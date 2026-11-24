/* 圣诞光屿。本地重制，粒子布局与场景切换借鉴 Pan Wang 的 MIT 项目。
 * 来源与许可见 THIRD_PARTY_NOTICES.md。照片始终只保存在当前页面内存。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createHandController } from './hand-controller.js';
import { createPalmRotation } from './palm-rotation.js';
import { createPalmDepth } from './palm-depth.js';
import { createChristmasDecorations } from './christmas-decorations.js';
import { createHandMotion } from './hand-motion.js';

const $ = selector => document.querySelector(selector);
const mobile = matchMedia('(max-width: 800px)').matches;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const state = {mode:'TREE',focus:0,photoCursor:-1,hand:null,landmarks:null,zoom:1,ready:false,
  controlActive:false,controlSession:0,handMoving:false};
const palmRotation = createPalmRotation();
const palmDepth = createPalmDepth();
const handMotion = createHandMotion();
const treeOrientation = new THREE.Quaternion();
const scene = new THREE.Scene();
scene.background = new THREE.Color('#050807');
scene.fog = new THREE.FogExp2('#050807',0.007);
const camera = new THREE.PerspectiveCamera(42,innerWidth/innerHeight,0.1,180);
const renderer = new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,mobile?1.5:1.75));
renderer.setSize(innerWidth,innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
$('#scene').appendChild(renderer.domElement);
renderer.domElement.setAttribute('aria-label','圣诞粒子场景：握拳聚树，张掌散开，竖大拇指弹出照片');
const root = new THREE.Group();root.position.y=-1.6;scene.add(root);
function refreshEnvironment(){
  const environment=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();
  const previous=scene.environment;scene.environment=environment.fromScene(room,.04).texture;
  previous?.dispose();room.dispose();environment.dispose();
}
refreshEnvironment();
scene.add(new THREE.AmbientLight(0xffedcb,1.1));
const keyLight = new THREE.DirectionalLight(0xffd17e,3.5);keyLight.position.set(12,18,25);scene.add(keyLight);
const rim = new THREE.DirectionalLight(0x7ea991,1.6);rim.position.set(-18,10,-15);scene.add(rim);
const inner = new THREE.PointLight(0xffad34,70,32);inner.position.set(0,2,4);root.add(inner);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene,camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),0.8,0.62,0.78);
composer.addPass(bloom);
const clock = new THREE.Clock();
const scratch = new THREE.Object3D();
const target = new THREE.Vector3();
const inverse = new THREE.Matrix4();
const inverseQuaternion = new THREE.Quaternion();
const photos = [];
let placeholders = true, elapsed = 0, motionElapsed=0, transitionUntil=0, photoPopAge=10,
  toastTimer, photoBusy = false, burstAge=10;
let graphicsLost=false,graphicsRestoreTimer=null,graphicsRestoreAttempts=0,renderFrameId=null;

// 规则随机数使初始树形可复现，不依赖外部素材。
let seed = 1225;
function random(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;}
function vectorOnSphere(radius){const a=random()*Math.PI*2,z=random()*2-1,r=Math.sqrt(1-z*z);return new THREE.Vector3(Math.cos(a)*r*radius,z*radius,Math.sin(a)*r*radius);}
function treePosition(){const t=Math.pow(random(),0.83),angle=t*50*Math.PI+random()*Math.PI,r=(1-t)*8*(.62+random()*.42);return new THREE.Vector3(Math.cos(angle)*r,t*24-12,Math.sin(angle)*r);}
function scatterPosition(){return vectorOnSphere(10+Math.pow(random(),.75)*13);}
function glowTexture(){const c=document.createElement('canvas');c.width=c.height=64;const ctx=c.getContext('2d'),g=ctx.createRadialGradient(32,32,0,32,32,32);g.addColorStop(0,'#fff9dd');g.addColorStop(.12,'#ffdd91');g.addColorStop(.4,'#d990383a');g.addColorStop(1,'#d9903800');ctx.fillStyle=g;ctx.fillRect(0,0,64,64);return new THREE.CanvasTexture(c);}
const glowMap = glowTexture();

// 体积装饰以实例批次绘制，避免每个小颗粒都成为独立绘制调用。
const ornaments = [];
function addOrnaments(geometry,count,color,emissive){
  const material=new THREE.MeshStandardMaterial({color,metalness:.88,roughness:.23,emissive,emissiveIntensity:.4});
  const mesh=new THREE.InstancedMesh(geometry,material,count);mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;root.add(mesh);
  const items=Array.from({length:count},()=>({tree:treePosition(),scatter:scatterPosition(),position:new THREE.Vector3(),scale:.28+random()*.46,spin:random()*6,axis:random()*3}));
  items.forEach(p=>p.position.copy(p.tree));ornaments.push({mesh,items});
}
addOrnaments(new THREE.SphereGeometry(.43,10,8),520,0xeac46d,0x7b4207);
addOrnaments(new THREE.BoxGeometry(.5,.5,.5),470,0xe0af4c,0x533208);
addOrnaments(new THREE.BoxGeometry(.48,.48,.48),320,0x174b29,0x071b0d);
addOrnaments(new THREE.SphereGeometry(.45,10,8),100,0x9b1814,0x390500);
const dustCount = mobile?4600:7600;
const dustPositions = new Float32Array(dustCount*3),dustColors=new Float32Array(dustCount*3),dustSizes=new Float32Array(dustCount),dustPhases=new Float32Array(dustCount);
const dust = Array.from({length:dustCount},(_,i)=>{
  const t=treePosition(),s=vectorOnSphere(10+Math.pow(random(),.65)*19),white=random()<.27,c=new THREE.Color().setHSL(white?.1:.115,white?.18:.7,white?.86:.62+random()*.15);
  t.toArray(dustPositions,i*3);c.toArray(dustColors,i*3);dustSizes[i]=(random()<.07?.62:.18+random()*.23);dustPhases[i]=random()*Math.PI*2;
  return {tree:t,scatter:s,phase:dustPhases[i]};
});
const dustGeometry=new THREE.BufferGeometry();dustGeometry.setAttribute('position',new THREE.BufferAttribute(dustPositions,3));dustGeometry.setAttribute('aTint',new THREE.BufferAttribute(dustColors,3));dustGeometry.setAttribute('aSize',new THREE.BufferAttribute(dustSizes,1));dustGeometry.setAttribute('aPhase',new THREE.BufferAttribute(dustPhases,1));
const dustMaterial=new THREE.ShaderMaterial({
  uniforms:{uTime:{value:0},uScale:{value:renderer.getPixelRatio()*Math.min(innerHeight,1000)*.72},uBurst:{value:0},uOpacity:{value:1}},
  vertexShader:`attribute vec3 aTint; attribute float aSize; attribute float aPhase;
    uniform float uTime; uniform float uScale; uniform float uBurst;
    varying vec3 vTint; varying float vLight;
    void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);vTint=aTint;
      float wave=sin(uTime*(1.1+fract(aPhase)*.8)+aPhase)*.5+.5;
      vLight=.6+wave*.45+pow(wave,10.0)*.75+uBurst*.35;
      gl_PointSize=clamp(aSize*uScale/max(1.0,-mv.z),1.3,15.0);gl_Position=projectionMatrix*mv;}`,
  fragmentShader:`uniform float uOpacity; varying vec3 vTint; varying float vLight;
    void main(){vec2 p=(gl_PointCoord-.5)*2.0;float r=length(p);if(r>1.0)discard;
      float core=exp(-r*12.0);float halo=exp(-r*3.7)*.48;
      float rays=(exp(-abs(p.x)*30.0)*exp(-abs(p.y)*5.0)+exp(-abs(p.y)*30.0)*exp(-abs(p.x)*5.0))*.2;
      float energy=(core+halo+rays)*vLight;gl_FragColor=vec4(vTint*1.5,energy*uOpacity);}`,
  transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,
});
const dustPoints=new THREE.Points(dustGeometry,dustMaterial);dustPoints.frustumCulled=false;root.add(dustPoints);
const decorations=createChristmasDecorations({THREE,root,random,treePosition,scatterPosition,glowMap,mobile,reducedMotion});

// 只在张掌炸开时出现的径向光迹，随后自然消隐。
const trailCount=mobile?150:260,trailPositions=new Float32Array(trailCount*6),trailColors=new Float32Array(trailCount*6),trailRays=[];
for(let i=0;i<trailCount;i++){
  trailRays.push(vectorOnSphere(21+random()*11));
  const c=new THREE.Color(i%4===0?0xfff5d9:0xe5ae4a);c.toArray(trailColors,i*6);c.toArray(trailColors,i*6+3);
}
const trailGeometry=new THREE.BufferGeometry();trailGeometry.setAttribute('position',new THREE.BufferAttribute(trailPositions,3));trailGeometry.setAttribute('color',new THREE.BufferAttribute(trailColors,3));
const trailMaterial=new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false});
const burstTrails=new THREE.LineSegments(trailGeometry,trailMaterial);burstTrails.frustumCulled=false;root.add(burstTrails);

// 金色灯带沿树身盘旋，散开时融入星团。
const ribbonCount=850,ribbonPositions=new Float32Array(ribbonCount*3),ribbon=[];
for(let i=0;i<ribbonCount;i++){const t=i/ribbonCount,a=t*Math.PI*2*5,r=(1-t)*8.3+.05,p=new THREE.Vector3(Math.cos(a)*r,t*24-12,Math.sin(a)*r);p.toArray(ribbonPositions,i*3);ribbon.push({tree:p,scatter:scatterPosition()});}
const ribbonGeo=new THREE.BufferGeometry();ribbonGeo.setAttribute('position',new THREE.BufferAttribute(ribbonPositions,3));root.add(new THREE.Points(ribbonGeo,new THREE.PointsMaterial({size:.3,color:0xffd480,map:glowMap,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending})));
const shape=new THREE.Shape();for(let i=0;i<10;i++){const a=i*Math.PI/5+Math.PI/2,r=i%2?.53:1.2;i?shape.lineTo(Math.cos(a)*r,Math.sin(a)*r):shape.moveTo(Math.cos(a)*r,Math.sin(a)*r);}shape.closePath();
const starGeo=new THREE.ExtrudeGeometry(shape,{depth:.25,bevelEnabled:true,bevelSize:.07,bevelThickness:.07,bevelSegments:2});starGeo.center();
const star=new THREE.Mesh(starGeo,new THREE.MeshStandardMaterial({color:0xffd47c,emissive:0xffb22f,emissiveIntensity:1.1,metalness:.7,roughness:.15}));star.position.y=13.1;root.add(star);
const starGlow=new THREE.Sprite(new THREE.SpriteMaterial({map:glowMap,color:0xffca75,transparent:true,opacity:.8,blending:THREE.AdditiveBlending,depthWrite:false}));starGlow.scale.set(6,6,1);starGlow.position.copy(star.position);root.add(starGlow);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(30,15),new THREE.MeshBasicMaterial({map:glowMap,color:0xb78233,transparent:true,opacity:.18,depthWrite:false}));ground.rotation.x=-Math.PI/2;ground.position.y=-14.3;scene.add(ground);
const groundRing=new THREE.Mesh(new THREE.RingGeometry(8.5,8.52,128),new THREE.MeshBasicMaterial({color:0xe6bd69,transparent:true,opacity:.2,side:THREE.DoubleSide}));groundRing.rotation.x=-Math.PI/2;groundRing.position.y=-14.2;scene.add(groundRing);
const snowCount=mobile?800:1400,snowArray=new Float32Array(snowCount*3),snowSpeeds=[];
for(let i=0;i<snowCount;i++){snowArray[i*3]=(random()-.5)*110;snowArray[i*3+1]=(random()-.5)*70;snowArray[i*3+2]=-20-random()*45;snowSpeeds.push(1.4+random()*2.1);}
const snowGeo=new THREE.BufferGeometry();snowGeo.setAttribute('position',new THREE.BufferAttribute(snowArray,3));
scene.add(new THREE.Points(snowGeo,new THREE.PointsMaterial({size:.3,map:glowMap,color:0xe8f1e6,transparent:true,opacity:.68,depthWrite:false,blending:THREE.AdditiveBlending})));
// 少量前景六角雪花，和远处的细雪形成前后层次。
const flakeCanvas=document.createElement('canvas');flakeCanvas.width=flakeCanvas.height=96;
const flakeContext=flakeCanvas.getContext('2d');flakeContext.strokeStyle='#f5fffa';flakeContext.lineWidth=3;flakeContext.lineCap='round';
for(let i=0;i<6;i++){
  flakeContext.save();flakeContext.translate(48,48);flakeContext.rotate(i*Math.PI/3);flakeContext.beginPath();flakeContext.moveTo(0,0);flakeContext.lineTo(0,-38);
  for(const y of [-17,-27]){flakeContext.moveTo(-8,y+6);flakeContext.lineTo(0,y);flakeContext.lineTo(8,y+6);}flakeContext.stroke();flakeContext.restore();
}
const flakeMap=new THREE.CanvasTexture(flakeCanvas),flakeCount=mobile?100:170,flakePositions=new Float32Array(flakeCount*3),flakeSpeeds=[];
for(let i=0;i<flakeCount;i++){flakePositions[i*3]=(random()-.5)*94;flakePositions[i*3+1]=(random()-.5)*70;flakePositions[i*3+2]=(random()-.5)*50;flakeSpeeds.push(1.2+random()*1.8);}
const flakeGeometry=new THREE.BufferGeometry();flakeGeometry.setAttribute('position',new THREE.BufferAttribute(flakePositions,3));
const flakeMaterial=new THREE.PointsMaterial({map:flakeMap,size:.8,color:0xe7f0eb,transparent:true,opacity:.48,depthWrite:false,blending:THREE.AdditiveBlending});
scene.add(new THREE.Points(flakeGeometry,flakeMaterial));

function makePostcard(index){
  const canvas=document.createElement('canvas');canvas.width=480;canvas.height=560;
  const ctx=canvas.getContext('2d'),palettes=[['#173d3d','#8caa9a'],['#3b2432','#c18e80'],['#1e314e','#7b9cac'],['#493922','#ccac71']];
  const [dark,light]=palettes[index%4],g=ctx.createLinearGradient(0,0,0,560);g.addColorStop(0,dark);g.addColorStop(1,light);ctx.fillStyle=g;ctx.fillRect(0,0,480,560);
  ctx.fillStyle='#f3d8a4';ctx.beginPath();ctx.arc(340,115,37,0,Math.PI*2);ctx.fill();
  for(let i=0;i<50;i++){ctx.fillStyle='#ffffff85';ctx.beginPath();ctx.arc(random()*480,random()*460,1+random()*2,0,Math.PI*2);ctx.fill();}
  ctx.fillStyle='#dce4d8';ctx.beginPath();ctx.moveTo(0,440);ctx.quadraticCurveTo(130,380,250,455);ctx.quadraticCurveTo(390,490,480,420);ctx.lineTo(480,560);ctx.lineTo(0,560);ctx.fill();
  if(index%3===0){ctx.fillStyle='#b67746';ctx.fillRect(128,326,193,130);ctx.fillStyle='#e0d8c5';ctx.beginPath();ctx.moveTo(105,335);ctx.lineTo(224,226);ctx.lineTo(344,335);ctx.fill();ctx.fillStyle='#f9d586';ctx.fillRect(160,360,38,46);ctx.fillRect(249,360,38,46);ctx.fillStyle='#503e2c';ctx.fillRect(212,393,26,63);}
  else{for(let k=0;k<3;k++){const x=95+k*130,y=220+(k%2)*62;ctx.fillStyle=k===1?'#183f32':'#285445';for(let n=0;n<3;n++){ctx.beginPath();ctx.moveTo(x,y+n*50);ctx.lineTo(x-50-n*13,y+100+n*50);ctx.lineTo(x+50+n*13,y+100+n*50);ctx.fill();}ctx.fillStyle='#efd18c';for(let n=0;n<8;n++){ctx.beginPath();ctx.arc(x-28+random()*56,y+70+random()*130,3,0,Math.PI*2);ctx.fill();}}}
  ctx.textAlign='center';ctx.fillStyle='#f6ead2';ctx.font='22px Georgia';ctx.fillText(['Winter wishes','A little wonder','Home for Christmas','Under the same stars'][index%4],240,67);
  return canvas;
}
function addPhoto(image,name,isPlaceholder=false){
  const texture=new THREE.CanvasTexture(image);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),4);
  const group=new THREE.Group(),aspect=image.width/image.height;let w=1.85,h=2.05;if(aspect>w/h)h=w/aspect;else w=h*aspect;
  const frame=new THREE.Mesh(new THREE.BoxGeometry(w+.2,h+.32,.09),new THREE.MeshStandardMaterial({color:0xdcb873,metalness:.8,roughness:.26}));
  const mat=new THREE.Mesh(new THREE.PlaneGeometry(w+.08,h+.2),new THREE.MeshBasicMaterial({color:0xf3e4c8}));mat.position.z=.055;
  const plane=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,toneMapped:false}));plane.position.set(0,.035,.065);group.add(frame,mat,plane);
  const p={group,texture,name,placeholder:isPlaceholder,tree:new THREE.Vector3(),scatter:scatterPosition().multiplyScalar(.72),angle:0,width:w,height:h};group.userData.photo=p;
  group.scale.setScalar(.7);root.add(group);photos.push(p);layoutPhotos();p.group.position.copy(state.mode==='TREE'?p.tree:p.scatter);updateCount();
}
function layoutPhotos(){photos.forEach((p,i)=>{const t=(i+.5)/photos.length*.85,a=t*Math.PI*6+.7,r=8.4*(1-t)+1.2;p.tree.set(Math.cos(a)*r,t*24-11.5,Math.sin(a)*r);p.angle=a;});}
function updateCount(){$('#photo-count').textContent=photos.length+(placeholders?' 张示意卡片':' 张照片');}
function clearPhotos(){for(const p of photos){root.remove(p.group);p.texture.dispose();p.group.traverse(mesh=>{mesh.geometry?.dispose();if(mesh.material)mesh.material.dispose();});}photos.length=0;}
for(let i=0;i<12;i++)addPhoto(makePostcard(i),'冬日片刻 '+String(i+1).padStart(2,'0'),true);

function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,4500);}
function setMode(mode,index=state.focus){
  if(mode==='FOCUS'&&!photos.length){toast('先添加一些照片，再来珍藏瞬间。');return;}
  if(mode!==state.mode||mode==='FOCUS')transitionUntil=elapsed+1.35;
  if(mode==='FOCUS')photoPopAge=0;
  if(mode==='SCATTER'&&state.mode==='TREE')burstAge=0;
  state.mode=mode;state.focus=(index+photos.length)%Math.max(1,photos.length);
  if(mode!=='SCATTER'){palmRotation.stop();palmDepth.stop();}
}
const selectionRay=new THREE.Raycaster(),selectionPoint=new THREE.Vector2();
function nearestVisiblePhoto(x=.5,y=.5){
  if(!photos.length)return -1;
  selectionPoint.set(x*2-1,1-y*2);selectionRay.setFromCamera(selectionPoint,camera);
  const hits=selectionRay.intersectObjects(photos.map(p=>p.group),true);let hit=hits[0]?.object;
  while(hit&&!hit.userData.photo)hit=hit.parent;
  if(hit?.userData.photo)return photos.indexOf(hit.userData.photo);
  let nearest=-1,best=Infinity,fallback=0,fallbackScore=Infinity;
  photos.forEach((p,i)=>{p.group.getWorldPosition(target);target.project(camera);
    if(target.z<=-1||target.z>=1)return;
    const center=target.x*target.x+target.y*target.y;if(center<fallbackScore){fallbackScore=center;fallback=i;}
    if(Math.abs(target.x)>1.06||Math.abs(target.y)>1.06)return;
    const dx=(target.x-selectionPoint.x)*innerWidth,dy=(target.y-selectionPoint.y)*innerHeight;
    const score=dx*dx+dy*dy;if(score<best){best=score;nearest=i;}
  });return nearest>=0?nearest:fallback;
}
$('#upload-button').onclick=()=>$('#photo-input').click();
$('#photo-input').onchange=async event=>{
  if(photoBusy)return;const files=[...event.target.files];if(!files.length)return;photoBusy=true;$('#upload-button').disabled=true;let added=0,skipped=0;
  try{for(const file of files){
    if(!/^image\/(jpeg|png|webp|avif|gif)$/.test(file.type)||file.size>20*1024*1024||(!placeholders&&photos.length>=36)){skipped++;continue;}
    let bitmap;
    try{bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});const scale=Math.min(1,1400/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);if(placeholders){clearPhotos();placeholders=false;}addPhoto(canvas,file.name);added++;}
    catch{skipped++;}finally{bitmap?.close();}
  }if(added){state.photoCursor=-1;setMode('TREE');}toast(added?`已点亮 ${added} 张照片。${skipped?`另有 ${skipped} 张未导入（格式、大小或数量限制）。`:''}`:'未能读取照片。请用 JPG、PNG 或 WebP，每张不超过 20 MB，最多 36 张。');}
  finally{photoBusy=false;$('#upload-button').disabled=false;event.target.value='';}
};

export function applyHandGesture(gesture){
  if(gesture.type==='THUMBS_UP'){
    // 浏览顺序独立于场景模式，放下拇指较久而回到树形后也继续下一张。
    const selected=state.photoCursor>=0&&state.photoCursor<photos.length
      ?(state.photoCursor+1)%photos.length:nearestVisiblePhoto(.5,.5);
    if(selected>=0){state.photoCursor=selected;setMode('FOCUS',selected);}
  }else setMode(gesture.type);
}
const handController=createHandController({video:$('#webcam'),getMode:()=>state.mode,onGesture:applyHandGesture,onLandmarks:lm=>{
  state.landmarks=lm;state.hand=lm?{x:1-lm[9].x,y:lm[9].y}:null;
},onPose:frame=>{
  const motion=handMotion.update(state.landmarks,frame.now,videoAspect());
  const resuming=frame.controlActive&&!state.controlActive;
  state.handMoving=motion.moving;state.controlActive=frame.controlActive;
  if(frame.controlActive&&frame.controlSession!==state.controlSession){
    state.controlSession=frame.controlSession;
    palmRotation.begin(state.hand,root.quaternion);palmDepth.begin(state.landmarks,videoAspect(),state.zoom);
  }else if(resuming){
    // 暂停期间的位移不能在恢复首帧补转或补缩放。
    palmRotation.pause(state.hand);palmDepth.begin(state.landmarks,videoAspect(),state.zoom);
  }
  // 静止判定只暂停呈现，不抹掉尚未越过防抖门槛的累计慢位移。
  if(!frame.controlActive)palmRotation.pause(state.hand);
  if(!frame.controlActive&&state.landmarks)palmDepth.begin(state.landmarks,videoAspect(),state.zoom);
},onStatus:status=>{
  const el=$('#gesture-status');el.textContent=status.message;el.dataset.state=status.state;
  el.hidden=['active','tracking','waiting','stopped'].includes(status.state);
  if(status.state==='error'||status.state==='stopped'){
    state.hand=null;state.landmarks=null;state.controlActive=false;state.handMoving=false;
    state.controlSession=0;handMotion.reset();palmRotation.stop();palmDepth.stop();
  }
}});
addEventListener('pagehide',()=>handController.stop());
addEventListener('pageshow',e=>{if(e.persisted)handController.start();});
addEventListener('online',()=>{if($('#gesture-status').dataset.state==='error')handController.start();});
navigator.mediaDevices?.addEventListener('devicechange',()=>{if($('#gesture-status').dataset.state==='error')handController.start();});

function videoAspect(){const video=$('#webcam');return video.videoWidth&&video.videoHeight?video.videoWidth/video.videoHeight:4/3;}
let cameraBaseDistance=64;
let blend=0;
function positionCamera(){const spreadFit=1+blend*(mobile?.35:.17);camera.position.set(0,2,cameraBaseDistance*spreadFit/state.zoom);camera.lookAt(0,0,0);camera.updateMatrixWorld();}

function resize(){const aspect=innerWidth/innerHeight;camera.aspect=aspect;cameraBaseDistance=64*Math.max(1,.62/aspect);camera.far=Math.max(260,cameraBaseDistance*1.35/.68+100);positionCamera();camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);dustMaterial.uniforms.uScale.value=renderer.getPixelRatio()*Math.min(innerHeight,1000)*.72;}
addEventListener('resize',resize);resize();
function animate(){
  renderFrameId=requestAnimationFrame(animate);const dt=Math.min(clock.getDelta(),.04);if(document.hidden||graphicsLost)return;
  renderFrame(dt);
}
function renderFrame(dt){
  elapsed+=dt;
  burstAge+=dt;photoPopAge+=dt;
  const ease=1-Math.exp(-dt*5.4),isTree=state.mode==='TREE';
  const transitioning=elapsed<transitionUntil;
  const movingByHand=state.mode==='SCATTER'&&state.controlActive&&state.handMoving;
  const updateGeometry=transitioning||movingByHand||!state.ready;
  if(transitioning||!state.ready)motionElapsed+=dt;
  blend=transitioning?THREE.MathUtils.lerp(blend,isTree?0:1,1-Math.exp(-dt*(isTree?5.8:7.2))):(isTree?0:1);
  const burst=reducedMotion?0:Math.sin(Math.min(burstAge/.78,1)*Math.PI)*Math.exp(-burstAge*.55);
  const expansion=1+burst*.26;
  if(isTree&&updateGeometry){root.quaternion.slerp(treeOrientation,ease);state.zoom=THREE.MathUtils.lerp(state.zoom,1,ease);palmDepth.reset(state.zoom);}
  else if(movingByHand){root.quaternion.copy(palmRotation.update(state.hand,dt));state.zoom=palmDepth.update(state.landmarks,videoAspect(),dt);}
  positionCamera();
  root.updateMatrixWorld(true);
  if(updateGeometry){
    for(const batch of ornaments){batch.items.forEach((p,i)=>{target.copy(p.scatter).multiplyScalar(expansion).lerp(p.tree,1-blend);p.position.lerp(target,1-Math.exp(-dt*11));scratch.position.copy(p.position);scratch.rotation.set(p.axis+motionElapsed*(isTree?.09:.19),p.spin+motionElapsed*.14,p.spin+blend*motionElapsed*.1);scratch.scale.setScalar(p.scale*(state.mode==='FOCUS'?.85:1));scratch.updateMatrix();batch.mesh.setMatrixAt(i,scratch.matrix);});batch.mesh.instanceMatrix.needsUpdate=true;}
    dust.forEach((p,i)=>{target.copy(p.scatter).multiplyScalar(expansion).lerp(p.tree,1-blend);const breathe=reducedMotion?1:1+Math.sin(motionElapsed*.7+p.phase)*.012*blend;dustPositions[i*3]=target.x*breathe;dustPositions[i*3+1]=target.y+Math.sin(motionElapsed*.45+p.phase)*.15*blend;dustPositions[i*3+2]=target.z*breathe;});dustGeometry.attributes.position.needsUpdate=true;
    ribbon.forEach((p,i)=>{target.copy(p.scatter).multiplyScalar(expansion).lerp(p.tree,1-blend);target.toArray(ribbonPositions,i*3);});ribbonGeo.attributes.position.needsUpdate=true;
    decorations.update({dt,elapsed:motionElapsed,blend,burst,focus:state.mode==='FOCUS'});
  }
  dustMaterial.uniforms.uTime.value=reducedMotion?0:elapsed;dustMaterial.uniforms.uBurst.value=burst;dustMaterial.uniforms.uOpacity.value=state.mode==='FOCUS'?.62:1;
  burstTrails.visible=state.mode==='SCATTER'&&burstAge<.95&&!reducedMotion;
  if(burstTrails.visible){const progress=Math.min(1,burstAge/.95),head=.12+(1-Math.pow(1-progress,3))*.96,tail=Math.max(0,head-.18*(1-progress));trailMaterial.opacity=Math.pow(1-progress,1.8)*.7;trailRays.forEach((ray,i)=>{target.copy(ray).multiplyScalar(tail);target.toArray(trailPositions,i*6);target.copy(ray).multiplyScalar(head);target.toArray(trailPositions,i*6+3);});trailGeometry.attributes.position.needsUpdate=true;}
  star.scale.setScalar(1-blend*.7);starGlow.material.opacity=(1-blend)*(.7+Math.sin(elapsed*1.5)*.1);ground.material.opacity=(1-blend)*.17;groundRing.material.opacity=(1-blend)*.2;
  inverse.copy(root.matrixWorld).invert();root.getWorldQuaternion(inverseQuaternion);inverseQuaternion.invert();
  star.quaternion.copy(inverseQuaternion);star.visible=isTree||blend<.8;
  if(updateGeometry)photos.forEach((p,i)=>{
    const focus=state.mode==='FOCUS'&&i===state.focus;target.copy(p.tree).lerp(p.scatter,blend);
    if(focus)target.set(0,.2,-23).applyMatrix4(camera.matrixWorld).applyMatrix4(inverse);
    p.group.position.lerp(target,1-Math.exp(-dt*(focus?9:7)));
    p.group.quaternion.slerp(inverseQuaternion,focus||isTree?ease:ease*.5);
    const focusHeight=2*Math.tan(THREE.MathUtils.degToRad(21))*23;
    const focusScale=Math.min(4.3,focusHeight*.43/(p.height+.32),(focusHeight*camera.aspect*.69)/(p.width+.2));
    const pop=focus&&!reducedMotion?1+Math.sin(Math.min(photoPopAge/.5,1)*Math.PI)*.07:1;
    const s=focus?focusScale*pop:isTree?.72:1.25;p.group.scale.lerp(target.set(s,s,s),ease);
  });
  if(!reducedMotion){for(let i=0;i<snowCount;i++){snowArray[i*3+1]-=dt*snowSpeeds[i];if(snowArray[i*3+1]<-35)snowArray[i*3+1]=35;}snowGeo.attributes.position.needsUpdate=true;for(let i=0;i<flakeCount;i++){flakePositions[i*3+1]-=dt*flakeSpeeds[i];flakePositions[i*3]+=Math.sin(elapsed*.4+i)*dt*.11;if(flakePositions[i*3+1]<-35)flakePositions[i*3+1]=35;}flakeGeometry.attributes.position.needsUpdate=true;}
  flakeMaterial.opacity=state.mode==='FOCUS'?.28:.48;
  composer.render();
  if(!state.ready){state.ready=true;$('#loader').style.opacity=0;setTimeout(()=>$('#loader').remove(),750);}
}
function scheduleGraphicsRestore(){
  clearTimeout(graphicsRestoreTimer);
  graphicsRestoreTimer=setTimeout(()=>{
    graphicsRestoreTimer=null;
    if(!graphicsLost||document.hidden)return;
    if(graphicsRestoreAttempts++<3){renderer.forceContextRestore();scheduleGraphicsRestore();}
    else toast('图形资源暂未恢复，请重新打开页面。');
  },graphicsRestoreAttempts?1500:500);
}
function pauseHandControl(){
  state.controlActive=false;state.handMoving=false;state.controlSession=0;
  handMotion.reset();palmRotation.stop();palmDepth.stop();
}
renderer.domElement.addEventListener('webglcontextlost',e=>{
  e.preventDefault();graphicsLost=true;graphicsRestoreAttempts=0;pauseHandControl();
  toast('正在恢复图形资源…');scheduleGraphicsRestore();
});
renderer.domElement.addEventListener('webglcontextrestored',()=>{
  clearTimeout(graphicsRestoreTimer);graphicsRestoreTimer=null;
  refreshEnvironment();composer.reset();resize();pauseHandControl();graphicsLost=false;
  toast('画面已恢复，可以继续手势操作。');
});
function resumeRendering(){
  if(document.hidden)return;
  if(graphicsLost){graphicsRestoreAttempts=0;scheduleGraphicsRestore();}
  if(renderFrameId!==null)cancelAnimationFrame(renderFrameId);
  clock.getDelta();renderFrameId=requestAnimationFrame(animate);
}
addEventListener('visibilitychange',resumeRendering);addEventListener('focus',resumeRendering);
addEventListener('pagehide',()=>{clearTimeout(graphicsRestoreTimer);if(renderFrameId!==null)cancelAnimationFrame(renderFrameId);renderFrameId=null;});
addEventListener('pageshow',e=>{if(e.persisted)resumeRendering();});
setMode('TREE');animate();
// 视觉核对副本不调用摄像头，主页面保持自动识别且不显示模式控件。
const previewMode=document.querySelector('meta[name="visual-preview"]')?.content;
if(['TREE','SCATTER','FOCUS'].includes(previewMode)){
  $('#gesture-status').hidden=true;
  if(previewMode==='SCATTER')setMode('SCATTER');else if(previewMode==='FOCUS')setMode('FOCUS',2);
}else handController.start();

// 仅供本地视觉核对读取场景变换，不包含照片内容或摄像头数据。
export function getVisualSnapshot(){
  const decor=root.getObjectByName('christmas-decorations');
  return {
    mode:state.mode,focus:state.focus,zoom:state.zoom,
    geometry:{orientation:root.quaternion.toArray(),
      ornaments:ornaments.map(batch=>Array.from(batch.mesh.instanceMatrix.array)),
      dust:Array.from(dustPositions),ribbon:Array.from(ribbonPositions),
      photos:photos.map(p=>p.group.matrixWorld.toArray()),
      decorations:decor?.children.map(group=>group.matrixWorld.toArray())||[]},
    snow:[...snowArray.slice(0,12),...flakePositions.slice(0,12)],
    lightTime:dustMaterial.uniforms.uTime.value,
  };
}

// 核对页用确定的帧步长检查雪与闪烁，避免后台标签暂停动画影响验证。
export function advanceVisualForVerification(seconds){
  if(!['TREE','SCATTER','FOCUS'].includes(previewMode))throw new Error('仅视觉核对页可推进测试帧');
  if(!Number.isFinite(seconds)||seconds<=0)return;
  renderFrame(Math.min(seconds,.04));
}

export function loseGraphicsForVerification(){
  if(!['TREE','SCATTER','FOCUS'].includes(previewMode))throw new Error('仅视觉核对页可模拟图形中断');
  renderer.forceContextLoss();
}
