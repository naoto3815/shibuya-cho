// [city] センター街 (Basketball Street) entrance gate: two stainless posts over the 10 m mouth, a shallow steel arch
// truss crown, the red-pink 「渋谷センター街 Basketball Street」 plate read from both sides (signage), can spotlights, side plates. World-space
// batched geometry; group origin = gate position (anchors local).
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';

export const KEYS = ['centerGaiGate'];
export const SIZE = { w: 12, d: 2, h: 9 };
const Y_UP = new THREE.Vector3(0, 1, 0);
const CAN_GEO = new THREE.CylinderGeometry(0.12, 0.1, 0.28, 14);
const LENS_GEO = new THREE.CircleGeometry(0.088, 14).rotateX(-Math.PI / 2);
/** Round steel member between two points (open ends). */
function strut(a, b, r) {
  const d = b.clone().sub(a), l = d.length();
  const g = new THREE.CylinderGeometry(r, r, l, 8, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y_UP, d.divideScalar(l)));
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

let STEEL = null;
/** Brushed stainless: fine vertical hairline grain in the albedo + roughness (anisotropic-looking streaks). */
function steelMat() {
  if (STEEL) return STEEL;
  const c = L.makeCanvas(64, 256), x = c.getContext('2d'), r = L.makeCanvas(64, 256), y = r.getContext('2d');
  x.fillStyle = '#c4c8cc'; x.fillRect(0, 0, 64, 256); y.fillStyle = 'rgb(0,90,0)'; y.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 64; i++) { const v = L.hash(i, 1, 71); x.fillStyle = `rgba(${v < 0.5 ? '255,255,255' : '40,44,50'},${0.05 + L.hash(i, 2, 71) * 0.12})`; x.fillRect(i, 0, 1, 256); y.fillStyle = `rgb(0,${60 + L.hash(i, 3, 71) * 80 | 0},0)`; y.fillRect(i, 0, 1, 256); }
  STEEL = L.std({ map: L.canvasTex(c, { wrap: true }), roughnessMap: L.canvasTex(r, { wrap: true, srgb: false }), roughness: 1, metalness: 0.62, envMapIntensity: 1.6 });
  STEEL.name = 'lm_brushedSteel';
  return STEEL;
}

