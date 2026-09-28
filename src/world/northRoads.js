// Restore complete OSM ways across the former core boundary.
export const NORTH_PATHS={"202129899":[[-123.1,-226.6],[-175.8,-226],[-180.2,-225.9],[-185.9,-225.6],[-207.1,-237],[-209.8,-239.1],[-231,-252],[-234,-253.4],[-238,-255.1],[-241.7,-256.4],[-246.8,-257.9],[-252.8,-259.4],[-257.4,-260.3],[-261.1,-261]],"691240263":[[26.2,-218.8],[12.6,-220],[-16.7,-221.6],[-101.4,-226.1],[-114.1,-226.7]],"976275942":[[-114.1,-226.7],[-123.1,-226.6]],"976275950":[[-115.1,-232.4],[-114.1,-226.7]]};
export function northRoad(r){
 // Join the clipped Shoto Bunkamura way across the old core boundary.
 // The missing span includes the Maruyamazaka mouth; leaving it out raised
 // a pavement slab across the carriageway and stopped its lane markings.
 if(r.id==='scope_osm_31856144_0')return {...r,path:[...r.path,[-503.6,-37.9],[-486.6,-47.5],[-468.5,-56]]};
 if(r.id==='koen')return {...r,path:[...r.path,[-114.1,-226.7]]};
 if(r.osm===202129899)return r.id.endsWith('_0')?{...r,path:NORTH_PATHS[r.osm]}:null;
 if(NORTH_PATHS[r.osm])return {...r,path:NORTH_PATHS[r.osm]};
 if(r.osm===202129903)return {...r,path:[[-220,-205],...r.path]};
 return r;
}
export const PARCO_CROSSINGS=[
 {id:'cx_parco_south',a:[-99.6,-224.2],b:[-111.6,-212.2],width:3.5},
 {id:'cx_parco_east',a:[-102,-230.1],b:[-102,-222.1],width:3.5},
 {id:'cx_parco_west',a:[-124,-230.6],b:[-124,-222.6],width:3.5},
 {id:'cx_parco_north',a:[-119,-231.4],b:[-111,-233.4],width:3.5}
];
