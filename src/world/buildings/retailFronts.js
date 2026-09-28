// Bunkamura retail fronts, modelled from the stores' official exterior photographs.
// Original geometry/type only: no downloaded photographs, advertisements or mascot assets.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { groundY } from '../cityData.js';

const displays = new Map();
function displayMaterial(electronics) {
  if(displays.has(electronics))return displays.get(electronics);
  const c=L.makeCanvas(1024,512),g=c.getContext('2d');
  g.fillStyle=electronics?'#293a50':'#79664b';g.fillRect(0,0,1024,512);
  // Lit shop interior painted from primitives; no product photographs or brand artwork.
  g.fillStyle='#eeeadd';g.fillRect(0,0,1024,125);
  for(let x=24;x<1024;x+=150){g.fillStyle='#ffffff';g.fillRect(x,25,110,13);g.fillStyle='#a9aeb6';g.fillRect(x,65,110,5);}
  for(let row=0;row<(electronics?1:3);row++){
    const y=electronics?335:150+row*108;g.fillStyle='#b2b4b6';g.fillRect(0,y+87,1024,10);
    for(let k=0;k<16;k++){
      const x=k*64+5;
      if(electronics){g.fillStyle='#151c27';g.fillRect(x,y,55,65);const gr=g.createLinearGradient(x,y,x+55,y+65);gr.addColorStop(0,['#77b7d9','#aba8d8','#73bcb2'][row]);gr.addColorStop(1,'#243b56');g.fillStyle=gr;g.fillRect(x+3,y+3,49,51);g.fillStyle='#afbac3';g.fillRect(x+21,y+65,14,6);}
      else{g.fillStyle=['#d94b36','#deb539','#f1e4c7','#79a84c','#387fac','#bd6091'][(k+row*3)%6];g.fillRect(x,y+9+(k%3)*5,43,69-(k%3)*5);g.fillStyle='#fff3d8';g.fillRect(x+6,y+27,31,20);}
      g.fillStyle='#fbe24b';g.fillRect(x,y+76,48,12);g.fillStyle='#993523';g.font='bold 10px sans-serif';g.fillText(electronics?'SPECIAL':'SALE',x+3,y+86);
    }
  }
  const m=L.signMaterial(c,{emissive:electronics?.45:.7}); displays.set(electronics,m);return m;
}
function washMaterial() {
 const c=L.makeCanvas(128,256),g=c.getContext('2d'),gr=g.createLinearGradient(0,256,0,0);
 gr.addColorStop(0,'rgba(230,240,255,.72)');gr.addColorStop(.5,'rgba(220,235,255,.22)');gr.addColorStop(1,'rgba(220,235,255,0)');g.fillStyle=gr;g.fillRect(0,0,128,256);
 return new THREE.MeshBasicMaterial({map:L.canvasTex(c),transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,opacity:.45});
}
let wash;
export function dressRetail({batch,group},lot,h,base) {
  const poly=L.ensureCW(lot.poly), electronics=lot.retail==='electronics';
  const white=L.std({color:0xd8dadd,roughness:.67,metalness:.14});
  const glass=L.std({color:0x274a61,roughness:.24,metalness:.38,emissive:0x345c78,emissiveIntensity:.48});
  const dark=L.std({color:0x20252b,roughness:.5});
  const metal=L.std({color:0x8f969c,roughness:.44,metalness:.5});
  const glow=L.std({color:0xe9e5d6,emissive:0xe9e5d6,emissiveIntensity:1.1});
  for(let i=0;i<poly.length;i++){
    const a=poly[i],b=poly[(i+1)%poly.length],len=Math.hypot(b[0]-a[0],b[1]-a[1]);
    const [nx,nz]=L.edgeNormal(poly,i),tx=(b[0]-a[0])/len,tz=(b[1]-a[1])/len;
    const mx=(a[0]+b[0])/2,mz=(a[1]+b[1])/2,rot=Math.atan2(-tz,tx);
    const face=electronics?nz<-.5:nz>.45;
    const y=groundY(mx+nx*.2,mz+nz*.2)+.15;
    const box=(u,cy,w,hh,depth,mat,out=.12)=>{const x=mx+tx*u+nx*out,z=mz+tz*u+nz*out;batch.add(mat,L.boxAt(x,cy,z,w,hh,depth,rot,false),x,z);};
    const sign=(u,cy,w,hh,text,bg,fg,em=.9)=>S.flatSign(group,mx+tx*u+nx*.78,cy,mz+tz*u+nz*.78,nx,nz,{text,w,h:hh,bg,fg,emissive:em,weight:'800'});
    const panel=(u,cy,w,hh,material,out=.48)=>{const m=new THREE.Mesh(new THREE.PlaneGeometry(w,hh),material);L.placeFacing(m,mx+tx*u+nx*out,cy,mz+tz*u+nz*out,nx,nz);group.add(m);};
    const light=(u,cy,color,intensity,distance)=>{const l=new THREE.PointLight(color,intensity,distance,2);l.position.set(mx+tx*u+nx*1.0,cy,mz+tz*u+nz*1.0);group.add(l);};
    // Cover the procedural window grid; this is a large single retailer, not stacked unrelated tenants.
    box(0,base+h/2,len,h,.18,white);
    if(!face)continue;
    if(electronics){
      box(0,y+(h-6)/2,len-1,h-6,.15,glass,.24);
      for(let fy=2;fy<h-7;fy+=3.4){panel(0,y+fy,len-1.2,2.9,displayMaterial(true),.37);box(0,y+fy+1.25,len-1.2,.09,.1,glow,.42);}
      for(let u=-len/2+1;u<len/2;u+=2)box(u,y+(h-6)/2,.10,h-6,.18,dark,.34);
      for(let fy=3;fy<h-6;fy+=2)box(0,y+fy,len-1,.13,.18,dark,.34);
      box(0,base+h-2.8,len,5.6,.16,metal,.23);
      sign(0,base+h-2.1,len*.72,3.4,'LABY','#d5d8dc','#c82e32');
      sign(0,base+h-4.7,len*.64,1,'SHIBUYA','#d5d8dc','#214c75');
      sign(0,y+4.8,len-.8,1.5,'家電・パソコン・スマートフォン','#17497d','#ffffff');
      sign(-len*.37,y+11,1.65,12,'家電・デジタル','#b92433','#ffffff',1.1);
      light(0,y+3.2,0xd9eeff,42,12);
      light(0,base+h-1,0xffdddd,22,9);
    }else{
      for(let fy=6;fy<h-1;fy+=1.8)box(0,base+fy,len,.018,.015,metal,.22);
      for(let u=-len/2+2;u<len/2;u+=3)box(u,base+h/2,.016,h,.015,metal,.22);
      const entry=Math.min(7,len*.55);
      box(0,y+2.8,entry,5.6,.2,dark,.25);
      panel(0,y+2.1,entry-.3,3.8,displayMaterial(false),.4);
      panel(-len*.34,y+1.65,Math.max(1,len*.17),2.9,displayMaterial(false),.4);
      box(0,y+3.9,entry-.4,.12,.12,glow,.39);
      box(0,y+4.9,entry-.4,.12,.3,glow,.37);
      box(0,y+7.7,len,.07,.2,glow,.42);
      box(0,y+5.3,len,.07,.2,glow,.42);
      panel(0,base+h*.57,len-.3,h*.7,wash||(wash=washMaterial()),.32);
      light(0,y+4.1,0xffe7a1,25,14);
      light(0,y+9.1,0xe2eeff,18,16);
      sign(0,y+6.5,len-.3,2.2,'MEGA ドン・キホーヂ','#171d28','#ebca53');
      sign(0,y+1.3,entry-.7,.7,'食品・日用品・雑貨  24H','#241f1c','#ffffff');
      if(lot.id.endsWith('_9')){
        sign(0,base+h-7,Math.min(5,len*.4),10,'SHIBUYA\nNIGHT\nMARKET','#8e354c','#fff2db');
        // The stepped horizontal reveals on the facade's right side.
        for(let fy=10;fy<h-1;fy+=3.4){box(len*.34,base+fy,len*.24,.28,.65,white,.45);box(len*.34,base+fy-.2,len*.2,.09,.18,glow,.53);}
      }
    }
  }
}
