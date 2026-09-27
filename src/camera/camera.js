// [camera] 龍が如く-style third-person rig: spring arm with collision pull-in, auto-orbit, combat framing,
// cinematic shot lists, trauma shake, FOV kick.
//
// Follow rig = a chain of legs, each starting from a point the previous one proved free (his head -> smoothed
// pivot -> shoulder -> lens), so no probe ever starts inside a box. Hard cone ceiling + soft tapered
// cylinder ease-in + whisker yaw feelers + crane lift in tight spots; critically damped springs everywhere a
// target can jump (pivot, auto yaw, combat distance, side swaps) so the lens never changes speed in one frame.
// Combat framing: primary target with hysteresis; a framing solver scores lens positions round the pair (side of
// the axis x swing 0.33..1.4 rad, 1.6 at contact range) through the exact pose the rig builds (rigPose: pivot,
// pitch, shoulder, look lift) and bone-sampled heads / chests, for subjects out of the HUD-safe frame, backs between
// lens and player and men hidden behind him; the two principals' chests under 12 % of the frame apart is a hard
// reject, and the arm may come in to 3.0 m to part them. Closed-form fit distance (3.8..6.4 m) that keeps everyone
// clear of the minimap and plates. Hit-stop freezes the framing springs (only shake / punch / FOV move). The last KO
// of a fight whips in to a slow-motion close shot on the victim and eases back (finalBlow, timed by
// combat/finalBlow.js). Near plane adapts to the arm (0.1..0.3 m).
//
//   camera.setFollow(entity, {distance, height, shoulder, yaw})  third-person spring arm (default mode)
//   camera.setFixed(pos, lookAt, {fov})                      pin the camera (shots.js / staged cutscene beats)
//   camera.cinematic(rig) -> Promise                         rig = { pos, lookAt, fov, duration, ease }        (single shot)
//                                                                | { shots:[{pos,lookAt,to,fov,duration,ease,cut,shake}],
//                                                                    relativeTo: actor, fov, duration, ease }  (shot list)
//        `relativeTo` puts a shot's pos/lookAt in that actor's local frame (+z forward, +y up, +x = his LEFT
//        hand, i.e. world +x at yaw 0 — unchanged from the first rig) and keeps tracking it, so a heat action
//        reads the same from any world angle. ease=0 (or cut:true) hard-cuts.
//        `relativeTo: [a, b]` (or {from:a, to:b}) is the two-actor frame: origin at a, +z toward b.
//        Optional per shot: roll (rad, dutch), curve ('inOut'|'linear'|'in'|'out' for `to` moves), fovKick,
//        onStart(engine, index), collide (relative shots authored into a wall are mirrored to the open side;
//        every shot whose lens has a facade between it and its lookAt slides toward the subject until clear;
//        collide:false turns both off). Optional on the rig: blendOut (s; default 'auto' = glide back when the
//        gameplay camera is within 3 m and in sight, cut otherwise; 0 = always cut), onEnd(). Resolves
//        {cancelled}. Runs in real time (slow-mo/hit-stop do not slow it). Emits 'camera:cut' on every hard cut
//        and 'camera:shot' {index, count} as each shot starts.
//   camera.stopCinematic()                                   cancel the running sequence
//   camera.shake(strength, duration)                         trauma noise (positional + rotational); falls linearly
//                                                            to 0 at the latest end time any caller asked for
//   camera.fovKick(delta, decay)                             impulse on the field of view (hits, dodges)
//   camera.punch(dir, metres)                                spring-loaded positional kick (every player hit)
//   camera.focusDistance                                     lens -> subject distance of the running cinematic; while
//                                                            postfx has a manual DOF it is written to postfx.focus
//   camera.finalBlow(target, attacker)                       the last-man KO shot (fired on combat:finale by itself): a
//                                                            weighted overlay on the live follow rig; emits
//                                                            'camera:finalBlow' {duration, target, attacker, still}.
//                                                            camera.fbState {t, w, fov, dist} while it plays
//   camera.subjectRect / camera.isCloseup                    per frame, for postfx: NDC box {x0,y0,x1,y1,on} of 健人
//                                                            through the final lens; long lens or subject < 2.5 m
//   camera.yaw / camera.pitch                                orbit angles (rad). getForward(out) -> flat forward.
//   Debug URL params: camdbg=1 (rig / solver log), camnoblur=1, camaim=<side>,<swing> (force a combat aim),
//   cucand=<m*10+delta> (force a closeup candidate), cudof=0 (closeup without its portrait DOF), camlab=1.
import * as THREE from 'three';
import { FINAL_BLOW, fbEnd, fbCam, fbDrift } from '../combat/finalBlow.js';

const _fbA = new THREE.Vector3(), _fbB = new THREE.Vector3(), _fbC = new THREE.Vector3(), _fbL = new THREE.Vector3(), _fbT = new THREE.Vector3();
const _fbF = new THREE.Vector3(), _fbR = new THREE.Vector3(), _fbU = new THREE.Vector3();
// the look point that puts world point `A` at NDC (hx, hy) through a lens at `C` (vertical fov deg, aspect)
function fbAim(C, A, hx, hy, fov, aspect, out) {
  _fbF.subVectors(A, C);
  const depth = _fbF.length() || 1;
  _fbF.multiplyScalar(1 / depth);
  _fbR.set(-_fbF.z, 0, _fbF.x);                                   // forward x up
  if (_fbR.lengthSq() < 1e-8) _fbR.set(1, 0, 0); else _fbR.normalize();
  _fbU.crossVectors(_fbR, _fbF);
  const tv = Math.tan((fov * Math.PI) / 360), th = tv * aspect;
  return out.copy(A).addScaledVector(_fbR, -hx * th * depth).addScaledVector(_fbU, -hy * tv * depth);
}
const _dir = new THREE.Vector3(), _pivot = new THREE.Vector3(), _look = new THREE.Vector3(), _head = new THREE.Vector3();
const _axis = new THREE.Vector3(), _right = new THREE.Vector3(), _fwd = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _o = new THREE.Vector3(), _c = new THREE.Vector3();
const _cr = new THREE.Vector3(), _cu = new THREE.Vector3(), _cp = new THREE.Vector3(), _ray = new THREE.Vector3();
const _F = new THREE.Vector3(), _U = new THREE.Vector3(), _q = new THREE.Quaternion(), _p2 = new THREE.Vector3();

// the arm must pass through thin / moving colliders: catching on a lamp post or a taxi makes it flicker
const PASS_THROUGH = new Set(['ground', 'dynamic', 'weapon', 'prop', 'pole', 'rail', 'tree', 'vehicle', 'sign', 'char', 'crowd']);
// cone cast: rays from the (known free) arm root to points on a ring of radius r around the camera end
const CONE = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
const LENS_R = 0.13;            // sphere that contains the near plane (0.1 m, 47° fov, 16:9) with a margin

const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const smoothstep = (k) => k * k * (3 - 2 * k);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// critically damped spring toward `target` (velocity kept in ref.v): unlike an exponential lerp the lens never
// picks up speed in a single frame, so a target that jumps (a new opponent, a side swap) is eased in AND out
function smoothDamp(cur, target, ref, smoothTime, dt) {
  const w = 2 / Math.max(1e-3, smoothTime), x = w * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target, temp = (ref.v + w * change) * dt;
  ref.v = (ref.v - w * temp) * e;
  return target + (change + temp) * e;
}
const CURVES = {
  inOut: smoothstep, linear: (k) => k,
  // Equal perceived scale changes over a 650 m descent, with a still start and soft landing.
  arrival: (k) => (1 - Math.exp(-4.2 * smoothstep(k))) / (1 - Math.exp(-4.2)),
  in: (k) => k * k * k, out: (k) => 1 - (1 - k) * (1 - k) * (1 - k),
};

// deterministic value noise. Own generator on purpose: engine.rng is a seeded stream other modules depend on,
// pulling from it every frame for shake would desync their determinism.
const hash1 = (n) => { const s = Math.sin(n * 127.1 + 17.3) * 43758.5453123; return (s - Math.floor(s)) * 2 - 1; };
function vnoise(x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}
const NO_HITS = [];
// HUD furniture in NDC (x right, y up, -1..1): a head or a foot may not be framed underneath it. A point in that
// corner is fine as long as it is inside EITHER edge of the box. [xSign, ySign, |x| edge, |y| edge]
const HUD_BOXES = [
  [1, -1, 0.70, 0.48],     // minimap, bottom right
  [-1, 1, 0.52, 0.58],     // name plate + enemy plates, top left
  [-1, -1, 0.72, 0.60],    // money / location plate, bottom left
];
// framing solver: swings off the player -> target axis; at contact range a true side-on two-shot is allowed
const SWINGS = [0.33, 0.5, 0.7, 0.9, 1.15, 1.4];
const SWINGS_CLOSE = [0.33, 0.5, 0.7, 0.9, 1.15, 1.4, 1.6];
const MIN_SEP = 0.12;            // the two principals' chests at least this fraction of the frame width apart
const SEP_AIM = 0.16;            // ...and this far when the arm can come in enough for it
const _bw = new THREE.Vector3(), _C = new THREE.Vector3(), _Fw = new THREE.Vector3(), _Rw = new THREE.Vector3(), _Uw = new THREE.Vector3();
const isDown = (x) => x.state === 'down' || x.state === 'dead';

// framing point record (world space): w > 0 fitted and scored, w = 0 a principal's chest, w < 0 a bystander's chest
function setPt(list, i, x, y, z, w, mH, mV) {
  const r = list[i] || (list[i] = { x: 0, y: 0, z: 0, w: 0, mH: 1, mV: 1 });
  r.x = x; r.y = y; r.z = z; r.w = w; r.mH = mH; r.mV = mV;
  return i + 1;
}
// closed-form arm for one point given in lens axes relative to the look point: far enough back that it projects
// inside the safe frame (mH, mV) and clears each HUD box by either inner edge
function fitDist(x, y, z, tH, tV, mH, mV) {
  let d = Math.max(Math.abs(x) / (tH * mH), Math.abs(y) / (tV * mV)) - z;
  for (let j = 0; j < HUD_BOXES.length; j++) {
    const b = HUD_BOXES[j];
    if (x * b[0] <= 0 || y * b[1] <= 0) continue;
    d = Math.max(d, Math.min(Math.abs(x) / (tH * b[2]), Math.abs(y) / (tV * b[3])) - z);
  }
  return d;
}
// primary-target score (lower wins): range, less how squarely he is facing him; a man on the ground comes last
// The man coming at him (an attack wound up or landing, enemy.js state 'attack') outranks everyone: he is the one
// the player has to see, so he becomes the principal the framing keeps apart from 健人 (readability review, P1).
const isAttacking = (x) => x.state === 'attack';
function targetScore(e, x, fx, fz) {
  const dx = x.position.x - e.position.x, dz = x.position.z - e.position.z;
  const d = Math.hypot(dx, dz);
  const facing = d > 1e-3 ? (dx * fx + dz * fz) / d : 0;
  return d - 1.1 * Math.max(0, facing) + (isDown(x) ? 2.5 : 0) - (isAttacking(x) && d < 4.5 ? 2.5 : 0);
}
// slab test, same contract as physics.js: -1 for a miss or when the origin is inside the box
function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1, maxDist) {
  let tmin = 0, tmax = maxDist, entered = false, t1, t2, tt;
  if (Math.abs(dx) < 1e-9) { if (ox < x0 || ox > x1) return -1; }
  else { t1 = (x0 - ox) / dx; t2 = (x1 - ox) / dx; if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; } if (t1 > tmin) { tmin = t1; entered = true; } if (t2 < tmax) tmax = t2; if (tmin > tmax) return -1; }
  if (Math.abs(dy) < 1e-9) { if (oy < y0 || oy > y1) return -1; }
  else { t1 = (y0 - oy) / dy; t2 = (y1 - oy) / dy; if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; } if (t1 > tmin) { tmin = t1; entered = true; } if (t2 < tmax) tmax = t2; if (tmin > tmax) return -1; }
  if (Math.abs(dz) < 1e-9) { if (oz < z0 || oz > z1) return -1; }
  else { t1 = (z0 - oz) / dz; t2 = (z1 - oz) / dz; if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; } if (t1 > tmin) { tmin = t1; entered = true; } if (t2 < tmax) tmax = t2; if (tmin > tmax) return -1; }
  return entered ? tmin : -1;
}
const VIEW_SKIP = new Set(['ground', 'bounds', 'dynamic', 'weapon', 'char', 'crowd']);
// final-blow lens search, round the VICTIM: bearing from the direction toward 健人 (rad; pi/2 = side-on, more = a touch
// behind him so 健人 turns toward the lens), lens distance offsets from FINAL_BLOW.dist
const KO_BEARING = [1.45, 1.65, 1.85], KO_DIST = [-0.4, 0, 0.3];
// the close shot's composition: his neck / upper chest held at this NDC point (x away from the side the fist comes in
// from, so the fist and 健人's arm have the other side of the frame; y on the upper third); x relaxes toward the centre
// as the blow carries him off and the fist is left behind
const FB_PLACE = [0.2, 0.16];
// ray against a list of physics shapes (aabb / obb), same contract as physics.raycast; returns the free length
function rayList(list, o, d, maxLen) {
  let best = maxLen;
  for (let i = 0; i < list.length; i++) {
    const sh = list[i];
    let t;
    if (sh.kind === 'aabb') t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, sh.min.x, sh.min.y, sh.min.z, sh.max.x, sh.max.y, sh.max.z, best);
    else {
      const ox = o.x - sh.center.x, oz = o.z - sh.center.z;
      t = rayBox(sh.c * ox - sh.s * oz, o.y, sh.s * ox + sh.c * oz, sh.c * d.x - sh.s * d.z, d.y, sh.s * d.x + sh.c * d.z,
        -sh.half.x, sh.center.y - sh.half.y, -sh.half.z, sh.half.x, sh.center.y + sh.half.y, sh.half.z, best);
    }
    if (t >= 0 && t < best) best = t;
  }
  return best;
}
// sphere against a list of shapes, same contract as physics.overlapSphere (XZ footprint inside = hit)
function insideList(list, p, r) {
  for (let i = 0; i < list.length; i++) {
    const sh = list[i];
    if (p.x + r < sh.min.x || p.x - r > sh.max.x || p.z + r < sh.min.z || p.z - r > sh.max.z || p.y + r < sh.min.y || p.y - r > sh.max.y) continue;
    let dx, dz;
    if (sh.kind === 'aabb') { dx = p.x - clamp(p.x, sh.min.x, sh.max.x); dz = p.z - clamp(p.z, sh.min.z, sh.max.z); }
    else {
      const ox = p.x - sh.center.x, oz = p.z - sh.center.z;
      const lx = sh.c * ox - sh.s * oz, lz = sh.s * ox + sh.c * oz;
      dx = lx - clamp(lx, -sh.half.x, sh.half.x); dz = lz - clamp(lz, -sh.half.z, sh.half.z);
    }
    if (dx === 0 && dz === 0) return true;
    const dy = p.y - clamp(p.y, sh.min.y, sh.max.y);
    if (dx * dx + dz * dz + dy * dy <= r * r) return true;
  }
  return false;
}
const fbm = (t, o) => vnoise(t + o) * 0.72 + vnoise(t * 2.31 + o * 1.7 + 5.1) * 0.28;

function toVec(v, out = new THREE.Vector3()) {
  if (!v) return out.set(0, 0, 0);
  if (Array.isArray(v)) return out.set(v[0] || 0, v[1] || 0, v[2] || 0);
  return out.set(v.x || 0, v.y || 0, v.z || 0);
}

