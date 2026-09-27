// [combat] Hitboxes, the rush combo, hit-stop, damage, knockback, guard break, weapons, heat gauge rules (§7).
//   combat.register(entity)                entities take part in hit tests
//   combat.attack(entity, name) -> bool    plays the clip, spawns bone hitboxes from clip.userData.events 'hit'
//        the player's presses are typed (light / heavy / grab), not named: combat owns the rush string
//        jab → straight → hook → uppercut, and the heavy button closes it with a finisher that depends on how many
//        links came first (kick / fin_kick / fin_upper / fin_round). Presses buffer for 0.25 s; every link opens a
//        cancel window just after its contact frame, and a dodge cancels the recovery.
//   combat.isAttacking(e)  combat.isBusy(e)  combat.active[]  combat.ATTACKS  combat.metrics
//   combat.pickUp(e) / combat.throwWeapon(e) / combat.dropWeapon(e)   dynamic props tagged 'weapon'
//   combat.hitStop(ms)  combat.setSlowMo(speed, realSeconds?)  — the one owner of engine.time.speed in a fight
//   combat.finale  the fight's final blow in progress ({t: real s since contact, target, att, point, dir, heat}) or
//        null; its timing is FINAL_BLOW in finalBlow.js. combat.afterFinale(fn) runs fn once it is over (results).
//   combat.applyHit(att, target, def, name, attack?, opts?)  combat.vfx.impact/dust/shock/wallHit/metal/splash
//   combat.playClip(humanoid, clip, opts)  plays a clip that is not in animations' library (heat choreography)
//   events: combat:attack, combat:hit {attacker,target,damage,dir,point,heavy,name,guarded,combo},
//           combat:ko {target,attacker,finale}, combat:guardbreak {target,attacker}, combat:grab, combat:throw,
//           combat:weapon {entity,type,action}, heat:ready, prop:impact {point,strength,type},
//           combat:finale {phase:'start'|'land'|'end', target, attacker, point, dir, heat}
import * as THREE from 'three';
import { FINAL_BLOW, fbSpeed, fbEnd } from './finalBlow.js';

const BUFFER = 0.25;              // input buffer window (s)
const STRING_WINDOW = 0.5;        // the rush survives this long after a link has recovered
const COMBO_HOLD = 2.4;           // combo counter decay (s)
const GUARD_MAX = 100;            // guard meter before a break
const GUARD_REGEN = 26;           // per second
const HOLD_MAX = 2.3;             // grab hold before an automatic throw (s)
const DAMP = 6;                   // player.js / enemy.js bleed velocity by (1 - 6 dt): a push of d metres is v0 = 6 d
const STOP_SPEED = 0.05;          // engine.time.speed during a hit-stop
const ENEMY_RATE = 0.8;           // enemy strikes play slower than the player's: the wind-up is the tell

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3(), _q = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _col = new THREE.Color(), _sc = new THREE.Vector3(), _v = new THREE.Vector3();
const _q2 = new THREE.Quaternion(), _camQ = new THREE.Quaternion(), _camQi = new THREE.Quaternion();
const _xAxis = new THREE.Vector3(1, 0, 0), _zAxis = new THREE.Vector3(0, 0, 1), _up = new THREE.Vector3(0, 1, 0);
const _hTip = new THREE.Vector3(), _hRoot = new THREE.Vector3(), _hC0 = new THREE.Vector3(), _hC1 = new THREE.Vector3();
const _fq = new THREE.Quaternion();
// additive flinch weights: a head blow snaps the neck, a body blow folds the lumbar/thoracic spine
const FLINCH_HEAD = [['Spine1', 0.2], ['Spine2', 0.3], ['Neck', 0.5]];
const FLINCH_BODY = [['Spine', 0.35], ['Spine1', 0.4], ['Spine2', 0.25]];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const _hitRing = Array.from({ length: 48 }, () => new THREE.Vector3());
let _hitI = 0;
const hitVec = () => _hitRing[(_hitI = (_hitI + 1) % _hitRing.length)];

// ---------------------------------------------------------------------------------------------- attack table
// reach = total horizontal reach from the attacker's centre (the bone capsule is padded out to it so the design number
// survives whatever the clip does); radius comes from the clip's own hit event. `knock` is the legacy impulse scale
// audio.js reads for its sub-drop; `push` is the knockback in metres the target actually slides. `rate` = clip speed,
// `lunge` = how far the attacker may step in to close the gap, `stop` = hit-stop in ms (60–90, finishers more).
// `sweep` = [toward the attacker's left, up]: which way the fist/foot is travelling at contact (a hook crosses the
// face, an uppercut rises); it steers the victim's reaction side, the flinch and the burst.
export const ATTACKS = {
  jab:        { dmg: 6,  heavy: false, reach: 1.28, knock: 1.7, push: 0.30, heat: 5,  stop: 60, shake: [0.12, 0.12], fx: 0.80, guard: 18, rate: 1.25, lunge: 0.65 },
  straight:   { dmg: 9,  heavy: false, reach: 1.40, knock: 2.5, push: 0.46, heat: 6,  stop: 66, shake: [0.17, 0.15], fx: 0.95, guard: 22, rate: 1.2,  lunge: 0.6 },
  hook:       { dmg: 12, heavy: true,  reach: 1.36, knock: 3.3, push: 0.80, heat: 8,  stop: 76, shake: [0.27, 0.20], fx: 1.10, guard: 30, rate: 1.15, lunge: 0.5, sweep: [1.0, 0.1] },
  uppercut:   { dmg: 16, heavy: true,  reach: 1.26, knock: 3.8, push: 2.10, heat: 10, stop: 86, shake: [0.40, 0.30], fx: 1.35, guard: 44, rate: 1.1,  lunge: 0.5, knockdown: true, launch: true, sweep: [0, 1.0] },
  kick:       { dmg: 14, heavy: true,  reach: 1.66, knock: 4.2, push: 1.30, heat: 8,  stop: 80, shake: [0.32, 0.24], fx: 1.20, guard: 72, rate: 1.0,  lunge: 0.7, sweep: [1.0, 0.1], react: 'stumble' },
  roundhouse: { dmg: 22, heavy: true,  reach: 1.80, knock: 5.4, push: 3.00, heat: 14, stop: 90, shake: [0.50, 0.34], fx: 1.55, guard: 60, rate: 1.0,  lunge: 0.6, knockdown: true, multi: true, sweep: [1.0, 0] },
  // rush finishers: the heavy button closes a string; what it becomes depends on how many links came first
  fin_kick:   { dmg: 15, heavy: true,  reach: 1.66, knock: 4.4, push: 1.70, heat: 10, stop: 82, shake: [0.36, 0.26], fx: 1.30, guard: 90, rate: 1.05, lunge: 0.7, sweep: [1.0, 0.1], react: 'stumble', clip: 'kick' },
  fin_upper:  { dmg: 19, heavy: true,  reach: 1.30, knock: 4.8, push: 2.40, heat: 12, stop: 86, shake: [0.44, 0.30], fx: 1.45, guard: 90, rate: 1.05, lunge: 0.55, knockdown: true, launch: true, clip: 'uppercut', sweep: [0, 1.0] },
  fin_round:  { dmg: 24, heavy: true,  reach: 1.84, knock: 5.6, push: 3.40, heat: 15, stop: 90, shake: [0.55, 0.36], fx: 1.65, guard: 100, rate: 1.05, lunge: 0.6, knockdown: true, multi: true, clip: 'roundhouse', sweep: [1.0, 0] },
  grab:       { dmg: 2,  heavy: false, reach: 1.25, knock: 0.2, push: 0.0,  heat: 3,  stop: 40, shake: [0.05, 0.10], fx: 0.40, guard: 14, rate: 1.3,  lunge: 0.6, grab: true },
  knee:       { dmg: 11, heavy: true,  reach: 1.05, knock: 0.6, push: 0.0,  heat: 7,  stop: 70, shake: [0.24, 0.16], fx: 1.00, guard: 0, held: true },
  throw:      { dmg: 22, heavy: true,  reach: 1.55, knock: 7.4, push: 3.40, heat: 14, stop: 90, shake: [0.50, 0.36], fx: 1.60, guard: 0, knockdown: true, held: true },
  // weapon moveset — a prop in the right hand doubles the hit volume and the reach
  w_swing:    { dmg: 17, heavy: true,  reach: 2.10, knock: 4.6, push: 1.60, heat: 11, stop: 80, shake: [0.34, 0.26], fx: 1.45, guard: 66, rate: 1.0, lunge: 0.5, clip: 'hook', weapon: true, radius: 2.1, react: 'stumble', multi: true, sweep: [0.9, 0] },
  w_heavy:    { dmg: 27, heavy: true,  reach: 2.05, knock: 6.2, push: 3.00, heat: 16, stop: 90, shake: [0.52, 0.36], fx: 1.85, guard: 100, rate: 0.95, lunge: 0.5, clip: 'uppercut', weapon: true, radius: 2.3, knockdown: true, multi: true },
  w_throw:    { dmg: 22, heavy: true,  reach: 1.60, knock: 5.0, push: 2.60, heat: 14, stop: 70, shake: [0.28, 0.22], fx: 1.20, guard: 100, clip: 'throw', weapon: true, knockdown: true },
  // heat actions (heatActions.js drives the choreography; these are the numbers on the contact frames)
  heat_wall:  { dmg: 12, heavy: true,  reach: 1.0,  knock: 5.0, push: 0.0,  heat: 0,  stop: 80,  shake: [0.45, 0.30], fx: 1.6, guard: 999 },
  heat_finisher: { dmg: 45, heavy: true, reach: 1.9, knock: 7.4, push: 1.20, heat: 0, stop: 110, shake: [0.80, 0.50], fx: 2.2, guard: 999, knockdown: true },
};
// light presses walk this string; the heavy button closes it with FINISH[links thrown so far]
export const RUSH = ['jab', 'straight', 'hook', 'uppercut'];
export const FINISH = ['kick', 'fin_kick', 'fin_upper', 'fin_round'];
const HEAVY_BUTTON = new Set(['kick', 'roundhouse', 'w_heavy', 'fin_kick', 'fin_upper', 'fin_round']);
export const BLOCK_CHANCE = { chinpira: 0.16 };

// ---------------------------------------------------------------------------------------------- math
function capsuleSeg(entity, out0, out1) {
  const r = entity.radius || 0.35, h = entity.height || 1.8;
  out0.set(entity.position.x, entity.position.y + r, entity.position.z);
  out1.set(entity.position.x, entity.position.y + Math.max(r + 0.05, h - r), entity.position.z);
}
export function segSegDist2(p1, q1, p2, q2) {
  const d1 = _e.subVectors(q1, p1), d2 = _f.subVectors(q2, p2), r = _g.subVectors(p1, p2);
  const a = d1.dot(d1), e2 = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-8 && e2 <= 1e-8) return r.lengthSq();
  if (a <= 1e-8) { t = clamp(f / e2, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e2 <= 1e-8) { s = clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2), den = a * e2 - b * b;
      s = den !== 0 ? clamp((b * f - c * e2) / den, 0, 1) : 0;
      t = (b * s + f) / e2;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const cx = p1.x + d1.x * s - (p2.x + d2.x * t), cy = p1.y + d1.y * s - (p2.y + d2.y * t), cz = p1.z + d1.z * s - (p2.z + d2.z * t);
  return cx * cx + cy * cy + cz * cz;
}

// ---------------------------------------------------------------------------------------------- VFX
function canvasTex(size, draw, h = size) {
  const c = document.createElement('canvas'); c.width = size; c.height = h;
  draw(c.getContext('2d'), size, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}
// the white-hot core: a tight radial falloff with four short spikes (a hot spot, not a star filter)
function texFlash() {
  return canvasTex(192, (g, s) => {
    const h = s / 2, rg = g.createRadialGradient(h, h, 0, h, h, h);
    rg.addColorStop(0.00, 'rgba(255,255,255,1)'); rg.addColorStop(0.12, 'rgba(255,255,250,0.92)');
    rg.addColorStop(0.30, 'rgba(255,238,210,0.36)'); rg.addColorStop(0.55, 'rgba(255,210,160,0.07)');
    rg.addColorStop(1.00, 'rgba(255,180,110,0)');
    g.fillStyle = rg; g.fillRect(0, 0, s, s);
    g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 8; k++) {
      g.save(); g.translate(h, h); g.rotate(k * Math.PI / 4);
      const len = k % 2 ? 0.34 : 0.62, w = k % 2 ? 0.07 : 0.1;
      const lg = g.createLinearGradient(0, 0, h * len, 0);
      lg.addColorStop(0, 'rgba(255,255,255,0.8)'); lg.addColorStop(0.5, 'rgba(255,244,222,0.25)'); lg.addColorStop(1, 'rgba(255,210,150,0)');
      g.fillStyle = lg;
      g.beginPath(); g.moveTo(0, -h * w); g.lineTo(h * len, 0); g.lineTo(0, h * w); g.closePath(); g.fill();
      g.restore();
    }
  });
}
function texRing() {
  return canvasTex(256, (g, s) => {
    const h = s / 2, rg = g.createRadialGradient(h, h, 0, h, h, h);
    rg.addColorStop(0.00, 'rgba(255,255,255,0)'); rg.addColorStop(0.74, 'rgba(255,255,255,0)');
    rg.addColorStop(0.86, 'rgba(255,255,255,0.9)'); rg.addColorStop(0.92, 'rgba(255,236,206,0.25)');
    rg.addColorStop(1.00, 'rgba(255,210,160,0)');
    g.fillStyle = rg; g.fillRect(0, 0, s, s);
  });
}
// a thin line, bright in the middle, soft at both ends: short burst lines, aura licks and every spark
function texStreak() {
  return canvasTex(256, (g, s, H) => {
    const h = H / 2;
    for (let y = 0; y < H; y++) {
      const k = 1 - Math.abs(y + 0.5 - h) / h;
      const lg = g.createLinearGradient(0, 0, s, 0);
      const a = Math.pow(Math.max(0, k), 2.2);
      lg.addColorStop(0.00, 'rgba(255,255,255,0)'); lg.addColorStop(0.18, `rgba(255,250,236,${0.45 * a})`);
      lg.addColorStop(0.55, `rgba(255,255,255,${a})`); lg.addColorStop(0.85, `rgba(255,250,236,${0.6 * a})`);
      lg.addColorStop(1.00, 'rgba(255,255,255,0)');
      g.fillStyle = lg; g.fillRect(0, y, s, 1);
    }
  }, 32);
}
// hit shard: a thick wedge, wide at the base (u = 0), a hard point at the tip (u = 1); white-hot spine, warm rim
function texShard() {
  return canvasTex(128, (g, W, H) => {
    const layers = [[1.0, 0.14, '255,190,120'], [0.55, 0.42, '255,236,200'], [0.24, 1.0, '255,255,255']];
    for (const [w, a, rgb] of layers) {
      const lg = g.createLinearGradient(0, 0, W, 0);
      lg.addColorStop(0, `rgba(${rgb},0)`); lg.addColorStop(0.06, `rgba(${rgb},${a})`);
      lg.addColorStop(0.5, `rgba(${rgb},${a * 0.75})`); lg.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = lg;
      g.beginPath(); g.moveTo(0, H / 2 - (H / 2) * w); g.lineTo(W, H / 2); g.lineTo(0, H / 2 + (H / 2) * w); g.closePath(); g.fill();
    }
  }, 32);
}
// the wind-up glint: a hard four-point star with thin long spikes (the anime "ting" on a chambered fist)
function texStar() {
  return canvasTex(128, (g, s) => {
    const h = s / 2;
    g.globalCompositeOperation = 'lighter';
    const rg = g.createRadialGradient(h, h, 0, h, h, h * 0.22);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 8; k++) {
      g.save(); g.translate(h, h); g.rotate(k * Math.PI / 4);
      const len = k % 2 ? 0.42 : 0.98, w = k % 2 ? 0.035 : 0.05;
      const lg = g.createLinearGradient(0, 0, h * len, 0);
      lg.addColorStop(0, 'rgba(255,255,255,1)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = lg;
      g.beginPath(); g.moveTo(0, -h * w); g.lineTo(h * len, 0); g.lineTo(0, h * w); g.closePath(); g.fill();
      g.restore();
    }
  });
}
// heat licks: an 8-frame flipbook of one blue flame tongue. Born wide and low, it stretches, its tip curls over and
// it tears off as a thinning wisp; white-hot core, blue body, soft outer glow
const FLAME_FRAMES = 8;
function texFlame() {
  const W = 64, H = 128;
  // 1D/2D value noise (seeded, deterministic) for the licking edges
  const R = new Float32Array(512);
  let sd = 91;
  for (let i = 0; i < 512; i++) { sd = (sd * 16807) % 2147483647; R[i] = sd / 2147483647; }
  const n1 = (x) => { const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f); return R[i & 511] * (1 - s) + R[(i + 1) & 511] * s; };
  const n2 = (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const h = (a, b) => R[(a * 57 + b * 131) & 511];
    return (h(i, j) * (1 - sx) + h(i + 1, j) * sx) * (1 - sy) + (h(i, j + 1) * (1 - sx) + h(i + 1, j + 1) * sx) * sy;
  };
  return canvasTex(W * FLAME_FRAMES, (g) => {
    const img = g.createImageData(W * FLAME_FRAMES, H), px = img.data;
    for (let f = 0; f < FLAME_FRAMES; f++) {
      const u = f / (FLAME_FRAMES - 1), t = f * 0.37;
      const lift = 0.22 * u * u;                                  // late frames tear off the base and rise
      for (let y = 0; y < H; y++) {
        const v = 1 - y / H - lift;                               // 0 at the base, 1 at the top of the frame
        if (v < -0.05) continue;
        for (let x = 0; x < W; x++) {
          const xn = (x + 0.5) / W * 2 - 1;
          // the column licks sideways more the higher it goes, and curls over at the tip
          const vv = Math.max(0, v);
          const disp = (n1(vv * 3.2 - t * 4 + 7) - 0.5) * 1.1 * vv + Math.sin(u * 2.4 + vv * 2.2) * 0.18 * vv * vv;
          const xx = xn - disp;
          const width = Math.pow(Math.max(0, 1 - vv / (0.95 - 0.35 * u)), 0.65) * (0.62 - 0.22 * u);
          if (width <= 0) continue;
          const body = Math.max(0, 1 - Math.abs(xx) / width);
          const base = Math.min(1, (v + 0.05) / 0.12);
          const tongue = n2(xx * 3.0 + 11, vv * 5 - t * 7) * 0.55 + n2(xx * 6.0, vv * 11 - t * 11) * 0.25;
          let heat = body * base * (1.05 - vv * 0.85) + (tongue - 0.4) * body * 0.9;
          heat = Math.max(0, Math.min(1, heat * (1 - 0.5 * u)));
          if (heat <= 0.01) continue;
          const core = Math.max(0, Math.min(1, (heat - 0.55) / 0.35));
          const k = ((y * W * FLAME_FRAMES) + f * W + x) * 4;
          px[k] = 90 + 165 * core; px[k + 1] = 150 + 105 * core; px[k + 2] = 255; px[k + 3] = Math.round(255 * Math.pow(heat, 1.3));
        }
      }
    }
    g.putImageData(img, 0, 0);
  }, H);
}
function texSmoke() {
  return canvasTex(128, (g, s) => {
    const h = s / 2;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 30; i++) {
      const a = rnd() * 6.283, r = rnd() * h * 0.42, rr = h * (0.22 + rnd() * 0.26);
      const x = h + Math.cos(a) * r, y = h + Math.sin(a) * r;
      const rg = g.createRadialGradient(x, y, 0, x, y, rr);
      rg.addColorStop(0, 'rgba(255,255,255,0.20)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(x, y, rr, 0, 6.283); g.fill();
    }
    const vg = g.createRadialGradient(h, h, h * 0.55, h, h, h);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = vg; g.fillRect(0, 0, s, s);
  });
}

