// [city] Elevated rail from CITY.rail: JR viaduct (deck, parapets, piers, 4 ballasted tracks with sleepers, catenary
// masts), the two island platforms with roofs + station boards, a stationary 6-car green JP train, the 東京メトロ
// 銀座線 box viaduct with its glazed station over 明治通り, and the 井の頭線 tail beside Mark City.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';

let M = null;
const SLEEPER_GEO = new THREE.BoxGeometry(2.4, 0.12, 0.22);      // instanced (~2,700) — one geometry, not one per sleeper
const PLAT_LIGHT_GEO = new THREE.BoxGeometry(1.4, 0.08, 0.2);
function mats() {
  if (M) return M;
  const concrete = L.std({ map: L.noiseTex({ size: 256, base: [150, 148, 142], variance: 12, seed: 501, low: 1.0, draw: (ctx, s) => { ctx.fillStyle = 'rgba(0,0,0,0.25)'; for (let i = 0; i <= 4; i++) ctx.fillRect(Math.round(i * s / 4), 0, 2, s); for (let k = 0; k < 30; k++) { ctx.fillStyle = `rgba(0,0,0,${0.05 + L.hash(k, 1, 6) * 0.15})`; ctx.fillRect(L.hash(k, 2, 6) * s, L.hash(k, 3, 6) * s, 3, 20 + L.hash(k, 4, 6) * 80); } } }), roughness: 0.9 });
  concrete.name = 'rail_concrete';
  const darkConcrete = L.std({ map: L.noiseTex({ size: 128, base: [92, 90, 88], variance: 10, seed: 502 }), roughness: 0.95 }); darkConcrete.name = 'rail_concreteDark';
  const ballast = L.std({ map: L.noiseTex({ size: 128, base: [96, 90, 84], variance: 26, seed: 503, low: 0.3 }), roughness: 1.0 }); ballast.name = 'rail_ballast';
  const steel = L.std({ color: 0x7a7c80, roughness: 0.35, metalness: 0.9 }); steel.name = 'rail_steel';
  const sleeper = L.std({ color: 0x8a8a86, roughness: 0.9 }); sleeper.name = 'rail_sleeper';
  const green = L.std({ color: 0x2f7d3a, roughness: 0.6, metalness: 0.2 }); green.name = 'rail_green';
  const roof = L.std({ color: 0x6a6e74, roughness: 0.6, metalness: 0.5 }); roof.name = 'rail_roof';
  const platform = L.std({ map: L.noiseTex({ size: 256, base: [172, 168, 160], variance: 8, seed: 504, draw: (ctx, s) => { ctx.fillStyle = 'rgba(60,58,54,0.5)'; for (let i = 0; i <= 8; i++) { ctx.fillRect(Math.round(i * s / 8), 0, 1, s); ctx.fillRect(0, Math.round(i * s / 8), s, 1); } } }), roughness: 0.8 }); platform.name = 'rail_platform';
  const yellow = L.std({ color: 0xe8c030, roughness: 0.7 }); yellow.name = 'rail_yellow';
  const glass = L.std({ color: 0x9fb8d0, roughness: 0.15, metalness: 0.8, transparent: true, opacity: 0.55, envMapIntensity: 1.4 }); glass.name = 'rail_glass'; glass.userData.noShadow = true;
  const silver = L.std({ color: 0xc9ccd0, roughness: 0.35, metalness: 0.85, envMapIntensity: 1.3 }); silver.name = 'rail_silver';
  const running = L.std({ color: 0x26282c, roughness: 0.7, metalness: 0.4 }); running.name = 'rail_running';
  // train side: silver body, green band, lit window band, doors
  const tc = L.makeCanvas(1024, 256), t = tc.getContext('2d');
  const te = L.makeCanvas(1024, 256), e = te.getContext('2d');
  t.fillStyle = '#c4c7cb'; t.fillRect(0, 0, 1024, 256); e.fillStyle = '#000'; e.fillRect(0, 0, 1024, 256);
  const g = t.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, 'rgba(255,255,255,0.25)'); g.addColorStop(0.5, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.3)'); t.fillStyle = g; t.fillRect(0, 0, 1024, 256);
  t.fillStyle = '#8fc31f'; t.fillRect(0, 150, 1024, 26); t.fillStyle = '#5a9a10'; t.fillRect(0, 176, 1024, 6);
  for (let d = 0; d < 4; d++) {   // 4 doors per side, windows between
    const dx = 40 + d * 250;
    t.fillStyle = '#9ea2a8'; t.fillRect(dx, 40, 90, 200); t.fillStyle = '#4a4e55'; t.fillRect(dx + 43, 40, 4, 200);
    t.fillStyle = '#e8f0ff'; t.fillRect(dx + 10, 60, 30, 60); t.fillRect(dx + 50, 60, 30, 60); e.fillStyle = '#c8d8ff'; e.fillRect(dx + 10, 60, 30, 60); e.fillRect(dx + 50, 60, 30, 60);
    // saloon window: lit ceiling, seat backs, hand straps, standing / seated passengers as head + shoulders
    for (const c of [t, e]) {
      const lit = c === e;
      c.fillStyle = lit ? '#ffe8c8' : '#e8ecf4'; c.fillRect(dx + 120, 55, 110, 70);
      c.fillStyle = lit ? '#fff6e0' : '#ffffff'; c.fillRect(dx + 120, 55, 110, 6);                              // ceiling light
      c.fillStyle = lit ? 'rgba(90,110,60,0.9)' : '#6a8a4a'; c.fillRect(dx + 120, 104, 110, 21);             // seat backs (green moquette)
      c.fillStyle = 'rgba(40,40,44,0.8)'; for (let k = 0; k < 7; k++) { c.fillRect(dx + 126 + k * 15, 61, 1, 9); c.beginPath(); c.arc(dx + 126.5 + k * 15, 72, 2.4, 0, 6.3); c.stroke(); }   // straps
      for (let k = 0; k < 3; k++) {
        const px = dx + 134 + k * 34 + (L.hash(d, k, 91) - 0.5) * 10, top = 70 + L.hash(d, k, 92) * 16;
        c.fillStyle = ['#2a2c34', '#4a3e34', '#3a4a56'][(d + k) % 3]; c.beginPath(); c.moveTo(px - 11, top + 30); c.lineTo(px + 11, top + 30); c.lineTo(px + 9, top + 13); c.lineTo(px - 9, top + 13); c.closePath(); c.fill();
        c.fillStyle = lit ? '#b89276' : '#c9a48a'; c.beginPath(); c.ellipse(px, top + 6, 5, 6.5, 0, 0, 6.3); c.fill();
        c.fillStyle = '#1a1714'; c.beginPath(); c.ellipse(px, top + 3.5, 5.4, 4.2, 0, Math.PI, 0); c.fill();
      }
    }
    t.fillStyle = 'rgba(0,0,0,0.35)'; t.fillRect(dx + 118, 53, 114, 3); t.fillRect(dx + 118, 124, 114, 3);   // rubber frame
    t.fillStyle = '#8fc31f'; t.fillRect(dx, 150, 90, 26);
  }
  t.fillStyle = '#1a1a1a'; t.fillRect(0, 232, 1024, 24);
  const trainSide = L.std({ map: L.canvasTex(tc), emissiveMap: L.canvasTex(te), emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.7, envMapIntensity: 1.2 }); trainSide.name = 'rail_trainSide';
  trainSide.userData.sign = { emissive: 0.9 }; L.signMaterials.add(trainSide);
  for (const m of [ballast, platform, yellow, sleeper]) m.userData.noShadow = true;   // flat / low parts on the deck
  M = { concrete, darkConcrete, ballast, steel, sleeper, green, roof, platform, yellow, glass, silver, trainSide, running };
  return M;
}

