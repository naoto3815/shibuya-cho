import * as THREE from 'three';
import * as L from './buildings/lib.js';
import {groundY} from './cityData.js';
// OSM crossing nodes 381091887 / 3623708937, and 2022-10 Street View.
// +x faces the two Shibuya tunnel portals. The road crosses north/south.
export const CROSSING={x:-602,z:247,y:11.78};
export function buildShinsenSurroundings(engine,root,box,sign,m,concourse){
 const {tile,silver,dark,yellow,white,light}=m;
 const mat=c=>new THREE.MeshStandardMaterial({color:c,roughness:.92});
 const ballast=mat(0x686660),asphalt=mat(0x424746),green=mat(0x648f7d),concrete=mat(0xa8aaa4),black=mat(0x101516),red=new THREE.MeshStandardMaterial({color:0x651a16,emissive:0x350500});
 const gravel=L.noiseTex({base:[99,98,91],variance:43,seed:260928});gravel.wrapS=gravel.wrapT=THREE.RepeatWrapping;gravel.repeat.set(28,9);ballast.map=gravel;
 const y=CROSSING.y;
 const mid=x=>247-.1*(x+602);
 const beam=(a,b,w,h,material)=>{const d=new THREE.Vector3().subVectors(new THREE.Vector3(...b),new THREE.Vector3(...a));const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d.length()),material);mesh.position.set((a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),d.normalize());mesh.castShadow=mesh.receiveShadow=true;root.add(mesh);return mesh;};
 // Replace the generic tiled ground beneath the station with its lower rail level.
 box(-612,y-.22,249,68,.4,18,ballast);
 for(let x=-646;x< -578;x++)for(const z of [240,258]){const top=Math.max(y,groundY(x,z));box(x+.5,(top+y-.4)/2,z,1,top-y+.4,.12,concrete);}

 for(let x=-646;x< -607;x++){
  const z=mid(x);
  for(const side of [-1,1]){
   box(x+.5,y+.48,z+side*5.15,1,1,2.25,concrete);
   box(x+.5,y+1.005,z+side*4.24,1,.035,.32,yellow);
   box(x+.5,(y+concourse-.5)/2,z+side*6.4,1,concourse-y-.5,.3,tile,true);
  }
 }
 // Platform roof reaches the crossing; its structure supports the concourse above.
 box(-626.5,concourse-.3,250,39,.5,17,concrete);
 for(let x=-643;x< -607;x+=6)for(const side of [-1,1]){
  const z=mid(x)+side*5.95;
  box(x,(y+concourse)/2,z,.35,concourse-y,.35,silver);
  box(x,concourse-.62,z,2.6,.06,.16,light);
 }
 // East concourse extension with a window band, not a floating unbroken box.
 box(-613.5,concourse+3.5,250,13,.3,17,tile);
 for(const z of [241.7,258.3]){
  box(-613.5,concourse+.5,z,13,1,.28,tile);
  box(-613.5,concourse+2.95,z,13,.9,.28,tile);
  for(let x=-620;x<=-607;x+=2)box(x,concourse+1.95,z,.09,1.8,.3,silver);
  box(-613.5,concourse+1.85,z,13,1.7,.08,new THREE.MeshStandardMaterial({color:0x526875,metalness:.35,roughness:.25}));
 }
 box(-606.9,concourse+1.7,250,.3,3.4,17,tile);
 sign('神泉駅',-606.68,concourse+2.6,250,6,.8,1,0,'Shinsen Station');
 // Rails continue through the platform and terminate inside both dark portals.
 for(const dz of [-2.5,2.5]){
  for(let x=-646;x< -582;x+=.65)box(x,y-.02,mid(x)+dz,.18,.16,2.05,dark);
  for(const gauge of [-.5335,.5335])beam([-646,y+.12,mid(-646)+dz+gauge],[-582,y+.12,mid(-582)+dz+gauge],.075,.13,silver);
 }
 // Level crossing: flush rubber panels, green margins, white edge lines.
 for(let z=237;z<257;z+=.5){const cx=-602+(z-247)*.07;box(cx,y+.035,z,6.7,.07,.51,asphalt);for(const s of [-1,1]){box(cx+s*2.7,y+.076,z,1.1,.016,.51,green);box(cx+s*2.12,y+.09,z,.09,.02,.51,white);}}
 for(const z of [244.5,249.5]){box(-602,y+.1,z,6.7,.08,2.15,dark);for(const dz of [-.5335,.5335])box(-602,y+.15,z+dz,6.7,.08,.075,silver);}
 // Four striped posts, warning lights and raised barrier arms.
 for(const [x,z] of [[-606,238.4],[-598.1,239],[-605.4,255.3],[-597.8,255.3]]){
  box(x,y+.55,z,.5,1.1,.65,yellow,true);
  for(let h=0;h<4;h+=.35)box(x,y+h+.17,z,.16,.34,.16,Math.round(h/.35)%2?dark:yellow);
  for(const a of [-.75,.75]){const cross=box(x,y+3.3,z,1.5,.18,.12,yellow);cross.rotation.z=a;}
  for(const dx of [-.32,.32]){box(x+dx,y+2.65,z,.42,.42,.28,black);box(x+dx,y+2.65,z-.16,.25,.25,.035,red);box(x+dx,y+2.65,z+.16,.25,.25,.035,red);}
  for(let h=0;h<4.5;h+=.4)box(x+.27,y+1.1+h,z,.12,.39,.12,Math.round(h/.4)%2?dark:yellow);
 }
 // Twin portals: a solid retaining facade with two arched openings, plus dark lined bores.
 const portalShape=new THREE.Shape();portalShape.moveTo(-6.2,-.3);portalShape.lineTo(6.2,-.3);portalShape.lineTo(6.2,7);portalShape.lineTo(-6.2,7);portalShape.closePath();
 const r=2.15,spring=2.45;
 for(const dz of [-2.5,2.5]){
  const hole=new THREE.Path();hole.moveTo(dz-r,-.2);hole.lineTo(dz+r,-.2);hole.lineTo(dz+r,spring);hole.absarc(dz,spring,r,0,Math.PI,false);hole.lineTo(dz-r,-.2);portalShape.holes.push(hole);
  const cz=mid(-590)+dz;
  box(-584,y-.15,cz,12,.3,4.3,ballast);
  for(const side of [-1,1])box(-584,y+1.18,cz+side*(r+.15),12,2.6,.3,concrete,true);
  const pos=[],idx=[];
  for(let i=0;i<=24;i++){const a=i*Math.PI/24;for(const x of [-590,-578])pos.push(x,y+spring+Math.sin(a)*r,cz+Math.cos(a)*r);if(i<24){const k=i*2;idx.push(k,k+1,k+2,k+1,k+3,k+2);}}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);g.computeVertexNormals();const lining=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0x50524f,roughness:1,side:THREE.DoubleSide}));root.add(lining);
  box(-578,y+2.5,cz,.2,5.2,4.3,black);
 }
 const pg=new THREE.ExtrudeGeometry(portalShape,{depth:.8,bevelEnabled:false,curveSegments:32});const pa=pg.attributes.position;for(let i=0;i<pa.count;i++){const u=pa.getX(i),v=pa.getY(i),d=pa.getZ(i);pa.setXYZ(i,-590+d,y+v,mid(-590)+u);}pg.computeVertexNormals();const portal=new THREE.Mesh(pg,concrete.clone());portal.castShadow=portal.receiveShadow=true;root.add(portal);
 for(let z=239.6;z<252.2;z+=.8)box(-590,y+8,z,.055,2,.055,silver);
 beam([-590,y+8.9,239.6],[-590,y+8.9,252.2],.07,.07,silver);
 for(const z of [242,257]){const lamp=new THREE.PointLight(0xfff4dc,45,19,2);lamp.position.set(-610,y+3,z);root.add(lamp);}
 for(const z of [239.7,253.8])box(-584,y+2.7,z,12,5.4,.5,concrete);
 // Overhead contact wiring and utility cabinets beside the portals.
 for(const x of [-607,-593]){for(const z of [238,255])box(x,y+3.2,z,.16,6.4,.16,silver);beam([x,y+6.25,238],[x,y+6.25,255],.18,.18,silver);}
 for(const dz of [-2.5,2.5])beam([-646,y+5.6,mid(-646)+dz],[-581,y+5.6,mid(-581)+dz],.025,.025,dark);
 for(const z of [238.5,254.5])box(-594,y+.9,z,1.1,1.8,.6,concrete,true);
 // North entrance stairs join the upper concourse. The solid risers remove the floating underside.
 for(let i=0;i<22;i++){const z=230+i*.55,top=groundY(-623,230)+(concourse-groundY(-623,230))*(i+1)/22;box(-623,(top+y-1)/2,z,3.3,top-y+1,.56,tile);}
 box(-623,concourse-.12,243.8,3.3,.24,4.4,tile);
 sign('神泉駅 北口',-623,concourse+2.4,238,4,.65,0,-1,'Inokashira Line');
 for(const side of [-1,1])beam([-623+side*1.7,groundY(-623,230)+1,230],[-623+side*1.7,concourse+1,242],.07,.07,silver);
 // Ground and visible crossing share the same level. Leave the road joins outside the cutout unchanged.
 const old=engine.world.groundBase;
 engine.world.groundBase=(x,z)=>{
  if(x>-606&&x< -598&&z>=237&&z<=257)return y+.12-(engine.world.groundSlab?.(x,z)||0);
  if(x>=-624.65&&x<=-621.35&&z>=230&&z<=246){const t=Math.min(1,(z-230)/12);return groundY(-623,230)*(1-t)+concourse*t-(engine.world.groundSlab?.(x,z)||0);}
  return old(x,z);
 };
}
