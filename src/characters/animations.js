// [animation] AnimationClips built in code against the bone contract (§6).
//   getClip(name) -> THREE.AnimationClip (cached)   CLIPS[]   selfTest()   shotPresets
//   clip.userData = { events:[{time, name:'hit', bone, radius} | {time, name:'footstep', foot:'L'|'R'}], loop, speed?, stride? }
//
// Authoring model: sparse pose keys -> monotone cubic sampling of every channel at 30/60 Hz -> per-sample analytic
// leg IK for feet that are pinned to the ground -> QuaternionKeyframeTrack per bone (+ Hips.position). Because the
// foot target is a channel, a foot that keeps the same target between two keys stays planted exactly (no sliding).
//
// Pose = { Bone: [xDeg, yDeg, zDeg], hips: [dx, dy, dz], ikL: [x, y, z, pitch, yaw], ikR: [...] }
//   deltas in the bone's bind-local frame (humanoid.js). Right-side bones have Y/Z mirrored here so the SAME
//   numbers mean the same thing on both sides:
//     limbs   X+ swing forward   Y+ internal rotation   Z+ abduct (away from the body)
//     feet    X+ toe up          Z+ toe out             shoulders X+ forward, Z+ shrug up
//     spine/neck/head/hips  X+ lean forward  Y+ turn left  Z+ tilt right
//   ikL/ikR: ankle target in character space (x left, y up, z forward, metres), foot pitch (toe up +), yaw (toe out +).
//   A leg given explicit UpLeg/Leg/Foot rotations instead is FK for that key; the sampler blends FK<->IK across keys.
import * as THREE from 'three';
import { RIG as DEFAULT_RIG, BONE_NAMES } from './humanoid.js';

// pedestrian street life (crowd.js / crowdScan.js; contract in docs/reports/pedclips.md). Appended to CLIPS so
// crowdScan's `CLIPS.includes(name)` gate admits them.
export const PED_CLIPS = ['walk_chat', 'walk_chat_r', 'walk_phone', 'idle_wait', 'idle_phone_call', 'greet_wave', 'greet_bow', 'talk_stand', 'talk_listen',
  'window_look', 'argue', 'argue_back', 'laugh', 'look_around', 'sit_rail'];
// left-handed twins, <name>_m = the base clip's frames mirrored (the base clips move the RIGHT hand): for a scan whose
// right hand is in a pocket / on a bag (PED_HANDS, pedClipFor). walk_chat_r is walk_chat's twin under its own name.
export const PED_MIRRORED = ['walk_phone', 'idle_wait', 'idle_phone_call', 'greet_wave', 'talk_stand', 'window_look', 'argue', 'argue_back', 'laugh'];
export const CLIPS = ['idle', 'idle_combat', 'walk', 'run', 'jab', 'straight', 'hook', 'uppercut', 'kick', 'roundhouse', 'guard', 'guard_hit', 'dodge',
  'hit_light', 'hit_heavy', 'knockdown', 'getup', 'grab', 'throw', 'heat_finisher', 'taunt', 'stumble', 'dead', 'sit', 'phone', 'smoke', ...PED_CLIPS,
  ...PED_MIRRORED.map((n) => n + '_m')];

// nominal durations (s) — selfTest checks these
export const DURATIONS = {
  idle: 4.0, idle_combat: 1.4, walk: 0.65, run: 0.6, jab: 0.35, straight: 0.45, hook: 0.5, uppercut: 0.55, kick: 0.78, roundhouse: 0.75,
  guard: 1.2, guard_hit: 0.35, dodge: 0.45, hit_light: 0.4, hit_heavy: 0.7, knockdown: 1.2, getup: 1.1, grab: 0.5, throw: 0.9,
  heat_finisher: 1.6, taunt: 1.5, stumble: 0.8, dead: 2.0, sit: 6.0, phone: 4.0, smoke: 4.0,
  walk_chat: 3.3, walk_chat_r: 3.3, walk_phone: 2.3, idle_wait: 11.0, idle_phone_call: 6.0, greet_wave: 1.6, greet_bow: 1.4, talk_stand: 6.0, talk_listen: 5.2,
  window_look: 7.0, argue: 4.0, argue_back: 4.0, laugh: 2.0, look_around: 3.4, sit_rail: 6.0,
};
for (const n of PED_MIRRORED) DURATIONS[n + '_m'] = DURATIONS[n];
// locomotion nominal speeds (m/s) — must match player.js WALK/RUN so feet do not slide at timeScale 1
export const WALK_SPEED = 2.4, HERO_WALK_SPEED = 2.0, RUN_SPEED = 5.6;

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
let RIG = DEFAULT_RIG;
let L_THIGH = RIG.world.LeftUpLeg.length, L_SHIN = RIG.world.LeftLeg.length, ANKLE_Y = RIG.joints.LeftFoot[1];
const SOLE_Y = 0.075, HEEL_Z = 0.06, TOE_Z = 0.20, TOE_OFF = 38;   // shoe geometry under the ankle (humanoid.js shoe box), toe-off plantar angle
const cache = new Map(), sampled = new Map();
// a pedestrian clip built against one scan's own arm lengths (getClip(name, fit)): { key, arms: { Left: [upper, fore],
// Right: [upper, fore] } } in the rig's metres, set only while that build runs; armIK reads it
let FIT = null;
const sampleKey = (name) => (FIT ? `${name}@${FIT.key}` : name);
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _v = new THREE.Vector3();

// ------------------------------------------------------------------ channel layout
const CH = {}; let NCH = 0;
for (const b of BONE_NAMES) { CH[b] = NCH; NCH += 3; }
CH.hips = NCH; NCH += 3;
CH.ikL = NCH; NCH += 6;   // x y z pitch yaw weight
CH.ikR = NCH; NCH += 6;
const LEGS = { L: { up: 'LeftUpLeg', leg: 'LeftLeg', foot: 'LeftFoot', ik: 'ikL', sign: 1 }, R: { up: 'RightUpLeg', leg: 'RightLeg', foot: 'RightFoot', ik: 'ikR', sign: -1 } };

function mirrored(bone, r) { return bone.startsWith('Right') ? [r[0], -r[1], -r[2]] : r; }

function boneQuat(bone, r, out) {
  const m = mirrored(bone, r);
  _e.set(m[0] * D2R, m[1] * D2R, m[2] * D2R, 'XYZ');
  _q.setFromEuler(_e);
  return out.copy(RIG.local[bone].quaternion).multiply(_q);
}

// FK: frame (Float64Array of channels) -> { pos: {bone: Vector3}, quat: {bone: Quaternion} } in character space
export function fkFrame(f, out = null) {
  const pos = out?.pos || {}, quat = out?.quat || {};
  for (const n of BONE_NAMES) {
    const c = CH[n];
    const q = quat[n] || (quat[n] = new THREE.Quaternion());
    boneQuat(n, [f[c], f[c + 1], f[c + 2]], q);
    const p = pos[n] || (pos[n] = new THREE.Vector3());
    p.copy(RIG.local[n].position);
    if (n === 'Hips') { p.x += f[CH.hips]; p.y += f[CH.hips + 1]; p.z += f[CH.hips + 2]; }
    const par = RIG.parent[n];
    if (par) { p.applyQuaternion(quat[par]).add(pos[par]); q.premultiply(quat[par]); }
  }
  return { pos, quat };
}
// character-space tip of a bone (toe tip / hand tip / head top) for an fk result; bone local +Y runs to the tip
function tipOf(fk, bone, out = new THREE.Vector3()) {
  return out.set(0, RIG.world[bone].length, 0).applyQuaternion(fk.quat[bone]).add(fk.pos[bone]);
}

// pose object -> channel frame (undefined ik = not specified for that key)
function frameFromPose(pose) {
  const f = new Float64Array(NCH);
  const ikGiven = { L: false, R: false }, fkGiven = { L: false, R: false };
  for (const k in pose) {
    const v = pose[k];
    if (k === 'hips') { f[CH.hips] = v[0] || 0; f[CH.hips + 1] = v[1] || 0; f[CH.hips + 2] = v[2] || 0; }
    else if (k === 'ikL' || k === 'ikR') { const c = CH[k]; for (let i = 0; i < 5; i++) f[c + i] = v[i] || 0; f[c + 5] = 1; ikGiven[k === 'ikL' ? 'L' : 'R'] = true; }
    else if (CH[k] !== undefined) { const c = CH[k]; f[c] = v[0] || 0; f[c + 1] = v[1] || 0; f[c + 2] = v[2] || 0; if (/UpLeg|Leg$|Foot$/.test(k)) fkGiven[k.startsWith('Left') ? 'L' : 'R'] = true; }
    else console.warn('[animations] unknown pose channel', k);
  }
  // complete both representations so every channel interpolates: FK legs get an IK target, IK legs get FK angles
  for (const s of ['L', 'R']) {
    const leg = LEGS[s], c = CH[leg.ik];
    if (ikGiven[s] && !fkGiven[s]) { solveLeg(f, s); }     // explicit FK angles win over an inherited ik target
    else {
      const fk = fkFrame(f);
      const ankle = fk.pos[leg.foot], [pitch, yaw] = footPitchYaw(fk, s);
      f[c] = ankle.x; f[c + 1] = ankle.y; f[c + 2] = ankle.z; f[c + 3] = pitch; f[c + 4] = yaw; f[c + 5] = fkGiven[s] ? 0 : 1;
      if (!fkGiven[s]) { f[c + 1] = ANKLE_Y; f[c + 3] = 0; f[c + 4] = 6; solveLeg(f, s); } // unspecified leg: plant it under the hip
    }
  }
  return f;
}

// analytic 2-bone leg IK, writes UpLeg/Leg/Foot rotations into f from the ikL/ikR channels.
// Built as world quaternions (thigh aimed at the knee with the toe direction as the pole, shin as a pure hinge,
// foot from absolute pitch/yaw) and decomposed to the XYZ Euler channels, so twist and abduction stay exact.
const _hq = new THREE.Quaternion(), _hp = new THREE.Vector3(), _t = new THREE.Vector3();
const _yA = new THREE.Vector3(), _zA = new THREE.Vector3(), _xA = new THREE.Vector3(), _m4 = new THREE.Matrix4();
const _qW = new THREE.Quaternion(), _qS = new THREE.Quaternion(), _qL = new THREE.Quaternion(), _qD = new THREE.Quaternion();
const _dir = new THREE.Vector3(), _w = new THREE.Vector3(), _pole = new THREE.Vector3(), _thigh = new THREE.Vector3(), _knee = new THREE.Vector3(), _ankle = new THREE.Vector3(), _shin = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), XW = new THREE.Vector3(1, 0, 0);
const BALL_Z = 0.13;                               // ball of the foot, forward of the ankle (pivot for heel lifts)
let BIND_FOOT_PITCH = Math.atan2(RIG.joints.LeftToeBase[1] - RIG.joints.LeftFoot[1], RIG.joints.LeftToeBase[2]) * R2D;   // toe elevation in bind (-25°)
const clamp1 = (x) => Math.min(1, Math.max(-1, x));

function frameQuat(y, z, out) {                    // world quaternion with local +Y = y, local +Z = z (z made ⟂ y)
  _yA.copy(y).normalize();
  _zA.copy(z).addScaledVector(_yA, -_zA.dot(_yA)).normalize();
  _xA.crossVectors(_yA, _zA);
  _m4.makeBasis(_xA, _yA, _zA);
  return out.setFromRotationMatrix(_m4);
}
function writeEuler(f, bone, qDelta) {             // bone local delta quaternion -> stored (mirrored) Euler channels
  _e.setFromQuaternion(qDelta, 'XYZ');
  const r = mirrored(bone, [_e.x * R2D, _e.y * R2D, _e.z * R2D]);
  const c = CH[bone]; f[c] = r[0]; f[c + 1] = r[1]; f[c + 2] = r[2];
}
function solveLeg(f, side) {
  const leg = LEGS[side], c = CH[leg.ik], sign = leg.sign;
  boneQuat('Hips', [f[CH.Hips], f[CH.Hips + 1], f[CH.Hips + 2]], _hq);
  _hp.copy(RIG.local.Hips.position); _hp.x += f[CH.hips]; _hp.y += f[CH.hips + 1]; _hp.z += f[CH.hips + 2];
  const joint = _t.copy(RIG.local[leg.up].position).applyQuaternion(_hq).add(_hp);
  _dir.set(f[c] - joint.x, f[c + 1] - joint.y, f[c + 2] - joint.z);
  let d = _dir.length();
  const maxD = (L_THIGH + L_SHIN) * 0.995;
  if (d > maxD) d = maxD; if (d < 0.05) d = 0.05;
  _dir.normalize();
  // pole = toe direction tilted up, so a leg stretched forward still bends its knee upward
  const yaw = f[c + 4] * D2R;
  _pole.set(sign * Math.sin(yaw), 0.35, Math.cos(yaw));
  _w.copy(_pole).addScaledVector(_dir, -_pole.dot(_dir));
  if (_w.lengthSq() < 1e-6) _w.set(0, 0, 1).addScaledVector(_dir, -_dir.z);
  _w.normalize();
  const A = Math.acos(clamp1((L_THIGH * L_THIGH + d * d - L_SHIN * L_SHIN) / (2 * L_THIGH * d)));
  _thigh.copy(_dir).multiplyScalar(Math.cos(A)).addScaledVector(_w, Math.sin(A));         // thigh direction
  frameQuat(_thigh, _w, _qW);                                                            // thigh world frame
  _knee.copy(joint).addScaledVector(_thigh, L_THIGH);
  _ankle.copy(joint).addScaledVector(_dir, d);
  _shin.copy(_ankle).sub(_knee).normalize();
  _qL.copy(_hq).invert().multiply(_qW);
  _qD.copy(RIG.local[leg.up].quaternion).invert().multiply(_qL);
  writeEuler(f, leg.up, _qD);
  // shin: same hinge axis as the thigh (local X = Y × Z), aimed down the shin
  _xA.crossVectors(_thigh, _w);
  _zA.crossVectors(_xA, _shin);
  frameQuat(_shin, _zA, _qS);
  _qL.copy(_qW).invert().multiply(_qS);
  _qD.copy(RIG.local[leg.leg].quaternion).invert().multiply(_qL);
  writeEuler(f, leg.leg, _qD);
  f[CH[leg.leg] + 1] = 0; f[CH[leg.leg] + 2] = 0;
  if (f[CH[leg.leg]] > 0) f[CH[leg.leg]] = 0;                                            // never hyper-extend
  // foot: absolute pitch (toe up +) and yaw (toe out +) in character space
  _qD.setFromAxisAngle(XW, -f[c + 3] * D2R);
  _qL.setFromAxisAngle(UP, sign * yaw).multiply(_qD).multiply(RIG.world[leg.foot].quaternion);
  _qD.copy(_qS).invert().multiply(_qL);
  _qL.copy(RIG.local[leg.foot].quaternion).invert().multiply(_qD);
  writeEuler(f, leg.foot, _qL);
}
// absolute pitch/yaw of a foot from an fk result (for FK-authored legs, so the ik channels stay continuous)
function footPitchYaw(fk, side) {
  const leg = LEGS[side];
  _t.set(0, 1, 0).applyQuaternion(fk.quat[leg.foot]);
  const yaw = leg.sign * Math.atan2(_t.x, _t.z) * R2D;
  const pitch = Math.atan2(_t.y, Math.hypot(_t.x, _t.z)) * R2D - BIND_FOOT_PITCH;
  return [pitch, yaw];
}
// ankle target for a foot pivoting on its ball: heel lifted by toeDown degrees, turned to yaw (toe out +)
function ballPivot(side, ik, toeDown, yaw = ik[4]) {
  const sign = side === 'L' ? 1 : -1, a = toeDown * D2R;
  const bx = ik[0] + sign * Math.sin(ik[4] * D2R) * BALL_Z, bz = ik[2] + Math.cos(ik[4] * D2R) * BALL_Z;
  const r = BALL_Z * Math.cos(a) - SOLE_Y * Math.sin(a);
  return [bx - sign * Math.sin(yaw * D2R) * r, ANKLE_Y + BALL_Z * Math.sin(a) + SOLE_Y * (Math.cos(a) - 1), bz - Math.cos(yaw * D2R) * r, -toeDown, yaw];
}

// ------------------------------------------------------------------ sampling
// monotone cubic (Fritsch–Carlson) per channel: no overshoot, flat holds, C1 elsewhere
function tangents(ts, ys, loop) {
  const n = ts.length, m = new Float64Array(n), d = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (ts[i + 1] - ts[i]);
  if (n === 1) return m;
  for (let i = 0; i < n; i++) {
    let dl, dr;
    if (i === 0) { dl = loop ? d[n - 2] : d[0]; dr = d[0]; }
    else if (i === n - 1) { dl = d[n - 2]; dr = loop ? d[0] : d[n - 2]; }
    else { dl = d[i - 1]; dr = d[i]; }
    if (dl * dr <= 0) m[i] = 0;
    else { m[i] = (dl + dr) / 2; const lim = 3 * Math.min(Math.abs(dl), Math.abs(dr)); if (Math.abs(m[i]) > lim) m[i] = Math.sign(m[i]) * lim; }
    if (!loop && (i === 0 || i === n - 1)) m[i] = 0;
  }
  return m;
}
function hermite(y0, y1, m0, m1, h, u) {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * h * m1;
}

// keys [{t, pose}] -> dense frames [{t, f}] at fps; per-frame IK for pinned legs
function sampleKeys(keys, { loop = false, fps = 30 } = {}) {
  const ts = keys.map(k => k.t), frames0 = keys.map(k => frameFromPose(k.pose));
  const dur = ts[ts.length - 1], n = keys.length;
  const count = Math.max(2, Math.round(dur * fps) + 1);
  const out = [];
  const tg = [];
  for (let c = 0; c < NCH; c++) tg.push(tangents(ts, frames0.map(f => f[c]), loop));
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const t = (i === count - 1) ? dur : i / fps;
    while (seg < n - 2 && t > ts[seg + 1]) seg++;
    const h = ts[seg + 1] - ts[seg], u = h > 0 ? (t - ts[seg]) / h : 0;
    const f = new Float64Array(NCH), a = frames0[seg], b = frames0[seg + 1];
    for (let c = 0; c < NCH; c++) f[c] = hermite(a[c], b[c], tg[c][seg], tg[c][seg + 1], h, u);
    // legs: blend FK angles with the IK solution by the interpolated ik weight
    for (const s of ['L', 'R']) {
      const leg = LEGS[s], w = f[CH[leg.ik] + 5];
      if (w <= 0.001) continue;
      const fkU = [f[CH[leg.up]], f[CH[leg.up] + 1], f[CH[leg.up] + 2]], fkL = f[CH[leg.leg]], fkF = f[CH[leg.foot]];
      solveLeg(f, s);
      if (w < 0.999) {
        const cu = CH[leg.up]; for (let k = 0; k < 3; k++) f[cu + k] = fkU[k] + (f[cu + k] - fkU[k]) * w;
        f[CH[leg.leg]] = fkL + (f[CH[leg.leg]] - fkL) * w; f[CH[leg.foot]] = fkF + (f[CH[leg.foot]] - fkF) * w;
      }
    }
    out.push({ t, f });
  }
  return out;
}

const _tq = new THREE.Quaternion();                // NOT _q: boneQuat uses _q for the delta internally
function tracksFromFrames(frames) {
  const times = frames.map(fr => fr.t), tracks = [];
  for (const b of BONE_NAMES) {
    const c = CH[b], vals = new Float32Array(frames.length * 4);
    frames.forEach((fr, i) => { boneQuat(b, [fr.f[c], fr.f[c + 1], fr.f[c + 2]], _tq); vals[i * 4] = _tq.x; vals[i * 4 + 1] = _tq.y; vals[i * 4 + 2] = _tq.z; vals[i * 4 + 3] = _tq.w; });
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, vals));
  }
  const hp = RIG.local.Hips.position, pv = new Float32Array(frames.length * 3);
  frames.forEach((fr, i) => { pv[i * 3] = hp.x + fr.f[CH.hips]; pv[i * 3 + 1] = hp.y + fr.f[CH.hips + 1]; pv[i * 3 + 2] = hp.z + fr.f[CH.hips + 2]; });
  const pt = new THREE.VectorKeyframeTrack('Hips.position', times, pv);
  pt.setInterpolation(THREE.InterpolateSmooth);
  tracks.push(pt);
  return tracks;
}

