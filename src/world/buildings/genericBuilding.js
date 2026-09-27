// [city] Procedural facade generator for every infill building (and the plain faces of landmarks).
//   getAtlases()                         shared window / shopfront / fascia atlases + wall materials (built once)
//   buildBuilding(spec, ctx)             polygon footprint → walls, per-window quads (atlas UV, random lit rooms),
//                                        ground-floor shopfronts with emissive interiors + tenant fascia, storey bands,
//                                        balconies, AC units, pipes, external stairs, awnings, setbacks, parapet,
//                                        rooftop tanks / antennas / billboard frames. Geometry goes into ctx.batch /
//                                        ctx.inst (merged + instanced), so a whole city costs a few draw calls.
//   setNightFactor(f) / getNightFactor()  window + shop emissive follow the time of day
//   build({w,d,h,...})                   legacy box API kept for other builders (returns { group, colliders })
import * as THREE from 'three';
import * as L from './lib.js';
import { SHOP_TENANTS, TENANT_TYPE } from './tenantsData.js';
import { CANVAS_K } from '../../core/mobileProfile.js';

export const STOREY_H = 3.4;

// ------------------------------------------------------------------------------------------ the people inside
// Every person in the game is one of the client's 19 pedestrian scans (docs/PEDS.md), the ones painted into shop and
// room interiors too: cut-outs rendered from the scans (tools/pedsprites.mjs → assets/peds/sprites.png + .json:
// full body and upper body, front and 3/4, 160 px/m, alpha). The atlases below are painted once at load, so the
// sheet is fetched before this module finishes evaluating; without it (tools under node) nobody is painted.
export const PEDS = await (async () => {
  try {
    if (typeof Image === 'undefined' || typeof fetch === 'undefined') return null;
    const base = new URL('../../../assets/peds/', import.meta.url);
    const [meta, img] = await Promise.all([
      fetch(new URL('sprites.json', base)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = new URL('sprites.png', base).href; }),
    ]);
    if (!meta || !img || !meta.scans) return null;
    const keys = Object.keys(meta.scans);
    const STAFF = new Set(['salaryman', 'office']);
    return { meta, img, keys, staff: keys.filter((k) => STAFF.has(meta.scans[k].role)), shoppers: keys.filter((k) => !STAFF.has(meta.scans[k].role)) };
  } catch (e) { return null; }
})();
let _pedTmp = null;
/** Paint one scan cut-out into an interior canvas. (bx, by) = the feet (full) or the crop line (upper) in canvas px,
 *  ppmX / ppmY = the canvas's px per metre, dark = 0..1 darkening with depth, crop = metres of the upper sprite kept
 *  from the top (a person seen over a desk), flip = mirrored (3/4 views face either way). */
export function paintPed(ctx, key, kind, view, bx, by, ppmX, ppmY, { dark = 0, soft = 0, crop = 0, flip = false } = {}) {
  if (!PEDS) return false;
  const rec = PEDS.meta.scans[key]; if (!rec) return false;
  const spr = rec[kind].find((q) => q.view === view) || rec[kind][0];
  const [sx, sy, sw, sh0] = spr.rect, ppm = PEDS.meta.ppm;
  const sh = crop ? Math.min(sh0, Math.round(crop * ppm)) : sh0;
  const dw = sw / ppm * ppmX, dh = sh / ppm * ppmY;
  // darkened (and softened) on a scratch canvas so only the figure's own pixels are touched
  const t = _pedTmp || (_pedTmp = L.makeCanvas(160, 320)), tc = t.getContext('2d');
  tc.clearRect(0, 0, t.width, t.height);
  if (soft > 0 && 'filter' in tc) tc.filter = `blur(${soft.toFixed(2)}px)`;
  tc.drawImage(PEDS.img, sx, sy, sw, sh, 0, 0, sw, sh);
  if ('filter' in tc) tc.filter = 'none';
  if (dark > 0) { tc.globalCompositeOperation = 'source-atop'; tc.fillStyle = `rgba(14,10,8,${Math.min(0.85, dark).toFixed(3)})`; tc.fillRect(0, 0, sw, sh); tc.globalCompositeOperation = 'source-over'; }
  const top = by - dh;                               // feet (full) / crop line (upper) sit on (bx, by)
  ctx.save();
  if (flip) { ctx.translate(bx, 0); ctx.scale(-1, 1); ctx.drawImage(t, 0, 0, sw, sh, -dw / 2, top, dw, dh); }
  else ctx.drawImage(t, 0, 0, sw, sh, bx - dw / 2, top, dw, dh);
  ctx.restore();
  return true;
}
/** A scan key for interior person #i: staff (the salaryman / office scans) or shoppers (the other 15). */
export function pedKey(i, staff) {
  if (!PEDS) return null;
  const list = staff ? PEDS.staff : PEDS.shoppers;
  return list[((i % list.length) + list.length) % list.length];
}
let A = null;
let nightFactor = 1;
const emissives = [];   // [{mat, day, night}]

