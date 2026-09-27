// [mobility] LOOP（ループ）— the e-kickboard share (real: LUUP, docs/NAMES.md). Ports on the real sites
// (src/world/loopPorts.js), docked boards, renting / riding / returning, the ride HUD, minimap + world-map icons,
// the motor whine. Rules as in the real service: you rent and return ONLY at a port; ¥50 + ¥15 per started minute
// (game time). Speeds are game speeds (LOOP_SPEED: one 50 km/h cap on the carriageway and the pavement; if the two
// caps ever differ again, the 車道 / 歩道 chip and the 歩道モード lamp come back).
//
//   loop.ports[]                 { ...LOOP_PORTS row, W, D, slotsDocked[] }
//   loop.ride                    null | { port, t, v, steer, mode:'road'|'pave', fare() }
//   loop.canRide()               the story / fight / cutscene gate (also: no live enemy anywhere)
//   loop.startRide(port)  loop.endRide(reason)       reason: 'return' | 'forced' | 'crash'
//   loop.nearestPort(x, z, needFree)   loop.freeBoards(port)   loop.fare(seconds)
//   engine.player.riding (bool) — player.js yields movement to this module while it is set;
//   engine.player.avoidR — crowd.js widens its player-avoid ring at speed.
//
// Cost: the whole network is 6 draw calls (bay paint, sign bodies, sign faces, board bodies, board lamps, contact
// blobs — each one merged or instanced across all ports; the boards only for bays within 110 m of the lens), plus 3
// for the ridden board while riding; the wet-road mirror and the bloom pass see some of them again (+8..10 in all,
// measured). ?loop=0 leaves the module out (A/B). ?shot=loop_port: 健人 on a board at the MAGNET bay.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { isRoad } from './cityData.js';
import { LOOP_PORTS, LOOP_BRAND, LOOP_FARE, LOOP_SPEED } from './loopPorts.js';

const KMH = 1 / 3.6;
const V_ROAD = LOOP_SPEED.road * KMH, V_PAVE = LOOP_SPEED.pavement * KMH;
// motor pull (m/s²) and tyre grip (lateral m/s²) sized for 50 km/h: 0→50 km/h in ~3.8 s; the tightest turn at 50 km/h
// is a ~19 m radius, at 25 km/h ~5 m
const ACCEL = 4.0, GRIP = 10.0;
const ONE_CAP = LOOP_SPEED.road === LOOP_SPEED.pavement;         // no 車道 / 歩道 distinction to show
const SLOT_W = 0.62, DECK = 0.135, WHEELBASE = 0.9, DOCK_R = 110;
const RENT_TXT = 'LOOPに乗る（基本¥50＋¥15/分）';
const SANS = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3(), _f = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3(), _p = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

// ------------------------------------------------------------------------------------------------ geometry
function tint(geo, hex) {
  const c = new THREE.Color(hex), n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  return geo;
}
function at(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(1, 1, 1));
  return geo.applyMatrix4(_m);
}
const box = (w, h, d, col, x, y, z, rx, ry, rz) => tint(at(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz), col);
// a cylinder whose axis runs along x (wheels, bars)
const cylX = (r, len, col, x, y, z, seg = 12) => tint(at(new THREE.CylinderGeometry(r, r, len, seg), x, y, z, 0, 0, Math.PI / 2), col);
function cylAB(r, a, b, col, seg = 8) {                      // a cylinder from point a to point b
  const g = new THREE.CylinderGeometry(r, r, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), seg);
  _q.setFromUnitVectors(_v.set(0, 1, 0), _w.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize());
  _m.compose(_v.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q, _s.set(1, 1, 1));
  return tint(g.applyMatrix4(_m), col);
}

// The board: local +z = nose, y up, the wheels' contact patch at y = 0; deck top at DECK. Real proportions of the
// share e-kickboards on Shibuya's streets: ~1.1 m long, 8" wheels, bar at ~1.03 m, a slim raked stem in the brand
// colour, black deck, rear fender with the number plate and tail lamp, a phone-size display on the bar.
const GRAPH = '#25292d', RUBBER = '#101113', STEEL = '#8a9095';
function boardGeometry() {
  const T = LOOP_BRAND.teal, stemA = [0, 0.33, 0.445], stemB = [0, 1.0, 0.345];
  const body = [
    box(0.19, 0.05, 0.84, GRAPH, 0, 0.108, -0.035),                              // deck
    box(0.165, 0.005, 0.7, '#0c0d0f', 0, 0.1355, -0.05),                          // grip tape
    box(0.005, 0.02, 0.74, T, 0.0955, 0.108, -0.035), box(0.005, 0.02, 0.74, T, -0.0955, 0.108, -0.035),
    box(0.08, 0.06, 0.14, GRAPH, 0, 0.15, 0.39, -0.35),                           // neck to the fork
    box(0.022, 0.25, 0.03, GRAPH, 0.037, 0.215, 0.452), box(0.022, 0.25, 0.03, GRAPH, -0.037, 0.215, 0.452),
    box(0.1, 0.035, 0.055, GRAPH, 0, 0.335, 0.448),                               // fork crown
    box(0.075, 0.012, 0.17, T, 0, 0.212, 0.47, 0.15),                             // front fender
    cylX(0.1, 0.055, RUBBER, 0, 0.1, 0.46), cylX(0.055, 0.062, STEEL, 0, 0.1, 0.46, 8),
    cylX(0.1, 0.055, RUBBER, 0, 0.1, -0.47), cylX(0.06, 0.062, STEEL, 0, 0.1, -0.47, 8),
    box(0.095, 0.012, 0.24, GRAPH, 0, 0.214, -0.5, 0.18),                         // rear fender
    box(0.108, 0.058, 0.006, '#e9e7dc', 0, 0.2, -0.617, -0.4),                    // number plate
    cylAB(0.027, stemA, [0, 0.52, 0.42], GRAPH),                                  // stem sleeve
    cylAB(0.021, [0, 0.5, 0.422], stemB, T),                                      // stem (brand colour)
    cylX(0.014, 0.52, GRAPH, 0, 1.012, 0.345, 6),                                // bar
    cylX(0.02, 0.105, RUBBER, 0.215, 1.012, 0.345, 8), cylX(0.02, 0.105, RUBBER, -0.215, 1.012, 0.345, 8),
    box(0.1, 0.01, 0.018, STEEL, 0.165, 1.01, 0.385, 0, 0.25), box(0.1, 0.01, 0.018, STEEL, -0.165, 1.01, 0.385, 0, -0.25),
    box(0.08, 0.032, 0.06, GRAPH, 0, 1.038, 0.36, -0.35),                         // display pod
    box(0.068, 0.05, 0.035, GRAPH, 0, 0.8, 0.418),                                // lamp housing
  ];
  const rideLamps = [
    box(0.058, 0.036, 0.012, '#fff6e2', 0, 0.8, 0.438),                           // headlight
    box(0.062, 0.018, 0.012, '#ff2414', 0, 0.237, -0.608, 0.18),                  // tail
    box(0.06, 0.004, 0.042, '#58f2dc', 0, 1.056, 0.362, -0.35),                   // display
  ];
  const dockLamps = [
    box(0.06, 0.004, 0.042, '#1fae9a', 0, 1.056, 0.362, -0.35),                   // the display's idle glow
    box(0.062, 0.018, 0.012, '#5a0c08', 0, 0.237, -0.608, 0.18),                  // tail reflector
  ];
  return { body: mergeGeometries(body), rideLamps: mergeGeometries(rideLamps), dockLamps: mergeGeometries(dockLamps) };
}

