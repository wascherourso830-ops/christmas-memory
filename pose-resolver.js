// 融合官方手势类别与保守几何；此模块不申请摄像头，也不保存识别状态。
import { classifyHandPose } from './hand-pose-classifier.js';

const supported = {
  Thumb_Up: {pose:'THUMBS_UP',minimum:.65},
  Open_Palm: {pose:'SCATTER',minimum:.60},
  Closed_Fist: {pose:'TREE',minimum:.65},
};
const photoConflicts = new Set(['Victory','Pointing_Up','ILoveYou','I_Love_You','Thumb_Down','OK']);

function inspectLandmarks(landmarks,aspect) {
  if(!Array.isArray(landmarks)||landmarks.length<21||!Number.isFinite(aspect)||aspect<=.2||aspect>=5)return null;
  const points=landmarks.slice(0,21);
  if(points.some(point=>!point||!Number.isFinite(point.x)||!Number.isFinite(point.y)
    ||(point.z!=null&&!Number.isFinite(point.z))||Math.abs(point.x)>4||Math.abs(point.y)>4||Math.abs(point.z??0)>4))return null;
  const distance=(a,b)=>Math.hypot((a.x-b.x)*aspect,a.y-b.y,((a.z??0)-(b.z??0))*aspect);
  const palmScale=distance(points[0],points[9]),width=distance(points[5],points[17]);
  // 这里只排除太小或退化的关键点，不要求正面掌形通过旧几何门槛。
  if(palmScale<.018||palmScale>2||width<.003||width>2)return null;
  const center=[0,5,9,13,17].reduce((sum,index)=>({x:sum.x+points[index].x/5,y:sum.y+points[index].y/5}),{x:0,y:0});
  return {palmScale,cursor:{x:Math.max(0,Math.min(1,1-center.x)),y:Math.max(0,Math.min(1,center.y))}};
}

function topCategory(categories) {
  if(!Array.isArray(categories))return null;
  const valid=categories.filter(category=>category&&typeof(category.categoryName??category.displayName)==='string'
    &&Number.isFinite(category.score)&&category.score>=0&&category.score<=1);
  if(!valid.length)return null;
  const best=valid.reduce((a,b)=>b.score>a.score?b:a);
  return {name:best.categoryName??best.displayName,score:best.score};
}

export function resolveHandPose(landmarks,aspect=4/3,modelCategories=[],{classify=classifyHandPose}={}) {
  let geometry=null;
  try{geometry=classify(landmarks,aspect);}catch{/* 单帧几何失败不阻止有效模型类别。 */}
  const raw=inspectLandmarks(landmarks,aspect),model=topCategory(modelCategories);
  const neutral={pose:'NEUTRAL',valid:!!raw,score:0,palmScale:raw?.palmScale??0,cursor:raw?.cursor??{x:.5,y:.5},
    releaseClear:false,strong:false,source:'none',modelCategory:model,features:geometry?.features??{}};
  if(model&&supported[model.name]&&model.score>=supported[model.name].minimum) {
    if(!raw)return {...neutral,valid:false};
    const pose=supported[model.name].pose;
    return {...neutral,pose,score:model.score,strong:true,source:'model',
      releaseClear:pose==='TREE'||pose==='SCATTER'};
  }
  // 明确向下的拇指可解除照片锁，但不映射成另一个场景动作。
  if(raw&&model?.name==='Thumb_Down'&&model.score>=.65)
    return {...neutral,score:model.score,releaseClear:true,source:'model-release'};
  // 高可信非命令手势不能因几何误差变成张掌、握拳或照片，也不能误解开照片锁。
  if(raw&&model&&photoConflicts.has(model.name)&&model.score>=.65)
    return {...neutral,score:model.score,source:'model-conflict'};
  if(!geometry?.valid)return neutral;
  const features=geometry.features??{},fingers=features.fingers;
  let pose=['THUMBS_UP','SCATTER','TREE'].includes(geometry.pose)&&geometry.score>=.7?geometry.pose:'NEUTRAL';
  if(pose==='THUMBS_UP') {
    const conflictingGeometry=features.ambiguousPinch===true||features.allFolded===false||features.thumb?.up===false;
    if(conflictingGeometry)pose='NEUTRAL';
  }
  // 握拳时拇指已折回、四指收拢也可明确释放，不必先张开拇指与食指。
  const foldedThumb=features.allFolded===true&&features.thumb?.retracted===true&&!features.ambiguousPinch;
  const releases=geometry.releaseClear===true||pose==='TREE'||pose==='SCATTER'||foldedThumb;
  return {...geometry,pose,score:Number.isFinite(geometry.score)?geometry.score:0,
    strong:false,source:'geometry',modelCategory:model,
    releaseClear:pose!=='THUMBS_UP'&&releases};
}

