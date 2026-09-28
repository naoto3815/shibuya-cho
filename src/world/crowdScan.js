// [crowd] src/world/crowdScan.js -- every pedestrian is one of the client's scanned people (docs/PEDS.md:
// 「基本的にアップロードしたイメージ以外で通行人は使わない」). This module is the crowd's RENDERING; crowd.js keeps the
// simulation (crossing waves, walkers, idlers, Hachiko square, Center-gai, the onlooker ring, car push-out) and this
// module gives every pedestrian a scan key (assignScanKeys). One person, three tiers:
//
//   near  a pool of rigged bodies from createHumanoid({ variant: 'ped_<key>' }), posed by the SAME clip at the SAME
//         phase as the instanced twin, bound / unbound by crowd.bindHeroes (the identity lock) where nobody sees it.
//   mid   (<= MID_D) one InstancedMesh per scan on its lod1 part, the scan's own maps (albedo, normal, ORM) through a
//         MeshStandardMaterial whose vertex stage reads the pose from a vertex-animation texture.
//         (lod1 is TEXTURE-SAFE since round 5: built no lower than its uv-chart floor, 3.4-8.5 k tris, so the 7-20 m
//         tier shows the scan's clothes, not flat-coloured facets; inside ~7 m everybody is a pool body -- crowd.js
//         SCAN_LOD0_CAP)
//   far   (beyond) one InstancedMesh per scan on its lod2 part, the scan's albedo.
//   the wet-road mirror: ONE vertex-pulled mesh (gl_VertexID -> that scan's corner row -> its VAT column, albedo from a
//         256² array) holding the nearest REFL_N, drawn by weather.js's reflection camera only.
//
// The VATs are baked AT LOAD: each scan's lod1 / lod2 SkinnedMesh is CPU-skinned through animations.js's clips (walk,
// idle, run; 'look' if it exists) at 16-24 frames a cycle. One RGBA16UI texel per vertex and frame: the position
// quantised to 37 µm inside a fixed body box, the normal octahedral in 2 x 8 bits -- one fetch per frame sample.
// A column per UNIQUE vertex (a scan's UV seams split ~2.4 vertices per triangle; the pose does not care), addressed
// by the per-vertex attribute aVat; one texture per tier for all 19 people. Baked in slices of ~12 ms with the event
// loop released between them. Per instance: clip / phase of the locomotion clip, clip / phase of the standing clip,
// the blend between them, the dithered fade, the neon rim. The walk phase advances by metres travelled / the scan's
// own stride, so a foot never slides.
//
// Sources: humanoid.js's PED_SCANS / pedScansReady() (the 19 people, [pedscan]); ?crowdMob=1 prototypes the whole
// pipeline on the four mob scans (dev only: without the flag they are never pedestrians); ?crowdLegacy=1 is the old
// procedural crowd for A/B, and the fallback when no scan loads.
import * as THREE from 'three';
import * as HUM from '../characters/humanoid.js';
import { getClip, CLIPS } from '../characters/animations.js';
import { crumb } from '../core/mobileProfile.js';

const QS = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
export const CROWD_LEGACY = QS.get('crowdLegacy') === '1';
const MOB_DEV = QS.get('crowdMob') === '1';
const MOBS = ['enforcer_b', 'enforcer_a', 'wanderer', 'nightlife_king'];

// tiers and budgets (?scanMid=<m> moves the lod1 / lod2 line for A/B)
const MID_D = Number(QS.get('scanMid')) || 20;   // lod1 inside (a 1.7 m body is >= ~150 px), lod2 beyond
const SCAN_PER = Number(QS.get('scanPer')) > 0 ? Number(QS.get('scanPer')) | 0 : 0;   // pool bodies per person at boot (buildPool)
const CULL_D = 115;                              // crowd.js CULL
const REFL_N = 28;                               // bodies in the wet-road mirror
const SHADOW_D = 25;                             // no shadow pass beyond this (day only)
const FAR2_D = 27;                               // the foot pad stops here, the soft blob goes on
const RIG_CROWN = 1.784;                         // crowd.js: p.scale x this = standing height
const STATIC_CAP = 12, STATIC_MID2 = 12 * 12;                            // per scan and tier: posed people outside the simulation (setStatics)
const POOL_MAX = 96, POOL_REBUILD_T = 2.5;           // (three bodies a person at boot, grown on demand: crowd.js binds up to 32 at once)
const POOL_SWAP_D = 14;                          // crowd.js SCAN_SWAP_D: the pool body's lod0 / lod1 line
const VAT_W = 4096;                              // texture width in columns (rows wrap in blocks of VAT_F)
const ALB_N = 256;                               // mirror albedo layer size
// ids 0..4, frames per cycle. 'brisk' (2026-09-26) is the walk clip with the legs left at its full 2.4 m/s stride (TUNE[4]):
// a quicker pace is a LONGER stride first (the instance blends walk -> brisk), a quicker step only up to a human cadence
const CLIP_WANT = [['walk', 24], ['idle', 24], ['run', 16], ['look', 24], ['brisk', 16, 'walk']];
// [mobile] ?vatK=<0..1> scales every clip's frame count, ?vatClips=walk,idle,... bakes only those (the rest fall back to walk /
// idle, as a missing clip always did): the VAT textures are scans x vertices x frames x 8 bytes, baked at load
const VAT_K = Number(QS.get('vatK')) > 0 && Number(QS.get('vatK')) < 1 ? Number(QS.get('vatK')) : 1;
const VAT_CLIPS = QS.get('vatClips') ? new Set(QS.get('vatClips').split(',')) : null;
const RUN_ON = 3.3, RUN_OFF = 2.9;               // m/s: the run clip is a sprint (5.6 m/s); a hurry stays a brisk walk
// Step length (m) against walking pace (m/s) for a 1.75 m adult, scaled by height: the gait's stride is chosen from it
// and the cadence follows (1.3 m/s -> 0.69 m steps at 1.9 steps/s; 2.3 m/s -> 0.91 m at 2.5). Human gait data, rounded.
const STEP_L = [[0, 0], [0.3, 0.32], [0.6, 0.48], [0.9, 0.58], [1.2, 0.66], [1.5, 0.74], [1.8, 0.81], [2.1, 0.87], [2.5, 0.95], [3.0, 1.02]];
const stepLenTab = (v) => { if (v <= 0) return 0; for (let i = 1; i < STEP_L.length; i++) if (v <= STEP_L[i][0]) { const a = STEP_L[i - 1], b = STEP_L[i]; return a[1] + (b[1] - a[1]) * (v - a[0]) / (b[0] - a[0]); } return STEP_L[STEP_L.length - 1][1]; };
// (tabulated at 2 cm/s, read with a lerp: animate() runs for every drawn pedestrian every frame)
const STEP_LUT = new Float32Array(162); for (let k = 0; k < 162; k++) STEP_LUT[k] = stepLenTab(k * 0.02);
const stepLenAt = (v) => { if (!(v > 0)) return 0; const f = v * 50, k = f | 0; if (k >= 160) return STEP_LUT[160]; return STEP_LUT[k] + (STEP_LUT[k + 1] - STEP_LUT[k]) * (f - k); };
const CAD_WALK = 2.5, CAD_RUN = 3.3;             // steps / s at most: a walk, a run
const VAT_MIN = [-1.2, -0.3, -1.2], VAT_EXT = [2.4, 2.7, 2.4];   // the body box the positions are quantised in
const ENV_K = 1.0;
// ?scanDbg=nomid | nofar | nopool | nodecal | norefl | lite | double | novat -- measuring what a tier / a feature costs
const SCAN_DBG = QS.get('scanDbg') || '';
// shading model per tier (?scanShade=mid:standard,far:lambert,...). The PBR light loop over the street's pooled point
// lights is what a crowd pixel costs: measured at crossing_night, Standard on both instanced tiers 41 fps, Lambert 58.
// The pool body shades like its twin (a Standard body bound onto a Lambert twin is a visible change at 14 m).
const SHADE = { mid: 'lambert', far: 'lambert', pool: 'lambert', mirror: 'lambert' };
for (const kv of (QS.get('scanShade') || '').split(',')) { const [k, v] = kv.split(':'); if (SHADE[k] && (v === 'standard' || v === 'lambert')) SHADE[k] = v; }

// [render] Precompile a subtree's programs in the variant the frame will actually draw: lighting's CSM hook attached
// first (it changes the program) and the scene target bound (tone mapping / output colour space are program
// parameters — renderer.compileAsync against the canvas built the ACES/sRGB variant no scene pass uses, so the
// real one still compiled synchronously on first sight). Before frame 4 the engine precompiles the whole scene
// itself, after the lights are final; until then this only hooks.
export function precompileLit(engine, root) {
  const L = engine && engine.get ? engine.get('lighting') : null;
  try { if (L && L.csm && typeof L.hookMaterials === 'function') L.hookMaterials(); } catch (e) { void e; }
  if (!engine || !engine.booted || !(engine.stats && engine.stats.frame > 4)) return;
  if (typeof engine.precompile === 'function') { engine.precompile(root); return; }
  const r = engine.renderer;
  if (r && r.compileAsync) { try { r.compileAsync(root, engine.camera, engine.scene).catch(() => {}); } catch (e) { void e; } }
}

const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _pm = new THREE.Matrix4(), _fr = new THREE.Frustum();
const _sph = new THREE.Sphere(new THREE.Vector3(), 1.2);
const _qR = new THREE.Quaternion(), _qT = new THREE.Quaternion(), _qI = new THREE.Quaternion();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hash01 = (i) => (((i + 1) * 2654435761) >>> 0) / 4294967296;
const nightK = (h) => (h < 4.8 || h >= 19.4 ? 1 : h < 6.6 ? clamp((6.6 - h) / 1.8, 0, 1) : h > 17.5 ? clamp((h - 17.5) / 1.9, 0, 1) : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trisOf = (m) => { const g = m.geometry; return (g.index ? g.index.count : g.attributes.position.count) / 3; };
const firstMat = (m) => (Array.isArray(m) ? m[0] : m);

// ------------------------------------------------------------------------------------------------ the source
// { kind, scans: [{ key, variant, height|null }], ready(): Promise<keys|undefined> }  or null (the legacy crowd)
export function scanSource() {
  if (CROWD_LEGACY) return null;
  const P = HUM.PED_SCANS;
  if (!MOB_DEV && Array.isArray(P) && P.length && typeof HUM.pedScansReady === 'function') {
    return {
      kind: 'ped',
      scans: P.map((s) => ({ key: s.key, variant: s.variant || 'ped_' + s.key, height: s.height || null, fem: !!s.fem, age: s.age || 'adult', role: s.role || null })),
      // resolves with the keys that loaded: the crowd is cast from those (a missing scan is simply not cast)
      ready: async () => { const keys = await HUM.pedScansReady(); return Array.isArray(keys) ? keys : null; },
    };
  }
  if (MOB_DEV) {
    return {
      kind: 'mob',
      scans: MOBS.map((k) => ({ key: k, variant: k, height: null, fem: false, age: 'adult', role: null })),
      // the three civilian scans report ready through civScans(); nightlife_king is checked at its bake
      ready: async () => {
        const t0 = performance.now();
        while (performance.now() - t0 < 60000) {
          if ((typeof HUM.civScans === 'function' ? HUM.civScans() : []).length >= 3) return null;
          await sleep(60);
        }
        throw new Error('mob scans never loaded');
      },
    };
  }
  return null;
}

// Every pedestrian gets a scan from its seed (its index), spread evenly over the scans, and never the same scan as a
// companion or -- where the neighbourhood allows it -- as anyone standing within 6 m when the crowd is seeded.
export function assignScanKeys(peds, scans) {
  const K = scans.length, used = new Int32Array(K), near = new Float32Array(K);
  const C = 6, grid = new Map();
  const cell = (gx, gz) => (gx + 2048) * 4096 + (gz + 2048);
  for (let i = 0; i < peds.length; i++) {
    const p = peds[i];
    near.fill(0);
    const gx = Math.floor(p.x / C), gz = Math.floor(p.z / C);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const L = grid.get(cell(gx + dx, gz + dz));
      if (!L) continue;
      for (const q of L) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < C) near[q.sk] += 1 + (C - d) / C; }
    }
    for (const q of [p.mate, p.leader, ...(Array.isArray(p.members) ? p.members : [])]) if (q && q !== p && q.sk != null) near[q.sk] += 50;
    const h0 = Math.floor(hash01(p.index != null ? p.index : i) * K);
    let best = 0, bs = Infinity;
    for (let k = 0; k < K; k++) {
      const kk = (k + h0) % K, s = near[kk] * 1000 + used[kk];
      if (s < bs) { bs = s; best = kk; }
    }
    p.sk = best; used[best]++;
    const c = cell(gx, gz);
    let L = grid.get(c); if (!L) grid.set(c, L = []);
    L.push(p);
  }
  return used;
}

