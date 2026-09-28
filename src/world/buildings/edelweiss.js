import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import {HOME} from '../shinsenData.js';
// User exterior + Google Street View (October 2022), observed 2026-09-28.
// Original mesh/textures. No photographs or street-view imagery are bundled.
export function buildEdelweiss(b,ctx,base){
 if(!HOME.buildingIds.includes(b.osm))return null;
 const {batch}=ctx,poly=L.ensureCW(b.poly),c=L.polyCentroid(poly),front=b.osm===136467359,h=front?7.6:10.2;
 const tex=L.noiseTex({base:[192,192,177],variance:4,seed:301,draw:(g,s)=>{g.strokeStyle='#8c8f83';g.lineWidth=1;for(let y=0;y<s;y+=10){g.beginPath();g.moveTo(0,y);g.lineTo(s,y);g.stroke();for(let x=(y/10%2)*28;x<s;x+=56){g.beginPath();g.moveTo(x,y);g.lineTo(x,y+10);g.stroke();}}}});tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.repeat.set(1.6,1.6);
 const tile=L.std({color:0xd4d4c8,map:tex,bumpMap:tex,bumpScale:.016}),dark=L.std({color:0x283131}),metal=L.std({color:0xaeb1ab,metalness:.65,roughness:.3}),glass=L.std({color:0x576e6b,metalness:.4,roughness:.24}),gold=L.std({color:0xbaa367,metalness:.55}),green=L.std({color:0x355c35});
 if(!front){S.prism(batch,tile,poly,0,h,{uvScale:1});S.parapet(batch,tile,poly,h,{h:.25,t:.16});
  for(let i=0;i<poly.length;i++){const a=poly[i],q=poly[(i+1)%poly.length],[nx,nz]=L.edgeNormal(poly,i),len=Math.hypot(q[0]-a[0],q[1]-a[1]);for(let f=0;f<3;f++)for(let u=1.5;u<len-1;u+=3){const x=a[0]+(q[0]-a[0])*u/len,z=a[1]+(q[1]-a[1])*u/len;const mesh=L.signMesh({text:'',w:1.25,h:1.1,bg:'#455c5a'});L.placeFacing(mesh,x+nx*.02,2.1+f*3.1,z+nz*.02,nx,nz);mesh.updateMatrix();batch.add(glass,mesh.geometry.applyMatrix4(mesh.matrix),...c);}}
 }else{
  const nx=.462,nz=.887,tx=.887,tz=-.462,[ox,oz]=HOME.door,y=ctx.yAt(...HOME.approach)-base;
  const pos=(u,v,d)=>[ox+tx*u+nx*d,y+v,oz+tz*u+nz*d];
  const box=(mat,u,v,d,w,hh,depth)=>batch.add(mat,L.boxAt(...pos(u,v,d),w,hh,depth,Math.atan2(nx,nz),false),...c);
  // Recessed ground floor: shuttered garage left, raised stair/entrance right.
  S.prism(batch,tile,poly,3.5,h,{uvScale:1});
  for(const u of [-3.65,.35,3.6])box(tile,u,1.7,-.5,.4,3.4,2);
  box(tile,0,3.3,-.4,7.5,.55,2.2);
  box(dark,-1.7,1.35,-1.1,3.45,2.7,.1);
  for(let v=1.25;v<2.95;v+=.075)box(metal,-1.7,v,-.92,3.45,.06,.06);
  box(tile,1.85,.8,-.5,2.6,1.6,1.4);
  box(dark,1.45,2.1,-.6,1.1,2.35,.12);
  box(metal,1.45,2.1,-.5,1.16,2.45,.05);box(glass,1.45,2.1,-.45,1,2.25,.035);
  for(let i=0;i<4;i++)for(let j=0;j<8;j++){box(metal,2.15+i*.2,1.5+j*.2,-.46,.195,.195,.07);box(glass,2.15+i*.2,1.5+j*.2,-.4,.155,.155,.035);}
  for(let k=0;k<8;k++)box(tile,1.8,(k+1)*.1,1.7-k*.27,1.9,(k+1)*.2,.28);
  // Stair cheek walls: sloping tile tops follow the treads, rather than a flat platform.
  for(let k=0;k<8;k++)for(const u of [.73,2.87])box(tile,u,.45+(k+1)*.1,1.7-k*.27,.22,.9+(k+1)*.2,.28);
  // Projecting balcony with three solid tile panels and thin silver window frames.
  box(tile,0,3.75,.18,7.6,.32,1.7);
  for(const u of [-2.5,0,2.5])box(tile,u,4.48,.98,2.46,1.15,.2);
  for(const u of [-3.68,-1.25,1.25,3.68])box(tile,u,4.55,.94,.16,1.3,.3);
  for(const u of [-2.4,0,2.4]){box(metal,u,5.45,-.08,1.9,2.05,.12);box(glass,u,5.45,.0,1.74,1.87,.04);box(metal,u,5.45,.04,.05,1.95,.05);}
  box(tile,0,6.65,0,7.55,.28,1.1);
  // Exposed rainwater pipes and their horizontal return below the balcony.
  box(metal,-3.48,3.4,1.04,.1,6.8,.1);box(metal,-2.95,3.35,1.04,1.15,.1,.1);
  box(tile,3.25,.9,1.6,.85,1.8,.35);box(gold,3.25,1.15,1.82,.86,.68,.06);
  const [sx,sy,sz]=pos(3.25,1.15,1.87);S.signQuad(batch,sx,sy,sz,nx,nz,{text:'Corpo Edelweiss',sub:'コーポエーデルワイス',w:.79,h:.61,bg:'#182525',fg:'#d7bd71',emissive:.15});
  for(let k=0;k<7;k++){const p=pos(3.3+(k%2)*.2,1.95+k*.1,1.6);const g=new THREE.IcosahedronGeometry(.4,1);g.translate(...p);batch.add(green,g,...c);}
 }
 const colliders=L.edgeColliders(poly,h);
 // front: the entrance stair's cheek walls are solid (the treads themselves are walkable — shinsen.js lifts the ground)
 if(front){const nx=.462,nz=.887,tx=.887,tz=-.462,[ox,oz]=HOME.door;for(const u of [.73,2.87])colliders.push(S.boxCollider(ox+tx*u+nx*.82,oz+tz*u+nz*.82,.22,4,2.04,Math.atan2(nx,nz),-1));}
 return {height:h,facades:[],colliders};
}
