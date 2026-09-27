// Gameplay network: approximately 100 m along streets, independent of real-world rental locations.
import { CITY } from './cityData.js';
export const LOOP_BRAND = {
  name: 'LOOP', kana: 'ループ',
  teal: '#22b8a4',         // the mint-teal of the real livery, a hair greener
  tealDeep: '#0f7f71',
  ink: '#0b1413',
};

export const LOOP_FARE = { base: 50, perMin: 15, towFee: 1000 };   // ¥50 + ¥15 per started minute; 回送手数料 (game rule)
// km/h. Game speeds, not the real limits (特定小型原付: 20 on the carriageway, 6 in 歩道モード): at those the board was slower
// than 健人 walking (2.4 m/s) on a pavement and no faster than his run (5.6 m/s) on the road — the client: 「遅すぎる」.
// Then 「車道と歩道でスピードに差つけなくて良い。時速50キロにして」: one cap everywhere, 50 km/h (~2.5× his run).
// (Both keys stay so a split can come back by changing one number.)
export const LOOP_SPEED = { road: 50, pavement: 50 };

export const LOOP_SOURCE = 'gameplay evenly spaced network, 2026-09-27';
export const LOOP_SPACING = 100;
export function pointOnRoute(path, distance) {
  for (let i=1;i<path.length;i++) {
    const [x,z]=path[i-1],dx=path[i][0]-x,dz=path[i][1]-z,len=Math.hypot(dx,dz);
    if (!len) continue;
    if(distance<=len || i===path.length-1) {const t=Math.max(0,Math.min(1,distance/len)); return {x:x+dx*t,z:z+dz*t,tx:dx/len,tz:dz/len};}
    distance-=len;
  }
}
export function portCandidate(route, s, side=1) {
  const q=pointOnRoute(route.path,s),off=route.width/2+(route.sidewalk ? route.sidewalk/2 : -1.2);
  const nx=-q.tz*side,nz=q.tx*side;
  return {x:q.x+nx*off,z:q.z+nz*off,rotY:Math.atan2(-nx,-nz)};
}
const ids=['dogenzaka_shita','dogenzaka','dogenzaka_ue','koen','bunkamura','miyamasu','meiji_ne','inokashira','tamagawa','nishiguchi','ekimae_sb'];
const routes=ids.map(id=>CITY.roads.find(r=>r.id===id)).filter(Boolean);
routes.push(CITY.pedestrianStreets.find(r=>r.id==='centergai'));
export function buildPorts() {
 const ports=[];
 for(const route of routes){
  const len=route.path.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-route.path[i][0],p[1]-route.path[i][1]),0);
  const count=Math.max(1,Math.round(len/LOOP_SPACING)),step=len/count;
  for(let i=0;i<count;i++){
   const s=(i+.5)*step,c=portCandidate(route,s);
   // A shared station at a junction serves both streets; avoid clusters.
   if(ports.some(p=>Math.hypot(p.x-c.x,p.z-c.z)<48))continue;
   ports.push({id:route.id+'_'+(i+1),name:(route.id==='dogenzaka_ue'?'道玄坂上':route.name)+' '+(i+1)+'ポート',...c,slots:3,docked:2,source:LOOP_SOURCE,route,s,spacing:step});
  }
 }
 return ports;
}
export const LOOP_PORTS=buildPorts();
export default LOOP_PORTS;
