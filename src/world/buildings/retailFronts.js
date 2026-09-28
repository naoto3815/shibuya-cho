// Bunkamura retail fronts after Google Street View (文化村通り, 2024-12 / the MEGA store 2025-06) and Commons photos,
// built in depth with relief.js (real boxes and extrusions, not paint on the wall):
//  - discount (MEGA ドン・キホーヂ, on its real OSM footprint): white panel body with slab-edge shadow lines, a stack
//    of rounded balcony bands on the right of the frontage (1.1 m out, lit soffits, dark recess behind), a huge
//    black box sign 1.2 m deep over the ground floor with yellow channel letters (SHIBUYA / MEGA ドン・キホーヂ /
//    HONTEN) and a 24h cabinet, tax-free blade banners at right angles to the face, an eave with downlights, and a
//    ground floor set back behind its frame with goods stacked to the pavement edge; floodlit at night;
//  - electronics (LABY 渋谷, the lots on the real footprint): navy glass set back behind a real mullion / transom
//    grid, a silver frame (end piers and a 5 m parapet band standing ~1 m proud) carrying big red channel letters,
//    red / green / blue blade banners off the store's corner, a white floor-guide cabinet, a deep canopy with
//    downlights over a bright recessed sales floor.
// Original geometry/type only (the game's own parody names, docs/NAMES.md): no photographs, logos or mascots.
// Nothing deeper than R.PAVE stands below R.HEAD: the pavement stays clear and no new colliders are needed.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import * as R from './relief.js';
import { groundY } from '../cityData.js';

const cache = new Map();
const once = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };

function displayMaterial(electronics) {
  return once('display' + electronics, () => {
    const c = L.makeCanvas(1024, 512), g = c.getContext('2d');
    g.fillStyle = electronics ? '#dfe6ee' : '#f3e7c8'; g.fillRect(0, 0, 1024, 512);
    // a lit shop interior painted from primitives; no product photographs or brand artwork
    g.fillStyle = '#ffffff'; for (let x = 24; x < 1024; x += 150) g.fillRect(x, 18, 110, 12);
    for (let row = 0; row < 3; row++) {
      const y = 110 + row * 125; g.fillStyle = '#b2b4b6'; g.fillRect(0, y + 96, 1024, 10);
      for (let k = 0; k < 16; k++) {
        const x = k * 64 + 5;
        if (electronics) { g.fillStyle = '#151c27'; g.fillRect(x, y, 55, 70); const gr = g.createLinearGradient(x, y, x + 55, y + 70); gr.addColorStop(0, ['#77b7d9', '#aba8d8', '#73bcb2'][row]); gr.addColorStop(1, '#243b56'); g.fillStyle = gr; g.fillRect(x + 3, y + 3, 49, 56); }
        else { g.fillStyle = ['#d94b36', '#deb539', '#f1e4c7', '#79a84c', '#387fac', '#bd6091', '#f07f22'][(k + row * 3) % 7]; g.fillRect(x, y + 6 + (k % 3) * 5, 50, 80 - (k % 3) * 5); g.fillStyle = '#fff3d8'; g.fillRect(x + 8, y + 30, 34, 20); }
        g.fillStyle = electronics ? '#e8303a' : '#fbe24b'; g.fillRect(x, y + 82, 50, 13);
        g.fillStyle = electronics ? '#ffffff' : '#b0281c'; g.font = 'bold 10px sans-serif'; g.fillText(electronics ? 'POINT' : '驚安', x + 6, y + 93);
      }
    }
    const m = L.signMaterial(c, { emissive: electronics ? 0.9 : 1.1 });
    m.map.wrapS = m.emissiveMap.wrapS = THREE.RepeatWrapping;   // R.storefront repeats it every ~8 m
    return m;
  });
}
// goods crammed to the pavement edge (wagons, stacked cartons, POP cards): lit by the store at night
function goodsMaterial() {
  return once('goods', () => {
    const c = L.makeCanvas(256, 256), g = c.getContext('2d');
    g.fillStyle = '#3b2f28'; g.fillRect(0, 0, 256, 256);
    const cols = ['#d94b36', '#deb539', '#f4ecd8', '#79a84c', '#387fac', '#bd6091', '#f07f22', '#ffffff', '#6a3fa0'];
    for (let y = 0; y < 256; y += 32) for (let x = 0; x < 256; x += 16 + ((x * 7 + y) % 3) * 8) {
      const w = 14 + ((x + y * 3) % 3) * 8; g.fillStyle = cols[Math.floor(L.hash(x, y, 71) * cols.length)]; g.fillRect(x + 1, y + 3 + L.hash(x, y, 72) * 6, w - 2, 27 - L.hash(x, y, 72) * 6);
    }
    g.fillStyle = '#fbe24b'; for (let y = 0; y < 256; y += 64) for (let x = 8; x < 256; x += 48) g.fillRect(x, y + 1, 22, 9);   // POP cards
    const t = L.canvasTex(c, { wrap: true });
    const m = L.std({ map: t, emissive: 0xfff0d0, emissiveMap: t, roughness: 0.7, metalness: 0 });
    m.name = 'lm_retailGoods'; S.nightMaterial(m, 0.04, 0.55);
    return m;
  });
}
// white panel body: 3.3 m storey joints, 1.8 m vertical joints (metre UVs); a faint floodlight glow at night
function whitePanel() {
  return once('white', () => {
    const c = L.makeCanvas(128, 128), g = c.getContext('2d');
    g.fillStyle = '#e9e8e4'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#c9c8c3'; g.fillRect(0, 0, 128, 3); g.fillRect(0, 0, 2, 128); g.fillRect(64, 0, 1, 128);
    const map = L.canvasTex(c, { wrap: true }), emi = L.canvasTex(c, { wrap: true });
    map.repeat.set(1 / 3.6, 1 / 3.3); emi.repeat.set(1 / 3.6, 1 / 3.3);
    const m = L.std({ map, roughness: 0.62, metalness: 0.05, emissive: 0xfff6e4, emissiveMap: emi });
    m.name = 'lm_retailWhite'; m.userData.keepShadow = true; S.nightMaterial(m, 0, 0.32);
    return m;
  });
}
// plain white for the relief parts (bands, balconies, cornices): same floodlit glow as the body, no joints
function whiteRelief() {
  return once('whiteRelief', () => { const m = L.std({ color: 0xeeede9, roughness: 0.6, metalness: 0.04, emissive: 0xfff6e4 }); m.name = 'lm_retailWhiteRelief'; m.userData.keepShadow = true; S.nightMaterial(m, 0, 0.3); return m; });
}
// the dark recess behind the balcony bands: tinted glass, a warm glow of the sales floors at night
function recessGlass() {
  return once('recess', () => { const m = L.std({ color: 0x46505b, roughness: 0.25, metalness: 0.25, emissive: 0xffe2b0, envMapIntensity: 1.2 }); m.name = 'lm_retailRecess'; S.nightMaterial(m, 0, 0.35); return m; });
}
const darkMat = () => once('dark', () => { const m = L.std({ color: 0x1a1d22, roughness: 0.5 }); m.name = 'lm_retailDark'; m.userData.keepShadow = true; return m; });
// LABY's silver frame: kept mostly dielectric (a metal has no diffuse term and goes black on the shaded north face
// under the game's IBL), with a faint glow so the frame still reads as silver in its own shadow
const metalMat = () => once('metal', () => { const m = L.std({ color: 0xc6ccd3, roughness: 0.42, metalness: 0.18, emissive: 0xdfe6f0, envMapIntensity: 1.1 }); m.name = 'lm_retailMetal'; m.userData.keepShadow = true; S.nightMaterial(m, 0.07, 0.16); return m; });
const redMat = () => once('red', () => { const m = L.std({ color: 0xb3121f, roughness: 0.45, metalness: 0.1, emissive: 0xc0141f }); m.name = 'lm_retailRed'; S.nightMaterial(m, 0.05, 0.7); return m; });
const whiteBoard = () => once('whiteBoard', () => { const m = L.std({ color: 0xf6f6f4, roughness: 0.5, emissive: 0xffffff }); m.name = 'lm_retailBoard'; S.nightMaterial(m, 0.02, 0.5); return m; });
// LABY's glass: navy, set back behind the real grid (no painted mullions: the geometry carries the rhythm). One tile
// is 7.2 m × two 3.5 m storeys: a dark slab band at each storey line, and at night the sales floors light up behind.
const LABY_STOREY = 3.5;
function blueGlass() {
  return once('blueGlass', () => {
    const c = L.makeCanvas(256, 256), g = c.getContext('2d'), e = L.makeCanvas(256, 256), eg = e.getContext('2d');
    g.fillStyle = '#1d3f6e'; g.fillRect(0, 0, 256, 256);
    const gr = g.createLinearGradient(0, 0, 256, 256); gr.addColorStop(0, 'rgba(150,190,235,.35)'); gr.addColorStop(.5, 'rgba(40,80,140,0)'); gr.addColorStop(1, 'rgba(120,170,220,.25)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    eg.fillStyle = '#000'; eg.fillRect(0, 0, 256, 256);
    for (const y0 of [0, 128]) {   // canvas y grows down: each storey is 128 px, its slab line at the bottom
      g.fillStyle = '#16253a'; g.fillRect(0, y0 + 108, 256, 20);                       // slab / spandrel
      eg.fillStyle = '#cfe3ff'; eg.fillRect(0, y0 + 12, 256, 94);                        // lit sales floor
      eg.fillStyle = '#ffffff'; for (let x = 6; x < 256; x += 32) eg.fillRect(x, y0 + 14, 20, 5);   // ceiling lights
      // gondola shelving along the lower half: dark runs of uneven length with coloured POP cards, faint by day
      for (let x = 0; x < 256;) { const w = 20 + L.hash(x, y0, 5) * 40, hh = 26 + L.hash(x, y0, 6) * 14; eg.fillStyle = 'rgba(60,78,104,.6)'; eg.fillRect(x, y0 + 106 - hh, w, hh); eg.fillStyle = ['#ff5a5a', '#ffd84a', '#7fd0ff'][Math.floor(L.hash(x, y0, 7) * 3)]; eg.fillRect(x + 3, y0 + 106 - hh, Math.min(10, w - 6), 4); g.fillStyle = 'rgba(12,24,40,.14)'; g.fillRect(x, y0 + 106 - hh, w, hh); x += w + 6 + L.hash(x, y0, 8) * 10; }
    }
    const map = L.canvasTex(c, { wrap: true }), emi = L.canvasTex(e, { wrap: true });
    map.repeat.set(1 / 7.2, 1 / (2 * LABY_STOREY)); emi.repeat.set(1 / 7.2, 1 / (2 * LABY_STOREY));
    // the lit sales floors show faintly through the glass by day too (a big store's floors are lit all day)
    const m = L.std({ map, emissiveMap: emi, emissive: 0xffffff, roughness: 0.14, metalness: 0.3, envMapIntensity: 1.6 });
    m.name = 'lm_labyGlass'; m.userData.keepShadow = true; S.nightMaterial(m, 0.07, 0.95);
    return m;
  });
}
function washMaterial() {
  return once('wash', () => {
    const c = L.makeCanvas(128, 256), g = c.getContext('2d'), gr = g.createLinearGradient(0, 256, 0, 0);
    gr.addColorStop(0, 'rgba(255,248,230,.8)'); gr.addColorStop(.55, 'rgba(255,248,230,.25)'); gr.addColorStop(1, 'rgba(255,248,230,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 256);
    const m = new THREE.MeshBasicMaterial({ map: L.canvasTex(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 });
    S.nightMaterial(m, 0, 1); m.name = 'lm_retailWash'; m.userData.noShadow = true; return m;
  });
}

// a point of a face is frontage when a carriageway lies within 12 m in front of it
function frontage(field, x, z, nx, nz) {
  if (!field) return true;
  for (let d = 1.5; d <= 12; d += 1.5) if (field.sample(x + nx * d, z + nz * d) < 0) return true;
  return false;
}
// the frontage part of a face: the longest run of frontage points (1 m apart), snapped to the corners within 2 m. A
// side wall half hidden behind the next lot (LABY's middle lot) is dressed only where it shows.
function frontRun(field, F) {
  const n = Math.max(2, Math.round(F.len)), ok = [];
  for (let k = 0; k <= n; k++) { const [x, z] = F.at(-F.len / 2 + F.len * k / n, 0); ok.push(frontage(field, x, z, F.nx, F.nz)); }
  let best = null, s = -1;
  for (let k = 0; k <= n + 1; k++) {
    if (k <= n && ok[k]) { if (s < 0) s = k; }
    else if (s >= 0) { if (!best || k - 1 - s > best[1] - best[0]) best = [s, k - 1]; s = -1; }
  }
  if (!best) return null;
  let u0 = -F.len / 2 + F.len * best[0] / n, u1 = -F.len / 2 + F.len * best[1] / n;
  if (u0 + F.len / 2 < 2) u0 = -F.len / 2;
  if (F.len / 2 - u1 < 2) u1 = F.len / 2;
  return u1 - u0 > 4 ? [u0, u1] : null;
}

export function dressRetail({ batch, group, field }, lot, h, base) {
  const poly = L.ensureCW(lot.poly), electronics = lot.retail === 'electronics', top = base + h;
  const faces = R.faces(poly);
  for (const F of faces) {
    const run = F.len > 4 ? frontRun(field, F) : null;
    // the dressed part is a face of its own (same line and normal); the rest of the wall keeps a plain skin
    F.front = run ? R.face(F.at(run[1], 0), F.at(run[0], 0)) : null;
    F.rest = run ? [[-F.len / 2, run[0]], [run[1], F.len / 2]].filter(([a, b]) => b - a > 0.05) : [[-F.len / 2, F.len / 2]];
  }
  // the lot's main face: its longest frontage (the big lettering goes there once per store: lot.retailMain)
  const main = faces.filter(f => f.front).sort((p, q) => q.front.len - p.front.len)[0];
  // a frontage reaching its left corner where the next face's frontage starts turns a street corner (banners there)
  const n = faces.length, reaches = (F, side) => !!F.front && F.rest.every(([a, b]) => (side < 0 ? a > -F.len / 2 + 0.01 : b < F.len / 2 - 0.01));
  for (let k = 0; k < n; k++) {
    const F = faces[k], next = faces[(k + 1) % n];
    if (F.front) F.front.cornerL = reaches(F, -1) && next.i === (F.i + 1) % poly.length && reaches(next, 1);
  }
  for (const F of faces) {
    for (const [a, b] of F.rest) R.skin(batch, F, whitePanel(), { u0: a, u1: b, y0: base, y1: top, out0: 0.03, d: 0.18 });
    if (!F.front) continue;
    const G = F.front, y = groundY(G.mx + G.nx * 0.2, G.mz + G.nz * 0.2) + 0.15, isMain = lot.retailMain && F === main;
    if (electronics) labyFace(batch, group, G, { y, base, top, isMain });
    else discountFace(batch, group, G, { y, base, top, isMain });
  }
}

// ---------------------------------------------------------------------------------------------------- LABY 渋谷
function labyFace(batch, group, F, { y, base, top, isMain }) {
  const M = S.mats(), glass = blueGlass(), metal = metalMat(), dark = darkMat(), len = F.len;
  const gf = y + 4.8, bandY0 = top - 5.2;                   // sales-floor grid between the 1F head and the parapet band
  const light = (u, cy, color, intensity, distance, out = 2) => { const [x, z] = F.at(u, out); const l = new THREE.PointLight(color, intensity, distance, 2); l.position.set(x, cy, z); group.add(l); };
  // navy glass set back 0.2 m behind a real grid: mullions every ~1.8 m (every 4th a deeper fin), a transom at every
  // storey line; the grid starts at the 1F head so the texture's slab bands line up with the transoms
  R.skin(batch, F, glass, { y0: gf, y1: bandY0, out0: 0.02, d: 0.18 });
  if (bandY0 - gf > 2) R.grid(batch, F, metal, { u0: -len / 2 + 1.0, u1: len / 2 - 1.0, y0: gf, y1: bandY0, bay: 1.8, storey: LABY_STOREY, mw: 0.09, th: 0.14, d: 0.32, out0: 0.2, major: 4, majorW: 0.22, majorD: 0.55 });
  // silver frame: a 5.2 m parapet band standing 1 m proud, end piers 0.9 m proud above the canopy (0.3 m below it,
  // the pavement stays clear), a silver sill band under the glass
  R.box(batch, F, metal, 0, top - 2.6, len + 0.3, 5.2, 0, 1.0);
  R.box(batch, F, metal, 0, top + 0.08, len + 0.3, 0.16, 0, 1.08);                      // coping lip: a shadow line on the band
  for (const e of [-1, 1]) {
    R.box(batch, F, metal, e * (len / 2 - 0.5), (gf + bandY0) / 2, 1.0, bandY0 - gf, 0, 0.9);
    R.box(batch, F, metal, e * (len / 2 - 0.5), (y + gf) / 2, 1.0, gf - y, 0, R.PAVE);
  }
  R.box(batch, F, metal, 0, gf + 0.1, len - 1.9, 0.8, 0, 0.62);                       // sill band, down behind the canopy
  // ground floor: a bright sales floor set back behind a silver frame, a deep dark canopy with downlights, red LABY
  // lettering on its fascia
  R.storefront(batch, F, displayMaterial(true), metal, { u0: -len / 2 + 1.0, u1: len / 2 - 1.0, y0: y, y1: gf - 0.4, back: 0.1, front: R.PAVE, jamb: 0.3, head: 0.35, bar: 2.4, barMat: metal });
  R.canopy(batch, F, dark, { u0: -len / 2 + 0.6, u1: len / 2 - 0.6, y: y + 4.25, d: 2.2, t: 0.4, light: M.glowWhite, lightStep: 2.2, fascia: dark, fasciaH: 0.85 });
  { const [x, z] = F.at(0, 2.2 + 0.01); S.signQuad(batch, x, y + 4.62, z, F.nx, F.nz, { text: 'LABY  渋谷', w: Math.min(len - 3, 9), h: 0.62, bg: '#1a1d22', fg: '#ff3a40', emissive: 1.2, weight: '900', lift: 0.01 }); }
  // white floor-guide cabinet on the grid at 2F (one line per floor: the atlas paints one line per quad)
  const gw = Math.min(5.5, len * 0.35), gu = len * 0.22, gy = gf + 2.2;
  R.boxSign(batch, F, whiteBoard(), { u: gu, y: gy, w: gw, h: 2.7, d: 0.25, out0: 0.52 });
  ['B1  化粧品・医薬品・日用品', '1F  スマートフォン・携帯', '2F  パソコン・カメラ'].forEach((t, k) => { const [x, z] = F.at(gu, 0.78); S.signQuad(batch, x, gy + 0.85 - k * 0.85, z, F.nx, F.nz, { text: t, w: gw - 0.3, h: 0.72, bg: '#ffffff', fg: '#1f3e7a', emissive: 0.8, weight: '700', lift: 0.01 }); });
  // red / green / blue blade banners off the store's corner: each street corner once, from the face on whose left it
  // lies (the main face's left end when the store turns no corner)
  if (F.cornerL || isMain) {
    const bh = Math.min(16, (bandY0 - gf) * 0.8);
    for (const [k, [bg, txt]] of [['#d92632', '家電デジタル'], ['#2f9a4a', 'ゲームおもちゃ'], ['#1f6fc0', '免税TAXFREE']].entries())
      R.blade(batch, F, metal, { u: -len / 2 + 1.3 + k * 1.25, y: gf + 0.9 + bh / 2, w: 1.25, h: bh, t: 0.2, out0: 0.95, text: txt, bg, fg: '#ffffff', emissive: 1.1 });
  }
  if (isMain) {
    // big red channel letters standing off the silver band, the blue SHIBUYA line under them
    const w = Math.min(len * 0.8, 17);
    R.letters(batch, F, { key: 'laby' + Math.round(w * 10), u: len * 0.06, y: top - 2.55, w, h: 4.7, out0: 1.0, d: 0.35, layers: 4, emissive: 1.4,
      items: [{ text: 'LABY', x: 0, y: 0, w: 1, h: 0.72, color: '#d8232e', letterSpacing: 8 }, { text: 'SHIBUYA', x: 0.24, y: 0.74, w: 0.52, h: 0.24, color: '#1f4c8a', letterSpacing: 4 }] });
    light(0, top - 1, 0xffd6d6, 30, 12, 3);
  }
  light(0, y + 3.4, 0xe4f1ff, 55, 14, 2.5);
}

// ----------------------------------------------------------------------------------------- MEGA ドン・キホーヂ
function discountFace(batch, group, F, { y, base, top, isMain }) {
  const M = S.mats(), white = whitePanel(), wr = whiteRelief(), dark = darkMat(), len = F.len;
  const light = (u, cy, color, intensity, distance, out = 2) => { const [x, z] = F.at(u, out); const l = new THREE.PointLight(color, intensity, distance, 2); l.position.set(x, cy, z); group.add(l); };
  const bandW = len, bandY = y + 6.1, bandTop = bandY + 1.5;
  // white body above the band; slab-edge shadow lines every storey on the left part, a deep cornice at the parapet
  R.skin(batch, F, white, { y0: bandTop - 0.2, y1: top, out0: 0.03, d: 0.22 });
  const bw = isMain ? Math.min(len * 0.42, 12) : 0, bu0 = len / 2 - bw;   // the balcony stack on the right of the main frontage
  R.bands(batch, F, wr, { u0: -len / 2, u1: bu0 - 0.2, y0: bandTop + 3.3, y1: top - 2, step: 3.3, h: 0.22, d: 0.28, out0: 0.25 });
  R.box(batch, F, wr, 0, top - 0.45, len + 0.3, 0.9, 0, 0.6);
  // stacked rounded balcony bands, 1.1 m out, each floor from 3F up: dark glazing in the recess, lit soffits
  if (isMain) R.balconies(batch, F, wr, { u0: bu0, u1: len / 2 + 0.05, y0: bandTop + 2.4, y1: top - 1.2, step: 3.3, h: 1.05, d: 1.1, out0: 0.25, round: 'right', seg: 10, soffit: M.glowWhite, back: recessGlass() });
  // the huge black band over the ground floor: a sign cabinet 1.2 m deep, yellow lit rims on its front edges
  R.box(batch, F, dark, 0, bandY, bandW, 3.0, 0, 1.2);
  for (const e of [-1, 1]) R.box(batch, F, M.glowYellow, 0, bandY + e * 1.46, bandW, 0.08, 1.16, 0.08);
  if (isMain) {
    // red panel behind MEGA, yellow channel letters standing off the band, the round-cornered 24h cabinet
    const U = (fx) => -bandW / 2 + fx * bandW;
    R.box(batch, F, redMat(), U(0.40), bandY, bandW * 0.42, 2.6, 1.2, 0.12);
    R.letters(batch, F, { key: 'mega' + Math.round(bandW * 10), u: U(0.45), y: bandY, w: bandW * 0.9, h: 2.6, out0: 1.32, d: 0.3, layers: 4, emissive: 1.5,
      items: [{ text: 'SHIBUYA', x: 0.01, y: 0.3, w: 0.19, h: 0.42, color: '#ffd21e' }, { text: 'MEGA ドン・キホーヂ', x: 0.24, y: 0.08, w: 0.44, h: 0.84, color: '#ffd21e' }, { text: 'HONTEN', x: 0.69, y: 0.18, w: 0.24, h: 0.66, color: '#ffd21e' }] });
    R.boxSign(batch, F, M.glowYellow, { u: bandW / 2 - 1.2, y: bandY, w: 2.0, h: 2.0, d: 0.3, out0: 1.2, text: '24h', bg: '#ffd21e', fg: '#111111', emissive: 1.4, inset: 0.1 });
    // tax-free banners: a tall pink cabinet on the upper facade and two blades at right angles to it
    const tu = -len * 0.28, tw = Math.min(4.2, len * 0.2), th = Math.min(top - bandTop - 4, (top - base) * 0.52);
    const ty = bandTop + 1.2 + th / 2;
    R.boxSign(batch, F, wr, { u: tu, y: ty, w: tw, h: th, d: 0.3, out0: 0.25, rim: M.glowWhite });
    ['日本の', 'おみやげ', '免税', 'Tax Free'].forEach((t, k) => { const [x, z] = F.at(tu, 0.55); S.signQuad(batch, x, ty + th * (0.3 - k * 0.2), z, F.nx, F.nz, { text: t, w: tw - 0.3, h: th * 0.18, bg: '#fbe9ee', fg: '#c8202e', emissive: 0.9, weight: '900', lift: 0.01 }); });
    const bh = Math.min(9, th * 0.7);
    R.blade(batch, F, wr, { u: -len / 2 + 0.8, y: bandTop + 1.4 + bh / 2, w: 1.3, h: bh, t: 0.22, out0: 0.3, text: '免税TAXFREE', bg: '#c8202e', fg: '#ffffff', emissive: 1.1 });
    R.blade(batch, F, wr, { u: tu + tw / 2 + 1.4, y: bandTop + 1.4 + bh / 2, w: 1.3, h: bh, t: 0.22, out0: 0.3, text: '驚安の殿堂', bg: '#ffd21e', fg: '#c8202e', emissive: 1.1 });
    light(-len * 0.28, base + (top - base) * 0.62, 0xfff0e0, 26, 16, 5);
  } else R.boxSign(batch, F, dark, { u: 0, y: bandY, w: Math.min(bandW * 0.8, 14), h: 2.2, d: 0.12, out0: 1.2, text: 'ドン・キホーヂ', bg: '#111111', fg: '#ffd21e', emissive: 1.4 });
  // eave under the band with warm downlights; the ground floor set back behind its frame, goods to the pavement edge
  R.canopy(batch, F, dark, { u0: -bandW / 2, u1: bandW / 2, y: y + 4.35, d: 1.9, t: 0.25, light: M.glowWarm, lightStep: 1.8 });
  R.storefront(batch, F, displayMaterial(false), dark, { u0: -len / 2, u1: len / 2, y0: y, y1: y + 4.35, back: 0.1, front: R.PAVE, jamb: 0.4, head: 0.3, bar: 3.2, barMat: dark });
  const goods = goodsMaterial(), gu0 = -len / 2 + 1.0, gu1 = len / 2 - 1.0;
  for (let u = gu0, k = 0; u < gu1 - 0.8; u += 1.3, k++) {
    if (k % 4 === 3) continue;                                // a gap for the doors
    const gh = 1.0 + L.hash(k, 3, 91) * 0.7;
    R.box(batch, F, goods, u + 0.55, y + gh / 2, 1.1, gh, 0.1, 0.24);
  }
  { const [x, z] = F.at(0, 1.9 + 0.01); S.signQuad(batch, x, y + 4.47, z, F.nx, F.nz, { text: '食品・日用品・コスメ・おみやげ  24時間営業', w: Math.min(len - 1, 11), h: 0.24, bg: '#241f1c', fg: '#ffffff', emissive: 0.9, weight: '700', lift: 0.01 }); }
  // floodlight wash on the white body
  R.quad(batch, F, washMaterial(), -bw / 2, (bandTop + top) / 2, len - bw - 0.3, top - bandTop, 0.27);
  light(0, y + 3.2, 0xffe2a0, 55, 16, 2.5);
  light(0, base + (top - base) * 0.75, 0xfff6e8, 28, 20, 6);
}
