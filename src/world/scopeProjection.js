import {CENTRE,nearestOn} from './dogenzakaData.js';
// User's red outline, 2026-09-27. Pixel trace registered against the scramble,
// PARCO, Tower Records and Shinsen. This is an approximate boundary, not a survey.
// Roads/footprints use OSM/PLATEAU coordinates; the screenshot is only the extent.
export const REFERENCE_TRACE = [[824,77],[948,77],[958,174],[972,315],[979,512],[989,554],[1032,624],[1050,681],[998,711],[864,747],[743,818],[631,899],[529,918],[391,939],[249,924],[215,905],[190,868],[144,839],[119,805],[101,731],[49,683],[47,652],[145,586],[279,507],[377,455],[454,423],[426,390],[415,352],[432,286],[486,246],[523,210],[615,192],[721,192],[769,201],[804,194],[818,137]];
export const REAL_OUTLINE = REFERENCE_TRACE.map(([x,z]) => [(x-790)/0.98,(z-533)/0.96]);
export const ORIGIN = [35.65948,139.70054];
const rad=ORIGIN[0]*Math.PI/180;
export const MLAT=111132.954-559.822*Math.cos(2*rad)+1.175*Math.cos(4*rad);
export const MLON=111412.84*Math.cos(rad)-93.5*Math.cos(3*rad);
export const toLocal=(lat,lon)=>[(lon-ORIGIN[1])*MLON,-(lat-ORIGIN[0])*MLAT];
// Existing square is compressed. Blend back to true metres west of it so the
// already-built, true-scale Dogenzaka corridor remains fixed. No core content moves.
export function projectScope([x,z]) {
  const north=Math.max(0,Math.min(1,(35-z)/110));
  const west=Math.max(0,Math.min(1,(x+380)/185));
  const d=nearestOn(CENTRE,x,z).d;
  const t=Math.max(0,Math.min(1,(d-70)/80)), corridorBlend=t*t*(3-2*t);
  const k=north*west*corridorBlend;
  const xx=x < -195 ? x+(-195+0.35*(x+195)-x)*k : x>150 ? 150+0.4*(x-150) : x;
  const kz=x < -195 ? Math.max(0,Math.min(1,(x+380)/185))*corridorBlend : 1;
  const zz=z < -150 ? z+(-150+0.45*(z+150)-z)*kz : z>150 ? z+(150+0.45*(z-150)-z)*kz : z;
  return [Math.round(xx*10)/10,Math.round(zz*10)/10];
}
export const SCOPE_OUTLINE=REAL_OUTLINE.map(projectScope);
