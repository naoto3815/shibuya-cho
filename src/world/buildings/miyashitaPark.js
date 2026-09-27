// [city] 宮下パーク (MIYASHITA PARK, 2020) — pass 11, rebuilt to the OSM plan (see miyashitaParkData.js for sources and
// the z mapping). A 3-storey open-air mall (RAYARD) between the JR tracks and 明治通り carrying 渋谷区立宮下公園 on its roof
// at +17.5 m, in two blocks divided by the 美竹通り passage:
//  · South block: a wedge whose tip sits on 宮下通り; its east face runs behind the 明治通り office row (built here
//    too, OSM heights) and reaches 明治通り only at the footbridge corner. 渋谷横丁 runs the length of its JR side on
//    1F: a covered arcade under the 2F overhang, twelve lantern-hung stall fronts (noren, counters, stools) and
//    terrace tables. South tip: the escalator atrium. Roof: skate park, bouldering wall, sand court, park centre.
//  · The passage: open to the sky between the park-level bridges, the grand stair climbs from 明治通り (2F landing,
//    3F landing, then twin flights back east to the park), the ground passage runs under and beside it to the tracks.
//  · North block: galleried 明治通り and passage faces (white slab bands, glass balustrades, planters and hanging
//    green, louvre screens, recessed shopfronts), STARBEANS COFFEE pavilion by the stair head, the lawn, hotel
//    "sequense" (75.1 m) on the Harajuku end.
//  · Footbridges over 明治通り at the 2F level: at the South block corner and at the hotel.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE } from './genericBuilding.js';
import { escalator } from './escalator.js';
import { SW_H } from './streets.js';
import * as D from './miyashitaParkData.js';

export const KEYS = ['miyashitaPark'];
export const SIZE = { w: 51, d: 113, h: 18 };

