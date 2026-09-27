// [city] 渋谷町駅 ハチ公口 (JR) — the west station building along the JR viaduct (x 40–52, 18 m), the under-track
// concourse box, the Hachiko-exit ticket-gate recess facing the square with its canopy and green JP band sign,
// the "Hachiko family" mosaic wall, rooftop plant. Platforms / roofs / train / Ginza-line box come from rail.js.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE, PEDS, paintPed, pedKey } from './genericBuilding.js';
import { well } from './escalator.js';

export const KEYS = ['station'];
export const SIZE = { w: 44, d: 112, h: 18 };

function mosaicCanvas() {
  const c = L.makeCanvas(1024, 320), ctx = c.getContext('2d');
  ctx.fillStyle = '#e8e2d2'; ctx.fillRect(0, 0, 1024, 320);
  const cols = ['#f04a3c', '#f5b32a', '#2c8ad4', '#3fa85a', '#f28ad0', '#8e5ad1', '#ffffff', '#1a1a1a'];
  for (let i = 0; i < 64; i++) for (let j = 0; j < 20; j++) { ctx.fillStyle = cols[Math.floor(L.hash(i, j, 41) * cols.length)]; ctx.globalAlpha = 0.25 + L.hash(i, j, 42) * 0.5; ctx.fillRect(i * 16 + 1, j * 16 + 1, 14, 14); }
  ctx.globalAlpha = 1;
  // stylised dogs: body + head + ears in bold colours
  for (let k = 0; k < 7; k++) {
    const x = 90 + k * 135, y = 200, col = cols[k % 6];
    ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(x, y, 48, 34, 0, 0, 6.3); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 40, y - 40, 24, 0, 6.3); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + 24, y - 58); ctx.lineTo(x + 30, y - 84); ctx.lineTo(x + 44, y - 60); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + 50, y - 60); ctx.lineTo(x + 60, y - 84); ctx.lineTo(x + 64, y - 58); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#1a1a1a'; ctx.beginPath(); ctx.arc(x + 48, y - 42, 3, 0, 6.3); ctx.fill();
  }
  ctx.fillStyle = '#1a1a1a'; ctx.font = `700 34px ${L.FONT_JP}`; ctx.textAlign = 'center'; ctx.fillText('ハチ公ファミリー', 512, 60);
  ctx.font = `500 20px ${L.FONT_LATIN}`; ctx.fillText('Hachiko Family  ―  Shibuya-cho', 512, 92);
  return c;
}
/**
 * Concourse back wall atlas: three 40 m × 5 m strips (gate hall / kiosk + lockers / stairs + escalator) stacked in a
 * 2048 × 1536 canvas. Everything is laid out on the 3.2 m mullion pitch of the real glazing: painted columns at
 * k·3.2 m, boards and posters centred in the bays between them (a bay-wide board never runs behind a mullion). The
 * wall is a grimed 30 cm tile, darker than the street so the frontage is not the brightest thing in frame, under a
 * duct / cable-tray soffit. The ticket gates themselves are real geometry in front of this wall (build()).
 */
