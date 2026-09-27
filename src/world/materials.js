// [materials] PBR material library + procedural canvas texture generators.
//   Every texture set is generated at boot on a canvas (1024² for the ground/architecture sets): albedo, ORM
//   (R ao / G roughness / B metalness), tangent-space normal computed from a height field by Sobel, emissive where
//   relevant. All textures: correct colorSpace, RepeatWrapping, anisotropy 8, mipmaps.
//   Architecture/ground materials are sampled in WORLD space (triplanar by dominant normal) so any mesh, whatever
//   its UVs, gets correctly scaled detail; a world-space macro noise breaks tiling and drives wet puddles.
//
//   get(key)                          shared material (keys: see KEYS)
//   clone(key)                        independent copy (keeps the shader hooks)
//   variant(key, {color, roughness, metalness, emissive, emissiveIntensity, opacity})  cached tinted copy
//   setWet(f)                         0..1 ground roughness / albedo darkening / puddles (asphalt, road, sidewalk, tactile, curb,
//                                     concrete, roadPaint*, stone, roof), distributed on up-facing ground by the after-rain
//                                     drying state (WET_STATE_FN: dry / damp film / standing water, world space, from
//                                     city.field + the macro noise; ?wetdbg=1 paints it red / green / blue)
//   setSoak(k)                        1 while it rains (weather.js): every surface filmed, low spots fill sooner
//   bindWetField(field), wetStateAt(x, z), wetStateShader   the state's inputs / CPU mirror / GLSL for other owners
//   makeEnvironment(renderer, mode)   'night'|'day'|'dusk' -> PMREM env texture from a procedural sky + neon cubemap scene
//   texture(name) / textureSet(name)  generated textures;  noiseTexture(opts) legacy helper (foundation API)
//   makeCanvas(w,h), canvasTexture(canvas, opts), scaleUV(geometry, su, sv)
//   shotPresets.materials_test / materials_day, selfTest()
import * as THREE from 'three';
import { fitCanvasTexture } from '../core/mobileProfile.js';

export const KEYS = [
  'asphalt', 'road', 'roadPaint', 'roadPaintYellow', 'concrete', 'sidewalk', 'paverRed', 'paverGrey', 'tactile', 'curb', 'brick',
  'tile', 'glass', 'glassNight', 'metal', 'chrome', 'paintSignalGrey', 'paintGuardrailWhite', 'paintPoleGreen', 'rubber',
  'plastic', 'wood', 'suit', 'shirt', 'cloth', 'skin', 'hair', 'shoes', 'leather', 'roof', 'stone', 'bronze', 'grass',
  'dark', 'white',
];

const mats = new Map();
const texs = new Map();
const sets = new Map();
const variants = new Map();
let anisotropyMax = 8;
let genMs = 0;

// shared shader uniforms (all ground/glass materials reference the same objects)
const U = {
  wet: { value: 0 },          // 0..1  from engine.time.wet
  night: { value: 1 },        // 0..1  from engine.time.night (lighting) - drives window emissive
  macro: { value: null },     // macro variation texture (world space)
  // after-rain drying state (see WET_STATE_GLSL): the city's carriageway distance field (metres, < 0 on the road)
  // as a half-float texture, its placement (xy = world xz of uv 0, z = 1 / size in metres, w = 1 when bound), and
  // soak = 1 while it is actually raining (every surface filmed, no dry patches)
  field: { value: null },
  fieldT: { value: new THREE.Vector4(0, 0, 1, 0) },
  soak: { value: 0 },
};

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function canvasTexture(canvas, { srgb = true, repeat = [1, 1], wrap = true, filter = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (wrap) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = anisotropyMax;
  t.generateMipmaps = filter;
  t.minFilter = filter ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return fitCanvasTexture(t, 'materials');   // [mobile] ?texmax: redrawn at the phone's cap, the full-size canvas let go
}

export function scaleUV(geometry, su, sv) {
  const uv = geometry.attributes.uv;
  if (!uv) return geometry;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geometry;
}

// ---------------------------------------------------------------------------------------------- noise / fields
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// tileable value-noise fbm, optionally anisotropic (fx, fy = lattice periods of the first octave)
function fbm(N, { fx = 4, fy = fx, oct = 5, gain = 0.5, lac = 2, seed = 1, ridged = false } = {}) {
  const res = new Float32Array(N * N);
  const sx = new Float32Array(N), sy = new Float32Array(N), ix0 = new Int32Array(N), iy0 = new Int32Array(N);
  let a = 1, sum = 0, ffx = fx, ffy = fy;
  for (let o = 0; o < oct; o++) {
    const px = Math.max(1, Math.round(ffx)), py = Math.max(1, Math.round(ffy));
    const lat = new Float32Array(px * py);
    for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) lat[j * px + i] = hash(i, j, seed * 17 + o * 131);
    for (let x = 0; x < N; x++) { const f = x * px / N, i = Math.floor(f), t = f - i; ix0[x] = i % px; sx[x] = t * t * (3 - 2 * t); }
    for (let y = 0; y < N; y++) { const f = y * py / N, i = Math.floor(f), t = f - i; iy0[y] = i % py; sy[y] = t * t * (3 - 2 * t); }
    for (let y = 0; y < N; y++) {
      const r0 = iy0[y] * px, r1 = ((iy0[y] + 1) % py) * px, ty = sy[y], row = y * N;
      for (let x = 0; x < N; x++) {
        const ix = ix0[x], ix1 = (ix + 1) % px, tx = sx[x];
        const v = (lat[r0 + ix] + (lat[r0 + ix1] - lat[r0 + ix]) * tx) * (1 - ty) + (lat[r1 + ix] + (lat[r1 + ix1] - lat[r1 + ix]) * tx) * ty;
        res[row + x] += (ridged ? 1 - Math.abs(v * 2 - 1) : v) * a;
      }
    }
    sum += a; a *= gain; ffx *= lac; ffy *= lac;
  }
  const inv = 1 / sum;
  for (let i = 0; i < res.length; i++) res[i] *= inv;
  return res;
}

// soft dots splatted with wrap-around (aggregate stones, pores, chips)
function splat(N, count, rMin, rMax, seed, { amp = 1, mask = null } = {}) {
  const f = new Float32Array(N * N), rnd = mulberry(seed), M = N - 1;
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(rnd() * N), cy = Math.floor(rnd() * N), r = rMin + rnd() * (rMax - rMin), a = amp * (0.5 + rnd() * 0.5);
    if (mask && mask[cy * N + cx] < rnd()) continue;
    const ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      if (d >= 1) continue;
      const k = ((cy + dy) & M) * N + ((cx + dx) & M), v = a * (1 - d * d);
      if (v > f[k]) f[k] = v;
    }
  }
  return f;
}

function blur(f, N, r) {
  if (r <= 0) return f;
  const tmp = new Float32Array(N * N), M = N - 1, w = 1 / (2 * r + 1);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; for (let k = -r; k <= r; k++) s += f[y * N + ((x + k) & M)]; tmp[y * N + x] = s * w; }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; for (let k = -r; k <= r; k++) s += tmp[((y + k) & M) * N + x]; f[y * N + x] = s * w; }
  return f;
}

// draws with a 2d context and returns the red channel as a 0..1 field; draw() is invoked 9x so shapes wrap
function canvasField(N, draw, { wrap = true } = {}) {
  const c = makeCanvas(N, N), ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, N, N);
  const offs = wrap ? [-N, 0, N] : [0];
  for (const oy of offs) for (const ox of offs) { ctx.save(); ctx.translate(ox, oy); draw(ctx); ctx.restore(); }
  const d = ctx.getImageData(0, 0, N, N).data, f = new Float32Array(N * N);
  for (let i = 0; i < f.length; i++) f[i] = d[i * 4] / 255;
  return f;
}

// random-walk crack polylines (with branches) in pixel space
function crackLines(N, count, seed, { step = 9, wobble = 0.9, len = [18, 60], branch = 0.12 } = {}) {
  const rnd = mulberry(seed), lines = [];
  const walk = (x, y, ang, n, depth) => {
    const pts = [[x, y]];
    for (let k = 0; k < n; k++) {
      ang += (rnd() - 0.5) * wobble; x += Math.cos(ang) * step; y += Math.sin(ang) * step; pts.push([x, y]);
      if (depth < 2 && rnd() < branch) walk(x, y, ang + (rnd() < 0.5 ? 1 : -1) * (0.7 + rnd() * 0.8), Math.floor(n * 0.4), depth + 1);
    }
    lines.push({ pts, depth });
  };
  for (let i = 0; i < count; i++) walk(rnd() * N, rnd() * N, rnd() * Math.PI * 2, Math.floor(len[0] + rnd() * (len[1] - len[0])), 0);
  return lines;
}
function strokeLines(ctx, lines, width, color, { depthScale = 0.7, filter = null } = {}) {
  ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const l of lines) {
    if (filter && !filter(l)) continue;
    ctx.lineWidth = width * Math.pow(depthScale, l.depth);
    ctx.beginPath(); ctx.moveTo(l.pts[0][0], l.pts[0][1]);
    for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i][0], l.pts[i][1]);
    ctx.stroke();
  }
}

// height field -> tangent-space normal map (OpenGL convention: +Y = up in the image = +v after flipY upload)
function normalCanvas(h, N, strength) {
  const c = makeCanvas(N, N), ctx = c.getContext('2d'), img = ctx.createImageData(N, N), d = img.data, M = N - 1;
  for (let y = 0; y < N; y++) {
    const yu = ((y - 1) & M) * N, yd = ((y + 1) & M) * N, r = y * N;
    for (let x = 0; x < N; x++) {
      const xl = (x - 1) & M, xr = (x + 1) & M;
      const gx = (h[r + xr] - h[r + xl]) * 2 + (h[yu + xr] - h[yu + xl]) + (h[yd + xr] - h[yd + xl]);
      const gy = (h[yd + x] - h[yu + x]) * 2 + (h[yd + xl] - h[yu + xl]) + (h[yd + xr] - h[yu + xr]);
      let nx = -gx * strength, ny = gy * strength, nz = 1;
      const il = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= il; ny *= il; nz *= il;
      const i = (r + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Builder: shade() fills albedo (sRGB 0..255), height, roughness, ao, metal per pixel; finish() bakes the maps.
class TexBuilder {
  constructor(N) {
    this.N = N; const n = N * N;
    this.rgb = new Uint8ClampedArray(n * 4); this.h = new Float32Array(n); this.r = new Float32Array(n);
    this.ao = new Float32Array(n).fill(1); this.m = new Float32Array(n);
    this.px = { r: 0, g: 0, b: 0, h: 0.5, rough: 0.8, ao: 1, metal: 0 };
  }
  shade(fn) {
    const N = this.N, p = this.px, rgb = this.rgb;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      p.h = 0.5; p.rough = 0.8; p.ao = 1; p.metal = 0;
      fn(x, y, i, p);
      const o = i * 4;
      rgb[o] = p.r; rgb[o + 1] = p.g; rgb[o + 2] = p.b; rgb[o + 3] = 255;
      this.h[i] = p.h; this.r[i] = clamp01(p.rough); this.ao[i] = clamp01(p.ao); this.m[i] = clamp01(p.metal);
    }
    return this;
  }
  finish({ name, normalStrength = 2, repeat = [1, 1], tile = null, blurHeight = 0, emissive = null }) {
    const N = this.N;
    const ac = makeCanvas(N, N), actx = ac.getContext('2d');
    actx.putImageData(new ImageData(this.rgb, N, N), 0, 0);
    const oc = makeCanvas(N, N), octx = oc.getContext('2d'), oi = octx.createImageData(N, N), od = oi.data;
    for (let i = 0; i < N * N; i++) { const o = i * 4; od[o] = this.ao[i] * 255; od[o + 1] = this.r[i] * 255; od[o + 2] = this.m[i] * 255; od[o + 3] = 255; }
    octx.putImageData(oi, 0, 0);
    if (blurHeight) blur(this.h, N, blurHeight);
    const set = {
      name, tile, size: N,
      map: canvasTexture(ac, { srgb: true, repeat }),
      orm: canvasTexture(oc, { srgb: false, repeat }),
      normal: canvasTexture(normalCanvas(this.h, N, normalStrength), { srgb: false, repeat }),
      emissive: emissive ? canvasTexture(emissive, { srgb: true, repeat }) : null,
    };
    for (const k of ['map', 'orm', 'normal', 'emissive']) if (set[k]) { set[k].name = `${name}_${k}`; texs.set(`${name}_${k}`, set[k]); }
    sets.set(name, set);
    return set;
  }
}

function timed(name, fn) {
  const t0 = performance.now();
  const r = fn();
  genMs += performance.now() - t0;
  return r;
}

// ---------------------------------------------------------------------------------------------- texture recipes
// [mobile] ?matTex=<px> (the phones' safe tier): the procedural sets are generated at that size — their pixel-unit
// details (gravel, cracks, joints) come out coarser, but a 1024² set is ~20 MB of scratch arrays before its first GC
const MAT_Q = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('matTex')) : 0;
const T1 = MAT_Q >= 128 ? Math.min(1024, MAT_Q) : 1024, T2 = T1 / 2;

function texAsphalt() {                                       // tile 6 m
  if (sets.has('asphalt')) return sets.get('asphalt');
  return timed('asphalt', () => {
    const N = T1, b = new TexBuilder(N);
    const micro = fbm(N, { fx: 128, oct: 3, gain: 0.55, seed: 11 });
    const wave = fbm(N, { fx: 3, oct: 3, seed: 12 });
    const grime = fbm(N, { fx: 6, oct: 4, gain: 0.55, seed: 13 });
    const oil = fbm(N, { fx: 5, oct: 2, seed: 16 });
    const stonesL = splat(N, 22000, 1.2, 3.0, 14);
    const stonesD = splat(N, 14000, 1.2, 2.6, 15);
    const lines = crackLines(N, 5, 17, { len: [34, 90], wobble: 0.5, step: 11, branch: 0.08 });
    const cracks = blur(canvasField(N, (ctx) => strokeLines(ctx, lines, 2.2, '#fff')), N, 1);
    const tar = blur(canvasField(N, (ctx) => strokeLines(ctx, lines, 9, '#fff', { filter: (l) => l.depth === 0 && hash(l.pts.length, 3, 5) < 0.5 })), N, 2);
    const patches = blur(canvasField(N, (ctx) => {
      const rnd = mulberry(18); ctx.fillStyle = '#fff';
      for (let i = 0; i < 3; i++) { ctx.save(); ctx.translate(rnd() * N, rnd() * N); ctx.rotate((rnd() - 0.5) * 0.3); ctx.fillRect(0, 0, 120 + rnd() * 260, 90 + rnd() * 200); ctx.restore(); }
    }), N, 3);
    b.shade((x, y, i, p) => {
      const mic = micro[i], sl = stonesL[i], sd = stonesD[i], cr = cracks[i], tr = tar[i], pt = patches[i];
      const oilK = smooth(0.58, 0.72, oil[i]);
      const ptEdge = pt * (1 - pt) * 4;                                 // soft rim of a repair patch
      p.h = 0.5 + (mic - 0.5) * 0.3 + (wave[i] - 0.5) * 0.25 + sl * 0.2 + sd * 0.16 - cr * 0.28 + tr * 0.12 + pt * 0.05;
      let v = 84 + (mic - 0.5) * 44 + (grime[i] - 0.5) * 30;
      v += sl * 56 - sd * 32;
      v *= 1 - cr * 0.6;
      v = mix(v, 26, tr * 0.85);
      v = mix(v, v * 0.72, pt);
      v -= ptEdge * 10;
      let r = v, g = v, bb = v + 3;
      if (oilK > 0) { r *= 1 - oilK * 0.12; g *= 1 - oilK * 0.06; bb *= 1 + oilK * 0.05; }
      p.r = r; p.g = g; p.b = bb;
      p.rough = 0.88 + (mic - 0.5) * 0.16 - sl * 0.14 - sd * 0.08 - tr * 0.28 - oilK * 0.25 + (grime[i] - 0.5) * 0.12 - pt * 0.06 + cr * 0.1;
      p.ao = 1 - cr * 0.5 - sd * 0.1;
    });
    return b.finish({ name: 'asphalt', normalStrength: 1.9, tile: [6, 6] });
  });
}

function texRoadPaint(yellow) {                               // uv-space, designed for a 6 x 0.45 m zebra bar (stretched)
  const name = yellow ? 'roadPaintYellow' : 'roadPaint';
  if (sets.has(name)) return sets.get(name);
  return timed(name, () => {
    const N = T2, b = new TexBuilder(N);
    const wear = fbm(N, { fx: 14, fy: 3, oct: 4, gain: 0.55, seed: yellow ? 93 : 91 });      // features ~0.6 m along, ~0.15 m across
    const fine = fbm(N, { fx: 96, fy: 12, oct: 2, seed: 92 });
    const dirt = fbm(N, { fx: 6, fy: 2, oct: 3, seed: 95 });
    const stones = splat(N, 9000, 0.9, 2.0, 94);
    const base = yellow ? [236, 190, 44] : [222, 220, 210];
    b.shade((x, y, i, p) => {
      const w = wear[i], f = fine[i], st = stones[i];
      const band = 0.66 + 0.34 * Math.cos((x / N) * Math.PI * 2 * 2);       // tyre tracks: two worn bands along the bar (u = along)
      const t = w * band + (f - 0.5) * 0.12 + 0.2;                        // paint thickness 0..1
      // thick paint is solid; thinning paint lets the aggregate tops poke through (speckle); bare zones keep paint
      // in the hollows between stones
      const solid = smooth(0.42, 0.6, t), thin = smooth(0.22, 0.42, t);
      const speck = st > 0.35 + 0.65 * solid ? 0 : 1;
      const cover = clamp01(mix(0.28 * (1 - st) * thin, speck, thin) * (1 - solid) + solid);
      const v = 74 + (f - 0.5) * 40 + st * 70;                          // asphalt showing through
      const dk = 1 - (dirt[i] - 0.5) * 0.18 - (1 - t) * 0.1;             // tyre grime on the paint
      p.r = mix(v, (base[0] + (f - 0.5) * 24) * dk, cover); p.g = mix(v, (base[1] + (f - 0.5) * 24) * dk, cover); p.b = mix(v + 3, (base[2] + (f - 0.5) * 24) * dk, cover);
      p.h = 0.5 + cover * 0.06 + st * 0.22 * (1 - cover) + (f - 0.5) * 0.04;
      p.rough = mix(0.86 - st * 0.12, 0.6 + (f - 0.5) * 0.16 + (1 - t) * 0.1, cover);
      p.ao = 1;
    });
    return b.finish({ name, normalStrength: 1.6 });
  });
}

function texSidewalk() {                                      // tile 4.8 m = 16 x 16 pavers of 300 mm
  if (sets.has('sidewalk')) return sets.get('sidewalk');
  return timed('sidewalk', () => {
    const N = T1, b = new TexBuilder(N), P = 16, cell = N / P, rnd = mulberry(61);
    const pav = [];
    for (let k = 0; k < P * P; k++) pav.push({ tint: (rnd() - 0.5) * 2, warm: (rnd() - 0.5), h: rnd() * 0.1, sx: (rnd() - 0.5) * 0.12, sy: (rnd() - 0.5) * 0.12, dark: rnd() < 0.07, light: rnd() < 0.05 });
    const micro = fbm(N, { fx: 160, oct: 2, seed: 62 });
    const dirt = fbm(N, { fx: 5, oct: 4, gain: 0.55, seed: 63 });
    const stain = fbm(N, { fx: 20, oct: 3, seed: 64 });
    const gum = canvasField(N, (ctx) => { const r2 = mulberry(65); ctx.fillStyle = '#fff'; for (let i = 0; i < 70; i++) { ctx.beginPath(); ctx.arc(r2() * N, r2() * N, 2.5 + r2() * 3, 0, 7); ctx.fill(); } });
    const chips = splat(N, 900, 1.5, 4, 66);
    b.shade((x, y, i, p) => {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), pv = pav[cy * P + cx];
      const u = x - cx * cell, v = y - cy * cell;
      const dj = Math.min(u, cell - 1 - u, v, cell - 1 - v);
      const bevel = smooth(1.5, 4.5, dj), mic = micro[i], dt = dirt[i];
      const paverH = 0.42 + pv.h + pv.sx * (u / cell - 0.5) + pv.sy * (v / cell - 0.5) + (mic - 0.5) * 0.07 - chips[i] * 0.3;
      p.h = mix(0.2 + (mic - 0.5) * 0.08, paverH, bevel);
      let val = 158 + pv.tint * 9 + (mic - 0.5) * 20 + (dt - 0.5) * 30 + (stain[i] - 0.5) * 10;
      if (pv.dark) val *= 0.82; if (pv.light) val *= 1.1;
      val = mix(92 + (mic - 0.5) * 24, val, bevel);
      const g = gum[i];
      val = mix(val, 40, g);
      p.r = val + pv.warm * 6 + 2; p.g = val + pv.warm * 3; p.b = val - pv.warm * 4 - 4;
      p.rough = mix(0.95, 0.76 + (mic - 0.5) * 0.15 + (dt - 0.5) * 0.12 + chips[i] * 0.1, bevel);
      p.rough = mix(p.rough, 0.5, g);
      p.ao = mix(0.6, 1, bevel);
    });
    return b.finish({ name: 'sidewalk', normalStrength: 2.4, tile: [4.8, 4.8] });
  });
}

// 90° herringbone of 200 x 100 mm interlocking blocks (Center-gai / plaza paving). Lattice a=(-1,1), b=(2,2) in
// block-width units -> period 4 x 4 units = 0.4 m; the texture covers 1.6 m so per-copy tints differ.
function texPaver(name, seed, palette) {
  if (sets.has(name)) return sets.get(name);
  return timed(name, () => {
    const N = T1, b = new TexBuilder(N), unit = 64, P = unit * 4, jointW = 0.045;
    const id = new Int16Array(P * P), edge = new Float32Array(P * P);
    for (let i = -8; i <= 8; i++) for (let j = -4; j <= 4; j++) {
      const tx = -i + 2 * j, ty = i + 2 * j;
      const blocks = [[tx, ty, 2, 1, 0], [tx + 2, ty, 1, 2, 1]];
      for (const [bx, by, bw, bh, o] of blocks) {
        const key = ((bx % 4 + 4) % 4) * 8 + ((by % 4 + 4) % 4) * 2 + o + 1;
        for (let py = Math.floor(by * unit); py < (by + bh) * unit; py++) for (let px = Math.floor(bx * unit); px < (bx + bw) * unit; px++) {
          const wx = ((px % P) + P) % P, wy = ((py % P) + P) % P;
          const lx = (px - bx * unit) / unit, ly = (py - by * unit) / unit;
          id[wy * P + wx] = key; edge[wy * P + wx] = Math.min(lx, bw - lx, ly, bh - ly);
        }
      }
    }
    const micro = fbm(N, { fx: 170, oct: 2, seed });
    const dirt = fbm(N, { fx: 5, oct: 4, gain: 0.55, seed: seed + 1 });
    const chips = splat(N, 700, 1.5, 3.5, seed + 2);
    const gum = canvasField(N, (ctx) => { const r2 = mulberry(seed + 3); ctx.fillStyle = '#fff'; for (let i = 0; i < 50; i++) { ctx.beginPath(); ctx.arc(r2() * N, r2() * N, 2 + r2() * 3, 0, 7); ctx.fill(); } });
    b.shade((x, y, i, p) => {
      const k = id[(y % P) * P + (x % P)], e = edge[(y % P) * P + (x % P)];
      const t = hash(Math.floor(x / P) * 31 + k, Math.floor(y / P) * 17, seed);
      const bevel = smooth(jointW, jointW + 0.06, e), mic = micro[i], dt = dirt[i];
      const pal = palette[Math.floor(t * palette.length)];
      p.h = mix(0.22 + (mic - 0.5) * 0.06, 0.5 + (t - 0.5) * 0.08 + (mic - 0.5) * 0.08 - chips[i] * 0.3, bevel);
      const m = 1 + (hash(k, 5, seed + t * 100) - 0.5) * 0.2 + (mic - 0.5) * 0.18 + (dt - 0.5) * 0.28 - chips[i] * 0.2;
      const jv = 88 + (mic - 0.5) * 24;
      p.r = mix(jv, pal[0] * m, bevel); p.g = mix(jv, pal[1] * m, bevel); p.b = mix(jv - 4, pal[2] * m, bevel);
      const g = gum[i];
      p.r = mix(p.r, 40, g); p.g = mix(p.g, 40, g); p.b = mix(p.b, 38, g);
      p.rough = mix(0.95, 0.72 + (mic - 0.5) * 0.15 + (dt - 0.5) * 0.12, bevel);
      p.rough = mix(p.rough, 0.5, g);
      p.ao = mix(0.6, 1 - chips[i] * 0.2, bevel);
    });
    return b.finish({ name, normalStrength: 2.2, tile: [1.6, 1.6] });
  });
}

function texTactile() {                                       // tile 1.2 m = 4 x 4 blocks of 300 mm with 5 x 5 domes
  if (sets.has('tactile')) return sets.get('tactile');
  return timed('tactile', () => {
    const N = T1, b = new TexBuilder(N), P = 4, cell = N / P, pitch = cell / 5, R = cell * 0.037, rnd = mulberry(71);
    const tint = []; for (let k = 0; k < P * P; k++) tint.push((rnd() - 0.5) * 12);
    const micro = fbm(N, { fx: 140, oct: 2, seed: 72 });
    const dirt = fbm(N, { fx: 6, oct: 4, seed: 73 });
    b.shade((x, y, i, p) => {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), u = x - cx * cell, v = y - cy * cell;
      const dj = Math.min(u, cell - 1 - u, v, cell - 1 - v), bevel = smooth(1.5, 4, dj);
      const du = ((u + pitch * 0.5) % pitch) - pitch * 0.5, dv = ((v + pitch * 0.5) % pitch) - pitch * 0.5;
      const d = Math.sqrt(du * du + dv * dv) / R;
      const dome = d < 1 ? Math.pow(1 - d * d, 0.6) : 0;
      const top = smooth(0.6, 1, dome), mic = micro[i], dt = dirt[i];
      p.h = mix(0.25, 0.45 + dome * 0.45 + (mic - 0.5) * 0.05, bevel);
      const dirtK = (dt - 0.5) * 0.35 + (1 - dome) * 0.12;
      let r = 234 + tint[cy * P + cx], g = 188 + tint[cy * P + cx] * 0.7, bb = 36;
      r = mix(r, 246, top * 0.6); g = mix(g, 222, top * 0.6); bb = mix(bb, 130, top * 0.6);
      const k = 1 - dirtK * 0.9 - (1 - bevel) * 0.5;
      p.r = r * k + (mic - 0.5) * 12; p.g = g * k + (mic - 0.5) * 12; p.b = bb * k + (mic - 0.5) * 8;
      p.rough = mix(0.95, 0.72 + (mic - 0.5) * 0.1 + dirtK * 0.2 - top * 0.3, bevel);
      p.ao = mix(0.65, 1 - (1 - dome) * 0.08, bevel);
    });
    return b.finish({ name: 'tactile', normalStrength: 2.2, tile: [1.2, 1.2] });
  });
}

