// [city] ハチ公前広場 — the bronze 忠犬ハチ公 (a sitting Akita sculpted as lofted sections: haunches, deep chest, neck
// ruff, wedge head with stop and muzzle, cupped ears, fused fore legs, curled tail; ~12k tris) on its granite
// pedestal facing the Hachiko exit, the curved stone garden wall + hedge behind it, chain bollards in front,
// 渋谷駅前交番 (shared koban builder), tree-pit rings at the zelkova positions (props plant the trees), granite planters
// and benches around the square. World-space batched geometry; group origin = statue position (anchors local).
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { koban } from './smallLandmarks.js';

export const KEYS = ['hachikoStatue'];
export const SIZE = { w: 30, d: 20, h: 4 };

const CYL = new THREE.CylinderGeometry(1, 1, 1, 14);
const PLINTH_H = 1.2;

// ---- statue lighting: two of the square's pole floodlights evaluated with the material's own GGX response
//      (RE_Direct in the physical lighting loop), so the bronze gets a real key / fill and specular that follows its
//      roughness, at no scene-light cost. A faint warm rim only. Positions are world space, set in build().
const FLOOD = { uFloodK: { value: 1 }, uFlood0: { value: new THREE.Vector3() }, uFlood1: { value: new THREE.Vector3() } };
const floodKnob = { set emissiveIntensity(v) { FLOOD.uFloodK.value = v; } };
const FLOOD_PARS = `
uniform float uFloodK; uniform vec3 uFlood0; uniform vec3 uFlood1;
varying vec3 vWPos; varying vec3 vWNrm;
float hkHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hkNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hkHash(i), hkHash(i + vec2(1.0, 0.0)), f.x), mix(hkHash(i + vec2(0.0, 1.0)), hkHash(i + vec2(1.0, 1.0)), f.x), f.y); }`;
const FLOOD_LIGHT = `
{
  IncidentLight fl; fl.visible = true;
  vec3 fp = (viewMatrix * vec4(uFlood0, 1.0)).xyz - geometryPosition; float fd = length(fp);
  fl.direction = fp / fd; fl.color = vec3(1.0, 0.9, 0.76) * 5.2 * uFloodK / (1.0 + fd * fd * 0.03);
  RE_Direct(fl, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  fp = (viewMatrix * vec4(uFlood1, 1.0)).xyz - geometryPosition; fd = length(fp);
  fl.direction = fp / fd; fl.color = vec3(1.0, 0.78, 0.55) * 1.0 * uFloodK / (1.0 + fd * fd * 0.03);
  RE_Direct(fl, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
}`;
const WPOS_VERT = 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNrm = normalize(mat3(modelMatrix) * objectNormal);';

