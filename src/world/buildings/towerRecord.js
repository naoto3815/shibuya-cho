// [city] TOWER RECORD 渋谷 — 8-storey yellow box on 神宮通り: yellow punched-window façade, thin white ledges, huge red
// "TOWER RECORD" letters on the west face, red/yellow vertical blade, "NO MUSIC, NO LIFE." band, poster wall at
// street level, rooftop event-space box.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE } from './genericBuilding.js';

export const KEYS = ['towerRecord'];
export const SIZE = { w: 27, d: 30, h: 40 };

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos, rot = data.rotY || 0;
  const [W, H, D] = data.size;
  const poly = L.rectPoly(px, pz, W, D, rot);
  const GF = 5, SH = (H - GF) / 7;
  const colliders = [S.obbOf(poly, H)], facades = [];
  S.prism(batch, M.yellow, poly, -0.2, H, { uvScale: 3.5 / SH });
  S.rings(batch, M.whiteMetal, poly, GF, H - 0.5, SH, { out: 0.15, h: 0.22 });
  S.parapet(batch, M.whiteMetal, poly, H, { h: 1.0, t: 0.35 });
  for (let i = 0; i < 4; i++) {
    const a = poly[i], b = poly[(i + 1) % 4];
    const [nx, nz] = L.edgeNormal(poly, i);
    if (!isStreetSide((a[0] + b[0]) / 2 + nx * 4, (a[1] + b[1]) / 2 + nz * 4)) continue;
    S.shopRow(batch, At, a, b, nx, nz, ['TOWER RECORD', 'TOWER RECORD CAFE', 'TOWER RECORD'], { gf: GF, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 220 + i, minW: 8, maxW: 11 });
    // poster wall above the shopfronts
    for (let k = -1; k <= 1; k++) S.poster(group, (a[0] + b[0]) / 2 + (b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]) * k * 7 + nx * 0.3, GF + 2.2, (a[1] + b[1]) / 2 + (b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1]) * k * 7 + nz * 0.3, nx, nz, 5.5, 3.2, i * 3 + k + 2, 0.8);
  }
  // west face onto 神宮通り: the red lettering, the slogan band, the corner blade
  const w = L.bestEdge(poly, -1, 0);
  if (w) {
    S.flatSign(group, w.mid[0] + w.nx * 0.5, H - 7, w.mid[1] + w.nz * 0.5, w.nx, w.nz, { text: 'TOWER RECORD', w: Math.min(w.len - 2, 26), h: 5.2, bg: '#ffd400', fg: '#e01010', emissive: 1.4, weight: '900', letterSpacing: 6 });
    S.flatSign(group, w.mid[0] + w.nx * 0.5, H - 13, w.mid[1] + w.nz * 0.5, w.nx, w.nz, { text: 'NO MUSIC, NO LIFE.', w: Math.min(w.len - 2, 22), h: 2.2, bg: '#e01010', fg: '#ffd400', emissive: 1.3, weight: '900' });
    const bx = w.a[0] + w.tx * 1.4, bz = w.a[1] + w.tz * 1.4;
    S.blade(batch, bx + w.nx * 1.1, 18, bz + w.nz * 1.1, w.tx, w.tz, { text: 'TOWER RECORD 渋谷', w: 1.6, h: 20, bg: '#e01010', fg: '#ffd400', emissive: 1.3, weight: '900' });
    for (const y of [9, 18, 27]) batch.add(M.darkMetal, L.boxAt(bx + w.nx * 0.55, y, bz + w.nz * 0.55, 1.1, 0.12, 0.12, L.rotYOf(w.nx, w.nz), false), px, pz);
  }
  const s = L.bestEdge(poly, 0, 1);
  if (s) S.flatSign(group, s.mid[0] + s.nx * 0.5, H - 7, s.mid[1] + s.nz * 0.5, s.nx, s.nz, { text: 'TOWER RECORD', sub: 'SHIBUYA-CHO', w: Math.min(s.len - 2, 22), h: 4.6, bg: '#ffd400', fg: '#e01010', emissive: 1.4, weight: '900' });
  // roof: 8F event-space box + plant
  S.prism(batch, M.yellow, L.rectPoly(px, pz, W - 8, D - 10, rot), H, H + 4.5, { uvScale: 3.5 / 4.5 });
  inst.add('acBig', At.geos.acBig, At.acMat, px + W / 2 - 4, H, pz - D / 2 + 4, 0.3, 1, 1, 1, 0xbcbcb8);
  inst.add('antenna', At.geos.antenna, At.metal, px - W / 2 + 3, H, pz + D / 2 - 3, 0);
  facades.push(...S.facadeRecords(key, poly, H, 8, { tenants: ['TOWER RECORD'], isStreetSide, gf: GF }));
  const anchors = { sign: w ? new THREE.Vector3(w.mid[0] - px, H - 7, w.mid[1] - pz) : new THREE.Vector3(0, H - 7, 0), signNormal: new THREE.Vector3(-1, 0, 0) };
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