function texGranite(name, seed, polished) {                  // curb: tile 1 m honed;  stone: tile 1.2 m = 2 x 2 polished 600 mm slabs
  if (sets.has(name)) return sets.get(name);
  return timed(name, () => {
    const N = T2, b = new TexBuilder(N), cell = N / 2, rnd = mulberry(seed + 9);
    const slabs = []; for (let k = 0; k < 4; k++) slabs.push({ tint: (rnd() - 0.5) * 16, h: (rnd() - 0.5) * 0.04 });
    const grain = fbm(N, { fx: 90, oct: 3, gain: 0.6, seed });
    const grain2 = fbm(N, { fx: 160, oct: 2, seed: seed + 1 });
    const low = fbm(N, { fx: 4, oct: 3, seed: seed + 2 });
    const chips = polished ? null : splat(N, 400, 1, 3, seed + 3);
    const wear = polished ? fbm(N, { fx: 6, oct: 3, seed: seed + 4 }) : null;
    b.shade((x, y, i, p) => {
      const g = grain[i], g2 = grain2[i];
      const tone = polished ? (g < 0.42 ? 78 : g > 0.6 ? (g2 > 0.5 ? 178 : 146) : 128) : (g < 0.42 ? 104 : g > 0.6 ? (g2 > 0.5 ? 160 : 142) : 128);   // quartz / feldspar / mica grains
      let v = tone + (g2 - 0.5) * (polished ? 20 : 12) + (low[i] - 0.5) * 18;
      const ch = chips ? chips[i] : 0;
      v *= 1 - ch * 0.25;
      let bevel = 1;
      if (polished) {                                                        // slab joints + per-slab tint
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell), u = x - cx * cell, w = y - cy * cell, s = slabs[cy * 2 + cx];
        bevel = smooth(1, 3.5, Math.min(u, cell - 1 - u, w, cell - 1 - w));
        v = mix(70 + (g2 - 0.5) * 20, v + s.tint, bevel);
      }
      p.r = v * 1.02; p.g = v; p.b = v * 0.97;
      p.h = mix(0.3, 0.5 + (g2 - 0.5) * 0.16 + (g - 0.5) * 0.08 - ch * 0.3 + (polished ? slabs[0].h : 0), bevel);
      p.rough = polished ? mix(0.9, 0.24 + (g2 - 0.5) * 0.08 + smooth(0.55, 0.8, wear[i]) * 0.3, bevel) : 0.62 + (g2 - 0.5) * 0.15 + ch * 0.2;
      p.ao = mix(0.7, 1 - ch * 0.3, bevel);
    });
    return b.finish({ name, normalStrength: polished ? 1.2 : 1.4, tile: polished ? [1.2, 1.2] : [1, 1] });
  });
}

function texConcrete() {                                      // tile 3.6 m: 4 x 2 formwork panels of 0.9 x 1.8 m
  if (sets.has('concrete')) return sets.get('concrete');
  return timed('concrete', () => {
    const N = T1, b = new TexBuilder(N), PW = N / 4, PH = N / 2, rnd = mulberry(31);
    const panel = []; for (let k = 0; k < 8; k++) panel.push({ h: (rnd() - 0.5) * 0.06, tint: (rnd() - 0.5) * 10 });
    const micro = fbm(N, { fx: 96, oct: 3, gain: 0.55, seed: 32 });
    const blotch = fbm(N, { fx: 4, oct: 4, gain: 0.55, seed: 33 });
    const pores = splat(N, 2600, 1, 2.4, 34);
    const ties = [];
    for (let py = 0; py < 2; py++) for (let px = 0; px < 4; px++) for (const fx of [0.17, 0.83]) for (const fy of [0.16, 0.84]) ties.push([px * PW + fx * PW, py * PH + fy * PH]);
    const tie = new Float32Array(N * N), M = N - 1;
    for (const [tx, ty] of ties) for (let dy = -16; dy <= 16; dy++) for (let dx = -16; dx <= 16; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy) / 14; if (d >= 1) continue;
      tie[((Math.round(ty) + dy) & M) * N + ((Math.round(tx) + dx) & M)] = smooth(1, 0.7, d);
    }
    const drips = blur(canvasField(N, (ctx) => {
      const r2 = mulberry(35);
      for (const [tx, ty] of ties) {
        if (r2() < 0.35) continue;
        const len = 60 + r2() * 260, w = 10 + r2() * 14;
        const g = ctx.createLinearGradient(0, ty, 0, ty + len); g.addColorStop(0, 'rgba(255,255,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(tx - w / 2, ty, w, len);
      }
      for (let i = 0; i < 30; i++) {                                          // streaks from the panel joints above
        const x = r2() * N, y0 = Math.floor(r2() * 2) * PH, len = 80 + r2() * 300, w = 4 + r2() * 10;
        const g = ctx.createLinearGradient(0, y0, 0, y0 + len); g.addColorStop(0, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(x - w / 2, y0, w, len);
      }
    }), N, 2);
    b.shade((x, y, i, p) => {
      const px = Math.floor(x / PW), py = Math.floor(y / PH), pn = panel[py * 4 + px];
      const u = x - px * PW, v = y - py * PH;
      const dj = Math.min(u, PW - 1 - u, v, PH - 1 - v), bevel = smooth(1, 3.5, dj);
      const mic = micro[i], bl = blotch[i], t = tie[i], dr = drips[i], po = pores[i];
      p.h = mix(0.3, 0.5 + pn.h + (mic - 0.5) * 0.1 - po * 0.35 - t * 0.7, bevel);
      let val = 160 + pn.tint + (mic - 0.5) * 16 + (bl - 0.5) * 34;
      val *= 1 - dr * 0.32 - t * 0.55 - po * 0.35;
      val = mix(val * 0.62, val, bevel);
      p.r = val + 2; p.g = val + 1; p.b = val - 4 + bl * 6;
      p.rough = 0.9 + (mic - 0.5) * 0.12 - bl * 0.06 + t * 0.05 - dr * 0.05;
      p.ao = mix(0.6, 1 - t * 0.5 - po * 0.2, bevel);
    });
    return b.finish({ name: 'concrete', normalStrength: 2.0, tile: [3.6, 3.6] });
  });
}

function texBrick() {                                         // tile 1.76 m: 8 bricks x 25 courses (210 x 60 + 10 mm joints)
  if (sets.has('brick')) return sets.get('brick');
  return timed('brick', () => {
    const N = T1, b = new TexBuilder(N), cols = 8, rows = 25, bw = N / cols, bh = N / rows, joint = 5, rnd = mulberry(81);
    const bricks = new Map();
    const brickAt = (c, r) => { const k = r * 64 + ((c % cols) + cols) % cols; let v = bricks.get(k); if (!v) { const t = rnd(); v = { tint: t, dark: rnd() < 0.12, h: (rnd() - 0.5) * 0.1 }; bricks.set(k, v); } return v; };
    const micro = fbm(N, { fx: 200, oct: 2, seed: 82 });
    const low = fbm(N, { fx: 5, oct: 3, seed: 83 });
    const chips = splat(N, 700, 1.5, 4, 84);
    b.shade((x, y, i, p) => {
      const r = Math.floor(y / bh), off = (r % 2) * bw * 0.5;
      const xs = x + off, c = Math.floor(xs / bw), u = xs - c * bw, v = y - r * bh;
      const dj = Math.min(u, bw - 1 - u, v, bh - 1 - v) - joint * 0.5;
      const bevel = smooth(0, 3, dj), br = brickAt(c, r), mic = micro[i], ch = chips[i];
      p.h = mix(0.28 + (mic - 0.5) * 0.06, 0.55 + br.h + (mic - 0.5) * 0.1 - ch * 0.35, bevel);
      const t = br.tint;
      let rr = 150 + t * 40 - (br.dark ? 45 : 0), gg = 78 + t * 22 - (br.dark ? 22 : 0), bb = 58 + t * 10 - (br.dark ? 12 : 0);
      const k = 1 + (mic - 0.5) * 0.25 + (low[i] - 0.5) * 0.2 - ch * 0.25;
      rr *= k; gg *= k; bb *= k;
      const mv = 182 + (mic - 0.5) * 40 + (low[i] - 0.5) * 30;
      p.r = mix(mv, rr, bevel); p.g = mix(mv - 4, gg, bevel); p.b = mix(mv - 12, bb, bevel);
      p.rough = mix(0.95, 0.9 + (mic - 0.5) * 0.1 + ch * 0.1, bevel);
      p.ao = mix(0.62, 1 - ch * 0.2, bevel);
    });
    return b.finish({ name: 'brick', normalStrength: 2.2, tile: [1.76, 1.76] });
  });
}

function texTile() {                                          // tile 1.2 m: 8 x 8 glossy white 150 mm tiles
  if (sets.has('tile')) return sets.get('tile');
  return timed('tile', () => {
    const N = T1, b = new TexBuilder(N), P = 8, cell = N / P, rnd = mulberry(101);
    const tiles = []; for (let k = 0; k < P * P; k++) tiles.push({ tint: (rnd() - 0.5) * 8, h: (rnd() - 0.5) * 0.04, cream: rnd() < 0.15 });
    const micro = fbm(N, { fx: 200, oct: 2, seed: 102 });
    const grime = fbm(N, { fx: 3, oct: 4, gain: 0.5, seed: 103 });
    b.shade((x, y, i, p) => {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), tl = tiles[cy * P + cx];
      const u = x - cx * cell, v = y - cy * cell;
      const dj = Math.min(u, cell - 1 - u, v, cell - 1 - v) - 2;
      const bevel = smooth(0, 4, dj), mic = micro[i], gr = grime[i];
      p.h = mix(0.3, 0.55 + tl.h + (mic - 0.5) * 0.015, bevel);
      let val = 232 + tl.tint + (mic - 0.5) * 6 - gr * 14 - (1 - bevel) * 4;
      const gv = 172 + (mic - 0.5) * 30 - gr * 30;
      p.r = mix(gv, val, bevel) + (tl.cream ? 3 : 0); p.g = mix(gv, val - 1, bevel) + (tl.cream ? 1 : 0); p.b = mix(gv - 6, val - 6, bevel) - (tl.cream ? 6 : 0);
      p.rough = mix(0.85, 0.2 + (mic - 0.5) * 0.06 + gr * 0.12, bevel);
      p.ao = mix(0.7, 1, bevel);
    });
    return b.finish({ name: 'tile', normalStrength: 1.6, tile: [1.2, 1.2] });
  });
}

