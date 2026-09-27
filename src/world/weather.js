// [lighting] Weather: rain streaks, ground splashes, puddle decals, wet factor, fog, lightning.
//   engine.time.weather 'clear'|'rain'|'wet'   engine.time.wet 0..1  (set from ?t= by shots.applyParams)
//   weather.setWeather(name)    weather.rainIntensity 0..1    weather.wind (Vector2, m/s)    weather.holdFlash 0..1
//   scene.fog is owned here (FogExp2): colour = lighting.fogColor, density = lighting.fogDensity + rain/wet terms,
//   thinned with camera altitude so the aerial presets still see the city.
//   Rain: instanced streak quads (billboarded around the fall direction, stretched by speed) wrapped in a box that
//   follows the camera, drifting with the wind. Splashes: instanced ring sprites re-spawned every cycle on a ground
//   height grid (road 0 / sidewalk SW_H / Dogenzaka slope). Puddles: the standing water is the ground materials' own
//   after-rain drying state (materials.js WET_STATE_FN: dry / damp film / standing water, world space); while it
//   rains, instanced decals add an analytic expanding-ring ripple normal over that water (placed and clipped by the
//   same state; materials.setSoak films every surface). Lightning: rare double flash → lighting.flash,
//   events 'weather:lightning' / 'weather:thunder' for audio.
//   Wet-ground reflections: every frame the BLOOM layer (signs, screens, neon, lamp heads, headlights) is rendered
//   once more from a camera mirrored in the y = 0 plane into a half-res HDR target with mips; the library ground
//   materials (road, sidewalk, pavers, paint …) and the ripple decals sample it through a projective matrix, blurred
//   by roughness and weighted by the drying state × fresnel. That is the 龍が如く look where the street is still wet:
//   neon bleeding in a soft sheen on the damp film, sharp in the puddles, nothing on the dried patches.
import * as THREE from 'three';
import { isRoad, groundY } from './cityData.js';

const RAIN_COUNT = 9000, RAIN_BOX = new THREE.Vector3(46, 26, 46);
const SPLASH_COUNT = 1100, SPLASH_RADIUS = 17;
const PUDDLE_COUNT = 620;
const SW_H = 0.15;
const GRID = 256;                                            // ground height grid, 1 m cells over ±128 m
// ?mirror=0 turns the wet-road mirror pass off (the mobile profile), ?mirror=<0..1> sets its resolution (0.5 authored)
const MIRROR_Q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('mirror') : null;
const MIRROR_OFF = MIRROR_Q === '0';
const REFL_SCALE = Number(MIRROR_Q) > 0 && Number(MIRROR_Q) <= 1 ? Number(MIRROR_Q) : 0.5, REFL_LAYER = 1;
// Every light is ALSO on this layer, and the mirror camera sees it. Why: the mirror renders from scene.onBeforeRender,
// i.e. BEFORE three pushes the main pass's render state, so both passes share one WebGLLights. With the mirror seeing
// no lights (layer 1 holds none) the light-set hash flipped 44 -> 0 -> 44 lights twice a frame, lights.state.version
// bumped each time, and WebGLRenderer.setProgram re-resolved EVERY lit material in both passes: measured ~300
// program look-ups (getParameters + a ~100-field cache-key string + a full uniform refresh) per frame, the largest
// single block of CPU in the render. With the same light set in both passes the hash never changes and the programs
// stay put. (The reflected signs / people are now lit by the street like the originals; the shadow maps are left
// alone for this pass instead of switching the whole shadow system off, which also forked every program.)
const LIGHT_LAYER = 5;
const REFL_KEYS = new Set(['road', 'asphalt', 'sidewalk', 'paverGrey', 'paverRed', 'tactile', 'stone', 'curb', 'roadPaint', 'roadPaintYellow']);
const reflMaterials = new WeakSet();
const _cp = new THREE.Vector3(), _look = new THREE.Vector3(), _tgt = new THREE.Vector3(), _rot = new THREE.Matrix4(), _v2 = new THREE.Vector2(), _cc = new THREE.Color();

function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }

function makeHeightTexture() {
  const data = new Float32Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const x = i - GRID / 2 + 0.5, z = j - GRID / 2 + 0.5;
    data[j * GRID + i] = groundY(x, z) + (isRoad(x, z) ? 0 : SW_H);
  }
  const tex = new THREE.DataTexture(data, GRID, GRID, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
  return tex;
}
function ellipseAlpha(size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size - 0.5, v = (y + 0.5) / size - 0.5;
    const a = Math.atan2(v, u), r = Math.hypot(u, v) * 2;
    const edge = 0.78 + 0.16 * Math.sin(a * 3 + 0.7) + 0.08 * Math.sin(a * 7 + 2.1);   // lobed outline, not a disc
    const k = Math.max(0, Math.min(1, (edge - r) / 0.16));
    const i = (y * size + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(k * k * (3 - 2 * k) * 255);
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

const RAIN_VERT = /* glsl */`
attribute vec4 aSeed;
uniform float uTime; uniform vec3 uCenter; uniform vec3 uBox; uniform vec2 uWind; uniform float uLen;
varying vec2 vUv; varying float vA;
void main() {
  float speed = 8.5 + 4.0 * aSeed.w;
  float T = uBox.y / speed;
  float tau = mod(uTime + aSeed.z * T * 7.0, T);
  vec3 p = vec3(aSeed.x * uBox.x + uWind.x * tau, uBox.y - speed * tau, aSeed.y * uBox.z + uWind.y * tau);
  p.x = uCenter.x + mod(p.x - uCenter.x + uBox.x * 0.5, uBox.x) - uBox.x * 0.5;
  p.z = uCenter.z + mod(p.z - uCenter.z + uBox.z * 0.5, uBox.z) - uBox.z * 0.5;
  p.y += uCenter.y;
  vec3 vel = normalize(vec3(uWind.x, -speed, uWind.y));
  vec3 toCam = cameraPosition - p;
  float d = length(toCam);
  vec3 right = normalize(cross(vel, toCam / d));
  float w = max(0.02, d * 0.0017);
  float len = uLen * (0.75 + 0.5 * aSeed.w);
  vec3 wp = p + right * (position.x * w) + vel * (position.y * len);
  float r = length(p.xz - uCenter.xz);
  vA = smoothstep(0.6, 2.2, d) * (1.0 - smoothstep(12.0, 30.0, d)) * (1.0 - smoothstep(uBox.x * 0.4, uBox.x * 0.5, r));
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const RAIN_FRAG = /* glsl */`
uniform float uOpacity; uniform vec3 uColor;
varying vec2 vUv; varying float vA;
void main() {
  float core = 1.0 - abs(vUv.x - 0.5) * 2.0; core *= core;
  float ends = smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
  float a = core * ends * vA * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
}`;

const SPLASH_VERT = /* glsl */`
attribute vec4 aSeed;
uniform float uTime; uniform vec3 uCenter; uniform float uRadius; uniform sampler2D uHeight; uniform vec3 uGrid;
varying vec2 vUv; varying float vT; varying float vA;
float h1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float period = 0.5 + 0.4 * aSeed.w;
  float s = (uTime + aSeed.z * period * 9.0) / period;
  float cyc = floor(s), tau = fract(s);
  vec2 h = vec2(h1(aSeed.xy * 13.0 + cyc * 0.173), h1(aSeed.yx * 7.0 + cyc * 0.311));
  float ang = h.x * 6.2831853, rr = sqrt(h.y) * uRadius;
  vec2 c = uCenter.xz + vec2(cos(ang), sin(ang)) * rr;
  float gy = texture2D(uHeight, (c - uGrid.xy) / uGrid.z + 0.5).r;
  float ring = 0.05 + 0.3 * tau * (0.7 + 0.6 * aSeed.w);
  vec3 wp = vec3(c.x + position.x * ring * 2.0, gy + 0.012, c.y + position.z * ring * 2.0);
  vUv = uv; vT = tau;
  float d = distance(wp, cameraPosition);
  vA = (1.0 - smoothstep(12.0, uRadius, rr)) * smoothstep(0.8, 2.0, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const SPLASH_FRAG = /* glsl */`
uniform float uOpacity; uniform vec3 uColor;
varying vec2 vUv; varying float vT; varying float vA;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float ring = smoothstep(0.16, 0.0, abs(d - 0.86)) * pow(1.0 - vT, 1.6);
  float crown = smoothstep(0.32, 0.0, d) * max(0.0, 1.0 - vT * 3.0);
  float a = (ring * 0.9 + crown * 0.8) * vA * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
}`;

// analytic ripple gradient: expanding rings spawned per cell (rain) + a faint travelling wind wave (wet)
const PUDDLE_FRAG_FN = /* glsl */`
uniform float uPTime, uRippleK, uWaveK;
varying vec2 vPuddleW;
vec2 pHash22(vec2 p) { vec3 a = fract(p.xyx * vec3(123.34, 234.34, 345.65)); a += dot(a, a + 34.45); return fract(vec2(a.x * a.y, a.y * a.z)); }
vec2 rippleGrad(vec2 p, float t, float cell, float seed) {
  vec2 g = vec2(0.0);
  vec2 ci = floor(p / cell);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = ci + vec2(float(i), float(j));
    vec2 h2 = pHash22(c + seed);
    vec2 centre = (c + 0.15 + 0.7 * h2) * cell;
    float period = 0.8 + 0.7 * h2.x;
    float ph = fract(t / period + h2.y);
    vec2 dv = p - centre; float r = length(dv) + 1e-4;
    float R = ph * cell * 0.95;
    float env = exp(-pow((r - R) * 7.0, 2.0)) * (1.0 - ph);
    g += env * cos((r - R) * 34.0) * dv / r;
  }
  return g;
}`;
const PUDDLE_FRAG_BODY = /* glsl */`
{
  vec2 g = (rippleGrad(vPuddleW, uPTime, 0.55, 3.1) + rippleGrad(vPuddleW, uPTime * 0.9, 0.9, 7.7)) * 0.9 * uRippleK;
  g += vec2(0.55, 0.83) * cos(dot(vPuddleW, vec2(0.55, 0.83)) * 26.0 + uPTime * 2.4) * 0.12 * uWaveK;
  g += vec2(-0.7, 0.71) * cos(dot(vPuddleW, vec2(-0.7, 0.71)) * 41.0 - uPTime * 1.7) * 0.05 * uWaveK;
  vec3 nw = normalize(vec3(-g.x, 1.0, -g.y));
  normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
}`;

// planar reflection chunks chained behind whatever hook a material already has (materials library / puddle)
const REFL_VERT_DECL = /* glsl */`
uniform mat4 uReflMatrix; varying vec4 vReflP;`;
const REFL_VERT_BODY = /* glsl */`
{ vec4 rwp = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  rwp = instanceMatrix * rwp;
#endif
  vReflP = uReflMatrix * ( modelMatrix * rwp ); }`;
const REFL_FRAG_DECL = /* glsl */`
uniform sampler2D uReflMap; uniform float uReflK, uReflBlur; varying vec4 vReflP;`;
// wet: glsl expression 0..1 (library ground: its after-rain state's mirror weight matReflW; puddles: 1), distort:
// ripple offset in screen uv, lodBias: glsl expression, base blur (a damp film is never a mirror; standing water is)
const reflFragBody = (wet, distort, lodBias) => /* glsl */`
if ( uReflK > 0.001 && vReflP.w > 0.0 ) {
  vec2 ruv = vReflP.xy / vReflP.w;
  ruv += ( normal.xy - nonPerturbedNormal.xy ) * ${distort};
  vec2 rEdge = smoothstep( 0.0, 0.06, ruv ) * smoothstep( 1.0, 0.94, ruv );
  float rNdV = saturate( dot( geometryNormal, geometryViewDir ) );
  float rF = 0.06 + 0.94 * pow( 1.0 - rNdV, 4.0 );
  float rGloss = smoothstep( 0.66, 0.12, roughnessFactor );
  float rk = uReflK * ( ${wet} ) * rGloss * rF * rEdge.x * rEdge.y * ( 1.0 - metalnessFactor );
  // rough wet asphalt smears reflections into vertical streaks that lengthen toward grazing angles (the 龍が如く
  // "light columns" on the far road); puddles (roughness ~0.18) stay crisp
  float rLod = roughnessFactor * uReflBlur + ${lodBias};
  vec2 rSm = vec2( 0.0, roughnessFactor * ( 0.012 + 0.05 * ( 1.0 - rNdV ) ) );
  vec3 rc = textureLod( uReflMap, ruv, rLod ).rgb * 0.3
    + ( textureLod( uReflMap, ruv + rSm, rLod ).rgb + textureLod( uReflMap, ruv - rSm, rLod ).rgb ) * 0.22
    + ( textureLod( uReflMap, ruv + rSm * 2.2, rLod + 0.5 ).rgb + textureLod( uReflMap, ruv - rSm * 2.2, rLod + 0.5 ).rgb ) * 0.13;
  reflectedLight.indirectSpecular += rc * rk;
}`;

const weather = {
  name: 'weather',
  rainIntensity: 0,
  targetRain: 0,
  wind: new THREE.Vector2(1.2, 0.4),
  holdFlash: 0,
  flash: 0,
  strikeIn: 40,
  strikeT: -1,
  rain: null, splash: null, puddles: null,

  init(engine) {
    this.engine = engine;
    const scene = engine.scene;
    scene.fog = new THREE.FogExp2(0x171326, 0.003);
    this.fog = scene.fog;
    const rng = engine.rng.fork(77);
    this.heightTex = makeHeightTexture();

    // ---- rain streaks
    const seeds = new Float32Array(RAIN_COUNT * 4);
    for (let i = 0; i < RAIN_COUNT; i++) { seeds[i * 4] = rng(); seeds[i * 4 + 1] = rng(); seeds[i * 4 + 2] = rng(); seeds[i * 4 + 3] = rng(); }
    const rainGeo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
    rainGeo.instanceCount = RAIN_COUNT;
    rainGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.rainU = { uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uBox: { value: RAIN_BOX.clone() }, uWind: { value: new THREE.Vector2() }, uLen: { value: 0.42 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0.7, 0.76, 0.9) } };
    const rain = new THREE.Mesh(rainGeo, new THREE.ShaderMaterial({ uniforms: this.rainU, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    rain.frustumCulled = false; rain.name = 'rain'; rain.visible = false; rain.renderOrder = 5;
    scene.add(rain);
    this.rain = rain;

    // ---- splash rings
    const sSeeds = new Float32Array(SPLASH_COUNT * 4);
    for (let i = 0; i < SPLASH_COUNT; i++) { sSeeds[i * 4] = rng(); sSeeds[i * 4 + 1] = rng(); sSeeds[i * 4 + 2] = rng(); sSeeds[i * 4 + 3] = rng(); }
    const splashGeo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    splashGeo.instanceCount = SPLASH_COUNT;
    splashGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sSeeds, 4));
    this.splashU = { uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uRadius: { value: SPLASH_RADIUS }, uHeight: { value: this.heightTex }, uGrid: { value: new THREE.Vector3(0, 0, GRID) }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0.8, 0.84, 0.95) } };
    const splash = new THREE.Mesh(splashGeo, new THREE.ShaderMaterial({ uniforms: this.splashU, vertexShader: SPLASH_VERT, fragmentShader: SPLASH_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    splash.frustumCulled = false; splash.name = 'rainSplash'; splash.visible = false; splash.renderOrder = 4;
    scene.add(splash);
    this.splash = splash;

    // ---- rain-ripple decals over the standing water (placed once the city exists: first update). The water itself
    // is the ground material's own after-rain state (materials.js); these only add the rain's rings, so they are
    // drawn while it rains, placed where that state has standing water and clipped to it per pixel.
    this.puddleU = { uPTime: { value: 0 }, uRippleK: { value: 0 }, uWaveK: { value: 0.3 } };
    const pm = new THREE.MeshStandardMaterial({ color: 0x07080b, roughness: 0.035, metalness: 0.0, transparent: true, opacity: 0, alphaMap: ellipseAlpha(), envMapIntensity: 1.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    pm.name = 'weather:puddle';
    const ws = engine.get('materials') && engine.get('materials').wetStateShader;
    pm.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.puddleU);
      if (ws) Object.assign(sh.uniforms, ws.uniforms());
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPuddleW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n{ vec4 pw = vec4( transformed, 1.0 );\n#ifdef USE_INSTANCING\n pw = instanceMatrix * pw;\n#endif\n pw = modelMatrix * pw; vPuddleW = pw.xz; }');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + PUDDLE_FRAG_FN + (ws ? ws.decl + ws.fn : ''))
        .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>' + (ws ? '\ndiffuseColor.a *= smoothstep( 0.3, 0.8, matWetField( vPuddleW ).y );' : ''))
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + PUDDLE_FRAG_BODY);
    };
    pm.customProgramCacheKey = () => 'weather-puddle';
    this.puddleMat = pm;
    this.setupReflection(engine);
    this.attachReflection(pm, '1.0', 0.16, 0.0);
    this.setWeather(engine.time.weather || 'wet');
  },

  // ---- mirrored BLOOM-layer pass (see header). Runs from scene.onBeforeRender so the camera transform is final.
  setupReflection(engine) {
    const renderer = engine.renderer, scene = engine.scene;
    // sized from the governed RENDER ratio (engine.renderRatio), not the canvas: the mirror follows the frame it is
    // composited into when the governor moves it
    const reflSize = () => {
      if (MIRROR_OFF) return [4, 4];                    // never rendered (uReflK stays 0): keep the target tiny
      const s = renderer.getSize(_v2), pr = typeof engine.renderRatio === 'function' ? engine.renderRatio() : renderer.getPixelRatio();
      return [Math.max(4, Math.floor(s.x * pr * REFL_SCALE)), Math.max(4, Math.floor(s.y * pr * REFL_SCALE))];
    };
    const size = reflSize();
    const rt = new THREE.WebGLRenderTarget(size[0], size[1], { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, samples: 0 });
    rt.texture.name = 'weather:reflection';
    this.reflRT = rt;
    const cam = new THREE.PerspectiveCamera(); cam.name = 'reflectionCamera'; cam.layers.set(REFL_LAYER); cam.layers.enable(LIGHT_LAYER);
    this.reflCam = cam;
    this.reflU = { uReflMap: { value: rt.texture }, uReflMatrix: { value: new THREE.Matrix4() }, uReflK: { value: 0 }, uReflBlur: { value: 5 } };
    this.reflStats = { calls: 0, frames: 0 };
    engine.events.on('scene:added', () => { this._lightsDirty = true; });
    const onSize = () => { const s = reflSize(); rt.setSize(s[0], s[1]); };
    engine.events.on('resize', onSize);
    engine.events.on('render:scale', onSize);
    const prevOBR = scene.onBeforeRender;
    scene.onBeforeRender = (r, sc, c, ...rest) => {
      if (typeof prevOBR === 'function') prevOBR.call(sc, r, sc, c, ...rest);
      if (c !== engine.camera || this._reflErr) return;
      try { this.renderReflection(r, sc, c); }
      catch (e) { this._reflErr = true; this.reflU.uReflK.value = 0; console.error('[weather] reflection pass', e); }
    };
  },

  renderReflection(renderer, scene, cam) {
    const engine = this.engine, U = this.reflU;
    if (U.uReflK.value <= 0.001 || this._reflFrame === engine.stats.frame) return;
    // the engine's governor may ask for the mirror at 30 Hz (its first, cheapest knob). uReflMatrix is only written
    // below, together with the texture, so a skipped frame samples a one-frame-old reflection CONSISTENTLY (the
    // matrix it was rendered with) — a blurred wet-road reflection that lags 16 ms, never a misregistered one.
    // the programs this pass shares with the main pass sample the shadow maps: until the main pass has rendered them
    // once (frame 1) a caster's map does not exist and the sampler would be bound to a non-depth fallback
    // (GL_INVALID_OPERATION, the draw dropped). Wait for them.
    const SL = this.shadowLights;
    if (!SL) return;
    for (let i = 0; i < SL.length; i++) { const l = SL[i]; if (l.castShadow && l.visible && !(l.shadow && l.shadow.map)) return; }
    const every = engine.governor ? engine.governor.mirrorEvery : 1;
    if (every > 1 && this.reflStats.frames > 0 && (engine.stats.frame % every) !== 0) return;
    this._reflFrame = engine.stats.frame;
    // mirror camera in the y = 0 plane (Reflector.js construction: position, look target and up reflected)
    const rc = this.reflCam;
    _cp.setFromMatrixPosition(cam.matrixWorld);
    if (_cp.y < 0.05) return;
    _rot.extractRotation(cam.matrixWorld);
    _look.set(0, 0, -1).applyMatrix4(_rot).add(_cp);
    rc.position.set(_cp.x, -_cp.y, _cp.z);
    _tgt.set(_look.x, -_look.y, _look.z);
    rc.up.set(0, 1, 0).applyMatrix4(_rot); rc.up.y = -rc.up.y;
    rc.lookAt(_tgt);
    rc.near = cam.near; rc.far = cam.far;
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(cam.projectionMatrix);
    U.uReflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
    // the shadow pass filters casters by the camera's layers: it must not run inside this layer-1 pass. It is held
    // (autoUpdate / needsUpdate off: the maps from the last main pass are used as they are) rather than disabled —
    // shadowMap.enabled is a program parameter, and toggling it forked every lit material's program per pass.
    const sm = renderer.shadowMap;
    const prevRT = renderer.getRenderTarget(), prevSmAuto = sm.autoUpdate, prevSmNeeds = sm.needsUpdate, prevAuto = renderer.autoClear;
    const prevBg = scene.background, prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_cc);
    sm.autoUpdate = false; sm.needsUpdate = false; renderer.autoClear = false; scene.background = null;
    renderer.setRenderTarget(this.reflRT);
    renderer.setClearColor(0x000000, 1); renderer.clear(true, true, false);
    const calls0 = renderer.info.render.calls;
    renderer.render(scene, rc);
    this.reflStats.calls = renderer.info.render.calls - calls0; this.reflStats.frames++;
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(_cc, prevAlpha); renderer.autoClear = prevAuto; sm.autoUpdate = prevSmAuto; sm.needsUpdate = prevSmNeeds; scene.background = prevBg;
  },

  // library ground: the mirror follows the material's after-rain state (materials.js WET_STATE_FN) — none on a dried
  // patch, a blurred sheen on a damp film (base blur 0.5 mip + its roughness), crisp in standing water (0)
  attachReflection(m, wet = 'matReflW', distort = 0.05, lodBias = '0.5 * ( 1.0 - matUp * matWS.y )') {
    if (!m || reflMaterials.has(m) || !m.isMeshStandardMaterial) return;
    reflMaterials.add(m);
    const lod = typeof lodBias === 'number' ? lodBias.toFixed(2) : lodBias;
    const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey(), U = this.reflU, body = reflFragBody(wet, distort.toFixed(3), lod);
    m.onBeforeCompile = function (shader, renderer) {
      if (typeof prev === 'function') prev.call(this, shader, renderer);
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>' + REFL_VERT_DECL)
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>' + REFL_VERT_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>' + REFL_FRAG_DECL)
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>' + body);
    };
    m.customProgramCacheKey = () => prevKey + '|refl';
    m.needsUpdate = true;
    this.reflCount = (this.reflCount || 0) + 1;
  },

  // every light in the scene joins LIGHT_LAYER so the mirror pass sees exactly the main pass's light set (see the
  // header of LIGHT_LAYER). Cheap and idempotent; re-run on scene:added and every 600 frames for late lights.
  tagLights() {
    this._lightsDirty = false;
    let n = 0;
    const casters = this.shadowLights = [];
    this.engine.scene.traverse((o) => {
      if (!o.isLight) return;
      if (o.castShadow) casters.push(o);
      // only lights the main camera sees (a light kept on a private layer, e.g. an env-capture rig, must stay out)
      if (!o.layers.isEnabled(LIGHT_LAYER) && o.layers.test(this.engine.camera.layers)) { o.layers.enable(LIGHT_LAYER); n++; }
    });
    if (n) this.lightsTagged = (this.lightsTagged || 0) + n;
  },

  // library ground materials (any owner's mesh) get the reflection term; retried a few frames in (late binding)
  hookGroundMaterials() {
    this.engine.scene.traverse((o) => {
      const m = o.material; if (!m || Array.isArray(m)) return;
      if (m.userData && m.userData.matHook && REFL_KEYS.has(m.userData.key)) this.attachReflection(m);
    });
  },

  placePuddles() {
    const engine = this.engine, city = engine.get('city'), rng = engine.rng.fork(91);
    const field = city && city.field && typeof city.field.sample === 'function' ? city.field : null;
    const mats = engine.get('materials'), stateAt = mats && typeof mats.wetStateAt === 'function' ? mats.wetStateAt : null;
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(geo, this.puddleMat, PUDDLE_COUNT);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let n = 0, tries = 0;
    while (n < PUDDLE_COUNT && tries++ < 20000) {
      const r = 3 + Math.pow(rng(), 1.4) * 100, a = rng() * Math.PI * 2;   // dense near the scramble, thinning out
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const road = isRoad(x, z);
      const sdf = field ? field.sample(x, z) : (road ? -1 : 99);
      if (!road && !(sdf > 0.6 && sdf < 4.6)) continue;                    // road or sidewalk only
      if (road && Math.hypot(x, z) < 24 && rng() < 0.4) continue;           // keep the zebra readable
      if (stateAt && stateAt(x, z).pud < 0.5) continue;                     // only over standing water
      const w = 1.2 + rng() * 3.4, d = w * (0.35 + rng() * 0.5);
      q.setFromAxisAngle(up, rng() * Math.PI);
      p.set(x, groundY(x, z) + (road ? 0 : SW_H) + 0.012, z); s.set(w, 1, d);
      mesh.setMatrixAt(n++, m.compose(p, q, s));
    }
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true; mesh.castShadow = false; mesh.frustumCulled = false; mesh.name = 'puddles'; mesh.renderOrder = 1;
    engine.scene.add(mesh);
    this.puddles = mesh;
    console.info(`[weather] ${n} puddle decals, ${RAIN_COUNT} rain streaks, ${SPLASH_COUNT} splash rings`);
  },

  setWeather(name) {
    const t = this.engine.time;
    t.weather = name;
    if (name === 'rain') { this.targetRain = 1; t.wet = 1; }
    else if (name === 'wet') { this.targetRain = 0; t.wet = Math.max(t.wet, 0.85); }
    else { this.targetRain = 0; t.wet = Math.min(t.wet, 0.35); }
    if (this.engine.params && this.engine.params.shot) this.rainIntensity = this.targetRain;   // deterministic screenshots
    this.engine.events.emit('weather:changed', { weather: name, rain: this.targetRain, wet: t.wet });
  },

  update(dt, t) {
    const engine = this.engine, lighting = engine.get('lighting'), materials = engine.get('materials');
    const cam = engine.camera, time = engine.time;
    // while it rains every ground surface is filmed (no dried patches) and the low spots fill sooner
    if (materials && typeof materials.setSoak === 'function') materials.setSoak(Math.min(1, this.rainIntensity * 1.5));
    if (!this.puddles && engine.booted) { try { this.placePuddles(); } catch (e) { this.puddles = {}; console.error('[weather] puddles failed', e); } }
    this._frame = (this._frame || 0) + 1;
    if (engine.booted && (this._frame === 2 || this._frame === 40 || this._frame === 240)) this.hookGroundMaterials();
    if (engine.booted && (this._frame < 4 || this._frame === 40 || this._frame === 240 || this._frame % 600 === 0 || this._lightsDirty)) this.tagLights();
    const night = lighting ? lighting.nightFactor : 1;
    // rain ease + wet factor (rain soaks in ~20 s, dries over ~2 min once it clears)
    this.rainIntensity += (this.targetRain - this.rainIntensity) * Math.min(1, dt * 0.8);
    const rainK = this.rainIntensity;
    if (this.targetRain > 0 && time.wet < 1) time.wet = Math.min(1, time.wet + dt * 0.05);
    if (this.targetRain === 0 && time.weather === 'clear' && time.wet > 0) time.wet = Math.max(0, time.wet - dt * 0.008);
    const wet = time.wet || 0;
    if (materials && typeof materials.setWet === 'function') materials.setWet(wet);

    // wind: slow veer + gusts
    this.wind.set(1.1 + 1.4 * Math.sin(t * 0.11) + 0.5 * Math.sin(t * 0.9), 0.5 * Math.cos(t * 0.07) + 0.4 * Math.sin(t * 1.3));

    // lightning: rare double flash while it pours
    let flash = 0;
    if (rainK > 0.5 && !engine.state.frozen) {
      this.strikeIn -= dt;
      if (this.strikeIn <= 0) { this.strikeIn = 28 + Math.random() * 55; this.strikeT = 0; engine.events.emit('weather:lightning', { delay: 1.5 + Math.random() * 3 }); this.thunderIn = 1.5 + Math.random() * 3; }
    }
    if (this.strikeT >= 0) {
      const s = this.strikeT;
      flash = s < 0.05 ? 1 : s < 0.11 ? 0.3 : s < 0.19 ? 0.85 : Math.exp(-(s - 0.19) * 9) * 0.7;
      this.strikeT += dt;
      if (this.strikeT > 1.2) this.strikeT = -1;
      if (this.thunderIn != null) { this.thunderIn -= dt; if (this.thunderIn <= 0) { this.thunderIn = null; engine.events.emit('weather:thunder'); } }
    }
    this.flash = Math.max(flash, this.holdFlash || 0);
    if (lighting) lighting.flash = this.flash;

    // fog: colour from lighting, density thinned with altitude so the aerial views keep the skyline
    if (lighting && lighting.fogColor) {
      this.fog.color.copy(lighting.fogColor);
      if (rainK > 0) this.fog.color.lerp(new THREE.Color(0x0d0b14), 0.3 * rainK * night);
      const base = (lighting.fogDensity || 0.003) + 0.0027 * rainK + 0.0005 * wet * (1 - rainK);
      const alt = Math.max(0.28, Math.min(1, 1 - (cam.position.y - 12) / 220));
      this.fog.density = base * alt;
    }

    // rain streaks + splashes follow the camera
    const rain = this.rain, splash = this.splash;
    rain.visible = rainK > 0.02; splash.visible = rainK > 0.05;
    if (rain.visible) {
      const u = this.rainU;
      u.uTime.value = t; u.uWind.value.copy(this.wind);
      u.uCenter.value.set(cam.position.x, Math.max(0, cam.position.y - RAIN_BOX.y * 0.55), cam.position.z);
      u.uOpacity.value = 0.62 * rainK;
      u.uColor.value.setRGB(0.62, 0.68, 0.82).multiplyScalar(0.9 + 0.5 * (1 - night)).addScalar(this.flash * 0.8);
    }
    if (splash.visible) {
      const u = this.splashU;
      u.uTime.value = t; u.uCenter.value.set(cam.position.x, 0, cam.position.z);
      u.uOpacity.value = 0.85 * rainK;
      u.uColor.value.setRGB(0.55, 0.6, 0.72).addScalar(this.flash * 0.6);
    }
    // ripple decals: only while it rains (the standing water itself is the ground material's), fading with the rain
    const pu = this.puddleU;
    pu.uPTime.value = t; pu.uRippleK.value = 1.6 * rainK; pu.uWaveK.value = 0.25 + 0.55 * rainK;
    this.puddleMat.opacity = Math.max(0, Math.min(1, (wet - 0.15) / 0.5)) * 0.96 * Math.min(1, rainK * 4);
    if (this.puddles && this.puddles.isInstancedMesh) this.puddles.visible = this.puddleMat.opacity > 0.01;
    // reflections: strongest on a wet night; pouring rain breaks them up (more blur, a little less weight)
    const R = this.reflU;
    // aerial cameras see the ground at angles where fresnel kills the term anyway: fade and skip the mirror pass
    const aerial = Math.max(0, Math.min(1, (cam.position.y - 18) / 18));
    R.uReflK.value = this._reflErr || MIRROR_OFF ? 0 : wet * (0.42 + 0.4 * night) * (1 - 0.25 * rainK) * (1 - aerial);
    R.uReflBlur.value = 6.5 + 2.5 * rainK;
  },

  selfTest() {
    const problems = [];
    // ?test= runs inside boot (before the first frame): do the lazy first-frame work now if the city exists
    const cityUp = !!(this.engine.get('city') && this.engine.get('city').group);
    if (!this.puddles && cityUp) { try { this.placePuddles(); } catch (e) { this.puddles = {}; } }
    if (cityUp) this.hookGroundMaterials();
    if (!this.rain || !this.splash) problems.push('rain meshes');
    if (!this.puddles || !this.puddles.isInstancedMesh) problems.push('puddles');
    if (!this.engine.scene.fog) problems.push('fog');
    if (this._reflErr) problems.push('reflection pass error');
    if (!this.reflCount || this.reflCount < 4) problems.push('few reflective materials');
    return { ok: problems.length === 0, rain: +this.rainIntensity.toFixed(2), wet: +(this.engine.time.wet || 0).toFixed(2), fogDensity: +this.fog.density.toFixed(5), puddles: this.puddles && this.puddles.count, reflMaterials: this.reflCount || 0, reflCalls: this.reflStats ? this.reflStats.calls : 0, reflFrames: this.reflStats ? this.reflStats.frames : 0, problems };
  },
};

export const shotPresets = {
  weather_rain_street: { pos: [-30, 1.5, 4], lookAt: [-90, 10, -8], t: 'rain', fov: 48 },
  weather_dry_day: { pos: [-9, 0.7, 15], lookAt: [22, 9, -30], t: 'day', fov: 42 },
};
weather.shotPresets = shotPresets;

export default weather;
