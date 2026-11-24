// 原生几何构成的圣诞装饰；所有素材在本页生成，不读取外部图片。
export function createChristmasDecorations({THREE,root,random,treePosition,scatterPosition,glowMap,mobile=false,reducedMotion=false}) {
  const collection = new THREE.Group();
  collection.name = 'christmas-decorations';
  root.add(collection);
  const items = [];
  const target = new THREE.Vector3();
  const targetScale = new THREE.Vector3();
  let disposed = false;

  const palette = {gold:0xe6ba57,brass:0xb77d29,red:0xa32625,evergreen:0x174833,ivory:0xf4e6ca};
  const gold = new THREE.MeshStandardMaterial({color:palette.gold,metalness:.87,roughness:.22,emissive:0x7e400b,emissiveIntensity:.18});
  const brass = new THREE.MeshStandardMaterial({color:palette.brass,metalness:.9,roughness:.28,emissive:0x4c2606,emissiveIntensity:.12});
  const red = new THREE.MeshStandardMaterial({color:palette.red,metalness:.25,roughness:.31,emissive:0x380502,emissiveIntensity:.1});
  const green = new THREE.MeshStandardMaterial({color:palette.evergreen,metalness:.2,roughness:.38});
  const ivory = new THREE.MeshStandardMaterial({color:palette.ivory,metalness:.15,roughness:.35});
  const starMaterial = new THREE.MeshStandardMaterial({color:0xf0ce78,metalness:.76,roughness:.2,emissive:0xca7918,emissiveIntensity:.27});

  // 斜向条纹沿拐杖管身缠绕，只创建一份共享纹理。
  const candyCanvas = document.createElement('canvas');
  candyCanvas.width = candyCanvas.height = 128;
  const context = candyCanvas.getContext('2d');
  context.fillStyle = '#f7ead5';context.fillRect(0,0,128,128);
  context.fillStyle = '#b7282b';
  for(let x=-128;x<256;x+=64){context.beginPath();context.moveTo(x,0);context.lineTo(x+32,0);context.lineTo(x+160,128);context.lineTo(x+128,128);context.closePath();context.fill();}
  const candyTexture = new THREE.CanvasTexture(candyCanvas);
  candyTexture.colorSpace = THREE.SRGBColorSpace;
  candyTexture.wrapS = candyTexture.wrapT = THREE.RepeatWrapping;
  candyTexture.repeat.set(4,1);
  const candyMaterial = new THREE.MeshStandardMaterial({map:candyTexture,roughness:.27,metalness:.07});
  const canePoints = [new THREE.Vector3(0,-.55,0),new THREE.Vector3(0,-.1,0),new THREE.Vector3(0,.25,0)];
  for(let i=1;i<=8;i++){const angle=Math.PI-i*Math.PI/8;canePoints.push(new THREE.Vector3(.2+Math.cos(angle)*.2,.25+Math.sin(angle)*.2,0));}
  canePoints.push(new THREE.Vector3(.4,.12,0));
  const caneCurve = new THREE.CatmullRomCurve3(canePoints,false,'centripetal');
  const caneGeometry = new THREE.TubeGeometry(caneCurve,mobile?28:40,.065,8,false);

  // 礼物的两条金带分别绕过前后面与左右面，在盒顶交叉。
  const giftBody = new THREE.BoxGeometry(.76,.76,.76);
  const giftLid = new THREE.BoxGeometry(.82,.1,.82);
  const ribbonA = new THREE.BoxGeometry(.105,.94,.845);
  const ribbonB = new THREE.BoxGeometry(.845,.94,.105);
  const giftMaterials = [red,green,ivory];

  const starShape = new THREE.Shape();
  for(let i=0;i<10;i++){const angle=Math.PI/2+i*Math.PI/5,radius=i%2?.18:.43;const x=Math.cos(angle)*radius,y=Math.sin(angle)*radius;i?starShape.lineTo(x,y):starShape.moveTo(x,y);}
  starShape.closePath();
  const starGeometry = new THREE.ExtrudeGeometry(starShape,{depth:.13,bevelEnabled:true,bevelThickness:.035,bevelSize:.025,bevelSegments:1});
  starGeometry.center();
  const haloMaterial = glowMap ? new THREE.SpriteMaterial({map:glowMap,color:0xefb65a,transparent:true,opacity:.15,depthWrite:false,blending:THREE.AdditiveBlending}) : null;

  // 旋转曲面构成外扩钟口，口沿、摆锤和挂环保留清晰的铃铛轮廓。
  const bellProfile = [[.035,.31],[.1,.30],[.16,.23],[.18,.08],[.21,-.08],[.28,-.23],[.34,-.29],[.34,-.315],[.285,-.325]].map(([r,y])=>new THREE.Vector2(r,y));
  const bellGeometry = new THREE.LatheGeometry(bellProfile,mobile?16:24);
  const bellMaterial = gold.clone();bellMaterial.side = THREE.DoubleSide;
  const bellRim = new THREE.TorusGeometry(.325,.035,6,mobile?16:24);
  const bellClapper = new THREE.SphereGeometry(.065,8,6);
  const bellLoop = new THREE.TorusGeometry(.075,.022,5,12);

  function register(group,kind,scale) {
    const tree = treePosition().clone();
    const scatter = scatterPosition().clone();
    const outward = scatter.clone();
    if(outward.lengthSq()<.0001)outward.set(1,0,0);else outward.normalize();
    const phase = random()*Math.PI*2;
    const rotation = new THREE.Vector3((random()-.5)*(kind==='gift'?.7:.35),random()*Math.PI*2,(random()-.5)*(kind==='star'?.9:.5));
    group.position.copy(tree);group.rotation.set(rotation.x,rotation.y,rotation.z);group.scale.setScalar(scale);
    collection.add(group);
    items.push({group,tree,scatter,outward,phase,rotation,scale,speed:.65+random()*.6});
  }

  for(let i=0;i<(mobile?24:32);i++){
    const group = new THREE.Group();group.name = 'candy-cane';
    group.add(new THREE.Mesh(caneGeometry,candyMaterial));
    register(group,'cane',.9+random()*.2);
  }
  for(let i=0;i<(mobile?30:36);i++){
    const group = new THREE.Group();group.name = 'ribbon-gift';
    const material = giftMaterials[i%giftMaterials.length];
    group.add(new THREE.Mesh(giftBody,material));
    const lid = new THREE.Mesh(giftLid,material);lid.position.y=.4;group.add(lid);
    const bandA = new THREE.Mesh(ribbonA,gold),bandB = new THREE.Mesh(ribbonB,gold);bandA.position.y=bandB.position.y=.025;group.add(bandA,bandB);
    register(group,'gift',.78+random()*.34);
  }
  for(let i=0;i<(mobile?20:25);i++){
    const group = new THREE.Group();group.name = 'little-star';
    group.add(new THREE.Mesh(starGeometry,starMaterial));
    if(haloMaterial){const halo=new THREE.Sprite(haloMaterial);halo.scale.set(1.8,1.8,1);group.add(halo);}
    register(group,'star',.65+random()*.42);
  }
  for(let i=0;i<(mobile?14:20);i++){
    const group = new THREE.Group();group.name = 'gold-bell';
    group.add(new THREE.Mesh(bellGeometry,bellMaterial));
    const rim = new THREE.Mesh(bellRim,brass);rim.rotation.x=Math.PI/2;rim.position.y=-.3;group.add(rim);
    const clapper = new THREE.Mesh(bellClapper,brass);clapper.position.y=-.335;group.add(clapper);
    const loop = new THREE.Mesh(bellLoop,gold);loop.position.y=.375;group.add(loop);
    register(group,'bell',.88+random()*.2);
  }

  function update({dt=0,elapsed=0,blend=0,burst=0,focus=false}) {
    if(disposed)return;
    const step = Number.isFinite(dt)?Math.min(.06,Math.max(0,dt)):0;
    const amount = Number.isFinite(blend)?THREE.MathUtils.clamp(blend,0,1):0;
    const pulse = Number.isFinite(burst)?THREE.MathUtils.clamp(burst,0,1.4):0;
    const time = Number.isFinite(elapsed)?elapsed:0;
    // 收拢比散开更快；爆发沿球面径向过冲，聚回时自动收掉过冲量。
    const ease = 1-Math.exp(-step*(amount<.3?11:6.5));
    const scaleEase = 1-Math.exp(-step*8);
    const focusScale = focus ? .72 : 1;
    for(const item of items){
      target.copy(item.tree).lerp(item.scatter,amount).addScaledVector(item.outward,pulse*amount*3.8);
      item.group.position.lerp(target,ease);
      const scale = item.scale*focusScale;
      item.group.scale.lerp(targetScale.set(scale,scale,scale),scaleEase);
      if(!reducedMotion){
        const swing = Math.sin(time*.7+item.phase)*(.06+amount*.05);
        item.group.rotation.set(item.rotation.x+swing,item.rotation.y+time*.12*item.speed,item.rotation.z+Math.sin(time*.43+item.phase)*.08);
      }
    }
    if(haloMaterial)haloMaterial.opacity=focus ? .07 : .15;
  }

  function dispose() {
    if(disposed)return;
    disposed=true;
    const geometries = new Set(),materials = new Set(),textures = new Set([candyTexture]);
    collection.traverse(object=>{
      // Sprite 的默认平面几何由 Three 全局共享，不属于本组件。
      if(object.geometry&&!object.isSprite)geometries.add(object.geometry);
      if(object.material){const values=Array.isArray(object.material)?object.material:[object.material];values.forEach(material=>materials.add(material));}
    });
    for(const material of materials){for(const value of Object.values(material)){if(value?.isTexture&&value!==glowMap)textures.add(value);}}
    geometries.forEach(geometry=>geometry.dispose());
    materials.forEach(material=>material.dispose());
    textures.forEach(texture=>texture.dispose());
    root.remove(collection);collection.clear();items.length=0;
  }

  return {update,dispose};
}
