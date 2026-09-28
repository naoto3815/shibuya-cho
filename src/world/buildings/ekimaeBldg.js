// [city] 渋谷駅前ビル — 9-storey white-panel block (red window frames, Street View 2023-09) on the south-west corner (道玄坂 × 駅前通り) carrying two stacked LED
// screens on its north-east corner aimed at the crossing (screens from the signage module via anchors.screens).
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE } from './genericBuilding.js';

export const KEYS = ['ekimaeBldg'];

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos;
  const poly = L.ensureCW(data.polygon);
  const H = data.size[1], GF = 4.5, SH = (H - GF) / 8;
  const c = L.polyCentroid(poly);
  const colliders = L.edgeColliders(poly, H), facades = [];
  S.prism(batch, M.panelRedFrame, poly, 0, H, { uvScale: 3.5 / SH });
  S.rings(batch, M.whiteMetal, poly, GF, H - 0.5, SH, { out: 0.18, h: 0.28 });
  S.parapet(batch, M.whiteMetal, poly, H, { h: 1.0, t: 0.3 });
  S.fins(inst, 'lm_finWhite', M.whiteMetal, poly, GF, H, 3.2, { w: 0.18, d: 0.35 });
  // the 西口 (east) face: a green planted sign band at 2F, the contact-lens banner down the corner, clinic boards
  const ef = L.bestEdge(poly, 1, 0.1);
  if (ef) {
    const r = L.rotYOf(ef.tx, ef.tz), bx = ef.mid[0] + ef.nx * 0.35, bz = ef.mid[1] + ef.nz * 0.35;
    batch.add(M.hedge, L.boxAt(bx, GF + 1.6, bz, Math.min(ef.len - 4, 20), 2.6, 0.5, r, false), c[0], c[1]);
    S.flatSign(group, bx + ef.nx * 0.3, GF + 1.6, bz + ef.nz * 0.3, ef.nx, ef.nz, { text: 'サンドラック', sub: 'DRUG  2F', w: 9, h: 1.8, bg: '#1f5a2a', fg: '#ffffff', emissive: 0.9, weight: '900' });
    const vx = ef.a[0] + ef.tx * 3 + ef.nx * 0.7, vz = ef.a[1] + ef.tz * 3 + ef.nz * 0.7;
    S.flatSign(group, vx, GF + 8.5, vz, ef.nx, ef.nz, { text: 'コンタクトの\nアイシチィ', w: 2.2, h: 11, bg: '#1f6fc0', fg: '#ffffff', emissive: 1.0, weight: '900' });
    for (let k = 0; k < 3; k++) S.flatSign(group, ef.b[0] - ef.tx * (2 + k * 2.2) + ef.nx * 0.5, GF + 11 - k * 3.2, ef.b[1] - ef.tz * (2 + k * 2.2) + ef.nz * 0.5, ef.nx, ef.nz, { text: ['消化器内科', '眼科・皮フ科', '歯科 5F'][k], w: 1.9, h: 2.6, bg: '#ffffff', fg: '#b3202a', emissive: 0.7, weight: '800' });
  }
  const tenants = data.tenants || [];
  let ti = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const [nx, nz] = L.edgeNormal(poly, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 5) continue;
    if (isStreetSide((a[0] + b[0]) / 2 + nx * 4, (a[1] + b[1]) / 2 + nz * 4)) { const k = Math.max(1, Math.round(len / 8)); S.shopRow(batch, At, a, b, nx, nz, tenants.slice(ti, ti + k).concat(tenants.slice(0, Math.max(0, ti + k - tenants.length))), { gf: GF, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 80 + i }); ti = (ti + k) % Math.max(1, tenants.length); }
  }
  // stacked screens on the north-east corner
  const anchors = { screens: [] };
  const lv = (x, y, z) => new THREE.Vector3(x - px, y, z - pz);
  for (const sc of data.screens || []) {
    const [fx, fz] = S.dirOf(sc.faces);
    const nx = fx, nz = fz, tx = -nz, tz = nx, rot = L.rotYOf(tx, tz);
    const cy = sc.bottom + sc.h / 2;
    const x = sc.center[0] + nx * 0.8, z = sc.center[1] + nz * 0.8;
    batch.add(M.darkMetal, L.boxAt(x, cy, z, sc.w + 1.0, sc.h + 0.8, 0.5, rot, false), c[0], c[1]);
    batch.add(M.darkMetal, L.boxAt(sc.center[0] + nx * 0.3, cy, sc.center[1] + nz * 0.3, sc.w + 1.4, 0.35, 1.2, rot, false), c[0], c[1]);
    S.poster(group, x + nx * 0.28, cy, z + nz * 0.28, nx, nz, sc.w, sc.h, 1 + anchors.screens.length);
    anchors.screens.push({ position: lv(x + nx * 0.45, cy, z + nz * 0.45), normal: new THREE.Vector3(nx, 0, nz), size: [sc.w, sc.h], name: sc.name });
  }
  anchors.screen = anchors.screens[0] ? anchors.screens[0].position : new THREE.Vector3();
  anchors.screenNormal = anchors.screens[0] ? anchors.screens[0].normal : new THREE.Vector3(0.7, 0, -0.7);
  // rooftop: billboard frame + plant
  const n = L.bestEdge(poly, 0.7, -0.7);
  if (n) { const rot = L.rotYOf(n.tx, n.tz); for (const o of [-5, 5]) S.ibox(inst, 'lm_post', M.darkMetal, n.mid[0] + n.tx * o - n.nx * 1.5, H, n.mid[1] + n.tz * o - n.nz * 1.5, 0.3, 6, 0.3, rot); S.flatSign(group, n.mid[0] - n.nx * 1.3, H + 4.2, n.mid[1] - n.nz * 1.3, n.nx, n.nz, { text: '渋谷駅前ビル', sub: 'SHIBUYA EKIMAE BLDG.', w: 11, h: 2.4, bg: '#14161a', fg: '#e8e0c8', emissive: 1.2, weight: '700', double: true }); }
  inst.add('tank', At.geos.tank, At.tankMat, c[0] - 4, H, c[1] + 4, 0.7);
  inst.add('acBig', At.geos.acBig, At.acMat, c[0] + 3, H, c[1] - 3, 1.1, 1, 1, 1, 0xbcbcb8);
  facades.push(...S.facadeRecords(key, poly, H, 9, { tenants, isStreetSide, gf: GF }));
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS };
