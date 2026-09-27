// [city] Q-FRONT — grey-blue aluminium block directly north of the crossing. Its south face is a deep convex glass
// drum (3.8 m sagitta on a 20 m chord, smooth normals): TSUTAYU's floors 2–8 behind a regular mullion grid, every
// floor lit at store hours with its slab edge showing (a parallax interior: ceiling-light rows, shelving, browsers),
// the Q's EYE LED cabinet over floors 3–7 bolted to it (the animated screen itself is signage's, at anchors.screen),
// the ground-floor TSUTAYU lobby recessed 0.9 m behind the glazing line (interior-mapped books floor), STARBEANS
// COFFEE band at 2F, rooftop steel sign frame to 46 m. World-space batched geometry; group origin = data.pos.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE, railAlong, shopQuad, shopUV, registerShopBay } from './genericBuilding.js';

export const KEYS = ['qfront'];
export const SIZE = { w: 36, d: 28, h: 35 };

const DRUM_W = 12;                     // metres of drum per texture repeat
let DRUM = null;
/**
 * Store glass for the drum: `map` is the front layer (RGBA: mullions every 1.5 m, a 0.55 m slab-edge band at the
 * foot of each storey, a transom; alpha 0 = vision glass) and `uInterior` a lit TSUTAYU floor sampled 2.6 m behind
 * the glass along the view ray, so the floors keep their depth at any angle. One storey per v repeat.
 */
function drumMaterial(SH, GF) {
  if (DRUM) return DRUM;
  const W = 1024, H = 512, X = (m) => (m / DRUM_W) * W, Y = (m) => H - (m / SH) * H;   // metres → px (y up from the floor)
  const ic = L.makeCanvas(W, H), x = ic.getContext('2d');
  // ceiling: warm white with recessed light-panel rows, the dark return of the ceiling void above the glass line
  x.fillStyle = '#d9d2c4'; x.fillRect(0, 0, W, Y(2.6));
  for (let m = 0.3; m < DRUM_W; m += 1.2) { x.fillStyle = '#fffaf0'; x.fillRect(X(m), Y(4.05), X(0.7), Y(3.85) - Y(4.05)); x.fillStyle = '#fff4dc'; x.fillRect(X(m + 0.1), Y(3.35), X(0.5), Y(3.22) - Y(3.35)); }
  x.fillStyle = 'rgba(40,36,30,0.45)'; x.fillRect(0, Y(4.3), W, Y(4.05) - Y(4.3));
  // back wall: tall book / media shelving in bays, category boards, end-cap posters, floor
  x.fillStyle = '#b8a888'; x.fillRect(0, Y(2.6), W, Y(0.1) - Y(2.6));
  const spine = ['#8a3a2a', '#2a4a7a', '#c8b060', '#3a6a4a', '#e8e0d0', '#6a3a6a', '#d87a2a', '#2a2a2a', '#a8a8b8', '#c84040'];
  for (let bay = 0; bay < 8; bay++) {
    const bx = 0.2 + bay * 1.5;
    x.fillStyle = '#5a4a3a'; x.fillRect(X(bx), Y(2.3), X(1.3), Y(0.15) - Y(2.3));
    for (let r = 0; r < 5; r++) {
      const y0 = 0.25 + r * 0.42;
      for (let m = bx + 0.05; m < bx + 1.25; m += 0.035 + L.hash(Math.round(m * 100), r, 3) * 0.03) {
        const h = 0.24 + L.hash(Math.round(m * 100), r, 5) * 0.12;
        x.fillStyle = spine[Math.floor(L.hash(Math.round(m * 100), r + bay, 7) * spine.length)];
        x.fillRect(X(m), Y(y0 + h), Math.max(1, X(0.03)), Y(y0) - Y(y0 + h));
      }
      x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(X(bx), Y(y0 + 0.02), X(1.3), 2);
    }
    x.fillStyle = ['#f7d100', '#1a3a8a', '#ffffff', '#c8102e'][bay % 4]; x.fillRect(X(bx + 0.2), Y(2.55), X(0.9), Y(2.35) - Y(2.55));
    x.fillStyle = bay % 4 === 0 ? '#0b2a5a' : '#ffffff'; x.font = `800 ${Math.round(Y(2.38) - Y(2.52))}px ${L.FONT_JP}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(['新刊', 'COMIC', '文庫', '映像', '音楽', '雑誌', 'GAME', '文具'][bay], X(bx + 0.65), Y(2.45));
  }
  x.fillStyle = '#8a7a64'; x.fillRect(0, Y(0.15), W, H - Y(0.15));
  // browsers between the shelves (upper bodies above the table displays)
  for (let k = 0; k < 9; k++) {
    const m = 0.5 + L.hash(k, 1, 13) * 11, hgt = 1.55 + L.hash(k, 2, 13) * 0.25, c = ['#2a2a30', '#6a5a4a', '#c8c4bc', '#3a4a6a', '#7a3a3a'][k % 5];
    x.fillStyle = c; x.fillRect(X(m - 0.2), Y(hgt - 0.3), X(0.4), Y(0.6) - Y(hgt - 0.3));
    x.fillStyle = '#1a1612'; x.beginPath(); x.ellipse(X(m), Y(hgt - 0.15), X(0.11), Y(0) - Y(0.13), 0, 0, 6.3); x.fill();
  }
  for (let k = 0; k < 6; k++) { const m = 0.6 + k * 2.0; x.fillStyle = '#e8e2d4'; x.fillRect(X(m), Y(0.85), X(1.1), Y(0.15) - Y(0.85)); x.fillStyle = '#c84040'; x.fillRect(X(m + 0.1), Y(0.95), X(0.9), Y(0.85) - Y(0.95)); }   // table displays
  const iTex = L.canvasTex(ic, { wrap: true });
  // front layer
  const fc = L.makeCanvas(W, H), f = fc.getContext('2d');
  f.clearRect(0, 0, W, H);
  f.fillStyle = '#8e949c'; f.fillRect(0, Y(0.55), W, H - Y(0.55));
  f.fillStyle = '#c8ccd2'; f.fillRect(0, Y(0.55), W, 3); f.fillStyle = '#50545a'; f.fillRect(0, H - 4, W, 4);
  f.fillStyle = '#5a6068';
  for (let m = 0; m < DRUM_W; m += 1.5) f.fillRect(X(m) - X(0.04), 0, X(0.08), H);
  f.fillRect(0, Y(2.95), W, Y(2.9) - Y(2.96));
  const fTex = L.canvasTex(fc, { wrap: true });
  for (const t of [fTex, iTex]) { t.repeat.set(1 / DRUM_W, 1 / SH); t.offset.set(0, -GF / SH); }
  const mat = new THREE.MeshStandardMaterial({ map: fTex, transparent: false, roughness: 0.1, metalness: 0.1, envMapIntensity: 0.9 });
  mat.name = 'lm_qfrontDrum';
  const knob = { value: 1 };
  S.nightMaterial({ set emissiveIntensity(v) { knob.value = v; } }, 0.25, 1.0);
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uInterior = { value: iTex }; sh.uniforms.uQK = knob;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vQPos; varying vec3 vQNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvQPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vQNrm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uInterior; uniform float uQK; varying vec3 vQPos; varying vec3 vQNrm;')
      .replace('#include <map_fragment>', `
  vec3 qn = normalize(vQNrm), qt = vec3(-qn.z, 0.0, qn.x), qV = normalize(vQPos - cameraPosition);
  float qd = max(-dot(qV, qn), 0.2);
  vec2 qOff = vec2(dot(qV, qt) * ${(1 / DRUM_W).toFixed(5)}, qV.y * ${(1 / SH).toFixed(5)}) * (2.6 / qd);
  vec4 qF = texture2D(map, vMapUv);
  vec3 qIn = texture2D(uInterior, vMapUv + qOff).rgb;
  float qGlass = 1.0 - qF.a;
  diffuseColor.rgb = mix(qF.rgb, vec3(0.015), qGlass);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.45, 0.06, qGlass);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(0.55, 0.0, qGlass);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += (qIn * qIn * 1.15 * qGlass + qF.rgb * (1.0 - qGlass) * 0.05) * uQK;');
  };
  mat.customProgramCacheKey = () => 'qfront_drum';
  return (DRUM = mat);
}

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos;
  const H = data.size[1], GF = 5, SH = (H - GF) / 7;
  const colliders = [], facades = [];
  // footprint: the drum's ends sit 3 m back along the side faces, so it bulges 3.8 m while its apex stays behind the
  // pavement line
  const base = L.ensureCW([[-31, -59], [-1, -50], [-2, -47], [-5.2, -35.9], [-25.2, -34.0], [-37, -45]]);
  let si = base.findIndex((a, i) => { const b = base[(i + 1) % base.length]; return (a[0] === -5.2 && b[0] === -25.2) || (a[0] === -25.2 && b[0] === -5.2); });
  if (si < 0) si = 0;
  const NA = 32;
  const bul = S.bulgeEdge(base, si, 3.8, NA);
  const poly = bul.poly;
  const c = L.polyCentroid(poly);
  const thM = (bul.t0 + bul.t1) / 2;
  const nM = [Math.cos(thM), Math.sin(thM)];                 // outward normal at the arc apex (≈ south)
  const arc = (r, y0, y1, opts) => S.cylSegment(bul.cx, bul.cz, r, y0, y1, bul.t0, bul.t1, 48, opts);
  const onArc = (x, z) => Math.abs(Math.hypot(x - bul.cx, z - bul.cz) - bul.R) < 0.02;
  const smoothArc = (g) => {   // radial normals on the drum faces of an extruded prism (no crease between segments)
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) if (Math.abs(n.getY(i)) < 0.5 && onArc(p.getX(i), p.getZ(i))) { const dx = p.getX(i) - bul.cx, dz = p.getZ(i) - bul.cz, l = Math.hypot(dx, dz); n.setXYZ(i, dx / l, 0, dz / l); }
    return g;
  };

  // ---- body (GF → roof, soffit under the drum overhang) + ground-floor core with the drum lobby recessed 0.9 m
  batch.add(M.panelGrey, smoothArc(L.extrudePolygon(poly, GF, H, { cap: false, bottom: true, uvScale: 3.5 / SH })), c[0], c[1]);
  batch.add(S.roofMat(), L.polygonCap(poly, H, 0.25), c[0], c[1]);
  const lobby = poly.map((p, i) => {
    const k = (i - si + poly.length) % poly.length;
    if (k === 0 || k >= NA) return p;
    const dx = p[0] - bul.cx, dz = p[1] - bul.cz, l = Math.hypot(dx, dz);
    return [bul.cx + dx / l * (bul.R - 0.9), bul.cz + dz / l * (bul.R - 0.9)];
  });
  batch.add(M.panelGrey, L.extrudePolygon(lobby, 0, GF + 0.02, { cap: false, uvScale: 3.5 / SH }), c[0], c[1]);
  S.rings(batch, M.silver, poly, GF, H - 0.5, SH, { out: 0.22, h: 0.3 });
  S.parapet(batch, M.silver, poly, H, { h: 1.1, t: 0.35 });
  // the drum: lit store glass over floors 2–8
  batch.add(drumMaterial(SH, GF), arc(bul.R + 0.1, GF, H - 0.05, { metres: true }), c[0], c[1]);
  // Q's EYE: one LED cabinet over floors 3–7, a D-shaped steel box whose flat face carries the screen and whose back
  // follows the drum; a proud frame lip around the LED
  const scr = { w: 15.2, h: 20.0, cy: GF + SH + 0.3 + 10.0, lift: 0.75 };
  const ax = bul.cx + nM[0] * (bul.R + scr.lift), az = bul.cz + nM[1] * (bul.R + scr.lift);
  {
    const tx = -nM[1], tz = nM[0], rot = L.rotYOf(tx, tz), hw = scr.w / 2 + 0.45;
    const cab = [];
    for (let i = 0; i <= 12; i++) { const u = -hw + (2 * hw * i) / 12; cab.push([ax + tx * u, az + tz * u]); }
    for (let i = 12; i >= 0; i--) {
      const u = -hw + (2 * hw * i) / 12, d = Math.sqrt(Math.max(0, bul.R * bul.R - u * u)) - 0.3;
      cab.push([bul.cx + nM[0] * d + tx * u, bul.cz + nM[1] * d + tz * u]);
    }
    batch.add(M.darkMetal, L.extrudePolygon(cab, scr.cy - scr.h / 2 - 0.45, scr.cy + scr.h / 2 + 0.45, { cap: true, bottom: true }), c[0], c[1]);
    const lip = (ox, oy, w, h) => batch.add(M.silver, L.boxAt(ax + tx * ox + nM[0] * 0.1, scr.cy + oy, az + tz * ox + nM[1] * 0.1, w, h, 0.2, rot, false), c[0], c[1]);
    lip(0, scr.h / 2 + 0.22, scr.w + 0.9, 0.22); lip(0, -scr.h / 2 - 0.22, scr.w + 0.9, 0.22);
    lip(scr.w / 2 + 0.22, 0, 0.22, scr.h + 0.66); lip(-scr.w / 2 - 0.22, 0, 0.22, scr.h + 0.66);
    S.glowBar(batch, M.glowWhite, ax + nM[0] * 0.25, scr.cy - scr.h / 2 - 0.36, az + nM[1] * 0.25, scr.w, 0.08, 0.1, rot);
  }
  // ---- ground floor: the TSUTAYU lobby behind the drum glazing line (interior-mapped books floor in 5 bays with
  //      mullions, a lit soffit under the overhang), shops on the other street faces
  const NQ = 5;
  for (let k = 0; k < NQ; k++) {
    const ta = bul.t0 + (bul.t1 - bul.t0) * k / NQ, tb = bul.t0 + (bul.t1 - bul.t0) * (k + 1) / NQ, tm = (ta + tb) / 2;
    const r = bul.R - 0.08, cw = 2 * r * Math.sin(Math.abs(tb - ta) / 2), rm = r * Math.cos(Math.abs(tb - ta) / 2);
    const nx = Math.cos(tm), nz = Math.sin(tm);
    batch.add(At.shop.mat, shopQuad(bul.cx + nx * rm, 0.15 + (GF - 0.4) / 2, bul.cz + nz * rm, nx, nz, cw - 0.1, GF - 0.4, 0, shopUV('books', 0, k)), c[0], c[1]);
  }
  // the real TSUTAYU floor behind that glass (interiors.js): one hall shared by the drum and the side-face bays —
  // its floor / walls follow the lobby polygon, the drum bay owns the fixtures and the people, each glass segment
  // opens its own shallow cut (card + the recessed lobby wall)
  {
    const half = Math.abs(bul.t1 - bul.t0) / 2, cuts = [];
    for (let k = 0; k < NQ; k++) {
      const ta = bul.t0 + (bul.t1 - bul.t0) * k / NQ, tb = bul.t0 + (bul.t1 - bul.t0) * (k + 1) / NQ, tm = (ta + tb) / 2;
      const r = bul.R - 0.08, cw = 2 * r * Math.sin(Math.abs(tb - ta) / 2), rm = r * Math.cos(Math.abs(tb - ta) / 2);
      cuts.push({ x: bul.cx + Math.cos(tm) * rm, z: bul.cz + Math.sin(tm) * rm, nx: Math.cos(tm), nz: Math.sin(tm), w: cw - 0.15, gh: GF - 0.62, y0: 0.15, hdIn: 1.3 });
    }
    const hallPoly = poly.map((p, i) => {
      const k = (i - si + poly.length) % poly.length;
      if (k === 0 || k >= NA) return p;
      const dx = p[0] - bul.cx, dz = p[1] - bul.cz, l = Math.hypot(dx, dz);
      return [bul.cx + dx / l * (bul.R - 0.1), bul.cz + dz / l * (bul.R - 0.1)];
    });
    const open = poly.map((p, i) => (i - si + poly.length) % poly.length < NA);          // edge i → i+1 is glazing
    const rc0 = bul.R * Math.cos(half);
    registerShopBay({ x: bul.cx + nM[0] * rc0, z: bul.cz + nM[1] * rc0, y0: 0.15, nx: nM[0], nz: nM[1], w: 2 * bul.R * Math.sin(half), gh: GF - 0.62,
      type: 'books', name: 'TSUTAYU', real: true, depth: 14, roomW: 18, roomD: 13.5, hall: 'qfront', hallOwner: true, cuts, hallPoly, hallOpen: open, hallH: GF - 0.12 });
  }
  for (let k = 0; k <= NQ; k++) { const th = bul.t0 + (bul.t1 - bul.t0) * k / NQ; S.ibox(inst, 'lm_mullion', M.darkMetal, bul.cx + Math.cos(th) * (bul.R - 0.02), 0, bul.cz + Math.sin(th) * (bul.R - 0.02), 0.14, GF - 0.2, 0.22, L.rotYOf(-Math.sin(th), Math.cos(th))); }
  batch.add(M.darkMetal, arc(bul.R - 0.02, GF - 0.45, GF - 0.3, { metres: true }), c[0], c[1]);                   // transom
  for (let k = 0; k < 14; k++) { const th = bul.t0 + (bul.t1 - bul.t0) * (k + 0.5) / 14; S.ibox(inst, 'lm_rimlight', M.glowWhiteDim, bul.cx + Math.cos(th) * (bul.R - 0.45), GF - 0.04, bul.cz + Math.sin(th) * (bul.R - 0.45), 0.5, 0.03, 0.18, L.rotYOf(-Math.sin(th), Math.cos(th))); }
  batch.add(M.silver, arc(bul.R + 0.4, GF - 0.3, GF + 0.15, { metres: true }), c[0], c[1]);                      // fascia band
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 4) continue;                                                                                    // arc pieces
    const [nx, nz] = L.edgeNormal(poly, i);
    if (!isStreetSide((a[0] + b[0]) / 2 + nx * 4, (a[1] + b[1]) / 2 + nz * 4)) { batch.add(At.trim, L.wallQuad((a[0] + b[0]) / 2, 1.2, (a[1] + b[1]) / 2, nx, nz, 1.2, 2.4, 0.03, [0, 0, 0.02, 0.02]), c[0], c[1]); continue; }
    S.shopRow(batch, At, a, b, nx, nz, ['TSUTAYU', 'STARBEANS COFFEE', 'TSUTAYU'], { gf: GF, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 40 + i, minW: 7, maxW: 10, hall: 'qfront' });
  }
  // 2F STARBEANS band along the arc + west face, TSUTAYU vertical blade on the Center-gai face
  S.wrapSign(group, { cx: bul.cx, cz: bul.cz, r: bul.R + 0.36, y0: GF + 0.35, y1: GF + 1.75, th0: bul.t0, th1: bul.t1, text: 'STARBEANS COFFEE  ★  SCRAMBLE VIEW 2F  ★  STARBEANS COFFEE', bg: '#0b3d2e', fg: '#f5f1e6', repeat: 1, emissive: 1.1, weight: '800', seg: 32, letterSpacing: 4 });
  const sw = L.bestEdge(poly, -0.72, 0.7);
  if (sw) {
    S.flatSign(group, sw.mid[0] + sw.nx * 0.35, GF + 1.05, sw.mid[1] + sw.nz * 0.35, sw.nx, sw.nz, { text: 'STARBEANS COFFEE', sub: '2F', w: Math.min(sw.len - 2, 12), h: 1.3, bg: '#0b3d2e', fg: '#f5f1e6', emissive: 1.1 });
    const bx = sw.mid[0] + sw.tx * (sw.len * 0.22), bz = sw.mid[1] + sw.tz * (sw.len * 0.22);
    S.blade(batch, bx + sw.nx * 1.1, 17, bz + sw.nz * 1.1, sw.tx, sw.tz, { text: 'TSUTAYU', w: 1.6, h: 16, bg: '#f7d100', fg: '#0b2a5a', emissive: 1.0, weight: '900' });
    for (const y of [10, 17, 24]) batch.add(M.darkMetal, L.boxAt(bx + sw.nx * 0.6, y, bz + sw.nz * 0.6, 1.2, 0.12, 0.12, L.rotYOf(sw.nx, sw.nz), false), c[0], c[1]);
  }
  // ---- rooftop steel frame (signage adds the Q-FRONT lettering at anchors.roofSign)
  {
    const rx = bul.cx + nM[0] * (bul.R - 1.2), rz = bul.cz + nM[1] * (bul.R - 1.2);
    const tx = -nM[1], tz = nM[0], rot = L.rotYOf(tx, tz);
    for (const o of [-9, -3, 3, 9]) S.ibox(inst, 'lm_post', M.darkMetal, rx + tx * o, H, rz + tz * o, 0.35, 11, 0.35, rot);
    for (const y of [H + 2, H + 6.5, H + 10.8]) batch.add(M.darkMetal, L.boxAt(rx, y, rz, 19, 0.3, 0.3, rot, false), c[0], c[1]);
    for (const o of [-9, 9]) batch.add(M.darkMetal, L.boxAt(rx + tx * o - nM[0] * 3, H + 5, rz + tz * o - nM[1] * 3, 0.2, 0.2, 6.5, rot, false), c[0], c[1]);   // back braces
    batch.add(M.darkMetal, L.boxAt(rx, H + 11, rz, 19.6, 0.5, 0.8, rot, false), c[0], c[1]);
    S.glowBar(batch, M.glowWhite, rx + nM[0] * 0.3, H + 1.6, rz + nM[1] * 0.3, 18, 0.12, 0.12, rot);
  }
  // rooftop plant (behind the sign frame): rail, tanks, AC, ducts, bulkhead + ladder
  S.roofPlant(batch, inst, L.offsetPolygon(poly, -3), H, { seed: 17, tanks: 2, ac: 7, ducts: 2, rail: false, inset: 2.5 });
  railAlong(inst, At, L.offsetPolygon(poly, -0.45), H);

  colliders.push(...L.edgeColliders(poly, H));
  facades.push(...S.facadeRecords(key, poly, H, 8, { tenants: data.tenants || [], isStreetSide, gf: GF }));
  const lv = (x, y, z) => new THREE.Vector3(x - px, y, z - pz);
  const screenPos = lv(ax + nM[0] * 0.16, scr.cy, az + nM[1] * 0.16);
  const anchors = {
    screen: screenPos, screenNormal: new THREE.Vector3(nM[0], 0, nM[1]), screenSize: [scr.w, scr.h],
    roofSign: lv(bul.cx + nM[0] * (bul.R - 0.6), H + 6.4, bul.cz + nM[1] * (bul.R - 0.6)), roofSignNormal: new THREE.Vector3(nM[0], 0, nM[1]), roofSignSize: [17, 4.2],
    curve: { center: lv(bul.cx, 0, bul.cz), radius: bul.R, th0: bul.t0, th1: bul.t1 },
  };
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
