// [city] Facade relief: real depth for flat facades. A face is one footprint edge seen from the street; every part
// here — mullion grids standing proud of the glass, slab edges / cornices, piers, rounded balcony bands, cantilevered
// canopies, recessed storefronts, box signs with thickness, blade signs, channel letters — is a box or an extrusion
// merged into the city GeoBatch. With the shared materials (S.mats(), or a builder's own cached ones) relief costs
// triangles, not draw calls; only `letters` brings its own texture (two materials per call, keep it for main names).
// Nothing here collides. Parts at pedestrian height stay within PAVE metres of the footprint (the building collider
// keeps the player about that far off the wall); anything deeper starts above HEAD metres over the pavement.
//
//   const F = R.face(a, b);                  // edge a→b of a CW footprint (L.ensureCW), outward normal
//   R.grid(batch, F, M.silver, { y0: 5, y1: 28, bay: 1.8, storey: 3.5, d: 0.35 });
//   R.canopy(batch, F, M.darkMetal, { y: 4.4, d: 2.2, light: M.glowWhite });
//   R.blade(batch, F, M.darkMetal, { u: -F.len / 2 + 0.6, y: 14, w: 1.3, h: 12, text: '免税', bg: '#d92632', fg: '#fff' });
//   // a landmark already painted with a shared.js curtain material (S.prism): real piers / sills on its windows
//   for (const F of R.faces(poly, 5)) R.curtainGrid(batch, F, M.whiteMetal, { curtain: M.panelWhite.userData.curtain,
//     uvScale: 3.5 / SH, uStart: R.perimeterAt(poly, F.i), y0: GF, y1: H });
//
// Coordinates on a face: u runs left → right as seen from the street (0 at the edge middle), y is world height,
// `out` is metres in front of the footprint line. A part "from out0, d deep" spans out0 … out0 + d.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';

export const PAVE = 0.35;   // deepest projection allowed below HEAD
export const HEAD = 3.2;    // clear height over the pavement for anything deeper than PAVE

/** Face frame on the footprint edge a→b (CW footprint: the outward normal is (dz, −dx) / len). */
export function face(a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
  return {
    a, b, len, nx: tz, nz: -tx, rx: -tx, rz: -tz, mx: (a[0] + b[0]) / 2, mz: (a[1] + b[1]) / 2, rot: Math.atan2(-tz, tx),
    /** world [x, z] of face point (u, out) */
    at(u, out = 0) { return [this.mx + this.rx * u + this.nx * out, this.mz + this.rz * u + this.nz * out]; },
  };
}
/** One face per edge of a footprint (edges shorter than minLen skipped); each carries its edge index `i`. */
export function faces(polyIn, minLen = 0.8) {
  const poly = L.ensureCW(polyIn), out = [];
  for (let i = 0; i < poly.length; i++) { const f = face(poly[i], poly[(i + 1) % poly.length]); if (f.len >= minLen) { f.i = i; out.push(f); } }
  return out;
}

/** Box on a face: centred on u (w wide) and y (h tall), from out0, d deep. uvm: metre UVs (panel textures). */
export function box(batch, F, mat, u, y, w, h, out0, d, uvm = false) {
  if (w <= 0 || h <= 0 || d <= 0) return;
  const [x, z] = F.at(u, out0 + d / 2);
  batch.add(mat, L.boxAt(x, y, z, w, h, d, F.rot, uvm), x, z);
}
/** Flat quad on a face at `out` (displays, washes, glazing seen straight on). uvr: [u0, v0, u1, v1]. */
export function quad(batch, F, mat, u, y, w, h, out, uvr = [0, 0, 1, 1]) {
  const [x, z] = F.at(u, out);
  batch.add(mat, L.wallQuad(x, y, z, F.nx, F.nz, w, h, 0, uvr), x, z);
}
/** Cladding skin (a panel material with metre UVs) over u0…u1 × y0…y1: hides the generic window grid behind. */
export function skin(batch, F, mat, { u0 = -F.len / 2, u1 = F.len / 2, y0, y1, out0 = 0.02, d = 0.2, uvm = true }) {
  box(batch, F, mat, (u0 + u1) / 2, (y0 + y1) / 2, u1 - u0, y1 - y0, out0, d, uvm);
}

