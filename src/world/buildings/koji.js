// Dogenzaka-koji: photo-referenced exterior details, source/limits in docs/reports/koji.md.
import * as THREE from 'three';
import * as L from './lib.js';
import {nightMaterial} from './shared.js';
let M;
function materials(){
 if(M)return M;
 const mat=(color,o={})=>nightMaterial(new THREE.MeshStandardMaterial({color,emissive:color,roughness:.75,...o}),.12,.012);
 const bricks=L.noiseTex({size:512,base:[137,73,49],variance:24,seed:9593,draw:(g,s)=>{g.strokeStyle='#665b4d';g.lineWidth=3;for(let y=0;y<s;y+=24){g.beginPath();g.moveTo(0,y);g.lineTo(s,y);g.stroke();for(let x=(y/24%2)*32;x<s;x+=64){g.beginPath();g.moveTo(x,y);g.lineTo(x,y+24);g.stroke();}}}});bricks.repeat.set(.5,.5);
 M={brick:mat('#ffffff',{map:bricks,emissiveMap:bricks,bumpMap:bricks,bumpScale:.06}),rim:mat('#995b3d'),white:mat('#d8d3c1'),dark:mat('#262b2b'),glass:mat('#3b4b4c',{metalness:.3,roughness:.22}),red:mat('#a62a35'),wood:mat('#664126'),metal:mat('#9a9991',{metalness:.45,roughness:.4}),green:mat('#365933'),purple:mat('#754797'),gold:mat('#b5a176')};return M;
}
function kit(b,ctx,base){
 const poly=L.ensureCW(b.poly),c=L.polyCentroid(poly),m=materials(),add=(mat,g)=>ctx.batch.add(mat,g,c[0],c[1]);
 const face=i=>{const a=poly[i],q=poly[(i+1)%poly.length],len=Math.hypot(q[0]-a[0],q[1]-a[1]),tx=(q[0]-a[0])/len,tz=(q[1]-a[1])/len,[nx,nz]=L.edgeNormal(poly,i),lift=ctx.yAt((a[0]+q[0])/2,(a[1]+q[1])/2)-base+.15;
  const p=(u,y,d=.1)=>[a[0]+tx*u+nx*d,y+lift,a[1]+tz*u+nz*d];
  const box=(mat,u,y,w,h,depth=.12,d=.06)=>add(mat,L.boxAt(...p(u,y,d),w,h,depth,Math.atan2(-tz,tx)));
  const planar=(geo,mat,u,y,d=.14)=>{const mesh=new THREE.Mesh(geo,mat);L.placeFacing(mesh,...p(u,y,d),nx,nz);mesh.updateMatrix();add(mat,mesh.geometry.applyMatrix4(mesh.matrix));};
  const sign=(text,u,y,w,h,bg,fg='#fff',emissive=.3)=>{const mesh=L.signMesh({text,w,h,bg,fg,emissive,ppm:110});planar(mesh.geometry,mesh.material,u,y,.48);};
  const letters=(text,u,y,w,h,color='#e4dcbf')=>{const mesh=L.signMesh({text,w,h,bg:'rgba(0,0,0,0)',fg:color,emissive:.25});mesh.material.transparent=true;mesh.material.alphaTest=.1;planar(mesh.geometry,mesh.material,u,y,.23);};
  return {len,p,box,sign,letters,planar,lift};};
 return {m,add,poly,face};
}