/** Tileable fur / chisel height field → normal map: short tufts running along v (down the body), modelling strokes. */
function furNormal() {
  const S0 = 512, c = L.makeCanvas(S0, S0), x = c.getContext('2d');
  x.fillStyle = 'rgb(128,128,128)'; x.fillRect(0, 0, S0, S0);
  x.lineCap = 'round';
  for (let k = 0; k < 2600; k++) {
    const px = L.hash(k, 1, 91) * S0, py = L.hash(k, 2, 91) * S0, len = 26 + L.hash(k, 3, 91) * 50, a = (L.hash(k, 4, 91) - 0.5) * 0.5, w = 2 + L.hash(k, 5, 91) * 4;
    const v = 128 + (L.hash(k, 6, 91) < 0.5 ? 1 : -1) * (40 + L.hash(k, 7, 91) * 60);
    x.strokeStyle = `rgb(${v},${v},${v})`; x.lineWidth = w;
    for (const [ox, oy] of [[0, 0], [S0, 0], [-S0, 0], [0, S0], [0, -S0]]) { x.beginPath(); x.moveTo(px + ox, py + oy); x.quadraticCurveTo(px + ox + Math.sin(a) * len * 0.6 + 4, py + oy + len * 0.5, px + ox + Math.sin(a) * len, py + oy + Math.cos(a) * len); x.stroke(); }
  }
  // broad modelling-tool facets
  for (let k = 0; k < 60; k++) { const v = 118 + L.hash(k, 8, 91) * 20; x.fillStyle = `rgba(${v},${v},${v},0.35)`; x.beginPath(); x.ellipse(L.hash(k, 9, 91) * S0, L.hash(k, 10, 91) * S0, 30 + L.hash(k, 11, 91) * 60, 14 + L.hash(k, 12, 91) * 30, L.hash(k, 13, 91) * 3, 0, 6.3); x.fill(); }
  x.filter = 'blur(1.2px)'; x.drawImage(c, 0, 0); x.filter = 'none';
  const d = x.getImageData(0, 0, S0, S0).data, out = L.makeCanvas(S0, S0), ox = out.getContext('2d'), img = ox.createImageData(S0, S0);
  const h = (i, j) => d[((((j + S0) % S0) * S0) + ((i + S0) % S0)) * 4] / 255;
  for (let j = 0; j < S0; j++) for (let i = 0; i < S0; i++) {
    const dx = (h(i + 1, j) - h(i - 1, j)) * 2.2, dy = (h(i, j + 1) - h(i, j - 1)) * 2.2, l = Math.hypot(dx, dy, 1), o = (j * S0 + i) * 4;
    img.data[o] = (-dx / l * 0.5 + 0.5) * 255; img.data[o + 1] = (dy / l * 0.5 + 0.5) * 255; img.data[o + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  ox.putImageData(img, 0, 0);
  return L.canvasTex(out, { srgb: false, wrap: true });
}
/** Speckled light-grey granite (feldspar / mica flecks), 512 px per 0.6 m. */
function graniteTex() {
  const S0 = 512, c = L.makeCanvas(S0, S0), x = c.getContext('2d');
  x.fillStyle = '#bdb9b2'; x.fillRect(0, 0, S0, S0);
  for (let k = 0; k < 16000; k++) {
    const r = L.hash(k, 1, 97), v = r < 0.22 ? 60 + r * 200 : r < 0.3 ? 235 : 160 + L.hash(k, 2, 97) * 60;
    x.fillStyle = `rgba(${v | 0},${(v * 0.98) | 0},${(v * 0.95) | 0},${0.3 + L.hash(k, 3, 97) * 0.4})`;
    const s = 1 + L.hash(k, 4, 97) * 3; x.fillRect(L.hash(k, 5, 97) * S0, L.hash(k, 6, 97) * S0, s, s * (0.6 + L.hash(k, 7, 97)));
  }
  return L.canvasTex(c, { wrap: true });
}
let SM = null;
function statueMats() {
  if (SM) return SM;
  // bronze: dark patinated body, verdigris gathering in the hollows, under the chin / belly and in rain run-downs
  // (world-Y keyed streaks), the rubbed nose, muzzle and paws polished back to brass (vertex mask r; cavity = g)
  const bronze = L.std({ color: 0xffffff, roughness: 0.5, metalness: 0.8, envMapIntensity: 0.9, normalMap: furNormal(), normalScale: new THREE.Vector2(0.32, 0.32) });
  bronze.name = 'lm_hachikoBronze'; bronze.userData.attrs = [['color', 3]];
  bronze.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FLOOD);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 color; varying vec3 vSculpt; varying vec3 vWPos; varying vec3 vWNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSculpt = color; ' + WPOS_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + FLOOD_PARS + '\nvarying vec3 vSculpt;')
      .replace('#include <map_fragment>', `#include <map_fragment>
  vec3 hkN = normalize(vWNrm);
  float hkWear = vSculpt.r, hkCav = vSculpt.g, hkDark = vSculpt.b;
  float hkU = abs(hkN.x) > abs(hkN.z) ? vWPos.z : vWPos.x;
  float hkStreak = smoothstep(0.5, 0.85, hkNoise(vec2(hkU * 42.0, vWPos.y * 2.6))) * smoothstep(0.25, 0.8, hkNoise(vec2(hkU * 7.0, vWPos.y * 0.7 + 3.0)));
  float hkUnder = smoothstep(0.05, 0.75, -hkN.y);
  float hkMott = hkNoise(vWPos.xz * 7.0 + vWPos.y * 5.0) * 0.6 + hkNoise(vWPos.zy * 23.0) * 0.4;
  float hkPat = clamp(hkCav * 1.1 + hkUnder * 0.55 + hkStreak * 0.75 * (1.0 - hkUnder) + hkMott * 0.5 - 0.2, 0.0, 1.0) * (1.0 - hkWear) * (1.0 - hkDark);
  vec3 hkBronze = vec3(0.1, 0.066, 0.04) * (0.7 + 0.6 * hkMott);
  vec3 hkVerd = mix(vec3(0.13, 0.2, 0.16), vec3(0.22, 0.32, 0.26), hkNoise(vWPos.xy * 31.0));
  diffuseColor.rgb = mix(mix(hkBronze, hkVerd, hkPat), vec3(0.5, 0.35, 0.17), hkWear) * (1.0 - 0.75 * hkDark);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(mix(0.5 + 0.18 * hkMott, 0.74, hkPat), 0.4, hkWear), 0.8, hkDark);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(mix(0.82, 0.12, hkPat), 0.95, hkWear);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += uFloodK * vec3(1.0, 0.82, 0.62) * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0) * 0.08 * (1.0 - hkPat * 0.6);`)
      .replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>' + FLOOD_LIGHT);
  };
  bronze.customProgramCacheKey = () => 'hachiko_bronze2';
  // pedestal: light speckled granite, flamed (rough) courses under a polished cap; green bronze run-off stains the
  // cap and the block face under the dog
  const plinth = L.std({ map: graniteTex(), color: 0xffffff, roughness: 0.62, metalness: 0.02, envMapIntensity: 0.7 });
  plinth.name = 'lm_hachikoPlinth';
  plinth.userData.topY = { value: PLINTH_H }; plinth.userData.statueXZ = { value: new THREE.Vector2() };
  plinth.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FLOOD, { uTopY: plinth.userData.topY, uStatueXZ: plinth.userData.statueXZ });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WPOS_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + FLOOD_PARS + '\nuniform float uTopY; uniform vec2 uStatueXZ;')
      .replace('#include <map_fragment>', `#include <map_fragment>
  float hkTop = step(uTopY - 0.125, vWPos.y);
  float hkU = abs(vWNrm.x) > abs(vWNrm.z) ? vWPos.z : vWPos.x;
  float hkSide = 1.0 - step(0.5, vWNrm.y);
  float hkRun = smoothstep(0.45, 0.85, hkNoise(vec2(hkU * 30.0, vWPos.y * 1.5))) * smoothstep(0.9, 0.0, uTopY - vWPos.y) * hkSide
              + (1.0 - hkSide) * hkTop * smoothstep(0.62, 0.25, length(vWPos.xz - uStatueXZ)) * (0.35 + 0.5 * hkNoise(vWPos.xz * 9.0));
  diffuseColor.rgb = mix(diffuseColor.rgb * mix(1.0, 1.08, hkTop), vec3(0.22, 0.3, 0.25), hkRun * 0.7);
  diffuseColor.rgb *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.5, vWPos.y - uTopY + 1.2));`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.16, hkTop);')
      .replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>' + FLOOD_LIGHT);
  };
  plinth.customProgramCacheKey = () => 'hachiko_plinth2';
  S.nightMaterial(floodKnob, 0.2, 1.0);
  return (SM = { bronze, plinth });
}
/** Chamfered granite course: a box whose top edges are bevelled by `b` (loft from the full to the inset outline). */
function course(batch, mat, x, y0, y1, z, w, d, ry, b) {
  const poly = L.rectPoly(x, z, w, d, ry), top = L.offsetPolygon(poly, -b);
  batch.add(mat, L.extrudePolygon(poly, y0, y1 - b, { cap: false, uvScale: 1 }), x, z);
  batch.add(mat, L.loft(poly, top, y1 - b, y1, { uvScale: 1 }), x, z);
  batch.add(mat, L.polygonCap(top, y1, 1), x, z);
}