const camera = {
  name: 'camera',
  mode: 'follow',                 // 'follow' | 'fixed' | 'cinematic'
  entity: null,

  // --- spring arm (exploration): ~3.6 m back, lens at ~1.75 m, over the right shoulder
  yaw: 0, pitch: 0.07,
  distance: 3.9, height: 1.22, shoulder: 0.42,
  runDistance: 0.20,              // the arm stretches a little at a sprint
  // combatMax is capped at 6.4: coverage of a wide ring comes from pitch (behind-lens lift), not from distance
  combatMin: 3.8, combatMax: 6.4, combatClose: 3.0, combatHeight: 1.3, combatShoulder: 0.22, combatAngle: 0.33,
  combatDist: 4.2, combatDepth: 4.0, distCur: 3.9, side: 1, _wasCombat: false, swing: 0.33, behind: 0,
  minDistance: 1.25, probeRadius: 0.24, softRadius: 0.62, compression: 0,
  pitchMin: -0.42, pitchMax: 1.05,
  sensitivity: 0.0024,
  arm: 3.9, armSm: 3.9, armLimit: 99, armHold: 0, lift: 0, occLift: 0, _olV: { v: 0 }, shoulderCur: 0.42,

  // --- auto orbit
  autoOrbit: 2.9, autoOrbitDelay: 0.45,
  lookIdle: 99, lookAccum: new THREE.Vector2(),

  // --- framing / smoothing
  smoothPos: new THREE.Vector3(), smoothTarget: new THREE.Vector3(), initialised: false,
  vel: new THREE.Vector3(), prevPivot: new THREE.Vector3(),
  roll: 0, combat: false, target: null, _prevYaw: 0, _switchT: 0, surround: 0, _aimCap: Infinity,
  _pv: { x: { v: 0 }, y: { v: 0 }, z: { v: 0 } }, _yawV: { v: 0 }, _distV: { v: 0 }, _dcV: { v: 0 },

  // --- fov
  fovBase: 45, fovCombat: 47, fovAim: 45, fovSprint: 0, fovImpulse: 0, fovImpulseDecay: 6,

  // --- shake / punch. trauma falls linearly to 0 at shakeEnd (real seconds on this module's clock); a new shake
  //     only ever pushes shakeEnd later, so a jab landing inside a finisher's shake never cuts it short
  trauma: 0, shakeEnd: 0, now: 0, shakeT: 0, shakeFreq: 19,
  punchX: new THREE.Vector3(), punchV: new THREE.Vector3(),
  focusDistance: 5, _heatBusy: false,
  subjectRect: { x0: 0, y0: 0, x1: 0, y1: 0, on: false }, isCloseup: false,

  fixed: null, cine: null, _returnMode: 'follow', _preview: null, _blend: null,
  _occTags: null, _tagCacheLen: -1, _local: false, _localBroken: false, _verify: 400, _cand: null,
  stats: { clampFrames: 0, lensFixes: 0, flips: 0 },

  init(engine) {
    this.engine = engine;
    this.cam = engine.camera;
    this.fovAim = this.fovBase;
    this.arm = this.distance;
    if (engine.player) this.setFollow(engine.player);
    engine.events.on('combat:start', () => { this.combat = true; });
    engine.events.on('combat:end', () => { this.combat = false; this.target = null; });
    engine.events.on('combat:hit', (h) => {
      if (!h) return;
      const onPlayer = h.target && h.target.isPlayer;
      const dir = h.dir && h.dir.isVector3 ? h.dir : null;
      if (onPlayer) {
        this.fovKick(h.heavy ? 4.2 : 2.0, 5.5);
        if (dir) this.punch(dir, h.heavy ? 0.11 : 0.045);
      } else if (h.attacker && h.attacker.isPlayer) {
        this.fovKick(h.heavy ? -3.4 : -1.5, 7.5);
        // every rush hit gets its one-frame lurch along the hit axis, not only the heavies
        if (dir) this.punch(dir, h.heavy ? 0.07 : h.guarded ? 0.018 : 0.03);
      }
    });
    engine.events.on('combat:ko', (k) => { if (!(k && k.finale)) this.fovKick(-2.6, 4.2); });
    // the last man: combat.js starts the final blow (a heat action's own last KO keeps its own camera: heat:true)
    engine.events.on('combat:finale', (f) => { if (f && f.phase === 'start' && !f.heat && f.target) this.finalBlow(f.target, f.attacker, { finale: f }); });
    // a heat action owns the camera from its first cut to its own setFollow(); its KO must not start a second show
    engine.events.on('heat:action', () => { this._heatBusy = true; });
    engine.events.on('player:dodge', () => { this.fovKick(2.4, 6.5); this.shake(0.06, 0.18); });
    if (engine.params && engine.params.raw && engine.params.raw.camlab) {
      engine.events.on('engine:booted', () => this.lab().catch((err) => console.warn('[camera] lab failed', err)));
    }
  },

  // ?cutscene=hachiko&camlab=1 — live measurement in the chapter-1 fight through real key presses: solver re-aims and
  // worst lens acceleration in the brawl, rig drift during hit-stops (must be 0), the shake a rush produces, the
  // last-man shot, a heat action's hand-back (yaw lag, DOF focus), every camera:cut with its reason, update cost
  async lab() {
    const engine = this.engine, p = engine.player, en = engine.get('enemy');
    const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
    const key = async (code, hold = 0.07) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
      await wait(hold);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
    };
    for (let k = 0; k < 40 && engine.state.mode !== 'combat'; k++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }));
      await wait(0.5);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', key: 'Enter', bubbles: true }));
      await wait(0.3);
    }
    await wait(1.0);
    const list = ((en && en.list) || []).filter((x) => x.alive);
    if (!p || !list.length) { console.warn('[camlab] no fight, mode ' + engine.state.mode); return; }
    const T0 = performance.now(), ms = () => Math.round(performance.now() - T0);
    const L = this._lab = { stopFrames: 0, stopDrift: 0, stopYaw: 0, maxTrauma: 0, maxShakePx: 0, cuts: [], shots: [], ko: [] };
    const onCut = (c) => L.cuts.push(`${ms()} ${c.reason}`);
    engine.events.on('camera:cut', onCut);
    engine.events.on('combat:ko', (k) => L.ko.push(`${ms()} ko last=${!list.some((x) => x !== k.target && x.alive && x.aggro)} mode=${this.mode}`));
    // the real brawl first: all three men on him for 6 s while he throws a rush now and then, measuring how often the
    // solver re-aims and the worst lens acceleration (a hunting or popping rig shows up in both)
    L.acc = 0; L.v = null; L.p = null;
    const s0 = this.stats.aimSwitches || 0;
    for (let i = 0; i < 12; i++) { await key(i % 4 === 3 ? 'KeyK' : 'KeyJ'); await wait(0.45); }
    const brawl = { secs: 5.4, aimSwitches: (this.stats.aimSwitches || 0) - s0, maxLensAcc: +L.acc.toFixed(1), updateMsAvg: +((L.updSum || 0) / Math.max(1, L.updN || 0)).toFixed(3), updateMsMax: +(L.updMax || 0).toFixed(2), at: L.accInfo };
    const t = list[0];
    for (const x of list) if (x !== t) { x.aggro = false; x.cooldown = 99; x.position.x += 30; }
    p.yaw = Math.atan2(t.position.x - p.position.x, t.position.z - p.position.z);
    p.position.set(t.position.x - Math.sin(p.yaw) * 1.3, p.position.y, t.position.z - Math.cos(p.yaw) * 1.3);
    p.group.rotation.y = p.yaw; p.velocity.set(0, 0, 0);
    t.cooldown = 99; t.hp = t.hpMax = 400; engine.input.enabled = true;
    const cb = engine.get('combat');
    if (cb) cb.rng = () => 0.99;
    await wait(0.6);
    for (const code of ['KeyJ', 'KeyJ', 'KeyJ', 'KeyJ', 'KeyK']) { await key(code); await wait(0.17); }
    await wait(1.2);
    const rush = { aimSwitches: this.stats.aimSwitches || 0, secs: +(ms() / 1000).toFixed(1), stopFrames: L.stopFrames, stopDriftMm: +(L.stopDrift * 1000).toFixed(2), stopYawMrad: +(L.stopYaw * 1000).toFixed(3), maxTrauma: +L.maxTrauma.toFixed(3), maxShakePx: +L.maxShakePx.toFixed(1) };
    // the last man: low HP, a rush finishes him -> the slow-motion push-in, then the glide / cut back
    const face = () => {
      p.yaw = Math.atan2(t.position.x - p.position.x, t.position.z - p.position.z);
      p.position.set(t.position.x - Math.sin(p.yaw) * 1.2, p.position.y, t.position.z - Math.cos(p.yaw) * 1.2);
      p.group.rotation.y = p.yaw; p.velocity.set(0, 0, 0);
      if (t.setState && t.state !== 'dead') t.setState('idle');
      if (t.velocity) t.velocity.set(0, 0, 0);
    };
    face(); t.hp = 14; t.cooldown = 99; t.guardT = 0;
    await wait(0.5);
    for (let i = 0; i < 6 && t.alive; i++) { if (i === 3) face(); await key('KeyJ'); await wait(0.2); }
    const koMode = this.mode;
    await wait(1.6);
    // a live heat action on the next man (bicycle), then how far the yaw still travels after the hand-back
    let heat = 'skipped';
    const ha = engine.get('heatActions'), u = list[1];
    const bike = cb && cb.nearestWeapon ? cb.nearestWeapon(p.position, 40, 'bike') : null;
    if (ha && u && bike) {
      const bp = bike.body.position;
      u.position.set(bp.x + 1.6, u.position.y, bp.z + 0.6); u.aggro = false; u.cooldown = 99;
      await wait(1.2);                                   // he re-aggroes on his own (combat:start)
      p.yaw = Math.atan2(u.position.x - p.position.x, u.position.z - p.position.z);
      p.position.set(u.position.x - Math.sin(p.yaw) * 1.2, p.position.y, u.position.z - Math.cos(p.yaw) * 1.2);
      p.group.rotation.y = p.yaw; p.velocity.set(0, 0, 0);
      u.hp = u.hpMax = 60; u.cooldown = 99; p.heat = 100;
      await wait(0.4);
      const plan = ha.available(p, true);
      if (plan) { await key('KeyR'); await wait(0.2); }
      else {
        // no finisher in reach: the same hand-back path heatActions.finish takes (a cut shot, then setFollow)
        this.cinematic({ relativeTo: p, shots: [{ pos: [2.4, 1.2, 1.0], lookAt: [0, 1.2, 1.0], duration: 3, cut: true }] });
        await wait(0.5);
        this.setFollow(p);
      }
      const pf = engine.get('postfx');
      let focusErr = 0, focusN = 0;
      for (let i = 0; i < 100 && (ha.running || this.mode === 'cinematic'); i++) {
        if (pf && pf._dofManual && this.mode === 'cinematic') { focusErr = Math.max(focusErr, Math.abs(pf.focus - this.cam.position.distanceTo(this.smoothTarget))); focusN++; }
        await wait(0.1);
      }
      L.focus = `samples=${focusN} maxErr=${focusErr.toFixed(3)}`;
      await wait(0.05);
      const lag0 = Math.abs(wrap(this.yaw - (this._desiredYaw || this.yaw))), y0 = this.yaw, d0 = this._desiredYaw || 0; const a0 = `${this._aimSide}/${this._aimSwing}`;
      await wait(0.6);
      const lag1 = Math.abs(wrap(this.yaw - (this._desiredYaw || this.yaw)));
      heat = `${plan ? plan.name : 'simulated'} mode=${engine.state.mode} lagAtReturnMrad=${Math.round(lag0 * 1000)} lag600msMrad=${Math.round(lag1 * 1000)} yawMoved=${Math.round(Math.abs(wrap(this.yaw - y0)) * 1000)} aimMoved=${Math.round(Math.abs(wrap((this._desiredYaw || 0) - d0)) * 1000)} aim=${a0}->${this._aimSide}/${this._aimSwing}`;
    }
    engine.events.off('camera:cut', onCut);
    this._lab = null;
    console.info('[camlab] ' + JSON.stringify({ brawl, rush, koShot: koMode, afterKo: this.mode, heat, dofFocus: L.focus, cuts: L.cuts, ko: L.ko }));
  },

  // THE FINAL BLOW (timing and every number in combat/finalBlow.js). No cut, no bars: from wherever the gameplay rig
  // is, the lens whips in (quartic ease-out, 0.15 s) to a close shot on the VICTIM — waist-up on a long lens, his face
  // and 健人's striking fist in frame, 2.0-2.8 m off, just under his eye line looking a touch up, a small Dutch roll —
  // on the side of the pair where 健人's chest (a hook twists it well off his hips) reads 3/4 to the lens, with the
  // least light behind the contact and nothing standing in the way now or where the blow will carry him. While time
  // is slowed it creeps in and orbits round him, tracking his chest as he is launched, then eases back to the gameplay
  // framing as time returns. The follow rig keeps running underneath: this is a weighted overlay on its pose, so the
  // return lands exactly on the live framing, travelling on an arc round him (never through him or 健人). Every lens
  // position is slid clear of facades, planters, parked cars and both men.
  finalBlow(target, attacker, opts = {}) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const r = this._finalBlow(target, attacker, opts);
    if (r && typeof performance !== 'undefined') this._fbMs = +(performance.now() - t0).toFixed(2);
    return r;
  },
  _finalBlow(target, attacker, opts = {}) {
    const engine = this.engine, p = engine.player, FB = FINAL_BLOW;
    if (!p || !target || target === p || target.kind === 'player' || target.isPlayer || !target.position) return false;
    if (this.mode !== 'follow' || this._heatBusy || engine.state.mode === 'cutscene' || engine.state.mode === 'paused') return false;
    const ha = engine.get('heatActions');
    if (ha && ha.running) return false;
    if (attacker && attacker !== p && !opts.force) return false;
    if (p.position.distanceToSquared(target.position) > 9 * 9) return false;
    const cb = engine.get('combat'), fin = opts.finale || (cb && cb.finale);
    const P = p.position, V = target.position;
    const bw = (h, name, out, fx, fy, fz) => (h && typeof h.boneWorld === 'function' ? h.boneWorld(name, out) : out.set(fx, fy, fz));
    const th = target.humanoid, ph = p.humanoid;
    // the pair axis at the contact (健人 -> him, flat) and its two sides
    const u = new THREE.Vector3(V.x - P.x, 0, V.z - P.z);
    if (u.lengthSq() < 1e-6) u.set(Math.sin(p.yaw || 0), 0, Math.cos(p.yaw || 0));
    u.normalize();
    const s = new THREE.Vector3(u.z, 0, -u.x);
    const K = fin && fin.point && fin.point.isVector3 ? fin.point.clone() : this.contactPoint(target, p, new THREE.Vector3());
    const vHead = bw(th, 'Head', new THREE.Vector3(), V.x, V.y + 1.62, V.z);
    const vUp = bw(th, 'Spine2', new THREE.Vector3(), V.x, V.y + 1.35, V.z).lerp(vHead, 0.6);
    const pHead = bw(ph, 'Head', new THREE.Vector3(), P.x, P.y + 1.62, P.z);
    let fist = K.clone(), strikeSide = -1;                          // -1: the lens on 健人's right (a right hand / foot)
    if (cb && cb.activeOf) {
      const a = cb.activeOf(p), bone = a && a.hits && a.hits.length ? a.hits[0].bone || 'RightHand' : null;
      if (bone) { bw(ph, bone, fist, K.x, K.y, K.z); if (/^Left/.test(bone)) strikeSide = 1; }
    }
    // 健人's chest normal (up x the shoulder line toward his right hand) and which way the man is facing
    let chx = u.x, chz = u.z;
    if (ph && typeof ph.boneWorld === 'function') {
      ph.boneWorld('LeftArm', _a); ph.boneWorld('RightArm', _b);
      const x = _b.z - _a.z, z = -(_b.x - _a.x), L = Math.hypot(x, z);
      if (L > 1e-3) { chx = x / L; chz = z / L; }
    }
    const vy = target.yaw != null ? target.yaw : Math.atan2(-u.x, -u.z);
    const vfx = Math.sin(vy), vfz = Math.cos(vy);
    // where the blow carries him (knockback v0 = 6 d, most of it spent inside the slow motion)
    const tv = new THREE.Vector3(target.velocity ? target.velocity.x : 0, 0, target.velocity ? target.velocity.z : 0);
    const travel = clamp(tv.length() / 6 * 0.9, 0, 3.5);
    if (tv.lengthSq() > 1e-6) tv.normalize(); else tv.copy(u);
    const Vend = new THREE.Vector3(V.x, V.y, V.z).addScaledVector(tv, travel);
    const look0 = new THREE.Vector3();
    const sight = this.sightList(P, Vend).slice();
    // a few extra shapes where he will land
    if (travel > 1.5) for (const sh of this.sightList(V, Vend)) if (!sight.includes(sh)) sight.push(sh);
    const cam = this._probeCam || (this._probeCam = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 400));
    cam.aspect = this.cam.aspect; cam.fov = FB.fovIn; cam.updateProjectionMatrix();
    const tanIn = Math.tan((FB.fovIn * Math.PI) / 360);
    const orbit = (FB.orbit * Math.PI) / 180;
    const lens = (foot, R, beta, sg, out) => out.set(
      foot.x + R * (-Math.cos(beta) * u.x + Math.sin(beta) * sg * s.x), V.y + FB.height,
      foot.z + R * (-Math.cos(beta) * u.z + Math.sin(beta) * sg * s.z));
    let best = null, bestCost = Infinity;
    const log = [];
    const C = new THREE.Vector3(), Ce = new THREE.Vector3(), lookE = new THREE.Vector3();
    for (let sg = -1; sg <= 1; sg += 2) {
      if (opts.side && sg !== opts.side) continue;
      for (const dR of KO_DIST) for (const beta of KO_BEARING) {
        const R = FB.dist + dR;
        lens(V, R, beta, sg, C);
        // 健人's face 3/4 to the lens (45 deg off his chest), the man's face no more than just past profile
        const ex = C.x - pHead.x, ez = C.z - pHead.z, el = Math.hypot(ex, ez) || 1;
        const aHero = Math.acos(clamp((ex * chx + ez * chz) / el, -1, 1));
        const vx = C.x - V.x, vz = C.z - V.z, vl = Math.hypot(vx, vz) || 1;
        const aVic = Math.acos(clamp((vx * vfx + vz * vfz) / vl, -1, 1));
        let cost = Math.abs(aHero - Math.PI / 4) * 1.1 + Math.max(0, aVic - 1.45) * 1.5 + Math.abs(beta - 1.65) * 0.25 + Math.abs(dR) * 0.4;
        if (sg !== strikeSide) cost += 0.35;                          // the striking arm on the lens side, not behind him
        cost += Math.min(2, this.backlight(C, K, 25 * Math.PI / 180) / 900);
        cost += this.sightCost(C, p, target, sight);
        if (this.insideOccluder(C, 0.35)) cost += 8;
        if (!this.segmentClear(vUp, C)) cost += 6;
        // where the lens will be once he has flown: whichever way the orbit goes clear, it goes
        let bestO = 1, oc = Infinity;
        for (let so = -1; so <= 1; so += 2) {
          lens(Vend, R - FB.dolly, beta + so * orbit, sg, Ce);
          lookE.set(Vend.x, Vend.y + 1.0, Vend.z);
          let c = 0;
          if (this.insideOccluder(Ce, 0.35) || insideList(sight, Ce, 0.35)) c += 4;
          if (!this.segmentClear(lookE, Ce)) c += 3;
          c += so < 0 ? 0 : 0.05;                                   // tie-break: toward his front (his face opens up)
          if (c < oc) { oc = c; bestO = so; }
        }
        cost += oc;
        // framing through this lens: his neck on the upper third, away from the side the fist comes in from; his head
        // (with room above it), the contact and the fist must sit inside the frame, 健人's face is a bonus at the edge.
        // The field of view widens toward fovMax only if they do not fit.
        cam.position.copy(C); cam.up.set(0, 1, 0); cam.lookAt(vUp); cam.updateMatrixWorld(true);
        _a.copy(fist).project(cam); _b.copy(vUp).project(cam);
        const hx = (_a.x <= _b.x ? 1 : -1) * FB_PLACE[0];
        fbAim(C, vUp, hx, FB_PLACE[1], FB.fovIn, cam.aspect, look0);
        cam.lookAt(look0); cam.updateMatrixWorld(true);
        let need = 0, behind = 0;
        const pts = [[vHead.x, vHead.y + 0.16, vHead.z, 0.84, 0.82], [K.x, K.y, K.z, 0.86, 0.84], [fist.x, fist.y, fist.z, 0.86, 0.84]];
        for (const q of pts) {
          _b.set(q[0], q[1], q[2]).project(cam);
          if (_b.z > 1) { behind++; continue; }
          need = Math.max(need, Math.abs(_b.x) / q[3], Math.abs(_b.y) / q[4]);
        }
        const fovNeed = (2 * Math.atan(tanIn * Math.max(need, 1e-3)) * 180) / Math.PI;
        // 健人's face is wanted at the edge of the frame: the lens may widen for it too, but never past fovMax
        _b.set(pHead.x, pHead.y + 0.08, pHead.z).project(cam);
        const needP = _b.z > 1 ? 9 : Math.max(Math.abs(_b.x) / 0.95, Math.abs(_b.y) / 0.9);
        const fovP = (2 * Math.atan(tanIn * needP) * 180) / Math.PI;
        const fov = clamp(Math.max(fovNeed, Math.min(fovP, FB.fovMax)), FB.fovIn, FB.fovMax);
        cost += behind * 20 + Math.max(0, fovNeed - FB.fovMax) * 0.3 + Math.min(1.2, Math.max(0, needP * tanIn / Math.tan((fov * Math.PI) / 360) - 1) * 2);
        log.push(`${sg}/${R.toFixed(1)}/${beta}:${cost.toFixed(2)}`);
        if (cost < bestCost) { bestCost = cost; best = { sg, R, beta, fov, so: bestO, hx }; }
      }
    }
    if (!best) return false;
    this._koLight = { pick: `${best.sg}/${best.R.toFixed(1)}/${best.beta}/o${best.so}`, fov: +best.fov.toFixed(1), cost: +bestCost.toFixed(2), all: log.join(' ') };
    // the Dutch roll leans the frame so his flight runs downhill (positive roll = the right side of the frame goes down)
    lens(V, best.R, best.beta, best.sg, C);
    fbAim(C, vUp, best.hx, FB_PLACE[1], best.fov, cam.aspect, look0);
    cam.position.copy(C); cam.lookAt(look0); cam.updateMatrixWorld(true);
    _a.set(V.x, V.y + 1.2, V.z).project(cam); _b.set(Vend.x, Vend.y + 1.2, Vend.z).addScaledVector(tv, 0.5).project(cam);
    const rollSign = _b.x - _a.x >= 0 ? 1 : -1;
    const F = this._fb = {
      target, p, t: 0, w: 0, u, s, sg: best.sg, R: best.R, beta: best.beta, so: best.so, fov: best.fov, hx: best.hx,
      rollRad: (rollSign * FB.roll * Math.PI) / 180, track: vUp.clone(), head: vHead.clone(), foot: new THREE.Vector3(V.x, V.y, V.z),
      sight, dof: false, hud: false, hudBack: false, still: !!(cb && cb.finaleStillAt != null),
    };
    this.fbState = { t: 0, w: 0, fov: this.cam.fov, dist: 0 };
    // one hard kick along the blow and a short, tight rumble; the rig's own springs and a pending glide are dropped
    this._blend = null;
    this.fovImpulse = 0;
    this.trauma = FB.trauma; this.shakeEnd = this.now + 0.25;
    this.punchX.set(0, 0, 0); this.punchV.set(0, 0, 0);
    this.punch(fin && fin.dir && fin.dir.isVector3 ? fin.dir : u, FB.kick);
    // the HUD steps out of the close shot (not the bars, not a stamp: the moment is the picture) ...
    this.fbHud(true);
    // ... and a portrait lens: the street behind him melts, both men stay sharp
    const pf = engine.get('postfx');
    if (pf && typeof pf.setDOF === 'function' && !pf._dofManual && !(engine.params && engine.params.raw && engine.params.raw.fbdof === '0')) {
      try { pf.setDOF(true, { focus: best.R, range: 2.2, strength: 0.6 }); F.dof = !!pf._dofManual; } catch (_) { /* cosmetic */ }
    }
    if (engine.params && engine.params.raw && engine.params.raw.camdbg) console.info(`[camdbg] finalBlow ${JSON.stringify(this._koLight)}`);
    try { engine.events.emit('camera:finalBlow', { duration: fbEnd(), target, attacker: p, still: F.still }); } catch (_) { /* listeners */ }
    return true;
  },

  fbHud(on) {
    const hud = this.engine.get('hud'), root = hud && hud.root, F = this._fb;
    if (!root || typeof document === 'undefined' || !document.getElementById('hx-cine-style')) return;
    if (on && !root.classList.contains('cine')) { root.classList.add('cine'); if (F) F.hud = true; }
    else if (!on && F && F.hud) { root.classList.remove('cine'); F.hud = false; }
  },

  endFinalBlow() {
    const F = this._fb;
    if (!F) return;
    this.fbHud(false);
    const pf = this.engine.get('postfx');
    if (F.dof && pf && typeof pf.setDOF === 'function') { try { pf.setDOF(false); } catch (_) { /* cosmetic */ } }
    this._fb = null;
    this.fbState = null;
  },

  // slide a staged lens toward what it looks at until it is in open air: facades first (the arm's own occluders), then
  // the street furniture round the pair (planters, benches, parked cars), then the ground; and never inside either man
  // (a 0.6 m column round each, pushed straight out)
  fbClear(look, pos, list, men) {
    this.pullShot(look, pos);
    const world = this.engine.world;
    const bis = (test) => {
      if (!test(pos)) return;
      _fbT.copy(pos);
      let lo = 0, hi = 0.85;
      for (let i = 0; i < 7; i++) { const mid = (lo + hi) * 0.5; _fbA.lerpVectors(_fbT, look, mid); if (test(_fbA)) lo = mid; else hi = mid; }
      pos.lerpVectors(_fbT, look, hi);
    };
    if (list && list.length) bis((q) => insideList(list, q, LENS_R + 0.05));
    if (world) bis((q) => this.insideOccluder(q, LENS_R));
    if (men) for (const m of men) {
      if (!m || !m.position || pos.y > m.position.y + 2.1) continue;
      const dx = pos.x - m.position.x, dz = pos.z - m.position.z, dl = Math.hypot(dx, dz);
      if (dl >= 0.6) continue;
      const k = dl > 1e-3 ? 0.6 / dl : 0;
      if (k) { pos.x = m.position.x + dx * k; pos.z = m.position.z + dz * k; } else pos.x += 0.6;
    }
    if (world) { const gy = world.groundHeight(pos.x, pos.z); if (pos.y < gy + 0.3) pos.y = gy + 0.3; }
  },

  // per frame, on top of the follow rig's pose (called from update, before the roll and the shake are applied)
  applyFinalBlow(dt, roll) {
    const F = this._fb, engine = this.engine, cam = this.cam, FB = FINAL_BLOW;
    const cb = engine.get('combat'), fin = cb && cb.finale;
    if (fin && fin.target === F.target) F.t = fin.t; else F.t += dt;      // the combat clock, our own once it is over
    if (this.mode !== 'follow' || F.t >= fbEnd() || !F.target.position) { this.endFinalBlow(); return roll; }
    const w = fbCam(F.t);
    if (!F.hudBack && F.t >= FB.freeze + FB.hold) { F.hudBack = true; this.fbHud(false); }
    // tracking: his upper chest and his feet, eased like an operator following him (exact during the freeze)
    const th = F.target.humanoid;
    if (th && typeof th.boneWorld === 'function') { th.boneWorld('Spine2', _fbA); th.boneWorld('Head', _fbB); _fbA.lerp(_fbB, 0.6); }
    else { _fbA.set(F.target.position.x, F.target.position.y + 1.45, F.target.position.z); _fbB.copy(_fbA); _fbB.y += 0.2; }
    const k = F.t < FB.freeze || F.still ? 1 : damp(9, dt);
    F.track.lerp(_fbA, k); F.head.lerp(_fbB, k);
    F.foot.x += (F.target.position.x - F.foot.x) * k; F.foot.z += (F.target.position.z - F.foot.z) * k;
    // the drift: a slow dolly-in and an orbit round him
    const d = fbDrift(F.t), orbit = (FB.orbit * Math.PI) / 180;
    const beta = F.beta + F.so * orbit * d, R = F.R - FB.dolly * d;
    const ux = F.u.x, uz = F.u.z, sx = F.s.x * F.sg, sz = F.s.z * F.sg;
    _fbC.set(F.foot.x + R * (-Math.cos(beta) * ux + Math.sin(beta) * sx), F.foot.y + FB.height, F.foot.z + R * (-Math.cos(beta) * uz + Math.sin(beta) * sz));
    // the look: his neck held on its NDC mark (drifting toward the centre as the fist is left behind)
    const men = F.men || (F.men = [F.target, F.p]);
    this.fbClear(F.track, _fbC, F.sight, men);
    fbAim(_fbC, F.track, F.hx * (1 - 0.6 * d), FB_PLACE[1], F.fov, cam.aspect, _fbL);
    // blend with the gameplay pose the follow rig produced this frame (look point at the same depth as the close one).
    // The lens travels on an ARC round him (azimuth, radius and height interpolated, swinging a little wider in the
    // middle of a long swing), never on the straight line, which can run straight through him or 健人.
    cam.getWorldDirection(_fbA);
    const depth = Math.max(1, _fbB.subVectors(_fbL, cam.position).dot(_fbA));
    _fbB.copy(cam.position).addScaledVector(_fbA, depth);
    const fovG = cam.fov;
    if (w < 1) {
      const ax = F.track.x, az = F.track.z;
      const gx = cam.position.x - ax, gz = cam.position.z - az, cx = _fbC.x - ax, cz = _fbC.z - az;
      const rg = Math.hypot(gx, gz), rc = Math.hypot(cx, cz);
      const tg = Math.atan2(gx, gz), dth = wrap(Math.atan2(cx, cz) - tg);
      const a = tg + dth * w, r = rg + (rc - rg) * w + 4 * w * (1 - w) * 0.45 * Math.abs(dth) / Math.PI;
      cam.position.set(ax + Math.sin(a) * r, cam.position.y + (_fbC.y - cam.position.y) * w, az + Math.cos(a) * r);
      _fbB.lerp(_fbL, w);
      this.fbClear(_fbB, cam.position, F.sight, men);                      // the blend must not cut a wall either
    } else { cam.position.copy(_fbC); _fbB.copy(_fbL); }
    cam.up.set(0, 1, 0);
    cam.lookAt(_fbB);
    const fov = fovG + (F.fov - fovG) * w;
    const near = this.nearFor(0.1, cam.position, !!engine.world);
    if (Math.abs(cam.fov - fov) > 1e-3 || near !== cam.near) { cam.fov = fov; cam.near = near; cam.updateProjectionMatrix(); }
    this.focusDistance = cam.position.distanceTo(F.head);
    const pf = F.dof ? engine.get('postfx') : null;
    if (pf && pf._dofManual) pf.focus = this.focusDistance;
    F.w = w;
    const st = this.fbState || (this.fbState = {});
    st.t = F.t; st.w = w; st.fov = fov; st.dist = Math.hypot(cam.position.x - F.target.position.x, cam.position.z - F.target.position.z);
    // the Dutch roll swings further as the lens orbits round him, and back
    const rollF = F.rollRad + Math.sign(F.rollRad) * (FB.rollSwing * Math.PI / 180) * Math.sin(Math.PI * d);
    return roll + (rollF - roll) * w;
  },

  // how much light sits behind `at` seen from `from`: lighting's fixtures (street heads, sign spill, shop fronts)
  // within `cone` rad of the view ray and beyond the subject, weighted by intensity, falling off with range
  backlight(from, at, cone) {
    const lg = this.engine.get('lighting'), fx = lg && lg.fixtures;
    if (!fx || !fx.length) return 0;
    _tmp.subVectors(at, from);
    const D = _tmp.length();
    if (D < 1e-3) return 0;
    _tmp.multiplyScalar(1 / D);
    const cc = Math.cos(cone);
    let sum = 0;
    for (let i = 0; i < fx.length; i++) {
      const q = fx[i].pos;
      if (!q) continue;
      const vx = q.x - from.x, vy = q.y - from.y, vz = q.z - from.z;
      const L = Math.hypot(vx, vy, vz);
      if (L < D || L > 240) continue;
      const k = (vx * _tmp.x + vy * _tmp.y + vz * _tmp.z) / L;
      if (k < cc) continue;
      sum += (fx[i].intensity || 40) * (0.4 + 0.6 * (k - cc) / (1 - cc)) / (1 + L / 40);
    }
    return sum;
  },

  // every visible collider that can stand between a close lens and the two men (facades, planters, benches,
  // poles, parked cars, tree trunks), gathered once round the pair
  sightList(P, T) {
    const world = this.engine.world;
    const out = this._sight || (this._sight = []);
    out.length = 0;
    if (!world || !world.overlapSphere || !world.statics) return out;
    if (!this._viewTags || this._viewTagsLen !== world.statics.length) {
      const set = new Set();
      for (const st of world.statics) if (st && !VIEW_SKIP.has(st.tag)) set.add(st.tag);
      this._viewTags = Array.from(set); this._viewTagsLen = world.statics.length;
    }
    _c.set((P.x + T.x) * 0.5, P.y + 1, (P.z + T.z) * 0.5);
    const hits = world.overlapSphere(_c, 9, { tags: this._viewTags }) || NO_HITS;
    for (const h of hits) {
      const sh = h.shape;
      if (!sh || !sh.min || !sh.max || !(sh.kind === 'aabb' || (sh.kind === 'obb' && sh.half && sh.center))) continue;
      // a street-level block (planter, bench, plinth) is drawn with its shrub / statue / clutter on top of the
      // collider: seen from a low lens it is 0.8 m taller and a little wider than the box
      if (sh.max.y - sh.min.y < 1.8) {
        const g = { kind: sh.kind, tag: sh.tag, min: sh.min.clone(), max: sh.max.clone(), c: sh.c, s: sh.s };
        g.max.y += 0.8; g.min.x -= 0.15; g.min.z -= 0.15; g.max.x += 0.15; g.max.z += 0.15;
        if (sh.kind === 'obb') { g.center = sh.center.clone(); g.center.y += 0.4; g.half = sh.half.clone(); g.half.x += 0.15; g.half.z += 0.15; g.half.y += 0.4; }
        out.push(g);
      } else out.push(sh);
    }
    return out;
  },

  // cost of a lens at C: hugging a collider (it would fill the frame), and sightlines to the two men's heads,
  // chests and knees cut by one
  sightCost(C, p, t, list) {
    let cost = 0;
    if (insideList(list, C, 0.9)) cost += 6;
    for (let m = 0; m < 2; m++) {
      const who = m ? t : p;
      for (let k = 0; k < 3; k++) {
        const hy = k === 0 ? 1.65 : k === 1 ? 1.25 : 0.5;
        _ray.set(who.position.x - C.x, who.position.y + hy - C.y, who.position.z - C.z);
        const L = _ray.length();
        if (L < 0.5) continue;
        _ray.multiplyScalar(1 / L);
        if (rayList(list, C, _ray, L - 0.3) < L - 0.3) cost += k < 2 ? 1.2 : 0.6;
      }
    }
    return cost;
  },

  // player_closeup: the camera's own character shot. Chest-up on a long lens (fov 29, 2.2 m out, lens 1.42 m high,
  // just under his eye line) 3/4 in front of him, his eye line on the upper third and at 0.38 of the frame width
  // with the lead room ahead of him (or the mirror, 0.62 looking left). Orbits within ±0.42 rad of both are
  // scored for bystander heads landing within 8 % of his silhouette (the crowd where it stands now and where it
  // will have walked by the capture), people between the lens and him or looming at the frame edge, walls, and
  // light behind his head. The chosen lens is pinned and gets a portrait depth of field.
  frameCloseup(e) {
    const engine = this.engine, P = e.position, h = e.humanoid;
    const FOV = 29, OUT = 2.2, LENS_Y = 1.42, AIM_X = -0.24, AIM_Y = 0.3;
    const yaw = e.yaw != null ? e.yaw : (e.group ? e.group.rotation.y : 0);
    const eye = new THREE.Vector3();
    if (h && h.boneWorld) { h.boneWorld('Head', eye); eye.y += 0.07; } else eye.set(P.x, P.y + 1.7, P.z);
    const cam = this._probeCam || (this._probeCam = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 400));
    cam.fov = FOV; cam.aspect = this.cam.aspect; cam.updateProjectionMatrix();
    // bystander heads within 22 m: crowd (now, +2.5 s, +5 s along their heading unless they stand) and enemies
    const heads = [];
    const crowd = engine.get('crowd');
    if (crowd && Array.isArray(crowd.peds)) {
      for (const q of crowd.peds) {
        if (q == null || q.x == null) continue;
        const dx = q.x - P.x, dz = q.z - P.z;
        if (dx * dx + dz * dz > 22 * 22) continue;
        const hy = (engine.world ? engine.world.groundHeight(q.x, q.z) : 0) + 1.58 * (q.scale || 1);
        const walks = q.kind !== 'idler' && q.speed > 0;
        for (let k = 0; k < (walks ? 3 : 1); k++) {
          const t = k * 2.5, sx = Math.sin(q.yaw || 0), sz = Math.cos(q.yaw || 0);
          heads.push(q.x + sx * q.speed * t, hy, q.z + sz * q.speed * t);
        }
      }
    }
    const en = engine.get('enemy');
    if (en && en.list) for (const x of en.list) if (x.alive && x.group && x.group.visible !== false) heads.push(x.position.x, x.position.y + 1.62, x.position.z);
    const tags = this.occluderTags();
    let best = null, bestCost = Infinity;
    const C = new THREE.Vector3(), Tg = new THREE.Vector3(), bestC = new THREE.Vector3(), bestT = new THREE.Vector3();
    const log = [];
    // m = 1: lens off his right, he looks screen-right from 0.38; m = -1: the mirror (0.62, looking left)
    for (let m = 1; m >= -1; m -= 2) for (const dl of [0, 0.15, -0.15, 0.3, -0.3, 0.42]) {
      const b = yaw - m * (0.6 - dl), aimX = AIM_X * m;
      C.set(P.x + Math.sin(b) * OUT, P.y + LENS_Y, P.z + Math.cos(b) * OUT);
      let cost = Math.abs(dl) * 2.5 + (m < 0 ? 0.6 : 0);
      if (engine.world && tags) {
        if (this.insideOccluder(C, 0.3)) continue;
        _tmp.subVectors(eye, C); const L = _tmp.length(); _tmp.multiplyScalar(1 / L);
        if (this.castLen(C, _tmp, L) < L - 0.05) continue;
      }
      // aim so his eye line lands at (AIM_X, AIM_Y): a few Newton steps on the look target
      Tg.copy(eye);
      cam.position.copy(C);
      for (let it = 0; it < 5; it++) {
        cam.lookAt(Tg); cam.updateMatrixWorld(true);
        _a.copy(eye).project(cam);
        const d = C.distanceTo(eye), tV = Math.tan((FOV * Math.PI) / 360), tH = tV * cam.aspect;
        _cr.setFromMatrixColumn(cam.matrixWorld, 0); _cu.setFromMatrixColumn(cam.matrixWorld, 1);
        Tg.addScaledVector(_cr, (_a.x - aimX) * d * tH).addScaledVector(_cu, (_a.y - AIM_Y) * d * tV);
      }
      cam.lookAt(Tg); cam.updateMatrixWorld(true);
      // his silhouette box in NDC: head top, shoulders at chest height, down to the frame edge
      let x0 = 9, x1 = -9, y1 = -9;
      _cr.setFromMatrixColumn(cam.matrixWorld, 0);
      for (let i = 0; i < 3; i++) {
        if (i === 0) _a.set(eye.x, eye.y + 0.16, eye.z); else _a.set(P.x, P.y + 1.42, P.z).addScaledVector(_cr, i === 1 ? -0.3 : 0.3);
        _a.project(cam);
        x0 = Math.min(x0, _a.x); x1 = Math.max(x1, _a.x); y1 = Math.max(y1, _a.y);
      }
      const dP = C.distanceTo(eye);
      let nB = 0, nE = 0, nT = 0;
      for (let i = 0; i < heads.length; i += 3) {
        _a.set(heads[i], heads[i + 1], heads[i + 2]);
        const dz = _a.distanceTo(C);
        if (dz < 0.5) { cost += 20; continue; }
        _a.project(cam);
        if (_a.z > 1 || Math.abs(_a.x) > 1.1 || Math.abs(_a.y) > 1.1) continue;
        if (dz < dP && _a.x > x0 - 0.1 && _a.x < x1 + 0.1) { cost += 20; nB++; continue; }  // someone between the lens and him
        if (dz < 4.5) { cost += (4.5 - dz) * 1.5; nE++; }                                   // a big half-figure at the edge
        const gx = Math.max(0, x0 - _a.x, _a.x - x1) * 0.5, gy = Math.max(0, _a.y - y1) * 0.5;
        const g = Math.max(gx, gy);
        if (g === 0) continue;                                                            // behind him: hidden
        if (g < 0.08) { cost += (0.08 - g) * 40 * (dz < 8 ? 1.5 : 1); nT++; }
      }
      const bl = this.backlight(C, eye, 12 * Math.PI / 180) * 0.012;
      cost += bl;
      const fc = engine.params && engine.params.raw && engine.params.raw.cucand;       // debug: ?cucand=<m*10+delta>
      if (fc != null && Math.abs(+fc - (m * 10 + dl)) > 1e-3) cost += 1000;
      log.push(`${m}/${dl}:${cost.toFixed(1)}(bl${bl.toFixed(1)} b${nB} e${nE} t${nT})`);
      if (cost < bestCost) { bestCost = cost; best = m * 10 + dl; bestC.copy(C); bestT.copy(Tg); }
    }
    if (best == null) return false;
    this._closeupReport = { log: log.join(' '), pick: best, cost: +bestCost.toFixed(3), heads: heads.length / 3, P: [P.x.toFixed(2), P.z.toFixed(2)], yaw: +yaw.toFixed(3) };
    if (engine.params && engine.params.raw && engine.params.raw.camdbg) console.info(`[camdbg] closeup ${JSON.stringify(this._closeupReport)}`);
    this.setFixed(bestC, bestT, { fov: FOV });
    // a portrait lens: the crowd behind him falls out of focus, he stays sharp head to belt
    const pf = engine.get('postfx');
    if (pf && typeof pf.setDOF === 'function' && !(engine.params && engine.params.raw && engine.params.raw.cudof === '0')) {
      try { pf.setDOF(true, { focus: bestC.distanceTo(eye), range: 1.0, strength: 0.85 }); } catch (_) { /* cosmetic */ }
    }
    return true;
  },

  // --------------------------------------------------------------------------------------------- modes
  setFixed(pos, lookAt, opts = {}) {
    this.stopCinematic();
    this.mode = 'fixed';
    this._returnMode = 'fixed';
    this._blend = null;
    this._hold = null;
    this.fixed = { pos: toVec(pos, new THREE.Vector3()), lookAt: toVec(lookAt, new THREE.Vector3()), fov: opts.fov || 45 };
    this.cam.position.copy(this.fixed.pos);
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(this.fixed.lookAt);
    this.cam.fov = this.fixed.fov;
    this.cam.near = this.nearFor(0.2, this.fixed.pos, !!this.engine.world);
    this.cam.updateProjectionMatrix();
    this.fovAim = this.fixed.fov; this.fovSprint = 0; this.fovImpulse = 0;
    this.smoothPos.copy(this.fixed.pos); this.smoothTarget.copy(this.fixed.lookAt);
    this.roll = 0;
    this.emitCut('fixed');
    // the canonical critic view of a fight is the LIVE combat rig (swung axis, midpoint pivot, fit), not a lens
    // hand-placed behind his back: take the rig back once combat has staged the tableau (engine:booted) and two
    // frames have run (?anim= pose stills and the heat tableau keep the side views their owners stage for them).
    // The plain player_closeup gets the camera's own character shot the same way.
    const eng = this.engine, prm = eng && eng.params;
    if (prm && prm.shot === 'combat' && !prm.anim && !prm.heat && eng.state.mode === 'combat' && !this._combatPreviewed) {
      this._combatPreviewed = true;
      this._preview = { combat: true, settle: 240, wait: 2, staged: true, verify: true, post: () => this.recentreImpact() };
    } else if (prm && prm.shot === 'player_closeup' && !prm.anim && !this._closeupPreviewed) {
      this._closeupPreviewed = true;
      this._preview = { closeup: true, wait: 2 };
    }
  },

  // a staged still holds postfx's radial impact blur; its centre was projected through whatever lens was up when
  // the blow was staged. Re-project the contact (not his chest) through the lens the still is actually taken with,
  // without firing a second hit (onHit would add a flash and restart the radial).
  recentreImpact() {
    const pf = this.engine.get('postfx'), t = this.target;
    if (!pf || !pf.hold || !t) return;
    this.contactPoint(t, this.entity, _a);
    this.cam.updateMatrixWorld(true);
    _a.project(this.cam);
    if (!(_a.z < 1)) return;
    if (typeof pf.setRadialCenter === 'function') pf.setRadialCenter(_a.x, _a.y);
    else if (pf._radialCenter && pf._radialCenter.set) pf._radialCenter.set(_a.x * 0.5 + 0.5, _a.y * 0.5 + 0.5);
  },

  // where a blow on `tgt` lands: combat's published contact if it has one, else his head pulled 35 % toward the
  // striking fist (combat's own staging rule), else root + 1.55
  contactPoint(tgt, att, out) {
    const cb = this.engine.get('combat');
    const hp = cb && (cb.stageHitPoint || cb.lastHitPoint);
    if (hp && hp.isVector3) return out.copy(hp);
    const h = tgt && tgt.humanoid;
    if (h && typeof h.boneWorld === 'function') {
      h.boneWorld('Head', out);
      if (att && att.humanoid && typeof att.humanoid.boneWorld === 'function') out.lerp(att.humanoid.boneWorld('RightHand', _bw), 0.35);
      return out;
    }
    return out.set(tgt.position.x, tgt.position.y + 1.55, tgt.position.z);
  },

  setFollow(entity, opts = {}) {
    const wasFollowing = this.mode === 'follow' && !this.cine;
    const wasFixed = this.mode === 'fixed';
    // leaving a cinematic or a pinned view is a hard cut: temporal effects must drop their history
    if (!wasFollowing) this.emitCut('follow');
    this.stopCinematic();
    this._hold = null;
    this.entity = entity || this.entity;
    this.mode = 'follow';
    this._returnMode = 'follow';
    this.fixed = null;
    if (wasFixed) this.fovImpulse = 0;
    if (opts.distance) this.distance = opts.distance;
    if (opts.height != null) this.height = opts.height;
    if (opts.shoulder != null) this.shoulder = opts.shoulder;
    if (this.entity) {
      // coming back from a staged view: sit behind him, not wherever the rig was before the cutscene. In a fight
      // the first follow frame then snaps yaw, swing and fit distance to the settled combat framing (frameCombat /
      // fitCombat while !initialised), so a finisher never ends in a cut followed by a half-second swim.
      if (opts.yaw != null) this.yaw = opts.yaw;
      else if (this.entity.yaw != null && (!this.initialised || !wasFollowing)) this.yaw = this.entity.yaw;
      this.initialised = false;
      this.lookIdle = 99;
      this.lookAccum.set(0, 0);
    }
  },

  emitCut(reason) {
    const ev = this.engine && this.engine.events;
    if (ev) { try { ev.emit('camera:cut', { reason }); } catch (_) { /* listeners are not our problem */ } }
  },

  // --------------------------------------------------------------------------------------- cinematic rig
  cinematic(rig = {}) {
    const list = Array.isArray(rig.shots) && rig.shots.length ? rig.shots : [rig];
    const seq = [];
    for (const s of list) {
      if (!s) continue;
      const dur = s.duration != null ? s.duration : (rig.duration != null ? rig.duration : 1.5);
      const ease = s.ease != null ? s.ease : (rig.ease != null ? rig.ease : 0.25);
      const rel = s.relativeTo !== undefined ? s.relativeTo : (rig.relativeTo || null);
      const collide = s.collide != null ? !!s.collide : (rig.collide != null ? !!rig.collide : !!rel);
      seq.push({
        pos: toVec(s.pos, new THREE.Vector3()),
        lookAt: toVec(s.lookAt, new THREE.Vector3()),
        toPos: s.to && s.to.pos ? toVec(s.to.pos, new THREE.Vector3()) : null,
        toLookAt: s.to && s.to.lookAt ? toVec(s.to.lookAt, new THREE.Vector3()) : null,
        toFov: s.to && s.to.fov != null ? s.to.fov : null,
        toRoll: s.to && s.to.roll != null ? s.to.roll : null,
        fov: s.fov != null ? s.fov : (rig.fov != null ? rig.fov : 40),
        duration: Math.max(0.02, dur),
        ease: (s.cut || rig.cut) ? 0 : Math.max(0, Math.min(ease, dur)),
        curve: CURVES[s.curve || rig.curve] || smoothstep,
        shake: s.shake || 0, fovKickAmt: s.fovKick || 0,
        roll: s.roll || 0,
        onStart: typeof s.onStart === 'function' ? s.onStart : null,
        rel, collide, keepClear: s.collide !== false && rig.collide !== false,
        flip: 1, fy: 0, fp: new THREE.Vector3(),
      });
    }
    if (!seq.length) return Promise.resolve({ cancelled: true });

    const prev = this.cine;
    if (this.mode !== 'cinematic') this._returnMode = this.mode === 'fixed' && this.fixed ? 'fixed' : 'follow';
    this._blend = null;
    this.cam.getWorldDirection(_tmp);
    this.cine = {
      seq, i: 0, t: 0, resolve: null,
      fromPos: this.cam.position.clone(),
      fromLook: this.cam.position.clone().addScaledVector(_tmp, 6),
      fromFov: this.cam.fov, fromRoll: this.roll,
      live: this.cam.position.clone(), liveLook: this.cam.position.clone().addScaledVector(_tmp, 6),
      liveRoll: 0,
      blendOut: rig.blendOut != null ? rig.blendOut : 'auto',
      onEnd: typeof rig.onEnd === 'function' ? rig.onEnd : null,
    };
    this.mode = 'cinematic';
    this._hold = null;
    if (prev && prev.resolve) prev.resolve({ cancelled: true });
    const mine = this.cine;
    this.enterShot(mine, 0);
    return new Promise((resolve) => { if (this.cine === mine) mine.resolve = resolve; else resolve({ cancelled: true }); });
  },

  stopCinematic() {
    const c = this.cine;
    this.cine = null;
    if (c && c.resolve) c.resolve({ cancelled: true });
  },

  // an actor's frame: origin + yaw. Entities ({position, yaw}), Object3Ds, or a pair [a, b] / {from, to}.
  frameOf(rel, outPos) {
    if (!rel) { outPos.set(0, 0, 0); return 0; }
    const pair = Array.isArray(rel) ? rel : (rel.from && rel.to ? [rel.from, rel.to] : null);
    if (pair) {
      const pa = this.framePos(pair[0]), pb = this.framePos(pair[1]);
      if (!pa) { outPos.set(0, 0, 0); return 0; }
      outPos.copy(pa);
      if (!pb) return 0;
      const dx = pb.x - pa.x, dz = pb.z - pa.z;
      return dx * dx + dz * dz > 1e-6 ? Math.atan2(dx, dz) : 0;
    }
    const rp = this.framePos(rel);
    if (!rp) { outPos.set(0, 0, 0); return 0; }
    outPos.copy(rp);
    let yaw = rel.yaw;
    if (yaw == null) yaw = rel.group ? rel.group.rotation.y : (rel.rotation ? rel.rotation.y : 0);
    return yaw || 0;
  },

  framePos(r) { return r ? (r.position || (r.group && r.group.position) || null) : null; },

  // shot-space -> world. `rel` may be an entity ({position, yaw}), an Object3D or an actor pair.
  resolveShot(rel, v, out, yawOverride, flip = 1, posOverride) {
    if (!rel) return out.copy(v);
    let yaw = this.frameOf(rel, _p2);
    if (yawOverride != null) yaw = yawOverride;
    const rp = posOverride || _p2;
    const c = Math.cos(yaw), s = Math.sin(yaw), x = v.x * flip;
    // frame kept bit-for-bit from the first rig so authored shots do not mirror: local +x = world +x at yaw 0,
    // which is the actor's LEFT hand (his right is (-cos, 0, sin))
    return out.set(x * c + v.z * s + rp.x, v.y + rp.y, -x * s + v.z * c + rp.z);
  },

  // shot entry: pick the open side for relative shots, fire callbacks/shake, report the cut
  enterShot(c, i) {
    const s = c.seq[i];
    if (s.rel) {
      s.fy = this.frameOf(s.rel, s.fp);
      if (s.collide && this.engine.world) {
        const keep = this.shotClearance(s, 1);
        if (keep < 0.97) {
          const alt = this.shotClearance(s, -1);
          if (alt > keep + 0.05) { s.flip = -1; this.stats.flips++; }
        }
      }
    }
    if (s.ease <= 0) this.emitCut('shot');
    if (s.shake) this.shake(s.shake, Math.min(0.5, s.duration));
    if (s.fovKickAmt) this.fovKick(s.fovKickAmt, 5);
    if (s.onStart) { try { s.onStart(this.engine, i); } catch (err) { console.warn('[camera] shot onStart failed', err); } }
    const ev = this.engine.events;
    if (ev) { try { ev.emit('camera:shot', { index: i, count: c.seq.length }); } catch (_) { /* ignore */ } }
  },

  // fraction (0..1) of the lookAt->pos line that is free, for both ends of a travelling shot
  shotClearance(s, flip) {
    const a = this.endClearance(s, s.pos, s.lookAt, flip);
    return s.toPos ? Math.min(a, this.endClearance(s, s.toPos, s.toLookAt || s.lookAt, flip)) : a;
  },

  endClearance(s, pos, look, flip) {
    this.resolveShot(s.rel, pos, _a, s.fy, flip, s.fp);
    this.resolveShot(s.rel, look, _b, s.fy, flip, s.fp);
    const L = _a.distanceTo(_b);
    if (L < 1e-3) return 1;
    const free = this.castLen(_b, _tmp.subVectors(_a, _b).normalize(), L + this.probeRadius);
    return clamp((free - this.probeRadius) / L, 0, 1);
  },

  updateCinematic(dt) {
    const cam = this.cam, c = this.cine;
    let s = c.seq[c.i];
    c.t += dt;
    while (c.t >= s.duration && c.i < c.seq.length - 1) {
      c.t -= s.duration;
      c.i++;
      c.fromPos.copy(c.live); c.fromLook.copy(c.liveLook); c.fromFov = cam.fov; c.fromRoll = c.liveRoll;
      s = c.seq[c.i];
      this.enterShot(c, c.i);
      if (this.cine !== c) return;            // a callback started another sequence
    }
    // a relative frame is followed tightly in position and loosely in heading, so an actor snapping his yaw
    // (face-target, a throw's spin) swings the shot instead of whipping it
    let fy = null, fpos = null;
    if (s.rel) {
      const y = this.frameOf(s.rel, _c);
      s.fy += wrap(y - s.fy) * damp(9, dt);
      s.fp.lerp(_c, damp(30, dt));
      fy = s.fy; fpos = s.fp;
    }
    const k = clamp(c.t / s.duration, 0, 1);
    this.resolveShot(s.rel, s.pos, _a, fy, s.flip, fpos);
    this.resolveShot(s.rel, s.lookAt, _b, fy, s.flip, fpos);
    let fov = s.fov, roll = s.roll * s.flip;
    if (s.toPos || s.toLookAt || s.toFov != null || s.toRoll != null) {   // travelling shot (dolly / crane)
      const e = s.curve(k);
      if (s.toPos) { this.resolveShot(s.rel, s.toPos, _o, fy, s.flip, fpos); _a.lerp(_o, e); }
      if (s.toLookAt) { this.resolveShot(s.rel, s.toLookAt, _o, fy, s.flip, fpos); _b.lerp(_o, e); }
      if (s.toFov != null) fov += (s.toFov - fov) * e;
      if (s.toRoll != null) roll += (s.toRoll * s.flip - roll) * e;
    }
    // a staged lens with a facade between it and its subject (a shot authored before the block plan moved, or
    // a relative shot landing in an alley) slides toward the subject until the line is clear. collide:false opts out.
    if (s.keepClear) this.pullShot(_b, _a);
    c.live.copy(_a); c.liveLook.copy(_b); c.liveRoll = roll;
    if (s.ease > 0 && c.t < s.ease) {                          // blend out of the previous framing
      const w = smoothstep(c.t / s.ease);
      _a.lerpVectors(c.fromPos, _a, w);
      _b.lerpVectors(c.fromLook, _b, w);
      fov = c.fromFov + (fov - c.fromFov) * w;
      roll = c.fromRoll + (roll - c.fromRoll) * w;
      if (s.keepClear) this.pullShot(_b, _a);                  // the straight-line blend can cut through a block too
    }
    cam.position.copy(_a);
    cam.up.set(0, 1, 0);
    cam.lookAt(_b);
    this.smoothTarget.copy(_b); this.smoothPos.copy(_a);
    this.fovImpulse *= Math.exp(-dt * this.fovImpulseDecay);
    fov += this.fovImpulse;
    const near = this.nearFor(0.2, cam.position, !!this.engine.world);
    if (Math.abs(cam.fov - fov) > 1e-3 || near !== cam.near) { cam.fov = fov; cam.near = near; cam.updateProjectionMatrix(); }
    this.fovAim = fov - this.fovImpulse; this.fovSprint = 0;
    this.roll = roll;
    // publish the REAL lens-to-subject distance: pullShot / keepClear and `to` dollies move the lens after
    // whoever staged the shot set the DOF focus once, and the subject would drift out of the focal window
    this.focusDistance = cam.position.distanceTo(_b);
    const pf = this.engine.get && this.engine.get('postfx');
    if (pf && pf._dofManual && !(this.engine.params && this.engine.params.raw && this.engine.params.raw.doftune)) pf.focus = this.focusDistance;
    if (c.i >= c.seq.length - 1 && c.t >= s.duration) {
      const r = c.resolve;
      this.cine = null;
      this.mode = this._returnMode === 'fixed' && this.fixed ? 'fixed' : 'follow';
      this.initialised = false;
      if (this.mode === 'follow' && c.blendOut !== 0) {
        this._blend = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov, t: 0,
          dur: c.blendOut === 'auto' ? 0.55 : Math.max(0.05, +c.blendOut || 0.5), auto: c.blendOut === 'auto', checked: false };
      } else this.emitCut('end');
      if (c.onEnd) { try { c.onEnd(); } catch (err) { console.warn('[camera] cinematic onEnd failed', err); } }
      if (r) r({ cancelled: false });
    }
  },

  // keep a staged lens out of the walls: slide it toward its subject until the line is clear
  pullShot(look, pos) {
    if (!this.engine.world) return;
    _tmp.subVectors(pos, look);
    const L = _tmp.length();
    if (L < 1e-3) return;
    _tmp.multiplyScalar(1 / L);
    const free = this.castLen(look, _tmp, L + this.probeRadius);
    if (free < L + this.probeRadius) pos.copy(look).addScaledVector(_tmp, Math.max(0.3, free - this.probeRadius));
  },

  // ------------------------------------------------------------------------------------------ feedback
  shake(strength = 0.3, duration = 0.25) {
    if (!(strength > 0)) return;
    this.trauma = Math.min(1, this.trauma + strength);
    this.shakeEnd = Math.max(this.shakeEnd, this.now + Math.max(0.06, duration || 0));
  },

  // linear ramp to zero at shakeEnd (this.now has already been advanced for this frame)
  decayTrauma(dt) {
    const left = this.shakeEnd - this.now;
    this.trauma = left > 1e-4 ? Math.max(0, this.trauma - (this.trauma / Math.max(dt, left)) * dt) : 0;
  },

  fovKick(delta = 2, decay = 6) {
    if (Math.abs(delta) > Math.abs(this.fovImpulse)) this.fovImpulse = delta;
    else this.fovImpulse += delta * 0.4;
    this.fovImpulse = clamp(this.fovImpulse, -9, 9);
    this.fovImpulseDecay = decay;
  },

  // a critically-under-damped spring kick: the lens lurches along `dir` by about `metres` and settles back
  punch(dir, metres = 0.06) {
    if (!dir || !(metres > 0)) return;
    _tmp.set(dir.x || 0, (dir.y || 0) * 0.5, dir.z || 0);
    if (_tmp.lengthSq() < 1e-8) return;
    _tmp.normalize();
    this.punchV.addScaledVector(_tmp, metres * 25);
    if (this.punchV.length() > 6) this.punchV.setLength(6);
  },

  getForward(out = new THREE.Vector3()) {
    if (this.mode === 'follow') return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.cam.getWorldDirection(out); out.y = 0;
    if (out.lengthSq() < 1e-6) out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    return out.normalize();
  },

  // ---------------------------------------------------------------------------------------------- loop
  update(dt) {
    const engine = this.engine, cam = this.cam;
    if (!cam) return;
    const t0 = this._lab ? performance.now() : 0;
    // the rig runs in real time: hit-stop and heat-action slow-mo must not slow the camera move itself. The
    // engine's own frame delta is read directly — dividing dt by time.speed is wrong on the very frames a
    // hit-stop starts or ends (combat changes the speed after the engine scaled dt), i.e. on every heavy hit.
    const tm = engine.clock && engine.clock.timer;
    let rawDt = tm && typeof tm.getDelta === 'function' ? tm.getDelta() : dt / Math.max(0.001, engine.time.speed || 1);
    if (!(rawDt >= 0)) rawDt = dt;
    rawDt = Math.min(rawDt, 1 / 20);
    this._lastRawDt = rawDt;
    this.now += rawDt;
    if (this._heatBusy) { const ha = engine.get('heatActions'); if (!ha || !ha.running) this._heatBusy = false; }
    if (this._preview && this.previewReady(this._preview)) { const p = this._preview; this._preview = null; this.applyPreview(p); }
    if (this._hold && !(engine.state.frozen && this.mode === 'follow')) this._hold = null;

    if (this.mode !== 'follow') this._stopped = false;
    if (this.mode === 'cinematic' && this.cine) this.updateCinematic(rawDt);
    else if (this.mode === 'fixed' && this.fixed) {
      cam.position.copy(this.fixed.pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.fixed.lookAt);
      this.smoothTarget.copy(this.fixed.lookAt); this.smoothPos.copy(this.fixed.pos);
      this.roll += (0 - this.roll) * damp(6, rawDt);
      // a pinned view still takes the hit punches on its field of view (and never hoards a stale impulse)
      this.fovImpulse *= Math.exp(-rawDt * this.fovImpulseDecay);
      if (Math.abs(this.fovImpulse) < 0.02) this.fovImpulse = 0;
      const f = this.fixed.fov + this.fovImpulse;
      if (Math.abs(cam.fov - f) > 0.01) { cam.fov = f; cam.updateProjectionMatrix(); }
    } else if (this._hold) {
      // a frozen still after a preview: the converged framing, bit for bit, every frame until the capture (the live
      // rig would keep re-solving against a crowd that still walks). Shake / punch / FOV still play on top.
      const h = this._hold;
      cam.position.copy(h.pos); cam.quaternion.copy(h.quat);
      this.fovImpulse *= Math.exp(-rawDt * this.fovImpulseDecay);
      if (Math.abs(this.fovImpulse) < 0.02) this.fovImpulse = 0;
      const f = h.fov + this.fovImpulse;
      if (Math.abs(cam.fov - f) > 0.01) { cam.fov = f; cam.updateProjectionMatrix(); }
    } else if (this.entity) this.updateFollow(rawDt);

    // the final blow is a weighted overlay on whatever the follow rig just produced (its roll included)
    let roll = this.roll;
    if (this._fb) {
      const t1 = performance.now();
      roll = this.applyFinalBlow(rawDt, roll);
      this._fbFrameMs = Math.max(this._fbFrameMs || 0, performance.now() - t1);
    }
    if (roll) cam.rotateZ(roll);
    const lab = this._lab;
    if (lab) {
      if (this._stopped && lab.prev) { lab.stopFrames++; lab.stopDrift = Math.max(lab.stopDrift, cam.position.distanceTo(lab.prev)); lab.stopYaw = Math.max(lab.stopYaw, Math.abs(wrap(this.yaw - lab.prevYaw))); }
      // lens acceleration (m/s^2) of the rig itself, before shake: a cut resets the history
      // (hit-stop edges excluded: the freeze is a deliberate dead stop, like the actors')
      if (lab.p && rawDt > 1e-4 && this.mode === 'follow' && !this._blend && !this._stopped && !lab.wasStopped) {
        const vx = (cam.position.x - lab.p.x) / rawDt, vy = (cam.position.y - lab.p.y) / rawDt, vz = (cam.position.z - lab.p.z) / rawDt;
        if (lab.v && lab.follow) {
          const acc = Math.hypot(vx - lab.v.x, vy - lab.v.y, vz - lab.v.z) / rawDt;
          if (acc > lab.acc) {
            lab.acc = acc;
            const d = this.dbg || {};
            lab.accInfo = { dt: +rawDt.toFixed(4), yawRate: +((wrap(this.yaw - (lab.py || this.yaw))) / rawDt).toFixed(3), yawRatePrev: lab.pyr, arm: +this.arm.toFixed(3), armPrev: lab.parm, dist: +d.dist?.toFixed(3), hard: +d.hard?.toFixed(3), clamp: d.clamp, fix: d.fix, lift: +(this.lift || 0).toFixed(3), tgt: this.target && this.target.id, tgtPrev: lab.ptgt, side: this.side, swing: +this.swing.toFixed(3), cd: +this.combatDist.toFixed(3) };
          }
        }
        (lab.v || (lab.v = new THREE.Vector3())).set(vx, vy, vz);
      } else lab.v = null;
      lab.follow = this.mode === 'follow' && !this._blend;
      lab.pyr = lab.py != null ? +((wrap(this.yaw - lab.py)) / Math.max(rawDt, 1e-4)).toFixed(3) : null; lab.py = this.yaw; lab.parm = +this.arm.toFixed(3); lab.ptgt = this.target && this.target.id;
      lab.wasStopped = this._stopped;
      (lab.p || (lab.p = new THREE.Vector3())).copy(cam.position);
      (lab.prev || (lab.prev = new THREE.Vector3())).copy(cam.position); lab.prevYaw = this.yaw;
      lab.rig = (lab.rig || new THREE.Vector3()).copy(cam.position);
      lab.rigQ = (lab.rigQ || new THREE.Quaternion()).copy(cam.quaternion);
    }
    this.applyShake(cam, rawDt);
    if (lab) {
      lab.maxTrauma = Math.max(lab.maxTrauma, this.trauma);
      // screen-space size of the kick: lens displacement over the distance to what it looks at, in 1080p pixels
      const ang = 2 * Math.acos(Math.min(1, Math.abs(cam.quaternion.dot(lab.rigQ))));
      const px = (cam.position.distanceTo(lab.rig) / Math.max(1, this.combatDist) + ang) / Math.tan((cam.fov * Math.PI) / 360) * 540;
      lab.maxShakePx = Math.max(lab.maxShakePx, px);
      if (this.mode === 'follow') { const u = performance.now() - t0; lab.updN = (lab.updN || 0) + 1; lab.updSum = (lab.updSum || 0) + u; lab.updMax = Math.max(lab.updMax || 0, u); }
    }
    this.publishSubject();
    this._candOk = false;             // the broadphase candidates belong to this frame's head position only
    if (engine.params && engine.params.raw && engine.params.raw.camdbg && ((this._dbgN = (this._dbgN || 0) + 1) % 10 === 0)) {
      const cb = engine.get('combat');
      console.info(`[camdbg] n=${this._dbgN} mode=${this.mode} yaw=${this.yaw.toFixed(4)} pos=${cam.position.x.toFixed(3)},${cam.position.y.toFixed(3)},${cam.position.z.toFixed(3)} tr=${this.trauma.toFixed(3)} px=${this.punchX.length().toFixed(4)} sw=${this.swing.toFixed(3)} side=${this.side} cd=${this.combatDist.toFixed(3)} beh=${this.behind.toFixed(2)} stop=${cb ? (cb.hitStopUntil - cb.now).toFixed(3) : '-'} fov=${cam.fov.toFixed(2)} roll=${this.roll.toFixed(4)} dt=${rawDt.toFixed(4)} pitch=${this.pitch.toFixed(3)} solve=${JSON.stringify(this.dbgFrame || null)}`);
    }
  },

  // for postfx: camera.subjectRect = NDC box {x0, y0, x1, y1, on} of the framed 健人 (head top, feet, shoulders)
  // through this frame's final lens, and camera.isCloseup (a long lens or the subject within 2.5 m) so
  // lens effects (bloom inside his silhouette, lateral CA) can ease off the lead
  publishSubject() {
    const cam = this.cam, e = this.entity || this.engine.player, R = this.subjectRect;
    R.on = false;
    if (!e || !e.position || (e.group && !e.group.visible)) { this.isCloseup = cam.fov <= 32; return; }
    cam.updateMatrixWorld();
    const P = e.position, h = e.humanoid;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, front = 0;
    _cr.setFromMatrixColumn(cam.matrixWorld, 0);
    for (let i = 0; i < 4; i++) {
      if (i === 0) { if (h && h.boneWorld) { h.boneWorld('Head', _a); _a.y += 0.2; } else _a.set(P.x, P.y + 1.85, P.z); }
      else if (i === 1) _a.set(P.x, P.y, P.z);
      else _a.set(P.x, P.y + 1.35, P.z).addScaledVector(_cr, i === 2 ? -0.32 : 0.32);
      _a.project(cam);
      if (_a.z > 1) continue;
      front++;
      if (_a.x < x0) x0 = _a.x; if (_a.x > x1) x1 = _a.x; if (_a.y < y0) y0 = _a.y; if (_a.y > y1) y1 = _a.y;
    }
    if (front >= 2) { R.x0 = Math.max(-1, x0); R.y0 = Math.max(-1, y0); R.x1 = Math.min(1, x1); R.y1 = Math.min(1, y1); R.on = R.x1 > R.x0 && R.y1 > R.y0; }
    _a.set(P.x, P.y + 1.35, P.z);
    const dist = this.mode === 'cinematic' ? this.focusDistance : cam.position.distanceTo(_a);
    this.isCloseup = cam.fov <= 32 || dist < 2.5;
  },

  applyShake(cam, dt) {
    // spring punch (semi-implicit Euler, stable for dt <= 1/20 at this stiffness)
    const moving = this.punchV.lengthSq() > 1e-7 || this.punchX.lengthSq() > 1e-8;
    if (moving) {
      const k = 210, c = 2 * Math.sqrt(k) * 0.42;
      this.punchV.addScaledVector(this.punchX, -k * dt).addScaledVector(this.punchV, -Math.min(1, c * dt));
      this.punchX.addScaledVector(this.punchV, dt);
      if (this.punchX.lengthSq() < 1e-8 && this.punchV.lengthSq() < 1e-7) { this.punchX.set(0, 0, 0); this.punchV.set(0, 0, 0); }
    }
    let shook = false;
    _cp.copy(cam.position);
    if (moving) { cam.position.add(this.punchX); shook = true; }
    if (this.trauma > 0) {
      this.decayTrauma(dt);
      this.shakeT += dt;
      // trauma^2 alone makes the everyday hits invisible (a 0.12 jab = 1-2 px): the linear floor gives every rush
      // hit a crisp few-pixel kick while the heavy end of the curve is unchanged
      const s = Math.max(this.trauma * this.trauma, 0.4 * this.trauma), t = this.shakeT * this.shakeFreq;
      if (s > 1e-5) {
        cam.rotateX(fbm(t, 37.3) * 0.028 * s);
        cam.rotateY(fbm(t, 0) * 0.032 * s);
        cam.rotateZ(fbm(t, 71.9) * 0.058 * s);
        _a.set(1, 0, 0).applyQuaternion(cam.quaternion);
        _b.set(0, 1, 0).applyQuaternion(cam.quaternion);
        cam.position.addScaledVector(_a, fbm(t, 113.1) * 0.26 * s).addScaledVector(_b, fbm(t, 157.7) * 0.19 * s);
        shook = true;
      }
    } else this.trauma = 0;
    // shake must never be what pushes the lens through a facade the arm was pressed against, nor a heat shot that
    // pullShot just slid out of a wall back into it: halve the offset first (the shot still shakes), then drop it
    const clear = this.mode === 'follow' || (this.mode === 'cinematic' && this.cine && this.cine.seq[this.cine.i] && this.cine.seq[this.cine.i].keepClear);
    if (shook && clear && this.engine.world && this.insideOccluder(cam.position, LENS_R * 0.6)) {
      cam.position.lerp(_cp, 0.5);
      if (this.insideOccluder(cam.position, LENS_R * 0.6)) cam.position.copy(_cp);
    }
  },

  // ------------------------------------------------------------------------------------- third person
  updateFollow(dt) {
    const engine = this.engine, cam = this.cam, e = this.entity, input = engine.input;
    const live = !engine.state.frozen && engine.state.mode !== 'paused';
    // a re-initialised rig (a cut) must not inherit spring velocities from before it; this runs before
    // frameCombat, whose first frame would otherwise carry the pre-cinematic yaw / distance velocity
    if (!this.initialised) {
      this._pv.x.v = this._pv.y.v = this._pv.z.v = 0; this._yawV.v = 0; this._distV.v = 0; this._dcV.v = 0;
      if (this._swV) this._swV.v = 0;
    }
    // hit-stop: the actors freeze, so the framing springs freeze with them (velocities kept for the release).
    // Only feedback moves during a stop: shake, punch, FOV. A dt of 0 makes smoothDamp an exact no-op.
    const cb = engine.get('combat');
    const stopped = !!(cb && cb.hitStopUntil > 0 && cb.hitStopUntil > cb.now && this.initialised);
    const sdt = stopped ? 0 : dt;
    this._stopped = stopped;

    // --- manual look: the raw delta goes into an accumulator that bleeds out over a few frames, so a
    //     jerky mouse sample never becomes a jerky frame (and the total rotation is still exact).
    let lookMag = 0;
    if (live && input && (input.pointerLocked || input.gamepadConnected || (input.virtual && input.virtual.active))) {   // (virtual: the touch controls' drag)
      lookMag = Math.abs(input.look.x) + Math.abs(input.look.y);
      this.lookAccum.x -= input.look.x * this.sensitivity;
      this.lookAccum.y += input.look.y * this.sensitivity;
    }
    const take = damp(26, dt);
    this.yaw = wrap(this.yaw + this.lookAccum.x * take);
    this.pitch = clamp(this.pitch + this.lookAccum.y * take, this.pitchMin, this.pitchMax);
    this.lookAccum.multiplyScalar(1 - take);
    this.lookIdle = lookMag > 0.6 ? 0 : this.lookIdle + dt;

    // --- pivot velocity (locomotion has no velocity vector of its own)
    _pivot.copy(e.position);
    if (this.initialised && !stopped) {
      _tmp.subVectors(_pivot, this.prevPivot).multiplyScalar(1 / Math.max(dt, 1e-4)); _tmp.y = 0;
      if (_tmp.lengthSq() < 400) this.vel.lerp(_tmp, damp(8, dt));
    }
    this.prevPivot.copy(_pivot);

    const inCombat = this.combat || engine.state.mode === 'combat';
    const tgt = this.pickTarget(e, inCombat, dt);
    this.target = tgt;
    const hgt = inCombat ? this.combatHeight : this.height;
    _head.set(e.position.x, e.position.y + hgt, e.position.z);   // inside his capsule: known free space

    let dist, shoulderAim, pitchAim = null, pivotTime = 0.07;
    const speed = e.moveSpeed || this.vel.length();
    if (inCombat !== this._wasCombat) {            // hand the current arm length across, so the switch never pops
      if (this.initialised) { if (inCombat) this.combatDist = this.distCur; }
      this._wasCombat = inCombat;
    }
    if (inCombat) {
      const f = this.frameCombat(e, tgt, sdt);
      shoulderAim = this.side * this.combatShoulder;
      pitchAim = f.pitch;
      pivotTime = 0.3;               // the midpoint jumps when the target changes: glide, never snap
      // someone behind the lens: the arm rises (pivot + pitch) to look down over the ring instead of backing off
      _pivot.copy(f.pivot); _pivot.y = this._rig.py;
      dist = null;                   // resolved after the pivot is smoothed (the fit depends on it)
    } else {
      // --- auto-orbit: settle behind him while he is actually travelling, never while he backs up
      this.side = 1;
      let rate = 0;
      if (this.lookIdle > this.autoOrbitDelay && speed > 0.6) {
        this.getForward(_fwd);
        const move = this.vel.lengthSq() > 0.05 ? _tmp.copy(this.vel).normalize() : _fwd;
        const forwardness = clamp(move.dot(_fwd), 0, 1);
        rate = this.autoOrbit * clamp(speed / 5.6, 0, 1) * forwardness;
      }
      // spring, not lerp: the swing eases in when he sets off and coasts out when he stops
      if (this.lookIdle < this.autoOrbitDelay) this._yawV.v = 0;
      else if (rate > 0.05) this.yaw = wrap(smoothDamp(this.yaw, this.yaw + wrap((e.yaw != null ? e.yaw : this.yaw) - this.yaw), this._yawV, Math.max(0.3, 1.6 / rate), dt));
      else { this._yawV.v *= Math.exp(-7 * dt); this.yaw = wrap(this.yaw + this._yawV.v * dt); }
      if (this.lookIdle > 1.2) this.pitch += (0.12 - this.pitch) * damp(speed > 3.4 ? 1.6 : 0.7, dt);
      const run = clamp((speed - 2.6) / 3.0, 0, 1);
      const aim = this.distance + this.runDistance * run;
      if (!this.initialised) this.distCur = aim;
      this.distCur = smoothDamp(this.distCur, aim, this._dcV, 0.5, dt);
      dist = this.distCur;
      shoulderAim = this.shoulder;
      _pivot.copy(_head).addScaledVector(this.vel, 0.09);
      _pivot.y = _head.y;
    }

    // --- pivot springs: y is slower so curbs and the ground snap in player.move never bob the frame
    if (!this.initialised) {
      this.smoothTarget.copy(_pivot); this.vel.set(0, 0, 0); this.shoulderCur = shoulderAim; this.armLimit = 99; this.lift = 0;
      this.occLift = 0; this._olV.v = 0; this._occT = 0;
      this.armSm = this.arm = dist || this.distance; this.compression = 0;
      if (pitchAim != null && this.lookIdle > 0.9) this.pitch = pitchAim;
    }
    this.smoothTarget.x = smoothDamp(this.smoothTarget.x, _pivot.x, this._pv.x, pivotTime, sdt);
    this.smoothTarget.z = smoothDamp(this.smoothTarget.z, _pivot.z, this._pv.z, pivotTime, sdt);
    this.smoothTarget.y = smoothDamp(this.smoothTarget.y, _pivot.y, this._pv.y, 0.2, sdt);
    if (pitchAim != null && this.lookIdle > 0.9) this.pitch += (pitchAim - this.pitch) * damp(1.5, sdt);

    // --- collision chain. Every leg starts from a point proven free by the previous one (his head first), so
    //     no probe ever begins inside a box (a ray born inside an AABB reports nothing and walks through it).
    _look.copy(this.smoothTarget);
    const world = engine.world;
    const tags = world ? this.occluderTags() : null;
    const r = this.probeRadius;
    if (tags) {
      const reach = (inCombat ? this.combatMax : Math.max(this.distCur, this.distance + this.runDistance)) + _look.distanceTo(_head) + 2.6;
      this.beginQueries(_head, reach);
      this.clampLeg(_head, _look, r);
    }

    _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));            // screen right (three.js lookAt basis)
    // a compressed arm widens into a proper over-the-shoulder instead of parking the lens behind his skull,
    // capped by a smoothed arm length (a 0.7 m arm with a 0.7 m offset would swing him out of the frame).
    // That target is eased; a wall at his shoulder is a hard clamp on top of it.
    this.armSm += (this.arm - this.armSm) * damp(3, sdt);
    const shMag = Math.min(Math.abs(shoulderAim) * (1 + 0.45 * this.compression), 0.1 + 0.3 * Math.max(this.armSm, 0.3));
    const shTarget = (Math.sign(shoulderAim) || 1) * shMag;
    this.shoulderCur = smoothDamp(this.shoulderCur, shTarget, this._shV || (this._shV = { v: 0 }), 0.45, sdt);
    const sc = Math.sign(this.shoulderCur);
    if (sc !== 0 && tags) {
      _tmp.copy(_right).multiplyScalar(sc);
      const lim = Math.max(0, this.castLen(_look, _tmp, Math.abs(this.shoulderCur) + r) - r);
      if (Math.abs(this.shoulderCur) > lim) this.shoulderCur = sc * lim;
    }
    _o.copy(_look).addScaledVector(_right, this.shoulderCur);

    // --- combat fit distance (needs the smoothed look point)
    if (dist == null) { dist = this.fitCombat(e, tgt, sdt, _o); this.distCur = dist; }

    // --- whiskers: two feelers either side of the arm swing it away from a corner BEFORE the arm has to snap in
    //     (the pull-in is the last resort, a slide round the corner is what a player never notices)
    const basePitch = clamp(this.pitch, this.pitchMin, this.pitchMax);
    this.armDir(basePitch, _dir);
    // a street-level block whose top is under the lens cannot hold the lens: the arm passes over it (a 1.5 m
    // plinth beside the fight must not yank the camera in) — the lens-sphere check below still sees it
    this._lowSkip = _o.y + _dir.y * dist - LENS_R - 0.02;
    let whisk = 0;
    if (tags && this.lookIdle > 0.35 && speed > 0.8 && !(inCombat && e.lockTarget)) {
      const wl = dist * 0.85, tw = 0.55;
      let bl = 0, br = 0;
      for (let side = -1; side <= 1; side += 2) {
        _tmp.set(_dir.x, 0, _dir.z).normalize().addScaledVector(_right, side * tw).normalize();
        const free = this.castLen(_o, _tmp, wl);
        const b = clamp(1 - free / wl, 0, 1);
        if (side < 0) bl = b; else br = b;
      }
      // increasing yaw carries the lens toward screen-right; a blocked right feeler therefore pushes yaw down.
      // Both feelers blocked = a flat wall behind: turning does not help there, the crane lift does.
      whisk = (bl - br) * (1 - Math.min(bl, br)) * (inCombat ? 0.7 : 1.5);
    }
    // the push is a yaw RATE; eased so a feeler catching a corner never kicks the lens sideways in one frame
    this._whisk = smoothDamp(this._whisk || 0, whisk, this._whV || (this._whV = { v: 0 }), 0.2, sdt);
    if (Math.abs(this._whisk) > 1e-4) { this.yaw = wrap(this.yaw + this._whisk * sdt); this.armDir(basePitch, _dir); _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw)); }

    // --- cramp lift: a wall right behind him cranes the arm up over his head, where there is room. Probed at
    //     the base pitch so the lift never feeds back into its own measurement.
    let cramp = 0;
    if (tags) {
      const h = this.castLen(_o, _dir, dist);
      cramp = clamp((Math.min(dist, 1.9) - h) / 1.5, 0, 1);
    }
    this.lift += (cramp * 0.55 - this.lift) * damp(cramp * 0.55 > this.lift ? 7 : 2.2, sdt);

    // --- over the top: the arm passes over street-level blocks, but when one of them (the ハチ公 plinth) hides
    //     his body from the lens, the lens cranes up and looks down over it. Tested at the un-craned pitch, so
    //     the crane never feeds back into its own test.
    let lowOcc = false;
    if (tags && this._local) {
      this.armDir(clamp(basePitch + this.lift, this.pitchMin, 1.25), _F);
      _cp.copy(_o).addScaledVector(_F, this.arm);
      _a.set(e.position.x, e.position.y + 1.0, e.position.z);
      _b.subVectors(_cp, _a);
      const L = _b.length();
      if (L > 0.5) {
        _b.multiplyScalar(1 / L);
        const keep = this._lowSkip;
        this._lowSkip = -Infinity;
        if (this.castLen(_a, _b, L) < L - LENS_R) { this._lowSkip = Infinity; lowOcc = this.castLen(_a, _b, L) >= L - LENS_R; }
        this._lowSkip = keep;
      }
    }
    this._occT = lowOcc ? 0.6 : Math.max(0, (this._occT || 0) - sdt);
    this.occLift = smoothDamp(this.occLift, this._occT > 0 ? 0.3 : 0, this._olV, lowOcc ? 0.35 : 0.9, sdt);
    const ep = clamp(basePitch + Math.min(0.6, this.lift + this.occLift), this.pitchMin, 1.25);
    this.armDir(ep, _dir);

    // --- arm: a soft tapered cylinder (full width from 1.5 m on, so a corner beside his shoulder is seen as early
    //     as one by the lens) starts easing in early; the hard cone is an absolute ceiling
    let hard = dist, soft = dist + 0.6;
    if (tags) {
      hard = this.coneCast(_o, _dir, dist, r);
      soft = Math.min(hard + 0.6, this.cylinderCast(_o, _dir, dist + 0.6, this.softRadius));
    }
    // the soft pass only shapes the approach: in a tight spot it never asks for less than the hard cone and the
    // comfort minimum allow. Everything outward (soft or hard freeing up) is eased; inward, the hard cone wins.
    const want = Math.min(Math.max(soft, Math.min(hard, this.minDistance)), hard);
    if (!this.initialised) this.armLimit = want;
    if (want < this.armLimit - 1e-4) {
      // pull harder the closer the hard ceiling is to biting, so the ease-in finishes before the snap would
      const urgency = clamp(1 - (hard - want) / 1.2, 0, 1);
      this.armLimit += (want - this.armLimit) * damp(9 + 18 * urgency, dt); this.armHold = 0.3;
    }
    else if (this.armHold > 0) this.armHold -= sdt;
    else this.armLimit += (want - this.armLimit) * damp(2.6, sdt);
    let arm = Math.min(dist, this.armLimit);
    const dbg = this.dbg || (this.dbg = {});      // per-frame diagnostics for the probes (no allocation)
    dbg.dist = dist; dbg.hard = hard; dbg.soft = soft; dbg.limit = this.armLimit; dbg.cramp = cramp; dbg.lift = this.lift; dbg.fix = 0; dbg.clamp = 0;
    if (arm > hard) { arm = hard; this.stats.clampFrames++; dbg.clamp = 1; }
    if (this.armLimit > hard) this.armLimit = hard;      // a snap-in releases from where it snapped to
    arm = Math.max(0.05, arm);
    this.arm = arm;
    const comp = clamp(1 - arm / Math.max(0.6, dist), 0, 1);
    this.compression += (comp - this.compression) * damp(5, sdt);

    _c.copy(_o).addScaledVector(_dir, arm);
    const gy = world ? world.groundHeight(_c.x, _c.z) : 0;
    if (_c.y < gy + 0.32) _c.y = gy + 0.32;
    // last line of defence: a grazing facade the cone missed -> bisect the arm until the lens is clear
    if (tags && this.insideOccluder(_c, LENS_R)) {
      let lo = 0, hi = arm;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) * 0.5;
        _tmp.copy(_o).addScaledVector(_dir, mid);
        if (this.insideOccluder(_tmp, LENS_R)) hi = mid; else lo = mid;
      }
      // a pivot that itself grazes a wall leaves no clear sphere anywhere on the arm: keep the cone's answer
      // rather than collapsing into his head, as long as the lens centre is outside
      if (lo > 0.3 || this.insideOccluder(_c, 0.02)) {
        _c.copy(_o).addScaledVector(_dir, lo);
        this.arm = lo; this.armLimit = Math.min(this.armLimit, lo);
        this.stats.lensFixes++; dbg.fix = 1;
      }
    }

    if (!this.initialised) { this.smoothPos.copy(_c); this.initialised = true; this._prevYaw = this.yaw; }
    this.smoothPos.copy(_c);
    cam.position.copy(_c);
    cam.up.set(0, 1, 0);
    // look down the shouldered axis, so 健人 sits off-centre instead of dead centre. A compressed arm aims up
    // toward his head: the crane lift looks down on him and would otherwise frame his belt at 1 m range.
    _look.copy(_o); _look.y += 0.42 * this.compression;
    cam.lookAt(_look);

    // --- lean: a touch of roll out of the turn + against the strafe, the classic hand-held bias
    const yawRate = wrap(this.yaw - this._prevYaw) / Math.max(dt, 1e-4);
    this._prevYaw = this.yaw;
    const strafe = this.vel.dot(_right);
    const rollTarget = clamp(-yawRate * 0.010 - strafe * 0.0055, -0.035, 0.035);
    this.roll += (rollTarget - this.roll) * damp(4.5, sdt);

    // --- fov: combat framing is a hair wider, sprint pushes it out, hits punch it
    const sprint = live && input && input.buttons && input.buttons.run.down && (e.moveSpeed || 0) > 3.4 ? 1 : 0;
    this.fovSprint += (sprint * 5.0 - this.fovSprint) * damp(sprint ? 3.0 : 4.5, dt);
    this.fovImpulse *= Math.exp(-dt * this.fovImpulseDecay);
    if (Math.abs(this.fovImpulse) < 0.02) this.fovImpulse = 0;
    this.fovAim += ((inCombat ? this.fovCombat : this.fovBase) - this.fovAim) * damp(3.5, dt);
    let fov = this.fovAim + this.fovSprint + this.fovImpulse;

    // --- glide back from a cinematic when the two framings are close; otherwise it is a clean cut
    if (this._blend) {
      const b = this._blend;
      if (!b.checked) {
        b.checked = true;
        if (b.auto && (b.pos.distanceTo(cam.position) > 3.0 || (tags && !this.segmentClear(b.pos, cam.position)))) { this._blend = null; this.emitCut('end'); }
      }
      if (this._blend) {
        b.t += dt;
        const w = smoothstep(clamp(b.t / b.dur, 0, 1));
        cam.position.lerpVectors(b.pos, _c, w);
        _q.copy(cam.quaternion);
        cam.quaternion.slerpQuaternions(b.quat, _q, w);
        fov = b.fov + (fov - b.fov) * w;
        if (w >= 1) this._blend = null;
      }
    }
    // adaptive near plane: a long arm buys depth precision (AO / fog / DOF reconstruct from this depth buffer); the
    // near plane's corner sphere must stay clear of every facade, else it drops back to 0.1
    const near = this.nearFor(clamp(this.arm * 0.06, 0.1, 0.3), cam.position, !!tags);
    if (Math.abs(cam.fov - fov) > 0.01 || near !== cam.near) { cam.fov = fov; cam.near = near; cam.updateProjectionMatrix(); }
    this.endQueries();
  },

  // near plane `n` if the sphere holding its corners (1.32 n at 47° / 16:9) is clear of occluders; changes under
  // 1 cm are ignored so the projection matrix is not rebuilt every frame
  nearFor(n, pos, probe) {
    const cur = this.cam.near;
    if (n > 0.1 && probe && this.insideOccluder(pos, n * 1.32)) n = 0.1;
    return Math.abs(n - cur) > 0.01 || (n === 0.1 && cur !== 0.1) ? n : cur;
  },

  armDir(pitch, out) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return out.set(-Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp);   // pivot -> camera
  },

  // --------------------------------------------------------------------------------------- combat framing
  // Where to stand: on the player -> target axis, swung off it (side + swing from the framing solver, 0.33 rad by
  // default) so the two men never stand one behind the other, with the look point pulled toward the midpoint.
  // Everything the solver needs about the rig (axis, midpoint pull, pack nudge, behind lift, pitch) is kept in
  // this._rig, so rigPose() rebuilds exactly the pose updateFollow will.
  frameCombat(e, tgt, dt) {
    const out = this._cf || (this._cf = { pivot: new THREE.Vector3(), pitch: 0.16 });
    const G = this._rig || (this._rig = { axisYaw: 0, kS: 0, m: 0, sep: 0, px: 0, py: 0, pz: 0, pitch: 0.16 });
    const P = e.position;
    const others = this.nearbyEnemies(e, 8.5);
    let sep = 0;
    if (tgt) { _axis.subVectors(tgt.position, P); _axis.y = 0; sep = _axis.length(); }
    const framed = !!tgt && sep > 0.3;
    G.sep = sep; G.kS = 0; G.m = 0; G.axisYaw = this.yaw;
    if (framed) {
      _axis.multiplyScalar(1 / sep);
      G.axisYaw = Math.atan2(_axis.x, _axis.z);
      // the swing is at full strength from contact range (a hook lands at ~1 m): scaling it by `k` put the lens
      // straight down the axis in exactly the moment that matters, his fist over the other man's face
      G.kS = smoothstep(clamp((sep - 0.35) / 0.6, 0, 1));
      G.m = Math.min(sep, 6) * 0.36 * G.kS;             // look point toward the midpoint: him left third, the man right
      // ...but only as far as the arm has room: pulled in by a wall to ~1 m, a look point 2 m out toward the man put
      // the lens beside 健人 or past him (measured after dodges into a wall). The pull fades out with the arm.
      if (this.initialised) G.m *= clamp((this.armSm - 1.2) / 2.3, 0, 1);
    } else _axis.set(0, 0, 0);
    // the rest of the pack nudges the look point, and anyone flanking him raises the camera for a readable
    // top-down-ish view of the ring instead of a wall of backs. Anyone left behind the LENS lifts the arm a little
    // more (pitch + pivot height). Measured: a steep lift drops men standing between lens and player further out
    // of the bottom of the frame, so seeing the ring is the solver's job (orbit), not the pitch's.
    const bx = P.x + _axis.x * G.m, bz = P.z + _axis.z * G.m;
    let flank = 0, n = 0, behind = 0;
    _b.set(0, 0, 0);
    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const lensZ = this.combatDist * Math.cos(clamp(this.pitch, this.pitchMin, this.pitchMax));
    for (const x of others) {
      if (x === tgt) continue;
      _tmp.subVectors(x.position, P); _tmp.y = 0;
      const d = _tmp.length();
      if (d < 0.2) continue;
      _b.add(_tmp); n++;
      if (_tmp.dot(_fwd) / d < 0.2) flank += clamp((7 - d) / 4, 0, 1);
      if (d < 7) {
        const z = (x.position.x - bx) * _fwd.x + (x.position.z - bz) * _fwd.z + lensZ;
        behind = Math.max(behind, clamp((1.2 - z) / 1.0, 0, 1));
      }
    }
    if (!this.initialised) { this.surround = Math.min(2, flank); this.behind = behind; }
    else {
      this.surround += (Math.min(2, flank) - this.surround) * damp(1.8, dt);
      this.behind += (behind - this.behind) * damp(behind > this.behind ? 2.4 : 1.1, dt);
    }
    out.pitch = G.pitch = 0.13 + Math.min(0.35, 0.055 * this.surround + 0.2 * this.behind);
    G.px = bx + (n ? _b.x * 0.1 / n : 0); G.pz = bz + (n ? _b.z * 0.1 / n : 0);
    G.py = P.y + this.combatHeight + 0.35 * this.behind;
    this.gatherFraming(e, tgt, others);

    if (framed) {
      const rel = wrap(this.yaw - G.axisYaw);
      const locked = e.lockTarget === tgt;
      if (this.lookIdle < 0.9) {
        // the player is steering: whichever side he puts the camera on is the side (the shoulder follows)
        if (Math.abs(rel) > 0.3 && Math.abs(rel) < 2.6) this.side = rel > 0 ? 1 : -1;
        this._aimSide = this.side; this._aimSwing = this.combatAngle; this._aimT = 0; this._aimCap = Infinity;
      } else {
        // otherwise the framing solver picks where round the pair the lens stands (side + swing + arm cap)
        this.solveFraming(e, tgt, dt);
        this.side = this._aimSide;
      }
      const swingAim = this._aimSwing != null ? this._aimSwing : this.combatAngle;
      if (!this.initialised) { this.swing = swingAim; if (this._swV) this._swV.v = 0; }
      else this.swing = smoothDamp(this.swing, swingAim, this._swV || (this._swV = { v: 0 }), 0.4, dt);
      const ang = this.swing * G.kS;
      if (this.lookIdle > (locked ? 0.25 : 0.9)) {
        const desired = G.axisYaw + this.side * ang;
        this._desiredYaw = desired;
        // first frame after a cut (a finisher handing back, a preview): be at the settled framing, not swim to it
        if (!this.initialised) { this.yaw = wrap(desired); this._yawV.v = 0; }
        else {
          // a long re-aim (side change, new opponent) glides proportionally longer: the lens acceleration of a
          // critically damped spring grows with the step, so the step stretches the time instead
          const err = Math.abs(wrap(desired - this.yaw));
          const quick = locked || isAttacking(tgt);                // he is swinging at 健人: be there before it lands
          const st = (quick ? 0.22 : 0.5) * (1 + 0.9 * err) / ((0.3 + 0.7 * G.kS) * (Math.abs(rel) > 1.6 && !quick ? 0.5 : 1));
          this.yaw = wrap(smoothDamp(this.yaw, this.yaw + wrap(desired - this.yaw), this._yawV, st, dt));
        }
      } else this._yawV.v = 0;
    } else this._aimCap = Infinity;
    out.pivot.set(G.px, P.y, G.pz);
    return out;
  },

  // The one combat rig pose for an aim (side, swing): the look point (pivot with the midpoint pull, pack nudge and
  // behind lift, plus the shoulder offset with its compression widening), the arm pitch (frameCombat's clamp plus
  // the wall / plinth crane) and the look lift of a compressed arm. updateFollow builds this; the solver scores it.
  rigPose(side, swing, out) {
    const G = this._rig;
    out.yaw = G.axisYaw + side * swing * G.kS;
    out.pitch = clamp(clamp(G.pitch, this.pitchMin, this.pitchMax) + Math.min(0.6, this.lift + this.occLift), this.pitchMin, 1.25);
    out.sh = side * Math.min(this.combatShoulder * (1 + 0.45 * this.compression), 0.1 + 0.3 * Math.max(this.armSm, 0.3));
    out.x = G.px - Math.cos(out.yaw) * out.sh; out.y = G.py; out.z = G.pz + Math.sin(out.yaw) * out.sh;
    out.lift = 0.42 * this.compression;
    return out;
  },

  // the lens the rig builds for pose R at arm d, with the view basis cam.lookAt() gives it (into _C/_Fw/_Rw/_Uw)
  lensAt(R, d) {
    const cp = Math.cos(R.pitch), sp = Math.sin(R.pitch), fx = Math.sin(R.yaw), fz = Math.cos(R.yaw);
    _C.set(R.x - fx * cp * d, R.y + sp * d, R.z - fz * cp * d);
    _Fw.set(R.x - _C.x, R.y + R.lift - _C.y, R.z - _C.z).normalize();
    _Rw.set(-_Fw.z, 0, _Fw.x).normalize();
    _Uw.crossVectors(_Rw, _Fw);
  },

  // screen-width fraction between the two principals' chests through the lens of pose R at arm d (signed: > 0 when
  // the man is on the `side` of 健人 the aim puts him on)
  sepAt(R, d, side, tH) {
    this.lensAt(R, d);
    const a = this._fpts[this._iPc], b = this._fpts[this._iTc];
    const za = (a.x - _C.x) * _Fw.x + (a.y - _C.y) * _Fw.y + (a.z - _C.z) * _Fw.z;
    const zb = (b.x - _C.x) * _Fw.x + (b.y - _C.y) * _Fw.y + (b.z - _C.z) * _Fw.z;
    if (za < 0.4 || zb < 0.4) return -1;
    const xa = ((a.x - _C.x) * _Rw.x + (a.z - _C.z) * _Rw.z) / (za * tH);
    const xb = ((b.x - _C.x) * _Rw.x + (b.z - _C.z) * _Rw.z) / (zb * tH);
    return side * (xb - xa) * 0.5;
  },

  // the points the framing is about, in world space, gathered once per combat frame (the solver and the fit read
  // the same list): head and feet of 健人 and his opponent from their bones (a reaction lean or a fall moves
  // them), their chests (w 0: the separation reference), and the rest of the pack with their chests (w < 0: only
  // tested for blocking)
  gatherFraming(e, tgt, others) {
    const L = this._fpts || (this._fpts = []);
    let n = this.manPoints(L, 0, e, 3, 0.8, 0.82, 0.92, 0);
    this._iPc = n - 1; this._iTc = -1;
    if (tgt) { n = this.manPoints(L, n, tgt, 2.5, 0.78, 0.82, 0.95, 0); this._iTc = n - 1; }
    this._fBlk = n;
    for (const x of others) {
      if (x === tgt) continue;
      n = isDown(x) ? this.manPoints(L, n, x, 0.8, 0.86, 0.9, 0.9, -1) : this.manPoints(L, n, x, 1, 0.88, 0.92, 0.95, -1);
    }
    this._fn = n;
  },

  // one man: two fitted points (head top + feet standing, head + feet on the ground) and his chest (weight cw) last
  manPoints(L, n, x, w, mH, mVh, mVf, cw) {
    const P = x.position, h = x.humanoid, down = isDown(x);
    if (h && typeof h.boneWorld === 'function') {
      h.boneWorld('Head', _bw);
      n = setPt(L, n, _bw.x, _bw.y + (down ? 0.12 : 0.18), _bw.z, w, mH, mVh);
      if (down) { h.boneWorld('LeftFoot', _bw); n = setPt(L, n, _bw.x, _bw.y + 0.1, _bw.z, w, mH, mVf); }
      else n = setPt(L, n, P.x, P.y + 0.1, P.z, w, mH, mVf);
      h.boneWorld('Spine2', _bw);
      return setPt(L, n, _bw.x, _bw.y, _bw.z, cw, 1, 1);
    }
    if (down) {
      const fy = x.yaw || 0;
      n = setPt(L, n, P.x - Math.sin(fy) * 1.2, P.y + 0.2, P.z - Math.cos(fy) * 1.2, w, mH, mVh);
      n = setPt(L, n, P.x, P.y + 0.25, P.z, w, mH, mVf);
      return setPt(L, n, P.x - Math.sin(fy) * 0.6, P.y + 0.25, P.z - Math.cos(fy) * 0.6, cw, 1, 1);
    }
    n = setPt(L, n, P.x, P.y + 1.8, P.z, w, mH, mVh);
    n = setPt(L, n, P.x, P.y + 0.1, P.z, w, mH, mVf);
    return setPt(L, n, P.x, P.y + 1.3, P.z, cw, 1, 1);
  },

  // Framing solver: score lens positions round the pair (either side of the axis, swung 0.33 .. 1.4 rad off it, 1.6
  // at contact range) through the pose the rig will really build, and aim for the cheapest. Cost = anyone out of
  // the HUD-safe frame (him and his opponent weigh most), backs between the lens and him, men hidden behind him, a
  // small preference for the standard over-the-shoulder swing, and a hard reject when the two principals' chests
  // are closer than 12 % of the frame. The aim changes only when a candidate beats it clearly for 0.5 s, and the
  // lens then glides there (swing / yaw springs), so the solver cannot make the frame hunt. Each aim also carries
  // an arm cap: the pack is fitted only as far as the principals stay apart.
  solveFraming(e, tgt, dt) {
    const SW = this._rig.sep < 1.3 ? SWINGS_CLOSE : SWINGS;
    // one broadphase round him for every candidate's arm cast (framingCost caps each aim's arm at the wall behind it)
    if (this.engine.world && this.occluderTags()) {
      _head.set(e.position.x, e.position.y + this.combatHeight, e.position.z);
      this.beginQueries(_head, this.combatMax + 4);
      this._lowSkip = -Infinity;
    }
    if (this._aimSide == null) { this._aimSide = this.side; this._aimSwing = this.combatAngle; }
    let best = Infinity, bSide = this._aimSide, bSwing = this._aimSwing, bCap = Infinity;
    const dbg = this.engine.params && this.engine.params.raw && this.engine.params.raw.camdbg ? (this._dbgList || (this._dbgList = [])) : null;
    if (dbg) dbg.length = 0;
    // the orbit an aim asks for is part of its price: the nearest good aim wins over a better one half a turn away
    // (a 1.5 rad swing takes a second, and the man winding up is behind 健人 the whole way round — measured in live
    // play). Dearer while the subject is an attacker: he has to be seen now.
    const G = this._rig, travel = isAttacking(tgt) ? 0.6 : 0.2;
    const orbitCost = (sd, sw) => travel * Math.abs(wrap(G.axisYaw + sd * sw * G.kS - this.yaw));
    const cur = this.framingCost(e, this._aimSide, this._aimSwing) + orbitCost(this._aimSide, this._aimSwing) - 0.1, curCap = this._lastCap;
    for (let sd = -1; sd <= 1; sd += 2) {
      for (let i = 0; i < SW.length; i++) {
        // changing sides is a long orbit across the line of action: it has to be worth it
        const c = this.framingCost(e, sd, SW[i]) + (sd !== this._aimSide ? 0.3 : 0) + orbitCost(sd, SW[i]);
        if (dbg) dbg.push(`${sd > 0 ? '+' : '-'}${SW[i]}:${c.toFixed(2)}${this._lastCap < 99 ? '@' + this._lastCap.toFixed(2) : ''}/g${this._lastG.toFixed(3)}`);
        if (c < best) { best = c; bSide = sd; bSwing = SW[i]; bCap = this._lastCap; }
      }
    }
    this.endQueries();
    if (dbg) this.dbgFrame = { best: +best.toFixed(3), cur: +(cur + 0.1).toFixed(3), side: bSide, swing: bSwing, all: dbg.join(' ') };
    if (!this.initialised) { this._aimSide = bSide; this._aimSwing = bSwing; this._aimCap = bCap; this._aimT = 0; return; }
    this._aimCap = curCap;
    if (best < cur - 0.2) {
      this._aimT = (this._aimT || 0) + dt;
      // the current aim merges the two principals (a reject, cost >= 50): nothing to wait for — the lens still glides
      if (this._aimT > (cur >= 49 ? 0 : 0.5)) {
        this._aimSide = bSide; this._aimSwing = bSwing; this._aimCap = bCap; this._aimT = 0;
        this.stats.aimSwitches = (this.stats.aimSwitches || 0) + 1;
      }
    } else this._aimT = 0;
  },

  // cost of standing the lens at (side, swing). Pass 1 solves the arm the fit would pick for that pose (fitCombat's
  // rule in closed form); if the pack would push the principals under 12 % apart the arm is capped where they
  // still are. Pass 2 projects every point through that exact lens.
  framingCost(e, side, swing) {
    const cam = this.cam, tV = Math.tan((cam.fov * Math.PI) / 360), tH = tV * cam.aspect;
    const R = this.rigPose(side, swing, this._pose || (this._pose = {}));
    const L = this._fpts, n = this._fn, blk = this._fBlk, iPc = this._iPc, hasT = this._iTc >= 0;
    const fx = Math.sin(R.yaw), fz = Math.cos(R.yaw), cp = Math.cos(R.pitch), sp = Math.sin(R.pitch), rx = -fz, rz = fx;
    let dP = this.combatMin, dA = 0;
    for (let i = 0; i < n; i++) {
      const r = L[i];
      if (r.w <= 0 && i !== iPc) continue;
      const qx = r.x - R.x, qy = r.y - R.y, qz = r.z - R.z;
      const z = qx * fx * cp - qy * sp + qz * fz * cp;
      if (i === iPc) { dP = Math.max(dP, this.combatDepth - z); continue; }
      const dd = fitDist(qx * rx + qz * rz, qx * fx * sp + qy * cp + qz * fz * sp, z, tH, tV, r.mH, r.mV);
      if (i < blk) dP = Math.max(dP, dd); else dA = Math.max(dA, dd);
    }
    dP = Math.min(dP, this.combatMax);
    let d = Math.max(dP, Math.min(dA, this.combatMax)), cap = Infinity, cost0 = 0;
    let g = hasT ? this.sepAt(R, d, side, tH) : 1;
    // too close to tell apart at this arm: come in (past the depth floor, down to combatClose) until there is a
    // clear gap (SEP_AIM), or at least the floor
    if (hasT && g < SEP_AIM && d > this.combatClose + 0.05) {
      const gc = this.sepAt(R, this.combatClose, side, tH);
      const want = gc >= SEP_AIM ? SEP_AIM : gc >= MIN_SEP + 0.01 ? MIN_SEP + 0.01 : MIN_SEP;
      if (gc >= want) {
        let lo = this.combatClose, hi = d;
        for (let k = 0; k < 6; k++) { const mid = (lo + hi) * 0.5; if (this.sepAt(R, mid, side, tH) >= want) lo = mid; else hi = mid; }
        d = cap = lo; g = this.sepAt(R, d, side, tH);
      }
    }
    // the arm this aim can really have: a wall (or a car, a facade) behind it pulls the lens in, and a lens pulled in
    // to a metre frames 健人's head and loses everyone else. Scoring the pose at that arm is what swings the camera
    // to the open side near a wall instead of leaving it pinned there (readability review, P1).
    if (this._local) {
      _tmp.set(-fx * cp, sp, -fz * cp);
      _o.set(R.x, R.y, R.z);
      const free = this.castLen(_o, _tmp, d + this.probeRadius) - this.probeRadius;
      if (free < d) { cost0 = (d - Math.max(0, free)) * 0.6; d = Math.max(0.5, free); if (hasT) g = this.sepAt(R, d, side, tH); }
    }
    this.lensAt(R, d);
    let cost = cost0 + 0.5 * (swing - this.combatAngle) + 0.08 * Math.max(0, d - this.combatMin) + 0.3 * Math.max(0, this.combatMin - d);
    const pc = L[iPc];
    const zP = (pc.x - _C.x) * _Fw.x + (pc.y - _C.y) * _Fw.y + (pc.z - _C.z) * _Fw.z;
    const XP = zP > 0.4 ? ((pc.x - _C.x) * _Rw.x + (pc.z - _C.z) * _Rw.z) / (zP * tH) : 0;
    for (let i = 0; i < n; i++) {
      const r = L[i];
      if (r.w === 0) continue;
      const qx = r.x - _C.x, qy = r.y - _C.y, qz = r.z - _C.z;
      const z = qx * _Fw.x + qy * _Fw.y + qz * _Fw.z;
      if (r.w < 0) {
        if (z < 0.4) continue;
        const dx = Math.abs((qx * _Rw.x + qz * _Rw.z) / (z * tH) - XP);
        if (z < zP - 0.3) { if (dx < 0.22) cost += (0.22 - dx) * 6; }          // a back between the lens and him
        else if (z > zP + 0.3 && dx < 0.14) cost += (0.14 - dx) * 5;           // a man hidden behind his silhouette
        continue;
      }
      if (z < 0.4) { cost += r.w * 6; continue; }
      if (i >= blk && z < 3) cost += (3 - z) * 0.5;                            // a bystander looming in the foreground
      const X = (qx * _Rw.x + qz * _Rw.z) / (z * tH), Y = (qx * _Uw.x + qy * _Uw.y + qz * _Uw.z) / (z * tV);
      let v = Math.max(0, Math.abs(X) - r.mH - 0.04) + Math.max(0, Math.abs(Y) - r.mV - 0.04);
      for (let j = 0; j < HUD_BOXES.length; j++) {
        const b = HUD_BOXES[j];
        if (X * b[0] <= 0 || Y * b[1] <= 0) continue;
        const inside = Math.min(Math.abs(X) - b[2], Math.abs(Y) - b[3]);
        if (inside > 0) v += inside;
      }
      cost += r.w * 4 * v;
    }
    // the two principals merging into one silhouette is not a trade-off, it is a reject (still ranked by how bad)
    if (hasT && g < MIN_SEP) cost += 50 + (MIN_SEP - g) * 100;
    else if (hasT && g < SEP_AIM) cost += (SEP_AIM - g) * 6;
    const force = this.engine.params && this.engine.params.raw && this.engine.params.raw.camaim;   // debug: ?camaim=side,swing
    if (force) { const f = String(force).split(','); if (+f[0] !== side || Math.abs(+f[1] - swing) > 1e-3) cost += 100; }
    const ban = this._aimBan;
    if (ban) for (let i = 0; i < ban.length; i += 2) if (ban[i] === side && Math.abs(ban[i + 1] - swing) < 1e-3) cost += 50;
    this._lastCap = cap; this._lastG = g;
    return cost;
  },

  nearbyEnemies(e, radius) {
    const en = this.engine.get('enemy');
    const list = en && en.list;
    const out = this._near || (this._near = []);
    out.length = 0;
    if (!list) return out;
    for (const x of list) {
      if (!x || !x.alive || !x.position) continue;
      if (x.position.distanceToSquared(e.position) < radius * radius) out.push(x);
    }
    return out;
  },

  // closed-form fit: the arm length at which every point of interest projects inside a safe frame. For a point
  // q (relative to the look point) with lens-space x = q.R, y = q.U, z = q.F + d, "inside" needs |x| <= z*tanH and
  // |y| <= z*tanV, i.e. d >= max(|x|/tanH, |y|/tanV) - q.F. Same points and rule as framingCost, through the real
  // lens pitch (crane lift included); the pack is fitted only up to the solver's arm cap for this aim.
  fitCombat(e, tgt, dt, lookPt) {
    const cam = this.cam;
    const ep = clamp(clamp(this.pitch, this.pitchMin, this.pitchMax) + Math.min(0.6, this.lift + this.occLift), this.pitchMin, 1.25);
    this.armDir(ep, _F).negate();                                          // lens forward
    _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    _U.crossVectors(_right, _F);
    const tV = Math.tan((cam.fov * Math.PI) / 360);
    const tH = tV * cam.aspect;
    const L = this._fpts, n = this._fn || 0, blk = this._fBlk || 0;
    // 健人 himself never closer than `combatDepth` to the lens: he reads at about half the frame height, the
    // way a 龍が如く brawl is shot, instead of a back filling the screen
    let needP = this.combatMin, needA = 0;
    for (let i = 0; i < n; i++) {
      const r = L[i];
      if (r.w <= 0 && i !== this._iPc) continue;
      _tmp.set(r.x - lookPt.x, r.y - lookPt.y, r.z - lookPt.z);
      const qz = _tmp.dot(_F);
      if (i === this._iPc) { needP = Math.max(needP, this.combatDepth - qz); continue; }
      const d = fitDist(_tmp.dot(_right), _tmp.dot(_U), qz, tH, tV, r.mH, r.mV);
      if (i < blk) needP = Math.max(needP, d); else needA = Math.max(needA, d);
    }
    needP = Math.min(needP, this.combatMax);
    const cap = this._aimCap != null ? this._aimCap : Infinity;
    const need = Math.max(this.combatClose, Math.min(clamp(Math.max(needP, Math.min(needA, this.combatMax)), this.combatMin, this.combatMax), cap));
    if (!this.initialised) this.combatDist = need;
    // widening is prompt, closing back in is slow and waits for the fight to settle: no pumping
    if (need > this.combatDist + 0.02) { this.combatDist = smoothDamp(this.combatDist, need, this._distV, 0.4, dt); this._fitHold = 0.6; }
    else if ((this._fitHold = (this._fitHold || 0) - dt) <= 0) this.combatDist = smoothDamp(this.combatDist, need, this._distV, 1.2, dt);
    else this.combatDist = smoothDamp(this.combatDist, this.combatDist, this._distV, 0.4, dt);
    return this.combatDist;
  },

  // primary subject: the lock-on, else the enemy he is squaring up to, with hysteresis so the framing does not
  // flick between two men standing at similar range
  pickTarget(e, inCombat, dt = 1 / 60) {
    if (e.lockTarget && e.lockTarget.alive) return e.lockTarget;
    if (!inCombat) return null;
    const list = this.nearbyEnemies(e, 12);
    if (!list.length) return null;
    const fx = Math.sin(e.yaw || 0), fz = Math.cos(e.yaw || 0);
    let best = null, bs = 1e9;
    for (const x of list) { const s = targetScore(e, x, fx, fz); if (s < bs) { bs = s; best = x; } }
    const cur = this.target && this.target.alive && list.includes(this.target) ? this.target : null;
    if (!cur || cur === best) { this._switchT = 0; return best; }
    if (bs < targetScore(e, cur, fx, fz) - 1.4) {
      this._switchT += dt;
      // an attacker takes the frame in a tenth of a second (his wind-up is the whole warning), anyone else in 0.35 s
      if (this._switchT > (isAttacking(best) ? 0.1 : 0.35)) { this._switchT = 0; return best; }
    } else this._switchT = 0;
    return cur;
  },

  // --------------------------------------------------------------------------------------- collision queries
  // tags worth colliding with: everything the world registered except the thin/moving ones. Rebuilt when the
  // static count changes (landmarks and props all register during boot, before the first camera update).
  occluderTags() {
    const world = this.engine && this.engine.world;
    if (!world || !world.statics) return null;
    if (this._tagCacheLen !== world.statics.length) {
      const set = new Set();
      for (const s of world.statics) if (s && !PASS_THROUGH.has(s.tag)) set.add(s.tag);
      this._occTags = set.size ? Array.from(set) : ['building'];
      this._tagCacheLen = world.statics.length;
    }
    return this._occTags;
  },

  // free length along a ray (maxLen when nothing is hit)
  castLen(origin, dir, maxLen) {
    const world = this.engine.world, tags = this.occluderTags();
    if (!world || !tags) return maxLen;
    if (this._local) {
      const d = this.localCast(origin, dir, maxLen);
      // the first few hundred local answers are checked against the world: a physics refactor that changes the
      // shape layout switches the broadphase off instead of letting the lens through a wall
      if (this._verify > 0 && this._lowSkip === -Infinity) {
        this._verify--;
        const hit = world.raycast(origin, dir, maxLen, { tags });
        const w = hit && hit.distance < maxLen ? hit.distance : maxLen;
        if (Math.abs(w - d) > 0.01) { this._localBroken = true; this._local = false; console.warn('[camera] broadphase disagrees with world.raycast; using world queries'); return w; }
      }
      return d;
    }
    const hit = world.raycast(origin, dir, maxLen, { tags });
    return hit && hit.distance < maxLen ? hit.distance : maxLen;
  },

  // Broadphase for one follow update: the ~15 rays of a frame all live inside a sphere round his head, so the
  // occluders touching that sphere are gathered once (one pass over the world) and every ray after that tests a
  // handful of boxes instead of all 1,100+. Falls back to world.raycast for any shape it does not understand.
  beginQueries(center, radius) {
    this._local = false; this._candOk = false;
    const world = this.engine.world, tags = this.occluderTags();
    if (!world || !tags || !world.overlapSphere || this._localBroken) return;
    const hits = world.overlapSphere(center, radius, { tags }) || NO_HITS;
    const cand = this._cand || (this._cand = []), low = this._candLow || (this._candLow = []);
    cand.length = 0; low.length = 0;
    for (const h of hits) {
      const sh = h.shape;
      if (!sh || !sh.min || !sh.max || (sh.kind !== 'aabb' && !(sh.kind === 'obb' && sh.half && sh.center))) return;
      cand.push(sh);
      // street-level blocks (the ハチ公 plinth, planters, benches): their top, so the arm can pass over them
      const gy = world.groundHeight((sh.min.x + sh.max.x) * 0.5, (sh.min.z + sh.max.z) * 0.5);
      low.push(sh.max.y - gy < 2.2 ? sh.max.y : Infinity);
    }
    this._lowSkip = -Infinity;
    this._local = true;
    // the candidate list stays valid for sphere tests inside this ball until the end of the frame (the shake
    // clamp runs after endQueries)
    const cc = this._candC || (this._candC = new THREE.Vector3());
    cc.copy(center); this._candR = radius; this._candOk = true;
  },

  endQueries() { this._local = false; this._lowSkip = -Infinity; },

  // sphere vs the frame's candidate boxes, same contract as physics.overlapSphere (XZ footprint inside = hit)
  insideLocal(p, r) { return insideList(this._cand, p, r); },

  // same contract as physics.raycast: a box that contains the origin is ignored (the chain never starts inside
  // one, and if the player is ever pushed into a box this keeps the lens outside it)
  localCast(o, d, maxLen) {
    let best = maxLen;
    const cand = this._cand, low = this._candLow, skip = this._lowSkip;
    for (let i = 0; i < cand.length; i++) {
      if (low[i] < skip) continue;
      const sh = cand[i];
      let t;
      if (sh.kind === 'aabb') t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, sh.min.x, sh.min.y, sh.min.z, sh.max.x, sh.max.y, sh.max.z, best);
      else {
        const ox = o.x - sh.center.x, oz = o.z - sh.center.z;
        t = rayBox(sh.c * ox - sh.s * oz, o.y, sh.s * ox + sh.c * oz, sh.c * d.x - sh.s * d.z, d.y, sh.s * d.x + sh.c * d.z,
          -sh.half.x, sh.center.y - sh.half.y, -sh.half.z, sh.half.x, sh.center.y + sh.half.y, sh.half.z, best);
      }
      if (t >= 0 && t < best) best = t;
    }
    return best;
  },

  // the longest arm (<= maxLen) whose end sphere of radius r stays clear: rays from the free root to a ring of
  // radius r around the would-be lens (5 rays, or 3 horizontal ones for the cheap soft pass)
  coneCast(origin, dir, maxLen, r, rays = 5) {
    _cr.set(dir.z, 0, -dir.x);
    if (_cr.lengthSq() < 1e-6) _cr.set(1, 0, 0); else _cr.normalize();
    _cu.crossVectors(_cr, dir).normalize();
    const reach = maxLen + r;
    let best = maxLen;
    const n = rays >= 5 ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const o = CONE[i];
      _ray.copy(dir).multiplyScalar(reach).addScaledVector(_cr, o[0] * r).addScaledVector(_cu, o[1] * r);
      const L = _ray.length();
      _ray.multiplyScalar(1 / L);
      const free = this.castLen(origin, _ray, L);
      if (free < L) {
        // a hit at fraction f of this ray caps the arm at f of the reach, minus the lens radius
        const cap = (free / L) * reach - (i === 0 ? r : r * 0.5);
        if (cap < best) best = cap;
      }
    }
    return Math.max(0.05, best);
  },

  // soft pass: two rays parallel to the arm at +-r (horizontal), each rooted at a point proven free by a sideways
  // leg from the arm root, plus the centre ray. Returns the free arm length.
  // soft pass: a horizontally tapered cylinder round the arm — radius 0 at the root (a wall he is standing
  // beside is not "in the way"), growing to r at `taper` metres, constant after. Each side is two straight legs,
  // root -> shoulder of the taper -> along the arm, so every leg starts from a point the previous leg proved free.
  cylinderCast(origin, dir, maxLen, r, taper = 1.5) {
    _cr.set(dir.z, 0, -dir.x);
    if (_cr.lengthSq() < 1e-6) _cr.set(1, 0, 0); else _cr.normalize();
    let best = this.castLen(origin, dir, maxLen);
    const L1 = Math.min(taper, maxLen);
    for (let side = -1; side <= 1; side += 2) {
      _cp.copy(origin).addScaledVector(dir, L1).addScaledVector(_cr, side * r);
      _ray.subVectors(_cp, origin);
      const len1 = _ray.length();
      _ray.multiplyScalar(1 / len1);
      const f1 = this.castLen(origin, _ray, len1);
      if (f1 < len1) { best = Math.min(best, (f1 / len1) * L1); continue; }
      if (maxLen > L1) {
        const f2 = this.castLen(_cp, dir, maxLen - L1);
        best = Math.min(best, L1 + f2);
      }
    }
    return Math.max(0.05, best);
  },

  // move `to` back toward `from` so the segment from -> to keeps `r` clear of every occluder
  clampLeg(from, to, r) {
    _tmp.subVectors(to, from);
    const L = _tmp.length();
    if (L < 1e-4) return;
    _tmp.multiplyScalar(1 / L);
    const free = this.castLen(from, _tmp, L + r);
    if (free < L + r) to.copy(from).addScaledVector(_tmp, Math.max(0, free - r));
  },

  segmentClear(a, b) {
    _tmp.subVectors(b, a);
    const L = _tmp.length();
    if (L < 1e-4) return true;
    return this.castLen(a, _tmp.multiplyScalar(1 / L), L) >= L;
  },

  insideOccluder(p, r) {
    const world = this.engine.world, tags = this.occluderTags();
    if (!world || !tags || !world.overlapSphere) return false;
    if (this._candOk && !this._localBroken && p.distanceTo(this._candC) + r <= this._candR) {
      const hit = this.insideLocal(p, r);
      // the first answers are cross-checked like the ray broadphase: a disagreement turns the local path off
      if (this._verifyS === undefined) this._verifyS = 200;
      if (this._verifyS > 0) {
        this._verifyS--;
        const w = world.overlapSphere(p, r, { tags });
        if (!!(w && w.length) !== hit) { this._localBroken = true; this._candOk = false; console.warn('[camera] local sphere test disagrees with world.overlapSphere; using world queries'); return !!(w && w.length); }
      }
      return hit;
    }
    const hits = world.overlapSphere(p, r, { tags });
    return !!(hits && hits.length);
  },

  // ------------------------------------------------------------------------------------- shot harness
  // shots.js pins the camera with setFixed() right after a preset's setup(); these presets ask for the LIVE
  // rig back on the next frame so a screenshot shows the real gameplay framing, not a hand-placed view.
  preview(opts) { this._preview = opts || {}; },

  // a preview waits for the boot (combat stages its tableau on engine:booted), `wait` further frames, and, for the
  // staged fight, for combat to report the stage applied (its stageReact; 30 frames at the outside)
  previewReady(p) {
    const engine = this.engine;
    if (!engine.booted) return false;
    p.waited = (p.waited || 0) + 1;
    if (p.waited <= (p.wait || 0)) return false;
    if (p.staged && p.waited < 30) {
      const cb = engine.get('combat');
      if (cb && cb.stage && cb.stageReact == null) return false;
    }
    return true;
  },

  // canonical solver / spring state: a preview settles from here, never from whatever the rig did before
  resetRig() {
    this._aimSide = null; this._aimSwing = null; this._aimT = 0; this._aimCap = Infinity;
    if (this._aimBan) this._aimBan.length = 0;
    this.swing = this.combatAngle; this.side = 1; this.target = null; this._switchT = 0; this._desiredYaw = null;
    this.surround = 0; this.behind = 0; this._whisk = 0; this._fitHold = 0;
    this.combatDist = this.combatDepth; this.distCur = this.distance; this.pitch = 0.12;
    this.lift = 0; this.occLift = 0; this._occT = 0; this.compression = 0;
    this.arm = this.armSm = this.distance; this.armLimit = 99; this.armHold = 0; this.shoulderCur = this.shoulder;
    this.vel.set(0, 0, 0); this.lookAccum.set(0, 0); this.roll = 0;
    this.fovImpulse = 0; this.fovSprint = 0; this.fovAim = this.fovBase;
    this.trauma = 0; this.shakeEnd = 0; this.punchX.set(0, 0, 0); this.punchV.set(0, 0, 0);
    this._pv.x.v = this._pv.y.v = this._pv.z.v = 0; this._yawV.v = 0; this._distV.v = 0; this._dcV.v = 0; this._olV.v = 0;
    for (const k of ['_swV', '_shV', '_whV']) if (this[k]) this[k].v = 0;
  },

  // the principals' chest separation through the real lens (fraction of the frame width, signed like sepAt)
  measureSeparation() {
    const e = this.entity, t = this.target;
    if (!e || !t || !e.humanoid || !t.humanoid) return null;
    this.cam.updateMatrixWorld(true);
    e.humanoid.boneWorld('Spine2', _a).project(this.cam);
    t.humanoid.boneWorld('Spine2', _b).project(this.cam);
    if (_a.z > 1 || _b.z > 1) return -1;
    return this.side * (_b.x - _a.x) * 0.5;
  },

  applyPreview(p) {
    const engine = this.engine;
    const e = p.entity || engine.player;
    if (!e) return;
    if (p.closeup) { this.frameCloseup(e); return; }
    // staging runs here, on the first live frame, i.e. after every module's own boot-time staging has happened
    if (typeof p.stage === 'function') { try { p.stage(engine); } catch (err) { console.warn('[camera] preview stage failed', err); } }
    // ?camnoblur=1 (debug): judge a framing without the radial impact blur that staged fight stills hold
    const pfx = engine.get('postfx'), raw = engine.params && engine.params.raw;
    if (raw && raw.camnoblur && pfx && pfx.hold) pfx.hold.radial = 0;
    this.resetRig();
    this.setFollow(e, p);
    if (p.yaw != null) this.yaw = p.yaw;
    if (p.pitch != null) this.pitch = p.pitch;
    if (p.faceWall) {
      // find the nearest facade, stand him `standoff` metres off it, and point the arm into it
      const world = engine.world, tags = this.occluderTags();
      let bd = 99, byaw = this.yaw;
      const hp = new THREE.Vector3();
      if (world && tags) {
        for (let i = 0; i < 32; i++) {
          const a = (i / 32) * Math.PI * 2;
          _tmp.set(Math.sin(a), 0, Math.cos(a));
          _a.set(e.position.x, e.position.y + this.height, e.position.z);
          const hit = world.raycast(_a, _tmp, 16, { tags });
          if (hit && hit.distance > 0.4 && hit.distance < bd) { bd = hit.distance; byaw = wrap(a + Math.PI); hp.copy(hit.point); }
        }
      }
      const stand = p.faceWall.standoff || 0;
      if (stand > 0 && bd < 90) {
        _tmp.set(Math.sin(byaw), 0, Math.cos(byaw));
        e.position.set(hp.x + _tmp.x * stand, e.position.y, hp.z + _tmp.z * stand);
      }
      this.yaw = byaw + (p.faceWall.yawOffset || 0);
      e.yaw = byaw + (p.faceWall.turn || 0); e.group.rotation.y = e.yaw;
    }
    if (p.combat) this.combat = true;
    if (p.trauma) this.shake(p.trauma, p.traumaDuration || 30);
    if (p.fovSprint) this.fovSprint = p.fovSprint;
    if (p.lockNearest && engine.get('enemy')) {
      const list = engine.get('enemy').list || [];
      let best = null, bd = 99;
      for (const x of list) { if (!x.alive) continue; const d = x.position.distanceTo(e.position); if (d < bd) { bd = d; best = x; } }
      e.lockTarget = best;
    }
    // settle the spring so the frame is the converged framing, not frame 1 of a lerp
    const steps = p.settle != null ? p.settle : 40;
    for (let i = 0; i < steps; i++) { try { this.updateFollow(1 / 60); } catch (_) { break; } }
    // the check the solver's model cannot fake: the two chests through the real lens. An aim that still merges
    // them is banned and the rig re-solves from a cut (at most three times)
    if (p.verify) {
      for (let k = 0; k < 3; k++) {
        const g = this.measureSeparation();
        this._sepReport = g;
        if (g == null || g >= MIN_SEP) break;
        (this._aimBan || (this._aimBan = [])).push(this._aimSide, this._aimSwing);
        this._aimT = 1; this.initialised = false;
        for (let i = 0; i < 150; i++) { try { this.updateFollow(1 / 60); } catch (_) { break; } }
      }
      this._sepReport = this.measureSeparation();
    }
    if (p.cine) this.cinematic(typeof p.cine === 'function' ? p.cine(engine) : p.cine);
    else if (engine.state.frozen && this.mode === 'follow') {
      this._hold = { pos: this.cam.position.clone(), quat: this.cam.quaternion.clone(), fov: this.cam.fov };
    }
    if (typeof p.post === 'function') { try { p.post(engine); } catch (err) { console.warn('[camera] preview post failed', err); } }
    if (raw && raw.camdbg && this._rig && this._aimSide != null) {
      const R = this.rigPose(this._aimSide, this._aimSwing, {});
      const tV = Math.tan((this.cam.fov * Math.PI) / 360);
      const gm = this._iTc >= 0 ? this.sepAt(R, this.combatDist, this._aimSide, tV * this.cam.aspect) : null;
      this.cam.getWorldDirection(_tmp);
      console.info(`[camdbg] model lens=${_C.x.toFixed(3)},${_C.y.toFixed(3)},${_C.z.toFixed(3)} real=${this.cam.position.x.toFixed(3)},${this.cam.position.y.toFixed(3)},${this.cam.position.z.toFixed(3)} fwdModel=${_Fw.x.toFixed(3)},${_Fw.y.toFixed(3)},${_Fw.z.toFixed(3)} fwdReal=${_tmp.x.toFixed(3)},${_tmp.y.toFixed(3)},${_tmp.z.toFixed(3)} gModel=${gm != null ? gm.toFixed(3) : '-'} yaw=${this.yaw.toFixed(3)} R.yaw=${R.yaw.toFixed(3)} swing=${this.swing.toFixed(3)} kS=${this._rig.kS.toFixed(3)} sep=${this._rig.sep.toFixed(3)} fov=${this.cam.fov.toFixed(2)} arm=${this.arm.toFixed(3)} tgt=${this.target && this.target.id} pts=${this._fn} pc=${JSON.stringify(this._fpts[this._iPc])} tc=${JSON.stringify(this._fpts[this._iTc])}`);
    }
    if (raw && raw.camdbg && this.dbgFrame) console.info(`[camdbg] solve ${JSON.stringify(this.dbgFrame)}`);
    if (raw && raw.camdbg && this._koLight) console.info(`[camdbg] ko ${JSON.stringify(this._koLight)}`);
    if (raw && raw.camdbg && pfx && pfx._radialCenter) console.info(`[camdbg] radialCenter=${pfx._radialCenter.x.toFixed(3)},${pfx._radialCenter.y.toFixed(3)} rect=${JSON.stringify(this.subjectRect)}`);
    if (raw && raw.camdbg) console.info(`[camdbg] preview aim=${this._aimSide}/${this._aimSwing} cap=${this._aimCap} dist=${this.combatDist.toFixed(2)} sep=${this._sepReport != null ? this._sepReport.toFixed(3) : '-'} bans=${(this._aimBan || []).join(',')} near=${this.cam.near}`);
  },

  // preset helper: drop 健人 somewhere and re-form the ?fight=1 group around him, so the framing shot is about the
  // camera and not about wherever the city happened to put its spawn points. `lane` = [[forward, right], ...].
  stageFight(engine, at, yaw, lane) {
    const pl = engine.get('player'), en = engine.get('enemy');
    if (pl && pl.respawn) pl.respawn(at, yaw);
    if (engine.player) { engine.player.position.y = engine.world ? engine.world.groundHeight(at.x, at.z) : 0; engine.player.group.rotation.y = yaw; }
    const list = (en && en.list) ? en.list.filter((x) => x.alive) : [];
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const rgt = new THREE.Vector3(fwd.z, 0, -fwd.x);   // (cos, 0, -sin): his LEFT, as the first rig laid lanes out
    const L = lane || [[3.0, -0.2], [4.6, 2.0], [4.4, -2.4]];
    list.forEach((x, i) => {
      const l = L[i % L.length];
      const q = at.clone().addScaledVector(fwd, l[0]).addScaledVector(rgt, l[1]);
      x.position.set(q.x, engine.world ? engine.world.groundHeight(q.x, q.z) : 0, q.z);
      x.yaw = Math.atan2(at.x - q.x, at.z - q.z);
      x.group.rotation.y = x.yaw;
      x.aggro = true;
    });
    engine.state.mode = 'combat';
  },

  shotPresets: {
    // live third-person rig behind 健人 on the Hachiko apron, looking north-west across the scramble
    cam_follow: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night',
      setup(engine) {
        const pl = engine.get('player');
        if (pl && pl.respawn) pl.respawn(new THREE.Vector3(20, 0, 26), -Math.PI * 0.72);
        camera.preview({ yaw: -Math.PI * 0.72, pitch: 0.12 });
      },
    }),
    // sprint framing: arm stretched, fov kicked out
    cam_sprint: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night',
      setup(engine) {
        const pl = engine.get('player');
        if (pl && pl.respawn) pl.respawn(new THREE.Vector3(6, 0, 18), -Math.PI * 0.78);
        if (engine.player) engine.player.moveSpeed = 5.6;
        camera.preview({ yaw: -Math.PI * 0.78, pitch: 0.1, fovSprint: 5.0 });
      },
    }),
    // combat framing: player + locked enemy held in frame by the swung axis, the midpoint pivot and the fit
    cam_fight: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night', fight: true,
      setup(engine) {
        const stage = (eng) => camera.stageFight(eng, new THREE.Vector3(20, 0, 28), -Math.PI * 0.62);
        stage(engine);
        camera.preview({ stage, combat: true, lockNearest: true, settle: 240 });
      },
    }),
    // surrounded: one man at his back, one on each flank -> the rig pulls back and rises to show the ring
    cam_surround: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night', fight: true,
      setup(engine) {
        const stage = (eng) => camera.stageFight(eng, new THREE.Vector3(20, 0, 28), -Math.PI * 0.62, [[2.4, 0.3], [-1.3, 2.3], [-2.2, -1.6]]);
        stage(engine);
        camera.preview({ stage, combat: true, settle: 300, yaw: -Math.PI * 0.62 });
      },
    }),
    // spring arm driven into a facade: the pull-in and the crane lift keep the lens out of the geometry
    cam_wall: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night',
      setup(engine) {
        const pl = engine.get('player');
        if (pl && pl.respawn) pl.respawn(new THREE.Vector3(31, 0, -16.5), Math.PI);
        camera.preview({ faceWall: { standoff: 0.75 }, pitch: 0.12, settle: 120 });
      },
    }),
    // the arm swung across a building corner at his right shoulder: the shoulder retracts, the arm shortens
    cam_corner: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night',
      setup(engine) {
        const pl = engine.get('player');
        if (pl && pl.respawn) pl.respawn(new THREE.Vector3(31, 0, -16.5), Math.PI);
        camera.preview({ faceWall: { standoff: 1.1, yawOffset: 0.95 }, pitch: 0.1, settle: 120 });
      },
    }),
    // 健人 with his back to the ハチ公 plinth and the arm swung over it: no snap-in on the 1.55 m block, and the
    // lens cranes up to look down over it instead of framing the bronze dog's flank
    cam_plinth: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night',
      setup(engine) {
        const stage = (eng) => { const pl = eng.get('player'); if (pl && pl.respawn) pl.respawn(new THREE.Vector3(26, 0, 26.9), 0); if (eng.player) eng.player.group.rotation.y = 0; };
        stage(engine);
        camera.preview({ stage, settle: 200, yaw: 0, pitch: 0.12 });
      },
    }),
    // cinematic rig driven in the player's local frame (what a heat action gets)
    cam_cine: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night', fight: true,
      setup(engine) {
        const stage = (eng) => { camera.stageFight(eng, new THREE.Vector3(20, 0, 28), -Math.PI * 0.62); eng.state.mode = 'cutscene'; };
        stage(engine);                                 // cutscene mode, as a heat action does: everyone holds their pose
        camera.preview({
          stage, settle: 4,
          cine: (eng) => ({
            relativeTo: eng.player,                    // +z forward, +x right, metres — the heat-action frame
            shots: [
              { pos: [-2.6, 1.9, 2.4], lookAt: [0, 1.35, 1.2], fov: 42, duration: 0.7, ease: 0.25 },
              { pos: [2.8, 1.2, -0.5], lookAt: [0.05, 1.25, 1.14], to: { pos: [2.3, 1.05, 0.5], fov: 33 }, fov: 38, duration: 60, cut: true },
            ],
          }),
        });
      },
    }),
    // the same heat-action shot staged with a facade on the camera side: the rig mirrors it to the open side
    cam_cine_wall: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night', fight: true,
      setup(engine) {
        const pl = engine.get('player');
        if (pl && pl.respawn) pl.respawn(new THREE.Vector3(31, 0, -16.5), Math.PI);
        engine.state.mode = 'cutscene';
        camera.preview({
          faceWall: { standoff: 1.0, turn: Math.PI / 2 }, settle: 4,
          cine: (eng) => {
            const p = eng.player, en = eng.get('enemy');
            const f = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
            const x = en && en.list && en.list.find((q) => q.alive);
            if (x) {
              x.position.set(p.position.x + f.x * 1.4, p.position.y, p.position.z + f.z * 1.4);
              x.yaw = p.yaw + Math.PI; x.group.rotation.y = x.yaw;
            }
            // deliberately authored on the WALL side: the rig has to mirror it to the open side to get a picture
            const plusX = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
            const world = eng.world, tags = camera.occluderTags();
            const o = new THREE.Vector3(p.position.x, p.position.y + 1.3, p.position.z);
            const hp = world.raycast(o, plusX, 8, { tags }), hn = world.raycast(o, plusX.clone().negate(), 8, { tags });
            const side = (hp ? hp.distance : 99) <= (hn ? hn.distance : 99) ? 1 : -1;
            return { relativeTo: [p, x || p], shots: [{ pos: [2.9 * side, 1.25, 0.35], lookAt: [0, 1.2, 0.7], fov: 36, duration: 60, cut: true }] };
          },
        });
      },
    }),
    // trauma shake held at full strength so the displacement and roll are visible in a still
    cam_shake: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night', fight: true,
      setup(engine) {
        const stage = (eng) => camera.stageFight(eng, new THREE.Vector3(20, 0, 28), -Math.PI * 0.62);
        stage(engine);
        camera.preview({ stage, combat: true, lockNearest: true, trauma: 1, traumaDuration: 40, settle: 240 });
      },
    }),
    // the fight's final blow, PLAYED live (combat.prepFinaleStill) and held at ?kok=<0..1> of the whole sequence
    // (default 0.5). ?shot=final_blow&t=<real seconds from the contact> is the same thing on the real clock.
    cam_ko: () => ({
      pos: [26.3, 2.0, 32.3], lookAt: [24, 1.5, 30], t: 'night', fight: true,
      setup(engine) {
        const cb = engine.get('combat'), raw = (engine.params && engine.params.raw) || {};
        const kok = raw.kok != null && raw.kok !== '' && isFinite(Number(raw.kok)) ? Number(raw.kok) : 0.5;
        if (cb && cb.prepFinaleStill) cb.prepFinaleStill(engine, clamp(kok, 0, 1) * fbEnd());
      },
    }),
  },

  async selfTest(engine) {
    const cam = this.cam || engine.camera;
    const out = { mode: this.mode, occluderTags: (this.occluderTags() || []).length };
    const e = engine.player;
    if (!e) return { ...out, error: 'no player' };
    // settle, then measure frame-to-frame movement with a static subject: this must be ~0 (no jitter)
    const savedMode = this.mode, savedFixed = this.fixed;
    this.mode = 'follow'; this.fixed = null; this.entity = e; this.initialised = false;
    for (let i = 0; i < 480; i++) this.updateFollow(1 / 60);
    let maxStep = 0;
    const last = cam.position.clone();                     // not a module scratch vector: updateFollow uses those
    for (let i = 0; i < 60; i++) { this.updateFollow(1 / 60); maxStep = Math.max(maxStep, cam.position.distanceTo(last)); last.copy(cam.position); }
    out.jitterMm = Math.round(maxStep * 1e5) / 100;
    out.arm = Math.round(this.arm * 1000) / 1000;
    out.fov = Math.round(cam.fov * 100) / 100;
    out.finite = ['x', 'y', 'z'].every((k) => Number.isFinite(cam.position[k])) && Number.isFinite(cam.fov);
    out.aboveGround = cam.position.y > (engine.world ? engine.world.groundHeight(cam.position.x, cam.position.z) : 0) + 0.3;
    out.lensClear = !this.insideOccluder(cam.position, 0.02);
    // cinematic frame maths: a shot 2 m behind the actor must land 2 m behind him in world space, and local +x
    // must be his right hand
    const probe = { position: new THREE.Vector3(10, 0, -5), yaw: Math.PI / 2 };
    this.resolveShot(probe, new THREE.Vector3(0, 1, -2), _b);
    out.relFrame = `${_b.x.toFixed(2)},${_b.y.toFixed(2)},${_b.z.toFixed(2)}`;  // expect 8.00,1.00,-5.00
    this.resolveShot({ position: new THREE.Vector3(), yaw: 0 }, new THREE.Vector3(1, 0, 0), _b);
    out.localXIsLeft = _b.x > 0.99;                                              // yaw 0 faces +z: his left is +x
    // shot list: resolves {cancelled:false}, emits one cut per hard cut, ends exactly on the last framing
    let cuts = 0;
    const onCut = () => { cuts++; };
    engine.events.on('camera:cut', onCut);
    const actor = { position: new THREE.Vector3(5, 0, 5), yaw: 0 };
    const done = this.cinematic({ relativeTo: actor, collide: false, blendOut: 0, shots: [
      { pos: [0, 2, -3], lookAt: [0, 1, 0], duration: 0.2, cut: true },
      { pos: [1, 1.5, 2], lookAt: [0, 1, 0], duration: 0.2, cut: true },
    ] });
    for (let i = 0; i < 40 && this.cine; i++) this.updateCinematic(1 / 60);
    const r = await done;
    engine.events.off('camera:cut', onCut);
    out.cine = `${r && !r.cancelled ? 'resolved' : 'CANCELLED'} cuts=${cuts} end=${cam.position.x.toFixed(2)},${cam.position.y.toFixed(2)},${cam.position.z.toFixed(2)}`; // expect resolved cuts=3 end=6.00,1.50,7.00
    // shake: a jab (0.12, 0.12 s) landing 0.1 s into a finisher shake (0.8, 0.5 s) must not end it early,
    // and a 40 s preview shake must still be near full strength after 5 s
    const saved = { trauma: this.trauma, end: this.shakeEnd, now: this.now };
    const run = (secs) => { let t = 0; while (t < secs - 1e-6 && this.trauma > 0) { this.now += 1 / 60; t += 1 / 60; this.decayTrauma(1 / 60); } return t; };
    this.trauma = 0; this.shakeEnd = 0;
    this.shake(0.8, 0.5); run(0.1); this.shake(0.12, 0.12);
    out.finisherShakeS = +(0.1 + run(5)).toFixed(3);                            // expect ~0.50
    this.trauma = 0; this.shakeEnd = 0;
    this.shake(1, 40); run(5);
    out.previewTraumaAt5s = +this.trauma.toFixed(3);                             // expect ~0.87
    out.jabShakeAmp = +Math.max(0.12 * 0.12, 0.4 * 0.12).toFixed(3);            // 0.048 (was 0.0144)
    this.trauma = saved.trauma; this.shakeEnd = saved.end; this.now = saved.now;
    // broadphase agrees with the world on this frame's candidates
    out.broadphase = this._localBroken ? 'DISABLED' : 'ok';
    this.mode = savedMode; this.fixed = savedFixed; this.initialised = false; this._blend = null;
    return out;
  },
};

export default camera;
