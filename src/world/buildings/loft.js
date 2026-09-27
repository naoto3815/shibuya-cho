// [city] LOFTY (渋谷ロフト) — 7-storey tan tile block on the north side of 井の頭通り: punched windows, storey
// ledges, yellow LOFTY band + vertical blade + 2F yellow stripe, corner entrance canopy, rooftop plant.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE } from './genericBuilding.js';

export const KEYS = ['loft'];
export const SIZE = { w: 30, d: 28, h: 38 };

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide }) {
  const M = S.mats(), At = getAtlases();
  const poly = L.ensureCW(data.polygon);
  const H = data.size[1], GF = 4.6, SH = (H - GF) / 6;
  const c = L.polyCentroid(poly);
  const colliders = L.edgeColliders(poly, H), facades = [];
  S.prism(batch, M.tileTan, poly, -0.2, H, { uvScale: 3.5 / SH });
  S.rings(batch, M.stoneLight, poly, GF, H - 0.5, SH, { out: 0.2, h: 0.3 });
  S.parapet(batch, M.stoneLight, poly, H, { h: 1.0, t: 0.35 });
  const tenants = ['LOFTY', 'LOFTY 文具', 'LOFTY コスメ', 'LOFTY 雑貨', 'STARBEANS COFFEE'];
  let ti = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const [nx, nz] = L.edgeNormal(poly, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 5) continue;
    const street = isStreetSide((a[0] + b[0]) / 2 + nx * 4, (a[1] + b[1]) / 2 + nz * 4);
    if (!street) { batch.add(At.trim, L.wallQuad((a[0] + b[0]) / 2, 1.2, (a[1] + b[1]) / 2, nx, nz, 1.2, 2.4, 0.04, [0, 0, 0.02, 0.02]), c[0], c[1]); continue; }
    const k = Math.max(1, Math.round(len / 8));
    const list = []; for (let j = 0; j < k; j++) list.push(tenants[(ti + j) % tenants.length]); ti += k;
    S.shopRow(batch, At, a, b, nx, nz, list, { gf: GF, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 200 + i, minW: 7, maxW: 10 });
    // 2F yellow stripe on every street face
    S.glowBar(batch, M.glowYellow, (a[0] + b[0]) / 2 + nx * 0.25, GF + 0.55, (a[1] + b[1]) / 2 + nz * 0.25, len - 0.6, 0.5, 0.2, L.rotYOf(b[0] - a[0], b[1] - a[1]));
  }
  // 井の頭通り (south) face: LOFTY band + canopy; vertical blade on the corner
  const s = L.bestEdge(poly, 0.1, 1);
  if (s) {
    const rot = L.rotYOf(s.tx, s.tz);
    S.flatSign(group, s.mid[0] + s.nx * 0.45, H - 4.2, s.mid[1] + s.nz * 0.45, s.nx, s.nz, { text: 'LOFTY', sub: '渋谷ロフト館  ―  LOFTY SHIBUYA-CHO', w: Math.min(s.len - 3, 18), h: 3.6, bg: '#ffe000', fg: '#111111', emissive: 1.5, weight: '900', letterSpacing: 10 });
    batch.add(M.darkMetal, L.boxAt(s.mid[0] + s.nx * 1.8, GF + 0.2, s.mid[1] + s.nz * 1.8, Math.min(s.len - 4, 14), 0.4, 3.4, rot, false), c[0], c[1]);
    for (let k = -1; k <= 1; k++) S.ibox(inst, 'lm_downlight', M.glowWarm, s.mid[0] + s.tx * k * 4 + s.nx * 1.8, GF - 0.02, s.mid[1] + s.tz * k * 4 + s.nz * 1.8, 0.5, 0.1, 0.5);
    const bx = s.b[0] - s.tx * 1.2, bz = s.b[1] - s.tz * 1.2;
    S.blade(batch, bx + s.nx * 1.0, 14, bz + s.nz * 1.0, s.tx, s.tz, { text: 'LOFTY', w: 1.4, h: 14, bg: '#ffe000', fg: '#111111', emissive: 1.2, weight: '900' });
    for (const y of [8, 14, 20]) batch.add(M.darkMetal, L.boxAt(bx + s.nx * 0.5, y, bz + s.nz * 0.5, 1.0, 0.12, 0.12, L.rotYOf(s.nx, s.nz), false), c[0], c[1]);
  }
  for (let k = 0; k < 3; k++) inst.add('acBig', At.geos.acBig, At.acMat, c[0] + (k - 1) * 7, H, c[1] + (k % 2 ? 4 : -4), k * 0.7, 1, 1, 1, 0xbcbcb8);
  inst.add('tank', At.geos.tank, At.tankMat, c[0] - 9, H, c[1] + 6, 0.3);
  inst.add('antenna', At.geos.antenna, At.metal, c[0] + 8, H, c[1] - 6, 0);
  batch.add(M.concrete, L.boxAt(c[0], H + 1.5, c[1] - 8, 6, 3, 4, 0, true), c[0], c[1]);
  facades.push(...S.facadeRecords(key, poly, H, 7, { tenants: ['LOFTY'], isStreetSide, gf: GF }));
  const anchors = { sign: s ? new THREE.Vector3(s.mid[0] - data.pos[0], H - 4.2, s.mid[1] - data.pos[1]) : new THREE.Vector3(0, H - 4, 0), signNormal: s ? new THREE.Vector3(s.nx, 0, s.nz) : new THREE.Vector3(0, 0, 1) };
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