// ------------------------------------------------------------------------------------------------- atlases
// Window atlas: every cell is the BACK WALL of a room (its outer bands are that room's ceiling / floor / side walls),
// which the glass shader ray-casts into a box behind the pane (interior mapping, 3–6 m deep): the same picture reads
// differently from every angle and every unit, so ~30 room pictures never repeat visibly across 10 k windows.
const RP = {   // room palettes: [ceiling, wall, floor, accent]
  cool: ['#8e979c', '#b4bec4', '#7c8284', '#3a6ea8'], warm: ['#a89880', '#c8b69a', '#7a624a', '#b0582e'],
  salon: ['#aaa296', '#d4c8b6', '#a8947a', '#2a2a2a'], clinic: ['#b0babd', '#cddadd', '#a8b4b6', '#2ab0c0'],
  izakaya: ['#6a4a2e', '#8a5a34', '#4a3424', '#d83a20'], karaoke: ['#2a1640', '#4a2066', '#1c1224', '#ff4ec0'],
  gym: ['#98a2a8', '#a8b6c0', '#4a4e52', '#e8a020'], bare: ['#8e908e', '#a4a6a4', '#8a8c8a', '#6a6c6a'],
};
function roomCell(ctx, X0, Y0, W, H, kind, lit, i) {
  const h = (a, b = 0) => L.hash(i * 17 + a, b, 23);
  const R = (fx, fy, fw, fh, c) => { ctx.fillStyle = c; ctx.fillRect(X0 + fx * W, Y0 + fy * H, fw * W, fh * H); };
  const E = (fx, fy, rx, ry, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(X0 + fx * W, Y0 + fy * H, rx * W, ry * H, 0, 0, 6.3); ctx.fill(); };
  const G = (fy0, fy1, c0, c1) => { const g = ctx.createLinearGradient(0, Y0 + fy0 * H, 0, Y0 + fy1 * H); g.addColorStop(0, c0); g.addColorStop(1, c1); ctx.fillStyle = g; ctx.fillRect(X0, Y0 + fy0 * H, W, (fy1 - fy0) * H); };
  // a person over a desk / sofa line at (fx, fy): one of the 19 scans, upper body, darker with depth into the room
  let pn = 0;
  const person = (fx, fy, sc, c) => {
    const k = pn++, px = 0.305 * sc * H / 0.72;       // px per metre: head top to the desk line ≈ 0.72 m of body
    if (PEDS && paintPed(ctx, pedKey(i * 7 + k * 3, kind === 'office' || kind === 'officeW' || kind === 'meeting' || kind === 'clinic'), 'upper', (i + k) % 3 ? 'q34' : 'front',
      X0 + fx * W, Y0 + fy * H, px * 0.9, px, { dark: 0.12 + 0.3 * Math.max(0, 1 - sc), soft: 0.8 + 3 * Math.max(0, 1 - sc), crop: 0.72, flip: (i + k) % 2 === 1 })) return;
    R(fx - 0.035 * sc, fy - 0.2 * sc, 0.07 * sc, 0.2 * sc, c); E(fx, fy - 0.25 * sc, 0.022 * sc, 0.055 * sc, '#1e1a18');
  };
  const room = (P, dim = 1) => {   // ceiling band, wall, floor band, side bands, skirting
    R(0, 0, 1, 1, P[1]); R(0, 0, 1, 0.12, P[0]); R(0, 0.88, 1, 0.12, P[2]); R(0, 0.12, 0.035, 0.76, P[1]); R(0.965, 0.12, 0.035, 0.76, P[1]);
    G(0.12, 0.88, 'rgba(255,255,255,0.08)', `rgba(0,0,0,${0.18 * dim})`); R(0, 0.86, 1, 0.02, 'rgba(0,0,0,0.25)');
  };
  const tubes = (n, c = '#ffffff', y = 0.03) => { for (let k = 0; k < n; k++) R(0.08 + k * (0.84 / n), y, 0.84 / n * 0.62, 0.035, c); };
  if (lit) switch (kind) {
    case 'office': case 'officeW': {
      const P = kind === 'office' ? RP.cool : RP.warm; room(P); tubes(3 + (i % 3));
      const nd = 2 + (i % 2);
      for (let r = 0; r < nd; r++) { const y = 0.6 + r * 0.1, sc = 0.6 + r * 0.25; R(0.05, y, 0.9, 0.03 * sc, kind === 'office' ? '#4a4c52' : '#7a5a3e');
        for (let k = 0; k < 7; k++) if (h(k, r) < 0.8) { const x = 0.08 + k * 0.125 + h(k, r + 5) * 0.03; R(x, y - 0.07 * sc, 0.055 * sc, 0.065 * sc, '#1e2026'); R(x + 0.005, y - 0.065 * sc, 0.045 * sc, 0.05 * sc, h(k, r + 9) < 0.5 ? '#9cc4ec' : '#d8e4f0'); if (h(k, r + 2) < 0.45) person(x + 0.03, y + 0.005, sc, ['#2a2c34', '#4a4a56', '#e8e4dc'][k % 3]); } }
      R(0.82, 0.3, 0.12, 0.56, kind === 'office' ? '#9aa2aa' : '#a88a66'); R(0.83, 0.32, 0.1, 0.02, 'rgba(0,0,0,0.3)'); R(0.83, 0.5, 0.1, 0.02, 'rgba(0,0,0,0.3)');
      if (kind === 'officeW') { E(0.12, 0.62, 0.04, 0.12, '#3a6a3a'); R(0.1, 0.7, 0.04, 0.16, '#6a4a2a'); }
      break; }
    case 'meeting': {
      room(RP.cool); tubes(2); R(0.25, 0.22, 0.5, 0.26, '#f4f4f2'); R(0.26, 0.23, 0.48, 0.02, '#c8ccd0'); R(0.3, 0.28, 0.3, 0.01, '#3a6ea8'); R(0.3, 0.33, 0.2, 0.01, '#c83a3a');
      R(0.12, 0.62, 0.76, 0.05, '#3a3634'); for (let k = 0; k < 6; k++) { R(0.14 + k * 0.125, 0.55, 0.06, 0.1, '#202226'); if (h(k) < 0.6) person(0.17 + k * 0.125, 0.6, 0.9, '#3a3c44'); }
      for (const x of [0.05, 0.95]) R(x, 0.12, 0.012, 0.76, 'rgba(255,255,255,0.35)');
      break; }
    case 'vacant': {
      room(RP.bare, 0.6); tubes(4, '#f8fbff'); for (const x of [0.2, 0.62]) { R(x, 0.12, 0.09, 0.76, '#a2a4a2'); R(x + 0.07, 0.12, 0.02, 0.76, 'rgba(0,0,0,0.2)'); }
      R(0.76, 0.6, 0.1, 0.26, '#5a5c60'); for (let k = 0; k < 4; k++) R(0.76, 0.6 + k * 0.06, 0.1, 0.01, '#8a8c90');
      R(0.36, 0.3, 0.2, 0.3, '#f2f0e8'); ctx.fillStyle = '#c8102e'; ctx.font = `800 ${Math.round(0.06 * H)}px ${L.FONT_JP}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('テナント募集', X0 + 0.46 * W, Y0 + 0.4 * H); ctx.fillStyle = '#1a1a1a'; ctx.font = `600 ${Math.round(0.035 * H)}px ${L.FONT_JP}`; ctx.fillText('03-XXXX-XXXX', X0 + 0.46 * W, Y0 + 0.5 * H);
      break; }
    case 'corridor': {
      room(['#9aa0a6', '#50565c', '#3a3e42', '#2a8a4a']); R(0, 0, 1, 0.12, '#8a9096'); tubes(5, '#ffffff', 0.02); tubes(5, '#ffffff', 0.07);
      for (const x of [0.15, 0.55]) { R(x, 0.38, 0.14, 0.5, '#6a7078'); R(x + 0.11, 0.62, 0.015, 0.03, '#c8ccd0'); }
      R(0.8, 0.2, 0.1, 0.06, '#1db35a'); R(0.81, 0.21, 0.035, 0.04, '#ffffff');
      break; }
    case 'blinds': {
      const P = i % 2 ? RP.cool : RP.warm; room(P); tubes(3);
      for (let k = 0; k < 4; k++) { const x = 0.1 + k * 0.22; R(x, 0.6, 0.06, 0.06, '#1e2026'); R(x + 0.005, 0.605, 0.05, 0.045, '#a8c8ec'); }
      R(0.05, 0.66, 0.9, 0.03, '#4a4c52');
      const drop = 0.42 + h(3) * 0.2; R(0, 0, 1, drop, '#cfd0cc'); for (let y = 0.01; y < drop; y += 0.028) R(0, y, 1, 0.009, 'rgba(0,0,0,0.22)'); R(0, drop - 0.02, 1, 0.02, '#9a9c98');
      break; }
    case 'storage': {
      room(RP.bare, 0.5); tubes(2, '#f0f4ff');
      for (let b = 0; b < 3; b++) { const x = 0.06 + b * 0.31; R(x, 0.2, 0.012, 0.68, '#4a5a7a'); R(x + 0.27, 0.2, 0.012, 0.68, '#4a5a7a');
        for (let r = 0; r < 4; r++) { const y = 0.26 + r * 0.16; R(x, y + 0.12, 0.28, 0.015, '#e07a20'); for (let k = 0; k < 4; k++) if (h(b * 9 + k, r) < 0.8) R(x + 0.02 + k * 0.065, y + 0.12 - (0.06 + h(k, r + b) * 0.05), 0.055, 0.06 + h(k, r + b) * 0.05, ['#b08a5a', '#c8a070', '#e8e4d8', '#8a6a44'][(k + r) % 4]); } }
      break; }
    case 'salon': {
      room(RP.salon); for (let k = 0; k < 4; k++) E(0.14 + k * 0.24, 0.05, 0.05, 0.025, '#fff8e8');
      for (let k = 0; k < 3; k++) { const x = 0.12 + k * 0.28; R(x, 0.22, 0.2, 0.34, '#c8ccd0'); R(x + 0.01, 0.23, 0.18, 0.32, '#dfe6ea'); R(x + 0.08, 0.6, 0.06, 0.2, '#1a1a1a'); R(x + 0.05, 0.56, 0.12, 0.06, '#2a2a2a'); if (h(k) < 0.6) person(x + 0.11, 0.58, 0.8, '#e8e4dc'); }
      E(0.93, 0.6, 0.04, 0.1, '#3a6a3a');
      break; }
    case 'clinic': {
      room(RP.clinic); tubes(3); R(0.08, 0.55, 0.5, 0.2, '#ffffff'); R(0.08, 0.55, 0.5, 0.03, '#2ab0c0'); person(0.3, 0.55, 0.8, '#e8f4f8');
      for (let k = 0; k < 4; k++) R(0.64 + k * 0.08, 0.66, 0.06, 0.08, '#6ab8c8'); R(0.7, 0.24, 0.14, 0.12, '#2ab0c0'); R(0.765, 0.26, 0.012, 0.08, '#ffffff'); R(0.735, 0.295, 0.07, 0.012, '#ffffff');
      break; }
    case 'izakaya': {
      room(RP.izakaya); for (let k = 0; k < 5; k++) { E(0.1 + k * 0.2, 0.2, 0.04, 0.07, '#e8401e'); R(0.1 + k * 0.2 - 0.005, 0.12, 0.01, 0.03, '#1a1a1a'); }
      for (let k = 0; k < 3; k++) { const x = 0.08 + k * 0.32; R(x, 0.64, 0.22, 0.04, '#5a3a22'); person(x + 0.05, 0.64, 0.9, '#2a2a30'); if (h(k) < 0.7) person(x + 0.17, 0.64, 0.9, '#6a4a3a'); }
      R(0.1, 0.3, 0.8, 0.07, '#f0e0b8'); for (let k = 0; k < 8; k++) R(0.12 + k * 0.1, 0.31, 0.06, 0.05, 'rgba(60,30,20,0.6)');
      break; }
    case 'karaoke': {
      room(RP.karaoke); R(0, 0.1, 1, 0.012, '#ff4ec0'); R(0, 0.84, 1, 0.012, '#40c0ff');
      for (let k = 0; k < 3; k++) { const x = 0.1 + k * 0.3; R(x, 0.32, 0.18, 0.54, '#3a1a52'); R(x + 0.05, 0.4, 0.08, 0.12, '#ffd0f0'); R(x + 0.02, 0.26, 0.14, 0.04, ['#40c0ff', '#ffd400', '#ff4ec0'][k]); }
      break; }
    case 'gym': {
      room(RP.gym); tubes(4); R(0.04, 0.2, 0.92, 0.46, '#d8e2ea'); R(0.04, 0.2, 0.92, 0.01, '#8a98a4');
      for (let k = 0; k < 4; k++) { const x = 0.08 + k * 0.23; R(x, 0.7, 0.16, 0.05, '#2a2c30'); R(x + 0.12, 0.52, 0.02, 0.2, '#2a2c30'); R(x + 0.1, 0.5, 0.06, 0.04, '#1a1c20'); if (h(k) < 0.6) person(x + 0.07, 0.7, 0.9, ['#e8a020', '#2a2c34', '#c83a3a'][k % 3]); }
      break; }
    // ---- punched (flats / hotel / small tenants)
    case 'lamp': {
      room(['#5a4632', '#6a5238', '#3a2c20', '#000'], 1.2); const g = ctx.createRadialGradient(X0 + 0.72 * W, Y0 + 0.45 * H, 0, X0 + 0.72 * W, Y0 + 0.45 * H, 0.55 * W); g.addColorStop(0, 'rgba(255,214,150,0.95)'); g.addColorStop(1, 'rgba(255,200,130,0)'); ctx.fillStyle = g; ctx.fillRect(X0, Y0, W, H);
      R(0.7, 0.34, 0.06, 0.08, '#fff0c8'); R(0.725, 0.42, 0.01, 0.44, '#2a2420'); R(0.1, 0.6, 0.45, 0.2, '#4a3a4a'); R(0.1, 0.52, 0.45, 0.1, '#5a4a5a');
      break; }
    case 'fluoro': { room(RP.cool); tubes(1, '#ffffff'); R(0.1, 0.4, 0.3, 0.46, '#b8c0c4'); R(0.6, 0.3, 0.1, 0.1, '#ffffff'); E(0.65, 0.35, 0.03, 0.03, '#2a2a2a'); person(0.5, 0.86, 1.1, '#3a4a6a'); break; }
    case 'curtain': {
      const c = ['#e8c89a', '#d8b0a0', '#c8d0b0', '#f0e0c0'][i % 4]; R(0, 0, 1, 1, c);
      for (let k = 0; k < 12; k++) R(k / 12, 0, 1 / 24, 1, 'rgba(0,0,0,0.12)'); G(0, 1, 'rgba(255,255,255,0.15)', 'rgba(0,0,0,0.2)');
      break; }
    case 'lace': { room(RP.warm); person(0.4, 0.8, 1.2, '#4a3a3a'); R(0, 0, 1, 1, 'rgba(250,246,238,0.55)'); for (let k = 0; k < 30; k++) R(k / 30, 0, 0.012, 1, 'rgba(255,255,255,0.25)'); break; }
    case 'halfblind': { room(i % 2 ? RP.warm : RP.cool); R(0.15, 0.55, 0.4, 0.31, '#6a5a4a'); R(0, 0, 1, 0.48, '#e8e2d4'); R(0, 0.46, 1, 0.025, '#b0a890'); break; }
    case 'tv': {
      room(['#2a2a34', '#34343e', '#1e1e24', '#000'], 1.2); R(0.55, 0.42, 0.3, 0.2, '#1a1a1e'); R(0.56, 0.43, 0.28, 0.17, '#9ac0ff');
      const g = ctx.createRadialGradient(X0 + 0.7 * W, Y0 + 0.5 * H, 0, X0 + 0.7 * W, Y0 + 0.5 * H, 0.5 * W); g.addColorStop(0, 'rgba(120,160,255,0.35)'); g.addColorStop(1, 'rgba(120,160,255,0)'); ctx.fillStyle = g; ctx.fillRect(X0, Y0, W, H);
      R(0.1, 0.62, 0.35, 0.18, '#26262e'); E(0.25, 0.56, 0.035, 0.05, '#101014');
      break; }
    case 'kitchen': { room(i % 2 ? RP.cool : RP.warm); tubes(1); R(0.05, 0.16, 0.6, 0.18, '#e8e4dc'); R(0.05, 0.56, 0.6, 0.3, '#d8d2c6'); R(0.05, 0.54, 0.6, 0.02, '#8a8a8a'); R(0.72, 0.2, 0.18, 0.66, '#f0f0ee'); R(0.72, 0.45, 0.18, 0.01, '#9a9a9a'); break; }
    case 'shoji': { R(0, 0, 1, 1, '#f4e8c8'); G(0, 1, 'rgba(255,255,255,0.12)', 'rgba(120,80,30,0.2)'); for (let k = 1; k < 4; k++) R(k / 4 - 0.006, 0, 0.012, 1, '#6a4a2a'); for (let k = 1; k < 6; k++) R(0, k / 6 - 0.006, 1, 0.012, '#6a4a2a'); break; }
    case 'shelves': { room(RP.warm); for (let r = 0; r < 4; r++) { R(0.1, 0.2 + r * 0.16, 0.5, 0.012, '#5a4a3a'); for (let k = 0; k < 10; k++) R(0.11 + k * 0.048, 0.2 + r * 0.16 - 0.1, 0.03, 0.1, ['#8a3a2a', '#2a4a7a', '#c8b060', '#3a6a4a', '#e8e0d0'][(k + r) % 5]); } R(0.7, 0.3, 0.2, 0.56, '#7a5a3a'); break; }
    case 'laundry': { room(RP.warm); for (let k = 0; k < 6; k++) R(0.08 + k * 0.15, 0.08, 0.1, 0.3 + h(k) * 0.15, ['#e8e8f0', '#3a5a8a', '#c83a3a', '#f0e0a0', '#6a6a70', '#e0c0d0'][k]); R(0, 0.07, 1, 0.01, '#2a2a2a'); break; }
    case 'stair': { room(RP.cool, 0.6); tubes(1); ctx.strokeStyle = '#5a6068'; ctx.lineWidth = Math.max(2, 0.02 * W); ctx.beginPath(); ctx.moveTo(X0 + 0.1 * W, Y0 + 0.85 * H); ctx.lineTo(X0 + 0.7 * W, Y0 + 0.25 * H); ctx.stroke(); R(0.75, 0.3, 0.15, 0.56, '#8a9098'); break; }
  } else switch (kind) {
    case 'blindsDark': { R(0, 0, 1, 1, '#4a4c50'); for (let y = 0; y < 1; y += 0.03) R(0, y, 1, 0.01, 'rgba(0,0,0,0.35)'); R(0, 0.96, 1, 0.04, '#6a5a44'); break; }
    case 'officeDark': { room(['#1c1e22', '#24272c', '#16181a', '#000'], 0.5); R(0.05, 0.62, 0.9, 0.03, '#101114'); for (let k = 0; k < 6; k++) R(0.08 + k * 0.15, 0.54, 0.06, 0.07, '#0c0d10'); break; }
    case 'curtainDark': { R(0, 0, 1, 1, ['#3a3430', '#2e3236', '#3a302e'][i % 3]); for (let k = 0; k < 10; k++) R(k / 10, 0, 1 / 20, 1, 'rgba(0,0,0,0.25)'); break; }
    default: { room(['#1e2024', '#26282c', '#18191c', '#000'], 0.4); if (h(1) < 0.5) R(0.1, 0.55, 0.4, 0.3, '#141518'); if (h(2) < 0.5) R(0.65, 0.3, 0.2, 0.56, '#1a1b1e'); }
  }
}
const STICKERS = ['カラオケ 2F〜5F', '焼肉 3F', 'BAR 4F', 'ネイルサロン', '歯科 4F', '整体・マッサージ', '英会話スクール', '麻雀 4F', '占いの館', 'ヘアサロン 2F', '居酒屋 3F', 'ダーツ 5F', 'まつげエクステ', 'メンズ脱毛', '漫画喫茶 24H', 'ホットヨガ', '個別指導塾', 'カフェ 2F', 'ラーメン 2F', '寿司 3F', 'ビリヤード', '古着 USED', 'ダンススタジオ', 'SHISHA 4F', 'ゲームバー', '眼科 3F', '美容皮膚科', 'ブランド買取', '金券ショップ', 'ボードゲーム', 'VR ゲーム 5F', 'もつ鍋 3F', '韓国料理 2F', 'エステ 4F', 'ボクシングジム', 'ピラティス', 'ネットカフェ', 'ガールズバー', 'スナック 3F', 'パーソナルジム'];
const OFFICE_KINDS = ['office', 'office', 'office', 'officeW', 'officeW', 'meeting', 'blinds', 'blinds', 'vacant', 'corridor', 'storage', 'salon', 'clinic', 'izakaya', 'gym'];
const ENT_KINDS = ['izakaya', 'izakaya', 'karaoke', 'karaoke', 'salon', 'clinic', 'gym', 'officeW', 'blinds', 'meeting', 'storage'];
const WIDE_LIT = ['office', 'officeW', 'meeting', 'vacant', 'corridor', 'blinds', 'storage', 'salon', 'clinic', 'izakaya', 'karaoke', 'gym'];
const WIDE_DARK = ['blindsDark', 'officeDark', 'curtainDark', 'darkRoom'];
const PUNCH_LIT = ['lamp', 'fluoro', 'curtain', 'lace', 'halfblind', 'tv', 'kitchen', 'shoji', 'shelves', 'laundry', 'stair'];
const PUNCH_DARK = ['curtainDark', 'blindsDark', 'darkRoom', 'darkRoom', 'curtainDark'];
function makeWindowAtlas() {
  // 2048 × 2304, 256 px cells: rows 0–3 punched rooms (10 dark + 22 lit), rows 4–7 wide rooms (4 dark + 12 lit, 2
  // cells each), row 8 the reveal / sill / mullion patches the window units' 3D surrounds sample
  const S = 2048, C = 256, SH = 9 * C;
  const map = L.makeCanvas(S, SH), emi = L.makeCanvas(S, SH);
  const mc = map.getContext('2d'), ec = emi.getContext('2d');
  ec.fillStyle = '#000'; ec.fillRect(0, 0, S, SH);
  const cells = { normal: [], wide: [] };
  const V = (row) => [1 - (row + 1) * C / SH, 1 - row * C / SH];
  const glowOnly = (x, y, w, h, kind, i) => {   // dark rooms: standby LEDs, exit signs, a TV left on, a light leak
    if (kind === 'officeDark') { ec.fillStyle = '#0e5a24'; ec.fillRect(x + w * 0.8, y + h * 0.2, w * 0.1, h * 0.06); for (let k = 0; k < 6; k++) { ec.fillStyle = k % 2 ? '#301010' : '#103018'; ec.fillRect(x + w * (0.1 + k * 0.15), y + h * 0.59, 3, 3); } }
    else if (kind === 'blindsDark' && L.hash(i, 4, 29) < 0.5) { ec.fillStyle = '#2a2014'; ec.fillRect(x, y + h * 0.96, w, h * 0.04); }
    else if (kind === 'darkRoom' && L.hash(i, 5, 29) < 0.35) { const g = ec.createRadialGradient(x + w * 0.6, y + h * 0.5, 0, x + w * 0.6, y + h * 0.5, w * 0.4); g.addColorStop(0, 'rgba(40,56,90,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ec.fillStyle = g; ec.fillRect(x, y, w, h); }
  };
  for (let i = 0; i < 32; i++) {
    const col = i % 8, row = (i / 8) | 0, lit = i >= 10, x = col * C, y = row * C;
    const kind = lit ? PUNCH_LIT[(i - 10) % PUNCH_LIT.length] : PUNCH_DARK[i % PUNCH_DARK.length];
    roomCell(mc, x, y, C, C, kind, lit, i);
    if (lit) ec.drawImage(map, x, y, C, C, x, y, C, C); else glowOnly(x, y, C, C, kind, i);
    const [v0, v1] = V(row);
    cells.normal.push({ u0: col / 8, v0, u1: (col + 1) / 8, v1, lit, warm: !['fluoro', 'stair', 'tv'].includes(kind), kind });
  }
  for (let i = 0; i < 16; i++) {
    const col = (i % 4) * 2, row = 4 + ((i / 4) | 0), lit = i >= 4, x = col * C, y = row * C;
    const kind = lit ? WIDE_LIT[i - 4] : WIDE_DARK[i];
    roomCell(mc, x, y, 2 * C, C, kind, lit, 100 + i);
    if (lit) ec.drawImage(map, x, y, 2 * C, C, x, y, 2 * C, C); else glowOnly(x, y, 2 * C, C, kind, 100 + i);
    const [v0, v1] = V(row);
    cells.wide.push({ u0: col / 8, v0, u1: (col + 2) / 8, v1, lit, warm: !['office', 'meeting', 'vacant', 'corridor', 'storage', 'clinic', 'gym'].includes(kind), kind });
  }
  // patches: [albedo, emissive] — anodised sash reveal (dark / lit warm / lit cool), precast sill (dark / lit),
  // mullion aluminium (dark / lit)
  const PATCH = [['#5e5c5a', '#000'], ['#b8a88e', '#6e5a3c'], ['#a8b0bc', '#44506a'], ['#a9a59d', '#000'], ['#b4aea2', '#2a2218'], ['#34363a', '#000'], ['#3a3c40', '#241e16']];
  const patch = {};
  ['reveal', 'revealWarm', 'revealCool', 'sill', 'sillLit', 'mullion', 'mullionLit'].forEach((k, i) => {
    const x = i * C, y = 8 * C;
    mc.fillStyle = PATCH[i][0]; mc.fillRect(x, y, C, C);
    for (let k2 = 0; k2 < 60; k2++) { mc.fillStyle = `rgba(0,0,0,${0.03 + L.hash(k2, i, 5) * 0.05})`; mc.fillRect(x + L.hash(k2, i, 6) * C, y, 3, C); }
    ec.fillStyle = PATCH[i][1]; ec.fillRect(x, y, C, C);
    const [v0, v1] = V(8);
    patch[k] = [(x + 48) / S, v0 + (v1 - v0) * 0.2, (x + C - 48) / S, v1 - (v1 - v0) * 0.2];
  });
  const mapT = L.canvasTex(map), emiT = L.canvasTex(emi);
  // low metalness + low roughness: the glass keeps a sharp sky reflection under the night IBL over the room
  const mat = new THREE.MeshStandardMaterial({ map: mapT, emissiveMap: emiT, emissive: 0xffffff, emissiveIntensity: 1.0, roughness: 0.1, metalness: 0.15, envMapIntensity: 1.5 });
  mat.name = 'gb_windows';
  mat.onBeforeCompile = glassShader;
  mat.customProgramCacheKey = () => 'gb_glass_room';
  mat.userData.attrs = [['cell', 4], ['room', 4]];
  emissives.push({ mat, day: 0.04, night: 0.85 });
  return { mat, cells, patch };
}
// Panes (cell ≠ 0): the ray from the camera is cast into a room box behind the glass — wider than the pane by a
// margin, floor below the sill, ceiling above the head, 3–6 m deep; the back wall samples the cell, the ceiling /
// floor / side walls sample the cell's outer bands, darkening with depth. room = (w, h, brightness jitter, warmth +
// 4 × room shift). Unlit panes also get a fresnel rim of the light-polluted sky, so dark glass separates from masonry.
const glassU = { uGlassNight: { value: 1 } };
function glassShader(shader) {
  shader.uniforms.uGlassNight = glassU.uGlassNight;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 cell; attribute vec4 room; varying vec4 vCell; varying vec4 vRoom; varying vec3 vWinPos; varying vec3 vWinNrm;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCell = cell; vRoom = room; vWinPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWinNrm = normalize(mat3(modelMatrix) * objectNormal);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uGlassNight; varying vec4 vCell; varying vec4 vRoom; varying vec3 vWinPos; varying vec3 vWinNrm;')
    .replace('#include <map_fragment>', `
  vec2 winUV = vMapUv; float winShade = 1.0; bool pane = vCell.z > vCell.x + 1e-5;
  if (pane) {
    vec2 cw = vCell.zw - vCell.xy, lc = clamp((vMapUv - vCell.xy) / cw, 0.0, 1.0);
    vec3 n = normalize(vWinNrm), t = vec3(n.z, 0.0, -n.x), V = normalize(vWinPos - cameraPosition);
    vec3 r = vec3(dot(V, t), V.y, -dot(V, n));
    float w = vRoom.x, h = vRoom.y, k = floor((vRoom.w + 2.0) / 4.0);
    float m = clamp(w * 0.45, 0.6, 1.6), fl = 0.9, ce = 0.45, D = clamp(w * 1.6, 3.2, 6.0);
    float Wr = w + 2.0 * m, Hr = h + fl + ce;
    vec3 p0 = vec3(m + (k / 3.0 - 0.5) * m * 1.4 + lc.x * w, fl + lc.y * h, 0.0);
    if (r.z > 0.02) {
      float tz = D / r.z;
      float tx = r.x > 0.0 ? (Wr - p0.x) / max(r.x, 1e-4) : p0.x / max(-r.x, 1e-4);
      float ty = r.y > 0.0 ? (Hr - p0.y) / max(r.y, 1e-4) : p0.y / max(-r.y, 1e-4);
      float tm = min(tz, min(tx, ty));
      vec3 hp = p0 + r * tm;
      float depth = clamp(hp.z / D, 0.0, 1.0);
      if (tm == tz) winUV = vCell.xy + clamp(vec2(hp.x / Wr, hp.y / Hr), 0.01, 0.99) * cw;
      else if (tm == tx) { winUV = vCell.xy + vec2(r.x > 0.0 ? 0.982 : 0.018, clamp(hp.y / Hr, 0.13, 0.87)) * cw; winShade = 0.5 + 0.4 * (1.0 - depth); }
      else { winUV = vCell.xy + vec2(clamp(hp.x / Wr, 0.02, 0.98), r.y > 0.0 ? 0.975 - 0.08 * depth : 0.02 + 0.08 * depth) * cw; winShade = 0.55 + 0.45 * (1.0 - depth); }
    }
  }
  vec4 sampledDiffuseColor = texture2D(map, winUV);
  diffuseColor *= sampledDiffuseColor * vec4(vec3(winShade), 1.0);`)
    .replace('#include <emissivemap_fragment>', `
  vec4 emissiveColor = texture2D(emissiveMap, winUV);
  if (pane) {
    float bj = vRoom.z > 0.01 ? vRoom.z : 1.0, kk = floor((vRoom.w + 2.0) / 4.0), warm = vRoom.w - 4.0 * kk;
    emissiveColor.rgb *= winShade * bj * mix(vec3(0.9, 0.96, 1.08), vec3(1.08, 0.95, 0.8), warm * 0.5 + 0.5);
  }
  totalEmissiveRadiance *= emissiveColor.rgb;
  {
    float litMask = smoothstep(0.02, 0.12, dot(totalEmissiveRadiance, vec3(0.3, 0.5, 0.2)));
    float dark = (1.0 - litMask) * (pane ? 1.0 : smoothstep(1.2, 1.55, diffuseColor.b / max(diffuseColor.r, 0.004)));
    float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
    totalEmissiveRadiance += dark * uGlassNight * (vec3(0.30, 0.22, 0.36) * (0.25 + 0.15 * fres) * (0.35 + 0.65 * fres) + diffuseColor.rgb * 0.05);
  }`);
}
const SHOP_TYPES = ['conv', 'izakaya', 'ramen', 'cafe', 'karaoke', 'drug', 'fashion', 'game', 'pachi', 'bank', 'bar', 'family', 'elec', 'books', 'fast', 'generic'];
const SHOP_PALETTE = {
  conv: ['#d6d6d0', '#ffffff', '#c8c8c0'], izakaya: ['#5a2a12', '#ffb347', '#6a4a2a'], ramen: ['#a8261a', '#fff4d0', '#4a3a30'], cafe: ['#4a3324', '#ffd9a0', '#3a2a1a'],
  karaoke: ['#3a1050', '#ff5ec4', '#2a1a3a'], drug: ['#d2d8da', '#ffffff', '#b8c4cc'], fashion: ['#d0ccc4', '#ffffff', '#b8b4ac'], game: ['#0a1a3a', '#40b0ff', '#18244a'],
  pachi: ['#ffe36a', '#ffffff', '#c04040'], bank: ['#1a2440', '#7a8ab0', '#202838'], bar: ['#2a1a12', '#ffb060', '#1a1210'], family: ['#f2e2b0', '#ffffff', '#b89860'],
  elec: ['#d0d6e4', '#ffffff', '#9aa8c8'], books: ['#dccfb4', '#ffffff', '#8a7050'], fast: ['#c81e1e', '#ffe040', '#7a2020'], generic: ['#d2cec6', '#ffffff', '#a8a49c'],
};
/**
 * Back wall of one shop type across a 2048 × 512 cell (14 m × 3.15 m, ≈145 px/m both ways): a 32 px palette column
 * on the left (ceiling / side wall / floor colours read by the interior-mapping shader), then shelves of shaded
 * product packs / counters / machines, a row of category boards (a different board every ~2 m from a per-type pool,
 * so neighbouring bays that sample other windows of the cell never repeat) and staff / shoppers as proper cut-outs.
 * Quads sample a 1/8-texture window of the cell at 4 offsets; the shader ray-marches floor, ceiling and side walls.
 */
const MUTE = ['#b8605a', '#5b7aa6', '#c7ab63', '#5e8c6c', '#b58aa0', '#ddd8cc', '#c28d5e', '#7a6e9c', '#8a9aa4', '#a4744e'];
const SHOP_BOARDS = {
  drug: ['医薬品', '化粧品', '日用品', 'サプリ', '衛生用品', 'ベビー', 'ヘアケア', '免税 TAX FREE', 'ポイント5倍', '風邪薬', '目薬', 'コスメ', '入浴剤', 'ドリンク剤', '日焼け止め', 'マスク'],
  conv: ['お弁当', 'ドリンク', 'お菓子', '雑誌', '日用品', 'ATM', 'おにぎり', 'パン', 'デザート', 'コピー', 'ホットスナック', 'お酒', 'たばこ', '冷凍食品', 'カップ麺', '文具'],
  elec: ['スマホ', 'カメラ', 'PC', '家電', 'ゲーム', 'オーディオ', 'イヤホン', '時計', 'ドローン', 'SIM', 'タブレット', '美容家電', '免税', '修理受付', 'ケーブル', 'VR'],
  books: ['新刊', 'コミック', '文庫', '雑誌', '旅行', 'ビジネス', '洋書', '児童書', '文芸', '話題の本', 'ラノベ', '写真集', '料理', '語学', 'アート', '地図'],
  fashion: ['NEW IN', 'SALE', 'MEN', 'WOMEN', 'SHOES', 'BAGS', 'DENIM', 'KNIT', 'OUTER', 'ACCESSORY', 'TAX FREE', 'LIMITED', 'T-SHIRT', 'SOCKS', 'CAP', 'GIFT'],
  generic: ['SALE', 'NEW', 'GIFT', 'OUTLET', 'TOP 10', '限定', 'CHARACTER', 'STATIONERY', 'COSME', 'SNACK', 'TOY', 'INTERIOR', 'KITCHEN', 'TRAVEL', 'SOUVENIR', 'PARTY'],
};
function drawShopCell(ctx, x, y, W, H, type, k) {
  const P = SHOP_PALETTE[type];
  const col = (c, m = 1) => { const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16); return `rgb(${Math.min(255, r * m) | 0},${Math.min(255, g * m) | 0},${Math.min(255, b * m) | 0})`; };
  const PW = W / 64;
  ctx.fillStyle = col(P[1], 0.92); ctx.fillRect(x, y, PW, H / 3);                   // palette: ceiling
  ctx.fillStyle = col(P[0], 0.8); ctx.fillRect(x, y + H / 3, PW, H / 3);            // side wall
  ctx.fillStyle = col(P[2], 0.75); ctx.fillRect(x, y + 2 * H / 3, PW, H / 3);       // floor
  const x0 = x + PW, CW = W - PW;
  const X = (m) => x0 + m * (CW / 14), Y = (m) => y + H - m * (H / 3.15), MX = CW / 14, MY = H / 3.15;   // metres → px
  const rect = (mx, my, mw, mh, c) => { ctx.fillStyle = c; ctx.fillRect(X(mx), Y(my + mh), mw * MX, mh * MY); };
  const text = (t, mx, my, mh, c, font = L.FONT_JP, weight = '800', maxW = 0) => { ctx.save(); ctx.translate(X(mx), Y(my)); ctx.fillStyle = c; ctx.font = `${weight} ${mh * MY}px ${font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; if (maxW) { const w0 = ctx.measureText(t).width; if (w0 > maxW * MX) ctx.scale(maxW * MX / w0, 1); } ctx.fillText(t, 0, 0); ctx.restore(); };
  const h = (a, b) => L.hash(a, b, k + 31);
  // back wall + skirting + a vertical gradient (lit from the ceiling)
  ctx.fillStyle = col(P[0]); ctx.fillRect(x0, y, CW, H);
  const g = ctx.createLinearGradient(0, y, 0, y + H); g.addColorStop(0, 'rgba(255,255,255,0.06)'); g.addColorStop(0.5, 'rgba(0,0,0,0.04)'); g.addColorStop(1, 'rgba(0,0,0,0.28)'); ctx.fillStyle = g; ctx.fillRect(x0, y, CW, H);
  rect(0, 0, 14, 0.12, col(P[2], 0.7));
  const shelfType = ['conv', 'drug', 'elec', 'books', 'fashion', 'generic'].includes(type);
  const counterType = ['izakaya', 'ramen', 'cafe', 'bar', 'family', 'fast'].includes(type);
  // a shaded retail pack: gradient body, label band, print lines, cap shadow
  const pack = (mx, my, w, hh, c, kind) => {
    const gx = ctx.createLinearGradient(0, Y(my + hh), 0, Y(my));
    gx.addColorStop(0, col(c, 1.12)); gx.addColorStop(0.5, col(c, 0.95)); gx.addColorStop(1, col(c, 0.7));
    ctx.fillStyle = gx; ctx.fillRect(X(mx), Y(my + hh), w * MX, hh * MY);
    if (kind === 0) { rect(mx + w * 0.1, my + hh * 0.42, w * 0.8, hh * 0.24, 'rgba(240,236,226,0.75)'); rect(mx + w * 0.18, my + hh * 0.52, w * 0.64, hh * 0.035, 'rgba(40,36,34,0.55)'); rect(mx + w * 0.18, my + hh * 0.47, w * 0.44, hh * 0.03, 'rgba(40,36,34,0.4)'); }
    else if (kind === 1) { rect(mx, my + hh * 0.72, w, hh * 0.12, 'rgba(255,255,255,0.35)'); rect(mx + w * 0.2, my + hh * 0.25, w * 0.6, hh * 0.3, 'rgba(0,0,0,0.12)'); }
    else { ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.beginPath(); ctx.ellipse(X(mx + w / 2), Y(my + hh * 0.55), w * 0.28 * MX, hh * 0.16 * MY, 0, 0, 6.3); ctx.fill(); }
    rect(mx, my + hh - 0.012, w, 0.012, 'rgba(0,0,0,0.35)');
    rect(mx + w - 0.006, my, 0.006, hh, 'rgba(0,0,0,0.3)');
  };
  // shoppers / staff: the 19 scans as full-body cut-outs standing on the shop floor (staff = the salaryman / office
  // scans), darker and softer the smaller (further back) they are; the painted figure is only the no-sheet fallback
  const person = (mx, base, sc, i, staff = false) => {
    if (PEDS) {
      const key = pedKey(i * 5 + k * 3 + (staff ? 1 : 0), staff), ht = PEDS.meta.scans[key].height;
      const view = staff ? (i % 3 ? 'front' : 'q34') : (i % 2 ? 'q34' : 'front');
      // the cut-out's cell is 1.90 m tall; ppm scaled so the person's real height stands at sc (the old figure's 1.62·sc)
      const sp = 1.62 / ht * sc;
      if (paintPed(ctx, key, 'full', view, X(mx), Y(base), MX * sp, MY * sp, { dark: 0.16 + 0.3 * Math.max(0, 1.05 - sc), soft: 0.6 + 4 * Math.max(0, 1.05 - sc), flip: (i + k) % 2 === 1 })) return;
    }
    const skin = ['#d9b39a', '#c99c80', '#e2c0a6', '#b88a6c'][i % 4], hair = ['#1c1814', '#2a221c', '#3a2c20', '#5a4838', '#161616'][(i * 3) % 5];
    const cloth = ['#3a4454', '#6a5a4a', '#2c2c30', '#7a3a3a', '#44584a', '#c8c4bc', '#4a4a6a', '#8a7a5a'][(i * 5 + k) % 8];
    const top = base + 1.62 * sc, sh = top - 0.3 * sc;
    ctx.fillStyle = col(cloth); ctx.beginPath(); ctx.moveTo(X(mx - 0.2 * sc), Y(sh - 0.04 * sc)); ctx.lineTo(X(mx + 0.2 * sc), Y(sh - 0.04 * sc)); ctx.lineTo(X(mx + 0.17 * sc), Y(base)); ctx.lineTo(X(mx - 0.17 * sc), Y(base)); ctx.closePath(); ctx.fill();
    rect(mx - 0.25 * sc, base + 0.55 * sc, 0.07 * sc, sh - base - 0.6 * sc, col(cloth, 0.8)); rect(mx + 0.18 * sc, base + 0.55 * sc, 0.07 * sc, sh - base - 0.6 * sc, col(cloth, 0.8));   // sleeves
    ctx.fillStyle = col(cloth, 1.08); ctx.beginPath(); ctx.ellipse(X(mx), Y(sh - 0.05 * sc), 0.21 * sc * MX, 0.07 * sc * MY, 0, Math.PI, 0); ctx.fill();   // shoulder line
    rect(mx - 0.035 * sc, sh - 0.02 * sc, 0.07 * sc, 0.08 * sc, skin);                                                  // neck
    ctx.fillStyle = skin; ctx.beginPath(); ctx.ellipse(X(mx), Y(top - 0.12 * sc), 0.085 * sc * MX, 0.115 * sc * MY, 0, 0, 6.3); ctx.fill();
    ctx.fillStyle = hair; ctx.beginPath(); ctx.ellipse(X(mx), Y(top - 0.08 * sc), 0.092 * sc * MX, 0.085 * sc * MY, 0, Math.PI, 0); ctx.fill();
    if (i % 3 === 1) rect(mx - 0.092 * sc, top - 0.2 * sc, 0.03 * sc, 0.12 * sc, hair);                            // longer hair
    if (i % 4 === 2) rect(mx - 0.16 * sc, base + 0.62 * sc, 0.32 * sc, 0.05 * sc, '#1a1a1a');                        // apron / bag strap
  };
  if (shelfType) {
    for (let r = 0; r < 4; r++) {
      const yy = 0.55 + r * 0.55;
      rect(0.2, yy - 0.05, 13.6, 0.05, 'rgba(0,0,0,0.22)');                                             // shelf shadow
      rect(0.2, yy, 13.6, 0.035, col(P[2], 0.85));
      rect(0.2, yy - 0.035, 13.6, 0.03, 'rgba(236,232,220,0.9)');                                         // price rail
      let mx = 0.3, gi = 0;
      while (mx < 13.6) {
        const n = 3 + Math.floor(h(mx * 10, r) * 6), pw = 0.07 + h(mx * 7, r + 3) * 0.08, ph = 0.14 + h(mx * 7, r + 9) * 0.26, kind = Math.floor(h(gi, r + 4) * 3);
        const c = type === 'fashion' ? ['#d8d0c6', '#3a3a3c', '#8a4a44', '#4a5a74', '#cfcac0', '#6a6450'][(gi + r) % 6] : MUTE[(gi * 3 + r + k) % MUTE.length];
        if (h(mx * 3, r + 5) < 0.9) for (let q = 0; q < n && mx + pw < 13.7; q++) { if (type === 'fashion') { rect(mx, yy + 0.03, pw * 0.9, ph * 1.3, col(c, 0.9 + h(q, gi) * 0.2)); rect(mx, yy + 0.03 + ph * 1.3 - 0.02, pw * 0.9, 0.02, 'rgba(0,0,0,0.3)'); } else pack(mx, yy + 0.035, pw - 0.008, ph, c, kind); if (q % 3 === 0) rect(mx + pw * 0.2, yy - 0.03, 0.05, 0.02, '#e8c848'); mx += pw; }
        mx += 0.04 + h(gi, r + 7) * 0.12; gi++;
      }
    }
    const pool = SHOP_BOARDS[type] || SHOP_BOARDS.generic, catBg = ['#2c5a9e', '#a8323e', '#2e6e56', '#c7822e', '#6a4a8a', '#2a7a92'];
    for (let i = 0; i < 7; i++) { const mx = 0.35 + i * 1.95; const t = pool[(i * 5 + k * 3) % pool.length]; rect(mx, 2.44, 1.7, 0.4, catBg[(i + k) % catBg.length]); rect(mx, 2.44, 1.7, 0.03, 'rgba(0,0,0,0.3)'); text(t, mx + 0.85, 2.64, 0.26, '#f4f2ec', L.FONT_JP, '800', 1.55); }
    rect(11.2, 0.12, 1.0, 2.1, col(P[2], 0.5)); rect(11.28, 0.2, 0.84, 1.9, col(P[2], 0.42));             // back-room door
    for (let i = 0; i < 2 + (k % 2); i++) person(1.2 + h(i, 17) * 11.6, 0.12, 0.92 + h(i, 19) * 0.12, i + k);
    if (type === 'fashion') { for (let i = 0; i < 4; i++) { const mx = 1.2 + i * 3.4 + h(i, 2) * 0.8; rect(mx, 0.12, 0.05, 1.1, 'rgba(60,60,60,0.9)'); rect(mx - 0.22, 1.0, 0.5, 0.7, ['#d8d0c6', '#3a3a3c', '#8a4a44', '#4a5a74'][i % 4]); ctx.beginPath(); ctx.fillStyle = '#d8d4cc'; ctx.ellipse(X(mx + 0.03), Y(1.84), 0.1 * MX, 0.12 * MY, 0, 0, 6.3); ctx.fill(); } }   // mannequins
    rect(0.6, 0.12, 2.6, 0.95, col(P[2], 0.9)); rect(0.6, 1.07, 2.6, 0.05, '#f0eee8'); rect(0.6, 0.12, 2.6, 0.08, 'rgba(0,0,0,0.3)');   // checkout counter
    if (type === 'conv') { rect(0.8, 1.12, 0.45, 0.4, '#2a2a2e'); rect(0.84, 1.18, 0.37, 0.26, '#6a8aa8'); rect(2.2, 1.12, 0.7, 0.85, '#cfcbbf'); rect(2.25, 1.18, 0.6, 0.6, '#d8a860'); }   // register / hot snack case
  } else if (counterType) {
    rect(0.2, 1.55, 13.6, 0.05, col(P[2], 0.8)); rect(0.2, 2.15, 13.6, 0.05, col(P[2], 0.8));
    for (let mx = 0.4; mx < 13.6; mx += 0.16) { const bh = 0.2 + h(mx * 10, 1) * 0.26; if (h(mx * 5, 2) < 0.8) { const c = ['#3a5a3a', '#7a5a3a', '#cfc2a0', '#2a2a3a', '#a89060'][(mx * 6 | 0) % 5]; pack(mx, 1.6, 0.1, bh, c, 1); } if (h(mx * 9, 3) < 0.6) rect(mx, 2.2, 0.11, 0.18 + h(mx, 4) * 0.2, ['#e8e6de', '#cfc2a8', '#b8b8b8'][(mx * 4 | 0) % 3]); }
    const menuBg = type === 'ramen' ? '#e2dac4' : type === 'fast' ? '#e8cc58' : type === 'cafe' ? '#2a1a10' : '#ece4d0', menuFg = type === 'ramen' ? '#8a2a20' : type === 'cafe' ? '#e8c894' : '#1a1a1a';
    const MENUS = {
      izakaya: ['本日のおすすめ  刺身 ・ 焼鳥 ・ 生ビール', '串焼き 一本 180円  ・  枝豆  ・  唐揚げ', '飲み放題 90分 1,500円'],
      ramen: ['らーめん  醤油 850 ・ 味噌 900 ・ 替玉 150', 'つけ麺 950  ・  餃子 350  ・  ライス 100', '深夜2時まで営業'],
      cafe: ['COFFEE ・ LATTE ・ CAKE SET', 'SEASONAL  ―  MATCHA LATTE', 'SANDWICH ・ SCONE ・ TEA'],
      bar: ['WHISKY ・ HIGHBALL ・ WINE', 'HAPPY HOUR  18:00–20:00', 'CRAFT BEER  ON TAP'],
      family: ['ハンバーグ ・ ドリンクバー ・ パフェ', 'モーニング 7:00–10:30', '期間限定  苺フェア'],
      fast: ['BURGER SET ￥690 ・ POTATO ・ SHAKE', '朝マック  5:00–10:30', 'NEW  てりやき ダブル'],
    }[type];
    [1.0, 8.2].forEach((mx, j) => { rect(mx, 2.45, 5.0, 0.55, menuBg); rect(mx, 2.45, 5.0, 0.03, 'rgba(0,0,0,0.25)'); text(MENUS[(j + k) % MENUS.length], mx + 2.5, 2.72, 0.28, menuFg, L.FONT_JP, '700', 4.7); });
    rect(6.3, 0.12, 1.6, 2.2, '#3a3a3c'); rect(6.4, 1.2, 1.4, 0.9, '#e8dcc0');                          // kitchen pass (lit)
    if (type === 'izakaya' || type === 'bar') for (let i = 0; i < 9; i++) { ctx.fillStyle = '#c8482e'; ctx.beginPath(); ctx.ellipse(X(0.9 + i * 1.5), Y(2.75), 0.17 * MX, 0.24 * MY, 0, 0, 6.3); ctx.fill(); ctx.fillStyle = '#1a1a1a'; ctx.beginPath(); ctx.ellipse(X(0.9 + i * 1.5), Y(2.75), 0.06 * MX, 0.2 * MY, 0, 0, 6.3); ctx.fill(); }
    for (let i = 0; i < 2 + (k % 2); i++) person(0.9 + h(i, 23) * 12.2, 0.12, 0.95 + h(i, 29) * 0.1, i + k + 1, true);   // staff behind the counter
    rect(0.4, 0.12, 5.6, 1.0, col(P[2])); rect(8.0, 0.12, 5.6, 1.0, col(P[2]));                        // counters
    rect(0.4, 1.12, 5.6, 0.05, '#ddd2be'); rect(8.0, 1.12, 5.6, 0.05, '#ddd2be');
    for (let i = 0; i < 12; i++) { const mx = 0.7 + i * 1.1 + (i > 5 ? 0.9 : 0); rect(mx, 0.12, 0.08, 0.55, '#2a2a2a'); rect(mx - 0.14, 0.62, 0.36, 0.1, type === 'cafe' ? '#5a3a24' : '#7a3a2a'); }   // stools
  } else if (type === 'karaoke' || type === 'game' || type === 'pachi') {
    const rows = type === 'pachi' ? 2 : 1, scr = ['#e05a5a', '#4a86d8', '#e8c850', '#50b070', '#d870b0', '#f0f0f0', '#e89040', '#8a70d0'];
    for (let r = 0; r < rows; r++) for (let i = 0; i < 11; i++) {
      const mx = 0.3 + i * 1.25, my = r * 1.4;
      rect(mx, my + 0.12, 1.05, type === 'pachi' ? 1.2 : 1.9, type === 'pachi' ? '#d0c8b8' : '#1c1c22');
      rect(mx + 0.1, my + (type === 'pachi' ? 0.55 : 1.05), 0.85, type === 'pachi' ? 0.65 : 0.8, scr[(i * 3 + r + k) % scr.length]);   // lit screen
      if (type !== 'pachi') rect(mx + 0.15, my + 0.25, 0.75, 0.55, '#3a3a44');
      if (type === 'pachi') { rect(mx + 0.05, my + 0.2, 0.95, 0.2, '#e8d060'); }
    }
    for (let i = 0; i < 6; i++) rect(0.6 + i * 2.4, 2.55, 1.6, 0.4, ['#e05ab4', '#4aa0e8', '#e8d060'][i % 3]);   // ceiling-height signs
    text(type === 'karaoke' ? 'カラオケ  ★  フリータイム' : type === 'game' ? 'GAME  ・  UFO CATCHER' : 'パチンコ ・ スロット  新台入替', 7, 2.75, 0.34, '#101010');
    for (let i = 0; i < 2; i++) person(2 + h(i, 31) * 10, 0.12, 0.95, i + k + 2);
  } else if (type === 'bank') {
    for (let i = 0; i < 5; i++) person(1.5 + i * 2.7, 0.3, 0.9, i + 3, true);                            // tellers
    rect(0.4, 0.12, 13.2, 1.0, '#d0d4dc'); rect(0.4, 1.12, 13.2, 0.05, '#f4f4f4');                      // counter line
    for (let i = 0; i < 5; i++) { rect(0.8 + i * 2.7, 1.2, 1.4, 0.3, '#e8eaf0'); rect(1.0 + i * 2.7, 1.25, 1.0, 0.2, '#3a4a7a'); }   // teller screens
    for (let i = 0; i < 3; i++) rect(9.6 + i * 1.3, 0.12, 1.0, 1.6, '#b0b8c8');                          // ATMs
    rect(2.0, 2.45, 10, 0.5, '#1a3a7a'); text('ATM  ・  ご相談窓口  9:00–15:00', 7, 2.7, 0.3, '#ffffff');
  }
}
function makeShopAtlas() {
  // 4 × 4 cells of 2048 × 512 (8192 × 2048): the UV layout is the old 4096-wide one scaled, so callers that address
  // the atlas in 1/4096 units (MAGNET, 109, shared shopfronts) keep working at twice the texel density
  const W = 8192, H = 2048, CW = 2048, CH = 512;
  const map = L.makeCanvas(W, H), mc = map.getContext('2d');
  const cells = {};
  SHOP_TYPES.forEach((t, i) => {
    const col = i % 4, row = (i / 4) | 0;
    drawShopCell(mc, col * CW, row * CH, CW, CH, t, i);
    cells[t] = { u: col / 4, v0: 1 - (row + 1) / 4, v1: 1 - row / 4 };
  });
  const tex = L.canvasTex(map, { aniso: 8 });
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.2, metalness: 0.3, envMapIntensity: 1.0 });
  mat.name = 'gb_shops';
  mat.onBeforeCompile = shopInteriorShader;
  mat.customProgramCacheKey = () => 'gb_shop_interior';
  mat.userData.attrs = [['cell', 4], ['room', 4]];
  emissives.push({ mat, day: 0.2, night: 0.85 });
  return { mat, cells };
}
/** Atlas window [u0,v0,u1,v1] for a shop type: one of 4 offsets into the cell, chosen by `variant` (0–3, so a run of
 *  bays can step through them and neighbours never share a window) or hashed from `seed`. No mirroring (text). */
