import {nearKoji} from '../kojiData.js';
// [city] Streets from cityData: asphalt ground, raised sidewalks (0.15 m) cut by a signed-distance field of every
// carriageway (junction fills come for free), granite kerbs, tactile strips, lane paint (centre / edge / dividers,
// stop lines, arrows), zebra crossings incl. the two diagonal scrambles, manholes, medians, pedestrian-street paving
// and plaza paving. Everything is merged into a handful of meshes via GeoBatch; kerb heights are registered as
// physics ground patches so characters walk at sidewalk level.
import * as THREE from 'three';
import * as L from './lib.js';

export const SW_H = 0.15;   // sidewalk height
const KERB_W = 0.22;        // granite kerb top width
// The SDF grid: a 900 m square at 1 m (pass 15). Its north-west corner is (−600, −300): the old ±300 m square (same
// cell lines, so the square's streets come out as before) plus the 道玄坂 corridor to the west / south-west. Only the
// cells inside the square or the corridor outline (field.live) get pavement, kerbs and tactile / gutter lines.
const GRID_R = 625;         // half the grid's side (m)
const GRID_X0 = -850, GRID_Z0 = -400;
const STEP = 1;             // grid resolution (m)
const DECAL_Y = 0.012;      // road decals
const SW_DECAL_Y = SW_H + 0.006;

let mats = null;
export const groundMaterials = [];   // [{mat, dry, wet}] for the wet factor (local set + the library plaza / paver variants)
// manhole lid and drain grate are flat textured decals (a 20-tri disc, a 2-tri quad) flush with the surface
const MANHOLE_GEO = (() => { const g = new THREE.CircleGeometry(0.32, 20); g.rotateX(-Math.PI / 2); g.translate(0, 0.004, 0); return g; })();
const HEDGE_GEO = new THREE.SphereGeometry(0.55, 7, 5);
const GRATE_GEO = (() => { const g = new THREE.PlaneGeometry(0.5, 0.36); g.rotateX(-Math.PI / 2); return g; })();

/** PBR ground set from the materials library (world-space projected, wet handled by materials.setWet). */
function libraryGround(lib, wetMat) {
  if (!lib || typeof lib.get !== 'function' || typeof lib.variant !== 'function' || typeof lib.stripVariant !== 'function') return null;
  try {
    const set = {
      asphalt: lib.get('road'), sidewalk: lib.get('sidewalk'), kerb: lib.get('curb'),
      paint: lib.variant('roadPaint', { decal: true }), paintY: lib.variant('roadPaintYellow', { decal: true }),
      paint2: lib.variant('roadPaint', { decal: true, color: 0xd6d6cc }), paint3: lib.variant('roadPaint', { decal: true, color: 0xb4b4aa }),   // worn zebra stripes
      tactile: lib.stripVariant('tactile', [0.25, 0.25], { decal: true }),
      paver: lib.variant('paverGrey', { decal: true }), brick: lib.variant('paverRed', { decal: true }), granite: lib.variant('stone', { decal: true }),
      graniteTiles: lib.variant('stone', { decal: true, tiles: 1 }), drain: lib.variant('stone', { decal: true, color: 0x3c3c40, roughness: 0.3 }),
      gutter: lib.variant('road', { decal: true, color: 0x232326, roughness: 0.35 }), patch: lib.variant('road', { decal: true, color: 0x303033, roughness: 0.85 }),
    };
    for (const m of Object.values(set)) if (!m || !m.isMaterial) return null;
    set.graniteTiles.vertexColors = true;   // per-tile lightness jitter (own cached variant, nobody else gets it)
    // Every one of these carries the library's shader hook, whose after-rain drying state (dry / damp film / standing
    // water, per pixel, in world space) already owns the wet response. Scaling the scalar roughness here as well
    // (paver 1.0 -> 0.3, gutter 0.35 -> 0.1) glossed every paver in the city at once and overrode the library's wet
    // env intensity with a flat 1.9: the "whole plaza is a mirror" look. They keep their dry scalars.
    for (const k of ['paver', 'brick', 'granite', 'graniteTiles']) set[k].roughness = 1.0;
    set.drain.roughness = 0.3; set.gutter.roughness = 0.35;
    return set;
  } catch (e) { console.warn('[city] materials library ground set unavailable, using the local set', e); return null; }
}

