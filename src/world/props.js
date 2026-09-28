// [props] Street furniture for 渋谷町: everything between the kerb and the shop front.
// Streetlights (curved mast arms, emissive lens + additive light cone), traffic signals read from
// CITY.crossing.signals (Japanese 3-lamp vehicle heads with hoods + 人形 pedestrian heads with a bar countdown),
// utility poles with catenary cables and transformers, guardrails, bollards, planters, benches, zelkova trees,
// vending machines with lit brand faces, parked bicycles/scooters, cones, bins, A-frame boards, nobori flags,
// menu boards, umbrella stands, Metro entrances, koban details and parked delivery trucks.
//
// Everything is one InstancedMesh per type (or one merged mesh), colour baked into a vertex-colour attribute so a
// whole family of parts shares a single material. Sign faces are staged into signage's atlas and flushed, so they
// cost no extra draw calls.
//
// Exports (module object):
//   props.lights []            { position: Vector3, color, intensity, distance }  — streetlight heads for lighting.js
//   props.dynamics []          { body, type }  — props registered with world.addDynamic, tag 'weapon'
//   props.setSignalState({ns, ew, ped, remaining})   also driven by engine.events 'signal:phase' / traffic.signal
//   emits 'prop:impact' { point, strength } when a dynamic prop lands or is hit (crowd flinches from it)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, groundY } from './cityData.js';
import { tenantType } from './buildings/genericBuilding.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();
const _c = new THREE.Color();
const _dirty = new Set();                // reused every frame by update()'s dynamics block
const UP = new THREE.Vector3(0, 1, 0);
const SW_H = 0.15;                       // sidewalk height (streets.js)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------------------------------------ geometry helpers
function tint(geo, hex) {
  const n = geo.attributes.position.count, arr = new Float32Array(n * 3);
  _c.set(hex);
  for (let i = 0; i < n; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
// alpha ramps with distance from the local Y axis: full on the axis, 0 on the rim, so a light volume has no
// silhouette edge at all. `power` > 1 keeps the core tight.
function fadeRadial(geo, hex, peak, power = 1.6) {
  const pos = geo.attributes.position, n = pos.count, arr = new Float32Array(n * 4);
  let rmax = 1e-6;
  for (let i = 0; i < n; i++) { const r = Math.hypot(pos.getX(i), pos.getZ(i)); if (r > rmax) rmax = r; }
  _c.set(hex);
  for (let i = 0; i < n; i++) {
    const t = clamp(Math.hypot(pos.getX(i), pos.getZ(i)) / rmax, 0, 1);
    arr[i * 4] = _c.r; arr[i * 4 + 1] = _c.g; arr[i * 4 + 2] = _c.b;
    arr[i * 4 + 3] = peak * Math.pow(1 - t, power);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 4));
  return geo;
}
// contact shadow for MultiplyBlending: the colour itself ramps dark→white, so the decal darkens the wet
// asphalt instead of replacing it with flat black (alpha is ignored by a multiply blend).
function fadeMultiply(geo, darkness, power = 2.2) {
  const pos = geo.attributes.position, n = pos.count, arr = new Float32Array(n * 3);
  let rmax = 1e-6;
  for (let i = 0; i < n; i++) { const r = Math.hypot(pos.getX(i), pos.getZ(i)); if (r > rmax) rmax = r; }
  for (let i = 0; i < n; i++) {
    const t = clamp(Math.hypot(pos.getX(i), pos.getZ(i)) / rmax, 0, 1);
    const v = 1 - darkness * Math.pow(1 - t, power);
    arr[i * 3] = v; arr[i * 3 + 1] = v; arr[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
// a ground decal ring with enough rings that the alpha curve is actually sampled: one phi segment turns any
// power curve into a straight ramp, and a straight ramp has a hard edge at the rim.
function decalRing(r0, r1, seg, rings, y) {
  const g = new THREE.RingGeometry(r0, r1, seg, rings);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}
function xf(geo, o = {}) {
  if (o.sx != null || o.sy != null || o.sz != null) geo.scale(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
  if (o.rx) geo.rotateX(o.rx);
  if (o.rz) geo.rotateZ(o.rz);
  if (o.ry) geo.rotateY(o.ry);
  geo.translate(o.x || 0, o.y || 0, o.z || 0);
  return geo;
}
const B = (w, h, d, o) => xf(new THREE.BoxGeometry(w, h, d), o);
const CY = (rt, rb, h, seg, o) => xf(new THREE.CylinderGeometry(rt, rb, h, seg, 1, false), o);
// open-ended: a thin tube whose caps are never seen costs half as many triangles
const CYO = (rt, rb, h, seg, o) => xf(new THREE.CylinderGeometry(rt, rb, h, seg, 1, true), o);
const SP = (r, o, w = 9, h = 6) => xf(new THREE.SphereGeometry(r, w, h), o);
const TOR = (r, t, o, rs = 6, ts = 14) => xf(new THREE.TorusGeometry(r, t, rs, ts), o);
const PL = (w, h, o) => xf(new THREE.PlaneGeometry(w, h), o);
const merge = (list) => mergeGeometries(list.filter(Boolean), false);

// ---------------------------------------------------------------------------------------------- instancing
function Instancer(group) {
  const defs = new Map();
  const api = {
    def(key, geo, mat, o = {}) { if (!defs.has(key)) defs.set(key, { geo, mat, o, items: [], colors: [], im: null }); return key; },
    add(key, x, y, z, ry = 0, s = 1, color = null, extra = null) {
      const d = defs.get(key); if (!d) return -1;
      const m = new THREE.Matrix4();
      _q.setFromAxisAngle(UP, ry);
      if (typeof s === 'number') _s.set(s, s, s); else _s.set(s[0], s[1], s[2]);
      m.compose(_p.set(x, y, z), _q, _s);
      if (extra) m.multiply(extra);
      d.items.push(m); d.colors.push(color);
      return d.items.length - 1;
    },
    count(key) { const d = defs.get(key); return d ? d.items.length : 0; },
    get(key) { const d = defs.get(key); return d ? d.im : null; },
    build() {
      const out = [];
      for (const [key, d] of defs) {
        if (!d.items.length) continue;
        const im = new THREE.InstancedMesh(d.geo, d.mat, d.items.length);
        im.name = 'props:' + key;
        for (let i = 0; i < d.items.length; i++) {
          im.setMatrixAt(i, d.items[i]);
          if (d.colors[i] != null) im.setColorAt(i, _c.set(d.colors[i]));
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.castShadow = !!d.o.shadow; im.receiveShadow = !!d.o.receive;
        if (d.o.bloom) im.layers.enable(1);
        if (d.o.dynamic) im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (d.o.noCull) im.frustumCulled = false;
        if (d.o.order != null) im.renderOrder = d.o.order;
        d.im = im; group.add(im); out.push(im);
      }
      return out;
    },
  };
  return api;
}

// -------------------------------------------------------------------------------------------- canvas textures
function canvasTex(c, { srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso; t.needsUpdate = true;
  return t;
}
function foliageTexture(rng) {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d');
  x.clearRect(0, 0, S, S);
  for (let i = 0; i < 2600; i++) {
    const a = rng() * Math.PI * 2, rr = Math.pow(rng(), 0.55);
    const px = S / 2 + Math.cos(a) * rr * 244, py = S / 2 + Math.sin(a) * rr * 232 - 8;
    if (rng() < rr * rr * 0.75) continue;                       // ragged, thinning edge
    const s = 22 - rr * 9 + rng() * 9;
    const g = 58 + rng() * 96, warm = rng() * 26;
    x.save(); x.translate(px, py); x.rotate(rng() * Math.PI);
    x.fillStyle = `rgba(${Math.round(20 + g * 0.42 + warm)},${Math.round(40 + g)},${Math.round(18 + g * 0.3)},${0.5 + rng() * 0.5})`;
    x.beginPath(); x.ellipse(0, 0, s * 0.5, s * 0.22, 0, 0, Math.PI * 2); x.fill();
    x.restore();
  }
  // interior shading + a lit crown, painted only where leaves already are (keeps the cut-out alpha)
  x.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 70; i++) {
    const a = rng() * Math.PI * 2, rr = Math.pow(rng(), 0.7) * 200;
    const cx = S / 2 + Math.cos(a) * rr, cy = S / 2 + Math.sin(a) * rr, R = 34 + rng() * 36;
    const g = x.createRadialGradient(cx, cy, 2, cx, cy, R);
    const up = cy < S * 0.45;
    g.addColorStop(0, up ? 'rgba(168,190,120,0.34)' : 'rgba(14,26,12,0.42)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.fill();
  }
  x.globalCompositeOperation = 'source-over';
  // dilate: a blurred copy under the crisp one widens the alpha ramp by ~2 px so alphaTest 0.35 lands on a
  // gradient instead of a binary edge. Without it the cut-out is a razor stair-step that crawls in motion.
  const d = document.createElement('canvas'); d.width = d.height = S;
  const dx2 = d.getContext('2d');
  dx2.filter = 'blur(2.5px)'; dx2.drawImage(c, 0, 0);
  dx2.filter = 'none'; dx2.globalAlpha = 0.9; dx2.drawImage(c, 0, 0);
  return canvasTex(d);
}
// 256×512: top half = red standing figure, bottom half = green walking figure (人形式歩行者灯器).
// The lens colour is baked here, not driven from the emissive: the instance colour only gates on/off, so the
// figure keeps its shape instead of blowing out into a saturated dot under bloom.
function pedFigureTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = S; c.height = S * 2;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, S, S * 2);
  const fig = (oy, col, glow, walk) => {
    x.save();
    x.beginPath(); x.arc(S / 2, oy + S / 2, S * 0.46, 0, Math.PI * 2); x.clip();
    x.fillStyle = '#060706'; x.fillRect(0, oy, S, S);
    const g = x.createRadialGradient(S / 2, oy + S / 2, 4, S / 2, oy + S / 2, S * 0.46);
    g.addColorStop(0, glow); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, oy, S, S);
    x.translate(S / 2, oy + S / 2);
    x.scale(2, 2);
    x.fillStyle = col; x.strokeStyle = col; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.arc(walk ? -2 : 0, -34, 9.5, 0, Math.PI * 2); x.fill();
    x.lineWidth = 14;
    x.beginPath(); x.moveTo(walk ? -2 : 0, -24); x.lineTo(walk ? 1 : 0, -2); x.stroke();     // torso
    x.lineWidth = 9.5;
    if (walk) {
      x.beginPath(); x.moveTo(1, -2); x.lineTo(-13, 16); x.lineTo(-17, 36); x.stroke();      // rear leg
      x.beginPath(); x.moveTo(1, -2); x.lineTo(13, 14); x.lineTo(16, 36); x.stroke();        // front leg
      x.beginPath(); x.moveTo(-2, -20); x.lineTo(-16, -8); x.lineTo(-14, 6); x.stroke();     // arms
      x.beginPath(); x.moveTo(-2, -20); x.lineTo(14, -12); x.lineTo(18, -2); x.stroke();
    } else {
      x.beginPath(); x.moveTo(0, -2); x.lineTo(-7, 18); x.lineTo(-8, 36); x.stroke();
      x.beginPath(); x.moveTo(0, -2); x.lineTo(7, 18); x.lineTo(8, 36); x.stroke();
      x.beginPath(); x.moveTo(0, -20); x.lineTo(-13, -6); x.lineTo(-13, 8); x.stroke();
      x.beginPath(); x.moveTo(0, -20); x.lineTo(13, -6); x.lineTo(13, 8); x.stroke();
    }
    x.restore();
  };
  fig(0, '#ff5240', 'rgba(150,26,14,0.5)', false);        // canvas top → UV v 0.5..1
  fig(S, '#5cff9e', 'rgba(14,120,60,0.5)', true);         // canvas bottom → UV v 0..0.5
  return canvasTex(c);
}
// のぼり cloth. Painted here rather than through signage's 'cloth' default so the glyphs get plate-class paint
// density: a 0.58 × 1.7 m flag at 80 ppm is a 46 × 136 px tile and every stroke is a 6 px ramp.
const JPFONT = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif';
function paintNobori(ctx, w, h, o) {
  ctx.fillStyle = o.bg; ctx.fillRect(0, 0, w, h);
  // across the claimed S-bend: the hem is in shadow, the belly catches the shop light
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.34)'); g.addColorStop(0.2, 'rgba(255,255,255,0.10)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.06)'); g.addColorStop(0.78, 'rgba(255,255,255,0.09)');
  g.addColorStop(1, 'rgba(0,0,0,0.26)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const v = ctx.createLinearGradient(0, 0, 0, h);
  v.addColorStop(0, 'rgba(255,255,255,0.06)'); v.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.88)'; ctx.lineWidth = Math.max(2, w * 0.03);
  ctx.strokeRect(w * 0.075, h * 0.028, w * 0.85, h * 0.944);
  const chars = [...o.text];
  const boxH = h * 0.82, cell = Math.min(boxH / chars.length, w * 0.7);
  const size = cell * 0.94;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `900 ${size}px ${JPFONT}`;
  ctx.lineJoin = 'round';
  const y0 = h * 0.5 - (chars.length - 1) * cell / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.lineWidth = size * 0.1; ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeText(chars[i], w * 0.5, y0 + i * cell);
    ctx.fillStyle = o.fg || '#ffffff';
    ctx.fillText(chars[i], w * 0.5, y0 + i * cell);
  }
}
// vending-machine flank: thin vertical ribs + a maker plate
function flankTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#d8d9d6'; x.fillRect(0, 0, 64, 128);
  for (let i = 0; i < 64; i += 4) { x.fillStyle = i % 8 ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.08)'; x.fillRect(i, 0, 2, 128); }
  x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, 0, 64, 5); x.fillRect(0, 123, 64, 5);
  return canvasTex(c);
}

// ------------------------------------------------------------------------------------------------ materials
// emissive driven by the (instance × vertex) colour so one material lights every lamp in the city
function emissiveVC(intensity, map) {
  const m = new THREE.MeshStandardMaterial({ color: 0x04040a, roughness: 0.35, metalness: 0, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 1 });
  if (map) m.emissiveMap = map;
  m.userData.uEmit = { value: intensity };
  m.onBeforeCompile = (s) => {
    s.uniforms.uEmit = m.userData.uEmit;
    s.fragmentShader = 'uniform float uEmit;\n' + s.fragmentShader
      .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * vColor.rgb * uEmit;');
  };
  m.name = 'props:emit';
  return m;
}

// --------------------------------------------------------------------------------------- placement utilities
function Occupancy(cell = 3, guard = null) {
  const map = new Map();
  return {
    guard,
    free(x, z, r) {
      const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const list = map.get(`${ci + i},${cj + j}`); if (!list) continue;
        for (let k = 0; k < list.length; k += 3) {
          const dx = x - list[k], dz = z - list[k + 1], rr = r + list[k + 2];
          if (dx * dx + dz * dz < rr * rr) return false;
        }
      }
      return true;
    },
    take(x, z, r) {
      const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
      let list = map.get(key); if (!list) map.set(key, list = []);
      list.push(x, z, r);
    },
    // `phys` = the prop's physical radius for the placement guard (default: under half the spacing radius, max
    // 0.35 m); -1 exempts a claim that is meant to be on the carriageway (traffic's loading bays)
    claim(x, z, r, phys) {
      if (this.guard && phys !== -1 && !this.guard(x, z, phys ?? Math.min(0.5, r * 0.5))) return false;
      if (!this.free(x, z, r)) return false; this.take(x, z, r); return true;
    },
    // an oriented claim for long thin props (a parked bicycle is 1.75 m × 0.5 m, not a 0.27 m disc): a capsule
    // of `n` discs along `ry`. Disc radius stays under half the row pitch so a tidy row still fits.
    claimRun(x, z, ry, len, r, n = 4) {
      const dx = Math.cos(ry), dz = -Math.sin(ry);
      for (let i = 0; i < n; i++) {
        const t = (i / (n - 1) - 0.5) * len;
        if (this.guard && !this.guard(x + dx * t, z + dz * t, Math.max(0.12, r), false)) return false;
        if (!this.free(x + dx * t, z + dz * t, r)) return false;
      }
      // the run as a whole must still leave 1.5 m of pavement (a row of bicycles across a 3.5 m pavement does not)
      if (this.guard && !this.guard.widthOk(x, z, len / 2 + r)) return false;
      for (let i = 0; i < n; i++) {
        const t = (i / (n - 1) - 0.5) * len;
        this.take(x + dx * t, z + dz * t, r);
      }
      return true;
    },
  };
}

// Building footprints from the physics world, hashed on a grid. Occupancy only knows about props, so without
// this a signal head or a planter can be planted inside a wall.
function Footprints(world, cell = 8) {
  const map = new Map();
  const shapes = [];
  const K = (cx, cz) => (cx + 4096) * 8192 + (cz + 4096);
  for (const sh of (world && world.statics) || []) {
    if (sh.tag === 'prop' || sh.tag === 'pole' || sh.tag === 'tree' || sh.tag === 'vehicle' || sh.tag === 'weapon' || sh.tag === 'bounds') continue;
    if (sh.max.x - sh.min.x > 150 || sh.max.z - sh.min.z > 150) continue;
    if (sh.max.y < 0.4 || sh.min.y > 1.6) continue;                  // overhead decks / canopies / sign boxes do not stand on the pavement
    const i = shapes.length; shapes.push(sh);
    for (let cx = Math.floor(sh.min.x / cell); cx <= Math.floor(sh.max.x / cell); cx++)
      for (let cz = Math.floor(sh.min.z / cell); cz <= Math.floor(sh.max.z / cell); cz++) {
        const k = K(cx, cz); let l = map.get(k); if (!l) map.set(k, l = []); l.push(i);
      }
  }
  // exact test: an OBB footprint is tested in its own frame (a rotated block's AABB swallowed the pavement beside it)
  const inside = (sh, x, z, pad) => {
    if (sh.kind !== 'obb') return x > sh.min.x - pad && x < sh.max.x + pad && z > sh.min.z - pad && z < sh.max.z + pad;
    const dx = x - sh.center.x, dz = z - sh.center.z, lx = sh.c * dx - sh.s * dz, lz = sh.s * dx + sh.c * dz;
    return Math.abs(lx) < sh.half.x + pad && Math.abs(lz) < sh.half.z + pad;
  };
  return {
    n: shapes.length,
    hit(x, z, pad = 0) {
      const l = map.get(K(Math.floor(x / cell), Math.floor(z / cell)));
      if (!l) return false;
      for (const i of l) if (inside(shapes[i], x, z, pad)) return true;
      return false;
    },
  };
}