/**
 * Mullion / transom grid standing proud of the glass: verticals across u0…u1 on a `bay` pitch (both ends included;
 * every `major`-th one wider and deeper), horizontals every `storey` from y0 to y1 (both included). The glass
 * behind the grid reads set back by d. Returns the vertical positions (for signs that must sit between them).
 */
export function grid(batch, F, mat, { u0 = -F.len / 2, u1 = F.len / 2, y0, y1, bay = 1.8, storey = 3.5, mw = 0.1, th = 0.16, d = 0.3, out0 = 0.2, major = 0, majorW = 0.3, majorD = null, ends = true, transoms = true }) {
  const n = Math.max(1, Math.round((u1 - u0) / bay)), sp = (u1 - u0) / n, us = [];
  for (let k = ends ? 0 : 1; k <= (ends ? n : n - 1); k++) {
    const u = u0 + k * sp, big = major && k % major === 0;
    box(batch, F, mat, u, (y0 + y1) / 2, big ? majorW : mw, y1 - y0, out0, big ? (majorD ?? d * 1.4) : d);
    us.push(u);
  }
  if (transoms) for (let y = y0; y <= y1 + 1e-3; y += storey) box(batch, F, mat, (u0 + u1) / 2, y, u1 - u0 + mw, th, out0, d * 0.85);
  return us;
}
/** Horizontal bands (slab edges, cornices, string courses) every `step` from y0 to y1, h tall, from out0, d deep. */
export function bands(batch, F, mat, { u0 = -F.len / 2, u1 = F.len / 2, y0, y1 = y0, step = 3.5, h = 0.3, d = 0.35, out0 = 0, uvm = false }) {
  for (let y = y0; y <= y1 + 1e-3; y += step) box(batch, F, mat, (u0 + u1) / 2, y, u1 - u0, h, out0, d, uvm);
}
/** Vertical piers at the given u positions from y0 to y1, w wide, from out0, d deep. */
export function piers(batch, F, mat, { us, y0, y1, w = 0.6, d = 0.35, out0 = 0, uvm = false }) {
  for (const u of us) box(batch, F, mat, u, (y0 + y1) / 2, w, y1 - y0, out0, d, uvm);
}
/**
 * Punched-window reveals: for every window of a regular grid (bay pitch across u0…u1, storey pitch from y0), the
 * jambs, head and sill stand d proud of the glass line, so each opening reads as a hole in the wall. winW / winH:
 * the opening; sillH: height of the sill over the storey line. `fill` (optional) glazes the opening at out0.
 */
export function reveals(batch, F, mat, { u0 = -F.len / 2, u1 = F.len / 2, y0, y1, bay = 2, storey = 3.5, winW = 1.4, winH = 1.9, sillH = 0.9, d = 0.22, out0 = 0.02, t = 0.12, fill = null }) {
  const n = Math.max(1, Math.floor((u1 - u0) / bay)), sp = (u1 - u0) / n;
  for (let y = y0; y + sillH + winH <= y1 + 1e-3; y += storey) {
    const cy = y + sillH + winH / 2;
    for (let k = 0; k < n; k++) {
      const u = u0 + sp * (k + 0.5);
      for (const e of [-1, 1]) box(batch, F, mat, u + e * (winW / 2 + t / 2), cy, t, winH + 2 * t, out0, d);
      box(batch, F, mat, u, cy + winH / 2 + t / 2, winW, t, out0, d);
      box(batch, F, mat, u, cy - winH / 2 - t / 2, winW + 0.2, t, out0, d + 0.05);
      if (fill) quad(batch, F, fill, u, cy, winW, winH, out0 + 0.01);
    }
  }
}

/**
 * Piers and sill bands standing on a painted curtain / punched-window texture (a shared.js curtain material on an
 * S.prism mass): the painted glass becomes the back of real openings. `curtain` = mat.userData.curtain, uvScale the
 * prism's, uStart the prism's u at the face's edge start a (the perimeter length before edge F.i on the same CW
 * polygon: perimeterAt). Piers cover the wall between windows (or a mullion `mw` on all-glass bays), one band per
 * storey line covers head + spandrel. Only y0…y1 (e.g. above the shop row) and u away from the corners.
 */
