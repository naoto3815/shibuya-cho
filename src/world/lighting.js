// [lighting] Sky, sun/moon (CSM), time-of-day, IBL env, pooled fixture lights, fog colour, exposure.
//   engine.time.hour drives everything (set from ?t= by shots.applyParams before boot).
//   lighting.setHour(h)            re-evaluates sun/moon, sky, colours, exposure (emits 'lighting:exposure')
//   lighting.fogColor / fogDensity THREE.Color + number the weather module copies into scene.fog every frame
//   lighting.nightFactor 0 day..1 night   lighting.duskFactor 0..1 golden hour   lighting.flash 0..1 (set by weather)
//   lighting.sun (cascade 0 of the CSM; moon at night) / hemi / sky / dome / csm / pool[]
//   lighting.addFixture({ pos:[x,y,z], color, intensity, distance })   extra spill-light candidate for the pool
//   lighting.poolLights(n)         the n active pool lights nearest the camera [{ pos, intensity, color }] (rain backlight)
//   lighting.bloomParams / aoParams  published for postfx ('postfx:bloom' / 'postfx:ao' events)
//   The real lights are a fixed pool of POOL_SIZE PointLights (constant count: no shader recompiles) assigned every
//   few frames to the fixtures nearest the camera: streetlight heads (props layout), sign / screen spill (signage.lights),
//   landmark lanterns (city builders' lights[]) and shop fronts (city.facades kind 'shop'). Every fixture also carries a
//   fake pool (additive ground quad, faded while the real light is on it) and a glare billboard (layer 1: mirrors in
//   the wet road), so the far grid glows from the air and lamp heads carry a halo.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CSM } from 'three/addons/csm/CSM.js';
import { isRoad, groundY } from './cityData.js';

// ?pool=<n> overrides the pool size for A/B (the count is baked into every lit shader: change it only at boot)
const POOL_Q = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('pool')) : NaN;
const POOL_SIZE = POOL_Q > 0 ? Math.min(64, POOL_Q | 0) : 28;
// ?shadow=<px> the near cascade's shadow map (the far one is half of it): 2048 as authored, the mobile profile's 1024
const SHADOW_Q = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('shadow')) : NaN;
const SHADOW_PX = SHADOW_Q >= 256 ? Math.min(4096, SHADOW_Q | 0) : 2048;
const SHADOW_EVERY = typeof location !== 'undefined' ? Math.max(1, Math.min(4, Number(new URLSearchParams(location.search).get('shadowEvery')) | 0 || 1)) : 1;
const NOON = 11.8, HALF_DAY = 7.1;                 // sunrise 4:42, sunset 18:54 (Tokyo, early summer)
const MOON_DIR = new THREE.Vector3(Math.cos(2.35) * Math.cos(0.9), Math.sin(0.9), Math.sin(2.35) * Math.cos(0.9)).normalize();
const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _c = new THREE.Color(), _c2 = new THREE.Color();
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const csmMaterials = new WeakSet();
// hour → colour targets (hoisted: setHour used to allocate 8 Colors per call)
const HEMI_NIGHT = new THREE.Color(0x2c3162), HEMI_DAY = new THREE.Color(0x9ab5e6), HEMI_GOLD = new THREE.Color(0xb47a6a);
const GROUND_NIGHT = new THREE.Color(0x46322a), GROUND_DAY = new THREE.Color(0x6b645c), GROUND_GOLD = new THREE.Color(0x7a5040);
const FOG_NIGHT = new THREE.Color(0x171326), FOG_DAY = new THREE.Color(0xa3b3c6), FOG_GOLD = new THREE.Color(0x9a6a5e), FOG_FLASH = new THREE.Color(0x9aa4c8);
const CLOUD_DAY = new THREE.Color(1.0, 1.0, 1.0), CLOUD_GOLD = new THREE.Color(1.0, 0.62, 0.55);
const SW_H = 0.15;

// ---- the point-light loop skips lights that cannot reach the fragment ----------------------------------------------
// Every lit fragment in the city runs three's unrolled point-light loop over ALL the scene's point lights (the pool
// of 28 plus a dozen fixed landmark / sign spills — 41) and evaluates the full BRDF (GGX D, V, F for Standard; the
// Lambert term for the crowd) for each, even when the light's range cutoff has already made its colour exactly 0.
// A street light reaches 14-44 m, so a given pixel is inside the range of only a handful of them: the rest was
// pure ALU. Measured at the scramble, Retina: hiding 31 of the 41 lights took the frame from 24.7 to 16.7 ms — the
// single biggest GPU cost in the frame. The guard below keeps every light and skips only the BRDF of a light whose
// attenuated colour is (0,0,0) — getPointLightInfo's own `visible` flag, so the output is bit-identical.
// Applied to the chunk CSM installs (CSM replaces ShaderChunk.lights_fragment_begin with its own copy on
// construction), before any material compiles.
function patchPointLightLoop() {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const a = src.indexOf('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
  const b = a < 0 ? -1 : src.indexOf('#pragma unroll_loop_end', a);
  const call = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  if (a < 0 || b < 0) { console.warn('[lighting] point-light loop not found; loop guard not applied'); return false; }
  const block = src.slice(a, b);
  if (block.includes('if ( directLight.visible ) RE_Direct')) return true;
  const i = block.lastIndexOf(call);
  if (i < 0) { console.warn('[lighting] point-light RE_Direct not found; loop guard not applied'); return false; }
  const guarded = block.slice(0, i) + 'if ( directLight.visible ) ' + block.slice(i);
  // ...and, when no point light casts a shadow (the case here: the pool never does), a REAL loop instead of three's
  // 41-fold unroll. The unrolled body (BRDF inlined 41 times) is a huge fragment shader whose register pressure
  // costs occupancy on every lit pixel; the rolled loop indexes the uniform array dynamically (GLSL ES 3.0 allows
  // it for uniforms) and lets the `visible` branch actually skip work.
  const end = '#pragma unroll_loop_end';
  const rolled = `#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct ) && !( defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0 )
	PointLight pointLight;
	for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
		pointLight = pointLights[ i ];
		vec3 plV = pointLight.position - geometryPosition;
		if ( pointLight.distance > 0.0 && dot( plV, plV ) >= pointLight.distance * pointLight.distance ) continue;   // out of range: exactly 0
		getPointLightInfo( pointLight, geometryPosition, directLight );
		if ( directLight.visible ) ${call}
	}
#elif ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )`;
  const afterIf = guarded.indexOf('\n');       // drop the original #if line: `rolled` ends in the matching #elif
  THREE.ShaderChunk.lights_fragment_begin = src.slice(0, a) + rolled + guarded.slice(afterIf) + src.slice(b);
  if (!THREE.ShaderChunk.lights_fragment_begin.includes(end)) console.warn('[lighting] point-light loop patch malformed');
  return true;
}

function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
// x-periodic value noise (period px lattice cells) for the dome clouds
function vnoise(x, y, px) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (i, j) => hash2(((i % px) + px) % px, j);
  return (h(xi, yi) * (1 - sx) + h(xi + 1, yi) * sx) * (1 - sy) + (h(xi, yi + 1) * (1 - sx) + h(xi + 1, yi + 1) * sx) * sy;
}
function fbm(x, y, px) { let a = 0.5, s = 0, f = 1; for (let o = 0; o < 4; o++) { s += vnoise(x * f, y * f, px * f) * a; a *= 0.5; f *= 2; } return s; }