// ------------------------------------------------------------------------------------------------ shaders
function vatGLSL(defs, FT) {
  const c = (i) => `ivec2(${defs[i].base}, ${defs[i].F})`;
  const f = (x) => x.toFixed(4);
  return `
  #define VAT_F ${FT}
  ivec2 vatClipDef(int c) { ${defs.map((d, i) => (i < defs.length - 1 ? `if (c == ${i}) return ${c(i)}; ` : `return ${c(i)};`)).join('')} }
  void vatTexel(int v, int row, out vec3 P, out vec3 N) {
    uvec4 t = texelFetch(uVat, ivec2(v % uVatW, (v / uVatW) * VAT_F + row), 0);
    P = vec3(${f(VAT_MIN[0])}, ${f(VAT_MIN[1])}, ${f(VAT_MIN[2])}) + vec3(t.xyz) * (vec3(${f(VAT_EXT[0])}, ${f(VAT_EXT[1])}, ${f(VAT_EXT[2])}) / 65535.0);
    vec2 e = vec2(float(t.w >> 8u), float(t.w & 255u)) * (2.0 / 255.0) - 1.0;
    N = vec3(e, 1.0 - abs(e.x) - abs(e.y));
    if (N.z < 0.0) N.xy = (1.0 - abs(N.yx)) * vec2(N.x >= 0.0 ? 1.0 : -1.0, N.y >= 0.0 ? 1.0 : -1.0);
    N = normalize(N);
  }
  void vatClip(int v, int clip, float ph, float w, inout vec3 P, inout vec3 N) {
    ivec2 C = vatClipDef(clip);
    float fr = fract(ph) * float(C.y);
    int f0 = int(fr); float ft = fr - float(f0);
    int f1 = f0 + 1; if (f1 >= C.y) f1 = 0;
    vec3 p0, n0, p1, n1;
    vatTexel(v, C.x + f0, p0, n0); vatTexel(v, C.x + f1, p1, n1);
    P += mix(p0, p1, ft) * w; N += mix(n0, n1, ft) * w;
  }
  void vatSample(int v, inout vec3 P, inout vec3 N) {
    P = vec3(0.0); N = vec3(0.0);
    float wB = iAnim2.x;
    if (wB < 0.999) vatClip(v, int(iAnim.x + 0.5), iAnim.y, 1.0 - wB, P, N);
    if (wB > 0.001) vatClip(v, int(iAnim.z + 0.5), iAnim.w, wB, P, N);
    N = normalize(N + vec3(0.0, 1e-5, 0.0));
  }`;
}
const VAT_DECL = 'uniform highp usampler2D uVat; uniform int uVatW;\nattribute vec4 iAnim; attribute vec4 iAnim2;\n';
const RIM_DECODE = `vec3 crowdRimDecode(float pk) { float r = floor(pk / 65536.0); float g = floor((pk - r * 65536.0) / 256.0); float b = pk - r * 65536.0 - g * 256.0; vec3 e = vec3(r, g, b) / 255.0; return e * e; }`;
const RIM_VS = (src) => `vRimC = crowdRimDecode(${src}.x);
  vRimL = (abs(${src}.y) + abs(${src}.z) > 0.01) ? normalize((viewMatrix * vec4(${src}.y, 0.0, ${src}.z, 0.0)).xyz) : vec3(0.0);`;
// the old crowd's neon rim (crowd.js rimPatch): an edge on the side facing the brightest emitter near that person,
// a little of its colour on the cloth, a bounce off the wet road on the down-facing normals; off inside ~3 m
const RIM_FS = `{ vec3 rN = normalize(normal);
    float rNV = 1.0 - clamp(dot(rN, normalize(vViewPosition)), 0.0, 1.0);
    float crowdF = rNV * rNV;
    float rSide = dot(vRimL, vRimL) > 0.25 ? clamp(dot(rN, vRimL) * 0.7 + 0.55, 0.3, 1.0) : 0.6;
    float rCam = clamp((length(vViewPosition) - 3.0) / 6.0, 0.0, 1.0);
    vec3 rAlb = 0.28 + 0.72 * sqrt(max(diffuseColor.rgb, vec3(0.0)));
    float rBounce = clamp((0.3 - (vec4(rN, 0.0) * viewMatrix).y) / 1.3, 0.0, 1.0);
    gl_FragColor.rgb += vRimC * rCam * (rSide * (crowdF * 2.2 * rAlb + CROWD_FILL * diffuseColor.rgb) + 0.15 * rBounce * rAlb); }`;
// a sky / ground fill on the scans' own albedo (the street at night is lit by signs, not by a sky): the crowd has to
// read against the frontages the way the hero does under his character light. Irradiance, so it rides the albedo.
const FILL_FS = `{ vec3 fUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    float fk = dot(normalize(normal), fUp) * 0.5 + 0.5;
    reflectedLight.indirectDiffuse += mix(uFillGnd, uFillSky, fk) * BRDF_Lambert(material.diffuseColor); }`;
const FADE_FS = `if (vFade < 0.997 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) > vFade) discard;`;

// ------------------------------------------------------------------------------------------------ the renderer
export class CrowdScan {
  constructor(crowd, src) {
    this.crowd = crowd; this.engine = crowd.engine; this.src = src;
    this.S = [];                  // per scan (index = p.sk): key, heights, strides, tier meshes, lists
    this.ready = false;
    this.nBodies = 0; this.lastGrow = -9; this.poolBuilds = 0; this.maxSlice = 0;
    this.fillU = { uFillSky: { value: new THREE.Vector3() }, uFillGnd: { value: new THREE.Vector3() } };
    this.stat = { bakeMs: 0, vatMid: 0, vatFar: 0, mirrorMB: 0, cols: [0, 0], verts: [0, 0], mid: 0, far: 0, midTris: 0, farTris: 0, draws: 0 };
  }

  // ---------------------------------------------------------------------------------------------- prepare (async)
  async prepare() {
    const T0 = performance.now();
    crumb('crowd', 'wait scans');
    const keys = await this.src.ready();
    if (Array.isArray(keys)) this.src.scans = this.src.scans.filter((s) => keys.includes(s.key));
    this.src.all = HUM.PED_SCANS && this.src.kind === 'ped' ? HUM.PED_SCANS.length : this.src.scans.length;
    if (!this.src.scans.length) throw new Error('no pedestrian scan loaded');
    // every pedestrian gets one of the people that loaded (from its seed, spread evenly, company never alike)
    assignScanKeys(this.crowd.peds, this.src.scans);
    this.defineClips();
    this.slice = performance.now();
    const bodies = [];
    for (let s = 0; s < this.src.scans.length; s++) {
      crumb('crowd', `bake ${s + 1}/${this.src.scans.length} ${this.src.scans[s].key}`);   // [mobile] boot breadcrumb
      try { bodies[s] = await this.bakeScan(s); }
      catch (e) { console.warn(`[crowdScan] ${this.src.scans[s].key}: not baked (${e.message})`); this.S[s] = null; }
    }
    const ok = this.S.map((S, i) => (S ? i : -1)).filter((i) => i >= 0);
    if (!ok.length) throw new Error('no scan could be baked');
    for (const p of this.crowd.peds) if (!this.S[p.sk]) p.sk = ok[p.index % ok.length];
    for (const p of this.crowd.peds) this.keyPed(p);
    this.root = new THREE.Group(); this.root.name = 'crowdScan'; this.engine.scene.add(this.root);
    crumb('crowd', 'tiers'); this.buildTiers();
    crumb('crowd', 'mirror'); await this.buildMirror();
    this.buildDecals();
    crumb('crowd', 'pool'); await this.buildPool(bodies);
    for (const S of this.S) if (S) { S.parts = null; }
    this.stat.bakeMs = performance.now() - T0;
    // compile the new programs off the frame (parallel compile), not on the first frame that shows them
    precompileLit(this.engine, this.root);
    this.hook();
    this.ready = true;
    const st = this.stat, live = ok.map((s) => this.S[s]);
    console.info(`[crowdScan] ${this.src.kind} scans: ${ok.length}/${this.src.scans.length} baked in ${st.bakeMs.toFixed(0)} ms (longest slice ${this.maxSlice.toFixed(0)} ms: ${this.maxSliceAt}); ` +
      `clips ${this.defs.filter((d, i) => d.id === i).map((d) => d.name + '/' + d.F).join(' ')}; VAT lod1 ${st.vatMid.toFixed(1)} MB (${st.cols[0]} columns of ${st.verts[0]} vertices), ` +
      `lod2 ${st.vatFar.toFixed(1)} MB (${st.cols[1]} of ${st.verts[1]}), mirror ${st.mirrorMB.toFixed(1)} MB; lod1 ${live.map((S) => S.tri1).join('/')} tris, lod2 ${live.map((S) => S.tri2).join('/')} tris; pool ${this.crowd.heroes.length} bodies`);
  }

  // yield the event loop when the current slice has run long (boot never hitches for long)
  async breathe(label) {
    const d = performance.now() - this.slice;
    if (d < 12) return;
    if (d > this.maxSlice) { this.maxSlice = d; this.maxSliceAt = label || '?'; }
    await sleep(0);
    this.slice = performance.now();
  }

  defineClips() {
    let base = 0;
    const defs = [];
    for (let id = 0; id < CLIP_WANT.length; id++) {
      const [name, F0, from] = CLIP_WANT[id], cn = from || name, F = Math.max(6, Math.round(F0 * VAT_K));
      const want = !VAT_CLIPS || VAT_CLIPS.has(name) || name === 'walk' || name === 'idle';
      const clip = want && (cn === 'walk' || cn === 'idle' || CLIPS.includes(cn)) ? getClip(cn) : null;
      if (!clip) { defs.push(null); continue; }
      defs.push({ id, name, clip, F, base, dur: clip.duration, stride: (clip.userData && clip.userData.stride) || null });
      base += F;
    }
    if (!defs[0] || !defs[1]) throw new Error('walk / idle clips missing');
    if (!defs[2]) defs[2] = defs[0];            // no run: a hurry is a brisk walk
    if (!defs[3]) defs[3] = defs[1];            // no gawk idle: the ring stands in the idle
    if (!defs[4]) defs[4] = defs[0];
    this.defs = defs; this.FT = base;
    this.hasLook = defs[3].id === 3; this.hasRun = defs[2].id === 2; this.hasBrisk = defs[4].id === 4;
    this.idleDur = defs[1].dur; this.lookDur = defs[3].dur;
  }