// ---- sculpt: superellipse cross-sections lofted along Catmull-Rom-interpolated key sections. A key is
//      { p: [x, y, z] centre, w: [left, right] half-widths (along x), d: [front, back] half-depths (in the section
//      plane, perpendicular to the path; `up` flips "front" to "up" for forward-running parts), e: exponent }.
const crs = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
function loft(keys, { nA = 24, nL = 24, up = false, uvK = 4, part = 0, deform = null } = {}) {
  const K = keys.length, at = (i) => keys[Math.max(0, Math.min(K - 1, i))];
  const sample = (t) => {
    const i = Math.min(K - 2, Math.floor(t)), f = t - i, k = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c = (sel) => crs(sel(k[0]), sel(k[1]), sel(k[2]), sel(k[3]), f);
    return { p: [0, 1, 2].map(j => c(q => q.p[j])), wl: Math.max(0.003, c(q => q.w[0])), wr: Math.max(0.003, c(q => q.w[1])), df: Math.max(0.003, c(q => q.d[0])), db: Math.max(0.003, c(q => q.d[1])), e: c(q => q.e ?? 2.2) };
  };
  const pos = [], uv = [], idx = [], parts = [];
  const T = new THREE.Vector3(), X = new THREE.Vector3(), Y = new THREE.Vector3(), P = new THREE.Vector3();
  let vAcc = 0, prev = null;
  for (let r = 0; r <= nL; r++) {
    const t = (r / nL) * (K - 1), s = sample(t), s0 = sample(Math.max(0, t - 0.02)), s1 = sample(Math.min(K - 1, t + 0.02));
    T.set(s1.p[0] - s0.p[0], s1.p[1] - s0.p[1], s1.p[2] - s0.p[2]).normalize();
    X.set(1, 0, 0).addScaledVector(T, -T.x).normalize();
    Y.crossVectors(X, T).normalize(); if (up) Y.negate();
    if (prev) vAcc += Math.hypot(s.p[0] - prev[0], s.p[1] - prev[1], s.p[2] - prev[2]);
    prev = s.p;
    const circ = Math.PI * (s.wl + s.wr + s.df + s.db) / 2;
    for (let j = 0; j <= nA; j++) {
      const th = (j / nA) * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th);
      let x = spow(c, 2 / s.e) * (c > 0 ? s.wl : s.wr), y = spow(sn, 2 / s.e) * (sn > 0 ? s.df : s.db);
      if (deform) [x, y] = deform(x, y, r / nL, s);
      P.set(s.p[0], s.p[1], s.p[2]).addScaledVector(X, x).addScaledVector(Y, y);
      pos.push(P.x, P.y, P.z); uv.push((j / nA) * circ * uvK, vAcc * uvK); parts.push(part);
    }
  }
  const W = nA + 1;
  for (let r = 0; r < nL; r++) for (let j = 0; j < nA; j++) { const a = r * W + j, b = a + W; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  // end caps (fans on the first / last ring)
  for (const [r, flip] of [[0, true], [nL, false]]) {
    let cx = 0, cy = 0, cz = 0; for (let j = 0; j < nA; j++) { const o = (r * W + j) * 3; cx += pos[o]; cy += pos[o + 1]; cz += pos[o + 2]; }
    const ci = pos.length / 3; pos.push(cx / nA, cy / nA, cz / nA); uv.push(0, r ? vAcc * uvK : 0); parts.push(part);
    for (let j = 0; j < nA; j++) { const a = r * W + j; if (flip) idx.push(ci, a + 1, a); else idx.push(ci, a, a + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  // winding: normals must point away from the section centres
  g.computeVertexNormals();
  const n0 = g.attributes.normal, mid = Math.floor(nL / 2) * W, q = sample((Math.floor(nL / 2) / nL) * (K - 1)).p;
  if ((pos[mid * 3] - q[0]) * n0.getX(mid) + (pos[mid * 3 + 1] - q[1]) * n0.getY(mid) + (pos[mid * 3 + 2] - q[2]) * n0.getZ(mid) < 0) {
    for (let i = 0; i < idx.length; i += 3) { const b = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = b; }
    g.setIndex(idx); g.computeVertexNormals();
  }
  // weld the uv seam normals
  const n = g.attributes.normal;
  for (let r = 0; r <= nL; r++) { const a = r * W, b = a + nA; const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b), l = Math.hypot(x, y, z) || 1; n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l); }
  g.userData.parts = parts;
  return g;
}
/** Tube along a Catmull-Rom curl with a radius taper r0 → r1 (tail), rounded tip. */
function taperedTube(pts, r0, r1, seg = 40, rad = 12, part = 0) {
  const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)));
  const g = new THREE.TubeGeometry(curve, seg, 1, rad, false);
  const p = g.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, r = THREE.MathUtils.lerp(r0, r1, t) * (t > 0.88 ? Math.sqrt(Math.max(0.02, 1 - ((t - 0.88) / 0.12) ** 2)) : 1) * (t < 0.1 ? 0.85 + t * 1.5 : 1);
    curve.getPointAt(t, c);
    for (let j = 0; j <= rad; j++) { const k = i * (rad + 1) + j; v.fromBufferAttribute(p, k).sub(c).multiplyScalar(r); p.setXYZ(k, c.x + v.x, c.y + v.y, c.z + v.z); }
  }
  g.computeVertexNormals();
  const uvA = g.attributes.uv; for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * 8, uvA.getY(i) * 1.2);
  g.userData.parts = new Array(p.count).fill(part);
  return g;
}
/**
 * Sitting Akita (忠犬ハチ公), ~1.6 m to the ear tips, local +z = forward, +x = the dog's left, origin = seat centre on
 * the pedestal. Returns one geometry with a `color` attribute: r = hand wear (nose, muzzle, paws, ear tips),
 * g = cavity (proxy-sphere occlusion + eye sockets / lip line) that gathers the verdigris.
 */
