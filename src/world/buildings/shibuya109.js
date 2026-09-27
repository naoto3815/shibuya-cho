// [city] SHIBUYA 1O9 — silver corrugated drum (r 15 m, 10 storeys / 42 m) at the east apex of the wedge podium
// between 道玄坂 and 文化村通り, storey ledges, slit windows, the white/red "SHIBUYA 1O9" band on floors 9–10,
// entrance recess + canopy at the tip facing the crossing, 109 Forum Vision frame, vertical blade sign, rooftop
// plant. Everything static goes through ctx.batch / ctx.inst in WORLD space; the landmark group's origin is the
// drum centre (signage anchors are relative to it).
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { buildBuilding, getAtlases, shopQuad } from './genericBuilding.js';

export const KEYS = ['shibuya109'];
export const SIZE = { w: 63, d: 51, h: 42 };

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide, groundRel = null }) {
  const M = S.mats(), At = getAtlases();
  const [cx, cz] = data.cylinder.center;
  const R = data.cylinder.radius;                     // 15
  const H = data.size[1];                             // 42
  const SH = 4.2, GF = 4.5;                            // storey / ground floor
  const [fx, fz] = S.dirOf(data.rotY);                // front direction (toward the crossing)
  const th0 = Math.atan2(fz, fx);                     // drum angle of the entrance
  const TAU = Math.PI * 2;
  const colliders = [], facades = [];
  // 道玄坂 / 文化村通り climb along the wedge: the base is the lowest point (the apex); ground-floor glass bottoms hug
  // the rising pavement (groundRel = terrain above the base) and a granite skirt fills the step
  const hug = (g, y0, off) => {
    if (!groundRel) return g;
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) if (Math.abs(p.getY(i) - y0) < 1e-3) p.setY(i, Math.max(y0, groundRel(p.getX(i), p.getZ(i)) + off));
    return g;
  };

  // ---- wedge podium (8 storeys ≈ 33.6 m): white panel + ribbon windows, shops at street level, silver ledges
  const poly = L.ensureCW(data.polygon);
  const faces = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const [nx, nz] = L.edgeNormal(poly, i);
    const street = isStreetSide((a[0] + b[0]) / 2 + nx * 4, (a[1] + b[1]) / 2 + nz * 4);
    return { kind: street ? 'street' : 'alley', tenants: street ? ['SHIBUYA 1O9', 'UNIQRO', 'WEGA', 'ABC-MARK', 'STARBEANS COFFEE', 'ドトルコーヒー'] : [] };
  });
  // on the slope the podium's ground floor grows taller toward the apex (genericBuilding adds the pavement rise to it)
  const pod = buildBuilding({ id: key, poly, storeys: 8, style: 'office', gf: GF, sh: 4.15, wall: 3, faces, setback: false, noStairs: true, noPipes: true, colliders: 'edges', groundFloor: 'shop', groundRel }, { batch, inst, rng: rng.fork(1), pools, billboards: [] });
  colliders.push(...pod.colliders);
  for (const f of pod.facades) { f.kind = 'landmark'; facades.push(f); }
  S.rings(batch, M.silver, poly, pod.gf, pod.height - 1, 4.15, { out: 0.4, h: 0.4 });

  // ---- the drum
  const wallSeg = 96;
  // upper drum wall (floors 2–10) with slit windows every 4.2 m (texture rows are 3.5 m → vScale)
  batch.add(M.panelSilver, S.cylSegment(cx, cz, R, GF, H, 0, TAU, wallSeg, { metres: true, vScale: 3.5 / SH }), cx, cz);
  // ground floor: a ring of real shop windows. Each 2.4 m bay between mullions is an interior-mapped shop cell
  // (fashion rails + mannequins, cosmetics shelves, a café counter; 2.5 m deep in the shader) behind clear glass,
  // with a lit brand board in the transom above. Bays sample consecutive slices of the atlas wall at true scale.
  const ea = 0.72;                                                          // entrance half-angle
  const shopAt = At.shop.cells, PXM = 1008 / 14;                            // atlas: 14 m of shop wall per 1008 px
  const BRANDS = ['EMOBA', 'LIZ LIZA', 'WEGA', 'dazzlim', 'SPINZ', 'GYBA', 'MURUE', 'ZALA', 'SHIBUYA 1O9', 'CECIL McBEA', 'H&N', 'GO'];
  const bayUV = (type, k, w) => {
    const c = shopAt[type] || shopAt.generic, pw = Math.min(900, w * PXM), off = (k * 173) % (1008 - pw);
    return [c.u + (16 + off) / 4096, c.v0, c.u + (16 + off + pw) / 4096, c.v1];
  };
  const shopBay = (th, t1, r, k, types) => {
    const tm = (th + t1) / 2, c = Math.cos(tm), s = Math.sin(tm), w = 2 * r * Math.sin((t1 - th) / 2) - 0.18;
    const x = cx + c * r, z = cz + s * r;
    const g0 = groundRel ? Math.max(0, groundRel(x + c * 0.9, z + s * 0.9)) : 0;
    const y0 = 0.15 + g0, hh = Math.min(3.25, GF - 0.45 - y0);
    if (hh < 1.2) return;
    batch.add(At.shop.mat, shopQuad(x, y0 + hh / 2, z, c, s, w, hh, 0, bayUV(types[k % types.length], k, w)), cx, cz);
    const top = y0 + hh + 0.08, bh = Math.min(0.62, GF - 0.25 - top);
    if (bh > 0.3) { const uv = At.fascia.get(BRANDS[k % BRANDS.length], 109); batch.add(At.fascia.mat, L.wallQuad(x, top + bh / 2, z, c, s, w - 0.3, bh, 0.02, [uv.u0, uv.v0, uv.u1, uv.v1]), cx, cz); }
  };
  { let k = 0; for (let th = th0 + ea; th < th0 + TAU - ea - 0.02; th += 0.16, k++) shopBay(th, Math.min(th + 0.16, th0 + TAU - ea), R - 0.3, k, ['fashion', 'fashion', 'drug', 'fashion', 'fashion', 'drug', 'fashion', 'cafe']); }   // 1F: fashion + cosmetics (no generic shelving in a fashion building)
  batch.add(M.glassClear, hug(S.cylSegment(cx, cz, R, 0.15, GF - 0.1, th0 + ea, th0 + TAU - ea, wallSeg, { metres: true }), 0.15, 0.15), cx, cz);
  if (groundRel) batch.add(getAtlases().plinth, hug(S.cylSegment(cx, cz, R + 0.06, -0.3, 0.15, th0 + ea, th0 + TAU - ea, wallSeg, { metres: true }), 0.15, 0.17), cx, cz);
  for (let th = th0 + ea; th < th0 + TAU - ea; th += 0.16) {               // mullions
    const x = cx + Math.cos(th) * (R - 0.1), z = cz + Math.sin(th) * (R - 0.1);
    S.ibox(inst, 'lm_mullion', M.darkMetal, x, 0, z, 0.14, GF, 0.3, L.rotYOf(-Math.sin(th), Math.cos(th)));
  }
  // entrance recess at the apex: the back of the recess is five chords — shop windows at the ends, three pairs of
  // automatic glass doors (dark frames, transom, lit lobby behind) in the middle
  const Ri = R - 4.2;
  for (let j = 0; j < 5; j++) {
    const ta = th0 - ea + (2 * ea) * j / 5, tb = th0 - ea + (2 * ea) * (j + 1) / 5, tm = (ta + tb) / 2, c = Math.cos(tm), s = Math.sin(tm);
    const w = 2 * Ri * Math.sin((tb - ta) / 2), x = cx + c * Ri, z = cz + s * Ri, rot = L.rotYOf(-s, c);
    batch.add(At.shop.mat, shopQuad(x, 0.15 + 1.6, z, c, s, w - 0.1, 3.2, 0, bayUV('fashion', 40 + j * 3, w)), cx, cz);
    batch.add(M.silver, L.wallQuad(x, (3.35 + GF) / 2, z, c, s, w, GF - 3.35, 0.01), cx, cz);
    if (j > 0 && j < 4) {
      for (const o of [-w / 2 + 0.06, 0, w / 2 - 0.06]) batch.add(M.darkMetal, L.boxAt(x - s * o + c * 0.08, 1.6, z + c * o + s * 0.08, 0.1, 3.0, 0.14, rot, false), cx, cz);   // door stiles
      batch.add(M.darkMetal, L.boxAt(x + c * 0.08, 3.12, z + s * 0.08, w, 0.22, 0.16, rot, false), cx, cz);                                           // transom
      batch.add(M.glassClear, L.wallQuad(x, 1.6, z, c, s, w - 0.1, 2.9, 0.12), cx, cz);
      const uv = At.fascia.get('SHIBUYA 1O9', 109); batch.add(At.fascia.mat, L.wallQuad(x, 3.7, z, c, s, w - 0.4, 0.5, 0.03, [uv.u0, uv.v0, uv.u1, uv.v1]), cx, cz);
    }
  }
  for (const th of [th0 - ea, th0 + ea]) {
    const c = Math.cos(th), s = Math.sin(th);
    const inward = th === th0 - ea ? 1 : -1;                                 // wall normal points into the recess
    const nx = -s * inward, nz = c * inward;
    batch.add(M.silver, L.quad([cx + Ri * c, 0, cz + Ri * s], [cx + R * c, 0, cz + R * s], [cx + R * c, GF, cz + R * s], [cx + Ri * c, GF, cz + Ri * s], [nx, 0, nz]), cx, cz);
  }
  batch.add(M.darkMetal, S.disc(cx, cz, Ri, R, GF - 0.01, { seg: 24, up: false, th0: th0 - ea, th1: th0 + ea }), cx, cz);   // recess ceiling
  for (let k = -2; k <= 2; k++) { const th = th0 + k * 0.28; S.ibox(inst, 'lm_downlight', M.glowWarm, cx + Math.cos(th) * (R - 2), GF - 0.12, cz + Math.sin(th) * (R - 2), 0.5, 0.1, 0.5); }
  // canopy slab over the entrance (annular sector r 10.8..18.5)
  batch.add(M.silver, S.cylSegment(cx, cz, R + 3.5, GF, GF + 0.6, th0 - ea - 0.08, th0 + ea + 0.08, 32, { metres: true }), cx, cz);
  batch.add(M.silver, S.disc(cx, cz, Ri, R + 3.5, GF + 0.6, { seg: 32, up: true, th0: th0 - ea - 0.08, th1: th0 + ea + 0.08 }), cx, cz);
  batch.add(M.whiteMetal, S.disc(cx, cz, R, R + 3.5, GF, { seg: 32, up: false, th0: th0 - ea - 0.08, th1: th0 + ea + 0.08 }), cx, cz);
  for (let k = -2; k <= 2; k++) { const th = th0 + k * 0.3; S.ibox(inst, 'lm_downlight', M.glowWarm, cx + Math.cos(th) * (R + 1.8), GF - 0.1, cz + Math.sin(th) * (R + 1.8), 0.5, 0.1, 0.5); }
  // entrance fascia lettering on the canopy edge
  S.flatSign(group, cx + Math.cos(th0) * (R + 3.55), GF + 0.3, cz + Math.sin(th0) * (R + 3.55), Math.cos(th0), Math.sin(th0), { text: 'SHIBUYA 1O9', sub: 'ENTRANCE  10:00 – 21:00', w: 12, h: 0.6, bg: '#b80d28', fg: '#ffffff', emissive: 0.9 });   // red ground: a white one blooms into a bar
  // storey ledges (none through the sign band on floors 9–10); the drum itself is faintly emissive (floodlit),
  // so no cove strips — the band and the red trims are the only strong emissives
  for (let y = GF; y < H - 6.5; y += SH) {
    batch.add(M.silver, S.cylSegment(cx, cz, R + 0.38, y, y + 0.36, 0, TAU, wallSeg, { metres: true }), cx, cz);
    batch.add(M.silver, S.disc(cx, cz, R, R + 0.38, y + 0.36, { seg: wallSeg, up: true }), cx, cz);
    batch.add(M.darkMetal, S.disc(cx, cz, R, R + 0.38, y, { seg: wallSeg, up: false }), cx, cz);
  }
  // white band with red lettering (floors 9–10) + red trim lines
  S.wrapSign(group, { cx, cz, r: R + 0.3, y0: H - 5.6, y1: H - 1.6, th0: th0 - Math.PI, th1: th0 + Math.PI, text: 'SHIBUYA 1O9', bg: '#f0efec', fg: '#c8102e', repeat: 3, emissive: 0.85, weight: '900', seg: wallSeg, letterSpacing: 6 });
  batch.add(M.glowRed, S.cylSegment(cx, cz, R + 0.34, H - 5.9, H - 5.6, 0, TAU, wallSeg), cx, cz);
  batch.add(M.glowRed, S.cylSegment(cx, cz, R + 0.34, H - 1.6, H - 1.3, 0, TAU, wallSeg), cx, cz);
  // parapet + roof + plant
  batch.add(M.silver, S.cylSegment(cx, cz, R + 0.45, H, H + 1.3, 0, TAU, wallSeg, { metres: true }), cx, cz);
  batch.add(M.silver, S.disc(cx, cz, R - 0.3, R + 0.45, H + 1.3, { seg: wallSeg, up: true }), cx, cz);
  const roofPoly = S.arcPoints(cx, cz, R - 0.3, 0, TAU, 40).slice(0, -1);
  batch.add(S.roofMat(), L.polygonCap(roofPoly, H, 0.25), cx, cz);                                   // membrane roof
  S.roofPlant(batch, inst, roofPoly, H, { seed: 109, tanks: 2, ac: 7, ducts: 2, rail: true, inset: 2.5 });
  inst.add('antenna', At.geos.antenna, At.metal, cx + 2, H, cz + 8, 0);
  // rooftop "109" frame (steel lattice) on the crossing side
  {
    const tx = -Math.sin(th0), tz = Math.cos(th0);
    const px = cx + Math.cos(th0) * (R - 3), pz = cz + Math.sin(th0) * (R - 3);
    const rot = L.rotYOf(tx, tz);
    for (const o of [-6, 0, 6]) S.ibox(inst, 'lm_post', M.darkMetal, px + tx * o, H, pz + tz * o, 0.3, 7, 0.3, rot);
    batch.add(M.darkMetal, L.boxAt(px, H + 6.8, pz, 13.4, 0.3, 0.3, rot, false), cx, cz);
    S.flatSign(group, px + Math.cos(th0) * 0.3, H + 4.2, pz + Math.sin(th0) * 0.3, Math.cos(th0), Math.sin(th0), { text: '1O9', w: 12, h: 4.6, bg: '#c8102e', fg: '#ffffff', emissive: 1.6, weight: '900', double: true });
  }
  // 109 Forum Vision frame (screen itself comes from the signage module via anchors.screen)
  {
    const tx = -Math.sin(th0), tz = Math.cos(th0);
    const rot = L.rotYOf(tx, tz);
    batch.add(M.darkMetal, L.boxAt(cx + Math.cos(th0) * (R + 0.25), 11.5, cz + Math.sin(th0) * (R + 0.25), 10.8, 6.6, 0.5, rot, false), cx, cz);
    batch.add(M.glowWhite, L.boxAt(cx + Math.cos(th0) * (R + 0.5), 11.5 - 3.4, cz + Math.sin(th0) * (R + 0.5), 10.8, 0.12, 0.2, rot, false), cx, cz);
  }
  // vertical blade "SHIBUYA 1O9" (north side of the entrance, visible from the crossing)
  {
    const th = th0 - 0.62;
    const c = Math.cos(th), s = Math.sin(th);
    S.blade(batch, cx + c * (R + 1.2), 19, cz + s * (R + 1.2), -s, c, { text: 'SHIBUYA 1O9', w: 1.7, h: 22, bg: '#eeede9', fg: '#c8102e', emissive: 0.9, weight: '900' });
    for (const y of [9, 19, 29]) batch.add(M.darkMetal, L.boxAt(cx + c * (R + 0.6), y, cz + s * (R + 0.6), 1.3, 0.12, 0.12, L.rotYOf(c, s), false), cx, cz);
  }
  // wedge face signs (道玄坂 / 文化村通り)
  for (const [dir, sub] of [[[0, 1], '道玄坂口'], [[0, -1], '文化村通り口']]) {
    const e = L.bestEdge(poly, dir[0], dir[1]); if (!e) continue;
    S.flatSign(group, e.mid[0] + e.nx * 0.35, 27, e.mid[1] + e.nz * 0.35, e.nx, e.nz, { text: 'SHIBUYA 1O9', sub, w: 14, h: 2.6, bg: '#c8102e', fg: '#ffffff', emissive: 1.4, weight: '900' });
  }

  // ---- colliders: the drum as 16 wall slabs whose outer faces lie on the cylinder (the old two rotated squares
  //      poked their corners 4–5 m out, onto 道玄坂 and the crossing's pavement) + a core box
  for (let k = 0; k < 16; k++) {
    const a = (k + 0.5) / 16 * Math.PI * 2, T = 1.6, ch = 2 * R * Math.sin(Math.PI / 16) * Math.cos(Math.PI / 16);
    const rr = R * Math.cos(Math.PI / 16) - T / 2;
    colliders.push({ obb: { center: new THREE.Vector3(cx + Math.cos(a) * rr, H / 2, cz + Math.sin(a) * rr), halfSize: new THREE.Vector3(T / 2, H / 2, ch / 2), rotationY: -a } });
  }
  colliders.push({ obb: { center: new THREE.Vector3(cx, H / 2, cz), halfSize: new THREE.Vector3(R * 0.68, H / 2, R * 0.68), rotationY: 0 } });

  // ---- anchors (local to the drum centre)
  const radial = (r, y) => new THREE.Vector3(Math.cos(th0) * r, y, Math.sin(th0) * r);
  const anchors = {
    cylinder: { center: new THREE.Vector3(0, 0, 0), radius: R, height: H },
    screen: radial(R + 0.6, 11.5), screenNormal: new THREE.Vector3(Math.cos(th0), 0, Math.sin(th0)), screenSize: [9.6, 5.8],
    band: new THREE.Vector3(0, H - 3.6, 0), bandRadius: R + 0.34, bandHeight: 4.0,
    entrance: radial(R + 3.7, GF + 0.3), signTop: radial(R + 0.3, H - 3.6),
    dogenzakaFace: (() => { const e = L.bestEdge(poly, 0, 1); return new THREE.Vector3(e.mid[0] - cx, 27, e.mid[1] - cz); })(),
    bunkamuraFace: (() => { const e = L.bestEdge(poly, 0, -1); return new THREE.Vector3(e.mid[0] - cx, 27, e.mid[1] - cz); })(),
  };
  return { group: new THREE.Group(), origin: [cx, cz], worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
