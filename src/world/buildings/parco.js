// [city] 渋谷PALCO (2019 rebuild) — 19-storey dark glass-and-metal block at the top of 公園通り: three stepped
// volumes, the spiralling 立体街路 terraces (lit balustrades climbing around the building), rooftop park with
// railing, big "PALCO" lettering on the 公園通り face, shopfronts at street level.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE } from './genericBuilding.js';

export const KEYS = ['parco'];
export const SIZE = { w: 85, d: 38, h: 100 };

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos;
  const poly = L.ensureCW(data.polygon);
  const H = data.size[1], GF = 6, SH = 4.8;
  const c = L.polyCentroid(poly);
  const colliders = L.edgeColliders(poly, 42), facades = [];
  // stepped volumes
  const vols = [[poly, -0.2, 42], [L.offsetPolygon(poly, -2.2), 41.8, 72], [L.offsetPolygon(poly, -4.6), 71.8, H]];
  for (const [p, y0, y1] of vols) {
    S.prism(batch, M.glassDark, p, y0, y1, { uvScale: 3.5 / SH });
    S.rings(batch, M.darkMetal, p, Math.max(GF, y0 + 0.2), y1 - 0.5, SH, { out: 0.25, h: 0.3 });
    S.fins(inst, 'lm_finDark', M.darkMetal, p, Math.max(GF, y0), y1, 2.4, { w: 0.2, d: 0.45, out: 0.05 });
    S.parapet(batch, M.darkMetal, p, y1, { h: 1.2, t: 0.4 });
  }
  colliders.push(S.obbOf(vols[1][0], 72), S.obbOf(vols[2][0], H));
  // 立体街路: terrace slabs + lit glass balustrades stepping around the building, one face per level
  const n = poly.length;
  for (let k = 0; k < 14; k++) {
    const y = GF + 4 + k * SH;
    const vol = y < 42 ? vols[0][0] : y < 72 ? vols[1][0] : vols[2][0];
    const i = (k * 3) % vol.length;
    const a = vol[i], b = vol[(i + 1) % vol.length];
    const [nx, nz] = L.edgeNormal(vol, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 10) continue;
    const rot = L.rotYOf(b[0] - a[0], b[1] - a[1]);
    const mx = (a[0] + b[0]) / 2 + nx * 1.1, mz = (a[1] + b[1]) / 2 + nz * 1.1;
    batch.add(M.darkMetal, L.boxAt(mx, y, mz, len - 2, 0.3, 2.2, rot, false), c[0], c[1]);
    batch.add(M.glassClear, L.boxAt(mx + nx * 1.0, y + 0.75, mz + nz * 1.0, len - 2, 1.2, 0.08, rot, false), c[0], c[1]);
    S.glowBar(batch, M.glowWarm, mx + nx * 0.95, y + 0.2, mz + nz * 0.95, len - 2.4, 0.06, 0.06, rot);
    for (const p of L.alongPolyline([[a[0] + nx * 1.2, a[1] + nz * 1.2], [b[0] + nx * 1.2, b[1] + nz * 1.2]], 5, 3)) inst.add('hedge', S.HEDGE_GEO, M.hedge, p.x - nx * 0.6, y + 0.45, p.z - nz * 0.6, 0, 1.0, 0.7, 1.0);
  }
  void n;
  // street level
  const tenants = ['渋谷PALCO', 'PALCO', 'ニンテンドウ TOKYO', 'ポケモンセンタ', 'ジャンプショプ', 'STARBEANS COFFEE', 'カプコンストア'];
  let ti = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const [nx, nz] = L.edgeNormal(poly, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 5) continue;
    if (!isStreetSide((a[0] + b[0]) / 2 + nx * 4, (a[1] + b[1]) / 2 + nz * 4)) continue;
    const k = Math.max(1, Math.round(len / 9));
    const list = []; for (let j = 0; j < k; j++) list.push(tenants[(ti + j) % tenants.length]); ti += k;
    S.shopRow(batch, At, a, b, nx, nz, list, { gf: GF, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 260 + i, minW: 8, maxW: 12 });
  }
  // PALCO lettering on the 公園通り (south-east) face and the south face
  const se = L.bestEdge(poly, 0.55, 0.83);
  if (se) S.flatSign(group, se.mid[0] + se.nx * 0.55, 60, se.mid[1] + se.nz * 0.55, se.nx, se.nz, { text: 'PALCO', w: Math.min(se.len - 4, 28), h: 6.5, bg: '#101010', fg: '#ffffff', emissive: 1.5, weight: '900', letterSpacing: 16 });
  const s = L.bestEdge(poly, 0, 1);
  if (s && s !== se) S.flatSign(group, s.mid[0] + s.nx * 0.55, 30, s.mid[1] + s.nz * 0.55, s.nx, s.nz, { text: '渋谷PALCO', sub: 'SHIBUYA PALCO  ―  B1F–10F SHOPS / 11F–19F OFFICES', w: Math.min(s.len - 4, 24), h: 3.2, bg: '#101010', fg: '#ffffff', emissive: 1.3, weight: '800' });
  // rooftop park on the top volume + crown
  const top = vols[2][0];
  batch.add(M.lawn, L.polygonCap(L.offsetPolygon(top, -1.2), H + 0.08, 0.25), c[0], c[1]);
  S.parapet(batch, M.glassClear, top, H, { h: 1.3, t: 0.08, out: -0.2 });
  for (const p of L.alongPolyline(L.offsetPolygon(top, -2.5), 9, 4)) { S.ibox(inst, 'lm_decklight', M.glowWarm, p.x, H, p.z, 0.14, 3.6, 0.14); inst.add('hedge', S.HEDGE_GEO, M.hedge, p.x + 1.5, H + 1.6, p.z, 0, 2.4, 2.4, 2.4); }
  S.prism(batch, M.darkMetal, L.rectPoly(c[0], c[1], 14, 10, 0), H, H + 5, {});
  inst.add('antenna', At.geos.antenna, At.metal, c[0] + 5, H + 5, c[1], 0);
  facades.push(...S.facadeRecords(key, poly, 42, 8, { tenants: ['渋谷PALCO'], isStreetSide, gf: GF }));
  const anchors = { sign: se ? new THREE.Vector3(se.mid[0] - px, 60, se.mid[1] - pz) : new THREE.Vector3(0, 60, 0), signNormal: se ? new THREE.Vector3(se.nx, 0, se.nz) : new THREE.Vector3(0.6, 0, 0.8) };
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