function texGlass() {                                         // tile 7.2 m: 4 bays of 1.8 m x 2 storeys of 3.6 m (0.9 m spandrel)
  if (sets.has('glass')) return sets.get('glass');
  return timed('glass', () => {
    const N = T1, b = new TexBuilder(N), bays = 4, storeys = 2, BW = N / bays, SH = N / storeys, spandrel = SH * 0.25, mull = 11, rnd = mulberry(41);
    const panes = []; for (let k = 0; k < bays * storeys; k++) panes.push({ tint: (rnd() - 0.5) * 12, bow: (rnd() - 0.5) * 0.12 });
    const streaks = fbm(N, { fx: 24, fy: 2, oct: 3, seed: 42 });
    const micro = fbm(N, { fx: 120, oct: 2, seed: 43 });
    // emissive: lit interiors (ceiling light band, blinds, desk glow); the shader hashes on/off per pane in world space
    const ec = makeCanvas(N, N), ectx = ec.getContext('2d');
    ectx.fillStyle = '#000'; ectx.fillRect(0, 0, N, N);
    const r2 = mulberry(44);
    for (let s = 0; s < storeys; s++) for (let bIdx = 0; bIdx < bays; bIdx++) {
      const x0 = bIdx * BW + mull, x1 = (bIdx + 1) * BW - mull;
      const yTop = N - (s + 1) * SH + mull, yBot = N - s * SH - spandrel - mull;     // canvas y down; storey s=0 at the bottom
      const warm = r2() < 0.6;
      const c = warm ? [255, 222, 168] : [214, 232, 255];
      const g = ectx.createLinearGradient(0, yTop, 0, yBot);
      g.addColorStop(0, `rgb(${c[0]},${c[1]},${c[2]})`); g.addColorStop(0.18, `rgb(${c[0] * 0.75 | 0},${c[1] * 0.75 | 0},${c[2] * 0.75 | 0})`); g.addColorStop(1, `rgb(${c[0] * 0.28 | 0},${c[1] * 0.3 | 0},${c[2] * 0.34 | 0})`);
      ectx.fillStyle = g; ectx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
      const style = r2();
      if (style < 0.35) {                                                             // blinds
        ectx.fillStyle = 'rgba(0,0,0,0.55)';
        for (let yy = yTop + 6; yy < yBot; yy += 9) ectx.fillRect(x0, yy, x1 - x0, 4);
      } else if (style < 0.6) {                                                       // furniture / partitions silhouettes
        ectx.fillStyle = 'rgba(0,0,0,0.6)';
        const n = 2 + Math.floor(r2() * 3);
        for (let k = 0; k < n; k++) { const w = 20 + r2() * 60, h = 30 + r2() * 90; ectx.fillRect(x0 + r2() * (x1 - x0 - w), yBot - h, w, h); }
        ectx.fillStyle = 'rgba(120,200,255,0.9)';
        if (r2() < 0.5) ectx.fillRect(x0 + r2() * (x1 - x0 - 30), yBot - 90, 26, 18);   // a monitor
      } else if (style < 0.72) {                                                      // ceiling light fixtures only
        ectx.fillStyle = 'rgba(0,0,0,0.5)'; ectx.fillRect(x0, yTop + 22, x1 - x0, yBot - yTop - 22);
        ectx.fillStyle = 'rgb(255,255,240)'; for (let xx = x0 + 20; xx < x1 - 20; xx += 70) ectx.fillRect(xx, yTop + 4, 40, 8);
      }
    }
    b.shade((x, y, i, p) => {
      const bIdx = Math.floor(x / BW), s = Math.floor((N - 1 - y) / SH), pn = panes[s * bays + bIdx];
      const u = x - bIdx * BW, vFromBottom = (N - 1 - y) - s * SH;
      const inMullX = u < mull || u >= BW - mull;
      const inTransom = vFromBottom < mull || vFromBottom >= SH - mull || Math.abs(vFromBottom - spandrel) < mull * 0.5;
      const inSpandrel = vFromBottom < spandrel;
      const mic = micro[i], st = streaks[i];
      if (inMullX || inTransom) {
        p.r = 58; p.g = 60; p.b = 64; p.h = 0.75; p.rough = 0.45 + (mic - 0.5) * 0.1; p.metal = 0.75; p.ao = 0.9;
      } else if (inSpandrel) {
        p.r = 40 + (mic - 0.5) * 6; p.g = 44 + (mic - 0.5) * 6; p.b = 52; p.h = 0.5; p.rough = 0.38 + (mic - 0.5) * 0.08; p.metal = 0.6;
      } else {
        const pu = (u - mull) / (BW - 2 * mull) - 0.5, pv = (vFromBottom - spandrel) / (SH - spandrel) - 0.5;
        const bow = (1 - 4 * (pu * pu + pv * pv)) * pn.bow;
        p.r = 92 + pn.tint * 0.5; p.g = 112 + pn.tint * 0.7; p.b = 134 + pn.tint;
        p.h = 0.5 + bow + (mic - 0.5) * 0.004;
        p.rough = 0.05 + smooth(0.55, 0.85, st) * 0.2 + (mic - 0.5) * 0.02;
        p.metal = 0.92; p.ao = 1;
      }
    });
    return b.finish({ name: 'glass', normalStrength: 1.2, tile: [7.2, 7.2], emissive: ec });
  });
}

function texBrushed() {                                       // uv-space brushed aluminium
  if (sets.has('metal')) return sets.get('metal');
  return timed('metal', () => {
    const N = T2, b = new TexBuilder(N);
    const streak = fbm(N, { fx: 2, fy: 256, oct: 3, gain: 0.55, seed: 51 });
    const scuff = fbm(N, { fx: 9, oct: 3, seed: 52 });
    b.shade((x, y, i, p) => {
      const s = streak[i], sc = scuff[i];
      const v = 176 + (s - 0.5) * 34 + (sc - 0.5) * 10;
      p.r = v; p.g = v + 1; p.b = v + 4;
      p.h = 0.5 + (s - 0.5) * 0.12;
      p.rough = 0.36 + (s - 0.5) * 0.25 + (sc - 0.5) * 0.12;
      p.metal = 1; p.ao = 1;
    });
    return b.finish({ name: 'metal', normalStrength: 0.9, repeat: [2, 2] });
  });
}

function texOrangePeel() {                                    // shared micro normal for painted metal / plastic / rubber
  if (sets.has('orangePeel')) return sets.get('orangePeel');
  return timed('orangePeel', () => {
    const N = 256, b = new TexBuilder(N);
    const f = fbm(N, { fx: 40, oct: 2, seed: 141 });
    const dust = fbm(N, { fx: 6, oct: 3, seed: 142 });
    b.shade((x, y, i, p) => { const v = 255; p.r = v; p.g = v; p.b = v; p.h = 0.5 + (f[i] - 0.5) * 0.3; p.rough = 0.42 + (f[i] - 0.5) * 0.1 + (dust[i] - 0.5) * 0.15; p.metal = 1; });
    return b.finish({ name: 'orangePeel', normalStrength: 0.5, repeat: [4, 4] });
  });
}

function texWood() {                                          // tile 1.2 m: 10 planks of 120 mm, grain along v
  if (sets.has('wood')) return sets.get('wood');
  return timed('wood', () => {
    const N = T1, b = new TexBuilder(N), planks = 10, pw = N / planks, rnd = mulberry(151);
    const pl = []; for (let k = 0; k < planks; k++) pl.push({ tint: (rnd() - 0.5) * 30, hue: (rnd() - 0.5) * 12, off: rnd() * 40, h: (rnd() - 0.5) * 0.08 });
    const grain = fbm(N, { fx: 3, fy: 60, oct: 4, gain: 0.55, seed: 152 });
    const fine = fbm(N, { fx: 220, fy: 40, oct: 2, seed: 153 });
    const knots = canvasField(N, (ctx) => { const r2 = mulberry(154); for (let i = 0; i < 7; i++) { const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, '#fff'); g.addColorStop(0.5, '#aaa'); g.addColorStop(1, '#000'); ctx.save(); ctx.translate(r2() * N, r2() * N); ctx.scale(10 + r2() * 12, 18 + r2() * 26); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, 7); ctx.fill(); ctx.restore(); } });
    b.shade((x, y, i, p) => {
      const c = Math.floor(x / pw), u = x - c * pw, k = pl[c];
      const dj = Math.min(u, pw - 1 - u) - 1.5, bevel = smooth(0, 3, dj);
      const g = grain[i], f = fine[i], kn = knots[i];
      const ring = 0.5 + 0.5 * Math.sin((g * 14 + x * 0.03 + k.off) * Math.PI);
      const band = Math.pow(ring, 3);
      p.h = mix(0.3, 0.5 + k.h - band * 0.08 + (f - 0.5) * 0.05 - kn * 0.1, bevel);
      let rr = 142 + k.tint + k.hue, gg = 96 + k.tint * 0.8, bb = 56 + k.tint * 0.5 - k.hue * 0.5;
      const m = (1 - band * 0.28 - kn * 0.45 + (f - 0.5) * 0.12);
      rr *= m; gg *= m; bb *= m;
      p.r = mix(40, rr, bevel); p.g = mix(28, gg, bevel); p.b = mix(18, bb, bevel);
      p.rough = mix(0.9, 0.5 + band * 0.18 + (f - 0.5) * 0.1 + kn * 0.1, bevel);
      p.ao = mix(0.55, 1, bevel);
    });
    return b.finish({ name: 'wood', normalStrength: 1.6, repeat: [1, 1] });
  });
}

function texWeave(name, seed, period, amp, base, fibre) {    // fabric: regular weave + fibre noise, uv-space
  if (sets.has(name)) return sets.get(name);
  return timed(name, () => {
    const N = T2, b = new TexBuilder(N);
    const f = fbm(N, { fx: 180, oct: 2, seed });
    const low = fbm(N, { fx: 6, oct: 3, seed: seed + 1 });
    const k = (Math.PI * 2) / period;
    b.shade((x, y, i, p) => {
      const w = Math.sin(x * k) * Math.sin(y * k);
      const tw = 0.5 + 0.5 * Math.sin(x * k * 0.5 + y * k * 0.5);
      p.h = 0.5 + w * amp + (tw - 0.5) * amp * 0.6 + (f[i] - 0.5) * 0.06;
      const m = 1 + (f[i] - 0.5) * fibre + (low[i] - 0.5) * 0.08 + w * 0.05;
      p.r = base[0] * m; p.g = base[1] * m; p.b = base[2] * m;
      p.rough = 0.85 + (f[i] - 0.5) * 0.1 - Math.abs(w) * 0.08;
    });
    return b.finish({ name, normalStrength: 1.2, repeat: [6, 6] });
  });
}

function texSkin() {
  if (sets.has('skin')) return sets.get('skin');
  return timed('skin', () => {
    const N = T2, b = new TexBuilder(N);
    const pores = splat(N, 5000, 0.8, 1.8, 161);
    const cells = fbm(N, { fx: 90, oct: 2, seed: 162 });
    const mottle = fbm(N, { fx: 10, oct: 3, seed: 163 });
    b.shade((x, y, i, p) => {
      const po = pores[i], m = mottle[i], c = cells[i];
      p.h = 0.5 - po * 0.35 + (c - 0.5) * 0.08;
      p.r = 206 + (m - 0.5) * 18; p.g = 156 + (m - 0.5) * 10 - po * 6; p.b = 126 + (m - 0.5) * 6 - po * 8;
      p.rough = 0.56 + po * 0.25 + (c - 0.5) * 0.1 + (m - 0.5) * 0.08;
    });
    return b.finish({ name: 'skin', normalStrength: 0.7, repeat: [3, 3] });
  });
}

function texHair() {
  if (sets.has('hair')) return sets.get('hair');
  return timed('hair', () => {
    const N = T2, b = new TexBuilder(N);
    const strands = fbm(N, { fx: 1, fy: 320, oct: 3, gain: 0.6, seed: 171 });
    const strands2 = fbm(N, { fx: 2, fy: 90, oct: 2, seed: 172 });
    b.shade((x, y, i, p) => {
      const s = strands[i], s2 = strands2[i];
      p.h = 0.5 + (s - 0.5) * 0.4 + (s2 - 0.5) * 0.2;
      const v = 1 + (s - 0.5) * 0.9;
      p.r = 30 * v; p.g = 22 * v; p.b = 16 * v;
      p.rough = 0.58 + (s - 0.5) * 0.3;
    });
    return b.finish({ name: 'hair', normalStrength: 1.0, repeat: [2, 2] });
  });
}