  // ---------------------------------------------------------------------------------------------- the bake
  async bakeScan(s) {
    const sc = this.src.scans[s];
    const h = HUM.createHumanoid({ variant: sc.variant, seed: 7 + s, lod: true, getClip });
    if (!h.scan) { try { h.dispose(); } catch (e) { void e; } throw new Error('scan not loaded'); }
    h.frozenPose = true;
    h.group.position.set(0, 0, 0); h.group.rotation.set(0, 0, 0);
    h.group.updateMatrixWorld(true);
    const ladder = h.meshes.slice().sort((a, b) => trisOf(b) - trisOf(a));
    const m0 = ladder[0], m1 = ladder[1] || m0, m2 = ladder[2] || m1;
    // standing height in the body group's space (its own scale included): crown over sole, bind pose
    let hi = -Infinity;
    { const pos = m0.geometry.attributes.position; m0.updateMatrixWorld(true);
      for (let i = 0; i < pos.count; i += 3) { _v.fromBufferAttribute(pos, i).applyMatrix4(m0.matrixWorld); if (_v.y > hi) hi = _v.y; } }
    const bakeH = hi;
    // the stride this skeleton walks the clip at (authored on the generic rig: foot travel scales with the leg)
    const gs = h.group.scale.x || 1, legOf = (B) => B.LeftLeg.position.length() + B.LeftFoot.position.length();
    const rigLeg = HUM.RIG.local.LeftLeg.position.length() + HUM.RIG.local.LeftFoot.position.length();
    const legK = legOf(h.bones) * gs / rigLeg;
    const dW = this.defs[0], dR = this.defs[2];
    let stride = (dW.stride || 2.4 * dW.dur) * legK, strideRun = (dR.stride || 5.6 * dR.dur) * legK, strideBrisk = stride;
    // the scan's own bind pose is its natural scanned stance (docs/PEDS.md: arms down): the tuning pulls toward it
    const bind = { q: {}, hip: h.bones.Hips.position.clone() };
    for (const n of HUM.BONE_NAMES) if (h.bones[n]) bind.q[n] = h.bones[n].quaternion.clone();

    // 1. the skin matrices of every baked frame (bone world x bone inverse), and the feet for the ground decals
    const bones = h.skeleton.bones, inv = h.skeleton.boneInverses, NB = bones.length, FT = this.FT;
    const mats = new Float32Array(FT * NB * 16), feet = new Float32Array(FT * 4), fz = new Float32Array(64 * 4);
    const mixer = h.mixer;
    const kneeLog = {}, liftLog = {};
    for (let di = 0; di < this.defs.length; di++) {
      const d = this.defs[di];
      if (d.id !== di) continue;                                   // an alias (no run / no look) is its clip's rows
      mixer.stopAllAction();
      const a = mixer.clipAction(d.clip);
      a.reset(); a.setLoop(THREE.LoopRepeat, Infinity); a.setEffectiveTimeScale(1); a.setEffectiveWeight(1); a.play();
      // walk / brisk: the stance knee at mid-stance, measured over the cycle first, sets this scan's pelvis lift
      let lift = 0;
      if (d.id === 0 || d.id === 4) {
        let phi = 0, best = 1e9, la = 0, lb = 0;
        for (let k = 0; k < d.F; k++) {
          a.time = (k / d.F) * d.dur; mixer.update(0); tunePose(h, bind, TUNE[d.id], 1); h.group.updateMatrixWorld(true);
          const Lw = h.bones.LeftFoot.matrixWorld.elements, Rw = h.bones.RightFoot.matrixWorld.elements, sL = Lw[13] <= Rw[13], st = sL ? 'Left' : 'Right';
          const hip = h.bones.Hips.matrixWorld.elements, under = Math.abs((sL ? Lw : Rw)[14] - hip[14]);
          if (under < best) {
            best = under;
            _kA.setFromMatrixPosition(h.bones[st + 'UpLeg'].matrixWorld); _kB.setFromMatrixPosition(h.bones[st + 'Leg'].matrixWorld); _kC.setFromMatrixPosition(h.bones[st + 'Foot'].matrixWorld);
            la = _kA.distanceTo(_kB); lb = _kB.distanceTo(_kC);
            _kC.sub(_kB); _kB.sub(_kA); phi = _kB.angleTo(_kC) * 180 / Math.PI;
          }
        }
        lift = kneeLift(la, lb, phi);
        (liftLog[d.id] = { lift, phi });
      }
      for (let k = 0; k < d.F; k++) {
        a.time = (k / d.F) * d.dur;
        mixer.update(0);
        tunePose(h, bind, TUNE[d.id], 1);
        if (lift > 0) liftLegs(h, lift);
        clampHandsLike(h);
        h.group.updateMatrixWorld(true);
        const f = d.base + k;
        for (let j = 0; j < NB; j++) { _m.multiplyMatrices(bones[j].matrixWorld, inv[j]); _m.toArray(mats, (f * NB + j) * 16); }
        // planted-foot table: ankle x / z of the lower foot and its height
        const L = h.bones.LeftFoot.matrixWorld.elements, R = h.bones.RightFoot.matrixWorld.elements, useL = L[13] <= R[13];
        feet[f * 4] = useL ? L[12] : R[12]; feet[f * 4 + 1] = useL ? L[14] : R[14]; feet[f * 4 + 2] = Math.min(L[13], R[13]); feet[f * 4 + 3] = useL ? 0 : 1;
        fz[k * 4] = L[13]; fz[k * 4 + 1] = L[14]; fz[k * 4 + 2] = R[13]; fz[k * 4 + 3] = R[14];
        // (the knee as baked, for the gait's look: flexion of the stance leg where its foot passes under the hip, and
        // the deepest of the cycle -- crowdScan.knees())
        if (d.id === 0 || d.id === 4) {
          const B = h.bones, flex = (s0) => { _kA.setFromMatrixPosition(B[s0 + 'UpLeg'].matrixWorld); _kB.setFromMatrixPosition(B[s0 + 'Leg'].matrixWorld); _kC.setFromMatrixPosition(B[s0 + 'Foot'].matrixWorld); _kB.sub(_kA); _kC.sub(_kA.setFromMatrixPosition(B[s0 + 'Leg'].matrixWorld)); return _kB.angleTo(_kC) * 180 / Math.PI; };
          const st = useL ? 'Left' : 'Right', hip = h.bones.Hips.matrixWorld.elements, foot = useL ? L : R;
          const kn = (kneeLog[d.id] || (kneeLog[d.id] = { mid: 0, midD: 1e9, max: 0 }));
          const fs = flex(st), under = Math.abs(foot[14] - hip[14]);
          if (under < kn.midD) { kn.midD = under; kn.mid = fs; }
          kn.max = Math.max(kn.max, flex('Left'), flex('Right'));
        }
      }
      // the stride as walked: the backward travel of the planted (lower) foot over one cycle, so the phase advances
      // exactly as far as the ground moves under that foot
      if (d.id === 0 || d.id === 2 || d.id === 4) {
        let tr = 0;
        for (let k = 0; k < d.F; k++) {
          const k2 = (k + 1) % d.F, lk = fz[k * 4] <= fz[k * 4 + 2], lk2 = fz[k2 * 4] <= fz[k2 * 4 + 2];
          if (lk !== lk2) continue;
          const z0 = lk ? fz[k * 4 + 1] : fz[k * 4 + 3], z1 = lk ? fz[k2 * 4 + 1] : fz[k2 * 4 + 3];
          if (z0 > z1) tr += z0 - z1;
        }
        const est = d.id === 2 ? strideRun : stride;
        if (tr > est * 0.4 && tr < est * 1.9) { if (d.id === 0) stride = tr; else if (d.id === 4) strideBrisk = tr; else strideRun = tr; }
      }
      await this.breathe('pose ' + (s === 0 || d.id === 0 ? 'bake body' : d.name));
    }
    mixer.stopAllAction();

    // 2. CPU skinning of the unique vertices of lod1 and lod2 through every baked frame
    const P1 = await this.skinPart(m1, mats, NB);
    const P2 = m2 === m1 ? P1 : await this.skinPart(m2, mats, NB);
    const src = firstMat(m1.material) || firstMat(h.skinned.material);
    this.S[s] = {
      knee: { walk: kneeLog[0] ? [+kneeLog[0].mid.toFixed(1), +kneeLog[0].max.toFixed(1)] : null, brisk: kneeLog[4] ? [+kneeLog[4].mid.toFixed(1), +kneeLog[4].max.toFixed(1)] : null },
      lift: [liftLog[0] ? liftLog[0].lift : 0, 0, 0, 0, liftLog[4] ? liftLog[4].lift : 0], kneeBefore: [liftLog[0] ? +liftLog[0].phi.toFixed(1) : null, liftLog[4] ? +liftLog[4].phi.toFixed(1) : null],
      bakeScale: gs, i: s, key: sc.key, variant: sc.variant, role: sc.role || null, height: sc.height || bakeH, bakeH, stride, strideRun, strideBrisk: Math.max(strideBrisk, stride), feet, bind,
      parts: [P1, P2], geo: [m1.geometry, m2.geometry], tri1: Math.round(trisOf(m1)), tri2: Math.round(trisOf(m2)),
      maps: { map: src.map || null, normalMap: src.normalMap || null, roughnessMap: src.roughnessMap || null, metalnessMap: src.metalnessMap || null, aoMap: src.aoMap || null },
      alb: src.map && src.map.image ? src.map.image : null,
    };
    return h;
  }

