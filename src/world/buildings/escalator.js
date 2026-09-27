// [city] Moving escalators and stairs for the station-side buildings (Scramble Square's 東口 アーバン・コア, the Metro
// exits). One shared step material whose texture scrolls (tickEscalators, called from city.update): every escalator
// is a few quads, so a dozen of them cost one extra draw call. Up and down runs share the texture — the direction
// comes from the UV orientation of each run.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { SW_H } from './streets.js';

let stepMat = null, stepTex = null;
function steps() {
  if (stepMat) return stepMat;
  const c = L.makeCanvas(128, 128), g = c.getContext('2d');
  g.fillStyle = '#6c7076'; g.fillRect(0, 0, 128, 128);
  for (let x = 0; x < 128; x += 8) { g.fillStyle = '#4a4e54'; g.fillRect(x, 0, 3, 128); }                  // cleats
  g.fillStyle = '#1e2024'; g.fillRect(0, 0, 128, 10);                                                          // riser shadow
  g.fillStyle = '#e8c830'; g.fillRect(0, 118, 6, 10); g.fillRect(122, 118, 6, 10); g.fillRect(0, 10, 128, 3); // yellow demarcation
  stepTex = L.canvasTex(c, { wrap: true, repeat: [1, 1] });
  stepTex.wrapS = stepTex.wrapT = THREE.RepeatWrapping;
  stepMat = new THREE.MeshStandardMaterial({ map: stepTex, roughness: 0.55, metalness: 0.5, envMapIntensity: 0.8, name: 'lm_escStep' });
  return stepMat;
}
let _t = 0;
/** Advance the step texture (0.5 m/s at the 0.4 m step pitch). */
export function tickEscalators(dt) { if (!stepTex) return; _t += dt || 0; stepTex.offset.y = -(_t * 0.5 / 0.4) % 1; }

/**
 * One escalator from the lower landing (x0, y0, z0) to the upper one (x1, y1, z1), width w (tread), up = travels
 * toward the upper landing. Flat 1.2 m landings at both ends, truss skirts, glass balustrades, black handrails.
 * `colliders` gets a box over the whole run (nobody walks through an escalator).
 */
