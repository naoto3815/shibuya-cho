// Full-scope infill: real survey/map footprints and source heights. Facade details
// are procedural; these are not photogrammetry or verified individual storefronts.
import * as L from './lib.js';
import {buildEdelweiss} from './edelweiss.js';
import {buildBuilding} from './genericBuilding.js';
import {WEST_INFILL} from '../westInfill.js';
import {UDAGAWA_INFILL,northLot} from '../udagawaInfill.js';
import {DENSITY_BUILDINGS} from '../densityData.js';
import {SCOPE_BUILDINGS} from '../scopeData.js';
import {buildMusicVenue} from './musicVenues.js';
import {buildMaruyamaVenue} from './maruyamaVenues.js';
import {KOJI_BUILDINGS} from '../kojiData.js';
import {buildKojiBuilding} from './koji.js';
import {STOREFRONT_ADDITIONS} from '../storefrontData.js';

export function buildScope(ctx){
 const {batch,inst,world,yAt,rng,CITY}=ctx,plan=[],facades=[];
 const buildings=[...SCOPE_BUILDINGS,...DENSITY_BUILDINGS,...UDAGAWA_INFILL,...WEST_INFILL,...[...STOREFRONT_ADDITIONS,...KOJI_BUILDINGS].filter(b=>!SCOPE_BUILDINGS.some(s=>s.osm===b.osm))];
 for(let i=0;i<buildings.length;i++){
  const b=northLot(buildings[i]),poly=L.ensureCW(b.poly),c=L.polyCentroid(poly);
  const samples=poly.flatMap((a,i)=>{const q=poly[(i+1)%poly.length];return [a,[(a[0]+q[0])/2,(a[1]+q[1])/2]];});
  const lo=Math.min(...samples.map(p=>yAt(...p))),hi=Math.max(...samples.map(p=>yAt(...p)));
  const residential=['apartments','house','residential','detached'].includes(b.use)||c[0]<-590;
  const hotel=b.use==='hotel'||/ホテル|hotel/i.test(b.name||'');
  const style=hotel?'hotel':residential?'residential':b.h>38?'office':'tenant';
  const floors=Math.max(1,b.levels||Math.round(b.h/3.3));
  const rise=Math.min(3.2,hi-lo),gf=Math.min(4,b.h)-rise;
  const faces=poly.map((a,j)=>{
   const q=poly[(j+1)%poly.length],[nx,nz]=L.edgeNormal(poly,j),x=(a[0]+q[0])/2,z=(a[1]+q[1])/2;
   const street=ctx.field.sample(x+nx*2,z+nz*2)<(b.id.startsWith('west_')?14:7);
   return {kind:street?'street':'alley',tenants:[]};
  });
  const out0=ctx.billboards.length;
  batch.lift=inst.lift=lo;
  const r=buildEdelweiss(b,ctx,lo)||buildKojiBuilding(b,ctx,lo)||buildMusicVenue(b,ctx,lo)||buildMaruyamaVenue(b,ctx,lo)||buildBuilding({id:b.id,poly,storeys:floors,style,faces,gf,sh:floors>1?(b.h-Math.min(4,b.h))/(floors-1):3.3,setback:false,noStairs:true,noRoofClutter:true,groundFloor:residential?'wall':'glass',colliders:'edges',groundRel:(x,z)=>Math.max(0,yAt(x,z)-lo),roofGlow:false}, {...ctx,rng:rng.fork(70000+i),billboards:ctx.billboards});
  batch.lift=inst.lift=0;
  for(const col of r.colliders){if(col.obb)col.obb.center.y+=lo;else if(col.min&&col.max){col.min.y+=lo;col.max.y+=lo;}world.addStatic(col,{tag:'building'});}
  for(const f of r.facades){f.position.y+=lo;f.kind='landmark';facades.push(f);}
  for(let k=out0;k<ctx.billboards.length;k++)ctx.billboards[k].position.y+=lo;
  plan.push({id:b.id,poly,h:r.height,base:lo,storeys:floors,style,source:b.heightSource,name:b.name});
 }
 return {plan,facades,stats:{buildings:plan.length}};
}