export function curtainGrid(batch, F, mat, { curtain, uvScale = 1, uStart = 0, y0, y1, d = 0.25, out0 = 0, mw = 0.14, margin = 0.4, bands = true }) {
  const B = curtain.W / curtain.bays / uvScale, Sh = curtain.H / curtain.storeys / uvScale;
  const pw = curtain.punched ? B * (1 - curtain.punched) : mw;
  // bay boundaries along the edge: s = distance from a; face u = len/2 − s
  const k0 = Math.ceil(uStart * uvScale / (curtain.W / curtain.bays)), sOf = (k) => k * B - uStart;
  let n = 0;
  for (let k = k0; ; k++) {
    const s = sOf(k); if (s > F.len) break;
    if (s < margin + pw / 2 || s > F.len - margin - pw / 2) continue;
    box(batch, F, mat, F.len / 2 - s, (y0 + y1) / 2, pw, y1 - y0, out0, d); n++;
  }
  if (bands) {
    const top = curtain.topFrac * Sh, sp = curtain.spandrelFrac * Sh;
    for (let r = Math.floor(y0 / Sh); r * Sh - top <= y1; r++) {
      const b0 = Math.max(y0, r * Sh - top), b1 = Math.min(y1, r * Sh + sp);
      if (b1 - b0 > 0.05) { box(batch, F, mat, 0, (b0 + b1) / 2, F.len - 2 * margin, b1 - b0, out0, d * 0.9); n++; }
    }
  }
  return n;
}
/** Perimeter length before edge i of a polygon (after L.ensureCW, as S.prism / L.extrudePolygon lay their u). */
export function perimeterAt(polyIn, i) {
  const p = L.ensureCW(polyIn); let u = 0;
  for (let k = 0; k < i; k++) u += Math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);
  return u;
}

/** Plan outline (world points) of a band u0…u1 projecting from out0 to out0 + d, its outer corners rounded (radius r). */
function bandOutline(F, u0, u1, out0, d, r, round, seg) {
  const pts = [], o1 = out0 + d, rr = Math.min(r, d, (u1 - u0) / 2);
  const back = out0 - 0.04;   // tucked into the wall: no light gap at the root
  const left = round === 'left' || round === 'both', right = round === 'right' || round === 'both';
  pts.push(F.at(u0, back));
  if (left) for (let k = 0; k <= seg; k++) { const th = Math.PI - (Math.PI / 2) * k / seg; pts.push(F.at(u0 + rr + Math.cos(th) * rr, o1 - rr + Math.sin(th) * rr)); }
  else pts.push(F.at(u0, o1));
  if (right) for (let k = 0; k <= seg; k++) { const th = Math.PI / 2 - (Math.PI / 2) * k / seg; pts.push(F.at(u1 - rr + Math.cos(th) * rr, o1 - rr + Math.sin(th) * rr)); }
  else pts.push(F.at(u1, o1));
  pts.push(F.at(u1, back));
  return pts;
}
/**
 * Stacked balcony bands: every `step` from y0 to y1 a solid band (slab + upstand, h tall) projecting d from u0 to u1,
 * outer corner(s) rounded (round: 'right' | 'left' | 'both' | null, radius r). Extruded with top and underside, so
 * the shadow line and soffit read from the street; `soffit` (a glow material) adds a light line under each band and
 * `back` (e.g. dark glass) fills the recess between bands.
 */
