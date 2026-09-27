// [city] Shared geometry / texture helpers for city.js and every builder in src/world/buildings/.
//   polygons:  area, ensureCW (A>0 in x/z), centroid, bounds, offsetPolygon, pointInPoly, edgeNormal, insetDepth
//   geometry:  extrudePolygon, quad, boxAt, ribbon (polyline strip with miter joins), stripRect
//   batching:  GeoBatch (merge by material [+ spatial chunk]), Instancer (InstancedMesh per geometry/material)
//   textures:  textCanvas, signMaterial, signMesh, hash
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fitCanvasTexture } from '../../core/mobileProfile.js';

export const FONT_JP = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif';
export const FONT_LATIN = '"Helvetica Neue", Helvetica, Arial, "Hiragino Sans", sans-serif';
export const isJP = (t) => /[぀-ヿ一-鿿]/.test(t);

export function hash(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ------------------------------------------------------------------------------------------------- polygons
export function polyArea(p) { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; }
/** Normalise winding so that polyArea > 0 (outward normal of edge a→b is (dz, −dx)). */
export function ensureCW(p) { return polyArea(p) < 0 ? p.slice().reverse() : p.slice(); }
export function polyCentroid(p) { let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length]; }
export function polyBounds(p) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of p) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return { x0, z0, x1, z1, w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}
export function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** Outward unit normal of edge i of a polyArea>0 polygon. */
export function edgeNormal(p, i) {
  const a = p[i], b = p[(i + 1) % p.length];
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  return [dz / l, -dx / l];
}
/** Offset every edge along its outward normal by `d` (negative = inset); miter-joined, clamped. */
export function offsetPolygon(p, d) {
  const n = p.length, out = [];
  for (let i = 0; i < n; i++) {
    const n0 = edgeNormal(p, (i - 1 + n) % n), n1 = edgeNormal(p, i);
    let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push([p[i][0] + n1[0] * d, p[i][1] + n1[1] * d]); continue; }
    mx /= ml; mz /= ml;
    const k = Math.min(3, 1 / Math.max(0.33, mx * n1[0] + mz * n1[1]));
    out.push([p[i][0] + mx * d * k, p[i][1] + mz * d * k]);
  }
  return out;
}
/** Distance from point (px,pz) travelling along direction (dx,dz) until the polygon boundary is hit (excluding edge `skip`). */
export function rayToPolygon(px, pz, dx, dz, poly, skip = -1, maxT = 1e9) {
  let best = maxT;
  for (let i = 0; i < poly.length; i++) {
    if (i === skip) continue;
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - px) * ez - (a[1] - pz) * ex) / den;
    const u = ((a[0] - px) * dz - (a[1] - pz) * dx) / den;
    if (t > 1e-4 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
}
export function distToSegment(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}
export function rectPoly(cx, cz, w, d, rotY = 0) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return ensureCW([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c]));
}
export function rotYOf(dx, dz) { return Math.atan2(-dz, dx); }