export function shopUV(type, seed = 0, variant = null) {
  // a continuous offset into the 14 m cell (not 4 fixed windows): two shops of one type within sight show different
  // shelves, boards and people (client: 「この辺の建物の画像が全部同じなのが違和感」)
  const A = getAtlases();
  const c = A.shop.cells[type] || A.shop.cells.generic;
  const hv = variant != null ? L.hash(variant * 7 + 3, seed * 3 + 11, 77) : L.hash(seed, 3, 77);
  const o = (2 + hv * 508) / 4096, w = 512 / 4096;
  return [c.u + o, c.v0, c.u + o + w, c.v1];
}
/** Flat window pane (no surround) that is interior-mapped like a window unit's: room cell + (w, h, jitter, warmth). */
export function paneQuad(cx, cy, cz, nx, nz, w, h, lift, cl, { bright = 1, warm = 0, shift = 0 } = {}) {
  const g = L.wallQuad(cx, cy, cz, nx, nz, w, h, lift, [cl.u0, cl.v0, cl.u1, cl.v1]);
  const cell = new Float32Array(16), room = new Float32Array(16);
  for (let k = 0; k < 4; k++) { cell.set([cl.u0, cl.v0, cl.u1, cl.v1], k * 4); room.set([w, h, bright, Math.max(-1, Math.min(1, warm)) + 4 * (shift & 3)], k * 4); }
  g.setAttribute('cell', new THREE.BufferAttribute(cell, 4)); g.setAttribute('room', new THREE.BufferAttribute(room, 4));
  return g;
}
/** Wall quad with the `cell` / `room` attributes the interior-mapping shader needs. */
export function shopQuad(cx, cy, cz, nx, nz, w, h, lift, uvr, { warm = null, bright = null } = {}) {
  const g = L.wallQuad(cx, cy, cz, nx, nz, w, h, lift, uvr);
  const n = g.attributes.position.count;
  // per-shop light: colour temperature (0 warm … 1 cool) and level, hashed from the position unless given
  const wm = warm != null ? warm : L.hash(Math.round(cx * 3), Math.round(cz * 3), 131);
  const br = bright != null ? bright : 0.82 + 0.3 * L.hash(Math.round(cz * 3), Math.round(cx * 3), 137);
  const cell = new Float32Array(n * 4), room = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { cell.set(uvr, i * 4); room.set([w, h, wm, br], i * 4); }
  g.setAttribute('cell', new THREE.BufferAttribute(cell, 4));
  g.setAttribute('room', new THREE.BufferAttribute(room, 4));
  return g;
}
/**
 * Real depth on one shopfront bay (client: 「薄っぺらい。実態に合わせるように」). Retail: the display window stands
 * 0.45 m proud of the building line — a lit display bed behind framed case glass — and the entrance sits back on
 * the line between the case's cheeks (door frame, transom, push bars, mat), so every shop has a recessed door, a
 * lit window with a floor and a visible way in. Eateries: a small food-sample case, the door under a noren.
 * (cx, cz) bay centre on the facade line, (nx, nz) outward, sw bay width, gh glass height, y0 its sill.
 */