function makeClip(name, keys, { events = [], loop = false, fps = 30, userData = {} } = {}) {
  const frames = sampleKeys(keys, { loop, fps });
  sampled.set(sampleKey(name), frames);
  const clip = new THREE.AnimationClip(name, frames[frames.length - 1].t, tracksFromFrames(frames));
  clip.userData = { events, loop, ...userData, ...(FIT ? { fit: FIT.key } : {}) };
  return clip;
}
// frames generated procedurally (already dense): run IK per frame, no resampling
function makeClipFromFrames(name, frames, opts = {}) {
  for (const fr of frames) for (const s of ['L', 'R']) if (fr.f[CH[LEGS[s].ik] + 5] > 0.5) solveLeg(fr.f, s);
  sampled.set(sampleKey(name), frames);
  const clip = new THREE.AnimationClip(name, frames[frames.length - 1].t, tracksFromFrames(frames));
  clip.userData = { events: [], loop: true, ...opts, ...(FIT ? { fit: FIT.key } : {}) };
  return clip;
}

// later poses override earlier ones; a leg given as FK angles drops an inherited ik target for that side and vice versa
const LEG_FK = /^(Left|Right)(UpLeg|Leg|Foot)$/;
function mix(...poses) {
  const out = {};
  for (const p of poses) for (const k in p) {
    if (k === 'ikL' || k === 'ikR') { const s = k === 'ikL' ? 'Left' : 'Right'; delete out[s + 'UpLeg']; delete out[s + 'Leg']; delete out[s + 'Foot']; }
    else if (LEG_FK.test(k)) delete out[k.startsWith('Left') ? 'ikL' : 'ikR'];
    out[k] = p[k];
  }
  return out;
}
const ease = (a, b, u) => a + (b - a) * (u * u * (3 - 2 * u));

// ------------------------------------------------------------------ arm solve (authoring helper)
// 2-bone arm IK: wrist target + elbow hint in character space -> { <side>Arm:[x,y,z], <side>ForeArm:[x,0,0] }.
// Same construction as the leg: the upper arm's world frame is aimed at the elbow with its local +Z on the side the
// forearm bends to (the elbow flexes about local X toward +Z), so the forearm is an exact positive hinge.
function eulerMin(q) {                              // XYZ Euler (deg) of q, the representation nearest to zero
  _e.setFromQuaternion(q, 'XYZ');
  const a = [_e.x * R2D, _e.y * R2D, _e.z * R2D];
  const wrap = (x) => ((x + 180) % 360 + 360) % 360 - 180;
  const b = [wrap(a[0] + 180), wrap(180 - a[1]), wrap(a[2] + 180)];
  const na = Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]), nb = Math.abs(b[0]) + Math.abs(b[1]) + Math.abs(b[2]);
  return nb < na - 1e-6 ? b : a;
}
function armIK(base, side, wrist, elbowHint) {
  const arm = side + 'Arm', fore = side + 'ForeArm', sh = side + 'Shoulder';
  const pose = { ...base }; delete pose[arm]; delete pose[fore];
  const fk0 = fkFrame(frameFromPose(pose));
  const fit = FIT?.arms?.[side];
  const S = fk0.pos[arm].clone(), L1 = fit ? fit[0] : RIG.world[arm].length, L2 = fit ? fit[1] : RIG.world[fore].length;
  // wrist: [x,y,z] in character space, or { dir:[x,y,z], ext:0..1 } = reach from wherever the shoulder is now
  const W = Array.isArray(wrist) ? new THREE.Vector3(...wrist) : S.clone().addScaledVector(new THREE.Vector3(...wrist.dir).normalize(), (wrist.ext ?? 0.95) * (L1 + L2));
  const u = W.clone().sub(S);
  let d = Math.min(u.length(), (L1 + L2) * 0.995); d = Math.max(d, Math.abs(L1 - L2) + 0.03); u.normalize();
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), r = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const C = S.clone().addScaledVector(u, a);
  const h = new THREE.Vector3(...elbowHint).sub(C); h.addScaledVector(u, -h.dot(u));
  if (h.lengthSq() < 1e-6) h.set(0, -1, 0).addScaledVector(u, u.y);
  const E = C.clone().addScaledVector(h.normalize(), r);
  const Wr = S.clone().addScaledVector(u, d);
  const dirUp = E.clone().sub(S).normalize(), dirFore = Wr.clone().sub(E).normalize();
  // bend side: forearm direction ⊥ upper arm (or the hint when the arm is straight)
  const bend = dirFore.clone().addScaledVector(dirUp, -dirFore.dot(dirUp));
  if (bend.lengthSq() < 1e-4) bend.copy(h);
  const qUp = frameQuat(dirUp, bend, new THREE.Quaternion());
  const xAxis = new THREE.Vector3().crossVectors(dirUp, bend).normalize();
  const qFore = frameQuat(dirFore, new THREE.Vector3().crossVectors(xAxis, dirFore), new THREE.Quaternion());
  const dUp = RIG.local[arm].quaternion.clone().invert().multiply(fk0.quat[sh].clone().invert().multiply(qUp));
  const flex = Math.acos(clamp1(dirUp.dot(dirFore))) * R2D;
  void qFore;
  return { [arm]: mirrored(arm, eulerMin(dUp)), [fore]: [Math.max(0, flex), 0, 0] };
}
// pose = base + torso overrides + solved arms ([side, wrist, elbowHint] ...)
function P(base, torso, ...arms) { const p = mix(base, torso); for (const a of arms) Object.assign(p, armIK(p, a[0], a[1], a[2])); return p; }

// ------------------------------------------------------------------ locomotion (procedural foot paths + IK)
// stance: the contact point slides back at exactly -speed under a rocker foot (heel strike -> flat -> toe off) so
// the planted foot never slides at timeScale 1; swing: forward arc with knee lift.
// Phase: right heel strike at 0.25, left at 0.75; 0 = left mid-stance / right leg passing.
// cycles > 1 lays several identical gait cycles end to end (a longer loop for an upper-body overlay, see pedLoco)
// Optional run shaping (all default off, so walks and crowd runs are unchanged): off shifts the stance forward/back of the
// hip (runners land nearly under the body and push off far behind it); heel/heelBack fold the heel up behind the hip early in
// the swing (heel recovery); knee holds the foot high and forward late in the swing (knee drive); armDrive opens the elbow
// behind and closes it in front, armBias carries the swing forward of the trunk.
function locomotionFrames({ dur, speed, stanceFrac, lift, hipDrop, bob, bobPhase = 0, sway, drop, twist, armSwing, elbow, lean, width = 0.12, fps = 60, cycles = 1,
  off = 0, heel = 0, heelBack = 0, knee = 0, armDrive = 0, armBias = 0, plantedOnly = false }) {
  const frames = [], count = Math.round(dur * cycles * fps) + 1;
  const stepLen = speed * stanceFrac * dur, half = stepLen / 2;
  const footRel = (ph) => {             // ph in [0,1): 0 = heel strike
    if (ph < stanceFrac) {
      const u = ph / stanceFrac;          // contact point z runs +half -> -half at -speed
      const cz = half - u * stepLen + off;
      let pitch, ay = ANKLE_Y, az = cz;
      if (u < 0.16) { const k = 1 - u / 0.16, th = 14 * k * D2R; pitch = 14 * k; az = cz + HEEL_Z * (Math.cos(th) - 1) - SOLE_Y * Math.sin(th); ay = ANKLE_Y + HEEL_Z * Math.sin(th) + SOLE_Y * (Math.cos(th) - 1); }   // heel rocker (pivot at the heel)
      else if (u < 0.6) pitch = 0;
      else { const k = (u - 0.6) / 0.4; pitch = -ease(0, TOE_OFF, k); const a = -pitch * D2R; az = cz + TOE_Z * (1 - Math.cos(a)) + SOLE_Y * Math.sin(a); ay = ANKLE_Y + TOE_Z * Math.sin(a) + SOLE_Y * (Math.cos(a) - 1); } // toe rocker (pivot at the toe)
      return { z: az, y: ay, pitch, stance: true, u };
    }
    const u = (ph - stanceFrac) / (1 - stanceFrac);       // swing: back -> front
    const a0 = TOE_OFF * D2R, zStart = -half + off + TOE_Z * (1 - Math.cos(a0)) + SOLE_Y * Math.sin(a0), yStart = ANKLE_Y + TOE_Z * Math.sin(a0) + SOLE_Y * (Math.cos(a0) - 1);
    const dz = half + off - 0.02 - zStart, tSwing = (1 - stanceFrac) * dur;
    // Hermite with end slopes matching the stance velocity so the foot has ~zero world velocity at toe-off and touchdown
    const m = -speed * tSwing / dz, s = (1 - m) * u * u * (3 - 2 * u) + m * u;
    // sin² bumps keep the end velocities, so touchdown and toe-off still match the stance foot
    const s2 = Math.sin(Math.PI * u) ** 2, early = s2 * (1 - u) ** 1.5 / 0.422, late = s2 * u ** 1.5 / 0.422;
    const z = zStart + dz * s - heelBack * early;
    const sy = u * u * (3 - 2 * u);
    const y = yStart * (1 - sy) + (ANKLE_Y + 0.012) * sy + lift * Math.sin(Math.PI * u) * (1 - 0.35 * u) + heel * early + knee * late;
    const pitch = u < 0.4 ? ease(-38, -4, u / 0.4) : ease(-4, 14, (u - 0.4) / 0.6);
    return { z, y, pitch, stance: false, u };
  };
  for (let i = 0; i < count; i++) {
    const t = i / fps, ph = (t / dur) % 1;
    const f = new Float64Array(NCH);
    const L = footRel((ph + 0.25) % 1), R = footRel((ph + 0.75) % 1);
    const s1 = Math.sin(2 * Math.PI * ph), c1 = Math.cos(2 * Math.PI * ph);     // s1 +1: right leg forward; c1 +1: left mid-stance
    const cb = Math.cos(4 * Math.PI * (ph - bobPhase));                          // +1 at the high points
    f[CH.hips + 1] = -hipDrop + bob * 0.5 * (1 + cb);
    f[CH.hips] = sway * c1;                    // pelvis shifts over the stance foot
    f[CH.Hips] = lean * 0.3; f[CH.Hips + 1] = twist * s1; f[CH.Hips + 2] = drop * c1;   // pelvis turns with the leading leg, swing-side hip drops
    f[CH.Spine] = lean * 0.4; f[CH.Spine1] = lean * 0.3; f[CH.Spine2] = lean * 0.15;
    f[CH.Spine1 + 1] = -twist * 1.0 * s1; f[CH.Spine2 + 1] = -twist * 0.4 * s1; f[CH.Head + 1] = twist * 0.4 * s1;   // shoulders counter-rotate, head stays on target
    f[CH.Spine1 + 2] = -drop * 0.6 * c1; f[CH.Spine2 + 2] = -drop * 0.4 * c1;
    f[CH.Neck] = -lean * 0.45; f[CH.Head] = -lean * 0.45 - bob * 40 * cb;
    const aL = armBias + armSwing * s1, aR = armBias - armSwing * s1;         // left arm forward with the right leg
    f[CH.LeftArm] = aL; f[CH.RightArm] = aR;
    f[CH.LeftArm + 2] = 5 + Math.max(0, -aL) * 0.08; f[CH.RightArm + 2] = 5 + Math.max(0, -aR) * 0.08;
    f[CH.LeftArm + 1] = 8; f[CH.RightArm + 1] = 8;
    const fore = (a) => armDrive ? elbow + armDrive * (Math.max(0, a) * 0.12 - Math.max(0, -a) * 0.3) : elbow + Math.max(0, a) * 0.5;
    f[CH.LeftForeArm] = fore(aL); f[CH.RightForeArm] = fore(aR);
    f[CH.LeftShoulder] = aL * 0.15; f[CH.RightShoulder] = aR * 0.15;
    f[CH.LeftHand] = 8; f[CH.RightHand] = 8;
    const cL = CH.ikL, cR = CH.ikR;
    f[cL] = width + (L.stance ? 0 : -0.02 * Math.sin(Math.PI * L.u)); f[cL + 1] = L.y; f[cL + 2] = L.z; f[cL + 3] = L.pitch; f[cL + 4] = 7; f[cL + 5] = 1;
    f[cR] = -width + (R.stance ? 0 : 0.02 * Math.sin(Math.PI * R.u)); f[cR + 1] = R.y; f[cR + 2] = R.z; f[cR + 3] = R.pitch; f[cR + 4] = 7; f[cR + 5] = 1;
    frames.push({ t, f, planted: { L: L.stance, R: R.stance } });
  }
  // feasibility: lower the pelvis where a planted leg would otherwise hyper-extend, smoothed loop-aware
  const hipJointY = RIG.joints.LeftUpLeg[1], maxD = (L_THIGH + L_SHIN) * 0.985;
  // plantedOnly: a leg in the air may fall short of its target (the IK clamps it); only a foot on the ground holds the pelvis down
  const need = frames.map(fr => {
    let y = Infinity;
    for (const s of ['L', 'R']) {
      if (plantedOnly && !fr.planted[s]) continue;
      const c = CH[LEGS[s].ik];
      const dx = fr.f[c] - (fr.f[CH.hips] + (s === 'L' ? 0.1 : -0.1)), dz = fr.f[c + 2] - fr.f[CH.hips + 2], planar = dx * dx + dz * dz;
      if (planar < maxD * maxD) y = Math.min(y, fr.f[c + 1] + Math.sqrt(maxD * maxD - planar) - hipJointY);
    }
    return y;
  });
  const n = frames.length - 1, sm = new Float64Array(n);
  for (let i = 0; i < n; i++) { let a = Infinity; for (let k = -4; k <= 4; k++) a = Math.min(a, need[(i + k + n) % n]); sm[i] = a; }
  for (let i = 0; i < n; i++) { let a = 0; for (let k = -3; k <= 3; k++) a += sm[(i + k + n) % n]; frames[i].f[CH.hips + 1] = Math.min(frames[i].f[CH.hips + 1], a / 7); }
  frames[n].f.set(frames[0].f);
  return frames;
}

// ------------------------------------------------------------------ reusable poses
const RELAX = { LeftArm: [4, 0, 5], RightArm: [4, 0, 5], LeftForeArm: [12, 0, 0], RightForeArm: [12, 0, 0], LeftHand: [6, 0, 0], RightHand: [6, 0, 0],
  LeftShoulder: [0, 0, 0], RightShoulder: [0, 0, 0] };
const STAND = { ikL: [0.13, ANKLE_Y, 0.02, 0, 8], ikR: [-0.13, ANKLE_Y, -0.02, 0, 8], hips: [0, -0.02, 0] };

// boxing stance: bladed, left foot forward, weight on the balls of the feet, fists at the chin
const STANCE_L = [0.16, ANKLE_Y, 0.30, 0, 6], STANCE_R = [-0.20, ANKLE_Y + 0.02, -0.16, -8, 32];
const COMBAT = {
  hips: [-0.02, -0.11, 0.02], Hips: [2, -22, 0],
  Spine: [5, 4, 0], Spine1: [3, 4, 0], Spine2: [2, 2, -2], Neck: [-4, 6, 0], Head: [-2, 6, 0],
  LeftShoulder: [10, 0, 2], RightShoulder: [6, 0, 6],
  LeftArm: [49, -11, 6], LeftForeArm: [120, 0, 0], LeftHand: [10, 0, 10],     // lead fist at cheek height, 0.42 m out
  RightArm: [56, 18, -34], RightForeArm: [124, 0, 0], RightHand: [8, 0, 10],  // rear fist tucked by the chin
  ikL: STANCE_L, ikR: STANCE_R,
};
const KNOCKED = { Hips: [-86, 0, 0], hips: [0, -0.82, -0.30], Spine: [-6, 0, 0], Spine1: [-2, 0, 0], Head: [-4, 0, 0],
  LeftShoulder: [0, 0, 0], RightShoulder: [0, 0, 0], LeftArm: [-30, 0, 55], RightArm: [-30, 0, 55], LeftForeArm: [20, 0, 0], RightForeArm: [20, 0, 0],
  LeftUpLeg: [-8, 0, 6], RightUpLeg: [-9, 0, 9], LeftLeg: [-2, 0, 0], RightLeg: [-4, 0, 0], LeftFoot: [42, 0, 0], RightFoot: [46, 0, 0] };
// forearm twist about its own axis (pronation +) after an IK solve: rolls the fist without moving the wrist
function twist(pose, side, deg) { const k = side + 'ForeArm', a = pose[k] || [0, 0, 0]; pose[k] = [a[0], deg, a[2]]; return pose; }
// high guard: fists at the temples, elbows tucked, chin down, hunched
const GUARD = mix(COMBAT, { hips: [-0.03, -0.15, 0.0], Hips: [4, -20, 0], Spine: [12, 4, 0], Spine1: [6, 4, 0], Spine2: [3, 2, -2], Neck: [2, 6, 0], Head: [8, 6, 0],
  LeftShoulder: [12, 0, 6], RightShoulder: [10, 0, 8], LeftArm: [62, -22, 12], LeftForeArm: [142, 0, 0], LeftHand: [10, 0, 20], RightArm: [64, 22, -30], RightForeArm: [144, 0, 0], RightHand: [10, 0, 20] });
// lapel grab: both hands closed on the collar at chest height, weight forward
const GRAB = P(COMBAT, { Hips: [6, -6, 0], hips: [0.0, -0.13, 0.06], Spine: [10, 2, 0], Spine1: [4, 0, 0], Neck: [-6, 2, 0], Head: [-4, 2, 0],
  LeftShoulder: [14, 0, 2], RightShoulder: [14, 0, 2], LeftHand: [-14, 0, 0], RightHand: [-14, 0, 0], ikR: ballPivot('R', STANCE_R, 14, 24) },
  ['Left', { dir: [-0.16, -0.08, 1], ext: 0.80 }, [0.40, 1.04, 0.22]], ['Right', { dir: [0.16, -0.08, 1], ext: 0.80 }, [-0.40, 1.04, 0.22]]);
// bench sit (seat ≈ 0.45 m): slouched forward, forearms on the thighs
const SIT = { hips: [0, -0.42, -0.05], Hips: [-6, 0, 0], Spine: [14, 0, 0], Spine1: [8, 0, 0], Spine2: [2, 0, 0], Neck: [-6, 0, 0], Head: [-4, 0, 0],
  LeftShoulder: [8, 0, -2], RightShoulder: [8, 0, -2], LeftArm: [58, 10, 4], LeftForeArm: [26, 0, 0], LeftHand: [-20, 0, -10], RightArm: [60, 10, 4], RightForeArm: [24, 0, 0], RightHand: [-20, 0, 10],
  LeftUpLeg: [86, 0, 8], LeftLeg: [-86, 0, 0], LeftFoot: [-4, 0, 0], RightUpLeg: [82, 0, 12], RightLeg: [-76, 0, 0], RightFoot: [-8, 0, 0] };