// ---------------------------------------------------------------------------------------------------
// Running trains. A train is a set of identical cars riding a polyline; per part we keep ONE geometry and
// one InstancedMesh, so a 6-car train is 4 draw calls no matter where it is. update() advances the head
// distance, eases into the platform for a station stop, then accelerates away and wraps around.
const CAR_L = 19.5, CAR_GAP = 0.6, CARS = 6;
const TRAIN_LEN = CARS * CAR_L + (CARS - 1) * CAR_GAP;
let CAR_GEO = null;
/** Box part whose ±z (side) faces map the livery rows v0..v1; ends / top / bottom read the plain body corner. */
function bodyPart(w, y0, y1, v0, v1) {
  const g = new THREE.BoxGeometry(CAR_L, y1 - y0, w), uv = g.attributes.uv;
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; if (f === 4 || f === 5) uv.setY(i, v0 + uv.getY(i) * (v1 - v0)); else uv.setXY(i, 0.01, 0.9); }
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}
function carGeometry() {
  if (CAR_GEO) return CAR_GEO;
  // car origin = rail top. Side skirt 0.75 m → roof 3.85 m (the livery canvas spans it), the window band set 5 cm
  // into the body, roof cap, and the running gear below: two bogies (frame, 4 wheels, bolster), under-floor boxes,
  // a dark gangway bellows at one end filling the 0.6 m gap to the next car
  const B0 = 0.75, B1 = 3.85, H = B1 - B0, vy = (v) => B0 + v * H;
  const body = mergeAll([bodyPart(2.9, B0, vy(0.51), 0, 0.51), bodyPart(2.8, vy(0.51), vy(0.785), 0.51, 0.785), bodyPart(2.9, vy(0.785), B1, 0.785, 1)]);
  const roof = new THREE.BoxGeometry(CAR_L - 0.4, 0.2, 2.6); roof.translate(0, B1 + 0.1, 0);
  const unders = [];
  const frameG = new THREE.BoxGeometry(2.6, 0.32, 2.3), wheel = new THREE.CylinderGeometry(0.43, 0.43, 0.14, 10); wheel.rotateX(Math.PI / 2);
  for (const b of [-6.9, 6.9]) {
    const f = frameG.clone(); f.translate(b, 0.62, 0); unders.push(f);
    const bol = new THREE.BoxGeometry(0.5, 0.25, 2.5); bol.translate(b, 0.62, 0); unders.push(bol);
    for (const ax of [-1.05, 1.05]) for (const sd of [-0.78, 0.78]) { const w = wheel.clone(); w.translate(b + ax, 0.43, sd); unders.push(w); }
  }
  for (const [x, w] of [[-2.8, 2.6], [0.4, 2.2], [3.4, 1.6]]) { const e = new THREE.BoxGeometry(w, 0.55, 2.2); e.translate(x, 0.5, 0); unders.push(e); }   // under-floor equipment
  const gw = new THREE.BoxGeometry(CAR_GAP + 0.1, 2.3, 2.1); gw.translate(CAR_L / 2 + CAR_GAP / 2, B0 + 0.35 + 1.15, 0); unders.push(gw);   // gangway bellows
  const acs = [];
  for (const b of [-5.5, 5.5]) { const a = new THREE.BoxGeometry(2.4, 0.42, 1.9); a.translate(b, B1 + 0.41, 0); acs.push(a); const v = new THREE.BoxGeometry(1.8, 0.06, 1.5); v.translate(b, B1 + 0.65, 0); acs.push(v); }
  for (const sd of [-1.05, 1.05]) { const c = new THREE.BoxGeometry(CAR_L - 3, 0.08, 0.12); c.translate(0, B1 + 0.24, sd); acs.push(c); }   // roof conduits
  // single-arm pantograph (every other car): base frame, lower + upper arm, pan head
  const pan = [];
  { const base = new THREE.BoxGeometry(1.6, 0.18, 1.4); base.translate(2.6, B1 + 0.3, 0); pan.push(base);
    const arm1 = new THREE.BoxGeometry(0.1, 1.2, 0.1); arm1.rotateZ(-0.95); arm1.translate(2.15, B1 + 0.75, 0); pan.push(arm1);
    const arm2 = new THREE.BoxGeometry(0.08, 1.15, 0.08); arm2.rotateZ(0.75); arm2.translate(2.25, B1 + 1.3, 0); pan.push(arm2);
    const head = new THREE.BoxGeometry(0.2, 0.08, 1.9); head.translate(1.9, B1 + 1.72, 0); pan.push(head); }
  CAR_GEO = { body, roof, under: mergeAll(unders), ac: mergeAll(acs), pan: mergeAll(pan) };
  return CAR_GEO;
}
function mergeAll(list) {
  if (list.length === 1) return list[0];
  const out = list[0].clone();
  const pos = [], nor = [], uvs = [], idx = [];
  let base = 0;
  for (const g of list) {
    const p = g.attributes.position.array, n = g.attributes.normal.array, u = g.attributes.uv.array, i = g.index.array;
    for (let k = 0; k < p.length; k++) pos.push(p[k]);
    for (let k = 0; k < n.length; k++) nor.push(n[k]);
    for (let k = 0; k < u.length; k++) uvs.push(u[k]);
    for (let k = 0; k < i.length; k++) idx.push(i[k] + base);
    base += p.length / 3;
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  out.setIndex(idx);
  return out;
}

// per-frame scratch (train.update runs every frame, even in frozen shot presets: no allocation in the loop)
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1), _up = new THREE.Vector3(0, 1, 0);
const _smp = { x: 0, z: 0, dx: 1, dz: 0 };
/** Point + direction at arc length s on a polyline with a cumulative-length table (binary search, no allocation). */
function sampleAt(path, cum, s, out) {
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const a = path[lo], b = path[hi], l = cum[hi] - cum[lo] || 1, t = Math.min(1, Math.max(0, (s - cum[lo]) / l));
  out.x = a[0] + (b[0] - a[0]) * t; out.z = a[1] + (b[1] - a[1]) * t; out.dx = (b[0] - a[0]) / l; out.dz = (b[1] - a[1]) / l;
  return out;
}
function makeTrain(path, deckY, dir, startOffset) {
  const R = mats();
  const G = carGeometry();
  const len = L.polylineLength(path);
  const cum = [0]; for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const sphere = new THREE.Sphere();
  const g = new THREE.Group();
  g.name = 'rail:train';
  const parts = [
    new THREE.InstancedMesh(G.body, R.trainSide, CARS),
    new THREE.InstancedMesh(G.roof, R.silver, CARS),
    new THREE.InstancedMesh(G.under, R.running, CARS),
    new THREE.InstancedMesh(G.ac, R.steel, CARS),
  ];
  const pan = new THREE.InstancedMesh(G.pan, R.steel, CARS / 2);   // pantographs on cars 1, 3, 5
  pan.instanceMatrix.setUsage(THREE.DynamicDrawUsage); pan.boundingSphere = sphere; pan.castShadow = false;
  g.add(pan);
  for (const p of parts) {
    p.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    p.boundingSphere = sphere;               // one sphere around the whole train, refitted every update → culls
    p.castShadow = false; p.receiveShadow = true;
    g.add(p);
  }
  // station stop: the platform straddles the middle of the line, so park the train centred on it
  const stopS = len * 0.5 + TRAIN_LEN * 0.5;
  return {
    group: g, parts, pan, path, len, dir, y: deckY + 0.3,
    s: (stopS + startOffset) % len,          // distance of the NOSE along the path
    v: 0, hold: startOffset === 0 ? 6 : 0, stopS, done: startOffset !== 0,
    update(dt) {
      const TOP = 19, ACC = 5.5, BRAKE = 4.2, HOLD = 9;
      if (this.hold > 0) { this.hold -= dt; this.v = 0; }
      else {
        // distance still to run before the nose reaches the platform mark (wrapping around the loop)
        let toStop = this.done ? Infinity : (this.stopS - this.s + this.len) % this.len;
        const brakeDist = (this.v * this.v) / (2 * BRAKE);
        if (toStop < 0.4) { this.v = 0; this.hold = HOLD; this.done = true; this.s = this.stopS; }
        else if (toStop <= brakeDist + 0.5) this.v = Math.max(1.2, this.v - BRAKE * dt);
        else this.v = Math.min(TOP, this.v + ACC * dt);
        this.s += this.v * dt;
        if (this.s >= this.len) { this.s -= this.len; this.done = false; }   // round the loop, stop again
      }
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < CARS; i++) {
        let cs = this.s - CAR_L * 0.5 - i * (CAR_L + CAR_GAP);
        cs = ((cs % this.len) + this.len) % this.len;
        const p = sampleAt(this.path, cum, cs, _smp);
        _q.setFromAxisAngle(_up, Math.atan2(-p.dz * this.dir, p.dx * this.dir));
        _m.compose(_p.set(p.x, this.y, p.z), _q, _one);
        for (const part of this.parts) part.setMatrixAt(i, _m);
        if (i % 2) this.pan.setMatrixAt(i >> 1, _m);
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
      }
      for (const part of this.parts) part.instanceMatrix.needsUpdate = true;
      this.pan.instanceMatrix.needsUpdate = true;
      sphere.center.set((x0 + x1) / 2, this.y + 2.5, (z0 + z1) / 2);
      sphere.radius = Math.hypot(x1 - x0, z1 - z0) / 2 + CAR_L * 0.6 + 4;
    },
  };
}