// zenith at the top, horizon at half height (v = 0.5 − elevation/180°): warm sodium light-pollution glow over the
// lowest 25° of the sky with lit cloud wisps in it — what the eye sees above the roofline, not a violet card
function makeNightDome() {
  const W = 512, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  for (const [o, col] of [[0, '#05060e'], [0.16, '#0a0b1a'], [0.28, '#1a1630'], [0.36, '#3e2e42'], [0.40, '#5a4048'], [0.45, '#644648'], [0.5, '#6a4a48'], [0.53, '#4e3a3e'], [0.6, '#221a24'], [1, '#0a0810']]) g.addColorStop(o, col);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  for (let y = Math.floor(H * 0.12); y < H * 0.5; y++) {
    const v = y / H, band = smooth(0.12, 0.3, v) * (1 - smooth(0.47, 0.5, v));
    for (let x = 0; x < W; x++) {
      const n = fbm(x / W * 6, v * 14, 6);
      const k = smooth(0.42, 0.7, n) * band;
      if (k <= 0.002) continue;
      const i = (y * W + x) * 4, lit = smooth(0.24, 0.5, v);
      const r = 0x3c + lit * 0x54, gg = 0x2a + lit * 0x36, b = 0x38 + lit * 0x38;
      d[i] += (r - d[i]) * k; d[i + 1] += (gg - d[i + 1]) * k; d[i + 2] += (b - d[i + 2]) * k;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
// day: fbm cumulus / haze wisps with alpha (scrolled with the wind); rain: a flat lit cloud deck, grey-orange
function makeCloudDome(rain) {
  const W = 1024, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, u = x / W;
      if (rain) {
        const n = fbm(u * 5 + 0.3, v * 9, 5), n2 = fbm(u * 11 + 2.1, v * 20 + 4, 11);
        const lit = smooth(0.1, 0.5, v), t = 0.7 + 0.5 * (n - 0.5) + 0.25 * (n2 - 0.5);
        d[i] = Math.round((0x2c + lit * 0x40) * t); d[i + 1] = Math.round((0x26 + lit * 0x2c) * t); d[i + 2] = Math.round((0x2a + lit * 0x1a) * t); d[i + 3] = 255;
      } else {
        const n = fbm(u * 5, v * 12, 5), sh = fbm(u * 5 + 0.05, v * 12 + 0.08, 5);
        const band = smooth(0.02, 0.16, v) * (1 - smooth(0.42, 0.49, v));
        const a = smooth(0.5, 0.74, n) * band * (0.9 - 0.25 * smooth(0.36, 0.49, v));
        const shade = 1 - 0.28 * smooth(0.55, 0.85, sh);
        d[i] = Math.round(250 * shade); d[i + 1] = Math.round(248 * shade); d[i + 2] = Math.round(252 * shade); d[i + 3] = Math.round(a * 255);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.RepeatWrapping;
  return tex;
}
function radialTexture(size, inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'), g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(255,255,255,${inner})`); g.addColorStop(0.35, `rgba(255,255,255,${inner * 0.45})`); g.addColorStop(1, `rgba(255,255,255,${outer})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

// additive sprites must fade *to black* in the fog, not toward the fog colour
const ADD_FOG = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb *= 1.0 - fogFactor;
#endif`;
// view-space billboard quad per instance (size = instance scale), additive, fogged to black
const GLARE_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vCol; varying float vDepth;
void main() {
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
    vCol = instanceColor;
  #else
    vCol = vec3( 1.0 );
  #endif
  #ifdef USE_INSTANCING
    vec4 c = modelViewMatrix * ( instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) );
    float s = length( instanceMatrix[ 0 ].xyz );
  #else
    vec4 c = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
    float s = 1.0;
  #endif
  c.xy += position.xy * s;
  vDepth = -c.z;
  gl_Position = projectionMatrix * c;
}`;
const GLARE_FRAG = /* glsl */`
uniform sampler2D uMap; uniform float uOpacity; uniform float uFogDensity;
varying vec2 vUv; varying vec3 vCol; varying float vDepth;
void main() {
  float a = texture2D( uMap, vUv ).a * uOpacity;
  a *= exp( - uFogDensity * uFogDensity * vDepth * vDepth );
  gl_FragColor = vec4( vCol * a, a );
}`;

const KONBINI = /ポッポ|セブン|ファミリ|ローソン|ドラッグ|薬局|キヨヒ|サンドラ/;
const PINK = /カラオケ|パチ|スロット|キャバ|ガールズ|ラウンジ|クラブ|BAR|バー/i;
// fake ground pool per fixture kind: [radius base, radius per 140 cd], colour weight
const POOL_R = { street: [5, 4], shop: [3.2, 0], sign: [3.5, 1.5], lantern: [2.2, 0], vend: [1.3, 0], extra: [3, 1] };
const POOL_W = { street: 0.35, shop: 0.28, sign: 0.18, lantern: 0.4, vend: 0.16, extra: 0.3 };

const lighting = {
  name: 'lighting',
  fogColor: new THREE.Color(0x171326),
  fogDensity: 0.003,
  nightFactor: 1,
  duskFactor: 0,
  exposure: 1,
  flash: 0,
  sunElevation: 0,
  lastHour: -1,
  envMode: null,
  envCache: {},
  pool: [],
  fixtures: null,
  extraFixtures: [],
  csmCount: 0,
  _frame: 0,
  _hookDirty: true,

  init(engine) {
    this.engine = engine;
    const scene = engine.scene;

    // ---- sky: Preetham dome (day / golden hour) + gradient night dome with light-pollution clouds + moon; the
    // anchor group follows the camera so the domes never show their edge
    const sky = new Sky();
    sky.scale.setScalar(1000);
    sky.name = 'sky';
    // The Preetham sky writes HDR radiance; with the composer it is not tone-mapped in the scene pass, so scale it
    // here or the bloom pass turns the whole sky into white haze by day. At golden hour the Preetham hue path
    // (teal → green → yellow) is graded by luminance into navy → magenta → orange, the Tokyo dusk.
    this.skyScale = { value: 0.3 };
    this.skyGolden = { value: 0 };
    sky.material.onBeforeCompile = (shader) => {
      shader.uniforms.uSkyScale = this.skyScale;
      shader.uniforms.uSkyGolden = this.skyGolden;
      shader.fragmentShader = shader.fragmentShader
        .replace('uniform float mieDirectionalG;', 'uniform float mieDirectionalG;\nuniform float uSkyScale;\nuniform float uSkyGolden;')
        .replace('gl_FragColor = vec4( texColor, 1.0 );', `vec3 skyC = texColor * uSkyScale; float skyL = max( dot( skyC, vec3( 0.3, 0.59, 0.11 ) ), 1e-4 ); skyC *= ( skyL / ( 1.0 + skyL * 0.42 ) ) / skyL;
	float gL = dot( skyC, vec3( 0.3, 0.59, 0.11 ) );
	vec3 gRamp = mix( vec3( 0.05, 0.05, 0.22 ), mix( vec3( 0.62, 0.16, 0.42 ), vec3( 1.0, 0.42, 0.12 ), smoothstep( 0.32, 0.9, gL ) ), smoothstep( 0.02, 0.36, gL ) );
	gRamp *= gL / max( dot( gRamp, vec3( 0.3, 0.59, 0.11 ) ), 1e-4 );
	skyC = mix( skyC, mix( skyC.rrb * vec3( 1.0, 0.72, 1.05 ), gRamp, 0.6 ), uSkyGolden * 0.8 );
	gl_FragColor = vec4( skyC, 1.0 );`);   // luminance roll-off (hue kept): the low-sun glow peaks ~2.4, not 100+
    };
    sky.material.needsUpdate = true;
    scene.add(sky);
    this.sky = sky;

    const anchor = new THREE.Group(); anchor.name = 'skyAnchor'; scene.add(anchor);
    this.anchor = anchor;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 20), new THREE.MeshBasicMaterial({ map: makeNightDome(), side: THREE.BackSide, fog: false, transparent: true, depthWrite: false }));
    dome.name = 'nightDome'; dome.renderOrder = -3;
    dome.layers.enable(1);                                   // mirrored by the wet-ground pass: the road reflects the lit sky
    anchor.add(dome);
    this.dome = dome;
    const rainDome = new THREE.Mesh(new THREE.SphereGeometry(880, 32, 20), new THREE.MeshBasicMaterial({ map: makeCloudDome(true), side: THREE.BackSide, fog: false, transparent: true, depthWrite: false, opacity: 0 }));
    rainDome.name = 'rainDome'; rainDome.renderOrder = -2; rainDome.visible = false; rainDome.layers.enable(1);
    anchor.add(rainDome);
    this.rainDome = rainDome;
    this.cloudTex = makeCloudDome(false);
    const cloudDome = new THREE.Mesh(new THREE.SphereGeometry(870, 32, 20), new THREE.MeshBasicMaterial({ map: this.cloudTex, side: THREE.BackSide, fog: false, transparent: true, depthWrite: false, opacity: 0 }));
    cloudDome.name = 'cloudDome'; cloudDome.renderOrder = -2; cloudDome.visible = false;
    anchor.add(cloudDome);
    this.cloudDome = cloudDome;
    const moon = new THREE.Mesh(new THREE.CircleGeometry(11, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.25, 1.3, 1.45), fog: false, transparent: true, depthWrite: false }));
    const halo = new THREE.Mesh(new THREE.CircleGeometry(70, 32), new THREE.MeshBasicMaterial({ color: 0x6d7aa8, map: radialTexture(128, 0.55, 0), fog: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    for (const m of [halo, moon]) { m.position.copy(MOON_DIR).multiplyScalar(860); m.lookAt(0, 0, 0); m.renderOrder = -1; m.name = 'moon'; m.layers.enable(1); anchor.add(m); }
    this.moon = moon; this.halo = halo;
    // sun disc + golden-hour glare (sprites: always camera-facing)
    const sunDisc = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(64, 1.0, 0), color: new THREE.Color(3.0, 2.1, 1.3), fog: false, depthWrite: false, transparent: true, opacity: 0 }));
    const sunGlare = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(128, 0.85, 0), color: new THREE.Color(1.0, 0.5, 0.22), fog: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, opacity: 0 }));
    const sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(128, 0.4, 0), color: new THREE.Color(0.9, 0.45, 0.35), fog: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, opacity: 0 }));
    sunDisc.scale.setScalar(34); sunGlare.scale.setScalar(300); sunHalo.scale.setScalar(720);
    for (const s of [sunHalo, sunGlare, sunDisc]) { s.renderOrder = -1; s.name = 'sun'; anchor.add(s); }
    this.sunSprites = [sunDisc, sunGlare, sunHalo];

    const hemi = new THREE.HemisphereLight(0x2a3560, 0x3a2c28, 0.22);
    hemi.name = 'hemi';
    scene.add(hemi);
    this.hemi = hemi;

    // ---- key light: 2-cascade CSM (sun by day: 0-30 m / 30-100 m; dim bluish moon at night: near cascade only).
    // The city's merged batches span the whole map, so every shadow pass costs ~0.9 M triangles whatever the cascade
    // size. The near cascade (what the player sees under his feet) renders every frame; the far cascade at 30 Hz by
    // day, at 1024 px (see scheduleShadows). A one-frame-old far map stays consistent: shadow.matrix only updates
    // when its map renders.
    const csm = new CSM({ camera: engine.camera, parent: scene, cascades: 2, maxFar: 180, mode: 'practical', shadowMapSize: SHADOW_PX, lightDirection: new THREE.Vector3(0.3, -1, 0.4).normalize(), lightIntensity: 2.6, lightMargin: 200, lightNear: 1, lightFar: 1400 });
    csm.fade = true;
    patchPointLightLoop();
    csm.lights.forEach((l, i) => { l.name = 'sun_csm' + i; l.shadow.bias = -0.00025; l.shadow.normalBias = i === 0 ? 0.06 : 0.3; l.shadow.radius = i === 0 ? 1.0 : 1.6; l.shadow.autoUpdate = false; l.shadow.needsUpdate = true; if (i > 0) l.shadow.mapSize.set(SHADOW_PX / 2, SHADOW_PX / 2); });
    csm.updateFrustums();
    this.csm = csm;
    this.sun = csm.lights[0];
    this._cam = { fov: -1, aspect: -1, maxFar: -1 };
    // CSM bounds must follow the camera of the frame being rendered (the camera module updates after us)
    const prevOBR = scene.onBeforeRender;
    scene.onBeforeRender = (renderer, sc, cam, ...rest) => {
      if (typeof prevOBR === 'function') prevOBR.call(sc, renderer, sc, cam, ...rest);
      if (cam !== engine.camera) return;
      try {
        cam.updateMatrixWorld();
        csm.update();
        for (const l of csm.lights) { l.updateMatrixWorld(); l.target.updateMatrixWorld(); }
      } catch (e) { if (!this._csmErr) { this._csmErr = true; console.error('[lighting] csm update', e); } }
    };

    // ---- pooled fixture lights (constant count)
    for (let i = 0; i < POOL_SIZE; i++) {
      const pl = new THREE.PointLight(0xffffff, 0, 24, 2);
      pl.name = 'poolLight' + i; pl.castShadow = false;
      pl.position.set(0, -50, 0);
      scene.add(pl);
      this.pool.push({ light: pl, cand: null, cur: 0, target: 0, base: 0 });
    }

    this.setHour(engine.time.hour, true);
    engine.events.on('time:changed', () => this.setHour(engine.time.hour, true));
    engine.events.on('engine:booted', () => { this._hookDirty = true; });
    engine.events.on('scene:added', () => { this._hookDirty = true; });
  },

  addFixture(f) {
    const fx = { pos: new THREE.Vector3(...(f.pos || [0, 3, 0])), color: new THREE.Color(f.color ?? 0xffd9a0), intensity: f.intensity ?? 40, distance: f.distance ?? 20, kind: f.kind || 'extra' };
    this.extraFixtures.push(fx);
    if (this.fixtures) this.fixtures.push(fx);
    return fx;
  },

  // fixture candidates gathered once every module has built its geometry
  gatherFixtures() {
    const engine = this.engine, city = engine.get('city'), props = engine.get('props'), signage = engine.get('signage');
    const out = [];
    const add = (x, y, z, color, intensity, distance, kind) => out.push({ pos: new THREE.Vector3(x, y, z), color: new THREE.Color(color), intensity, distance, kind });
    const MAIN = new Set(['dogenzaka', 'dogenzaka_shita', 'bunkamura', 'ekimae_s', 'meiji_ne', 'koen', 'inokashira', 'miyamasu', 'jingu_n']);
    // A sign spill / lantern that is mirrored into the pool is RETIRED as a scene light: it used to stay on as well,
    // so near it the fixture was lit twice (the pool copy at fixture strength carries 75-90% of the light) and
    // everywhere else it was one more iteration of every lit pixel's point-light loop — 13 permanent lights, 41
    // in the shader instead of 28. Measured: -2.2 ms at the scramble (Retina), and a same-frame A/B at
    // crossing_night, signage_centergai_low and lighting_nonbei differs only at grain level (mean |d| <= 0.5 LSB
    // outside the animated LED screens). Retired before the first frame renders, so no program is built twice.
    const retire = (l) => { if (l.visible) { l.visible = false; l.userData.pooled = true; this.retired = (this.retired || 0) + 1; } };
    let street = 0, vend = 0;
    if (props && Array.isArray(props.lights) && props.lights.length) {
      for (const l of props.lights) {
        const p = l.position || l.pos; if (!p) continue;
        const x = p.x ?? p[0], y = p.y ?? p[1], z = p.z ?? p[2];
        // a vending machine's face light (props authors it at 2.0 over 2.2 m) was filed as a STREET light: clamped up
        // to 90 cd with a 7.6 m pool and a lamp glare, 13 of the 28 pool slots at the scramble, and anyone standing
        // in front of a machine lit like a torch (client: 「自販が明るすぎ」). Its own kind now: ~10 cd over 2.6 m,
        // a 1.3 m spill on the pavement, no glare, and never a real light.
        if ((l.distance ?? 34) < 4) { add(x, y, z, l.color ?? 0xffdcb0, Math.min(12, (l.intensity ?? 2) * 5), 2.6, 'vend'); vend++; continue; }
        add(x, y, z, l.color ?? 0xe6ecff, Math.min(140, Math.max(90, l.intensity ?? 110)), l.distance ?? 34, 'street'); street++;
      }
    } else if (city && Array.isArray(city.roads)) {
      // same layout as props.js: both sides every 22 m, heads 2.3 m over the road, skipping the crossing box
      for (const r of city.roads) {
        if (r.pedestrian || !r.points) continue;
        const cool = MAIN.has(r.id);
        for (let i = 0; i < r.points.length - 1; i++) {
          const a = r.points[i], b = r.points[i + 1];
          const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
          if (len < 1e-3) continue;
          const nx = dz / len, nz = -dx / len, off = r.width / 2 + 0.6;
          for (let s = 8; s < len - 4; s += 22) {
            const t = s / len, x = a[0] + dx * t, z = a[1] + dz * t;
            for (const side of [1, -1]) {
              const px = x + nx * off * side, pz = z + nz * off * side;
              if (Math.abs(px) < 26 && Math.abs(pz) < 26) continue;
              add(px - nx * side * 2.3, 8.0, pz - nz * side * 2.3, cool ? 0xe2eaff : 0xffd8a0, cool ? 130 : 100, 34, 'street'); street++;
            }
          }
        }
      }
      for (const [x, z] of [[-21, -21], [21, -21], [21, 21], [-21, 21]]) { const n = Math.hypot(x, z); add(x - x / n * 2.3 * 1.35, 10.8, z - z / n * 2.3 * 1.35, 0xeef2ff, 160, 40, 'street'); street++; }
    }
    let sign = 0;
    if (signage && Array.isArray(signage.lights)) {
      for (const l of signage.lights) {
        if (!l || !l.isLight) continue;
        l.getWorldPosition(_v);
        add(_v.x, _v.y, _v.z, l.color, Math.min(90, Math.max(40, (l.userData.base || 1) * 30)), Math.max(16, l.distance || 20), 'sign'); sign++;
        retire(l);
      }
    }
    // landmark builders return their own dim lights (nonbei lanterns): mirror them at fixture strength
    let lantern = 0;
    const cityGroup = city && city.group ? city.group : engine.scene.getObjectByName('city');
    if (cityGroup) cityGroup.traverse((o) => { if (o.isPointLight && !o.name.startsWith('poolLight')) { o.getWorldPosition(_v); add(_v.x, _v.y, _v.z, o.color, Math.min(60, Math.max(28, o.intensity * 7)), Math.max(10, o.distance || 10), 'lantern'); lantern++; retire(o); } });
    let shop = 0;
    if (city && Array.isArray(city.facades)) {
      for (const f of city.facades) {
        if (f.kind !== 'shop' || !f.position || !f.normal) continue;
        const name = (f.tenants && f.tenants[0]) || '';
        const color = KONBINI.test(name) ? 0xdde8ff : PINK.test(name) ? 0xffa0c8 : 0xffc890;
        add(f.position.x + f.normal.x * 1.6, Math.min(2.6, (f.groundFloorHeight || 3.2) * 0.8), f.position.z + f.normal.z * 1.6, color, KONBINI.test(name) ? 22 : 16, 14, 'shop'); shop++;
      }
    }
    for (const f of this.extraFixtures) out.push(f);
    this.fixtures = out;
    this.fixtureStats = { street, vend, sign, lantern, shop, extra: this.extraFixtures.length };
    try { this.buildFixtureSprites(); } catch (e) { console.error('[lighting] fixture sprites', e); }
    console.info(`[lighting] ${out.length} light fixtures (${street} streetlights, ${vend} vending, ${sign} sign spill, ${lantern} lanterns, ${shop} shop fronts) → pool of ${POOL_SIZE}`);
  },

  // one additive InstancedMesh of ground pools (every fixture) + one of lamp-head glare billboards (street / neon)
  buildFixtureSprites() {
    const scene = this.engine.scene, fx = this.fixtures, n = fx.length;
    if (!n) return;
    const gMat = new THREE.MeshBasicMaterial({ map: radialTexture(64, 0.6, 0), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
    gMat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', ADD_FOG); };
    gMat.customProgramCacheKey = () => 'lighting-pool';
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), gMat, n);
    const base = this.poolBase = new Float32Array(n * 3);
    const glareIdx = [];
    fx.forEach((f, i) => {
      f.idx = i;
      const [r0, r1] = POOL_R[f.kind] || POOL_R.extra, r = r0 + r1 * clamp01(f.intensity / 140);
      const y = groundY(f.pos.x, f.pos.z) + (isRoad(f.pos.x, f.pos.z) ? 0 : SW_H) + 0.04;
      _q.setFromAxisAngle(_v.set(0, 1, 0), hash2(i, 3) * Math.PI);
      pools.setMatrixAt(i, _m.compose(_p.set(f.pos.x, y, f.pos.z), _q, _s.set(r * 2, 1, r * 2)));
      const w = (POOL_W[f.kind] || POOL_W.extra) * (0.55 + 0.45 * clamp01(f.intensity / 140));
      base[i * 3] = f.color.r * w; base[i * 3 + 1] = f.color.g * w; base[i * 3 + 2] = f.color.b * w;
      pools.setColorAt(i, _c.setRGB(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]));
      if (f.kind === 'street' || (f.kind === 'sign' && f.distance < 25)) glareIdx.push(i);
    });
    pools.instanceColor.needsUpdate = true;
    pools.name = 'fixturePools'; pools.renderOrder = 2; pools.frustumCulled = false; pools.castShadow = pools.receiveShadow = false;
    scene.add(pools);
    this.poolMesh = pools;

    this.glareU = { uMap: { value: radialTexture(64, 0.9, 0) }, uOpacity: { value: 0 }, uFogDensity: { value: 0.003 } };
    const glMat = new THREE.ShaderMaterial({ uniforms: this.glareU, vertexShader: GLARE_VERT, fragmentShader: GLARE_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const glare = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glMat, Math.max(1, glareIdx.length));
    glareIdx.forEach((fi, k) => {
      const f = fx[fi];
      const sz = Math.max(0.8, Math.min(2.4, 1.3 * f.intensity / 90));
      glare.setMatrixAt(k, _m.compose(_p.copy(f.pos), _q.identity(), _s.setScalar(sz)));
      glare.setColorAt(k, _c.copy(f.color).multiplyScalar(f.kind === 'sign' ? 0.9 : 1.6));
    });
    glare.count = glareIdx.length; glare.instanceColor.needsUpdate = true;
    glare.name = 'fixtureGlare'; glare.renderOrder = 3; glare.frustumCulled = false; glare.castShadow = glare.receiveShadow = false;
    glare.layers.enable(1);
    scene.add(glare);
    this.glareMesh = glare;
  },

  // pick the POOL_SIZE fixtures nearest the camera focus (in front of the camera preferred), with hysteresis
  updatePool(dt) {
    const engine = this.engine, cam = engine.camera;
    if (!this.fixtures) return;
    const night = 0.04 + 0.96 * this.nightFactor;
    if (this._frame % 4 === 0) {
      cam.getWorldDirection(_f);
      const cx = cam.position.x + _f.x * 10, cz = cam.position.z + _f.z * 10;
      const assigned = new Set(); for (const s of this.pool) if (s.cand) assigned.add(s.cand);
      const near = [];
      for (const f of this.fixtures) {
        const dx = f.pos.x - cam.position.x, dz = f.pos.z - cam.position.z, dc = Math.hypot(dx, dz);
        if (dc > 75 + f.distance || f.kind === 'vend') continue;          // a machine's spill is its pool quad only: a real
        //   point light 0.3 m from a pedestrian's face turned him into a torch
        const ahead = (dx * _f.x + dz * _f.z);
        let score = Math.hypot(f.pos.x - cx, f.pos.z - cz) + Math.max(0, -ahead) * 1.4 + Math.max(0, cam.position.y - f.pos.y - 20) * 0.5;
        score -= f.intensity * 0.06;
        if (assigned.has(f)) score *= 0.85;
        near.push([score, f]);
      }
      near.sort((a, b) => a[0] - b[0]);
      const want = new Set(); for (let i = 0; i < Math.min(POOL_SIZE, near.length); i++) want.add(near[i][1]);
      for (const s of this.pool) if (s.cand && !want.has(s.cand)) s.target = 0;
      for (const f of want) {
        if (assigned.has(f)) continue;
        const slot = this.pool.find(s => !s.cand) || this.pool.find(s => s.target === 0 && s.cur < 0.03);
        if (!slot) break;
        slot.cand = f; slot.cur = 0; slot.base = f.intensity; slot.target = f.intensity;
        slot.light.position.copy(f.pos); slot.light.color.copy(f.color); slot.light.distance = f.distance;
        assigned.add(f);
      }
    }
    const k = Math.min(1, dt * 5);
    const pm = this.poolMesh, base = this.poolBase;
    let colorDirty = false;
    for (const s of this.pool) {
      if (!s.cand) continue;
      s.cur += (s.target - s.cur) * k;
      const f = s.cand;
      if (s.target === 0 && s.cur < 0.03) {
        s.cur = 0; s.cand = null; s.light.intensity = 0; s.light.position.y = -50;
        if (pm && f.idx != null) { pm.instanceColor.setXYZ(f.idx, base[f.idx * 3], base[f.idx * 3 + 1], base[f.idx * 3 + 2]); colorDirty = true; }
        continue;
      }
      s.light.intensity = s.cur * (f.kind === 'shop' ? 0.25 + 0.75 * this.nightFactor : night);
      // the fake pool fades out (to a 35 % floor) while the real light is on the fixture
      if (pm && f.idx != null) { const w = 1 - 0.65 * clamp01(s.cur / (s.base || 1)); pm.instanceColor.setXYZ(f.idx, base[f.idx * 3] * w, base[f.idx * 3 + 1] * w, base[f.idx * 3 + 2] * w); colorDirty = true; }
    }
    if (colorDirty) pm.instanceColor.needsUpdate = true;
  },

  // the n brightest-at-camera active pool lights (weather backlights its rain streaks with them)
  poolLights(n = 3) {
    const cam = this.engine.camera, list = [];
    for (const s of this.pool) {
      if (!s.cand || s.light.intensity <= 0) continue;
      const d2 = s.light.position.distanceToSquared(cam.position);
      list.push([s.light.intensity / (d2 + 4), s]);
    }
    list.sort((a, b) => b[0] - a[0]);
    return list.slice(0, n).map(([, s]) => ({ pos: s.light.position, intensity: s.light.intensity, color: s.light.color }));
  },

  setHour(hour, force = false) {
    const engine = this.engine;
    const h = ((hour % 24) + 24) % 24;
    if (!force && Math.abs(h - this.lastHour) < 1e-3) return;
    this.lastHour = h;
    const x = ((h - NOON) / 24) * Math.PI * 2;
    const elev = Math.cos(x) * 0.72 + 0.205;                                     // radians above the horizon
    const az = -0.35 + ((h - (NOON - HALF_DAY)) / (2 * HALF_DAY)) * (Math.PI + 0.7);   // ENE sunrise → WNW sunset
    this.sunElevation = elev;
    const daylight = smooth(-0.06, 0.24, elev);
    const golden = clamp01(1 - Math.abs(elev - 0.1) / 0.22) * (1 - 0.35 * daylight * daylight);
    this.nightFactor = 1 - daylight;
    this.duskFactor = golden;
    this.daylight = daylight;
    engine.time.night = this.nightFactor;

    // golden hour cheat: the sky/sun sit ~3° lower than the clock says (redder band, longer shadows)
    const sunEl = elev - 0.05 * golden;
    const sunDir = _v.set(Math.cos(az) * Math.cos(sunEl), Math.sin(sunEl), Math.sin(az) * Math.cos(sunEl)).normalize();
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(sunDir).multiplyScalar(1000);
    // golden hour: more rayleigh (pink/orange band) but only a little extra mie, or the low sun becomes a white blob
    u.turbidity.value = 2.4 + 7.6 * golden;
    u.rayleigh.value = 1.6 + 3.2 * golden;
    u.mieCoefficient.value = 0.003 + 0.006 * golden;
    u.mieDirectionalG.value = 0.78 + 0.15 * golden;
    this.skyScale.value = 0.3 - 0.13 * golden;
    this.skyGolden.value = golden;

    // key light: sun (warm at golden hour) blended into the moon just below the horizon. Day: the sun must dominate
    // the sky fill (~15:1) so building / pedestrian shadows read; night: a weak moon whose shadows are only ~half dark.
    const sunK = smooth(-0.05, 0.03, elev);
    const sunCol = _c.setHSL(0.075 + 0.03 * daylight, 0.5 + 0.4 * golden, 0.6 + 0.3 * daylight * (1 - golden));
    const sunI = 0.35 + 5.65 * smooth(-0.03, 0.4, elev);
    const moonCol = _c2.set(0x8fa3d8), moonI = 0.24;
    const keyCol = moonCol.lerp(sunCol, sunK), keyI = moonI + (sunI - moonI) * sunK;
    const dir = sunK > 0.5 ? sunDir : MOON_DIR;
    this.csm.lightDirection.copy(dir).negate().normalize();
    const shadowK = 0.55 + 0.45 * sunK;
    for (const l of this.csm.lights) { l.color.copy(keyCol); l.intensity = keyI; l.shadow.intensity = shadowK; }
    this.csmDay = sunK > 0.5;
    this.csmMaxFar = this.csmDay ? 100 : 70;

    // ambient: kept low so the local sources (lamp pools, shop spill, neon) are what lights the night
    this.hemiBase = 0.22 + 0.10 * daylight + 0.05 * golden;
    this.hemi.color.copy(HEMI_NIGHT).lerp(HEMI_DAY, daylight).lerp(HEMI_GOLD, golden * 0.7);
    this.hemi.groundColor.copy(GROUND_NIGHT).lerp(GROUND_DAY, daylight).lerp(GROUND_GOLD, golden * 0.6);

    // fog: night = violet-grey light pollution, day = pale blue haze, golden hour = mauve amber
    this._fogBase = (this._fogBase || new THREE.Color()).copy(FOG_NIGHT).lerp(FOG_DAY, daylight).lerp(FOG_GOLD, golden * 0.7);
    this.fogColor.copy(this._fogBase);
    this.fogDensity = 0.0034 - 0.0012 * daylight + 0.0004 * golden;
    engine.renderer.setClearColor(this.fogColor, 1);
    this.domeBase = smooth(0.2, 0.75, this.nightFactor);
    this.dome.material.opacity = this.domeBase;
    this.dome.visible = this.domeBase > 0.01;
    this.moon.material.opacity = smooth(0.35, 0.9, this.nightFactor);
    this.halo.material.opacity = 0.5 * smooth(0.35, 0.9, this.nightFactor);
    // day clouds (warm at golden hour), sun disc + glare at low sun
    this.cloudBase = daylight * 0.6;
    this.cloudDome.material.color.copy(CLOUD_DAY).lerp(CLOUD_GOLD, golden * 0.8);
    this.cloudDome.material.opacity = this.cloudBase;
    this.cloudDome.visible = this.cloudBase > 0.01;
    const glareK = golden * sunK, [sunDisc, sunGlare, sunHalo] = this.sunSprites;
    for (const s of this.sunSprites) { s.position.copy(sunDir).multiplyScalar(850); s.visible = glareK > 0.01; }
    sunDisc.material.opacity = glareK; sunGlare.material.opacity = 0.9 * glareK; sunHalo.material.opacity = 0.55 * glareK;

    this.exposure = 0.85 - 0.30 * daylight + 0.12 * golden;
    engine.renderer.toneMappingExposure = this.exposure;
    engine.events.emit('lighting:exposure', this.exposure);
    // bloom: only the neon/emissives at night (1.25: the MAG's PARK box must not clip); by day the sky/sunlit
    // concrete must stay clean. AO: creases under the crowd / cars, stronger at night where the ambient is flat.
    this.bloomParams = { threshold: 1.25 + 0.35 * daylight, strength: 0.46 - 0.22 * daylight, radius: 0.5 };
    engine.events.emit('postfx:bloom', this.bloomParams);
    this.aoParams = { radius: 0.6, intensity: 0.6 + 0.3 * this.nightFactor };
    engine.events.emit('postfx:ao', this.aoParams);
    engine.events.emit('lighting:changed', { hour: h, night: this.nightFactor, daylight, golden, fog: this.fogColor });
    this.updateEnvironment();
  },

  // IBL: materials.makeEnvironment (procedural sky + lit towers + neon patches) per mode, cached
  updateEnvironment() {
    const engine = this.engine, scene = engine.scene, materials = engine.get('materials');
    const mode = this.nightFactor > 0.55 ? 'night' : this.duskFactor > 0.35 ? 'dusk' : 'day';
    scene.environmentIntensity = mode === 'night' ? 0.30 : mode === 'dusk' ? 0.3 : 0.18;
    if (mode === this.envMode) return;
    this.envMode = mode;
    if (!this.envCache[mode]) {
      try {
        if (materials && typeof materials.makeEnvironment === 'function') this.envCache[mode] = materials.makeEnvironment(engine.renderer, mode);
      } catch (e) { console.error('[lighting] makeEnvironment failed', e); }
      if (!this.envCache[mode]) {                                    // fallback: PMREM of the sky dome
        const pmrem = new THREE.PMREMGenerator(engine.renderer);
        const envScene = new THREE.Scene();
        const skyClone = this.sky.clone(); skyClone.material = this.sky.material; skyClone.scale.setScalar(50); envScene.add(skyClone);
        this.envCache[mode] = pmrem.fromScene(envScene, 0.02, 0.1, 100).texture;
        pmrem.dispose();
      }
    }
    scene.environment = this.envCache[mode];
  },

  // chain the CSM shader hook behind whatever hook a material already has (materials library, signage, shops…)
  attachCSM(m) {
    if (!m || csmMaterials.has(m)) return;
    if (!(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial)) return;
    csmMaterials.add(m);
    const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey();
    this.csm.setupMaterial(m);
    this._hookedNew = true;
    const hook = m.onBeforeCompile;
    m.onBeforeCompile = function (shader, renderer) { prev.call(this, shader, renderer); hook.call(this, shader, renderer); };
    m.customProgramCacheKey = () => prevKey + '|csm';
    m.needsUpdate = true;
    this.csmCount++;
  },
  // new lit materials (any module) get the cascade hook: after boot, on scene:added, and every 60 frames (not per frame)
  hookMaterials() {
    // after boot, an object whose material is hooked NOW (an enemy spawned for a fight, a late prop) gets its CSM
    // variant compiled in the background immediately — otherwise the hook's needsUpdate makes its next draw a
    // synchronous compile (measured 146 ms on the two enforcers mid-fight)
    const late = this.engine.booted && this.engine.stats.frame > 4 && typeof this.engine.precompile === 'function' ? [] : null;
    this.engine.scene.traverse((o) => {
      const m = o.material; if (!m) return;
      this._hookedNew = false;
      if (Array.isArray(m)) { for (const mm of m) this.attachCSM(mm); } else this.attachCSM(m);
      if (late && this._hookedNew) late.push(o);
    });
    if (late && late.length) {
      // one compile per top-level subtree (an enemy's group), not per mesh: each call walks the scene for its lights
      const scene = this.engine.scene, roots = new Set();
      for (const o of late) { let r = o; while (r.parent && r.parent !== scene) r = r.parent; roots.add(r); }
      for (const r of roots) this.engine.precompile(r);
    }
  },

  update(dt) {
    const engine = this.engine, cam = engine.camera;
    this._frame++;
    if (!engine.state.frozen && engine.time.speed !== 0 && engine.time.advance) engine.time.hour = (engine.time.hour + dt / 60) % 24;
    if (Math.abs(engine.time.hour - this.lastHour) > 0.01) this.setHour(engine.time.hour);
    if (!this.fixtures && engine.booted) this.gatherFixtures();
    if (this._hookDirty || this._frame < 4 || this._frame === 30 || this._frame % 60 === 0) { this._hookDirty = false; this.hookMaterials(); }
    // cascade splits follow the camera projection / key range
    const c = this._cam;
    if (cam.fov !== c.fov || cam.aspect !== c.aspect || this.csmMaxFar !== c.maxFar) {
      c.fov = cam.fov; c.aspect = cam.aspect; c.maxFar = this.csmMaxFar;
      this.csm.maxFar = this.csmMaxFar;
      this.csm.updateFrustums();
    }
    this.scheduleShadows();
    this.updatePool(dt);
    const weather = engine.get('weather');
    const rainK = weather && weather.rainIntensity ? Math.min(1, weather.rainIntensity) : 0;
    // lightning / heat flash (weather sets flash 0..1)
    const fl = this.flash;
    this.hemi.intensity = this.hemiBase + 2.4 * fl;
    this.dome.material.color.setScalar(1 + 2.5 * fl);
    if (fl > 0.001) this.fogColor.copy(this._fogBase).lerp(FOG_FLASH, fl * 0.7); else if (!this.fogColor.equals(this._fogBase)) this.fogColor.copy(this._fogBase);
    // rain: a low lit cloud deck crossfades over the stars / day sky
    const rd = this.rainDome;
    rd.material.opacity = 0.8 * rainK; rd.visible = rainK > 0.02;
    rd.material.color.setScalar((1 + 1.6 * (this.daylight || 0)) * (1 + 2.5 * fl));
    this.dome.material.opacity = this.domeBase * (1 - 0.35 * rainK);
    if (this.cloudDome.visible) { this.cloudDome.material.opacity = this.cloudBase * (1 - 0.6 * rainK); const w = weather && weather.wind; this.cloudTex.offset.x += ((w ? w.x : 1.2) * 0.00045 + 0.0002) * dt; }
    if (this.glareU) { this.glareU.uOpacity.value = (0.04 + 0.96 * this.nightFactor) * (1 + 0.6 * rainK); this.glareU.uFogDensity.value = engine.scene.fog && engine.scene.fog.isFogExp2 ? engine.scene.fog.density : this.fogDensity; }
    if (this.poolMesh) this.poolMesh.material.opacity = 0.04 + 0.96 * this.nightFactor;
    this.anchor.position.set(cam.position.x, 0, cam.position.z);
    this.sky.position.set(cam.position.x, 0, cam.position.z);
  },

  // near cascade every frame (never stale under the player's feet); far cascade at 30 Hz by day, rendered once
  // empty (far = 1.01) and frozen at night
  scheduleShadows() {
    const day = !!this.csmDay, L = this.csm.lights;
    if (day !== this._shadowDay) {
      this._shadowDay = day;
      for (let i = 1; i < L.length; i++) { const sh = L[i].shadow; sh.camera.far = day ? 1400 : 1.01; sh.camera.updateProjectionMatrix(); sh.needsUpdate = true; }
      L[0].shadow.needsUpdate = true;
      return;
    }
    // [mobile] ?shadowEvery=<n>: the near cascade renders every n-th frame (the far one every 2n-th, off the near's frames);
    // a map a frame old stays consistent for the same reason the far one does. The mobile profile's 2.
    const E = SHADOW_EVERY, odd = (this._frame % (2 * E)) === 1;
    L[0].shadow.needsUpdate = E === 1 || (this._frame % E) === 0;
    for (let i = 1; i < L.length; i++) L[i].shadow.needsUpdate = day && odd;
  },

  selfTest() {
    // ?test= runs before the first frame: do the lazy first-frame work here so the numbers mean something
    if (!this.fixtures) this.gatherFixtures();
    this.hookMaterials();
    this._frame = 0; this.engine.camera.updateMatrixWorld(); this.updatePool(1);
    const active = this.pool.filter(s => s.cand && s.light.intensity > 0).length;
    const problems = [];
    if (!this.engine.scene.environment) problems.push('no environment');
    if (!this.fixtures || this.fixtures.length < 20) problems.push('few fixtures');
    if (this.csmCount < 10) problems.push('csm materials');
    if (this._csmErr) problems.push('csm update error');
    if (!this.poolMesh || !this.glareMesh) problems.push('fixture sprites');
    return { ok: problems.length === 0, fixtures: this.fixtures ? this.fixtures.length : 0, ...(this.fixtureStats || {}), poolActive: active, glare: this.glareMesh ? this.glareMesh.count : 0, csmMaterials: this.csmCount, env: this.envMode, exposure: +this.exposure.toFixed(2), night: +this.nightFactor.toFixed(2), problems };
  },
};

export const shotPresets = {
  dusk_109: { pos: [-14, 1.7, 10], lookAt: [-84, 18, -4], t: 'dusk', fov: 50 },
  lighting_dawn: { pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'dawn' },
  lighting_day_hachiko: { pos: [6, 1.7, 22], lookAt: [40, 6, 44], t: 'day', fov: 50 },
  lighting_rain_puddle: { pos: [-9, 0.7, 15], lookAt: [22, 9, -30], t: 'rain', fov: 42 },
  lighting_nonbei: { pos: [78, 1.6, -33], lookAt: [78, 2.4, -70], t: 'night', fov: 50 },
  lighting_lightning: { pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'rain', setup(engine) { const w = engine.get('weather'); if (w) w.holdFlash = 0.8; } },
  lighting_street_night: { pos: [-48, 1.6, 6], lookAt: [-120, 8, 40], t: 'night', fov: 50 },
};
lighting.shotPresets = shotPresets;

export default lighting;