// ------------------------------------------------------------------ clip builders
const BUILDERS = {
  // yakuza stand: feet a little wide, weight on the right leg, chest out / shoulders back, arms held off the body
  idle: () => {
    const base = mix(RELAX, { ikL: [0.17, ANKLE_Y, 0.03, 0, 12], ikR: [-0.15, ANKLE_Y, -0.03, 0, 8], hips: [-0.012, -0.012, 0], Hips: [0, 0, 0.5],
      Spine: [-2, 0, -1], Spine1: [-2, 0, -1], Spine2: [-1, 0, 0], Neck: [2, 0, 0], Head: [0, 0, 0],
      LeftShoulder: [-4, 0, 1], RightShoulder: [-4, 0, 1], LeftArm: [2, 4, 10], RightArm: [2, 4, 9], LeftForeArm: [16, 0, 0], RightForeArm: [14, 0, 0], LeftHand: [8, 0, 4], RightHand: [8, 0, 4] });
    return makeClip('idle', [
      { t: 0, pose: base },
      { t: 1.2, pose: mix(base, { Spine2: [1, 0, 0], Spine1: [-0.5, 0, -1], Neck: [1, 0, 0], Head: [-1, 6, 1], LeftShoulder: [-4, 0, 3], RightShoulder: [-4, 0, 3], hips: [-0.01, -0.017, 0.003] }) },
      { t: 2.4, pose: mix(base, { Spine2: [-1, 0, 0], Head: [1, -5, -1], hips: [-0.015, -0.012, 0], Hips: [0, -1, 0.5] }) },
      { t: 3.2, pose: mix(base, { Spine2: [1, 0, 0], Neck: [1, 0, 0], Head: [0, -2, 0], LeftShoulder: [-4, 0, 3], RightShoulder: [-4, 0, 3], hips: [-0.01, -0.016, 0.002] }) },
      { t: 4.0, pose: base },
    ], { loop: true });
  },
  idle_combat: () => makeClip('idle_combat', [
    { t: 0, pose: COMBAT },
    { t: 0.35, pose: mix(COMBAT, { hips: [-0.03, -0.125, -0.01], Hips: [2, -24, 0], Spine2: [3, 2, -2], LeftArm: [51, -11, 6], RightArm: [58, 18, -34], Head: [-2, 7, 0] }) },
    { t: 0.7, pose: mix(COMBAT, { hips: [-0.01, -0.105, 0.04], Hips: [3, -20, 0], Spine: [6, 5, 0], LeftArm: [47, -11, 6], LeftForeArm: [118, 0, 0], RightArm: [54, 18, -34] }) },
    { t: 1.05, pose: mix(COMBAT, { hips: [-0.03, -0.12, 0.0], Hips: [2, -23, 0], Spine2: [2, 3, -1], Head: [-1, 5, 0] }) },
    { t: 1.4, pose: COMBAT },
  ], { loop: true }),
  walk: () => {
    const duration=FIT?.rig?.hero ? .8 : DURATIONS.walk;
    const speed=FIT?.rig?.hero ? HERO_WALK_SPEED : WALK_SPEED;
    const frames = locomotionFrames({ dur: duration, speed, stanceFrac: 0.55,
      lift: 0.07, hipDrop: 0.025, bob: 0.018, bobPhase: 0, sway: 0.014, drop: 3, twist: 7, armSwing: 22, elbow: 14, lean: 3, width: 0.12 });
    return makeClipFromFrames('walk', frames, { speed, stride: speed * duration,
      events: [{ time: duration * 0.25, name: 'footstep', foot: 'R', bone: 'RightFoot' }, { time: duration * 0.75, name: 'footstep', foot: 'L', bone: 'LeftFoot' }] });
  },
  run: () => {
    // Hero: an athletic run — short contact, a real flight phase, push-off leg long behind, heel folded up then the knee
    // driven high, elbows near 90° swinging shoulder-to-hip, body tipped forward and chest up. Crowd runs keep the old gait.
    const frames = locomotionFrames(FIT?.rig?.hero
      ? { dur: DURATIONS.run, speed: RUN_SPEED, stanceFrac: 0.24, off: -0.08, lift: 0.10, heel: 0.24, heelBack: 0.10, knee: 0.28,
        hipDrop: 0.02, bob: 0.045, bobPhase: 0.12, sway: 0.008, drop: 3, twist: 10, armSwing: 40, elbow: 86, armDrive: 1, armBias: 2, lean: 13, width: 0.09, plantedOnly: true }
      : { dur: DURATIONS.run, speed: RUN_SPEED, stanceFrac: 0.28,
        lift: 0.23, hipDrop: 0.035, bob: 0.025, bobPhase: 0.18, sway: 0.009, drop: 2, twist: 8, armSwing: 34, elbow: 72, lean: 9, width: 0.10 });
    return makeClipFromFrames('run', frames, { speed: RUN_SPEED, stride: RUN_SPEED * DURATIONS.run,
      events: [{ time: DURATIONS.run * 0.25, name: 'footstep', foot: 'R', bone: 'RightFoot' }, { time: DURATIONS.run * 0.75, name: 'footstep', foot: 'L', bone: 'LeftFoot' }] });
  },
  // ---------------------------------------------------------------- punches: anticipation -> contact -> follow-through
  // The lead (left) foot stays planted through every punch; the rear foot pivots on its ball as the hips drive.
  jab: () => makeClip('jab', [
    { t: 0, pose: COMBAT },
    { t: 0.06, pose: mix(COMBAT, { Hips: [3, -26, 0], hips: [-0.03, -0.12, -0.01], LeftShoulder: [4, 0, 2], LeftArm: [46, -11, 6], Head: [-1, 8, 0] }) },
    { t: 0.16, pose: twist(P(COMBAT, { Hips: [-2, -8, 0], hips: [0.0, -0.12, 0.09], Spine: [9, -4, 0], Spine1: [4, -6, 0], Spine2: [2, -4, -2], Neck: [-4, 2, 0], Head: [-1, 3, 0],
      LeftShoulder: [16, 0, 4], LeftHand: [0, 0, 6], ikR: ballPivot('R', STANCE_R, 22, 24) }, ['Left', { dir: [-0.16, 0.16, 1], ext: 0.985 }, [0.34, 1.10, 0.34]]), 'Left', 75) },
    { t: 0.22, pose: twist(P(COMBAT, { Hips: [-1, -10, 0], hips: [-0.01, -0.12, 0.07], Spine: [8, -3, 0], Spine1: [4, -5, 0], Spine2: [2, -3, -2], Neck: [-4, 3, 0], Head: [-1, 4, 0],
      LeftShoulder: [14, 0, 4], LeftHand: [2, 0, 6], ikR: ballPivot('R', STANCE_R, 18, 26) }, ['Left', { dir: [-0.12, 0.16, 1], ext: 0.95 }, [0.34, 1.10, 0.32]]), 'Left', 70) },
    { t: 0.35, pose: COMBAT },
  ], { events: [{ time: 0.16, name: 'hit', bone: 'LeftHand', radius: 0.25 }] }),
  straight: () => makeClip('straight', [
    { t: 0, pose: COMBAT },
    { t: 0.09, pose: mix(COMBAT, { Hips: [4, -30, 0], hips: [-0.04, -0.125, -0.03], RightShoulder: [-4, 0, 6], RightArm: [50, 18, -36], Spine1: [4, 8, 0], Head: [0, 8, 0] }) },
    { t: 0.20, pose: twist(P(COMBAT, { Hips: [2, 12, 0], hips: [0.02, -0.13, 0.11], Spine: [12, 6, 0], Spine1: [5, 10, 0], Spine2: [3, 6, -1], Neck: [-6, -8, 0], Head: [-2, -8, 0],
      RightShoulder: [18, 0, 4], RightHand: [0, 0, 4], LeftArm: [46, -8, 10], LeftForeArm: [124, 0, 0], ikR: ballPivot('R', STANCE_R, 34, 6) }, ['Right', { dir: [0.10, 0.22, 1], ext: 0.99 }, [-0.36, 1.08, 0.40]]), 'Right', 80) },
    { t: 0.27, pose: twist(P(COMBAT, { Hips: [2, 10, 0], hips: [0.01, -0.13, 0.10], Spine: [11, 5, 0], Spine1: [5, 9, 0], Spine2: [3, 5, -1], Neck: [-6, -7, 0], Head: [-2, -7, 0],
      RightShoulder: [16, 0, 4], RightHand: [2, 0, 4], LeftArm: [46, -8, 10], LeftForeArm: [124, 0, 0], ikR: ballPivot('R', STANCE_R, 30, 8) }, ['Right', { dir: [0.12, 0.22, 1], ext: 0.95 }, [-0.36, 1.08, 0.38]]), 'Right', 76) },
    { t: 0.45, pose: COMBAT },
  ], { events: [{ time: 0.20, name: 'hit', bone: 'RightHand', radius: 0.28 }] }),
  hook: () => makeClip('hook', [
    { t: 0, pose: COMBAT },
    { t: 0.12, pose: mix(COMBAT, { Hips: [4, -34, 0], hips: [-0.05, -0.13, -0.02], Spine1: [4, 10, 0], Spine2: [2, 6, -2], RightShoulder: [-6, 0, 8], RightArm: [34, 14, -30], RightForeArm: [104, 0, 0], RightHand: [0, 0, 10], Head: [0, 10, -2],
      ikR: ballPivot('R', STANCE_R, 6, 34) }) },
    { t: 0.27, pose: twist(P(COMBAT, { Hips: [4, 22, 0], hips: [0.06, -0.13, 0.06], Spine: [8, 10, 0], Spine1: [4, 14, 0], Spine2: [2, 10, -2], Neck: [-4, -18, 0], Head: [-2, -20, -3],
      RightShoulder: [16, 0, 8], RightHand: [-10, 0, 0], LeftArm: [44, -8, 10], LeftForeArm: [126, 0, 0], ikR: ballPivot('R', STANCE_R, 32, -4) }, ['Right', { dir: [0.7, 0.28, 1], ext: 0.72 }, [-0.46, 1.50, 0.24]]), 'Right', 30) },
    { t: 0.34, pose: twist(P(COMBAT, { Hips: [4, 30, 0], hips: [0.08, -0.13, 0.05], Spine: [8, 12, 0], Spine1: [4, 16, 0], Spine2: [2, 12, -2], Neck: [-4, -22, 0], Head: [-2, -24, -3],
      RightShoulder: [16, 0, 8], RightHand: [-10, 0, 0], LeftArm: [44, -8, 10], LeftForeArm: [126, 0, 0], ikR: ballPivot('R', STANCE_R, 34, -8) }, ['Right', { dir: [1.0, 0.2, 0.45], ext: 0.72 }, [-0.32, 1.52, 0.34]]), 'Right', 30) },
    { t: 0.5, pose: COMBAT },
  ], { events: [{ time: 0.27, name: 'hit', bone: 'RightHand', radius: 0.30 }] }),
  uppercut: () => makeClip('uppercut', [
    { t: 0, pose: COMBAT },
    { t: 0.15, pose: mix(COMBAT, { Hips: [8, -32, 2], hips: [-0.05, -0.21, -0.02], Spine: [18, 6, -4], Spine1: [8, 8, 0], Spine2: [4, 4, -2], Neck: [-8, 6, 0], Head: [-4, 8, 0],
      RightShoulder: [-4, 0, 2], RightArm: [12, 12, -16], RightForeArm: [76, 0, 0], RightHand: [0, 0, 6], LeftArm: [40, -8, 8], LeftForeArm: [118, 0, 0], ikR: ballPivot('R', STANCE_R, 0, 30) }) },
    { t: 0.30, pose: twist(P(COMBAT, { Hips: [-4, 10, -2], hips: [0.03, -0.09, 0.08], Spine: [-4, 6, 2], Spine1: [-4, 10, 0], Spine2: [-2, 6, 0], Neck: [-8, -6, 0], Head: [-8, -6, 0],
      RightShoulder: [8, 0, 10], RightHand: [10, 0, 0], LeftArm: [46, -8, 8], LeftForeArm: [124, 0, 0], ikR: ballPivot('R', STANCE_R, 36, 8) }, ['Right', { dir: [0.2, 0.32, 0.88], ext: 0.66 }, [-0.34, 0.96, 0.46]]), 'Right', -70) },
    { t: 0.38, pose: twist(P(COMBAT, { Hips: [-6, 14, -2], hips: [0.04, -0.06, 0.08], Spine: [-8, 8, 2], Spine1: [-6, 12, 0], Spine2: [-3, 6, 0], Neck: [-10, -8, 0], Head: [-10, -8, 0],
      RightShoulder: [6, 0, 14], RightHand: [10, 0, 0], LeftArm: [46, -8, 8], LeftForeArm: [124, 0, 0], ikR: ballPivot('R', STANCE_R, 38, 8) }, ['Right', { dir: [0.25, 0.75, 0.55], ext: 0.74 }, [-0.34, 1.04, 0.46]]), 'Right', -70) },
    { t: 0.55, pose: COMBAT },
  ], { events: [{ time: 0.30, name: 'hit', bone: 'RightHand', radius: 0.28 }] }),

  // ---------------------------------------------------------------- kicks (kicking leg FK, support leg IK on a ball pivot)
  // Rear-leg head kick: load -> chamber -> pivot/hip turn -> shin/instep contact -> recoil -> guard.
  kick: () => makeClip('kick', [
    { t: 0, pose: COMBAT },
    { t: 0.13, pose: mix(COMBAT, { Hips: [2,-18,0], hips: [0.08,-0.08,0.01], Spine: [4,-6,0],
      LeftArm: [48,-8,14], LeftForeArm: [120,0,0], RightArm: [38,10,-22], RightForeArm: [116,0,0],
      ikL: ballPivot('L', STANCE_L, 3, 18) }) },
    { t: 0.26, pose: mix(COMBAT, { Hips: [-3,22,-7], hips: [0.10,-0.05,0.02], Spine: [-4,8,-8], Spine1: [-2,6,-5], Neck: [2,-14,4], Head: [2,-18,4],
      LeftArm: [48,-10,12], LeftForeArm: [122,0,0], RightArm: [-12,0,34], RightForeArm: [55,0,0],
      RightUpLeg: [55,-8,90], RightLeg: [-118,0,0], RightFoot: [-18,0,0], ikL: ballPivot('L', STANCE_L, 8, 65) }) },
    { t: 0.40, pose: mix(COMBAT, { Hips: [-4,78,-8], hips: [0.10,-0.045,0.025], Spine: [-6,8,-12], Spine1: [-3,6,-6], Spine2: [-2,4,-3], Neck: [2,-34,5], Head: [2,-42,5],
      LeftArm: [48,-10,12], LeftForeArm: [122,0,0], RightArm: [-24,0,42], RightForeArm: [36,0,0],
      RightUpLeg: [25,0,114], RightLeg: [-12,0,0], RightFoot: [-28,0,0], ikL: ballPivot('L', STANCE_L, 12, 125) }) },
    { t: 0.46, pose: mix(COMBAT, { Hips: [-3,98,-8], hips: [0.10,-0.05,0.015], Spine: [-5,8,-10], Spine1: [-3,6,-5], Spine2: [-1,4,-2], Neck: [2,-40,4], Head: [2,-45,4],
      LeftArm: [48,-10,12], LeftForeArm: [120,0,0], RightArm: [-28,0,42], RightForeArm: [38,0,0],
      RightUpLeg: [18,0,113], RightLeg: [-28,0,0], RightFoot: [-24,0,0], ikL: ballPivot('L', STANCE_L, 12, 132) }) },
    { t: 0.60, pose: mix(COMBAT, { Hips: [-2,42,-4], hips: [0.08,-0.06,0.01], Spine: [0,6,-4], Spine1: [0,4,-2], Neck: [0,-18,2], Head: [0,-24,2],
      LeftArm: [46,-8,14], LeftForeArm: [118,0,0], RightArm: [24,8,-22], RightForeArm: [100,0,0],
      RightUpLeg: [48,0,65], RightLeg: [-106,0,0], RightFoot: [-14,0,0], ikL: ballPivot('L', STANCE_L, 6, 65) }) },
    { t: 0.78, pose: COMBAT },
  ], { events: [{ time: 0.40, name: 'hit', bone: 'RightFoot', radius: 0.27 }] }),
  roundhouse: () => makeClip('roundhouse', [
    { t: 0, pose: COMBAT },
    { t: 0.18, pose: mix(COMBAT, { Hips: [2, 12, -6], hips: [0.10, -0.13, 0.03], Spine: [-2, 14, -8], Spine1: [-2, 8, -4], Neck: [0, -18, 4], Head: [0, -22, 4],
      LeftArm: [30, 0, 40], LeftForeArm: [60, 0, 0], LeftHand: [0, 0, 0], RightArm: [-18, 0, 30], RightForeArm: [46, 0, 0],
      RightUpLeg: [40, -10, 62], RightLeg: [-124, 0, 0], RightFoot: [-10, 0, 0], ikL: ballPivot('L', STANCE_L, 10, 44) }) },
    { t: 0.36, pose: mix(COMBAT, { Hips: [-4, 70, -14], hips: [0.16, -0.17, 0.0], Spine: [-6, 16, -8], Spine1: [-4, 10, -4], Spine2: [-2, 6, -2], Neck: [0, -40, 6], Head: [0, -44, 6],
      LeftArm: [20, 0, 50], LeftForeArm: [40, 0, 0], LeftHand: [0, 0, 0], RightArm: [-24, 0, 36], RightForeArm: [30, 0, 0],
      RightUpLeg: [34, 0, 100], RightLeg: [-8, 0, 0], RightFoot: [-30, 0, 0], ikL: ballPivot('L', STANCE_L, 22, 70) }) },
    { t: 0.45, pose: mix(COMBAT, { Hips: [-2, 88, -10], hips: [0.16, -0.16, -0.03], Spine: [-4, 14, -6], Spine1: [-2, 8, -4], Neck: [0, -40, 4], Head: [0, -44, 4],
      LeftArm: [26, 0, 44], LeftForeArm: [46, 0, 0], LeftHand: [0, 0, 0], RightArm: [-20, 0, 32], RightForeArm: [36, 0, 0],
      RightUpLeg: [20, 0, 86], RightLeg: [-44, 0, 0], RightFoot: [-22, 0, 0], ikL: ballPivot('L', STANCE_L, 22, 88) }) },
    { t: 0.60, pose: mix(COMBAT, { Hips: [2, 28, -2], hips: [0.08, -0.13, 0.00], Spine: [4, 8, -2], Spine1: [2, 4, 0], Neck: [-2, -10, 0], Head: [-2, -12, 0],
      LeftArm: [40, -8, 16], LeftForeArm: [104, 0, 0], RightArm: [30, 12, -20], RightForeArm: [100, 0, 0],
      RightUpLeg: [24, -8, 30], RightLeg: [-60, 0, 0], RightFoot: [-16, 0, 0], ikL: ballPivot('L', STANCE_L, 6, 40) }) },
    { t: 0.75, pose: COMBAT },
  ], { events: [{ time: 0.36, name: 'hit', bone: 'RightFoot', radius: 0.35 }] }),

  // ---------------------------------------------------------------- guard / dodge / reactions
  guard: () => makeClip('guard', [
    { t: 0, pose: GUARD },
    { t: 0.6, pose: mix(GUARD, { hips: [-0.03, -0.155, 0.0], Spine2: [5, 2, -2], LeftArm: [64, -22, 12], RightArm: [66, 22, -30], Head: [9, 6, 0] }) },
    { t: 1.2, pose: GUARD },
  ], { loop: true }),
  guard_hit: () => makeClip('guard_hit', [
    { t: 0, pose: GUARD },
    { t: 0.07, pose: mix(GUARD, { Hips: [-4, -20, 0], hips: [-0.03, -0.15, -0.06], Spine: [-2, 4, 0], Spine1: [-6, 4, 0], Neck: [-2, 6, 0], Head: [12, 6, 0],
      LeftArm: [56, -24, 4], LeftForeArm: [150, 0, 0], RightArm: [58, 24, -36], RightForeArm: [150, 0, 0], ikR: [-0.20, ANKLE_Y + 0.03, -0.20, -14, 32] }) },
    { t: 0.16, pose: mix(GUARD, { Hips: [0, -22, 0], hips: [-0.03, -0.15, -0.08], Spine: [6, 4, 0], Spine1: [-2, 4, 0], Head: [10, 6, 0],
      LeftArm: [60, -22, 8], LeftForeArm: [146, 0, 0], RightArm: [62, 22, -34], RightForeArm: [146, 0, 0], ikR: [-0.20, ANKLE_Y + 0.02, -0.26, -8, 32] }) },
    { t: 0.35, pose: mix(GUARD, { ikR: [-0.20, ANKLE_Y + 0.02, -0.24, -8, 32], hips: [-0.03, -0.145, -0.03] }) },
  ]),
  dodge: () => makeClip('dodge', [
    { t: 0, pose: COMBAT },
    { t: 0.08, pose: mix(COMBAT, { Hips: [14, -14, 0], hips: [-0.02, -0.22, 0.06], Spine: [24, 2, 0], Spine1: [10, 2, 0], Neck: [-10, 4, 0], Head: [-8, 4, 0],
      LeftArm: [56, -12, 10], LeftForeArm: [116, 0, 0], RightArm: [40, 18, -30], RightForeArm: [116, 0, 0], ikL: [0.16, ANKLE_Y, 0.42, 0, 6], ikR: ballPivot('R', [-0.20, ANKLE_Y, -0.30, 0, 24], 36) }) },
    { t: 0.20, pose: mix(COMBAT, { Hips: [16, -10, 0], hips: [0.02, -0.20, 0.10], Spine: [26, 0, 0], Spine1: [10, 0, 0], Neck: [-12, 4, 0], Head: [-10, 4, 0],
      LeftArm: [58, -12, 10], LeftForeArm: [116, 0, 0], RightArm: [40, 18, -30], RightForeArm: [116, 0, 0], ikL: ballPivot('L', [0.16, ANKLE_Y, 0.06, 0, 6], 20), ikR: [-0.18, ANKLE_Y + 0.16, 0.10, -20, 18] }) },
    { t: 0.32, pose: mix(COMBAT, { Hips: [8, -18, 0], hips: [-0.02, -0.16, 0.04], Spine: [14, 2, 0], Spine1: [6, 2, 0], Neck: [-6, 4, 0], Head: [-4, 5, 0],
      ikL: [0.16, ANKLE_Y + 0.02, 0.16, 8, 6], ikR: [-0.20, ANKLE_Y, -0.24, 0, 28] }) },
    { t: 0.45, pose: COMBAT },
  ]),
  hit_light: () => makeClip('hit_light', [
    { t: 0, pose: COMBAT },
    { t: 0.06, pose: mix(COMBAT, { Hips: [-2, -20, 0], hips: [-0.02, -0.11, -0.03], Spine: [-4, 2, 0], Spine1: [-8, 12, 2], Spine2: [-4, 6, 0], Neck: [-12, 14, 4], Head: [-22, 20, 8],
      LeftShoulder: [4, 0, 8], RightShoulder: [2, 0, 10], LeftArm: [42, -11, 14], LeftForeArm: [110, 0, 0], RightArm: [48, 18, -40], RightForeArm: [112, 0, 0] }) },
    { t: 0.14, pose: mix(COMBAT, { Hips: [-2, -20, 0], hips: [-0.02, -0.12, -0.08], Spine: [-2, 2, 0], Spine1: [-6, 10, 2], Neck: [-8, 10, 3], Head: [-14, 14, 6],
      LeftArm: [44, -11, 12], RightArm: [50, 18, -38], ikR: [-0.20, ANKLE_Y + 0.05, -0.24, -16, 30] }) },
    { t: 0.22, pose: mix(COMBAT, { Hips: [1, -22, 0], hips: [-0.02, -0.12, -0.10], Spine: [3, 3, 0], Spine1: [-2, 6, 0], Neck: [-4, 8, 1], Head: [-6, 9, 3],
      ikR: [-0.20, ANKLE_Y + 0.02, -0.30, -8, 32] }) },
    { t: 0.4, pose: mix(COMBAT, { hips: [-0.02, -0.115, -0.04], ikR: [-0.20, ANKLE_Y + 0.02, -0.22, -8, 32] }) },
  ]),
  hit_heavy: () => makeClip('hit_heavy', [
    { t: 0, pose: COMBAT },
    { t: 0.08, pose: mix(COMBAT, { Hips: [-8, -14, 0], hips: [-0.02, -0.10, -0.06], Spine: [-8, 0, 0], Spine1: [-12, 8, 2], Spine2: [-6, 4, 0], Neck: [-14, 6, 4], Head: [-30, 12, 8],
      LeftShoulder: [-4, 0, 14], RightShoulder: [-4, 0, 14], LeftArm: [44, -6, 36], LeftForeArm: [70, 0, 0], LeftHand: [0, 0, 0], RightArm: [34, 8, 44], RightForeArm: [64, 0, 0], RightHand: [0, 0, 0] }) },
    { t: 0.18, pose: mix(COMBAT, { Hips: [-10, -12, 0], hips: [-0.01, -0.12, -0.14], Spine: [-8, 0, 0], Spine1: [-12, 6, 2], Spine2: [-6, 4, 0], Neck: [-10, 4, 3], Head: [-22, 8, 6],
      LeftArm: [42, -6, 32], LeftForeArm: [74, 0, 0], LeftHand: [0, 0, 0], RightArm: [32, 8, 40], RightForeArm: [70, 0, 0], RightHand: [0, 0, 0], ikR: [-0.20, ANKLE_Y + 0.10, -0.30, -24, 28] }) },
    { t: 0.28, pose: mix(COMBAT, { Hips: [-6, -16, 0], hips: [-0.01, -0.14, -0.22], Spine: [-4, 2, 0], Spine1: [-8, 6, 2], Neck: [-6, 4, 2], Head: [-14, 6, 4],
      LeftArm: [52, -8, 24], LeftForeArm: [80, 0, 0], RightArm: [44, 12, 20], RightForeArm: [80, 0, 0], ikR: [-0.22, ANKLE_Y + 0.02, -0.46, -10, 30] }) },
    { t: 0.40, pose: mix(COMBAT, { Hips: [-2, -18, 0], hips: [-0.02, -0.14, -0.26], Spine: [2, 3, 0], Spine1: [-4, 5, 0], Neck: [-4, 5, 1], Head: [-8, 6, 2],
      LeftArm: [48, -10, 14], LeftForeArm: [100, 0, 0], RightArm: [48, 16, -10], RightForeArm: [100, 0, 0], ikL: [0.16, ANKLE_Y + 0.08, 0.16, 10, 8], ikR: [-0.22, ANKLE_Y + 0.02, -0.46, -8, 30] }) },
    { t: 0.52, pose: mix(COMBAT, { Hips: [2, -20, 0], hips: [-0.02, -0.13, -0.20], Spine: [5, 4, 0], Neck: [-4, 6, 0], Head: [-4, 6, 1],
      ikL: [0.16, ANKLE_Y, 0.04, 0, 6], ikR: [-0.22, ANKLE_Y + 0.02, -0.44, -8, 30] }) },
    { t: 0.7, pose: mix(COMBAT, { hips: [-0.02, -0.12, -0.10], ikL: [0.16, ANKLE_Y, 0.16, 0, 6], ikR: [-0.20, ANKLE_Y + 0.02, -0.30, -8, 32] }) },
  ]),
  stumble: () => makeClip('stumble', [
    { t: 0, pose: COMBAT },
    { t: 0.10, pose: mix(COMBAT, { Hips: [-10, -16, 0], hips: [-0.02, -0.12, -0.05], Spine: [-12, 2, 0], Spine1: [-8, 4, 0], Neck: [-8, 4, 0], Head: [-14, 6, 2],
      LeftShoulder: [0, 0, 12], RightShoulder: [0, 0, 12], LeftArm: [80, -10, 40], LeftForeArm: [40, 0, 0], LeftHand: [0, 0, 0], RightArm: [30, 0, 60], RightForeArm: [50, 0, 0], RightHand: [0, 0, 0] }) },
    { t: 0.28, pose: mix(COMBAT, { Hips: [-14, -10, 4], hips: [-0.04, -0.17, -0.16], Spine: [-14, 0, 4], Spine1: [-8, 2, 2], Neck: [-6, 2, 0], Head: [-12, 4, -4],
      LeftShoulder: [0, 0, 14], RightShoulder: [0, 0, 14], LeftArm: [110, -10, 50], LeftForeArm: [30, 0, 0], LeftHand: [0, 0, 0], RightArm: [-30, 0, 70], RightForeArm: [40, 0, 0], RightHand: [0, 0, 0],
      ikR: [-0.24, ANKLE_Y + 0.03, -0.44, -12, 34] }) },
    { t: 0.46, pose: mix(COMBAT, { Hips: [-4, -14, -2], hips: [-0.02, -0.16, -0.24], Spine: [-4, 2, -2], Spine1: [-2, 2, 0], Neck: [-4, 4, 0], Head: [-6, 6, 0],
      LeftShoulder: [0, 0, 8], RightShoulder: [0, 0, 8], LeftArm: [60, -10, 40], LeftForeArm: [70, 0, 0], RightArm: [30, 0, 40], RightForeArm: [70, 0, 0],
      ikL: [0.18, ANKLE_Y + 0.06, 0.02, 8, 8], ikR: [-0.24, ANKLE_Y + 0.02, -0.44, -8, 34] }) },
    { t: 0.62, pose: mix(COMBAT, { Hips: [4, -20, 0], hips: [-0.02, -0.14, -0.18], Spine: [8, 4, 0], Head: [-2, 6, 0],
      LeftArm: [48, -10, 14], LeftForeArm: [110, 0, 0], RightArm: [50, 16, -24], RightForeArm: [114, 0, 0], ikL: [0.16, ANKLE_Y, 0.06, 0, 6], ikR: [-0.22, ANKLE_Y + 0.02, -0.40, -8, 32] }) },
    { t: 0.8, pose: mix(COMBAT, { hips: [-0.02, -0.12, -0.10], ikL: [0.16, ANKLE_Y, 0.16, 0, 6], ikR: [-0.20, ANKLE_Y + 0.02, -0.30, -8, 32] }) },
  ]),

  // ---------------------------------------------------------------- knockdown (fall to the back, bounce) / get up / dead
  knockdown: () => makeClip('knockdown', [
    { t: 0, pose: COMBAT },
    { t: 0.08, pose: mix(COMBAT, { Hips: [-10, -12, 0], hips: [-0.02, -0.10, -0.06], Spine: [-12, 0, 0], Spine1: [-18, 8, 2], Spine2: [-8, 4, 0], Neck: [-16, 6, 4], Head: [-34, 12, 10],
      LeftShoulder: [-4, 0, 16], RightShoulder: [-4, 0, 16], LeftArm: [70, -6, 40], LeftForeArm: [50, 0, 0], LeftHand: [0, 0, 0], RightArm: [56, 8, 46], RightForeArm: [46, 0, 0], RightHand: [0, 0, 0] }) },
    { t: 0.22, pose: mix(COMBAT, { Hips: [-34, -6, 0], hips: [0.0, -0.32, -0.30], Spine: [-10, 0, 0], Spine1: [-10, 4, 0], Spine2: [-4, 2, 0], Neck: [-12, 4, 2], Head: [-26, 8, 6],
      LeftShoulder: [-6, 0, 18], RightShoulder: [-6, 0, 18], LeftArm: [40, 0, 62], LeftForeArm: [36, 0, 0], LeftHand: [0, 0, 0], RightArm: [30, 0, 66], RightForeArm: [34, 0, 0], RightHand: [0, 0, 0],
      ikL: [0.16, ANKLE_Y + 0.02, 0.30, 6, 6], ikR: [-0.20, ANKLE_Y + 0.06, -0.14, -28, 32] }) },
    { t: 0.40, pose: mix(KNOCKED, { Hips: [-86, 0, 0], hips: [0, -0.79, -0.36], Spine: [-4, 0, 0], Spine1: [2, 0, 0], Neck: [6, 0, 0], Head: [14, 0, 0],
      LeftArm: [-20, 0, 70], RightArm: [-20, 0, 70], LeftForeArm: [40, 0, 0], RightForeArm: [40, 0, 0],
      LeftUpLeg: [50, 0, 10], LeftLeg: [-64, 0, 0], LeftFoot: [-30, 0, 0], RightUpLeg: [38, 0, 12], RightLeg: [-56, 0, 0], RightFoot: [-30, 0, 0] }) },
    { t: 0.50, pose: mix(KNOCKED, { Hips: [-84, 0, 0], hips: [0, -0.73, -0.36], Spine: [-8, 0, 0], Spine1: [-4, 0, 0], Neck: [-8, 0, 0], Head: [-18, 4, 0],
      LeftArm: [-26, 0, 66], RightArm: [-26, 0, 66], LeftForeArm: [30, 0, 0], RightForeArm: [30, 0, 0],
      LeftUpLeg: [34, 0, 10], LeftLeg: [-40, 0, 0], LeftFoot: [-10, 0, 0], RightUpLeg: [24, 0, 12], RightLeg: [-36, 0, 0], RightFoot: [-6, 0, 0] }) },
    { t: 0.64, pose: mix(KNOCKED, { Hips: [-88, 0, 0], hips: [0, -0.81, -0.34], Spine: [-6, 0, 0], Neck: [-2, 0, 0], Head: [-6, 4, 0],
      LeftArm: [-28, 0, 60], RightArm: [-28, 0, 60], LeftForeArm: [24, 0, 0], RightForeArm: [24, 0, 0],
      LeftUpLeg: [10, 0, 8], LeftLeg: [-18, 0, 0], LeftFoot: [20, 0, 0], RightUpLeg: [6, 0, 8], RightLeg: [-16, 0, 0], RightFoot: [24, 0, 0] }) },
    { t: 0.90, pose: mix(KNOCKED, { Head: [-10, 12, 0], LeftArm: [-30, 0, 58], RightArm: [-32, 0, 62], RightForeArm: [26, 0, 0] }) },
    { t: 1.2, pose: mix(KNOCKED, { Head: [-10, 18, 2], RightArm: [-34, 0, 66], RightForeArm: [28, 0, 0] }) },
  ]),
  getup: () => makeClip('getup', [
    { t: 0, pose: mix(KNOCKED, { Head: [-10, 18, 2] }) },
    { t: 0.24, pose: P(mix(KNOCKED, { Hips: [-46, 16, 22], hips: [-0.06, -0.74, -0.28], Spine: [18, -6, -4], Spine1: [12, -4, 0], Neck: [8, -4, 0], Head: [12, -12, 0],
      LeftShoulder: [8, 0, 0], RightShoulder: [-6, 0, 10], LeftArm: [50, 0, 14], LeftForeArm: [80, 0, 0], LeftHand: [0, 0, 0], RightHand: [-30, 0, 0],
      ikL: [0.18, ANKLE_Y, 0.32, 0, 10], ikR: [-0.24, ANKLE_Y, 0.14, 0, 22] }), {}, ['Right', [-0.42, 0.06, -0.50], [-0.52, 0.40, -0.30]]) },
    { t: 0.50, pose: mix(KNOCKED, { Hips: [20, 2, 4], hips: [-0.02, -0.52, -0.08], Spine: [16, -4, 0], Spine1: [8, -2, 0], Neck: [-4, 0, 0], Head: [-8, -4, 0],
      LeftArm: [44, 0, 12], LeftForeArm: [76, 0, 0], LeftHand: [0, 0, 0], RightArm: [10, 0, 24], RightForeArm: [60, 0, 0], RightHand: [-10, 0, 0],
      ikL: [0.16, ANKLE_Y, 0.40, 0, 8], RightUpLeg: [-4, 0, 10], RightLeg: [-110, 0, 0], RightFoot: [-40, 0, 0] }) },
    { t: 0.78, pose: mix(COMBAT, { Hips: [18, -6, 0], hips: [0.0, -0.30, 0.02], Spine: [18, 2, 0], Spine1: [8, 2, 0], Neck: [-8, 4, 0], Head: [-10, 4, 0],
      LeftArm: [30, -8, 10], LeftForeArm: [90, 0, 0], RightArm: [20, 10, -10], RightForeArm: [80, 0, 0],
      ikL: [0.16, ANKLE_Y, 0.34, 0, 6], ikR: [-0.20, ANKLE_Y + 0.03, -0.16, -12, 30] }) },
    { t: 1.1, pose: COMBAT },
  ]),
  dead: () => makeClip('dead', [
    { t: 0, pose: mix(KNOCKED, { Head: [-10, 18, 2] }) },
    { t: 0.55, pose: mix(KNOCKED, { Head: [-8, 24, 4], RightArm: [-36, 0, 74], RightForeArm: [22, 0, 0], LeftUpLeg: [12, 4, 10], RightUpLeg: [8, 2, 12] }) },
    { t: 1.3, pose: mix(KNOCKED, { Head: [-6, 30, 6], Spine: [-8, 2, 2], RightArm: [-38, 0, 80], RightForeArm: [16, 0, 0], LeftArm: [44, 0, 18], LeftForeArm: [74, 0, 0], LeftHand: [10, 0, 0],
      LeftUpLeg: [10, 6, 14], RightUpLeg: [6, 2, 18], RightLeg: [-14, 0, 0] }) },
    { t: 2.0, pose: mix(KNOCKED, { Head: [-6, 32, 6], Spine: [-8, 2, 2], RightArm: [-38, 0, 82], RightForeArm: [14, 0, 0], LeftArm: [46, 0, 18], LeftForeArm: [76, 0, 0], LeftHand: [10, 0, 0],
      LeftUpLeg: [10, 6, 14], RightUpLeg: [6, 2, 18], RightLeg: [-14, 0, 0] }) },
  ]),

  // ---------------------------------------------------------------- grab / throw / heat finisher / taunt
  grab: () => makeClip('grab', [
    { t: 0, pose: COMBAT },
    { t: 0.12, pose: P(COMBAT, { Hips: [8, -10, 0], hips: [0.0, -0.13, 0.08], Spine: [14, 2, 0], Spine1: [6, 0, 0], Neck: [-8, 2, 0], Head: [-6, 2, 0],
      LeftShoulder: [16, 0, 2], RightShoulder: [16, 0, 2], LeftHand: [-10, 0, 0], RightHand: [-10, 0, 0], ikR: ballPivot('R', STANCE_R, 20, 22) },
      ['Left', { dir: [-0.12, -0.08, 1], ext: 0.92 }, [0.42, 1.08, 0.30]], ['Right', { dir: [0.12, -0.08, 1], ext: 0.92 }, [-0.42, 1.08, 0.30]]) },
    { t: 0.26, pose: GRAB },
    { t: 0.5, pose: mix(GRAB, { Spine: [8, 2, 0], hips: [0.0, -0.13, 0.05] }) },
  ], { events: [{ time: 0.18, name: 'hit', bone: 'RightHand', radius: 0.30 }] }),
  throw: () => makeClip('throw', [
    { t: 0, pose: GRAB },
    { t: 0.22, pose: P(GRAB, { Hips: [6, -42, 0], hips: [-0.06, -0.15, 0.0], Spine: [10, -12, 0], Spine1: [4, -10, 0], Neck: [-6, 6, 0], Head: [-4, 8, 0],
      LeftShoulder: [10, 0, 2], RightShoulder: [-4, 0, 6], ikR: [-0.24, ANKLE_Y, -0.22, 0, 40] },
      ['Left', [-0.18, 1.28, 0.58], [0.30, 1.08, 0.20]], ['Right', [-0.50, 1.20, 0.18], [-0.46, 1.00, -0.14]]) },
    { t: 0.42, pose: P(GRAB, { Hips: [14, 46, 0], hips: [0.10, -0.20, 0.04], Spine: [24, 22, 0], Spine1: [10, 16, 0], Neck: [-10, -14, 0], Head: [-8, -18, 0],
      LeftShoulder: [4, 0, 2], RightShoulder: [20, 0, 4], ikL: [0.34, ANKLE_Y, -0.06, 0, 34], ikR: ballPivot('R', STANCE_R, 30, 0) },
      ['Left', [0.62, 0.92, 0.14], [0.36, 1.18, -0.16]], ['Right', [0.40, 1.06, 0.34], [-0.14, 1.34, 0.30]]) },
    { t: 0.58, pose: P(GRAB, { Hips: [16, 56, 2], hips: [0.12, -0.22, 0.02], Spine: [28, 24, 0], Spine1: [10, 16, 0], Neck: [-10, -18, 0], Head: [-6, -22, 0],
      LeftShoulder: [0, 0, 2], RightShoulder: [22, 0, 4], ikL: [0.34, ANKLE_Y, -0.06, 0, 34], ikR: ballPivot('R', STANCE_R, 30, -4) },
      ['Left', [0.62, 0.70, -0.06], [0.36, 1.10, -0.24]], ['Right', [0.50, 0.84, 0.20], [0.0, 1.30, 0.34]]) },
    { t: 0.9, pose: COMBAT },
  ], { events: [{ time: 0.40, name: 'hit', bone: 'RightHand', radius: 0.40 }] }),
  heat_finisher: () => makeClip('heat_finisher', [
    { t: 0, pose: COMBAT },
    { t: 0.24, pose: mix(COMBAT, { Hips: [-8, -22, 0], hips: [0.10, -0.16, -0.05], Spine: [16, -8, 0], Spine1: [8, -4, 0], Neck: [-10, 8, 0], Head: [-8, 10, 0],
      LeftArm: [50, -10, 20], LeftForeArm: [80, 0, 0], LeftHand: [0, 0, 0], RightArm: [-10, 10, -20], RightForeArm: [100, 0, 0],
      RightUpLeg: [112, 0, 10], RightLeg: [-132, 0, 0], RightFoot: [4, 0, 0], ikL: ballPivot('L', STANCE_L, 6, 28) }) },
    { t: 0.35, pose: mix(COMBAT, { Hips: [-20, -4, 0], hips: [0.14, -0.13, 0.20], Spine: [-8, 0, 0], Spine1: [-6, 0, 0], Neck: [4, 2, 0], Head: [10, 2, 0],
      LeftArm: [24, -6, 34], LeftForeArm: [56, 0, 0], LeftHand: [0, 0, 0], RightArm: [-24, 10, -28], RightForeArm: [70, 0, 0],
      RightUpLeg: [96, 0, 6], RightLeg: [-6, 0, 0], RightFoot: [22, 0, 0], ikL: ballPivot('L', STANCE_L, 20, 40) }) },
    { t: 0.55, pose: mix(COMBAT, { Hips: [-22, -2, 0], hips: [0.15, -0.13, 0.24], Spine: [-8, 0, 0], Spine1: [-6, 0, 0], Neck: [4, 2, 0], Head: [10, 2, 0],
      LeftArm: [24, -6, 34], LeftForeArm: [56, 0, 0], LeftHand: [0, 0, 0], RightArm: [-24, 10, -28], RightForeArm: [70, 0, 0],
      RightUpLeg: [98, 0, 6], RightLeg: [-6, 0, 0], RightFoot: [22, 0, 0], ikL: ballPivot('L', STANCE_L, 22, 40) }) },
    { t: 0.80, pose: mix(COMBAT, { Hips: [-6, -10, 0], hips: [0.08, -0.14, 0.10], Spine: [4, 0, 0], Neck: [0, 4, 0], Head: [4, 4, 0],
      LeftArm: [36, -8, 20], LeftForeArm: [90, 0, 0], RightArm: [10, 12, -20], RightForeArm: [90, 0, 0],
      RightUpLeg: [60, 0, 8], RightLeg: [-96, 0, 0], RightFoot: [-14, 0, 0], ikL: ballPivot('L', STANCE_L, 6, 30) }) },
    { t: 1.0, pose: mix(RELAX, { Hips: [2, -8, 0], hips: [0.0, -0.06, 0.06], Spine: [4, 0, 0], Spine1: [2, 0, 0], Neck: [-6, 4, 0], Head: [-8, 4, 0],
      LeftShoulder: [0, 0, 4], RightShoulder: [0, 0, 4], LeftArm: [14, 0, 10], LeftForeArm: [40, 0, 0], LeftHand: [10, 0, 10], RightArm: [14, 0, 10], RightForeArm: [40, 0, 0], RightHand: [10, 0, 10],
      ikL: [0.16, ANKLE_Y, 0.10, 0, 10], ikR: [-0.18, ANKLE_Y, 0.36, 0, 12] }) },
    { t: 1.3, pose: mix(RELAX, { Hips: [-2, -6, 0], hips: [0.0, -0.03, 0.04], Spine: [-2, 0, 0], Spine1: [-2, 0, 0], Neck: [-8, 6, 0], Head: [-12, 8, 0],
      LeftShoulder: [-4, 0, 6], RightShoulder: [-4, 0, 6], LeftArm: [10, 0, 14], LeftForeArm: [30, 0, 0], LeftHand: [10, 0, 10], RightArm: [10, 0, 14], RightForeArm: [30, 0, 0], RightHand: [10, 0, 10],
      ikL: [0.16, ANKLE_Y, 0.10, 0, 10], ikR: [-0.18, ANKLE_Y, 0.36, 0, 12] }) },
    { t: 1.6, pose: COMBAT },
  ], { events: [{ time: 0.36, name: 'hit', bone: 'RightFoot', radius: 0.40 }] }),
  taunt: () => {
    const base = P(COMBAT, { Hips: [-2, -26, 0], hips: [-0.04, -0.10, -0.05], Spine: [-4, 10, 0], Spine1: [-2, 6, 0], Neck: [-6, -8, -4], Head: [-8, -14, -8],
      LeftShoulder: [0, 0, 4], RightShoulder: [8, 0, 4], LeftArm: [14, -6, 12], LeftForeArm: [68, 0, 0], LeftHand: [0, 0, 24], RightHand: [-20, 0, 0] },
      ['Right', { dir: [0.25, -0.2, 1], ext: 0.86 }, [-0.44, 0.98, 0.22]]);
    const beckon = (h) => mix(base, { RightHand: [h, 0, 0] });
    return makeClip('taunt', [
      { t: 0, pose: COMBAT },
      { t: 0.30, pose: twist(beckon(-20), 'Right', -70) },
      { t: 0.48, pose: twist(beckon(24), 'Right', -70) },
      { t: 0.62, pose: twist(beckon(-24), 'Right', -70) },
      { t: 0.78, pose: twist(beckon(24), 'Right', -70) },
      { t: 0.94, pose: twist(mix(beckon(-10), { Head: [-8, -18, -10], Spine: [-5, 12, 0] }), 'Right', -70) },
      { t: 1.15, pose: twist(mix(beckon(-10), { Head: [-8, -18, -10], Spine: [-5, 12, 0] }), 'Right', -70) },
      { t: 1.5, pose: COMBAT },
    ]);
  },

  // ---------------------------------------------------------------- ambient (pedestrians / substories)
  sit: () => makeClip('sit', [
    { t: 0, pose: SIT },
    { t: 1.5, pose: mix(SIT, { Spine2: [3, 0, 0], LeftShoulder: [0, 0, 2], RightShoulder: [0, 0, 2], Head: [-3, 2, 0] }) },
    { t: 2.6, pose: mix(SIT, { Spine1: [9, 6, 0], Neck: [-4, 12, 0], Head: [-4, 22, 2], Spine2: [1, 4, 0] }) },
    { t: 3.6, pose: mix(SIT, { Spine1: [8, 4, 0], Neck: [-4, 8, 0], Head: [-5, 16, 2], Spine2: [3, 2, 0], LeftShoulder: [0, 0, 2], RightShoulder: [0, 0, 2] }) },
    { t: 4.8, pose: mix(SIT, { Spine1: [8, -4, 0], Neck: [-5, -8, 0], Head: [-2, -16, -3] }) },
    { t: 6.0, pose: SIT },
  ], { loop: true }),
  phone: () => {
    const base = P(mix(RELAX, STAND, { hips: [-0.03, -0.03, 0.0], Hips: [2, 0, -3], Spine: [3, 4, 1], Spine1: [2, 4, 0], Neck: [2, -8, -6], Head: [2, -10, -9],
      LeftShoulder: [0, 0, 2], RightShoulder: [6, 0, 8], LeftHand: [0, 0, -10], RightHand: [-10, 0, -30], ikL: [0.15, ANKLE_Y, 0.06, 0, 12], ikR: [-0.12, ANKLE_Y, -0.04, 0, 6] }),
      {}, ['Right', [-0.17, 1.58, 0.13], [-0.42, 1.22, 0.06]], ['Left', [0.19, 0.94, 0.12], [0.34, 1.16, -0.16]]);
    return makeClip('phone', [
      { t: 0, pose: base },
      { t: 1.2, pose: mix(base, { Head: [8, -10, -9], Neck: [4, -8, -6], Spine2: [2, 0, 0] }) },
      { t: 2.2, pose: mix(base, { Head: [2, -4, -8], hips: [-0.01, -0.035, 0.0], Hips: [2, 0, -1], Spine2: [1, 0, 0] }) },
      { t: 3.1, pose: mix(base, { Head: [6, -14, -10], Neck: [3, -10, -6], Spine2: [2, 2, 0] }) },
      { t: 4.0, pose: base },
    ], { loop: true });
  },
  smoke: () => {
    const torso = mix(RELAX, STAND, { hips: [0.03, -0.03, 0.0], Hips: [0, 0, 3], Spine: [5, 0, -1], Spine1: [3, 0, 0], Neck: [2, 0, 0], Head: [2, 0, 0],
      LeftShoulder: [0, 0, 2], RightShoulder: [2, 0, 2], LeftHand: [0, 0, -10], RightHand: [0, 0, 0], ikL: [0.14, ANKLE_Y, 0.04, 0, 10], ikR: [-0.15, ANKLE_Y, -0.06, 0, 14] });
    const pocket = ['Left', [0.19, 0.94, 0.12], [0.34, 1.16, -0.16]];
    const down = P(torso, {}, ['Right', [-0.30, 0.96, 0.16], [-0.36, 1.20, -0.10]], pocket);
    const up = P(torso, { Neck: [4, -3, 0], Head: [8, -4, 2], RightShoulder: [6, 0, 6], RightHand: [-30, 0, 10] }, ['Right', [-0.09, 1.50, 0.19], [-0.40, 1.16, 0.06]], pocket);
    const exhale = P(torso, { Neck: [-8, -4, 0], Head: [-16, -6, 2], Spine1: [1, 0, 0], RightHand: [-10, 0, 0] }, ['Right', [-0.28, 1.06, 0.20], [-0.40, 1.22, -0.06]], pocket);
    return makeClip('smoke', [
      { t: 0, pose: down },
      { t: 0.9, pose: up },
      { t: 1.5, pose: mix(up, { Spine2: [3, 0, 0], Head: [9, -4, 2] }) },
      { t: 2.1, pose: exhale },
      { t: 2.8, pose: mix(exhale, { Head: [-8, -4, 2], Neck: [-4, -3, 0], Spine2: [-1, 0, 0] }) },
      { t: 3.4, pose: mix(down, { Spine2: [1, 0, 0] }) },
      { t: 4.0, pose: down },
    ], { loop: true });
  },
};