export function escalator(batch, inst, x0, y0, z0, x1, y1, z1, { w = 1.0, up = true, colliders = null } = {}) {
  const M = S.mats(), SM = steps();
  const dx = x1 - x0, dz = z1 - z0, run = Math.hypot(dx, dz), ux = dx / run, uz = dz / run, lx = -uz, lz = ux;
  const land = 1.2, rise = y1 - y0, slope = Math.hypot(run - 2 * land, rise);
  // centreline samples: lower landing, incline, upper landing
  const P = [[x0, y0, z0], [x0 + ux * land, y0, z0 + uz * land], [x1 - ux * land, y1, z1 - uz * land], [x1, y1, z1]];
  const hw = w / 2;
  let v = 0;
  for (let i = 0; i < 3; i++) {
    const a = P[i], b = P[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const A = (p, s) => [p[0] + lx * hw * s, p[1] + 0.02, p[2] + lz * hw * s];
    const vA = v, vB = v + len / 0.4; v = vB;
    const [q0, q1] = up ? [vA, vB] : [-vA, -vB];
    const nrm = new THREE.Vector3(-(b[0] - a[0]) * (b[1] - a[1]), (b[0] - a[0]) ** 2 + (b[2] - a[2]) ** 2, -(b[2] - a[2]) * (b[1] - a[1])).normalize();
    batch.add(SM, L.quad(A(a, -1), A(a, 1), A(b, 1), A(b, -1), [nrm.x, nrm.y, nrm.z], [[0, q0], [1, q0], [1, q1], [0, q1]]), a[0], a[2]);
    // truss skirts + glass balustrades + handrails on both sides
    for (const s of [-1, 1]) {
      const ox = lx * (hw + 0.1) * s, oz = lz * (hw + 0.1) * s;
      const sa = [a[0] + ox, a[1], a[2] + oz], sb = [b[0] + ox, b[1], b[2] + oz];
      const n = [lx * s, 0, lz * s];
      batch.add(M.whiteMetal, L.quad([sa[0], sa[1] - 0.7, sa[2]], [sb[0], sb[1] - 0.7, sb[2]], [sb[0], sb[1] + 0.2, sb[2]], [sa[0], sa[1] + 0.2, sa[2]], n), a[0], a[2]);
      batch.add(M.whiteMetal, L.quad([sb[0], sb[1] - 0.7, sb[2]], [sa[0], sa[1] - 0.7, sa[2]], [sa[0], sa[1] + 0.2, sa[2]], [sb[0], sb[1] + 0.2, sb[2]], [-n[0], 0, -n[2]]), a[0], a[2]);
      batch.add(M.glassClear, L.quad([sa[0], sa[1] + 0.2, sa[2]], [sb[0], sb[1] + 0.2, sb[2]], [sb[0], sb[1] + 1.0, sb[2]], [sa[0], sa[1] + 1.0, sa[2]], n), a[0], a[2]);
      const mx = (sa[0] + sb[0]) / 2, my = (sa[1] + sb[1]) / 2 + 1.02, mz = (sa[2] + sb[2]) / 2, l = Math.hypot(sb[0] - sa[0], sb[1] - sa[1], sb[2] - sa[2]);
      const rail = new THREE.BoxGeometry(0.09, 0.06, l); rail.rotateX(-Math.atan2(sb[1] - sa[1], Math.hypot(sb[0] - sa[0], sb[2] - sa[2]))); rail.rotateY(Math.atan2(ux, uz)); rail.translate(mx, my, mz);
      batch.add(M.innerDark, rail, a[0], a[2]);
    }
  }
  // underside of the incline (seen from below / beside): a dark soffit slab
  const a = P[1], b = P[2];
  batch.add(M.whiteMetal, L.quad([b[0] - lx * (hw + 0.2), b[1] - 0.72, b[2] - lz * (hw + 0.2)], [b[0] + lx * (hw + 0.2), b[1] - 0.72, b[2] + lz * (hw + 0.2)], [a[0] + lx * (hw + 0.2), a[1] - 0.72, a[2] + lz * (hw + 0.2)], [a[0] - lx * (hw + 0.2), a[1] - 0.72, a[2] - lz * (hw + 0.2)], [0, -1, 0]), a[0], a[2]);
  for (const p of [P[0], P[3]]) S.ibox(inst, 'lm_escComb', M.silver, p[0], p[1] + 0.01, p[2], w + 0.3, 0.03, 0.5, Math.atan2(-uz, ux) + Math.PI / 2);
  if (colliders && Math.min(y0, y1) < 1.6) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    colliders.push(S.boxCollider(cx, cz, run, 1.2 + Math.max(0, Math.max(y0, y1)), w + 0.5, Math.atan2(-uz, ux), Math.min(0, Math.min(y0, y1))));
  }
  void slope;
}

/** A straight stair (treads + risers) from (x0, y0, z0) to (x1, y1, z1), width w, with side walls down into a well. */
export function stair(batch, x0, y0, z0, x1, y1, z1, { w = 2.6, mat = null } = {}) {
  const M = S.mats(), m = mat || M.stoneLight;
  const dx = x1 - x0, dz = z1 - z0, run = Math.hypot(dx, dz), ux = dx / run, uz = dz / run, lx = -uz, lz = ux;
  const n = Math.max(2, Math.round(Math.abs(y1 - y0) / 0.16)), tr = run / n, rs = (y1 - y0) / n;
  const r = Math.atan2(-uz, ux);
  for (let i = 0; i < n; i++) {
    const cx = x0 + ux * tr * (i + 0.5), cz = z0 + uz * tr * (i + 0.5), cy = y0 + rs * (i + 1);
    batch.add(m, L.boxAt(cx, (cy + Math.min(y0, y1) - 0.3) / 2, cz, tr + 0.01, Math.abs(cy - Math.min(y0, y1) + 0.3), w, r, false), cx, cz);
    batch.add(M.darkMetal, L.boxAt(cx - ux * tr * 0.42, cy + 0.005, cz - uz * tr * 0.42, 0.05, 0.012, w, r, false), cx, cz);   // nosing strip
  }
  void lx; void lz;
}