/** Edge of a polyArea>0 polygon whose outward normal best matches direction (dx,dz). */
export function bestEdge(poly, dx, dz) {
  let best = null, bd = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [nx, nz] = edgeNormal(poly, i);
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d = (nx * dx + nz * dz) * Math.min(1, len / 8);
    if (d > bd) { bd = d; best = { i, a, b, nx, nz, len, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], tx: (b[0] - a[0]) / len, tz: (b[1] - a[1]) / len }; }
  }
  return best;
}
/** Cut every corner of a polygon by `c` metres along both adjacent edges (45° chamfers for rectangles). */
export function chamferPoly(polyIn, c) {
  const p = ensureCW(polyIn), n = p.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n], b = p[i], d = p[(i + 1) % n];
    const l0 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, l1 = Math.hypot(d[0] - b[0], d[1] - b[1]) || 1;
    const k0 = Math.min(c, l0 * 0.45), k1 = Math.min(c, l1 * 0.45);
    out.push([b[0] + (a[0] - b[0]) / l0 * k0, b[1] + (a[1] - b[1]) / l0 * k0], [b[0] + (d[0] - b[0]) / l1 * k1, b[1] + (d[1] - b[1]) / l1 * k1]);
  }
  return out;
}
function segsIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return false;
  const q = [c[0] - a[0], c[1] - a[1]];
  const t = (q[0] * s[1] - q[1] * s[0]) / den, u = (q[0] * r[1] - q[1] * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
/** True when polygon and axis-aligned rect {x0,z0,x1,z1} overlap (vertex containment or edge crossing). */
export function polyRectOverlap(poly, r) {
  const rp = [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]];
  for (const [x, z] of poly) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return true;
  for (const [x, z] of rp) if (pointInPoly(x, z, poly)) return true;
  for (let i = 0; i < poly.length; i++) for (let j = 0; j < 4; j++) if (segsIntersect(poly[i], poly[(i + 1) % poly.length], rp[j], rp[(j + 1) % 4])) return true;
  return false;
}
/** Thin OBB wall per polygon edge (+ a fill box at the centroid) for irregular footprints. World coordinates. */
export function edgeColliders(polyIn, h, thick = 1.0) {
  const poly = ensureCW(polyIn);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    const [nx, nz] = edgeNormal(poly, i);
    out.push({ obb: { center: new THREE.Vector3((a[0] + b[0]) / 2 - nx * thick / 2, h / 2, (a[1] + b[1]) / 2 - nz * thick / 2), halfSize: new THREE.Vector3(len / 2, h / 2, thick / 2), rotationY: Math.atan2(-dz, dx) } });
  }
  // fill box at the AREA centroid (a vertex average is dragged toward any densely sampled curve — Q-FRONT's bulge
  // pushed its box 2.5 m out into the crossing), shrunk until its corners and edge midpoints are inside the outline
  let A = 0, cx = 0, cz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const cr = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]; A += cr; cx += (poly[j][0] + poly[i][0]) * cr; cz += (poly[j][1] + poly[i][1]) * cr; }
  const c = Math.abs(A) > 1e-6 ? [cx / (3 * A), cz / (3 * A)] : polyCentroid(poly), b = polyBounds(poly);
  let hx = b.w * 0.22, hz = b.d * 0.22;
  const fits = () => [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]].every(([u, v]) => pointInPoly(c[0] + u * hx, c[1] + v * hz, poly));
  for (let k = 0; k < 12 && !fits(); k++) { hx *= 0.8; hz *= 0.8; }
  if (pointInPoly(c[0], c[1], poly)) out.push({ obb: { center: new THREE.Vector3(c[0], h / 2, c[1]), halfSize: new THREE.Vector3(hx, h / 2, hz), rotationY: 0 } });
  return out;
}

// ------------------------------------------------------------------------------------------------- geometry
function finish(pos, nor, uv, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (idx) g.setIndex(idx);
  return g;
}
/**
 * Prism from a polygon (world x/z, any winding): side walls with metre UVs (u along the edge, v = height) and an
 * optional top cap (uv in metres) / bottom cap. Returns one indexed BufferGeometry.
 */
