import * as THREE from 'three';
// [hero face] 渋沢健人's head. Four switches (?heroFace=):
//   v4 (default)  the delivered Meshy GLB's own head (docs/ref/hero-model-v2.glb), re-decimated at ~32 k triangles for
//                 lod0 and stitched watertight onto lod0's body, then fitted to the approved image's landmarks (one
//                 RBF field on every rung) with the approved close-up baked onto it (a 1024² face texture over the
//                 re-baked atlas), grey in the hair, loose locks and flyaways (assets/hero/v2/face4/build_all.py,
//                 docs/reports/hero-face-v4.md). No runtime sculpt, no runtime projection.
//   wip | prev    the 2026-09-27 work in progress kept for A/B: the runtime sculpt below (fitHeroFace) on the shipped
//                 36 k lod0, plus the concept photo projected in the shader (applyHeroFaceMaterial).
//   scan          the shipped lod0 exactly as built (no sculpt, no projection), for A/B against v4's denser head.
//   glb           stage 1 only: the delivered GLB's head at 32 k triangles on the shipped maps, not yet fitted to the
//                 approved image (face4/glb/)
const Q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('heroFace') : null;
export const HERO_FACE_MODE = Q === 'wip' || Q === 'prev' ? 'wip' : Q === 'scan' ? 'scan' : Q === 'glb' ? 'glb' : 'v4';
// geometry source for the hero_v2 scan (loadScanAsset reads json + bin from here) and, for v4, the four maps it re-bakes
export const HERO_FACE_SRC = HERO_FACE_MODE === 'v4' ? 'assets/hero/v2/face4/' : HERO_FACE_MODE === 'glb' ? 'assets/hero/v2/face4/glb/' : null;
export const heroFaceMapBase = (suffix, base) => (HERO_FACE_MODE === 'v4' ? HERO_FACE_SRC : base);
// lod0's face-texture coordinates (u, v, weight) from the v4 build; the far rungs have none (weight 0: the atlas)
// (?heroFaceTex=0: v4 on the atlas alone, for A/B)
const FACE_TEX = typeof location === 'undefined' || new URLSearchParams(location.search).get('heroFaceTex') !== '0';
export function heroFaceAttr(geo, SC, part) {
  const d = HERO_FACE_MODE === 'v4' && FACE_TEX && SC.data.parts[part] && SC.data.parts[part].faceUv;
  if (!d || geo.getAttribute('position').count * 3 !== d.n) return;
  geo.setAttribute('heroFaceUv', new THREE.BufferAttribute(new Float32Array(SC.bin, d.o, d.n), 3));
}
// v4 lod0 ends with alpha-tested hair cards (face4/cards.py): material group 1 (humanoid.js hairCardMat). ?heroCards=0 off.
const CARDS = typeof location === 'undefined' || new URLSearchParams(location.search).get('heroCards') !== '0';
export function heroCardGroups(geo, SC, part) {
  const c = HERO_FACE_MODE === 'v4' && SC.data.parts[part] && SC.data.parts[part].cards;
  if (!c) return false;
  const n = geo.index.count, k = c[1] * 3;
  geo.clearGroups();
  if (!CARDS) { geo.setIndex(new THREE.BufferAttribute(geo.index.array.slice(0, n - k), 1)); return false; }
  geo.addGroup(0, n - k, 0); geo.addGroup(n - k, k, 1);
  return true;
}
// v4: the approved close-up, re-projected offline onto the fitted head (face4/bake2.py) at ~40 px/cm in its own
// seam-free coordinates, laid over the atlas by the per-vertex weight. One texture fetch, no projection at runtime.
const HERO_FILL = typeof location !== 'undefined' && /[?&]heroFill=([\d.]+)/.test(location.search) ? parseFloat(RegExp.$1) : 1.6;
const HAIR_FLAT_V4 = typeof location !== 'undefined' && /[?&]heroHairFlat=([\d.]+)/.test(location.search) ? parseFloat(RegExp.$1) : 0.35;
export function applyHeroFaceV4(material, texture) {
  texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false; texture.anisotropy = 8;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping; texture.needsUpdate = true;
  const prev = material.onBeforeCompile, cache = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uHeroFaceMap = { value: texture };
    shader.vertexShader = shader.vertexShader.replace('void main() {', 'attribute vec3 heroFaceUv;\nvarying vec3 vHeroFaceUv;\nvoid main() {\nvHeroFaceUv = heroFaceUv;');
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'uniform sampler2D uHeroFaceMap;\nvarying vec3 vHeroFaceUv;\nvoid main() {');
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      if ( vHeroFaceUv.z > 0.001 ) diffuseColor.rgb = mix( diffuseColor.rgb, texture2D( uHeroFaceMap, vHeroFaceUv.xy ).rgb, vHeroFaceUv.z );`);
    // the scalp keeps most of its own strand variation (and the grey the bake put in): charShader's hair flattening
    // (a shell's studio highlights -> one dark base) at a third, so the comb reads as hair, not a helmet
    shader.fragmentShader = shader.fragmentShader.replace('chHair * uHairFlat', 'chHair * uHairFlat * ' + HAIR_FLAT_V4.toFixed(2));
    // Night only (the hemisphere is ~0.15 at night, ~2.8 by day): a soft fill from the lens on his face — the
    // approved image is a lit portrait, and under the street's key alone the face went muddy and the moustache a
    // black block. Face material only: the scene's lights are untouched. The LAST lights_fragment_end is charShader's.
    shader.uniforms.uHeroFill = { value: HERO_FILL };
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'uniform float uHeroFill;\nvoid main() {');
    const at = shader.fragmentShader.lastIndexOf('#include <lights_fragment_end>');
    if (at >= 0) shader.fragmentShader = shader.fragmentShader.slice(0, at) + `{
        float hfNight = 1.0 - smoothstep( 0.3, 1.0, dot( uHemiSky, vec3( 0.2126, 0.7152, 0.0722 ) ) );
        float hfSkin = clamp( max( vHeroFaceUv.z, 0.5 * chSkin / max( uSkinHair.x, 1e-3 ) ), 0.0, 1.0 ) * ( 1.0 - 0.8 * chHair );
        float hfNdv = max( dot( geometryNormal, geometryViewDir ), 0.0 );
        reflectedLight.indirectDiffuse += BRDF_Lambert( material.diffuseColor ) * uHeroFill * hfNight * hfSkin * ( 0.35 + 0.65 * hfNdv );
      }
      ` + shader.fragmentShader.slice(at);
  };
  material.customProgramCacheKey = () => cache() + 'heroFaceV4bake' + HAIR_FLAT_V4 + '|' + HERO_FILL;
  material.needsUpdate = true;
}
const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
const bump=(x,c,r)=>Math.exp(-(((x-c)/r)**2));
// Owns the position buffer and keeps the bind face in `heroFaceCoord` (the WIP projection's coordinate). Only the
// WIP mode sculpts; v4's head is baked offline and 'scan' is the build as shipped.
export function fitHeroFace(geo) {
  const source=geo.getAttribute('position');
  geo.setAttribute('heroFaceCoord',source.clone());
  const p=source.clone();geo.setAttribute('position',p);
  if(HERO_FACE_MODE!=='wip')return;
  for(let i=0;i<p.count;i++){
    const x=source.getX(i),y=source.getY(i),z=source.getZ(i),ax=Math.abs(x);
    if(y<1.535||y>1.84)continue;
    const face=smooth(.015,.075,z),jaw=bump(y,1.58,.037),cheek=bump(y,1.642,.028);
    // Restore the adopted face's cheek volume and broad jaw; reduce the high pompadour.
    let nx=x*(1+.10*jaw*face+.035*cheek*face);
    let ny=y-.004*jaw*face,nz=z+.006*cheek*face*bump(ax,.050,.032);
    // The adopted nose is broader and less pointed than the old scan.
    const nose=bump(y,1.636,.022)*bump(ax,0,.022)*smooth(.105,.135,z);
    nx*=1+.13*nose;nz-=.012*nose;
    const eye=bump(ax,.034,.025)*bump(y,1.678,.016)*face;
    nx-=Math.sign(x)*.0035*eye;
    ny-=(y-1.674)*.06*eye;
    // Reduce the old scan's heavy brow overhang instead of baking its scowl into the new face.
    const brow=bump(y,1.697,.018)*bump(ax,.034,.030)*face;
    nz-=.009*brow;nz+=.003*eye;
    const hair=smooth(1.744,1.788,y);
    const temple=smooth(1.665,1.73,y)*smooth(.05,.085,ax);
    nx*=1-.07*hair-.075*temple;
    ny-=(.026+.005*Math.sin(x*25))*hair;
    nz-=.010*hair*smooth(.015,.075,z);
    p.setXYZ(i,nx,ny,nz);
  }
}
// After buildMobBody's computeVertexNormals (the body's proportion stretch needs it): the head takes back the normals
// it shipped with — the dense GLB's own, smooth across every uv seam — easing in over the 3 cm above the collar
// (heroBodyY is the identity above 1.52 m). The WIP mode keeps its own seam smoothing.
export function heroHeadNormals(geo, shipped){
  if(HERO_FACE_MODE==='wip'){smoothHeroFaceNormals(geo);return;}
  const p=geo.getAttribute('position'),n=geo.getAttribute('normal');
  for(let i=0;i<p.count;i++){
    const t=smooth(1.52,1.55,p.getY(i));if(t<=0)continue;
    let x=n.getX(i)*(1-t)+shipped.getX(i)*t,y=n.getY(i)*(1-t)+shipped.getY(i)*t,z=n.getZ(i)*(1-t)+shipped.getZ(i)*t;
    const l=Math.hypot(x,y,z)||1;n.setXYZ(i,x/l,y/l,z/l);
  }
  n.needsUpdate=true;
}
// Smooth across the scan's UV seams, which otherwise split the cheek highlights.
export function smoothHeroFaceNormals(geo){
  const p=geo.getAttribute('position'),n=geo.getAttribute('normal'),groups=new Map();
  for(let i=0;i<p.count;i++)if(p.getY(i)>1.535){
    const key=[p.getX(i),p.getY(i),p.getZ(i)].map(v=>Math.round(v*1e5)).join(',');
    let group=groups.get(key);if(!group){group={ids:[],sum:new THREE.Vector3()};groups.set(key,group);}
    group.ids.push(i);group.sum.add(new THREE.Vector3(n.getX(i),n.getY(i),n.getZ(i)));
  }
  for(const {ids,sum} of groups.values()){sum.normalize();for(const i of ids)n.setXYZ(i,sum.x,sum.y,sum.z);}
}
export const HERO_FACE_GLSL=`
varying vec3 vHeroFaceCoord;
uniform sampler2D uHeroFace;
// Source is the actual adopted concept, not a newly interpreted portrait.
// Measured image landmarks: chin, lips, nose, pupils, brows and hairline.
vec2 heroFaceUV(vec3 p){
 float y=p.y,iy,cx;
 if(y<1.560){float t=clamp((y-1.535)/.025,0.,1.);iy=mix(.716,.638,t);cx=mix(.734,.733,t);}
 else if(y<1.604){float t=(y-1.560)/.044;iy=mix(.638,.522,t);cx=mix(.733,.718,t);}
 else if(y<1.635){float t=(y-1.604)/.031;iy=mix(.522,.441,t);cx=mix(.718,.716,t);}
 else if(y<1.674){float t=(y-1.635)/.039;iy=mix(.441,.335,t);cx=mix(.716,.712,t);}
 else if(y<1.697){float t=(y-1.674)/.023;iy=mix(.335,.288,t);cx=mix(.712,.718,t);}
 else if(y<1.748){float t=(y-1.697)/.051;iy=mix(.288,.167,t);cx=mix(.718,.724,t);}
 else {float t=clamp((y-1.748)/.072,0.,1.);iy=mix(.167,.008,t);cx=mix(.724,.739,t);}
 return vec2(cx+p.x*1.78-(p.z-.10)*.45,1.-iy-p.x*.27);
}
`;
export function applyHeroFaceMaterial(material,texture){
  texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=true;
  texture.wrapS=texture.wrapT=THREE.ClampToEdgeWrapping;texture.anisotropy=8;
  const prev=material.onBeforeCompile,cache=material.customProgramCacheKey.bind(material);
  material.onBeforeCompile=(shader,renderer)=>{
    prev(shader,renderer);shader.uniforms.uHeroFace={value:texture};
    shader.vertexShader=shader.vertexShader.replace('void main() {','attribute vec3 heroFaceCoord;\nvarying vec3 vHeroFaceCoord;\nvoid main() {\nvHeroFaceCoord=heroFaceCoord;');
    shader.fragmentShader=shader.fragmentShader.replace('void main() {',HERO_FACE_GLSL+'\nvoid main() {');
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
      float hfX=abs(vHeroFaceCoord.x);
      float heroFaceMask=smoothstep(.035,.075,vHeroFaceCoord.z)
        *(1.-smoothstep(.074,.098,hfX))*smoothstep(1.537,1.558,vHeroFaceCoord.y)
        *(1.-smoothstep(1.823,1.84,vHeroFaceCoord.y));
      vec2 heroUV=heroFaceUV(vHeroFaceCoord);
      // Keep the source portrait's jacket/background off the jaw and ears.
      float photoY=1.-heroUV.y;
      float edgeLo=mix(.602,.675,smoothstep(.49,.64,photoY));
      float edgeHi=mix(.865,.790,smoothstep(.40,.64,photoY));
      heroFaceMask*=smoothstep(edgeLo,edgeLo+.018,heroUV.x)*(1.-smoothstep(edgeHi-.018,edgeHi,heroUV.x));
      // Lift photographic shadow slightly before real-time lighting, avoiding double-dark eye sockets.
      vec3 heroAlbedo=pow(max(texture2D(uHeroFace,heroUV).rgb,vec3(.0001)),vec3(.86));
      float hfHead=smoothstep(1.535,1.57,vHeroFaceCoord.y);
      float hfWarm=smoothstep(.1,.3,(diffuseColor.r-diffuseColor.b)/max(diffuseColor.r,.001));
      diffuseColor.rgb*=mix(vec3(1.),vec3(.90,.91,.92),hfHead*hfWarm);
      diffuseColor.rgb=mix(diffuseColor.rgb,heroAlbedo,heroFaceMask);
    `);
    // Region values must follow the new brows/beard rather than the old UV atlas.
    shader.fragmentShader=shader.fragmentShader.replace('vec3 chReg = texture2D( uRegion, vMapUv ).rgb;',`vec3 chReg = texture2D( uRegion, vMapUv ).rgb;
      float hfY=vHeroFaceCoord.y;
      float hfBrow=smoothstep(1.684,1.694,hfY)*(1.-smoothstep(1.705,1.718,hfY));
      float hfBeard=1.-smoothstep(1.620,1.635,hfY);
      float hfScalp=smoothstep(1.729,1.762,hfY);
      float hfDark=(1.-smoothstep(.018,.065,dot(heroAlbedo,vec3(.2126,.7152,.0722))))*max(hfScalp,max(hfBrow,hfBeard));
      chReg=mix(chReg,vec3(hfDark,1.-hfDark,hfDark*smoothstep(1.725,1.76,vHeroFaceCoord.y)),heroFaceMask);`);
    shader.fragmentShader=shader.fragmentShader.replace('// Round 3, critic #7:', `
        float hfFiber=chFibre*smoothstep(1.535,1.57,vHeroFaceCoord.y);
        vec3 hfBlack=vec3(dot(diffuseColor.rgb,CHAR_LW))*vec3(.97,.985,1.0)*.90;
        diffuseColor.rgb=mix(diffuseColor.rgb,hfBlack,hfFiber);
        // Round 3, critic #7:`);
    shader.fragmentShader=shader.fragmentShader.replace('vec3 c = outgoingLight;', 'vec3 c = mix(outgoingLight, diffuseColor.rgb, heroFaceMask * .18);');
    shader.fragmentShader=shader.fragmentShader.replace('chHair * uHairFlat','chHair * uHairFlat * .15');
    shader.fragmentShader=shader.fragmentShader.replace('vec3 hm = vec3( 0.030, 0.026, 0.024 )','vec3 hm = vec3( 0.012, 0.013, 0.014 )');
    shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;','mapN.xy *= normalScale * mix(1.0, 0.06, heroFaceMask);'));
  };
  material.customProgramCacheKey=()=>cache()+'heroFaceV4';material.needsUpdate=true;
}