function makePool(tex, count, opts = {}) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: 1, toneMapped: true, ...opts,
  });
  return instanced(geo, mat, count);
}
function instanced(geo, mat, count) {
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, _col.setRGB(0, 0, 0));
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  mesh.count = 0;
  mesh.castShadow = false; mesh.receiveShadow = false;
  return mesh;
}
// debris: tiny faceted chips that catch the key light and the neon (paint flakes, plaster, spoke ends)
function makeChipPool(count) {
  const geo = new THREE.TetrahedronGeometry(1, 0);
  geo.scale(1, 0.45, 0.8);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.4, flatShading: true });
  const mesh = instanced(geo, mat, count);
  mesh.renderOrder = 0;
  return mesh;
}
/** upload only what is live, and nothing at all while nothing is (or was) live */
function upload(mesh, n) {
  const prev = mesh.count;
  mesh.count = n;
  if (!n) return prev > 0;
  const m = mesh.instanceMatrix, c = mesh.instanceColor;
  m.clearUpdateRanges(); m.addUpdateRange(0, n * 16); m.needsUpdate = true;
  if (c) { c.clearUpdateRanges(); c.addUpdateRange(0, n * 3); c.needsUpdate = true; }
  return true;
}
/** fixed pool of preallocated records: add() hands out a free record (or null when full), kill(i) swap-removes */
function slots(n, make) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = make();
  return {
    a, n: 0,
    add() { return this.n < a.length ? a[this.n++] : null; },
    kill(i) { const last = --this.n, r = a[i]; a[i] = a[last]; a[last] = r; },
  };
}
/** the flame pool picks its flipbook frame per instance (aFrame), everything else is a stock additive quad */
function makeFlamePool(count) {
  const mesh = makePool(texFlame(), count);
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  mesh.geometry.setAttribute('aFrame', attr);
  mesh.material.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute float aFrame;\n' + sh.vertexShader.replace('#include <uv_vertex>',
      `#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv.x = (vMapUv.x + aFrame) / ${FLAME_FRAMES}.0;\n#endif`);
  };
  mesh.material.customProgramCacheKey = () => 'combat-flame-flipbook';
  return mesh;
}
const QUAD_KEYS = ['flash', 'ring', 'streak', 'shard', 'smoke', 'flame', 'star'];
// flame tongues rise off the back, shoulders and arms; never off the face (they would veil it in every close-up)
const AURA_BONES = ['Hips', 'Spine1', 'Spine1', 'Spine2', 'Spine2', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg'];
// the striking bone's parent: the tip of a fist is the hand pushed out along the forearm
const TIP_PARENT = { RightHand: 'RightForeArm', LeftHand: 'LeftForeArm', RightFoot: 'RightLeg', LeftFoot: 'LeftLeg', RightLeg: 'RightUpLeg', LeftLeg: 'LeftUpLeg' };
const _tipB = new THREE.Vector3();
function limbTip(h, bone, parent, ext, out) {
  h.boneWorld(bone, out);
  if (!parent || !ext) return out;
  h.boneWorld(parent, _tipB);
  _tipB.subVectors(out, _tipB);
  const l = _tipB.length();
  return l > 1e-4 ? out.addScaledVector(_tipB, ext / l) : out;
}

function createVfx(engine) {
  const group = new THREE.Group(); group.name = 'combat-vfx';
  group.matrixAutoUpdate = false;
  engine.scene.add(group);

  const streakTex = texStreak();
  const pools = {
    flash: makePool(texFlash(), 48),
    ring: makePool(texRing(), 40),
    streak: makePool(streakTex, 128),
    shard: makePool(texShard(), 48),
    smoke: makePool(texSmoke(), 64, { blending: THREE.NormalBlending, opacity: 0.8 }),
    flame: makeFlamePool(96),
    star: makePool(texStar(), 16),
  };
  const SPARKS = 480, CHIPS = 64;
  const spark = makePool(streakTex, SPARKS);
  spark.renderOrder = 21;
  const chip = makeChipPool(CHIPS);
  // grey smoke is normal-blended: it must never feed the bloom (and every pool on the layer draws twice)
  for (const k of QUAD_KEYS) { if (k !== 'smoke') pools[k].layers.enable(engine.layers.BLOOM); group.add(pools[k]); }
  spark.layers.enable(engine.layers.BLOOM); group.add(spark);
  group.add(chip);
  const flameFrame = pools.flame.geometry.attributes.aFrame;

  const V3 = () => new THREE.Vector3();
  // lift / dir are resolved against the CURRENT lens every frame in write(): a burst spawned before a cut (or before
  // the camera rig takes over a still) still sits toward the lens and fans along the blow as the new lens sees it
  const Q = slots(320, () => ({ kind: 'flash', pos: V3(), vel: V3(), nrm: V3(), hasN: false, grav: 0, drag: 0, life: 0, t: 0, s0: 0, s1: 0,
    roll: 0, spin: 0, r: 0, g: 0, b: 0, aspect: 1, pow: 1, out: 0, fh: null, fb: null, fp: null, fx: 0, aura: false,
    lift: 0, dir: V3(), hasDir: false, rollOff: 0, rt: false }));
  const P = slots(SPARKS, () => ({ p: V3(), v: V3(), t: 0, life: 0, r: 0, g: 0, b: 0, len: 0, w: 0, grav: 0, bounce: 0, drag: 0, hot: 0, gy: 0, minLen: 0 }));
  const C = slots(CHIPS, () => ({ p: V3(), v: V3(), t: 0, life: 0, s: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0, r: 0, g: 0, b: 0, gy: 0 }));
  const counts = {};
  for (const k of QUAD_KEYS) counts[k] = 0;
  const _eul = new THREE.Euler(), _camM = new Float32Array(16);
  let dirty = true;
  const ground = (x, z) => (engine.world ? engine.world.groundHeight(x, z) : 0);

  const vfx = {
    group, pools, spark, chip, enabled: true, streakK: 1,
    get nQuads() { return Q.n; }, get nSparks() { return P.n; }, get nChips() { return C.n; },

    /** o: {vel | vx,vy,vz, grav, drag, life, s0, s1, roll, spin, r,g,b, normal | flat, aspect, pow, out,
     *       follow:[humanoid, bone, parentBone?, ext?], aura, lift (m toward the lens), dir + rollOff (roll along the
     *       world direction as the lens sees it; `roll` is the fallback when it is end-on)} */
    quad(kind, x, y, z, o = {}) {
      const q = Q.add(); if (!q) return null;
      dirty = true;
      q.kind = kind; q.pos.set(x, y, z);
      if (o.vel) q.vel.copy(o.vel); else q.vel.set(o.vx || 0, o.vy || 0, o.vz || 0);
      q.grav = o.grav || 0; q.drag = o.drag != null ? o.drag : 2.2;
      q.life = o.life || 0.2; q.t = 0; q.s0 = o.s0 != null ? o.s0 : 0.4; q.s1 = o.s1 != null ? o.s1 : 1.6;
      q.roll = o.roll != null ? o.roll : Math.random() * 6.283; q.spin = o.spin || 0;
      q.r = o.r != null ? o.r : 2.0; q.g = o.g != null ? o.g : 1.8; q.b = o.b != null ? o.b : 1.5;
      q.hasN = !!(o.normal || o.flat); if (q.hasN) q.nrm.copy(o.normal || _up);
      q.aspect = o.aspect || 1; q.pow = o.pow || 1; q.out = o.out || 0;
      q.fh = o.follow ? o.follow[0] : null; q.fb = o.follow ? o.follow[1] : null;
      q.fp = o.follow && o.follow[2] ? o.follow[2] : null; q.fx = o.follow && o.follow[3] ? o.follow[3] : 0;
      q.aura = !!o.aura;
      q.lift = o.lift || 0;
      q.hasDir = !!o.dir; if (q.hasDir) q.dir.copy(o.dir); q.rollOff = o.rollOff || 0;
      q.rt = !!o.rt;
      return q;
    },

    /** o: {dir, bias, spread, up, life, r,g,b, len, w, grav, bounce, drag, hot, minLen} — spawned already in flight
     *  (offset along their velocity) so a burst opens as a star of lines on its first frame, not a blob */
    spark(x, y, z, n, o = {}) {
      const spread = o.spread || 5.5, up = o.up != null ? o.up : 0.45, dir = o.dir, hot = o.hot != null ? o.hot : 1;
      const gy = o.bounce ? ground(x, z) + 0.01 : 0;
      dirty = true;
      for (let i = 0; i < n; i++) {
        const p = P.add(); if (!p) return;
        const a = Math.random() * 6.283, c = Math.random() * 2 - 1, sq = Math.sqrt(1 - c * c);
        const v = p.v.set(sq * Math.cos(a), c * 0.7 + up, sq * Math.sin(a));
        if (dir) v.addScaledVector(dir, (o.bias != null ? o.bias : 1.0) * (0.9 + Math.random() * 1.1));
        v.multiplyScalar(spread * (0.35 + Math.random() * 0.9));
        p.p.set(x + (Math.random() - 0.5) * 0.06, y + (Math.random() - 0.5) * 0.06, z + (Math.random() - 0.5) * 0.06).addScaledVector(v, 0.03);
        p.t = 0; p.life = (o.life || 0.42) * (0.55 + Math.random() * 0.8);
        p.r = o.r != null ? o.r : 3.2; p.g = o.g != null ? o.g : 2.3 + Math.random() * 0.6; p.b = o.b != null ? o.b : 1.1 + Math.random() * 0.6;
        p.len = o.len != null ? o.len : 0.016; p.w = o.w != null ? o.w : 0.011; p.grav = o.grav != null ? o.grav : 14;
        p.bounce = o.bounce || 0; p.drag = o.drag != null ? o.drag : 2.2; p.hot = hot; p.gy = gy;
        p.minLen = o.minLen != null ? o.minLen : (hot ? 0.08 : 0.02);
      }
    },

    debris(x, y, z, n, o = {}) {
      const gy = ground(x, z);
      dirty = true;
      for (let i = 0; i < n; i++) {
        const c = C.add(); if (!c) return;
        c.v.set((Math.random() - 0.5) * 2, Math.random() * 1.2 + 0.4, (Math.random() - 0.5) * 2);
        if (o.dir) c.v.addScaledVector(o.dir, 1.6 + Math.random() * 1.6);
        c.v.multiplyScalar(o.speed || 2.6);
        c.p.set(x, y, z); c.t = 0; c.life = 1.4 + Math.random() * 0.8;
        c.s = (o.size || 0.03) * (0.6 + Math.random() * 0.9);
        c.rx = Math.random() * 6; c.ry = Math.random() * 6; c.rz = Math.random() * 6;
        c.sx = Math.random() * 16 - 8; c.sy = Math.random() * 16 - 8; c.sz = Math.random() * 16 - 8;
        const tone = 0.55 + Math.random() * 0.45;
        c.r = tone * (o.r || 0.62); c.g = tone * (o.g || 0.60); c.b = tone * (o.b || 0.58); c.gy = gy;
      }
    },

    /** a fist landing. Blood-free. The white-hot core sits on the EXIT side of the contact (point + blow·0.08), is
     *  small (22 cm on a heavy) and gone in 40 ms, so it pops and clears instead of sitting on the jaw. The wedge
     *  shards start 14 cm off the core and fan out past the far side of the head along the blow AS THE LENS SEES IT;
     *  lift and fan are resolved against the current camera every frame (write()), so a cut or a camera rig taking
     *  over mid-burst cannot point them back at the attacker. Legacy call: impact(point, scale). */
    impact(point, dir, opt = {}) {
      if (typeof dir === 'number') { opt = { scale: dir, heavy: dir > 1.1 }; dir = null; }
      const s = opt.scale || 1, heavy = !!opt.heavy;
      const lift = opt.lift != null ? opt.lift : 0.1;
      const ex = dir ? (opt.exit != null ? opt.exit : 0.08) : 0;
      const x = point.x + (dir ? dir.x * ex : 0), y = point.y + (dir ? dir.y * ex : 0), z = point.z + (dir ? dir.z * ex : 0);
      const g = opt.guard ? { r: 1.0, g: 1.6, b: 2.4 } : { r: 2.1, g: 1.95, b: 1.7 };
      vfx.quad('flash', x, y, z, { life: heavy ? 0.04 : 0.035, s0: 0.1 * s, s1: (heavy ? 0.22 : 0.18) * s, r: g.r * 1.7, g: g.g * 1.7, b: g.b * 1.7, pow: 1.4, lift, rt: true });
      vfx.quad('flash', x, y, z, { life: 0.03, s0: 0.05 * s, s1: 0.12 * s, r: g.r * 2.2, g: g.g * 2.2, b: g.b * 2.2, roll: 0.39, pow: 1.3, lift, rt: true });
      vfx.quad('ring', x, y, z, { life: heavy ? 0.14 : 0.1, s0: 0.12 * s, s1: (heavy ? 0.7 : 0.5) * s, r: g.r * 0.1, g: g.g * 0.1, b: g.b * 0.1, pow: 2.4, lift, rt: true });
      // short, thick radial burst lines round the contact (capped at 26 cm), their bases pushed off the core
      const lines = heavy ? 6 : 5;
      for (let i = 0; i < lines; i++) {
        const roll = (i / lines) * 6.283 + Math.random() * 0.7;
        const len = Math.min(0.26, (heavy ? 0.22 : 0.17) * s * (0.75 + Math.random() * 0.4));
        vfx.quad('streak', x, y, z, { life: 0.05, s0: len * 0.5, s1: len, aspect: 0.12, roll, out: 0.08 + len * 0.45,
          r: g.r * 0.9, g: g.g * 0.9, b: g.b * 0.9, pow: 1.3, drag: 0, lift, rt: true });
      }
      // hit shards: thick wedges on the far side, fanned ±0.45 rad round the blow (a crown over the head when the
      // blow runs straight away from the lens)
      const nS = heavy ? 4 : 3, base = Math.random() * 6.283;
      for (let i = 0; i < nS; i++) {
        const j = i - (nS - 1) / 2, jit = (Math.random() - 0.5) * 0.25;
        const len = Math.min(0.3, (heavy ? 0.26 : 0.2) * s * (0.8 + Math.random() * 0.35) * (i === (nS >> 1) ? 1.15 : 1));
        vfx.quad('shard', x, y, z, { life: heavy ? 0.1 : 0.075, s0: len * 0.45, s1: len, aspect: 0.2, roll: Math.PI / 2 + j * 0.9 + jit, out: 0.12 + len * 0.3,
          r: g.r * 0.8, g: g.g * 0.82, b: g.b * 0.85, pow: 1.4, drag: 0, lift: lift + 0.04, dir, rollOff: j * 0.45 + jit, rt: true });
      }
      if (dir && heavy) {
        vfx.quad('streak', x, y, z, { life: 0.08, s0: 0.3 * s, s1: 0.75 * s, aspect: 0.06, roll: base, out: 0.24 * s, r: g.r * 0.5, g: g.g * 0.5, b: g.b * 0.5,
          pow: 2.2, drag: 0, lift, dir, rollOff: 0, rt: true });
      }
      vfx.spark(x, y, z, Math.round((heavy ? 22 : 10) * s), { dir, spread: heavy ? 6.5 : 4.4, life: heavy ? 0.36 : 0.26, len: 0.018, w: heavy ? 0.013 : 0.01,
        minLen: 0.05, ...(opt.guard ? { r: 1.2, g: 2.0, b: 3.0 } : {}) });
      if (heavy && !opt.guard) {
        // sweat / rain water flung off the target along the blow
        vfx.spark(x, y, z, Math.round(10 * s), { dir, bias: 1.6, spread: 3.4, up: 0.25, life: 0.5, r: 0.8, g: 0.9, b: 1.05, len: 0.012, w: 0.012, grav: 9.8, hot: 0 });
      }
    },

    /** a body hits the ground: on the wet night street that is a splash + mist, dry it is a dust puff */
    dust(point, scale = 1) {
      const y = point.y, wet = engine.time ? (engine.time.wet || 0) : 0;
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * 6.283, r = Math.random() * 0.5 * scale;
        vfx.quad('smoke', point.x + Math.cos(a) * r, y + 0.12 + Math.random() * 0.2, point.z + Math.sin(a) * r, {
          life: 0.8 + Math.random() * 0.4, s0: 0.28 * scale, s1: (1.1 + Math.random() * 0.5) * scale,
          r: 0.34 - 0.06 * wet, g: 0.34 - 0.05 * wet, b: 0.34, spin: (Math.random() - 0.5) * 1.6, drag: 1.4,
          vx: Math.cos(a) * 1.5 * scale, vy: 0.5, vz: Math.sin(a) * 1.5 * scale,
        });
      }
      vfx.quad('ring', point.x, y + 0.03, point.z, { life: 0.45, s0: 0.4 * scale, s1: 2.6 * scale, flat: true, r: 0.7, g: 0.72, b: 0.78, pow: 1.8 });
      if (wet > 0.3) vfx.splash(point, scale);
      else vfx.spark(point.x, y + 0.1, point.z, 10, { spread: 2.2, up: 0.9, life: 0.4, r: 1.1, g: 0.95, b: 0.75, hot: 0 });
    },

    /** puddle water thrown up by a body or a bicycle: a crown of droplets and two flat ripples */
    splash(point, scale = 1) {
      const y = point.y;
      vfx.spark(point.x, y + 0.05, point.z, Math.round(26 * scale), { spread: 2.6 * scale, up: 1.4, life: 0.55, r: 0.7, g: 0.8, b: 1.0, len: 0.012, w: 0.012, grav: 9.8, hot: 0, drag: 0.8 });
      vfx.quad('ring', point.x, y + 0.02, point.z, { life: 0.7, s0: 0.3 * scale, s1: 1.8 * scale, flat: true, r: 0.45, g: 0.55, b: 0.7, pow: 1.3 });
      vfx.quad('ring', point.x, y + 0.02, point.z, { life: 1.0, s0: 0.2 * scale, s1: 3.2 * scale, flat: true, r: 0.25, g: 0.32, b: 0.42, pow: 1.2 });
    },

    /** ground shockwave for finishers */
    shock(point, scale = 1) {
      vfx.quad('ring', point.x, point.y + 0.04, point.z, { life: 0.5, s0: 0.5 * scale, s1: 5.0 * scale, flat: true, r: 1.5, g: 1.3, b: 1.0, pow: 1.5 });
      vfx.quad('flash', point.x, point.y + 0.9, point.z, { life: 0.16, s0: 0.3 * scale, s1: 1.1 * scale, r: 1.8, g: 1.6, b: 1.4, pow: 2.0 });
      vfx.spark(point.x, point.y + 0.4, point.z, 40, { spread: 7, up: 0.7, life: 0.6 });
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * 6.283;
        vfx.quad('smoke', point.x + Math.cos(a) * 0.7, point.y + 0.3, point.z + Math.sin(a) * 0.7, {
          life: 1.0, s0: 0.4 * scale, s1: 1.8 * scale, r: 0.38, g: 0.37, b: 0.38, spin: (Math.random() - 0.5) * 1.6,
          vx: Math.cos(a) * 3.4, vy: 0.8, vz: Math.sin(a) * 3.4, drag: 1.6,
        });
      }
    },

    /** a head meets a wall: flash on the surface, a ring flat on the wall plane, plaster chips and dust off the face */
    wallHit(point, normal, scale = 1) {
      const n = _e.copy(normal).setY(0).normalize(), nx = n.x, nz = n.z;
      vfx.impact(point, n, { scale: 1.2 * scale, heavy: true });
      vfx.quad('ring', point.x + nx * 0.02, point.y, point.z + nz * 0.02, { life: 0.34, s0: 0.2 * scale, s1: 1.9 * scale, normal: n, r: 1.3, g: 1.2, b: 1.0, pow: 1.6 });
      vfx.quad('flash', point.x + nx * 0.03, point.y, point.z + nz * 0.03, { life: 0.14, s0: 0.3 * scale, s1: 1.1 * scale, normal: n, r: 1.9, g: 1.8, b: 1.6, pow: 2.0 });
      vfx.debris(point.x + nx * 0.08, point.y, point.z + nz * 0.08, Math.round(16 * scale), { dir: n, speed: 2.4, r: 0.8, g: 0.78, b: 0.74 });
      for (let i = 0; i < 6; i++) {
        vfx.quad('smoke', point.x + nx * 0.15, point.y + (Math.random() - 0.5) * 0.4, point.z + nz * 0.15, {
          life: 1.1, s0: 0.25 * scale, s1: (1.0 + Math.random() * 0.6) * scale, r: 0.42, g: 0.41, b: 0.40, spin: (Math.random() - 0.5) * 1.2, drag: 1.8,
          vx: nx * 1.6 + (Math.random() - 0.5), vy: 0.2 + Math.random() * 0.4, vz: nz * 1.6 + (Math.random() - 0.5), grav: -0.3,
        });
      }
    },

    /** steel on bone: a fountain of long white-hot sparks that cool to orange and bounce, plus paint flakes */
    metal(point, dir, scale = 1) {
      vfx.impact(point, dir, { scale: 0.9 * scale, heavy: true, lift: 0.05 });
      vfx.spark(point.x, point.y, point.z, Math.round(46 * scale), { dir, bias: 0.5, spread: 7.5, up: 0.9, life: 0.9, r: 3.2, g: 1.9, b: 0.7,
        len: 0.03, w: 0.009, grav: 11, bounce: 0.35, drag: 1.0, minLen: 0.08 });
      vfx.debris(point.x, point.y, point.z, Math.round(10 * scale), { dir, speed: 3.2, size: 0.022, r: 0.85, g: 0.86, b: 0.9 });
    },

    /** an enemy's strike is about to land, ~0.25 s ahead: a red glint riding the TIP of the chambered fist/foot
     *  (the bone pushed 8 cm out along its limb), a 2-frame white star "ting", and a small contracting ring */
    telegraph(h, bone) {
      const parent = TIP_PARENT[bone] || null;
      const p = limbTip(h, bone, parent, 0.08, _v);
      const follow = [h, bone, parent, 0.08];
      vfx.quad('flash', p.x, p.y, p.z, { life: 0.26, s0: 0.06, s1: 0.3, r: 3.0, g: 0.5, b: 0.35, pow: 1.1, follow, lift: 0.06, rt: true });
      vfx.quad('star', p.x, p.y, p.z, { life: 0.034, s0: 0.34, s1: 0.4, r: 3.4, g: 3.3, b: 3.2, roll: 0.2, pow: 0.6, follow, lift: 0.08, rt: true });
      vfx.quad('ring', p.x, p.y, p.z, { life: 0.24, s0: 0.25, s1: 0.06, r: 1.3, g: 0.28, b: 0.2, pow: 0.9, follow, lift: 0.06, rt: true });
    },

    /** one rising heat lick beside a bone: a camera-facing flame tongue from the flipbook, kept upright on screen */
    lick(h, k) {
      const bone = AURA_BONES[(Math.random() * AURA_BONES.length) | 0];
      const p = h.boneWorld(bone, _v);
      // licks rise off his SILHOUETTE as this lens sees it: pushed out to the left/right edge of the limb in screen
      // space and a little behind him, so the body hides their roots and only the tongues show round the outline
      const me = engine.camera.matrixWorld.elements;
      const half = /Spine|Hips/.test(bone) ? 0.17 : 0.08, side = Math.random() < 0.5 ? -1 : 1;
      const o = side * (half + 0.02 + Math.random() * 0.06);
      p.x += me[0] * o - me[8] * 0.12; p.y += me[1] * o - me[9] * 0.12 + (Math.random() - 0.4) * 0.16; p.z += me[2] * o - me[10] * 0.12;
      const w = (0.11 + Math.random() * 0.06) * (0.8 + 0.25 * k);
      vfx.quad('flame', p.x, p.y, p.z, {
        life: 0.42 + Math.random() * 0.22, s0: w * 0.8, s1: w * 1.15, aspect: 2.0, roll: 0, dir: _up, rollOff: -Math.PI / 2 + (Math.random() - 0.5) * 0.35,
        vy: 0.7 + Math.random() * 0.6, drag: 0.6, r: 0.75 * k, g: 0.85 * k, b: 1.2 * k, pow: 0.8, aura: true });
    },

    clear() { Q.n = 0; P.n = 0; C.n = 0; dirty = true; },

    /** advance the simulation without a frame (staged screenshots) */
    advance(seconds, steps = 6) { const h = seconds / steps; for (let i = 0; i < steps; i++) vfx.step(h); },

    /** dt: game time for quads; pdt: sparks and chips (combat runs them at real x 0.25 through a hit-stop, so the
     *  fountain opens while the bodies are frozen); rdt: real time, for the lens events of a hit (core flash, burst
     *  lines, shards, glint) which play out DURING the freeze instead of sitting on a face for the whole slow-mo;
     *  auraOnly: frozen stills still animate the aura licks */
    step(dt, pdt = dt, auraOnly = false, rdt = dt) {
      if (!Q.n && !P.n && !C.n) return;
      dirty = true;
      for (let i = Q.n - 1; i >= 0; i--) {
        const q = Q.a[i];
        if (auraOnly && !q.aura) continue;
        q.t += q.rt ? rdt : dt;
        if (q.t >= q.life) { Q.kill(i); continue; }
        if (q.fh) { limbTip(q.fh, q.fb, q.fp, q.fx, q.pos); continue; }
        q.pos.addScaledVector(q.vel, dt);
        q.vel.y += q.grav * dt;
        q.vel.multiplyScalar(Math.max(0, 1 - q.drag * dt));
        q.roll += q.spin * dt;
      }
      if (auraOnly) return;
      for (let i = P.n - 1; i >= 0; i--) {
        const p = P.a[i];
        p.t += pdt;
        if (p.t >= p.life) { P.kill(i); continue; }
        p.p.addScaledVector(p.v, pdt);
        p.v.y -= p.grav * pdt;
        p.v.multiplyScalar(Math.max(0, 1 - p.drag * pdt));
        if (p.bounce && p.p.y < p.gy && p.v.y < 0) { p.p.y = p.gy; p.v.y = -p.v.y * p.bounce; p.v.x *= 0.7; p.v.z *= 0.7; }
      }
      for (let i = C.n - 1; i >= 0; i--) {
        const c = C.a[i];
        c.t += pdt;
        if (c.t >= c.life) { C.kill(i); continue; }
        c.p.addScaledVector(c.v, pdt);
        c.v.y -= 9.8 * pdt;
        const gy = c.gy + c.s * 0.3;
        if (c.p.y < gy) { c.p.y = gy; if (c.v.y < 0) c.v.y = -c.v.y * 0.25; c.v.x *= 0.6; c.v.z *= 0.6; c.sx *= 0.6; c.sy *= 0.6; c.sz *= 0.6; }
        c.rx += c.sx * pdt; c.ry += c.sy * pdt; c.rz += c.sz * pdt;
      }
    },

    write() {
      const cam = engine.camera, me = cam.matrixWorld.elements;
      let moved = false;
      for (let i = 0; i < 16; i++) if (_camM[i] !== me[i]) { moved = true; _camM[i] = me[i]; }
      if (!dirty && !(moved && (Q.n || P.n))) return;
      dirty = false;
      cam.getWorldQuaternion(_camQ);
      _camQi.copy(_camQ).invert();
      _c.set(1, 0, 0).applyQuaternion(_camQ);          // camera right, world
      _d.set(0, 1, 0).applyQuaternion(_camQ);          // camera up, world
      const cx = me[12], cy = me[13], cz = me[14];
      const fr = flameFrame.array;
      for (const k of QUAD_KEYS) counts[k] = 0;
      for (let j = 0; j < Q.n; j++) {
        const q = Q.a[j];
        const pool = pools[q.kind]; if (!pool) continue;
        const i = counts[q.kind];
        if (i >= pool.instanceMatrix.count) continue;
        const k = q.t / q.life, fade = Math.pow(Math.max(0, 1 - k), q.pow);
        const s = q.s0 + (q.s1 - q.s0) * (1 - Math.pow(1 - k, 2));
        let roll = q.roll;
        if (q.hasDir && !q.hasN) {                     // the world direction as this lens sees it
          _e.copy(q.dir).applyQuaternion(_camQi);
          if (_e.x * _e.x + _e.y * _e.y > 0.05) roll = Math.atan2(_e.y, _e.x) + q.rollOff;
        }
        if (q.hasN) _q.setFromUnitVectors(_zAxis, q.nrm);
        else _q.copy(_camQ);
        if (roll) _q.multiply(_q2.setFromAxisAngle(_zAxis, roll));
        _sc.set(s, s * (q.aspect || 1), s);
        _a.copy(q.pos);
        if (q.lift) {                                  // toward the lens, so the burst reads ON the surface
          _b.set(cx - _a.x, cy - _a.y, cz - _a.z);
          const dl = _b.length();
          if (dl > 0.4) _a.addScaledVector(_b, q.lift / dl);
        }
        if (q.out) {                                   // burst line / shard: its base slides out along its own axis
          const o = q.out * (1 - Math.pow(1 - k, 3)) + s * 0.5;
          const cr = Math.cos(roll), sr = Math.sin(roll);
          _a.addScaledVector(_c, cr * o).addScaledVector(_d, sr * o);
        } else if (q.kind === 'flame') {               // a flame grows up from its base, not out from its middle
          const o = s * (q.aspect || 1) * 0.4;
          _a.addScaledVector(_c, -Math.sin(roll) * o).addScaledVector(_d, Math.cos(roll) * o);
        }
        _m.compose(_a, _q, _sc);
        pool.setMatrixAt(i, _m);
        pool.setColorAt(i, _col.setRGB(q.r * fade, q.g * fade, q.b * fade));
        if (q.kind === 'flame') fr[i] = Math.min(FLAME_FRAMES - 1, Math.floor(k * FLAME_FRAMES));
        counts[q.kind] = i + 1;
      }
      for (const k of QUAD_KEYS) upload(pools[k], counts[k]);
      if (counts.flame) { flameFrame.clearUpdateRanges(); flameFrame.addUpdateRange(0, counts.flame); flameFrame.needsUpdate = true; }
      // sparks: quads in the camera plane stretched along the projected velocity; white-hot for the first 40 ms,
      // then orange → red as they cool
      let n = 0;
      for (let j = 0; j < P.n; j++) {
        const p = P.a[j];
        const k = p.t / p.life, f = Math.pow(1 - k, 1.4);
        _v.copy(p.v).applyQuaternion(_camQi);
        const sp = Math.hypot(_v.x, _v.y);
        // a streak is a spark's motion blur, so slow motion shortens it (streakK): the final blow's sparks hang in the air
        const K = vfx.streakK;
        const len = clamp(sp * p.len * K, Math.max(p.w * 1.8, p.minLen * Math.min(1, 0.35 + sp * 0.2) * Math.max(0.45, K)), 0.3 * Math.max(0.4, K));
        _q.copy(_camQ).multiply(_q2.setFromAxisAngle(_zAxis, Math.atan2(_v.y, _v.x)));
        _sc.set(len, p.w, 1);
        _a.copy(p.v).normalize().multiplyScalar(-len * 0.35).add(p.p);
        _m.compose(_a, _q, _sc);
        spark.setMatrixAt(n, _m);
        const cool = p.hot ? Math.pow(k, 0.8) : 0, white = p.hot ? clamp(1 - p.t / 0.04, 0, 1) : 0;
        const r = p.r * f, g = p.g * f * (1 - 0.55 * cool), b = p.b * f * (1 - 0.85 * cool);
        spark.setColorAt(n, _col.setRGB(r + (3.5 - r) * white, g + (3.3 - g) * white, b + (3.0 - b) * white));
        n++;
      }
      upload(spark, n);
      let m = 0;
      for (let j = 0; j < C.n; j++) {
        const c = C.a[j];
        const fade = c.t > c.life - 0.3 ? (c.life - c.t) / 0.3 : 1;
        _q.setFromEuler(_eul.set(c.rx, c.ry, c.rz));
        _sc.setScalar(c.s * Math.max(0.05, fade));
        _m.compose(c.p, _q, _sc);
        chip.setMatrixAt(m, _m);
        chip.setColorAt(m, _col.setRGB(c.r, c.g, c.b));
        m++;
      }
      upload(chip, m);
    },

    update(dt, frozen, pdt = dt, rdt = dt) {
      if (!frozen) vfx.step(dt, pdt, false, rdt);
      else vfx.step(rdt, rdt, true, rdt);
      vfx.write();
    },
  };
  return vfx;
}