  // Skin one part's unique vertices (position + normal + skin; UV seams collapse) through every baked frame into
  // packed RGBA16UI texels, frame-major. remap: part vertex -> unique column.
  async skinPart(mesh, mats, NB) {
    const geo = mesh.geometry;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const pos = geo.attributes.position, nrm = geo.attributes.normal, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    const nV = pos.count, FT = this.FT;
    const bm = mesh.bindMatrix && !mesh.bindMatrix.equals(_m.identity()) ? mesh.bindMatrix : null;
    const remap = new Int32Array(nV), seen = new Map();
    const px = [], nx = [], bi = [], bw = [];
    for (let i = 0; i < nV; i++) {
      _v.fromBufferAttribute(pos, i); if (bm) _v.applyMatrix4(bm);
      const x = _v.x, y = _v.y, z = _v.z;
      _v.fromBufferAttribute(nrm, i); if (bm) _v.transformDirection(bm);
      const a = _v.x, b = _v.y, c = _v.z;
      let key = Math.round(x * 1e5) + ',' + Math.round(y * 1e5) + ',' + Math.round(z * 1e5) + ',' + Math.round(a * 100) + ',' + Math.round(b * 100) + ',' + Math.round(c * 100);
      for (let k = 0; k < 4; k++) key += ',' + si.getComponent(i, k) + ':' + Math.round(sw.getComponent(i, k) * 1000);
      const u = seen.get(key);
      if (u !== undefined) { remap[i] = u; continue; }
      const n = px.length / 3;
      seen.set(key, n); remap[i] = n;
      px.push(x, y, z); nx.push(a, b, c);
      let ws = 0; const w4 = [];
      for (let k = 0; k < 4; k++) { bi.push(si.getComponent(i, k)); const w = sw.getComponent(i, k); w4.push(w); ws += w; }
      for (let k = 0; k < 4; k++) bw.push(ws > 1e-6 ? w4[k] / ws : w4[k]);
    }
    const nU = px.length / 3;
    const out = new Uint16Array(nU * FT * 4);
    const mnx = VAT_MIN[0], mny = VAT_MIN[1], mnz = VAT_MIN[2], kx = 65535 / VAT_EXT[0], ky = 65535 / VAT_EXT[1], kz = 65535 / VAT_EXT[2];
    const q = (v) => (v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v));
    for (let f = 0; f < FT; f++) {
      const mo = f * NB * 16;
      for (let v = 0; v < nU; v++) {
        const x = px[v * 3], y = px[v * 3 + 1], z = px[v * 3 + 2], a = nx[v * 3], b = nx[v * 3 + 1], c = nx[v * 3 + 2];
        let X = 0, Y = 0, Z = 0, A = 0, B = 0, C = 0;
        for (let k = 0; k < 4; k++) {
          const w = bw[v * 4 + k]; if (w === 0) continue;
          const o = mo + bi[v * 4 + k] * 16;
          const e0 = mats[o], e1 = mats[o + 1], e2 = mats[o + 2], e4 = mats[o + 4], e5 = mats[o + 5], e6 = mats[o + 6], e8 = mats[o + 8], e9 = mats[o + 9], e10 = mats[o + 10];
          X += w * (e0 * x + e4 * y + e8 * z + mats[o + 12]); Y += w * (e1 * x + e5 * y + e9 * z + mats[o + 13]); Z += w * (e2 * x + e6 * y + e10 * z + mats[o + 14]);
          A += w * (e0 * a + e4 * b + e8 * c); B += w * (e1 * a + e5 * b + e9 * c); C += w * (e2 * a + e6 * b + e10 * c);
        }
        // the normal, octahedral: |n|1 projection, the lower half folded over the diagonals
        const l1 = Math.abs(A) + Math.abs(B) + Math.abs(C) || 1;
        let ou = A / l1, ov = B / l1;
        if (C < 0) { const su = ou >= 0 ? 1 : -1, sv = ov >= 0 ? 1 : -1; const tu = (1 - Math.abs(ov)) * su; ov = (1 - Math.abs(ou)) * sv; ou = tu; }
        const t = (f * nU + v) * 4;
        out[t] = q((X - mnx) * kx); out[t + 1] = q((Y - mny) * ky); out[t + 2] = q((Z - mnz) * kz);
        out[t + 3] = (Math.round((ou * 0.5 + 0.5) * 255) << 8) | Math.round((ov * 0.5 + 0.5) * 255);
      }
      if ((f & 7) === 7) await this.breathe('skin');
    }
    return { nV, nU, remap, data: out };
  }

  // ped fields the renderer keeps: height from the scan, the instance scale against the baked body, anim state
  keyPed(p) {
    const S = this.S[p.sk];
    p.pk = S.key;
    p.scale = S.height / RIG_CROWN;
    p._si = S.height / S.bakeH;                      // instance scale (1 when the scan is shown at its own height)
    p._sh = S.height; p._shK = Math.sqrt(S.height / 1.75);
    p._ap = hash01(p.index * 3 + 1); p._ip = hash01(p.index * 7 + 3);
    p._aw = p.moving ? 1 : 0; p._sv = p.moving ? (p.vel || p.speed || 1.2) : 0; p._rx = p.x; p._rz = p.z; p._run = false;
    // the fastest this person walks: 2.4 steps / s at their longest (brisk) step; a pace the sim gives above 92 % of it
    // is theirs no longer (a crosser's hurry, a slope, a span's pace are all held to it in crowd.js)
    p.vmax = Math.min(2.4, 2.4 * (S.strideBrisk || S.stride) * p._si / 2);
    if (p.speed > p.vmax * 0.92) p.speed = p.vmax * 0.92;
    p._ctl = p.moving ? 1 : 0; p._wd = 0; p._cB = 1; p._wB = p.moving ? 0 : 1;
  }

  // one texture per tier: every scan's unique columns, VAT_W wide, blocks of FT rows
  assemble(tier) {
    const live = this.S.filter(Boolean), FT = this.FT;
    let n = 0, verts = 0;
    for (const S of live) { const P = S.parts[tier]; S['off' + tier] = n; n += P.nU; verts += P.nV; }
    const W = Math.min(VAT_W, n), blocks = Math.ceil(n / W), H = blocks * FT;
    const data = new Uint16Array(W * H * 4);
    for (const S of live) {
      const P = S.parts[tier], off = S['off' + tier];
      for (let u = 0; u < P.nU; u++) {
        const g = off + u, gx = g % W, gb = Math.floor(g / W) * FT;
        for (let f = 0; f < FT; f++) {
          const a = (f * P.nU + u) * 4, b = ((gb + f) * W + gx) * 4;
          data[b] = P.data[a]; data[b + 1] = P.data[a + 1]; data[b + 2] = P.data[a + 2]; data[b + 3] = P.data[a + 3];
        }
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAIntegerFormat, THREE.UnsignedShortType);
    tex.internalFormat = 'RGBA16UI';
    tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.flipY = false; tex.needsUpdate = true;
    this.stat[tier ? 'vatFar' : 'vatMid'] = W * H * 8 / 1048576;
    this.stat.cols[tier] = n; this.stat.verts[tier] = verts;
    return { uVat: { value: tex }, uVatW: { value: W } };
  }

  // ---------------------------------------------------------------------------------------------- materials
  patch(sh, mode) {
    // mode: 'mid' | 'far' (per-scan instanced, aVat) | 'mirror' (pulled) | 'pool' (a rigged body: rim uniform)
    const inst = mode !== 'pool';
    let vdecl = 'varying float vFade; varying vec3 vRimC; varying vec3 vRimL;\n' + RIM_DECODE;
    if (inst) vdecl = VAT_DECL + 'attribute vec3 aRim;\n' + (mode === 'mirror' ? '' : 'attribute float aVat;\n') + vdecl + vatGLSL(this.defs, this.FT);
    else vdecl = 'uniform vec3 uRim;\n' + vdecl;
    if (mode === 'mirror') vdecl = 'uniform highp sampler2D uCorner; uniform int uCornerW; uniform int uCMax;\nvarying vec2 vScanUv; flat varying float vLayer;\n' + vdecl;
    if (inst) {
      const vbody = mode === 'mirror'
        ? `vec3 vatP = vec3(0.0), vatN = vec3(0.0, 1.0, 0.0); vScanUv = vec2(0.0); vLayer = iAnim2.z;
          { int c = gl_VertexID; int cN = int(iAnim2.w + 0.5);
            if (c < cN) { int ii = int(iAnim2.z + 0.5) * uCMax + c; vec4 k = texelFetch(uCorner, ivec2(ii % uCornerW, ii / uCornerW), 0);
              vatSample(int(k.x + 0.5), vatP, vatN); vScanUv = k.yz; } }`
        : SCAN_DBG.includes('novat') ? 'vec3 vatP = position, vatN = vec3(0.0, 0.0, 1.0);' : 'vec3 vatP, vatN; vatSample(int(aVat + 0.5), vatP, vatN);';
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + vdecl)
        .replace('#include <beginnormal_vertex>', `${vbody}
          vec3 objectNormal = vatN;
          #ifdef USE_TANGENT
          vec3 objectTangent = vec3( tangent.xyz );
          #endif
          vFade = iAnim2.y;
          ${RIM_VS('aRim')}`)
        .replace('#include <begin_vertex>', 'vec3 transformed = vatP;\n#ifdef USE_ALPHAHASH\nvPosition = vec3( position );\n#endif');
    } else {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + vdecl)
        .replace('#include <begin_vertex>', `vFade = 1.0;\n${RIM_VS('uRim')}\n#include <begin_vertex>`);
    }
    let fdecl = 'varying float vFade; varying vec3 vRimC; varying vec3 vRimL; uniform vec3 uFillSky; uniform vec3 uFillGnd;\n';
    if (mode === 'mirror') fdecl += 'uniform highp sampler2DArray uAlb; varying vec2 vScanUv; flat varying float vLayer;\n';
    sh.fragmentShader = '#define CROWD_FILL 0.95\n' + sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + fdecl)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + (SCAN_DBG.includes('nofade') ? '' : FADE_FS))
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + (SCAN_DBG.includes('nofill') ? '' : FILL_FS))
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' + (SCAN_DBG.includes('norim') ? '' : RIM_FS));
    if (mode === 'mirror') sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb *= texture(uAlb, vec3(vScanUv, vLayer)).rgb;');
    Object.assign(sh.uniforms, this.fillU);
    if (this.crowd.knee) this.crowd.knee(sh);
  }

  scanMaterial(S, mode, U) {
    const M = { ...S.maps };
    // the far tier and the lite A/B: the albedo alone (a 60 px figure has no use for a normal map)
    if (mode === 'far' || mode === 'poolFar' || (SCAN_DBG.includes('lite') && mode === 'mid')) { M.normalMap = null; M.roughnessMap = null; M.metalnessMap = null; M.aoMap = null; }
    const side = mode === 'pool' || SCAN_DBG.includes('double') ? THREE.DoubleSide : THREE.FrontSide;
    const shade = SHADE[mode === 'poolFar' ? 'far' : mode], patchMode = mode === 'poolFar' ? 'pool' : mode;
    if (SCAN_DBG.includes('farbasic') && mode === 'far') {
      const b = new THREE.MeshBasicMaterial({ name: 'crowdScan:dbg', map: M.map, side });
      b.onBeforeCompile = (sh) => {
        if (U) Object.assign(sh.uniforms, U);
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + VAT_DECL + 'attribute float aVat;\n' + vatGLSL(this.defs, this.FT))
          .replace('#include <begin_vertex>', 'vec3 vatP, vatN; vatSample(int(aVat + 0.5), vatP, vatN); vec3 transformed = vatP;');
      };
      b.customProgramCacheKey = () => 'crowdScan-dbgbasic';
      return b;
    }
    if (shade === 'lambert') {
      const b = new THREE.MeshLambertMaterial({ name: 'crowdScan:' + mode + ':' + S.key, map: M.map, normalMap: M.normalMap, aoMap: M.aoMap, aoMapIntensity: M.aoMap ? 0.85 : 1, side });
      b.onBeforeCompile = (sh) => { if (U) Object.assign(sh.uniforms, U); this.patch(sh, patchMode); };
      b.customProgramCacheKey = () => 'crowdScan-lam-' + patchMode + '-3';
      return b;
    }
    const m = new THREE.MeshStandardMaterial({
      name: 'crowdScan:' + mode + ':' + S.key, map: M.map, normalMap: M.normalMap, roughnessMap: M.roughnessMap, metalnessMap: M.metalnessMap,
      aoMap: M.aoMap, aoMapIntensity: M.aoMap ? 0.85 : 1, roughness: M.roughnessMap ? 1 : 0.8, metalness: M.metalnessMap ? 1 : 0,
      // a scan is a closed shell (seams.mjs): back faces only show through a hole, and at a crowd's density they
      // were half the rasterised triangles (measured 28 -> 38 fps). The pool body keeps both sides at arm's length.
      side, envMapIntensity: ENV_K,
    });
    m.onBeforeCompile = (sh) => { if (U) Object.assign(sh.uniforms, U); this.patch(sh, patchMode); };
    m.customProgramCacheKey = () => 'crowdScan-' + patchMode + '-3';
    return m;
  }

  depthMaterial(U) {
    const m = new THREE.MeshDepthMaterial();
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + VAT_DECL + 'attribute float aVat;\n' + vatGLSL(this.defs, this.FT))
        .replace('#include <begin_vertex>', 'vec3 vatP, vatN; vatSample(int(aVat + 0.5), vatP, vatN); vec3 transformed = vatP;');
    };
    m.customProgramCacheKey = () => 'crowdScan-depth-3';
    return m;
  }

  // ---------------------------------------------------------------------------------------------- mid + far tiers
  buildTiers() {
    const peds = this.crowd.peds;
    const per = new Int32Array(this.S.length);
    for (const p of peds) per[p.sk]++;
    this.U = [this.assemble(0), this.assemble(1)];
    const depth = [this.depthMaterial(this.U[0]), this.depthMaterial(this.U[1])];
    for (const S of this.S) {
      if (!S) continue;
      const cap = Math.max(4, per[S.i] + 4) + STATIC_CAP;
      S.tier = [0, 1].map((tier) => {
        const src = S.geo[tier], P = S.parts[tier], off = S['off' + tier];
        const g = new THREE.BufferGeometry();
        g.setIndex(new THREE.BufferAttribute(src.index.array.slice(0, src.index.count), 1));
        g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(src.attributes.position.array.subarray(0, src.attributes.position.count * 3)), 3));
        if (src.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(src.attributes.uv.array.subarray(0, src.attributes.uv.count * 2)), 2));
        const av = new Float32Array(P.nV);
        for (let v = 0; v < P.nV; v++) av[v] = off + P.remap[v];
        g.setAttribute('aVat', new THREE.BufferAttribute(av, 1));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.3);
        const at = (name, sz) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * sz), sz); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, a); return a; };
        const T = { aAnim: at('iAnim', 4), aAnim2: at('iAnim2', 4), aRim: at('aRim', 3), cap, list: new Int32Array(cap), n: 0, nNear: 0, b: cap, nShadow: 0 };
        const im = new THREE.InstancedMesh(g, this.scanMaterial(S, tier ? 'far' : 'mid', this.U[tier]), cap);
        im.name = 'crowdScan:' + (tier ? 'far:' : 'mid:') + S.key; im.frustumCulled = false; im.count = 0; im.visible = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = false; im.receiveShadow = true;
        im.customDepthMaterial = depth[tier];
        // the shadow pass draws only the instances inside SHADOW_D (packed first)
        im.onBeforeShadow = () => { im._sc = im.count; im.count = Math.min(im.count, T.nShadow); };
        im.onAfterShadow = () => { if (im._sc != null) { im.count = im._sc; im._sc = null; } };
        T.mesh = im;
        this.root.add(im);
        return T;
      });
    }
  }

  // ---------------------------------------------------------------------------------------------- the mirror
  // One vertex-pulled mesh: a corner row per scan (lod2 triangle corners -> VAT column + uv), the albedo from a
  // 256² array. Only weather.js's reflection camera draws it (count 0 for every other camera, the bloom mask
  // included); the pool bodies' own meshes stay off layer 1, their twins are mirrored here.
  async buildMirror() {
    const live = this.S.filter(Boolean), nS = this.S.length;
    let cMax = 0;
    for (const S of live) { const g = S.geo[1]; S.corners = g.index ? g.index.count : g.attributes.position.count; cMax = Math.max(cMax, S.corners); }
    const CW = Math.min(VAT_W, nS * cMax), CH = Math.ceil(nS * cMax / CW);
    const cor = new Float32Array(CW * CH * 4);
    for (const S of live) {
      const g = S.geo[1], ia = g.index ? g.index.array : null, uv = g.attributes.uv, P = S.parts[1], off = S.off1;
      for (let c = 0; c < S.corners; c++) {
        const v = ia ? ia[c] : c, o = (S.i * cMax + c) * 4;
        cor[o] = off + P.remap[v]; cor[o + 1] = uv ? uv.getX(v) : 0; cor[o + 2] = uv ? uv.getY(v) : 0;
      }
    }
    const tc = new THREE.DataTexture(cor, CW, CH, THREE.RGBAFormat, THREE.FloatType);
    tc.magFilter = tc.minFilter = THREE.NearestFilter; tc.generateMipmaps = false; tc.flipY = false; tc.needsUpdate = true;
    const alb = new Uint8Array(ALB_N * ALB_N * 4 * nS).fill(128);
    const cv = document.createElement('canvas'), cv2 = document.createElement('canvas');
    cv.width = cv.height = ALB_N; cv2.width = cv2.height = ALB_N * 2;
    const g = cv.getContext('2d', { willReadFrequently: true }), g2 = cv2.getContext('2d');
    g.imageSmoothingQuality = 'high'; g2.imageSmoothingQuality = 'high';
    for (const S of live) {
      if (!S.alb) continue;
      try {
        g2.clearRect(0, 0, ALB_N * 2, ALB_N * 2); g2.drawImage(S.alb, 0, 0, ALB_N * 2, ALB_N * 2);
        g.clearRect(0, 0, ALB_N, ALB_N); g.drawImage(cv2, 0, 0, ALB_N, ALB_N);
        alb.set(g.getImageData(0, 0, ALB_N, ALB_N).data, S.i * ALB_N * ALB_N * 4);
      } catch (e) { console.warn('[crowdScan] mirror albedo ' + S.key + ': ' + e.message); }
      S.alb = null;
      await this.breathe('mirror albedo');
    }
    const ta = new THREE.DataArrayTexture(alb, ALB_N, ALB_N, nS);
    ta.format = THREE.RGBAFormat; ta.type = THREE.UnsignedByteType; ta.colorSpace = THREE.SRGBColorSpace;
    ta.minFilter = THREE.LinearMipmapLinearFilter; ta.magFilter = THREE.LinearFilter; ta.generateMipmaps = true; ta.needsUpdate = true;
    this.stat.mirrorMB = (cor.length * 4 + alb.length * 1.333) / 1048576;
    const U = { ...this.U[1], uCorner: { value: tc }, uCornerW: { value: CW }, uCMax: { value: cMax }, uAlb: { value: ta } };
    const mat = SHADE.mirror === 'lambert' ? new THREE.MeshLambertMaterial({ name: 'crowdScan:mirror', side: THREE.FrontSide })
      : new THREE.MeshStandardMaterial({ name: 'crowdScan:mirror', roughness: 0.82, metalness: 0, side: THREE.FrontSide, envMapIntensity: ENV_K });
    mat.onBeforeCompile = (sh) => { Object.assign(sh.uniforms, U); this.patch(sh, 'mirror'); };
    mat.customProgramCacheKey = () => 'crowdScan-mirror-' + SHADE.mirror + '-3';
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cMax * 3), 3));
    gg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.3);
    const at = (nm, sz) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(REFL_N * sz), sz); a.setUsage(THREE.DynamicDrawUsage); gg.setAttribute(nm, a); return a; };
    const T = { aAnim: at('iAnim', 4), aAnim2: at('iAnim2', 4), aRim: at('aRim', 3) };
    const im = new THREE.InstancedMesh(gg, mat, REFL_N);
    im.name = 'crowdScan:mirror'; im.frustumCulled = false; im.count = 0; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = false; im.receiveShadow = false;
    im.layers.set(1);
    im.onBeforeRender = (r, sc, camera) => { im._n = im.count; if (camera.name !== 'reflectionCamera') im.count = 0; };
    im.onAfterRender = () => { if (im._n != null) { im.count = im._n; im._n = null; } };
    T.mesh = im;
    this.root.add(im);
    this.refl = T; this.cMax = cMax;
  }

  // ---------------------------------------------------------------------------------------------- ground decals
  buildDecals() {
    const cr = this.crowd, N = cr.count;
    const mk = (geo, mat, name) => {
      const im = new THREE.InstancedMesh(geo, mat, N);
      im.name = name; im.frustumCulled = false; im.count = 0; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = false; im.receiveShadow = false; im.renderOrder = 2;
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3); im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.root.add(im);
      return im;
    };
    this.blob = mk(cr.G.blob, cr.mats.blob, 'crowdScan:blob');
    this.pad = mk(cr.G.contact, cr.mats.contact, 'crowdScan:pad');
  }

  // ---------------------------------------------------------------------------------------------- the pool
  async buildPool(bodies) {
    const live = this.S.filter(Boolean);
    // three bodies per person at boot (a WALK wave brings two or three of the same person within a few metres of the
    // lens; a mid-play build is a ~30 ms hitch, and with up to 32 bound a 2-a-person pool grew by ~16 in one crossing),
    // the 4-scan prototype more
    // [mobile] ?scanPer=<n> overrides it (the mobile profile's 1: its pool binds at most 6, the rest are grown on demand)
    const per = SCAN_PER || Math.max(3, Math.ceil(10 / live.length));
    for (const S of live) {
      this.addBody(S, bodies[S.i]);
      await this.breathe('body');
      for (let k = 1; k < per; k++) { this.addBody(S, null); await this.breathe('body'); }
    }
  }

  addBody(S, h) {
    if (!h) h = HUM.createHumanoid({ variant: S.variant, seed: 101 + this.nBodies * 7, lod: true, getClip });
    this.nBodies++;
    h.frozenPose = true;
    try { h.mixer.stopAllAction(); } catch (e) { void e; }
    h.group.visible = false;
    h.group.name = 'crowdScan:body:' + S.key;
    const U = { uRim: { value: new THREE.Vector3() } };
    const mat = this.scanMaterial(S, 'pool', U), matFar = this.scanMaterial(S, 'poolFar', U);
    h.group.traverse((o) => {
      if (!o.isMesh) return;
      o.material = mat; o.castShadow = false; o.receiveShadow = true; o.layers.disable(1);
    });
    // The body's own ladder on the instanced tiers' lines: lod0 inside SWAP_D (14 m, where only the lock binds), its
    // lod1 to MID_D and its lod2 beyond, the lod2 rung in the far tier's material. A bind or unbind past 14 m (the
    // lock allows those in view) is then between the same rung in the same shading as the twin.
    if (h.lod && h.lod.levels && h.lod.levels.length >= 2) {
      const L = h.lod.levels.slice().sort((a, b2) => trisOf(b2.object) - trisOf(a.object));
      if (L[1]) L[1].distance = POOL_SWAP_D;
      if (L[2]) { L[2].distance = MID_D; L[2].object.material = matFar; }
      h.lod.levels.sort((a, b2) => a.distance - b2.distance);
    }
    if (h.lod) h.lod.layers.disable(1);
    // one action per baked clip (an alias shares its clip's action)
    const acts = this.defs.map((d) => {
      const a = h.mixer.clipAction(d.clip);
      a.setLoop(THREE.LoopRepeat, Infinity); a.enabled = true; a.setEffectiveTimeScale(1); a.setEffectiveWeight(0); a.play();
      return a;
    });
    const H = { h, ped: null, conf: S.key, key: S.key, det: 1, scan: S.i, mat, U, acts, base: h.group.scale.x || 1, acc: {}, lastUse: 0, boundAt: null, sc: true };
    this.engine.scene.add(h.group);
    this.crowd.heroes.push(H);
    return H;
  }

  // crowd.bindHeroes denied a key: grow the pool by one body of it (throttled; never a churn)
  growPool() {
    const cr = this.crowd, want = cr.poolWant;
    if (!want) return;
    cr.poolWant = null;
    const hs = cr.heroes, now = cr.tNow || 0;
    if (hs.length >= POOL_MAX || hs.some((H) => H.conf === want && !H.ped)) return;
    if (now - this.lastGrow < POOL_REBUILD_T) { cr.poolWant = want; return; }
    const S = this.S.find((q) => q && q.key === want);
    if (!S) return;
    this.lastGrow = now;
    const t0 = performance.now();
    try { this.addBody(S, null); this.poolBuilds++; } catch (e) { console.warn('[crowdScan] pool body ' + want + ': ' + e.message); }
    this.growMs = performance.now() - t0;
  }

  bindBody(H, p) { H.h.group.visible = true; this.poseBody(H, p, this.crowd.tNow || 0); }
  unbindBody(H) { H.h.group.visible = false; }

  // the pool body plays the twin's clips at the twin's phases: the pose its VAT shows (humanoid.update's wrist clamp
  // runs after this on a frozen, visible body; the bake ran the same clamp on every frame)
  poseBody(H, p, t) {
    const g = H.h.group;
    g.position.set(p.x, p.gy, p.z);
    g.rotation.set(0, p.yaw, 0);
    g.scale.setScalar(H.base * (p._si || 1));
    const idA = p._run && this.hasRun ? 2 : 0, [idB, wB, phB] = this.clipB(p, t);
    const acts = H.acts, dA = this.defs[idA], dB = this.defs[idB];
    for (const a of acts) a.setEffectiveWeight(0);
    const aA = acts[idA], aB = acts[idB];
    aA.time = (p._ap || 0) * dA.dur;
    if (aB === aA) aA.setEffectiveWeight(1);                     // brisk: the walk clip itself, its tuning blended below
    else { aB.time = phB * dB.dur; aA.setEffectiveWeight(1 - wB); aB.setEffectiveWeight(wB); }
    H.h.mixer.update(0);
    // the bake's per-clip tuning, blended by the clips' weights (exact on a pure walk or a pure idle)
    const tA = TUNE[idA], tB = TUNE[idB], S = this.S[H.scan];
    _tune.legs = (tA ? tA.legs : 0) * (1 - wB) + (tB ? tB.legs : 0) * wB;
    const thA = tA ? (tA.thigh != null ? tA.thigh : tA.legs) : 0, thB = tB ? (tB.thigh != null ? tB.thigh : tB.legs) : 0;
    const hpA = tA ? (tA.hip != null ? tA.hip : tA.legs) : 0, hpB = tB ? (tB.hip != null ? tB.hip : tB.legs) : 0;
    _tune.thigh = thA * (1 - wB) + thB * wB; _tune.hip = hpA * (1 - wB) + hpB * wB;
    _tune.arms = (tA ? tA.arms : 0) * (1 - wB) + (tB ? tB.arms : 0) * wB;
    _tune.spine = (tA ? tA.spine : 0) * (1 - wB) + (tB ? tB.spine : 0) * wB;
    tunePose(H.h, S.bind, _tune, 1);
    // the bake's pelvis lift (liftLegs), by the walk / brisk share of the pose; the pool body is at H.base x _si of the
    // bake's size
    if (S.lift && idA === 0) { const lf = (S.lift[0] || 0) * (1 - wB) + (idB === 4 ? (S.lift[4] || 0) : 0) * wB; if (lf > 1e-4) liftLegs(H.h, lf * (p._si || 1) * (H.base || 1) / (S.bakeScale || 1)); }
    const r = p._rim, d2 = (p.x - this.camX) ** 2 + (p.z - this.camZ) ** 2;
    if (r && d2 > 9) H.U.uRim.value.set(r[0], r[1], r[2]); else H.U.uRim.value.set(0, 0, 0);
  }

  idlePhase(p, t, id) { const d = id === 3 ? this.lookDur : this.idleDur; return ((t / d + p._ip) % 1 + 1) % 1; }

  // ---------------------------------------------------------------------------------------------- per frame
  // animation state: metres travelled / stride for the locomotion clip, a ~0.2 s blend into and out of the idle
  // 2026-09-26 (「足を高速にバタバタ」): the gait no longer reads displacement. It advances by the distance the person
  // WALKED this frame (crowd.js settle: their own steps plus any push hard enough to be a step aside -- never the
  // separation jitter a standing crowd trades), and the stride is chosen for the pace from human gait (STEP_L, scaled by
  // height): shorter than the walk clip's own stride by blending toward the idle, longer by blending toward 'brisk'.
  // The cadence that follows is held to CAD_WALK / CAD_RUN steps a second.
  animate(p, dt) {
    let dist;
    if (p.stage === true) dist = (p.vel || p.speed || 1.2) * dt;           // a preset's treadmill walker
    else if (p._wdF !== undefined) dist = p._wdF === this.crowd.frame ? (p._wd || 0) : 0;
    else { dist = Math.hypot(p.x - p._rx, p.z - p._rz); if (dist > 2.0) dist = 0; }
    p._rx = p.x; p._rz = p.z;
    const v = dt > 1e-5 ? dist / dt : 0;
    // the pace the stride is chosen for: quick to rise (a lagging estimate picked a short stride for someone speeding up
    // off the kerb -- 2.3 steps/s at 0.6 m/s), slower to fall (the last steps into a stop are the long ones)
    p._sv = v > p._sv ? v : p._sv + (v - p._sv) * Math.min(1, dt * 8);   // (the distance a frame is smooth: crowd.js carry())
    const S = this.S[p.sk], si = p._si || 1, sv = p._sv;
    const run = p._run = this.hasRun && sv > (p._run ? RUN_OFF : RUN_ON);
    let stride, cB, wB;
    if (run) {
      const c = clamp(2.6 + 0.15 * (sv - 3), 2.6, 3.2), Sr = S.strideRun * si, amp = clamp(2 * sv / c / Sr, 0.55, 1);
      stride = Sr * amp; cB = 1; wB = 1 - amp;
    } else {
      const Sw = S.stride * si, Sb = (S.strideBrisk || S.stride) * si, want = 2 * stepLenAt(sv) * (p._shK || 1);   // (a step grows slower than stature)
      let ctl = want <= Sw ? want / Sw : this.hasBrisk && Sb > Sw + 0.02 ? 1 + clamp((want - Sw) / (Sb - Sw), 0, 1) : 1;
      // someone covering ground at >= 0.3 m/s is visibly stepping (a long-stride scan at a slow pace sat at ~0.2 of
      // its walk, near the standing pose, and read as a slide)
      if (sv > 0.1 && ctl < 0.45) ctl = Math.max(ctl, Math.min(0.45, sv * 2));
      if (p.stage === 2) ctl = 0;
      p._ctl = p._ctl == null || ctl > p._ctl ? ctl : p._ctl + (ctl - p._ctl) * Math.min(1, dt * 20);  // (the sim's pace itself is eased: accel())
      const k = p._ctl;
      if (k <= 1) { stride = Sw * Math.max(k, 0.25); cB = p.gawk && this.hasLook ? 3 : 1; wB = 1 - k; }
      else { stride = Sw + (Sb - Sw) * (k - 1); cB = 4; wB = k - 1; }
    }
    let dph = dist / Math.max(0.05, stride);
    const cap = (run ? CAD_RUN : CAD_WALK) / 2 * dt;             // cycles (two steps) this frame at most
    if (dph > cap) dph = cap;
    p._ap = (p._ap + dph) % 1;
    p._cB = cB; p._wB = wB < 0.002 ? 0 : wB > 0.998 ? 1 : wB;
    p._aw = run ? 1 : Math.min(1, p._ctl);
  }

  // the standing / second clip of an instance: its id, weight and phase (the statics carry none of the gait state)
  clipB(p, t) {
    if (p._cB == null) { const id = p.gawk && this.hasLook ? 3 : 1; return [id, 1 - (p._aw || 0), p._frz != null ? p._frz : this.idlePhase(p, t, id)]; }
    const id = p._cB;
    return [id, p._wB, id === 4 ? p._ap : p._frz != null ? p._frz : this.idlePhase(p, t, id)];
  }

  writeInst(T, k, p, t, S, d2) {
    const mi = T.mesh.instanceMatrix.array, o = k * 16, s = p._si || 1, c = Math.cos(p.yaw) * s, sn = Math.sin(p.yaw) * s;
    mi[o] = c; mi[o + 1] = 0; mi[o + 2] = -sn; mi[o + 3] = 0;
    mi[o + 4] = 0; mi[o + 5] = s; mi[o + 6] = 0; mi[o + 7] = 0;
    mi[o + 8] = sn; mi[o + 9] = 0; mi[o + 10] = c; mi[o + 11] = 0;
    mi[o + 12] = p.x; mi[o + 13] = p.gy; mi[o + 14] = p.z; mi[o + 15] = 1;
    const idA = p._run && this.hasRun ? 2 : 0, [idB, wB, phB] = this.clipB(p, t);
    const a = T.aAnim.array, a2 = T.aAnim2.array, r = T.aRim.array, o4 = k * 4, o3 = k * 3;
    a[o4] = idA; a[o4 + 1] = p._ap; a[o4 + 2] = idB; a[o4 + 3] = phB;   // (_frz: a posed static held still, a shop-window mannequin)
    a2[o4] = wB; a2[o4 + 1] = p.hero ? 1 : p.fade; a2[o4 + 2] = S.i; a2[o4 + 3] = S.corners || 0;
    const pr = p._rim;
    // the rim is an edge seen from a distance (the shader starts it at 3 m)
    if (pr && d2 > 9) { r[o3] = pr[0]; r[o3 + 1] = pr[1]; r[o3 + 2] = pr[2]; } else { r[o3] = 0; r[o3 + 1] = 0; r[o3 + 2] = 0; }
  }

  flush(T, n) {
    const up = (a, sz) => { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * sz); a.needsUpdate = true; };
    T.mesh.count = n;
    if (!n) return;
    up(T.mesh.instanceMatrix, 16); up(T.aAnim, 4); up(T.aAnim2, 4); up(T.aRim, 3);
  }

  // the street's own sky / ground fill for the scans: a night street is lit from the signs, not the sky
  fill(night) {
    const k = night, d = 1 - night;
    this.fillU.uFillSky.value.set(0.55 * k + 0.10 * d, 0.52 * k + 0.10 * d, 0.70 * k + 0.12 * d);
    this.fillU.uFillGnd.value.set(0.34 * k + 0.05 * d, 0.26 * k + 0.05 * d, 0.30 * k + 0.05 * d);
  }

  // crowd.update (the simulation's frame): the pool bodies are posed here, before humanoid.update clamps their wrists
  update(dt, t) {
    if (!this.ready) return;
    const T0 = performance.now();
    this.dt = dt; this.t = t;
    this.posePool(dt, t);
    this.stat.poolMs = performance.now() - T0;
  }

  // The instances are culled and packed at RENDER time (scene.onBeforeRender, the main camera, once a frame): the camera
  // module moves the lens after crowd.update, so a pack in update culled every frame against last frame's lens -- and
  // on a camera cut the first frame of the new shot was missing everybody the old one could not see. A cut pending
  // from the camera module is resorted and bound here too, on the cut's own frame (crowd-pop counted binds two
  // frames late as on-screen swaps).
  hook() {
    const scene = this.engine.scene, prev = scene.onBeforeRender;
    scene.onBeforeRender = (r, sc, cam, ...rest) => {
      if (cam === this.engine.camera && this.ready && this._packF !== this.crowd.frame) {
        this._packF = this.crowd.frame;
        try {
          const T0 = performance.now();
          const cr = this.crowd;
          // a cut is whatever the frame shows as one: the lens jumped over 4 m or turned over 40 degrees since the last
          // rendered frame (camera.js emits camera:cut a frame BEFORE the follow lens lands, so the event alone freed
          // the pool one view early and the step's own jump test one frame late)
          cam.updateMatrixWorld();
          cam.getWorldDirection(_v);
          const L = this._lens || (this._lens = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, on: false });
          const jump = L.on && (Math.hypot(cam.position.x - L.x, cam.position.y - L.y, cam.position.z - L.z) > 4 || _v.x * L.fx + _v.y * L.fy + _v.z * L.fz < 0.75);
          L.x = cam.position.x; L.y = cam.position.y; L.z = cam.position.z; L.fx = _v.x; L.fy = _v.y; L.fz = _v.z; L.on = true;
          if (jump) {
            cr.cutNow = false;
            cr.camPX = cam.position.x; cr.camPZ = cam.position.z; cr.camVX = 0; cr.camVZ = 0;
            cr.cutFree = 1; cr.resort(); cr.bindNow = false;
            this.cuts = (this.cuts || 0) + 1;
            cr.cutF = cr.frame;
          }
          // a fight's arena holds 健人 and the men he fights: clamped here, after every module has moved them this frame
          if (cr.clampArena) cr.clampArena(this.dt || 1 / 60);
          // whatever moved a pedestrian after the crowd's step (missions updates after it) is judged before it is drawn
          if (cr.guardExternal) cr.guardExternal();
          this.pack(this.dt || 1 / 60, this.t != null ? this.t : 0);
          const ms = performance.now() - T0 + (this.stat.poolMs || 0);
          this.stat.ms = this.stat.ms == null ? ms : this.stat.ms + (ms - this.stat.ms) * 0.05;
        } catch (e) { if (!this._packErr) { this._packErr = true; console.error('[crowdScan] pack', e); } }
      }
      if (typeof prev === 'function') prev.call(sc, r, sc, cam, ...rest);
    };
  }

  posePool(dt, t) {
    const cr = this.crowd, cam = this.engine.camera, cx = cam.position.x, cz = cam.position.z;
    const day = nightK(this.engine.time.hour) < 0.9, sh2 = SHADOW_D * SHADOW_D;
    this.camX = cx; this.camZ = cz;
    let pool = 0, c1 = null, c2 = null, d1 = sh2, dd2 = sh2;
    const hs = cr.heroes;
    for (let k = 0; k < hs.length; k++) {
      const H = hs[k], p = H.ped;
      if (!H.sc) continue;
      H.h.skinned.castShadow = false;
      if (!p) continue;
      if (p.dfade < 0.9) { cr.unbind(H, Math.hypot(p.x - cx, p.z - cz)); continue; }
      this.animate(p, dt); p._animF = cr.frame;
      this.poseBody(H, p, t);
      pool++;
      if (day) { const e = (p.x - cx) ** 2 + (p.z - cz) ** 2; if (e < d1) { dd2 = d1; c2 = c1; d1 = e; c1 = H; } else if (e < dd2) { dd2 = e; c2 = H; } }
    }
    if (c1) c1.h.skinned.castShadow = true;
    if (c2) c2.h.skinned.castShadow = true;
    this.stat.pool = pool;
  }

  pack(dt, t) {
    const cr = this.crowd, eng = this.engine, peds = cr.peds, N = cr.count, cam = eng.camera, world = eng.world;
    cam.updateMatrixWorld();
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_pm);
    const cx = cam.position.x, cz = cam.position.z, frame = cr.frame;
    this.camX = cx; this.camZ = cz;
    const night = nightK(eng.time.hour), day = night < 0.9;
    this.fill(night);
    const cull2 = CULL_D * CULL_D, mid2 = MID_D * MID_D, sh2 = SHADOW_D * SHADOW_D;
    const S = this.S;
    for (const Q of S) if (Q) { const A = Q.tier[0], B = Q.tier[1]; A.n = 0; A.nNear = 0; A.b = A.cap; B.n = 0; B.nNear = 0; B.b = B.cap; }
    let nDec = 0, nPad = 0;
    const shade = Math.max(0.50, 0.78 - 0.22 * night), wet = eng.time.wet || 0, nb = cr.nightBlob || 0;
    const bm = this.blob.instanceMatrix.array, bc = this.blob.instanceColor.array, pm = this.pad.instanceMatrix.array, pc = this.pad.instanceColor.array;
    for (let i = 0; i < N; i++) {
      const p = peds[i];
      const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
      if (d2 > cull2) { p._seen = false; continue; }
      // the ground under them (道玄坂's slope): inside 20 m every frame, beyond on a rolling quarter
      if (world && (d2 < 400 || (i & 3) === (frame & 3) || p.gyT == null)) p.gyT = world.groundHeight(p.x, p.z);
      if (p.gyT != null) { if (Math.abs(p.gyT - p.gy) > 0.35) p.gy = p.gyT; p.gy += (p.gyT - p.gy) * Math.min(1, dt * 12); }
      const hgt = p._sh || 1.7;
      _sph.center.set(p.x, p.gy + 0.5 * hgt, p.z); _sph.radius = 0.62 * hgt;
      const vis = p._seen = _fr.intersectsSphere(_sph);
      if (!vis) continue;
      if (p._animF !== frame) { this.animate(p, dt); p._animF = frame; }
      const fade = p.hero ? 1 : p.fade;
      if (fade <= 0.004) continue;
      const Q = S[p.sk];
      if (!p.hero) {
        const T = Q.tier[d2 < mid2 ? 0 : 1];
        if (d2 < sh2) T.list[T.nNear++] = i; else T.list[--T.b] = i;
      }
      // ground contact: a soft blob (leaned from the sun by day, a footprint under the planted foot at night) and,
      // inside FAR2_D, the hard pad under the planted foot (the baked foot table at the clip's phase)
      const yaw = p.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), si = p._si || 1;
      const ft = Q.feet, moving = (p._aw || 0) > 0.5, def = this.defs[moving ? (p._run && this.hasRun ? 2 : 0) : (p.gawk && this.hasLook ? 3 : 1)];
      const ph = moving ? p._ap : this.idlePhase(p, t, def.id), fi = (def.base + Math.min(def.F - 1, Math.floor(ph * def.F))) * 4;
      const lx = ft[fi] * si, lz = ft[fi + 1] * si;
      const pfx = p.x + lx * fz + lz * fx, pfz = p.z - lx * fx + lz * fz;
      const gsc = p.scale * fade;
      const bs = gsc * (moving ? 0.93 : p.inLight ? 0.64 : 1.0);
      {
        const ang = nb > 0.5 ? yaw : (cr.sunYaw || 0), c = Math.cos(ang), s = Math.sin(ang);
        const sx = bs * (0.30 - 0.12 * nb), sz = bs * (0.475 * (cr.sunLen || 1) - 0.195 * nb);
        const o = nDec * 16;
        bm[o] = c * sx; bm[o + 1] = 0; bm[o + 2] = -s * sx; bm[o + 3] = 0; bm[o + 4] = 0; bm[o + 5] = 1; bm[o + 6] = 0; bm[o + 7] = 0;
        bm[o + 8] = s * sz; bm[o + 9] = 0; bm[o + 10] = c * sz; bm[o + 11] = 0;
        bm[o + 12] = p.x + (cr.sunOX || 0) * bs + (pfx - p.x) * nb; bm[o + 13] = p.gy + 0.02; bm[o + 14] = p.z + (cr.sunOZ || 0) * bs + (pfz - p.z) * nb; bm[o + 15] = 1;
        const gg = 1 - shade * (p.blobK || 1) * (p.inLight && !moving ? 0.55 : 1);
        bc[nDec * 3] = gg; bc[nDec * 3 + 1] = gg; bc[nDec * 3 + 2] = gg * 1.02;
        nDec++;
      }
      if (d2 < FAR2_D * FAR2_D) {
        const lift = clamp(1 - (ft[fi + 2] - 0.095) * si * 9, 0, 1), sc = gsc * lift;
        const c = Math.cos(yaw), s = Math.sin(yaw), o = nPad * 16;
        pm[o] = c * sc; pm[o + 1] = 0; pm[o + 2] = -s * sc; pm[o + 3] = 0; pm[o + 4] = 0; pm[o + 5] = 1; pm[o + 6] = 0; pm[o + 7] = 0;
        pm[o + 8] = s * sc * 1.4; pm[o + 9] = 0; pm[o + 10] = c * sc * 1.4; pm[o + 11] = 0;
        pm[o + 12] = pfx + fx * 0.05 * gsc; pm[o + 13] = p.gy + 0.012; pm[o + 14] = pfz + fz * 0.05 * gsc; pm[o + 15] = 1;
        const hc = 1 - (0.78 - 0.26 * wet) * (p.blobK || 1);
        pc[nPad * 3] = hc; pc[nPad * 3 + 1] = hc; pc[nPad * 3 + 2] = hc * 1.02;
        nPad++;
      }
    }
    // per scan and tier, the shadow-distance ones first (the shadow pass draws only those), the statics last
    const stat = this.statics && this.statics.length ? this.packStatics(_fr, cx, cz, mid2) : null;
    let draws = 0, midN = 0, midT = 0, farN = 0, farT = 0;
    for (const Q of S) {
      if (!Q) continue;
      const stQ = stat && stat.get(Q.i);
      for (let tier = 0; tier < 2; tier++) {
        const T = Q.tier[tier];
        let k = 0;
        for (let j = 0; j < T.nNear; j++) this.writeInst(T, k++, peds[T.list[j]], t, Q, 1e9);
        for (let j = T.cap - 1; j >= T.b; j--) { const p = peds[T.list[j]]; this.writeInst(T, k++, p, t, Q, (p.x - cx) ** 2 + (p.z - cz) ** 2); }
        if (stQ) for (const p of stQ[tier]) { if (k >= T.cap) break; this.writeInst(T, k++, p, t, Q, 1e9); }
        T.n = k; T.nShadow = day ? T.nNear : 0;
        this.flush(T, k);
        T.mesh.visible = k > 0 && !SCAN_DBG.includes(tier ? 'nofar' : 'nomid');
        T.mesh.castShadow = day && T.nNear > 0;
        if (k) { draws++; if (tier) { farN += k; farT += k * Q.tri2; } else { midN += k; midT += k * Q.tri1; } }
      }
    }
    // the mirror: the nearest REFL_N from the last resort (pool-bound ones included: their bodies stay off layer 1)
    const refl = this.refl;
    let nR = 0;
    if (wet > 0.05 || eng.time.weather === 'rain') {
      const order = cr.order, nVis = Math.min(cr.visible || 0, 160);
      for (let s = 0; s < nVis && nR < REFL_N; s++) {
        const p = peds[order[s]];
        if (!p._seen || (p.hero ? 1 : p.fade) <= 0.05) continue;
        this.writeInst(refl, nR++, p, t, S[p.sk], 1e9);
      }
    }
    this.flush(refl, nR);
    refl.mesh.visible = nR > 0 && !SCAN_DBG.includes('norefl');
    this.blob.count = nDec; this.pad.count = nPad;
    for (const [im, n] of [[this.blob, nDec], [this.pad, nPad]]) {
      im.visible = n > 0 && !SCAN_DBG.includes('nodecal');
      if (!n) continue;
      im.instanceMatrix.clearUpdateRanges(); im.instanceMatrix.addUpdateRange(0, n * 16); im.instanceMatrix.needsUpdate = true;
      im.instanceColor.clearUpdateRanges(); im.instanceColor.addUpdateRange(0, n * 3); im.instanceColor.needsUpdate = true;
    }
    if (nDec) draws++;
    if (nPad) draws++;
    let poolD = 0;
    for (const H of cr.heroes) if (H.sc && H.ped && H.ped._seen) poolD++;
    const st = this.stat;
    st.mid = midN; st.far = farN; st.midTris = midT; st.farTris = farT; st.poolSeen = poolD; st.refl = nR;
    st.draws = draws + poolD;
  }

  // ---- statics: posed people outside the crowd simulation (the shop interiors, city interiors.js). Each entry
  //      { key (scan key), x, y (floor), z, yaw, clip: 'idle' | 'look', phase 0..1, freeze? }; they are drawn in the scans' own
  //      instanced tiers (STATIC_CAP reserved per scan and tier), culled and tiered like the crowd, no shadow / mirror.
  setStatics(list) {
    // the tiers that carry posed people draw before the city: the shop interiors' depth punch (interiors.js) is written
    // between the rooms and the city and would otherwise hide the people standing behind a window
    if (!this._stOrder && this.root) { this._stOrder = true; this.root.traverse((o) => { if (o.isInstancedMesh && /^crowdScan:(mid|far):/.test(o.name)) o.renderOrder = -2; }); }
    this.statics = [];
    if (!this.keyIdx) { this.keyIdx = new Map(); this.S.forEach((Q, i) => { if (Q) this.keyIdx.set(Q.key, i); }); }
    // returns the posed objects aligned with `list` (null where the scan is not baked): the caller drives p.fade
    // (0..1, the crowd's own dithered fade) to cross-fade people in and out
    const out = [];
    for (const e of list || []) {
      const i = this.keyIdx.get(e.key); if (i == null) { out.push(null); continue; }
      const Q = this.S[i];
      const p = { x: e.x, z: e.z, gy: e.y || 0, yaw: e.yaw || 0, _si: Q.height / Q.bakeH, _run: false, gawk: e.clip === 'look', _ap: 0, _aw: 0, _ip: e.phase || 0, _frz: e.freeze ? (e.phase || 0) : null, hero: false, fade: e.fade ?? 1, _rim: null };
      this.statics.push({ sk: i, p }); out.push(p);
    }
    return out;
  }
  packStatics(frustum, cx, cz, mid2) {
    const out = this._stat || (this._stat = new Map());
    for (const v of out.values()) { v[0].length = 0; v[1].length = 0; }
    for (const s of this.statics || []) {
      const p = s.p, d2 = (p.x - cx) ** 2 + (p.z - cz) ** 2;
      if (d2 > 80 * 80 || p.fade <= 0.004) continue;
      _sph.center.set(p.x, p.gy + 0.85, p.z); _sph.radius = 1.1;
      if (!frustum.intersectsSphere(_sph)) continue;
      let v = out.get(s.sk); if (!v) out.set(s.sk, v = [[], []]);
      v[d2 < Math.min(mid2, STATIC_MID2) ? 0 : 1].push(p);                          // behind glass: the far tier past 12 m
    }
    return out;
  }

  report() {
    const st = this.stat;
    return { kind: this.src.kind, scans: this.S.filter(Boolean).length, bakeMs: Math.round(st.bakeMs), maxSliceMs: Math.round(this.maxSlice),
      vatMB: +(st.vatMid + st.vatFar).toFixed(1), mirrorMB: +st.mirrorMB.toFixed(1), mid: st.mid, far: st.far, pool: st.pool, poolSeen: st.poolSeen, refl: st.refl,
      midTris: st.midTris, farTris: st.farTris, draws: st.draws, cpuMs: +(st.ms || 0).toFixed(2), shade: SHADE, poolBodies: this.crowd.heroes.length, poolBuilds: this.poolBuilds, midD: MID_D };
  }
}