// Street-furniture placement guard (client: 「明らかに、道路の真ん中に電柱立ってたりおかしいよね」). Every placer claims
// its spot through Occupancy.claim / claimRun, so the rules live here, map-wide: nothing on a carriageway (street
// field: roads + busways + aprons), nothing in a zebra band or on its kerb landing, nothing along a kerbside bus bay
// where the doors open, and no standing prop that leaves less than 1.5 m of clear pavement beside it (checked across
// the narrowest of four cross-sections against buildings / structures and the kerb). docs/reports/props-audit.mjs
// audits the result.
function PlacementGuard(field, foot) {
  if (!field) return null;
  const inPoly = (x, z, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { if ((p[i][1] > z) !== (p[j][1] > z) && x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) c = !c; } return c; };
  const F = (x, z) => field.sample(x, z);
  const cws = [...((CITY.crossing && CITY.crossing.crosswalks) || []), ...((CITY.crossing && CITY.crossing.diagonals) || []), ...(CITY.crosswalksExtra || [])].map((c) => {
    const dx = c.b[0] - c.a[0], dz = c.b[1] - c.a[1], len = Math.hypot(dx, dz) || 1;
    return { ax: c.a[0], az: c.a[1], ux: dx / len, uz: dz / len, len, hw: (c.width || 6) / 2 };
  });
  const bays = (CITY.busStops || []).filter((b) => b.road).map((b) => ({ x: b.pos[0], z: b.pos[1], ux: Math.cos(b.heading), uz: -Math.sin(b.heading) }));
  const DIRS = Array.from({ length: 8 }, (_, k) => [Math.cos(k * Math.PI / 8), Math.sin(k * Math.PI / 8)]);
  const free1 = (x, z, dx, dz, r) => {
    for (let d = 0.3; d <= 1.81; d += 0.3) { const px = x + dx * (r + d), pz = z + dz * (r + d); if (F(px, pz) < 0 || (foot && foot.hit(px, pz))) return d - 0.3; }
    return 1.8;
  };
  const stats = { road: 0, crosswalk: 0, busBay: 0, narrow: 0 };
  const ok = (x, z, phys, widthTest = true) => {
    const f = F(x, z);
    if (f < phys + 0.1) { stats.road++; return false; }
    if (foot && foot.hit(x, z, 0)) { stats.building = (stats.building || 0) + 1; return false; }
    if (CITY.propFree && CITY.propFree.some((poly) => inPoly(x, z, poly))) { stats.building = (stats.building || 0) + 1; return false; }   // station interiors
    if (f < 1.3) {
      for (const c of cws) { const px = x - c.ax, pz = z - c.az, t = px * c.ux + pz * c.uz; if (t < -1.0 - phys || t > c.len + 1.0 + phys) continue; if (Math.abs(-px * c.uz + pz * c.ux) < c.hw + phys) { stats.crosswalk++; return false; } }
      for (const b of bays) { const t = (x - b.x) * b.ux + (z - b.z) * b.uz; if (Math.abs(t) < 7 && Math.hypot(x - b.x - b.ux * t, z - b.z - b.uz * t) < 8) { stats.busBay++; return false; } }
    }
    if (widthTest && phys >= 0.1 && !widthOk(x, z, phys)) { stats.narrow++; return false; }
    return true;
  };
  const widthOk = (x, z, phys) => {
    let span = 1e9, clear = 0;
    for (const [dx, dz] of DIRS) { const a = free1(x, z, dx, dz, phys), b = free1(x, z, -dx, -dz, phys); if (a + b < span) { span = a + b; clear = Math.max(a, b); } }
    return clear >= 1.5;
  };
  ok.widthOk = (x, z, phys) => { if (widthOk(x, z, phys)) return true; stats.narrow++; return false; };
  ok.stats = stats; ok.F = F;
  // nearest spot (≤ maxD) that passes the guard: hand-placed furniture (Metro entrances, shelters, signal posts)
  // is moved onto the pavement instead of dropped
  ok.snap = (x, z, phys, maxD = 8, occ = null, r = 0, fits = null) => {
    const good = (px, pz) => ok(px, pz, phys) && (!fits || fits(px, pz)) && (!occ || occ.free(px, pz, r));
    if (good(x, z)) return [x, z];
    for (let d = 0.5; d <= maxD; d += 0.5) for (let k = 0; k < 16; k++) {
      const a = k / 16 * Math.PI * 2, px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      if (good(px, pz)) return [px, pz];
    }
    return null;
  };
  // a rotated box footprint (local x0..x1 × z0..z1 at yaw ry) wholly on the pavement: corners + edge midpoints
  ok.box = (x, z, ry, x0, x1, z0, z1) => {
    const c = Math.cos(ry), sn = Math.sin(ry);
    for (const lx of [x0, (x0 + x1) / 2, x1]) for (const lz of [z0, (z0 + z1) / 2, z1]) {
      if (lx === (x0 + x1) / 2 && lz === (z0 + z1) / 2) continue;
      const wx = x + lx * c + lz * sn, wz = z - lx * sn + lz * c;
      if (!ok(wx, wz, 0.1, false)) return false;
    }
    return true;
  };
  return ok;
}

