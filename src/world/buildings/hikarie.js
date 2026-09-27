// [city] ヒカリエ — 182 m "stack of glass boxes" east of the tracks across 明治通り: 4-storey ShinQs podium with lit
// shopfronts, four offset glass volumes each with a lit rim at its top, crown bulkhead. Signage adds the ヒカリエ /
// ShinQs lettering relative to the landmark group.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE } from './genericBuilding.js';

export const KEYS = ['hikarie'];
export const SIZE = { w: 40, d: 60, h: 182 };

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos, rot = data.rotY || 0;
  const [W, H, D] = data.size;
  const rp = (w, d, ox = 0, oz = 0) => L.rectPoly(px + ox, pz + oz, w, d, rot);
  const colliders = [], facades = [];
  const SH = 4.2, PH = 20;
  // podium
  const pod = rp(W + 8, D + 6);
  S.prism(batch, M.panelWhite, pod, 0, PH, { uvScale: 3.5 / 5 });
  S.rings(batch, M.whiteMetal, pod, 5, PH - 0.5, 5, { out: 0.3, h: 0.35 });
  S.parapet(batch, M.whiteMetal, pod, PH, { h: 1.0, t: 0.35 });
  for (let i = 0; i < 4; i++) {
    const a = pod[i], b = pod[(i + 1) % 4];
    const [nx, nz] = L.edgeNormal(pod, i);
    if (isStreetSide((a[0] + b[0]) / 2 + nx * 5, (a[1] + b[1]) / 2 + nz * 5)) S.shopRow(batch, At, a, b, nx, nz, ['ShinQs', 'ヒカリエ', 'STARBEANS COFFEE', 'エクセルシオル', 'ZALA', 'ドトルコーヒー'], { gf: 5, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 120 + i, minW: 8, maxW: 11 });
  }
  colliders.push(S.obbOf(pod, PH));
  facades.push(...S.facadeRecords(key, pod, PH, 4, { tenants: ['ShinQs', 'ヒカリエ'], isStreetSide, gf: 5 }));
  // stacked volumes
  const boxes = [[PH, 64, W, D, 1.5, -1], [64, 104, W - 2, D - 2, -1.5, 1.5], [104, 144, W, D, 1, 1], [144, H, W - 4, D - 4, -1, -1.5]];
  for (const [y0, y1, w, d, ox, oz] of boxes) {
    const p = rp(w, d, ox, oz);
    S.prism(batch, M.glassHikarie, p, y0 - 0.3, y1, { uvScale: 3.5 / SH });
    S.rings(batch, M.whiteMetal, p, y0, y1 - 0.5, SH, { out: 0.1, h: 0.2 });
    S.fins(inst, 'lm_finWhite', M.whiteMetal, p, y0, y1, 4.0, { w: 0.2, d: 0.5, out: 0.05 });
    S.parapet(batch, M.whiteMetal, p, y1, { h: 0.8, t: 0.5, out: 0.3 });
    for (let i = 0; i < 4; i++) { const a = p[i], b = p[(i + 1) % 4]; const [nx, nz] = L.edgeNormal(p, i); const len = Math.hypot(b[0] - a[0], b[1] - a[1]); batch.add(M.glowWhite, L.boxAt((a[0] + b[0]) / 2 + nx * 0.35, y1 + 0.82, (a[1] + b[1]) / 2 + nz * 0.35, len, 0.12, 0.14, L.rotYOf(b[0] - a[0], b[1] - a[1]), false), px, pz); }
  }
  colliders.push(S.obbOf(rp(W + 3, D + 3), H));
  // crown
  const bulk = rp(18, 26, -1, -1.5);
  S.prism(batch, M.whiteMetal, bulk, H, H + 6, { uvScale: 1, capMat: S.roofMat() });
  S.roofPlant(batch, inst, pod, PH, { seed: 51, tanks: 2, ac: 8, ducts: 2, inset: 2 });
  inst.add('antenna', At.geos.antenna, At.metal, px + 4, H + 6, pz - 4, 0);
  S.ibox(inst, 'lm_aviation', M.glowRed, px - 1, H + 6, pz - 1.5, 0.7, 0.7, 0.7);
  const anchors = { sign: new THREE.Vector3(0, 56, -D / 2 - 0.3), signNormal: new THREE.Vector3(0, 0, -1) };
  return { group: new THREE.Group(), worldSpace: true, rotation: rot, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
