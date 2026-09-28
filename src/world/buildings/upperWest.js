// Completed-state interpretation of the published 2025 Shibuya Upper West design.
// This is a game model, not a construction/BIM model; see docs/reports/upper-west.md.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import {UPPER_WEST as D} from '../upperWestData.js';

export function buildUpperWest(ctx){
 const {batch,inst,world,yAt}=ctx, M=S.mats(),c=L.polyCentroid(D.poly);
 const base=Math.min(...D.poly.map(p=>yAt(...p)));
 const ceramic=new THREE.MeshStandardMaterial({color:'#d3dbd9',roughness:.6,metalness:.22});
 const terrace=new THREE.MeshStandardMaterial({color:'#6e7766',roughness:.94});
 const leaf=new THREE.MeshStandardMaterial({color:'#38633c',roughness:.95});
 const tex=L.makeCanvas(256,512),emi=L.makeCanvas(256,512),g=tex.getContext('2d'),e=emi.getContext('2d');
 g.fillStyle='#8ba5b5';g.fillRect(0,0,256,512);e.fillStyle='#000';e.fillRect(0,0,256,512);
 for(let r=0;r<8;r++)for(let k=0;k<8;k++){
  const x=k*32,y=r*64,t=L.hash(k,r,728);
  g.fillStyle=t>.65?'#9eb5c0':'#7693a6';g.fillRect(x+2,y+2,28,55);
  g.fillStyle='#c5cfd1';g.fillRect(x,y+58,32,6);g.fillRect(x,y,2,64);
  if(t>.76){e.fillStyle=t>.9?'#e5ce9f':'#8f9aa5';e.fillRect(x+3,y+3,26,52);}
 }
 const glass=new THREE.MeshStandardMaterial({map:L.canvasTex(tex,{wrap:true}),emissiveMap:L.canvasTex(emi,{wrap:true}),emissive:0xffffff,emissiveIntensity:.15,roughness:.32,metalness:.3});
 glass.map.repeat.set(1/16,1/32);glass.emissiveMap.repeat.set(1/16,1/32);
 glass.userData.sign={emissive:.7};L.signMaterials.add(glass);
 const add=(m,g)=>batch.add(m,g,...c);
 batch.lift=inst.lift=base;
 function garden(poly,y,exclude=[]){
  const b=L.polyBounds(poly);
  for(let x=b.x0+2;x<b.x1-1;x+=6.1)for(let z=b.z0+2;z<b.z1-1;z+=6.1){
   if(!L.pointInPoly(x,z,poly)||exclude.some(p=>L.pointInPoly(x,z,p))||L.hash(x,z,919)<.18)continue;
   const h=1.1+L.hash(x,z,573)*1.8;
   S.ibox(inst,'suw_planter',M.concrete,x,y,z,4.2,.4,3.6);
   inst.add('suw_leaves',S.HEDGE_GEO,leaf,x,y+.6+h*.45,z,0,4.1,h,3.5);
   if(L.hash(x,z,17)>.8){S.ibox(inst,'suw_trunk',M.darkMetal,x,y+.4,z,.16,3.2,.16);inst.add('suw_leaves',S.HEDGE_GEO,leaf,x,y+3.4,z,0,3.6,3.2,3.6);}
  }
 }
 // Seven retail/museum levels, stepping up from the west toward the tower.
 for(let k=0;k<D.tiers.length;k++){
  const t=D.tiers[k];
  S.prism(batch,glass,t.poly,k===0?-2:t.bottom,t.top,{uvScale:1});
  S.rings(batch,ceramic,t.poly,t.bottom+.1,t.top,4.7,{h:.5,out:.12});
  S.fins(inst,'suw_fins',ceramic,t.poly,Math.max(0,t.bottom),t.top,3.2,{w:.12,d:.22,out:0});
  add(terrace,L.polygonCap(t.poly,t.top+.03));
  S.parapet(batch,ceramic,t.poly,t.top,{h:.28,t:.28});
  garden(t.poly,t.top+.05,k<6?[D.tiers[k+1].poly]:[D.tower]);
 }
 // Main hotel/residential shaft with fine ceramic grid and recessed balcony bands.
 S.prism(batch,glass,D.tower,32.9,139.7,{uvScale:1});
 S.rings(batch,ceramic,D.tower,33,139.7,4.1,{h:.23,out:.16});
 S.fins(inst,'suw_tower_fins',ceramic,D.tower,33,139.7,2.05,{w:.1,d:.24,out:0});
 const tp=L.ensureCW(D.tower),face=L.bestEdge(tp,1,1);
 for(let y=72;y<139;y+=4.1){
  const m=[face.mid[0]+face.nx*.14,y,face.mid[1]+face.nz*.14];
  add(M.darkMetal,L.boxAt(...m,11,2.6,.16,Math.atan2(-face.tz,face.tx)));
  add(ceramic,L.boxAt(m[0]+face.nx*.12,y-1.2,m[2]+face.nz*.12,11,.22,.65,Math.atan2(-face.tz,face.tx)));
 }
 // Planted crown rises in four strips to the published 155.7m apex.
 for(const r of D.crown){
  S.prism(batch,glass,r.poly,139.7,r.top,{uvScale:1});
  S.rings(batch,ceramic,r.poly,139.7,r.top,4,{h:.22,out:.1});
  S.fins(inst,'suw_crown_fins',ceramic,r.poly,139.7,r.top,2.05,{w:.1,d:.22});
  add(terrace,L.polygonCap(r.poly,r.top));garden(r.poly,r.top);
 }
 // Ground-level entrances, glazing, ceramic canopy and quiet retail signage.
 const poly=L.ensureCW(D.poly);
 for(let i=0;i<poly.length;i++){
  const a=poly[i],b=poly[(i+1)%poly.length],len=Math.hypot(b[0]-a[0],b[1]-a[1]);
  const [nx,nz]=L.edgeNormal(poly,i),rot=Math.atan2(-(b[1]-a[1]),b[0]-a[0]);
  if(nz<.1||len<18)continue;
  const mx=(a[0]+b[0])/2,mz=(a[1]+b[1])/2,gy=Math.max(0,yAt(mx,mz)-base);
  add(M.darkMetal,L.boxAt(mx+nx*.2,gy+2.8,mz+nz*.2,Math.min(18,len*.35),5.6,.18,rot));
  add(ceramic,L.boxAt(mx+nx*.5,gy+5.8,mz+nz*.5,len*.7,.3,1.4,rot));
  S.signQuad(batch,mx+nx*.35,gy+6.8,mz+nz*.35,nx,nz,{text:'UPPER WEST',sub:'SHIBUYA  /  RETAIL · ART · RESIDENCES',w:Math.min(23,len*.65),h:1.5,bg:'#384b50',fg:'#e6ede6',emissive:.45});
  for(const v of [-4,4]){const x=mx+(b[0]-a[0])/len*v,z=mz+(b[1]-a[1])/len*v;add(M.glassClear,L.boxAt(x+nx*.32,gy+2.4,z+nz*.32,3.6,4.6,.1,rot));}
 }
 batch.lift=inst.lift=0;
 for(const col of L.edgeColliders(poly,34)){if(col.obb)col.obb.center.y+=base;else{col.min.y+=base;col.max.y+=base;}world.addStatic(col,{tag:'building'});}
 return {plan:[{id:D.id,poly:D.poly,h:D.height,base,storeys:34,style:'landmark',name:'Shibuya Upper West Project',source:'Tokyu/Snohetta 2025 planned exterior'}],facades:[]};
}
