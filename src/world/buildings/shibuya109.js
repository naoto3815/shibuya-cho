// SHIBUYA109 architectural study; fictional identity SHIBUYA ARC.
// Photo references are viewed only, never shipped as textures. See docs/reports/109-exterior.md.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
export const KEYS=['shibuya109'];
export const SIZE={w:63,d:51,h:42};

export function build({key,data,batch,inst,group,groundRel=null}){
 const M=S.mats(),[cx,cz]=data.cylinder.center,R=data.cylinder.radius,H=data.size[1];
 const [fx,fz]=S.dirOf(data.rotY),th=Math.atan2(fz,fx),TAU=Math.PI*2,GF=5.7;
 const at=(u,v,y)=>new THREE.Vector3(cx+fz*u+fx*v,y,cz-fx*u+fz*v);
 const add=(m,g)=>batch.add(m,g,cx,cz);
 const mat=(color,extra={})=>new THREE.MeshStandardMaterial({color,roughness:.55,...extra});
 const gold=mat('#bca26a',{metalness:.48,roughness:.38,emissive:'#a68b58',emissiveIntensity:.16}),dark=mat('#202328'),pink=mat('#b66791',{emissive:'#95577b',emissiveIntensity:.13}),stone=mat('#969695');
 // Hand-drawn neutral panel grid: no slit windows, ribbed texture or floor ledges.
 const cv=L.makeCanvas(512,512),ct=cv.getContext('2d');
 ct.fillStyle='#b9bfc0';ct.fillRect(0,0,512,512);
 for(let y=0;y<512;y+=128)for(let x=0;x<512;x+=128){const q=182+Math.floor(L.hash(x,y,109)*12);ct.fillStyle=`rgb(${q},${q+4},${q+5})`;ct.fillRect(x+1,y+1,126,126);ct.strokeStyle='#899294';ct.lineWidth=1;ct.strokeRect(x+.5,y+.5,127,127);}
 const panel=mat('#ffffff',{map:L.canvasTex(cv,{wrap:true}),metalness:.25,roughness:.56,emissive:'#a8afb1',emissiveIntensity:.17});panel.map.repeat.set(1/5.6,1/5.6);
 const box=(m,u,v,y,w,h,d)=>{const p=at(u,v,y);add(m,L.boxAt(p.x,p.y,p.z,w,h,d,Math.atan2(fx,fz)));};
 function beam(u,v,y,u1,v1,y1,r=.07){const a=at(u,v,y),b=at(u1,v1,y1),len=a.distanceTo(b),geo=new THREE.CylinderGeometry(r,r,len,8);geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),b.clone().sub(a).normalize()));geo.translate((a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2);add(gold,geo);}
 // Clip the old pointed generic podium behind the cylinder so it cannot fill the entrance.
 const vOf=p=>(p[0]-cx)*fx+(p[1]-cz)*fz;
 let poly=[];const original=L.ensureCW(data.polygon);
 for(let i=0;i<original.length;i++){const a=original[i],b=original[(i+1)%original.length],va=vOf(a)+2.5,vb=vOf(b)+2.5;if(va<=0)poly.push(a);if((va<=0)!==(vb<=0)){const t=va/(va-vb);poly.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}}
 S.prism(batch,panel,poly,-1,29.5,{cap:true});
 const colliders=L.edgeColliders(poly,29.5);
 S.parapet(batch,M.silver,poly,29.5,{h:.55,t:.18});
 // Side wings have service glazing/louvres and a restrained ground-level frontage.
 for(let i=0;i<poly.length;i++){
  const a=poly[i],b=poly[(i+1)%poly.length],len=Math.hypot(b[0]-a[0],b[1]-a[1]);if(len<10)continue;
  const [nx,nz]=L.edgeNormal(poly,i),mx=(a[0]+b[0])/2,mz=(a[1]+b[1])/2,rot=Math.atan2(-(b[1]-a[1]),b[0]-a[0]);
  for(const y of [8.5,13.5,18.5]){add(dark,L.boxAt(mx+nx*.04,y,mz+nz*.04,len*.72,2.6,.08,rot));for(let k=0;k<7;k++)add(M.silver,L.boxAt(mx+nx*.09,y-1.2+k*.36,mz+nz*.09,len*.72,.05,.08,rot));}
  const gy=groundRel?Math.max(0,groundRel(mx,mz)):0;
  add(M.glassDark,L.boxAt(mx+nx*.1,gy+2.1,mz+nz*.1,len*.82,3.8,.1,rot));
 }
 // Continuous tiled drum; one recessed technical band near the crown.
 add(panel,S.cylSegment(cx,cz,R,GF,H,0,TAU,128,{metres:true}));
 add(dark,S.cylSegment(cx,cz,R+.025,H-8.6,H-8.38,0,TAU,128,{metres:true}));
 add(M.silver,S.disc(cx,cz,R-.25,R+.06,H,{seg:128,up:true}));
 add(S.roofMat(),L.polygonCap(S.arcPoints(cx,cz,R-.25,0,TAU,64).slice(0,-1),H));
 // Solid lower cylinder, interrupted only by the entrance/stair opening.
 const ea=.86;
 add(panel,S.cylSegment(cx,cz,R,-1,GF,th+ea,th+TAU-ea,96,{metres:true}));
 const edge=S.arcPoints(cx,cz,R,th+ea,th+TAU-ea,48);
 colliders.push(...L.edgeColliders([...edge,[cx,cz]],GF));
 // Pink recessed portal and neutral dark lobby. No invented cafe/bar counter.
 const doorV=R-3.6,gy=groundRel?Math.max(0,groundRel(...[at(0,doorV,0).x,at(0,doorV,0).z])):0;
 box(dark,0,doorV-.55,gy+2.25,7.5,4.5,.15);
 box(pink,0,doorV,gy+4.7,8.2,1.45,.3);
 for(const u of [-3.95,3.95])box(pink,u,doorV,gy+2,.38,4,.45);
 for(const u of [-2.5,-1.25,0,1.25,2.5])box(M.silver,u,doorV+.1,gy+1.9,.055,3.8,.1);
 box(M.glassClear,0,doorV+.04,gy+1.9,7.5,3.8,.08);
 box(M.glowWarm,0,doorV-1,gy+3.8,6.5,.08,.3);
 const dp=at(0,doorV,gy+2);
 colliders.push({obb:{center:dp,halfSize:new THREE.Vector3(4,2,.2),rotationY:Math.atan2(fx,fz)}});
 // Right-hand exterior stair: narrow gold treads and paired balustrades.
 const stairU=5.45,stairV=R+1.1,n=24,depth=6.6,rise=4.6;
 for(let k=0;k<n;k++)box(gold,stairU,stairV-k*depth/n,gy+(k+1)*rise/n/2,2.25,(k+1)*rise/n,depth/n+.025);
 for(const u of [stairU-1.14,stairU+1.14]){
  beam(u,stairV,gy+.95,u,stairV-depth,gy+rise+.95,.045);
  for(let k=0;k<=6;k++){const v=stairV-depth*k/6,y=gy+rise*k/6;beam(u,v,y,u,v,y+.95,.035);}
 }
 // Stairs are dressing, with a solid collision box at their foot (no unsupported traversal).
 const sp=at(stairU,stairV-depth/2,gy+rise/2);
 colliders.push({obb:{center:sp,halfSize:new THREE.Vector3(1.13,rise/2,depth/2),rotationY:Math.atan2(fx,fz)}});
 // Flat, open gold space-frame canopy, no oversized circular slab.
 const back=R-3.2,front=R+3.1,top=gy+7.1;
 for(const u of [-5.65,5.65])for(const v of [back,front]){
  beam(u,v,groundRel?Math.max(0,groundRel(at(u,v,0).x,at(u,v,0).z)):0,u,v,top,.12);
  const p=at(u,v,top/2);colliders.push({obb:{center:p,halfSize:new THREE.Vector3(.13,top/2,.13),rotationY:0}});
 }
 for(let k=0;k<=4;k++){
  const v=back+(front-back)*k/4;beam(-5.65,v,top,5.65,v,top);beam(-5.65,v,top-.6,5.65,v,top-.6,.055);
  for(let j=0;j<6;j++){const u=-5.65+j*11.3/6;beam(u,v,top,u+11.3/12,v,top-.6,.045);beam(u+11.3/12,v,top-.6,u+11.3/6,v,top,.045);}
 }
 for(let j=0;j<=6;j++){const u=-5.65+j*11.3/6;beam(u,back,top,u,front,top,.055);for(let k=0;k<4;k++)beam(u,back+(front-back)*k/4,top,u+(j<6?11.3/6:-11.3/6),back+(front-back)*(k+1)/4,top,.035);}
 for(const u of [-4,0,4])box(M.glowWarm,u,back+2,top-.67,.22,.06,.5);
 box(pink,0,front,top-.18,11.3,1.35,.13);
 // Original typography, not the 109 logo. Transparent raised-look ARC lettering.
 function logo(u,v,y,w,h,tag){
  const c=L.makeCanvas(1024,512),g=c.getContext('2d');g.clearRect(0,0,1024,512);g.textAlign='center';g.font='700 265px Helvetica';g.fillStyle='#ac83ae';g.fillText('ARC',512,296);g.font='500 64px Helvetica';g.fillStyle=tag?'#eef0f0':'#454650';g.fillText('S H I B U Y A',512,408);
  const m=L.signMaterial(c,{transparent:true,emissive:.7});m.depthWrite=false;const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),m);const p=at(u,v,y);L.placeFacing(mesh,p.x,p.y,p.z,fx,fz);mesh.name='original:SHIBUYA ARC';group.add(mesh);
 }
 logo(0,R+.27,H-3.5,8.6,5.1,false);
 logo(0,front+.1,top-.1,3.5,1.55,true);
 logo(0,doorV+.2,gy+4.8,3.7,1.6,true);
 // Original abstract fashion campaign on the lower cylinder (no portraits or copied ads).
 const ad=L.makeCanvas(1024,1024),g=ad.getContext('2d'),gr=g.createLinearGradient(0,0,1024,1024);gr.addColorStop(0,'#243c58');gr.addColorStop(1,'#785379');g.fillStyle=gr;g.fillRect(0,0,1024,1024);
 for(let k=0;k<8;k++){g.strokeStyle=k%2?'#cabaaa':'#92bbbe';g.lineWidth=18;g.beginPath();g.arc(220+k*82,480,150+k*21,.25,4.5);g.stroke();}
 g.fillStyle='#f4ece3';g.textAlign='center';g.font='600 92px Helvetica';g.fillText('AFTER HOURS',512,175);g.font='500 36px Helvetica';g.fillText('SHIBUYA ARC  /  AUTUMN COLLECTION',512,900);
 const am=L.signMaterial(ad,{emissive:.12});add(am,S.cylSegment(cx,cz,R+.045,13.2,27.5,th-.76,th+.76,64,{flipU:true}));
 // One small service opening below the campaign panel.
 const vp=at(0,R+.1,11.1);add(dark,L.wallQuad(vp.x,vp.y,vp.z,fx,fz,3.2,.65,0));
 const light=new THREE.PointLight('#ffe2b8',8,14,2);light.position.copy(at(0,doorV+2,gy+4));
 const anchors={cylinder:{center:new THREE.Vector3(),radius:R,height:H},entrance:at(0,front,0).sub(new THREE.Vector3(cx,0,cz))};
 return {group:new THREE.Group(),origin:[cx,cz],worldSpace:true,colliders,lights:[light],anchors,facades:S.facadeRecords(key,poly,29.5,8,{tenants:['SHIBUYA ARC']})};
}
export default {build,KEYS,SIZE};
