// 手掌增量直接拖拽世界 X/Y 轴；手停即停，不保存角速度或惯性。
import { Quaternion, Vector3 } from './vendor/three/build/three.module.js';

export function createPalmRotation() {
  const orientation = new Quaternion();
  const delta = new Quaternion();
  const horizontalAxis = new Vector3(0,1,0);
  const verticalAxis = new Vector3(1,0,0);
  const gain = 10.55;
  const incrementThreshold = .001;
  const maximumJump = .24;
  let hasInput = false;
  let appliedX = 0,appliedY = 0;
  let filteredX = 0,filteredY = 0;
  let previousX = 0,previousY = 0;

  const valid = hand => hand && Number.isFinite(hand.x) && Number.isFinite(hand.y);

  function stop() {
    hasInput=false;
    appliedX=appliedY=filteredX=filteredY=previousX=previousY=0;
  }

  function pause(hand) {
    // 不传手时保留输入锚点；传入当前手则同步锚点，朝向始终保留。
    if(valid(hand)){
      hasInput=true;
      appliedX=filteredX=previousX=hand.x;
      appliedY=filteredY=previousY=hand.y;
    }else{
      filteredX=appliedX;
      filteredY=appliedY;
    }
  }

  function begin(hand,currentOrientation) {
    if(currentOrientation){
      const {x,y,z,w}=currentOrientation;
      const lengthSquared=x*x+y*y+z*z+w*w;
      if(Number.isFinite(lengthSquared)&&lengthSquared>1e-12)orientation.copy(currentOrientation).normalize();
    }
    stop();
    if(valid(hand))pause(hand);
  }

  function update(hand,elapsedSeconds) {
    if(!valid(hand)){stop();return orientation;}
    if(!hasInput){pause(hand);return orientation;}
    if(!Number.isFinite(elapsedSeconds)||elapsedSeconds<=0){pause(hand);return orientation;}
    // 同一输入绝不推进滤波器，因此停手后不会补转剩余角度。
    if(hand.x===previousX&&hand.y===previousY)return orientation;
    if(Math.hypot(hand.x-previousX,hand.y-previousY)>maximumJump){pause(hand);return orientation;}

    const dt=Math.min(elapsedSeconds,.05);
    const ease=1-Math.exp(-dt/0.012);
    filteredX+=(hand.x-filteredX)*ease;
    filteredY+=(hand.y-filteredY)*ease;
    previousX=hand.x;previousY=hand.y;
    let changed=false;
    // 轻微低通只用于越过防抖门槛；有效拖拽使用真实累计位移，不留下惯性残量。
    if(Math.abs(filteredX-appliedX)>incrementThreshold){
      delta.setFromAxisAngle(horizontalAxis,(hand.x-appliedX)*gain);
      orientation.premultiply(delta);
      appliedX=filteredX=hand.x;
      changed=true;
    }
    if(Math.abs(filteredY-appliedY)>incrementThreshold){
      delta.setFromAxisAngle(verticalAxis,(hand.y-appliedY)*gain);
      orientation.premultiply(delta);
      appliedY=filteredY=hand.y;
      changed=true;
    }
    if(changed)orientation.normalize();
    return orientation;
  }

  return {begin,update,stop,pause};
}
