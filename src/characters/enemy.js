// [enemy] Enemy AI for chapter 1's three chinpira. Plan A (docs/CRP.md): the yakuza and boss variants are deleted, so a
//   'yakuza' / 'boss' request spawns a chinpira. Group behaviour after 龍が如く:
//   - attack token: one man swings at a time (a second only once the first is committed); the rest hold surround
//     slots on a ring round 健人 (kept apart on screen, never parked behind his back), shuffle in stance, taunt
//   - wind-up: every opening blow chambers and HOLDS 0.3–0.5 s: a full-body chamber posed by IK after the mixer (fist
//     cocked, weight on the rear foot, lead shoulder down, chin tucked) under combat's red rim and fist glint; the
//     release commits (≤15° of correction, none for the brute) and steps in along his own facing
//   - personalities: brute (the salaryman's scan at 1.08 in a white suit, armoured haymaker, shoulder tackle),
//     guard (the vagrant's scan in an ivory スカジャン, blocks a string and counters, jab-jab-knee, collar-grab
//     headbutt), coward (wanderer in a violet hoodie, slap string and low kick, darts in while you are busy with
//     someone else, backs off when hurt); each stands in his own stance (STANCE) built on idle_combat
//   - reactions play out (85 % of combat's clip), stagger per persona; a KO lies there until the fight is over and
//     dithers away off screen or under the victory cut; ¥ burst
//   - bodies: the scans' carried props culled and their worst skinning mended per spawn; a runtime foot lock on the
//     stance shuffle; the scan's LOD ladder picked by distance here
//   enemy.spawn(type, position, {name, persona, variant, aggro, ownClothes}) -> entity
//   enemy.spawnGroup(n | {count, personas, types}, around, type?) -> entity[]    enemy.clear()    enemy.list[]
//   events out: enemy:spawned {entity}, enemy:ko {entity, position}, combat:telegraph {attacker, name, hold},
//               combat:armor {target, attacker, point, dir}, sfx:voice {entity, name, text, line}, sfx:footstep
//   ?fight=1 spawns the three at init; ?enemylab=1 runs 30 s of live fight against a scripted 健人 and logs how many
//   men swung at once; ?shot=enemy_ring freezes the live AI mid wind-up; ?shot=enemy_cast is the model review frame.
import * as THREE from 'three';
import { CITY } from '../world/cityData.js';
import { createHumanoid, BONE_NAMES } from './humanoid.js';

const TYPES = { chinpira: { hp: 70, names: ['チンピラ', '半グレ', '兄貴分'] } };
TYPES.yakuza = TYPES.chinpira; TYPES.boss = TYPES.chinpira;

// wind: the chamber hold of an opening blow (s); follow: the hold of a chained link; strike: swing speed on release;
// ring: where he waits (m from 健人); rest: breather after a string; downT: time on the floor before the get-up;
// block: chance he reads a swing coming at him and guards (then counters); roll: combat's random block (integration request)
const PERSONA = {
  brute: { variant: 'enforcer_b', scale: 1.06, name: 'チンピラ', hp: 85, walk: 1.9, run: 3.4, shuffle: 1.05, ring: 2.5,
    wind: [0.44, 0.52], follow: 0.22, strike: 0.9, combos: [['brute_haymaker'], ['straight', 'hook'], ['brute_tackle'], ['hook'], ['brute_haymaker']],
    rest: [1.4, 2.3], downT: 1.9, block: 0, roll: 0, eager: 0.9, taunt: 0.8, turn: 5, retreat: 0, feint: false,
    chamber: 1.3, commitTurn: 0, stagger: 0.6 },
  guard: { variant: 'enforcer_a', name: '兄貴分', hp: 75, walk: 2.1, run: 4.0, shuffle: 1.2, ring: 2.8,
    wind: [0.36, 0.42], follow: 0.18, strike: 1.0, combos: [['straight'], ['jab', 'jab', 'guard_knee'], ['jab', 'hook'], ['guard_headbutt'], ['uppercut']],
    counter: ['straight', 'uppercut'], rest: [1.3, 2.2], downT: 1.2, block: 0.6, roll: 0.2, eager: 0.1, taunt: 0.6, turn: 7, retreat: 0, feint: true,
    chamber: 1.0, stagger: 1.0 },
  coward: { variant: 'wanderer', name: '半グレ', hp: 55, walk: 2.5, run: 4.6, shuffle: 1.45, ring: 3.5,
    wind: [0.3, 0.34], follow: 0.14, strike: 1.1, combos: [['jab'], ['coward_slaps'], ['jab', 'jab', 'straight'], ['coward_lowkick'], ['jab', 'coward_lowkick']],
    rest: [1.0, 1.9], downT: 1.35, block: 0, roll: 0.08, eager: -0.5, taunt: 1.2, turn: 9, retreat: 0.65, feint: true,
    chamber: 0.85, stagger: 1.3 },
};
const CAST = ['brute', 'guard', 'coward'];
const LINES = {
  taunt: ['ざけんな！', 'ぶっ殺す！', 'オラ、かかってこいよ！', 'なめてんじゃねえぞ、オッサン！', 'ビビってんのか？', 'スーツが泣いてんぞ！'],
  floor: ['立てよ、オラ！', 'もう終わりかァ？'],
  getup: ['この野郎……！', 'いってえな、クソが……！'],
  scared: ['ひっ……！', 'ちょ、待てって！'],
  counter: ['甘えんだよ！', '見えてんだよ！'],
  last: ['く、来るんじゃねえ！'],
};

// clip time of the chamber key in animations.js (fist/foot drawn back, just before it is driven out)
const CHAMBER = { jab: 0.06, straight: 0.09, hook: 0.12, uppercut: 0.15, kick: 0.15, roundhouse: 0.18,
  brute_haymaker: 0.18, brute_tackle: 0.22, coward_slaps: 0.05, coward_lowkick: 0.14, guard_knee: 0.14, guard_headbutt: 0.34 };
// the persona moves' numbers, registered into combat.ATTACKS (combat bookkeeps with a library clip, enemy.js then
// plays the persona clip on the record: see startLink / integration request 2)
const MOVE_DEFS = {
  brute_haymaker: { dmg: 16, heavy: true, reach: 1.45, knock: 4.0, push: 1.2, heat: 10, stop: 86, shake: [0.42, 0.3], fx: 1.35, guard: 60, rate: 1.0, lunge: 0.5, clip: 'hook', sweep: [0.6, -0.3] },
  brute_tackle: { dmg: 13, heavy: true, reach: 1.3, knock: 4.4, push: 1.8, heat: 8, stop: 80, shake: [0.36, 0.26], fx: 1.2, guard: 80, rate: 1.0, lunge: 0.7, clip: 'hook', react: 'stumble', step: 1.1 },
  coward_slaps: { dmg: 4, heavy: false, reach: 1.3, knock: 1.4, push: 0.2, heat: 3, stop: 50, shake: [0.08, 0.08], fx: 0.7, guard: 12, rate: 1.15, lunge: 0.4, clip: 'jab' },
  coward_lowkick: { dmg: 8, heavy: false, reach: 1.5, knock: 2.0, push: 0.3, heat: 5, stop: 60, shake: [0.15, 0.12], fx: 0.9, guard: 20, rate: 1.0, lunge: 0.5, clip: 'kick', react: 'stumble' },
  guard_knee: { dmg: 11, heavy: true, reach: 1.1, knock: 2.4, push: 0.4, heat: 7, stop: 76, shake: [0.3, 0.2], fx: 1.1, guard: 40, rate: 1.0, lunge: 0.5, clip: 'kick' },
  guard_headbutt: { dmg: 14, heavy: true, reach: 1.05, knock: 3.4, push: 0.9, heat: 9, stop: 86, shake: [0.42, 0.3], fx: 1.3, guard: 100, rate: 1.0, lunge: 0.55, clip: 'hook', react: 'stumble' },
};
const HOLD_CREEP = 0.05;            // clip speed through the hold: the chamber keeps tightening instead of freezing
const MAX_TOKENS = 2;
const RING_STEP = 1.55;             // rad between neighbours on the ring: three men span half a circle round him
const HOLDER_GAP = 0.95;            // rad the waiting men keep clear of a man who is swinging
const SEP = 1.6;                    // m two standing men keep between them
// stance-shuffle clips: two stride sets (a stride is only foot-locked at the speed it was authored for, so a 0.3 m/s
// drift plays the short set rather than the long one slowed past its floor), stance fraction STANCE_F
const STANCE_V = 1.0, STANCE_VS = 0.4, STANCE_F = 0.6, STANCE_SLOW = 0.65;
// per persona: T cycle (s), dip (m, lowest in double support), bounce (m, a second bob per step: on his toes),
// sway (m over the planted foot), fist (deg of fist bob), counter (deg of shoulder-line counter-rotation)
const GAIT = {
  brute: { T: 0.68, dip: 0.04, bounce: 0, sway: 0.022, fist: 3.5, counter: 5 },
  guard: { T: 0.6, dip: 0.024, bounce: 0.004, sway: 0.016, fist: 4, counter: 6 },
  coward: { T: 0.5, dip: 0.016, bounce: 0.014, sway: 0.012, fist: 5.5, counter: 7 },
};
// Each persona's own stance, applied to every key of the library's idle_combat (a boxer's crouch: hips 11 cm down,
// feet wide and bladed) and to everything built on it (the shuffle, the persona moves). lift: m the hips come up;
// feet: [lateral, fore-aft] scale of the planted feet; toe: [pitch deg, lift m] of both heels (on his toes); add:
// degrees on top of the clip. The brute stands tall and square, chest out, chin up, shoulders rolled, fists low and
// loose; the 兄貴分 is a boxer at mid height peeking over his lead glove; the 半グレ is narrow, up on his toes,
// leaning off to one side with his hands up by his face.
const STANCE = {
  brute: { lift: 0.085, feet: [0.95, 0.72], toe: [0, 0], add: { Hips: [-2, 10, 0], Spine: [-4, -3, 0], Spine1: [-5, -3, 0], Spine2: [-3, -2, 0], Neck: [2, -2, 0], Head: [-8, -2, 0],
    LeftShoulder: [8, 0, -3], RightShoulder: [8, 0, -3], LeftArm: [-30, 6, 16], LeftForeArm: [-48, 0, 0], RightArm: [-32, -8, 22], RightForeArm: [-50, 0, 0] } },
  guard: { lift: 0.08, feet: [0.8, 0.72], toe: [0, 0], add: { Spine: [4, 0, 0], Spine1: [2, -2, 0], Neck: [2, -4, 0], Head: [6, -6, 0] } },
  coward: { lift: 0.085, feet: [0.62, 0.55], toe: [-12, 0.03], add: { Hips: [0, 4, -4], Spine: [2, 0, 6], Spine1: [2, 2, 4], Spine2: [0, 0, 2], Neck: [4, 0, -6], Head: [4, 4, -5],
    LeftShoulder: [4, 0, 6], RightShoulder: [4, 0, 8], LeftArm: [4, 6, -4], RightArm: [0, -4, 6], LeftForeArm: [8, 0, 0], RightForeArm: [6, 0, 0] } },
};
function stanceOf(pk, p) {
  const S = STANCE[pk];
  if (!S || !p) return p;
  const o = { ...p };
  if (p.hips) o.hips = [p.hips[0], p.hips[1] + S.lift, p.hips[2]];
  for (const k of ['ikL', 'ikR']) {
    const a = p[k]; if (!a) continue;
    o[k] = [a[0] * S.feet[0], a[1] + S.toe[1], a[2] * S.feet[1], a[3] + S.toe[0], a[4]];
  }
  for (const k in S.add) { const a = p[k] || [0, 0, 0], d = S.add[k]; o[k] = [a[0] + d[0], a[1] + d[1], a[2] + d[2]]; }
  return o;
}
const DEAD_HOLD = 8, FADE_T = 1.2;
const REACT = new Set(['hit', 'down', 'getup']);
const FLOOR_STATES = new Set(['down', 'dead', 'getup']), FLOOR_CLIPS_E = new Set(['knockdown', 'dead', 'getup']);
const REEL = new Set(['hit', 'getup']);                   // states whose clips throw the arms out (see clampPose)

const _d = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _o = new THREE.Vector3();
const _m4 = new THREE.Matrix4(), _sph = new THREE.Sphere();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// one sampled pose of a library clip as an authoring pose (the same reading combat.js does for its reaction clips)
function poseAt(A, clipName, phase) {
  const frames = A.getFrames(clipName);
  if (!frames || !frames.length) return null;
  const t = clamp(phase, 0, 1) * frames[frames.length - 1].t;
  let i = 0; while (i < frames.length - 1 && frames[i + 1].t <= t) i++;
  const f = frames[i].f, CH = A.CH, pose = {};
  for (const k of Object.keys(CH)) {
    if (k === 'hips') { pose.hips = [f[CH.hips], f[CH.hips + 1], f[CH.hips + 2]]; continue; }
    if (k === 'ikL' || k === 'ikR') continue;
    pose[k] = [f[CH[k]], f[CH[k] + 1], f[CH[k] + 2]];
  }
  for (const [ik, side] of [['ikL', 'Left'], ['ikR', 'Right']]) {
    const c = CH[ik];
    if (f[c + 5] > 0.5) {
      pose[ik] = [f[c], f[c + 1], f[c + 2], f[c + 3], f[c + 4]];
      delete pose[side + 'UpLeg']; delete pose[side + 'Leg']; delete pose[side + 'Foot'];
    }
  }
  return pose;
}

function playLoop(h, clip, fade) {
  const action = h.mixer.clipAction(clip);
  action.enabled = true;
  action.setLoop(THREE.LoopRepeat, Infinity);
  if (h.currentAction && h.currentAction !== action) h.currentAction.fadeOut(fade);
  action.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
  h.currentAction = action; h.currentName = clip.name; h.frozenPose = false;
  return action;
}

// ¥ coins: one instanced gold disc with the yen mark on both faces
function yenTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 58, 6, 64, 64, 64);
  rg.addColorStop(0, '#fff2b8'); rg.addColorStop(0.55, '#e8b440'); rg.addColorStop(0.9, '#a86f14'); rg.addColorStop(1, '#6e4608');
  g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(90,55,5,0.9)'; g.lineWidth = 6; g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#6a3f06'; g.font = 'bold 76px "Hiragino Sans", "Noto Sans JP", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('¥', 64, 68);
  g.fillStyle = '#ffe9a0'; g.fillText('¥', 62, 65);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------------------------------------ body preparation
// The client's street scans carry what their subjects were holding (a pipe; a cane and a book; a crowbar and a bag),
// fused into the mesh and auto-skinned to whatever bone was nearest — often a thigh or the hip. In a fight those
// pieces swing with the legs as floating sticks, sheets and tangles. Every weld-connected island other than the
// body itself is measured against the body's own bind skeleton: a piece lying off the bone it is skinned to (a
// prop, not a sleeve or a finger) is culled. Cached per scan and LOD level, so a spawn pays it once.
const BI = {}; BONE_NAMES.forEach((n, i) => { BI[n] = i; });
const CHILD_OF = { Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head', LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm',
  LeftForeArm: 'LeftHand', RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand', LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot',
  LeftFoot: 'LeftToeBase', RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'RightToeBase' };