const props = {
  name: 'props',
  lights: [],
  dynamics: [],
  signalLamps: [],
  _state: { ns: 'red', ew: 'red', ped: 'walk', remaining: 30 },
  _lit: -1,
  _pedMax: 30,
  _wet: -1,
  _night: -1,
  _flashOn: false,
  _culls: [],
  _cullX: 1e9, _cullZ: 1e9, _cullFx: 0, _cullFz: 1,

  init(engine) {
    this.engine = engine;
    const t0 = performance.now();
    const materials = engine.get('materials'), city = engine.get('city') || {}, sg = engine.get('signage');
    const world = engine.world;
    const group = new THREE.Group(); group.name = 'props';
    engine.scene.add(group);
    this.group = group;
    const rng = engine.rng.fork(55);
    const foot = this.foot = Footprints(world);
    const guard = this.guard = PlacementGuard(city.field || null, foot);
    const occ = Occupancy(3, guard);
    const I = Instancer(group);
    this.I = I;
    this.lights = []; this.dynamics = []; this.signalLamps = [];

    const field = city.field || null;
    const off = (x, z) => (field ? field.sample(x, z) : 8);           // signed distance to the carriageway edge
    const baseY = (x, z) => groundY(x, z) + (off(x, z) > 0.3 ? SW_H : 0);
    this.baseY = baseY;

    // ------------------------------------------------------------------------------------------- materials
    const paint = materials.clone('paintSignalGrey');
    paint.color.set(0xffffff); paint.vertexColors = true; paint.name = 'props:paint';
    const M = {
      paint,
      emit: emissiveVC(1.6),
      lamp: emissiveVC(3.0),
      signal: emissiveVC(3.6),
      ped: emissiveVC(0.9, pedFigureTexture()),
      // no alphaToCoverage: the composer resolves with SMAA, not MSAA, so it is a no-op that only costs state.
      // A lower alphaTest against a dilated alpha keeps the cut-out from stair-stepping into a 1-px crawl.
      leaf: new THREE.MeshStandardMaterial({ map: foliageTexture(rng.fork(9)), alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.88, metalness: 0, color: 0xe8f0dc, emissive: 0x000000, emissiveIntensity: 1, name: 'props:leaf' }),
      // light volumes: BackSide only (a DoubleSide additive shell doubles every pixel) and the alpha ramp is
      // radial, so the shaft has no silhouette rim at all.
      cone: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide, opacity: 1, name: 'props:lightcone' }),
      pool: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, opacity: 1, name: 'props:lightpool' }),
      // contact darkening MULTIPLIES the ground instead of painting black over it: an alpha-blended black disc
      // erases the wet neon reflection and leaves an ellipse-shaped hole in the street.
      shade: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.MultiplyBlending, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide, opacity: 1, name: 'props:contact' }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x35404a, roughness: 0.06, metalness: 0, opacity: 0.3, transparent: true, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.8, name: 'props:glass' }),
      flank: new THREE.MeshStandardMaterial({ map: flankTexture(), vertexColors: true, roughness: 0.42, metalness: 0.45, envMapIntensity: 1.1, name: 'props:flank' }),
      // a 1-px pure-black line reads as a scratch on the lens: the span needs enough body and enough rim
      // response to catch the neon behind it.
      wire: new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.65, metalness: 0.35, envMapIntensity: 1.2, name: 'props:wire' }),
    };
    const conc = materials.clone('concrete');
    conc.color.set(0xffffff); conc.vertexColors = true; conc.name = 'props:concrete';
    M.concrete = conc;
    // 横断防止柵 is galvanised pipe, not painted steel: it needs a specular streak on a soaked street
    const steel = materials.clone('paintSignalGrey');
    steel.color.set(0xffffff); steel.vertexColors = true; steel.metalness = 0.75; steel.roughness = 0.28;
    steel.envMapIntensity = 1.4; steel.name = 'props:steel';
    M.steel = steel;
    M.dayLeaf = new THREE.Color(0xe8f0dc); M.nightLeaf = new THREE.Color(0x333b30);
    this.M = M;
    const lighting0 = engine.get('lighting');
    this._buildNight = lighting0 && typeof lighting0.nightFactor === 'number' ? lighting0.nightFactor : 1;
    this._culls = [];

    const ms = {}; let tp = performance.now();
    const lap = (k) => { ms[k] = Math.round(performance.now() - tp); tp = performance.now(); };
    lap('mat');
    this.buildStreetlights(I, M, city, sg, occ, baseY, rng.fork(1), world); lap('lamps');
    this.buildSignals(I, M, city, occ, baseY, world, group); lap('signals');
    this.buildUtilityPoles(I, M, city, occ, baseY, rng.fork(2), world, group); lap('poles');
    this.buildBarriers(I, M, city, occ, baseY, rng.fork(3), world); lap('rails');
    this.buildTrees(I, M, city, occ, baseY, rng.fork(4), world); lap('trees');
    this.buildStreetLife(I, M, city, sg, occ, baseY, rng.fork(5), world); lap('street');
    this.buildLandmarkProps(I, M, city, sg, occ, baseY, rng.fork(6), world); lap('civic');
    this.buildKerbside(I, M, city, occ, baseY, rng.fork(7), world); lap('kerb');

    const meshes = I.build(); lap('build');
    // Every family is ONE InstancedMesh spanning 400 × 400 m, so its bounding sphere always intersects the
    // frustum and three.js never culls a single instance: the ~90 % of the city behind the camera is
    // submitted every frame. Compact each family to what is actually in front of the camera and in range.
    // (Dynamic families are excluded: compaction moves the instance an index was issued for.)
    for (const [key, r, near] of [
      ['lamp_cone', 55], ['lamp_pool', 35], ['pool_c', 25], ['contact', 40],
      ['bike', 26], ['bike_wheel', 26], ['bike_far', 115, 24],
      ['rail', 90], ['rail_cap', 90], ['shrub', 70], ['crate', 95], ['beercase', 95],
      ['bollard', 95], ['brella', 80], ['bin', 95], ['flag_pole', 130], ['flag_pole_l', 130],
      ['tree0_leaf', 150], ['tree1_leaf', 150], ['tree2_leaf', 130], ['tree3_leaf', 130],
      ['tree0_cast', 22], ['tree1_cast', 22], ['tree2_cast', 20], ['tree3_cast', 20],
    ]) this.prepCull(key, r, near);
    if (sg && sg.flush && this._staged) sg.flush();
    lap('flush');
    this.ms = ms;

    this.setSignalState(this._state);
    engine.events.on('signal:phase', (e) => { if (e) this.setSignalState(e); });

    let tris = 0;
    group.traverse(o => { if (o.isMesh && o.geometry) { const g = o.geometry; const n = (g.index ? g.index.count : g.attributes.position.count) / 3; tris += o.isInstancedMesh ? n * o.count : n; } });
    this.triangles = Math.round(tris);
    this.drawCalls = meshes.length + group.children.filter(o => o.isMesh && !o.isInstancedMesh).length;
    console.info(`[props] ${this.counts.streetlight} streetlights, ${this.counts.signal} signals, ${this.counts.pole} utility poles, ${this.counts.tree} trees, ${this.counts.vending} vending, ${this.counts.bike} bikes, ${this.counts.rail} rails, ${this.counts.kerb} kerbside, ${Object.entries(this.counts.tally || {}).map(([k, v]) => k + ':' + v).join(' ')}, ${this.dynamics.length} dynamic — sg ${this.counts.sgn}/${this.counts.sgms}ms slots ${this.counts.slots} (${this.counts.phase}) — ${this.drawCalls} draws, ${this.triangles} tris, ${(performance.now() - t0).toFixed(0)} ms [${Object.entries(ms).map(([k, v]) => k + ' ' + v).join(', ')}]`);
  },

  counts: { streetlight: 0, signal: 0, pole: 0, tree: 0, vending: 0, bike: 0 },
  sample: {},

  // ============================================================================================ streetlights
  buildStreetlights(I, M, city, sg, occ, baseY, rng, world) {
    const REACH = 2.45, H = 8.3;
    const pole = merge([
      tint(CY(0.20, 0.235, 0.34, 8, { y: 0.17 }), 0x33363a),
      tint(CY(0.075, 0.125, H - 0.34, 9, { y: 0.34 + (H - 0.34) / 2 }), 0x9ba1a6),
      tint(CY(0.10, 0.10, 0.10, 8, { y: H - 0.02 }), 0x74797e),
      tint(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(0, H - 0.95, 0), new THREE.Vector3(0, H + 0.24, -REACH * 0.5), new THREE.Vector3(0, H + 0.10, -REACH)), 7, 0.055, 5, false), 0x9ba1a6),
      tint(B(0.46, 0.15, 0.96, { y: H + 0.02, z: -REACH - 0.34, rx: 0.10 }), 0x4b5055),
      tint(B(0.5, 0.06, 0.2, { y: H + 0.12, z: -REACH + 0.04 }), 0x4b5055),
      tint(B(0.30, 0.42, 0.16, { y: 1.05, z: 0.16 }), 0x53585c),            // cable access door
    ]);
    const lens = tint(B(0.40, 0.045, 0.84, { y: H - 0.075, z: -REACH - 0.34, rx: 0.10 }), 0xffe3b4);
    // haze shaft: narrow, stops 3.6 m up (never reads as an object standing on the pavement) and dissolves
    // radially, so there is no rim to silhouette against a facade.
    const coneG = fadeRadial(new THREE.ConeGeometry(1.1, 4.6, 18, 2, true), 0xffb765, 0.035, 1.5);
    xf(coneG, { y: H - 0.12 - 2.3, z: -REACH - 0.34 });
    // and the other half of a streetlight: the warm pool it throws on the wet asphalt. 6 concentric rings so
    // fadeRadial's power curve is actually sampled — with one ring the curve collapses to a straight ramp,
    // whose non-zero derivative at the rim is exactly the hard painted-donut edge.
    const poolG = decalRing(0.02, 2.4, 32, 6, 0.02);
    fadeRadial(poolG, 0xffc27a, 0.30, 2.4);
    poolG.translate(0, 0, -REACH - 0.34);
    I.def('lamp_pole', pole, M.paint, { shadow: true });
    I.def('lamp_lens', lens, M.lamp, { bloom: true });
    I.def('lamp_cone', coneG, M.cone, { order: 3 });
    I.def('lamp_pool', poolG, M.pool, { order: 2 });
    // centred variant, reused by any fixture that should wash the pavement under it
    const poolC = decalRing(0.02, 1.6, 28, 5, 0.02);
    fadeRadial(poolC, 0xffc27a, 0.13, 2.4);
    I.def('pool_c', poolC, M.pool, { order: 2 });
    // contact darkening, shared by every family that stands on the pavement (defined here because barriers
    // build before street life). Multiply-blended, so it darkens the wet reflection instead of deleting it.
    const contactG = decalRing(0.02, 1.0, 16, 3, 0.012);
    fadeMultiply(contactG, 0.6, 2.0);
    I.def('contact', contactG, M.shade, { order: 1 });

    const spots = [];
    for (const r of city.roads || []) {
      if (r.pedestrian || !r.points || r.id==='dg_koji' || r.id==='scope_osm_46867241_0') continue;
      const cool = r.width >= 14;
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i], b = r.points[i + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        const nx = dz / len, nz = -dx / len, o = r.width / 2 + 0.75;
        for (let s = 8; s < len - 4; s += 24) {
          const t = s / len, x = a[0] + dx * t, z = a[1] + dz * t;
          for (const side of (r.scope && r.width < 8 ? [1] : [1, -1])) {
            const px = x + nx * o * side, pz = z + nz * o * side;
            if (Math.abs(px) < 25 && Math.abs(pz) < 25) continue;
            if (r.scope && spots.some(p => Math.hypot(p[0]-px,p[1]-pz)<18)) continue;
            if (!occ.claim(px, pz, 1.5)) continue;
            spots.push([px, pz, Math.atan2(nx * side, nz * side), cool, 1]);
          }
        }
      }
    }
    for (const [x, z] of [[-23, -23], [23, -23], [23, 23], [-23, 23]]) {
      const n = Math.hypot(x, z);
      if (occ.claim(x, z, 1.6)) spots.push([x, z, Math.atan2(-x / n, -z / n), true, 1.3]);
    }
    // vertical ad banners on the pole (公園通り / センター街 style), staged into the signage atlas
    const BANNERS = [
      ['渋谷町 冬の祭典', '#c8102e'], ['ハチ公 生誕百年', '#1c56b7'], ['SHIBUYA-CHO', '#1a1a1a'],
      ['公園通り商店会', '#1d6b3a'], ['スクランブル 冬', '#7b2ff7'], ['渋谷町 光の祭', '#e8306a'],
    ];
    const bannerArm = merge([
      ...[1, -1].flatMap(s => [6.2, 4.25].map(y => tint(CY(0.02, 0.02, 0.34, 5, { rz: Math.PI / 2, x: s * 0.17, y }), 0x8d9296))),
    ]);
    I.def('lamp_banner_arm', bannerArm, M.paint, {});

    let bn = 0;
    const arms = [];                       // mast-arm heads: the catenary pass must not thread a cable through one
    for (const [x, z, ry, cool, sc] of spots) {
      const y = baseY(x, z);
      I.add('lamp_pole', x, y, z, ry, sc);
      I.add('lamp_lens', x, y, z, ry, sc);
      I.add('lamp_cone', x, y, z, ry, sc);
      I.add('lamp_pool', x, y, z, ry, sc);
      if (sg && sg.makeSign && Math.hypot(x, z) < 150 && bn % 3 === 0) {
        const [text, bg] = BANNERS[(bn / 3 | 0) % BANNERS.length];
        for (const s of [1, -1]) {
          const b = sg.makeSign({ text, w: 0.56, h: 1.9, bg, fg: '#ffffff', vertical: true, weight: '800', glow: 1.15 });
          b.position.set(x + Math.cos(ry) * 0.3 * s, y + 5.22 * sc, z - Math.sin(ry) * 0.3 * s);
          b.rotation.set(0, ry + s * Math.PI / 2, 0);
          sg.batch(b); this._staged = true;
        }
        I.add('lamp_banner_arm', x, y, z, ry, sc);
      }
      bn++;
      world.addStatic(new THREE.Box3(new THREE.Vector3(x - 0.16, y, z - 0.16), new THREE.Vector3(x + 0.16, y + 8, z + 0.16)), { tag: 'pole' });
      const hx = x - Math.sin(ry) * (REACH + 0.34) * sc, hz = z - Math.cos(ry) * (REACH + 0.34) * sc;
      this.lights.push({ position: new THREE.Vector3(hx, y + (H - 0.1) * sc, hz), color: cool ? 0xe6ecff : 0xffd9a6, intensity: cool ? 128 : 104, distance: 34 * sc });
      arms.push(hx, hz, y + (H - 0.1) * sc);
    }
    this._arms = arms;
    this.counts.streetlight = spots.length;
  },

  // ========================================================================================== traffic signals
  buildSignals(I, M, city, occ, baseY, world, group) {
    const sig = (CITY.crossing && CITY.crossing.signals) || [];
    // a signal head at night sits against warm shop light — crushed-black housings read as floating lenses,
    // so the paintwork is kept well off black and the hoods a shade lighter still.
    const DARK = 0x4a5550, HOOD = 0x2e3338, BACK = 0x3a4046, POST = 0x6f7a72, FOOT = 0x46514a, BAND = 0xcfd4d6;
    // --- shared parts
    const hood = (x, y, z, r) => tint(xf(new THREE.CylinderGeometry(r, r * 1.06, 0.22, 12, 1, true, Math.PI, Math.PI), { rx: Math.PI / 2, x, y, z: z + 0.11 }), HOOD);
    // unlit aspects need a dark-glass disc of their own or only the lit one exists on screen; the 背面板 needs
    // the white perimeter band a real Japanese head carries, or the whole silhouette vanishes at night.
    const vehHead = (cx) => merge([
      tint(B(1.68, 0.66, 0.05, { x: cx, y: 0, z: -0.11 }), BACK),                           // 背面板
      tint(B(1.72, 0.06, 0.035, { x: cx, y: 0.33, z: -0.126 }), BAND),                      // white frame ring
      tint(B(1.72, 0.06, 0.035, { x: cx, y: -0.33, z: -0.126 }), BAND),
      tint(B(0.06, 0.72, 0.035, { x: cx - 0.855, y: 0, z: -0.126 }), BAND),
      tint(B(0.06, 0.72, 0.035, { x: cx + 0.855, y: 0, z: -0.126 }), BAND),
      tint(B(1.52, 0.52, 0.2, { x: cx, y: 0, z: 0 }), DARK),
      tint(B(1.56, 0.06, 0.24, { x: cx, y: 0.28, z: 0 }), HOOD),
      hood(cx - 0.5, 0, 0.1, 0.2), hood(cx, 0, 0.1, 0.2), hood(cx + 0.5, 0, 0.1, 0.2),
      ...[[-0.5, 0x0d2416], [0, 0x2a1e06], [0.5, 0x2a0b06]].map(([dx, col]) =>
        tint(xf(new THREE.CylinderGeometry(0.152, 0.152, 0.02, 18), { rx: Math.PI / 2, x: cx + dx, y: 0, z: 0.098 }), col)),
    ]);
    const pedHead = merge([
      tint(B(0.52, 0.98, 0.05, { y: 0, z: -0.1 }), BACK),
      tint(B(0.42, 0.86, 0.18, { y: 0, z: 0 }), DARK),
      tint(B(0.46, 0.05, 0.22, { y: 0.45, z: 0 }), HOOD),
      tint(xf(new THREE.CylinderGeometry(0.19, 0.2, 0.2, 12, 1, true, Math.PI, Math.PI), { rx: Math.PI / 2, y: 0.21, z: 0.1 }), HOOD),
      tint(xf(new THREE.CylinderGeometry(0.19, 0.2, 0.2, 12, 1, true, Math.PI, Math.PI), { rx: Math.PI / 2, y: -0.21, z: 0.1 }), HOOD),
      // dark lens glass behind each figure: an unlit head must still read as two round lenses, not as holes
      tint(xf(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 20), { rx: Math.PI / 2, y: 0.21, z: 0.088 }), 0x1f2a26),
      tint(xf(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 20), { rx: Math.PI / 2, y: -0.21, z: 0.088 }), 0x22301f),
      tint(B(0.11, 0.62, 0.06, { x: 0.3, y: -0.02, z: 0.06 }), BACK),                       // countdown strip housing
    ]);
    const pedPole = merge([
      tint(CY(0.155, 0.175, 0.28, 10, { y: 0.14 }), FOOT),
      tint(CY(0.062, 0.082, 3.1, 10, { y: 1.68 }), POST),
      tint(B(0.26, 0.34, 0.1, { y: 1.05, z: 0.11 }), POST),                                 // push-button box
      tint(B(0.13, 0.13, 0.02, { y: 1.1, z: 0.17 }), 0xd8d2c4),
    ]);
    const lensG = tint(xf(new THREE.CylinderGeometry(0.155, 0.155, 0.04, 24), { rx: Math.PI / 2 }), 0xffffff);
    const pedLensTop = PL(0.33, 0.33, {}); remapV(pedLensTop, 0.5, 1);
    const pedLensBot = PL(0.33, 0.33, {}); remapV(pedLensBot, 0, 0.5);
    const segG = tint(B(0.07, 0.05, 0.02, {}), 0xffffff);

    I.def('sig_ped_pole', pedPole, M.paint, { shadow: true });
    I.def('sig_ped_head', pedHead, M.paint, {});
    I.def('sig_lens', lensG, M.signal, { bloom: true });
    I.def('sig_ped_r', tint(pedLensTop, 0xffffff), M.ped, { bloom: true });
    I.def('sig_ped_g', tint(pedLensBot, 0xffffff), M.ped, { bloom: true });
    I.def('sig_count', segG, M.signal, { bloom: true });

    // --- vehicle signals: mast arm reaches over the carriageway, lamps face the oncoming traffic
    const vehGeo = [];
    let n = 0;
    for (const s of sig) {
      let [px, pz] = s.pos; const ry = Math.atan2(Math.cos(s.facing), -Math.sin(s.facing));      // local +z → facing dir
      if (s.type === 'vehicle' && this.guard && !this.guard(px, pz, 0.3, false)) { const sp = this.guard.snap(px, pz, 0.3, 8); if (sp) [px, pz] = sp; }
      const y = baseY(px, pz);
      if (s.type === 'vehicle') {
        const road = (city.roads || []).find(r => r.id === s.road);
        let side = -1, reach = 3.4;
        if (road) {
          const c = nearestOnPolyline(px, pz, road.points);
          const ax = Math.cos(ry), az = -Math.sin(ry);                                        // local +x in world
          const d = (c.x - px) * ax + (c.z - pz) * az;
          side = d >= 0 ? 1 : -1;
          reach = clamp(Math.abs(d) + 1.4, 2.6, 6.0);
        }
        const cx = side * reach;
        const braceL = Math.hypot(reach * 0.5, 1.2);
        const parts = [
          tint(CY(0.185, 0.215, 0.32, 12, { y: 0.16 }), 0x2f3a34),
          tint(CY(0.085, 0.115, 5.5, 12, { y: 2.9 }), 0x5f6b63),
          tint(CY(0.05, 0.055, reach, 8, { rz: Math.PI / 2, x: cx / 2, y: 5.5 }), 0x5f6b63),
          tint(CY(0.032, 0.032, braceL, 6, { rz: side * (Math.PI / 2 - Math.atan2(1.2, reach * 0.5)), x: side * reach * 0.25, y: 4.9 }), 0x5f6b63),
        ];
        const head = vehHead(cx); head.translate(0, 5.18, 0);
        parts.push(head);
        const g = merge(parts);
        g.rotateY(ry); g.translate(px, y, pz);
        vehGeo.push(g);
        // lamps: 青 / 黄 / 赤, red on the driver's right (= local +x)
        const order = [['green', -0.5], ['amber', 0], ['red', 0.5]];
        for (const [name, dx] of order) {
          const lx = cx + dx, ly = 5.18, lz = 0.115;
          const wx = px + lx * Math.cos(ry) + lz * Math.sin(ry), wz = pz - lx * Math.sin(ry) + lz * Math.cos(ry);
          const idx = I.add('sig_lens', wx, y + ly, wz, ry, 1, 0x000000);
          this.signalLamps.push({ key: 'sig_lens', idx, axis: axisOf(s.road), color: name });
        }
        world.addStatic(new THREE.Box3(new THREE.Vector3(px - 0.22, y, pz - 0.22), new THREE.Vector3(px + 0.22, y + 5.5, pz + 0.22)), { tag: 'pole' });
        occ.take(px, pz, 1.2);
        n++;
      } else {
        // walk the head back to the kerb: never inside a building footprint, never on top of another prop
        const foot = this.foot, guard = this.guard;
        let x = px, z = pz, ok = false;
        // (the crosswalk ends inside the scramble lie on the carriageway: the guard walks the post onto the corner)
        if (guard) { const sp = guard.snap(px, pz, 0.25, 10, occ, 1.0); if (sp && !(foot && foot.hit(sp[0], sp[1], 0.5))) { x = sp[0]; z = sp[1]; ok = true; } }
        const tryAt = (ax, az) => !(foot && foot.hit(ax, az, 0.5)) && occ.free(ax, az, 1.0) && (!guard || guard(ax, az, 0.25));
        if (ok || tryAt(x, z)) ok = true;
        else {
          for (let k = 1; k <= 8 && !ok; k++) {
            const a = s.facing + Math.PI / 2 * (k % 2 ? 1 : -1), d = 1.2 + (k >> 1) * 1.1;
            const ax = px + Math.cos(a) * d, az = pz - Math.sin(a) * d;
            if (tryAt(ax, az)) { x = ax; z = az; ok = true; }
          }
        }
        if (!ok || !occ.claim(x, z, 0.9, 0.25)) continue;
        const yy = baseY(x, z);
        I.add('sig_ped_pole', x, yy, z, ry, 1);
        I.add('sig_ped_head', x, yy + 2.98, z, ry, 1);
        const rIdx = I.add('sig_ped_r', x + Math.sin(ry) * 0.1, yy + 3.19, z + Math.cos(ry) * 0.1, ry, 1, 0x000000);
        const gIdx = I.add('sig_ped_g', x + Math.sin(ry) * 0.1, yy + 2.77, z + Math.cos(ry) * 0.1, ry, 1, 0x000000);
        this.signalLamps.push({ key: 'sig_ped_r', idx: rIdx, axis: 'ped', color: 'red' });
        this.signalLamps.push({ key: 'sig_ped_g', idx: gIdx, axis: 'ped', color: 'green' });
        const segs = [];
        for (let k = 0; k < 8; k++) {
          const ly = 2.7 + k * 0.073, lx = 0.3;
          const wx = x + lx * Math.cos(ry) + 0.1 * Math.sin(ry), wz = z - lx * Math.sin(ry) + 0.1 * Math.cos(ry);
          segs.push(I.add('sig_count', wx, yy + ly, wz, ry, 1, 0x000000));
        }
        this.countdown = this.countdown || [];
        this.countdown.push(segs);
        world.addStatic(new THREE.Box3(new THREE.Vector3(x - 0.14, yy, z - 0.14), new THREE.Vector3(x + 0.14, yy + 3.4, z + 0.14)), { tag: 'pole' });
        n++;
      }
    }
    if (vehGeo.length) {
      const mesh = new THREE.Mesh(merge(vehGeo), M.paint);
      mesh.name = 'props:signals'; mesh.castShadow = true;
      group.add(mesh);
    }
    this.counts.signal = n;
  },

  // ========================================================================================== utility poles
  buildUtilityPoles(I, M, city, occ, baseY, rng, world, group) {
    const H = 10.2;
    const poleGeo = merge([
      tint(CY(0.11, 0.17, H, 10, { y: H / 2 }), 0xa9a49a),
      tint(B(1.7, 0.08, 0.1, { y: H - 0.55 }), 0x6c6f63),                          // crossarm
      tint(B(1.3, 0.08, 0.1, { y: H - 1.25 }), 0x6c6f63),
      ...[-0.75, -0.25, 0.25, 0.75].map(x => tint(CY(0.045, 0.05, 0.16, 6, { x, y: H - 0.42 }), 0xbfc4c8)),
      ...[-0.55, 0, 0.55].map(x => tint(CY(0.045, 0.05, 0.16, 6, { x, y: H - 1.12 }), 0xbfc4c8)),
      tint(CY(0.26, 0.26, 0.86, 12, { x: 0.36, y: H - 2.6 }), 0x8d9296),           // 柱上変圧器
      tint(CY(0.3, 0.3, 0.08, 12, { x: 0.36, y: H - 2.12 }), 0x6e7377),
      ...[-0.13, 0.13].map(dx => tint(CY(0.05, 0.062, 0.2, 8, { x: 0.36 + dx, y: H - 1.98 }), 0x9aa0a4)),   // 一次ブッシング
      ...[-0.13, 0.13].map(dx => tint(SP(0.045, { x: 0.36 + dx, y: H - 1.88 }, 7, 5), 0xb4b8bc)),
      tint(CYO(0.275, 0.275, 0.07, 12, { x: 0.36, y: H - 2.34 }), 0x5e6367),        // hanger band
      tint(CYO(0.275, 0.275, 0.07, 12, { x: 0.36, y: H - 2.92 }), 0x5e6367),
      ...[0, 1, 2].map(i => tint(CYO(0.272, 0.272, 0.03, 12, { x: 0.36, y: H - 2.62 + (i - 1) * 0.16 }), 0x7c8186)), // cooling ribs
      tint(B(0.16, 0.12, 0.02, { x: 0.36, y: H - 2.72, z: 0.27 }), 0xd8d4c6),       // maker plate
      tint(B(0.3, 0.42, 0.22, { x: -0.3, y: H - 3.5 }), 0x74787c),                  // cutout box
      tint(B(0.24, 0.7, 0.12, { x: 0, y: 2.4, z: 0.2 }), 0x2c2f33),                 // riser conduit
      tint(B(0.5, 0.36, 0.03, { y: 3.4, z: 0.19 }), 0xd8d4c6),                      // 電柱番号札
    ]);
    I.def('upole', poleGeo, M.paint, { shadow: true });

    const chains = [];
    const streets = (CITY.pedestrianStreets || []).filter(p => (p.width <= 6.5 || p.id === 'centergai') && p.poles !== false);
    const roads = (CITY.roads || []).filter(r => r.width <= 10);
    for (const s of [...streets, ...roads]) {
      const pts = s.path, side = rng.chance(0.5) ? 1 : -1;
      const o = s.sidewalk ? s.width / 2 + Math.min(1.2, s.sidewalk * 0.4) : s.width / 2 - 0.45;
      const chain = [];
      let acc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        const nx = dz / len, nz = -dx / len;
        for (let t = acc; t < len; t += 24) {
          const x = a[0] + dx * (t / len) + nx * o * side, z = a[1] + dz * (t / len) + nz * o * side;
          if (Math.abs(x) > 220 || Math.abs(z) > 220) continue;
          if (Math.hypot(x, z) < 26) continue;
          if (!occ.claim(x, z, 1.4)) continue;
          const y = baseY(x, z);
          I.add('upole', x, y, z, Math.atan2(dx, dz) + Math.PI / 2 + (rng() - 0.5) * 0.2, rng.range(0.94, 1.08));
          world.addStatic(new THREE.Box3(new THREE.Vector3(x - 0.2, y, z - 0.2), new THREE.Vector3(x + 0.2, y + H, z + 0.2)), { tag: 'pole' });
          chain.push([x, y, z]);
          acc = t + 24 - len;
        }
        acc = Math.max(0, acc);
      }
      if (chain.length > 1) chains.push(chain);
    }
    // catenary cables: 6 wires per span. Thick enough to survive SMAA, sag clamped so a span across a step in
    // the pavement can never dip to the tiles, and never threaded through a streetlight's mast arm.
    const wires = [];
    const arms = this._arms || [];
    const hitsArm = (ax, az, bx, bz, ylo, yhi) => {
      for (let k = 0; k < arms.length; k += 3) {
        const hy = arms[k + 2];
        if (hy < ylo - 1.1 || hy > yhi + 1.1) continue;
        if (distToSeg(arms[k], arms[k + 1], ax, az, bx, bz) < 0.7) return true;
      }
      return false;
    };
    let poles = 0;
    for (const chain of chains) {
      poles += chain.length;
      for (let i = 0; i < chain.length - 1; i++) {
        const [x0, y0, z0] = chain[i], [x1, y1, z1] = chain[i + 1];
        const span = Math.hypot(x1 - x0, z1 - z0);
        if (span > 46) continue;
        const sag = clamp(0.25 + span * 0.012, 0.2, 1.1);
        if (hitsArm(x0, z0, x1, z1, Math.min(y0, y1) + H - 1.6, Math.max(y0, y1) + H)) continue;
        for (const [dy, dl] of [[H - 0.42, -0.75], [H - 0.42, -0.25], [H - 0.42, 0.25], [H - 0.42, 0.75], [H - 1.12, 0], [H - 1.12, 0.55]]) {
          const nx = -(z1 - z0) / span, nz = (x1 - x0) / span;
          const ax = x0 + nx * dl, az = z0 + nz * dl, bx = x1 + nx * dl, bz = z1 + nz * dl;
          const floor = Math.min(y0, y1) + dy - 1.2;
          const my = Math.max((y0 + y1) / 2 + dy - sag * 2, floor);
          const mid = new THREE.Vector3((ax + bx) / 2, my, (az + bz) / 2);
          const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(ax, y0 + dy, az), mid, new THREE.Vector3(bx, y1 + dy, bz));
          wires.push(new THREE.TubeGeometry(curve, 6, 0.026, 4, false));
        }
      }
    }
    if (wires.length) {
      const mesh = new THREE.Mesh(merge(wires), M.wire);
      mesh.name = 'props:cables'; group.add(mesh);
    }
    this.counts.pole = poles;
  },

  // ================================================================================ guardrails / bollards etc
  buildBarriers(I, M, city, occ, baseY, rng, world) {
    // 横断防止柵: a 3-rail ガードパイプ panel with a picket infill. 8-sided tube so the highlight runs along it
    // instead of aliasing, and thick enough (4.5 cm) for the wet envMap to actually show on a night street.
    const RAIL = 0xe4e7e1;
    const railGeo = merge([
      tint(CYO(0.045, 0.045, 2.0, 8, { rz: Math.PI / 2, y: 0.84 }), RAIL),
      tint(CYO(0.040, 0.040, 2.0, 8, { rz: Math.PI / 2, y: 0.56 }), RAIL),
      tint(CYO(0.036, 0.036, 2.0, 8, { rz: Math.PI / 2, y: 0.28 }), RAIL),
      // 5 fatter pickets, not 7 thin ones: at 20 m a 12 mm picket is sub-pixel and shimmers through SMAA
      ...Array.from({ length: 5 }, (_, i) => tint(CYO(0.018, 0.018, 0.56, 5, { x: -0.8 + i * 0.4, y: 0.56 }), RAIL)),
      tint(CY(0.046, 0.052, 0.92, 8, { x: -0.98, y: 0.46 }), RAIL),
      tint(CY(0.046, 0.052, 0.92, 8, { x: 0.98, y: 0.46 }), RAIL),
      // 根巻き collar: without a flange the run looks like it hovers over the pavement
      tint(CY(0.11, 0.13, 0.09, 9, { x: -0.98, y: 0.045 }), 0x9aa09a),
      tint(CY(0.11, 0.13, 0.09, 9, { x: 0.98, y: 0.045 }), 0x9aa09a),
    ]);
    // terminal panel: the rails wrap round the last post in a 180° elbow instead of stopping in mid-air
    const railCap = merge([
      tint(xf(new THREE.TorusGeometry(0.28, 0.04, 4, 10, Math.PI), { rz: -Math.PI / 2, x: 0.98, y: 0.56 }), RAIL),
      tint(CYO(0.05, 0.058, 1.0, 8, { x: 0.98, y: 0.5 }), RAIL),
      tint(CY(0.11, 0.135, 0.1, 9, { x: 0.98, y: 0.05 }), 0x9aa09a),
    ]);
    const bollard = merge([
      tint(CYO(0.058, 0.07, 0.82, 8, { y: 0.41 }), 0x4b5158),
      tint(SP(0.062, { y: 0.83 }, 6, 4), 0x4b5158),
      tint(CYO(0.062, 0.062, 0.09, 8, { y: 0.62 }), 0xe8e4d8),
      tint(CY(0.09, 0.1, 0.05, 8, { y: 0.025 }), 0x3a3f44),
    ]);
    // cast-concrete planter: chamfered coping over a slightly tapered tub, dark soil sunk below the lip
    const planter = merge([
      tint(B(1.36, 0.5, 0.58, { y: 0.25 }), 0xb0aba0),
      tint(B(1.42, 0.09, 0.64, { y: 0.545 }), 0xbdb8ad),                 // chamfer course
      tint(B(1.46, 0.08, 0.68, { y: 0.625 }), 0xc6c1b5),                 // coping
      tint(B(1.34, 0.04, 0.56, { y: 0.655 }), 0x9d988d),
      tint(B(1.22, 0.06, 0.46, { y: 0.60 }), 0x241d14),                  // soil
      tint(B(1.38, 0.1, 0.6, { y: 0.05 }), 0x8e8a80),                    // plinth
    ]);
    // shrubs are crossed alpha cards, not spheres: a ragged silhouette that does not take a wet-metal highlight
    const shrub = merge([
      PL(0.78, 0.66, { y: 0.31 }),
      PL(0.78, 0.66, { y: 0.31, ry: Math.PI / 3 }),
      PL(0.78, 0.66, { y: 0.31, ry: -Math.PI / 3 }),
      PL(0.7, 0.34, { y: 0.52, rx: -Math.PI / 2 }),
    ]);
    const bench = merge([
      ...[-0.85, 0.85].map(x => tint(B(0.08, 0.42, 0.44, { x, y: 0.21 }), 0x5a5f63)),
      ...[0, 1, 2].map(i => tint(B(1.95, 0.05, 0.11, { y: 0.44, z: -0.16 + i * 0.16 }), 0x8a6a42)),
      ...[0, 1].map(i => tint(B(1.95, 0.05, 0.11, { y: 0.66, z: -0.24 + i * 0.13, rx: -0.22 }), 0x8a6a42)),
    ]);
    const rack = merge([
      tint(CYO(0.025, 0.025, 1.9, 5, { rz: Math.PI / 2, y: 0.34 }), 0x9aa0a4),
      ...[-0.8, -0.4, 0, 0.4, 0.8].map(x => tint(TOR(0.16, 0.022, { x, y: 0.2, rx: Math.PI / 2, ry: Math.PI / 2 }, 3, 8), 0x9aa0a4)),
    ]);
    I.def('rail', railGeo, M.steel, { shadow: true });
    I.def('rail_cap', railCap, M.steel, { shadow: true });
    I.def('bollard', bollard, M.paint, { shadow: true });
    I.def('planter', planter, M.concrete, { shadow: true, receive: true });
    I.def('shrub', shrub, M.leaf, {});
    I.def('bench', bench, M.paint, { shadow: true });
    I.def('rack', rack, M.paint, {});

    // crosswalk / stop-line keep-out so railings never block a crossing
    const keepOut = [];
    for (const c of [...(CITY.crossing.crosswalks || []), ...(CITY.crossing.diagonals || []), ...(CITY.crosswalksExtra || [])]) {
      keepOut.push([c.a[0], c.a[1], (c.width || 8) * 0.8 + 3], [c.b[0], c.b[1], (c.width || 8) * 0.8 + 3]);
    }
    // Client call 2026-09-22: NO railings around the scramble itself. The real crossing is deliberately open
    // on every corner — that is what makes it a scramble — and a fence ringing it both misreads the place and
    // walls off the hero's own establishing shot. Railings stay on ordinary road frontages further out.
    const OPEN_R = (CITY.crossing.radius || 27) + 26;
    const blocked = (x, z) => (x * x + z * z < OPEN_R * OPEN_R)
      || keepOut.some(([kx, kz, r]) => (x - kx) ** 2 + (z - kz) ** 2 < r * r);

    let rails = 0;
    // panels are emitted in runs so each run can be terminated properly and registered as one collider
    const flushRun = (run, ry) => {
      if (!run.length) return;
      I.add('rail_cap', run[run.length - 1][0], run[run.length - 1][1], run[run.length - 1][2], ry, 1);
      I.add('rail_cap', run[0][0], run[0][1], run[0][2], ry + Math.PI, 1);
      const ax = run[0][0], az = run[0][2], bx = run[run.length - 1][0], bz = run[run.length - 1][2];
      world.addStatic(boxOBB((ax + bx) / 2, run[0][1], (az + bz) / 2, Math.hypot(bx - ax, bz - az) + 2.0, 0.9, 0.12, ry), { tag: 'rail' });
      run.length = 0;
    };
    for (const r of CITY.roads || []) {
      if (!r.sidewalk || r.sidewalk < 3.5) continue;
      const o = r.width / 2 + 0.55;
      for (let i = 0; i < r.path.length - 1; i++) {
        const a = r.path[i], b = r.path[i + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        if (len < 4) continue;
        const nx = dz / len, nz = -dx / len, ry = Math.atan2(dx, dz) + Math.PI / 2;
        for (const side of [1, -1]) {
          const run = [];
          for (let s = 1; s < len - 1; s += 2.0) {
            const x = a[0] + dx * (s / len) + nx * o * side, z = a[1] + dz * (s / len) + nz * o * side;
            const ex = Math.cos(ry) * 1.0, ez = -Math.sin(ry) * 1.0;
            if (this.guard && (!this.guard(x + ex, z + ez, 0.06, false) || !this.guard(x - ex, z - ez, 0.06, false))) { flushRun(run, ry); continue; }
            if (Math.hypot(x, z) > 95 || blocked(x, z) || !occ.claim(x, z, 0.9, 0.08)) { flushRun(run, ry); continue; }
            const y = baseY(x, z);
            I.add('rail', x, y, z, ry, 1);
            I.add('contact', x, y, z, ry, [1.1, 1, 0.34]);
            run.push([x, y, z]);
            rails++;
          }
          flushRun(run, ry);
        }
      }
    }
    // bollards + planters + benches around the plazas (not a bus terminal's pavement: its kerbs, poles, queues and
    // canopies are the city module's, see eastExit.js)
    for (const p of CITY.plazas || []) {
      if (p.terminal) continue;
      const poly = p.polygon || [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        const ry = Math.atan2(dx, dz);
        for (let s = 1; s < len - 1; s += 2.1) {
          const x = a[0] + dx * (s / len), z = a[1] + dz * (s / len);
          if (blocked(x, z)) continue;
          if (!occ.claim(x, z, 0.95)) continue;
          if (rng.chance(0.14)) {
            I.add('planter', x, baseY(x, z), z, ry, 1);
            I.add('contact', x, baseY(x, z), z, ry, [0.86, 1, 0.42]);
            this.plantShrubs(I, x, baseY(x, z), z, ry, rng);
            world.addStatic(boxOBB(x, baseY(x, z), z, 1.5, 0.7, 0.7, ry), { tag: 'prop' });
          } else if (rng.chance(0.1)) {
            I.add('bench', x, baseY(x, z), z, ry + Math.PI / 2, 1);
            I.add('contact', x, baseY(x, z), z, ry + Math.PI / 2, [1.15, 1, 0.4]);
            world.addStatic(boxOBB(x, baseY(x, z), z, 2.0, 0.8, 0.6, ry + Math.PI / 2), { tag: 'prop' });
          } else {
            I.add('bollard', x, baseY(x, z), z, 0, 1);
            I.add('contact', x, baseY(x, z), z, 0, 0.22);
          }
        }
      }
    }
    this.counts.rail = rails;
  },

  // ==================================================================================================== trees
  buildTrees(I, M, city, occ, baseY, rng, world) {
    // Crossed cards per cluster. Each card's Y rotation is jittered off the regular (k/n)·π fan so the crown
    // outline is not a set of matching chords, and the lowest ring sits at h·0.52 so it overlaps the branch
    // tips instead of floating above a gap.
    const jr = rng.fork(21);
    const crown = (r, y, tilt, flip, n = 5) => {
      const out = [];
      for (let k = 0; k < n; k++) {
        const g = PL(r * 2, r * 2, { rx: tilt * (k - (n - 1) / 2) * 0.11, ry: (k / n) * Math.PI + jr.range(-0.4, 0.4), y });
        if (flip) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); }
        out.push(g);
      }
      return out;
    };
    const zelkova = (h, spread, nb) => {
      const trunkH = h * 0.42;
      const parts = [tint(CY(0.14, 0.34, trunkH, 9, { y: trunkH / 2 }), 0x7d7264)];
      for (let k = 0; k < nb; k++) {
        const a = (k / nb) * Math.PI * 2 + 0.4, lean = 0.34 + (k % 2) * 0.1;
        const bl = h * 0.42;
        const g = tint(CY(0.045, 0.11, bl, 6, { y: bl / 2 }), 0x7d7264);
        g.rotateZ(lean); g.rotateY(a); g.translate(0, trunkH - 0.2, 0);
        parts.push(g);
      }
      return { trunk: merge(parts), leaf: merge([
        ...crown(spread, h * 0.86, 1, false),
        ...crown(spread * 0.62, h * 0.64, -1, true),
        ...crown(spread * 0.5, h * 0.72, 1, true).map(g => g.translate(spread * 0.5, 0, spread * 0.3)),
        ...crown(spread * 0.46, h * 0.52, -1, false).map(g => g.translate(-spread * 0.52, 0, -spread * 0.26)),
        ...crown(spread * 0.44, h * 0.78, 1, false, 4).map(g => g.translate(spread * 0.2, 0, -spread * 0.52)),
        ...crown(spread * 0.40, h * 0.54, -1, true, 4).map(g => g.translate(-spread * 0.3, 0, spread * 0.48)),
      ]),
      cast: merge([
        PL(spread * 1.9, spread * 1.6, { y: h * 0.72 }),
        PL(spread * 1.9, spread * 1.6, { y: h * 0.72, ry: Math.PI / 2 }),
      ]) };
    };
    // four silhouettes, not two: the plaza zelkovas draw from the tall pair, street trees from the short pair
    const VARIANTS = [zelkova(12.6, 4.3, 6), zelkova(10.4, 3.5, 5), zelkova(7.9, 2.7, 5), zelkova(6.5, 2.2, 4)];
    // shadow proxy: the full canopy is far too expensive to run through the shadow pass 69× over, but a
    // colour-less 2-card stand-in culled to the camera's own block gives the nearest trees a real shadow.
    M.castLeaf = new THREE.MeshBasicMaterial({ map: M.leaf.map, alphaTest: 0.4, side: THREE.DoubleSide, colorWrite: false, depthWrite: false, name: 'props:leafcast' });
    VARIANTS.forEach((v, i) => {
      I.def(`tree${i}_trunk`, v.trunk, M.paint, { shadow: true });
      I.def(`tree${i}_leaf`, v.leaf, M.leaf, {});           // no shadow: alpha-tested canopies murder the shadow pass
      I.def(`tree${i}_cast`, v.cast, M.castLeaf, { shadow: true, order: -1 });
    });
    // street-tree pit: granite kerb frame + soil + a 4-post guard ring
    const guard = merge([
      ...[0, 1].map(i => tint(B(i ? 1.5 : 0.13, 0.17, i ? 0.13 : 1.5, { x: 0, y: 0.075, z: i ? -0.685 : 0 }), 0x9a958c)),
      ...[0, 1].map(i => tint(B(i ? 1.5 : 0.13, 0.17, i ? 0.13 : 1.5, { x: i ? 0 : 0.685, y: 0.075, z: i ? 0.685 : 0 }), 0x9a958c)),
      tint(B(1.26, 0.06, 1.26, { y: 0.06 }), 0x2b241b),
      ...[0, 1, 2, 3].map(i => tint(CYO(0.028, 0.032, 1.7, 4, { x: Math.cos(i * Math.PI / 2) * 0.6, y: 0.85, z: Math.sin(i * Math.PI / 2) * 0.6 }), 0x5d6266)),
      tint(TOR(0.6, 0.02, { y: 1.42, rx: Math.PI / 2 }, 3, 12), 0x5d6266),
    ]);
    I.def('tree_guard', guard, M.paint, { shadow: true });

    let n = 0;
    const plant = (x, z, kind, s) => {
      if (!occ.claim(x, z, 1.5)) return;
      const big = kind === 'big';
      const y = big ? groundY(x, z) + 0.4 : baseY(x, z);
      const v = big ? rng.int(0, 1) : rng.int(2, 3);
      const ty = y + (big ? 0 : 0.08), tr = rng.range(0, 6.28);
      I.add(`tree${v}_trunk`, x, ty, z, tr, s);
      I.add(`tree${v}_leaf`, x, ty, z, tr, s);
      I.add(`tree${v}_cast`, x, ty, z, tr, s);
      I.add('contact', x, y, z, 0, big ? 1.3 : 0.8);
      if (!big) I.add('tree_guard', x, y, z, rng.chance(0.5) ? 0 : Math.PI / 2, 1);
      world.addStatic(new THREE.Box3(new THREE.Vector3(x - 0.3, y, z - 0.3), new THREE.Vector3(x + 0.3, y + 4, z + 0.3)), { tag: 'tree' });
      n++;
    };
    for (const p of CITY.plazas || []) for (const [x, z] of p.trees || []) plant(x, z, 'big', rng.range(0.92, 1.12));
    for (const s of CITY.pedestrianStreets || []) {
      if (!s.trees) continue;
      const pts = s.path;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        const nx = dz / len, nz = -dx / len;
        for (let t = 3; t < len - 2; t += 11) {
          const x = a[0] + dx * (t / len) + nx * (s.width / 2 - 1.1), z = a[1] + dz * (t / len) + nz * (s.width / 2 - 1.1);
          plant(x, z, 'street', rng.range(0.85, 1.1));
        }
      }
    }
    // 公園通り / 明治通り street trees along the kerb
    for (const id of ['koen', 'meiji_ne', 'jingu_n', 'inokashira']) {
      const r = (CITY.roads || []).find(q => q.id === id); if (!r) continue;
      const o = r.width / 2 + 1.7;
      for (let i = 0; i < r.path.length - 1; i++) {
        const a = r.path[i], b = r.path[i + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        const nx = dz / len, nz = -dx / len;
        for (let t = 6; t < len - 4; t += 13) {
          for (const side of [1, -1]) {
            const x = a[0] + dx * (t / len) + nx * o * side, z = a[1] + dz * (t / len) + nz * o * side;
            if (Math.hypot(x, z) < 30 || Math.abs(x) > 215 || Math.abs(z) > 215) continue;
            plant(x, z, 'street', rng.range(0.85, 1.05));
          }
        }
      }
    }
    this.counts.tree = n;
  },

  // ============================================================================== shop fronts, bikes, clutter
  buildStreetLife(I, M, city, sg, occ, baseY, rng, world) {
    const prof = this._prof = { sg: 0, n: 0, t0: performance.now() };
    const stage = (mesh, x, y, z, ry, rx, rz) => {
      if (!sg || !sg.batch || !mesh) return;
      mesh.position.set(x, y, z); mesh.rotation.order = 'YXZ'; mesh.rotation.set(rx || 0, ry, rz || 0);
      sg.batch(mesh); this._staged = true;
    };
    // the signage factories paint into an atlas: build each distinct face once and clone it for every placement
    const protos = new Map();
    // signage's default glow blows out under bloom at arm's length; street furniture needs a gentler face
    const dim = (obj, v) => {
      if (obj) obj.traverse(o => { const a = o.geometry && o.geometry.attributes && o.geometry.attributes.aGlow; if (a) { a.array.fill(v); a.needsUpdate = true; } });
      return obj;
    };
    const proto = (key, make) => {
      let m = protos.get(key);
      if (m === undefined) {
        const t = performance.now();
        m = (sg && make()) || null;
        prof.sg += performance.now() - t; prof.n++;
        protos.set(key, m);
      }
      return m ? lightClone(m) : null;
    };
    // nobori hang with a slack S-curve, never as a flat card. aWave is signage's pole→free-edge ramp, so it
    // doubles as the bend weight; the clone keeps the shared atlas material and the shader wind.
    const furl = (obj, phase, dir) => {
      if (!obj) return obj;
      obj.traverse(o => {
        const a = o.geometry && o.geometry.attributes && o.geometry.attributes.aWave;
        if (!o.isMesh || !a) return;
        const g = o.geometry.clone(), pos = g.attributes.position, w = g.attributes.aWave;
        for (let i = 0; i < pos.count; i++) {
          const t = w.getX(i);
          pos.setZ(i, pos.getZ(i) + dir * 0.085 * t * Math.sin(pos.getY(i) * 2.6 + phase));
        }
        pos.needsUpdate = true; g.computeVertexNormals();
        o.geometry = g;
      });
      return obj;
    };
    // ---- vending machines
    const VW = 1.06, VH = 1.86, VD = 0.74;
    // (2026-09-25, client 「自販が明るすぎ」: the face bloomed into a glowing slab with a lit rim at night — 0.064 -> 0.022)
    const VGLOW = 0.013 + 0.009 * (this._buildNight ?? 1);
    // the ribbed flank texture belongs on the sides only — a corrugated customer face reads as a garage shutter
    const vendCase = tint(B(VW, VH, VD - 0.08, { y: VH / 2, z: -0.04 }), 0xf0f0ee);
    const vendFront = merge([
      tint(B(VW, VH, 0.08, { y: VH / 2, z: VD / 2 - 0.04 }), 0xf6f6f3),            // smooth painted front plate
      tint(B(VW + 0.04, 0.1, VD + 0.04, { y: VH - 0.02 }), 0x3a3d42),
      tint(B(VW + 0.02, 0.09, VD + 0.02, { y: 0.045 }), 0x2a2d32),
      // delivery flap: a hinged door that stands proud of the face, with its own lintel and shadow gap
      tint(B(VW - 0.2, 0.26, 0.07, { y: 0.54, z: VD / 2 + 0.035 }), 0x3c4045),
      tint(B(VW - 0.16, 0.05, 0.09, { y: 0.69, z: VD / 2 + 0.03 }), 0x24272b),     // 取出口 lintel
      tint(B(VW - 0.24, 0.18, 0.02, { y: 0.52, z: VD / 2 + 0.075 }), 0x14161a),
      // coin panel: a recessed column with a slot, a return cup and a note reader
      tint(B(0.2, 0.62, 0.07, { x: VW / 2 - 0.15, y: 1.14, z: VD / 2 + 0.03 }), 0x25282c),
      tint(B(0.13, 0.02, 0.03, { x: VW / 2 - 0.15, y: 1.37, z: VD / 2 + 0.07 }), 0xb4b8bc),   // coin slot
      tint(B(0.14, 0.1, 0.04, { x: VW / 2 - 0.15, y: 0.93, z: VD / 2 + 0.06 }), 0x14161a),    // return cup
      tint(B(0.15, 0.13, 0.03, { x: VW / 2 - 0.15, y: 1.18, z: VD / 2 + 0.06 }), 0x3c4045),   // note reader
      // flanks: a raised corner rail each side so the silhouette from an angle is not a plain cuboid
      ...[-1, 1].map(s => tint(B(0.045, VH - 0.24, VD - 0.02, { x: s * (VW / 2 - 0.01), y: VH / 2 - 0.02 }), 0xc8cacc)),
      tint(B(VW - 0.3, 0.3, 0.04, { y: 0.22, z: -VD / 2 - 0.01 }), 0x9aa0a4),      // compressor grille
    ]);
    const vendGlow = merge([
      tint(B(VW - 0.1, 0.06, 0.02, { y: 0.075, z: VD / 2 + 0.015 }), 0xffe9c0),
      tint(B(VW - 0.1, 0.05, 0.02, { y: VH - 0.09, z: VD / 2 + 0.015 }), 0xffe9c0),
    ]);
    I.def('vend', vendCase, M.flank, { shadow: true });
    I.def('vend_front', vendFront, M.paint, { shadow: true });
    I.def('vend_glow', vendGlow, M.emit, { bloom: true });
    const bin = merge([
      tint(CYO(0.26, 0.24, 0.9, 10, { y: 0.45 }), 0xb9bcc0),
      tint(CY(0.28, 0.28, 0.07, 10, { y: 0.93 }), 0x2d3035),
      tint(TOR(0.16, 0.03, { y: 0.97, rx: Math.PI / 2 }, 3, 10), 0x2d3035),
    ]);
    I.def('bin', bin, M.paint, { shadow: true });

    const BRANDS = [
      { brand: 'Tojo Cola', color: '#c8102e' }, { brand: 'サンシャイン', color: '#f2b705' },
      { brand: 'BOSS COFFEE', color: '#1a1a1a' }, { brand: 'ポッポ', color: '#1c56b7' },
      { brand: 'ポカリスエス', color: '#0b8fd0' }, { brand: '伊右衛問 緑茶', color: '#1d6b3a' },
      { brand: 'キリソ午後の紅茶', color: '#b8336a' }, { brand: 'アサビ ワンダ', color: '#e2601a' },
    ];
    // ---- bicycles (ママチャリ) and scooters
    // A 64 cm wheel 3 m from the camera is the most foreground object in the plaza: a 10-gon tyre with two
    // crossed 12 mm boxes for spokes reads as a black plus-sign inside a polygon. 20-sided tyre, a rim ring
    // that catches light, and 8 real spokes.
    const WHEEL = merge([
      tint(TOR(0.325, 0.032, { rx: Math.PI / 2 }, 4, 20), 0x17181a),                             // tyre
      tint(TOR(0.275, 0.014, { rx: Math.PI / 2 }, 3, 18), 0xb6bbc0),                             // rim
      ...Array.from({ length: 8 }, (_, i) => tint(CYO(0.0045, 0.0045, 0.54, 3, { rz: i * Math.PI / 8 }), 0xc4c9ce)),
      tint(CYO(0.042, 0.042, 0.07, 6, { rx: Math.PI / 2 }), 0x8d9296),                           // hub
    ]);
    // a crude stand-in for anything past ~26 m: same silhouette, 1/6 the triangles
    const WHEEL_LOD = merge([tint(TOR(0.325, 0.038, { rx: Math.PI / 2 }, 3, 10), 0x1c1d20)]);
    const bikeBody = merge([
      tint(CYO(0.026, 0.026, 0.66, 6, { rz: Math.PI / 2 - 0.32, x: 0.3, y: 0.62 }), 0xffffff),   // top tube
      tint(CYO(0.027, 0.027, 0.52, 6, { rz: 0.22, x: 0.02, y: 0.52 }), 0xffffff),                // seat tube
      tint(CYO(0.026, 0.026, 0.62, 6, { rz: -0.72, x: 0.34, y: 0.42 }), 0xffffff),               // down tube
      tint(CYO(0.016, 0.016, 0.52, 6, { rz: Math.PI / 2 - 0.16, x: -0.26, y: 0.36 }), 0xffffff), // stays
      tint(CYO(0.018, 0.018, 0.62, 6, { rz: -0.22, x: 0.58, y: 0.5 }), 0x3c4045),                // fork/steerer
      tint(CYO(0.014, 0.014, 0.3, 5, { rz: 0.28, x: 0.03, y: 0.66 }), 0x6a6f74),                 // seat post
      tint(B(0.04, 0.03, 0.46, { x: 0.62, y: 0.92 }), 0x2c2f33),                                // handlebar
      ...[-0.21, 0.21].map(z => tint(CYO(0.016, 0.016, 0.1, 5, { rx: Math.PI / 2, x: 0.62, y: 0.92, z }), 0x1a1c20)),  // grips
      tint(B(0.24, 0.055, 0.13, { x: 0.02, y: 0.8, rz: -0.08 }), 0x1e2024),                     // saddle
      tint(B(0.28, 0.2, 0.3, { x: 0.66, y: 0.74 }), 0xbfc4c8),                                  // front basket
      tint(B(0.25, 0.015, 0.27, { x: 0.66, y: 0.645 }), 0x8a8f94),
      tint(B(0.3, 0.03, 0.22, { x: -0.3, y: 0.66 }), 0x3c4045),                                 // rear carrier
      tint(TOR(0.34, 0.014, { x: 0.62, y: 0.32, rx: Math.PI / 2, rz: 0.2 }, 3, 10), 0x55595e),  // front mudguard
      tint(TOR(0.34, 0.014, { x: -0.42, y: 0.32, rx: Math.PI / 2 }, 3, 10), 0x55595e),
      tint(CYO(0.03, 0.03, 0.14, 5, { rx: Math.PI / 2, x: 0.16, y: 0.3 }), 0x2c2f33),           // crank
      tint(CYO(0.012, 0.012, 0.9, 4, { rz: 0.25, x: -0.24, y: 0.48 }), 0x8d9296),               // kickstand / lock arm
    ]);
    const bikeLod = merge([
      tint(B(0.9, 0.05, 0.05, { x: 0.12, y: 0.6, rz: -0.12 }), 0xffffff),
      tint(B(0.05, 0.4, 0.05, { x: 0.02, y: 0.55 }), 0xffffff),
      tint(B(0.24, 0.18, 0.26, { x: 0.66, y: 0.74 }), 0xbfc4c8),
      tint(B(0.22, 0.05, 0.12, { x: 0.02, y: 0.8 }), 0x1e2024),
      WHEEL_LOD.clone().translate(0.62, 0.325, 0), WHEEL_LOD.clone().translate(-0.42, 0.325, 0),
    ]);
    const wheelPair = merge([WHEEL.clone().translate(0.62, 0.325, 0), WHEEL.clone().translate(-0.42, 0.325, 0)]);
    I.def('bike', bikeBody, M.paint, { shadow: true });
    I.def('bike_wheel', wheelPair, M.paint, { shadow: true });
    I.def('bike_far', bikeLod, M.paint, {});
    // throwables live in their own pair of meshes: the static families get compacted by the distance cull and
    // an index into a compacted buffer no longer points at the prop it was issued for.
    I.def('bike_dyn', bikeBody, M.paint, { shadow: true, dynamic: true });
    I.def('bike_wheel_dyn', wheelPair, M.paint, { shadow: true, dynamic: true });
    const scooter = merge([
      tint(B(1.04, 0.3, 0.34, { x: 0.05, y: 0.6 }), 0xffffff),
      tint(B(0.5, 0.26, 0.3, { x: -0.3, y: 0.82 }), 0xffffff),
      tint(B(0.42, 0.08, 0.3, { x: -0.3, y: 0.98 }), 0x1c1e22),
      tint(CY(0.035, 0.035, 0.72, 6, { rz: -0.3, x: 0.52, y: 0.72 }), 0x3c4045),
      tint(B(0.06, 0.05, 0.52, { x: 0.66, y: 1.02 }), 0x2c2f33),
      tint(B(0.3, 0.3, 0.06, { x: 0.62, y: 0.86 }), 0x25282c),
      tint(B(0.6, 0.06, 0.28, { x: 0.1, y: 0.4 }), 0x2c2f33),
      tint(TOR(0.22, 0.06, { x: 0.6, y: 0.22, rx: Math.PI / 2 }, 5, 12), 0x17181a),
      tint(TOR(0.22, 0.06, { x: -0.5, y: 0.22, rx: Math.PI / 2 }, 5, 12), 0x17181a),
    ]);
    I.def('scooter', scooter, M.paint, { shadow: true });
    // ---- traffic cone, bin, A-frame, umbrella stand, menu board legs
    const coneGeo = merge([
      tint(B(0.42, 0.045, 0.42, { y: 0.022 }), 0xd84a18),
      tint(xf(new THREE.ConeGeometry(0.15, 0.72, 10, 1, true), { y: 0.41 }), 0xf05a20),
      tint(xf(new THREE.ConeGeometry(0.115, 0.14, 10, 1, true), { y: 0.55 }), 0xf2f0e8),
    ]);
    I.def('cone', coneGeo, M.paint, { shadow: true, dynamic: true });
    const barGeo = merge([
      tint(B(1.8, 0.09, 0.05, { y: 0.84 }), 0xf05a20),
      tint(B(1.8, 0.09, 0.05, { y: 0.66 }), 0xf2f0e8),
      ...[-0.8, 0.8].map(x => tint(B(0.05, 0.9, 0.05, { x, y: 0.45 }), 0xf05a20)),
      ...[-0.8, 0.8].map(x => tint(B(0.5, 0.05, 0.5, { x, y: 0.03 }), 0x2c2f33)),
    ]);
    I.def('barrier', barGeo, M.paint, { shadow: true });
    // konbini 分別ゴミ箱: a 可燃 / 不燃 pair on a shared tray. Each is a tapered tub with a real circular
    // deposit opening cut in the lid (annulus + dark throat), a liner-bag lip over the rim, wire bands and a
    // label plate — a flat saturated cuboid with a black slab on top is a placeholder, not a bin.
    const binTub = (x, body, lid) => [
      tint(CYO(0.235, 0.2, 0.68, 12, { x, y: 0.37 }), body),                                    // tapered tub
      tint(CYO(0.243, 0.243, 0.1, 12, { x, y: 0.75 }), body),                                   // collar
      tint(xf(new THREE.RingGeometry(0.115, 0.248, 18, 1), { rx: -Math.PI / 2, x, y: 0.805 }), lid),
      tint(CYO(0.113, 0.113, 0.16, 12, { x, y: 0.73 }), 0x0d0f11),                              // throat
      tint(TOR(0.244, 0.018, { x, y: 0.79, rx: Math.PI / 2 }, 4, 14), lid),                     // rim moulding
      tint(TOR(0.236, 0.012, { x, y: 0.735, rx: Math.PI / 2 }, 3, 12), 0xd8d4c8),               // liner-bag lip
      ...[0.2, 0.44].map(y => tint(TOR(0.228, 0.008, { x, y, rx: Math.PI / 2 }, 3, 12), 0x6d7175)),
      tint(B(0.26, 0.15, 0.015, { x, y: 0.5, z: 0.21 }), 0xece8dc),                             // 可燃 / 不燃 label
      tint(B(0.26, 0.026, 0.02, { x, y: 0.555, z: 0.215 }), lid),
    ];
    const trash = merge([
      ...binTub(-0.27, 0xa8352e, 0x7d2620),
      ...binTub(0.27, 0x2f5aa0, 0x24417a),
      tint(B(1.06, 0.05, 0.54, { y: 0.025 }), 0x3a3f44),
      ...[-0.54, 0.54].map(x => tint(B(0.035, 0.72, 0.035, { x, y: 0.39 }), 0x5b6165)),
    ]);
    I.def('trash', trash, M.paint, { shadow: true, dynamic: true });
    const aPanel = (z, rx) => [
      tint(B(0.66, 0.92, 0.03, { y: 0.55, z, rx }), 0x23201b),
      tint(B(0.7, 0.07, 0.05, { y: 0.55 + Math.cos(rx) * 0.46, z: z + Math.sin(-rx) * 0.46, rx }), 0x9a7442),
      tint(B(0.7, 0.07, 0.05, { y: 0.55 - Math.cos(rx) * 0.46, z: z - Math.sin(-rx) * 0.46, rx }), 0x9a7442),
      ...[-0.335, 0.335].map(x => tint(B(0.055, 0.98, 0.05, { x, y: 0.55, z, rx }), 0x9a7442)),
    ];
    const aframe = merge([
      ...aPanel(0.15, -0.2), ...aPanel(-0.15, 0.2),
      tint(B(0.74, 0.055, 0.44, { y: 1.03 }), 0x7c5c34),
      ...[-0.33, 0.33].map(x => tint(B(0.05, 0.07, 0.52, { x, y: 0.035 }), 0x5c4526)),
    ]);
    I.def('aframe', aframe, M.paint, { shadow: true, dynamic: true });
    const brella = merge([
      tint(B(0.46, 0.5, 0.34, { y: 0.25 }), 0x6e737a),
      tint(B(0.48, 0.05, 0.36, { y: 0.52 }), 0x9aa0a6),
      ...[0, 1, 2, 3].map(i => tint(B(0.09, 0.42, 0.28, { x: -0.16 + i * 0.105, y: 0.3, z: 0.03 }), 0x3a3f45)),
      ...[0, 1, 2, 3, 4].map(i => tint(CY(0.018, 0.022, 0.86, 5, { x: -0.16 + i * 0.08, y: 0.7, rz: (i - 2) * 0.055 }), [0x27324a, 0x6a2430, 0x2f4a32, 0x3a3540, 0x1f3b58][i])),
      ...[0, 1, 2, 3, 4].map(i => tint(CY(0.014, 0.014, 0.12, 5, { x: -0.16 + i * 0.08, y: 1.18, rz: (i - 2) * 0.055 }), 0xcfd4d8)),
    ]);
    I.def('brella', brella, M.paint, { shadow: true });
    // stacked 通い箱: a moulded case, not a cuboid — recessed panel, hand slots cut in the ends, rib courses
    const crate = merge([
      tint(B(0.5, 0.3, 0.36, { y: 0.15 }), 0xffffff),
      tint(B(0.44, 0.17, 0.3, { y: 0.15, z: 0.045 }), 0xd2d2d2),                 // recessed front panel
      tint(B(0.52, 0.045, 0.38, { y: 0.315 }), 0xdedede),
      ...[-0.11, 0.11].map(y => tint(B(0.53, 0.035, 0.39, { y: 0.15 + y }), 0xb4b4b4)),
      ...[-0.255, 0.255].map(x => tint(B(0.02, 0.06, 0.16, { x, y: 0.22 }), 0x2a2c30)),   // hand slots
      tint(B(0.2, 0.12, 0.02, { y: 0.17, z: 0.19 }), 0xf4f2ea),
    ]);
    I.def('crate', crate, M.paint, { shadow: true });
    // ビールケース: what an alley wall in Kamurocho actually carries — an open case with bottle necks showing
    const beercase = merge([
      tint(B(0.46, 0.09, 0.34, { y: 0.045 }), 0xffffff),
      ...[[0.225, 0, 0.02, 0.26, 0.34], [-0.225, 0, 0.02, 0.26, 0.34]].map(([x, , , h, d]) => tint(B(0.025, h, d, { x, y: 0.15 }), 0xffffff)),
      ...[0.17, -0.17].map(z => tint(B(0.46, 0.26, 0.025, { y: 0.15, z }), 0xffffff)),
      tint(B(0.4, 0.05, 0.28, { y: 0.27 }), 0xc8c4bc),                            // divider grid top
      ...[0, 1, 2, 3].flatMap(i => [-0.07, 0.07].map(z => tint(CYO(0.032, 0.032, 0.2, 5, { x: -0.15 + i * 0.1, y: 0.18, z }), 0x3d2a14))),
      ...[0, 1, 2, 3].flatMap(i => [-0.07, 0.07].map(z => tint(CY(0.034, 0.034, 0.02, 5, { x: -0.15 + i * 0.1, y: 0.285, z }), 0xd8c26a))),
      tint(B(0.24, 0.1, 0.015, { y: 0.15, z: 0.185 }), 0xf0ece0),
    ]);
    I.def('beercase', beercase, M.paint, { shadow: true });
    const postbox = merge([
      tint(CY(0.26, 0.26, 1.02, 14, { y: 0.83 }), 0xc8102e),
      tint(SP(0.26, { y: 1.34 }, 14, 8), 0xc8102e),
      tint(CY(0.1, 0.13, 0.34, 10, { y: 0.16 }), 0x3a2024),
      tint(B(0.34, 0.06, 0.03, { y: 1.18, z: 0.25 }), 0x2a0e12),
      tint(B(0.3, 0.2, 0.02, { y: 0.86, z: 0.26 }), 0xf0ece0),
    ]);
    I.def('postbox', postbox, M.paint, { shadow: true });
    // ---- のぼり pole: tapered, tinted off black (a pure #000 rod has no specular and reads as a scratch),
    // with a cross pole whose end balls sit level with the cloth's top corner and チチ loops at the hem.
    const FW = 0.58, FH = 1.7, FTOP = FH + 0.55;
    const flagPole = (side) => merge([
      tint(CY(0.013, 0.026, 2.52, 6, { y: 1.26 }), 0x4a4d52),
      tint(SP(0.024, { y: 2.53 }, 6, 4), 0x9aa0a4),
      tint(CYO(0.011, 0.011, FW + 0.07, 5, { rz: Math.PI / 2, x: side * (FW / 2 + 0.02), y: FTOP }), 0x5a5e64),
      tint(SP(0.021, { x: side * (FW + 0.055), y: FTOP }, 6, 4), 0x9aa0a4),
      ...[0.3, 0.95, 1.55].map(y => tint(B(0.05, 0.028, 0.014, { x: side * 0.026, y: 0.55 + y }), 0xe4e0d6)),
      tint(CY(0.075, 0.09, 0.055, 8, { y: 0.028 }), 0x3a3f44),
    ]);
    I.def('flag_pole', flagPole(1), M.paint, { shadow: true });
    I.def('flag_pole_l', flagPole(-1), M.paint, { shadow: true });
    // the cloth itself: painted at plate density into signage's cloth page (DoubleSide, so the reverse of the
    // nobori shows the print through the weave the way a real one does) and seated hard against the pole.
    const noboriCloth = (text, bg, side) => {
      if (!sg || !sg.makePainted) return null;
      const geo = new THREE.PlaneGeometry(FW, FH, 3, 6);
      const pos = geo.attributes.position, wave = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) wave[i] = Math.max(0, (side * pos.getX(i) + FW / 2) / FW) ** 1.5;
      geo.setAttribute('aWave', new THREE.BufferAttribute(wave, 1));
      geo.translate(side * (FW / 2 + 0.006), FH / 2 + 0.55, 0);
      return sg.makePainted({
        style: 'cloth', w: FW, h: FH, key: 'nobori~' + text + bg, bleed: bg, ppm: 220, glow: 0.3,
        geometry: geo, painter: (ctx, px, py, W, H) => paintNobori(ctx, W, H, { text, bg }),
      });
    };
    // the chalk face of an A-frame is the FRONT BOARD of a menu board, not the whole free-standing board
    const boardFace = (key, m) => proto(key, () => {
      if (!sg || !sg.makeMenuBoard) return null;
      const g = sg.makeMenuBoard({ title: m.title, items: m.items, w: 0.62, h: 0.88 });
      const f = g.children.find(c => c.isMesh && !c.userData.frame);
      if (!f) return null;
      f.position.set(0, 0, 0); f.rotation.set(0, 0, 0); f.removeFromParent();
      return dim(f, 0.3);
    });
    const hydrant = merge([
      tint(CY(0.045, 0.05, 1.5, 8, { y: 0.75 }), 0xe0e0dc),
      tint(B(0.34, 0.44, 0.03, { y: 1.62 }), 0xc8102e),
      tint(B(0.3, 0.4, 0.02, { y: 1.62, z: 0.022 }), 0xf0ece0),
      tint(CY(0.11, 0.13, 0.12, 8, { y: 0.06 }), 0x3a3f44),
    ]);
    I.def('hydrant', hydrant, M.paint, { shadow: true });

    prof.geo = performance.now() - prof.t0;
    // ------------------------------------------------------- walk the facades and dress them
    // センター街 and the other pedestrian streets are shop frontage, not back-alley: city marks them 'alley'
    // because no carriageway runs past, but they carry the densest dressing in Shibuya.
    const pedStreets = CITY.pedestrianStreets || [];
    const pedDist = (x, z) => {
      let best = Infinity;
      for (const p of pedStreets) for (let i = 0; i < p.path.length - 1; i++)
        best = Math.min(best, distToSeg(x, z, p.path[i][0], p.path[i][1], p.path[i + 1][0], p.path[i + 1][1]) - p.width / 2);
      return best;
    };
    // a センター街 flank wall is 20 m of shop frontage that happens to face a blind side street: it failed the
    // old width/2 + 4.5 m test entirely. Widen the band, and also accept a face whose outward normal points
    // INTO the pedestrian street a few metres away.
    const nearPed = (x, z, nx, nz) => pedDist(x, z) < 9 || pedDist(x + nx * 7, z + nz * 7) < 1.5;
    // every slot is assigned to the street it fronts so quota is spent per street, not greedily outward
    const STREETS = [
      ...pedStreets.map(s => ({ id: s.id, path: s.path, w: s.width, ped: true })),
      ...(CITY.roads || []).map(r => ({ id: r.id, path: r.path, w: r.width, ped: false })),
    ];
    const streetOf = (x, z) => {
      let best = '_', bd = Infinity;
      for (const s of STREETS) {
        for (let i = 0; i < s.path.length - 1; i++) {
          const d = distToSeg(x, z, s.path[i][0], s.path[i][1], s.path[i + 1][0], s.path[i + 1][1]) - s.w / 2;
          if (d < bd) { bd = d; best = s.id; }
        }
      }
      return bd < 30 ? best : '_';
    };
    const slots = [];
    for (const f of city.facades || []) {
      if (!f.position || !f.normal) continue;
      if (f.width < 3) continue;
      if (Math.abs(f.position.x) > 200 || Math.abs(f.position.z) > 200) continue;
      const nx = f.normal.x, nz = f.normal.z, tx = -nz, tz = nx;
      const n = Math.max(1, Math.floor(f.width / 2.4));
      for (let i = 0; i < n; i++) {
        const s = -f.width / 2 + (i + 0.5) * (f.width / n);
        const sx = f.position.x + tx * s, sz = f.position.z + tz * s;
        const kind = (f.kind === 'alley' || f.kind === 'blind') && nearPed(sx, sz, nx, nz) ? 'pedestrian' : f.kind;
        slots.push({ x: sx, z: sz, nx, nz, kind, st: streetOf(sx, sz), tenants: f.tenants || [] });
      }
    }
    // dress the dense core first: only enough jitter to break the concentric ordering, not 70 m of noise
    for (const s of slots) s.k = Math.hypot(s.x, s.z) + rng.range(0, 12);
    slots.sort((a, b) => a.k - b.k);
    this.counts.pedSlots = slots.reduce((n, s) => n + (s.kind === 'pedestrian' ? 1 : 0), 0);
    prof.slots = performance.now() - prof.t0;

    const fieldOk = (x, z) => (city.field ? city.field.sample(x, z) > 0.45 : true);
    // Quota is PER STREET, not a global budget consumed in radial order — the old table handed ~1584 items to
    // the slots nearest the crossing and left 74 % of the city's shop fronts bare by construction.
    const BASE = { vend: 110, bike: 300, aframe: 320, flag: 700, menu: 180, brella: 60, trash: 120, cone: 60, crate: 200, scooter: 50, rack: 30, postbox: 14, hydrant: 30 };
    const weight = new Map(); let totalW = 0;
    for (const s of slots) { const k = s.kind === 'pedestrian' ? 2.4 : s.kind === 'alley' ? 0.7 : 1; weight.set(s.st, (weight.get(s.st) || 0) + k); totalW += k; }
    const quotas = new Map();
    const quotaFor = (id) => {
      let q = quotas.get(id);
      if (!q) { const f = (weight.get(id) || 1) / totalW; q = {}; for (const k in BASE) q[k] = Math.max(1, Math.round(BASE[k] * f)); quotas.set(id, q); }
      return q;
    };
    // radial density: the core still saturates first, but a shop front 150 m out is not bare
    const density = (d) => (d < 80 ? 1 : d > 180 ? 0.5 : 1 - 0.5 * (d - 80) / 100);
    const FLAGS = [
      ['ラーメン', '#d7262b'], ['生ビール', '#f2a007'], ['居酒屋', '#b8112b'], ['セール', '#e8306a'],
      ['カラオケ', '#7b2ff7'], ['たこ焼', '#e0531a'], ['餃子', '#c8102e'], ['本日開店', '#1c56b7'],
      ['食べ放題', '#1d6b3a'], ['学割あり', '#e8306a'], ['串カツ', '#a8102e'], ['立呑み', '#2b2b2b'],
    ];
    const MENUS = [
      { title: '本日のおすすめ', items: [['唐揚げ定食', '¥780'], ['生ビール', '¥390'], ['ハイボール', '¥290']] },
      { title: 'ランチ', items: [['醤油ラーメン', '¥880'], ['味玉ラーメン', '¥980'], ['餃子(6個)', '¥380']] },
      { title: '飲み放題', items: [['2時間', '¥1,680'], ['3時間', '¥2,180'], ['学割', '¥1,280']] },
      { title: 'CAFE', items: [['ブレンド', '¥420'], ['カフェラテ', '¥520'], ['ケーキセット', '¥780']] },
    ];
    // the shop's trade decides its street dressing: nobori and menu boards only in front of eateries / karaoke /
    // drugstores, never in front of a department store, a boutique or a bank (pass 11)
    const FLAGS_BY = {
      ramen: ['ラーメン', '餃子'], izakaya: ['生ビール', '居酒屋', '串カツ', '立呑み', '食べ放題'], bar: ['生ビール', '立呑み'],
      fast: ['たこ焼', '本日開店', '食べ放題'], family: ['食べ放題', '本日開店'], karaoke: ['カラオケ', '学割あり'], drug: ['セール'], conv: ['本日開店'],
    };
    const FOOD = new Set(['ramen', 'izakaya', 'bar', 'fast', 'family', 'cafe', 'gyudon']);
    const tradeOf = (slot) => { if (slot.kind === 'landmark') return 'landmark'; const n = (slot.tenants || [])[0]; return n ? tenantType(n, CITY.tenantPools) : null; };
    let vends = 0, bikes = 0, made = 0;
    const tally = this.counts.tally = {};
    for (const slot of slots) {
      const d = 0.55;
      const x = slot.x + slot.nx * d, z = slot.z + slot.nz * d;
      if (!fieldOk(x, z)) continue;
      if (rng() > density(Math.hypot(x, z))) continue;
      const ry = Math.atan2(slot.nx, slot.nz);
      const y = baseY(x, z);
      const quota = quotaFor(slot.st);
      const alley = slot.kind === 'alley' || slot.kind === 'blind';
      // choose a prop by remaining quota, weighted toward the shop-front kinds
      const pool = [];
      if (quota.vend > 0 && !alley) pool.push('vend', 'vend');
      if (quota.bike > 0) pool.push('bike', 'bike', 'bike');
      if (quota.aframe > 0 && !alley) pool.push('aframe', 'aframe');
      // on a pedestrian street the crowd hides anything below waist height, so lean on the tall dressing
      const trade = tradeOf(slot), flagSet = trade ? FLAGS_BY[trade] : null;
      if (quota.flag > 0 && !alley && (trade === null || flagSet)) { pool.push('flag', 'flag', 'flag'); if (slot.kind === 'pedestrian') pool.push('flag', 'flag', 'flag'); }
      if (quota.menu > 0 && !alley && (trade === null || FOOD.has(trade))) pool.push('menu');
      if (quota.brella > 0) pool.push('brella');
      if (quota.trash > 0) pool.push('trash');
      if (quota.cone > 0) pool.push('cone');
      // an alley wall carries crates and beer cases, which is what it actually carries in Kamurocho
      if (quota.crate > 0) { pool.push('crate'); if (alley) pool.push('crate', 'crate'); if (alley || slot.kind === 'pedestrian') pool.push('beercase', 'beercase'); }
      if (quota.scooter > 0) pool.push('scooter');
      if (quota.rack > 0) pool.push('rack');
      if (quota.postbox > 0 && !alley) pool.push('postbox');
      if (quota.hydrant > 0) pool.push('hydrant');
      if (!pool.length) continue;
      const pick = rng.pick(pool);
      tally[pick] = (tally[pick] || 0) + 1;
      if (pick === 'vend') {
        const count = rng.int(1, 3);
        let placed = 0;
        for (let k = 0; k < count; k++) {
          const tx = -slot.nz, tz = slot.nx;
          const ox = x + tx * (k - (count - 1) / 2) * 1.12, oz = z + tz * (k - (count - 1) / 2) * 1.12;
          if (!fieldOk(ox, oz) || !occ.claim(ox, oz, 0.62, 0.5)) continue;
          const yy = baseY(ox, oz);
          const b = BRANDS[(vends + k) % BRANDS.length];
          I.add('vend', ox, yy, oz, ry, 1, 0xffffff);
          I.add('vend_front', ox, yy, oz, ry, 1, 0xffffff);
          I.add('vend_glow', ox, yy, oz, ry, 1, 0xffdca8);
          I.add('contact', ox, yy, oz, ry, 1);
          I.add('pool_c', ox + slot.nx * 0.42, yy, oz + slot.nz * 0.42, 0, 0.42);
          // kept deliberately short-range: these have no shadow map, so a strong one washes the facade behind
          this.lights.push({ position: new THREE.Vector3(ox + slot.nx * 1.0, yy + 0.6, oz + slot.nz * 1.0), color: 0xffdcb0, intensity: 2.0, distance: 2.2 });
          if (sg && sg.makeVendingFace) {
            // a vending face is a backlit panel at arm's length, not a billboard: at 0.14 it still blew to a
            // pure-white strip under bloom and erased the product rows, the 選択ボタン and the あたたかい
            // tags. Track the exposure the scene is actually built at instead of a hard-coded constant.
            const face = proto('vend' + b.brand + ((vends + k) % 3), () => dim(sg.makeVendingFace({ brand: b.brand, color: b.color, w: VW - 0.1, h: VH - 0.16, seed: (vends + k) % 3 }), VGLOW));
            stage(face, ox + slot.nx * (VD / 2 + 0.012), yy + VH / 2 - 0.04, oz + slot.nz * (VD / 2 + 0.012), ry);
          }
          world.addStatic(boxOBB(ox, yy, oz, VW, VH, VD, ry), { tag: 'prop' });
          if (!this.sample.vend) this.sample.vend = [ox, yy, oz, ry];
          placed++;
        }
        if (placed) { vends += placed; quota.vend -= placed; if (rng.chance(0.5)) { const bx = x - slot.nz * (count * 0.62), bz = z + slot.nx * (count * 0.62); if (occ.claim(bx, bz, 0.4)) { I.add('bin', bx, baseY(bx, bz), bz, ry, 1, rng.pick([0x2f6b3a, 0x1c56b7, 0xb9bcc0])); I.add('contact', bx, baseY(bx, bz), bz, ry, 0.36); } } }
      } else if (pick === 'bike') {
        // a row of at most 4 at a 42 cm pitch, each claiming a 1.75 m oriented capsule along its own axis —
        // the old 27 cm disc let bikes from adjacent slots grow through one another into a heap of wreckage.
        const count = rng.int(2, 4), tx = -slot.nz, tz = slot.nx;
        let placed = 0;
        for (let k = 0; k < count; k++) {
          const ox = x + slot.nx * 0.42 + tx * (k - (count - 1) / 2) * 0.42;
          const oz = z + slot.nz * 0.42 + tz * (k - (count - 1) / 2) * 0.42;
          const bry = ry + Math.PI / 2 + (rng() - 0.5) * 0.1;
          if (!fieldOk(ox, oz) || !occ.claimRun(ox, oz, bry, 1.55, 0.2, 4)) continue;
          const lean = (rng() - 0.5) * 0.1;
          const rot = new THREE.Matrix4().makeRotationZ(0.05 + lean);
          const yy = baseY(ox, oz);
          const col = rng.pick([0x9aa0a6, 0x6d3a2a, 0x3a6ab0, 0xc8c4bc, 0x2f3a33, 0xa03040, 0xd8d4cc, 0x3f4a55]);
          const dyn = k === 0 && this.dynCount('bike') < 14;
          const parts = this.placeBike(I, ox, yy, oz, bry, col, dyn ? null : rot, dyn);
          if (parts) this.registerDynamic(world, parts, ox, yy + 0.34, oz, bry, 0.34, 9, 0.5);
          if (!this.sample.bike) this.sample.bike = [ox, yy, oz, bry];
          placed++;
        }
        bikes += placed; quota.bike -= placed;
      } else if (pick === 'flag') {
        let [text, bg] = rng.pick(FLAGS);
        if (flagSet) { const t = flagSet[Math.floor(rng() * flagSet.length)]; const f = FLAGS.find((q) => q[0] === t); if (f) [text, bg] = f; }
        if (!occ.claim(x, z, 0.28)) continue;
        // the printed face is always turned to the street: staging at ry + π/2 with no side test presented
        // the reverse of roughly half the nobori in the city. The cloth hangs either side of the pole.
        const side = rng.chance(0.5) ? 1 : -1;
        const lean = rng.range(-0.05, 0.05);
        const cloth = furl(proto('nob' + text + side, () => noboriCloth(text, bg, side)), rng.range(0, 6.28), side);
        if (cloth) stage(cloth, x, y, z, ry + rng.range(-0.12, 0.12), 0, lean);
        I.add(side > 0 ? 'flag_pole' : 'flag_pole_l', x, y, z, ry + rng.range(-0.12, 0.12), 1, 0xffffff,
          new THREE.Matrix4().makeRotationZ(lean));
        if (!this.sample.flag) this.sample.flag = [x, y, z, ry];
        quota.flag--;
      } else if (pick === 'menu') {
        if (!occ.claim(x, z, 0.45)) continue;
        let m = rng.pick(MENUS);
        if (trade === 'cafe') m = MENUS[3]; else if (trade === 'ramen') m = MENUS[1]; else if (trade === 'izakaya' || trade === 'bar') m = rng.chance(0.5) ? MENUS[0] : MENUS[2];
        if (sg && sg.makeMenuBoard) stage(proto('menu' + m.title, () => dim(sg.makeMenuBoard({ title: m.title, items: m.items, w: 0.62, h: 0.92 }), 0.34)), x, y, z, ry);
        I.add('contact', x, y, z, ry, 0.48);
        quota.menu--;
      } else if (pick === 'aframe') {
        if (!occ.claim(x, z, 0.5)) continue;
        const ar = ry + rng.range(-0.4, 0.4);
        const idx = I.add('aframe', x, y, z, ar, 1, 0xffffff);
        I.add('contact', x, y, z, ar, [0.7, 1, 0.55]);
        if (!this.sample.aframe) this.sample.aframe = [x, y, z, ar];
        const dyn = this.dynCount('aframe') < 8;
        // EVERY board gets a chalk face — the FRONT BOARD ONLY. makeMenuBoard returns a complete free-standing
        // board (own legs, own back panel, own -0.18 tilt); stuffing that whole group into the frame put a
        // second standing board 26 cm in front of the A-frame's own panels with its leg box through the rail.
        const m = rng.pick(MENUS);
        const face = boardFace('af' + m.title, m);
        const AFY = 0.55, AFZ = 0.172, AFR = -0.2;                 // the +z panel's own centre, tilt and plane
        if (face && !dyn) stage(face, x + Math.sin(ar) * AFZ, y + AFY, z + Math.cos(ar) * AFZ, ar, AFR);
        if (dyn) {
          const rec = this.registerDynamic(world, [['aframe', idx]], x, y + 0.52, z, ar, 0.52, 6, 0.45);
          if (rec && face) this.attachFace(rec, face, 0, AFY, AFZ, AFR);
          else if (face) stage(face, x + Math.sin(ar) * AFZ, y + AFY, z + Math.cos(ar) * AFZ, ar, AFR);
        }
        quota.aframe--;
      } else if (pick === 'trash') {
        // push the pair out by half its own depth, or the rear tub ends up buried in the wall it stands against
        const bx = x + slot.nx * 0.3, bz = z + slot.nz * 0.3;
        if (this.foot && this.foot.hit(bx, bz, 0.34)) continue;
        if (!occ.claim(bx, bz, 0.45)) continue;
        const yy = baseY(bx, bz);
        const idx = I.add('trash', bx, yy, bz, ry, 1, 0xffffff);
        I.add('contact', bx, yy, bz, ry, [0.72, 1, 0.42]);
        if (this.dynCount('trash') < 10) this.registerDynamic(world, [['trash', idx]], bx, yy + 0.42, bz, ry, 0.42, 4, 0.34);
        quota.trash--;
      } else if (pick === 'cone') {
        const count = rng.int(1, 3), tx = -slot.nz, tz = slot.nx;
        for (let k = 0; k < count; k++) {
          const ox = x + tx * (k - (count - 1) / 2) * 0.9, oz = z + tz * (k - (count - 1) / 2) * 0.9;
          if (!occ.claim(ox, oz, 0.3)) continue;
          const idx = I.add('cone', ox, baseY(ox, oz), oz, rng.range(0, 6.28), 1, 0xffffff);
          if (this.dynCount('cone') < 12) this.registerDynamic(world, [['cone', idx]], ox, baseY(ox, oz) + 0.36, oz, 0, 0.36, 2, 0.28);
          quota.cone--;
        }
        if (rng.chance(0.4) && occ.claim(x, z, 1.0)) I.add('barrier', x, y, z, ry + Math.PI / 2, 1, 0xffffff);
      } else if (pick === 'brella') {
        if (!occ.claim(x, z, 0.35)) continue;
        I.add('brella', x, y, z, ry, 1, 0xffffff); I.add('contact', x, y, z, ry, 0.34); quota.brella--;
      } else if (pick === 'crate' || pick === 'beercase') {
        // a stacked cluster, pushed clear of the wall by half its own depth
        const cx = x + slot.nx * 0.2, cz = z + slot.nz * 0.2;
        if (this.foot && this.foot.hit(cx, cz, 0.24)) continue;
        if (!occ.claim(cx, cz, 0.4)) continue;
        const yy = baseY(cx, cz);
        const cols = pick === 'beercase' ? [0xc03a2a, 0x2f6b3a, 0x2b3f72] : [0x3f6b48, 0x44577f, 0x7a6244, 0xb0a894];
        const st = rng.int(2, pick === 'beercase' ? 5 : 3), step = pick === 'beercase' ? 0.3 : 0.32;
        for (let k = 0; k < st; k++) I.add(pick, cx, yy + k * step, cz, ry + rng.range(-0.22, 0.22), 1, rng.pick(cols));
        I.add('contact', cx, yy, cz, ry, [0.62, 1, 0.5]);
        if (rng.chance(0.4)) {
          const ox = cx - slot.nz * 0.62, oz = cz + slot.nx * 0.62;
          if (occ.claim(ox, oz, 0.34)) {
            const n2 = rng.int(1, 3);
            for (let k = 0; k < n2; k++) I.add(pick === 'beercase' ? 'beercase' : 'crate', ox, baseY(ox, oz) + k * step, oz, ry + rng.range(-0.3, 0.3), 1, rng.pick(cols));
            I.add('contact', ox, baseY(ox, oz), oz, ry, [0.58, 1, 0.46]);
          }
        }
        quota.crate--;
      } else if (pick === 'scooter') {
        if (!occ.claim(x, z, 0.6)) continue;
        I.add('scooter', x, y, z, ry + Math.PI / 2, 1, rng.pick([0xd8dadc, 0x24282c, 0xc03a2a, 0x2f4f7a]));
        I.add('contact', x, y, z, ry + Math.PI / 2, [0.85, 1, 0.34]);
        world.addStatic(boxOBB(x, y, z, 1.5, 1.1, 0.6, ry + Math.PI / 2), { tag: 'prop' });
        quota.scooter--;
      } else if (pick === 'rack') {
        if (!occ.claim(x, z, 1.1, 1.0)) continue;                     // (1.9 m long: its whole length on the pavement)
        I.add('rack', x, y, z, ry + Math.PI / 2, 1, 0xffffff); I.add('contact', x, y, z, ry + Math.PI / 2, [1.0, 1, 0.3]); quota.rack--;
      } else if (pick === 'postbox') {
        if (!occ.claim(x, z, 0.45)) continue;
        I.add('postbox', x, y, z, ry, 1, 0xffffff); I.add('contact', x, y, z, ry, 0.34); quota.postbox--;
        world.addStatic(boxOBB(x, y, z, 0.6, 1.6, 0.6, ry), { tag: 'prop' });
      } else if (pick === 'hydrant') {
        if (!occ.claim(x, z, 0.3)) continue;
        I.add('hydrant', x, y, z, ry, 1, 0xffffff); quota.hydrant--;
      }
      made++;
      if (made > 7000) break;
    }
    this.counts.vending = vends;
    this.counts.bike = bikes;
    this.counts.sgms = Math.round(prof.sg);
    this.counts.sgn = prof.n;
    this.counts.slots = slots.length;
    this.counts.phase = `ped ${this.counts.pedSlots} geo ${Math.round(prof.geo)} slot ${Math.round(prof.slots)} place ${Math.round(performance.now() - prof.t0 - prof.slots)}`;
  },

  // ============================================================ metro entrances, koban details, parked trucks
  buildLandmarkProps(I, M, city, sg, occ, baseY, rng, world) {
    const stage = (mesh, x, y, z, ry) => {
      if (!sg || !sg.batch || !mesh) return;
      mesh.position.set(x, y, z); mesh.rotation.set(0, ry, 0);
      sg.batch(mesh); this._staged = true;
    };
    // ---- 東京メトロ entrance: stair box down, handrails, canopy, totem
    // the pavement has no hole cut in it, so the stairwell is a dark recess: black floor, three visible treads,
    // stepped-down parapets and handrails, under a lit canopy with a metro-blue fascia.
    const metro = merge([
      tint(B(2.7, 0.06, 3.6, { y: 0.14, z: -1.3 }), 0x04050a),
      ...[0, 1, 2].map(i => tint(B(2.7, 0.2 - i * 0.055, 0.36, { y: 0.06 - i * 0.055, z: 0.42 - i * 0.36 }), 0x76797d)),
      ...[-1.52, 1.52].flatMap(x => [0, 1, 2].map(i => tint(B(0.26, 1.02 - i * 0.24, 1.25, { x, y: 0.15 + (1.02 - i * 0.24) / 2, z: 0.3 - i * 1.25 }), 0xb4b0a6))),
      tint(B(3.35, 0.95, 0.26, { y: 0.62, z: 0.85 }), 0xb4b0a6),
      ...[-1.52, 1.52].map(x => tint(CY(0.028, 0.028, 3.3, 6, { x, y: 1.16, z: -1.15, rx: 0.28 }), 0xd2d6da)),
      ...[[-1.78, 0.5], [1.78, 0.5], [-1.78, -2.2], [1.78, -2.2]].map(([x, z]) => tint(CY(0.062, 0.075, 2.62, 8, { x, y: 1.31, z }), 0x5a5f65)),
      tint(B(3.9, 0.1, 2.55, { y: 2.68, z: -0.85 }), 0x5b6167),
      ...[-1.5, -0.75, 0, 0.75, 1.5].map(x => tint(B(0.1, 0.07, 2.55, { x, y: 2.75, z: -0.85 }), 0x777d84)),
      tint(B(4.0, 0.26, 2.62, { y: 2.5, z: -0.85 }), 0x1c56b7),
      tint(B(3.7, 0.05, 2.36, { y: 2.36, z: -0.85 }), 0x2a2e33),
    ]);
    I.def('metro', metro, M.paint, { shadow: true });
    I.def('metro_glow', merge([
      tint(B(3.5, 0.03, 0.34, { y: 2.335, z: -1.65 }), 0xfff0d2),
      tint(B(3.5, 0.03, 0.34, { y: 2.335, z: -0.05 }), 0xfff0d2),
    ]), M.emit, { bloom: true });
    const METROS = [[-30, 17, 0.4, '3'], [10, -29, Math.PI + 0.2, '5'], [30, 6, -Math.PI / 2, '8'], [-36, -20, 1.9, '1']];
    for (const [x0, z0, ry, exit] of METROS) {
      const sp = this.guard ? this.guard.snap(x0, z0, 1.2, 12, occ, 3.0, (px, pz) => this.guard.box(px, pz, ry, -1.85, 1.85, -3.15, 1.05)) : [x0, z0];
      if (!sp) continue;
      const [x, z] = sp; occ.take(x, z, 3.0);
      const y = baseY(x, z);
      I.add('metro', x, y, z, ry, 1);
      I.add('metro_glow', x, y, z, ry, 1, 0xfff0d2);
      if (sg && sg.makeMetroTotem) stage(sg.makeMetroTotem({ exit }), x + Math.sin(ry + 1.4) * 2.4, y, z + Math.cos(ry + 1.4) * 2.4, ry);
      world.addStatic(boxOBB(x, y, z, 4.2, 0.4, 3.6, ry), { tag: 'prop' });
      // the canopy slab (2.36–2.8 m, above every capsule and the crowd's 0–2 m probes): an occluder for the combat
      // camera only, which otherwise swung its lens into the blue fascia beside the entrance
      const cx = x + Math.sin(ry) * -0.85, cz = z + Math.cos(ry) * -0.85;
      world.addStatic(boxOBB(cx, y + 2.36, cz, 4.0, 0.46, 2.62, ry), { tag: 'canopy' });
    }
    // ---- koban details: red lamp, notice board, police bicycle, cones
    const plaza = (CITY.plazas || []).find(p => p.id === 'hachiko');
    if (plaza && plaza.koban) {
      const [kx, kz] = plaza.koban.pos, kry = Math.atan2(Math.cos(plaza.koban.rotY), -Math.sin(plaza.koban.rotY));
      const y = baseY(kx, kz);
      // (the 赤色灯 belongs to the koban builder in smallLandmarks.js — a second one from here ended up
      //  embedded flat in the tiled wall, reading as a red blob beside the bronze emblem)
      // the canopy downlights are emissive quads on the soffit with nothing under them — give them a pool
      for (const t of [-1.3, 1.3]) {
        const lx = kx + Math.sin(kry) * 2.45 + Math.cos(kry) * t, lz = kz + Math.cos(kry) * 2.45 - Math.sin(kry) * t;
        this.lights.push({ position: new THREE.Vector3(lx, y + 3.25, lz), color: 0xfff0d4, intensity: 14, distance: 6 });
        I.add('pool_c', lx, y, lz, 0, 0.75);
      }
      const board = merge([
        tint(B(1.5, 1.05, 0.06, { y: 1.55 }), 0x24272b),
        tint(B(1.4, 0.94, 0.02, { y: 1.55, z: 0.04 }), 0xf0ece0),
        ...[-0.62, 0.62].map(x => tint(B(0.07, 1.05, 0.07, { x, y: 0.52 }), 0x3a3f44)),
      ]);
      I.def('noticeboard', board, M.paint, { shadow: true });
      I.add('noticeboard', kx + Math.sin(kry) * 3.4 - Math.cos(kry) * 2.6, y, kz + Math.cos(kry) * 3.4 + Math.sin(kry) * 2.6, kry, 1);
      for (let k = 0; k < 3; k++) {
        const ox = kx + Math.sin(kry) * 3.2 + Math.cos(kry) * (1.2 + k * 0.62), oz = kz + Math.cos(kry) * 3.2 - Math.sin(kry) * (1.2 + k * 0.62);
        if (occ.claimRun(ox, oz, kry + Math.PI / 2, 1.55, 0.2, 4)) this.placeBike(I, ox, baseY(ox, oz), oz, kry + Math.PI / 2, 0xf2f2f0, null, false);
      }
    }
    // ---- bus shelters over the 西口 / 東口 bays: roof, glass back, bench, timetable pillar
    const shelter = merge([
      tint(B(4.6, 0.12, 1.9, { y: 2.66, rx: 0.04 }), 0x4d545b),
      tint(B(4.5, 0.05, 1.8, { y: 2.58, rx: 0.04 }), 0x24282d),
      ...[[-2.1, 0.8], [2.1, 0.8], [-2.1, -0.8], [2.1, -0.8]].map(([x, z]) => tint(CY(0.055, 0.065, 2.6, 8, { x, y: 1.3, z }), 0x6a7075)),
      tint(B(4.4, 0.09, 0.09, { y: 2.42, z: -0.85 }), 0x8d9296),
      tint(B(4.4, 0.09, 0.09, { y: 0.52, z: -0.85 }), 0x8d9296),
      ...[-1.45, 0, 1.45].map(x => tint(B(0.07, 1.9, 0.07, { x, y: 1.47, z: -0.85 }), 0x8d9296)),
      ...[-1.5, 0, 1.5].map(x => tint(B(1.3, 0.05, 0.4, { x, y: 0.46, z: -0.5 }), 0x8a6a42)),
      ...[-1.5, 0, 1.5].map(x => tint(B(1.2, 0.42, 0.06, { x, y: 0.23, z: -0.5 }), 0x5a5f63)),
      tint(CY(0.05, 0.06, 2.9, 8, { x: 2.5, y: 1.45 }), 0x8d9296),
      tint(CY(0.34, 0.34, 0.06, 14, { x: 2.5, y: 2.86, rx: Math.PI / 2 }), 0xf2f0e8),
      tint(B(0.5, 0.86, 0.04, { x: 2.5, y: 1.9, z: 0.05 }), 0xf2f0e8),
    ]);
    I.def('shelter', shelter, M.paint, { shadow: true });
    I.def('shelter_glow', merge([
      tint(B(3.9, 0.04, 0.3, { y: 2.55, z: 0.42 }), 0xfff1d8),
      tint(B(3.9, 0.04, 0.3, { y: 2.55, z: -0.42 }), 0xfff1d8),
    ]), M.emit, { bloom: true });
    const shelterGlass = tint(B(4.3, 1.85, 0.02, { y: 1.45, z: -0.85 }), 0x8fb0c8);
    I.def('shelter_glass', shelterGlass, M.glass, {});
    for (const p of CITY.plazas || []) {
      for (const [bx, bz] of p.busBays || []) {
        const sp = this.guard ? this.guard.snap(bx - 3.2, bz, 1.0, 6, occ, 2.6, (px, pz) => this.guard.box(px, pz, Math.PI / 2, -1.05, 1.05, -2.35, 2.35)) : [bx - 3.2, bz];
        if (!sp) continue;
        const [sx, sz] = sp; occ.take(sx, sz, 2.6);
        const y = baseY(sx, sz);
        I.add('shelter', sx, y, sz, Math.PI / 2, 1);
        I.add('shelter_glow', sx, y, sz, Math.PI / 2, 1, 0x36322a);
        I.add('shelter_glass', sx, y, sz, Math.PI / 2, 1, 0x9fc0d8);
        this.lights.push({ position: new THREE.Vector3(sx, y + 2.4, sz), color: 0xfff1d8, intensity: 14, distance: 9 });
        world.addStatic(boxOBB(sx, y, sz, 2.0, 2.7, 4.6, Math.PI / 2), { tag: 'prop' });
      }
    }
    // ---- 喫煙所: glass smoking box with standing ashtrays on Hachiko square
    const smoke = merge([
      ...[[-1.9, 1.3], [1.9, 1.3], [-1.9, -1.3], [1.9, -1.3]].map(([x, z]) => tint(CY(0.05, 0.06, 2.35, 8, { x, y: 1.17, z }), 0x5a5f65)),
      tint(B(4.2, 0.12, 3.0, { y: 2.4 }), 0x33383d),
      tint(B(4.0, 0.06, 2.8, { y: 2.32 }), 0x141619),
      ...[-1.9, 1.9].map(x => tint(B(0.06, 2.3, 2.6, { x, y: 1.2 }), 0x3a4046)),
      tint(B(3.8, 2.3, 0.05, { y: 1.2, z: -1.42 }), 0x3a4046),
      ...[-0.9, 0.9].map(x => tint(CY(0.17, 0.2, 0.92, 10, { x, y: 0.46 }), 0x8d9296)),
      ...[-0.9, 0.9].map(x => tint(CY(0.19, 0.19, 0.06, 10, { x, y: 0.94 }), 0x2a2d31)),
    ]);
    I.def('smoking', smoke, M.paint, { shadow: true });
    const smokeGlass = merge([
      tint(B(3.7, 2.2, 0.02, { y: 1.2, z: -1.4 }), 0x8fb0c8),
      ...[-1.86, 1.86].map(x => tint(B(0.02, 2.2, 2.5, { x, y: 1.2 }), 0x8fb0c8)),
    ]);
    I.def('smoking_glass', smokeGlass, M.glass, {});
    for (const [sx0, sz0, sry] of [[36, 18, 0.1], [-27, 62, 1.5]]) {
      const sp = this.guard ? this.guard.snap(sx0, sz0, 1.5, 6, occ, 3.0) : [sx0, sz0];
      if (!sp) continue;
      const [sx, sz] = sp; occ.take(sx, sz, 3.0);
      const y = baseY(sx, sz);
      I.add('smoking', sx, y, sz, sry, 1);
      I.add('smoking_glass', sx, y, sz, sry, 1, 0x9fc0d8);
      world.addStatic(boxOBB(sx, y, sz, 4.2, 2.5, 3.0, sry), { tag: 'prop' });
    }
    // ---- タクシー乗り場 poles at the ranks
    const rankPole = merge([
      tint(CY(0.13, 0.15, 0.2, 10, { y: 0.1 }), 0x3a3f44),
      tint(CY(0.045, 0.055, 2.5, 8, { y: 1.3 }), 0xe8e4d8),
      tint(B(0.62, 0.9, 0.05, { y: 2.32 }), 0x2f3439),
    ]);
    I.def('rankpole', rankPole, M.paint, { shadow: true });
    const ranks = (CITY.spawns && CITY.spawns.taxiStand) || [];
    for (let i = 0; i < ranks.length; i += 2) {
      const [x, z] = ranks[i];
      const rx = x - 2.2;
      if (!occ.claim(rx, z, 0.8)) continue;
      const y = baseY(rx, z);
      I.add('rankpole', rx, y, z, Math.PI / 2, 1);
      if (sg && sg.makeSign) {
        const face = sg.makeSign({ text: 'タクシー乗り場', sub: 'TAXI', w: 0.58, h: 0.86, bg: '#f5d000', fg: '#111111', weight: '800', glow: 0.5 });
        stage(face, rx + 0.028, y + 2.32, z, Math.PI / 2);
        const back = sg.makeSign({ text: 'タクシー乗り場', sub: 'TAXI', w: 0.58, h: 0.86, bg: '#f5d000', fg: '#111111', weight: '800', glow: 0.5 });
        stage(back, rx - 0.028, y + 2.32, z, -Math.PI / 2);
      }
    }
    // ---- parked delivery trucks / vans on the kerbside loading bays
    const truck = merge([
      tint(B(2.1, 1.05, 2.0, { x: 1.55, y: 1.0 }), 0xffffff),                       // cab
      tint(B(2.0, 0.66, 1.86, { x: 1.6, y: 1.72 }), 0x16202c),                      // windscreen band
      tint(B(4.6, 2.2, 2.16, { x: -1.5, y: 1.62 }), 0xffffff),                      // box body
      tint(B(4.66, 0.12, 2.22, { x: -1.5, y: 2.74 }), 0xd8dadc),
      tint(B(0.08, 1.9, 2.0, { x: -3.82, y: 1.6 }), 0x9aa0a4),                      // rear shutter
      tint(B(5.0, 0.3, 2.2, { x: -1.2, y: 0.46 }), 0x3a3f44),                       // chassis
      ...[[1.4, 0.95], [1.4, -0.95], [-2.2, 0.95], [-2.2, -0.95]].map(([x, z]) => tint(CY(0.42, 0.42, 0.3, 12, { rx: Math.PI / 2, x, y: 0.44, z }), 0x17181a)),
      tint(B(0.3, 0.22, 0.12, { x: 2.6, y: 0.8, z: 0.78 }), 0xffe9c0),
      tint(B(0.3, 0.22, 0.12, { x: 2.6, y: 0.8, z: -0.78 }), 0xffe9c0),
    ]);
    I.def('truck', truck, M.paint, { shadow: true });
    // [traffic] kerbside loading bays on the carriageway itself, each clear of every lane, turn path, zebra and
    // traffic.js's own parked vehicles (the old list stood four of them on the pavement and one in a lane)
    const BAYS = [[-21.4, 29.1, 1.39], [-53.2, -16.8, -0.09], [-96.9, 4.0, -3.01], [-21.5, -109.1, 2.94], [-126.6, -28.0, -0.50], [143.1, -57.3, 1.60]];
    for (const [x, z, ry] of BAYS) {
      if (!occ.claim(x, z, 3.2, -1)) continue;                  // on the carriageway by design
      const y = groundY(x, z);
      I.add('truck', x, y, z, ry, 1, rng.pick([0xf2f2ee, 0xe8e4d8, 0xd8dee6]));
      world.addStatic(boxOBB(x, y, z, 7.2, 3.0, 2.3, ry), { tag: 'vehicle' });
    }
  },

  // ===================================================================== kerbside fill on the emptier pavements
  // the facade pass only dresses shop fronts; blank walls and wide pavements need the kerb itself furnished.
  buildKerbside(I0, M, city, occ, baseY, rng, world0) {
    let n = 0;
    // an item whose spot is now terminal carriageway (the 東口 apron over 明治通り's west pavement) is built into a
    // sink: it still claims its cell and draws its random numbers, so every other kerb item stays where it was
    const field = city && city.field, sinkI = { add() { return -1; } }, sinkW = { addStatic() {} };
    let I = I0, world = world0;
    for (const r of CITY.roads || []) {
      if (!r.sidewalk || r.sidewalk < 2.5) continue;
      const o = r.width / 2 + Math.min(2.0, r.sidewalk * 0.42);
      for (let i = 0; i < r.path.length - 1; i++) {
        const a = r.path[i], b = r.path[i + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        if (len < 3) continue;
        const nx = dz / len, nz = -dx / len, along = Math.atan2(dx, dz);
        for (let s = 2; s < len - 2; s += 5.5) {
          for (const side of [1, -1]) {
            const x = a[0] + dx * (s / len) + nx * o * side, z = a[1] + dz * (s / len) + nz * o * side;
            const d = Math.hypot(x, z);
            if (d > 175 || d < 24) continue;
            const ry = along + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
            const roll = rng();
            if (roll > 0.62) continue;
            const y = baseY(x, z);
            const sunk = field && x > 85 && x < 175 && z > 0 && z < 95 && field.sample(x, z) < 0.4;
            I = sunk ? sinkI : I0; world = sunk ? sinkW : world0;
            if (roll < 0.14) {
              if (!occ.claim(x, z, 1.0)) continue;
              I.add('planter', x, y, z, along, 1);
              I.add('contact', x, y, z, along, [0.86, 1, 0.42]);
              this.plantShrubs(I, x, y, z, along, rng);
              world.addStatic(boxOBB(x, y, z, 1.5, 0.7, 0.7, along), { tag: 'prop' });
            } else if (roll < 0.30) {
              for (let k = 0; k < 3; k++) {
                const bx = x + Math.sin(along) * (k - 1) * 1.5, bz = z + Math.cos(along) * (k - 1) * 1.5;
                if (occ.claim(bx, bz, 0.5)) { I.add('bollard', bx, baseY(bx, bz), bz, 0, 1); I.add('contact', bx, baseY(bx, bz), bz, 0, 0.22); }
              }
            } else if (roll < 0.44) {
              if (!occ.claim(x, z, 1.3)) continue;
              I.add('rack', x, y, z, along, 1, 0xffffff);
              I.add('contact', x, y, z, along, [1.0, 1, 0.3]);
              for (let k = 0; k < 4; k++) {
                const bx = x + Math.sin(along) * (k - 1.5) * 0.44, bz = z + Math.cos(along) * (k - 1.5) * 0.44;
                if (!occ.claimRun(bx, bz, ry, 1.55, 0.2, 4)) continue;
                this.placeBike(I, bx, baseY(bx, bz), bz, ry, rng.pick([0x9aa0a6, 0x6d3a2a, 0x3a6ab0, 0xc8c4bc, 0x2f3a33, 0xd8d4cc]), new THREE.Matrix4().makeRotationZ(0.05), false);
                this.counts.bike++;
              }
            } else if (roll < 0.52) {
              if (!occ.claim(x, z, 0.4)) continue;
              I.add('bin', x, y, z, ry, 1, rng.pick([0x2f6b3a, 0x1c56b7, 0xb9bcc0]));
              I.add('contact', x, y, z, ry, 0.36);
            } else if (roll < 0.57) {
              if (!occ.claim(x, z, 0.35)) continue;
              I.add('hydrant', x, y, z, ry, 1, 0xffffff);
              I.add('contact', x, y, z, ry, 0.24);
            } else {
              if (!occ.claim(x, z, 0.9)) continue;
              I.add('bench', x, y, z, along, 1);
              I.add('contact', x, y, z, along, [1.15, 1, 0.4]);
              world.addStatic(boxOBB(x, y, z, 2.0, 0.8, 0.6, along), { tag: 'prop' });
            }
            n++;
          }
        }
      }
    }
    I = I0; world = world0;
    // ---- plaza floor. buildBarriers only rims the perimeter, so the open granite of ハチ公前広場 reads as an
    // empty car park. Scatter furniture across the interior, clear of the statue, the koban and the bus bays.
    for (const p of CITY.plazas || []) {
      const poly = p.polygon || [];
      if (poly.length < 3 || p.terminal) continue;
      let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
      for (const [px, pz] of poly) { minx = Math.min(minx, px); maxx = Math.max(maxx, px); minz = Math.min(minz, pz); maxz = Math.max(maxz, pz); }
      const keep = [];
      if (p.statue) keep.push([p.statue.pos[0], p.statue.pos[1], 6.0]);
      if (p.koban) keep.push([p.koban.pos[0], p.koban.pos[1], 6.5]);
      for (const b of p.busBays || []) keep.push([b[0], b[1], 5.0]);
      for (const t of p.trees || []) keep.push([t[0], t[1], 2.8]);
      for (let gx = minx + 2; gx < maxx; gx += 4.4) {
        for (let gz = minz + 2; gz < maxz; gz += 4.4) {
          const x = gx + rng.range(-1.2, 1.2), z = gz + rng.range(-1.2, 1.2);
          if (Math.hypot(x, z) < 22) continue;
          if (!insidePoly(x, z, poly) || edgeDist(x, z, poly) < 2.0) continue;
          if (keep.some(([kx, kz, kr]) => (x - kx) ** 2 + (z - kz) ** 2 < kr * kr)) continue;
          if (this.foot && this.foot.hit(x, z, 0.9)) continue;
          if (rng() > 0.5) continue;                       // leave walking room between the clusters
          const y = baseY(x, z), ry = rng.range(0, 6.28), roll = rng();
          if (roll < 0.26) {
            if (!occ.claim(x, z, 1.1)) continue;
            I.add('planter', x, y, z, ry, 1);
            I.add('contact', x, y, z, ry, [0.86, 1, 0.42]);
            this.plantShrubs(I, x, y, z, ry, rng);
            world.addStatic(boxOBB(x, y, z, 1.5, 0.7, 0.7, ry), { tag: 'prop' });
          } else if (roll < 0.5) {
            if (!occ.claim(x, z, 1.1)) continue;
            I.add('bench', x, y, z, ry, 1);
            I.add('contact', x, y, z, ry, [1.15, 1, 0.4]);
            world.addStatic(boxOBB(x, y, z, 2.0, 0.8, 0.6, ry), { tag: 'prop' });
          } else if (roll < 0.7) {
            if (!occ.claim(x, z, 1.3)) continue;
            I.add('rack', x, y, z, ry, 1, 0xffffff);
            I.add('contact', x, y, z, ry, [1.0, 1, 0.3]);
            for (let k = 0; k < 4; k++) {
              const bx = x + Math.sin(ry) * (k - 1.5) * 0.44, bz = z + Math.cos(ry) * (k - 1.5) * 0.44;
              if (!occ.claimRun(bx, bz, ry + Math.PI / 2, 1.55, 0.2, 4)) continue;
              this.placeBike(I, bx, baseY(bx, bz), bz, ry + Math.PI / 2, rng.pick([0x9aa0a6, 0x6d3a2a, 0x3a6ab0, 0xc8c4bc, 0x2f3a33, 0xd8d4cc]), new THREE.Matrix4().makeRotationZ(0.05), false);
              this.counts.bike++;
            }
          } else if (roll < 0.84) {
            if (!occ.claim(x, z, 0.45)) continue;
            I.add('bin', x, y, z, ry, 1, rng.pick([0x2f6b3a, 0x1c56b7, 0xb9bcc0]));
            I.add('contact', x, y, z, ry, 0.36);
          } else {
            const ax = Math.cos(ry), az = -Math.sin(ry);
            for (let k = -1; k <= 1; k++) {
              const bx = x + ax * k * 1.5, bz = z + az * k * 1.5;
              if (occ.claim(bx, bz, 0.5)) { I.add('bollard', bx, baseY(bx, bz), bz, 0, 1); I.add('contact', bx, baseY(bx, bz), bz, 0, 0.22); }
            }
          }
          n++;
        }
      }
    }
    this.counts.kerb = n;
  },

  /** one parked bicycle: near mesh + far LOD stand-in + contact patch. `dyn` routes it to the throwable pair. */
  placeBike(I, x, y, z, ry, col, rot, dyn) {
    if (dyn) {
      const bi = I.add('bike_dyn', x, y, z, ry, 1, col);
      const wi = I.add('bike_wheel_dyn', x, y, z, ry, 1, 0x9aa0a4);
      return [['bike_dyn', bi], ['bike_wheel_dyn', wi]];
    }
    I.add('bike', x, y, z, ry, 1, col, rot);
    I.add('bike_wheel', x, y, z, ry, 1, 0x9aa0a4, rot);
    I.add('bike_far', x, y, z, ry, 1, col, rot);
    I.add('contact', x + Math.cos(ry) * 0.1, y, z - Math.sin(ry) * 0.1, ry, [0.95, 1, 0.3]);
    return null;
  },

  plantShrubs(I, x, y, z, ry, rng) {
    const n = rng.int(3, 6);
    for (let k = 0; k < n; k++) {
      const t = ((k + 0.5) / n - 0.5) * 1.08 + rng.range(-0.05, 0.05), u = rng.range(-0.1, 0.1);
      I.add('shrub', x + Math.cos(ry) * t + Math.sin(ry) * u, y + 0.6 + rng.range(-0.03, 0.06), z - Math.sin(ry) * t + Math.cos(ry) * u,
        rng.range(0, 6.28), rng.range(0.8, 1.25));
    }
  },

  // ------------------------------------------------------------------------------------- dynamic prop bodies
  dynCount(type) { let n = 0; for (const d of this.dynamics) if (d.type === type) n++; return n; },

  /** nearest throwable prop to a point → { body, type, position } | null  (combat: grab / heat action) */
  nearestProp(position, radius = 2.6) {
    let best = null, bd = radius * radius;
    for (const d of this.dynamics) {
      if (d.taken) continue;
      const p = d.body.position, dx = p.x - position.x, dy = p.y - position.y, dz = p.z - position.z;
      const q = dx * dx + dy * dy + dz * dz;
      if (q < bd) { bd = q; best = d; }
    }
    return best ? { body: best.body, type: best.type, position: best.body.position } : null;
  },

  /** lift a prop out of its InstancedMesh as a standalone mesh the caller can parent to a hand bone */
  takeProp(body) {
    const d = this.dynamics.find(x => x.body === body);
    if (!d) return null;
    if (d.taken) return d.taken;
    const g = new THREE.Group();
    g.name = 'prop:' + d.type;
    for (const [key, idx] of d.parts) {
      const im = this.I.get(key); if (!im) continue;
      let mat = im.material;
      if (im.instanceColor) {
        _c.fromArray(im.instanceColor.array, idx * 3);
        mat = im.material.clone(); mat.color.copy(_c);
      }
      g.add(new THREE.Mesh(im.geometry, mat));
      _m.makeScale(0, 0, 0);
      im.setMatrixAt(idx, _m); im.instanceMatrix.needsUpdate = true;
    }
    if (d.face) {
      d.face.visible = false;
      const f = lightClone(d.face);
      f.matrixAutoUpdate = false; f.matrix.copy(d.faceLocal); f.matrixWorldNeedsUpdate = true;
      g.add(f);
    }
    g.position.y = -d.restY;
    const wrap = new THREE.Group(); wrap.add(g); wrap.userData.prop = { type: d.type, body };
    d.taken = wrap; d.body.sleeping = true;
    return wrap;
  },

  /** put a taken prop back into the world at `position`, optionally with a throw impulse */
  releaseProp(body, position, velocity) {
    const d = this.dynamics.find(x => x.body === body);
    if (!d || !d.taken) return;
    d.taken = null;
    if (d.face) d.face.visible = true;
    if (position) body.position.copy(position);
    body.velocity.set(0, 0, 0);
    if (velocity) body.velocity.copy(velocity);
    body.sleeping = false; d.wake = true; d.prevSpeed = body.velocity.length();
  },

  registerDynamic(world, parts, x, y, z, ry, restY, mass, radius) {
    if (!world || !world.addDynamic) return;
    const type = parts[0][0].replace(/_dyn$/, '');
    const proxy = new THREE.Object3D();
    proxy.position.set(x, y, z); proxy.rotation.order = 'YXZ'; proxy.rotation.y = ry;
    const body = world.addDynamic({ mesh: proxy, mass, radius, tag: 'weapon' });
    if (!body) return;
    body.type = type; body.restY = restY;
    body.userData = { type, prop: true };
    proxy.userData.prop = { type };
    const rec = { body, proxy, type, parts, restY, ry, cool: 0 };
    this.dynamics.push(rec);
    return rec;
  },

  /** Bolt a signage face to a dynamic prop as a loose child so it rides the physics body instead of staying
   *  baked into the atlas at the prop's rest position. */
  attachFace(d, face, lx, ly, lz, rx) {
    if (!d || !face || !this.group) return;
    d.face = face;
    d.faceLocal = new THREE.Matrix4().makeTranslation(lx, ly, lz).multiply(new THREE.Matrix4().makeRotationX(rx || 0));
    face.matrixAutoUpdate = false;
    this.group.add(face);
    _q.setFromAxisAngle(UP, d.ry);
    _p.copy(d.body.position); _p.y -= d.restY;
    face.matrix.compose(_p, _q, _s.set(1, 1, 1)).multiply(d.faceLocal);
    face.matrixWorldNeedsUpdate = true;
  },

  // ---------------------------------------------------------------------------------------------- signals
  setSignalState(state = {}) {
    const s = this._state;
    if (state.ns) s.ns = state.ns;
    if (state.ew) s.ew = state.ew;
    if (state.ped) s.ped = state.ped;
    if (state.remaining != null) s.remaining = state.remaining;
    const flash = Math.floor(performance.now() / 260) % 2 === 0;
    const OFF = { red: 0x120604, amber: 0x120d05, green: 0x04120a };
    const ON = { red: 0xff2a18, amber: 0xffb020, green: 0x18e07a };
    for (const l of this.signalLamps) {
      const im = this.I && this.I.get(l.key);
      if (!im) continue;
      let on;
      if (l.axis === 'ped') on = l.color === 'green' ? (s.ped === 'walk' || (s.ped === 'flash' && flash)) : s.ped === 'stop';
      else on = (l.axis === 'ns' ? s.ns : s.ew) === l.color;
      // ped lenses carry their colour in the atlas, so the instance colour is only a gate
      if (l.axis === 'ped') _c.setHex(on ? 0xffffff : 0x0a0c0a);
      else _c.setHex(on ? ON[l.color] : OFF[l.color]);
      im.setColorAt(l.idx, _c);
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  },

  update(dt) {
    const engine = this.engine; if (!engine) return;
    const lighting = engine.get('lighting'), traffic = engine.get('traffic');
    const night = lighting && typeof lighting.nightFactor === 'number' ? lighting.nightFactor : 1;
    const M = this.M;
    if (M) {
      M.lamp.userData.uEmit.value = 0.25 + 3.4 * night;
      M.emit.userData.uEmit.value = 0.3 + 1.5 * night;
      M.signal.userData.uEmit.value = 2.6;
      M.ped.userData.uEmit.value = 0.55 + 0.45 * night;
      M.cone.opacity = 0.05 + 0.95 * night;
      M.pool.opacity = 0.02 + 0.98 * night;
      // foliage is lit, never self-lit: at 21:30 a zelkova canopy is near-black with streetlight spill only.
      // The lerp alone was not enough — the whole albedo comes down with it or the crown stays the most
      // saturated mass in a magenta frame.
      if (Math.abs(night - this._night) > 0.01) {
        this._night = night;
        M.leaf.color.lerpColors(M.dayLeaf, M.nightLeaf, night).multiplyScalar(1 - 0.45 * night);
        M.leaf.emissive.setRGB(0.012 * night, 0.020 * night, 0.010 * night);
      }
      const wet = engine.time.wet ?? 0;
      if (Math.abs(wet - this._wet) > 0.01) {
        this._wet = wet;
        M.paint.roughness = 0.52 - 0.24 * wet; M.paint.envMapIntensity = 0.9 + 0.8 * wet;
        M.flank.roughness = 0.42 - 0.18 * wet; M.flank.envMapIntensity = 1.1 + 0.7 * wet;
        M.steel.roughness = 0.28 - 0.16 * wet; M.steel.envMapIntensity = 1.4 + 0.8 * wet;
        M.leaf.roughness = 0.88 - 0.22 * wet;
        M.concrete.envMapIntensity = 0.7 + 0.9 * wet;
      }
    }
    this.cullVolumes(engine.camera);
    if (traffic && traffic.signal) {
      const t = traffic.signal;
      const changed = t.ns !== this._state.ns || t.ew !== this._state.ew || t.ped !== this._state.ped;
      // the flash phase only toggles ~2×/s: re-uploading instanceColor for every signal mesh 60×/s is pure waste
      const flashOn = t.ped === 'flash' ? Math.floor(performance.now() / 260) % 2 === 0 : false;
      if (changed || flashOn !== this._flashOn) { this._flashOn = flashOn; this.setSignalState(t); }
      else this._state.remaining = t.remaining;
      // countdown bar
      if (t.ped === 'walk' || t.ped === 'flash') this._pedMax = Math.max(this._pedMax, t.remaining || 0);
      const lit = (t.ped === 'stop') ? 0 : Math.ceil(clamp((t.remaining || 0) / Math.max(1, this._pedMax), 0, 1) * 8);
      if (lit !== this._lit && this.countdown) {
        this._lit = lit;
        const im = this.I.get('sig_count');
        if (im) {
          for (const segs of this.countdown) for (let k = 0; k < segs.length; k++) im.setColorAt(segs[k], _c.set(k < lit ? 0x18e07a : 0x06110b));
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
        }
      }
    }
    // dynamic props: mirror the physics bodies back into their instanced meshes, report impacts
    if (this.dynamics.length) {
      _dirty.clear();
      for (const d of this.dynamics) {
        const b = d.body;
        d.cool = Math.max(0, d.cool - dt);
        if (d.taken) continue;
        if (b.sleeping && !d.wake) continue;
        d.wake = !b.sleeping;
        _q.setFromEuler(d.proxy.rotation);
        _p.copy(b.position); _p.y -= d.restY;
        _m.compose(_p, _q, _s.set(1, 1, 1));
        for (const [key, idx] of d.parts) {
          const im = this.I.get(key);
          if (!im) continue;
          im.setMatrixAt(idx, _m);
          _dirty.add(im);
        }
        if (d.face && d.face.visible) { d.face.matrix.copy(_m).multiply(d.faceLocal); d.face.matrixWorldNeedsUpdate = true; }
        const speed = b.velocity.length(), drop = d.prevSpeed != null ? d.prevSpeed - speed : 0;
        if (drop > 2.2 && d.cool <= 0) {
          d.cool = 0.4;
          engine.events.emit('prop:impact', { point: b.position.clone(), strength: clamp(drop / 6, 0.2, 2.2), type: d.type });
        }
        d.prevSpeed = speed;
      }
      for (const im of _dirty) im.instanceMatrix.needsUpdate = true;
    }
  },

  /** Per-instance distance cull for the additive light volumes. One InstancedMesh per family spans the whole
   *  map, so whole-mesh frustum culling never fires; instead compact the matrices the camera can actually see
   *  and shrink `count`. Rebuilt only when the camera has moved. */
  prepCull(key, radius, near = 0) {
    const im = this.I.get(key); if (!im) return;
    const n = im.count, src = new Float32Array(im.instanceMatrix.array);
    const px = new Float32Array(n), pz = new Float32Array(n);
    for (let i = 0; i < n; i++) { px[i] = src[i * 16 + 12]; pz[i] = src[i * 16 + 14]; }
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    this._culls.push({ im, src, px, pz, n, r2: radius * radius, n2: near * near });
  },
  cullVolumes(camera) {
    if (!camera || !this._culls || !this._culls.length) return;
    const cx = camera.position.x, cz = camera.position.z;
    // forward on the ground plane; the behind-camera half is the whole point of the pass, so a turn has to
    // rebuild too — but only past a hysteresis band, or a running camera rebuilds every frame.
    _p.set(0, 0, -1).applyQuaternion(camera.quaternion);
    let fx = _p.x, fz = _p.z;
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const moved = (cx - this._cullX) ** 2 + (cz - this._cullZ) ** 2 > 64;
    if (!moved && fx * this._cullFx + fz * this._cullFz > 0.985) return;
    this._cullX = cx; this._cullZ = cz; this._cullFx = fx; this._cullFz = fz;
    for (const c of this._culls) {
      const dst = c.im.instanceMatrix.array;
      let k = 0;
      for (let i = 0; i < c.n; i++) {
        const dx = c.px[i] - cx, dz = c.pz[i] - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > c.r2 || d2 < c.n2) continue;
        if (d2 > 400 && dx * fx + dz * fz < -14) continue;      // behind the camera and not close
        dst.set(c.src.subarray(i * 16, i * 16 + 16), k * 16);
        k++;
      }
      c.im.count = k;
      // a blanket needsUpdate re-uploads the family's WHOLE matrix buffer; only the live prefix changed
      const a = c.im.instanceMatrix;
      a.clearUpdateRanges(); a.addUpdateRange(0, k * 16); a.needsUpdate = true;
    }
  },

  // frame the props that actually got placed (procedural positions), so a critic always sees the real thing
  facing(key, dist, h, t) {
    const s = this.sample[key];
    if (!s) return { pos: [-30, 1.7, -26], lookAt: [-45, 2, -44], t };
    const [x, y, z, ry] = s;
    return { pos: [x + Math.sin(ry) * dist + Math.cos(ry) * 1.3, y + h, z + Math.cos(ry) * dist - Math.sin(ry) * 1.3], lookAt: [x, y + 1.0, z], fov: 42, t };
  },

  // street level is a wall of pedestrians, so the review cameras sit above head height and look down the kerb
  shotPresets: {
    props_street: { pos: [-21, 6.4, -13], lookAt: [-42, 0.9, -40], t: 'night', fov: 55 },
    props_street_day: { pos: [-21, 6.4, -13], lookAt: [-42, 0.9, -40], t: 'day', fov: 55 },
    props_signals: { pos: [25, 7.0, 15], lookAt: [-6, 3.6, -12], t: 'night', fov: 48 },
    props_trees: { pos: [9, 7.0, 29], lookAt: [30, 2.6, 43], t: 'night', fov: 52 },
    props_trees_day: { pos: [9, 7.0, 29], lookAt: [30, 2.6, 43], t: 'day', fov: 52 },
    props_vending: () => props.facing('vend', 4.6, 2.4, 'night'),
    props_bikes: () => props.facing('bike', 3.0, 1.9, 'night'),
    props_flag: () => props.facing('flag', 3.2, 2.2, 'night'),
    props_aframe: () => props.facing('aframe', 2.2, 1.4, 'night'),
    props_kerb: { pos: [-44, 7.0, 30], lookAt: [-18, 0.8, -6], t: 'night', fov: 50 },
    props_centergai: { pos: [-28, 6.6, -22], lookAt: [-76, 1.4, -68], t: 'night', fov: 56 },
    props_plaza: { pos: [12, 6.8, 20], lookAt: [34, 0.9, 46], t: 'night', fov: 54 },
    props_koen: { pos: [15, 7.5, -44], lookAt: [22, 1.5, -92], t: 'night', fov: 52 },
    props_metro: { pos: [-38, 4.4, 24], lookAt: [-29, 1.4, 16], t: 'night', fov: 46 },
    props_bus: { pos: [-33, 5.2, 40], lookAt: [-21, 1.2, 64], t: 'night', fov: 52 },
    props_utility: { pos: [-70, 4.6, -18], lookAt: [-95, 7.5, -62], t: 'night', fov: 52 },
  },

  selfTest() {
    const problems = [];
    if (!this.lights.length) problems.push('no lights exported');
    if (!this.signalLamps.length) problems.push('no signal lamps');
    if (this.drawCalls > 120) problems.push(`draw calls ${this.drawCalls} > 120`);
    if (!this.dynamics.length) problems.push('no dynamic props');
    return { ok: problems.length === 0, ...this.counts, lights: this.lights.length, dynamics: this.dynamics.length, draws: this.drawCalls, triangles: this.triangles, problems };
  },
};

