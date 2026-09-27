// [city] 渋谷マルコ / MOD1 (渋谷モディ) — slim 9-storey white-panel block in the 公園通り / 神宮通り fork: white panel
// façade, storey ledges, vertical LED strip on the south tip, big LED frame + "MOD1" sign facing the fork.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE } from './genericBuilding.js';

export const KEYS = ['modi'];
export const SIZE = { w: 31, d: 30, h: 35 };

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos;
  const poly = L.ensureCW(data.polygon);
  const H = data.size[1], GF = 4.6, SH = (H - GF) / 8;
  const c = L.polyCentroid(poly);
  const colliders = L.edgeColliders(poly, H), facades = [];
  let anchorsScreen = null;
  S.prism(batch, M.panelWhite, poly, -0.2, H, { uvScale: 3.5 / SH });
  S.rings(batch, M.whiteMetal, poly, GF, H - 0.5, SH, { out: 0.2, h: 0.26 });
  S.parapet(batch, M.whiteMetal, poly, H, { h: 1.2, t: 0.35 });
  const tenants = ['渋谷マルコ', 'MOD1', 'HMV&BOOKZ', 'STARBEANS COFFEE', 'ZALA', 'ノジモ'];
  let ti = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const [nx, nz] = L.edgeNormal(poly, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 5) continue;
    if (!isStreetSide((a[0] + b[0]) / 2 + nx * 4, (a[1] + b[1]) / 2 + nz * 4)) continue;
    const k = Math.max(1, Math.round(len / 8));
    const list = []; for (let j = 0; j < k; j++) list.push(tenants[(ti + j) % tenants.length]); ti += k;
    S.shopRow(batch, At, a, b, nx, nz, list, { gf: GF, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 240 + i, minW: 7, maxW: 10 });
  }
  // south tip: LED frame (poster placeholder), MOD1 sign, vertical light strip on the tip corner
  const s = L.bestEdge(poly, 0.1, 1);
  if (s) {
    const rot = L.rotYOf(s.tx, s.tz);
    const w = Math.max(6, Math.min(s.len + 3, 12)), h = 7, cy = GF + 1.5 + h / 2;
    batch.add(M.darkMetal, L.boxAt(s.mid[0] + s.nx * 0.45, cy, s.mid[1] + s.nz * 0.45, w + 0.8, h + 0.8, 0.6, rot, false), c[0], c[1]);
    S.poster(group, s.mid[0] + s.nx * 0.78, cy, s.mid[1] + s.nz * 0.78, s.nx, s.nz, w, h, 6, 0.9);
    S.flatSign(group, s.mid[0] + s.nx * 0.5, H - 3.5, s.mid[1] + s.nz * 0.5, s.nx, s.nz, { text: 'MOD1', sub: '渋谷マルコ', w: Math.max(6, Math.min(s.len + 2, 10)), h: 4.2, bg: '#e0202a', fg: '#ffffff', emissive: 1.5, weight: '900' });
    for (const p of [s.a, s.b]) S.glowBar(batch, M.glowWhite, p[0] + s.nx * 0.3, (GF + H) / 2, p[1] + s.nz * 0.3, 0.25, H - GF - 1, 0.25, 0);
    anchorsScreen = { position: new THREE.Vector3(s.mid[0] + s.nx * 1.0 - px, cy, s.mid[1] + s.nz * 1.0 - pz), normal: new THREE.Vector3(s.nx, 0, s.nz), size: [w, h] };
  }
  // east face onto 神宮通り: name band
  const e = L.bestEdge(poly, 1, 0);
  if (e) S.flatSign(group, e.mid[0] + e.nx * 0.5, H - 3.5, e.mid[1] + e.nz * 0.5, e.nx, e.nz, { text: '渋谷マルコ', sub: 'MOD1', w: Math.min(e.len - 2, 14), h: 3.2, bg: '#e0202a', fg: '#ffffff', emissive: 1.4, weight: '900' });
  for (let k = 0; k < 3; k++) inst.add('acBig', At.geos.acBig, At.acMat, c[0] + (k - 1) * 5, H, c[1] + (k % 2 ? 4 : -4), k * 0.6, 1, 1, 1, 0xbcbcb8);
  batch.add(M.concrete, L.boxAt(c[0], H + 1.5, c[1] - 6, 5, 3, 4, 0, true), c[0], c[1]);
  facades.push(...S.facadeRecords(key, poly, H, 9, { tenants: ['渋谷マルコ'], isStreetSide, gf: GF }));
  const anchors = { sign: s ? new THREE.Vector3(s.mid[0] - px, H - 3.5, s.mid[1] - pz) : new THREE.Vector3(0, H - 3, 0), signNormal: s ? new THREE.Vector3(s.nx, 0, s.nz) : new THREE.Vector3(0, 0, 1) };
  if (anchorsScreen) { anchors.screen = anchorsScreen.position; anchors.screenNormal = anchorsScreen.normal; anchors.screenSize = anchorsScreen.size; }
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
