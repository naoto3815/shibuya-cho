import { fitHeroFace, heroHeadNormals, applyHeroFaceMaterial, applyHeroFaceV4, heroFaceAttr, heroFaceMapBase, heroCardGroups, HERO_FACE_MODE, HERO_FACE_SRC } from './heroFace.js';
import { fitHeroKnees } from './heroSkinning.js';
import { heroBodyY, heroJoints, HERO_HEIGHT, HERO_ASSET_HEIGHT } from './heroProportions.js';
// [character] Procedural rigged humanoid: real THREE.Skeleton + SkinnedMesh with a lofted cross-section body, Mixamo bone
// names (§6). Bind pose = relaxed A-pose, 1.80 m tall, facing +z, feet at y=0. Bone local +Y points down the bone
// toward its child; local +Z ≈ world +Z (forward) so animation deltas are: X = swing forward(+)/back, Y = twist, Z = abduct.
//   createHumanoid({variant, seed, detail}) -> { group, skinned, skeleton, bones, mixer, play(name, opts), current(), setWeapon(mesh),
//                                              attach(name, mesh, bone, offset), detach(name), setProp(kind), dropProp(scene), height, dispose() }
//   Variants: 'kento' = 渋沢 健人, the hero (docs/HERO.md; 'kiryu' is kept as a legacy alias), 'chinpira', 'yakuza', 'boss', 'pedestrian'.
//   setProp('briefcase'|'phone'|'cigarette') parents the item to its slot bone (briefcase = LEFT hand); dropProp() stands it
//   on the ground at his feet (fight start). PROP_SLOTS holds the bone + offset per kind.
//   RIG  { names[], parent{}, world{}, local{ name: {position, quaternion} }, index{} }  (used by animations.js)
//   humanoid.all[]  every live humanoid (module.update advances their mixers);  makeProp('briefcase'|'phone'|'cigarette')
//   shotPresets.character_lineup / character_kento*, selfTest(engine)
// Body: every part is a loft of cross-section rings (smooth normals, uv u = around / v = metres along) skinned with
// per-vertex two-bone smoothstep weights (±6-8 cm) at every joint. Per humanoid the rig is re-derived from the variant's
// proportions (shoulderW / torsoLen / legLen / posture): clips are deltas from bind so they apply unchanged; the hips joint
// stays at 0.98 so the hips position track matches and the mesh is lifted so the feet sit on y=0.
// Head = sculpted rings (brow, sockets, zygomatic, nose, lips, chin, jaw), eyeballs, lofted ears, hair shell + fringe locks;
// hands = palm with MCP knuckles + curled fingers (own uv strips: nails, creases); materials from materials.js (suit/shirt/cloth/
// skin/hair/shoes/leather/rubber) + a painted face atlas (albedo + ORM, 512², 1024² for the hero) on the skin material.
// Per character: 7 draw calls — the hero's black shoes / brown belt and his navy tie / pocket square share one material each
// through a per-vertex colour attribute (see tintOf/vcolor).
//
// PEDESTRIAN OPTIONS API (stable; crowd.js builds its instanced twin from the same record):
//   createHumanoid({ variant: 'pedestrian', seed, fem, outfit, hair, hairColor, skin, height, build, accessories, age, detail, lod })
//     seed        int      every field below is a deterministic function of the seed when the option is omitted, and
//                          passing one option never shifts another (resolvePedestrian draws its whole budget up front)
//     fem         bool     the female frame (waist / hips / bust, the softer sculpt, blouse-and-skirt templates)
//     outfit      PED_OUTFITS = 'suit' | 'hoodie' | 'blouson' | 'cardigan' | 'dress' | 'school' | 'staff' | 'tourist'
//                          (a dress on a man builds as 'blouson'; 'school' on anyone past 20 falls back to suit / hoodie)
//     hair        PED_HAIRS = 'short' | 'parted' | 'swept' | 'bob' | 'tied' | 'cap'   (real geometry, sitting on the skull)
//     hairColor   key of PED_HAIR_COLORS ('black' | 'dark' | 'brown' | 'ash' | 'grey') or a hex
//     skin        0..4 into PED_SKIN_TONES (fair .. tan)     height  metres 1.35..2.05     build  0.7..1.35
//     accessories subset of ['bag', 'phone', 'umbrella']     age     0..1 (>= 0.6 is old: grey, gaunt, stooped)
//   resolvePedestrian(opts) -> the LOOK: { seed, fem, age, old, outfit, hair, hairKey, hairColor, skin, skinRGB, height,
//     build, accessories, colours: { top, bottom, inner, shoe, sole, accent, coat, legwear, bag, cap }, cut: { top, coat,
//     bottom, legwear, shoe, sleeve, hem, coatHem, skirtHem, pleats, tie, hood, bag, garment, topGarment, trouserGarment },
//     face: {...}, shoulderW, torsoLen, legLen, gut, posture }.  No garment colour in PED_PAL reads as skin.
//   Draw calls per body <= 7 whatever it wears (skin, eye [LOD0 only], hair, shoes, and at most three cloth slots).
//   ?shot=pedestrian_lineup | pedestrian_faces | pedestrian_faces_f | pedestrian_back   ?test=humanoid sweeps every template.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const BONE_NAMES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];

// world-space bind joints (metres). Left = +x (character faces +z, y up).
const JOINTS = {
  Hips: [0, 0.98, 0], Spine: [0, 1.08, 0], Spine1: [0, 1.20, 0], Spine2: [0, 1.34, 0], Neck: [0, 1.50, 0], Head: [0, 1.58, 0],
  LeftShoulder: [0.05, 1.47, 0], LeftArm: [0.21, 1.46, 0], LeftForeArm: [0.29, 1.19, 0], LeftHand: [0.36, 0.93, 0],
  RightShoulder: [-0.05, 1.47, 0], RightArm: [-0.21, 1.46, 0], RightForeArm: [-0.29, 1.19, 0], RightHand: [-0.36, 0.93, 0],
  LeftUpLeg: [0.10, 0.95, 0], LeftLeg: [0.10, 0.50, 0], LeftFoot: [0.10, 0.08, 0], LeftToeBase: [0.10, 0.02, 0.13],
  RightUpLeg: [-0.10, 0.95, 0], RightLeg: [-0.10, 0.50, 0], RightFoot: [-0.10, 0.08, 0], RightToeBase: [-0.10, 0.02, 0.13],
};
const PARENT = {
  Hips: null, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
};
// direction target per bone (child joint, or a tip offset for leaf bones)
const AIM = {
  Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head', Head: [0, 0.22, 0],
  LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftHand: [0.04, -0.17, 0],
  RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightHand: [-0.04, -0.17, 0],
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: 'LeftToeBase', LeftToeBase: [0, 0, 0.09],
  RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'RightToeBase', RightToeBase: [0, 0, 0.09],
};

function orientation(dir) {
  const y = dir.clone().normalize();
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(y.dot(ref)) > 0.95) ref = new THREE.Vector3(0, 1, 0);
  const z = ref.clone().sub(y.clone().multiplyScalar(ref.dot(y))).normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export function buildRig(joints = JOINTS) {
  const world = {}, local = {}, index = {};
  BONE_NAMES.forEach((n, i) => { index[n] = i; });
  for (const n of BONE_NAMES) {
    const p = new THREE.Vector3(...joints[n]);
    const aim = AIM[n];
    const tip = Array.isArray(aim) ? p.clone().add(new THREE.Vector3(...aim)) : new THREE.Vector3(...joints[aim]);
    const q = orientation(tip.clone().sub(p));
    world[n] = { position: p, quaternion: q, tip, length: tip.distanceTo(p) };
  }
  for (const n of BONE_NAMES) {
    const par = PARENT[n];
    if (!par) { local[n] = { position: world[n].position.clone(), quaternion: world[n].quaternion.clone() }; continue; }
    const pw = world[par];
    const invQ = pw.quaternion.clone().invert();
    const pos = world[n].position.clone().sub(pw.position).applyQuaternion(invQ);
    const quat = invQ.clone().multiply(world[n].quaternion);
    local[n] = { position: pos, quaternion: quat };
  }
  return { names: BONE_NAMES, parent: PARENT, world, local, index, joints };
}
export const RIG = buildRig();
// Weight-shifted stance. `animations.js` writes absolute local quaternions derived from the shared RIG, so a clip wipes
// any rotation baked into the bind pose: the only asymmetry that survives is in joint POSITIONS (and, for a single-child
// chain, only the bone length) plus the mesh itself. So the stance is (a) a pelvis roll on the two UpLeg joints, which
// are real offsets under Hips, and (b) a shear applied identically to the remaining joints and to the built geometry —
// bind pose and skeleton stay in step, and the silhouette is asymmetric with the mixer at t=0.
const stanceT = (y) => sstep((y - 0.98) / 0.34);
function shearJoint(S, p) {
  const t = stanceT(p[1]);
  p[1] += S.tilt * t * p[0];
  p[2] += S.twist * t * p[0];
}
function stanceFor(seed) {
  const rr = mulberry(((seed | 0) * 2654435761 + 0x9e3779b9) >>> 0);
  const sup = rr() < 0.5 ? 1 : -1;                    // +1 = weight on the left leg
  const k = 0.8 + rr() * 0.45;
  const toe = [0.145 + 0.05 * rr(), 0.112 + 0.05 * rr()];   // feet toe out ~8° / ~6.5°
  return {
    sup, k,
    roll: 0.080 * k * sup,                            // pelvis rolls ~4.5°: support hip up, free hip down (≈1.6 cm)
    tilt: -0.078 * k * sup,                           // shoulder line tilts against the hips
    twist: 0.060 * k * sup,                           // and the support-side shoulder comes forward
    yaw: 0.062 * k * sup, headRoll: -0.032 * k * sup, // head a few degrees off the shoulder line
    toe: sup > 0 ? toe : [toe[1], toe[0]],
  };
}
// per-humanoid proportions: arms out by shoulderW, everything above the hips stretched by torsoLen, shins/feet by legLen,
// neck/head forward by posture. Returns the rig, the stance and the lift that puts the feet back on y=0.
function rigFor(V, seed = 0) {
  // A variant may ship its own joint set (the hero's are measured off the client's mesh so the bones sit inside HIS
  // limbs). Clips are absolute local quaternions, so only the joint OFFSETS matter and they still apply unchanged.
  if (V.joints) {
    const S = stanceFor(seed);
    // (groundLift: a scan whose soles sit a few mm under the ground in the clips' stances — the story cast, measured)
    return { rig: buildRig(V.joints), lift: V.groundLift || 0, stance: { ...S, roll: 0, tilt: 0, twist: 0, yaw: 0, headRoll: 0, k: 0 } };
  }
  const sw = V.shoulderW || 1, tl = V.torsoLen || 1, ll = V.legLen || 1, post = V.posture || 0;
  const S = stanceFor(seed);
  const J = {};
  for (const n of BONE_NAMES) {
    let [x, y, z] = JOINTS[n];
    if (/Arm|Hand/.test(n)) x += Math.sign(x) * 0.21 * (sw - 1);
    if (!/Hips|UpLeg|Leg|Foot|Toe/.test(n)) y = 0.98 + (y - 0.98) * tl;
    if (/^(Left|Right)(Leg|Foot|ToeBase)$/.test(n)) y = 0.95 - (0.95 - y) * ll;
    if (n === 'Neck' || n === 'Head') z += post;
    J[n] = [x, y, z];
  }
  const hy = J.Hips[1], c = Math.cos(S.roll), s = Math.sin(S.roll);
  for (const n of ['LeftUpLeg', 'RightUpLeg']) {      // pelvis roll about the hips joint
    const p = J[n], dx = p[0], dy = p[1] - hy;
    p[0] = dx * c - dy * s; p[1] = hy + dx * s + dy * c;
  }
  J[(S.sup > 0 ? 'Right' : 'Left') + 'UpLeg'][1] -= 0.005 * S.k;   // the unweighted hip sits a touch lower still
  for (const n of BONE_NAMES) shearJoint(S, J[n]);
  return { rig: buildRig(J), lift: (ll - 1) * 0.87, stance: S };
}
// the same shear, on a built geometry (before binding, so it becomes the bind pose). Normals get the inverse transpose.
function stanceWarp(geo, S) {
  const p = geo.attributes.position, nr = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), t = stanceT(y);
    if (t <= 0) continue;
    const a = S.tilt * t, b = S.twist * t;
    p.setXYZ(i, x, y + a * x, p.getZ(i) + b * x);
    if (!nr) continue;
    const nx = nr.getX(i), ny = nr.getY(i), nz = nr.getZ(i);
    const vx = nx - a * ny - b * nz, l = Math.hypot(vx, ny, nz) || 1;
    nr.setXYZ(i, vx / l, ny / l, nz / l);
  }
  p.needsUpdate = true; if (nr) nr.needsUpdate = true;
  return geo;
}

// ---------------------------------------------------------------- small maths
const TAU = Math.PI * 2, HPI = Math.PI / 2;
const SIDES = ['Left', 'Right'];                     // hoisted: the per-frame loops used to allocate this literal
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const gauss = (x, s) => Math.exp(-(x * x) / (2 * s * s));
// signed angular distance to `a0` (wrapped)
const adiff = (a, a0) => { let d = a - a0; d -= Math.round(d / TAU) * TAU; return d; };
function mulberry(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// piecewise-linear table lookup: rows [[y, v0, v1, ...]] sorted by y -> [v0, v1, ...] at y (clamped)
function table(rows, y) {
  if (y <= rows[0][0]) return rows[0].slice(1);
  for (let i = 1; i < rows.length; i++) {
    if (y <= rows[i][0]) {
      const a = rows[i - 1], b = rows[i], t = sstep((y - a[0]) / (b[0] - a[0]));
      const out = []; for (let k = 1; k < a.length; k++) out.push(lerp(a[k], b[k], t));
      return out;
    }
  }
  return rows[rows.length - 1].slice(1);
}

// ---------------------------------------------------------------- skinning helpers
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();

// Chain of bones -> per-segment frames + a per-vertex weight function (two-bone smoothstep blend ±blend at each joint).
function chainSegs(R, chain, blend = 0.06, ref = null) {
  const segs = chain.map((n) => {
    const w = R.world[n];
    const d = w.tip.clone().sub(w.position).normalize();
    let r = ref || (Math.abs(d.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1));
    const u = new THREE.Vector3().crossVectors(r, d).normalize();
    const v = new THREE.Vector3().crossVectors(d, u).normalize();
    return { name: n, i: R.index[n], a: w.position, d, L: w.length, u, v, blend };
  });
  segs.forEach((s, k) => {
    s.w = (p) => {
      const t = _t.subVectors(p, s.a).dot(s.d), b = s.blend;
      if (k > 0 && t < b) { const f = sstep((t + b) / (2 * b)); return [[s.i, f], [segs[k - 1].i, 1 - f]]; }
      if (k < segs.length - 1 && t > s.L - b) { const f = sstep((t - (s.L - b)) / (2 * b)); return [[s.i, 1 - f], [segs[k + 1].i, f]]; }
      return [[s.i, 1]];
    };
  });
  return segs;
}
// ring on a chain segment at t metres from its joint, radii rx (along u) / ry (along v), optional centre offsets
function ring(seg, t, rx, ry, o = {}) {
  const c = seg.a.clone().addScaledVector(seg.d, t).addScaledVector(seg.u, o.ox || 0).addScaledVector(seg.v, o.oy || 0);
  return { c, u: seg.u, v: seg.v, rx, ry, shape: o.shape || null, w: o.w || seg.w, uScale: o.uScale };
}
// axis-aligned ring (u=+x, v=+z) used for torso / head parts; w = weight fn
function yring(y, rx, ry, w, o = {}) {
  return { c: new THREE.Vector3(o.ox || 0, y, o.oz || 0), u: X_AXIS, v: Z_AXIS, rx, ry, shape: o.shape || null, w, uScale: o.uScale };
}
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);

// Loft rings into an indexed tube: smooth normals (seam averaged), uv (u around * uScale, v metres along), skin attrs.
// Open lofts (a0..a1 < full turn) keep both edges; poles are tiny rings. Winding is auto-fixed to face outward.
function loft(rings, { segs = 24, a0 = 0, a1 = TAU, uv = [1, 1], flip = false } = {}) {
  const nR = rings.length, nA = segs + 1, closed = Math.abs((a1 - a0) - TAU) < 1e-6;
  const pos = new Float32Array(nR * nA * 3), uvs = new Float32Array(nR * nA * 2);
  const si = new Uint16Array(nR * nA * 4), sw = new Float32Array(nR * nA * 4);
  let along = 0;
  for (let j = 0; j < nR; j++) {
    const r = rings[j];
    if (j > 0) along += r.c.distanceTo(rings[j - 1].c);
    for (let i = 0; i < nA; i++) {
      const f = i / segs, a = a0 + (a1 - a0) * f;
      let dx, dy, dz = 0;
      if (r.shape) { const s = r.shape(a, f); dx = s[0]; dy = s[1]; dz = s[2] || 0; } else { dx = Math.cos(a) * r.rx; dy = Math.sin(a) * r.ry; }
      _p.copy(r.c).addScaledVector(r.u, dx).addScaledVector(r.v, dy);
      if (dz && r.n) _p.addScaledVector(r.n, dz);
      const k = j * nA + i;
      pos[k * 3] = _p.x; pos[k * 3 + 1] = _p.y; pos[k * 3 + 2] = _p.z;
      uvs[k * 2] = f * uv[0] * (r.uScale ?? 1); uvs[k * 2 + 1] = r.vv != null ? r.vv : along * uv[1];
      const ws = r.w(_p, r);
      let sum = 0; for (const [, w] of ws) sum += w;
      for (let q = 0; q < 4; q++) { si[k * 4 + q] = q < ws.length ? ws[q][0] : 0; sw[k * 4 + q] = q < ws.length ? ws[q][1] / (sum || 1) : 0; }
    }
  }
  const idx = [];
  for (let j = 0; j < nR - 1; j++) for (let i = 0; i < segs; i++) {
    const a = j * nA + i, b = a + 1, c = a + nA, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setIndex(idx);
  // winding: first non-degenerate quad must face away from its own ring's centroid (r.c can sit far off the ring —
  // the hair/head shells all share the chin-level centre — which used to flip the crown cap inward)
  let out = flip ? -1 : 1;
  for (let j = 0; j < nR - 1 && out !== 0; j++) {
    const a = j * nA, b = a + 1, c = a + nA;
    _e1.fromArray(pos, c * 3).sub(_p.fromArray(pos, a * 3)); _e2.fromArray(pos, b * 3).sub(_p);
    _n.crossVectors(_e1, _e2);
    if (_n.lengthSq() < 1e-14) continue;
    _t.set(0, 0, 0);
    for (let i = 0; i < segs; i++) _t.x += pos[(a + i) * 3], _t.y += pos[(a + i) * 3 + 1], _t.z += pos[(a + i) * 3 + 2];
    _t.multiplyScalar(-1 / segs);
    _t.x += pos[a * 3]; _t.y += pos[a * 3 + 1]; _t.z += pos[a * 3 + 2];
    if (_t.lengthSq() < 1e-10) continue;
    if (_n.dot(_t) * out < 0) g.setIndex(idx.map((v, i) => (i % 3 === 1 ? idx[i + 1] : i % 3 === 2 ? idx[i - 1] : v)));
    break;
  }
  g.computeVertexNormals();
  if (closed) {                                     // average the duplicated seam normals
    const n = g.attributes.normal;
    for (let j = 0; j < nR; j++) {
      const a = j * nA, b = a + segs;
      _n.set(n.getX(a) + n.getX(b), n.getY(a) + n.getY(b), n.getZ(a) + n.getZ(b)).normalize();
      n.setXYZ(a, _n.x, _n.y, _n.z); n.setXYZ(b, _n.x, _n.y, _n.z);
    }
  }
  return g;
}

// skin any plain geometry (spheres etc.) with a weight fn evaluated per vertex
function skinGeo(g, w) {
  const n = g.attributes.position.count, p = g.attributes.position;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const ws = w(_p.set(p.getX(i), p.getY(i), p.getZ(i)));
    let sum = 0; for (const [, x] of ws) sum += x;
    for (let q = 0; q < 4; q++) { si[i * 4 + q] = q < ws.length ? ws[q][0] : 0; sw[i * 4 + q] = q < ws.length ? ws[q][1] / (sum || 1) : 0; }
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return g;
}
const boneW = (name) => { const i = RIG.index[name]; return () => [[i, 1]]; };
// remap uvs of a geometry into an atlas rectangle (uvRect: assumes 0..1 input; uvFit: normalises the actual uv range first)
function uvRect(g, u0, v0, u1, v1) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return g;
}
function uvFit(g, u0, v0, u1, v1) {
  const uv = g.attributes.uv;
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (let i = 0; i < uv.count; i++) { const x = uv.getX(i), y = uv.getY(i); if (x < a) a = x; if (x > b) b = x; if (y < c) c = y; if (y > d) d = y; }
  const su = b > a ? 1 / (b - a) : 0, sv = d > c ? 1 / (d - c) : 0;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (uv.getX(i) - a) * su * (u1 - u0), v0 + (uv.getY(i) - c) * sv * (v1 - v0));
  return g;
}
// small disc (button) whose axis points along `normal`
function button(center, normal, r, h = 0.004, segs = 10) {
  const g = new THREE.CylinderGeometry(r, r * 0.9, h, segs);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y_AXIS, normal.clone().normalize()));
  g.translate(center.x, center.y, center.z);
  return g;
}

// ---------------------------------------------------------------- materials (materials.js library, cached; fallback if absent)
const matCache = new Map();
// Every material this module owns, so update() can drive their image-based lighting per time of day.
// r186 (WebGLRenderer, `material.envMap === null && scene.environment !== null`) OVERWRITES envMapIntensity with
// scene.environmentIntensity, so a per-material value is silently ignored — which is why a character standing in a
// building's shade got 0.18 of the sky and rendered as a black cut-out however high the number was set. Assigning
// material.envMap = scene.environment takes the material out of that branch and hands the control back.
const charMats = new Set();
const envState = { tex: undefined, intensity: -1 };
function envTrack(m, boost) { m.userData.envBoost = boost; charMats.add(m); return m; }
function syncEnv(scene) {
  if (!scene) return;
  const i = scene.environmentIntensity ?? 1;
  if (scene.environment === envState.tex && i === envState.intensity) return;
  const swap = scene.environment !== envState.tex;
  envState.tex = scene.environment; envState.intensity = i;
  for (const m of charMats) {
    if (swap) { m.envMap = scene.environment; m.needsUpdate = true; }
    m.envMapIntensity = (m.userData.envBoost ?? 1) * i;
  }
}
// ---------------------------------------------------------------- shared shader patches (every character material)
// Three things the stock physical shader cannot give a small figure standing in a city built for concrete:
//
// 1. SPECULAR AA. The pomade on the hero's crown threw white-blue fireflies in direct sun — read as dandruff at
//    1080p on the flagship close-up — because a 2048 normal map minified over a hair chart is undersampled and
//    roughness 0.2 turns that into aliasing. Fold the normal's own screen-space variance into roughness
//    (Kaplanyan/Tokuyoshi) and floor it, which is a Toksvig bake done per pixel instead of offline.
// 2. A GAMUT FLOOR. Shibuya is full of single-hue signs. A TSUTAYA yellow through envMapIntensity 2.2 drove a
//    pedestrian's face to B = 3/255 (B/R 0.057, saturation 0.95) — a yellow-green egg, not a human being. Green
//    and blue may not fall below a fixed fraction of red. Under any balanced light this is a no-op (skin's own
//    linear g/r is 0.49 and b/r 0.37, both well above the floors); it only bites when a channel has been
//    annihilated.
// 3. A SKY/GROUND HEMISPHERE of the material's own. `scene.environmentIntensity` is 0.18 at 13:00, so a near-black
//    worsted lands at L 6 against L 134 granite — a black cut-out with no terminator and no bounce. This adds a
//    real hemispheric irradiance term (sky above, pavement albedo below) that the character key cannot fake,
//    because a key only lights what faces it.
// linear-space floors, as a fraction of red. Skin's own albedo sits at g/r 0.49, b/r 0.33 (sRGB 158/114/94), so
// these are ~20 % below anything a neutral light can produce and only catch a monochrome sign.
// [chroma anchor strength, green floor, blue floor]. The anchor is the real tool: it re-mixes the shaded result
// toward the ALBEDO's own hue at the same luminance, so a face lit by nothing but a TSUTAYA yellow still comes
// out skin-coloured instead of olive (measured B = 3/255, B/R 0.057, saturation 0.95 — not a human colour by any
// definition). Under a balanced light the anchor is a no-op because the result already has the albedo's hue.
// The two floors are a backstop in LINEAR: ACES's output matrix subtracts red and green from blue, so a channel
// that is merely small going in comes out at zero.
// [knee start, shoulder width] in LINEAR scene luminance, for the poplin knee in charShader's opaque_fragment.
// ?charKnee=start,shoulder sweeps it; a start above anything the frame reaches disables it.
const KQ2 = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('charKnee') || '').split(',').map(Number) : [];
const KNEEQ = [KQ2[0] || 0.95, KQ2[1] || 1.30];
const SKIN_GAMUT = [0.78, 0.56, 0.46];
// the hero shares ONE material with a navy tie, a white poplin and a charcoal two-piece, and a Kamurocho night
// is SUPPOSED to put neon on a suit: he anchors at half strength.
// Fix round 1: 0.58 -> 0.40. At 0.58 the anchor re-mixed every lit texel more than halfway back to its albedo's own
// hue, so the magenta and green of the signs round him never reached his jaw or his shoulder (the face read as
// composited in) and the tie, whose albedo is b/r 7 in linear, came out the most saturated blue in the frame. The
// skin wedge below still holds a face inside human hue under a single-colour sign.
const HERO_GAMUT = [0.40, 0.46, 0.32];
// The skin WEDGE, round 6. The anchor re-mixes toward the albedo's own hue, and the procedural cast's albedo is
// itself authored yellow-olive, so the anchor preserved the defect: five faces in one frame spanned B/R 0.216
// (a red mask) to 0.545. This clamps the RESULT into a gamut wedge instead — luminance is preserved exactly, only
// the hue is pulled back inside human skin. Linear, so the grade's ~0.65x blue transfer is allowed for:
// display B/R 0.38-0.58 is linear 0.58-0.90, display G/R 0.58-0.78 is linear 0.62-0.86.
// Round 6 measured the wedge against the client's own contact sheet and the FLOOR was the problem, not the
// ceiling: his cheek there is sRGB 136/92/71, i.e. LINEAR b/r 0.254, and the hero's own scanned albedo is
// 158/114/94 = 0.32 — both far under a 0.58 floor, so the wedge was pulling the one face in the game built from
// a photograph back toward grey and costing it every bit of warmth the scan had. The floor exists to catch a
// face annihilated by a monochrome sign (measured display B/R 0.057 under a TSUTAYA yellow); 0.34 still catches
// that by a factor of four and leaves real skin alone.
const SKIN_WEDGE = [0.60, 0.92, 0.47, 0.95];        // [gLo, gHi, bLo, bHi] as fractions of red, LINEAR
const HEMI_SKY = new THREE.Color(), HEMI_GND = new THREE.Color();
// ---------------------------------------------------------------- the analytic character key
// Round 5 gave every `lit` body a PointLight, a PointLight and a HemisphereLight. With the 3-nearest cull that is
// NINE dynamic lights in the scene, and three.js bakes NUM_POINT_LIGHTS / NUM_HEMI_LIGHTS into EVERY program — so
// all 648 draws of city, signage, props and traffic paid a 9-light forward loop so that one man had a rim. These
// two directions are evaluated inside the character shader itself through RE_Direct (full diffuse AND specular,
// same BRDF a real light gets), at a FIXED irradiance: no 1/d², so a hand hanging at hip height and a cheek 0.5 m
// further away finally take the same key and N·L is the only variable (round 5's hand/cheek divergence).
const U_KEYD = { value: new THREE.Vector3(0.4, 0.5, 0.75) };   // WORLD direction from the body toward the key
const U_KEYC = { value: new THREE.Vector3() };
const U_RIMD = { value: new THREE.Vector3(-0.5, 0.6, -0.7) };
const U_RIMC = { value: new THREE.Vector3() };
// postfx's night NEAR-FIELD FILL, as this frame runs it: x = gain, yzw = its per-channel tint (see syncFill)
const U_FILL = { value: new THREE.Vector4(0, 1, 1, 1) };
// `dark` biases the SKY half of the hemisphere toward the low-albedo charts. The hero is ONE material over one
// scanned atlas — charcoal worsted, white poplin and skin all sample it — so a flat lift that pulls the thigh out
// of the black also clips the shirt. The GROUND half is never weighted: it is irradiance arriving at the surface
// from the granite 10 cm away, not a function of the surface's own albedo, and weighting it was what left the
// trousers and the attaché as black cut-outs in full 13:00 sun.
// `sss` (0..1): wrap lighting with a red terminator on skin-coloured texels — a face lit only by N·L ends in a hard
// brown line where a real one glows red through the ear, the nostril wing and the jaw's edge.
// `hair` (0/1): the scan's crown (dark, neutral, above 1.60 m in the bind pose) takes two Kajiya-Kay lobes along
// the combed direction instead of the sky's blue IBL, a warm tint, and no cloth sheen — it rendered as cold
// blue-grey carved clay.
const HAIR_FLAT = typeof location !== 'undefined' && /[?&]hairFlat=([\d.]+)/.test(location.search) ? parseFloat(RegExp.$1) : 1;
function charShader(m, { gamut = null, hemi = 0, hemiN = null, dark = 0, lift = 1, wedge = 0, key = 1, rim = 1, gnd = 0, gndN = null, gndFloor = 0.12, cap = 0, knee = KNEEQ, aa = [0.085, 0.085], back = 1, patch = false, sss = 0, hair = 0, region = null, detail = null, face = 0, wrap = 0 } = {}) {
  if (m.userData.charShader) return m;
  m.userData.gndK = gnd; m.userData.gndN = gndN == null ? gnd : gndN;
  const u = { uGamut: { value: new THREE.Vector3(gamut ? gamut[0] : 0, gamut ? gamut[1] : 0, gamut ? gamut[2] : 0) },
    uHemiSky: { value: new THREE.Vector3() }, uHemiGnd: { value: new THREE.Vector3() },
    uHemiDark: { value: dark }, uLift: { value: lift }, uWedge: { value: wedge }, uCap: { value: cap }, uBack: { value: back },
    uKnee: { value: new THREE.Vector2(knee[0], knee[1]) },
    uKeyK: { value: new THREE.Vector3(key, rim, gndFloor) }, uAA: { value: new THREE.Vector2(aa[0], aa[1]) },
    uSkinHair: { value: new THREE.Vector2(sss, hair) }, uFaceK: { value: face }, uHairFlat: { value: HAIR_FLAT }, uWrap: { value: wrap },
    uKeyDir: U_KEYD, uKeyCol: U_KEYC, uRimDir: U_RIMD, uRimCol: U_RIMC, uFill: U_FILL };
  // region: the hero's baked atlas classification (assets/hero/pipeline/region_map.py) — R any hair, G skin, B scalp.
  // Without it the skin / hair split is guessed from the albedo, which put the SSS terminator on every blended
  // hair-edge texel (the orange outline round the hairline and the beard).
  if (region) { u.uRegion = { value: region }; m.defines = { ...(m.defines || {}), CH_REGION: '' }; }
  // detail: a tiling micro-normal (a garment swatch) over the cloth of a scan whose own normal map was shipped as a
  // 4:2:0 JPEG, which smeared its tangent X/Y: the mobs' leather, denim and nylon read as fold-less albedo
  if (detail) { u.uDetailN = { value: detail.tex }; u.uDetail = { value: new THREE.Vector2(detail.rep, detail.k) }; m.defines = { ...(m.defines || {}), CH_DETAIL: '' }; }
  // 優先3: the chapter-1 scans (not the pedestrians, crowd.js's) keep the twill off skin and pale cloth
  if (detail && detail.fix) m.defines = { ...(m.defines || {}), CH_DETAIL_FIX: '' };
  // Non-enumerable: Material.copy() deep-copies userData through JSON, and these uniforms hold textures (the region
  // map, the detail swatch) — every clone of a scan material (enemy.js wardrobe / fade copies, crowd's pool copies)
  // re-encoded them with toDataURL, 9-11 ms a clone and a 40 ms stall in the ハチ公 cutscene. Every clone site shares
  // the source's userData object afterwards (c.userData = m.userData), so it still finds them here.
  Object.defineProperty(m.userData, 'charShader', { value: u, enumerable: false, writable: true, configurable: true });
  m.userData.hemiK = hemi; m.userData.hemiN = hemiN == null ? hemi : hemiN;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    for (const k of Object.keys(u)) shader.uniforms[k] = u[k];
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform vec3 uGamut;\nuniform vec3 uHemiSky;\nuniform vec3 uHemiGnd;\nuniform float uHemiDark;
uniform float uLift;\nuniform float uWedge;\nuniform float uCap;\nuniform float uBack;\nuniform vec3 uKeyK;\nuniform vec2 uAA;\nuniform vec2 uKnee;
uniform vec3 uKeyDir;\nuniform vec3 uKeyCol;\nuniform vec3 uRimDir;\nuniform vec3 uRimCol;\nuniform vec2 uSkinHair;\nuniform vec4 uFill;\nuniform float uFaceK;\nuniform float uHairFlat;\nuniform float uWrap;
#ifdef CH_REGION
uniform sampler2D uRegion;
#endif
#ifdef CH_DETAIL
uniform sampler2D uDetailN;
uniform vec2 uDetail;
#endif
varying float vCharY;
varying float vCharY0;
varying vec3 vHairT;
const vec3 CHAR_LW = vec3( 0.2126, 0.7152, 0.0722 );
// how much this texel looks like a warm chart (skin, leather) rather than a neutral one (worsted, hair, poplin).
// One material covers the hero's whole atlas, so every per-chart decision in here is made off the albedo's hue.
float charWarm( vec3 a ) { return smoothstep( 0.10, 0.34, ( a.r - a.b ) / max( a.r, 1e-4 ) ); }
// Kajiya-Kay: the highlight of a fibre is a function of the angle to its own direction, not to a normal
float charStrand( vec3 T, vec3 H, float p ) { float t = dot( T, H ); return pow( sqrt( max( 0.0, 1.0 - t * t ) ), p ); }
void main() {`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        { float a0 = dot( diffuseColor.rgb, CHAR_LW );
          diffuseColor.rgb *= mix( 1.0, uLift, 1.0 - smoothstep( 0.010, 0.085, a0 ) ); }
        float chLa = dot( diffuseColor.rgb, CHAR_LW );
        #ifdef CH_REGION
          vec3 chReg = texture2D( uRegion, vMapUv ).rgb;
          float chFibre = chReg.r;
          float chSkin = uSkinHair.x * chReg.g * ( 1.0 - chFibre );
          float chHair = uSkinHair.y * chReg.b;
        #else
          // no baked regions (the mob scans): only a clearly lit-skin value counts, so a hair edge blended into
          // skin (warm, but a third of skin's value) takes no terminator
          float chSkin = uSkinHair.x * charWarm( diffuseColor.rgb ) * smoothstep( 0.08, 0.15, chLa );
          float chHair = uSkinHair.y * ( 1.0 - charWarm( diffuseColor.rgb ) ) * ( 1.0 - smoothstep( 0.022, 0.06, chLa ) ) * smoothstep( 1.60, 1.66, vCharY0 );
          float chFibre = chHair;
        #endif
        diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.80, 0.76, 0.72 ), chHair );
        // Round 3, critic #7: the scan baked its studio highlights into the hair albedo, and lit again they read as
        // a marbled shell. A hair texel keeps 15 % of its own variation about one dark base (round 4: 35 -> 15, the
        // two pale bands across the crown were still the studio's); the band it shows is the strand lobe below
        // (?hairFlat=0 A/B).
        { vec3 hm = vec3( 0.030, 0.026, 0.024 );
          diffuseColor.rgb = mix( diffuseColor.rgb, hm + ( diffuseColor.rgb - hm ) * 0.15, chHair * uHairFlat ); }`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        #ifdef USE_SHEEN
          material.sheenColor *= ( 1.0 - chFibre ) * ( 1.0 - 0.7 * chSkin );
        #endif`)
      // Spec AA (Kaplanyan/Tokuyoshi, per pixel instead of an offline Toksvig bake) with a per-chart floor: a
      // 1 mm-detail normal over a hair chart at this pixel density throws white-cyan fireflies at 0.085, and they
      // crawl in motion. The hair floor is gated on "dark and neutral", so it catches the hero's crown and the
      // procedural strand sheet without flattening the skin's own specular two centimetres away.
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        #if defined( CH_DETAIL ) && defined( USE_NORMALMAP_TANGENTSPACE )
        { vec3 dn = texture2D( uDetailN, vNormalMapUv * uDetail.x ).xyz * 2.0 - 1.0;
          // (優先3: chSkin carries the SSS amount (0.8 on the scans), so a face kept a fifth of the denim twill and read
          // as diagonal hatching in a close-up; the cloth weave stops at the skin whatever the SSS)
          #ifdef CH_DETAIL_FIX
          float dk = uDetail.y * ( 1.0 - clamp( chSkin / max( uSkinHair.x, 1e-3 ), 0.0, 1.0 ) ) * ( 1.0 - chFibre );
          // (and on pale cloth — the brute's white suit — the denim twill at full strength lit as a 3-4 mm zebra hatch
          // that aliased into a dark grid from the fight camera; a pale worsted keeps a quarter of it)
          dk *= 1.0 - 0.75 * smoothstep( 0.10, 0.35, dot( diffuseColor.rgb, CHAR_LW ) );
          #else
          float dk = uDetail.y * ( 1.0 - chSkin ) * ( 1.0 - chFibre );
          #endif
          normal = normalize( normal + tbn * vec3( dn.xy * dk, 0.0 ) ); }
        #endif
        { vec3 dnx = dFdx( normal ), dny = dFdy( normal );
          float kr = min( 0.26, 0.55 * ( dot( dnx, dnx ) + dot( dny, dny ) ) );
          float dkc = ( 1.0 - charWarm( diffuseColor.rgb ) ) * ( 1.0 - smoothstep( 0.012, 0.055, dot( diffuseColor.rgb, CHAR_LW ) ) );
          // (round 4: a hair texel's floor is 0.30 whatever the region says — the cyan fireflies on the crown were
          // the env through the 1 mm normal at 0.20)
          float fl = max( mix( uAA.x, uAA.y, dkc * smoothstep( 1.52, 1.60, vCharY ) ), 0.30 * chHair );
          // skin carries a tighter sebum lobe than the scan's 0.52 (a matte face reads as clay under a sign)
          roughnessFactor = mix( roughnessFactor, min( roughnessFactor, 0.43 ), chSkin );
          ${patch ? '// a mend patch / wrist plug is lit as the cloth round it, not as a polished plate (round 4, critic #11 / #14)\n          roughnessFactor = max( roughnessFactor, 0.66 * vSeamPatch );' : ''}
          roughnessFactor = clamp( sqrt( roughnessFactor * roughnessFactor + kr ), fl, 1.0 ); }`)
      .replace('#include <lights_fragment_end>', `{ vec3 wn = inverseTransformDirection( normal, viewMatrix );
          float alb = dot( diffuseColor.rgb, CHAR_LW );
          // the sky half is for GARMENT: skin and poplin are already above 10 % and need none of it, and the
          // vCharY gate keeps it off the hair, which is the one other near-black chart on the hero's atlas and
          // which turns into a grey helmet the moment it takes five times the sky. A goatee sits BELOW that gate
          // and is as dark as the worsted: without the region it took the garment's lift and rendered orange paint.
          float dkr = ( 1.0 - smoothstep( 0.008, 0.10, alb ) ) * ( 1.0 - smoothstep( 1.56, 1.64, vCharY ) ) * ( 1.0 - chFibre );
          float dk = mix( 1.0, dkr, uHemiDark );
          // the GROUND half carries its own scalar and only a floored weight: it is granite bounce arriving at
          // the surface, so a charcoal trouser takes essentially all of it, but one material also covers a white
          // poplin and a face and those cannot take the same 20 units without clipping to paper.
          float gw = mix( 1.0, uKeyK.z + ( 1.0 - uKeyK.z ) * dkr, uHemiDark );
          float hw = clamp( wn.y * 0.5 + 0.5, 0.0, 1.0 );
          irradiance += uHemiGnd * ( 1.0 - hw ) * gw + uHemiSky * hw * dk;
          IncidentLight chL;
          chL.visible = true;
          chL.direction = normalize( ( viewMatrix * vec4( uKeyDir, 0.0 ) ).xyz );
          chL.color = uKeyCol * uKeyK.x;
          RE_Direct( chL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
          vec3 keyL = chL.direction, keyC = chL.color;
          chL.direction = normalize( ( viewMatrix * vec4( uRimDir, 0.0 ) ).xyz );
          chL.color = uRimCol * uKeyK.y;
          RE_Direct( chL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
          if ( uWrap > 0.0 ) {
            // Fix round 4 (critic #6): a near-black worsted lit by N·L alone is a cut-out below the terminator, so the
            // dark charts take the key wrapped past it and a share of the rim the same way — the thigh and the
            // jacket skirt keep a value under a sign instead of crushing to sRGB 6
            float ndl = dot( geometryNormal, keyL ), wr = max( 0.0, ( ndl + uWrap ) / ( 1.0 + uWrap ) ) - max( ndl, 0.0 );
            float ndr = dot( geometryNormal, chL.direction ), wr2 = max( 0.0, ( ndr + uWrap ) / ( 1.0 + uWrap ) ) - max( ndr, 0.0 );
            reflectedLight.directDiffuse += dkr * ( 1.5 * wr * keyC + 1.0 * wr2 * chL.color ) * BRDF_Lambert( material.diffuseColor );
          }
          if ( chSkin > 0.001 ) {
            float ndl = dot( geometryNormal, keyL );
            float wrap = max( 0.0, ( ndl + 0.35 ) / 1.35 ) - max( ndl, 0.0 );
            reflectedLight.directDiffuse += chSkin * wrap * keyC * BRDF_Lambert( material.diffuseColor ) * vec3( 1.0, 0.40, 0.26 );
            // the rim through the thin parts: back-lit skin at grazing angles goes red, not black
            float bl = pow( clamp( dot( geometryViewDir, - chL.direction ), 0.0, 1.0 ), 3.0 ) * ( 1.0 - abs( dot( geometryNormal, geometryViewDir ) ) );
            reflectedLight.directDiffuse += chSkin * 0.35 * bl * chL.color * material.diffuseColor * vec3( 1.0, 0.35, 0.22 );
          }
          if ( chHair > 0.001 ) {
            // The strand frame comes off the INTERPOLATED normal, not the normal-mapped one: fed the scan's 1 mm
            // normal detail, the tangent swung texel to texel and the two lobes broke into a marbled wood grain.
            // One soft primary band along the comb, a faint tinted secondary.
            vec3 gN = nonPerturbedNormal;
            vec3 T = normalize( vHairT - gN * dot( gN, vHairT ) );
            vec3 T2 = normalize( T + gN * 0.12 );
            vec3 hk = normalize( keyL + geometryViewDir ), hr = normalize( chL.direction + geometryViewDir );
            float ak = smoothstep( -0.15, 0.35, dot( gN, keyL ) ), ar = smoothstep( -0.15, 0.35, dot( gN, chL.direction ) );
            vec3 tint = diffuseColor.rgb / max( chLa, 1e-3 );
            // (round 3: one broad soft band, not a tight lobe that follows every scanned clump as a wavy streak;
            // round 4: the strand term can never exceed six times the texel's own value — no fireflies)
            vec3 hs = keyC * ak * ( 0.011 * charStrand( T, hk, 60.0 ) + 0.005 * charStrand( T2, hk, 22.0 ) * tint )
              + chL.color * ar * ( 0.013 * charStrand( T, hr, 60.0 ) );
            reflectedLight.directSpecular += chHair * min( hs, vec3( 6.0 * chLa ) );
            radiance *= 1.0 - 0.85 * chHair;
          } }
        #include <lights_fragment_end>`)
      .replace('#include <opaque_fragment>', `{ vec3 c = outgoingLight;
          float la = dot( diffuseColor.rgb, CHAR_LW ), lo = dot( c, CHAR_LW );
          c = mix( c, diffuseColor.rgb * ( lo / max( la, 1e-4 ) ), uGamut.x );
          c.g = max( c.g, c.r * uGamut.y );
          c.b = max( c.b, c.r * uGamut.z );
          // the wedge: only where the ALBEDO is skin (warm and mid-value), so a navy tie, black hair and brown
          // leather on the same atlas are untouched. Luminance-preserving, so it can never brighten or crush.
          float sk = uWedge * charWarm( diffuseColor.rgb ) * smoothstep( 0.055, 0.135, la ) * ( 1.0 - chFibre );
          if ( sk > 0.001 ) {
            float rr = max( c.r, 1e-5 );
            vec3 t = vec3( 1.0, clamp( c.g / rr, ${SKIN_WEDGE[0]}, ${SKIN_WEDGE[1]} ), clamp( c.b / rr, ${SKIN_WEDGE[2]}, ${SKIN_WEDGE[3]} ) );
            c = mix( c, t * ( lo / max( dot( t, CHAR_LW ), 1e-5 ) ), sk );
          }
          // POPLIN KNEE. A white dress shirt is the brightest chart on the atlas by a factor of sixty and the
          // only one that clips: at 13:00 it left the tone mapper at 231/228/226 with no fold left in it, and
          // being over the bloom threshold it also threw a halo that ate the lapel edge for 8 px either side.
          // Compress the top of its range with a Reinhard shoulder instead of letting it clip flat — gated on
          // "bright AND neutral", so skin (warm) and every garment below 30 % (charcoal, navy, denim) are
          // untouched, and luminance-only, so the poplin keeps its own slightly-warm white.
          { float wl = smoothstep( 0.30, 0.62, la ) * ( 1.0 - charWarm( diffuseColor.rgb ) );
            float lo2 = dot( c, CHAR_LW );
            if ( wl > 0.002 && lo2 > uKnee.x ) {
              float hd = lo2 - uKnee.x, sh = max( uKnee.y - uKnee.x, 1e-3 );
              float lk = uKnee.x + hd / ( 1.0 + hd / sh );
              c *= mix( 1.0, lk / max( lo2, 1e-5 ), wl );
            } }
          if ( uCap > 0.0 ) c *= min( 1.0, uCap / max( dot( c, CHAR_LW ), 1e-5 ) );
          // FACE vs postfx's near-field fill. That pass multiplies every near, dark pixel by up to 1 + 3.4 (gain
          // 1 - smoothstep(0.003, 0.05, L)), and x (1 + G d(x)) is NOT monotonic: an 0.02 beard edge leaves at 0.068,
          // brighter than the 0.05 skin beside it. Measured across the moustache: 8 -> 33 while the skin went 60 -> 20
          // (sRGB) — the orange 'sticker border' round the hairline, the brows and the beard. Skin and hair here are
          // pre-divided by the gain that pass will apply (the rising branch, solved by bisection), so the face leaves it
          // at the value lit here; the garments keep the lift the pass was written for. syncFill() turns this off
          // unless postfx still runs that exact formula (docs/reports/character.md, integration request).
          { float yL = dot( c, CHAR_LW );
            float wf = uFill.x > 0.0 ? clamp( chSkin + chFibre + uFaceK, 0.0, 1.0 ) * smoothstep( 1.40, 1.48, vCharY ) : 0.0;
            if ( wf > 0.001 && yL > 1e-5 && yL < 0.05 ) {
              float G = 0.9 * uFill.x * ( 1.0 - smoothstep( 4.0, 12.0, - vViewPosition.z ) );
              float lo = 0.0, hi = yL;
              for ( int i = 0; i < 12; i ++ ) {
                float m = 0.5 * ( lo + hi );
                if ( m * ( 1.0 + G * ( 1.0 - smoothstep( 0.003, 0.05, m ) ) ) < yL ) lo = m; else hi = m;
              }
              float dL = 1.0 - smoothstep( 0.003, 0.05, 0.5 * ( lo + hi ) );
              c = mix( c, c / ( 1.0 + uFill.yzw * G * dL ), wf );
            } }
          // a scanned shell seen from inside (through a gap the scanner left) is the garment's own lining in shadow;
          // a generated patch's back (seamPatch 1) is simply its cloth
          if ( !gl_FrontFacing ) c *= ${patch ? 'mix( uBack, 1.0, vSeamPatch )' : 'uBack'};
          outgoingLight = c; }
        #include <opaque_fragment>`);
    // A fold of cloth seen from behind (the lapel's underside at the notch, a sleeve's lining at the cuff) was lit
    // with its normal flipped INTO the body, so however much light uBack let through it came out black. It keeps
    // the outer surface's normal: the back of a lapel takes the light the lapel takes, dimmed by uBack.
    if (patch) shader.fragmentShader = shader.fragmentShader.replace('varying float vCharY;', 'varying float vCharY;\nvarying float vSeamPatch;')
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;'))
      // A double-sided scan rasterises its whole inside too, and whatever of it is drawn before the outside in
      // front of it paid the full physical shader (sheen, clearcoat, two analytic lights, the IBL) for nothing:
      // measured, a double-sided mob cost ~40 % more than the same mob single-sided. The inside is only ever SEEN
      // as a fold in shade or a lining, so it takes a flat term — albedo x (hemisphere + a quarter of the key + the
      // IBL irradiance) x uBack — and returns before any of the lighting code runs. Early-z is untouched.
      .replace('#include <color_fragment>', `#include <color_fragment>
        #ifdef DOUBLE_SIDED
        if ( !gl_FrontFacing ) {
          vec3 chIr = uHemiSky * 0.55 + uHemiGnd * 0.45 + uKeyCol * ( uKeyK.x * 0.22 );
          #ifdef USE_ENVMAP
            chIr += getIBLIrradiance( normalize( vNormal ) );
          #endif
          gl_FragColor = vec4( BRDF_Lambert( diffuseColor.rgb ) * chIr * mix( uBack, 1.0, vSeamPatch ), 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
          return;
        }
        #endif`);
    // Fix round 2 (performance): three.js runs the full BRDF for every one of the lighting pool's 28 point lights on
    // every fragment, lit or not; a character is inside the 24 m cutoff of a handful of them. Measured on the
    // lineup, the scans' lit material cost ~7 ms more than an unlit one. A light whose attenuated colour is zero
    // (out of range, or a pool slot switched off) is now skipped — the branch is uniform across a body's pixels.
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', chLightsBegin());
    if (DQS) shader.vertexShader = shader.vertexShader
      .replace('#include <skinning_pars_vertex>', '#include <skinning_pars_vertex>\n' + DQS_PARS)
      .replace('#include <skinbase_vertex>', DQS_BASE).replace('#include <skinnormal_vertex>', DQS_NORMAL)
      .replace('#include <skinning_vertex>', DQS_POS);
    // skinned-local height: the only cheap way to tell a charcoal sleeve from black hair on one shared atlas
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `varying float vCharY;\nvarying float vCharY0;\nvarying vec3 vHairT;\n${patch ? 'attribute float seamPatch;\nvarying float vSeamPatch;\n' : ''}void main() {`)
      // vHairT: the combed direction, back and a little up in the body's own frame (a swept-back pompadour)
      .replace('#include <project_vertex>', `#include <project_vertex>\n  vCharY = transformed.y;\n  vCharY0 = position.y;
  vHairT = normalize( ( modelViewMatrix * vec4( 0.0, 0.30, -1.0, 0.0 ) ).xyz );${patch ? '\n  vSeamPatch = seamPatch;' : ''}`);
  };
  m.customProgramCacheKey = () => (patch ? 'charP' : 'char') + (DQS ? 'Q' : '') + (region ? 'R' : '') + (detail ? 'D' : '');
  return m;
}
// built at compile time from the CURRENT chunk: lighting.js's CSM swaps THREE.ShaderChunk.lights_fragment_begin for its
// cascade-aware version when it initialises, after this module is imported
let _chLB = { src: null, out: null };
function chLightsBegin() {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  if (_chLB.src !== src) _chLB = { src, out: src.replace(/RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);/g,
    'if ( directLight.visible ) RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );') };
  return _chLB.out;
}
// ---------------------------------------------------------------- dual-quaternion skinning
// Linear blend skinning averages bone MATRICES, and the average of two rotations far apart is not a rotation: the
// shoulder cap under hook@0.75 (the arm swung 100° across the chest) collapsed like a candy wrapper and an armpit
// edge grew 10-17 cm (selfTest.stretch). Blending the bones as unit dual quaternions keeps every skinned vertex on
// a rigid motion, so the deltoid keeps its volume through the punch. Uniform scale (a persona's 1.06) is factored
// out per bone and blended separately. Every character material, the lod ladder included; the shadow depth pass
// stays linear (a few mm of shadow is not worth a second program). ?dqs=0 compares against linear blending, and
// selfTest's maxStretch skins on the CPU the same way the GPU now does.
const DQS = !(typeof location !== 'undefined' && /[?&]dqs=0/.test(location.search));
const DQS_PARS = `#ifdef USE_SKINNING
vec4 chQuat( mat3 m ) {
  float tr = m[0][0] + m[1][1] + m[2][2];
  if ( tr > 0.0 ) { float s = sqrt( tr + 1.0 ) * 2.0; return vec4( ( m[1][2] - m[2][1] ) / s, ( m[2][0] - m[0][2] ) / s, ( m[0][1] - m[1][0] ) / s, 0.25 * s ); }
  if ( m[0][0] > m[1][1] && m[0][0] > m[2][2] ) { float s = sqrt( 1.0 + m[0][0] - m[1][1] - m[2][2] ) * 2.0; return vec4( 0.25 * s, ( m[1][0] + m[0][1] ) / s, ( m[2][0] + m[0][2] ) / s, ( m[1][2] - m[2][1] ) / s ); }
  if ( m[1][1] > m[2][2] ) { float s = sqrt( 1.0 + m[1][1] - m[0][0] - m[2][2] ) * 2.0; return vec4( ( m[1][0] + m[0][1] ) / s, 0.25 * s, ( m[2][1] + m[1][2] ) / s, ( m[2][0] - m[0][2] ) / s ); }
  float s = sqrt( 1.0 + m[2][2] - m[0][0] - m[1][1] ) * 2.0; return vec4( ( m[2][0] + m[0][2] ) / s, ( m[2][1] + m[1][2] ) / s, 0.25 * s, ( m[0][1] - m[1][0] ) / s );
}
vec4 chQMul( vec4 a, vec4 b ) { return vec4( a.w * b.xyz + b.w * a.xyz + cross( a.xyz, b.xyz ), a.w * b.w - dot( a.xyz, b.xyz ) ); }
vec3 chQRot( vec4 q, vec3 v ) { return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v ); }
void chDQ( mat4 M, out vec4 qr, out vec4 qd, out float sc ) {
  sc = length( M[0].xyz );
  qr = normalize( chQuat( mat3( M[0].xyz / sc, M[1].xyz / sc, M[2].xyz / sc ) ) );
  qd = 0.5 * chQMul( vec4( M[3].xyz / sc, 0.0 ), qr );
}
#endif`;
const DQS_BASE = `#ifdef USE_SKINNING
  mat4 boneMatX = getBoneMatrix( skinIndex.x );
  mat4 boneMatY = getBoneMatrix( skinIndex.y );
  mat4 boneMatZ = getBoneMatrix( skinIndex.z );
  mat4 boneMatW = getBoneMatrix( skinIndex.w );
  vec4 chR0, chR1, chR2, chR3, chD0, chD1, chD2, chD3; float chS0, chS1, chS2, chS3;
  chDQ( boneMatX, chR0, chD0, chS0 ); chDQ( boneMatY, chR1, chD1, chS1 ); chDQ( boneMatZ, chR2, chD2, chS2 ); chDQ( boneMatW, chR3, chD3, chS3 );
  // one hemisphere for all four, referenced to the heaviest influence
  vec4 chRef = chR0; float chWm = skinWeight.x;
  if ( skinWeight.y > chWm ) { chRef = chR1; chWm = skinWeight.y; }
  if ( skinWeight.z > chWm ) { chRef = chR2; chWm = skinWeight.z; }
  if ( skinWeight.w > chWm ) { chRef = chR3; }
  vec4 chW = skinWeight * vec4( dot( chR0, chRef ) < 0.0 ? -1.0 : 1.0, dot( chR1, chRef ) < 0.0 ? -1.0 : 1.0, dot( chR2, chRef ) < 0.0 ? -1.0 : 1.0, dot( chR3, chRef ) < 0.0 ? -1.0 : 1.0 );
  vec4 chBR = chW.x * chR0 + chW.y * chR1 + chW.z * chR2 + chW.w * chR3;
  vec4 chBD = chW.x * chD0 + chW.y * chD1 + chW.z * chD2 + chW.w * chD3;
  float chSc = dot( skinWeight, vec4( chS0, chS1, chS2, chS3 ) ) / max( dot( skinWeight, vec4( 1.0 ) ), 1e-6 );
  float chBL = max( length( chBR ), 1e-6 ); chBR /= chBL; chBD /= chBL;
#endif`;
const DQS_NORMAL = `#ifdef USE_SKINNING
  objectNormal = ( bindMatrixInverse * vec4( chQRot( chBR, ( bindMatrix * vec4( objectNormal, 0.0 ) ).xyz ), 0.0 ) ).xyz;
  #ifdef USE_TANGENT
    objectTangent = ( bindMatrixInverse * vec4( chQRot( chBR, ( bindMatrix * vec4( objectTangent, 0.0 ) ).xyz ), 0.0 ) ).xyz;
  #endif
#endif`;
const DQS_POS = `#ifdef USE_SKINNING
  vec3 chT = 2.0 * ( chBR.w * chBD.xyz - chBD.w * chBR.xyz + cross( chBR.xyz, chBD.xyz ) );
  vec3 chPos = ( chQRot( chBR, ( bindMatrix * vec4( transformed, 1.0 ) ).xyz ) + chT ) * chSc;
  transformed = ( bindMatrixInverse * vec4( chPos, 1.0 ) ).xyz;
#endif`;
// the same blend on the CPU (selfTest.stretch and poseStray read what the GPU draws)
const _dqM = new THREE.Matrix4(), _dqQ = new THREE.Quaternion(), _dqT = new THREE.Vector3(), _dqS = new THREE.Vector3();
function skinDQ(sk, si, sw, i, px, py, pz, out) {
  let br = [0, 0, 0, 0], bd = [0, 0, 0, 0], sc = 0, ws = 0, ref = null, wmax = -1;
  const Q = [];
  for (let k = 0; k < 4; k++) {
    const w = sw.getComponent(i, k); if (w <= 0) continue;
    const b = si.getComponent(i, k);
    _dqM.multiplyMatrices(sk.bones[b].matrixWorld, sk.boneInverses[b]);
    _dqM.decompose(_dqT, _dqQ, _dqS);
    const s = _dqS.x, q = [_dqQ.x, _dqQ.y, _dqQ.z, _dqQ.w], t = [_dqT.x / s, _dqT.y / s, _dqT.z / s];
    // qd = 0.5 * (t, 0) * q
    const d = [0.5 * (q[3] * t[0] + t[1] * q[2] - t[2] * q[1]), 0.5 * (q[3] * t[1] + t[2] * q[0] - t[0] * q[2]),
      0.5 * (q[3] * t[2] + t[0] * q[1] - t[1] * q[0]), -0.5 * (t[0] * q[0] + t[1] * q[1] + t[2] * q[2])];
    Q.push({ w, q, d, s });
    if (w > wmax) { wmax = w; ref = q; }
  }
  for (const { w, q, d, s } of Q) {
    const sg = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? -w : w;
    for (let c = 0; c < 4; c++) { br[c] += sg * q[c]; bd[c] += sg * d[c]; }
    sc += w * s; ws += w;
  }
  const L = Math.hypot(br[0], br[1], br[2], br[3]) || 1;
  br = br.map((x) => x / L); bd = bd.map((x) => x / L); sc /= ws || 1;
  // rotate p by br
  const [qx, qy, qz, qw] = br;
  const cx = qy * pz - qz * py + qw * px, cy = qz * px - qx * pz + qw * py, cz = qx * py - qy * px + qw * pz;
  let rx = px + 2 * (qy * cz - qz * cy), ry = py + 2 * (qz * cx - qx * cz), rz = pz + 2 * (qx * cy - qy * cx);
  const tx = 2 * (qw * bd[0] - bd[3] * qx + (qy * bd[2] - qz * bd[1])), ty = 2 * (qw * bd[1] - bd[3] * qy + (qz * bd[0] - qx * bd[2])), tz = 2 * (qw * bd[2] - bd[3] * qz + (qx * bd[1] - qy * bd[0]));
  return out.set((rx + tx) * sc, (ry + ty) * sc, (rz + tz) * sc);
}
// ---------------------------------------------------------------- the city's own colour at the character
// The key and the rim were a studio's, warm white and cool white, and the ground bounce a fixed amber. A night
// Kamurocho lead picks up the magenta and the green of the signs on his jaw and along his shoulder; without it the
// hero stood in the frame like a cut-out pasted over it and his charcoal back merged into any dark pillar behind
// him. Every 12 frames the sign / shop / lantern fixtures (lighting.fixtures) within 30 m of the camera's focus are
// averaged by intensity / (d² + 9); only the HUE travels (luminance normalised to 1) and it tints the rim, the
// ground bounce and the scan's cloth sheen at night.
// Fix round 2: the average of magenta, green and white is grey, so the rim it tinted was invisible and the key
// stayed a studio's. The average still drives the ambient (hemisphere, sheen); the RIM now comes from ONE fixture —
// the strongest, weighted toward those behind him — in its own saturated hue and its own world direction, and the
// KEY takes its yaw (clamped within 60° of the lens) and a share of its colour from the strongest of the rest.
const NEON = { col: new THREE.Color(1, 1, 1), frame: 0, focus: new THREE.Vector3(), w: 0, init: false,
  rimDir: new THREE.Vector3(-0.5, 0.6, -0.7), rimCol: new THREE.Color(0.8, 0.85, 1), keyDir: new THREE.Vector3(0.4, 0.5, 0.75), keyCol: new THREE.Color(1, 0.94, 0.88), rimK: 1 };
const NEON_T = { rimDir: new THREE.Vector3(), rimCol: new THREE.Color(), keyDir: new THREE.Vector3(), keyCol: new THREE.Color(), rimK: 1, ok: false };
const _nc = new THREE.Color(), _nd = new THREE.Vector3(), _nv = new THREE.Vector3();
const NEON_DBG = typeof location !== 'undefined' && /[?&]neonDbg=1/.test(location.search);
// clamp a world direction's elevation into [lo, hi] (sines), keeping its heading
function clampElev(v, lo, hi) {
  const y = clamp(v.y, lo, hi), h = Math.hypot(v.x, v.z) || 1e-6, k = Math.sqrt(1 - y * y) / h;
  return v.set(v.x * k, y, v.z * k);
}
// saturated hue at unit peak: a magenta sign stays magenta instead of being normalised toward white
const satHue = (c, out) => { const m = Math.max(c.r, c.g, c.b, 1e-4); return out.setRGB(c.r / m, c.g / m, c.b / m); };
function sampleNeon(engine) {
  if ((NEON.frame++ % 12) !== 0) return;
  const L = engine && engine.get && engine.get('lighting'), fx = L && L.fixtures, cam = engine && engine.camera;
  if (!fx || !fx.length || !cam) return;
  // the lead if he is in front of the lens, else a point 4 m down it
  const pl = engine.player, pp = pl && (pl.position || (pl.group && pl.group.position));
  _p.set(0, 0, -4).applyQuaternion(cam.quaternion).add(cam.position);
  if (pp && pp.distanceToSquared(cam.position) < 144) { _nv.copy(pp).sub(cam.position); if (_nv.dot(_nd.copy(_p).sub(cam.position)) > 0) _p.set(pp.x, pp.y + 1.3, pp.z); }
  NEON.focus.copy(_p);
  _nv.copy(cam.position).sub(_p); _nv.y = 0; _nv.normalize();                 // toward the lens, flat
  let r = 0, g = 0, b = 0, w = 0, best = null, bw = 0, second = null, sw2 = 0;
  for (const f of fx) {
    if (f.kind === 'street') continue;
    const d2 = f.pos.distanceToSquared(NEON.focus);
    if (d2 > 900) continue;
    const k = (f.intensity || 30) / (d2 + 9);
    r += f.color.r * k; g += f.color.g * k; b += f.color.b * k; w += k;
    _nd.copy(f.pos).sub(NEON.focus); _nd.y = 0; const dl = _nd.length() || 1;
    const behind = 0.4 + 0.6 * sstep((-(_nd.x * _nv.x + _nd.z * _nv.z) / dl + 0.2) / 0.7);
    // a saturated sign makes the rim (a magenta wall beats a peach shop front of similar strength); white-ish
    // fixtures are left to the key
    const mx = Math.max(f.color.r, f.color.g, f.color.b, 1e-4), sat = 1 - Math.min(f.color.r, f.color.g, f.color.b) / mx;
    const kr = k * behind * (0.35 + sat);
    if (kr > bw) { if (best) { const kb = best.k; if (kb > sw2) { second = best; sw2 = kb; } } best = { f, k }; bw = kr; }
    else if (k > sw2) { second = { f, k }; sw2 = k; }
  }
  if (w <= 0) return;
  _nc.setRGB(r / w, g / w, b / w);
  const l = 0.2126 * _nc.r + 0.7152 * _nc.g + 0.0722 * _nc.b;
  if (l > 1e-4) _nc.multiplyScalar(1 / l);
  // hold the hue from swinging a whole sign's worth when the camera turns
  NEON.col.lerp(_nc, NEON.w ? 0.35 : 1); NEON.w = w;
  if (best) {
    clampElev(NEON_T.rimDir.copy(best.f.pos).sub(NEON.focus).normalize(), 0.14, 0.62);
    satHue(best.f.color, NEON_T.rimCol);
    NEON_T.rimK = clamp(0.75 + 0.25 * Math.log2(1 + best.k / 0.8), 0.75, 1.25);
  }
  // key: the strongest of the rest, its yaw pulled within 60° of the lens, 20-38° up, warm white with a third of its hue
  const kf = second ? second.f : best ? best.f : null;
  _nd.set(_nv.x, 0, _nv.z);
  if (kf) { _nd.copy(kf.pos).sub(NEON.focus); _nd.y = 0; if (_nd.lengthSq() < 1e-6) _nd.set(_nv.x, 0, _nv.z); _nd.normalize(); }
  const ca = Math.atan2(_nv.x, _nv.z); let da = Math.atan2(_nd.x, _nd.z) - ca;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  if (Math.abs(da) < 0.26) da = 0.61 * (da < 0 ? -1 : 1);                   // never dead on the lens axis (flat)
  da = clamp(da, -1.05, 1.05);
  const ya = ca + da, el = 0.42;
  NEON_T.keyDir.set(Math.sin(ya) * Math.cos(el), Math.sin(el), Math.cos(ya) * Math.cos(el));
  NEON_T.keyCol.setRGB(1, 0.94, 0.886);
  if (kf) NEON_T.keyCol.lerp(satHue(kf.color, _nc), 0.3);
  NEON_T.ok = true;
  if (NEON_DBG && NEON.frame < 400) {
    console.info('[humanoid] neon rim', best && best.f.kind, NEON_T.rimCol.getHexString(), NEON_T.rimDir.toArray().map((v) => v.toFixed(2)).join(','), 'k', best && +best.k.toFixed(3),
      '| key', kf && kf.kind, NEON_T.keyCol.getHexString(), NEON_T.keyDir.toArray().map((v) => v.toFixed(2)).join(','));
    const top = fx.filter((f) => f.kind !== 'street' && f.pos.distanceToSquared(NEON.focus) < 900).map((f) => [f, (f.intensity || 30) / (f.pos.distanceToSquared(NEON.focus) + 9)]).sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.info('[humanoid] neon top', top.map(([f, k]) => f.kind + ':' + f.color.getHexString() + '@' + f.pos.toArray().map((v) => v.toFixed(0)).join('/') + ' k' + k.toFixed(3)).join('  '));
  }
  if (!NEON.init) { NEON.init = true; NEON.rimDir.copy(NEON_T.rimDir); NEON.rimCol.copy(NEON_T.rimCol); NEON.keyDir.copy(NEON_T.keyDir); NEON.keyCol.copy(NEON_T.keyCol); NEON.rimK = NEON_T.rimK; }
}
// sky/ground irradiance for the hemisphere term, driven once per frame from the time of day
function setCharHemi(hour, wet) {
  const night = hour < 6.2 || hour > 17.6;
  // day: an overcast-bright sky above and the plaza's own warm granite bounce below (the pavement measures L 115,
  // which is a real bounce source a few centimetres from a trouser leg). night: the city's own spill, which is
  // whatever the nearest signs are (sampleNeon), not a fixed amber.
  if (night) {
    // the night sky over Shibuya is the city's own sodium/LED haze, not moonlight: the old blue sky (b/r 1.67)
    // times a navy albedo (b/r 2) rendered every dark suit in the cast as royal blue
    HEMI_SKY.setRGB(0.029, 0.027, 0.031); HEMI_GND.setRGB(0.042, 0.031, 0.028);
    const ls = 0.2126 * HEMI_SKY.r + 0.7152 * HEMI_SKY.g + 0.0722 * HEMI_SKY.b;
    HEMI_SKY.lerp(_nc.copy(NEON.col).multiplyScalar(ls), 0.2);
    // (round 4: 0.42 -> 0.62 toward the signs' own hue — the wet crossing under him is magenta, and the bounce off
    // it onto a trouser leg has to be too)
    const l = 0.2126 * HEMI_GND.r + 0.7152 * HEMI_GND.g + 0.0722 * HEMI_GND.b;
    HEMI_GND.lerp(_nc.copy(NEON.col).multiplyScalar(l), 0.62);
  } else { HEMI_SKY.setRGB(0.56, 0.64, 0.82); HEMI_GND.setRGB(0.82, 0.72, 0.58); }
  if (wet) HEMI_GND.multiplyScalar(0.8);
  for (const m of charMats) {
    const s = m.userData.charShader; if (!s) continue;
    const k = (night ? m.userData.hemiN : m.userData.hemiK) || 0;
    const g = (night ? m.userData.gndN : m.userData.gndK) || 0;
    s.uHemiSky.value.set(HEMI_SKY.r * k, HEMI_SKY.g * k, HEMI_SKY.b * k);
    s.uHemiGnd.value.set(HEMI_GND.r * g, HEMI_GND.g * g, HEMI_GND.b * g);
  }
}
// key/rim colour and direction, once per frame for the whole cast. The direction is camera-relative — 35° to
// camera-right, 20° up, with the rim opposite and behind — because a key pinned to a body's own frame lights
// whichever side of him the modeller happened to choose.
// Round 6: the day key was 3.05 ON TOP of the scene's own 13:00 sun, an env at 1.9-2.6 and the hemisphere below.
// Against the client's contact sheet the cheek measured 235/198/190 (L 205) where the reference is 136/92/71
// (L 100) — not "bright skin" but skin with the red channel clipped and the chroma gone with it. The key exists
// so a face has shape when the city's own lighting does not reach it, which is a NIGHT problem; at noon the sun
// is already doing that job and the key was only stacking exposure. ?charKey=day,night sweeps it.
const KQ = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('charKey') || '').split(',').map(Number) : [];
// Fix round 2: night key 2.15 -> 1.2. At 2.15 from 35° off the lens the face was evenly front-lit whatever the
// street was doing — a studio portrait pasted onto the plate. The key side now falls off and the sign rim reads.
const KEY_DAY = [0xfff0e2, KQ[0] || 1.35], KEY_NIGHT = [0xfff0e2, KQ[1] || 1.2];
// night rim: one sign's own saturated hue and direction (sampleNeon), not a studio cool-white opposite the key
const RIM_DAY = [0xc2cfe4, 0.85], RIM_NIGHT = [0xc2cfe4, 1.85];
const _kc = new THREE.Color();
const KEY_YAW = [Math.cos(0.61), Math.sin(0.61)], KEY_EL = [Math.cos(0.35), Math.sin(0.35)], RIM_EL = [Math.cos(0.52), Math.sin(0.52)];
function setCharKey(cam, night, boost = 1, dt = 1 / 60) {
  let fx = 0, fz = 1;
  if (cam) {                                        // camera forward, flattened: the key sits off the lens axis
    _p.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const l = Math.hypot(_p.x, _p.z);
    if (l > 1e-5) { fx = -_p.x / l; fz = -_p.z / l; }   // from the body toward the camera
  }
  const [kh, ki0] = night ? KEY_NIGHT : KEY_DAY, [rh, ri0] = night ? RIM_NIGHT : RIM_DAY;
  const ki = ki0 * boost, ri = ri0 * boost;
  if (night && NEON_T.ok) {
    // ease toward the sampled lights (they are re-picked every 12 frames; a cut must not pop the face)
    const a = NEON.init ? 1 - Math.exp(-4 * clamp(dt, 1 / 240, 0.1)) : 1;
    NEON.rimDir.lerp(NEON_T.rimDir, a).normalize(); NEON.keyDir.lerp(NEON_T.keyDir, a).normalize();
    NEON.rimCol.lerp(NEON_T.rimCol, a); NEON.keyCol.lerp(NEON_T.keyCol, a); NEON.rimK += (NEON_T.rimK - NEON.rimK) * a;
    U_KEYD.value.copy(NEON.keyDir); U_RIMD.value.copy(NEON.rimDir);
    U_KEYC.value.set(NEON.keyCol.r * ki, NEON.keyCol.g * ki, NEON.keyCol.b * ki);
    const rk = ri * NEON.rimK;
    U_RIMC.value.set(NEON.rimCol.r * rk, NEON.rimCol.g * rk, NEON.rimCol.b * rk);
  } else {
    const kx = fx * KEY_YAW[0] - fz * KEY_YAW[1], kz = fx * KEY_YAW[1] + fz * KEY_YAW[0];
    U_KEYD.value.set(kx * KEY_EL[0], KEY_EL[1], kz * KEY_EL[0]).normalize();
    U_RIMD.value.set(-kx * RIM_EL[0], RIM_EL[1], -kz * RIM_EL[0]).normalize();
    _kc.set(kh); U_KEYC.value.set(_kc.r * ki, _kc.g * ki, _kc.b * ki);
    _kc.set(rh);
    if (night) { const l = 0.2126 * _kc.r + 0.7152 * _kc.g + 0.0722 * _kc.b; _kc.lerp(_c1.copy(NEON.col).multiplyScalar(l), 0.5); }
    U_RIMC.value.set(_kc.r * ri, _kc.g * ri, _kc.b * ri);
  }
  // the scan's worsted sheen: the fibre's own near-black by day, the signs' colour at night
  if (HERO.mat && HERO.mat.sheenColor && HERO.sheen0) {
    if (night) { HERO.mat.sheenColor.copy(HERO.sheen0).lerp(_c1.copy(NEON.col).multiplyScalar(0.075), 0.5); HERO.mat.sheen = 0.40; }
    else { HERO.mat.sheenColor.copy(HERO.sheen0); HERO.mat.sheen = HERO.sheenK; }
  }
  // (the story cast's Meshy suits — hero v2, 柊 — the same, each about its own fibre colour: see loadScanAsset `cast`)
  for (const m of CAST_SHEEN) {
    const u = m.userData;
    if (night) { m.sheenColor.copy(u.sheen0).lerp(_c1.copy(NEON.col).multiplyScalar(0.075), 0.5); m.sheen = u.sheenN; }
    else { m.sheenColor.copy(u.sheen0); m.sheen = u.sheenK; }
  }
}
// Read postfx's near-field fill once a frame, and only when its shader still carries the formula charShader's face
// pre-compensation inverts: a changed (or fixed) fill turns the compensation off instead of double-correcting.
const FILL_SIG = ['float dark = 1.0 - smoothstep(0.003, 0.05, sceneL);', 'c.rgb *= 1.0 + fillTint * (fillNear * nearK * dark * ao * cover);'];
function syncFill(engine) {
  let g = 0, t = null;
  try {
    const pf = engine && engine.get && engine.get('postfx'), hz = pf && pf.haze;
    const src = hz && hz.material && hz.material.fragmentShader;
    if (pf && pf.enabled !== false && hz.enabled !== false && (!pf.normalPass || pf.normalPass.enabled) && src && FILL_SIG.every((x) => src.includes(x))
      && !/[?&]faceFill=0/.test(location.search)) {
      g = hz.uniforms.fillNear ? +hz.uniforms.fillNear.value || 0 : 0;
      t = hz.uniforms.fillTint && hz.uniforms.fillTint.value;
    }
  } catch (e) { g = 0; }
  U_FILL.value.set(g, t ? t.x : 1, t ? t.y : 1, t ? t.z : 1);
}
function lib() { const m = humanoid.engine && humanoid.engine.get && humanoid.engine.get('materials'); return m && typeof m.variant === 'function' ? m : null; }
// mean albedo (sRGB) of the library's cloth/leather maps: the tint colour is normalised against it so `color` is the final albedo
const BASE_ALBEDO = { suit: [40, 42, 50], shirt: [236, 233, 226], cloth: [128, 124, 118], leather: [52, 38, 30], shoes: [20, 16, 14] };
const lin = (c) => Math.pow(c / 255, 2.2);
function tintTo(m, key, hex) {
  const b = BASE_ALBEDO[key];
  m.color.set(hex);
  if (b) m.color.setRGB(m.color.r / lin(b[0]), m.color.g / lin(b[1]), m.color.b / lin(b[2]));
}
// ---------------------------------------------------------------- garment swatches (albedo + ORM + normal, body scale)
// The library's cloth maps are authored for façade uv — 6 tiles across a metre of wall. Every loft in this file
// normalises uv to ~11.7 units per metre, so one of those tiles lands at 1.4 cm on a sleeve and mips to a single
// flat colour: which is why every procedural variant read as an untextured shell next to the hero's scanned suit.
// These are drawn in the body's own metric uv, 0.34 m a tile, and carry three scales — the weave (~1 mm), the panel
// structure (stripes, ripstop, ribs, ~1.5 cm) and a value blotch field (~10 cm), so no two square decimetres of a
// jacket sit at the same value. Albedo stays within ±16 % and never darkens past 0.86: wrinkles belong in the
// normal map, and a dark stroke painted into cloth albedo reads as a slash.
const GARMENT_N = 512, GARMENT_M = 0.34, GARMENT_REPEAT = 1 / (11.7 * GARMENT_M);
// tileable value noise: `cells` lattice points across the tile, smoothstep interpolation
function vnoise(N, cells, seed) {
  const r = mulberry(seed), g = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) g[i] = r();
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fx = (x / N) * cells, fy = (y / N) * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = sstep(fx - x0), ty = sstep(fy - y0);
    const xa = x0 % cells, xb = (x0 + 1) % cells, ya = (y0 % cells) * cells, yb = ((y0 + 1) % cells) * cells;
    out[y * N + x] = lerp(lerp(g[ya + xa], g[ya + xb], tx), lerp(g[yb + xa], g[yb + xb], tx), ty);
  }
  return out;
}
// tileable Worley-ish cell field for pebble grain: distance to the nearest of a jittered 24x24 lattice, 0..1
const CELL_N = 24, _cellPts = (() => { const r = mulberry(0x9a17), p = new Float32Array(CELL_N * CELL_N * 2);
  for (let i = 0; i < CELL_N * CELL_N; i++) { p[i * 2] = r(); p[i * 2 + 1] = r(); } return p; })();
function vnoiseCell(x, y, N) {
  const fx = (x / N) * CELL_N, fy = (y / N) * CELL_N;
  const cx = Math.floor(fx), cy = Math.floor(fy);
  let best = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const gx = ((cx + i) % CELL_N + CELL_N) % CELL_N, gy = ((cy + j) % CELL_N + CELL_N) % CELL_N;
    const k = (gy * CELL_N + gx) * 2;
    const px = cx + i + _cellPts[k], py = cy + j + _cellPts[k + 1];
    const d = (px - fx) * (px - fx) + (py - fy) * (py - fy);
    if (d < best) best = d;
  }
  return clamp(Math.sqrt(best) * 1.7, 0, 1);
}
// height field -> tangent-space normal canvas (wraps, so the swatch still tiles)
function normalFromHeight(h, N, gain) {
  const c = document.createElement('canvas'); c.width = c.height = N;
  const ctx = c.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
  const H = (a, b) => h[(((b % N) + N) % N) * N + (((a % N) + N) % N)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const du = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
    const dv = (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1)) - (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1));
    let vx = -du * gain, vy = -dv * gain, vz = 1; const l = Math.hypot(vx, vy, vz); vx /= l; vy /= l; vz /= l;
    const k = (y * N + x) * 4;
    d[k] = (vx * 0.5 + 0.5) * 255; d[k + 1] = (vy * 0.5 + 0.5) * 255; d[k + 2] = (vz * 0.5 + 0.5) * 255; d[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
// per-kind cloth structure. v = albedo multiplier about 1, h = height (0..1), r = roughness (0..1)
const GARMENT_KINDS = ['worsted', 'pinstripe', 'birdseye', 'nylon', 'denim', 'poplin', 'knit', 'grain'];
const garmentCache = new Map();
function garmentSet(kind, base) {
  const id = kind + '|' + base.join(',');
  if (garmentCache.has(id)) return garmentCache.get(id);
  const N = GARMENT_N, sd = 0x5100 + GARMENT_KINDS.indexOf(kind) * 977;
  const rng = mulberry(sd);
  const blotch = vnoise(N, 4, sd + 1), midN = vnoise(N, 15, sd + 2), fine = vnoise(N, 96, sd + 3), fibre = vnoise(N, 210, sd + 4);
  const hh = new Float32Array(N * N);
  const c = document.createElement('canvas'); c.width = c.height = N;
  const ctx = c.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
  const oc = document.createElement('canvas'); oc.width = oc.height = N;
  const octx = oc.getContext('2d'), oimg = octx.createImageData(N, N), od = oimg.data;
  // slubs / abrasion: a few hundred short fibres crossing the weave, aligned to the garment V axis (vertical on the
  // body, along the arm on a sleeve). Never darker than 0.90 — a dark stroke on a suit reads as a cut.
  const slub = new Float32Array(N * N);
  const nSlub = kind === 'denim' ? 900 : kind === 'nylon' ? 260 : 620;
  for (let i = 0; i < nSlub; i++) {
    const px = rng() * N, py = rng() * N, len = 6 + rng() * (kind === 'denim' ? 44 : 22), amp = (rng() - 0.42) * 0.14;
    const dx = (rng() - 0.5) * 0.5;
    for (let t = 0; t < len; t++) {
      const x = Math.round(px + dx * t) % N, y = Math.round(py + t) % N;
      slub[(((y % N) + N) % N) * N + (((x % N) + N) % N)] += amp * (1 - t / len);
    }
  }
  const mean = [0, 0, 0];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    let v = 1, hgt = 0.5, rough = 0.78, warm = 1;
    const bl = blotch[i] - 0.5, md = midN[i] - 0.5, fn = fine[i] - 0.5, fb = fibre[i] - 0.5;
    if (kind === 'grain') {                                       // pebbled calf: cell walls, scuffed highs
      const cell = vnoiseCell(x, y, N);
      hgt = 0.5 + cell * 0.36 + fn * 0.08;
      v = 1 + (cell - 0.5) * 0.13 + bl * 0.10 + md * 0.06;
      rough = 0.34 + (0.5 - cell) * 0.26 + bl * 0.14;
    } else if (kind === 'nylon') {                                // tricot: smooth, calendered, a soft ripple
      // (a ripstop grid at 13 texels read as burlap on every track top in the cast shot)
      hgt = 0.5 + md * 0.10 + fn * 0.03;
      v = 1 + bl * 0.06 + md * 0.035 + fb * 0.012;
      rough = 0.34 + bl * 0.08 + fn * 0.04;
    } else if (kind === 'denim') {                                // coarse 3/1 twill, indigo mottle, fades
      const tw = Math.sin((x * 3 + y * 3) * (TAU / 21));
      hgt = 0.5 + tw * 0.22 + fb * 0.20 + fn * 0.08;
      v = 1 + tw * 0.055 + bl * 0.15 + md * 0.07 + fb * 0.07 + Math.max(0, slub[i]);
      rough = 0.88 + tw * 0.04 + fn * 0.08;
      warm = 1 + tw * 0.01;
    } else if (kind === 'poplin') {                               // fine plain weave, crisp
      const w = Math.sin(x * (TAU / 4)) * Math.sin(y * (TAU / 4));
      hgt = 0.5 + w * 0.16 + fn * 0.06;
      v = 1 + w * 0.025 + bl * 0.055 + md * 0.03 + fb * 0.035;
      rough = 0.70 + fn * 0.10 - Math.abs(w) * 0.06;
    } else if (kind === 'knit') {                                 // rib knit: vertical wales with a rounded profile
      const wale = 0.5 + 0.5 * Math.cos((x % 9) / 9 * TAU), course = 0.5 + 0.5 * Math.cos((y % 11) / 11 * TAU);
      hgt = 0.34 + wale * 0.42 + course * 0.14 + fn * 0.08;
      v = 1 + (wale - 0.5) * 0.12 + (course - 0.5) * 0.05 + bl * 0.09 + fb * 0.05;
      rough = 0.90 - wale * 0.10 + fn * 0.08;
    } else {                                                      // worsted family: 2/2 twill at ~0.8 mm
      const tw = Math.sin((x + y) * (TAU / 5)), tw2 = Math.sin((x - y) * (TAU / 26));
      hgt = 0.5 + tw * 0.20 + tw2 * 0.05 + fb * 0.16 + fn * 0.07;
      v = 1 + tw * 0.030 + bl * 0.055 + md * 0.032 + fb * 0.04 + slub[i] * 0.35;
      rough = 0.80 + tw * 0.03 + fn * 0.09 + bl * 0.07;
      if (kind === 'pinstripe') {                                 // chalk stripe every 2.0 cm, one thread wide
        // 1.6 texels at +42 % mipped into corduroy the moment the camera left 2 m. A chalk stripe on worsted is a
        // single white thread: one texel, and only 14 % over the ground.
        const s = (x % 30) < 1 ? 1 : 0;
        v += s * 0.14; hgt += s * 0.04; rough += s * 0.03;
      } else if (kind === 'birdseye') {                           // 8 mm dotted ground
        const dx2 = (x % 12) - 6, dy2 = (y % 12) - 6, dot = Math.exp(-(dx2 * dx2 + dy2 * dy2) / 4.5);
        v += dot * 0.12; hgt += dot * 0.08;
      }
    }
    v = clamp(v, 0.88, 1.40);
    hh[i] = clamp(hgt, 0, 1);
    const k = i * 4;
    const r0 = base[0] * v * warm, g0 = base[1] * v, b0 = base[2] * v * (2 - warm);
    d[k] = clamp(r0, 0, 255); d[k + 1] = clamp(g0, 0, 255); d[k + 2] = clamp(b0, 0, 255); d[k + 3] = 255;
    mean[0] += d[k]; mean[1] += d[k + 1]; mean[2] += d[k + 2];
    od[k] = 255; od[k + 1] = clamp(rough, 0.12, 1) * 255; od[k + 2] = 0; od[k + 3] = 255;
  }
  // the tint pipeline (tintTo / tintOf) normalises the requested albedo against BASE_ALBEDO[key], so the swatch's
  // own mean has to land exactly on it or every garment comes out at the wrong value
  const px = N * N;
  for (let ch = 0; ch < 3; ch++) mean[ch] /= px;
  const gain = [base[0] / Math.max(mean[0], 1e-3), base[1] / Math.max(mean[1], 1e-3), base[2] / Math.max(mean[2], 1e-3)];
  for (let i = 0; i < px; i++) for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = clamp(d[i * 4 + ch] * gain[ch], 0, 255);
  ctx.putImageData(img, 0, 0); octx.putImageData(oimg, 0, 0);
  const rep = [GARMENT_REPEAT, GARMENT_REPEAT];
  const set = {
    map: texFromCanvas(c, true, rep),
    orm: texFromCanvas(oc, false, rep),
    normal: texFromCanvas(normalFromHeight(hh, N, kind === 'poplin' ? 1.0 : 1.9), false, rep),
  };
  garmentCache.set(id, set);
  return set;
}
function mat(key, color, extra = {}) {
  const id = key + '|' + color + '|' + JSON.stringify(extra);
  if (matCache.has(id)) return matCache.get(id);
  const L = lib();
  let m;
  if (L && BASE_ALBEDO[key]) {
    m = L.clone(key); if (extra.vc) m.color.set(0xffffff); else tintTo(m, key, color); m.name = key + '#h';
    if (key === 'suit' || key === 'cloth' || key === 'shirt' || key === 'shoes' || key === 'leather') {
      // body-scale swatch: albedo, roughness and normal all come off the same weave, so the garment has variation
      // at 10 cm AND at 1 mm instead of being one value with a façade-scale normal mipped to grey
      const dk = key === 'shirt' ? 'poplin' : (key === 'shoes' || key === 'leather') ? 'grain' : 'worsted';
      const g = garmentSet(extra.garment || dk, BASE_ALBEDO[key]);
      m.map = g.map; m.roughnessMap = g.orm; m.metalnessMap = g.orm; m.aoMap = null;
      m.normalMap = g.normal;
      if (m.normalScale) m.normalScale.set(extra.nscale ?? ((key === 'shoes' || key === 'leather') ? 0.7 : 1.05), extra.nscale ?? ((key === 'shoes' || key === 'leather') ? 0.7 : 1.05));
    }
    if (key === 'suit' || key === 'cloth') {          // wool: soft sheen so folds and the weave read under street light
      // 0x8a8aa0 is a ~0.24 reflectance and `sheen` does NOT scale with albedo, so on a 0x2b2b33 yakuza suit the
      // sheen lobe alone returned five times what the cloth did: every procedural suit in the cast shot rendered
      // as pale flannel while the hero, who carries the same charcoal, rendered black. Same fix as the scan's.
      m.sheen = extra.sheen ?? 0.30; m.sheenRoughness = 0.55; m.sheenColor = new THREE.Color(extra.sheenColor ?? 0x4a4e57);
      m.roughness = (extra.roughness ?? 0.62) / 0.85;
    }
    if (extra.roughness != null && key !== 'suit' && key !== 'cloth') m.roughness = extra.roughness;
    if (extra.clearcoat != null) { m.clearcoat = extra.clearcoat; m.clearcoatRoughness = extra.clearcoatRoughness ?? 0.32; }
    m.needsUpdate = true;
  } else if (L && extra.vc) {
    m = L.clone(key); m.color.set(0xffffff); m.name = key + '#h';
    if (extra.roughness != null) m.roughness = extra.roughness;
    if (extra.metalness != null) m.metalness = extra.metalness;
    m.needsUpdate = true;
  } else if (L) m = L.variant(key, { color, ...extra });
  else m = new THREE.MeshPhysicalMaterial({ color: extra.vc ? 0xffffff : color, roughness: extra.roughness ?? (key === 'shoes' ? 0.3 : 0.75), metalness: extra.metalness ?? 0, name: key });
  if (extra.vc) m.vertexColors = true;
  // the city env is authored for concrete and glass (environmentIntensity 0.18 at noon); a body is a small object
  // in the middle of it and needs the sky wrap turned up, or its shaded side has no fill at all
  envTrack(m, extra.env ?? 2.6);
  // A dark worsted needs its own hemisphere or it is a silhouette at 13:00; a white poplin needs almost none or it
  // clips. No gamut floor on garments — a chinpira's magenta track top is SUPPOSED to be out of the skin gamut.
  // `gnd` is the ground-bounce half's OWN scalar (not a multiple of `hemi`): a white poplin sees almost no
  // granite from inside a buttoned jacket, a trouser leg and a case standing on the plaza see all of it.
  charShader(m, { dark: 1,
    gnd: extra.gnd ?? (key === 'suit' || key === 'cloth' ? 5.0 : key === 'shirt' ? 0.8 : key === 'shoes' || key === 'leather' ? 3.6 : 1.6),
    hemi: extra.hemi ?? (key === 'suit' || key === 'cloth' ? 3.4 : key === 'shirt' ? 0.6 : key === 'shoes' || key === 'leather' ? 2.0 : 1.0) });
  matCache.set(id, m);
  return m;
}
// One material, several colours: the tint moves to a per-vertex colour attribute so the hero's black shoes, brown belt
// and (separately) navy tie / pocket square share a draw call. `tintOf` normalises against the library map's mean albedo
// exactly like tintTo(), so the requested hex is still the final albedo.
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
function tintOf(key, hex) {
  const b = BASE_ALBEDO[key];
  _c1.set(hex);
  return b ? [_c1.r / lin(b[0]), _c1.g / lin(b[1]), _c1.b / lin(b[2])] : [_c1.r, _c1.g, _c1.b];
}
const WHITE3 = [1, 1, 1];
// scale a colour in linear space and hand back an sRGB hex (tintOf/tintTo both take hexes)
function shadeHex(hex, k) { _c2.set(hex); return _c2.setRGB(_c2.r * k, _c2.g * k, _c2.b * k).getHex(); }
// fn(p, out) may override the tint per vertex (hair greying at the temples)
function vcolor(g, rgb, fn = null) {
  const p = g.attributes.position, n = p.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = fn ? fn(_p.set(p.getX(i), p.getY(i), p.getZ(i)), rgb) : rgb;
    a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function texFromCanvas(c, srgb, repeat = null) {
  const L = lib();
  if (L && typeof L.canvasTexture === 'function') return L.canvasTexture(c, { srgb, wrap: !!repeat, repeat: repeat || [1, 1] });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.needsUpdate = true;
  return t;
}
// ---------------------------------------------------------------- face atlas (512²)
// head unwrap: u = 0.5 + (a - π/2)/2π (a = ring angle, π/2 = face centre), v = 0.5 + 0.5 * yh / HEAD_H (yh from the chin;
// the neck continues below the chin as negative yh down to v 0.25). Bottom quarter: palm, five finger strips, ear, eyeball.
const HEAD_H = 0.235, ATLAS = 512, MOUTH_Y = 0.060;   // MOUTH_Y: mouth line above the chin — geometry and atlas share it
const HX = (a) => 256 + (a - HPI) * (ATLAS / TAU);                 // ring angle -> atlas x
const HY = (yh) => 256 - (yh / HEAD_H) * 256;                       // head height -> atlas y
const AX = (xm) => 256 + (xm / 0.085) * (ATLAS / TAU);              // metres across the face -> atlas x (r ≈ 8.5 cm)
const RECT = {                                                      // [x0, y0, x1, y1] atlas pixels
  palm: [2, 386, 94, 510], finger: (i) => [98 + i * 51, 388, 143 + i * 51, 508], ear: [354, 386, 414, 510], eye: [416, 384, 512, 480],
  limb: [418, 483, 510, 510],                                       // plain skin for bare arms / legs (mottle only, no features)
};
const rectUV = ([x0, y0, x1, y1]) => [x0 / ATLAS, 1 - y1 / ATLAS, x1 / ATLAS, 1 - y0 / ATLAS];
const skinCache = new Map();

function paintFace(face, rng) {
  const S = face.hires ? 2 : 1;                     // hero: 1024² atlas drawn in the same 512 coordinate space
  const c = document.createElement('canvas'); c.width = c.height = ATLAS * S;
  const x = c.getContext('2d'); x.scale(S, S);
  const o = document.createElement('canvas'); o.width = o.height = ATLAS * S;
  const ox = o.getContext('2d'); ox.scale(S, S);
  const [sr, sg, sb] = face.skin;
  const rgb = (m, a = 1, r = 1, g = 1, b = 1) => `rgba(${(sr * m * r) | 0},${(sg * m * g) | 0},${(sb * m * b) | 0},${a})`;
  const soft = (ctx, cx, cy, rx, ry, col0, col1) => { ctx.save(); ctx.translate(cx, cy); ctx.scale(rx, ry); const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, col0); g.addColorStop(1, col1); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill(); ctx.restore(); };
  // base skin: fine mottle (r 1-4 px) + a low-frequency colour pass (cool mouth/chin, warm nose/ears/cheeks)
  x.fillStyle = rgb(1); x.fillRect(0, 0, ATLAS, ATLAS);
  for (let i = 0; i < 900; i++) {
    const px = rng() * ATLAS, py = rng() * ATLAS, r = 1 + rng() * 3, k = 0.9 + rng() * 0.2;
    x.fillStyle = rgb(k, 0.1); x.beginPath(); x.arc(px, py, r, 0, TAU); x.fill();
  }
  // ORM base: R ao, G roughness (x material roughness 0.75), B metal
  ox.fillStyle = 'rgb(255,204,0)'; ox.fillRect(0, 0, ATLAS, ATLAS);
  const orm = (ao, rough, fn) => { ox.fillStyle = `rgb(${(ao * 255) | 0},${(rough * 255) | 0},0)`; fn(ox); };

  // ---- head region (yh 0.235 .. -0.115 = rows 0..381)
  const yEye = HY(0.135), yBrow = HY(0.152), yNose = HY(0.086), yLip = HY(MOUTH_Y);
  soft(x, 256, HY(0.10), 120, 40, 'rgba(210,90,80,0.14)', 'rgba(210,90,80,0)');                              // warm mid-face
  for (const s of [-1, 1]) soft(x, AX(s * 0.06), HY(0.118), 34, 30, 'rgba(200,80,70,0.16)', 'rgba(200,80,70,0)');   // cheeks
  soft(x, 256, HY(0.085), 14, 12, 'rgba(210,70,60,0.35)', 'rgba(210,70,60,0)');                               // nose tip
  soft(x, 256, HY(0.122), 8, 28, 'rgba(255,240,224,0.16)', 'rgba(255,240,224,0)');                            // bridge highlight
  soft(x, 256, HY(0.0885), 7.5, 5.5, 'rgba(255,242,228,0.2)', 'rgba(255,242,228,0)');                         // tip highlight
  for (const s of [-1, 1]) soft(x, HX(HPI + s * 1.6), HY(0.12), 22, 30, 'rgba(210,70,60,0.22)', 'rgba(210,70,60,0)'); // ears
  soft(x, 256, HY(0.035), 70, 34, 'rgba(120,130,170,0.16)', 'rgba(120,130,170,0)');                           // cool chin/mouth
  soft(x, 256, HY(0.2), 110, 40, 'rgba(255,230,200,0.12)', 'rgba(255,230,200,0)');                            // forehead lift
  soft(x, 256, HY(0.0), 120, 34, 'rgba(50,30,25,0.22)', 'rgba(50,30,25,0)');                                  // under-jaw shadow (into the neck)
  orm(1, 0.38, (k) => { k.beginPath(); k.ellipse(256, HY(0.17), 46, 34, 0, 0, TAU); k.fill(); });               // T-zone: forehead
  orm(1, 0.36, (k) => { k.fillRect(244, HY(0.155), 24, HY(0.072) - HY(0.155)); });                             // nose bridge + tip
  orm(1, 0.62, (k) => { for (const s of [-1, 1]) { k.beginPath(); k.ellipse(AX(s * 0.058), HY(0.11), 30, 26, 0, 0, TAU); k.fill(); } });  // cheeks: matte but not dead
  orm(1, 0.44, (k) => { for (const s of [-1, 1]) { k.beginPath(); k.ellipse(AX(s * 0.040), HY(0.125), 15, 12, 0, 0, TAU); k.fill(); } }); // cheekbone catches
  // eye sockets shading + lids + lashes
  for (const s of [-1, 1]) {
    const ex = AX(s * 0.031);
    soft(x, ex, yEye + 2, 26, 13, 'rgba(70,35,30,0.17)', 'rgba(70,35,30,0)');
    // Round 3 (critic: "flat painted face, no sockets/lids"): the orbit reads as a cavity -- a shadowed band under the
    // brow ridge, the lit brow bone above it, a lower-lid shadow and the lid's own fold 3 px above its margin
    soft(x, ex + s * 3, yEye - 7, 24, 8, 'rgba(58,28,22,0.26)', 'rgba(58,28,22,0)');
    soft(x, ex + s * 4, yBrow - 7, 24, 6, 'rgba(255,236,220,0.14)', 'rgba(255,236,220,0)');
    soft(x, ex, yEye + 9, 18, 5, 'rgba(78,38,40,0.16)', 'rgba(78,38,40,0)');
    x.strokeStyle = 'rgba(52,26,22,0.32)'; x.lineWidth = 1.1;
    x.beginPath(); x.ellipse(ex, yEye - 2.5, 15.5, 8.5, 0, Math.PI * 1.12, Math.PI * 1.88); x.stroke();
    if (face.fem) {
      // lash line and a short wing, a darker upper lash mass, a little lid colour, a lower lash line
      x.strokeStyle = 'rgba(22,12,12,0.85)'; x.lineWidth = 2.2; x.lineCap = 'round';
      x.beginPath(); x.ellipse(ex, yEye, 15, 7.5, 0, Math.PI * 1.06, Math.PI * 1.94); x.stroke();
      x.beginPath(); x.moveTo(ex + s * 14.5, yEye - 2); x.lineTo(ex + s * 19, yEye - 4.5); x.stroke();
      soft(x, ex, yEye - 5, 16, 5, 'rgba(120,70,80,0.22)', 'rgba(120,70,80,0)');
      x.strokeStyle = 'rgba(40,22,22,0.4)'; x.lineWidth = 0.9;
      x.beginPath(); x.ellipse(ex, yEye + 1, 14, 7, 0, Math.PI * 0.15, Math.PI * 0.85); x.stroke();
      soft(x, AX(s * 0.052), HY(0.108), 26, 18, 'rgba(214,96,100,0.16)', 'rgba(214,96,100,0)');   // blush
    }
    orm(0.74, 0.7, (k) => { k.beginPath(); k.ellipse(ex, yEye, 24, 15, 0, 0, TAU); k.fill(); });
    x.strokeStyle = 'rgba(40,20,16,0.7)'; x.lineWidth = 1.4; x.lineCap = 'round';
    x.beginPath(); x.ellipse(ex, yEye, 15, 7.5, 0, Math.PI * 1.08, Math.PI * 1.92); x.stroke();          // upper lid margin
    x.lineWidth = 1; x.strokeStyle = 'rgba(90,50,40,0.45)';
    x.beginPath(); x.ellipse(ex, yEye + 1, 15, 7.5, 0, Math.PI * 0.12, Math.PI * 0.88); x.stroke();     // lower lid
    x.fillStyle = 'rgba(30,18,14,0.8)';                                                                   // lash mass, outer corner
    x.beginPath(); x.ellipse(ex + s * 12, yEye - 3, 3, 1.5, s * 0.5, 0, TAU); x.fill();
    soft(x, ex, yEye - 5.5, 16, 5, 'rgba(60,32,26,0.27)', 'rgba(60,32,26,0)');                            // lid crease shadow
    // eyebrow: strong but hair-like — a soft mass plus strokes along it, angled inward-down when scowling
    const bw = face.brow, ang = face.browAngle;
    const b0 = [ex - s * 17, yBrow + 2 - ang * 5], b1 = [ex + s * 4, yBrow - 6 - bw * 2 + ang * 2], b2 = [ex + s * 26, yBrow - 1 + ang * 4];
    const bAt = (t, k) => (1 - t) * (1 - t) * b0[k] + 2 * t * (1 - t) * b1[k] + t * t * b2[k];
    // A brow is hair, not a bar. 2.4 + 2.6·bw at 0.8 alpha painted a 4.7 px caterpillar across a 43 px eye — the
    // second thing (after the sclera) that made the cast's faces read as masks. The mass is now a soft spine and
    // the read comes from 54 individual hairs fanning off it, thinning to nothing at the tail.
    x.save(); x.globalAlpha = 0.46;
    x.strokeStyle = face.hair; x.lineWidth = 1.7 + bw * 1.8; x.lineCap = 'round';
    x.beginPath(); x.moveTo(b0[0], b0[1]); x.quadraticCurveTo(b1[0], b1[1], b2[0], b2[1]); x.stroke();
    for (let i = 0; i < 54; i++) {
      const t = i / 53, px = bAt(t, 0), py = bAt(t, 1) + (rng() - 0.5) * (2.2 + bw * 2.2);
      const k = 1 - 0.55 * Math.max(0, (t - 0.55) / 0.45);                 // the tail thins off toward the temple
      x.globalAlpha = (0.30 + 0.34 * rng()) * k; x.lineWidth = 0.7 + rng() * 0.8;
      x.beginPath(); x.moveTo(px - s * (1.5 + rng()), py + 2.4 + rng()); x.lineTo(px + s * (3.5 + rng() * 2.5), py - 2.6 - rng() * 1.6); x.stroke();
    }
    x.restore();
    // nostril shadow, nose side shading
    soft(x, AX(s * 0.0125), yNose + 1.5, 5.5, 3.6, 'rgba(66,30,24,0.5)', 'rgba(66,30,24,0)');
    soft(x, AX(s * 0.019), HY(0.098), 7, 22, 'rgba(70,35,30,0.16)', 'rgba(70,35,30,0)');                  // ala / nose side
    soft(x, AX(s * 0.0165), HY(0.0855), 4.5, 4, 'rgba(255,238,222,0.12)', 'rgba(255,238,222,0)');         // ala highlight
    orm(0.6, 0.7, (k) => { k.beginPath(); k.ellipse(AX(s * 0.0125), yNose + 1.5, 5, 3.4, 0, 0, TAU); k.fill(); });
  }
  // lips
  const lipCol = face.lip || [150, 78, 74], lipA = face.lipA ?? 1;
  x.fillStyle = `rgba(${lipCol[0]},${lipCol[1]},${lipCol[2]},${0.7 * lipA})`;
  x.beginPath(); x.moveTo(AX(-0.021), yLip); x.quadraticCurveTo(AX(-0.008), yLip - 6, 256, yLip - 4); x.quadraticCurveTo(AX(0.008), yLip - 6, AX(0.021), yLip); x.quadraticCurveTo(256, yLip + 2, AX(-0.021), yLip); x.fill();
  x.fillStyle = `rgba(${lipCol[0] + 30},${lipCol[1] + 20},${lipCol[2] + 20},${0.65 * lipA})`;
  x.beginPath(); x.moveTo(AX(-0.02), yLip + 1); x.quadraticCurveTo(256, yLip + 12, AX(0.02), yLip + 1); x.quadraticCurveTo(256, yLip + 3, AX(-0.02), yLip + 1); x.fill();
  x.strokeStyle = 'rgba(56,26,22,0.6)'; x.lineWidth = 1.25;                                               // a mouth LINE, not a slit
  x.beginPath(); x.moveTo(AX(-0.021), yLip + 0.5); x.quadraticCurveTo(256, yLip + 3, AX(0.021), yLip + 0.5); x.stroke();
  orm(0.9, 0.30, (k) => { k.beginPath(); k.ellipse(256, yLip + 2, 22, 9, 0, 0, TAU); k.fill(); });
  // philtrum: a faint vertical groove. As a 5x4 px dot at 0.35 it read as a toothbrush moustache on every pedestrian.
  soft(x, 256, HY(MOUTH_Y + 0.013), 2.6, 7, 'rgba(60,25,20,0.14)', 'rgba(60,25,20,0)');
  for (const s of [-1, 1]) soft(x, 256 + s * 3.2, HY(MOUTH_Y + 0.013), 1.6, 6, 'rgba(255,232,214,0.10)', 'rgba(255,232,214,0)');   // its two lit ridges
  soft(x, 256, HY(MOUTH_Y - 0.020), 22, 5, 'rgba(60,25,20,0.25)', 'rgba(60,25,20,0)');                     // labiomental fold
  // nasolabial folds: crease from the nostril wing past the mouth corner + the lit cheek ridge outboard of it
  if (face.nlf > 0) {
    const nf = face.nlf;
    x.lineCap = 'round';
    for (const s of [-1, 1]) {
      x.strokeStyle = `rgba(78,40,30,${0.26 * nf})`; x.lineWidth = 2.8;
      x.beginPath(); x.moveTo(AX(s * 0.0155), yNose + 1); x.quadraticCurveTo(AX(s * 0.032), yLip - 11, AX(s * 0.030), yLip + 8); x.stroke();
      x.strokeStyle = `rgba(96,50,38,${0.18 * nf})`; x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(AX(s * 0.0135), yNose + 3); x.quadraticCurveTo(AX(s * 0.030), yLip - 10, AX(s * 0.028), yLip + 7); x.stroke();
      x.strokeStyle = `rgba(255,226,208,${0.13 * nf})`; x.lineWidth = 2.6;                                  // cheek side catches light
      x.beginPath(); x.moveTo(AX(s * 0.022), yNose - 2); x.quadraticCurveTo(AX(s * 0.039), yLip - 12, AX(s * 0.037), yLip + 5); x.stroke();
      soft(x, AX(s * 0.029), yLip + 11, 9, 6, `rgba(70,32,26,${0.2 * nf})`, 'rgba(70,32,26,0)');            // mouth-corner pit
    }
  }
  // stubble / five o'clock shadow, running under the jaw into the neck rows.
  // `beard` joins a moustache and the chin patch (denser around the mouth) over the lighter cheek/jaw shadow.
  if (face.stubble > 0) {
    const a = face.stubble, bd = face.beard || 0;
    soft(x, 256, HY(0.03), 80, 42, `rgba(40,30,28,${0.20 * a})`, 'rgba(40,30,28,0)');
    for (const s of [-1, 1]) soft(x, AX(s * 0.062), HY(0.07), 28, 46, `rgba(40,30,28,${0.15 * a})`, 'rgba(40,30,28,0)');
    const yM = HY(MOUTH_Y + 0.012), yC = HY(MOUTH_Y - 0.009), yCh = HY(MOUTH_Y - 0.037);
    if (bd > 0) {
      soft(x, 256, yM, 30, 7.5, `rgba(30,22,20,${0.3 * bd})`, 'rgba(30,22,20,0)');                           // moustache, clear of the nose
      for (const s of [-1, 1]) soft(x, AX(s * 0.024), yC, 9, 15, `rgba(30,22,20,${0.26 * bd})`, 'rgba(30,22,20,0)');  // down the mouth corners
      soft(x, 256, yCh, 27, 15, `rgba(30,22,20,${0.36 * bd})`, 'rgba(30,22,20,0)');                          // chin patch
      soft(x, 256, HY(MOUTH_Y - 0.012), 17, 7, `rgba(30,22,20,${0.22 * bd})`, 'rgba(30,22,20,0)');           // under the lower lip
    }
    // hair dots: density from the same mask so the beard edge is soft, ~12 % grey (42 years old)
    const gs = (v, s2) => Math.exp(-(v * v) / (2 * s2 * s2));
    const dens = (mx, py) => {
      const d0 = 0.42 * gs(mx / 96, 0.62) * gs((py - HY(MOUTH_Y - 0.018)) / 44, 0.66);
      if (bd <= 0) return d0;
      const m = gs(mx / 30, 0.8) * gs((py - yM) / 9, 0.85)
        + gs((Math.abs(mx) - 24) / 10, 0.85) * gs((py - yC) / 16, 0.9)
        + gs(mx / 28, 0.85) * gs((py - yCh) / 17, 0.9);
      return clamp(d0 + bd * 1.0 * m, 0, 1);
    };
    const dn = face.hires ? 0.5 : 1.2, dcount = face.hires ? 11000 : 1700;
    for (let i = 0; i < dcount; i++) {
      const px = 256 + (rng() - 0.5) * 204, py = HY(0.080) + rng() * (HY(-0.032) - HY(0.080)), mx = px - 256;
      if (Math.abs(mx) < 25 && py > HY(MOUTH_Y + 0.007) && py < HY(MOUTH_Y - 0.013)) continue;              // lips stay bare
      if (py > HY(0) && Math.abs(mx) > 60 + (py - HY(0)) * 0.6) continue;                                   // outside the jaw
      if (rng() > dens(mx, py)) continue;
      x.fillStyle = rng() < 0.13 ? `rgba(158,153,146,${0.5 * a})` : `rgba(30,23,21,${0.55 * a})`;
      x.fillRect(px, py, dn, dn * 1.35);
    }
    orm(1, 0.85, (k) => { k.globalAlpha = 0.6 * a; k.fillRect(150, HY(0.085), 212, HY(-0.02) - HY(0.085)); k.globalAlpha = 1; });
    if (bd > 0) orm(1, 0.95, (k) => { k.globalAlpha = 0.7 * bd; k.beginPath(); k.ellipse(256, HY(0.045), 44, 40, 0, 0, TAU); k.fill(); k.globalAlpha = 1; });
  }
  if (face.age > 0) {                                                                                         // crow's feet, nasolabial
    x.strokeStyle = `rgba(80,40,30,${0.35 * face.age})`; x.lineWidth = 1.2;
    for (const s of [-1, 1]) { for (let i = 0; i < 3; i++) { x.beginPath(); x.moveTo(AX(s * 0.048), yEye + i * 3 - 3); x.lineTo(AX(s * 0.062), yEye + i * 6 - 8); x.stroke(); } x.beginPath(); x.moveTo(AX(s * 0.018), yNose + 4); x.quadraticCurveTo(AX(s * 0.03), yLip - 4, AX(s * 0.028), yLip + 10); x.stroke(); }
    x.strokeStyle = `rgba(80,40,30,${0.25 * face.age})`; for (let i = 0; i < 2; i++) { x.beginPath(); x.moveTo(230, HY(0.175) + i * 7); x.quadraticCurveTo(256, HY(0.178) + i * 7, 282, HY(0.175) + i * 7); x.stroke(); }
  }
  if (face.scar) {                                                                                            // boss: pale keloid across the left cheek
    x.lineCap = 'round';
    // An old keloid is a raised, DESATURATED ridge that catches light on one side — not a white line. At 0.9 alpha
    // over (232,180,170) it read as a wet tear running down the boss's cheek in every cast frame.
    x.strokeStyle = 'rgba(158,92,80,0.42)'; x.lineWidth = 5; x.beginPath(); x.moveTo(AX(0.058), HY(0.162)); x.lineTo(AX(0.05), HY(0.145)); x.lineTo(AX(0.054), HY(0.122)); x.lineTo(AX(0.048), HY(0.098)); x.stroke();
    x.strokeStyle = 'rgba(206,158,142,0.20)'; x.lineWidth = 2.2; x.beginPath(); x.moveTo(AX(0.0575), HY(0.161)); x.lineTo(AX(0.0497), HY(0.145)); x.lineTo(AX(0.0537), HY(0.122)); x.lineTo(AX(0.0477), HY(0.099)); x.stroke();
    x.strokeStyle = 'rgba(120,58,50,0.28)'; x.lineWidth = 1; for (let i = 0; i < 5; i++) { const py = HY(0.157) + i * 6; x.beginPath(); x.moveTo(AX(0.056) - 4, py); x.lineTo(AX(0.056) + 4, py + 2); x.stroke(); }
    orm(1, 0.5, (k) => { k.lineWidth = 5; k.strokeStyle = 'rgb(255,128,0)'; k.beginPath(); k.moveTo(AX(0.058), HY(0.165)); k.lineTo(AX(0.046), HY(0.09)); k.stroke(); });
  }
  // mandible: the masseter hollow above the bone's lower border and the lit border itself. The geometry now carries
  // the ridge (headRadius), and without the value under it a jaw edge at this pixel density is invisible.
  { x.lineCap = 'round'; x.lineJoin = 'round';
    const jy = (d) => HY(0.011 + 0.035 * sstep((d - 0.22) / 0.98));
    for (const s of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 12; i++) { const d = 0.04 + 1.36 * (i / 12); pts.push([HX(HPI + s * d), jy(d)]); }
      const run = (dy, col, lw) => { x.strokeStyle = col; x.lineWidth = lw; x.beginPath(); x.moveTo(pts[0][0], pts[0][1] + dy); for (const [px, py] of pts) x.lineTo(px, py + dy); x.stroke(); };
      run(-9, 'rgba(62,31,25,0.10)', 11);                       // masseter / submandibular hollow
      run(-1, 'rgba(255,228,206,0.075)', 5.5);                  // the bone border catches the sky
      run(4, 'rgba(46,24,19,0.15)', 6);                         // and falls away under it
    }
    soft(x, 256, HY(0.024), 26, 13, 'rgba(255,230,208,0.11)', 'rgba(255,230,208,0)'); }   // chin front plane
  // (no AO ellipse on the masseter: faceNormal() Sobels ORM.R into the normal map, so a hard-edged cavity shape
  //  comes back as an embossed ring — two of them sat at the mouth corners like blisters.)
  // neck form: the sterno-mastoid pair from behind the ear to the sternal notch, the notch shadow and a lit larynx —
  // the most expressive junction on a Yakuza character (jaw over a thick neck over a white collar) used to be a hole
  for (const s of [-1, 1]) {
    x.strokeStyle = 'rgba(74,38,30,0.30)'; x.lineWidth = 5; x.lineCap = 'round';
    x.beginPath(); x.moveTo(AX(s * 0.052), HY(-0.008)); x.quadraticCurveTo(AX(s * 0.030), HY(-0.052), AX(s * 0.010), HY(-0.093)); x.stroke();
    x.strokeStyle = 'rgba(255,224,204,0.16)'; x.lineWidth = 3.5;
    x.beginPath(); x.moveTo(AX(s * 0.062), HY(-0.010)); x.quadraticCurveTo(AX(s * 0.040), HY(-0.054), AX(s * 0.020), HY(-0.094)); x.stroke();
    soft(x, AX(s * 0.075), HY(-0.05), 16, 34, 'rgba(56,28,22,0.24)', 'rgba(56,28,22,0)');                   // trapezius side falls away
  }
  soft(x, 256, HY(-0.100), 26, 11, 'rgba(50,26,20,0.34)', 'rgba(50,26,20,0)');                              // sternal notch
  soft(x, 256, HY(-0.044), 9, 12, 'rgba(255,230,210,0.14)', 'rgba(255,230,210,0)');                         // larynx
  orm(0.86, 0.72, (k) => { k.beginPath(); k.ellipse(256, HY(-0.045), 34, 26, 0, 0, TAU); k.fill(); });
  // neck: cooler + slightly darker than the face, no hard seam (the multiply fades in over 1.5 cm below the chin)
  const nk = x.createLinearGradient(0, HY(0.012), 0, HY(-0.03)); nk.addColorStop(0, 'rgba(255,255,255,1)'); nk.addColorStop(1, 'rgba(238,241,250,1)');
  x.globalCompositeOperation = 'multiply'; x.fillStyle = nk; x.fillRect(0, HY(0.012), ATLAS, HY(-0.03) - HY(0.012));
  x.fillStyle = 'rgb(238,241,250)'; x.fillRect(0, HY(-0.03), ATLAS, HY(-0.12) - HY(-0.03));
  x.globalCompositeOperation = 'source-over';
  orm(1, 0.9, (k) => k.fillRect(0, HY(-0.01), ATLAS, HY(-0.12) - HY(-0.01)));
  // where the throat enters the collar: the contact gradient that makes the shirt read as cloth wrapping a neck
  { const cg = x.createLinearGradient(0, HY(-0.055), 0, HY(NECK_UV));
    cg.addColorStop(0, 'rgba(26,18,16,0)'); cg.addColorStop(0.55, 'rgba(26,18,16,0.42)'); cg.addColorStop(1, 'rgba(18,12,11,0.8)');
    x.fillStyle = cg; x.fillRect(0, HY(-0.055), ATLAS, HY(NECK_UV) - HY(-0.055));
    const og = ox.createLinearGradient(0, HY(-0.05), 0, HY(NECK_UV));
    og.addColorStop(0, 'rgba(255,230,0,0)'); og.addColorStop(1, 'rgba(70,230,0,1)');
    ox.fillStyle = og; ox.fillRect(0, HY(-0.05), ATLAS, HY(NECK_UV) - HY(-0.05)); }
  // scalp under the hair shell (matches hair colour so gaps read as hair)
  x.fillStyle = face.hair; x.globalAlpha = 0.85;
  { const ht = face.hairTop ?? 0.188;
    x.beginPath(); x.moveTo(0, 0); x.lineTo(ATLAS, 0); x.lineTo(ATLAS, HY(ht - 0.138)); x.quadraticCurveTo(384, HY(ht - 0.103), 330, HY(ht - 0.058)); x.quadraticCurveTo(300, HY(ht - 0.006), 256, HY(ht)); x.quadraticCurveTo(212, HY(ht - 0.006), 182, HY(ht - 0.058)); x.quadraticCurveTo(128, HY(ht - 0.103), 0, HY(ht - 0.138)); x.closePath(); x.fill();
    // Roots: the shell's rim is a polygon wherever it leaves the skull, and a hard colour step from hair to skin
    // across it is what made every head read as a moulded cap. Paint individual hairs crossing the line, thinning
    // downward, so the transition happens in strands the way a real hairline does.
    x.save(); x.lineCap = 'round'; x.strokeStyle = face.hair;
    for (let i = 0; i < 520; i++) {
      const px = rng() * ATLAS, t = Math.abs(px - 256) / 256;
      const base = HY(lerp(ht - 0.004, ht - 0.056, t * t)) + (rng() - 0.5) * 3;
      const len = (3 + rng() * 11) * (1 - 0.45 * rng());
      x.globalAlpha = 0.72 * (1 - len / 16) + 0.12;
      x.lineWidth = 0.7 + rng() * 0.9;
      x.beginPath(); x.moveTo(px, base - 2); x.lineTo(px + (rng() - 0.5) * 5, base + len); x.stroke();
    }
    x.restore(); }
  x.globalAlpha = 1;
  // ---- palm (u 0/1 = back of the hand, 0.5 = palm; v 1 = finger end): knuckle darkening, tendons, palm creases
  {
    const [x0, y0, x1, y1] = RECT.palm, w = x1 - x0, h = y1 - y0;
    soft(x, x0 + w * 0.5, y0 + h * 0.5, w * 0.62, h * 0.7, 'rgba(225,125,105,0.08)', 'rgba(225,125,105,0)');
    for (const bx of [x0 + 4, x1 - 4]) {
      soft(x, bx, y0 + 6, 22, 9, 'rgba(120,50,40,0.28)', 'rgba(120,50,40,0)');                             // MCP knuckle redness/shadow
      x.strokeStyle = 'rgba(90,45,35,0.075)'; x.lineWidth = 1.2;                                             // tendons: at 1.2 m
      for (let i = -1; i <= 1; i++) { x.beginPath(); x.moveTo(bx + i * 6, y0 + 14); x.lineTo(bx + i * 8, y0 + h * 0.52); x.stroke(); }   // a painted stripe reads as a stripe
    }
    x.strokeStyle = 'rgba(100,45,35,0.35)'; x.lineWidth = 1.6;                                              // palm creases
    x.beginPath(); x.moveTo(x0 + w * 0.32, y0 + h * 0.3); x.quadraticCurveTo(x0 + w * 0.5, y0 + h * 0.5, x0 + w * 0.7, y0 + h * 0.36); x.stroke();
    x.beginPath(); x.moveTo(x0 + w * 0.36, y0 + h * 0.5); x.quadraticCurveTo(x0 + w * 0.55, y0 + h * 0.62, x0 + w * 0.68, y0 + h * 0.75); x.stroke();
    orm(1, 0.82, (k) => k.fillRect(x0, y0, w, h));
    orm(0.8, 0.7, (k) => { for (const bx of [x0 + 4, x1 - 4]) { k.beginPath(); k.ellipse(bx, y0 + 6, 18, 8, 0, 0, TAU); k.fill(); } });
  }
  // ---- finger strips (u 0.25 = palm side, 0.75 = back; v 1 = tip): nail, joint creases, knuckle shading
  for (let i = 0; i < 5; i++) {
    const [x0, y0, x1, y1] = RECT.finger(i), w = x1 - x0, h = y1 - y0, joints = i < 4 ? [0.42, 0.72] : [0.45];
    soft(x, x0 + w * 0.5, y0 + h * 0.5, w * 0.7, h * 0.7, 'rgba(230,120,100,0.1)', 'rgba(230,120,100,0)');
    for (const s of joints) {
      const py = y0 + h * (1 - s);
      x.strokeStyle = 'rgba(90,40,32,0.42)'; x.lineWidth = 1.5;                                                // palm-side crease
      x.beginPath(); x.moveTo(x0 + w * 0.08, py); x.quadraticCurveTo(x0 + w * 0.25, py + 2, x0 + w * 0.42, py); x.stroke();
      soft(x, x0 + w * 0.75, py, 9, 4, 'rgba(110,50,40,0.3)', 'rgba(110,50,40,0)');                             // knuckle back
      orm(0.78, 0.82, (k) => { k.beginPath(); k.ellipse(x0 + w * 0.25, py, 8, 2, 0, 0, TAU); k.fill(); });
    }
    { const eg = x.createLinearGradient(x0, 0, x1, 0);                                                      // side walls fall into the valley
      eg.addColorStop(0, 'rgba(48,24,18,0.55)'); eg.addColorStop(0.16, 'rgba(48,24,18,0)');
      eg.addColorStop(0.84, 'rgba(48,24,18,0)'); eg.addColorStop(1, 'rgba(48,24,18,0.55)');
      x.fillStyle = eg; x.fillRect(x0, y0, w, h);
      orm(0.42, 0.9, (k) => { k.fillRect(x0, y0, w * 0.13, h); k.fillRect(x1 - w * 0.13, y0, w * 0.13, h); }); }
    const nx = x0 + w * 0.66, ny = y0 + 4, nw = w * 0.2, nh = 13;                                           // nail
    x.fillStyle = rgb(1.1, 0.9, 1, 0.98, 0.98); x.beginPath(); x.roundRect(nx, ny, nw, nh, 3); x.fill();
    x.strokeStyle = 'rgba(120,60,50,0.4)'; x.lineWidth = 1; x.beginPath(); x.roundRect(nx, ny, nw, nh, 3); x.stroke();
    x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(nx + 1, ny + 1, nw * 0.5, 2);
    orm(1, 0.35, (k) => { k.beginPath(); k.roundRect(nx, ny, nw, nh, 3); k.fill(); });
  }
  // ---- ear (u around the outline, v 0 = attachment, 1 = canal): concha shadow, antihelix, helix highlight
  {
    const [x0, y0, x1, y1] = RECT.ear, w = x1 - x0, h = y1 - y0;
    const g = x.createLinearGradient(0, y1, 0, y0); g.addColorStop(0, 'rgba(120,60,50,0)'); g.addColorStop(0.55, 'rgba(120,60,50,0.05)'); g.addColorStop(0.72, 'rgba(90,40,32,0.45)'); g.addColorStop(1, 'rgba(60,25,20,0.8)');
    x.fillStyle = g; x.fillRect(x0, y0, w, h);
    x.fillStyle = 'rgba(255,220,200,0.18)'; x.fillRect(x0, y0 + h * 0.42, w, h * 0.12);                        // helix rim catches light
    x.strokeStyle = 'rgba(80,35,28,0.5)'; x.lineWidth = 2; x.beginPath(); x.moveTo(x0, y0 + h * 0.36); x.quadraticCurveTo(x0 + w * 0.5, y0 + h * 0.3, x1, y0 + h * 0.36); x.stroke();   // antihelix
    orm(0.7, 0.8, (k) => k.fillRect(x0, y0, w, h * 0.35));
  }
  // ---- eyeball (v=1 pole = front): sclera, iris, limbal ring, pupil, catchlight texel upper-left of the pupil
  {
    const [x0, y0, x1, y1] = RECT.eye, w = x1 - x0, h = y1 - y0, ir = face.iris || [70, 42, 30];
    // A sclera is NOT white: lit by the same sky as the cheek it sits under and shaded by a lid, it measures well
    // below the surrounding skin. At 226 every procedural face in the cast read wide-eyed, because the one chart
    // brighter than anything else on the head was the whites of the eyes.
    x.fillStyle = 'rgb(196,188,180)'; x.fillRect(x0, y0, w, h);
    const scl = x.createLinearGradient(0, y0 + h * 0.4, 0, y1); scl.addColorStop(0, 'rgba(210,150,150,0)'); scl.addColorStop(1, 'rgba(200,120,120,0.5)');
    x.fillStyle = scl; x.fillRect(x0, y0 + h * 0.4, w, h * 0.6);
    x.strokeStyle = 'rgba(200,60,60,0.3)'; x.lineWidth = 0.8; for (let i = 0; i < 10; i++) { const px = x0 + rng() * w; x.beginPath(); x.moveTo(px, y1); x.lineTo(px + (rng() - 0.5) * 8, y0 + h * 0.5 + rng() * 20); x.stroke(); }
    x.fillStyle = `rgb(${ir[0]},${ir[1]},${ir[2]})`; x.fillRect(x0, y0, w, 14);                             // iris band (v 0.85..1, r ≈ 5.5 mm)
    for (let i = 0; i < 48; i++) { x.fillStyle = `rgba(${ir[0] + 70},${ir[1] + 45},${ir[2] + 25},${0.25 + rng() * 0.4})`; x.fillRect(x0 + i * 2 + rng(), y0 + 5, 1, 9); }
    x.fillStyle = 'rgba(20,10,8,0.9)'; x.fillRect(x0, y0 + 13, w, 2);                                       // limbal ring
    x.fillStyle = 'rgb(8,6,6)'; x.fillRect(x0, y0, w, 6);                                                    // pupil (pole)
    x.fillStyle = 'rgba(255,255,255,0.95)'; x.beginPath(); x.ellipse(x0 + w * 0.62, y0 + 8, 3.2, 2.2, 0, 0, TAU); x.fill();   // catchlight
    x.fillStyle = 'rgba(255,255,255,0.5)'; x.fillRect(x0 + w * 0.62 - 6, y0 + 8, 12, 1);
    // Lid occlusion, baked onto the ball. The eyeball is its own sphere with its own material, so no amount of
    // shading on the FACE can put a lid shadow on it — and an unoccluded ball is the other half of the stare.
    // u = 0.75 of the sphere's sweep is the top of the eye after the +z rotate, u = 0.25 the bottom.
    { const lid = x.createLinearGradient(x0 + w * 0.30, 0, x1, 0);
      lid.addColorStop(0, 'rgba(26,18,16,0.16)'); lid.addColorStop(0.36, 'rgba(26,18,16,0)');
      lid.addColorStop(0.66, 'rgba(22,15,13,0.34)'); lid.addColorStop(1, 'rgba(18,12,11,0.62)');
      x.fillStyle = lid; x.fillRect(x0 + w * 0.30, y0, w * 0.70, h); }
    orm(1, 0.12, (k) => k.fillRect(x0, y0, w, h));
    orm(0.55, 0.12, (k) => { k.globalAlpha = 0.9; k.fillRect(x0 + w * 0.80, y0, w * 0.20, h); k.globalAlpha = 0.5; k.fillRect(x0 + w * 0.66, y0, w * 0.14, h); k.globalAlpha = 1; });
  }
  // ---- limb skin (bare arms, legs): the base tone with a faint warm mottle, a little cooler than the face
  { const [x0, y0, x1, y1] = RECT.limb, w = x1 - x0, h = y1 - y0;
    x.fillStyle = rgb(0.97, 1, 1, 1, 1.02); x.fillRect(x0, y0, w, h);
    for (let i = 0; i < 60; i++) { x.fillStyle = rgb(0.9 + rng() * 0.18, 0.12); x.beginPath(); x.arc(x0 + rng() * w, y0 + rng() * h, 1 + rng() * 2, 0, TAU); x.fill(); }
    orm(1, 0.78, (k) => k.fillRect(x0, y0, w, h)); }
  return { albedo: c, orm: o };
}

// The painted face carried its whole form in the albedo, so every procedural head read as a flat mask the moment a
// light moved off axis. The ORM's red channel is ambient occlusion — a cavity map of the eye sockets, the crease of
// the lids, the nasolabial fold, the lip line, the stubble — so Sobel it into a real tangent-space normal and hand
// the face macro relief. Pores go into the same canvas so there is still sub-millimetre break-up at 30 cm.
function faceNormal(ormCanvas, rng) {
  const N = ormCanvas.width, src = ormCanvas.getContext('2d').getImageData(0, 0, N, N).data;
  const h = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) h[i] = src[i * 4] / 255;
  // Box blur (AO is painted with hard edges), SEPARABLE: the square version is O(N²R²), which at the hero's
  // 1024² atlas is 300 M samples per face — seconds of main-thread canvas work, and it showed up as a four-second
  // hitch whenever a LOD0 body was built. Two sliding-window passes are O(N²) at any radius.
  const b = new Float32Array(N * N), tmp = new Float32Array(N * N), R = Math.max(2, N >> 7);
  for (let y = 0; y < N; y++) {
    const row = y * N;
    let s = 0, n = 0;
    for (let x = 0; x <= R && x < N; x++) { s += h[row + x]; n++; }
    for (let x = 0; x < N; x++) {
      tmp[row + x] = s / n;
      const add = x + R + 1, sub = x - R;
      if (add < N) { s += h[row + add]; n++; }
      if (sub >= 0) { s -= h[row + sub]; n--; }
    }
  }
  for (let x = 0; x < N; x++) {
    let s = 0, n = 0;
    for (let y = 0; y <= R && y < N; y++) { s += tmp[y * N + x]; n++; }
    for (let y = 0; y < N; y++) {
      b[y * N + x] = s / n;
      const add = y + R + 1, sub = y - R;
      if (add < N) { s += tmp[add * N + x]; n++; }
      if (sub >= 0) { s -= tmp[sub * N + x]; n--; }
    }
  }
  const c = document.createElement('canvas'); c.width = c.height = N;
  const ctx = c.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
  const K = N * 0.022;                                                // height gain, in the same units as the atlas
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const xm = Math.max(0, x - 1), xp = Math.min(N - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(N - 1, y + 1);
    let nx = (b[y * N + xm] - b[y * N + xp]) * K, ny = (b[ym * N + x] - b[yp * N + x]) * K;
    nx += (rng() - 0.5) * 0.07; ny += (rng() - 0.5) * 0.07;           // pores
    const inv = 1 / Math.hypot(nx, ny, 1), k = (y * N + x) * 4;
    d[k] = (nx * inv * 0.5 + 0.5) * 255; d[k + 1] = (ny * inv * 0.5 + 0.5) * 255; d[k + 2] = (inv * 0.5 + 0.5) * 255; d[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
// skin materials are refcounted (pedestrian faces are quantised to a 16-entry pool upstream): textures are freed at 0 refs
function acquireSkin(face, seed) {
  const id = JSON.stringify(face);
  let e = skinCache.get(id);
  if (e) { e.refs++; return e.m; }
  const L = lib();
  let m;
  if (L && typeof L.clone === 'function') { m = L.clone('skin'); m.color.set(0xffffff); }
  else m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  // skin needs a broad grazing sheen and a whisper of clearcoat or it reads as clay; the T-zone comes from the ORM green
  m.sheen = 0.2; m.sheenRoughness = 0.6; m.sheenColor = new THREE.Color(0xe8b8a0);
  m.clearcoat = 0.05; m.clearcoatRoughness = 0.55;
  const tex = paintFace(face, mulberry(seed || 7));
  m.map = texFromCanvas(tex.albedo, true);
  const orm = texFromCanvas(tex.orm, false);
  m.roughnessMap = orm; m.metalnessMap = orm; m.aoMap = orm; m.aoMapIntensity = 1;
  m.normalMap = texFromCanvas(faceNormal(tex.orm, mulberry(seed || 7)), false);   // cavity -> relief, pores baked in
  m.normalMap.repeat.set(1, 1);
  m.normalScale.set(1.35, 1.35);                       // (round 4: 0.85 -> 1.35, the brow ridge and nose have to read at 2 m)
  m.roughness = 0.75; m.metalness = 0;
  m.name = 'skin#face';
  m.userData.skinId = id;
  m.needsUpdate = true;
  // The env is where a sign's colour reaches a face: at 2.2 the TSUTAYA yellow behind the cast owned the whole
  // skin chart. Down to 1.15, with the difference made up by the neutral hemisphere term instead.
  envTrack(m, 1.15);
  // every skin chart — face, neck, ears, palm, fingers — is this one material, so the anchor, the channel floors
  // AND the wedge reach all of them. Round 5 measured a face at B/R 0.297 against its own neck at 0.490.
  charShader(m, { gamut: SKIN_GAMUT, hemi: 1.3, hemiN: 6, wedge: 1, gnd: 1.8, gndN: 0.8, face: 1 });
  // the eyeball leaves the matte skin submesh: wet sclera needs its own specular, and a hair of emissive keeps the
  // catchlight alive under a dark key. A 龍が如く lead's eye always carries a highlight.
  // …and it has to SEE the city: with no envMap of its own a clearcoat sphere on an unlit pedestrian reflects
  // nothing at all, which is exactly the "two painted almonds" the cast shot shipped. envTrack hands it the
  // scene environment so a sign 4 m away lands a catchlight on it.
  const eye = new THREE.MeshPhysicalMaterial({
    map: m.map, roughness: 0.09, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, ior: 1.38,
    emissive: new THREE.Color(0xd8d2cc), emissiveIntensity: 0.06, name: 'eye#face',
  });
  envTrack(eye, 1.5);
  // 3.0 + clearcoat 1 blew the sclera to a solid white oval on an unlit pedestrian — a dead eye at 3 m. The env
  // comes down and the diffuse half is capped in the shader (uLift < 1 darkens the white of the eye, nothing else).
  charShader(eye, { gamut: SKIN_GAMUT, hemi: 0.5, gnd: 0.5, key: 0.55, rim: 0.4, cap: 0.72 });
  skinCache.set(id, { m, eye, refs: 1 });
  return m;
}
function eyeMatOf(skinMat) { const e = skinCache.get(skinMat.userData.skinId); return e ? e.eye : skinMat; }
// A cornea is not an eyeball: it is a 1 mm clear cap that exists so the eye carries a catchlight. Painting an
// opaque sclera over the scan's own eye turns a 42-year-old salaryman into a cartoon.
let _corneaMat = null;
function corneaMat() {
  if (_corneaMat) return _corneaMat;
  // ADDITIVE, with a black base. At opacity 0.10 the alpha blend scaled the specular lobe down with everything
  // else, so the cap was mathematically present and visually absent: no catchlight on the lead's eye at 13:00,
  // which is the single strongest cue separating a photoscan head from a character. Black diffuse + additive
  // means only the reflection is written — the scan's own painted iris shows through underneath, unchanged.
  _corneaMat = new THREE.MeshPhysicalMaterial({ name: 'cornea', color: 0x000000, transparent: true, opacity: 1,
    roughness: 0.035, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, ior: 1.38,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true });
  envTrack(_corneaMat, 2.6);
  // the catchlight is the character key's, which only exists inside charShader: without it a night cornea reflects
  // nothing but a dark env and the lead's eyes read as painted slits
  charShader(_corneaMat, { key: 1.6, rim: 0.5 });
  return _corneaMat;
}
function releaseSkin(m) {
  const e = skinCache.get(m.userData.skinId);
  if (!e || --e.refs > 0) return;
  skinCache.delete(m.userData.skinId);
  e.eye?.dispose();
  m.map?.dispose(); m.roughnessMap?.dispose(); m.normalMap?.dispose(); m.dispose();
}
// ---------------------------------------------------------------- head: sculpted ring stack (yh = height above the chin)
const CHIN_Y = 1.565;
// yh < 0 is the NECK: the same loft continues past the chin, flares into the submandibular triangle and the
// throat and ends inside the collar. Before this the skull sat straight on the collar with a black slot behind
// the jaw — no throat, no sterno-mastoid, nothing to carry a jaw over a shirt, which is the whole read of a
// 龍が如く head. Radii below are the old buildNeck() table, so the collar still closes over the bottom ring.
const HEAD_ROWS = [ // [yh, front, back, side, centre z]
  [-0.150, 0.074, 0.080, 0.080, -0.016], [-0.120, 0.072, 0.078, 0.078, -0.013], [-0.092, 0.069, 0.075, 0.075, -0.010],
  // fix round 1: the neck under the jaw thickened ~20 % (side 0.057/0.045/0.036 -> 0.062/0.055/0.046). At the
  // old radii every procedural head sat on a stalk 46-58 % of its own width — a real neck is ~75 %.
  [-0.066, 0.065, 0.072, 0.071, -0.005], [-0.044, 0.061, 0.069, 0.067, 0.004], [-0.026, 0.054, 0.064, 0.062, 0.013],
  [-0.012, 0.045, 0.058, 0.055, 0.019],
  [0.000, 0.036, 0.052, 0.046, 0.023], [0.012, 0.062, 0.066, 0.058, 0.020], [0.030, 0.078, 0.078, 0.071, 0.015],
  [0.050, 0.083, 0.088, 0.074, 0.010], [0.075, 0.086, 0.094, 0.076, 0.007], [0.095, 0.086, 0.098, 0.078, 0.005],
  [0.115, 0.088, 0.101, 0.080, 0.004], [0.135, 0.086, 0.103, 0.080, 0.003], [0.155, 0.090, 0.103, 0.079, 0.003],
  [0.180, 0.086, 0.101, 0.077, 0.003], [0.205, 0.075, 0.090, 0.071, 0.003], [0.222, 0.055, 0.065, 0.054, 0.003],
  [0.232, 0.028, 0.032, 0.028, 0.003], [0.2355, 0.001, 0.001, 0.001, 0.003],
];
const NOSE = [[0.074, 0, 0.24], [0.081, 0.013, 0.25], [0.090, 0.025, 0.22], [0.100, 0.022, 0.17], [0.115, 0.017, 0.13], [0.130, 0.013, 0.12], [0.145, 0.009, 0.13], [0.160, 0.003, 0.15]];
const HEAD_YS = [0, 0.006, 0.014, 0.024, 0.032, 0.038, 0.043, 0.048, 0.052, 0.055, 0.058, 0.062, 0.067, 0.072, 0.078, 0.084, 0.09, 0.097, 0.105, 0.115, 0.122, 0.1275, 0.131, 0.135, 0.139, 0.1435, 0.148, 0.156, 0.166, 0.178, 0.19, 0.205, 0.218, 0.228, 0.234, 0.2355];
const NECK_YS = [-0.150, -0.126, -0.104, -0.084, -0.066, -0.050, -0.036, -0.024, -0.014, -0.006];
const NECK_YS_LO = [-0.150, -0.110, -0.072, -0.040, -0.016];      // low detail: 5 rings instead of 10
const NECK_BOTTOM = -0.150, NECK_UV = -0.112;                     // atlas rows below NECK_UV belong to the hand strips

const HEAD_K = 0.965;                                   // radii scale: keeps the figure ~7.7 heads tall with the hair shell on
function headRadius(a, yh, P) {
  let [F, B, S] = table(HEAD_ROWS, yh);
  const hk = P.headK || 1;                              // per-variant head size: see headSizeFor()
  F *= HEAD_K * hk; B *= HEAD_K * hk; S *= HEAD_K * hk;
  // jaw: flare at the gonion (jawY, ear level for the hero) and taper below it so the chin reads as its own form.
  // The flare used to be applied at FULL strength, centred at yh 0.035 — 15 mm above the chin, not at the jaw
  // angle — so a `jaw` of 1.3 made the mandible 17 % wider than the cranium 10 cm above it and every procedural
  // head in `character_heads` was a light bulb. The gonion sits at mouth height, and the flare is now referred to
  // the skull it hangs off: at jaw 1.3 the widest mandible section lands just inside the parietal width.
  S *= 1 + (P.jaw - 1) * 0.55 * gauss(yh - (P.jawY ?? 0.056), 0.026);
  if (P.chinTaper) { const t = 1 - P.chinTaper * gauss(yh - 0.004, 0.038); S *= t; F *= lerp(1, t, 0.55); }
  const ca = Math.cos(a), sa = Math.sin(a);
  // p = superellipse exponent: higher = squarer. jawSq/jawSpread widen the square section up the mandible (hero).
  const Rz = sa > 0 ? F : B, p = 2 + (P.jawSq ?? 0.45) * P.jaw * gauss(yh - 0.045, P.jawSpread ?? 0.03);
  let r = Math.pow(Math.pow(Math.abs(ca) / S, p) + Math.pow(Math.abs(sa) / Rz, p), -1 / p);
  if (yh < 0) {                                         // throat: sterno-mastoid pair, sternal notch, larynx, nape hollow
    const dd = adiff(a, HPI), low = sstep((-yh - 0.016) / 0.075);
    r *= lerp(1, P.neck || 1, sstep(-yh / 0.035));
    r *= 1 + 0.055 * low * (gauss(dd - 0.62, 0.30) + gauss(dd + 0.62, 0.30)) - 0.050 * low * gauss(dd, 0.20)
      + 0.030 * (1 - low) * gauss(dd, 0.34) - 0.022 * low * gauss(Math.abs(dd) - Math.PI, 0.55);
    return r;
  }
  if (sa <= 0) return r;
  const d = adiff(a, HPI);
  const n = table(NOSE, yh);
  r += n[0] * P.nose * gauss(d, n[1]);
  // A ridge with no wings and no nostrils is a lump: at 4 m the cast's faces read as featureless eggs. The alar
  // lobes flank the tip, the crease behind them cuts each wing free of the cheek, and the septum sits between.
  // (kept at σ ≥ 0.09 rad: the head ring is 48 segments at LOD0, so anything finer aliases instead of reading)
  const alar = gauss(yh - 0.080, 0.013) * P.nose;
  r += 0.0070 * alar * (gauss(d - 0.20, 0.10) + gauss(d + 0.20, 0.10));         // nostril wings
  r -= 0.0050 * alar * (gauss(d - 0.40, 0.11) + gauss(d + 0.40, 0.11));         // alar crease onto the cheek
  r -= 0.0034 * gauss(yh - 0.0745, 0.008) * P.nose * (gauss(d - 0.15, 0.09) + gauss(d + 0.15, 0.09));   // nostrils
  r += 0.0020 * gauss(yh - 0.0725, 0.009) * P.nose * gauss(d, 0.09);            // columella
  r -= 0.0026 * gauss(yh - 0.118, 0.018) * P.nose * (gauss(d - 0.26, 0.11) + gauss(d + 0.26, 0.11));    // bridge sidewalls
  r += 0.007 * P.brow * gauss(yh - 0.152, 0.011) * (gauss(d - 0.42, 0.32) + gauss(d + 0.42, 0.32));
  // eyes: socket hollow, the opening slot where the eyeball shows, upper/lower lid ridges.
  // The slot used to cut 13 mm at σ 6.1 mm over an eyeball parked only 4 mm inside the skin, so ~13 mm of a 25 mm
  // ball bulged through a 13 mm-tall gap: every procedural face in `character_heads` stared. 10.5 mm at σ 5.4 mm
  // over a ball 7 mm in (see buildEyes) shows the 10 mm fissure a relaxed eye actually has, and the upper lid is
  // heavier so it lands ON the iris instead of clearing it.
  r -= 0.008 * gauss(yh - 0.134, 0.013) * (gauss(d - 0.42, 0.21) + gauss(d + 0.42, 0.21));
  r -= 0.0105 * gauss(yh - 0.1345, 0.0054) * (gauss(d - 0.42, 0.19) + gauss(d + 0.42, 0.19));
  r += 0.0042 * gauss(yh - 0.1420, 0.0038) * (gauss(d - 0.42, 0.20) + gauss(d + 0.42, 0.20));  // upper lid, sits on the iris
  r += 0.0022 * gauss(yh - 0.1272, 0.0030) * (gauss(d - 0.42, 0.17) + gauss(d + 0.42, 0.17));
  // zygomatic ridge under the eye, hollow below it, then the masseter/jaw
  r += 0.006 * P.cheek * gauss(yh - 0.130, 0.012) * (gauss(d - 0.95, 0.28) + gauss(d + 0.95, 0.28));
  r -= 0.004 * gauss(yh - 0.095, 0.014) * (gauss(d - 0.85, 0.25) + gauss(d + 0.85, 0.25));
  // mouth: upper lip mass, mouth line, lower lip, labiomental fold, chin (MOUTH_Y = the mouth line)
  // mouth: upper lip mass, mouth line, lower lip, labiomental fold. The angular sigmas used to be 0.27-0.32 rad,
  // which at an 80 mm head radius is a lip mass ~100 mm across — twice a real mouth, and twice the 42 mm mouth the
  // ATLAS paints on top of it. That mismatch is the soft doughnut every procedural face wore instead of a mouth.
  const my = MOUTH_Y;
  r += 0.0055 * gauss(yh - (my + 0.006), 0.005) * gauss(d, 0.175) - 0.004 * gauss(yh - my, 0.003) * gauss(d, 0.185) + 0.0075 * gauss(yh - (my - 0.007), 0.0048) * gauss(d, 0.155) - 0.0028 * gauss(yh - (my - 0.017), 0.004) * gauss(d, 0.20);
  r -= 0.002 * gauss(yh - (my + 0.018), 0.008) * gauss(d, 0.07);
  r += 0.009 * P.chin * gauss(yh - 0.020, 0.02) * gauss(d, 0.30);
  // Mandible. Without its lower border the whole region under the mouth was one soft mass that hung off the face
  // like a jowl bag — the loudest defect in `character_heads`. The border climbs from the chin (yh 0.012 at the
  // midline) to the gonion (0.046 out at the angle); a 3.5 mm ridge on it and a shallow hollow above it give the
  // lower face the bone edge a head's silhouette is read off.
  { const ad = Math.abs(d), yJaw = 0.011 + 0.035 * sstep((ad - 0.22) / 0.98), jk = 1 - sstep((ad - 1.28) / 0.30);
    r += 0.0038 * P.jaw * jk * gauss(yh - yJaw, 0.0105);
    r -= 0.0030 * jk * gauss(yh - yJaw - 0.023, 0.016); }
  r -= 0.004 * gauss(yh - 0.18, 0.02) * (gauss(d - 1.1, 0.25) + gauss(d + 1.1, 0.25));
  if (P.nlf) {                                          // nasolabial fold: groove from the nose wing past the mouth corner
    r -= 0.0038 * P.nlf * gauss(yh - 0.073, 0.021) * (gauss(d - 0.40, 0.095) + gauss(d + 0.40, 0.095));
    r += 0.0022 * P.nlf * gauss(yh - 0.078, 0.026) * (gauss(d - 0.62, 0.17) + gauss(d + 0.62, 0.17));
  }
  return r;
}
const headPoint = (a, yh, P, extra = 0) => { const r = headRadius(a, yh, P) + extra, zc = table(HEAD_ROWS, yh)[3]; return [r * Math.cos(a), r * Math.sin(a) + zc, yh]; };

// two weight lists mixed by t (0 = a, 1 = b) — the throat rides Head near the jaw and the torso chain at the collar
function blendW(wa, wb, t) {
  if (t <= 0.001) return wa;
  if (t >= 0.999) return wb;
  return (p, r) => {
    const out = [];
    for (const [i, w] of wa(p, r)) out.push([i, w * (1 - t)]);
    for (const [i, w] of wb(p, r)) { const e = out.find((o) => o[0] === i); if (e) e[1] += w * t; else out.push([i, w * t]); }
    return out.sort((x, y) => y[1] - x[1]).slice(0, 4);
  };
}
function buildHead(K, wHead, wT) {
  const P = K.V, c = new THREE.Vector3(0, K.chinY, K.headZ);
  const ring = (yh, w) => ({ c, u: X_AXIS, v: Z_AXIS, n: Y_AXIS, rx: 0, ry: 0, w, vv: 0.5 + 0.5 * Math.max(yh, NECK_UV) / HEAD_H, shape: (a) => headPoint(a, yh, P) });
  const neckYs = K.hsegs >= 24 ? NECK_YS : NECK_YS_LO;
  // Head -> Neck -> torso chain over the 15 cm below the chin, so turning his head twists the jaw and not the collar
  const rings = neckYs.map((yh) => ring(yh, blendW(wHead, wT, sstep((-yh - 0.012) / 0.085))));
  for (const yh of HEAD_YS) rings.push(ring(yh, wHead));
  return loft(rings, { segs: K.hsegs, a0: -HPI, a1: 3 * Math.PI / 2 });
}
function buildEyes(K, wHead) {
  const P = K.V, parts = [], r = rectUV(RECT.eye);
  for (const s of [-1, 1]) {
    const g = new THREE.SphereGeometry(0.0125, 16, 12);
    g.rotateX(HPI);                                              // +y pole (iris, v=1) faces +z
    // 7 mm in, not 4: a 25 mm ball parked 4 mm under the skin bulges through the lid slot and the face stares
    const a = HPI - s * 0.42, [x, z] = headPoint(a, 0.135, P, -0.007);
    g.translate(x, K.chinY + 0.135, z + K.headZ);
    uvRect(g, r[0], r[1], r[2], r[3]);
    parts.push(skinGeo(g, wHead));
  }
  return parts;
}
// ear: 6-ring loft in the ear's own frame (u = forward, v = up, rings stepping outward): back of the ear, helix rim (3 mm),
// concha bowl, canal. Lower half is stretched into a lobe.
function buildEars(K, wHead) {
  const P = K.V, parts = [], r = rectUV(RECT.ear);
  // headK (the per-variant head size, headSizeFor) scales the skull but was never applied here, so an ear was
  // pinned to an UNSCALED side radius: on a 1.10 head it sat 8 mm inside the skull and vanished, on a 0.92 head it
  // floated off it. Not one of the five procedural faces in `character_heads` had a visible ear.
  const hk = P.headK || 1;
  const S = table(HEAD_ROWS, 0.118)[2] * HEAD_K * hk, zc = table(HEAD_ROWS, 0.118)[3];
  const rows = [[-0.006, 0.030, 0.016, 0, 0], [0.003, 0.033, 0.018, 0, 0], [0.012, 0.032, 0.017, -0.004, 0.002], [0.0135, 0.027, 0.013, -0.004, 0.002], [0.008, 0.017, 0.008, -0.002, 0.004], [0.003, 0.006, 0.004, -0.002, 0.004]];
  for (const s of [-1, 1]) {
    const rings = rows.map(([ox, ry, rz, cz, cy]) => ({
      c: new THREE.Vector3(ox, cy, cz), u: Z_AXIS, v: Y_AXIS, rx: rz, ry, w: wHead, uScale: 1,
      shape: (a) => { const [dz, dy] = sellipse(a, rz, ry, 2.1); const lobe = dy < 0 ? 1 + 0.18 * (-dy / ry) : 1; return [dz * (dy < 0 ? 0.88 : 1) - (dy > 0 ? 0.002 : 0), dy * lobe]; },
    }));
    const g = loft(rings, { segs: 18, uv: [1, 1] });
    uvFit(g, r[0], r[1], r[2], r[3]);
    g.scale(s * hk, hk, hk);
    g.rotateZ(s * 0.1); g.rotateY(s * 0.32);
    g.translate(s * (S - 0.003 * hk), K.chinY + 0.116 * hk, zc - 0.016 + K.headZ);
    parts.push(skinGeo(g, wHead));
  }
  return parts;
}
// hairline (yh above the chin) by angle from the front: front centre, peak (widow's peak -), corner (receding corners +),
// temple, burn (sideburn bottom), nape; top = crown thickness, quiff = swept-back wave behind the hairline, sideK = side thinning
const HAIR_STYLES = {
  // hero: short back-and-sides, swept back off a receding hairline (deep temple corners), sides cropped (low sideK)
  kento: { front: 0.1855, peak: 0.0015, corner: 0.0125, temple: 0.1815, burn: 0.121, top: 0.024, quiff: 0.028, rise: 3.2, sideK: 0.26, clump: 0.0035, spike: 0, nape: 0.040, locks: 'sweep' },
  spiky: { front: 0.19, peak: 0.002, corner: 0.0, temple: 0.176, burn: 0.13, top: 0.03, quiff: 0.026, rise: 2.5, sideK: 0.3, clump: 0.0075, spike: 0.024, nape: 0.05, locks: 'drop' },
  slick: { front: 0.198, peak: -0.003, corner: 0.012, temple: 0.19, burn: 0.12, top: 0.012, quiff: 0.006, rise: 2.2, sideK: 0.55, clump: 0.002, spike: 0, nape: 0.045, locks: 'sweep' },
  longslick: { front: 0.196, peak: -0.002, corner: 0.015, temple: 0.184, burn: 0.115, top: 0.018, quiff: 0.008, rise: 2.4, sideK: 0.7, clump: 0.0025, spike: 0, nape: 0.0, locks: 'sweep' },
  ped: { front: 0.192, peak: 0, corner: 0.003, temple: 0.178, burn: 0.125, top: 0.02, quiff: 0.01, rise: 2.0, sideK: 0.45, clump: 0.003, spike: 0, nape: 0.045, locks: 'drop' },
  // The six pedestrian styles (PED_HAIRS). A passer-by WEARS his hair — it does not sit on him: the hairline runs
  // 7-10 mm lower than the cast's (front 0.197 was a receding forehead on every 20-year-old in the crowd), the
  // sides carry real volume (sideK 0.35 left the temples bare above the ear, a skullcap on a dome), and every style
  // has a silhouette of its own. Extra fields: `ear/earTop/earBack/back` move the rim on the sides and the occiput,
  // `base` is the shell's own thickness at the rim (a bob hangs 17 mm off the jaw, it does not taper into it),
  // `flush` rolls the rim under instead of burying it, `part` puts a parting groove that many radians off centre
  // with the mass falling to the far side, `tail` hangs a ponytail off the occiput, `lockK` scales the fringe.
  short:  { front: 0.184, peak: -0.004, corner: 0.005, temple: 0.174, burn: 0.100, top: 0.030, quiff: 0.020, rise: 2.6, sideK: 0.56, clump: 0.004, spike: 0, nape: 0.045, locks: 'drop', base: 0.004 },
  parted: { front: 0.183, peak: -0.002, corner: 0.009, temple: 0.173, burn: 0.104, top: 0.033, quiff: 0.026, rise: 2.5, sideK: 0.52, clump: 0.0035, spike: 0, nape: 0.045, locks: 'drop', part: 0.38, base: 0.004 },
  swept:  { front: 0.183, peak: 0.0, corner: 0.011, temple: 0.175, burn: 0.108, top: 0.034, quiff: 0.036, rise: 2.8, sideK: 0.42, clump: 0.0045, spike: 0, nape: 0.042, locks: 'sweep', base: 0.003 },
  bob:    { front: 0.160, peak: 0.0, corner: -0.003, temple: 0.118, burn: 0.052, top: 0.012, quiff: 0.004, rise: 1.2, sideK: 1.0, clump: 0.0025, spike: 0, nape: 0.040, locks: 'drop', ear: 0.040, earTop: 0.040, earBack: 0.040, back: 0.040, base: 0.017, flush: true, lockK: 0.45 },
  tied:   { front: 0.190, peak: -0.002, corner: 0.004, temple: 0.178, burn: 0.118, top: 0.011, quiff: 0.004, rise: 2.0, sideK: 0.85, clump: 0.0015, spike: 0, nape: 0.050, locks: 'sweep', tail: true, lockK: 0.6 },
};
function buildHair(K, style, wHead, rng) {
  const P = K.V, st = HAIR_STYLES[style] || HAIR_STYLES.short, segs = K.hsegs;
  const ph = rng() * TAU, c0 = new THREE.Vector3(0, K.chinY, K.headZ);
  // The side of the shell used to come down to yh 0.138-0.142 — BELOW the top of the ear (0.149 · headK), so the
  // hair swallowed the ear whole on every variant and not one head in `character_heads` had one. It climbs over
  // the ear now and drops again behind it, which is also what a real short back-and-sides does.
  const hairline0 = (d) => table([[0, st.front + st.peak], [0.35, st.front + 0.002], [0.65, st.front + st.corner], [0.95, st.temple], [1.2, st.burn], [1.34, st.ear ?? 0.146], [1.62, st.earTop ?? 0.158], [1.86, st.earBack ?? 0.144], [2.3, st.back ?? 0.09], [2.8, st.nape + 0.01], [Math.PI, st.nape]], d)[0];
  // The shell's rim used to be a clean polygon cut straight across the forehead — countable tabs, PS2-tier. The
  // hairline now wanders at two frequencies (~2 mm and ~1 mm) so the edge is ragged before a single lock is added.
  // Frequencies stay well under the ring sampling rate (hsegs around a full turn): at a*11 / a*27 the noise
  // aliased into a row of scalloped tabs cut across the forehead, which is worse than the clean polygon it replaced.
  const hairline = (d, a) => hairline0(d) + 0.0021 * Math.sin((a ?? d) * 5 + ph) + 0.0012 * Math.sin((a ?? d) * 9 + ph * 2.7);
  const thick = (a, s) => {
    const d = Math.abs(adiff(a, HPI)), frontK = gauss(d, 0.9);
    let th = (st.base || 0) + st.top * sstep(s * lerp(1.7, st.rise, frontK));
    th += st.quiff * frontK * gauss(s - 0.3, 0.17) * sstep(s * 7);      // wave lifts behind the hairline, not off it
    th *= lerp(1, st.sideK, gauss(d - 1.6, 0.5));
    if (st.part) {                                                        // side parting: a groove, the mass combed to the far side
      const pd = adiff(a, HPI + st.part);
      th -= 0.0065 * gauss(pd, 0.10) * sstep((0.96 - s) / 0.1) * sstep(s * 6 + 0.3);
      th *= 1 + 0.16 * Math.tanh(-pd / 0.5) * frontK;
    }
    th += st.clump * Math.sin(a * 9 + ph) * Math.sin(s * 17 + a * 2 + ph) * sstep(s * 4);
    th += st.clump * 0.6 * Math.sin(a * 6 + ph * 1.7) * Math.sin(s * 31 + ph) * sstep(s * 3);   // second octave: the crown silhouette must not be a smooth helmet
    th += st.spike * Math.abs(Math.sin(a * 7 + ph)) * Math.abs(Math.sin(s * 9 + 1)) * sstep((s - 0.15) / 0.3);
    return th;
  };
  const N = 22, rings = [];
  for (let j = 0; j < N; j++) {
    const s = j === 0 ? 0 : j === 1 ? 0.03 : (j - 1) / (N - 2);
    rings.push({
      c: c0, u: X_AXIS, v: Z_AXIS, n: Y_AXIS, rx: 0, ry: 0, w: wHead, vv: s * 2,
      shape: (a) => {
        const hl = hairline(Math.abs(adiff(a, HPI)), a), yh = hl + s * (0.2355 - hl);
        // a flush rim (bob) rolls under: buried at ring 0, at full thickness by ring 1 — a hem, not a taper
        return headPoint(a, yh, P, j === 0 ? -0.005 : j === 1 ? (st.flush ? thick(a, s) : -0.0025) : Math.max(-0.004, thick(a, s)));
      },
    });
  }
  // the s=1 ring is a horizontal circle of radius ≈ top AT the crown, i.e. an open hole seen from above: cap it with a
  // dome that also gives the hair its height on top of the skull
  for (const [dy, k] of [[0.005, 0.80], [0.0095, 0.52], [0.0125, 0.22], [0.0138, 0.0]]) {
    rings.push({ c: c0, u: X_AXIS, v: Z_AXIS, n: Y_AXIS, rx: 0, ry: 0, w: wHead, vv: 2 + dy * 14,
      shape: (a) => headPoint(a, 0.2355 + dy, P, Math.max(0.0005, thick(a, 1) * k)) });
  }
  const parts = [loft(rings, { segs, a0: -HPI, a1: 3 * Math.PI / 2 })];
  // fringe / nape locks: tapered tubes hanging off the hairline that break the helmet silhouette
  const lock = (ac, yh0, len, dir, w0, t0, bulge) => {
    const rs = [], n = 7;
    for (let j = 0; j <= n; j++) {
      const s = j / n, yh = yh0 + dir[0] * len * s, off = t0 + bulge * Math.sin(s * Math.PI) + dir[1] * s;
      const a = ac + dir[2] * s;
      const [hx, hz] = headPoint(a, clamp(yh, -0.02, 0.2355), P, 0);
      const nx = Math.cos(a), nz = Math.sin(a);
      const taper = j === n ? 0.05 : j === 0 ? 0.45 : 1 - 0.55 * s * s;   // the root end is buried, not a flat disc
      rs.push({ c: new THREE.Vector3(hx + nx * off, K.chinY + yh, hz + nz * off + K.headZ), u: new THREE.Vector3(-nz, 0, nx), v: new THREE.Vector3(nx, 0, nz), rx: w0 * taper, ry: w0 * 0.42 * taper, w: wHead, uScale: 0.3 });
    }
    return loft(rs, { segs: 8, uv: [1, 1] });
  };
  // Fringe / temple / nape strands. The old set was 6 tubes ~1 cm wide standing 2.3 cm off the skull — five
  // rectangular tabs with straight vertical edges cut across the forehead, plus a stray one that floated clear of
  // the boss's coat and caught a blown specular. These are 3-8 mm, rooted ON the shell (t0 ≈ 3 mm) and tapered to
  // a point, so the silhouette ends on strands instead of on a polygon edge.
  const fine = K.hsegs >= 24;
  const nF = fine ? 14 : 5, drop = st.locks === 'drop', lk = st.lockK || 1, pk = st.part ? Math.sign(st.part) : 0;
  for (let i = 0; i < nF; i++) {
    const t = (i + 0.5) / nF;
    const da = -1.02 + 2.04 * t + (rng() - 0.5) * 0.10;
    const k = 0.35 + 0.65 * gauss(da, 0.62);                       // longest over the centre of the forehead
    const a = HPI + da, hl = hairline(Math.abs(da), a);
    const w0 = 0.0032 + rng() * 0.0042;
    const len = (drop ? 0.026 : 0.036) * (0.6 + k * 0.7) * (0.8 + rng() * 0.45) * lk;
    // a parted fringe falls AWAY from the parting; the locks on the parting's own side are short and swept over
    const sw = pk ? (Math.sign(da - st.part) === -pk ? 0.55 : 1) : 1, drift = pk ? -pk * 0.22 : 0;
    if (drop) parts.push(lock(a, hl + 0.009, len * sw, [-1, 0.0035, (rng() - 0.5) * 0.28 + drift], w0 * 1.15, 0.003, 0.004 + k * 0.005));
    else parts.push(lock(a, hl + 0.007, len, [1, 0.004 + k * 0.005, (rng() - 0.5) * 0.18 + drift], w0, 0.002 + st.top * 0.25, 0.004 + k * 0.005));
  }
  for (const s of [-1, 1]) for (let i = 0; i < (fine ? 3 : 1); i++) {     // temple / sideburn wisps
    const da = s * (1.02 + i * 0.16 + rng() * 0.06), a = HPI + da;
    parts.push(lock(a, hairline(Math.abs(da), a) + 0.004, 0.016 + rng() * 0.012, [-1, 0.0025, s * 0.06], 0.0028 + rng() * 0.0022, 0.0025, 0.003));
  }
  const nN = fine ? 6 : 2;
  // nape locks hang DOWN from their root, so a style whose nape sits at the jaw line (longslick, nape 0) put 4 cm
  // tubes through the collar and out over the shoulder — the pale shard on the boss. Root them at the hairline the
  // style actually has, never below 3.5 cm above the chin, and never longer than the drop to the collar.
  const napeY = Math.max(st.nape, 0.035);
  for (let i = 0; i < nN; i++) {
    const da = -0.6 + 1.2 * ((i + 0.5) / nN) + (rng() - 0.5) * 0.12, a = -HPI + da;
    const len = Math.min((style === 'longslick' ? 0.034 : 0.020) * (0.75 + rng() * 0.5), napeY - 0.004);
    parts.push(lock(a, napeY + 0.010, len, [-1, 0.002, (rng() - 0.5) * 0.22], 0.0030 + rng() * 0.0032, 0.0025, 0.0035));
  }
  if (st.tail) {
    // ponytail: gathered at the occiput 15 cm above the chin, a tapered tube that curves back and hangs behind the
    // nape to just above the collar (never lower — it would live inside the coat collar the moment the head tilts).
    // [yh, metres behind the skull's own back surface, radius]
    const path = [[0.152, 0.008, 0.017], [0.140, 0.036, 0.021], [0.112, 0.056, 0.019], [0.070, 0.066, 0.016], [0.025, 0.070, 0.012], [-0.015, 0.067, 0.008], [-0.038, 0.062, 0.0025]];
    const cs = path.map(([yh, off, r]) => { const [, z] = headPoint(-HPI, Math.max(yh, -0.02), P, 0); return { c: new THREE.Vector3(0.004, K.chinY + yh, z - off + K.headZ), r }; });
    const rs = cs.map((p, i) => {
      const d = (i === cs.length - 1 ? p.c.clone().sub(cs[i - 1].c) : cs[i + 1].c.clone().sub(p.c)).normalize();
      const v = new THREE.Vector3().crossVectors(d, X_AXIS).normalize();     // ring plane perpendicular to the tail
      return { c: p.c, u: X_AXIS, v, rx: p.r, ry: p.r * 0.8, w: wHead, uScale: 0.6, shape: (a) => { const [x, y] = sellipse(a, p.r, p.r * 0.8, 2); return [x * (1 + 0.06 * Math.sin(a * 5 + i)), y]; } };
    });
    parts.push(loft(rs, { segs: 10, uv: [1, 1] }));
  }
  // greying: the strand map carries the base colour, so the temples are lifted toward `greyHair` per vertex
  if (P.greyHair != null) {
    _c1.set(P.greyHair); _c2.set(P.hairColor);
    const g = [_c1.r / Math.max(_c2.r, 0.002), _c1.g / Math.max(_c2.g, 0.002), _c1.b / Math.max(_c2.b, 0.002)];
    const out = [1, 1, 1];
    const mix = (p) => {                                   // temples + sideburns only, never the crown
      const k = sstep((Math.abs(p.x) - 0.063) / 0.014) * gauss(p.y - K.chinY - 0.148, 0.030) * (P.greyAmt ?? 0.6);
      for (let i = 0; i < 3; i++) out[i] = lerp(1, g[i], k);
      return out;
    };
    for (const g2 of parts) vcolor(g2, WHITE3, mix);
  }
  return parts;
}
// a two-sided sheet from rows of points (each row an arc): the cap's visor, which is seen from below as often as
// from above and cannot rely on loft()'s outward-winding guess
function sheet(rows, w) {
  const nR = rows.length, nA = rows[0].length, n = nR * nA;
  const pos = new Float32Array(n * 2 * 3), uvs = new Float32Array(n * 2 * 2), idx = [];
  for (let side = 0; side < 2; side++) for (let j = 0; j < nR; j++) for (let i = 0; i < nA; i++) {
    const k = side * n + j * nA + i, p = rows[j][i];
    pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z; uvs[k * 2] = i / (nA - 1); uvs[k * 2 + 1] = j / (nR - 1);
  }
  for (let j = 0; j < nR - 1; j++) for (let i = 0; i < nA - 1; i++) {
    const a = j * nA + i, b = a + 1, c = a + nA, d = c + 1;
    idx.push(a, c, b, b, c, d, n + a, n + b, n + c, n + b, n + d, n + c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return skinGeo(g, w);
}
// baseball cap over the short shell: a six-panel crown 8-38 mm off the skull (clear of the hair under it), a band a
// hair below the brow line all round, and a curved visor 7 cm out over the eyes
function buildCap(K, wHead) {
  const P = K.V, c0 = new THREE.Vector3(0, K.chinY, K.headZ), parts = [];
  const rows = [[0.148, 1, 0.007], [0.153, 1, 0.011], [0.165, 1, 0.015], [0.180, 1, 0.019], [0.198, 1, 0.023], [0.216, 1, 0.026], [0.230, 0.96, 0.027], [0.243, 0.72, 0.018], [0.252, 0.44, 0.010], [0.258, 0.18, 0.004], [0.260, 0.02, 0.001]];
  const rings = rows.map(([yh, k, off], j) => ({
    c: c0, u: X_AXIS, v: Z_AXIS, n: Y_AXIS, rx: 0, ry: 0, w: wHead, vv: j / (rows.length - 1),
    shape: (a) => { const r = headRadius(a, Math.min(yh, 0.205), P) * k + off, zc = table(HEAD_ROWS, Math.min(yh, 0.2355))[3];
      const seam = 1 + 0.004 * Math.max(0, Math.cos(a * 3 + HPI)) * sstep((yh - 0.16) / 0.06);   // panel seams stand a hair proud
      return [r * seam * Math.cos(a), r * seam * Math.sin(a) + zc, yh]; },
  }));
  parts.push(loft(rings, { segs: K.hsegs, a0: -HPI, a1: 3 * Math.PI / 2 }));
  const arcs = [];
  for (let k = 0; k <= 4; k++) {
    const row = [], out = 0.010 + 0.016 * k, y = K.chinY + 0.149 - 0.0035 * k - 0.0022 * k * k;
    for (let i = 0; i <= 14; i++) {
      const a = HPI - 1.05 + 2.1 * (i / 14), r = headRadius(a, 0.149, P) + out * (1 - 0.18 * Math.abs(i / 7 - 1)), zc = table(HEAD_ROWS, 0.149)[3];
      row.push(new THREE.Vector3(r * Math.cos(a), y - 0.004 * Math.abs(i / 7 - 1) * k, r * Math.sin(a) + zc + K.headZ));
    }
    arcs.push(row);
  }
  parts.push(sheet(arcs, wHead));
  return parts;
}
// ---------------------------------------------------------------- torso / clothes
function torsoWeights(R, blend = 0.07) {
  const segs = chainSegs(R, ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'], blend);
  const ys = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head'].map((n) => R.joints[n][1]);
  const base = (p) => { let k = 0; while (k < 5 && p.y >= ys[k]) k++; return segs[k].w(p); };
  // The jacket's shoulder cap used to be 100 % Spine2, so when an arm came up the sleeve left and the cap stayed —
  // a flat horizontal shelf of cloth standing clear of the body, and on the boss (black coat, guard pose) it was the
  // brightest thing in the cast shot. The outer 9 cm of the yoke now rides the arm up to 60 %, like a real sleeve head.
  const ai = { Left: R.index.LeftArm, Right: R.index.RightArm };
  const yT = R.joints.Spine2[1];
  return (p) => {
    const w = base(p);
    const t = 0.6 * sstep((Math.abs(p.x) - 0.125) / 0.085) * sstep((p.y - (yT + 0.02)) / 0.13);
    if (t <= 0.002) return w;
    const si = ai[p.x > 0 ? 'Left' : 'Right'];
    const out = w.map(([i, x]) => [i, x * (1 - t)]);
    const e = out.find((o) => o[0] === si); if (e) e[1] += t; else out.push([si, t]);
    return out;
  };
}
// superellipse point (p = exponent), returns [dx, dy]
function sellipse(a, rx, ry, p) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const r = Math.pow(Math.pow(Math.abs(ca) / rx, p) + Math.pow(Math.abs(sa) / ry, p), -1 / p);
  return [r * ca, r * sa];
}
// jacket / coat: open front with a V gap g(y) (half-angle) and rolled lapels of angular width lw(y)
// q 0 = the lapel's free edge at the gorge, 1 = the roll line where it folds back onto the chest. Before this the
// profile was a flat plateau with a step at the roll line — a painted stripe, not a folded panel. The trough at
// q ≈ 0.9 is the roll crease, and it is what makes a lapel read as tailoring in a 5 m silhouette.
const lapelProfile = (q) => (1 - 0.13 * q) * (1 - sstep((q - 0.72) / 0.28)) - 0.34 * gauss(q - 0.90, 0.075);
function jacketShape(rx, ry, g, lw, lapelH, oz = 0, wr = null) {
  return (a, f) => {
    const a0 = HPI + g, span = TAU - 2 * g;
    let ang, off = 0;
    const L = lw > 0 ? 0.1 : 0.0;
    if (lw > 0 && f < L) { const q = f / L; ang = a0 + lw * q; off = lapelH * lapelProfile(q); }
    else if (lw > 0 && f > 1 - L) { const q = (1 - f) / L; ang = a0 + span - lw * q; off = lapelH * lapelProfile(q); }
    else { const q = lw > 0 ? (f - L) / (1 - 2 * L) : f; ang = a0 + lw + (span - 2 * lw) * q; }
    if (wr) off += wr(ang);
    const [x, z] = sellipse(ang, rx + off, ry + off, 2.2);
    return [x, z + oz];
  };
}
// belly profile (m) added to the front of the torso rows around the waist
const gutAt = (y, belly) => belly * gauss(y - 1.08, 0.13) * 1.25;
// The skirt of a jacket (and a tee hanging to the hip) rides the thighs part-way below the waist. On Hips alone a
// stride drove the trouser tops out through the hem and the zip in jagged blue drips, which from 4 m read as a hole in
// the middle of the torso (the client's screenshot of a crowd MOB). 85 % at the hem, gone by the belt line.
function skirtW(R, wT) {
  const iL = R.index.LeftUpLeg, iR = R.index.RightUpLeg;
  return (p, r) => {
    // the back panel drapes over the seat and follows a third as much: behind the hip axis a flexing thigh swings the
    // cloth INTO the body, and the pelvis came out through the back hem at every stride
    const base = wT(p, r), k = 0.85 * sstep((0.99 - p.y) / 0.13) * (0.3 + 0.7 * sstep((p.z + 0.075) / 0.06));
    if (k <= 0.002) return base;
    const s = sstep((p.x + 0.05) / 0.10), out = base.map(([i, w]) => [i, w * (1 - k)]);
    for (const [i, w] of [[iL, k * s], [iR, k * (1 - s)]]) { if (w <= 0) continue; const e = out.find((o) => o[0] === i); if (e) e[1] += w; else out.push([i, w]); }
    return out.sort((x, y) => y[1] - x[1]).slice(0, 4);
  };
}
// the half-width and depth a garment below the waist must clear to hold both thighs (see buildLegs' top rows)
function thighHull(K) {
  const R = K.R, lb = 0.88 + 0.12 * (K.V.build || 1), jeans = K.V.outfit === 'track', hw = K.V.hipW || 1;
  const hipX = Math.max(Math.abs(R.joints.LeftUpLeg[0]), Math.abs(R.joints.RightUpLeg[0]));
  return { rx: (hipX + (jeans ? 0.098 : 0.095) * lb + 0.020) * hw, ry: ((jeans ? 0.104 : 0.101) * lb + 0.036) * (0.5 + 0.5 * hw) };
}
// female frame on the torso lofts: the waist narrows about 1.12 (V.waist), the hips widen below 1.02 (V.hipW) and
// a bust rides the front of the chest rows (V.bust, metres proud at the apex). All 1 / 0 on a male body.
function figureK(K, y) { const V = K.V, w = V.waist || 1, h = V.hipW || 1; return lerp(1, w, gauss(y - 1.12, 0.09)) * lerp(1, h, sstep((1.02 - y) / 0.10)); }
function bustAt(K, y, k = 1) {
  const b = (K.V.bust || 0) * k; if (b <= 0) return null;
  const g = gauss(y - 1.30, 0.055); if (g < 0.02) return null;
  return (ang) => b * g * (gauss(adiff(ang, HPI - 0.38), 0.34) + gauss(adiff(ang, HPI + 0.38), 0.34));
}
// a generic hem-cut copy of a row table [y, rx, ry, oz, ...]: the first row sits AT `hem` (interpolated), with an
// optional rib band (a 4 mm inset over `band` metres) above it, then the table's own rows
function rowsFrom(rows, hem, band = 0) {
  const at = (y) => [y, ...table(rows, y)];
  const out = [];
  if (band > 0) { const a = at(hem), c = at(hem + band); out.push([hem, a[1] - 0.004, a[2] - 0.004, ...a.slice(3)], [hem + band, c[1] - 0.004, c[2] - 0.004, ...c.slice(3)], [hem + band + 0.004, ...c.slice(1)]); }
  else out.push(at(hem));
  for (const r of rows) if (r[0] > hem + band + 0.012) out.push(r);
  return out;
}
function buildJacket(K, wT, kind, spec = {}) {
  const V = K.V, b = V.build, belly = (V.belly || 0) + (V.gut || 0), coat = kind === 'coat', sw = V.shoulderW || 1;
  // [y, rx, ry, oz, gap, lapel]
  let rows;
  if (coat) rows = [
    [0.52, 0.245, 0.17, 0.0, 0.22, 0], [0.60, 0.240, 0.165, 0, 0.2, 0], [0.72, 0.232, 0.16, 0, 0.17, 0], [0.84, 0.222, 0.15, 0, 0.14, 0], [0.98, 0.212, 0.142, 0, 0.11, 0.05],
    [1.06, 0.206, 0.136, 0.004, 0.09, 0.12], [1.14, 0.208, 0.138, 0.006, 0.09, 0.2], [1.22, 0.216, 0.144, 0.008, 0.13, 0.3], [1.30, 0.227, 0.15, 0.008, 0.24, 0.34], [1.38, 0.240, 0.153, 0.004, 0.36, 0.32],
    [1.44, 0.252, 0.151, 0, 0.46, 0.30], [1.48, 0.250, 0.146, -0.002, 0.52, 0.12], [1.50, 0.236, 0.138, -0.005, 0.55, 0.04], [1.515, 0.196, 0.122, -0.008, 0.57, 0], [1.53, 0.14, 0.097, -0.01, 0.6, 0], [1.54, 0.099, 0.081, -0.01, 0.62, 0]];
  else if (V.buttoned) rows = [                     // single-breasted, only the waist button fastened: the V closes at 1.11
    [0.870, 0.202, 0.138, 0, 0.178, 0], [0.876, 0.2145, 0.1465, 0, 0.178, 0], [0.888, 0.2140, 0.1460, 0, 0.176, 0], [0.92, 0.212, 0.145, 0, 0.168, 0], [0.98, 0.211, 0.146, 0.002, 0.140, 0],
    [1.028, 0.2095, 0.1465, 0.003, 0.100, 0.02], [1.050, 0.2045, 0.1435, 0.004, 0.082, 0.05], [1.078, 0.2070, 0.1450, 0.0045, 0.048, 0.08],
    [1.11, 0.204, 0.142, 0.005, 0.020, 0.11], [1.142, 0.2015, 0.1395, 0.0055, 0.050, 0.16], [1.17, 0.206, 0.141, 0.006, 0.085, 0.21],
    [1.23, 0.213, 0.143, 0.008, 0.165, 0.29], [1.30, 0.222, 0.147, 0.008, 0.255, 0.345], [1.38, 0.235, 0.150, 0.004, 0.375, 0.35],
    [1.415, 0.243, 0.149, 0.002, 0.428, 0.245], [1.438, 0.2515, 0.1495, 0, 0.458, 0.315], [1.458, 0.2535, 0.1475, -0.001, 0.50, 0.30], [1.468, 0.2505, 0.1450, -0.0015, 0.52, 0.22],
    [1.480, 0.238, 0.140, -0.002, 0.53, 0.12], [1.497, 0.226, 0.133, -0.005, 0.56, 0.04], [1.509, 0.190, 0.118, -0.008, 0.58, 0], [1.518, 0.135, 0.094, -0.01, 0.6, 0], [1.524, 0.096, 0.078, -0.01, 0.62, 0]];
  // The shoulder line reaches its full width at the acromion (1.425) and slopes IN above it — the old table held
  // max width from 1.44 to 1.48 and then collapsed, which built a flat shelf and read as a cardboard box.
  else rows = [
    // hem: a 12 mm band standing 4 mm proud of the body with a lip under it, so the jacket ENDS somewhere instead of
    // fading into the trouser at one flat value
    [0.830, 0.197, 0.130, 0, 0.11, 0], [0.836, 0.2095, 0.1395, 0, 0.11, 0], [0.848, 0.2090, 0.1390, 0, 0.11, 0], [0.90, 0.205, 0.136, 0, 0.1, 0], [0.98, 0.203, 0.134, 0.002, 0.08, 0], [1.06, 0.196, 0.128, 0.004, 0.06, 0.06],
    [1.14, 0.200, 0.132, 0.006, 0.07, 0.16], [1.22, 0.210, 0.140, 0.008, 0.12, 0.28], [1.30, 0.221, 0.146, 0.008, 0.24, 0.34], [1.375, 0.2375, 0.1495, 0.004, 0.37, 0.32],
    [1.402, 0.2432, 0.1490, 0.0025, 0.41, 0.315],                                     // shoulder cap: two extra rings
    [1.425, 0.2465, 0.1475, 0.001, 0.45, 0.31], [1.442, 0.2462, 0.1452, 0, 0.475, 0.27],
    [1.455, 0.2435, 0.1425, -0.001, 0.50, 0.22], [1.478, 0.2335, 0.1370, -0.002, 0.53, 0.12],
    [1.484, 0.216, 0.129, -0.005, 0.56, 0.04], [1.496, 0.181, 0.115, -0.008, 0.58, 0], [1.506, 0.131, 0.093, -0.01, 0.6, 0], [1.514, 0.096, 0.078, -0.01, 0.62, 0]];
  const track = kind === 'track';
  if (coat && spec.hem) rows = rowsFrom(rows, spec.hem, 0.012);       // a pedestrian's overcoat ends above the knee
  const proud = spec.proud || 0;
  // unbuttoned jacket (kiryu): the fronts hang open into a wedge that widens toward the hem
  const open = V.open ? 1 : 0, parts = [];
  const info = [];
  const hull = thighHull(K), wSkirt = skirtW(K.R, wT);
  const rings = rows.map(([y, rx, ry, oz, g, lw]) => {
    const shK = lerp(1, sw, sstep((y - 1.2) / 0.24)), gut = gutAt(y, belly), fk = figureK(K, y);
    // below the waist the skirt is never narrower than the thighs it hangs over (a slim build's jacket flares a little)
    const fh = coat ? 0 : sstep((1.0 - y) / 0.10);
    const RX = Math.max(rx * b * shK * fk, lerp(rx * b * shK * fk, hull.rx, fh)) + proud, RY = Math.max(ry * (0.85 + 0.15 * b) * fk, lerp(0, hull.ry, fh)) + gut * 0.6 + proud, OZ = oz + gut * 0.5;
    const gOpen = g + open * (0.14 + 0.06 * sstep((1.0 - y) / 0.15)) * sstep((1.4 - y) / 0.12);
    const gap = track ? Math.max(0.06, g * 0.5) : (spec.gap != null ? Math.max(g, spec.gap) : gOpen), lap = track ? 0 : lw;
    const w = coat && y < 0.95 ? coatSkirtW : y < 1.0 ? wSkirt : wT;
    // coat skirt drape folds, waist bunching for the short jacket, the bust on a woman's chest rows
    const bu = bustAt(K, y, coat ? 0.55 : 0.8);
    const wr0 = coat ? (ang) => 0.004 * Math.sin(ang * 7 + 0.4) * sstep((1.0 - y) / 0.4) : (ang) => 0.0015 * Math.sin(ang * 5 + y * 30) * gauss(y - 1.05, 0.1);
    const wr = bu ? (ang) => wr0(ang) + bu(ang) : wr0;
    info.push({ y: K.ty(y), RX, RY, OZ, gap, lap });
    return { c: new THREE.Vector3(0, K.ty(y), 0), u: X_AXIS, v: Z_AXIS, rx: RX, ry: RY, w, uScale: 11.7 * TAU * (RX + RY) / 2, shape: jacketShape(RX, RY, gap, lap, track ? 0.005 : 0.017, OZ, wr) };
  });
  // a1 stops a hair short of a full turn so loft() does NOT treat this as closed: the two ends of the ring are the
  // two lapel edges either side of the chest, and averaging their normals flattened both into one painted V
  parts.push({ geo: loft(rings, { segs: K.segs, a0: 0, a1: TAU - 1e-3, uv: [1, 11.7] }), mat: K.mats.jacket });
  if (track) return parts;
  const at = (y) => { const r = table(info.map((i) => [i.y, i.RX, i.RY, i.OZ, i.gap, i.lap]), K.ty(y)); return { RX: r[0], RY: r[1], OZ: r[2], gap: r[3], lap: r[4] }; };
  const surf = (y, ang, proud) => { const i = at(y), [x, z] = sellipse(ang, i.RX + proud, i.RY + proud, 2.2); return new THREE.Vector3(x, K.ty(y), z + i.OZ); };
  // collar: stand inside the shirt collar's line, rolled over onto the yoke, 8 mm proud; open ±60° at the front
  const nk = V.neck, cr = [[1.446, 0.084, 0.074], [1.478, 0.082, 0.072], [1.510, 0.087, 0.077], [1.512, 0.099, 0.088], [1.499, 0.115, 0.102], [1.480, 0.136, 0.121]];
  const ga = 1.05, cs = coat ? 1.06 : 1;
  parts.push({ geo: loft(cr.map(([y, rx, ry]) => ({ c: new THREE.Vector3(0, K.ty(y), -0.008), u: X_AXIS, v: Z_AXIS, rx: rx * nk * cs, ry: ry * nk * cs, w: wT, uScale: 8, shape: (a, f) => { const ang = HPI + ga + (TAU - 2 * ga) * f; return sellipse(ang, rx * nk * cs, ry * nk * cs, 2); } })), { segs: Math.max(14, K.segs >> 1), uv: [1, 11.7] }), mat: K.mats.jacket });
  // front buttons on the wearer's right panel (glossy horn = shoe material), hip pocket flaps, breast welt
  const bys = coat ? [1.02, 1.12, 1.22] : V.buttoned ? [1.02, 1.11] : [1.02, 1.12];
  for (const y of bys) { const i = at(y), ang = HPI + i.gap + (V.buttoned && y > 1.06 ? 0.03 : 0.07); const p = surf(y, ang, 0.004); parts.push({ geo: K.tint(skinGeo(button(p, new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)), 0.009, 0.004), wT), 'shoes', 0x26221d), mat: K.mats.shoes }); }
  for (const s of [-1, 1]) {
    const ac = HPI - s * 0.95, y0 = coat ? 1.02 : 1.05;
    const flap = [[y0, 0.0], [y0 - 0.012, 0.004], [y0 - 0.05, 0.004], [y0 - 0.052, 0.0]].map(([y, pr]) => { const i = at(y); return { c: new THREE.Vector3(0, K.ty(y), i.OZ), u: X_AXIS, v: Z_AXIS, rx: i.RX, ry: i.RY, w: wT, uScale: 2, shape: (a) => sellipse(a, i.RX + pr, i.RY + pr, 2.2) }; });
    parts.push({ geo: loft(flap, { segs: 8, a0: ac - 0.36, a1: ac + 0.36, uv: [1, 11.7] }), mat: K.mats.jacket });
  }
  { const i = at(1.27), ac = HPI - (i.gap + i.lap + 0.24);
    const welt = [[1.283, 0.0], [1.28, 0.003], [1.258, 0.003], [1.255, 0.0]].map(([y, pr]) => { const j = at(y); return { c: new THREE.Vector3(0, K.ty(y), j.OZ), u: X_AXIS, v: Z_AXIS, rx: j.RX, ry: j.RY, w: wT, uScale: 2, shape: (a) => sellipse(a, j.RX + pr, j.RY + pr, 2.2) }; });
    parts.push({ geo: loft(welt, { segs: 6, a0: ac - 0.22, a1: ac + 0.22, uv: [1, 11.7] }), mat: K.mats.jacket });
    // pocket square: a soft triangular peak standing 7 mm out of the welt, fading back into the chest at its edges
    if (V.chief) {
      const cr2 = [[1.2815, 0.30, 0.0045], [1.292, 0.265, 0.0072], [1.301, 0.175, 0.0072], [1.309, 0.075, 0.005], [1.3125, 0.02, 0.002]];
      const cg = loft(cr2.map(([y, w, pr]) => { const j = at(y); return {
        c: new THREE.Vector3(0, K.ty(y), j.OZ), u: X_AXIS, v: Z_AXIS, rx: j.RX, ry: j.RY, w: wT, uScale: 1.4,
        shape: (a, f) => { const e = 0.0012 + pr * Math.sin(clamp(f, 0.001, 0.999) * Math.PI); return sellipse(ac + (f - 0.5) * w, j.RX + e, j.RY + e, 2.2); } }; }),
        { segs: 10, a0: 0, a1: 1, uv: [1, 6] });
      parts.push({ geo: K.tint(cg, 'cloth', V.chiefColor || V.accent), mat: K.mats.accent });
    } }
  return parts;
}
// coat skirt follows the legs (left/right panel) blending to the hips at the top
let coatSkirtW = null;
function makeCoatSkirtW() {
  const L = RIG.index.LeftUpLeg, R = RIG.index.RightUpLeg, H = RIG.index.Hips;
  return (p) => {
    const side = sstep((p.x + 0.04) / 0.08), hip = sstep((p.y - 0.80) / 0.16);
    return [[L, side * (1 - hip)], [R, (1 - side) * (1 - hip)], [H, hip]];
  };
}
function buildShirt(K, wT, { collar = true, vGap = 0.35, vFrom = 1.28, inset = 0.013, top = 1.506, bottom = 1.02, closed = false, stand = false } = {}) {
  const V = K.V, b = V.build, belly = (V.belly || 0) + (V.gut || 0);
  // a tee under a zip top hangs to the hip: it fills the zip's gap down to the hem (the trousers used to show there as
  // a blue stripe from the chest to the crotch) and rides the thighs like the jacket skirt it sits behind
  const low = bottom < 0.95 ? [[bottom, 0.200, 0.132, 0.002], [0.93, 0.194, 0.126, 0.002]] : [[bottom, 0.192, 0.124, 0.002]];
  const rows = [...low, [1.06, 0.186, 0.118, 0.004], [1.14, 0.190, 0.122, 0.006], [1.22, 0.200, 0.130, 0.008], [1.30, 0.210, 0.136, 0.008], [1.38, 0.218, 0.138, 0.004], [1.43, 0.212, 0.132, 0], [1.458, 0.18, 0.116, -0.004], [1.478, 0.14, 0.098, -0.008], [1.496, 0.098, 0.08, -0.01], [top, 0.082, 0.07, -0.01]];
  const wS = bottom < 0.95 ? skirtW(K.R, wT) : wT;
  const rings = rows.map(([y, rx, ry, oz]) => {
    const gut = gutAt(y, belly), fk = figureK(K, y);
    const RX = rx * b * fk - inset, RY = ry * (0.85 + 0.15 * b) * fk - inset + gut * 0.6;
    const g = closed ? 0.004 : Math.max(0.004, vGap * sstep((y - vFrom) / (top - vFrom)));
    return { c: new THREE.Vector3(0, K.ty(y), 0), u: X_AXIS, v: Z_AXIS, rx: RX, ry: RY, w: y < 1.0 ? wS : wT, uScale: 9 * TAU * (RX + RY) / 2, shape: jacketShape(RX, RY, g, 0, 0, oz + gut * 0.5, bustAt(K, y, 1)) };
  });
  const parts = [loft(rings, { segs: K.segs, a0: 0, a1: TAU - 1e-3, uv: [1, 9] })];
  if (collar || stand) {
    // stand + fold: rings around the neck base, open at the front (collar points fall on the lapels); stand-only for track tops
    const cr = stand ? [[1.460, 0.082, 0.072, 0], [1.490, 0.080, 0.070, 0], [1.506, 0.083, 0.072, 0.002]]
      : [[1.458, 0.081, 0.071, 0], [1.494, 0.0745, 0.0655, 0], [1.520, 0.0795, 0.0695, 0.004], [1.512, 0.090, 0.079, 0.01], [1.500, 0.099, 0.087, 0.016], [1.490, 0.104, 0.092, 0.02]];
    const ga = stand ? 0.2 : closed ? 0.32 : vGap + 0.12;
    const crings = cr.map(([y, rx, ry, zz]) => ({ c: new THREE.Vector3(0, K.ty(y), -0.006 - zz), u: X_AXIS, v: Z_AXIS, rx: rx * V.neck, ry: ry * V.neck, w: wT, uScale: 4, shape: (a, f) => { const ang = HPI + ga + (TAU - 2 * ga) * f; return sellipse(ang, rx * V.neck, ry * V.neck, 2); } }));
    parts.push(loft(crings, { segs: Math.max(12, K.segs >> 1), uv: [1, 9] }));
  }
  return parts;
}
// bunched hood on the upper back (track outfit): back half bulges behind the collar, front half hides inside the neck
function buildHood(K, wT) {
  const b = K.V.build;
  const rows = [[1.38, 0.19, 0.05, 0.13, -0.02], [1.43, 0.20, 0.05, 0.145, -0.03], [1.48, 0.17, 0.05, 0.14, -0.04], [1.53, 0.13, 0.048, 0.12, -0.05], [1.565, 0.09, 0.045, 0.09, -0.055], [1.585, 0.03, 0.03, 0.03, -0.055]];
  return loft(rows.map(([y, rxB, rF, ryB, oz]) => ({
    c: new THREE.Vector3(0, K.ty(y), oz), u: X_AXIS, v: Z_AXIS, rx: rxB, ry: ryB, w: wT, uScale: 10,
    shape: (a) => { const k = sstep((-Math.sin(a) + 0.2) / 0.7); return sellipse(a, lerp(rF, rxB * b, k), lerp(rF, ryB, k), 2); },
  })), { segs: K.segs, uv: [1, 11.7] });
}
function buildUndershirt(K, wT, top = 1.53) {
  const b = K.V.build;
  const rows = [[1.10, 0.176, 0.106], [1.22, 0.184, 0.112], [1.34, 0.196, 0.118], [1.44, 0.19, 0.112], [1.475, 0.16, 0.098], [1.50, 0.12, 0.08], [top, 0.07, 0.062]];
  return loft(rows.map(([y, rx, ry]) => yring(K.ty(y), rx * b, ry * (0.85 + 0.15 * b), wT, { oz: 0.004, uScale: 8 })), { segs: K.segs, uv: [1, 9] });
}
function buildTie(K, wT) {
  const b = K.V.build, belly = (K.V.belly || 0) + (K.V.gut || 0);
  const zAt = (y) => (table([[1.10, 0.122], [1.22, 0.130], [1.30, 0.136], [1.38, 0.138], [1.44, 0.132], [1.50, 0.098], [1.53, 0.07]], y)[0]) * (0.85 + 0.15 * b) - 0.006 + gutAt(y, belly) * 1.1;
  // A real blade is 3-4 mm thick; it used to be a 19 mm sausage, which is why it read as a flat quad floating on
  // a painted V. The knot keeps its mass (a four-in-hand is ~28 mm deep) and the dimple sits under it.
  const rows = K.V.knitTie
    ? [[1.520, 0.014, 0.008], [1.508, 0.026, 0.0145], [1.494, 0.030, 0.0155], [1.480, 0.029, 0.0135], [1.468, 0.021, 0.0075], [1.460, 0.024, 0.0055], [1.44, 0.030, 0.0045], [1.38, 0.034, 0.0042], [1.30, 0.038, 0.0042], [1.22, 0.040, 0.0042], [1.16, 0.041, 0.0042], [1.122, 0.041, 0.0038], [1.116, 0.038, 0.0028], [1.113, 0.02, 0.0012]]
    : [[1.518, 0.012, 0.007], [1.506, 0.022, 0.0125], [1.492, 0.026, 0.0135], [1.478, 0.025, 0.0115], [1.466, 0.017, 0.0065], [1.458, 0.020, 0.0045], [1.40, 0.026, 0.0038], [1.30, 0.034, 0.0038], [1.20, 0.040, 0.0038], [1.125, 0.042, 0.0038], [1.10, 0.024, 0.003], [1.088, 0.003, 0.0012]];
  return loft(rows.map(([y, rx, ry]) => yring(K.ty(y), rx, ry, wT, { oz: zAt(y) + ry, uScale: 2 })), { segs: 10, uv: [1, 9] });
}

// ---------------------------------------------------------------- pedestrian wardrobe (the eight outfit templates)
// The lapel-less family (hoodie, blouson, windbreaker, tee, cardigan, gakuran) is one loft over the generic torso
// table with a hem, an optional rib band, a front opening g(y) and a collar; the tailored family (suit, blazer,
// coat) stays on buildJacket. Everything below rides the vertex-colour slots, so a body never pays more than the
// seven draws the budget allows whatever it wears.
const TOP_ROWS = [
  [0.830, 0.197, 0.130, 0, 0.11, 0], [0.836, 0.2095, 0.1395, 0, 0.11, 0], [0.848, 0.2090, 0.1390, 0, 0.11, 0], [0.90, 0.205, 0.136, 0, 0.1, 0], [0.98, 0.203, 0.134, 0.002, 0.08, 0], [1.06, 0.196, 0.128, 0.004, 0.06, 0.06],
  [1.14, 0.200, 0.132, 0.006, 0.07, 0.16], [1.22, 0.210, 0.140, 0.008, 0.12, 0.28], [1.30, 0.221, 0.146, 0.008, 0.24, 0.34], [1.375, 0.2375, 0.1495, 0.004, 0.37, 0.32],
  [1.402, 0.2432, 0.1490, 0.0025, 0.41, 0.315], [1.425, 0.2465, 0.1475, 0.001, 0.45, 0.31], [1.442, 0.2462, 0.1452, 0, 0.475, 0.27],
  [1.455, 0.2435, 0.1425, -0.001, 0.50, 0.22], [1.478, 0.2335, 0.1370, -0.002, 0.53, 0.12],
  [1.484, 0.216, 0.129, -0.005, 0.56, 0.04], [1.496, 0.181, 0.115, -0.008, 0.58, 0], [1.506, 0.131, 0.093, -0.01, 0.6, 0], [1.514, 0.096, 0.078, -0.01, 0.62, 0]];
// the body's own outline at height y (jacket table x build x frame), for anything laid ON the torso (apron, straps)
function bodyAt(K, y) {
  const V = K.V, b = V.build, sw = V.shoulderW || 1;
  const [rx, ry, oz] = table(TOP_ROWS, y), shK = lerp(1, sw, sstep((y - 1.2) / 0.24)), fk = figureK(K, y), gut = gutAt(y, (V.belly || 0) + (V.gut || 0));
  const hull = thighHull(K), fh = sstep((1.0 - y) / 0.10);
  return { RX: Math.max(rx * b * shK * fk, lerp(rx * b * shK * fk, hull.rx, fh)), RY: Math.max(ry * (0.85 + 0.15 * b) * fk, lerp(0, hull.ry, fh)) + gut * 0.6, OZ: oz + gut * 0.5 };
}
const bodyW = (K, wT, y) => (y < 0.92 ? coatSkirtW : y < 1.0 ? skirtW(K.R, wT) : wT);
function buildTopLoft(K, wT, spec) {
  const V = K.V, b = V.build, belly = (V.belly || 0) + (V.gut || 0), sw = V.shoulderW || 1;
  const { hem = 0.86, band = 0, gap = 0.004, collar = 'none', boxy = 1, mat, tint, key = 'cloth', proud = 0, folds = 0.0015, bustK = 0.8 } = spec;
  const rows = rowsFrom(TOP_ROWS, hem, band), hull = thighHull(K), wSkirt = skirtW(K.R, wT), parts = [], info = [];
  const rings = rows.map(([y, rx, ry, oz]) => {
    const shK = lerp(1, sw, sstep((y - 1.2) / 0.24)), gut = gutAt(y, belly), fk = figureK(K, y), fh = sstep((1.0 - y) / 0.10);
    const base = rx * b * shK * boxy * fk;
    const RX = Math.max(base, lerp(base, hull.rx, fh)) + proud, RY = Math.max(ry * (0.85 + 0.15 * b) * boxy * fk, lerp(0, hull.ry, fh)) + gut * 0.6 + proud, OZ = oz + gut * 0.5;
    const g = typeof gap === 'function' ? gap(y) : gap;
    const bu = bustAt(K, y, bustK);
    const wr = (ang) => folds * Math.sin(ang * 5 + y * 30) * gauss(y - 1.05, 0.1) + folds * 1.4 * Math.sin(ang * 3 + 1.2) * gauss(y - hem - 0.05, 0.05) + (bu ? bu(ang) : 0);
    info.push({ y: K.ty(y), RX, RY, OZ, gap: g });
    return { c: new THREE.Vector3(0, K.ty(y), 0), u: X_AXIS, v: Z_AXIS, rx: RX, ry: RY, w: y < 1.0 ? wSkirt : wT, uScale: 11.7 * TAU * (RX + RY) / 2, shape: jacketShape(RX, RY, g, 0, 0, OZ, wr) };
  });
  parts.push({ geo: K.tint(loft(rings, { segs: K.segs, a0: 0, a1: TAU - 1e-3, uv: [1, 11.7] }), key, tint), mat });
  const at = (y) => { const r = table(info.map((i) => [i.y, i.RX, i.RY, i.OZ, i.gap]), K.ty(y)); return { RX: r[0], RY: r[1], OZ: r[2], gap: r[3] }; };
  const surf = (y, ang, pr) => { const i = at(y), [x, z] = sellipse(ang, i.RX + pr, i.RY + pr, 2.2); return new THREE.Vector3(x, K.ty(y), z + i.OZ); };
  const nk = V.neck;
  if (collar !== 'none') {
    // stand (a blouson's rib collar, 2.6 cm), tall (a gakuran's, 3.8 cm) or a crew rib (1.2 cm); open at the front by gapTop
    const hgt = collar === 'tall' ? 0.038 : collar === 'stand' ? 0.026 : 0.012;
    const ga = collar === 'rib' ? 0.02 : Math.max(0.14, spec.gapTop ?? 0.2);
    const cr = [[1.460, 0.083, 0.073], [1.460 + hgt * 0.5, 0.0815, 0.0715], [1.460 + hgt, 0.084, 0.074], [1.462 + hgt, 0.091, 0.080]];
    parts.push({ geo: K.tint(loft(cr.map(([y, rx, ry]) => ({ c: new THREE.Vector3(0, K.ty(y), -0.008), u: X_AXIS, v: Z_AXIS, rx: rx * nk, ry: ry * nk, w: wT, uScale: 8, shape: (a, f) => { const ang = HPI + ga + (TAU - 2 * ga) * f; return sellipse(ang, rx * nk, ry * nk, 2); } })), { segs: Math.max(12, K.segs >> 1), uv: [1, 11.7] }), key, tint), mat });
  }
  if (spec.zip) {                                    // a 9 mm zip tape down the centre front, 2 mm proud
    const zs = [];
    for (let y = hem + band + 0.012; y < 1.455; y += 0.028) zs.push({ c: surf(y, HPI, 0.0022), u: X_AXIS, v: Z_AXIS, rx: 0.0045, ry: 0.0015, w: wT, uScale: 0.25 });
    parts.push({ geo: K.tint(loft(zs, { segs: 6, uv: [1, 3] }), 'cloth', 0x8e9298), mat: K.mats.accent });
  }
  if (spec.kangaroo) {                               // kangaroo pocket: a proud panel across the belly, its top edge the opening
    const pk = [[hem + band + 0.012, 0], [hem + band + 0.016, 0.004], [1.075, 0.004], [1.08, 0.0]].map(([y, pr]) => { const i = at(y); return { c: new THREE.Vector3(0, K.ty(y), i.OZ), u: X_AXIS, v: Z_AXIS, rx: i.RX, ry: i.RY, w: y < 1.0 ? wSkirt : wT, uScale: 3, shape: (a) => sellipse(a, i.RX + pr, i.RY + pr, 2.2) }; });
    parts.push({ geo: K.tint(loft(pk, { segs: 10, a0: HPI - 0.62, a1: HPI + 0.62, uv: [1, 11.7] }), key, tint), mat });
  }
  if (spec.buttons) {                                // a column of buttons down the wearer's right edge of the opening
    const [n, y0, y1, hex] = spec.buttons;
    for (let i = 0; i < n; i++) { const y = lerp(y0, y1, n > 1 ? i / (n - 1) : 0), a = HPI + at(y).gap + 0.045; const p = surf(y, a, 0.004); parts.push({ geo: K.tint(skinGeo(button(p, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 0.0075, 0.0035), wT), 'shoes', hex), mat: K.mats.shoes }); }
  }
  return parts;
}
// a knee dress in one loft: crew neck, a fitted bodice with the bust, the waist, then a flared skirt to `hem`
function buildDress(K, wT, mat, tint, key, hem = 0.56) {
  const V = K.V, b = V.build, sw = V.shoulderW || 1, hull = thighHull(K), flare = 1.20 + 0.10 * ((0.62 - hem) / 0.12);
  const rows = [];
  for (const y of [hem, hem + 0.010, lerp(hem, 0.97, 0.3), lerp(hem, 0.97, 0.62), 0.97, 1.00, 1.02]) rows.push([y, 0, 0, 0.002]);
  for (const r of TOP_ROWS) if (r[0] > 1.04) rows.push([r[0], r[1], r[2], r[3]]);
  const rings = rows.map(([y, rx, ry, oz]) => {
    let RX, RY, OZ = oz;
    if (y <= 1.02) { const t = sstep((1.0 - y) / (1.0 - hem)); RX = lerp(hull.rx + 0.004, (hull.rx + 0.004) * flare, t); RY = lerp(hull.ry + 0.004, (hull.ry + 0.004) * flare * 1.08, t); }
    else { const shK = lerp(1, sw, sstep((y - 1.2) / 0.24)), fk = figureK(K, y); RX = rx * b * shK * fk; RY = ry * (0.85 + 0.15 * b) * fk; }
    const bu = bustAt(K, y, 1);
    const wr = (ang) => 0.003 * Math.sin(ang * 6 + 0.7) * sstep((1.0 - y) / 0.25) + (bu ? bu(ang) : 0);
    return { c: new THREE.Vector3(0, K.ty(y), 0), u: X_AXIS, v: Z_AXIS, rx: RX, ry: RY, w: bodyW(K, wT, y), uScale: 11.7 * TAU * (RX + RY) / 2, shape: jacketShape(RX, RY, 0.004, 0, 0, OZ, wr) };
  });
  const g = K.tint(loft(rings, { segs: K.segs, a0: 0, a1: TAU - 1e-3, uv: [1, 11.7] }), key, tint);
  return [{ geo: g, mat }];
}
// a skirt from the waist (top) to `hem`: flared or knife-pleated (pleats > 0: the loft is sampled 3x per pleat)
function buildSkirt(K, wT, mat, tint, key, { top = 1.01, hem = 0.58, flare = 1.28, pleats = 0 } = {}) {
  const hull = thighHull(K);
  const ys = [hem, hem + 0.008, lerp(hem, top, 0.3), lerp(hem, top, 0.6), lerp(hem, top, 0.85), top - 0.012, top];
  const rings = ys.map((y) => {
    const t = sstep((top - 0.02 - y) / (top - 0.02 - hem));
    const RX = lerp(hull.rx + 0.006, (hull.rx + 0.006) * flare, t), RY = lerp(hull.ry + 0.006, (hull.ry + 0.006) * flare * 1.08, t);
    return { c: new THREE.Vector3(0, K.ty(y), 0.002), u: X_AXIS, v: Z_AXIS, rx: RX, ry: RY, w: bodyW(K, wT, y), uScale: 11.7 * TAU * (RX + RY) / 2,
      shape: (a, f) => { const k = pleats ? 1 + 0.030 * t * (1 - 2 * Math.abs(((pleats * f) % 1) - 0.5)) : 1 + 0.004 * Math.sin(a * 7 + 0.3) * t; const [x, z] = sellipse(a, RX * k, RY * k, 2.2); return [x, z]; } };
  });
  return [{ geo: K.tint(loft(rings, { segs: pleats ? pleats * 3 : K.segs, uv: [1, 11.7] }), key, tint), mat }];
}
// a bib apron: bib from the sternum to the waist, skirt to above the knee, 8 mm off the body; neck strap and a waist tie
function buildApron(K, wT, mat, tint, key) {
  const parts = [];
  const rows = [[0.56, 0.72], [0.575, 0.74], [0.80, 0.70], [0.98, 0.64], [1.02, 0.62], [1.03, 0.36], [1.17, 0.33], [1.30, 0.29], [1.32, 0.25]];
  const rings = rows.map(([y, ha]) => { const i = bodyAt(K, y), pr = 0.008; return { c: new THREE.Vector3(0, K.ty(y), i.OZ), u: X_AXIS, v: Z_AXIS, rx: i.RX + pr, ry: i.RY + pr, w: bodyW(K, wT, y), uScale: 2 * ha,
    shape: (a, f) => { const ang = HPI - ha + 2 * ha * f, [x, z] = sellipse(ang, i.RX + pr + 0.003 * Math.sin(f * 9 + y * 20) * sstep((1.0 - y) / 0.3), i.RY + pr, 2.2); return [x, z]; } }; });
  parts.push({ geo: K.tint(loft(rings, { segs: Math.max(10, K.segs), a0: 0, a1: 1, uv: [1, 11.7] }), key, tint), mat });
  const i1 = bodyAt(K, 1.32), i2 = bodyAt(K, 1.44);
  for (const s of [-1, 1]) {                         // strap: bib corner up over the shoulder to the nape
    const a0 = HPI - s * 0.25, [x0, z0] = sellipse(a0, i1.RX + 0.009, i1.RY + 0.009, 2.2);
    const [x1, z1] = sellipse(HPI - s * 0.42, i2.RX + 0.006, i2.RY + 0.006, 2.2);
    const pts = [new THREE.Vector3(x0, K.ty(1.32), z0 + i1.OZ), new THREE.Vector3(x1 * 0.9, K.ty(1.44), z1 + i2.OZ), new THREE.Vector3(s * 0.062, K.ty(1.505), 0.012), new THREE.Vector3(s * 0.030, K.ty(1.512), -0.070)];
    parts.push({ geo: K.tint(tubeAlong(pts, 0.007, 0.0022, wT, false, new THREE.Vector3(0, K.ty(1.40), -0.02)), key, tint), mat });
  }
  const tie = [[1.018, 0], [1.022, 0.003], [1.040, 0.003], [1.044, 0]].map(([y, pr]) => { const i = bodyAt(K, y); return { c: new THREE.Vector3(0, K.ty(y), i.OZ), u: X_AXIS, v: Z_AXIS, rx: i.RX, ry: i.RY, w: wT, uScale: 6, shape: (a) => sellipse(a, i.RX + 0.006 + pr, i.RY + 0.006 + pr, 2.2) }; });
  parts.push({ geo: K.tint(loft(tie, { segs: K.segs, uv: [1, 11.7] }), key, tint), mat });
  return parts;
}
// a rounded slab (superellipse rings stacked in y with rounded ends) — bags, packs
function softBox(cx, cy, cz, hx, hy, hz, w, exp = 4, ax = X_AXIS, az = Z_AXIS) {
  const rings = [];
  for (let j = 0; j <= 8; j++) { const t = j / 8, cap = Math.sqrt(Math.max(0.0004, 1 - Math.pow(2 * t - 1, 6))); rings.push({ c: new THREE.Vector3(cx, cy - hy + 2 * hy * t, cz), u: ax, v: az, rx: hx * cap, ry: hz * cap, w, uScale: 2, shape: (a) => sellipse(a, hx * cap, hz * cap, exp) }); }
  return loft(rings, { segs: 14, uv: [1, 4] });
}
function buildBag(K, wT, parts, mat, kind, hex) {
  const R = K.R, key = 'shoes', T = (g) => K.tint(g, key, hex);
  if (kind === 'hand') {                             // a handbag in the left hand, hanging at the thigh by its two handles
    const H = new THREE.Vector3(...R.joints.LeftHand), wH = boneW('LeftHand');
    const c = H.clone().add(new THREE.Vector3(-0.005, -0.235, 0.01));
    parts.push({ geo: T(skinGeo(softBox(c.x, c.y, c.z, 0.038, 0.095, 0.125, wH, 4), wH)), mat });
    for (const dz of [-0.05, 0.05]) {
      const pts = [new THREE.Vector3(c.x, c.y + 0.09, c.z + dz), new THREE.Vector3(c.x - 0.004, H.y - 0.105, c.z + dz * 0.5), new THREE.Vector3(c.x - 0.004, H.y - 0.085, c.z)];
      parts.push({ geo: T(tubeAlong(pts, 0.004, 0.004, wH, false, new THREE.Vector3(c.x + 0.1, c.y + 0.1, c.z))), mat });
    }
  } else if (kind === 'shoulder') {                  // a satchel on the left hip, strap over the right shoulder
    const wHip = boneW('Hips'), hull = thighHull(K);
    const cx = hull.rx + 0.045, cy = 0.94, cz = 0.02;
    parts.push({ geo: T(skinGeo(softBox(cx, cy, cz, 0.045, 0.11, 0.14, wHip, 4), wHip)), mat });
    const s1 = bodyAt(K, 1.46), s2 = bodyAt(K, 1.25), s3 = bodyAt(K, 1.08);
    const P = (i, ang, y, pr = 0.006) => { const [x, z] = sellipse(ang, i.RX + pr, i.RY + pr, 2.2); return new THREE.Vector3(x, K.ty(y), z + i.OZ); };
    const front = [P(s1, HPI + 1.25, 1.46, 0.01), P(s2, HPI + 0.45, 1.27), P(s3, HPI - 0.40, 1.10), new THREE.Vector3(cx - 0.01, cy + 0.10, cz + 0.06)];
    const back = [P(s1, HPI + 1.25, 1.46, 0.01), P(s2, -HPI + 0.55, 1.27), P(s3, -HPI - 0.45, 1.10), new THREE.Vector3(cx - 0.01, cy + 0.10, cz - 0.06)];
    for (const pts of [front, back]) parts.push({ geo: T(tubeAlong(pts, 0.014, 0.0025, wT, false, new THREE.Vector3(0, 1.20, 0))), mat });
  } else if (kind === 'backpack') {                  // a daypack on the back, two straps over the shoulders
    const wB = blendW(boneW('Spine2'), boneW('Spine1'), 0.5), i = bodyAt(K, 1.22);
    parts.push({ geo: T(skinGeo(softBox(0, K.ty(1.20), -i.RY - 0.075 + i.OZ, 0.145, 0.19, 0.075, wB, 3.2), wB)), mat });
    const s1 = bodyAt(K, 1.47), s2 = bodyAt(K, 1.30), s3 = bodyAt(K, 1.10);
    for (const s of [-1, 1]) {
      const P = (q, ang, y) => { const [x, z] = sellipse(ang, q.RX + 0.007, q.RY + 0.007, 2.2); return new THREE.Vector3(x, K.ty(y), z + q.OZ); };
      const pts = [new THREE.Vector3(s * 0.09, K.ty(1.36), -s2.RY - 0.03), P(s1, HPI - s * 0.42, 1.475), P(s2, HPI - s * 0.36, 1.30), P(s3, HPI - s * 0.62, 1.10), new THREE.Vector3(s * 0.12, K.ty(1.03), -s3.RY - 0.03)];
      parts.push({ geo: T(tubeAlong(pts, 0.018, 0.004, wT, false, new THREE.Vector3(0, K.ty(1.25), 0))), mat });
    }
  }
}
// bare legs (skin) or hosiery: the leg's own section from the hip to the ankle, on the given material
const LEG_ROWS = [['U', 0.0, 0.086, 0.094], ['U', 0.08, 0.089, 0.096], ['U', 0.20, 0.082, 0.088], ['U', 0.32, 0.070, 0.075], ['U', 0.42, 0.061, 0.065], ['U', 0.45, 0.058, 0.062],
  ['L', 0.03, 0.057, 0.061], ['L', 0.10, 0.061, 0.067], ['L', 0.20, 0.056, 0.061], ['L', 0.32, 0.045, 0.049], ['L', 0.40, 0.037, 0.040], ['L', 0.445, 0.035, 0.038]];
function buildBareLeg(K, U, Lg, mat, tint, key, from = 0, to = 1, pr = 0) {
  const V = K.V, lb = 0.88 + 0.12 * V.build, ll = V.legLen || 1, hw = V.hipW || 1;
  const rows = LEG_ROWS.filter(([s, t]) => { const q = s === 'U' ? t / 0.9 : 0.5 + t / 0.9; return q >= from - 0.02 && q <= to + 0.02; });
  const rings = rows.map(([s, t, rx, ry]) => { const seg = s === 'U' ? U : Lg, k = s === 'U' ? lerp(hw, 1, sstep(t / 0.3)) : 1, RX = rx * lb * k + pr, RY = ry * lb * k + pr; return ring(seg, t * ll, RX, RY, { shape: (a) => { const [x, z] = sellipse(a, RX, RY, 2.1); const calf = s === 'L' ? 1 + 0.06 * gauss(t - 0.12, 0.08) * Math.max(0, -Math.sin(a)) : 1; return [x, z * calf]; } }); });
  const g = loft(rings, { segs: K.segs, uv: [1, 1] });
  if (key) return { geo: K.tint(g, key, tint), mat };
  const r = rectUV(RECT.limb); uvFit(g, r[0], r[1], r[2], r[3]);
  return { geo: g, mat };
}
function buildWardrobe(K, wT, parts, mats) {
  const V = K.V, L = V.look, C = L.colours, G = L.cut;
  const keyOf = (m) => (m === mats.tailor ? 'suit' : m === mats.shoes ? 'shoes' : 'cloth');
  const shirt = (opts) => { for (const g of buildShirt(K, wT, opts)) parts.push({ geo: K.tint(g, 'cloth', V.shirt), mat: mats.accent }); };
  const tie = () => {
    const t = K.tint(buildTie(K, wT), 'cloth', V.accent), a = t.attributes.color, p = t.attributes.position, knotY = K.ty(1.452);
    for (let i = 0; i < a.count; i++) { const k = 1 + 0.18 * sstep((p.getY(i) - knotY) / 0.02); a.setXYZ(i, a.getX(i) * k, a.getY(i) * k, a.getZ(i) * k); }
    parts.push({ geo: t, mat: mats.accent });
  };
  const ribbon = () => {                             // a school ribbon: two flat lobes and a knot at the collar
    const y = K.ty(1.458), z = bodyAt(K, 1.458).RY + 0.004;
    for (const s of [-1, 1]) parts.push({ geo: K.tint(skinGeo(softBox(s * 0.028, y - 0.004, z, 0.026, 0.012, 0.005, wT, 2.4), wT), 'cloth', V.accent), mat: mats.accent });
    parts.push({ geo: K.tint(skinGeo(softBox(0, y, z + 0.002, 0.009, 0.008, 0.006, wT, 2.4), wT), 'cloth', V.accent), mat: mats.accent });
  };
  const coatOver = () => { for (const p of buildJacket(K, wT, 'coat', { hem: V.coatHem, proud: 0.006, gap: 0.16 })) { if (p.mat === mats.jacket && !p.geo.attributes.color) K.tint(p.geo, 'suit', V.coatColor); parts.push(p); } };
  switch (V.top) {
    case 'suit': case 'blazer':
      for (const p of buildJacket(K, wT, 'suit')) { if (p.mat === mats.jacket && !p.geo.attributes.color) K.tint(p.geo, 'suit', shadeHex(V.suit, 1.10)); parts.push(p); }
      shirt({ closed: true });
      if (V.tie) tie(); else if (V.top === 'blazer' && L.fem) ribbon();
      if (V.coat) coatOver();
      break;
    case 'gakuran':
      for (const p of buildTopLoft(K, wT, { hem: 0.80, gap: 0.012, collar: 'tall', gapTop: 0.05, mat: mats.tailor, tint: V.suit, key: 'suit', buttons: [5, 1.06, 1.40, 0xb09040] })) parts.push(p);
      shirt({ collar: false, stand: true, closed: true, top: 1.49 });
      break;
    case 'hoodie':
      for (const p of buildTopLoft(K, wT, { hem: V.hem, band: 0.034, gap: 0.004, collar: 'none', boxy: 1.03, mat: mats.knit, tint: V.suit, key: 'cloth', kangaroo: true, folds: 0.002 })) parts.push(p);
      parts.push({ geo: K.tint(buildHood(K, wT), 'cloth', V.suit), mat: mats.knit });
      shirt({ collar: false, stand: true, closed: true, top: 1.49, bottom: 0.846 });
      break;
    case 'blouson':
      for (const p of buildTopLoft(K, wT, { hem: V.hem, band: 0.030, gap: 0.05, collar: 'stand', gapTop: 0.16, boxy: 1.035, mat: mats.nylon, tint: V.suit, key: 'cloth', zip: true, folds: 0.0025 })) parts.push(p);
      shirt({ collar: false, stand: true, closed: true, top: 1.49, bottom: 0.846 });
      break;
    case 'wind':
      for (const p of buildTopLoft(K, wT, { hem: V.hem, band: 0.02, gap: (y) => 0.05 + 0.12 * sstep((y - 1.05) / 0.35), collar: 'stand', gapTop: 0.22, boxy: 1.04, mat: mats.nylon, tint: V.suit, key: 'cloth', folds: 0.003 })) parts.push(p);
      shirt({ collar: false, stand: true, closed: true, top: 1.49, bottom: 0.846 });
      break;
    case 'tee':
      for (const p of buildTopLoft(K, wT, { hem: V.hem, band: 0.012, gap: 0.004, collar: 'rib', boxy: 1.0, mat: mats.accent, tint: V.suit, key: 'cloth', folds: 0.002 })) parts.push(p);
      break;
    case 'cardigan':
      for (const p of buildTopLoft(K, wT, { hem: V.hem, band: 0.032, gap: (y) => 0.05 + 0.30 * sstep((y - 1.08) / 0.34), collar: 'none', boxy: 1.02, mat: mats.knit, tint: V.suit, key: 'cloth', buttons: [5, 1.10, 1.34, shadeHex(V.suit, 0.6)], folds: 0.002 })) parts.push(p);
      shirt({ closed: true, vGap: 0.2 });
      break;
    case 'dress':
      for (const p of buildDress(K, wT, mats.knit, V.suit, 'cloth', V.skirtHem)) parts.push(p);
      if (V.coat) coatOver();
      break;
    case 'apron':
      shirt({ closed: true });
      for (const p of buildApron(K, wT, mats.accent, V.suit, 'cloth')) parts.push(p);
      break;
  }
  if (V.bottom === 'skirt' || V.bottom === 'pleated') for (const p of buildSkirt(K, wT, mats.tailor, V.trousers, 'suit', { hem: V.skirtHem, flare: V.bottom === 'pleated' ? 1.34 : (L.outfit === 'suit' ? 1.10 : 1.26), pleats: V.pleats })) parts.push(p);
  if (V.bag && V.bag !== 'none') buildBag(K, wT, parts, mats.shoes, V.bag, V.bagColor);
}

// ---------------------------------------------------------------- arms & hands
function buildArm(K, side, parts, mats) {
  const V = K.V, R = K.R, segs = K.segs, b = V.build, ab = 0.85 + 0.15 * b;
  // (fix round 4, critic #1: below LOD0's 22 segments the elbow's pinch/bulge/pinch triple read as a mannequin's
  // ball joint — the bulge is halved and the two-bone blend widened so the arm lofts as one surface)
  const eb = segs >= 20 ? 1 : 0.45;
  const ch = chainSegs(R, ['Spine2', side + 'Shoulder', side + 'Arm', side + 'ForeArm', side + 'Hand'], segs >= 20 ? 0.075 : 0.11);
  const A = ch[2], F = ch[3], H = ch[4];
  const sgn = side === 'Left' ? 1 : -1;
  // sleeve: head starts inside the jacket shoulder (continuous shoulder line), deltoid, elbow bulge (olecranon side) with
  // cloth bunching on the inner elbow, straight fall to the cuff
  const inner = (a, k) => 1 + k * Math.max(0, -Math.cos(a) * sgn);          // inner side (toward the body) of a sleeve ring
  const wrS = (t) => (a) => { const [x, z] = [Math.cos(a), Math.sin(a)]; return [x, z]; };
  void wrS;
  const sv = (seg, t, rx, ry, o = {}) => ring(seg, t, rx, ry, { ...o, shape: (a) => { const k = (o.k || 0) * (0.5 + 0.5 * Math.sin(a * (o.n || 5) + t * 40)) * inner(a, 1) + (o.bulge || 0) * Math.max(0, Math.cos(a) * sgn); const [x, z] = sellipse(a, rx * (1 + k), ry * (1 + k * 0.5), 2.1); return [x, z]; } });
  // every build gets a deltoid: with 0 the sleeve head is a plain sphere on a cone and the arm has no shoulder at all
  const dl = V.deltoid ?? 0.055;
  const short = V.sleeve === 'short', pr = V.look && V.coat ? 0.005 : 0;   // a tee's sleeve ends at mid-biceps; a coat's sleeve sits over the suit's
  if (short) {
    // the sleeve to the mid upper arm with a turned hem, then the bare arm to the wrist on the skin chart
    const sl = [sv(A, -0.030, 0.030 * b, 0.034 * b), sv(A, -0.022, 0.046 * b, 0.050 * b), sv(A, -0.014, 0.060 * b, 0.064 * b), sv(A, -0.008, 0.070 * b, 0.074 * b), sv(A, 0.008, 0.079 * b, 0.082 * b, { bulge: dl * 0.7 }),
      sv(A, 0.045, 0.078 * b, 0.081 * b, { bulge: dl }), sv(A, 0.09, 0.073 * b, 0.076 * b, { bulge: dl * 0.55 }), sv(A, 0.135, 0.070 * b, 0.072 * b), sv(A, 0.150, 0.071 * b, 0.073 * b), sv(A, 0.153, 0.062 * b, 0.064 * b)];
    parts.push({ geo: loft(sl, { segs, uv: [1, 11.7] }), mat: mats.jacket });
    const bare = [[A, 0.10, 0.058, 0.060], [A, 0.16, 0.052, 0.054], [A, 0.22, 0.047, 0.049], [A, 0.262, 0.044, 0.046], [A, 0.2816, 0.043, 0.045], [F, 0.012, 0.044, 0.046], [F, 0.034, 0.048, 0.050], [F, 0.08, 0.046, 0.048], [F, 0.14, 0.041, 0.043], [F, 0.20, 0.035, 0.037], [F, 0.245, 0.030, 0.032], [F, 0.262, 0.029, 0.031]]
      .map(([sg, t, rx, ry]) => ring(sg, t, rx * ab, ry * ab, { shape: (a) => sellipse(a, rx * ab, ry * ab, 2.1) }));
    const bg = loft(bare, { segs, uv: [1, 1] }); { const r = rectUV(RECT.limb); uvFit(bg, r[0], r[1], r[2], r[3]); }
    parts.push({ geo: bg, mat: mats.skin });
    buildHand(K, side, H, parts, mats);
    return;
  }
  const sleeve = [
    sv(A, -0.030, 0.030 * b, 0.034 * b), sv(A, -0.022, 0.046 * b, 0.050 * b), sv(A, -0.014, 0.060 * b, 0.064 * b),   // sleeve head, rounded into the shoulder cap
    sv(A, -0.008, 0.070 * b, 0.074 * b), sv(A, 0.008, 0.079 * b, 0.082 * b, { bulge: dl * 0.7 }),
    sv(A, 0.045, 0.078 * b, 0.081 * b, { bulge: dl }), sv(A, 0.09, 0.071 * b, 0.074 * b, { bulge: dl * 0.55 }),
    sv(A, 0.145, 0.064 * b, 0.066 * b), sv(A, 0.2, 0.060 * ab, 0.062 * ab), sv(A, 0.238, 0.0575 * ab, 0.0595 * ab, { k: 0.05 }),
    sv(A, 0.258, 0.0605 * ab, 0.0625 * ab, { k: 0.07, n: 7 }),
    // Elbow: a pinch/bulge/pinch ring triple across the joint, ±3 cm, 14 % on the radius. At a 4 % fold line the
    // forearm read as one smooth tapered cone from shoulder to cuff — no joint anywhere in the silhouette.
    sv(A, 0.2816, 0.0492 * ab, 0.0512 * ab, { bulge: 0.10 * eb }),
    sv(F, 0.012, 0.0512 * ab, 0.0532 * ab, { bulge: 0.15 * eb, k: 0.06 }), sv(F, 0.034, 0.0608 * ab, 0.0628 * ab, { bulge: 0.16 * eb, k: 0.09, n: 7 }),
    sv(F, 0.054, 0.0548 * ab, 0.0568 * ab, { k: 0.07, n: 6 }), sv(F, 0.068, 0.0525 * ab, 0.0545 * ab, { k: 0.05, n: 7 }),
    sv(F, 0.09, 0.054 * ab, 0.056 * ab, { k: 0.03 }), sv(F, 0.14, 0.05 * ab, 0.051 * ab), sv(F, 0.21, 0.044 * ab, 0.045 * ab), sv(F, 0.24, 0.043 * ab, 0.044 * ab, { k: 0.02 }), sv(F, 0.245, 0.0372 * ab, 0.0382 * ab), sv(F, 0.2465, 0.0272 * ab, 0.0282 * ab),
  ];
  // sleeve stripes: two bands 3 mm proud of the sleeve's OWN section (deltoid bulge included) — as plain circles the
  // same size as the sleeve they z-fought it and broke into jagged slivers the moment the arm swung
  if (V.outfit === 'track' && !V.look) for (let i = 0; i < 2; i++) {
    const t0 = 0.05 + i * 0.09, band = [];
    for (const t of [t0, t0 + 0.015, t0 + 0.03]) {
      const [rx, ry, bg] = table([[0.045, 0.078, 0.081, dl], [0.09, 0.071, 0.074, dl * 0.55], [0.145, 0.064, 0.066, 0], [0.2, 0.060, 0.062, 0]], t);
      band.push(sv(A, t, rx * b + 0.003, ry * b + 0.003, { bulge: bg }));
    }
    parts.push({ geo: K.sh(loft(band, { segs, uv: [1, 9] })), mat: mats.shirt });
  }
  if (pr) for (const r of sleeve) { r.rx += pr; r.ry += pr; }
  parts.push({ geo: loft(sleeve, { segs, uv: [1, 11.7] }), mat: mats.jacket });
  if (V.outfit !== 'track' && !(V.look && V.top !== 'suit' && V.top !== 'blazer' && V.top !== 'apron' && V.top !== 'cardigan')) {
    parts.push({ geo: K.sh(loft([ring(F, 0.218, 0.0402 * ab, 0.0412 * ab), ring(F, 0.262, 0.0388 * ab, 0.0398 * ab), ring(F, 0.264, 0.034 * ab, 0.035 * ab), ring(F, 0.266, 0.02 * ab, 0.026 * ab)], { segs, uv: [1, 9] })), mat: mats.shirt });
    // Cuff buttons: sleeve material, 5 mm, LOD0 only. On the shoes/leather slot at 6.5 mm they caught a specular
    // brighter than anything else on the model, and in the guard pose the forearm puts that row right beside the
    // ear — the grey blob with a tail that read as a stray unlit polygon on the boss's collar.
    if (segs >= 20) for (let i = 0; i < 4; i++) {
      const t = 0.19 + i * 0.014, rr = 0.0445 * ab;
      const c = F.a.clone().addScaledVector(F.d, t).addScaledVector(F.u, sgn * (rr + 0.0005)).addScaledVector(F.v, -0.006);
      parts.push({ geo: skinGeo(button(c, F.u.clone().multiplyScalar(sgn), 0.005, 0.0022, 8), F.w), mat: mats.jacket });
    }
  }
  // steel watch: bracelet over the end of the shirt cuff, case on the outer wrist
  if (V.watch === side && mats.metal) {
    const band = [[0.2545, 0.0352], [0.2600, 0.0366], [0.2705, 0.0362], [0.2765, 0.0334]].map(([t, r]) => ring(F, t, r * ab, (r + 0.001) * ab, { shape: (a) => sellipse(a, r * ab, (r + 0.001) * ab, 2.2) }));
    parts.push({ geo: K.tint(loft(band, { segs, uv: [1, 1] }), 'metal', 0xe4e9f0), mat: mats.metal });
    const axis = F.u.clone().multiplyScalar(sgn);
    const c = F.a.clone().addScaledVector(F.d, 0.2645).addScaledVector(axis, 0.0312 * ab).addScaledVector(F.v, -0.001);
    parts.push({ geo: K.tint(skinGeo(button(c, axis, 0.0172, 0.0105, 16), F.w), 'metal', 0xeef2f8), mat: mats.metal });
    const face2 = c.clone().addScaledVector(axis, 0.0058);
    parts.push({ geo: K.tint(skinGeo(button(face2, axis, 0.0134, 0.0018, 16), F.w), 'metal', 0x252c3c), mat: mats.metal });
  }
  buildHand(K, side, H, parts, mats);
}
// hand: palm loft (3 cm thick) with a 4-lobe MCP knuckle ridge on the back + 4 three-phalanx fingers + thumb.
// fist 0..1 blends relaxed curl -> tight fist (proximal 90°, middle 100°, distal 50°; thumb wraps across the fingers).
// Its own function because the hero wears it too: the scan's hands are one decimated paddle with the finger
// separations painted on, and no amount of texture work makes a mitten read as a fist at 1.2 m.
function buildHand(K, side, H, parts, mats) {
  const V = K.V, segs = K.segs, b = V.build || 1;
  const sgn = side === 'Left' ? 1 : -1;
  const palmDir = H.u.clone().multiplyScalar(-sgn);   // palm faces the body
  const hs = 0.9 + 0.1 * b, hsegs = K.handSegs ?? Math.max(8, segs >> 1), rot = side === 'Left' ? 0 : Math.PI;   // u=0 is always the back
  const fist = (side === 'Left' ? V.fistL : V.fistR) ?? V.fist;
  // The squeeze used to pull the four finger roots to a 19 mm pitch under an 18 mm finger, so at fist 0.8 the four
  // lofts interpenetrated into one tan lump with a few scratched grooves — a mitten. 10 % squeeze over a 22 mm
  // pitch with a 16 mm finger keeps a real valley between every pair, which is what makes a fist read as knuckles.
  const sq = 1 - 0.10 * fist;
  // the hero's wrist has to meet the scan's forearm where its own hand was cut off, so his palm carries two extra
  // rings at the scanned wrist's section instead of starting at the joint
  const hl = K.handLen ?? 1;                          // the scan's own hand is 18 % shorter than the generic rig's
  // A palm is ~3 cm thick and a wrist ~4 x 3 cm. The old first rings were 5 cm thick, which is why the hand read
  // as a fat pink cylinder with the fingers stuck on the end instead of as a hand.
  const palm = (K.wristRings || []).concat([[-0.012, 0.0165, 0.0262], [0.0, 0.0172, 0.0295], [0.03, 0.0162, 0.038], [0.065, 0.0152, 0.0442], [0.088, 0.0152, 0.0465], [0.098, 0.0156, 0.0455], [0.106, 0.0118, 0.0405], [0.11, 0.004, 0.032]]);
  const pg = loft(palm.map(([t0, rx, ry]) => { const t = t0 * hl; return ring(H, t, rx * hs, ry * hs, { shape: (a) => {
    const aa = a + rot, [x, z] = sellipse(aa, rx * hs, ry * hs, 2.3);
    const back = Math.max(0, Math.cos(aa) * (side === 'Left' ? 1 : -1) * (side === 'Left' ? 1 : -1));
    const lobes = 0.5 + 0.5 * Math.cos(Math.PI * (z - 0.0115 * sq * hs) / (0.023 * sq * hs));
    const kn = (0.003 + 0.0055 * fist) * gauss(t - 0.1, 0.016) * back * back * (0.28 + 0.72 * lobes);
    return [x + kn * Math.sign(Math.cos(aa)), z];
  } }); }), { segs: hsegs, uv: [1, 1] });
  { const r = rectUV(RECT.palm); uvFit(pg, r[0], r[1], r[2], r[3]); }
  parts.push({ geo: pg, mat: mats.skin });
  // bends[] = joint angles (rad) at s = jointAt of the finger length; curl rotates dir toward curlAxis
  const finger = (base, dir0, len, r0, r1, bends, curlAxis, jointAt, uvr) => {
    const rings = [], N = 12, steps = 48;
    let p = base.clone(), d = dir0.clone();
    const pts = [p.clone()], ds = [d.clone()];
    const th = (s) => bends[0] * sstep((s - jointAt[0]) / 0.1 + 0.5) + bends[1] * sstep((s - jointAt[1]) / 0.1 + 0.5) + bends[2] * sstep((s - jointAt[2]) / 0.1 + 0.5);
    for (let i = 1; i <= steps; i++) {
      const s = i / steps, a = th(s);
      d.copy(dir0).multiplyScalar(Math.cos(a)).addScaledVector(curlAxis, Math.sin(a)).normalize();
      p.addScaledVector(d, len / steps); pts.push(p.clone()); ds.push(d.clone());
    }
    for (let j = 0; j <= N; j++) {
      const s = j / N, i = Math.round(s * steps);
      const knuckle = 1 + 0.10 * (gauss(s - jointAt[0], 0.06) + gauss(s - jointAt[1], 0.05) + 0.6 * gauss(s - jointAt[2], 0.05));
      const rr = j === N ? 0.0015 : lerp(r0, r1, s) * knuckle;
      const u = H.v.clone(), v = new THREE.Vector3().crossVectors(ds[i], u).normalize();
      if (v.dot(palmDir) < 0) v.negate();                          // palm side always at f 0.25, nail side at 0.75
      rings.push({ c: pts[i].clone().addScaledVector(ds[i], j === N ? 0.003 : 0), u, v, rx: rr, ry: rr * 0.85, w: H.w, uScale: 0.2 });
    }
    const g = loft(rings, { segs: hsegs, uv: [1, 1] });
    uvFit(g, uvr[0], uvr[1], uvr[2], uvr[3]);
    return g;
  };
  // Four identical parallel tubes of equal length with square tips is the loudest "not shipping" tell in a closeup.
  // Real proportions (index 1.00, middle 1.08, ring 0.98, little 0.78 of the index), a 6-8° resting curl that
  // differs per finger so no two are parallel, and a splay that opens as the hand relaxes.
  const FR = [1.00, 1.08, 0.98, 0.78], FCURL = [0.13, 0.10, 0.12, 0.15], FSPLAY = [0.10, 0.03, -0.04, -0.12];
  // fingers staggered down the knuckle line (the little finger sits 4 mm lower and 6 mm back) so the fist has a
  // diagonal knuckle ridge instead of a flat wall
  const fOff = [0.036, 0.0125, -0.0115, -0.035], fDrop = [0.0015, 0, 0.0015, 0.004];
  const fRad = [0.0080, 0.0083, 0.0078, 0.0070];
  for (let i = 0; i < 4; i++) {
    const bendF = [lerp(0.25 + FCURL[i], 1.55, fist), lerp(0.40 + FCURL[i] * 1.2, 1.75, fist), lerp(0.25 + FCURL[i] * 0.5, 0.85, fist)];
    const base = H.a.clone().addScaledVector(H.d, (0.1 + fDrop[i]) * hl).addScaledVector(H.v, fOff[i] * hs * sq).addScaledVector(palmDir, 0.003);
    const dir0 = H.d.clone().addScaledVector(H.v, (fOff[i] * 0.4 + FSPLAY[i] * 0.05) * (1 - fist)).normalize();
    parts.push({ geo: finger(base, dir0, 0.0752 * FR[i] * hs * hl, fRad[i] * hs, fRad[i] * 0.85 * hs, bendF, palmDir, [0.02, 0.42, 0.72], rectUV(RECT.finger(i))), mat: mats.skin });
  }
  // 4 mm knuckle ring across the MCP heads: without it the back of the hand is a smooth paddle whatever the fist
  // value, and a fist has to read at 1.2 m
  if (hsegs >= 10) {
    const kn = [];
    for (const [t, r] of [[0.086, 0.0], [0.098, 0.0032 + 0.0022 * fist], [0.110, 0.0]]) {
      kn.push(ring(H, t * hl, 0.0175 * hs, 0.047 * hs, { shape: (a) => {
        const aa = a + rot, [x, z] = sellipse(aa, 0.0175 * hs, 0.047 * hs, 2.3);
        const back = Math.max(0, Math.cos(aa) * (side === 'Left' ? 1 : -1) * (side === 'Left' ? 1 : -1));
        const lobes = 0.5 + 0.5 * Math.cos(Math.PI * z / (0.023 * hs));
        return [x + r * back * (0.3 + 0.7 * lobes) * Math.sign(Math.cos(aa)), z];
      } }));
    }
    const kg = loft(kn, { segs: hsegs, uv: [1, 1] });
    const kr = rectUV(RECT.palm); uvFit(kg, kr[0], kr[1], kr[2], kr[3]);
    parts.push({ geo: kg, mat: mats.skin });
  }
  // thumb: from the index side of the palm, folds across the front of the curled proximal phalanges (fist) / half
  // open. It is the one finger that must break the silhouette of a fist, so it sits further out on the palm.
  const tb = H.a.clone().addScaledVector(H.d, lerp(0.05, 0.062, fist) * hl).addScaledVector(H.v, 0.036 * hs).addScaledVector(palmDir, lerp(0.006, 0.013, fist));
  const tdir = H.d.clone().multiplyScalar(lerp(0.5, 0.72, fist)).addScaledVector(H.v, lerp(0.8, 0.42, fist)).addScaledVector(palmDir, lerp(0.35, 0.58, fist)).normalize();
  const taxis = H.v.clone().multiplyScalar(-0.85).addScaledVector(palmDir, 0.3).addScaledVector(H.d, 0.4).normalize();
  parts.push({ geo: finger(tb, tdir, 0.068 * hs * hl, 0.0108 * hs, 0.0086 * hs, [lerp(0.3, 0.85, fist), lerp(0.5, 1.45, fist), 0], taxis, [0.05, 0.45, 2], rectUV(RECT.finger(4))), mat: mats.skin });
}

// ---------------------------------------------------------------- legs & shoes
function buildLegs(K, parts, mats, wT) {
  const V = K.V, R = K.R, segs = K.segs, b = V.build, lb = 0.88 + 0.12 * b, ll = V.legLen || 1;
  const kind = V.outfit, belly = (V.belly || 0) + (V.gut || 0);
  // pelvis (hidden under the jacket/coat; closes the crotch) + belt with a buckle (seen through an open jacket)
  // it stays inside the shirt and the jacket skirt: at 0.20 x 0.135 it stood 1 mm proud of the jacket front at the
  // waist and 2.4 cm in front of the shirt, so every zip and every suit V showed trouser cloth down the belly
  const pelvis = [[0.80, 0.12, 0.08], [0.83, 0.166, 0.096], [0.86, 0.172, 0.094], [0.92, 0.176, 0.096], [0.98, 0.176, 0.099], [1.03, 0.170, 0.098]];
  parts.push({ geo: loft(pelvis.map(([y, rx, ry]) => yring(K.ty(y), rx * b, ry * (0.85 + 0.15 * b) + gutAt(y, belly) * 0.6, wT, { oz: 0.002 + gutAt(y, belly) * 0.5, uScale: 10 })), { segs, uv: [1, 11.7] }), mat: mats.trousers, t: 'trousers' });
  // The belt and its buckle only exist to be seen through an OPEN jacket. Lofted from the trouser waist while the
  // jacket front is closed over it, the buckle came out 1 cm proud of the garment it is supposed to live under —
  // a light-grey rectangle glued to the front of a suited pedestrian in the cast shot.
  if (kind === 'suit' && V.open) {                                // coat hides it; so does a closed jacket
    const bz = 0.85 + 0.15 * b, g1 = gutAt(1.03, belly);
    // sits on the trousers, inside the jacket (seen through the open quarters below the fastened button)
    const br = V.buttoned ? 0.99 : 1;
    parts.push({ geo: K.tint(loft([[1.01, 0.202, 0.137], [1.015, 0.206, 0.141], [1.04, 0.206, 0.141], [1.045, 0.202, 0.137]].map(([y, rx, ry]) => yring(K.ty(y), rx * br * b, ry * br * bz + g1 * 0.6, wT, { oz: 0.002 + g1 * 0.5, uScale: 4 })), { segs, uv: [1, 1] }), 'shoes', V.belt || V.shoes), mat: mats.shoes });
    const yc = K.ty(1.0275), zf = 0.002 + g1 * 1.1 + 0.141 * br * bz;
    if (mats.metal) {                                              // square silver frame buckle + prong
      const bar = (w, h, x0, y0, z0) => { const g = new THREE.BoxGeometry(w, h, 0.0055); g.translate(x0, yc + y0, zf + z0); return K.tint(skinGeo(g, wT), 'metal', V.buckle || 0xcbd0d8); };
      parts.push({ geo: bar(0.050, 0.0075, 0, 0.0155, 0.004), mat: mats.metal });
      parts.push({ geo: bar(0.050, 0.0075, 0, -0.0155, 0.004), mat: mats.metal });
      parts.push({ geo: bar(0.0075, 0.024, -0.0212, 0, 0.004), mat: mats.metal });
      parts.push({ geo: bar(0.0075, 0.024, 0.0212, 0, 0.004), mat: mats.metal });
      parts.push({ geo: bar(0.0045, 0.030, 0.006, 0, 0.0062), mat: mats.metal });
    } else {
      const buckle = new THREE.BoxGeometry(0.034, 0.03, 0.006);    // shirt material = brushed-silver read, keeps 7 draw calls
      buckle.translate(0.01, yc, zf + 0.004);
      parts.push({ geo: K.sh(skinGeo(buckle, wT)), mat: mats.shirt });
    }
  }
  const hipsW = () => [[R.index.Hips, 1]];
  // a pedestrian's bottom half (buildWardrobe's V.bottom): trousers / chinos on the tailoring slot, jeans and shorts
  // on denim, a skirt or a dress over legwear — tights on the tailoring slot, a schoolgirl's socks on poplin from
  // below the knee over a bare shin, or bare legs on the skin chart's limb strip
  const bottom = V.look ? V.bottom : null, legsOnly = bottom === 'skirt' || bottom === 'pleated' || bottom === 'none';
  for (const side of SIDES) {
    const ch = chainSegs(R, ['Hips', side + 'UpLeg', side + 'Leg', side + 'Foot', side + 'ToeBase'], 0.075);
    const U = ch[1], Lg = ch[2], F = ch[3];
    if (legsOnly) {
      const lw = V.legwear;
      if (lw === 'tights') parts.push(buildBareLeg(K, U, Lg, mats.tailor, V.legwearColor, 'suit', 0, 1, 0.0008));
      else if (lw === 'socks') { parts.push(buildBareLeg(K, U, Lg, mats.skin, null, null, 0, 0.62)); parts.push(buildBareLeg(K, U, Lg, mats.accent, V.legwearColor, 'cloth', 0.57, 1, 0.0018)); }
      else parts.push(buildBareLeg(K, U, Lg, mats.skin, null, null));
      buildShoe(K, side, F, parts, mats, Lg);
      continue;
    }
    const jeans = bottom ? (bottom === 'jeans' || bottom === 'shorts') : kind === 'track';
    // trousers hang off the thigh: straight leg, kneecap bulge, bunching behind the knee, hem breaking over the shoe (y 0.055)
    // the top rings start AT the hip joint and stay slim under the skirt (they began 3 cm above it at the full thigh
    // radius, wider than a slim build's jacket: the trouser top poked out of both flanks and the hem at every stride)
    const rows = jeans ? [
      [U, 0.0, 0.086, 0.092, 0, 0], [U, 0.06, 0.093, 0.099, 0, 0.01], [U, 0.12, 0.097, 0.103, 0, 0], [U, 0.16, 0.100, 0.106, 0, 0], [U, 0.28, 0.094, 0.100, 0, 0.01], [U, 0.38, 0.090, 0.096, 0, 0], [U, 0.43, 0.089, 0.095, 0, 0, 0.05], [U, 0.45, 0.088, 0.094, 0, 0, 0.03],
      [Lg, 0.02, 0.088, 0.095, 0, 0.02, 0.02], [Lg, 0.05, 0.089, 0.096, -0.002, 0.035], [Lg, 0.08, 0.087, 0.095, -0.002, 0.03], [Lg, 0.18, 0.086, 0.094, -0.002, 0.01], [Lg, 0.28, 0.084, 0.09, 0, 0.02], [Lg, 0.36, 0.086, 0.092, 0.004, 0.03], [Lg, 0.40, 0.088, 0.094, 0.006, 0.02], [Lg, 0.43, 0.090, 0.096, 0.004, 0], [Lg, 0.448, 0.092, 0.098, 0.006, 0.02], [Lg, 0.458, 0.088, 0.094, 0.010, 0], [Lg, 0.462, 0.066, 0.072, 0.010, 0],
    ] : [
      [U, 0.0, 0.084, 0.090, 0, 0], [U, 0.06, 0.092, 0.098, 0, 0.008], [U, 0.12, 0.094, 0.100, 0, 0], [U, 0.16, 0.096, 0.102, 0, 0], [U, 0.28, 0.088, 0.094, 0, 0.008], [U, 0.355, 0.0845, 0.0895, 0, 0, 0.015],
      [U, 0.392, 0.0865, 0.0915, 0, 0.01, 0.03], [U, 0.418, 0.0805, 0.0855, 0, 0, 0.05], [U, 0.45, 0.080, 0.085, 0, 0, 0.03],     // knee break: cloth gathers above the cap
      [Lg, 0.02, 0.080, 0.086, 0, 0.02, 0.02], [Lg, 0.05, 0.081, 0.087, -0.002, 0.03], [Lg, 0.08, 0.079, 0.086, -0.002, 0.025], [Lg, 0.18, 0.076, 0.083, -0.002, 0.008], [Lg, 0.28, 0.073, 0.079, 0, 0.015], [Lg, 0.36, 0.071, 0.077, 0.002, 0.025],
      [Lg, 0.392, 0.0748, 0.0808, 0.003, 0.03], [Lg, 0.412, 0.0700, 0.0760, 0.004, 0.012], [Lg, 0.428, 0.0740, 0.0800, 0.004, 0],
      // hem: a 12 mm band that flares over the instep and breaks 6 mm forward, so the trouser ends ON the shoe
      // instead of the leg turning into a shoe at a hard cut
      [Lg, 0.442, 0.0790, 0.0860, 0.006, 0], [Lg, 0.452, 0.0775, 0.0845, 0.011, 0], [Lg, 0.456, 0.060, 0.066, 0.011, 0],
    ];
    const crease = jeans ? 0 : 0.045;
    const trShape = (rx, ry, t, wr, kb) => (a) => {
      const [x, z] = sellipse(a, rx, ry, 2.1);
      const front = gauss(adiff(a, HPI), 0.22), back = gauss(adiff(a, -HPI), 0.3);
      let k = 1 + crease * (front + back);
      k += (kb || 0) * gauss(adiff(a, HPI), 0.5);                                            // kneecap
      k += (wr || 0) * (0.5 + 0.5 * Math.sin(a * 6 + t * 90)) * gauss(adiff(a, -HPI), 0.9);   // folds bunch at the back
      return [x * k, z * k];
    };
    // hip crease: the top of the thigh tube stays mostly on the pelvis and stretches, as cloth in a hip fold does. Rigid
    // on the femur, a stride swung its upper front 4 cm up into the belly and out through the jacket's waist
    const creaseW = (t) => blendW(U.w, hipsW, 0.75 * (1 - sstep(t / 0.14)));
    if (bottom === 'shorts') {                                      // to mid-thigh with a turned hem, then the bare leg
      const sh = rows.filter(([s, t]) => s === U && t <= 0.285).concat([[U, 0.300, 0.095, 0.101, 0, 0], [U, 0.310, 0.097, 0.103, 0, 0], [U, 0.314, 0.086, 0.092, 0, 0]]);
      parts.push({ geo: loft(sh.map(([s, t, rx, ry, oy, wr, kb]) => ring(s, t * ll, rx * lb, ry * lb, { oy, uScale: 11.7 * TAU * (rx + ry) * lb / 2, shape: trShape(rx * lb, ry * lb, t, wr, kb), w: s === U && t < 0.14 ? creaseW(t) : undefined })), { segs, uv: [1, 11.7] }), mat: mats.trousers, t: 'trousers' });
      parts.push(buildBareLeg(K, U, Lg, mats.skin, null, null, 0.30, 1));
    } else parts.push({ geo: loft(rows.map(([s, t, rx, ry, oy, wr, kb]) => ring(s, t * ll, rx * lb, ry * lb, { oy, uScale: 11.7 * TAU * (rx + ry) * lb / 2, shape: trShape(rx * lb, ry * lb, t, wr, kb), w: s === U && t < 0.14 ? creaseW(t) : undefined })), { segs, uv: [1, 11.7] }), mat: mats.trousers, t: 'trousers' });
    buildShoe(K, side, F, parts, mats, Lg);
  }
}
// sole / midsole value: always a real step down from the upper (0.38x), whatever the variant asked for. A shipped
// dress shoe never has its sole within 5 % of its upper, and that step is the whole reason a shoe reads as a shoe.
const _sc1 = new THREE.Color(), _sc2 = new THREE.Color();
function soleTint(V) {
  _sc1.set(V.shoes);
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (V.sole != null) { _sc2.set(V.sole); if (lum(_sc2) <= lum(_sc1) * 0.55) return V.sole; }
  return _sc1.setRGB(_sc1.r * 0.36, _sc1.g * 0.37, _sc1.b * 0.42).getHex();
}
// shoe: sole slab (superellipse, welted, matte rubber) with a stepped heel, upper starting 1 cm inside the sole,
// toe-cap seam; sneaker = chunky uniform sole, tongue strip + lace bars. Rings perpendicular to z around the foot bone.
function buildShoe(K, side, F, parts, mats, Lg = null) {
  const V = K.V, segs = K.segs, kind = V.outfit;
  {
    // a pedestrian names the shoe (V.shoeKind: dress / sneaker / pump / flat / boot); the cast infers it from the outfit
    const sk = V.shoeKind || (kind === 'track' ? 'sneaker' : 'dress');
    const sneaker = sk === 'sneaker', heel = sk === 'pump' ? 0.026 : 0, boot = sk === 'boot';
    const sx = F.a.x, fy = F.a.y - 0.08;    // fy: foot joint offset from the default (legLen)
    const toeA = (K.stance ? K.stance.toe[side === 'Left' ? 0 : 1] : 0) * (side === 'Left' ? 1 : -1);
    const cT = Math.cos(toeA), sT = Math.sin(toeA), uAx = new THREE.Vector3(cT, 0, -sT);   // shoe yawed about the ankle
    const wShoe = (p) => F.w(p);
    // The sneaker used to be one 2.6 cm slab in the same off-white as the upper, so the navy trouser cylinder just
    // stopped and a flesh-pink egg began on a flat circular seam. Now: a wedge midsole (3.0 cm at the heel, 1.9 at
    // the toe) in its own dark rubber, a toe bumper and a collar band at the ankle — three value breaks.
    // a pump adds a 2.6 cm block under the dress shoe's own stepped heel
    const soleTh = (z) => (sneaker ? lerp(0.030, 0.019, sstep((z + 0.06) / 0.20)) : lerp(0.012, 0.028, sstep((-z - 0.005) / 0.035))) + heel * sstep((-z - 0.02) / 0.04);
    if (boot && Lg) {                                   // ankle boot: the shaft climbs 8 cm up the shin over the leg
      const sh = [[0.086, 0.0505, 0.0565], [0.100, 0.0480, 0.0540], [0.125, 0.0462, 0.0522], [0.150, 0.0462, 0.0522], [0.164, 0.0470, 0.0530], [0.167, 0.0400, 0.0460]];
      const rings = sh.map(([y, rx, ry]) => ({ c: new THREE.Vector3(sx, y + fy, -0.026), u: X_AXIS, v: Z_AXIS, rx, ry, w: blendW(wShoe, Lg.w, sstep((y - 0.095) / 0.05)), uScale: 0.3, shape: (a) => sellipse(a, rx, ry, 2.2) }));
      parts.push({ geo: K.tint(loft(rings, { segs: Math.max(12, segs * 0.75 | 0), uv: [1, 1] }), 'shoes', V.shoes), mat: mats.shoes });
    }
    const up = sneaker
      ? [[-0.085, 0.072, 0.03], [-0.07, 0.088, 0.042], [-0.03, 0.10, 0.048], [0.0, 0.104, 0.05], [0.04, 0.096, 0.051], [0.08, 0.08, 0.052], [0.12, 0.066, 0.051], [0.16, 0.054, 0.048], [0.20, 0.042, 0.04], [0.23, 0.03, 0.027], [0.245, 0.02, 0.008]]
      : [[-0.085, 0.06, 0.026], [-0.072, 0.078, 0.039], [-0.03, 0.09, 0.046], [0.0, 0.094, 0.047], [0.04, 0.084, 0.048], [0.08, 0.07, 0.049], [0.12, 0.056, 0.048], [0.145, 0.048, 0.047], [0.155, 0.046, 0.046], [0.16, 0.044, 0.045], [0.20, 0.032, 0.038], [0.235, 0.022, 0.025], [0.256, 0.014, 0.007]];
    const sring = (z, cy, rx, ry, exp, uS, shape) => ({ c: new THREE.Vector3(sx + z * sT, cy + fy, z * cT), u: uAx, v: Y_AXIS, rx, ry, w: wShoe, uScale: uS, shape });
    const upper = up.map(([z, top, rx], j) => {
      const bot = soleTh(z) - 0.01, cy = (top + bot) / 2, ry = Math.max(0.002, (top - bot) / 2), cap = !sneaker && j >= 8 && j <= 9 ? 0.0015 : 0;
      return sring(z, cy, rx, ry, 2.2, 0.3, (a) => { const [x, y] = sellipse(a, rx + cap, ry + cap, Math.sin(a) < 0 ? 5 : 2.2); return [x, y]; });
    });
    parts.push({ geo: K.tint(loft(upper, { segs: Math.max(12, segs * 0.75 | 0), uv: [1, 1] }), 'shoes', V.shoes), mat: mats.shoes });
    // The sole was authored 0x1d1a16 against an 0x241f19 upper — a 4 % step, so every dress shoe read as one black
    // lozenge. The sole slot now takes 0.38x the upper's own value (it costs nothing: it rides the vertex colour)
    // and stands 8 mm proud of the upper instead of 4, so the welt makes a silhouette at 4 m.
    const soleHex = soleTint(V);
    const welt = sneaker ? 0.006 : 0.008;
    const soleZ = [-0.092, -0.085, -0.06, -0.04, -0.02, 0.0, 0.03, 0.06, 0.1, 0.14, 0.18, 0.21, 0.235, 0.25, 0.262];
    const sole = soleZ.map((z, j) => {
      const th = soleTh(z), rx0 = table(up.map(([zz, , rr]) => [zz, rr]), z)[0];
      const rx = (j === 0 || j === soleZ.length - 1) ? 0.004 : rx0 + welt;
      return sring(z, th / 2, rx, th / 2, 6, 0.3, (a) => sellipse(a, rx, th / 2, 6));
    });
    parts.push({ geo: K.tint(loft(sole, { segs: Math.max(12, segs * 0.75 | 0), uv: [1, 1] }), 'shoes', soleHex), mat: mats.sole });
    if (sneaker) {
      // midsole band: the pale foxing strip that separates the upper from the outsole on any real sneaker
      const mid = soleZ.map((z, j) => {
        const th = soleTh(z), rx0 = table(up.map(([zz, , rr]) => [zz, rr]), z)[0];
        const rx = (j === 0 || j === soleZ.length - 1) ? 0.005 : rx0 + welt + 0.0015;
        return sring(z, th - 0.0035, rx, 0.0055, 6, 0.3, (a) => sellipse(a, rx, 0.0055, 5));
      });
      parts.push({ geo: K.tint(loft(mid, { segs: Math.max(12, segs * 0.75 | 0), uv: [1, 1] }), 'shoes', V.midsole || 0xa8a296), mat: mats.sole });
      const toeZ = [0.175, 0.205, 0.235, 0.252];                                    // rubber toe bumper
      const toe = toeZ.map((z, j) => { const th = soleTh(z), rx0 = table(up.map(([zz, , rr]) => [zz, rr]), z)[0] + welt + 0.001, top = table(up.map(([zz, t]) => [zz, t]), z)[0];
        const cy = (top * 0.62 + th) / 2, ry = Math.max(0.003, (top * 0.62 - th) / 2 + 0.004), rx = j === toeZ.length - 1 ? 0.006 : rx0;
        return sring(z, cy, rx, ry, 2.4, 0.3, (a) => sellipse(a, rx, ry, 2.4)); });
      parts.push({ geo: K.tint(loft(toe, { segs: Math.max(10, segs >> 1), a0: HPI - 1.5, a1: HPI + 1.5, uv: [1, 1] }), 'shoes', soleHex), mat: mats.sole });
      const tongue = [[0.02, 0], [0.03, 0.003], [0.11, 0.003], [0.125, 0.0]].map(([z, pr]) => { const [, top, rx] = table(up.map(([zz, t, r]) => [zz, t, r]), z).length ? [0, ...table(up.map(([zz, t, r]) => [zz, t, r]), z)] : [0, 0.08, 0.05]; const bot = soleTh(z) - 0.01, cy = (top + bot) / 2, ry = (top - bot) / 2; return sring(z, cy, rx, ry, 2.2, 0.3, (a) => sellipse(a, rx + pr, ry + pr, 2.2)); });
      parts.push({ geo: K.tint(loft(tongue, { segs: 6, a0: HPI - 0.55, a1: HPI + 0.55, uv: [1, 1] }), 'shoes', V.midsole || 0xa8a296), mat: mats.sole });
      for (const z of [0.045, 0.075, 0.105]) { const [top] = table(up.map(([zz, t]) => [zz, t]), z); const lace = new THREE.BoxGeometry(0.03, 0.0035, 0.007); lace.rotateY(toeA); lace.translate(sx + z * sT, top + 0.004 + fy, z * cT); parts.push({ geo: K.tint(skinGeo(lace, wShoe), 'shoes', soleHex), mat: mats.sole }); }
      { const col = [[-0.085, 0.072], [-0.062, 0.090], [-0.03, 0.100], [0.005, 0.104]].map(([z, top]) => {   // padded ankle collar
          const rx = table(up.map(([zz, , rr]) => [zz, rr]), z)[0] + 0.002;
          return sring(z, top - 0.009, rx, 0.009, 2.2, 0.3, (a) => sellipse(a, rx, 0.009, 2.2));
        });
        parts.push({ geo: K.tint(loft(col, { segs: Math.max(10, segs >> 1), a0: HPI + 0.6, a1: HPI + TAU - 0.6, uv: [1, 1] }), 'shoes', soleHex), mat: mats.sole }); }
    }
  }
}
// The skull WITHOUT the face: the same superellipse the head loft starts from, before the nose, brow, sockets,
// cheekbones and mouth are added to it. Anything that sits ON a face rather than being part of one (shades, and
// their frame) has to be placed against this, or it follows the eye socket down into the hole it is meant to cover.
function skullPoint(a, yh, P, extra = 0) {
  const t = table(HEAD_ROWS, yh), hk = P.headK || 1;
  const F = t[0] * HEAD_K * hk, B = t[1] * HEAD_K * hk;
  const S = t[2] * HEAD_K * hk * (1 + (P.jaw - 1) * gauss(yh - (P.jawY ?? 0.035), 0.022));
  const ca = Math.cos(a), sa = Math.sin(a);
  const Rz = sa > 0 ? F : B, p = 2 + (P.jawSq ?? 0.7) * P.jaw * gauss(yh - 0.04, P.jawSpread ?? 0.03);
  const r = Math.pow(Math.pow(Math.abs(ca) / S, p) + Math.pow(Math.abs(sa) / Rz, p), -1 / p) + extra;
  return [r * ca, r * sa + t[3]];
}
// a 2-3 mm section swept along a path, framed off the outward direction from `ref` so the blade of a temple arm
// stays vertical all the way round the skull. `closed` joins the last point back to the first (the lens rim).
function tubeAlong(pts, rx, ry, w, closed, ref) {
  const n = pts.length, rings = [], _T = new THREE.Vector3();
  for (let i = 0; i < n + (closed ? 1 : 0); i++) {
    const k = i % n, p = pts[k];
    const a = closed ? pts[(k - 1 + n) % n] : pts[Math.max(k - 1, 0)];
    const b = closed ? pts[(k + 1) % n] : pts[Math.min(k + 1, n - 1)];
    _T.subVectors(b, a).normalize();
    const N = new THREE.Vector3().subVectors(p, ref).normalize();
    const B = new THREE.Vector3().crossVectors(_T, N).normalize();
    N.crossVectors(B, _T).normalize();
    rings.push({ c: p.clone(), u: B, v: N, rx, ry, w });
  }
  return loft(rings, { segs: 8, uv: [1, 1] });
}
// Smoked glass. Its own draw call (one per cast, and only the yakuza wears them) because a lens is the one chart on
// a head that has to be near-black AND a mirror: on the shoe slot it was a matte charcoal rectangle.
let lensMat = null;
function lensMaterial() {
  if (lensMat) return lensMat;
  lensMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0b0f, roughness: 0.10, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide, name: 'lens' });
  envTrack(lensMat, 2.4);
  charShader(lensMat, { hemi: 0.45, gnd: 0.35, key: 1.05, rim: 1.7, aa: [0.055, 0.055] });
  return lensMat;
}
// lens space: f 0..1 from the nose side to the temple, h -1..1 bottom to top. The stand-off is a bell centred on the
// nose — 15 mm over the bridge (which clears the ridge AND the brow), 6 mm at the eye, 4 mm at the temple, so the
// glasses sit on the face the way a frame does instead of being inset into the sockets.
const GLASS_D = [0.150, 1.010];
function glassSurf(P, s, f, h) {
  const d = lerp(GLASS_D[0], GLASS_D[1], f);
  const yh = lerp(0.1378, 0.1405, f) + h * lerp(0.0196, 0.0152, f);
  const [x, z] = skullPoint(HPI + s * d, yh, P, 0.0038 + 0.0115 * gauss(d, 0.22));
  return [x, z, yh];
}
// Two flat boxes on the brow with a 3 mm bar between them read as an alien's eye slabs at any crop under 3 m, and
// they were the worst thing in `character_lineup`. Real shades: a smoked lens laid on the skull as a curved patch,
// a rim tube around its outline, a bridge arching over the nose and temple blades that run back OVER the ear and
// hook down behind it. Rim/bridge/temples ride the shoe slot's vertex colour, so only the glass costs a draw call.
function buildSunglasses(K, wHead, parts, mat) {
  const P = K.V, cy = K.chinY, cz = K.headZ, lensM = lensMaterial();
  const V3 = (p) => new THREE.Vector3(p[0], cy + p[2], cz + p[1]);
  const EXP = 2.7;
  for (const s of [-1, 1]) {
    const rings = [0.03, 0.34, 0.60, 0.80, 0.93, 1.0].map((k) => ({
      c: new THREE.Vector3(0, cy, cz), u: X_AXIS, v: Z_AXIS, n: Y_AXIS, rx: 0, ry: 0, w: wHead, vv: k,
      shape: (a) => { const [cf, ch] = sellipse(a, 1, 1, EXP); return glassSurf(P, s, 0.5 + 0.5 * cf * k, ch * k); },
    }));
    parts.push({ geo: loft(rings, { segs: 18, uv: [1, 1] }), mat: lensM });
    const ref = new THREE.Vector3(0, cy + 0.138, cz);
    const rim = [];
    for (let i = 0; i < 24; i++) { const [cf, ch] = sellipse((i / 24) * TAU, 1, 1, EXP); rim.push(V3(glassSurf(P, s, 0.5 + 0.5 * cf, ch))); }
    parts.push({ geo: K.tint(tubeAlong(rim, 0.0026, 0.0021, wHead, true, ref), 'shoes', 0x0d0d11), mat });
    // temple: hinge at the outer corner, then a blade that stays at brow height (above the ear, never through it)
    // and drops behind it. Each row is [angle from front, height above the chin, stand-off].
    const arm = [[1.010, 0.1420, 0.0040], [1.30, 0.1500, 0.0048], [1.60, 0.1535, 0.0060], [1.90, 0.1520, 0.0060], [2.05, 0.1420, 0.0052], [2.15, 0.1270, 0.0044]]
      .map(([d, yh, off]) => { const [x, z] = skullPoint(HPI + s * d, yh, P, off); return new THREE.Vector3(x, cy + yh, cz + z); });
    parts.push({ geo: K.tint(tubeAlong(arm, 0.0042, 0.0016, wHead, false, new THREE.Vector3(0, cy + 0.145, cz)), 'shoes', 0x0d0d11), mat });
  }
  const bridge = [];
  for (let i = 0; i <= 8; i++) {
    const d = -0.150 + 0.300 * (i / 8), yh = 0.1530 - 0.0035 * gauss(d, 0.085);
    const [x, z] = skullPoint(HPI + d, yh, P, 0.0038 + 0.0115 * gauss(Math.abs(d), 0.22));
    bridge.push(new THREE.Vector3(x, cy + yh, cz + z));
  }
  parts.push({ geo: K.tint(tubeAlong(bridge, 0.0021, 0.0021, wHead, false, new THREE.Vector3(0, cy + 0.150, cz)), 'shoes', 0x0d0d11), mat });
}
// ---------------------------------------------------------------- variants
// colours are final albedo (sRGB): the library's cloth/leather maps are normalised to them in mat()
export const VARIANTS = {
  // 渋沢 健人 — 42, 1.82 m. Near-black charcoal wool two-piece worn buttoned, white shirt, wide navy satin tie,
  // navy pocket square, dark brown belt with a silver buckle, steel bracelet watch on the LEFT wrist and the
  // attaché in the LEFT hand (docs/HERO.md, corrected against the supplied model), black plain-toe shoes.
  // These fields drive the PROCEDURAL fallback; when the scan loads he wears his own.
  kento:      { scale: HERO_HEIGHT / 1.8, build: 1.09, jaw: 1.13, jawY: 0.075, jawSq: 1.2, jawSpread: 0.05, chinTaper: 0.17, brow: 1.2, nose: 1.14, chin: 1.14, cheek: 1.05, neck: 1.10, fist: 0.25, fistL: 0.8, fistR: 0.42, nlf: 1,   // the case hand closes on the handle, the free hand hangs
                displayName: { ja: '渋沢 健人', en: 'SHIBUSAWA KENTO' },
                // skin: the mean albedo of the SCAN's own cheek charts, re-measured off the raw atlas (sRGB
                // 158/114/94 at the cheek band). Only the fallback body paints with it now — the scan carries its
                // own hands and face (see stripHands).
                hair: 'kento', hairColor: 0x2e2620, hairDim: 0.82, greyHair: 0x7d7468, greyAmt: 0.62, skin: [158, 114, 94], stubble: 0.8, beard: 1, browW: 0.72, browAngle: 0.55, age: 0.5, hires: true, lip: [128, 84, 76], lipA: 0.72,
                shoulderW: 1.13, deltoid: 0.10, torsoLen: 1.0, legLen: 1.0, gut: 0, posture: 0,
                outfit: 'suit', suit: 0x1c1e23, shirt: 0xcfccc5, accent: 0x18294a, chiefColor: 0x1b2c4c, shoes: 0x241f19, sole: 0x1d1a16, belt: 0x4a3324, buckle: 0xd2d8e2,
                tie: true, knitTie: false, buttoned: false, chief: true, watch: 'Left', vc: true, shirtVC: true, eyeMat: true },
  // every variant carries eyeMat: the real eyeball (clearcoat 1 / roughness 0.05, own catchlight) is what stops a
  // face reading as painted-on almonds under a hundred neon signs. It is built at LOD0 only — see buildBody.
  // Proportions carry the casting, not the colour: a tout is short and stocky, a host tall and narrow, an enforcer
  // heavy. Height 1.62-1.92 across the cast, shoulders ±18 %, torso/leg ratio ±12 %, and `belly` moves the torso loft
  // itself so a heavy man is heavy in silhouette and not just in his jacket colour.
  yakuza:     { scale: 1.035, build: 1.02, jaw: 1.0, chinTaper: 0.11, brow: 1.0, nose: 1.05, chin: 1.0, cheek: 1.1, neck: 1.05, fist: 0.8, hair: 'slick', hairColor: 0x23201e, skin: [172, 128, 106], stubble: 0.35, browW: 0.6, browAngle: 0.6, age: 0.4,
                shoulderW: 1.06, torsoLen: 0.96, legLen: 1.06, gut: 0, posture: 0,
                outfit: 'suit', suit: 0x212129, shirt: 0x2c2c34, accent: 0x9aa0aa, shoes: 0x312d27, sole: 0x151311, tie: true, sunglasses: true, vc: true, shirtVC: true, eyeMat: true },
  chinpira:   { scale: 0.925, build: 0.88, jaw: 0.92, chinTaper: 0.14, brow: 0.8, nose: 0.95, chin: 0.9, cheek: 0.8, neck: 0.92, fist: 0.85, hair: 'spiky', hairColor: 0xd9bc6a, skin: [192, 152, 128], stubble: 0.1, browW: 0.4, browAngle: 0.4, age: 0,
                shoulderW: 0.84, torsoLen: 1.06, legLen: 0.91, gut: 0.015, posture: 0.016,
                outfit: 'track', suit: 0xd82a8a, shirt: 0xf0f0ea, trousers: 0x3a4a78, shoes: 0xe8e4da, sole: 0x322e2a, midsole: 0xa39e92, hood: true, vc: true, shirtVC: true, eyeMat: true },
  boss:       { scale: 1.055, build: 1.18, jaw: 1.15, chinTaper: 0.10, brow: 1.2, nose: 1.1, chin: 1.1, cheek: 1.1, neck: 1.2, fist: 0.8, hair: 'longslick', hairColor: 0x3a3430, skin: [166, 122, 100], stubble: 0.4, browW: 0.9, browAngle: 0.8, age: 0.8, scar: true,
                shoulderW: 1.20, torsoLen: 1.05, legLen: 0.94, gut: 0.05, belly: 0.03, posture: -0.008,
                outfit: 'coat', suit: 0x2c2523, trousers: 0x2a2a30, shirt: 0x7a1e26, accent: 0x2e2e33, shoes: 0x312d27, sole: 0x151311, tie: true, vc: true, shirtVC: true, eyeMat: true },
  pedestrian: { scale: 1.0, build: 1.0, jaw: 1.0, chinTaper: 0.12, brow: 1.0, nose: 1.0, chin: 1.0, cheek: 1.0, neck: 1.0, fist: 0.15, hair: 'ped', hairColor: 0x1a1410, skin: [180, 138, 114], stubble: 0, browW: 0.6, browAngle: 0.2, age: 0.2,
                shoulderW: 1.0, torsoLen: 1.0, legLen: 1.0, gut: 0, posture: 0,
                outfit: 'suit', suit: 0x3a3d48, shirt: 0xdedad2, accent: 0x404050, shoes: 0x312d27, sole: 0x151311, tie: true, vc: true, shirtVC: true, eyeMat: true },
};
VARIANTS.kiryu = VARIANTS.kento;                        // legacy alias (player.js / enemy.js / crowd.js)
// The client's four street scans. `scan` names the asset under assets/mobs/; everything else is a fallback
// used only if that asset fails to load, so a missing file downgrades to a procedural body instead of a hole.
for (const [key, base, name] of [
  ['enforcer_a', 'chinpira', { ja: '鉄パイプの男', en: 'ENFORCER' }],
  ['enforcer_b', 'yakuza', { ja: '杖の兄貴', en: 'ENFORCER II' }],
  ['wanderer', 'chinpira', { ja: 'フードの若造', en: 'WANDERER' }],
  ['nightlife_king', 'boss', { ja: '夜の王', en: 'NIGHTLIFE KING' }],
]) VARIANTS[key] = { ...VARIANTS[base], scan: key, displayName: name };
// 柊 誠司 (docs/STORY.md cast), the client's Meshy model (docs/ref/hiiragi-model.glb, built by
// assets/hero/pipeline/v2/buildScan.mjs): white two-piece, black open shirt, long swept-back hair, rimless glasses (on
// the Head bone, rigidly: rigidHead). Loaded after boot, not awaited — castScansReady('hiiragi') before a scene that
// shows him (a body built before that is the procedural fallback below, in white). Story: missions npcFor with
// variant 'hiiragi'; a fight: enemy.spawn(type, at, { variant: 'hiiragi', ownClothes: true }).
VARIANTS.hiiragi = { ...VARIANTS.yakuza, scan: 'hiiragi', cast: true, castHeight: 1.80, groundLift: 0.009,   // (soles 0.6-1.8 cm under in idle / talk / jab)
  suit: 0xe4e0da, shirt: 0x141416, sunglasses: false,
  hair: 'longslick', hairColor: 0x121010, displayName: { ja: '柊 誠司', en: 'HIIRAGI SEIJI' } };
// The "fight club" trio (client, 2026-09-26: 「ファイトクラブ三名のイメージアップロードしたから、ゲーム内に登場させて」), the
// client's Meshy models built like 柊 (assets/hero/pipeline/v2/buildScan.mjs -> assets/mobs/club_*). Story NPCs
// (missions npcFor { variant: 'club_miku' } …) and fighters (enemy.spawn('chinpira', at, { variant, persona, name,
// ownClothes: true, aggro: true }); personas miku 'guard', kai 'brute', tenma 'coward'). Fallback: the procedural tout.
for (const [key, h, lift, name] of [
  // (groundLift: the soles measured 1.0-2.4 cm under the ground in idle / the stance / a jab — thick Meshy soles on the
  // rig's 8 cm ankle; assets/hero/pipeline/v2/probe.mjs club)
  ['club_miku', 1.78, 0.012, { ja: '朝比奈 未空', en: 'ASAHINA MIKU' }],        // black tee, black trousers, sunglasses
  ['club_kai', 1.80, 0.011, { ja: '朝比奈 快', en: 'ASAHINA KAI' }],            // denim shirt-jacket, white tee, jeans
  ['club_tenma', 1.74, 0.018, { ja: '那珂川 天真', en: 'NAKAGAWA TENMA' }],     // bleached spikes, white tee, cargo trousers
]) VARIANTS[key] = { ...VARIANTS.chinpira, scan: key, cast: true, castHeight: h, groundLift: lift, displayName: name };
// Per-scan GAIT (1 = the clips as authored): the legs' swing is scaled by it about the clip's own neutral stance, the
// hips' travel with it (their drop by its square, so a straighter stance leg does not push the foot through the
// street). A long robe cannot take the hero's 2.4 m/s stride without stretching into a sheet between the feet, and in
// a thobe nobody walks like that anyway: short steps. gaitPose(h) applies it; crowdScan.js calls it on every pose it
// bakes or plays (its planted-foot stride measurement then shortens the stride to match, so nothing slides).
// { walk, run } per scan (a number is both): the long thobe takes half the stride; the knock-kneed schoolgirl a little
// less than the authored walk and a trot for a run (her skirt's hem, fused to both thighs, is what a full run tears).
const PED_GAIT = { high_school_student_5828: { walk: 0.82, run: 0.65 }, wandering_photographe_5203: { walk: 0.5, run: 0.5 }, thoughtful_schoolgirl_5927: { walk: 0.7, run: 0.3 } };
// The client's 19 PASSERS-BY (docs/PEDS.md): every pedestrian in the game is one of these people. Built offline by
// assets/peds/pipeline/buildPed.mjs at the rig's own 1.82 m (so every clip lands on its joints) and scaled to the
// person's real height here. `height` is shoes-and-hair standing height in metres.
export const PED_SCANS = [
  ['formal_portrait_4019', 1.74, false, 'adult', 'salaryman'],
  ['smiling_businesswoman_4044', 1.62, true, 'adult', 'office'],
  ['modern_office_profess_4034', 1.75, false, 'adult', 'office'],
  ['confident_professiona_5856', 1.76, false, 'adult', 'salaryman'],
  ['confident_professiona_5913', 1.77, false, 'adult', 'salaryman'],
  ['confident_modern_gent_4727', 1.73, false, 'senior', 'gentleman'],
  ['silver_noir_swagger_4736', 1.76, false, 'adult', 'host'],
  ['man_in_black_casual_o_5836', 1.78, false, 'adult', 'casual'],
  ['anime_inspired_street_0039', 1.58, true, 'student', 'otaku'],
  ['elegant_night_out_4745', 1.63, true, 'adult', 'nightlife'],
  ['evening_walk_in_the_c_4029', 1.71, false, 'student', 'casual'],
  ['high_school_student_5828', 1.57, true, 'student', 'schoolgirl'],
  ['thoughtful_schoolgirl_5927', 1.58, true, 'student', 'schoolgirl'],
  ['casual_student_portra_4103', 1.70, false, 'student', 'student'],
  ['confident_young_stude_4122', 1.72, false, 'student', 'schoolboy'],
  ['smiling_student_with_4700', 1.59, true, 'student', 'student'],
  ['scholar_s_path_4057', 1.60, true, 'student', 'schoolgirl'],
  ['wanderlust_explorer_4828', 1.66, true, 'adult', 'tourist'],
  ['ready_for_the_trail_4758', 1.78, false, 'adult', 'tourist'],
  // round 2 (2026-09-25): 「これらの人たちも通行人として、追加ください」
  ['confident_business_pr_5909', 1.65, true, 'adult', 'office'],
  ['confident_professiona_5901', 1.77, false, 'adult', 'salaryman'],
  ['confident_professiona_0118', 1.74, false, 'adult', 'salaryman'],
  ['mexican_traveler_5850', 1.85, false, 'adult', 'tourist'],
  ['wandering_photographe_5203', 1.79, false, 'adult', 'tourist'],
].map(([key, height, fem, age, role]) => ({ key, variant: 'ped_' + key, height, fem, age, role, gait: PED_GAIT[key] || null }));
// a ped variant is its scan and nothing else: the pedestrian fields are only what a failed load falls back to, and the
// crowd must not show that (pedScanReady / pedScansReady)
for (const p of PED_SCANS) VARIANTS[p.variant] = { ...VARIANTS.pedestrian, scan: p.variant, ped: p.key, pedHeight: p.height, fem: p.fem, gait: p.gait, displayName: null };
const GAIT_LEGS = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];
// scale the legs' pose about the clip's neutral (the rig's rest: legs plumb) by h.gait, after the mixer has written it.
// The factor is the walk's, or the run's while a run clip carries the weight (read off the mixer's running actions, as
// crowdScan.js blends them); `clip` names it outright for a single posed clip.
// Keep the soles and head fixed while redistributing 8 cm from torso to legs.
function studentBodyY(y) {
  if (y <= 0.08 || y >= 1.52) return y;
  return y + 0.08 * (y <= 0.98 ? (y - 0.08) / 0.90 : (1.52 - y) / 0.54);
}
// 2026-09-28 (client: 「みんな短足なので、通行人の足を長くして」): every other passer-by's legs are longer. Built at the
// rig's 1.82 m, the scans all stood on the same joint heights (hip joints 0.955, knees 0.50: 52 % of the crown, the
// average adult, which the street read as short-legged). PED_LEGS stretches the legs between the ankle (y0, so no
// shoe grows) and the crotch (y1) by dL, and takes dT of it back from the torso between t0 and t1 (the waist to the
// chest): the hip joints at 0.55 of the crown instead of 0.52, the crotch / a skirt's hem at ~0.50. The person keeps
// the height PED_SCANS gives (V.scale divides by the longer crown), so the head and torso read a little smaller.
// Each vertex moves by its bones: a leg bone's share by the stretch at its height, the pelvis / spine share by the
// torso field (a skirt, a coat's hem, a bag on the hip ride up with the pelvis, whole), the neck, head, shoulders and
// arms by the shift at the shoulder line (arms, hands and what they hold keep their length). The Hips JOINT stays at
// the clips' 0.98: the pelvis bone's origin is where every clip's Hips.position track puts it, and the hip joints,
// the spine and everything above sit dL higher off it, so every clip (walk, idle, story poses, bus rides) stands on
// the ground unchanged with no per-clip pelvis offset. (high_school_student_5828 keeps her own redistribution above.)
export const PED_LEGS = { dL: 0.085, dT: 0.025, y0: 0.09, y1: 0.84, t0: 1.00, t1: 1.45 };
const PL = PED_LEGS, PL_E = PL.dL / (PL.y1 - PL.y0), PL_C = PL.dT / (PL.t1 - PL.t0);
const legField = (y) => (y <= PL.y0 ? 0 : y >= PL.y1 ? PL.dL : PL_E * (y - PL.y0));                          // leg bones
const torsoField = (y) => PL.dL - (y <= PL.t0 ? 0 : y >= PL.t1 ? PL.dT : PL_C * (y - PL.t0));               // pelvis / spine
const legStretch = (y) => (y > PL.y0 && y < PL.y1 ? 1 + PL_E : 1), torsoStretch = (y) => (y > PL.t0 && y < PL.t1 ? 1 - PL_C : 1);
const PED_LEG_BONES = new Set(['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase']);
const PED_TORSO_BONES = new Set(['Hips', 'Spine', 'Spine1', 'Spine2']);
// how far a joint of that bone moves up, and the crown with it (V.scale)
const pedJointDY = (name, y) => (name === 'Hips' ? 0 : PED_LEG_BONES.has(name) ? legField(y) : PED_TORSO_BONES.has(name) ? torsoField(y) : PL.dL - PL.dT);
const pedLong = (key) => key !== 'high_school_student_5828';
// how far the pelvis's mesh sits above the Hips joint's bind (rig metres): what a seat carries is that much higher
// (crowdScan.js bakes the bus_sit anchor there)
const pedPelvisUp = (key) => (pedLong(key) ? PL.dL : studentBodyY(0.98) - 0.98);
function pedJoints(key, joints) {
  // (the student: her redistribution, the Hips joint held at the clips' 0.98 all the same)
  if (!pedLong(key)) return Object.fromEntries(Object.entries(joints).map(([name, p]) => [name, [p[0], name === 'Hips' ? p[1] : studentBodyY(p[1]), p[2]]]));
  return Object.fromEntries(Object.entries(joints).map(([name, p]) => [name, [p[0], p[1] + pedJointDY(name, p[1]), p[2]]]));
}
// the remapped positions / normals of one scan part, per scan and part (every body of that person shares them)
const PED_LONG_GEO = new Map();
function pedLongGeo(geo, key, part) {
  const ck = key + ':' + part;
  let c = PED_LONG_GEO.get(ck);
  if (!c) {
    const P = geo.attributes.position, N = geo.attributes.normal, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, n = P.count;
    const pos = new Float32Array(n * 3), nrm = N ? new Float32Array(n * 3) : null;
    for (let i = 0; i < n; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      let dy = 0, sy = 0, ws = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k); if (!(w > 0)) continue;
        const b = BONE_NAMES[si.getComponent(i, k)];
        if (PED_LEG_BONES.has(b)) { dy += w * legField(y); sy += w * legStretch(y); }
        else if (PED_TORSO_BONES.has(b)) { dy += w * torsoField(y); sy += w * torsoStretch(y); }
        else { dy += w * (PL.dL - PL.dT); sy += w; }
        ws += w;
      }
      if (ws > 0) { dy /= ws; sy /= ws; } else sy = 1;
      pos[i * 3] = x; pos[i * 3 + 1] = y + dy; pos[i * 3 + 2] = z;
      // a vertical stretch by sy turns the normal by the inverse transpose: (nx, ny / sy, nz)
      if (nrm) { const a = N.getX(i), b = N.getY(i) / sy, d = N.getZ(i), l = Math.hypot(a, b, d) || 1; nrm[i * 3] = a / l; nrm[i * 3 + 1] = b / l; nrm[i * 3 + 2] = d / l; }
    }
    PED_LONG_GEO.set(ck, c = { pos, nrm });
  }
  geo.setAttribute('position', new THREE.BufferAttribute(c.pos, 3));
  if (c.nrm) geo.setAttribute('normal', new THREE.BufferAttribute(c.nrm, 3));
  geo.computeBoundingBox(); geo.computeBoundingSphere();
}
export function gaitPose(h, gait = h && h.gait, clip = null) {
  if (!h || !gait) return;
  const gw = typeof gait === 'number' ? gait : gait.walk || 1, gr = typeof gait === 'number' ? gait : gait.run || gw;
  let g = gw;
  if (gr !== gw) {
    if (clip) g = clip === 'run' ? gr : gw;
    else {
      let wr = 0, wt = 0;
      for (const a of h.mixer._actions || []) { if (!a.isRunning()) continue; const w = a.getEffectiveWeight(); if (!(w > 0)) continue; wt += w; if (a.getClip().name === 'run') wr += w; }
      if (wt > 0) g = gw + (gr - gw) * (wr / wt);
    }
  }
  if (!(g > 0 && g < 1)) return;
  const B = h.bones;
  for (const n of GAIT_LEGS) if (B[n]) B[n].quaternion.slerp(RIG.local[n].quaternion, 1 - g);
  const hp = B.Hips.position, r = RIG.local.Hips.position;
  hp.x = r.x + (hp.x - r.x) * g; hp.z = r.z + (hp.z - r.z) * g; hp.y = r.y + (hp.y - r.y) * g * g;
}
// 30 % toward their own luminance (fix round 1): at full chroma a track top was the loudest thing in any frame
const CHINPIRA_JACKETS = [0xb1377a, 0xd7c767, 0x51b0cc, 0xbc5341, 0x7856bb];
const PED_SUITS = [0x3a3d48, 0x50545e, 0x2c3040, 0x5a5048, 0x404448];
const PED_JACKETS = [0x4e5969, 0xa9997d, 0x55765e, 0x7b4e4e, 0x707076];
// pedestrian face pool: skin tone x faceSeed (each faceSeed fixes the atlas-affecting traits) -> at most 16 atlases
const PED_SKINS = [[180, 138, 114], [196, 154, 130], [166, 122, 100], [152, 110, 88]];
const PED_FACES = [{ stubble: 0, age: 0.1, browW: 0.5, browAngle: 0.1, hairColor: 0x1a1410 }, { stubble: 0.4, age: 0.35, browW: 0.8, browAngle: 0.4, hairColor: 0x241a12 }, { stubble: 0, age: 0.55, browW: 0.6, browAngle: 0.2, hairColor: 0x4a4440 }, { stubble: 0.3, age: 0.0, browW: 0.4, browAngle: 0.3, hairColor: 0x0e0c0c }];

// ---------------------------------------------------------------- pedestrian: the STABLE options API
// createHumanoid({ variant: 'pedestrian', seed, outfit, hair, hairColor, skin, height, fem, build, accessories }) — see
// the header comment. resolvePedestrian(opts) is the one function that turns those into a LOOK (every colour, hem,
// garment kind and face trait the body is built from); it is exported so crowd.js can build the instanced twin from
// the same numbers, and every field is deterministic from `seed` when the option is omitted: the resolver takes a
// FIXED budget of draws up front, so passing one option never shifts another.
export const PED_OUTFITS = ['suit', 'hoodie', 'blouson', 'cardigan', 'dress', 'school', 'staff', 'tourist'];
export const PED_HAIRS = ['short', 'parted', 'swept', 'bob', 'tied', 'cap'];
export const PED_HAIR_COLORS = { black: 0x141110, dark: 0x2a1d15, brown: 0x4e3320, ash: 0x8a6c4c, grey: 0x726e6b };
// 0 = fair (the most common tone under a Shibuya sign) .. 4 = deep tan. sRGB albedo of the cheek. The hero's scan
// measures 158/114/94 at the cheek; the first pass had tone 0 at 232/198/180, which under the night key rendered as
// a pale pink dome next to him. The ladder now runs from a fair 214 down to a tan 156, all inside SKIN_GAMUT.
export const PED_SKIN_TONES = [[214, 170, 148], [202, 156, 132], [188, 142, 118], [174, 128, 104], [156, 112, 90]];
const PED_TAILORED = new Set(['suit', 'school', 'staff']);
const PED_OUTFIT_W = {
  m: { suit: 30, hoodie: 15, blouson: 14, cardigan: 3, dress: 0, school: 8, staff: 6, tourist: 8 },
  f: { suit: 10, hoodie: 9, blouson: 5, cardigan: 18, dress: 18, school: 13, staff: 6, tourist: 8 },
};
const PED_HAIR_W = { m: { short: 34, parted: 24, swept: 18, bob: 0, tied: 2, cap: 12 }, f: { short: 6, parted: 8, swept: 3, bob: 42, tied: 32, cap: 7 } };
// Shibuya night palettes. NOTHING here may read as skin: no tan, camel, beige, peach or pink on a garment.
const PED_PAL = {
  suit: [0x1b1f2b, 0x222836, 0x14161c, 0x2b3040, 0x303338, 0x1d2233],
  coat: [0x24262c, 0x1a1d27, 0x121316, 0x2e3330, 0x3a3d44],
  shirt: [0xe8e4dc, 0xdcdfe6, 0xd8d4cc, 0xc9d3e0],
  tie: [0x18294a, 0x4a1c22, 0x2a3a2a, 0x2c2c34, 0x3a2a4a],
  hoodie: [0x5e626a, 0x2b2d33, 0x1f2740, 0x3d4a38, 0x5a2a2e, 0xd8d4ca, 0x8a8f96],
  jeans: [0x2a3450, 0x1f2638, 0x1a1c22, 0x36404e, 0x4a5568],
  blouson: [0x1a1a1e, 0x1f2740, 0x3a3d2c, 0x4a1e22, 0x2c2c34],
  chinos: [0x3a3c42, 0x2a2e38, 0x4a4f5a, 0x2b2f2a],
  cardigan: [0x8a8f96, 0x5a5e66, 0x2a2e3a, 0x4a3a44, 0x3d4a38, 0x6a3a3a, 0xb8bcc4],
  blouse: [0xe8e4dc, 0xd8dce4, 0xcfd8e8, 0xe0dcd4],
  skirt: [0x1b1f2b, 0x3a3a44, 0x4a3040, 0x2a3a34, 0x5a5560],
  dress: [0x1f2740, 0x14161c, 0x4a1e2a, 0x2a3a34, 0x3a3050, 0x5a5568],
  tights: [0x141418, 0x1c1c22, 0x2a2a30],
  school: [0x1e2a44, 0x22304c, 0x14161c],
  apron: [0x121216, 0x1c2a3a, 0x2c3226, 0x3a2a20],
  tee: [0xe4e0d8, 0x2a2a30, 0x8a8f96, 0x3a4a5a, 0x6a2a2e],
  wind: [0x2a3450, 0x2f9c82, 0x3a3a3e, 0x6a2a2e, 0xa6bece],
  shorts: [0x2a3450, 0x36404e, 0x2b2f2a, 0x4a4f5a],
  sneaker: [0xe8e4da, 0x2a2a2e, 0x3a4560, 0x5e3230, 0xc8c4bc],
  dress_shoe: [0x22201c, 0x1a1a1e, 0x3a2a20],
  pump: [0x1a1a1e, 0x3a2a20, 0x2a2a30, 0x4a1e22],
  bag: [0x1a1a1e, 0x3a2a20, 0x1f2740, 0x4a3a30],
  cap: [0x14161c, 0x1f2740, 0x2c3226, 0x4a4f5a, 0x8a1c22],
};
const wpick = (keys, W, u) => { let t = 0; for (const k of keys) t += W[k]; let x = u * t; for (const k of keys) { x -= W[k]; if (x < 0) return k; } return keys[keys.length - 1]; };
const pickAt = (arr, u) => arr[Math.min(arr.length - 1, Math.floor(u * arr.length))];
export function resolvePedestrian(o = {}) {
  const seed = (o.seed ?? 1) | 0, r = mulberry(seed), d = [];
  for (let i = 0; i < 40; i++) d.push(r());
  const tailored = d[0] >= 0.45;                        // (crowd.js's poolSeed reads this first draw: kept as the tailored/casual split)
  const fem = o.fem != null ? !!o.fem : d[1] < 0.42;
  const age = o.age != null ? clamp(o.age, 0, 1) : d[2] < 0.13 ? 0.62 + d[3] * 0.33 : d[2] < 0.58 ? 0.02 + d[3] * 0.2 : 0.22 + d[3] * 0.3;
  const old = age >= 0.6, sex = fem ? 'f' : 'm';
  const W = PED_OUTFIT_W[sex];
  const pool = PED_OUTFITS.filter((k) => W[k] > 0 && (tailored ? PED_TAILORED.has(k) : !PED_TAILORED.has(k)));
  let outfit = PED_OUTFITS.includes(o.outfit) ? o.outfit : wpick(pool, W, d[4]);
  if (outfit === 'school' && age > 0.2 && !PED_OUTFITS.includes(o.outfit)) outfit = tailored ? 'suit' : 'hoodie';   // uniforms on teenagers only
  if (outfit === 'dress' && !fem) outfit = 'blouson';    // a dress is a women's template, however it was asked for
  const hair = PED_HAIRS.includes(o.hair) ? o.hair : (old && d[5] < 0.5 ? (fem ? 'tied' : 'short') : wpick(PED_HAIRS, PED_HAIR_W[sex], d[5]));
  const hairKey = o.hairColor != null ? (typeof o.hairColor === 'string' && PED_HAIR_COLORS[o.hairColor] != null ? o.hairColor : null)
    : old ? (d[6] < 0.6 ? 'grey' : 'dark') : d[6] < 0.55 ? 'black' : d[6] < 0.78 ? 'dark' : d[6] < 0.92 ? 'brown' : 'ash';
  const hairColor = hairKey ? PED_HAIR_COLORS[hairKey] : (typeof o.hairColor === 'number' ? o.hairColor : PED_HAIR_COLORS.black);
  const skin = o.skin != null ? clamp(o.skin | 0, 0, 4) : Math.min(4, Math.floor(Math.pow(d[7], 1.5) * 5));
  const height = o.height != null ? clamp(o.height, 1.35, 2.05) : (fem ? 1.50 + d[8] * 0.18 : 1.62 + d[8] * 0.20) - (old ? 0.03 : 0);
  const build = o.build != null ? clamp(o.build, 0.7, 1.35) : (fem ? 0.84 + d[9] * 0.14 : 0.88 + d[9] * 0.26) + (old && !fem ? 0.04 : 0);
  let accessories = Array.isArray(o.accessories) ? o.accessories.filter((a) => a === 'bag' || a === 'phone' || a === 'umbrella') : null;
  if (!accessories) {
    accessories = [];
    if (d[10] < (fem ? 0.55 : 0.32)) accessories.push('bag');
    if (d[11] < 0.22 && !old) accessories.push('phone');
    else if (d[11] < 0.30) accessories.push('umbrella');
  }
  // colours and cuts per template (every draw indexed, none conditional, so the twin can read them back)
  const P = PED_PAL, C = { top: 0, bottom: 0, inner: 0xe8e4dc, shoe: 0x22201c, sole: 0x1b1916, accent: 0x18294a, coat: 0, legwear: 0, bag: pickAt(P.bag, d[20]), cap: pickAt(P.cap, d[21]) };
  const G = { outfit, top: 'suit', coat: false, bottom: 'trousers', legwear: null, shoe: 'dress', sleeve: 'long', hem: 0.83, coatHem: 0.62, skirtHem: 0.58, pleats: 0, tie: false, hood: false, bag: 'none', garment: 'worsted', trouserGarment: 'worsted', topGarment: 'worsted' };
  switch (outfit) {
    case 'suit':
      C.top = pickAt(P.suit, d[12]); C.bottom = C.top; C.inner = pickAt(P.shirt, d[13]); C.accent = pickAt(P.tie, d[14]); C.coat = pickAt(P.coat, d[15]);
      C.shoe = pickAt(P.dress_shoe, d[16]); G.coat = d[17] < (old ? 0.55 : 0.36); G.tie = !fem && d[18] < 0.82; G.garment = ['worsted', 'pinstripe', 'birdseye', 'worsted'][Math.floor(d[19] * 4)];
      if (fem) { G.bottom = d[22] < 0.5 ? 'skirt' : 'trousers'; G.skirtHem = 0.60; G.legwear = 'tights'; C.legwear = pickAt(P.tights, d[23]); G.shoe = 'pump'; C.shoe = pickAt(P.pump, d[16]); }
      G.bag = fem ? 'hand' : 'shoulder';
      break;
    case 'hoodie':
      G.top = 'hoodie'; G.hood = true; G.bottom = 'jeans'; G.shoe = 'sneaker'; G.hem = 0.86; G.topGarment = 'knit'; G.trouserGarment = 'denim';
      C.top = pickAt(P.hoodie, d[12]); C.bottom = pickAt(P.jeans, d[13]); C.inner = pickAt(P.tee, d[14]); C.shoe = pickAt(P.sneaker, d[16]); C.sole = d[16] < 0.5 ? 0xa39e92 : 0x322e2a;
      G.bag = d[17] < 0.5 ? 'backpack' : 'shoulder';
      break;
    case 'blouson':
      G.top = 'blouson'; G.bottom = d[17] < 0.55 ? 'chinos' : 'jeans'; G.shoe = d[18] < 0.6 ? 'sneaker' : 'dress'; G.hem = 0.90; G.topGarment = 'nylon'; G.trouserGarment = G.bottom === 'jeans' ? 'denim' : 'worsted';
      C.top = pickAt(P.blouson, d[12]); C.bottom = G.bottom === 'jeans' ? pickAt(P.jeans, d[13]) : pickAt(P.chinos, d[13]); C.inner = pickAt(P.tee, d[14]);
      C.shoe = G.shoe === 'sneaker' ? pickAt(P.sneaker, d[16]) : pickAt(P.dress_shoe, d[16]); C.sole = G.shoe === 'sneaker' ? 0xa39e92 : 0x1b1916;
      G.bag = 'shoulder';
      if (fem) { G.bottom = 'skirt'; G.skirtHem = 0.62; G.legwear = 'tights'; C.legwear = pickAt(P.tights, d[23]); C.bottom = pickAt(P.skirt, d[13]); G.trouserGarment = 'worsted'; }
      break;
    case 'cardigan':
      G.top = 'cardigan'; G.hem = 0.86; G.topGarment = 'knit';
      C.top = pickAt(P.cardigan, d[12]); C.inner = pickAt(P.blouse, d[14]);
      if (fem) { G.bottom = 'skirt'; G.skirtHem = 0.52 + d[17] * 0.12; G.legwear = 'tights'; C.legwear = pickAt(P.tights, d[23]); C.bottom = pickAt(P.skirt, d[13]); G.shoe = d[18] < 0.5 ? 'flat' : 'pump'; C.shoe = pickAt(P.pump, d[16]); }
      else { G.bottom = 'chinos'; C.bottom = pickAt(P.chinos, d[13]); G.shoe = 'dress'; C.shoe = pickAt(P.dress_shoe, d[16]); }
      G.bag = fem ? 'hand' : 'shoulder';
      break;
    case 'dress':
      G.top = 'dress'; G.coat = d[17] < 0.72; G.bottom = 'none'; G.skirtHem = 0.50 + d[18] * 0.14; G.legwear = d[19] < 0.6 ? 'tights' : 'bare'; G.shoe = d[22] < 0.55 ? 'pump' : 'boot'; G.topGarment = 'knit';
      C.top = pickAt(P.dress, d[12]); C.coat = pickAt(P.coat, d[15]); C.legwear = pickAt(P.tights, d[23]); C.shoe = pickAt(P.pump, d[16]); C.inner = C.top;
      G.bag = 'hand';
      break;
    case 'school':
      G.top = !fem && d[17] < 0.35 ? 'gakuran' : 'blazer'; G.hem = 0.80; C.top = pickAt(P.school, d[12]); C.inner = pickAt(P.shirt, d[13]); C.accent = fem ? pickAt([0x8a1c22, 0x18294a, 0x2a3a2a], d[14]) : pickAt(P.tie, d[14]);
      G.tie = G.top === 'blazer'; C.shoe = 0x1a1a1e; G.shoe = 'dress';
      if (fem) { G.bottom = 'pleated'; G.skirtHem = 0.62 + d[18] * 0.06; G.pleats = 16; C.bottom = pickAt([0x1e2a44, 0x3a3a44, 0x2a3a34], d[19]); G.legwear = 'socks'; C.legwear = 0x1e2a44; G.shoe = 'flat'; }
      else { G.bottom = 'trousers'; C.bottom = G.top === 'gakuran' ? 0x14161c : pickAt([0x2a2e38, 0x4a4f5a, 0x1e2a44], d[19]); }
      if (G.top === 'gakuran') C.top = 0x14161c;
      G.bag = d[22] < 0.6 ? 'backpack' : 'shoulder';
      break;
    case 'staff':
      G.top = 'apron'; G.bottom = 'trousers'; G.shoe = d[17] < 0.5 ? 'dress' : 'sneaker'; G.hem = 0.83;
      C.top = pickAt(P.apron, d[12]); C.bottom = pickAt([0x14161c, 0x1a1a1e, 0x2a2e38], d[13]); C.inner = pickAt(P.shirt, d[14]);
      C.shoe = G.shoe === 'sneaker' ? 0x2a2a2e : pickAt(P.dress_shoe, d[16]); C.sole = 0x1b1916;
      if (fem) { G.bottom = d[18] < 0.5 ? 'skirt' : 'trousers'; G.skirtHem = 0.60; G.legwear = 'tights'; C.legwear = pickAt(P.tights, d[23]); }
      G.bag = 'none';
      break;
    case 'tourist':
      G.top = d[17] < 0.62 ? 'wind' : 'tee'; G.sleeve = G.top === 'tee' ? 'short' : 'long'; G.bottom = d[18] < 0.42 ? 'shorts' : 'chinos'; G.shoe = 'sneaker'; G.hem = 0.86; G.topGarment = 'nylon'; G.trouserGarment = 'denim';
      C.top = G.top === 'wind' ? pickAt(P.wind, d[12]) : pickAt(P.tee, d[12]); C.inner = pickAt(P.tee, d[14]); C.bottom = G.bottom === 'shorts' ? pickAt(P.shorts, d[13]) : pickAt(P.chinos, d[13]);
      C.shoe = pickAt(P.sneaker, d[16]); C.sole = 0xa39e92; G.legwear = G.bottom === 'shorts' ? 'bare' : null;
      G.bag = d[19] < 0.7 ? 'backpack' : 'shoulder';
      break;
  }
  if (!accessories.includes('bag')) G.bag = 'none';
  // face traits: a deterministic cast of four male / three female faces per tone, the old carry their years
  const face = fem
    ? { stubble: 0, browW: 0.30 + d[24] * 0.12, browAngle: 0.05 + d[25] * 0.2, age: Math.min(age, 0.55), faceSeed: Math.floor(d[26] * 3), jaw: 0.78 + d[27] * 0.08, chin: 0.76 + d[28] * 0.12, nose: 0.72 + d[29] * 0.14, cheek: 1.06 + d[30] * 0.1, full: 0.6 + d[31] * 0.4 }
    : { stubble: d[24] < 0.35 ? 0.25 + d[25] * 0.35 : 0, browW: 0.5 + d[26] * 0.4, browAngle: 0.1 + d[27] * 0.4, age, faceSeed: Math.floor(d[28] * 4), jaw: 1.0 + d[29] * 0.18, chin: 0.92 + d[30] * 0.24, nose: 0.92 + d[31] * 0.26, cheek: 0.95 + d[32] * 0.2, full: 0.25 + d[33] * 0.5 };
  if (old) { face.full = Math.max(0, face.full - 0.3); face.nlf = fem ? 0.55 : 1; face.age = fem ? Math.min(age, 0.7) : age; }
  const shoulderW = fem ? 0.84 + d[34] * 0.08 : 0.94 + d[34] * 0.2, torsoLen = 0.95 + d[35] * 0.1, legLen = fem ? 0.98 + d[36] * 0.1 : 0.94 + d[36] * 0.12;
  const gut = !fem && (old ? d[37] < 0.5 : d[37] < 0.18) ? 0.02 + d[38] * 0.03 : 0, posture = (d[39] - 0.35) * 0.02 + (old ? 0.014 : 0);
  return { seed, fem, age, old, outfit, hair, hairKey, hairColor, skin, skinRGB: PED_SKIN_TONES[skin], height, build, accessories, colours: C, cut: G, face, shoulderW, torsoLen, legLen, gut, posture, hairUnder: hair === 'cap' ? 'short' : hair };
}
// write a resolved look into a variant record (the fields buildBody reads)
function applyLook(V, L) {
  const C = L.colours, G = L.cut;
  V.look = L; V.fem = L.fem; V.age = L.face.age; V.stubble = L.face.stubble; V.browW = L.face.browW; V.browAngle = L.face.browAngle; V.faceSeed = L.face.faceSeed + (L.fem ? 8 : 0) + L.skin * 16;
  V.jaw = L.face.jaw; V.chin = L.face.chin; V.nose = L.face.nose; V.cheek = L.face.cheek; V.full = L.face.full; V.nlf = L.face.nlf || 0;
  V.skin = L.skinRGB.slice(); V.hair = L.hairUnder; V.hairStyle = L.hair; V.hairColor = L.hairColor;
  // a woman's head: a tapered chin on a round (not square) mandible, no brow ridge to speak of, a fuller cheek — the
  // first pass gave her the men's jaw table with the stubble turned off, and she read as a slight man
  if (L.fem) { V.chinTaper = 0.27; V.brow = 0.5; V.neck = 0.86; V.lip = [172, 84, 88]; V.lipA = 0.9; V.bust = 0.024 + 0.010 * (L.build - 0.84) / 0.14; V.hipW = 1.07; V.waist = 0.91; V.jawSq = 0.15; V.jawSpread = 0.02; V.headScale = 0.965; }
  else { V.chinTaper = 0.10; V.brow = 0.85 + (L.face.browW - 0.5) * 0.5; V.neck = 1.0 + 0.1 * (L.build - 1); V.bust = 0; V.hipW = 1.0; V.waist = 1.0; }
  if (L.old) { V.hairDim = 1; V.greyHair = 0x8e8a86; V.greyAmt = L.hairKey === 'grey' ? 0.2 : 0.5; }
  V.scale = L.height / 1.80; V.build = L.build; V.shoulderW = L.shoulderW; V.torsoLen = L.torsoLen; V.legLen = L.legLen; V.gut = L.gut; V.belly = 0; V.posture = L.posture;
  V.fist = 0.42;
  V.outfit = (G.top === 'suit' || G.top === 'blazer') ? 'suit' : 'track';   // legacy switch some helpers still read
  V.top = G.top; V.coat = G.coat; V.bottom = G.bottom; V.legwear = G.legwear; V.shoeKind = G.shoe; V.sleeve = G.sleeve; V.hem = G.hem; V.coatHem = G.coatHem; V.skirtHem = G.skirtHem; V.pleats = G.pleats;
  V.tie = G.tie; V.hood = G.hood; V.bag = G.bag; V.garment = G.garment; V.topGarment = G.topGarment; V.trouserGarment = G.trouserGarment;
  V.suit = C.top; V.trousers = C.bottom; V.shirt = C.inner; V.accent = C.accent; V.coatColor = C.coat; V.legwearColor = C.legwear; V.bagColor = C.bag; V.capColor = C.cap;
  V.shoes = C.shoe; V.sole = C.sole; V.midsole = G.shoe === 'sneaker' ? 0xa39e92 : undefined;
  V.knitTie = false; V.buttoned = G.top === 'suit'; V.open = false; V.chief = false; V.vc = true; V.shirtVC = true; V.eyeMat = true;
  return V;
}

// hair: per colour a strand albedo + Sobel strand normal + strand roughness, tiled 14 x 3 so strands are ~1 mm; anisotropic
// highlight across the strands
// One strand sheet for every hair colour on the map: a mid-grey albedo with a wide value range (strands at 0.55..1.9 of
// the base, alpha 0.7 — near-black on near-black used to mip down to one flat tone), a Sobel strand normal and a strand
// roughness. The colour is the material tint, normalised against STRAND_BASE, so nothing is re-rasterised per colour.
const STRAND_BASE = 158;
let strandCache = null;
function strandSet() {
  if (strandCache) return strandCache;
  const W = 256, Hh = 256, rng = mulberry(0x5bd1e995), B = STRAND_BASE;
  const ac = document.createElement('canvas'); ac.width = W; ac.height = Hh;
  const hc = document.createElement('canvas'); hc.width = W; hc.height = Hh;
  const a = ac.getContext('2d'), h = hc.getContext('2d');
  a.fillStyle = `rgb(${B},${B},${B})`; a.fillRect(0, 0, W, Hh);
  h.fillStyle = '#000'; h.fillRect(0, 0, W, Hh);
  a.lineCap = h.lineCap = 'round';
  for (let i = 0; i < 1500; i++) {
    const k = 0.55 + rng() * 1.35, px = rng() * W, w = 0.7 + rng() * 1.8, len = 50 + rng() * 220, py = rng() * Hh - len * 0.5, drift = (rng() - 0.5) * 8;
    const v = Math.min(255, (B * k) | 0);
    a.strokeStyle = `rgba(${v},${v},${v},0.7)`; a.lineWidth = w;
    h.strokeStyle = `rgba(255,255,255,${0.25 + 0.35 * rng()})`; h.lineWidth = w;
    for (const ox of [-W, 0, W]) for (const oy of [-Hh, 0, Hh]) {
      a.beginPath(); a.moveTo(px + ox, py + oy); a.lineTo(px + ox + drift, py + oy + len); a.stroke();
      h.beginPath(); h.moveTo(px + ox, py + oy); h.lineTo(px + ox + drift, py + oy + len); h.stroke();
    }
  }
  const glossy = false;
  const hd = h.getImageData(0, 0, W, Hh).data;
  const nc = document.createElement('canvas'); nc.width = W; nc.height = Hh;
  const oc = document.createElement('canvas'); oc.width = W; oc.height = Hh;
  const nx = nc.getContext('2d'), ni = nx.createImageData(W, Hh), nd = ni.data;
  const ox = oc.getContext('2d'), oi = ox.createImageData(W, Hh), od = oi.data;
  const H = (x, y) => hd[(((y + Hh) % Hh) * W + ((x + W) % W)) * 4] / 255;
  const str = 2.2, rBase = glossy ? 0.38 : 0.52;
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const dhdu = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
    const dhdv = (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1)) - (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1));
    let vx = -dhdu * str, vy = -dhdv * str, vz = 1; const l = Math.hypot(vx, vy, vz); vx /= l; vy /= l; vz /= l;
    const k = (y * W + x) * 4;
    nd[k] = (vx * 0.5 + 0.5) * 255; nd[k + 1] = (vy * 0.5 + 0.5) * 255; nd[k + 2] = (vz * 0.5 + 0.5) * 255; nd[k + 3] = 255;
    od[k] = 255; od[k + 1] = clamp(rBase + (0.5 - H(x, y)) * 0.3, 0.2, 1) * 255; od[k + 2] = 0; od[k + 3] = 255;
  }
  nx.putImageData(ni, 0, 0); ox.putImageData(oi, 0, 0);
  strandCache = { albedo: ac, normal: nc, orm: oc };
  return strandCache;
}
let strandTex = null;
function strandTextures() {
  if (!strandTex) { const s = strandSet(); strandTex = { map: texFromCanvas(s.albedo, true, [14, 3]), normal: texFromCanvas(s.normal, false, [14, 3]), orm: texFromCanvas(s.orm, false, [14, 3]) }; }
  return strandTex;
}
function hairMaterial(color, glossy, vc = false, dim = 1) {
  const id = 'hair|' + color + '|' + glossy + (vc ? '|vc' : '') + '|' + dim;
  if (matCache.has(id)) return matCache.get(id);
  const L = lib();
  let m;
  if (L) { m = L.clone('hair'); m.color.set(0xffffff); }
  else m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const t = strandTextures();
  m.map = t.map; m.normalMap = t.normal; m.normalScale = new THREE.Vector2(0.9, 0.9);
  m.roughnessMap = m.metalnessMap = t.orm;
  const d = lin(STRAND_BASE) / dim;                 // the strand sheet is grey: tint it to the requested albedo
  _c1.set(color); m.color.setRGB(_c1.r / d, _c1.g / d, _c1.b / d);
  // A slicked head is glossier than a dry one, but the specular was picking up the whole cool sky + sign hemisphere
  // and washing a 30-something's black hair into a pale blue-grey helmet. Clamp the env so a green sign cannot tint
  // the head, and put the gloss in a narrow anisotropic band along the comb direction instead of a broad sheen.
  m.roughness = glossy ? 0.82 : 0.98; m.metalness = 0;
  m.anisotropy = 0.95; m.anisotropyRotation = HPI;
  m.sheen = 0; m.clearcoat = 0;
  envTrack(m, 0.55);                                // a green sign must not tint a whole head of black hair
  // the character key is analytic now (no THREE.Light anywhere on a body), so hair has to opt in or every head in
  // the cast goes black. Low ground bounce — hair is the one chart that must not take the plaza — and a 0.18
  // roughness floor, which is what kills the crawling specular on a 1 mm strand normal at 1080p.
  charShader(m, { hemi: 0.9, hemiN: 2.2, gnd: 0.6, key: 0.72, rim: 0.85, aa: [0.18, 0.18], face: 1 });
  if (vc) m.vertexColors = true;
  m.side = THREE.FrontSide;                        // the crown cap winding is fixed in loft(), so no double raster cost
  m.name = 'hair#' + color.toString(16); m.needsUpdate = true;
  matCache.set(id, m);
  return m;
}

// Six characters, six unrelated skeletons: a linebacker with a pinhead next to a child-proportioned tout is what
// a free-running seeded morph produces. The head is sized from the body it sits on — from the standing height in
// heads AND from the shoulder width, because a head reads small against a wide yoke — and clamped, so every
// variant lands in the 7.3-7.8 heads a human figure occupies.
const HEAD_LEN = 0.2355 * HEAD_K + 0.014;               // chin to crown with the hair shell on
function headSizeFor(V, R, lift) {
  const bodyH = R.joints.Head[1] + 0.22 + (lift || 0);
  const k = (bodyH / (7.55 * HEAD_LEN)) * (0.5 + 0.5 * (V.shoulderW || 1));
  return clamp(k, 0.92, 1.10);
}
function buildBody(V, rng, detail, R, stance = null) {
  // 34 segments over a full head ring is 10.6° a step: a nose wing is 6° wide, so at LOD0 the whole middle of the
  // face fell between two samples and every procedural head read as an egg. 48 at LOD0, unchanged below.
  // Fix round 2: the crowd's LOD0 pool builds at detail 0.5, which gave its heads 17 segments — a faceted egg that
  // walked two metres behind the lead in the flagship close-up. The head is where the eye lands: 40 at 0.4-0.9.
  const segs = Math.max(10, Math.round(22 * detail)), hsegs = detail >= 0.9 ? 48 : detail >= 0.4 ? 40 : Math.max(16, Math.round(34 * detail));
  const tl = V.torsoLen || 1;
  const K = { V, R, segs, hsegs, stance, ty: (y) => (y <= 0.98 ? y : 0.98 + (y - 0.98) * tl), chinY: R.joints.Head[1] - 0.015, headZ: R.joints.Head[2] };
  const wT = torsoWeights(R, 0.07), wHead = boneW('Head');
  if (!coatSkirtW) coatSkirtW = makeCoatSkirtW();
  // 512² put a whole head AND both hands on one atlas: at LOD0 that is ~90 texels across a face, so the eyes, the
  // nose and the mouth were painted at a resolution no amount of geometry could rescue. Anything built at full
  // detail (the cast shot, the player, the foreground crowd body) now paints at 1024².
  const face = { ...heroFace(V), hires: !!V.hires || detail >= 0.95 };
  const vc = !!V.vc;
  K.vc = vc;
  K.tint = vc ? (geo, key, hex) => vcolor(geo, tintOf(key, hex)) : (geo) => geo;
  const mats = {
    skin: acquireSkin(face, 11 + (V.faceSeed || 0)),
    hair: hairMaterial(V.hairColor, V.hair === 'slick' || V.hair === 'longslick', V.greyHair != null, V.hairDim || 1),
    // one shoe material for every outfit; the upper / sole / midsole / belt colour break rides the vertex colour,
    // which is what buys the eyeball its draw call back
    shoes: mat('shoes', V.shoes, vc ? (V.outfit === 'track' ? { vc: true, roughness: 0.58 } : { vc: true }) : {}),
    shirt: mat('shirt', V.shirt),
  };
  // the eyeball is LOD0 / the crowd's near pool only (detail >= 0.4, fix round 4 — a painted dot at 2 m is a doll's
  // eye): the far rungs must not pay a draw call for a 2.5 cm sphere at 20 m
  if (V.eyeMat && detail >= 0.4) mats.eye = eyeMatOf(mats.skin);
  // every garment indexes a body-scale swatch: worsted / pinstripe / birdseye for tailoring, nylon for a track top,
  // denim for jeans, poplin for a shirt. The vertex colour only TINTS it.
  const gk = V.garment || 'worsted';
  if (V.look) {
    // A pedestrian's wardrobe (buildWardrobe) rides FOUR cloth slots, all vertex-tinted so the whole crowd shares
    // them: tailoring (worsted family: suit, blazer, coat, skirt, trousers, tights), rib knit (hoodie, cardigan,
    // dress, tee), tricot nylon (blouson, windbreaker), denim (jeans, shorts), plus poplin on the accent slot for
    // every shirt, blouse, apron, tie and ribbon. An outfit only ever draws its own subset: 7 calls at most.
    const G = V.look.cut, cl = (garment, ex) => mat('cloth', 0xffffff, { vc: true, garment, ...ex });
    mats.tailor = mat('suit', 0xffffff, { vc: true, garment: gk });
    mats.knit = cl('knit', { roughness: 0.84, sheen: 0.14, sheenColor: 0x5c5c66 });
    mats.nylon = cl('nylon', { roughness: 0.36, sheen: 0.32, sheenColor: 0x707070, nscale: 0.45 });
    mats.denim = cl('denim', { roughness: 0.85, sheen: 0.1, sheenColor: 0x506080, nscale: 1.2 });
    const slot = (g) => (g === 'knit' ? mats.knit : g === 'nylon' ? mats.nylon : g === 'denim' ? mats.denim : mats.tailor);
    mats.jacket = slot(G.topGarment); mats.trousers = slot(G.trouserGarment);
    mats.accent = cl('poplin', { roughness: 0.78, sheen: 0.18, sheenColor: 0x6070a0 });
  }
  else if (V.outfit === 'coat') { mats.jacket = mat('leather', V.suit); mats.trousers = mat('suit', V.trousers, { garment: gk }); }
  else if (V.outfit === 'track') { mats.jacket = mat('cloth', V.suit, { garment: 'nylon', roughness: 0.36, sheen: 0.32, sheenColor: 0x707070, nscale: 0.45 }); mats.trousers = mat('cloth', V.trousers, { garment: 'denim', roughness: 0.85, sheen: 0.1, sheenColor: 0x506080, nscale: 1.2 }); }
  else { mats.jacket = mat('suit', V.suit, vc ? { vc: true, garment: gk } : { garment: gk }); mats.trousers = mats.jacket; }
  mats.sole = vc ? mats.shoes : (V.outfit === 'track' ? mat('rubber', 0xd8d4cc, { roughness: 0.85 }) : mat('rubber', 0x1a1a1a, { roughness: 0.9 }));
  // the accent slot carries the tie, the pocket square and (with shirtVC) the dress shirt: poplin when the shirt
  // rides it, a rib knit when it is only neckwear
  const ak = V.shirtVC && vc ? 'poplin' : 'knit';
  if (!V.look) mats.accent = mat('cloth', V.accent || 0x404040, vc ? { vc: true, garment: ak, roughness: 0.78, sheen: 0.18, sheenColor: 0x6070a0 } : { garment: ak, roughness: 0.6, sheen: 0.3, sheenColor: 0x806070 });
  if (vc && V.buckle) mats.metal = mat('metal', 0xffffff, { vc: true, metalness: 0.5, roughness: 0.45 });  // half-diffuse: reads as steel even unlit
  // the hero's shirt rides in the vertex-coloured cloth slot so splitting the eyeball out costs no extra draw call
  if (V.shirtVC && vc) { mats.shirt = mats.accent; K.shirtTint = 'cloth'; }
  K.sh = (g) => (K.shirtTint ? K.tint(g, K.shirtTint, V.shirt) : g);
  K.mats = mats;

  const parts = [], headParts = [];
  headParts.push({ geo: buildHead(K, wHead, wT), mat: mats.skin });
  for (const g of buildEyes(K, wHead)) headParts.push({ geo: g, mat: mats.eye || mats.skin });
  for (const g of buildEars(K, wHead)) headParts.push({ geo: g, mat: mats.skin });
  for (const g of buildHair(K, V.hair, wHead, rng)) headParts.push({ geo: g, mat: mats.hair });
  if (V.hairStyle === 'cap') for (const g of buildCap(K, wHead)) headParts.push({ geo: K.tint(g, 'cloth', V.capColor || 0x14161c), mat: mats.accent });
  if (V.sunglasses) buildSunglasses(K, wHead, headParts, mats.shoes);
  if (K.stance) {                                    // head carried a few degrees off the shoulder line
    const S = K.stance, py = K.ty(R.joints.Neck[1]), pz = K.headZ;
    const m = new THREE.Matrix4().makeTranslation(0, py, pz)
      .multiply(new THREE.Matrix4().makeRotationY(S.yaw))
      .multiply(new THREE.Matrix4().makeRotationZ(S.headRoll))
      .multiply(new THREE.Matrix4().makeTranslation(0, -py, -pz));
    for (const p of headParts) p.geo.applyMatrix4(m);
  }
  for (const p of headParts) parts.push(p);
  if (V.look) buildWardrobe(K, wT, parts, mats);
  else for (const p of buildJacket(K, wT, V.outfit)) parts.push(p);
  if (V.look) { /* the wardrobe dressed the torso */ }
  else if (V.outfit === 'track') { for (const g of buildShirt(K, wT, { collar: false, stand: true, closed: true, top: 1.49, bottom: 0.846 })) parts.push({ geo: K.sh(g), mat: mats.shirt }); if (V.hood) parts.push({ geo: buildHood(K, wT), mat: mats.jacket }); }
  else if (V.tie) {
    for (const g of buildShirt(K, wT, { closed: true })) parts.push({ geo: K.sh(g), mat: mats.shirt });
    // the knot is the same cloth as the blade, so without a value of its own a four-in-hand reads as a painted
    // stripe running into the collar. The knot's front faces up and catches the sky: +18 %, on the vertex colour.
    const tie = K.tint(buildTie(K, wT), 'cloth', V.accent);
    if (K.vc) { const knotY = K.ty(1.452), a = tie.attributes.color, p = tie.attributes.position;
      for (let i = 0; i < a.count; i++) { const k = 1 + 0.18 * sstep((p.getY(i) - knotY) / 0.02); a.setXYZ(i, a.getX(i) * k, a.getY(i) * k, a.getZ(i) * k); } }
    parts.push({ geo: tie, mat: mats.accent });
  }
  else { for (const g of buildShirt(K, wT, { vGap: 0.36, vFrom: 1.24 })) parts.push({ geo: K.sh(g), mat: mats.shirt }); if (V.undershirt) parts.push({ geo: buildUndershirt(K, wT), mat: mats.accent }); }
  for (const side of SIDES) buildArm(K, side, parts, mats);
  buildLegs(K, parts, mats, wT);

  if (stance) for (const p of parts) stanceWarp(p.geo, stance);
  // A two-piece is one cloth, but a jacket hanging over trousers is never one VALUE: the wool catches the sky on the
  // shoulders and the trouser falls away. Both halves share the suit slot, so the break rides the vertex colour and
  // costs no draw call — without it the whole body was a single flat silhouette with no hem anywhere.
  if (vc && V.look) {
    // whatever the wardrobe left untinted on the top / trouser slots (sleeves, pelvis, trouser legs): the top's
    // colour on the top slot — the coat's when one is worn over it, since the sleeve is the coat's — the bottom's
    // on the trouser slot; a suit's jacket lifts 10 % over its trousers exactly as the cast's does
    const kj = mats.jacket === mats.tailor ? 'suit' : 'cloth', kt = mats.trousers === mats.tailor ? 'suit' : 'cloth';
    const jt = tintOf(kj, V.coat ? V.coatColor : V.outfit === 'suit' ? shadeHex(V.suit, 1.10) : V.suit), tt = tintOf(kt, V.trousers || V.suit);
    for (const p of parts) if ((p.mat === mats.jacket || p.mat === mats.trousers) && !p.geo.attributes.color) vcolor(p.geo, p.t === 'trousers' || (p.mat === mats.trousers && p.mat !== mats.jacket) ? tt : jt);
  } else if (vc && V.outfit === 'suit') {
    const jt = tintOf('suit', shadeHex(V.suit, 1.14)), tt = tintOf('suit', shadeHex(V.trousers != null ? V.trousers : V.suit, V.trousers != null ? 1 : 0.80));
    for (const p of parts) if ((p.mat === mats.jacket || p.mat === mats.trousers) && !p.geo.attributes.color) vcolor(p.geo, p.t === 'trousers' ? tt : jt);
  }
  // merge per material -> one geometry with groups (draw calls = distinct materials)
  if (vc) for (const p of parts) if (!p.geo.attributes.color) vcolor(p.geo, WHITE3);   // attributes must match to merge
  const byMat = new Map();
  for (const p of parts) { if (!byMat.has(p.mat)) byMat.set(p.mat, []); byMat.get(p.mat).push(p.geo); }
  const merged = [], matList = [];
  for (const [m, geos] of byMat) { const g = mergeGeometries(geos, false); if (!g) { console.warn('[humanoid] merge failed for', m.name); continue; } merged.push(g); matList.push(m); geos.forEach((x) => x.dispose()); }
  const geo = mergeGeometries(merged, true);
  merged.forEach((x) => x.dispose());
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.8);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-1.3, -0.3, -1.3), new THREE.Vector3(1.3, 2.2, 1.3));
  return { geo, mats: matList, tris: geo.index.count / 3, skin: mats.skin };
}
// Round 3, critic #5: the free RIGHT hand closes. The scan's hand is one fused mitt, fingers already half curled
// toward the thigh; measured in the hand frame (t down the hand from the wrist joint, n toward the palm, k across
// the knuckles, i.e. forward) the back of the hand runs flat at n -2.5 cm to t 6 cm and the knuckles turn at t ~7 cm.
// A baked morph target curls everything past that line about the knuckle axis: 37° at the MCP, a further 46° past
// 2.8 cm of finger (the PIP), the thumb (forward of k 3.6 cm, above t 9.5 cm, on the palm side) left where it is.
// The morph runs before the skinning, so it rides every clip; humanoid.update drives it from the clip (FIST_CLIPS).
const NO_FIST = typeof location !== 'undefined' && /[?&]heroFist=0/.test(location.search);
const FIST_Q = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('fistK') || '').split(',').map(Number) : [];
function heroFistMorph(geo, R) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  if (!si || !sw || !nrm) { if (CIV_DBG) console.info("[humanoid] fist: no attrs", !!si, !!sw, !!nrm); return; }
  const bi = R.index.RightHand, H = new THREE.Vector3(...R.joints.RightHand), F = new THREE.Vector3(...R.joints.RightForeArm);
  const ax = H.clone().sub(F).normalize(), n = new THREE.Vector3(1, 0, 0).addScaledVector(ax, -ax.x).normalize(), k = new THREE.Vector3().crossVectors(ax, n);
  // Fix round 4 (critic #3): one pivot for the whole finger swung the tips 8 cm round the MCP and parked them at
  // the wrist joint, INSIDE the poplin cuff, so the closed hand showed a white plug between thumb and fingers.
  // Measured off the scan (t down the hand from the wrist, n toward the palm): the back of the hand runs flat to
  // t 6 cm, the MCP heads turn at 6.8, the fused fingers reach t 12.1 already curled ~30° toward the palm. Two
  // pivots now: the MCP line, and the PIP 3 cm down the finger; the tips land at t ~3 cm on the palm, where a
  // fist's do. Two targets — the half-closed hand and the rest of the way — so the mid-curl is a rigid pose
  // and not the chord of the arc (one target at 0.35 shortened every finger to 40 % of its length).
  const tK = FIST_Q[2] || 0.068, nK = -0.012, th1 = FIST_Q[0] || 0.70, th2 = FIST_Q[1] || 1.10;
  const piv1 = H.clone().addScaledVector(ax, tK).addScaledVector(n, nK);
  const piv2 = H.clone().addScaledVector(ax, tK + 0.030).addScaledVector(n, 0.008);
  const N = pos.count, dA = new Float32Array(N * 3), dB = new Float32Array(N * 3), nA = new Float32Array(N * 3), nB = new Float32Array(N * 3);
  const d = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), o = new THREE.Vector3(), on = new THREE.Vector3();
  const vh = new THREE.Vector3(), nh = new THREE.Vector3(), vf = new THREE.Vector3(), nf = new THREE.Vector3();
  // the hand at a fraction f of the curl: PIP first (about its own axis, in bind space), then the MCP carries the
  // finger and its PIP with it; the MCP heads rise on the back of the hand as the fingers come down (the ridge)
  const curl = (f, a1, a2, ridge, outP, outN) => {
    q2.setFromAxisAngle(k, th2 * a2 * f); q1.setFromAxisAngle(k, th1 * a1 * f);   // +about k takes t toward n
    outP.copy(o);
    if (a2 > 0) outP.sub(piv2).applyQuaternion(q2).add(piv2);
    outP.sub(piv1).applyQuaternion(q1).add(piv1).addScaledVector(n, -ridge * f);
    outN.copy(on);
    if (a2 > 0) outN.applyQuaternion(q2);
    outN.applyQuaternion(q1);
  };
  let moved = 0;
  for (let i = 0; i < N; i++) {
    let w = 0;
    for (let j = 0; j < 4; j++) if (si.getComponent(i, j) === bi) w += sw.getComponent(i, j);
    if (w < 0.25) continue;
    d.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(H);
    const t = d.dot(ax), pn = d.dot(n), pk = d.dot(k);
    if (t < tK - 0.026) continue;
    // the thumb: forward of the index finger, on the palm side, short of the fingertips
    // (broad fades: two neighbours an angle apart at 5 cm from the pivot open a gap of 5 cm x that angle)
    const thumb = sstep((pk - 0.018) / 0.030) * sstep((pn + 0.005) / 0.030) * (1 - sstep((t - 0.085) / 0.030));
    const wk = (1 - 0.9 * thumb) * sstep((w - 0.25) / 0.35);
    const a1 = sstep((t - (tK - 0.012)) / 0.03) * wk, a2 = sstep((t - (tK + 0.022)) / 0.024) * wk;
    const ridge = 0.006 * gauss(t - tK, 0.012) * sstep((-pn - 0.004) / 0.014) * sstep((w - 0.25) / 0.35);
    if (a1 < 1e-4 && ridge < 1e-5) continue;
    o.set(pos.getX(i), pos.getY(i), pos.getZ(i)); on.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    curl(0.5, a1, a2, ridge, vh, nh); curl(1.0, a1, a2, ridge, vf, nf);
    dA[i * 3] = vh.x - o.x; dA[i * 3 + 1] = vh.y - o.y; dA[i * 3 + 2] = vh.z - o.z;
    dB[i * 3] = vf.x - vh.x; dB[i * 3 + 1] = vf.y - vh.y; dB[i * 3 + 2] = vf.z - vh.z;
    nA[i * 3] = nh.x - on.x; nA[i * 3 + 1] = nh.y - on.y; nA[i * 3 + 2] = nh.z - on.z;
    nB[i * 3] = nf.x - nh.x; nB[i * 3 + 1] = nf.y - nh.y; nB[i * 3 + 2] = nf.z - nh.z;
    moved++;
  }
  if (CIV_DBG) console.info('[humanoid] fist morph verts', moved, 'of', pos.count);
  if (!moved) return;
  geo.morphAttributes.position = [new THREE.BufferAttribute(dA, 3), new THREE.BufferAttribute(dB, 3)];
  geo.morphAttributes.normal = [new THREE.BufferAttribute(nA, 3), new THREE.BufferAttribute(nB, 3)];
  geo.morphTargetsRelative = true;
  geo.userData.fistVerts = moved;
}
// how closed the free hand is per clip (0 = the scan's own relaxed curl, 1 = the fist)
// (fix round 4: idle 0.35 -> 0.2, the fingers curl without balling; the two-pivot morph closes them properly at 1)
const FIST_CLIPS = { idle: 0.2, idle_combat: 1, jab: 1, straight: 1, hook: 1, uppercut: 1, kick: 0.9, roundhouse: 0.9, guard: 1, guard_hit: 1, dodge: 0.8,
  grab: 0.5, throw: 0.7, heat_finisher: 1, taunt: 0.6, hit_light: 0.7, hit_heavy: 0.5, stumble: 0.3, knockdown: 0.2, getup: 0.4, dead: 0, walk: 0.15, run: 0.35, phone: 0.3, smoke: 0.3 };
// enemy.js's own clips (the persona moves, its stance shuffles 'es_*' / idles 'ei_*', combat's reactions 'cx_*') close
// the hand too: on a scan with open hands (the story cast) a haymaker thrown flat-handed was a slap. The coward slaps.
const FIST_MOVES = { brute_haymaker: 1, brute_tackle: 0.7, guard_knee: 1, guard_headbutt: 1, coward_slaps: 0.1, coward_lowkick: 0.9 };
function fistFor(name) {
  if (!name) return 0;
  const f = FIST_CLIPS[name] ?? FIST_MOVES[name];
  if (f != null) return f;
  return /^e[si]_/.test(name) ? 1 : /^cx_/.test(name) ? 0.6 : 0;
}
function driveFist(h, dt) {
  const m = h.skinned, inf = m.morphTargetInfluences;
  if (!inf || !inf.length) return;
  const want = FIST_Q[3] != null && !Number.isNaN(FIST_Q[3]) ? FIST_Q[3] : fistFor(h.currentName);
  const cur = h._fist == null ? want : h._fist;
  const w = dt >= 1 || !(dt > 0) ? want : cur + (want - cur) * Math.min(1, dt * 12);   // (a frozen shot runs at dt 0)
  h._fist = w;
  // two targets in series: the first half of the curl, then the rest (see heroFistMorph)
  inf[0] = Math.min(1, 2 * w);
  if (inf.length > 1) inf[1] = Math.max(0, 2 * w - 1);
  if (inf.length < 4) return;
  // the story cast (castFistMorph): targets 2 / 3 are the LEFT hand. It closes round what it carries (the attaché's
  // handle: CAST_GRIP, not a full fist — the bar is 1.6 cm thick) and otherwise follows the clip like the right
  const carry = h.props.prop && PROP_SLOTS[h.propKind] && PROP_SLOTS[h.propKind].bone === 'LeftHand';
  const wantL = carry ? Math.max(CAST_GRIP, want) : want;
  const curL = h._fistL == null ? wantL : h._fistL;
  const wl = dt >= 1 || !(dt > 0) ? wantL : curL + (wantL - curL) * Math.min(1, dt * 12);
  h._fistL = wl;
  inf[2] = Math.min(1, 2 * wl); inf[3] = Math.max(0, 2 * wl - 1);
}
// The story cast's fists. The Meshy hands are OPEN (a relaxed A-pose, fingers together and a little curled), and a
// jab, a guard or the attaché's handle with the fingers out reads as a slap / a hook-hand. heroFistMorph's two-pivot
// curl (MCP, then PIP), generalised to either hand and measured on THIS scan's own hand instead of the v1 constants:
// the hand's frame is the principal axes of its Hand-weighted vertices (length / width / thickness), the palm is the
// side the relaxed fingertips already lean to, the thumb the forward edge. Targets [R half, R full, L half, L full]
// (driveFist). Computed once per scan (the lod0 geometry is the same for every body built from it) and shared.
const CAST_GRIP = 0.82;
// ?castFist=mcp,pip,dip (radians at the full fist) for tuning; the cache is per page load
const CAST_FQ = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('castFist') || '').split(',').map(Number) : [];
function eig3(C) {                                   // Jacobi: eigenvectors of a symmetric 3x3, largest first
  const a = C.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
    if (Math.abs(a[p][q]) < 1e-14) continue;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
  }
  return [0, 1, 2].map((i) => ({ l: a[i][i], v: new THREE.Vector3(v[0][i], v[1][i], v[2][i]) })).sort((x, y) => y.l - x.l);
}
function castHandFrame(pos, si, sw, bi, H) {
  const pts = [], c = new THREE.Vector3(), d = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    let w = 0; for (let j = 0; j < 4; j++) if (si.getComponent(i, j) === bi) w += sw.getComponent(i, j);
    if (w > 0.5) { const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)); pts.push(p); c.add(p); }
  }
  if (pts.length < 60) return null;
  c.divideScalar(pts.length);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) { d.subVectors(p, c); const e = [d.x, d.y, d.z]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += e[a] * e[b]; }
  const [e1, e2, e3] = eig3(C);
  const ax = e1.v.clone(); if (ax.dot(d.subVectors(c, H)) < 0) ax.negate();
  let L = 0; for (const p of pts) L = Math.max(L, d.subVectors(p, H).dot(ax));
  // the palm: where the relaxed fingertips lean (off the hand's own centre line)
  let lean = 0; for (const p of pts) { d.subVectors(p, c); if (d.dot(ax) > L - 0.035 - c.clone().sub(H).dot(ax)) lean += d.dot(e3.v); }
  const n = e3.v.clone().multiplyScalar(lean >= 0 ? 1 : -1);
  const th = e2.v.clone(); if (th.z < 0) th.negate();                     // the thumb: the hand's forward edge
  return { ax, n, th, L, c };
}
function castFistMorph(geo, R, SC, key) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  if (!si || !sw || !nrm) return;
  if (!SC.fist || SC.fist.n !== pos.count) {
    const N = pos.count, T = [0, 1, 2, 3].map(() => ({ p: new Float32Array(N * 3), n: new Float32Array(N * 3) }));
    const out = { n: N, T, frames: {}, moved: 0 };
    const d = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), o = new THREE.Vector3(), on = new THREE.Vector3();
    const vh = new THREE.Vector3(), nh = new THREE.Vector3(), vf = new THREE.Vector3(), nf = new THREE.Vector3();
    ['Right', 'Left'].forEach((side, sIdx) => {
      const bi = R.index[side + 'Hand'], H = new THREE.Vector3(...R.joints[side + 'Hand']);
      const F = castHandFrame(pos, si, sw, bi, H);
      if (!F) return;
      const { ax, n, th, L } = F, k = new THREE.Vector3().crossVectors(ax, n);   // +about k takes ax toward the palm
      // v1's hand (12.1 cm) scaled to this one: MCP line at 55 % of the hand, PIP 3.2 cm past it, and — these fingers
      // are 7 cm long and straight, v1's were short, fused and already curled — a DIP 2.2 cm past that: with only two
      // pivots the closed hand read as a claw from the palm side (the tips standing off it)
      const s = L / 0.121, tK = 0.55 * L, nK = -0.012 * s;
      const th1 = CAST_FQ[0] || 0.95, th2 = CAST_FQ[1] || 1.30, th3 = CAST_FQ[2] || 0.75;
      const piv1 = H.clone().addScaledVector(ax, tK).addScaledVector(n, nK);
      const piv2 = H.clone().addScaledVector(ax, tK + 0.032).addScaledVector(n, 0.008 * s);
      const piv3 = H.clone().addScaledVector(ax, tK + 0.054).addScaledVector(n, 0.010 * s);
      const q3 = new THREE.Quaternion();
      const curl = (f, a1, a2, a3, ridge, outP, outN) => {
        q3.setFromAxisAngle(k, th3 * a3 * f); q2.setFromAxisAngle(k, th2 * a2 * f); q1.setFromAxisAngle(k, th1 * a1 * f);
        outP.copy(o);
        if (a3 > 0) outP.sub(piv3).applyQuaternion(q3).add(piv3);
        if (a2 > 0) outP.sub(piv2).applyQuaternion(q2).add(piv2);
        outP.sub(piv1).applyQuaternion(q1).add(piv1).addScaledVector(n, -ridge * f);
        outN.copy(on); if (a3 > 0) outN.applyQuaternion(q3); if (a2 > 0) outN.applyQuaternion(q2); outN.applyQuaternion(q1);
      };
      const A = T[sIdx * 2], B = T[sIdx * 2 + 1];
      let palm = -1;
      for (let i = 0; i < N; i++) {
        let w = 0; for (let j = 0; j < 4; j++) if (si.getComponent(i, j) === bi) w += sw.getComponent(i, j);
        if (w < 0.25) continue;
        d.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(H);
        const t = d.dot(ax), pn = d.dot(n), pt = d.dot(th);
        if (Math.abs(t - (tK - 0.012)) < 0.008) palm = Math.max(palm, pn);   // the palm's surface just above the MCP line
        if (t < tK - 0.026) continue;
        // the thumb: the forward edge on the palm side, short of the fingertips — it stays, the fingers close onto it
        const thumb = sstep((pt - 0.018 * s) / (0.030 * s)) * sstep((pn + 0.005) / 0.030) * (1 - sstep((t - (tK + 0.017 * s)) / 0.030));
        const wk = (1 - 0.9 * thumb) * sstep((w - 0.25) / 0.35);
        const a1 = sstep((t - (tK - 0.012)) / 0.03) * wk, a2 = sstep((t - (tK + 0.022)) / 0.024) * wk, a3 = sstep((t - (tK + 0.046)) / 0.018) * wk;
        const ridge = 0.006 * gauss(t - tK, 0.012) * sstep((-pn - 0.004) / 0.014) * sstep((w - 0.25) / 0.35);
        if (a1 < 1e-4 && ridge < 1e-5) continue;
        o.set(pos.getX(i), pos.getY(i), pos.getZ(i)); on.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
        curl(0.5, a1, a2, a3, ridge, vh, nh); curl(1.0, a1, a2, a3, ridge, vf, nf);
        A.p[i * 3] = vh.x - o.x; A.p[i * 3 + 1] = vh.y - o.y; A.p[i * 3 + 2] = vh.z - o.z;
        B.p[i * 3] = vf.x - vh.x; B.p[i * 3 + 1] = vf.y - vh.y; B.p[i * 3 + 2] = vf.z - vh.z;
        A.n[i * 3] = nh.x - on.x; A.n[i * 3 + 1] = nh.y - on.y; A.n[i * 3 + 2] = nh.z - on.z;
        B.n[i * 3] = nf.x - nh.x; B.n[i * 3 + 1] = nf.y - nh.y; B.n[i * 3 + 2] = nf.z - nh.z;
        out.moved++;
      }
      // the grip: a 1.6 cm bar laid across the palm just past the MCP line, inside the curled fingers, running along
      // the hand's width — in the Hand bone's bind frame, the way PROP_SLOTS are written (deriveGrip's convention)
      const g = H.clone().addScaledVector(ax, tK + 0.004).addScaledVector(n, (palm > 0 ? palm : 0.022) + 0.011);
      const bw = R.world[side + 'Hand'], inv = bw.quaternion.clone().invert();
      const gl = g.sub(bw.position).applyQuaternion(inv), bar = th.clone().applyQuaternion(inv);
      const yaw = Math.atan2(bar.z, bar.x);
      out.frames[side] = { L: +L.toFixed(3), tK: +tK.toFixed(3), palm: +palm.toFixed(3), grip: [+gl.x.toFixed(4), +gl.y.toFixed(4), +gl.z.toFixed(4)], yaw: +(HPI - yaw).toFixed(4) };
    });
    SC.fist = out;
    const G = out.frames.Left;
    // the attaché hangs from this hand's own closed fist (propGripCheck verifies it against the morphed vertices)
    if (G) SC.slots = { ...PROP_SLOTS, briefcase: { bone: 'LeftHand', position: G.grip, rotation: [0, G.yaw, 0] } };
    if (CIV_DBG) console.info('[humanoid] cast fist', key, JSON.stringify(out.frames), 'verts', out.moved);
  }
  const F = SC.fist;
  if (!F.moved) return;
  F.attrP = F.attrP || F.T.map((t) => new THREE.BufferAttribute(t.p, 3));
  F.attrN = F.attrN || F.T.map((t) => new THREE.BufferAttribute(t.n, 3));
  geo.morphAttributes.position = F.attrP;
  geo.morphAttributes.normal = F.attrN;
  geo.morphTargetsRelative = true;
  geo.userData.fistVerts = F.moved;
}

// ---------------------------------------------------------------- 渋沢 健人: the client's own mesh
// The client supplied docs/ref/hero-model.glb — one unskinned 896k-triangle scan, the attaché fused into his left
// hand, legs cut off at mid-thigh, no skeleton. An offline pass (see docs/reports/character.md) decimates it with a
// quadric edge collapse that is never allowed to cross a uv chart, splits the case out by flood fill and auto-skins
// what is left to the §6 bones by capsule distance with a two-bone smoothstep blend, writing
//   assets/hero/hero.json   joints measured off the scan + part table
//   assets/hero/hero.bin    position/normal/uv/skinIndex/skinWeight/index for lod0-2 and the attaché
//   assets/hero/hero_{albedo,orm,normal}.jpg
// The scan stops at y ≈ 0.75, so the trousers, shoes and soles below that are lofted here onto the same bones and
// merged into the same geometry. If any of it fails to load the hero silently falls back to the procedural model.
const HERO = { state: 'idle', data: null, bin: null, mat: null, rig: null, promise: null };
// The scans' 15 maps through fetch + createImageBitmap: decoded off the main thread and in parallel (0.1 s for all
// fifteen) rather than one <img> decode at a time on first upload. flipY is false on every one of these maps anyway,
// which is the one thing an ImageBitmap cannot do at upload.
const HUM_TIME = typeof location !== 'undefined' && location.search.includes('humTime');
// [mobile] ?texmax=<px> (the mobile profile's 1024): a map bigger than that becomes a smaller BITMAP here. three's own
// upload-time resize (engine.js) would redraw it into a canvas, and a canvas obeys flipY where a bitmap does not —
// measured: the hero's suit came out in patches. Resized as a bitmap it keeps exactly the orientation it had.
// ?scanTex / ?pedTex / ?heroTex=<px> cap the enemies' & cast's / the passers-by's / the hero's maps (mobileProfile.js tiers:
// the passers-by are small on a phone's screen, the hero is on it all the time). Each falls back to ?texmax.
const TQ = (k) => (typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get(k)) || 0 : 0);
const TEX_MAX = TQ('texmax'), PED_TEX = TQ('pedTex') || TEX_MAX, SCAN_TEX = TQ('scanTex') || TEX_MAX, HERO_TEX = TQ('heroTex') || TEX_MAX;
const texCap = (url) => (url.startsWith('assets/peds/') ? PED_TEX : url.startsWith('assets/hero/') ? HERO_TEX : SCAN_TEX);
async function fitBitmap(bmp, cap = TEX_MAX) {
  const m = Math.max(bmp.width, bmp.height);
  if (!(cap >= 128) || m <= cap) return bmp;
  const w = Math.max(1, Math.round(bmp.width * cap / m)), h = Math.max(1, Math.round(bmp.height * cap / m));
  const opt = { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
  let small = null;
  try { small = await createImageBitmap(bmp, { ...opt, resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }); } catch (e) { small = null; }
  if (!small || small.width !== w) {                 // no resize option (older Safari): draw it smaller, same orientation
    if (small) small.close();
    try { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(bmp, 0, 0, w, h); small = await createImageBitmap(c, opt); c.width = c.height = 0; }
    catch (e) { return bmp; }
  }
  bmp.close();
  return small;
}
// [mobile] with a cap, the image is decoded straight at its capped size (the header gives its dimensions: no full-size
// 2048² decode first — 16 MB each, and a scan brings three or four) and at most two decodes run at once
function imageDims(u) {
  if (u[0] === 0x89 && u[1] === 0x50) return [(u[16] << 24 | u[17] << 16 | u[18] << 8 | u[19]) >>> 0, (u[20] << 24 | u[21] << 16 | u[22] << 8 | u[23]) >>> 0];
  if (u[0] !== 0xFF || u[1] !== 0xD8) return null;
  for (let i = 2; i + 9 < u.length;) {
    if (u[i] !== 0xFF) { i++; continue; }
    const m = u[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [u[i + 7] << 8 | u[i + 8], u[i + 5] << 8 | u[i + 6]];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    i += 2 + (u[i + 2] << 8 | u[i + 3]);
  }
  return null;
}
let decodes = 0; const decodeQ = [];
const decodeSlot = () => (!TEX_MAX || decodes < 2 ? (decodes++, Promise.resolve()) : new Promise((res) => decodeQ.push(res)).then(() => { decodes++; }));
const decodeDone = () => { decodes--; const n = decodeQ.shift(); if (n) n(); };
async function loadTex(url) {
  if (typeof createImageBitmap !== 'function') return new THREE.TextureLoader().loadAsync(url);
  const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
  const blob = await r.blob();
  if (HUM_TIME) console.info('[humanoid] t', Math.round(performance.now()), url, 'fetched');
  const opt = { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }, cap = texCap(url);
  let bmp;
  await decodeSlot();
  try {
    let dims = null;
    if (cap >= 128) { try { dims = imageDims(new Uint8Array(await blob.slice(0, 65536).arrayBuffer())); } catch (e) { dims = null; } }
    if (dims && Math.max(dims[0], dims[1]) > cap) {
      const k = cap / Math.max(dims[0], dims[1]);
      bmp = await createImageBitmap(blob, { ...opt, resizeWidth: Math.max(1, Math.round(dims[0] * k)), resizeHeight: Math.max(1, Math.round(dims[1] * k)), resizeQuality: 'medium' });
    } else bmp = await createImageBitmap(blob, opt);
    bmp = await fitBitmap(bmp, cap);                 // (no-op when the decode already obeyed the size)
  } finally { decodeDone(); }
  if (HUM_TIME) console.info('[humanoid] t', Math.round(performance.now()), url, 'decoded');
  const t = new THREE.Texture(bmp);
  t.needsUpdate = true;
  return t;
}
const HERO_URL = 'assets/hero/';
const TYPED = { Float32Array, Uint16Array, Uint32Array, Uint8Array };
function loadHero() {
  if (HERO.promise) return HERO.promise;
  HERO.state = 'loading';
  HERO.promise = (async () => {
    const get = async (f, kind) => { const r = await fetch(HERO_URL + f); if (!r.ok) throw new Error(f + ' ' + r.status); return kind === 'json' ? r.json() : r.arrayBuffer(); };
    const [json, bin] = await Promise.all([get('hero.json', 'json'), get('hero.bin', 'bin')]);
    if (HUM_TIME) console.info('[humanoid] t', Math.round(performance.now()), 'hero bin');
    const [map, orm, nrm, region] = await Promise.all(['hero_albedo.jpg', 'hero_orm.jpg', 'hero_normal.png', 'hero_region.png']
      .map((f) => (f === 'hero_region.png' ? loadTex(HERO_URL + f).catch(() => null) : loadTex(HERO_URL + f))));
    for (const t of [map, orm, nrm, region]) if (t) { t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
    HERO.region = region;
    map.colorSpace = THREE.SRGBColorSpace;
    HERO.data = json; HERO.bin = bin;
    HERO.rig = buildRig(json.joints);
    // ORM: R = occlusion (baked offline in assets/hero/pipeline/delight.py — ray-cast against a voxel grid of the
    // whole body, times the cavity term; it used to ship flat white, so the hero had no cavity information at all),
    // G = roughness, B = metalness. r186 samples aoMap through texture.channel, which is 0 = the `uv` attribute,
    // so no uv2 is needed. The normal is a 2048 PNG: as a JPEG the 4:2:0 chroma pass mushed tangent X and Y, which
    // is exactly why the wool showed no fold shading. Single sided — capHoles() closes what the split left open.
    // ?heroDebug=albedo|noNormal|noAO isolates which map a defect lives in (the scan ships three of them and a
    // black sliver on a lapel can come from any one)
    const dbg = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('heroDebug') : null;
    const mq = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('heroMat') || '').split(',') : [];
    if (dbg === 'solid') HERO.mat = new THREE.MeshBasicMaterial({ name: 'heroScan', color: 0x30c060, side: THREE.DoubleSide });
    else if (dbg === 'solid1') HERO.mat = new THREE.MeshBasicMaterial({ name: 'heroScan', color: 0x30c060 });
    else if (dbg === 'albedo') HERO.mat = new THREE.MeshBasicMaterial({ name: 'heroScan', map, vertexColors: true });
    // Physical, not Standard: wool needs a grazing sheen and so does skin — without it the ear and the nose are
    // opaque matte brown and the suit has no bloom off the shoulder.
    // sheenColor was 0xd8b49c — a tan. Over a near-black worsted that grazing term is the whole silhouette edge, and
    // it turned the charcoal two-piece brown (measured R/B 1.50 against the reference sheet's 0.75). Wool's sheen is
    // the fibre's own colour, which on this suit is neutral-cool.
    // Round 6: `sheen` is an ADDITIVE lobe that does not scale with albedo. sheen 0.20 × 0xb4bac4 is a ~0.10
    // reflectance sitting on top of a 1.2 % worsted — eight times the cloth's own diffuse, and it was the single
    // biggest reason the two-piece rendered as mid-grey flannel. Real worsted does have a grazing sheen, but the
    // fibre is dyed near-black and so is its sheen: 0x4a4e57 at 0.30 keeps the terminator roll off the shoulder
    // and costs the flat of the chest almost nothing. ?heroMat=sheen,sheenCol,env sweeps it.
    else HERO.mat = new THREE.MeshPhysicalMaterial({ name: 'heroScan', map, aoMap: dbg === 'noAO' ? null : orm, aoMapIntensity: 0.85,
      roughnessMap: orm, metalnessMap: orm, normalMap: dbg === 'noNormal' ? null : nrm, roughness: 1, metalness: 1, vertexColors: true,
      sheen: mq[0] ? +mq[0] : 0.30, sheenRoughness: 0.58, sheenColor: new THREE.Color(mq[1] ? parseInt(mq[1], 16) : 0x4a4e57) });
    if (HERO.mat.sheenColor) { HERO.sheen0 = HERO.mat.sheenColor.clone(); HERO.sheenK = HERO.mat.sheen; }
    envTrack(HERO.mat, mq[2] ? +mq[2] : 1.9);
    // The whole hero is ONE material over one scanned atlas, and that atlas is a photograph: the worsted reads
    // 1.2 % linear, darker than black velvet, so through an ACES curve no honest irradiance can put it at a
    // quarter of L 110 granite. The compensation rides the INDIRECT term only (dark charts, below the chin),
    // never the albedo and never the direct key — so the night frame, where the key does the work, is untouched
    // and only the daylight ambient the scene cannot supply gets made up. Gamut floors: the scan's own skin
    // sits at linear g/r 0.50, b/r 0.33, well clear of them, and nothing he wears is red.
    // wedge 1: face, neck, ears and the scan's own hands are all charts on this one atlas, so the skin clamp has
    // to be albedo-gated rather than material-gated. aa[1] 0.20: the pomade chart threw 1-2 px white/cyan
    // fireflies across the crown at the flagship camera, and those crawl violently in motion.
    // Round 6 measured it: the jacket's median luminance was 68/255 in 13:00 sun against 25 on the client's own
    // contact sheet — 2.7x, a mid-grey flannel where the source is near-black worsted. The albedo was never the
    // problem (?heroDebug=albedo renders the atlas straight and it is correct); this line was. gnd 21 put
    // 17 units of granite bounce on a 1.2 %-albedo chart, which is nine tenths of everything the suit returned.
    // The trousers, lofted here and carrying the procedural `suit` material at gnd 8 / hemi 5, measured 28 in the
    // same frame — so the scan's own numbers are now the garment ones, and the jacket, the trousers and the
    // reference sheet finally agree. ?heroLit=hemi,hemiN,gnd,gndN sweeps it.
    const lit = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('heroLit') || '').split(',').map(Number) : [];
    // Double-sided with a dark lining, like the mob scans: the attaché was cut out of his left fist offline and left
    // a 1 m open boundary round the knuckles and the watch, and single-sided the street showed through the wrist.
    // The shadow pass keeps one side (the round-5 cost the old DoubleSide paid was the depth pass, not this).
    // Fix round 1: single-sided again. finish.mjs closes every hole the attaché cut and the scanner left (the
    // wrist, the palm, the coat where each fist was fused to it, the armpits), verified front-faces-only in six
    // clips (?heroDebug=solid1), and the inside the double side rasterised cost 7 fps in character_hero (45 -> 52).
    // ?heroSide=2 restores the double-sided lining for A/B.
    if (!dbg && typeof location !== 'undefined' && location.search.includes('heroSide=2')) { HERO.mat.side = THREE.DoubleSide; HERO.mat.shadowSide = THREE.BackSide; }
    // back 0.5, not 0.2: what is still seen from inside after finish.mjs closed the holes is a fold of cloth (the
    // lapel roll, a sleeve's lining at the cuff), and at a fifth of its light every one of them was a black shard
    // Fix round 4 (critic #6): night ground 2.4 -> 4.6 and its floor 0.10 -> 0.22, plus a 0.3 wrap on the dark charts:
    // the trousers and the jacket skirt measured sRGB < 8 on a magenta crossing that bounced onto everything else.
    charShader(HERO.mat, { gamut: HERO_GAMUT, hemi: lit[0] || 4.4, hemiN: lit[1] || 5.2, dark: 1, lift: 1, wedge: 1,
      gnd: lit[2] || 6.6, gndN: lit[3] || 4.6, gndFloor: 0.22, aa: [0.085, 0.20], back: 0.5, patch: true, sss: 1, hair: 1, wrap: 0.3,
      region: dbg ? null : HERO.region });
    // ?heroU=uWedge=0,uSkinHair.x=0,uGamut.x=0 : zero one shading term at a time (debug)
    const hu = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('heroU') : null;
    if (hu && HERO.mat.userData.charShader) for (const kv of hu.split(',')) {
      const [path, val] = kv.split('='), [k, c] = path.split('.'), U = HERO.mat.userData.charShader[k];
      if (U) { if (c && U.value && c in U.value) U.value[c] = +val; else if (!c) U.value = +val; }
    }
    VARIANTS.kento.joints = json.joints;            // bones measured off HIS limbs, not the generic rig
    VARIANTS.kento.glb = true;
    deriveGrip();
    HERO.state = 'ready';
    return HERO;
  })().catch((e) => { HERO.state = 'failed'; console.warn('[humanoid] hero scan unavailable, procedural model in use:', e.message); return null; });
  return HERO.promise;
}
// ---------------------------------------------------------------- where his fist actually closes
// Round 4 tuned `PROP_SLOTS.briefcase.position` to [0.016, 0.088, 0] against the procedural finger chain that
// PROP_GRIP used to close at build time. The scan's hand is one rigid piece, and 0.088 m down LeftHand's local
// +Y is 12 mm PAST his fingertips: the case hung in open air with lit pavement visible between the fingers and
// the handle. This is not a number to tune — hero.bin still carries the attaché the scanner captured welded
// into that fist (parts case0/case1), so the bar his fingers close around is in the data. Measure it.
//
// Result in the LeftHand bind frame: the arch apex sits at y ≈ 0.022 (the hand mask spans 0.013..0.076), centred
// x ≈ 0.014 / z ≈ 0.039, with the bar running ~38° off the bone's +Z. `makeProp` authors the handle with its
// apex at the group origin, so the slot position IS the apex and the case hangs a full arch below it.
function deriveGrip() {
  try {
    const e = HERO.data && HERO.data.parts && HERO.data.parts.case0;
    const bw = HERO.rig && HERO.rig.world.LeftHand;
    if (!e || !bw) return;
    const src = new TYPED[e.position.t](HERO.bin, e.position.o, e.position.n);
    const inv = bw.quaternion.clone().invert(), v = new THREE.Vector3(), pts = [];
    let apex = Infinity;
    for (let i = 0; i < e.count; i++) {
      v.set(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]).sub(bw.position).applyQuaternion(inv);
      pts.push([v.x, v.y, v.z]);
      if (v.y < apex) apex = v.y;
    }
    // walk down from the apex until the cross-section stops being a bar and becomes a case lid
    let lid = apex + 0.008;
    for (let y = apex + 0.008; y < apex + 0.09; y += 0.004) {
      const sl = pts.filter((p) => p[1] >= y && p[1] < y + 0.004);
      if (sl.length < 4) continue;
      let w = 0;
      for (const a of sl) for (const b of sl) { const d = Math.hypot(a[0] - b[0], a[2] - b[2]); if (d > w) w = d; }
      if (w > 0.15) break;
      lid = y + 0.004;
    }
    const arch = pts.filter((p) => p[1] < lid);
    if (arch.length < 20) return;
    let cx = 0, cz = 0;
    for (const p of arch) { cx += p[0]; cz += p[2]; }
    cx /= arch.length; cz /= arch.length;
    // principal axis of the arch in the bone's XZ plane = the direction the handle bar runs
    let sxx = 0, szz = 0, sxz = 0;
    for (const p of arch) { const dx = p[0] - cx, dz = p[2] - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
    const yaw = 0.5 * Math.atan2(2 * sxz, sxx - szz);     // the bar is authored along the prop's local +Z
    PROP_SLOTS.briefcase.position = [+cx.toFixed(4), +apex.toFixed(4), +cz.toFixed(4)];
    PROP_SLOTS.briefcase.rotation = [0, +(HPI - yaw).toFixed(4), 0];
    HERO.grip = { apex: +apex.toFixed(4), lid: +lid.toFixed(4), cx: +cx.toFixed(4), cz: +cz.toFixed(4), yaw: +(HPI - yaw).toFixed(4), n: arch.length };
  } catch (err) { console.warn('[humanoid] grip derive failed', err.message); }
}
// Fan-cap every open boundary loop. The offline split cuts the hands free of the coat the scanner welded them to
// and drops ~250 triangles of crevice at the hips; the old fix was `side: DoubleSide`, which rasterised all 32.8 k
// triangles twice into the colour pass AND the shadow map and fed flipped backface normals into the trouser
// silhouette. Vertices are split at every one of the 471 uv charts, so the boundary has to be found on a
// position-welded copy of the graph or every chart seam would look like a hole.
//
// The fan itself was the bug the critic saw as "dark torn flaps all over the jacket and the thigh" and as "orange
// spikes out of the cuff": 35 of the 61 capped loops span most of the ATLAS (uv span up to 0.99), because the two
// sides of a crevice belong to different uv charts. Fanning them reuses those uvs, so the cap samples whatever
// happens to live between the two charts — usually a black gutter — and inherits normals pointing in two
// directions. Caps now get their OWN vertices: one coherent uv from the loop's own chart, one averaged normal,
// and any fan triangle that faces more than 80° away from the loop is dropped instead of shipped as a spike.
// (?nocap in the url skips it — a debug switch for telling a cap artifact from a hole)
const NO_CAP = typeof location !== 'undefined' && location.search.includes('nocap');
function capHoles(g, maxLoop = 160) {
  if (NO_CAP) return g;
  const pos = g.attributes.position, idx = g.index.array, n = pos.count;
  const nrm = g.attributes.normal, uvA = g.attributes.uv, siA = g.attributes.skinIndex, swA = g.attributes.skinWeight;
  const weld = new Int32Array(n), first = new Map();
  for (let i = 0; i < n; i++) {
    const k = (Math.round(pos.getX(i) * 8192) + ',' + Math.round(pos.getY(i) * 8192) + ',' + Math.round(pos.getZ(i) * 8192));
    const p = first.get(k);
    if (p === undefined) { first.set(k, i); weld[i] = i; } else weld[i] = p;
  }
  const seen = new Map(), rep = new Map();           // directed welded edge -> raw origin vertex
  for (let f = 0; f < idx.length; f += 3) for (let e = 0; e < 3; e++) {
    const a = weld[idx[f + e]], b = weld[idx[f + (e + 1) % 3]];
    if (a === b) continue;
    const key = a * n + b, back = b * n + a;
    if (seen.has(back)) { seen.delete(back); rep.delete(back); } else { seen.set(key, b); rep.set(key, idx[f + e]); }
  }
  if (!seen.size) return g;
  const next = new Map(), org = new Map();
  for (const [key, b] of seen) { const a = (key - b) / n; if (!next.has(a)) { next.set(a, b); org.set(a, rep.get(key)); } }
  const used = new Set(), add = [];
  const ext = { pos: [], nrm: [], uv: [], si: [], sw: [] };   // the caps' own vertices
  const isHand = (i) => {                                     // dominant bone of a vertex, by name
    if (!siA || !swA) return false;
    let b = 0, w = -1;
    for (let k = 0; k < 4; k++) { const x = swA.getComponent(i, k); if (x > w) { w = x; b = siA.getComponent(i, k); } }
    return /Hand$/.test(BONE_NAMES[b] || '');
  };
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), fn = new THREE.Vector3(), nAvg = new THREE.Vector3();
  let dropped = 0;
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop = [];
    let v = start;
    while (v !== undefined && !used.has(v) && loop.length <= maxLoop) { used.add(v); loop.push(org.get(v)); v = next.get(v); }
    if (v !== start || loop.length < 3 || loop.length > maxLoop) continue;
    // Only the small crevices. A fan across a wide boundary — the thigh cut, the armpit the scanner welded shut —
    // is a web that stretches 5 cm every time the arm swings, and maxStretch() catches it as a torn weight.
    // On a hand the limit is 2 cm: at 8.5 cm every gap between two fingers passes, and the four fingers fan into
    // one paddle with the separations left as paint.
    let chord = 0, hand = false;
    const ax = pos.getX(loop[0]), ay = pos.getY(loop[0]), az = pos.getZ(loop[0]);
    for (let i = 0; i < loop.length; i++) {
      if (i) { const d = Math.hypot(pos.getX(loop[i]) - ax, pos.getY(loop[i]) - ay, pos.getZ(loop[i]) - az); if (d > chord) chord = d; }
      if (!hand && isHand(loop[i])) hand = true;
    }
    // 0.085 was tuned when the hands were stripped, which changed which loops the walk reaches. With the scan's
    // hands back the walk also reaches the armpit crevice, and a fan across 8 cm of armpit is a web that stretches
    // 19 cm under hook@0.75 (selfTest.stretch). 0.052 still closes every hip and finger-web gap.
    if (chord > (hand ? 0.02 : 0.052)) continue;
    // the loop's own frame: an averaged normal, and one uv from the chart nearest the loop's uv centroid
    nAvg.set(0, 0, 0);
    let mu = 0, mv = 0;
    for (const i of loop) {
      if (nrm) nAvg.x += nrm.getX(i), nAvg.y += nrm.getY(i), nAvg.z += nrm.getZ(i);
      if (uvA) { mu += uvA.getX(i); mv += uvA.getY(i); }
    }
    if (nAvg.lengthSq() < 1e-9) nAvg.set(0, 1, 0); else nAvg.normalize();
    mu /= loop.length; mv /= loop.length;
    let best = Infinity, bu = mu, bv = mv;
    for (const i of loop) {
      if (!uvA) break;
      const du = uvA.getX(i) - mu, dv = uvA.getY(i) - mv, d = du * du + dv * dv;
      if (d < best) { best = d; bu = uvA.getX(i); bv = uvA.getY(i); }
    }
    const base = n + ext.pos.length / 3;
    for (const i of loop) {                                   // duplicate: same point, coherent uv + normal
      ext.pos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      ext.nrm.push(nAvg.x, nAvg.y, nAvg.z);
      ext.uv.push(bu, bv);
      for (let k = 0; k < 4; k++) { ext.si.push(siA ? siA.getComponent(i, k) : 0); ext.sw.push(swA ? swA.getComponent(i, k) : (k ? 0 : 1)); }
    }
    va.set(pos.getX(loop[0]), pos.getY(loop[0]), pos.getZ(loop[0]));
    for (let i = 1; i < loop.length - 1; i++) {
      vb.set(pos.getX(loop[i]), pos.getY(loop[i]), pos.getZ(loop[i]));
      vc.set(pos.getX(loop[i + 1]), pos.getY(loop[i + 1]), pos.getZ(loop[i + 1]));
      fn.crossVectors(vc.sub(va), vb.clone().sub(va));
      if (fn.lengthSq() < 1e-16 || fn.normalize().dot(nAvg) < 0.17) { dropped++; continue; }   // > 80° off: that is a spike
      add.push(base, base + i + 1, base + i);                 // reverse of the boundary winding
    }
  }
  if (!add.length) return g;
  const extN = ext.pos.length / 3;
  const grow = (attr, arr, size, Type) => {
    const out = new Type(attr.count * size + arr.length);
    out.set(attr.array.subarray ? attr.array.subarray(0, attr.count * size) : attr.array, 0);
    out.set(arr, attr.count * size);
    return new THREE.BufferAttribute(out, size);
  };
  g.setAttribute('position', grow(pos, ext.pos, 3, Float32Array));
  if (nrm) g.setAttribute('normal', grow(nrm, ext.nrm, 3, Float32Array));
  if (uvA) g.setAttribute('uv', grow(uvA, ext.uv, 2, Float32Array));
  if (siA) g.setAttribute('skinIndex', grow(siA, ext.si, 4, Uint16Array));
  if (swA) g.setAttribute('skinWeight', grow(swA, ext.sw, 4, Float32Array));
  const out = new (n + extN + 1 > 65535 ? Uint32Array : Uint16Array)(idx.length + add.length);
  out.set(idx, 0); out.set(add, idx.length);
  g.setIndex(new THREE.BufferAttribute(out, 1));
  g.userData.capped = add.length / 3;
  g.userData.capDropped = dropped;
  return g;
}
// Round 3 dropped the scan's hands and lofted procedural ones on the wrists. That was the wrong trade: the
// procedural hand runs on a DIFFERENT material with a different skin tone (measured 1.9x the cheek's luminance and
// far pinker), butt-joins the sleeve, and reads as four square tubes. The scan's own hands come with his face's
// albedo, his normal map, a thumb, knuckles and the shirt cuff already modelled — see docs/ref/hero-model-views.png
// LEGS/SHOES. They ride the Hand bone rigidly, which is exactly right for everything but a clenched fist.
// ?heroHands=proc restores the lofted hand for A/B.
const HAND_SRC = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('heroHands') || 'scan') : 'scan';
const HAND_BONES = [BONE_NAMES.indexOf('LeftHand'), BONE_NAMES.indexOf('RightHand')];
function stripHands(g) {
  if (HAND_SRC !== 'proc') return g;
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, idx = g.index.array;
  if (!si || !sw) return g;
  const n = si.count, hand = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (HAND_BONES.includes(si.getComponent(i, k))) w += sw.getComponent(i, k);
    hand[i] = w > 0.5 ? 1 : 0;
  }
  const keep = [];
  for (let f = 0; f < idx.length; f += 3) {
    if (hand[idx[f]] && hand[idx[f + 1]] && hand[idx[f + 2]]) continue;
    keep.push(idx[f], idx[f + 1], idx[f + 2]);
  }
  if (keep.length === idx.length) return g;
  const out = new (si.count > 65535 ? Uint32Array : Uint16Array)(keep.length);
  out.set(keep);
  g.setIndex(new THREE.BufferAttribute(out, 1));
  g.userData.handTris = (idx.length - keep.length) / 3;
  return g;
}
function heroPart(name, SC = HERO) {
  const e = SC.data.parts[name]; if (!e) return null;
  const g = new THREE.BufferGeometry();
  for (const [k, n] of [['position', 3], ['normal', 3], ['uv', 2], ['skinIndex', 4], ['skinWeight', 4], ['patch', 1]]) {
    const d = e[k]; if (!d) continue;
    const a = new TYPED[d.t](SC.bin, d.o, d.n);
    // the hero is merged with its lofted legs, and a merge needs one array type per attribute
    g.setAttribute(k === 'patch' ? 'seamPatch' : k, SC === HERO && k === 'patch' ? new THREE.BufferAttribute(Float32Array.from(a, (x) => x / 255), 1)
      : new THREE.BufferAttribute(a, n, k === 'patch'));
  }
  // finish.mjs tints its wrist plugs on a white square of the atlas: stored as an sRGB ratio, used linear
  if (e.color) g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(new Uint8Array(SC.bin, e.color.o, e.color.n), (x) => (x / 255) ** 2.2), 3));
  g.setIndex(new THREE.BufferAttribute(new TYPED[e.index.t](SC.bin, e.index.o, e.index.n), 1));
  if (e.dbg && MOB_DBG === 'groups') {              // pipeline debug channel: limb group per vertex, patches bright
    const d = new TYPED[e.dbg.t](SC.bin, e.dbg.o, e.dbg.n), col = new Float32Array(d.length * 3);
    const C = [[0.75, 0.25, 0.2], [0.2, 0.35, 0.9], [0.15, 0.75, 0.25], [0.45, 0.45, 0.45], [0.75, 0.7, 0.55]];
    for (let i = 0; i < d.length; i++) { const c = C[d[i] & 7] || C[0], k = d[i] >= 8 ? 1.6 : 1; col[i * 3] = Math.min(1, c[0] * k + (d[i] >= 8 ? 0.35 : 0)); col[i * 3 + 1] = Math.min(1, c[1] * k + (d[i] >= 8 ? 0.35 : 0)); col[i * 3 + 2] = c[2] * k * (d[i] >= 8 ? 0.3 : 1); }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  if (e.dbg && MOB_DBG === 'back') {                // patches tinted yellow, so a red back face can be told from a yellow one
    const d = new TYPED[e.dbg.t](SC.bin, e.dbg.o, e.dbg.n), col = new Float32Array(d.length * 3).fill(1);
    for (let i = 0; i < d.length; i++) if (d[i] >= 8) col[i * 3 + 2] = 0;
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  // a mob built with seams.mjs arrives closed: its welds are split per side and every window already has its own
  // patch, and a position-welded pass over the split copies would read each cut as a hole and web it shut again.
  // The hero's finish.mjs bakes the same caps (and patches the holes they could not close) offline.
  const c = SC.data.seams || (SC.data.finished && HAND_SRC !== 'proc') ? g : capHoles(stripHands(g));
  SC.capped = (SC.capped || 0) + (c.userData.capped || 0);
  return c;
}

// ---------------------------------------------------------------- mob scans
// The four street characters the client supplied go through the same offline pipeline as the hero
// (assets/mobs/pipeline/buildMob.mjs) but are simpler to consume: full-body scans, so nothing is lofted back
// on and the whole character is one part with one material. Each has its own joints, measured off its own
// limbs, so a 1.74 m courier and a 1.83 m host do not share a skeleton.
const MOB_URL = 'assets/mobs/';
const MOB_DBG = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('mobDbg') : null;
const MOB_ASSETS = ['enforcer_a', 'enforcer_b', 'wanderer', 'nightlife_king'];
// which scans ship a _region.png (mobface.py). An optional file that does not exist is still a 404 in the console on
// every boot (nightlife_king's was), so only these are ever requested; the peds have none (manifest `region: false`).
const MOB_REGION = new Set(['enforcer_a', 'enforcer_b', 'wanderer']);
const SCANS = {};
function loadMobScan(name) { return loadScanAsset(name, MOB_URL, name, MOB_REGION.has(name), true); }
// ---------------------------------------------------------------- the story cast's Meshy models (2026-09-26)
// Client: 「主人公の渋沢健人の画像をこれに変えて」 (docs/ref/hero-model-v2.glb) and 「柊のイメージはこれを使って」
// (docs/ref/hiiragi-model.glb). Both go through assets/hero/pipeline/v2/buildScan.mjs — the pedscan pipeline (UV-safe
// decimation, capsule skin with occlusion, finger / jacket / long-hair overrides, seams.mjs) at the hero's budgets —
// and ship in the mob format with a region map (region.py). At runtime they are scans like the mobs (buildMobBody)
// plus what a lead needs: the rigid head, a closing fist on BOTH hands (the Meshy hands are open), the v1 hero's
// suit sheen and skin / hair shading, his own LOD distances, and (the hero) his stance and the attaché on a grip
// measured off his own closed left hand.
//   ?hero=v1  the previous hero (assets/hero/hero.*, the fused-attaché scan with lofted legs), for A/B
const HERO_V = typeof location !== 'undefined' && new URLSearchParams(location.search).get('hero') === 'v1' ? 'v1' : 'v2';
const CAST_SCANS = {
  hero_v2: { base: 'assets/hero/v2/', file: 'hero_v2', sheen: 0x4a4e57 },
  // (white worsted: a pale fibre's sheen, kept low — sheen is additive and the albedo is already 0.7)
  // (back 0.8: on white cloth a fold's inside at half light read as black shards along the hem and the lapel in a jab)
  hiiragi: { base: 'assets/hiiragi/', file: 'hiiragi', sheen: 0x8c8a86, sheenK: 0.18, back: 0.8 },
  // the "fight club" trio (same pipeline, the mobs' directory): cotton, denim and twill, not worsted — no sheen lobe
  // (the mobs' reason: a second BRDF per fragment for nothing); the white tee / sneakers take 柊's lighter lining
  club_miku: { base: 'assets/mobs/', file: 'club_miku', sheen: null },
  club_kai: { base: 'assets/mobs/', file: 'club_kai', sheen: null, back: 0.7 },
  club_tenma: { base: 'assets/mobs/', file: 'club_tenma', sheen: null, back: 0.7 },
};
// the trio fight in chapter one: fetched at import and awaited by init() like MOB_ASSETS (柊 is not: he is lazy)
const CLUB_ASSETS = ['club_miku', 'club_kai', 'club_tenma'];
const CAST_SHEEN = [];
const CAST_EAGER = typeof location !== 'undefined' && /hiiragi/.test(location.search);
function loadCastScan(name) { const c = CAST_SCANS[name]; return c ? loadScanAsset(name, c.base, c.file, true, false, c) : Promise.resolve(null); }
// sync: is that cast member's scan in? ('hiiragi'; the hero's is 'hero_v2')
export function castScanReady(name) { const sc = SCANS[name]; return !!sc && sc.state === 'ready'; }
// Promise: load (once) and resolve when it is in, e.g. `await castScansReady('hiiragi')` before a scene that shows him
export function castScansReady(...names) { return Promise.all((names.length ? names : ['hiiragi']).map(loadCastScan)); }
// the hero: v2 unless ?hero=v1, and v1 if v2 fails to load (a missing file downgrades, it never leaves a hole)
function loadHeroAny() {
  if (HERO_V === 'v1') return loadHero();
  return loadCastScan('hero_v2').then((sc) => {
    // groundLift: in idle / talk / jab / the guard his soles measured 0.7-1.3 cm under the ground (a Meshy sole is
    // thicker than the rig's ankle-to-ground; assets/hero/pipeline/v2/probe.mjs): 8 mm up centres them
    if (sc) { Object.assign(VARIANTS.kento, { scan: 'hero_v2', cast: true, hero: true, castHeight: HERO_HEIGHT, groundLift: 0.008, joints: heroJoints(sc.data.joints) }); return sc; }
    return loadHero();
  });
}
// one scan asset (a mob or a pedestrian): <base><file>.json/.bin + _albedo/_orm/_normal.jpg [+ _region.png], one
// material. `name` is the SCANS / VARIANTS key ('wanderer', 'ped_<key>'). `cast`: a story-cast scan (CAST_SCANS).
function loadScanAsset(name, base, file, withRegion, mob = false, cast = null) {
  const SC = SCANS[name] || (SCANS[name] = { state: 'idle', data: null, bin: null, mat: null, rig: null, promise: null });
  if (SC.promise) return SC.promise;
  SC.state = 'loading';
  SC.promise = (async () => {
    const get = async (f, kind) => { const r = await fetch(base + f); if (!r.ok) throw new Error(f + ' ' + r.status); return kind === 'json' ? r.json() : r.arrayBuffer(); };
    // ?mobSrc=<dir>/ loads the geometry of an A/B build from elsewhere (the maps stay the shipped ones); ?pedSrc= the same for a ped
    // (the hero's v4 head is its own geometry build, heroFace.js HERO_FACE_SRC; ?castSrc= still wins for an A/B)
    const src = (typeof location !== 'undefined' ? new URLSearchParams(location.search).get(cast ? 'castSrc' : mob ? 'mobSrc' : 'pedSrc') : null) || (name === 'hero_v2' ? HERO_FACE_SRC : null);
    const getG = src && /^[\w/.-]+\/$/.test(src) && !src.includes('..') ? async (f, kind) => { const r = await fetch(src + f); if (!r.ok) throw new Error(f + ' ' + r.status); return kind === 'json' ? r.json() : r.arrayBuffer(); } : get;
    const [json, bin] = await Promise.all([getG(file + '.json', 'json'), getG(file + '.bin', 'bin')]);
    if (HUM_TIME) console.info('[humanoid] t', Math.round(performance.now()), name, 'bin');
    // _region.png (fix round 4, assets/mobs/pipeline/mobface.py): R hair / beard, G skin, B scalp — optional, and
    // without it charShader falls back to its luma guess for the skin terms
    const want = withRegion && json.region !== false;
    // (the hero's v4 face re-bakes albedo / normal / region: heroFace.js heroFaceMapBase)
    const mb = (s) => (name === 'hero_v2' ? heroFaceMapBase(s, base) : base);
    const [map, orm, nrm, region] = await Promise.all(['_albedo.jpg', '_orm.jpg', '_normal.jpg'].map((s) => loadTex(mb(s) + file + s))
      .concat(want ? [loadTex(mb('_region.png') + file + '_region.png').catch(() => null)] : []));
    for (const t of [map, orm, nrm, region]) if (t) { t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
    SC.region = region;
    map.colorSpace = THREE.SRGBColorSpace;
    SC.data = json; SC.bin = bin;
    SC.rig = buildRig(json.joints);
    // glTF packs occlusion/roughness/metalness into R/G/B, which is what aoMap/roughnessMap/metalnessMap read.
    SC.mat = new THREE.MeshPhysicalMaterial({
      name: 'mobScan:' + name, map, aoMap: orm, aoMapIntensity: 0.85, roughnessMap: orm, metalnessMap: orm,
      roughness: 1, metalness: 1, normalMap: nrm, envMapIntensity: 1.6,
    });
    // no sheen lobe (fix round 2): leather, denim, nylon and a cotton hoodie are not worsted, and the lobe was a
    // second BRDF per light per fragment — measured ~2 fps on the three-scan lineup
    envTrack(SC.mat, 1.9);
    // Both sides, the inside as the lining in shadow. A scan is one shell with the scanner's gaps in it (a cuff,
    // a jacket hem, a weapon's weld), and anything that trims it at runtime opens more: single-sided, every one of
    // them showed the street straight through the torso — the client's "胴体が欠けている" in a fight. The shadow
    // pass keeps the old single side.
    SC.mat.side = THREE.DoubleSide; SC.mat.shadowSide = THREE.BackSide;
    // A back face on a mob is a real gap in the scan (a torn knee, a cuff: the lining in shadow) or a fold the pose
    // squeezes into the cloth (the seat in a lunge, the flank under a raised guard). At a fifth of its light every
    // fold read as a black tear across the jacket; half is a crease in shade. A seam patch's own back (seams.mjs
    // flags its vertices) is simply its cloth at full light.
    // normal 1.0 -> 1.3 and a denim-twill micro-normal (skin and hair excluded): the JPEG normals cannot be
    // re-exported lossless (the source GLBs ship them as JPEG too), so the response is given back in the shader
    SC.mat.normalScale.set(1.3, 1.3);
    if (cast) {
      // A lead in a worsted suit: the v1 hero's material numbers (loadHero) on the scan's own maps — a grazing sheen of
      // the fibre's own colour (neon-tinted at night, CAST_SHEEN), SSS on the skin and the Kajiya-Kay strand lobes on
      // the scalp, both placed by the region map (region.py) rather than guessed from the albedo. No twill
      // micro-normal: the Meshy normal carries its own weave, and on white cloth the twill aliased into a grid
      // (docs/reports/characters.md §6). Double-sided like every seams.mjs build (a jacket hem is one sheet).
      SC.mat.name = 'castScan:' + name;
      SC.mat.normalScale.set(1.15, 1.15);
      // ?castMat=sheen,sss sweeps the two (debug)
      const cq = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('castMat') || '').split(',') : [];
      if (cast.sheen != null && cq[0] !== '0') {
        SC.mat.sheen = cq[0] ? +cq[0] : cast.sheenK || 0.30; SC.mat.sheenRoughness = 0.58; SC.mat.sheenColor = new THREE.Color(cast.sheen);
        SC.mat.userData.sheen0 = SC.mat.sheenColor.clone(); SC.mat.userData.sheenK = SC.mat.sheen; SC.mat.userData.sheenN = SC.mat.sheen + 0.10;
        CAST_SHEEN.push(SC.mat);
      }
      if (MOB_DBG !== 'nochar') charShader(SC.mat, { gamut: HERO_GAMUT, hemi: 4.4, hemiN: 5.2, dark: 1, lift: 1, wedge: 1,
        // (sss 0.5, not v1's 1: the SSS terms scale with the albedo, and a Meshy cheek is ~2x v1's scanned one (linear
        // 0.68 vs 0.34) — at 1 every back-lit skin edge glowed orange in daylight: the forehead, the hands' outline)
        gnd: 6.6, gndN: 4.6, gndFloor: 0.22, aa: [0.085, 0.20], back: cast.back || 0.5, patch: true, sss: cq[1] ? +cq[1] : cast.sss || 0.5, hair: 1, wrap: 0.3,
        region: MOB_DBG === 'noregion' ? null : region });
    } else if (MOB_DBG !== 'nochar') charShader(SC.mat, { gamut: HERO_GAMUT, hemi: 4.4, hemiN: 5.2, dark: 1, lift: 1, wedge: 1,
      gnd: 6.6, gndN: 4.2, gndFloor: 0.20, aa: [0.085, 0.20], back: 0.5, patch: true, sss: 0.8, wrap: 0.3,
      region: MOB_DBG === 'noregion' ? null : region,
      detail: MOB_DBG === 'nodetail' ? null : { tex: garmentSet('denim', BASE_ALBEDO.cloth).normal, rep: 9, k: 0.55, fix: mob } });
    // ?mobDbg=normal: flat normal colours, front faces only, so a hole shows the street through the body;
    // ?mobDbg=groups: the pipeline's limb groups (a debug build's `dbg` channel), patches in yellow
    // ?mobDbg=back: the textured material with every back face painted red (a fold or an inside-out patch)
    if (MOB_DBG === 'back') {
      const prev = SC.mat.onBeforeCompile;
      SC.mat.vertexColors = !!json.parts.lod0.dbg;       // a MOB_DBG build: back faces of patches yellow, of the scan red
      SC.mat.onBeforeCompile = (s, r) => { if (prev) prev(s, r); s.fragmentShader = s.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        if (!gl_FrontFacing) gl_FragColor = ${SC.mat.vertexColors ? 'vColor.b < 0.5 ? vec4(1.0, 1.0, 0.0, 1.0) : ' : ''}vec4(1.0, 0.0, 0.0, 1.0);`); };
      SC.mat.customProgramCacheKey = () => 'mobDbgBack';
    }
    if (MOB_DBG === 'normal') SC.mat = new THREE.MeshNormalMaterial({ name: 'mobScan:' + name });
    if (MOB_DBG === 'basic') SC.mat = new THREE.MeshBasicMaterial({ name: 'mobScan:' + name, map: SC.mat.map });
    if (MOB_DBG === 'single' || MOB_DBG === 'lean') SC.mat.side = THREE.FrontSide;
    if (MOB_DBG === 'lean') SC.mat.sheen = 0;
    if (MOB_DBG === 'nosheen') SC.mat.sheen = 0;
    if (MOB_DBG === 'std') SC.mat = new THREE.MeshStandardMaterial({ name: 'mobScan:' + name, map: SC.mat.map, normalMap: SC.mat.normalMap, roughnessMap: SC.mat.roughnessMap, metalnessMap: SC.mat.metalnessMap, roughness: 1, metalness: 1 });
    if (MOB_DBG === 'groups') SC.mat = new THREE.MeshLambertMaterial({ name: 'mobScan:' + name, vertexColors: true });
    if (!mob && PED_BONES) SC.mat = new THREE.MeshLambertMaterial({ name: 'pedBones:' + name, vertexColors: true, side: THREE.DoubleSide });
    if(name==='hero_v2' && HERO_FACE_MODE==='v4'){
      try { applyHeroFaceV4(SC.mat, await loadTex(HERO_FACE_SRC + 'hero_v2_face.jpg')); }
      catch(error){ console.warn('[hero] v4 face texture unavailable',error); }
    }
    if(name==='hero_v2' && HERO_FACE_MODE==='wip'){
      try { applyHeroFaceMaterial(SC.mat,await new THREE.TextureLoader().loadAsync(base+'kento-face-source-approved.png')); }
      catch(error){ console.warn('[hero] approved face texture unavailable',error); }
    }
    const V = VARIANTS[name];
    if (V) { V.joints = V.ped ? pedJoints(V.ped, json.joints) : json.joints; V.scan = name; }
    SC.state = 'ready';
    return SC;
  })().catch((e) => { SC.state = 'failed'; console.warn(`[humanoid] scan "${name}" unavailable:`, e.message); return null; });
  return SC.promise;
}
// ---------------------------------------------------------------- the 19 pedestrian scans
// Lazy and parallel: nothing is fetched until humanoid.init() has the hero and the mobs (the boot never waits on a
// passer-by), then all 19 at once (json + bin + three maps each, ~1.6 MB + 0.3 MB). The crowd shows nobody near until
// they are in. pedScansReady() resolves with the keys that loaded (a failed one is simply missing, never a fallback).
const PED_URL = 'assets/peds/';
let PED_ALL = null;
// [mobile] ?pedScans=<n> downloads only the first n passer-by scans (the mobile profile's 12, ~40 % fewer bytes); the
// crowd is cast from whichever loaded. The scans the story's NPCs wear (missions.js / doubleDragon.js) always load.
const PED_STORY = new Set(['formal_portrait_4019', 'mexican_traveler_5850', 'ready_for_the_trail_4758']);
const pedSubset = () => {
  const n = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('pedScans')) : NaN;
  return n > 0 ? PED_SCANS.filter((p, i) => i < n || PED_STORY.has(p.key)) : PED_SCANS;
};
export function pedScansReady() {
  if (!PED_ALL) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    PED_ALL = Promise.all(pedSubset().map((p) => loadScanAsset(p.variant, PED_URL, p.key, false))).then(() => {
      const keys = PED_SCANS.filter((p) => pedScanReady(p.key)).map((p) => p.key);
      if (HUM_TIME || PED_DBG) console.info('[humanoid] peds ready', keys.length, 'of', PED_SCANS.length, Math.round(performance.now() - t0), 'ms');
      return keys;
    });
  }
  return PED_ALL;
}
// accepts the key or the variant ('ped_<key>')
export function pedScanReady(key) { const sc = SCANS[String(key).startsWith('ped_') ? key : 'ped_' + key]; return !!sc && sc.state === 'ready'; }
const PED_DBG = typeof location !== 'undefined' && /[?&]pedDbg=1/.test(location.search);
// ?pedDbg=bones: every pedestrian painted by its skin weights, one colour per bone (left warm, right cool, torso grey-blue,
// head white, hands saturated) — what rides what, at a glance
const PED_BONES = typeof location !== 'undefined' && /[?&]pedDbg=bones/.test(location.search);
const PED_BONE_RGB = {
  Hips: [0.35, 0.35, 0.45], Spine: [0.45, 0.45, 0.6], Spine1: [0.55, 0.55, 0.75], Spine2: [0.65, 0.65, 0.9], Neck: [0.85, 0.85, 0.6], Head: [1, 1, 1],
  LeftShoulder: [0.9, 0.6, 0.3], LeftArm: [1, 0.5, 0.1], LeftForeArm: [1, 0.25, 0.05], LeftHand: [1, 0, 0],
  RightShoulder: [0.3, 0.6, 0.9], RightArm: [0.1, 0.5, 1], RightForeArm: [0.05, 0.25, 1], RightHand: [0, 0, 1],
  LeftUpLeg: [0.9, 0.9, 0.1], LeftLeg: [0.6, 0.6, 0.05], LeftFoot: [0.35, 0.35, 0], LeftToeBase: [0.2, 0.2, 0],
  RightUpLeg: [0.1, 0.9, 0.3], RightLeg: [0.05, 0.6, 0.2], RightFoot: [0, 0.35, 0.1], RightToeBase: [0, 0.2, 0.05],
};
function pedBoneColours(geo) {
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, n = si.count, c = new Float32Array(n * 3), sp = geo.attributes.seamPatch;
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k), rgb = PED_BONE_RGB[BONE_NAMES[si.getComponent(i, k)]]; if (!w || !rgb) continue; c[i * 3] += rgb[0] * w; c[i * 3 + 1] += rgb[1] * w; c[i * 3 + 2] += rgb[2] * w; }
  // (a seam patch — seams.mjs's closing of a window the scanner never saw — in magenta)
  if (sp) for (let i = 0; i < n; i++) if (sp.getX(i) > 0.5) { c[i * 3] = 1; c[i * 3 + 1] = 0; c[i * 3 + 2] = 1; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
}

// A mob is one scanned mesh on its own skeleton — no lofted legs, no procedural hands or face to blend in.
function buildMobBody(V, R, detail, stance, part, SC) {
  // one geometry, one material, no groups — so the material is passed SINGLY. Handing a SkinnedMesh a
  // one-element array against a geometry with no groups draws nothing at all, which is how these first
  // shipped: the lineup rendered the hero and four invisible men.
  const geo = heroPart(part, SC);
  if (V.hero) {
    // Own the attributes: source scan buffers are shared by every instance and LOD.
    const position = geo.getAttribute('position').clone();
    for (let i = 0; i < position.count; i++) position.setY(i, heroBodyY(position.getY(i),position.getX(i)));
    geo.setAttribute('position', position);
    fitHeroKnees(geo,R);
    const shippedNormal = geo.getAttribute('normal');
    fitHeroFace(geo);
    geo.setAttribute('normal', shippedNormal.clone());
    geo.computeVertexNormals();
    heroHeadNormals(geo, shippedNormal);
    heroFaceAttr(geo, SC, part);
    geo.computeBoundingBox(); geo.computeBoundingSphere();
  }
  if (V.ped === 'high_school_student_5828') {
    const position = geo.getAttribute('position').clone();
    for (let i = 0; i < position.count; i++) position.setY(i, studentBodyY(position.getY(i)));
    geo.setAttribute('position', position);
    geo.setAttribute('normal', geo.getAttribute('normal').clone());
    geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
  }
  else if (V.ped) pedLongGeo(geo, V.ped, part);
  // a pedestrian keeps what she carries (the handbag, the backpack, the cup ride their bones: buildPed.mjs)
  if (V.ped) { if (PED_BONES) pedBoneColours(geo); return { geo, mats: SC.mat, tris: geo.index.count / 3, skin: null }; }
  if (V.cast) {
    // the story cast: nothing to cut out of a hand (open Meshy hands, no carried thing), the head rigid above the jaw,
    // and at lod0 a fist on both hands (castFistMorph)
    rigidHead(geo, R, HEAD_CUT[V.scan]);
    if (part === 'lod0' && !NO_FIST) castFistMorph(geo, R, SC, V.scan);
    // (the hero's v4 lod0 carries its hair cards as a second group: heroFace.js heroCardGroups)
    if (V.hero && heroCardGroups(geo, SC, part)) return { geo, mats: [SC.mat, hairCardMat()], tris: geo.index.count / 3, skin: null };
    return { geo, mats: SC.mat, tris: geo.index.count / 3, skin: null };
  }
  if (!V.civ) rigidHead(geo, R, HEAD_CUT[V.scan]);
  if (MOB_GARMENT[V.scan] && !/[?&]mobHem=0/.test(typeof location !== 'undefined' ? location.search : '')) garmentMask(geo, R, MOB_GARMENT[V.scan]);
  // (a civilian gets its own cut and masks later, on enemy.js's re-weighted skin: see civFinish)
  if (!MOB_KEEP_PROPS || V.civ) {
    // the cut is a pure function of the scan and the rung: done once (a weld map over 24 k vertices was a 50-100 ms
    // hitch on every fighter and crowd civilian built from the same scan), the index shared by every later body
    const k = V.scan + ':' + part, c = PROP_CUT.get(k);
    if (c) { geo.setIndex(new THREE.BufferAttribute(c.index, 1)); geo.userData.handPlugs = c.plugs; }
    else { dropHeldProps(geo, R, MOB_REACH[V.scan] || 0.11); PROP_CUT.set(k, { index: geo.index.array, plugs: geo.userData.handPlugs || null }); }
  }
  return { geo, mats: SC.mat, tris: geo.index.count / 3, skin: null };
}
// the fist plugs (dropHeldProps) as children of the hand bones, wearing the scan's material
function attachPlugs(h, geo, R, mat, layer) {
  const P = geo.userData.handPlugs;
  if (!P) return;
  for (const side of SIDES) {
    if (!P[side] || h.props['plug' + side]) continue;
    const pg = handPlug(P[side], R, side);
    if (!pg) continue;
    const m = new THREE.Mesh(pg, mat);
    m.name = 'handPlug:' + side; m.castShadow = true; m.receiveShadow = true;
    if (layer != null) m.layers.enable(layer);
    h.bones[side + 'Hand'].add(m); h.props['plug' + side] = m;
  }
}
const PROP_CUT = new Map();
// Fix round 2: what the scans were HOLDING. enemy.js culls the loose prop islands for a fight, but a pistol, a book
// or a bag welded into the fist is part of the hand's own surface and survives it: the glasses man stood in the cast
// shot with a pistol and a book, the cap man with his bag glued to his fingertips. Anything skinned to a hand that
// lies more than 11 cm from the palm centre (a fist's fingertips reach ~9) is not hand; and small islands within
// 25 cm of a hand are the rest of the same prop. ?mobProps=1 keeps them.
const CIV_DBG = typeof location !== 'undefined' && /[?&]civDbg=1/.test(location.search);
const MOB_KEEP_PROPS = typeof location !== 'undefined' && /[?&]mobProps=1/.test(location.search);
function dropHeldProps(geo, R, reach = 0.11, civ = false) {
  const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, idx = geo.index && geo.index.array;
  if (!si || !sw || !idx) return geo;
  const n = pos.count, hands = [];
  for (const s of SIDES) {
    const F = R.joints[s + 'ForeArm'], H = R.joints[s + 'Hand'];
    const d = new THREE.Vector3(H[0] - F[0], H[1] - F[1], H[2] - F[2]).normalize();
    hands.push({ bi: R.index[s + 'Hand'], c: new THREE.Vector3(...H).addScaledVector(d, 0.045), j: new THREE.Vector3(...H), d });
  }
  const own = new Int8Array(n).fill(-1);                    // which hand dominates each vertex (w > 0.5)
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) {
    const b = si.getComponent(i, k), w = sw.getComponent(i, k);
    if (w > 0.5) { if (b === hands[0].bi) own[i] = 0; else if (b === hands[1].bi) own[i] = 1; }
  }
  // weld-connected islands, for the small pieces
  const weld = new Int32Array(n), first = new Map();
  for (let i = 0; i < n; i++) {
    const k = Math.round(pos.getX(i) * 2000) + ',' + Math.round(pos.getY(i) * 2000) + ',' + Math.round(pos.getZ(i) * 2000);
    const f = first.get(k); if (f === undefined) { first.set(k, i); weld[i] = i; } else weld[i] = f;
  }
  const par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let f = 0; f < idx.length; f += 3) {
    const a = find(weld[idx[f]]), b = find(weld[idx[f + 1]]), c = find(weld[idx[f + 2]]);
    if (a !== c) par[a] = c;
    if (find(b) !== find(c)) par[find(b)] = find(c);
  }
  const itris = new Map(), icen = new Map();
  for (let f = 0; f < idx.length; f += 3) {
    const r = find(weld[idx[f]]); itris.set(r, (itris.get(r) || 0) + 1);
    let c = icen.get(r); if (!c) icen.set(r, c = [0, 0, 0, 0]);
    c[0] += pos.getX(idx[f]); c[1] += pos.getY(idx[f]); c[2] += pos.getZ(idx[f]); c[3]++;
  }
  // Fix round 4 (critic #5): small islands within 25 cm of a hand were 150 triangles; the pistol's remains, the
  // cane's grip cluster and the strap ends were 150-600. And an island near a hand whose box never touches the hand
  // capsule (the wrist to 17 cm down its line, 8 cm round) is not hand: posed, it stayed at the hip while the hand
  // swung away — the black sliver floating 15 cm off the brute's fist.
  const smallNear = new Set();
  const capsule = hands.map((h) => ({ a: h.j, b: h.j.clone().addScaledVector(h.d, 0.17) }));
  const boxTouches = (lo, hi, cap) => {
    // the nearest point of the box to the segment, sampled along it
    for (let s = 0; s <= 1; s += 0.125) {
      const px = cap.a.x + (cap.b.x - cap.a.x) * s, py = cap.a.y + (cap.b.y - cap.a.y) * s, pz = cap.a.z + (cap.b.z - cap.a.z) * s;
      const dx = Math.max(lo[0] - px, 0, px - hi[0]), dy = Math.max(lo[1] - py, 0, py - hi[1]), dz = Math.max(lo[2] - pz, 0, pz - hi[2]);
      if (dx * dx + dy * dy + dz * dz < 0.08 * 0.08) return true;
    }
    return false;
  };
  let mainR = -1, mainT = 0;
  for (const [r, t] of itris) if (t > mainT) { mainT = t; mainR = r; }
  const ibox = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(weld[i]); if (r === mainR) continue;
    let b = ibox.get(r); if (!b) ibox.set(r, b = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]]);
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < b[0][0]) b[0][0] = x; if (y < b[0][1]) b[0][1] = y; if (z < b[0][2]) b[0][2] = z;
    if (x > b[1][0]) b[1][0] = x; if (y > b[1][1]) b[1][1] = y; if (z > b[1][2]) b[1][2] = z;
  }
  // (critic #15: the brute's ripped-knee flaps are 5-40 triangle islands round the knee joints — debris, not rips)
  const knees = ['LeftLeg', 'RightLeg'].map((k) => R.joints[k]).filter(Boolean);
  for (const [r, t] of itris) {
    if (r === mainR) continue;
    const c = icen.get(r), x = c[0] / c[3], y = c[1] / c[3], z = c[2] / c[3];
    const dh = Math.min(...hands.map((h) => Math.hypot(x - h.j.x, y - h.j.y, z - h.j.z)));
    if (t < 600 && dh < 0.25) { smallNear.add(r); continue; }
    if (t < 3000 && dh < 0.30) { const b = ibox.get(r); if (b && !hands.some((h, k) => boxTouches(b[0], b[1], capsule[k]))) { smallNear.add(r); continue; } }
    if (t < 40 && knees.some((K) => Math.hypot(x - K[0], y - K[1], z - K[2]) < 0.08)) smallNear.add(r);
  }
  // per hand: what lies beyond reach is what the hand was holding — a pistol, a cane, the satchel's strap. (Round 2
  // kept anything over 500 triangles as "a bag carried by its strap"; round 4 cuts it too — the wanderer's satchel
  // is a holed, jagged shell that hung from his fist as a 20 cm rag of orange leather in the cast shot.)
  const out = new Uint8Array(idx.length / 3), per = [0, 0];
  // whatever hangs past the fingertips (15.5 cm down the hand line, within 15 cm of it) is a strap, a bag or a
  // cane, on whichever bone the auto-skin gave it — except the legs, which stand right beside a hanging hand
  const legV = new Uint8Array(n);
  { const legs = new Set(['Hips', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg'].map((k) => R.index[k]).filter((v) => v != null));
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0.5 && legs.has(si.getComponent(i, k))) legV[i] = 1; }
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], b = idx[f + 1], c = idx[f + 2];
    if (smallNear.has(find(weld[a]))) { out[f / 3] = 3; continue; }
    const hi = own[a] >= 0 && own[a] === own[b] && own[a] === own[c] ? own[a] : -1;
    if (hi < 0) {
      if (!(legV[a] || legV[b] || legV[c])) {
        const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
        for (let k = 0; k < 2; k++) {
          const h = hands[k], t = (x - h.j.x) * h.d.x + (y - h.j.y) * h.d.y + (z - h.j.z) * h.d.z;
          if (t > 0.155 && t < 0.5 && Math.hypot(x - h.j.x - h.d.x * t, y - h.j.y - h.d.y * t, z - h.j.z - h.d.z * t) < 0.15) { out[f / 3] = 4 + k; break; }
        }
      }
      continue;
    }
    const h = hands[hi], x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    let cut = Math.hypot(x - h.c.x, y - h.c.y, z - h.c.z) > reach;
    // a civilian: the hand is a capsule 10 cm down the forearm line from the wrist, 5.8 cm round; the cane's grip
    // under the fist and the book's edge against the palm lie outside it
    if (cut) { out[f / 3] = 1 + hi; per[hi]++; }
    else if (civ) {
      const t = clamp((x - h.j.x) * h.d.x + (y - h.j.y) * h.d.y + (z - h.j.z) * h.d.z, 0, 0.10);
      if (Math.hypot(x - h.j.x - h.d.x * t, y - h.j.y - h.d.y * t, z - h.j.z - h.d.z * t) > 0.058) out[f / 3] = 4 + hi;
    }
  }
  // a civilian keeps only a bag carried by its strap (civ = the hands that carry one, e.g. ['Left']); a fighter nothing
  const cutHand = (hi) => (civ ? !(civ.bag && civ.bag.includes(hi ? 'Right' : 'Left')) : true);
  const keep = [];
  let gone = 0;
  // 優先3 "blob hands": the opening each cut leaves in a hand is closed by a fan over its own rim (below). The directed
  // welded edges of every triangle cut from hand k, so a kept triangle can tell which of its edges lies on that rim.
  const cutE = new Map(), rim = [[], []];
  for (let f = 0; f < idx.length; f += 3) {
    const o = out[f / 3];
    const hk = o && o < 3 ? o - 1 : o > 3 ? o - 4 : -1;
    if (hk < 0 || !cutHand(hk)) continue;
    for (let e = 0; e < 3; e++) cutE.set(weld[idx[f + e]] * n + weld[idx[f + (e + 1) % 3]], hk);
  }
  for (let f = 0; f < idx.length; f += 3) {
    const o = out[f / 3];
    if (o === 3 || (o && o < 3 && cutHand(o - 1)) || (o > 3 && cutHand(o - 4))) { gone++; continue; }
    keep.push(idx[f], idx[f + 1], idx[f + 2]);
    if (cutE.size) for (let e = 0; e < 3; e++) {
      const a = idx[f + e], b = idx[f + (e + 1) % 3], hk = cutE.get(weld[b] * n + weld[a]);
      if (hk !== undefined) rim[hk].push(a, b);
    }
  }
  geo.userData.propHands = per;
  if (CIV_DBG) console.info('[humanoid] dropHeldProps', civ ? 'civ' : 'mob', 'per', per.join('/'), 'gone', gone, 'of', idx.length / 3, 'own', own.reduce((a, o) => a + (o >= 0 ? 1 : 0), 0), 'islands', smallNear.size);
  if (!gone) return geo;
  geo.setIndex(new THREE.BufferAttribute(new (n > 65535 ? Uint32Array : Uint16Array)(keep), 1));
  geo.userData.propTris = gone;
  // a hand that lost what it held is open at the cut: a plug (a cap of the cut sphere, on the hand bone, wearing the
  // nearest kept hand texel) closes it into a fist — see handPlug / createHumanoid
  const plugs = {};
  for (let k = 0; k < 2; k++) {
    if (!per[k] || !cutHand(k)) continue;
    const h = hands[k];
    let bi = -1, bd = Infinity;
    for (let f = 0; f < keep.length; f++) {
      const i = keep[f]; if (own[i] !== k) continue;
      const dd = Math.hypot(pos.getX(i) - h.c.x, pos.getY(i) - h.c.y, pos.getZ(i) - h.c.z);
      if (dd < bd) { bd = dd; bi = i; }
    }
    const uv = geo.attributes.uv;
    // the rim edges (kept side a -> b) with their own uvs: ax ay az bx by bz ua va ub vb
    const R0 = rim[k], edges = new Float32Array(R0.length * 5);
    for (let e = 0; e < R0.length; e += 2) {
      const a = R0[e], b2 = R0[e + 1], o = e * 5;
      edges[o] = pos.getX(a); edges[o + 1] = pos.getY(a); edges[o + 2] = pos.getZ(a);
      edges[o + 3] = pos.getX(b2); edges[o + 4] = pos.getY(b2); edges[o + 5] = pos.getZ(b2);
      if (uv) { edges[o + 6] = uv.getX(a); edges[o + 7] = uv.getY(a); edges[o + 8] = uv.getX(b2); edges[o + 9] = uv.getY(b2); }
    }
    plugs[k ? 'Right' : 'Left'] = { c: h.c.toArray(), d: h.d.toArray(), r: reach - 0.0025, uv: bi >= 0 && uv ? [uv.getX(bi), uv.getY(bi)] : null, edges };
  }
  geo.userData.handPlugs = plugs;
  return geo;
}
// The plug for a hand cut open by dropHeldProps, in the HAND bone's bind frame so it rides the bone as a child mesh
// (one draw, no merge into the cached geometry). It used to be a spherical cap of the cut radius (8.75 cm, 10.75 on
// the wanderer) laid over the far side of the palm: every fist of the three men wore a 17-21 cm ball of one flat
// texel — the client's "blob hands" (shots/chars/before_*). Now each opening is closed where it is: a fan from the
// centre of its own rim to every rim edge, each rim vertex keeping its own uv, so the cap is the size of the hole
// and wears the skin / cuff round it. ?handPlug=ball restores the old cap for A/B.
const PLUG_BALL = typeof location !== 'undefined' && /[?&]handPlug=ball/.test(location.search);
const PLUG_NONE = typeof location !== 'undefined' && /[?&]handPlug=none/.test(location.search);
function handPlug(P, R, side) {
  if (PLUG_NONE) return null;
  let g;
  if (PLUG_BALL || !P.edges) {
    g = new THREE.SphereGeometry(P.r, 16, 9, 0, TAU, 0, 1.85);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(...P.d)));
    g.translate(P.c[0], P.c[1], P.c[2]);
    const uv = g.attributes.uv;
    if (P.uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, P.uv[0], P.uv[1]);
  } else {
    const E = P.edges, m = E.length / 10;
    if (!m) return null;
    // rims: edges joined by shared end points (welded at 0.25 mm)
    const ids = new Map(), par = [];
    const id = (o) => { const k = Math.round(E[o] * 4000) + ',' + Math.round(E[o + 1] * 4000) + ',' + Math.round(E[o + 2] * 4000); let i = ids.get(k); if (i === undefined) { i = par.length; ids.set(k, i); par.push(i); } return i; };
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const ea = new Int32Array(m);
    for (let e = 0; e < m; e++) { const a = id(e * 10), b = id(e * 10 + 3); ea[e] = a; const A = find(a), B = find(b); if (A !== B) par[A] = B; }
    const cen = new Map();
    for (let e = 0; e < m; e++) {
      const r = find(ea[e]), o = e * 10;
      let c = cen.get(r); if (!c) cen.set(r, c = { x: 0, y: 0, z: 0, n: 0, u: 0, v: 0, d: Infinity });
      c.x += E[o] + E[o + 3]; c.y += E[o + 1] + E[o + 4]; c.z += E[o + 2] + E[o + 5]; c.n += 2;
    }
    for (const c of cen.values()) { c.x /= c.n; c.y /= c.n; c.z /= c.n; c.r = 0; c.u0 = Infinity; c.u1 = -Infinity; c.v0 = Infinity; c.v1 = -Infinity; }
    for (let e = 0; e < m; e++) {                         // each rim's size, and the span of its uvs
      const c = cen.get(find(ea[e])), o = e * 10;
      c.r = Math.max(c.r, Math.hypot(E[o] - c.x, E[o + 1] - c.y, E[o + 2] - c.z));
      c.u0 = Math.min(c.u0, E[o + 6]); c.u1 = Math.max(c.u1, E[o + 6]); c.v0 = Math.min(c.v0, E[o + 7]); c.v1 = Math.max(c.v1, E[o + 7]);
    }
    for (let e = 0; e < m; e++) {                         // the centre wears the uv of the rim point nearest it
      const c = cen.get(find(ea[e])), o = e * 10;
      const d = (E[o] - c.x) ** 2 + (E[o + 1] - c.y) ** 2 + (E[o + 2] - c.z) ** 2;
      if (d < c.d) { c.d = d; c.u = E[o + 6]; c.v = E[o + 7]; }
    }
    // Only an opening the size of a gap in a fist (≤ 3.5 cm from its centre) is closed. A wide rim is the cut round a
    // whole book or bag: fanned, it came out as a striped plate across the uv charts (shots/chars/sheet_noplug.png);
    // left open, the scan's inside shows as lining in shade, which reads as a fold. One chart's uvs, else one texel.
    const p = [], t = [];
    for (let e = 0; e < m; e++) {
      const c = cen.get(find(ea[e])), o = e * 10;
      if (c.r > 0.035) continue;
      const one = c.u1 - c.u0 > 0.04 || c.v1 - c.v0 > 0.04;
      p.push(c.x, c.y, c.z, E[o + 3], E[o + 4], E[o + 5], E[o], E[o + 1], E[o + 2]);   // (centre, b, a): the kept side's winding reversed
      if (one) t.push(c.u, c.v, c.u, c.v, c.u, c.v); else t.push(c.u, c.v, E[o + 8], E[o + 9], E[o + 6], E[o + 7]);
    }
    if (!p.length) return null;
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(t), 2));
    g.computeVertexNormals();
  }
  const bw = R.world[side + 'Hand'];
  if (bw) {
    const inv = new THREE.Matrix4().compose(bw.position, bw.quaternion, new THREE.Vector3(1, 1, 1)).invert();
    g.applyMatrix4(inv);
  }
  return g;
}
// Fix round 4 (critic #5): the pistol / cane grips of the two enforcers read as a spike ball at 11 cm; a closed fist's
// own fingertips reach ~9 from the palm centre
const MOB_REACH = { enforcer_a: 0.09, enforcer_b: 0.09 };
// Where each scan's top garment really ends. enemy.js re-dresses a mob in its shader, by region: torso-skinned cloth
// takes the jacket, hip- and leg-skinned cloth the trousers. A garment does not stop where the skinning does: the
// salaryman's jacket hangs 19 cm below his Hips joint, and repainted by weight its skirt came out trouser-black
// under a gold jacket — a black band round the middle of him, "the torso is missing" from the fight camera. The
// wanderer's hoodie went violet to its original grey-brown at the belly the same way. Measured off the scans (the
// bind-pose depth profile steps out at the hem: enforcer_b 0.159 -> 0.219 m at the back between 0.76 and 0.78 m,
// wanderer 0.127 -> 0.165 m in front at 0.86-0.88 m). The mask is the same three channels enemy.js's wardMask()
// writes (upper, lower, chest V), and wardMask() keeps an attribute it finds; &mobHem=0 compares against its own.
const MOB_GARMENT = { enforcer_b: { hem: 0.772 }, wanderer: { hem: 0.862 } };
const WARD_UP = ['Spine', 'Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm'];
const WARD_LO = ['Hips', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg'];
function garmentMask(geo, R, G) {
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, nr = geo.attributes.normal, pos = geo.attributes.position;
  if (!si || !sw || !nr) return;
  const up = new Set(WARD_UP.map((n) => R.index[n])), lo = new Set(WARD_LO.map((n) => R.index[n]));
  const NECK = R.index.Neck, S2 = R.index.Spine2, sx = R.joints.Spine2[0], hx = R.joints.Hips[0], hy = R.joints.Hips[1];
  const n = si.count, a = new Float32Array(n * 3);
  let moved = 0;
  for (let v = 0; v < n; v++) {
    let u = 0, l = 0, s2 = 0;
    for (let k = 0; k < 4; k++) {
      const b = si.getComponent(v, k), w = sw.getComponent(v, k);
      if (b === NECK) continue;
      if (up.has(b)) u += w; else if (lo.has(b)) l += w;
      if (b === S2) s2 += w;
    }
    const x = pos.getX(v), y = pos.getY(v), nx = nr.getX(v), ny = nr.getY(v), nz = nr.getZ(v);
    a[v * 3 + 2] = sstep((s2 - 0.4) / 0.2) * sstep((nz - 0.2) / 0.2) * (1 - sstep((Math.abs(x - sx) - 0.07) / 0.04));
    // hip- and thigh-skinned cloth above the hem is the garment, all round and up past the waist (the auto-skin's
    // Hips share reaches the lower ribs: stopped at the joint, a 60/40 band of trouser colour crossed the waist) --
    // but not the inside of the thighs under it or the underside of the hem
    let j = l > 0 && y < hy + 0.3 ? sstep((y - (G.hem - 0.006)) / 0.012) : 0;
    if (j > 0 && ((Math.abs(x - hx) < 0.09 && nx * Math.sign(x - hx) < -0.55) || ny < -0.75)) j = 0;
    if (j > 0.01) moved++;
    a[v * 3] = u + l * j; a[v * 3 + 1] = l * (1 - j);
  }
  geo.setAttribute('aWard', new THREE.BufferAttribute(a, 3));
  geo.userData.garmentMoved = moved;
}
// ---------------------------------------------------------------- civilians built from the scans (crowd LOD0 pool)
// Round 3, critic blocker #1: crowd.js's nearest bodies were the procedural 'pedestrian' (a lofted head on a painted
// 512² atlas, a fold-less jacket) and one walked 2 m behind the lead in the flagship close-up. The pool's men are now
// the client's scans: every held prop cut, re-dressed per twin inside their own shader, luminance-preserving so the
// scan's own folds, seams and weave survive the new colour. Same key maths as enemy.js's wardrobe on the same
// atlases; `ref` is each region's mean linear luminance off the 512² albedo (skin and white cloth excluded).
// Women and slight builds stay procedural: no scan fits them.
const CIV_SCANS = ['enforcer_b', 'enforcer_a', 'wanderer'];
// the hand that carries a bag by its strap (kept whole). Round 3: nobody — the wanderer's scanned satchel is a
// holed, jagged shell that read as a torn rag swinging from a pedestrian's hand at 3 m (?civBag=1 keeps it)
const CIV_BAG = typeof location !== 'undefined' && /[?&]civBag=1/.test(location.search) ? { wanderer: ['Left'] } : {};
// bare-handed scans: past the wrist, whatever is hand-skinned and not skin-coloured is what the hand was holding (the
// cane's grip under the salaryman's fist, the book's spine in his palm). The vest man wears gloves: not him.
const CIV_TEXCUT = { enforcer_b: true, enforcer_a: true };
// the salaryman's book, pressed between his left forearm and hip: skinned to the torso, so no hand test finds it. It
// is the only warm, non-skin surface within 30 cm of that hand (the suit is navy and black, measured off the atlas).
const CIV_WARM = { enforcer_b: [['LeftHand', 0.30]] };
function civWarmCut(geo, R, A, list) {
  const idx = geo.index, uv = geo.attributes.uv, pos = geo.attributes.position;
  if (!A || !idx || !uv) return;
  const warm = (i) => {
    const N = A.N, u = uv.getX(i), v = uv.getY(i), x = clamp(Math.floor((u - Math.floor(u)) * N), 0, N - 1), y = clamp(Math.floor((v - Math.floor(v)) * N), 0, N - 1), o = (y * N + x) * 4;
    return A.d[o] - A.d[o + 2] > 14 && !civSkinTexel(A, uv, i, 95);
  };
  const cs = list.map(([j, r]) => [R.joints[j], r]), a0 = idx.array, keep = [];
  let gone = 0;
  for (let f = 0; f < a0.length; f += 3) {
    const a = a0[f], b = a0[f + 1], c = a0[f + 2];
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    if (cs.some(([J, r]) => Math.hypot(x - J[0], y - J[1], z - J[2]) < r) && warm(a) + warm(b) + warm(c) >= 2) { gone++; continue; }
    keep.push(a, b, c);
  }
  if (CIV_DBG) console.info('[humanoid] civWarmCut', gone);
  if (gone) geo.setIndex(new THREE.BufferAttribute(new (pos.count > 65535 ? Uint32Array : Uint16Array)(keep), 1));
}
const civAlb = new Map();
function civAlbedo(SC) {
  const key = SC.mat && SC.mat.map ? SC.mat.map.uuid : null;
  if (civAlb.has(key)) return civAlb.get(key);
  let out = null;
  try {
    const img = SC.mat.map && SC.mat.map.image, N = 256;
    if (img && typeof document !== 'undefined') {
      const c = document.createElement('canvas'); c.width = c.height = N;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, N, N);
      out = { N, d: g.getImageData(0, 0, N, N).data };
    }
  } catch (e) { out = null; if (CIV_DBG) console.warn('[humanoid] civAlbedo', e.message); }
  civAlb.set(key, out);
  return out;
}
function civPropCut(geo, R, A) {
  const idx = geo.index, uv = geo.attributes.uv, pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  if (!A || !idx || !uv || !si) return;
  const { N, d } = A;
  const arms = ['Left', 'Right'].map((s) => { const F = R.joints[s + 'ForeArm'], H = R.joints[s + 'Hand'], v = [H[0] - F[0], H[1] - F[1], H[2] - F[2]], l = Math.hypot(...v);
    return { F, d: v.map((x) => x / l), l, bi: R.index[s + 'Hand'], fi: R.index[s + 'ForeArm'] }; });
  // the arm (hand or forearm) that dominates a vertex: a grip welded into the fist may ride the forearm
  const side = (i) => { for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0.5) { const b = si.getComponent(i, k); return b === arms[0].bi || b === arms[0].fi ? 0 : b === arms[1].bi || b === arms[1].fi ? 1 : -1; } return -1; };
  const skin = (i) => {
    const u = uv.getX(i), v = uv.getY(i), x = clamp(Math.floor((u - Math.floor(u)) * N), 0, N - 1), y = clamp(Math.floor((v - Math.floor(v)) * N), 0, N - 1), o = (y * N + x) * 4;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    return r > 45 && r >= g && g >= b * 0.9 && r - b > 16 && g / r > 0.5 && g / r < 0.93;
  };
  const a0 = idx.array, keep = [];
  let gone = 0;
  for (let f = 0; f < a0.length; f += 3) {
    const a = a0[f], b = a0[f + 1], c = a0[f + 2], s = side(a);
    if (s >= 0 && s === side(b) && s === side(c)) {
      const A2 = arms[s], cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3 - A2.F[0], cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3 - A2.F[1], cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3 - A2.F[2];
      const t = cx * A2.d[0] + cy * A2.d[1] + cz * A2.d[2];
      if (t > A2.l + 0.02 && (skin(a) + skin(b) + skin(c)) < 2) { gone++; continue; }
    }
    keep.push(a, b, c);
  }
  if (CIV_DBG) console.info('[humanoid] civPropCut', gone, 'of', a0.length / 3);
  if (gone) geo.setIndex(new THREE.BufferAttribute(new (pos.count > 65535 ? Uint32Array : Uint16Array)(keep), 1));
}
const CIV_WARD = {
  // the salaryman: suit -> top, trousers -> bottom, the navy shirt in the chest V -> inner
  enforcer_b: [{ garment: true, region: [1, 0, 0], to: 'top', gamma: 0.8, ref: 0.0155 },
    { garment: true, region: [0, 1, 0], to: 'bottom', gamma: 0.75, ref: 0.0063 },
    { key: 0x0d1e30, tol: 0.14, lum: [0.002, 0.09], sat: [0.45, 1], region: [0, 0, 1], to: 'inner', gamma: 0.6 }],
  // the bomber (fur collar included) -> top, the red flannel -> inner, the jeans -> bottom
  enforcer_a: [{ garment: true, key: 0x5a1f1f, tol: 0.1, lum: [0.006, 0.2], sat: [0.42, 1], region: [1, 0, 0], to: 'top', gamma: 0.65, ref: 0.038 },
    { key: 0x5a1f1f, tol: 0.1, lum: [0.008, 0.09], sat: [0.48, 1], region: [1, 0, 0], to: 'inner', gamma: 0.85 },
    { garment: true, region: [0, 1, 0], to: 'bottom', gamma: 0.75, ref: 0.0465 }],
  // the quilted vest -> top, the hoodie -> inner, the cargo trousers -> bottom
  wanderer: [{ key: 0x131b22, tol: 0.11, lum: [0.002, 0.04], sat: [0.24, 1], region: [1, 0, 0], to: 'top', gamma: 0.8 },
    { key: 0x544a40, tol: 0.08, lum: [0.018, 0.16], sat: [0.04, 0.32], region: [1, 0, 0], to: 'inner', gamma: 0.8 },
    { garment: true, region: [0, 1, 0], to: 'bottom', gamma: 0.75, ref: 0.0234 }],
};
const CIV_GLSL = /* glsl */`
#ifdef CIV_WARD
{ vec3 wa = diffuseColor.rgb;
  float wl = dot( wa, vec3( 0.2126, 0.7152, 0.0722 ) );
  float wmx = max( wa.r, max( wa.g, wa.b ) ), wmn = min( wa.r, min( wa.g, wa.b ) );
  float wsat = ( wmx - wmn ) / max( wmx, 1e-5 );
  vec3 wch = wa / max( wa.r + wa.g + wa.b, 1e-5 );
  float wskin = ( 1.0 - smoothstep( 0.035, 0.075, distance( wch, vec3( 0.45, 0.33, 0.22 ) ) ) ) * smoothstep( 0.2, 0.3, wsat ) * smoothstep( 0.035, 0.07, wl );
  float wwhite = smoothstep( 0.2, 0.32, wl ) * ( 1.0 - smoothstep( 0.12, 0.22, wsat ) );
  vec3 wo = wa;
  for ( int i = 0; i < 3; i ++ ) {
    vec4 K = uCvKey[ i ], R = uCvRng[ i ], D = uCvTo[ i ], M = uCvMask[ i ];
    float w = clamp( dot( vCivW, M.xyz ), 0.0, 1.0 );
    if ( w < 0.001 ) continue;
    float m = K.w > 0.0 ? ( 1.0 - smoothstep( K.w * 0.55, K.w, distance( wch, K.xyz ) ) )
      * smoothstep( R.x * 0.6, R.x, wl ) * ( 1.0 - smoothstep( R.y, R.y * 1.5, wl ) )
      * smoothstep( R.z - 0.08, R.z, wsat ) * ( 1.0 - smoothstep( R.w, R.w + 0.08, wsat ) ) : 0.0;
    w *= M.w > 0.5 ? ( 1.0 - m ) * ( 1.0 - wskin ) * ( 1.0 - wwhite ) : m;
    if ( w < 0.001 ) continue;
    wo = mix( wo, D.rgb * clamp( pow( max( wl, 1e-5 ) / D.w, uCvGam[ i ] ), 0.3, 2.4 ), w );
  }
  // the twin's own skin tone on every skin texel (face, neck, hands)
  diffuseColor.rgb = mix( wo, wo * uCvSkin, wskin );
#ifdef CIV_WARD_DBG
  diffuseColor.rgb = vCivW * 0.5;
#endif
}
#endif`;
const _cv = new THREE.Color();
function civUniforms(swaps) {
  const U = { uCvKey: { value: [] }, uCvRng: { value: [] }, uCvTo: { value: [] }, uCvMask: { value: [] }, uCvGam: { value: [] }, uCvSkin: { value: new THREE.Vector3(1, 1, 1) } };
  for (let i = 0; i < 3; i++) {
    const s = swaps[i];
    let keyLum = s.ref || 0.02;
    if (s.key != null) {
      _cv.setHex(s.key);
      const sum = _cv.r + _cv.g + _cv.b || 1;
      if (!s.garment) keyLum = 0.2126 * _cv.r + 0.7152 * _cv.g + 0.0722 * _cv.b;
      U.uCvKey.value.push(new THREE.Vector4(_cv.r / sum, _cv.g / sum, _cv.b / sum, s.tol));
      U.uCvRng.value.push(new THREE.Vector4(Math.max(0.001, s.lum[0]), s.lum[1], s.sat[0], s.sat[1]));
    } else { U.uCvKey.value.push(new THREE.Vector4(0, 0, 0, 0)); U.uCvRng.value.push(new THREE.Vector4(0.001, 1, 0, 1)); }
    U.uCvTo.value.push(new THREE.Vector4(0.02, 0.02, 0.02, Math.max(1e-4, keyLum)));
    U.uCvMask.value.push(new THREE.Vector4(s.region[0] || 0, s.region[1] || 0, s.region[2] || 0, s.garment ? 1 : 0));
    U.uCvGam.value.push(s.gamma != null ? s.gamma : 0.7);
  }
  return U;
}
// one material per civilian (its own uniforms, one shared program), on every rung of its LOD ladder
function civDress(h, scan) {
  const swaps = CIV_WARD[scan], m0 = h.skinned.material;
  if (!swaps || !m0 || Array.isArray(m0)) return;
  const U = civUniforms(swaps), c = m0.clone(), prev = m0.onBeforeCompile, prevKey = m0.customProgramCacheKey.bind(m0);
  c.name = m0.name + ':civ';
  c.userData = m0.userData;
  c.defines = { ...(m0.defines || {}), CIV_WARD: '' };
  if (typeof location !== 'undefined' && /[?&]civDbg=2/.test(location.search)) c.defines.CIV_WARD_DBG = '';
  c.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader.replace('void main() {', 'attribute vec3 aWard;\nvarying vec3 vCivW;\nvoid main() {\n  vCivW = aWard;');
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'uniform vec4 uCvKey[ 3 ]; uniform vec4 uCvRng[ 3 ]; uniform vec4 uCvTo[ 3 ]; uniform vec4 uCvMask[ 3 ]; uniform float uCvGam[ 3 ]; uniform vec3 uCvSkin;\nvarying vec3 vCivW;\nvoid main() {')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + CIV_GLSL);
    if (c.defines.CIV_WARD_DBG !== undefined) shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  gl_FragColor = vec4( vCivW, 1.0 );');
  };
  c.customProgramCacheKey = () => prevKey() + '|civ';
  charMats.add(c);
  for (const m of h.meshes) if (m.material === m0) m.material = c;
  const slot = { top: [], bottom: [], inner: [] };
  swaps.forEach((s, i) => slot[s.to].push(U.uCvTo.value[i]));
  h.civ = {
    scan, material: c,
    // linear colours (THREE.Color); skin is a multiplier on the scan's own tone
    dress(top, bottom, inner, skin) {
      for (const [k, col] of [['top', top], ['bottom', bottom], ['inner', inner]]) if (col) for (const v of slot[k]) v.set(col.r, col.g, col.b, v.w);
      if (skin) U.uCvSkin.value.set(skin[0], skin[1], skin[2]);
    },
    dispose() { charMats.delete(c); c.dispose(); },
  };
}
// on the final skin weights: every held prop out (a strap bag excepted), then the garment masks, hands kept out of them
function civFinish(geo, R, scan, SC) {
  dropHeldProps(geo, R, 0.11, { bag: CIV_BAG[scan] });
  if (CIV_TEXCUT[scan]) civPropCut(geo, R, civAlbedo(SC));
  if (CIV_WARM[scan]) civWarmCut(geo, R, civAlbedo(SC), CIV_WARM[scan]);
  garmentMask(geo, R, MOB_GARMENT[scan] || { hem: 9 });
  civHands(geo, R, civAlbedo(SC));
}
const CIV_GEO = new Map();
const CIV_WARM_UP = !(typeof location !== 'undefined' && /[?&]poolScan=0/.test(location.search));
function civWarmUp(engine) {
  let last = null;
  for (const sc of civScans()) {
    try { if (last) last.dispose(); last = createHumanoid({ variant: sc, seed: 1, detail: 1, lod: true, civ: true }); } catch (e) { last = null; }
  }
  // the civilian program compiled off the frame (parallel compile), kept alive by this body until it is ready
  const r = engine.renderer;
  if (!last) return;
  if (!r || !r.compileAsync || !engine.scene || !engine.camera) { last.dispose(); return; }
  last.group.position.set(0, -500, 0); engine.scene.add(last.group);
  const done = () => { try { last.dispose(); } catch (e) { void e; } };
  try { r.compileAsync(last.group, engine.camera, engine.scene).then(done, done); } catch (e) { done(); }
}
export function civScans() { return CIV_SCANS.filter((s) => SCANS[s] && SCANS[s].state === 'ready'); }
// The hands are never re-dressed: the auto-skin gives the back of the hand a forearm share, and a scan's grimy knuckles
// fail the skin-chroma test, so a pale top came out as a white glove.
function civSkinTexel(A, uv, i, lo = 45) {
  const N = A.N, u = uv.getX(i), v = uv.getY(i), x = clamp(Math.floor((u - Math.floor(u)) * N), 0, N - 1), y = clamp(Math.floor((v - Math.floor(v)) * N), 0, N - 1), o = (y * N + x) * 4;
  const r = A.d[o], g = A.d[o + 1], b = A.d[o + 2];
  return r > lo && r >= g && g >= b * 0.9 && r - b > 16 && g / r > 0.5 && g / r < 0.93;
}
function civHands(geo, R, A = null) {
  const a = geo.attributes.aWard, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, uv = geo.attributes.uv;
  if (!a || !si) return;
  const NK = R.index.Neck, HD = R.index.Head;
  const L = R.index.LeftHand, Rh = R.index.RightHand, pos = geo.attributes.position;
  // past the wrist along the forearm line is hand, whatever the weights say
  const alb = A;
  const arms = ['Left', 'Right'].map((s) => { const F = R.joints[s + 'ForeArm'], H = R.joints[s + 'Hand'], d = [H[0] - F[0], H[1] - F[1], H[2] - F[2]], l = Math.hypot(...d);
    return { F, d: d.map((x) => x / l), l, fi: R.index[s + 'ForeArm'], hi: R.index[s + 'Hand'] }; });
  let nk = 0;
  for (let v = 0; v < a.count; v++) {
    let hw = 0, k = 1;
    for (let j = 0; j < 4; j++) { const b = si.getComponent(v, j); if (b === L || b === Rh) hw += sw.getComponent(v, j); }
    if (hw > 0.05) k = 1 - sstep((hw - 0.05) / 0.3);
    for (const A of arms) {
      let aw = 0;
      for (let j = 0; j < 4; j++) { const b = si.getComponent(v, j); if (b === A.fi || b === A.hi) aw += sw.getComponent(v, j); }
      if (aw < 0.3) continue;
      const t = (pos.getX(v) - A.F[0]) * A.d[0] + (pos.getY(v) - A.F[1]) * A.d[1] + (pos.getZ(v) - A.F[2]) * A.d[2];
      k = Math.min(k, 1 - sstep((t - A.l + 0.005) / 0.02));
      // the last 6 cm of the forearm and the hand: skin-coloured is skin, however the weights fell
      if (alb && uv && t > A.l - 0.06 && civSkinTexel(alb, uv, v)) k = 0;
    }
    if (alb && uv && k > 0) {
      let nw = 0, fw = 0;
      for (let j = 0; j < 4; j++) {
        const b = si.getComponent(v, j), w = sw.getComponent(v, j);
        if (b === NK || b === HD) nw += w;
        if (b === arms[0].fi || b === arms[1].fi || b === arms[0].hi || b === arms[1].hi) fw += w;
      }
      // on the neck any skin-coloured texel is skin; on the forearm a LIGHT one is (a hand whose joint the fit left in
      // the fist) -- a dark brown one there may be the bomber's leather sleeve
      if ((nw > 0.3 && civSkinTexel(alb, uv, v)) || (fw > 0.3 && civSkinTexel(alb, uv, v, 95))) k = 0;
    }
    if (k < 1) { a.setXYZ(v, a.getX(v) * k, a.getY(v) * k, a.getZ(v) * k); nk++; }
  }
  if (CIV_DBG) console.info('[humanoid] civHands alb', !!alb, nk, 'of', a.count, 'hand idx', L, Rh, 'arms', JSON.stringify(arms.map((A) => [A.l.toFixed(3), A.fi, A.hi])));
}
// trouser cross-sections from the scan's cut down to the shoe. The first ring is 4 mm proud of the open thigh tube
// so it swallows the cut edge instead of showing a rim, then drifts from the scan's thigh axis onto the bone.
// Round 4's table tapered with the leg — 0.0865 at the thigh cut down to 0.0706 at the calf — so the silhouette
// traced the kneecap and the calf exactly and the hero wore leggings from the hip down. A trouser is a tube that
// HANGS: it stops tapering below the knee, it gathers behind the knee, and it breaks forward over the shoe. The
// fold rings are at 1.7 cm spacing in the two zones that gather, because a wrinkle sampled by rings 5 cm apart is
// not a wrinkle. [y, rx, rz, kneecap, drape, forward break]
const HERO_LEG_ROWS = [
  [0.755, 0.0865, 0.1035, 0, 0, 0], [0.730, 0.0858, 0.1018, 0, 0.006, 0], [0.697, 0.0850, 0.0996, 0, 0.012, 0],
  [0.680, 0.0842, 0.0978, 0, 0.022, 0], [0.663, 0.0848, 0.0986, 0, 0.007, 0],                       // hip break: seat fold
  [0.646, 0.0840, 0.0960, 0, 0.026, 0], [0.628, 0.0830, 0.0944, 0, 0.008, 0],                     // thigh drape
  [0.610, 0.0834, 0.0938, 0, 0.028, 0], [0.592, 0.0824, 0.0920, 0, 0.010, 0],
  [0.574, 0.0826, 0.0912, 0, 0.030, 0], [0.556, 0.0816, 0.0896, 0, 0.012, 0], [0.545, 0.0812, 0.0888, 0, 0.030, 0],
  [0.512, 0.0834, 0.0896, 0.012, 0.030, 0], [0.487, 0.0812, 0.0866, 0.014, 0.020, 0],
  [0.470, 0.0820, 0.0880, 0.008, 0.030, 0], [0.453, 0.0810, 0.0864, 0.004, 0.008, 0],               // behind-the-knee bunch
  [0.436, 0.0818, 0.0876, 0, 0.032, 0], [0.419, 0.0808, 0.0862, 0, 0.010, 0],
  [0.400, 0.0812, 0.0868, 0, 0.026, 0], [0.330, 0.0800, 0.0854, 0, 0.022, 0], [0.250, 0.0792, 0.0846, 0, 0.018, 0],
  [0.196, 0.0790, 0.0846, 0, 0.022, 0.002], [0.178, 0.0800, 0.0858, 0, 0.008, 0.003],               // hem break over the instep
  [0.160, 0.0792, 0.0848, 0, 0.026, 0.004], [0.142, 0.0806, 0.0866, 0, 0.010, 0.006],
  [0.124, 0.0812, 0.0876, 0, 0.018, 0.008], [0.104, 0.0804, 0.0868, 0, 0.004, 0.010], [0.082, 0.058, 0.064, 0, 0, 0.010],
];
const trouserShape = (rx, rz, kb, wr, y) => {
  const rr = (rx + rz) * 0.5;
  return (a) => {
    const [x, z] = sellipse(a, rx, rz, 2.1);
    const df = adiff(a, HPI), db = adiff(a, -HPI);
    let k = 1 + 0.028 * (gauss(df, 0.22) + gauss(db, 0.30));                    // the swell either side of the crease
    k += (0.0022 / rr) * (gauss(df, 0.05) + 0.7 * gauss(db, 0.05));             // and the pressed crease itself: 2 mm
    k += kb * gauss(df, 0.5);                                                   // kneecap
    k += wr * (0.5 + 0.5 * Math.sin(a * 6 + y * 90)) * gauss(db, 0.9);          // folds bunch behind the knee
    k += wr * 0.45 * Math.sin(a * 11 + y * 63) * (0.4 + 0.6 * gauss(db, 1.3));  // and a shallower second octave all round
    k -= 0.010 * gauss(df - 0.95, 0.14) * sstep((y - 0.55) / 0.12);             // side-seam / fly shadow at the hip
    return [x * k, z * k];
  };
};
// The legs and shoes wear the SCAN's own material: the largest clean square of trouser weave and of case leather in
// the 2048² atlas (found offline by rasterising the uv charts), ping-ponged across the loft's metric uv. Same albedo,
// roughness and normal detail as the cloth above the cut — and the whole hero collapses to one draw call.
const HERO_UV_TROUSER = [0.6953, 0.7422, 0.7324, 0.7793], HERO_UV_LEATHER = [0.7383, 0.3613, 0.7949, 0.4180];
// The trouser patch is a clean square of the jacket's own weave, so the two halves of the suit come out at exactly
// one value. A jacket hangs over a trouser; the trouser falls away from the sky. 0.84 is that break, on the vertex
// colour, inside the hero's single draw call.
const HERO_TROUSER_TINT = [0.84, 0.84, 0.87];
const pingpong = (x) => { const t = ((x % 2) + 2) % 2; return t > 1 ? 2 - t : t; };
function uvPatch(g, p, k) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, p[0] + pingpong(uv.getX(i) * k) * (p[2] - p[0]), p[1] + pingpong(uv.getY(i) * k) * (p[3] - p[1]));
  return g;
}
function buildHeroLegs(K, R, parts, mats) {
  const T = HERO.data.thigh, segs = K.segs;
  for (const side of SIDES) {
    const ch = chainSegs(R, ['Hips', side + 'UpLeg', side + 'Leg', side + 'Foot', side + 'ToeBase'], 0.075);
    const U = ch[1], Lg = ch[2], F = ch[3], t0 = T[side];
    const rings = HERO_LEG_ROWS.map(([y, rx, rz, kb, wr, bz]) => {
      const f = sstep((0.755 - y) / 0.21);
      const cx = lerp(t0.x, Lg.a.x, f), cz = lerp(t0.z, Lg.a.z, f) + (bz || 0);
      const w = y > 0.50 ? U.w : y > 0.095 ? Lg.w : F.w;
      return yring(y, rx, rz, w, { ox: cx, oz: cz, uScale: 11.7 * TAU * (rx + rz) / 2, shape: trouserShape(rx, rz, kb, wr, y) });
    });
    // fade the trouser tint in over the first 9 cm: applied flat it put a hard horizontal value step across both
    // legs exactly where the scan's thigh is cut and the loft takes over
    const tint = (p, rgb) => { const t = sstep((0.755 - p.y) / 0.09); return [lerp(1, rgb[0], t), lerp(1, rgb[1], t), lerp(1, rgb[2], t)]; };
    parts.push({ geo: vcolor(uvPatch(loft(rings, { segs, uv: [1, 11.7] }), HERO_UV_TROUSER, 1.645), HERO_TROUSER_TINT, tint), mat: mats.trousers });
    // (fix round 4: the shoes wear their own calf and rubber materials, not the atlas's case-leather square)
    buildShoe(K, side, F, parts, mats);
  }
}
// the face record the skin atlas is keyed on (the hero only needs its palm/finger strips: his face is the scan's)
function heroFace(V) {
  return { skin: V.skin, hairTop: (HAIR_STYLES[V.hair] || HAIR_STYLES.short).front, hair: '#' + new THREE.Color(V.hairColor).multiplyScalar(0.6).getHexString(),
    brow: V.browW, browAngle: V.browAngle, stubble: V.stubble, beard: V.beard || 0, nlf: V.nlf || 0, age: V.age, scar: !!V.scar,
    iris: V.iris || [70, 42, 30], lip: V.lip || null, lipA: V.lipA ?? 1, hires: !!V.hires, fem: !!V.fem };
}
// 優先3 (client: 「顔、目、髪、関節の変形」): a rigid head. The offline auto-skin gave the face a gradient between Head
// and Neck — on 健人 the mouth row is 98 % Neck, the nose 60 %, the eyes 50 %, the brows 0 %, and the chapter-1 scans
// carry 20-70 % Neck across the lower face. Any head turn against the neck (the idle's 6° look, the stance's chin,
// a head-snap reaction, the knockdown's roll) therefore moved the brows with the skull and left the mouth with the
// neck: the face sheared (measured 1.4 cm in his idle, 5.3 cm under hit_light; docs/reports/characters.md) — the
// 「顔が歪んでる」 the round-3 idle head yaw only made visible. A skull and a jaw do not bend: above the jaw / skull-
// base line every head-or-neck vertex rides the Head bone alone, and the Neck takes over in the 3 cm of neck under
// that line. The line, per scan in bind space, measured off the midline profile of each lod0 (chin underside at the
// throat, the jaw angle, the nape): [y, z] points; z runs to his front.
const HEAD_CUT = {
  hero: { chin: [1.535, 0.035], jaw: [1.575, -0.015], nape: [1.625, -0.07] },
  enforcer_b: { chin: [1.515, 0.03], jaw: [1.55, -0.025], nape: [1.585, -0.085] },
  enforcer_a: { chin: [1.535, -0.045], jaw: [1.565, -0.095], nape: [1.60, -0.16] },
  wanderer: { chin: [1.505, -0.01], jaw: [1.535, -0.07], nape: [1.565, -0.11] },
  // the story cast's Meshy models (assets/hero/pipeline/v2), off their lod0 midlines the same way: the chin's underside
  // meets the throat at y 1.55 / z 0.06 (hero) and 1.56 / 0.045 (柊); the nape under the hero's taper at 1.615, under
  // 柊's long hair (which rides Head -> Neck -> Spine2 by height, buildScan's `hair`) at the same line
  // (the chin point 1 cm under that corner, as v1's: at the corner itself the underside of the goatee sat in the
  // 3 cm Head -> Neck ramp and sheared 3 mm under hit_light)
  hero_v2: { chin: [1.540, 0.060], jaw: [1.578, 0.0], nape: [1.615, -0.085] },
  hiiragi: { chin: [1.550, 0.045], jaw: [1.585, -0.005], nape: [1.620, -0.085] },
  // the club trio, measured the same way (chin / throat corner at 1.555 / 1.562 / 1.556, 1 cm under it; nape 1.615-1.625)
  club_miku: { chin: [1.545, 0.062], jaw: [1.582, 0.0], nape: [1.615, -0.085] },
  club_kai: { chin: [1.552, 0.062], jaw: [1.588, 0.0], nape: [1.625, -0.085] },
  club_tenma: { chin: [1.546, 0.062], jaw: [1.582, 0.0], nape: [1.615, -0.085] },
};
const NO_RIGID_HEAD = typeof location !== 'undefined' && /[?&]rigidHead=0/.test(location.search);   // A/B
function headCutY(C, z) {
  const [cy, cz] = C.chin, [jy, jz] = C.jaw, [ny, nz] = C.nape;
  if (z >= cz) return cy;
  if (z >= jz) return jy + (cy - jy) * (z - jz) / (cz - jz);
  if (z >= nz) return ny + (jy - ny) * (z - nz) / (jz - nz);
  return ny;
}
// Rewrites skinIndex/skinWeight on copies (heroPart's attributes are views into the shared scan buffer). Only vertices
// inside the skull's ellipsoid round the Head joint that already ride Head or Neck are touched: a jacket collar standing
// behind the neck, the shirt collar and the shoulders keep their weights. geo.userData.headRigid flags the vertices it
// made head (enemy.js keeps them there when it re-splits the neck).
function rigidHead(g, R, C) {
  if (!C || NO_RIGID_HEAD || !g || !g.attributes.skinIndex) return g;
  const pos = g.attributes.position, si0 = g.attributes.skinIndex, sw0 = g.attributes.skinWeight, n = pos.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) { si[i] = si0.array[i]; sw[i] = sw0.array[i]; }
  const HD = R.index.Head, NK = R.index.Neck, J = R.joints.Head;
  const cx = J[0], cy = J[1] + 0.07, cz = J[2] + 0.02;
  const flag = new Uint8Array(n);
  const w = new Map();
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ex = (x - cx) / 0.13, ey = (y - cy) / 0.19, ez = (z - cz) / 0.16;
    if (ex * ex + ey * ey + ez * ez > 1) continue;
    let wh = 0, wn = 0;
    for (let k = 0; k < 4; k++) { const b = si[i * 4 + k], v = sw[i * 4 + k]; if (b === HD) wh += v; else if (b === NK) wn += v; }
    const s = wh + wn;
    if (s < 0.3) continue;
    const yc = headCutY(C, z);
    const h = smooth01((y - (yc - 0.03)) / 0.035);               // the head's share of the head/neck pair
    const hh = smooth01((y - yc) / 0.03);                        // above the line the head also takes the rest
    w.clear();
    for (let k = 0; k < 4; k++) { const b = si[i * 4 + k], v = sw[i * 4 + k]; if (v > 0 && b !== HD && b !== NK) w.set(b, (w.get(b) || 0) + v * (1 - hh)); }
    let rest = 0; for (const v of w.values()) rest += v;
    const pair = s + (1 - s - rest);                             // what the others gave up joins the pair
    w.set(HD, pair * Math.max(h, hh)); w.set(NK, pair * (1 - Math.max(h, hh)));
    const top = [...w.entries()].filter((e) => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    let tot = 0; for (const e of top) tot += e[1];
    for (let k = 0; k < 4; k++) { si[i * 4 + k] = top[k] ? top[k][0] : 0; sw[i * 4 + k] = top[k] ? top[k][1] / tot : 0; }
    if (Math.max(h, hh) > 0.5) flag[i] = 1;
    if (Math.abs(wh - (w.get(HD) || 0)) > 0.02) moved++;
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.userData.headRigid = flag; g.userData.headMoved = moved;
  return g;
}
function smooth01(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
// The scan's eyes are painted onto the face with no geometry and no specular at all, so the lead's eyes read dead
// under a hundred neon signs. Find where they are on HIS head — Head-weighted vertices, eye level at 42 % down
// from the crown, frontmost surface either side of the nose — and cap each with a 12.8 mm cornea.
let _eyeSpots;
function heroEyeSpots(geo, R) {
  if (_eyeSpots !== undefined) return _eyeSpots;
  const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  if (!pos || !si || !sw) return null;
  const HEAD = RIG.index.Head;
  let ymin = Infinity, ymax = -Infinity;
  const keep = [];
  for (let i = 0; i < pos.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === HEAD) w += sw.getComponent(i, k);
    if (w < 0.8) continue;
    const y = pos.getY(i);
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    keep.push(i);
  }
  if (keep.length < 200 || !(ymax > ymin)) return (_eyeSpots = null);
  const hx = R.joints.Head[0], hy = R.joints.Head[1];
  // The scan's own face below the brow is weighted to Neck, not Head, so anything measured inside the Head mask
  // lands on the forehead (that put two eyeballs above his eyebrows). Anchor on the CROWN — the top of the head
  // mask, which is the top of the man — and take the eye line 14.2 cm below it, which is where his painted eyes
  // are. The cornea then inherits the skin weights of the face vertex it sits on, so it turns with the head
  // whichever bone that patch happens to ride.
  // Measured off the atlas (the darkest 8 % of the front-most eye texels, finish_maps.py's position map): the painted
  // irises sit 14.4 cm under the crown, 2.92 cm to his right of Head.x and 3.26 cm to his left — the scan's face is
  // not symmetric about the joint, and a symmetric guess put the right cap on the inner canthus.
  // Fix round 2: the depth came from the front-most vertex within ±1 cm, which is the UPPER LID (it stands 5 mm
  // proud of the eye), so the cap's centre sat at the lid and its front 1 cm in front of the eye: a glint smeared
  // across the painted lid, a bubble in the frontal macro. Re-measured column by column off the atlas
  // (region_map.py's position map): his eyes are narrow (a 6 mm opening), the visible iris is at 14.97 / 14.59 cm
  // under the crown, the eye surface there at z 0.0985 / 0.0976, and the lids close over anything above or below.
  // The cap now sits 1.5 mm proud of THAT surface; the lids' own depth hides the rest of the sphere.
  const EYE = [[-0.0308, 0.1497, 0.0985], [0.0355, 0.1459, 0.0976]];
  if (ymax - 0.15 < hy + 0.02 || ymax - 0.15 > hy + 0.16) return (_eyeSpots = null);
  const spots = [];
  for (const [ox, oy, sz] of EYE) {
    const ex = hx + ox, eyeY = ymax - oy;
    let bd = Infinity, bi = -1;
    for (let i = 0; i < pos.count; i++) {
      const d = (pos.getX(i) - ex) ** 2 + (pos.getY(i) - eyeY) ** 2 + (pos.getZ(i) - sz) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi < 0 || bd > 0.012 * 0.012) return (_eyeSpots = null);
    const w = [];
    for (let k = 0; k < 4; k++) { const x = sw.getComponent(bi, k); if (x > 0.01) w.push([si.getComponent(bi, k), x]); }
    spots.push({ p: [ex, eyeY, sz + 0.0015 - 0.0078], w: w.length ? w : [[RIG.index.Head, 1]] });
  }
  _eyeSpots = spots;
  if (typeof location !== 'undefined' && location.search.includes('heroDebug=eyes')) {
    console.info('[humanoid] hero eyes', JSON.stringify(spots.map((e) => e.p.map((v) => +v.toFixed(3)))), 'crown', +ymax.toFixed(3));
  }
  return spots;
}
// Round 3 lofted two horn buttons, a steel buckle frame and eight cuff buttons onto the scan, because against the
// de-lit albedo his own tailoring had been graded out of existence. With the scan's own maps back
// (docs/ref/hero-model-views.png TORSO 3/4) he already wears a single waist button, a chest-pocket welt, hip-pocket
// flaps, a dark brown belt with a silver buckle and a navy pocket square, all modelled and photographed. The added
// hardware sat proud of that and read as debris glued to the sleeves. Removed — one draw call back, nothing lost.
// Stray islands at the wrists. The offline hand split left ~20 small pieces of the scan disconnected from the body:
// fingertip slivers on the free hand skinned to Spine/Hips, and bits of the steel bracelet skinned to Hips. At bind
// they sit where they belong; the moment an arm moves they stay at the hip — the brown shard beside his index
// finger and the jagged slivers round the watch. Each island under 60 triangles within reach of a hand takes the
// skin weights of the nearest arm-chain vertex of the body, so it rides the wrist it was cut from.
function mendHeroShards(g, R) {
  const pos = g.attributes.position, idx = g.index.array, n = pos.count;
  let si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  if (!si || !sw) return g;
  const weld = new Int32Array(n), first = new Map();
  for (let i = 0; i < n; i++) {
    const k = Math.round(pos.getX(i) * 2000) + ',' + Math.round(pos.getY(i) * 2000) + ',' + Math.round(pos.getZ(i) * 2000);
    const p = first.get(k); if (p === undefined) { first.set(k, i); weld[i] = i; } else weld[i] = p;
  }
  const par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let f = 0; f < idx.length; f += 3) {
    const a = find(weld[idx[f]]), b = find(weld[idx[f + 1]]), c = find(weld[idx[f + 2]]);
    if (a !== c) par[a] = c;
    if (find(b) !== find(c)) par[find(b)] = find(c);
  }
  const tris = new Map();
  for (let f = 0; f < idx.length; f += 3) { const r = find(weld[idx[f]]); tris.set(r, (tris.get(r) || 0) + 1); }
  let main = -1, mt = 0; for (const [r, t] of tris) if (t > mt) { mt = t; main = r; }
  const sides = ['Left', 'Right'].map((s) => ({ hand: new THREE.Vector3(...R.joints[s + 'Hand']), chain: new Set([R.index[s + 'ForeArm'], R.index[s + 'Hand']]) }));
  const armShare = (i, chain) => { let w = 0; for (let k = 0; k < 4; k++) if (chain.has(si.getComponent(i, k))) w += sw.getComponent(i, k); return w; };
  const members = new Map();
  for (let i = 0; i < n; i++) { const r = find(weld[i]); if (r === main || (tris.get(r) || 0) >= 60) continue; if (!members.has(r)) members.set(r, []); members.get(r).push(i); }
  const c = new THREE.Vector3(), p = new THREE.Vector3();
  let mended = 0, cloned = false;
  for (const vs of members.values()) {
    c.set(0, 0, 0); for (const i of vs) c.x += pos.getX(i), c.y += pos.getY(i), c.z += pos.getZ(i);
    c.multiplyScalar(1 / vs.length);
    const S = sides.find((s) => s.hand.distanceTo(c) < 0.13);
    if (!S) continue;
    let own = 0; for (const i of vs) own += armShare(i, S.chain);
    if (own / vs.length > 0.5) continue;
    if (!cloned) { si = si.clone(); sw = sw.clone(); g.setAttribute('skinIndex', si); g.setAttribute('skinWeight', sw); cloned = true; }
    for (const i of vs) {
      p.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      let best = -1, bd = Infinity;
      for (let j = 0; j < n; j++) {
        if (find(weld[j]) !== main || armShare(j, S.chain) < 0.5) continue;
        const d = (pos.getX(j) - p.x) ** 2 + (pos.getY(j) - p.y) ** 2 + (pos.getZ(j) - p.z) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      if (best < 0) continue;
      for (let k = 0; k < 4; k++) { si.setComponent(i, k, si.getComponent(best, k)); sw.setComponent(i, k, sw.getComponent(best, k)); }
    }
    mended += vs.length;
  }
  g.userData.shardsMended = mended;
  return g;
}
// Fix round 2: what finish.mjs's shard mend re-skinned but left in place — 17 islands of 1-51 triangles round the
// wrists (bits of the steel bracelet, the attaché's handle welded into the left fist, the cuff's torn lip) — are
// the grey flap standing up over the watch strap and the dark blade in front of the knuckles. Islands under 150
// triangles within 16 cm of a hand joint are dropped; the two wrist plugs (728 each) and the body are kept.
// ?heroIsl=show paints them red instead, ?heroIsl=keep leaves them.
const HERO_ISL = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('heroIsl') : null;
function dropHandIslands(g, R, maxTris = 150) {
  if (HERO_ISL === 'keep') return g;
  const pos = g.attributes.position, idx = g.index.array, n = pos.count;
  const weld = new Int32Array(n), first = new Map();
  for (let i = 0; i < n; i++) {
    const k = Math.round(pos.getX(i) * 2000) + ',' + Math.round(pos.getY(i) * 2000) + ',' + Math.round(pos.getZ(i) * 2000);
    const p = first.get(k); if (p === undefined) { first.set(k, i); weld[i] = i; } else weld[i] = p;
  }
  const par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let f = 0; f < idx.length; f += 3) {
    const a = find(weld[idx[f]]), b = find(weld[idx[f + 1]]), c = find(weld[idx[f + 2]]);
    if (a !== c) par[a] = c;
    if (find(b) !== find(c)) par[find(b)] = find(c);
  }
  const tris = new Map(), cen = new Map();
  for (let f = 0; f < idx.length; f += 3) {
    const r = find(weld[idx[f]]); tris.set(r, (tris.get(r) || 0) + 1);
    let c = cen.get(r); if (!c) cen.set(r, c = [0, 0, 0, 0]);
    const v = idx[f]; c[0] += pos.getX(v); c[1] += pos.getY(v); c[2] += pos.getZ(v); c[3]++;
  }
  const hands = ['Left', 'Right'].map((s) => R.joints[s + 'Hand']);
  const drop = new Set();
  for (const [r, t] of tris) {
    if (t >= maxTris) continue;
    const c = cen.get(r), x = c[0] / c[3], y = c[1] / c[3], z = c[2] / c[3];
    if (hands.some((h) => Math.hypot(x - h[0], y - h[1], z - h[2]) < 0.16)) drop.add(r);
  }
  if (!drop.size) return g;
  if (HERO_ISL === 'show') {                       // islands red, finish.mjs's wrist plugs and patches green
    const col = g.attributes.color, sp = g.attributes.seamPatch;
    if (col) for (let i = 0; i < n; i++) {
      if (drop.has(find(weld[i]))) col.setXYZ(i, 1, 0, 0);
      else if (sp && sp.getX(i) > 0.5) col.setXYZ(i, 0, 1, 0);
    }
    console.info('[humanoid] hand islands', drop.size);
    return g;
  }
  const keep = [];
  let gone = 0;
  for (let f = 0; f < idx.length; f += 3) { if (drop.has(find(weld[idx[f]]))) { gone++; continue; } keep.push(idx[f], idx[f + 1], idx[f + 2]); }
  g.setIndex(new THREE.BufferAttribute(new (n > 65535 ? Uint32Array : Uint16Array)(keep), 1));
  g.userData.islandsDropped = gone;
  return g;
}
// Fix round 2: the shirt cuffs and the watch. The scan's cuff is a crumpled white rag that glows at night, and its
// bracelet is a torn grey sheet with finish.mjs's wrist plug showing through it — the one part of the hero that
// looked broken at gameplay distance. Both wrists are rebuilt: a clean 1.5 cm poplin cuff (a lofted tube with a
// turned lip, uv on a flat white square of his own shirt chart so it lights like the collar) and, on the LEFT
// wrist (docs/HERO.md), a steel bracelet with a round case, crystal and navy dial. The scan inside that band is
// pulled in under them and made rigid to the forearm, so nothing of the rag can poke out when the wrist turns.
// Axis and sleeve line measured off the scan's cross-sections (bind pose, metres): the forearm axis runs along
// ForeArm->Hand through `c`; the jacket sleeve ends at world y `sleeve`.
const HERO_WRIST = {
  Left: { c: [0.240, 1.030, 0.045], sleeve: 0.984, r: [0.041, 0.045], watch: true },
  Right: { c: [-0.271, 1.000, -0.003], sleeve: 0.957, r: [0.040, 0.044], watch: false },
};
const HERO_UV_POPLIN = [0.2383, 0.5586, 0.2617, 0.5820];
// the scan's own steel bracelet: the cleanest metal square of the atlas (ORM blue 190-230), found off the 1024 ORM
const HERO_UV_STEEL = [0.4844, 0.1348, 0.4893, 0.1416];
const WATCH_FLAT = typeof location !== 'undefined' && /[?&]heroWatch=flat/.test(location.search);
const NO_WRIST = typeof location !== 'undefined' && /[?&]heroWrist=0/.test(location.search);   // A/B: the scan's own cuffs
const NO_HEM = typeof location !== 'undefined' && /[?&]heroHem=0/.test(location.search);       // A/B: the scan's torn sleeve hem
function wristFrame(R, side) {
  const W = HERO_WRIST[side], F = R.joints[side + 'ForeArm'], H = R.joints[side + 'Hand'];
  const ax = new THREE.Vector3(H[0] - F[0], H[1] - F[1], H[2] - F[2]).normalize();
  const c = new THREE.Vector3(...W.c);
  const u = new THREE.Vector3(1, 0, 0).addScaledVector(ax, -ax.x).normalize();
  const v = new THREE.Vector3().crossVectors(ax, u).normalize();
  const sSleeve = (W.sleeve - c.y) / ax.y;
  return { W, ax, c, u, v, sSleeve, bone: R.index[side + 'ForeArm'] };
}
// pull the scan in under the cuff / bracelet band and pin it to the forearm
function tuckWrists(g, R) {
  const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, uv = g.attributes.uv;
  if (!si || !sw) return g;
  const d = new THREE.Vector3();
  let moved = 0;
  // Round 3: the scan's own cuff where it stands proud of the sleeve hem (the torn white rag the critic saw on the
  // free hand) or hangs off the torso's weights is shirt all the same: told apart from the charcoal sleeve by its
  // albedo, and taken in under the lofted cuff with the rest
  const A = HERO.mat && HERO.mat.map ? civAlbedo(HERO) : null;
  const shirt = (i) => {
    if (!A || !uv) return false;
    const N = A.N, x = clamp(Math.floor((uv.getX(i) - Math.floor(uv.getX(i))) * N), 0, N - 1), y = clamp(Math.floor((uv.getY(i) - Math.floor(uv.getY(i))) * N), 0, N - 1), o = (y * N + x) * 4;
    const r = A.d[o], gg = A.d[o + 1], b = A.d[o + 2], mx = Math.max(r, gg, b);
    return mx > 88 && (mx - Math.min(r, gg, b)) / mx < 0.22;   // the poplin, and the bracelet's torn grey sheet
  };
  for (const side of SIDES) {
    const f = wristFrame(R, side), [rx, ry] = f.W.r;
    const armSet = new Set(['Arm', 'ForeArm', 'Hand'].map((b) => R.index[side + b]));
    // up inside the sleeve too: the scan's cuff runs 3 cm up under the jacket and its torn top edge showed through
    // the sleeve's open hem. Inside the sleeve only the shirt is taken (the sleeve itself stands at e ≈ 1.25-1.35).
    // (fix round 4: the bracelet moved onto the bare wrist past the cuff, so the tuck runs 4 cm past the sleeve there)
    const s0 = f.sSleeve - 0.004, sUp = f.sSleeve - 0.040, s1 = f.sSleeve + (f.W.watch ? 0.040 : 0.0165);
    for (let i = 0; i < pos.count; i++) {
      d.set(pos.getX(i) - f.c.x, pos.getY(i) - f.c.y, pos.getZ(i) - f.c.z);
      const s = d.dot(f.ax);
      if (s < sUp || s > s1 + 0.014) continue;
      const x = d.dot(f.u), y = d.dot(f.v), e = Math.hypot(x / rx, y / ry);
      if (s > s1) {
        // the scan's ragged wrist edge just past the band: drawn into the cuff's mouth (weights untouched), so a bent
        // wrist does not lift a tooth of skin over the lip
        const k2 = 0.84 + 0.14 * sstep((s - s1) / 0.014);
        if (e > k2 && e < 1.45) { const q = k2 / e; pos.setXYZ(i, f.c.x + f.ax.x * s + (f.u.x * x + f.v.x * y) * q, f.c.y + f.ax.y * s + (f.u.y * x + f.v.y * y) * q, f.c.z + f.ax.z * s + (f.u.z * x + f.v.z * y) * q); }
        continue;
      }
      if (e > 1.45) continue;                                   // the other hand, the jacket skirt: not this wrist
      const white = e < 1.4 && shirt(i);
      if (s < s0 && e > 1.16 && !white) continue;               // the sleeve
      let arm = 0;                                              // the hip and the jacket skirt hang beside this wrist
      for (let k = 0; k < 4; k++) if (armSet.has(si.getComponent(i, k))) arm += sw.getComponent(i, k);
      if (arm < 0.5 && !(white && arm > 0.1)) continue;
      const inWatch = f.W.watch && s > f.sSleeve + 0.016;
      const k = inWatch ? 0.80 : 0.88;
      if (e > k) {
        const q = k / e;
        pos.setXYZ(i, f.c.x + f.ax.x * s + (f.u.x * x + f.v.x * y) * q, f.c.y + f.ax.y * s + (f.u.y * x + f.v.y * y) * q, f.c.z + f.ax.z * s + (f.u.z * x + f.v.z * y) * q);
      }
      si.setXYZW(i, f.bone, 0, 0, 0); sw.setXYZW(i, 1, 0, 0, 0);
      moved++;
    }
  }
  pos.needsUpdate = si.needsUpdate = sw.needsUpdate = true;
  g.userData.wristTucked = moved;
  return g;
}
// Round 3: the jacket's own sleeve hem, measured. The scan's hem is a torn edge (dark slivers, the lining showing
// between it and the cuff when the lens looks down the sleeve). Per 10° of the wrist frame the outermost jacket
// vertex over the last 3.5 cm of sleeve gives the hem's own section; a 2 cm band of the jacket's weave is lofted
// 1.5 mm proud of it with a turned-in edge down to the cuff, so the sleeve ends in a finished hem.
const HEM_N = 36;
function sleeveProfile(g, R, side) {
  const f = wristFrame(R, side), [rx, ry] = f.W.r, pos = g.attributes.position, idx = g.index.array, d = new THREE.Vector3();
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, armSet = new Set(['Arm', 'ForeArm', 'Hand'].map((b) => R.index[side + b]));
  const prof = new Float32Array(HEM_N).fill(0), seen = new Uint8Array(pos.count);
  for (let t = 0; t < idx.length; t++) {
    const i = idx[t]; if (seen[i]) continue; seen[i] = 1;
    d.set(pos.getX(i) - f.c.x, pos.getY(i) - f.c.y, pos.getZ(i) - f.c.z);
    const s = d.dot(f.ax);
    if (s < f.sSleeve - 0.035 || s > f.sSleeve + 0.001) continue;
    const x = d.dot(f.u), y = d.dot(f.v), e = Math.hypot(x / rx, y / ry);
    if (e > 1.6 || e < 1.0) continue;
    let arm = 0;                                                // the jacket skirt hangs beside the wrist: not sleeve
    for (let k = 0; k < 4; k++) if (armSet.has(si.getComponent(i, k))) arm += sw.getComponent(i, k);
    if (arm < 0.6) continue;
    const b = ((Math.round(Math.atan2(y / ry, x / rx) / TAU * HEM_N) % HEM_N) + HEM_N) % HEM_N;
    if (e > prof[b]) prof[b] = e;
  }
  // gaps from their neighbours, then a light smoothing (a hem is a smooth curve, the scan's edge is not)
  const ok = Array.from(prof).filter((v) => v > 0);
  if (ok.length < HEM_N * 0.6) return null;
  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  for (let b = 0; b < HEM_N; b++) if (!prof[b]) prof[b] = mean;
  const out = new Float32Array(HEM_N);
  for (let b = 0; b < HEM_N; b++) out[b] = Math.max(prof[b], 0.5 * prof[b] + 0.25 * (prof[(b + 1) % HEM_N] + prof[(b + HEM_N - 1) % HEM_N]));
  return out;
}
function buildHeroWrists(R, parts, mats, detail, hems = null) {
  const segs = Math.max(12, Math.round(30 * detail));
  for (const side of SIDES) {
    const f = wristFrame(R, side), [rx, ry] = f.W.r, w = () => [[f.bone, 1]];
    const at = (s, k, o = {}) => ({ c: f.c.clone().addScaledVector(f.ax, s), u: f.u, v: f.v, rx: rx * k, ry: ry * k, w, shape: o.shape || null });
    // cuff: 1.4 cm up inside the sleeve, 1.5 cm showing, a rolled lip turning back in at the open edge
    const sl = f.sSleeve;
    const hp = hems && hems[side];
    if (hp && !NO_HEM) {
      const eAt = (a) => { const t = ((a / TAU) * HEM_N % HEM_N + HEM_N) % HEM_N, b0 = Math.floor(t), k = t - b0; return lerp(hp[b0 % HEM_N], hp[(b0 + 1) % HEM_N], k); };
      // buried at the top, flush with the sleeve 1 cm up, 1.2 mm proud at the hem, then turned in flat onto the cuff
      const hem = (dk, flat = 0) => (a) => { const e = lerp(eAt(a) + dk, 1.03, flat); return [Math.cos(a) * rx * e, Math.sin(a) * ry * e]; };
      const band = loft([at(sl - 0.040, 1, { shape: hem(-0.04) }), at(sl - 0.026, 1, { shape: hem(0.0) }), at(sl - 0.010, 1, { shape: hem(0.028) }),
        at(sl - 0.001, 1, { shape: hem(0.028) }), at(sl + 0.0012, 1, { shape: hem(0.0) }), at(sl + 0.0016, 1, { shape: hem(0, 0.6) }), at(sl + 0.0016, 1, { shape: hem(0, 1) })],
      { segs: Math.max(24, segs), uv: [3, 30] });
      parts.push({ geo: vcolor(uvPatch(band, HERO_UV_TROUSER, 1), [0.92, 0.92, 0.95]), mat: mats.body });
    }
    const cuff = loft([at(sl - 0.014, 0.965), at(sl + 0.004, 1.0), at(sl + 0.0125, 1.0), at(sl + 0.0152, 0.985), at(sl + 0.0165, 0.945), at(sl + 0.0158, 0.905), at(sl + 0.008, 0.89)],
      { segs, uv: [1, 20] });
    // Fix round 4 (critic #7): the turned edge and the last 2 mm of the lip go dark (a hem's own fold shadow), and a
    // pearl button sits on the outer face — the cuff read as a strip of white tape round the wrist
    const edgeAt = (p) => sstep((p.clone().sub(f.c).dot(f.ax) - (sl + 0.0120)) / 0.0035);
    parts.push({ geo: vcolor(uvFit(cuff, ...HERO_UV_POPLIN), [0.96, 0.96, 0.955], (p, rgb) => { const e = edgeAt(p); return [lerp(rgb[0], 0.50, e), lerp(rgb[1], 0.50, e), lerp(rgb[2], 0.52, e)]; }), mat: mats.body });
    { const tb = side === 'Left' ? 0.38 : Math.PI - 0.38;
      const bd = f.u.clone().multiplyScalar(Math.cos(tb) * rx).addScaledVector(f.v, Math.sin(tb) * ry);
      const bo = bd.length(); bd.normalize();
      const bc = f.c.clone().addScaledVector(f.ax, sl + 0.0055).addScaledVector(bd, bo + 0.0006);
      const btn = button(bc, bd, 0.0046, 0.0022, 12);
      parts.push({ geo: vcolor(uvFit(skinGeo(btn, w), ...HERO_UV_POPLIN), [0.78, 0.76, 0.70]), mat: mats.body }); }
    if (!f.W.watch) continue;
    // Fix round 4 (critic #7): the watch used to sit ON the cuff — a flat dark disc glued to a white band, read as a
    // sweatband with a button. The bracelet now sits on the bare wrist past the cuff's edge (2 cm, 22 links, rolled
    // edges), and the case, bezel and lugs are the library's steel at metalness 0.9 / roughness 0.2 with the env
    // at 2.5, so the signs land a highlight on the bezel; only the dial stays on the body draw (navy over the atlas's
    // steel square). ?heroWatch=flat keeps the old atlas-square watch.
    const links = 22, bk = 0.905, b0 = sl + 0.0175, b1 = sl + 0.0375;
    const band = (k) => (a) => { const r = k * (1 + 0.012 * Math.cos(a * links)); return [Math.cos(a) * rx * r, Math.sin(a) * ry * r]; };
    const br = loft([at(b0, bk * 0.93, { shape: band(bk * 0.93) }), at(b0 + 0.001, bk, { shape: band(bk) }), at(b1 - 0.001, bk, { shape: band(bk) }),
      at(b1, bk * 0.93, { shape: band(bk * 0.93) })], { segs: Math.max(links * 2, segs) });
    vcolor(br, [0.90, 0.91, 0.94]);
    // the case: on the back of the wrist, which on this fist faces front-and-out (66° from lateral)
    const th = 1.15, sc = sl + 0.0275;
    const dir = f.u.clone().multiplyScalar(Math.cos(th) * rx).addScaledVector(f.v, Math.sin(th) * ry);
    const rOut = dir.length() * bk; dir.normalize();
    const base = f.c.clone().addScaledVector(f.ax, sc).addScaledVector(dir, rOut + 0.0005);
    const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir);
    const caseG = new THREE.CylinderGeometry(0.0158, 0.0164, 0.0072, 28, 1); caseG.translate(0, 0.0036, 0);
    const bezel = new THREE.TorusGeometry(0.0148, 0.0014, 6, 28); bezel.rotateX(HPI); bezel.translate(0, 0.0073, 0);
    const lugs = [];
    for (const sg of [-1, 1]) { const l = new THREE.BoxGeometry(0.009, 0.0035, 0.006); l.translate(0, 0.0024, sg * 0.0175); lugs.push(l); }
    const dial = new THREE.CircleGeometry(0.0136, 28); dial.rotateX(-HPI); dial.translate(0, 0.0068, 0);
    const head = [caseG, bezel, ...lugs];
    head.forEach((x) => vcolor(x, [0.92, 0.93, 0.95]));
    vcolor(dial, [0.035, 0.05, 0.09]);                                                   // navy dial
    const steel = mergeGeometries(head, false);
    head.forEach((x) => x.dispose());
    // the lugs run along the forearm: the case's local Z onto the axis, then the case's +Y out of the wrist
    const qz = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, f.ax.clone().applyQuaternion(q.clone().invert()).setComponent(1, 0).normalize());
    for (const m of [steel, dial]) { m.applyQuaternion(qz); m.applyQuaternion(q); m.translate(base.x, base.y, base.z); skinGeo(m, w); }
    skinGeo(br, w);
    if (WATCH_FLAT) { for (const m of [br, steel, dial]) uvPatch(m, HERO_UV_STEEL, 1); parts.push({ geo: mergeGeometries([br, steel, dial], false), mat: mats.body }); }
    else {
      mats.watch = mats.watch || mat('metal', 0xffffff, { vc: true, metalness: 0.9, roughness: 0.20, env: 2.5, gnd: 0.6, hemi: 0.8 });
      parts.push({ geo: mergeGeometries([br, steel], false), mat: mats.watch });
      parts.push({ geo: uvPatch(dial, HERO_UV_STEEL, 1), mat: mats.body });
    }
    // crystal: the eye's clear additive cap, so it shares that draw call
    if (mats.eye) {
      const gl = new THREE.SphereGeometry(0.026, 24, 6, 0, TAU, 0, 0.55); gl.scale(1, 0.12, 1); gl.translate(0, 0.0061, 0);
      gl.applyQuaternion(q); gl.translate(base.x, base.y, base.z);
      parts.push({ geo: vcolor(skinGeo(gl, w), WHITE3), mat: mats.eye });
    }
  }
}
function buildHeroBody(V, R, detail, stance, part = 'lod0') {
  const segs = Math.max(10, Math.round(22 * detail));
  // Fix round 4 (critic #2): the shoes and soles no longer sample the case-leather square of the scan atlas — a
  // brown that the sodium key and the wet ground's bounce lifted to flesh-tan at every lifted heel and along the toe
  // cap, so a walking hero showed a bare foot in every frame. They wear the library's black calf with its own grain
  // (tinted on the vertex colour exactly like the procedural cast's shoes), the sole a matte near-black version of
  // it that takes almost no ground bounce. Two draws more (hero 2 -> 4; the watch's steel makes 5).
  V.shoes = 0x161311; V.sole = 0x0a0a0a;
  const mats = { body: HERO.mat, trousers: HERO.mat,
    shoes: mat('shoes', 0xffffff, { vc: true, roughness: 0.40, env: 1.5, gnd: 1.6, hemi: 1.2 }),
    sole: mat('shoes', 0xffffff, { vc: true, roughness: 0.94, env: 0.25, gnd: 0.4, hemi: 0.4, nscale: 0.35 }) };
  // Anything else lofted onto the scan's own material gets a vertex-colour multiplier on the patch it wears.
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const heroMul = (hex) => { _c1.set(hex); _c2.set(V.shoes); const k = 0.72 * clamp(lum(_c1) / Math.max(lum(_c2), 1e-4), 0.15, 2.5); return [k, k, k * 1.04]; };
  const K = { V, R, segs, stance, tint: (g, key, hex) => vcolor(g, key === 'shoes' ? tintOf('shoes', hex) : heroMul(hex)), mats,
    handLen: 0.84, handSegs: Math.max(14, segs), wristRings: [[-0.042, 0.0186, 0.0252], [-0.022, 0.0178, 0.0262]] };
  const g0 = heroPart(part);
  if (!HERO.data.finished) mendHeroShards(g0, R);             // baked by finish.mjs
  rigidHead(g0, R, HEAD_CUT.hero);                             // before the corneas copy the face's weights
  if (!g0.attributes.color) vcolor(g0, WHITE3);
  dropHandIslands(g0, R);
  // the hem is measured before the tuck moves anything (and on lod0's section for every rung)
  const hems = HAND_SRC !== 'proc' && !NO_WRIST ? (HERO.hems || (HERO.hems = { Left: sleeveProfile(part === 'lod0' ? g0 : heroPart('lod0'), R, 'Left'), Right: sleeveProfile(part === 'lod0' ? g0 : heroPart('lod0'), R, 'Right') })) : null;
  if (HAND_SRC !== 'proc' && !NO_WRIST) tuckWrists(g0, R);
  const parts = [{ geo: g0, mat: mats.body }];
  buildHeroLegs(K, R, parts, mats);
  if (HAND_SRC === 'proc') {
    mats.skin = acquireSkin(heroFace(V), 11);
    mats.cuff = mat('shirt', V.shirt || 0xcfccc5, { garment: 'poplin' });
    for (const side of SIDES) {
      const ch = chainSegs(R, ['Spine2', side + 'Shoulder', side + 'Arm', side + 'ForeArm', side + 'Hand'], 0.075);
      const n0 = parts.length;
      // in the HAND bone's own frame: the scan's forearm is 20 cm, not the generic rig's 27, so anything placed by
      // metres along the forearm lands past the wrist
      const Hh = ch[4];
      const cuff = [[-0.062, 0.0262], [-0.046, 0.0286], [-0.024, 0.0292], [-0.014, 0.0268], [-0.010, 0.0210]]
        .map(([t, r]) => ring(Hh, t, r, r * 1.22, { shape: (a) => sellipse(a, r, r * 1.22, 2.3) }));
      parts.push({ geo: vcolor(loft(cuff, { segs: Math.max(14, segs), uv: [1, 9] }), WHITE3), mat: mats.cuff });
      buildHand(K, side, ch[4], parts, mats);
      for (let i = n0; i < parts.length; i++) if (!parts[i].geo.attributes.color) vcolor(parts[i].geo, WHITE3);
    }
  }
  // Cornea: a clear cap over each painted iris, with a real cornea's curvature (r 7.8 mm) standing 1.8 mm proud.
  // The old cap was a 12 mm sphere 1 mm proud, so every highlight a key 30° off the lens could make fell on the
  // part of the sphere buried in the head — no catchlight in any frame. The lash-line arcs that sat round it
  // floated a centimetre off the painted lids and are gone: the scan's lids already carry their lashes.
  const eyes = detail >= 0.9 ? heroEyeSpots(parts[0].geo, R) : null;
  if (eyes) {
    mats.eye = corneaMat();
    for (const e of eyes) {
      const g = new THREE.SphereGeometry(0.0078, 16, 12);
      g.rotateX(HPI); g.scale(1.12, 0.86, 1); g.translate(e.p[0], e.p[1], e.p[2]);
      parts.push({ geo: vcolor(skinGeo(g, () => e.w), WHITE3), mat: mats.eye });
    }
  }
  if (HAND_SRC !== 'proc' && !NO_WRIST) buildHeroWrists(R, parts, mats, detail, hems);
  // hair cards (finish.mjs): lod0 only, their own alpha-tested material — one extra draw call. Fix round 4 (critic
  // #8): on by default but only the cards within ~3.5 cm of the hairline (temples, sideburns, nape), so the razor
  // edge of the shell softens without the spiky crown that got them turned off; ?heroHair=all / off.
  if (detail >= 0.9 && part === 'lod0' && HERO.data.parts.hair && HERO_HAIR !== 'off') {
    const hg = heroPart('hair');
    if (hg) rigidHead(hg, R, HEAD_CUT.hero);
    if (hg && HERO_HAIR !== 'all') {
      const p = hg.attributes.position, ix = hg.index.array, keep = [];
      // (優先3: behind the ear line the cards sat over the clipper-short taper, where there is no hair for them to soften,
      // and read as a cluster of black dashes floating on the scalp in every side close-up — only the hairline in front
      // of the ears keeps them; ?heroHair=edgeAll restores the old set)
      const zEar = R.joints.Head[2] + 0.02, all = HERO_HAIR === 'edgeAll';
      for (let f = 0; f < ix.length; f += 3) {
        const y = (p.getY(ix[f]) + p.getY(ix[f + 1]) + p.getY(ix[f + 2])) / 3, z = (p.getZ(ix[f]) + p.getZ(ix[f + 1]) + p.getZ(ix[f + 2])) / 3;
        if (y < HAIR_CARD_Y && (all || z > zEar)) keep.push(ix[f], ix[f + 1], ix[f + 2]);
      }
      hg.setIndex(new THREE.BufferAttribute(new (p.count > 65535 ? Uint32Array : Uint16Array)(keep), 1));
    }
    if (hg && hg.index.count) parts.push({ geo: hg, mat: (mats.hairCards = hairCardMat()) });
  }
  const byMat = new Map();
  for (const p of parts) {
    if (!p.geo.attributes.seamPatch) p.geo.setAttribute('seamPatch', new THREE.BufferAttribute(new Float32Array(p.geo.attributes.position.count), 1));
    if (!byMat.has(p.mat)) byMat.set(p.mat, []); byMat.get(p.mat).push(p.geo);
  }
  const merged = [], matList = [];
  for (const [m, geos] of byMat) {
    const g = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
    if (!g) { console.warn('[humanoid] hero merge failed for', m.name); continue; }
    merged.push(g); matList.push(m);
    if (geos.length > 1) geos.forEach((x) => x.dispose());
  }
  const geo = mergeGeometries(merged, true);
  merged.forEach((x) => x.dispose());
  if (part === 'lod0' && HAND_SRC !== 'proc' && !NO_FIST) heroFistMorph(geo, R);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.8);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-1.3, -0.3, -1.3), new THREE.Vector3(1.3, 2.2, 1.3));
  return { geo, mats: matList, tris: geo.index.count / 3, skin: mats.skin };
}
// The strand sheet the hair cards sample: four 32 px columns (a card picks one), each a clump of 6-8 strands that
// taper to the tip and fade in at the root so the card's base melts into the shell. White: the colour is the card's
// vertex colour, i.e. the shell's own albedo at its root.
// OFF by default (?heroHair=1 to see them): measured against the shell in player_closeup, 780 cards read as dark
// flecks over a slicked pompadour — the shell gets its value from the scan's normal-mapped highlights, which a
// flat card cannot reproduce — and the Kajiya-Kay lobes on the shell already give the comb its strand highlight.
const HERO_HAIR = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('heroHair') || 'edge') : 'edge';
const HAIR_CARD_Y = 1.745;                          // the cards start at 1.708 (the temple hairline); the crown is 1.83
let _hairCardMat = null;
function hairCardMat() {
  if (_hairCardMat) return _hairCardMat;
  const W = 128, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data, rng = mulberry(0x4a17);
  const a = new Float32Array(W * H), v = new Float32Array(W * H).fill(1);
  for (let col = 0; col < 4; col++) {
    const n = 6 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const x0 = col * 32 + 5 + rng() * 22, wv = (rng() - 0.5) * 2.0, len = 0.70 + rng() * 0.30, wd = 1.8 + rng() * 1.6, br = 0.82 + rng() * 0.28;
      for (let y = 0; y < H; y++) {
        const t = y / H; if (t > len) break;
        const xc = x0 + wv * Math.sin(t * 3.1 + k) + (rng() - 0.5) * 0.3;
        const taper = wd * (1 - 0.6 * (t / len)), fade = Math.min(1, t / 0.10) * (1 - Math.pow(t / len, 2));
        for (let x = Math.floor(xc - 3); x <= Math.ceil(xc + 3); x++) {
          if (x < col * 32 || x >= col * 32 + 32) continue;
          const cov = Math.max(0, 1 - Math.abs(x - xc) / Math.max(taper, 0.35)) * fade;
          const i = y * W + x; if (cov > a[i]) { a[i] = cov; v[i] = br; }
        }
      }
    }
  }
  for (let i = 0; i < W * H; i++) { const k = i * 4, b = Math.min(255, 255 * v[i]); d[k] = b; d[k + 1] = b; d[k + 2] = b; d[k + 3] = Math.min(255, a[i] * 300); }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  _hairCardMat = new THREE.MeshPhysicalMaterial({ name: 'heroHairCards', map: tex, vertexColors: true, alphaTest: 0.42, side: THREE.DoubleSide,
    roughness: 0.52, metalness: 0 });
  // lit exactly like the shell it sits on (the hero material's own numbers), or every card reads as a dark fleck
  envTrack(_hairCardMat, 1.9);
  charShader(_hairCardMat, { gamut: HERO_GAMUT, hemi: 4.4, hemiN: 5.2, dark: 1, lift: 1, gnd: 6.6, gndN: 2.4, gndFloor: 0.10, aa: [0.085, 0.20], hair: 1, face: 1 });
  return _hairCardMat;
}
// The scan's own attaché (parts case0/case1) is kept in hero.bin but no longer carried. It was welded into his
// fist and the flood fill that lifted it out took the strap with it, so its centroid sits 74 cm off the wrist —
// hung from the hand bone it dangles at knee height, and every texel of it maps to HERO_UV_LEATHER, a 12.0 ± 2.6
// dead square of the scan atlas: a black paper cutout with no grain, no stitching, no clasp. The modelled attaché
// below is the right size (0.42 x 0.30 x 0.09), has a real handle arc, welt and latches, wears the library's
// leather with its own normal, and hangs plumb from the grip.

// seeded per-character morphs (every non-hero variant): face, skin tone, build, height, hair
function seededMorph(V, rng, variant) {
  V.skin = V.skin.map((x) => clamp(x + (rng() - 0.5) * 44, 60, 250) | 0);
  V.jaw *= 0.95 + rng() * 0.2; V.nose *= 0.9 + rng() * 0.3; V.chin *= 0.9 + rng() * 0.3; V.brow *= 0.8 + rng() * 0.4; V.cheek *= 0.85 + rng() * 0.3;
  V.age = rng() * 0.6; V.stubble = rng() < 0.45 ? 0.4 : 0; V.faceSeed = Math.floor(rng() * 4);
  V.build *= 0.92 + rng() * 0.22; V.scale *= 0.955 + rng() * 0.09;
  V.garment = ['worsted', 'pinstripe', 'birdseye', 'worsted'][Math.floor(rng() * 4)];
  V.shoulderW *= 0.90 + rng() * 0.20; V.legLen = (V.legLen || 1) * (0.94 + rng() * 0.12); V.torsoLen = (V.torsoLen || 1) * (0.95 + rng() * 0.10);
  if (rng() < 0.3) V.belly = (V.belly || 0) + 0.02 + rng() * 0.035;
  if (variant === 'yakuza') { V.hair = rng() < 0.5 ? 'slick' : 'short'; V.hairColor = [0x141010, 0x1a1410, 0x2a2018][Math.floor(rng() * 3)]; V.gut = rng() < 0.3 ? 0.02 : 0; V.sunglasses = rng() < 0.7; }
  else if (variant === 'boss') { V.hair = rng() < 0.6 ? 'longslick' : 'slick'; V.hairColor = [0x3a3430, 0x1a1410, 0x555050][Math.floor(rng() * 3)]; V.age = 0.5 + rng() * 0.4; V.stubble = 0.4; }
  else if (variant === 'chinpira') {
    V.suit = CHINPIRA_JACKETS[Math.floor(rng() * CHINPIRA_JACKETS.length)];
    if (rng() < 0.4) { V.hairColor = [0x1a1410, 0x2a1e14][Math.floor(rng() * 2)]; V.hair = 'short'; } else V.hairColor = [0xd9bc6a, 0xc8a050, 0xe0d0a0][Math.floor(rng() * 3)];
    V.stubble = rng() < 0.25 ? 0.4 : 0; V.age = rng() * 0.25;
  }
}

// ---------------------------------------------------------------- grounding + self-collision (per frame)
let _contactMat = null;
// THE FALLOFF IS IN THE GEOMETRY, NOT IN A TEXTURE. Round 5 shipped it as a 128² canvas whose alpha channel fed
// `map`/`alphaMap`, and that texture's alpha never reached the frame: with the identical material and blend, a
// flat `opacity: 0.5` darkened the plaza to 0.32x, the same material with the ramp in `map` measured 0.86x and
// with the ramp in vertex alpha 0.67x — and uv, the colour attribute's itemSize and the canvas's own alpha
// bytes were each read back and verified correct along the way. So every contact decal in this game has been
// invisible since it was written, while the self-test cheerfully reported an authored opacity of 0.19.
// A 9x9 vertex grid carries the same radial ramp for 128 triangles a decal, needs no texture fetch and no uv,
// and cannot be defeated by a texture path. Two lobes: a nearly opaque core the width of the shoe out to
// r 0.34, then a long weak skirt for the ambient occlusion — one smooth bell washes a whole crosswalk stripe
// flat at any alpha that also darkens the ground the shoe is standing on.
const CONTACT_G = 9;
const CONTACT_STOPS = [[0, 1], [0.20, 0.98], [0.34, 0.86], [0.46, 0.58], [0.60, 0.36], [0.76, 0.18], [0.90, 0.055], [1, 0]];
function contactFall(r) {
  if (r >= 1) return 0;
  for (let i = 1; i < CONTACT_STOPS.length; i++) {
    const [r1, a1] = CONTACT_STOPS[i];
    if (r <= r1) { const [r0, a0] = CONTACT_STOPS[i - 1]; return lerp(a0, a1, (r - r0) / Math.max(r1 - r0, 1e-6)); }
  }
  return 0;
}
// the grid's own [-1..1] node coordinates and their falloff, built once
const CONTACT_NODE = (() => {
  const G = CONTACT_G, p = new Float32Array(G * G * 2), f = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const u = (i / (G - 1)) * 2 - 1, v = (j / (G - 1)) * 2 - 1, k = j * G + i;
    p[k * 2] = u; p[k * 2 + 1] = v; f[k] = contactFall(Math.hypot(u, v));
  }
  return { p, f };
})();
function contactMat() {
  // Multiplicative, not "black over": on the wet crossing the road under a character is a mirror full of neon, and
  // an alpha-blended black quad at 0.9 still leaves a bright reflection showing through. dst *= (1 - a) scales
  // whatever is already there, so the reflection darkens with the pavement and the decal can never brighten.
  // ?contactDbg=1 draws the decals opaque red — the only way to see where they land on a painted road.
  const dbg = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('contactDbg') : null;
  if (dbg === '1') return _contactMat = _contactMat || new THREE.MeshBasicMaterial({ name: 'contactDbg', color: 0xff0020, opacity: 0.85,
    transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
  if (!_contactMat) _contactMat = new THREE.MeshBasicMaterial({ name: 'contact', color: 0x000000, transparent: true,
    opacity: 1, vertexColors: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -14, polygonOffsetUnits: -28,
    blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation });
  return _contactMat;
}
// THREE decals: one per foot and a long one under the hips, so the BODY darkens the ground and not just the shoes.
const CONTACT_QUADS = 3;
// Peak alpha at the core of one decal. The three overlap and the blend is multiplicative, so the authored
// number is not what reaches the frame: measured on `character_feet`, the plaza 20 cm from a planted sole comes
// out at 0.63x the same tile in the open (it was 0.92x — i.e. nothing) and the core under the sole at 0.81x.
// ?contactA / ?contactW / ?contactY sweep the peak alpha, the foot decal's half width and its height above the
// ground; ?contactForce skips the frustum cull and ?contactDbg=1 draws the decals opaque red.
const CQ = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new Map();
const CONTACT_A = +CQ.get('contactA') || 0.97;
// 0.44 -> 0.32 (fix round 4): a foot's occlusion is gone by 20 cm; the wider pool merged four men's feet into one
// dark carpet once the decals started reaching the frame
const CONTACT_W = +CQ.get('contactW') || 0.32;
const CONTACT_Y = +CQ.get('contactY') || 0.030;
const CONTACT_FORCE = !!CQ.get('contactForce');
function contactMesh() {
  const n = CONTACT_QUADS, G = CONTACT_G, V = G * G;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * V * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * V * 4), 4));
  const idx = [];
  for (let q = 0; q < n; q++) {
    const b = q * V;
    for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) {
      const k = b + j * G + i;
      // wound so the grid faces +Y like the four-corner quad it replaces: +u then +v is the BACK face here, and
      // FrontSide culling made the whole decal invisible again the first time round
      idx.push(k, k + G + 1, k + 1, k, k + G, k + G + 1);
    }
  }
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2);
  const m = new THREE.Mesh(g, contactMat());
  // Fix round 4 (critic #10): renderOrder 2.5, AFTER weather.js's puddle mirrors (renderOrder 1, depthWrite off) and
  // lighting's fixture pools (2). The decal writes no depth, so anything transparent drawn after it at ground level
  // simply painted over it: on the crossing the lead stood on a puddle and his contact shadow was gone, while the
  // three mobs on plain asphalt beside him kept theirs (?contactDbg=1 showed it: red on his shoes, none on the road).
  m.name = 'contactShadow'; m.renderOrder = 2.5; m.frustumCulled = false; m.matrixAutoUpdate = false;
  return m;
}
const _u1 = new THREE.Vector3(), _u2 = new THREE.Vector3(), _u3 = new THREE.Vector3(), _u4 = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
// Keep a fist out of its owner's own face and torso. `animations.js` writes one set of hand targets for every
// build; on the hero (fist 0.25, jaw 1.13) they clear, on the boss (fist 0.8, jaw 1.15) the guard pose drives his
// knuckles through his own cheek — and guard is the pose the cast shot is built around. Measured after the mixer
// has written the clip and corrected on the upper arm, so nothing about the clips has to change.
// An attack is allowed to pass the fist close to the face — a hook comes over the guard by design, and correcting
// it there only fights the clip (and costs 4 cm of shoulder stretch under hook@0.75).
const NO_CLEAR = new Set(['jab', 'straight', 'hook', 'uppercut', 'kick', 'roundhouse', 'heat_finisher', 'throw', 'grab',
  'knockdown', 'getup', 'dead', 'stumble', 'dodge', 'hit_light', 'hit_heavy', 'guard_hit']);
// A fist's own radius: what has to clear the head, not just the wrist joint.
const fistRadius = (V) => (0.042 + 0.024 * (V.fist ?? 0.3)) * (V.build || 1);
// radius of the clearance ellipsoid along a unit direction
function ellipR(R, dx, dy, dz) {
  const a = dx / R[0], b = dy / R[1], c = dz / R[2];
  const q = Math.sqrt(a * a + b * b + c * c);
  return q > 1e-9 ? 1 / q : R[0];
}
// ?charDbg=noclear|nobreak|nofeet|none turns the per-frame rig overlays off one at a time
const CHAR_DBG = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('charDbg') || '') : '';
// The probe set is MEASURED off the hand's own vertices (see handProbes): the fist centre plus the four points
// that actually stick out — fingertip, thumb, back of the hand, forward knuckle. Round 4 probed one point
// 6 cm down the bone, so the thumb tip went straight through the jacket skirt (the two detached orange wedges
// beside the left hand in the night close-up) and a folded hand buried itself in its owner's jaw.
// (module scope: these were three closures rebuilt per humanoid per frame)
const FIST = [0, 0.06, 0], FIST1 = [FIST];
function clipProbe(h, s, side, p) {
  const hand = h.bones[side + 'Hand'];
  hand.getWorldPosition(_u2);
  hand.getWorldQuaternion(_qa);
  return _u2.addScaledVector(_u3.set(p[0], p[1], p[2]).applyQuaternion(_qa), s);
}
function clipSwing(h, bone, dir, gap) {               // rotate `bone` so the probe (_u2) travels `gap` along `dir`
  bone.getWorldPosition(_u4);
  const u = _u1.copy(_u2).sub(_u4), r = u.length();
  if (r < 0.06) return false;
  u.divideScalar(r);
  const perp = 1 - Math.abs(u.dot(dir));
  if (perp < 0.08) return false;
  let th = gap / (r * perp);
  if (th > 0.6) th = 0.6;                        // 0.3 rad could not clear a 0.8 fist off a 1.15 jaw in one pass
  if (CHAR_DBG === 'log' && (humanoid.__logN = (humanoid.__logN || 0) + 1) < 24) console.info('[humanoid] swing', h.variant, h.currentName, 'th', th.toFixed(3), 'gap', gap.toFixed(3), 'r', r.toFixed(3));
  _qb.setFromAxisAngle(_u1.crossVectors(u, dir).normalize(), th);
  bone.parent.getWorldQuaternion(_qc);
  bone.quaternion.premultiply(_qa.copy(_qc).invert().multiply(_qb).multiply(_qc));
  bone.updateMatrixWorld(true);
  return true;
}
function resolveSelfClip(h) {
  const C = h.clearance; if (!C || NO_CLEAR.has(h.currentName) || CHAR_DBG === 'none') return;
  const s = C.scale;
  ovBegin(h);
  if (h.stagger) stagger(h);                       // break the mirror first, then clear what it put in the way
  if (h.idleBreak && CHAR_DBG !== 'nobreak') idleBreak(h);
  if (h.footPitch0 && CHAR_DBG !== 'nofeet') levelFeet(h);
  if (h.neckHeadBind) clampHead(h);
  if (CHAR_DBG !== 'nohands') clampHands(h);
  if (CHAR_DBG === 'noclear') { ovEnd(h); return; }
  h.bones.Head.getWorldPosition(_u1); _u1.y += C.headUp * s;
  const hx = _u1.x, hy = _u1.y, hz = _u1.z;
  h.bones.Hips.getWorldPosition(_u1);
  const bx = _u1.x, bz = _u1.z, by = _u1.y;         // the body axis is vertical through the hips
  for (const side of SIDES) {
    const arm = h.bones[side + 'Arm'], fore = h.bones[side + 'ForeArm'], P = (C.handPts && C.handPts[side]) || FIST1;
    // 1. out of his own skull (ellipsoid, iterated). The upper arm first; if the gap direction runs along the
    // arm it cannot help, and the forearm — which is what a phone/smoke clip folds up against the face — can.
    // Round 4 only ever tried the upper arm, so the cast shot shipped a hand inside a jaw.
    // the forearm itself too, not only the hand: a phone at the ear folded the forearm straight through the
    // side of the head while every hand probe sat clear of it
    for (const bone of [arm, fore]) for (let pass = 0; pass < 3; pass++) {
      let worst = 0, wp = null;
      for (let pi = 0, pn = P.length + FORE_PTS.length; pi < pn; pi++) {
        const p = pi < P.length ? P[pi] : FORE_PTS[pi - P.length];
        clipProbe(h, s, side, p);
        _u3.set(_u2.x - hx, _u2.y - hy, _u2.z - hz);
        const d = _u3.length(); if (d <= 1e-4) continue;
        const pen = ellipR(C.headR, _u3.x / d, _u3.y / d, _u3.z / d) - d;
        if (pen > worst) { worst = pen; wp = p; }
      }
      if (!wp) break;
      clipProbe(h, s, side, wp);
      _u3.set(_u2.x - hx, _u2.y - hy, _u2.z - hz).normalize();
      if (!clipSwing(h, bone, _u3, worst * 1.05)) break;
    }
    // 2. out of the jacket (a vertical body cylinder), at every probe point
    let worst = 0, wp = null, wdy = 0;
    for (const p of P) {
      clipProbe(h, s, side, p);
      const dy = (_u2.y - by) / s;
      if (dy <= -0.34 || dy >= 0.42) continue;
      // below the waist the skirt of a jacket stands 3-4 cm proud of the ribs the table was measured on
      const need = C.body(dy) + (dy < -0.02 ? 0.032 : 0.008);
      _u3.set(_u2.x - bx, 0, _u2.z - bz);
      const r2 = _u3.length();
      if (need - r2 > worst && r2 > 1e-4) { worst = need - r2; wp = p; wdy = dy; }
    }
    // upper arm first; if the push direction runs along it the forearm is the joint that can do the work
    if (wp) { clipProbe(h, s, side, wp); _u3.set(_u2.x - bx, 0, _u2.z - bz).normalize();
      if (!clipSwing(h, arm, _u3, worst * 0.85)) { clipProbe(h, s, side, wp); _u3.set(_u2.x - bx, 0, _u2.z - bz).normalize(); clipSwing(h, fore, _u3, worst * 0.9); } }
    // …and 3. NOT held out from it. The clips are authored against the generic A-pose bind, so a standing
    // pedestrian holds both arms 12° off his ribs with the palms forward — the shop-window-mannequin read that
    // makes a cast shot look like one model recoloured. A relaxed arm hangs ~4 cm off the jacket.
    else if (IDLE_TUCK.has(h.currentName)) {
      clipProbe(h, s, side, FIST);
      const dy = (_u2.y - by) / s;
      if (dy > -0.30 && dy < 0.12) {
        _u3.set(_u2.x - bx, 0, _u2.z - bz);
        const r2 = _u3.length(), slack = r2 - (C.body(dy) + 0.075);
        if (slack > 0 && r2 > 1e-4) { _u3.divideScalar(-r2); clipSwing(h, arm, _u3, Math.min(slack, 0.07) * 0.8); }
      }
    }
    void wdy;
  }
  ovEnd(h);
}
// A standing pose never carries the head more than 20° off the chest. taunt@0.45 threw the chinpira's head back
// ~35° on a long bare neck, which read as a head detached from its collar. Neck and Head together, measured
// against their bind relation; only the excess is taken out, on the Head (the overlay chain restores it per frame).
// Fix round 2: a wrist bent back ~60° with the fingers splayed (a crowd pool body's gesture, posed bone by bone by
// crowd.js) read as a broken hand two metres behind the lead. The hand's SWING off its bind relation to the forearm
// is held within 35°; its twist (pronation) is left alone. Idempotent, so it can run after whoever posed the bone.
// Fix round 4 (critic #11): the hook's arc carries the fist over the crown, and the auto-skinned shoulder tears
// there (selfTest stretch 0.10 m at hook@0.75). Until animations.js re-times the arc, the upper arm is brought down
// so the fist stays below the crown — measured after the mixer, on the clip's own pose, so nothing integrates.
const FIST_LIFT_CLIPS = new Set(['hook', 'uppercut', 'straight', 'jab', 'roundhouse']);
function clampFistLift(h) {
  if (!FIST_LIFT_CLIPS.has(h.currentName) || CHAR_DBG === 'none' || CHAR_DBG === 'nolift') return;
  const s = h.clearance ? h.clearance.scale : 1;
  h.bones.Head.getWorldPosition(_u1);
  const crown = _u1.y + 0.11 * s;
  for (const side of SIDES) {
    clipProbe(h, s, side, FIST);
    const over = _u2.y - crown;
    if (over <= 0.005) continue;
    _u3.set(0, -1, 0);
    clipSwing(h, h.bones[side + 'Arm'], _u3, Math.min(over, 0.25));
  }
}
const HAND_MAX = 0.61;
const _hsR = new THREE.Quaternion(), _hsT = new THREE.Quaternion(), _hsI = new THREE.Quaternion();
function clampHands(h) {
  const B = h.handBind; if (!B) return;
  for (const side of SIDES) {
    const b = h.bones[side + 'Hand']; if (!b) continue;
    _hsR.copy(B[side]).invert().multiply(b.quaternion);                    // relative to the bind
    _hsT.set(0, _hsR.y, 0, _hsR.w); const tl = Math.hypot(_hsT.y, _hsT.w);
    if (tl < 1e-6) continue;
    _hsT.y /= tl; _hsT.w /= tl;                                             // twist about the bone's own axis
    _hsR.multiply(_hsI.copy(_hsT).invert());                               // swing
    const ang = 2 * Math.acos(Math.min(1, Math.abs(_hsR.w)));
    if (ang <= HAND_MAX) continue;
    _hsR.slerp(_hsI.identity(), 1 - HAND_MAX / ang);
    b.quaternion.copy(B[side]).multiply(_hsR).multiply(_hsT);
    b.updateMatrixWorld(true);
  }
}
const HEAD_CLAMP = new Set(['idle', 'idle_combat', 'guard', 'taunt']), HEAD_MAX = 0.35;
const _hcA = new THREE.Quaternion(), _hcB = new THREE.Quaternion(), _hcI = new THREE.Quaternion();
function clampHead(h) {
  if (!HEAD_CLAMP.has(h.currentName)) return;
  const neck = h.bones.Neck, head = h.bones.Head; if (!neck || !head) return;
  _hcA.copy(neck.quaternion).multiply(head.quaternion);                  // current Neck*Head
  _hcB.copy(h.neckHeadBind).invert().multiply(_hcA);                      // deviation from bind
  const ang = 2 * Math.acos(Math.min(1, Math.abs(_hcB.w)));
  if (ang <= HEAD_MAX) return;
  _hcB.slerp(_hcI.identity(), 1 - HEAD_MAX / ang);
  _hcA.copy(h.neckHeadBind).multiply(_hcB);                               // clamped Neck*Head
  head.quaternion.copy(neck.quaternion).invert().multiply(_hcA);
  head.updateMatrixWorld(true);
}
const IDLE_TUCK = new Set(['idle', 'phone', 'smoke', 'sit', 'walk']);
const FORE_PTS = [[0, -0.07, 0], [0, -0.14, 0]];             // up the forearm, in the hand bone's frame
// Contrapposto, at the rig level. `animations.js` writes ONE symmetric idle for every character: arms dead
// straight, elbows locked, palms flat to camera, shoulder line level. Six of those in a row is a shop window.
// The pelvis drop already survives a clip (it lives in the UpLeg joint POSITIONS, see stanceFor), so what is
// missing above it is the counter-rotation of the shoulder line and a break in both elbows. Rotating the Hips
// would tilt the feet off the ground, so nothing below the pelvis is touched.
const BREAK_CLIPS = new Set(['idle', 'phone', 'smoke', 'sit']);
// ?idleK=adduct,knee sweeps the hero's free-arm adduction and free-knee flex (radians)
const KQA = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('idleK') || '').split(',').map(Number) : [];
// hip socket to sole: how far a lateral pelvis shift has to be absorbed by the leg so the foot stays planted
const LEG_REACH = 0.87;
// A scan's bind pose is its capture pose (the king's hand in his hair, the cap man's arm out with the crowbar), and
// `idle` writes no track for the upper arms, so in the cast shot they stood in those poses. For a scan in idle the
// arms are swung to hang: upper arm ~8° off the side and a touch forward, forearm 14° further forward.
const _ha = new THREE.Vector3(), _hb = new THREE.Vector3(), _hq = new THREE.Quaternion();
function swingTo(bone, child, target) {
  bone.getWorldPosition(_ha); child.getWorldPosition(_hb);
  _hb.sub(_ha); if (_hb.lengthSq() < 1e-8) return;
  _qb.setFromUnitVectors(_hb.normalize(), target);
  bone.parent.getWorldQuaternion(_qc);
  bone.quaternion.premultiply(_qa.copy(_qc).invert().multiply(_qb).multiply(_qc));
  bone.updateMatrixWorld(true);
}
function hangArms(h) {
  h.group.getWorldQuaternion(_hq);
  for (const side of SIDES) {
    const sg = side === 'Left' ? 1 : -1, B = h.bones;
    _u3.set(sg * 0.14, -0.985, 0.07).applyQuaternion(_hq).normalize();
    swingTo(B[side + 'Arm'], B[side + 'ForeArm'], _u3);
    _u4.set(sg * 0.10, -0.94, 0.32).applyQuaternion(_hq).normalize();
    swingTo(B[side + 'ForeArm'], B[side + 'Hand'], _u4);
  }
}
// Fix round 3 (critic #6): four shop-window mannequins in a row — one rig recoloured four times. A per-scan stance
// over `idle`, applied after hangArms: the brute squares up (weight right, chin down, shoulders rolled, fists rolled
// in and forward), the salaryman rests his left hand at his back pocket and looks 12° toward the lead, the wanderer
// slouches with his shoulders forward and his right hand hooked up at the vest. Angles verified against the bone
// frames: ForeArm +X = elbow flex forward, Arm +Z = swing toward +x, Head/Neck +X = chin down, Neck +Y = yaw toward
// the character's own left, Shoulder +X = rolled forward, Shoulder +Z = shrug.
const MOB_STANCE = {
  enforcer_a: { sup: -1, roll: 0.14, shift: 0.035, drop: 0.06, dropSide: 'Right', head: 0.02, twist: 0.09,
    ov: [['Head', 1, 0, 0, 0.16], ['LeftShoulder', 1, 0, 0, 0.10], ['RightShoulder', 1, 0, 0, 0.10],
      ['LeftArm', 0, 0, 1, 0.09], ['RightArm', 0, 0, 1, -0.09], ['LeftForeArm', 1, 0, 0, 0.30], ['RightForeArm', 1, 0, 0, 0.30],
      ['LeftForeArm', 0, 1, 0, 0.45], ['RightForeArm', 0, 1, 0, -0.45]] },
  enforcer_b: { sup: 1, roll: 0.09, shift: 0.025, drop: 0.04, dropSide: 'Left', head: -0.03, twist: -0.06,
    ov: [['Neck', 0, 1, 0, -0.21], ['Head', 1, 0, 0, 0.04], ['LeftArm', 1, 0, 0, -0.38], ['LeftArm', 0, 0, 1, 0.06], ['LeftForeArm', 1, 0, 0, 0.95],
      ['LeftForeArm', 0, 1, 0, 0.5], ['RightForeArm', 1, 0, 0, 0.14], ['RightArm', 0, 0, 1, 0.05]] },
  wanderer: { sup: -1, roll: 0.10, shift: 0.03, drop: 0.05, dropSide: 'Right', head: 0.05, twist: 0.04,
    ov: [['Spine', 1, 0, 0, 0.11], ['Spine1', 1, 0, 0, 0.06], ['Neck', 1, 0, 0, -0.14], ['Head', 1, 0, 0, -0.04], ['Neck', 0, 1, 0, 0.12],
      ['LeftShoulder', 1, 0, 0, 0.17], ['RightShoulder', 1, 0, 0, 0.17], ['RightArm', 1, 0, 0, 0.12], ['RightArm', 0, 0, 1, 0.14], ['RightForeArm', 1, 0, 0, 1.30],
      ['RightForeArm', 0, 1, 0, -0.35], ['LeftForeArm', 1, 0, 0, 0.10]] },
};
function idleBreak(h) {
  if (!BREAK_CLIPS.has(h.currentName) && !(h.idleBreak.more && h.idleBreak.more.has(h.currentName))) return;
  if (h.scan && h.currentName === 'idle') hangArms(h);
  const S = h.idleBreak, sup = S.sup;
  if (S.ov && h.scan && h.currentName === 'idle') for (const o of S.ov) overlay(h, h.bones[o[0]], o[0], o[1], o[2], o[3], o[4]);
  // WEIGHT SHIFT. Round 4 left everything below the pelvis alone on the grounds that rolling the Hips lifts a
  // foot — true, but it is also the difference between a lead and a mannequin: level hips, a vertical spine and
  // two arms hanging the same length is a shop window. Roll the pelvis AND counter-rotate both femurs in the
  // same axis, so the pelvis tilts while the legs stay where they were; the 2 cm lateral shift onto the support
  // leg is likewise absorbed by a -shift/reach swing of both femurs, and the feet do not move.
  const r = S.roll * 0.55 * sup, dx = (S.shift || 0) * sup;
  overlay(h, h.bones.Hips, 'ibHip', 0, 0, 1, r);
  h.bones.Hips.position.x += dx;
  for (const side of SIDES) overlay(h, h.bones[side + 'UpLeg'], 'ibU' + side, 0, 0, 1, -r - dx / LEG_REACH);
  overlay(h, h.bones.Spine, 'ibSp', 0, 0, 1, -r * 0.6);
  overlay(h, h.bones.Spine2, 'ibSp2', 0, 0, 1, -S.roll * sup);
  overlay(h, h.bones.Spine1, 'ibSp1', 0, 1, 0, S.twist * sup);
  // …and the shoulder line is not level either: the side carrying 3 kg of attaché sits ~2 cm lower.
  if (S.drop) for (const side of SIDES) {
    const s2 = side === 'Left' ? -1 : 1, k = side === S.dropSide ? S.drop : -S.drop * 0.35;
    overlay(h, h.bones[side + 'Shoulder'], 'ibS' + side, 0, 0, 1, s2 * k);
  }
  if (!h.scan) for (const side of SIDES) {
    const k = side === 'Left' ? S.elbowL : S.elbowR;
    // (the hero flexes forward — a real elbow; the procedural break keeps its sign, those bodies are demoted)
    overlay(h, h.bones[side + 'ForeArm'], 'ibF' + side, 1, 0, 0, S.flexFwd && side === S.freeArm ? k : -k);
    overlay(h, h.bones[side + 'Arm'], 'ibA' + side, 1, 0, 0, k * 0.22);
  }
  if (S.foreTwist && S.freeArm) overlay(h, h.bones[S.freeArm + 'ForeArm'], 'ibTw', 0, 1, 0, S.foreTwist);
  overlay(h, h.bones.Head, 'ibHead', 0, 0, 1, S.head * sup);
  if (S.headYaw) overlay(h, h.bones.Head, 'ibHy', 0, 1, 0, S.headYaw);
  // the free arm hangs IN, not out: the generic idle holds it ~15° off the jacket (fix round 2: ~8°)
  if (S.adduct) overlay(h, h.bones[S.freeArm + 'Arm'], 'ibAd', 0, 0, 1, S.adduct * (S.freeArm === 'Left' ? -1 : 1));
  // and the unweighted leg is not a second pillar: its knee gives a few degrees (thigh forward, shin back)
  if (S.knee) {
    const fl = sup > 0 ? 'Right' : 'Left';
    overlay(h, h.bones[fl + 'UpLeg'], 'ibKu', 1, 0, 0, S.knee * 0.55);
    overlay(h, h.bones[fl + 'Leg'], 'ibKl', 1, 0, 0, -S.knee);
  }
  h.bones.Hips.updateMatrixWorld(true);
}
// Nobody guards square. `animations.js` writes one mirrored COMBAT pose for every character, so six people in the cast
// shot hold identical fists at identical heights. This is a rig-level overlay on top of whatever the clip wrote: the
// rear hand comes back and up, the spine turns toward the lead shoulder and the chin drops. Lead side is per-character.
const STAGGER_CLIPS = new Set(['guard', 'idle_combat', 'taunt']);
// A rig overlay multiplies the local quaternion the mixer just wrote. That is only safe for bones the clip has a
// track for: where it has none, the bone keeps last frame's value and the overlay integrates every frame — over
// 200 frames of a shot preset it wound the hero's case arm up over his shoulder. Remember what we left the bone
// at; if it is still exactly that, the mixer did not touch it, so undo before re-applying.
const _ovq = new THREE.Quaternion();
const OV_BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm',
  'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'];
// One restore point for the WHOLE overlay chain, taken before the first of them runs. Per-overlay memories fight
// each other: the stance overlay writes the upper arm, the clearance pass writes it again afterwards, so next
// frame the stance overlay no longer recognises its own output, skips the undo and integrates on top.
function ovBegin(h) {
  for (const n of OV_BONES) {
    const b = h.bones[n]; if (!b) continue;
    const e = h._ov.get(n);
    if (!e) { h._ov.set(n, { before: b.quaternion.clone(), after: new THREE.Quaternion(0, 0, 0, -2) }); continue; }
    if (b.quaternion.equals(e.after)) b.quaternion.copy(e.before);   // the clip has no track for this bone
    e.before.copy(b.quaternion);
  }
  // the pelvis shift is a TRANSLATION, so it needs the same memory or it integrates into a side-step
  const p = h._ov.get('#hipX'), x = h.bones.Hips.position.x;
  if (!p) h._ov.set('#hipX', { before: x, after: NaN });
  else { h.bones.Hips.position.x = (x === p.after ? p.before : x); p.before = h.bones.Hips.position.x; }
  h.bones.Hips.updateMatrixWorld(true);
}
function ovEnd(h) {
  for (const n of OV_BONES) {
    const b = h.bones[n]; if (!b) continue;
    const e = h._ov.get(n); if (e) e.after.copy(b.quaternion);
  }
  const p = h._ov.get('#hipX'); if (p) p.after = h.bones.Hips.position.x;
}
function overlay(h, bone, key, ax, ay, az, angle) {
  if (!bone) return;
  bone.quaternion.multiply(_ovq.setFromAxisAngle(_u1.set(ax, ay, az), angle));
}
function stagger(h) {
  if (!STAGGER_CLIPS.has(h.currentName)) return;
  const S = h.stagger, lead = S.lead;                               // +1 = left foot/hand forward
  const rear = lead > 0 ? 'Right' : 'Left';
  const arm = h.bones[rear + 'Arm'], fore = h.bones[rear + 'ForeArm'];
  if (!arm) return;
  overlay(h, arm, 'sgArm', 1, 0, 0, -S.pull);                       // rear elbow back
  overlay(h, fore, 'sgFore', 1, 0, 0, S.pull * 0.8);                // elbow closes: the rear hand comes back AND up
  overlay(h, h.bones.Spine1, 'sgSp1', 0, 1, 0, S.twist * lead);
  overlay(h, h.bones.Spine2, 'sgSp2', 0, 0, 1, S.tilt * lead);
  overlay(h, h.bones.Head, 'sgHead', 1, 0, 0, S.chin);
  h.bones.Hips.updateMatrixWorld(true);
}
// A shoe has TWO ground contacts, the heel and the ball, and in a standing clip both of them are on the floor.
// The clips are authored against the generic rig, so on a short-shinned or long-footed build the ankle pitch comes
// out wrong and plant() then drops the group until the LOWEST point touches — which on the boss's right foot was
// the toe alone, a ballerina plant in a standing pose. Level the foot back to its own bind pitch first.
const STAND_CLIPS = new Set(['idle', 'idle_combat', 'guard', 'taunt', 'phone', 'smoke']);
const _lf1 = new THREE.Vector3(), _lf2 = new THREE.Vector3();
function footPitch(h, side) {
  const f = h.bones[side + 'Foot'], t = h.bones[side + 'ToeBase'];
  f.getWorldPosition(_lf1); t.getWorldPosition(_lf2);
  return Math.atan2(_lf1.y - _lf2.y, Math.hypot(_lf2.x - _lf1.x, _lf2.z - _lf1.z) || 1e-4);
}
function levelFeet(h) {
  if (!STAND_CLIPS.has(h.currentName)) return;
  for (const side of SIDES) {
    const f = h.bones[side + 'Foot'], t = h.bones[side + 'ToeBase'];
    if (!f || !t) continue;
    const want = h.footPitch0[side];
    let err = footPitch(h, side) - want;
    if (Math.abs(err) < 0.03) continue;
    err = clamp(err, -0.5, 0.5);
    const turn = (th) => { _qb.setFromAxisAngle(_u1.set(1, 0, 0), th); f.quaternion.multiply(_qb); f.updateMatrixWorld(true); };
    turn(-err);
    // the sign of local X against the foot's own frame depends on the build, so check and go the other way if
    // the first try made it worse rather than guessing
    if (Math.abs(footPitch(h, side) - want) > Math.abs(err)) turn(err * 2);
  }
}
// A carried case hangs plumb. The scanned attaché sits in the hand bone's bind frame, so it follows the wrist
// exactly — and in any pose but the scan's own it swung out along his forearm at 40° like a dropped prop. Keep the
// grip, take the hang from gravity.
// Built from the prop's AUTHORED local quaternion, never from its own previous value: reading back what it wrote last
// frame is a feedback loop with no reference, and the yaw about the hang axis drifted over a long animation. And the
// hang axis is not snapped to world down — it is chased by a critically damped spring, so the case lags the arm a
// couple of degrees on the backswing and settles when he stops.
const _hangUp = new THREE.Vector3(0, -1, 0);
function plumbProp(mesh, dt = 0.016) {
  const hang = mesh.userData.hang, p = mesh.parent;
  if (!hang || !p) return;
  const U = mesh.userData;
  if (!U.bind0) U.bind0 = mesh.quaternion.clone();
  p.getWorldQuaternion(_qc);
  _qa.copy(_qc).multiply(U.bind0);                     // where the authored grip points this frame
  _u1.copy(hang).applyQuaternion(_qa).normalize();
  if (!U.hangDir) { U.hangDir = _u1.clone(); U.rigid0 = _u1.clone(); }
  _qb.setFromUnitVectors(U.rigid0, _u1);               // this frame's wrist rotation drags the case with it…
  U.hangDir.applyQuaternion(_qb);
  U.rigid0.copy(_u1);
  // …and gravity pulls it back: critically damped, ω ≈ 9 rad/s. The floor on dt matters: a shot preset freezes
  // gameplay and can hand update() a zero dt, and a spring with k = 0 leaves the case hanging at whatever angle
  // the wrist happened to be in when it was attached.
  const k = 1 - Math.exp(-9 * clamp(dt, 1 / 240, 0.1));
  U.hangDir.lerp(_hangUp, k).normalize();
  _qb.setFromUnitVectors(_u1, U.hangDir);
  mesh.quaternion.copy(_qc).invert().multiply(_qb).multiply(_qa);
}
// Each foot's own ground point (world), midway between ankle and toe. It drives that foot's contact decal, so the
// shadow tightens and darkens under the planted foot and fades under the lifted one — the read of weight on a
// character. The city-wide sun cascade has no texel density to do this at 13:00, which is why the hero used to be
// a razor-sharp cut-out on blown-white pavement while every crowd body behind him sat on a soft ellipse.
const _m1 = new THREE.Matrix4();
// _fpA is private: callers pass _u4 as `out`, and aliasing the scratch with the output turned the lerp into a no-op
// against itself — every foot reported its TOE height, which is 12 cm off the ankle and read as permanently lifted.
const _fpA = new THREE.Vector3();
const _fp = [new THREE.Vector3(), new THREE.Vector3()];      // both feet in world, held while the decal is placed
function footPos(h, side, out) {
  const a = h.bones[side + 'Foot'], b = h.bones[side + 'ToeBase'];
  if (!a) return out.set(0, 0, 0);
  a.getWorldPosition(out);
  if (b) { b.getWorldPosition(_fpA); out.lerp(_fpA, 0.55); }
  return out;
}
// The decal belongs on the GROUND, not on the group origin: plant() lifts the origin onto whatever the character is
// standing on (0.15 m on a Shibuya sidewalk), so a quad at local y = 0.012 floated 16 cm over the pavement and the
// whole cast read as stickers. Ground Y comes from the physics ground query under each foot.
const _frustum = new THREE.Frustum(), _pvm = new THREE.Matrix4(), _csph = new THREE.Sphere(new THREE.Vector3(), 1.6);
function contactFrustum(engine) {
  const cam = engine && engine.camera; if (!cam) return false;
  _pvm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_pvm);
  return true;
}
// Cheap enough to run BEFORE the matrix walk: quads for feet nobody can see are not free, and neither is the
// recursive updateMatrixWorld that would have to run to place them.
function contactVisible(h, engine) {
  if (!engine || !engine.camera) return true;
  const s = h.group.scale.y || 1, gp = h.group.position;
  _csph.center.set(gp.x, gp.y + 0.9 * s, gp.z); _csph.radius = 1.7 * s;
  return _frustum.intersectsSphere(_csph);
}
// The sun's ground projection (the direction its shadow falls) plus how far a 1.8 m figure's shadow stretches at
// that elevation, clamped so a low sun does not turn a contact decal into a 5 m smear the real cascade already
// draws. Null at night / overcast: then the decals stay round and foot-aligned.
const _sg = { x: 0, z: 1, k: 1 };
function sunGround(engine) {
  const L = engine && engine.get && engine.get('lighting');
  const sun = L && L.sun;
  if (!sun || !sun.visible || (L.sunElevation ?? -1) < 0.12) return null;
  _u3.copy(sun.position);
  if (sun.target) _u3.sub(sun.target.position);
  const l = Math.hypot(_u3.x, _u3.z);
  if (l < 1e-4) return null;
  _sg.x = -_u3.x / l; _sg.z = -_u3.z / l;                 // away from the sun
  _sg.k = clamp(1 + 0.42 / Math.max(Math.tan(L.sunElevation), 0.25), 1, 2.2);
  return _sg;
}
// module scope, not per-call closures: updateContact runs for every visible full-detail body every frame
function contactGround(world, gy0, x, z) {
  let gy = world && typeof world.groundHeight === 'function' ? world.groundHeight(x, z) : gy0;
  if (!(gy > -60 && gy < 60) || Math.abs(gy - gy0) > 0.6) gy = gy0;     // off a ramp/stair the query can disagree
  return gy;
}
function contactQuad(pos, col, q, cx, cz, y, hu, hv, a, ux, uz) {
  const V = CONTACT_G * CONTACT_G, NP = CONTACT_NODE.p, NF = CONTACT_NODE.f;
  const vx = -uz, vz = ux, o = q * V * 3, co = q * V * 4;
  for (let k = 0; k < V; k++) {
    const p = NP[k * 2] * hu, r = NP[k * 2 + 1] * hv;
    pos[o + k * 3] = cx + ux * p + vx * r; pos[o + k * 3 + 1] = y; pos[o + k * 3 + 2] = cz + uz * p + vz * r;
    const c = co + k * 4; col[c] = col[c + 1] = col[c + 2] = 1; col[c + 3] = a * NF[k];
  }
}
function updateContact(h, engine) {
  const m = h.contact, s = h.group.scale.y || 1, gp = h.group.position;
  m.visible = true;
  // a frozen pose (review presets, a body posed once) whose group has not moved under an unchanged sun keeps last
  // frame's decal: no rewrite, no buffer upload
  if (h.frozenPose) {
    const S0 = sunGround(engine), e = h.group.matrixWorld.elements;
    const sig = e[12] + e[13] * 3 + e[14] * 7 + e[0] * 11 + e[2] * 13 + (S0 ? S0.x * 17 + S0.z * 19 + S0.k * 23 : 0);
    if (h._cSig === sig) return;
    h._cSig = sig;
  }
  const world = engine && engine.world;
  const pos = m.geometry.attributes.position.array, col = m.geometry.attributes.color.array;
  _m1.copy(h.group.matrixWorld).invert();
  // 30 mm, not 12: at a grazing camera the polygon offset loses to the plaza tile and the decal disappears entirely.
  // (ux, uz) is the quad's long axis in the GROUP's local XZ: axis-aligned quads could not point at the sun or lie
  // along a foot, so the lead was the one figure in the frame sitting on a radially symmetric pool while every
  // crowd extra behind him threw a directional, offset shadow.
  // shadow direction on the ground, in the group's local frame (the sun's ground projection, away from the sun)
  const S = sunGround(engine), yaw = h.group.rotation.y;
  const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
  let ux = 0, uz = 1, elong = 1;
  if (S) { ux = S.x * cy - S.z * sy; uz = S.x * sy + S.z * cy; elong = S.k; }
  // `lift` used to be measured against `h.footRest`, a bind-pose constant taken before plant() moved the group
  // onto the ground — and it was out by ~8 cm, so a figure STANDING STILL reported lift 0.51 on both feet
  // (self-test `contact.lift`) and every contact decal in the game ran at 0.575 of its authored alpha and 1.46x
  // its authored radius. That is why the plaza 20 cm from a planted sole measured 0.92x the open plaza.
  // Measure it relatively instead: the LOWER foot of a standing or walking figure is the planted one by
  // definition, so it is its own reference and no bind-frame number can drift away from it. `liftAll` folds in
  // the absolute height so a body in the air (knockdown, a jump) still fades both quads out.
  const fh = [0, 0], fg = [0, 0];
  for (let i = 0; i < 2; i++) { footPos(h, i ? 'Right' : 'Left', _fp[i]); fg[i] = contactGround(world, gp.y, _fp[i].x, _fp[i].z); fh[i] = (_fp[i].y - fg[i]) / s; }
  const rest = Math.min(fh[0], fh[1]);
  const liftAll = clamp((rest - 0.10) / 0.25, 0, 1);
  let lo = 1;
  for (let i = 0; i < 2; i++) {
    const lift = Math.max(clamp((fh[i] - rest - 0.02) / 0.16, 0, 1), liftAll);
    if (lift < lo) lo = lift;
    const y = (fg[i] + CONTACT_Y - gp.y) / s;
    _u4.copy(_fp[i]); _u4.y = 0; _u4.applyMatrix4(_m1);
    const w = CONTACT_W * (1 + lift * 0.9);
    // The foot quads are AMBIENT OCCLUSION and stay centred on the foot, round and short. Round 5 elongated them
    // along the sun and shifted their centres half the extra length downwind, which left the sunward side of
    // every shoe — the side the flagship camera is on — sitting on undarkened pavement. The cast direction is the
    // hips quad's job. These three overlap and the blend is multiplicative, so the authored alpha is not what
    // reaches the frame: the product under a sole measures 0.4x the adjacent plaza and 20 cm out 0.6x.
    contactQuad(pos, col, i, _u4.x, _u4.z, y, w, w, CONTACT_A * (1 - lift * 0.85), ux, uz);
  }
  // and the body itself: a 0.55 m elongated pool under the Hips, so the ground darkens under the whole figure
  { const b = h.bones.Hips;
    if (b) b.getWorldPosition(_u4); else _u4.set(gp.x, gp.y, gp.z);
    const gy = contactGround(world, gp.y, _u4.x, _u4.z);
    const y = (gy + CONTACT_Y - 0.002 - gp.y) / s;
    _u4.y = 0; _u4.applyMatrix4(_m1);
    contactQuad(pos, col, 2, _u4.x + ux * 0.30 * (elong - 1), _u4.z + uz * 0.30 * (elong - 1), y,
      0.52 * elong, 0.42, CONTACT_A * 0.55 * (1 - lo * 0.4), ux, uz);
  }
  m.geometry.attributes.position.needsUpdate = true;
  m.geometry.attributes.color.needsUpdate = true;
}
// The four points of each hand that actually stick out, in that hand bone's bind frame: fingertip, thumb side,
// back of the hand, forward knuckle. Measured off the built mesh, so the scan's own thumb and the procedural
// hand's four tubes both get the right probe set and neither has to be guessed at.
const PROBE_DIRS = [[0, 1, 0], [1, 0.45, 0], [-1, 0.45, 0], [0, 0.45, 1], [0, 0.45, -1]];
function handProbes(geo, R) {
  const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const out = {};
  if (!pos || !si || !sw) return out;
  const v = new THREE.Vector3();
  for (const side of SIDES) {
    const bi = RIG.index[side + 'Hand'], bw = R.world[side + 'Hand'];
    if (!bw) continue;
    const inv = bw.quaternion.clone().invert(), sgn = side === 'Left' ? 1 : -1;
    const best = PROBE_DIRS.map(() => ({ s: -Infinity, p: null }));
    for (let i = 0; i < pos.count; i += 2) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) w += sw.getComponent(i, k);
      if (w < 0.7) continue;
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(bw.position).applyQuaternion(inv);
      if (v.y < 0.01) continue;                                  // the cuff, not the hand
      for (let d = 0; d < PROBE_DIRS.length; d++) {
        const D = PROBE_DIRS[d], s2 = v.x * D[0] * sgn + v.y * D[1] + v.z * D[2];
        if (s2 > best[d].s) { best[d].s = s2; best[d].p = [v.x, v.y, v.z]; }
      }
    }
    const pts = best.filter((b) => b.p).map((b) => b.p);
    if (pts.length) { pts.push([0, pts[0][1] * 0.5, 0]); out[side] = pts; }
  }
  return out;
}
// 優先3 grounding: a body on the floor lies ON it. The knockdown / dead clips are authored on the generic rig with the
// pelvis 16 cm up; on the scans' proportions the shins went 17-23 cm under the paving, and enemy.js's lying variants
// (the roll onto the side, the curl, the arm flung out along the ground) pushed a shoulder, a forearm or both thighs
// 34-49 cm under it (measured on the skinned mesh, docs/reports/characters.md). ~500 of the body's own vertices are
// skinned on the CPU each frame he is down: whatever of the trunk (pelvis, back, head, the thigh / shoulder next to
// it) is under the ground lifts the whole body, and a leg or arm still under swings up about its hip / shoulder just
// far enough to rest on it. Idempotent on a held pose (nothing under the ground, nothing moves). ?floorFit=0 A/B.
const FLOOR_CLIPS = new Set(['knockdown', 'dead', 'getup']);
const NO_FLOOR = typeof location !== 'undefined' && /[?&]floorFit=0/.test(location.search);
const FLOOR_CHAIN = { LeftUpLeg: 1, LeftLeg: 1, LeftFoot: 1, LeftToeBase: 1, RightUpLeg: 2, RightLeg: 2, RightFoot: 2, RightToeBase: 2,
  LeftArm: 3, LeftForeArm: 3, LeftHand: 3, RightArm: 4, RightForeArm: 4, RightHand: 4 };
const FLOOR_ROOT = [null, 'LeftUpLeg', 'RightUpLeg', 'LeftArm', 'RightArm'];
const _ffa = new THREE.Vector3(), _ffb = new THREE.Vector3(), _ffc = new THREE.Vector3(), _ffq = new THREE.Quaternion(), _ffp = new THREE.Quaternion(), _ffr = new THREE.Quaternion();
const _ffM = [];
function floorSamples(h) {
  if (h._floorS) return h._floorS;
  const g = h.skinned.geometry, P = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, idx = g.index && g.index.array;
  const names = h.skeleton.bones.map((b) => b.name), used = new Uint8Array(P.count);
  if (idx) for (let i = 0; i < idx.length; i++) used[idx[i]] = 1; else used.fill(1);
  const list = [];
  for (let i = 0; i < P.count; i++) if (used[i]) list.push(i);
  const step = Math.max(1, Math.floor(list.length / 520)), n = Math.ceil(list.length / step);
  const S = { n, p: new Float32Array(n * 3), b: new Uint8Array(n * 4), w: new Float32Array(n * 4), c: new Uint8Array(n) };
  for (let k = 0; k < n; k++) {
    const i = list[k * step]; let bb = 0, bw = -1;
    S.p[k * 3] = P.getX(i); S.p[k * 3 + 1] = P.getY(i); S.p[k * 3 + 2] = P.getZ(i);
    for (let j = 0; j < 4; j++) { const b = si.getComponent(i, j), w = sw.getComponent(i, j); S.b[k * 4 + j] = b; S.w[k * 4 + j] = w; if (w > bw) { bw = w; bb = b; } }
    S.c[k] = FLOOR_CHAIN[names[bb]] || 0;
  }
  return (h._floorS = S);
}
// the worst depth under the ground of the samples of `chain` (-1: all), world position of that sample in _ffb
function floorWorst(h, S, gy, chain, rootPos, near) {
  const bones = h.skeleton.bones, inv = h.skeleton.boneInverses;
  for (let i = 0; i < bones.length; i++) (_ffM[i] || (_ffM[i] = new THREE.Matrix4())).multiplyMatrices(bones[i].matrixWorld, inv[i]);
  let worst = -Infinity;
  for (let k = 0; k < S.n; k++) {
    const c = S.c[k];
    if (chain >= 0 && c !== chain) continue;
    let x = 0, y = 0, z = 0;
    const px = S.p[k * 3], py = S.p[k * 3 + 1], pz = S.p[k * 3 + 2];
    for (let j = 0; j < 4; j++) {
      const w = S.w[k * 4 + j]; if (w <= 0) continue;
      const e = _ffM[S.b[k * 4 + j]].elements;
      x += w * (e[0] * px + e[4] * py + e[8] * pz + e[12]); y += w * (e[1] * px + e[5] * py + e[9] * pz + e[13]); z += w * (e[2] * px + e[6] * py + e[10] * pz + e[14]);
    }
    // a limb's samples next to its root (the seat, the shoulder cap) belong to the trunk's lift, not to a swing
    if (rootPos) { const dd = (x - rootPos.x) ** 2 + (y - rootPos.y) ** 2 + (z - rootPos.z) ** 2; if (chain >= 0 ? dd < near * near : false) continue; }
    const d = gy(x, z) - y;
    if (d > worst) { worst = d; _ffb.set(x, y, z); }
  }
  return worst;
}
function floorFit(h) {
  if (NO_FLOOR) return 0;
  const B = h.bones, world = humanoid.engine && humanoid.engine.world, s = h.group.scale.y || 1;
  if (!B || !B.Hips || !B.Hips.parent || !h.skeleton) return 0;
  const g0 = h.group.position.y, gy = (x, z) => (world ? world.groundHeight(x, z) : g0) + 0.004;
  const S = floorSamples(h);
  h.group.updateMatrixWorld(true);
  // the trunk: every sample except the far parts of the limbs
  let d = -Infinity;
  for (let c = 0; c <= 4; c++) {
    if (c === 0) { d = Math.max(d, floorWorst(h, S, gy, 0, null, 0)); continue; }
    B[FLOOR_ROOT[c]].getWorldPosition(_ffa);
    const near = (c < 3 ? 0.14 : 0.09) * s;
    // (only the near samples of a limb count here: floorWorst skips the far ones when given the root)
    const bones = h.skeleton.bones, inv = h.skeleton.boneInverses;
    for (let i = 0; i < bones.length; i++) (_ffM[i] || (_ffM[i] = new THREE.Matrix4())).multiplyMatrices(bones[i].matrixWorld, inv[i]);
    for (let k = 0; k < S.n; k++) {
      if (S.c[k] !== c) continue;
      let x = 0, y = 0, z = 0; const px = S.p[k * 3], py = S.p[k * 3 + 1], pz = S.p[k * 3 + 2];
      for (let j = 0; j < 4; j++) { const w = S.w[k * 4 + j]; if (w <= 0) continue; const e = _ffM[S.b[k * 4 + j]].elements;
        x += w * (e[0] * px + e[4] * py + e[8] * pz + e[12]); y += w * (e[1] * px + e[5] * py + e[9] * pz + e[13]); z += w * (e[2] * px + e[6] * py + e[10] * pz + e[14]); }
      if ((x - _ffa.x) ** 2 + (y - _ffa.y) ** 2 + (z - _ffa.z) ** 2 < near * near) d = Math.max(d, gy(x, z) - y);
    }
  }
  if (d > 0) { B.Hips.position.y += d / s; B.Hips.updateMatrixWorld(true); }
  let turned = 0;
  for (let c = 1; c <= 4; c++) {
    const R0 = B[FLOOR_ROOT[c]]; if (!R0) continue;
    const near = (c < 3 ? 0.14 : 0.09) * s;
    for (let it = 0; it < 4; it++) {
      R0.getWorldPosition(_ffa);
      const worst = floorWorst(h, S, gy, c, _ffa, near);
      if (!(worst > 0.003)) break;
      _ffc.subVectors(_ffb, _ffa);                         // root -> the part under the ground
      if (Math.hypot(_ffc.x, _ffc.z) < 0.04) break;
      const L = _ffc.length();
      _ffc.cross(_u1.set(0, 1, 0)).normalize();            // rotating about (v x up) lifts v
      const th = Math.min(Math.asin(Math.min(1, worst / Math.max(L, 0.05))) * 1.1, 0.6);
      R0.parent.getWorldQuaternion(_ffp);
      _ffq.setFromAxisAngle(_ffc, th);
      R0.quaternion.premultiply(_ffr.copy(_ffp).invert().multiply(_ffq).multiply(_ffp));
      R0.updateMatrixWorld(true);
      turned++;
    }
  }
  h._floorLift = Math.max(0, d); h._floorTurns = turned;
  return h._floorLift;
}
function lowestFoot(h) {
  let lo = Infinity;
  for (const b of ['LeftToeBase', 'RightToeBase', 'LeftFoot', 'RightFoot']) {
    const bone = h.bones[b]; if (!bone) continue;
    bone.getWorldPosition(_u4);
    if (_u4.y < lo) lo = _u4.y;
  }
  return lo === Infinity ? 0 : lo;
}

export function createHumanoid({ variant = 'kento', seed = 1, getClip = null, detail = null, keyLight = null, lod = null, prop = undefined, entity = null, civ = false, part = undefined,
  fem = undefined, outfit = undefined, hair = undefined, hairColor = undefined, skin: skinTone = undefined, height = undefined, build = undefined, accessories = undefined, age = undefined } = {}) {
  if (variant === 'kiryu') variant = 'kento';           // legacy alias
  const V = { ...(VARIANTS[variant] || VARIANTS.pedestrian) };
  V.civ = !!(civ && V.scan);
  const rng = mulberry(seed);
  if (variant === 'chinpira' || variant === 'yakuza' || variant === 'boss') seededMorph(V, rng, variant);
  if (variant === 'pedestrian') {
    // everything a passer-by is comes out of ONE resolved look (resolvePedestrian): crowd.js builds the instanced
    // twin from the same record, so the swap in view is between two bodies wearing the same clothes
    applyLook(V, resolvePedestrian({ seed, fem, outfit, hair, hairColor, skin: skinTone, height, build, accessories, age }));
    for (let i = 0; i < 6; i++) rng();                   // the body's own strand/lock jitter draws start past the look's
    // a carried phone is posed by the caller's clip; the umbrella hangs from the right hand like a cane
    if (prop === undefined && V.look.accessories.includes('umbrella')) prop = 'umbrella';
    else if (prop === undefined && V.look.accessories.includes('phone')) prop = 'phone';
  }
  const det = detail != null ? detail : (variant === 'kento' || V.cast ? 1 : 0.75);
  const MOB = V.scan && SCANS[V.scan] && SCANS[V.scan].state === 'ready' ? SCANS[V.scan] : null;
  const glb = !!MOB || !!(V.glb && HERO.state === 'ready');
  // the measured joints are already 1.82 m tall; a pedestrian scan is BUILT at 1.82 m (the clips' own rig) and shrunk
  // to the person here, so the walk's hips height and leg IK land exactly as authored
  if (glb) V.scale = MOB && V.ped ? (V.pedHeight || MOB.data.height || 1.82) / ((MOB.data.built || 1.82) + (pedLong(V.ped) ? PL.dL - PL.dT : 0))
    : MOB && V.cast ? (V.castHeight || MOB.data.height || 1.82) / (MOB.data.built || 1.82) : variant === 'kento' ? HERO_HEIGHT / HERO_ASSET_HEIGHT : 1;   // scans retain their authored bind rig
  else delete V.joints;                                           // scan missing -> generic rig + procedural body
  if (V.ped && !MOB && !createHumanoid._pedWarned) { createHumanoid._pedWarned = true; console.warn(`[humanoid] ${variant} built before its scan loaded (await pedScansReady())`); }
  // `part` picks the rung of a scan's LOD ladder to build as THE body (lod0 | lod1 | lod2); no ladder under it unless
  // lod: true asks for one (then the rungs below it)
  const PARTS = ['lod0', 'lod1', 'lod2'], part0 = MOB && PARTS.includes(part) && MOB.data.parts[part] ? part : 'lod0';
  const { rig: R, lift, stance } = rigFor(V, seed);
  if(V.hero)R.hero=true;
  if (!glb) V.headK = headSizeFor(V, R, lift) * (V.headScale || 1);
  // a carried item has to be GRIPPED: the finger chain is built once, so the hand that will hold something closes
  // at build time. Without this the phone hung in mid-air beside an open, flat hand.
  const pk = prop !== undefined ? prop : (variant === 'kento' ? 'briefcase' : null);
  if (pk) { const g = PROP_GRIP[pk]; if (g) V[g.bone === 'LeftHand' ? 'fistL' : 'fistR'] = g.fist; }
  const { geo, mats, tris, skin } = MOB ? buildMobBody(V, R, det, stance, part0, MOB)
    : glb ? buildHeroBody(V, R, det, stance) : buildBody(V, rng, det, R, stance);
  let skinRefs = 1;

  // bones (bind from the per-humanoid rig; clips are deltas so they apply to any proportions)
  const bones = [], byName = {};
  for (const n of BONE_NAMES) {
    const b = new THREE.Bone(); b.name = n;
    b.position.copy(R.local[n].position); b.quaternion.copy(R.local[n].quaternion);
    bones.push(b); byName[n] = b;
  }
  for (const n of BONE_NAMES) if (PARENT[n]) byName[PARENT[n]].add(byName[n]);
  const neckHeadBind = byName.Neck.quaternion.clone().multiply(byName.Head.quaternion);
  const handBind = { Left: byName.LeftHand.quaternion.clone(), Right: byName.RightHand.quaternion.clone() };

  const skinned = new THREE.SkinnedMesh(geo, mats);
  skinned.name = 'humanoid:' + variant;
  // The bones hang off a host group rather than off the mesh itself: with a LOD ladder the renderer hides LOD0
  // beyond 8 m, and anything parented to a bone — the briefcase, a weapon — went dark with it.
  const boneHost = new THREE.Group(); boneHost.name = 'bones';
  boneHost.add(byName.Hips);
  skinned.add(boneHost);
  skinned.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  skinned.bind(skeleton, new THREE.Matrix4());
  skinned.position.y = lift;                        // after bind: lifts mesh + bones together so the feet sit on y=0
  const lit = keyLight != null ? keyLight : variant === 'kento';
  skinned.castShadow = true;
  // Everyone receives. Opting the hero out was the old workaround for a city-wide cascade whose texels are wider
  // than a nose, and the price was a character who stood on blown-white pavement with a razor-sharp silhouette and
  // no contact darkening at all while every crowd body behind him sat on a soft ellipse — a sticker on the street.
  // The cascade still cannot resolve him, so `lit` characters also carry the contact decal below.
  skinned.receiveShadow = true;
  // the depth bias has to cover one cascade texel across a chest now that he receives: at 1.5/2 the sun's map put
  // blocky 20 cm blobs on his lapel and thigh
  skinned.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, polygonOffset: true, polygonOffsetFactor: 3.0, polygonOffsetUnits: 5 });
  skinned.frustumCulled = true;                    // fixed generous bounding sphere set in buildBody

  // LOD ladder: cheaper bodies bound to the SAME skeleton (the bones live under LOD0, which the mixer drives), wrapped
  // in a THREE.LOD the renderer updates per camera. `detail` stays the build-time ceiling; this is the runtime ladder.
  // LOD0 holds to 14 m: at fov 38 a 1.8 m body at 8 m is still ~300 px tall, and dropping it to mitten hands and a
  // painted face there was visible in every group shot. LOD1 pays for it by being cheaper than it was.
  const meshes = [skinned];
  const ladder = part !== undefined && MOB ? lod === true : lod != null ? lod : det >= 0.9;
  if (ladder) {
    // a scan's LOD0 is 33 k triangles over three 2048² maps: past 8 m its lod1 (10 k) holds the same silhouette
    // (fix round 3: 5 m / 12 m put the 5.8 m lineup on lod1 — a smeared face with slit eyes at 4 m)
    // a pedestrian's rungs are the crowd's (docs/PEDS.md): lod0 to 14 m, lod1 (3 k) to 40 m, lod2 (750) beyond
    // (the story cast keeps the v1 hero's distances: lod0 to 14 m, lod1 to 26 m)
    const rungs = MOB && !V.cast ? (V.ped ? [[0.5, 14, 'lod1'], [0.28, 40, 'lod2']] : [[0.5, 8, 'lod1'], [0.28, 18, 'lod2']]) : [[0.5, 14, 'lod1'], [0.28, 26, 'lod2']];
    for (const [d, at, part] of rungs.filter((r) => !MOB || PARTS.indexOf(r[2]) > PARTS.indexOf(part0))) {
      let alt = null;
      try {
        alt = MOB ? buildMobBody(V, R, d, stance, part, MOB)
          : glb ? buildHeroBody(V, R, d, stance, part) : buildBody(V, mulberry(seed), d, R, stance);
      } catch (e) { console.warn('[humanoid] lod build failed', e.message); break; }
      const m = new THREE.SkinnedMesh(alt.geo, alt.mats);
      m.name = skinned.name + ':lod' + at;
      m.bind(skeleton, new THREE.Matrix4());
      m.position.y = lift; m.castShadow = true; m.receiveShadow = true;
      m.customDepthMaterial = skinned.customDepthMaterial;
      m.userData.lodAt = at;
      meshes.push(m); skinRefs++;
    }
  }
  let lodRoot = skinned;
  if (meshes.length > 1) {
    lodRoot = new THREE.LOD(); lodRoot.name = 'humanoidLOD:' + variant;
    skinned.remove(boneHost); lodRoot.add(boneHost); boneHost.position.y = lift;   // same world transform as the mesh
    lodRoot.addLevel(skinned, 0);
    for (let i = 1; i < meshes.length; i++) lodRoot.addLevel(meshes[i], meshes[i].userData.lodAt);
    for (const prop of ['castShadow', 'receiveShadow']) {     // crowd.js toggles these on h.skinned: carry them across
      let v = skinned[prop];
      Object.defineProperty(skinned, prop, { configurable: true, get: () => v, set: (x) => { v = x; for (let i = 1; i < meshes.length; i++) meshes[i][prop] = x; } });
    }
  }

  // Wet-ground reflection: weather.js mirrors layer 1 into the road (crowd.js puts its instanced people there the
  // same way). Without it six people stand on a mirror full of neon and not one of them smears down the asphalt,
  // which in any wet Kamurocho night shot is the first thing you see.
  const RL = (humanoid.engine && humanoid.engine.layers && humanoid.engine.layers.BLOOM) || 1;
  for (const m of meshes) m.layers.enable(RL);
  if (lodRoot !== skinned) lodRoot.layers.enable(RL);

  const group = new THREE.Group();
  group.name = 'humanoidGroup:' + variant;
  group.scale.setScalar(V.scale);
  group.add(lodRoot);
  // Character key + rim, parented to the body so it travels with him. 4 m falloff: it models the lead and leaves the
  // crowd and the street alone. Intensity follows time of day (see humanoid.update).
  // No THREE.Light objects on a body any more: the key and the rim are evaluated analytically inside the
  // character shader (see charShader / setCharKey), so the city's ~650 other draws stop compiling and running a
  // 9-light forward loop for a rim on one man, and a hand 1.0 m from the lamp stops taking 2.6x the cheek's
  // irradiance. `keyRig` survives as the per-body gain the review presets still push.
  const keyRig = lit ? { gain: glb ? 0.62 : 1, boost: 1, on: true } : null;
  let contact = null;
  // Per-foot contact decals for every character built at full detail. The sun cascade spans the whole city, so at
  // 13:00 it has no texel density under a shoe and at night there is no sun at all: without these the cast is a
  // row of stickers on the pavement. Two 0.62 m quads per body, and the crowd's instanced people never pay.
  if (det >= 0.9 && !V.civ) {                       // (a pool civilian is grounded by the crowd's own contact shadow)
    contact = contactMesh();
    group.add(contact);
  }

  // Self-collision budget, per the critic's formula: a bigger fist on a squarer jaw needs more room. The body term
  // is the jacket radius at that height plus 2.5 cm, which is what stops a hand-on-hip pose putting the fingers
  // inside the suit.
  const bb = V.build || 1;
  // Self-collision budget. A single scalar radius could not hold a 0.8 fist off a 1.15 jaw — the boss's guard pose
  // drove his own knuckles into his cheek in the one frame built to show the cast off — because a head is not a
  // sphere: it is ~9 cm across, ~12.5 cm tall and ~11 cm deep. The barrier is an ellipsoid around the Head bone,
  // grown by the fist's own radius plus 2 cm, and resolveSelfClip iterates it twice.
  const clearance = {
    scale: V.scale,
    headUp: 0.10,
    headR: [(0.090 * (V.jaw || 1) * bb + fistRadius(V) + 0.02) * V.scale,
      (0.125 * bb + fistRadius(V) + 0.02) * V.scale,
      (0.100 * (V.jaw || 1) * bb + fistRadius(V) + 0.02) * V.scale],
    head: (0.090 * (V.jaw || 1) * bb + fistRadius(V) + 0.02) * V.scale,   // the sphere the sweeps still report against
    body: (dy) => (table([[-0.20, 0.196], [0.0, 0.203], [0.16, 0.200], [0.30, 0.212], [0.42, 0.222]], dy)[0] * bb + 0.025) * V.scale,
    handPts: handProbes(geo, R),
  };
  const mixer = new THREE.AnimationMixer(lodRoot);   // the bone host, whichever of the two it ended up under
  // per-character fighting stance: which foot leads, how far the rear hand sits back (see stagger())
  const sg = mulberry(((seed | 0) * 9176 + 1013) >>> 0);
  const stance2 = { lead: sg() < 0.5 ? 1 : -1, pull: 0.13 + sg() * 0.06, twist: 0.20 + sg() * 0.06, tilt: 0.045 + sg() * 0.03, chin: 0.08 + sg() * 0.04 };
  // per-character standing break: shoulder line 4-7° against the hips, both elbows 8-14°, head a few degrees off,
  // the pelvis rolled 2-4° onto the support leg and shifted 1-2 cm over it, one shoulder dropped
  const brk = { sup: stance ? (stance.sup || 1) : 1, roll: 0.070 + sg() * 0.052, twist: 0.030 + sg() * 0.030,
    elbowL: 0.140 + sg() * 0.105, elbowR: 0.140 + sg() * 0.105, head: -0.030 - sg() * 0.028,
    shift: 0.010 + sg() * 0.009, drop: 0.035 + sg() * 0.035, dropSide: sg() < 0.5 ? 'Left' : 'Right' };
  // 渋沢 健人's own idle. Both his arms hung dead straight and symmetric with a level shoulder line — the body
  // said nothing, only the head did. The attaché weighs the left side down; the free arm carries more elbow.
  // Fix round 2 (a Kiryu/Ichiban stance, not a mannequin): the pelvis shifts 3 cm onto the right leg and rolls ~4°,
  // the case shoulder drops against it, the free arm comes in to ~8° with 15° of elbow, the free knee gives 6°.
  // (Fix round 3 turned the head ~10° off the body and pushed the pelvis to 5 cm; seen from the front the face read
  // as twisted — client: 「主人公の顔が歪んでる」. Back to round 2's stance.)
  if ((glb && !MOB) || V.hero) { brk.sup = -1; brk.roll = 0.127; brk.twist = 0.055; brk.head = -0.042; brk.shift = 0.030;
    brk.elbowL = 0.095; brk.elbowR = 0.26; brk.drop = 0.105; brk.dropSide = 'Left'; brk.freeArm = 'Right'; brk.adduct = KQA[0] || 0.2; brk.knee = KQA[1] || 0.105;
    // v2: the Meshy rig is fitted symmetric (v1's was measured off a scan standing 4 cm off its own centre line, which
    // tipped every clip's shoulder line on its own), so the same break read 1.9-2.0° — a level mannequin by the sweep's
    // measure — and the taunt, which has no break, stood dead level: a little more roll and drop, and the taunt too
    if (V.hero && MOB) {
      brk.roll = 0.035; brk.twist = 0.015; brk.shift = 0.008; brk.head = 0;
      brk.drop = 0.018; brk.knee = 0.025; brk.elbowR = 0.15; brk.adduct = 0.08;
      brk.more = new Set(['taunt']);
    } }
  else if (MOB && !V.civ && MOB_STANCE[V.scan]) Object.assign(brk, MOB_STANCE[V.scan]);
  const h = {
    stagger: stance2,
    idleBreak: brk,
    scan: MOB ? V.scan : null,
    cast: !!(MOB && V.cast),                         // a story-cast scan (hero v2, 柊): enemy.js leaves its body as built
    ped: V.ped && MOB ? V.ped : null, pelvisUp: V.ped && MOB ? pedPelvisUp(V.ped) : 0, part: MOB ? part0 : null, gait: V.ped && MOB ? (V.gait || null) : null,
    neckHeadBind, handBind,
    _ov: new Map(),                                  // per-bone overlay memory (see overlay())
    group, skinned, skeleton, bones: byName, mixer, variant, seed, tris, drawCalls: Array.isArray(mats) ? mats.length : 1, keyRig, contact, clearance, stance, lod: lodRoot, meshes,
    slots: MOB && MOB.slots ? MOB.slots : glb ? PROP_SLOTS : PROC_SLOTS,   // the scan's grip is MEASURED off his own hand (v2: his closed fist, castFistMorph); a lofted hand is a different shape
    displayName: V.displayName || null,
    height: variant === 'kento' ? HERO_HEIGHT : (R.joints.Head[1] + 0.22 + lift) * V.scale, proportions: { shoulderW: V.shoulderW, torsoLen: V.torsoLen, legLen: V.legLen, gut: V.gut, scale: V.scale },
    currentName: null, currentAction: null, weapon: null, props: {}, frozenPose: false, propKind: null, droppedProp: null,
    // lateFloor: the owner runs floorFit() itself after its own pose pass (enemy.js, after its lying variants)
    lateFloor: false, floorFit() { return floorFit(h); },
    floorOK: variant === 'kento' || !!(MOB && !V.civ && !V.ped),     // the cast only: pedestrians are crowd.js's
    play(name, { fade = 0.15, loop = true, speed = 1, force = false } = {}) {
      const provider = getClip || humanoid.getClip;
      const clip = provider ? provider(name, V.hero ? {key:'kento-proportions-v3',rig:R} : null) : null;
      if (!clip) { if (!h.__warned) { console.warn('[humanoid] no clip', name); h.__warned = true; } return null; }
      if (h.currentName === name && h.currentAction && !force && h.currentAction.isRunning()) return h.currentAction;
      const action = mixer.clipAction(clip);
      action.enabled = true;
      action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = !loop;
      // A larger body takes longer strides; keep its planted foot speed aligned with player travel.
      const playbackSpeed = variant === 'kento' && (name === 'walk' || name === 'run') ? speed / V.scale : speed;
      action.timeScale = playbackSpeed;
      if (h.currentAction && h.currentAction !== action) h.currentAction.fadeOut(fade);
      action.reset().setEffectiveTimeScale(playbackSpeed).setEffectiveWeight(1).fadeIn(fade).play();
      h.currentAction = action; h.currentName = name;
      return action;
    },
    current() { return h.currentName; },
    isFinished() { return h.currentAction ? (!h.currentAction.isRunning() || (h.currentAction.loop === THREE.LoopOnce && h.currentAction.time >= h.currentAction.getClip().duration - 1e-4)) : true; },
    // props parented to a bone; offset = { position:[x,y,z], rotation:[x,y,z] } in the bone frame (+Y down the bone, +Z forward at bind)
    attach(name, mesh, boneName = 'RightHand', offset = null) {
      h.detach(name);
      if (!mesh) return null;
      const b = byName[boneName]; if (!b) { console.warn('[humanoid] attach: no bone', boneName); return null; }
      if (offset && offset.position) mesh.position.fromArray(offset.position);
      if (offset && offset.rotation) mesh.rotation.fromArray(offset.rotation);
      b.add(mesh); h.props[name] = mesh;
      return mesh;
    },
    detach(name) { const m = h.props[name]; if (m) { m.parent?.remove(m); delete h.props[name]; } },
    setWeapon(mesh) { h.weapon = mesh ? h.attach('weapon', mesh, 'RightHand') : (h.detach('weapon'), null); },
    // carried item: 'briefcase' (left hand), 'phone', 'cigarette' — setProp(null) removes it
    setProp(kind) {
      if (h.droppedProp) { h.droppedProp.parent?.remove(h.droppedProp); h.droppedProp = null; }
      h.detach('prop');
      h.propKind = kind || null;
      if (!kind) return null;
      const slot = (h.slots && h.slots[kind]) || PROP_SLOTS[kind] || PROP_SLOTS.phone;
      const mesh = makeProp(kind);
      if (!mesh) { h.propKind = null; return null; }
      const at = h.attach('prop', mesh, slot.bone, mesh.userData.exact || !slot.position ? null : { position: slot.position, rotation: slot.rotation });
      driveFist(h, 1);                               // (the hand closes on it now, not on the next unfrozen frame: a cutscene still)
      return at;
    },
    // fight starting: stand the carried item on the ground just in front of the feet (kept, so setProp() can pick it back up)
    dropProp(scene = null) {
      const mesh = h.props.prop;
      if (!mesh) return null;
      const root = scene || group.parent;
      h.detach('prop');
      if (!root) return null;
      const yaw = group.rotation.y, fx = Math.sin(yaw), fz = Math.cos(yaw);
      const bag = h.propKind === 'briefcase';
      driveFist(h, 1);                               // (the carrying hand opens with it: a held still keeps no grip on nothing)
      // yaw it, undo the bone frame it was modelled in, then sit its own bounding box on the ground at his feet
      mesh.quaternion.setFromEuler(new THREE.Euler(0, yaw + 0.6, bag && !mesh.userData.bindQ ? HPI : 0));
      if (mesh.userData.bindQ) mesh.quaternion.multiply(mesh.userData.bindQ);
      mesh.position.set(0, 0, 0); mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh), ctr = box.getCenter(new THREE.Vector3());
      mesh.position.set(group.position.x + fx * 0.42 + fz * 0.46 - ctr.x, group.position.y - box.min.y + 0.002, group.position.z + fz * 0.42 - fx * 0.46 - ctr.z);
      root.add(mesh);
      h.droppedProp = mesh;
      return mesh;
    },
    boneWorld(name, out = new THREE.Vector3()) { const b = byName[name]; if (!b) return out.set(0, 0, 0); return b.getWorldPosition(out); },
    // pose at a clip phase and freeze (screenshots)
    pose(name, phase = 0) {
      const prev = h.currentAction;
      const action = h.play(name, { fade: 0, loop: true, force: true });
      if (!action) return;
      // play()'s fadeIn(0) is a weight ramp of zero length, and three.js evaluates it at its own start time from a
      // pooled interpolant's cached index: some page loads it read 0, so a still showed the bind pose (or the previous
      // clip) instead of the clip asked for — flaky from load to load (優先3 probes). A held pose has no fade.
      action.stopFading().setEffectiveWeight(1);
      if (prev && prev !== action) prev.stop();
      mixer.update(0); action.time = clamp(phase, 0, 0.999) * action.getClip().duration; mixer.update(0);
      h.frozenPose = true; h._cSig = null;
      driveFist(h, 1);
      group.updateMatrixWorld(true); resolveSelfClip(h); clampFistLift(h); group.updateMatrixWorld(true);
      if (h.floorOK && !h.lateFloor && FLOOR_CLIPS.has(name)) floorFit(h);
    },
    // sit the lowest foot back on the ground plane: a clip authored against the generic rig floats or sinks a
    // shorter or taller build, and a shoe half under the crosswalk stripe is the loudest tell in a lineup
    plant() {
      h._cSig = null;
      group.updateMatrixWorld(true);
      group.position.y -= (lowestFoot(h) - group.position.y) - h.footBind;
      group.updateMatrixWorld(true);
      return h;
    },
    dispose() {
      const i = humanoid.all.indexOf(h); if (i >= 0) humanoid.all.splice(i, 1);
      for (const k of Object.keys(h.props)) h.detach(k);
      if (h.droppedProp) { h.droppedProp.parent?.remove(h.droppedProp); h.droppedProp = null; }
      mixer.stopAllAction(); mixer.uncacheRoot(lodRoot);
      if (group.parent) group.parent.remove(group);
      skeleton.dispose(); skinned.customDepthMaterial?.dispose();
      if (contact) { group.remove(contact); contact.geometry.dispose(); }   // the material is shared by the whole cast
      if (h.civ) h.civ.dispose();
      for (const m of meshes) m.geometry.dispose();
      if (skin) for (let i = 0; i < skinRefs; i++) releaseSkin(skin);   // cloth/hair materials are shared per colour and kept
    },
  };
  // the hero carries his briefcase unless the caller asked for something else — nobody downstream has to wire it up,
  // and humanoid.init() swaps it for `dropProp()` when a fight starts. Same for the name plate.
  group.updateMatrixWorld(true);
  h.footPitch0 = { Left: footPitch(h, 'Left'), Right: footPitch(h, 'Right') };   // the sole's own bind pitch
  h.footBind = lowestFoot(h);                       // bind heights: plant() uses the lowest bone, the decal the ground point
  // both sides through the same call path (one used to be aliased and one not, so the reference height was the mean of
  // a toe and an ankle-toe midpoint) and relative to the group origin, which is where the ground is after plant()
  h.footRest = (footPos(h, 'Left', _u1).y + footPos(h, 'Right', _u2).y) * 0.5 - group.position.y;
  if (prop !== undefined) h.setProp(prop);
  else if (variant === 'kento') h.setProp('briefcase');
  if (MOB && !V.civ) attachPlugs(h, geo, R, MOB.mat, RL);
  if (V.civ && MOB) {
    // enemy.js's own clean-up (spine fit, prop islands) exactly as a fight runs it, then the civilian wardrobe
    const en = humanoid.engine && humanoid.engine.get && humanoid.engine.get('enemy');
    try { if (en && typeof en.prepareBody === 'function') en.prepareBody(h, variant, null); } catch (e) { void e; }
    meshes.forEach((m, i) => {
      // civFinish is a pure function of the scan and the rung: the second civilian of a scan reuses the first's result
      const g = m.geometry, k = V.scan + ':' + i + ':' + g.attributes.position.count + ':' + g.index.count, c = CIV_GEO.get(k);
      if (c) {
        g.setIndex(new THREE.BufferAttribute(c.index, 1));
        g.setAttribute('aWard', new THREE.BufferAttribute(c.ward, 3));
        g.userData.handPlugs = c.plugs;
      } else {
        civFinish(g, R, V.scan, MOB);
        CIV_GEO.set(k, { index: g.index.array, ward: g.attributes.aWard.array, plugs: g.userData.handPlugs || null });
      }
    });
    civDress(h, V.scan);
    attachPlugs(h, skinned.geometry, R, (h.civ && h.civ.material) || MOB.mat, RL);
    h.displayName = null;
  }
  if (h.displayName && entity) { entity.displayName = h.displayName; if (!entity.name) entity.name = h.displayName.ja; }
  humanoid.all.push(h);
  return h;
}

// ---------------------------------------------------------------- props (briefcase, phone, cigarette): meshes for attach()
// Slot = the bone and the local offset setProp() uses; the hand bone's +Y runs down the bone, +Z is forward at bind.
// The grip point of a closed hand is ~9.5 cm down the hand bone, a couple of centimetres to the PALM side (local
// +X on the left hand, -X on the right — see orientation(): local +X runs outboard on the right and inboard on
// the left). The handle used to sit 4.6 cm short of that, which is why the fingers splayed in front of the case
// with a visible gap, and the phone hung beside an ear with no hand on it at all.
export const PROP_SLOTS = {
  // yaw HPI: the shell is authored 0.088 deep on local X and 0.42 wide on local Z, and in the hand's bind frame
  // that hung the case EDGE-ON to the camera — a narrow slab. docs/ref/hero-model-views.png FRONT shows the broad
  // face square to the viewer with the handle bar running across the body, which is where a quarter turn puts it.
  briefcase: { bone: 'LeftHand', position: [0.016, 0.088, 0], rotation: [0, HPI, 0] },
  // the screen faces the head (a quarter turn each way was a lit panel turned to the camera, away from his eyes)
  phone: { bone: 'RightHand', position: [-0.016, 0.082, 0.004], rotation: [0, Math.PI, 0] },
  // between the index and middle fingers, 3 cm clear of the knuckles: at the lips it sits off the mouth, not in it
  cigarette: { bone: 'RightHand', position: [-0.010, 0.092, 0.050], rotation: [0.25, 0, 0] },
};
// The PROCEDURAL hand is lofted, and PROP_GRIP closes its finger chain at build time, so its grip point is
// further down the bone than the scan's rigid one. Keeping one table for both is what put the case 12 mm past
// the hero's fingertips in the first place.
export const PROC_SLOTS = {
  briefcase: { bone: 'LeftHand', position: [0.016, 0.082, 0], rotation: [0, HPI, 0] },
  phone: { bone: 'RightHand', position: [-0.016, 0.082, 0.004], rotation: [0, Math.PI, 0] },
  cigarette: { bone: 'RightHand', position: [-0.010, 0.092, 0.050], rotation: [0.25, 0, 0] },
};
// how far the holding hand closes when the item is attached at build time (the finger chain is lofted once)
export const PROP_GRIP = {
  briefcase: { bone: 'LeftHand', fist: 0.88 },
  phone: { bone: 'RightHand', fist: 0.58 },
  cigarette: { bone: 'RightHand', fist: 0.52 },
};
// 0x1e1917 is linear 0.005 — a fifth of what any leather reflects, and it read as a paper cutout next to his
// hand. 0x342e29 is 2.8 %, black grained calf.
// half-metal steel: a 3 mm latch that is fully metallic has no diffuse at all, so in the figure's own shade it
// rendered as a pure-black square punched out of the case face
// Round 5 measured the sunlit case at RGB (8.4, 7.5, 8.8), sd 1.56, against pavement at 107 — 0.07x and dead
// flat, with no specular anywhere on a leather object in direct 13:00 sun. Three causes, all here: the albedo was
// 0x262220 (linear 0.017 — darker than the shadow it casts; a real black attaché is 30-40/255), the roughness
// came off the `grain` ORM at ~0.9, and the ground-bounce half of the hemisphere was albedo-weighted to nothing.
// 0x37322e + roughness 0.50 + clearcoat 0.30 gives the top face and the lid welt a highlight to catch.
// Round 6: 0x37322e is a WARM dark brown, and against a corrected near-black worsted the case read as an olive
// duffel — the one object in the flagship frame that was the wrong colour outright. HERO.md and the contact
// sheet both say black leather. 0x24242a is linear 0.015, neutral-cool, still above the 0.005 that made it a
// paper cutout in round 5. The value it needs comes from a clearcoat highlight down the lid welt and along the
// bevels, not from albedo: clearcoat 0.55 at roughness 0.18 is polished calf and gives the edges a light line.
// (0x24242a + clearcoat 0.55/0.18 made it a navy mirror: a polished black face at that roughness returns the
// sky almost specularly, and both frames read the case as blue. 0x2a2724 is warm-neutral and 0.38/0.34 keeps a
// broad highlight on the lid welt without turning the front panel into a sky sample.)
// Fix round 2: clearcoat 0.38 / 0.34 put the magenta plaza on the lid — the case read as purple plastic at night.
// 0.15 / 0.5 is waxed calf: a soft sheen on the welt and the bevels, the grain's own normal doing the rest.
function propMats() { return { leather: mat('leather', 0x252321, { roughness: 0.52, clearcoat: 0.15, clearcoatRoughness: 0.5, hemi: 1.6, gnd: 3.2, env: 1.3 }), steel: mat('metal', 0xb4b8c0, { metalness: 0.7, roughness: 0.25, env: 2.0 }) }; }
// A box is a box: a bevelled slab whose edges catch a line of light is the difference between an attaché and a black
// rectangle. The shell is one loft of rounded cross-sections (3 mm corner radius, a lid welt standing 6 mm proud and
// the bulge of a full case), so the front face carries a gradient instead of one dead value, and the side gusset is
// the SAME surface — it used to be a separate box face 11x brighter than the front with nothing in between.
// Fix round 2: a HARD case. The old rows bulged every face 4 mm past its own edges and rolled a 1.7 cm radius into
// the top, so under a single key it shaded like a pillow; and the far end was left open. Rows run from the lid
// (the handle side, d = 0) to the base, +Y down the hand like the prop: crisp 3-4 mm radii, dead-flat faces, a
// 2 mm piped welt round the lid seam and the base, both ends closed.
function caseShell(W, H2, D, top) {
  const rows = [                                            // [d from the lid, inset, corner exponent]
    [0.0, 0.30, 2.0], [0.0, 0.0045, 7.0], [0.0012, 0.0016, 9.0], [0.0035, 0.0003, 11.0], [0.0065, 0.0, 12.0],
    [0.0680, 0.0, 12.0], [0.0690, -0.0020, 12.0], [0.0712, -0.0020, 12.0], [0.0722, 0.0, 12.0],      // lid seam welt
    [0.2900, 0.0, 12.0], [0.2910, -0.0020, 12.0], [0.2932, -0.0020, 12.0], [0.2942, 0.0, 12.0],      // base welt
    [0.2975, 0.0006, 11.0], [0.2992, 0.0022, 9.0], [0.3000, 0.0048, 7.0], [0.3000, 0.30, 2.0],
  ];
  const rings = rows.map(([d, inset, p]) => {
    const hx = Math.max(0.004, W * 0.5 - inset), hz = Math.max(0.01, D * 0.5 - inset);
    return {
      c: new THREE.Vector3(0, top + d * (H2 / 0.3), 0), u: X_AXIS, v: Z_AXIS, rx: hx, ry: hz, w: () => [[0, 1]], uScale: 1,
      shape: (a) => sellipse(a, hx, hz, p),
    };
  });
  const g = loft(rings, { segs: 36, uv: [1, 2.4] });
  g.deleteAttribute('skinIndex'); g.deleteAttribute('skinWeight');
  g.computeVertexNormals();
  return g;
}
// lid -> grip. The grip bar's centre sits just under the group origin (= the measured grip point, see deriveGrip),
// and the lid CASE_ARCH below it. Fix round 2: 4.4 cm put the lid against the bottom of his fist — the scanned
// fingers curl 3 cm under the bar — so no handle showed anywhere and the case read as glued to the knuckles.
// 6.2 cm leaves 2-3 cm of steel loop visible between the fist and the lid.
const CASE_ARCH = 0.062;
// A real attaché handle: a leather-wrapped bar ~11 cm long (four fingers), whose ends turn down into two steel
// loops seated in fittings on the lid. The fist covers the middle; the loops and the fittings are what read.
const HANDLE = { half: 0.056, barY: 0.008, r: 0.0072 };
function caseHandle() {
  const { half, barY, r } = HANDLE, pts = [];
  for (let i = 0; i <= 12; i++) { const z = -half + (2 * half) * (i / 12); pts.push(new THREE.Vector3(0, barY + 0.0035 * (1 - Math.cos((i / 12) * TAU)) * 0.5, z)); }
  const bar = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, r, 8, false);
  bar.scale(1.35, 1, 1);                                   // a wrapped grip is oval, flatter across the palm
  const caps = [-1, 1].map((sg) => { const c = new THREE.SphereGeometry(r, 8, 6); c.scale(1.35, 1, 1); c.translate(0, barY, sg * half); return c; });
  return mergeGeometries([bar, ...caps].map((x) => { if (x.index) return x; return x; }), false);
}
function caseLoops() {
  // steel D-loops: from each bar end down to its fitting on the lid
  const { half, barY } = HANDLE, out = [];
  for (const sg of [-1, 1]) {
    const pts = [new THREE.Vector3(0, barY, sg * (half + 0.004)), new THREE.Vector3(0, barY + 0.012, sg * (half + 0.009)),
      new THREE.Vector3(0, CASE_ARCH - 0.016, sg * (half + 0.006)), new THREE.Vector3(0, CASE_ARCH - 0.003, sg * (half - 0.002))];
    for (const dx of [-0.006, 0.006]) {
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => p.clone().setX(dx))), 10, 0.0021, 6, false);
      out.push(tube);
    }
    const fit = new THREE.BoxGeometry(0.020, 0.0045, 0.016); fit.translate(0, CASE_ARCH - 0.0018, sg * (half - 0.002)); out.push(fit);
  }
  return out;
}
export function makeProp(kind) {
  // black leather attaché: bevelled shell with a lid welt, arched handle on anchor plates, four steel latches. 0.42 x 0.30 x 0.09 m.
  // TWO meshes, not fourteen. Round 4 shipped a shell, a handle, two plates, two anchors and eight latch/tongue
  // boxes — 14 draw calls for a prop the size of a fist, 12 of them for 3 mm hardware that is sub-pixel at every
  // gameplay distance. Merged per material, the way every other slot in this file works.
  if (kind === 'briefcase') {
    const g = new THREE.Group(); g.name = 'prop:briefcase';
    const M = propMats();
    const W = 0.088, H2 = 0.30, D = 0.42, top = CASE_ARCH;                 // hangs down local +Y (= world down at bind)
    // the arch: its bar centre sits at y ≈ 0.006 — i.e. at the group origin, which deriveGrip() put inside his
    // fist. Authored flat the apex landed at +0.002, at the group origin AND at the top of the shell at the same
    // time, so there was no grip point anywhere on the prop and the fingers had nothing to hold.
    const leather = [caseShell(W, H2, D, top), caseHandle()];
    const steel = caseLoops();
    for (const s of [-1, 1]) {
      for (const f of [-1, 1]) {                                           // latch plates with a tongue, both faces
        const l = new THREE.BoxGeometry(0.0032, 0.018, 0.026); l.translate(f * (W * 0.5 + 0.0014), top + 0.070, s * 0.135); steel.push(l);
        const t = new THREE.BoxGeometry(0.0026, 0.010, 0.012); t.translate(f * (W * 0.5 + 0.0033), top + 0.068, s * 0.135); steel.push(t);
      }
    }
    // the hinge: a steel rod along the back of the lid seam
    const hinge = new THREE.CylinderGeometry(0.0022, 0.0022, D * 0.78, 8); hinge.rotateX(HPI); hinge.translate(-(W * 0.5 + 0.0012), top + 0.0705, 0); steel.push(hinge);
    // uv-less steel and a mixed set: give every part the same attribute layout before the merge
    for (const x of steel) if (!x.attributes.uv) x.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2));
    const shell = new THREE.Mesh(mergeGeometries(leather, false), M.leather);
    const hw = new THREE.Mesh(mergeGeometries(steel, false), M.steel);
    leather.forEach((x) => x.dispose()); steel.forEach((x) => x.dispose());
    g.add(shell, hw);
    for (const c of g.children) { c.castShadow = true; c.receiveShadow = true; }
    g.position.fromArray(PROP_SLOTS.briefcase.position);
    g.rotation.fromArray(PROP_SLOTS.briefcase.rotation);
    g.userData.hang = new THREE.Vector3(0, 1, 0);          // hangs down local +Y; update() keeps it pointing at the ground
    return g;
  }
  if (kind === 'phone') {
    const g = new THREE.Group(); g.name = 'prop:phone';
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.14, 0.07), new THREE.MeshStandardMaterial({ color: 0x151518, roughness: 0.35, metalness: 0.4 }));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.062), new THREE.MeshBasicMaterial({ color: 0xcfe4ff }));
    screen.rotation.y = -HPI; screen.rotation.z = HPI; screen.position.x = -0.0041;    // faces the palm side (local -X)
    if (humanoid.engine && humanoid.engine.layers) screen.layers.enable(humanoid.engine.layers.BLOOM);
    g.add(body, screen);
    g.position.fromArray(PROP_SLOTS.phone.position);
    return g;
  }
  if (kind === 'cigarette') {
    const g = new THREE.Group(); g.name = 'prop:cigarette';
    const geo = new THREE.CylinderGeometry(0.004, 0.004, 0.08, 8);
    const col = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < geo.attributes.position.count; i++) { const y = geo.attributes.position.getY(i); const f = y < -0.018; col[i * 3] = f ? 0.85 : 0.96; col[i * 3 + 1] = f ? 0.6 : 0.95; col[i * 3 + 2] = f ? 0.25 : 0.9; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const stick = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    stick.rotation.x = HPI;                                                            // along local +Z (out of the fingers)
    // the ember: HDR orange, so the bloom picks it out at street distance where the 8 mm stick itself is sub-pixel
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, 0.006, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6a14).multiplyScalar(3.2), toneMapped: false }));
    tip.rotation.x = HPI; tip.position.z = 0.042;
    if (humanoid.engine && humanoid.engine.layers) tip.layers.enable(humanoid.engine.layers.BLOOM);
    g.add(stick, tip);
    g.position.fromArray(PROP_SLOTS.cigarette.position);
    return g;
  }
  return null;
}

// ---------------------------------------------------------------- shot presets & self test
// the hero stands in a plain idle with the case hanging at his side: that, the shoulder line and the stance are what
// have to name him from silhouette alone at 6 m
// Idle phases are deliberately coprime-ish: six people breathing in sync is the tell that they are one mannequin
// recoloured. The salaryman's flat A-pose is gone — he stands in idle_combat's weight shift with a hand at his side.
const LINEUP = [['kento', 1, 'idle', 0.0, undefined], ['chinpira', 5, 'taunt', 0.45, null], ['yakuza', 9, 'idle', 0.62, null], ['boss', 13, 'guard', 0.2, null], ['pedestrian', 21, 'phone', 0.5, 'phone'], ['pedestrian', 37, 'smoke', 0.17, 'cigarette']];
let lineup = [];
// fix round 2: every scan in its idle at a neutral phase — the guard and the taunt left the brute in a half-squat
// with his pistol at his chin and the cap man mid-swing, capture poses rather than people. The cast is chapter 1's:
// 健人 and the three チンピラ (nightlife_king is the boss-type scan, out of Plan A; his raised arm is not on his
// skeleton, so no pose can bring it down — ?shot=mob_pose&v=nightlife_king still shows him).
const MOB_LINEUP = [['kento', 1, 'idle', 0.0, undefined], ['enforcer_a', 3, 'idle', 0.08, null],
  ['enforcer_b', 5, 'idle', 0.30, null], ['wanderer', 7, 'idle', 0.55, null]];
// the "fight club" trio as the story stands them: 未空 on the phone, 快 and 天真 idle (?shot=club_lineup)
const CLUB_LINEUP = [['club_miku', 3, 'phone', 0.3, 'phone'], ['club_kai', 5, 'idle', 0.3, null], ['club_tenma', 7, 'idle', 0.6, null]];
function spawnLineup(engine, at = [0, 0, 0], spacing = 1.06, cast = LINEUP) {
  for (const h of lineup) h.dispose();
  lineup = [];
  const x0 = at[0] - spacing * (cast.length - 1) / 2;
  const W = engine.world;
  cast.forEach(([variant, seed, clip, phase, prop], i) => {
    // the cast shot is the one frame built to show the models off: LOD0 bodies, no ladder, feet planted
    const h = createHumanoid({ variant, seed, detail: 1, lod: false, prop });
    const x = x0 + i * spacing, z = at[2];
    // they stand on the crossing, not on y=0: plant() drops the group onto the lowest foot from wherever it is, so
    // the spawn has to start at the ground height under that spot or two of six sink into the asphalt
    const gy = W && typeof W.groundHeight === 'function' ? W.groundHeight(x, z) : at[1];
    h.group.position.set(x, Number.isFinite(gy) ? gy : at[1], z);
    h.group.rotation.y = (i % 2 ? -1 : 1) * (0.05 + 0.06 * ((seed * 7) % 5) / 5);   // nobody stands dead square
    engine.scene.add(h.group);
    // a scan in the cast shot is the body the fight spawns: its fused props (pipe, cane, book, crowbar, bag) culled
    // by enemy.js's own pass, when that module offers it
    if (VARIANTS[variant] && VARIANTS[variant].scan) {
      const en = engine.get && engine.get('enemy');
      try { if (en && typeof en.prepareBody === 'function') en.prepareBody(h, variant, null); } catch (e) { void e; }
    }
    if (humanoid.getClip) h.pose(clip, phase);
    h.plant();
    // the decal written now, in the final pose on the final ground (a frozen body only rewrites it when it moves)
    if (h.contact) { h.group.updateMatrixWorld(true); updateContact(h, engine); }
    lineup.push(h);
  });
  return lineup;
}
// single hero in bind pose (no clip dependency) for a stable head-and-shoulders / full-body review frame
let hero = null;
function spawnHero(engine, variant = 'kento', at = [0, 0, 0], yaw = 0.35, prop = null, clip = null, phase = 0) {
  for (const h of lineup) h.dispose();
  lineup = [];
  hero = createHumanoid({ variant, seed: 1, detail: 1 });
  hero.group.position.set(...at); hero.group.rotation.y = yaw;
  engine.scene.add(hero.group);
  if (prop) hero.setProp(prop);
  if (clip && humanoid.getClip && humanoid.getClip(clip)) hero.pose(clip, phase);
  lineup.push(hero);
  return hero;
}
const varQ = () => { const v = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('v') : null; return VARIANTS[v] ? v : 'yakuza'; };
// the five PROCEDURAL variants only (the scanned hero is not in this frame): the cast's own faces, side by side
const CAST = [['yakuza', 9], ['chinpira', 5], ['boss', 13], ['pedestrian', 21], ['pedestrian', 37]];
function spawnCast(engine, spacing = 0.6) {
  for (const h of lineup) h.dispose();
  lineup = [];
  const x0 = -spacing * (CAST.length - 1) / 2, W = engine.world;
  CAST.forEach(([variant, seed], i) => {
    const h = createHumanoid({ variant, seed, detail: 1, lod: false });
    const x = x0 + i * spacing;
    const gy = W && typeof W.groundHeight === 'function' ? W.groundHeight(x, 0) : 0;
    h.group.position.set(x, Number.isFinite(gy) ? gy : 0, 0);
    h.group.rotation.y = (i - 2) * 0.05;
    engine.scene.add(h.group);
    if (humanoid.getClip) h.pose('idle', 0);
    h.plant();
    lineup.push(h);
  });
  humanoid.keyBoost = 1.35;
  return lineup;
}
// the eight outfit templates on both frames: men in the front row, women behind, every hair style and colour in the
// cycle. ?shot=pedestrian_lineup[&anim=walk&phase=0.25&seed0=300&det=1] — the frame the crowd's near bodies are judged in
function spawnPedestrians(engine, spacing = 0.56, rowZ = 0.45) {
  for (const h of lineup) h.dispose();
  lineup = [];
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
  const clip = q.get('anim') || 'idle', ph = parseFloat(q.get('phase') || '0') || 0, s0 = parseInt(q.get('seed0') || '300', 10), det = parseFloat(q.get('det') || '1') || 1;
  const W = engine.world, colours = Object.keys(PED_HAIR_COLORS);
  PED_OUTFITS.forEach((outfit, i) => {
    [[false, rowZ, 0], [true, -rowZ, 400]].forEach(([fem, z, so]) => {
      const hair = PED_HAIRS[(i + (fem ? 3 : 0)) % PED_HAIRS.length], hairColor = colours[(i * 2 + (fem ? 1 : 0)) % colours.length];
      const h = createHumanoid({ variant: 'pedestrian', seed: s0 + so + i * 37, detail: det, lod: false, outfit, fem, hair, hairColor });
      const x = -spacing * (PED_OUTFITS.length - 1) / 2 + i * spacing;
      const gy = W && typeof W.groundHeight === 'function' ? W.groundHeight(x, z) : 0;
      h.group.position.set(x, Number.isFinite(gy) ? gy : 0, z);
      h.group.rotation.y = (i % 2 ? -1 : 1) * 0.06;
      engine.scene.add(h.group);
      if (humanoid.getClip && humanoid.getClip(clip)) h.pose(clip, (ph + i * 0.13 + (fem ? 0.5 : 0)) % 1);
      h.plant();
      lineup.push(h);
    });
  });
  return lineup;
}
const pedPreset = (pos, look, fov, spacing, rowZ) => ({ engine: e0 } = {}) => {
  const raw = (e0 && e0.params && e0.params.raw) || {}, v3 = (s, d) => (s && s.split(',').length === 3 ? s.split(',').map(Number) : d);
  return { pos: v3(raw.cam, pos), lookAt: v3(raw.look, look), t: 'night', fov: Number(raw.fov) || fov, setup(engine) { hideCrowd(engine); spawnPedestrians(engine, spacing, rowZ); } };
};
// character-review frames only: drop the crowd so nothing walks between the camera and the model (debug preset, not gameplay)
function hideCrowd(engine) {
  humanoid.hideCrowd = true;                     // crowd re-binds its LOD0 bodies every frame, so update() re-hides them
  hideTraffic(engine);
  applyHideCrowd(engine);
}
function applyHideCrowd(engine) {
  try {
    // ('crowd:' — crowd.js's own meshes; 'crowdScan' — its scanned-crowd root, crowdScan.js)
    for (const o of engine.scene.children) if (o.visible && o.name && (o.name.startsWith('crowd:') || o.name.startsWith('crowdScan'))) o.visible = false;
    // Matching on the scene-graph name missed crowd.js's LOD0 pool entirely: those three bodies are THIS module's
    // own `pedestrian` variant, created through createHumanoid and named humanoidGroup:pedestrian, and they walked
    // through every cast frame the module shot. Anything in humanoid.all that the preset did not spawn goes.
    for (const h of humanoid.all) if (h.group.visible && !lineup.includes(h)) h.group.visible = false;
  } catch (e) { void e; }
}
// …and the traffic. `spawnLineup` stages the cast at world origin, which is the middle of the scramble, which is
// where traffic.js parks: a blue van filled the centre 60 % of the critic's frame and cropped three of the six
// cast members at the chest. A review preset is allowed to empty the road.
function hideTraffic(engine) {
  for (const n of ['traffic', 'crowd']) {
    try {
      const m = engine.get && engine.get(n);
      for (const k of ['root', 'group', 'container']) if (m && m[k] && m[k].isObject3D) { m[k].visible = false; break; }
    } catch (e) { void e; }
  }
}
// The character key + rim now ships inside createHumanoid (gameplay included). Tight review crops just push it a stop
// hotter and widen the falloff so a 30 cm frame is still lit.
function portraitFill(h) {
  humanoid.keyBoost = 1.45;                        // the key is global now: a tight crop pushes it a stop, for everyone in frame
  return h;
}
// ?anim=<clip>&phase=<0..1> on any character_pose* preset: the hero frozen at that phase, so the skin weights can be
// read against the bind pose. Without them he stands in idle.
function posed(engine, yaw) {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
  const h = spawnHero(engine, 'kento', [0, 0, 0], yaw, q.get('prop') === '0' ? null : 'briefcase');
  const clip = q.get('anim') || 'idle';
  if (humanoid.getClip && humanoid.getClip(clip)) h.pose(clip, parseFloat(q.get('phase') || '0') || 0);
  return h;
}
// the cast / hero alone in a clip (mobPosed's url), a lens that ?cam / ?look / ?fov may move; the body is NOT planted
// when the clip is a floor clip (floorFit already sits it on the ground)
function castPreset(v, cam, look, fov) {
  return ({ engine }) => {
    const raw = (engine && engine.params && engine.params.raw) || {}, v3 = (s, d) => (s && s.split(',').length === 3 ? s.split(',').map(Number) : d);
    return { pos: v3(raw.cam, cam), lookAt: v3(raw.look, look), t: raw.t || 'night', fov: Number(raw.fov) || fov, setup(eng) { hideCrowd(eng || engine); mobPosed(eng || engine, v); } };
  };
}
function mobPosed(engine, force = null) {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
  const v = force || (VARIANTS[q.get('v')] ? q.get('v') : 'enforcer_a');
  const h = spawnHero(engine, v, [0, 0, 0], parseFloat(q.get('yaw') || '0') || 0, v === 'kento' && q.get('prop') !== '0' ? 'briefcase' : null);
  if (q.get('prop') === '0') h.setProp(null);
  const clip = q.get('anim') || (force ? 'idle' : 'idle_combat');
  // walk/run: stand on the ground as in play — planting the frame itself pulls a run's flight phase down into a lunge
  if ((clip === 'walk' || clip === 'run') && humanoid.getClip && humanoid.getClip('idle')) { h.pose('idle', 0); h.plant(); h.pose(clip, parseFloat(q.get('phase') || '0') || 0); return h; }
  if (humanoid.getClip && humanoid.getClip(clip)) h.pose(clip, parseFloat(q.get('phase') || (force ? '0' : '0.3')) || 0);
  if (!force || !FLOOR_CLIPS.has(clip)) h.plant();
  return h;
}
// ?shot=ped_lineup: the client's 19 passers-by (docs/PEDS.md) on the crossing at night, LOD0, idle — two staggered rows
// (the first ten in front, the other nine a metre behind and between them), the front row 3.2 m from the lens.
//   &anim=walk&phase=0.25   everyone in that clip at that phase (each a little off the next, so the row is not in step
//                           unless &sync=1)
//   &set=1 | &set=2         one straight row only (the first ten / the other nine), for a clear look at every body
//   &v=<key>                one of them alone, close up, front (&yaw=180 the back, &yaw=90 their left side; degrees)
//   &v=<key>&sheet=1        that one four times: idle, walk (front), walk (their right side), walk (back)
//   &v=<key>&sheet=side     that one six times from the side (posture): idle, walk 0 / 0.25 / 0.5 / 0.75, run 0.25
//   &part=lod1 | lod2       the crowd's far rungs instead of lod0
//   &poolMat=1              each body in the crowd's own pool material (crowdScan.js), exactly as the live crowd draws it
//   &cam=x,y,z&look=x,y,z&fov=n   move the lens
// The scans load lazily (pedScansReady); the row is stood up the moment they are in, a second or two after __ready.
// &crowdPose=1: pose exactly as the live crowd does (crowdScan.js poseBody / bake): the clip through the mixer alone, then
// each bone group slerped part of the way back to the scan's own bind (its TUNE table, copied here) and the wrist clamp
// — none of pose()'s arm hang or weight shift, which a crowd body never runs
const CROWD_TUNE = { walk: { legs: 0.24, arms: 0.30, spine: 0.30 }, idle: { legs: 0.50, arms: 0.55, spine: 0.35 } };
const CROWD_TUNE_BONES = { legs: ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'],
  arms: ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'], spine: ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head'] };
function crowdPosed(h, clip, phase) {
  const bindQ = {}, hip = h.bones.Hips.position.clone();
  for (const n of BONE_NAMES) bindQ[n] = h.bones[n].quaternion.clone();
  const action = h.play(clip, { fade: 0, loop: true, force: true }); if (!action) return;
  h.mixer.update(0); action.time = clamp(phase, 0, 0.999) * action.getClip().duration; h.mixer.update(0);
  gaitPose(h, h.gait, clip);
  const T = CROWD_TUNE[clip];
  if (T) {
    for (const g of ['legs', 'arms', 'spine']) for (const n of CROWD_TUNE_BONES[g]) h.bones[n].quaternion.slerp(bindQ[n], T[g]);
    h.bones.Hips.position.lerp(hip, T.legs);
  }
  clampHands(h);
  h.frozenPose = true;
  h.group.updateMatrixWorld(true);
}
const PED_Q = () => (typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams(''));
function spawnPedLineup(engine) {
  const q = PED_Q(), clip = q.get('anim') || 'idle', ph0 = parseFloat(q.get('phase') || '0') || 0, sync = q.get('sync') === '1';
  const part = ['lod0', 'lod1', 'lod2'].includes(q.get('part')) ? q.get('part') : 'lod0', set = q.get('set'), one = q.get('v');
  const yaw = (parseFloat(q.get('yaw') || '0') || 0) * Math.PI / 180;
  pedScansReady().then(() => {
    for (const h of lineup) h.dispose();
    lineup = [];
    let cast = PED_SCANS.map((p, i) => ({ p, i }));
    const sheet = one && (q.get('sheet') === '1' || q.get('sheet') === 'side');
    if (one) cast = cast.filter((c) => c.p.key === one || c.p.variant === one);
    const SHEET = q.get('sheet') === 'side' ? [['idle', ph0, HPI], ['walk', 0, HPI], ['walk', 0.25, HPI], ['walk', 0.5, HPI], ['walk', 0.75, HPI], ['run', 0.25, HPI]]
      : [['idle', ph0, 0], ['walk', 0.25, 0], ['walk', 0.62, Math.PI / 2], ['walk', 0.25, Math.PI]];
    if (sheet && cast.length) cast = SHEET.map(() => cast[0]);
    else if (set === '1') cast = cast.slice(0, 10);
    else if (set === '2') cast = cast.slice(10);
    const W = engine.world, rows = !one && !set;
    cast.forEach(({ p, i }, k) => {
      if (!pedScanReady(p.key)) { console.warn('[humanoid] ped_lineup: scan not loaded', p.key); return; }
      const h = createHumanoid({ variant: p.variant, seed: 11 + i * 7, detail: 1, lod: false, part });
      let x = 0, z = 0;
      if (rows) { const back = k >= 10, j = back ? k - 10 : k; x = (j - 4.5) * 0.62 + (back ? 0.31 : 0); z = back ? -1.3 : 0; }
      else if (!one) { x = (k - (cast.length - 1) / 2) * 0.60; }
      else if (sheet) x = (k - (SHEET.length - 1) / 2) * (SHEET.length > 4 ? 0.78 : 0.95);
      const gy = W && typeof W.groundHeight === 'function' ? W.groundHeight(x, z) : 0;
      h.group.position.set(x, Number.isFinite(gy) ? gy : 0, z);
      h.group.rotation.y = sheet ? SHEET[k][2] + yaw : one ? yaw : ((k % 2 ? -1 : 1) * 0.06);
      engine.scene.add(h.group);
      if (q.get('crowdPose') === '1') crowdPosed(h, sheet ? SHEET[k][0] : clip, sheet ? SHEET[k][1] : sync || one ? ph0 : (ph0 + k * 0.137) % 1);
      else if (sheet) h.pose(SHEET[k][0], SHEET[k][1]);
      else if (humanoid.getClip && humanoid.getClip(clip)) h.pose(clip, sync || one ? ph0 : (ph0 + k * 0.137) % 1);
      h.plant();
      if (h.contact) { h.group.updateMatrixWorld(true); updateContact(h, engine); }
      lineup.push(h);
    });
    if (PED_DBG) console.info('[humanoid] ped_lineup', lineup.map((h) => `${h.ped}:${h.tris}:${h.height.toFixed(2)}`).join(' '));
    if (q.get('pedAudit') === '1') for (const h of lineup) pedAudit(h, clip + ':' + (sync || one ? ph0 : '*'));
    if (q.get('poolMat') === '1') {
      // (a debug frame only: the crowd's scan renderer builds its per-scan sources a little after load)
      const dress = (tries) => {
        const R = engine.get && engine.get('crowd') && engine.get('crowd').scanR;
        if (!R || !R.S || !R.S.length || typeof R.scanMaterial !== 'function') { if (tries > 0) setTimeout(() => dress(tries - 1), 500); else console.warn('[humanoid] poolMat: no crowd scan renderer'); return; }
        for (const h of lineup) {
          const S = R.S.find((x) => x.key === h.ped); if (!S) continue;
          const mat = R.scanMaterial(S, 'pool', { uRim: { value: new THREE.Vector3() } });
          for (const m of h.meshes) m.material = mat;
        }
        console.info('[humanoid] poolMat on', lineup.length);
      };
      dress(40);
    }
  });
}
// ?shot=ped_lineup&pedAudit=1: for every body in the frame, in the pose it is standing in (the clip AND the runtime's own
// arm hang and weight shift), the places where the surface came apart: two points of the bind mesh within 4 mm of
// each other (a split weld, seams.mjs) that the pose has pulled more than 1.5 cm apart — a window the patch behind it
// now shows through. Logged per scan: count, the worst gap, and the worst places by bone pair.
const _pa = new THREE.Vector3();
function pedAudit(h, tag) {
  const m = h.skinned, g = m.geometry, P = g.attributes.position, si = g.attributes.skinIndex, n = P.count;
  h.group.updateMatrixWorld(true); m.skeleton.update();
  const Q = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { m.getVertexPosition(i, _pa); Q[i * 3] = _pa.x; Q[i * 3 + 1] = _pa.y; Q[i * 3 + 2] = _pa.z; }
  const cell = 0.004, grid = new Map(), key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < n; i++) { const k = key(P.getX(i), P.getY(i), P.getZ(i)); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(i); }
  const cl = new Map(); let cnt = 0, worst = 0;
  for (let i = 0; i < n; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i), cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const l = grid.get(`${cx + a},${cy + b},${cz + c}`); if (!l) continue;
      for (const j of l) {
        if (j <= i) continue;
        const d0 = Math.hypot(P.getX(j) - x, P.getY(j) - y, P.getZ(j) - z); if (d0 > 0.004) continue;
        const d1 = Math.hypot(Q[i * 3] - Q[j * 3], Q[i * 3 + 1] - Q[j * 3 + 1], Q[i * 3 + 2] - Q[j * 3 + 2]) - d0;
        if (d1 < 0.015) continue;
        cnt++; if (d1 > worst) worst = d1;
        const bn = [BONE_NAMES[si.getX(i)], BONE_NAMES[si.getX(j)]].sort().join('+') + '@' + [x, y, z].map((v) => Math.round(v * 10) / 10).join(',');
        const e = cl.get(bn) || { n: 0, max: 0 }; e.n++; e.max = Math.max(e.max, d1); cl.set(bn, e);
      }
    }
  }
  const top = [...cl.entries()].sort((p, q) => q[1].max * Math.sqrt(q[1].n) - p[1].max * Math.sqrt(p[1].n)).slice(0, 5).map(([k, e]) => `${k} n${e.n} ${(e.max * 100).toFixed(1)}cm`);
  console.info(`[pedAudit] ${h.ped} ${h.part} ${tag} openings ${cnt} worst ${(worst * 100).toFixed(1)}cm | ${top.join(' | ')}`);
}
const pedLineupPreset = ({ engine } = {}) => {
  const raw = (engine && engine.params && engine.params.raw) || {}, v3 = (s2, d) => (s2 && s2.split(',').length === 3 ? s2.split(',').map(Number) : d);
  const q = PED_Q(), one = q.get('v'), set = q.get('set'), sheet = one && (q.get('sheet') === '1' || q.get('sheet') === 'side'), side = sheet && q.get('sheet') === 'side';
  const pos = side ? [0, 0.95, 5.6] : sheet ? [0, 1.0, 4.2] : one ? [0, 1.02, 3.0] : set ? [0, 1.25, 4.6] : [0, 1.45, 3.35];
  const look = sheet ? [0, 0.86, 0] : one ? [0, 0.86, 0] : set ? [0, 0.88, 0] : [0, 0.86, -0.4];
  const fov = side ? 30 : sheet ? 30 : one ? 40 : set ? 44 : 60;
  return { pos: v3(raw.cam, pos), lookAt: v3(raw.look, look), t: raw.t || 'night', fov: Number(raw.fov) || fov, setup(eng) { hideCrowd(eng || engine); spawnPedLineup(eng || engine); } };
};
export const shotPresets = {
  ped_lineup: pedLineupPreset,
  // 1.6 m west of the origin: at dead centre the third and fourth cast members stand directly in front of the
  // TSUTAYA sign, and a 2 m² of yellow emissive right behind a head is not a frame anyone can judge skin on.
  // Fix round 1: the cast shot is the client's four street scans beside the hero. The procedural cast (lofted heads
  // on a 512² face atlas) stood PS2-era next to a 2048² scan at 4.8 m and is kept for the crowd's LOD0 pool only;
  // character_lineup_proc still shows it.
  character_lineup: { pos: [-1.6, 1.35, 5.8], lookAt: [-1.6, 0.98, 0], t: 'night', fov: 38, setup(engine) { hideCrowd(engine); spawnLineup(engine, [-1.6, 0, 0], 1.14, MOB_LINEUP); } },
  character_lineup_day: { pos: [-1.6, 1.35, 5.8], lookAt: [-1.6, 0.98, 0], t: 'day', fov: 38, setup(engine) { hideCrowd(engine); spawnLineup(engine, [-1.6, 0, 0], 1.14, MOB_LINEUP); } },
  character_lineup_proc: { pos: [-1.6, 1.35, 5.8], lookAt: [-1.6, 0.98, 0], t: 'night', fov: 38, setup(engine) { hideCrowd(engine); spawnLineup(engine, [-1.6, 0, 0]); } },
  character_faces: { pos: [0.1, 1.72, 1.55], lookAt: [0, 1.66, 0], t: 'night', fov: 30, setup(engine) { hideCrowd(engine); spawnLineup(engine, [0, 0, 0], 0.42); } },
  // the client's four street scans next to the hero, and the same five in daylight
  mob_lineup: { pos: [-1.6, 1.35, 5.4], lookAt: [-1.6, 0.98, 0], t: 'night', fov: 38, setup(engine) { hideCrowd(engine); spawnLineup(engine, [-1.6, 0, 0], 1.14, MOB_LINEUP); } },
  mob_lineup_day: { pos: [-1.6, 1.35, 5.4], lookAt: [-1.6, 0.98, 0], t: 'day', fov: 38, setup(engine) { hideCrowd(engine); spawnLineup(engine, [-1.6, 0, 0], 1.14, MOB_LINEUP); } },
  mob_faces: { pos: [-1.6, 1.68, 2.0], lookAt: [-1.6, 1.60, 0], t: 'day', fov: 32, setup(engine) { hideCrowd(engine); spawnLineup(engine, [-1.6, 0, 0], 0.46, MOB_LINEUP); } },
  // one scan on its own in a clip: ?shot=mob_pose&v=enforcer_a&anim=hook&phase=0.5&yaw=0.6 (yaw turns the body, the
  // camera stays) — the frame the torn-seam repair is judged in, in motion rather than in the bind pose
  // &cam=x,y,z&look=x,y,z&fov=n move the lens for a macro of one seam
  mob_pose: ({ engine }) => {
    const raw = (engine && engine.params && engine.params.raw) || {}, v3 = (s, d) => (s && s.split(',').length === 3 ? s.split(',').map(Number) : d);
    return { pos: v3(raw.cam, [0, 1.25, 3.3]), lookAt: v3(raw.look, [0, 0.95, 0]), t: 'night', fov: Number(raw.fov) || 38, setup(eng) { hideCrowd(eng || engine); mobPosed(eng || engine); } };
  },
  mob_pose_back: { pos: [0, 1.25, -3.3], lookAt: [0, 0.95, 0], t: 'night', fov: 38, setup(engine) { hideCrowd(engine); mobPosed(engine); } },
  // 柊 誠司 (the client's Meshy model, docs/ref/hiiragi-model.glb): the face at night, and the whole man. Both take
  // mob_pose's &anim=<clip>&phase=<0..1>&yaw=<rad>&cam=x,y,z&look=x,y,z&fov=n (default: idle at 0, facing the lens).
  // For a clip in motion: ?shot=mob_pose&v=hiiragi&anim=jab&phase=0.5
  // the "fight club" trio at close range, night (&t=day for daylight): whole bodies, then their faces
  club_lineup: { pos: [0, 1.35, 3.6], lookAt: [0, 1.0, 0], t: 'night', fov: 38, setup(engine) { hideCrowd(engine); spawnLineup(engine, [0, 0, 0], 0.95, CLUB_LINEUP); } },
  club_faces: { pos: [0, 1.66, 1.75], lookAt: [0, 1.58, 0], t: 'night', fov: 34, setup(engine) { hideCrowd(engine); spawnLineup(engine, [0, 0, 0], 0.5, CLUB_LINEUP); } },
  hiiragi_closeup: castPreset('hiiragi', [0.16, 1.70, 0.98], [0, 1.635, 0], 26),
  hiiragi_body: castPreset('hiiragi', [1.2, 1.3, 4.3], [0, 0.9, 0], 36),
  // the hero the same way (v2 by default, ?hero=v1 for the previous one): face, and whole body
  hero_closeup: castPreset('kento', [0.16, 1.70, 0.98], [0, 1.635, 0], 26),
  hero_body: castPreset('kento', [1.2, 1.3, 4.3], [0, 0.9, 0], 36),
  mob_pose_side: { pos: [3.1, 1.25, 0.6], lookAt: [0, 0.95, 0], t: 'night', fov: 38, setup(engine) { hideCrowd(engine); mobPosed(engine); } },
  // 8 outfits x 2 sexes at 3 m, night (see spawnPedestrians); _faces frames the front row's heads, _back turns them round.
  // &cam=x,y,z&look=x,y,z&fov=n move the lens
  pedestrian_lineup: pedPreset([0, 1.32, 3.9], [0, 0.98, -0.4], 40, 0.56, 0.45),
  pedestrian_faces: pedPreset([0, 1.66, 2.45], [0, 1.58, 0.45], 34, 0.44, 0.45),
  pedestrian_faces_f: pedPreset([0, 1.60, 2.45], [0, 1.50, 0.45], 34, 0.44, -0.45),
  pedestrian_back: pedPreset([0, 1.32, -3.9], [0, 0.98, 0.4], 40, 0.56, 0.45),
  // the crowd's pool bodies as crowd.js builds them (pedestrian, detail 0.5, no ladder), eight seeds in a row:
  // ?shot=ped_pool&det=0.5&anim=walk&phase=0.25&yaw=3.14 (yaw turns them, the lens stays)
  ped_pool: ({ engine: e0 } = {}) => { const raw = (e0 && e0.params && e0.params.raw) || {}, v3 = (s, d) => (s && s.split(',').length === 3 ? s.split(',').map(Number) : d);
    return { pos: v3(raw.cam, [0, 1.3, 6.2]), lookAt: v3(raw.look, [0, 0.95, 0]), t: 'night', fov: Number(raw.fov) || 40, setup(engine) {
    hideCrowd(engine);
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
    const det = parseFloat(q.get('det') || '0.5') || 0.5, yaw = parseFloat(q.get('yaw') || '0') || 0, s0 = parseInt(q.get('seed0') || '4100', 10);
    for (const h of lineup) h.dispose();
    lineup = [];
    for (let i = 0; i < 8; i++) {
      const h = createHumanoid({ variant: q.get('v') || 'pedestrian', seed: s0 + i * 1373, detail: det, lod: false, fem: q.get('fem') === '1' });
      h.group.position.set(-3.5 + i, 0, 0); h.group.rotation.y = yaw;
      engine.scene.add(h.group);
      if (humanoid.getClip) h.pose(q.get('anim') || 'walk', parseFloat(q.get('phase') || '0.25') || 0);
      h.plant(); lineup.push(h);
    }
  } }; },
  // the crowd's scan civilians (civDress) walking, two of each scan in sample clothes:
  // ?shot=civ_pool&anim=walk&phase=0.25&yaw=0&cam=x,y,z&look=x,y,z&fov=n
  civ_pool: ({ engine: e0 } = {}) => { const raw = (e0 && e0.params && e0.params.raw) || {}, v3 = (s, d) => (s && s.split(',').length === 3 ? s.split(',').map(Number) : d);
    return { pos: v3(raw.cam, [0, 1.35, 6.4]), lookAt: v3(raw.look, [0, 1.0, 0]), t: 'night', fov: Number(raw.fov) || 40, setup(engine) {
    hideCrowd(engine);
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
    const yaw = parseFloat(q.get('yaw') || '0') || 0;
    for (const h of lineup) h.dispose();
    lineup = [];
    const C = (hex) => new THREE.Color(hex);
    const looks = [['enforcer_b', 0x2a2d35, 0x2a2d35, 0xe8e6e0], ['enforcer_a', 0x303a2e, 0x1e2230, 0x6a6e78], ['wanderer', 0x4a3a2c, 0x2c2c30, 0x8a8f96],
      ['enforcer_b', 0x4a4c52, 0x3a3c42, 0x9fb4d0], ['enforcer_a', 0x18181a, 0x3a4a78, 0xb8b0a0], ['wanderer', 0x1d2a44, 0x4a4b4f, 0x5a1f22]];
    looks.forEach(([v, top, bot, inn], i) => {
      const h = createHumanoid({ variant: v, seed: 4100 + i * 1373, detail: 1, lod: true, civ: true });
      if (h.civ) h.civ.dress(C(top), C(bot), C(inn), [1, 1, 1]);
      h.group.position.set(-2.9 + i * 1.16, 0, 0); h.group.rotation.y = yaw;
      engine.scene.add(h.group);
      if (humanoid.getClip) h.pose(q.get('anim') || 'walk', ((parseFloat(q.get('phase') || '0.25') || 0) + i * 0.17) % 1);
      h.plant(); lineup.push(h);
    });
  } }; },
  // one procedural variant on his own, isolated from the cast: ?shot=character_var&v=yakuza|boss|chinpira|pedestrian
  character_var: { pos: [0.12, 1.52, 3.15], lookAt: [0, 1.06, 0], t: 'day', fov: 36, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, varQ(), [0, 0, 0], 0.06, null, 'idle', 0)); } },
  character_var_torso: { pos: [0.35, 1.36, 1.35], lookAt: [0, 1.24, 0], t: 'day', fov: 32, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, varQ(), [0, 0, 0], 0.16, null, 'idle', 0)); } },
  character_var_face: { pos: [0.22, 1.685, 1.02], lookAt: [0, 1.578, 0], t: 'day', fov: 26, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, varQ(), [0, 0, 0], 0.1)); } },
  character_var_face_night: { pos: [0.22, 1.685, 1.02], lookAt: [0, 1.578, 0], t: 'night', fov: 26, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, varQ(), [0, 0, 0], 0.1)); } },
  // the five procedural heads side by side at a readable size — the frame the cast's faces are judged in
  character_heads: { pos: [0, 1.66, 2.35], lookAt: [0, 1.60, 0], t: 'day', fov: 30, setup(engine) { hideCrowd(engine); spawnCast(engine, 0.60); } },
  character_heads_night: { pos: [0, 1.66, 2.35], lookAt: [0, 1.60, 0], t: 'night', fov: 30, setup(engine) { hideCrowd(engine); spawnCast(engine, 0.60); } },
  // the grip macro: his LEFT hand closed on the attaché handle, half a metre out
  character_hands: { pos: [0.70, 0.99, 0.56], lookAt: [0.28, 0.86, 0.03], t: 'day', fov: 28, setup(engine) { hideCrowd(engine); spawnHero(engine, 'kento', [0, 0, 0], 0, 'briefcase'); } },
  character_hands_free: { pos: [-0.66, 0.96, 0.58], lookAt: [-0.38, 0.85, 0.02], t: 'day', fov: 28, setup(engine) { hideCrowd(engine); spawnHero(engine, 'kento', [0, 0, 0], 0); } },
  character_hands_open: { pos: [-0.66, 0.96, 0.58], lookAt: [-0.38, 0.85, 0.02], t: 'day', fov: 28, setup(engine) { hideCrowd(engine); spawnHero(engine, 'pedestrian', [0, 0, 0], 0); } },
  character_back: { pos: [0, 1.4, -5.5], lookAt: [0, 0.98, 0], t: 'day', fov: 38, setup(engine) { hideCrowd(engine); spawnLineup(engine, [0, 0, 0]); } },
  // fix round 2: in his idle (the stance overlay only runs on a clip), not the bind A-pose
  character_hero: { pos: [0.9, 1.62, 1.9], lookAt: [0, 1.42, 0], t: 'night', fov: 32, setup(engine) { hideCrowd(engine); spawnHero(engine, 'kento', [0, 0, 0], 0.35, null, 'idle', 0).plant(); } },
  character_hero_day: { pos: [0.9, 1.62, 1.9], lookAt: [0, 1.42, 0], t: 'day', fov: 32, setup(engine) { hideCrowd(engine); spawnHero(engine, 'kento', [0, 0, 0], 0.35); } },
  character_hero_body: { pos: [1.6, 1.3, 3.6], lookAt: [0, 0.95, 0], t: 'day', fov: 34, setup(engine) { hideCrowd(engine); spawnHero(engine, 'kento', [0, 0, 0], 0.35); } },
  character_feet: { pos: [0.7, 0.45, 1.5], lookAt: [0, 0.12, 0], t: 'day', fov: 30, setup(engine) { hideCrowd(engine); spawnLineup(engine, [0, 0, 0], 0.5); } },
  // the reference-photo frame: 渋沢 健人 straight on, briefcase in the left hand
  character_kento: { pos: [0.12, 1.52, 3.15], lookAt: [0, 1.06, 0], t: 'night', fov: 36, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, 'kento', [0, 0, 0], 0.06, 'briefcase')); } },
  character_kento_day: { pos: [0.12, 1.52, 3.15], lookAt: [0, 1.06, 0], t: 'day', fov: 36, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, 'kento', [0, 0, 0], 0.06, 'briefcase')); } },
  character_kento_face: { pos: [0.22, 1.685, 1.06], lookAt: [0, 1.565, 0], t: 'night', fov: 26, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, 'kento', [0, 0, 0], 0.1)); } },
  character_kento_face_day: { pos: [0.22, 1.685, 1.06], lookAt: [0, 1.565, 0], t: 'day', fov: 26, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, 'kento', [0, 0, 0], 0.1)); } },
  character_kento_torso: { pos: [0.35, 1.36, 1.35], lookAt: [0, 1.22, 0], t: 'day', fov: 32, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, 'kento', [0, 0, 0], 0.2, 'briefcase')); } },
  character_kento_hair: { pos: [0.55, 2.02, 0.92], lookAt: [0, 1.66, 0], t: 'day', fov: 28, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, 'kento', [0, 0, 0], 0.15)); } },
  character_kento_watch: { pos: [-0.66, 1.06, 0.62], lookAt: [-0.40, 0.92, 0.0], t: 'day', fov: 26, setup(engine) { hideCrowd(engine); portraitFill(spawnHero(engine, 'kento', [0, 0, 0], 0.1)); } },
  // the LOD ladder: LOD0 to 8 m, LOD1 to 20 m, LOD2 beyond. Two frames either side of each switch.
  character_lod_mid: { pos: [3.2, 2.2, 11.5], lookAt: [0, 1.0, 0], t: 'day', fov: 20, setup(engine) { hideCrowd(engine); spawnHero(engine, 'kento', [0, 0, 0], 0.3, 'briefcase'); } },
  character_lod_far: { pos: [6.5, 3.6, 23.5], lookAt: [0, 1.0, 0], t: 'day', fov: 10, setup(engine) { hideCrowd(engine); spawnHero(engine, 'kento', [0, 0, 0], 0.3, 'briefcase'); } },
  // deformation review: ?shot=character_pose&anim=hook&phase=0.55 — the auto-skinned scan under a posed clip
  character_pose: { pos: [1.85, 1.30, 2.55], lookAt: [0, 1.02, 0], t: 'day', fov: 40, setup(engine) { hideCrowd(engine); posed(engine, 0.45); } },
  character_pose_front: { pos: [0.1, 1.30, 3.1], lookAt: [0, 1.02, 0], t: 'day', fov: 40, setup(engine) { hideCrowd(engine); posed(engine, 0); } },
  character_pose_shoulder: { pos: [0.95, 1.55, 1.25], lookAt: [0.05, 1.33, 0], t: 'day', fov: 34, setup(engine) { hideCrowd(engine); posed(engine, 0.5); } },
  character_pose_hip: { pos: [1.1, 1.05, 1.5], lookAt: [0, 0.88, 0], t: 'day', fov: 36, setup(engine) { hideCrowd(engine); posed(engine, 0.5); } },
  // fight start: the case is set down at his feet
  character_kento_drop: { pos: [1.45, 1.55, 3.0], lookAt: [0.3, 0.62, 0.12], t: 'day', fov: 40, setup(engine) { hideCrowd(engine); const h = portraitFill(spawnHero(engine, 'kento', [0, 0, 0], 0.25, 'briefcase')); h.dropProp(engine.scene); if (humanoid.getClip) h.pose('idle_combat', 0); } },
};
// Skinning regression guard: run the mesh through the clips on the CPU and measure how far each triangle edge is
// stretched against its bind length. A vertex on the wrong bone shows up as a 3-5x edge long before it is visible
// in a screenshot, and it is exactly what went wrong when the scan was first auto-skinned (his fists were welded
// into the coat by the scanner, so a strip of wool travelled with the punch).
const STRETCH_DBG = typeof location !== 'undefined' && location.search.includes('stretchDbg') ? [] : null;
function maxStretch(h, clips = ['idle', 'walk', 'hook', 'knockdown', 'guard']) {
  const mesh = h.skinned, geo = mesh.geometry, pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  if (!si || !sw || !geo.index) return null;
  const sk = h.skeleton, n = pos.count;
  const bind = new Float32Array(n * 3), cur = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { bind[i * 3] = pos.getX(i); bind[i * 3 + 1] = pos.getY(i); bind[i * 3 + 2] = pos.getZ(i); }
  const M = new THREE.Matrix4(), v = new THREE.Vector3(), t = new THREE.Vector3();
  const idx = geo.index.array, step = Math.max(1, Math.floor(idx.length / 3 / 4000));
  let worst = 0, over = 0, worstClip = null, worstAt = null, worstBones = null;
  for (const name of clips) {
    if (!humanoid.getClip || !humanoid.getClip(name)) continue;
    for (const phase of [0, 0.25, 0.5, 0.75]) {
      h.pose(name, phase); h.group.updateMatrixWorld(true); sk.update();
      for (let i = 0; i < n; i++) {
        if (DQS) skinDQ(sk, si, sw, i, bind[i * 3], bind[i * 3 + 1], bind[i * 3 + 2], t);
        else {
          t.set(0, 0, 0);
          for (let k = 0; k < 4; k++) {
            const w = sw.getComponent(i, k); if (w === 0) continue;
            const b = si.getComponent(i, k);
            M.multiplyMatrices(sk.bones[b].matrixWorld, sk.boneInverses[b]);
            v.set(bind[i * 3], bind[i * 3 + 1], bind[i * 3 + 2]).applyMatrix4(M).multiplyScalar(w);
            t.add(v);
          }
        }
        cur[i * 3] = t.x; cur[i * 3 + 1] = t.y; cur[i * 3 + 2] = t.z;
      }
      for (let f = 0; f < idx.length; f += 3 * step) for (let e = 0; e < 3; e++) {
        const a = idx[f + e], b = idx[f + (e + 1) % 3];
        const L0 = Math.hypot(bind[a * 3] - bind[b * 3], bind[a * 3 + 1] - bind[b * 3 + 1], bind[a * 3 + 2] - bind[b * 3 + 2]);
        const L1 = Math.hypot(cur[a * 3] - cur[b * 3], cur[a * 3 + 1] - cur[b * 3 + 1], cur[a * 3 + 2] - cur[b * 3 + 2]);
        if (L1 - L0 > 0.012) over++;
        if (STRETCH_DBG && L1 - L0 > 0.06) STRETCH_DBG.push([+(L1 - L0).toFixed(3), +L0.toFixed(3), name + '@' + phase, a, b, [+bind[a * 3].toFixed(3), +bind[a * 3 + 1].toFixed(3), +bind[a * 3 + 2].toFixed(3)], [+bind[b * 3].toFixed(3), +bind[b * 3 + 1].toFixed(3), +bind[b * 3 + 2].toFixed(3)]]);
        if (L1 - L0 > worst) { worst = L1 - L0; worstClip = name + '@' + phase; worstAt = [+bind[a * 3].toFixed(2), +bind[a * 3 + 1].toFixed(2), +bind[a * 3 + 2].toFixed(2)];
          worstBones = [a, b].map((i) => [0, 1, 2, 3].filter((k) => sw.getComponent(i, k) > 0.01).map((k) => BONE_NAMES[si.getComponent(i, k)] + ':' + sw.getComponent(i, k).toFixed(2)).join('+')); }
      }
    }
  }
  if (STRETCH_DBG) { STRETCH_DBG.sort((x, y) => y[0] - x[0]); console.info('[humanoid] stretch top', JSON.stringify(STRETCH_DBG.slice(0, 14))); }
  return { gainM: +worst.toFixed(3), edgesOver12mm: over, at: worstClip, where: worstAt, bones: worstBones };
}
// Every variant, not just the hero. The old sweep only ever posed kento (fist 0.25, jaw 1.13) against a flat 13.5 cm
// margin and reported guard:{ok:true} while the boss (fist 0.8, jaw 1.15) had his knuckles inside his own cheek in
// the one preset built to show the cast off. Threshold is now the per-variant clearance the rig itself uses.
// How far the skinned mesh strays from the SKELETON in a given pose — the bind-pose bounding box could never see
// the boss's coat yoke, which only leaves the body once an arm comes up (100 % Spine2 cloth on a raised shoulder:
// a flat shelf standing clear of the sleeve, and the brightest thing in the cast shot).
const _psA = new THREE.Vector3(), _psB = new THREE.Vector3(), _psC = new THREE.Vector3(), _psM = new THREE.Matrix4();
function poseStray(h, clip, phase) {
  const geo = h.skinned.geometry, pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  if (!si || !sw || !humanoid.getClip || !humanoid.getClip(clip)) return null;
  h.pose(clip, phase); h.group.updateMatrixWorld(true); h.skeleton.update();
  const segs = [];
  for (const n of BONE_NAMES) {
    const b = h.bones[n]; if (!b) continue;
    const par = PARENT[n] ? h.bones[PARENT[n]] : null; if (!par) continue;
    segs.push([par.getWorldPosition(new THREE.Vector3()), b.getWorldPosition(new THREE.Vector3())]);
  }
  const step = Math.max(1, Math.floor(pos.count / 2500));
  let worst = 0, at = null;
  for (let i = 0; i < pos.count; i += step) {
    if (DQS) skinDQ(h.skeleton, si, sw, i, pos.getX(i), pos.getY(i), pos.getZ(i), _psB);
    else {
      _psB.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k); if (w === 0) continue;
        _psM.multiplyMatrices(h.skeleton.bones[si.getComponent(i, k)].matrixWorld, h.skeleton.boneInverses[si.getComponent(i, k)]);
        _psA.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(_psM).multiplyScalar(w);
        _psB.add(_psA);
      }
    }
    _psB.applyMatrix4(h.skinned.matrixWorld);
    let best = Infinity;
    for (const [a, b] of segs) {                    // distance to the bone SEGMENT, not to a joint
      _psA.copy(b).sub(a);
      const L = _psA.lengthSq();
      const t = L > 1e-9 ? clamp(_psC.copy(_psB).sub(a).dot(_psA) / L, 0, 1) : 0;
      _psC.copy(_psA).multiplyScalar(t).add(a);
      const d = _psC.distanceTo(_psB);
      if (d < best) best = d;
    }
    if (best > worst) { worst = best; at = [+pos.getX(i).toFixed(2), +pos.getY(i).toFixed(2), +pos.getZ(i).toFixed(2)]; }
  }
  return { clip: clip + '@' + phase, maxFromSkeleton: +worst.toFixed(3), at };
}
// How far inside the head-clearance ellipsoid a fist is: q < 1 means the knuckles are inside the skull.
const _hqA = new THREE.Vector3(), _hqB = new THREE.Vector3(), _hqC = new THREE.Vector3(), _hqQ = new THREE.Quaternion();
function fistQ(h, side) {
  const C = h.clearance, s = C.scale;
  h.bones.Head.getWorldPosition(_hqA); _hqA.y += C.headUp * s;
  const hand = h.bones[side + 'Hand'];
  hand.getWorldPosition(_hqB);
  _hqB.addScaledVector(_hqC.set(0, 1, 0).applyQuaternion(hand.getWorldQuaternion(_hqQ)), 0.06 * s);
  _hqB.sub(_hqA);
  return Math.hypot(_hqB.x / C.headR[0], _hqB.y / C.headR[1], _hqB.z / C.headR[2]);
}
// shoulder-line and hip-line tilt in degrees: a standing character with both under 2° is an unmodified A-pose
const _saA = new THREE.Vector3(), _saB = new THREE.Vector3();
function stanceAngles(h) {
  const line = (a, b) => {
    h.bones[a].getWorldPosition(_saA); h.bones[b].getWorldPosition(_saB);
    return Math.atan2(_saA.y - _saB.y, Math.hypot(_saA.x - _saB.x, _saA.z - _saB.z) || 1e-6) * 180 / Math.PI;
  };
  return { shoulderRoll: +line('LeftArm', 'RightArm').toFixed(2), hipTilt: +line('LeftUpLeg', 'RightUpLeg').toFixed(2) };
}
const POSE_CLIPS = ['idle', 'idle_combat', 'guard', 'taunt', 'phone', 'smoke'];
// Every prop kind must end up IN the hand it is slotted to. Round 4's test compared the prop's whole bounding
// box — 0.42 x 0.35 m for the attaché — against a 13 cm box near the wrist, so a case dangling 3 cm clear of
// the fingertips in open air still passed. It reported 'prop grip briefcase ok' on the frame the critic marked
// as a blocker. The test is now the thing a viewer sees: the GRIP POINT (the prop's own origin, which is where
// makeProp puts the handle bar) has to be buried in the hand's own vertices.
function propGripCheck(h) {
  const out = [];
  const geo = h.skinned.geometry, pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const handVerts = (boneName) => {
    const bi = BONE_NAMES.indexOf(boneName), bone = h.bones[boneName], ps = [];
    if (!pos || !si || !sw || bi < 0) return ps;
    const m = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, h.skeleton.boneInverses[bi]);
    // (with the fist morph as it is driven now: the story cast's open hands close round the grip — castFistMorph)
    const mp = geo.morphAttributes.position || [], inf = h.skinned.morphTargetInfluences || [];
    for (let i = 0; i < pos.count; i += 2) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) w += sw.getComponent(i, k);
      if (w < 0.8) continue;
      const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      for (let k = 0; k < mp.length; k++) if (inf[k]) { v.x += inf[k] * mp[k].getX(i); v.y += inf[k] * mp[k].getY(i); v.z += inf[k] * mp[k].getZ(i); }
      ps.push(v.applyMatrix4(m));
    }
    return ps;
  };
  for (const kind of ['briefcase', 'phone', 'cigarette']) {
    const m = h.setProp(kind);
    if (!m) { out.push({ kind, ok: false, note: 'not built' }); continue; }
    driveFist(h, 1);
    h.group.updateMatrixWorld(true);
    plumbProp(m, 0.016);
    h.group.updateMatrixWorld(true);
    m.getWorldPosition(_hqA);                                   // the grip point itself
    const vs = handVerts(((h.slots && h.slots[kind]) || PROP_SLOTS[kind]).bone);
    let near = 0, best = Infinity;
    for (const p of vs) { const d = p.distanceTo(_hqA); if (d < best) best = d; if (d < 0.035) near++; }
    out.push({ kind, ok: vs.length > 20 && near >= 4 && best < 0.022, near, nearest: +best.toFixed(4) });
  }
  h.setProp(null);
  return out;
}
function sweepVariants() {
  const out = [];
  for (const variant of ['kento', 'yakuza', 'chinpira', 'boss', 'pedestrian']) {
    const h = createHumanoid({ variant, seed: 7, detail: 1, lod: false, prop: null });
    const r = { variant, tris: h.tris, drawCalls: h.drawCalls, clip: [], stray: 0, ok: true };
    if (h.drawCalls > 7) { r.ok = false; r.drawNote = 'over the 8 draw call budget'; }
    r.stance = [];
    for (const clip of POSE_CLIPS) {
      if (!humanoid.getClip || !humanoid.getClip(clip)) continue;
      for (const phase of [0, 0.2, 0.45, 0.7, 0.9]) {
        h.pose(clip, phase); h.group.updateMatrixWorld(true);
        for (const side of SIDES) {
          const q = fistQ(h, side);
          if (q < 0.97) r.clip.push({ clip, phase, side, q: +q.toFixed(3) });
        }
        const sa = stanceAngles(h);
        if (Math.abs(sa.shoulderRoll) < 2 && Math.abs(sa.hipTilt) < 2) r.stance.push({ clip, phase, ...sa });
      }
    }
    if (r.stance.length) { r.ok = false; r.stanceNote = 'an unmodified symmetric A-pose: shoulder line and hip line both under 2 degrees'; }
    r.props = propGripCheck(h);
    if (r.props.some((p) => !p.ok)) { r.ok = false; r.propNote = 'a prop must sit IN the hand it is slotted to'; }
    // a part that strayed off the body (the grey blob that used to float on the boss's shoulder) shows up as a
    // vertex outside a generous capsule around the skeleton
    const bb = new THREE.Box3().setFromBufferAttribute(h.skinned.geometry.attributes.position);
    r.bbox = [bb.min.toArray().map((v) => +v.toFixed(2)), bb.max.toArray().map((v) => +v.toFixed(2))];
    if (bb.max.y > 2.05 || bb.min.y < -0.08 || bb.max.x > 0.95 || bb.min.x < -0.95) { r.ok = false; r.strayNote = 'geometry outside the body envelope'; }
    // the pose the cast shot is built around, not just the bind pose
    r.stray = poseStray(h, 'guard', 0.2);
    if (r.stray && r.stray.maxFromSkeleton > 0.42) { r.ok = false; r.strayNote = 'geometry more than 42 cm off the skeleton in the guard pose'; }
    if (r.clip.length) r.ok = false;
    out.push(r);
    h.dispose();
  }
  return out;
}
export function selfTest(engine) {
  const h = createHumanoid({ variant: 'kento', seed: 1 });
  const out = { hero: HERO_V, scan: h.scan, grip: h.scan ? (h.slots.briefcase || null) : HERO.grip || null, fistVerts: h.skinned.geometry.userData.fistVerts || 0, variant: h.variant, glb: h.scan ? SCANS[h.scan].state : HERO.state, bones: h.skeleton.bones.length, tris: h.tris, drawCalls: h.drawCalls, height: +h.height.toFixed(3), name: h.displayName && h.displayName.ja, keyLight: !!h.keyRig, shadows: { receive: h.skinned.receiveShadow, contact: !!h.contact }, capped: HERO.capped || 0, prop: null, guard: null, stretch: null, clipThrough: [], variants: null, ok: true };
  if (out.bones !== 22 || out.drawCalls > 7) out.ok = false;
  if (Math.abs(h.height - 1.82) > 0.015) { out.ok = false; out.heightNote = 'hero must be 1.82 m (docs/HERO.md)'; }
  { const b = h.setProp('briefcase');                                   // left hand, then set down at the feet
    out.prop = { attached: !!b, bone: b && b.parent && b.parent.name };
    if (!b || b.parent.name !== 'LeftHand') out.ok = false;
    h.group.updateMatrixWorld(true);
    const wp = b.getWorldPosition(new THREE.Vector3());
    out.prop.world = wp.toArray().map((v) => +v.toFixed(2));
    out.prop.raw = new THREE.Box3().setFromObject(b).min.toArray().map((v) => +v.toFixed(2));
    plumbProp(b); h.group.updateMatrixWorld(true);
    const pb = new THREE.Box3().setFromObject(b);
    out.prop.box = [pb.min.toArray().map((v) => +v.toFixed(2)), pb.max.toArray().map((v) => +v.toFixed(2))];
    out.prop.hang = b.userData.hang ? b.userData.hang.toArray().map((v) => +v.toFixed(3)) : null;
    const d = h.dropProp(new THREE.Group());
    out.prop.dropped = !!d && !h.props.prop;
    if (!out.prop.dropped) out.ok = false;
    out.prop.gripCheck = propGripCheck(h);
    if (out.prop.gripCheck.some((p) => !p.ok)) { out.ok = false; out.propNote = 'the grip point of every prop must be buried in its hand\'s own vertices (nearest < 22 mm)'; }
    h.setProp(null); }
  // grounding: a character standing on both feet must report both of them PLANTED (lift < 0.05, the decal at full
  // opacity) and the decal must sit on the ground plane, not on the group origin — which is where it used to be,
  // 16 cm up, with both feet reading 0.8 lifted because footPos() aliased its own scratch vector.
  if (h.contact) {
    h.group.position.set(0, 0.15, 0);                                   // a Shibuya sidewalk, not y = 0
    if (humanoid.getClip && humanoid.getClip('idle')) h.pose('idle', 0);
    h.plant();
    updateContact(h, null);
    const col = h.contact.geometry.attributes.color.array, pos2 = h.contact.geometry.attributes.position.array;
    // the decal is a CONTACT_G² grid now, so the core alpha of decal q is at its centre node, not at vertex 0
    const V4 = CONTACT_G * CONTACT_G * 4, mid = ((CONTACT_G * CONTACT_G - 1) >> 1) * 4 + 3;
    const peak = (q) => col[q * V4 + mid] / Math.max(CONTACT_NODE.f[(CONTACT_G * CONTACT_G - 1) >> 1], 1e-4);
    const lift = (a) => +((1 - a / CONTACT_A) / 0.85);
    const a0 = peak(0), a1 = peak(1);
    out.contact = { opacity: [+a0.toFixed(3), +a1.toFixed(3)], lift: [+lift(a0).toFixed(3), +lift(a1).toFixed(3)],
      worldY: +(h.group.position.y + pos2[1] * (h.group.scale.y || 1)).toFixed(4), groundY: +h.group.position.y.toFixed(3) };
    const planted = lift(a0) < 0.05 && lift(a1) < 0.05;
    const onGround = Math.abs(out.contact.worldY - (h.group.position.y + 0.030)) < 0.003 && out.contact.worldY > 0.16;
    out.contact.quads = CONTACT_QUADS;
    if (!planted || !onGround) { out.ok = false; out.contactNote = 'both feet must read planted (opacity >= 0.54, lift < 0.05) and the decal must lie 30 mm above the GROUND'; }
    h.group.position.set(0, 0, 0); h.plant();
  }
  if (humanoid.getClip && humanoid.getClip('guard')) {
    h.group.updateMatrixWorld(true);
    h.pose('guard', 0.1); h.plant(); h.group.updateMatrixWorld(true);     // planted in THIS pose, not the idle's
    const l = h.boneWorld('LeftHand'), r = h.boneWorld('RightHand');
    out.guard = { leftHand: l.toArray().map((v) => +v.toFixed(2)), rightHand: r.toArray().map((v) => +v.toFixed(2)) };
    const fistsUp = l.y > 1.2 && l.y < 1.7 && r.y > 1.2 && r.y < 1.7, inside = Math.abs(l.x) < 0.42 && Math.abs(r.x) < 0.42, forward = l.z > 0.05 && r.z > 0.05;
    out.guard.ok = fistsUp && inside && forward;
    if (!out.guard.ok) out.guardNote = 'guard fists should be at chin height, inside the shoulders and in front of the chest (animations.js COMBAT pose)';
    // no hand bone may sit inside the head's clearance ellipsoid in ANY standing clip (the critic's assertion)
    out.stance = [];
    for (const clip of POSE_CLIPS) {
      if (!humanoid.getClip(clip)) continue;
      for (const phase of [0, 0.25, 0.5, 0.75]) {
        h.pose(clip, phase); h.group.updateMatrixWorld(true);
        for (const side of SIDES) {
          const q = fistQ(h, side);
          if (q < 0.97) out.clipThrough.push({ clip, phase, side, q: +q.toFixed(3) });
        }
        const sa = stanceAngles(h);
        if (Math.abs(sa.shoulderRoll) < 2 && Math.abs(sa.hipTilt) < 2) out.stance.push({ clip, phase, ...sa });
      }
    }
    if (out.clipThrough.length) { out.ok = false; console.warn('[humanoid] a fist is inside the head ellipsoid:', JSON.stringify(out.clipThrough)); }
    if (out.stance.length) { out.ok = false; out.stanceNote = 'symmetric A-pose: shoulder line and hip line both under 2 degrees'; }
  }
  // a healthy skin stretches a few mm at a joint; a vertex on the wrong bone pulls its edge tens of centimetres
  // the story cast's other scans (loaded ones only): the same stretch sweep, reported (柊, the club trio)
  out.cast = {};
  for (const v of ['hiiragi', ...CLUB_ASSETS]) {
    if (!castScanReady(v)) { out.cast[v] = 'not loaded'; continue; }
    const c = createHumanoid({ variant: v, seed: 1 });
    try { out.cast[v] = { tris: c.tris, drawCalls: c.drawCalls, height: +c.height.toFixed(3), fistVerts: c.skinned.geometry.userData.fistVerts || 0, stretch: maxStretch(c), stray: poseStray(c, 'guard', 0.2) }; } catch (e) { out.cast[v] = e.message; }
    c.dispose();
  }
  try { out.stretch = maxStretch(h); if (out.stretch && out.stretch.gainM > 0.10) { out.ok = false; out.stretchNote = 'an edge grows > 10 cm under a clip — LBS at the shoulder cap, driven by how far the clip rotates it (animations.js), not by a bad weight'; } } catch (e) { out.stretchNote = e.message; }
  h.dispose();
  try { out.variants = sweepVariants(); if (out.variants.some((v) => !v.ok)) out.ok = false; } catch (e) { out.variantsNote = e.message; }
  try { out.pedestrians = sweepPedestrians(); if (out.pedestrians.some((p) => !p.ok)) { out.ok = false; out.pedestriansNote = 'every outfit x frame must build at detail 1 / 0.6 / 0.35 in <= 7 draw calls, deterministic from its seed'; } } catch (e) { out.pedestriansNote = e.message; }
  out.skinAtlases = skinCache.size;
  return out;
}
// every outfit template on both frames at the three details the crowd builds (1 / 0.6 / 0.35): it builds, it stays
// inside the seven-draw budget, it wears what was asked for, and the look is a pure function of its options
function sweepPedestrians() {
  const out = [];
  PED_OUTFITS.forEach((outfit, i) => {
    for (const fem of [false, true]) {
      const seed = 500 + i * 41 + (fem ? 7 : 0), want = outfit === 'dress' && !fem ? 'blouson' : outfit;
      const a = resolvePedestrian({ seed, outfit, fem }), b = resolvePedestrian({ seed, outfit, fem });
      const r = { outfit, fem, hair: a.hair, wears: a.outfit, draws: [], tris: [], ok: JSON.stringify(a) === JSON.stringify(b) && a.outfit === want };
      for (const det of [1, 0.6, 0.35]) {
        const h = createHumanoid({ variant: 'pedestrian', seed, outfit, fem, detail: det, lod: false });
        r.draws.push(h.drawCalls); r.tris.push(h.tris);
        if (h.drawCalls > 7 || !(h.tris > 1000)) r.ok = false;
        h.dispose();
      }
      out.push(r);
    }
  });
  return out;
}

// ?heroPick=x,y[;x,y]: which triangle of which character is under that pixel of the 1920x1080 frame (debug)
const HERO_PICK = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('heroPick') : null;
function heroPick(engine) {
  const rc = new THREE.Raycaster(), cam = engine.camera, W = engine.renderer.domElement;
  for (const xy of HERO_PICK.split(';')) {
    const [x, y] = xy.split(',').map(Number);
    rc.setFromCamera(new THREE.Vector2((x / 1920) * 2 - 1, -(y / 1080) * 2 + 1), cam);
    const hits = [];
    for (const h of humanoid.all) for (const m of h.meshes) if (m.visible !== false) hits.push(...rc.intersectObject(m, false));
    hits.sort((a, b) => a.distance - b.distance);
    const hit = hits[0]; if (!hit) { console.info('[humanoid] pick', xy, 'nothing'); continue; }
    const g = hit.object.geometry, f = hit.face, uv = g.attributes.uv, sp = g.attributes.seamPatch, col = g.attributes.color;
    const v = [f.a, f.b, f.c].map((i) => ({ i, uv: uv ? [+uv.getX(i).toFixed(4), +uv.getY(i).toFixed(4)] : null, patch: sp ? sp.getX(i) : null,
      col: col ? [+col.getX(i).toFixed(2), +col.getY(i).toFixed(2), +col.getZ(i).toFixed(2)] : null, p: [+g.attributes.position.getX(i).toFixed(3), +g.attributes.position.getY(i).toFixed(3), +g.attributes.position.getZ(i).toFixed(3)] }));
    console.info('[humanoid] pick', xy, hit.object.name, 'face', hit.faceIndex, 'W', W.width, JSON.stringify(v));
  }
}
// ?civCam=dist,height,angle[,any,lookHeight,fov]: debug lens that follows the crowd's nearest bound pool civilian (a scan one, any
// pool body with a 4th value of 1, a procedural one with 2) from `dist` metres, `angle` rad off its facing — the pool body as the crowd poses it
const CIV_CAM = (() => { const s = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('civCam') : null; return s ? s.split(',').map(Number) : null; })();
let civCamT = 0, civCamH = null;
function civCam(engine, dt) {
  civCamT += dt;
  if (civCamT < 2.5) return;
  const cam = engine.get && engine.get('camera');
  if (!civCamH || !civCamH.group.visible) {
    civCamH = null;
    let bd = Infinity;
    for (const h of humanoid.all) {
      if (!h.group.visible || lineup.includes(h) || !h.frozenPose || (!h.civ && !CIV_CAM[3]) || (h.civ && CIV_CAM[3] === 2)) continue;
      const d = h.group.position.distanceTo(engine.camera.position);
      if (d < bd) { bd = d; civCamH = h; }
    }
    if (civCamH) console.info('[humanoid] civCam on', civCamH.variant, civCamH.civ ? 'civ' : 'proc');
  }
  if (!civCamH || !cam || typeof cam.setFixed !== 'function') return;
  const [d = 3, y = 1.6, a = 0.35, , ly = y - 0.25 * d / 3, fov = 30] = CIV_CAM, g = civCamH.group, yaw = g.rotation.y + a, s = g.scale.y;
  const p = new THREE.Vector3(g.position.x + Math.sin(yaw) * d, g.position.y + y * s, g.position.z + Math.cos(yaw) * d);
  cam.setFixed(p, new THREE.Vector3(g.position.x, g.position.y + ly * s, g.position.z), { fov });
}
const humanoid = {
  name: 'humanoid',
  all: [],
  getClip: null,
  createHumanoid, makeProp, PROP_SLOTS, PROP_GRIP, RIG, BONE_NAMES, VARIANTS, shotPresets, selfTest, civScans, PED_SCANS, pedScansReady, pedScanReady, gaitPose,
  castScansReady, castScanReady,
  async init(engine) {
    this.engine = engine;
    // the hero's mesh is the client's own scan; awaited here (humanoid runs in the asset phase) so player.init(),
    // enemy.init() and every shot preset already see it. A failure only drops back to the procedural hero.
    const t0 = performance.now();
    // ?humTime=1: the load timeline. Measured: every byte is here before this runs; what the engine logs as this
    // init's time is a setTimeout(0) queued behind the city's first-frame shader compile (1.6 s), not this module.
    if (HUM_TIME) { console.info('[humanoid] t', Math.round(t0), 'init'); setTimeout(() => console.info('[humanoid] t', Math.round(performance.now()), 'event loop free'), 0); }
    await Promise.all([loadHeroAny().then(() => { if (HUM_TIME) console.info('[humanoid] hero ready', HERO_V, Math.round(performance.now() - t0), 'ms'); }),
      ...MOB_ASSETS.map((n) => loadMobScan(n).then(() => { if (HUM_TIME) console.info('[humanoid] mob', n, 'ready', Math.round(performance.now() - t0), 'ms'); })),
      // 柊 is awaited only when the page asks for him (a shot of him, ?cast=hiiragi); otherwise he loads after boot
      ...CLUB_ASSETS.map(loadCastScan),
      ...(CAST_EAGER ? [loadCastScan('hiiragi')] : [])]);
    const anim = engine.get('animations');
    if (anim && typeof anim.getClip === 'function') this.getClip = anim.getClip;
    // the 19 passers-by: after everything the boot needs, in parallel, not awaited
    setTimeout(() => { pedScansReady(); loadCastScan('hiiragi'); }, 0);
    // carried props are put down for a fight and picked back up afterwards — a no-op for anyone not carrying one
    const ev = engine.events;
    if (ev && typeof ev.on === 'function') {
      ev.on('combat:start', () => { for (const h of this.all) if (h.propKind && h.props.prop) { h.stashedProp = h.propKind; h.dropProp(engine.scene); } });
      // ...once the fight's final blow has played out: it must not pop back into his hand inside the slow-motion close-up
      ev.on('combat:end', () => {
        const pick = () => { for (const h of this.all) if (h.stashedProp) { h.setProp(h.stashedProp); h.stashedProp = null; } };
        const cb = engine.get && engine.get('combat');
        if (cb && cb.afterFinale) cb.afterFinale(pick); else pick();
      });
    }
  },
  update(dt) {
    // first frame, every system initialised (enemy.js's clean-up included): fill the civilian caches now, so the
    // crowd's first scan body of each kind is not a 150-250 ms hitch mid-play
    if (!this._civWarm && this.engine) { this._civWarm = true; if (CIV_WARM_UP) civWarmUp(this.engine); }
    const hour = this.engine && this.engine.time ? this.engine.time.hour : 21.5;
    const night = hour < 6.2 || hour > 17.6 ? 1 : 0;
    if (this.engine) syncEnv(this.engine.scene);
    if (night) sampleNeon(this.engine);
    setCharHemi(hour, this.engine && this.engine.time ? (this.engine.time.wet || 0) > 0.3 : false);
    contactFrustum(this.engine);
    const cam = this.engine && this.engine.camera;
    // One key direction and one rim direction for the whole cast, written once per frame. There is nothing left
    // to cull: the lights are two dot products inside the character shader.
    setCharKey(cam, !!night, this.keyBoost || 1, dt);
    syncFill(this.engine);
    for (const h of this.all) {
      if (!h.frozenPose) { h.mixer.update(dt); driveFist(h, dt); if (h.floorOK && !h.lateFloor && FLOOR_CLIPS.has(h.currentName) && h.group.visible) floorFit(h); }
      const carried = h.props.prop;
      // a frozen pose already ran it once in pose(): the mixer is not there to re-write the bones, so running the
      // arm corrections and the stance overlay again every frame would integrate them into a pretzel
      const needClip = !!h.clearance && !h.frozenPose && !NO_CLEAR.has(h.currentName);
      const seen = h.contact ? (CONTACT_FORCE || contactVisible(h, this.engine)) : false;
      if (h.contact && !seen) h.contact.visible = false;
      // the recursive walk of a skinned hierarchy is the expensive part, so it only runs when something on this
      // character is actually going to move a bone or read one this frame
      // a body posed by someone else each frame (the crowd's pool) still gets its wrists held
      if (h.frozenPose && h.group.visible && !lineup.includes(h)) clampHands(h);
      const lift = !h.frozenPose && !!h.clearance && FIST_LIFT_CLIPS.has(h.currentName);
      if (needClip || carried || seen || lift) {
        h.group.updateMatrixWorld(true);
        if (needClip) resolveSelfClip(h);
        if (lift) clampFistLift(h);
        if (seen) updateContact(h, this.engine);
        if (carried) plumbProp(carried, dt);
      }
    }
    if (this.hideCrowd && this.engine) { applyHideCrowd(this.engine); hideTraffic(this.engine); }
    if (CIV_CAM && this.engine) civCam(this.engine, dt);
    if (HERO_PICK && (this._pickN = (this._pickN || 0) + 1) === 40) heroPick(this.engine);
  },
};

// Start the scans' fetch + decode the moment this module is imported. main.js imports every system before it inits
// any, and the city and the signage take several seconds of init ahead of humanoid's turn: the hero's and the four
// mobs' 13 MB of geometry and 15 maps now download under that work instead of blocking boot for 1.6-2.5 s after it.
// init() still awaits the same promises, so nothing downstream can see a half-loaded scan.
if (typeof window !== 'undefined' && typeof fetch === 'function') { loadHeroAny(); MOB_ASSETS.forEach(loadMobScan); CLUB_ASSETS.forEach(loadCastScan); if (CAST_EAGER) loadCastScan('hiiragi'); }

export default humanoid;