// ---------------------------------------------------------------------------------------------- heat aura
// 龍が如く tells the player the gauge is charged on the character himself: a halo shell (a second skinned draw of
// his LOD1 body sharing the skeleton, pushed 3-5 cm out, BACK faces only, additive, on the BLOOM layer) plus rising
// flame tongues from the flipbook pool. Back faces are what makes it a halo: the shell's own inner creases (ear,
// jaw, collar, trouser seams) sit behind the body's depth and can never light up, only the band OUTSIDE the
// silhouette does, hottest against the suit and gone at the shell's outer edge. A world-space noise that scrolls
// upward breaks the band into tongues; it fades out below the knees. The same shader in red is an enemy's
// unblockable-wind-up rim.
const AURA_VERT = /* glsl */`
#include <common>
#include <skinning_pars_vertex>
uniform float uPush;
varying vec3 vN; varying vec3 vV; varying vec3 vW;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  transformed += normalize(objectNormal) * uPush;
  #include <skinning_vertex>
  #include <project_vertex>
  vN = normalize(transformedNormal);
  vV = normalize(-mvPosition.xyz);
  vW = (modelMatrix * vec4(transformed, 1.0)).xyz;
}`;
const AURA_FRAG = /* glsl */`
uniform float uK, uTime, uFloor, uTongue;
uniform vec3 uColA, uColB;
varying vec3 vN; varying vec3 vV; varying vec3 vW;
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  // BackSide: FLIP_SIDED turned the normals toward the lens, so d runs 0 at the halo's outer edge -> 0.6-0.8 at the
  // suit. The band is soft on BOTH sides (it floats just off the body): a glow, never a hard line along the outline
  float d = max(0.0, dot(normalize(vN), normalize(vV)));
  float halo = smoothstep(0.0, 0.32, d) * (1.0 - 0.55 * smoothstep(0.35, 0.75, d));
  vec3 q = vW * vec3(7.5, 2.6, 7.5) - vec3(0.0, uTime * 3.2, 0.0);
  float n = vnoise(q) * 0.62 + vnoise(q * 2.3 + 4.1) * 0.38;
  float breathe = 0.65 + 0.35 * vnoise(vW * 1.6 + vec3(0.0, -uTime * 0.9, uTime * 0.3));
  float tongue = mix(1.0, smoothstep(0.42, 0.72, n), uTongue) * breathe;
  float legs = smoothstep(uFloor + 0.32, uFloor + 0.72, vW.y);
  float a = halo * halo * tongue * legs;
  vec3 col = mix(uColA, uColB, clamp(tongue * halo - 0.35, 0.0, 1.0));
  gl_FragColor = vec4(col * a * uK, 1.0);
}`;
function buildAura(h, layer, colA = [0.10, 0.34, 1.25], colB = [0.95, 1.15, 1.7]) {
  // the LOD1 body (a third of the triangles) is plenty for a halo pushed a few centimetres off the suit
  const src = (h.meshes && h.meshes[1] && h.meshes[1].isSkinnedMesh) ? h.meshes[1] : h.skinned;
  if (!src || !src.isSkinnedMesh || !src.parent) return null;
  const mat = new THREE.ShaderMaterial({
    vertexShader: AURA_VERT, fragmentShader: AURA_FRAG,
    uniforms: { uK: { value: 0 }, uTime: { value: 0 }, uPush: { value: 0.035 }, uFloor: { value: 0 }, uTongue: { value: 1 },
      uColA: { value: new THREE.Color(...colA) }, uColB: { value: new THREE.Color(...colB) } },
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.BackSide,
  });
  const m = new THREE.SkinnedMesh(src.geometry, mat);
  m.name = 'heat-aura';
  m.position.copy(src.position); m.quaternion.copy(src.quaternion); m.scale.copy(src.scale);
  m.bindMode = src.bindMode;
  m.bind(src.skeleton, src.bindMatrix);
  if (src.boundingSphere) m.boundingSphere = src.boundingSphere;
  if (src.boundingBox) m.boundingBox = src.boundingBox;
  m.frustumCulled = src.frustumCulled;
  m.castShadow = false; m.receiveShadow = false;
  m.renderOrder = 19;
  m.layers.enable(layer);
  m.visible = false;
  src.parent.add(m);
  return m;
}

// ---------------------------------------------------------------------------------------------- clip helpers
/** play a clip that is not in animations' library (it goes through the humanoid's own mixer and bookkeeping) */
export function playClip(h, clip, { fade = 0.08, speed = 1, loop = false, at = 0 } = {}) {
  if (!h || !clip) return null;
  const action = h.mixer.clipAction(clip);
  action.enabled = true;
  action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  action.clampWhenFinished = !loop;
  if (h.currentAction && h.currentAction !== action) h.currentAction.fadeOut(fade);
  action.reset().setEffectiveTimeScale(speed).setEffectiveWeight(1);
  if (fade > 0) action.fadeIn(fade); else action.stopFading();
  action.play();
  if (at) action.time = at;
  h.currentAction = action; h.currentName = clip.name; h.frozenPose = false;
  return action;
}

// ---------------------------------------------------------------------------------------------- held-bike geometry
// props.js builds the bicycle's tyre, rim and mudguard tori with rx = PI/2, which lays them flat (TorusGeometry is
// already in the XY wheel plane) while the spokes stand upright. Parked at hub height the error hides; lifted over a
// man's head it is the whole silhouette. A bicycle that ends up in someone's hands gets a corrected copy of its
// geometry (vertices picked by their vertex colour); a no-op once props fixes the source.
const RING_TINTS = [[0x17181a, 0.325], [0xb6bbc0, 0.325], [0x55595e, 0.32]];   // tyre, rim, mudguard -> centre height
const _fixed = new Map();
function fixedRingGeometry(geo) {
  if (_fixed.has(geo.uuid)) return _fixed.get(geo.uuid);
  let out = geo;
  const col = geo.attributes.color, pos = geo.attributes.position;
  if (col && pos) {
    const tints = RING_TINTS.map(([hex, cy]) => ({ c: new THREE.Color(hex), cy }));
    const pick = new Int8Array(pos.count).fill(-1);
    let dy = 0, dz = 0;
    for (let i = 0; i < pos.count; i++) {
      for (let k = 0; k < tints.length; k++) {
        const c = tints[k].c;
        if (Math.abs(pos.getY(i) - tints[k].cy) > 0.06) continue;      // a flat ring stays within its tube of the hub height
        if (Math.abs(col.getX(i) - c.r) < 0.0025 && Math.abs(col.getY(i) - c.g) < 0.0025 && Math.abs(col.getZ(i) - c.b) < 0.0025) { pick[i] = k; break; }
      }
      if (pick[i] >= 0) { dy = Math.max(dy, Math.abs(pos.getY(i) - tints[pick[i]].cy)); dz = Math.max(dz, Math.abs(pos.getZ(i))); }
    }
    if (dz > 0.2 && dy < 0.1) {                                        // the rings really are lying flat
      out = geo.clone();
      const p = out.attributes.position, n = out.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        if (pick[i] < 0) continue;
        const cy = tints[pick[i]].cy, y = p.getY(i) - cy, z = p.getZ(i);
        p.setXYZ(i, p.getX(i), cy + z, -y);                            // rotateX(-PI/2) about the hub
        if (n) { const ny = n.getY(i), nz = n.getZ(i); n.setXYZ(i, n.getX(i), nz, -ny); }
      }
      p.needsUpdate = true; if (n) n.needsUpdate = true;
      out.computeBoundingSphere(); out.computeBoundingBox();
      // verify: every corrected ring must now stand in the wheel plane (z extent under 12 cm)
      const zr = tints.map(() => 0);
      for (let i = 0; i < p.count; i++) if (pick[i] >= 0) zr[pick[i]] = Math.max(zr[pick[i]], Math.abs(p.getZ(i)));
      const bad = zr.map((z, k) => [z, k]).filter(([z]) => z * 2 > 0.12);
      if (bad.length) console.warn(`[combat] held bike: ${bad.length} ring(s) still flat after the fix (z extent ${bad.map(([z]) => (z * 2).toFixed(2)).join(', ')} m)`);
    }
  }
  _fixed.set(geo.uuid, out);
  return out;
}
export function fixHeldProp(wrap) {
  if (!wrap || !(wrap.userData.prop && wrap.userData.prop.type === 'bike')) return wrap;
  wrap.traverse((o) => { if (o.isMesh && o.geometry) o.geometry = fixedRingGeometry(o.geometry); });
  return wrap;
}