const PITCH = 3.2;
function concourseCanvas() {
  const W = 2048, SH = 512, c = L.makeCanvas(W, SH * 3), ctx = c.getContext('2d');
  const MX = W / 40, MY = SH / 5;
  for (let s = 0; s < 3; s++) {
    const y = s * SH;
    const X = (m) => m * MX, Y = (m) => y + SH - m * MY;
    const rect = (mx, my, mw, mh, col) => { ctx.fillStyle = col; ctx.fillRect(X(mx), Y(my + mh), mw * MX, mh * MY); };
    const text = (t, mx, my, mh, col, weight = '700', font = L.FONT_JP, maxW = 0) => { ctx.save(); ctx.translate(X(mx), Y(my)); ctx.scale(MX / MY, 1); ctx.fillStyle = col; ctx.font = `${weight} ${mh * MY}px ${font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; if (maxW) { const w0 = ctx.measureText(t).width * MX / MY; if (w0 > maxW * MX) ctx.scale(maxW * MX / w0, 1); } ctx.fillText(t, 0, 0); ctx.restore(); };
    const bayC = (k) => (k + 0.5) * PITCH;
    // grimed tile: warm grey, darker toward the floor, per-tile tone, soot along the skirting
    const g = ctx.createLinearGradient(0, y, 0, y + SH); g.addColorStop(0, '#8f877a'); g.addColorStop(0.7, '#8a8274'); g.addColorStop(1, '#5e574d'); ctx.fillStyle = g; ctx.fillRect(0, y, W, SH);
    for (let i = 0; i < 134; i++) for (let j = 0; j < 17; j++) { const v = L.hash(i, j + s * 20, 57); if (v > 0.55) { ctx.fillStyle = `rgba(${v > 0.8 ? '255,255,255' : '0,0,0'},0.05)`; ctx.fillRect(X(i * 0.3), Y((j + 1) * 0.3), 0.3 * MX, 0.3 * MY); } }
    ctx.fillStyle = 'rgba(0,0,0,0.16)'; for (let mx = 0; mx < 40; mx += 0.3) ctx.fillRect(Math.round(X(mx)), y, 1, SH); for (let my = 0.3; my < 5; my += 0.3) ctx.fillRect(0, Math.round(Y(my)), W, 1);
    for (let k = 0; k < 60; k++) { const gx = L.hash(k, s, 58) * 40, gl = 0.4 + L.hash(k, s, 59) * 1.4; const gg = ctx.createLinearGradient(0, Y(4.3), 0, Y(4.3 - gl)); gg.addColorStop(0, 'rgba(30,26,22,0.25)'); gg.addColorStop(1, 'rgba(30,26,22,0)'); ctx.fillStyle = gg; ctx.fillRect(X(gx), Y(4.3), (0.05 + L.hash(k, s, 60) * 0.2) * MX, gl * MY); }
    rect(0, 0, 40, 0.15, '#3e3a34'); rect(0, 0.15, 40, 0.25, 'rgba(0,0,0,0.18)');                                            // skirting + soot
    // soffit: dark ceiling, a duct run and a cable tray, fluorescent battens
    rect(0, 4.3, 40, 0.7, '#2e2d2b'); rect(0, 4.45, 40, 0.28, '#6a6c70'); rect(0, 4.45, 40, 0.03, '#8a8c90'); rect(0, 4.7, 40, 0.03, '#3a3c40');
    for (let mx = 0.2; mx < 40; mx += 1.2) rect(mx, 4.47, 0.06, 0.24, 'rgba(0,0,0,0.25)');                                    // duct flanges
    rect(0, 4.33, 40, 0.06, '#9a9488'); for (let mx = 0; mx < 40; mx += 0.25) rect(mx, 4.33, 0.03, 0.06, '#5a564e');           // cable tray
    // commuters (cut-outs) walking along the back of the hall
    // commuters: the client's pedestrian scans as cut-outs (every person in the game is one of the 19 scans); the
    // painted figure below is only the fallback when the sprite sheet is missing
    const person = (mx, sc, i) => {
      const key = pedKey(i * 7 + s * 5, false);
      if (key) { const sp = 1.66 / PEDS.meta.scans[key].height * sc; if (paintPed(ctx, key, 'full', i % 2 ? 'q34' : 'front', X(mx), Y(0.15), MX * sp, MY * sp, { dark: 0.2 + 0.25 * Math.max(0, 1.05 - sc), soft: 0.9, flip: i % 3 === 1 })) return; }
      const skin = ['#c9a48a', '#b89276', '#d2b096'][i % 3], hair = ['#1a1714', '#2a221c', '#3c3026'][i % 3], cloth = ['#2c3038', '#4a4038', '#5a5e66', '#6a3a34', '#3c4a42', '#b8b2a8', '#24242a'][(i * 3) % 7];
      const base = 0.15, top = base + 1.66 * sc, sh = top - 0.3 * sc;
      rect(mx - 0.1 * sc, base, 0.08 * sc, 0.8 * sc, '#22242a'); rect(mx + 0.02 * sc, base, 0.08 * sc, 0.8 * sc, '#22242a');   // legs
      ctx.fillStyle = cloth; ctx.beginPath(); ctx.moveTo(X(mx - 0.2 * sc), Y(sh)); ctx.lineTo(X(mx + 0.2 * sc), Y(sh)); ctx.lineTo(X(mx + 0.17 * sc), Y(base + 0.78 * sc)); ctx.lineTo(X(mx - 0.17 * sc), Y(base + 0.78 * sc)); ctx.closePath(); ctx.fill();
      rect(mx - 0.26 * sc, base + 0.8 * sc, 0.07 * sc, sh - base - 0.85 * sc, cloth); rect(mx + 0.19 * sc, base + 0.8 * sc, 0.07 * sc, sh - base - 0.85 * sc, cloth);
      rect(mx - 0.035 * sc, sh, 0.07 * sc, 0.06 * sc, skin);
      ctx.fillStyle = skin; ctx.beginPath(); ctx.ellipse(X(mx), Y(top - 0.12 * sc), 0.085 * sc * MX, 0.11 * sc * MY, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = hair; ctx.beginPath(); ctx.ellipse(X(mx), Y(top - 0.08 * sc), 0.09 * sc * MX, 0.08 * sc * MY, 0, Math.PI, 0); ctx.fill();
      if (i % 3 === 0) rect(mx + 0.2 * sc, base + 0.7 * sc, 0.2 * sc, 0.28 * sc, '#1a1a1a');                                    // bag
    };
    // framed posters in the bays the strip leaves free
    const poster = (k, bg, t, sub) => { const mx = bayC(k); rect(mx - 0.75, 1.3, 1.5, 2.1, '#1c1c1e'); rect(mx - 0.68, 1.37, 1.36, 1.96, bg); text(t, mx, 2.7, 0.3, '#ffffff', '900', L.FONT_LATIN, 1.2); text(sub, mx, 1.8, 0.14, '#ffffff', '600', L.FONT_JP, 1.2); rect(mx - 0.75, 3.4, 1.5, 0.04, '#e8e0c8'); };
    if (s === 0) {                       // gate hall: commuters beyond the (3D) gates, green 改札 boards in bays 2 and 7, ticket machines
      for (let i = 0; i < 22; i++) person(1.2 + L.hash(i, 1, 51) * 32, 0.94 + L.hash(i, 2, 51) * 0.12, i);
      for (const k of [2, 7]) { const mx = bayC(k); rect(mx - 1.3, 3.15, 2.6, 0.72, '#1d8f3e'); text('改札', mx, 3.62, 0.3, '#ffffff', '900', L.FONT_JP, 2.3); text('Ticket Gates', mx, 3.3, 0.16, '#ffffff', '700', L.FONT_LATIN, 2.3); rect(mx - 1.3, 3.08, 2.6, 0.06, '#ffe36a'); }
      { const mx = bayC(11); rect(mx - 1.4, 1.2, 2.8, 2.4, '#e8e4dc'); rect(mx - 1.3, 1.4, 2.6, 2.0, '#2b6bd6'); text('きっぷうりば', mx, 3.1, 0.28, '#ffffff', '800', L.FONT_JP, 2.4); for (let i = 0; i < 2; i++) rect(mx - 1.2 + i * 1.3, 0.15, 1.1, 1.4, '#a8b0b8'); }
      poster(4, '#c8102e', 'SHIBUYA46', '純愛 ― NOW ON SALE'); poster(9, '#1a2a4a', 'TOJO COLA', '爽快、東城。');
      { const mx = bayC(0); rect(mx - 0.8, 2.0, 1.6, 1.8, '#2b6bd6'); text('ハチ公口', mx, 3.5, 0.24, '#ffffff', '800', L.FONT_JP, 1.4); text('↑', mx, 2.6, 0.7, '#ffffff', '800', L.FONT_LATIN); }
    } else if (s === 1) {                // kiosk + coin lockers + vending machines + map board
      rect(0.4, 0.15, 5.6, 2.7, '#3a2e24'); rect(0.4, 2.4, 5.6, 0.55, '#d8bc20'); text('NEWDAYZ', 3.2, 2.68, 0.36, '#111111', '800', L.FONT_LATIN, 5);
      for (let r = 0; r < 4; r++) for (let i = 0; i < 11; i++) rect(0.7 + i * 0.46, 0.45 + r * 0.48, 0.38, 0.32, ['#b8605a', '#5b7aa6', '#c7ab63', '#5e8c6c', '#ddd8cc', '#c28d5e'][(i + r) % 6]);
      rect(0.6, 0.15, 5.2, 0.85, '#a8a39a'); rect(1.4, 1.0, 0.9, 0.5, '#2a2a2e');
      for (let r = 0; r < 5; r++) for (let mx = 6.6; mx < 12.6; mx += 0.4) rect(mx, 0.15 + r * 0.56, 0.36, 0.52, (r + (mx * 10 | 0)) % 7 === 0 ? '#3a4a7a' : '#8e929a');   // coin lockers
      rect(6.6, 3.0, 6, 0.4, '#1a3a7a'); text('コインロッカー', 9.6, 3.2, 0.26, '#ffffff', '700', L.FONT_JP, 5.6);
      for (let i = 0; i < 2; i++) { const mx = 13.2 + i * 1.3; rect(mx, 0.15, 1.1, 1.9, ['#2b5ab6', '#b02020'][i]); rect(mx + 0.12, 0.9, 0.86, 1.0, '#dcdcd8'); }   // vending machines
      poster(5, '#6a2a8a', 'KARAOKE', 'カラオケ舘 ― 30分 ¥100'); poster(7, '#0b3d2e', 'STARBEANS', 'SEASONAL LATTE');
      { const mx = bayC(9); rect(mx - 1.4, 0.6, 2.8, 3.0, '#e8e4dc'); rect(mx - 1.3, 0.8, 2.6, 2.4, '#c8d0bc'); rect(mx - 1.3, 3.2, 2.6, 0.35, '#1d8f3e'); text('構内図', mx, 3.37, 0.24, '#ffffff', '800', L.FONT_JP, 2.4); ctx.fillStyle = '#4a4a4a'; for (let i = 0; i < 9; i++) ctx.fillRect(X(mx - 1.1 + L.hash(i, 3, 53) * 2.0), Y(1.0 + L.hash(i, 4, 53) * 2.0), 0.4 * MX, 0.05 * MY); }
      for (let i = 0; i < 9; i++) person(0.8 + L.hash(i, 5, 52) * 37, 0.94 + L.hash(i, 6, 52) * 0.12, i + 5);
    } else {                             // stairs + escalator up to the platforms, のりば board in its own bay
      for (let i = 0; i < 14; i++) rect(1 + i * 0.4, 0.15 + i * 0.28, 5.4 - i * 0.38, 0.28, i % 2 ? '#8a847a' : '#96907e');
      rect(1, 0.15, 5.6, 0.04, '#d8c830');
      ctx.save(); ctx.beginPath(); ctx.moveTo(X(7), Y(0.15)); ctx.lineTo(X(15.5), Y(0.15)); ctx.lineTo(X(15.5), Y(4.3)); ctx.closePath(); ctx.fillStyle = '#6e737a'; ctx.fill(); ctx.restore();
      ctx.strokeStyle = '#b8bcc0'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(X(7), Y(1.1)); ctx.lineTo(X(15.5), Y(4.2)); ctx.stroke();
      for (let i = 0; i < 14; i++) rect(7.2 + i * 0.6, 0.15 + i * 0.29, 0.5, 0.06, '#2a2a2c');
      { const mx = bayC(6); rect(mx - 1.4, 3.05, 2.8, 0.7, '#1d8f3e'); text('のりば ↑', mx, 3.52, 0.28, '#ffffff', '900', L.FONT_JP, 2.5); text('山手線 ・ 埼京線', mx, 3.2, 0.16, '#ffffff', '700', L.FONT_JP, 2.5); }
      poster(8, '#c8102e', 'SALE', '東急百貨店 ― 夏のクリアランス'); poster(10, '#1a56b8', 'Q-FRONT', 'TSUTAYU ― 新作レンタル');
      for (let i = 0; i < 10; i++) person(17 + L.hash(i, 7, 54) * 22, 0.94 + L.hash(i, 8, 54) * 0.12, i + 9);
    }
    for (let k = 0; k <= 13; k++) { const mx = k * PITCH; rect(mx - 0.25, 0.15, 0.5, 4.15, '#77726a'); rect(mx + 0.12, 0.15, 0.13, 4.15, '#5a564f'); rect(mx - 0.25, 0.15, 0.5, 0.4, '#3a3632'); }   // columns on the mullion pitch
  }
  return c;
}
/** ICカード自動改札機 bank: body, green top plate, blue reader, orange flap doors, one merged vertex-coloured mesh. */
let gateMat = null;
function icGates(batch, x0, z0, z1, depth, pitch = 0.9) {
  if (!gateMat) { gateMat = L.std({ vertexColors: true, roughness: 0.45, metalness: 0.2, emissive: 0x000000 }); gateMat.name = 'lm_icGate'; }
  const col = (g, hex) => { const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
  const xc = x0 + 0.15 + depth / 2;
  for (let z = z0; z <= z1; z += pitch) {
    batch.add(gateMat, col(L.boxAt(xc, 0.15 + 0.5, z, depth, 1.0, 0.22, 0, false), 0xc4c8cc), xc, z);
    batch.add(gateMat, col(L.boxAt(xc, 0.15 + 1.02, z, depth + 0.02, 0.05, 0.24, 0, false), 0x1d8f3e), xc, z);
    batch.add(gateMat, col(L.boxAt(xc - depth / 2 + 0.25, 0.15 + 1.06, z, 0.26, 0.03, 0.18, 0, false), 0x2b6bd6), xc, z);
    batch.add(gateMat, col(L.boxAt(xc - depth / 2 + 0.05, 0.15 + 0.85, z, 0.04, 0.16, 0.2, 0, false), 0x101418), xc, z);   // display
    if (z + pitch <= z1) for (const sg of [-1, 1]) batch.add(gateMat, col(L.boxAt(xc + 0.1, 0.15 + 0.62, z + pitch / 2 + sg * 0.17, 0.05, 0.36, 0.3, 0, false), 0xe8742a), xc, z);   // flaps
  }
}

function gateCanvas() {
  const c = L.makeCanvas(1024, 512), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512); g.addColorStop(0, '#fff6e2'); g.addColorStop(1, '#e8dcc4'); ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 512);
  ctx.fillStyle = '#d8d0c0'; ctx.fillRect(0, 400, 1024, 112);                                       // floor
  for (let i = 0; i < 7; i++) { const x = 70 + i * 135; ctx.fillStyle = '#c9ced4'; ctx.fillRect(x, 250, 46, 160); ctx.fillStyle = '#1d8f3e'; ctx.fillRect(x, 250, 46, 12); ctx.fillStyle = '#2b6bd6'; ctx.fillRect(x + 6, 300, 34, 22); }   // ticket gates
  ctx.fillStyle = '#1d8f3e'; ctx.fillRect(0, 60, 1024, 70);
  ctx.fillStyle = '#fff'; ctx.font = `800 44px ${L.FONT_JP}`; ctx.textAlign = 'center'; ctx.fillText('ハチ公改札  Hachiko Gate', 512, 110);
  ctx.fillStyle = '#ffe36a'; ctx.fillRect(0, 140, 1024, 6);
  ctx.fillStyle = '#333'; ctx.font = `600 30px ${L.FONT_JP}`; ctx.fillText('山手線 ・ 埼京線 ・ 湘南新宿ライン    のりば →', 512, 200);
  return c;
}

// ------------------------------------------------------------------ the 1F 東西自由通路 and the relocated ハチ公改札
// Since 2025-01-26 the JR ハチ公改札 (14 gates: 8 in, 6 out) no longer faces Hachiko square: it stands on the south
// side of the ground-floor passage under the tracks that runs from ハチ公口 (the square) to 宮益坂口 (the 東口 side),
// "closer to 宮益坂口 on the far side of the tracks" (シブヤ経済新聞 2025-01, 東洋経済 2025-02). OSM: corridor
// 904652326 / footway 906194293 (x 43 → 85.5, z ≈ 15–27), the 宮益坂口 node 8401481034 at (85.5, 19.2), the station
// building's north edge (59.4, 14.5) → (82.9, 12.1) along the narrow 宮益坂 ガード下 pavement.
const PAS = { z0: 17.5, z1: 25.5, h: 4.2 };                 // passage (behind the ガード下 shop strip)
const GATE = { x0: 64.6, x1: 82, z1: 31.5, h: 3.6 };         // gate recess (paid concourse beyond the gate line)
const WEST_N = 15.6;                                         // the west building's north face (OSM 15.3–16.2)
// the under-track block's north face (OSM, slanted), never closer than 2.4 m to 宮益坂's kerb (≈ z 10.9 there): the
// real ガード下 pavement is narrow but walkable, guard pipe and all (client: 「ここの通りは実際は狭いが、通れるはず」)
const northFace = (x) => Math.max(14.5 - 0.102 * (x - 59.4), 13.3);
/** Recess back (paid concourse: stair + escalators up to the platforms, commuters) and the header band over the gates
 *  (name board, three 発車標, the 運賃表), one 2048 × 768 canvas. */
function gateCanvas2(gateName = 'ハチ公改札', gateEn = 'Hachiko Gate') {
  const W = 2048, c = L.makeCanvas(W, 768), ctx = c.getContext('2d');
  // ---- A (0..512): 17.4 m × 3.6 m concourse back wall
  {
    const MX = W / 17.4, MY = 512 / 3.6, X = (m) => m * MX, Y = (m) => 512 - m * MY;
    const rect = (mx, my, mw, mh, col) => { ctx.fillStyle = col; ctx.fillRect(X(mx), Y(my + mh), mw * MX, mh * MY); };
    const text = (t, mx, my, mh, col, weight = '800', font = L.FONT_JP, maxW = 0) => { ctx.save(); ctx.translate(X(mx), Y(my)); ctx.scale(MX / MY, 1); ctx.fillStyle = col; ctx.font = `${weight} ${mh * MY}px ${font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; if (maxW) { const w0 = ctx.measureText(t).width * MX / MY; if (w0 > maxW * MX) ctx.scale(maxW * MX / w0, 1); } ctx.fillText(t, 0, 0); ctx.restore(); };
    const g = ctx.createLinearGradient(0, 0, 0, 512); g.addColorStop(0, '#f2f0ea'); g.addColorStop(0.75, '#e2ded4'); g.addColorStop(1, '#b8b2a6'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, 512);
    ctx.fillStyle = 'rgba(0,0,0,0.07)'; for (let m = 0; m < 17.4; m += 0.3) ctx.fillRect(X(m), 0, 1, 512); for (let m = 0; m < 3.6; m += 0.3) ctx.fillRect(0, Y(m), W, 1);
    rect(0, 0, 17.4, 0.12, '#6a665e'); rect(0, 3.25, 17.4, 0.35, '#d8d8d4'); for (let m = 0.6; m < 17.4; m += 1.6) rect(m, 3.3, 0.9, 0.05, '#ffffff');   // soffit battens
    // stair up (left) and the up / down escalators (right), rising out of frame into the platform level
    for (let i = 0; i < 12; i++) rect(0.6 + i * 0.05, 0.12 + i * 0.26, 4.6 - i * 0.1, 0.26, i % 2 ? '#a19a8c' : '#aba495');
    rect(0.6, 0.12, 4.6, 0.04, '#e0c030');
    for (const [e0, dir] of [[6.0, 1], [8.1, -1]]) {
      ctx.save(); ctx.beginPath(); ctx.moveTo(X(e0), Y(0.12)); ctx.lineTo(X(e0 + 1.9), Y(0.12)); ctx.lineTo(X(e0 + 1.9), Y(3.3)); ctx.lineTo(X(e0), Y(3.3)); ctx.closePath(); ctx.fillStyle = '#5c6068'; ctx.fill(); ctx.restore();
      for (let i = 0; i < 16; i++) rect(e0 + 0.15, 0.3 + i * 0.19, 1.6, 0.05, '#2a2c30');
      rect(e0, 0.12, 0.1, 3.2, '#1a1c20'); rect(e0 + 1.8, 0.12, 0.1, 3.2, '#1a1c20');
      text(dir > 0 ? '↑' : '↓', e0 + 0.95, 0.6, 0.4, dir > 0 ? '#3ad06a' : '#ff5a4a', '900', L.FONT_LATIN);
    }
    // のりば boards
    rect(0.7, 2.55, 4.4, 0.62, '#1d8f3e'); text('1・2番線  山手線', 2.9, 2.94, 0.26, '#ffffff', '900', L.FONT_JP, 4.1); text('渋谷町 ・ 新宿 ・ 池袋 / 品川 ・ 東京', 2.9, 2.68, 0.14, '#ffffff', '700', L.FONT_JP, 4.1);
    rect(6.0, 2.55, 4.0, 0.62, '#1d8f3e'); text('3・4番線  埼京線 ・ 湘南新宿ライン', 8.0, 2.94, 0.22, '#ffffff', '900', L.FONT_JP, 3.8); text('新宿 ・ 大宮 / 大崎 ・ 横浜', 8.0, 2.68, 0.14, '#ffffff', '700', L.FONT_JP, 3.8);
    // posters + a station map board in the bays right of the escalators
    for (const [m, bg, t, sub] of [[11.2, '#c8102e', 'SHIBUYA46', '純愛 ― 9.28 ON SALE'], [12.8, '#0b3d2e', 'STARBEANS', 'AUTUMN LATTE'], [14.4, '#1a2a4a', 'TOJO COLA', '爽快、東城。']]) { rect(m, 1.0, 1.3, 1.9, '#1c1c1e'); rect(m + 0.06, 1.06, 1.18, 1.78, bg); text(t, m + 0.65, 2.3, 0.24, '#ffffff', '900', L.FONT_LATIN, 1.1); text(sub, m + 0.65, 1.5, 0.12, '#ffffff', '700', L.FONT_JP, 1.1); }
    rect(15.9, 0.9, 1.3, 2.1, '#e8e4dc'); rect(15.96, 0.96, 1.18, 1.7, '#c9d2c0'); rect(15.96, 2.66, 1.18, 0.3, '#1d8f3e'); text('構内図', 16.55, 2.81, 0.18, '#ffffff', '800', L.FONT_JP, 1.1);
    for (let k = 0; k < 7; k++) { const m = 0.05 + k * 2.9; rect(m, 0.12, 0.3, 3.13, '#8a857c'); rect(m + 0.22, 0.12, 0.08, 3.13, '#6a655d'); }   // columns
    // commuters: the scan cut-outs (heading to the stairs / off the escalators), darker toward the back
    if (PEDS) for (let i = 0; i < 12; i++) {
      const mx = 0.8 + L.hash(i, 3, 71) * 16, sc = 0.84 + L.hash(i, 4, 71) * 0.14, key = pedKey(i * 5 + 3, i % 4 === 0);
      const sp = 1.66 / PEDS.meta.scans[key].height * sc;
      paintPed(ctx, key, 'full', i % 2 ? 'q34' : 'front', X(mx), Y(0.12 + (1 - sc) * 0.5), MX * sp, MY * sp, { dark: 0.18 + 0.3 * (1 - sc), soft: 1.0, flip: i % 3 === 1 });
    }
  }
  // ---- B (512..768): 17.4 m × 1.5 m header band over the gate line
  {
    const MX = W / 17.4, MY = 256 / 1.5, X = (m) => m * MX, Y = (m) => 768 - m * MY;
    const rect = (mx, my, mw, mh, col) => { ctx.fillStyle = col; ctx.fillRect(X(mx), Y(my + mh), mw * MX, mh * MY); };
    const text = (t, mx, my, mh, col, weight = '800', font = L.FONT_JP, maxW = 0, align = 'center') => { ctx.save(); ctx.translate(X(mx), Y(my)); ctx.scale(MX / MY, 1); ctx.fillStyle = col; ctx.font = `${weight} ${mh * MY}px ${font}`; ctx.textAlign = align; ctx.textBaseline = 'middle'; if (maxW) { const w0 = ctx.measureText(t).width * MX / MY; if (w0 > maxW * MX) ctx.scale(maxW * MX / w0, 1); } ctx.fillText(t, 0, 0); ctx.restore(); };
    rect(0, 0, 17.4, 1.5, '#e9e7e1'); rect(0, 0, 17.4, 0.06, '#9a968e');
    // gate name board
    rect(0.2, 0.2, 3.6, 1.1, '#1d8f3e'); rect(0.2, 0.2, 3.6, 0.06, '#ffe36a'); text(gateName, 2.0, 0.95, 0.42, '#ffffff', '900', L.FONT_JP, 3.3); text(gateEn, 2.0, 0.48, 0.2, '#ffffff', '700', L.FONT_LATIN, 3.3);
    // 発車標: black LED boards, orange / green rows
    const board = (m, line, col, rows) => {
      rect(m, 0.18, 3.3, 1.16, '#101214'); rect(m, 1.18, 3.3, 0.16, col); text(line, m + 1.65, 1.26, 0.11, '#ffffff', '800', L.FONT_JP, 3.1);
      rows.forEach((r, k) => { const y = 0.95 - k * 0.24; text(r[0], m + 0.12, y, 0.14, '#ffb020', '700', L.FONT_JP, 0.6, 'left'); text(r[1], m + 0.85, y, 0.14, '#ffb020', '700', L.FONT_JP, 1.4, 'left'); text(r[2], m + 3.18, y, 0.14, '#3ad06a', '700', L.FONT_LATIN, 0.7, 'right'); });
    };
    board(4.0, '山手線  外回り  新宿 ・ 池袋方面', '#8fc31f', [['普通', '新宿 ・ 池袋', '21:34'], ['普通', '新宿 ・ 池袋', '21:37'], ['普通', '新宿 ・ 池袋', '21:40']]);
    board(7.45, '山手線  内回り  品川 ・ 東京方面', '#8fc31f', [['普通', '品川 ・ 東京', '21:35'], ['普通', '品川 ・ 東京', '21:38'], ['普通', '品川 ・ 東京', '21:41']]);
    board(10.9, '埼京線 ・ 湘南新宿ライン', '#00ac9a', [['快速', '大宮', '21:36'], ['普通', '新木場', '21:44'], ['特快', '小田原', '21:49']]);
    // 運賃表 (fare chart): route diagram on white with fare figures
    rect(14.35, 0.16, 2.9, 1.2, '#fbfbf8'); rect(14.35, 1.2, 2.9, 0.16, '#1d8f3e'); text('きっぷ運賃表  Fares', 15.8, 1.28, 0.11, '#ffffff', '800', L.FONT_JP, 2.7);
    ctx.strokeStyle = '#8fc31f'; ctx.lineWidth = 5; ctx.beginPath(); ctx.ellipse(X(15.8), Y(0.66), 1.0 * MX, 0.36 * MY, 0, 0, 6.3); ctx.stroke();
    ctx.strokeStyle = '#00ac9a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(X(14.6), Y(0.3)); ctx.lineTo(X(17.0), Y(1.05)); ctx.stroke();
    ctx.strokeStyle = '#e8762a'; ctx.beginPath(); ctx.moveTo(X(14.5), Y(0.9)); ctx.lineTo(X(17.1), Y(0.5)); ctx.stroke();
    for (let k = 0; k < 18; k++) { const a = k / 18 * 6.283; text(String(150 + (k % 6) * 30), 15.8 + Math.cos(a) * 1.0, 0.66 + Math.sin(a) * 0.36, 0.07, '#222222', '700', L.FONT_LATIN); }
  }
  return c;
}
/** IC ticket gates in a row along x (gate line at z, passengers walk along ±z): cabinets every `pitch`, flaps. */
function gatesAlongX(batch, z, xa, xb, pitch = 0.9, depth = 1.3) {
  if (!gateMat) { gateMat = L.std({ vertexColors: true, roughness: 0.45, metalness: 0.2, emissive: 0x000000 }); gateMat.name = 'lm_icGate'; }
  const col = (g, hex) => { const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
  let k = 0;
  for (let x = xa; x <= xb + 1e-6; x += pitch, k++) {
    batch.add(gateMat, col(L.boxAt(x, 0.15 + 0.5, z, 0.22, 1.0, depth, 0, false), 0xc4c8cc), x, z);
    batch.add(gateMat, col(L.boxAt(x, 0.15 + 1.02, z, 0.24, 0.05, depth + 0.02, 0, false), k < 9 ? 0x1d8f3e : 0x2b6bd6), x, z);   // entry lanes green, exit lanes blue
    batch.add(gateMat, col(L.boxAt(x, 0.15 + 1.06, z - depth / 2 + 0.25, 0.18, 0.03, 0.26, 0, false), 0x2b6bd6), x, z);             // IC reader
    batch.add(gateMat, col(L.boxAt(x, 0.15 + 0.85, z - depth / 2 + 0.05, 0.2, 0.16, 0.04, 0, false), 0x101418), x, z);            // display
    if (x + pitch <= xb + 1e-6) for (const sg of [-1, 1]) batch.add(gateMat, col(L.boxAt(x + pitch / 2 + sg * 0.17, 0.15 + 0.62, z + 0.1, 0.3, 0.36, 0.05, 0, false), 0xe8742a), x, z);   // flaps
  }
}

export function build({ key, data, batch, inst, group, rng, world, pools, engine, CITY }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos;
  const [W, H, D] = data.size;
  const x0 = px - W / 2, x1 = px + W / 2, z0 = pz - D / 2, z1 = pz + D / 2;   // 40..84, 12..124
  const colliders = [], facades = [];
  const gx = x0 + 12;                                                       // west building x 40..52
  const zw = WEST_N;                                                        // west building north face
  const gate = data.hachikoExit, gz0 = Math.max(gate.pos[1] - 8, zw + 0.8), gz1 = gate.pos[1] + 8;   // ハチ公口 mouth z 16.4..30
  const lighting = engine && engine.get ? engine.get('lighting') : null;
  const fixture = (x, y, z, color, intensity, distance) => { if (lighting && lighting.addFixture) lighting.addFixture({ pos: [x, y, z], color, intensity, distance, kind: 'station' }); };
  if (CITY) (CITY.propFree || (CITY.propFree = [])).push([[x0, PAS.z0], [x1 + 0.5, PAS.z0], [x1 + 0.5, GATE.z1], [x0, GATE.z1]]);   // no street dressing in the passage
  // ---- west building: 0–6.5 concourse level (glass in front of a 1.5 m deep lit recess), 6.5–18 concrete with windows
  const wb = [[x0, zw], [gx, zw], [gx, z1], [x0, z1]];
  const RD = 1.5;                                                             // concourse recess depth behind the glass
  S.prism(batch, M.concreteWin, wb, 6.5, H, { uvScale: 3.5 / 3.8 });
  // the concourse-level tile box, split at the ハチ公口 mouth (one box across it walled the passage off)
  for (const [za, zb] of [[zw, gz0], [gz1, z1]]) batch.add(M.tile, L.extrudePolygon([[x0 + RD, za], [gx, za], [gx, zb], [x0 + RD, zb]], -0.2, 6.5, { cap: false, uvScale: 0.5 }), px, pz);
  S.rings(batch, M.concrete, wb, 6.5, H - 0.5, 3.8, { out: 0.25, h: 0.3 });
  S.parapet(batch, M.concrete, wb, H, { h: 1.1, t: 0.4 });
  // glazed spans: painted concourse wall at the back of the recess, real floor + soffit + strip lights in front
  const spans = [[zw + 0.5, gz0 - 0.5], [gz1 + 0.5, gz1 + 26]].filter(([a, b]) => b - a > 1);
  const concourse = L.signMaterial(concourseCanvas(), { emissive: 0.5, roughness: 0.6 });
  let bay = 0;
  for (const [za, zb] of spans) {
    const cz = (za + zb) / 2, w = zb - za;
    for (let z = za; z < zb - 0.5; z += 19.2) {
      // strips in order (gate hall first, next to the exit); offsets are whole mullion pitches so painted columns
      // land on the real mullions. Slivers (< 3 m) take the kiosk strip and do not count as a bay.
      const len = Math.min(19.2, zb - z), strip = len < 3 ? 1 : (bay + 1) % 3, u0 = (bay % 2) * 6 * PITCH / 40;   // (kiosk + stairs strips: the gates moved into the passage in 2025)
      if (len >= 3) bay++;
      batch.add(concourse, L.wallQuad(x0 + RD, 0.15 + 2.5, z + len / 2, -1, 0, len, 5.0, 0.04, [u0, 1 - (strip + 1) / 3, u0 + len / 40, 1 - strip / 3]), px, pz);
      if (strip === 0 && len > 6) icGates(batch, x0 + 0.05, z + 1.1, z + len - 3.4, 1.2);   // bank of 15+ gates, the far end left to the ticket machines
    }
    batch.add(At.walls[1], L.boxAt(x0 + RD / 2, 0.1, cz, RD, 0.2, w, 0, true), px, pz);                                    // concourse floor
    batch.add(M.whiteMetal, L.boxAt(x0 + RD / 2, 5.75, cz, RD + 0.1, 1.5, w, 0, false), px, pz);                            // soffit / bulkhead
    for (let z = za + 1.6; z < zb; z += 3.2) S.ibox(inst, 'lm_stripLight', M.glowWhite, x0 + RD / 2, 4.92, z, 0.14, 0.06, 1.6);
    batch.add(M.glassClear, L.wallQuad(x0, 0.15 + 2.5, cz, -1, 0, w, 5.0, 0.14), px, pz);
    batch.add(M.darkMetal, L.boxAt(x0 - 0.1, 5.35, cz, 0.2, 0.4, w, 0, false), px, pz);                                  // head rail
    for (let z = za; z <= zb; z += 3.2) S.ibox(inst, 'lm_mullion', M.darkMetal, x0 - 0.1, 0.15, z, 0.3, 5.4, 0.16);
  }
  for (const [za, zb] of [[zw, Math.min(gz0, zw + 0.5)], [gz0 - 0.5, gz0], [gz1, gz1 + 0.5], [gz1 + 26, z1]]) if (zb - za > 0.05) batch.add(M.tile, L.boxAt(x0 + RD / 2, 3.15, (za + zb) / 2, RD, 6.7, zb - za, 0, true), px, pz);   // tile piers / solid wall
  const mosaic = L.signMaterial(mosaicCanvas(), { emissive: 0.35, roughness: 0.6 });
  const mm = new THREE.Mesh(new THREE.PlaneGeometry(12, 3.6), mosaic); L.placeFacing(mm, x0 - 0.08, 3.6, gz1 + 34, -1, 0); group.add(mm);
  batch.add(M.stoneLight, L.boxAt(x0 - 0.03, 0.9, gz1 + 34, 0.06, 1.8, 12.4, 0, false), px, pz);
  // ---- ハチ公口: the old gate recess (4.5 m deep, lit) is now the passage's west mouth, canopy + JP sign kept
  const rd = 4.5;
  for (const z of [gz0, gz1]) batch.add(M.tile, L.quad([x0, 0, z], [x0 + rd, 0, z], [x0 + rd, 6.5, z], [x0, 6.5, z], [0, 0, z === gz0 ? 1 : -1]), px, pz);
  batch.add(M.whiteMetal, L.boxAt(x0 + rd / 2, 6.4, (gz0 + gz1) / 2, rd, 0.2, gz1 - gz0, 0, false), px, pz);   // recess ceiling
  for (let k = 0; k < 3; k++) S.ibox(inst, 'lm_stripLight', M.glowWhite, x0 + 1 + k * 1.4, 6.2, (gz0 + gz1) / 2, 0.15, 0.08, gz1 - gz0 - 2);
  // the recess back wall either side of the passage mouth
  for (const [za, zb] of [[gz0, PAS.z0], [PAS.z1, gz1]]) if (zb - za > 0.1) batch.add(M.tile, L.wallQuad(x0 + rd, 3.3, (za + zb) / 2, -1, 0, zb - za, 6.3, 0.01), px, pz);
  batch.add(M.tile, L.wallQuad(x0 + rd, (PAS.h + 6.5) / 2, (PAS.z0 + PAS.z1) / 2, -1, 0, PAS.z1 - PAS.z0, 6.5 - PAS.h, 0.01), px, pz);   // bulkhead over the mouth
  S.signQuad(batch, x0 + rd - 0.05, PAS.h + 0.55, (PAS.z0 + PAS.z1) / 2, -1, 0, { text: 'ハチ公改札 ・ 宮益坂口 ・ 東口', sub: 'Hachiko Gate  ・  Miyamasuzaka Exit  ・  East Exit  →', w: 7.4, h: 0.9, bg: '#1d8f3e', fg: '#ffffff', emissive: 0.58, weight: '800' });
  batch.add(M.silver, L.boxAt(x0 - 3.2, 6.9, (gz0 + gz1) / 2, 6.8, 0.5, gz1 - gz0 + 4, 0, false), px, pz);   // canopy
  for (const z of [gz0 - 1, gz1 + 1]) { S.ibox(inst, 'lm_post', M.silver, x0 - 6.2, 0.15, z, 0.4, 6.7, 0.4); colliders.push(S.boxCollider(x0 - 6.2, z, 0.5, 6.7, 0.5)); }
  for (let k = -2; k <= 2; k++) S.ibox(inst, 'lm_downlight', M.glowWarm, x0 - 3.2, 6.62, (gz0 + gz1) / 2 + k * 3.2, 0.5, 0.1, 0.5);
  S.flatSign(group, x0 - 0.35, 9.6, (gz0 + gz1) / 2, -1, 0, { text: 'JP 渋谷町駅', sub: 'ハチ公口  Hachiko Exit  ―  Shibuya-cho Station', w: 15, h: 2.4, bg: '#1d8f3e', fg: '#ffffff', emissive: 1.3, weight: '900' });
  S.flatSign(group, x0 - 0.35, 12.6, (gz0 + gz1) / 2 + 3, -1, 0, { text: '東京メトロ 銀座線 ・ 半蔵門線 ・ 副都心線', w: 9, h: 1.1, bg: '#f7f7f7', fg: '#f39c12', emissive: 1.0, weight: '700' });
  S.flatSign(group, x0 - 0.35, 12.6, (gz0 + gz1) / 2 - 5.5, -1, 0, { text: '東急東横線 ・ 田園都市線', w: 7, h: 1.1, bg: '#f7f7f7', fg: '#c8102e', emissive: 1.0, weight: '700' });
  S.flatSign(group, x0 - 6.0, 7.5, (gz0 + gz1) / 2, -1, 0, { text: 'ハチ公口', sub: 'Hachiko Exit', w: 5, h: 1.0, bg: '#ffffff', fg: '#111111', emissive: 1.1, weight: '700', double: true });
  // shops flanking the mouth at street level
  S.flatSign(group, x0 - 0.3, 5.6, gz1 + 5, -1, 0, { text: 'ポッポ', sub: '渋谷町駅ハチ公口店', w: 6, h: 1.2, bg: '#1c56b7', fg: '#ffffff', emissive: 1.3, weight: '800' });
  S.flatSign(group, x0 - 0.3, 5.6, gz1 + 13, -1, 0, { text: 'みどりの窓口', sub: 'JP Ticket Office', w: 6, h: 1.2, bg: '#0d8a4f', fg: '#ffffff', emissive: 1.2, weight: '700' });
  S.flatSign(group, x0 - 0.3, 5.6, gz1 + 21, -1, 0, { text: 'コインロッカー ・ トイレ →', w: 6, h: 1.0, bg: '#ffffff', fg: '#111111', emissive: 1.1, weight: '700' });
  // ---- south of the mosaic: the 東急 東横店 frontage — station shops under a lit canopy, the store name board above
  {
    const za = gz1 + 41, zb = z1 - 2;
    S.shopRow(batch, At, [x0, zb], [x0, za], -1, 0, ['東急フードショー', 'ポッポ', 'マツモトキヨヒ', 'STARBEANS COFFEE', '成城石丼', 'ドトルコーヒー', '東急百貨店', 'サンドラック'], { gf: 4.6, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 190, minW: 6, maxW: 8, lift: 0.05 });
    batch.add(M.silver, L.boxAt(x0 - 1.0, 4.75, (za + zb) / 2, 2.0, 0.3, zb - za, 0, false), px, pz);                  // canopy
    batch.add(M.whiteMetal, L.boxAt(x0 - 1.99, 4.75, (za + zb) / 2, 0.04, 0.34, zb - za, 0, false), px, pz);
    for (let z = za + 1.5; z < zb; z += 3) S.ibox(inst, 'lm_downlight', M.glowWarm, x0 - 1.0, 4.54, z, 0.4, 0.06, 0.4);
    S.flatSign(group, x0 - 0.3, 5.75, (za + zb) / 2, -1, 0, { text: '東急百貨店  東横店', sub: 'TOKYU DEPT. STORE  ―  渋谷町駅 西口', w: 18, h: 1.3, bg: '#15171c', fg: '#f2efe6', emissive: 1.1, weight: '800' });
    for (const z of [za + 4, zb - 4]) S.flatSign(group, x0 - 0.3, 5.75, z, -1, 0, { text: '東急フードショー', sub: 'FOOD SHOW  B1F', w: 6, h: 1.1, bg: '#1e7a58', fg: '#ffffff', emissive: 1.0, weight: '800' });
  }
  // ---- under-track block (x 52..84, up to the viaduct underside): the ガード下 shop strip on the narrow 宮益坂
  //      pavement, the 東西自由通路 behind it, the ハチ公改札 recess on the passage's south side, solid beyond
  const UH = 5.3, zA = northFace(gx), zB = northFace(x1);
  S.prism(batch, M.concrete, [[gx, zA], [x1, zB], [x1, PAS.z0], [gx, PAS.z0]], 0, UH, { uvScale: 0.5 });
  S.prism(batch, M.concrete, [[gx, PAS.z1], [GATE.x0, PAS.z1], [GATE.x0, GATE.z1], [GATE.x1, GATE.z1], [GATE.x1, PAS.z1], [x1, PAS.z1], [x1, z1], [gx, z1]], 0, UH, { uvScale: 0.5 });
  batch.add(M.concrete, L.boxAt((gx + x1) / 2 - rd / 2, (PAS.h + UH) / 2, (PAS.z0 + PAS.z1) / 2, x1 - gx + rd, UH - PAS.h, PAS.z1 - PAS.z0, 0, true), px, pz);   // slab over the passage
  {
    // the ガード下 eateries facing the pavement (OSM: カレー厨房, a cafe, 千代松, Kawakei — near-names)
    const types = { 'カレー厨房': 'ramen', 'ガード下カフェ': 'cafe', '千代竹 らーめん': 'ramen', '川啓 そば・うどん': 'ramen' };
    const tx = x1 - gx, tz = zB - zA, tl = Math.hypot(tx, tz), nx = tz / tl, nz = -tx / tl;
    S.shopRow(batch, At, [gx, zA], [x1, zB], nx, nz, Object.keys(types), { gf: 3.4, rng, pools, typeOf: (n) => types[n] || 'cafe', shopOf: SHOP_OF_TYPE, fi: 230, minW: 7, maxW: 8.5, lift: 0.05, depth: inst, roomDepth: 3.2 });
    batch.add(M.darkMetal, L.boxAt((gx + x1) / 2 + nx * 0.6, 3.45, (zA + zB) / 2 + nz * 0.6, tl, 0.12, 1.2, Math.atan2(-tz, tx), false), px, pz);   // shallow awning
    for (let t = 0.06; t < 1; t += 0.125) S.ibox(inst, 'lm_downlight', M.glowWarm, gx + tx * t + nx * 0.6, 3.38, zA + tz * t + nz * 0.6, 0.35, 0.05, 0.35);
    colliders.push(...L.edgeColliders([[gx, zA], [x1, zB], [x1, PAS.z0], [gx, PAS.z0]], UH, 1.0));
  }
  // ---- the passage: stone floor, tiled walls with posters, a lit ceiling, JR signs, the gate recess
  const pz0 = PAS.z0, pz1 = PAS.z1, pcx = (x0 + rd + x1 + 2) / 2, plen = x1 + 2 - (x0 + rd);
  batch.add(M.stoneLight, L.boxAt(pcx, 0.16, (pz0 + pz1) / 2, plen, 0.02, pz1 - pz0, 0, true), px, pz);
  batch.add(M.whiteMetal, L.boxAt((x0 + rd + x1) / 2, PAS.h + 0.05, (pz0 + pz1) / 2, x1 - x0 - rd, 0.1, pz1 - pz0, 0, false), px, pz);
  for (let x = x0 + rd + 1.2; x < x1 - 0.5; x += 2.4) for (const z of [pz0 + 2.2, pz1 - 2.2]) S.ibox(inst, 'lm_stripLight', M.glowWhite, x, PAS.h - 0.02, z, 1.6, 0.05, 0.16);
  for (const x of [x0 + rd + 4, 60, 71, 80]) fixture(x, PAS.h - 0.25, (pz0 + pz1) / 2, 0xf2f5ff, 16, 10);
  for (const [z, n] of [[pz0, 1], [pz1, -1]]) {
    const segs = n > 0 ? [[x0 + rd, x1]] : [[x0 + rd, GATE.x0], [GATE.x1, x1]];
    for (const [xa, xb] of segs) if (xb - xa > 0.2) batch.add(M.tile, L.wallQuad((xa + xb) / 2, (PAS.h + 0.15) / 2, z, 0, n, xb - xa, PAS.h - 0.15, 0.02), px, pz);
  }
  // posters / the station map / coin lockers on the north wall; ticket machines + きっぷうりば on the south wall
  for (const [x, t, sub, bg] of [[49, 'SHIBUYA46', '純愛 ― 9.28 ON SALE', '#c8102e'], [58.5, 'TOJO COLA', '爽快、東城。', '#1a2a4a'], [63, '構内図', 'Station Map', '#1d8f3e'], [79.5, 'STARBEANS', 'AUTUMN LATTE', '#0b3d2e']])
    S.signQuad(batch, x, 1.9, pz0 + 0.06, 0, 1, { text: t, sub, w: 1.4, h: 2.0, bg, fg: '#ffffff', emissive: 0.45, weight: '900' });
  for (let i = 0; i < 12; i++) for (let r = 0; r < 4; r++) batch.add(r === 3 && i % 5 === 2 ? M.darkMetal : M.silver, L.boxAt(67.4 + i * 0.46, 0.45 + r * 0.5, pz0 + 0.32, 0.42, 0.46, 0.6, 0, false), px, pz);   // コインロッカー
  S.signQuad(batch, 70, 2.5, pz0 + 0.64, 0, 1, { text: 'コインロッカー', sub: 'Coin Lockers', w: 5.2, h: 0.36, bg: '#1a3a7a', fg: '#ffffff', emissive: 0.45, weight: '700' });
  colliders.push(S.boxCollider(70, pz0 + 0.35, 5.6, 2.2, 0.7));
  for (let i = 0; i < 5; i++) {
    const x = 57.4 + i * 1.3;
    batch.add(M.whiteMetal, L.boxAt(x, 0.15 + 0.9, pz1 - 0.32, 1.1, 1.8, 0.6, 0, false), px, pz);
    batch.add(M.interior, L.wallQuad(x, 1.25, pz1 - 0.63, 0, -1, 0.8, 0.55, 0.01), px, pz);
    batch.add(M.darkMetal, L.boxAt(x, 0.95, pz1 - 0.7, 0.9, 0.06, 0.2, 0, false), px, pz);
  }
  colliders.push(S.boxCollider(60, pz1 - 0.32, 6.8, 1.9, 0.7));
  S.signQuad(batch, 60, 2.45, pz1 - 0.05, 0, -1, { text: 'きっぷうりば', sub: 'Tickets  ・  Suica チャージ', w: 6.4, h: 0.55, bg: '#2b6bd6', fg: '#ffffff', emissive: 0.5, weight: '800' });
  // hanging exit signs across the passage (yellow = exits, green = JR gate)
  for (const [x, t, sub, bg, fg, nx] of [[52, '宮益坂口 ・ 東口バスターミナル →', 'Miyamasuzaka Exit  ・  East Exit', '#ffd400', '#111111', -1], [76, '← ハチ公口 ・ ハチ公前広場', 'Hachiko Exit', '#ffd400', '#111111', 1]])
    S.signQuad(batch, x, PAS.h - 0.55, (pz0 + pz1) / 2, nx, 0, { text: t, sub, w: 5.6, h: 0.72, bg, fg, emissive: 0.34, weight: '800', double: true });
  // gate recess: header band (name board, 発車標, 運賃表) over the gate line, the paid concourse beyond, the gates,
  // the attendant window at the west end and the wide gate + fence at the east end
  {
    const gm = L.signMaterial(gateCanvas2(), { emissive: 0.5, roughness: 0.55 }), gw = GATE.x1 - GATE.x0, gcx = (GATE.x0 + GATE.x1) / 2;
    batch.add(gm, L.wallQuad(gcx, 0.15 + (GATE.h - 0.15) / 2, GATE.z1, 0, -1, gw, GATE.h - 0.15, 0.02, [0, 1 / 3, 1, 1]), px, pz);
    batch.add(gm, L.wallQuad(gcx, GATE.h + 0.3, pz1, 0, -1, gw, 1.2, 0.03, [0, 0, 1, 1 / 3]), px, pz);
    batch.add(M.whiteMetal, L.boxAt(gcx, GATE.h + 0.05, (pz1 + GATE.z1) / 2, gw, 0.1, GATE.z1 - pz1, 0, false), px, pz);
    for (let x = GATE.x0 + 1; x < GATE.x1; x += 2.2) S.ibox(inst, 'lm_stripLight', M.glowWhite, x, GATE.h - 0.02, (pz1 + GATE.z1) / 2, 1.6, 0.05, 0.16);
    for (const x of [GATE.x0, GATE.x1]) batch.add(M.tile, L.wallQuad(x, (GATE.h + 0.15) / 2, (pz1 + GATE.z1) / 2, x === GATE.x0 ? 1 : -1, 0, GATE.z1 - pz1, GATE.h - 0.15, 0.02), px, pz);
    batch.add(M.stoneLight, L.boxAt(gcx, 0.165, (pz1 + GATE.z1) / 2, gw, 0.02, GATE.z1 - pz1, 0, true), px, pz);
    fixture(gcx, GATE.h - 0.25, (pz1 + GATE.z1) / 2, 0xf4f6ff, 18, 9);
    const gz = pz1 + 1.0;
    gatesAlongX(batch, gz, GATE.x0 + 2.4, GATE.x0 + 2.4 + 14 * 0.9);                                             // 15 cabinets = 14 lanes
    // 有人改札 / のりこし精算 window: a glazed booth with a lit counter
    batch.add(M.whiteMetal, L.boxAt(GATE.x0 + 1.0, 0.15 + 0.55, gz, 1.8, 1.1, 1.6, 0, false), px, pz);
    batch.add(M.glassClear, L.boxAt(GATE.x0 + 1.0, 0.15 + 1.75, gz, 1.8, 1.3, 1.6, 0, false), px, pz);
    batch.add(M.interior, L.boxAt(GATE.x0 + 1.0, 0.15 + 1.75, gz + 0.1, 1.5, 1.1, 1.2, 0, false), px, pz);
    S.signQuad(batch, GATE.x0 + 1.0, 2.75, gz - 0.82, 0, -1, { text: '窓口', sub: 'のりこし精算 ・ Staff', w: 1.6, h: 0.42, bg: '#ffffff', fg: '#1d8f3e', emissive: 0.45, weight: '800' });
    for (const x of [GATE.x0 + 2.4 + 14 * 0.9 + 0.95, GATE.x1 - 0.4]) batch.add(M.silver, L.boxAt(x, 0.15 + 0.5, gz, 0.1, 1.0, 1.3, 0, false), px, pz);   // wide gate + fence post
    colliders.push(S.boxCollider(gcx, gz, gw, 1.4, 1.4));                                                         // the gate line (paid side closed)
    // the 宮益坂口 end of the header: 'JR線' pictogram board over the wide gate
    S.signQuad(batch, GATE.x1 - 1.0, GATE.h - 0.55, gz - 0.7, 0, -1, { text: 'JR線', sub: 'JR Lines', w: 1.6, h: 0.5, bg: '#1d8f3e', fg: '#ffffff', emissive: 0.5, weight: '900' });
  }
  // ---- 宮益坂口: the passage mouth on the east face, JP band sign over it, the tiled east face to the south
  {
    const mz = (pz0 + pz1) / 2;
    S.signQuad(batch, x1 + 0.06, PAS.h + 0.55, mz, 1, 0, { text: 'JP 渋谷町駅  宮益坂口', sub: 'Miyamasuzaka Exit  ・  ハチ公改札 Hachiko Gate', w: 8.2, h: 0.95, bg: '#1d8f3e', fg: '#ffffff', emissive: 0.32, weight: '900' });
    batch.add(M.jrGreen, L.boxAt(x1 + 0.1, UH - 0.2, (zB + 44) / 2, 0.08, 0.3, 44 - zB, 0, false), px, pz);            // green band along the east face
    batch.add(M.tile, L.wallQuad(x1, 2.2, (pz1 + 44) / 2, 1, 0, 44 - pz1, 4.1, 0.02), px, pz);
    for (const [z, t, sub] of [[30, '東口バスターミナル ・ 銀座線', 'East Exit Bus Terminal  →'], [37.5, '東京メトロ 半蔵門線 ・ 副都心線', 'B7 東口地下広場  →']])
      S.signQuad(batch, x1 + 0.05, 2.9, z, 1, 0, { text: t, sub, w: 5.4, h: 0.8, bg: '#ffd400', fg: '#111111', emissive: 0.45, weight: '800' });
    S.signQuad(batch, x1 + 0.05, 1.5, 41.2, 1, 0, { text: '渋谷町駅 周辺案内図', sub: 'Area Map', w: 2.2, h: 1.6, bg: '#e8e4dc', fg: '#1d4a2a', emissive: 0.8, weight: '800' });
    for (let k = 0; k < 4; k++) S.ibox(inst, 'lm_downlight', M.glowWhite, x1 + 0.6, PAS.h - 0.1, pz0 + 1 + k * 2, 0.4, 0.06, 0.4);
    fixture(x1 + 1.5, 3.8, mz, 0xf2f5ff, 22, 10);
  }
  // ---- the south concourse under the tracks (JR 1F 南改札) and its 東口 (pass 12). South of the 東口 terminal the
  //      ground under the viaduct was open floor from the station's east face to Scramble Square; in reality it is the
  //      station itself (OSM building 904652357): the 1F 南改札 concourse with the 東口 opening east onto the little
  //      square in front of Scramble Square's 1F entrance, the escalators down to the subway gates straight ahead
  //      (「東口を出て正面には地下鉄の改札へと続くエスカレーター、右側には渋谷スクランブルスクエアの1F入口」)
  if (CITY) {
    const SB = CITY.stationSouth;
    if (SB) {
      const blk = SB.polygon, A = SB.opening[0], B = SB.opening[1], DEP = 7, HH = 5.3;
      const ow = Math.hypot(B[0] - A[0], B[1] - A[1]), dx = (B[0] - A[0]) / ow, dz = (B[1] - A[1]) / ow;
      let ix = -dz, iz = dx; { const mx = (A[0] + B[0]) / 2 + ix, mz = (A[1] + B[1]) / 2 + iz; if (!L.pointInPoly(mx, mz, blk)) { ix = -ix; iz = -iz; } }
      const A2 = [A[0] + ix * DEP, A[1] + iz * DEP], B2 = [B[0] + ix * DEP, B[1] + iz * DEP];
      // the outline with the recess notched in (walls + a solid fill in slices, walls also facing inward)
      const ai = blk.findIndex((p) => p[0] === A[0] && p[1] === A[1]);
      const ring = ai >= 0 ? [...blk.slice(0, ai + 1), A2, B2, ...blk.slice(ai + 1)] : blk;
      S.prism(batch, M.concrete, ring, 0, HH, { uvScale: 0.5 });
      batch.add(M.concrete, L.flipGeo(L.extrudePolygon(ring, 0, HH, { cap: false, uvScale: 0.5 })), A[0], A[1]);
      batch.add(M.tile, L.extrudePolygon(ring, 0.15, 3.9, { cap: false, uvScale: 0.5 }), A[0], A[1]);
      colliders.push(...L.edgeColliders(ring, HH, 1.6));
      // solid all through: 3 m scan-line slices of the outline (nothing walkable inside the block)
      { const b = L.polyBounds(ring);
        for (let z = b.z0 + 1.5; z < b.z1; z += 3) {
          const xs = [];
          for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; if ((p[1] > z) !== (q[1] > z)) xs.push(p[0] + (q[0] - p[0]) * (z - p[1]) / (q[1] - p[1])); }
          xs.sort((u, v) => u - v);
          for (let k = 0; k + 1 < xs.length; k += 2) { const w = xs[k + 1] - xs[k] - 0.8; if (w > 0.5) colliders.push(S.boxCollider((xs[k] + xs[k + 1]) / 2, z, w, HH, 3.05)); }
        } }
      // the JR green band + tiled face along the square
      const tl = Math.hypot(B[0] - A[0], B[1] - A[1]);
      // recess: floor, ceiling, side walls, the gate line, header band, paid concourse back wall
      const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2, r = Math.atan2(-dz, dx);
      batch.add(M.stoneLight, L.polygonCap([A, B, B2, A2], 0.17, 0.5), mx, mz);
      batch.add(M.whiteMetal, L.extrudePolygon([A, B, B2, A2], 3.85, 3.95, { cap: false, bottom: true, sides: false }), mx, mz);
      for (const [p, q] of [[A, A2], [B2, B]]) { const l = Math.hypot(q[0] - p[0], q[1] - p[1]), nx2 = (q[1] - p[1]) / l, nz2 = -(q[0] - p[0]) / l, cx = (p[0] + q[0]) / 2, cz = (p[1] + q[1]) / 2, [ox, oz] = L.pointInPoly(cx + nx2, cz + nz2, [A, B, B2, A2]) ? [nx2, nz2] : [-nx2, -nz2]; batch.add(M.tile, L.wallQuad(cx, 2.05, cz, ox, oz, l, 3.8, 0.02), mx, mz); }
      const gm = L.signMaterial(gateCanvas2('南改札', 'South Gate'), { emissive: 0.5, roughness: 0.55 });
      const bx = (A2[0] + B2[0]) / 2, bz = (A2[1] + B2[1]) / 2;
      batch.add(gm, L.wallQuad(bx, 0.15 + (3.75 - 0.15) / 2, bz, -ix, -iz, tl, 3.6, 0.02, [0, 1 / 3, 1, 1]), mx, mz);
      const gx0 = mx + ix * 3.2, gz0 = mz + iz * 3.2;
      batch.add(gm, L.wallQuad(gx0, 3.35, gz0, -ix, -iz, tl, 1.1, 0.03, [0, 0, 1, 1 / 3]), mx, mz);
      batch.add(M.whiteMetal, L.boxAt(gx0 + ix * 0.1, 3.35, gz0 + iz * 0.1, tl, 1.1, 0.2, r, false), mx, mz);
      if (!gateMat) { gateMat = L.std({ vertexColors: true, roughness: 0.45, metalness: 0.2, emissive: 0x000000 }); gateMat.name = 'lm_icGate'; }
      const col = (g, hex) => { const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
      const rg = Math.atan2(-iz, ix);                                                     // cabinet long axis along the walk
      for (let t = 1.6, k = 0; t <= tl - 1.2; t += 0.9, k++) {
        const x = A[0] + dx * t + ix * 3.2, z = A[1] + dz * t + iz * 3.2;
        batch.add(gateMat, col(L.boxAt(x, 0.65, z, 1.3, 1.0, 0.22, rg, false), 0xc4c8cc), x, z);
        batch.add(gateMat, col(L.boxAt(x, 1.17, z, 1.32, 0.05, 0.24, rg, false), k % 3 === 2 ? 0x2b6bd6 : 0x1d8f3e), x, z);
      }
      colliders.push(S.boxCollider(gx0, gz0, tl, 1.4, 1.4, r));
      for (let t = 1.0; t < tl; t += 2.2) S.ibox(inst, 'lm_stripLight', M.glowWhite, A[0] + dx * t + ix * 1.6, 3.8, A[1] + dz * t + iz * 1.6, 0.16, 0.05, 1.6, r);
      const lighting = engine && engine.get ? engine.get('lighting') : null;
      if (lighting && lighting.addFixture) lighting.addFixture({ pos: [mx + ix * 2, 3.5, mz + iz * 2], color: 0xf4f6ff, intensity: 22, distance: 11, kind: 'station' });
      (CITY.propFree || (CITY.propFree = [])).push([A, B, B2, A2]);
      // the 東口 sign over the opening and the JR band
      S.signQuad(batch, mx - ix * 0.08, HH - 0.55, mz - iz * 0.08, -ix, -iz, { text: 'JP 渋谷町駅  東口', sub: '南改札 South Gate  ・  山手線 ・ 埼京線 ・ 湘南新宿ライン', w: Math.min(tl, 9), h: 0.95, bg: '#1d8f3e', fg: '#ffffff', emissive: 0.4, weight: '900' });
      // the subway escalators in front (CITY.groundHoles 'higashiguchi'), with their board
      const hole = (CITY.groundHoles || []).find((h) => h.id === 'higashiguchi');
      if (hole) {
        well(batch, inst, hole, colliders, { title: '東京メトロ 半蔵門線 ・ 副都心線  東急東横線 ・ 田園都市線', sub: '地下鉄のりば  B2F  Subway Lines ↓', escalators: true });
        const hx = (hole.x0 + hole.x1) / 2;
        S.signQuad(batch, hx, 2.6, hole.z0 - 0.05, 0, -1, { text: '地下鉄 のりかえ ↓', sub: 'Metro ・ Tokyu Lines', w: 4.2, h: 0.6, bg: '#ffd400', fg: '#111111', emissive: 0.4, weight: '800', double: true });
        batch.add(M.darkMetal, L.boxAt(hx - 2.2, 1.35, hole.z0 - 0.1, 0.08, 2.4, 0.08, 0, false), hx, hole.z0);
        batch.add(M.darkMetal, L.boxAt(hx + 2.2, 1.35, hole.z0 - 0.1, 0.08, 2.4, 0.08, 0, false), hx, hole.z0);
      }
    }
  }
  // ---- roof plant on the west building
  S.roofPlant(batch, inst, wb, H, { seed: 71, tanks: 2, ac: 8, ducts: 3, inset: 1.5 });
  inst.add('antenna', At.geos.antenna, At.metal, px - 14, H, pz + 40, 0);
  // ---- colliders
  colliders.push(S.boxCollider((x0 + gx) / 2, (zw + gz0) / 2, gx - x0, H, gz0 - zw));
  colliders.push(S.boxCollider((x0 + gx) / 2, (gz1 + z1) / 2, gx - x0, H, z1 - gz1));
  colliders.push(S.boxCollider(x0 + rd + (gx - x0 - rd) / 2, (gz0 + PAS.z0) / 2, gx - x0 - rd, H, PAS.z0 - gz0));   // either side of the passage mouth
  colliders.push(S.boxCollider(x0 + rd + (gx - x0 - rd) / 2, (PAS.z1 + gz1) / 2, gx - x0 - rd, H, gz1 - PAS.z1));
  colliders.push(S.boxCollider((gx + GATE.x0) / 2, (PAS.z1 + z1) / 2, GATE.x0 - gx, UH, z1 - PAS.z1));              // south block around the gate recess
  colliders.push(S.boxCollider((GATE.x1 + x1) / 2, (PAS.z1 + z1) / 2, x1 - GATE.x1, UH, z1 - PAS.z1));
  colliders.push(S.boxCollider((GATE.x0 + GATE.x1) / 2, (GATE.z1 + z1) / 2, GATE.x1 - GATE.x0, UH, z1 - GATE.z1));
  facades.push(...S.facadeRecords(key, wb, H, 3, { tenants: ['JP 渋谷町駅'], gf: 6.5 }));
  const lv = (x, y, z) => new THREE.Vector3(x - px, y, z - pz);
  const anchors = { sign: lv(x0 - 0.5, 9.6, (gz0 + gz1) / 2), signNormal: new THREE.Vector3(-1, 0, 0), gate: lv(x0, 0, (gz0 + gz1) / 2), gateNormal: new THREE.Vector3(-1, 0, 0), gateWidth: gz1 - gz0, mosaic: lv(x0 - 0.1, 3.6, gz1 + 34), passage: lv(x1, 0, (PAS.z0 + PAS.z1) / 2) };
  void world; void gateCanvas;
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
