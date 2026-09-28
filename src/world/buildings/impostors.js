// [city] Silhouette impostors beyond the playable ±220 m square: a sea of low-rise boxes with a lit-window texture
// out to ~800 m, plus the recognisable far towers (セルリアンタワー SW, 渋谷インフィニティ / 新宿 cluster N, 六本木 E).
// One merged mesh for the sea, one for the towers.
import * as THREE from 'three';
import * as L from './lib.js';
import { VISTA } from './streets.js';
import * as S from './shared.js';
import { UPPER_WEST } from '../upperWestData.js';
import { DENSITY_CONTEXT } from '../densityContext.js';
import { BACKDROP_TRUE } from '../dogenzakaData.js';

let M = null;
/** Lit windows and lamps pierce the night haze: the emissive term is added back after the fog mix (k = share of the
 *  fogged-out emissive restored), so a tower 400 m out still reads as floors of lit rooms, not a grey slab. */
function fogKeepsEmissive(m, k) {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', `#include <fog_fragment>
#ifdef USE_FOG
  gl_FragColor.rgb += totalEmissiveRadiance * fogFactor * ${k.toFixed(2)};
#endif`);
  };
  m.customProgramCacheKey = () => `fogEmi${k}`;
  return m;
}
function mats() {
  if (M) return M;
  // 16 bays × 40 storeys (48 m × 140 m per repeat): whole tenant floors on or off, runs of lit bays, warm / cool /
  // dim rooms, so no two floors (and, with per-box uv offsets, no two boxes) show the same pattern
  const mk = (base, seed, floorOn, emiScale) => {
    const W = 512, H = 1280, cols = 16, rows = 40, cw = W / cols, rh = H / rows;
    const map = L.makeCanvas(W, H), emi = L.makeCanvas(W, H);
    const mc = map.getContext('2d'), ec = emi.getContext('2d');
    mc.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; mc.fillRect(0, 0, W, H);
    ec.fillStyle = '#000'; ec.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      const on = L.hash(r, 1, seed) < floorOn, warm = L.hash(r, 2, seed) < 0.6, fb = 0.45 + L.hash(r, 3, seed) * 0.55;
      let c = 0;
      while (c < cols) {
        const run = 1 + Math.floor(L.hash(c, r, seed + 4) * 5), lit = on ? L.hash(c, r, seed + 5) < 0.8 : L.hash(c, r, seed + 6) < 0.1;
        for (let k = c; k < Math.min(cols, c + run); k++) {
          const x = k * cw + 3, y = r * rh + 5, w = cw - 6, h = rh * 0.55;
          if (lit) {
            const b = fb * (0.75 + L.hash(k, r, seed + 7) * 0.25) * emiScale, col = warm ? [255, 222, 168] : [208, 224, 255];
            mc.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.8)`; mc.fillRect(x, y, w, h);
            ec.fillStyle = `rgb(${col[0] * b | 0},${col[1] * b | 0},${col[2] * b | 0})`; ec.fillRect(x, y, w, h);
          } else { mc.fillStyle = 'rgba(10,12,18,0.72)'; mc.fillRect(x, y, w, h); }
        }
        c += run;
      }
    }
    const m = L.std({ map: L.canvasTex(map, { wrap: true }), emissiveMap: L.canvasTex(emi, { wrap: true }), emissive: 0xffffff, emissiveIntensity: 1.0, roughness: 0.8, metalness: 0.1 });
    m.userData.sign = { emissive: 1.0 }; L.signMaterials.add(m);
    m.userData.noShadow = true;
    return fogKeepsEmissive(m, 0.8);
  };
  M = { sea: mk([58, 60, 68], 7, 0.28, 1.0), tower: mk([48, 54, 66], 9, 0.55, 1.15) };
  M.sea.name = 'imp_sea'; M.tower.name = 'imp_tower';
  const red = fogKeepsEmissive(L.std({ color: 0xff2a2a, emissive: 0xff2a2a, emissiveIntensity: 2.4, roughness: 0.5 }), 0.95); red.name = 'imp_aviation';
  red.userData.sign = { emissive: 2.4 }; L.signMaterials.add(red); red.userData.noShadow = true;
  const lamp = fogKeepsEmissive(L.std({ color: 0xffe0b0, emissive: 0xffd9a0, emissiveIntensity: 2.0, roughness: 0.5 }), 0.85); lamp.name = 'imp_lamp';
  lamp.userData.sign = { emissive: 2.0 }; L.signMaterials.add(lamp); lamp.userData.noShadow = true;
  const deck = L.std({ color: 0x5a5c60, roughness: 0.85, metalness: 0.05 }); deck.name = 'imp_deck';
  // crown light band of the tall towers (the lit top floor / crown wash every Tokyo high-rise shows at night)
  const crown = fogKeepsEmissive(L.std({ color: 0xdfe6f0, emissive: 0xcfdcf0, emissiveIntensity: 0.35, roughness: 0.6 }), 0.6); crown.name = 'imp_crown';
  crown.userData.sign = { emissive: 0.35 }; L.signMaterials.add(crown); crown.userData.noShadow = true;
  Object.assign(M, { red, lamp, deck, crown });
  return M;
}
/** Box with window uvs (1 repeat = 48 m × 140 m) shifted by a per-box hash so neighbours never line up. The roof /
 *  underside faces sample one unlit wall texel (a lit-window texel there read as a bright outline along the top). */
function winBox(x, y, z, w, h, d, rot, seed) {
  const g = L.boxAt(x, y, z, w, h, d, rot, true);
  const du = Math.floor(L.hash(seed, 1, 71) * 16) / 16, dv = Math.floor(L.hash(seed, 2, 71) * 40) / 40;
  const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) / 48 + du, uv.getY(k) / 140 + dv);
  for (let k = 8; k < 16; k++) uv.setXY(k, 1.5 / 512, 1 - 1.5 / 1280);
  return g;
}
/** Roof clutter silhouette on an impostor box: plant room / penthouse, a tank, sometimes a mast or a board frame. */
function roofSil(b, R, x, top, z, w, d, rot, seed) {
  const c = Math.cos(rot), s = Math.sin(rot), at = (u, v) => [x + u * c + v * s, z - u * s + v * c];
  const h1 = L.hash(seed, 3, 73), h2 = L.hash(seed, 4, 73), h3 = L.hash(seed, 5, 73);
  if (h1 < 0.75) { const [px, pz] = at((h2 - 0.5) * w * 0.4, (h3 - 0.5) * d * 0.4), pw = w * (0.22 + h2 * 0.2), pd = d * (0.22 + h3 * 0.2), ph = 2.6 + h1 * 3; b.add(R.deck, L.boxAt(px, top + ph / 2, pz, pw, ph, pd, rot, false)); }
  if (h2 < 0.6) { const [px, pz] = at(-w * 0.3, d * 0.25); b.add(R.deck, L.boxAt(px, top + 1.7, pz, 1.8, 3.4, 1.8, rot, false)); }
  if (h3 < 0.25) { const [px, pz] = at(w * 0.3, -d * 0.3); b.add(R.deck, L.boxAt(px, top + 4, pz, 0.35, 8, 0.35, 0, false)); }
  else if (h3 > 0.8) { const [px, pz] = at(0, d * 0.45); b.add(R.deck, L.boxAt(px, top + 2.8, pz, w * 0.6, 3.2, 0.3, rot, false)); }
}
/** A tall box gets a setback upper third, a plant crown and a red aviation lamp. */
function tallBox(b, R, x, g0, z, w, h, d, rot, seed) {
  const h1 = h * 0.72;
  b.add(R.tower, winBox(x, g0 + h1 / 2 - 2, z, w, h1, d, rot, seed));
  b.add(R.tower, winBox(x, g0 + h1 + (h - h1) / 2 - 2, z, w * 0.78, h - h1, d * 0.78, rot, seed + 3));
  if (h > 90) b.add(R.crown, L.boxAt(x, g0 + h - 3.6, z, w * 0.78 + 0.2, 0.7, d * 0.78 + 0.2, rot, false));
  b.add(R.deck, L.boxAt(x, g0 + h - 2 + 2.2, z, w * 0.45, 4.4, d * 0.45, rot, true));
  b.add(R.red, L.boxAt(x, g0 + h - 2 + 4.8, z, 1.4, 1.2, 1.4, 0, false));
}

export function buildImpostors(ctx) {
  const { batch, rng, group } = ctx;
  const yAt = ctx.yAt || (() => 0);   // the 道玄坂 plateau continues beyond the map edge
  // road corridors that run out of the map (streets.js VISTA): no impostor box on them or on their backdrop lots
  const vista = ctx.CITY.roads.filter(r => VISTA[r.id]).map(r => { const p = r.path, a = p[p.length - 2], b = p[p.length - 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]); return { a: b, b: [b[0] + (b[0] - a[0]) / l * 400, b[1] + (b[1] - a[1]) / l * 400], clear: r.width / 2 + r.sidewalk + 40 }; });
  const R = mats();
  const half = ctx.CITY.bounds / 2;
  const seaBatch = new L.GeoBatch();
  // pass 15: the 道玄坂 corridor is real city (buildings/dogenzaka.js): no impostor box inside its outline or within a
  // box's reach of it; the real tall masses behind its frontage (PLATEAU footprints 42–110 m off the street: 渋谷ソラスタ
  // 108.7 m, the hotels round 円山町 …) stand there instead, as lit-window prisms on their own footprints
  const corr = ctx.CITY.corridor && ctx.CITY.corridor.outline;
  const t246 = ctx.CITY.roads.filter((q) => q.id === 'tamagawa_ue');
  const nearCorr = (x, z, r) => {
    if (L.pointInPoly(x,z,UPPER_WEST.poly) || UPPER_WEST.poly.some((a,i)=>L.distToSegment(x,z,...a,...UPPER_WEST.poly[(i+1)%UPPER_WEST.poly.length])<r+2)) return true;
    if (DENSITY_CONTEXT.some(b => L.pointInPoly(x,z,b.poly) || b.poly.some((a,i)=>{const q=b.poly[(i+1)%b.poly.length];return L.distToSegment(x,z,...a,...q)<r;}))) return true;
    for (const q of t246) for (let i = 0; i < q.path.length - 1; i++) if (L.distToSegment(x, z, q.path[i][0], q.path[i][1], q.path[i + 1][0], q.path[i + 1][1]) < r + 8) return true;
    const outline = ctx.CITY.scope?.outline;
    if (outline && (L.pointInPoly(x,z,outline) || outline.some((a,i) => { const b=outline[(i+1)%outline.length]; return L.distToSegment(x,z,a[0],a[1],b[0],b[1])<r; }))) return true;
    if (!corr) return false;
    if (L.pointInPoly(x, z, corr)) return true;
    for (let i = 0, j = corr.length - 1; i < corr.length; j = i++) if (L.distToSegment(x, z, corr[j][0], corr[j][1], corr[i][0], corr[i][1]) < r) return true;
    return false;
  };
  for (const [k, b] of [...BACKDROP_TRUE,...DENSITY_CONTEXT].entries()) {
    if (UPPER_WEST.replacedContext.includes(b.id)) continue;
    const c = L.polyCentroid(b.poly);
    if (ctx.CITY.scope && L.pointInPoly(c[0],c[1],ctx.CITY.scope.outline)) continue;
    const y0 = yAt(c[0], c[1]) - 1.5, du = Math.floor(L.hash(k, 1, 83) * 16) * 3;
    seaBatch.add(b.h > 55 ? R.tower : R.sea, L.extrudePolygon(b.poly, y0, y0 + b.h + 1.5, { cap: false, faceUV: (i) => ({ su: 1 / 48, sv: 1 / 140, u0: du + i * 7, v0: Math.floor(L.hash(k, i, 84) * 40) * 3.5 }) }), c[0], c[1]);
    seaBatch.add(R.deck, L.polygonCap(b.poly, y0 + b.h + 1.5, 0.25), c[0], c[1]);
    if (b.h > 45) seaBatch.add(R.red, L.boxAt(c[0], y0 + b.h + 2.5, c[1], 1.2, 1.0, 1.2, 0, false));
  }
  // ring of boxes: density falls with distance; sizes grow so far rows still read as a skyline
  const n = 1400;
  let placed = 0;
  for (let i = 0; i < n * 4 && placed < n; i++) {
    const a = rng() * Math.PI * 2;
    const d = half + 24 + Math.pow(rng(), 0.7) * 560;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.abs(x) < half + 12 && Math.abs(z) < half + 12) continue;
    if (nearCorr(x, z, 24 + Math.pow(Math.max(0, d - half) / 560, 1) * 40)) continue;
    if (vista.some(v => L.distToSegment(x, z, v.a[0], v.a[1], v.b[0], v.b[1]) < v.clear)) continue;   // keep the 道玄坂 / 文化村通り vistas open
    const far = (d - half) / 560;
    const w = rng.range(14, 30) * (1 + far * 1.5), dd = rng.range(14, 30) * (1 + far * 1.5);
    let h = rng.range(10, 34) * (1 + far * 0.6);
    if (rng() < 0.08) h *= rng.range(1.8, 3.2);
    const rot = rng.range(0, Math.PI);
    if (h > 55) tallBox(seaBatch, R, x, yAt(x, z), z, w, h, dd, rot, i);
    else { seaBatch.add(R.sea, winBox(x, h / 2 - 2 + yAt(x, z), z, w, h, dd, rot, i)); roofSil(seaBatch, R, x, h - 2 + yAt(x, z), z, w, dd, rot, i); }
    placed++;
  }
  // ---- 道玄坂上: where the street goes over its crest — the Route 246 junction under the 首都高 3号 viaduct and the
  //      office / hotel towers around it (the セルリアンタワー mass to the left), with streetlights up the far carriageway
  const dg = ctx.CITY.roads.find(r => r.id === 'dogenzaka');
  if (dg && VISTA.dogenzaka) {
    const p = dg.path, a = p[p.length - 2], b = p[p.length - 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l, lx = uz, lz = -ux;               // along / left (seen walking up)
    const at = (s, o) => [b[0] + ux * s + lx * o, b[1] + uz * s + lz * o];
    const end = VISTA.dogenzaka, rot = Math.atan2(-uz, ux);
    for (const [s, o, w, d, h, k] of [[end + 40, -30, 34, 28, 96, 1], [end + 55, 34, 30, 30, 118, 2], [end + 95, 8, 40, 32, 142, 3], [end + 70, 70, 46, 40, 184, 4], [end + 30, -62, 26, 26, 64, 5]]) {
      const [x, z] = at(s, o);
      tallBox(seaBatch, R, x, yAt(x, z), z, w, h, d, rot, 900 + k);
    }
    // 首都高 3号 viaduct across the top of the hill (deck, fascia lamps, piers clear of the carriageway)
    const [vx, vz] = at(end + 18, 0), vy = yAt(vx, vz), VL = 320;
    const drot = Math.atan2(-lz, lx);
    seaBatch.add(R.deck, L.boxAt(vx, vy + 12.5, vz, VL, 2.6, 17, drot, true));
    seaBatch.add(R.deck, L.boxAt(vx - ux * 8.7, vy + 14.4, vz - uz * 8.7, VL, 1.2, 0.4, drot, true));   // parapet facing down the hill
    for (let t = -VL / 2 + 6; t < VL / 2; t += 8) seaBatch.add(R.lamp, L.boxAt(vx + lx * t - ux * 8.95, vy + 11.1, vz + lz * t - uz * 8.95, 0.9, 0.18, 0.12, drot, false));
    for (const t of [-150, -110, -70, -34, 34, 70, 110, 150]) { const px = vx + lx * t, pz = vz + lz * t; seaBatch.add(R.deck, L.boxAt(px, yAt(px, pz) + 5.6, pz, 3.2, 11.2, 3.2, drot, true)); }
    S.signQuad(seaBatch, vx - ux * 8.6, vy + 12.5, vz - uz * 8.6, -ux, -uz, { text: '首都高速 3号渋谷線', sub: '道玄坂上', w: 7, h: 1.3, bg: '#1a4a9a', fg: '#ffffff', emissive: 0.9, weight: '800' });
    // streetlights up the far carriageway (beyond the props module's range)
    const half = dg.width / 2 + 0.6;
    for (let s = -end + 10; s < end + 10; s += 26) for (const sg of [1, -1]) {
      const [x, z] = at(s, sg * half), y0 = yAt(x, z);
      if (Math.abs(x) < ctx.CITY.bounds / 2 - 10 && Math.abs(z) < ctx.CITY.bounds / 2 - 10) continue;
      seaBatch.add(R.deck, L.boxAt(x, y0 + 4, z, 0.2, 8, 0.2, 0, false));
      seaBatch.add(R.lamp, L.boxAt(x - lx * sg * 1.1, y0 + 7.9, z - lz * sg * 1.1, 1.0, 0.16, 0.4, rot, false));
    }
  }
  // named far towers (approximate real bearings from the crossing, compressed distances)
  const towers = [
    // セルリアンタワー (SSW, 362 m real, OSM 55441040 at (−101, 348)): pass 15 moved it off the corridor's flank, where the
    // old compressed placement (−330, 250) stood a 184 m tower beside 道玄坂上交番 — just south of the square's 玉川通り
    { x: -112, z: 262, w: 46, d: 40, h: 184, name: 'cerulean' },
    { x: -60, z: -720, w: 40, d: 40, h: 235, name: 'shinjuku1' }, { x: 10, z: -760, w: 48, d: 44, h: 243, name: 'shinjuku2' }, { x: -140, z: -740, w: 44, d: 40, h: 225, name: 'shinjuku3' }, { x: 80, z: -700, w: 36, d: 36, h: 200, name: 'shinjuku4' }, { x: -230, z: -690, w: 60, d: 50, h: 210, name: 'shinjuku5' },
    { x: 700, z: -260, w: 56, d: 56, h: 238, name: 'roppongi' }, { x: 640, z: -180, w: 44, d: 44, h: 200, name: 'azabudai' },
    { x: 330, z: 380, w: 40, d: 40, h: 140, name: 'ebisu' }, { x: 420, z: 320, w: 36, d: 36, h: 120, name: 'ebisu2' },
    // (pass 15: the 'shoto' tower at (−520, 80) went — in true metres that is 円山町's low-rise, beside the corridor)
  ];
  for (const [k, t] of towers.entries()) tallBox(seaBatch, R, t.x, yAt(t.x, t.z), t.z, t.w, t.h, t.d, rng.range(0, 0.6), 700 + k);
  const meshes = seaBatch.build(group, { castShadow: false, receiveShadow: false, name: 'impostor' });
  for (const m of meshes) m.frustumCulled = false;
  void batch;
  return meshes.length;
}

export default { buildImpostors };