// ---------------------------------------------------------------------------------------------- module
const combat = {
  name: 'combat',
  entities: [],
  active: [],
  hold: null,
  hitStopUntil: 0,
  baseSpeed: 1, slowUntil: 0,
  finale: null, finaleStillAt: null,
  now: 0,
  ATTACKS, RUSH, FINISH,
  vfx: null,
  timers: [],
  rush: { stage: 0, idle: 99 },
  metrics: { press: [], hits: [], stops: [], knock: [] },

  init(engine) {
    this.engine = engine;
    const anim = engine.get('animations');
    this.anim = anim;
    this.getClip = anim && anim.getClip ? anim.getClip.bind(anim) : null;
    this.rng = engine.rng.fork ? engine.rng.fork(4711) : Math.random;
    this.vfx = createVfx(engine);
    this.buffer = null;
    this.stage = null;
    this.playClip = playClip;
    this.flinches = [];
    this.aura = null; this.auraK = 0; this.auraAcc = 0; this.rdt = 0;
    this.rims = [];
    // finisher-class damage numbers (≥ 30): bigger and orange-red (hud.css owns .dmg; integration request 12)
    if (typeof document !== 'undefined' && !document.getElementById('cx-style')) {
      const st = document.createElement('style'); st.id = 'cx-style';
      st.textContent = '#hud .dmg.cx-fin{font-size:60px;color:#ff5a1e;-webkit-text-stroke:2px #fff0c4;text-shadow:0 0 16px rgba(255,70,20,.85),0 3px 3px #000}';
      document.head.appendChild(st);
    }
    // everything a fight draws for the first time is built and compiled NOW, while loading, not on the frame the
    // gauge crosses 50 or the first wind-up: the heat aura (also the program every red wind-up rim shares) and the
    // flame flipbook. heatActions prewarms its hero bicycle the same way.
    try { this.ensureAura(); } catch (err) { console.warn('[combat] aura prebuild failed', err); }
    this.prewarm(this.vfx.group);
    if (this.aura) this.prewarm(this.aura);

    engine.events.on('combat:end', () => {
      this.releaseHold(true);
      for (const e of this.entities) { e.guardMeter = 0; e.guardBroken = 0; }
      this.rush.stage = 0;
      this.arena(false);
    });
    engine.events.on('combat:start', () => {
      if (!engine.params?.shot) { try { this.dressArena(); } catch (err) { console.warn('[combat] arena dressing failed', err); } }
      this.arena(true);
    });
    engine.events.on('heat:action', () => this.arena(true));
    // a heat action has its own camera: when its final contact kills the LAST man, only the final blow's time, grade and
    // sound run on top of it (the KO itself is deferred to the end of the cinematic, quiet)
    engine.events.on('heat:impact', (e) => {
      if (!e || !e.final || this.finale) return;
      const t = e.target, p = e.player;
      if (!t || !p || !p.isPlayer || t.kind !== 'enemy' || !(t.hp <= 0) || !this.isLastEnemy(t)) return;
      this.startFinale(t, p, e.point, { heat: true });
    });

    if (engine.params && engine.params.heat && engine.player) {
      engine.player.heat = 100;
      engine.events.emit('heat:ready', engine.player);
    }
    // staged screenshots: positions must be set before shots.js reads the player frame for its camera preset
    if (engine.params && engine.params.shot) {
      if (!this.stage && engine.params.fight) this.stage = engine.params.heat ? 'heat' : 'brawl';
      if (this.stage) this.placeStage();
      engine.events.on('engine:booted', () => { try { this.applyStage(); } catch (err) { console.warn('[combat] stage failed', err); } });
    }
    if (engine.params && engine.params.raw && engine.params.raw.combatlab) {
      engine.events.on('engine:booted', () => this.lab().catch(err => console.warn('[combat] lab failed', err)));
    }
  },

  /** compile an object's programs against the live scene's lights/environment in the background (parallel compile) */
  prewarm(obj) {
    const r = this.engine.renderer;
    if (!obj || !r || typeof r.compileAsync !== 'function') return;
    try { r.compileAsync(obj, this.engine.camera, this.engine.scene).catch(() => {}); } catch (err) { /* compiled on first draw instead */ }
  },
  ensureAura() {
    const p = this.engine.player;
    if (!p || !p.humanoid) return null;
    if (this.aura && this.aura.skeleton === ((p.humanoid.meshes && p.humanoid.meshes[1]) || p.humanoid.skinned).skeleton) return this.aura;
    if (this.aura) this.aura.parent?.remove(this.aura);
    this.aura = buildAura(p.humanoid, this.engine.layers.BLOOM);
    return this.aura;
  },

  register(e) {
    if (!e || this.entities.includes(e)) return;
    e.guardMeter = e.guardMeter || 0;
    e.guardBroken = 0; e.guardT = 0; e.weapon = null;
    this.entities.push(e);
  },
  /** the attack record an entity is running (indexed loop: this runs several times a frame) */
  activeOf(e) {
    const A = this.active;
    for (let i = 0; i < A.length; i++) if (A[i].attacker === e) return A[i];
    return null;
  },
  isAttacking(e) { return this.activeOf(e) !== null; },
  isBusy(e) { return this.isAttacking(e) || (this.hold && (this.hold.att === e || this.hold.target === e)); },
  defOf(name) { return ATTACKS[name] || null; },

  // ------------------------------------------------------------------ time: hit-stop + slow-mo share one owner
  /** base game speed that hit-stops return to; with `real` it reverts to 1 after that many real seconds */
  setSlowMo(speed = 1, real = 0) {
    this.baseSpeed = speed;
    this.slowUntil = real > 0 ? this.now + real : 0;
    this.engine.time.speed = this.effSpeed();
  },
  hitStop(ms) {
    if (!ms || this.noStop) return;
    const until = this.now + ms / 1000;
    if (!this.hitStopUntil) this.stopStart = this.now;
    this.hitStopUntil = Math.max(this.hitStopUntil, until);
    this.engine.time.speed = this.effSpeed();
  },
  /** what engine.time.speed must be right now: a hit-stop or the slow-mo base, and never faster than the final blow's
   *  curve while one plays (a heat action's own setSlowMo(1) cannot cut the tail short) */
  effSpeed() {
    let s = this.hitStopUntil ? STOP_SPEED : this.baseSpeed;
    const F = this.finale;
    if (F) s = F.still != null ? 1e-4 : Math.min(s, fbSpeed(F.t));
    return s;
  },
  /** real-time bookkeeping (engine.elapsed is unscaled, so a hit-stop lasts its milliseconds whatever the speed) */
  clock(t) {
    this.rdt = Math.max(0, Math.min(0.05, t - this.now));
    this.now = t;
    if (this.slowUntil && t >= this.slowUntil) { this.slowUntil = 0; this.baseSpeed = 1; this.engine.time.speed = this.effSpeed(); }
    if (this.hitStopUntil && t >= this.hitStopUntil) {
      this.hitStopUntil = 0;
      this.engine.time.speed = this.effSpeed();
      this.metrics.stops.push(Math.round((t - this.stopStart) * 1000));
      if (this.metrics.stops.length > 40) this.metrics.stops.shift();
    }
    if (this.finale) this.tickFinale(this.rdt);
    else if (this._postStill && (this._postStill.t += this.rdt) >= this.finaleStillAt) {
      this._postStill = null;
      this.engine.state.frozen = true;
      console.info(`[combat] final blow held at t=${this.finaleStillAt.toFixed(3)} s (after the sequence)`);
    }
  },

  // ------------------------------------------------------------------ the fight's final blow (finalBlow.js)
  isLastEnemy(target) {
    return !this.entities.some(e => e !== target && e.kind === 'enemy' && e.alive && e.hp > 0 && e.aggro);
  },
  /** the last man goes down: freeze, slow motion, ramp back (engine.time.speed follows fbSpeed on the real clock).
   *  opts.heat: a heat action's final contact — time, grade and sound only; its own camera and FX stay in charge */
  startFinale(target, att, point, opts = {}) {
    const engine = this.engine, vfx = this.vfx, FB = FINAL_BLOW;
    const p = point && point.isVector3 ? point.clone() : new THREE.Vector3(target.position.x, target.position.y + 1.45, target.position.z);
    const dir = new THREE.Vector3(target.position.x - att.position.x, 0, target.position.z - att.position.z);
    if (dir.lengthSq() < 1e-6) att.forward(dir);
    dir.setY(0).normalize();
    const heat = !!opts.heat;
    const act = this.activeOf(att), sw = act && act.def && act.def.sweep;
    const F = this.finale = { t: 0, g: 0, target, att, point: p, dir, heat, still: null, queue: [], input: false, landed: false,
      yaw0: target.yaw, spinSign: sw && sw[0] < 0 ? -1 : 1, flown: false, flashK: 1 };
    engine.time.speed = this.effSpeed();
    // no presses while the blow plays out (a heat action already holds the input)
    if (!heat && engine.input && engine.input.enabled) { engine.input.enabled = false; F.input = true; }
    if (!heat && vfx) {
      // the contact: a white-hot core that burns for two frames and a warm bloom halo (real time, so they are gone
      // before the slow motion starts), a star glint, and the shockwave — a bright ring racing out round the contact
      // with a slower, warmer one behind it
      const G = FB.flashGain, r = Math.random() * 6.283;
      vfx.quad('flash', p.x, p.y, p.z, { life: FB.flash, s0: 0.4, s1: 1.1, r: 5.2 * G, g: 4.9 * G, b: 4.4 * G, pow: 1.1, lift: 0.18, rt: true });
      vfx.quad('flash', p.x, p.y, p.z, { life: FB.flash * 4, s0: 0.7, s1: 2.2, r: 2.2 * G, g: 1.5 * G, b: 0.8 * G, pow: 2.4, lift: 0.14, rt: true });
      vfx.quad('star', p.x, p.y, p.z, { life: FB.flash * 1.6, s0: 1.3, s1: 1.7, r: 4.6, g: 4.3, b: 3.9, roll: r, pow: 0.8, lift: 0.2, rt: true });
      vfx.quad('ring', p.x, p.y, p.z, { life: 0.2, s0: 0.3, s1: FB.ring, r: 2.2, g: 1.95, b: 1.6, pow: 1.4, lift: 0.12, rt: true });
      vfx.quad('ring', p.x, p.y, p.z, { life: 0.36, s0: 0.2, s1: FB.ring * 0.6, r: 1.1, g: 0.8, b: 0.5, pow: 1.8, lift: 0.1, rt: true });
      // sparks thrown along the blow, on game time: the slow motion hangs them in the air
      vfx.spark(p.x, p.y, p.z, FB.sparks, { dir, bias: 0.9, spread: 8.5, life: 0.6, len: 0.02, w: 0.014, minLen: 0.06 });
      // sweat and spit off his face: droplets that hang through the slow motion and fall as time comes back
      const hd = target.humanoid && target.humanoid.boneWorld ? target.humanoid.boneWorld('Head', _e) : _e.copy(p);
      vfx.spark(hd.x, hd.y, hd.z, FB.spray, { dir, bias: 1.3, spread: 2.6, up: 0.35, life: 1.4, r: 1.5, g: 1.6, b: 1.85,
        len: 0.01, w: 0.026, grav: 9.8, hot: 0, drag: 0.35, minLen: 0.035 });
      vfx.quad('ring', target.position.x, target.position.y + 0.04, target.position.z, { life: 0.6, s0: 0.4, s1: 4.6, flat: true, r: 1.4, g: 1.2, b: 0.95, pow: 1.5 });
      // his landing (the knockdown clip reaches the floor FB.land s of game time in): the wet road throws a crown of
      // spray up round him, grit skitters off along the blow, a mist ring spreads
      this.later(FB.land, () => {
        if (this.finale !== F || !target.position) return;
        const gy = engine.world ? engine.world.groundHeight(target.position.x, target.position.z) : target.position.y;
        const q = _v.set(target.position.x, gy + 0.04, target.position.z);
        vfx.splash(q, FB.splash);
        if ((engine.time ? engine.time.wet || 0 : 0) > 0.3) {
          vfx.spark(q.x, q.y + 0.05, q.z, 46, { spread: 3.4, up: 1.9, life: 0.9, r: 0.75, g: 0.85, b: 1.05, len: 0.014, w: 0.013, grav: 9.8, hot: 0, drag: 0.6 });
        }
        vfx.debris(q.x, q.y + 0.06, q.z, 22, { dir, speed: 2.2, size: 0.024, r: 0.46, g: 0.46, b: 0.5 });
        vfx.quad('ring', q.x, q.y, q.z, { life: 1.0, s0: 0.6, s1: 4.2, flat: true, r: 0.55, g: 0.64, b: 0.78, pow: 1.3 });
        F.landed = true;
        engine.events.emit('combat:finale', { phase: 'land', target, attacker: att, point: q.clone(), dir, heat });
      });
    }
    engine.events.emit('combat:finale', { phase: 'start', target, attacker: att, point: p, dir, heat });
    return F;
  },
  /** his flight: a higher arc than the knockdown alone (a parabola peaking at FB.launch m) and a turn in the air, both
   *  over the FB.land s of game time until he lands. combat updates after enemy.js, so the lift and the turn sit on
   *  top of wherever his knockback slid him this frame (walls and cars still stop him) */
  flyFinale(F) {
    const FB = FINAL_BLOW, t = F.target;
    if (F.flown || !t || !t.position) return;
    const u = clamp(F.g / FB.land, 0, 1);
    const gy = this.engine.world ? this.engine.world.groundHeight(t.position.x, t.position.z) : 0;
    t.position.y = gy + FB.launch * 4 * u * (1 - u);
    t.yaw = F.yaw0 + F.spinSign * (FB.spin * Math.PI / 180) * u * u * (3 - 2 * u);
    t.group.rotation.y = t.yaw;
    if (u >= 1) F.flown = true;
  },
  tickFinale(rdt) {
    const F = this.finale, engine = this.engine;
    if (F.still != null) F.t = F.still;
    else if (engine.state.mode !== 'paused') F.t += rdt;
    // ?shot=final_blow&t=<s>: freeze the whole sequence on that instant for a still
    if (this.finaleStillAt != null && F.still == null && F.t >= this.finaleStillAt) {
      F.still = F.t = this.finaleStillAt;
      engine.state.frozen = true;
      console.info(`[combat] final blow held at t=${F.t.toFixed(3)} s`);
    }
    engine.time.speed = this.effSpeed();
    F.flashK = F.t < FINAL_BLOW.flash ? FINAL_BLOW.flashGain : 0;   // (published for the live measurement)
    if (F.still == null && F.t >= fbEnd()) this.endFinale();
  },
  endFinale() {
    const F = this.finale, engine = this.engine;
    if (!F) return;
    this.finale = null;
    engine.time.speed = this.effSpeed();
    const ha = engine.get('heatActions');
    if (F.input && engine.input && !engine.input.enabled && !(ha && ha.running) && engine.state.mode !== 'cutscene') engine.input.enabled = true;
    engine.events.emit('combat:finale', { phase: 'end', target: F.target, attacker: F.att, point: F.point, dir: F.dir, heat: F.heat });
    for (const fn of F.queue) { try { fn(); } catch (err) { console.warn('[combat] after-finale', err); } }
    if (this.finaleStillAt != null && this.finaleStillAt > F.t) this._postStill = { t: F.t };   // a still after the end
  },
  /** run fn when the final blow has played out (now, if none is playing): the results wait for the camera to return */
  afterFinale(fn) {
    if (this.finale) { this.finale.queue.push(fn); return true; }
    fn();
    return false;
  },
  /** game-time timers (hit-stop and slow-mo delay them like everything else) */
  later(sec, fn) { this.timers.push({ t: sec, fn }); },

  // ------------------------------------------------------------------ attack / buffering / cancels
  attack(attacker, name) {
    if (!attacker || !attacker.alive) return false;
    // holding someone: the light button knees, heavy / grab throws
    if (this.hold && this.hold.att === attacker) {
      if (name === 'grab' || HEAVY_BUTTON.has(name)) { this.doThrow(); return true; }
      this.doKnee(); return true;
    }
    if (attacker.isPlayer) {
      const type = name === 'grab' ? 'grab' : HEAVY_BUTTON.has(name) ? 'heavy' : 'light';
      this.metrics.lastPress = this.now;
      return this.press(attacker, type);
    }
    if (attacker.weapon) {
      if (name === 'grab') { this.throwWeapon(attacker); return true; }
      name = ATTACKS[name] && ATTACKS[name].heavy ? 'w_heavy' : 'w_swing';
    }
    const def = ATTACKS[name];
    if (!def || this.isAttacking(attacker)) return false;
    return this.start(attacker, name, def);
  },

  /** a player press: buffered while the current link is still before its cancel window */
  press(p, type) {
    const cur = this.activeOf(p);
    if (cur) {
      if (cur.def.hold || cur.locked) return false;
      if (cur.t < cur.cancelAt) {
        if (!this.buffer || type !== 'light') this.buffer = { attacker: p, type, t: 0 };
        return true;
      }
      this.endAttack(cur);
    }
    return this.startPlayer(p, type);
  },

  startPlayer(p, type) {
    const R = this.rush;
    if (R.idle > STRING_WINDOW) R.stage = 0;
    if (type === 'grab') {
      R.stage = 0;
      if (p.weapon) { this.throwWeapon(p); return true; }
      if (!this.grabCandidate(p) && this.pickUp(p, 1.9)) return true;
      return this.start(p, 'grab', ATTACKS.grab);
    }
    if (p.weapon) return this.start(p, type === 'heavy' ? 'w_heavy' : 'w_swing', ATTACKS[type === 'heavy' ? 'w_heavy' : 'w_swing']);
    let name;
    if (type === 'heavy') { name = FINISH[Math.min(R.stage, FINISH.length - 1)]; R.stage = 0; }
    else { name = RUSH[R.stage]; R.stage = (R.stage + 1) % RUSH.length; }
    return this.start(p, name, ATTACKS[name]);
  },

  start(attacker, name, def) {
    const engine = this.engine;
    const clipName = def.clip || name;
    const clip = this.getClip ? this.getClip(clipName) : null;
    if (!clip) return false;
    const rate = (def.rate || 1) * (attacker.isPlayer ? 1 : ENEMY_RATE);
    const target = def.noHit ? null : this.aim(attacker, def);
    const action = attacker.humanoid.play(clipName, { loop: false, fade: def.held ? 0.04 : 0.06, force: true, speed: rate });
    const evs = (clip.userData && clip.userData.events || []).filter(ev => ev.name === 'hit');
    const hits = def.noHit ? [] : (evs.length ? evs.map(ev => ({ t: ev.time, bone: ev.bone || 'RightHand', r: (ev.radius || 0.3) * (def.radius || 1) }))
      : [{ t: clip.duration * 0.4, bone: 'RightHand', r: 0.3 * (def.radius || 1) }]);
    const first = hits.length ? hits[0].t : clip.duration * 0.4;
    // lights cancel straight after contact (that is what makes the rush a rush); heavies commit through most of the swing
    const cancelAt = def.heavy && !RUSH.includes(name) ? Math.max(first + 0.12, clip.duration * 0.62)
      : RUSH.includes(name) && name !== 'uppercut' ? first + 0.05 : Math.max(first + 0.08, clip.duration * 0.5);
    const pressT = attacker.isPlayer ? this.metrics.lastPress : null;
    if (attacker.isPlayer) this.metrics.lastPress = null;
    this.active.push({
      attacker, name, def, t: 0, rate, duration: clip.duration, hits, done: new Set(), action, target,
      cancelAt, prev: new THREE.Vector3(), prevOk: false, landed: false, pressT,
    });
    attacker.attackName = name;
    if (attacker.isPlayer) this.rush.idle = 0;
    engine.events.emit('combat:attack', { attacker, name, heavy: !!def.heavy });
    return true;
  },

  endAttack(a) {
    const i = this.active.indexOf(a);
    if (i >= 0) this.active.splice(i, 1);
    if (a.attacker.weapon && a.def.weapon) this.wearWeapon(a.attacker, a.landed);
  },

  /** soft lock: turn to the best target in the stick direction (or the facing) and step in to the strike's range */
  aim(att, def) {
    const engine = this.engine;
    let want = att.forward(_a);
    if (att.isPlayer) {
      const input = engine.input, cam = engine.get('camera');
      if (input && input.move.lengthSq() > 0.04 && cam && cam.getForward) {
        cam.getForward(_f);
        want = _b.set(-_f.z, 0, _f.x).multiplyScalar(input.move.x).addScaledVector(_f, input.move.y).normalize();
      }
    }
    let best = null, bs = Infinity;
    for (const t of this.entities) {
      if (t === att || !t.alive || t.kind === att.kind || t.state === 'dead') continue;
      const dx = t.position.x - att.position.x, dz = t.position.z - att.position.z, d = Math.hypot(dx, dz);
      if (d > (att.isPlayer ? 3.6 : 2.6) || d < 1e-3) continue;
      const ang = Math.acos(clamp((dx * want.x + dz * want.z) / d, -1, 1));
      if (att.isPlayer && ang > 1.75) continue;
      let score = d + ang * 1.3;
      if (att.lockTarget === t) score -= 2;
      if (t.state === 'down' || t.state === 'getup') score += def.ground ? -1 : 3;
      if (score < bs) { bs = score; best = t; }
    }
    if (!best) return null;
    const dx = best.position.x - att.position.x, dz = best.position.z - att.position.z, d = Math.hypot(dx, dz);
    att.yaw = Math.atan2(dx, dz);
    att.group.rotation.y = att.yaw;
    const close = d - Math.max(0.78, def.reach - 0.34);
    if (close > 0.02 && def.lunge) {
      const step = Math.min(close, att.isPlayer ? def.lunge : Math.min(def.lunge, 0.35));
      att.velocity.set(dx / d, 0, dz / d).multiplyScalar(step * DAMP);
    }
    return best;
  },

  grabCandidate(p) {
    for (const t of this.entities) {
      if (t === p || !t.alive || t.kind === p.kind || t.state === 'down' || t.state === 'dead') continue;
      if (Math.hypot(t.position.x - p.position.x, t.position.z - p.position.z) < 1.9) return t;
    }
    return null;
  },

  // ------------------------------------------------------------------ frame
  update(dt, t) {
    const engine = this.engine;
    this.clock(t != null ? t : this.now + dt);
    const frozen = engine.state.frozen || engine.state.mode === 'paused';
    const rdt = this.rdt;
    this.updateAura(rdt, frozen);
    // through a hit-stop the bodies hold, but sparks and chips keep flying at a quarter of real time
    if (this.vfx) {
      this.vfx.streakK = this.finale && !this.finale.heat ? Math.max(0.3, Math.sqrt(fbSpeed(this.finale.t))) : 1;
      this.vfx.update(dt, frozen, this.hitStopUntil ? rdt * 0.25 : dt, rdt);
    }
    if (frozen) return;
    this.updateFlinch(dt);
    if (this.finale && !this.finale.heat) { this.finale.g += dt; this.flyFinale(this.finale); }
    // ?shot=final_blow: the gameplay rig has settled on the live fight, now the real blow is thrown
    if (this._fbStage) {
      const S = this._fbStage, v = S.victim;
      if (v && v.alive) {                                  // he holds his mark (the AI would circle off to its spacing)
        v.position.copy(S.at); v.velocity.set(0, 0, 0); v.yaw = S.yaw; v.group.rotation.y = S.yaw; v.cooldown = 99;
      }
      if ((S.wait -= this.rdt) <= 0) {
        this._fbStage = null;
        // the fight is on: whatever he carries is on the ground (as combat:start does in play; humanoid.js picks it
        // back up once the fight is over)
        const h = engine.player.humanoid;
        if (h && h.propKind && h.props && h.props.prop && h.dropProp) { try { h.stashedProp = h.propKind; h.dropProp(engine.scene); } catch (err) { /* cosmetic */ } }
        const ok = this.throwFinisher(engine.player, S.move), a = this.activeOf(engine.player);
        console.info(`[combat] final blow still: threw ${a ? a.name : S.move} (${ok ? 'started' : 'FAILED'}) at ${v ? Math.hypot(v.position.x - engine.player.position.x, v.position.z - engine.player.position.z).toFixed(2) : '-'} m`);
      }
    }

    for (let i = this.timers.length - 1; i >= 0; i--) {
      const tm = this.timers[i];
      tm.t -= dt;
      if (tm.t <= 0) { this.timers.splice(i, 1); try { tm.fn(); } catch (err) { console.warn('[combat] timer', err); } }
    }

    const player = engine.player;
    if (this.buffer) { this.buffer.t += dt / Math.max(0.05, engine.time.speed || 1); if (this.buffer.t > BUFFER) this.buffer = null; }
    if (player && player.alive && engine.state.mode !== 'cutscene') this.pollPlayer(player);

    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      a.t += dt * (a.rate || 1);
      if (a.def.hold) continue;                                   // grab hold pseudo-attack
      // enemy wind-up tell: a red-white glint on the striking limb ~0.25 s (real) before contact
      if (!a.attacker.isPlayer && !a.told && a.hits.length && a.t >= a.hits[0].t - 0.25 * (a.rate || 1)) {
        a.told = true;
        if (this.vfx) this.vfx.telegraph(a.attacker.humanoid, a.hits[0].bone);
        this.rim(a.attacker, 0.25 / (a.rate || 1) + 0.08);
        engine.events.emit('combat:telegraph', { attacker: a.attacker, name: a.name });
      }
      for (let k = 0; k < a.hits.length; k++) {
        if (a.done.has(k)) continue;
        if (a.t >= a.hits[k].t) { a.done.add(k); this.resolveHit(a, a.hits[k]); }
      }
      this.trackBone(a);
      if (a.t >= a.duration - 0.02 || !a.attacker.alive) this.endAttack(a);
    }
    // consume a buffered press as soon as the current link opens its cancel window
    if (this.buffer) {
      const cur = this.activeOf(this.buffer.attacker);
      if (!cur || (cur.t >= cur.cancelAt && !cur.def.hold)) {
        const b = this.buffer; this.buffer = null;
        if (cur) this.endAttack(cur);
        if (b.attacker.alive) this.startPlayer(b.attacker, b.type);
      }
    }

    if (player) {
      if (this.isAttacking(player)) this.rush.idle = 0;
      else { this.rush.idle += dt; if (this.rush.idle > STRING_WINDOW) this.rush.stage = 0; }
    }

    this.updateHold(dt);
    this.separate(dt);

    for (const e of this.entities) {
      if (e.guardMeter > 0 && !e.guard) e.guardMeter = Math.max(0, e.guardMeter - GUARD_REGEN * dt);
      if (e.guardBroken > 0) e.guardBroken -= dt;
      if (e.guardT > 0) e.guardT -= dt;
      if (e.isPlayer) {
        if (e.comboT > 0) { e.comboT -= dt; if (e.comboT <= 0 && e.combo) { e.combo = 0; const h = engine.get('hud'); if (h) h.combo(0); } }
        if (e.heat > 0 && engine.state.mode !== 'combat' && engine.state.mode !== 'cutscene') e.heat = Math.max(0, e.heat - dt * 2.5);
      }
      if (e._kb) {                                                 // knockback measurement
        const k = e._kb;
        if (e.velocity.lengthSq() < 0.0025 || this.now - k.t0 > 2.5) {
          this.metrics.knock.push({ name: k.name, d: +Math.hypot(e.position.x - k.x, e.position.z - k.z).toFixed(2), want: k.want });
          if (this.metrics.knock.length > 40) this.metrics.knock.shift();
          e._kb = null;
        }
      }
    }

    // weapon pick-up / drop on the interact button
    if (player && player.alive && engine.input && engine.input.buttons.interact.pressed && !this.isBusy(player) && engine.state.mode !== 'cutscene') {
      if (player.weapon) this.dropWeapon(player); else this.pickUp(player);
    }
  },

  /** capsules do not pass through each other: two standing fighters closer than their radii are eased apart (the
   *  player gives way less than a thug), through the world's slide-collide so nobody is pushed into a wall. A man on
   *  the floor, a grab pair and the actors of a running heat action are left alone. */
  separate(dt) {
    const world = this.engine.world, ha = this.engine.get('heatActions'), S = ha && ha.running;
    const E = this.entities, H = this.hold;
    for (let i = 0; i < E.length; i++) {
      const a = E[i];
      if (!a.alive || a.state === 'down' || a.state === 'dead' || (S && (a === S.player || a === S.target))) continue;
      for (let j = i + 1; j < E.length; j++) {
        const b = E[j];
        if (!b.alive || b.state === 'down' || b.state === 'dead' || (S && (b === S.player || b === S.target))) continue;
        if (H && ((H.att === a && H.target === b) || (H.att === b && H.target === a))) continue;
        const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z, d = Math.hypot(dx, dz);
        const min = (a.radius || 0.35) + (b.radius || 0.35) + 0.12;
        if (d >= min) continue;
        const push = Math.min(min - d, 3.5 * dt + (min - d) * 0.35);
        const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
        const wa = a.isPlayer ? 0.25 : b.isPlayer ? 0.75 : 0.5;
        this.nudge(world, a, nx * push * -wa, nz * push * -wa);
        this.nudge(world, b, nx * push * (1 - wa), nz * push * (1 - wa));
      }
    }
  },
  nudge(world, e, x, z) {
    if (!x && !z) return;
    _v.set(x, 0, z);
    if (world && world.moveCapsule) { const p = world.moveCapsule(e.position, e.radius || 0.35, e.height || 1.8, _v); e.position.x = p.x; e.position.z = p.z; }
    else e.position.add(_v);
  },

  /** player.js only reads buttons when he is idle; inside a string the presses come through here */
  pollPlayer(p) {
    const b = this.engine.input && this.engine.input.buttons;
    const cur = b ? this.activeOf(p) : null;
    if (!cur || (this.hold && this.hold.att === p)) return;
    if (b.attack.pressed) this.attack(p, 'jab');
    else if (b.heavy.pressed) this.attack(p, 'kick');
    else if (b.grab.pressed) this.attack(p, 'grab');
    else if (b.dodge.pressed && cur && cur.t >= cur.cancelAt) this.dodgeCancel(p, cur);
    else if (b.heat.pressed && cur && cur.t >= cur.cancelAt) {
      const ha = this.engine.get('heatActions');
      if (ha && ha.available && ha.available(p)) { this.endAttack(cur); this.buffer = null; ha.trigger(p); }
    }
  },

  /** recovery frames are cancellable into a dodge: same motion player.js would start from idle */
  dodgeCancel(p, cur) {
    const engine = this.engine, input = engine.input, cam = engine.get('camera');
    this.endAttack(cur); this.buffer = null; this.rush.stage = 0;
    let dir;
    if (input.move.lengthSq() > 0.01 && cam && cam.getForward) {
      cam.getForward(_f);
      dir = new THREE.Vector3(-_f.z, 0, _f.x).multiplyScalar(input.move.x).addScaledVector(_f, input.move.y).normalize();
      p.yaw = Math.atan2(dir.x, dir.z);
    } else { dir = p.forward(new THREE.Vector3()).negate(); }
    p.dodgeDir = dir; p.velocity.set(0, 0, 0);
    p.setState('dodge'); p.humanoid.play('dodge', { loop: false, force: true });
    engine.events.emit('player:dodge', p);
  },

  trackBone(a) {
    const b = a.hits[0]; if (!b) return;
    a.attacker.humanoid.boneWorld(b.bone, _a);
    a.prev.copy(_a); a.prevOk = true;
  },

  // ------------------------------------------------------------------ hitboxes
  /** sphere on the striking bone, swept from the previous frame, padded out to the attack's design reach,
   *  tested against every opponent's capsule */
  resolveHit(a, ev) {
    const att = a.attacker, def = a.def;
    const h = att.humanoid;
    h.boneWorld(ev.bone, _a);                                       // strike point
    h.boneWorld('Spine1', _b);                                      // shaft root
    if (_b.lengthSq() < 1e-6) _b.set(att.position.x, att.position.y + 1.2, att.position.z);
    const fwd = att.forward(_c);
    const flat = Math.hypot(_a.x - att.position.x, _a.z - att.position.z);
    const pad = Math.max(0, def.reach - flat - ev.r);
    const tip = _hTip.copy(_a).addScaledVector(fwd, pad), root = _hRoot.copy(_b);
    const from = a.prevOk ? a.prev : root;
    const r = ev.r + 0.1;

    const hit = [];
    for (const target of this.entities) {
      if (target === att || !target.alive || target.kind === att.kind || target.state === 'dead') continue;
      if ((target.state === 'down' || target.state === 'getup') && !def.ground) continue;   // no juggling a man on the floor
      const gap = Math.hypot(target.position.x - att.position.x, target.position.z - att.position.z);
      if (gap > def.reach + (target.radius || 0.35) + 1.1) continue;
      capsuleSeg(target, _hC0, _hC1);                                    // segSegDist2 scribbles on _e/_f/_g
      const rr = r + (target.radius || 0.35);
      let d2 = segSegDist2(from, tip, _hC0, _hC1);
      if (d2 > rr * rr) d2 = segSegDist2(root, tip, _hC0, _hC1);         // shaft (arm/leg) sweep
      if (d2 > rr * rr) continue;
      hit.push({ target, d2: d2 + (target === a.target ? -1 : 0) });
    }
    hit.sort((p, q) => p.d2 - q.d2);
    const list = def.multi ? hit : hit.slice(0, 1);
    if (def.grab) { if (list[0]) this.beginHold(att, list[0].target); }
    else for (const x of list) this.applyHit(att, x.target, def, a.name, a);
    if (list.length) a.landed = true;
    if (!list.length && att.weapon && def.weapon) this.swingProps(att, tip, def);
  },

  /** where a blow lands: the striking bone pulled onto the target's body surface */
  contactPoint(att, target, a, out) {
    const cx = target.position.x, cz = target.position.z;
    if (a && a.hits.length) att.humanoid.boneWorld(a.hits[0].bone, _a);
    else _a.set((att.position.x + cx) * 0.5, target.position.y + 1.3, (att.position.z + cz) * 0.5);
    const y = clamp(_a.y, target.position.y + 0.5, target.position.y + (target.height || 1.8) - 0.12);
    let dx = _a.x - cx, dz = _a.z - cz;
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) { dx = att.position.x - cx; dz = att.position.z - cz; }
    const k = (target.radius || 0.35) * 0.8 / Math.max(1e-4, Math.hypot(dx, dz));
    return out.set(cx + dx * k, y, cz + dz * k);
  },

  /** opts: { noReact, deferKo, point, dir, dmg, vfx:false } — heat actions drive their own reactions */
  applyHit(att, target, def, name, a = null, opts = {}) {
    const engine = this.engine, hud = engine.get('hud'), cam = engine.get('camera'), vfx = this.vfx;
    // hit vectors come from a ring (the combat:hit payload keeps them valid for the next 15 hits, no per-hit garbage)
    const dir = hitVec().set(target.position.x - att.position.x, 0, target.position.z - att.position.z);
    if (opts.dir) dir.copy(opts.dir).setY(0);
    if (dir.lengthSq() < 1e-6) att.forward(dir);
    dir.normalize();
    const point = opts.point ? hitVec().copy(opts.point) : this.contactPoint(att, target, a, hitVec());

    const guarded = opts.noReact ? false : this.rollGuard(target, att, def);
    let dmg = opts.dmg != null ? opts.dmg : def.dmg;
    if (target.guardBroken > 0 && !guarded) dmg = Math.round(dmg * 1.5);
    const heavy = !!def.heavy;
    const wasAlive = target.hp > 0;

    if (guarded) {
      dmg = Math.max(1, Math.round(dmg * 0.15));
      target.hp = Math.max(0, target.hp - dmg);
      target.humanoid.play('guard_hit', { loop: false, force: true });
      target.velocity.copy(dir).multiplyScalar((def.push || 0.3) * 0.45 * DAMP);
      target.guardMeter = (target.guardMeter || 0) + (def.guard || 20);
      target.guardT = 0.6;
      if (!target.isPlayer) { target.setState('hit'); target.stateT = 0.05; }   // hold the block instead of walking out of it
      if (vfx && opts.vfx !== false) vfx.impact(point, dir, { scale: 0.8 * (def.fx || 1), heavy: false, guard: true });
      this.hitStop(Math.round(def.stop * 0.6));
      if (cam && cam.shake) cam.shake(def.shake[0] * 0.5, def.shake[1] * 0.7);
      if (target.guardMeter >= GUARD_MAX) this.guardBreak(target, att, point, dir);
    } else {
      target.hp = Math.max(0, target.hp - dmg);
      const ko = target.hp <= 0;
      const blow = this.blowDir(att, dir, def, hitVec());
      if (!opts.noReact) {
        const down = def.knockdown || ko || (heavy && target.hp < target.hpMax * 0.2) || (target.guardBroken > 0 && heavy);
        const push = (def.push != null ? def.push : 0.5) * (ko && !def.knockdown ? 1.6 : 1);
        target.velocity.copy(dir).multiplyScalar(push * DAMP);
        target.yaw = Math.atan2(-dir.x, -dir.z);
        target.group.rotation.y = target.yaw;
        target._kb = { x: target.position.x, z: target.position.z, t0: this.now, name, want: +push.toFixed(2) };
        if (down) {
          target.setState('down');
          target.humanoid.play('knockdown', { loop: false, force: true });
          // the body reaches the floor ~0.4 s (game time) into the clip, at the end of its slide
          this.later(0.4, () => { if (vfx) vfx.dust(_e.set(target.position.x, target.position.y + 0.04, target.position.z), def.launch ? 1.2 : 1.0); });
        } else {
          const react = target.guardBroken > 0 ? 'stumble' : this.reaction(target, point, blow, def);
          target.setState('hit');
          if (react !== 'hit_light' && react !== 'hit_heavy') target.stateT = -0.35;
          this.playReact(target, react);
        }
        this.flinch(target, point, blow, def);
      }
      if (vfx && opts.vfx !== false) vfx.impact(point, blow, { scale: def.fx || 1, heavy });
      this.hitStop(def.stop + (ko && wasAlive ? 40 : 0));
      if (cam && cam.shake) cam.shake(def.shake[0], def.shake[1]);
    }

    if (att.isPlayer) {
      att.combo = (att.combo || 0) + 1; att.comboT = COMBO_HOLD;
      if (hud) hud.combo(att.combo);
      const before = att.heat;
      const gain = (def.heat || 0) * (guarded ? 0.4 : 1) * (1 + Math.min(0.6, att.combo * 0.04));
      att.heat = Math.min(100, att.heat + gain);
      if (before < 100 && att.heat >= 100) engine.events.emit('heat:ready', att);
      if (a && a.pressT != null) {                                // input → contact, real ms (includes any buffer wait)
        this.metrics.hits.push({ name, ms: Math.round((this.now - a.pressT) * 1000), guarded });
        if (this.metrics.hits.length > 40) this.metrics.hits.shift();
        a.pressT = null;
      }
    } else if (target.isPlayer && !guarded) {
      target.combo = 0; target.comboT = 0;
      target.heat = Math.max(0, (target.heat || 0) - 4);
      if (hud) hud.combo(0);
    }

    engine.events.emit('combat:hit', { attacker: att, target, damage: dmg, dir, point, heavy, name, guarded, combo: att.combo | 0 });
    if (target.hp <= 0 && target.alive && !opts.deferKo) this.knockOut(target, att, point);
    return dmg;
  },

  knockOut(target, att, point, quiet = false) {
    const engine = this.engine, cam = engine.get('camera');
    const last = target.kind === 'enemy' && this.isLastEnemy(target);
    // the fight's final blow (finalBlow.js): set up BEFORE combat:ko goes out, because enemy.js ends the fight inside
    // that event and the results must already know to wait for it. A heat action's KO (quiet) had its tail at the
    // contact; a man killed by anything but 健人 (a car, the scenery) just goes down.
    const fin = last && att && att.isPlayer && !quiet && !this.finale && engine.state.mode !== 'cutscene';
    if (fin) this.startFinale(target, att, point);
    else {
      if (cam && cam.shake) cam.shake(0.55, 0.45);
      this.vfx.shock(_b.set(target.position.x, target.position.y, target.position.z), 0.7);
    }
    engine.events.emit('combat:ko', { target, attacker: att, finale: !!fin || !!(last && this.finale) });
  },

  // ------------------------------------------------------------------ hit reactions
  /** which way the fist/foot is travelling at contact: along the line of the blow, bent by the attack's sweep */
  blowDir(att, dir, def, out) {
    out.copy(dir);
    const sw = def && def.sweep;
    if (sw) { const f = att.forward(_v); out.x += f.z * sw[0]; out.z -= f.x * sw[0]; out.y += sw[1]; }
    return out.normalize();
  },
  /** the reaction is chosen from WHERE it landed and which way it was going: a hook to the jaw throws the head to
   *  the side it travels, a straight snaps it back, anything into the belly folds him (くの字), low blows stagger */
  reaction(target, point, blow, def) {
    const rel = (point.y - target.position.y) * 1.8 / (target.height || 1.8);
    if (rel > 1.45) {
      const side = blow.x * -Math.cos(target.yaw) + blow.z * Math.sin(target.yaw);   // + = shoved toward his right
      if (Math.abs(side) > 0.35) return side > 0 ? 'cx_hit_head_r' : 'cx_hit_head_l';
      return def.heavy ? 'hit_heavy' : 'hit_light';
    }
    if (rel > 0.9) return 'cx_hit_body';
    return 'stumble';
  },
  playReact(e, name, phase = null) {
    const clips = this.reactClips();
    const clip = clips[name];
    if (phase != null) { this.poseHard(e.humanoid, name, phase, clip || null); return; }
    if (clip) playClip(e.humanoid, clip, { fade: 0.04 });
    else e.humanoid.play(name, { loop: false, force: true, fade: 0.05 });
  },
  /** head-left / head-right / body-fold reactions, authored from the stance frame against the bone contract */
  reactClips() {
    if (this._react) return this._react;
    this._react = {};
    try {
      const A = this.anim;
      if (!A || !A.makeClip || !A.getFrames) return this._react;
      const C = poseOf(A, 'idle_combat', 0);
      if (!C) return this._react;
      const K = C.ikL ? C.ikL[1] : 0.09;
      // offsets for a blow that shoves the head to HIS RIGHT (negative yaw turns right, positive roll tilts right)
      const hitR = (s) => addPose(C, {
        hips: [-0.05 * s, -0.12 * s, -0.06 * s], Hips: [-3 * s, -12 * s, 0], Spine: [-3 * s, -6 * s, 3 * s], Spine1: [-5 * s, -12 * s, 5 * s],
        Spine2: [-4 * s, -10 * s, 5 * s], Neck: [-10 * s, -22 * s, 9 * s], Head: [-14 * s, -34 * s, 16 * s],
        LeftShoulder: [0, 0, 8 * s], RightShoulder: [0, 0, 12 * s], LeftArm: [-14 * s, 0, 18 * s], LeftForeArm: [-38 * s, 0, 0], RightArm: [-20 * s, 0, 28 * s], RightForeArm: [-56 * s, 0, 0] });
      const mirror = (p) => {
        const o = {};
        for (const k in p) {
          const v = p[k];
          if (k === 'hips') o[k] = [-v[0], v[1], v[2]];
          else if (k === 'ikL' || k === 'ikR') continue;
          else if (k.startsWith('Left') || k.startsWith('Right')) continue;
          else o[k] = [v[0], -v[1], -v[2]];
        }
        for (const k in p) {
          if (k.startsWith('Left')) o['Right' + k.slice(4)] = p[k];
          else if (k.startsWith('Right')) o['Left' + k.slice(5)] = p[k];
        }
        return o;
      };
      const offR = (s) => { const d = {}; const full = hitR(s); for (const k in full) if (C[k] && k !== 'ikL' && k !== 'ikR') d[k] = full[k].map((v, i) => v - C[k][i]); return d; };
      const stepBack = { ikR: [C.ikR ? C.ikR[0] : -0.2, K + 0.04, (C.ikR ? C.ikR[2] : -0.3) - 0.1, -12, C.ikR ? C.ikR[4] : 30] };
      const headKeys = (o) => [
        { t: 0, pose: C }, { t: 0.05, pose: addPose(C, o(1)) }, { t: 0.16, pose: addPose(addPose(C, o(0.72)), stepBack) },
        { t: 0.34, pose: addPose(addPose(C, o(0.25)), stepBack) }, { t: 0.6, pose: C }];
      this._react.cx_hit_head_r = A.makeClip('cx_hit_head_r', headKeys(offR));
      this._react.cx_hit_head_l = A.makeClip('cx_hit_head_l', headKeys((s) => mirror(offR(s))));
      // くの字: the fist/foot drives into the belly, the pelvis goes back, the chest folds over it, hands clutch, and
      // the chin is thrown forward (the face comes out over the blow instead of burying itself in the jacket)
      const clutch = { LeftShoulder: [8, 0, 0], RightShoulder: [8, 0, 0], LeftArm: [24, -6, 12], LeftForeArm: [100, 0, 0], RightArm: [24, -6, 12], RightForeArm: [100, 0, 0], LeftHand: [0, 0, 0], RightHand: [0, 0, 0] };
      const fold = (s) => setPose(addPose(C, { hips: [0, -0.08 - 0.1 * s, -0.08 - 0.1 * s], Hips: [12 * s, 0, 0], Spine: [8 * s, 0, 0], Spine1: [10 * s, 0, 0], Spine2: [6 * s, 0, 0], Neck: [-8 * s, 0, 0], Head: [-14 * s, 0, 0] }), clutch);
      this._react.cx_hit_body = A.makeClip('cx_hit_body', [
        { t: 0, pose: C }, { t: 0.06, pose: fold(0.8) }, { t: 0.2, pose: addPose(fold(1.25), stepBack) }, { t: 0.42, pose: addPose(fold(0.9), stepBack) },
        { t: 0.75, pose: C }]);
    } catch (err) { console.warn('[combat] reaction clips', err); }
    return this._react;
  },
  /** additive jolt on top of whatever clip plays: the spine and neck snap along the blow (~25°) and recover over
   *  ~120 ms, so no two hits land the same even on the same reaction clip */
  flinch(target, point, blow, def, amp = null) {
    if (!target.humanoid || !target.humanoid.bones) return null;
    const rel = (point.y - target.position.y) * 1.8 / (target.height || 1.8);
    const body = rel <= 1.45;
    const a = amp != null ? amp : Math.min(0.5, (def && def.heavy ? 0.44 : 0.3) * Math.min(1.2, 0.8 + (def && def.fx || 1) * 0.2));
    const axis = new THREE.Vector3(blow.z, 0, -blow.x);                // up x blow: rotating about it tips the chest along the blow
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0); else axis.normalize();
    for (let i = this.flinches.length - 1; i >= 0; i--) if (this.flinches[i].e === target) this.flinches.splice(i, 1);
    const f = { e: target, axis, amp: body ? -a * 0.8 : a, t: 0, bones: body ? FLINCH_BODY : FLINCH_HEAD };
    this.flinches.push(f);
    return f;
  },
  updateFlinch(dt) {
    for (let i = this.flinches.length - 1; i >= 0; i--) {
      const f = this.flinches[i];
      f.t += dt;
      if (f.t > 0.6 || !f.e.alive) { this.flinches.splice(i, 1); continue; }
      if (f.e.humanoid.frozenPose) continue;                          // a held pose would integrate it
      this.applyFlinch(f, f.amp * Math.exp(-f.t / 0.12));
    }
  },
  applyFlinch(f, k) {
    const bones = f.e.humanoid.bones;
    for (const [name, w] of f.bones) {
      const b = bones[name]; if (!b || !b.parent) continue;
      b.parent.getWorldQuaternion(_q);
      _q2.setFromAxisAngle(f.axis, k * w);
      b.quaternion.premultiply(_fq.copy(_q).invert().multiply(_q2).multiply(_q));
    }
  },

  // ------------------------------------------------------------------ heat aura
  updateAura(rdt, frozen) {
    const engine = this.engine, p = engine.player;
    if (!p || !p.humanoid) return;
    const ha = engine.get('heatActions');
    const heat = p.heat || 0, running = !!(ha && ha.running);
    const k = clamp((heat - 50) / 50, 0, 1);
    let want = heat >= 50 && p.alive !== false ? 0.3 + 0.55 * k : 0;
    if (heat >= 100) want = 1.1 + 0.15 * Math.sin(this.now * 9);            // charged: it flares and pulses
    if (running) want = 1.3;
    this.auraK += (want - this.auraK) * Math.min(1, (frozen && this.stage ? 1 : rdt * 6));
    const aura = this.auraK > 0.02 ? this.ensureAura() : this.aura;
    if (aura) {
      const u = aura.material.uniforms;
      aura.visible = this.auraK > 0.02;
      u.uK.value = this.auraK * this.auraK * 0.62; u.uTime.value = this.now; u.uFloor.value = p.position.y;   // faint at 50, full at 100
      u.uPush.value = 0.03 + 0.02 * Math.min(1, this.auraK);
    }
    this.updateRims(rdt, frozen);
    if (this.auraK <= 0.05 || !this.vfx) return;
    const rate = 4 + 12 * Math.min(1.2, this.auraK);                         // flame tongues per second
    this.auraAcc += rdt * rate;
    let n = 0;
    while (this.auraAcc >= 1 && n++ < 6) { this.auraAcc -= 1; this.vfx.lick(p.humanoid, Math.min(1.2, this.auraK)); }
  },
  /** an enemy about to throw a blow glows red along his outline (7外伝's unblockable tell), ~0.3 s real */
  rim(e, life = 0.32) {
    if (!e || !e.humanoid) return;
    let r = this.rims.find(x => x.e === e);
    if (!r) {
      const m = buildAura(e.humanoid, this.engine.layers.BLOOM, [0.95, 0.05, 0.03], [1.5, 0.35, 0.18]);
      if (!m) return;
      m.material.uniforms.uTongue.value = 0.25;
      r = { e, m, t: 0, life };
      this.rims.push(r);
    }
    r.t = 0; r.life = life;
  },
  updateRims(rdt, frozen) {
    for (let i = 0; i < this.rims.length; i++) {
      const r = this.rims[i], u = r.m.material.uniforms;
      if (!frozen) r.t += rdt;
      const k = r.t >= r.life || !r.e.alive ? 0 : Math.sin(Math.PI * Math.min(1, r.t / r.life * 0.8 + 0.2));
      r.m.visible = k > 0.01;
      u.uK.value = k * 0.32; u.uTime.value = this.now; u.uFloor.value = r.e.position.y + 0.25; u.uPush.value = 0.03;
    }
  },

  // ------------------------------------------------------------------ the arena (crowd gallery + render budget)
  /** a fight is a closed ring: ask the crowd for a gallery of onlookers and the heavy systems for a combat budget.
   *  Both are optional interfaces (docs/reports/combat.md, integration requests); released on combat:end. */
  arena(on) {
    const engine = this.engine, p = engine.player;
    if (on && this._arenaOn) return;
    if (!on && !this._arenaOn) return;
    this._arenaOn = !!on;
    const crowd = engine.get('crowd'), props = engine.get('props');
    let centre = null;
    if (on && p) {
      centre = p.position.clone();
      const foes = ((engine.get('enemy') || {}).list || []).filter(e => e.alive && e.aggro);
      for (const e of foes) centre.add(e.position);
      centre.multiplyScalar(1 / (1 + foes.length)); centre.y = p.position.y;
    }
    try {
      if (crowd && typeof crowd.gawk === 'function') { if (on) crowd.gawk(centre, 8.5, 18); else if (crowd.releaseGawk) crowd.releaseGawk(); }
      const budget = on ? { centre, radius: 60, lod0: 6, lodScale: 0.7 } : null;
      if (crowd && typeof crowd.setCombatBudget === 'function') crowd.setCombatBudget(budget);
      if (props && typeof props.setCombatBudget === 'function') props.setCombatBudget(budget);
    } catch (err) { console.warn('[combat] arena request failed', err); }
    engine.events.emit('combat:arena', { on: !!on, centre, radius: 8.5, budgetRadius: 60 });
  },

  /** enemies decide to block on their own (the player's guard is an input flag) */
  rollGuard(target, att, def) {
    if (def.grab || def.held || def.dmg >= 40 || def.guard >= 999) return false;
    if (target.guardBroken > 0) return false;
    if (target.isPlayer) {
      if (!(target.guard || target.state === 'guard')) return false;
      return target.forward(_a).dot(_b.set(att.position.x - target.position.x, 0, att.position.z - target.position.z).normalize()) > 0.25;
    }
    if (target.state === 'down' || target.state === 'getup' || target.state === 'dead' || !target.alive) return false;
    if (target.guardT > 0) { target.humanoid.play('guard_hit', { loop: false, force: true }); return true; }
    if (target.state === 'hit' || target.state === 'attack') return false;
    const p = BLOCK_CHANCE[target.type] != null ? BLOCK_CHANCE[target.type] : 0.16;
    const roll = typeof this.rng === 'function' ? this.rng() : Math.random();
    if (roll >= p) return false;
    target.yaw = Math.atan2(att.position.x - target.position.x, att.position.z - target.position.z);
    target.group.rotation.y = target.yaw;
    return true;
  },

  guardBreak(target, att, point, dir) {
    const engine = this.engine, cam = engine.get('camera'), hud = engine.get('hud');
    target.guardMeter = 0;
    target.guardBroken = 1.7;
    target.guardT = 0;
    target.setState('hit');
    target.stateT = -1.0;                                            // hold the stagger ~1.4 s
    target.humanoid.play('stumble', { loop: false, force: true });
    target.velocity.copy(dir).multiplyScalar(0.9 * DAMP);
    this.vfx.quad('ring', point.x, point.y, point.z, { life: 0.42, s0: 0.3, s1: 2.4, r: 1.1, g: 1.7, b: 2.4, pow: 1.5 });
    this.vfx.quad('flash', point.x, point.y, point.z, { life: 0.18, s0: 0.3, s1: 1.2, r: 1.4, g: 2.0, b: 2.7, pow: 2.0 });
    this.vfx.spark(point.x, point.y, point.z, 34, { spread: 6, life: 0.5, r: 1.3, g: 2.1, b: 3.0 });
    for (let i = 0; i < 8; i++) this.vfx.quad('streak', point.x, point.y, point.z, { life: 0.12, s0: 0.3, s1: 1.0, aspect: 0.05, roll: i / 8 * 6.283, out: 0.8, r: 1.2, g: 1.7, b: 2.4, pow: 1.5, drag: 0 });
    this.hitStop(100);
    if (cam && cam.shake) cam.shake(0.5, 0.35);
    if (hud && hud.stamp && att && att.isPlayer) hud.stamp('崩');
    engine.events.emit('combat:guardbreak', { target, attacker: att });
  },

  // ------------------------------------------------------------------ grab → knee / throw
  beginHold(att, target) {
    const engine = this.engine;
    if (this.hold) return;
    this.hold = { att, target, t: 0, knees: 0, busy: 0 };
    target.setState('hit'); target.stateT = 0;
    target.velocity.set(0, 0, 0);
    target.guardT = 0;
    target.humanoid.play('stumble', { loop: false, force: true });
    att.humanoid.play('grab', { loop: false, force: true });
    // pseudo-attack so player.js keeps the character in its attack state while we drive it
    this.active.push({ attacker: att, name: 'grab_hold', def: { hold: true, ...ATTACKS.grab }, t: 0, rate: 1, duration: 99, hits: [], done: new Set(), prev: new THREE.Vector3(), prevOk: false, landed: true, cancelAt: 99 });
    if (engine.get('hud')) engine.get('hud').combo((att.combo = (att.combo || 0) + 1));
    att.comboT = COMBO_HOLD;
    engine.events.emit('combat:grab', { attacker: att, target });
  },

  updateHold(dt) {
    const H = this.hold; if (!H) return;
    const engine = this.engine, att = H.att, t = H.target;
    if (!att.alive || !t.alive) { this.releaseHold(true); return; }
    H.t += dt;
    if (H.busy > 0) { H.busy -= dt; if (H.busy <= 0 && att.humanoid.currentName !== 'grab') att.humanoid.play('grab', { fade: 0.1, force: true }); }
    // pin the victim in front, facing the attacker
    att.forward(_a);
    t.position.x = att.position.x + _a.x * 0.78;
    t.position.z = att.position.z + _a.z * 0.78;
    t.position.y = att.position.y;
    t.yaw = att.yaw + Math.PI;
    t.group.rotation.y = t.yaw;
    t.velocity.set(0, 0, 0);
    t.setState('hit'); t.stateT = -0.15;
    if (att.isPlayer && engine.state.mode !== 'cutscene') {
      const b = engine.input.buttons;
      if (b.attack.pressed) { this.doKnee(); return; }
      if (b.heavy.pressed || b.grab.pressed) { this.doThrow(); return; }
      if (b.dodge.pressed) { this.releaseHold(false); return; }
      if (b.heat.pressed) { const ha = engine.get('heatActions'); if (ha && ha.available && ha.available(att)) { this.releaseHold(true); ha.trigger(att); return; } }
    }
    if (H.t > HOLD_MAX) this.doThrow();
  },

  doKnee() {
    const H = this.hold; if (!H || H.busy > 0) return;
    H.knees++;
    H.busy = 0.36;
    const def = ATTACKS.knee;
    const kc = this.kneeClip();
    if (kc) playClip(H.att.humanoid, kc, { fade: 0.05, speed: 1.2 });
    else H.att.humanoid.play('uppercut', { loop: false, fade: 0.05, force: true });
    // the knee lands on the clip's contact frame, not on the press
    this.later(0.13, () => {
      if (this.hold !== H) return;
      H.target.humanoid.play('hit_heavy', { loop: false, force: true });
      H.att.forward(_a);
      const point = new THREE.Vector3(H.target.position.x - _a.x * 0.25, H.target.position.y + 1.02, H.target.position.z - _a.z * 0.25);
      this.applyHit(H.att, H.target, def, 'knee', null, { noReact: true, point, dir: _a.clone(), deferKo: true });
      H.target.setState('hit'); H.target.stateT = -0.15;
      if (H.knees >= 3 || H.target.hp <= 0) this.later(0.18, () => { if (this.hold === H) this.doThrow(); });
    });
  },

  /** a knee strike authored from the grab and the chambered knee of heat_finisher (no knee clip in the library) */
  kneeClip() {
    if (this._knee !== undefined) return this._knee;
    this._knee = null;
    try {
      const A = this.anim;
      if (!A || !A.makeClip || !A.getFrames) return null;
      const grab = poseOf(A, 'grab', 1), knee = poseOf(A, 'heat_finisher', 0.24 / 1.6);
      if (!grab || !knee) return null;
      const up = { ...grab };
      for (const k of ['RightUpLeg', 'RightLeg', 'RightFoot']) up[k] = knee[k];
      delete up.ikR;
      up.Hips = add3(grab.Hips, [-6, 0, 0]); up.Spine = add3(grab.Spine, [10, 0, 0]); up.hips = add3(grab.hips, [0, 0.02, 0.04]);
      this._knee = A.makeClip('cx_knee', [{ t: 0, pose: grab }, { t: 0.14, pose: up }, { t: 0.2, pose: up }, { t: 0.42, pose: grab }], { events: [{ time: 0.14, name: 'hit', bone: 'RightLeg', radius: 0.3 }] });
    } catch (err) { console.warn('[combat] knee clip', err); }
    return this._knee;
  },

  doThrow() {
    const H = this.hold; if (!H) return;
    const engine = this.engine, att = H.att, t = H.target;
    const def = ATTACKS.throw;
    this.releaseHold(true, true);
    att.humanoid.play('throw', { loop: false, fade: 0.05, force: true });
    this.active.push({ attacker: att, name: 'throw_anim', def: { ...def, noHit: true }, t: 0, rate: 1, duration: 0.9, hits: [], done: new Set(), prev: new THREE.Vector3(), prevOk: false, landed: true, cancelAt: 0.62, locked: false });
    // the victim leaves the hands on the throw's release frame
    this.later(0.36, () => {
      if (!t.alive) return;
      att.forward(_a);
      const dir = _a.clone().applyAxisAngle(_up, -0.5);
      t.yaw = Math.atan2(-dir.x, -dir.z); t.group.rotation.y = t.yaw;
      this.applyHit(att, t, def, 'throw', null, { dir, point: new THREE.Vector3(t.position.x, t.position.y + 1.0, t.position.z) });
      engine.events.emit('combat:throw', { attacker: att, target: t });
    });
  },

  releaseHold(silent, throwing = false) {
    const H = this.hold; if (!H) return;
    this.hold = null;
    const i = this.active.findIndex(a => a.name === 'grab_hold');
    if (i >= 0) this.active.splice(i, 1);
    if (H.target && H.target.alive && !silent) { H.target.setState('hit'); H.target.stateT = 0; }
    if (!throwing && H.target && H.target.hp <= 0 && H.target.alive) this.knockOut(H.target, H.att, H.target.position);
  },

  // ------------------------------------------------------------------ weapons (dynamic props tagged 'weapon')
  WEAPON_GRIP: {
    bike:   { pos: [0.02, 0.10, 0.02], rot: [0.0, 0.0, 1.45], scale: 1.0, dmg: 1.25, uses: 5 },
    aframe: { pos: [0.02, 0.12, -0.02], rot: [0.0, 0.0, 1.50], scale: 1.0, dmg: 1.10, uses: 4 },
    trash:  { pos: [0.00, 0.20, 0.00], rot: [0.0, 0.0, 1.40], scale: 1.0, dmg: 1.00, uses: 4 },
    cone:   { pos: [0.00, 0.10, 0.00], rot: [3.14, 0.0, 0.0], scale: 1.0, dmg: 0.75, uses: 6 },
  },

  nearestWeapon(position, radius, type = null) {
    const props = this.engine.get('props');
    let best = null, bd = radius;
    for (const d of (props && props.dynamics) || []) {
      if (d.taken || (type && d.type !== type)) continue;
      const q = Math.hypot(d.body.position.x - position.x, d.body.position.z - position.z);
      if (q < bd) { bd = q; best = d; }
    }
    return best;
  },

  pickUp(entity, radius = 2.4) {
    const engine = this.engine, props = engine.get('props');
    if (!props || !props.takeProp || entity.weapon) return false;
    const near = this.nearestWeapon(entity.position, radius);
    if (!near) return false;
    const mesh = fixHeldProp(props.takeProp(near.body));
    if (!mesh) return false;
    const ha = engine.get('heatActions');
    if (near.type === 'bike' && ha && ha.dressWrap) ha.dressWrap(mesh);    // in hand it is a close-up prop: the hero bicycle
    const grip = this.WEAPON_GRIP[near.type] || this.WEAPON_GRIP.cone;
    const wrap = new THREE.Group();
    wrap.add(mesh);
    mesh.position.set(0, 0, 0);
    wrap.position.fromArray(grip.pos);
    wrap.rotation.fromArray(grip.rot);
    wrap.scale.setScalar(grip.scale);
    entity.yaw = Math.atan2(near.body.position.x - entity.position.x, near.body.position.z - entity.position.z);
    entity.group.rotation.y = entity.yaw;
    entity.humanoid.setWeapon(wrap);
    entity.weapon = { body: near.body, type: near.type, mesh: wrap, uses: grip.uses, dmg: grip.dmg };
    if (entity.humanoid.dropProp) entity.humanoid.dropProp(engine.scene);
    // a short reach-and-lift so the prop does not just blink into the hand
    this.start(entity, 'pickup', { clip: 'grab', noHit: true, rate: 1.6, held: true });
    if (entity.setState) entity.setState('attack');
    engine.events.emit('combat:weapon', { entity, type: near.type, action: 'pickup' });
    return true;
  },

  dropWeapon(entity, velocity, spin) {
    const engine = this.engine, props = engine.get('props'), w = entity.weapon;
    if (!w) return false;
    entity.humanoid.setWeapon(null);
    entity.weapon = null;
    entity.humanoid.boneWorld('RightHand', _a);
    _a.y = Math.max(_a.y, (engine.world ? engine.world.groundHeight(_a.x, _a.z) : 0) + 0.35);
    if (props && props.releaseProp) props.releaseProp(w.body, _a, velocity || _b.set(0, 0.6, 0));
    if (spin && w.body.angularVelocity) w.body.angularVelocity.copy(spin);
    engine.events.emit('combat:weapon', { entity, type: w.type, action: velocity ? 'throw' : 'drop' });
    engine.events.emit('prop:impact', { point: _a.clone(), strength: velocity ? 1.6 : 0.5, type: w.type });
    return true;
  },

  throwWeapon(entity) {
    const w = entity.weapon; if (!w) return false;
    const engine = this.engine;
    const fwd = entity.forward(_c).clone();
    let hit = null, bestD = 14;
    for (const t of this.entities) {
      if (t === entity || !t.alive || t.kind === entity.kind) continue;
      const to = _d.set(t.position.x - entity.position.x, 0, t.position.z - entity.position.z);
      const dist = to.length(); if (dist > bestD) continue;
      if (fwd.dot(to.normalize()) < 0.72) continue;
      bestD = dist; hit = t;
    }
    if (hit) { entity.yaw = Math.atan2(hit.position.x - entity.position.x, hit.position.z - entity.position.z); entity.group.rotation.y = entity.yaw; entity.forward(fwd); }
    this.start(entity, 'w_throw_anim', { ...ATTACKS.w_throw, clip: 'throw', noHit: true });
    // it leaves the hand on the release frame and lands a little later, scaled by the distance
    this.later(0.34, () => {
      if (entity.weapon !== w) return;
      const vel = fwd.clone().multiplyScalar(12).setY(2.6);
      this.dropWeapon(entity, vel, new THREE.Vector3(2, 9, 3));
      if (hit && hit.alive) this.later(Math.min(0.5, bestD / 12), () => { if (hit.alive) this.applyHit(entity, hit, ATTACKS.w_throw, 'w_throw', null, { dir: fwd }); });
    });
    return true;
  },

  wearWeapon(entity, landed) {
    const w = entity.weapon; if (!w || !landed) return;
    w.uses--;
    if (w.uses > 0) return;
    // it breaks: spit it out with a spin and a burst
    entity.humanoid.boneWorld('RightHand', _a);
    const v = entity.forward(_c).clone().multiplyScalar(4).setY(2.4);
    this.dropWeapon(entity, v, new THREE.Vector3(6, 3, 8));
    this.vfx.metal(_a.clone(), v.clone().normalize(), 0.7);
    this.engine.events.emit('combat:weapon', { entity, type: w.type, action: 'break' });
  },

  /** a weapon swing also scatters loose street props it passes through */
  swingProps(att, point, def) {
    const engine = this.engine, world = engine.world;
    if (!world || !world.overlapSphere) return;
    const hits = world.overlapSphere(point, 1.1, { tags: ['dynamic'] });
    for (const h of hits) {
      if (!h.body || h.body === (att.weapon && att.weapon.body)) continue;
      att.forward(_d);
      h.body.velocity.set(_d.x * 6 + (Math.random() - 0.5) * 2, 4 + Math.random() * 2, _d.z * 6 + (Math.random() - 0.5) * 2);
      h.body.sleeping = false;
      if (h.body.angularVelocity) h.body.angularVelocity.set(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4);
      engine.events.emit('prop:impact', { point: h.point.clone(), strength: 1.2, type: h.body.type });
    }
  },

  /** a fight should have something to pick up: if no bicycle is within reach of the brawl, wheel the nearest idle
   *  one in and park it at the edge of the ring (props has 14 dynamic bikes city-wide; none sit at ハチ公前) */
  dressArena() {
    const engine = this.engine, props = engine.get('props'), p = engine.player;
    if (!props || !props.takeProp || !props.releaseProp || !p) return;
    if (this.nearestWeapon(p.position, 11, 'bike')) return;
    const bike = this.nearestWeapon(p.position, 400, 'bike');
    if (!bike || !bike.body.sleeping) return;
    const en = engine.get('enemy'), foes = ((en && en.list) || []).filter(e => e.alive);
    let best = null, bs = -Infinity;
    for (let k = 0; k < 24; k++) {
      const a = k / 24 * Math.PI * 2, r = 3.4 + (k % 3) * 0.9;
      const x = p.position.x + Math.sin(a) * r, z = p.position.z + Math.cos(a) * r;
      const c = this.clearance(x, z);
      if (c < 0.9) continue;
      let foe = 9;
      for (const e of foes) foe = Math.min(foe, Math.hypot(e.position.x - x, e.position.z - z));
      if (foe < 2.0) continue;
      const score = Math.min(c, 3) + Math.min(foe, 5) * 0.4 - Math.abs(r - 4) * 0.3;
      if (score > bs) { bs = score; best = { x, z, a }; }
    }
    if (!best) return;
    props.takeProp(bike.body);
    const y = (engine.world ? engine.world.groundHeight(best.x, best.z) : 0) + (bike.body.restY || 0.34);
    if (bike.body.mesh) { bike.body.mesh.rotation.set(0, best.a + Math.PI / 2 + 0.3, 0.06); }
    props.releaseProp(bike.body, new THREE.Vector3(best.x, y, best.z), null);
    console.info(`[combat] arena: parked a bicycle at ${best.x.toFixed(1)},${best.z.toFixed(1)}`);
  },

  // ------------------------------------------------------------------ staged screenshots
  /** clearance from statics, street furniture and parked cars — staged fights need open asphalt */
  clearance(x, z) {
    const engine = this.engine, world = engine.world, traffic = engine.get('traffic');
    let d = 40;
    if (world && world.overlapSphere) {
      for (const h of world.overlapSphere(_a.set(x, 1.1, z), 6.0, {})) {
        if (h.tag === 'ground' || h.tag === 'bounds' || h.tag === 'dynamic') continue;
        d = Math.min(d, h.distance);
      }
    }
    for (const c of (traffic && traffic.cars) || []) {
      if (c.far) continue;
      d = Math.min(d, Math.hypot(c.x - x, c.z - z) - Math.max(1.0, (c.l || 4) * 0.45));
    }
    return d;
  },

  /** ?shot=final_blow&t=<s> (also ?shot=cam_ko&kok=<0..1>): the final blow is PLAYED, not posed. The staged fight is
   *  left unposed, the last man stands in front of 健人 on 1 HP, the gameplay rig settles live, the real finisher is
   *  thrown through the press path, and the whole game freezes when the sequence reaches t (real seconds from the
   *  contact). &fbmove=<attack> picks the blow (default fin_upper; jab / hook / kick / fin_round ...). */
  prepFinaleStill(engine, at = null) {
    const raw = (engine.params && engine.params.raw) || {};
    const num = (v) => (v != null && v !== '' && isFinite(Number(v)) ? Number(v) : null);
    let t = at != null ? at : num(raw.fbt) ?? num(raw.t);
    if (t == null && num(raw.kok) != null) t = num(raw.kok) * fbEnd();
    this.finaleStillAt = Math.max(0, t == null ? 0.6 : t);
    this.finaleMove = raw.fbmove || 'fin_upper';
    this.stage = null;                                     // no posed tableau
    engine.events.on('engine:booted', () => { try { this.stageFinale(); } catch (err) { console.warn('[combat] final blow stage failed', err); } });
  },
  stageFinale() {
    const engine = this.engine, p = engine.player, en = engine.get('enemy'), cam = engine.get('camera'), hud = engine.get('hud');
    const list = ((en && en.list) || []).filter(e => e.alive);
    if (!p || !list.length) { console.warn('[combat] final blow still: no fight to stage'); return; }
    const raw = (engine.params && engine.params.raw) || {};
    engine.state.frozen = false; engine.state.mode = 'combat';
    const base = this.stageBase ? this.stageBase.base.clone() : p.position.clone();
    const yaw = (this.stageBase ? this.stageBase.yaw : p.yaw) + (raw.fbyaw != null && isFinite(Number(raw.fbyaw)) ? Number(raw.fbyaw) : 0);
    const gy = (x, z) => (engine.world ? engine.world.groundHeight(x, z) : 0);
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    p.position.set(base.x, gy(base.x, base.z), base.z); p.velocity.set(0, 0, 0);
    p.yaw = yaw; p.group.rotation.y = yaw; p.setState('idle'); p.hp = p.hpMax || 100; p.heat = 40;
    p.humanoid.play('idle_combat', { fade: 0, force: true });
    const v = list[0];
    const q = base.clone().addScaledVector(fwd, 1.15);
    v.position.set(q.x, gy(q.x, q.z), q.z); v.velocity.set(0, 0, 0);
    v.yaw = yaw + Math.PI; v.group.rotation.y = v.yaw;
    v.aggro = true; v.hp = 1; v.cooldown = 99; v.guardT = 0; v.guardMeter = 0; v.guardBroken = 0;
    if (v.setState) v.setState('idle');
    v.humanoid.frozenPose = false;
    // the first two are down where the fight put them
    list.slice(1).forEach((e, i) => {
      const s = base.clone().addScaledVector(fwd, i ? 4.4 : -2.0).addScaledVector(right, i ? 2.6 : -2.6);
      e.position.set(s.x, gy(s.x, s.z), s.z); e.velocity.set(0, 0, 0);
      e.yaw = yaw + (i ? 2.2 : -2.4); e.group.rotation.y = e.yaw;
      e.hp = 0; e.alive = false; e.aggro = false; e.deadT = 0; e.deadClip = true; e.seen = 'dead';
      if (e.setState) e.setState('dead');
      this.poseHard(e.humanoid, 'knockdown', 0.99);
      if (hud && hud.hideEnemy) hud.hideEnemy(e);
    });
    this.rng = () => 0.99;                                 // the killing blow is not blocked
    this.vfx.clear();
    if (cam) { if (cam.resetRig) cam.resetRig(); cam.combat = true; cam.setFollow(p); }
    this._fbStage = { wait: 0.9, move: this.finaleMove, victim: v, at: v.position.clone(), yaw: v.yaw };
    console.info(`[combat] final blow still: ${this.finaleMove} on the last man, held at t=${this.finaleStillAt} s`);
  },
  /** throw a named blow through the player's press path (the rush string is set so the button yields that move) */
  throwFinisher(p, name) {
    if (!p) return false;
    const R = this.rush;
    if (RUSH.includes(name)) { R.stage = RUSH.indexOf(name); R.idle = 0; return this.startPlayer(p, 'light'); }
    const fi = FINISH.indexOf(name);
    if (fi >= 0) { R.stage = fi; R.idle = 0; return this.startPlayer(p, 'heavy'); }
    return ATTACKS[name] ? this.start(p, name, ATTACKS[name]) : false;
  },

  placeStage() {
    const engine = this.engine, p = engine.player, en = engine.get('enemy');
    if (!p) return;
    // an open, photogenic patch of the crossing: 109 and the Center-gai neon fill the background
    let base = new THREE.Vector3(6, 0, 14), yaw = -2.05, bestScore = -1;
    for (let gx = -14; gx <= 14; gx += 3.5) {
      for (let gz = -4; gz <= 20; gz += 3.5) {
        const c = this.clearance(gx, gz);
        if (c < 4.2) continue;
        const bx = gx - Math.sin(yaw) * -3.6, bz = gz - Math.cos(yaw) * -3.6;
        const cb = this.clearance(bx, bz);
        const score = Math.min(c, cb) - Math.hypot(gx - 2, gz - 10) * 0.10;
        if (score > bestScore) { bestScore = score; base.set(gx, 0, gz); }
      }
    }
    p.position.set(base.x, engine.world ? engine.world.groundHeight(base.x, base.z) : 0, base.z);
    p.yaw = yaw; p.group.rotation.y = yaw;
    p.setState('attack');
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    const list = (en && en.list) || [];
    const spots = [
      { o: fwd.clone().multiplyScalar(1.02).addScaledVector(right, -0.12), face: Math.PI },
      { o: fwd.clone().multiplyScalar(2.4).addScaledVector(right, -3.0), face: Math.PI * 0.62 },
      { o: fwd.clone().multiplyScalar(3.3).addScaledVector(right, 1.55), face: Math.PI * 1.1 },
    ];
    this.stageEnemies = [];
    for (let i = 0; i < Math.min(3, list.length); i++) {
      const e = list[i], s = spots[i];
      e.position.set(base.x + s.o.x, 0, base.z + s.o.z);
      e.position.y = engine.world ? engine.world.groundHeight(e.position.x, e.position.z) : 0;
      e.yaw = yaw + s.face; e.group.rotation.y = e.yaw;
      e.aggro = true;
      this.stageEnemies.push(e);
    }
    this.stageBase = { base, yaw, fwd, right };
    const ha = engine.get('heatActions');
    if (this.stage === 'heat' && ha && ha.placeStage) ha.placeStage(engine, this.stageBase);
  },

  /** a staged pose must be the ONLY action on the mixer at full weight: play()'s zero-length fade leaves the weight
   *  at 0 under mixer.update(0), which is why the downed man used to stand in his bind pose */
  poseHard(h, name, phase, clip = null) {
    if (!h) return;
    try { h.mixer.stopAllAction(); } catch (err) { /* no mixer */ }
    h.currentAction = null; h.currentName = null; h.frozenPose = false;
    const c = clip || (this.getClip ? this.getClip(name) : null);
    if (!c) return;
    const A = h.mixer.clipAction(c);
    A.reset(); A.setLoop(THREE.LoopRepeat, Infinity); A.enabled = true;
    A.stopFading(); A.setEffectiveTimeScale(1); A.setEffectiveWeight(1); A.play();
    A.time = clamp(phase, 0, 0.999) * c.duration;
    h.mixer.update(0);
    h.currentAction = A; h.currentName = c.name; h.frozenPose = true;
    h.group.updateMatrixWorld(true);
  },

  applyStage() {
    const engine = this.engine, p = engine.player, hud = engine.get('hud'), cam = engine.get('camera');
    if (!this.stage || !p) return;
    this.arena(true);                                                  // shots set the mode directly: no combat:start
    if (this.stage === 'heat') { const ha = engine.get('heatActions'); if (ha && ha.applyStage && ha.applyStage()) return; }
    if (!this.stageBase) return;
    const { base, yaw, fwd, right } = this.stageBase;
    const list = this.stageEnemies || [];
    const params = engine.params || {};
    const posed = params.anim;
    const weapon = this.stage === 'weapon';

    // the player: the staged hook at its contact frame, or whatever the critic asked for with ?anim=&phase=
    let clipName = weapon ? 'uppercut' : 'hook', phase = weapon ? 0.52 : 0.54;
    if (posed) { clipName = posed; phase = params.phase || 0; }
    if (weapon) { this.stageWeapon(p); }
    // my presets and the ?anim= view frame the pair themselves; the plain brawl is framed by camera.js's live rig,
    // with him turned far enough (0.6 rad) that the hooked man's jaw clears his shoulder for that lens
    const dyaw = params.raw && params.raw.pyaw != null && params.raw.pyaw !== '' ? Number(params.raw.pyaw) : -0.6;   // &pyaw= debug
    const pyaw = yaw + (this.stageView || posed ? 0 : dyaw);
    p.yaw = pyaw; p.group.rotation.y = pyaw;
    const pf = new THREE.Vector3(Math.sin(pyaw), 0, Math.cos(pyaw));
    this.poseHard(p.humanoid, clipName, phase);
    p.setState('attack');
    p.hp = 76; p.heat = params.raw && params.raw.pheat ? Number(params.raw.pheat) : 62;       // &pheat= debug (aura)

    // put the first man exactly where the blow lands: the striking bone of the posed clip, 0.3 m inside his capsule
    const a = list[0], b = list[1], c = list[2];
    const clip = this.getClip ? this.getClip(clipName) : null;
    const ev = clip && clip.userData && (clip.userData.events || []).find(e => e.name === 'hit');
    const bone = ev && ev.bone ? ev.bone : 'RightHand';
    const def = ATTACKS[clipName] || null;
    const strike = new THREE.Vector3();
    p.humanoid.boneWorld(bone, strike);
    let hitPt = strike.clone();
    const blow = this.blowDir(p, pf, weapon ? ATTACKS.w_heavy : def, new THREE.Vector3());
    const foot = /Foot|Leg|ToeBase/.test(bone);
    const along = (v) => (v.x - base.x) * pf.x + (v.z - base.z) * pf.z;
    if (a) {
      const reach = Math.max(0.55, Math.hypot(strike.x - base.x, strike.z - base.z) + (weapon ? -0.2 : 0.12));
      a.position.set(base.x + pf.x * reach, 0, base.z + pf.z * reach);
      a.position.y = engine.world ? engine.world.groundHeight(a.position.x, a.position.z) : 0;
      a.yaw = pyaw + Math.PI; a.group.rotation.y = a.yaw;
      a.setState('hit'); a.hp = Math.round(a.hpMax * 0.3);
      // his reaction comes from where the posed blow lands: a foot/leg means the belly (くの字), a fist the head
      if (!foot) {
        hitPt = this.contactPoint(p, a, null, new THREE.Vector3());
        hitPt.lerp(strike, 0.35); hitPt.y = clamp(strike.y, a.position.y + 0.8, a.position.y + 1.62);
      }
      const react = weapon ? 'stumble' : foot ? 'cx_hit_body'
        : this.reaction(a, hitPt.y - a.position.y > 1.45 ? hitPt : _v.copy(hitPt).setY(a.position.y + 1.5), blow, def || ATTACKS.hook);
      // くの字 at its deepest fold (the head comes forward over the knee); a head snap a few frames in
      const rp = react === 'cx_hit_body' ? 0.27 : react.startsWith('cx_hit_head') ? 0.085 : weapon ? 0.14 : 0.13;
      this.playReact(a, react, rp);
      if (a.humanoid.plant) a.humanoid.plant();
      // a kick/knee: he stands where the posed limb actually is, 10 cm clear of it, never with the thigh in his torso
      if (foot) hitPt = this.fitToLimb(p, a, bone, pf, along);
      const f = this.flinch(a, foot ? _v.copy(hitPt).setY(a.position.y + 1.1) : _v.copy(hitPt).setY(Math.max(hitPt.y, a.position.y + 1.5)), blow, weapon ? ATTACKS.w_heavy : def || ATTACKS.hook);
      if (f) { this.applyFlinch(f, f.amp * Math.exp(-0.03 / 0.12)); a.group.updateMatrixWorld(true); }
      this.stageReact = react;
    }
    if (posed) {                                                      // side view from his right: the other two stay upstage
      const put = (e, f, r) => { e.position.set(base.x + fwd.x * f + right.x * r, 0, base.z + fwd.z * f + right.z * r); e.position.y = engine.world ? engine.world.groundHeight(e.position.x, e.position.z) : 0; };
      if (b) put(b, 2.9, -2.6);
      if (c) put(c, 3.4, -1.3);
    }
    if (b) { b.setState('down'); b.hp = Math.round(b.hpMax * 0.1); this.poseHard(b.humanoid, 'knockdown', 0.72); }
    this.vfx.clear();
    if (c) {                                                          // the next man in, chambering a hook
      c.setState('attack'); c.hp = c.hpMax;
      c.yaw = Math.atan2(p.position.x - c.position.x, p.position.z - c.position.z); c.group.rotation.y = c.yaw;
      this.poseHard(c.humanoid, 'hook', 0.24); if (c.humanoid.plant) c.humanoid.plant();
    }

    const view = this.stageView;
    if (cam && cam.setFixed) {
      let pos, look, fov;
      if (view === 'wide') {
        look = new THREE.Vector3(base.x + fwd.x * 1.4, 1.0, base.z + fwd.z * 1.4);
        pos = new THREE.Vector3(base.x, 2.9, base.z).addScaledVector(right, 4.2).addScaledVector(fwd, -4.0);
        fov = 42;
      } else if (view) {
        look = new THREE.Vector3(base.x + fwd.x * 0.75, 1.2, base.z + fwd.z * 0.75);
        pos = new THREE.Vector3(base.x, 1.45, base.z).addScaledVector(right, 2.3).addScaledVector(fwd, -1.2);
        fov = 38;
      } else if (posed) {
        // front 3/4 from the striking limb's side at hip height: the drive of the leg and the folded face both read
        const side = /^Left/.test(bone) ? -1 : 1;
        look = hitPt.clone().lerp(a ? a.humanoid.boneWorld('Head', new THREE.Vector3()) : hitPt, 0.35);
        look.y = clamp(look.y, base.y + 0.95, base.y + 1.3);
        let F = 0.8, Y = 0.7, Rr = 3.0;
        if (params.raw && params.raw.acam) { const v = String(params.raw.acam).split(',').map(Number); if (v.length >= 2 && v.every(isFinite)) { [F, Y] = v; if (v[2]) Rr = v[2]; } }   // &acam=F,Y[,R] debug
        pos = new THREE.Vector3(base.x, base.y + Y, base.z).addScaledVector(right, Rr * side).addScaledVector(fwd, F);
        pos = this.clearLens(pos, look);
        fov = 38;
      } else {
        // gameplay framing: 3/4 behind, high enough to read the whole ring and his feet
        look = new THREE.Vector3(base.x, base.y + 1.05, base.z).addScaledVector(fwd, 1.5).addScaledVector(right, 0.35);
        pos = new THREE.Vector3(base.x, base.y + 2.2, base.z).addScaledVector(fwd, -3.3).addScaledVector(right, 3.1);
        fov = 42;
      }
      cam.setFixed(pos, look, { fov });
      engine.camera.updateMatrixWorld(true);
    }

    // frozen VFX, spawned only now that the lens is set: the burst 50 ms after contact (the 40 ms core has already
    // gone, so shards and sparks frame the snapped head), then the third man's wind-up glint and red rim
    if (weapon) this.vfx.metal(hitPt, blow.clone(), 0.8); else this.vfx.impact(hitPt, blow.clone(), { scale: 1.1, heavy: true });
    this.vfx.advance(0.05, 5);
    if (c) {
      this.vfx.telegraph(c.humanoid, 'RightHand');
      this.rim(c, 0.4);
      const r = this.rims.find(x => x.e === c); if (r) r.t = 0.15;
      this.vfx.advance(0.012, 1);
    }
    // the screen answers the blow: flash + a radial kick centred on the contact point, held for the still
    const pfx = engine.get('postfx');
    if (pfx && a) {
      if (pfx.onHit) pfx.onHit({ target: { position: new THREE.Vector3(hitPt.x, hitPt.y - 1.1, hitPt.z) }, heavy: true, point: hitPt });
      pfx.hold = { flash: 0.1, radial: 0.35, heat: p.heat / 100 };
    }

    if (hud) {
      const combo = weapon ? 5 : 9;
      hud.combo(combo);
      hud.objective('チンピラを倒せ');
      for (const e of list) if (e && e.alive) hud.showEnemy(e);
      // the number rises off the contact itself; a finisher-class blow gets the big orange-red style
      const dmg = weapon ? ATTACKS.w_heavy.dmg : (ATTACKS[clipName] || ATTACKS.hook).dmg;
      const at = new THREE.Vector3(hitPt.x, hitPt.y + 0.35, hitPt.z);
      const beat = () => {
        if (!hud.el) return;
        hud.combo(combo);
        hud.damage(at, dmg, true);
        const el = hud.root && hud.root.lastElementChild;
        if (el && el.classList.contains('dmg') && dmg >= 30) el.classList.add('cx-fin');
      };
      beat();
      this._stageTimer = setInterval(beat, 700);
    }
    console.info(`[combat] staged "${this.stage}" — ${list.length} enemies, reaction ${this.stageReact || '-'}, vfx ${this.vfx.nQuads} quads / ${this.vfx.nSparks} sparks` + (this.stageGap != null ? `, leg-torso clearance ${this.stageGap} m` : '') +
      `, aura ${this.aura ? (this.aura.geometry.index ? this.aura.geometry.index.count / 3 : 0) : 0} tris, rims ${this.rims.map(r => r.m.geometry.index ? r.m.geometry.index.count / 3 : 0).join('+') || 0} tris`);
  },

  /** a posed kick/knee still: whichever part of the leg leads (knee or foot) sits 10 cm off the man's belly, and no
   *  capsule of the leg (thigh r 8.5 cm, shin r 7 cm) may touch his torso (Hips -> Spine2, r 15 cm). He is slid along
   *  the line of the blow until both hold. Returns the contact point (the leading part). */
  fitToLimb(p, a, bone, pf, along) {
    const side = /^Left/.test(bone) ? 'Left' : 'Right';
    const H = p.humanoid, Vh = a.humanoid;
    const hip = H.boneWorld(side + 'UpLeg', new THREE.Vector3()), knee = H.boneWorld(side + 'Leg', new THREE.Vector3());
    const ankle = H.boneWorld(side + 'Foot', new THREE.Vector3()), toe = H.boneWorld(side + 'ToeBase', new THREE.Vector3());
    let lead = knee;
    for (const q of [ankle, toe]) if (along(q) > along(lead) + 0.02) lead = q;
    const t0 = new THREE.Vector3(), t1 = new THREE.Vector3(), belly = new THREE.Vector3();
    let gap = 0;
    for (let it = 0; it < 8; it++) {
      a.group.updateMatrixWorld(true);
      Vh.boneWorld('Hips', t0); Vh.boneWorld('Spine2', t1); Vh.boneWorld('Spine1', belly);
      const clear = Math.min(Math.sqrt(segSegDist2(hip, knee, t0, t1)) - 0.235, Math.sqrt(segSegDist2(knee, ankle, t0, t1)) - 0.22);
      let need = along(lead) + 0.3 - along(belly);                      // 10 cm clearance + limb + belly depth
      if (clear < 0.02) need = Math.max(need, 0.02 - clear + 0.01);
      gap = clear;
      if (Math.abs(need) < 0.004) break;
      a.position.addScaledVector(pf, need);
    }
    a.group.updateMatrixWorld(true);
    if (gap < 0) console.warn(`[combat] staged kick: leg still ${(-gap * 100).toFixed(1)} cm inside the torso`);
    this.stageGap = +gap.toFixed(3);
    return lead.clone().addScaledVector(pf, 0.1);
  },

  /** a still's lens must not sit in a shop front or behind a pedestrian's umbrella: statics via heatActions.clearShot,
   *  then the lens swings round the subject (±0.36 rad) to the spot with the most room from the crowd; anyone still
   *  within 2 m of it steps back out of the lens */
  clearLens(pos, look) {
    const engine = this.engine, ha = engine.get('heatActions'), crowd = engine.get('crowd');
    const peds = (crowd && crowd.peds) || [];
    const room = (q) => {
      let m = 9;
      for (const pd of peds) {
        const dx = pd.x - q.x, dz = pd.z - q.z;
        if (dx * dx + dz * dz > 81) continue;
        m = Math.min(m, Math.hypot(dx, dz));
        // standing in the sight line within 5 m of the lens counts as right in front of it
        const lx = look.x - q.x, lz = look.z - q.z, L = Math.hypot(lx, lz) || 1;
        const t = (dx * lx + dz * lz) / L;
        if (t > 0 && t < Math.min(5, L - 0.8)) m = Math.min(m, Math.abs(dx * lz - dz * lx) / L + 0.6);
      }
      return m;
    };
    let best = pos, br = -1;
    for (const ang of [0, 0.12, -0.12, 0.24, -0.24, 0.36, -0.36]) {
      const q = pos.clone().sub(look).applyAxisAngle(_up, ang).add(look);
      const c = ha && ha.clearShot ? ha.clearShot(q, look) : q;
      const r = room(c) - Math.abs(ang) * 0.8;
      if (r > br) { br = r; best = c; }
      if (r >= 2.2) break;
    }
    for (const pd of peds) {
      const dx = pd.x - best.x, dz = pd.z - best.z, d = Math.hypot(dx, dz);
      if (d >= 2.0 || d < 1e-3) continue;
      pd.x = best.x + dx / d * 2.4; pd.z = best.z + dz / d * 2.4;
      if (pd.tx != null && (pd.kind === 'idler' || pd.state === 'wait')) { pd.tx = pd.x; pd.tz = pd.z; }
    }
    return best;
  },

  /** weapon stage: lift the nearest bicycle into his hand */
  stageWeapon(p) {
    const props = this.engine.get('props');
    if (!props || p.weapon) return;
    const near = this.nearestWeapon(p.position, 500, 'bike');
    if (!near) return;
    const saved = near.body.position.clone();
    near.body.position.set(p.position.x, near.body.position.y, p.position.z);
    const ok = this.pickUp(p, 1.0);
    if (!ok) near.body.position.copy(saved);
    this.active.length = 0;
  },

  // ------------------------------------------------------------------ live measurement (?combatlab=1&fight=1)
  /** drives real key events through input.js and logs what the frame loop measured: input→contact, hit-stop,
   *  knockback, then a grab string and a live heat action. Same code path as a player's key presses. */
  async lab() {
    const engine = this.engine, p = engine.player, en = engine.get('enemy'), ha = engine.get('heatActions');
    const wait = (s) => new Promise(r => setTimeout(r, s * 1000));
    const key = async (code, hold = 0.07) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
      await wait(hold);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
    };
    const log = [];
    const T0 = performance.now(), ms = () => Math.round(performance.now() - T0);
    engine.events.on('combat:hit', (h) => log.push(`${ms()} hit ${h.name} ${h.damage}${h.guarded ? ' G' : ''} -> ${h.target.isPlayer ? 'P' : h.target.id}`));
    engine.events.on('combat:ko', (h) => log.push(`${ms()} ko ${h.target.id || 'P'}`));
    engine.events.on('heat:action', (h) => log.push(`${ms()} heat:action ${h.name}`));
    engine.events.on('heat:impact', (h) => log.push(`${ms()} heat:impact ${h.name} #${h.index}${h.final ? ' final' : ''} dmg ${h.damage}`));
    engine.events.on('combat:guardbreak', () => log.push(`${ms()} guardbreak`));
    // chapter 1 (?cutscene=hachiko): hold Enter through the confrontation until the fight is live
    for (let k = 0; k < 40 && engine.state.mode !== 'combat'; k++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }));
      await wait(0.5);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', key: 'Enter', bubbles: true }));
      await wait(0.3);
    }
    await wait(1.2);
    const list = ((en && en.list) || []).filter(e => e.alive);
    if (!p || !list.length) { console.warn('[combat] lab: no fight, mode ' + engine.state.mode); return; }
    log.push(`${ms()} fight live: ${list.map(e => e.type + '/' + e.humanoid.variant).join(',')} at ${p.position.x.toFixed(1)},${p.position.z.toFixed(1)}`);
    engine.input.enabled = true;
    const t = list[0];
    const setup = (d = 1.35) => {
      p.yaw = Math.atan2(t.position.x - p.position.x, t.position.z - p.position.z);
      p.position.set(t.position.x - Math.sin(p.yaw) * d, p.position.y, t.position.z - Math.cos(p.yaw) * d);
      p.group.rotation.y = p.yaw; p.setState('idle'); p.velocity.set(0, 0, 0);
      for (const e of list) { e.cooldown = 99; if (e !== t && e.aggro) { e.aggro = false; e.position.x += 30; } }
      t.hp = t.hpMax = 400; t.setState('idle'); t.velocity.set(0, 0, 0); t.guardT = 0; t.guardMeter = 0;
      this.rng = () => 0.99;                                    // no random blocks while measuring
      this.metrics = { press: [], hits: [], stops: [], knock: [] };
    };
    const snap = () => JSON.parse(JSON.stringify({ hits: this.metrics.hits, stops: this.metrics.stops, knock: this.metrics.knock }));
    setup(); await wait(0.4);
    for (const code of ['KeyJ', 'KeyJ', 'KeyJ', 'KeyK']) { await key(code); await wait(0.16); }
    await wait(1.8);
    const rush = snap();
    setup(); await wait(0.3);
    await key('KeyK'); await wait(1.4);
    const kick = snap();
    setup(); await wait(0.3);
    await key('KeyL'); await wait(0.45); await key('KeyJ'); await wait(0.4); await key('KeyJ'); await wait(0.4); await key('KeyL'); await wait(1.6);
    const grab = snap();
    // guard break: he blocks everything, two heavies crack it
    setup(); await wait(0.3);
    this.rng = () => 0; t.guardT = 0;
    let worstB = 0, lastB = performance.now(), probingB = true;          // the same probe over plain fighting
    const probeB = (ts) => { worstB = Math.max(worstB, ts - lastB); lastB = ts; if (probingB) requestAnimationFrame(probeB); };
    requestAnimationFrame(probeB);
    await key('KeyJ'); await wait(0.5); await key('KeyK'); await wait(0.9); await key('KeyK'); await wait(1.2);
    probingB = false;
    log.push(`${ms()} worst frame over plain fighting ${Math.round(worstB)} ms`);
    this.rng = () => 0.99;
    // live heat action: walk the pair over to the bicycle the arena dressing parked, then R
    let heat = 'skipped';
    if (ha) {
      const bike = this.nearestWeapon(p.position, 30, 'bike');
      log.push(`${ms()} arena bike ${bike ? bike.body.position.x.toFixed(1) + ',' + bike.body.position.z.toFixed(1) + ' at ' + Math.hypot(bike.body.position.x - p.position.x, bike.body.position.z - p.position.z).toFixed(1) + ' m' : 'none within 30 m'}`);
      if (bike) {
        const bp = bike.body.position;
        t.position.set(bp.x + 1.6, t.position.y, bp.z + 0.6);
      }
      setup(1.2); t.hp = 60; t.hpMax = 60;
      await wait(0.5);
      p.heat = 100;
      const plan = ha.available(p, true);
      heat = plan ? plan.name : 'none available';
      // the worst real frame from the trigger through the whole cut (a shader compile would show up here)
      let worst = 0, last = performance.now(), probing = true;
      const probe = (ts) => { worst = Math.max(worst, ts - last); last = ts; if (probing) requestAnimationFrame(probe); };
      requestAnimationFrame(probe);
      await key('KeyR');
      await wait(0.2);
      const ran = !!ha.running;
      await wait(4.5);
      probing = false;
      heat += ` worst-frame ${Math.round(worst)} ms`;
      heat += ran ? ' (ran)' : ' (did not start)';
      heat += ha.running ? ' STILL RUNNING' : ' finished';
      heat += ` mode=${engine.state.mode} input=${engine.input.enabled} target hp=${t.hp} alive=${t.alive} speed=${engine.time.speed}`;
    }
    // live wall slam: the pair against a real building face near the crossing
    let wall = 'skipped';
    if (ha && ha.findStageWall) {
      const site = ha.findStageWall(engine);
      if (site) {
        const { W, n } = site;
        t.position.set(W.x + n.x * 1.2, t.position.y, W.z + n.z * 1.2);
        p.position.set(W.x + n.x * 2.3, p.position.y, W.z + n.z * 2.3);
        setup(1.1); t.hp = 60; t.hpMax = 60;
        await wait(0.4);
        p.heat = 100;
        const plan = ha.available(p, true);
        wall = plan ? plan.name : 'none available';
        await key('KeyR'); await wait(0.2);
        const ran = !!ha.running;
        await wait(4.0);
        wall += (ran ? ' (ran)' : ' (did not start)') + (ha.running ? ' STILL RUNNING' : ' finished') + ` mode=${engine.state.mode} target hp=${t.hp} state=${t.state}`;
      }
    }
    // weapons: pick the bicycle up (E), swing it (J), throw it (L)
    let weapon = 'skipped';
    {
      const bike = this.nearestWeapon(p.position, 500, 'bike');
      if (bike) {
        setup(1.6);
        const f = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw)), r = new THREE.Vector3(-f.z, 0, f.x);
        bike.body.position.set(p.position.x - r.x * 0.9, bike.body.position.y, p.position.z - r.z * 0.9);
        await wait(0.3);
        engine.events.on('combat:weapon', (w) => log.push(`${ms()} weapon ${w.action} ${w.type}`));
        await key('KeyE'); await wait(0.6);
        const held = !!p.weapon;
        p.yaw = Math.atan2(t.position.x - p.position.x, t.position.z - p.position.z); p.group.rotation.y = p.yaw;
        await key('KeyJ'); await wait(1.0);
        p.yaw = Math.atan2(t.position.x - p.position.x, t.position.z - p.position.z); p.group.rotation.y = p.yaw;
        await key('KeyL'); await wait(1.4);
        weapon = `picked=${held} holding-after-throw=${!!p.weapon}`;
      }
    }
    // hand the fight back: everyone aggro, let them come at him for a few seconds
    for (const e of list) { if (e.alive && !e.aggro) { e.aggro = true; e.position.x -= 30; e.cooldown = 0.5; e.setState('approach'); } else e.cooldown = 0.4; }
    engine.state.mode = 'combat';
    await wait(4.0);
    log.push(`${ms()} end: player hp ${p.hp} heat ${Math.round(p.heat)} mode ${engine.state.mode}`);
    // leave the frame on a full gauge so the live prompt shows over whoever can be heated
    for (const e of list) e.cooldown = 99;
    p.hp = Math.max(p.hp, 60); p.heat = 100;
    const plan = ha && ha.available(p, true);
    log.push(`${ms()} prompt: ${plan ? plan.name + ' on ' + plan.target.id : 'none in reach'}`);
    console.info('[combat] lab rush ' + JSON.stringify(rush));
    console.info('[combat] lab kick ' + JSON.stringify(kick));
    console.info('[combat] lab grab ' + JSON.stringify(grab));
    console.info('[combat] lab heat ' + heat);
    console.info('[combat] lab wall ' + wall);
    console.info('[combat] lab weapon ' + weapon);
    console.info('[combat] lab events ' + log.join(' | '));
    window.__combatLab = { rush, kick, grab, heat, wall, weapon, log };
  },

  dispose() {
    if (this._stageTimer) clearInterval(this._stageTimer);
    if (this.vfx) { this.vfx.group.parent?.remove(this.vfx.group); }
  },
};