const EATERY = new Set(['izakaya', 'ramen', 'bar']);
const TENANT_USED = new Set();
// Every ground-floor shop bay the city builds (infill + landmark rows): the 3D interiors (interiors.js) build a real
// room behind the nearest ones. { x, z (facade line, bay centre), y0, nx, nz (outward), w, gh (glass), type, name,
// real (tenantsData row), depth (m of building behind the glass) }
export const SHOP_BAYS = [];
export function registerShopBay(b) { if (b && b.w > 1.5 && b.gh > 1.8) SHOP_BAYS.push(b); }
// The real tenants (tenantsData.js) are handed out once each, to the shop bay in front of their survey point: points
// sit ~7 m out from the facade on the street, so a bay takes the nearest unused one between 4 m behind and 7.5 m in
// front of its facade line, anywhere along the bay (+1.5 m). Landmark shop rows use the same claim (shared.shopRow).
export function claimRealTenant(x, z, nx, nz, halfW = 4, upper = false, latMin = -4) {
  let best = null, bd = upper ? 7 : Math.max(5, halfW + 1.5);
  for (const t of SHOP_TENANTS) {
    if (TENANT_USED.has(t) || (upper ? !(t.floor > 1) : t.floor > 1)) continue;
    const dx = t.pos[0] - x, dz = t.pos[1] - z, lat = dx * nx + dz * nz, along = Math.abs(-dx * nz + dz * nx);
    if (lat < latMin || lat > 7.5) continue;
    const d = along + 0.15 * Math.abs(lat); if (d < bd) { bd = d; best = t; }
  }
  if (best) TENANT_USED.add(best);
  return best;
}
export function claimRealByName(name, x, z, nx, nz, reach) {
  let best = null, bd = reach;
  for (const t of SHOP_TENANTS) {
    if (t.name !== name || t.floor > 1 || TENANT_USED.has(t)) continue;
    const dx = t.pos[0] - x, dz = t.pos[1] - z, lat = dx * nx + dz * nz, along = Math.abs(-dx * nz + dz * nx);
    if (lat < -4 || lat > 7.5 || along > bd) continue;
    bd = along; best = t;
  }
  if (best) TENANT_USED.add(best);
  return best;
}
/** Unused real ground-floor shops in front of the frontage a → b (outward nx, nz). */
export function realCountAlong(a, b, nx, nz, latMin = -4) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
  let k = 0;
  for (const t of SHOP_TENANTS) {
    if (t.floor > 1 || TENANT_USED.has(t)) continue;
    const dx = t.pos[0] - a[0], dz = t.pos[1] - a[1], lat = dx * nx + dz * nz, along = dx * tx + dz * tz;
    if (lat > latMin && lat < 7.5 && along > -1 && along < len + 1) k++;
  }
  return k;
}
/** A landmark's own name shown on its sign counts as that tenant shown. */
export function markTenantShown(re, near, r = 30) {
  for (const t of SHOP_TENANTS) if (!TENANT_USED.has(t) && re.test(t.name) && Math.hypot(t.pos[0] - near[0], t.pos[1] - near[1]) < r) TENANT_USED.add(t);
}
const NAMES_SHOWN = new Set(), SHOP_NAME_SET = new Set(SHOP_TENANTS.map((t) => t.name));
/** How many of the real tenants (tenantsData.js) found a shop bay / 2F board. */
export function tenantUsed() { return TENANT_USED; }
export function tenantStats() { let gf = 0, up = 0; for (const t of TENANT_USED) (t.floor > 1 ? up++ : gf++); return { gf, up, of: SHOP_TENANTS.length }; }
const NOREN_GEO = (() => { const g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0); return g; })();
export function shopFrontDepth(batch, inst, { cx, cz, nx, nz, sw, gh, y0 = 0.15, type = 'generic', seed = 0 }) {
  if (gh < 1.9 || sw < 3.2) return;
  const At = getAtlases(), tx = -nz, tz = nx, r = Math.atan2(-tz, tx);
  const side = L.hash(Math.round(cx * 5), Math.round(cz * 5), 151 + seed) < 0.5 ? -1 : 1;
  const P = 0.45, DW = 1.3, edge = sw / 2 - 0.3;
  const sd = side * (edge - DW / 2);                                            // door centre along the bay
  const at = (s, o) => [cx + tx * s + nx * o, cz + tz * s + nz * o];
  const box = (mat, s, y, o, w, h, d) => { const [x, z] = at(s, o); batch.add(mat, L.boxAt(x, y, z, w, h, d, r, false), cx, cz); };
  // the entrance: frame posts, transom, glass leaves' push bars, the mat
  const dh = Math.min(2.3, gh - 0.1);
  for (const e of [-DW / 2, DW / 2]) box(At.trim, sd + e, y0 + dh / 2, 0.06, 0.08, dh, 0.12);
  box(At.trim, sd, y0 + dh + 0.05, 0.06, DW + 0.16, 0.1, 0.12);
  for (const e of [-0.18, 0.18]) box(At.metal, sd + e, y0 + 1.05, 0.1, 0.03, 0.9, 0.04);
  box(At.matMat, sd, 0.155, 0.45, DW, 0.012, 0.8);
  // the window: display case in front of the rest of the bay (a food-sample case for eateries)
  const eat = EATERY.has(type);
  const w0 = side > 0 ? -edge : sd + DW / 2 + 0.05, w1 = side > 0 ? sd - DW / 2 - 0.05 : edge;
  let ca = w0, cb = w1;
  if (eat) { const mid = (w0 + w1) / 2; ca = mid - 0.8; cb = mid + 0.8; }
  const ww = cb - ca, wc = (ca + cb) / 2; if (ww < 0.8) return;
  const top = eat ? y0 + 1.5 : y0 + gh - 0.05, bed = eat ? y0 + 0.85 : y0 + 0.42;
  box(At.plinth, wc, (0.15 + bed) / 2, P / 2, ww, bed - 0.15, P);                       // case base (stone)
  box(At.displayMat, wc, bed + 0.01, P / 2, ww - 0.08, 0.02, P - 0.06);                 // the lit display bed
  box(At.trim, wc, top + 0.05, P / 2, ww + 0.04, 0.1, P + 0.02);                        // head
  for (const e of [ca, cb]) box(At.trim, e, (bed + top) / 2, P - 0.02, 0.05, top - bed, 0.05);   // corner mullions
  const [gx, gz] = at(wc, P);
  batch.add(At.caseGlass, L.wallQuad(gx, (bed + top) / 2, gz, nx, nz, ww, top - bed, 0.0), cx, cz);
  for (const e of [ca, cb]) { const [ex, ez] = at(e, P / 2); batch.add(At.caseGlass, L.wallQuad(ex, (bed + top) / 2, ez, e === ca ? -tx : tx, e === ca ? -tz : tz, P, top - bed, 0.0), cx, cz); }
  if (eat) {                                                                    // noren over the door, three panels
    const cols = [0x1a3a8a, 0xc8102e, 0x2a2a2a, 0xe8e0c8, 0x6a1a3a];
    const col = cols[Math.floor(L.hash(Math.round(cx), Math.round(cz), 157) * cols.length)];
    for (const e of [-0.42, 0, 0.42]) { const [x, z] = at(sd + e, 0.14); inst.add('gb_noren', NOREN_GEO, At.awningMat, x, y0 + dh - 0.62, z, r, 0.4, 0.6, 0.02, col); }
  }
  // the case, for the shop interiors (interiors.js dresses its bed): `s` along (−nz, nx) from (cx, cz), heights from y0
  return { s: wc, w: ww, bed: bed - y0, top: top - y0, depth: P, eat };
}
// Interior mapping: the quad is the shop window; a ray from the camera is intersected with a box (w × h × D) behind
// it in tangent space. Back wall hits sample the atlas window, floor / ceiling / side walls are flat palette colours
// (read from the cell's palette column) with tile lines, shelf edges and emissive ceiling strip lights.
function shopInteriorShader(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 cell; attribute vec4 room; varying vec4 vCell; varying vec4 vRoom; varying vec3 vShopPos; varying vec3 vShopNrm;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCell = cell; vRoom = room; vShopPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vShopNrm = normalize(mat3(modelMatrix) * objectNormal);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
varying vec4 vCell; varying vec4 vRoom; varying vec3 vShopPos; varying vec3 vShopNrm;
vec3 shopInterior(vec2 uvIn, out float lightAdd) {
  lightAdd = 0.0;
  vec2 cw = vCell.zw - vCell.xy;
  vec2 lc = (uvIn - vCell.xy) / cw;
  vec3 n = normalize(vShopNrm);
  vec3 t = vec3(n.z, 0.0, -n.x);
  vec3 V = normalize(vShopPos - cameraPosition);
  vec3 r = vec3(dot(V, t), V.y, -dot(V, n));
  float w = vRoom.x, h = vRoom.y, D = clamp(w * 0.55, 2.5, 6.0);
  vec2 cellO = floor(min(vCell.xy, vCell.zw) * 4.0) / 4.0;
  vec2 uv = uvIn;
  if (r.z > 0.03) {
    vec3 p0 = vec3(lc.x * w, lc.y * h, 0.0);
    float tz = D / r.z;
    float tx = r.x > 0.0 ? (w - p0.x) / max(r.x, 1e-4) : p0.x / max(-r.x, 1e-4);
    float ty = r.y > 0.0 ? (h - p0.y) / max(r.y, 1e-4) : p0.y / max(-r.y, 1e-4);
    float tm = min(tz, min(tx, ty));
    vec3 hp = p0 + r * tm;
    float depth = clamp(hp.z / D, 0.0, 1.0);
    if (tm == tz) {
      uv = vCell.xy + vec2(hp.x / w, hp.y / h) * cw;
    } else if (tm == tx) {
      // side walls carry the shop's own shelving (the atlas window repeated along the depth), darker toward the
      // back: seen at a grazing angle down a street a shop reads as stocked shelves, never a blank white shutter
      float su = fract(hp.z / max(w * 0.8, 1.2));
      vec2 suv = vCell.xy + vec2(r.x > 0.0 ? 1.0 - su : su, hp.y / h) * cw;   // reads left to right from the street on both walls
      return texture2D(map, suv).rgb * (0.5 + 0.38 * (1.0 - depth));
    } else {
      float pal = (tm == tx) ? 0.5 : (r.y < 0.0 ? 0.17 : 0.83);
      vec3 tint = texture2D(map, cellO + vec2(0.002, pal * 0.25)).rgb * (0.38 + 0.5 * (1.0 - depth));
      if (tm == tx) { if (fract(hp.y / 0.45) < 0.08) tint *= 0.55; }
      else if (r.y < 0.0) { if (fract(hp.x / 0.6) < 0.06 || fract(hp.z / 0.6) < 0.06) tint *= 0.7; }
      else { float lx = fract(hp.x / 1.6); float lz = fract((hp.z + 0.4) / 1.5); if (lx > 0.15 && lx < 0.85 && lz < 0.2) { tint = vec3(1.0, 0.98, 0.92); lightAdd = 1.2; } }
      return tint;
    }
  }
  return texture2D(map, uv).rgb;
}`)
    .replace('#include <map_fragment>', 'float shopLight = 0.0; vec3 shopCol = shopInterior(vMapUv, shopLight) * mix(vec3(1.07, 0.98, 0.86), vec3(0.9, 0.97, 1.08), vRoom.z) * vRoom.w; diffuseColor.rgb *= shopCol * 0.6;')
    // back-light tone-compressed (a white back wall tops out at ~0.6 × intensity, never a clipped white slab); the
    // brightness sits in the discrete ceiling strip lights
    .replace('#include <emissivemap_fragment>', 'vec3 shopE = shopCol / (1.0 + dot(shopCol, vec3(0.3, 0.5, 0.2)) * 0.75); totalEmissiveRadiance *= min(shopE, vec3(0.62)) + shopCol * shopLight * 0.9;');
}
// tenant fascia strips: 8 columns × 32 rows of 512×64 on a 4096×2048 canvas
const FASCIA_STYLES = [
  { bg: '#c8102e', fg: '#ffffff' }, { bg: '#ffffff', fg: '#1a1a1a' }, { bg: '#ffd400', fg: '#c8102e' }, { bg: '#1a56b8', fg: '#ffffff' },
  { bg: '#101010', fg: '#ffd400' }, { bg: '#1e7a58', fg: '#ffffff' }, { bg: '#f2f2f2', fg: '#1a56b8' }, { bg: '#ff6a00', fg: '#ffffff' },
  { bg: '#3a1050', fg: '#ff9ad8' }, { bg: '#e8e0c8', fg: '#5a2a12', font: 'jpBrush' }, { bg: '#0b3d2e', fg: '#f5f1e6' }, { bg: '#f7d100', fg: '#0b2a5a' },
];
const FASCIA_BY_NAME = {
  'ポッポ': { bg: '#1a56b8', fg: '#ffffff', stripe: ['#ffffff', '#e83030'] }, 'セブンイレブ': { bg: '#ffffff', fg: '#d02020', stripe: ['#f28c1a', '#1e8a3a', '#d02020'] }, 'ファミリマート': { bg: '#ffffff', fg: '#1a7a3a', stripe: ['#1a7a3a', '#2a6ad0'] },
  'マックドナルド': { bg: '#c8102e', fg: '#ffd400' }, 'STARBEANS COFFEE': { bg: '#0b3d2e', fg: '#f5f1e6' }, 'ドトルコーヒー': { bg: '#f7d100', fg: '#111111' }, 'タリース': { bg: '#1a1a1a', fg: '#f2c94c' },
  'カラオケ舘': { bg: '#1a56b8', fg: '#ffffff' }, 'ジャンカレ': { bg: '#ffd400', fg: '#c8102e' }, 'ビックエコー': { bg: '#ffe000', fg: '#101010' }, 'マツモトキヨヒ': { bg: '#ffe000', fg: '#1a56b8' }, '三千里薬局': { bg: '#c8102e', fg: '#ffffff' },
  'サンドラック': { bg: '#ffffff', fg: '#d02020' }, 'UNIQRO': { bg: '#c8102e', fg: '#ffffff' }, 'GO': { bg: '#1a1a1a', fg: '#d0f000' }, 'ABC-MARK': { bg: '#e8e8e8', fg: '#d02020' }, 'ドン・キホーヂ': { bg: '#1a56b8', fg: '#ffe000' }, 'ドン・キホーヂ 渋谷本店': { bg: '#1a56b8', fg: '#ffe000' },
  'アコン': { bg: '#c8102e', fg: '#ffffff' }, 'プロミズ': { bg: '#ffd400', fg: '#1a1a1a' }, 'アイフリ': { bg: '#1a56b8', fg: '#ffffff' }, 'レイク ALSO': { bg: '#3a9a4a', fg: '#ffffff' }, 'マルハソ 渋谷': { bg: '#ffd400', fg: '#c8102e' }, 'エスパズ日拓': { bg: '#c8102e', fg: '#ffe000' },
  '一乱': { bg: '#c8102e', fg: '#ffffff' }, '天下一本': { bg: '#ffe000', fg: '#c8102e' }, '松家': { bg: '#f7d100', fg: '#1a1a1a' }, '吉野屋': { bg: '#f28c1a', fg: '#1a1a1a' }, 'すき屋': { bg: '#c8102e', fg: '#ffe000' }, 'ガスド': { bg: '#c8102e', fg: '#ffffff' }, 'サイゼリア': { bg: '#1e7a58', fg: '#ffffff' },
  'ビッグカメラ': { bg: '#c8102e', fg: '#ffffff' }, 'ビッグカメラ 渋谷東口': { bg: '#c8102e', fg: '#ffffff' }, 'ビッグカメラ 渋谷ハチ公口店': { bg: '#c8102e', fg: '#ffffff' }, 'ヤマド電機 LABY': { bg: '#1a56b8', fg: '#ffffff' }, 'ソフトバング': { bg: '#a0a0a0', fg: '#ffffff' }, 'aU ショップ': { bg: '#ff6a00', fg: '#ffffff' }, 'ドコマショップ': { bg: '#c8102e', fg: '#ffffff' },
  'TSUTAYU': { bg: '#f7d100', fg: '#0b2a5a' }, 'ブックオン': { bg: '#1a56b8', fg: '#ffe000' }, 'タイトーステーシオン': { bg: '#c8102e', fg: '#ffffff' }, 'GIGA': { bg: '#101010', fg: '#40b0ff' }, '快活CLAB': { bg: '#1a56b8', fg: '#ffe000' }, 'ラウンドツー': { bg: '#c8102e', fg: '#ffffff' },
  '三稜UFJ銀行': { bg: '#a01020', fg: '#ffffff' }, 'みずぼ銀行': { bg: '#1a3a8a', fg: '#ffffff' }, 'りそね銀行': { bg: '#1e7a58', fg: '#ffffff' }, '三井住本銀行': { bg: '#1e7a58', fg: '#ffffff' }, 'H&N': { bg: '#ffffff', fg: '#c8102e' }, 'ZALA': { bg: '#101010', fg: '#ffffff' }, 'WEGA': { bg: '#1a1a1a', fg: '#ffffff' }, 'SPINZ': { bg: '#ffffff', fg: '#101010' },
  '東急ハンド': { bg: '#1e7a58', fg: '#ffffff' }, 'ビレッジバンガード': { bg: '#ffe000', fg: '#101010' }, 'まんだらげ': { bg: '#c8102e', fg: '#ffe000' }, 'ゼロゲート': { bg: '#101010', fg: '#ffffff' }, 'JINZ': { bg: '#ffffff', fg: '#101010' }, 'Zoft': { bg: '#ffffff', fg: '#1a1a1a' }, '無地良品': { bg: '#7a1a1a', fg: '#ffffff' },
};
function tenantType(name, pools) {
  for (const [k, list] of Object.entries(pools || {})) if (list.includes(name)) return k;
  if (/銀行|信託/.test(name)) return 'bank';
  if (/クリニック|歯科|医院|皮フ科|眼科/.test(name)) return 'clinic';
  if (/ビル|BLD|マンション|会館|ビルヂング/.test(name)) return 'office';
  if (/カラオケ/.test(name)) return 'karaoke';
  if (/ホテル|イン$/.test(name)) return 'hotel';
  // a named shop outside the pools: read its trade from the name, so a landmark's ground floor shows boutiques,
  // cafes, books … and not the generic sundries shelving (pass 11: 「全部同じなのが違和感」)
  if (/COFFEE|珈琲|カフェ|CAFE|Café|ティー|茶|パーラ|スイーツ|デリ|DELI|チョコ|ベーカリ/i.test(name)) return 'cafe';
  if (/RECORD|TSUTAYU|BOOK|ブック|書店|文庫/i.test(name)) return 'books';
  if (/ラーメン|らーめん|そば|うどん|豚骨|一乱|天下一本/.test(name)) return 'ramen';
  if (/居酒屋|酒場|鳥貴|焼鳥|串/.test(name)) return 'izakaya';
  if (/ドラッグ|ドラック|薬|マツモトキヨヒ|コスメ|COSME|MAKE UP|化粧/i.test(name)) return 'drug';
  if (/ポッポ|セブンイレブ|ファミリマート|ローソ/.test(name)) return 'conv';
  if (/バーガー|BURGER|マックドナルド|ランチ|牛丼|松家|吉野屋|すき屋|フードショー/i.test(name)) return 'fast';
  if (/カメラ|電機|ソフトバング|ドコマ|aU/i.test(name)) return 'elec';
  if (/ゲーム|GIGA|タイトー|ラウンドツー|アミューズ/.test(name)) return 'game';
  if (/西部|SEIBO|東急|マルコ|MOD1|PALCO|LOFTY|ロフト|1O9|MAGNET|ヒカリエ|ShinQs|プラザ|UNIQRO|^GO$|H&N|ZALA|WEGA|SPINZ|ABC-MARK|ARROW|ティファニ|EDITION|無地良品|ニューエラ|RAYARD|SCRAMBLE|スクランブル|百貨店|ハンド/i.test(name)) return 'fashion';
  if (/ビル|BLD|会館|ビルヂング|オフィス/.test(name)) return 'office';
  return 'fashion';
}
const SHOP_OF_TYPE = { fast: 'fast', gyudon: 'ramen', ramen: 'ramen', family: 'family', izakaya: 'izakaya', cafe: 'cafe', karaoke: 'karaoke', drug: 'drug', conv: 'conv', fashion: 'fashion', elec: 'elec', game: 'game', pachi: 'pachi', money: 'bank', bank: 'bank', office: 'generic', clinic: 'generic', hotel: 'generic', books: 'books', cinema: 'game', bar: 'bar' };
class FasciaAtlas {
  constructor() {
    // 480 cells of 512 × 44 (was 320 of 512 × 64): room for the real tenants' names (tenantsData.js) at +3 % texels;
    // 44 px over a 0.82 m board ≈ the 57 px/m the 512 px give along a 9 m fascia
    // [city] pass 15: 72 rows (was 60): the 道玄坂 corridor's real tenants need ~90 more cells than the 51 left
    this.W = 4096; this.H = 3168; this.cw = 512; this.ch = 44; this.cols = 8; this.rows = 72;
    // [mobile] ?canvasK: painted at that scale through the context's transform (same cells, same UVs, a quarter the memory)
    this.canvas = L.makeCanvas(Math.round(this.W * CANVAS_K), Math.round(this.H * CANVAS_K)); this.ctx = this.canvas.getContext('2d');
    if (CANVAS_K !== 1) this.ctx.scale(CANVAS_K, CANVAS_K);
    this.ctx.fillStyle = '#222'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.tex = L.canvasTex(this.canvas, { aniso: 8, live: true });
    this.mat = new THREE.MeshStandardMaterial({ map: this.tex, emissiveMap: this.tex, emissive: 0xffffff, emissiveIntensity: 1.0, roughness: 0.45, metalness: 0.05 });
    this.mat.name = 'gb_fascia';
    emissives.push({ mat: this.mat, day: 0.15, night: 0.88 });
    this.map = new Map(); this.n = 0;
  }
  get(name, seed = 0) {
    const key = name;
    if (this.map.has(key)) return this.map.get(key);
    if (this.n >= this.cols * this.rows) return this.map.values().next().value;
    const i = this.n++;
    const col = i % this.cols, row = (i / this.cols) | 0;
    const x = col * this.cw, y = row * this.ch;
    const st = FASCIA_BY_NAME[name] || FASCIA_STYLES[(L.hash(i, seed, 3) * FASCIA_STYLES.length) | 0];
    const ctx = this.ctx;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, this.cw, this.ch); ctx.clip();
    ctx.fillStyle = st.bg; ctx.fillRect(x, y, this.cw, this.ch);
    if (st.stripe) { const n = st.stripe.length; st.stripe.forEach((c, k) => { ctx.fillStyle = c; ctx.fillRect(x, y + this.ch * (0.82 + k * 0.18 / n), this.cw, this.ch * 0.18 / n); }); }
    const g = ctx.createLinearGradient(0, y, 0, y + this.ch); g.addColorStop(0, 'rgba(255,255,255,0.14)'); g.addColorStop(1, 'rgba(0,0,0,0.14)'); ctx.fillStyle = g; ctx.fillRect(x, y, this.cw, this.ch);
    const family = L.isJP(name) ? L.FONT_JP : L.FONT_LATIN;
    const size = L.fitFont(ctx, name, this.cw * 0.86, this.ch * 0.7, '800', family);
    ctx.font = `800 ${size}px ${family}`; ctx.fillStyle = st.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, x + this.cw / 2, y + this.ch * (st.stripe ? 0.44 : 0.52));
    ctx.restore();
    const uv = { u0: col / this.cols, v0: 1 - (row + 1) / this.rows, u1: (col + 1) / this.cols, v1: 1 - row / this.rows };
    this.map.set(key, uv);
    this.tex.needsUpdate = true;
    return uv;
  }
}
// ---- wall sets: 1024² albedo per material, one 1024² normal + 512² roughness per family (二丁掛 tile, 打ち放し /
//      render, ALC / metal panel). Every texture repeats every 2 m (uvScale 0.5) and every seam of the repeat falls on
//      a joint, so the tiling never shows. Grime, streaks and colour drift are NOT painted in (they repeated every
//      2 m): the world-space macro layer below puts them on per building.
function wrapNoise(size, seed, cellN, amp) {
  // value noise on a cellN grid that wraps at the canvas edge, + white grain; returns Float32 0..1 field
  const out = new Float32Array(size * size), cs = size / cellN;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = x / cs, gy = y / cs, ix = gx | 0, iy = gy | 0; let fx = gx - ix, fy = gy - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const h = (a, b) => L.hash(a % cellN, b % cellN, seed);
    const v = (h(ix, iy) * (1 - fx) + h(ix + 1, iy) * fx) * (1 - fy) + (h(ix, iy + 1) * (1 - fx) + h(ix + 1, iy + 1) * fx) * fy;
    out[y * size + x] = v * (1 - amp) + L.hash(x, y, seed + 3) * amp;
  }
  return out;
}
function fieldCanvas(field, size, fn) {
  const c = L.makeCanvas(size, size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  for (let i = 0; i < size * size; i++) { const [r, g, b, a = 255] = fn(field[i], i); d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a; }
  ctx.putImageData(img, 0, 0);
  return c;
}
/** Joint / relief layout of a family drawn into a 2d context (height: 255 face … 0 deep joint). */
function drawRelief(ctx, S, family, height) {
  const H = (v) => `rgb(${v},${v},${v})`;
  if (family === 'tile') {
    // 二丁掛 227 × 60 mm tiles in running bond: 8 per 2 m across, 32 courses per 2 m up, 4 px (8 mm) joints
    const tw = S / 8, th = S / 32;
    ctx.fillStyle = height ? H(70) : 'rgba(0,0,0,0)'; if (height) ctx.fillRect(0, 0, S, S);
    for (let r = 0; r < 32; r++) for (let c = -1; c < 8; c++) {
      const x = c * tw + (r % 2 ? tw / 2 : 0), y = r * th;
      if (height) { ctx.fillStyle = H(215 + (L.hash(c + 20, r, 41) * 30 | 0)); ctx.fillRect(x + 2, y + 2, tw - 4, th - 4); ctx.fillStyle = H(250); ctx.fillRect(x + 4, y + 4, tw - 8, th - 8); }
    }
  } else if (family === 'concrete') {
    // 打ち放し: 2 × 1 m form panels, Pコン tie holes on a 0.5 m grid, faint form-board grain
    if (height) {
      ctx.fillStyle = H(230); ctx.fillRect(0, 0, S, S);
      for (let k = 0; k < 90; k++) { ctx.fillStyle = `rgba(${L.hash(k, 1, 51) < 0.5 ? '255,255,255' : '0,0,0'},0.08)`; ctx.fillRect(0, L.hash(k, 2, 51) * S, S, 1 + L.hash(k, 3, 51) * 3); }
      ctx.fillStyle = H(90); ctx.fillRect(0, 0, 5, S); ctx.fillRect(0, 0, S, 5); ctx.fillRect(0, S / 2 - 2, S, 5);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { const x = (c + 0.5) * S / 4, y = (r + 0.5) * S / 4; ctx.fillStyle = H(150); ctx.beginPath(); ctx.arc(x, y, 12, 0, 6.3); ctx.fill(); ctx.fillStyle = H(40); ctx.beginPath(); ctx.arc(x, y, 7, 0, 6.3); ctx.fill(); }
    }
  } else if (family === 'render') {
    // 吹付け render: a fine stipple, one faint joint at the repeat edge
    ctx.fillStyle = H(220); ctx.fillRect(0, 0, S, S);
    for (let k = 0; k < 14000; k++) { const v = 160 + (L.hash(k, 4, 61) * 95 | 0); ctx.fillStyle = H(v); ctx.fillRect(L.hash(k, 5, 61) * S, L.hash(k, 6, 61) * S, 3, 3); }
    ctx.fillStyle = H(150); ctx.fillRect(0, 0, S, 3); ctx.fillRect(0, 0, 3, S);
  } else if (family === 'panel') {
    // ALC / metal cladding: 0.5 m vertical panels, a horizontal joint every 2 m, fixing dots
    if (height) {
      ctx.fillStyle = H(235); ctx.fillRect(0, 0, S, S);
      for (let c = 0; c < 4; c++) { const x = c * S / 4; ctx.fillStyle = H(60); ctx.fillRect(x, 0, 5, S); ctx.fillStyle = H(255); ctx.fillRect(x + 5, 0, 3, S); }
      ctx.fillStyle = H(60); ctx.fillRect(0, 0, S, 6);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { ctx.fillStyle = H(150); ctx.fillRect(c * S / 4 + 18, r * S / 4 + 40, 6, 6); ctx.fillRect((c + 1) * S / 4 - 24, r * S / 4 + 40, 6, 6); }
    }
  }
}
function heightToNormal(hc, S, strength) {
  const d = hc.getContext('2d').getImageData(0, 0, S, S).data;
  const h = (x, y) => d[(((y + S) % S) * S + ((x + S) % S)) * 4] / 255;
  const f = new Float32Array(S * S);
  return fieldCanvas(f, S, (_, i) => {
    const x = i % S, y = (i / S) | 0;
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength, dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1);
    return [(-dx / l * 0.5 + 0.5) * 255, (dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  });
}
const WALL_FAMILY = {};
function wallFamily(family) {
  if (WALL_FAMILY[family]) return WALL_FAMILY[family];
  const S = 1024, hc = L.makeCanvas(S, S), hx = hc.getContext('2d');
  drawRelief(hx, S, family, true);
  hx.filter = 'blur(1.5px)'; hx.drawImage(hc, 0, 0); hx.filter = 'none';
  const normal = L.canvasTex(heightToNormal(hc, S, family === 'tile' ? 5 : family === 'panel' ? 4 : 3), { srgb: false, wrap: true });
  // roughness (green): glaze / face vs joint, low-frequency blotches
  const R = 512, n = wrapNoise(R, 71 + family.length, 8, 0.35), hd = (() => { const c = L.makeCanvas(R, R), x = c.getContext('2d'); x.drawImage(hc, 0, 0, R, R); return x.getImageData(0, 0, R, R).data; })();
  const base = family === 'tile' ? 0.52 : family === 'panel' ? 0.6 : 0.82;
  const rough = L.canvasTex(fieldCanvas(n, R, (v, i) => { const joint = 1 - hd[i * 4] / 255; const r = Math.min(1, base + (v - 0.5) * 0.25 + joint * 0.45); return [0, r * 255, 0]; }), { srgb: false, wrap: true });
  return (WALL_FAMILY[family] = { normal, rough });
}
function wallAlbedo(family, base, seed, opts = {}) {
  const S = 1024, c = L.makeCanvas(S, S), ctx = c.getContext('2d');
  const N = 256, f = wrapNoise(N, seed, 16, 0.25);
  const v = opts.variance ?? 12;
  const nc = fieldCanvas(f, N, (x) => { const k = (x - 0.5) * v * 2; return [base[0] + k, base[1] + k, base[2] + k * 1.05]; });
  ctx.imageSmoothingEnabled = true; ctx.drawImage(nc, 0, 0, S, S);
  if (family === 'tile') {
    const tw = S / 8, th = S / 32, mortar = opts.mortar || 'rgba(70,64,58,0.85)';
    for (let r = 0; r < 32; r++) for (let col = -1; col < 8; col++) {
      const x = col * tw + (r % 2 ? tw / 2 : 0), y = r * th, j = L.hash(col + 20, r, seed), k = (j - 0.5) * (opts.tileVar ?? 26);
      ctx.fillStyle = `rgba(${base[0] + k | 0},${base[1] + k | 0},${base[2] + k * 0.9 | 0},0.55)`; ctx.fillRect(x + 2, y + 2, tw - 4, th - 4);
      ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(x + 3, y + 3, tw - 6, 3);          // glaze catch-light on the upper edge
      if (j > 0.93) { ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(x + 2, y + 2, tw - 4, th - 4); }   // odd dark tile
    }
    ctx.fillStyle = mortar;
    for (let r = 0; r <= 32; r++) ctx.fillRect(0, r * th - 2, S, 4);
    for (let r = 0; r < 32; r++) for (let col = -1; col <= 8; col++) ctx.fillRect(col * tw + (r % 2 ? tw / 2 : 0) - 2, r * th, 4, th);
  } else if (family === 'concrete') {
    if (!opts.render) {
      ctx.fillStyle = 'rgba(30,28,26,0.35)'; ctx.fillRect(0, 0, 3, S); ctx.fillRect(0, 0, S, 3); ctx.fillRect(0, S / 2 - 1, S, 3);
      for (let r = 0; r < 4; r++) for (let col = 0; col < 4; col++) { const x = (col + 0.5) * S / 4, y = (r + 0.5) * S / 4; ctx.fillStyle = 'rgba(40,38,36,0.55)'; ctx.beginPath(); ctx.arc(x, y, 11, 0, 6.3); ctx.fill(); ctx.fillStyle = 'rgba(200,196,188,0.35)'; ctx.beginPath(); ctx.arc(x - 2, y - 2, 12, 3.4, 5.2); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(210,206,198,0.3)'; ctx.stroke(); }
      for (let k = 0; k < 60; k++) { ctx.fillStyle = `rgba(0,0,0,${0.03 + L.hash(k, 7, seed) * 0.04})`; ctx.fillRect(0, L.hash(k, 8, seed) * S, S, 2); }   // form-board grain
    } else {
      for (let k = 0; k < 9000; k++) { ctx.fillStyle = L.hash(k, 1, seed) < 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'; ctx.fillRect(L.hash(k, 2, seed) * S, L.hash(k, 3, seed) * S, 2, 2); }   // 吹付け stipple
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, 0, S, 3); ctx.fillRect(0, 0, 3, S);
    }
  } else if (family === 'panel') {
    for (let col = 0; col < 4; col++) {
      const x = col * S / 4, k = (L.hash(col, 3, seed) - 0.5) * 10;
      ctx.fillStyle = `rgba(${k > 0 ? '255,255,255' : '0,0,0'},${Math.abs(k) / 100})`; ctx.fillRect(x, 0, S / 4, S);
      ctx.fillStyle = opts.seam || 'rgba(20,20,22,0.55)'; ctx.fillRect(x, 0, 4, S);
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x + 4, 0, 3, S);
    }
    ctx.fillStyle = opts.seam || 'rgba(20,20,22,0.55)'; ctx.fillRect(0, 0, S, 5);
    if (opts.glass) {   // curtain wall: spandrel / vision glass split with a sky gradient
      for (let r = 0; r < 2; r++) { const y = r * S / 2; const g = ctx.createLinearGradient(0, y + 30, 0, y + S / 2); g.addColorStop(0, 'rgba(120,140,170,0.35)'); g.addColorStop(0.4, 'rgba(40,50,64,0.1)'); g.addColorStop(1, 'rgba(0,0,0,0.25)'); ctx.fillStyle = g; ctx.fillRect(0, y + 30, S, S / 2 - 60); ctx.fillStyle = 'rgba(12,14,18,0.8)'; ctx.fillRect(0, y + S / 2 - 30, S, 30); }
    }
  }
  // fine grain (wrapping pattern)
  const gn = wrapNoise(128, seed + 9, 128, 1), gc = fieldCanvas(gn, 128, (x) => { const a = Math.abs(x - 0.5) * 0.16; return x > 0.5 ? [255, 255, 255, a * 255] : [0, 0, 0, a * 255]; });
  ctx.fillStyle = ctx.createPattern(gc, 'repeat'); ctx.fillRect(0, 0, S, S);
  return L.canvasTex(c, { wrap: true });
}
// World-space macro layer shared by every wall material: low-frequency colour drift (per building), rain streaks down
// from each storey's sills (the pitch comes from the `binfo` attribute: base y, ground-floor height, ±storey pitch;
// negative = the building has storey bands), a street-level grime rise over 0–3 m, AO under every band and on
// down-facing soffits, dirt on up-facing ledges. Geometry without binfo (landmark parts) only gets drift + soffit AO.
const WALL_MACRO_VERT = `
attribute vec3 binfo; varying vec3 vBInfo; varying vec3 vMacroPos; varying vec3 vMacroNrm;`;
const WALL_MACRO_FRAG = `
varying vec3 vBInfo; varying vec3 vMacroPos; varying vec3 vMacroNrm;
float mHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float mNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(mHash(i), mHash(i + vec2(1.0, 0.0)), f.x), mix(mHash(i + vec2(0.0, 1.0)), mHash(i + vec2(1.0, 1.0)), f.x), f.y); }`;
const WALL_MACRO_BODY = `
float macroRough = 0.0;
{
  vec3 mN = normalize(vMacroNrm);
  float vert = 1.0 - abs(mN.y);
  float mU = dot(vMacroPos.xz, vec2(mN.z, -mN.x)) + dot(floor(vMacroPos.xz / 24.0), vec2(13.7, 7.3));
  float mY = vMacroPos.y, baseY = vBInfo.x, gfH = vBInfo.y, pitch = abs(vBInfo.z);
  // colour drift: one tone per ~20 m (reads per building) + a softer wash up the facade
  float lf = mNoise(vMacroPos.xz * 0.05 + 3.1) * 0.65 + mNoise(vec2(mU * 0.11, mY * 0.07)) * 0.35;
  vec3 drift = mix(vec3(0.86, 0.87, 0.9), vec3(1.08, 1.05, 1.0), lf);
  float dirt = 0.0;
  if (pitch > 0.5) {
    // drips from every sill (sill ≈ 27 % of the pitch above the storey line), fading over ~1.1 m
    float col = smoothstep(0.35, 0.9, mNoise(vec2(mU * 2.6, 1.7))) * (0.45 + 0.55 * mNoise(vec2(mU * 0.43, 9.2)));
    float above = mY - baseY - gfH;
    if (above > 0.0) {
      float d = mod(pitch * 0.27 - above, pitch);
      dirt += col * exp(-d / 1.1) * 0.55 * vert;
      // AO under each storey band
      if (vBInfo.z < 0.0) { float db = mod(-above - 0.02, pitch); dirt += exp(-db / 0.14) * 0.42 * vert * step(0.0, pitch - db); }
    }
    // street-level grime: splash + soot, patchy along the wall
    float g = 1.0 - smoothstep(0.0, 3.0, mY - baseY);
    dirt += g * g * (0.3 + 0.25 * mNoise(vec2(mU * 0.8, mY * 1.5))) * vert;
    macroRough = g * 0.1;
    // ledges / parapet caps catch dirt
    dirt += step(0.6, mN.y) * 0.25;
  }
  dirt += step(mN.y, -0.6) * 0.45;              // soffits / band undersides
  diffuseColor.rgb *= drift * (1.0 - clamp(dirt, 0.0, 0.7)) * mix(vec3(1.0), vec3(0.93, 0.9, 0.86), clamp(dirt * 1.5, 0.0, 1.0));
}`;
function wallMacroShader(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>' + WALL_MACRO_VERT)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBInfo = binfo; vMacroPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vMacroNrm = normalize(mat3(modelMatrix) * objectNormal);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>' + WALL_MACRO_FRAG)
    .replace('#include <map_fragment>', '#include <map_fragment>' + WALL_MACRO_BODY)
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor - macroRough, 0.04, 1.0);')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  // night: warm spill from the shopfronts / signs below fading up the facade + a faint cool sky-glow bounce
  totalEmissiveRadiance += diffuseColor.rgb * uGlassNight * (vec3(1.0, 0.8, 0.6) * 0.1 * exp(-max(vMacroPos.y - vBInfo.x, 0.0) / 8.0) + vec3(0.55, 0.5, 0.7) * 0.035);`);
  shader.uniforms.uGlassNight = glassU.uGlassNight;
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGlassNight;');
}
/** Put the wall macro layer (drift, drips, street grime, soffit AO) on any builder's material. */
export function wallMacro(mat, key = 'gb_wall_macro') {
  mat.onBeforeCompile = wallMacroShader; mat.customProgramCacheKey = () => key; mat.userData.attrs = [['binfo', 3]];
  return mat;
}
export { tagWall };
function makeWallMaterials() {
  const mk = (name, family, base, seed, { rough = 0.85, metal = 0, ns = 0.7, extra = {}, albedo = {}, relief = family } = {}) => {
    const fam = wallFamily(relief);
    const map = wallAlbedo(family, base, seed, albedo);
    const mean = family === 'tile' ? 0.62 : family === 'panel' ? 0.66 : 0.86;
    const m = L.std({ map, normalMap: fam.normal, normalScale: new THREE.Vector2(ns, ns), roughnessMap: fam.rough, roughness: Math.min(1.6, rough / mean), metalness: metal, ...extra });
    m.name = 'gb_wall_' + name;
    m.onBeforeCompile = wallMacroShader;
    m.customProgramCacheKey = () => 'gb_wall_macro';
    m.userData.attrs = [['binfo', 3]];
    return m;
  };
  return [
    mk('tileBeige', 'tile', [196, 186, 170], 301, { rough: 0.55, ns: 0.8, albedo: { mortar: 'rgba(120,110,96,0.9)' } }),
    mk('tileGrey', 'tile', [150, 150, 152], 302, { rough: 0.5, ns: 0.8, albedo: { mortar: 'rgba(84,84,86,0.9)' } }),
    mk('concrete', 'concrete', [140, 138, 134], 303, { rough: 0.9, ns: 0.6 }),
    mk('whitePanel', 'panel', [218, 218, 214], 304, { rough: 0.55, metal: 0.1, ns: 0.55, albedo: { seam: 'rgba(90,90,88,0.6)' } }),
    mk('darkPanel', 'panel', [66, 68, 74], 305, { rough: 0.45, metal: 0.5, ns: 0.5 }),
    mk('curtain', 'panel', [42, 52, 66], 306, { rough: 0.18, metal: 0.85, ns: 0.4, extra: { envMapIntensity: 1.3 }, albedo: { glass: true, seam: 'rgba(8,9,12,0.9)' } }),
    mk('brownTile', 'tile', [118, 82, 66], 307, { rough: 0.55, ns: 0.8, albedo: { mortar: 'rgba(150,140,126,0.85)', tileVar: 34 } }),
    mk('cream', 'concrete', [178, 158, 128], 308, { rough: 0.9, ns: 0.5, relief: 'render', albedo: { render: true, variance: 8 } }),
  ];
}
/** Dark roofing membrane: seam lines every 2 m, stains, and puddle discs that go mirror-smooth on the roughness map. */
function makeRoofMaterial() {
  const puddles = []; for (let i = 0; i < 4; i++) puddles.push([L.hash(i, 1, 811), L.hash(i, 2, 811), 0.08 + L.hash(i, 3, 811) * 0.1, 0.05 + L.hash(i, 4, 811) * 0.06]);
  const map = L.noiseTex({ size: 256, base: [66, 66, 70], variance: 10, seed: 309, low: 0.9, draw: (ctx, s) => {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; for (let i = 0; i < 2; i++) { ctx.fillRect(Math.round(i * s / 2), 0, 2, s); ctx.fillRect(0, Math.round(i * s / 2), s, 2); }
    for (let i = 0; i < 8; i++) { ctx.fillStyle = `rgba(0,0,0,${0.06 + L.hash(i, 5, 812) * 0.12})`; ctx.beginPath(); ctx.ellipse(L.hash(i, 6, 812) * s, L.hash(i, 7, 812) * s, 10 + L.hash(i, 8, 812) * 40, 6 + L.hash(i, 9, 812) * 20, L.hash(i, 10, 812) * 3, 0, 6.3); ctx.fill(); }
    for (const [x, y, rx, ry] of puddles) { ctx.fillStyle = 'rgba(18,22,34,0.45)'; ctx.beginPath(); ctx.ellipse(x * s, y * s, rx * s, ry * s, 0.4, 0, 6.3); ctx.fill(); }
  } });
  const rough = L.noiseTex({ size: 256, base: [228, 228, 228], variance: 14, seed: 310, srgb: false, draw: (ctx, s) => { for (const [x, y, rx, ry] of puddles) { ctx.fillStyle = 'rgb(38,38,38)'; ctx.beginPath(); ctx.ellipse(x * s, y * s, rx * s, ry * s, 0.4, 0, 6.3); ctx.fill(); } } });
  const m = L.std({ map, roughnessMap: rough, roughness: 1, metalness: 0.04, envMapIntensity: 0.9 }); m.name = 'gb_roof';
  return m;
}
export function getAtlases() {
  if (A) return A;
  const T = [performance.now()];
  const win = makeWindowAtlas(); T.push(performance.now());
  const shop = makeShopAtlas(); T.push(performance.now());
  const fascia = new FasciaAtlas(), walls = makeWallMaterials(); T.push(performance.now());
  console.info(`[city] atlas ms: windows ${(T[1] - T[0]).toFixed(0)}, shops ${(T[2] - T[1]).toFixed(0)}, walls ${(T[3] - T[2]).toFixed(0)}`);
  const roofMat = makeRoofMaterial();
  const inner = L.std({ color: 0x0a0a0c, roughness: 1, metalness: 0 }); inner.name = 'gb_inner';
  const trim = L.std({ color: 0x3a3c40, roughness: 0.6, metalness: 0.4 }); trim.name = 'gb_trim';
  const metal = L.std({ color: 0x8a8d92, roughness: 0.5, metalness: 0.7 }); metal.name = 'gb_metal';
  const acMat = L.std({ color: 0xd8d8d4, roughness: 0.6, metalness: 0.2 }); acMat.name = 'gb_ac';
  const pipeMat = L.std({ color: 0x6a6e72, roughness: 0.5, metalness: 0.6 }); pipeMat.name = 'gb_pipe';
  const awningMat = L.std({ color: 0xffffff, roughness: 0.8 }); awningMat.name = 'gb_awning';
  const tankMat = L.std({ color: 0xc0c4c8, roughness: 0.45, metalness: 0.7 }); tankMat.name = 'gb_tank';
  const boardMat = L.std({ color: 0x2a2a2e, roughness: 0.7, metalness: 0.2 }); boardMat.name = 'gb_board';
  const steelMat = L.std({ color: 0x4a4c50, roughness: 0.55, metalness: 0.6 }); steelMat.name = 'gb_steel';
  const lampMat = L.std({ color: 0xfff0d8, emissive: 0xffe2b0, emissiveIntensity: 2.0, roughness: 0.4 }); lampMat.name = 'gb_lamp'; lampMat.userData.noShadow = true;
  emissives.push({ mat: lampMat, day: 0.1, night: 2.0 });
  const aviationMat = L.std({ color: 0xff3030, emissive: 0xff2020, emissiveIntensity: 3, roughness: 0.4 }); aviationMat.name = 'gb_aviation'; aviationMat.userData.noShadow = true;
  // shopfront depth (shopFrontDepth): display-case glass, the lit display bed, the door mat
  const caseGlass = L.std({ color: 0xc8d8e4, roughness: 0.06, metalness: 0.6, transparent: true, opacity: 0.22, envMapIntensity: 1.6, depthWrite: false }); caseGlass.name = 'gb_caseGlass'; caseGlass.userData.noShadow = true;
  const displayMat = L.std({ color: 0xf4efe6, emissive: 0xfff2dc, emissiveIntensity: 0.55, roughness: 0.5 }); displayMat.name = 'gb_display'; displayMat.userData.noShadow = true;
  emissives.push({ mat: displayMat, day: 0.15, night: 0.55 });
  const matMat = L.std({ color: 0x2a2a2c, roughness: 0.95 }); matMat.name = 'gb_mat'; matMat.userData.noShadow = true;
  // parapet back-light: a soft wash that is brightest along the coping and fades down the parapet face
  const washC = L.makeCanvas(8, 64), wx = washC.getContext('2d'), wg = wx.createLinearGradient(0, 0, 0, 64);
  wg.addColorStop(0, '#fff4e4'); wg.addColorStop(0.12, '#c8b8a0'); wg.addColorStop(0.5, '#3a342c'); wg.addColorStop(1, '#000000'); wx.fillStyle = wg; wx.fillRect(0, 0, 8, 64);
  const washT = L.canvasTex(washC, { mips: false });
  const washMat = L.std({ color: 0x000000, emissive: 0xffffff, emissiveMap: washT, emissiveIntensity: 0.9, roughness: 0.9, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
  washMat.name = 'gb_wash'; washMat.userData.noShadow = true; washMat.polygonOffset = true; washMat.polygonOffsetFactor = -2; washMat.polygonOffsetUnits = -2;
  emissives.push({ mat: washMat, day: 0.0, night: 0.9 });
  // granite skirt / sill under shopfronts on the 道玄坂 slope (flamed grey granite, 60 × 30 cm courses)
  const plinth = L.std({ map: L.noiseTex({ size: 256, base: [96, 94, 90], variance: 16, seed: 131, low: 0.9, draw: (ctx, s) => {
    ctx.fillStyle = 'rgba(30,28,26,0.55)';
    for (let r = 0; r < 8; r++) { ctx.fillRect(0, r * s / 8, s, 2); const off = (r % 2) * s / 8; for (let c = 0; c <= 4; c++) ctx.fillRect((c * s / 4 + off) % s, r * s / 8, 2, s / 8); }
  } }), roughness: 0.55, metalness: 0.05 }); plinth.name = 'gb_plinth';
  const geos = {
    balcony: (() => { const slab = new THREE.BoxGeometry(1, 0.14, 1.25); slab.translate(0, 0.07, 0.625); const rail = new THREE.BoxGeometry(1, 1.05, 0.05); rail.translate(0, 0.65, 1.225); return mergeTwo(slab, rail); })(),
    ac: (() => { const g = new THREE.BoxGeometry(0.78, 0.58, 0.3); g.translate(0, 0, 0.15); return g; })(),
    acBig: (() => { const g = new THREE.BoxGeometry(1.6, 1.1, 0.9); g.translate(0, 0.55, 0); return g; })(),
    pipe: (() => { const g = new THREE.CylinderGeometry(0.06, 0.06, 1, 6, 1, true); g.translate(0, 0.5, 0.1); return g; })(),
    stair: makeStairFlight(),
    awning: (() => { const g = new THREE.BoxGeometry(1, 0.08, 1.4); g.rotateX(0.35); g.translate(0, -0.2, 0.62); return g; })(),
    tank: (() => { const c = new THREE.CylinderGeometry(0.85, 0.85, 1.7, 12, 1, true); c.translate(0, 1.85, 0); const top = new THREE.CircleGeometry(0.85, 12); top.rotateX(-Math.PI / 2); top.translate(0, 2.7, 0); const legs = []; for (const [x, z] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) { const l = new THREE.BoxGeometry(0.12, 1.0, 0.12); l.translate(x, 0.5, z); legs.push(keepFaces(l, [0, 1, 4, 5])); } return mergeMany([c, top, ...legs]); })(),
    antenna: (() => { const m = new THREE.CylinderGeometry(0.04, 0.06, 6, 6, 1, true); m.translate(0, 3, 0); const bars = [[1.6, 5.2], [1.2, 4.6], [0.8, 4.0]].map(([w, y]) => { const b = new THREE.BoxGeometry(w, 0.04, 0.04); b.translate(0, y, 0); return keepFaces(b, [2, 3, 4, 5]); }); return mergeMany([m, ...bars]); })(),
    bbframe: (() => { const parts = []; for (const x of [-0.45, 0.45]) { const p = new THREE.BoxGeometry(0.12, 4.2, 0.12); p.translate(x, 2.1, 0); parts.push(p); const d = new THREE.BoxGeometry(0.08, 0.08, 1.6); d.translate(x, 1.2, -0.8); parts.push(d); } const board = new THREE.BoxGeometry(1, 3.0, 0.1); board.translate(0, 2.9, 0.1); parts.push(board); return mergeMany(parts); })(),
    // 1 m maintenance-rail module along +x (post at the origin + top rail, 14 tris: hidden end / underside faces
    // dropped) — scaled in x to the 3 m pitch
    roofRail: (() => { const post = new THREE.BoxGeometry(0.06, 1.1, 0.06); post.translate(0, 0.55, 0); const r1 = new THREE.BoxGeometry(1, 0.05, 0.05); r1.translate(0.5, 1.1, 0); return mergeMany([keepFaces(post, [0, 1, 4, 5]), keepFaces(r1, [2, 4, 5])]); })(),
    // wall ladder in the local x/y plane facing +z: two open rails + 11 rung quads (38 tris)
    ladder: (() => { const parts = []; for (const x of [-0.22, 0.22]) { const r = new THREE.BoxGeometry(0.04, 3.4, 0.04); r.translate(x, 1.7, 0.06); parts.push(keepFaces(r, [0, 1, 4, 5])); } for (let i = 0; i < 11; i++) { const s = new THREE.PlaneGeometry(0.44, 0.035); s.translate(0, 0.25 + i * 0.3, 0.06); parts.push(s); } return mergeMany(parts); })(),
    grate: (() => { const parts = []; const f = new THREE.BoxGeometry(0.5, 0.03, 0.36); f.translate(0, 0.015, 0); parts.push(f); for (let i = 0; i < 6; i++) { const b = new THREE.BoxGeometry(0.03, 0.02, 0.3); b.translate(-0.2 + i * 0.08, 0.04, 0); parts.push(b); } return mergeMany(parts); })(),
    bulkhead: null,
    lamp: (() => { const g = new THREE.SphereGeometry(1, 8, 6); return g; })(),
  };
  // parts that sit on (or inside) a wall or roof that already casts the same shadow stay out of the shadow pass
  for (const m of [win.mat, shop.mat, fascia.mat, inner, roofMat, pipeMat]) m.userData.noShadow = true;
  A = { caseGlass, displayMat, matMat, win, shop, fascia, walls, roofMat, inner, trim, metal, acMat, pipeMat, awningMat, tankMat, boardMat, steelMat, lampMat, aviationMat, washMat, plinth, stairMat: makeStairMaterial(), geos };
  return A;
}
function mergeTwo(a, b) { return mergeMany([a, b]); }
/** Keep only some faces of a BoxGeometry (0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z): hidden ends / undersides cost tris. */
function keepFaces(g, faces) {
  const ix = g.index.array, out = [];
  for (const f of faces) for (let k = 0; k < 6; k++) out.push(ix[f * 6 + k]);
  g.setIndex(out);
  return g;
}
function mergeMany(list) {
  // lightweight merge (all BoxGeometry/Cylinder are indexed with position/normal/uv)
  const pos = [], nor = [], uv = [], idx = []; let base = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0); }
    const ix = g.index; for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base);
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); out.setIndex(idx);
  return out;
}
function makeStairFlight() {
  // one storey of exterior steel stair, 72 tris: a sloped tread plate (the steps are in the texture), two
  // stringers, the landing, a handrail and the landing's guard rail. 1.1 m wide, rises 3.4 over a 3 m run.
  const run = 3.0, rise = 3.4, L0 = Math.hypot(run, rise), ang = -Math.atan2(rise, run);
  const tread = new THREE.BoxGeometry(1.1, 0.05, L0); tread.rotateX(ang); tread.translate(0, rise / 2, 0);
  const stringer = new THREE.BoxGeometry(0.05, 0.25, L0); stringer.rotateX(ang); stringer.translate(-0.56, rise / 2, 0);
  const st2 = stringer.clone(); st2.translate(1.12, 0, 0);
  const landing = new THREE.BoxGeometry(1.1, 0.08, 1.2); landing.translate(0, rise, run / 2 + 0.6);
  const rail = new THREE.BoxGeometry(0.04, 0.04, L0); rail.rotateX(ang); rail.translate(-0.56, rise / 2 + 1.0, 0);
  const guard = new THREE.BoxGeometry(1.1, 1.0, 0.03); guard.translate(0, rise + 0.5, run / 2 + 1.2);
  return mergeMany([tread, stringer, st2, landing, rail, guard]);
}
/** Galvanised steel with 12 step nosings across v (the tread plate's long axis). */
function makeStairMaterial() {
  const c = L.makeCanvas(32, 384), x = c.getContext('2d');
  x.fillStyle = '#7c8086'; x.fillRect(0, 0, 32, 384);
  for (let i = 0; i < 12; i++) { x.fillStyle = '#2c2e32'; x.fillRect(0, i * 32, 32, 9); x.fillStyle = '#a4a8ae'; x.fillRect(0, i * 32 + 9, 32, 3); }
  const m = L.std({ map: L.canvasTex(c, { aniso: 4 }), roughness: 0.55, metalness: 0.6 }); m.name = 'gb_stair';
  return m;
}