export function buildRail(ctx) {
  const { CITY, batch, inst, world, group } = ctx;
  const R = mats();
  const rail = CITY.rail;
  const trains = [];
  // ------------------------------------------------------------------ JR viaduct
  {
    const r = rail.jr, y = r.elevation, half = r.width / 2;
    const pts = L.resample(r.path, 6);
    // deck slab + parapets
    batch.add(R.concrete, L.extrudePolygon([...L.offsetPolyline(pts, half), ...L.offsetPolyline(pts, -half).reverse()], y - 1.6, y, { cap: true, bottom: true, uvScale: 0.25 }), 60, 0);
    for (const side of [half - 0.25, -half + 0.25]) {
      const p = L.offsetPolyline(pts, side);
      batch.add(R.concrete, L.extrudePolygon([...L.offsetPolyline(p, 0.25), ...L.offsetPolyline(p, -0.25).reverse()], y, y + 1.4, { cap: true, uvScale: 0.5 }), 60, 0);
      // JR green band on the outer face of the parapet so the line reads as the station edge from above
      const o = L.offsetPolyline(pts, side + (side > 0 ? 0.29 : -0.29));
      batch.add(S.mats().jrGreen, L.extrudePolygon([...L.offsetPolyline(o, 0.03), ...L.offsetPolyline(o, -0.03).reverse()], y + 0.85, y + 1.25, { cap: true, bottom: true }), 60, 0);
    }
    // piers: portal frames every 18 m
    for (const p of L.alongPolyline(pts, 18, 6)) {
      const rot = Math.atan2(-p.dz, p.dx);
      for (const lat of [-half + 3, half - 3]) {
        const x = p.x - p.dz * lat, z = p.z + p.dx * lat;
        batch.add(R.concrete, L.boxAt(x, (y - 1.6) / 2, z, 1.8, y - 1.6, 1.8, rot, true), x, z);
        world.addStatic({ obb: { center: new THREE.Vector3(x, (y - 1.6) / 2, z), halfSize: new THREE.Vector3(0.95, (y - 1.6) / 2, 0.95), rotationY: rot } }, { tag: 'pier' });
      }
      // pier head: a hammerhead cap that runs 0.3 m past both deck edges (the pier rhythm read from the street)
      const perp = Math.atan2(p.dx, p.dz);
      batch.add(R.concrete, L.boxAt(p.x, y - 2.35, p.z, r.width + 0.6, 1.5, 2.0, rot, true), p.x, p.z);
      batch.add(R.darkConcrete, L.boxAt(p.x, y - 3.2, p.z, r.width - 4, 0.3, 1.7, rot, true), p.x, p.z);
      void perp;
    }
    // stepped deck edge: a proud precast fascia in 9 m units (dark joint between), a recessed drip step under it and
    // two longitudinal girders in the soffit shadow
    for (const sd of [1, -1]) {
      const edge = L.offsetPolyline(pts, sd * (half + 0.08));
      for (const q of L.alongPolyline(edge, 9, 0)) batch.add(R.concrete, L.boxAt(q.x + q.dx * 4.5, y - 0.75, q.z + q.dz * 4.5, 8.94, 1.1, 0.16, Math.atan2(-q.dz, q.dx), true), q.x, q.z);
      const drip = L.offsetPolyline(pts, sd * (half - 0.25));
      batch.add(R.darkConcrete, L.extrudePolygon([...L.offsetPolyline(drip, 0.1), ...L.offsetPolyline(drip, -0.1).reverse()], y - 1.95, y - 1.6, { cap: false, bottom: true, uvScale: 0.5 }), 60, 0);
      const gird = L.offsetPolyline(pts, sd * (half - 2.2));
      batch.add(R.darkConcrete, L.extrudePolygon([...L.offsetPolyline(gird, 0.45), ...L.offsetPolyline(gird, -0.45).reverse()], y - 2.7, y - 1.6, { cap: false, bottom: true, uvScale: 0.5 }), 60, 0);
    }
    // tracks: ballast + 2 rails each, sleepers instanced
    const trackLats = [-9.5, -3.2, 3.2, 9.5];
    for (const lat of trackLats) {
      const c = L.offsetPolyline(pts, lat);
      batch.add(R.ballast, L.ribbon(c, 3.4, y + 0.12, { uScale: 0.25 }), 60, 0);
      for (const rl of [-0.72, 0.72]) {
        const rp = L.offsetPolyline(c, rl);
        batch.add(R.steel, L.extrudePolygon([...L.offsetPolyline(rp, 0.04), ...L.offsetPolyline(rp, -0.04).reverse()], y + 0.12, y + 0.3, { cap: true, uvScale: 1 }), 60, 0);
      }
      for (const p of L.alongPolyline(c, 0.75, 0.3)) inst.add('sleeper', SLEEPER_GEO, R.sleeper, p.x, y + 0.14, p.z, Math.atan2(-p.dz, p.dx));
    }
    // catenary: a head-span portal every 50 m (H-section masts on the parapets, a lattice girder across all four
    // tracks), drop brackets + insulators over each track, messenger + contact wires
    for (const p of L.alongPolyline(pts, 50, 12)) {
      const rot = Math.atan2(-p.dz, p.dx), at = (lat, dy = 0) => [p.x - p.dz * lat, p.z + p.dx * lat];
      for (const lat of [-half + 0.6, half - 0.6]) {
        const [x, z] = at(lat);
        for (const f of [-0.14, 0.14]) batch.add(R.steel, L.boxAt(x + p.dx * f, y + 4.0, z + p.dz * f, 0.06, 8.0, 0.32, rot, false), x, z);   // flanges
        batch.add(R.steel, L.boxAt(x, y + 4.0, z, 0.26, 8.0, 0.04, rot, false), x, z);                                                 // web
        batch.add(R.darkConcrete, L.boxAt(x, y + 1.6, z, 0.7, 0.3, 0.7, rot, false), x, z);                                              // foot
      }
      const span = r.width - 1.2, perp = rot + Math.PI / 2;
      for (const yy of [y + 7.6, y + 8.4]) batch.add(R.steel, L.boxAt(p.x, yy, p.z, span, 0.12, 0.12, perp, false), p.x, p.z);   // girder chords
      for (let k = 0; k < 12; k++) {                                                                                             // girder lacing
        const l0 = -span / 2 + span * k / 12, l1 = -span / 2 + span * (k + 1) / 12, [ax, az] = at(l0), [bx, bz] = at(l1);
        const g = new THREE.BoxGeometry(0.06, Math.hypot(span / 12, 0.8), 0.06); g.rotateZ((k % 2 ? 1 : -1) * Math.atan2(span / 12, 0.8)); g.rotateY(perp); g.translate((ax + bx) / 2, y + 8.0, (az + bz) / 2);
        batch.add(R.steel, g, p.x, p.z);
      }
      for (const lat of trackLats) {
        const [x, z] = at(lat);
        batch.add(R.steel, L.boxAt(x, y + 6.95, z, 0.08, 1.3, 0.08, rot, false), x, z);                                               // dropper
        batch.add(R.steel, L.boxAt(x, y + 6.3, z, 0.07, 0.07, 1.6, perp + Math.PI / 2, false), x, z);                                 // cantilever
        batch.add(R.sleeper, S.placed(new THREE.CylinderGeometry(0.09, 0.09, 0.45, 8), x, y + 7.4, z), x, z);                        // insulator
      }
    }
    for (const lat of trackLats) {
      const c = L.offsetPolyline(pts, lat);
      batch.add(R.steel, L.extrudePolygon([...L.offsetPolyline(c, 0.02), ...L.offsetPolyline(c, -0.02).reverse()], y + 5.2, y + 5.25, { cap: true }), 60, 0);
      batch.add(R.steel, L.extrudePolygon([...L.offsetPolyline(c, 0.015), ...L.offsetPolyline(c, -0.015).reverse()], y + 6.28, y + 6.32, { cap: true }), 60, 0);
    }
    // ---- island platforms (between tracks) in the station section
    const zs0 = -34, zs1 = 96;
    const platPts = pts.filter(p => p[1] > zs0 - 8 && p[1] < zs1 + 8);
    const along = L.alongPolyline(pts, 1, 0).filter(p => p.z >= zs0 && p.z <= zs1).map(p => [p.x, p.z]);
    for (const lat of [-6.35, 6.35]) {
      const c = L.offsetPolyline(along, lat);
      batch.add(R.platform, L.extrudePolygon([...L.offsetPolyline(c, 2.3), ...L.offsetPolyline(c, -2.3).reverse()], y + 0.12, y + 1.1, { cap: true, uvScale: 0.5 }), 60, 30);
      for (const e of [1.8, -1.8]) batch.add(R.yellow, L.ribbon(L.offsetPolyline(c, e), 0.3, y + 1.106, { uScale: 3 }), 60, 30);
      // roof: columns every 9 m + flat roof
      for (const p of L.alongPolyline(c, 9, 4)) { batch.add(R.steel, L.boxAt(p.x, y + 1.1 + 1.9, p.z, 0.3, 3.8, 0.3, 0, false), p.x, p.z); }
      batch.add(R.roof, L.extrudePolygon([...L.offsetPolyline(c, 2.6), ...L.offsetPolyline(c, -2.6).reverse()], y + 4.9, y + 5.15, { cap: true, bottom: true, uvScale: 0.5 }), 60, 30);
      // lit soffit under the roof + white fascia bars along both roof edges: the platform reads as a bright bar at night
      const SM = S.mats();
      batch.add(SM.interiorDim, L.extrudePolygon([...L.offsetPolyline(c, 2.45), ...L.offsetPolyline(c, -2.45).reverse()], y + 4.72, y + 4.88, { cap: false, bottom: true }), 60, 30);
      for (const e of [2.62, -2.62]) { const f = L.offsetPolyline(c, e); batch.add(SM.glowWhite, L.extrudePolygon([...L.offsetPolyline(f, 0.06), ...L.offsetPolyline(f, -0.06).reverse()], y + 4.93, y + 5.12, { cap: true, bottom: true }), 60, 30); }
      // station name boards hanging at both platform edges, every 27 m (offset per side) + white strip lights
      for (const [e, start] of [[1.9, 12], [-1.9, 25]]) for (const p of L.alongPolyline(L.offsetPolyline(c, e), 27, start)) {
        S.signQuad(batch, p.x, y + 3.9, p.z, p.dz, -p.dx, { text: '渋谷町', sub: 'Shibuya-cho  しぶやちょう', w: 3.2, h: 1.0, bg: '#ffffff', fg: '#111111', emissive: 1.0, double: true });
        S.signQuad(batch, p.x, y + 3.25, p.z, p.dz, -p.dx, { text: '山手線', w: 3.2, h: 0.3, bg: '#8fc31f', fg: '#ffffff', emissive: 0.8, double: true });
      }
      for (const p of L.alongPolyline(c, 4.5, 2)) inst.add('platLight', PLAT_LIGHT_GEO, SM.glowWhite, p.x, y + 4.66, p.z, Math.atan2(-p.dz, p.dx));
    }
    void platPts;
    // ---- running JP trains. Cars are identical, so each part is ONE InstancedMesh with an instance per
    //      car: a 6-car train costs 4 draw calls however it moves. The whole train is not a rigid body —
    //      every car is placed on the polyline independently, so it bends through the curve into the
    //      station instead of cutting the corner.
    trains.push(makeTrain(L.offsetPolyline(pts, -9.5), y, +1, 0));    // northbound, at the platform first
    trains.push(makeTrain(L.offsetPolyline(pts, 3.2), y, -1, 46));    // southbound, arrives later
  }
  // ------------------------------------------------------------------ 銀座線 box viaduct + glazed station
  {
    const r = rail.ginza, y = r.elevation, half = r.width / 2;
    const pts = L.resample(r.path, 5);
    const jr = rail.jr.path;
    const nearJr = (x, z) => { for (let i = 0; i < jr.length - 1; i++) if (L.distToSegment(x, z, jr[i][0], jr[i][1], jr[i + 1][0], jr[i + 1][1]) < 15) return true; return false; };
    batch.add(R.concrete, L.extrudePolygon([...L.offsetPolyline(pts, half), ...L.offsetPolyline(pts, -half).reverse()], y - 1.8, y, { cap: true, bottom: true, uvScale: 0.25 }), 60, 60);
    for (const side of [half - 0.2, -half + 0.2]) {
      const p = L.offsetPolyline(pts, side);
      batch.add(R.concrete, L.extrudePolygon([...L.offsetPolyline(p, 0.2), ...L.offsetPolyline(p, -0.2).reverse()], y, y + 1.3, { cap: true, uvScale: 0.5 }), 60, 60);
    }
    for (const lat of [-2.0, 2.0]) {
      const c = L.offsetPolyline(pts, lat);
      batch.add(R.ballast, L.ribbon(c, 3.0, y + 0.1, { uScale: 0.25 }), 60, 60);
      for (const rl of [-0.72, 0.72]) { const rp = L.offsetPolyline(c, rl); batch.add(R.steel, L.extrudePolygon([...L.offsetPolyline(rp, 0.04), ...L.offsetPolyline(rp, -0.04).reverse()], y + 0.1, y + 0.26, { cap: true }), 60, 60); }
    }
    // piers every ~20 m, each slid along the line (±10 m) onto a pavement / island spot with room for its 2 m foot:
    // over the 西口 terminal the viaduct spans the carriageways and stands on the platform island
    const field = ctx.field, dense = L.alongPolyline(pts, 1, 0);
    const okAt = (q) => !field || (field.sample(q.x, q.z) > 1.35 && [[1, 1], [1, -1], [-1, 1], [-1, -1]].every(([a, b]) => field.sample(q.x + a, q.z + b) > 0.2));
    const piers = [];
    for (const p of L.alongPolyline(pts, 20, 8)) {
      if (okAt(p)) { piers.push(p); continue; }
      let best = null;
      for (const q of dense) if (Math.abs(q.s - p.s) <= 10 && okAt(q) && (!best || Math.abs(q.s - p.s) < Math.abs(best.s - p.s))) best = q;
      if (best && !piers.some(o => Math.abs(o.s - best.s) < 12)) piers.push(best);
    }
    for (const p of piers) {
      const insideMark = p.x < -40;   // runs through Mark City's 3F
      // (over the 東口 terminal the station's own piers are eastExit.js's; none stands in 明治通り)
      if (insideMark || nearJr(p.x, p.z) || (p.x > 100 && p.x < 192)) continue;
      batch.add(R.concrete, L.boxAt(p.x, (y - 1.8) / 2, p.z, 2.0, y - 1.8, 2.0, 0, true), p.x, p.z);
      world.addStatic({ obb: { center: new THREE.Vector3(p.x, (y - 1.8) / 2, p.z), halfSize: new THREE.Vector3(1.05, (y - 1.8) / 2, 1.05), rotationY: 0 } }, { tag: 'pier' });
      batch.add(R.concrete, L.boxAt(p.x, y - 2.4, p.z, r.width + 1, 1.2, 2.0, Math.atan2(-p.dz, p.dx), true), p.x, p.z);
    }
    // station enclosure (the 2020 "M-shaped" glass hall over 明治通り): steel ribs + glass sides + roof
    const st = r.station;
    const sPts = L.alongPolyline(pts, 1, 0).filter(p => p.x >= st.from[0] && p.x <= st.to[0]).map(p => [p.x, p.z]);
    if (sPts.length > 4) {
      const w = half + 3.5;
      for (const side of [w, -w]) {
        const c = L.offsetPolyline(sPts, side);
        batch.add(R.glass, L.extrudePolygon([...L.offsetPolyline(c, 0.05), ...L.offsetPolyline(c, -0.05).reverse()], y - 0.2, y + 6.5, { cap: false, uvScale: 0.2 }), 150, 30);
      }
      for (const p of L.alongPolyline(sPts, 6, 2)) {
        const rot = Math.atan2(-p.dz, p.dx);
        // M-shaped rib: two outer posts + a peaked roof beam
        batch.add(R.silver, L.boxAt(p.x, y + 3.3, p.z, 0.3, 7.0, 0.3, 0, false), p.x, p.z);
        for (const lat of [-w, w]) { const x = p.x - p.dz * lat, z = p.z + p.dx * lat; batch.add(R.silver, L.boxAt(x, y + 3.2, z, 0.3, 6.8, 0.3, 0, false), x, z); }
        const beam = L.boxAt(0, 0, 0, 2 * w + 0.6, 0.35, 0.35, 0, false); beam.rotateY(Math.PI / 2 + rot); beam.translate(p.x, y + 6.8, p.z); batch.add(R.silver, beam, p.x, p.z);
      }
      batch.add(R.silver, L.extrudePolygon([...L.offsetPolyline(sPts, w + 0.4), ...L.offsetPolyline(sPts, -w - 0.4).reverse()], y + 6.8, y + 7.1, { cap: true, bottom: true, uvScale: 0.3 }), 150, 30);
      const mid = sPts[Math.floor(sPts.length / 2)];
      S.signQuad(batch, mid[0], y + 8.2, mid[1], Math.sin(0.3), Math.cos(0.3), { text: '渋谷町', sub: '東京メトロ 銀座線', w: 6, h: 1.6, bg: '#f7f7f7', fg: '#f39c12', emissive: 1.1, double: true });
    }
  }
  // ------------------------------------------------------------------ 井の頭線 tail
  {
    const r = rail.inokashira, y = r.elevation, half = r.width / 2;
    const pts = L.resample(r.path, 6);
    batch.add(R.concrete, L.extrudePolygon([...L.offsetPolyline(pts, half), ...L.offsetPolyline(pts, -half).reverse()], y - 1.4, y, { cap: true, bottom: true, uvScale: 0.25 }), -170, 130);
    for (const lat of [-2.2, 2.2]) {
      const c = L.offsetPolyline(pts, lat);
      batch.add(R.ballast, L.ribbon(c, 3.0, y + 0.1, { uScale: 0.25 }), -170, 130);
      for (const rl of [-0.72, 0.72]) { const rp = L.offsetPolyline(c, rl); batch.add(R.steel, L.extrudePolygon([...L.offsetPolyline(rp, 0.04), ...L.offsetPolyline(rp, -0.04).reverse()], y + 0.1, y + 0.26, { cap: true }), -170, 130); }
    }
    for (const p of L.alongPolyline(pts, 16, 8)) {
      if (p.x > -128) continue;   // inside Mark City
      batch.add(R.concrete, L.boxAt(p.x, (y - 1.4) / 2, p.z, 1.6, y - 1.4, 1.6, 0, true), p.x, p.z);
      world.addStatic({ obb: { center: new THREE.Vector3(p.x, (y - 1.4) / 2, p.z), halfSize: new THREE.Vector3(0.85, (y - 1.4) / 2, 0.85), rotationY: 0 } }, { tag: 'pier' });
    }
  }
  for (const t of trains) { t.update(0); group.add(t.group); }
  return { trains };
}

export default { buildRail };