export function extrudePolygon(polyIn, y0, y1, { cap = true, bottom = false, uvScale = 1, sides = true, u0 = 0, uFace = 0, faceUV = null } = {}) {
  // uFace: seed → every face starts at its own hashed u (breaks curtain-wall phase matching between faces);
  // faceUV(i, len) → { su, sv, u0, v0 } per-face scale / origin (mullion grids that must land on the window bays)
  const poly = ensureCW(polyIn);
  const pos = [], nor = [], uv = [], idx = [];
  let vi = 0;
  if (sides) {
    let u = u0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
      const nx = dz / len, nz = -dx / len;
      pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y1, a[1]);
      for (let k = 0; k < 4; k++) nor.push(nx, 0, nz);
      if (uFace) u = u0 + Math.floor(hash(i, 3, uFace) * 64) * 1.5 + hash(i, 4, uFace) * 97;
      const f = faceUV ? faceUV(i, len) : null;
      const su = f ? f.su : uvScale, sv = f ? f.sv : uvScale, fu = f ? f.u0 : u, fv = f ? f.v0 : 0;
      uv.push(fu * su, (y0 + fv) * sv, (fu + len) * su, (y0 + fv) * sv, (fu + len) * su, (y1 + fv) * sv, fu * su, (y1 + fv) * sv);
      idx.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2);
      vi += 4; u += len;
    }
  }
  const capIt = (y, up) => {
    const v2 = poly.map(([x, z]) => new THREE.Vector2(x, z));
    const tris = THREE.ShapeUtils.triangulateShape(v2, []);
    const base = vi;
    for (const [x, z] of poly) { pos.push(x, y, z); nor.push(0, up ? 1 : -1, 0); uv.push(x * uvScale, z * uvScale); vi++; }
    for (const [a, b, c] of tris) {
      // winding: make the normal point up (or down)
      const ax = poly[a][0], az = poly[a][1], bx = poly[b][0], bz = poly[b][1], cx = poly[c][0], cz = poly[c][1];
      const ny = -((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
      if ((ny > 0) === up) idx.push(base + a, base + b, base + c); else idx.push(base + a, base + c, base + b);
    }
  };
  if (cap) capIt(y1, true);
  if (bottom) capIt(y0, false);
  return finish(pos, nor, uv, idx);
}
/** Flat polygon at height y (top cap only), uv in metres × uvScale. */
export function polygonCap(poly, y, uvScale = 1) { return extrudePolygon(poly, y - 1, y, { sides: false, cap: true, uvScale }); }
/**
 * Side walls between two polygons with the same vertex count (bottom at y0, top at y1): tapered shafts, crowns.
 * Metre UVs (u along the edge, v = height × uvScale).
 */
export function loft(polyA, polyB, y0, y1, { uvScale = 1, u0 = 0, uFace = 0 } = {}) {
  const a = ensureCW(polyA), b = ensureCW(polyB), n = Math.min(a.length, b.length);
  const pos = [], nor = [], uv = [], idx = [];
  let u = u0, vi = 0;
  for (let i = 0; i < n; i++) {
    const a0 = a[i], a1 = a[(i + 1) % n], b0 = b[i], b1 = b[(i + 1) % n];
    const ex = a1[0] - a0[0], ez = a1[1] - a0[1], len = Math.hypot(ex, ez) || 1;
    if (uFace) u = u0 + Math.floor(hash(i, 3, uFace) * 64) * 1.5 + hash(i, 4, uFace) * 97;   // per-face hashed u start
    const dy = y1 - y0, ix = (b0[0] + b1[0] - a0[0] - a1[0]) / 2, iz = (b0[1] + b1[1] - a0[1] - a1[1]) / 2;
    // normal = edge × up-slope, normalised
    let nx = ez * dy, ny = ex * iz - ez * ix, nz = -ex * dy;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    pos.push(a0[0], y0, a0[1], a1[0], y0, a1[1], b1[0], y1, b1[1], b0[0], y1, b0[1]);
    for (let k = 0; k < 4; k++) nor.push(nx, ny, nz);
    uv.push(u * uvScale, y0 * uvScale, (u + len) * uvScale, y0 * uvScale, (u + len) * uvScale, y1 * uvScale, u * uvScale, y1 * uvScale);
    idx.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2);
    vi += 4; u += len;
  }
  return finish(pos, nor, uv, idx);
}
/** Flip a geometry inside out (reverse winding, negate normals) — inner dark shells. */
export function flipGeo(g) {
  if (g.index) { const ix = g.index; for (let i = 0; i < ix.count; i += 3) { const b = ix.getX(i + 1); ix.setX(i + 1, ix.getX(i + 2)); ix.setX(i + 2, b); } ix.needsUpdate = true; }
  const n = g.attributes.normal; if (n) { for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i)); n.needsUpdate = true; }
  return g;
}

/** Quad from four world points (a,b,c,d in order, outward-facing winding computed from the given normal). */
export function quad(a, b, c, d, normal, uvs = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
  const pos = [...a, ...b, ...c, ...d];
  const nor = []; for (let k = 0; k < 4; k++) nor.push(normal[0], normal[1], normal[2]);
  const uv = []; for (const [u, v] of uvs) uv.push(u, v);
  // check winding against the normal
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const dot = cr[0] * normal[0] + cr[1] * normal[1] + cr[2] * normal[2];
  const idx = dot >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  return finish(pos, nor, uv, idx);
}
/**
 * Wall-mounted quad: centre (cx,cy,cz), outward normal (nx,nz), width w, height h, lifted `lift` metres off the wall.
 * uvs: [u0,v0,u1,v1] atlas rectangle.
 */
