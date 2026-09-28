// Individually surveyed exterior, first pass: O-EAST / duo / O-Crest building.
// Geometry follows the OSM footprint. Photo sources and approximation limits:
// docs/reports/storefronts.md. No reference photographs are shipped as textures.
import * as THREE from 'three';
import * as L from './lib.js';

export function buildMusicVenue(b,ctx,base){
 if(b.osm!==136587813)return null;
 const {batch}=ctx,poly=L.ensureCW(b.poly),c=L.polyCentroid(poly),h=b.h;
 const mat=(color,extra={})=>new THREE.MeshStandardMaterial({color,roughness:.8,...extra});
 const panel=mat('#858b90',{map:L.noiseTex({base:[155,158,162],variance:14,seed:9314})});
 const seam=mat('#181c20'),metal=mat('#727b7e',{metalness:.65,roughness:.42}),black=mat('#080c10');
 const glass=mat('#36505a',{metalness:.5,roughness:.22}),locker=mat('#92958d');
 const blue=mat('#335986',{emissive:'#225baa',emissiveIntensity:.55}),warm=mat('#c29052',{emissive:'#e59b43',emissiveIntensity:.45});
 const add=(m,g)=>batch.add(m,g,c[0],c[1]);
 // Retain irregular rear footprint; street faces are built around entrance recesses.
 const frames=poly.map((a,i)=>{const q=poly[(i+1)%poly.length],len=Math.hypot(q[0]-a[0],q[1]-a[1]),[nx,nz]=L.edgeNormal(poly,i),tx=(q[0]-a[0])/len,tz=(q[1]-a[1])/len;
  let lift=0;
  const p=(u,y,d=0)=>[a[0]+tx*u+nx*d,y+lift,a[1]+tz*u+nz*d];
  const box=(m,u,y,w,ht,depth=.12,d=0)=>{const v=p(u,y,d);add(m,L.boxAt(...v,w,ht,depth,Math.atan2(-tz,tx)));};
  const sign=(text,u,y,w,ht,{bg='#171c20',fg='#eee',sub=null,d=.13,emissive=.25}={})=>{const mesh=L.signMesh({text,sub,w,h:ht,bg,fg,emissive,ppm:96});const v=p(u,y,d);L.placeFacing(mesh,...v,nx,nz);mesh.updateMatrix();add(mesh.material,mesh.geometry.applyMatrix4(mesh.matrix));};
  const poster=(u,y,w,ht,title,color)=>{
   const canvas=L.makeCanvas(512,512),g=canvas.getContext('2d');g.fillStyle=color;g.fillRect(0,0,512,512);
   const grad=g.createLinearGradient(0,0,512,420);grad.addColorStop(0,'#d1c8b144');grad.addColorStop(1,'#07131fe6');g.fillStyle=grad;g.fillRect(0,0,512,512);
   for(let j=0;j<5;j++){const x=65+j*95,yy=145+(j%2)*28;g.fillStyle=['#bcc3c6','#949ead','#d4c6b3'][j%3];g.beginPath();g.ellipse(x,yy,23,31,-.13,0,Math.PI*2);g.fill();g.fillStyle='#141b27';g.beginPath();g.moveTo(x-24,yy+28);g.lineTo(x+27,yy+28);g.lineTo(x+43,380);g.lineTo(x-45,380);g.closePath();g.fill();}
   g.textAlign='center';g.fillStyle='#f3efe8';g.font='bold 31px sans-serif';g.fillText(title.replace('\n',' '),256,52);g.font='bold 19px sans-serif';g.fillText('SHIBUYA LIVE CIRCUIT',256,433);g.font='14px sans-serif';g.fillText('OPEN 18:00 / LIVE 19:00',256,467);g.fillRect(32,485,448,2);
   const m=L.signMaterial(canvas,{emissive:.1}),mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,ht),m);L.placeFacing(mesh,...p(u,y,.2),nx,nz);mesh.updateMatrix();add(m,mesh.geometry.applyMatrix4(mesh.matrix));
  };
  if(i!==5&&i!==6)box(panel,len/2,h/2,len,h,.2,-.1);
  else {box(panel,len/2,(h+5.4)/2,len,h-5.4,.2,-.1);box(black,len/2,2.7,len,5.4,.1,-.85);box(seam,len/2,.04,len,.08,1,-.4);}
  // Large sheet joints, not office windows: the upper storeys are a live hall.
  for(let y=4.5;y<h;y+=3.45)box(seam,len/2,y,len,.045,.025,.02);
  for(let u=0;u<len;u+=3.15)box(seam,u,h/2,.035,h,.025,.02);
  box(metal,len/2,h+.08,len,.16,.26);
  return {p,box,sign,poster,len,setLift:v=>{lift=v;}};
 });
 add(seam,L.polygonCap(poly,h));
 const west=frames[5],north=frames[6];
 west.setLift(.95);north.setLift(.55);
 // West: three tall portal bays below the poster band; entrance is inset.
 for(const u of [.25,7.2,14.7,22.3,29.85])west.box(metal,u,2.3,.42,4.6,.5,-.08);
 west.box(metal,15,4.4,30,.45,.52,-.08);
 for(const u of [10.9,18.5]){
  west.box(blue,u,3.3,6.6,.8,.12,-.54);
  for(let j=0;j<9;j++)west.box(metal,u,2.95+j*.085,6.6,.035,.13,-.43);
  west.sign('due',u,3.43,3.5,.63,{bg:'#243749',sub:'MUSIC EXCHANGE',d:-.32,emissive:.6});
  for(const dx of [-1.65,1.65]){west.box(warm,u+dx,1.32,2.95,2.55,.08,-.79);west.box(black,u+dx,1.25,2.58,2.25,.09,-.72);west.box(metal,u+dx-.95,1.2,.035,.55,.05,-.62);}
  west.box(metal,u,1.35,.28,2.7,.48,-.3);
 }
 west.sign('O-EAZT',3.6,3.75,5,.65,{fg:'#97e5a4',d:-.3});
 // Upper posters are original game event graphics. Their positions follow photos.
 for(const [k,u] of [6.2,12.1,18].entries()){
  west.box(black,u,7.7,5.4,4.7,.2,.07);
  west.poster(u,7.7,5,4.3,['MIDNIGHT SESSION','NEON VOICES','CITY RESONANCE'][k],['#32536b','#6d304f','#a29a40'][k]);
  west.box(metal,u,10.55,5.8,.1,.1,.3);
  for(const dx of [-2,0,2])west.box(metal,u+dx,10.7,.32,.18,.5,.4);
 }
 // Corner glass stairwell and its dark mullions, visible from both streets.
 for(const f of [west,north]){const u=f===west?f.len-1.45:1.45;f.box(glass,u,8.25,2.6,14,.12,.065);for(let y=2;y<15.4;y+=2.15)f.box(metal,u,y,2.65,.075,.14,.12);}
 function venueBadge(f,u,y,label){
  // Original coloured cut-out backing in the same signage zone, not a photo decal.
  for(const [k,color] of ['#f29737','#df4b70','#4595dc','#c3469b'].entries()){
   const pts=[[u-2.25+(k%2)*2.4,y-1.7+Math.floor(k/2)*1.8],[u+.1+(k%2)*2.4,y-1.1+Math.floor(k/2)*1.8],[u-1.5+(k%2)*2.4,y+1.1+Math.floor(k/2)*1.8]];
   const g=new THREE.BufferGeometry().setFromPoints(pts.map(([x,z])=>new THREE.Vector3(...f.p(x,z,.16))));g.setIndex([0,1,2,2,1,0]);g.computeVertexNormals();add(mat(color),g);
  }
  f.sign(label,u,y,4.5,1.3,{bg:'#25282c',sub:'LIVE MUSIC',d:.19});
 }
 venueBadge(west,26.2,6.3,'O-EAZT');venueBadge(north,8.8,6.5,'O-Cresta');
 // Crest door and lockers are on the Hyakkendana (north) side, not on the west.
 north.box(seam,9.4,2.25,5.5,4.5,.4,-.2);north.box(black,9.4,1.45,2.3,2.9,.12,.025);
 north.sign('5F  O-Cresta',9.4,3.35,4,.65);
 north.box(seam,4.2,2.9,4.8,.15,1.2,.15);
 for(let col=0;col<6;col++)for(let row=0;row<3;row++){
  const u=2.05+col*.68,y=.5+row*.72;north.box(locker,u,y,.64,.68,.38,.12);north.box(seam,u+.19,y,.07,.2,.02,.33);north.box(metal,u-.06,y+.13,.24,.1,.02,.33);
 }
 north.box(black,8.1,13.8,7.2,5.6,.28,.16);north.sign('SOUND OF\nTHE CITY',8.1,13.8,6.8,5.15,{bg:'#334958',sub:'SHIBUYA LIVE CIRCUIT',d:.32,emissive:.1});
 // Tiny pavement-level event cases, kept flush so the narrow street stays clear.
 for(let k=0;k<6;k++)west.sign(k%2?'LIVE\nTONIGHT':'CITY\nMUSIC',24+k*.87,1.6,.82,1.8,{bg:k%2?'#768b9f':'#b68c9b',fg:'#f5eeee',d:.12,emissive:0});
 const colliders=L.edgeColliders(poly,h);
 return {height:h,colliders,facades:[],name:'O-EAZT / due / O-Cresta',base};
}