function texLeather(name, seed, base, rough) {
  if (sets.has(name)) return sets.get(name);
  return timed(name, () => {
    const N = 256, b = new TexBuilder(N);
    const g = fbm(N, { fx: 60, oct: 3, gain: 0.6, seed });
    const cr = splat(N, 900, 1, 2.2, seed + 1);
    b.shade((x, y, i, p) => {
      p.h = 0.5 + (g[i] - 0.5) * 0.3 - cr[i] * 0.25;
      const m = 1 + (g[i] - 0.5) * 0.2;
      p.r = base[0] * m; p.g = base[1] * m; p.b = base[2] * m;
      p.rough = rough + (g[i] - 0.5) * 0.15 + cr[i] * 0.1;
    });
    return b.finish({ name, normalStrength: 0.9, repeat: [3, 3] });
  });
}

function texRoof() {                                          // tile 4 m: bitumen / concrete roof with puddles and rust streaks
  if (sets.has('roof')) return sets.get('roof');
  return timed('roof', () => {
    const N = T2, b = new TexBuilder(N);
    const f = fbm(N, { fx: 24, oct: 4, gain: 0.55, seed: 111 });
    const low = fbm(N, { fx: 3, oct: 3, seed: 112 });
    const rust = fbm(N, { fx: 6, fy: 40, oct: 3, seed: 113 });
    b.shade((x, y, i, p) => {
      const rk = smooth(0.6, 0.75, rust[i]);
      let v = 88 + (f[i] - 0.5) * 30 + (low[i] - 0.5) * 24;
      p.h = 0.5 + (f[i] - 0.5) * 0.2 + (low[i] - 0.5) * 0.2;
      p.r = mix(v, 110, rk); p.g = mix(v, 68, rk); p.b = mix(v + 2, 40, rk);
      p.rough = 0.92 + (f[i] - 0.5) * 0.1 - (low[i] - 0.5) * 0.15;
    });
    return b.finish({ name: 'roof', normalStrength: 1.4, tile: [4, 4] });
  });
}

function texBronze() {
  if (sets.has('bronze')) return sets.get('bronze');
  return timed('bronze', () => {
    const N = T2, b = new TexBuilder(N);
    const pat = fbm(N, { fx: 7, oct: 4, gain: 0.55, seed: 121 });
    const f = fbm(N, { fx: 90, oct: 2, seed: 122 });
    b.shade((x, y, i, p) => {
      const k = smooth(0.5, 0.7, pat[i]);                     // green patina in recesses
      p.r = mix(122, 74, k) + (f[i] - 0.5) * 20; p.g = mix(88, 112, k) + (f[i] - 0.5) * 16; p.b = mix(46, 92, k) + (f[i] - 0.5) * 10;
      p.h = 0.5 + (f[i] - 0.5) * 0.15;
      p.rough = mix(0.42, 0.8, k) + (f[i] - 0.5) * 0.1; p.metal = mix(0.95, 0.35, k);
    });
    return b.finish({ name: 'bronze', normalStrength: 0.8, repeat: [2, 2] });
  });
}

function texGrass() {
  if (sets.has('grass')) return sets.get('grass');
  return timed('grass', () => {
    const N = T2, b = new TexBuilder(N);
    const f = fbm(N, { fx: 60, oct: 3, gain: 0.6, seed: 131 });
    const low = fbm(N, { fx: 4, oct: 3, seed: 132 });
    const blades = fbm(N, { fx: 200, fy: 40, oct: 2, seed: 133 });
    b.shade((x, y, i, p) => {
      const g = f[i], l = low[i], bl = blades[i];
      p.h = 0.5 + (bl - 0.5) * 0.4 + (g - 0.5) * 0.2;
      p.r = 62 + (g - 0.5) * 40 + (l - 0.5) * 30; p.g = 104 + (g - 0.5) * 50 + (l - 0.5) * 36 + (bl - 0.5) * 20; p.b = 40 + (g - 0.5) * 20;
      p.rough = 1;
    });
    return b.finish({ name: 'grass', normalStrength: 1.4, tile: [2, 2] });
  });
}

// macro variation: R brightness, G puddle field, B grime (sampled in world space; RepeatWrapping)
let macroCPU = null;
// ?wetdbg=1 paints the after-rain state onto the ground as emission: red dry, green damp film, blue standing water
const WET_DBG = typeof location !== 'undefined' && /[?&]wetdbg=1/.test(location.search);
function texMacro() {
  if (texs.has('macro')) return texs.get('macro');
  return timed('macro', () => {
    const N = T2, c = makeCanvas(N, N), ctx = c.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
    const bright = fbm(N, { fx: 3, oct: 5, gain: 0.55, seed: 201 });
    const pud = fbm(N, { fx: 9, oct: 4, gain: 0.5, seed: 202 });          // puddles 1-4 m at the 0.02 macro scale
    const pud2 = fbm(N, { fx: 23, oct: 3, gain: 0.5, seed: 204 });
    const grime = fbm(N, { fx: 4, oct: 4, gain: 0.6, seed: 203 });
    for (let i = 0; i < N * N; i++) {
      const o = i * 4;
      d[o] = bright[i] * 255; d[o + 1] = clamp01(pud[i] * 0.75 + pud2[i] * 0.25) * 255; d[o + 2] = grime[i] * 255; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    macroCPU = { N, d };                                  // wetStateAt() mirrors the shader's lookups on the CPU
    const t = canvasTexture(c, { srgb: false });
    t.name = 'macro'; texs.set('macro', t); U.macro.value = t;
    return t;
  });
}

// legacy foundation helper (kept for other modules)
export function noiseTexture({ size = 256, base = [128, 128, 128], variance = 16, seed = 1, srgb = true, repeat = [1, 1], draw = null, lowFreq = 0.5, name = null } = {}) {
  if (name && texs.has(name)) return texs.get(name);
  const c = makeCanvas(size, size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  const lo = fbm(size, { fx: 8, oct: 3, seed: seed + 7 });
  for (let i = 0; i < size * size; i++) {
    const v = (hash(i % size, (i / size) | 0, seed) - 0.5) * variance + (lo[i] - 0.5) * variance * 2 * lowFreq;
    d[i * 4] = base[0] + v; d[i * 4 + 1] = base[1] + v; d[i * 4 + 2] = base[2] + v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (draw) draw(ctx, size);
  const t = canvasTexture(c, { srgb, repeat });
  if (name) texs.set(name, t);
  return t;
}

// ---------------------------------------------------------------------------------------------- shader hooks
// hook = { space: 'world'|'uv', tile: [m, m], wet: { darken, rough, puddle } | null, macro: 0..1, glass: { cells: [m, m], lit } | null }
const VERT_DECL = `
uniform vec2 uMatTile; uniform float uMatMacroScale;
varying vec2 vMatTexUv; varying vec2 vMatMacroUv; varying float vMatUp;`;
const VERT_BODY = `
{
  vec4 mwp = vec4( transformed, 1.0 );
  vec3 mwn = objectNormal;
  #ifdef USE_INSTANCING
    mwp = instanceMatrix * mwp; mwn = mat3( instanceMatrix ) * mwn;
  #endif
  mwp = modelMatrix * mwp; mwn = normalize( mat3( modelMatrix ) * mwn );
  vec3 an = abs( mwn );
  vec2 tuv = ( an.y >= max( an.x, an.z ) ) ? mwp.xz : ( ( an.x >= an.z ) ? vec2( -mwp.z * sign( mwn.x ), mwp.y ) : vec2( mwp.x * sign( mwn.z ), mwp.y ) );
  vMatTexUv = tuv / uMatTile;
  vMatMacroUv = tuv * uMatMacroScale;
  vMatUp = mwn.y;
}`;
// AFTER-RAIN DRYING STATE, in WORLD space: (x, z metres) -> vec2( film 0 dry .. 1 wet, standing water 0..1 ).
// One function for every ground material (road, lane paint, pavement, kerb top, pavers, tactile strip) and for the
// rain-ripple decals, at fixed world scales, so a puddle crosses a zebra bar or a kerb seam without a step (the old
// per-material puddle field sampled each material's own macro scale and did not line up across a seam). Drivers:
//   - the carriageway distance field (city.field, < 0 on the road): water runs to the kerb foot and stands there in
//     a wandering 0.25-0.85 m band broken into pools; the raised pavement sheds it (outer 1 m damp, crown dries)
//   - broad drying patches (12 m and 36 m noise): about half the carriageway has dried back to its own albedo
//   - low spots (5 m noise), mostly inside the damp half: the puddles
// uMatSoak = 1 while it rains: everything carries a film and the low spots fill sooner.
const WET_STATE_DECL = `
uniform sampler2D uMatField; uniform vec4 uMatFieldT; uniform float uMatSoak;`;
const WET_STATE_FN = `
vec2 matWetField( vec2 w ) {
  float sdf = uMatFieldT.w > 0.5 ? texture2D( uMatField, ( w - uMatFieldT.xy ) * uMatFieldT.z ).r : 6.0;
  vec4 mA = texture2D( uMatMacro, w * 0.0093 + vec2( 0.31, 0.67 ) );
  vec4 mB = texture2D( uMatMacro, w * 0.021 + vec2( 0.13, 0.41 ) );
  float fw = min( fwidth( sdf ), 0.5 );
  float road = 1.0 - smoothstep( -0.03 - fw, 0.03 + fw, sdf );
  float pave = 1.0 - road;
  float dryN = 0.55 * mA.g + 0.45 * mA.r;
  float gw = 0.25 + 0.6 * mB.b;
  float gut = road * ( 1.0 - smoothstep( gw - fw, gw + 0.25 + fw, -sdf ) ) * smoothstep( 0.40, 0.50, mB.r + 0.4 * ( dryN - 0.5 ) );
  float edge = pave * ( 1.0 - smoothstep( 0.25, 1.1, sdf ) );
  float gutDamp = road * ( 1.0 - smoothstep( 0.6, 1.8, -sdf ) );
  float low = mB.g + 0.4 * ( dryN - 0.5 ) - 0.035 * pave;
  float film = smoothstep( 0.49, 0.53, dryN - 0.02 * pave + 0.12 * edge + 0.1 * gutDamp );
  float pud = max( smoothstep( 0.625, 0.655, low ), gut );
  film = max( film, max( pud, smoothstep( 0.56, 0.625, low ) ) );
  pud = max( pud, uMatSoak * smoothstep( 0.58, 0.62, low ) );
  return vec2( mix( film, 1.0, uMatSoak ), pud );
}`;
const FRAG_DECL = `
uniform sampler2D uMatMacro; uniform float uMatWet, uMatNight, uMatMacroK, uMatDarken, uMatWetRough, uMatPuddle, uMatLit, uMatMacroScale;
uniform vec2 uMatCells;
varying vec2 vMatTexUv; varying vec2 vMatMacroUv; varying float vMatUp;
float matHash21( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }` + WET_STATE_DECL + WET_STATE_FN;

function fragChunks(hook) {
  const uvTex = hook.space === 'world';
  const uvMap = uvTex ? 'vMatTexUv' : 'vMapUv', uvN = uvTex ? 'vMatTexUv' : 'vNormalMapUv', uvR = uvTex ? 'vMatTexUv' : 'vRoughnessMapUv';
  const uvM = uvTex ? 'vMatTexUv' : 'vMetalnessMapUv', uvE = uvTex ? 'vMatTexUv' : 'vEmissiveMapUv', uvA = uvTex ? 'vMatTexUv' : 'vAoMapUv';
  // de-tiling: a second sample of the same maps rotated 90° + offset, blended by the macro grime field, so a
  // distinctive crack / patch never repeats on a lattice (unstructured sets only - grids would ghost)
  const detile = !!(uvTex && hook.detile);
  const tex2 = (name, uv) => detile ? `mix( texture2D( ${name}, ${uv} ), texture2D( ${name}, matUv2 ), matDetileK )` : `texture2D( ${name}, ${uv} )`;
  const map = `
vec4 matMacro = texture2D( uMatMacro, vMatMacroUv );
vec2 matUv2 = vec2( vMatTexUv.y, -vMatTexUv.x ) + vec2( 0.37, 0.61 );
float matDetileK = ${detile ? 'smoothstep( 0.42, 0.58, matMacro.b )' : '0.0'};
#ifdef USE_MAP
  vec4 sampledDiffuseColor = ${tex2('map', uvMap)};
  diffuseColor *= sampledDiffuseColor;
#endif
float matUp = smoothstep( 0.55, 0.95, vMatUp );
// wetness follows the after-rain drying state on up-facing ground (dry / damp film / standing water); a wall keeps
// the flat rain-streaked quarter it always had. matReflW is the planar mirror's weight (weather.js): a damp film
// takes most of it through a blurred lookup (a sheen of the brightest lights), standing water all of it, crisp.
#ifdef MAT_WETSTATE
  vec2 matWS = matWetField( vMatMacroUv / uMatMacroScale );
#else
  vec2 matWS = vec2( 1.0, 0.0 );
#endif
float matWetK = uMatWet * mix( 0.25, matWS.x, matUp );
float matPuddle = uMatPuddle * uMatWet * matUp * matWS.y;
float matReflW = uMatWet * matUp * mix( 0.8 * matWS.x, 1.0, min( 1.0, 2.0 * uMatPuddle ) * matWS.y );
diffuseColor.rgb *= mix( 1.0, mix( 0.84, 1.16, matMacro.r ), uMatMacroK );
diffuseColor.rgb *= 1.0 - uMatDarken * matWetK;
diffuseColor.rgb *= 1.0 - 0.3 * matPuddle;`;
  const rough = `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = ${tex2('roughnessMap', uvR)};
  roughnessFactor *= texelRoughness.g;
#endif
roughnessFactor = clamp( roughnessFactor + ( matMacro.b - 0.5 ) * 0.16 * uMatMacroK, 0.02, 1.0 );
#ifdef MAT_WETSTATE
  // a damp film on the ground is a sheen, not a varnish: it keeps 15 % of the roughness a soaked surface loses;
  // standing water is a mirror (the planar reflection's blur follows this roughness)
  roughnessFactor *= 1.0 - uMatWetRough * matWetK * ( 1.0 - 0.15 * matUp );
  roughnessFactor = mix( roughnessFactor, 0.12, matPuddle );
#else
  roughnessFactor *= 1.0 - uMatWetRough * matWetK;
  roughnessFactor = mix( roughnessFactor, 0.18, matPuddle );
#endif`;
  const metal = `
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  vec4 texelMetalness = ${tex2('metalnessMap', uvM)};
  metalnessFactor *= texelMetalness.b;
#endif`;
  // world-space sets: the tangent frame must come from the projected uv, not the mesh uv three.js used for tbn
  const normal = `
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = texture2D( normalMap, ${uvN} ).xyz * 2.0 - 1.0;
  ${detile ? `vec3 mapN2 = texture2D( normalMap, matUv2 ).xyz * 2.0 - 1.0;
  mapN = normalize( mix( mapN, vec3( -mapN2.y, mapN2.x, mapN2.z ), matDetileK ) );` : ''}
  mapN.xy *= normalScale * ( 1.0 - 0.65 * matWetK );
  ${uvTex ? `mat3 matTbn = getTangentFrame( - vViewPosition, normal, vMatTexUv );
  #ifdef DOUBLE_SIDED
    matTbn[0] *= faceDirection; matTbn[1] *= faceDirection;
  #endif
  normal = normalize( matTbn * mapN );` : 'normal = normalize( tbn * mapN );'}
  normal = normalize( mix( normal, nonPerturbedNormal, matPuddle ) );
#endif`;
  const ao = `
#ifdef USE_AOMAP
  float ambientOcclusion = ( ${tex2('aoMap', uvA)}.r - 1.0 ) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
#endif`;
  const emissive = hook.glass ? `
#ifdef USE_EMISSIVEMAP
  vec4 emissiveColor = texture2D( emissiveMap, ${uvE} );
  vec2 matCell = floor( vMatTexUv * uMatCells );
  float matH = matHash21( matCell );
  float matLit = step( 1.0 - uMatLit, matH ) * mix( 0.3, 1.0, matHash21( matCell + 7.3 ) );
  vec3 matTint = mix( vec3( 1.0, 0.92, 0.8 ), vec3( 0.85, 0.95, 1.0 ), step( 0.5, matHash21( matCell + 3.1 ) ) );
  totalEmissiveRadiance *= emissiveColor.rgb * matLit * matTint * uMatNight;
#endif` : `
#ifdef USE_EMISSIVEMAP
  vec4 emissiveColor = texture2D( emissiveMap, ${uvE} );
  totalEmissiveRadiance *= emissiveColor.rgb;
#endif`;
  // the wet env boost (ENV_WET) belongs to the wet part only: a dried patch keeps its dry IBL sheen
  const env = hook.wet && hook.wet.puddle > 0 ? `
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular ) && defined( MAT_WETSTATE )
  radiance *= mix( 1.0, mix( 0.45, 1.0, matWS.x ), matUp * uMatWet );
#endif` : '';
  return { map, rough, metal, normal, ao, emissive, env };
}

function hookShader(mat, hook) {
  mat.userData.matHook = hook;
  const tile = hook.tile || [1, 1];
  const wet = hook.wet || { darken: 0, rough: 0, puddle: 0 };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uMatTile: { value: new THREE.Vector2(tile[0], tile[1]) },
      uMatMacroScale: { value: hook.macroScale || 0.021 },
      uMatMacro: U.macro, uMatWet: U.wet, uMatNight: U.night,
      uMatMacroK: { value: hook.macro ?? 1 },
      uMatDarken: { value: wet.darken }, uMatWetRough: { value: wet.rough }, uMatPuddle: { value: wet.puddle },
      uMatLit: { value: hook.glass ? hook.glass.lit : 0 },
      uMatCells: { value: new THREE.Vector2(hook.glass ? 1 / hook.glass.cells[0] : 1, hook.glass ? 1 / hook.glass.cells[1] : 1) },
    });
    const ch = fragChunks(hook);
    const state = !!(hook.wet && hook.wet.puddle > 0);    // ground-capable: runs the after-rain drying state
    if (state) Object.assign(shader.uniforms, { uMatField: U.field, uMatFieldT: U.fieldT, uMatSoak: U.soak });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + VERT_DECL)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', (state ? '#define MAT_WETSTATE\n' : '') + '#include <common>' + FRAG_DECL)
      .replace('#include <map_fragment>', ch.map)
      .replace('#include <roughnessmap_fragment>', ch.rough)
      .replace('#include <metalnessmap_fragment>', ch.metal)
      .replace('#include <normal_fragment_maps>', ch.normal)
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>' + ch.env)
      .replace('#include <aomap_fragment>', ch.ao)
      .replace('#include <emissivemap_fragment>', ch.emissive + (state && WET_DBG ?
        '\ntotalEmissiveRadiance = 0.25 * matUp * vec3( 1.0 - matWS.x, matWS.x * ( 1.0 - matWS.y ), matWS.y );' : ''));
  };
  mat.customProgramCacheKey = () => 'mat:' + hook.space + ':' + (hook.glass ? 'glass' : 'std') + (hook.detile ? ':detile' : '') + (hook.wet && hook.wet.puddle > 0 ? ':ws' : '');
  return mat;
}