function akitaGeometry() {
  const G = [];
  // torso: seat → haunches → loin → deep chest → withers → neck ruff → throat (into the head)
  G.push(loft([
    { p: [0, 0.03, -0.2], w: [0.1, 0.1], d: [0.1, 0.1] },
    { p: [0, 0.12, -0.2], w: [0.23, 0.23], d: [0.24, 0.22] },
    { p: [0, 0.3, -0.18], w: [0.25, 0.25], d: [0.26, 0.23] },
    { p: [0, 0.5, -0.1], w: [0.225, 0.225], d: [0.27, 0.17] },
    { p: [0, 0.7, 0.01], w: [0.235, 0.235], d: [0.31, 0.15] },
    { p: [0, 0.88, 0.1], w: [0.225, 0.225], d: [0.27, 0.15] },
    { p: [0, 1.02, 0.17], w: [0.185, 0.185], d: [0.19, 0.15], e: 2.0 },
    { p: [0, 1.13, 0.225], w: [0.175, 0.175], d: [0.16, 0.14], e: 2.0 },
    { p: [0, 1.22, 0.26], w: [0.15, 0.15], d: [0.13, 0.11] },
    { p: [0, 1.32, 0.3], w: [0.06, 0.06], d: [0.06, 0.06] },
  ], { nA: 36, nL: 44, part: 1 }));
  for (const sg of [-1, 1]) {
    // folded hind leg: thigh pad (hip → stifle), hock + metatarsus along the ground to the hind paw
    G.push(loft([
      { p: [sg * 0.17, 0.47, -0.31], w: [0.04, 0.04], d: [0.05, 0.05] },
      { p: [sg * 0.19, 0.41, -0.27], w: [0.085, 0.085], d: [0.14, 0.14] },
      { p: [sg * 0.205, 0.28, -0.16], w: [0.1, 0.1], d: [0.165, 0.16] },
      { p: [sg * 0.21, 0.16, -0.04], w: [0.092, 0.092], d: [0.12, 0.12] },
      { p: [sg * 0.205, 0.1, 0.04], w: [0.065, 0.065], d: [0.07, 0.07] },
      { p: [sg * 0.21, 0.08, 0.07], w: [0.02, 0.02], d: [0.02, 0.02] },
    ], { nA: 20, nL: 18, part: 2 }));
    G.push(loft([
      { p: [sg * 0.2, 0.09, -0.35], w: [0.03, 0.03], d: [0.03, 0.03] },
      { p: [sg * 0.2, 0.08, -0.31], w: [0.055, 0.055], d: [0.065, 0.06] },
      { p: [sg * 0.205, 0.06, -0.12], w: [0.05, 0.05], d: [0.05, 0.05] },
      { p: [sg * 0.21, 0.05, 0.05], w: [0.062, 0.062], d: [0.045, 0.045], e: 2.6 },
      { p: [sg * 0.21, 0.045, 0.13], w: [0.066, 0.066], d: [0.04, 0.04], e: 2.6 },
      { p: [sg * 0.21, 0.04, 0.175], w: [0.02, 0.02], d: [0.015, 0.015] },
    ], { nA: 14, nL: 14, part: 3 }));
    // fore leg: fused into the chest at the elbow, tapering down to the wrist, pastern angled forward
    G.push(loft([
      { p: [sg * 0.13, 0.82, 0.16], w: [0.065, 0.065], d: [0.075, 0.075] },
      { p: [sg * 0.138, 0.7, 0.19], w: [0.098, 0.098], d: [0.112, 0.105] },
      { p: [sg * 0.143, 0.52, 0.215], w: [0.076, 0.076], d: [0.084, 0.078] },
      { p: [sg * 0.145, 0.32, 0.232], w: [0.065, 0.065], d: [0.067, 0.064] },
      { p: [sg * 0.146, 0.15, 0.246], w: [0.059, 0.059], d: [0.058, 0.056] },
      { p: [sg * 0.146, 0.085, 0.27], w: [0.06, 0.06], d: [0.056, 0.055] },
      { p: [sg * 0.146, 0.05, 0.3], w: [0.022, 0.022], d: [0.022, 0.022] },
    ], { nA: 16, nL: 22, part: 4 }));
    // fore paw with a toe split (the flattened loft is creased twice across the front)
    G.push(loft([
      { p: [sg * 0.146, 0.05, 0.22], w: [0.035, 0.035], d: [0.03, 0.03] },
      { p: [sg * 0.146, 0.05, 0.25], w: [0.07, 0.07], d: [0.05, 0.05], e: 2.6 },
      { p: [sg * 0.146, 0.047, 0.32], w: [0.076, 0.076], d: [0.045, 0.045], e: 2.6 },
      { p: [sg * 0.146, 0.038, 0.38], w: [0.066, 0.066], d: [0.036, 0.036], e: 2.4 },
      { p: [sg * 0.146, 0.03, 0.405], w: [0.022, 0.022], d: [0.014, 0.014] },
    ], { nA: 18, nL: 12, part: 5, deform: (x, y, t) => [x, y < 0 && t > 0.45 ? y + 0.011 * Math.pow(Math.abs(Math.cos(x / 0.07 * Math.PI * 1.5)), 8) : y] }));
    // cupped, erect ear: the front of each section is pushed back into a concave inner ear
    G.push(loft([
      { p: [sg * 0.082, 1.415, 0.262], w: [0.064, 0.064], d: [0.036, 0.036] },
      { p: [sg * 0.094, 1.455, 0.282], w: [0.064, 0.064], d: [0.035, 0.032] },
      // the real Hachi's left ear flopped forward, and the statue keeps it: the left tip folds down over the brow
      { p: [sg * 0.103, 1.482 - (sg > 0 ? 0.006 : 0), 0.318 + (sg > 0 ? 0.01 : 0)], w: [0.046, 0.046], d: [0.027, 0.024] },
      sg > 0 ? { p: [0.117, 1.482, 0.366], w: [0.028, 0.028], d: [0.018, 0.016] } : { p: [-0.109, 1.5, 0.35], w: [0.026, 0.026], d: [0.018, 0.016] },
      sg > 0 ? { p: [0.122, 1.466, 0.392], w: [0.012, 0.012], d: [0.009, 0.009] } : { p: [-0.112, 1.508, 0.368], w: [0.011, 0.011], d: [0.009, 0.009] },
    ], { nA: 16, nL: 10, part: 6, deform: (x, y, t, s) => [x, y > 0 ? y - 0.03 * (1 - Math.min(1, (x / Math.max(0.004, s.wl)) ** 2)) * (1 - t) : y] }));
  }
  // head: occiput → broad skull with cheek ruff → brow → stop → tapering muzzle → nose (sections point forward, d = up/down)
  G.push(loft([
    { p: [0, 1.36, 0.16], w: [0.05, 0.05], d: [0.05, 0.05] },
    { p: [0, 1.365, 0.2], w: [0.12, 0.12], d: [0.1, 0.1] },
    { p: [0, 1.36, 0.27], w: [0.152, 0.152], d: [0.115, 0.125] },
    { p: [0, 1.35, 0.34], w: [0.142, 0.142], d: [0.105, 0.12] },
    { p: [0, 1.34, 0.39], w: [0.112, 0.112], d: [0.074, 0.106], e: 2.4 },
    { p: [0, 1.325, 0.425], w: [0.097, 0.097], d: [0.048, 0.09], e: 2.7 },
    { p: [0, 1.318, 0.48], w: [0.088, 0.088], d: [0.043, 0.074], e: 3.1 },
    { p: [0, 1.315, 0.54], w: [0.08, 0.08], d: [0.041, 0.064], e: 3.0 },
    { p: [0, 1.313, 0.578], w: [0.066, 0.066], d: [0.036, 0.05], e: 2.8 },
    { p: [0, 1.312, 0.6], w: [0.034, 0.034], d: [0.02, 0.026] },
  ], { nA: 32, nL: 36, up: true, part: 7 }));
  // curled tail: up from the base of the rump, over the back and down onto the right hip
  G.push(taperedTube([[0, 0.3, -0.41], [-0.015, 0.46, -0.45], [-0.05, 0.61, -0.4], [-0.11, 0.7, -0.29], [-0.19, 0.67, -0.19], [-0.245, 0.57, -0.19], [-0.25, 0.48, -0.26], [-0.2, 0.46, -0.33]], 0.064, 0.03, 44, 12, 8));
  // merge + per-vertex colour (wear / cavity)
  const list = G.map(g => { const q = g.index ? g : g; return q; });
  const nV = list.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), uv = new Float32Array(nV * 2), col = new Float32Array(nV * 3), part = new Uint8Array(nV), idx = [];
  let o = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) { pos.set([p.getX(i), p.getY(i), p.getZ(i)], (o + i) * 3); nor.set([n.getX(i), n.getY(i), n.getZ(i)], (o + i) * 3); uv.set([u.getX(i), u.getY(i)], (o + i) * 2); part[o + i] = g.userData.parts[i]; }
    for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + o);
    o += p.count;
  }
  // occlusion proxies: spheres along each part (part id, centre, radius); a vertex is shadowed by other parts only
  const prox = [
    [1, 0, 0.2, -0.19, 0.25], [1, 0, 0.45, -0.13, 0.2], [1, 0, 0.7, 0.03, 0.2], [1, 0, 0.9, 0.12, 0.18], [1, 0, 1.12, 0.22, 0.12],
    [7, 0, 1.36, 0.28, 0.14], [7, 0, 1.32, 0.44, 0.08], [7, 0, 1.315, 0.52, 0.06],
    [8, -0.1, 0.66, -0.33, 0.06], [8, -0.23, 0.55, -0.21, 0.055],
  ];
  for (const sg of [-1, 1]) prox.push([2, sg * 0.205, 0.3, -0.16, 0.13], [2, sg * 0.21, 0.15, -0.03, 0.095], [4, sg * 0.14, 0.62, 0.2, 0.09], [4, sg * 0.145, 0.35, 0.23, 0.065], [4, sg * 0.146, 0.15, 0.245, 0.058], [5, sg * 0.146, 0.045, 0.32, 0.06], [3, sg * 0.205, 0.06, -0.1, 0.05], [6, sg * 0.1, 1.49, 0.28, 0.045]);
  const eyes = [[0.068, 1.402, 0.384], [-0.068, 1.402, 0.384]];
  for (let i = 0; i < nV; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2], pi = part[i];
    let occ = 0;
    for (const [pp, cx, cy, cz, r] of prox) {
      if (pp === pi) continue;
      const dx = cx - x, dy = cy - y, dz = cz - z, d = Math.hypot(dx, dy, dz) || 1e-3;
      const cosT = (dx * nx + dy * ny + dz * nz) / d;
      if (cosT > 0) occ += cosT * Math.min(1, (r / d) ** 2) * 1.4;
    }
    occ += Math.max(0, -ny) * 0.6 * Math.exp(-y / 0.12);                       // pedestal contact
    // sculpted recesses read dark (b): eye sockets, the lip line, nostrils, the inner ear
    let dark = 0;
    for (const [ex, ey, ez] of eyes) { const d = Math.hypot((x - ex) * 0.8, (y - ey) * 1.7, z - ez); if (d < 0.019) dark = Math.max(dark, 0.85 * Math.min(1, 1.6 * (1 - d / 0.019))); }
    if (pi === 7 && z > 0.44 && z < 0.58) { const lip = 1.268 + (z - 0.44) * 0.05; if (Math.abs(y - lip) < 0.007 && Math.abs(nx) > 0.35) dark = Math.max(dark, 0.5 * (1 - Math.abs(y - lip) / 0.007)); }
    if (pi === 7 && z > 0.585 && Math.abs(Math.abs(x) - 0.018) < 0.009 && y < 1.318 && y > 1.296) dark = Math.max(dark, 0.9);
    if (pi === 6 && nz > 0.3) dark = Math.max(dark, 0.45 * (1 - Math.min(1, Math.abs(y - 1.475) / 0.07)));
    // hand wear: nose + muzzle top, the paws, the ear tips
    let wear = 0;
    if (pi === 7) wear = Math.max(THREE.MathUtils.smoothstep(z, 0.57, 0.595) * 0.4, THREE.MathUtils.smoothstep(z, 0.46, 0.55) * THREE.MathUtils.smoothstep(ny, 0.6, 0.95) * 0.55);
    if (pi === 5) wear = 0.1 * THREE.MathUtils.smoothstep(ny, 0.7, 0.95); else if (pi === 4) wear = THREE.MathUtils.smoothstep(0.16 - y, 0, 0.1) * 0.4 * Math.max(0, nz); else if (pi === 3) wear = THREE.MathUtils.smoothstep(z, 0.02, 0.14) * 0.2 * THREE.MathUtils.smoothstep(ny, 0.7, 0.95);
    if (pi === 6) wear = THREE.MathUtils.smoothstep(y, 1.52, 1.55) * 0.5;
    col[i * 3] = wear * (1 - dark); col[i * 3 + 1] = Math.min(1, occ); col[i * 3 + 2] = dark;
  }
  for (let i = 0; i < nV; i++) if (part[i] === 6 || part[i] === 7) {
    pos[i * 3] *= 1.18; pos[i * 3 + 1] = 1.27 + (pos[i * 3 + 1] - 1.3) * 1.18; pos[i * 3 + 2] = 0.25 + (pos[i * 3 + 2] - 0.25) * 1.18;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
let AKITA = null;
/** Place the sculpt at (x, y, z) facing (fx, fz). */
function akita(batch, mat, x, y, z, fx, fz) {
  if (!AKITA) AKITA = akitaGeometry();
  const g = AKITA.clone(); g.rotateY(Math.atan2(fx, fz)); g.translate(x, y, z);
  batch.add(mat, g, x, z);
  return AKITA.index.count / 3;
}

export function build({ key, data, batch, inst, group, rng, CITY }) {
  const M = S.mats();
  const plaza = (CITY.plazas || []).find(p => p.id === 'hachiko') || { statue: { pos: data.pos, rotY: data.rotY }, koban: null, trees: [] };
  const [sx, sz] = plaza.statue.pos;
  const [fx, fz] = S.dirOf(plaza.statue.rotY || 0);           // statue faces the Hachiko exit (east)
  const ry = Math.atan2(fx, fz);
  const colliders = [];
  const lw = (lx, lz) => [sx + fz * lx + fx * lz, sz - fx * lx + fz * lz];
  // ---- granite pedestal, 1.2 m: base slab, step, block, polished cap (bevelled top edges, a shadow gap under the
  //      cap) + bronze plaque. The two floods stand on the square's lamp poles: key front-left high, warm fill from
  //      the station side.
  const SMt = statueMats();
  const PH = PLINTH_H, y0 = batch.lift || 0;
  SMt.plinth.userData.topY.value = y0 + PH; SMt.plinth.userData.statueXZ.value.set(sx, sz);
  { const [kx, kz] = lw(2.2, 3.4), [fx2, fz2] = lw(-4.6, 0.8); FLOOD.uFlood0.value.set(kx, y0 + 6.2, kz); FLOOD.uFlood1.value.set(fx2, y0 + 5.2, fz2); }
  course(batch, SMt.plinth, sx, 0, 0.14, sz, 2.9, 3.0, ry, 0.03);
  course(batch, SMt.plinth, sx, 0.14, 0.32, sz, 2.05, 2.2, ry, 0.03);
  course(batch, SMt.plinth, sx, 0.32, PH - 0.12, sz, 1.2, 1.36, ry, 0.02);
  course(batch, SMt.plinth, sx, PH - 0.12, PH, sz, 1.34, 1.5, ry, 0.035);
  batch.add(M.bronzeDark, L.boxAt(sx, PH - 0.135, sz, 1.26, 0.03, 1.42, ry, false), sx, sz);   // shadow gap under the cap
  const [qx, qz] = lw(0, 0.69);
  S.signQuad(batch, qx, 0.68, qz, fx, fz, { text: '忠犬ハチ公', sub: 'HACHIKO  1934 / 1948', w: 0.8, h: 0.44, bg: '#3a2a18', fg: '#d8b060', emissive: 0.3, weight: '700' });
  const statueTris = akita(batch, SMt.bronze, sx, PH, sz, fx, fz);
  colliders.push(S.boxCollider(sx, sz, 2.95, 2.8, 3.05, ry));
  // ---- garden behind the statue: curved granite wall (0.6 m) + hedge, chain bollards in front
  const th0 = Math.atan2(-fz, -fx);                            // behind = opposite of facing (x/z angle)
  batch.add(M.granite, S.cylSegment(sx, sz, 3.4, 0.15, 0.75, th0 - 1.15, th0 + 1.15, 20, { metres: true }), sx, sz);
  batch.add(M.granite, S.cylSegment(sx, sz, 2.9, 0.15, 0.75, th0 - 1.15, th0 + 1.15, 20, { metres: true, inward: true }), sx, sz);
  batch.add(M.granite, S.disc(sx, sz, 2.9, 3.4, 0.75, { seg: 20, th0: th0 - 1.15, th1: th0 + 1.15 }), sx, sz);
  for (let t = -0.95; t <= 0.95; t += 0.32) { const th = th0 + t; inst.add('hedge', S.HEDGE_GEO, M.hedge, sx + Math.cos(th) * 2.35, 0.55, sz + Math.sin(th) * 2.35, 0, 1.25, 0.9, 1.1); }
  for (let t = -0.95; t <= 0.95; t += 0.48) { const th = th0 + t; S.ibox(inst, 'lm_post', M.darkMetal, sx + Math.cos(th) * 3.15, 0.75, sz + Math.sin(th) * 3.15, 0.06, 0.9, 0.06); }
  colliders.push({ obb: { center: new THREE.Vector3(sx - fx * 2.6, 0.5, sz - fz * 2.6), halfSize: new THREE.Vector3(3.2, 0.5, 1.2), rotationY: ry } });
  const thF = Math.atan2(fz, fx);
  for (let t = -0.9; t <= 0.9; t += 0.45) {
    const th = thF + t, bx = sx + Math.cos(th) * 2.8, bz = sz + Math.sin(th) * 2.8;
    batch.add(M.bronzeDark, S.placed(CYL, bx, 0.15 + 0.3, bz, { s: [0.06, 0.6, 0.06] }), sx, sz);
    batch.add(M.bronzeDark, S.placed(CYL, bx, 0.765, bz, { s: [0.08, 0.05, 0.08] }), sx, sz);   // flat cap (a sphere threw pin-point glints)
    if (t > -0.9) { const thp = th - 0.45, ax = sx + Math.cos(thp) * 2.8, az = sz + Math.sin(thp) * 2.8; batch.add(M.bronzeDark, L.boxAt((ax + bx) / 2, 0.62, (az + bz) / 2, Math.hypot(bx - ax, bz - az), 0.03, 0.03, L.rotYOf(bx - ax, bz - az), false), sx, sz); }
  }
  // ---- 渋谷駅前交番
  if (plaza.koban) colliders.push(...koban({ batch, inst, group }, plaza.koban.pos[0], plaza.koban.pos[1], plaza.koban.rotY, { w: 5.4, d: 4.8, storeys: 2, name: '渋谷駅前交番', hachiko: true }));
  // ---- tree pits (granite ring + soil) where props plant the zelkovas, granite planters + benches along the edges
  for (const [tx, tz] of plaza.trees || []) {
    batch.add(M.granite, S.cylSegment(tx, tz, 1.3, 0.15, 0.55, 0, Math.PI * 2, 18, { metres: true }), tx, tz);
    batch.add(M.granite, S.disc(tx, tz, 1.0, 1.3, 0.55, { seg: 18 }), tx, tz);
    batch.add(M.bronzeDark, S.disc(tx, tz, 0, 1.0, 0.4, { seg: 18 }), tx, tz);
    colliders.push({ obb: { center: new THREE.Vector3(tx, 0.3, tz), halfSize: new THREE.Vector3(1.3, 0.3, 1.3), rotationY: 0 } });
  }
  const benches = [[12, 30, 0], [12, 40, 0], [40, 38, 0], [40, 46, 0], [20, 52, Math.PI / 2], [34, 52, Math.PI / 2]];
  for (const [bx, bz, r] of benches) {
    batch.add(M.granite, L.boxAt(bx, 0.15 + 0.22, bz, 0.5, 0.44, 2.2, r, true), bx, bz);
    batch.add(M.wood, L.boxAt(bx, 0.15 + 0.47, bz, 0.6, 0.06, 2.3, r, true), bx, bz);
    colliders.push({ obb: { center: new THREE.Vector3(bx, 0.4, bz), halfSize: new THREE.Vector3(0.35, 0.4, 1.2), rotationY: r } });
  }
  // ---- south edge of the square (station side): granite planters with shrubs, crowd-control rails between them,
  //      a standing area-map board and a digital signage pylon
  const planter = (px, pz, w, d, r = 0) => {
    batch.add(M.granite, L.boxAt(px, 0.15 + 0.3, pz, w, 0.6, d, r, true), px, pz);
    batch.add(M.lawn, L.boxAt(px, 0.15 + 0.61, pz, w - 0.3, 0.02, d - 0.3, r, true), px, pz);
    const n = Math.max(1, Math.round(Math.max(w, d) / 1.1));
    for (let i = 0; i < n; i++) { const t = (i + 0.5) / n - 0.5, ox = Math.cos(r) * t * (w - 0.6), oz = -Math.sin(r) * t * (w - 0.6); inst.add('hedge', S.HEDGE_GEO, M.hedge, px + ox, 0.95, pz + oz, i * 1.3, 0.8, 0.6, 0.8); }
    colliders.push({ obb: { center: new THREE.Vector3(px, 0.45, pz), halfSize: new THREE.Vector3(w / 2, 0.45, d / 2), rotationY: r } });
  };
  for (const [px, pz] of [[14, 53], [21, 53], [36.5, 53], [41.5, 49]]) planter(px, pz, px > 41 ? 1.4 : 4.2, px > 41 ? 4.2 : 1.4);
  const rail = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az), r = L.rotYOf(bx - ax, bz - az), n = Math.max(1, Math.round(len / 2));
    for (let i = 0; i <= n; i++) S.ibox(inst, 'lm_railpost', M.silver, ax + (bx - ax) * i / n, 0.15, az + (bz - az) * i / n, 0.06, 1.0, 0.06);
    for (const y of [0.55, 1.1]) batch.add(M.silver, L.boxAt((ax + bx) / 2, 0.15 + y, (az + bz) / 2, len, 0.05, 0.05, r, false), ax, az);
    colliders.push({ obb: { center: new THREE.Vector3((ax + bx) / 2, 0.6, (az + bz) / 2), halfSize: new THREE.Vector3(len / 2, 0.6, 0.1), rotationY: r } });
  };
  rail(16.3, 53.2, 18.7, 53.2); rail(23.3, 53.2, 25.5, 53.2); rail(34.2, 53.2, 32, 53.2);
  // area map board (faces west into the square) and a signage pylon by the koban
  {
    const bx = 42.2, bz = 42, SA = 1;
    batch.add(M.darkMetal, L.boxAt(bx, 0.15 + 1.2, bz, 0.25, 2.4, 1.9, 0, false), bx, bz);
    S.signQuad(batch, bx - 0.14, 1.55, bz, -1, 0, { text: '渋谷町 周辺案内図', sub: 'AREA MAP  ―  ハチ公前広場  現在地', w: 1.7, h: 1.5, bg: '#e8efe4', bg2: '#c8d8c0', fg: '#1d4f2e', emissive: 0.9 * SA, weight: '800' });
    S.signQuad(batch, bx - 0.14, 2.45, bz, -1, 0, { text: 'SHIBUYA-CHO', w: 1.7, h: 0.22, bg: '#1d8f3e', fg: '#ffffff', emissive: 0.9, weight: '800' });
    colliders.push(S.boxCollider(bx, bz, 0.35, 2.6, 2.0));
    // two double-sided ad pylons east of the koban (the square's digital signage columns)
    for (const [px, pz, k, r] of [[35.5, 47.5, 0, 0.5], [18.5, 57, 1, -0.6]]) {
      const ad = [{ text: 'SHIBUYA46', sub: '純愛  ―  NOW ON SALE', bg: '#ff2d8a', bg2: '#5a0f9c' }, { text: 'Tojo Cola', sub: '爽快、東城。', bg: '#c8102e', bg2: '#5a0810' }][k];
      const fx = Math.sin(r), fz = Math.cos(r);
      batch.add(M.darkMetal, L.boxAt(px, 0.15 + 1.4, pz, 1.1, 2.8, 0.45, r, false), px, pz);
      batch.add(M.silver, L.boxAt(px, 0.15 + 2.86, pz, 1.2, 0.12, 0.55, r, false), px, pz);
      for (const sg of [1, -1]) S.signQuad(batch, px + fx * sg * 0.23, 1.65, pz + fz * sg * 0.23, fx * sg, fz * sg, { ...ad, w: 0.95, h: 2.1, fg: '#ffffff', emissive: 1.0, weight: '900' });
      colliders.push(S.boxCollider(px, pz, 1.2, 3.0, 0.55, r));
    }
  }
  void rng; void key;
  const anchors = { statue: new THREE.Vector3(0, PH, 0), statueTop: new THREE.Vector3(0, PH + 1.62, 0), plaque: new THREE.Vector3(qx - sx, 0.68, qz - sz), statueTris, koban: plaza.koban ? new THREE.Vector3(plaza.koban.pos[0] - sx, 3.2, plaza.koban.pos[1] - sz) : null };
  return { group: new THREE.Group(), origin: [sx, sz], worldSpace: true, colliders, lights: [], anchors, facades: [] };
}

export default { build, KEYS, SIZE };
