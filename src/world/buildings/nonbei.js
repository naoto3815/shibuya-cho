// [city] のんべい横丁 — ~70 tiny 2-storey wooden bars (2.2 × 2.4 m plan, 5.2 m) in four rows along the two lanes
// squeezed between the JR viaduct wall and 渋谷東映プラザ: dark doorway, noren, red lantern, name plate from the
// fascia atlas, upstairs window + AC unit, tin roof; lantern strings over both lanes and the wooden 「のんべい横丁」
// gate at the south end of each lane. Bar names cycle the T.bar pool.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases } from './genericBuilding.js';

export const KEYS = ['nonbei'];
export const SIZE = { w: 14, d: 42, h: 7 };

export function build({ key, data, batch, inst, group, rng, pools, CITY }) {
  const M = S.mats(), At = getAtlases();
  const lanes = (data.lanes || []).map(id => (CITY.pedestrianStreets || []).find(p => p.id === id)).filter(Boolean);
  if (lanes.length < 2) return null;
  const names = (pools && pools.bar) || ['のんべい'];
  const [w, e] = lanes;                                       // west lane (x≈78) and east lane (x≈86)
  const zA = Math.max(w.path[0][1], e.path[0][1]) - 2.5, zB = Math.min(w.path[1][1], e.path[1][1]) + 1;   // −36.5 … −75
  const wx = w.path[0][0], ex = e.path[0][0];
  const BW = 2.2, BD = 2.4, BH = 5.2;
  // rows: [x of the bar centre, facing sign (+1 east / −1 west)] — the west lane backs onto the JR viaduct piers
  const rows = [[wx + w.width / 2 + BD / 2 + 0.1, -1], [ex - e.width / 2 - BD / 2 - 0.1, 1], [ex + e.width / 2 + BD / 2 + 0.1, -1]];
  const colliders = [];
  const lit = At.win.cells.normal.filter(c => c.lit), dark = At.win.cells.normal.filter(c => !c.lit);
  const norenCols = [0x1a3a8a, 0xc8102e, 0x2a6a3a, 0x3a2a1a, 0xe8e0c8, 0x6a1a5a, 0x1a1a1a];
  let n = 0;
  for (const [rx, fx] of rows) {
    const nBars = Math.floor((zA - zB) / (BW + 0.05));
    for (let i = 0; i < nBars; i++) {
      const cz = zA - (i + 0.5) * (BW + 0.05);
      const h = BH + (L.hash(i, rx | 0, 3) - 0.5) * 0.6;
      const name = names[n % names.length] + (n >= names.length ? ` ${['本店', '2号店', '別館', '離れ'][(n / names.length | 0) % 4]}` : '');
      batch.add(M.wood, L.boxAt(rx, h / 2, cz, BD, h, BW, 0, true), rx, cz);
      batch.add(M.darkMetal, L.boxAt(rx + fx * 0.15, h + 0.12, cz, BD + 0.5, 0.16, BW + 0.1, 0, false), rx, cz);          // tin roof
      const wx0 = rx + fx * BD / 2;                                                                                  // front wall x
      batch.add(M.darkMetal, L.wallQuad(wx0, 1.1, cz + 0.45, fx, 0, 0.9, 2.1, 0.03), rx, cz);                         // doorway
      batch.add(M.interior, L.wallQuad(wx0, 1.1, cz + 0.45, fx, 0, 0.5, 1.9, 0.02), rx, cz);
      inst.add('lm_noren', S.UNIT_BOX, M.whiteMetal, wx0 + fx * 0.06, 1.7, cz + 0.45, 0, 0.05, 0.85, 1.0, norenCols[n % norenCols.length]);
      S.lantern(inst, wx0 + fx * 0.25, 2.25, cz - 0.6);
      const uv = At.fascia.get(name, 400 + n);
      batch.add(At.fascia.mat, L.wallQuad(wx0, 2.85, cz, fx, 0, BW - 0.3, 0.42, 0.05, [uv.u0, uv.v0, uv.u1, uv.v1]), rx, cz);
      const cells = L.hash(n, 7, 9) < 0.55 ? lit : dark, cell = cells[n % cells.length];
      batch.add(At.win.mat, L.wallQuad(wx0, 4.0, cz + 0.2, fx, 0, 1.1, 0.9, 0.04, [cell.u0, cell.v0, cell.u1, cell.v1]), rx, cz);
      if (L.hash(n, 11, 9) < 0.6) inst.add('ac', At.geos.ac, At.acMat, wx0, 3.55, cz - 0.7, Math.atan2(fx, 0), 0.8, 0.8, 0.8, 0xd0d0cc);
      if (L.hash(n, 13, 9) < 0.5) batch.add(M.darkMetal, L.boxAt(wx0 + fx * 0.3, 3.3, cz, 0.05, 0.05, BW - 0.4, 0, false), rx, cz);   // wire
      n++;
    }
    colliders.push(S.boxCollider(rx, (zA + zB) / 2, BD + 0.2, BH, zA - zB));
  }
  // lantern strings over the lanes + gates at the south end
  for (const lane of lanes) {
    const lx = lane.path[0][0];
    for (const p of L.alongPolyline([[lx, zA - 1], [lx, zB + 1]], 2.6, 1.2)) { S.lantern(inst, p.x, 3.6, p.z); batch.add(M.darkMetal, L.boxAt(p.x, 4.05, p.z, lane.width + BD, 0.04, 0.04, 0, false), p.x, p.z); }
    const gz = zA + 0.6, gw = lane.width + 1.2;
    for (const sg of [-1, 1]) { batch.add(M.wood, L.boxAt(lx + sg * gw / 2, 2.2, gz, 0.25, 4.4, 0.25, 0, true), lx, gz); colliders.push(S.boxCollider(lx + sg * gw / 2, gz, 0.35, 4.4, 0.35)); }
    batch.add(M.wood, L.boxAt(lx, 4.4, gz, gw + 0.6, 0.3, 0.35, 0, true), lx, gz);
    S.flatSign(group, lx, 3.75, gz + 0.2, 0, 1, { text: 'のんべい横丁', sub: 'NONBEI YOKOCHO', w: gw - 0.2, h: 0.75, bg: '#2a1a10', fg: '#ffcf70', emissive: 1.3, weight: '900', double: true });
    S.lantern(inst, lx - gw / 2 + 0.3, 3.3, gz + 0.3);
    S.lantern(inst, lx + gw / 2 - 0.3, 3.3, gz + 0.3);
  }
  // a few warm lights down each lane (the lanterns are emissive only)
  const lights = [];
  for (const lane of lanes) for (const z of [zA - 8, zA - 22, zA - 36]) { const l = new THREE.PointLight(0xff8a3c, 5, 9, 2); l.position.set(lane.path[0][0], 3.4, z); lights.push(l); }
  void rng; void key;
  const anchors = { gate: new THREE.Vector3(wx - data.pos[0], 3.75, zA + 0.8 - data.pos[1]), gateNormal: new THREE.Vector3(0, 0, 1) };
  return { group: new THREE.Group(), worldSpace: true, colliders, lights, anchors, facades: [] };
}

export default { build, KEYS, SIZE };
