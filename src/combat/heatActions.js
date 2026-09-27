// [combat] Heat actions. Plan A (docs/CRP.md, 2026-09-22) keeps exactly two finishers:
//   wall_slam      a wall / pole / vending machine within reach of the man: grab him, turn him into it, slam his head
//                  twice, he rebounds onto his back
//   bicycle_smash  a bicycle in hand or parked within reach: hoist it overhead and bring it down on him; it breaks
//                  loose and tumbles across the asphalt
// Each one is a timeline of cues + tracks in GAME time, so slow-mo and hit-stop scale the choreography together with
// the clips; camera.cinematic cuts fire on the cues. Letterbox + hud.stamp('極') at the start, combat.setSlowMo and a
// hit-stop on every contact, damage through combat.applyHit (KO deferred to the end of the cinematic).
// Events: 'heat:action' {name, player, target} at the start, 'heat:impact' {name, index, final, point, strength,
// player, target} on every contact frame (audio lands the taiko on it).
//   heatActions.available(player) -> {name, target, wall?, bike?} | null    heatActions.trigger(player) -> bool
//   heatActions.FINISHERS   ?shot=combat&fight=1&heat=1 stages the bicycle smash on its contact frame
//   (&hx=wall|bike picks the finisher, &ht=<seconds> scrubs the timeline to any beat)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { playClip, poseOf, fixHeldProp, segSegDist2 } from './combat.js';

export const FINISHERS = ['wall_slam', 'bicycle_smash'];
const NOT_WALL = new Set(['ground', 'bounds', 'dynamic', 'weapon', 'vehicle', 'rail', 'tree', 'crowd', 'char', 'mover']);
const REACH = 2.6;          // the man must be this close to the player
const WALL_REACH = 2.1;     // ...and a wall this close to him
const BIKE_REACH = 3.4;     // a parked bicycle this close to the player
const HEAD = 1.42;          // head height the wall test is made at
const BIKE_HIT = 0.8;       // hx_bike: the frame where the hands pass below the shoulders = contact
const BIKE_OVER = 2 / 30;   // two frames of overshoot through him before the bicycle breaks loose

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
// followBike runs twice a tick through the whole bicycle cinematic: its vectors live here, not in the call
const _sh = new THREE.Vector3(), _fw = new THREE.Vector3(), _fx = new THREE.Vector3(), _fy = new THREE.Vector3(), _fz = new THREE.Vector3();
const _pos = new THREE.Vector3(), _fr = new THREE.Vector3(), _hz = new THREE.Vector3(), _UP = new THREE.Vector3(0, 1, 0);
// the money frame names the finisher: a brush title card at lower left for the contact and aftermath beat
const TITLES = { wall_slam: '壁の極み', bicycle_smash: '自転車の極み' };
const TITLE_CSS = `
#hud .hx-title{position:absolute;left:5.2vw;bottom:calc(11vh + 2.6vh);pointer-events:none;opacity:0;z-index:30;white-space:nowrap;
  font-family:"Hiragino Mincho ProN","Yu Mincho","Hiragino Sans",serif}
#hud .hx-title.on{animation:hxin .3s cubic-bezier(.2,.9,.3,1) forwards}
#hud .hx-title.off{animation:hxout .35s ease-in forwards}
#hud .hx-title .band{position:absolute;left:-2.4vw;right:-4.5vw;top:14%;bottom:2%;transform:skewX(-14deg);
  background:linear-gradient(90deg,rgba(110,4,8,0) 0%,rgba(172,14,20,.93) 6%,rgba(132,8,14,.88) 58%,rgba(90,4,8,0) 100%);
  clip-path:polygon(0 22%,18% 8%,100% 0,98% 64%,94% 100%,30% 92%,3% 88%)}
#hud .hx-title .k{position:relative;font-size:76px;font-weight:900;letter-spacing:.05em;color:#fff;-webkit-text-stroke:1.5px #230000;
  text-shadow:0 0 18px rgba(255,70,40,.5),4px 5px 0 rgba(0,0,0,.85)}
#hud .hx-title .e{position:relative;display:block;margin:-4px 0 0 8px;font-family:"Hiragino Sans","Noto Sans JP",sans-serif;font-size:13px;
  font-weight:700;letter-spacing:.6em;color:#f0cf78;text-shadow:0 1px 2px #000}
@keyframes hxin{0%{opacity:0;transform:translateX(-48px);clip-path:inset(0 100% 0 0)}100%{opacity:1;transform:none;clip-path:inset(-20% -10% -20% 0)}}
@keyframes hxout{0%{opacity:1}100%{opacity:0;transform:translateX(28px)}}`;
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (k) => k * k * (3 - 2 * k);
const easeIn = (k) => k * k * k;
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const flat = (v) => v.setY(0).normalize();
const rightOf = (f) => V(-f.z, 0, f.x);            // the character's right for a facing f (player.js convention)

// pose authoring: `add` offsets rotation channels (deg) and the hips offset (m); leg IK targets / FK legs replace
const LEG_FK = /^(Left|Right)(UpLeg|Leg|Foot)$/;
function add(pose, d) {
  const o = { ...pose };
  for (const k in d) {
    if (k === 'ikL' || k === 'ikR') { const s = k === 'ikL' ? 'Left' : 'Right'; delete o[s + 'UpLeg']; delete o[s + 'Leg']; delete o[s + 'Foot']; o[k] = d[k]; }
    else if (LEG_FK.test(k)) { delete o[k.startsWith('Left') ? 'ikL' : 'ikR']; o[k] = d[k]; }
    else o[k] = o[k] ? o[k].map((v, i) => v + (d[k][i] || 0)) : d[k].slice();
  }
  return o;
}
function set(pose, d) {
  const o = { ...pose };
  for (const k in d) {
    if (k === 'ikL' || k === 'ikR') { const s = k === 'ikL' ? 'Left' : 'Right'; delete o[s + 'UpLeg']; delete o[s + 'Leg']; delete o[s + 'Foot']; }
    else if (LEG_FK.test(k)) delete o[k.startsWith('Left') ? 'ikL' : 'ikR'];
    o[k] = d[k].slice();
  }
  return o;
}

function promptTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  const cx = 48, cy = 48;
  g.fillStyle = 'rgba(8,8,10,0.72)'; g.beginPath(); g.arc(cx, cy, 34, 0, Math.PI * 2); g.fill();
  g.lineWidth = 5; g.strokeStyle = '#e8c46a'; g.beginPath(); g.arc(cx, cy, 34, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 2; g.strokeStyle = 'rgba(255,236,180,0.6)'; g.beginPath(); g.arc(cx, cy, 41, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#fff6dc'; g.font = '800 40px "Hiragino Sans","Noto Sans JP",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('R', cx, cy + 2);
  g.textAlign = 'left'; g.font = '900 34px "Hiragino Mincho ProN","Yu Mincho","Hiragino Sans",serif';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText('ヒート', 96, cy + 2);
  const lg = g.createLinearGradient(0, 20, 0, 76); lg.addColorStop(0, '#fff2c8'); lg.addColorStop(1, '#d9a53c');
  g.fillStyle = lg; g.fillText('ヒート', 96, cy + 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------------------------- hero bicycle
// The street ママチャリ is a 20-gon instanced prop built for 3+ m. In the finisher it fills the frame, so the cinematic
// swaps in a dedicated one in the same local frame (ground origin, long axis +x toward the front hub at 0.62, rear hub
// at -0.42, hubs at 0.325, wheels in the XY plane): chrome rims and spokes, a wire basket, a sprung saddle.
function tubeGeo(a, b, r, seg = 8) {
  const A = V(a[0], a[1], a[2] || 0), B = V(b[0], b[1], b[2] || 0), len = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), B.sub(A).normalize()));
  g.translate(A.x, A.y, A.z);
  return g;
}
function ringGeo(R, r, cx, cy, z = 0, arc = Math.PI * 2, rot = 0, flatZ = 1, seg = 44) {
  const g = new THREE.TorusGeometry(R, r, 8, seg, arc);
  if (rot) g.rotateZ(rot);
  if (flatZ !== 1) g.scale(1, 1, flatZ);
  g.translate(cx, cy, z);
  return g;
}
function wireTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 32, 32);
  g.fillStyle = '#fff'; g.fillRect(0, 0, 32, 3); g.fillRect(0, 0, 3, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function planeGeo(w, h, cell) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / cell, uv.getY(i) * h / cell);
  return g;
}
function buildHeroBike() {
  const chrome = [], paint = [], rubber = [], black = [], wire = [];
  const FH = [0.62, 0.325], RH = [-0.42, 0.325], BB = [0.075, 0.285], SC = [-0.03, 0.74];
  for (const [cx, cy] of [FH, RH]) {
    rubber.push(ringGeo(0.3, 0.03, cx, cy, 0, Math.PI * 2, 0, 1, 48));
    chrome.push(ringGeo(0.266, 0.012, cx, cy, 0, Math.PI * 2, 0, 1.6, 48));
    for (let i = 0; i < 20; i++) {
      const a = i / 20 * Math.PI * 2 + (i % 2 ? 0.08 : 0), z = i % 2 ? 0.03 : -0.03;
      chrome.push(tubeGeo([cx + Math.cos(a + (i % 2 ? 0.35 : -0.35)) * 0.032, cy + Math.sin(a + (i % 2 ? 0.35 : -0.35)) * 0.032, z], [cx + Math.cos(a) * 0.258, cy + Math.sin(a) * 0.258, 0], 0.0022, 3));
    }
    const hub = new THREE.CylinderGeometry(0.028, 0.028, 0.1, 12); hub.rotateX(Math.PI / 2); hub.translate(cx, cy, 0); chrome.push(hub);
  }
  // mudguards: flat chrome strips over the top of each wheel
  chrome.push(ringGeo(0.335, 0.011, FH[0], FH[1], 0, Math.PI * 0.8, Math.PI * 0.12, 3.2, 28));
  chrome.push(ringGeo(0.335, 0.011, RH[0], RH[1], 0, Math.PI * 1.02, Math.PI * 0.08, 3.2, 28));
  // step-through frame: a low swooping down tube, seat tube, stays, head tube
  const down = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(V(0.5, 0.6, 0), V(0.28, 0.16, 0), V(BB[0], BB[1] + 0.01, 0)), 18, 0.022, 10, false);
  paint.push(down);
  paint.push(tubeGeo(BB, SC, 0.02));
  paint.push(tubeGeo([0.485, 0.56], [0.53, 0.8], 0.025));
  for (const z of [-0.045, 0.045]) {
    paint.push(tubeGeo([BB[0], BB[1], z * 0.6], [RH[0], RH[1], z], 0.012));
    paint.push(tubeGeo([SC[0], SC[1] - 0.02, z * 0.4], [RH[0], RH[1], z], 0.011));
    chrome.push(tubeGeo([0.49, 0.57, z * 0.7], [FH[0], FH[1], z], 0.012));           // fork legs
  }
  const cg = new THREE.BoxGeometry(0.46, 0.065, 0.006);                              // chain guard
  cg.rotateZ(Math.atan2(RH[1] - BB[1], RH[0] - BB[0]) + Math.PI); cg.translate((BB[0] + RH[0]) / 2, (BB[1] + RH[1]) / 2 + 0.01, 0.075); paint.push(cg);
  // cockpit: stem, swept-back bar, grips, bell, lamp
  chrome.push(tubeGeo([0.53, 0.8], [0.515, 0.94], 0.013));
  for (const s of [-1, 1]) {
    chrome.push(tubeGeo([0.515, 0.94, 0], [0.47, 0.955, 0.12 * s], 0.011));
    chrome.push(tubeGeo([0.47, 0.955, 0.12 * s], [0.37, 0.955, 0.27 * s], 0.011));
    black.push(tubeGeo([0.37, 0.955, 0.27 * s], [0.26, 0.95, 0.285 * s], 0.017));
  }
  const bell = new THREE.SphereGeometry(0.026, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2); bell.translate(0.44, 0.97, -0.17); chrome.push(bell);
  const lamp = new THREE.CylinderGeometry(0.04, 0.034, 0.07, 14); lamp.rotateZ(-Math.PI / 2); lamp.translate(0.62, 0.64, 0); chrome.push(lamp);
  // saddle on its springs, seat post
  chrome.push(tubeGeo(SC, [-0.045, 0.84], 0.013));
  const sad = new THREE.SphereGeometry(1, 20, 12); sad.scale(0.14, 0.045, 0.105); sad.translate(-0.055, 0.875, 0); black.push(sad);
  for (const z of [-0.05, 0.05]) black.push(tubeGeo([-0.14, 0.835, z], [-0.14, 0.87, z], 0.012, 6));
  // crank + chainring
  paint.push(ringGeo(0.085, 0.009, BB[0], BB[1], 0.06, Math.PI * 2, 0, 1, 24));
  for (const s of [-1, 1]) black.push(tubeGeo([BB[0], BB[1], 0.07 * s], [BB[0] + 0.02 * s, BB[1] - 0.16 * s, 0.085 * s], 0.012, 6));
  // rear carrier
  for (const z of [-0.07, 0.07]) {
    chrome.push(tubeGeo([-0.16, 0.72, z], [-0.6, 0.72, z], 0.007, 6));
    chrome.push(tubeGeo([-0.58, 0.72, z], [RH[0] - 0.02, RH[1] + 0.02, z * 0.8], 0.006, 6));
  }
  for (const x of [-0.25, -0.38, -0.5]) chrome.push(tubeGeo([x, 0.72, -0.07], [x, 0.72, 0.07], 0.005, 5));
  // front wire basket: open top, a stiff rim, two struts to the fork crown
  const bx = 0.76, by = 0.8, W = 0.32, H = 0.22, D = 0.34, cell = 0.045;
  const side = (w, h, rx, ry, x, y, z) => { const g = planeGeo(w, h, cell); if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); g.translate(x, y, z); wire.push(g); };
  side(W, D, -Math.PI / 2, 0, bx, by - H / 2, 0);
  side(W, H, 0, 0, bx, by, D / 2); side(W, H, 0, 0, bx, by, -D / 2);
  side(D, H, 0, Math.PI / 2, bx + W / 2, by, 0); side(D, H, 0, Math.PI / 2, bx - W / 2, by, 0);
  const x0 = bx - W / 2, x1 = bx + W / 2, y1 = by + H / 2, z0 = -D / 2, z1 = D / 2;
  for (const [a, b] of [[[x0, y1, z0], [x1, y1, z0]], [[x0, y1, z1], [x1, y1, z1]], [[x0, y1, z0], [x0, y1, z1]], [[x1, y1, z0], [x1, y1, z1]]]) chrome.push(tubeGeo(a, b, 0.006, 6));
  for (const z of [-0.06, 0.06]) chrome.push(tubeGeo([FH[0] + 0.02, FH[1] + 0.05, z], [bx + 0.02, by - H / 2, z], 0.006, 6));

  const g = new THREE.Group(); g.name = 'hero-bike'; g.userData.hero = true;
  const mats = {
    chrome: new THREE.MeshStandardMaterial({ color: 0xe6eaee, metalness: 1, roughness: 0.25 }),
    paint: new THREE.MeshPhysicalMaterial({ color: 0xe4ded0, metalness: 0.3, roughness: 0.34, clearcoat: 0.7, clearcoatRoughness: 0.18 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0, roughness: 0.82 }),
    black: new THREE.MeshStandardMaterial({ color: 0x1b1b1d, metalness: 0.1, roughness: 0.5 }),
    wire: new THREE.MeshStandardMaterial({ color: 0xd4d8dc, metalness: 0.9, roughness: 0.3, map: wireTexture(), alphaTest: 0.5, side: THREE.DoubleSide }),
  };
  for (const [k, list] of Object.entries({ chrome, paint, rubber, black, wire })) {
    const geo = mergeGeometries(list.map(x => (x.index ? x.toNonIndexed() : x)), false);
    list.forEach(x => x.dispose());
    const m = new THREE.Mesh(geo, mats[k]);
    // the alpha-tested wire would need a depth program of its own in the shadow pass (compiled on first use)
    m.castShadow = k !== 'wire'; m.receiveShadow = true; m.name = 'hero-bike:' + k;
    g.add(m);
  }
  return g;
}

