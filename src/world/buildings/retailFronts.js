// Bunkamura retail fronts after Google Street View (文化村通り, 2024-12 / the MEGA store 2025-06) and Commons photos:
//  - discount (MEGA ドン・キホーヂ, on its real OSM footprint): white panel body, stacked rounded balcony bands on the
//    frontage, a huge black band with yellow lettering over the ground floor (SHIBUYA / MEGA / HONTEN 24h), a tall
//    tax-free banner, a wide-open ground floor packed with goods, floodlit at night;
//  - electronics (LABY 渋谷, the lots on the real footprint): dark-blue glass on a fine grid, silver frame and a silver
//    parapet carrying big red letters, coloured vertical banners on the corner, white floor-guide boards, a lit canopy.
// Original geometry/type only (the game's own parody names, docs/NAMES.md): no photographs, logos or mascots.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
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
    const m = L.signMaterial(c, { emissive: electronics ? 0.9 : 1.1 }); return m;
  });
}
// white panel body: 3.3 m storey joints, 1.8 m vertical joints; a faint floodlight glow at night
function whitePanel() {
  return once('white', () => {
    const c = L.makeCanvas(128, 128), g = c.getContext('2d');
    g.fillStyle = '#e9e8e4'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#c9c8c3'; g.fillRect(0, 0, 128, 3); g.fillRect(0, 0, 2, 128); g.fillRect(64, 0, 1, 128);
    const m = L.std({ map: L.canvasTex(c, { wrap: true }), roughness: 0.62, metalness: 0.05, emissive: 0xfff6e4, emissiveMap: L.canvasTex(c, { wrap: true }) });
    m.name = 'lm_retailWhite'; S.nightMaterial(m, 0, 0.32);
    return m;
  });
}
// LABY's glass: navy panels on a fine silver grid; the night map lights whole sales floors white behind it
function blueGlass() {
  return once('blueGlass', () => {
    const c = L.makeCanvas(128, 256), g = c.getContext('2d'), e = L.makeCanvas(128, 256), eg = e.getContext('2d');
    g.fillStyle = '#1d3f6e'; g.fillRect(0, 0, 128, 256);
    const gr = g.createLinearGradient(0, 0, 128, 256); gr.addColorStop(0, 'rgba(150,190,235,.35)'); gr.addColorStop(.5, 'rgba(40,80,140,0)'); gr.addColorStop(1, 'rgba(120,170,220,.25)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 256);
    eg.fillStyle = '#000'; eg.fillRect(0, 0, 128, 256);
    eg.fillStyle = '#cfe3ff'; eg.fillRect(0, 40, 128, 190); eg.fillStyle = '#ffffff'; eg.fillRect(0, 44, 128, 8);   // sales floor + ceiling lights
    for (const cv of [g, eg]) { cv.fillStyle = cv === g ? '#aeb6bf' : '#20242a'; for (let x = 0; x < 128; x += 32) cv.fillRect(x, 0, 3, 256); for (let y = 0; y < 256; y += 64) cv.fillRect(0, y, 128, 4); cv.fillRect(0, 230, 128, 26); }
    const map = L.canvasTex(c, { wrap: true }), emi = L.canvasTex(e, { wrap: true });
    const m = L.std({ map, emissiveMap: emi, emissive: 0xffffff, roughness: 0.12, metalness: 0.55, envMapIntensity: 1.6 });
    m.name = 'lm_labyGlass'; S.nightMaterial(m, 0.02, 0.95);
    return m;
  });
}
function washMaterial() {
  return once('wash', () => {
    const c = L.makeCanvas(128, 256), g = c.getContext('2d'), gr = g.createLinearGradient(0, 256, 0, 0);
    gr.addColorStop(0, 'rgba(255,248,230,.8)'); gr.addColorStop(.55, 'rgba(255,248,230,.25)'); gr.addColorStop(1, 'rgba(255,248,230,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 256);
    const m = new THREE.MeshBasicMaterial({ map: L.canvasTex(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 });
    S.nightMaterial(m, 0, 1); m.name = 'lm_retailWash'; return m;
  });
}

// a face is frontage when a carriageway lies within 12 m in front of it
function frontage(field, mx, mz, nx, nz) {
  if (!field) return true;
  for (let d = 1.5; d <= 12; d += 1.5) if (field.sample(mx + nx * d, mz + nz * d) < 0) return true;
  return false;
}

export function dressRetail({ batch, group, field }, lot, h, base) {
  const poly = L.ensureCW(lot.poly), electronics = lot.retail === 'electronics';
  const M = S.mats();
  const white = whitePanel(), glass = blueGlass();
  const dark = L.std({ color: 0x1a1d22, roughness: 0.5 });
  const metal = L.std({ color: 0xb9bfc6, roughness: 0.38, metalness: 0.55 });
  const faces = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.8) continue;
    const [nx, nz] = L.edgeNormal(poly, i), tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    faces.push({ a, b, len, nx, nz, tx, tz, mx, mz, rot: Math.atan2(-tz, tx), front: len > 4 && frontage(field, mx, mz, nx, nz) });
  }
  // the lot's main face: its longest frontage (the big lettering goes there once per store: lot.retailMain)
  const main = faces.filter(f => f.front).sort((p, q) => q.len - p.len)[0];
  for (const f of faces) {
    const { len, nx, nz, tx, tz, mx, mz, rot } = f;
    const y = groundY(mx + nx * 0.2, mz + nz * 0.2) + 0.15;
    // u runs left → right as seen from the street (the CW edge tangent runs the other way)
    const box = (u, cy, w, hh, depth, mat, out = 0.12) => { const x = mx - tx * u + nx * out, z = mz - tz * u + nz * out; batch.add(mat, L.boxAt(x, cy, z, w, hh, depth, rot, false), x, z); };
    const sign = (u, cy, w, hh, text, bg, fg, em = 0.9, out = 0.78, extra = {}) => S.flatSign(group, mx - tx * u + nx * out, cy, mz - tz * u + nz * out, nx, nz, { text, w, h: hh, bg, fg, emissive: em, weight: '900', ...extra });
    const panel = (u, cy, w, hh, material, out = 0.48) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), material); L.placeFacing(m, mx - tx * u + nx * out, cy, mz - tz * u + nz * out, nx, nz); group.add(m); };
    const light = (u, cy, color, intensity, distance, out = 2) => { const l = new THREE.PointLight(color, intensity, distance, 2); l.position.set(mx - tx * u + nx * out, cy, mz - tz * u + nz * out); group.add(l); };
    const top = base + h;
    // cover the procedural window grid: one large retailer, not stacked unrelated tenants
    box(0, base + h / 2, len, h, 0.18, electronics && f.front ? glass : white);
    if (!f.front) continue;
    const isMain = lot.retailMain && f === main;
    if (electronics) {
      // silver frame: parapet band on top, a slim silver pier at each end, floor lines on the grid
      box(0, top - 2.6, len + 0.2, 5.2, 0.5, metal, 0.3);
      for (const e of [-1, 1]) box(e * (len / 2 - 0.5), base + h / 2, 1.0, h, 0.5, metal, 0.3);
      for (let fy = 7.4; fy < h - 5.5; fy += 3.6) box(0, base + fy, len - 1, 0.16, 0.2, metal, 0.3);
      // ground floor: dark canopy, bright open store, red LABY board over the doors
      box(0, y + 4.6, len, 0.9, 2.2, dark, 1.1);
      for (let u = -len / 2 + 1.5; u < len / 2 - 1; u += 2.2) box(u, y + 4.12, 1.2, 0.06, 1.2, M.glowWhite, 1.4);
      panel(0, y + 2.1, len - 1, 3.9, displayMaterial(true), 0.4);
      sign(0, y + 4.65, Math.min(len - 2, 9), 0.75, 'LABY  渋谷', '#1a1d22', '#ff3a40', 1.2, 2.25);
      // white floor-guide boards at 2F, three coloured banners down the left end
      sign(-len * 0.18, y + 7.2, Math.min(5.5, len * 0.35), 2.6, 'B1 化粧品・医薬品・日用品\n1F スマートフォン・携帯\n2F パソコン・カメラ', '#ffffff', '#1f3e7a', 0.8, 0.45, { weight: '700' });
      for (const [k, [bg, txt]] of [['#d92632', '家電\nデジタル'], ['#2f9a4a', 'ゲーム\nおもちゃ'], ['#1f6fc0', '免税\nTAX FREE']].entries())
        sign(-len / 2 + 1.6 + k * 1.5, base + h * 0.55, 1.2, h * 0.5, txt, bg, '#ffffff', 1.1, 0.9);
      if (isMain) {
        sign(len * 0.08, top - 2.2, Math.min(len * 0.8, 16), 3.2, 'LABY', '#c7ccd2', '#d8232e', 1.3, 0.6);
        sign(len * 0.08, top - 4.3, Math.min(len * 0.55, 10), 0.9, 'SHIBUYA', '#c7ccd2', '#1f4c8a', 1.1, 0.6);
        light(0, top - 1, 0xffd6d6, 30, 12, 3);
      }
      light(0, y + 3.4, 0xe4f1ff, 55, 14, 2.5);
    } else {
      // stacked rounded balcony bands on the right of the frontage, each floor from 3F up
      const bw = Math.min(len * 0.42, 12), bu = len / 2 - bw / 2 - 0.3;
      for (let fy = 10; fy < h - 1.5; fy += 3.3) {
        box(bu, base + fy, bw, 0.34, 1.6, white, 0.95);
        box(bu, base + fy + 0.55, bw, 0.9, 0.12, white, 1.7);                                   // solid balustrade
        const ex = mx - tx * (bu - bw / 2) + nx * 0.95, ez = mz - tz * (bu - bw / 2) + nz * 0.95;
        batch.add(white, S.cylSegment(ex, ez, 0.8, base + fy - 0.17, base + fy + 1.0, 0, Math.PI * 2, 14), ex, ez);   // rounded end
        box(bu, base + fy - 0.2, bw - 0.4, 0.06, 0.8, M.glowWhite, 0.95);                        // soffit light line
      }
      // the huge black band over the ground floor, yellow lettering, a red panel behind MEGA, the round 24h badge
      const bandW = len - 0.4, bandY = y + 6.1;
      box(0, bandY, bandW, 3.0, 0.5, dark, 0.55);
      box(0, bandY + 1.55, bandW, 0.12, 0.55, M.glowYellow, 0.6); box(0, bandY - 1.55, bandW, 0.12, 0.55, M.glowYellow, 0.6);
      if (isMain) {
        sign(-bandW * 0.40, bandY, bandW * 0.15, 1.3, 'SHIBUYA', '#111111', '#ffd21e', 1.4, 0.85);
        sign(-bandW * 0.10, bandY, bandW * 0.40, 2.6, 'MEGA ドン・キホーヂ', '#b3121f', '#ffd21e', 1.6, 0.86);
        sign(bandW * 0.27, bandY, bandW * 0.28, 2.2, 'HONTEN', '#111111', '#ffd21e', 1.4, 0.85);
        sign(bandW * 0.45, bandY, 2.1, 2.1, '24h', '#ffd21e', '#111111', 1.4, 0.88);
        // tall tax-free banner on the left of the upper facade
        sign(-len * 0.28, base + h * 0.62, Math.min(4.2, len * 0.2), h * 0.52, '日本の\nおみやげ\n\n免税\nTax Free', '#fbe9ee', '#c8202e', 0.9, 0.3);
        light(-len * 0.28, base + h * 0.62, 0xfff0e0, 26, 16, 5);
      } else sign(0, bandY, Math.min(bandW * 0.8, 14), 2.2, 'ドン・キホーヂ', '#111111', '#ffd21e', 1.4, 0.85);
      // ground floor: wide open, goods to the pavement, warm light
      box(0, y + 2.3, len - 0.4, 4.6, 0.2, dark, 0.2);
      panel(0, y + 2.2, len - 0.8, 4.1, displayMaterial(false), 0.36);
      for (let u = -len / 2 + 1.2; u < len / 2 - 1; u += 1.8) box(u, y + 4.35, 1.2, 0.06, 1.2, M.glowWarm, 0.8);
      sign(0, y + 0.95, Math.min(len - 1, 10), 0.6, '食品・日用品・コスメ・おみやげ  24時間営業', '#241f1c', '#ffffff', 0.9, 0.5, { weight: '700' });
      // floodlight wash on the white body
      panel(0, base + h * 0.6, len - 0.3, h * 0.8, washMaterial(), 0.34);
      light(0, y + 3.2, 0xffe2a0, 55, 16, 2.5);
      light(0, base + h * 0.75, 0xfff6e8, 28, 20, 6);
    }
  }
}