export function wallQuad(cx, cy, cz, nx, nz, w, h, lift = 0.02, uvr = [0, 0, 1, 1]) {
  const tx = nz, tz = -nx;   // tangent (left→right when facing the wall from outside)
  const x = cx + nx * lift, z = cz + nz * lift;
  const a = [x - tx * w / 2, cy - h / 2, z - tz * w / 2], b = [x + tx * w / 2, cy - h / 2, z + tz * w / 2];
  const c = [x + tx * w / 2, cy + h / 2, z + tz * w / 2], d = [x - tx * w / 2, cy + h / 2, z - tz * w / 2];
  return quad(a, b, c, d, [nx, 0, nz], [[uvr[0], uvr[1]], [uvr[2], uvr[1]], [uvr[2], uvr[3]], [uvr[0], uvr[3]]]);
}
/** Axis box placed in world: centre (x,y,z), size, rotY. UVs in metres on every face when uvMetres. */
export function boxAt(x, y, z, w, h, d, rotY = 0, uvMetres = false) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (uvMetres) {
    const uv = g.attributes.uv;
    const rep = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * rep[f][0], uv.getY(i) * rep[f][1]); }
  }
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}
/** Horizontal flat rectangle at height y (decal), centre (x,z), length along dir, width across, uv 0..1. */
export function stripRect(x, z, len, wid, rotY, y, uvr = [0, 0, 1, 1]) {
  const g = new THREE.PlaneGeometry(len, wid);
  const uv = g.attributes.uv;
  for (let i = 0; i < 4; i++) uv.setXY(i, uvr[0] + uv.getX(i) * (uvr[2] - uvr[0]), uvr[1] + uv.getY(i) * (uvr[3] - uvr[1]));
  g.rotateX(-Math.PI / 2); g.rotateY(rotY); g.translate(x, y, z);
  return g;
}
/**
 * Ribbon along a polyline [[x,z]...] of total width w at height y (or y(x,z) fn), miter joins. u = metres along
 * (× uScale), v 0..1 across. Optional `offset` shifts the whole ribbon to the left (+) / right (−) of travel.
 */