// ------------------------------------------------------------------------------------------------ textures
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
// the ground paint atlas: a white block for the lines, then the LOOP wordmark
function paintAtlas() {
  const c = canvas(512, 128), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 40, 128);
  g.font = `900 84px ${SANS}`; g.textBaseline = 'middle'; g.textAlign = 'left';
  g.fillText('LOOP', 76, 66);
  g.font = `800 40px ${SANS}`; g.fillText('ポート', 318, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function paintSign() {
  const c = canvas(256, 384), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 384); gr.addColorStop(0, '#2cc6b1'); gr.addColorStop(1, LOOP_BRAND.tealDeep);
  g.fillStyle = gr; g.fillRect(0, 0, 256, 384);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `900 72px ${SANS}`; g.fillText('LOOP', 128, 60);
  g.font = `700 24px ${SANS}`; g.fillText('ループ', 128, 106);
  // "P" disc, ポート, the kickboard pictogram
  g.beginPath(); g.arc(128, 186, 46, 0, Math.PI * 2); g.fill();
  g.fillStyle = LOOP_BRAND.tealDeep; g.font = `900 64px ${SANS}`; g.fillText('P', 128, 190);
  g.fillStyle = '#fff'; g.font = `800 30px ${SANS}`; g.fillText('ポート', 128, 262);
  g.strokeStyle = '#fff'; g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(84, 338); g.lineTo(162, 338); g.lineTo(172, 296); g.moveTo(160, 296); g.lineTo(186, 296); g.stroke();
  g.beginPath(); g.arc(90, 346, 9, 0, Math.PI * 2); g.arc(166, 346, 9, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function paintBlob() {
  const c = canvas(64, 128), g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 64, 4, 32, 64, 62);
  gr.addColorStop(0, 'rgba(0,0,0,.85)'); gr.addColorStop(0.55, 'rgba(0,0,0,.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.save(); g.translate(32, 64); g.scale(0.5, 1); g.translate(-32, -64); g.fillStyle = gr; g.fillRect(-32, 0, 128, 128); g.restore();
  return new THREE.CanvasTexture(c);
}
function paintBeam() {
  const c = canvas(64, 128), g = c.getContext('2d');
  for (let y = 0; y < 128; y++) {
    const k = y / 127, a = Math.pow(1 - k, 1.6) * Math.min(1, k * 8), half = 10 + 22 * k;
    const gr = g.createLinearGradient(32 - half, 0, 32 + half, 0);
    gr.addColorStop(0, 'rgba(255,245,225,0)'); gr.addColorStop(0.5, `rgba(255,245,225,${a.toFixed(3)})`); gr.addColorStop(1, 'rgba(255,245,225,0)');
    g.fillStyle = gr; g.fillRect(0, y, 64, 1);
  }
  return new THREE.CanvasTexture(c);
}

// ------------------------------------------------------------------------------------------------ two-bone IK
// Works on world positions only, so it holds for any bind pose / rig scale the hero model ships with.
function aimBone(bone, from, to, target) {
  _a.subVectors(to, from); _b.subVectors(target, from);
  if (_a.lengthSq() < 1e-10 || _b.lengthSq() < 1e-10) return;
  _q.setFromUnitVectors(_a.normalize(), _b.normalize());
  bone.getWorldQuaternion(_q2); _q2.premultiply(_q);
  bone.parent.getWorldQuaternion(_q3).invert();
  bone.quaternion.copy(_q3.multiply(_q2));
  bone.updateMatrixWorld(true);
}
function rotateBoneWorld(bone, axis, angle) {
  _q.setFromAxisAngle(axis, angle);
  bone.getWorldQuaternion(_q2); _q2.premultiply(_q);
  bone.parent.getWorldQuaternion(_q3).invert();
  bone.quaternion.copy(_q3.multiply(_q2));
  bone.updateMatrixWorld(true);
}
const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _C = new THREE.Vector3(), _P = new THREE.Vector3(), _E = new THREE.Vector3();
function twoBone(b0, b1, b2, target, pole) {
  if (!b0 || !b1 || !b2 || !b0.parent) return;
  b0.getWorldPosition(_A); b1.getWorldPosition(_B); b2.getWorldPosition(_C);
  const la = _A.distanceTo(_B), lb = _B.distanceTo(_C);
  if (la < 1e-4 || lb < 1e-4) return;
  _d.subVectors(target, _A); let dist = _d.length();
  dist = clamp(dist, Math.abs(la - lb) + 1e-3, la + lb - 1e-3);
  _d.normalize();
  _P.subVectors(pole, _A); _P.addScaledVector(_d, -_P.dot(_d));
  if (_P.lengthSq() < 1e-8) _P.set(0, -1, 0); else _P.normalize();
  const cosA = clamp((la * la + dist * dist - lb * lb) / (2 * la * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  _E.copy(_A).addScaledVector(_d, la * cosA).addScaledVector(_P, la * sinA);
  aimBone(b0, _A, _B, _E);
  b1.getWorldPosition(_B); b2.getWorldPosition(_C);
  _t.copy(_A).addScaledVector(_d, dist);
  aimBone(b1, _B, _C, _t);
}

// Bones the ride pose writes. Each frame they start from the skeleton's bind pose (the contract's relaxed A-pose:
// spine upright, legs straight), not from whatever the frame left: the mixer has no track for some of them and the
// humanoid's post-mixer passes (self-clip, hand clamps) nudge the rest, so an edit on top of either integrates.
const TOUCH = ['Spine', 'Spine1', 'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm'];
const REST = new WeakMap();
function restPose(h) {
  let r = REST.get(h); if (r) return r;
  r = {};
  const sk = h.skeleton, bones = sk ? sk.bones : [];
  for (const n of TOUCH) {
    const b = h.bones[n]; if (!b) continue;
    const i = bones.indexOf(b), pi = b.parent ? bones.indexOf(b.parent) : -1;
    if (i < 0 || pi < 0 || !sk.boneInverses[i] || !sk.boneInverses[pi]) { r[n] = b.quaternion.clone(); continue; }
    const world = new THREE.Matrix4().copy(sk.boneInverses[i]).invert();
    const local = new THREE.Matrix4().multiplyMatrices(sk.boneInverses[pi], world);
    const q = new THREE.Quaternion(); local.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    r[n] = q;
  }
  REST.set(h, r);
  return r;
}
function poseBegin(B, rest) { for (const n of TOUCH) if (B[n] && rest[n]) B[n].quaternion.copy(rest[n]); }
function poseSave(B) { const o = {}; for (const n of TOUCH) if (B[n]) o[n] = B[n].quaternion.clone(); return o; }
function poseRestore(B, saved) { if (!B || !saved) return; for (const n of TOUCH) if (B[n] && saved[n]) B[n].quaternion.copy(saved[n]); }

// ------------------------------------------------------------------------------------------------ module
const loop = {
  name: 'loop',
  ports: [],
  ride: null,
  engine: null,

  shotPresets: {
    // 健人 on a LOOP board beside the MAGNET port (north of the scramble), night, 3/4 view
    loop_port: () => {
      const p = LOOP_PORTS.find((q) => q.id === 'magnet');
      const r = p.rotY, nx = Math.sin(r), nz = Math.cos(r), ax = Math.cos(r), az = -Math.sin(r);
      // (the bay backs onto MAGNET in a 4 m lane: the lens stands down the lane, 健人 rolls toward it past the bay)
      const cx = p.x + nx * 1.3, cz = p.z + nz * 1.3;
      return {
        pos: [cx - ax * 5.2 + nx * 0.6, 1.6, cz - az * 5.2 + nz * 0.6], lookAt: [cx + ax * 0.2 - nx * 0.5, 0.8, cz + az * 0.2 - nz * 0.5], fov: 46, t: 'night',
        setup: (engine) => { const m = engine.get('loop'); if (m && m.shotSetup) m.shotSetup(); },
      };
    },
  },

  init(engine) {
    this.engine = engine;
    // ?loop=0: the module stays out entirely (A/B perf measurement)
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('loop') === '0') { this.off = true; return; }
    const world = engine.world;
    const gy = (x, z) => (world ? world.groundHeight(x, z) : 0);
    this.geo = boardGeometry();
    this.mats = {
      body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 }),
      lamp: new THREE.MeshBasicMaterial({ vertexColors: true }),
      paint: new THREE.MeshStandardMaterial({ color: LOOP_BRAND.teal, map: paintAtlas(), transparent: true, depthWrite: false, roughness: 0.55, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      signBody: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 }),
      blob: new THREE.MeshBasicMaterial({ map: paintBlob(), color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    };
    const signTex = paintSign();
    this.mats.signFace = new THREE.MeshStandardMaterial({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.5, roughness: 0.4 });

    // ports: bay paint + sign stands (merged), docked boards (instanced), colliders
    let nSlots = 0;
    const paint = { p: [], uv: [], n: [] }, signBodies = [], signFaces = [];
    const quad = (pts, uvs) => { const [a, b, c, d] = pts; const [ua, ub, uc, ud] = uvs;
      for (const [P, U] of [[a, ua], [b, ub], [c, uc], [a, ua], [c, uc], [d, ud]]) { paint.p.push(P[0], P[1], P[2]); paint.uv.push(U[0], U[1]); paint.n.push(0, 1, 0); } };
    const LINE_UV = [[0.012, 0.2], [0.06, 0.2], [0.06, 0.8], [0.012, 0.8]];
    for (const row of LOOP_PORTS) {
      const W = row.slots * SLOT_W + 0.3, D = row.slots <= 3 ? 1.3 : 1.6;
      const port = { ...row, W, D, base: nSlots, dock: [], cs: Math.cos(row.rotY), sn: Math.sin(row.rotY) };
      this.fitPort(port);
      for (let i = 0; i < row.slots; i++) port.dock.push(i < row.docked);
      // (spread the docked boards over the bay the way people leave them: gaps, not packed from one end)
      if (row.docked < row.slots) { port.dock.fill(false); for (let k = 0; k < row.docked; k++) port.dock[Math.round((k + 0.5) * row.slots / row.docked - 0.5)] = true; }
      nSlots += row.slots;
      this.ports.push(port);
      const toW = (lx, lz, y = 0.012) => { const x = port.x + lx * port.cs + lz * port.sn, z = port.z - lx * port.sn + lz * port.cs; return [x, gy(x, z) + y, z]; };
      const line = (x0, z0, x1, z1, w) => {                        // a painted stripe from (x0,z0) to (x1,z1), local
        const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz) || 1, ox = -dz / L * w / 2, oz = dx / L * w / 2;
        quad([toW(x0 - ox, z0 - oz), toW(x1 - ox, z1 - oz), toW(x1 + ox, z1 + oz), toW(x0 + ox, z0 + oz)], LINE_UV);
      };
      const hw = W / 2, hd = D / 2;
      line(-hw, -hd, hw, -hd, 0.07); line(-hw, hd, hw, hd, 0.07); line(-hw, -hd, -hw, hd, 0.07); line(hw, -hd, hw, hd, 0.07);
      for (let i = 1; i < row.slots; i++) { const x = -hw + 0.15 + i * SLOT_W; line(x, -hd + 0.12, x, hd - 0.12, 0.035); }
      // the wordmark in front of the bay, reading from the street
      const tw = Math.min(1.5, W * 0.62), th = tw / 4;
      // (a reader in the street faces −z: the text runs −x → +x, its top toward the bay)
      quad([toW(tw / 2, hd + 0.12), toW(-tw / 2, hd + 0.12), toW(-tw / 2, hd + 0.12 + th), toW(tw / 2, hd + 0.12 + th)],
        [[1, 1], [0.125, 1], [0.125, 0], [1, 0]]);
      // sign stand at the back corner
      const sx = hw + 0.3, sz = -hd + 0.25, [px, py, pz] = toW(sx, sz, 0);
      const sb = [box(0.34, 0.03, 0.26, '#1c2023', 0, 0.015, 0), box(0.05, 1.12, 0.05, GRAPH, 0, 0.58, 0),
        box(0.42, 0.58, 0.035, LOOP_BRAND.tealDeep, 0, 1.38, 0)];
      const g = mergeGeometries(sb); _m.compose(_v.set(px, py, pz), _q.setFromEuler(_e.set(0, row.rotY, 0)), _s.set(1, 1, 1)); g.applyMatrix4(_m);
      signBodies.push(g);
      const f = new THREE.PlaneGeometry(0.38, 0.54); f.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 1.38, 0.0185)); f.applyMatrix4(_m);
      signFaces.push(f);
      port.sign = new THREE.Vector3(px, py + 1.8, pz);
      if (world) {
        world.addStatic({ obb: { center: new THREE.Vector3(port.x, gy(port.x, port.z) + 0.55, port.z), halfSize: new THREE.Vector3(hw - 0.05, 0.55, hd - 0.12), rotationY: row.rotY } }, { tag: 'prop' });
        world.addStatic(new THREE.Box3(new THREE.Vector3(px - 0.12, py, pz - 0.12), new THREE.Vector3(px + 0.12, py + 1.7, pz + 0.12)), { tag: 'pole' });
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(paint.p, 3));
    pg.setAttribute('normal', new THREE.Float32BufferAttribute(paint.n, 3));
    pg.setAttribute('uv', new THREE.Float32BufferAttribute(paint.uv, 2));
    const root = this.root = new THREE.Group(); root.name = 'loop';
    const add = (mesh, name) => { mesh.name = name; mesh.matrixAutoUpdate = false; mesh.updateMatrix(); mesh.castShadow = false; mesh.receiveShadow = false; root.add(mesh); return mesh; };
    const paintMesh = add(new THREE.Mesh(pg, this.mats.paint), 'loop:paint'); paintMesh.renderOrder = 1; paintMesh.receiveShadow = true;
    add(new THREE.Mesh(mergeGeometries(signBodies), this.mats.signBody), 'loop:signs');
    add(new THREE.Mesh(mergeGeometries(signFaces), this.mats.signFace), 'loop:signFaces');
    this.dockBody = add(new THREE.InstancedMesh(this.geo.body, this.mats.body, nSlots), 'loop:boards');
    this.dockLamp = add(new THREE.InstancedMesh(this.geo.dockLamps, this.mats.lamp, nSlots), 'loop:boardLamps');
    const blobGeo = new THREE.PlaneGeometry(0.42, 1.22); blobGeo.rotateX(-Math.PI / 2);
    this.dockBlob = add(new THREE.InstancedMesh(blobGeo, this.mats.blob, nSlots), 'loop:blobs'); this.dockBlob.renderOrder = 2;
    const bloom = engine.layers && engine.layers.BLOOM;
    if (bloom != null) this.dockLamp.layers.enable(bloom);
    for (const im of [this.dockBody, this.dockLamp, this.dockBlob]) im.frustumCulled = false;   // spread over the city: one draw either way
    this.refreshDocked(true);
    engine.scene.add(root);

    // the ridden board (child of 健人 while he rides)
    const rb = this.rideBoard = new THREE.Group(); rb.name = 'loop:ride';
    rb.add(new THREE.Mesh(this.geo.body, this.mats.body));
    const lamps = new THREE.Mesh(this.geo.rideLamps, this.mats.lamp); rb.add(lamps);
    this.modeLamp = new THREE.Mesh(tint(new THREE.BoxGeometry(0.03, 0.02, 0.012), '#3dff7a'), this.mats.lamp);
    this.modeLamp.position.set(0, 0.955, 0.378); rb.add(this.modeLamp);
    const beam = this.beam = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 4.2), new THREE.MeshBasicMaterial({ map: paintBeam(), color: 0xfff1d6, transparent: true,
      opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    beam.rotation.x = -Math.PI / 2; beam.position.set(0, 0.02, 0.62 + 2.1); beam.renderOrder = 3; rb.add(beam);
    // (the texture's bright end is v = 0 → the near end of the plane, at the wheel)
    beam.geometry.attributes.uv.array.forEach((v, i, arr) => { if (i % 2) arr[i] = 1 - v; });
    rb.traverse((o) => { if (o.isMesh) { o.castShadow = o !== beam; o.frustumCulled = false; } });
    if (bloom != null) { lamps.layers.enable(bloom); this.modeLamp.layers.enable(bloom); }
    rb.visible = false;

    // the crowd built its street-furniture grid in its own init: fold the bays into it
    const crowd = engine.get('crowd');
    if (crowd && typeof crowd.buildObstacles === 'function' && crowd.obs) { try { crowd.buildObstacles(); } catch (e) { console.warn('[loop] crowd obstacles', e); } }
    engine.events.on('traffic:hit', (ev) => { if (this.ride && ev && ev.target === engine.player) this.endRide('crash'); });
    this.t = 0;
  },

  // The bay, its sign and the roll-out space in front must be clear of the street furniture props.js / the builders
  // placed (vending machines, poles, trees, racks, shopfronts) and off the carriageway. loopPorts.js is already fitted
  // against them; this only guards against later changes: it slides the bay along its row (then a little out) to the
  // nearest clear spot and says so.
  fitPort(port) {
    const world = this.engine.world, city = this.engine.get('city'), field = city && city.field;
    if (!world || !world.statics) return;
    const gy0 = world.groundHeight(port.x, port.z), near = [];
    for (const sh of world.statics) {
      if (sh.tag === 'ground') continue;
      if (sh.max.x < port.x - 14 || sh.min.x > port.x + 14 || sh.max.z < port.z - 14 || sh.min.z > port.z + 14) continue;
      if (sh.min.y > gy0 + 1.4 || sh.max.y < gy0 + 0.05) continue;
      near.push(sh);
    }
    const hit = (x, z) => {
      for (const sh of near) {
        if (x < sh.min.x || x > sh.max.x || z < sh.min.z || z > sh.max.z) continue;
        if (sh.kind !== 'obb') return true;
        const dx = x - sh.center.x, dz = z - sh.center.z, lx = sh.c * dx - sh.s * dz, lz = sh.s * dx + sh.c * dz;
        if (Math.abs(lx) <= sh.half.x && Math.abs(lz) <= sh.half.z) return true;
      }
      return false;
    };
    const clear = (cx, cz) => {
      const hw = port.W / 2, hd = port.D / 2;
      for (let lx = -hw - 0.1; lx <= hw + 0.66; lx += 0.25) for (let lz = -hd - 0.05; lz <= hd + 0.9; lz += 0.25) {
        if (lx > hw + 0.1 && lz > -hd + 0.6) continue;             // (the sign stands at the back corner only)
        const x = cx + lx * port.cs + lz * port.sn, z = cz - lx * port.sn + lz * port.cs;
        if (hit(x, z)) return false;                                // bay, sign and a 0.9 m roll-out strip
        if (field && lz <= hd && field.sample(x, z) < 0.1) return false;   // the bay itself on the pavement
      }
      return true;
    };
    if (clear(port.x, port.z)) return;
    for (let k = 1; k <= 40; k++) {
      const s = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.25;
      for (const out of [0, 0.25, 0.5]) {
        const x = port.x + s * port.cs + out * port.sn, z = port.z - s * port.sn + out * port.cs;
        if (clear(x, z)) { console.info(`[loop] port ${port.id}: slid ${s.toFixed(2)} m along the row, ${out} m out, clear of street furniture`); port.fitted = [+(x - port.x).toFixed(2), +(z - port.z).toFixed(2)]; port.x = x; port.z = z; return; }
      }
    }
    console.info(`[loop] port ${port.id}: no clear spot within 5 m — kept as surveyed`);
  },

  // ---------------------------------------------------------------------------------------------- slots
  slotLocal(port, i) { return -port.W / 2 + 0.15 + SLOT_W * (i + 0.5); },
  slotWorld(port, i, lz, out) {
    const lx = this.slotLocal(port, i);
    return out.set(port.x + lx * port.cs + lz * port.sn, 0, port.z - lx * port.sn + lz * port.cs);
  },
  setSlot(port, i, docked) { port.dock[i] = docked; this._dockDirty = true; },
  // the docked boards of the bays within DOCK_R of the lens, packed into the instanced meshes (a bay farther out
  // is a few pixels: its boards are not drawn, its paint and sign still are). Re-packed when a board moves or the
  // lens has travelled 6 m.
  slotMatrices(port, i) {
    const world = this.engine.world;
    this.slotWorld(port, i, 0.02, _p);
    _p.y = world ? world.groundHeight(_p.x, _p.z) : 0;
    // on its kickstand: leaning ~4° to its left, each at its own slight angle
    const jit = Math.sin((port.base + i) * 12.9898) * 0.05;
    const board = new THREE.Matrix4().compose(_p, _q.setFromEuler(_e.set(0, port.rotY + jit, 0.07, 'YXZ')), _s.set(1, 1, 1));
    _p.y += 0.006;
    const blob = new THREE.Matrix4().compose(_p, _q.setFromEuler(_e.set(0, port.rotY + jit, 0)), _s.set(1, 1, 1));
    return { board, blob };
  },
  refreshDocked(force = false) {
    const cam = this.engine.camera.position, a = this._dockAt || (this._dockAt = new THREE.Vector3(1e9, 0, 0));
    if (!force && !this._dockDirty && Math.abs(cam.x - a.x) + Math.abs(cam.z - a.z) < 6) return;
    a.copy(cam); this._dockDirty = false;
    let n = 0;
    for (const port of this.ports) {
      if (Math.hypot(port.x - cam.x, port.z - cam.z) > DOCK_R) continue;
      if (!port.mats) port.mats = Array.from({ length: port.slots }, (_, i) => this.slotMatrices(port, i));
      for (let i = 0; i < port.slots; i++) {
        if (!port.dock[i]) continue;
        this.dockBody.setMatrixAt(n, port.mats[i].board); this.dockLamp.setMatrixAt(n, port.mats[i].board); this.dockBlob.setMatrixAt(n, port.mats[i].blob);
        n++;
      }
    }
    for (const im of [this.dockBody, this.dockLamp, this.dockBlob]) { im.count = n; im.visible = n > 0; im.instanceMatrix.needsUpdate = true; }
    this.dockedDrawn = n;
  },
  freeBoards(port) { let n = 0; for (const d of port.dock) if (d) n++; return n; },
  freeSlots(port) { return port.slots - this.freeBoards(port); },
  // bay-local coordinates of (x, z): lx along the row, lz out toward the street
  local(port, x, z, out) { const dx = x - port.x, dz = z - port.z; out[0] = port.cs * dx - port.sn * dz; out[1] = port.sn * dx + port.cs * dz; return out; },
  nearestPort(x, z, needFree = false) {
    let best = null, bd = Infinity;
    for (const p of this.ports) { if (needFree && this.freeSlots(p) <= 0) continue; const d = Math.hypot(x - p.x, z - p.z); if (d < bd) { bd = d; best = p; } }
    return best;
  },
  fare(seconds) { return LOOP_FARE.base + LOOP_FARE.perMin * Math.max(1, Math.ceil(seconds / 60 - 1e-9)); },

  // ---------------------------------------------------------------------------------------------- gates
  canRide() {
    const engine = this.engine, e = engine.player;
    if (!e || !e.alive || engine.state.frozen || engine.state.mode !== 'explore') return false;
    if (e.state !== 'idle' && e.state !== 'move') return false;
    const ms = engine.get('missions');
    if (ms && (ms.scene || ms.talk || ms.fightCtx || ms.startAt != null || ms.startSubAt != null || ms._resHold)) return false;
    const en = engine.get('enemy');
    if (en && en.list) for (const x of en.list) if (x.alive) return false;     // nobody picks a fight with a rider
    return true;
  },
  onCarriageway(x, z) {
    const city = this.engine.get('city'), f = city && city.field;
    if (f && typeof f.sample === 'function') return f.sample(x, z) < 0;
    return isRoad(x, z);
  },

  // ---------------------------------------------------------------------------------------------- rent / return
  startRide(port, opts = {}) {
    const engine = this.engine, e = engine.player;
    if (!e || this.ride) return false;
    if (!opts.force && !this.canRide()) return false;
    const ms = engine.get('missions');
    if (!opts.force && ms && typeof ms.yen === 'number' && ms.yen < LOOP_FARE.base + LOOP_FARE.perMin) { this.toast('所持金が足りません', '基本¥50＋¥15/分', true); return false; }
    // the docked board nearest to him
    let si = -1, sd = Infinity;
    for (let i = 0; i < port.slots; i++) if (port.dock[i]) { this.slotWorld(port, i, 0, _p); const d = Math.hypot(_p.x - e.position.x, _p.z - e.position.z); if (d < sd) { sd = d; si = i; } }
    if (si < 0) return false;
    this.setSlot(port, si, false);
    this.slotWorld(port, si, port.D / 2 + 0.62, _p);
    const world = engine.world;
    e.position.x = _p.x; e.position.z = _p.z; e.position.y = world ? world.groundHeight(_p.x, _p.z) : 0;
    e.yaw = port.rotY; e.group.rotation.set(0, e.yaw, 0);
    e.riding = true; e.setState('ride'); e.velocity.set(0, 0, 0); e.lockTarget = null;
    e.humanoid.play('idle', { fade: 0.2, force: true });
    const sc = e.group.scale.x || 1;
    this.rideBoard.scale.setScalar(1 / sc);
    this.rideBoard.position.set(0, -DECK / sc, 0.06 / sc);
    if (this.rideBoard.parent !== e.group) e.group.add(this.rideBoard);
    this.rideBoard.visible = true;
    this.ride = { port, t: 0, v: 0, steer: 0, mode: 'pave', lift: opts.force ? 1 : 0, bumpT: 0, roll: 0, gy: e.position.y, blink: 0, lean: 0, acc: 0,
      saved: e.humanoid.bones ? poseSave(e.humanoid.bones) : null };
    const cam = engine.get('camera');
    if (cam) { this.ride.cam0 = { distance: cam.distance, height: cam.height }; }
    if (!opts.silent) { this.toast(`LOOP 利用開始`, port.name); this.beep(true); }
    this.startAudio();
    engine.events.emit('loop:rent', { port: port.id });
    return true;
  },

  endRide(reason = 'return', dockPort = null) {
    const engine = this.engine, e = engine.player, R = this.ride;
    if (!R || !e) return;
    this.ride = null;
    const world = engine.world;
    // where the board ends up: the bay he is in, or (forced / crash) the nearest bay with room — towed there
    let port = dockPort || this.nearestPort(e.position.x, e.position.z, true) || R.port;
    let si = -1, sd = Infinity;
    for (let i = 0; i < port.slots; i++) if (!port.dock[i]) { this.slotWorld(port, i, 0, _p); const d = Math.hypot(_p.x - e.position.x, _p.z - e.position.z); if (d < sd) { sd = d; si = i; } }
    if (si >= 0) this.setSlot(port, si, true);
    const fare = this.fare(R.t), fee = reason === 'crash' ? LOOP_FARE.towFee : 0, mins = Math.max(1, Math.ceil(R.t / 60 - 1e-9));
    const ms = engine.get('missions');
    if (ms && typeof ms.addYen === 'function' && !this._shot) ms.addYen(-(fare + fee));
    this.rideBoard.visible = false;
    poseRestore(e.humanoid && e.humanoid.bones, R.saved);
    e.riding = false; e.avoidR = undefined; e.moveSpeed = 0;
    e.group.rotation.set(0, e.yaw, 0);
    if (reason === 'return' && si >= 0) {
      this.slotWorld(port, si, port.D / 2 + 0.78, _p);
      e.position.x = _p.x; e.position.z = _p.z;
    }
    if (reason !== 'crash') {
      e.velocity.set(0, 0, 0); e.setState('idle');
      e.humanoid.play('idle', { fade: 0.2, force: true });
    }
    if (world) e.position.y = world.groundHeight(e.position.x, e.position.z);
    const cam = engine.get('camera');
    if (cam && R.cam0) { cam.distance = R.cam0.distance; cam.height = R.cam0.height; }
    this.stopAudio();
    if (reason === 'return') { this.toast(`返却完了　ご利用 ${mins}分　¥${fare.toLocaleString('en-US')}`, port.name); this.beep(false); }
    else if (reason === 'crash') this.toast(`車と接触 — LOOPは「${port.name}」ポートへ自動返却されました`, `料金 ¥${fare.toLocaleString('en-US')}＋回送手数料 ¥${fee.toLocaleString('en-US')}`, true);
    else this.toast(`LOOPを「${port.name}」ポートへ自動返却しました`, `ご利用 ${mins}分　¥${fare.toLocaleString('en-US')}`);
    this.lastEnd = { reason, port: port.id, fare, fee, minutes: mins, seconds: R.t };
    engine.events.emit('loop:return', this.lastEnd);
  },

  // ---------------------------------------------------------------------------------------------- frame
  update(dt, t) {
    const engine = this.engine, e = engine.player;
    if (!e || this.off) return;
    this.t += dt;
    this.refreshDocked();
    if (!this.ui) this.setupUI();
    if (!this._layer) this.setupMapLayer();
    const input = engine.input, R = this.ride;
    const shot = !!(engine.params && engine.params.shot);
    if (shot) { if (R) this.pose(e, R, 0); this.paintHUD(); return; }
    const mode = engine.state.mode;
    const ms = engine.get('missions');

    if (R) {
      // a cutscene / fight / conversation takes over: the board goes back to the nearest bay on its own
      const storyBusy = ms && (ms.scene || ms.talk || ms.fightCtx);
      if (mode === 'cutscene' || mode === 'combat' || storyBusy || !e.alive) { this.endRide('forced'); this.paintHUD(); return; }
      if (mode === 'paused' || engine.state.frozen) { this.pose(e, R, 0); return; }
      if (input.buttons.interact.pressed) {
        input.buttons.interact.pressed = false;               // (missions reads E after us: no conversation from the saddle)
        const zone = this.returnZone(e.position.x, e.position.z);
        if (zone && this.freeSlots(zone) > 0) { this.endRide('return', zone); this.paintHUD(); return; }
        if (zone) this.toast('このポートは満車です', '空きのあるポートへ返却してください', true);
        else this.toast('ポート以外では返却できません', 'LOOP ポート（地図の緑のアイコン）で返却', true);
      }
      this.drive(e, R, dt, input);
      this.pose(e, R, dt);
      this.updateAudio(R);
    } else {
      // walking: the rent prompt at the nearest bay with a board
      this._near = null;
      if (this.canRide() && !(ms && ms.nearSub)) {
        let best = null, bd = Infinity; const L = [0, 0];
        for (const p of this.ports) {
          if (Math.abs(p.x - e.position.x) > 6 || Math.abs(p.z - e.position.z) > 6) continue;
          this.local(p, e.position.x, e.position.z, L);
          const inFront = Math.abs(L[0]) <= p.W / 2 + 0.9 && L[1] >= p.D / 2 - 0.3 && L[1] <= p.D / 2 + 2.4;
          const d = Math.hypot(p.x - e.position.x, p.z - e.position.z);
          if ((inFront || d < 2.4) && d < bd) { bd = d; best = p; }
        }
        this._near = best;
        if (best && input.buttons.interact.pressed) {
          if (this.freeBoards(best) > 0) { input.buttons.interact.pressed = false; this.startRide(best); }
          else this.toast('このポートに車両はありません', '他のポートを探してください', true);
        }
      }
    }
    this.paintHUD();
  },

  // the bay he is standing in front of / beside while riding (for 返却), or null
  returnZone(x, z) {
    const L = [0, 0];
    for (const p of this.ports) {
      if (Math.abs(p.x - x) > 7 || Math.abs(p.z - z) > 7) continue;
      this.local(p, x, z, L);
      if (Math.abs(L[0]) <= p.W / 2 + 1.6 && L[1] >= -p.D / 2 - 0.4 && L[1] <= p.D / 2 + 3.6) return p;
    }
    return null;
  },

  drive(e, R, dt, input) {
    const engine = this.engine, world = engine.world;
    R.t += dt;
    R.bumpT = Math.max(0, R.bumpT - dt);
    R.lift = Math.min(1, R.lift + dt / 0.25);
    const pos = e.position;
    const road = this.onCarriageway(pos.x, pos.z);
    R.mode = road ? 'road' : 'pave';
    const cap = road ? V_ROAD : V_PAVE;
    const thr = Math.max(0, input.move.y), brk = Math.max(0, -input.move.y), steerIn = clamp(input.move.x, -1, 1);
    // longitudinal: rolling + air drag; the hub motor pulls ~1.6 m/s² and its controller holds the cap exactly at full
    // throttle (the last 0.45 m/s eased in); over the cap — coming up off the road onto the pavement — the controller
    // brakes at 2.4 m/s² rather than snapping; the brakes give 4 m/s²
    const drag = R.v > 0 ? 0.16 + 0.011 * R.v * R.v : 0;
    let a = -drag;
    if (thr > 0.02 && R.v < cap) a += thr * (ACCEL * clamp((cap - R.v) / 0.6, 0, 1) + drag);
    if (R.v > cap + 0.05) a -= 3.5;
    if (R.v > 0) a -= brk * 7.0;
    // hard steering at speed eases off the motor and scrubs speed (up to 5 m/s² at full lock above ~29 km/h), so a
    // Shibuya corner can be taken at 50 km/h without a separate brake: the grip-limited radius shrinks as he slows
    const lock = Math.abs(R.steer);
    if (lock > 0.55 && R.v > 8) a -= 5.0 * clamp((lock - 0.55) / 0.45, 0, 1) * clamp((R.v - 8) / 4, 0, 1);
    // the slope under the wheels (道玄坂 3.5 %, 宮益坂): gravity along the heading
    const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
    if (world && R.v > 0.05) { const h1 = world.groundHeight(pos.x + fx * 0.6, pos.z + fz * 0.6), h0 = world.groundHeight(pos.x - fx * 0.6, pos.z - fz * 0.6), s = (h1 - h0) / 1.2; if (Math.abs(s) < 0.12) a -= 9.8 * s * 0.8; }
    R.acc = a;
    R.v = Math.max(0, R.v + a * dt);
    if (R.v < 0.03 && thr < 0.05) R.v = 0;
    // steering: kinematic bicycle, the yaw rate held under ~3.2 m/s² of lateral grip; at a standstill a foot on the
    // ground walks the board round
    R.steer += (steerIn - R.steer) * damp(7, dt);
    let yawRate;
    if (R.v < 0.35) yawRate = -R.steer * (0.9 + R.v * 1.2);
    else { const kin = R.v * Math.tan(0.5 * R.steer) / WHEELBASE, lim = GRIP / R.v; yawRate = -clamp(kin, -lim, lim); }
    e.yaw = Math.atan2(Math.sin(e.yaw + yawRate * dt), Math.cos(e.yaw + yawRate * dt));
    R.yawRate = yawRate;
    // move through the physics world (slides along walls, steps the 15 cm kerbs)
    _d.set(Math.sin(e.yaw), 0, Math.cos(e.yaw)).multiplyScalar(R.v * dt);
    const want = _d.length(), x0 = pos.x, z0 = pos.z, gy0 = R.gy;
    if (want > 1e-6) {
      if (world) { const p = world.moveCapsule(pos, e.radius || 0.35, e.height || 1.8, _d); pos.x = p.x; pos.z = p.z; }
      else { pos.x += _d.x; pos.z += _d.z; }
      const got = ((pos.x - x0) * _d.x + (pos.z - z0) * _d.z) / want;
      if (got < want * 0.45 && R.v > 1.3 && R.bumpT <= 0) this.bump(R, 0.35, null);
    }
    // pedestrians: the crowd steps aside (avoidR, velocity); one he still runs into stops him dead
    if (R.v > 0.7 && R.bumpT <= 0) {
      const crowd = engine.get('crowd'), peds = crowd && crowd.peds;
      if (peds) {
        const hx = pos.x + fx * 0.55, hz = pos.z + fz * 0.55;
        for (let i = 0; i < peds.length; i++) {
          const q = peds[i]; if (!q) continue;
          const dx = q.x - hx; if (dx > 0.55 || dx < -0.55) continue;
          const dz = q.z - hz; if (dz > 0.55 || dz < -0.55) continue;
          if (dx * dx + dz * dz < 0.2 && !(q.fade < 0.3)) { this.bump(R, 0.25, '歩行者と接触しました — 歩行者優先で走行してください', 0.4); break; }
        }
      }
    }
    // ground: kerbs jolt at speed
    const gy = world ? world.groundHeight(pos.x, pos.z) : 0;
    if (Math.abs(gy - gy0) > 0.07 && R.v > 2.0) { R.v *= 0.88; const cam = engine.get('camera'); if (cam && cam.shake) cam.shake(0.12, 0.18); }
    R.gy = gy;
    pos.y += (gy + DECK * R.lift * (e.group.scale.y || 1) - pos.y) * damp(18, dt);
    // what the other systems read: camera arm and auto-orbit, the crowd's look-ahead and avoid ring, traffic
    e.moveSpeed = R.v;
    e.velocity.set(Math.sin(e.yaw) * R.v, 0, Math.cos(e.yaw) * R.v);
    e.avoidR = 2.6 + 0.4 * R.v;                                  // the crowd reads it: at 25 km/h ~5.4 m, at 40 km/h ~7 m
    const cam = engine.get('camera');
    if (cam && R.cam0) {
      const k = clamp(R.v / V_ROAD, 0, 1);
      cam.distance += (R.cam0.distance + 0.95 * k - cam.distance) * damp(2.5, dt);
      cam.height += (R.cam0.height + 0.1 * k - cam.height) * damp(2.5, dt);
    }
  },

  // keep: the share of speed left (a wall stops him; a pedestrian brushed at speed only slows him — at the faster game
  // speeds a dead stop on every brush made the pavements unrideable). The warning shows at most every 4 s.
  bump(R, shake, msg, keep = 0.1) {
    const engine = this.engine;
    R.v *= keep; R.bumpT = msg ? 0.6 : 0.9;
    const cam = engine.get('camera'); if (cam && cam.shake) cam.shake(shake, 0.3);
    const au = engine.get('audio'); if (au && au.play) { try { au.play(msg ? 'cloth' : 'prop', { gain: 0.35, pos: engine.player && engine.player.position }); } catch (_) { /* silent */ } }
    if (msg && R.t - (R.msgT ?? -99) > 4) { R.msgT = R.t; this.toast(msg, null, true); }
    engine.events.emit('loop:bump', { msg });
  },

  // standing pose on the deck: both hands on the grips, feet one behind the other, a slight lean into the bar and
  // into the turn. Runs after the mixer (humanoid.update) and before the render.
  pose(e, R, dt) {
    const h = e.humanoid, B = h && h.bones, g = e.group;
    if (!B || !B.LeftArm) return;
    const lat = R.v * (R.yawRate || 0);                          // lateral acceleration → lean into the turn
    R.roll += (clamp(Math.atan2(lat, 9.8), -0.2, 0.2) - R.roll) * damp(6, dt || 1);
    poseBegin(B, restPose(h));
    g.rotation.set(0, e.yaw, 0);
    g.rotation.z = -R.roll;
    g.updateMatrixWorld(true);
    const sc = g.scale.x || 1;
    const W = (x, y, z, out) => out.set(x, y, z).applyMatrix4(g.matrixWorld);
    // lean: the chest over the bar, a touch more under throttle
    R.lean += (0.11 + clamp(R.acc || 0, -2, 2) * 0.02 - R.lean) * damp(5, dt || 1);
    _f.set(1, 0, 0).transformDirection(g.matrixWorld);          // his left = group +x
    if (B.Spine) rotateBoneWorld(B.Spine, _f, R.lean * 0.6);
    if (B.Spine1) rotateBoneWorld(B.Spine1, _f, R.lean * 0.4);
    // feet: left forward, right back on the deck
    if (B.LeftUpLeg && B.LeftLeg && B.LeftFoot) {
      const ank = 0.085;                                          // ankle over the sole (group-local, pre-scale)
      twoBone(B.LeftUpLeg, B.LeftLeg, B.LeftFoot, W(0.03 / sc, ank / sc, 0.2 / sc, _c), W(0.25 / sc, 0.5 / sc, 1.4 / sc, _w));
      twoBone(B.RightUpLeg, B.RightLeg, B.RightFoot, W(-0.05 / sc, ank / sc, -0.18 / sc, _c), W(-0.25 / sc, 0.5 / sc, 1.2 / sc, _w));
    }
    // hands: on the grips (bar at 1.012 on the board, the board 6 cm ahead and DECK below the group origin)
    const gy = (1.012 - DECK + 0.02) / sc, gz = (0.345 + 0.06 - 0.05) / sc;
    twoBone(B.LeftArm, B.LeftForeArm, B.LeftHand, W(0.2 / sc, gy, gz, _c), W(0.55 / sc, 0.8 / sc, -0.5 / sc, _w));
    twoBone(B.RightArm, B.RightForeArm, B.RightHand, W(-0.2 / sc, gy, gz, _c), W(-0.55 / sc, 0.8 / sc, -0.5 / sc, _w));
    // lamps: the 歩道モード lamp blinks at 1 Hz; the headlight beam only reads at night
    R.blink += dt || 0;
    this.modeLamp.visible = !ONE_CAP && R.mode === 'pave' ? (R.blink % 1) < 0.55 : false;
    const hr = this.engine.time ? this.engine.time.hour : 21.5, night = hr < 6.3 || hr > 17.5;
    this.beam.visible = night;
  },

  // ---------------------------------------------------------------------------------------------- shot preset
  shotSetup() {
    const p = this.ports.find((q) => q.id === 'magnet') || this.ports[0], e = this.engine.player;
    if (!p || !e) return;
    this._shot = true;
    this.startRide(p, { force: true, silent: true });
    const R = this.ride; if (!R) return;
    // rolling out along the row, a metre off the bay
    const ax = p.cs, az = -p.sn;
    e.position.x = p.x + p.sn * (p.D / 2 + 1.25) - ax * 0.6; e.position.z = p.z + p.cs * (p.D / 2 + 1.25) - az * 0.6;
    const world = this.engine.world;
    e.position.y = (world ? world.groundHeight(e.position.x, e.position.z) : 0) + DECK;
    e.yaw = Math.atan2(-ax, -az) + 0.35;
    R.mode = this.onCarriageway(e.position.x, e.position.z) ? 'road' : 'pave'; R.v = R.mode === 'road' ? 4.2 : 1.6; R.t = 95; R.yawRate = 0.25;
    this.pose(e, R, 0.016);
  },

  // ---------------------------------------------------------------------------------------------- HUD
  setupUI() {
    const root = document.getElementById('hud'); if (!root) return;
    const hud = this.engine.get('hud'); if (hud && !hud.root) return;           // hud builds its DOM in its own init
    if (!document.getElementById('loop-css')) {
      const st = document.createElement('style'); st.id = 'loop-css';
      const T = LOOP_BRAND.teal;
      st.textContent = `
#hud .loopui { position:absolute; inset:0; pointer-events:none; }
#hud.cutscene .loopui, #hud.letterbox .loopui { display:none; }
#hud .loop-ride { position:absolute; left:34px; bottom:122px; zoom:var(--hk,1); min-width:252px; padding:10px 18px 12px 16px; color:#eaf7f4;
  background:linear-gradient(90deg, rgba(3,9,9,.9), rgba(3,9,9,.58)); border-left:3px solid ${T}; box-shadow:0 6px 18px rgba(0,0,0,.55);
  opacity:0; transform:translateX(-14px); transition:opacity .25s, transform .25s; }
#hud .loop-ride.on { opacity:1; transform:none; }
#hud .loop-ride .hd { display:flex; align-items:baseline; gap:10px; }
#hud .loop-ride .brand { font-weight:900; font-size:15px; letter-spacing:.2em; color:${T}; }
#hud .loop-ride .kana { font-size:11px; letter-spacing:.24em; color:#9fdcd2; }
#hud .loop-ride .mode { margin-left:auto; padding:1px 9px 2px; font-size:13px; font-weight:800; letter-spacing:.18em; border:1px solid; white-space:nowrap; }
#hud .loop-ride .mode.road { color:#ffd98a; border-color:rgba(255,217,138,.6); }
#hud .loop-ride .mode.pave { color:#8ff7e4; border-color:${T}; }
#hud .loop-ride .mode .lamp { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:6px; vertical-align:1px; background:#3dff7a; box-shadow:0 0 6px #3dff7a; }
#hud .loop-ride .mode.road .lamp { display:none; }
#hud .loop-ride .spd { margin-top:2px; font-size:46px; font-weight:800; line-height:1; letter-spacing:.02em; font-variant-numeric:tabular-nums; }
#hud .loop-ride .spd small { font-size:14px; font-weight:700; margin-left:6px; color:#a9d8d0; letter-spacing:.1em; }
#hud .loop-ride .cap { font-size:11px; color:#8fb8b1; letter-spacing:.12em; margin-top:2px; }
#hud .loop-ride .row { display:flex; justify-content:space-between; gap:18px; margin-top:7px; padding-top:6px; border-top:1px solid rgba(34,184,164,.35);
  font-size:15px; font-weight:700; letter-spacing:.06em; font-variant-numeric:tabular-nums; }
#hud .loop-ride .row span i { font-style:normal; font-size:11px; font-weight:600; color:#8fb8b1; margin-right:7px; letter-spacing:.14em; }
#hud .loop-prompt { position:absolute; left:0; top:0; transform:translate(-50%,-100%); white-space:nowrap; padding:7px 14px 8px; color:#f2fbf9;
  background:rgba(3,9,9,.86); border:1px solid rgba(34,184,164,.55); border-left:3px solid ${T}; font-size:16px; font-weight:700; letter-spacing:.05em;
  opacity:0; transition:opacity .15s; box-shadow:0 4px 14px rgba(0,0,0,.5); }
#hud .loop-prompt.on { opacity:1; }
#hud .loop-prompt .pn { font-size:12px; font-weight:600; color:#8fe6d7; letter-spacing:.1em; margin-bottom:3px; }
#hud .loop-prompt .pn b { color:${T}; font-weight:900; letter-spacing:.18em; margin-right:8px; }
#hud .loop-prompt .key { display:inline-block; min-width:14px; padding:0 5px; background:${T}; color:#04201c; border-radius:3px; text-align:center; font-weight:900; }
#hud .loop-prompt .n { font-size:12px; color:#a9d8d0; margin-left:10px; font-weight:600; }
#hud .loop-toast { position:absolute; left:50%; top:63%; transform:translate(-50%,8px); padding:10px 64px 11px; text-align:center; white-space:nowrap;
  background:linear-gradient(90deg, rgba(3,9,9,0), rgba(3,9,9,.9) 18%, rgba(3,9,9,.9) 82%, rgba(3,9,9,0)); color:#f4fbf9;
  font-size:19px; font-weight:800; letter-spacing:.08em; opacity:0; transition:opacity .25s, transform .25s; }
#hud .loop-toast.on { opacity:1; transform:translate(-50%,0); }
#hud .loop-toast.warn { color:#ffd98a; }
#hud .loop-toast .sub { font-size:13px; font-weight:600; color:#9fe8dc; margin-top:4px; letter-spacing:.1em; }`;
      document.head.appendChild(st);
    }
    const el = document.createElement('div'); el.className = 'loopui';
    el.innerHTML = `
      <div class="loop-ride"><div class="hd"><span class="brand">LOOP</span><span class="kana">ループ</span><span class="mode road"><i class="lamp"></i><b>車道</b></span></div>
        <div class="spd">0<small>km/h</small></div><div class="cap">上限 ${LOOP_SPEED.road} km/h</div>
        <div class="row"><span class="tm"><i>利用時間</i>00:00</span><span class="fr"><i>料金</i>¥65</span></div></div>
      <div class="loop-prompt"><div class="pn"></div><div class="tx"></div></div>
      <div class="loop-toast"><div class="m"></div><div class="sub"></div></div>`;
    root.appendChild(el);
    const q = (s) => el.querySelector(s);
    this.ui = { el, ride: q('.loop-ride'), mode: q('.loop-ride .mode'), modeB: q('.loop-ride .mode b'), spd: q('.loop-ride .spd'), cap: q('.loop-ride .cap'),
      tm: q('.loop-ride .tm'), fr: q('.loop-ride .fr'), prompt: q('.loop-prompt'), pn: q('.loop-prompt .pn'), tx: q('.loop-prompt .tx'),
      toast: q('.loop-toast'), tm2: q('.loop-toast .m'), sub: q('.loop-toast .sub') };
    this._last = {};
  },
  toast(msg, sub = null, warn = false) {
    if (!this.ui) this.setupUI();
    const u = this.ui; if (!u) return;
    u.tm2.textContent = msg; u.sub.textContent = sub || ''; u.sub.style.display = sub ? '' : 'none';
    u.toast.classList.toggle('warn', !!warn); u.toast.classList.add('on');
    clearTimeout(this._toastT); this._toastT = setTimeout(() => u.toast.classList.remove('on'), 3200);
    this.lastToast = msg;
  },
  paintHUD() {
    const u = this.ui; if (!u) return;
    const R = this.ride, L = this._last, set = (k, v, fn) => { if (L[k] !== v) { L[k] = v; fn(v); } };
    set('on', !!R, (v) => u.ride.classList.toggle('on', v));
    if (R) {
      set('spd', Math.round(R.v / KMH), (v) => { u.spd.firstChild.nodeValue = String(v); });
      set('mode', R.mode, (v) => { u.mode.className = 'mode ' + v; u.modeB.textContent = v === 'road' ? '車道' : '歩道'; u.cap.textContent = ONE_CAP ? `上限 ${LOOP_SPEED.road} km/h` : v === 'road' ? `上限 ${LOOP_SPEED.road} km/h（車道）` : `上限 ${LOOP_SPEED.pavement} km/h（歩道モード）`; u.mode.style.display = ONE_CAP ? 'none' : ''; });
      const s = Math.floor(R.t);
      set('tm', s, (v) => { u.tm.lastChild.nodeValue = `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`; });
      set('fr', this.fare(R.t), (v) => { u.fr.lastChild.nodeValue = '¥' + v.toLocaleString('en-US'); });
    }
    // world-anchored prompt: rent (walking) or return (riding)
    const e = this.engine.player;
    let port = null, text = null, pn = null;
    if (R && !this._shot) {
      const z = e ? this.returnZone(e.position.x, e.position.z) : null;
      if (z) { port = z; text = this.freeSlots(z) > 0 ? '返却' : null; pn = z.name; if (!text) text = '満車（返却不可）'; }
    } else if (!R && this._near) {
      port = this._near; pn = port.name;
      const n = this.freeBoards(port);
      text = n > 0 ? RENT_TXT : '車両なし';
    }
    const key = port ? port.id + '|' + text : '';
    set('pkey', key, () => {
      if (!port) { u.prompt.classList.remove('on'); return; }
      u.pn.innerHTML = `<b>LOOP</b>${pn}`;
      const withKey = text === '返却' || text === RENT_TXT;
      u.tx.innerHTML = (withKey ? '<b class="key">E</b>：' : '') + text + (!R ? `<span class="n">貸出可能 ${this.freeBoards(port)}台</span>` : `<span class="n">空き ${this.freeSlots(port)}台</span>`);
      u.prompt.classList.add('on');
    });
    if (port) {
      const cam = this.engine.camera;
      _v.copy(port.sign).project(cam);
      if (_v.z > 1 || _v.z < -1) u.prompt.style.opacity = '0';
      else {
        u.prompt.style.opacity = '';
        const x = (_v.x * 0.5 + 0.5) * window.innerWidth, y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
        u.prompt.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      }
    }
  },

  // minimap + pause map icons (hud.addMapLayer)
  setupMapLayer() {
    const hud = this.engine.get('hud');
    if (!hud || typeof hud.addMapLayer !== 'function') { this._layer = true; return; }
    this._layer = true;
    const icon = (() => {
      const dpr = Math.min(2, window.devicePixelRatio || 1), n = 22, c = canvas(Math.round(n * dpr), Math.round(n * dpr)), g = c.getContext('2d');
      g.scale(dpr, dpr); g.translate(n / 2, n / 2);
      g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.arc(0, 0.6, 10, 0, Math.PI * 2); g.fill();
      g.fillStyle = LOOP_BRAND.teal; g.strokeStyle = '#eafffb'; g.lineWidth = 1.4;
      g.beginPath(); g.arc(0, 0, 8.6, 0, Math.PI * 2); g.fill(); g.stroke();
      g.strokeStyle = '#fff'; g.lineWidth = 1.7; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(-4.6, 3.2); g.lineTo(3.2, 3.2); g.lineTo(4.3, -4.2); g.moveTo(2.6, -4.2); g.lineTo(5.6, -4.2); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(-4.2, 4.3, 1.5, 0, Math.PI * 2); g.arc(3.6, 4.3, 1.5, 0, Math.PI * 2); g.fill();
      return c;
    })();
    hud.addMapLayer((ctx, project, info) => {
      const e = this.engine.player, px = e ? e.position.x : 0, pz = e ? e.position.z : 0;
      const sz = info.mini ? 17 : 19;
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const p of this.ports) {
        const d = Math.hypot(p.x - px, p.z - pz);
        const s = project(p.x, p.z), sx = s[0], sy = s[1];
        if (info.mini && Math.hypot(sx - info.C, sy - info.C) > info.R - 7) continue;
        ctx.drawImage(icon, sx - sz / 2, sy - sz / 2, sz, sz);
        if (!info.mini || d < 130) {                             // free boards, for the bays near him (all of them on the pause map)
          const n = this.freeBoards(p), t = String(n);
          ctx.font = `800 10px ${SANS}`;
          const bx = sx + sz * 0.42, by = sy - sz * 0.42;
          ctx.fillStyle = n > 0 ? '#062a25' : '#3a1010'; ctx.strokeStyle = n > 0 ? LOOP_BRAND.teal : '#d05050'; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(bx, by, 6.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.fillText(t, bx, by + 0.5);
        }
      }
      if (!info.mini) {                                           // legend
        ctx.textAlign = 'left'; ctx.font = `600 11px ${SANS}`;
        const y = (info.css || 600) - 44;
        ctx.drawImage(icon, 14, y - 9, 18, 18);
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.fillStyle = '#bff3ea';
        ctx.strokeText('LOOP ポート（数字＝貸出可能台数）', 36, y); ctx.fillText('LOOP ポート（数字＝貸出可能台数）', 36, y);
      }
      ctx.restore();
    });
  },

  // ---------------------------------------------------------------------------------------------- audio
  // a quiet hub-motor whine that rises with speed and throttle, and the deck's rumble over the paving; both ride the
  // street's own bus (audio.bus.world), so they duck behind a pause and a fight like the rest of the street
  startAudio() {
    const au = this.engine.get('audio');
    if (!au || !au.ctx || !au.bus || !au.bus.world || au.ctx.state !== 'running' || this.snd) return;
    try {
      const ctx = au.ctx, now = ctx.currentTime;
      const out = ctx.createGain(); out.gain.value = 0; out.connect(au.bus.world);
      const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 110;
      const osc2 = ctx.createOscillator(); osc2.type = 'sine'; osc2.frequency.value = 330;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 2.4;
      const wg = ctx.createGain(); wg.gain.value = 0;
      const g2 = ctx.createGain(); g2.gain.value = 0.35;
      osc.connect(bp); osc2.connect(g2).connect(bp); bp.connect(wg).connect(out);
      const len = Math.round(ctx.sampleRate * 2), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      let l = 0; for (let i = 0; i < len; i++) { l = (l + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = l * 3.2; }
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 240;
      const rg = ctx.createGain(); rg.gain.value = 0;
      src.connect(lp).connect(rg).connect(out);
      osc.start(now); osc2.start(now); src.start(now);
      out.gain.setTargetAtTime(1, now, 0.12);
      this.snd = { ctx, out, osc, osc2, bp, wg, src, lp, rg };
    } catch (e) { console.warn('[loop] audio', e && e.message); this.snd = null; }
  },
  updateAudio(R) {
    if (!this.snd) { if ((this._sndTry = (this._sndTry || 0) + 1) % 30 === 0) this.startAudio(); return; }
    const s = this.snd, now = s.ctx.currentTime, k = clamp(R.v / V_ROAD, 0, 1), thr = clamp((R.acc || 0) / ACCEL, 0, 1);
    s.osc.frequency.setTargetAtTime(85 + 470 * k, now, 0.07);
    s.osc2.frequency.setTargetAtTime(3 * (85 + 470 * k), now, 0.07);
    s.bp.frequency.setTargetAtTime(520 + 1500 * k, now, 0.1);
    s.wg.gain.setTargetAtTime(k > 0.01 ? 0.0045 + 0.011 * thr + 0.004 * k : 0.0012, now, 0.08);
    const wet = this.engine.time && this.engine.time.wet > 0.4 ? 1.25 : 1;
    s.rg.gain.setTargetAtTime(0.05 * Math.sqrt(k) * wet * (R.mode === 'pave' ? 1.3 : 1), now, 0.1);
    s.lp.frequency.setTargetAtTime(180 + 260 * k, now, 0.1);
  },
  stopAudio() {
    const s = this.snd; if (!s) return;
    this.snd = null;
    try {
      const now = s.ctx.currentTime;
      s.out.gain.setTargetAtTime(0, now, 0.08);
      for (const n of [s.osc, s.osc2, s.src]) n.stop(now + 0.6);
      setTimeout(() => { try { s.out.disconnect(); } catch (_) { /* gone */ } }, 800);
    } catch (_) { /* context closed */ }
  },
  // the lock's two-tone beep (rent: rising, return: falling)
  beep(up) {
    const au = this.engine.get('audio');
    if (!au || !au.ctx || !au.bus || !au.bus.ui || au.ctx.state !== 'running') return;
    try {
      const ctx = au.ctx, t0 = ctx.currentTime + 0.01;
      const fr = up ? [1318, 1760] : [1760, 1318];
      fr.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f;
        const t = t0 + i * 0.11; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        o.connect(g).connect(au.bus.ui); o.start(t); o.stop(t + 0.1);
      });
    } catch (_) { /* no audio */ }
  },

  selfTest() {
    const out = { ports: this.ports.length, slots: this.ports.reduce((n, p) => n + p.slots, 0), docked: this.ports.reduce((n, p) => n + this.freeBoards(p), 0),
      riding: !!this.ride, ui: !!this.ui, layer: !!this._layer, drawn: this.dockedDrawn, tris: (this.geo.body.index ? this.geo.body.index.count : this.geo.body.attributes.position.count) / 3 };
    out.ok = out.ports > 0 && !!this.dockBody;
    return out;
  },

  dispose() { this.stopAudio(); if (this.root && this.root.parent) this.root.parent.remove(this.root); },
};

export default loop;