export function buildKojiBuilding(b,ctx,base){
 if(!['dg_9593','dg_9585','dg_9454'].includes(b.id)&&b.osm!==136667879&&b.osm!==136667888)return null;
 const {m,add,poly,face}=kit(b,ctx,base),reikyo=b.id==='dg_9593',uobei=b.id==='dg_9585',entry=b.id==='dg_9454',taco=b.osm===136667879;
 const h=reikyo?9.4:b.h||b.roof,material=reikyo?m.brick:taco?m.white:entry?m.dark:m.white;
 // Round the restaurant's convex corners inside its surveyed footprint.
 let shell=poly;
 if(reikyo){shell=[];for(let i=0;i<poly.length;i++){const a=poly[(i+poly.length-1)%poly.length],p=poly[i],q=poly[(i+1)%poly.length],r=.55,la=Math.hypot(p[0]-a[0],p[1]-a[1]),lb=Math.hypot(q[0]-p[0],q[1]-p[1]);const s=[p[0]+(a[0]-p[0])*Math.min(r/la,.25),p[1]+(a[1]-p[1])*Math.min(r/la,.25)],e=[p[0]+(q[0]-p[0])*Math.min(r/lb,.25),p[1]+(q[1]-p[1])*Math.min(r/lb,.25)];for(let k=0;k<=5;k++){const t=k/5;shell.push([(1-t)**2*s[0]+2*t*(1-t)*p[0]+t*t*e[0],(1-t)**2*s[1]+2*t*(1-t)*p[1]+t*t*e[1]]);}}}
 add(material,L.extrudePolygon(shell,0,h,{uvScale:1}));
 const fi=L.bestEdge(poly,uobei?-1:1,0).i,f=face(fi),w=f.len;
 if(reikyo){
  for(let i=0;i<poly.length;i++){
   const [nx,nz]=L.edgeNormal(poly,i),v=face(i);if((nx<-.25&&nz<.15)||v.len<2.5)continue;
   for(let u=1.45;u<v.len-1;u+=3.15){v.planar(new THREE.CircleGeometry(.76,24),m.glass,u,6.7);v.planar(new THREE.RingGeometry(.78,.99,28),m.rim,u,6.7,.18);v.box(m.metal,u,6.7,.035,1.44,.025,.2);}
   if(nx<-.25)for(let u=1.35;u<v.len-1;u+=2.8){v.box(m.glass,u,2.1,1.55,2.1,.1,.16);v.box(m.rim,u,3.2,1.8,.18,.15,.2);}
   v.box(m.rim,v.len/2,4.8,v.len,.22,.14,.06);v.box(m.dark,v.len/2,8.95,v.len,.16,.2,.06);
  }
  const door=w*.7;
  f.box(m.glass,door,1.25,2.1,2.5,.12,.16);f.planar(new THREE.CircleGeometry(1.05,28,0,Math.PI),m.glass,door,2.5,.16);
  f.planar(new THREE.RingGeometry(1.08,1.38,28,1,0,Math.PI),m.rim,door,2.5,.23);
  for(const dx of [-1.22,1.22])f.box(m.rim,door+dx,1.22,.3,2.44,.19,.18);
  f.box(m.wood,door,1.43,.1,2.85,.12,.25);for(const dx of [-.48,.48])for(const y of [.65,1.45,2.25])f.planar(new THREE.RingGeometry(.31,.35,20),m.gold,door+dx,y,.27);
  f.letters('麗 郷 亭',door,4.1,3.5,.8);
  for(const u of [1.5,4.2]){f.box(m.glass,u,2.1,1.5,2.1,.1,.16);f.box(m.dark,u,2.1,1.65,.08,.15,.22);}
  for(const u of [1.8,w-1.1]){f.box(m.dark,u,.28,.55,.55,.4,.15);const g=new THREE.SphereGeometry(.38,8,6);g.translate(...f.p(u,.9,.1));add(m.green,g);}
  const south=face((fi+1)%poly.length);if(south.len>1.5)south.sign('麗郷亭',south.len/2,7.7,Math.min(3,south.len-.3),.8,'#945337','#e5ddbe');
 }else if(uobei){
  f.box(m.white,w/2,3.55,w,1.1,.24,.13);f.sign('魚べえ   SUSHI',w/2,3.57,w-.5,.85,'#f2f0e7','#282d2b');
  f.box(m.red,w/2,2.95,w,.3,.8,.2);
  for(let u=1;u<w-.7;u+=2){f.box(m.glass,u,1.45,1.8,2.7,.12,.13);f.box(m.metal,u-.88,1.45,.05,2.7,.15,.22);}
  f.sign('SUSHI',1.4,1.6,1.6,.65,'#d5d7ce','#aa3038');f.sign('お持ち帰り',w-1.7,1.6,1.6,.6,'#eeeadd','#982936');
  for(let y=5.6;y<h-1;y+=3.2)for(let u=1;u<w-.8;u+=2.4)f.box(m.glass,u,y,1.65,1.8,.08,.08);
  f.sign('カラオケの達人',w/2,6.9,w-.6,.75,'#315791');
 }else if(entry){
  // The dense yellow/pink guide-board corner is distinct from the brick restaurant.
  for(let i=0;i<poly.length;i++){const v=face(i);if(v.len<3)continue;
   v.box(m.glass,v.len/2,1.4,v.len-.3,2.6,.12,.08);
   v.sign('無料案内所',v.len/2,3.25,v.len-.2,1.6,'#eee868','#bb3863');
   v.sign('INFORMATION',v.len/2,2.27,v.len-.3,.32,'#2584a4','#f5efdd');
   for(let y=5.3;y<h-1;y+=3.3)v.box(m.glass,v.len/2,y,v.len-1,1.5,.1,.07);
  }
 }else if(taco){
  f.box(m.wood,w/2,2.5,w,5,.2,.13);for(let y=.4;y<4.6;y+=.26)f.box(m.dark,w/2,y,w,.02,.02,.25);
  f.box(m.dark,w/2,4.7,w,.55,.45,.2);f.sign('TACO BELL＋',w/2,4.7,w-.4,.56,'#23262b','#e8e5ee',.7);
  const door=w*.68;f.box(m.glass,door,2.25,w*.4,2.9,.12,.27);f.sign('TACO\nBELL＋',w*.23,2.95,w*.36,1.1,'#663c28','#e4c6f7',.5);
  for(let k=0;k<5;k++)f.box(m.white,door,.09+k*.16,w*.4,.15,.65-k*.08,.25-k*.1);
  for(let y=6.3;y<h-1;y+=2.8)f.box(m.glass,w/2,y,w-.9,1.5,.1,.09);
 }else{
  f.box(m.glass,w/2,1.5,w-.5,2.8,.12,.15);
  for(const [y,color] of [[3.1,'#168c4e'],[3.36,'#eeeece'],[3.6,'#d76c2e']])f.box(new THREE.MeshStandardMaterial({color}),w/2,y,w,.22,.22,.1);
  f.sign('セブンイレブ',w/2,3.34,w-.2,.55,'#eee8ce','#228551');
  for(let y=5.5;y<h-1;y+=2.7)f.box(m.glass,w/2,y,w-1,1.5,.1,.08);
 }
 return {height:h,colliders:L.edgeColliders(poly,h),facades:[]};
}