// ---------------------------------------------------------------------------------------------- library
const WET_GROUND = { darken: 0.42, rough: 0.56, puddle: 1 };
const WET_WALL = { darken: 0.3, rough: 0.4, puddle: 0.6 };
const WET_PAINT = { darken: 0.25, rough: 0.5, puddle: 1 };
const ENV_WET = { asphalt: [0.55, 1.5], road: [0.55, 1.5], sidewalk: [0.5, 1.2], paverRed: [0.5, 1.2], paverGrey: [0.5, 1.2], tactile: [0.5, 1.1], curb: [0.5, 1.1], concrete: [0.45, 0.9], roadPaint: [0.5, 1.3], roadPaintYellow: [0.5, 1.3], stone: [0.7, 1.2], roof: [0.4, 0.9] };
let currentWet = -1;

function applySet(m, set, { ao = true, normalScale = 1 } = {}) {
  m.map = set.map; m.roughnessMap = set.orm; m.metalnessMap = set.orm; m.normalMap = set.normal;
  if (ao) { m.aoMap = set.orm; m.aoMapIntensity = 1; }
  if (set.emissive) m.emissiveMap = set.emissive;
  m.normalScale.set(normalScale, normalScale);
  return m;
}

function buildMaterial(key) {
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const phys = (o) => new THREE.MeshPhysicalMaterial(o);
  texMacro();
  switch (key) {
    case 'asphalt': case 'road': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.55 }), texAsphalt());
      return hookShader(m, { space: 'world', tile: [6, 6], wet: WET_GROUND, macro: 1, macroScale: key === 'road' ? 0.019 : 0.023, detile: true });
    }
    case 'roadPaint': case 'roadPaintYellow': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.5 }), texRoadPaint(key === 'roadPaintYellow'));
      return hookShader(m, { space: 'uv', wet: WET_PAINT, macro: 0.6, macroScale: 0.021 });
    }
    case 'sidewalk': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.5 }), texSidewalk());
      return hookShader(m, { space: 'world', tile: [4.8, 4.8], wet: WET_GROUND, macro: 1, macroScale: 0.03 });
    }
    case 'paverRed': case 'paverGrey': {
      const set = key === 'paverRed'
        ? texPaver('paverRed', 211, [[152, 84, 62], [138, 72, 56], [168, 104, 78], [120, 66, 54], [160, 92, 70]])
        : texPaver('paverGrey', 212, [[150, 148, 144], [122, 122, 120], [166, 162, 156], [96, 96, 98], [140, 136, 130]]);
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.5 }), set);
      return hookShader(m, { space: 'world', tile: [1.6, 1.6], wet: WET_GROUND, macro: 1, macroScale: 0.03 });
    }
    case 'tactile': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.5 }), texTactile());
      return hookShader(m, { space: 'world', tile: [1.2, 1.2], wet: { darken: 0.3, rough: 0.5, puddle: 0.5 }, macro: 0.5, macroScale: 0.03 });
    }
    case 'curb': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.5 }), texGranite('curb', 105, false));
      return hookShader(m, { space: 'world', tile: [1, 1], wet: WET_WALL, macro: 0.7, macroScale: 0.03 });
    }
    case 'stone': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.7 }), texGranite('stone', 125, true));
      return hookShader(m, { space: 'world', tile: [1.2, 1.2], wet: { darken: 0.15, rough: 0.3, puddle: 0.4 }, macro: 0.4, macroScale: 0.03 });
    }
    case 'concrete': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.45 }), texConcrete());
      return hookShader(m, { space: 'world', tile: [3.6, 3.6], wet: WET_WALL, macro: 1, macroScale: 0.03 });
    }
    case 'brick': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.4 }), texBrick());
      return hookShader(m, { space: 'world', tile: [1.76, 1.76], wet: { darken: 0.25, rough: 0.3, puddle: 0 }, macro: 0.8, macroScale: 0.04 });
    }
    case 'tile': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.9 }), texTile());
      return hookShader(m, { space: 'world', tile: [1.2, 1.2], wet: { darken: 0.1, rough: 0.3, puddle: 0.5 }, macro: 0.5, macroScale: 0.04 });
    }
    case 'glass': case 'glassNight': {
      const night = key === 'glassNight';
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 1, envMapIntensity: 1.6, transparent: !night, opacity: night ? 1 : 0.92, emissive: 0xffffff, emissiveIntensity: night ? 1.1 : 0.55, depthWrite: true }), texGlass());
      return hookShader(m, { space: 'world', tile: [7.2, 7.2], wet: null, macro: 0.25, macroScale: 0.02, glass: { cells: [1.8, 3.6], lit: night ? 0.62 : 0.3 } });
    }
    case 'metal': return applySet(std({ color: 0xffffff, roughness: 1, metalness: 1, envMapIntensity: 1.2 }), texBrushed(), { ao: false });
    case 'chrome': return std({ color: 0xf2f4f6, roughness: 0.05, metalness: 1, envMapIntensity: 1.6 });
    case 'paintSignalGrey': case 'paintGuardrailWhite': case 'paintPoleGreen': case 'plastic': case 'rubber': {
      const colors = { paintSignalGrey: 0x6f7276, paintGuardrailWhite: 0xe6e7e2, paintPoleGreen: 0x4a5a50, plastic: 0xe4e4dc, rubber: 0x141417 };
      const set = texOrangePeel();
      const m = std({ color: colors[key], roughness: key === 'rubber' ? 0.9 : key === 'plastic' ? 0.42 : 0.5, metalness: key === 'rubber' ? 0 : 0.15, envMapIntensity: key === 'rubber' ? 0.4 : 0.9 });
      m.normalMap = set.normal; m.normalScale.set(key === 'rubber' ? 1.5 : 0.7, key === 'rubber' ? 1.5 : 0.7); m.roughnessMap = set.orm;
      return m;
    }
    case 'wood': return applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.6 }), texWood());
    case 'suit': {
      const m = applySet(phys({ color: 0xffffff, roughness: 1, metalness: 0, sheen: 0.3, sheenRoughness: 0.7, sheenColor: new THREE.Color(0x3a3d4a), envMapIntensity: 0.5 }), texWeave('suit', 181, 6, 0.16, [40, 42, 50], 0.14), { ao: false });
      return m;
    }
    case 'shirt': return applySet(phys({ color: 0xffffff, roughness: 1, metalness: 0, sheen: 0.15, sheenRoughness: 0.8, sheenColor: new THREE.Color(0xffffff), envMapIntensity: 0.5 }), texWeave('shirt', 182, 4, 0.1, [236, 233, 226], 0.06), { ao: false });
    case 'cloth': return applySet(phys({ color: 0xffffff, roughness: 1, metalness: 0, sheen: 0.25, sheenRoughness: 0.75, sheenColor: new THREE.Color(0x777777), envMapIntensity: 0.5 }), texWeave('cloth', 183, 5, 0.14, [128, 124, 118], 0.12), { ao: false });
    case 'skin': return applySet(phys({ color: 0xffffff, roughness: 1, metalness: 0, sheen: 0.25, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xe8b8a0), clearcoat: 0.05, clearcoatRoughness: 0.65, envMapIntensity: 0.45 }), texSkin(), { ao: false });
    case 'hair': return applySet(phys({ color: 0xffffff, roughness: 1, metalness: 0, anisotropy: 0.6, anisotropyRotation: Math.PI / 2, envMapIntensity: 0.45 }), texHair(), { ao: false });
    case 'shoes': return applySet(phys({ color: 0xffffff, roughness: 1, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.22, envMapIntensity: 1.0 }), texLeather('shoes', 191, [20, 16, 14], 0.36), { ao: false });
    case 'leather': return applySet(phys({ color: 0xffffff, roughness: 1, metalness: 0, clearcoat: 0.2, clearcoatRoughness: 0.5, envMapIntensity: 0.7 }), texLeather('leather', 192, [52, 38, 30], 0.55), { ao: false });
    case 'roof': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.4 }), texRoof());
      return hookShader(m, { space: 'world', tile: [4, 4], wet: WET_GROUND, macro: 1, macroScale: 0.05 });
    }
    case 'bronze': return applySet(std({ color: 0xffffff, roughness: 1, metalness: 1, envMapIntensity: 1.0 }), texBronze(), { ao: false });
    case 'grass': {
      const m = applySet(std({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.3 }), texGrass());
      return hookShader(m, { space: 'world', tile: [2, 2], wet: null, macro: 1, macroScale: 0.06 });
    }
    case 'dark': return std({ color: 0x1c1d22, roughness: 0.8, metalness: 0.1 });
    case 'white': return std({ color: 0xffffff, roughness: 0.6, metalness: 0.0 });
    default: {
      console.warn(`[materials] unknown key "${key}", returning concrete`);
      return buildMaterial('concrete');
    }
  }
}

