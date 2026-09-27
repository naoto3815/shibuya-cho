// [city] The ground under the JR viaduct north of 宮益坂 (client: 「高架下ってこんなにスペースが自由にあるっけ？」).
// North of the 宮益坂 ガード the 山手線 / 埼京線 tracks do not stand over an open hall: the space between the viaduct's
// portal frames is closed railway structure (JR equipment rooms, stores, the ハチ公口 bicycle park under the tracks at
// 宮下公園's south end), walled and shuttered along both sides, with a row of small ガード下 eateries facing the
// 宮益坂 pavement (OSM 2026: a cafe, a 豚骨 ramen counter and a teppan grill at x 56 / 64 / 73, z ≈ −9) and the only
// ways through being the 宮益坂 ガード itself and the 宮下通り underpass at z ≈ −100. The west lane of のんべい横丁 runs
// along the east wall. This builds those blocks (walls up to the deck soffit, shutters, service doors, louvres,
// notices, bracket lamps) with colliders, so the viaduct is walked around, not through.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, SHOP_OF_TYPE } from './genericBuilding.js';

// the closed stretches along the viaduct (z from south to north), and where the east face must stay clear of a lane
const SPANS = [
  { z0: -9.8, z1: -93.6, shops: true },        // 宮益坂 north pavement → 宮下通り's south pavement
  { z0: -106.2, z1: -221, shops: false },      // 宮下通り's north pavement → the map edge (MIYASHITA PARK side)
];
const LANE_E = { x: 76.6, z0: -8, z1: -78 };   // のんべい横丁 west lane (x 76.75–79.25) + its approach from 宮益坂

let wallMat = null;
/** 1024 × 512 atlas of wall panels: roller shutter, service door, louvre, notice board, fire-hose box. */
function panels() {
  if (wallMat) return wallMat;
  const W = 1024, H = 512, c = L.makeCanvas(W, H), g = c.getContext('2d');
  // [0] roller shutter (0..256): galvanised ribs, a bottom rail, grime
  { const x0 = 0; const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#8e9296'); gr.addColorStop(1, '#6a6e72'); g.fillStyle = gr; g.fillRect(x0, 0, 256, H);
    for (let y = 0; y < H; y += 9) { g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(x0, y, 256, 2); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x0, y + 3, 256, 1); }
    g.fillStyle = '#3a3c40'; g.fillRect(x0, H - 18, 256, 18); g.fillStyle = '#4a4c50'; g.fillRect(x0, 0, 256, 14);
    for (let k = 0; k < 14; k++) { g.fillStyle = `rgba(40,34,28,${0.05 + L.hash(k, 1, 91) * 0.1})`; g.fillRect(x0 + L.hash(k, 2, 91) * 240, H * 0.55 + L.hash(k, 3, 91) * H * 0.4, 6 + L.hash(k, 4, 91) * 30, 30 + L.hash(k, 5, 91) * 80); } }
  // [1] steel service door with the no-entry plate (256..512)
  { const x0 = 256; g.fillStyle = '#7b7f7c'; g.fillRect(x0, 0, 256, H); g.fillStyle = '#5c605d'; g.fillRect(x0 + 40, 60, 176, 440); g.fillStyle = '#6c706d'; g.fillRect(x0 + 48, 68, 160, 424);
    g.fillStyle = '#c8ccc8'; g.fillRect(x0 + 180, 270, 16, 40);
    g.fillStyle = '#f2f0ea'; g.fillRect(x0 + 70, 130, 116, 70); g.fillStyle = '#c8102e'; g.font = `800 17px ${L.FONT_JP}`; g.textAlign = 'center'; g.fillText('関係者以外', x0 + 128, 160); g.fillText('立入禁止', x0 + 128, 184);
    g.fillStyle = '#1d8f3e'; g.fillRect(x0 + 70, 206, 116, 14); g.fillStyle = '#ffffff'; g.font = `700 11px ${L.FONT_LATIN}`; g.fillText('JP EAST  渋谷町駅', x0 + 128, 217); }
  // [2] louvre vent over a concrete panel (512..768)
  { const x0 = 512; g.fillStyle = '#8a8780'; g.fillRect(x0, 0, 256, H); g.fillStyle = '#4a4c4e'; g.fillRect(x0 + 30, 40, 196, 180);
    for (let y = 48; y < 216; y += 12) { g.fillStyle = '#6e7174'; g.fillRect(x0 + 34, y, 188, 6); }
    g.fillStyle = 'rgba(0,0,0,0.18)'; for (let k = 0; k < 6; k++) g.fillRect(x0 + L.hash(k, 7, 92) * 250, 230, 3, 80 + L.hash(k, 8, 92) * 150); }
  // [3] notice board + fire-hose box (768..1024)
  { const x0 = 768; g.fillStyle = '#8a8780'; g.fillRect(x0, 0, 256, H); g.fillStyle = '#2a2c2e'; g.fillRect(x0 + 24, 110, 132, 150); g.fillStyle = '#e8e4d8'; g.fillRect(x0 + 30, 116, 120, 138);
    g.fillStyle = '#1d8f3e'; g.fillRect(x0 + 30, 116, 120, 20); g.fillStyle = '#fff'; g.font = `800 12px ${L.FONT_JP}`; g.textAlign = 'center'; g.fillText('お知らせ', x0 + 90, 131);
    g.fillStyle = '#444'; for (let k = 0; k < 8; k++) g.fillRect(x0 + 40, 146 + k * 12, 60 + L.hash(k, 9, 93) * 40, 4);
    g.fillStyle = '#b8201c'; g.fillRect(x0 + 176, 210, 64, 90); g.fillStyle = '#fff'; g.font = `800 14px ${L.FONT_JP}`; g.fillText('消火栓', x0 + 208, 262); }
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, H - 40, W, 40);                                            // splash grime along the foot
  wallMat = L.signMaterial(c, { emissive: 0.04, roughness: 0.8, metalness: 0.1 });
  wallMat.name = 'lm_underTrackPanels';
  return wallMat;
}
const PANEL_UV = (k) => [k / 4, 0, (k + 1) / 4, 1];