export function build({ key, data, batch, group }) {
  const M = S.mats();
  const [gx, gz] = data.pos;
  const [fx, fz] = S.dirOf(data.rotY);                        // front = toward the crossing
  const tx = -fz, tz = fx;                                     // across the street
  const rot = L.rotYOf(tx, tz);
  const W = data.size[0] || 11, H = data.size[1] || 9;
  const half = W / 2;
  const colliders = [];
  const at = (lx, lz) => [gx + tx * lx + fx * lz, gz + tz * lx + fz * lz];
  // posts: brushed stainless shafts with dark banding every 1.2 m, a cast base collar + plinth, a capital ring
  const brushed = steelMat();
  for (const sg of [-1, 1]) {
    const [px, pz] = at(sg * half, 0);
    batch.add(brushed, S.placed(new THREE.CylinderGeometry(0.17, 0.2, H - 0.2, 16), px, 0.15 + (H - 0.2) / 2, pz), gx, gz);
    for (let y = 1.6; y < H - 1.2; y += 1.2) batch.add(M.darkMetal, S.placed(new THREE.CylinderGeometry(0.205, 0.205, 0.07, 16, 1, true), px, y, pz), gx, gz);
    batch.add(M.darkMetal, S.placed(new THREE.CylinderGeometry(0.26, 0.3, 0.55, 16), px, 0.15 + 0.4, pz), gx, gz);   // base collar
    batch.add(brushed, S.placed(new THREE.CylinderGeometry(0.31, 0.31, 0.05, 16), px, 0.15 + 0.7, pz), gx, gz);
    batch.add(M.darkMetal, L.boxAt(px, 0.15 + 0.06, pz, 0.8, 0.12, 0.8, rot, false), gx, gz);
    batch.add(M.darkMetal, S.placed(new THREE.CylinderGeometry(0.24, 0.2, 0.3, 16), px, H - 0.35, pz), gx, gz);   // capital
    colliders.push(S.boxCollider(px, pz, 0.6, H, 0.6, rot));
  }
  // the lettered plate + its frame come from the signage module (pedestrianStreets.centergai.gate, plate centre at
  // H − 2.2): the city adds the crown above it — a shallow steel arch truss (two tube chords springing from the post
  // capitals, the lower one rising 1.1 m, the upper 1.3 m, with a zig-zag web between them), hangers down to the
  // plate beam, an LED line under the lower chord and three can spotlights pitched down at the lettering
  const py = H - 2.2;
  const SPR_LO = H - 0.9, SAG_LO = 1.1, SPR_HI = H - 0.2, SAG_HI = 1.3, span = half + 0.1;
  const arcY = (lx, spring, sag) => { const R = (span * span + sag * sag) / (2 * sag); return spring + sag - R + Math.sqrt(Math.max(0, R * R - lx * lx)); };
  const P3 = (lx, y, lz = 0) => { const [x, z] = at(lx, lz); return new THREE.Vector3(x, y, z); };
  const chord = (spring, sag, r, lz = 0, dy = 0) => new THREE.CatmullRomCurve3(Array.from({ length: 25 }, (_, i) => { const lx = -span + (2 * span * i) / 24; return P3(lx, arcY(lx, spring, sag) + dy, lz); }));
  batch.add(brushed, new THREE.TubeGeometry(chord(SPR_HI, SAG_HI, 0.13), 40, 0.13, 12, false), gx, gz);
  batch.add(brushed, new THREE.TubeGeometry(chord(SPR_LO, SAG_LO, 0.09), 40, 0.09, 10, false), gx, gz);
  const NP = 12;
  for (let k = 0; k < NP; k++) {
    const la = -span + (2 * span * k) / NP, lb = -span + (2 * span * (k + 1)) / NP;
    const a = k % 2 ? P3(la, arcY(la, SPR_HI, SAG_HI)) : P3(la, arcY(la, SPR_LO, SAG_LO)), b = k % 2 ? P3(lb, arcY(lb, SPR_LO, SAG_LO)) : P3(lb, arcY(lb, SPR_HI, SAG_HI));
    batch.add(brushed, strut(a, b, 0.045), gx, gz);
    if (k > 0) batch.add(brushed, strut(P3(la, arcY(la, SPR_LO, SAG_LO)), P3(la, arcY(la, SPR_HI, SAG_HI)), 0.035), gx, gz);   // verticals
  }
  // hangers from the lower chord down to the plate's top beam (signage frame at py + 1.15)
  for (const lx of [-3.8, 0, 3.8]) batch.add(M.darkMetal, strut(P3(lx, arcY(lx, SPR_LO, SAG_LO) - 0.08), P3(lx, py + 1.12), 0.028), gx, gz);
  // LED line following the arch under the lower chord (lights the plate edge, reads at 20 m)
  batch.add(M.glowWhite, new THREE.TubeGeometry(chord(SPR_LO, SAG_LO, 0.02, 0, -0.12), 40, 0.022, 6, false), gx, gz);
  // can spotlights: dark housings on a yoke under the lower chord, 0.9 m in front of the plate, pitched down at the
  // lettering; only a small lens disc on the underside glows
  for (const lx of [-3.6, 0, 3.6]) for (const side of [1, -1]) {
    const hang = P3(lx, arcY(lx, SPR_LO, SAG_LO) - 0.1, side * 0.2), can = P3(lx, hang.y - 0.34, side * 0.95);
    const aim = P3(lx * 0.92, py + 0.2, side * 0.2).sub(can).normalize();
    batch.add(M.darkMetal, strut(hang, can.clone().addScaledVector(aim, -0.12), 0.022), gx, gz);   // yoke arm
    batch.add(M.darkMetal, S.placed(CAN_GEO, 0, 0, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y_UP, aim)).translate(can.x, can.y, can.z), gx, gz);
    batch.add(M.glowWarm, S.placed(LENS_GEO, 0, 0, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y_UP, aim)).translate(can.x + aim.x * 0.151, can.y + aim.y * 0.151, can.z + aim.z * 0.151), gx, gz);
  }
  // post plates (lit low: a white face at full emissive clips to a bloom bar at 40 m)
  for (const sg of [-1, 1]) {
    const [px, pz] = at(sg * (half - 0.35), 0);
    S.flatSign(group, px + fx * 0.02, 3.2, pz + fz * 0.02, tx * -sg, tz * -sg, { text: 'センター街', sub: '商店街振興組合', w: 0.5, h: 2.6, bg: '#e8e2d6', fg: '#c8102e', vertical: true, emissive: 0.42, weight: '800', double: true });
  }
  const anchors = {
    gateSign: new THREE.Vector3(fx * 0.4, py, fz * 0.4), gateSignBack: new THREE.Vector3(-fx * 0.4, py, -fz * 0.4), gateNormal: new THREE.Vector3(fx, 0, fz), width: W,
    // the crown arch (local to the gate position): a sign that wants to follow it can bend its top edge to
    // y(lx) = spring + sagitta − R + √(R² − lx²), R = (span² + sagitta²) / (2 sagitta), lx across the street
    arch: { span, spring: SPR_LO, sagitta: SAG_LO, upperSpring: SPR_HI, upperSagitta: SAG_HI, across: new THREE.Vector3(tx, 0, tz) },
  };
  void key;
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades: [] };
}

export default { build, KEYS, SIZE };
