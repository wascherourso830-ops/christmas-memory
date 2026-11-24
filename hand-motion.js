// 掌部静止检测：只取腕点及三处掌根，不让指尖换姿态维持全场运动。
// now 使用 performance.now() 一类的毫秒时间；输出是复用的只读状态。
export function createHandMotion() {
  const still = Object.freeze({stationary:true,moving:false});
  const moving = Object.freeze({stationary:false,moving:true});
  const holdMilliseconds = 160;
  const scaleThreshold = .02;
  let initialized = false;
  let lastTime = -Infinity;
  let lastMotion = -Infinity;
  let previousAspect = 4/3;
  let anchorX = 0,anchorY = 0,anchorSize = 0;
  let filteredX = 0,filteredY = 0,filteredSize = 0;
  let rawX = 0,rawY = 0,rawSize = 0;
  let samplePeriod = 1000/30,slowCandidate = null,slowCandidateAge = 0;

  function reset() {
    initialized=false;
    lastTime=lastMotion=-Infinity;
    anchorX=anchorY=anchorSize=filteredX=filteredY=filteredSize=rawX=rawY=rawSize=0;
    samplePeriod=1000/30;slowCandidate=null;slowCandidateAge=0;
  }

  function observeInterval(interval) {
    if(!Number.isFinite(interval)||interval<=0)return false;
    if(slowCandidate!==null)slowCandidateAge++;
    if(interval>2000){samplePeriod=1000/30;slowCandidate=null;slowCandidateAge=0;return true;}
    if(interval>Math.max(400,samplePeriod*2.5)) {
      if(slowCandidate!==null&&slowCandidateAge<=3
        &&Math.abs(interval-slowCandidate)<=Math.max(100,slowCandidate*.35)) {
        samplePeriod=Math.max(1000/60,Math.min(2000,(slowCandidate+interval)*.5));
        slowCandidate=null;slowCandidateAge=0;return false;
      }
      slowCandidate=interval;slowCandidateAge=0;return true;
    }
    const blend=interval<samplePeriod*.5?.15:.5;
    samplePeriod=Math.max(1000/60,Math.min(2000,samplePeriod+(interval-samplePeriod)*blend));
    if(slowCandidateAge>3){slowCandidate=null;slowCandidateAge=0;}
    return false;
  }

  function valid(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  function seed(x,y,size,now,aspect) {
    initialized=true;
    rawX=filteredX=anchorX=x;
    rawY=filteredY=anchorY=y;
    rawSize=filteredSize=anchorSize=size;
    lastTime=now;lastMotion=now-holdMilliseconds;
    previousAspect=aspect;
    return still;
  }

  function update(landmarks,now,aspect=4/3) {
    // 时间异常或退回时先静止，下一帧重新建立当前手的参照。
    if(!Number.isFinite(now)||now<0||(initialized&&now<lastTime)){
      reset();return still;
    }
    const wrist=landmarks?.[0],index=landmarks?.[5],middle=landmarks?.[9],little=landmarks?.[17];
    if(!valid(wrist)||!valid(index)||!valid(middle)||!valid(little)){
      reset();return still;
    }
    const ratio=Number.isFinite(aspect)&&aspect>.2&&aspect<5?aspect:4/3;
    // x 与 y 都换到图像高度的单位；阈值对应图像长边约 0.5%。
    const x=(wrist.x+index.x+middle.x+little.x)*.25*ratio;
    const y=(wrist.y+index.y+middle.y+little.y)*.25;
    const x0=wrist.x*ratio-x,y0=wrist.y-y;
    const x5=index.x*ratio-x,y5=index.y-y;
    const x9=middle.x*ratio-x,y9=middle.y-y;
    const x17=little.x*ratio-x,y17=little.y-y;
    // 四点到掌心的均方半径可同时利用掌长与掌宽，忽略指尖的变化。
    const size=Math.sqrt((x0*x0+y0*y0+x5*x5+y5*y5+x9*x9+y9*y9+x17*x17+y17*y17)*.25);
    if(!Number.isFinite(size)||size<.012){reset();return still;}
    if(!initialized){return seed(x,y,size,now,ratio);}
    const clockBreak=observeInterval(now-lastTime);
    if(clockBreak||Math.abs(ratio/previousAspect-1)>.04){
      return seed(x,y,size,now,ratio);
    }
    // 同一时间戳的重复输入不延长运动窗口，也不重复累积噪声。
    if(now===lastTime)return now-lastMotion<holdMilliseconds?moving:still;

    // 完全相同的手部输入不继续推进低通余量，防止停手后又被残量唤醒。
    if(x===rawX&&y===rawY&&size===rawSize){
      lastTime=now;previousAspect=ratio;
      return now-lastMotion<holdMilliseconds?moving:still;
    }

    const elapsed=Math.min(now-lastTime,80);
    const ease=1-Math.exp(-elapsed/45);
    filteredX+=(x-filteredX)*ease;
    filteredY+=(y-filteredY)*ease;
    filteredSize+=(size-filteredSize)*ease;
    const threshold=.005*Math.max(1,ratio);
    // 明显位移和推拉立即放行；原始噪声的正负摆动不会越过此快速门槛。
    const immediate=Math.hypot(x-rawX,y-rawY)>threshold*2.2||Math.abs(size/rawSize-1)>.05;
    const displaced=Math.hypot(filteredX-anchorX,filteredY-anchorY)>threshold;
    const resized=Math.abs(filteredSize/anchorSize-1)>scaleThreshold;
    if(immediate||displaced||resized){
      lastMotion=now;
      // 明显动作直接跟上当前位置，不把低通滤波的余量误判成后续运动。
      if(immediate){filteredX=x;filteredY=y;filteredSize=size;}
      anchorX=filteredX;anchorY=filteredY;anchorSize=filteredSize;
    }
    rawX=x;rawY=y;rawSize=size;lastTime=now;previousAspect=ratio;
    return now-lastMotion<holdMilliseconds?moving:still;
  }

  return {update,reset};
}