export function ribbon(pts, w, y = 0, { uScale = 1, offset = 0, vRange = [0, 1], closed = false } = {}) {
  const n = pts.length;
  if (n < 2) return null;
  const pos = [], nor = [], uv = [], idx = [];
  const yAt = typeof y === 'function' ? y : () => y;
  let u = 0;
  const left = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(n - 1, i + 1)];
    const d0 = [b[0] - a[0], b[1] - a[1]], d1 = [c[0] - b[0], c[1] - b[1]];
    const l0 = Math.hypot(d0[0], d0[1]) || 1, l1 = Math.hypot(d1[0], d1[1]) || 1;
    const n0 = [d0[1] / l0, -d0[0] / l0], n1 = [d1[1] / l1, -d1[0] / l1];   // right-hand normals (x,z)
    let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = n1[0]; mz = n1[1]; } else { mx /= ml; mz /= ml; }
    const k = Math.min(2.5, 1 / Math.max(0.4, mx * n1[0] + mz * n1[1]));
    left.push([-mx * k, -mz * k]);
  }
  for (let i = 0; i < n; i++) {
    if (i > 0) u += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const [lx, lz] = left[i];
    const ox = lx * offset, oz = lz * offset;
    const xl = pts[i][0] + ox + lx * w / 2, zl = pts[i][1] + oz + lz * w / 2;
    const xr = pts[i][0] + ox - lx * w / 2, zr = pts[i][1] + oz - lz * w / 2;
    pos.push(xl, yAt(xl, zl), zl, xr, yAt(xr, zr), zr);
    nor.push(0, 1, 0, 0, 1, 0);
    uv.push(u * uScale, vRange[1], u * uScale, vRange[0]);
    if (i > 0) { const b = (i - 1) * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
  }
  return finish(pos, nor, uv, idx);
}
export function polylineLength(pts) { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return l; }
export function offsetPolyline(pts, off) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    out.push([pts[i][0] + (dz / l) * off, pts[i][1] - (dx / l) * off]);  // + = left of travel (when +z is south, left = north side for eastbound)
  }
  return out;
}
/** Resample a polyline every `step` metres (keeps corners). */
export function resample(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(l / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
/** Points along a polyline: {x,z,dx,dz,s} every `step` metres starting at `start`. */
export function alongPolyline(pts, step, start = 0) {
  const out = [];
  let s = start, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dx = (b[0] - a[0]) / (l || 1), dz = (b[1] - a[1]) / (l || 1);
    while (s <= acc + l) { const t = (s - acc) / (l || 1); out.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx, dz, s }); s += step; }
    acc += l;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- batching
const KEEP_ATTR = new Set(['position', 'normal', 'uv', 'cell', 'room', 'color', 'binfo']);   // extras: shop interior quads, tile jitter, wall macro info
function normalizeGeo(g) {
  // keep position/normal/uv (+ the few custom attributes the builders use) so any mix of generated geometries can merge
  for (const name of Object.keys(g.attributes)) if (!KEEP_ATTR.has(name)) g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}
/** Collects geometries per material (+ optional spatial chunk) and emits one merged Mesh per key. */
export class GeoBatch {
  // lift: metres added to every geometry added while it is set (city.js raises a building standing on a slope)
  // noShadow: materials whose merged meshes never cast (flat ground-level parts: sidewalk, kerb, sills)
  constructor({ chunk = 0, origin = 1000 } = {}) { this.map = new Map(); this.chunk = chunk; this.origin = origin; this.tris = 0; this.lift = 0; this.noShadow = new Set(); }
  key(mat, x, z) {
    if (!this.chunk) return mat;
    if (this.clampX != null && x < this.clampX) x = this.clampX;   // beyond-the-edge backdrop merges into the edge chunk
    const cx = Math.floor((x + this.origin) / this.chunk), cz = Math.floor((z + this.origin) / this.chunk);
    const k = `${cx},${cz}`;
    if (!mat.__chunks) mat.__chunks = new Map();
    let o = mat.__chunks.get(k);
    if (!o) { o = { mat, k }; mat.__chunks.set(k, o); }
    return o;
  }
  add(mat, geo, x = 0, z = 0) {
    if (!geo) return;
    normalizeGeo(geo);
    if (this.lift) geo.translate(0, this.lift, 0);
    const key = this.key(mat, x, z);
    if (!this.map.has(key)) this.map.set(key, { mat, geos: [] });
    this.map.get(key).geos.push(geo);
    this.tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  }
  build(parent, { castShadow = true, receiveShadow = true, name = 'batch', layer = null, mergeBelow = 0 } = {}) {
    const meshes = [];
    // materials whose whole-city geometry is small (< mergeBelow tris) are not worth a draw call per chunk: their
    // chunks merge into one mesh (always drawn — trims, lamps, lattice, low-poly walls, small landmark parts)
    if (mergeBelow > 0) {
      const byMat = new Map();
      for (const [key, e] of this.map) { if (key === e.mat) continue; let o = byMat.get(e.mat); if (!o) byMat.set(e.mat, o = { keys: [], tris: 0 }); o.keys.push(key); for (const g of e.geos) o.tris += (g.index ? g.index.count : g.attributes.position.count) / 3; }
      for (const [mat, o] of byMat) {
        if (o.keys.length < 2 || o.tris >= mergeBelow || mat.userData.keepChunks) continue;
        const all = []; for (const k of o.keys) { all.push(...this.map.get(k).geos); this.map.delete(k); }
        this.map.set(mat, { mat, geos: all, merged: true });
      }
    }
    for (const [, { mat, geos, merged: wholeCity }] of this.map) {
      // custom attributes must be present on every geometry of the batch, else mergeGeometries refuses: the ones a
      // material's shader reads (mat.userData.attrs [[name, size]]) are zero-filled where missing, the rest dropped
      const need = new Map((mat.userData.attrs || []).map(([k, n]) => [k, n]));
      for (const g of geos) for (const [k, n] of need) if (!g.attributes[k]) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * n), n));
      const extra = new Set(); for (const g of geos) for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') extra.add(k);
      for (const k of extra) if (!geos.every(g => g.attributes[k])) for (const g of geos) if (g.attributes[k]) g.deleteAttribute(k);
      const allIndexed = geos.every(g => !!g.index);
      const list = allIndexed ? geos : geos.map(g => (g.index ? g.toNonIndexed() : g));
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) { console.warn('[city] merge failed for', mat.name); continue; }
      const mesh = new THREE.Mesh(merged, mat);
      // a mesh merged across the whole city has no useful culling bounds and would draw in every shadow cascade:
      // only the landmark masses (keepShadow) still cast from it; trims, lamps and small parts rely on GTAO
      mesh.castShadow = castShadow && !(wholeCity && !mat.userData.keepShadow) && !mat.userData.noShadow && !this.noShadow.has(mat); mesh.receiveShadow = receiveShadow;
      mesh.name = `${name}:${mat.name || 'mat'}`;
      if (layer != null) mesh.layers.enable(layer);
      if (mat.userData.layer != null) mesh.layers.enable(mat.userData.layer);
      if (mat.userData.renderOrder != null) mesh.renderOrder = mat.userData.renderOrder;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.map.clear();
    return meshes;
  }
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0), _n = new THREE.Vector3(), _qt = new THREE.Quaternion();
// thin parts whose shadows are sub-pixel at shadow-map resolution
export const INSTANCE_NO_SHADOW = new Set(['stair', 'ladder', 'pipe', 'grate', 'manhole', 'roofRail', 'antenna', 'ac', 'acBig', 'tank', 'lm_railpost', 'lm_mullion', 'lm_commuter', 'platLight', 'sleeper']);
/**
 * Accumulates instance transforms per (geometry, material) and emits InstancedMeshes. With `chunk` the instances are
 * bucketed on a spatial grid (one InstancedMesh per name + cell, each with its own bounding sphere) so frustum
 * culling can drop the cells out of view, in the main pass and the shadow pass alike.
 */