export function setNightFactor(f) {
  f = Math.max(0, Math.min(1, f));
  if (Math.abs(f - nightFactor) < 1e-3 && A) return;
  nightFactor = f;
  for (const e of emissives) e.mat.emissiveIntensity = e.day + (e.night - e.day) * f;
  glassU.uGlassNight.value = f;
}
export function getNightFactor() { return nightFactor; }
/** Aviation lamps: a slow 1 Hz pulse (never fully off, so a still frame always shows them). */
export function tickBlink(t) { if (A) A.aviationMat.emissiveIntensity = (0.35 + 0.65 * (Math.sin(t * 6.283) > -0.2 ? 1 : 0)) * (0.3 + 2.7 * nightFactor); }

// ------------------------------------------------------------------------------------------------- styles
const STYLES = {
  tenant:        { gf: 4.2, sh: 3.3, win: 'wide', fill: 0.86, wh: 0.62, sill: 0.25, lit: 0.58, bands: true, walls: [0, 1, 3, 7, 2], balcony: 0, ac: 0.35 },
  office:        { gf: 3.8, sh: 3.5, win: 'ribbon', fill: 0.92, wh: 0.55, sill: 0.3, lit: 0.55, bands: false, walls: [3, 5, 4, 1], balcony: 0, ac: 0.1 },
  entertainment: { gf: 4.4, sh: 3.4, win: 'punched', fill: 0.4, wh: 0.4, sill: 0.35, lit: 0.6, bands: true, walls: [4, 0, 6, 1], balcony: 0, ac: 0.4, ent: true },
  // センター街 pencil buildings: tenant floors all the way up (karaoke, izakaya, salons, clinics), most lit, condensers
  // on every frontage, window-sticker tenant panels on 2–5F, an exterior steel stair on about half of them
  cg:            { gf: 4.3, sh: 3.3, win: 'punched', fill: 0.72, wh: 0.52, sill: 0.3, lit: 0.72, bands: true, walls: [4, 0, 6, 1, 7, 2], balcony: 0, ac: 0.85, ent: true },
  hotel:         { gf: 3.8, sh: 3.0, win: 'punched', fill: 0.62, wh: 0.5, sill: 0.28, lit: 0.42, bands: false, walls: [0, 7, 3, 6], balcony: 0.3, ac: 0.15 },
  residential:   { gf: 3.2, sh: 2.9, win: 'punched', fill: 0.62, wh: 0.55, sill: 0.3, lit: 0.36, bands: false, walls: [0, 6, 2, 7], balcony: 0.9, ac: 0.6 },
};