export function get(key) {
  let m = mats.get(key);
  if (!m) { m = buildMaterial(key); m.name = key; m.userData.key = key; mats.set(key, m); applyWetTo(key, m, Math.max(0, currentWet)); }
  return m;
}
export function clone(key) {
  const src = get(key), m = src.clone();
  m.userData.key = key;
  if (src.userData.matHook) hookShader(m, src.userData.matHook);
  return m;
}
export function variant(key, opts = {}) {
  const id = key + JSON.stringify(opts);
  let m = variants.get(id);
  if (m) return m;
  m = clone(key);
  m.name = key + '#' + variants.size;
  if (opts.color != null) m.color.set(opts.color);
  if (opts.roughness != null) m.roughness = opts.roughness;
  if (opts.metalness != null) m.metalness = opts.metalness;
  if (opts.emissive != null) { m.emissive.set(opts.emissive); if (opts.emissiveIntensity == null) m.emissiveIntensity = Math.max(m.emissiveIntensity, 1); }
  if (opts.emissiveIntensity != null) m.emissiveIntensity = opts.emissiveIntensity;
  if (opts.opacity != null) { m.opacity = opts.opacity; m.transparent = opts.opacity < 1; }
  if (opts.side != null) m.side = opts.side;
  if (opts.decal) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2; m.userData.noShadow = true; }
  variants.set(id, m);
  return m;
}
// uv-space copy of a world-space set for ribbon geometry (u = metres / width, v = 0..1 across): `repeat` is the
// texture repeat per uv unit, e.g. tactile strips 0.3 m wide -> one 300 mm block per unit = 1/4 of the 1.2 m set.
export function stripVariant(key, repeat = [1, 1], opts = {}) {
  const id = key + '|strip' + JSON.stringify([repeat, opts]);
  let m = variants.get(id);
  if (m) return m;
  const src = get(key);
  m = src.clone(); m.name = key + '#strip'; m.userData.key = key;
  const shared = new Map();
  for (const slot of ['map', 'roughnessMap', 'metalnessMap', 'aoMap', 'normalMap', 'emissiveMap']) {
    const t = m[slot]; if (!t) continue;
    let c = shared.get(t);
    if (!c) { c = t.clone(); c.repeat.set(repeat[0], repeat[1]); c.needsUpdate = true; shared.set(t, c); }
    m[slot] = c;
  }
  if (src.userData.matHook) hookShader(m, { ...src.userData.matHook, space: 'uv', detile: false });
  if (opts.decal) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2; m.userData.noShadow = true; }
  variants.set(id, m);
  applyWetTo(key, m, Math.max(0, currentWet));
  return m;
}
export function texture(name) { return texs.get(name) || null; }
export function textureSet(name) { return sets.get(name) || null; }

// ---------------------------------------------------------------------------------------------- scene binding
// The street builder (city) still carries its own flat noise ground set, named st_*. Until it consumes the library
// directly, bind those meshes to the PBR equivalents by material name (opt out with ?nobind=1; a mesh whose material
// already comes from this library, or has userData.keepMaterial, is left alone).
const BIND = {
  st_asphalt: () => get('road'),
  st_sidewalk: () => get('sidewalk'),
  st_kerb: () => get('curb'),
  st_paint: () => variant('roadPaint', { decal: true }),
  st_paintY: () => variant('roadPaintYellow', { decal: true }),
  st_tactile: () => stripVariant('tactile', [0.25, 0.25], { decal: true }),
  st_paver: () => variant('paverGrey', { decal: true }),
  st_brick: () => variant('paverRed', { decal: true }),
  st_granite: () => variant('stone', { decal: true }),
};
export function bindScene(root, table = BIND) {
  let n = 0;
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
    const src = o.material, make = table[src.name];
    if (!make || src.userData.key || src.userData.keepMaterial) return;
    let m = cache.get(src);
    if (!m) { m = make(); cache.set(src, m); }
    o.material = m; n++;
  });
  return n;
}

function applyWetTo(key, m, f) {
  const e = ENV_WET[key];
  if (e) m.envMapIntensity = mix(e[0], e[1], f);
}
export function setWet(f) {
  f = Math.max(0, Math.min(1, f));
  if (Math.abs(f - currentWet) < 1e-3) return;
  currentWet = f;
  U.wet.value = f;
  for (const [key, m] of mats) applyWetTo(key, m, f);
  for (const m of variants.values()) applyWetTo(m.userData.key, m, f);
}
// 1 while it is actually raining (weather.js): every ground surface filmed, the low spots fill sooner
export function setSoak(k) { U.soak.value = Math.max(0, Math.min(1, k)); }

// ---- after-rain drying state (WET_STATE_FN): the city's carriageway distance field, uploaded once as a half-float
// texture (clamped to +-8 m, the only range the state reads), bilinear like city.field.sample so the gutter band
// lands exactly on the kerbs streets.js cut from the same field. Before it is bound the shader reads "pavement".
let fieldCPU = null;
function placeholderField() {
  if (U.field.value) return;
  const t = new THREE.DataTexture(new Uint16Array([THREE.DataUtils.toHalfFloat(6)]), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
  t.needsUpdate = true; U.field.value = t;
}
export function bindWetField(field) {
  if (!field || !field.f || !field.N) return false;
  const N = field.N, R = field.R != null ? field.R : (N - 1) / 2, step = field.step || (2 * R) / (N - 1);
  const data = new Uint16Array(N * N), f = field.f;
  for (let i = 0; i < N * N; i++) data[i] = THREE.DataUtils.toHalfFloat(f[i] < -8 ? -8 : f[i] > 8 ? 8 : f[i]);
  const t = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.name = 'wetField'; t.needsUpdate = true;
  const old = U.field.value;
  U.field.value = t;
  if (old && old !== t) old.dispose();
  U.fieldT.value.set(-R - step / 2, -R - step / 2, 1 / (N * step), 1);   // texel centres on the grid points
  fieldCPU = field;
  return true;
}
// CPU mirror of WET_STATE_FN (fwidth terms = 0): { film, pud } at world (x, z). weather.js places its rain-ripple
// decals only where this says there is standing water.
function macroAt(u, v, ch) {
  if (!macroCPU) return 0.5;
  const { N, d } = macroCPU;
  const fx = u * N - 0.5, fy = (1 - v) * N - 0.5;               // CanvasTexture flipY: v = 0 is the canvas's last row
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (x, y) => d[((((y % N) + N) % N) * N + (((x % N) + N) % N)) * 4 + ch] / 255;
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}
export function wetStateAt(x, z) {
  let sdf = fieldCPU ? fieldCPU.sample(x, z) : 6;
  sdf = Math.max(-8, Math.min(8, sdf));
  const aU = x * 0.0093 + 0.31, aV = z * 0.0093 + 0.67, bU = x * 0.021 + 0.13, bV = z * 0.021 + 0.41;
  const road = 1 - smooth(-0.03, 0.03, sdf), pave = 1 - road;
  const dryN = 0.55 * macroAt(aU, aV, 1) + 0.45 * macroAt(aU, aV, 0);
  const bR = macroAt(bU, bV, 0), bG = macroAt(bU, bV, 1), bB = macroAt(bU, bV, 2);
  const gw = 0.25 + 0.6 * bB;
  const gut = road * (1 - smooth(gw, gw + 0.25, -sdf)) * smooth(0.40, 0.50, bR + 0.4 * (dryN - 0.5));
  const edge = pave * (1 - smooth(0.25, 1.1, sdf)), gutDamp = road * (1 - smooth(0.6, 1.8, -sdf));
  const low = bG + 0.4 * (dryN - 0.5) - 0.035 * pave;
  let film = smooth(0.49, 0.53, dryN - 0.02 * pave + 0.12 * edge + 0.1 * gutDamp);
  let pud = Math.max(smooth(0.625, 0.655, low), gut);
  film = Math.max(film, pud, smooth(0.56, 0.625, low));
  const soak = U.soak.value;
  pud = Math.max(pud, soak * smooth(0.58, 0.62, low));
  return { film: mix(film, 1, soak), pud, sdf };
}
// for other owners' shaders that must follow the same state (weather's ripple decals): GLSL + the shared uniforms
export const wetStateShader = {
  decl: '\nuniform sampler2D uMatMacro;' + WET_STATE_DECL,
  fn: WET_STATE_FN,
  uniforms: () => ({ uMatMacro: U.macro, uMatField: U.field, uMatFieldT: U.fieldT, uMatSoak: U.soak }),
};

// ---------------------------------------------------------------------------------------------- environment
// Procedural cubemap scene: sky gradient + light-pollution band, ring of lit towers, neon sign patches, dark ground.
export function makeEnvironment(renderer, mode = 'night') {
  const night = mode === 'night' ? 1 : mode === 'dusk' ? 0.55 : 0;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  const disposables = [];
  const add = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); scene.add(m); disposables.push(geo, mat); return m; };

  // sky: vertical gradient on a back-facing sphere
  const sc = makeCanvas(4, 256), sctx = sc.getContext('2d'), g = sctx.createLinearGradient(0, 0, 0, 256);
  const stops = mode === 'night'
    ? [[0, '#05060f'], [0.3, '#0a0d1f'], [0.42, '#231a38'], [0.48, '#5a3a55'], [0.52, '#6a4658'], [0.6, '#2a1f30'], [1, '#0a0810']]
    : mode === 'dusk'
      ? [[0, '#1a2a5a'], [0.3, '#3a4d8a'], [0.44, '#c07a5a'], [0.5, '#ffb070'], [0.54, '#d07a60'], [0.7, '#3a2a30'], [1, '#1a1418']]
      : [[0, '#3a6fd0'], [0.25, '#6f9be0'], [0.45, '#b9d0ea'], [0.5, '#d8e2ec'], [0.55, '#8a8f96'], [1, '#3a3c40']];
  for (const [o, c] of stops) g.addColorStop(o, c);
  sctx.fillStyle = g; sctx.fillRect(0, 0, 4, 256);
  const skyTex = new THREE.CanvasTexture(sc); skyTex.colorSpace = THREE.SRGBColorSpace;
  const sky = add(new THREE.SphereGeometry(400, 32, 24), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide }));
  sky.material.color.setScalar(mode === 'day' ? 2.2 : 1.0);
  disposables.push(skyTex);
  if (mode !== 'night') {                                                       // sun disc (HDR)
    const el = mode === 'day' ? 1.0 : 0.12, az = 2.2;
    add(new THREE.SphereGeometry(mode === 'day' ? 9 : 14, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(mode === 'day' ? 60 : 14, mode === 'day' ? 56 : 8, mode === 'day' ? 48 : 4) }),
      Math.cos(az) * Math.cos(el) * 380, Math.sin(el) * 380, Math.sin(az) * Math.cos(el) * 380);
  }
  // ground
  add(new THREE.CircleGeometry(390, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(mode === 'day' ? 0.14 : 0.02) }), 0, -2, 0);
  // ring of towers with lit windows
  const glassSet = texGlass();
  const winMat = new THREE.MeshBasicMaterial({ map: glassSet.emissive, color: new THREE.Color().setScalar(0.25 + 0.9 * night) });
  const wallMat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(mode === 'day' ? 0.35 : 0.03) });
  const rnd = mulberry(311);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rnd() * 0.1, r = 45 + rnd() * 60, w = 14 + rnd() * 20, h = 18 + rnd() * 70;
    const geo = new THREE.BoxGeometry(w, h, w);
    const uv = geo.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * w / 7.2, uv.getY(k) * h / 7.2);
    const mesh = new THREE.Mesh(geo, [winMat, winMat, wallMat, wallMat, winMat, winMat]);
    mesh.position.set(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r); mesh.rotation.y = -a;
    scene.add(mesh); disposables.push(geo);
  }
  disposables.push(winMat, wallMat);
  // neon / LED patches (HDR colours) - the coloured highlights on chrome, glass and wet asphalt
  if (night > 0) {
    const neon = [[3.5, 0.5, 1.6], [0.5, 2.2, 3.6], [3.6, 2.0, 0.6], [0.6, 3.2, 1.0], [3.4, 0.9, 0.4], [3.6, 3.6, 3.4], [2.2, 0.4, 3.2], [3.2, 1.4, 0.3]];
    for (let i = 0; i < 40; i++) {
      const a = rnd() * Math.PI * 2, r = 30 + rnd() * 45, w = 3 + rnd() * 9, h = 1.5 + rnd() * 5;
      const c = neon[Math.floor(rnd() * neon.length)];
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(c[0] * night, c[1] * night, c[2] * night), side: THREE.DoubleSide });
      const m = add(new THREE.PlaneGeometry(w, h), mat, Math.cos(a) * r, 2 + rnd() * 22, Math.sin(a) * r);
      m.lookAt(0, m.position.y, 0);
    }
  }
  const rt = pmrem.fromScene(scene, 0.035, 1, 900);
  for (const d of disposables) if (d && d.dispose && d !== glassSet.emissive) d.dispose();
  pmrem.dispose();
  rt.texture.name = `env_${mode}`;
  return rt.texture;
}