const LEAF = { Head: ['Neck', 0.2], LeftHand: ['LeftForeArm', 0.09], RightHand: ['RightForeArm', 0.09], LeftToeBase: ['LeftFoot', 0.07], RightToeBase: ['RightFoot', 0.07] };
const boneSet = (names) => new Set(names.map((n) => BI[n]));
const B_HAND = boneSet(['LeftHand', 'RightHand', 'LeftForeArm', 'RightForeArm']);
const B_HEAD = boneSet(['Neck', 'Head']);
const B_UPPER = boneSet(['Spine', 'Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm']);
const B_LOWER = boneSet(['Hips', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg']);
const _bodyCache = new Map();
// &cull=bones: torso warm (hips red, spine orange / yellow / cream), head white, left arm blues, right arm greens, legs grey
const BONE_DBG = { Hips: 0xd01010, Spine: 0xe07010, Spine1: 0xe0c020, Spine2: 0xf0e0a0, Neck: 0xffffff, Head: 0xffffff,
  LeftShoulder: 0x40e0e0, LeftArm: 0x2060ff, LeftForeArm: 0x1010a0, LeftHand: 0xa040ff, RightShoulder: 0x80ff80, RightArm: 0x10c010, RightForeArm: 0x086008, RightHand: 0xff40c0,
  LeftUpLeg: 0x606060, LeftLeg: 0x404040, LeftFoot: 0x202020, LeftToeBase: 0x202020, RightUpLeg: 0x909090, RightLeg: 0x707070, RightFoot: 0x303030, RightToeBase: 0x303030 };
const NO_REWEIGHT = typeof location !== 'undefined' && /[?&]noreweight=1/.test(location.search);   // debug: the scan's own weights
const DBG_BODY = typeof location !== 'undefined' && /[?&]edbg=body/.test(location.search);
const NO_ECAST = typeof location !== 'undefined' && /[?&]ecast=0/.test(location.search);
const NO_ARMFIX = typeof location !== 'undefined' && /[?&]noarmfix=1/.test(location.search);

function bindSegments(skeleton) {
  const m = new THREE.Matrix4();
  const J = skeleton.boneInverses.map((bi) => new THREE.Vector3().setFromMatrixPosition(m.copy(bi).invert()));
  return BONE_NAMES.map((n, i) => {
    if (CHILD_OF[n]) return [J[i], J[BI[CHILD_OF[n]]]];
    const [p, ext] = LEAF[n], a = J[i], d = a.clone().sub(J[BI[p]]).normalize();
    return [a, a.clone().addScaledVector(d, ext)];
  });
}
function segDist(x, y, z, s) {
  const a = s[0], b = s[1], abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, apx = x - a.x, apy = y - a.y, apz = z - a.z;
  const l = abx * abx + aby * aby + abz * abz;
  const t = l > 0 ? clamp((apx * abx + apy * aby + apz * abz) / l, 0, 1) : 0;
  return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t);
}
/** the surface normal against the direction out of a bone segment's axis at that point (1: it faces straight out) */
function radialDot(x, y, z, s, nx, ny, nz) {
  const a = s[0], b = s[1], abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, apx = x - a.x, apy = y - a.y, apz = z - a.z;
  const l = abx * abx + aby * aby + abz * abz, t = l > 0 ? clamp((apx * abx + apy * aby + apz * abz) / l, 0, 1) : 0;
  const rx = apx - abx * t, ry = apy - aby * t, rz = apz - abz * t, rl = Math.hypot(rx, ry, rz) || 1;
  return (nx * rx + ny * ry + nz * rz) / rl;
}
/** which triangles of a scan geometry to keep, and its skinning mended: { keep, culled, islands, list, moved, skin } */
function planBody(geo, segs) {
  const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, idx = geo.index.array;
  const n = pos.count, nt = idx.length / 3, headRigid = geo.userData.headRigid || null;
  const dom = new Uint8Array(n), dist = new Float32Array(n), weld = new Int32Array(n), first = new Map();
  for (let v = 0; v < n; v++) {
    let bw = -1, bi = 0;
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > bw) { bw = w; bi = si.getComponent(v, k); } }
    dom[v] = bi;
    dist[v] = segDist(pos.getX(v), pos.getY(v), pos.getZ(v), segs[bi]);
    const key = Math.round(pos.getX(v) * 2000) + ',' + Math.round(pos.getY(v) * 2000) + ',' + Math.round(pos.getZ(v) * 2000);
    const f = first.get(key);
    if (f === undefined) { first.set(key, v); weld[v] = v; } else weld[v] = f;
  }
  // ---- the body's own measurements in bind space: spine axis, torso half-depths, sleeve and trouser radii
  const J = (b) => segs[BI[b]][0];
  const SPINE = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck'].map(J);
  const ax = { x: 0, z: 0 };
  const axisAt = (y) => {
    let i = 0; while (i < SPINE.length - 2 && y > SPINE[i + 1].y) i++;
    const a = SPINE[i], b = SPINE[i + 1], t = clamp((y - a.y) / ((b.y - a.y) || 1), 0, 1);
    ax.x = a.x + (b.x - a.x) * t; ax.z = a.z + (b.z - a.z) * t; return ax;
  };
  const pct = (arr, q, d) => { if (arr.length < 12) return d; arr.sort((a, b) => a - b); return arr[Math.floor(arr.length * q)]; };
  const TORSO = boneSet(['Spine', 'Spine1', 'Spine2']);
  const front = [], back = [];
  for (let v = 0; v < n; v += 2) {
    if (!TORSO.has(dom[v])) continue;
    const y = pos.getY(v); axisAt(y);
    const dx = pos.getX(v) - ax.x, dz = pos.getZ(v) - ax.z;
    if (Math.abs(dx) < 0.05) (dz >= 0 ? front : back).push(Math.abs(dz));
  }
  const Rf = clamp(pct(front, 0.85, 0.13), 0.05, 0.22), Rb = clamp(pct(back, 0.85, 0.12), 0.06, 0.26);
  const Rx = clamp(0.5 * (Math.abs(J('LeftArm').x - axisAt(J('LeftArm').y).x) + Math.abs(J('RightArm').x - axisAt(J('RightArm').y).x)), 0.13, 0.22);
  // a limb's cloth radius: the median distance of its own outward-facing surface over the middle of the bone
  const tubeR = (b, d, outward) => {
    const s = segs[b], a = s[0], e = s[1], ex = e.x - a.x, ey = e.y - a.y, ez = e.z - a.z, l2 = ex * ex + ey * ey + ez * ez || 1, r = [];
    for (let v = 0; v < n; v++) {
      if (dom[v] !== b) continue;
      const px = pos.getX(v) - a.x, py = pos.getY(v) - a.y, pz = pos.getZ(v) - a.z, t = (px * ex + py * ey + pz * ez) / l2;
      if (t < 0.3 || t > 0.7) continue;
      const rx = px - ex * t, rz = pz - ez * t;
      if (outward && rx * outward < 0.5 * Math.hypot(rx, rz)) continue;
      r.push(dist[v]);
    }
    return pct(r, 0.5, d);
  };
  const R = new Float32Array(BONE_NAMES.length).fill(0.06);
  for (const [sd, sg] of [['Left', 1], ['Right', -1]]) {
    R[BI[sd + 'Arm']] = clamp(tubeR(BI[sd + 'Arm'], 0.065, sg), 0.045, 0.1);
    R[BI[sd + 'ForeArm']] = clamp(tubeR(BI[sd + 'ForeArm'], 0.055, sg), 0.04, 0.09);
    R[BI[sd + 'Hand']] = 0.05;
    R[BI[sd + 'UpLeg']] = clamp(tubeR(BI[sd + 'UpLeg'], 0.085, 0), 0.06, 0.17);
    R[BI[sd + 'Leg']] = clamp(tubeR(BI[sd + 'Leg'], 0.065, 0), 0.045, 0.1);
  }
  const torsoD = (x, y, z) => { axisAt(y); const dx = x - ax.x, dz = z - ax.z; return Math.hypot(dx / Rx, dz / (dz >= 0 ? Rf : Rb)); };
  // a hand's own reach: wrist to fingertips (17 cm down the forearm's line)
  const HANDX = {};
  for (const hb of [BI.LeftHand, BI.RightHand]) {
    const sg = segs[hb], w = sg[0], dx = sg[1].x - w.x, dy = sg[1].y - w.y, dz = sg[1].z - w.z, l = Math.hypot(dx, dy, dz) || 1;
    HANDX[hb] = [w, { x: w.x + dx / l * 0.17, y: w.y + dy / l * 0.17, z: w.z + dz / l * 0.17 }];
  }
  // ---- weld-connected islands
  const par = new Int32Array(n); for (let v = 0; v < n; v++) par[v] = v;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < nt; t++) {
    const a = find(weld[idx[t * 3]]), b = find(weld[idx[t * 3 + 1]]), c = find(weld[idx[t * 3 + 2]]);
    if (a !== c) par[a] = c;
    if (find(b) !== c) par[find(b)] = c;
  }
  const isl = new Map(), triRoot = new Int32Array(nt);
  for (let t = 0; t < nt; t++) {
    const r = find(weld[idx[t * 3]]); triRoot[t] = r;
    let I = isl.get(r);
    if (!I) isl.set(r, I = { tris: 0, cx: 0, cy: 0, cz: 0, md: 0, far: 0, hf: 0, lo: [9, 9, 9], hi: [-9, -9, -9], votes: new Float32Array(BONE_NAMES.length) });
    I.tris++;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k], x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      I.cx += x; I.cy += y; I.cz += z; I.md += dist[v]; if (dist[v] > 0.2) I.far++;
      if (HANDX[dom[v]] && segDist(x, y, z, HANDX[dom[v]]) > 0.07) I.hf++;
      if (x < I.lo[0]) I.lo[0] = x; if (y < I.lo[1]) I.lo[1] = y; if (z < I.lo[2]) I.lo[2] = z;
      if (x > I.hi[0]) I.hi[0] = x; if (y > I.hi[1]) I.hi[1] = y; if (z > I.hi[2]) I.hi[2] = z;
      I.votes[dom[v]]++;
    }
  }
  let main = null;
  for (const I of isl.values()) if (!main || I.tris > main.tris) main = I;
  let culled = 0;
  const LEGB = boneSet(['LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg']);
  // a hand the scan modelled into the body itself: then every small piece skinned to that hand is something it held
  const handInMain = (b) => main.votes[b] / 3 > 200;
  for (const I of isl.values()) {
    const m = I.tris * 3;
    I.cx /= m; I.cy /= m; I.cz /= m; I.md /= m; I.far /= m; I.hf /= m;
    let b = 0; for (let k = 1; k < I.votes.length; k++) if (I.votes[k] > I.votes[b]) b = k;
    I.bone = b;
    I.cd = segDist(I.cx, I.cy, I.cz, segs[b]);
    I.cull = false;
    if (I === main) continue;
    const thin = Math.min(I.hi[0] - I.lo[0], I.hi[1] - I.lo[1], I.hi[2] - I.lo[2]);
    if (B_HEAD.has(b)) I.cull = I.cd > 0.14;                        // eyes, teeth, hair tufts stay
    // fingers stay; a grip, a rag, a strap, a book held flat against the palm (a quarter of it past a hand's reach) do not
    else if (B_HAND.has(b)) I.cull = I.md > 0.1 || I.cd > 0.075 || (I.tris < 150 && I.cd > 0.06) || I.hf > 0.16
      || ((b === BI.LeftHand || b === BI.RightHand) && handInMain(b) && I.tris < 400 && (I.cd > 0.05 || I.hf > 0.2));
    else I.cull = I.md > 0.12 || I.far > 0.3 || (I.tris < 150 && I.cd > R[b] + 0.06);
    // a torn denim thread: a narrow ribbon hanging off the trouser surface
    if (!I.cull && LEGB.has(b) && I.tris < 60 && thin < 0.025 && I.cd - R[b] > 0.03) I.cull = true;
    if (I.cull) culled += I.tris;
  }
  // Per vertex, whichever island: what a hand held — skinned to the hand but more than 4 cm outside the hand's own
  // capsule and not on the sleeve above it; a forearm-skinned point well off its sleeve and off the torso; a point
  // skinned to the hip / a thigh 30 cm out to the side below the belt.
  const hipY = segs[BI.Hips][0].y + 0.05, spX = segs[BI.Spine][0].x, spZ = segs[BI.Spine][0].z;
  const prop = (v, inMain) => {
    const b = dom[v], x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    if (b === BI.LeftHand || b === BI.RightHand) {
      const fa = b === BI.LeftHand ? BI.LeftForeArm : BI.RightForeArm;
      if (segDist(x, y, z, segs[fa]) <= R[fa] + 0.035) return false;
      // a hand modelled into the body keeps only what lies within 6.5 cm of its own reach (a rag or strap it
      // gripped hangs further out); a hand of its own island is judged by the looser capsule
      return inMain ? segDist(x, y, z, HANDX[b]) > 0.065 : dist[v] > R[b] + 0.04;
    }
    if (b === BI.LeftForeArm || b === BI.RightForeArm) {
      if (!inMain) {                                               // in a hand's own island: up the arm side of the wrist
        const s = segs[b === BI.LeftForeArm ? BI.LeftHand : BI.RightHand], w = s[0];
        const dx = s[1].x - w.x, dy = s[1].y - w.y, dz = s[1].z - w.z, l = Math.hypot(dx, dy, dz) || 1;
        if (((x - w.x) * dx + (y - w.y) * dy + (z - w.z) * dz) / l < -0.06) return true;
      }
      return dist[v] > R[b] + 0.05 && torsoD(x, y, z) > 1.3;
    }
    // a strap skinned to the upper arm but hanging off it (the arm's own cloth is within its tube or on the torso)
    if (b === BI.LeftArm || b === BI.RightArm) return dist[v] > R[b] + 0.06 && torsoD(x, y, z) > 1.3;
    // a strap or book edge skinned to the pelvis or a thigh, standing off the hip below the belt
    if (b === BI.Hips || b === BI.LeftUpLeg || b === BI.RightUpLeg) return y < hipY && (Math.hypot(x - spX, z - spZ) > 0.3 || (Math.abs(x - spX) > 0.21 && torsoD(x, y, z) > 1.25 && dist[v] > R[b === BI.Hips ? BI.LeftUpLeg : b] + 0.03));
    return false;
  };
  const keep = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    const I = isl.get(triRoot[t]), inMain = I === main;
    keep[t] = I.cull || (prop(idx[t * 3], inMain) && prop(idx[t * 3 + 1], inMain) && prop(idx[t * 3 + 2], inMain)) ? 0 : 1;
    if (!keep[t] && !I.cull) culled++;
  }
  // ---- skinning. The auto-skin gave the body's cloth to whatever hung beside it in the scan's A-pose: a jacket's
  // hem to the thigh, a bomber's chest to the pelvis, a collar's front edge to the neck, and the flanks and back
  // panels of every jacket to the arm that hung against them. A guard, a swing or a reel then drags that cloth out as
  // a sheet. Each point skinned to an arm is sorted by which surface it lies on: the torso's (an ellipse round the
  // spine, measured per scan) or the sleeve's (a tube round the bone, radius measured per scan). Torso cloth goes to
  // the spine bone at its height, with a soft band where the two meet so the armpit stretches instead of tearing.
  let moved = 0;
  const skinI = new Uint16Array(n * 4), skinW = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) for (let k = 0; k < 4; k++) { skinI[v * 4 + k] = si.getComponent(v, k); skinW[v * 4 + k] = sw.getComponent(v, k); }
  const wm = new Map();
  const readW = (v) => { wm.clear(); for (let k = 0; k < 4; k++) { const w = skinW[v * 4 + k]; if (w > 0) wm.set(skinI[v * 4 + k], (wm.get(skinI[v * 4 + k]) || 0) + w); } };
  const writeW = (v) => {
    const e = [...wm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let s = 0; for (const x of e) s += x[1]; s = s || 1;
    for (let k = 0; k < 4; k++) { skinI[v * 4 + k] = e[k] ? e[k][0] : 0; skinW[v * 4 + k] = e[k] ? e[k][1] / s : 0; }
    moved++;
  };
  const moveW = (from, to, f) => { const w = (wm.get(from) || 0) * f; if (w <= 0) return; wm.set(from, wm.get(from) - w); wm.set(to, (wm.get(to) || 0) + w); };
  // spine bone(s) at a height: linear between the bones' mid-heights
  const TB = [BI.Hips, BI.Spine, BI.Spine1, BI.Spine2], TC = TB.map((b, i) => (SPINE[i].y + SPINE[i + 1].y) / 2);
  const toTorso = (from, y, f) => {
    const w0 = wm.get(from) || 0, w = w0 * f; if (w <= 0) return;
    wm.set(from, w0 - w);
    let i = 0; while (i < TC.length - 1 && y > TC[i + 1]) i++;
    const u = i === TC.length - 1 ? 0 : clamp((y - TC[i]) / (TC[i + 1] - TC[i]), 0, 1);
    wm.set(TB[i], (wm.get(TB[i]) || 0) + w * (1 - u));
    if (u > 0) wm.set(TB[i + 1], (wm.get(TB[i + 1]) || 0) + w * u);
  };
  const ARMS = [[BI.LeftArm, BI.LeftForeArm, BI.LeftHand], [BI.RightArm, BI.RightForeArm, BI.RightHand]];
  const nrm = geo.attributes.normal || null;
  const upLeg = [BI.LeftUpLeg, BI.RightUpLeg];
  const ySp0 = SPINE[1].y, ySp1 = SPINE[2].y, yNeck = SPINE[4].y, yHead = segs[BI.Head][0].y, yArm = Math.min(J('LeftArm').y, J('RightArm').y);
  const yCrotch = Math.min(J('LeftUpLeg').y, J('RightUpLeg').y) - 0.12;
  let flank = 0;
  for (let v = 0; v < n; v++) {
    const b = dom[v], x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    readW(v);
    let touched = false;
    if (upLeg.includes(b) && y > segs[b][0].y - 0.3 && dist[v] > R[b] + 0.03) {   // a jacket hem off the thigh, not the trouser
      moveW(b, BI.Hips, smooth(R[b] + 0.03, R[b] + 0.08, dist[v]) * smooth(segs[b][0].y - 0.3, segs[b][0].y - 0.18, y)); touched = true;
    } else if (b === BI.Neck && y < yNeck - 0.05) { moveW(b, BI.Spine2, smooth(0.05, 0.12, yNeck - y)); touched = true; }
    // (not the chin and jaw humanoid.js's rigidHead() put on the Head: a face half on the neck shears when he turns it)
    else if (b === BI.Head && y < yHead - 0.04 && !(headRigid && headRigid[v])) { moveW(b, y < yNeck ? BI.Spine2 : BI.Neck, smooth(yHead - 0.04, yHead - 0.1, y)); touched = true; }
    else if (b === BI.Hips && y > ySp0 - 0.02) { moveW(b, y < ySp1 ? BI.Spine : BI.Spine1, smooth(ySp0 - 0.02, ySp0 + 0.1, y)); touched = true; }
    if (!NO_ARMFIX && y < yArm + 0.02) {
      const dT = torsoD(x, y, z), tx = x - ax.x, tz = z - ax.z;
      const nx = nrm ? nrm.getX(v) : 0, ny = nrm ? nrm.getY(v) : 0, nz = nrm ? nrm.getZ(v) : 0;
      let dL = 9, leg = -1, nL = 0;
      if (y < yCrotch) for (const u of upLeg) { const d = segDist(x, y, z, segs[u]); if (d < dL) { dL = d; leg = u; nL = radialDot(x, y, z, segs[u], nx, ny, nz); } }
      for (const chain of ARMS) {
        let wA = 0; for (const c of chain) wA += wm.get(c) || 0;
        if (wA < 0.02) continue;
        let dA = 9, near = chain[0]; for (const c of chain) { const d = segDist(x, y, z, segs[c]) / R[c]; if (d < dA) { dA = d; near = c; } }
        const nA = nrm ? radialDot(x, y, z, segs[near], nx, ny, nz) : 0;
        // nothing past the torso's own surface is torso cloth (the shoulder cap above yArm is never touched)
        let f = smooth(-0.05, 0.3, dA - dT);
        if (nrm) {
          // where the sleeve lay against the flank the two are the same distance off: the surface's facing decides it.
          // The flank faces out of the torso and into the sleeve; the sleeve's inside faces out of the arm and into
          // the torso (its outside faces out of both, and the distances already give that one to the arm)
          const nT = (nx * tx + nz * tz) / (Math.hypot(tx, tz) || 1);
          const vote = smooth(0.1, 0.5, nT) * (1 - smooth(-0.1, 0.35, nA)) * (1 - smooth(1.2, 1.5, dT));
          const veto = smooth(0.2, 0.55, nA) * (1 - smooth(0, 0.4, nT)) * (1 - smooth(1.2, 1.5, dA));
          f = clamp(f + vote - veto, 0, 1);
        }
        f *= 1 - smooth(1.3, 1.6, dT);
        // the shoulder blades and the chest between the arms are the torso's whatever the auto-skin said: a raised
        // guard lifted them off the back as one panel
        if (dT < 1.25 && y < yArm - 0.03) {
          const ax2 = Math.abs(tx) / Rx, panel = tz < 0 ? smooth(0.25, 0.45, -tz / Rb) * (1 - smooth(0.85, 1.0, ax2)) : smooth(0.3, 0.5, tz / Rf) * (1 - smooth(0.7, 0.9, ax2));
          f = Math.max(f, panel);
        }
        if (f >= 0.01) { for (const c of chain) toTorso(c, y, f); touched = true; flank++; continue; }
        // the denim a hanging hand rested on: below the crotch, on the thigh, facing out of it and into the hand
        if (leg >= 0 && dL < Math.min(R[leg], 0.1) + 0.05) {
          const g = nrm ? smooth(0.4, 0.7, nL) * (1 - smooth(-0.15, 0.15, nA)) : smooth(1.5, 1.9, dA);
          if (g > 0.25) { for (const c of chain) moveW(c, leg, 1); touched = true; flank++; }     // all or nothing: see the bridge cut below
        }
      }
    }
    if (touched) writeW(v);
  }
  // The torso's own share goes down the spine as a gradient. The auto-skin cut the back into a pelvis half and a
  // shoulder half along a jagged line with almost no Spine / Spine1 between them, and every lean opened that line
  // as a tear. Each point's torso weight is re-split across the spine chain by its height alone.
  const yT0 = SPINE[0].y - 0.06, yT1 = SPINE[4].y, SHOULDERS = [BI.LeftShoulder, BI.RightShoulder];
  for (let v = 0; v < n; v++) {
    const y = pos.getY(v);
    if (y < yT0 || y > yT1) continue;
    readW(v);
    let tw = 0; for (const b of TB) tw += wm.get(b) || 0;
    // (and the clavicles' share of the back and chest below the shoulder line: a raised guard lifted it as a panel)
    const fs = 1 - smooth(yArm - 0.12, yArm - 0.02, y);
    let sw = 0; for (const b of SHOULDERS) { const w = (wm.get(b) || 0) * fs; if (w > 0) { sw += w; wm.set(b, wm.get(b) - w); } }
    tw += sw;
    if (tw < 0.02) { if (sw > 0) writeW(v); continue; }
    for (const b of TB) wm.delete(b);
    wm.set(BI.Hips, tw);
    toTorso(BI.Hips, Math.max(y, TC[0] - 0.08 + smooth(yT0, TC[0], y) * 0.08), 1);
    writeW(v);
  }
  // The seam between sleeve and body is where a raised arm stretches the cloth: a one-ring seam tears open (the dark
  // zigzags across a back), a seam four rings wide stretches like cloth. Each side's arm share is diffused over the
  // welded mesh in the upper body, and the weights are re-split to match.
  if (!NO_ARMFIX) {
    const nb = new Int32Array(n + 1), wv = (v) => weld[v];
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) nb[wv(idx[t * 3 + k]) + 1] += 2;
    for (let v = 0; v < n; v++) nb[v + 1] += nb[v];
    const adj = new Int32Array(nb[n]), fill = nb.slice(0, n);
    for (let t = 0; t < nt; t++) {
      const a = wv(idx[t * 3]), b = wv(idx[t * 3 + 1]), c = wv(idx[t * 3 + 2]);
      adj[fill[a]++] = b; adj[fill[a]++] = c; adj[fill[b]++] = a; adj[fill[b]++] = c; adj[fill[c]++] = a; adj[fill[c]++] = b;
    }
    const yLo = yCrotch + 0.25, share = new Float32Array(n), next = new Float32Array(n);
    for (const chain of ARMS) {
      const cs = new Set(chain);
      for (let v = 0; v < n; v++) { let a = 0; for (let k = 0; k < 4; k++) if (cs.has(skinI[v * 4 + k])) a += skinW[v * 4 + k]; share[v] = a; }
      for (let it = 0; it < 4; it++) {
        for (let v = 0; v < n; v++) {
          const r = wv(v);
          if (r !== v) continue;
          const i0 = nb[v], i1 = nb[v + 1];
          if (i1 <= i0 || pos.getY(v) < yLo || pos.getY(v) > yArm) { next[v] = share[v]; continue; }
          let m = 0; for (let i = i0; i < i1; i++) m += share[adj[i]];
          next[v] = 0.5 * share[v] + 0.5 * m / (i1 - i0);
        }
        for (let v = 0; v < n; v++) share[v] = weld[v] === v ? next[v] : share[weld[v]];
      }
      for (let v = 0; v < n; v++) {
        const y = pos.getY(v);
        if (y < yLo || y > yArm) continue;
        readW(v);
        let a0 = 0; for (const c of chain) a0 += wm.get(c) || 0;
        const a1 = share[v];
        if (Math.abs(a1 - a0) < 0.02) continue;
        if (a1 < a0) { for (const c of chain) toTorso(c, y, 1 - a1 / a0); }
        else {                                                        // the body cloth next to the sleeve follows it a little
          const take = a1 - a0, arm = y > (segs[chain[1]][0].y + segs[chain[0]][0].y) / 2 - 0.1 ? chain[0] : chain[1];
          let tw = 0; for (const b of TB) tw += wm.get(b) || 0;
          if (tw < 1e-4) continue;
          const f = Math.min(1, take / tw);
          for (const b of TB) { const w = (wm.get(b) || 0) * f; if (w > 0) { wm.set(b, wm.get(b) - w); wm.set(arm, (wm.get(arm) || 0) + w); } }
        }
        writeW(v);
      }
    }
  }
  // A hanging arm and what it touched (the denim, the belt, the jacket's waist, the cane or pipe held against the hip) share triangles
  // where the scan fused them: however the contact is skinned, they become a web from the fist to the hip as soon as
  // the arm moves. They lie inside the contact, so they are cut.
  const ARMSET = boneSet(['LeftForeArm', 'LeftHand', 'RightForeArm', 'RightHand']), LEGSET = boneSet(['Hips', 'Spine', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg']);
  const grp = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    let a = 0, l = 0;
    for (let k = 0; k < 4; k++) { const b = skinI[v * 4 + k], w = skinW[v * 4 + k]; if (ARMSET.has(b)) a += w; else if (LEGSET.has(b)) l += w; }
    grp[v] = (a > 0.3 ? 1 : 0) | (l > 0.3 ? 2 : 0);
  }
  let bridged = 0;
  for (let t = 0; t < nt; t++) {
    if (!keep[t]) continue;
    const g0 = grp[idx[t * 3]], g1 = grp[idx[t * 3 + 1]], g2 = grp[idx[t * 3 + 2]];
    if ((g0 | g1 | g2) === 3) { keep[t] = 0; culled++; bridged++; }
  }
  const list = [...isl.values()].sort((a, b) => b.tris - a.tris).map((I) => `${I.cull ? 'CULL' : 'keep'} ${I.tris}t ${BONE_NAMES[I.bone]} md${I.md.toFixed(3)} cd${I.cd.toFixed(3)} far${I.far.toFixed(2)} hf${I.hf.toFixed(2)} @${I.cx.toFixed(2)},${I.cy.toFixed(2)},${I.cz.toFixed(2)}`);
  list.unshift(`dims Rx${Rx.toFixed(3)} Rf${Rf.toFixed(3)} Rb${Rb.toFixed(3)} arm${R[BI.LeftArm].toFixed(3)}/${R[BI.RightArm].toFixed(3)} fore${R[BI.LeftForeArm].toFixed(3)}/${R[BI.RightForeArm].toFixed(3)} thigh${R[BI.LeftUpLeg].toFixed(3)} flank ${flank} moved ${moved} bridged ${bridged}`);
  return { keep, culled, islands: isl.size, list, moved, skin: moved ? { skinI, skinW } : null };
}
// The scans' spine joints are the template's (the same x / z in every scan's rig; only the heights were fitted), so on
// the vagrant and the hoodie the whole column sits ~10 cm in front of the torso it bends: every lean, flinch and
// reel pivoted about the chest's front and folded the jacket into a sack. The chain is measured against its own
// cloth (the torso strip round each joint's height, the neck ring, the skull) and moved back to just behind the
// torso's centre, per scan, before anything is skinned or measured off it.
const _spineFix = new Map();
const SPINE_FIX = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head'];
function spineShift(h, key) {
  if (_spineFix.has(key)) return _spineFix.get(key);
  const sk = h.skeleton, geo = h.skinned.geometry, pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const J = sk.boneInverses.map((bi) => new THREE.Vector3().setFromMatrixPosition(_m4.copy(bi).invert()));
  const zs = SPINE_FIX.map(() => []);
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    for (let i = 0; i < 4; i++) { const j = J[BI[SPINE_FIX[i]]]; if (Math.abs(y - j.y) < 0.04 && Math.abs(x - j.x) < 0.05) zs[i].push(z); }
    const hj = J[BI.Head]; if (y > hj.y + 0.04 && Math.abs(x - hj.x) < 0.06) zs[4].push(z);
  }
  const ctr = SPINE_FIX.map((n, i) => { const a = zs[i]; if (a.length < 30) return null; a.sort((p, q) => p - q); return (a[Math.floor(a.length * 0.06)] + a[Math.floor(a.length * 0.94)]) / 2 - J[BI[n]].z; });
  // the column moves as one (the median of its three joints), 2 cm behind the torso's centre; neck and skull follow
  // within 5 cm of the joint below them
  const col = ctr.slice(0, 3).filter((c) => c != null).sort((a, b) => a - b);
  const out = {};
  if (col.length) {
    const d = clamp(col[col.length >> 1] - 0.02, -0.15, 0.1);
    const dn = ctr[3] != null ? clamp(ctr[3] - 0.01, d - 0.05, d + 0.05) : d, dh = ctr[4] != null ? clamp(ctr[4], dn - 0.05, dn + 0.05) : dn;
    if (Math.abs(d) > 0.01 || Math.abs(dh) > 0.01) { out.Spine = d; out.Spine1 = d; out.Spine2 = d; out.Neck = dn; out.Head = dh; }
  }
  _spineFix.set(key, out);
  return out;
}
/** move the spine chain's bind joints (back) by z metres each, keeping every other joint where it is */
function applySpineShift(h, shift) {
  const sk = h.skeleton, bones = sk.bones;
  if (!Object.keys(shift).length) return;
  const T = new THREE.Matrix4(), L = new THREE.Matrix4();
  const Mn = sk.boneInverses.map((bi, i) => { const m = new THREE.Matrix4().copy(bi).invert(), s = shift[bones[i].name]; return s ? m.premultiply(T.makeTranslation(0, 0, s)) : m; });
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i], pi = bones.indexOf(b.parent);
    if (pi < 0 || (!shift[b.name] && !shift[b.parent.name])) continue;
    b.position.setFromMatrixPosition(L.copy(Mn[pi]).invert().multiply(Mn[i]));
    if (shift[b.name]) sk.boneInverses[i].copy(Mn[i]).invert();
  }
  h.group.updateMatrixWorld(true);
}
/** cull the prop islands of one scan mesh (cached per scan + level); `show` keeps them as a red second group */
function cleanBody(mesh, key, segs, show) {
  const geo = mesh.geometry;
  if (!geo || !geo.index || !geo.attributes.skinIndex) return 0;
  let plan = _bodyCache.get(key);
  if (!plan || plan.nt !== geo.index.count / 3) {
    plan = planBody(geo, segs); plan.nt = geo.index.count / 3;
    _bodyCache.set(key, plan);
    if (show) console.info(`[enemy] islands ${key}:\n` + plan.list.slice(0, 40).join('\n'));
    else if (DBG_BODY) console.info(`[enemy] body ${key}: ` + plan.list[0] + ` culled ${plan.culled} spine ${JSON.stringify(_spineFix.get(key.split(':')[0]) || {})}`);
  }
  if (plan.skin && !NO_REWEIGHT) {
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(plan.skin.skinI, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(plan.skin.skinW, 4));
  }
  if (!plan.culled) return 0;
  const idx = geo.index.array, nt = plan.nt, kept = nt - plan.culled;
  const out = new (idx.constructor)(show ? nt * 3 : kept * 3);
  let o = 0, c = kept * 3;
  for (let t = 0; t < nt; t++) {
    if (plan.keep[t]) { out[o++] = idx[t * 3]; out[o++] = idx[t * 3 + 1]; out[o++] = idx[t * 3 + 2]; }
    else if (show) { out[c++] = idx[t * 3]; out[c++] = idx[t * 3 + 1]; out[c++] = idx[t * 3 + 2]; }
  }
  geo.setIndex(new THREE.BufferAttribute(out, 1));
  if (show) {
    geo.clearGroups(); geo.addGroup(0, kept * 3, 0); geo.addGroup(kept * 3, plan.culled * 3, 1);
    const m0 = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    mesh.material = [m0, new THREE.MeshBasicMaterial({ color: 0xff2020 })];
  }
  return plan.culled;
}