// ------------------------------------------------------------------------------------------------- building
const _bv = new THREE.Vector3(), _bq = new THREE.Quaternion(), _by = new THREE.Vector3(0, 1, 0);
/** Square-section steel member between two world points (end caps dropped). */
function beam(p, q, t) {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2], l = Math.hypot(dx, dy, dz);
  const g = keepFaces(new THREE.BoxGeometry(t, l, t), [0, 1, 4, 5]);
  _bq.setFromUnitVectors(_by, _bv.set(dx / l, dy / l, dz / l)); g.applyQuaternion(_bq);
  g.translate((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2);
  return g;
}
/**
 * Rooftop billboard on a steel scaffold (Shibuya's classic roof ad): the board face (signage puts the lit ad on it)
 * raised `lift` m on front posts, a back frame with X-bracing and raking struts, a catwalk and gooseneck lamps.
 * Real member sizes at any board width (merged, not a scaled instance). Returns the board centre.
 */
function billboardFrame(batch, At, cx, y0, cz, nx, nz, w, lift, bh, deep) {
  const tx = nz, tz = -nx, P = (s, y, d) => [cx + tx * s + nx * d, y, cz + tz * s + nz * d];
  const add = (m, g) => batch.add(m, g, cx, cz);
  const top = y0 + lift + bh, D = deep ? 2.2 : 1.1, np = Math.max(2, Math.ceil(w / 3.2) + 1);
  const xs = []; for (let i = 0; i < np; i++) xs.push(-w / 2 + 0.2 + (w - 0.4) * i / (np - 1));
  for (const x of xs) {
    add(At.steelMat, beam(P(x, y0, -0.25), P(x, top + 0.1, -0.25), 0.16));                       // front post
    add(At.steelMat, beam(P(x, y0, -0.25 - D), P(x, y0 + lift + bh * 0.7, -0.25 - D), 0.12));    // back post
    add(At.steelMat, beam(P(x, y0 + 0.1, -0.25 - D), P(x, y0 + lift + bh * 0.7, -0.3), 0.08));    // raking strut
    add(At.steelMat, beam(P(x, y0 + lift, -0.25), P(x, y0 + lift, -0.25 - D), 0.07));             // side rail
  }
  for (const y of deep ? [y0 + 0.4, y0 + lift, y0 + lift + bh * 0.7] : [y0 + lift]) add(At.steelMat, beam(P(-w / 2, y, -0.25 - (y > y0 + 0.5 ? D : 0)), P(w / 2, y, -0.25 - (y > y0 + 0.5 ? D : 0)), 0.08));
  for (let i = 0; i < np - 1; i++) {                                                               // X-bracing in the back frame
    const a = xs[i], b = xs[i + 1], ya = deep ? y0 + 0.4 : y0, yb = y0 + lift + bh * 0.7;
    add(At.steelMat, beam(P(a, ya, -0.25 - D), P(b, yb, -0.25 - D), 0.06));
    add(At.steelMat, beam(P(b, ya, -0.25 - D), P(a, yb, -0.25 - D), 0.06));
  }
  add(At.boardMat, L.boxAt(...P(0, y0 + lift + bh / 2, -0.1), w, bh, 0.16, Math.atan2(-tz, tx), false));
  add(At.steelMat, L.boxAt(...P(0, y0 + lift - 0.12, 0.25), w + 0.3, 0.06, 0.75, Math.atan2(-tz, tx), false));   // catwalk
  add(At.steelMat, beam(P(-w / 2 - 0.15, y0 + lift + 1.0, 0.6), P(w / 2 + 0.15, y0 + lift + 1.0, 0.6), 0.04));    // catwalk rail
  const nl = Math.max(2, Math.round(w / 2.6));
  for (let i = 0; i < nl; i++) {                                                                   // gooseneck lamps over the face
    const x = -w / 2 + w * (i + 0.5) / nl;
    add(At.steelMat, beam(P(x, top + 0.05, -0.1), P(x, top + 0.35, 0.9), 0.05));
    add(At.lampMat, L.boxAt(...P(x, top + 0.3, 0.95), 0.34, 0.1, 0.22, Math.atan2(-tz, tx), false));
  }
  return P(0, y0 + lift + bh / 2, 0.0);
}
/** Tag a wall geometry with the macro-layer info (base y, ground-floor height, ±storey pitch; − = banded). */
function tagWall(g, info) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = info[0]; a[i * 3 + 1] = info[1]; a[i * 3 + 2] = info[2]; }
  g.setAttribute('binfo', new THREE.BufferAttribute(a, 3));
  return g;
}
export const WINDOW_STATS = { units: 0 };
/**
 * One window: the atlas pane set 0.15 m deep in an anodised sash reveal — two jambs, a head soffit and a projecting
 * precast sill (+ a centre mullion on wide panes). Every part samples the window atlas (patch row), so a whole facade
 * stays one draw call per chunk; a lit room also lights its own reveal (the lit-edge read at night). 12–14 tris.
 */