// ================================================================== pedestrian street life (docs/reports/pedclips.md)
// For the client's scanned passers-by (crowd.js / crowdScan.js): 「友達や知り合い同志一緒に歩いていたり、待ち合わせしてたり、
// お店をのぞいたり、喧嘩したり」. Authored as a PEDESTRIAN, not the hero: arms hang close (~10° off the ribs, not the
// yakuza stand), the weight sits on one leg, the walk is a 1.05-1.2 m/s stroll. Every standing clip starts and ends on
// PED_A (weight on the right leg, same feet) so a one-shot (greet_*, laugh, look_around) cross-fades in from and back
// out to idle_wait / talk_* without the feet moving. Clip durations / loop flags: DURATIONS and clip.userData.loop.
const AY = ANKLE_Y;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
// left <-> right: limb channels swap sides unchanged (they are already side-mirrored), centre bones negate Y / Z,
// the pelvis offset negates x, the ankle targets swap and negate x
function mirrorPose(p) {
  const o = {};
  for (const k in p) {
    const v = p[k];
    if (k === 'hips') o.hips = [-v[0], v[1], v[2]];
    else if (k === 'ikL' || k === 'ikR') o[k === 'ikL' ? 'ikR' : 'ikL'] = [-v[0], v[1], v[2], v[3], v[4]];
    else if (k.startsWith('Left')) o['Right' + k.slice(4)] = v.slice();
    else if (k.startsWith('Right')) o['Left' + k.slice(5)] = v.slice();
    else o[k] = [v[0], -v[1], -v[2]];
  }
  return o;
}
// the pedestrian stance: feet planted once (hip width, a little toe-out, the left a few cm forward); the weight moves
// over them. HANG: upper arms ~10° off the ribs (the rig's A-pose bind is 16.5°), elbows soft, hands a touch forward.
const PED_FEET = { ikL: [0.12, AY, 0.06, 0, 12], ikR: [-0.11, AY, -0.01, 0, 8] };
const HANG = { LeftShoulder: [0, 0, 0], RightShoulder: [0, 0, 0], LeftArm: [5, 2, -6], RightArm: [4, 2, -6], LeftForeArm: [15, 0, 0], RightForeArm: [13, 0, 0],
  LeftHand: [4, 0, 3], RightHand: [4, 0, 3] };