export function buildUnderTrack({ CITY, batch, inst, rng, pools, engine }) {
  const M = S.mats(), At = getAtlases(), P = panels(), colliders = [];
  const jr = CITY.rail && CITY.rail.jr; if (!jr) return { colliders };
  const Y = jr.elevation - 1.6 - 0.05;                                   // up to the deck soffit
  const half = jr.width / 2;
  const cxAt = (z) => {                                                  // viaduct centreline x at z (the path runs ~N–S)
    const p = jr.path;
    for (let i = 0; i < p.length - 1; i++) { const a = p[i], b = p[i + 1]; if ((z - a[1]) * (z - b[1]) <= 0 && a[1] !== b[1]) return a[0] + (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]); }
    return p[0][0];
  };
  const xW = (z) => cxAt(z) - half + 0.35;
  const xE = (z) => { const e = cxAt(z) + half - 0.35; return z <= LANE_E.z0 && z >= LANE_E.z1 ? Math.min(e, LANE_E.x) : e; };
  const lighting = engine && engine.get ? engine.get('lighting') : null;
  const fixture = (x, y, z) => { if (lighting && lighting.addFixture) lighting.addFixture({ pos: [x, y, z], color: 0xffe2b8, intensity: 10, distance: 8, kind: 'underTrack' }); };
  for (const sp of SPANS) {
    // outline sampled every 3 m (the lane offset makes the east face step in)
    const zs = []; for (let z = sp.z0; z > sp.z1; z -= 3) zs.push(z); zs.push(sp.z1);
    for (const zz of [LANE_E.z0, LANE_E.z1]) if (zz < sp.z0 && zz > sp.z1) { zs.push(zz + 0.01, zz - 0.01); }
    zs.sort((a, b) => b - a);
    const west = zs.map((z) => [xW(z), z]), east = zs.map((z) => [xE(z), z]);
    const poly = [...west, ...east.reverse()];
    S.prism(batch, M.concrete, poly, 0, Y, { uvScale: 0.5 });
    // the same walls facing inward: a camera that ends up inside the mass (a preset, a spring arm through the wall)
    // sees closed structure, never the old open floor under the deck
    batch.add(M.concrete, L.flipGeo(L.extrudePolygon(poly, 0, Y, { cap: false, uvScale: 0.5 })), (west[0][0] + east[0][0]) / 2, (sp.z0 + sp.z1) / 2);
    // plinth + a drip band under the soffit along both long faces
    for (const side of [west, [...east].reverse()]) for (let i = 0; i < side.length - 1; i++) {
      const a = side[i], b = side[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.5) continue;
      const r = Math.atan2(-(b[1] - a[1]), b[0] - a[0]), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      batch.add(M.darkMetal, L.boxAt(mx, 0.3, mz, len, 0.6, 0.06 + 2 * 0.02, r, false), mx, mz);
    }
    // solid all through (not edge walls round a hollow core): 6 m slices wall to wall
    for (let z = sp.z0; z > sp.z1 + 0.01; z -= 6) {
      const zb = Math.max(sp.z1, z - 6), zm = (z + zb) / 2, xa = Math.max(xW(z), xW(zb)), xb = Math.min(xE(z), xE(zb));
      colliders.push(S.boxCollider((xa + xb) / 2, zm, xb - xa, Y, z - zb + 0.2));
    }
    // wall features on both long faces every 4.5 m: shutter / door / louvre / notice, a bracket lamp every 18 m
    for (const [face, nx] of [[west, -1], [[...east].reverse(), 1]]) {
      const path = face.map(([x, z]) => [x + nx * 0.03, z]);
      let k = 0;
      for (const p of L.alongPolyline(path, 4.5, 2.2)) {
        if (sp.shops && p.z > sp.z0 - 9) continue;                        // the shop front owns the south end
        const kind = [0, 1, 2, 0, 3, 2, 0, 1][(k++ + (nx > 0 ? 3 : 0)) % 8];
        const w = kind === 0 ? 3.6 : 1.8, h = kind === 0 ? 3.1 : kind === 1 ? 2.4 : 2.2;
        batch.add(P, L.wallQuad(p.x + nx * 0.02, 0.15 + h / 2, p.z, nx, 0, w, h, 0.02, PANEL_UV(kind)), p.x, p.z);
        if (k % 4 === 0) { S.ibox(inst, 'lm_downlight', M.glowWarm, p.x + nx * 0.25, 3.3, p.z, 0.3, 0.12, 0.3); if (k % 8 === 0) fixture(p.x + nx * 0.8, 3.1, p.z); }
      }
    }
    // the south end on the 宮益坂 pavement: the ガード下 eateries (near-names) under a shallow awning
    if (sp.shops) {
      const a = [xW(sp.z0), sp.z0], b = [xE(sp.z0), sp.z0];
      const types = { 'CAFE SCRAMBLE': 'cafe', '東京豚骨BASE': 'ramen', 'ペパーランチ': 'fast' };
      S.shopRow(batch, At, a, b, 0, 1, Object.keys(types), { gf: 3.6, rng, pools, typeOf: (n) => types[n] || 'cafe', shopOf: SHOP_OF_TYPE, fi: 260, minW: 7.5, maxW: 8.5, lift: 0.05, depth: inst, roomDepth: 5 });
      const cx = (a[0] + b[0]) / 2, len = b[0] - a[0];
      batch.add(M.darkMetal, L.boxAt(cx, 3.7, sp.z0 + 0.6, len, 0.12, 1.2, 0, false), cx, sp.z0);
      for (let x = a[0] + 1.5; x < b[0]; x += 3) S.ibox(inst, 'lm_downlight', M.glowWarm, x, 3.62, sp.z0 + 0.6, 0.35, 0.05, 0.35);
      batch.add(M.jrGreen, L.boxAt(cx, Y - 0.25, sp.z0 + 0.04, len, 0.3, 0.06, 0, false), cx, sp.z0);          // JR band over the row
    }
    // the far (north) end of the first span faces 宮下通り: the ハチ公口 bicycle park's shutters and its sign
    if (sp.shops) {
      const zN = sp.z1, xa = xW(zN), xb = xE(zN), cx = (xa + xb) / 2;
      batch.add(P, L.wallQuad(cx - 5, 1.7, zN - 0.02, 0, -1, 7.2, 3.1, 0.02, PANEL_UV(0)), cx, zN);
      batch.add(P, L.wallQuad(cx + 5, 1.7, zN - 0.02, 0, -1, 7.2, 3.1, 0.02, PANEL_UV(0)), cx, zN);
      S.signQuad(batch, cx, 3.75, zN - 0.05, 0, -1, { text: 'ハチ公口自転車駐車場', sub: 'Bicycle Parking  ―  1時間無料', w: 5.2, h: 0.62, bg: '#1a3a7a', fg: '#ffffff', emissive: 0.35, weight: '800' });
    }
  }
  return { colliders };
}

export default { buildUnderTrack };