// ------------------------------------------------------------------------------------------------ wardrobe
// The scans were shot as a vagrant, a day labourer and a salaryman: brown, grey and navy, and the salaryman's navy
// suit is 健人's own palette. Each persona re-dresses his scan inside its own shader, repainted luminance-preserving
// (the weave and the big folds survive, the grime does not: gamma is how much of the source's contrast is kept).
// Two kinds of swap:
//   garment: everything in its region (skin-weight masks: torso / legs) except skin, white cloth and an optional
//            exception key — so the source's dark folds and shadows cannot survive as navy holes in a cream suit
//   keyed:   only where the albedo matches a chroma / value / saturation key (a shirt, a vest), optionally only in
//            the chest-V mask (Spine2-skinned, facing forward, near the midline) so a shirt never bleeds onto the fly
// swap: { garment | key, tol, lum: [min, max] linear, sat: [min, max], to: sRGB hex, region: [upper, lower, chestV],
//         gamma, ref: the source's own mean luminance (garment), pattern: 1 = leopard rosettes, scale: per metre,
//         spareInV: skin / white cloth are only spared inside the chest V (else everywhere in the region) }
const WARDROBE = {
  // チンピラ (enforcer_b, the salaryman's suit): a white suit over a black shirt. The gold leopard print read as a
  // stained jacket in play (client: 「ぶつぶつすぎておかしい」), and a plain wine red read as bare skin under the
  // sodium and sign light; white is the one suit that reads at night. `pattern: 1` still works.
  // (優先3 / coordinator: the salaryman's navy suit is a glen check, and it came through the white as a dark grid that
  // read like a wireframe from the fight camera: its pale threads passed the "white cloth" spare and kept their grey,
  // its brown ones the "skin" spare, and gamma 0.3 kept the rest of its contrast. The spares now only apply in the
  // chest V (the neck, the shirt), and 0.12 keeps the folds' shading without the check.)
  brute: [
    { garment: true, to: 0xcfcac0, region: [1, 0, 0], gamma: 0.12, ref: 0.02, spareInV: true },
    { garment: true, to: 0xc4bfb5, region: [0, 1, 0], gamma: 0.12, ref: 0.02, spareInV: true },
    { key: 0x0d1e30, tol: 0.14, lum: [0.002, 0.09], sat: [0.45, 1], to: 0x141214, region: [0, 0, 1], gamma: 0.6 },
  ],
  // 兄貴分 (enforcer_a, the vagrant's bomber): an ivory satin スカジャン over the red flannel, his own jeans
  guard: [
    { garment: true, key: 0x5a1f1f, tol: 0.1, lum: [0.006, 0.2], sat: [0.42, 1], to: 0xd9d0bb, region: [1, 0, 0], gamma: 0.25, ref: 0.03, spareInV: true },
    { key: 0x5a1f1f, tol: 0.1, lum: [0.008, 0.09], sat: [0.48, 1], to: 0xc8141e, region: [1, 0, 0], gamma: 0.85 },
  ],
  // 半グレ (wanderer): a violet hoodie under a black vest
  coward: [
    { key: 0x131b22, tol: 0.11, lum: [0.002, 0.04], sat: [0.24, 1], to: 0x121216, region: [1, 0, 0], gamma: 0.8 },
    { key: 0x544a40, tol: 0.08, lum: [0.018, 0.16], sat: [0.04, 0.32], to: 0x6a2c9c, region: [1, 0, 0], gamma: 0.8, torso: true },
  ],
};
const WARD_N = 3;
const WARD_GLSL = /* glsl */`
#ifdef ENEMY_WARD
{ vec3 wa = diffuseColor.rgb;
  float wl = dot( wa, vec3( 0.2126, 0.7152, 0.0722 ) );
  float wmx = max( wa.r, max( wa.g, wa.b ) ), wmn = min( wa.r, min( wa.g, wa.b ) );
  float wsat = ( wmx - wmn ) / max( wmx, 1e-5 );
  vec3 wch = wa / max( wa.r + wa.g + wa.b, 1e-5 );
  // what a garment never takes: skin (the neck, a bare chest) and white cloth (a tee, a collar)
  float wskin = ( 1.0 - smoothstep( 0.035, 0.075, distance( wch, vec3( 0.45, 0.33, 0.22 ) ) ) ) * smoothstep( 0.2, 0.3, wsat ) * smoothstep( 0.035, 0.07, wl );
  float wwhite = smoothstep( 0.2, 0.32, wl ) * ( 1.0 - smoothstep( 0.12, 0.22, wsat ) );
  // the rosettes, once, outside the loop (screen-space derivatives want uniform control flow)
  vec2 wleo = uWLeo.x > 0.0 ? wardLeopard( vWardP * uWLeo.x ) : vec2( 0.0 );
  vec3 wo = wa;
  for ( int i = 0; i < ${WARD_N}; i ++ ) {
    vec4 K = uWKey[ i ], R = uWRng[ i ], D = uWTo[ i ], M = uWMask[ i ], Q = uWPat[ i ];
    float w = clamp( dot( vWard, M.xyz ), 0.0, 1.0 );
    if ( w < 0.001 ) continue;
    float m = K.w > 0.0 ? ( 1.0 - smoothstep( K.w * 0.55, K.w, distance( wch, K.xyz ) ) )
      * smoothstep( R.x * 0.6, R.x, wl ) * ( 1.0 - smoothstep( R.y, R.y * 1.5, wl ) )
      * smoothstep( R.z - 0.08, R.z, wsat ) * ( 1.0 - smoothstep( R.w, R.w + 0.08, wsat ) ) : 0.0;
    // Q.y: skin / white only spared inside the chest V (a pile collar's pale and tan flecks are not a tee or a neck)
    float wv = Q.y > 0.5 ? clamp( vWard.z, 0.0, 1.0 ) : 1.0;
    w *= M.w > 0.5 ? ( 1.0 - m ) * ( 1.0 - wskin * wv ) * ( 1.0 - wwhite * wv ) : m;
    if ( w < 0.001 ) continue;
    vec3 t = D.rgb * clamp( pow( max( wl, 1e-5 ) / D.w, Q.z ), 0.3, 2.4 );
    if ( Q.x > 0.5 ) t = mix( mix( t, t * 0.5, wleo.x ), vec3( 0.02, 0.016, 0.012 ), wleo.y );
    wo = mix( wo, t, w );
  }
  diffuseColor.rgb = wo;
#ifdef ENEMY_WARD_DBG
  { float w0 = clamp( dot( vWard, uWMask[ 0 ].xyz ), 0.0, 1.0 ); diffuseColor.rgb = vec3( w0, wskin, wwhite ); }
#endif
}
#endif`;
const WARD_HEAD = /* glsl */`
uniform vec4 uWKey[ ${WARD_N} ]; uniform vec4 uWRng[ ${WARD_N} ]; uniform vec4 uWTo[ ${WARD_N} ]; uniform vec4 uWMask[ ${WARD_N} ]; uniform vec4 uWPat[ ${WARD_N} ];
uniform vec2 uWLeo;
varying vec3 vWard; varying vec3 vWardP;
vec3 wardHash( vec3 p ) {
  p = vec3( dot( p, vec3( 127.1, 311.7, 74.7 ) ), dot( p, vec3( 269.5, 183.3, 246.1 ) ), dot( p, vec3( 113.5, 271.9, 124.6 ) ) );
  return fract( sin( p ) * 43758.5453 );
}
// leopard: jittered cells in the body's bind space (no uv seams). x: the darker centre, y: the broken dark ring,
// both edges widened by fwidth so the rings do not crawl at 5-8 m
vec2 wardLeopard( vec3 p ) {
  vec3 ip = floor( p ), fp = fract( p );
  float d1 = 9.0; vec3 id = vec3( 0.0 ), r1 = vec3( 0.0 );
  for ( int x = - 1; x <= 1; x ++ ) for ( int y = - 1; y <= 1; y ++ ) for ( int z = - 1; z <= 1; z ++ ) {
    vec3 g = vec3( float( x ), float( y ), float( z ) ), o = wardHash( ip + g );
    vec3 r = g + 0.15 + o * 0.7 - fp; float d = dot( r, r );
    if ( d < d1 ) { d1 = d; id = o; r1 = r; }
  }
  // a rosette is not a circle: its radius wanders with the angle, its ring breaks into three or four blotches, and
  // a third of the cells are plain solid spots
  float an = atan( r1.y, r1.x );
  float d = sqrt( d1 ) * ( 0.85 + 0.3 * id.x ) * ( 1.0 + 0.2 * sin( 3.0 * an + id.z * 6.28 ) + 0.1 * sin( 5.0 * an + id.x * 6.28 ) );
  float aa = clamp( fwidth( d ), 0.002, 0.08 ), fade = 1.0 - smoothstep( 0.25, 0.5, aa );
  if ( id.z < 0.33 ) return vec2( 0.0, ( 1.0 - smoothstep( 0.15 - aa, 0.21 + aa, d ) ) * fade );
  float ring = smoothstep( 0.19 - aa, 0.25 + aa, d ) * ( 1.0 - smoothstep( 0.33 - aa, 0.4 + aa, d ) );
  float gap = smoothstep( 0.2, 0.3, fract( an * ( 0.477 + 0.16 * id.y ) + id.y ) );
  return vec2( 1.0 - smoothstep( 0.17 - aa, 0.23 + aa, d ), ring * mix( 0.35, 1.0, gap ) * fade );
}
void main() {`;
const _wc = new THREE.Color();
function wardUniforms(swaps, scale = 1) {
  const U = { uWKey: { value: [] }, uWRng: { value: [] }, uWTo: { value: [] }, uWMask: { value: [] }, uWPat: { value: [] }, uWLeo: { value: new THREE.Vector2() } };
  for (let i = 0; i < WARD_N; i++) {
    const s = swaps[i];
    if (!s) { for (const k of Object.keys(U)) if (Array.isArray(U[k].value)) U[k].value.push(new THREE.Vector4(0, 0, 0, 0)); continue; }
    let keyLum = s.ref || 0.02;
    if (s.key != null) {
      _wc.setHex(s.key);
      const sum = _wc.r + _wc.g + _wc.b || 1;
      if (!s.garment) keyLum = 0.2126 * _wc.r + 0.7152 * _wc.g + 0.0722 * _wc.b;
      U.uWKey.value.push(new THREE.Vector4(_wc.r / sum, _wc.g / sum, _wc.b / sum, s.tol));
      U.uWRng.value.push(new THREE.Vector4(Math.max(0.001, s.lum[0]), s.lum[1], s.sat[0], s.sat[1]));
    } else { U.uWKey.value.push(new THREE.Vector4(0, 0, 0, 0)); U.uWRng.value.push(new THREE.Vector4(0.001, 1, 0, 1)); }   // no exception key
    _wc.setHex(s.to);
    U.uWTo.value.push(new THREE.Vector4(_wc.r, _wc.g, _wc.b, Math.max(1e-4, keyLum)));
    const r = s.region;
    U.uWMask.value.push(new THREE.Vector4(r[0] || 0, r[1] || 0, r[2] || 0, s.garment ? 1 : 0));
    U.uWPat.value.push(new THREE.Vector4(s.pattern || 0, s.spareInV ? 1 : 0, s.gamma != null ? s.gamma : 0.7, 0));
    // bind space is metres (the scans' joints stand 1.8 m tall); a scaled body keeps its rosettes per world metre
    if (s.pattern) U.uWLeo.value.set((s.scale || 12) * scale, 1);
  }
  return U;
}
/** his own copy of the scan material with the wardrobe pass (and the scan's own hooks, cascade included, kept) */
function wardrobeMaterial(m0, swaps, scale) {
  const c = m0.clone();
  c.defines = { ...(m0.defines || {}), ENEMY_WARD: '' };
  if (typeof location !== 'undefined' && /[?&]edbg=wardmask/.test(location.search)) c.defines.ENEMY_WARD_DBG = '';
  c.userData = m0.userData;
  const prev = m0.onBeforeCompile, prevKey = m0.customProgramCacheKey.bind(m0), U = wardUniforms(swaps, scale);
  c.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader.replace('void main() {', 'attribute vec3 aWard;\nvarying vec3 vWard;\nvarying vec3 vWardP;\nvoid main() {\n  vWard = aWard; vWardP = position;');
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', WARD_HEAD).replace('#include <map_fragment>', '#include <map_fragment>\n' + WARD_GLSL);
  };
  c.customProgramCacheKey = () => prevKey() + '|ward2';
  return c;
}
/** the masks the wardrobe pass reads, from the skin weights (so the boundary is as soft as the skinning): torso
 *  (the neck excluded), legs, and the chest V a shirt shows through (Spine2, facing forward, near the midline) */
function wardMask(geo, segs) {
  if (geo.attributes.aWard) return;
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, nr = geo.attributes.normal, pos = geo.attributes.position, n = si.count, a = new Float32Array(n * 3);
  const sx = segs ? segs[BI.Spine2][0].x : 0;
  for (let v = 0; v < n; v++) {
    let u = 0, l = 0, s2 = 0;
    for (let k = 0; k < 4; k++) {
      const b = si.getComponent(v, k), w = sw.getComponent(v, k);
      if (b === BI.Neck) continue;
      if (B_UPPER.has(b)) u += w; else if (B_LOWER.has(b)) l += w;
      if (b === BI.Spine2) s2 += w;
    }
    const nz = nr ? nr.getZ(v) : 0;
    a[v * 3] = u; a[v * 3 + 1] = l;
    a[v * 3 + 2] = smooth(0.4, 0.6, s2) * smooth(0.2, 0.4, nz) * (1 - smooth(0.07, 0.11, Math.abs(pos.getX(v) - sx)));
  }
  geo.setAttribute('aWard', new THREE.BufferAttribute(a, 3));
}

// ------------------------------------------------------------------------------------------------ wind-up chamber
// A 龍が如く tell cocks the arm back, sinks the weight onto the rear foot, drops the lead shoulder and tucks the chin.
// The library clips' chamber keys are 60–120 ms flinches of the idle guard, so the chamber is posed on top of them
// after the mixer (and after combat's flinch), by IK: the striking fist goes to a target in the chest's frame, the
// hips sit back while both feet stay planted, the spine coils away from the blow and the head counter-turns to keep
// its eyes on 健人. Character frame: out = toward the striking arm's side, up, fwd. Angles in radians.
// twist: + turns the chest to his left; lean: + back; roll: + lifts his left shoulder; hips: [left, up, fwd] m.
const CHAMBER_POSE = {
  hook:     { arm: 'Right', from: 'Head', hand: [0.19, -0.03, -0.11], pole: [1, 0.12, -0.7], twist: -0.55, lean: 0.1, roll: -0.12, hips: [-0.03, -0.045, -0.08], tuck: 0.16 },
  straight: { arm: 'Right', from: 'Head', hand: [0.14, -0.1, -0.17], pole: [0.55, -0.9, -0.55], twist: -0.52, lean: 0.08, roll: -0.07, hips: [-0.025, -0.035, -0.07], tuck: 0.13 },
  jab:      { arm: 'Left', from: 'Head', hand: [0.22, -0.05, 0.0], pole: [0.75, -0.9, -0.35], twist: 0.42, lean: 0.12, roll: 0.06, hips: [0.0, -0.05, -0.065], tuck: 0.13 },
  uppercut: { arm: 'Right', from: 'Hips', hand: [0.26, 0.2, 0.02], pole: [0.35, -0.45, -0.95], twist: -0.48, lean: -0.12, roll: 0.2, hips: [-0.04, -0.09, -0.02], tuck: 0.1 },
  kick:     { arm: null, twist: 0.1, lean: 0.17, roll: 0, hips: [0, 0, -0.04], tuck: 0.06 },
  roundhouse: { arm: null, twist: 0.25, lean: 0.12, roll: 0.05, hips: [0, -0.02, -0.03], tuck: 0.06 },
  brute_haymaker: { arm: 'Right', from: 'Head', hand: [0.2, 0.02, -0.15], pole: [1, 0.15, -0.65], twist: -0.6, lean: 0.14, roll: -0.14, hips: [-0.03, -0.05, -0.09], tuck: 0.12 },
  brute_tackle: { arm: null, twist: -0.3, lean: -0.2, roll: 0, hips: [0, -0.07, -0.05], tuck: -0.1 },
  coward_slaps: { arm: 'Right', from: 'Head', hand: [0.22, 0.1, -0.1], pole: [0.9, 0.2, -0.5], twist: -0.38, lean: 0.08, roll: -0.06, hips: [-0.02, -0.03, -0.05], tuck: 0.1 },
  coward_lowkick: { arm: null, twist: 0.15, lean: 0.15, roll: 0, hips: [0, 0, -0.04], tuck: 0.06 },
  guard_knee: { arm: null, twist: 0, lean: -0.08, roll: 0, hips: [0, -0.03, -0.02], tuck: 0.08 },
  guard_headbutt: { arm: null, twist: 0, lean: 0.14, roll: 0, hips: [0, -0.02, -0.05], tuck: -0.12 },
};
// per persona: the brute's hook and haymaker cock the fist well up and back behind the ear, raise the striking shoulder
// (shrug, rad) and drag the rear foot back through the hold (drag, m); the smaller wind-ups come across to the lens
// side when the striking arm is on his far side (cross)
const CHAMBER_OWN = {
  brute: { hook: { hand: [0.28, 0.02, -0.25], shrug: 0.3, drag: 0.17 }, brute_haymaker: { hand: [0.28, 0.02, -0.25], shrug: 0.3, drag: 0.17 }, straight: { drag: 0.12 } },
  guard: { jab: { cross: true } },
  coward: { jab: { cross: true }, coward_slaps: { cross: true }, hook: { cross: true }, straight: { cross: true } },
};
// the library clips built on idle_combat's crouch (see liftStance)
const LIFT_CLIPS = new Set(['jab', 'straight', 'hook', 'uppercut', 'kick', 'roundhouse', 'guard', 'guard_hit', 'hit_light', 'hit_heavy', 'stumble', 'cx_hit_head_l', 'cx_hit_head_r', 'cx_hit_body']);
// how each lies once he is down (rad): roll onto his side about the body's long axis; curl the spine and draw the knees
// up; per arm [out along the ground, in over the chest, forearm bend]
const LIE = {
  brute: { Left: [1.1, 0, 0.4], Right: [0.3, 0, 0] },
  guard: { roll: 0.8, Left: [0.3, 0, 0.5], Right: [0.2, 0, 0] },
  coward: { curl: 0.5, knees: 0.9, Left: [-0.2, -0.6, 0.8], Right: [-0.2, -0.6, 0.8] },
};
const SPINE_W = [['Spine', 0.3], ['Spine1', 0.35], ['Spine2', 0.35]];
const HIP_TWIST = 0.35;
const _S = new THREE.Vector3(), _E = new THREE.Vector3(), _W = new THREE.Vector3(), _T = new THREE.Vector3(), _u = new THREE.Vector3();
const _h = new THREE.Vector3(), _E2 = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _pl = new THREE.Vector3(), _pk = new THREE.Vector3();
const _qp = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qr = new THREE.Quaternion(), _qs1 = new THREE.Quaternion(), _qs2 = new THREE.Quaternion(), _qt = new THREE.Quaternion();
const _qc = new THREE.Quaternion(), _qd = new THREE.Quaternion(), _fw = new THREE.Vector3(), _rt = new THREE.Vector3();
const _W2 = new THREE.Vector3(), _E3 = new THREE.Vector3(), _S2 = new THREE.Vector3();
const LEGS = [['LeftUpLeg', 'LeftLeg', 'LeftFoot'], ['RightUpLeg', 'RightLeg', 'RightFoot']];
const _leg = LEGS.map(() => ({ ankle: new THREE.Vector3(), knee: new THREE.Vector3(), hip: new THREE.Vector3(), foot: new THREE.Quaternion() }));

const _pv = new THREE.Vector3(), _pd = new THREE.Vector3(), _dx = new THREE.Vector3(), _dv = new THREE.Vector3(), _ds = new THREE.Vector3();
/** a world rotation straight off matrixWorld (no walk up the parents: the pass keeps what it reads fresh) */
function worldQ(o, out) { o.matrixWorld.decompose(_dv, out, _ds); return out; }
/** refresh these bones' world matrices only, parent first (the first one's parent must already be fresh) */
function fresh(...bones) { for (const b of bones) if (b) b.updateWorldMatrix(false, false); }
/** rotate a bone by a WORLD-space rotation about its own origin; only the bone itself is refreshed */
function rotW(bone, q) {
  worldQ(bone.parent, _qp);
  _qa.copy(_qp).invert().multiply(q).multiply(_qp);
  bone.quaternion.premultiply(_qa);
  bone.updateWorldMatrix(false, false);
}
/** analytic two-bone IK in world space: `end` reaches T, the middle joint bends toward `pole`, the upper bone is rolled
 *  so the middle joint stays a hinge; amt < 1 slerps from the pose it found. The chain must be fresh on entry. */
function ik2(up, mid, end, T, pole, amt = 1) {
  _qs1.copy(up.quaternion); _qs2.copy(mid.quaternion);
  _S.setFromMatrixPosition(up.matrixWorld); _E.setFromMatrixPosition(mid.matrixWorld); _W.setFromMatrixPosition(end.matrixWorld);
  const L1 = _S.distanceTo(_E), L2 = _E.distanceTo(_W);
  _u.subVectors(T, _S); let d = _u.length();
  if (d < 1e-4 || L1 < 1e-4 || L2 < 1e-4) return;
  _u.divideScalar(d);
  d = clamp(d, Math.abs(L1 - L2) + 0.01, (L1 + L2) * 0.998);
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), r = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  _h.copy(pole).addScaledVector(_u, -pole.dot(_u));
  if (_h.lengthSq() < 1e-8) return;
  _h.normalize();
  _E2.copy(_S).addScaledVector(_u, a).addScaledVector(_h, r);
  _T.copy(_S).addScaledVector(_u, d);
  _a.subVectors(_E, _S).normalize(); _b.subVectors(_E2, _S).normalize();
  rotW(up, _qr.setFromUnitVectors(_a, _b)); fresh(mid, end);
  _W.setFromMatrixPosition(end.matrixWorld); _E.setFromMatrixPosition(mid.matrixWorld);
  _a.subVectors(_W, _E); _a.addScaledVector(_b, -_a.dot(_b));
  _c.subVectors(_T, _E); _c.addScaledVector(_b, -_c.dot(_b));
  if (_a.lengthSq() > 1e-6 && _c.lengthSq() > 1e-6) {
    _a.normalize(); _c.normalize();
    rotW(up, _qr.setFromAxisAngle(_b, Math.atan2(_x.crossVectors(_a, _c).dot(_b), _a.dot(_c)))); fresh(mid, end);
  }
  _W.setFromMatrixPosition(end.matrixWorld); _E.setFromMatrixPosition(mid.matrixWorld);
  _a.subVectors(_W, _E).normalize(); _c.subVectors(_T, _E).normalize();
  rotW(mid, _qr.setFromUnitVectors(_a, _c)); fresh(end);
  if (amt < 0.999) {
    _qt.copy(up.quaternion); up.quaternion.copy(_qs1).slerp(_qt, amt);
    _qt.copy(mid.quaternion); mid.quaternion.copy(_qs2).slerp(_qt, amt);
    fresh(up, mid, end);
  }
}
/** the chest's forward / down / left and the face's forward in their bones' own frames, read off the bind (the body
 *  faces +z, his left is +x) */
function boneAxes(h) {
  const sk = h.skeleton, q = new THREE.Quaternion(), m = new THREE.Matrix4();
  const local = (b, v) => { const i = sk.bones.indexOf(b); m.copy(sk.boneInverses[i]).invert().decompose(_dv, q, _ds); return v.applyQuaternion(q.invert()); };
  const B = h.bones;
  return { chestFwd: local(B.Spine2, new THREE.Vector3(0, 0, 1)), chestDown: local(B.Spine2, new THREE.Vector3(0, -1, 0)),
    chestLeft: local(B.Spine2, new THREE.Vector3(1, 0, 0)), faceFwd: local(B.Head, new THREE.Vector3(0, 0, 1)) };
}
/** a local bone rotation at most `max` rad from its bind (idempotent: a frozen pose can run it every frame) */
function clampBone(bone, bind, max) {
  if (!bone || !bind) return;
  const dot = Math.min(1, Math.abs(bone.quaternion.dot(bind))), ang = 2 * Math.acos(dot);
  if (ang > max) { _qt.copy(bone.quaternion); bone.quaternion.copy(bind).slerp(_qt, max / ang); }
}