/** A well into the station levels over a CITY.groundHoles rectangle (the ground and pavement skip it): tiled walls, a
 *  lit landing 3 m down with the concourse sign facing up the run, escalators (up + down) or a stair descending
 *  toward `down`, a glass balustrade on three sides and colliders all round (the mouth is fenced too: nobody rides). */
export function well(batch, inst, h, colliders, { title, sub, escalators = true, fixture = null } = {}) {
  const M = S.mats(), DEP = 3.0, x0 = h.x0, x1 = h.x1, z0 = h.z0, z1 = h.z1, zc = (z0 + z1) / 2, cx = (x0 + x1) / 2;
  const wl = (x, z, nx, nz, w) => batch.add(M.tile, L.wallQuad(x, (SW_H - DEP - 0.3) / 2, z, nx, nz, w, SW_H + DEP + 0.3, 0.001), x, z);
  wl(cx, z0, 0, 1, x1 - x0); wl(cx, z1, 0, -1, x1 - x0); wl(x0, zc, 1, 0, z1 - z0); wl(x1, zc, -1, 0, z1 - z0);
  batch.add(M.stoneLight, L.boxAt(cx, -DEP - 0.1, zc, x1 - x0, 0.2, z1 - z0, 0, true), cx, zc);
  if (fixture) { fixture(cx, -0.9, zc, 0xf4f6ff, 7, 5); }
  // the concourse beyond the bottom landing: a lit portal on the west wall with the lines' board over it
  batch.add(M.interiorDim, L.wallQuad(x0, -DEP + 1.2, zc, 1, 0, z1 - z0 - 0.6, 2.4, 0.02), x0, zc);
  S.signQuad(batch, x0 + 0.05, -DEP + 2.75, zc, 1, 0, { text: title, sub, w: z1 - z0 - 0.4, h: 0.6, bg: '#f4f4f0', fg: '#1c56b7', emissive: 0.5, weight: '800' });
  for (let x = x0 + 0.6; x < x1; x += 1.4) for (const z of [z0 + 0.12, z1 - 0.12]) S.ibox(inst, 'lm_stripLight', M.glowWhite, x, -0.4, z, 0.8, 0.05, 0.06);
  if (escalators) {
    for (const [dz, up] of [[-0.85, false], [0.85, true]]) escalator(batch, inst, x0 + 0.15, -DEP, zc + dz, x1 - 0.05, SW_H, zc + dz, { up, w: 1.0 });
  } else stair(batch, x1 - 0.05, SW_H, zc, x0 + 1.2, -DEP, zc, { w: z1 - z0 - 0.3 });
  // balustrade (glass on a steel kerb) on the long sides and the far end, a low fence across the mouth
  for (const [ax, az, bx, bz] of [[x0, z0, x1, z0], [x0, z1, x1, z1], [x0, z0, x0, z1]]) {
    const l = Math.hypot(bx - ax, bz - az), r = Math.atan2(-(bz - az), bx - ax), mx = (ax + bx) / 2, mz = (az + bz) / 2;
    batch.add(M.glassClear, L.boxAt(mx, SW_H + 0.65, mz, l, 1.0, 0.04, r, false), mx, mz);
    batch.add(M.darkMetal, L.boxAt(mx, SW_H + 0.1, mz, l, 0.2, 0.16, r, false), mx, mz);
    batch.add(M.silver, L.boxAt(mx, SW_H + 1.17, mz, l, 0.05, 0.08, r, false), mx, mz);
    colliders.push(S.boxCollider(mx, mz, l, 1.2, 0.3, r));
  }
  colliders.push(S.boxCollider(x1 - 0.05, zc, 0.3, 1.2, z1 - z0));
}

export default { escalator, stair, well, tickEscalators };
