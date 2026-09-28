// Photo-referenced exterior models; exact sources and remaining limits in
// docs/reports/storefronts.md. Original procedural art, no downloaded textures.
import * as THREE from 'three';
import * as L from './lib.js';
import {nightMaterial} from './shared.js';

const IDS=new Set([136570613,136558420,136558413]);
export function buildMaruyamaVenue(b,ctx,base){
 if(!IDS.has(b.osm))return null;
 const poly=L.ensureCW(b.poly),c=L.polyCentroid(poly),{batch}=ctx;
 const mat=(color,extra={})=>{const out=new THREE.MeshStandardMaterial({color,emissive:color,roughness:.72,...extra});return nightMaterial(out,.14,extra.emissiveIntensity??.012);};
 const m={white:mat('#c3c2b7'),red:mat('#912b35'),dark:mat('#262b2e'),black:mat('#10161a'),silver:mat('#a3adb0',{metalness:.7,roughness:.34}),glass:mat('#648895',{metalness:.35,roughness:.22}),blue:mat('#206bbc'),green:mat('#5bb269'),light:mat('#d9dbb9',{emissive:'#a2a784',emissiveIntensity:.25})};
 const add=(material,g)=>batch.add(material,g,c[0],c[1]);
 const frontIndex=b.osm===136570613?2:b.osm===136558420?1:3;
 // Facade-local coordinates u along the street edge, d outward; features have a
 // single surveyed frontage datum while the foundation follows the lowest point.
 const a=poly[frontIndex],q=poly[(frontIndex+1)%poly.length],len=Math.hypot(q[0]-a[0],q[1]-a[1]),tx=(q[0]-a[0])/len,tz=(q[1]-a[1])/len,[nx,nz]=L.edgeNormal(poly,frontIndex);
 const lift=ctx.yAt((a[0]+q[0])/2,(a[1]+q[1])/2)-base+.13;
 const p=(u,y,d=0)=>{if(b.osm===136570613)u=len-u;return [a[0]+tx*u+nx*d,y+lift,a[1]+tz*u+nz*d];};
 const box=(material,u,y,w,h,depth=.1,d=0)=>add(material,L.boxAt(...p(u,y,d),w,h,depth,Math.atan2(-tz,tx)));
 const sign=(text,u,y,w,h,bg,fg='#fff',d=.13,emissive=.12,font=null)=>{const mesh=L.signMesh({text,w,h,bg,fg,emissive,font,ppm:110});L.placeFacing(mesh,...p(u,y,d),nx,nz);mesh.updateMatrix();add(mesh.material,mesh.geometry.applyMatrix4(mesh.matrix));};
 const panel=(points,material,d=.14)=>{const pts=points.map(v=>p(...v,d)),g=L.quad(pts[0],pts[1],pts[2],pts[3],[nx,0,nz]);add(material,g);};
 function poster(u,y,w,h,k){
  const canvas=L.makeCanvas(256,384),g=canvas.getContext('2d');g.fillStyle=['#172d41','#61293d','#494829','#193c37'][k%4];g.fillRect(0,0,256,384);
  g.strokeStyle=['#d9be72','#bc719c','#dbd3be','#65b9a3'][k%4];g.lineWidth=3;for(let j=0;j<7;j++){g.beginPath();g.arc(128,155,j*13+12,0,Math.PI*2);g.stroke();}
  g.fillStyle='#efede0';g.textAlign='center';g.font='bold 26px sans-serif';g.fillText(['NIGHT SHIFT','ECHOES','CITY BEATS','AFTER DARK'][k%4],128,43);g.font='18px sans-serif';g.fillText('LIVE / SHIBUYA',128,303);g.font='13px sans-serif';g.fillText('OPEN 18:00 • START 19:00',128,337);g.fillRect(20,354,216,2);
  box(m.silver,u,y,w+.09,h+.09,.08,.1);const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),L.signMaterial(canvas,{emissive:.08}));L.placeFacing(mesh,...p(u,y,.155),nx,nz);mesh.updateMatrix();add(mesh.material,mesh.geometry.applyMatrix4(mesh.matrix));
 }
 let wall=b.osm===136570613?m.white:b.osm===136558420?m.silver:m.dark;
 if(b.osm===136558413){
  const tex=L.noiseTex({base:[184,190,194],variance:17,seed:9174,draw:(g,s)=>{g.strokeStyle='#646c74';g.lineWidth=1;for(let y=0;y<s;y+=32){g.beginPath();g.moveTo(0,y);g.lineTo(s,y);g.stroke();for(let x=(y/32%2)*32;x<s;x+=64){g.beginPath();g.moveTo(x,y);g.lineTo(x,y+32);g.stroke();}}}});tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.repeat.set(.35,.35);wall=mat('#929aa0',{map:tex,bumpMap:tex,bumpScale:.045});
 }
 for(let i=0;i<poly.length;i++){
  const aa=poly[i],bb=poly[(i+1)%poly.length],[ex,ez]=L.edgeNormal(poly,i),w=Math.hypot(bb[0]-aa[0],bb[1]-aa[1]);
  const y0=i===frontIndex?6+lift:0;
  add(wall,L.boxAt((aa[0]+bb[0])/2-ex*.08,(b.h+y0)/2,(aa[1]+bb[1])/2-ez*.08,w,b.h-y0,.16,Math.atan2(aa[1]-bb[1],bb[0]-aa[0]),true));
 }
 add(m.dark,L.polygonCap(poly,b.h));
 // Recessed backing and floor: exterior-only; collision remains at the footprint.
 box(b.osm===136570613?m.white:m.black,len/2,2.9,len,5.8,.12,-1.2);box(m.dark,len/2,.03,len,.06,1.3,-.58);
 if(b.osm===136570613){
  // Long red stair enclosure with diagonal underside, white upper service wall.
  box(m.white,len/2,5.8,len,.4,.2,-.1);
  panel([[0,.25],[len-1.8,3.05],[len-1.8,5.7],[0,5.7]],m.red,.08);
  box(m.red,2.5,2.7,5,5.4,.15,.05);
  sign('club azia',len*.5,4.35,len*.55,1.25,'#912b35','#17282c',.2,.05,'Georgia, serif');
  for(let k=0;k<6;k++)poster(5.2+k*1.45,2.35,1.28,1.8,k);
  for(let k=0;k<4;k++)poster(5.2+k*1.45,.82,1.28,1.1,k+1);
  box(m.red,1.65,1.6,1.7,3,.17,.15);box(m.silver,2.2,1.4,.05,.28,.07,.26);
  const door=len-2.05;box(m.white,door,1.7,3.8,3.4,.12,-.5);box(m.black,door,1.37,2.1,2.7,.13,-.41);box(m.dark,door,3.2,4.3,.13,1.35,-.18);
  box(m.silver,6.7,8.35,5.8,1.75,.09,.03);box(m.white,6.7,8.35,5.65,1.6,.1,.1);for(let u=4;u<10;u+=1.85)box(m.silver,u,8.35,.045,1.65,.08,.18);
  // Rooftop safety rail and service pipe, visible in the source photograph.
  for(let u=.3;u<len;u+=2.8)box(m.silver,u,b.h-lift+.55,.045,1.1,.045,-.1);
  box(m.silver,len/2,b.h-lift+1.08,len,.05,.05,-.1);
  for(const u of [4,12,19])box(m.dark,u,5.85,.34,.17,.42,.25);
 }else if(b.osm===136558420){
  // O-WEST: corrugated metal, adjacent glazed bay, convenience store underneath.
  for(let u=.08;u<len;u+=.21)box(m.silver,u,(b.h-lift+6)/2,.055,b.h-lift-6,.075,.03);
  const right=len*.28,left=len*.72;
  box(m.glass,right,15.4,len*.43,8.4,.12,.08);
  for(let u=.3;u<len*.5;u+=2.1)box(m.dark,u,15.4,.1,8.5,.15,.16);
  for(let y=11.3;y<=19.7;y+=2.8)box(m.dark,right,y,len*.46,.1,.15,.16);
  box(m.dark,right,8.5,len*.43,5.15,.18,.13);sign('LIVE MUSIC',right,8.5,len*.4,4.8,'#77bc62','#244b32',.25);
  sign('O-WEZT',left,8.4,len*.42,1.25,'#46576c','#eef5f5',.16);sign('6F O-nexT',left,10,len*.42,.8,'#46576c','#dde8e6',.16);
  // Blue/white band preserves the observed shop frontage using the established alias.
  const shop=len*.58;box(m.light,shop,1.6,len*.72,3,.12,-.35);
  for(let u=4;u<len;u+=2.1){box(m.glass,u,1.55,1.9,2.7,.1,-.18);box(m.dark,u,1.6,.06,2.9,.12,-.09);}
  box(m.blue,shop,3.5,len*.73,.85,.22,.03);sign('POPPO',shop,3.5,6.2,.65,'#eef3e8','#2671b5',.17,.35);
  for(let u=5;u<len-1;u+=2.1)for(let y=.65;y<2;y+=.43)box(m.light,u,y,1.65,.08,.08,-.12);
  // North/right-hand stair, kept inside the footprint rather than blocking lane.
  for(let i=0;i<15;i++){const u=4.6-i*.29,y=(i+1)*.23;box(m.dark,u,y/2,.3,y,1.7,-.78);}
  for(let i=0;i<7;i++){const u=4.6-i*.63,y=(i*2+1)*.23;box(m.silver,u,y+.5,.045,1,.05,.045);}
  // Cylindrical sloped handrail shares the metal batch material.
  const v1=new THREE.Vector3(...p(4.6,1.2,.045)),v2=new THREE.Vector3(...p(.45,4.4,.045)),v=v2.clone().sub(v1),g=new THREE.CylinderGeometry(.035,.035,v.length(),6);g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),v.normalize()));g.translate(...v1.add(v2).multiplyScalar(.5).toArray());add(m.silver,g);
  sign('O-WEZT ↑',2.5,4.7,4.1,.7,'#172320','#81e6a0',.18,.6);
 }else{
  // WOMB: slate wall, broad projecting canopy, asymmetric stainless entry portal.
  box(m.dark,len*.69,2.9,len*.62,5.8,.12,.02);box(wall,len/2,5.8,len,.45,.8,.28);
  box(m.dark,len*.68,1.5,1.6,2.8,.12,.12);box(m.silver,len*.68+.55,1.4,.035,.35,.07,.22);
  const entrance=len*.23;box(m.silver,entrance,2.65,len*.4,5.25,.14,.1);
  box(m.black,entrance+.45,1.43,2.15,2.85,.12,.2);box(m.silver,entrance+1.58,1.48,.12,2.95,.15,.25);
  sign('WOMV',entrance,4.53,len*.32,.85,'#879499','#edf2ed',.2,.1);
  for(let i=0;i<3;i++)box(m.dark,entrance+.45,.06+i*.09,2.35,.12,1.1-i*.23,.0-i*.1);
  for(const u of [len*.51,len*.73,len*.9])sign('PLEASE KEEP QUIET',u,1.5,1.05,.47,'#dfdfd6','#30393d',.16,0);
  for(const u of [len*.52,len*.72,len*.91])box(m.dark,u,3.1,.33,.4,.16,.15);
  box(m.silver,entrance,5.35,len*.43,.16,.65,.26);
 }
 return {height:b.h,colliders:L.edgeColliders(poly,b.h),facades:[]};
}
