import * as THREE from 'three';
import {buildShinsenSurroundings,CROSSING} from './shinsenSurroundings.js';
import {createApartment} from './apartment301.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {groundY} from './cityData.js';
import * as L from './buildings/lib.js';
import {HOME,SHINSEN,SHIBUYA_RAIL,canUseRail} from './shinsenData.js';

export default {
 name:'shinsen',
 init(engine){
  this.engine=engine;this.pending=false;this.root=new THREE.Group();this.root.name='shinsen-station-and-rail-gates';engine.scene.add(this.root);
  const material=(color,extra={})=>new THREE.MeshStandardMaterial({color,roughness:.8,...extra});
  const tileTex=L.noiseTex({base:[148,147,132],variance:7,seed:2025,draw:(g,s)=>{g.strokeStyle='#676b65';g.lineWidth=2;for(let y=0;y<s;y+=32){g.beginPath();g.moveTo(0,y);g.lineTo(s,y);g.stroke();for(let x=(y/32%2)*32;x<s;x+=64){g.beginPath();g.moveTo(x,y);g.lineTo(x,y+32);g.stroke();}}}});tileTex.wrapS=tileTex.wrapT=THREE.RepeatWrapping;
  const tile=material(0xb6b4a4,{map:tileTex}),silver=material(0x9aa6a5,{metalness:.7,roughness:.28}),dark=material(0x242d32),blue=material(0x294f84),yellow=material(0xd8b448),white=material(0xe4e3d9),light=material(0xffffff,{emissive:0xfff2d9,emissiveIntensity:1.5});
  const box=(x,y,z,w,h,d,m,solid=false)=>{const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;this.root.add(mesh);if(solid)engine.world.addStatic(new THREE.Box3(new THREE.Vector3(x-w/2,y-h/2,z-d/2),new THREE.Vector3(x+w/2,y+h/2,z+d/2)),{tag:'station'});return mesh;};
  const sign=(text,x,y,z,w,h,nx=-1,nz=0,sub='')=>{const mesh=L.signMesh({text,sub,w,h,bg:'#eff0e7',fg:'#18374e',emissive:.3});L.placeFacing(mesh,x,y,z,nx,nz);this.root.add(mesh);};
  const y=groundY(-648,250)+.55;this.floor=y;
  // The west entrance meets the hillside at concourse (2F) level; tracks are below.
  for(let x=-648;x< -620;x++){
   const yy=x< -642?groundY(x,250)+.15+(y-groundY(x,250)-.15)*(x+648)/6:y;
   box(x+.5,yy-.1,250,1,.2,8,white);
   box(x+.5,yy+.015,250,1,.025,.55,yellow);
  }
  this.oldGround=engine.world.groundBase;
  engine.world.groundBase=(x,z)=>{
   // floor reaches the south wall (z 255.3): the strip in front of the stair opening was terrain, 1.2 m under the slab
   if(x>=-648&&x<=-620&&z>=(x>=-627.6?244.7:246)&&z<=255.3){const t=Math.max(0,Math.min(1,(x+648)/6)),g=this.oldGround(x,z);return g+(y-g)*t-(engine.world.groundSlab?.(x,z)||0);}
   return this.oldGround(x,z);
  };
  box(-634,y+3.5,250,25,.3,10,tile);
  box(-637,y+1.65,244.7,19,3.3,.35,tile,true);box(-620.8,y+1.65,244.7,.8,3.3,.35,tile,true);
  // South entrance opening aligns with the mapped station stairs.
  box(-640,y+1.65,255.3,12,3.3,.35,tile,true);box(-622,y+1.65,255.3,4,3.3,.35,tile,true);
  box(-646,y+1.6,245.8,.35,3.2,.35,tile,true);box(-646,y+1.6,254.2,.35,3.2,.35,tile,true);
  sign('神泉駅',-646.3,y+2.85,250,5,.7,-1,0,'Shinsen Station · IN02');
  sign('井の頭線　改札口',-637,y+2.6,250,4,.55,-1,0,'渋谷方面');
  sign('神泉駅',-629,y+2.8,255.6,4,.65,0,1,'Shinsen Station');
  for(let x=-644;x< -620;x+=4)box(x,y+3.3,250,1.8,.06,.25,light);
  // Original ticket machines and stainless gates, blue panels and IC readers.
  for(let z=247;z<=253;z+=2){box(-634,y+.48,z,2,.96,.45,silver,true);box(-634,y+.99,z,2,.08,.5,blue);box(-634.7,y+1.05,z,.28,.04,.26,dark);box(-634.95,y+.72,z,.05,.13,.24,light);}
  for(let x=-642;x< -638;x+=1.1){box(x,y+.8,245.3,.9,1.6,.65,silver,true);box(x,y+1.1,245.67,.65,.4,.025,blue);}
  sign('きっぷ Tickets',-640.5,y+2.2,245.8,3,.4,0,1);
  for(const x of [-643,-635,-626]){const lamp=new THREE.PointLight(0xfff1dc,35,13,2);lamp.position.set(x,y+2.7,250);this.root.add(lamp);}
  box(-620,y+1.65,250,.3,3.3,10,tile,true);
  sign('1 渋谷方面　　2 吉祥寺方面',-621,y+2.3,250,7,.6,-1,0);
  sign('駅事務室',-641,y+2.1,255.05,2,.35,0,-1);
  // South approach has a short stair flight. Treads match the contact surface.
  const foot=groundY(-630,264)+.15;
  for(let z=256;z<=263;z+=.5){const t=(z-256)/7,yy=y*(1-t)+foot*t;box(-630,yy-.12,z,3,.24,.52,tile);}
  // contact surface = the tread tops (same t as above); it was 15 cm under the landing and fell behind the treads
  const prev=engine.world.groundBase;engine.world.groundBase=(x,z)=>x>=-631.5&&x<=-628.5&&z>=255.3&&z<=263.25?y+(foot-y)*Math.min(1,Math.max(0,(z-256)/7))-(engine.world.groundSlab?.(x,z)||0):prev(x,z);
  // the stair's cheeks: it spans the rail cutting (z 256–258), so stepping off its side dropped you into the track bed
  for(const x of [-631.7,-628.3]){
   for(let z=255.5;z<260.5;z+=.5){const top=y+(foot-y)*Math.min(1,Math.max(0,(z+.25-256)/7))+1,bot=CROSSING.y-.3;box(x,(top+bot)/2,z+.25,.2,top-bot,.5,tile);}
   engine.world.addStatic(new THREE.Box3(new THREE.Vector3(x-.1,CROSSING.y-2,255.3),new THREE.Vector3(x+.1,y+3,260.5)),{tag:'station'});
  }
  for(const [a,b] of [[-634,-631.7],[-628.3,-624]])engine.world.addStatic(new THREE.Box3(new THREE.Vector3(a,foot-4,255.2),new THREE.Vector3(b,y+3,256.2)),{tag:'station'});
  buildShinsenSurroundings(engine,this.root,box,sign,{tile,silver,dark,yellow,white,light},y);
  // 渋谷 side: no gate of our own — the ride button sits at the foot of the 西口 stair / escalator up to the 井の頭線
  // 中央口 on the Mark City 2F deck (westDeck.js builds them; SHIBUYA_RAIL.gate is their foot).
  // Home entrance stair (edelweiss.js): 8 treads of 0.2 m up to the 1.6 m landing. The ground follows the treads, so
  // walking up to the door climbs them instead of sinking into them.
  {const [ox,oz]=HOME.door,hy=groundY(...HOME.approach),prevH=engine.world.groundBase;
   engine.world.groundBase=(x,z)=>{const dx=x-ox,dz=z-oz,u=dx*.887-dz*.462,d=dx*.462+dz*.887;
    if(u>=.85&&u<=2.75&&d>=-1.2&&d<=1.84){const k=Math.min(7,Math.max(0,Math.floor((1.84-d)/.27)));return hy+(k+1)*.2-(engine.world.groundSlab?.(x,z)||0);}
    return prevH(x,z);};}
  // Merge static meshes by material; lights and collision volumes remain independent.
  const groups=new Map();for(const mesh of [...this.root.children])if(mesh.isMesh){mesh.updateMatrix();const list=groups.get(mesh.material)||[];list.push(mesh.geometry.clone().applyMatrix4(mesh.matrix));groups.set(mesh.material,list);this.root.remove(mesh);mesh.geometry.dispose();}
  for(const [mat,geos] of groups){const merged=mergeGeometries(geos,false);for(const geo of geos)geo.dispose();const mesh=new THREE.Mesh(merged,mat);mesh.castShadow=true;mesh.receiveShadow=true;this.root.add(mesh);}
  const style=document.createElement('style');style.textContent='body[data-home301] .minimap,body[data-home301] .objective{display:none}#rail-action{position:fixed;left:50%;bottom:18%;transform:translateX(-50%);z-index:45;padding:14px 24px;border:1px solid #d7bc75;background:#101b24ed;color:#f3e3ad;font:600 17px sans-serif;border-radius:5px;cursor:pointer}#rail-status{position:fixed;inset:0;z-index:90;background:#08121cef;color:#eee;display:grid;place-content:center;text-align:center;font:24px sans-serif;pointer-events:none}#rail-action[hidden],#rail-status[hidden]{display:none}';document.head.append(style);
  this.button=document.createElement('button');this.button.id='rail-action';this.button.hidden=true;this.button.addEventListener('click',()=>this.use());document.body.append(this.button);
  this.overlay=document.createElement('div');this.overlay.id='rail-status';this.overlay.hidden=true;this.overlay.setAttribute('role','status');document.body.append(this.overlay);
  this.home={...HOME,owner:'渋沢 健人'};this.apartment=createApartment(engine);this.insideHome=false;const hud=engine.get('hud');if(hud?.areaName){const area=hud.areaName.bind(hud);hud.areaName=(x,z)=>this.insideHome?'自宅 301号室':area(x,z);}
 },
 nearby(){const p=this.engine.player?.position;if(!p)return null;if(this.insideHome)return Math.hypot(p.x-this.apartment.exit[0],p.z-this.apartment.exit[1])<2.5?'homeExit':null;for(const [id,point,r] of [['shinsen',SHINSEN.gate,4],['shibuya',SHIBUYA_RAIL.gate,3.2],['home',HOME.approach,3.5]])if(Math.hypot(p.x-point[0],p.z-point[1])<r)return id;return null;},
 use(){const e=this.engine,id=this.nearby();if(this.pending||!id||!canUseRail(e.state,e.player))return false;
  if(id==='home'||id==='homeExit'){const enter=id==='home',[x,z]=enter?this.apartment.entry:HOME.approach;this.insideHome=enter;document.body.toggleAttribute('data-home301',enter);this.apartment.root.visible=enter;const p=e.player;p.position.set(x,e.world.groundHeight(x,z),z);p.velocity.set(0,0,0);p.yaw=enter?Math.PI/2:0;p.group.rotation.y=p.yaw;e.get('camera')?.resetRig?.();return true;}
  this.pending=true;this.button.hidden=true;this.overlay.hidden=false;this.overlay.textContent=id==='shinsen'?'井の頭線　神泉 → 渋谷':'井の頭線　渋谷 → 神泉';
  e.state.frozen=true;const destination=id==='shinsen'?SHIBUYA_RAIL:SHINSEN;
  this.timer=setTimeout(()=>{const p=e.player,[x,z]=destination.arrival;p.position.set(x,e.world.groundHeight(x,z),z);p.velocity.set(0,0,0);p.yaw=id==='shinsen'?0:-Math.PI/2;p.group.rotation.y=p.yaw;p.setState('idle');p.humanoid.play('idle',{fade:.15});e.get('camera')?.resetRig?.();e.events.emit('rail:arrive',{station:destination.name});this.overlay.hidden=true;this.pending=false;e.state.frozen=false;},1000);return true;
 },
 update(){if(!this.button)return;const e=this.engine,id=this.nearby();this.button.hidden=this.pending||!id||!canUseRail(e.state,e.player);if(this.button.hidden)return;this.button.textContent=id==='homeExit'?'E ／ 自宅を出る':id==='home'?'E ／ 自宅に入る　301号室':id==='shinsen'?'E ／ 井の頭線で渋谷駅へ':'E ／ 井の頭線で神泉駅へ';if(e.input.buttons.interact.pressed){e.input.buttons.interact.pressed=false;this.use();}}
};