// contrapposto over the `side` leg ('R' | 'L'): pelvis over that foot, the free hip dropped, the chest tilted back
// against it (shoulder line opposite to the hip line), the pelvis turned so the free side leads. k scales it.
function stand(side, k = 1, feet = PED_FEET) {
  const s = (side === 'L' ? 1 : -1) * k;
  return mix(HANG, feet, { hips: [0.030 * s, -0.036, 0.004], Hips: [0, 3 * s, 4 * s],
    Spine: [1, -1 * s, -3.4 * s], Spine1: [0, -1.5 * s, -1.6 * s], Spine2: [0, 0, -1 * s], Neck: [1, 0, 0.6 * s], Head: [0, 0, 1.2 * s],
    LeftShoulder: [0, 0, -0.8 * s], RightShoulder: [0, 0, 0.8 * s] });
}
const PED_A = stand('R'), PED_B = stand('L');
// add rotation deltas to a pose (for small head / spine moves on top of a stance): add(pose, {Head:[x,y,z]})
function add(pose, d) {
  const o = { ...pose };
  for (const k in d) { const a = pose[k] || [0, 0, 0], b = d[k]; o[k] = k.startsWith('ik') ? b.slice() : [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  return o;
}
// arm poses in the character frame (IK against the pose they are on), with the forearm roll (pronation +)
const armAt = (pose, side, wrist, elbow, roll = 0, hand = null) => {
  const p = P(pose, hand ? { [side + 'Hand']: hand } : {}, [side, wrist, elbow]);
  return roll ? twist(p, side, roll) : p;
};
const PHONE_R = [[-0.075, 1.13, 0.27], [-0.27, 1.00, -0.04]];     // phone read at the chest, screen to the face
// phone at the right ear: the elbow hangs down and forward (a wrist at ear height puts the elbow out at shoulder
// height — the scans' shoulders tear there), the forearm rises steeply and the hand carries the phone up to the ear
const EAR_R = [[-0.13, 1.53, 0.155], [-0.15, 1.24, 0.30]];
const WATCH_R = [[-0.035, 1.14, 0.27], [-0.29, 1.02, -0.02]];     // right wrist across the front, watch face up (the phone hand:
                                                                   // every hand move of idle_wait is the right's, see PED_HANDS)

// ------------------------------------------------------------------ walking with an upper-body overlay
// The legs, pelvis and arm swing come from locomotionFrames (so the planted foot travels at exactly -speed); `keys`
// ride on top: { t, add: {Spine..Head: deltas}, arm: {<side>Shoulder/Arm/ForeArm/Hand: absolute}, wL, wR }. A side's
// arm weight blends the swing (0) into the authored arm (1). Loops: the first and last key must match.
const W_ADD = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head'];
const W_ARM = ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'];
function pedLoco(name, gait, cycles, keys) {
  const fps = 30, frames = locomotionFrames({ ...gait, cycles, fps });
  const dur = gait.dur * cycles, ts = keys.map((k) => k.t);
  const rows = keys.map((k) => {
    const r = [];
    for (const b of W_ADD) { const v = (k.add && k.add[b]) || [0, 0, 0]; r.push(v[0], v[1], v[2]); }
    for (const b of W_ARM) { const v = (k.arm && k.arm[b]) || [0, 0, 0]; r.push(v[0], v[1], v[2]); }
    r.push(k.wL || 0, k.wR || 0);
    return r;
  });
  const nc = rows[0].length, tg = [], v = new Float64Array(nc);
  for (let c = 0; c < nc; c++) tg.push(tangents(ts, rows.map((r) => r[c]), true));
  let seg = 0;
  for (const fr of frames) {
    const t = Math.min(fr.t, dur);
    while (seg < ts.length - 2 && t > ts[seg + 1]) seg++;
    const h = ts[seg + 1] - ts[seg], u = h > 0 ? (t - ts[seg]) / h : 0;
    for (let c = 0; c < nc; c++) v[c] = hermite(rows[seg][c], rows[seg + 1][c], tg[c][seg], tg[c][seg + 1], h, u);
    const f = fr.f, wL = clamp01(v[nc - 2]), wR = clamp01(v[nc - 1]);
    let c = 0;
    for (const b of W_ADD) for (let i = 0; i < 3; i++) f[CH[b] + i] += v[c++];
    for (const b of W_ARM) { const w = b.startsWith('Left') ? wL : wR; for (let i = 0; i < 3; i++, c++) f[CH[b] + i] += (v[c] - f[CH[b] + i]) * w; }
  }
  const events = [];
  for (let k = 0; k < cycles; k++) events.push({ time: gait.dur * (k + 0.25), name: 'footstep', foot: 'R', bone: 'RightFoot' }, { time: gait.dur * (k + 0.75), name: 'footstep', foot: 'L', bone: 'LeftFoot' });
  return makeClipFromFrames(name, frames, { speed: gait.speed, stride: gait.speed * dur, gaitCycle: gait.dur, events });
}
// the torso a walking gesture is solved against (locomotionFrames' mean upper body + the overlay's own turn)
function walkArms(gait, addPose, ...arms) {
  const L = gait.lean, torso = { Hips: [L * 0.3, 0, 0], Spine: [L * 0.4, 0, 0], Spine1: [L * 0.3, 0, 0], Spine2: [L * 0.15, 0, 0], Neck: [-L * 0.45, 0, 0], Head: [-L * 0.45, 0, 0] };
  let p = add(mix(HANG, PED_FEET, torso), addPose || {});
  for (const a of arms) { p = P(p, a[4] ? { [a[0] + 'Hand']: a[4] } : {}, [a[0], a[1], a[2]]); if (a[3]) twist(p, a[0], a[3]); }
  const o = {};
  for (const b of W_ARM) if (p[b]) o[b] = p[b];
  return o;
}
function mirrorKey(k) { return { t: k.t, add: k.add && mirrorPose(k.add), arm: k.arm && mirrorPose(k.arm), wL: k.wR || 0, wR: k.wL || 0 }; }

// stroll with a companion on the LEFT: head + upper spine turned ~25° to them, a nod, one right-hand gesture (the
// far hand, across toward them), then a glance ahead at the path. 3 gait cycles of 1.1 s at 1.2 m/s.
const CHAT_GAIT = { dur: 1.1, speed: 1.2, stanceFrac: 0.6, lift: 0.045, hipDrop: 0.03, bob: 0.016, sway: 0.018, drop: 3, twist: 6, armSwing: 13, elbow: 14, lean: 3, width: 0.10 };
function chatKeys() {
  const LOOK = { Spine1: [0, 3, 0], Spine2: [0, 4, 0], Neck: [0, 7, -1], Head: [0, 12, -3] };
  const TOWARD = { Spine1: [0, 6, 0], Spine2: [0, 5, 0], Neck: [0, 8, -1], Head: [-1, 13, -4] };
  const g = (w, e, roll, hand) => walkArms(CHAT_GAIT, TOWARD, ['Right', w, e, roll, hand]);
  const up = g([-0.05, 1.12, 0.31], [-0.29, 1.02, 0.0], -55, [-6, 0, 0]), beat = g([-0.045, 1.065, 0.32], [-0.29, 1.0, 0.0], -55, [8, 0, 0]);
  const open = g([0.0, 1.13, 0.33], [-0.28, 1.03, 0.02], -70, [-10, 0, 0]);
  return [
    { t: 0, add: LOOK, arm: up },
    { t: 0.42, add: add(LOOK, { Head: [5, 0, 0], Neck: [2, 0, 0] }), arm: up },
    { t: 0.72, add: LOOK, arm: up },
    { t: 1.2, add: LOOK, arm: up },
    { t: 1.5, add: TOWARD, arm: up, wR: 1 },
    { t: 1.8, add: add(TOWARD, { Head: [4, 0, 0] }), arm: beat, wR: 1 },
    { t: 2.08, add: TOWARD, arm: open, wR: 1 },
    { t: 2.45, add: LOOK, arm: open, wR: 0 },
    { t: 2.7, add: { Spine1: [0, 1, 0], Spine2: [0, 1, 0], Neck: [0, 1, 0], Head: [2, 1, -1] } },
    { t: 2.95, add: { Spine1: [0, 1, 0], Spine2: [0, 2, 0], Neck: [0, 2, 0], Head: [1, 3, -1] } },
    { t: 3.3, add: LOOK, arm: up },
  ];
}
// eyes on a phone in the right hand at chest height: head and neck down ~34°, shoulders rounded, the phone arm held
// (it rides the chest, no swing), the left arm swinging short. 2 gait cycles of 1.15 s at 1.05 m/s.
const PHONE_GAIT = { dur: 1.15, speed: 1.05, stanceFrac: 0.62, lift: 0.04, hipDrop: 0.03, bob: 0.014, sway: 0.02, drop: 3, twist: 5, armSwing: 10, elbow: 16, lean: 4, width: 0.10 };
function phoneWalkKeys() {
  const DOWN = { Spine1: [2, 0, 0], Spine2: [3, 0, 0], Neck: [14, -2, 0], Head: [17, -4, 0] };
  const arm = (dy) => walkArms(PHONE_GAIT, DOWN, ['Right', [PHONE_R[0][0], PHONE_R[0][1] + dy, PHONE_R[0][2]], PHONE_R[1], -65, [-12, 0, 0]]);
  const a0 = arm(0), a1 = arm(-0.012), a2 = arm(0.008);
  return [
    { t: 0, add: DOWN, arm: a0, wR: 1 },
    { t: 0.6, add: add(DOWN, { Head: [2, 1, 0] }), arm: a1, wR: 1 },
    { t: 1.15, add: DOWN, arm: a0, wR: 1 },
    { t: 1.62, add: add(DOWN, { Head: [-4, 2, 0], Neck: [-2, 0, 0] }), arm: a2, wR: 1 },
    { t: 2.3, add: DOWN, arm: a0, wR: 1 },
  ];
}

// ------------------------------------------------------------------ standing: poses shared by the clips below
const phoneAt = (base, dy = 0) => armAt(add(base, { Spine1: [2, -1, 0], Spine2: [2, 0, 0], Neck: [12, -3, 0], Head: [16, -6, 0], RightShoulder: [2, 0, 2] }),
  'Right', [PHONE_R[0][0], PHONE_R[0][1] + dy, PHONE_R[0][2]], PHONE_R[1], -65, [-12, 0, 0]);
const watchAt = (base) => armAt(add(base, { Spine1: [3, -2, 0], Spine2: [2, -1, 0], Neck: [12, -5, 0], Head: [16, -10, 2], RightShoulder: [4, 0, 2] }), 'Right', WATCH_R[0], WATCH_R[1], 85, [10, 0, 0]);
const look = (base, yaw, pitch = 0, roll = 0) => add(base, { Spine1: [0, yaw * 0.12, 0], Spine2: [0, yaw * 0.1, 0], Neck: [pitch * 0.35, yaw * 0.3, roll * 0.3], Head: [pitch * 0.65, yaw * 0.48, roll * 0.7] });

const PED_BUILDERS = {
  walk_chat: () => pedLoco('walk_chat', CHAT_GAIT, 3, chatKeys()),
  walk_chat_r: () => { const f = FIT; FIT = mirrorFit(f); let k; try { k = chatKeys(); } finally { FIT = f; } return pedLoco('walk_chat_r', CHAT_GAIT, 3, k.map(mirrorKey)); },
  walk_phone: () => pedLoco('walk_phone', PHONE_GAIT, 2, phoneWalkKeys()),

  // waiting for a friend (Hachiko): phone glance, weight shift, look up and down the street, check the watch,
  // weight back. 11 s so the repeat is not noticed; feet never move.
  idle_wait: () => {
    const A0 = look(PED_A, 8), B0 = look(PED_B, 4);
    return makeClip('idle_wait', [
      { t: 0, pose: A0 },
      { t: 0.9, pose: look(PED_A, 3, 2) },
      { t: 1.55, pose: phoneAt(PED_A) },
      { t: 2.4, pose: add(phoneAt(PED_A, -0.008), { Head: [-2, 2, 0] }) },
      { t: 3.0, pose: add(phoneAt(PED_A, 0.004), { Head: [-5, 3, 0], Neck: [-2, 0, 0] }) },
      { t: 3.6, pose: look(PED_A, 0, -2) },
      { t: 4.6, pose: look(PED_B, 10, -2) },
      { t: 5.3, pose: look(PED_B, 44, -4) },
      { t: 6.1, pose: look(PED_B, 50, -6, -3) },
      { t: 6.9, pose: look(PED_B, -40, -3) },
      { t: 7.5, pose: look(PED_B, -8) },
      { t: 8.1, pose: watchAt(PED_B) },
      { t: 8.8, pose: add(watchAt(PED_B), { Head: [2, 1, 0] }) },
      { t: 9.35, pose: B0 },
      { t: 10.3, pose: look(PED_A, 7, -1) },
      { t: 11.0, pose: A0 },
    ], { loop: true });
  },
  // on the phone: right hand at the ear, head tipped off it; the free left hand explains, rests on the hip, a laugh
  idle_phone_call: () => {
    const CALL = armAt(mix(PED_B, { Neck: [2, -4, -2], Head: [2, -8, -3], RightShoulder: [4, 0, 4], RightHand: [-12, 0, -6] }), 'Right', EAR_R[0], EAR_R[1], -10);
    const lu = (w, roll = -50) => armAt(CALL, 'Left', w, [0.33, 1.02, -0.04], roll, [-8, 0, 0]);
    const HIP = armAt(add(CALL, { LeftShoulder: [0, 0, 4] }), 'Left', [0.235, 0.99, -0.03], [0.42, 1.16, -0.10], 20, [-30, 0, 0]);
    return makeClip('idle_phone_call', [
      { t: 0, pose: CALL },
      { t: 0.7, pose: add(CALL, { Head: [6, 0, 0], Neck: [2, 0, 0] }) },
      { t: 1.1, pose: lu([0.19, 1.07, 0.28]) },
      { t: 1.42, pose: add(lu([0.20, 1.02, 0.29]), { Head: [3, 0, 0] }) },
      { t: 1.72, pose: lu([0.17, 1.09, 0.29], -70) },
      { t: 2.3, pose: add(CALL, { Head: [0, 4, 0] }) },
      { t: 2.9, pose: add(CALL, { Head: [6, 3, 0], Neck: [2, 0, 0] }) },
      { t: 3.5, pose: HIP },
      { t: 4.2, pose: add(HIP, { Head: [-6, 0, 0], Neck: [-2, 0, 0], Spine2: [-2, 0, 0] }) },
      { t: 4.4, pose: add(HIP, { Head: [2, 0, 0], Spine2: [1.5, 0, 0], RightShoulder: [0, 0, 1], LeftShoulder: [0, 0, 1] }) },
      { t: 4.6, pose: add(HIP, { Head: [-3, 0, 0], Spine2: [-1, 0, 0] }) },
      { t: 5.3, pose: add(CALL, { Head: [2, -2, 0] }) },
      { t: 6.0, pose: CALL },
    ], { loop: true });
  },
  // the friend arrives: right hand up beside the head, palm out, waved from the elbow, chest lifting (one-shot)
  greet_wave: () => {
    const lift = add(PED_A, { Spine1: [-3, 2, 0], Spine2: [-2, 1, 0], Neck: [-2, 0, 0], Head: [-5, 0, 0], RightShoulder: [0, 0, 8] });
    // (a head-height wave with the elbow low and forward: the scans' auto-skinned shoulders tear past ~60° of
    // abduction, which the first, shoulder-high elbow hit — a flat sheet between arm and ribs)
    // the upper arm is FLEXED forward (elbow in front of the ribs), not abducted, and the forearm pronated so the
    // palm faces out
    const w = (x, hz) => armAt(lift, 'Right', [x, 1.53, 0.30], [-0.32, 1.21, 0.20], 70, [0, 0, hz]);
    const OUT = w(-0.39, -18), IN = w(-0.28, 16);
    return makeClip('greet_wave', [
      { t: 0, pose: PED_A },
      { t: 0.3, pose: OUT },
      { t: 0.44, pose: IN },
      { t: 0.58, pose: OUT },
      { t: 0.72, pose: IN },
      { t: 0.86, pose: OUT },
      { t: 1.0, pose: IN },
      { t: 1.18, pose: add(armAt(lift, 'Right', [-0.31, 1.36, 0.24], [-0.36, 1.06, 0.04]), { Head: [3, 0, 0] }) },
      { t: 1.6, pose: PED_A },
    ]);
  },
  // 会釈: a ~15-18° nod-bow from the hips, eyes down, arms riding the sides, the pelvis back to balance (one-shot)
  greet_bow: () => {
    const BOW = add(PED_A, { hips: [0, -0.006, -0.035], Hips: [11, 0, 0], Spine: [4, 0, 0], Spine1: [2, 0, 0], Neck: [2, 0, 0], Head: [6, 0, 0], LeftArm: [-8, 0, 0], RightArm: [-8, 0, 0] });
    return makeClip('greet_bow', [
      { t: 0, pose: PED_A },
      { t: 0.38, pose: BOW },
      { t: 0.7, pose: add(BOW, { Hips: [1, 0, 0], Head: [2, 0, 0] }) },
      { t: 1.1, pose: add(PED_A, { Head: [3, 0, 0] }) },
      { t: 1.4, pose: PED_A },
    ]);
  },
  // standing conversation, the talker: explaining with the right hand, both hands open, turns to the next listener,
  // a laugh beat, a left-hand beat (loop, 2-4 people standing in a rough circle)
  talk_stand: () => {
    const A0 = look(PED_A, 6);
    const ru = (base, w, roll = -55) => armAt(base, 'Right', [w[0], w[1], w[2] - 0.05], [-0.31, 1.0, -0.06], roll, [-8, 0, 0]);
    const lu = (base, w, roll = -40) => armAt(base, 'Left', [w[0], w[1], w[2] - 0.05], [0.31, 1.0, -0.06], roll, [-8, 0, 0]);
    const both = (base, dy = 0) => lu(ru(add(base, { LeftShoulder: [0, 0, 4], RightShoulder: [0, 0, 4], Spine1: [-1, 0, 0] }), [-0.25, 1.06 + dy, 0.29], -65), [0.25, 1.06 + dy, 0.29], -65);
    const LAUGH = add(look(PED_A, -10), { Spine2: [-2, 0, 0], Neck: [-3, 0, 0], Head: [-6, 0, 0], LeftShoulder: [0, 0, 5], RightShoulder: [0, 0, 5] });
    const BOUNCE = add(look(PED_A, -10), { Spine1: [2, 0, 0], Spine2: [2, 0, 0], Head: [4, 0, 0], LeftShoulder: [0, 0, 2], RightShoulder: [0, 0, 2] });
    return makeClip('talk_stand', [
      { t: 0, pose: A0 },
      { t: 0.5, pose: ru(look(PED_A, 4, 3), [-0.18, 1.08, 0.30]) },
      { t: 0.85, pose: ru(look(PED_A, 4, 6), [-0.18, 1.03, 0.31]) },
      { t: 1.15, pose: ru(look(PED_A, 3, 2), [-0.17, 1.09, 0.31]) },
      { t: 1.6, pose: both(look(PED_A, 1)) },
      { t: 2.1, pose: both(look(PED_A, 0, 3), -0.03) },
      { t: 2.6, pose: look(PED_A, -2) },
      { t: 3.1, pose: look(PED_A, -12) },
      { t: 3.32, pose: LAUGH },
      { t: 3.52, pose: BOUNCE },
      { t: 3.72, pose: LAUGH },
      { t: 3.95, pose: BOUNCE },
      { t: 4.3, pose: look(PED_A, -9, 1) },
      { t: 4.7, pose: lu(look(PED_A, -9, 3), [0.18, 1.05, 0.29]) },
      { t: 5.0, pose: lu(look(PED_A, -8, 5), [0.18, 1.0, 0.30]) },
      { t: 5.3, pose: lu(look(PED_A, -6, 2), [0.17, 1.06, 0.30]) },
      { t: 5.65, pose: look(PED_A, 2) },
      { t: 6.0, pose: A0 },
    ], { loop: true });
  },
  // the listener: nods (a double nod, a slow one), a thinking head tilt, a small laugh; weight on the left leg
  talk_listen: () => {
    const B0 = look(PED_B, -4), n = (dx, yaw = -4, roll = 0) => add(look(PED_B, yaw, 0, roll), { Head: [dx, 0, 0], Neck: [dx * 0.35, 0, 0] });
    return makeClip('talk_listen', [
      { t: 0, pose: B0 },
      { t: 0.9, pose: n(8) },
      { t: 1.15, pose: n(0) },
      { t: 1.35, pose: n(5) },
      { t: 1.6, pose: n(0) },
      { t: 2.4, pose: add(n(2, -10, -7), { Spine2: [0, 0, -1], hips: [0.005, 0, 0] }) },
      { t: 3.1, pose: n(0, -6) },
      { t: 3.3, pose: add(n(-5, -5), { LeftShoulder: [0, 0, 4], RightShoulder: [0, 0, 4], Spine2: [-1.5, 0, 0] }) },
      { t: 3.46, pose: add(n(3, -5), { LeftShoulder: [0, 0, 1], RightShoulder: [0, 0, 1], Spine2: [1.5, 0, 0] }) },
      { t: 3.62, pose: add(n(-3, -5), { LeftShoulder: [0, 0, 3], RightShoulder: [0, 0, 3] }) },
      { t: 3.9, pose: n(0, -4) },
      { t: 4.2, pose: n(7, -3) },
      { t: 4.6, pose: n(0, -4) },
      { t: 5.2, pose: B0 },
    ], { loop: true });
  },
  // window shopping, the root ~0.7 m from the glass (the pointing fingertip reaches ~0.68 m): leaning in, scanning the
  // display left and right with head tilts, pointing at one item (with a tap toward the glass) once per cycle
  window_look: () => {
    const FEET = { ikL: [0.11, AY, 0.03, 0, 10], ikR: [-0.11, AY, 0.0, 0, 9] };
    const W = add(stand('R', 0.6, FEET), { hips: [0, 0, -0.022], Hips: [4, 0, 0], Spine: [4, 0, 0], Spine1: [3, 0, 0], Spine2: [2, 0, 0], Neck: [4, 0, 0], Head: [6, 0, 0] });
    const pt = (base, w, e, hand) => armAt(base, 'Right', w, e, -20, hand);
    const PT = add(W, { Spine: [1, 0, 0], Head: [-4, 0, 0] });
    return makeClip('window_look', [
      { t: 0, pose: look(W, 16) },
      { t: 1.3, pose: look(W, 6, 2, -6) },
      { t: 2.3, pose: look(add(W, { Spine: [2, 0, 0] }), -12, 2) },
      { t: 2.85, pose: pt(look(PT, -10), [-0.19, 1.12, 0.30], [-0.31, 1.02, 0.02], [0, 0, 0]) },
      { t: 3.25, pose: pt(look(PT, -8, -2), [-0.12, 1.37, 0.56], [-0.24, 1.12, 0.30], [-6, 0, 0]) },
      { t: 3.5, pose: pt(look(PT, -8, -2), [-0.12, 1.38, 0.60], [-0.24, 1.13, 0.32], [-10, 0, 0]) },
      { t: 3.72, pose: pt(look(PT, -7, -1), [-0.12, 1.37, 0.56], [-0.24, 1.12, 0.30], [-6, 0, 0]) },
      { t: 4.2, pose: pt(look(W, -4), [-0.21, 1.10, 0.26], [-0.31, 1.02, 0.0], [0, 0, 0]) },
      { t: 4.75, pose: look(W, 0, 2, 6) },
      { t: 5.8, pose: look(add(W, { Spine: [-2, 0, 0] }), 10, -2, 2) },
      { t: 7.0, pose: look(W, 16) },
    ], { loop: true });
  },
  laugh: () => {
    const UP = add(PED_A, { Spine1: [-2, 0, 0], Spine2: [-1, 0, 0], Neck: [-4, 0, 0], Head: [-8, 0, 2], LeftShoulder: [0, 0, 5], RightShoulder: [0, 0, 5] });
    const bend = add(PED_A, { Hips: [4, 0, 0], hips: [0, 0, -0.012], Spine: [5, 0, 0], Spine1: [5, 0, 0], Spine2: [3, 0, 0], Neck: [2, 0, 0], Head: [6, 0, 0], LeftShoulder: [0, 0, 3], RightShoulder: [0, 0, 3] });
    const DOWN = armAt(bend, 'Right', [-0.05, 1.03, 0.24], [-0.29, 0.98, 0.02], -20, [10, 0, 0]);
    const BNC = add(DOWN, { Spine2: [2, 0, 0], Spine1: [1, 0, 0], Head: [2, 3, 0], LeftShoulder: [0, 0, -2], RightShoulder: [0, 0, -2] });
    return makeClip('laugh', [
      { t: 0, pose: PED_A },
      { t: 0.18, pose: UP },
      { t: 0.42, pose: DOWN },
      { t: 0.56, pose: BNC },
      { t: 0.7, pose: DOWN },
      { t: 0.84, pose: add(BNC, { Head: [0, -5, 0] }) },
      { t: 0.98, pose: DOWN },
      { t: 1.12, pose: BNC },
      { t: 1.38, pose: armAt(add(PED_A, { Spine1: [1, 0, 0], Head: [2, 2, 0] }), 'Right', [-0.10, 1.02, 0.22], [-0.30, 0.98, 0.0], -10) },
      { t: 2.0, pose: PED_A },
    ]);
  },
  // a tourist taking in the district: gaze climbs the buildings to the left, sweeps across to the right (one-shot)
  look_around: () => makeClip('look_around', [
    { t: 0, pose: PED_A },
    { t: 0.55, pose: add(look(PED_A, 38, -22), { Hips: [0, 3, 0] }) },
    { t: 1.35, pose: add(look(PED_A, 48, -28, -3), { Hips: [0, 4, 0] }) },
    { t: 2.15, pose: add(look(PED_A, -36, -20, 2), { Hips: [0, -3, 0] }) },
    { t: 2.75, pose: look(PED_A, -12, -14) },
    { t: 3.4, pose: PED_A },
  ]),
  // a heated quarrel, the one pressing: leaning in, chin out, a half step in with three finger jabs, a half step
  // back, both arms flung out palms up ("haa?"), a chopping hand. Nothing lands (partner 0.9-1.0 m away). Loop,
  // in step with argue_back when both start at the same phase.
  argue: () => {
    const F0 = { ikL: [0.12, AY, 0.10, 0, 10], ikR: [-0.12, AY, -0.08, 0, 14] };
    const T = { ...F0, hips: [0.0, -0.04, 0.01], Hips: [3, 0, 0], Spine: [5, 0, 0], Spine1: [3, 0, 0], Spine2: [1, 0, 0], Neck: [7, 0, 0], Head: [-6, 0, 0],
      LeftShoulder: [4, 0, 4], RightShoulder: [4, 0, 4], LeftArm: [10, 2, -3], RightArm: [10, 2, -3], LeftForeArm: [42, 0, 0], RightForeArm: [42, 0, 0], LeftHand: [0, 0, 0], RightHand: [0, 0, 0] };
    const inFwd = { ikL: [0.12, AY, 0.24, 0, 10], ikR: ballPivot('R', F0.ikR, 12), hips: [0.0, -0.05, 0.085], Hips: [5, 0, 0], Spine: [7, 0, 0], Neck: [9, 0, 0], Head: [-7, 0, 0] };
    const R = (base, w, e = [-0.33, 1.1, -0.04], roll = 0, hand = [0, 0, 0]) => armAt(base, 'Right', w, e, roll, hand);
    const FWD = mix(T, inFwd);
    const OUT = add(armAt(armAt(T, 'Right', [-0.45, 1.12, 0.22], [-0.40, 1.16, -0.10], -70, [-10, 0, 0]), 'Left', [0.45, 1.12, 0.22], [0.40, 1.16, -0.10], -70, [-10, 0, 0]),
      { Spine1: [-4, 0, 0], Neck: [-2, 0, 0], Head: [-6, 0, 6], LeftShoulder: [0, 0, 8], RightShoulder: [0, 0, 8] });
    return makeClip('argue', [
      { t: 0, pose: T },
      { t: 0.35, pose: R(add(T, { Neck: [2, 0, 0] }), [-0.25, 1.27, 0.17], [-0.37, 1.06, -0.10]) },
      { t: 0.55, pose: R(add(T, { Spine: [1, 0, 0], Neck: [2, 0, 0] }), [-0.25, 1.28, 0.18], [-0.37, 1.06, -0.10]) },
      { t: 0.72, pose: R(mix(T, { ...inFwd, ikL: [0.12, AY + 0.05, 0.20, 8, 10], hips: [0, -0.045, 0.05] }), [-0.24, 1.27, 0.25], [-0.37, 1.06, -0.06]) },
      { t: 0.9, pose: R(FWD, [-0.12, 1.31, 0.34], [-0.34, 1.12, 0.02]) },
      { t: 1.0, pose: R(add(FWD, { Neck: [2, 0, 0] }), [-0.06, 1.32, 0.50], [-0.31, 1.20, 0.18], -30, [-4, 0, 0]) },
      { t: 1.15, pose: R(FWD, [-0.10, 1.30, 0.38], [-0.32, 1.16, 0.10], -30) },
      { t: 1.3, pose: R(add(FWD, { Neck: [2, 0, 0] }), [-0.06, 1.30, 0.50], [-0.31, 1.19, 0.18], -30, [-4, 0, 0]) },
      { t: 1.45, pose: R(FWD, [-0.10, 1.30, 0.38], [-0.32, 1.16, 0.10], -30) },
      { t: 1.6, pose: R(add(FWD, { Neck: [3, 0, 0], Head: [-2, 0, 0] }), [-0.05, 1.33, 0.51], [-0.31, 1.20, 0.18], -30, [-4, 0, 0]) },
      { t: 1.85, pose: R(FWD, [-0.18, 1.18, 0.26], [-0.34, 1.06, -0.04]) },
      { t: 2.05, pose: FWD },
      { t: 2.22, pose: mix(T, { ...inFwd, ikL: [0.12, AY + 0.04, 0.18, 6, 10], hips: [0, -0.045, 0.05], ikR: ballPivot('R', F0.ikR, 6) }) },
      { t: 2.4, pose: add(T, { Spine: [-1, 0, 0] }) },
      { t: 2.75, pose: OUT },
      { t: 2.95, pose: add(OUT, { Head: [0, 8, 0] }) },
      { t: 3.1, pose: add(OUT, { Head: [0, -6, 0] }) },
      { t: 3.28, pose: R(add(T, { Spine1: [-2, 0, 0] }), [-0.20, 1.46, 0.24], [-0.40, 1.22, 0.0], -10) },
      { t: 3.45, pose: R(add(T, { Spine: [3, 0, 0], Neck: [2, 0, 0] }), [-0.18, 1.06, 0.35], [-0.35, 1.08, 0.04], -10) },
      { t: 3.7, pose: R(T, [-0.18, 1.05, 0.30], [-0.34, 1.04, -0.02]) },
      { t: 4.0, pose: T },
    ], { loop: true });
  },
  // the other party: hands up and a half step back as the first one presses in, flinching at each jab, then pushing
  // back — a half step in, a finger of their own, a dismissive flick and a "me?!" hand to the chest. Loop (4 s).
  argue_back: () => {
    const F0 = { ikL: [0.12, AY, 0.06, 0, 10], ikR: [-0.12, AY, -0.08, 0, 14] };
    const T = { ...F0, hips: [0.0, -0.04, 0.0], Hips: [0, 0, 0], Spine: [0, 0, 0], Spine1: [-1, 0, 0], Spine2: [0, 0, 0], Neck: [3, 0, 0], Head: [-1, 0, 0],
      LeftShoulder: [2, 0, 3], RightShoulder: [2, 0, 3], LeftArm: [8, 2, -3], RightArm: [8, 2, -3], LeftForeArm: [36, 0, 0], RightForeArm: [36, 0, 0], LeftHand: [0, 0, 0], RightHand: [0, 0, 0] };
    const back = { ikR: [-0.12, AY, -0.24, 0, 14], hips: [0.0, -0.045, -0.075], Hips: [-2, 0, 0], Spine: [-3, 0, 0], Spine1: [-2, 0, 0], Neck: [3, 0, 0], Head: [4, 0, 0] };   // (neck / head take the lean back out: eyes stay on the other)
    const UP = (base) => armAt(armAt(base, 'Right', [-0.14, 1.22, 0.24], [-0.33, 1.04, 0.0], -20, [-45, 0, 0]), 'Left', [0.14, 1.22, 0.24], [0.33, 1.04, 0.0], -20, [-45, 0, 0]);
    const BACK = mix(T, back), flinch = (k) => add(UP(BACK), { Spine1: [-3 * k, 0, 0], Neck: [-1 * k, 3 * k, 0], Head: [-2 * k, 9 * k, 2 * k] });
    const IN = mix(T, { hips: [0.0, -0.045, 0.035], Hips: [3, 0, 0], Spine: [6, 0, 0], Spine1: [3, 0, 0], Neck: [8, 0, 0], Head: [-7, 0, 0] });
    const R = (base, w, e, roll = 0, hand = [0, 0, 0]) => armAt(base, 'Right', w, e, roll, hand);
    const POINT = (base, z) => armAt(R(base, [-0.06, 1.30, z], [-0.31, 1.19, z - 0.34], -30, [-4, 0, 0]), 'Left', [0.30, 1.07, 0.22], [0.36, 1.02, -0.08], -65, [-8, 0, 0]);
    return makeClip('argue_back', [
      { t: 0, pose: T },
      { t: 0.4, pose: UP(add(T, { Spine: [-2, 0, 0], Neck: [-1, 0, 0], Head: [-2, 0, 0] })) },
      { t: 0.55, pose: UP(add(T, { Spine: [-3, 0, 0], Neck: [-1, 0, 0], Head: [-2, 0, 0] })) },
      { t: 0.72, pose: UP(mix(T, { ...back, ikR: [-0.12, AY + 0.05, -0.16, -6, 14], hips: [0, -0.045, -0.04] })) },
      { t: 0.9, pose: UP(BACK) },
      { t: 1.02, pose: flinch(1) },
      { t: 1.2, pose: flinch(0.3) },
      { t: 1.32, pose: flinch(1) },
      { t: 1.5, pose: flinch(0.3) },
      { t: 1.62, pose: flinch(1.2) },
      { t: 1.9, pose: R(BACK, [-0.16, 1.16, 0.28], [-0.33, 1.04, -0.02]) },
      { t: 2.05, pose: R(add(BACK, { Spine: [3, 0, 0] }), [-0.14, 1.18, 0.30], [-0.33, 1.05, -0.02]) },
      { t: 2.22, pose: R(mix(T, { ...back, ikR: [-0.12, AY + 0.05, -0.15, 6, 14], hips: [0, -0.045, -0.03], Spine: [3, 0, 0], Neck: [4, 0, 0] }), [-0.12, 1.22, 0.30], [-0.33, 1.08, -0.02]) },
      { t: 2.4, pose: POINT(add(IN, { Neck: [1, 0, 0] }), 0.48) },
      { t: 2.58, pose: POINT(IN, 0.38) },
      { t: 2.74, pose: POINT(add(IN, { Neck: [2, 0, 0] }), 0.49) },
      { t: 3.0, pose: R(add(IN, { Head: [0, -6, 0] }), [-0.12, 1.22, 0.32], [-0.33, 1.08, 0.0], -40) },
      { t: 3.2, pose: R(add(T, { Head: [2, -20, 0], Neck: [0, -6, 0] }), [-0.40, 1.02, 0.18], [-0.40, 1.16, -0.08], -80, [10, 0, 0]) },
      { t: 3.5, pose: armAt(add(T, { Head: [0, -4, 0], Spine1: [-2, 0, 0] }), 'Left', [0.07, 1.27, 0.23], [0.34, 1.12, 0.04], 10, [-10, 0, 0]) },
      { t: 3.75, pose: armAt(T, 'Left', [0.16, 1.08, 0.26], [0.33, 1.02, -0.04], 0) },
      { t: 4.0, pose: T },
    ], { loop: true });
  },
  // perched on a guardrail (rail top ~0.78 m, 0.12 m behind the root): hands on the rail beside the hips, legs out,
  // looking about; one foot re-planted out and back. Place the root 0.12 m in front of the rail, facing away from it.
  sit_rail: () => {
    const RAIL = { ikL: [0.14, AY, 0.30, 0, 12], ikR: [-0.12, AY, 0.24, 0, 10], hips: [0, -0.12, -0.10], Hips: [-6, 0, 0], Spine: [8, 0, 0], Spine1: [4, 0, 0], Spine2: [2, 0, 0],
      Neck: [0, 0, 0], Head: [2, 0, 0], LeftShoulder: [0, 0, 4], RightShoulder: [0, 0, 4], LeftHand: [-20, 0, 0], RightHand: [-20, 0, 0] };
    const S = armAt(armAt(RAIL, 'Left', [0.27, 0.87, -0.15], [0.35, 1.05, -0.26], 10), 'Right', [-0.27, 0.87, -0.15], [-0.35, 1.05, -0.26], 10);
    return makeClip('sit_rail', [
      { t: 0, pose: look(S, 10) },
      { t: 1.5, pose: look(S, -6, 2) },
      { t: 2.5, pose: look(S, -18, 4) },
      { t: 2.85, pose: look(S, -16, 4) },
      { t: 3.05, pose: mix(look(S, -12, 4), { ikR: [-0.12, AY + 0.04, 0.20, 4, 10] }) },
      { t: 3.25, pose: mix(look(S, -8, 3), { ikR: [-0.10, AY, 0.16, 0, 16] }) },
      { t: 4.2, pose: mix(look(S, 6, -2), { ikR: [-0.10, AY, 0.16, 0, 16] }) },
      { t: 5.2, pose: mix(look(S, 10), { ikR: [-0.10, AY, 0.16, 0, 16] }) },
      { t: 5.4, pose: mix(look(S, 10), { ikR: [-0.11, AY + 0.04, 0.20, 4, 12] }) },
      { t: 5.6, pose: look(S, 10) },
      { t: 6.0, pose: look(S, 10) },
    ], { loop: true });
  },
};
Object.assign(BUILDERS, PED_BUILDERS);

// ------------------------------------------------------------------ left-handed twins (<name>_m)
// A frame mirrored through the body's midplane: limb channels trade sides unchanged (their Y / Z are already stored
// side-mirrored, see the header), centre bones negate Y / Z, the pelvis offset and the ankle targets negate x. The rig
// is left/right symmetric, so this is the exact mirror image of the pose.
function mirrorFrame(f) {
  const o = new Float64Array(NCH);
  for (const b of BONE_NAMES) {
    const c = CH[b];
    if (b.startsWith('Left') || b.startsWith('Right')) { const m = CH[b.startsWith('Left') ? 'Right' + b.slice(4) : 'Left' + b.slice(5)]; o[m] = f[c]; o[m + 1] = f[c + 1]; o[m + 2] = f[c + 2]; }
    else { o[c] = f[c]; o[c + 1] = -f[c + 1]; o[c + 2] = -f[c + 2]; }
  }
  o[CH.hips] = -f[CH.hips]; o[CH.hips + 1] = f[CH.hips + 1]; o[CH.hips + 2] = f[CH.hips + 2];
  for (const [a, b] of [['ikL', 'ikR'], ['ikR', 'ikL']]) { const ca = CH[a], cb = CH[b]; o[cb] = -f[ca]; for (let i = 1; i < 6; i++) o[cb + i] = f[ca + i]; }
  return o;
}
const mirrorFit = f => f ? {key:f.key+'~m', ...(f.rig?{rig:f.rig}:{}), ...(f.arms?{arms:{Left:f.arms.Right,Right:f.arms.Left}}:{})} : null;
function mirrorClip(name, base) {
  const mf = mirrorFit(FIT), clip = getClip(base, mf); if (!clip) return null;
  const frames = sampled.get(mf ? `${base}@${mf.key}` : base).map((fr) => ({ t: fr.t, f: mirrorFrame(fr.f) })), ud = { ...clip.userData };
  delete ud.fit;
  const events = (ud.events || []).map((e) => (e.foot ? { ...e, foot: e.foot === 'L' ? 'R' : 'L', bone: e.foot === 'L' ? 'RightFoot' : 'LeftFoot' } : { ...e }));
  return makeClipFromFrames(name, frames, { ...ud, events, mirrorOf: base });
}
for (const n of PED_MIRRORED) BUILDERS[n + '_m'] = () => mirrorClip(n + '_m', n);

// ------------------------------------------------------------------ which hands a scanned passer-by can move
// Read off the pipeline's rigging notes (assets/peds/pipeline/peds.config.mjs): [right, left], each
//   'free'   an empty hand                 'small'  a map / bottle / notebook rides the hand (it may gesture with it)
//   'bag'    a hanging bag or case rides the hand: raise that arm and the bag comes up to the chest -> keep it down
//   'locked' the arm's mesh rides the torso (hand in a pocket, round a folder, a cup at the chest): the clip's arm
//            moves nothing, the scan keeps its own pose there
export const PED_HANDS = {
  formal_portrait_4019: ['free', 'free'], smiling_businesswoman_4044: ['bag', 'free'], modern_office_profess_4034: ['locked', 'locked'],
  confident_professiona_5856: ['locked', 'free'], confident_professiona_5913: ['bag', 'locked'], confident_modern_gent_4727: ['locked', 'free'],
  silver_noir_swagger_4736: ['free', 'locked'], man_in_black_casual_o_5836: ['free', 'free'], anime_inspired_street_0039: ['locked', 'bag'],
  elegant_night_out_4745: ['locked', 'locked'], evening_walk_in_the_c_4029: ['locked', 'free'], high_school_student_5828: ['free', 'bag'],
  thoughtful_schoolgirl_5927: ['locked', 'locked'], casual_student_portra_4103: ['locked', 'locked'], confident_young_stude_4122: ['locked', 'bag'],
  smiling_student_with_4700: ['locked', 'locked'], scholar_s_path_4057: ['bag', 'free'], wanderlust_explorer_4828: ['small', 'small'],
  ready_for_the_trail_4758: ['small', 'small'], confident_business_pr_5909: ['free', 'locked'], confident_professiona_5901: ['small', 'locked'],
  confident_professiona_0118: ['locked', 'locked'], mexican_traveler_5850: ['small', 'small'], wandering_photographe_5203: ['locked', 'free'],
};
const handOK = (s) => s === 'free' || s === 'small';
// the variant of a pedestrian clip for a scan (key or 'ped_<key>'): the base clip gestures with the right hand, so a
// scan whose right hand cannot and whose left can plays the _m twin. Anything else plays `name` unchanged.
export function pedClipFor(name, key) {
  const h = PED_HANDS[String(key).replace(/^ped_/, '')];
  if (!h || !PED_MIRRORED.includes(name)) return name;
  return !handOK(h[0]) && handOK(h[1]) ? name + '_m' : name;
}
// the arms ('Left' / 'Right') a crowd body should hold at its scan's own hang while it plays a pedestrian clip: the
// hands carrying a hanging bag (slerp that arm chain — Shoulder, Arm, ForeArm, Hand — to the scan's bind pose)
export function pedArmMask(key) {
  const h = PED_HANDS[String(key).replace(/^ped_/, '')];
  return h ? ['Right', 'Left'].filter((s, i) => h[i] === 'bag') : [];
}

// getClip(name) -> the clip (cached). getClip(name, fit) — for the pedestrian clips (and their _m twins) only — the same
// clip re-solved against ONE scan's arm lengths (pedFit(h)): every arm target (phone at the ear, hand on the hip, the
// watch, the point) lands where it was authored instead of up to ~15 % further out on a long-armed scan. Same name,
// Cached per scan key. fit.rig also re-solves every hero clip against its own bind rig.
const PED_SET = new Set([...PED_CLIPS, ...PED_MIRRORED.map((n) => n + '_m')]);
export function getClip(name, fit = null) {
  const f = fit?.key && (fit.rig || (fit.arms && PED_SET.has(name))) ? fit : null;
  const ck = f ? `${name}@${f.key}` : name;
  if (cache.has(ck)) return cache.get(ck);
  const b = BUILDERS[name];
  if (!b) { console.warn('[animations] unknown clip', name); return null; }
  let clip = null;
  const prev = FIT, previousRig = RIG;
  const previousLeg = [L_THIGH, L_SHIN, ANKLE_Y, BIND_FOOT_PITCH];
  FIT = f;
  if(f?.rig){
    RIG=f.rig;
    L_THIGH=RIG.world.LeftUpLeg.length;L_SHIN=RIG.world.LeftLeg.length;
    ANKLE_Y=RIG.joints.LeftFoot[1];
    BIND_FOOT_PITCH=Math.atan2(RIG.joints.LeftToeBase[1]-ANKLE_Y,RIG.joints.LeftToeBase[2]-RIG.joints.LeftFoot[2])*R2D;
  }
  try { clip = b(); } catch (e) { console.warn(`[animations] clip "${name}" failed`, e); return null; }
  finally { FIT=prev;RIG=previousRig;[L_THIGH,L_SHIN,ANKLE_Y,BIND_FOOT_PITCH]=previousLeg; }
  cache.set(ck, clip);
  return clip;
}
// the arm fit of a humanoid built from a scan (read off its bind skeleton: a bone's local offset is its parent's
// length, in the rig's own metres — the group scale is the person's height). Pass it to getClip(name, fit).
export function pedFit(h) {
  const B = h && h.bones; if (!B || !B.LeftHand || !B.RightHand) return null;
  const len = (b) => B[b].position.length();
  const arms = { Left: [len('LeftForeArm'), len('LeftHand')], Right: [len('RightForeArm'), len('RightHand')] };
  if (!(arms.Left[0] > 0.1 && arms.Left[1] > 0.1 && arms.Right[0] > 0.1 && arms.Right[1] > 0.1)) return null;
  return { key: h.ped || arms.Left.concat(arms.Right).map((v) => v.toFixed(3)).join(','), arms };
}
export function getFrames(name, fit = null) { getClip(name, fit); return sampled.get(fit && fit.arms && fit.key && PED_SET.has(name) ? `${name}@${fit.key}` : name) || null; }
// evaluate a single pose object (authoring / tests): { pos, quat, tip(bone) }
export function poseFK(pose) { const fk = fkFrame(frameFromPose(pose)); fk.tip = (b) => tipOf(fk, b); return fk; }

// ------------------------------------------------------------------ shot presets (full-body views for the animation critic)
// ?shot=anim_body&anim=<clip>&phase=<0..1>   (player_closeup is the foundation's head-and-shoulders framing)
// The player is moved to a clear spot on the scramble crossing facing south-west (Q-Front / Center-gai behind him)
// and the crowd is hidden so limbs read; the camera is computed from that spot.
const ANIM_SPOT = { pos: [-3, 0, 5], yaw: -Math.PI / 4 };
function bodyPreset(azDeg, dist, height, lookY, fov) {
  return () => {
    const pos = new THREE.Vector3(...ANIM_SPOT.pos), a = ANIM_SPOT.yaw + azDeg * D2R;
    const cam = pos.clone().add(new THREE.Vector3(Math.sin(a) * dist, height, Math.cos(a) * dist));
    return { pos: cam.toArray(), lookAt: [pos.x, pos.y + lookY, pos.z], fov, t: 'night',
      setup(eng) {
        const pl = eng.player; if (!pl) return;
        pl.position.set(...ANIM_SPOT.pos); pl.yaw = ANIM_SPOT.yaw; pl.group.position.copy(pl.position); pl.group.rotation.y = pl.yaw;
        const cr = eng.get('crowd');
        if (cr) for (const k of ['torso', 'head', 'hair', 'legL', 'legR', 'armL', 'armR', 'umbrella', 'group', 'mesh']) if (cr[k] && cr[k].isObject3D) cr[k].visible = false;
      } };
  };
}
// ?shot=pedclips&clip=<name>&phase=<0..1>&v=<key>[,<key>...]   the pedestrian clips on the client's scans
//   2-4 scanned passers-by (PED_SCANS keys, or any unique part of one; default a salaryman and an office woman) at
//   their real heights, side by side on the crossing at night, crowd / traffic / player hidden, every body posed exactly
//   as the crowd poses a pool body: the clip through the mixer at that phase, nothing else (humanoid.update's wrist
//   clamp runs on it, as on the crowd's). The conversation / quarrel clips stand as facing pairs (talk_stand <->
//   talk_listen 1.1 m apart, argue <-> argue_back 1.2 m: the 1st, 3rd .. key plays the named clip, the next one its
//   partner); walk_chat pairs side by side with walk_chat_r. &pair=0 turns that off.
//   &view=front|side|back|left|top (default a front 3/4; pairs in profile)   &prop=0 no phone   &pp=<phase> partner phase
//   &auto=1 each scan plays its own variant (pedClipFor: the _m twin when only its left hand is free) with its bag arms held down
//   &fit=0 the generic clip instead of the one fitted to each scan's arm lengths (getClip(name, pedFit(h)))
//   &cam=x,y,z&look=x,y,z&fov=n   move the lens
const PED_PAIR = { talk_stand: 'talk_listen', talk_listen: 'talk_stand', argue: 'argue_back', argue_back: 'argue', walk_chat: 'walk_chat_r', walk_chat_r: 'walk_chat' };
const PED_PHONE = new Set(['walk_phone', 'idle_wait', 'idle_phone_call']);
const PED_SHOT = { pos: [-3, 0, 5], yaw: -Math.PI / 4, keys: ['formal_portrait_4019', 'smiling_businesswoman_4044'], bodies: [] };
function pedClipsPreset({ engine } = {}) {
  const raw = (engine && engine.params && engine.params.raw) || {};
  const v3 = (s, d) => (s && s.split(',').length === 3 ? s.split(',').map(Number) : d);
  const clip = raw.clip || raw.anim || 'idle_wait', phase = Number(raw.phase) || 0;
  const want = (raw.v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const n = Math.max(1, Math.min(4, want.length || 2));
  const paired = raw.pair !== '0' && !!PED_PAIR[clip], face = paired && !clip.startsWith('walk');
  // layout along the stage's lateral axis (metres), yaw offsets relative to the stage facing
  const slots = [];
  for (let i = 0; i < n; i++) {
    if (face) { const pr = Math.floor(i / 2), a = i % 2 === 0, half = (clip.startsWith('argue') ? 1.2 : 1.1) / 2; slots.push({ x: (pr - (Math.ceil(n / 2) - 1) / 2) * 2.6 + (a ? -half : half), yaw: a ? Math.PI / 2 : -Math.PI / 2, partner: !a }); }
    else if (paired) { const pr = Math.floor(i / 2), a = i % 2 === 0; slots.push({ x: (pr - (Math.ceil(n / 2) - 1) / 2) * 1.9 + (a ? -0.33 : 0.33), yaw: 0, partner: !a }); }
    else slots.push({ x: (i - (n - 1) / 2) * 1.0, yaw: 0, partner: false });
  }
  const S = new THREE.Vector3(...PED_SHOT.pos), Y0 = PED_SHOT.yaw;
  const fwd = new THREE.Vector3(Math.sin(Y0), 0, Math.cos(Y0)), lat = new THREE.Vector3(Math.cos(Y0), 0, -Math.sin(Y0));
  const view = raw.view || (face ? 'front0' : 'front');
  const az = { front: -28, front0: 0, side: 90, left: -90, back: 180, top: -20 }[view] ?? -28;
  const span = Math.max(...slots.map((s) => Math.abs(s.x))) * 2 + 1.0;
  const dist = Math.max(3.9, span * 1.15 + 1.6), a = az * D2R;
  const camPos = S.clone().addScaledVector(fwd, Math.cos(a) * dist).addScaledVector(lat, -Math.sin(a) * dist);
  camPos.y += view === 'top' ? 3.4 : 1.2;
  return { pos: v3(raw.cam, camPos.toArray()), lookAt: v3(raw.look, [S.x, 0.86, S.z]), fov: Number(raw.fov) || 34, t: 'night',
    setup(eng) {
      const hum = eng.get('humanoid');
      if (!hum || !hum.pedScansReady) { console.warn('[animations] pedclips: no humanoid ped scans'); return; }
      PED_SHOT.active = true; pedShotHide(eng);
      hum.pedScansReady().then(() => {
        for (const h of PED_SHOT.bodies) h.dispose();
        PED_SHOT.bodies = [];
        const scans = hum.PED_SCANS.filter((p) => hum.pedScanReady(p.key));
        const pick = (s, i) => scans.find((p) => p.key === s || p.variant === s) || scans.find((p) => p.key.includes(s)) || scans[(i * 7) % scans.length];
        const cast = (want.length ? want : PED_SHOT.keys).slice(0, n).map(pick);
        slots.forEach((sl, i) => {
          const p = cast[i % cast.length]; if (!p) return;
          let name = sl.partner ? PED_PAIR[clip] : clip;
          const ph = sl.partner && raw.pp != null ? Number(raw.pp) || 0 : phase, auto = raw.auto === '1';
          if (auto) name = pedClipFor(name, p.key);
          // each body plays the clip fitted to its own arms (pedFit), exactly as a crowd body should (&fit=0: the generic clip)
          let fit = null;
          const h = hum.createHumanoid({ variant: p.variant, seed: 5 + i * 3, detail: 1, lod: false, getClip: (n) => getClip(n, fit) });
          fit = raw.fit === '0' ? null : pedFit(h);
          const bindQ = {}; for (const b of BONE_NAMES) if (h.bones[b]) bindQ[b] = h.bones[b].quaternion.clone();
          const pos = S.clone().addScaledVector(lat, sl.x), W = eng.world;
          const gy = W && typeof W.groundHeight === 'function' ? W.groundHeight(pos.x, pos.z) : 0;
          h.group.position.set(pos.x, Number.isFinite(gy) ? gy : 0, pos.z);
          h.group.rotation.y = Y0 + sl.yaw;
          eng.scene.add(h.group);
          if (PED_PHONE.has(name) && raw.prop !== '0' && h.setProp) h.setProp('phone');   // (right-hand slot only: none on a _m twin)
          const act = h.play(name, { fade: 0, loop: true, force: true });
          if (act) { h.mixer.update(0); act.time = Math.max(0, Math.min(0.999, ph)) * act.getClip().duration; h.mixer.update(0); }
          // &auto=1: as the crowd should play it — the scan's variant (pedClipFor) and its bag arms held at the hang
          if (auto) for (const side of pedArmMask(p.key)) for (const b of ['Shoulder', 'Arm', 'ForeArm', 'Hand']) if (bindQ[side + b]) h.bones[side + b].quaternion.copy(bindQ[side + b]);
          h.pedClip = name;
          h.frozenPose = true;
          h.group.updateMatrixWorld(true);
          PED_SHOT.bodies.push(h);
        });
        console.info(`[animations] pedclips ${clip}@${phase} ` + PED_SHOT.bodies.map((h, i) => `${cast[i % cast.length].key}:${h.pedClip}`).join(' '));
      });
    } };
}
// review frames only: nothing but the posed bodies — crowd (its roots and pool bodies re-bound every frame), traffic,
// the player
function pedShotHide(eng) {
  try {
    for (const o of eng.scene.children) if (o.visible && o.name && (o.name.startsWith('crowd:') || o.name.startsWith('crowdScan'))) o.visible = false;
    for (const n of ['traffic', 'crowd']) { const m = eng.get(n); for (const k of ['root', 'group', 'container']) if (m && m[k] && m[k].isObject3D) { m[k].visible = false; break; } }
    const hum = eng.get('humanoid');
    if (hum && hum.all) for (const h of hum.all) if (h.group.visible && !PED_SHOT.bodies.includes(h)) h.group.visible = false;
    if (eng.player && eng.player.group) eng.player.group.visible = false;
  } catch (e) { void e; }
}
export const shotPresets = {
  pedclips: pedClipsPreset,
  anim_body:  bodyPreset(-40, 4.2, 1.35, 0.95, 36),   // front-right 3/4, whole body
  anim_side:  bodyPreset(-90, 4.2, 1.2, 0.95, 36),    // pure right-side profile (stride / lean)
  anim_front: bodyPreset(0, 4.2, 1.35, 0.95, 36),
  anim_back:  bodyPreset(180, 4.2, 1.5, 0.95, 36),
  anim_left:  bodyPreset(90, 4.2, 1.2, 0.95, 36),
  anim_upper: bodyPreset(-35, 2.7, 1.45, 1.2, 32),    // fists / guard / face
  anim_low:   bodyPreset(-60, 3.6, 0.5, 0.5, 34),     // feet, knees (foot planting)
};

// ------------------------------------------------------------------ self test (?test=animations)
// every clip exists with its nominal duration, only contract bones, finite values, hit/footstep events where required,
// knees/elbows inside their hinge range on every sampled frame, no foot below the ground while standing, and the
// planted foot in walk/run travelling at exactly -speed (no sliding at timeScale 1).
const ATTACK_CLIPS = ['jab', 'straight', 'hook', 'uppercut', 'kick', 'roundhouse', 'grab', 'throw', 'heat_finisher'];
const LYING_CLIPS = ['knockdown', 'getup', 'dead'];
export function selfTest() {
  const out = { clips: 0, ok: true, problems: [], slide: {} };
  const valid = new Set(BONE_NAMES), fk = { pos: {}, quat: {} };
  for (const name of CLIPS) {
    const clip = getClip(name);
    if (!clip) { out.problems.push(`${name}: missing`); continue; }
    out.clips++;
    if (Math.abs(clip.duration - DURATIONS[name]) > 0.02) out.problems.push(`${name}: duration ${clip.duration.toFixed(2)} != ${DURATIONS[name]}`);
    for (const tr of clip.tracks) {
      const bone = tr.name.split('.')[0];
      if (!valid.has(bone)) out.problems.push(`${name}: bad bone ${bone}`);
      for (let i = 0; i < tr.values.length; i++) if (!Number.isFinite(tr.values[i])) { out.problems.push(`${name}: NaN in ${tr.name}`); break; }
    }
    const events = clip.userData.events || [];
    for (const ev of events) {
      if (!(ev.time >= 0 && ev.time <= clip.duration)) out.problems.push(`${name}: event out of range`);
      if (ev.name === 'hit' && !['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'].includes(ev.bone)) out.problems.push(`${name}: hit bone ${ev.bone}`);
    }
    if (ATTACK_CLIPS.includes(name) && !events.some(e => e.name === 'hit')) out.problems.push(`${name}: no hit event`);
    if ((name === 'walk' || name === 'run') && events.filter(e => e.name === 'footstep').length !== 2) out.problems.push(`${name}: footstep events`);
    const frames = sampled.get(name) || [];
    let knee = null, elbow = null, low = null;
    for (const fr of frames) {
      for (const b of ['LeftLeg', 'RightLeg']) { const x = fr.f[CH[b]]; if ((x > 1.5 || x < -155) && !knee) knee = `${b} ${x.toFixed(0)}° @${fr.t.toFixed(2)}`; }
      for (const b of ['LeftForeArm', 'RightForeArm']) { const x = fr.f[CH[b]]; if ((x < -1.5 || x > 155) && !elbow) elbow = `${b} ${x.toFixed(0)}° @${fr.t.toFixed(2)}`; }
      if (!LYING_CLIPS.includes(name) && !low) {
        const r = fkFrame(fr.f, fk);
        for (const b of ['LeftFoot', 'RightFoot']) if (r.pos[b].y < ANKLE_Y - 0.03) { low = `${b} y=${r.pos[b].y.toFixed(2)} @${fr.t.toFixed(2)}`; break; }
      }
    }
    if (knee) out.problems.push(`${name}: knee ${knee}`);
    if (elbow) out.problems.push(`${name}: elbow ${elbow}`);
    if (low) out.problems.push(`${name}: foot below ground ${low}`);
  }
  for (const [name, speed] of [['walk', WALK_SPEED], ['run', RUN_SPEED]]) {
    const frames = sampled.get(name); if (!frames) continue;
    let worst = 0, n = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i], dt = b.t - a.t;
      for (const s of ['L', 'R']) {
        const c = CH[LEGS[s].ik];
        if (Math.abs(a.f[c + 3]) > 0.5 || Math.abs(b.f[c + 3]) > 0.5) continue;      // flat-foot mid-stance samples only
        const v = (b.f[c + 2] - a.f[c + 2]) / dt;
        worst = Math.max(worst, Math.abs(v + speed)); n++;
      }
    }
    out.slide[name] = { samples: n, worstErr: +worst.toFixed(3) };
    if (n === 0 || worst > speed * 0.03) out.problems.push(`${name}: planted foot slides (err ${worst.toFixed(2)} m/s over ${n} samples)`);
  }
  // pedestrian clips: a loop's last frame IS its first; a walking one's planted foot travels at exactly -speed; a
  // standing one's planted feet do not creep (a step lifts the foot); hands and forearms stay off the body (an
  // ellipse per height band, clothes included — only idle_phone_call's hand on the hip may touch)
  const BODY = (y) => (y < 0.80 ? null : y < 1.05 ? [0.175, 0.13] : y < 1.25 ? [0.16, 0.12] : y < 1.45 ? [0.18, 0.13] : null);
  const TOUCH = new Set(['idle_phone_call', 'idle_phone_call_m']), _hv = new THREE.Vector3(), _hi = new THREE.Quaternion();
  out.ped = {};
  for (const name of CLIPS) {
    if (!PED_CLIPS.includes(name) && !name.endsWith('_m')) continue;
    const clip = getClip(name), frames = sampled.get(name); if (!clip || !frames) continue;
    let seam = 0, slide = 0, drift = 0, clear = Infinity;
    if (clip.userData.loop) { const a = frames[0].f, b = frames[frames.length - 1].f; for (let c = 0; c < NCH; c++) seam = Math.max(seam, Math.abs(a[c] - b[c])); }
    const speed = clip.userData.speed || 0;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i].f;
      if (i > 0) for (const s of ['L', 'R']) {
        const c = CH[LEGS[s].ik], g = frames[i - 1].f, dt = (frames[i].t - frames[i - 1].t) || 1;
        if (Math.abs(f[c + 3]) > 0.5 || Math.abs(g[c + 3]) > 0.5 || f[c + 1] > ANKLE_Y + 0.002 || g[c + 1] > ANKLE_Y + 0.002) continue;
        if (speed) slide = Math.max(slide, Math.abs((f[c + 2] - g[c + 2]) / dt + speed));
        else drift = Math.max(drift, Math.hypot(f[c] - g[c], f[c + 2] - g[c + 2]) / dt);
      }
      if (i % 2) continue;
      const r = fkFrame(f, fk);
      _hi.copy(r.quat.Hips).invert();
      for (const side of ['Left', 'Right']) for (const [b, k] of [[side + 'ForeArm', 0], [side + 'ForeArm', 0.5], [side + 'Hand', 0], [side + 'Hand', 0.5]]) {
        _hv.set(0, RIG.world[b].length * k, 0).applyQuaternion(r.quat[b]).add(r.pos[b]);
        const e = BODY(_hv.y); if (!e) continue;
        _hv.sub(r.pos.Hips).applyQuaternion(_hi);
        clear = Math.min(clear, (Math.hypot(_hv.x / e[0], _hv.z / e[1]) - 1) * Math.min(e[0], e[1]));
      }
    }
    out.ped[name] = { seam: +seam.toFixed(4), ...(speed ? { slide: +slide.toFixed(3) } : { drift: +drift.toFixed(3) }), clear: +clear.toFixed(3) };
    if (seam > 1e-3) out.problems.push(`${name}: loop seam ${seam.toFixed(3)}`);
    if (speed && slide > speed * 0.03) out.problems.push(`${name}: planted foot slides (err ${slide.toFixed(2)} m/s)`);
    if (!speed && drift > 0.08) out.problems.push(`${name}: planted foot creeps ${drift.toFixed(2)} m/s`);
    if (clear < (TOUCH.has(name) ? -0.01 : 0.01)) out.problems.push(`${name}: arm inside the body (${clear.toFixed(3)} m)`);
  }
  out.ok = out.problems.length === 0;
  return out;
}