export class Instancer {
  constructor({ chunk = 0, origin = 1000, noShadow = INSTANCE_NO_SHADOW } = {}) { this.items = new Map(); this.lift = 0; this.chunk = chunk; this.origin = origin; this.noShadow = noShadow; }
  /** `up` (optional [nx, ny, nz]): tilt the instance so its local +y follows a sloped surface normal. */
  add(name, geo, mat, x, y, z, rotY = 0, sx = 1, sy = 1, sz = 1, color = null, up = null) {
    const key = this.chunk ? `${name}:${Math.floor((x + this.origin) / this.chunk)},${Math.floor((z + this.origin) / this.chunk)}` : name;
    let it = this.items.get(key);
    if (!it) { it = { name, geo, mat, list: [] }; this.items.set(key, it); }
    it.list.push([x, y + this.lift, z, rotY, sx, sy, sz, color, up]);
  }
  count(name) { let n = 0; for (const it of this.items.values()) if (it.name === name) n += it.list.length; return n; }
  build(parent, { castShadow = true, layer = null, mergeBelow = 0 } = {}) {
    const meshes = [];
    if (mergeBelow > 0) {
      const byName = new Map();
      for (const [key, it] of this.items) { if (key === it.name) continue; let o = byName.get(it.name); if (!o) byName.set(it.name, o = { keys: [], tris: 0 }); o.keys.push(key); o.tris += it.list.length * ((it.geo.index ? it.geo.index.count : it.geo.attributes.position.count) / 3); }
      for (const [name, o] of byName) {
        if (o.keys.length < 2 || o.tris >= mergeBelow) continue;
        const first = this.items.get(o.keys[0]), list = [];
        for (const k of o.keys) { list.push(...this.items.get(k).list); this.items.delete(k); }
        this.items.set(name, { name, geo: first.geo, mat: first.mat, list, merged: true });
      }
    }
    for (const [key, it] of this.items) {
      const n = it.list.length, name = it.name;
      if (!n) continue;
      normalizeGeo(it.geo);
      const im = new THREE.InstancedMesh(it.geo, it.mat, n);
      let hasColor = false;
      it.list.forEach(([x, y, z, r, sx, sy, sz, col, up], i) => {
        _q.setFromAxisAngle(_up, r); _s.set(sx, sy, sz); _p.set(x, y, z);
        if (up) { _n.set(up[0], up[1], up[2]).normalize(); _qt.setFromUnitVectors(_up, _n); _q.premultiply(_qt); }
        _m.compose(_p, _q, _s); im.setMatrixAt(i, _m);
        if (col != null) { im.setColorAt(i, _c.set(col)); hasColor = true; }
      });
      if (hasColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = castShadow && !it.mat.userData.noShadow && !(this.noShadow && this.noShadow.has(name)); im.receiveShadow = true;
      im.name = 'inst:' + key;
      if (layer != null) im.layers.enable(layer);
      parent.add(im);
      meshes.push(im);
    }
    this.items.clear();
    return meshes;
  }
}

// ------------------------------------------------------------------------------------------------- textures
export function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
// [mobile] a finished canvas is redrawn at the phone's texture cap and the full-size one let go (mobileProfile.js
// fitCanvasTexture); an atlas still being painted after this call passes live: true
export function canvasTex(c, { srgb = true, repeat = null, wrap = false, aniso = 8, mips = true, live = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping; else t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso; t.generateMipmaps = mips; t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return live ? t : fitCanvasTexture(t, 'lib');
}
export function fitFont(ctx, text, maxW, maxH, weight, family) {
  let size = maxH;
  for (let i = 0; i < 14; i++) {
    ctx.font = `${weight} ${size}px ${family}`;
    const w = ctx.measureText(text).width;
    if (w <= maxW) break;
    size = Math.floor(size * Math.min(0.92, maxW / w));
  }
  return size;
}
/**
 * Draw a sign face into a canvas: solid/gradient bg, text (auto-fit, JP/latin font), optional sub line, vertical mode,
 * border, subtle panel shading. Returns the canvas.
 */
export function textCanvas({ w = 512, h = 128, text = '', sub = null, bg = '#c8102e', bg2 = null, fg = '#fff', font = null, weight = '800', vertical = false, border = null, align = 'center', pad = 0.06, shade = true, letterSpacing = 0 } = {}) {
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  if (bg2) { const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, bg); g.addColorStop(1, bg2); ctx.fillStyle = g; } else ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (shade) { const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.16)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.05); ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth); }
  const family = font || (isJP(text) ? FONT_JP : FONT_LATIN);
  ctx.fillStyle = fg; ctx.textBaseline = 'middle';
  if (letterSpacing) ctx.letterSpacing = `${letterSpacing}px`;
  const px = w * pad, py = h * pad;
  if (vertical) {
    const chars = [...text];
    const size = Math.min((w - 2 * px) * 0.86, (h - 2 * py) / chars.length * 0.92);
    ctx.font = `${weight} ${size}px ${family}`; ctx.textAlign = 'center';
    const total = size * chars.length * 1.05, y0 = (h - total) / 2;
    chars.forEach((ch, i) => ctx.fillText(ch, w / 2, y0 + size * 1.05 * (i + 0.5)));
  } else if (sub) {
    const size = fitFont(ctx, text, w - 2 * px, (h - 2 * py) * 0.55, weight, family);
    ctx.textAlign = align; const x = align === 'left' ? px : align === 'right' ? w - px : w / 2;
    ctx.font = `${weight} ${size}px ${family}`; ctx.fillText(text, x, h * 0.37);
    const fam2 = isJP(sub) ? FONT_JP : FONT_LATIN;
    const s2 = fitFont(ctx, sub, w - 2 * px, (h - 2 * py) * 0.26, '600', fam2);
    ctx.font = `600 ${s2}px ${fam2}`; ctx.fillText(sub, x, h * 0.76);
  } else {
    const size = fitFont(ctx, text, w - 2 * px, (h - 2 * py) * 0.8, weight, family);
    ctx.textAlign = align; const x = align === 'left' ? px : align === 'right' ? w - px : w / 2;
    ctx.font = `${weight} ${size}px ${family}`; ctx.fillText(text, x, h * 0.53);
  }
  return c;
}
export const signMaterials = new Set();
/** Emissive sign material from a canvas (emissive follows lib.setNight). */
export function signMaterial(canvas, { emissive = 1.2, roughness = 0.5, metalness = 0.05, transparent = false, side = THREE.FrontSide, unlit = false } = {}) {
  const tex = canvasTex(canvas);
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: emissive, roughness, metalness, transparent, side });
  mat.userData.sign = { emissive, unlit };
  mat.name = 'sign';
  signMaterials.add(mat);
  return mat;
}
/** Plane mesh w×h (metres) at (x,y,z) facing normal (nx,nz). bloom layer 1. */
export function signMesh({ text, sub = null, w = 4, h = 1, bg = '#c8102e', bg2 = null, fg = '#fff', emissive = 1.2, vertical = false, border = null, weight = '800', font = null, ppm = 64, double = false, letterSpacing = 0 }) {
  const W = Math.min(1024, Math.max(64, Math.round(w * ppm))), H = Math.min(1024, Math.max(32, Math.round(h * ppm)));
  const c = textCanvas({ w: W, h: H, text, sub, bg, bg2, fg, vertical, border, weight, font, letterSpacing });
  const mat = signMaterial(c, { emissive, side: double ? THREE.DoubleSide : THREE.FrontSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.name = 'citySign:' + text;
  mesh.layers.enable(1);
  return mesh;
}
export function placeFacing(mesh, x, y, z, nx, nz) {
  mesh.position.set(x, y, z);
  mesh.lookAt(x + nx, y, z + nz);
  return mesh;
}
let night = 1;
export function setNight(f) {
  night = f;
  for (const m of signMaterials) { const s = m.userData.sign; m.emissiveIntensity = s.unlit ? 0 : s.emissive * (0.18 + 0.82 * f); }
}
export function getNight() { return night; }

/** Simple repeating procedural texture: base colour + noise + optional draw callback (ctx, size). */
export function noiseTex({ size = 256, base = [128, 128, 128], variance = 14, seed = 1, low = 0.6, draw = null, srgb = true } = {}) {
  const c = makeCanvas(size, size), ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  const cell = Math.max(2, size >> 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n1 = hash(x, y, seed) - 0.5;
    const cx = x / cell | 0, cy = y / cell | 0, fx = (x % cell) / cell, fy = (y % cell) / cell;
    const a = hash(cx, cy, seed + 7), b = hash((cx + 1) % 16, cy, seed + 7), cc = hash(cx, (cy + 1) % 16, seed + 7), dd = hash((cx + 1) % 16, (cy + 1) % 16, seed + 7);
    const n2 = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + dd * fx) * fy - 0.5;
    const v = n1 * variance + n2 * variance * 2 * low;
    const i = (y * size + x) * 4;
    d[i] = Math.max(0, Math.min(255, base[0] + v)); d[i + 1] = Math.max(0, Math.min(255, base[1] + v)); d[i + 2] = Math.max(0, Math.min(255, base[2] + v)); d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (draw) draw(ctx, size);
  return canvasTex(c, { srgb, wrap: true });
}
export function std(o) { const m = new THREE.MeshStandardMaterial(o); return m; }

export default { hash, polyArea, ensureCW, polyCentroid, polyBounds, pointInPoly, edgeNormal, offsetPolygon, rayToPolygon, distToSegment, rectPoly, rotYOf, chamferPoly, polyRectOverlap, extrudePolygon, polygonCap, loft, flipGeo, quad, wallQuad, boxAt, stripRect, ribbon, polylineLength, offsetPolyline, resample, alongPolyline, GeoBatch, Instancer, makeCanvas, canvasTex, textCanvas, signMaterial, signMesh, placeFacing, setNight, getNight, noiseTex, std, FONT_JP, FONT_LATIN };