// Pedestrian tuning of the shared clips, per clip id: each group of bones is slerped this far back toward the scan's
// OWN bind pose -- a natural scanned stance, arms down. The walk is the hero's 2.4 m/s stride (a lunge at a
// pedestrian's 1.3 m/s) and the idle his yakuza stand (feet wide, chest out, arms held off the ribs); pulled toward
// the person's own stance they read as a passer-by walking and waiting. The Hips position follows the legs, so the
// feet stay on the ground. The pool body runs the same function after its mixer (poseBody), the bake before skinning.
const TUNE = [
  { legs: 0.24, arms: 0.30, spine: 0.30 },          // walk
  { legs: 0.50, arms: 0.55, spine: 0.35 },          // idle
  null,                                             // run
  { legs: 0.50, arms: 0.55, spine: 0.35 },          // look
  // brisk: a human's longer step at 1.3-1.6 m/s (0.65-0.75 m) -- the thighs swing past the clip's own arc, the knees and
  // feet keep the walk's easing (all of the leg past it was a lunge: deep knees, a crouch)
  { legs: 0.10, thigh: -0.25, hip: 0.10, arms: 0.18, spine: 0.22 },
];
const TUNE_LEGS = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
const TUNE_ARMS = ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'];
const TUNE_SPINE = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head'];
const TUNE_THIGH = ['LeftUpLeg', 'RightUpLeg'], TUNE_SHIN = ['LeftLeg', 'LeftFoot', 'RightLeg', 'RightFoot'];
const _tune = { legs: 0, thigh: 0, hip: 0, arms: 0, spine: 0 };
const _kA = new THREE.Vector3(), _kB = new THREE.Vector3(), _kC = new THREE.Vector3();
// The walk clip is the hero's (deep knees): at a pedestrian's pace its stance knee sat at 24-34 deg at mid-stance on the
// walk rows and 38-49 on 'brisk' -- a crouch (2026-09-26, the client's review: 「歩く時に膝が曲がりすぎ」; a person's is
// ~15-20). liftLegs raises the pelvis by `lift` (metres, world) and solves each leg (two bones, in its own bending
// plane) back onto the ankle the clip put down, the foot keeping its world orientation: the stance knee straightens,
// the feet do not move, the stride is the clip's. The lift per scan and clip is measured at the bake (KNEE_STANCE).
const KNEE_STANCE = 18;
const _lA = new THREE.Vector3(), _lK = new THREE.Vector3(), _lC = new THREE.Vector3(), _lT = [new THREE.Vector3(), new THREE.Vector3()];
const _lU = new THREE.Vector3(), _lV = new THREE.Vector3(), _lN = new THREE.Vector3(), _lUp = new THREE.Vector3(), _lS = new THREE.Vector3();
const _lq = new THREE.Quaternion(), _lqP = new THREE.Quaternion(), _lqW = new THREE.Quaternion(), _lF = [new THREE.Quaternion(), new THREE.Quaternion()];
function liftLegs(h, lift) {
  if (!(lift > 1e-4)) return;
  const B = h.bones, H = B.Hips; if (!H || !H.parent) return;
  H.parent.updateWorldMatrix(true, false); H.updateMatrixWorld(true);
  const sides = ['Left', 'Right'];
  for (let i = 0; i < 2; i++) { const F = B[sides[i] + 'Foot']; if (!F) return; _lT[i].setFromMatrixPosition(F.matrixWorld); F.getWorldQuaternion(_lF[i]); }
  // as much of the lift as leaves both ankles within reach (98.5 % of the leg): the pelvis rides highest at mid-stance and
  // dips at double support, as a walker's does, and the feet stay on the clip's marks (the stride is unchanged)
  for (let i = 0; i < 2; i++) {
    const U = B[sides[i] + 'UpLeg'], K = B[sides[i] + 'Leg'], F = B[sides[i] + 'Foot'];
    _lA.setFromMatrixPosition(U.matrixWorld); _lK.setFromMatrixPosition(K.matrixWorld); _lC.setFromMatrixPosition(F.matrixWorld);
    const R = 0.985 * (_lA.distanceTo(_lK) + _lK.distanceTo(_lC)), wx = _lA.x - _lT[i].x, wy = _lA.y - _lT[i].y, wz = _lA.z - _lT[i].z;
    const disc = wy * wy - (wx * wx + wy * wy + wz * wz) + R * R;
    lift = Math.min(lift, disc > 0 ? Math.max(0, -wy + Math.sqrt(disc)) : 0);
  }
  if (!(lift > 1e-4)) return;
  // up, in the pelvis's parent frame
  H.parent.getWorldQuaternion(_lqP); H.parent.getWorldScale(_lS);
  _lUp.set(0, 1, 0).applyQuaternion(_lqP.invert()).divide(_lS);
  H.position.addScaledVector(_lUp, lift); H.updateMatrixWorld(true);
  for (let i = 0; i < 2; i++) {
    const U = B[sides[i] + 'UpLeg'], K = B[sides[i] + 'Leg'], F = B[sides[i] + 'Foot'];
    if (!U || !K) continue;
    _lA.setFromMatrixPosition(U.matrixWorld); _lK.setFromMatrixPosition(K.matrixWorld); _lC.setFromMatrixPosition(F.matrixWorld);
    const a = _lA.distanceTo(_lK), b = _lK.distanceTo(_lC), d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, _lA.distanceTo(_lT[i])));
    _lU.subVectors(_lA, _lK); _lV.subVectors(_lC, _lK); _lN.crossVectors(_lU, _lV);
    if (_lN.lengthSq() < 1e-10) continue;
    _lN.normalize();
    const cur = _lU.angleTo(_lV), des = Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b))));
    // the knee: turned about its plane's normal to the interior angle that puts the ankle at distance d from the hip
    _lq.setFromAxisAngle(_lN, des - cur); K.getWorldQuaternion(_lqW); _lqW.premultiply(_lq);
    U.getWorldQuaternion(_lqP); K.quaternion.copy(_lqP.invert().multiply(_lqW)); K.updateMatrixWorld(true);
    // the thigh: swung so the ankle lands on its target
    _lC.setFromMatrixPosition(F.matrixWorld);
    _lU.subVectors(_lC, _lA).normalize(); _lV.subVectors(_lT[i], _lA).normalize();
    _lq.setFromUnitVectors(_lU, _lV); U.getWorldQuaternion(_lqW); _lqW.premultiply(_lq);
    H.getWorldQuaternion(_lqP); U.quaternion.copy(_lqP.invert().multiply(_lqW)); U.updateMatrixWorld(true);
    // the foot keeps its world orientation (the sole stays as the clip set it)
    K.getWorldQuaternion(_lqP); F.quaternion.copy(_lqP.invert().multiply(_lF[i])); F.updateMatrixWorld(true);
  }
}
// the pelvis lift that brings a stance knee flexed phi (deg) to KNEE_STANCE, for thigh a and shin b (metres)
function kneeLift(a, b, phi) {
  const D = (f) => Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(f * Math.PI / 180));
  return Math.max(0, Math.min(0.08 * (a + b), D(KNEE_STANCE) - D(phi)));
}
function tunePose(h, bind, T, k) {
  if (h.gait && HUM.gaitPose) HUM.gaitPose(h);   // [pedscan] per-scan gait (PED_SCANS[].gait: shorter steps for a robe)
  if (!T || !bind) return;
  const B = h.bones, q = bind.q;
  // (thigh / hip default to legs; a negative share swings past the clip, away from the stance)
  const th = T.thigh != null ? T.thigh : T.legs, hp = T.hip != null ? T.hip : T.legs;
  if (th) for (const n of TUNE_THIGH) if (B[n] && q[n]) B[n].quaternion.slerp(q[n], th * k);
  if (T.legs) for (const n of TUNE_SHIN) if (B[n] && q[n]) B[n].quaternion.slerp(q[n], T.legs * k);
  if (hp) B.Hips.position.lerp(bind.hip, hp * k);
  if (T.arms > 0) for (const n of TUNE_ARMS) if (B[n] && q[n]) B[n].quaternion.slerp(q[n], T.arms * k);
  if (T.spine > 0) for (const n of TUNE_SPINE) if (B[n] && q[n]) B[n].quaternion.slerp(q[n], T.spine * k);
}

// humanoid.js's wrist clamp (clampHands, not exported), run on every baked frame so the VAT and a frozen pool body
// (which humanoid.update clamps the same way) show the same hand: swing off the bind relation held within 0.61 rad
const HAND_MAX = 0.61;
function clampHandsLike(h) {
  const B = h.handBind; if (!B) return;
  for (const side of ['Left', 'Right']) {
    const b = h.bones[side + 'Hand']; if (!b || !B[side]) continue;
    _qR.copy(B[side]).invert().multiply(b.quaternion);
    _qT.set(0, _qR.y, 0, _qR.w); const tl = Math.hypot(_qT.y, _qT.w);
    if (tl < 1e-6) continue;
    _qT.y /= tl; _qT.w /= tl;
    _qR.multiply(_qI.copy(_qT).invert());
    const ang = 2 * Math.acos(Math.min(1, Math.abs(_qR.w)));
    if (ang <= HAND_MAX) continue;
    _qR.slerp(_qI.identity(), 1 - HAND_MAX / ang);
    b.quaternion.copy(B[side]).multiply(_qR).multiply(_qT);
  }
}