// -------------------------------------------------------------------------------------------------- helpers
// Object3D.clone() JSON-round-trips userData — and a signage mesh carries its whole atlas page in there, which
// costs tens of milliseconds each. Sign faces only need geometry + material + transform, so copy those by hand.
function lightClone(o) {
  const c = o.isMesh ? new THREE.Mesh(o.geometry, o.material) : new THREE.Group();
  c.name = o.name;
  c.userData = o.userData;
  c.position.copy(o.position); c.quaternion.copy(o.quaternion); c.scale.copy(o.scale);
  c.layers.mask = o.layers.mask;
  c.castShadow = o.castShadow; c.receiveShadow = o.receiveShadow; c.renderOrder = o.renderOrder;
  for (const ch of o.children) c.add(lightClone(ch));
  return c;
}
function remapV(geo, v0, v1) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, v0 + uv.getY(i) * (v1 - v0));
  uv.needsUpdate = true;
  return geo;
}
function boxOBB(x, y, z, w, h, d, ry) {
  return { obb: { center: new THREE.Vector3(x, y + h / 2, z), halfSize: new THREE.Vector3(w / 2, h / 2, d / 2), rotationY: ry } };
}
function nearestOnPolyline(x, z, pts) {
  let best = { x: pts[0][0], z: pts[0][1], d: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const px = ax + dx * t, pz = az + dz * t, d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < best.d) best = { x: px, z: pz, d };
  }
  return best;
}
function distToSeg(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
  const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}
function insidePoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function edgeDist(x, z, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distToSeg(x, z, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
  return d;
}
function axisOf(roadId) {
  return roadId === 'koen' || roadId === 'ekimae_s' || roadId === 'jingu_n' ? 'ns' : 'ew';
}

export default props;
export const shotPresets = props.shotPresets;
