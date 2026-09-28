// [city] 渋谷マークシティ — 175 m grey-white 5-storey podium along the 井の頭線 south of 道玄坂 with the continuous
// glazed 2F "Mark City" walkway, the EAST (エクセルホテル東急, 100 m) and WEST (offices, 92 m) towers, the 銀座線
// portal on the east end, the 井の頭線 portal on the south face, and the glazed pedestrian bridge from the podium's
// east end over the bus terminal to the JR station.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE } from './genericBuilding.js';
import { BRIDGE, Y as DECK_Y } from './westDeck.js';

export const KEYS = ['markCity'];
export const SIZE = { w: 175, d: 45, h: 100 };

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide, CITY, world }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos, rot = data.rotY || 0;
  const poly = L.ensureCW(data.polygon);
  const PH = 22, GF = 5, SH = 4.25;
  const c = L.polyCentroid(poly);
  const colliders = L.edgeColliders(poly, PH), facades = [];
  // ---- podium: panel walls, 2F glazed walkway band, ledges, parapet
  S.prism(batch, M.panelGrey, poly, -0.2, PH, { uvScale: 3.5 / SH });
  batch.add(M.interiorDim, L.extrudePolygon(L.offsetPolygon(poly, -0.05), GF + 0.6, GF + 3.6, { cap: false, uvScale: 1 }), c[0], c[1]);
  batch.add(M.glassClear, L.extrudePolygon(L.offsetPolygon(poly, 0.3), GF + 0.5, GF + 3.7, { cap: false, uvScale: 1 }), c[0], c[1]);
  S.rings(batch, M.whiteMetal, poly, GF + 3.7, PH - 0.5, SH, { out: 0.35, h: 0.35 });
  S.rings(batch, M.whiteMetal, poly, GF, GF + 1, 10, { out: 0.35, h: 0.5 });
  S.parapet(batch, M.whiteMetal, poly, PH, { h: 1.2, t: 0.4 });
  for (const p of L.alongPolyline([...L.offsetPolygon(poly, 0.32), L.offsetPolygon(poly, 0.32)[0]], 3.2, 1)) S.ibox(inst, 'lm_mullion', M.darkMetal, p.x, GF + 0.5, p.z, 0.14, 3.2, 0.14, L.rotYOf(p.dx, p.dz));
  const tenants = ['渋谷マークシティ', '東急フードショー', 'STARBEANS COFFEE', '無地良品', 'ドトルコーヒー', '京王井の頭線 渋谷町駅', 'ポッポ', '成城石丼'];
  let ti = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const [nx, nz] = L.edgeNormal(poly, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 6) continue;
    if (!isStreetSide((a[0] + b[0]) / 2 + nx * 4, (a[1] + b[1]) / 2 + nz * 4)) continue;
    const k = Math.max(1, Math.round(len / 10));
    const list = []; for (let j = 0; j < k; j++) list.push(tenants[(ti + j) % tenants.length]); ti += k;
    S.shopRow(batch, At, a, b, nx, nz, list, { gf: GF, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 280 + i, minW: 8, maxW: 12 });
  }
  // ---- towers (EAST hotel / WEST offices) on the podium
  for (const [ti2, t] of (data.towers || []).entries()) {
    const [tx, tz] = t.pos, [W, TH, D] = t.size;
    const p = L.rectPoly(tx, tz, W, D, rot);
    S.prism(batch, ti2 === 0 ? M.glassTower3 : M.glassTower2, p, PH - 0.3, TH, { uvScale: 3.5 / 3.6 });   // hotel (warm, wide bays) / offices (cool)
    S.rings(batch, M.whiteMetal, p, PH, TH - 0.5, 3.6, { out: 0.18, h: 0.24 });
    S.fins(inst, 'lm_finWhite', M.whiteMetal, p, PH, TH, 3.2, { w: 0.22, d: 0.6, out: 0.05 });
    S.parapet(batch, M.whiteMetal, p, TH, { h: 1.4, t: 0.5, out: 0.3 });
    S.prism(batch, M.whiteMetal, L.rectPoly(tx, tz, W * 0.5, D * 0.5, rot), TH, TH + 4, { capMat: S.roofMat() });
    S.roofPlant(batch, inst, p, TH, { seed: 40 + ti2, tanks: 1, ac: 4, ducts: 1, bulkhead: false, inset: 1.5 });
    S.ibox(inst, 'lm_aviation', M.glowRed, tx, TH + 4, tz, 0.7, 0.7, 0.7);
    colliders.push(S.obbOf(p, TH));
    const face = L.bestEdge(p, 0, -1);
    S.flatSign(group, face.mid[0] + face.nx * 0.6, TH - 6, face.mid[1] + face.nz * 0.6, face.nx, face.nz, { text: ti2 === 0 ? 'エクセルホテル東急' : '渋谷マークシティ', sub: ti2 === 0 ? 'SHIBUYA EXCEL HOTEL TOKYU' : 'SHIBUYA MARK CITY WEST', w: Math.min(face.len - 4, 26), h: 3.2, bg: '#14161a', fg: '#e8e0c8', emissive: 1.4, weight: '700' });
  }
  // ---- 道玄坂 (north) face name band, 銀座線 portal on the east end, 井の頭線 portal on the south face
  const nf = L.bestEdge(poly, -0.3, -1);
  if (nf) S.flatSign(group, nf.mid[0] + nf.nx * 0.6, PH - 2.6, nf.mid[1] + nf.nz * 0.6, nf.nx, nf.nz, { text: '渋谷マークシティ', sub: 'SHIBUYA MARK CITY  ―  京王井の頭線 / 東京メトロ銀座線', w: Math.min(nf.len - 4, 30), h: 3.0, bg: '#14161a', fg: '#e8e0c8', emissive: 1.3, weight: '700' });
  const ef = L.bestEdge(poly, 1, 0);
  const ginza = CITY && CITY.rail && CITY.rail.ginza;
  if (ef && ginza) {
    const gy = ginza.elevation;
    const t = Math.max(3, Math.min(ef.len - 3, ((ginza.path[1][0] - ef.a[0]) * ef.tx + (ginza.path[1][1] - ef.a[1]) * ef.tz)));
    const x = ef.a[0] + ef.tx * t, z = ef.a[1] + ef.tz * t;
    batch.add(M.darkMetal, L.wallQuad(x, gy - 0.2, z, ef.nx, ef.nz, ginza.width + 1.5, 5.6, 0.08), c[0], c[1]);
    S.flatSign(group, x + ef.nx * 0.5, gy + 3.4, z + ef.nz * 0.5, ef.nx, ef.nz, { text: '東京メトロ 銀座線', sub: '渋谷町 ← → 表参道 ・ 浅草', w: 9, h: 1.3, bg: '#f7f7f7', fg: '#f39c12', emissive: 1.1, weight: '700' });
  }
  const sf = L.bestEdge(poly, 0.4, 0.9);
  if (sf) {
    const x = sf.mid[0] + sf.tx * Math.min(sf.len / 2 - 8, 6), z = sf.mid[1] + sf.tz * Math.min(sf.len / 2 - 8, 6);
    batch.add(M.darkMetal, L.wallQuad(x, 8.5, z, sf.nx, sf.nz, 12, 4.6, 0.08), c[0], c[1]);
    S.flatSign(group, x + sf.nx * 0.5, 11.4, z + sf.nz * 0.5, sf.nx, sf.nz, { text: '京王 井の頭線', sub: '渋谷町 → 下北沢 ・ 吉祥寺', w: 8, h: 1.2, bg: '#f7f7f7', fg: '#1a3a8a', emissive: 1.1, weight: '700' });
  }
  // ---- pedestrian bridge (2F) from the glazed concourse bridge's east end (westDeck.js, over the 西口 bus terminal)
  //      across the construction yard to the JR station
  const st = CITY && CITY.landmarks.station;
  if (ef && st) {
    const z = 77, x0 = ef.a[0] + ef.tx * ((z - ef.a[1]) / (ef.tz || 1e-6)) , x1 = st.pos[0] - st.size[0] / 2;
    void x0; const ax = BRIDGE.x1 - 0.3, len = x1 - ax, mx = (ax + x1) / 2;
    const y0 = DECK_Y.floor, bh = 3.4, bw = 5;
    // a see-through glazed tube: deck + roof, white spandrel panels to rail height, clear glass above on a 3.2 m
    // mullion grid, a lit ceiling (panel + cross strips every 1.6 m) and commuters inside
    batch.add(M.silver, L.boxAt(mx, y0 - 0.3, z, len, 0.6, bw + 0.4, 0, false), mx, z);
    batch.add(M.stoneLight, L.boxAt(mx, y0 + 0.02, z, len - 0.4, 0.04, bw - 0.2, 0, false), mx, z);
    batch.add(M.silver, L.boxAt(mx, y0 + bh + 0.2, z, len, 0.4, bw + 0.8, 0, false), mx, z);
    batch.add(M.interiorDim, L.boxAt(mx, y0 + bh - 0.03, z, len - 0.6, 0.04, bw - 0.4, 0, false), mx, z);
    for (let x = ax + 1.2; x < x1 - 0.8; x += 1.6) S.ibox(inst, 'lm_stripLight', M.glowWhite, x, y0 + bh - 0.1, z, 0.16, 0.05, bw - 1.2);
    for (const sg of [-1, 1]) {
      batch.add(M.whiteMetal, L.boxAt(mx, y0 + 0.5, z + sg * (bw / 2 - 0.05), len - 0.4, 1.0, 0.1, 0, false), mx, z);
      batch.add(M.glassClear, L.boxAt(mx, y0 + 1.0 + (bh - 1.0) / 2, z + sg * bw / 2, len - 0.5, bh - 1.0, 0.04, 0, false), mx, z);
      batch.add(M.darkMetal, L.boxAt(mx, y0 + 1.05, z + sg * (bw / 2 - 0.12), len - 0.4, 0.06, 0.06, 0, false), mx, z);   // handrail
    }
    for (let x = ax + 2; x < x1 - 1; x += 3.2) for (const sg of [-1, 1]) S.ibox(inst, 'lm_mullion', M.darkMetal, x, y0, z + sg * bw / 2, 0.14, bh, 0.14);
    for (let k = 0, x = ax + 3; x < x1 - 2; x += 2.3 + L.hash(k, 1, 66) * 4, k++) {                     // commuters (dark silhouettes)
      const pz = z + (L.hash(k, 2, 66) - 0.5) * (bw - 1.6), ph = 1.6 + L.hash(k, 3, 66) * 0.2;
      S.ibox(inst, 'lm_commuter', M.innerDark, x, y0 + 0.04, pz, 0.46, ph - 0.24, 0.3);
      S.ibox(inst, 'lm_commuter', M.innerDark, x, y0 + ph - 0.22, pz, 0.22, 0.24, 0.24);
    }
    for (const x of [ax + 14, x1 - 5]) {                                     // piers inside the yard
      batch.add(M.concrete, L.boxAt(x, (y0 - 0.6) / 2, z, 0.8, y0 - 0.6, 0.8, 0, true), x, z);
      colliders.push(S.boxCollider(x, z, 0.9, y0, 0.9));
    }
    S.flatSign(group, mx, y0 + bh + 0.9, z - bw / 2 - 0.45, 0, -1, { text: '渋谷マークシティ ⇄ JP 渋谷町駅', sub: 'MARK CITY WALKWAY  2F', w: 12, h: 1.0, bg: '#1b2748', fg: '#f2f2ee', emissive: 1.0, weight: '700', double: true });
  }
  // roof plant on the podium
  for (const p of L.alongPolyline(L.offsetPolygon(poly, -6), 26, 12)) inst.add('acBig', At.geos.acBig, At.acMat, p.x, PH, p.z, L.hash(p.x | 0, p.z | 0) * 3, 1, 1, 1, 0xbcbcb8);
  facades.push(...S.facadeRecords(key, poly, PH, 5, { tenants: ['渋谷マークシティ'], isStreetSide, gf: GF }));
  void world; void px; void pz;
  const anchors = { sign: nf ? new THREE.Vector3(nf.mid[0] - data.pos[0], PH - 2.6, nf.mid[1] - data.pos[1]) : new THREE.Vector3(0, 20, 0), signNormal: nf ? new THREE.Vector3(nf.nx, 0, nf.nz) : new THREE.Vector3(0, 0, -1) };
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
