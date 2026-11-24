// 快速姿态确认与照片锁存。强模型类别走短确认，普通几何仍需更多有效帧。
import { classifyHandPose } from './hand-pose-classifier.js';
import { resolveHandPose } from './pose-resolver.js';

export function createGestureInterpreter({classify=classifyHandPose}={}) {
  let history=[],lastNow=-Infinity,committed=null,session=0,lastControlAt=-Infinity;
  let photoArmed=true,releaseSince=null,releaseSamples=0,lastFrame=null,samplePeriod=1000/30,lastMode=null;
  let slowCandidate=null,slowCandidateAge=0,sessionInterrupted=false;
  const evidence={THUMBS_UP:{since:null,last:-Infinity},TREE:{since:null,last:-Infinity},SCATTER:{since:null,last:-Infinity}};

  function clearPhotoEvidence() {
    evidence.THUMBS_UP.since=null;evidence.THUMBS_UP.last=-Infinity;
    history=history.filter(frame=>frame.pose!=='THUMBS_UP');
  }
  function observeInterval(interval) {
    if(!Number.isFinite(interval)||interval<=0)return false;
    if(slowCandidate!==null)slowCandidateAge++;
    // 单次长停顿先断开证据；重复的相近慢帧才可成为设备的实际节奏。
    if(interval>2000) {
      samplePeriod=1000/30;slowCandidate=null;slowCandidateAge=0;return true;
    }
    if(interval>Math.max(400,samplePeriod*2.5)) {
      if(slowCandidate!==null&&slowCandidateAge<=3
        &&Math.abs(interval-slowCandidate)<=Math.max(100,slowCandidate*.35)) {
        samplePeriod=Math.max(1000/60,Math.min(2000,(slowCandidate+interval)*.5));
        slowCandidate=null;slowCandidateAge=0;return false;
      }
      slowCandidate=interval;slowCandidateAge=0;return true;
    }
    // 偶尔的快速帧不能把刚确认的慢设备节奏立即拉回30fps。
    const blend=interval<samplePeriod*.5?.15:.5;
    samplePeriod=Math.max(1000/60,Math.min(2000,samplePeriod+(interval-samplePeriod)*blend));
    if(slowCandidateAge>3){slowCandidate=null;slowCandidateAge=0;}
    return false;
  }
  function reset() {
    history=[];lastNow=-Infinity;committed=null;session=0;lastControlAt=-Infinity;
    photoArmed=true;releaseSince=null;releaseSamples=0;lastFrame=null;samplePeriod=1000/30;lastMode=null;
    slowCandidate=null;slowCandidateAge=0;sessionInterrupted=false;
    for(const item of Object.values(evidence)){item.since=null;item.last=-Infinity;}
  }

  function update(landmarks,now,aspect=4/3,modelCategories=[],context={}) {
    if(!Number.isFinite(now)||now<=lastNow) {
      return lastFrame?{...lastFrame,controlActive:false,gesture:null,photoPending:false}:
        {pose:'NEUTRAL',stablePose:null,controlActive:false,controlSession:session,gesture:null,cursor:{x:.5,y:.5},photoPending:false,photoArmed};
    }
    const interval=now-lastNow;
    const clockBreak=observeInterval(interval);
    const evidenceGap=Math.max(110,samplePeriod*2.5),releaseGap=Math.max(120,samplePeriod*2.2);
    if(clockBreak||interval>evidenceGap) {
      history=[];
      for(const item of Object.values(evidence)){item.since=null;item.last=-Infinity;}
      if(Number.isFinite(interval))sessionInterrupted=true;
    }
    if(clockBreak||interval>releaseGap){releaseSince=null;releaseSamples=0;}
    lastNow=now;
    const mode=context?.mode??null;
    if(mode==='FOCUS'&&lastMode!=='FOCUS') {
      for(const name of ['TREE','SCATTER']){evidence[name].since=null;evidence[name].last=-Infinity;}
      history=history.filter(frame=>frame.pose!=='TREE'&&frame.pose!=='SCATTER');
      if(committed==='TREE'||committed==='SCATTER')committed=null;
    }
    lastMode=mode;
    const sample=resolveHandPose(landmarks,aspect,modelCategories,{classify});
    const valid=!!sample?.valid;
    if(!valid)clearPhotoEvidence();
    const pose=valid&&(sample.strong||sample.score>=.7)&&evidence[sample.pose]?sample.pose:'NEUTRAL';
    const cursor=sample?.cursor&&Number.isFinite(sample.cursor.x)&&Number.isFinite(sample.cursor.y)?{
      x:Math.max(0,Math.min(1,sample.cursor.x)),y:Math.max(0,Math.min(1,sample.cursor.y)),
    }:{x:.5,y:.5};
    history.push({pose,now,cursor,strong:sample?.strong===true});
    history=history.filter(frame=>now-frame.now<=Math.max(500,samplePeriod*7)).slice(-12);
    // 照片中退出必须持续握拳；过渡、其它姿态或缺手都要重新计650ms。
    if(mode==='FOCUS'&&pose!=='TREE') {
      evidence.TREE.since=null;evidence.TREE.last=-Infinity;
      history=history.filter(frame=>frame.pose!=='TREE');
    }
    for(const [name,item] of Object.entries(evidence)) {
      if(now-item.last>evidenceGap)item.since=null;
      if(pose===name){if(item.since===null)item.since=now;item.last=now;}
    }
    const ready=(name,dwell) => {
      if(pose!==name||evidence[name].since===null||now-evidence[name].since<dwell)return false;
      const recent=history.slice(-4);
      const required=sample.strong?2:3;
      return recent.filter(frame=>frame.pose===name&&(!sample.strong||frame.strong)).length>=required;
    };

    // 明确折回拇指、张掌或握拳可释放；缺手和普通中性过渡不算释放。
    if(valid&&sample.releaseClear&&pose!=='THUMBS_UP') {
      if(releaseSince===null)releaseSince=now;
      releaseSamples++;
      if(!photoArmed&&now-releaseSince>=80&&releaseSamples>=3) {
        photoArmed=true;
        // 释放后的下一次照片动作必须使用全新证据，不能继承上一轮比赞历史。
        clearPhotoEvidence();
      }
    } else {releaseSince=null;releaseSamples=0;}

    let gesture=null,controlActive=false,averagedCursor=cursor;
    const photoFrames=history.slice(-4).filter(frame=>frame.pose==='THUMBS_UP');
    if(photoFrames.length) {
      averagedCursor={x:0,y:0};
      for(const frame of photoFrames){averagedCursor.x+=frame.cursor.x/photoFrames.length;averagedCursor.y+=frame.cursor.y/photoFrames.length;}
    }
    const pending=pose==='THUMBS_UP'&&photoArmed;
    if(ready('THUMBS_UP',120)&&photoArmed) {
      photoArmed=false;committed='THUMBS_UP';
      gesture={type:'THUMBS_UP',x:averagedCursor.x,y:averagedCursor.y};
      clearPhotoEvidence();
    } else if(ready('TREE',mode==='FOCUS'?650:sample.strong?65:80)) {
      // 看照片时短暂握拳只是放下拇指，持续握拳才真正退出照片。
      if(committed!=='TREE'){committed='TREE';gesture={type:'TREE',x:cursor.x,y:cursor.y};}
    } else if(ready('SCATTER',sample.strong?55:80)) {
      const changed=committed!=='SCATTER';
      if(changed||session===0||sessionInterrupted||now-lastControlAt>Math.max(180,samplePeriod*2.5))session++;
      sessionInterrupted=false;
      controlActive=true;lastControlAt=now;
      if(changed){committed='SCATTER';gesture={type:'SCATTER',x:cursor.x,y:cursor.y};}
    }
    lastFrame={pose,stablePose:committed,controlActive,controlSession:session,gesture,cursor:averagedCursor,
      photoPending:pending,photoArmed,valid,now,continuityMilliseconds:evidenceGap,
      samplePeriodMilliseconds:samplePeriod,continuityReset:clockBreak,
      source:sample.source,strong:sample.strong===true,modelCategory:sample.modelCategory};
    return lastFrame;
  }
  return {update,reset};
}