// ---------------------------------------------------------------------------------------------- pose helpers
const add3 = (a = [0, 0, 0], b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
// authoring: addPose offsets rotation channels (deg) and the hips offset (m); leg IK targets / FK legs replace
const LEG_FK = /^(Left|Right)(UpLeg|Leg|Foot)$/;
function addPose(pose, d) {
  const o = { ...pose };
  for (const k in d) {
    if (k === 'ikL' || k === 'ikR') { const s = k === 'ikL' ? 'Left' : 'Right'; delete o[s + 'UpLeg']; delete o[s + 'Leg']; delete o[s + 'Foot']; o[k] = d[k].slice(); }
    else if (LEG_FK.test(k)) { delete o[k.startsWith('Left') ? 'ikL' : 'ikR']; o[k] = d[k].slice(); }
    else o[k] = o[k] ? o[k].map((v, i) => v + (d[k][i] || 0)) : d[k].slice();
  }
  return o;
}
function setPose(pose, d) {
  const o = { ...pose };
  for (const k in d) {
    if (k === 'ikL' || k === 'ikR') { const s = k === 'ikL' ? 'Left' : 'Right'; delete o[s + 'UpLeg']; delete o[s + 'Leg']; delete o[s + 'Foot']; }
    else if (LEG_FK.test(k)) delete o[k.startsWith('Left') ? 'ikL' : 'ikR'];
    o[k] = d[k].slice();
  }
  return o;
}
/** a sampled frame of a library clip back as an authoring pose { Bone:[deg], hips:[m], ikL/ikR | leg FK } */
export function poseOf(A, clipName, phase) {
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

// ---------------------------------------------------------------------------------------------- shot presets
function stageWith(kind, view) {
  return (engine) => {
    const c = engine.get('combat');
    if (!c) return;
    c.stage = kind; c.stageView = view;
    c.placeStage();
  };
}
// pos/lookAt are placeholders: the staged tableau picks clear ground at boot and re-frames the camera itself
export const shotPresets = {
  combat_impact: { fight: true, t: 'night', fov: 38, pos: [9.4, 1.4, 16.2], lookAt: [4.6, 1.2, 12.6], setup: stageWith('brawl', 'impact') },
  combat_wide:   { fight: true, t: 'night', fov: 42, pos: [14.5, 3.2, 22.0], lookAt: [4.0, 1.1, 12.0], setup: stageWith('brawl', 'wide') },
  combat_weapon: { fight: true, t: 'night', fov: 38, pos: [9.4, 1.4, 16.2], lookAt: [4.6, 1.2, 12.6], setup: stageWith('weapon', 'impact') },
  // the final blow, PLAYED live and frozen at &t=<real seconds from the contact> (finalBlow.js has the timeline)
  final_blow:    { fight: true, t: 'night', fov: 45, pos: [9.4, 1.8, 16.2], lookAt: [4.6, 1.2, 12.6], setup: (engine) => { const c = engine.get('combat'); if (c) c.prepFinaleStill(engine); } },
};

// ---------------------------------------------------------------------------------------------- self test
export function selfTest(engine) {
  const out = { ok: true, attacks: 0, problems: [] };
  const anim = engine.get('animations');
  for (const [name, def] of Object.entries(ATTACKS)) {
    out.attacks++;
    if (name.startsWith('heat_')) continue;
    if (def.held) continue;
    const clip = anim && anim.getClip ? anim.getClip(def.clip || name) : null;
    if (!clip) { out.problems.push(`${name}: no clip "${def.clip || name}"`); continue; }
    const evs = (clip.userData.events || []).filter(e => e.name === 'hit');
    if (!evs.length && !def.held && !def.hold) out.problems.push(`${name}: clip has no hit event`);
    for (const e of evs) if (!e.bone || !e.radius) out.problems.push(`${name}: hit event missing bone/radius`);
    if (!(def.dmg >= 0) || !(def.reach > 0)) out.problems.push(`${name}: bad dmg/reach`);
    if (def.held) continue;
    if (!(def.stop >= 40 && def.stop <= 110)) out.problems.push(`${name}: hit-stop ${def.stop} ms out of range`);
    // what the player feels: press → contact, in ms, at the attack's playback rate
    if (evs.length && !def.weapon && !def.held) out[name] = Math.round(evs[0].time / (def.rate || 1) * 1000);
  }
  const p1 = new THREE.Vector3(0, 0, 0), q1 = new THREE.Vector3(1, 0, 0);
  const p2 = new THREE.Vector3(0.5, 1, 0), q2 = new THREE.Vector3(0.5, 2, 0);
  const d = Math.sqrt(segSegDist2(p1, q1, p2, q2));
  if (Math.abs(d - 1) > 1e-6) out.problems.push(`segSegDist2 wrong: ${d}`);
  if (!combat.vfx) out.problems.push('vfx not created');
  if (!combat.kneeClip()) out.problems.push('knee clip failed');
  const rc = combat.reactClips();
  for (const k of ['cx_hit_head_l', 'cx_hit_head_r', 'cx_hit_body']) if (!rc[k]) out.problems.push(`reaction clip ${k} missing`);
  out.reactions = Object.keys(rc).length;
  const ha = engine.get('heatActions');
  if (ha && ha.FINISHERS && ha.FINISHERS.length !== 2) out.problems.push(`heat actions: ${ha.FINISHERS.length} (Plan A wants 2)`);
  if (engine.world && engine.params?.raw?.survey) {
    const tags = {};
    for (const h of engine.world.overlapSphere(new THREE.Vector3(10, 1.4, 10), 70, {})) {
      const s = h.shape; if (!s) continue;
      const t = tags[h.tag] || (tags[h.tag] = { n: 0, hmin: 99, hmax: 0 });
      t.n++; t.hmin = Math.min(t.hmin, +s.max.y.toFixed(1)); t.hmax = Math.max(t.hmax, +s.max.y.toFixed(1));
    }
    out.survey = tags;
  }
  out.ok = out.problems.length === 0;
  return out;
}

combat.shotPresets = shotPresets;
combat.selfTest = selfTest;
combat.poseOf = poseOf;
export default combat;