export function windowUnit(batch, At, cx, cy, cz, nx, nz, w, h, cl, kx, kz, { depth = 0.15, mullion = false, sill = true, bright = 1, warm = 0, shift = 0 } = {}) {
  const P = At.win.patch, lit = cl.lit;
  const rv = lit ? (cl.warm ? P.revealWarm : P.revealCool) : P.reveal, sl = lit ? P.sillLit : P.sill;
  const tx = nz, tz = -nx, D = depth, hw = w / 2, hh = h / 2;
  // one BufferGeometry per unit (pane + surround): 6–7 quads written straight into typed arrays
  const nq = 4 + (sill ? 2 : 0) + (mullion && w > 1.6 ? 1 : 0);
  const pos = new Float32Array(nq * 12), nor = new Float32Array(nq * 12), uv = new Float32Array(nq * 8), idx = new Uint16Array(nq * 6);
  let q = 0;
  const quad = (pts, n, r) => {
    for (let k = 0; k < 4; k++) { const [s, y, d] = pts[k]; pos.set([cx + tx * s + nx * d, y, cz + tz * s + nz * d], q * 12 + k * 3); nor.set(n, q * 12 + k * 3); }
    uv.set([r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3]], q * 8);
    const b = q * 4; idx.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6); q++;
  };
  // points are (s along the wall, y, d out of the wall), ordered counter-clockwise seen from the normal side
  quad([[-hw, cy - hh, 0.02], [hw, cy - hh, 0.02], [hw, cy + hh, 0.02], [-hw, cy + hh, 0.02]], [nx, 0, nz], [cl.u0, cl.v0, cl.u1, cl.v1]);
  quad([[-hw, cy - hh, D], [-hw, cy - hh, 0], [-hw, cy + hh, 0], [-hw, cy + hh, D]], [tx, 0, tz], rv);
  quad([[hw, cy - hh, 0], [hw, cy - hh, D], [hw, cy + hh, D], [hw, cy + hh, 0]], [-tx, 0, -tz], rv);
  quad([[-hw, cy + hh, D], [-hw, cy + hh, 0], [hw, cy + hh, 0], [hw, cy + hh, D]], [0, -1, 0], rv);
  if (sill) {
    const sw = hw + 0.05, SD = D + 0.06, sy = cy - hh;
    quad([[-sw, sy, SD], [sw, sy, SD], [sw, sy, 0], [-sw, sy, 0]], [0, 1, 0], sl);
    quad([[-sw, sy - 0.07, SD], [sw, sy - 0.07, SD], [sw, sy, SD], [-sw, sy, SD]], [nx, 0, nz], sl);
  }
  if (mullion && w > 1.6) quad([[-0.035, cy - hh, 0.07], [0.035, cy - hh, 0.07], [0.035, cy + hh, 0.07], [-0.035, cy + hh, 0.07]], [nx, 0, nz], lit ? P.mullionLit : P.mullion);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  // the pane (first quad) carries its room: atlas cell + (w, h, brightness jitter, warmth + 4 × room shift)
  const cellA = new Float32Array(nq * 16), roomA = new Float32Array(nq * 16), rw = Math.max(-1, Math.min(1, warm)) + 4 * (shift & 3);
  for (let k = 0; k < 4; k++) { cellA.set([cl.u0, cl.v0, cl.u1, cl.v1], k * 4); roomA.set([w, h, bright, rw], k * 4); }
  g.setAttribute('cell', new THREE.BufferAttribute(cellA, 4)); g.setAttribute('room', new THREE.BufferAttribute(roomA, 4));
  batch.add(At.win.mat, g, kx, kz);
  WINDOW_STATS.units++;
}
/**
 * spec: { id, poly:[[x,z]...] (world), storeys, style, faces:[{kind:'street'|'alley'|'blind', tenants:[]}] per edge,
 *         gf?, sh?, wall?, setback?:bool, seed, name?, noRoofClutter?, groundFloor?: 'shop'|'wall'|'glass',
 *         groundRel?: (x, z) => terrain height above the building base (sloped sites: shop sills step up with it) }
 * ctx:  { batch, inst, rng, pools, facades[], billboards[] }
 * returns { colliders:[{obb}], height, facades:[...] }
 */