// ---------------------------------------------------------------------------------------------- shot presets / self test
function labelMesh(text, w = 1.1, h = 0.22) {
  const c = makeCanvas(256, 52), ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(0, 0, 256, 52);
  ctx.fillStyle = '#f2e6c8'; ctx.font = 'bold 30px "Helvetica Neue", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 27);
  const t = canvasTexture(c, { srgb: true, wrap: false });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
}

function buildTestRig(engine, mode) {
  if (engine.scene.getObjectByName('materials_test')) return;
  const group = new THREE.Group(); group.name = 'materials_test';
  const sphere = new THREE.SphereGeometry(0.42, 48, 32), cube = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  const perRow = 11, dx = 1.35, rows = Math.ceil(KEYS.length / perRow), rise = 1.45;
  for (let r = 1; r < rows; r++) {                                              // bleacher steps so every row is visible
    const step = new THREE.Mesh(new THREE.BoxGeometry(perRow * dx + 1.2, r * rise, 2.6), get('concrete'));
    step.position.set(0, r * rise / 2, -r * 2.6); step.receiveShadow = step.castShadow = true;
    group.add(step);
  }
  KEYS.forEach((key, i) => {
    const r = Math.floor(i / perRow), c = i % perRow;
    const x = (c - (Math.min(perRow, KEYS.length - r * perRow) - 1) / 2) * dx, z = -r * 2.6, y = r * rise;
    const m = get(key);
    const cb = new THREE.Mesh(cube, m); cb.position.set(x, y + 0.4, z); cb.castShadow = cb.receiveShadow = true;
    const sp = new THREE.Mesh(sphere, m); sp.position.set(x, y + 1.25, z); sp.castShadow = true;
    const lb = labelMesh(key, 1.2, 0.24); lb.position.set(x, y + 0.12, z + 0.42);
    group.add(cb, sp, lb);
  });
  // flat ground tiles in front of the rig for the ground/wall sets
  const slabs = ['asphalt', 'sidewalk', 'paverRed', 'paverGrey', 'tactile', 'concrete', 'brick', 'tile', 'curb', 'wood'];
  slabs.forEach((key, i) => {
    const x = (i - (slabs.length - 1) / 2) * 1.75;
    const m = key === 'concrete' ? variant('concrete', { color: 0xc9bca6 }) : get(key);   // variant() exercises the re-hook path
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.06, 1.65), m); slab.position.set(x, 0.03, 4.4); slab.receiveShadow = true;
    const lb = labelMesh(key === 'concrete' ? 'concrete#tint' : key, 1.2, 0.24); lb.position.set(x, 0.12, 5.4);
    group.add(slab, lb);
  });
  // key / fill near the camera and a high blue rim: their ground reflections fall outside the preset frame
  const l1 = new THREE.PointLight(0xffd0a0, 90, 40, 2); l1.position.set(-8, 7, 10);
  const l2 = new THREE.PointLight(0xff5aa0, 70, 40, 2); l2.position.set(8, 6, 10);
  const l3 = new THREE.PointLight(0x80c0ff, 320, 60, 2); l3.position.set(0, 16, -18);
  group.add(l1, l2, l3);
  engine.scene.add(group);
  engine.scene.environment = makeEnvironment(engine.renderer, mode);
  engine.scene.environmentIntensity = mode === 'night' ? 0.9 : 0.45;
}

// normal-map handedness check: a flat quad with a dome normal map must shade like the real hemisphere beside it
function buildNormalCheck(engine) {
  if (engine.scene.getObjectByName('materials_nmcheck')) return;
  const N = 256, h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const dx = (x - 128) / 100, dy = (y - 128) / 100, d = dx * dx + dy * dy; h[y * N + x] = d < 1 ? Math.sqrt(1 - d) * 0.6 : 0; }
  const nm = canvasTexture(normalCanvas(h, N, 1.5), { srgb: false, wrap: false });
  const flat = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.6, normalMap: nm });
  const solid = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.6 });
  const g = new THREE.Group(); g.name = 'materials_nmcheck';
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), flat); quad.position.set(-2, 1.5, 0); g.add(quad);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.15, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), solid);
  dome.rotation.x = Math.PI / 2; dome.position.set(2, 1.5, 0); g.add(dome);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), solid); back.position.set(2, 1.5, -0.01); g.add(back);
  const key = new THREE.DirectionalLight(0xffffff, 6); key.position.set(-8, 6, 6); key.target.position.set(0, 1.5, 0); g.add(key, key.target);
  engine.scene.add(g);
}

export const shotPresets = {
  materials_nmcheck: { pos: [0, 1.6, 7], lookAt: [0, 1.5, 0], t: 'night', fov: 40, setup(engine) { buildNormalCheck(engine); } },
  materials_test: { pos: [0, 5.3, 10.8], lookAt: [0, 0.9, -3.2], t: 'night', fov: 52, setup(engine) { buildTestRig(engine, 'night'); } },
  materials_day: { pos: [0, 5.3, 10.8], lookAt: [0, 0.9, -3.2], t: 'day', fov: 52, setup(engine) { buildTestRig(engine, 'day'); } },
  materials_dusk: { pos: [0, 5.3, 10.8], lookAt: [0, 0.9, -3.2], t: 'dusk', fov: 52, setup(engine) { buildTestRig(engine, 'dusk'); } },
  materials_ground: { pos: [-3, 1.7, 9], lookAt: [3, 0, -6], t: 'night', fov: 50 },
  materials_ground_day: { pos: [-3, 1.7, 9], lookAt: [3, 0, -6], t: 'day', fov: 50 },
  materials_kerb: { pos: [-24, 1.4, 14], lookAt: [-34, 0.2, 2], t: 'night', fov: 40 },
  materials_kerb_day: { pos: [-28, 2.2, 12], lookAt: [-33, 0.1, 6], t: 'day', fov: 40 },
  materials_slabs: { pos: [0, 3.4, 7.4], lookAt: [0, 0, 2.2], t: 'day', fov: 50, setup(engine) { buildTestRig(engine, 'day'); } },
};

export function selfTest() {
  const t0 = performance.now();
  const problems = [];
  for (const k of KEYS) {
    const m = get(k);
    for (const slot of ['map', 'emissiveMap']) if (m[slot] && m[slot].colorSpace !== THREE.SRGBColorSpace) problems.push(`${k}.${slot} colorSpace`);
    for (const slot of ['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (m[slot] && m[slot].colorSpace !== THREE.NoColorSpace) problems.push(`${k}.${slot} colorSpace`);
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'emissiveMap']) {
      const t = m[slot];
      if (!t) continue;
      if (t.wrapS !== THREE.RepeatWrapping) problems.push(`${k}.${slot} wrap`);
      if (t.anisotropy < Math.min(8, anisotropyMax)) problems.push(`${k}.${slot} anisotropy`);
      if (!t.generateMipmaps) problems.push(`${k}.${slot} mipmaps`);
    }
  }
  const v = variant('plastic', { color: 0xff3040, roughness: 0.3 });
  if (v === get('plastic') || v.color.getHex() !== 0xff3040) problems.push('variant');
  const c = clone('asphalt');
  if (!c.userData.matHook || c.onBeforeCompile === THREE.Material.prototype.onBeforeCompile) problems.push('clone rehook');
  setWet(1); if (U.wet.value !== 1) problems.push('setWet');
  setWet(0);
  return { ok: problems.length === 0, materials: KEYS.length, textureSets: sets.size, textures: texs.size, genMs: Math.round(genMs), testMs: Math.round(performance.now() - t0), problems };
}

const materials = {
  name: 'materials',
  KEYS, get, clone, variant, stripVariant, bindScene, texture, textureSet, noiseTexture, makeCanvas, canvasTexture, scaleUV, setWet, setSoak, bindWetField, wetStateAt, wetStateShader, makeEnvironment, shotPresets, selfTest,
  uniforms: U,
  init(engine) {
    this.engine = engine;
    anisotropyMax = Math.min(8, engine.renderer.capabilities.getMaxAnisotropy());
    placeholderField();
    const t0 = performance.now();
    for (const k of ['asphalt', 'road', 'concrete', 'glass', 'metal', 'sidewalk', 'brick', 'tile', 'roadPaint', 'curb', 'roof', 'dark']) get(k);
    setWet(engine.time.wet ?? 0);
    console.info(`[materials] pre-warmed ${mats.size} materials, ${sets.size} texture sets in ${Math.round(performance.now() - t0)} ms`);
  },
  update() {
    const e = this.engine;
    if (!e) return;
    if (!fieldCPU && !this._fieldTried) {                // the city's carriageway field drives the drying state
      const city = e.get('city');
      if (city && city.field) {
        this._fieldTried = true;
        try { bindWetField(city.field); } catch (err) { console.warn('[materials] wet field unavailable', err); }
      }
    }
    if (!this.bound) {                                   // first frame after boot: every module has built its meshes
      this.bound = true;
      if (!(e.params && e.params.raw && e.params.raw.nobind)) {
        const n = bindScene(e.scene);
        if (n) console.info(`[materials] bound ${n} street meshes to the PBR library`);
      }
    }
    setWet(e.time.wet ?? 0);
    const night = e.time.night != null ? e.time.night : (e.time.hour < 5.5 || e.time.hour > 18.5 ? 1 : 0);
    U.night.value = 0.12 + 0.88 * night;
  },
};
export default materials;