export function balconies(batch, F, mat, { u0 = -F.len / 2, u1 = F.len / 2, y0, y1, step = 3.3, h = 1.1, d = 1.0, out0 = 0, r = d, round = 'right', seg = 8, soffit = null, back = null }) {
  const outline = bandOutline(F, u0, u1, out0, d, r, round, seg), c = F.at((u0 + u1) / 2, out0 + d / 2);
  let n = 0;
  for (let y = y0; y + h <= y1 + 1e-3; y += step, n++) {
    batch.add(mat, L.extrudePolygon(outline, y, y + h, { cap: true, bottom: true }), c[0], c[1]);
    if (soffit) box(batch, F, soffit, (u0 + u1) / 2 - (round === 'right' || round === 'both' ? r / 2 : 0), y - 0.02, Math.max(0.5, u1 - u0 - r - 0.4), 0.05, out0 + 0.25, Math.max(0.1, d * 0.35));
  }
  if (back) box(batch, F, back, (u0 + u1) / 2, (y0 + y1) / 2, u1 - u0, y1 - y0, out0 - 0.02, 0.06);
  return n;
}
/**
 * Cantilevered canopy (eave) over the ground floor: slab t thick with its underside at y, from out0, d deep, across
 * u0…u1; `light` puts downlights in the soffit every lightStep, `fascia` (material) a front upstand fasciaH tall.
 * No posts: nothing stands on the pavement. Keep y ≥ HEAD when d > PAVE.
 */
export function canopy(batch, F, mat, { u0 = -F.len / 2, u1 = F.len / 2, y, d = 2, t = 0.3, out0 = 0, light = null, lightStep = 2.2, fascia = null, fasciaH = 0.6 }) {
  box(batch, F, mat, (u0 + u1) / 2, y + t / 2, u1 - u0, t, out0, d);
  if (fascia) box(batch, F, fascia, (u0 + u1) / 2, y + fasciaH / 2 - 0.05, u1 - u0 + 0.02, fasciaH, out0 + d - 0.12, 0.14);
  if (light) { const n = Math.max(1, Math.floor((u1 - u0) / lightStep)); for (let k = 0; k < n; k++) box(batch, F, light, u0 + (u1 - u0) * (k + 0.5) / n, y - 0.025, Math.min(1.2, lightStep * 0.5), 0.05, out0 + d * 0.3, Math.min(0.9, d * 0.4)); }
}
/**
 * Recessed storefront: the display (a lit-interior material) at `back` over u0…u1 × y0…y1, framed by jambs and a
 * head soffit standing forward to `front`, and thin glazing bars every `bar` metres; reads as a sales floor set in
 * behind the facade line. `front` ≤ PAVE: the frame stands on the pavement edge.
 */
export function storefront(batch, F, display, frame, { u0 = -F.len / 2, u1 = F.len / 2, y0, y1, back = 0.1, front = PAVE, jamb = 0.45, head = 0.45, bar = 2.4, barMat = null }) {
  const w = u1 - u0;
  if (display) quad(batch, F, display, (u0 + u1) / 2, (y0 + y1) / 2, w - 2 * jamb, y1 - y0 - head, back, [0, 0, Math.max(1, w / 8), 1]);
  for (const e of [-1, 1]) box(batch, F, frame, (u0 + u1) / 2 + e * (w / 2 - jamb / 2), (y0 + y1) / 2, jamb, y1 - y0, back - 0.05, front - back + 0.05);
  box(batch, F, frame, (u0 + u1) / 2, y1 - head / 2, w, head, back - 0.05, front - back + 0.05);
  if (bar && barMat) { const n = Math.max(1, Math.round((w - 2 * jamb) / bar)); for (let k = 1; k < n; k++) box(batch, F, barMat, u0 + jamb + (w - 2 * jamb) * k / n, (y0 + y1 - head) / 2, 0.07, y1 - y0 - head, back, 0.08); }
}

/**
 * Box sign (sign cabinet) with thickness: a w × h × d cabinet in `mat` from out0, the lettering (sign atlas) on its
 * front, optional lit rims (`rim`: glow material) along its top and bottom front edges. opts: text, sub, bg, fg,
 * emissive, weight, letterSpacing, vertical (as S.signQuad).
 */