export function buildBuilding(spec, ctx) {
  const At = getAtlases();
  const { batch, inst } = ctx;
  const rng = ctx.rng;
  const style = STYLES[spec.style] || STYLES.tenant;
  const poly = L.ensureCW(spec.poly);
  const n = poly.length;
  // on a slope (spec.groundRel = pavement height above the base) the ground floor is as much taller as the pavement
  // rises across the footprint, so the uphill shopfronts keep their full height (a double-height downhill end)
  let rise = 0;
  if (spec.groundRel) for (let i = 0; i < spec.poly.length; i++) {
    const a = spec.poly[i], b = spec.poly[(i + 1) % spec.poly.length];
    for (let t = 0; t <= 4; t++) rise = Math.max(rise, spec.groundRel(a[0] + (b[0] - a[0]) * t / 4, a[1] + (b[1] - a[1]) * t / 4));
  }
  rise = Math.min(3.2, Math.max(0, rise));
  const gf = (spec.gf ?? style.gf) + rise, sh = spec.sh ?? style.sh;
  const storeys = Math.max(1, spec.storeys | 0);
  const h = gf + (storeys - 1) * sh;
  const wallMat = spec.wallMat || (spec.wall != null ? At.walls[spec.wall % At.walls.length] : At.walls[style.walls[rng.int(0, style.walls.length - 1)]]);
  const c = L.polyCentroid(poly);
  const out = { colliders: [], height: h, facades: [], gf };
  const setback = spec.setback != null ? spec.setback : (storeys >= 7 && rng.chance(h > 30 ? 0.55 : 0.35));
  const h1 = setback ? gf + (storeys - 3) * sh : h;
  const winfo = [batch.lift || 0, gf, style.bands ? -sh : sh], W = (g) => tagWall(g, winfo);
  // ---- masses (walls + bottom cap; the roof cap is a separate dark membrane; an inward-facing dark shell so an
  //      accidental interior view reads as a dark room instead of see-through walls)
  batch.add(wallMat, W(L.extrudePolygon(poly, -0.2, h1, { cap: false, bottom: true, uvScale: 0.5, uFace: (spec.seed | 0) + 7 })), c[0], c[1]);
  batch.add(At.roofMat, L.polygonCap(poly, h1, 0.25), c[0], c[1]);
  batch.add(At.inner, L.flipGeo(L.extrudePolygon(L.offsetPolygon(poly, -0.25), 0, h1 - 0.05, { cap: false })), c[0], c[1]);
  let upper = null;
  if (setback) {
    upper = L.offsetPolygon(poly, -rng.range(1.6, 2.6));
    if (L.polyArea(upper) > 20) { batch.add(wallMat, W(L.extrudePolygon(upper, h1 - 0.1, h, { cap: false, uvScale: 0.5 })), c[0], c[1]); batch.add(At.roofMat, L.polygonCap(upper, h, 0.25), c[0], c[1]); } else { upper = null; }
  }
  const topH = upper ? h : h1;
  // ---- faces
  const faceOf = (i) => (spec.faces && spec.faces[i]) || { kind: 'alley', tenants: [] };
  const gr = spec.groundRel || null;
  const grAt = (x, z) => (gr ? Math.max(0, gr(x, z)) : 0);
  const windowsOnFace = (a, b, nx, nz, y0, y1, kind, seedI, massTop) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 2.2) return;
    const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
    const margin = 0.6;
    const bw = kind === 'street' ? rng.range(2.6, 3.8) : rng.range(2.8, 4.2);
    const nb = Math.max(1, Math.floor((len - 2 * margin) / bw));
    const bay = (len - 2 * margin) / nb;
    const wide = style.win === 'wide' || style.win === 'ribbon', roomWide = wide || !!style.ent;
    const cells = roomWide ? At.win.cells.wide : At.win.cells.normal;
    const litCells = cells.filter(cl => cl.lit), darkCells = cells.filter(cl => !cl.lit);
    let k = 0;
    // occupancy by storey: a tenant / office floor is one tenant — 45–100 % occupied in a contiguous run (its own room
    // type, colour temperature and brightness), a closed floor keeps the odd night-owl room; flats / hotel rooms
    // behind punched windows are lit room by room (~45 % at 21:30). A face is topped up to ≥ 15 % lit by whole floors.
    const cellsOn = [], floors = [];
    const byRoom = style.win === 'punched' && !style.ent;
    const pOn = style.win === 'ribbon' ? 0.97 : 0.9;
    const kinds = roomWide ? (style.ent ? ENT_KINDS : OFFICE_KINDS) : null;
    for (let y = y0; y + sh <= y1 + 0.01; y += sh) {
      const floorLit = rng() < style.lit;
      const frac = byRoom ? style.lit + 0.12 : floorLit ? rng.range(0.45, 1.0) : rng.range(0, 0.08);
      const run = Math.ceil(nb * frac), r0 = rng.int(0, Math.max(0, nb - run));
      const tenant = kinds ? litCells.find(c => c.kind === kinds[rng.int(0, kinds.length - 1)]) || litCells[0] : null;
      floors.push({ at: cellsOn.length, lit: floorLit, tenant, warm: tenant && !tenant.warm ? rng.range(-1, -0.2) : rng.range(-0.3, 1), b: rng.range(0.86, 1.1) });
      for (let i = 0; i < nb; i++) cellsOn.push(kind === 'alley' && rng() < 0.25 ? -1 : (byRoom ? rng() < frac : floorLit ? (i >= r0 && i < r0 + run ? rng() < pOn : rng() < 0.1) : rng() < frac) ? 1 : 0);
    }
    const nCell = cellsOn.filter(v => v >= 0).length;
    let nLit = cellsOn.filter(v => v === 1).length;
    for (let t = 0; t < floors.length * 2 && nCell && nLit < Math.ceil(nCell * 0.15); t++) {
      const f = floors[rng.int(0, floors.length - 1)]; if (f.lit) continue; f.lit = true;
      for (let i = f.at; i < f.at + nb; i++) if (cellsOn[i] === 0 && rng() < pOn) { cellsOn[i] = 1; nLit++; }
    }
    let ci = 0;
    const acP = (kind === 'street' ? 0.5 : 1) * style.ac;
    const blindCells = litCells.filter(c => c.kind === 'blinds' || c.kind === 'halfblind' || c.kind === 'curtain' || c.kind === 'lamp');
    for (let y = y0; y + sh <= y1 + 0.01; y += sh, k++) {
      const fl = floors[k];
      const fill = kind === 'blind' ? 0 : style.fill * (kind === 'alley' ? 0.8 : 1);
      if (fill <= 0) { ci += nb; continue; }
      const ww = bay * fill, wh = sh * style.wh;
      const cy = y + sh * style.sill + wh / 2;
      for (let i = 0; i < nb; i++) {
        const on = cellsOn[ci++];
        if (on < 0) continue;
        const s = margin + bay * (i + 0.5);
        const cx = a[0] + tx * s, cz = a[1] + tz * s;
        const lit = on === 1;
        // a lit unit shows its floor's tenant; 10–15 % break the run (half-drawn blinds, curtains, a lamp pool)
        const cl = !lit ? darkCells[rng.int(0, darkCells.length - 1)] : fl.tenant && rng() < 0.86 ? fl.tenant : rng() < 0.6 && blindCells.length ? blindCells[rng.int(0, blindCells.length - 1)] : litCells[rng.int(0, litCells.length - 1)];
        windowUnit(batch, At, cx, cy, cz, nx, nz, ww, wh, cl, cx, cz, { mullion: wide, bright: fl.b * rng.range(0.87, 1.13), warm: byRoom ? rng.range(-0.6, 1) : fl.warm, shift: rng.int(0, 3) });
        if (spec.stickers && lit && kind === 'street' && k < 4 && rng() < 0.55) {
          // tenant window-sticker panel across the upper glass (lit from the room behind)
          const uv = At.fascia.get(STICKERS[(Math.floor(L.hash(Math.round(cx * 3), Math.round(cz * 3), k) * STICKERS.length) + k) % STICKERS.length], 91);
          batch.add(At.fascia.mat, L.wallQuad(cx, cy + wh * 0.27, cz, nx, nz, ww * 0.86, Math.min(0.5, wh * 0.3), 0.19, [uv.u0, uv.v0, uv.u1, uv.v1]), cx, cz);
        }
        if (style.balcony && kind !== 'blind' && rng() < style.balcony) {
          inst.add('balcony', At.geos.balcony, At.trim, cx, y + 0.02, cz, Math.atan2(nx, nz), bay - 0.35, 1, 1);
          if (rng() < style.ac) inst.add('ac', At.geos.ac, At.acMat, cx + tx * (bay * 0.3), y + 0.45, cz + tz * (bay * 0.3), Math.atan2(nx, nz), 1, 1, 1, 0xd0d0cc);
        } else if (kind !== 'blind' && rng() < acP) {
          // condenser on a wall bracket beside the pane, under the sill line (street faces too: 渋谷 frontages are full of them)
          const side = rng.chance(0.5) ? 1 : -1, off = Math.min(bay * 0.5 - 0.1, ww / 2 + 0.5) * side;
          inst.add('ac', At.geos.ac, At.acMat, cx + tx * off, y + sh * style.sill - 0.1, cz + tz * off, Math.atan2(nx, nz), 1, 1, 1, rng.chance(0.5) ? 0xd0d0cc : 0x9a9a96);
          if (rng() < 0.6) inst.add('pipe', At.geos.pipe, At.pipeMat, cx + tx * (off + 0.46 * side), y + 0.2, cz + tz * (off + 0.46 * side), Math.atan2(nx, nz), 0.45, sh * style.sill - 0.4, 0.45);   // refrigerant line down to the unit
        }
      }
      if (style.bands && kind !== 'blind') batch.add(wallMat, W(L.boxAt((a[0] + b[0]) / 2 + nx * 0.06, y + 0.12, (a[1] + b[1]) / 2 + nz * 0.06, len, 0.28, 0.14, Math.atan2(-tz, tx), true)), cx0(a, b), cz0(a, b));
    }
    void massTop; void seedI;
  };
  const cx0 = (a, b) => (a[0] + b[0]) / 2, cz0 = (a, b) => (a[1] + b[1]) / 2;
  // the real tenant at this bay (tenantsData.js): nearest unused ground-floor entry in front of the bay, and the
  // nearest upper-floor one for the 2F board
  const realAt = (x, z, nx, nz, upper, halfW = 4) => claimRealTenant(x, z, nx, nz, halfW, upper);
  // no survey point in front of this bay (the compressed west end, several shops behind one front, lots set back
  // from the real building line): the nearest unplaced real shop of the SAME street within 16 m takes it, so the
  // stretch still shows its own real tenants in their order rather than invented ones
  const STREET_KEY = { centergai: 'center', basketball: 'center', koen: 'koen', koen_promenade: 'koen', koen_promenade_n: 'koen', jingu_n: 'koen', inokashira: 'inokashira', bunkamura: 'bunkamura' };
  const streetAt = (x, z) => {
    const C = ctx.CITY; if (!C) return null;
    let best = null, bd = 9;
    for (const r of [...(C.pedestrianStreets || []), ...(C.roads || [])]) {
      const key = STREET_KEY[r.id]; if (!key) continue;
      for (let i = 0; i < r.path.length - 1; i++) { const d = L.distToSegment(x, z, r.path[i][0], r.path[i][1], r.path[i + 1][0], r.path[i + 1][1]) - r.width / 2; if (d < bd) { bd = d; best = key; } }
    }
    return best;
  };
  const sameStreetAt = (x, z, nx, nz) => {
    const key = streetAt(x + nx * 3, z + nz * 3); if (!key) return null;
    let best = null, bd = 16;
    for (const t of SHOP_TENANTS) {
      if (t.street !== key || t.floor > 1 || TENANT_USED.has(t)) continue;
      const d = Math.hypot(t.pos[0] - x, t.pos[1] - z); if (d < bd) { bd = d; best = t; }
    }
    if (best) { TENANT_USED.add(best); NAMES_SHOWN.add(best.name); }
    return best;
  };
  const shopsOnFace = (a, b, nx, nz, face, fi) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
    const tenants = face.tenants && face.tenants.length ? face.tenants : [];
    // bays follow the frontage (never one 20 m shop because a face carries one tenant); bays past the named
    // tenants take a name from the street's tenant pools so every shopfront has a fascia
    let nShops = Math.max(1, Math.round(len / rng.range(6, 9)));
    // as many bays as real shops stand along this frontage (real Shibuya frontages are 3–6 m units, not 7 m)
    if (SHOP_TENANTS.length && face.kind === 'street') { const k = realCountAlong(a, b, nx, nz); if (k > nShops) nShops = Math.max(nShops, Math.min(k, Math.floor(len / 3.2))); }
    const faceVar = Math.floor(L.hash(Math.round(a[0] * 7), Math.round(a[1] * 7), fi) * 4);
    const sw = len / nShops;
    const glassH = gf - 1.05;
    for (let i = 0; i < nShops; i++) {
      let name = tenants[i] || null;
      let type = name ? tenantType(name, ctx.pools) : rng.pick(['izakaya', 'cafe', 'bar', 'ramen', 'conv', 'drug', 'karaoke', 'fast']);
      if (!name && ctx.pools) { const pool = ctx.pools[type]; if (pool && pool.length) name = pool[rng.int(0, pool.length - 1)]; }
      const s = sw * (i + 0.5);
      const cx = a[0] + tx * s, cz = a[1] + tz * s;
      let real = SHOP_TENANTS.length && face.kind === 'street' ? (realAt(cx, cz, nx, nz, false, sw / 2) || sameStreetAt(cx, cz, nx, nz)) : null;
      if (real) name = real.name;
      else if (name && SHOP_NAME_SET.has(name)) {
        // a real name used as a lot's filler: only at the bay where a shop of that name really is (same side) — then
        // it is that shop — else a pool name (a chain's name may repeat, but only where its branches are)
        real = claimRealByName(name, cx, cz, nx, nz, sw / 2 + 3);
        if (!real) { const pool = ctx.pools && (ctx.pools[type] || ctx.pools.izakaya); name = pool && pool.length ? pool[rng.int(0, pool.length - 1)] : null; }
      }
      const shopType = real ? (TENANT_TYPE[real.cat] || 'generic') : (SHOP_OF_TYPE[type] || 'generic');
      const gw = sw - 0.6;
      // on a slope each shop sits at the highest pavement point of its bay: a granite sill fills the step below
      const g0 = gr ? Math.max(0, gr(a[0] + tx * (s - sw / 2) + nx * 0.6, a[1] + tz * (s - sw / 2) + nz * 0.6), gr(a[0] + tx * (s + sw / 2) + nx * 0.6, a[1] + tz * (s + sw / 2) + nz * 0.6), gr(cx + nx * 0.6, cz + nz * 0.6)) : 0;
      const gh = glassH - g0;
      // a bay whose floor is buried too deep for a shopfront becomes a granite base wall up to the fascia
      const sillTop = gh >= 1.4 ? g0 + 0.15 : glassH + 0.15;
      if (g0 > 0.02) batch.add(At.plinth, L.boxAt(cx + nx * 0.09, (sillTop - 0.3) / 2, cz + nz * 0.09, sw, sillTop + 0.3, 0.18, Math.atan2(-tz, tx), true), cx, cz);
      // glass + interior (atlas window variant by position hash, interior-mapped in the shader)
      if (gh >= 1.4) batch.add(At.shop.mat, shopQuad(cx, 0.15 + g0 + gh / 2, cz, nx, nz, gw, gh, 0.04, shopUV(shopType, 0, faceVar + i)), cx, cz);
      const fcase = gh >= 1.4 ? shopFrontDepth(batch, inst, { cx: cx + nx * 0.04, cz: cz + nz * 0.04, nx, nz, sw, gh, y0: 0.15 + g0, type: shopType, seed: fi }) : null;
      if (gh >= 1.9 && face.kind === 'street') {
        const dIn = L.rayToPolygon(cx - nx * 0.05, cz - nz * 0.05, -nx, -nz, poly, fi, 40);
        registerShopBay({ x: cx, z: cz, y0: (batch.lift || 0) + 0.15 + g0, nx, nz, w: gw, sw, gh, type: shopType, name, real, depth: Math.max(2.8, Math.min(9, dIn - 0.6)),
          front: gh >= 1.9 && sw >= 3.2 ? 0.51 : g0 > 0.02 ? 0.2 : 0.09, case: fcase || null, caseOff: 0.04 });   // how far the shop front stands off the wall (display case 0.04 + 0.45)
      }
      // piers between shops (wall material) + fascia board
      batch.add(At.trim, L.boxAt(cx + nx * 0.08, gf - 0.55, cz + nz * 0.08, sw, 0.95, 0.18, Math.atan2(-tz, tx), false), cx, cz);
      if (name && gh >= 1.4) {
        const uv = At.fascia.get(name, fi);
        batch.add(At.fascia.mat, L.wallQuad(cx, gf - 0.55, cz, nx, nz, Math.min(sw - 0.2, 9), 0.82, 0.2, [uv.u0, uv.v0, uv.u1, uv.v1]), cx, cz);
      }
      if (i > 0) batch.add(wallMat, W(L.boxAt(a[0] + tx * (sw * i) + nx * 0.1, gf / 2, a[1] + tz * (sw * i) + nz * 0.1, 0.5, gf, 0.25, Math.atan2(-tz, tx), true)), cx, cz);
      if (rng() < 0.4 && gh >= 1.4 && ['izakaya', 'cafe', 'ramen', 'bar', 'fast', 'family', 'books'].includes(shopType)) {
        inst.add('awning', At.geos.awning, At.awningMat, cx + nx * 0.05, glassH + 0.15, cz + nz * 0.05, Math.atan2(nx, nz), gw * 0.9, 1, 1, rng.pick([0xc8102e, 0x1e7a58, 0xf2c94c, 0x1a56b8, 0xf0f0e8, 0x2a2a2a]));
      }
      // 2F tenant board over street shopfronts: the band above the fascia is lit, never a black strip at night
      const up = SHOP_TENANTS.length && face.kind === 'street' && storeys > 1 ? realAt(cx, cz, nx, nz, true) : null;
      if (up) { const uvU = At.fascia.get(up.name, fi + 7); batch.add(At.fascia.mat, L.wallQuad(cx, gf + 0.42, cz, nx, nz, Math.min(sw - 0.8, 6), 0.7, 0.12, [uvU.u0, uvU.v0, uvU.u1, uvU.v1]), cx, cz); }
      else if (face.kind === 'street' && storeys > 1 && rng() < 0.65 && ctx.pools) {
        const t2 = rng.pick(['karaoke', 'izakaya', 'game', 'cafe', 'ramen']), pool = ctx.pools[t2];
        if (pool && pool.length) { const uv2 = At.fascia.get(pool[rng.int(0, pool.length - 1)], fi + 7); batch.add(At.fascia.mat, L.wallQuad(cx, gf + 0.42, cz, nx, nz, Math.min(sw - 0.8, 6), 0.7, 0.12, [uv2.u0, uv2.v0, uv2.u1, uv2.v1]), cx, cz); }
      }
      out.facades.push({ id: `${spec.id}:shop${fi}_${i}`, buildingId: spec.id, position: new THREE.Vector3(cx, 0.15, cz), normal: new THREE.Vector3(nx, 0, nz), width: sw, height: gf, storeys: 1, tenants: name ? [name] : [], kind: 'shop', groundFloorHeight: gf });
    }
  };
  let stairDone = false;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const [nx, nz] = L.edgeNormal(poly, i);
    const face = faceOf(i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const kind = face.kind || 'alley';
    // ground floor
    const gfMode = spec.groundFloor || (kind === 'street' ? 'shop' : kind === 'alley' && rng.chance(0.5) ? 'shop' : 'wall');
    if (gfMode === 'shop' && len >= 4) shopsOnFace(a, b, nx, nz, face, i);
    else if (gfMode === 'glass' && kind !== 'blind' && len >= 3) {
      // continuous lit glazing (department stores, lobbies)
      const cells = At.win.cells.wide.filter(cl => cl.lit);
      const nb = Math.max(1, Math.round(len / 4)), bw = len / nb;
      for (let k = 0; k < nb; k++) { const s = bw * (k + 0.5); const cx = a[0] + (b[0] - a[0]) / len * s, cz = a[1] + (b[1] - a[1]) / len * s; const cl = cells[rng.int(0, cells.length - 1)]; const g0 = Math.max(grAt(cx - (b[0] - a[0]) / len * bw / 2, cz - (b[1] - a[1]) / len * bw / 2), grAt(cx + (b[0] - a[0]) / len * bw / 2, cz + (b[1] - a[1]) / len * bw / 2)); if (g0 > 0.02) batch.add(At.plinth, L.boxAt(cx + nx * 0.08, (g0 - 0.15) / 2, cz + nz * 0.08, bw, g0 + 0.45, 0.16, Math.atan2(-(b[1] - a[1]), b[0] - a[0]), true), cx, cz); if (gf - 0.5 - g0 >= 1.4) batch.add(At.win.mat, L.wallQuad(cx, 0.15 + g0 + (gf - 0.5 - g0) / 2, cz, nx, nz, bw - 0.12, gf - 0.5 - g0, 0.04, [cl.u0, cl.v0, cl.u1, cl.v1]), cx, cz); }
    }
    else if (gfMode !== 'none' && kind !== 'blind' && len >= 3) {
      // service door + a few small windows
      const cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
      const dx0 = cx - (b[0] - a[0]) / len * 1.2, dz0 = cz - (b[1] - a[1]) / len * 1.2;
      batch.add(At.trim, L.wallQuad(dx0, 1.1 + grAt(dx0 + nx * 0.5, dz0 + nz * 0.5), dz0, nx, nz, 1.0, 2.2, 0.03, [0, 0, 0.02, 0.02]), cx, cz);
    }
    if (spec.windows !== false) windowsOnFace(a, b, nx, nz, gf, h1, kind, i, h1);
    // pipes on alley/blind faces; rain downpipes + a cable conduit at the party walls of street faces (from the
    // fascia up, so they never cross a shopfront)
    if (kind !== 'street' && len >= 5 && !spec.noPipes) {
      const np = rng.int(1, 2);
      for (let k = 0; k < np; k++) { const s = rng.range(0.4, len - 0.4); inst.add('pipe', At.geos.pipe, At.pipeMat, a[0] + (b[0] - a[0]) / len * s, 0, a[1] + (b[1] - a[1]) / len * s, Math.atan2(nx, nz), 1, h1 - 0.3, 1); }
    } else if (kind === 'street' && len >= 5 && !spec.noPipes && storeys >= 2) {
      for (const s of [0.22, len - 0.22]) if (rng() < 0.55) {
        const px = a[0] + (b[0] - a[0]) / len * s, pz = a[1] + (b[1] - a[1]) / len * s;
        inst.add('pipe', At.geos.pipe, At.pipeMat, px, gf - 0.2, pz, Math.atan2(nx, nz), 1.1, h1 - gf, 1.1);
        if (rng() < 0.5) { const s2 = s + (s < 1 ? 0.3 : -0.3); inst.add('pipe', At.geos.pipe, At.pipeMat, a[0] + (b[0] - a[0]) / len * s2, gf - 0.2, a[1] + (b[1] - a[1]) / len * s2, Math.atan2(nx, nz), 0.55, h1 - gf - 0.6, 0.55); }
      }
    }
    // one fire-escape run per building, only on a side / back face that still looks onto a pavement or pedestrian
    // lane (where a camera can see it; never a shop or sign frontage). It starts at 2F, above head height, like the
    // real drop-ladder runs.
    if (!stairDone && !spec.noStairs && len >= 6 && storeys >= 3 && kind === 'alley' && ctx.stairOk && rng.chance(0.6)) {
      const s = rng.range(2.2, len - 2.2);
      const px = a[0] + (b[0] - a[0]) / len * s + nx * 0.7, pz = a[1] + (b[1] - a[1]) / len * s + nz * 0.7;
      if (ctx.stairOk(px + nx * 2.5, pz + nz * 2.5)) {
        stairDone = true;
        for (let f = 1; f < storeys - 1; f++) inst.add('stair', At.geos.stair, At.stairMat, px, gf + (f - 1) * sh, pz, Math.atan2(nx, nz) + (f % 2 ? 0 : Math.PI) + Math.PI / 2, 1, sh / 3.4, 1);
      }
    }
    out.facades.push({ id: `${spec.id}:f${i}`, buildingId: spec.id, position: new THREE.Vector3((a[0] + b[0]) / 2, 0.15, (a[1] + b[1]) / 2), normal: new THREE.Vector3(nx, 0, nz), width: len, height: h1, storeys, tenants: face.tenants || [], kind: kind === 'street' ? 'street' : 'alley', groundFloorHeight: gf });
  }
  if (spec.frontStair && !stairDone && !spec.noStairs && storeys >= 3) {
    let bi = -1, bl = 0;
    for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (faceOf(i).kind === 'street' && l > bl) { bl = l; bi = i; } }
    if (bi >= 0 && bl >= 5) {
      const a = poly[bi], b = poly[(bi + 1) % n], [nx, nz] = L.edgeNormal(poly, bi), sgn = L.hash(Math.round(a[0] * 5), Math.round(a[1] * 5), 5) < 0.5;
      const s = sgn ? bl - 1.9 : 1.9, px = a[0] + (b[0] - a[0]) / bl * s + nx * 0.7, pz = a[1] + (b[1] - a[1]) / bl * s + nz * 0.7;
      for (let f = 1; f < storeys - 1; f++) inst.add('stair', At.geos.stair, At.stairMat, px, gf + (f - 1) * sh, pz, Math.atan2(nx, nz) + (f % 2 ? 0 : Math.PI) + Math.PI / 2, 1, sh / 3.4, 1);
      stairDone = true;
    }
  }
  if (upper) {
    const m = upper.length;
    for (let i = 0; i < m; i++) {
      const a = upper[i], b = upper[(i + 1) % m];
      const [nx, nz] = L.edgeNormal(upper, i);
      windowsOnFace(a, b, nx, nz, h1, h, faceOf(i).kind === 'blind' ? 'alley' : faceOf(i).kind, i, h);
    }
  }
  // ---- roof: parapet + clutter
  const roofPoly = upper || poly;
  const rp = roofPoly.length;
  for (let i = 0; i < rp && spec.parapet !== false; i++) {
    const a = roofPoly[i], b = roofPoly[(i + 1) % rp];
    const [nx, nz] = L.edgeNormal(roofPoly, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    batch.add(wallMat, W(L.boxAt((a[0] + b[0]) / 2 - nx * 0.15, topH + 0.45, (a[1] + b[1]) / 2 - nz * 0.15, len, 0.9, 0.3, Math.atan2(-(b[1] - a[1]), b[0] - a[0]), true)), c[0], c[1]);
  }
  if (upper) {
    // lower roof parapet too
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const [nx, nz] = L.edgeNormal(poly, i);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      batch.add(wallMat, W(L.boxAt((a[0] + b[0]) / 2 - nx * 0.15, h1 + 0.45, (a[1] + b[1]) / 2 - nz * 0.15, len, 0.9, 0.3, Math.atan2(-(b[1] - a[1]), b[0] - a[0]), true)), c[0], c[1]);
    }
  }
  if (!spec.noRoofClutter) {
    const inner = L.offsetPolygon(roofPoly, -1.6);
    const bb = L.polyBounds(inner);
    const pick = () => { for (let t = 0; t < 12; t++) { const x = rng.range(bb.x0, bb.x1), z = rng.range(bb.z0, bb.z1); if (L.pointInPoly(x, z, inner)) return [x, z]; } return null; };
    const area = Math.abs(L.polyArea(roofPoly));
    // stair bulkhead + ladder, perimeter maintenance rail, duct runs, tanks, AC units, antenna
    // stair bulkhead (a lift machine-room penthouse on tall lots: the skyline's stepped tops)
    if (area > 60) { const p = pick(); if (p) { const r = rng.range(0, 3.14), bw = h > 30 ? rng.range(4.5, 7) : 3.2, bh = h > 30 ? 3.6 : 2.8, bd = h > 30 ? rng.range(4, 6) : 4.0; batch.add(wallMat, W(L.boxAt(p[0], topH + bh / 2, p[1], bw, bh, bd, r, true)), p[0], p[1]); batch.add(At.roofMat, L.boxAt(p[0], topH + bh + 0.05, p[1], bw + 0.2, 0.1, bd + 0.2, r, true), p[0], p[1]); inst.add('ladder', At.geos.ladder, At.metal, p[0] + Math.cos(r) * bw / 2, topH, p[1] - Math.sin(r) * bw / 2, r + Math.PI / 2); if (h > 30 && rng.chance(0.6)) inst.add('antenna', At.geos.antenna, At.metal, p[0], topH + bh, p[1], rng.range(0, 6.28)); } }
    if (area > 60) railAlong(inst, At, L.offsetPolygon(roofPoly, -0.45), topH);
    if (area > 60) for (let k = 0, n = area > 200 ? 3 : 2; k < n; k++) { const p = pick(); if (p) ductRun(batch, At, p[0], topH, p[1], rng.range(0, 6.28), rng.int(4, 8), inner, rng); }
    if (area > 40 && rng.chance(0.6)) { const p = pick(); if (p) inst.add('tank', At.geos.tank, At.tankMat, p[0], topH, p[1], rng.range(0, 6.28)); }
    if (area > 160 && rng.chance(0.5)) { const p = pick(); if (p) inst.add('tank', At.geos.tank, At.tankMat, p[0], topH, p[1], rng.range(0, 6.28)); }
    const nAc = Math.min(14, Math.round(area / 35));
    for (let k = 0; k < nAc; k++) { const p = pick(); if (p) inst.add('acBig', At.geos.acBig, At.acMat, p[0], topH, p[1], rng.range(0, 6.28), 1, 1, 1, rng.chance(0.7) ? 0xbcbcb8 : 0x8a8e92); }
    if (rng.chance(0.5)) { const p = pick(); if (p) inst.add('antenna', At.geos.antenna, At.metal, p[0], topH, p[1], rng.range(0, 6.28)); }
    // rooftop billboard: a tall steel-scaffold board on ~30 % of the street-corner lots over 20 m (the Shibuya skyline
    // read), a low frame on most other street lots; signage lights the face through ctx.billboards
    const streetFaces = (spec.faces || []).map((f, i) => (f && f.kind === 'street' ? i : -1)).filter(i => i >= 0 && i < rp);
    const streetFace = spec.boardFace != null && spec.boardFace < rp ? spec.boardFace : streetFaces.length ? streetFaces.reduce((b, i) => { const l = (j) => Math.hypot(roofPoly[(j + 1) % rp][0] - roofPoly[j][0], roofPoly[(j + 1) % rp][1] - roofPoly[j][1]); return l(i) > l(b) ? i : b; }, streetFaces[0]) : -1;
    const corner = streetFaces.length >= 2 && h > 20;
    const big = (corner || spec.bigBoard === 1) && rng.chance(spec.bigBoard ?? 0.3);
    if (streetFace >= 0 && (big || rng.chance(0.7))) {
      const a = roofPoly[streetFace], b = roofPoly[(streetFace + 1) % rp];
      const [nx, nz] = L.edgeNormal(roofPoly, streetFace);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 6) {
        const w = big ? Math.min(len - 1.5, rng.range(8, 13)) : Math.min(len - 2, rng.range(5, 10)), lift = big ? rng.range(2.6, 4) : 1.4;
        const cx = (a[0] + b[0]) / 2 - nx * 0.8, cz = (a[1] + b[1]) / 2 - nz * 0.8;
        const ctr = billboardFrame(batch, At, cx, topH, cz, nx, nz, w, lift, 3.0, big);
        (ctx.billboards || []).push({ buildingId: spec.id, position: new THREE.Vector3(ctr[0] + nx * 0.02, ctr[1], ctr[2] + nz * 0.02), normal: new THREE.Vector3(nx, 0, nz), width: w, height: 3.0 });
        if (big) inst.add('gb_aviation', At.geos.lamp, At.aviationMat, cx - nx * 0.25, topH + lift + 3.25, cz - nz * 0.25, 0, 0.28, 0.28, 0.28);
      }
    }
    // red aviation lamps on the roof corners of tall lots (blink in city.update)
    if (h > 45) for (let i = 0; i < rp; i += Math.max(1, Math.floor(rp / 2))) { const q = roofPoly[i]; inst.add('gb_aviation', At.geos.lamp, At.aviationMat, q[0] - (q[0] - c[0]) * 0.03, topH + 1.05, q[1] - (q[1] - c[1]) * 0.03, 0, 0.35, 0.35, 0.35); }
  }
  // parapet back-light on street faces near the crossing (spec.roofGlow): the roof edge reads against the night sky
  if (spec.roofGlow && spec.parapet !== false) {
    for (let i = 0; i < rp; i++) {
      if (!(faceOf(i).kind === 'street')) continue;
      const a = roofPoly[i], b = roofPoly[(i + 1) % rp], [nx, nz] = L.edgeNormal(roofPoly, i), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 4) continue;
      batch.add(At.washMat, L.wallQuad((a[0] + b[0]) / 2 + nx * 0.005, topH + 0.45, (a[1] + b[1]) / 2 + nz * 0.005, nx, nz, len - 0.1, 0.9, 0.0, [0, 0, 1, 1]), c[0], c[1]);
    }
  }
  // ---- colliders: per-edge walls for irregular footprints, else one OBB of the oriented bounds
  if (spec.colliders === 'edges') out.colliders.push(...L.edgeColliders(poly, h));
  else if (spec.colliders !== 'none') {
    const a = poly[0], b = poly[1];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    const ux = dx / l, uz = dz / l;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, z] of poly) { const u = x * ux + z * uz, v = -x * uz + z * ux; if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v; }
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
    const cx = cu * ux - cv * uz, cz = cu * uz + cv * ux;
    out.colliders.push({ obb: { center: new THREE.Vector3(cx, h / 2, cz), halfSize: new THREE.Vector3((maxU - minU) / 2 + 0.1, h / 2, (maxV - minV) / 2 + 0.1), rotationY: Math.atan2(-uz, ux) } });
  }
  return out;
}

/** Instanced maintenance rail along every edge of a (roof) polygon at height y. */
export function railAlong(inst, At, polyIn, y) {
  const p = L.ensureCW(polyIn), n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1) continue;
    const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len, rot = L.rotYOf(tx, tz);
    for (let s = 0; s < len - 0.05; s += 3) inst.add('roofRail', At.geos.roofRail, At.metal, a[0] + tx * s, y, a[1] + tz * s, rot, Math.min(3, len - s), 1, 1);
  }
}
/** Chain of duct boxes (with a 90° turn half way) from (x, z) along `ang`, kept inside `inner`. */
export function ductRun(batch, At, x, y, z, ang, n, inner, rng) {
  let dx = Math.cos(ang), dz = Math.sin(ang), px = x, pz = z;
  const w = rng ? rng.range(0.45, 0.8) : 0.6, hh = w * 0.8, seg = 2.0;
  for (let i = 0; i < n; i++) {
    if (i === Math.floor(n / 2)) { const t = dx; dx = -dz; dz = t; }
    const nx = px + dx * seg, nz = pz + dz * seg;
    if (!L.pointInPoly(nx, nz, inner)) break;
    batch.add(At.pipeMat, L.boxAt((px + nx) / 2, y + 0.35 + hh / 2, (pz + nz) / 2, seg + 0.05, hh, w, L.rotYOf(dx, dz), false), px, pz);
    batch.add(At.trim, L.boxAt(px, y + 0.18, pz, 0.12, 0.36, w + 0.2, L.rotYOf(dx, dz), false), px, pz);   // support cradle
    px = nx; pz = nz;
  }
}

// ------------------------------------------------------------------------------------------------- legacy box API
export function facadeMaterial(variant) { const At = getAtlases(); return At.walls[((variant | 0) % At.walls.length + At.walls.length) % At.walls.length]; }
export function build({ w = 16, d = 16, h = 24, storeys = null, materials, rng, variant = null, shopfront = true, roofClutter = true, style = 'tenant', tenants = [] } = {}) {
  const group = new THREE.Group();
  const batch = new L.GeoBatch(), inst = new L.Instancer();
  const st = storeys || Math.max(1, Math.round(h / STOREY_H));
  const poly = L.rectPoly(0, 0, w, d, 0);
  const r = buildBuilding({ id: 'box', poly, storeys: st, style, wall: variant, faces: poly.map((_, i) => ({ kind: i === 0 && shopfront ? 'street' : 'alley', tenants })), noRoofClutter: !roofClutter }, { batch, inst, rng: rng || createFallbackRng(), pools: null });
  batch.build(group); inst.build(group);
  return { group, colliders: r.colliders, lights: [], size: new THREE.Vector3(w, r.height, d) };
}
function createFallbackRng() { let s = 7; const f = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; f.range = (a, b) => a + (b - a) * f(); f.int = (a, b) => Math.min(b, Math.floor(a + (b - a + 1) * f())); f.pick = (arr) => arr[Math.floor(f() * arr.length)]; f.chance = (p) => f() < p; return f; }

export { tenantType, SHOP_OF_TYPE, STYLES };
export default { build, buildBuilding, getAtlases, setNightFactor, getNightFactor, facadeMaterial, STOREY_H };
