// Road-level profile from cached GSI DEM5A (2026-09-27), datum 15.4 m.
// Correct the compatibility terrain's local dips without exaggerating the hill.
export const SHOTO_PROFILE = [
 [-456.1,-61.9,5.1146414],[-503.6,-37.9,6.04],[-540,-9.2,6.88],
 [-572.3,17.9,7.33],[-599.7,35.1,7.81],[-623.6,48.7,8.94],
 [-714.7,98.8,13.49],[-757.6,123.2,15.8508336]
];
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
const segments=[];
for(let i=1;i<SHOTO_PROFILE.length;i++){
 const a=SHOTO_PROFILE[i-1],b=SHOTO_PROFILE[i],dx=b[0]-a[0],dz=b[1]-a[1],len=Math.hypot(dx,dz);
 segments.push({a,b,dx,dz,len});
}
export function shotoGround(x,z,base){
 if(x> -350||x< -860||z< -170||z>230)return base;
 let best=Infinity,height=base;
 for(const s of segments){
  const t=Math.max(0,Math.min(1,((x-s.a[0])*s.dx+(z-s.a[1])*s.dz)/(s.len*s.len)));
  const d=Math.hypot(x-s.a[0]-s.dx*t,z-s.a[1]-s.dz*t);
  if(d<best){best=d;height=s.a[2]+(s.b[2]-s.a[2])*t;}
 }
 // Keep the carriageway, sidewalks and immediate shopfront ground together.
 // End heights match the existing junctions; fade laterally into adjacent blocks.
 // Endpoint values differ slightly from DEM to keep both connecting roads continuous.
 const w=(1-smooth((best-12)/80));
 return base+(height-base)*w;
}