const animations = {
  name: 'animations',
  CLIPS, DURATIONS, getClip, getFrames, makeClip, fkFrame, poseFK, CH, RIG, shotPresets, selfTest,
  PED_CLIPS, PED_MIRRORED, PED_HANDS, pedClipFor, pedArmMask, pedFit,
  init(engine) {
    this.engine = engine;
    for (const n of CLIPS) getClip(n);
    const hum = engine.get('humanoid');
    if (hum && !hum.getClip) hum.getClip = getClip;
  },
  update() {
    if (PED_SHOT.active && this.engine) pedShotHide(this.engine);
    // ?animdbg=1: log the rendered skeleton's key joints (player-local metres) once, to cross-check the authored pose
    const eng = this.engine, p = eng && eng.player;
    if (!eng || !p || !p.humanoid || this.__dbg || !eng.params?.raw?.animdbg) return;
    if (this.__dbgFrames === undefined) this.__dbgFrames = 0;
    if (++this.__dbgFrames < 4) return;
    this.__dbg = true;
    p.group.updateMatrixWorld(true);
    const out = {};
    for (const b of ['Head', 'LeftHand', 'RightHand', 'LeftForeArm', 'RightForeArm', 'LeftFoot', 'RightFoot', 'LeftLeg', 'RightLeg', 'Hips']) {
      const v = p.humanoid.boneWorld(b); p.group.worldToLocal(v); out[b] = v.toArray().map(x => +x.toFixed(2));
    }
    console.info('[animdbg] ' + p.humanoid.current() + ' ' + JSON.stringify(out));
  },
};

export default animations;