const heatActions = {
  name: 'heatActions',
  running: null,
  FINISHERS,
  clips: null,
  _avail: null, _availT: 0,

  init(engine) {
    this.engine = engine;
    this.combat = engine.get('combat');
    // a heat cut is a cutscene: everything on the HUD except the letterbox and the stamp fades out (hud.css owns the
    // rule once it lands; this runtime copy keeps the cut clean until then)
    if (typeof document !== 'undefined' && !document.getElementById('hx-cine-style')) {
      const st = document.createElement('style'); st.id = 'hx-cine-style';
      st.textContent = '#hud.cine > :not(.lb):not(.stamp):not(.hx-title){opacity:0 !important;transition:opacity .12s}' + TITLE_CSS;
      document.head.appendChild(st);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: promptTexture(), transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sprite.scale.set(0.72, 0.27, 1); sprite.renderOrder = 40; sprite.visible = false; sprite.name = 'heat-prompt';
    engine.scene.add(sprite);
    this.prompt = sprite;
    // the hero bicycle (a MeshPhysicalMaterial clear-coat and an alpha-tested wire: two programs of their own) is
    // built and compiled while loading, parked hidden, so the first bicycle smash does not stall on its trigger frame
    try {
      const bike = this.heroBike();
      bike.visible = false;
      engine.scene.add(bike);
      this.bikeEnv(bike);
      if (engine.renderer && engine.renderer.compileAsync) engine.renderer.compileAsync(bike, engine.camera, engine.scene).catch(() => {});
    } catch (err) { console.warn('[heatActions] hero bike prebuild failed', err); }
  },

  // ------------------------------------------------------------------------------------------ choreography clips
  /** authored once from the library's own frames (idle_combat stance, grab) plus offsets, against the same bone
   *  contract, so they deform every cast member the way the library clips do */
  buildClips() {
    if (this.clips) return this.clips;
    const A = this.engine.get('animations');
    if (!A || !A.makeClip || !A.getFrames) return (this.clips = {});
    const C = poseOf(A, 'idle_combat', 0), G = poseOf(A, 'grab', 1);
    const K = C.ikL ? C.ikL[1] : 0.09;                             // ankle height of the stance
    const lunge = { ikL: [0.16, K, 0.44, 0, 6], ikR: [-0.2, K + 0.02, -0.34, -10, 28] };
    const lungeDeep = { ikL: [0.17, K, 0.52, 0, 4], ikR: [-0.2, K + 0.03, -0.40, -14, 26] };

    // --- wall slam, player (behind the man, both facing the wall). Beats in clip time: 0.22 slam, 0.44 pulled
    //     back, 0.56 second slam, 0.70 let go, 1.10 back in stance.
    // torso pitch of the grab pose is ~22 deg; hands must reach the bent man's head ~1.1 m ahead at ~1.25 m
    const wHold = set(add(G, { hips: [0, -0.06, 0.08], Hips: [6, 16, 0], Spine: [6, 0, 0], Spine1: [2, 0, 0], Neck: [-10, 0, 0], Head: [-8, -6, 0] }), {
      ...lunge, RightShoulder: [14, 0, 4], RightArm: [120, 4, -10], RightForeArm: [22, 0, 0], RightHand: [-20, 0, 0],
      LeftShoulder: [10, 0, 2], LeftArm: [102, -4, -16], LeftForeArm: [42, 0, 0], LeftHand: [-10, 0, 0] });
    const wSlam = add(wHold, { hips: [0, -0.04, 0.14], Hips: [4, 0, 0], Spine: [4, 0, 0], RightArm: [6, 0, 0], RightForeArm: [-16, 0, 0], LeftArm: [4, 0, 0], LeftForeArm: [-18, 0, 0] });
    const wBack = add(wHold, { hips: [0, 0.02, -0.08], Hips: [-6, 0, 0], Spine: [-6, 0, 0], RightArm: [-4, 0, 0], RightForeArm: [40, 0, 0], LeftForeArm: [24, 0, 0], Head: [-4, 0, 0] });
    const wSlam2 = set(add(wSlam, { hips: [0, -0.02, 0.06], Hips: [2, 0, 0], RightArm: [4, 0, 0], RightForeArm: [-4, 0, 0] }), lungeDeep);
    const wLet = add(C, { Hips: [4, 10, 0], Spine: [4, 0, 0], Head: [-4, -14, 0] });
    this.clips = {};
    this.clips.wall = A.makeClip('hx_wall', [
      { t: 0, pose: wHold }, { t: 0.14, pose: wBack }, { t: 0.22, pose: wSlam }, { t: 0.30, pose: wSlam },
      { t: 0.44, pose: wBack }, { t: 0.56, pose: wSlam2 }, { t: 0.70, pose: wSlam2 }, { t: 1.0, pose: wLet }, { t: 1.3, pose: C },
    ]);

    // --- wall slam, the man (facing the wall, bent over by the grip); his head snaps back off the wall at 0.22 / 0.56
    const vBent = set(add(C, { hips: [0, -0.06, -0.08], Hips: [24, 22, 0], Spine: [14, -4, 0], Spine1: [8, 0, 0], Spine2: [4, 0, 0], Neck: [8, 0, 0], Head: [6, 0, 0] }), {
      LeftShoulder: [0, 0, 10], RightShoulder: [0, 0, 10], LeftArm: [-18, 0, 36], LeftForeArm: [34, 0, 0], RightArm: [-14, 0, 42], RightForeArm: [40, 0, 0],
      ikL: [0.13, K, 0.16, 0, 4], ikR: [-0.16, K, -0.24, 0, 12] });
    const vSnap = add(vBent, { Hips: [-8, 0, 0], Spine: [-8, 0, 0], Spine1: [-6, 0, 0], Neck: [-22, 0, 0], Head: [-26, 12, 8], LeftArm: [60, 0, 34], RightArm: [52, 0, 36], LeftForeArm: [-14, 0, 0], RightForeArm: [-16, 0, 0], hips: [0, 0.02, 0.02] });
    const vDaze = add(vBent, { Hips: [-4, 0, 0], Spine: [8, 0, 0], Neck: [10, 0, 0], Head: [12, -8, -6], LeftArm: [18, 0, -12], RightArm: [18, 0, -14], hips: [0, -0.03, 0] });
    const vSnap2 = add(vBent, { Hips: [-12, 0, 0], Spine: [-12, 0, 0], Spine1: [-8, 0, 0], Neck: [-26, 0, 0], Head: [-32, -14, -10], LeftArm: [80, 0, 44], RightArm: [70, 0, 48], LeftForeArm: [-20, 0, 0], RightForeArm: [-20, 0, 0], hips: [0, 0.03, 0.03] });
    const vSlump = add(vBent, { hips: [0, -0.16, -0.02], Hips: [-6, 0, 0], Spine: [10, 0, 0], Neck: [16, 0, 0], Head: [18, 10, 4], LeftArm: [10, 0, -20], RightArm: [8, 0, -22], ikL: [0.13, K, 0.2, 0, 4], ikR: [-0.16, K, -0.16, 0, 12] });
    this.clips.wallV = A.makeClip('hx_wall_v', [
      { t: 0, pose: vBent }, { t: 0.2, pose: vBent }, { t: 0.235, pose: vSnap }, { t: 0.32, pose: vSnap }, { t: 0.44, pose: vDaze },
      { t: 0.545, pose: vBent }, { t: 0.575, pose: vSnap2 }, { t: 0.68, pose: vSnap2 }, { t: 0.8, pose: vSlump },
    ]);

    // --- bicycle smash, player. 0.14 hands on the frame, 0.46 overhead, 0.66 wind-up, 0.86 contact, 1.4 stance.
    //     World arm angle (from hanging) = arm X minus the torso pitch (Hips+Spine chain, ~12 deg in the stance).
    const bReach = set(add(C, { hips: [0, -0.32, -0.04], Hips: [20, 0, 0], Spine: [14, 0, 0], Spine1: [6, 0, 0], Neck: [-18, 0, 0], Head: [-14, 0, 0] }), {
      LeftShoulder: [8, 0, 0], RightShoulder: [8, 0, 0], LeftArm: [62, 0, -6], LeftForeArm: [14, 0, 0], RightArm: [62, 0, -6], RightForeArm: [14, 0, 0],
      LeftHand: [0, 0, 0], RightHand: [0, 0, 0], ikL: [0.24, K, 0.2, 0, 12], ikR: [-0.24, K, -0.06, 0, 16] });
    const bChest = set(add(C, { hips: [0, -0.14, 0], Hips: [2, 0, 0], Spine: [2, 0, 0] }), {
      LeftArm: [100, 0, -12], LeftForeArm: [70, 0, 0], RightArm: [100, 0, -12], RightForeArm: [70, 0, 0], LeftHand: [0, 0, 0], RightHand: [0, 0, 0],
      Head: [-6, 0, 0], ikL: [0.18, K, 0.22, 0, 8], ikR: [-0.2, K, -0.18, -6, 22] });
    const bOver = set(add(C, { hips: [0, -0.06, -0.02], Hips: [-4, 0, 0], Spine: [-6, 0, 0], Spine1: [-4, 0, 0] }), {
      LeftShoulder: [0, 0, 10], RightShoulder: [0, 0, 10], LeftArm: [172, 0, -2], LeftForeArm: [16, 0, 0], RightArm: [172, 0, -2], RightForeArm: [16, 0, 0],
      LeftHand: [0, 0, 0], RightHand: [0, 0, 0], Neck: [-10, 0, 0], Head: [-6, 0, 0], ikL: [0.17, K, 0.26, 0, 6], ikR: [-0.2, K, -0.26, -6, 24] });
    const bWind = add(bOver, { hips: [0, 0.0, -0.05], Hips: [-2, 0, 0], Spine: [-6, 0, 0], LeftArm: [12, 0, 0], RightArm: [12, 0, 0], LeftForeArm: [10, 0, 0], RightForeArm: [10, 0, 0] });
    // the strike is DELIVERED: on contact the hands have come down past his shoulders to chest height in front of him,
    // the spine is flexed ~28° over them, the hips have dropped 12 cm onto a lead foot stepped well forward, and the
    // next two frames overshoot (hands on down to the belt, deeper fold) before the bicycle breaks loose
    const drive = { ikL: [0.17, K, 0.5, 0, 2], ikR: [-0.19, K + 0.04, -0.36, -16, 26] };
    const smash = (lean, arm, drop, fore = 10) => set(add(C, { hips: [0, -0.1 - drop, 0.2], Hips: [lean * 0.45, 0, 0], Spine: [lean * 0.35, 0, 0], Spine1: [lean * 0.2, 0, 0] }), {
      LeftShoulder: [14, 0, 4], RightShoulder: [14, 0, 4], LeftArm: [arm, 0, -6], LeftForeArm: [fore, 0, 0], RightArm: [arm, 0, -6], RightForeArm: [fore, 0, 0],
      LeftHand: [-10, 0, 0], RightHand: [-10, 0, 0], Neck: [-16, 0, 0], Head: [-10, 0, 0], ...drive });
    const bSmash = smash(26, 120, -0.04), bOvershoot = smash(34, 102, 0.02, 6), bFollow = add(smash(22, 96, 0.02, 20), { hips: [0, 0.04, -0.04] });
    const bSmashLow = smash(34, 102, 0.1), bOvershootLow = smash(40, 90, 0.13, 6), bFollowLow = add(smash(30, 86, 0.1, 18), { Spine: [4, 0, 0] });
    const keys = (hit, over, follow) => [
      { t: 0, pose: C }, { t: 0.14, pose: bReach }, { t: 0.30, pose: bChest }, { t: 0.46, pose: bOver }, { t: 0.66, pose: bWind },
      { t: BIKE_HIT, pose: hit }, { t: BIKE_HIT + 0.07, pose: over }, { t: 1.1, pose: follow }, { t: 1.45, pose: C }];
    this.clips.bike = A.makeClip('hx_bike', keys(bSmash, bOvershoot, bFollow));
    this.clips.bikeLow = A.makeClip('hx_bike_low', keys(bSmashLow, bOvershootLow, bFollowLow));
    // --- the man sees it coming: he ducks under it (knees buckled, weight back, shoulders hunched), face turned up at
    //     the frame, forearms thrown up over his head: the front tyre comes down on his crown, his face stays in view
    const cower = set(add(C, { hips: [0, -0.2, -0.16], Hips: [-6, 0, 0], Spine: [-8, 0, 0], Spine1: [-6, 0, 0], Spine2: [-4, 0, 0], Neck: [-16, 0, 0], Head: [-20, 8, 4] }), {
      LeftShoulder: [0, 0, 18], RightShoulder: [0, 0, 18], LeftArm: [138, 10, -22], LeftForeArm: [72, 0, 0], RightArm: [128, 14, -26], RightForeArm: [80, 0, 0],
      LeftHand: [10, 0, 0], RightHand: [10, 0, 0] });
    this.clips.cower = A.makeClip('hx_cower', [{ t: 0, pose: C }, { t: 0.18, pose: cower }, { t: 0.6, pose: add(cower, { hips: [0, -0.03, -0.02], Head: [-4, 0, 0] }) }]);
    return this.clips;
  },

  // ------------------------------------------------------------------------------------------ availability
  /** nearest wall-like collider face to the man: tall enough to put a head into, not a railing or a planter */
  findWall(target) {
    const world = this.engine.world;
    if (!world || !world.overlapSphere) return null;
    const y0 = target.position.y;
    const c = V(target.position.x, y0 + HEAD, target.position.z);
    let best = null;
    for (const h of world.overlapSphere(c, WALL_REACH, {})) {
      if (NOT_WALL.has(h.tag) || !h.shape) continue;
      if (h.shape.max.y < y0 + 1.75 || h.shape.min.y > y0 + 0.8) continue;
      const d = Math.hypot(c.x - h.point.x, c.z - h.point.z);
      if (d < 0.12) continue;                                      // inside it
      if (!best || d < best.dist) best = { point: V(h.point.x, y0 + HEAD, h.point.z), normal: V(c.x - h.point.x, 0, c.z - h.point.z).normalize(), dist: d, tag: h.tag };
    }
    return best;
  },

  nearestBike(pos, radius) {
    const combat = this.combat || this.engine.get('combat');
    return combat && combat.nearestWeapon ? combat.nearestWeapon(pos, radius, 'bike') : null;
  },

  available(player, force = false) {
    const engine = this.engine;
    if (!player || !player.alive || this.running) return null;
    const now = engine.elapsed || 0;
    if (!force && this._avail !== undefined && now - this._availT < 0.15) return this._avail;
    this._availT = now;
    this._avail = null;
    const en = engine.get('enemy');
    const fwd = player.forward(_a);
    const cands = [];
    for (const e of (en && en.list) || []) {
      if (!e.alive || e.state === 'dead' || e.hp <= 0) continue;
      const dx = e.position.x - player.position.x, dz = e.position.z - player.position.z, d = Math.hypot(dx, dz);
      if (d > REACH) continue;
      const facing = (dx * fwd.x + dz * fwd.z) / Math.max(1e-4, d);
      if (facing < -0.2 && d > 1.4) continue;
      const stag = e.state === 'hit' || e.state === 'down' || e.guardBroken > 0;
      cands.push({ e, score: d - (stag ? 0.6 : 0) - facing * 0.5 });
    }
    cands.sort((p, q) => p.score - q.score);
    const held = player.weapon && player.weapon.type === 'bike' ? player.weapon : null;
    for (const { e } of cands) {
      if (held) { this._avail = { name: 'bicycle_smash', target: e, bike: { held, body: held.body } }; break; }
      if (e.state !== 'down' && e.state !== 'getup') {
        const wall = this.findWall(e);
        if (wall) { this._avail = { name: 'wall_slam', target: e, wall }; break; }
      }
      const d = this.nearestBike(player.position, BIKE_REACH);
      if (d) { this._avail = { name: 'bicycle_smash', target: e, bike: { rec: d, body: d.body } }; break; }
    }
    return this._avail;
  },

  trigger(player) {
    if (this.running || !player || player.heat < 100) return false;
    const plan = this.available(player, true);
    if (!plan) return false;
    this.start(plan);
    return true;
  },

  // ------------------------------------------------------------------------------------------ runner
  start(plan, scrub = false) {
    const engine = this.engine, combat = this.combat || engine.get('combat'), p = engine.player, t = plan.target;
    this.buildClips();
    const S = this.running = {
      plan, t: 0, i: 0, cues: [], tracks: [], end: 2, scrub, prevMode: engine.state.mode, player: p, target: t,
      actors: [p, t], impacts: 0, bikeMesh: null,
    };
    if (combat) {
      if (combat.hold) combat.releaseHold(true);
      combat.active = combat.active.filter(a => a.attacker !== p && a.attacker !== t);
      combat.buffer = null;
    }
    engine.state.mode = 'cutscene';
    engine.input.enabled = false;
    p.setState('heat'); p.velocity.set(0, 0, 0);
    t.velocity.set(0, 0, 0);
    t.guardT = 0;
    this.clearCast(S);
    if (plan.name === 'wall_slam') this.wallSeq(S); else this.bikeSeq(S);
    S.cues.sort((x, y) => x.at - y.at);
    engine.events.emit('heat:action', { name: plan.name, player: p, target: t });
    this.tick(0);
    return S;
  },

  /** the other two back off: anyone within 3.5 m of where the finisher plays out steps back to 3.8 m on his own
   *  bearing (turned aside if that spot is a wall or a car); per cut, castForShot hides whoever is still in frame */
  clearCast(S) {
    const engine = this.engine, combat = this.combat || engine.get('combat'), t = S.target;
    const plan = S.plan;
    const cx = plan.wall ? plan.wall.point.x + plan.wall.normal.x * 1.2 : t.position.x;
    const cz = plan.wall ? plan.wall.point.z + plan.wall.normal.z * 1.2 : t.position.z;
    S.others = [];
    for (const e of (engine.get('enemy')?.list || [])) {
      if (e === t || !e.alive || !e.group || !e.humanoid) continue;
      S.others.push({ e, vis: e.group.visible });
      const dx = e.position.x - cx, dz = e.position.z - cz, d = Math.hypot(dx, dz);
      if (d >= 3.5) continue;
      const a0 = d > 1e-3 ? Math.atan2(dx, dz) : S.others.length * 2.1;
      for (const da of [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4]) {
        const x = cx + Math.sin(a0 + da) * 3.8, z = cz + Math.cos(a0 + da) * 3.8;
        if (combat && combat.clearance && combat.clearance(x, z) < 0.6) continue;
        this.place(e, x, z); this.face(e, cx, cz);
        e.velocity.set(0, 0, 0);
        break;
      }
    }
  },
  restoreCast(S) { for (const o of S.others || []) o.e.group.visible = o.vis; },

  cue(S, at, fn) { S.cues.push({ at, fn }); },
  track(S, from, to, fn) { S.tracks.push({ from, to, fn, done: false }); },

  tick(dt) {
    const S = this.running; if (!S) return;
    S.t += dt; S.dt = dt;
    if (S.tumble) this.stepTumble(S, dt);
    if (S.bikeFollow) this.followBike(S);
    while (S.i < S.cues.length && S.cues[S.i].at <= S.t + 1e-9) {
      const c = S.cues[S.i++];
      try { c.fn(S); } catch (err) { console.warn('[heatActions] cue failed', err); }
    }
    for (const tr of S.tracks) {
      if (tr.done || S.t < tr.from) continue;
      const u = tr.to > tr.from ? clamp((S.t - tr.from) / (tr.to - tr.from)) : 1;
      try { tr.fn(u, S); } catch (err) { console.warn('[heatActions] track failed', err); tr.done = true; }
      if (u >= 1) tr.done = true;
    }
    if (S.bikeFollow) this.followBike(S);
    if (S.dof && !S.scrub) this.focusDOF(S);
    if (!S.scrub && S.t >= S.end) this.finish();
  },

  update(dt, t) {
    const engine = this.engine, S = this.running;
    this.updatePrompt(dt, t);
    if (!S || S.scrub || engine.state.mode === 'paused') return;
    if (S.grade && (engine.elapsed || 0) >= S.gradeUntil) this.restoreGrade(S);
    this.tick(dt);
  },

  finish() {
    const S = this.running; if (!S) return;
    const engine = this.engine, p = S.player, t = S.target, hud = engine.get('hud'), cam = engine.get('camera'), combat = this.combat || engine.get('combat');
    this.running = null;
    if (hud) hud.letterbox(false);
    this.setCine(false);
    this.title(null);
    this.stampHome();
    this.restoreCast(S);
    this.restoreGrade(S);
    const pf = engine.get('postfx'); if (pf && pf.setDOF) pf.setDOF(false);
    if (combat) combat.setSlowMo(1);
    if (S.bikeMesh) this.releaseBike(S, true);
    p.heat = 0;
    p.setState('idle'); p.velocity.set(0, 0, 0);
    p.humanoid.play('idle_combat', { fade: 0.25 });
    engine.input.enabled = true;
    const anyone = (engine.get('enemy')?.list || []).some(e => e.alive && e.aggro && e.hp > 0);
    engine.state.mode = anyone || t.hp <= 0 ? 'combat' : (S.prevMode === 'cutscene' ? 'explore' : S.prevMode);
    if (t.alive) {
      if (t.hp <= 0 && combat) {
        combat.knockOut(t, p, t.position, true);
        // enemy.onKo replays the knockdown from its first frame: he is already on the floor, keep him there
        const a = t.humanoid.currentAction;
        if (a && t.humanoid.currentName === 'knockdown') { a.stopFading(); a.setEffectiveWeight(1); a.time = a.getClip().duration; }
      } else { t.setState('down'); t.stateT = 0.2; }
    }
    if (cam && cam.setFollow) cam.setFollow(p);
  },

  // ------------------------------------------------------------------------------------------ shared beats
  begin(S) {
    const engine = this.engine, hud = engine.get('hud'), combat = this.combat || engine.get('combat');
    if (hud) { hud.letterbox(true); hud.stamp('極'); }
    this.setCine(true);
    if (combat) combat.setSlowMo(1);
  },
  setCine(on) {
    const hud = this.engine.get('hud');
    if (hud && hud.root) hud.root.classList.toggle('cine', !!on);
  },
  /** letterbox off + the HUD back (the tail of every finisher) */
  outro() { const hud = this.engine.get('hud'); if (hud) hud.letterbox(false); this.setCine(false); this.title(null); },
  /** the second 極 lands on the blow itself, so it goes to the upper right third where it frames the contact
   *  instead of covering it (hud's stamp is centred for the start of the cut; the inline offset is undone in finish) */
  stampAside() {
    const hud = this.engine.get('hud');
    if (!hud || !hud.stamp) return null;
    hud.stamp('極');
    const st = hud.el && hud.el.stamp;
    if (st) { st.style.left = '77%'; st.style.top = '31%'; this._stampMoved = st; }
    return st;
  },
  stampHome() {
    const st = this._stampMoved; if (!st) return;
    st.style.left = st.style.top = st.style.animationDelay = st.style.animationPlayState = '';
    this._stampMoved = null;
  },
  /** the finisher's name, brush-lettered at lower left (null slides it out); `hold` seconds real, 0 = until told */
  title(text, hold = 1.1) {
    const hud = this.engine.get('hud'), root = hud && hud.root;
    if (!root || typeof document === 'undefined') return;
    let el = this._title;
    clearTimeout(this._titleT);
    if (!text) { if (el && el.classList.contains('on')) { el.classList.remove('on'); el.classList.add('off'); } return; }
    if (!el || !el.isConnected) {
      el = this._title = document.createElement('div');
      el.className = 'hx-title';
      el.innerHTML = '<div class="band"></div><span class="k"></span><span class="e">HEAT ACTION</span>';
      root.appendChild(el);
    }
    el.querySelector('.k').textContent = text;
    el.classList.remove('on', 'off'); void el.offsetWidth; el.classList.add('on');
    if (hold > 0) this._titleT = setTimeout(() => this.title(null), hold * 1000);
  },
  shot(S, pos, lookAt, o = {}) {
    const cam = this.engine.get('camera');
    if (!cam || !cam.cinematic) return;
    pos = this.clearShot(pos, lookAt, o.mirror);
    if (o.to && o.to.pos) o.to.pos = this.clearShot(o.to.pos, lookAt, o.mirror);
    const s = { pos, lookAt, fov: o.fov || 38, duration: o.duration || 4, cut: true, shake: o.shake || 0 };
    if (o.to) s.to = o.to;
    cam.cinematic({ shots: [s] });
    // the rig only moves the camera on its own update, after this cue: stand the lens on its cut NOW, so whatever
    // this cue spawns next (burst, radial kick, the cast check) is resolved against the camera that will show it
    const c = this.engine.camera;
    c.position.copy(pos); c.up.set(0, 1, 0); c.lookAt(lookAt);
    if (c.fov !== s.fov) { c.fov = s.fov; c.updateProjectionMatrix(); }
    c.updateMatrixWorld(true);
    this.castForShot(S, pos, lookAt);
    S.dof = true;
    this.focusDOF(S, pos);
  },
  /** the rest of the gang stays out of a heat cut: anyone standing in this lens's frame near the pair (in front of
   *  them, or behind them within 6 m, or overlapping either man on screen) is hidden for the cut, everyone else stays
   *  as the gallery. Restored in finish(). */
  castForShot(S, pos, look) {
    if (!S.others || !S.others.length) return;
    const c = this.engine.camera;
    const subj = S.target.humanoid.boneWorld('Head', _b), hero = S.player.humanoid.boneWorld('Head', _c);
    const ds = pos.distanceTo(subj);
    subj.project(c); hero.project(c);
    for (const o of S.others) {
      const e = o.e;
      let hide = false;
      for (const bone of ['Head', 'Spine1', 'Hips']) {
        const q = e.humanoid.boneWorld(bone, _a);
        const d = pos.distanceTo(q);
        q.project(c);
        if (q.z < -1 || q.z > 1 || Math.abs(q.x) > 1.15 || Math.abs(q.y) > 1.2) continue;
        const near = Math.hypot(q.x - subj.x, (q.y - subj.y) * 0.6) < 0.55 || Math.hypot(q.x - hero.x, (q.y - hero.y) * 0.6) < 0.45;
        if (d < ds + 0.4 || (d < ds + 6 && near)) { hide = true; break; }
      }
      e.group.visible = o.vis && !hide;
    }
  },
  /** portrait lens on the man taking the blow: focus on his Head bone, a narrow window, the street melts */
  focusDOF(S, from) {
    const pf = this.engine.get('postfx');
    if (!pf || !pf.setDOF || !S.target || !S.target.humanoid) return;
    const head = S.target.humanoid.boneWorld('Head', _d);
    pf.setDOF(true, { focus: Math.max(0.8, (from || this.engine.camera.position).distanceTo(head)), range: 1.4, strength: 0.9 });
  },
  /** 150 ms contact grade on every heat impact: contrast up, colour down, a flash, and the energy in a radial kick
   *  centred on the contact point. No chromatic kick: at the frame edges it split every window into RGB ghosts. */
  punchGrade(S, point, final) {
    const pf = this.engine.get('postfx');
    if (!pf || !pf.applyGrade || !pf.grade) return;
    const u = pf.grade.uniforms;
    if (!S.grade) S.grade = { contrast: pf._baseContrast != null ? pf._baseContrast : u.contrast.value, saturation: u.saturation.value };
    pf.applyGrade({ contrast: S.grade.contrast + 0.15, saturation: S.grade.saturation - 0.2 });
    pf.flash = Math.max(pf.flash || 0, 0.3);
    if (point) this.radialAt(point, final ? 1.0 : 0.8);
    S.gradeUntil = (this.engine.elapsed || 0) + 0.15;
  },
  /** postfx centres its radial blur on target + 1.1 m: hand it a stand-in target so the blur centres on the contact */
  radialAt(point, k = 1) {
    const pf = this.engine.get('postfx');
    if (!pf || !pf.onHit) return;
    this.engine.camera.updateMatrixWorld(true);
    pf.onHit({ target: { position: _a.set(point.x, point.y - 1.1, point.z) }, heavy: true, point }, k);
    pf.radial = Math.max(pf.radial || 0, 0.9 * k);
  },
  restoreGrade(S) {
    const pf = this.engine.get('postfx');
    if (!S || !S.grade || !pf || !pf.applyGrade) return;
    pf.applyGrade(S.grade);
    S.grade = null;
  },
  /** a cut must not start inside a wall, a shop front or a lamp post: try the shot as authored, then mirrored across
   *  the line of action, then slid toward the subject until the lens is in open air */
  clearShot(pos, look, mirror) {
    const w = this.engine.world;
    if (!w || !w.overlapSphere) return pos;
    const blocked = (p) => w.overlapSphere(p, 0.32, {}).some(h => !NOT_WALL.has(h.tag) || h.tag === 'vehicle');
    if (!blocked(pos)) return pos;
    if (mirror) {
      const m = pos.clone().sub(mirror.origin);
      const d = m.dot(mirror.axis);
      const alt = pos.clone().addScaledVector(mirror.axis, -2 * d);
      if (!blocked(alt)) return alt;
    }
    for (let k = 1; k <= 8; k++) {
      const p = pos.clone().lerp(look, k * 0.09);
      if (!blocked(p)) return p;
    }
    return pos;
  },
  face(e, x, z) { e.yaw = Math.atan2(x - e.position.x, z - e.position.z); e.group.rotation.y = e.yaw; },
  place(e, x, z) {
    const w = this.engine.world;
    e.position.set(x, w ? w.groundHeight(x, z) : e.position.y, z);
    e.group.position.copy(e.position);
  },
  impact(S, o) {
    const engine = this.engine, combat = this.combat || engine.get('combat'), cam = engine.get('camera');
    const def = combat.ATTACKS[o.final ? 'heat_finisher' : 'heat_wall'];
    const dmg = combat.applyHit(S.player, S.target, def, o.final ? 'heat_finisher' : 'heat_wall', null,
      { noReact: true, deferKo: true, point: o.point, dir: o.dir, dmg: o.dmg, vfx: false });
    if (cam && cam.shake) cam.shake(o.shake || 0.6, 0.4);
    combat.hitStop(o.stop || 90);
    combat.setSlowMo(o.slow || 0.15);
    this.punchGrade(S, o.point, !!o.final);
    if (o.final) {
      // the money frame: the kanji slams in again on the blow itself, and the finisher is named
      this.stampAside();
      this.title(TITLES[S.plan.name] || 'ヒートアクション', 1.1);
    }
    S.lastPoint = o.point.clone();
    engine.events.emit('heat:impact', { name: S.plan.name, index: S.impacts++, final: !!o.final, point: o.point.clone(), strength: o.strength || 1, damage: dmg, player: S.player, target: S.target });
  },

  // ------------------------------------------------------------------------------------------ 壁 wall slam
  wallSeq(S) {
    const engine = this.engine, p = S.player, t = S.target, combat = this.combat || engine.get('combat');
    const W = S.plan.wall.point.clone(), n = S.plan.wall.normal.clone(), tan = V(n.z, 0, -n.x);
    const ground = t.position.y;
    const toWall = n.clone().negate();
    const mirror = { origin: W.clone(), axis: tan.clone() };
    S.end = 1.85;
    const f0 = flat(V(t.position.x - p.position.x, 0, t.position.z - p.position.z));
    const hy = (y) => ground + y;
    // the man's head is kept at a scripted distance from the wall plane: his root is moved so the Head bone lands
    // exactly there whatever the pose does
    const headGap = (gap) => {
      t.humanoid.boneWorld('Head', _a);
      const cur = (_a.x - W.x) * n.x + (_a.z - W.z) * n.z;
      const k = gap + 0.1 - cur;
      this.place(t, t.position.x + n.x * k, t.position.z + n.z * k);
      this.place(p, t.position.x + n.x * 0.66, t.position.z + n.z * 0.66);
    };
    const contactPoint = () => {
      t.humanoid.boneWorld('Head', _a);
      const d = (_a.x - W.x) * n.x + (_a.z - W.z) * n.z;
      return V(_a.x - n.x * d, _a.y, _a.z - n.z * d);
    };

    this.cue(S, 0, () => {
      this.begin(S);
      this.face(p, t.position.x, t.position.z);
      this.face(t, p.position.x, p.position.z);
      const d = Math.hypot(t.position.x - p.position.x, t.position.z - p.position.z);
      if (d > 0.85) this.place(p, t.position.x - f0.x * 0.82, t.position.z - f0.z * 0.82);
      p.humanoid.play('grab', { loop: false, fade: 0.06, force: true, speed: 1.5 });
      t.humanoid.play('stumble', { loop: false, fade: 0.06, force: true, speed: 1.2 });
      t.setState('hit');
      const r = rightOf(f0);
      this.shot(S, V(p.position.x - f0.x * 1.9 + r.x * 0.8, hy(1.6), p.position.z - f0.z * 1.9 + r.z * 0.8), V(t.position.x, hy(1.25), t.position.z), { fov: 40 });
    });
    this.cue(S, 0.28, () => {
      // cut: he has spun the man round to face the wall
      const vx = W.x + n.x * 0.95, vz = W.z + n.z * 0.95;
      this.place(t, vx, vz); this.face(t, vx - n.x, vz - n.z);
      this.place(p, vx + n.x * 0.66, vz + n.z * 0.66); this.face(p, vx - n.x, vz - n.z);
      playClip(p.humanoid, this.clips.wall, { fade: 0.04 });
      playClip(t.humanoid, this.clips.wallV, { fade: 0.04 });
      this.shot(S, V(W.x + n.x * 1.4 + tan.x * 3.1, W.y - 0.18, W.z + n.z * 1.4 + tan.z * 3.1), V(W.x + n.x * 0.62, W.y - 0.3, W.z + n.z * 0.62),
        { fov: 38, mirror, to: { pos: V(W.x + n.x * 1.25 + tan.x * 2.6, W.y - 0.1, W.z + n.z * 1.25 + tan.z * 2.6) } });
    });
    this.track(S, 0.28, 0.50, (u) => headGap(0.62 - 0.55 * easeIn(u)));
    this.cue(S, 0.50, () => {
      headGap(0.07);
      const pt = contactPoint();
      // the lens first: the burst and the radial kick are resolved against the camera that shows them
      this.shot(S, V(W.x + n.x * 2.0 + tan.x * 1.7, pt.y + 0.12, W.z + n.z * 2.0 + tan.z * 1.7), V(pt.x + n.x * 0.35, pt.y - 0.18, pt.z + n.z * 0.35), { fov: 36, mirror });
      combat.vfx.wallHit(pt, n, 1.0);
      this.impact(S, { point: pt, dir: toWall, dmg: 12, stop: 80, slow: 0.15, shake: 0.5, strength: 0.8 });
    });
    this.cue(S, 0.53, () => combat.setSlowMo(1));
    this.track(S, 0.50, 0.72, (u) => headGap(0.07 + 0.41 * easeOut(u)));
    this.track(S, 0.72, 0.84, (u) => headGap(0.48 - 0.43 * easeIn(u)));
    this.cue(S, 0.84, () => {
      headGap(0.05);
      const pt = contactPoint();
      this.shot(S, V(W.x + n.x * 3.0 - tan.x * 2.3, hy(1.05), W.z + n.z * 3.0 - tan.z * 2.3), V(pt.x + n.x * 0.7, pt.y - 0.35, pt.z + n.z * 0.7), { fov: 38, mirror });
      combat.vfx.wallHit(pt, n, 1.5);
      combat.vfx.shock(V(t.position.x, ground + 0.02, t.position.z), 0.6);
      this.impact(S, { point: pt, dir: toWall, dmg: 30, stop: 110, slow: 0.08, shake: 0.9, strength: 1.3, final: true });
    });
    this.cue(S, 0.88, () => combat.setSlowMo(0.35));
    this.track(S, 0.84, 0.98, (u) => headGap(0.05 + 0.07 * u));
    this.cue(S, 0.98, () => {
      combat.setSlowMo(1);
      // he rebounds off the wall and goes down on his back, away from it
      t.humanoid.play('knockdown', { loop: false, force: true, fade: 0.08 });
      t.setState('down');
      t.velocity.copy(n).multiplyScalar(1.2 * 6);
      const sx = p.position.x + tan.x * 0.55 + n.x * 0.2, sz = p.position.z + tan.z * 0.55 + n.z * 0.2;
      S.step = { x0: p.position.x, z0: p.position.z, x1: sx, z1: sz };
      this.shot(S, V(W.x + n.x * 4.4 + tan.x * 2.2, hy(1.75), W.z + n.z * 4.4 + tan.z * 2.2), V(W.x + n.x * 1.5, hy(0.55), W.z + n.z * 1.5),
        { fov: 42, duration: 1.2, mirror, to: { pos: V(W.x + n.x * 4.9 + tan.x * 2.5, hy(1.9), W.z + n.z * 4.9 + tan.z * 2.5) } });
      combat.later(0.42, () => combat.vfx.dust(V(t.position.x, ground + 0.04, t.position.z), 1.2));
    });
    this.track(S, 0.98, 1.3, (u, s) => { if (s.step) this.place(p, s.step.x0 + (s.step.x1 - s.step.x0) * smooth(u), s.step.z0 + (s.step.z1 - s.step.z0) * smooth(u)); });
    this.track(S, 0.98, 1.6, (u, s) => {                           // the slide the knockdown velocity would give him
      const e = t, dt = s.dt || 0;
      if (e.velocity.lengthSq() > 1e-4) { const w = engine.world; const np = w ? w.moveCapsule(e.position, e.radius, e.height, _b.copy(e.velocity).multiplyScalar(dt)) : e.position; this.place(e, np.x, np.z); e.velocity.multiplyScalar(1 - dt * 6); }
    });
    this.cue(S, 1.6, () => this.outro());
  },

  // ------------------------------------------------------------------------------------------ 自転車 bicycle smash
  bikeSeq(S) {
    const engine = this.engine, p = S.player, t = S.target, combat = this.combat || engine.get('combat'), props = engine.get('props');
    const held = !!(S.plan.bike && S.plan.bike.held);
    const off = held ? 0.3 : 0;                                    // a bike already in hand skips the lift
    const T = (x) => x - off;
    S.end = T(1.95);
    const ground = t.position.y;
    const hy = (y) => ground + y;
    const body = S.plan.bike.body;
    let f = flat(V(t.position.x - p.position.x, 0, t.position.z - p.position.z));
    const down = t.state === 'down' || t.state === 'getup';

    this.cue(S, 0, () => {
      this.begin(S);
      if (held) {
        const w = p.weapon;
        p.humanoid.setWeapon(null);
        p.weapon = null;
        S.bikeMesh = w.mesh.children[0] || w.mesh;
        w.mesh.remove(S.bikeMesh);
        engine.scene.add(S.bikeMesh);
        this.dressHeroBike(S);
        S.bikeFollow = { w: 1 };
        this.standOff(S, f);
        playClip(p.humanoid, down ? this.clips.bikeLow : this.clips.bike, { fade: 0.08, at: 0.3 });
        this.victimBrace(S, down);
        const r = rightOf(f);
        this.shot(S, V(p.position.x + r.x * 1.5 - f.x * 0.6, hy(0.9), p.position.z + r.z * 1.5 - f.z * 0.6), V(p.position.x, hy(1.5), p.position.z), { fov: 40 });
      } else {
        // cut to him at the bicycle: he stoops, takes it by the frame and hoists it
        const bp = body.position.clone();
        const fb = flat(V(bp.x - p.position.x, 0, bp.z - p.position.z));
        if (!isFinite(fb.x)) fb.copy(f);
        this.place(p, bp.x - fb.x * 0.62, bp.z - fb.z * 0.62);
        this.face(p, bp.x, bp.z);
        S.bikeMesh = props && props.takeProp ? fixHeldProp(props.takeProp(body)) : null;
        if (S.bikeMesh) {
          engine.scene.add(S.bikeMesh);
          const m = body.mesh;
          S.bikeMesh.position.set(bp.x, bp.y, bp.z);
          if (m) S.bikeMesh.quaternion.setFromEuler(m.rotation);
          S.bikeFrom = { pos: S.bikeMesh.position.clone(), quat: S.bikeMesh.quaternion.clone() };
          this.dressHeroBike(S);
        }
        S.bikeFollow = { w: 0 };
        playClip(p.humanoid, down ? this.clips.bikeLow : this.clips.bike, { fade: 0.08 });
        t.humanoid.play(down ? 'knockdown' : 'hit_heavy', { loop: false, force: true, speed: 0.6 });
        const rb = rightOf(fb);
        this.shot(S, V(bp.x + rb.x * 2.6 - fb.x * 0.9, hy(0.7), bp.z + rb.z * 2.6 - fb.z * 0.9), V(bp.x - fb.x * 0.35, hy(0.8), bp.z - fb.z * 0.35),
          { fov: 40, duration: 1.2, to: { pos: V(bp.x + rb.x * 2.9 - fb.x * 1.2, hy(1.15), bp.z + rb.z * 2.9 - fb.z * 1.2) } });
      }
    });
    if (!held) this.track(S, 0.12, 0.3, (u) => { if (S.bikeFollow) S.bikeFollow.w = smooth(u); });
    S.grip = held ? -0.04 : 0.3;
    if (!held) this.track(S, 0.3, 0.46, (u) => { S.grip = 0.3 - 0.34 * smooth(u); });
    if (!held) this.cue(S, 0.42, () => {
      // cut: he is on top of the man with it overhead
      f = flat(V(t.position.x - p.position.x, 0, t.position.z - p.position.z));
      this.standOff(S, f);
      this.victimBrace(S, down);
    });
    this.cue(S, T(0.46), () => {
      // low, over the man's shoulder, looking up at him with the bicycle above his head
      const r = rightOf(f), vx = t.position.x, vz = t.position.z;
      this.shot(S, V(vx + r.x * 0.75 + f.x * 1.25, hy(0.95), vz + r.z * 0.75 + f.z * 1.25), V(p.position.x, hy(1.75), p.position.z),
        { fov: 44, to: { fov: 40 } });
      combat.setSlowMo(0.5);
    });
    this.cue(S, T(0.64), () => combat.setSlowMo(1));
    // on the way down he swings it round like a club: across his shoulders overhead, pointing at the man on contact,
    // so the front wheel comes down on the man's head and the whole thing reads in profile from the side. It pitches
    // with the swing: nose up behind the hands, level-ish on contact, driven on down through him for two frames
    const HIT = T(BIKE_HIT);
    // (on a man already on the floor the nose comes DOWN instead, so the front wheel lands on his chest)
    const P0 = down ? 0.6 : 1.2, P1 = down ? -0.45 : 0.85, P2 = down ? -0.65 : 0.4;
    this.track(S, T(0.62), HIT, (u) => { S.skew = 0.4 + 1.05 * smooth(u); S.pitch = P0 + (P1 - P0) * smooth(u); });
    this.track(S, HIT, HIT + BIKE_OVER, (u) => { S.pitch = P1 + (P2 - P1) * u; });
    this.cue(S, HIT, () => {
      if (S.bikeMesh) S.bikeMesh.updateMatrixWorld(true);
      // the front tyre comes down on his crown (on his chest when he is already on the floor): he is set so the
      // tyre MEETS the skull, never passes through it
      let pt = down ? null : this.seatUnderWheel(S, f);
      if (!pt) { pt = t.humanoid.boneWorld(down ? 'Spine1' : 'Head', V(0, 0, 0)); pt.y += 0.12; }
      // the lens first, so the burst, the radial kick and the cast check all resolve against the money frame
      this.contactShot(S, f, down);
      const blow = f.clone().setY(-0.5).normalize();
      combat.vfx.metal(pt, blow, 1.1);
      if (down) {
        combat.vfx.shock(V(t.position.x, ground + 0.02, t.position.z), 0.9);
        if ((engine.time.wet || 0) > 0.3) combat.vfx.splash(V(t.position.x, ground, t.position.z), 1.3);
      } else combat.later(0.42, () => combat.vfx.dust(V(t.position.x, ground + 0.04, t.position.z), 1.25));
      this.impact(S, { point: pt, dir: f, dmg: 48, stop: 110, slow: 0.1, shake: 1.0, strength: 1.5, final: true });
      if (down) { const a = t.humanoid.play('knockdown', { loop: false, force: true, fade: 0.05 }); if (a) a.time = 0.45; }   // bounced off the floor
      else { t.humanoid.play('knockdown', { loop: false, force: true, fade: 0.04 }); t.velocity.copy(f).multiplyScalar(0.9 * 6); }
      t.setState('down');
      if (!down && combat.flinch) combat.flinch(t, pt, f.clone().setY(-0.6).normalize(), null, 0.55);
    });
    this.cue(S, HIT + 0.04, () => combat.setSlowMo(0.4));
    this.cue(S, HIT + BIKE_OVER, () => this.breakLoose(S));
    this.track(S, HIT, T(1.6), (u, s) => {
      const e = t, dt = s.dt || 0;
      if (e.velocity.lengthSq() > 1e-4) { const w = engine.world; const np = w ? w.moveCapsule(e.position, e.radius, e.height, _b.copy(e.velocity).multiplyScalar(dt)) : e.position; this.place(e, np.x, np.z); e.velocity.multiplyScalar(1 - dt * 6); }
    });
    this.cue(S, T(1.02), () => {
      combat.setSlowMo(1);
      const r = rightOf(f), mx = (p.position.x + t.position.x) / 2, mz = (p.position.z + t.position.z) / 2;
      this.shot(S, V(mx + r.x * 3.6 - f.x * 2.4, hy(1.8), mz + r.z * 3.6 - f.z * 2.4), V(t.position.x, hy(0.55), t.position.z),
        { fov: 42, duration: 1.2, to: { pos: V(mx + r.x * 4.0 - f.x * 2.9, hy(1.95), mz + r.z * 4.0 - f.z * 2.9) } });
    });
    this.cue(S, T(1.75), () => this.outro());
  },

  /** the money shot on the contact frame. The bicycle is held across his shoulders, so it only reads in profile from
   *  along the line of action: the lens goes low on the man's side of the pair, 3/4 off the line, looking at the
   *  man's head with the hero's face and the wheels behind it. If the frame would hide the head, slide/mirror. */
  contactShot(S, f, down) {
    const engine = this.engine, t = S.target, r = rightOf(f), ground = t.position.y;
    const raw = (engine.params && engine.params.raw) || {};
    let F = -0.6, R = 3.2, Y = 1.05, fov = 42;
    if (raw.hcc) { const v = String(raw.hcc).split(',').map(Number); if (v.length >= 3 && v.every(isFinite)) { [F, R, Y] = v; if (v[3]) fov = v[3]; } }
    if (down) { F = 1.4; R = 1.6; Y = 0.75; }
    const head = t.humanoid.boneWorld(down ? 'Spine2' : 'Head', V(0, 0, 0));
    const hands = S.player.humanoid.boneWorld('LeftHand', V(0, 0, 0)).add(S.player.humanoid.boneWorld('RightHand', V(0, 0, 0))).multiplyScalar(0.5);
    const look = head.clone().lerp(hands, 0.3);
    if (!down) look.y = Math.max(look.y, ground + 1.58);                 // hold the whole frame of the bike above him
    let pos = V(t.position.x + f.x * F + r.x * R, ground + Y, t.position.z + f.z * F + r.z * R);
    pos = this.unoccluded(S, pos, head, r, t.position);
    this.shot(S, pos, look, { fov, mirror: { origin: t.position.clone(), axis: r.clone() } });
  },
  /** a lens from which BOTH faces read: the man's head is not behind the bicycle, and neither face is behind an arm,
   *  a body or one of the other thugs (bone capsules: upper arm 6 cm, forearm 5.5 cm, torso 16 cm, head 10 cm; a
   *  man's own head and torso never count against his own face). Tries the authored spot, then swings round the
   *  man's head (±0.2 / ±0.4 rad), slides outward and cranes; the spot with the fewest blockers wins. */
  unoccluded(S, pos, head, r, origin) {
    const hero = S.hero;
    if (hero && S.bikeMesh) S.bikeMesh.updateMatrixWorld(true);
    const ray = this._ray || (this._ray = new THREE.Raycaster());
    const face = (e) => {
      const f = e.forward(V(0, 0, 0));
      return e.humanoid.boneWorld('Head', V(0, 0, 0)).addScaledVector(f, 0.07).add(V(0, 0.07, 0));
    };
    const faces = [[S.target, face(S.target)], [S.player, face(S.player)]];
    const segs = [];
    for (const e of [S.player, S.target, ...(S.others || []).map(o => o.e).filter(e => e.group.visible)]) {
      const B = (n) => e.humanoid.boneWorld(n, V(0, 0, 0));
      const LA = B('LeftArm'), LF = B('LeftForeArm'), LH = B('LeftHand'), RA = B('RightArm'), RF = B('RightForeArm'), RH = B('RightHand');
      const Hp = B('Hips'), Nk = B('Neck'), Hd = B('Head');
      segs.push([LA, LF, 0.06, e, 0], [LF, LH, 0.055, e, 0], [RA, RF, 0.06, e, 0], [RF, RH, 0.055, e, 0], [Hp, Nk, 0.16, e, 1], [Nk, Hd, 0.1, e, 1]);
      if (e === S.player) segs.push([LH, RH, 0.07, e, 0]);        // his fists on the frame
    }
    const end = V(0, 0, 0);
    const blockers = (p) => {
      let n = 0;
      for (const [who, fp] of faces) {
        const L = p.distanceTo(fp);
        end.copy(fp).sub(p).multiplyScalar((L - 0.12) / L).add(p);
        for (const [a, b, rad, e, body] of segs) {
          // a man's own head/torso never hides his face; the victim's forearms thrown over his head ARE the reaction
          if (e === who && (body || who === S.target)) continue;
          if (segSegDist2(p, end, a, b) < rad * rad) { n++; break; }
        }
      }
      if (hero) {                                                  // the bicycle over the man's face
        for (const q of [head, faces[0][1]]) {
          const d = q.clone().sub(p), L = d.length();
          ray.set(p, d.multiplyScalar(1 / L)); ray.far = L - 0.1;
          if (ray.intersectObject(hero, true).length) { n++; break; }
        }
      }
      return n;
    };
    let best = pos, bn = blockers(pos);
    this.lensBlockers = bn;
    if (!bn) return pos;
    // stay on the side of the line of action (both men in profile): slide along it, crane, pull back; never swing
    // round behind the hero, which trades a covered face for his back
    const out = Math.sign(pos.clone().sub(origin).dot(r)) || 1;
    const f = V(-r.z, 0, r.x).multiplyScalar(-1);                  // r = right of f  =>  f = (r.z, 0, -r.x)
    const cands = [];
    for (const [df, dy] of [[0.3, 0], [-0.3, 0], [0, 0.2], [0, -0.15], [0.3, 0.2], [-0.3, 0.2], [0.6, 0], [-0.6, 0], [0.6, 0.25], [-0.6, 0.25]]) {
      cands.push(pos.clone().addScaledVector(f, df).add(V(0, dy, 0)));
    }
    for (let k = 1; k <= 2; k++) cands.push(pos.clone().addScaledVector(r, 0.5 * k * out).add(V(0, 0.15 * k, 0)));
    for (const q of cands) {
      const n = blockers(q);
      if (n < bn) { bn = n; best = q; if (!n) break; }
    }
    this.lensBlockers = bn;
    return best;
  },

  /** contact geometry of the smash: the front tyre (0.33 m round the hub) must touch the man's crown. His root slides
   *  (a few cm, on a cut) so the crown sits on the tyre's lower-front arc in the bicycle's plane. Returns the contact
   *  point on the tyre. */
  seatUnderWheel(S, f) {
    const hero = S.hero, t = S.target;
    if (!hero) return null;
    hero.updateMatrixWorld(true);
    const hub = hero.localToWorld(V(0.62, 0.325, 0));
    const R = 0.34, r = rightOf(f);
    const crown = () => { const h = t.humanoid.boneWorld('Head', V(0, 0, 0)); h.y += 0.16; return h; };
    let c = crown();
    const dy = hub.y - c.y;
    const dx = dy < R ? Math.sqrt(R * R - dy * dy) : 0;
    const along = (hub.x - c.x) * f.x + (hub.z - c.z) * f.z + dx;          // move the crown to hub + f·dx
    const side = (hub.x - c.x) * r.x + (hub.z - c.z) * r.z;               // ...and into the bicycle's plane
    const k = Math.min(1, 0.5 / Math.max(0.5, Math.hypot(along, side)));     // never more than 50 cm (on a cut)
    this.place(t, t.position.x + (f.x * along + r.x * side) * k, t.position.z + (f.z * along + r.z * side) * k);
    t.group.updateMatrixWorld(true);
    c = crown();
    this.wheelGap = +(hub.distanceTo(c) - R).toFixed(3);
    this.wheelMove = [+along.toFixed(3), +side.toFixed(3), +dy.toFixed(3), +k.toFixed(2)];
    return c.sub(hub).setLength(R).add(hub);
  },

  /** stand him in striking distance of the man, facing him */
  standOff(S, f) {
    const p = S.player, t = S.target;
    const d = t.state === 'down' || t.state === 'getup' ? 1.05 : 1.12;
    this.place(p, t.position.x - f.x * d, t.position.z - f.z * d);
    this.face(p, t.position.x, t.position.z);
  },
  victimBrace(S, down) {
    const t = S.target, p = S.player;
    if (down) return;
    this.face(t, p.position.x, p.position.z);
    if (this.clips.cower) playClip(t.humanoid, this.clips.cower, { fade: 0.1 }); else t.humanoid.play('guard', { fade: 0.1, force: true });
    t.setState('hit');
  },

  /** the bicycle is lifted level, like a barbell: long axis across his shoulders, wheels down, gripped on the top
   *  tube; it tips back a little above his head and forward as it comes down, so its bottom leads into the man */
  followBike(S) {
    const m = S.bikeMesh, F = S.bikeFollow; if (!m || !F) return;
    const h = S.player.humanoid;
    const L = h.boneWorld('LeftHand', _a), R = h.boneWorld('RightHand', _b);
    const mid = _c.addVectors(L, R).multiplyScalar(0.5);
    h.boneWorld('LeftArm', _sh); h.boneWorld('RightArm', _fr);
    _sh.add(_fr).multiplyScalar(0.5);
    const arm = _d.subVectors(mid, _sh).normalize();
    const f = S.player.forward(_fw);
    const sk = S.skew != null ? S.skew : 0.4;
    // long axis: held a little skew across the shoulders, swung round to point at the man, then pitched with the swing
    const w = smooth(clamp((sk - 0.4) / 1.05));
    const pitch = w * (S.pitch != null ? S.pitch : 0);
    const x = _fx.set(-f.z, 0, f.x).multiplyScalar(Math.cos(sk)).addScaledVector(f, Math.sin(sk)).normalize();
    x.multiplyScalar(Math.cos(pitch)).addScaledVector(_UP, Math.sin(pitch)).normalize();
    // wheels up the frame's own vertical plane; while it is still across his shoulders it tips back over his head
    const y = _fy.copy(_UP).addScaledVector(x, -x.y).normalize();
    const tau = (1 - w) * clamp((Math.asin(clamp(arm.y, -1, 1)) - 0.78) * 0.45, -0.4, 0.35);
    if (tau) {
      const hz = _hz.crossVectors(x, y);
      y.multiplyScalar(Math.cos(tau)).addScaledVector(hz, Math.sin(tau) * (hz.dot(f) > 0 ? -1 : 1)).normalize();
    }
    const z = _fz.crossVectors(x, y).normalize();
    _m.makeBasis(x, y, z);
    _q.setFromRotationMatrix(_m);
    // grip: on the top tube while he hoists it, then shifted down to the bottom bracket once it is overhead, so the
    // wheels come down ON the man's head rather than hanging in front of his face
    const pos = _pos.copy(mid).addScaledVector(x, -0.11).addScaledVector(y, -(S.grip != null ? S.grip : 0.3));
    if (F.w >= 1 || !S.bikeFrom) { m.position.copy(pos); m.quaternion.copy(_q); }
    else { m.position.lerpVectors(S.bikeFrom.pos, pos, F.w); m.quaternion.slerpQuaternions(S.bikeFrom.quat, _q, F.w); }
  },

  // ------------------------------------------------------------------------------------------ the hero bicycle
  heroBike() { return this._heroBike || (this._heroBike = buildHeroBike()); },
  /** chrome needs the city in it, not the 0.3 ambient share */
  bikeEnv(hero) {
    const env = this.engine.scene.environment;
    if (!env || hero.userData.env === env) return;
    hero.userData.env = env;
    hero.traverse(o => { if (o.isMesh && o.material.metalness >= 0.8) { o.material.envMap = env; o.material.envMapIntensity = 1.5; o.material.needsUpdate = true; } });
  },
  /** the taken prop keeps its transform (followBike / the tumble drive it); only what is drawn changes */
  dressHeroBike(S) {
    const wrap = S.bikeMesh; if (!wrap || S.hero) return;
    const hero = this.dressWrap(wrap);
    if (!hero) return;
    S.hero = hero; S.heroHidden = wrap.userData.heroHidden;
  },
  /** swap the drawn bicycle inside a taken-prop wrap for the hero one (combat.pickUp uses it for the held weapon) */
  dressWrap(wrap) {
    let hero;
    try { hero = this.heroBike(); } catch (err) { console.warn('[heatActions] hero bike', err); return null; }
    if (hero.parent === wrap) return hero;
    this.bikeEnv(hero);
    hero.visible = true;
    const inner = wrap.children[0];
    const hidden = [];
    for (const c of wrap.children) if (c.visible) { c.visible = false; hidden.push(c); }
    hero.position.set(0, inner ? inner.position.y : -0.34, 0); hero.rotation.set(0, 0, 0);
    wrap.add(hero);
    wrap.userData.heroHidden = hidden;
    return hero;
  },
  /** it breaks loose off his head and tumbles across the asphalt (still the hero bike: the prop only comes back
   *  once the cut is over, lying where this one came to rest) */
  breakLoose(S) {
    const engine = this.engine, m = S.bikeMesh; if (!m) return;
    S.bikeFollow = null;
    const f = S.player.forward(new THREE.Vector3()), r = rightOf(f);
    S.tumble = { v: f.clone().multiplyScalar(2.2).addScaledVector(r, 1.2).setY(3.0), w: V(4, 7, -3), bounces: 0,
      ground: engine.world ? engine.world.groundHeight(m.position.x, m.position.z) : 0 };
    engine.events.emit('combat:weapon', { entity: S.player, type: 'bike', action: 'break' });
  },
  stepTumble(S, dt) {
    const m = S.bikeMesh, T = S.tumble; if (!m || !T || dt <= 0) return;
    T.v.y -= 9.8 * dt;
    m.position.addScaledVector(T.v, dt);
    const wl = T.w.length();
    if (wl > 1e-4) m.quaternion.premultiply(_q.setFromAxisAngle(_a.copy(T.w).multiplyScalar(1 / wl), wl * dt));
    const floor = T.ground + 0.22;
    if (m.position.y < floor) {
      m.position.y = floor;
      if (T.v.y < 0) {
        if (T.bounces === 0) this.engine.events.emit('prop:impact', { point: m.position.clone(), strength: 2.0, type: 'bike' });
        T.v.y = -T.v.y * 0.3; T.v.x *= 0.55; T.v.z *= 0.55; T.w.multiplyScalar(0.45); T.bounces++;
      }
    }
    if (T.bounces >= 1) {                                          // settle onto its side
      const x = _b.set(1, 0, 0).applyQuaternion(m.quaternion).setY(0);
      if (x.lengthSq() < 1e-4) x.set(1, 0, 0);
      x.normalize();
      const z = _c.set(0, 1, 0), y = _d.crossVectors(z, x);
      _q.setFromRotationMatrix(_m.makeBasis(x, y, z));
      m.quaternion.slerp(_q, Math.min(1, dt * (T.bounces >= 2 ? 8 : 3)));
      T.w.multiplyScalar(Math.max(0, 1 - dt * 5));
    }
  },
  /** the physics body takes over again, lying where the hero bike came to rest */
  releaseBike(S, quiet) {
    const engine = this.engine, props = engine.get('props'), m = S.bikeMesh, body = S.plan.bike && S.plan.bike.body;
    S.bikeFollow = null;
    const tumbled = !!S.tumble;
    S.tumble = null;
    if (!m) return;
    S.bikeMesh = null;
    if (S.hero) { m.remove(S.hero); S.hero = null; }
    for (const c of S.heroHidden || []) c.visible = true;
    S.heroHidden = null;
    m.parent?.remove(m);
    if (!body || !props || !props.releaseProp) return;
    const f = S.player.forward(new THREE.Vector3()), r = rightOf(f);
    const pos = m.position.clone();
    pos.y = Math.max(pos.y, (engine.world ? engine.world.groundHeight(pos.x, pos.z) : 0) + (body.restY || 0.34));
    if (body.mesh) {
      if (tumbled) { _a.set(1, 0, 0).applyQuaternion(m.quaternion); body.mesh.rotation.set(0, Math.atan2(-_a.z, _a.x), Math.PI * 0.5); }
      else body.mesh.rotation.set(0, S.player.yaw + Math.PI / 2, Math.PI * 0.45);
    }
    props.releaseProp(body, pos, quiet ? null : f.clone().multiplyScalar(2.2).addScaledVector(r, 1.2).setY(3.0));
    if (!quiet && body.angularVelocity) body.angularVelocity.set(4, 7, -3);
    if (!tumbled) {
      engine.events.emit('combat:weapon', { entity: S.player, type: 'bike', action: 'break' });
      engine.events.emit('prop:impact', { point: pos.clone(), strength: 2.0, type: 'bike' });
    }
  },

  // ------------------------------------------------------------------------------------------ prompt
  updatePrompt(dt, t) {
    const engine = this.engine, s = this.prompt, p = engine.player;
    if (!s) return;
    let plan = null;
    if (p && p.heat >= 100 && !this.running && engine.state.mode === 'combat' && !engine.state.frozen) plan = this.available(p);
    if (engine.state.frozen && this._stagePrompt) plan = this._stagePrompt;
    s.visible = !!plan;
    if (!plan) return;
    const e = plan.target;
    s.position.set(e.position.x, e.position.y + (e.state === 'down' ? 0.9 : 2.12), e.position.z);
    const k = 1 + 0.06 * Math.sin((t || 0) * 7);
    s.scale.set(0.72 * k, 0.27 * k, 1);
  },

  // ------------------------------------------------------------------------------------------ staged screenshots
  /** called from combat.placeStage (combat inits first): re-site the tableau for the chosen finisher */
  placeStage(engine, base) {
    this.engine = this.engine || engine;
    const params = engine.params || {}, raw = params.raw || {};
    const kind = raw.hx === 'wall' ? 'wall' : raw.hx === 'bikelift' ? 'bikelift' : 'bike';
    const combat = engine.get('combat'), p = engine.player, list = (engine.get('enemy')?.list || []);
    if (!p || !list.length) return false;
    this.stageKind = kind;
    if (kind === 'wall') {
      const site = this.findStageWall(engine);
      if (!site) { console.warn('[heatActions] no wall for the staged slam'); return false; }
      const { W, n } = site;
      const t = list[0];
      this.place(t, W.x + n.x * 1.25, W.z + n.z * 1.25);
      this.face(t, W.x + n.x * 3, W.z + n.z * 3);
      this.place(p, W.x + n.x * 2.1, W.z + n.z * 2.1);
      this.face(p, W.x, W.z);
      this.stageSite = site;
    } else {
      const { yaw, fwd } = base;
      const t = list[0];
      this.place(t, p.position.x + fwd.x * 1.1, p.position.z + fwd.z * 1.1);
      this.face(t, p.position.x, p.position.z);
      p.yaw = yaw; p.group.rotation.y = yaw;
    }
    // the other two stand back at the edge of the ring
    const t0 = list[0], f = flat(V(t0.position.x - p.position.x, 0, t0.position.z - p.position.z)), r = rightOf(f);
    [[-2.2, 2.6], [2.5, 2.9]].forEach(([side, ahead], i) => {
      const e = list[i + 1]; if (!e) return;
      this.place(e, p.position.x + r.x * side + f.x * ahead, p.position.z + r.z * side + f.z * ahead);
      this.face(e, p.position.x, p.position.z);
    });
    void combat;
    return true;
  },

  /** a long building face near the crossing with open pavement in front of it (for ?hx=wall) */
  findStageWall(engine) {
    const combat = engine.get('combat');
    let best = null;
    const gy = (x, z) => (engine.world ? engine.world.groundHeight(x, z) : 0);
    for (let gx = -48; gx <= 48; gx += 2) {
      for (let gz = -44; gz <= 48; gz += 2) {
        const w = this.findWall({ position: V(gx, gy(gx, gz), gz) });
        if (!w || w.dist < 0.9 || w.dist > 1.6 || !['building', 'station', 'qfront', 'ekimaeBldg', 'magnet', 'seibu', 'markCity'].includes(w.tag)) continue;
        const n = w.normal, tan = V(n.z, 0, -n.x);
        // the same flat face 2.5 m either side, and nothing standing within 2 m of it
        let ok = true;
        for (const s of [-2.5, 2.5]) {
          const q = V(w.point.x + n.x * 1.2 + tan.x * s, 0, w.point.z + n.z * 1.2 + tan.z * s);
          const w2 = this.findWall({ position: V(q.x, gy(q.x, q.z), q.z) });
          if (!w2 || Math.abs(w2.dist - 1.2) > 0.15 || w2.normal.dot(n) < 0.98) { ok = false; break; }
        }
        if (!ok) continue;
        let c = 9;
        if (combat) for (const [a, t] of [[2.0, 0], [3.4, 0], [2.0, 2.4], [2.0, -2.4]]) c = Math.min(c, combat.clearance(w.point.x + n.x * a + tan.x * t, w.point.z + n.z * a + tan.z * t) + a * 0.0);
        if (c < 1.1) continue;
        const score = c * 0.4 - Math.hypot(gx, gz) * 0.03;
        if (!best || score > best.score) best = { score, W: V(w.point.x, 0, w.point.z), n: n.clone(), tag: w.tag };
      }
    }
    if (best) console.info(`[heatActions] stage wall: ${best.tag} at ${best.W.x.toFixed(1)},${best.W.z.toFixed(1)} n=${best.n.x.toFixed(2)},${best.n.z.toFixed(2)}`);
    return best;
  },

  /** at engine:booted: run the real timeline up to its contact frame (or ?ht=) and freeze everything there */
  applyStage() {
    const engine = this.engine, combat = this.combat || engine.get('combat'), cam = engine.get('camera'), hud = engine.get('hud');
    const p = engine.player, list = (engine.get('enemy')?.list || []);
    if (!p || !list.length) return false;
    const params = engine.params || {}, raw = params.raw || {};
    const t = list[0];
    for (const e of [p, ...list]) { if (e.humanoid) { e.humanoid.frozenPose = false; e.humanoid.play(e === t || e === p ? 'idle_combat' : 'guard', { fade: 0, force: true }); e.humanoid.mixer.update(0.5); } }
    p.heat = 100; p.hp = 71;
    t.hp = t.hpMax;
    t.setState('hit');
    if (raw.hdown) { t.setState('down'); t.humanoid.play('knockdown', { fade: 0, force: true, loop: false }); t.humanoid.mixer.update(1.5); }   // &hdown=1 debug
    let plan = null;
    if (this.stageKind === 'wall') {
      const wall = this.findWall(t);
      if (wall) plan = { name: 'wall_slam', target: t, wall };
    } else if (this.stageKind === 'bikelift') {
      // a bicycle parked at arm's length: he has to stoop for it first
      const d = this.nearestBike(p.position, 500);
      if (d) {
        const f = p.forward(new THREE.Vector3()), r = rightOf(f);
        const bx = p.position.x + r.x * 1.5 - f.x * 0.3, bz = p.position.z + r.z * 1.5 - f.z * 0.3;
        d.body.position.set(bx, (engine.world ? engine.world.groundHeight(bx, bz) : 0) + (d.body.restY || 0.34), bz);
        if (d.body.mesh) d.body.mesh.rotation.set(0, p.yaw + 0.3, 0.05);
        plan = { name: 'bicycle_smash', target: t, bike: { rec: d, body: d.body } };
      }
    } else {
      // put a bicycle in his hands the way a pick-up would, then heat it
      const d = this.nearestBike(p.position, 500);
      if (d && combat) {
        const saved = d.body.position.clone();
        d.body.position.set(p.position.x, d.body.position.y, p.position.z);
        if (!combat.pickUp(p, 1.0)) d.body.position.copy(saved);
        combat.active.length = 0;
        if (p.weapon) plan = { name: 'bicycle_smash', target: t, bike: { held: p.weapon, body: p.weapon.body } };
      }
    }
    if (!plan) { console.warn('[heatActions] staged heat: no plan'); return false; }
    if (combat) { combat.noStop = false; combat.vfx.clear(); }
    const S = this.start(plan, true);
    // 60 ms (real) into the contact hit-stop: the wheel is on him, the core flash has come and gone, the shards and
    // the spark fountain are open
    const contact = plan.name === 'wall_slam' ? 0.84 + 0.003 : BIKE_HIT - (plan.bike.held ? 0.3 : 0) + 0.003;
    const ht = raw.ht != null && raw.ht !== '' && !isNaN(Number(raw.ht)) ? Number(raw.ht) : contact;
    this.scrub(ht);
    // freeze: poses, camera, VFX exactly as they are on this frame
    for (const e of [p, ...list]) if (e.humanoid) e.humanoid.frozenPose = true;
    if (cam && cam.setFixed) {
      const c = engine.camera;
      if (raw.hcam === 'side' || raw.hcam === 'q') {               // a plain side / 3-4 view of the pair (choreography check)
        const f = flat(V(t.position.x - p.position.x, 0, t.position.z - p.position.z)), r = rightOf(f);
        const mx = (p.position.x + t.position.x) / 2, mz = (p.position.z + t.position.z) / 2, y = p.position.y;
        if (raw.hcam === 'q') cam.setFixed(V(mx + r.x * 2.2 - f.x * 1.6, y + 1.9, mz + r.z * 2.2 - f.z * 1.6), V(mx, y + 1.3, mz), { fov: 40 });
        else cam.setFixed(V(mx + r.x * 4.2, y + 1.3, mz + r.z * 4.2), V(mx, y + 1.0, mz), { fov: 40 });
      } else {
        const look = c.getWorldDirection(new THREE.Vector3()).multiplyScalar(4).add(c.position);
        cam.setFixed(c.position.clone(), look, { fov: c.fov });
      }
    }
    this.setCine(true);
    // the still keeps the flash and a strong radial kick centred on the contact; the grade punch is let go (the
    // chromatic split it used to carry is gone anyway)
    const pfx = engine.get('postfx');
    this.restoreGrade(S);
    if (pfx && S.impacts && S.lastPoint) {
      this.radialAt(S.lastPoint, 1);
      pfx.hold = { flash: 0.08, radial: raw.camnoblur ? 0 : 0.55, heat: 1 };      // camnoblur: debug, judge the pose
    }
    if (hud) {
      hud.letterbox(true);
      for (const e of list) if (e.alive) hud.showEnemy(e);
      hud.objective('チンピラを倒せ');
      // the stamp and the title are part of the money frame: held on screen at full size for the still
      const st = S.impacts ? this.stampAside() : (hud.stamp && hud.stamp('極'), hud.el && hud.el.stamp);
      if (st) { st.style.animationDelay = '-0.36s'; st.style.animationPlayState = 'paused'; }
      if (S.impacts) {
        this.title(TITLES[plan.name] || 'ヒートアクション', 0);
        const tl = this._title;
        if (tl) { tl.style.animationDelay = '-0.3s'; tl.style.animationPlayState = 'paused'; }
      }
    }
    const hL = p.humanoid.boneWorld('LeftHand', V(0, 0, 0)), hS = p.humanoid.boneWorld('LeftArm', V(0, 0, 0)), hd = t.humanoid.boneWorld('Head', V(0, 0, 0));
    const bm = S.hero || S.bikeMesh;
    console.info(`[heatActions] staged ${plan.name} at t=${ht.toFixed(3)} (game s) — impacts ${S.impacts}, vfx ${combat ? combat.vfx.nQuads + ' quads / ' + combat.vfx.nSparks + ' sparks' : '-'}` +
      `, lens blockers ${this.lensBlockers != null ? this.lensBlockers : '-'}, hands ${hL.y.toFixed(2)} vs shoulders ${hS.y.toFixed(2)}, his head ${hd.y.toFixed(2)}` +
      (bm ? `, front hub ${bm.localToWorld(V(0.62, 0.325, 0)).distanceTo(hd).toFixed(2)} m from his head` : '') +
      `, tyre-crown gap ${this.wheelGap != null ? this.wheelGap : '-'} m (move ${JSON.stringify(this.wheelMove)}), hidden ${(S.others || []).filter(o => !o.e.group.visible).length}/${(S.others || []).length}`);
    return true;
  },

  /** step the timeline, the actors' mixers, the VFX and the camera at 60 Hz real time up to game time `tEnd` */
  scrub(tEnd) {
    const S = this.running; if (!S) return;
    const engine = this.engine, combat = this.combat || engine.get('combat'), cam = engine.get('camera');
    let real = combat ? combat.now : 0, guard = 0;
    while (S.t < tEnd - 1e-6 && guard++ < 4000) {
      const sp = engine.time.speed || 1;
      const dt = Math.min((1 / 60) * sp, tEnd - S.t);
      for (const e of S.actors) if (e.humanoid && !e.humanoid.frozenPose) e.humanoid.mixer.update(dt);
      if (combat && combat.updateFlinch) combat.updateFlinch(dt);
      for (const e of S.actors) e.group.updateMatrixWorld(true);
      this.tick(dt);
      if (combat) {
        for (let i = combat.timers.length - 1; i >= 0; i--) { const tm = combat.timers[i]; tm.t -= dt; if (tm.t <= 0) { combat.timers.splice(i, 1); try { tm.fn(); } catch (err) { /* staged */ } } }
        const rdt = dt / sp;                                       // the same clocks the live frame gives the VFX
        combat.vfx.step(dt, combat.hitStopUntil ? rdt * 0.25 : dt, false, rdt);
        real += rdt;
        combat.clock(real);
      }
      if (cam && cam.update) cam.update(dt);
    }
  },

  selfTest() {
    const out = { ok: true, problems: [], finishers: FINISHERS.slice() };
    const c = this.buildClips();
    for (const k of ['wall', 'wallV', 'bike', 'bikeLow']) { if (!c[k]) out.problems.push('clip ' + k); else out[k] = +c[k].duration.toFixed(2); }
    if (FINISHERS.length !== 2) out.problems.push(`${FINISHERS.length} finishers (Plan A: 2)`);
    out.ok = out.problems.length === 0;
    return out;
  },

  dispose() { if (this._stageTimer) clearInterval(this._stageTimer); },
};

export default heatActions;
