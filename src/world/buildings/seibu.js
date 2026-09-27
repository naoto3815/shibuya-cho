// [city] 西部渋谷店 A館 / B館 (SEIBO) — two 8-storey department-store blocks facing each other across 井の頭通り:
// granite base, dark-brown vertical fins over bronze-tinted glazing, storey ledges, display windows at street
// level, entrance canopies, "SEIBO" signs on the 公園通り faces, and the glazed 3F sky-bridge between them.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE } from './genericBuilding.js';

export const KEYS = ['seibu', 'seibuB'];
export const SIZE = { w: 32, d: 36, h: 40 };

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide, CITY }) {
  const M = S.mats(), At = getAtlases();
  const poly = L.ensureCW(data.polygon);
  const H = data.size[1], GF = 5.2, SH = (H - GF) / 7;
  const c = L.polyCentroid(poly);
  const colliders = L.edgeColliders(poly, H), facades = [];
  const isA = key === 'seibu';
  // base, body, fins, ledges, parapet
  batch.add(M.granite, L.extrudePolygon(L.offsetPolygon(poly, 0.18), -0.2, 1.1, { cap: true, uvScale: 0.5 }), c[0], c[1]);
  S.prism(batch, M.brownFins, poly, 1.0, H, { uvScale: 3.5 / SH });
  S.fins(inst, 'lm_finBrown', M.bronzeDark, poly, GF, H - 0.6, 1.6, { w: 0.22, d: 0.55, out: 0.02 });
  S.rings(batch, M.darkMetal, poly, GF, H - 0.5, SH, { out: 0.35, h: 0.32 });
  S.parapet(batch, M.darkMetal, poly, H, { h: 1.2, t: 0.4 });
  // street level: display windows / shops on street faces, service doors elsewhere
  const tenants = isA ? ['西部渋谷店', 'SEIBO', 'ルイ・ヴィトソ', 'シャネリ', 'ゴディバ', 'STARBEANS COFFEE', 'ティファニ'] : ['西部渋谷店 B館', 'SEIBO', 'ロフト館', 'ザ・ノースフェイズ', 'ビームズ', 'ユナイテッドアロウス'];
  let ti = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const [nx, nz] = L.edgeNormal(poly, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 5) continue;
    if (isStreetSide((a[0] + b[0]) / 2 + nx * 4, (a[1] + b[1]) / 2 + nz * 4)) {
      const k = Math.max(1, Math.round(len / 9));
      const list = []; for (let j = 0; j < k; j++) list.push(tenants[(ti + j) % tenants.length]); ti += k;
      S.shopRow(batch, At, a, b, nx, nz, list, { gf: GF, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: (isA ? 160 : 180) + i, minW: 7, maxW: 10, lift: 0.06 });
    } else batch.add(At.trim, L.wallQuad((a[0] + b[0]) / 2, 1.3, (a[1] + b[1]) / 2, nx, nz, 1.4, 2.6, 0.06, [0, 0, 0.02, 0.02]), c[0], c[1]);
  }
  // 公園通り face (east): entrance canopy, SEIBO sign band + rooftop letters
  const e = L.bestEdge(poly, 1, 0.15);
  if (e) {
    const rot = L.rotYOf(e.tx, e.tz);
    batch.add(M.darkMetal, L.boxAt(e.mid[0] + e.nx * 2.2, GF + 0.25, e.mid[1] + e.nz * 2.2, Math.min(e.len - 4, 22), 0.5, 4.2, rot, false), c[0], c[1]);
    for (let k = -2; k <= 2; k++) S.ibox(inst, 'lm_downlight', M.glowWarm, e.mid[0] + e.tx * k * 4 + e.nx * 2.2, GF - 0.02, e.mid[1] + e.tz * k * 4 + e.nz * 2.2, 0.5, 0.1, 0.5);
    S.flatSign(group, e.mid[0] + e.nx * 0.62, GF + 1.6, e.mid[1] + e.nz * 0.62, e.nx, e.nz, { text: isA ? '西部渋谷店' : '西部渋谷店 B館', sub: 'SEIBO SHIBUYA-CHO', w: Math.min(e.len - 3, 16), h: 1.6, bg: '#0d2a6a', fg: '#ffffff', emissive: 1.2, weight: '800' });
    S.flatSign(group, e.mid[0] + e.nx * 0.62, H - 3.2, e.mid[1] + e.nz * 0.62, e.nx, e.nz, { text: 'SEIBO', w: Math.min(e.len - 3, 14), h: 3.4, bg: '#0d2a6a', fg: '#ffffff', emissive: 1.5, weight: '900', letterSpacing: 12 });
  }
  // roof plant: rail, 2 tanks, AC units, duct runs, bulkhead + ladder
  S.roofPlant(batch, inst, poly, H, { seed: isA ? 7 : 8, tanks: 2, ac: 8, ducts: 2 });
  // 3F sky-bridge over 井の頭通り (built once, with B館): glazed box between A's north face and B's south face
  if (!isA && CITY && CITY.landmarks.seibu) {
    const pa = L.ensureCW(CITY.landmarks.seibu.polygon);
    const ea = L.bestEdge(pa, 0.05, -1), eb = L.bestEdge(poly, -0.05, 1);
    if (ea && eb) {
      const ax = ea.mid[0], az = ea.mid[1];
      const t = ((ax - eb.a[0]) * eb.tx + (az - eb.a[1]) * eb.tz);                    // foot of A's mid on B's edge
      const bx = eb.a[0] + eb.tx * Math.max(2, Math.min(eb.len - 2, t)), bz = eb.a[1] + eb.tz * Math.max(2, Math.min(eb.len - 2, t));
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz), rot = L.rotYOf(dx, dz);
      const mx = (ax + bx) / 2, mz = (az + bz) / 2, y0 = 8.4, bh = 3.6, bw = 4.6;
      batch.add(M.darkMetal, L.boxAt(mx, y0 - 0.25, mz, len + 1, 0.5, bw, rot, false), mx, mz);
      batch.add(M.darkMetal, L.boxAt(mx, y0 + bh + 0.2, mz, len + 1, 0.4, bw + 0.4, rot, false), mx, mz);
      batch.add(M.interiorDim, L.boxAt(mx, y0 + bh / 2, mz, len, bh - 0.2, bw - 0.6, rot, false), mx, mz);
      batch.add(M.glassClear, L.boxAt(mx, y0 + bh / 2, mz, len, bh, bw, rot, false), mx, mz);
      for (const p of L.alongPolyline([[ax, az], [bx, bz]], 3, 1.5)) for (const sg of [-1, 1]) S.ibox(inst, 'lm_mullion', M.darkMetal, p.x - p.dz * sg * bw / 2, y0, p.z + p.dx * sg * bw / 2, 0.14, bh, 0.14);
    }
  }
  facades.push(...S.facadeRecords(key, poly, H, 8, { tenants: tenants.slice(0, 2), isStreetSide, gf: GF }));
  const anchors = { sign: e ? new THREE.Vector3(e.mid[0] - data.pos[0], H - 3.2, e.mid[1] - data.pos[1]) : new THREE.Vector3(0, H - 3, 0), signNormal: e ? new THREE.Vector3(e.nx, 0, e.nz) : new THREE.Vector3(1, 0, 0) };
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
