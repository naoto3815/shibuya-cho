// [city] Small landmarks: モヤイ像 (grey stone head at the west exit) and 宇田川交番 (2-storey police box), plus the
// shared koban() builder that ハチ公前広場 reuses for 渋谷駅前交番. World-space batched geometry; signs in the group.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, wallMacro, tagWall } from './genericBuilding.js';

export const KEYS = ['moyai', 'udagawaKoban'];

const SPH = new THREE.SphereGeometry(1, 20, 14);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 14);

/**
 * 交番: grimed tan-tile box (w × d, `storeys`) on a granite base with a step, 0.7 m dark eave slab with soffit
 * downlights, framed (12 cm reveal) lit door + windows, 交番 sign, red police lamp (glass cylinder on a post),
 * emblem. `rotY` = cityData facing (direction the door points). Returns colliders.
 */
let kobanStoneMat = null, kobanBandMat = null;
/** Dark flamed granite cladding on a 0.9 × 0.6 m panel grid (渋谷駅前交番). */
function kobanStone() {
  if (kobanStoneMat) return kobanStoneMat;
  const map = L.noiseTex({ size: 256, base: [92, 94, 98], variance: 14, seed: 211, low: 0.8, draw: (ctx, s) => {
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) { const v = (L.hash(r, c, 212) - 0.5) * 22; ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`; ctx.fillRect(c * s / 3, r * s / 5, s / 3, s / 5); }
    ctx.fillStyle = 'rgba(20,20,22,0.8)';
    for (let r = 0; r <= 5; r++) ctx.fillRect(0, Math.round(r * s / 5) - 1, s, 2);
    for (let c = 0; c <= 3; c++) ctx.fillRect(Math.round(c * s / 3) - 1, 0, 2, s);
  } });
  map.repeat.set(1 / 2.7, 1 / 3.0);
  // grimed: the wall macro layer adds drips under the upper sills, soot at street level and per-panel drift
  kobanStoneMat = wallMacro(L.std({ map, roughness: 0.5, metalness: 0.05, envMapIntensity: 1.0 })); kobanStoneMat.name = 'lm_kobanStone';
  return kobanStoneMat;
}
let badgeMat = null;
/** 旭日章: gold sunburst star on a dark disc (a flat emblem plate, faintly self-lit). */
function kobanBadge() {
  if (badgeMat) return badgeMat;
  const c = L.makeCanvas(128, 128), x = c.getContext('2d');
  x.fillStyle = '#16181c'; x.beginPath(); x.arc(64, 64, 62, 0, 6.3); x.fill();
  x.fillStyle = '#c9a23a';
  for (let i = 0; i < 5; i++) { const a0 = -Math.PI / 2 + i * 2 * Math.PI / 5; x.beginPath(); x.moveTo(64, 64); x.lineTo(64 + Math.cos(a0 - 0.2) * 20, 64 + Math.sin(a0 - 0.2) * 20); x.lineTo(64 + Math.cos(a0) * 56, 64 + Math.sin(a0) * 56); x.lineTo(64 + Math.cos(a0 + 0.2) * 20, 64 + Math.sin(a0 + 0.2) * 20); x.closePath(); x.fill(); }
  for (let i = 0; i < 20; i++) { const a = i * Math.PI / 10; x.strokeStyle = 'rgba(232,196,90,0.7)'; x.lineWidth = 2; x.beginPath(); x.moveTo(64 + Math.cos(a) * 14, 64 + Math.sin(a) * 14); x.lineTo(64 + Math.cos(a) * 34, 64 + Math.sin(a) * 34); x.stroke(); }
  x.fillStyle = '#f0d070'; x.beginPath(); x.arc(64, 64, 9, 0, 6.3); x.fill();
  const t = L.canvasTex(c);
  badgeMat = S.nightMaterial(L.std({ map: t, emissiveMap: t, emissive: 0xffffff, roughness: 0.35, metalness: 0.6, transparent: true, alphaTest: 0.5 }), 0.05, 0.35);
  badgeMat.name = 'lm_kobanBadge';
  return badgeMat;
}
/**
 * 渋谷駅前交番 (the Hachiko koban): dark granite-clad block, a sculpted overhanging roof cap (a low hipped "hat" with
 * a white fascia), the red lamp on a bracket at the front corner, a dim interior behind the door and the 交番 KOBAN
 * plate on a dark ground above it (only the letters glow).
 */
function kobanHachiko(ctx, x, z, rotY, { w = 5.4, d = 4.8, storeys = 2, name = '渋谷駅前交番' } = {}) {
  const { batch, inst } = ctx;
  const M = S.mats(), At = getAtlases(), stone = kobanStone();
  const [fx, fz] = S.dirOf(rotY);
  const tx = -fz, tz = fx, rot = L.rotYOf(tx, tz);
  const SH = 3.1, h = storeys * SH;
  const poly = L.rectPoly(x, z, w, d, rot);
  batch.add(stone, tagWall(L.extrudePolygon(poly, -0.1, h, { cap: false, uvScale: 1 }), [0, SH, SH]), x, z);
  batch.add(At.roofMat, L.polygonCap(poly, h, 0.25), x, z);
  batch.add(M.granite, L.extrudePolygon(L.offsetPolygon(poly, 0.05), -0.1, 0.35, { cap: true, uvScale: 1 }), x, z);   // plinth course
  // roof cap: 0.9 m overhang slab, then a low hipped cap rising 1.1 m, white fascia band on the slab edge
  const cap0 = L.offsetPolygon(poly, 0.9), cap1 = L.offsetPolygon(poly, -0.9);
  const capB = L.offsetPolygon(poly, 0.82);
  batch.add(M.darkMetal, L.extrudePolygon(cap0, h, h + 0.26, { cap: false, bottom: true, uvScale: 1 }), x, z);
  batch.add(M.darkMetal, L.loft(cap0, capB, h + 0.26, h + 0.34), x, z);                                   // bevelled fascia edge
  batch.add(M.whiteMetal, L.extrudePolygon(L.offsetPolygon(poly, 0.93), h + 0.07, h + 0.2, { cap: false, uvScale: 1 }), x, z);
  batch.add(M.darkMetal, L.loft(capB, cap1, h + 0.34, h + 1.4), x, z);
  // soffit LED line under the overhang, 25 cm in from the fascia (lights the granite, reads from the square)
  { const ring = L.offsetPolygon(poly, 0.62); for (let i = 0; i < 4; i++) { const a = ring[i], b = ring[(i + 1) % 4]; batch.add(M.glowWhiteDim, L.boxAt((a[0] + b[0]) / 2, h - 0.02, (a[1] + b[1]) / 2, Math.hypot(b[0] - a[0], b[1] - a[1]) - 0.3, 0.03, 0.06, L.rotYOf(b[0] - a[0], b[1] - a[1]), false), x, z); } }
  batch.add(M.darkMetal, L.polygonCap(cap1, h + 1.4, 0.5), x, z);
  for (const lx of [-w / 3, 0, w / 3]) S.ibox(inst, 'lm_downlight', M.glowWarm, x + fx * (d / 2 + 0.5) + tx * lx, h - 0.02, z + fz * (d / 2 + 0.5) + tz * lx, 0.3, 0.05, 0.3);
  const front = (lx, lz) => [x + fx * lz + tx * lx, z + fz * lz + tz * lx];
  const frame = (cx, cy, cz, nx, nz, ww, hh, depth = 0.1) => {
    const r = L.rotYOf(nz, -nx);
    for (const s of [-1, 1]) batch.add(M.darkMetal, L.boxAt(cx + nz * s * (ww / 2 + 0.04) + nx * depth / 2, cy, cz - nx * s * (ww / 2 + 0.04) + nz * depth / 2, 0.08, hh + 0.16, depth, r, false), x, z);
    for (const s of [-1, 1]) batch.add(M.darkMetal, L.boxAt(cx + nx * depth / 2, cy + s * (hh / 2 + 0.04), cz + nz * depth / 2, ww + 0.16, 0.08, depth, r, false), x, z);
  };
  // door: dim lit interior (≤ 0.5) behind glass, split leaves; counter window beside it
  const dw = 1.4, gh = 2.3;
  const [dx0, dz0] = front(-w / 4 + 0.1, d / 2);
  batch.add(M.interiorDim, L.wallQuad(dx0, 0.35 + gh / 2, dz0, fx, fz, dw, gh, 0.02), x, z);
  batch.add(M.glassClear, L.wallQuad(dx0, 0.35 + gh / 2, dz0, fx, fz, dw, gh, 0.06), x, z);
  batch.add(M.darkMetal, L.wallQuad(dx0, 0.35 + gh / 2, dz0, fx, fz, 0.07, gh, 0.08), x, z);
  frame(dx0, 0.35 + gh / 2, dz0, fx, fz, dw, gh);
  batch.add(M.granite, L.boxAt(dx0 + fx * 0.4, 0.17, dz0 + fz * 0.4, dw + 0.9, 0.34, 0.8, rot, true), x, z);
  const [wx, wz] = front(w / 4 + 0.1, d / 2);
  batch.add(M.interiorDim, L.wallQuad(wx, 1.65, wz, fx, fz, w / 2 - 1.0, 1.3, 0.02), x, z);
  batch.add(M.glassClear, L.wallQuad(wx, 1.65, wz, fx, fz, w / 2 - 1.0, 1.3, 0.06), x, z);
  frame(wx, 1.65, wz, fx, fz, w / 2 - 1.0, 1.3);
  // upper floor: real glass (env reflection) over a dim duty-room interior, framed; side windows the same
  for (let s2 = 1; s2 < storeys; s2++) {
    const y = s2 * SH + 1.5;
    const pane = (px, pz, nx, nz, ww, hh) => { batch.add(M.interiorDim, L.wallQuad(px, y, pz, nx, nz, ww, hh, 0.01), x, z); batch.add(M.glassClear, L.wallQuad(px, y, pz, nx, nz, ww, hh, 0.05), x, z); batch.add(M.darkMetal, L.wallQuad(px, y + 0.1, pz, nx, nz, ww, 0.05, 0.07), x, z); frame(px, y, pz, nx, nz, ww, hh); };
    for (const lx of [-w / 4, w / 4]) { const [px, pz] = front(lx, d / 2); pane(px, pz, fx, fz, 1.6, 1.2); }
    for (const sgn of [-1, 1]) { const [px, pz] = front(sgn * w / 2, 0); pane(px, pz, tx * sgn, tz * sgn, 1.4, 1.1); }
  }
  // 交番 KOBAN plate over the door on a dark matte signboard band (letters only glow; the matte band also keeps
  // the soffit lamps from burning hot spots into the facade) + gold emblem between the upper windows
  const [sx, sz] = front(0, d / 2);
  if (!kobanBandMat) { kobanBandMat = L.std({ color: 0x1c1e22, roughness: 0.85, metalness: 0 }); kobanBandMat.name = 'lm_kobanBand'; }
  batch.add(kobanBandMat, L.boxAt(sx + fx * 0.08, 3.25, sz + fz * 0.08, w + 0.02, 1.1, 0.16, rot, false), x, z);
  S.flatSign(ctx.group, sx + fx * 0.18, 3.25, sz + fz * 0.18, fx, fz, { text: '交番', sub: `KOBAN  ${name}`, w: w - 1.6, h: 0.72, bg: '#15171c', fg: '#f2efe6', emissive: 0.8, weight: '800' });
  batch.add(kobanBadge(), L.wallQuad(sx, 4.45, sz, fx, fz, 0.62, 0.62, 0.03), x, z);                        // 旭日章
  // red lamp on a bracket at the front-right corner (a point lamp, 2.9 m up)
  const [cx0, cz0] = front(w / 2, d / 2), ox = (fx + tx) * 0.7071, oz = (fz + tz) * 0.7071;
  batch.add(M.darkMetal, L.boxAt(cx0 + ox * 0.3, 2.95, cz0 + oz * 0.3, 0.6, 0.07, 0.07, L.rotYOf(ox, oz), false), x, z);
  batch.add(M.darkMetal, S.placed(CYL, cx0 + ox * 0.6, 3.05, cz0 + oz * 0.6, { s: [0.05, 0.25, 0.05] }), x, z);
  batch.add(M.lampGlass, S.placed(SPH, cx0 + ox * 0.6, 2.85, cz0 + oz * 0.6, { s: 0.2 }), x, z);
  batch.add(M.darkMetal, S.placed(CYL, cx0 + ox * 0.6, 3.1, cz0 + oz * 0.6, { s: [0.16, 0.06, 0.16] }), x, z);
  // lamp housing: a hooded cage over the globe + drip cap, wall back-plate at the bracket root
  batch.add(M.darkMetal, S.placed(new THREE.CylinderGeometry(0.24, 0.26, 0.1, 16), cx0 + ox * 0.6, 3.02, cz0 + oz * 0.6), x, z);
  for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; batch.add(M.darkMetal, L.boxAt(cx0 + ox * 0.6 + Math.cos(a) * 0.21, 2.86, cz0 + oz * 0.6 + Math.sin(a) * 0.21, 0.025, 0.34, 0.025, 0, false), x, z); }
  batch.add(M.darkMetal, S.placed(new THREE.CylinderGeometry(0.1, 0.06, 0.08, 12), cx0 + ox * 0.6, 2.62, cz0 + oz * 0.6), x, z);
  batch.add(M.darkMetal, L.boxAt(cx0 + ox * 0.03, 2.95, cz0 + oz * 0.03, 0.28, 0.4, 0.06, L.rotYOf(ox, oz) + Math.PI / 2, false), x, z);
  return [S.boxCollider(x, z, w + 0.2, h, d + 0.2, rot)];
}

export function koban(ctx, x, z, rotY, { w = 5.2, d = 4.6, storeys = 2, name = '渋谷駅前交番', hachiko = false } = {}) {
  if (hachiko) return kobanHachiko(ctx, x, z, rotY, { w, d, storeys, name });
  const { batch, inst, group } = ctx;
  const M = S.mats(), At = getAtlases();
  const tile = At.walls[0];                                 // tileBeige with grime
  const [fx, fz] = S.dirOf(rotY);
  const tx = -fz, tz = fx;                                  // tangent (left→right seen from the front)
  const rot = L.rotYOf(tx, tz);
  const SH = 3.1, h = storeys * SH;
  const poly = L.rectPoly(x, z, w, d, rot);
  S.prism(batch, tile, poly, -0.1, h, { uvScale: 0.5, capMat: At.roofMat });
  batch.add(M.darkMetal, L.boxAt(x, h + 0.2, z, w + 1.4, 0.4, d + 1.4, rot, true), x, z);       // 0.7 m eave slab (soffit = its underside)
  batch.add(M.darkMetal, L.boxAt(x, h + 0.45, z, w + 0.2, 0.12, d + 0.2, rot, false), x, z);    // eave upstand
  batch.add(tile, L.boxAt(x, h + 0.7, z, w - 0.6, 0.6, d - 0.6, rot, false), x, z);             // roof kerb
  inst.add('acBig', At.geos.acBig, At.acMat, x - tx * (w / 4), h + 1.0, z - tz * (w / 4), rot, 0.6, 0.6, 0.6, 0xbcbcb8);
  batch.add(M.granite, L.extrudePolygon(L.offsetPolygon(poly, 0.06), -0.1, 0.5, { cap: false, uvScale: 1 }), x, z);   // granite base
  const front = (lx, ly, lz) => [x + fx * lz + tx * lx, ly, z + fz * lz + tz * lx];
  const frame = (cx, cy, cz, nx, nz, ww, hh, depth = 0.12) => {                                                        // reveal frame: jambs + head + sill proud of the wall
    const ttx = nz, ttz = -nx, r = L.rotYOf(ttx, ttz);
    for (const s of [-1, 1]) batch.add(M.darkMetal, L.boxAt(cx + ttx * s * (ww / 2 + 0.04) + nx * depth / 2, cy, cz + ttz * s * (ww / 2 + 0.04) + nz * depth / 2, 0.08, hh + 0.16, depth, r, false), x, z);
    for (const s of [-1, 1]) batch.add(M.darkMetal, L.boxAt(cx + nx * depth / 2, cy + s * (hh / 2 + 0.04), cz + nz * depth / 2, ww + 0.16, 0.08, depth, r, false), x, z);
  };
  // door (lit, split, with a granite step) + side window on the front face, small windows on the other faces
  const dw = 1.3, gh = SH - 0.5;
  const [dx0, , dz0] = front(-w / 4 + 0.2, 0, d / 2);
  batch.add(M.interior, L.wallQuad(dx0, 0.15 + gh / 2, dz0, fx, fz, dw, gh, 0.02), x, z);
  batch.add(M.glassClear, L.wallQuad(dx0, 0.15 + gh / 2, dz0, fx, fz, dw, gh, 0.06), x, z);
  batch.add(M.darkMetal, L.wallQuad(dx0, 0.15 + gh / 2, dz0, fx, fz, 0.08, gh, 0.08), x, z);   // door split
  batch.add(M.darkMetal, L.boxAt(dx0 + fx * 0.09 + tx * 0.42, 1.1, dz0 + fz * 0.09 + tz * 0.42, 0.04, 0.3, 0.04, rot, false), x, z);   // handle
  frame(dx0, 0.15 + gh / 2, dz0, fx, fz, dw, gh);
  batch.add(M.granite, L.boxAt(dx0 + fx * 0.35, 0.1, dz0 + fz * 0.35, dw + 0.8, 0.2, 0.7, rot, true), x, z);              // step
  const lit = At.win.cells.wide.filter(c => c.lit), litN = At.win.cells.normal.filter(c => c.lit);
  const [wx, , wz] = front(w / 4, 0, d / 2);
  const c0 = lit[2];
  batch.add(At.win.mat, L.wallQuad(wx, 1.75, wz, fx, fz, w / 2 - 0.9, 1.6, 0.04, [c0.u0, c0.v0, c0.u1, c0.v1]), x, z);
  frame(wx, 1.75, wz, fx, fz, w / 2 - 0.9, 1.6);
  batch.add(M.granite, L.boxAt(wx + fx * 0.1, 0.93, wz + fz * 0.1, w / 2 - 0.6, 0.06, 0.2, rot, false), x, z);            // sill
  for (let s = 1; s < storeys; s++) {
    const y = s * SH + 1.6;
    const c1 = litN[(s * 3) % litN.length];
    for (const lx of [-w / 4, w / 4]) { const [px, , pz] = front(lx, 0, d / 2); batch.add(At.win.mat, L.wallQuad(px, y, pz, fx, fz, 1.4, 1.3, 0.04, [c1.u0, c1.v0, c1.u1, c1.v1]), x, z); frame(px, y, pz, fx, fz, 1.4, 1.3); }
    for (const sgn of [-1, 1]) { const [px, , pz] = front(sgn * w / 2, 0, 0); batch.add(At.win.mat, L.wallQuad(px, y, pz, tx * sgn, tz * sgn, 1.2, 1.2, 0.04, [c1.u0, c1.v0, c1.u1, c1.v1]), x, z); frame(px, y, pz, tx * sgn, tz * sgn, 1.2, 1.2); }
  }
  // 交番 sign over the door, soffit downlights, red lamp (glass cylinder on a post), gold emblem, police strip light
  const [sx, , sz] = front(0, 0, d / 2);
  S.flatSign(group, sx + fx * 0.28, SH + 0.05, sz + fz * 0.28, fx, fz, { text: '交番', sub: `KOBAN  ${name}`, w: 2.6, h: 0.72, bg: '#ffffff', fg: '#111111', emissive: 0.8, weight: '800' });
  for (const lx of [-w / 4 + 0.2, w / 4]) { const [px, , pz] = front(lx, 0, d / 2 + 0.4); S.ibox(inst, 'lm_downlight', M.glowWarm, px, h - 0.02, pz, 0.35, 0.06, 0.35); }
  const [lx, , lz] = front(w / 2 - 0.5, 0, d / 2 - 0.5);
  S.ibox(inst, 'lm_post', M.silver, lx, h + 0.4, lz, 0.08, 1.0, 0.08);
  batch.add(M.darkMetal, S.placed(CYL, lx, h + 1.42, lz, { s: [0.16, 0.05, 0.16] }), x, z);
  batch.add(M.lampGlass, S.placed(CYL, lx, h + 1.62, lz, { s: [0.125, 0.35, 0.125] }), x, z);
  batch.add(M.darkMetal, S.placed(CYL, lx, h + 1.82, lz, { s: [0.15, 0.05, 0.15] }), x, z);
  batch.add(M.bronze, S.placed(CYL, sx + fx * 0.06, SH + 1.0, sz + fz * 0.06, { rx: Math.PI / 2, ry: rot, s: [0.32, 0.06, 0.32] }), x, z);
  S.glowBar(batch, M.glowWhite, sx + fx * 0.12, SH - 0.32, sz + fz * 0.12, w - 0.6, 0.06, 0.06, rot);
  return [S.boxCollider(x, z, w + 0.2, h, d + 0.2, rot)];
}

/** モヤイ像 — 2.5 m grey stone head with brow ridge, long nose and a hair mass, on a low granite base. */
function moyai(ctx, x, z, rotY) {
  const { batch } = ctx;
  const M = S.mats();
  const [fx, fz] = S.dirOf(rotY);
  const ry = Math.atan2(fx, fz);                             // local +z → facing direction, local +x → (fz, −fx)
  const P = (geo, lx, ly, lz, o = {}) => batch.add(M.granite, S.placed(geo, x + fz * lx + fx * lz, ly, z - fx * lx + fz * lz, { ...o, ry: (o.ry || 0) + ry }), x, z);
  batch.add(M.granite, L.boxAt(x, 0.2, z, 2.6, 0.4, 2.2, ry, true), x, z);                 // base
  P(SPH, 0, 1.55, 0, { s: [0.72, 1.12, 0.62] });                                            // skull
  P(SPH, 0, 0.95, 0.1, { s: [0.62, 0.5, 0.55] });                                           // jaw
  P(new THREE.BoxGeometry(1.35, 0.32, 0.5), 0, 1.85, 0.45, { rx: 0.2 });                    // brow ridge
  P(new THREE.BoxGeometry(0.34, 0.9, 0.36), 0, 1.4, 0.6, { rx: 0.18 });                     // nose
  P(new THREE.BoxGeometry(0.55, 0.12, 0.25), 0, 0.98, 0.6);                                 // mouth
  P(SPH, 0, 2.3, -0.35, { s: [0.85, 0.55, 0.8] });                                          // hair mass
  for (let i = -3; i <= 3; i++) P(SPH, i * 0.2, 2.55 - Math.abs(i) * 0.06, -0.15 - Math.abs(i) * 0.08, { s: [0.11, 0.3, 0.16] });   // hair strands
  return [S.boxCollider(x, z, 2.7, 3.0, 2.3, ry)];
}

/** Nearest point with `clear` metres of sidewalk around it (cityData drops the koban on the 井の頭通り centre line). */
function offRoad(field, x, z, clear) {
  if (!field || field.sample(x, z) >= clear) return [x, z];
  for (let r = 4; r <= 18; r += 2) for (let a = 0; a < 16; a++) {
    const th = a * Math.PI / 8, px = x + Math.cos(th) * r, pz = z + Math.sin(th) * r;
    if (field.sample(px, pz) >= clear) return [px, pz];
  }
  return [x, z];
}

export function build(ctx) {
  const { key, data } = ctx;
  let [px, pz] = data.pos;
  let colliders = [];
  if (key === 'moyai') colliders = moyai(ctx, px, pz, data.rotY || 0);
  else if (key === 'udagawaKoban') { [px, pz] = offRoad(ctx.field, px, pz, 3.6); colliders = koban(ctx, px, pz, data.rotY || 0, { w: 6, d: 5, storeys: 2, name: '宇田川交番' }); }
  else return null;
  return { group: new THREE.Group(), origin: [px, pz], worldSpace: true, colliders, lights: [], anchors: { top: new THREE.Vector3(0, 3, 0) }, facades: [] };
}

export default { build, koban, KEYS };
