// [city] 渋谷フクラス (東急プラザ渋谷) — 18-storey dark metal-lattice tower at the south-west end of 駅前通り with the
// airport-bus terminal bays under a canopy on the south face and 東急プラザ signage.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE } from './genericBuilding.js';

export const KEYS = ['fukuras'];

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide, field }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos, rot = data.rotY || 0;
  const [W, H, D] = data.size;
  const p = L.rectPoly(px, pz, W, D, rot);
  const SH = 5.6, GF = 6;
  const colliders = [S.obbOf(p, H)], facades = [];
  S.prism(batch, M.darkGrid, p, -0.2, H, { uvScale: 3.5 / SH });
  // lattice: dark horizontal rings each floor + vertical fins every 4 m, standing 0.8 m proud of the glass
  S.rings(batch, M.darkMetal, p, GF, H - 0.5, SH, { out: 0.8, h: 0.4 });
  S.fins(inst, 'lm_finDark', M.darkMetal, p, GF, H, 4.0, { w: 0.4, d: 0.8, out: 0.05 });
  S.parapet(batch, M.darkMetal, p, H, { h: 1.6, t: 0.5, out: 0.6 });
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4];
    const [nx, nz] = L.edgeNormal(p, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    batch.add(M.glowWhite, L.boxAt((a[0] + b[0]) / 2 + nx * 0.62, H + 1.65, (a[1] + b[1]) / 2 + nz * 0.62, len, 0.12, 0.14, L.rotYOf(b[0] - a[0], b[1] - a[1]), false), px, pz);
    const street = isStreetSide((a[0] + b[0]) / 2 + nx * 5, (a[1] + b[1]) / 2 + nz * 5);
    if (nz > 0.5) {
      // bus terminal: deep canopy with bay numbers (no post on the 246 carriageway: the canopy cantilevers there)
      const mx = (a[0] + b[0]) / 2 + nx * 4, mz = (a[1] + b[1]) / 2 + nz * 4;
      batch.add(M.silver, L.boxAt(mx, GF + 0.2, mz, len - 4, 0.5, 8, L.rotYOf(b[0] - a[0], b[1] - a[1]), false), px, pz);
      for (let k = -3; k <= 3; k++) { const x = mx + (b[0] - a[0]) / len * k * 7, z = mz + (b[1] - a[1]) / len * k * 7; S.ibox(inst, 'lm_downlight', M.glowWarm, x, GF - 0.08, z, 0.6, 0.1, 0.6); if (k % 2 && !(field && field.sample(x + nx * 3.5, z + nz * 3.5) < 0.5)) { S.ibox(inst, 'lm_post', M.silver, x + nx * 3.5, 0.15, z + nz * 3.5, 0.35, GF, 0.35); colliders.push(S.boxCollider(x + nx * 3.5, z + nz * 3.5, 0.5, GF, 0.5)); } }
      S.flatSign(group, mx + nx * 4.1, GF + 0.2, mz + nz * 4.1, nx, nz, { text: '空港リムジンバス ・ 高速バス のりば', sub: 'AIRPORT LIMOUSINE / HIGHWAY BUS', w: 14, h: 0.5, bg: '#ffffff', fg: '#111111', emissive: 1.1, weight: '700' });
      batch.add(M.interior, L.wallQuad((a[0] + b[0]) / 2, GF / 2, (a[1] + b[1]) / 2, nx, nz, len - 2, GF - 0.4, 0.05), px, pz);
    } else if (street) S.shopRow(batch, At, a, b, nx, nz, ['東急プラザ', 'STARBEANS COFFEE', 'ドトルコーヒー', '無地良品'], { gf: GF, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 140 + i, minW: 9, maxW: 12 });
  }
  const n = L.bestEdge(p, 0, -1);
  S.flatSign(group, n.mid[0] + n.nx * 1.0, 24, n.mid[1] + n.nz * 1.0, n.nx, n.nz, { text: '東急プラザ 渋谷町', sub: 'TOKYU PLAZA  ―  SHIBUYA FUKURAS', w: 22, h: 3, bg: '#0e1116', fg: '#ffffff', emissive: 1.5, weight: '700' });
  const e = L.bestEdge(p, 1, 0);
  S.flatSign(group, e.mid[0] + e.nx * 1.0, H - 8, e.mid[1] + e.nz * 1.0, e.nx, e.nz, { text: 'FUKURAS', w: 16, h: 3.4, bg: '#0e1116', fg: '#ffffff', emissive: 1.6, weight: '900' });
  S.prism(batch, M.darkMetal, L.rectPoly(px, pz, 20, 12, rot), H, H + 4, {});
  S.roofPlant(batch, inst, p, H, { seed: 61, tanks: 2, ac: 6, ducts: 2, bulkhead: false, inset: 2 });
  inst.add('antenna', At.geos.antenna, At.metal, px + 3, H + 4, pz, 0);
  facades.push(...S.facadeRecords(key, p, H, 18, { tenants: ['東急プラザ'], isStreetSide, gf: GF }));
  return { group: new THREE.Group(), worldSpace: true, rotation: rot, colliders, lights: [], anchors: { sign: new THREE.Vector3(0, 24, -D / 2 - 1) }, facades };
}

export default { build, KEYS };