export function buildKojiStreet(ctx){
 const {batch,yAt}=ctx,m=materials();
 // White street-name cantilever at the Dogenzaka mouth, not a gateway spanning the lane.
 for(const [x,z,nx,nz] of [[-253.45,35.7,0,1]]){
  const y=yAt(x,z),add=g=>batch.add(m.white,g,x,z);
  add(L.boxAt(x,y+2.8,z,.12,5.6,.12));add(L.boxAt(x-.83,y+5.5,z,1.8,.12,.14));
  const oval=new THREE.SphereGeometry(1,20,8);oval.scale(1.2,.33,.19);oval.translate(x-.85,y+5.35,z);add(oval);
  const mesh=L.signMesh({text:'道玄坂小路',w:2.08,h:.4,bg:'rgba(0,0,0,0)',fg:'#28537a',emissive:.2});mesh.material.transparent=true;mesh.material.alphaTest=.1;L.placeFacing(mesh,x-.85,y+5.35,z+.2*nz,nx,nz);mesh.updateMatrix();batch.add(mesh.material,mesh.geometry.applyMatrix4(mesh.matrix),x,z);
  // The entrance marker's small orange dog silhouette, simplified from the reference.
  const dog=new THREE.Shape();const points=[[-.48,0],[-.35,.3],[-.39,.65],[-.28,.64],[-.17,.47],[.28,.43],[.39,.62],[.38,.88],[.49,.77],[.61,.78],[.69,.61],[.52,.55],[.44,.15],[.55,0],[.39,0],[.27,.22],[-.2,.21],[-.28,0]];dog.moveTo(...points[0]);for(const p of points.slice(1))dog.lineTo(...p);dog.closePath();const dg=new THREE.ExtrudeGeometry(dog,{depth:.08,bevelEnabled:false});dg.translate(x-.85,y+5.67,z-.04);batch.add(m.gold,dg,x,z);
 }
 // Smaller round street lamps fit the alley; skip the generic 8 m highway-style arms.
 for(const [x,z] of [[-258.7,24],[-254.8,-24],[-251.8,-54]]){
  const y=yAt(x,z);batch.add(m.dark,L.boxAt(x,y+2.4,z,.085,4.8,.085),x,z);
  const globe=new THREE.SphereGeometry(.22,10,8);globe.translate(x,y+4.9,z);batch.add(m.white,globe,x,z);
 }
 return {};
}

export function dressKojiCentreSide(b,ctx,base){
 if(b.id!=='dg_9534')return;
 const {m,face,poly}=kit(b,ctx,base),f=face(L.bestEdge(poly,-1,0).i);
 f.box(m.white,f.len/2,2.3,f.len,4.6,.14,.09);
 const door=Math.min(2.5,f.len/2);
 f.box(m.dark,door,1.6,3.3,3.2,.16,.19);
 f.box(m.glass,door,1.6,2.9,2.95,.13,.3);
 f.box(m.metal,door,1.6,.055,2.95,.1,.39);
 f.box(m.white,door,3.6,4.8,.25,.8,.25);
 f.sign('ロイヤルポスト 3F',door,4.2,4.5,.6,'#efe0a4','#675126',.15);
 for(let u=.3;u<5;u+=.45)f.box(m.dark,u,4.9,.045,1,.06,.45);
 f.box(m.dark,2.55,5.4,4.6,.055,.06,.45);
}
