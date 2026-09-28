import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
// Layout traced from the user-supplied plan. Dimensions estimated from tatami labels;
// finishes and fittings are neutral placeholders until interior photos are supplied.
const scaleZ=z=>z<=11.1?z*.92:11.1*.92+(z-11.1)*.66;
export const apartmentPoint=(x,z)=>[2000+x*1.07,scaleZ(z)];
export const APARTMENT={origin:[2000,0],entry:apartmentPoint(1.2,13.2),exit:apartmentPoint(.7,13.2),rooms:[
 {name:'洋室 約10帖',x:0,z:0,w:4.8,d:3.5},
 {name:'洋室 約8帖',x:0,z:3.7,w:3.65,d:3.55},
 {name:'洋室 約8帖',x:0,z:7.45,w:3.65,d:3.55},
 {name:'LDK 約21.6帖',x:0,z:14.3,w:5.8,d:6.0}
]};
export function createApartment(engine){
 const root=new THREE.Group();root.name='edelweiss-301-interior';root.visible=false;engine.scene.add(root);
 const mat=(c,extra={})=>new THREE.MeshStandardMaterial({color:c,roughness:.78,...extra});
 const wall=mat(0xe3ded1),wood=mat(0xb58b60),trim=mat(0x6d5742),white=mat(0xe5e7e3),metal=mat(0x9aabaa,{metalness:.7,roughness:.3}),glass=mat(0xadc6cb,{transparent:true,opacity:.28,roughness:.18}),dark=mat(0x313b42),yellow=mat(0xffecd2,{emissive:0xffedc9,emissiveIntensity:.8});
 const box=(x,y,z,w,h,d,m,solid=false)=>{const z0=scaleZ(z-d/2),z1=scaleZ(z+d/2);x*=1.07;w*=1.07;z=(z0+z1)/2;d=z1-z0;const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);mesh.position.set(2000+x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh);if(solid)engine.world.addStatic(new THREE.Box3(new THREE.Vector3(2000+x-w/2,y-h/2,z-d/2),new THREE.Vector3(2000+x+w/2,y+h/2,z+d/2)),{tag:'apartment301'});return mesh;};
 box(3.4,-.12,10.2,6.8,.24,20.4,wood);box(3.4,2.75,10.2,7,.16,20.6,wall);
 // Actual plank seams, running along the long axis of the apartment.
 for(let x=.15;x<6.8;x+=.18)box(x,.002,10.2,.007,.005,20.4,trim);
 const h=2.7;
 const wallX=(x,z,d)=>box(x,h/2,z,.14,h,d,wall,true);
 const wallZ=(x,z,w)=>box(x,h/2,z,w,h,.14,wall,true);
 wallX(6.8,10.2,20.4);wallZ(3.4,0,6.8);
 // Left and south balconies are visible through sliding glass. Exterior boundaries stay solid.
 for(const [a,b] of [[0,.5],[2.9,4.3],[6.7,8],[10.4,12],[14.4,15.9],[18.3,20.4]])wallX(0,(a+b)/2,b-a);
 for(const z of [1.7,5.5,9.2,17.1]){box(0,.2,z,.14,.4,2.4,wall);box(0,2.5,z,.14,.4,2.4,wall);box(0,1.35,z,.05,2.2,2.4,glass,true);}
 wallZ(.6,20.4,1.2);wallZ(6.3,20.4,1);box(3.5,.2,20.4,4.4,.4,.14,wall);box(3.5,2.5,20.4,4.4,.4,.14,wall);box(3.5,1.35,20.4,4.4,2.2,.05,glass,true);
 // Glazed bays replace the appearance of the solid shell; collision keeps the closed doors safe.
 for(const z of [1.7,5.5,9.2,17.1]){box(-.09,1.4,z,.03,1.9,2.4,glass);box(-.13,1.4,z,.04,1.9,.06,metal);}
 // Partition doorways are deliberately open and >= 0.9 m wide.
 wallZ(1.8,3.6,3.6);wallZ(4.65,3.6,.3);
 wallZ(1.8,7.35,3.6);wallZ(1.8,11.1,3.6);
 for(const [z,d] of [[4.15,.9],[6.3,1.8],[8,.9],[10.35,1.4]])wallX(3.75,z,d);
 for(const [a,b] of [[0,1],[2.2,3.9],[4.95,5.8],[7,8.9],[10,11.5],[12.6,14.2]])wallX(4.95,(a+b)/2,b-a);
 wallX(5.85,15,1.6);wallX(5.85,17.45,1.3);wallX(5.85,19.85,1.1);wallZ(3.7,14.2,4.1);wallZ(.3,14.2,.6);
 // Right-side service rooms, with access gaps from the central hall.
 for(const z of [3.6,5.35,8.4,10.8,14.2,17.1])wallZ(5.9,z,1.8);
 // Replace selected service-wall sections with open door-sized gaps.
 // These fixtures can be viewed through their doors; their sizes are approximations.
 // Baths, two toilets, wash basin and washing-machine space follow the diagram's side.
 box(6.15,.28,6.8,1.1,.56,2.1,white,true);box(6.15,.55,6.8,.9,.05,1.8,glass);
 for(const z of [4.5,18.5]){box(6.1,.22,z,.48,.44,.65,white,true);box(6.1,.65,z-.4,.52,.68,.22,white,true);}
 box(6,.4,9.2,1,.8,.6,white,true);box(6,1.4,9.55,.9,.75,.05,glass);box(6,.5,12,.65,1,.65,white,true);
 // Separate kitchen north of the large LDK, as supplied in the plan.
 box(2.2,.44,11.65,3,.88,.6,white,true);box(2.2,.92,11.65,3.1,.06,.65,metal);box(1.1,.96,11.65,.6,.03,.45,dark);
 box(3.45,.95,13.15,.7,1.9,.7,white,true);
 // Closets behind the two 8-tatami rooms.
 for(const z of [7.05,10.8])box(1.7,1.2,z,3.1,2.4,.22,wood,true);
 // Recessed genkan and entrance leaf at the plan's left-side entry.
 box(.75,.005,13.2,1.5,.01,1.65,dark);box(-.015,1.2,13.2,.1,2.4,1.2,wood,true);
 // Balcony slabs/rails outside the west and south walls (no invented furniture).
 box(-.7,-.15,10.2,1.25,.2,20.4,white);box(2.8,-.15,21.1,6.8,.2,1.3,white);
 box(-1.25,.55,10.2,.12,1.2,20.4,wall);box(2.8,.55,21.7,6.8,1.2,.12,wall);
 for(const [x,z] of [[2.4,1.7],[1.8,5.5],[1.8,9.2],[3,17.2],[4.3,12.7]]){box(x,2.62,z,.65,.07,.65,yellow);const lamp=new THREE.PointLight(0xffedda,25,8,2);lamp.position.set(2000+x*1.07,2.4,scaleZ(z));root.add(lamp);}
 // Batch static surfaces to keep this extra room inexpensive.
 const groups=new Map();for(const mesh of [...root.children])if(mesh.isMesh){mesh.updateMatrix();const gs=groups.get(mesh.material)||[];gs.push(mesh.geometry.clone().applyMatrix4(mesh.matrix));groups.set(mesh.material,gs);root.remove(mesh);mesh.geometry.dispose();}
 for(const [material,gs] of groups){const geometry=mergeGeometries(gs);gs.forEach(g=>g.dispose());const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh);}
 const old=engine.world.groundBase;engine.world.groundBase=(x,z)=>x>1998&&x<2008&&z>-1&&z<23?-(engine.world.groundSlab?.(x,z)||0):old(x,z);
 return {root,...APARTMENT};
}
