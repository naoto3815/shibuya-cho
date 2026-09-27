// [city] ストリーム (渋谷ストリーム, 180 m, horizontal-fin glass) and サクラステージ (Sakura Stage, 180 m silhouette) —
// the two towers at the south edge. Both are rect footprints from cityData rotated by rotY.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases } from './genericBuilding.js';

export const KEYS = ['stream', 'sakuraStage'];

export function build({ key, data, batch, inst, group, rng }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos, rot = data.rotY || 0;
  const [W, H, D] = data.size;
  const rp = (w, d) => L.rectPoly(px, pz, w, d, rot);
  const colliders = [], facades = [];
  const SH = 4.3;
  if (key === 'stream') {
    const pod = data.fitted ? rp(W, D) : rp(W + 10, D + 8), PH = 26;
    S.prism(batch, M.panelWhite, pod, 0, PH, { uvScale: 3.5 / 5 });
    S.rings(batch, M.whiteMetal, pod, 5, PH - 0.5, 5, { out: 0.35, h: 0.4 });
    S.parapet(batch, M.whiteMetal, pod, PH, { h: 1, t: 0.4 });
    const p = data.fitted ? rp(W - 6, D - 6) : rp(W, D);
    S.prism(batch, M.glassStream, p, PH - 0.3, H, { uvScale: 3.5 / SH });
    S.rings(batch, M.whiteMetal, p, PH, H - 0.5, SH, { out: 0.6, h: 0.3 });         // strong horizontal fins
    S.parapet(batch, M.whiteMetal, p, H, { h: 1.2, t: 0.5, out: 0.4 });
    for (let i = 0; i < 4; i++) { const a = p[i], b = p[(i + 1) % 4]; const [nx, nz] = L.edgeNormal(p, i); const len = Math.hypot(b[0] - a[0], b[1] - a[1]); batch.add(M.glowWhite, L.boxAt((a[0] + b[0]) / 2 + nx * 0.45, H + 1.25, (a[1] + b[1]) / 2 + nz * 0.45, len, 0.12, 0.14, L.rotYOf(b[0] - a[0], b[1] - a[1]), false), px, pz); }
    S.prism(batch, M.silver, data.fitted ? rp(12, 14) : rp(16, 14), H, H + 5, { capMat: S.roofMat() });
    S.roofPlant(batch, inst, p, H, { seed: 31, tanks: 2, ac: 5, ducts: 2, bulkhead: false, inset: 2 });
    S.roofPlant(batch, inst, pod, PH, { seed: 32, tanks: 2, ac: 8, ducts: 2, inset: 2 });
    const w = L.bestEdge(p, -1, 0);
    S.flatSign(group, w.mid[0] + w.nx * 0.9, PH - 4, w.mid[1] + w.nz * 0.9, w.nx, w.nz, { text: 'ストリーム', sub: 'SHIBUYA-CHO STREAM', w: 20, h: 3, bg: '#f4f4f2', fg: '#1a3a8a', emissive: 1.2, weight: '600' });
    const n = L.bestEdge(p, 0, -1);
    S.flatSign(group, n.mid[0] + n.nx * 0.9, H - 8, n.mid[1] + n.nz * 0.9, n.nx, n.nz, { text: 'STREAM', w: 24, h: 4, bg: '#0e1116', fg: '#ffffff', emissive: 1.8, weight: '900' });
    colliders.push(S.obbOf(pod, PH), S.obbOf(p, H));
    facades.push(...S.facadeRecords(key, pod, PH, 6, { tenants: ['ストリーム', 'STARBEANS COFFEE'], gf: 5 }));
  } else {
    const p = rp(W, D);
    S.prism(batch, M.glassSakura, p, -0.3, H, { uvScale: 3.5 / SH });
    S.fins(inst, 'lm_finSilver', M.silver, p, 6, H, 3.4, { w: 0.25, d: 0.8 });
    S.rings(batch, M.darkMetal, p, 6, H - 0.5, SH * 2, { out: 0.15, h: 0.25 });
    S.parapet(batch, M.silver, p, H, { h: 1.5, t: 0.5, out: 0.4 });
    for (let i = 0; i < 4; i++) { const a = p[i], b = p[(i + 1) % 4]; const [nx, nz] = L.edgeNormal(p, i); const len = Math.hypot(b[0] - a[0], b[1] - a[1]); batch.add(M.glowWhite, L.boxAt((a[0] + b[0]) / 2 + nx * 0.45, H + 1.55, (a[1] + b[1]) / 2 + nz * 0.45, len, 0.12, 0.14, L.rotYOf(b[0] - a[0], b[1] - a[1]), false), px, pz); }
    S.prism(batch, M.silver, rp(Math.min(20, W - 6), Math.min(16, D - 6)), H, H + 6, { capMat: S.roofMat() });
    S.roofPlant(batch, inst, p, H, { seed: 33, tanks: 2, ac: 5, ducts: 2, bulkhead: false, inset: 2 });
    S.ibox(inst, 'lm_aviation', M.glowRed, px, H + 6, pz, 0.7, 0.7, 0.7);
    const n = L.bestEdge(p, 0, -1);
    S.flatSign(group, n.mid[0] + n.nx * 0.9, H - 10, n.mid[1] + n.nz * 0.9, n.nx, n.nz, { text: 'SAKURA STAGE', w: 26, h: 3.6, bg: '#0e1116', fg: '#ffb7c5', emissive: 1.6, weight: '900' });
    colliders.push(S.obbOf(p, H));
  }
  inst.add('antenna', At.geos.antenna, At.metal, px + 3, H + (key === 'stream' ? 5 : 6), pz + 2, 0);
  void rng;
  return { group: new THREE.Group(), worldSpace: true, rotation: rot, colliders, lights: [], anchors: {}, facades };
}

export default { build, KEYS };