export function boxSign(batch, F, mat, { u, y, w, h, d = 0.45, out0 = 0, rim = null, inset = 0.06, ...sign }) {
  box(batch, F, mat, u, y, w, h, out0, d);
  if (rim) for (const e of [-1, 1]) box(batch, F, rim, u, y + e * (h / 2 - 0.04), w + 0.02, 0.08, out0 + d - 0.02, 0.06);
  if (sign.text != null) { const [x, z] = F.at(u, out0 + d); S.signQuad(batch, x, y, z, F.nx, F.nz, { w: w - 2 * inset, h: h - 2 * inset, lift: 0.012, emissive: 1.2, weight: '900', ...sign }); }
}
/**
 * Blade sign (袖看板) projecting at right angles to the face: a cabinet t thick and w out (from out0), h tall,
 * centred on u / y; the lettering on both broad faces (one atlas print), two brackets back to the wall.
 */
export function blade(batch, F, mat, { u, y, w = 1.2, h = 6, t = 0.2, out0 = 0.15, brackets = true, ...sign }) {
  box(batch, F, mat, u, y, t, h, out0, w);
  if (brackets) for (const e of [-1, 1]) box(batch, F, mat, u, y + e * h * 0.38, 0.08, 0.1, 0, out0 + 0.05);
  if (sign.text != null) {
    const [x, z] = F.at(u, out0 + w / 2);
    S.signQuad(batch, x, y, z, F.rx, F.rz, { w: w - 0.1, h: h - 0.12, lift: t / 2 + 0.012, double: true, vertical: true, emissive: 1.2, weight: '900', ...sign });
  }
}

// channel letters: one alpha-tested canvas per call, drawn by two materials (lit faces, dark returns)
const letterCache = new Map();
function letterMats(key, draw, W, H, emissive) {
  if (letterCache.has(key)) return letterCache.get(key);
  const c = L.makeCanvas(W, H), g = c.getContext('2d');
  g.clearRect(0, 0, W, H); draw(g, W, H);
  const tex = L.canvasTex(c);
  const lit = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, roughness: 0.4, metalness: 0.1, alphaTest: 0.5 });
  lit.name = 'lm_letters:' + key; lit.userData.noShadow = true; lit.userData.layer = 1; S.nightMaterial(lit, 0.1, emissive);
  const side = new THREE.MeshStandardMaterial({ map: tex, color: 0x6c6c6c, roughness: 0.5, metalness: 0.2, alphaTest: 0.5 });
  side.name = 'lm_lettersSide:' + key; side.userData.noShadow = true;
  const o = { lit, side }; letterCache.set(key, o); return o;
}
/**
 * Channel letters standing off a band: `items` ([{ text, x, y, w, h, color, weight, font }] in 0…1 of the sign box,
 * y down) painted on a transparent canvas, stacked `layers` deep from out0 to out0 + d — the back layers darkened
 * as the letters' returns, the front one lit (bloom layer). From an angle the stack reads as solid letters.
 */
export function letters(batch, F, { key, u, y, w, h, out0 = 0, d = 0.3, layers = 4, items, emissive = 1.4, ppm = 72 }) {
  const W = Math.min(2048, Math.max(64, Math.round(w * ppm))), H = Math.min(1024, Math.max(32, Math.round(h * ppm)));
  const m = letterMats(key, (g) => {
    g.textBaseline = 'middle'; g.textAlign = 'center';
    for (const it of items) {
      const fam = it.font || (L.isJP(it.text) ? L.FONT_JP : L.FONT_LATIN), wt = it.weight || '900';
      g.letterSpacing = `${it.letterSpacing || 0}px`;
      const bw = it.w * W, bh = it.h * H, size = L.fitFont(g, it.text, bw, bh * 0.92, wt, fam);
      g.font = `${wt} ${size}px ${fam}`; g.fillStyle = it.color || '#ffffff';
      g.fillText(it.text, (it.x + it.w / 2) * W, (it.y + it.h / 2) * H + size * 0.04);
    }
  }, W, H, emissive);
  for (let k = 0; k < layers; k++) quad(batch, F, k === layers - 1 ? m.lit : m.side, u, y, w, h, out0 + d * k / Math.max(1, layers - 1));
}

export default { PAVE, HEAD, face, faces, box, quad, skin, grid, bands, piers, reveals, curtainGrid, perimeterAt, balconies, canopy, storefront, boxSign, blade, letters };