const enemy = {
  name: 'enemy',
  list: [],
  TYPES, PERSONA,
  nextId: 1,
  now: 0,
  director: { holders: [], max: 1, nextGrant: 0, centre: null },
  metrics: null,
  clips: null,
  coins: null,
  barkAt: 0,

  init(engine) {
    this.engine = engine;
    this.rng = engine.rng.fork(909);
    this.anim = engine.get('animations');
    this._foes = [];
    this.resetMetrics();
    try { this.buildClips(); } catch (err) { console.warn('[enemy] stance clips', err); }
    // the pose pass (chamber, armour jolt, neck clamp) has to run after combat's flinch additive and before the frame
    // is drawn: a tiny system registered now lands after every module main.js registered
    if (engine.register) engine.register({ name: 'enemyPose', update: (dt) => this.lateUpdate(dt) });
    if (!(engine.params && engine.params.shot)) this.buildCoins();   // in the scene from boot: lighting hooks it early
    engine.events.on('combat:ko', ({ target }) => { if (target && target.kind === 'enemy') this.onKo(target); });
    engine.events.on('combat:hit', (ev) => this.onHit(ev));
    engine.events.on('combat:start', () => this.onFightStart());
    engine.events.on('combat:end', () => { for (const e of this.list) this.dropToken(e); this.director.holders.length = 0; this.fightOver = true; });
    const raw = (engine.params && engine.params.raw) || {};
    if (engine.params && engine.params.fight) {
      const city = engine.get('city');
      const spots = city && city.getSpawnPoints ? city.getSpawnPoints().enemies : [new THREE.Vector3(19, 0, 25), new THREE.Vector3(22, 0, 23), new THREE.Vector3(16, 0, 28)];
      spots.slice(0, 3).forEach((p, i) => { const e = this.spawn('chinpira', p, { persona: CAST[i % CAST.length], aggro: true }); e.aggro = true; this.go(e, 'approach'); });
      engine.state.mode = 'combat';
      engine.events.emit('combat:start', { enemies: this.list.slice() });
    }
    if (raw.enemylab) engine.events.on('engine:booted', () => this.runLab().catch((err) => console.warn('[enemy] lab failed', err)));
  },

  // ------------------------------------------------------------------------------------------------ spawning
  nextPersona() {
    const taken = new Set(this.list.filter((e) => e.alive).map((e) => e.persona));
    for (const k of CAST) if (!taken.has(k)) return k;
    return CAST[(this.nextId - 1) % CAST.length];
  },

  spawn(type = 'chinpira', position, opts = {}) {
    const engine = this.engine;
    const key = PERSONA[opts.persona] ? opts.persona : PERSONA[opts.personality] ? opts.personality : this.nextPersona();
    const P = PERSONA[key];
    const seed = this.nextId * 17 + 3;
    // full detail for the contact decals under the feet; no LOD ladder: on the scans it ADDED ~80 k triangles per man
    // in the fight view (3.61 M -> 3.85 M on ?shot=combat) instead of saving any
    const variant = opts.variant || P.variant;
    // the scan's LOD ladder, but picked here (see pickLod), never by THREE.LOD's own per-camera switch: that one ran
    // per render pass (shadow, reflection, main) and drew the wrong level — or all of them — in the fight view
    const h = createHumanoid({ variant, seed, detail: 1, lod: true, getClip: this.clipProvider(key) });
    if (h.lod && h.lod.isLOD) { h.lod.autoUpdate = false; this.setLod(h, 0); }
    h.lateFloor = true;                                                  // floorFit runs after lie(), in lateUpdate
    this.prepareBody(h, variant, key, opts.ownClothes);
    const group = h.group, k = P.scale || 1;
    // the brute is the salaryman's scan, 6 % bigger (combat still reads him as 1.8 m: its hit heights are relative)
    if (k !== 1) group.scale.multiplyScalar(k);
    group.position.copy(position || new THREE.Vector3());
    group.position.y = engine.world ? engine.world.groundHeight(group.position.x, group.position.z) : 0;
    engine.scene.add(group);
    const e = {
      id: 'enemy' + (this.nextId++), name: opts.name || P.name, kind: 'enemy', type: 'chinpira', persona: key, P,
      group, position: group.position, yaw: 0, humanoid: h,
      radius: 0.35 * k, height: 1.8, hp: P.hp, hpMax: P.hp, heat: 0, velocity: new THREE.Vector3(),
      state: 'idle', stateT: 0, alive: true, aggro: false, cooldown: this.rng.range(0.4, 1.2), blockChance: P.roll,
      forward(out = new THREE.Vector3()) { return out.set(Math.sin(e.yaw), 0, Math.cos(e.yaw)); },
      setState(s, t = 0) { e.state = s; e.stateT = t; },
      // AI
      mv: new THREE.Vector3(), seen: 'idle', token: false, atk: null, slotA: null, slotR: P.ring, waitT: 0,
      tauntT: this.rng.range(4, 8) / P.taunt, stuckT: 0, detour: 0, detourT: 0, guardUntil: 0, counter: false,
      lastHit: null, deadT: 0, sector: -1, stepU: 0, rayT: 0, wallR: 99, desperate: false, gone: false,
    };
    if (engine.player) e.yaw = Math.atan2(engine.player.position.x - e.position.x, engine.player.position.z - e.position.z);
    group.rotation.y = e.yaw;
    const fight = engine.state.mode === 'combat' || opts.aggro;
    h.play(fight ? 'idle_combat' : 'idle', { fade: 0 });
    if (fight) h.mixer.update(this.rng() * 0.8);                          // desync the idles
    this.list.push(e);
    const combat = engine.get('combat');
    if (combat && combat.register) combat.register(e);
    if (!(engine.params && engine.params.shot)) this.prewarm(e);
    engine.events.emit('enemy:spawned', { entity: e });
    return e;
  },

  /** clips the library does not have (the persona moves) come from this module; the rest from animations.js */
  /** idle_combat is the persona's own stance (ei_<p>), whoever asks for it (combat after a reaction, missions) */
  clipProvider(pk) {
    const P = this._providers || (this._providers = {});
    const key = pk && STANCE[pk] ? pk : '_';
    if (!P[key]) {
      const own = key === '_' ? null : 'ei_' + key[0];
      P[key] = (name) => (this.clips && ((own && name === 'idle_combat' && this.clips[own]) || this.clips[name])) || (this.anim && this.anim.getClip ? this.anim.getClip(name) : null);
    }
    return P[key];
  },
  setLod(h, level) {
    const L = h.lod;
    if (!L || !L.isLOD || h.lodLevel === level) return;
    h.lodLevel = level;
    L.levels.forEach((lv, i) => { lv.object.visible = i === Math.min(level, L.levels.length - 1); });
  },
  /** LOD0 for the man nearest the lens within 6 m and anyone within 3 m, LOD1 to 18 m, LOD2 beyond; no shadow
   *  caster past 5 m (the scans are 28 k triangles a pass) */
  pickLod() {
    const cam = this.engine.camera;
    if (!cam) return;
    let near = null, nd = Infinity;
    for (const e of this.list) {
      if (e.gone) continue;
      e.camD = cam.position.distanceTo(e.position);
      if (e.camD < nd) { nd = e.camD; near = e; }
    }
    for (const e of this.list) {
      if (e.gone) continue;
      const d = e.camD, h = e.humanoid;
      const floor = e.state === 'down' || e.state === 'dead';          // a body on the floor never needs the full scan
      this.setLod(h, !floor && ((e === near && d < 6) || d < 3) ? 0 : d < 18 ? 1 : 2);
      const cast = d < 5 && !NO_ECAST;
      if (h.castNow !== cast) { h.castNow = cast; h.skinned.castShadow = cast; }
    }
  },
  /** the scan's prop islands out (see planBody); stats kept on the humanoid for the report */
  prepareBody(h, variant, persona, ownClothes = false) {
    const raw = (this.engine.params && this.engine.params.raw) || {};
    if (!h.skeleton || !h.meshes) return;
    try {
      if (!raw.nospine) { h.spineShift = spineShift(h, variant); applySpineShift(h, h.spineShift); }
      const segs = bindSegments(h.skeleton);
      let culled = 0;
      // (the story cast — humanoid.js `cast` scans, e.g. 'hiiragi' — is built clean offline: open hands, nothing carried,
      // its seat / jacket / neck weights set by the pipeline. The prop-island cull took 柊's fingertips for a prop.)
      if (!h.cast) h.meshes.forEach((m, i) => { culled += cleanBody(m, variant + ':' + i + ':' + m.geometry.attributes.position.count, segs, raw.cull === 'show'); });
      h.culledTris = culled;
      const swaps = ownClothes ? null : WARDROBE[persona];      // a named NPC turned enemy keeps what he wore
      const m0 = h.skinned.material;
      if (swaps && m0 && !Array.isArray(m0) && m0.isMeshStandardMaterial && !raw.nowardrobe) {
        const wm = wardrobeMaterial(m0, swaps, (PERSONA[persona] && PERSONA[persona].scale) || 1);
        for (const m of h.meshes) { wardMask(m.geometry, segs); if (m.material === m0) m.material = wm; }
        h.wardrobe = wm;
        if (raw.edbg === 'ward') console.info(`[enemy] ward ${persona} ${variant} meshes ${h.meshes.map((m) => (m.material === wm ? 'W' : m.material && m.material.name)).join(',')} m0 ${m0.name}`);
      }
      if (raw.cull === 'bones') {                                     // debug: flat colour per dominant bone
        for (const m of h.meshes) {
          const g = m.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, n = si.count, col = new Float32Array(n * 3), c = new THREE.Color();
          for (let v = 0; v < n; v++) {
            let bw = -1, bi = 0;
            for (let k = 0; k < 4; k++) if (sw.getComponent(v, k) > bw) { bw = sw.getComponent(v, k); bi = si.getComponent(v, k); }
            c.setHex(BONE_DBG[BONE_NAMES[bi]] || 0x808080); col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
          }
          g.setAttribute('color', new THREE.BufferAttribute(col, 3));
          m.material = new THREE.MeshBasicMaterial({ vertexColors: true });
        }
      }
    } catch (err) { console.warn('[enemy] body clean-up skipped', err); }
  },

  /** spawnGroup(3, around) or spawnGroup({count, personas, types}, around). The cast order is brute, guard, coward:
   *  missions lines them up by index, the guard (the 兄貴分 who does the talking) in the middle. */
  spawnGroup(spec = 3, around = null, type = 'chinpira') {
    const engine = this.engine, p = around || (engine.player ? engine.player.position : new THREE.Vector3());
    const o = typeof spec === 'object' && spec ? spec : { count: spec };
    const personas = o.personas || o.personalities || null;
    const n = Math.max(1, o.count || (personas && personas.length) || (o.types && o.types.length) || 3);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rng() * 0.5;
      const pos = new THREE.Vector3(p.x + Math.sin(a) * 4.5, 0, p.z + Math.cos(a) * 4.5);
      const t = (o.types && o.types[i % o.types.length]) || type;
      const e = this.spawn(t, pos, { aggro: true, persona: personas ? personas[i % personas.length] : CAST[i % CAST.length] });
      e.aggro = true; this.go(e, 'approach');
      out.push(e);
    }
    if (engine.state.mode !== 'combat') { engine.state.mode = 'combat'; engine.events.emit('combat:start', { enemies: out }); }
    return out;
  },

  clear() {
    for (const e of this.list) {
      this.dropToken(e);
      if (e.group.parent) e.group.parent.remove(e.group);
      if (!e.gone) { try { e.humanoid.dispose(); } catch (err) { /* already gone */ } }
      if (e.fadeMats) for (const m of e.fadeMats.values()) m.dispose();
    }
    this.list.length = 0;
    this.director.holders.length = 0;
    if (this._warmFrames) {                                          // cut short: warm again on the next fight
      if (this._warmMesh && this._warmMesh.parent) this._warmMesh.parent.remove(this._warmMesh);
      this._warmMesh = null; this._warmE = null; this._warmFrames = 0; this._warm = false;
    }
    if (this.coins) { this.coins.live.length = 0; this.coins.mesh.count = 0; this.coins.mesh.visible = false; }
  },

  // ------------------------------------------------------------------------------------------------ events
  onFightStart() {
    const D = this.director;
    D.holders.length = 0; D.nextGrant = this.now + 1.1; D.centre = null;
    this.resetMetrics();
    this.armorShown = false; this.fightOver = false;
    for (const e of this.list) e.plateKey = null;                      // hud.showEnemy runs on a state change: re-show now
    // the opening: they square up one after another (a beckon each), the first one says something
    let k = 0;
    for (const e of this.list) {
      if (!e.alive) continue;
      e.opening = true; e.openT = 0.25 + k * 0.6 + this.rng() * 0.15; e.openLine = k === 0;
      e.tauntT = 8 + this.rng() * 4; e.cooldown = 0.6 + k * 0.5; e.waitT = 0; k++;
    }
    D.nextGrant = this.now + 0.25 + k * 0.6;
  },

  onHit(ev) {
    if (!ev) return;
    const { attacker, target, guarded } = ev;
    const M = this.metrics;
    if (attacker && attacker.kind === 'enemy') {
      if (guarded) M.blocked++;
      else if (target && target.isPlayer) {
        M.landed++;
        // he has just been hit: the others let him have it for a moment instead of queueing up on a man in hit-stun
        this.breatheUntil = Math.max(this.breatheUntil || 0, this.now + 0.55);
        this.director.nextGrant = Math.max(this.director.nextGrant, this.now + 0.9);
      }
    }
    if (!target || target.kind !== 'enemy') return;
    target.lastHit = { t: this.now, guarded: !!guarded, heavy: !!ev.heavy, name: ev.name, dir: ev.dir && ev.dir.isVector3 ? ev.dir.clone() : null };
    if (guarded) { target.counter = true; target.guardUntil = Math.max(target.guardUntil, this.now + 0.55); M.guards++; return; }
    const combat = this.engine.get('combat');
    const a = combat && combat.activeOf ? combat.activeOf(target) : null;
    // the brute's haymaker has armour: once it is coming, a jab or a straight lands (damage, flinch, burst) but does
    // not stop it — only a heavy blow, a knockdown or the KO does. Undo the light reaction and put the swing back.
    const k = target.atk;
    if (target.persona === 'brute' && k && a && a === k.rec && k.i === 0 && k.phase !== 'load' && !ev.heavy
      && target.state === 'hit' && target.hp > 0 && target.alive) {
      const h = target.humanoid;
      const act = h.play(k.name, { loop: false, force: true, fade: 0 });      // the swing keeps its full weight
      if (act) { act.time = a.t; act.setEffectiveTimeScale(a.rate); act.setEffectiveWeight(1); a.action = act; }
      target.state = target.seen = 'attack'; target.stateT = 0;
      target.velocity.multiplyScalar(0.2);
      // what the player reads instead of a flinch: an 8° jolt of the chest off the blow (pose pass), a clank, and
      // the words the first time it happens
      const d = _v.copy(ev.dir || target.forward(_w).negate()).setY(0);
      if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
      target.jolt = { t: 0, axis: new THREE.Vector3().crossVectors(UP, d.normalize()).normalize() };
      this.engine.events.emit('combat:armor', { target, attacker, point: ev.point || null, dir: d.clone() });
      try { if (combat.vfx && combat.vfx.metal && ev.point) combat.vfx.metal(ev.point.clone ? ev.point.clone() : ev.point, d.clone(), 0.55); } catch (err) { /* optional */ }
      if (!this.armorShown) { this.armorShown = true; this.popText(target, 'スーパーアーマー'); }
      M.armor++;
      return;
    }
    // a blow that lands interrupts his swing: the record would otherwise still resolve its contact mid-stagger.
    // (marked spent here, ended on his next think — combat is iterating its attack list right now)
    if (a && a.hits && a.done) for (let k = 0; k < a.hits.length; k++) a.done.add(k);
    if (target.atk) target.atk.cancelled = true;
    if (target.P && target.P.retreat && target.hp < target.hpMax * 0.5 && this.rng() < 0.5) this.bark(target, 'scared');
  },

  onKo(e) {
    if (!e || (!e.alive && e.state === 'dead')) return;
    this.cancelAttack(e);
    this.dropToken(e);
    e.alive = false; e.deadT = 0; e.deadClip = false; e.mv.set(0, 0, 0);
    // combat has already started the knockdown on the killing blow (a heat action leaves him lying): never replay it
    const h = e.humanoid;
    if (h.currentName !== 'knockdown' && e.state !== 'down' && !h.frozenPose) h.play('knockdown', { loop: false, force: true, fade: 0.08 });
    e.setState('dead'); e.seen = 'dead';
    this.metrics.kos++;
    this.dropYen(e);
    this.engine.events.emit('enemy:ko', { entity: e, position: e.position.clone() });
    const anyAlive = this.list.some((x) => x.alive && x.aggro);
    if (!anyAlive && this.engine.state.mode === 'combat') {
      this.engine.state.mode = 'explore';
      this.engine.events.emit('combat:end', { enemies: this.list.slice() });
    }
  },

  // ------------------------------------------------------------------------------------------------ frame
  update(dt) {
    const engine = this.engine, player = engine.player;
    // humanoid.update ran each mixer this frame unless the pose is frozen: the pose pass may add to it only then
    for (const e of this.list) e.fresh = !e.humanoid.frozenPose;
    if (((this._lodF = (this._lodF || 0) + 1) % 5) === 1 || engine.state.frozen) this.pickLod();
    if (!player) return;
    const frozen = engine.state.frozen || engine.state.mode === 'cutscene' || engine.state.mode === 'paused';
    if (this._warmFrames) this.warmTick();
    if (this.castShot) this.hideOthers();
    this.updateCoins(dt, frozen);
    if (frozen) {
      this.holdStill();
      // the victory cut: the bodies are cleared under it (a shot or the pause keeps everything as it is)
      if (engine.state.mode === 'cutscene' && !engine.state.frozen) for (const e of this.list) if (!e.alive) this.updateDead(e, dt);
      return;
    }
    this.now += dt;
    if (this.labOn) this.labKeep();
    if (this.ringShot) this.ringTick(dt);
    const combat = engine.get('combat'), hud = engine.get('hud');
    this.combat = combat;
    const foes = this._foes; foes.length = 0;
    for (const e of this.list) {
      if (!e.alive) continue;
      const dist = Math.hypot(player.position.x - e.position.x, player.position.z - e.position.z);
      if (!e.aggro && dist < 12 && player.alive) { e.aggro = true; this.go(e, 'approach'); }
      if (e.aggro && engine.state.mode === 'explore' && dist < 14 && player.alive) {
        engine.state.mode = 'combat'; engine.events.emit('combat:start', { enemies: this.list.filter((x) => x.alive) });
      }
      if (e.aggro) { foes.push(e); if (hud && hud.showEnemy && e.plateKey !== e.state) { hud.showEnemy(e); e.plateKey = e.state; } }
    }
    this.updateDirector(player, foes);
    this.assignSlots(player, foes, dt);
    for (const e of this.list) this.think(e, dt, player);
    this.sample(dt, foes);
  },

  /** frozen (a shot, a cutscene, a heat action, the pause): nobody walks on the spot */
  holdStill() {
    for (const e of this.list) {
      if (!e.alive || e.gone) continue;
      const h = e.humanoid;
      if (h.frozenPose || REACT.has(e.state) || e.state === 'attack' || e.state === 'dead') continue;
      const n = h.currentName;
      if (n && (n.startsWith('es_') || n === 'walk' || n === 'run')) h.play(e.aggro ? 'idle_combat' : 'idle', { fade: 0.2 });
      else if (!n || n === 'idle') h.play(e.aggro ? 'idle_combat' : 'idle');
      e.mv.set(0, 0, 0);
    }
  },

  go(e, s) {
    e.state = s; e.stateT = 0; e.seen = s;
    const h = e.humanoid;
    if (s === 'taunt') { h.play('taunt', { loop: false, force: true, fade: 0.2 }); e.mv.set(0, 0, 0); this.metrics.taunts++; }
    else if (s === 'guard') { e.guardUntil = Math.max(e.guardUntil, this.now + 1.0); this.metrics.guardUps++; }
    else if (s === 'recover') { this.dropToken(e); e.cooldown = Math.max(e.cooldown, this.rng.range(e.P.rest[0], e.P.rest[1])); e.waitT = 0; }
    else if (s === 'retreat') { this.dropToken(e); e.retreatFor = this.rng.range(1.0, 1.6); this.metrics.retreats++; }
    else if (s === 'getup') { h.play('getup', { loop: false, force: true, fade: 0.1 }); this.metrics.getups++; }
  },

  think(e, dt, player) {
    const P = e.P, h = e.humanoid;
    if (!e.alive) { this.updateDead(e, dt); return; }
    e.stateT += dt;
    if (e.cooldown > 0) e.cooldown -= dt;
    if (e.tauntT > 0) e.tauntT -= dt;
    // combat (or missions/menus) changed his state from outside: a blow landed, he was knocked down, re-staged
    if (e.state !== e.seen) this.external(e);
    if (e.guardUntil > this.now && e.state !== 'guard' && !REACT.has(e.state)) e.guardUntil = 0;

    const toX = player.position.x - e.position.x, toZ = player.position.z - e.position.z;
    const dist = Math.hypot(toX, toZ) || 1e-3;
    e.dist = dist;

    if (e.state === 'hit') {
      // the reaction plays out: he leaves 'hit' at 85 % of the clip combat started (a re-hit restarts the clock),
      // riding its knockback plus a second stagger step on a heavy blow, and is never left standing inside 健人
      const act = h.currentAction;
      if (!e.hitR || e.hitR.act !== act || e.stateT < e.hitR.last - 1e-4) this.beginHit(e, act, dt);
      const R = e.hitR;
      R.t += dt; R.last = e.stateT;
      if (R.step && R.t >= 0.22) { e.velocity.add(R.step); R.step = null; }
      this.applyVelocity(e, dt);
      if (dist < 0.9) this.move(e, _d.set(-toX / dist, 0, -toZ / dist).multiplyScalar((0.9 - dist) * Math.min(1, dt * 12)));
      if (R.t >= R.need) {
        e.hitR = null;
        const lh = e.lastHit;
        if (lh && lh.guarded && e.P.block && this.now - lh.t < 0.6 && !(e.guardBroken > 0)) this.go(e, 'guard');
        else if (P.retreat && this.rng() < P.retreat && dist < P.ring + 0.5) this.go(e, 'retreat');
        else if (P.eager > 0.5 && e.cooldown < 0.6) { e.cooldown = 0; this.go(e, 'circle'); }
        else this.go(e, 'circle');
      }
      return;
    }
    if (e.state === 'down') {
      this.applyVelocity(e, dt);
      if (e.stateT > P.downT + (e.downExtra || 0)) this.go(e, 'getup');
      return;
    }
    if (e.state === 'getup') {
      this.applyVelocity(e, dt);
      if (e.stateT > 1.05) {
        if (P.retreat) this.go(e, 'retreat');
        else if (this.rng() < 0.45 && this.bark(e, 'getup')) this.go(e, 'taunt');
        else this.go(e, 'recover');
      }
      return;
    }
    if (!e.aggro || !player.alive) {
      this.steer(e, _v.set(0, 0, 0), dt);
      if (e.aggro && !player.alive && e.state !== 'taunt' && e.tauntT <= 0) { e.tauntT = 99; this.go(e, 'taunt'); }
      if (e.state !== 'taunt' || e.stateT > 1.45) h.play(e.aggro ? 'idle_combat' : 'idle');
      return;
    }
    if (e.state === 'attack') { this.updateAttack(e, dt, player, dist); this.applyVelocity(e, dt); return; }
    if (e.state === 'idle') this.go(e, 'approach');

    const busy = this.playerBusy(player);
    const down = player.state === 'down' || player.state === 'getup';
    if (e.opening && (e.openT -= dt) <= 0) {
      e.opening = false;
      if ((e.state === 'approach' || e.state === 'circle') && !e.token && dist > 1.8) {
        if (e.openLine) this.bark(e, 'taunt', true);
        this.go(e, 'taunt');
        this.turn(e, Math.atan2(toX, toZ), 1, 99);
        return;
      }
    }
    this.guardCheck(e, player, dist);

    let want = _v.set(0, 0, 0), faceMove = false, guardPose = false;
    switch (e.state) {
      case 'engage': {
        if (down || e.stateT > 3.8) { this.go(e, 'recover'); break; }
        const plan = e.plan || (e.plan = this.pickCombo(e)), reach = this.reachOf(plan[0]);
        if (dist <= reach + 0.18 && Math.abs(this.facingErr(e, toX, toZ)) < 0.55) {
          // two tells never start together: he waits (in range, square to 健人) until the other man's hold is mostly spent
          if (!this.tellBlocked(e) && this.startCombo(e, plan.slice())) return;
          if (dist < reach - 0.1) want.set(-toX / dist, 0, -toZ / dist).multiplyScalar(0.4);
          break;
        }
        const far = dist > 4.2;
        const sp = far ? (P.retreat ? P.run : P.walk * 1.2) : Math.min(P.shuffle * 1.25, 1.6);
        want.set(toX / dist, 0, toZ / dist).multiplyScalar(sp * clamp((dist - reach + 0.1) * 1.6, 0.35, 1));
        faceMove = far;
        break;
      }
      case 'recover': {
        // a step back out of range, still facing him
        want.set(-toX / dist, 0, -toZ / dist).multiplyScalar(dist < P.ring ? 1.0 : 0.3);
        if (e.stateT > 0.55 + (P.retreat ? 0.2 : 0)) this.go(e, 'circle');
        break;
      }
      case 'retreat': {
        const far = P.ring + 1.4;
        if (dist < far) want.set(-toX / dist, 0, -toZ / dist).multiplyScalar(1.6);
        if (e.stateT > e.retreatFor || dist >= far + 0.4) this.go(e, 'circle');
        break;
      }
      case 'taunt': {
        if (e.token) { this.go(e, 'engage'); break; }
        if (e.stateT > 1.4 || dist < 1.5) this.go(e, 'circle');
        break;
      }
      case 'guard': {
        guardPose = true;
        e.guard = true;
        if (!(e.guardBroken > 0)) e.guardT = Math.max(e.guardT || 0, 0.2);
        const combat = this.combat, pa = combat && combat.isAttacking ? combat.isAttacking(player) : false;
        if (!pa && (this.now > e.guardUntil || e.counter)) {
          e.guard = false;
          if (e.counter && this.canCounter(e) && this.counterAttack(e)) return;
          e.counter = false;
          this.go(e, 'circle');
        }
        // a small step back while he holds it: the string pushes him, he gives ground
        if (dist < 1.3) want.set(-toX / dist, 0, -toZ / dist).multiplyScalar(0.5);
        break;
      }
      default: {                                                   // approach / circle: hold the slot
        if (e.token) { this.go(e, 'engage'); break; }
        if (e.state !== 'approach' && e.state !== 'circle') this.go(e, 'circle');
        const sx = player.position.x + Math.sin(e.slotA || 0) * e.slotR, sz = player.position.z + Math.cos(e.slotA || 0) * e.slotR;
        let dx = sx - e.position.x, dz = sz - e.position.z;
        const dd = Math.hypot(dx, dz);
        if (dd > 0.12) {
          const far = dd > 3.5 && dist > 5;
          const sp = far ? P.walk : Math.min(P.shuffle, 1.55);
          dx /= dd; dz /= dd;
          // never walk through him: slide round the ring instead of across it
          const ux = -toX / dist, uz = -toZ / dist;                 // player -> me
          const across = -(dx * ux + dz * uz);
          if (across > 0.3 && dist < e.slotR + 1.2) {
            const side = (ux * dz - uz * dx) > 0 ? 1 : -1;
            dx = dx * 0.35 + uz * side * 0.9; dz = dz * 0.35 - ux * side * 0.9;
            const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          }
          want.set(dx, 0, dz).multiplyScalar(sp * clamp(dd * 1.4, 0.25, 1));
          faceMove = far;
          if (e.state === 'approach' && dd < 1.2) e.state = e.seen = 'circle';
        } else if (e.state === 'approach') e.state = e.seen = 'circle';
        // taunt from the slot when there is room and nobody needs him
        const targeted = busy && this.combat && this.combat.activeOf && (this.combat.activeOf(player) || {}).target === e;
        if (e.state === 'circle' && e.tauntT <= 0 && dd < 0.8 && dist > 2.2 && !targeted && e.cooldown > 0.3) {
          e.tauntT = this.rng.range(7, 12) / P.taunt;
          if (this.rng() < 0.7) { this.bark(e, down ? 'floor' : 'taunt'); this.go(e, 'taunt'); }
        }
        // the brute does not wait to be asked when 健人 walks into him
        if (P.eager > 0.5 && dist < 1.9 && !e.token && e.cooldown < 1.0 && !down) e.cooldown = 0;
        // the coward keeps his distance
        if (P.retreat && dist < 1.8 && !e.token) this.go(e, 'retreat');
      }
    }
    // separation: the others and 健人's personal space
    this.separate(e, want, player, dist);
    // separation can add metres per second on top of the gait: the stance clips are foot-locked up to 1.7 m/s
    if (!faceMove) { const wl = Math.hypot(want.x, want.z); if (wl > 1.7) want.multiplyScalar(1.7 / wl); }
    if (e.stuckT > 0.4) { e.detour = e.detour || (this.rng() < 0.5 ? 1 : -1); e.detourT = 0.7; e.stuckT = 0; }
    if (e.detourT > 0) {
      e.detourT -= dt;
      const c = Math.cos(1.1 * e.detour), s = Math.sin(1.1 * e.detour);
      want.set(want.x * c + want.z * s, 0, -want.x * s + want.z * c);
      if (e.detourT <= 0) e.detour = 0;
    }
    this.steer(e, want, dt);
    // facing: toward 健人, or along the path when crossing open ground
    const targetYaw = faceMove && e.mv.lengthSq() > 0.3 ? Math.atan2(e.mv.x, e.mv.z) : Math.atan2(toX, toZ);
    this.turn(e, targetYaw, dt, e.state === 'guard' ? P.turn * 1.4 : P.turn);
    if (e.state !== 'taunt') this.animate(e, faceMove, guardPose);
    this.applyVelocity(e, dt);
  },

  /** a new reaction: how long it runs and how far it carries him (the brute barely gives, the coward reels) */
  beginHit(e, act, dt) {
    const clip = act && act.getClip ? act.getClip() : null;
    const ts = act ? Math.abs(act.getEffectiveTimeScale()) || 1 : 1, s0 = e.stateT - dt;
    const lh = e.lastHit, guarded = !!(lh && lh.guarded && this.now - lh.t < 0.3);
    const R = e.hitR = { act, t: 0, last: e.stateT, need: Math.max(0.4 - s0, clip ? clip.duration * 0.85 / ts : 0.4), step: null };
    if (guarded) return;
    const k = e.P.stagger || 1;
    e.velocity.multiplyScalar(k);
    const heavy = (lh && lh.heavy) || (clip && /hit_heavy|stumble|body/.test(clip.name));
    if (heavy && e.velocity.lengthSq() > 0.04) R.step = e.velocity.clone().setY(0).normalize().multiplyScalar(1.6 * k);
  },
  /** a state set from outside (combat's reactions, missions / menus re-staging, the combat lab) */
  external(e) {
    const s = e.state;
    if (s === 'hit' || s === 'down' || s === 'dead') {
      this.cancelAttack(e);
      this.dropToken(e);
      e.mv.set(0, 0, 0); e.guard = false;
      if (s === 'down') { this.metrics.downs++; e.downExtra = this.rng.range(0, 0.35); }
    }
    if (s !== 'dead') e.seen = s;
  },

  tellBlocked(e) {
    if (this.now < (this.breatheUntil || 0)) return true;
    const p = this.engine.player;
    if (p && (p.state === 'hit' || p.state === 'down' || p.state === 'getup')) return true;
    for (const o of this.list) {
      if (o === e || !o.alive || o.state !== 'attack' || !o.atk) continue;
      const k = o.atk;
      if (k.phase === 'load' || (k.phase === 'hold' && k.holdT < k.hold * 0.6)) return true;
    }
    return false;
  },
  playerBusy(p) {
    const c = this.combat;
    return (c && c.isAttacking && c.isAttacking(p)) || p.state === 'hit' || p.state === 'attack' || p.state === 'heat';
  },
  facingErr(e, toX, toZ) { return wrap(Math.atan2(toX, toZ) - e.yaw); },
  reachOf(name) {
    const c = this.combat, def = (c && c.ATTACKS && c.ATTACKS[name]) || MOVE_DEFS[name] || null;
    return (def ? def.reach : 1.35) - 0.12;
  },

  // ------------------------------------------------------------------------------------------------ director
  /** the attack token: at most MAX_TOKENS men engage at once (one while only two are left), handed out at least
   *  0.6 s apart and held back for 0.9 s after a blow lands on 健人; tellBlocked() staggers the wind-ups themselves */
  updateDirector(player, foes) {
    const D = this.director;
    for (let i = D.holders.length - 1; i >= 0; i--) { const e = D.holders[i]; if (!e.token || !e.alive) D.holders.splice(i, 1); }
    const standing = this._standing || (this._standing = []);
    standing.length = 0;
    for (const e of foes) if (e.alive && e.hp > 0) standing.push(e);
    D.max = standing.length >= 3 ? MAX_TOKENS : 1;
    if (standing.length === 1 && standing[0].P.retreat && standing[0].hp < standing[0].hpMax * 0.6 && !standing[0].desperate) {
      standing[0].desperate = true; this.bark(standing[0], 'last', true);
    }
    const ha = this.engine.get('heatActions');
    if (!player.alive || player.state === 'down' || player.state === 'getup' || (ha && ha.running)) {
      for (const e of D.holders.slice()) if (e.state === 'engage') this.go(e, 'recover');
      return;
    }
    // tokens are handed out at least half a second apart; the wind-ups themselves are staggered in 'engage'
    if (D.holders.length >= D.max || this.now < D.nextGrant) return;
    const busy = this.playerBusy(player);
    const cam = this.engine.camera;
    cam.getWorldDirection(_o); _o.y = 0; _o.normalize();
    let best = null, bs = Infinity;
    for (const e of standing) {
      if (e.token || e.cooldown > 0 || e.opening || (e.state !== 'circle' && e.state !== 'approach')) continue;
      const dx = e.position.x - player.position.x, dz = e.position.z - player.position.z, d = Math.hypot(dx, dz) || 1;
      let s = d - Math.min(e.waitT, 6) * 0.4 - e.P.eager;
      if ((dx * _o.x + dz * _o.z) / d < -0.2) s += 1.6;          // behind the lens: he waits his turn
      if (this.hiddenBehind(e.position, player.position)) s += 1.5;  // behind 健人's back on screen: his tell would be hidden
      if (e.P.retreat) s += e.desperate ? -3 : busy ? -2.2 : 2.4; // the coward picks his moment
      if (s < bs) { bs = s; best = e; }
    }
    if (!best) return;
    best.token = true; D.holders.push(best);
    best.plan = this.pickCombo(best);
    this.go(best, 'engage');
    D.nextGrant = this.now + this.rng.range(0.6, 1.0);
    this.metrics.grants++;
  },
  dropToken(e) {
    if (!e.token) return;
    e.token = false;
    const H = this.director.holders, i = H.indexOf(e);
    if (i >= 0) H.splice(i, 1);
  },
  pickCombo(e) {
    const C = e.P.combos;
    // the last man standing, cornered, throws his longest string
    const k = e.desperate ? C.reduce((b, c, i) => (c.length > C[b].length ? i : b), 0) : Math.floor(this.rng() * C.length);
    return C[k].slice();
  },

  /** surround slots: the waiting men spread on a ring round 健人, centred on where the pack stands (so the camera
   *  that frames the pack is not chasing its own tail), each on his personality's radius, drifting slowly so the
   *  ring is never a line of statues; the token holders' bearings are kept clear */
  assignSlots(player, foes, dt) {
    const D = this.director;
    const ring = [], holders = [];
    let cx = 0, cz = 0;
    for (const e of foes) {
      const a = Math.atan2(e.position.x - player.position.x, e.position.z - player.position.z);
      e.bearing = a;
      cx += Math.sin(a); cz += Math.cos(a);
      if (e.token || e.state === 'attack') holders.push(e);
      else ring.push(e);
    }
    if (!foes.length) return;
    const want = Math.atan2(cx, cz);
    D.centre = D.centre == null ? want : D.centre + wrap(want - D.centre) * Math.min(1, dt * 0.8);
    ring.sort((a, b) => wrap(a.bearing - D.centre) - wrap(b.bearing - D.centre));
    const n = ring.length, down = player.state === 'down' || player.state === 'getup';
    for (let i = 0; i < n; i++) {
      const e = ring[i];
      let a = D.centre + (i - (n - 1) / 2) * RING_STEP;
      // the coward drifts to 健人's flank (90° off his facing, whichever side he is on) while he waits for an opening:
      // at the edge of 健人's view, never parked behind his back where the lens would hide him
      if (e.P.retreat && !e.desperate) {
        const side = wrap(e.bearing - player.yaw) >= 0 ? 1 : -1;
        a = wrap(a + wrap(player.yaw + side * Math.PI / 2 - a) * 0.35);
      }
      a += 0.2 * Math.sin(this.now * 0.33 + i * 2.1);
      for (const hld of holders) {
        const g = wrap(a - hld.bearing);
        if (Math.abs(g) < HOLDER_GAP) a = hld.bearing + (g < 0 ? -HOLDER_GAP : HOLDER_GAP);
      }
      e.slotA = a;
      let r = e.P.ring + (down ? 0.9 : 0) + (e.P.retreat && e.hp < e.hpMax * 0.4 ? 0.8 : 0);
      e.rayT -= dt;
      if (e.rayT <= 0) { e.rayT = 0.25 + this.rng() * 0.1; e.wallR = this.wallAt(player, a, r + 0.6); }
      e.slotR = Math.max(1.4, Math.min(r, e.wallR - 0.55));
    }
    this.screenSpread(player, ring, holders, dt);
  },
  /** On screen, not just on the ring: two waiting men on one sightline stack into one silhouette under two plates,
   *  and a man straight behind 健人 is a man whose tell is hidden. Each waiting man eases his slot sideways (±0.35 rad)
   *  to whichever side keeps him 0.15 NDC clear of the others and of 健人. */
  screenSpread(player, ring, holders, dt) {
    const cam = this.engine.camera;
    if (!cam || !ring.length) return;
    const P = player.position, sx = this._sx || (this._sx = []);
    const at = (e, a) => _o.set(P.x + Math.sin(a) * e.slotR, P.y + 1.3, P.z + Math.cos(a) * e.slotR).project(cam).x;
    sx.length = 0;
    sx.push(_o.set(P.x, P.y + 1.3, P.z).project(cam).x);
    for (const h of holders) sx.push(_o.set(h.position.x, h.position.y + 1.3, h.position.z).project(cam).x);
    const pd = cam.position.distanceTo(P);
    for (const e of ring) {
      const others = (x, self) => {
        let m = 9;
        for (let i = 0; i < sx.length; i++) m = Math.min(m, Math.abs(x - sx[i]) / (i === 0 ? 0.12 : 0.15));
        for (const o of ring) if (o !== self && o.slotX != null) m = Math.min(m, Math.abs(x - o.slotX) / 0.15);
        return m;
      };
      let best = 0, bs = -1;
      for (const n of [0, -0.35, 0.35]) {
        const a = e.slotA + n, far = Math.hypot(P.x + Math.sin(a) * e.slotR - cam.position.x, P.z + Math.cos(a) * e.slotR - cam.position.z) > pd;
        const sc = far ? Math.min(1, others(at(e, a), e)) - Math.abs(n) * 0.2 : 1 - Math.abs(n) * 0.2;
        if (sc > bs + 1e-3) { bs = sc; best = n; }
      }
      e.nudge = (e.nudge || 0) + (best - (e.nudge || 0)) * Math.min(1, dt * 1.5);
      e.slotA += e.nudge;
      e.slotX = at(e, e.slotA);
    }
  },
  /** is a man at `p` on 健人's screen line (within 0.12 NDC) and farther from the lens than he is? */
  hiddenBehind(p, pp) {
    const cam = this.engine.camera; if (!cam) return false;
    const ex = _o.set(p.x, p.y + 1.3, p.z).project(cam).x, px = _w.set(pp.x, pp.y + 1.3, pp.z).project(cam).x;
    return Math.abs(ex - px) < 0.12 && cam.position.distanceToSquared(p) > cam.position.distanceToSquared(pp);
  },
  wallAt(player, a, max) {
    const world = this.engine.world;
    if (!world || !world.raycast) return 99;
    try {
      const hit = world.raycast(_w.set(player.position.x, player.position.y + 1.0, player.position.z), _d.set(Math.sin(a), 0, Math.cos(a)), max);
      return hit && hit.tag !== 'dynamic' && hit.tag !== 'ground' ? hit.distance : 99;
    } catch (err) { return 99; }
  },

  // ------------------------------------------------------------------------------------------------ attacks
  startCombo(e, plan) {
    e.atk = { chain: plan, i: 0, rec: null, phase: 'load', holdT: 0, hold: 0, cancelled: false };
    if (!this.startLink(e)) { e.atk = null; this.go(e, 'recover'); return false; }
    e.state = e.seen = 'attack'; e.stateT = 0;
    return true;
  },
  startLink(e) {
    const k = e.atk, combat = this.combat, name = k.chain[k.i];
    if (!combat || !combat.attack || !combat.activeOf) return false;
    const before = combat.activeOf(e);
    if (before) combat.endAttack(before);
    this.ensureMoves(combat);
    if (!combat.attack(e, name)) return false;
    const a = combat.activeOf(e);
    if (!a) return false;
    const own = this.clips && this.clips[name];
    if (own) {
      // combat started the move on the library clip its def names; the record now plays the persona clip instead
      const act = e.humanoid.play(name, { loop: false, force: true, fade: 0.06, speed: a.rate || 1 });
      if (act) {
        a.action = act; a.duration = own.duration;
        a.hits = (own.userData.events || []).filter((ev) => ev.name === 'hit').map((ev) => ({ t: ev.time, bone: ev.bone || 'RightHand', r: ev.radius || 0.3 }));
        a.cancelAt = Math.max(a.hits.length ? a.hits[a.hits.length - 1].t + 0.12 : 0, own.duration * 0.62);
        a.done = new Set(); a.prevOk = false;
      }
    }
    const P = e.P;
    k.rec = a; k.name = name; k.rate0 = a.rate || 1; k.phase = 'load'; k.holdT = 0; k.cancelled = false; k.ting = false;
    k.hold = k.i === 0 ? this.rng.range(P.wind[0], P.wind[1]) : P.follow;
    k.contact = a.hits && a.hits.length ? a.hits[0].t : a.duration * 0.4;
    k.chamber = Math.min(CHAMBER[name] != null ? CHAMBER[name] : 0.1, k.contact - 0.05);
    a.told = true;                                                   // the tell is ours: at the chamber, not 0.25 s out
    e.velocity.set(0, 0, 0);                                         // the step in comes with the blow, not the wind-up
    this.metrics.attacks++;
    return true;
  },
  setRate(a, r) { a.rate = r; if (a.action) a.action.setEffectiveTimeScale(r); },
  /** the persona moves' numbers go into combat's attack table once (a non-breaking addition: new keys only) */
  ensureMoves(combat) {
    if (this._movesIn || !combat || !combat.ATTACKS) return;
    this._movesIn = true;
    for (const [k, d] of Object.entries(MOVE_DEFS)) if (!combat.ATTACKS[k]) combat.ATTACKS[k] = { ...d };
  },
  tell(e, a, hold, name) {
    const combat = this.combat;
    try {
      if (combat.vfx && combat.vfx.telegraph) combat.vfx.telegraph(e.humanoid, a.hits && a.hits[0] ? a.hits[0].bone : 'RightHand');
      if (combat.rim) combat.rim(e, hold + 0.14);
      if (e.atk && combat.rims) e.atk.rim = combat.rims.find((x) => x.e === e) || null;   // once per tell, not per frame
    } catch (err) { /* vfx are optional */ }
    this.engine.events.emit('combat:telegraph', { attacker: e, name, hold });
  },
  updateAttack(e, dt, player, dist) {
    const k = e.atk, combat = this.combat;
    if (!k) { if (!combat || !combat.isAttacking(e)) this.go(e, 'circle'); return; }
    const a = k.rec;
    const live = combat && combat.activeOf(e) === a;
    if (k.cancelled || !live) {
      if (live) combat.endAttack(a);
      if (!k.cancelled && !a.landed) this.metrics.whiffs++;
      e.atk = null;
      if (!k.cancelled) this.go(e, 'recover');
      return;
    }
    const toX = player.position.x - e.position.x, toZ = player.position.z - e.position.z;
    const P = e.P;
    // the chamber (posed in lateUpdate): builds through the clip's own chamber key, is fully cocked early in the hold
    // and creeps on to the end of it, then unwinds in 80 ms as the clip drives the blow out
    k.coilK = k.phase === 'load' ? 0.4 * clamp(a.t / Math.max(0.02, k.chamber), 0, 1)
      : k.phase === 'hold' ? 0.4 + 0.6 * (1 - Math.pow(1 - clamp(k.holdT / Math.max(0.05, k.hold), 0, 1), 2.5))
        : Math.max(0, (k.coilK || 0) - dt / 0.08);
    if (k.phase === 'load') {
      this.turn(e, Math.atan2(toX, toZ), dt, P.turn * 0.8);
      if (a.t >= k.chamber) {
        k.phase = 'hold'; k.holdYaw = e.yaw;
        this.setRate(a, k.rate0 * HOLD_CREEP);
        this.tell(e, a, k.hold, k.name);
        this.metrics.windups.push(+(k.hold + k.chamber / k.rate0).toFixed(2));
        if (this.metrics.windups.length > 60) this.metrics.windups.shift();
      }
    } else if (k.phase === 'hold') {
      k.holdT += dt;
      // the red rim runs on real time in combat.js, the hold on game time (a hit-stop, a slow frame): keep the rim
      // at its peak for as long as he actually holds, and ring the glint again just before the release
      const r = k.rim && k.rim.e === e && combat.rims && combat.rims.includes(k.rim) ? k.rim : null;
      if (r) { const u = clamp(k.holdT / Math.max(0.05, k.hold), 0, 1); r.life = Math.max(r.life, 0.3); r.t = r.life * 0.375 * Math.min(1, 0.35 + u / 0.3); }
      const late = k.holdT >= k.hold - 0.12;
      if (!k.ting && k.hold > 0.25 && late) {
        k.ting = true;
        try { if (combat.vfx && combat.vfx.telegraph) combat.vfx.telegraph(e.humanoid, a.hits && a.hits[0] ? a.hits[0].bone : 'RightHand'); } catch (err) { /* optional */ }
      }
      // he tracks you through the hold, slowly, and not at all once the second glint has rung: a sidestep beats it
      if (!late) { this.turn(e, Math.atan2(toX, toZ), dt, P.turn * 0.45); k.holdYaw = e.yaw; }
      const reach = this.reachOf(k.name);
      if (P.feint && dist > reach + 1.7) {                           // you walked out of it: he lets it go
        combat.endAttack(a); e.atk = null;
        e.humanoid.play('idle_combat', { fade: 0.18 });
        this.go(e, e.token ? 'engage' : 'recover');
        this.metrics.feints++;
        return;
      }
      if (k.holdT >= k.hold) {
        k.phase = 'strike';
        this.setRate(a, k.rate0 * P.strike);
        // the release commits to where he was aiming: at most 15° of correction (none for the brute), and the step
        // in goes along his own facing, never toward where 健人 has since moved
        const lim = P.commitTurn != null ? P.commitTurn : 0.26;
        e.yaw = k.holdYaw + clamp(wrap(Math.atan2(toX, toZ) - k.holdYaw), -lim, lim); e.group.rotation.y = e.yaw;
        const f = e.forward(_w), along = toX * f.x + toZ * f.z, want = reach - 0.25, run = (MOVE_DEFS[k.name] && MOVE_DEFS[k.name].step) || 0.5;
        if (along > want || run > 0.5) { const s = Math.min(Math.max(along - want, run > 0.5 ? run : 0), run) * 6; e.velocity.set(f.x * s, 0, f.z * s); }
      }
    } else if (k.phase === 'strike') {
      if (a.done && a.done.size && a.t >= k.contact + 0.07 && k.i + 1 < k.chain.length) {
        const down = player.state === 'down' || player.state === 'getup';
        const next = k.chain[k.i + 1];
        if (!down && dist < this.reachOf(next) + 0.55) {
          if (!a.landed) this.metrics.whiffs++;
          k.i++;
          if (!this.startLink(e)) { e.atk = null; this.go(e, 'recover'); }
          return;
        }
        k.chain.length = k.i + 1;                                  // out of reach: the string ends here
      }
    }
  },

  // ------------------------------------------------------------------------------------------------ pose pass
  /** After every module (combat's flinch included), before the frame: the persona's stance height under the library
   *  clips, the wind-up chamber, the armour jolt, the head snap, the lying pose, the foot lock and the clamps.
   *  Each man's skeleton is brought up to date once; every step after that refreshes only the chain it reads (the
   *  renderer recomputes the rest), and parent rotations come straight off matrixWorld. The additive parts run only
   *  on a frame whose mixer ran, or once on a staged still. Nobody is posed past 12 m or off screen. */
  lateUpdate(dt) {
    this.updatePops();
    const edbg = this.engine.params && this.engine.params.raw && this.engine.params.raw.edbg;
    if (edbg === '2' && ((this._dbgN2 = (this._dbgN2 || 0) + 1) % 30) === 0) console.info(`[enemy] f${this._dbgN2} ` + this.list.map((e) => `${e.persona}:${e.state}:${e.humanoid.currentName}:${e.humanoid.currentAction ? e.humanoid.currentAction.getEffectiveWeight().toFixed(2) : '-'}`).join(' '));
    const dbgNow = edbg && !this._dbgOnce && (this._dbgN = (this._dbgN || 0) + 1) > 30;
    const tp0 = edbg === 'perf' ? performance.now() : 0;
    for (const e of this.list) {
      if (e.gone) continue;
      const h = e.humanoid, B = h.bones;
      if (!B || !B.Hips || !B.Hips.parent) continue;
      if (!this.castShot && ((e.camD != null && e.camD > 12) || !this.onScreen(e))) continue;
      try {
        B.Hips.parent.updateWorldMatrix(true, true);
        if (!e.axes) e.axes = boneAxes(h);
        // a staged still (combat preset, enemy_cast, a frozen ring) takes its additive parts once
        const staged = h.frozenPose && h.currentAction && e.stagedAct !== h.currentAction;
        if (staged) e.stagedAct = h.currentAction;
        const add = e.fresh || staged;
        if (e.alive) {
          const k = e.atk;
          if (add) this.liftStance(e);
          if (e.state === 'attack' && k && e.fresh) { if (k.coilK > 0.002) this.applyChamber(e, k.name, k.coilK * (k.i === 0 ? 1 : 0.6), k.phase === 'hold' || k.phase === 'load' ? k.coilK : 0); }
          else if (e.state === 'attack' && staged && !k && CHAMBER_POSE[h.currentName]) this.applyChamber(e, h.currentName, 1, 1);
          if (e.jolt && e.fresh) this.applyJolt(e, dt);
          if (add && e.state === 'hit') this.headSnap(e);
          if (e.fresh) this.footLock(e, dt);
        }
        if (add && (e.state === 'down' || e.state === 'dead')) this.lie(e);
        this.clampPose(e, dt);
        // on the floor he lies ON it (humanoid.floorFit: trunk lifted, a limb under the paving swung up onto it), after
        // the lying variant and the clamps, whatever the clip's generic-rig pelvis height did to this scan
        if ((add || h.frozenPose) && h.floorFit && FLOOR_STATES.has(e.state) && FLOOR_CLIPS_E.has(h.currentName)) h.floorFit();
      } catch (err) { if (!this._poseErr) { this._poseErr = true; console.warn('[enemy] pose pass', err); } }
    }
    if (tp0) {
      const P = this._perf || (this._perf = { t: 0, n: 0 });
      P.t += performance.now() - tp0; P.n++;
      if (P.n === 600) { console.info(`[enemy] pose pass ${(P.t / P.n).toFixed(3)} ms/frame, ${this.list.filter((e) => !e.gone && (e.camD || 99) <= 12).length} men posed`); P.t = 0; P.n = 0; }
    }
    if (dbgNow && edbg !== 'perf') {
      this._dbgOnce = true;
      console.info('[enemy] dbg ' + this.list.map((e) => `${e.persona}:${e.state}:${e.humanoid.currentName}:${e.humanoid.currentAction ? e.humanoid.currentAction.time.toFixed(3) : '-'}:lod${e.humanoid.lodLevel}:cam${(e.camD || 0).toFixed(1)}`).join(' '));
      for (const e of this.list) {
        const B = e.humanoid.bones, P = (n) => B[n].getWorldPosition(new THREE.Vector3()), f = e.forward(new THREE.Vector3());
        const seg = (a, b) => { const d = P(b).sub(P(a)); const up = Math.atan2(Math.hypot(d.x, d.z), d.y) * 57.3, fw = (d.x * f.x + d.z * f.z) >= 0 ? '+' : '-'; return a + '>' + b + ' ' + fw + up.toFixed(0); };
        let fy = '-';
        if (e.axes && this.engine.player) { const q = B.Head.getWorldQuaternion(new THREE.Quaternion()), a = e.axes.faceFwd.clone().applyQuaternion(q), p = this.engine.player.position; const bx = p.x - e.position.x, bz = p.z - e.position.z; fy = (Math.atan2(bx * a.z - bz * a.x, bx * a.x + bz * a.z) * 57.3).toFixed(0) + '/pitch' + (Math.asin(clamp(a.y, -1, 1)) * 57.3).toFixed(0); }
        console.info(`[enemy] face ${e.persona} ${fy}`);
        console.info(`[enemy] tilt ${e.persona} hipsY ${(P('Hips').y - e.position.y).toFixed(2)} headY ${(P('Head').y - e.position.y).toFixed(2)} ` + [['Hips', 'Spine1'], ['Spine1', 'Neck'], ['Neck', 'Head'], ['Hips', 'Head']].map(([a, b]) => seg(a, b)).join(' | '));
      }
    }
  },
  /** The library's fight clips (the punches, the guard, combat's reactions) are built on idle_combat's boxer crouch:
   *  under them the hips come up by the persona's own stance lift, both feet held where the clip planted them */
  liftStance(e) {
    const h = e.humanoid, act = h.currentAction, S = STANCE[e.persona];
    if (!act || !S) return;
    const name = act.getClip().name;
    if (!LIFT_CLIPS.has(name)) return;
    const w = clamp(act.getEffectiveWeight(), 0, 1) * (name.startsWith('cx_hit') || name.startsWith('hit_') ? 0.8 : 1);
    if (w < 0.02) return;
    this.shiftHips(e, _pv.set(0, S.lift * w * e.group.scale.y, 0), 0, null);
  },
  /** move the pelvis by a world offset (and twist it about the vertical), re-solving both legs so the ankles stay where
   *  the clip planted them (`drag`: { leg: 0 | 1, off } moves one planted foot, the rear-foot drag of a wind-up) */
  shiftHips(e, off, twist, drag) {
    const B = e.humanoid.bones, hips = B.Hips;
    LEGS.forEach(([u, l, f], i) => {
      const L = _leg[i];
      L.ankle.setFromMatrixPosition(B[f].matrixWorld); L.knee.setFromMatrixPosition(B[l].matrixWorld); L.hip.setFromMatrixPosition(B[u].matrixWorld);
      worldQ(B[f], L.foot);
      if (drag && drag.leg === i) L.ankle.add(drag.off);
    });
    hips.parent.matrixWorld.decompose(_dv, _qp, _ds);
    hips.position.add(_a.copy(off).applyQuaternion(_qp.invert()).divideScalar(_ds.x || 1));
    hips.updateWorldMatrix(false, false);
    if (twist) rotW(hips, _qc.setFromAxisAngle(UP, twist));
    hips.updateWorldMatrix(false, true);
    LEGS.forEach(([u, l, f], i) => {
      const L = _leg[i];
      _pk.subVectors(L.knee, L.hip);
      ik2(B[u], B[l], B[f], L.ankle, _pk);
      worldQ(B[f].parent, _qp);
      B[f].quaternion.copy(_qp.invert().multiply(L.foot));
      B[f].updateWorldMatrix(false, true);
    });
  },
  /** the full-body wind-up (see CHAMBER_POSE), amt 0..1 of the persona's amplitude; hold 0..1 how far into the hold */
  applyChamber(e, name, amt, hold) {
    const base = CHAMBER_POSE[name], h = e.humanoid, B = h.bones, P = e.P;
    if (!base || !B || !B.Hips || amt < 0.002) return;
    const own = CHAMBER_OWN[e.persona] && CHAMBER_OWN[e.persona][name], spec = own ? { ...base, ...own } : base;
    const s = amt * (P.chamber || 1), dbg = (this.engine.params && this.engine.params.raw) || {};
    const g = h.group, yaw = g.rotation.y, cy = Math.cos(yaw), sy = Math.sin(yaw), sc = g.scale.y;
    _fw.set(sy, 0, cy); _rt.set(-cy, 0, sy);
    const lead = spec.arm === 'Right' ? 'Left' : spec.arm === 'Left' ? 'Right' : null;
    // sit back onto the rear foot, both feet staying where the clip planted them; the brute drags his rear foot back
    // through the hold (the haymaker has to read from 8 m)
    if (spec.hips && !dbg.chnohips) {
      const hx = spec.hips[0] * s * sc, hy = spec.hips[1] * s * sc, hz = spec.hips[2] * s * sc;
      _pv.set(-_rt.x * hx + _fw.x * hz, hy, -_rt.z * hx + _fw.z * hz);
      const drag = spec.drag && hold > 0 ? { leg: spec.arm === 'Left' ? 0 : 1, off: _pd.copy(_fw).multiplyScalar(-spec.drag * Math.min(1, hold) * sc) } : null;
      // the pelvis takes a third of the coil: a jacket is skinned to the hips below the belt, and a chest wrung 40°
      // over a still pelvis shears the cloth between them
      this.shiftHips(e, _pv, dbg.chnotwist ? 0 : spec.twist * s * HIP_TWIST, drag);
    }
    // the guard hand holds its place through the coil (a lead arm carried round by a 40° chest reads as a flail)
    if (lead && B[lead + 'Hand']) { _W2.setFromMatrixPosition(B[lead + 'Hand'].matrixWorld); _E3.setFromMatrixPosition(B[lead + 'ForeArm'].matrixWorld); }
    // the coil: the chest winds away from the blow, leans back off it and drops the lead shoulder
    const twAll = dbg.chnotwist ? 0 : spec.twist * s, tw = twAll * (1 - HIP_TWIST), ln = dbg.chnolean ? 0 : spec.lean * s, rl = dbg.chnolean ? 0 : spec.roll * s;
    for (const [n, w] of SPINE_W) {
      const b = B[n]; if (!b) continue;
      _qc.setFromAxisAngle(UP, tw * w).multiply(_qd.setFromAxisAngle(_rt, ln * w));
      rotW(b, _qc.multiply(_qd.setFromAxisAngle(_fw, rl * w)));
    }
    // the eyes stay on him: the neck and head give back most of the coil, the chin tucks
    if (B.Neck) rotW(B.Neck, _qc.setFromAxisAngle(UP, -twAll * 0.45));
    if (B.Head) rotW(B.Head, _qc.setFromAxisAngle(UP, -twAll * 0.35).multiply(_qd.setFromAxisAngle(_rt, -(spec.tuck || 0) * s - ln * 0.6)));
    if (lead && B[lead + 'Hand']) {
      fresh(B[lead + 'Shoulder'], B[lead + 'Arm'], B[lead + 'ForeArm'], B[lead + 'Hand']);
      _S2.setFromMatrixPosition(B[lead + 'Arm'].matrixWorld);
      ik2(B[lead + 'Arm'], B[lead + 'ForeArm'], B[lead + 'Hand'], _W2, _pk.subVectors(_E3, _S2), 0.85);
    }
    // the striking fist cocked back to its mark in the chest's (coiled) frame
    if (spec.arm && !dbg.chnoarm) {
      const A = spec.arm, sh = B[A + 'Shoulder'];
      fresh(sh, B[A + 'Arm'], B[A + 'ForeArm'], B[A + 'Hand']);
      if (spec.shrug && sh) {                                        // the striking shoulder comes up with the fist
        _a.setFromMatrixPosition(B[A + 'Arm'].matrixWorld).sub(_b.setFromMatrixPosition(sh.matrixWorld));
        _c.crossVectors(_a, UP);
        if (_c.lengthSq() > 1e-8) rotW(sh, _qc.setFromAxisAngle(_c.normalize(), spec.shrug * Math.min(1, amt)));
        fresh(B[A + 'Arm'], B[A + 'ForeArm'], B[A + 'Hand']);
      }
      let side = A === 'Right' ? -1 : 1;
      const cyw = yaw + twAll, fx = Math.sin(cyw), fz = Math.cos(cyw), lx = Math.cos(cyw), lz = -Math.sin(cyw);
      let [ox, oy, oz] = spec.hand;
      const back = oz < 0 && !(own && own.hand) ? oz * (P.chamber || 1) : oz;
      // a fist cocked on the far side of him from the lens is hidden by his own chest: the smaller wind-ups come
      // across to the lens side and up, the brute's haymaker goes higher and wider
      const cam = this.engine.camera;
      if (cam) {
        _c.setFromMatrixPosition(B.Spine2.matrixWorld);
        const vx = _c.x - cam.position.x, vz = _c.z - cam.position.z, vl = Math.hypot(vx, vz) || 1;
        const far = (lx * side * vx + lz * side * vz) / vl;           // > 0: the striking side faces away from the lens
        if (far > 0.3) {
          const k = smooth(0.3, 0.6, far);
          if (spec.cross) { side = -side * (k > 0.5 ? 1 : -1); ox *= 0.6; oy += 0.07 * k; }
          else { ox += 0.06 * k; oy += 0.08 * k; }
        }
      }
      B[spec.from].updateWorldMatrix(false, false);
      _pl.setFromMatrixPosition(B[spec.from].matrixWorld);
      _pl.x += (lx * side * ox + fx * back) * sc; _pl.y += oy * sc; _pl.z += (lz * side * ox + fz * back) * sc;
      const [px, py, pz] = spec.pole;
      _pk.set(lx * side * px + fx * pz, py, lz * side * px + fz * pz);
      ik2(B[A + 'Arm'], B[A + 'ForeArm'], B[A + 'Hand'], _pl, _pk, Math.min(1, amt));
    }
  },
  /** Foot lock. The stance clips plant a foot exactly for the generic rig they were solved on; on a scan's own leg
   *  lengths the same rotations walk the ankle a few centimetres per step. While a stance clip says a foot is down,
   *  its ankle is held where it landed (two-bone IK, the clip's foot orientation kept), and eased off at lift-off. */
  footLock(e, dt) {
    const h = e.humanoid, B = h.bones, act = h.currentAction, L = e.lock || (e.lock = [{ on: false, w: 0, pos: new THREE.Vector3() }, { on: false, w: 0, pos: new THREE.Vector3() }]);
    const stance = act && h.currentName && h.currentName.startsWith('es_') && act.getEffectiveWeight() > 0.5;
    let u = -1;
    if (stance) { const T = act.getClip().duration; u = (act.time % T) / T; }
    for (let i = 0; i < 2; i++) {
      const F = L[i], ph = u < 0 ? -1 : (u + (i ? 0.5 : 0)) % 1;
      const down = ph >= 0.02 && ph < STANCE_F - 0.03;
      const [up, mid, end] = LEGS[i];
      if (down && !F.on) { F.on = true; F.pos.setFromMatrixPosition(B[end].matrixWorld); }
      if (!down) F.on = false;
      F.w = clamp(F.w + (F.on ? dt / 0.05 : -dt / 0.08), 0, 1);
      if (F.w <= 0.001) continue;
      worldQ(B[end], _qs1); _qt.copy(_qs1);
      _pk.setFromMatrixPosition(B[mid].matrixWorld).sub(_S2.setFromMatrixPosition(B[up].matrixWorld));
      ik2(B[up], B[mid], B[end], F.pos, _pk, F.w);
      worldQ(B[end].parent, _qp);
      B[end].quaternion.copy(_qp.invert().multiply(_qt));
      B[end].updateWorldMatrix(false, true);
    }
  },
  /** the brute's armour: a light blow that does not stop his swing still jolts his chest and head 8° off it */
  applyJolt(e, dt) {
    const J = e.jolt, B = e.humanoid.bones;
    J.t += dt;
    const u = J.t / 0.12;
    if (u >= 1 || !B.Spine2) { e.jolt = null; return; }
    const a = Math.sin(Math.PI * u) * 0.14;
    rotW(B.Spine2, _qc.setFromAxisAngle(J.axis, a * 0.6));
    if (B.Neck) rotW(B.Neck, _qc.setFromAxisAngle(J.axis, a * 0.4));
  },
  /** A head blow: the head goes where the fist was going. For the first 0.12 s of combat's head reaction the neck and
   *  head snap ~30° along the blow (about up x blow, like combat's flinch but on the head, where the blow landed), and
   *  whatever the clip and the flinch do to the waist, the torso never folds more than 30° toward the puncher: the
   *  face stays up at fist height instead of dropping under it. */
  headSnap(e) {
    const h = e.humanoid, act = h.currentAction, B = h.bones;
    if (!act || !B.Neck) return;
    const name = act.getClip().name;
    if (!name.startsWith('cx_hit_head')) return;
    const t = act.time;
    const d = _pd;
    const lh = e.lastHit;
    if (lh && lh.dir && this.now - lh.t < 0.4) d.copy(lh.dir).setY(0);
    else {                                                            // across, the way the clip throws the head (a hook's path), a little back
      const yaw = e.group.rotation.y, sgn = name.endsWith('_r') ? -1 : 1;
      d.set(Math.cos(yaw) * sgn * 0.92 - Math.sin(yaw) * 0.35, 0, -Math.sin(yaw) * sgn * 0.92 - Math.cos(yaw) * 0.35);
    }
    if (d.lengthSq() < 1e-6) return;
    d.normalize();
    // the fold cap
    fresh(B.Spine, B.Spine1, B.Spine2, B.Neck);
    _a.setFromMatrixPosition(B.Neck.matrixWorld).sub(_b.setFromMatrixPosition(B.Hips.matrixWorld));
    const f = e.forward(_fw), lean = Math.atan2(_a.x * f.x + _a.z * f.z, _a.y);
    if (lean > 0.52) {
      _c.crossVectors(f, UP).normalize();
      rotW(B.Spine, _qc.setFromAxisAngle(_c, lean - 0.52));
      fresh(B.Spine1, B.Spine2, B.Neck);
    }
    if (t < 0.13) {
      const a = Math.sin(Math.PI * clamp(t / 0.12, 0, 1)) * 0.52;
      _c.crossVectors(UP, d).normalize();
      rotW(B.Neck, _qc.setFromAxisAngle(_c, a * 0.4));
      if (B.Head) rotW(B.Head, _qc.setFromAxisAngle(_c, a * 0.6));
    }
    // the reaction twists hips, chest, neck and head all the same way: past ~45° from the man who hit him the face
    // is gone and the lens is left with the back of a skull. The neck and head give the excess back.
    const p = this.engine.player, X = e.axes;
    if (p && X && B.Head) {
      worldQ(B.Head, _qp); _a.copy(X.faceFwd).applyQuaternion(_qp).setY(0);
      const src = this.castShot || p.position.distanceToSquared(e.position) > 9 ? this.engine.camera.position : p.position;   // (a review still: the lens)
      _b.set(src.x - e.position.x, 0, src.z - e.position.z);
      if (_a.lengthSq() > 1e-6 && _b.lengthSq() > 1e-6) {
        _a.normalize(); _b.normalize();
        const ang = Math.atan2(_b.x * _a.z - _b.z * _a.x, _b.x * _a.x + _b.z * _a.z), over = Math.abs(ang) - 0.8;
        if (over > 0) {
          const back = Math.sign(ang) * over;                        // turn the face back toward him
          rotW(B.Neck, _qc.setFromAxisAngle(UP, back * 0.5)); rotW(B.Head, _qc.setFromAxisAngle(UP, back * 0.5));
        }
      }
      // and the chin comes up off the chest: a snapped head looks up and away, never down into his own collar
      worldQ(B.Head, _qp); _a.copy(X.faceFwd).applyQuaternion(_qp);
      const pitch = Math.asin(clamp(_a.y, -1, 1));
      if (pitch < 0) { _c.crossVectors(_a, UP); if (_c.lengthSq() > 1e-6) rotW(B.Head, _qc.setFromAxisAngle(_c.normalize(), -pitch)); }
    }
  },
  /** On the floor each persona lies his own way, eased in as the knockdown lands: the brute flat on his back with an
   *  arm flung out, the 兄貴分 rolled onto his side, the 半グレ curled up; and every one of them turns his face to the
   *  lens, so the body reads as a man and not a sack */
  lie(e) {
    const h = e.humanoid, act = h.currentAction, B = h.bones, X = e.axes, V = LIE[e.persona];
    if (!act || !V || !X) return;
    const name = act.getClip().name, still = h.frozenPose;
    const u = name === 'knockdown' ? (still ? smooth(0.35, 0.7, act.time / act.getClip().duration) : smooth(0.45, 0.95, act.time / act.getClip().duration)) : name === 'dead' ? 1 : 0;
    if (u < 0.01) return;
    // a staged still lays him across the lens with his head away from 健人 (a live fall lands where the blow sent it)
    const cam = this.engine.camera, p = this.engine.player;
    if (still && cam && p && !e.castPose) {
      _a.set(e.position.x - cam.position.x, 0, e.position.z - cam.position.z).normalize();
      _b.set(-_a.z, 0, _a.x);
      if (_b.x * (e.position.x - p.position.x) + _b.z * (e.position.z - p.position.z) < 0) _b.negate();
      e.yaw = Math.atan2(-_b.x, -_b.z); e.group.rotation.y = e.yaw;
      e.group.updateMatrixWorld(true);
    }
    fresh(B.Spine, B.Spine1, B.Spine2);
    // the body's own frame as it lies: long axis (hips to chest), chest normal, and his left
    _y.setFromMatrixPosition(B.Spine2.matrixWorld).sub(_b.setFromMatrixPosition(B.Hips.matrixWorld)).normalize();
    worldQ(B.Spine2, _qp); _z.copy(X.chestFwd).applyQuaternion(_qp);
    _z.addScaledVector(_y, -_z.dot(_y)).normalize();
    _x.crossVectors(_y, _z);
    if (V.roll) { rotW(B.Spine, _qc.setFromAxisAngle(_y, V.roll * u)); B.Spine.updateWorldMatrix(false, true); }
    if (V.curl) {
      for (const n of ['Spine', 'Spine1']) { rotW(B[n], _qc.setFromAxisAngle(_x, V.curl * u * 0.5)); }
      B.Spine.updateWorldMatrix(false, true);
      for (const [up, lo] of [['LeftUpLeg', 'LeftLeg'], ['RightUpLeg', 'RightLeg']]) {
        rotW(B[up], _qc.setFromAxisAngle(_x, V.knees * u)); fresh(B[lo]);
        rotW(B[lo], _qc.setFromAxisAngle(_x, -V.knees * 1.4 * u));
        B[up].updateWorldMatrix(false, true);
      }
    }
    for (const [sd, sg] of [['Left', 1], ['Right', -1]]) {
      const a = V[sd]; if (!a) continue;
      fresh(B[sd + 'Shoulder'], B[sd + 'Arm']);
      // out along the ground (about the chest normal) and / or in over the chest (about the long axis)
      if (a[0]) rotW(B[sd + 'Arm'], _qc.setFromAxisAngle(_z, a[0] * sg * u));
      if (a[1]) rotW(B[sd + 'Arm'], _qc.setFromAxisAngle(_y, a[1] * sg * u));
      if (a[2]) { fresh(B[sd + 'ForeArm']); rotW(B[sd + 'ForeArm'], _qc.setFromAxisAngle(_z, a[2] * sg * u)); }
      B[sd + 'Arm'].updateWorldMatrix(false, true);
    }
    // an unconscious arm falls: no upper arm or forearm is left pointing at the sky
    for (const sd of ['Left', 'Right']) {
      for (const [bn, cn] of [[sd + 'Arm', sd + 'ForeArm'], [sd + 'ForeArm', sd + 'Hand']]) {
        fresh(B[bn], B[cn]);
        _a.setFromMatrixPosition(B[cn].matrixWorld).sub(_b.setFromMatrixPosition(B[bn].matrixWorld)).normalize();
        if (_a.y > 0.15) {
          _c.crossVectors(_a, UP);
          if (_c.lengthSq() > 1e-6) rotW(B[bn], _qc.setFromAxisAngle(_c.normalize(), -(Math.asin(_a.y) + 0.05) * u));
          B[bn].updateWorldMatrix(false, true);
        }
      }
    }
    // the face to the lens (neck 40 %, head 60 %, at most 70°)
    if (cam && B.Head) {
      fresh(B.Neck, B.Head);
      worldQ(B.Head, _qp); _a.copy(X.faceFwd).applyQuaternion(_qp);
      _b.setFromMatrixPosition(B.Head.matrixWorld); _c.subVectors(cam.position, _b).normalize();
      const ang = Math.acos(clamp(_a.dot(_c), -1, 1));
      _dx.crossVectors(_a, _c);
      if (ang > 0.05 && _dx.lengthSq() > 1e-8) {
        _dx.normalize();
        const k = Math.min(ang, 1.2) * u;
        rotW(B.Neck, _qc.setFromAxisAngle(_dx, k * 0.4)); rotW(B.Head, _qc.setFromAxisAngle(_dx, k * 0.6));
      }
    }
  },
  /** The scans tear when the neck or the chest is wrung past ~35°, and a scan's flank is skinned to the arm that hung
   *  beside it: a reaction that throws the arms out wide drags the jacket's side out with them as a cape. So the neck,
   *  chest and head are held near bind, and while he reels or gets up his upper arms stay near his flanks (the forward
   *  reach of a guard is untouched). A head blow lets both go for its first 0.15 s — the arms fly, the head whips —
   *  and takes them back over the next 0.15. On the floor only an arm driven into his own torso is stopped: the rest
   *  splay. */
  clampPose(e, dt) {
    const R = this.anim && this.anim.RIG, h = e.humanoid, B = h.bones, X = e.axes;
    if (!R || !R.local || !B) return;
    const act = h.currentAction, clip = act ? act.getClip().name : '';
    const head = e.state === 'hit' && clip.startsWith('cx_hit_head') ? act.time : -1;
    const free = head >= 0 ? 1 - smooth(0.15, 0.3, head) : 0;          // 1: the head blow's first 0.15 s
    const lim = 0.61 + (0.9 - 0.61) * free;
    clampBone(B.Neck, R.local.Neck && R.local.Neck.quaternion, lim);
    clampBone(B.Spine2, R.local.Spine2 && R.local.Spine2.quaternion, lim);
    clampBone(B.Head, R.local.Head && R.local.Head.quaternion, 0.8 + 0.2 * free);
    const floor = e.state === 'down' || e.state === 'dead';
    const W = e.armW || (e.armW = { Left: 0, Right: 0 });
    const k = Math.min(1, (dt || 0.016) / 0.15);
    const want = REEL.has(e.state) ? 1 - free : 0;
    let any = floor;
    for (const sd of ['Left', 'Right']) {
      W[sd] += (want - W[sd]) * (e.fresh || !dt ? k : 1);
      if (head >= 0 && head < 0.15) W[sd] = Math.min(W[sd], want);
      if (W[sd] > 0.01) any = true;
    }
    if (!any || !B.Spine2 || !B.LeftArm || !X) return;
    B.Spine2.updateWorldMatrix(false, false);
    worldQ(B.Spine2, _qc);
    const down = _y.copy(X.chestDown).applyQuaternion(_qc), left = _x.copy(X.chestLeft).applyQuaternion(_qc), fwd = _z.copy(X.chestFwd).applyQuaternion(_qc);
    const maxA = e.P.armClamp ? e.P.armClamp[0] : 0.56, maxE = e.P.armClamp ? e.P.armClamp[1] : 0.96;
    for (const [sd, sg] of [['Left', 1], ['Right', -1]]) {
      const arm = sd + 'Arm', fore = sd + 'ForeArm';
      fresh(B[sd + 'Shoulder'], B[arm], B[fore]);
      _S.setFromMatrixPosition(B[arm].matrixWorld); _E.setFromMatrixPosition(B[fore].matrixWorld);
      _u.subVectors(_E, _S).normalize();
      if (floor) {                                                    // only through himself: into the chest's back half
        const f = _u.dot(fwd);
        if (f < -0.05) { _a.copy(_u).addScaledVector(fwd, -f - 0.05).normalize(); rotW(B[arm], _qr.setFromUnitVectors(_u, _a)); }
        continue;
      }
      const w = W[sd]; if (w <= 0.01) continue;
      const d = _u.dot(down), l = _u.dot(left) * sg, f = _u.dot(fwd);
      const a = Math.atan2(l, d);
      if (a > maxA) {
        const r = Math.hypot(d, l);
        _a.copy(down).multiplyScalar(r * Math.cos(maxA)).addScaledVector(left, sg * r * Math.sin(maxA)).addScaledVector(fwd, f).normalize();
        rotW(B[arm], _qr.setFromUnitVectors(_u, _a.lerp(_u, 1 - w).normalize()));
        fresh(B[fore]); _E.setFromMatrixPosition(B[fore].matrixWorld); _u.subVectors(_E, _S).normalize();
      }
      // and no higher than maxE off the flank in any direction: a reeling man's arms drop, a jacket's side stays on
      const el = Math.acos(clamp(_u.dot(down), -1, 1));
      if (el > maxE) {
        _c.crossVectors(down, _u);
        if (_c.lengthSq() > 1e-8) rotW(B[arm], _qr.setFromAxisAngle(_c.normalize(), (maxE - el) * w));
      }
    }
  },
  cancelAttack(e) {
    const combat = this.engine.get('combat');
    const a = combat && combat.activeOf ? combat.activeOf(e) : null;
    if (a && combat.endAttack) combat.endAttack(a);
    e.atk = null;
  },

  // ------------------------------------------------------------------------------------------------ guard / counter
  /** the guard reads the string: when 健人 starts a swing his way, he gets his arms up (once per swing) */
  guardCheck(e, player, dist) {
    const P = e.P, combat = this.combat;
    // (a man walking in with the token still gets his arms up; one already throwing does not)
    if (!P.block || e.guardBroken > 0 || e.state === 'guard' || e.state === 'attack' || !combat || !combat.activeOf) return;
    const pa = combat.activeOf(player);
    if (!pa || pa === e.seenSwing) return;
    e.seenSwing = pa;
    if (dist > 2.6) return;
    const f = player.forward(_w);
    const dx = e.position.x - player.position.x, dz = e.position.z - player.position.z;
    if ((f.x * dx + f.z * dz) / dist < 0.55 && pa.target !== e) return;
    const p = P.block * (e.lastHit && this.now - e.lastHit.t < 2.5 ? 1.35 : 1);
    if (this.rng() < p) { this.go(e, 'guard'); e.guardUntil = this.now + 0.9; }
  },
  canCounter(e) {
    const D = this.director;
    return (e.token || D.holders.length < D.max) && e.cooldown < 1.5;
  },
  counterAttack(e) {
    const D = this.director;
    e.counter = false;
    if (!e.token) { e.token = true; D.holders.push(e); }
    this.bark(e, 'counter');
    const plan = [e.P.counter[Math.floor(this.rng() * e.P.counter.length)]];
    if (!this.startCombo(e, plan)) { this.dropToken(e); return false; }
    e.atk.hold = 0.22;                                              // a counter is quick, but it is still read
    this.metrics.counters++;
    return true;
  },

  // ------------------------------------------------------------------------------------------------ movement
  separate(e, want, player, dist) {
    const engaging = e.state === 'engage';
    for (const o of this.list) {
      if (o === e || !o.alive || o.state === 'down') continue;
      const dx = e.position.x - o.position.x, dz = e.position.z - o.position.z, d = Math.hypot(dx, dz);
      if (d >= SEP || d < 1e-3) continue;
      const k = (SEP - d) * (engaging ? 1.4 : 2.6);
      want.x += dx / d * k; want.z += dz / d * k;
      // the man stepping in slides round the one in his way instead of shoving through him
      if (engaging && d < 1.2) {
        const side = (dx * (player.position.z - e.position.z) - dz * (player.position.x - e.position.x)) > 0 ? 1 : -1;
        want.x += -dz / d * side * 0.9; want.z += dx / d * side * 0.9;
      }
    }
    if (e.state !== 'engage' && e.state !== 'attack' && dist < 1.15) {
      const k = (1.15 - dist) * 3;
      want.x -= (player.position.x - e.position.x) / dist * k; want.z -= (player.position.z - e.position.z) / dist * k;
    }
  },
  steer(e, want, dt) {
    const k = Math.min(1, dt * 7);
    e.mv.x += (want.x - e.mv.x) * k; e.mv.z += (want.z - e.mv.z) * k;
    const sp = Math.hypot(e.mv.x, e.mv.z);
    if (sp < 0.03) { e.stuckT = 0; return; }
    const x0 = e.position.x, z0 = e.position.z;
    this.move(e, _d.set(e.mv.x * dt, 0, e.mv.z * dt));
    const moved = Math.hypot(e.position.x - x0, e.position.z - z0), meant = sp * dt;
    if (meant > 0.004 && moved < meant * 0.35) e.stuckT += dt; else e.stuckT = Math.max(0, e.stuckT - dt * 2);
  },
  turn(e, target, dt, rate) {
    const d = wrap(target - e.yaw);
    e.yaw += clamp(d, -rate * dt, rate * dt);
    e.group.rotation.y = e.yaw;
  },
  move(e, delta) {
    const world = this.engine.world;
    if (world) { const p = world.moveCapsule(e.position, e.radius, e.height, delta); e.position.set(p.x, p.y, p.z); }
    else e.position.add(delta);
    const gy = world ? world.groundHeight(e.position.x, e.position.z) : 0;
    e.position.y += (gy - e.position.y) * 0.5;
    e.group.rotation.y = e.yaw;
  },
  applyVelocity(e, dt) {
    if (e.velocity.lengthSq() > 1e-4) { this.move(e, _d.copy(e.velocity).multiplyScalar(dt)); e.velocity.multiplyScalar(Math.max(0, 1 - dt * 6)); }
    else e.group.rotation.y = e.yaw;
  },

  // ------------------------------------------------------------------------------------------------ animation
  /** stance locomotion: per persona, two stride sets x eight directions (es_<p><f|s><k>). The upper body is
   *  idle_combat itself, sampled per key over the step cycle (so the breathing and the bounce survive the move),
   *  with the shoulders counter-rotating against the hips, the fists bobbing a beat behind and the head held level;
   *  the feet step along the travel direction with the planted one locked to the ground at the set's speed */
  buildClips() {
    if (this.clips) return this.clips;
    this.clips = {};
    const A = this.anim;
    if (!A || !A.makeClip || !A.getFrames || !A.CH) return this.clips;
    const C0 = poseAt(A, 'idle_combat', 0);
    if (!C0 || !C0.ikL || !C0.ikR) return this.clips;
    const add = (a, d) => [(a ? a[0] : 0) + d[0], (a ? a[1] : 0) + d[1], (a ? a[2] : 0) + d[2]];
    const ICD = (A.DURATIONS && A.DURATIONS.idle_combat) || 1.4, CP = {};
    for (const pk of Object.keys(GAIT)) {
      // the persona's idle: idle_combat's own breathing keys, re-stanced
      const C = CP[pk] = stanceOf(pk, C0), keys = [];
      for (let i = 0; i <= 8; i++) keys.push({ t: (i / 8) * ICD, pose: i === 8 ? keys[0].pose : stanceOf(pk, poseAt(A, 'idle_combat', i / 8)) });
      this.clips['ei_' + pk[0]] = A.makeClip('ei_' + pk[0], keys, { loop: true });
    }
    for (const [pk, G] of Object.entries(GAIT)) {
      const C = CP[pk];
      for (const [set, V] of [['f', STANCE_V], ['s', STANCE_VS]]) {
        const T = G.T, n = Math.round(T * 60), half = V * STANCE_F * T / 2, lift = set === 'f' ? 0.06 : 0.035;
        const foot = (ik, ph, dx, dz) => {
          let off, up = 0;
          if (ph < STANCE_F) off = half - (ph / STANCE_F) * 2 * half;
          else { const q = (ph - STANCE_F) / (1 - STANCE_F), sm = q * q * (3 - 2 * q); off = -half + sm * 2 * half; up = Math.sin(Math.PI * q); }
          return [ik[0] + dx * off, ik[1] + lift * up, ik[2] + dz * off, ik[3] - 7 * up, ik[4]];
        };
        for (let k = 0; k < 8; k++) {
          const ang = k * Math.PI / 4, dx = Math.sin(ang), dz = Math.cos(ang), keys = [];
          const kv = set === 'f' ? 1 : 0.6;                                   // a drift is a quieter step
          for (let i = 0; i <= n; i++) {
            const u = i / n, pose = stanceOf(pk, poseAt(A, 'idle_combat', u % 1)) || { ...C };
            pose.ikL = foot(C.ikL, u % 1, dx, dz);
            pose.ikR = foot(C.ikR, (u + 0.5) % 1, dx, dz);
            const dip = 0.5 + 0.5 * Math.cos(4 * Math.PI * (u - 0.05));      // lowest in double support
            const sway = Math.sin(2 * Math.PI * (u - 0.05));                  // over the planted foot
            const bob = Math.sin(4 * Math.PI * (u + 0.2));                    // off the toes, twice a cycle
            const hp = pose.hips || C.hips || [0, 0, 0];
            // the planted leg needs reach to hold the ground: a fast shuffle gives back half of the stance's lift
            const give = (STANCE[pk] ? STANCE[pk].lift : 0) * (set === 'f' ? 0.55 : 0.15);
            pose.hips = [hp[0] + G.sway * sway * kv, hp[1] - give - (G.dip * dip + G.bounce * (0.5 + 0.5 * bob)) * kv, hp[2] + 0.02 * dz * kv];
            const hy = 4 * sway * kv, sy = -G.counter * sway * kv, lean = 3 * dz * kv, side = -2 * dx * kv;
            pose.Hips = add(pose.Hips, [0, hy, 0]);
            pose.Spine = add(pose.Spine, [lean, -1.5 * sway * kv, side]);
            pose.Spine1 = add(pose.Spine1, [0, 1.5 * sway * kv, 0]);
            pose.Spine2 = add(pose.Spine2, [0, sy, 0]);
            // the head stays level and on him: give back the chain's yaw, pitch and roll
            pose.Neck = add(pose.Neck, [-lean * 0.7, -(hy + sy) * 0.8, -side * 0.7]);
            const fb = G.fist * Math.sin(2 * Math.PI * (u - 0.1)) * kv;
            pose.LeftArm = add(pose.LeftArm, [fb, 0, 0]);
            pose.RightArm = add(pose.RightArm, [G.fist * Math.sin(2 * Math.PI * (u - 0.1) + Math.PI) * kv, 0, 0]);
            keys.push({ t: u * T, pose });
          }
          const name = 'es_' + pk[0] + set + k;
          const clip = A.makeClip(name, keys, { loop: true, fps: 60 });
          clip.userData.stance = { speed: V, dir: k, persona: pk };
          this.clips[name] = clip;
        }
      }
    }
    try { this.buildMoves(A, CP); } catch (err) { console.warn('[enemy] persona moves', err); }
    return this.clips;
  },
  /** Each persona's own two moves, so the three stop fighting like palette swaps of 健人's rush string. Keys are
   *  the library's own poses (idle guard, hook, jab, straight, kick, grab) re-timed and pushed: a looping haymaker
   *  with a lunge and a shoulder tackle for the brute, a flailing slap string and a low kick for the coward, a knee
   *  from the clinch and a collar-grab headbutt for the guard. The wind-up of each is posed by CHAMBER_POSE. */
  buildMoves(A, CP) {
    for (const pk of Object.keys(CP)) this.buildPersonaMoves(A, CP[pk], pk);
  },
  buildPersonaMoves(A, C, pk) {
    const at = (clip, t) => poseAt(A, clip, t / ((A.DURATIONS && A.DURATIONS[clip]) || A.getFrames(clip)[A.getFrames(clip).length - 1].t)) || { ...C };
    const add = (p, d) => { const o = { ...p }; for (const k in d) o[k] = (k === 'ikL' || k === 'ikR') ? d[k] : [(p[k] ? p[k][0] : 0) + d[k][0], (p[k] ? p[k][1] : 0) + d[k][1], (p[k] ? p[k][2] : 0) + d[k][2]]; return o; };
    const set = (p, d) => { const o = { ...p }; for (const k in d) o[k] = d[k]; return o; };
    const step = (ik, dz, dx = 0) => [ik[0] + dx, ik[1], ik[2] + dz, ik[3], ik[4]];
    const lunge = (p, k) => add(p, { hips: [0, -0.04 * k, 0.14 * k], Spine: [12 * k, 0, 0], Spine1: [6 * k, 0, 0], ikL: step(C.ikL, 0.2 * k) });
    const ARM = ['LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand'];
    const armsOf = (p) => { const o = {}; for (const k of ARM) if (p[k]) o[k] = p[k]; return o; };
    const arms = armsOf(at('grab', 0.3)), guardArms = armsOf(at('guard', 0));
    // a right leg driven by FK drops the stance's IK target for it (as animations' mix() does)
    const kneeUp = (p, up, leg) => { const o = { ...p, RightUpLeg: [up, 0, 6], RightLeg: [leg, 0, 0], RightFoot: [10, 0, 0] }; delete o.ikR; return o; };
    const M = {
      // brute: a looping haymaker from behind the ear, and he steps through it
      brute_haymaker: { keys: [
        { t: 0, pose: C }, { t: 0.18, pose: add(at('hook', 0.12), { Spine: [-4, 6, 0], Spine1: [0, 6, 0] }) },
        { t: 0.36, pose: lunge(add(at('hook', 0.27), { RightArm: [-12, 0, 0], Spine1: [4, 0, 0] }), 1) },
        { t: 0.46, pose: lunge(add(at('hook', 0.34), { Spine: [6, 0, 0] }), 1.05) },
        { t: 0.62, pose: lunge(at('hook', 0.42), 0.7) }, { t: 0.85, pose: C }],
        hit: [0.36, 'RightHand', 0.34] },
      // brute: head down, right shoulder presented, and he runs through you
      brute_tackle: { keys: [
        { t: 0, pose: C },
        { t: 0.22, pose: add(set(C, guardArms), { hips: [0, -0.16, -0.06], Hips: [0, -14, 0], Spine: [20, -14, 0], Spine1: [10, -8, 0], Neck: [-14, 8, 0], Head: [-12, 8, 0] }) },
        { t: 0.38, pose: add(set(C, guardArms), { hips: [0, -0.14, 0.28], Hips: [0, -28, 0], Spine: [26, -18, 0], Spine1: [12, -10, 0], Neck: [-16, 12, 0], Head: [-14, 12, 0], ikL: step(C.ikL, 0.36), ikR: step(C.ikR, 0.1) }) },
        { t: 0.52, pose: add(C, { hips: [0, -0.12, 0.3], Hips: [0, -22, 0], Spine: [18, -12, 0], ikL: step(C.ikL, 0.36), ikR: step(C.ikR, 0.12) }) },
        { t: 0.85, pose: C }],
        hit: [0.38, 'RightArm', 0.42] },
      // coward: three wild open-hand swipes, arms wide, body swaying behind them
      coward_slaps: { keys: [
        { t: 0, pose: C }, { t: 0.05, pose: at('straight', 0.09) },
        { t: 0.14, pose: add(at('straight', 0.2), { RightArm: [0, 0, 16], Spine1: [0, 6, 0] }) },
        { t: 0.24, pose: add(at('jab', 0.06), { Spine1: [0, -6, 0] }) },
        { t: 0.33, pose: add(at('jab', 0.16), { LeftArm: [6, 0, 22], Spine1: [0, -10, 0], Head: [0, -6, 0] }) },
        { t: 0.43, pose: at('hook', 0.14) }, { t: 0.52, pose: add(at('hook', 0.27), { RightArm: [8, 0, 0] }) },
        { t: 0.8, pose: C }],
        hit: [[0.14, 'RightHand', 0.26], [0.33, 'LeftHand', 0.26], [0.52, 'RightHand', 0.28]] },
      // coward: a low stamping kick at the knee, leaning well away from it
      coward_lowkick: { keys: [
        { t: 0, pose: C }, { t: 0.14, pose: add(at('kick', 0.15), { RightUpLeg: [-30, 0, 0], Spine: [-6, 0, 0] }) },
        { t: 0.28, pose: add(at('kick', 0.3), { RightUpLeg: [-38, 0, 12], RightLeg: [0, 0, 0], RightFoot: [-10, 0, 0], Hips: [0, 14, 0], Spine: [-8, 0, 0] }) },
        { t: 0.4, pose: add(at('kick', 0.42), { RightUpLeg: [-30, 0, 0] }) }, { t: 0.62, pose: C }],
        hit: [0.28, 'RightFoot', 0.3] },
      // guard: hands on the collar, then the knee comes up into the gut
      guard_knee: { keys: [
        { t: 0, pose: C }, { t: 0.14, pose: add(set(C, arms), { hips: [0, -0.02, 0.06], Spine: [8, 0, 0] }) },
        { t: 0.28, pose: add(kneeUp(set(C, arms), 104, -118), { hips: [0.02, 0.0, 0.1], Spine: [4, 0, 0], Spine1: [-4, 0, 0], ikL: step(C.ikL, 0.02) }) },
        { t: 0.38, pose: add(kneeUp(set(C, arms), 90, -112), { hips: [0.02, -0.02, 0.08] }) },
        { t: 0.62, pose: C }],
        hit: [0.28, 'RightLeg', 0.3] },
      // guard: grabs the lapels, rears his head back and drives his forehead in
      guard_headbutt: { keys: [
        { t: 0, pose: C }, { t: 0.2, pose: add(set(C, arms), { hips: [0, -0.03, 0.08], Spine: [6, 0, 0] }) },
        { t: 0.34, pose: add(set(C, arms), { hips: [0, -0.02, 0.04], Spine: [-8, 0, 0], Spine1: [-6, 0, 0], Neck: [-14, 0, 0], Head: [-16, 0, 0] }) },
        { t: 0.44, pose: add(set(C, arms), { hips: [0, -0.05, 0.14], Spine: [18, 0, 0], Spine1: [10, 0, 0], Neck: [20, 0, 0], Head: [22, 0, 0] }) },
        { t: 0.56, pose: add(set(C, arms), { hips: [0, -0.04, 0.12], Spine: [12, 0, 0], Neck: [10, 0, 0], Head: [8, 0, 0] }) },
        { t: 0.8, pose: C }],
        hit: [0.44, 'Head', 0.26] },
    };
    for (const [name, m] of Object.entries(M)) {
      if (!name.startsWith(pk + '_')) continue;
      const hits = Array.isArray(m.hit[0]) ? m.hit : [m.hit];
      const clip = A.makeClip(name, m.keys, { events: hits.map(([time, bone, radius]) => ({ time, name: 'hit', bone, radius })) });
      this.clips[name] = clip;
    }
  },
  /** which stride set and at what rate for a body moving at sp m/s: the planted foot then travels exactly sp */
  stanceFor(sp) {
    return sp < STANCE_SLOW ? { set: 's', ts: clamp(sp / STANCE_VS, 0.5, 1.6) } : { set: 'f', ts: clamp(sp / STANCE_V, STANCE_SLOW, 1.7) };
  },
  play(e, name, speed = 1, fade = 0.2) {
    const h = e.humanoid;
    if (h.frozenPose) return null;
    let act;
    const clip = name.startsWith('es_') && this.clips ? this.clips[name] : null;
    if (clip) {
      if (h.currentName !== name) {
        const prev = h.currentAction, keep = prev && h.currentName && h.currentName.startsWith('es_');
        act = playLoop(h, clip, fade);
        if (keep) act.time = prev.time % clip.duration;             // same gait period: the feet stay in phase
      } else act = h.currentAction;
    } else act = h.play(name.startsWith('es_') ? 'idle_combat' : name, { fade });
    if (act && speed !== act.getEffectiveTimeScale()) act.setEffectiveTimeScale(speed);
    return act;
  },
  animate(e, faceMove, guard) {
    const sp = Math.hypot(e.mv.x, e.mv.z);
    if (guard) { this.play(e, 'guard'); return; }
    if (sp < 0.16) { this.play(e, 'idle_combat'); e.sector = -1; return; }
    if (faceMove) {
      const run = sp > 3.2;
      this.play(e, run ? 'run' : 'walk', clamp(sp / (run ? 5.6 : 2.4), 0.6, 1.5));
      e.sector = -1;
      return;
    }
    const c = Math.cos(e.yaw), s = Math.sin(e.yaw);
    const lx = e.mv.x * c - e.mv.z * s, lz = e.mv.x * s + e.mv.z * c;
    const ang = Math.atan2(lx, lz);
    let k = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
    if (e.sector >= 0 && k !== e.sector && Math.abs(wrap(ang - e.sector * Math.PI / 4)) < Math.PI / 8 + 0.14) k = e.sector;
    e.sector = k;
    const g = this.stanceFor(sp);
    const act = this.play(e, 'es_' + e.persona[0] + g.set + k, g.ts, 0.16);
    // a soft scuff on each plant (the planted foot's stance starts at u = 0 for the left, 0.5 for the right)
    if (act && act.getClip) {
      const T = act.getClip().duration, u = (act.time % T) / T, prev = e.stepU;
      e.stepU = u;
      if ((prev > 0.9 && u < 0.1) || (prev < 0.5 && u >= 0.5)) {
        const cam = this.engine.camera;
        if (!cam || cam.position.distanceToSquared(e.position) < 400) this.engine.events.emit('sfx:footstep', { pos: e.position, gain: g.set === 'f' ? 0.3 : 0.18, rate: 1.1, wet: this.engine.time.wet || 0 });
      }
    }
  },

  /** a gold call-out over a man's head (the first armoured hit: スーパーアーマー), on real time. hud.callout() takes it
   *  when hud.js has one; until then it is a DOM label moved by transform only (no layout per frame), its opacity
   *  written only when it changes */
  popText(e, text) {
    const hud = this.engine.get('hud');
    if (hud && typeof hud.callout === 'function') { try { hud.callout(e, text); return; } catch (err) { /* fall back to our own label */ } }
    if (typeof document === 'undefined') return;
    const host = document.getElementById('hud') || document.body;
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:40;white-space:nowrap;will-change:transform,opacity;transform-origin:50% 100%;'
      + 'font:900 30px/1 "Hiragino Mincho ProN","Yu Mincho","Hiragino Sans",serif;letter-spacing:.06em;color:#ffe7a0;'
      + '-webkit-text-stroke:1.5px #3a2500;text-shadow:0 0 10px rgba(255,190,60,.9),0 2px 0 #000;opacity:0';
    host.appendChild(el);
    (this.pops || (this.pops = [])).push({ e, el, t0: performance.now(), op: -1 });
  },
  updatePops() {
    if (!this.pops || !this.pops.length) return;
    const cam = this.engine.camera, W = window.innerWidth, H = window.innerHeight, now = performance.now();
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i], age = (now - p.t0) / 1000;
      if (age > 1.2 || p.e.gone) { p.el.remove(); this.pops.splice(i, 1); continue; }
      p.e.humanoid.boneWorld('Head', _o); _o.y += 0.32 + age * 0.12;
      _o.project(cam);
      const x = (_o.x * 0.5 + 0.5) * W, y = (-_o.y * 0.5 + 0.5) * H, sc = 1 + Math.max(0, 0.12 - age) / 0.12 / 3;
      p.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-100%) scale(${sc.toFixed(3)})`;
      const op = _o.z < 1 ? Math.round((age < 0.9 ? 1 : Math.max(0, (1.2 - age) / 0.3)) * 20) / 20 : 0;
      if (op !== p.op) { p.op = op; p.el.style.opacity = String(op); }
    }
  },

  // ------------------------------------------------------------------------------------------------ barks
  bark(e, kind, force = false) {
    if (!force && this.now < this.barkAt) return false;
    const pool = LINES[kind]; if (!pool) return false;
    const i = Math.floor(this.rng() * pool.length), line = pool[i];
    const hud = this.engine.get('hud'), text = `${e.name}「${line}」`;
    // on screen long enough to read: 0.12 s a character, never under 1.8 s
    if (hud && hud.subtitle) hud.subtitle(text, Math.max(1.8, line.length * 0.12));
    this.lastBark = { text, t: this.now };
    this.barkAt = this.now + this.rng.range(3.8, 6);
    // `line` keys the take (docs/reports/enemy.md: VOICEVOX takes by text, integration request to audio)
    this.engine.events.emit('sfx:voice', { entity: e, name: kind === 'getup' ? 'getup' : kind === 'scared' ? 'hurt' : 'taunt', text: line, line: kind + '/' + i });
    this.metrics.barks++;
    return true;
  },

  // ------------------------------------------------------------------------------------------------ KO / fade
  /** A KO'd man lies where he fell until the fight is over, and then goes only where nobody is looking: off screen,
   *  or under the victory cut / the results card. The fade itself is a dither (alphaHash): the body stays in the
   *  opaque pass, so the scan's overlapping layers never show through each other the way a blended fade showed them. */
  updateDead(e, dt) {
    if (e.gone) return;
    e.deadT += dt;
    this.applyVelocity(e, dt);
    const h = e.humanoid;
    if (!e.deadClip && !h.frozenPose) {
      const a = h.currentAction;
      const done = h.currentName === 'knockdown' ? (a && a.time >= a.getClip().duration - 0.03) : e.deadT > 1.1;
      if (done) { h.play('dead', { loop: false, force: true, fade: 0.45 }); e.deadClip = true; }
    }
    if (e.fadeT == null) {
      if (e.deadT < 1.6) return;
      const over = this.fightOver || !this.list.some((x) => x.alive && x.aggro);
      if (!over) return;
      // not during the final blow: its close shot puts the others off screen, and fadeReady's material build (~100 ms)
      // would land on the slow motion itself. They go under the results card that follows it instead.
      const cb = this.combat || this.engine.get('combat');
      if (cb && cb.finale) return;
      const ms = this.engine.get('missions');
      const cut = this.engine.state.mode === 'cutscene' || !!(ms && ms._resHold);
      if (cut || !this.onScreen(e) || e.deadT > 45) this.startFade(e);
      return;
    }
    e.fadeT += dt;
    const k = clamp(1 - e.fadeT / FADE_T, 0, 1);
    if (e.fadeMats) for (const m of e.fadeMats.values()) m.opacity = k;
    if (h.contact) h.contact.visible = k > 0.5;
    if (k <= 0) {
      if (e.group.parent) e.group.parent.remove(e.group);
      try { h.dispose(); } catch (err) { /* nothing left to free */ }
      if (e.fadeMats) { for (const m of e.fadeMats.values()) m.dispose(); e.fadeMats = null; }
      e.gone = true;
    }
  },
  startFade(e) {
    e.fadeT = 0;
    this.fadeReady(e);
    const h = e.humanoid;
    h.castNow = false; h.skinned.castShadow = false;
  },
  onScreen(e) {
    const cam = this.engine.camera;
    if (!cam) return true;
    if (this._frF !== this._lodF) {
      this._frF = this._lodF;
      cam.updateMatrixWorld();
      (this._fr || (this._fr = new THREE.Frustum())).setFromProjectionMatrix(_m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    }
    return this._fr.intersectsSphere(_sph.set(_o.set(e.position.x, e.position.y + 0.4, e.position.z), 1.1));
  },
  /** his own dithered copies of the scan material (the variant is compiled while the fight is set up, see prewarm) */
  fadeClone(m) {
    const c = m.clone();
    // copy() resets a physical material's defines to STANDARD/PHYSICAL: keep the cascade defines lighting.js added
    c.defines = { ...(m.defines || {}) };
    c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey; c.userData = m.userData;
    c.alphaHash = true; c.transparent = false; c.depthWrite = true; c.opacity = 1;
    return c;
  },
  /** the KO's programs (the blendable scan material in every pass it is drawn in, the coins) are compiled while the
   *  fight is being set up, not on the first KO, where they cost ~0.9 s: a copy of the first man's body in the fade
   *  material is drawn exactly over him (same geometry and skeleton, opacity 1: nothing changes on screen) and a coin
   *  sits inside his chest. renderer.compileAsync cannot do it: postfx renders into its own targets, and lighting.js
   *  hooks every new lit material into its CSM (a new key) within 60 frames — the scan material first, then the KO's
   *  copy of it. So the copy is made once the scan material is hooked, and drawn until it has been hooked itself;
   *  that is exactly the pair of keys a KO goes through. The material is kept, so the programs stay cached. */
  prewarm(e) {
    if (this._warm) return;
    this._warm = true;
    if (!this.coins) this.buildCoins();
    const C = this.coins;
    if (C) { C.mesh.count = 1; C.mesh.visible = true; }
    this._warmE = e; this._warmFrames = 1; this._warmAfter = 0;
    this.warmTick();
  },
  warmTick() {
    const e = this._warmE, C = this.coins;
    this._warmFrames++;
    try {
      if (C && e && !C.live.length) { C.mesh.setMatrixAt(0, C.m.makeTranslation(e.position.x, e.position.y + 1.25, e.position.z)); C.mesh.instanceMatrix.needsUpdate = true; }
      const src = e && e.humanoid.skinned, m0 = src && (Array.isArray(src.material) ? src.material[0] : src.material);
      if (!this._warmMesh && src && src.isSkinnedMesh && m0 && src.parent && !e.gone
        && (/csm$/.test(m0.customProgramCacheKey()) || this._warmFrames > 150)) {
        const tmp = new THREE.SkinnedMesh(src.geometry, this._warmMat = this.fadeClone(m0));
        tmp.bind(src.skeleton, src.bindMatrix);
        tmp.position.copy(src.position); tmp.quaternion.copy(src.quaternion); tmp.scale.copy(src.scale);
        tmp.layers.mask = src.layers.mask; tmp.frustumCulled = false; tmp.castShadow = false; tmp.receiveShadow = src.receiveShadow;
        src.parent.add(tmp);
        this._warmMesh = tmp; this._warmKey = this._warmMat.customProgramCacheKey();
        return;
      }
      if (this._warmMesh && this._warmMat.customProgramCacheKey() !== this._warmKey) this._warmAfter++;
    } catch (err) { this._warmFrames = 999; }
    if (this._warmAfter < 4 && this._warmFrames < 360) return;
    this._warmFrames = 0; this._warmE = null;
    if (this._warmMesh) { if (this._warmMesh.parent) this._warmMesh.parent.remove(this._warmMesh); this._warmMesh = null; }
    if (C && !C.live.length) { C.mesh.count = 0; C.mesh.visible = false; }
  },
  fadeReady(e) {
    if (e.fadeMats) return;
    const map = new Map();
    const cloneOf = (m) => {
      if (!m) return m;
      let c = map.get(m);
      if (!c) { c = this.fadeClone(m); map.set(m, c); }
      return c;
    };
    try {
      for (const mesh of e.humanoid.meshes || [e.humanoid.skinned]) {
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneOf) : cloneOf(mesh.material);
      }
      e.fadeMats = map;
    } catch (err) { e.fadeMats = map; }
  },

  /** ¥: a burst of spinning gold coins out of the body that arc, bounce once and are drawn into 健人 */
  dropYen(e) {
    if (!this.coins) this.buildCoins();
    const C = this.coins; if (!C) return;
    const n = 9 + Math.floor(this.rng() * 6);
    for (let i = 0; i < n && C.live.length < C.max; i++) {
      const a = this.rng() * Math.PI * 2, s = 1.3 + this.rng() * 1.6;
      C.live.push({
        p: new THREE.Vector3(e.position.x, e.position.y + 0.9 + this.rng() * 0.3, e.position.z),
        v: new THREE.Vector3(Math.sin(a) * s, 3.2 + this.rng() * 1.8, Math.cos(a) * s),
        spin: (8 + this.rng() * 10) * (this.rng() < 0.5 ? -1 : 1), tilt: this.rng() * Math.PI, rot: this.rng() * 6, t: -i * 0.035, bounced: false, home: 0,
      });
    }
  },
  buildCoins() {
    try {
      // oversized and self-lit on purpose: game money has to read as gold against a black, wet street at 4 m
      const geo = new THREE.CylinderGeometry(0.062, 0.062, 0.011, 24);
      const tex = yenTexture();
      const face = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, color: 0xffffff, metalness: 0.75, roughness: 0.3, emissive: 0xffc860, emissiveIntensity: 1.25 });
      const edge = new THREE.MeshStandardMaterial({ color: 0xf0c050, metalness: 0.85, roughness: 0.28, emissive: 0xc08418, emissiveIntensity: 1.0 });
      const max = 48;
      const mesh = new THREE.InstancedMesh(geo, [edge, face, face], max);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; mesh.count = 0; mesh.visible = false; mesh.castShadow = false;
      mesh.name = 'enemy:yen';
      if (this.engine.layers && this.engine.layers.BLOOM) mesh.layers.enable(this.engine.layers.BLOOM);
      this.engine.scene.add(mesh);
      this.coins = { mesh, max, live: [], m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), s: new THREE.Vector3() };
    } catch (err) { this.coins = null; }
  },
  updateCoins(dt, frozen) {
    const C = this.coins; if (!C || !C.live.length) return;
    const p = this.engine.player;
    if (!frozen) {
      for (let i = C.live.length - 1; i >= 0; i--) {
        const c = C.live[i];
        c.t += dt;
        if (c.t < 0) continue;
        c.rot += c.spin * dt;
        if (c.t < 1.05 || !p) {
          c.v.y -= 9.8 * dt;
          c.p.addScaledVector(c.v, dt);
          const gy = (this.engine.world ? this.engine.world.groundHeight(c.p.x, c.p.z) : 0) + 0.03;
          if (c.p.y < gy) { c.p.y = gy; if (!c.bounced) { c.v.y = Math.abs(c.v.y) * 0.38; c.v.x *= 0.5; c.v.z *= 0.5; c.bounced = true; } else { c.v.set(0, 0, 0); } }
        } else {
          c.home += dt * 2.6;
          const k = Math.min(1, c.home * c.home);
          c.p.lerp(_w.set(p.position.x, p.position.y + 1.1, p.position.z), k);
          if (c.home >= 1) C.live.splice(i, 1);
        }
      }
    }
    const n = Math.min(C.live.length, C.max);
    for (let i = 0; i < n; i++) {
      const c = C.live[i];
      const sc = c.t < 0 ? 0 : c.home > 0.6 ? Math.max(0, 1 - (c.home - 0.6) / 0.4) : 1;
      C.e.set(c.tilt + Math.PI / 2, c.rot, 0, 'YXZ');
      C.q.setFromEuler(C.e);
      C.m.compose(c.p, C.q, C.s.set(sc, sc, sc));
      C.mesh.setMatrixAt(i, C.m);
    }
    C.mesh.count = n; C.mesh.visible = n > 0;
    C.mesh.instanceMatrix.needsUpdate = true;
  },

  // ------------------------------------------------------------------------------------------------ metrics / lab
  resetMetrics() {
    this.metrics = { t: 0, share: [0, 0, 0, 0], maxAtk: 0, maxHold: 0, grants: 0, attacks: 0, landed: 0, blocked: 0, whiffs: 0, armor: 0,
      feints: 0, guards: 0, guardUps: 0, counters: 0, taunts: 0, barks: 0, downs: 0, getups: 0, kos: 0, retreats: 0, windups: [], minGap: 99 };
  },
  sample(dt, foes) {
    if (this.engine.state.mode !== 'combat' || !foes.length) return;
    const M = this.metrics;
    let atk = 0, hold = 0;
    for (const e of foes) if (e.alive && e.state === 'attack') { atk++; if (e.atk && e.atk.phase !== 'strike') hold++; }
    M.t += dt; M.share[Math.min(3, atk)] += dt;
    M.maxAtk = Math.max(M.maxAtk, atk); M.maxHold = Math.max(M.maxHold, hold);
    // the smallest distance between any two standing men: a stack reads as one blob
    for (let i = 0; i < foes.length; i++) for (let j = i + 1; j < foes.length; j++) {
      const a = foes[i], b = foes[j];
      if (!a.alive || !b.alive || REACT.has(a.state) || REACT.has(b.state)) continue;
      M.minGap = Math.min(M.minGap, Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z));
    }
  },
  report() {
    const M = this.metrics, T = Math.max(1e-3, M.t);
    const pct = M.share.map((s) => Math.round((s / T) * 100));
    const w = M.windups.length ? M.windups.reduce((a, b) => a + b, 0) / M.windups.length : 0;
    return `${T.toFixed(1)} s in combat: simultaneous attackers max ${M.maxAtk} (wind-ups at once max ${M.maxHold}); time with 0/1/2/3 attacking ${pct.join('/')} %; `
      + `grants ${M.grants}, swings ${M.attacks}, landed ${M.landed}, blocked by 健人 ${M.blocked}, whiffed ${M.whiffs}, feints ${M.feints}, brute armour ${M.armor}; `
      + `enemy guards ${M.guardUps} (blocked ${M.guards}), counters ${M.counters}; taunts ${M.taunts}, barks ${M.barks}; downs ${M.downs}, get-ups ${M.getups}, KOs ${M.kos}, `
      + `retreats ${M.retreats}; wind-up mean ${w.toFixed(2)} s; closest two standing men ${M.minGap.toFixed(2)} m`;
  },

  /** ?enemylab=1 (with ?fight=1 or ?cutscene=hachiko): skips to the live fight, then a scripted 健人 stands his ground
   *  and throws rush strings at whoever steps in, guarding now and then. Enemies cannot die for the first 30 s
   *  (the group behaviour is what is measured); then the floor is lifted and the KO → dead → fade chain is logged. */
  async runLab() {
    const engine = this.engine;
    const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
    const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
    const tap = async (code, hold = 0.06) => { key(code, true); await wait(hold); key(code, false); };
    // missions opens chapter 1 a few seconds in (the intro, or ?cutscene=hachiko): let it start, hold Enter through it,
    // and if the fight is not live after that (?fight=1 spawns them where the intro walks 健人 away) walk him back
    await wait(3.6);
    for (let k = 0, calm = 0; k < 80 && calm < 3; k++) {
      if (engine.state.mode === 'cutscene') { calm = 0; key('Enter', true); await wait(0.5); key('Enter', false); await wait(0.25); continue; }
      const alive = this.list.filter((e) => e.alive);
      if (engine.state.mode !== 'combat' && alive.length && engine.player) {
        const c = new THREE.Vector3(); for (const e of alive) c.add(e.position); c.multiplyScalar(1 / alive.length);
        const p = engine.player;
        const dir = new THREE.Vector3(p.position.x - c.x, 0, p.position.z - c.z); if (dir.lengthSq() < 1e-3) dir.set(0, 0, 1);
        dir.normalize();
        p.position.set(c.x + dir.x * 4.5, 0, c.z + dir.z * 4.5);
        p.yaw = Math.atan2(-dir.x, -dir.z); p.group.rotation.y = p.yaw;
        engine.state.mode = 'combat'; engine.events.emit('combat:start', { enemies: alive });
      }
      if (engine.state.mode === 'combat') calm++;
      await wait(0.3);
    }
    await wait(0.4);
    this.resetMetrics();
    this.labOn = true; this.labImmortal = true;
    const log = [];
    const T0 = performance.now(), sec = () => (performance.now() - T0) / 1000;
    const offs = [
      ['combat:telegraph', (x) => log.push(`${sec().toFixed(1)} tell ${x.attacker.persona} ${x.name} ${x.hold.toFixed(2)}s`)],
      ['combat:ko', (x) => log.push(`${sec().toFixed(1)} ko ${x.target.persona || 'P'}`)],
      ['enemy:ko', (x) => log.push(`${sec().toFixed(1)} enemy:ko ${x.entity.persona}`)],
    ];
    for (const [n, f] of offs) engine.events.on(n, f);
    let snap = 0;
    while (sec() < 42 && this.list.some((e) => e.alive)) {
      if (sec() > 30 && this.labImmortal) { this.labImmortal = false; console.info('[enemy] lab 30 s: ' + this.report()); }
      if (sec() > snap) {
        snap += 3;
        log.push(`${sec().toFixed(1)} ` + this.list.filter((e) => e.alive).map((e) => `${e.persona}:${e.state}${e.token ? '*' : ''}@${(e.dist || 0).toFixed(1)}`).join(' '));
      }
      // a fair player: reads a wind-up (guard or step out of it), strings 2–4 blows on whoever is in reach, breathes
      const p = engine.player;
      const near = this.list.filter((e) => e.alive && !REACT.has(e.state)).map((e) => [e, Math.hypot(e.position.x - p.position.x, e.position.z - p.position.z)]).sort((a, b) => a[1] - b[1])[0];
      const winding = this.list.find((e) => e.alive && e.state === 'attack' && e.atk && e.atk.phase === 'hold' && (e.dist || 9) < 2.6);
      if (winding && !winding.labSeen) {
        winding.labSeen = winding.atk;
        const r = this.rng();
        if (r < 0.45) { key('KeyI', true); await wait(0.6); key('KeyI', false); await wait(0.1); continue; }
        if (r < 0.65) { await tap('Space'); await wait(0.4); continue; }
      }
      if (winding && winding.labSeen !== winding.atk) winding.labSeen = null;
      if (near && near[1] < 1.75 && p.state !== 'down' && p.state !== 'getup') {
        const n = 2 + Math.floor(this.rng() * 3);
        for (let i = 0; i < n; i++) { await tap('KeyJ'); await wait(0.13); }
        if (this.rng() < 0.4) { await tap('KeyK'); await wait(0.13); }
        await wait(0.5 + this.rng() * 0.6);
        continue;
      }
      await wait(0.12);
    }
    this.labOn = false;
    for (const [n, f] of offs) engine.events.off(n, f);
    const dead = this.list.filter((e) => !e.alive).map((e) => `${e.persona} ${e.gone ? 'faded' : e.deadClip ? 'lying (dead clip)' : 'falling'} t=${e.deadT.toFixed(1)}`);
    console.info('[enemy] lab log:\n' + log.join('\n'));
    console.info('[enemy] lab end: ' + this.report() + ' | dead: ' + (dead.join(', ') || 'none'));
  },
  labKeep() {
    const p = this.engine.player;
    if (p && p.hp < 40) p.hp = 40;
    if (this.labImmortal) for (const e of this.list) if (e.alive && e.hp < 30) e.hp = 30;   // above any one blow
  },

  // ------------------------------------------------------------------------------------------------ shot preset
  /** ?shot=enemy_ring: the three are spawned in front of 健人 and the live AI runs until the first wind-up is held,
   *  then the world is frozen on it — the ring, the circling men and the red tell of the one who is coming */
  stageRing(engine) {
    const p = engine.player; if (!p) return;
    // on 健人's chapter-1 mark: 8.5 m in front of ハチ公, facing it (as missions.stageHachiko)
    const hp = (CITY.plazas || []).find((q) => q.id === 'hachiko'), st = hp ? hp.statue : { pos: [26, 24], rotY: -Math.PI / 2 };
    const fx = Math.cos(st.rotY || 0), fz = -Math.sin(st.rotY || 0), mx = st.pos[0] + fx * 7.5, mz = st.pos[1] + fz * 7.5;
    p.position.set(mx, engine.world ? engine.world.groundHeight(mx, mz) : 0, mz); p.yaw = Math.atan2(-fx, -fz); p.group.rotation.y = p.yaw;
    p.setState('idle');
    const fwd = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    const list = this.spawnGroup(3, p.position.clone().addScaledVector(fwd, 1.2));
    // already on the ring (bearing from his facing, radius): the brute in front, the guard front-right, the coward
    // front-left. The brute comes straight in; the guard squares up with a beckon while he winds up; the coward waits
    const ring = { brute: [-0.45, 2.9], guard: [-1.15, 3.0], coward: [1.1, 3.8] };
    list.forEach((e, i) => {
      const [b, r] = ring[e.persona] || [0, 3];
      e.position.set(p.position.x + Math.sin(p.yaw + b) * r, p.position.y, p.position.z + Math.cos(p.yaw + b) * r);
      e.yaw = Math.atan2(p.position.x - e.position.x, p.position.z - e.position.z); e.group.rotation.y = e.yaw;
      e.tauntT = 99; e.cooldown = i === 0 ? 0 : 6;
      e.opening = e.persona === 'guard'; e.openT = 1.2; e.openLine = e.opening;
    });
    this.director.nextGrant = this.now + 0.35;
    this.ringShot = { t: 0, done: false };
    const ms = engine.get('missions');
    if (ms && ms.setObjective) ms.setObjective('チンピラを倒せ', null, '戦闘');   // (and no waypoint pillar in the ring)
    // shots.init freezes the world right after this setup: let it run live from the first frame instead
    engine.events.on('engine:booted', () => { engine.state.frozen = false; });
  },
  ringTick(dt) {
    const R = this.ringShot; if (R.done) return;
    R.t += dt;
    const w = this.list.find((e) => e.alive && e.state === 'attack' && e.atk && e.atk.phase === 'hold' && e.atk.holdT > e.atk.hold * 0.6);
    if (!w && R.t < 3.3) return;
    R.done = true;
    const engine = this.engine;
    // hud.subtitle clears itself on a real-time timer: the still keeps the opening line on screen
    const hud = engine.get('hud');
    if (this.lastBark && hud && hud.subtitle) hud.subtitle(this.lastBark.text, 0);
    engine.state.frozen = true;
    for (const e of this.list) e.humanoid.frozenPose = true;
    if (engine.player) engine.player.humanoid.frozenPose = true;
    console.info(`[enemy] ring still at ${R.t.toFixed(2)} s: ` + this.list.map((e) => `${e.persona}:${e.state}${e.atk ? '/' + e.atk.phase : ''}@${(e.dist || 0).toFixed(2)}m`).join(' '));
  },

  /** ?shot=enemy_cast: the three side by side on the crossing, crowd hidden, frozen in a pose — the model review frame.
   *  &eanim=<clip>&ephase=<0..1> poses them; &chamber=1 adds the wind-up chamber (hook/straight/jab/uppercut/kick);
   *  &yaw=<rad> turns them; &cull=show paints the culled prop islands red instead of removing them */
  stageCast(engine) {
    this.castShot = true;
    const raw = (engine.params && engine.params.raw) || {};
    const clip = raw.eanim || 'idle_combat', phase = raw.ephase != null ? Number(raw.ephase) : 0.3;
    const yaw = raw.yaw != null ? Number(raw.yaw) : 0;
    const evar = raw.evar ? String(raw.evar).split(',') : [];          // &evar=a,b,c: try another scan per man
    CAST.forEach((k, i) => {
      const e = this.spawn('chinpira', new THREE.Vector3(-4.5 + i * 1.5, 0, 5), { persona: k, variant: evar[i] || undefined });
      e.yaw = yaw; e.group.rotation.y = yaw;
      const combat = engine.get('combat'), rc = raw.react && combat && combat.reactClips ? combat.reactClips()[raw.react] : null;
      if (rc) {
        combat.poseHard(e.humanoid, raw.react, phase, rc); e.state = e.seen = 'hit';
        if (raw.flinch && combat.flinch && combat.ATTACKS) {                // the staged combat still adds combat's flinch
          e.group.updateMatrixWorld(true);
          const blow = new THREE.Vector3(Number(raw.flinch) > 1 ? -0.7 : 0.7, 0.1, -0.7).normalize();
          const f = combat.flinch(e, e.humanoid.boneWorld('Head', new THREE.Vector3()), blow, combat.ATTACKS.hook);
          if (f) combat.applyFlinch(f, f.amp * Math.exp(-0.03 / 0.12));
        }
      }
      else { e.humanoid.pose(clip, phase); if (clip === 'knockdown' || clip === 'dead') { e.state = e.seen = 'down'; e.castPose = true; } }
      if (e.humanoid.plant && !e.castPose) e.humanoid.plant();
      if (raw.chamber) { e.state = e.seen = 'attack'; e.staged = { name: clip, done: false }; }
    });
    if (engine.player && engine.player.group) engine.player.group.visible = false;
  },
  /** the review frame empties the street: crowd bodies (instanced and pooled humanoids) and traffic */
  hideOthers() {
    const engine = this.engine, hm = engine.get('humanoid');
    for (const o of engine.scene.children) if (o.visible && o.name && o.name.startsWith('crowd:')) o.visible = false;
    const mine = new Set(this.list.map((e) => e.humanoid));
    if (hm && hm.all) for (const h of hm.all) if (!mine.has(h) && h.group.visible) h.group.visible = false;
    for (const n of ['traffic', 'crowd']) {
      const m = engine.get(n);
      if (m) for (const k of ['root', 'group', 'container']) if (m[k] && m[k].isObject3D) { m[k].visible = false; break; }
    }
  },

  // ------------------------------------------------------------------------------------------------ self test
  selfTest() {
    const out = { ok: true, problems: [] };
    const clips = this.buildClips();
    out.stanceClips = Object.keys(clips).filter((k) => k.startsWith('es_')).length;
    out.moves = Object.keys(MOVE_DEFS).filter((k) => clips[k]).length;
    if (out.moves !== Object.keys(MOVE_DEFS).length) { out.ok = false; out.problems.push('persona moves ' + out.moves); }
    const want = Object.keys(GAIT).length * 16;
    if (out.stanceClips !== want) { out.ok = false; out.problems.push('stance clips ' + out.stanceClips + '/' + want); }
    // The planted foot must not slide at any speed the AI actually drives: a real body is moved at 0.3, 0.6 and 1.5 m/s
    // along each direction, playing the set and rate stanceFor() picks, and the world-space drift of the ankle on the
    // ground is measured (left planted u 0.08–0.52, right 0.58–1.02)
    const e = this.list.find((x) => x.alive && !x.humanoid.frozenPose);
    if (e && out.stanceClips === want) {
      const h = e.humanoid, g = h.group, p0 = g.position.clone(), yaw = g.rotation.y;
      const fa = new THREE.Vector3(), fb = new THREE.Vector3();
      out.plantedSlip = {};
      for (const pk of Object.keys(GAIT)) {
        for (const sp of [0.3, 0.6, 1.5]) {
          const st = this.stanceFor(sp);
          let slip = 0;
          for (let k = 0; k < 8; k++) {
            const clip = clips['es_' + pk[0] + st.set + k], T = clip.duration, steps = 48, dt = T / st.ts / steps;
            const ang = k * Math.PI / 4, lx = Math.sin(ang), lz = Math.cos(ang);
            const wx = lx * Math.cos(yaw) + lz * Math.sin(yaw), wz = -lx * Math.sin(yaw) + lz * Math.cos(yaw);
            h.mixer.stopAllAction();
            const act = h.mixer.clipAction(clip);
            act.reset().setEffectiveWeight(1).setEffectiveTimeScale(st.ts).play();
            const cur = h.currentAction, curName = h.currentName;
            h.currentAction = act; h.currentName = clip.name;
            for (const [bone, u0, u1] of [['LeftFoot', 0.08, 0.52], ['RightFoot', 0.58, 1.02]]) {
              act.time = 0; g.position.copy(p0); h.mixer.update(0); e.lock = null;
              let prevOk = false;
              for (let i = 0; i <= steps * 1.1; i++) {
                const u = i / steps;
                g.updateMatrixWorld(true); h.boneWorld(bone, fb);
                if (u > u0 && u < u1 && prevOk) slip = Math.max(slip, fb.distanceTo(fa) / dt);
                prevOk = u >= u0; fa.copy(fb);
                h.mixer.update(dt); g.position.x += wx * sp * dt; g.position.z += wz * sp * dt;
                g.updateMatrixWorld(true);
                this.footLock(e, dt);
              }
            }
            h.currentAction = cur; h.currentName = curName; e.lock = null;
            act.stop();
          }
          out.plantedSlip[pk + '@' + sp] = +slip.toFixed(3);         // m/s of ankle drift while that foot is planted
          if (slip > 0.12) { out.ok = false; out.problems.push(`${pk} planted foot slides ${slip.toFixed(3)} m/s at ${sp} m/s`); }
        }
      }
      g.position.copy(p0); g.updateMatrixWorld(true);
      h.play('idle_combat', { fade: 0, force: true }); h.mixer.update(0);
    }
    for (const [k, P] of Object.entries(PERSONA)) if (!P.combos.every((c) => c.every((n) => CHAMBER[n] != null))) { out.ok = false; out.problems.push(k + ': combo move without a chamber key'); }
    // casting: no torso colour within 20 % of 健人's navy / charcoal in both luminance and hue
    const kento = [0x1c1e23, 0x18294a].map((x) => new THREE.Color(x)), hsl = { h: 0, s: 0, l: 0 }, hk = { h: 0, s: 0, l: 0 };
    out.wardrobe = {};
    for (const [pk, sw] of Object.entries(WARDROBE)) {
      const main = sw.find((x) => x.torso) || sw[0], c = new THREE.Color(main.to), L = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      c.getHSL(hsl);
      let clash = false;
      for (const kc of kento) {
        kc.getHSL(hk);
        const Lk = 0.2126 * kc.r + 0.7152 * kc.g + 0.0722 * kc.b;
        const dl = Math.abs(L - Lk) / Math.max(L, Lk), dh = Math.min(Math.abs(hsl.h - hk.h), 1 - Math.abs(hsl.h - hk.h));
        if (dl < 0.2 && dh < 0.2) clash = true;
      }
      out.wardrobe[pk] = '#' + c.getHexString() + (clash ? ' CLASH' : '');
      if (clash) { out.ok = false; out.problems.push(pk + ' torso reads as 健人\'s palette'); }
    }
    out.personas = Object.keys(PERSONA);
    return out;
  },
};

export const shotPresets = {
  // same lens as the 'combat' preset (3/4 behind 健人's right shoulder), on the chapter-1 apron in front of ハチ公
  enemy_ring: ({ engine }) => {
    const hp = (CITY.plazas || []).find((q) => q.id === 'hachiko'), st = hp ? hp.statue : { pos: [26, 24], rotY: -Math.PI / 2 };
    const fx = Math.cos(st.rotY || 0), fz = -Math.sin(st.rotY || 0), mx = st.pos[0] + fx * 7.5, mz = st.pos[1] + fz * 7.5;
    // 3.4 m behind 健人 and 0.9 m to his right, looking past the ring toward the statue (the old fixed frame, re-anchored)
    return { pos: [mx + fx * 3.4 + fz * 0.9, 1.9, mz + fz * 3.4 - fx * 0.9], lookAt: [mx - fx * 4.5, 1.2, mz - fz * 4.5], fov: 45,
      setup: (eng) => enemy.stageRing(eng || engine) };
  },
  // &who=0|1|2 frames one man (brute, guard, coward) at 2.4 m; &side=1 from his right
  enemy_cast: ({ engine }) => {
    const raw = (engine && engine.params && engine.params.raw) || {};
    const who = raw.who != null && raw.who !== '' ? Number(raw.who) : -1, side = raw.side ? 1 : 0;
    if (who < 0 && raw.top) return { pos: [-3, 3.4, 9.6], lookAt: [-3, 0.1, 4.4], fov: 38, t: 'night', setup: (eng) => enemy.stageCast(eng || engine) };   // &top=1: bodies on the floor
    if (who < 0) return { pos: [-3, 1.25, 9.4], lookAt: [-3, 0.98, 5], fov: 38, t: 'night', setup: (eng) => enemy.stageCast(eng || engine) };
    const x = -4.5 + who * 1.5;
    return { pos: side ? [x - 2.4, 1.3, 5.2] : [x + 0.3, 1.3, 7.4], lookAt: [x, 1.0, 5], fov: 40, t: 'night', setup: (eng) => enemy.stageCast(eng || engine) };
  },
};
enemy.shotPresets = shotPresets;

export default enemy;