const QP_SEG = 8;
/** Quarter-pipe transition (radius r, length len along local x) whose deck edge is at local z = 0, facing +z. */
function quarterPipe(cx, y, cz, len, r, rotY) {
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i <= QP_SEG; i++) {
    const a = (i / QP_SEG) * Math.PI / 2;
    const zz = r - Math.sin(a) * r, yy = r - Math.cos(a) * r;
    const nz = -Math.sin(a), ny = Math.cos(a);
    for (const x of [-len / 2, len / 2]) { pos.push(x, yy, -zz + r); nor.push(0, ny, nz); uv.push(x / 2, a * r / 2); }
    if (i > 0) { const b = (i - 1) * 2; idx.push(b, b + 3, b + 1, b, b + 2, b + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.rotateY(rotY); g.translate(cx, y, cz);
  return g;
}

export function build({ key, data, batch, inst, group, rng, pools, CITY }) {
  const M = S.mats(), At = getAtlases();
  const { H, LV, HD, GAL } = D;
  const FY = SW_H + 0.012;                                   // our paving, just over the pavement
  const colliders = [], facades = [], lights = [];
  const lift0 = batch.lift || 0;
  const onFloor = (y, fn) => { batch.lift = lift0 + y; try { fn(); } finally { batch.lift = lift0; } };
  const box = (mat, x, y, z, w, h, d, rot = 0, uvm = true) => batch.add(mat, L.boxAt(x, y, z, w, h, d, rot, uvm), x, z);
  const seg = (mat, a, b, y, h, t, off = [0, 0], uvm = true) => { const dx = b[0] - a[0], dz = b[1] - a[1]; const mx = (a[0] + b[0]) / 2 + off[0], mz = (a[1] + b[1]) / 2 + off[1]; box(mat, mx, y, mz, Math.hypot(dx, dz), h, t, Math.atan2(-dz, dx), uvm); };
  const cap = (mat, poly, y, uv = 0.25) => { const c = L.polyCentroid(poly); batch.add(mat, L.polygonCap(poly, y, uv), c[0], c[1]); };
  const col = (x, z, w, h, d, y0 = 0, rot = 0) => colliders.push(S.boxCollider(x, z, w, h, d, rot, y0));
  const segCol = (a, b, h, t = 0.6, y0 = 0) => { const dx = b[0] - a[0], dz = b[1] - a[1]; col((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.hypot(dx, dz), h, t, y0, Math.atan2(-dz, dx)); };
  const propFree = CITY ? (CITY.propFree || (CITY.propFree = [])) : [];
  const shops = (a, b, nx, nz, names, o) => S.shopRow(batch, At, a, b, nx, nz, names, { rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, ...o });
  const upper = ['RAYARD', 'Doctor Martins', 'ニューエラ', 'アディダズ', 'GO', 'キス', 'ビレッジバンガード', 'ABC-MARK', 'タリース', '無地良品', 'WEGA', 'ゴン茶', 'SPINZ', 'MIYASHITA PARK'];
  let fi = 300;

  // ---------------------------------------------------------------------------------------------- walls / floors
  S.prism(batch, M.concreteWin, D.S_1F, -0.2, LV[1] - 0.4, { cap: false, uvScale: 3.5 / 4.3 });
  S.prism(batch, M.concreteWin, D.S_UP, LV[1] - 0.4, HD, { cap: false, uvScale: 3.5 / 4.3 });
  S.prism(batch, M.concreteWin, D.N_1F, -0.2, HD, { cap: false, uvScale: 3.5 / 4.3 });
  for (const c of L.edgeColliders(D.S_1F, H)) colliders.push(c);
  for (const c of L.edgeColliders(D.N_1F, H)) colliders.push(c);
  // our paving: the 渋谷横丁 arcade, the passage + both blocks' arcades + the 明治通り forecourt (east edge = the
  // pavement's inner line, which runs 134.3 → 136 northward), the south atrium
  const xIn = (z) => 150 + 2 * (-133 - z) / 89 - 16;
  const F_YOKO = [[82.75, -107], [87.5, -107], [87.5, -155], [82.75, -155]];
  const F_PASS = [[82.75, -155], [125.5, -155], [125.5, -144], [xIn(-144), -144], [xIn(-220), -220], [130.5, -220], [130.5, -173], [84, -173], [84, -170], [82.75, -170]];
  const F_ATR = [[91, -107], [101, -107], [101, -121], [91, -121]];
  for (const p of [F_YOKO, F_PASS, F_ATR]) cap(M.tile, p, FY, 0.4);
  propFree.push([[76, -106], [87.5, -106], [87.5, -158], [76, -158]], F_PASS, F_ATR, [[76, -170], [84, -170], [84, -221], [76, -221]]);

  // ---------------------------------------------------------------------------------------------- open galleries
  // face at `c` on axis 'x' (x = c, normal (n,0)) or 'z' (z = c, normal (0,n)); u runs along the face [u0,u1]; the
  // band runs [b0,b1] (it wraps the corner); shopfronts on 1F / 2F / 3F at the inner line (GAL back)
  const P = (ax, c, n) => (u, v) => ax === 'x' ? [c + n * v, u] : [u, c + n * v];
  const fbox = (ax, c, n) => (mat, u, v, y, lu, dv, h, uvm = true) => { const [x, z] = P(ax, c, n)(u, v); if (ax === 'x') box(mat, x, y, z, dv, h, lu, 0, uvm); else box(mat, x, y, z, lu, h, dv, 0, uvm); };
  function gallery(ax, c, n, u0, u1, { b0 = u0, b1 = u1, t1 = null, t2 = upper, louvre = true, gf1 = 4.6 } = {}) {
    const fb = fbox(ax, c, n), at = P(ax, c, n), len = u1 - u0, uc = (u0 + u1) / 2, blen = b1 - b0, bc = (b0 + b1) / 2;
    const nx = ax === 'x' ? n : 0, nz = ax === 'z' ? n : 0;
    // white column line
    const nb = Math.max(1, Math.round(len / 7.2)), bay = len / nb;
    for (let k = 0; k <= nb; k++) {
      const u = u0 + Math.min(len - 0.35, Math.max(0.35, k * bay));
      fb(M.whiteMetal, u, -0.35, HD / 2, 0.55, 0.55, HD);
      const [x, z] = at(u, -0.35); col(x, z, 0.6, 4, 0.6);
    }
    for (let li = 1; li < LV.length; li++) {
      const y = LV[li];
      fb(M.whiteMetal, uc, -GAL / 2, y - 0.2, len, GAL, 0.4, false);                           // gallery slab
      fb(M.whiteMetal, bc, 0.12, y - 0.1, blen, 0.34, 0.9);                                   // white slab-edge band
      fb(M.glassClear, uc, -0.1, y + 0.9, len - 0.3, 0.04, 1.1, false);                       // glass balustrade
      fb(M.silver, uc, -0.1, y + 1.47, len - 0.3, 0.06, 0.06, false);
      fb(M.concrete, uc, -0.62, y + 0.25, len - 0.8, 0.55, 0.5);                              // planter trough
      for (let u = u0 + 0.8; u < u1 - 0.6; u += 1.7) {
        const [x, z] = at(u + rng.range(-0.3, 0.3), -0.62);
        inst.add('lm_mpGreen', S.HEDGE_GEO, M.hedge, x, y + 0.65, z, rng.range(0, 3), 1.6, 0.75, 1.0);
        if (rng() < 0.3) { const [hx, hz] = at(u, 0.34); inst.add('lm_mpGreen', S.HEDGE_GEO, M.hedge, hx, y - 0.9 - rng() * 0.5, hz, 0, 0.9, 1.5 + rng() * 0.8, 0.45); }   // hanging green over the band
      }
      for (let u = u0 + 1.2; u < u1 - 0.6; u += 3.6) { const [dx, dz] = at(u, -GAL / 2); S.ibox(inst, 'lm_downlight', M.glowWarm, dx, y - 0.43, dz, 0.45, 0.05, 0.45); }
      // louvre screen (white vertical fins, 0.45 m pitch) over alternate 3F bays
      if (louvre && li === 2) for (let k = 0; k < nb; k += 2) for (let u = u0 + k * bay + 0.5; u < u0 + (k + 1) * bay - 0.3; u += 0.45) {
        const [x, z] = at(u, -0.05);
        S.ibox(inst, 'lm_mpLouvre', M.whiteMetal, x, y + 1.6, z, ax === 'x' ? 0.32 : 0.07, HD - y - 1.6, ax === 'x' ? 0.07 : 0.32);
      }
    }
    for (let u = u0 + 1.2; u < u1 - 0.5; u += 3.6) { const [x, z] = at(u, -GAL / 2); S.ibox(inst, 'lm_downlight', M.glowWarm, x, HD - 0.03, z, 0.45, 0.05, 0.45); }
    // shopfronts: a..b along the inner line
    const a = at(u1, -GAL), b = at(u0, -GAL);
    const [sa, sb] = (ax === 'x' ? n > 0 : n < 0) ? [a, b] : [b, a];
    if (t1) shops(sa, sb, nx, nz, t1, { gf: gf1, fi: fi++, minW: 7, maxW: 10 });
    for (let li = 1; li < LV.length; li++) onFloor(LV[li], () => shops(sa, sb, nx, nz, t2.slice((fi * 3) % t2.length).concat(t2), { gf: 4.4, fi: fi++, minW: 6, maxW: 9 }));
  }
  // South block: 明治通り corner face and the passage face; North block: passage face and the long 明治通り face
  gallery('x', 128.5, 1, -158, -144.3, { t1: ['STARBEANS COFFEE', 'RAYARD'], louvre: false });
  gallery('z', -158, -1, 83, 125.5, { b1: 128.7, t1: ['ニューエラ', 'GO', 'Doctor Martins', 'アディダズ', 'ABC-MARK'] });
  gallery('z', -170, 1, 84, 133.5, { b0: 83.8, t1: ['キス', 'RAYARD', 'タリース', 'ビレッジバンガード', 'MIYASHITA PARK'] });
  gallery('x', 133.5, 1, -220, -173, { b1: -169.8, t1: ['ルイ・ヴィトソ', 'GUCHI', 'PRADO', 'BALENCIAGO', 'RAYARD', 'キス'] });

  // ---------------------------------------------------------------------------------------------- solid faces
  // JR side (South block above the 渋谷横丁 arcade, North block full height), the south tip and the north end:
  // white bands at the floor lines, a louvre screen over dark panels
  function solidFace(ax, c, n, u0, u1, y0) {
    const fb = fbox(ax, c, n), at = P(ax, c, n), len = u1 - u0, uc = (u0 + u1) / 2;
    fb(M.panelGrey, uc, 0.02, (y0 + HD) / 2, len, 0.06, HD - y0, true);
    for (let li = 1; li < LV.length; li++) if (LV[li] >= y0 - 0.1) fb(M.whiteMetal, uc, 0.15, LV[li] - 0.1, len + 0.2, 0.3, 0.9);
    for (let u = u0 + 0.4; u < u1 - 0.2; u += 0.9) {
      const [x, z] = at(u, 0.22);
      for (let li = 1; li < LV.length; li++) { const ya = Math.max(y0, LV[li] + 0.35), yb = li + 1 < LV.length ? LV[li + 1] - 0.55 : HD - 0.4; if (yb > ya) S.ibox(inst, 'lm_mpLouvre', M.whiteMetal, x, ya, z, ax === 'x' ? 0.3 : 0.08, yb - ya, ax === 'x' ? 0.08 : 0.3); }
    }
  }
  solidFace('x', D.YOKO.xOut, -1, D.Z.p0, D.Z.s0, LV[1] - 0.55);
  solidFace('x', 84, -1, D.Z.n1, D.Z.p1, 0);
  solidFace('z', D.Z.s0, 1, 83, 104, LV[1] - 0.55);
  solidFace('z', D.Z.n1, -1, 84, 133.5, 0);
  // the overhang soffit over the 渋谷横丁 arcade and the atrium ceiling
  box(M.whiteMetal, 85.25, LV[1] - 0.2, -131, 4.5, 0.4, 48, 0, false);
  for (let z = -109; z > -155; z -= 3) S.ibox(inst, 'lm_downlight', M.glowWarm, 84.4, LV[1] - 0.43, z, 0.4, 0.05, 0.4);

  // ---------------------------------------------------------------------------------------------- 渋谷横丁
  {
    const Y = D.YOKO, names = D.YOKOCHO_STALLS, n = names.length, zA = Y.z0 - 0.5, zB = -154.6, sw = (zA - zB) / n;
    shops([Y.x, zB], [Y.x, zA], -1, 0, names, { gf: 3.4, typeOf: () => 'izakaya', fascia: false, fi: 320, minW: sw, maxW: sw });
    box(M.wood, Y.x - 0.12, 4.3, (zA + zB) / 2, 0.25, 1.8, zA - zB, 0, true);                    // dark timber band over the stalls
    box(M.wood, Y.x - 0.35, 3.45, (zA + zB) / 2, 0.3, 0.28, zA - zB, 0, true);                   // lintel
    const NOREN = [['#1d2a4a', '食'], ['#8a1a14', '酒'], ['#3a2616', '肴'], ['#1d2a4a', 'めし'], ['#8a1a14', '呑'], ['#2b3a2a', '焼']];
    for (let i = 0; i < n; i++) {
      const z0 = zA - i * sw, zc = z0 - sw / 2;
      box(M.wood, Y.x - 0.3, 1.75, z0, 0.22, 3.5, 0.22, 0, true);                                // posts
      S.signQuad(batch, Y.x - 0.42, 3.05, zc, -1, 0, { text: names[i], w: sw - 0.7, h: 0.42, bg: '#f3e6c8', fg: '#2a1a10', emissive: 1.0, weight: '900' });
      const [bg, t] = NOREN[i % NOREN.length];
      S.signQuad(batch, Y.x - 0.5, 2.42, zc, -1, 0, { text: t, sub: names[i], w: sw - 1.0, h: 0.7, bg, fg: '#f4efe4', emissive: 0.4, weight: '900' });
      box(M.wood, Y.x - 0.75, 1.02, zc, 0.55, 0.08, sw - 0.9, 0, true);                          // counter top
      box(M.wood, Y.x - 0.62, 0.52, zc, 0.3, 0.95, sw - 0.9, 0, true);
      for (let k = -1; k <= 1; k++) S.ibox(inst, 'lm_stool', M.darkMetal, Y.x - 1.35, FY, zc + k * sw * 0.26, 0.34, 0.72, 0.34);
      S.lantern(inst, Y.x - 0.55, 2.55, z0 - 0.35, 0.34, 0.5); S.lantern(inst, Y.x - 0.55, 2.55, z0 - sw + 0.35, 0.34, 0.5);
    }
    // lantern strings along the arcade + along the overhang edge
    for (let z = Y.z0 - 1.2; z > -157; z -= 1.8) {
      S.lantern(inst, 85.9, 4.05, z, 0.32, 0.46); S.lantern(inst, 83.4, 4.35, z - 0.75, 0.36, 0.5);
    }
    for (const x of [85.9, 83.4]) box(M.darkMetal, x, x > 85 ? 4.55 : 4.9, -132, 0.03, 0.03, 50, 0, false);
    // overhang columns, terrace tables (under cover, beside the walk), the gate boards at both mouths
    for (let z = -113; z > -155; z -= 8.5) { box(M.whiteMetal, 83.3, LV[1] / 2, z, 0.5, LV[1], 0.5, 0, false); col(83.3, z, 0.55, 4, 0.55); }
    for (let z = -110; z > -155; z -= 3.3) {                                                    // terrace seats along the viaduct
      if (z < -127 && z > -131.5) continue;                                                    // a gap to cross to the arcade
      const tx = 77.3;
      box(M.wood, tx, 0.76, z, 0.75, 0.06, 1.7, 0, true); S.ibox(inst, 'lm_stool', M.darkMetal, tx, FY, z, 0.12, 0.72, 0.12);
      for (const s of [-1, 1]) box(M.wood, tx + s * 0.68, 0.45, z, 0.3, 0.06, 1.6, 0, true);
      col(tx, z, 1.7, 1, 1.8);
    }
    for (let z = -110; z > -155; z -= 6.6) S.lantern(inst, 77.3, 3.1, z - 1.65, 0.3, 0.44);
    for (const [z, nz] of [[D.Z.s0 + 0.05, 1], [D.Z.p0 + 0.05, -1]]) {
      box(M.wood, 85.25, 4.95, z - nz * 0.1, 4.6, 0.3, 0.25, 0, true);
      S.signQuad(batch, 85.25, 4.45, z, 0, nz, { text: '渋谷横丁', sub: 'SHIBUYA YOKOCHO', w: 3.8, h: 0.8, bg: '#2a1a10', fg: '#ffcf70', emissive: 1.3, weight: '900' });
    }
    for (const z of [-119, -143]) S.signQuad(batch, D.YOKO.xOut - 0.3, LV[1] - 0.1, z, -1, 0, { text: '渋谷横丁', sub: '全国ご当地食市  24H', w: 7.5, h: 0.82, bg: '#2a1a10', fg: '#ffcf70', emissive: 1.3, weight: '900' });
    for (const z of [-115, -131, -147]) { const l = new THREE.PointLight(0xff8a3c, 5, 10, 2); l.position.set(85.4, 3.4, z); lights.push(l); }
  }

  // ---------------------------------------------------------------------------------------------- south atrium
  {
    const A = D.ATRIUM, xc = (A.x0 + A.x1) / 2;
    box(M.whiteMetal, xc, LV[1] - 0.2, -111.5, A.x1 - A.x0, 0.4, 9, 0, false);                     // ceiling over the front half
    for (const [x, z, nx, nz, w] of [[A.x0 + 0.02, -118.5, 1, 0, 5], [A.x1 - 0.02, -118.5, -1, 0, 5], [xc, A.z1 + 0.02, 0, 1, A.x1 - A.x0], [xc, -116.02, 0, -1, A.x1 - A.x0]]) batch.add(M.interiorDim, L.wallQuad(x, 8.1, z, nx, nz, w, 5.4, 0.01), x, z);
    box(M.whiteMetal, xc, 10.9, -118.5, A.x1 - A.x0, 0.3, 5, 0, false);
    shops([A.x0, -115.8], [A.x0, A.z0], 1, 0, ['ゴン茶', 'RAYARD'], { gf: 4.6, fi: 390, minW: 4, maxW: 5 });   // shops lining the atrium
    shops([A.x1, A.z0], [A.x1, -115.8], -1, 0, ['マリオソクレープ', 'GO'], { gf: 4.6, fi: 391, minW: 4, maxW: 5 });
    for (let z = -108.5; z > -116; z -= 2.5) for (const x of [93.5, 98.5]) S.ibox(inst, 'lm_downlight', M.glowWhite, x, LV[1] - 0.43, z, 0.5, 0.05, 0.5);
    escalator(batch, inst, 94.8, FY, -109.2, 94.8, LV[1], -120.6, { w: 1.1, up: true, colliders });
    escalator(batch, inst, 97.2, FY, -109.2, 97.2, LV[1], -120.6, { w: 1.1, up: false, colliders });
    box(M.stoneLight, xc, LV[1] - 0.15, -120.8, A.x1 - A.x0, 0.3, 0.8, 0, true);
    S.signQuad(batch, xc, 3.95, A.z0 + 0.3, 0, 1, { text: 'RAYARD MIYASHITA PARK', sub: 'SOUTH  1F–3F  ／  PARK 4F', w: 7, h: 0.6, bg: '#f4f4f0', fg: '#111111', emissive: 1.0, weight: '800' });
  }

  // ---------------------------------------------------------------------------------------------- the grand stair
  const flight = (x0, y0, z0, x1, y1, z1, w, { sides = [1, -1], mat = M.stoneLight, riser = 0.16, solid = false } = {}) => {
    const dx = x1 - x0, dz = z1 - z0, run = Math.hypot(dx, dz), ux = dx / run, uz = dz / run, lx = -uz, lz = ux, rot = Math.atan2(-uz, ux);
    const rise = y1 - y0, n = Math.max(2, Math.round(rise / riser)), tr = run / n, rs = rise / n;
    for (let i = 0; i < n; i++) {
      const cx = x0 + ux * tr * (i + 0.5), cz = z0 + uz * tr * (i + 0.5), top = y0 + rs * (i + 1), hh = solid ? top - y0 + 0.02 : rs + 0.14;
      batch.add(mat, L.boxAt(cx, top - hh / 2, cz, tr + 0.02, hh, w, rot, true), cx, cz);
    }
    const ang = Math.atan2(rise, run), ln = Math.hypot(run, rise), mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, my = (y0 + y1) / 2;
    if (!solid) batch.add(M.whiteMetal, S.placed(new THREE.BoxGeometry(ln, 0.3, w), mx, my - 0.32, mz, { rz: ang, ry: rot }), mx, mz);   // soffit
    for (const s of sides) {
      const ox = lx * s * (w / 2 + 0.07), oz = lz * s * (w / 2 + 0.07);
      batch.add(M.whiteMetal, S.placed(new THREE.BoxGeometry(ln, 0.55, 0.14), mx + ox, my - 0.1, mz + oz, { rz: ang, ry: rot }), mx, mz);     // stringer
      batch.add(M.glassClear, S.placed(new THREE.BoxGeometry(ln, 1.05, 0.04), mx + ox, my + 0.72, mz + oz, { rz: ang, ry: rot }), mx, mz);
      batch.add(M.silver, S.placed(new THREE.BoxGeometry(ln, 0.06, 0.07), mx + ox, my + 1.27, mz + oz, { rz: ang, ry: rot }), mx, mz);
    }
    if (y0 < 0.5) { const uc = Math.min(run, run * 2.3 / rise); col(x0 + ux * uc / 2, z0 + uz * uc / 2, uc, 2.3, w + 0.3, 0, rot); }   // the low end is solid
  };
  {
    const zc = (D.Z.p0 + D.Z.p1) / 2;
    flight(132.5, FY, zc, 118.5, LV[1], zc, 5, {});
    flight(114.5, LV[1], zc, 100.5, LV[2], zc, 5, {});
    for (const z of [D.Z.p0 - 1.75, D.Z.p1 + 1.75]) flight(97, LV[2], z, 113, H, z, 3, { sides: z > zc ? [-1] : [1] });
    for (const [x0, x1, y] of [[114.5, 118.5, LV[1]], [95, 100.5, LV[2]]]) {                      // full-width landings into both blocks' galleries
      box(M.whiteMetal, (x0 + x1) / 2, y - 0.3, zc, x1 - x0, 0.6, 12, 0, false);
      box(M.stoneLight, (x0 + x1) / 2, y - 0.02, zc, x1 - x0, 0.04, 11.9, 0, true);
      for (const dz of [-2.2, 2.2]) { box(M.whiteMetal, (x0 + x1) / 2, (y - 0.6) / 2, zc + dz, 0.6, y - 0.6, 0.6, 0, false); col((x0 + x1) / 2, zc + dz, 0.65, 4, 0.65); }
    }
    // hung flights C: hangers from the park-level bridge; step lights on the grand stair
    for (let x = 131; x > 101; x -= 2) for (const s of [-1, 1]) {
      const y = x > 118.5 ? (132.5 - x) / 14 * LV[1] : x < 114.5 ? LV[1] + (114.5 - x) / 14 * (LV[2] - LV[1]) : -1;
      if (y > 0) S.ibox(inst, 'lm_steplight', M.glowWarm, x, y + 0.02, zc + s * 2.55, 0.35, 0.05, 0.08);
    }
    const l = new THREE.PointLight(0xfff0d8, 4, 14, 2); l.position.set(110, 8.5, zc); lights.push(l);
  }

  // ---------------------------------------------------------------------------------------------- 明治通り office row
  {
    const xd = (z) => D.DIAG.a[0] + (D.DIAG.a[1] - z) * (D.DIAG.b[0] - D.DIAG.a[0]) / (D.DIAG.a[1] - D.DIAG.b[1]) + 0.05;
    const X = D.X_MEIJI - 0.3;
    D.OFFICES.forEach((o, k) => {
      const poly = [[xd(o.z0), o.z0], [X, o.z0], [X, o.z1], [xd(o.z1), o.z1]];
      const mat = M[o.mat] || M.concreteWin, id = `miyashitaPark_bldg${k}`;
      S.prism(batch, mat, poly, -0.2, o.h, { uvScale: 1 });
      S.parapet(batch, M.ledge, poly, o.h, { h: 1.0, t: 0.3 });
      S.roofPlant(batch, inst, poly, o.h, { seed: 910 + k, tanks: k % 2, ac: 2 + (k % 3), ducts: 1, rail: false, inset: 1.2 });
      shops([X, o.z1], [X, o.z0], 1, 0, o.t, { gf: 4.2, fi: 360 + k, minW: 3, maxW: 7 });
      box(M.ledge, X + 0.3, 4.35, (o.z0 + o.z1) / 2, 0.6, 0.25, o.z0 - o.z1 - 0.2, 0, true);            // storey-1 canopy ledge
      for (const c of L.edgeColliders(poly, o.h)) colliders.push(c);
      const w = o.z0 - o.z1, nT = o.t.length;
      o.t.forEach((t, i) => facades.push({ id: `${id}:shop${i}`, buildingId: id, position: new THREE.Vector3(X, 0.15, o.z0 - w * (i + 0.5) / nT), normal: new THREE.Vector3(1, 0, 0), width: w / nT, height: 4.2, storeys: 1, tenants: [t], kind: 'shop', groundFloorHeight: 4.2 }));
      facades.push({ id: `${id}:f`, buildingId: id, position: new THREE.Vector3(X, 0.15, (o.z0 + o.z1) / 2), normal: new THREE.Vector3(1, 0, 0), width: w, height: o.h, storeys: o.st, tenants: o.t.concat(['渋谷町総合法律事務所', '大和證研']), kind: 'street', groundFloorHeight: 4.2 });
      if (k === 0) {                                                                            // the 宮下通り corner
        shops([xd(o.z0), o.z0], [X, o.z0], 0, 1, ['ファミリマート', '三千里薬局'], { gf: 4.2, fi: 370, minW: 8, maxW: 12 });
        facades.push({ id: `${id}:s`, buildingId: id, position: new THREE.Vector3((xd(o.z0) + X) / 2, 0.15, o.z0), normal: new THREE.Vector3(0, 0, 1), width: X - xd(o.z0), height: o.h, storeys: o.st, tenants: ['三千里薬局', 'アコン'], kind: 'street', groundFloorHeight: 4.2 });
      }
    });
  }

  // ---------------------------------------------------------------------------------------------- park deck
  for (const p of [D.S_DECK, D.N_DECK, D.BR_W, D.BR_E]) { S.prism(batch, M.whiteMetal, p, HD, H, { cap: false, bottom: true }); cap(M.stoneLight, p, H, 0.25); }
  // outer edges: thick white fascia + glass parapet on a curb (not on the diagonal / office side)
  const EDGES = [
    [[83, -107], [104, -107], [0, 1]], [[83, -158], [83, -107], [-1, 0]], [[128.5, -144], [128.5, -158], [1, 0]],
    [[95, -158], [113, -158], [0, -1]], [[95, -170], [113, -170], [0, 1]], [[128.5, -170], [133.5, -170], [0, 1]], [[133.5, -170], [133.5, -220], [1, 0]], [[84, -220], [133.5, -220], [0, -1]], [[84, -170], [84, -220], [-1, 0]],
    [[83, -158], [84, -170], [-1, 0.08]], [[95, -158], [95, -170], [1, 0]], [[113, -161], [113, -167], [-1, 0]], [[128.5, -158], [128.5, -170], [1, 0]],
  ];
  for (const [a, b, nn] of EDGES) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), inner = Math.abs(nn[1]) > 0.5 && (a[1] === -158 || a[1] === -170) && a[0] >= 95 && b[0] <= 113;
    const fo = inner ? 0 : 0.2;
    seg(M.whiteMetal, a, b, H - 0.65, 1.9, 0.4, [nn[0] * fo, nn[1] * fo]);
    seg(M.whiteMetal, a, b, H + 0.15, 0.3, 0.35, [-nn[0] * 0.1, -nn[1] * 0.1]);
    seg(M.glassClear, a, b, H + 0.85, 1.1, 0.04, [-nn[0] * 0.05, -nn[1] * 0.05], false);
    seg(M.silver, a, b, H + 1.42, 0.06, 0.07, [-nn[0] * 0.05, -nn[1] * 0.05], false);
    for (const p of L.alongPolyline([a, b], 1.8, 0.4)) S.ibox(inst, 'lm_mpRailpost', M.silver, p.x - nn[0] * 0.05, H + 0.3, p.z - nn[1] * 0.05, 0.06, 1.15, 0.06);
    if (!inner && len > 6) for (const p of L.alongPolyline([a, b], 3.2, 1.2)) S.ibox(inst, 'lm_downlight', M.glowWarm, p.x - nn[0] * 1.4, HD - 0.03, p.z - nn[1] * 1.4, 0.4, 0.05, 0.4);
  }
  // "MIYASHITA PARK" on the park-level bridge over the passage mouth (facing 明治通り) and on the 2F band by it
  S.signQuad(batch, 128.95, H - 0.65, -164, 1, 0, { text: 'MIYASHITA PARK', w: 10, h: 1.1, bg: '#f4f4f0', fg: '#111111', emissive: 0.9, weight: '900', letterSpacing: 6 });
  S.signQuad(batch, 133.95, H - 0.65, -186, 1, 0, { text: 'MIYASHITA PARK', sub: '渋谷区立宮下公園', w: 12, h: 1.3, bg: '#f4f4f0', fg: '#111111', emissive: 0.9, weight: '900', letterSpacing: 6 });

  // ---------------------------------------------------------------------------------------------- roof: greenery
  const tree = (x, z, s = 1) => {
    S.ibox(inst, 'lm_mpTrunk', M.wood, x, H, z, 0.26, 3.4 * s, 0.26);
    inst.add('lm_mpGreen', S.HEDGE_GEO, M.hedge, x, H + 4.2 * s, z, rng.range(0, 3), 3.4 * s, 2.7 * s, 3.4 * s);
    inst.add('lm_mpGreen', S.HEDGE_GEO, M.hedge, x + rng.range(-0.8, 0.8), H + 5.2 * s, z + rng.range(-0.8, 0.8), 0, 2.4 * s, 2.0 * s, 2.4 * s);
    box(M.concrete, x, H + 0.25, z, 1.9, 0.5, 1.9, 0, true);
  };
  const lamp = (x, z) => { S.ibox(inst, 'lm_mpPole', M.silver, x, H, z, 0.12, 4.6, 0.12); S.ibox(inst, 'lm_decklight', M.glowWarm, x, H + 4.4, z, 0.45, 0.2, 0.45); };
  const bench = (x, z, alongZ = true) => { box(M.wood, x, H + 0.45, z, alongZ ? 0.5 : 2.2, 0.1, alongZ ? 2.2 : 0.5, 0, true); box(M.concrete, x, H + 0.2, z, alongZ ? 0.4 : 2, 0.4, alongZ ? 2 : 0.4, 0, true); };
  const hedgeRow = (a, b, y = H) => { seg(M.concrete, a, b, y + 0.3, 0.6, 1.1); for (const p of L.alongPolyline([a, b], 1.2, 0.6)) inst.add('lm_mpGreen', S.HEDGE_GEO, M.hedge, p.x, y + 0.75, p.z, rng.range(0, 3), 1.4, 0.8, 1.2); };
  for (let z = -116; z > -152; z -= 6.5) { tree(86.2, z, 0.95 + rng() * 0.15); if (z < -118) lamp(84.4, z - 3.2); }
  for (const [x, z, s] of [[102.6, -111.6, 0.9], [110.2, -124, 0.75], [113.2, -130.5, 0.75], [116.4, -137.6, 0.9], [119.4, -143, 0.85]]) tree(x, z, s);
  hedgeRow([91, -116.2], [101, -116.2]);
  for (let z = -174; z > -218; z -= 6.2) { tree(87.2, z, 1 + rng() * 0.15); lamp(85.3, z - 3); }
  for (let z = -181; z > -196; z -= 5) tree(131, z, 0.95);
  for (const x of [92, 100]) tree(x, -216.5, 1.05);
  for (const z of [-150, -156]) tree(126, z, 0.85);
  for (let z = -120; z > -150; z -= 9) bench(89.4, z);
  for (let z = -183; z > -195; z -= 5) { bench(90.6, z); bench(127.6, z); }
  for (const x of [120, 125]) lamp(x, -159.2); for (const x of [120, 125]) lamp(x, -168.8);

  // ---------------------------------------------------------------------------------------------- roof: South block
  {
    const e = D.ROOF.escalatorHouse, ex = (e.x0 + e.x1) / 2, ez = (e.z0 + e.z1) / 2;
    batch.add(M.interior, L.extrudePolygon(L.rectPoly(ex, ez, e.x1 - e.x0 - 0.6, e.z0 - e.z1 - 0.6, 0), H, H + 3.4, { cap: false }), ex, ez);
    batch.add(M.glassClear, L.extrudePolygon(L.rectPoly(ex, ez, e.x1 - e.x0, e.z0 - e.z1, 0), H + 0.05, H + 3.5, { cap: false }), ex, ez);
    box(M.whiteMetal, ex, H + 3.7, ez, e.x1 - e.x0 + 1.4, 0.4, e.z0 - e.z1 + 1.4, 0, true);
    col(ex, ez, e.x1 - e.x0, 3.6, e.z0 - e.z1, H);
    S.signQuad(batch, ex, H + 3.7, e.z1 - 0.72, 0, -1, { text: 'MIYASHITA PARK', sub: 'SOUTH  ↓ RAYARD 1F–3F', w: 6, h: 0.36, bg: '#f4f4f0', fg: '#111111', emissive: 0.9, weight: '800' });
  }
  {
    // skate park: concrete bed, two quarter pipes with coping decks, a manual pad, a flat rail, a funbox
    const k = D.ROOF.skate, kx = (k.x0 + k.x1) / 2, kz = (k.z0 + k.z1) / 2, kd = k.z0 - k.z1 - 1, kl = k.x1 - k.x0 - 2;
    box(M.concrete, kx, H + 0.15, kz, k.x1 - k.x0, 0.3, k.z0 - k.z1, 0, true);
    batch.add(M.concrete, quarterPipe(kx, H + 0.3, kz - kd / 2 + 2.2, kl, 2.2, Math.PI), kx, kz);
    batch.add(M.concrete, quarterPipe(kx, H + 0.3, kz + kd / 2 - 2.2, kl, 2.2, 0), kx, kz);
    for (const s2 of [-1, 1]) { batch.add(M.concrete, L.boxAt(kx, H + 1.4, kz + s2 * (kd / 2 + 0.4), kl, 2.2, 0.8, 0, true), kx, kz); box(M.silver, kx, H + 2.55, kz + s2 * kd / 2, kl, 0.08, 0.08, 0, false); }
    box(M.concrete, kx - 4, H + 0.6, kz, 3, 0.6, 2, 0.3, true);
    box(M.silver, kx + 3.5, H + 0.75, kz, 0.08, 0.08, 5, 0, false);
    for (const dz of [-2, 2]) S.ibox(inst, 'lm_mpPole', M.silver, kx + 3.5, H + 0.3, kz + dz, 0.06, 0.45, 0.06);
    batch.add(M.concrete, S.placed(new THREE.BoxGeometry(3, 0.8, 3.2), kx + 0.2, H + 0.55, kz, { rz: 0 }), kx, kz);
    for (const s2 of [-1, 1]) batch.add(M.concrete, S.placed(new THREE.BoxGeometry(2.2, 0.1, 3.2), kx + 0.2 + s2 * 2.5, H + 0.62, kz, { rz: s2 * -0.34 }), kx, kz);
    for (const [x0, x1] of [[k.x0, k.x1]]) for (const z of [k.z0 + 0.1, k.z1 - 0.1]) { box(M.darkMetal, (x0 + x1) / 2, H + 1.0, z, x1 - x0, 2.0, 0.03, 0, false); }
  }
  {
    // bouldering wall: 12 m, 4.6 m high, overhanging north over the crash mats (the skate park is behind it)
    const b = D.ROOF.boulder, bx = (b.x0 + b.x1) / 2, bw = b.x1 - b.x0;
    box(M.concrete, bx, H + 2.3, b.z, bw, 4.6, 0.4, 0, true);
    batch.add(M.stoneLight, S.placed(new THREE.BoxGeometry(bw, 2.2, 0.35), bx, H + 3.9, b.z - 0.45, { rx: 0.45 }), bx, b.z);
    const HOLD = ['#e8306a', '#ffd400', '#2a9df4', '#35c46a', '#ff7a1a', '#f4f4f4', '#8a4dff'];
    for (let q = 0; q < 70; q++) S.ibox(inst, 'lm_hold', M.whiteMetal, bx + rng.range(-bw / 2 + 0.4, bw / 2 - 0.4), H + rng.range(0.3, 3.0), b.z - 0.25, rng.range(0.2, 0.42), rng.range(0.14, 0.3), 0.18, rng.range(0, 3), HOLD[q % HOLD.length]);
    box(M.redPaint, bx, H + 0.12, b.z - 1.9, bw + 0.4, 0.24, 3.2, 0, true);
    col(bx, b.z, bw, 4.6, 0.5, H);
  }
  {
    // sand court (beach volleyball / futsal): sand bed, net across the middle, low fence
    const c = D.ROOF.sand, cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2;
    box(M.stoneLight, cx, H + 0.1, cz, c.x1 - c.x0, 0.2, c.z0 - c.z1, 0, true);
    for (const s2 of [-1, 1]) S.ibox(inst, 'lm_mpPole', M.silver, cx, H, cz + s2 * 4.6, 0.1, 2.5, 0.1);
    box(M.darkMetal, cx, H + 2.05, cz, 0.03, 0.9, 9, 0, false);
    box(M.whiteMetal, cx, H + 2.5, cz, 0.05, 0.06, 9, 0, false);
    for (const z of [c.z0 + 0.1, c.z1 - 0.1]) box(M.darkMetal, cx, H + 0.6, z, c.x1 - c.x0, 1.2, 0.03, 0, false);
  }
  {
    // MIYASHITA PARK CENTER (the park office / toilets) at the stair head
    const c = D.ROOF.center, cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2;
    box(M.panelWhite, cx, H + 1.8, cz, c.x1 - c.x0, 3.6, c.z0 - c.z1, 0, true);
    batch.add(M.interior, L.wallQuad(c.x1 + 0.02, H + 1.5, cz, 1, 0, c.z0 - c.z1 - 1, 2.6, 0.01), c.x1, cz);
    box(M.whiteMetal, cx, H + 3.75, cz, c.x1 - c.x0 + 1, 0.3, c.z0 - c.z1 + 1, 0, true);
    S.signQuad(batch, c.x1 + 0.52, H + 3.2, cz, 1, 0, { text: 'MIYASHITA PARK CENTER', w: 4.6, h: 0.35, bg: '#f4f4f0', fg: '#111111', emissive: 0.9, weight: '800' });
    col(cx, cz, c.x1 - c.x0, 3.6, c.z0 - c.z1, H);
  }

  // ---------------------------------------------------------------------------------------------- roof: North block
  {
    // STARBEANS COFFEE pavilion by the stair head: lit glass box under a thin white roof with deep eaves, terrace deck
    const s = D.ROOF.starbeans, sx = (s.x0 + s.x1) / 2, sz = (s.z0 + s.z1) / 2, sw = s.x1 - s.x0, sd = s.z0 - s.z1;
    batch.add(M.interior, L.extrudePolygon(L.rectPoly(sx, sz, sw - 0.6, sd - 0.6, 0), H, H + 3.6, { cap: false }), sx, sz);
    batch.add(M.glassClear, L.extrudePolygon(L.rectPoly(sx, sz, sw, sd, 0), H + 0.05, H + 3.7, { cap: false }), sx, sz);
    box(M.whiteMetal, sx, H + 3.95, sz, sw + 3, 0.3, sd + 2.6, 0, true);
    for (let x = s.x0 - 1.2; x <= s.x1 + 1.2; x += 0.5) box(M.wood, x, H + 3.72, sz, 0.08, 0.16, sd + 2.4, 0, false);   // timber louvre soffit
    box(M.wood, s.x0 - 3.8, H + 0.12, sz, 7.4, 0.24, sd, 0, true);
    for (const [x, z] of [[s.x0 - 2, sz - 1.6], [s.x0 - 5, sz - 1.6], [s.x0 - 2, sz + 1.6], [s.x0 - 5, sz + 1.6]]) { box(M.whiteMetal, x, H + 0.95, z, 0.9, 0.05, 0.9, 0, false); S.ibox(inst, 'lm_stool', M.darkMetal, x, H + 0.24, z, 0.1, 0.7, 0.1); }
    S.signQuad(batch, sx, H + 4.3, s.z0 + 1.35, 0, 1, { text: 'STARBEANS COFFEE', sub: 'MIYASHITA PARK', w: 6.4, h: 0.6, bg: '#0b3d2e', fg: '#f5f1e6', emissive: 1.1, weight: '900' });
    S.signQuad(batch, s.x1 + 1.55, H + 4.3, sz, 1, 0, { text: 'STARBEANS COFFEE', w: 5, h: 0.5, bg: '#0b3d2e', fg: '#f5f1e6', emissive: 1.1, weight: '900' });
    col(sx, sz, sw, 3.8, sd, H);
  }
  {
    const w = D.ROOF.lawn;
    batch.add(M.lawn, L.polygonCap(L.rectPoly((w.x0 + w.x1) / 2, (w.z0 + w.z1) / 2, w.x1 - w.x0, w.z0 - w.z1, 0), H + 0.05, 0.25), (w.x0 + w.x1) / 2, (w.z0 + w.z1) / 2);
    for (const [a, b] of [[[w.x0, w.z0], [w.x1, w.z0]], [[w.x0, w.z1], [w.x1, w.z1]], [[w.x0, w.z0], [w.x0, w.z1]], [[w.x1, w.z0], [w.x1, w.z1]]]) seg(M.concrete, a, b, H + 0.1, 0.2, 0.25);
  }
  {
    // hotel "sequense": slab from the park level to 75.1 m; lit lobby storey at the park level; white frame grid
    const T = D.HOTEL, hp = [[T.x0, T.z0], [T.x1, T.z0], [T.x1, T.z1], [T.x0, T.z1]], hx = (T.x0 + T.x1) / 2, hz = (T.z0 + T.z1) / 2;
    batch.add(M.interior, L.extrudePolygon(L.offsetPolygon(L.ensureCW(hp), -0.6), H, H + 4.4, { cap: false }), hx, hz);
    S.prism(batch, M.glassClear, hp, H + 0.05, H + 4.4, { cap: false });
    S.prism(batch, M.glassTower3, hp, H + 4.4, T.top, { uvScale: 1 / 3.2 });
    box(M.whiteMetal, hx, H + 4.6, hz, T.x1 - T.x0 + 1.2, 0.5, T.z0 - T.z1 + 1.2, 0, true);
    S.fins(inst, 'lm_finWhite', M.whiteMetal, hp, H + 4.8, T.top, 1.6, { w: 0.25, d: 0.6, out: 0.2 });
    S.rings(batch, M.whiteMetal, hp, H + 7.8, T.top - 1, 3.2 * 2, { out: 0.4, h: 0.3 });
    S.parapet(batch, M.whiteMetal, hp, T.top, { h: 1.4, t: 0.35, out: 0.3 });
    S.roofPlant(batch, inst, hp, T.top, { seed: 902, tanks: 1, ac: 4, ducts: 1, rail: true, inset: 1.5 });
    S.flatSign(group, hx, T.top - 2.6, T.z0 + 0.72, 0, 1, { text: 'sequense', sub: 'MIYASHITA PARK', w: 10, h: 2.2, bg: '#161616', fg: '#ffffff', emissive: 1.1, weight: '700', letterSpacing: 4 });
    S.flatSign(group, T.x1 + 0.72, T.top - 2.6, hz, 1, 0, { text: 'sequense', w: 8, h: 1.6, bg: '#161616', fg: '#ffffff', emissive: 1.1, weight: '700', letterSpacing: 4 });
    col(hx, hz, T.x1 - T.x0, T.top - H, T.z0 - T.z1, H);
  }

  // ---------------------------------------------------------------------------------------------- footbridges
  for (const B of D.BRIDGES) {
    const len = B.x1 - B.x0, bx = (B.x0 + B.x1) / 2, W = 3.6, y = LV[1];
    box(M.whiteMetal, bx, y - 0.45, B.z, len, 0.8, W, 0, false);                                  // box girder
    box(M.stoneLight, bx, y - 0.02, B.z, len, 0.04, W - 0.2, 0, true);
    for (const s of [-1, 1]) {
      box(M.whiteMetal, bx, y + 0.25, B.z + s * (W / 2 - 0.1), len, 0.5, 0.2, 0, true);
      box(M.glassClear, bx, y + 0.85, B.z + s * (W / 2 - 0.1), len, 0.7, 0.04, 0, false);
      box(M.silver, bx, y + 1.25, B.z + s * (W / 2 - 0.1), len, 0.06, 0.08, 0, false);
      S.signQuad(batch, bx, y - 0.45, B.z + s * (W / 2 + 0.02), 0, s, { text: B.plate, w: 3.6, h: 0.42, bg: '#e6e6e2', fg: '#1a1a1a', emissive: 0.35, weight: '900', letterSpacing: 3 });
    }
    for (let x = B.x0 + 2; x < B.x1 - 1; x += 4) S.ibox(inst, 'lm_downlight', M.glowWarm, x, y - 0.88, B.z, 0.3, 0.04, 0.3);
    col(bx, B.z, len, 2.2, W, y - 0.85);
    propFree.push([[B.x0, B.z - 2.6], [B.x1 + 0.5, B.z - 2.6], [B.x1 + 0.5, B.z + 2.6], [B.x0, B.z + 2.6]]);   // no lamp / tree under the deck
    for (const st of B.stairs) {                                                                 // stair down the pavement
      const zt = B.z - st.dir * W / 2, run = 11, zb = zt - st.dir * run;
      flight(st.x, FY, zb, st.x, y, zt, 2.2, {});
      propFree.push([[st.x - 1.7, Math.min(zb, zt) - 0.8], [st.x + 1.7, Math.min(zb, zt) - 0.8], [st.x + 1.7, Math.max(zb, zt) + 0.8], [st.x - 1.7, Math.max(zb, zt) + 0.8]]);
      for (const t of [0.55, 0.85]) { const z = zb + (zt - zb) * t; box(M.whiteMetal, st.x, (y * t - 0.4) / 2, z, 0.4, y * t - 0.4, 0.4, 0, false); col(st.x, z, 0.45, 3, 0.45); }
    }
    if (B.x0 < 130) { const px = 135.4; box(M.whiteMetal, px, (y - 0.85) / 2, B.z, 0.6, y - 0.85, 0.6, 0, false); col(px, B.z, 0.65, 4, 0.65); }
  }

  // ---------------------------------------------------------------------------------------------- the North block yard
  // (between the tracks and the North block: service only, fenced off the passage)
  {
    box(M.darkMetal, 80, 1.1, D.Z.p1 - 0.3, 8, 2.2, 0.05, 0, false);
    for (let x = 76.4; x <= 84; x += 1.9) S.ibox(inst, 'lm_mpFence', M.darkMetal, x, 0, D.Z.p1 - 0.3, 0.08, 2.3, 0.08);
    col(80, D.Z.p1 - 0.3, 8, 2.3, 0.3);
  }

  const px = data.pos[0], pz = data.pos[1];
  const anchors = { yokocho: new THREE.Vector3(85.25 - px, 4.45, -131 - pz), stair: new THREE.Vector3(118 - px, LV[1], -164 - pz), hotelTop: new THREE.Vector3((D.HOTEL.x0 + D.HOTEL.x1) / 2 - px, D.HOTEL.top, (D.HOTEL.z0 + D.HOTEL.z1) / 2 - pz) };
  void key;
  return { group: new THREE.Group(), worldSpace: true, colliders, lights, anchors, facades };
}

export default { build, KEYS, SIZE };
