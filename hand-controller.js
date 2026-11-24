/**
 * 仅在 start() 后开启摄像头；识别在工作线程执行，画面不上传。
 * 回调看门狗、前后台恢复与有限模型重建共用单循环，不重置照片动作锁存。
 */
import { loadHandRuntime } from './vision-runtime.js';
import { createGestureInterpreter } from './gesture-interpreter.js';
import { createGestureWorkerModel } from './gesture-worker-client.js';

export function createHandController({video,onGesture,onStatus,onLandmarks,onPose,getMode=()=>null,
  runtimeLoader=loadHandRuntime,modelFactory=createGestureWorkerModel}={}) {
  let currentRun=null;
  const clock=()=>performance.now();
  const hidden=()=>globalThis.document?.hidden===true;
  const emit=(callback,value)=>{if(typeof callback==='function')try{callback(value);}catch(error){console.warn('手势回调执行失败',error);}};
  const status=(state,message,extra={})=>emit(onStatus,{state,message,...extra});
  const isCurrent=run=>currentRun===run&&!run.cancelled;
  const closeModel=model=>{try{model?.close();}catch{/* 继续清理其他资源。 */}};
  const stopStream=stream=>stream?.getTracks().forEach(track=>track.stop());
  const makeError=(code,message)=>Object.assign(new Error(message),{handCode:code});
  const aspect=()=>video.videoWidth&&video.videoHeight?video.videoWidth/video.videoHeight:4/3;
  const context=()=>({mode:typeof getMode==='function'?getMode():null});

  function awaitStep(run,task,timeoutMs=0,lateCleanup) {
    return new Promise((resolve,reject)=>{
      let settled=false,timer=null;
      const finish=(error,value)=>{
        if(settled)return;
        settled=true;if(timer!==null)clearTimeout(timer);run.cancelWaiters.delete(cancel);
        if(error)reject(error);else resolve(value);
      };
      const cancel=()=>finish(makeError('cancelled','手势启动已取消'));
      run.cancelWaiters.add(cancel);
      if(timeoutMs>0)timer=setTimeout(()=>finish(makeError('runtime-timeout','本地手势工作线程初始化超时')),timeoutMs);
      Promise.resolve(task).then(value=>{
        if(settled||!isCurrent(run)){lateCleanup?.(value);if(!settled)cancel();return;}
        finish(null,value);
      },error=>finish(error));
      if(!isCurrent(run))cancel();
    });
  }

  function cancelFrame(run) {
    // token 必须先失效；已进入浏览器队列的旧回调不能擦掉新循环的 id。
    run.loopToken++;
    const id=run.frameId,kind=run.frameKind;
    run.frameId=null;run.frameKind=null;
    if(id!==null)try{
      if(kind==='video')video.cancelVideoFrameCallback(id);else cancelAnimationFrame(id);
    }catch{/* token 已阻止晚到回调继续工作。 */}
  }

  function release(run) {
    cancelFrame(run);
    if(run.watchdogId!==null)clearTimeout(run.watchdogId);
    run.watchdogId=null;
    for(const remove of run.listeners.splice(0))remove();
    for(const cancel of [...run.cancelWaiters])cancel();
    if(run.stream){
      stopStream(run.stream);
      if(video?.srcObject===run.stream){video.pause();video.srcObject=null;}
      run.stream=null;
    }
    closeModel(run.model);run.model=null;
  }

  function stop() {
    const run=currentRun;if(run)clearControl(run);currentRun=null;
    if(run){run.cancelled=true;release(run);}
    emit(onLandmarks,null);
    status('stopped','手势已关闭，摄像头已释放',{code:'stopped'});
  }

  function describeError(error,stage) {
    if(error?.handCode)return {code:error.handCode,message:error.message};
    if(stage==='video'&&error?.name==='NotAllowedError')return {code:'playback-blocked',message:'浏览器阻止了摄像头画面自动播放，请点击页面后重试'};
    if(['NotAllowedError','PermissionDeniedError'].includes(error?.name))return {code:'permission-denied',message:'摄像头权限被拒绝，请在浏览器地址栏允许摄像头后重新打开页面'};
    if(['NotFoundError','DevicesNotFoundError'].includes(error?.name))return {code:'no-camera',message:'没有找到摄像头，请连接摄像头后重新打开页面'};
    if(['NotReadableError','TrackStartError'].includes(error?.name))return {code:'camera-busy',message:'摄像头无法读取，请关闭占用摄像头的其他应用后重试'};
    if(error?.name==='SecurityError')return {code:'insecure-context',message:'浏览器阻止了摄像头访问，请通过 localhost 或 HTTPS 打开页面'};
    if(stage==='runtime')return {code:'runtime-failed',message:'本地手势资源加载失败，请确认打开的是完整文件或完整预览目录'};
    if(stage.startsWith('model'))return {code:'model-failed',message:'手势工作线程连续恢复失败，请重新打开页面后重试'};
    if(stage==='inference')return {code:'inference-failed',message:'手势识别连续中断，请重新打开页面；圣诞树仍可继续观赏'};
    return {code:'camera-failed',message:'摄像头画面未能启动，请检查设备和浏览器权限后重试'};
  }

  function poseTime(run) {
    const now=Math.max(clock(),run.lastPoseTime+.001);
    run.lastPoseTime=now;return now;
  }

  function clearControl(run) {
    if(!isCurrent(run)||run.controlCleared)return;
    run.controlCleared=true;run.tracking=false;
    const frame=run.interpreter.update(null,poseTime(run),aspect(),[],context());
    emit(onLandmarks,null);
    if(isCurrent(run))emit(onPose,{...frame,valid:false,controlActive:false,gesture:null,photoPending:false});
    // 不调用 interpreter.reset：暂停、丢帧、模型恢复都不能解开照片锁。
  }

  function fail(run,error,stage) {
    if(!isCurrent(run))return;
    clearControl(run);
    console.error('[圣诞手势]['+stage+']',error);
    const details=describeError(error,stage);
    currentRun=null;run.cancelled=true;release(run);
    emit(onLandmarks,null);status('error',details.message,{code:details.code,stage});
  }

  function playVideo(run) {
    return new Promise((resolve,reject)=>{
      let settled=false,playing=false;
      const events=['loadeddata','loadedmetadata','canplay','resize'];
      const finish=error=>{
        if(settled)return;settled=true;clearTimeout(timer);
        for(const type of events)video.removeEventListener(type,check);
        video.removeEventListener('error',videoError);run.cancelWaiters.delete(cancel);
        if(error)reject(error);else resolve();
      };
      const check=()=>{if(!isCurrent(run)){cancel();return;}if(playing&&video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0)finish();};
      const cancel=()=>finish(makeError('cancelled','摄像头启动已取消'));
      const videoError=()=>finish(makeError('video-error','摄像头画面读取失败，请检查摄像头后重试'));
      const timer=setTimeout(()=>finish(makeError('video-timeout','等待摄像头画面超过12秒，请检查设备是否被占用后重试')),12000);
      for(const type of events)video.addEventListener(type,check);
      video.addEventListener('error',videoError);run.cancelWaiters.add(cancel);
      try{
        video.muted=true;video.playsInline=true;video.srcObject=run.stream;
        Promise.resolve(video.play()).then(()=>{playing=true;check();},finish);check();
      }catch(error){finish(error);}
    });
  }

  function processLandmarks(run,landmarks,categories) {
    const frame=run.interpreter.update(landmarks,poseTime(run),aspect(),categories,context());
    run.controlCleared=!frame.valid;
    emit(onLandmarks,frame.valid?landmarks:null);
    if(!isCurrent(run))return;
    emit(onPose,frame);
    if(isCurrent(run)&&frame.gesture)emit(onGesture,frame.gesture);
  }

  async function createModel(run) {
    // 每次恢复重新计预算，不能继续使用首次打开页面时的过期 deadline。
    run.modelDeadline=Date.now()+40000;
    const task=Promise.resolve().then(()=>{
      if(!isCurrent(run))throw makeError('cancelled','手势启动已取消');
      return modelFactory(run.runtime,{delegate:'CPU'});
    });
    const model=await awaitStep(run,task,Math.max(1,run.modelDeadline-Date.now()),closeModel);
    if(!isCurrent(run)){closeModel(model);return false;}
    if(!model||typeof model.recognizeForVideo!=='function'||typeof model.close!=='function'){
      closeModel(model);throw makeError('worker-model-invalid','手势工作线程接口不完整');
    }
    run.model=model;run.backend='WORKER_CPU';run.successSinceRecovery=0;run.firstSuccessAt=null;
    return true;
  }

  function cooldown(run,milliseconds) {
    return new Promise((resolve,reject)=>{
      let timer=null;
      const cancel=()=>{clearTimeout(timer);run.cancelWaiters.delete(cancel);reject(makeError('cancelled','手势恢复已取消'));};
      run.cancelWaiters.add(cancel);
      timer=setTimeout(()=>{run.cancelWaiters.delete(cancel);resolve();},milliseconds);
      if(!isCurrent(run))cancel();
    });
  }

  async function recoverModel(run,error) {
    if(!isCurrent(run)||run.recovering)return;
    clearControl(run);cancelFrame(run);
    if(run.recoveryCount>=2){fail(run,error,'inference');return;}
    run.recovering=true;
    closeModel(run.model);run.model=null;
    try{
      let failure=error;
      while(isCurrent(run)&&run.recoveryCount<2){
        run.recoveryCount++;
        status('loading','手势识别暂时中断，正在恢复本地工作线程',{stage:'model-recovery',attempt:run.recoveryCount});
        try{
          await cooldown(run,run.recoveryCount*500);
          if(!isCurrent(run)||!await createModel(run))return;
          const now=clock();run.lastVideoTime=-1;run.lastDetectionTime=-Infinity;
          run.lastResultAt=run.lastCallbackAt=run.lastVideoAdvanceAt=now;run.healthVideoTime=video.currentTime;
          status('active','手势识别已恢复，请重新稳定张掌',{backend:run.backend});return;
        }catch(nextError){failure=nextError;if(!isCurrent(run))return;closeModel(run.model);run.model=null;}
      }
      if(isCurrent(run))fail(run,failure,'model-recovery');
    }
    finally{run.recovering=false;}
  }

  function scheduleFrame(run) {
    if(!isCurrent(run)||!run.active||run.recovering||run.inFlight||hidden()||run.frameId!==null)return;
    const token=++run.loopToken;
    const processFrame=async()=>{
      if(!isCurrent(run)||token!==run.loopToken)return;
      run.frameId=null;run.frameKind=null;run.lastCallbackAt=clock();
      const videoTime=video.currentTime;
      if(clock()-run.lastDetectionTime<16||video.readyState<2||!video.videoWidth||!video.videoHeight||videoTime===run.lastVideoTime){
        scheduleFrame(run);return;
      }
      run.lastDetectionTime=clock();run.lastVideoTime=videoTime;
      run.inFlight=true;run.inFlightToken=token;
      const timestamp=Math.max(clock(),run.lastInferenceTime+.001);run.lastInferenceTime=timestamp;
      try{
        const result=await run.model.recognizeForVideo(video,timestamp);
        if(!isCurrent(run)||token!==run.loopToken||hidden())return;
        const now=clock();run.lastResultAt=now;run.successSinceRecovery++;
        if(run.firstSuccessAt===null)run.firstSuccessAt=now;
        if(run.successSinceRecovery>=30||now-run.firstSuccessAt>=10000)run.recoveryCount=0;
        const landmarks=result.landmarks?.[0]??null,categories=result.gestures?.[0]??[];
        if(landmarks){
          if(!run.tracking)status('tracking','已识别手部：张掌散开，握拳聚合，竖大拇指弹出照片');
          if(!isCurrent(run))return;
          run.tracking=true;
        }else{
          if(run.tracking!==false)status('waiting','请将一只手放在摄像头前，并保持光线充足');
          run.tracking=false;
        }
        processLandmarks(run,landmarks,categories);
      }catch(error){if(isCurrent(run))await recoverModel(run,error);}
      finally{
        if(run.inFlightToken===token){run.inFlight=false;run.inFlightToken=null;}
        if(isCurrent(run))scheduleFrame(run);
      }
    };
    if(run.useVideoFrames)try{
      run.frameKind='video';run.frameId=video.requestVideoFrameCallback(processFrame);return;
    }catch{run.useVideoFrames=false;}
    run.frameKind='animation';run.frameId=requestAnimationFrame(processFrame);
  }

  function ensureScheduling(run,{grace=false,animation=false}={}) {
    if(!isCurrent(run)||!run.active)return;
    clearControl(run);cancelFrame(run);
    if(animation)run.useVideoFrames=false;
    if(grace){
      const now=clock();run.lastResultAt=run.lastCallbackAt=run.lastVideoAdvanceAt=now;
      run.healthVideoTime=video.currentTime;
    }
    if(!hidden())scheduleFrame(run);
  }

  function retryPlayback(run) {
    if(!isCurrent(run)||hidden()||run.playbackRetryUsed)return;
    run.playbackRetryUsed=true;
    Promise.resolve().then(()=>video.play()).then(()=>{
      if(isCurrent(run))ensureScheduling(run,{grace:true,animation:true});
    },error=>fail(run,error,'video'));
  }

  function armWatchdog(run) {
    if(!isCurrent(run)||run.watchdogId!==null)return;
    run.watchdogId=setTimeout(()=>{
      run.watchdogId=null;
      if(!isCurrent(run))return;
      const now=clock();
      if(!hidden()){
        // busy 时只能等工作线程自己的超时，绝不再提交第二个识别请求。
        if(!run.inFlight&&!run.recovering){
          if(now-run.lastResultAt>700)clearControl(run);
          if(video.currentTime!==run.healthVideoTime){run.healthVideoTime=video.currentTime;run.lastVideoAdvanceAt=now;}
          if(run.frameKind==='video'&&now-run.lastCallbackAt>700)ensureScheduling(run,{animation:true});
          if(now-run.lastVideoAdvanceAt>1800)retryPlayback(run);
          if(now-run.lastVideoAdvanceAt>6000){
            fail(run,makeError('video-stalled','摄像头画面长时间没有更新，请检查设备后重新打开页面'),'video');return;
          }
          scheduleFrame(run);
        }
      }
      armWatchdog(run);
    },250);
  }

  function bind(run,target,name,listener) {
    if(typeof target?.addEventListener!=='function')return;
    target.addEventListener(name,listener);
    run.listeners.push(()=>target.removeEventListener(name,listener));
  }

  function bindLifecycle(run) {
    bind(run,globalThis.document,'visibilitychange',()=>{
      ensureScheduling(run,{grace:!hidden()});
      if(!hidden()&&video.paused)retryPlayback(run);
    });
    const resume=()=>{if(!hidden()){ensureScheduling(run,{grace:true});if(video.paused)retryPlayback(run);}};
    bind(run,globalThis,'focus',resume);bind(run,globalThis,'pageshow',resume);
    const stalled=()=>{ensureScheduling(run,{animation:true});retryPlayback(run);};
    bind(run,video,'stalled',stalled);bind(run,video,'pause',stalled);
    bind(run,video,'error',()=>fail(run,makeError('video-error','摄像头画面读取失败，请检查设备后重新打开页面'),'video'));
    bind(run,video,'ended',()=>fail(run,makeError('camera-ended','摄像头连接已结束，请连接设备后重新打开页面'),'video'));
    for(const track of run.stream.getTracks())bind(run,track,'ended',()=>fail(run,makeError('camera-ended','摄像头连接已结束，请连接设备后重新打开页面'),'video'));
  }

  async function initialize(run) {
    let stage='camera';
    try{
      if(!video||typeof video.play!=='function')throw makeError('missing-video','缺少摄像头读取元素，无法启动手势识别');
      if(!globalThis.isSecureContext)throw makeError('insecure-context','摄像头需要安全页面，请通过 localhost 或 HTTPS 打开');
      if(!globalThis.navigator?.mediaDevices?.getUserMedia)throw makeError('unsupported','当前浏览器不支持摄像头访问，请使用 Chrome 或 Edge');
      status('loading','请允许摄像头访问，画面仅在本机处理',{stage});
      if(!isCurrent(run))return false;
      run.stream=await awaitStep(run,navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:480}}}),0,stopStream);
      if(!isCurrent(run))return false;
      stage='video';await playVideo(run);if(!isCurrent(run))return false;
      stage='runtime';status('loading','摄像头已就绪，正在读取本地手势模型',{stage});
      run.runtime=await awaitStep(run,Promise.resolve().then(()=>{
        if(!isCurrent(run))throw makeError('cancelled','手势启动已取消');
        return runtimeLoader('gesture');
      }),40000);
      if(!isCurrent(run))return false;
      stage='model-worker';if(!await createModel(run))return false;
      run.active=true;
      const now=clock();run.lastResultAt=run.lastCallbackAt=run.lastVideoAdvanceAt=now;run.healthVideoTime=video.currentTime;
      bindLifecycle(run);armWatchdog(run);
      status('active','手势已自动启动，请将手放在摄像头前',{backend:run.backend});
      if(!isCurrent(run))return false;
      scheduleFrame(run);return true;
    }catch(error){if(isCurrent(run))fail(run,error,stage);return false;}
    finally{if(!run.active||!isCurrent(run)){release(run);if(currentRun===run)currentRun=null;}}
  }

  function start() {
    if(currentRun)return currentRun.promise;
    const run={
      cancelled:false,active:false,model:null,stream:null,frameId:null,frameKind:null,loopToken:0,
      useVideoFrames:typeof video?.requestVideoFrameCallback==='function'&&typeof video?.cancelVideoFrameCallback==='function',
      watchdogId:null,listeners:[],cancelWaiters:new Set(),inFlight:false,inFlightToken:null,recovering:false,recoveryCount:0,
      runtime:null,modelDeadline:0,backend:null,successSinceRecovery:0,firstSuccessAt:null,
      lastVideoTime:-1,lastDetectionTime:-Infinity,lastInferenceTime:-Infinity,lastPoseTime:-Infinity,
      lastResultAt:0,lastCallbackAt:0,lastVideoAdvanceAt:0,healthVideoTime:0,
      playbackRetryUsed:false,tracking:null,controlCleared:false,interpreter:createGestureInterpreter(),promise:null,
    };
    currentRun=run;run.promise=initialize(run);return run.promise;
  }
  return {start,stop};
}