function makeMaterials(lib) {
  if (mats) return mats;
  const wetMat = (mat, dry, wet) => { mat.roughness = dry; groundMaterials.push({ mat, dry, wet }); return mat; };
  const decal = (o) => { const m = L.std(o); m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2; m.userData.noShadow = true; return m; };
  const ground = libraryGround(lib, wetMat) || localGround(wetMat, decal);
  const gc = L.makeCanvas(64, 48), gx = gc.getContext('2d');   // steel frame + 6 bars over a black sump
  gx.fillStyle = '#4a4a4e'; gx.fillRect(0, 0, 64, 48); gx.fillStyle = '#050506'; gx.fillRect(4, 4, 56, 40);
  for (let i = 0; i < 6; i++) { gx.fillStyle = '#56565c'; gx.fillRect(7 + i * 9.4, 4, 4, 40); gx.fillStyle = '#7a7a80'; gx.fillRect(7 + i * 9.4, 4, 1, 40); }
  const grate = L.std({ map: L.canvasTex(gc, { aniso: 4 }), roughness: 0.45, metalness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }); grate.name = 'st_grate';
  // arrows atlas (4 cells): straight, left, right, straight+left — white on transparent
  const ac = L.makeCanvas(512, 256), actx = ac.getContext('2d');
  actx.clearRect(0, 0, 512, 256);
  const arrow = (cx, kind) => {
    actx.save(); actx.translate(cx, 0); actx.fillStyle = '#e8e8e0';
    actx.fillRect(56, 60, 16, 180);                                  // shaft
    if (kind === 'straight' || kind === 'straightLeft') { actx.beginPath(); actx.moveTo(64, 10); actx.lineTo(96, 70); actx.lineTo(32, 70); actx.closePath(); actx.fill(); }
    if (kind === 'left' || kind === 'straightLeft') { actx.fillRect(20, 130, 44, 14); actx.beginPath(); actx.moveTo(4, 137); actx.lineTo(30, 112); actx.lineTo(30, 162); actx.closePath(); actx.fill(); }
    if (kind === 'right') { actx.fillRect(64, 130, 44, 14); actx.beginPath(); actx.moveTo(124, 137); actx.lineTo(98, 112); actx.lineTo(98, 162); actx.closePath(); actx.fill(); }
    if (kind === 'left' || kind === 'right') { actx.clearRect(56, 10, 16, 50); }
    actx.restore();
  };
  ['straight', 'left', 'right', 'straightLeft'].forEach((k, i) => arrow(i * 128, k));
  const arrowTex = L.canvasTex(ac);
  const arrows = decal({ map: arrowTex, transparent: true, alphaTest: 0.3, roughness: 0.6, metalness: 0 }); arrows.name = 'st_arrows';
  // road text atlas (2 cells): バス専用 (white, bus-only lane) / バス (yellow, bus stop bay) — tall letters, drivers read
  // them foreshortened
  const tc = L.makeCanvas(512, 256), tctx = tc.getContext('2d');
  tctx.clearRect(0, 0, 512, 256); tctx.textAlign = 'center'; tctx.textBaseline = 'middle';
  tctx.font = `900 132px ${L.FONT_JP}`;
  tctx.fillStyle = '#ecece4'; tctx.save(); tctx.translate(128, 128); tctx.scale(0.5, 1.7); tctx.fillText('バス専用', 0, 0); tctx.restore();
  tctx.fillStyle = '#e8b830'; tctx.save(); tctx.translate(384, 128); tctx.scale(0.9, 1.7); tctx.fillText('バス', 0, 0); tctx.restore();
  const roadText = decal({ map: L.canvasTex(tc, { aniso: 8 }), transparent: true, alphaTest: 0.35, roughness: 0.6, metalness: 0 }); roadText.name = 'st_roadText';
  const manholeC = L.makeCanvas(128, 128), mctx = manholeC.getContext('2d');
  mctx.fillStyle = '#3a3a3c'; mctx.fillRect(0, 0, 128, 128);
  mctx.strokeStyle = '#1c1c1e'; mctx.lineWidth = 3; mctx.beginPath(); mctx.arc(64, 64, 58, 0, Math.PI * 2); mctx.stroke();
  mctx.beginPath(); mctx.arc(64, 64, 48, 0, Math.PI * 2); mctx.stroke();
  mctx.lineWidth = 2; for (let i = 0; i < 8; i++) { mctx.beginPath(); mctx.moveTo(64, 64); mctx.lineTo(64 + Math.cos(i * Math.PI / 4) * 48, 64 + Math.sin(i * Math.PI / 4) * 48); mctx.stroke(); }
  mctx.fillStyle = '#2a2a2c'; for (let i = 0; i < 40; i++) { mctx.fillRect(20 + L.hash(i, 1, 1) * 88, 20 + L.hash(i, 2, 1) * 88, 4, 4); }
  const manhole = wetMat(L.std({ map: L.canvasTex(manholeC), roughness: 0.55, metalness: 0.7, envMapIntensity: 1.0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), 0.55, 0.2); manhole.name = 'st_manhole';
  const green = L.std({ color: 0x2f5a2a, roughness: 0.95 }); green.name = 'st_hedge';
  // crack-seal / patch atlas (4 cells: two wandering tar seams, a square cut patch, a round utility patch) and a
  // soft kerb-grime ribbon (oil / soot / rubber collecting along the gutter), both transparent decals, one draw each
  const rc = L.makeCanvas(1024, 256), rx = rc.getContext('2d');
  rx.clearRect(0, 0, 1024, 256);
  for (let c = 0; c < 2; c++) {
    rx.strokeStyle = 'rgba(8,8,10,0.92)'; rx.lineCap = 'round'; rx.lineJoin = 'round';
    for (let b = 0; b < 3; b++) { rx.lineWidth = 5 + L.hash(c, b, 7) * 6; rx.beginPath(); let x = c * 256 + 8, y = 60 + b * 60 + L.hash(c, b, 8) * 30; rx.moveTo(x, y); for (let k = 0; k < 16; k++) { x += 15; y += (L.hash(c * 40 + b * 16 + k, 1, 9) - 0.5) * 22; rx.lineTo(Math.min(x, c * 256 + 248), Math.max(10, Math.min(246, y))); } rx.stroke(); }
  }
  { const x0 = 512 + 16; rx.fillStyle = 'rgba(14,14,16,0.9)'; rx.fillRect(x0, 16, 224, 224); rx.strokeStyle = 'rgba(4,4,5,0.95)'; rx.lineWidth = 6; rx.strokeRect(x0 + 3, 19, 218, 218); for (let k = 0; k < 400; k++) { rx.fillStyle = `rgba(${L.hash(k, 2, 3) < 0.5 ? '60,60,64' : '0,0,0'},0.35)`; rx.fillRect(x0 + L.hash(k, 3, 3) * 220, 18 + L.hash(k, 4, 3) * 220, 3, 3); } }
  { const cx = 896; rx.fillStyle = 'rgba(16,16,18,0.9)'; rx.beginPath(); rx.arc(cx, 128, 104, 0, 6.3); rx.fill(); rx.strokeStyle = 'rgba(4,4,5,0.95)'; rx.lineWidth = 7; rx.beginPath(); rx.arc(cx, 128, 104, 0, 6.3); rx.stroke(); }
  const repairs = wetMat(decal({ map: L.canvasTex(rc, { aniso: 8 }), transparent: true, depthWrite: false, roughness: 0.5, metalness: 0 }), 0.5, 0.08); repairs.name = 'st_repairs';
  const kc = L.makeCanvas(4, 64), kx = kc.getContext('2d'), kg = kx.createLinearGradient(0, 0, 0, 64);
  kg.addColorStop(0, 'rgba(6,6,7,0)'); kg.addColorStop(0.5, 'rgba(6,6,7,0.55)'); kg.addColorStop(1, 'rgba(6,6,7,0)'); kx.fillStyle = kg; kx.fillRect(0, 0, 4, 64);
  const kerbGrime = wetMat(decal({ map: L.canvasTex(kc, { mips: false }), transparent: true, depthWrite: false, roughness: 0.6, metalness: 0 }), 0.6, 0.1); kerbGrime.name = 'st_kerbGrime';
  for (const m of [ground.paint, ground.paint2, ground.paint3, ground.paintY]) addPaintWear(m);
  mats = { ...ground, arrows, roadText, manhole, green, grate, repairs, kerbGrime };
  return mats;
}
/**
 * World-space paint wear chained after the material's own hook: tyre tracks (two wheel paths per 3.2 m lane, running
 * along the stripe direction carried in `binfo.xy`, binfo.z = 1 on zebra bars), heel scuffs, chips and glass-bead
 * speckle. Worn paint shows the asphalt through and goes rough.
 */
function addPaintWear(m) {
  if (!m || m.userData.wearHooked) return;
  m.userData.wearHooked = true;
  m.userData.attrs = [['binfo', 3]];
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey ? m.customProgramCacheKey() : '';
  m.onBeforeCompile = function (sh, r) {
    if (typeof prev === 'function') prev.call(this, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 binfo; varying vec3 vWearInfo; varying vec3 vWearPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWearInfo = binfo; vWearPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWearInfo; varying vec3 vWearPos;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float wNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float paintWear = 0.0;
{
  vec2 p = vWearPos.xz;
  float scuff = smoothstep(0.58, 0.86, wNoise(p * 1.3) * 0.6 + wNoise(p * 4.1) * 0.4);
  float chip = smoothstep(0.74, 0.8, wNoise(p * 7.0) * 0.55 + wNoise(p * 19.0) * 0.45) * step(0.45, wNoise(p * 1.7 + 3.0));
  float tyre = 0.0;
  if (vWearInfo.z > 0.5) {
    vec2 t = normalize(vWearInfo.xy + 1e-5);
    float along = dot(p, t), across = mod(dot(p, vec2(-t.y, t.x)), 3.2);
    tyre = (smoothstep(0.24, 0.06, abs(across - 0.8)) + smoothstep(0.24, 0.06, abs(across - 2.4))) * (0.55 + 0.45 * wNoise(vec2(along * 0.9, across * 3.0)));
  }
  paintWear = clamp(tyre * 0.7 + scuff * 0.55 + chip * 0.8, 0.0, 0.92);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.032, 0.032, 0.036), paintWear);
  diffuseColor.rgb *= 1.0 + (wHash(floor(p * 240.0)) - 0.5) * 0.12 * (1.0 - paintWear);   // glass-bead speckle
}`)
      .replace('#include <normal_fragment_begin>', 'roughnessFactor = mix(roughnessFactor, max(roughnessFactor, 0.85), paintWear * 0.7);\n#include <normal_fragment_begin>');
  };
  m.customProgramCacheKey = () => prevKey + '|wear';
}

/** Local flat-noise ground set, used only when the materials library is not available. */
function localGround(wetMat, decal) {
  const asphaltMap = L.noiseTex({ size: 512, base: [38, 38, 41], variance: 12, seed: 21, low: 1.2, draw: (ctx, s) => {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.2;
    for (let i = 0; i < 12; i++) { let x = L.hash(i, 1, 5) * s, y = L.hash(i, 2, 5) * s; ctx.beginPath(); ctx.moveTo(x, y); for (let k = 0; k < 7; k++) { x += (L.hash(i, 10 + k, 5) - 0.5) * 40; y += (L.hash(i, 30 + k, 5) - 0.5) * 40; ctx.lineTo(x, y); } ctx.stroke(); }
    for (let i = 0; i < 7; i++) { ctx.fillStyle = `rgba(${L.hash(i, 7, 9) > 0.5 ? 12 : 70},${L.hash(i, 7, 9) > 0.5 ? 12 : 70},${L.hash(i, 7, 9) > 0.5 ? 14 : 72},0.3)`; ctx.fillRect(L.hash(i, 21, 9) * s, L.hash(i, 22, 9) * s, 30 + L.hash(i, 23, 9) * 120, 14 + L.hash(i, 24, 9) * 50); }
  } });
  const asphaltRough = L.noiseTex({ size: 256, base: [215, 215, 215], variance: 45, seed: 22, srgb: false, low: 1.5 });
  const asphalt = wetMat(L.std({ map: asphaltMap, roughnessMap: asphaltRough, roughness: 0.92, metalness: 0, envMapIntensity: 0.8 }), 0.92, 0.25);
  asphalt.name = 'st_asphalt';
  const swMap = L.noiseTex({ size: 512, base: [152, 148, 140], variance: 10, seed: 61, low: 0.9, draw: (ctx, s) => {
    const n = 10, t = s / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = (L.hash(i, j, 3) - 0.5) * 26;
      ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`; ctx.fillRect(i * t, j * t, t, t);
    }
    ctx.fillStyle = 'rgba(60,56,50,0.55)';
    for (let i = 0; i <= n; i++) { ctx.fillRect(Math.round(i * t), 0, 2, s); ctx.fillRect(0, Math.round(i * t), s, 2); }
    for (let k = 0; k < 40; k++) { ctx.fillStyle = `rgba(20,18,16,${0.08 + L.hash(k, 9, 4) * 0.12})`; ctx.fillRect(L.hash(k, 1, 4) * s, L.hash(k, 2, 4) * s, 10 + L.hash(k, 3, 4) * 60, 6 + L.hash(k, 4, 4) * 30); }
  } });
  const swRough = L.noiseTex({ size: 256, base: [205, 205, 205], variance: 40, seed: 62, srgb: false });
  const sidewalk = wetMat(L.std({ map: swMap, roughnessMap: swRough, roughness: 0.85, metalness: 0, envMapIntensity: 0.7 }), 0.85, 0.42);
  sidewalk.name = 'st_sidewalk';
  const kerbMap = L.noiseTex({ size: 128, base: [172, 170, 164], variance: 12, seed: 101, low: 0.8 });
  const kerb = wetMat(L.std({ map: kerbMap, roughness: 0.8, metalness: 0 }), 0.8, 0.45);
  kerb.name = 'st_kerb';
  const paintMap = L.noiseTex({ size: 128, base: [232, 232, 224], variance: 18, seed: 91, low: 1.4 });
  const paint = wetMat(decal({ map: paintMap, roughness: 0.6, metalness: 0, envMapIntensity: 0.6 }), 0.6, 0.3); paint.name = 'st_paint';
  const yellowMap = L.noiseTex({ size: 128, base: [236, 196, 48], variance: 16, seed: 92, low: 1.2 });
  const paintY = wetMat(decal({ map: yellowMap, roughness: 0.6, metalness: 0 }), 0.6, 0.3); paintY.name = 'st_paintY';
  // tactile paving: yellow with raised bars (u along the strip)
  const tacMap = L.noiseTex({ size: 128, base: [226, 186, 40], variance: 10, seed: 93, draw: (ctx, s) => {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    for (let i = 0; i < 4; i++) { ctx.fillRect(0, i * s / 4 + 6, s, 3); ctx.fillRect(0, i * s / 4 + s / 8 + 6, s, 3); }
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(i * s / 4 + 4, j * s / 4 + 2, s / 4 - 8, 3); }
  } });
  const tactile = wetMat(decal({ map: tacMap, roughness: 0.7, metalness: 0 }), 0.7, 0.4); tactile.name = 'st_tactile';
  // pavers (Center-gai style grey interlocking) and red brick promenade, granite plaza
  const paverMap = L.noiseTex({ size: 256, base: [138, 134, 128], variance: 12, seed: 71, low: 0.8, draw: (ctx, s) => {
    const bw = s / 8, bh = s / 16;
    ctx.fillStyle = 'rgba(50,48,44,0.6)';
    for (let r = 0; r < 16; r++) { ctx.fillRect(0, r * bh, s, 1.5); const off = (r % 2) * bw / 2; for (let c = 0; c <= 8; c++) ctx.fillRect((c * bw + off) % s, r * bh, 1.5, bh); }
    for (let k = 0; k < 60; k++) { const v = (L.hash(k, 3, 2) - 0.5) * 30; ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`; const r = Math.floor(L.hash(k, 1, 2) * 16), c = Math.floor(L.hash(k, 2, 2) * 8); ctx.fillRect(c * bw + (r % 2) * bw / 2, r * bh, bw, bh); }
  } });
  const paver = wetMat(decal({ map: paverMap, roughness: 0.8, metalness: 0 }), 0.8, 0.4); paver.name = 'st_paver';
  const brickMap = L.noiseTex({ size: 256, base: [142, 88, 70], variance: 16, seed: 72, low: 0.8, draw: (ctx, s) => {
    const bw = s / 6, bh = s / 12;
    ctx.fillStyle = 'rgba(210,200,190,0.75)';
    for (let r = 0; r < 12; r++) { ctx.fillRect(0, r * bh, s, 2); const off = (r % 2) * bw / 2; for (let c = 0; c <= 6; c++) ctx.fillRect((c * bw + off) % s, r * bh, 2, bh); }
  } });
  const brick = wetMat(decal({ map: brickMap, roughness: 0.85, metalness: 0 }), 0.85, 0.45); brick.name = 'st_brick';
  const graniteMap = L.noiseTex({ size: 512, base: [168, 160, 148], variance: 9, seed: 73, low: 1.0, draw: (ctx, s) => {
    const n = 6, t = s / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const k = (i + j) % 3; ctx.fillStyle = k === 0 ? 'rgba(90,80,70,0.25)' : k === 1 ? 'rgba(255,250,240,0.12)' : 'rgba(120,110,100,0.1)'; ctx.fillRect(i * t, j * t, t, t); }
    ctx.fillStyle = 'rgba(70,66,60,0.5)';
    for (let i = 0; i <= n; i++) { ctx.fillRect(Math.round(i * t), 0, 2, s); ctx.fillRect(0, Math.round(i * t), s, 2); }
  } });
  const granite = wetMat(decal({ map: graniteMap, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.9 }), 0.6, 0.25); granite.name = 'st_granite';
  const graniteTiles = wetMat(decal({ map: graniteMap, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.9, vertexColors: true }), 0.6, 0.25); graniteTiles.name = 'st_graniteTiles';
  const paint2 = wetMat(decal({ map: paintMap, color: 0xd6d6cc, roughness: 0.6, metalness: 0 }), 0.6, 0.3); paint2.name = 'st_paint2';
  const paint3 = wetMat(decal({ map: paintMap, color: 0xb4b4aa, roughness: 0.65, metalness: 0 }), 0.65, 0.3); paint3.name = 'st_paint3';
  const gutter = wetMat(decal({ map: asphaltMap, color: 0x8a8a90, roughness: 0.4, metalness: 0 }), 0.4, 0.1); gutter.name = 'st_gutter';
  const patch = wetMat(decal({ map: asphaltMap, color: 0x9a9a9c, roughness: 0.9, metalness: 0 }), 0.9, 0.3); patch.name = 'st_patch';
  const drain = wetMat(decal({ color: 0x3c3c40, roughness: 0.3, metalness: 0.1 }), 0.3, 0.12); drain.name = 'st_drain';
  return { asphalt, sidewalk, kerb, paint, paintY, paint2, paint3, tactile, paver, brick, granite, graniteTiles, gutter, patch, drain };
}

export function setWetFactor(f) {
  for (const { mat, dry, wet } of groundMaterials) { mat.roughness = dry + (wet - dry) * f; mat.envMapIntensity = 0.6 + 1.3 * f; }
}

// ------------------------------------------------------------------------------------------------ SDF field
function sdfPolygon(x, z, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, L.distToSegment(x, z, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
  return L.pointInPoly(x, z, poly) ? d : -d;
}

export function buildRoadField(CITY) {
  const N = (2 * GRID_R) / STEP + 1;
  const f = new Float32Array(N * N);
  const segs = [];
  // carriageways: every road + the bus-only lanes (西口 terminal); the islands between them are simply what no
  // capsule covers, so they come out raised with kerbs and tactile edges like any pavement
  for (const r of [...CITY.roads, ...(CITY.busways || [])]) {
    const half = r.width / 2;
    for (let i = 0; i < r.path.length - 1; i++) {
      const [ax, az] = r.path[i], [bx, bz] = r.path[i + 1];
      segs.push({ ax, az, bx, bz, half, x0: Math.min(ax, bx) - half - 2, x1: Math.max(ax, bx) + half + 2, z0: Math.min(az, bz) - half - 2, z1: Math.max(az, bz) + half + 2, road: r });
    }
  }
  // at-grade cuts through the terminal islands where a zebra crosses them (kerbs stop at the crossing)
  for (const c of CITY.crosswalksExtra || []) {
    if (!c.stops) continue;
    const xs = c.stops.map(s => [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]);
    const ux = c.b[0] - c.a[0], uz = c.b[1] - c.a[1], ul = Math.hypot(ux, uz), t = (p) => ((p[0] - c.a[0]) * ux + (p[1] - c.a[1]) * uz) / ul;
    const ts = xs.map(t), t0 = Math.min(...ts) + 1, t1 = Math.max(...ts) - 1;
    const ax = c.a[0] + ux / ul * t0, az = c.a[1] + uz / ul * t0, bx = c.a[0] + ux / ul * t1, bz = c.a[1] + uz / ul * t1, half = c.width / 2;
    segs.push({ ax, az, bx, bz, half, x0: Math.min(ax, bx) - half - 2, x1: Math.max(ax, bx) + half + 2, z0: Math.min(az, bz) - half - 2, z1: Math.max(az, bz) + half + 2, road: c, cut: true });
  }
  const cc = CITY.crossing;
  // terminal aprons (carriageway that is no lane: the 東口 waiting area, turn flares) and the islands raised on them
  const aprons = (CITY.aprons || []).map(p => ({ poly: L.ensureCW(p.polygon), b: L.polyBounds(p.polygon) }));
  const islands = (CITY.raised || []).map(p => ({ poly: L.ensureCW(p.polygon), b: L.polyBounds(p.polygon) }));
  // segments bucketed on a 20 m grid (each where its bbox reaches): a cell tests only its bucket's segments, with the
  // same bbox test as before, so every value is what the full scan gave
  const BK = 20, NB = Math.ceil((N - 1) * STEP / BK) + 1, buckets = Array.from({ length: NB * NB }, () => []);
  segs.forEach((s, k) => {
    const i0 = Math.max(0, Math.floor((s.x0 - GRID_X0) / BK)), i1 = Math.min(NB - 1, Math.floor((s.x1 - GRID_X0) / BK));
    const j0 = Math.max(0, Math.floor((s.z0 - GRID_Z0) / BK)), j1 = Math.min(NB - 1, Math.floor((s.z1 - GRID_Z0) / BK));
    for (let bj = j0; bj <= j1; bj++) for (let bi = i0; bi <= i1; bi++) buckets[bj * NB + bi].push(k);
  });
  for (let j = 0; j < N; j++) {
    const z = GRID_Z0 + j * STEP;
    for (let i = 0; i < N; i++) {
      const x = GRID_X0 + i * STEP;
      let v = 1e3;
      const bl = buckets[Math.min(NB - 1, Math.floor((z - GRID_Z0) / BK)) * NB + Math.min(NB - 1, Math.floor((x - GRID_X0) / BK))];
      for (let q = 0; q < bl.length; q++) {
        const s = segs[bl[q]];
        if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
        const d = L.distToSegment(x, z, s.ax, s.az, s.bx, s.bz) - s.half;
        if (d < v) v = d;
      }
      const dc = Math.hypot(x - cc.center[0], z - cc.center[1]) - cc.radius;
      if (dc < v) v = dc;
      for (const ap of aprons) {
        if (x < ap.b.x0 - 8 || x > ap.b.x1 + 8 || z < ap.b.z0 - 8 || z > ap.b.z1 + 8) continue;
        const d = -sdfPolygon(x, z, ap.poly);
        if (d < v) v = d;
      }
      for (const isl of islands) {
        if (x < isl.b.x0 - 2 || x > isl.b.x1 + 2 || z < isl.b.z0 - 2 || z > isl.b.z1 + 2) continue;
        const d = sdfPolygon(x, z, isl.poly);
        if (d > v) v = d;
      }
      f[j * N + i] = Math.min(v, 60);
    }
  }
  // live cells: inside the old ±300 m square or the corridor outline (scanline fill of the polygon per cell row)
  const live = new Uint8Array((N - 1) * (N - 1)), W = N - 1;
  for (let j = 0; j < W; j++) {
    const z = GRID_Z0 + (j + 0.5) * STEP;
    for (let i = 0; i < W; i++) { const x = GRID_X0 + (i + 0.5) * STEP; if (x >= -300 && x <= 300 && z >= -300 && z <= 300) live[j * W + i] = 1; }
    const P = CITY.scope?.outline || (CITY.corridor && CITY.corridor.outline);
    if (!P) continue;
    const xs = [];
    for (let a = 0, b = P.length - 1; a < P.length; b = a++) { const [xa, za] = P[a], [xb, zb] = P[b]; if ((za > z) !== (zb > z)) xs.push(xa + (z - za) / (zb - za) * (xb - xa)); }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - GRID_X0) / STEP - 0.5)), i1 = Math.min(W - 1, Math.floor((xs[k + 1] - GRID_X0) / STEP - 0.5));
      for (let i = i0; i <= i1; i++) live[j * W + i] = 1;
    }
  }
  return { f, N, segs, live, x0: GRID_X0, z0: GRID_Z0, step: STEP, R: GRID_R, sample(x, z) {
    const gx = (x - GRID_X0) / STEP, gz = (z - GRID_Z0) / STEP;
    const i = Math.max(0, Math.min(N - 2, Math.floor(gx))), j = Math.max(0, Math.min(N - 2, Math.floor(gz)));
    const tx = Math.max(0, Math.min(1, gx - i)), tz = Math.max(0, Math.min(1, gz - j));
    const a = f[j * N + i], b = f[j * N + i + 1], c = f[(j + 1) * N + i], d = f[(j + 1) * N + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  } };
}

// clip a convex polygon of {x,z,f} vertices to f >= lo (Sutherland–Hodgman on the scalar field)
function clipLo(poly, lo) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ain = a.f >= lo, bin = b.f >= lo;
    if (ain) out.push(a);
    if (ain !== bin) { const t = (lo - a.f) / (b.f - a.f); out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, f: lo, iso: true }); }
  }
  return out;
}
function clipHi(poly, hi) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ain = a.f <= hi, bin = b.f <= hi;
    if (ain) out.push(a);
    if (ain !== bin) { const t = (hi - a.f) / (b.f - a.f); out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, f: hi, iso: true }); }
  }
  return out;
}
function isoSegments(c, level) {
  // c = 4 corners in order (x0z0, x1z0, x1z1, x0z1); returns [[p,q],...] with p,q = {x,z}
  const pts = [];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    if ((a.f >= level) !== (b.f >= level)) { const t = (level - a.f) / (b.f - a.f); pts.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, e: i }); }
  }
  if (pts.length === 2) return [[pts[0], pts[1]]];
  if (pts.length === 4) {
    const centre = (c[0].f + c[1].f + c[2].f + c[3].f) / 4;
    const firstIn = c[0].f >= level;
    // pair edges so the inside stays connected when the centre is inside
    if ((centre >= level) === firstIn) return [[pts[3], pts[0]], [pts[1], pts[2]]];
    return [[pts[0], pts[1]], [pts[2], pts[3]]];
  }
  return [];
}

// ------------------------------------------------------------------------------------------------ builders
// Axis-aligned openings in the ground (CITY.groundHoles: stair / escalator wells going down to the station levels —
// the Scramble Square アーバン・コア's down escalators, Metro exit 15). The terrain grid and the pavement skip them;
// the builder that owns the well lines it (walls, floor, steps) and fences it.
const HOLES = (CITY0) => (CITY0.groundHoles || []).map((h) => ({ id:h.id, x0: h.x0, z0: h.z0, x1: h.x1, z1: h.z1 }));
function subtractHoles(r, holes) {
  let out = [r];
  for (const h of holes) {
    const next = [];
    for (const [x0, z0, x1, z1] of out) {
      if (h.x1 <= x0 || h.x0 >= x1 || h.z1 <= z0 || h.z0 >= z1) { next.push([x0, z0, x1, z1]); continue; }
      if (h.z0 > z0) next.push([x0, z0, x1, h.z0]);
      if (h.z1 < z1) next.push([x0, h.z1, x1, z1]);
      const za = Math.max(z0, h.z0), zb = Math.min(z1, h.z1);
      if (h.x0 > x0) next.push([x0, za, h.x0, zb]);
      if (h.x1 < x1) next.push([h.x1, za, x1, zb]);
    }
    out = next;
  }
  return out;
}
class PolyEmitter {
  constructor(batch, mat, y, uvScale, yAt, holes = []) { this.batch = batch; this.mat = mat; this.y = y; this.uvScale = uvScale; this.yAt = yAt; this.holes = holes; this.pos = []; this.nor = []; this.uv = []; this.idx = []; this.vi = 0; this.chunkX = 0; this.chunkZ = 0; }
  poly(p) {
    if (p.length < 3) return;
    const base = this.vi;
    for (const v of p) { this.pos.push(v.x, this.y + this.yAt(v.x, v.z), v.z); this.nor.push(0, 1, 0); this.uv.push(v.x * this.uvScale, v.z * this.uvScale); this.vi++; }
    // winding: up normal → (a, c, b) for our x/z ordering when area > 0
    let area = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) area += p[j].x * p[i].z - p[i].x * p[j].z;
    for (let k = 1; k < p.length - 1; k++) { if (area > 0) this.idx.push(base, base + k + 1, base + k); else this.idx.push(base, base + k, base + k + 1); }
    if (this.vi > 60000) this.flush();
  }
  rect(x0, z0, x1, z1) {
    if (this.holes.length && this.holes.some((h) => !(h.x1 <= x0 || h.x0 >= x1 || h.z1 <= z0 || h.z0 >= z1))) { for (const r of subtractHoles([x0, z0, x1, z1], this.holes)) if (r[2] - r[0] > 1e-3 && r[3] - r[1] > 1e-3) this.rect(...r); return; }
    // on the 道玄坂 / 文化村通り slopes a big flat quad would cut through the curved ground: 2 m tiles there
    const y = this.yAt, flat = !y((x0 + x1) / 2, (z0 + z1) / 2) && !y(x0, z0) && !y(x1, z0) && !y(x1, z1) && !y(x0, z1);
    if (flat || (x1 - x0 <= 2.01 && z1 - z0 <= 2.01)) { this.poly([{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }]); return; }
    const nx = Math.ceil((x1 - x0) / 2 - 1e-6), nz = Math.ceil((z1 - z0) / 2 - 1e-6), dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = x0 + i * dx, b = z0 + j * dz; this.poly([{ x: a, z: b }, { x: a + dx, z: b }, { x: a + dx, z: b + dz }, { x: a, z: b + dz }]); }
  }
  flush() {
    if (!this.vi) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    this.batch.add(this.mat, g, this.pos[0], this.pos[2]);
    this.pos = []; this.nor = []; this.uv = []; this.idx = []; this.vi = 0;
  }
}

/** Sidewalk field → merged meshes. Returns { kerbChains, patches } */
function buildSidewalks(field, batch, M, yAt, world, holes = []) {
  const { f, N, live } = field, LW = N - 1;
  const isLive = (i, j) => !live || live[j * LW + i] === 1;
  // cells of a block that are live: 0 none, 2 all, 1 some
  const liveIn = (i0, j0, n) => { if (!live) return 2; let a = 0, t = 0; for (let j = j0; j < Math.min(LW, j0 + n); j++) for (let i = i0; i < Math.min(LW, i0 + n); i++) { t++; a += live[j * LW + i]; } return a === 0 ? 0 : a === t ? 2 : 1; };
  const sw = new PolyEmitter(batch, M.sidewalk, SW_H, 1 / 3, yAt, holes);
  const kt = new PolyEmitter(batch, M.kerb, SW_H, 1, yAt);
  const wallPos = [], wallNor = [], wallUv = [], wallIdx = []; let wvi = 0;
  const iso = [];                                   // tactile isoline segments
  const corner = (i, j) => ({ x: GRID_X0 + i * STEP, z: GRID_Z0 + j * STEP, f: f[j * N + i] });
  const cellIsMixed = (i, j) => { const a = f[j * N + i], b = f[j * N + i + 1], c = f[(j + 1) * N + i + 1], d = f[(j + 1) * N + i]; return Math.min(a, b, c, d) < KERB_W && Math.max(a, b, c, d) > 0; };
  const blockMin = (i0, j0, n) => { let m = Infinity, mx = -Infinity; for (let j = j0; j <= Math.min(N - 1, j0 + n); j++) for (let i = i0; i <= Math.min(N - 1, i0 + n); i++) { const v = f[j * N + i]; if (v < m) m = v; if (v > mx) mx = v; } return [m, mx]; };
  const emitCell = (i, j) => {
    if (i >= N - 1 || j >= N - 1 || !isLive(i, j)) return;
    const c = [corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)];
    // Rail cutting owns its pavement and kerbs; none of the street field may bridge the opening.
    if (holes.some(h => h.id==='shinsen_rail_cutting' && (c[0].x+c[2].x)/2>h.x0 && (c[0].x+c[2].x)/2<h.x1 && (c[0].z+c[2].z)/2>h.z0 && (c[0].z+c[2].z)/2<h.z1)) return;
    const inside = clipLo(c, KERB_W);
    if (inside.length >= 3 && !(holes.length && holes.some((h) => c[0].x >= h.x0 && c[2].x <= h.x1 && c[0].z >= h.z0 && c[2].z <= h.z1))) sw.poly(inside);
    const band = clipHi(clipLo(c, 0), KERB_W);
    if (band.length >= 3) kt.poly(band);
    // kerb wall on the f=0 isoline
    for (const [p, q] of isoSegments(c, 0)) {
      const gx = ((c[1].f - c[0].f) + (c[2].f - c[3].f)) / 2, gz = ((c[3].f - c[0].f) + (c[2].f - c[1].f)) / 2;
      const gl = Math.hypot(gx, gz) || 1, nx = -gx / gl, nz = -gz / gl;
      const yp = yAt(p.x, p.z), yq = yAt(q.x, q.z);
      const b = wvi;
      wallPos.push(p.x, yp, p.z, q.x, yq, q.z, q.x, yq + SW_H, q.z, p.x, yp + SW_H, p.z);
      for (let k = 0; k < 4; k++) wallNor.push(nx, 0, nz);
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      wallUv.push(0, 0, len, 0, len, SW_H, 0, SW_H);
      // winding from the normal
      const e1x = q.x - p.x, e1z = q.z - p.z; const cy = e1z * nx - e1x * nz; // (e1 × up) · n sign
      if (cy < 0) wallIdx.push(b, b + 1, b + 2, b, b + 2, b + 3); else wallIdx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      wvi += 4;
    }
    for (const s of isoSegments(c, 0.62)) iso.push(s);
  };
  const B = 16, S = 4;
  for (let j = 0; j < N - 1; j += B) for (let i = 0; i < N - 1; i += B) {
    const lv = liveIn(i, j, B);
    if (!lv) continue;
    const [mn, mx] = blockMin(i, j, B);
    if (mx <= 0) continue;
    if (mn >= KERB_W && lv === 2) { sw.rect(GRID_X0 + i * STEP, GRID_Z0 + j * STEP, GRID_X0 + Math.min(N - 1, i + B) * STEP, GRID_Z0 + Math.min(N - 1, j + B) * STEP); continue; }
    for (let jj = j; jj < Math.min(N - 1, j + B); jj += S) for (let ii = i; ii < Math.min(N - 1, i + B); ii += S) {
      const lv2 = liveIn(ii, jj, S);
      if (!lv2) continue;
      const [mn2, mx2] = blockMin(ii, jj, S);
      if (mx2 <= 0) continue;
      if (mn2 >= KERB_W && lv2 === 2) { sw.rect(GRID_X0 + ii * STEP, GRID_Z0 + jj * STEP, GRID_X0 + Math.min(N - 1, ii + S) * STEP, GRID_Z0 + Math.min(N - 1, jj + S) * STEP); continue; }
      for (let cj = jj; cj < Math.min(N - 1, jj + S); cj++) for (let ci = ii; ci < Math.min(N - 1, ii + S); ci++) {
        if (!isLive(ci, cj)) continue;
        if (cellIsMixed(ci, cj)) emitCell(ci, cj);
        else { const v = f[cj * N + ci]; if (v >= KERB_W) sw.rect(GRID_X0 + ci * STEP, GRID_Z0 + cj * STEP, GRID_X0 + (ci + 1) * STEP, GRID_Z0 + (cj + 1) * STEP); }
      }
    }
  }
  sw.flush(); kt.flush();
  if (wvi) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(wallNor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(wallUv, 2));
    g.setIndex(wallIdx);
    batch.add(M.kerb, g, 0, 0);
  }
  // ---- physics ground patches: raised cells → row runs → merged rectangles
  const raised = new Uint8Array((N - 1) * (N - 1));
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const v = (f[j * N + i] + f[j * N + i + 1] + f[(j + 1) * N + i] + f[(j + 1) * N + i + 1]) / 4;
    if (v > 0.05) raised[j * (N - 1) + i] = 1;
  }
  const patches = [];
  const used = new Uint8Array(raised.length);
  const W = N - 1;
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    if (!raised[j * W + i] || used[j * W + i]) continue;
    let w = 1; while (i + w < W && raised[j * W + i + w] && !used[j * W + i + w]) w++;
    let h = 1;
    outer: while (j + h < W) { for (let k = 0; k < w; k++) if (!raised[(j + h) * W + i + k] || used[(j + h) * W + i + k]) break outer; h++; }
    for (let jj = 0; jj < h; jj++) for (let k = 0; k < w; k++) used[(j + jj) * W + i + k] = 1;
    patches.push({ cx: GRID_X0 + (i + w / 2) * STEP, cz: GRID_Z0 + (j + h / 2) * STEP, hw: w * STEP / 2, hd: h * STEP / 2, rot: 0, y: SW_H });
  }
  // physics: the sidewalk slab is read straight from the field (exact kerb line, O(1)); the terrain comes from
  // world.groundBase (city.js). `patches` is still returned for anyone who wants the rectangles.
  if (world) world.groundSlab = (x, z) => (field.sample(x, z) > 0 ? SW_H : 0);
  // gutter isoline 25 cm out on the carriageway side of every kerb
  const gutterIso = [];
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = f[j * N + i], b = f[j * N + i + 1], c2 = f[(j + 1) * N + i + 1], d = f[(j + 1) * N + i];
    if (isLive(i, j) && Math.min(a, b, c2, d) < -0.25 && Math.max(a, b, c2, d) >= -0.25) for (const s of isoSegments([corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)], -0.25)) gutterIso.push(s);
  }
  return { iso, gutterIso, patches };
}
/** 2 m granite tiles with a per-tile lightness jitter (vertex colours) over the cells fully inside a plaza polygon. */
function tileGrid(poly, y, uvScale = 1 / 7) {
  const bb = L.polyBounds(poly);
  const pos = [], nor = [], uv = [], col = [], idx = []; let vi = 0;
  for (let x = Math.floor(bb.x0 / 2) * 2; x < bb.x1; x += 2) for (let z = Math.floor(bb.z0 / 2) * 2; z < bb.z1; z += 2) {
    const cs = [[x, z], [x + 2, z], [x + 2, z + 2], [x, z + 2]];
    if (!cs.every(([cx, cz]) => L.pointInPoly(cx, cz, poly))) continue;
    if (poly.some(([px, pz]) => px > x && px < x + 2 && pz > z && pz < z + 2)) continue;
    const k = 0.95 + L.hash(x, z, 5) * 0.1, kw = 1 + (L.hash(x, z, 6) - 0.5) * 0.04;
    const b = vi;
    for (const [cx, cz] of cs) { pos.push(cx, y, cz); nor.push(0, 1, 0); uv.push(cx * uvScale, cz * uvScale); col.push(k * kw, k, k / kw); vi++; }
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  if (!vi) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
  return g;
}

/** Chain unordered isoline segments into polylines. */
function chainSegments(segs) {
  const key = (p) => `${Math.round(p.x * 100)},${Math.round(p.z * 100)}`;
  const ends = new Map();
  const add = (k, i) => { if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); };
  segs.forEach((s, i) => { add(key(s[0]), i); add(key(s[1]), i); });
  const used = new Uint8Array(segs.length);
  const chains = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const chain = [segs[i][0], segs[i][1]];
    for (const dir of [1, -1]) {
      let cur = dir === 1 ? chain[chain.length - 1] : chain[0];
      for (let guard = 0; guard < 5000; guard++) {
        const list = ends.get(key(cur)) || [];
        let next = -1;
        for (const j of list) if (!used[j]) { next = j; break; }
        if (next < 0) break;
        used[next] = 1;
        const s = segs[next];
        const other = key(s[0]) === key(cur) ? s[1] : s[0];
        if (dir === 1) chain.push(other); else chain.unshift(other);
        cur = other;
      }
    }
    if (chain.length >= 3) chains.push(chain.map(p => [p.x, p.z]));
  }
  return chains;
}

/** Ground mesh over ±700 m following yAt: a tensor grid, fine (2 m) over the bounding box of the sloped area. */
function terrainGeometry(yAt, holes = []) {
  const E = 950, FINE = 2, MID = 5, COARSE = 25, R = 440, FR = 300;   // 2 m cells inside ±300 m, 5 m on the vistas beyond
  // pass 15: the 道玄坂 corridor runs out to x −590 / z +500: the slope scan reaches it, and the x axis stays fine (2 m)
  // west to −600 (its z rows are fine to +300 and 5 m beyond, where the street runs along z: the profile is linear
  // between the 12 m DEM samples, so 5 m rows leave < 1 cm between the mesh and yAt)
  const RX0 = -840, RZ1 = 560, FX0 = -840;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let x = RX0; x <= R; x += 5) for (let z = -R; z <= RZ1; z += 5) if (yAt(x, z) > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const axis = (a, b, f0 = -FR) => {
    const out = [];
    const coarse = (from, to) => { const n = Math.max(1, Math.ceil((to - from) / COARSE)); for (let i = 0; i < n; i++) out.push(from + (to - from) * i / n); };
    if (!(a < b)) { coarse(-E, E); out.push(E); return out; }
    a = Math.max(-E + 1, Math.floor((a - 6) / MID) * MID); b = Math.min(E - 1, Math.ceil((b + 6) / MID) * MID);
    coarse(-E, a);
    for (let v = a; v < b;) { out.push(v); v += v >= f0 && v < FR ? FINE : MID; }
    coarse(b, E); out.push(E);
    return out;
  };
  const xs = axis(x0, x1, FX0), zs = axis(z0, z1);
  for (const h of holes) { xs.push(h.x0, h.x1); zs.push(h.z0, h.z1); }
  if (holes.length) { const uniq = (a) => [...new Set(a.map((v) => Math.round(v * 1000) / 1000))].sort((p, q) => p - q); xs.splice(0, xs.length, ...uniq(xs)); zs.splice(0, zs.length, ...uniq(zs)); }
  // tiles: the axes are cut at the fine region's edges and midpoint, so the 2 m slope grid is split into its own
  // frustum-culled pieces (tiles share their edge vertices and use analytic normals: no seams)
  const cuts = (vs, a, b) => {
    const out = [0];
    if (a < b) for (const c of [a, (a + b) / 2, b]) { const i = vs.findIndex(v => v >= c - 1e-6); if (i > out[out.length - 1] && i < vs.length - 1) out.push(i); }
    out.push(vs.length - 1);
    return out;
  };
  const cx = cuts(xs, x0, x1), cz = cuts(zs, z0, z1), tiles = [];
  for (let tj = 0; tj < cz.length - 1; tj++) for (let ti = 0; ti < cx.length - 1; ti++) {
    const X = xs.slice(cx[ti], cx[ti + 1] + 1), Z = zs.slice(cz[tj], cz[tj + 1] + 1), nx = X.length, nz = Z.length;
    const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2), nor = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = X[i], z = Z[j];
      pos[k * 3] = x; pos[k * 3 + 1] = yAt(x, z); pos[k * 3 + 2] = z;
      uv[k * 2] = x / 10; uv[k * 2 + 1] = -z / 10;
      const hx = yAt(x + 0.5, z) - yAt(x - 0.5, z), hz = yAt(x, z + 0.5) - yAt(x, z - 0.5), l = Math.hypot(hx, 1, hz);
      nor[k * 3] = -hx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = -hz / l;
    }
    const idx = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      if (holes.length) { const mx = (X[i] + X[i + 1]) / 2, mz = (Z[j] + Z[j + 1]) / 2; if (holes.some((h) => mx > h.x0 && mx < h.x1 && mz > h.z0 && mz < h.z1)) continue; }
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeBoundingSphere();
    tiles.push(g);
  }
  return tiles;
}
// Roads that climb out of the map (道玄坂 to 道玄坂上, 文化村通り toward Bunkamura) keep going for the eye: their
// carriageway, kerbs and paint are extended past the map edge (render only; traffic / crowd use cityData as is).
// (pass 15: 道玄坂 no longer leaves the map — the corridor lays it for real up to 道玄坂上 — so only 文化村通り keeps one)
export const VISTA = { bunkamura: 85 };
export function vistaRoads(CITY) {
  return CITY.roads.map(r => {
    const ext = CITY.scope ? 0 : VISTA[r.id]; if (!ext) return r;
    const p = r.path, a = p[p.length - 2], b = p[p.length - 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { ...r, path: [...p, [b[0] + (b[0] - a[0]) / l * ext, b[1] + (b[1] - a[1]) / l * ext]], vista: true };
  });
}
/** Re-seat a flat decal geometry on the terrain: every vertex at `dy` above yAt(x, z) (lane paint, zebras, patches). */
function drape(g, yAt, dy) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, dy + yAt(p.getX(i), p.getZ(i)));
  return g;
}
/** Surface normal of the terrain at (x, z) for tilting small instanced parts (null when flat). */
function slopeUp(yAt, x, z) {
  const hx = yAt(x + 0.5, z) - yAt(x - 0.5, z), hz = yAt(x, z + 0.5) - yAt(x, z - 0.5);
  return hx || hz ? [-hx, 1, -hz] : null;
}

// ------------------------------------------------------------------------------------------------ main
/**
 * buildStreets({ CITY, batch, inst, world, yAt, rng, group, materials }) → { field, kerbChains, materials }
 * `materials` = the materials module (engine.get('materials')); its PBR ground set is used when present.
 */
export function buildStreets({ CITY, batch, inst, world, yAt = () => 0, rng, group, materials = null }) {
  CITY = { ...CITY, roads: vistaRoads(CITY) };
  const M = makeMaterials(materials);
  const t0 = performance.now();
  // ---- base asphalt (a terrain grid: 2 m cells wherever the ground is sloped, 25 m elsewhere)
  const holes = HOLES(CITY);
  for (const g of terrainGeometry(yAt, holes)) {
    const ground = new THREE.Mesh(g, M.asphalt); ground.receiveShadow = true; ground.name = 'ground';
    group.add(ground);
  }
  // flat ground-level parts never cast a visible shadow: keep them out of the shadow pass
  batch.noShadow.add(M.sidewalk); batch.noShadow.add(M.kerb);
  // ---- sidewalk field
  const field = buildRoadField(CITY);
  const { iso, gutterIso } = buildSidewalks(field, batch, M, yAt, world, holes);
  const chains = chainSegments(iso);
  // tactile guidance strips along every kerb (skipping tiny loops)
  for (const ch of chains.flatMap(ch=>{const out=[];let run=[];for(let i=0;i<ch.length-1;i++){const a=ch[i],b=ch[i+1];if(nearKoji((a[0]+b[0])/2,(a[1]+b[1])/2)){if(run.length>1)out.push(run);run=[];}else{if(!run.length)run.push(a);run.push(b);}}if(run.length>1)out.push(run);return out;})) {
    if (L.polylineLength(ch) < 6) continue;
    const g = L.ribbon(ch, 0.3, (x, z) => SW_DECAL_Y + yAt(x, z), { uScale: 1 / 0.3 });
    if (g) batch.add(M.tactile, g, ch[0][0], ch[0][1]);
  }
  // gutters: darker low-roughness ribbon along the kerb foot + instanced drain grates every 12 m
  for (const ch of chainSegments(gutterIso)) {
    if (L.polylineLength(ch) < 6) continue;
    const g = L.ribbon(ch, 0.4, (x, z) => DECAL_Y + 0.001 + yAt(x, z), { uScale: 1 / 4 });
    if (g) batch.add(M.gutter, g, ch[0][0], ch[0][1]);
    const gk = L.ribbon(ch, 2.2, (x, z) => DECAL_Y + 0.0012 + yAt(x, z), { uScale: 1 / 4 });   // grime fading 1 m out from the kerb
    if (gk) batch.add(M.kerbGrime, gk, ch[0][0], ch[0][1]);
    for (const p of L.alongPolyline(ch, 12, 5)) inst.add('grate', GRATE_GEO, M.grate, p.x, DECAL_Y + 0.004 + yAt(p.x, p.z), p.z, L.rotYOf(p.dx, p.dz), 1, 1, 1, null, slopeUp(yAt, p.x, p.z));
  }
  const roadNear = (x, z, exclude, pad) => {
    for (const s of field.segs) {
      if (s.road === exclude) continue;
      if (x < s.x0 - pad || x > s.x1 + pad || z < s.z0 - pad || z > s.z1 + pad) continue;
      if (L.distToSegment(x, z, s.ax, s.az, s.bx, s.bz) < s.half + pad) return true;
    }
    return false;
  };
  const cc = CITY.crossing;
  const inCrossing = (x, z, pad = 1) => Math.hypot(x - cc.center[0], z - cc.center[1]) < cc.radius + pad;
  const dash = (x, z, dx, dz, len, wid, mat) => batch.add(mat, drape(L.stripRect(x, z, len, wid, L.rotYOf(dx, dz), 0), yAt, DECAL_Y), x, z);
  const nearCrosswalk = (x, z) => { for (const c of [...cc.crosswalks, ...CITY.crosswalksExtra]) if (L.distToSegment(x, z, c.a[0], c.a[1], c.b[0], c.b[1]) < c.width / 2 + 1.5) return true; return false; };
  // ---- lane paint
  for (const r of CITY.roads) {
    const half = r.width / 2, laneW = r.width / Math.max(1, r.lanes);
    const lines = [];
    if (!r.oneway && r.lanes >= 2) lines.push({ off: 0, mat: r.lanes >= 4 ? M.paintY : M.paint, dashed: r.lanes < 4, wid: 0.15 });
    if (r.lanes >= 4) { const n = r.lanes / 2; for (let k = 1; k < n; k++) { lines.push({ off: k * laneW, mat: M.paint, dashed: true, wid: 0.15 }); lines.push({ off: -k * laneW, mat: M.paint, dashed: true, wid: 0.15 }); } }
    if (r.oneway && r.lanes >= 2) for (let k = 1; k < r.lanes; k++) lines.push({ off: -half + k * laneW, mat: M.paint, dashed: true, wid: 0.15 });
    if (r.width >= 7) { lines.push({ off: half - 0.3, mat: M.paint, dashed: false, wid: 0.15 }); lines.push({ off: -half + 0.3, mat: M.paint, dashed: false, wid: 0.15 }); }
    for (const ln of lines) {
      const pts = L.offsetPolyline(r.path, ln.off);
      const step = ln.dashed ? 8 : 2.5, len = ln.dashed ? 3 : 2.6;
      for (const p of L.alongPolyline(pts, step, ln.dashed ? 4 : 1.3)) {
        if (inCrossing(p.x, p.z, 2) || roadNear(p.x, p.z, r, 0.5) || (ln.off === 0 && nearCrosswalk(p.x, p.z))) continue;
        dash(p.x, p.z, p.dx, p.dz, len, ln.wid, ln.mat);
      }
    }
    // manholes down the carriageway + tar patches (6–8 per 100 m)
    for (const p of L.alongPolyline(r.path, 27, 11)) {
      if (inCrossing(p.x, p.z, 0)) continue;
      const side = rng.range(-half + 1.5, half - 1.5);
      const x = p.x - p.dz * side, z = p.z + p.dx * side;
      inst.add('manhole', MANHOLE_GEO, M.manhole, x, DECAL_Y + yAt(x, z), z, rng.range(0, 6.28), 1, 1, 1, null, slopeUp(yAt, x, z));
    }
    for (const p of (r.scope || r.id==='dg_koji' ? [] : L.alongPolyline(r.path, 14, 5))) {
      if (inCrossing(p.x, p.z, 2) || nearCrosswalk(p.x, p.z)) continue;
      const side = rng.range(-half + 1.2, half - 1.2);
      const x = p.x - p.dz * side, z = p.z + p.dx * side;
      batch.add(M.patch, drape(L.stripRect(x, z, rng.range(1.4, 3.4), rng.range(0.8, 1.9), L.rotYOf(p.dx, p.dz) + rng.range(-0.25, 0.25), 0), yAt, DECAL_Y + 0.0015), x, z);
    }
  }
  // ---- bus-only lanes (西口 terminal): solid edge lines, バス専用 every 24 m; a バス box at every stop bay
  const textDecal = (x, z, tx, tz, cell, across, along) => {
    const g = drape(L.stripRect(x, z, across, along, Math.atan2(-tx, -tz), 0, [cell / 2, 0, (cell + 1) / 2, 1]), yAt, DECAL_Y + 0.004);
    batch.add(M.roadText, g, x, z);
  };
  const nearStop = (x, z) => (CITY.busStops || []).some(s => Math.hypot(s.pos[0] - x, s.pos[1] - z) < 9);
  for (const r of CITY.busways || []) {
    const half = r.width / 2;
    for (const off of [half - 0.25, -half + 0.25]) {
      for (const p of L.alongPolyline(L.offsetPolyline(r.path, off), 2.5, 1.3)) {
        if (roadNear(p.x, p.z, r, -0.6) || nearCrosswalk(p.x, p.z)) continue;
        dash(p.x, p.z, p.dx, p.dz, 2.6, 0.15, M.paint);
      }
    }
    for (const p of L.alongPolyline(r.path, 24, 14)) {
      if (roadNear(p.x, p.z, r, 0) || nearCrosswalk(p.x, p.z) || nearStop(p.x, p.z)) continue;
      textDecal(p.x, p.z, p.dx, p.dz, 0, r.width - 1.2, 3.4);
    }
  }
  for (const s of CITY.busStops || []) {
    const dx = Math.cos(s.heading), dz = -Math.sin(s.heading);   // rotY → travel direction
    textDecal(s.pos[0] - dx * 3, s.pos[1] - dz * 3, dx, dz, 1, 1.9, 2.6);
    // bay outline: 13 m yellow dashes along both sides of the stopping position
    for (const side of [1, -1]) {
      const ox = -dz * side * 1.45, oz = dx * side * 1.45;
      for (let k = -6; k <= 6; k += 1.5) dash(s.pos[0] + dx * k + ox, s.pos[1] + dz * k + oz, dx, dz, 0.75, 0.15, M.paintY);
    }
  }
  // ---- zebra crossings (perimeter, diagonals, mid-block) + stop lines. Stripes vary: three paint tones, 3–5 cm
  //      endpoint noise, 8 % worn stripes with a missing cell
  const paints = [M.paint, M.paint, M.paint2, M.paint2, M.paint3];
  const withDir = (g, tx, tz, flag) => { const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = tx; a[i * 3 + 1] = tz; a[i * 3 + 2] = flag; } g.setAttribute('binfo', new THREE.BufferAttribute(a, 3)); return g; };
  const zebra = (c, seed = 0) => {
    const dx = c.b[0] - c.a[0], dz = c.b[1] - c.a[1], len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len, rot = L.rotYOf(-uz, ux);
    const Z = (g) => withDir(g, -uz, ux, 1);
    let k = 0;
    for (let s = 0.7; s < len - 0.4; s += 0.9, k++) {
      const jx = (L.hash(k, 1, seed) - 0.5) * 0.06, jl = (L.hash(k, 2, seed) - 0.5) * 0.1;
      const x = c.a[0] + ux * s + jx * -uz, z = c.a[1] + uz * s + jx * ux;
      const mat = paints[Math.floor(L.hash(k, 3, seed) * paints.length)], y = DECAL_Y + 0.002;
      const w = c.width + jl;
      if (L.hash(k, 4, seed) < 0.08) {   // worn: two pieces with a gap
        const g = 0.2 + L.hash(k, 5, seed) * 0.6, gw = 0.5 + L.hash(k, 6, seed) * 0.5;
        const l1 = w * g - gw / 2, l2 = w * (1 - g) - gw / 2;
        batch.add(mat, Z(drape(L.stripRect(x + ux * (-w / 2 + l1 / 2), z + uz * (-w / 2 + l1 / 2), l1, 0.45, rot, 0), yAt, y)), x, z);
        batch.add(mat, Z(drape(L.stripRect(x + ux * (w / 2 - l2 / 2), z + uz * (w / 2 - l2 / 2), l2, 0.45, rot, 0), yAt, y)), x, z);
      } else batch.add(mat, Z(drape(L.stripRect(x, z, w, 0.45, rot, 0), yAt, y)), x, z);
    }
  };
  let zi = 0;
  for (const c of cc.crosswalks) zebra(c, ++zi);
  for (const c of cc.diagonals) zebra(c, ++zi);
  for (const c of CITY.crosswalksExtra) {
    zebra(c, ++zi);
    if (c.stops) {   // divided road / terminal: one stop line per carriageway, given explicitly
      for (const s of c.stops) {
        const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], x = (s.a[0] + s.b[0]) / 2, z = (s.a[1] + s.b[1]) / 2;
        batch.add(M.paint, drape(L.stripRect(x, z, Math.hypot(dx, dz), 0.45, L.rotYOf(dx, dz), 0), yAt, DECAL_Y + 0.002), x, z);
      }
      continue;
    }
    // stop lines 2 m before the crossing on each approach (left-hand traffic → left half of the road)
    const dx = c.b[0] - c.a[0], dz = c.b[1] - c.a[1], len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;                // across the road
    const rx = -uz, rz = ux;                           // along the road
    const mx = (c.a[0] + c.b[0]) / 2, mz = (c.a[1] + c.b[1]) / 2;
    for (const sgn of [1, -1]) {
      const dxr = rx * sgn, dzr = rz * sgn;             // travel direction
      const lx = dzr, lz = -dxr;                        // left of travel
      const sx = mx - dxr * (c.width / 2 + 2), sz = mz - dzr * (c.width / 2 + 2);
      const cx = sx + lx * len / 4, cz = sz + lz * len / 4;
      batch.add(M.paint, drape(L.stripRect(cx, cz, len / 2 - 0.6, 0.45, L.rotYOf(lx, lz), 0), yAt, DECAL_Y + 0.002), cx, cz);
    }
  }
  for (const s of cc.stopLines) {
    const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], len = Math.hypot(dx, dz);
    const x = (s.a[0] + s.b[0]) / 2, z = (s.a[1] + s.b[1]) / 2;
    batch.add(M.paint, drape(L.stripRect(x, z, len, 0.45, L.rotYOf(dx, dz), 0), yAt, DECAL_Y + 0.002), x, z);
  }
  // ---- the scramble's own repair history: crack-seal seams and cut patches (one atlas decal, drawn under the paint),
  //      extra utility covers — a 50 m junction under this much traffic is never new-build asphalt
  {
    const R = cc.radius - 2, rr = (a, b) => a + (b - a) * rng();
    for (let i = 0; i < 34; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * R, x = cc.center[0] + Math.cos(a) * d, z = cc.center[1] + Math.sin(a) * d;
      if (field.sample(x, z) > -0.5) continue;
      const kind = i % 5 < 3 ? (i % 2) : 2 + (i % 2), ang = rng() * Math.PI;
      const len = kind < 2 ? rr(3, 7) : rr(0.9, 2.2), wid = kind < 2 ? rr(0.35, 0.6) : len * (kind === 2 ? rr(0.7, 1.2) : 1);
      batch.add(M.repairs, drape(L.stripRect(x, z, len, wid, ang, 0, [kind / 4 + 0.004, 0.02, (kind + 1) / 4 - 0.004, 0.98]), yAt, DECAL_Y + 0.0008), x, z);
    }
    for (let i = 0; i < 9; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * R, x = cc.center[0] + Math.cos(a) * d, z = cc.center[1] + Math.sin(a) * d;
      if (field.sample(x, z) > -1) continue;
      inst.add('manhole', MANHOLE_GEO, M.manhole, x, DECAL_Y + yAt(x, z), z, rng() * 6.28, i % 3 ? 1 : 0.7, 1, i % 3 ? 1 : 0.7);
    }
  }
  // ---- lane arrows on the four approaches to the scramble
  const approaches = [
    { road: 'dogenzaka_shita', from: [-40, -5], dir: [-1, 0] },   // eastbound traffic approaches from the west: arrows sit west of the stop line
    { road: 'koen', from: [8, -30], dir: [0, -1] },
    { road: 'miyamasu', from: [26, 0], dir: [1, 0] },
    { road: 'ekimae_s', from: [-9.1, 23], dir: [-0.124, 0.992], laneW: 3.3 },   // the 2 + 2 lane throat: arrows on its 北行 lanes
  ];
  for (const ap of approaches) {
    const r = CITY.roads.find(q => q.id === ap.road); if (!r) continue;
    const laneW = ap.laneW || r.width / r.lanes, nl = Math.max(1, Math.floor(r.lanes / 2));
    const [dx, dz] = ap.dir;                 // pointing away from the crossing (back along the approach)
    // approaching traffic (travelling −dir) keeps left: left of (−dx,−dz) = (−dz, dx)
    const kx = -dz, kz = dx;
    for (let li = 0; li < nl; li++) {
      const off = (li + 0.5) * laneW;
      const kind = nl === 1 ? 'straight' : li === 0 ? 'straightLeft' : li === nl - 1 ? 'right' : 'straight';
      const cell = { straight: 0, left: 1, right: 2, straightLeft: 3 }[kind];
      for (const back of [7, 19]) {
        const x = ap.from[0] + dx * back + kx * off, z = ap.from[1] + dz * back + kz * off;
        // canvas arrow points along +v; after stripRect that is −z, rotated so it points at the crossing (−dir)
        const g = drape(L.stripRect(x, z, 1.6, 3.6, Math.atan2(dx, dz), 0, [cell / 4, 0, (cell + 1) / 4, 1]), yAt, DECAL_Y + 0.004);
        batch.add(M.arrows, g, x, z);
      }
    }
  }
  // ---- medians (raised kerb strips with hedges) on the wide roads
  for (const id of ['meiji_ne', 'tamagawa']) {
    const r = CITY.roads.find(q => q.id === id); if (!r) continue;
    const pts = L.resample(r.path, 4);
    let run = [];
    const flush = () => {
      if (run.length >= 3) {
        const left = L.offsetPolyline(run, 0.8), right = L.offsetPolyline(run, -0.8).reverse();
        const poly = [...left, ...right];
        batch.add(M.kerb, L.extrudePolygon(poly, 0, SW_H, { cap: true, uvScale: 1 }), run[0][0], run[0][1]);
        for (const p of L.alongPolyline(run, 3, 1.5)) inst.add('hedge', HEDGE_GEO, M.green, p.x, SW_H + 0.35 + yAt(p.x, p.z), p.z, 0, 1.2, 0.8, 1);
      }
      run = [];
    };
    for (const p of pts) {
      if (inCrossing(p[0], p[1], 6) || roadNear(p[0], p[1], r, 3) || nearCrosswalk(p[0], p[1])) flush(); else run.push(p);
    }
    flush();
  }
  // ---- pedestrian street paving + plazas
  const surfMat = { paving: M.paver, brick: M.brick, stone: M.granite, asphalt: null };
  for (const p of CITY.pedestrianStreets) {
    // Explicit asphalt entries need no raised paving overlay, including lane mouths.
    const mat = Object.hasOwn(surfMat, p.surface) ? surfMat[p.surface] : M.paver;
    if (!mat) continue;
    const g = L.ribbon(L.resample(p.path, 2), p.width, (x, z) => SW_DECAL_Y + yAt(x, z), { uScale: 1 / 4 });
    if (g) batch.add(mat, g, p.path[0][0], p.path[0][1]);
  }
  for (const p of CITY.plazas) {
    const mat = p.id === 'hachiko' ? M.granite : p.id === 'moyai' ? M.granite : p.id === 'inaribashi' ? M.paver : null;
    if (!mat) continue;
    batch.add(mat, L.polygonCap(p.polygon, SW_DECAL_Y, 1 / 7), p.polygon[0][0], p.polygon[0][1]);
    if (mat !== M.granite) continue;
    // granite plazas: 2 m tile grid with lightness jitter over the cap, a drain channel ribbon 1.5 m in from the
    // edge with grates every 10 m
    const poly = L.ensureCW(p.polygon);
    const tiles = tileGrid(poly, SW_DECAL_Y + 0.004);
    if (tiles) batch.add(M.graniteTiles, tiles, poly[0][0], poly[0][1]);
    const ring = L.offsetPolygon(poly, -1.5); ring.push(ring[0]);
    const g = L.ribbon(ring, 0.3, (x, z) => SW_DECAL_Y + 0.008 + yAt(x, z), { uScale: 1 / 3 });
    if (g) batch.add(M.drain, g, ring[0][0], ring[0][1]);
    for (const q of L.alongPolyline(ring, 10, 4)) inst.add('grate', GRATE_GEO, M.grate, q.x, SW_DECAL_Y + 0.01 + yAt(q.x, q.z), q.z, L.rotYOf(q.dx, q.dz), 1, 1, 1, null, slopeUp(yAt, q.x, q.z));
  }
  const ms = performance.now() - t0;
  return { field, kerbChains: chains, materials: M, ms };
}

export default { buildStreets, buildRoadField, setWetFactor, SW_H };
