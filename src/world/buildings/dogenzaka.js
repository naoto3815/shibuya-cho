// [city] 道玄坂 corridor builder (pass 15): the real buildings along both frontages from the 109 up to 道玄坂上, the
// 道玄坂二丁目南地区 construction yard, 道玄坂上交番, the 首都高3号 viaduct and 玉川通り at the top, and the corridor's own
// street furniture (signal heads with live aspects, the 道玄坂上 bus stop, the 渋谷町駅 A0 / A1 exits, the 道玄坂乃碑,
// the 百軒店 arch, bicycle parking, street trees, guard fences, street-name plates).
//
// Data: dogenzakaData.js (hand) over dogenzakaOsm.js (generated: OSM + PLATEAU + GSI). Everything is merged into the
// city's GeoBatch / Instancer (no own draw calls except the signal lenses: one InstancedMesh), signs go into the shared
// sign atlas; no canvas of its own. The mobile profile builds the rear row plainer (no roof plant, no stairs).
//
//   corridorFootprints()  → [{ id, sid, poly (CW), storeys, ... }]   the corridor's building footprints (cached)
//   buildDogenzaka(ctx)   → { colliders: [[collider, tag]], facades, plan: [...], update(engine), stats }
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as L from './lib.js';
import * as S from './shared.js';
import {buildKojiBuilding,dressKojiCentreSide} from './koji.js';
import { buildBuilding, getAtlases } from './genericBuilding.js';
import { koban as buildKoban } from './smallLandmarks.js';
import * as DG from '../dogenzakaData.js';
import {SCOPE_ROADS} from '../scopeData.js';
import { MOBILE } from '../../core/mobileProfile.js';

const SW_H = 0.15;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------------------------------------ footprints
let FP = null;
function roofOf(b) {
  // PLATEAU measuredHeight is the top of the roof plant; the roof slab sits ~1–2.5 m below it
  return b.h > 20 ? b.h - 2.2 : b.h - 0.8;
}
export function corridorFootprints() {
  if (FP) return FP;
  FP = [];
  const inPoly = (p, poly) => L.pointInPoly(p[0], p[1], poly);
  for (const b of DG.BUILDINGS) {
    const sid = b.id.replace('13113-bldg-', '');
    let poly = L.ensureCW(b.poly.map((p) => [p[0], p[1]]));
    // Two old PLATEAU rear walls straddled newly added OSM lanes. Trim only
    // these rear edges; the detailed Dogenzaka-facing elevations stay in place.
    const laneId = { '9488':87250166, '9513':275974039 }[sid];
    if(laneId) for(const r of SCOPE_ROADS.filter(r=>r.osm===laneId)) for(let i=1;i<r.path.length;i++){
      const a=r.path[i-1],d=r.path[i],len=Math.hypot(d[0]-a[0],d[1]-a[1]);if(len<0.1)continue;
      let nx=-(d[1]-a[1])/len,nz=(d[0]-a[0])/len;const c=L.polyCentroid(poly);
      if((c[0]-a[0])*nx+(c[1]-a[1])*nz<0){nx=-nx;nz=-nz;}
      const off=r.width/2+1.1,trimmed=clipHalf(poly,a[0]+nx*off,a[1]+nz*off,nx,nz);
      if(trimmed.length>=3&&Math.abs(L.polyArea(trimmed))>15)poly=trimmed;
    }
    const c = L.polyCentroid(poly);
    // the construction yard and its notch were cleared in 2023 (their PLATEAU / OSM buildings are already filtered)
    if (inPoly(c, DG.WORKS.site) || inPoly(c, DG.WORKS.notch)) continue;
    const T = DG.TENANTS[sid] || null;
    const roof = roofOf(b);
    let storeys = b.levels && b.levels > 0 && b.levels * 2.6 <= roof + 3 ? b.levels : Math.max(1, Math.round((roof - 4.2) / 3.3) + 1);
    if (T && T.style === 'shop') storeys = Math.min(storeys, Math.max(1, Math.round(roof / 3.2)));
    FP.push({ id: 'dg_' + sid, sid, poly, h: b.h, roof, storeys, T, s: b.s, side: b.side, d: b.d, name: b.name || (T && T.name) || null, use: b.use, clip: b.clip, levels: b.levels, osm: b.osm });
  }
  return FP;
}

// ------------------------------------------------------------------------------------------------ helpers
function siteLevels(poly, yAt) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
    for (let t = 0; t < k; t++) { const y = yAt(a[0] + (b[0] - a[0]) * t / k, a[1] + (b[1] - a[1]) * t / k); if (y < lo) lo = y; if (y > hi) hi = y; }
  }
  const c = L.polyCentroid(poly), y = yAt(c[0], c[1]); if (y < lo) lo = y; if (y > hi) hi = y;
  return { lo, hi };
}
function liftOut(r, billboards, nb0, dy) {
  if (!dy) return;
  for (const col of r.colliders || []) { if (col.obb) col.obb.center.y += dy; else if (col.min && col.max) { col.min.y += dy; col.max.y += dy; } }
  for (const f of r.facades || []) f.position.y += dy;
  for (let i = nb0; i < billboards.length; i++) billboards[i].position.y += dy;
}
const hashS = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
const STYLE_OF = { mall: 'tenant', tenant: 'tenant', office: 'office', glass: 'office', entertainment: 'entertainment', cinema: 'entertainment', hotel: 'hotel', residential: 'residential', shop: 'tenant' };
const WALL_OF = { mall: 3, glass: 5, cinema: 0, hotel: 7, residential: 6, office: 3 };

// ------------------------------------------------------------------------------------------------ materials
let MM = null;
function mats() {
  if (MM) return MM;
  const M = S.mats();
  const mk = (o, name) => { const m = L.std(o); m.name = 'dg_' + name; return m; };
  // (draw calls: every material the corridor adds is one more merged mesh drawn everywhere, so it reuses the
  // landmark set wherever it can — only the crane yellow, the construction net and the lit hoarding are its own)
  MM = {
    ...M,
    steel: M.darkMetal, steelGrey: M.silver, craneWhite: M.whiteMetal, deck: M.concrete, deckDark: M.darkMetal,
    dirt: M.concrete, void: M.innerDark, soundWall: M.glassClear, leaf: M.hedge, bark: M.wood, stele: M.granite, rough: M.concrete,
    sigBody: M.darkMetal, sigPole: M.silver,
    crane: mk({ color: 0xe8c21a, roughness: 0.5, metalness: 0.3 }, 'crane'),
    net: (() => { const m = mk({ color: 0x8e979c, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.85 }, 'net'); m.userData.noShadow = true; return m; })(),
    // the white site hoarding: its own floodlit look at night (Tokyo sites light their hoarding and its print)
    hoard: S.nightMaterial(mk({ color: 0xe9e9e3, emissive: 0xe4e6e8, emissiveIntensity: 0.22, roughness: 0.7, metalness: 0.05 }, 'hoard'), 0.0, 0.22),
    // the big yellow graphic panels on the 道玄坂 run of the hoarding (Commons photos 2025-06 / 2026-03)
    hoardYellow: S.nightMaterial(mk({ color: 0xf3cb14, emissive: 0xf0c20e, emissiveIntensity: 0.2, roughness: 0.6, metalness: 0.02 }, 'hoardY'), 0.0, 0.2),
    // (pass 16) the ケヤキ: grey-brown bark; the canopy borrows props.js's foliage cut-out (assigned on the first update,
    // hidden until then) with a gentle sway and the street lamps' warm spill on its underside at night
    bark: mk({ color: 0x6e675f, roughness: 0.93, metalness: 0 }, 'bark'),
    leaf: treeLeafMaterial(),
    leafCast: (() => { const m = new THREE.MeshBasicMaterial({ alphaTest: 0.4, side: THREE.DoubleSide, colorWrite: false, depthWrite: false, name: 'dg_leafcast' }); m.visible = false; return m; })(),
  };
  MM.netBlue = MM.net;
  return MM;
}
// canopy shader hooks: uTime drives the sway, uGlow (lamp colour × night) lights the lower crown
const TREE_U = { uTime: { value: 0 }, uGlow: { value: new THREE.Color(0, 0, 0) } };
function treeLeafMaterial() {
  const m = new THREE.MeshStandardMaterial({ alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.88, metalness: 0, color: 0xe2ebd4, name: 'dg_leaf' });
  m.visible = false; m.userData.noShadow = true;
  m.customProgramCacheKey = () => 'dg_leaf_v2';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = TREE_U.uTime; sh.uniforms.uGlow = TREE_U.uGlow;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vDgLow;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float dgK = clamp((position.y - 2.5) / 12.0, 0.0, 1.0); dgK *= dgK;
        float dgPh = 0.0;
        #ifdef USE_INSTANCING
          dgPh = instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;
        #endif
        transformed.x += (sin(uTime * 1.05 + dgPh) * 0.16 + sin(uTime * 2.9 + position.y * 1.3 + dgPh * 3.0) * 0.035) * dgK;
        transformed.z += cos(uTime * 0.83 + dgPh * 1.7) * 0.11 * dgK;
        vDgLow = 1.0 - smoothstep(4.5, 12.0, position.y);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGlow;\nvarying float vDgLow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_MAP\n totalEmissiveRadiance += uGlow * vDgLow * sampledDiffuseColor.rgb;\n#endif');
  };
  return m;
}
/** A ケヤキ (vase form): trunk + limbs (bark), crossed-card leaf clumps on the vase envelope, a 2-card shadow stand-in. */
function zelkovaGeo(h, spread, seed) {
  const R = (i) => { const v = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453; return v - Math.floor(v); };
  const cyl = (r0, r1, len, seg) => new THREE.CylinderGeometry(r1, r0, len, seg, 1, true).translate(0, len / 2, 0);
  const trunkH = 3.1, bark = [cyl(0.25, 0.2, trunkH + 0.5, 8)];
  const limbs = 6;
  for (let k = 0; k < limbs; k++) {
    const a = k / limbs * TAU + R(k) * 0.7, lean = 0.4 + R(k + 9) * 0.2, len = h * 0.5 + R(k + 3) * 1.4, y0 = trunkH - 0.35 + R(k + 5) * 0.6;
    const g = cyl(0.13, 0.05, len, 6); g.rotateZ(lean); g.rotateY(a); g.translate(0, y0, 0); bark.push(g);
    // a fork halfway out, turned further out
    const mx = -Math.sin(lean) * len * 0.5, my = Math.cos(lean) * len * 0.5, ca = Math.cos(a), sa = Math.sin(a);
    const f = cyl(0.07, 0.03, len * 0.55, 5); f.rotateZ(lean + 0.38); f.rotateY(a + 0.45); f.translate(mx * ca, y0 + my, -mx * sa); bark.push(f);
  }
  const leaf = [];
  const clump = (cx, cy, cz, r, k) => {
    for (let j = 0; j < 3; j++) {
      const p = new THREE.PlaneGeometry(r * 2, r * 2);
      p.rotateX((R(k * 3 + j) - 0.5) * 0.5); p.rotateY(j * Math.PI / 3 + R(k * 7 + j) * 0.6);
      if (R(k * 11 + j) > 0.5) { const uv = p.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); }
      p.translate(cx, cy, cz); leaf.push(p);
    }
  };
  // rings on the vase envelope: [height fraction, radius fraction, clumps, clump size fraction]
  let k = 0;
  for (const [fy, fr, n, fs] of [[0.5, 0.72, 5, 0.46], [0.68, 0.95, 7, 0.5], [0.84, 0.66, 5, 0.46], [0.95, 0.18, 1, 0.52]]) {
    for (let i = 0; i < n; i++, k++) {
      const a = i / n * TAU + fy * 3 + R(k) * 0.5, rr = spread * fr * (0.85 + R(k + 1) * 0.3);
      clump(Math.cos(a) * rr, h * fy + (R(k + 2) - 0.5) * 0.8, Math.sin(a) * rr, spread * fs * (0.9 + R(k + 4) * 0.3), k);
    }
  }
  const cast = [new THREE.PlaneGeometry(spread * 1.9, spread * 1.5).translate(0, h * 0.72, 0), new THREE.PlaneGeometry(spread * 1.9, spread * 1.5).rotateY(Math.PI / 2).translate(0, h * 0.72, 0)];
  const merge = (list) => { for (const g of list) { for (const n of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(n)) g.deleteAttribute(n); } return mergeGeometries(list.map((g) => g.index ? g.toNonIndexed() : g), false); };
  return { bark: merge(bark), leaf: merge(leaf), cast: merge(cast) };
}
/** The part of a polygon on the `keep` side (+1: dot ≥ 0) of the line through (px, pz) with normal (nx, nz). */
function clipHalf(P, px, pz, nx, nz, keep = 1) {
  const out = [], sd = (q) => ((q[0] - px) * nx + (q[1] - pz) * nz) * keep;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], da = sd(a), db = sd(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
/** Square-section member from p to q (world Vector3s), t thick. */
function beamGeo(p, q, t) {
  const d = new THREE.Vector3().subVectors(q, p), len = d.length();
  const g = new THREE.BoxGeometry(t, len, t); g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate(p.x, p.y, p.z);
  return g;
}
const UNIT_CYL = (() => { const g = new THREE.CylinderGeometry(1, 1, 1, 8); g.translate(0, 0.5, 0); return g; })();

// ------------------------------------------------------------------------------------------------ build
export function buildDogenzaka(ctx) {
  const t0 = performance.now();
  const { batch, inst, group, world, CITY } = ctx;
  const yAt = ctx.yAt, field = ctx.field;
  const M = mats(), At = getAtlases();
  const out = { colliders: [], facades: [], plan: [], anchors: {}, stats: { buildings: 0, works: 0, signs: 0 } };
  const col = (c, tag = 'building') => out.colliders.push([c, tag]);
  const rng = ctx.rng;
  const FPS = corridorFootprints();
  const others = (f) => FPS.filter((g) => g !== f);
  const roadPaths = CITY.roads.filter((r) => r.id === 'dogenzaka' || r.id === 'dogenzaka_ue');
  const mainDist = (x, z) => { let d = Infinity; for (const r of roadPaths) { const q = DG.nearestOn(r.path, x, z); if (q.d < d) d = q.d; } return d; };
  const fill = (list, k) => list[Math.floor(k * list.length) % list.length];

  // ---- the buildings -----------------------------------------------------------------------------------------
  const koban = CITY.corridor.koban, kobanFP = FPS.find((f) => L.pointInPoly(koban.pos[0], koban.pos[1], L.offsetPolygon(f.poly, 1.2)) && Math.abs(L.polyArea(f.poly)) < 60);
  for (let bi = 0; bi < FPS.length; bi++) {
    const f = FPS[bi];
    if (f === kobanFP) continue;                                             // the koban's own box (below)
    // (pass 16) the Gusto corner: the lot's 道玄坂 end is the 2-storey Gusto / セブンイレブ block (built by hand below),
    // the generic builder raises only the 9F block behind it (and without the corner's tenants)
    let poly = f.poly, T = f.T, gusto = null;
    if (f.sid === DG.GUSTO_CORNER.sid) {
      gusto = gustoSplit(f, CITY);
      if (gusto) { poly = gusto.tower; T = null; }
    }
    if(['9593','9585','9454'].includes(f.sid)){
      const lv=siteLevels(poly,yAt);batch.lift=inst.lift=lv.lo;
      const r=buildKojiBuilding(f,ctx,lv.lo);batch.lift=inst.lift=0;
      liftOut(r,ctx.billboards,ctx.billboards.length,lv.lo);
      for(const shape of r.colliders)col(shape);
      out.plan.push({id:f.id,poly,h:r.height,base:lv.lo,style:'landmark',storeys:f.storeys,corridor:true});out.stats.buildings++;continue;
    }
    const n = poly.length, LOOK = DG.LOOK[f.sid] || null;
    const up = f.s > 300 || f.side === 'R' && f.s > 150;                   // the upper street (offices / clinics)
    const kind = T ? T.style : gusto ? 'office' :/ホテル/.test(f.name || '') || f.use === 'love_hotel' ? 'hotel' : f.d > 20 ? (f.side === 'L' && f.s > 150 && f.s < 330 ? 'hotel' : 'tenant') : (up ? (f.storeys >= 8 ? 'office' : 'tenant') : (f.storeys >= 6 && hashS(f.sid) < 0.4 ? 'entertainment' : 'tenant'));
    const style = (LOOK && LOOK.style) || STYLE_OF[kind] || 'tenant';
    const front = f.d <= 16 && !gusto;
    // faces: street (a carriageway / side street within reach), blind (a neighbour's party wall), else alley
    let mainI = -1, mainL = 0;
    const faces = [];
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const [nx, nz] = L.edgeNormal(poly, i), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const street = ctx.isStreetSide(mx + nx * 3.5, mz + nz * 3.5);
      const blind = !street && others(f).some((g) => L.pointInPoly(mx + nx * 1.1, mz + nz * 1.1, g.poly));
      faces.push({ kind: street ? 'street' : blind ? 'blind' : 'alley', tenants: [] });
      if (street && len > mainL && mainDist(mx + nx * 6, mz + nz * 6) < mainDist(mx, mz)) { mainL = len; mainI = i; }
    }
    const k0 = hashS(f.sid);
    const gf = T ? T.gf : [fill(up ? DG.FILL_GF.high : DG.FILL_GF.low, k0)];
    const upN = T ? T.up : [fill(up ? DG.FILL_UP.high : DG.FILL_UP.low, k0 * 7), fill(up ? DG.FILL_UP.high : DG.FILL_UP.low, k0 * 13 + 0.3)];
    // the shop bays take the gf names (and the real rows in front of them, tenantsData DOGEN_SHOPS); the face's
    // signage record gets every tenant of the building (its vertical stacks and floor boards), set after the build
    if (mainI >= 0) faces[mainI].tenants = gf.slice();
    faces.forEach((fc, i) => { if (fc.kind === 'street' && i !== mainI) fc.tenants = [fill(up ? DG.FILL_GF.high : DG.FILL_GF.low, k0 * 3 + i * 0.17)]; });
    const lv = siteLevels(poly, yAt);
    const S0 = { tenant: 4.2, office: 3.8, entertainment: 4.4, hotel: 3.8, residential: 3.2 }[style];
    const sh = f.storeys > 1 ? Math.max(2.9, Math.min(4.2, (f.roof - S0) / (f.storeys - 1))) : 3.3;
    const spec = {
      id: f.id, poly, storeys: f.storeys, style, faces, sh, setback: false, seed: bi,
      wall: LOOK && LOOK.wall != null ? LOOK.wall : WALL_OF[kind] != null ? WALL_OF[kind] : [0, 1, 6, 7, 2, 0][Math.floor(k0 * 6)],
      stickers: front && (style === 'tenant' || style === 'entertainment'), noStairs: !front || MOBILE,
      noRoofClutter: MOBILE && !front, colliders: n > 4 || ['9488','9513'].includes(f.sid) ? 'edges' : undefined,
      ...(lv.hi > lv.lo + 0.02 ? { groundRel: (x, z) => yAt(x, z) - lv.lo } : {}),
      ...(kind === 'mall' ? { bigBoard: 1 } : {}),
      ...(!front && MOBILE ? { groundFloor: 'wall' } : {}),
    };
    if(f.sid==='9534'){spec.noStairs=true;for(let i=0;i<faces.length;i++){const [nx]=L.edgeNormal(poly,i);if(nx<-.6)faces[i]={kind:'blind',tenants:[]};}}
    const nb0 = ctx.billboards.length;
    batch.lift = inst.lift = lv.lo;
    const r = buildBuilding(spec, { batch, inst, rng: rng.fork(9100 + bi), pools: ctx.pools, billboards: ctx.billboards, stairOk: ctx.stairOk, CITY });
    dressKojiCentreSide(f,ctx,lv.lo);
    batch.lift = inst.lift = 0;
    liftOut(r, ctx.billboards, nb0, lv.lo);
    if (mainI >= 0) { const rec = r.facades.find((q) => q.id === `${f.id}:f${mainI}`); if (rec) rec.tenants = [...gf, ...upN].map((s) => s.replace(/\s*\d+F$|\s+B\d$/, '')); }
    // signage (signage.js decorates every 'street' face with sign stacks, floor boards and neon): the corridor keeps
    // it where 道玄坂 has it — the main face of the lower street's 雑居ビル — and not on side / back faces or on the
    // upper street's office / hotel / residential blocks (their fronts are plain on the real street; their own name
    // plates are placed here). Every new sign is atlas space: the corridor must not open new atlas pages.
    const plain = up && (kind === 'office' || kind === 'glass' || kind === 'hotel' || kind === 'residential' || f.storeys >= 9);
    for (const rec of r.facades) {
      if (rec.kind === 'shop') continue;
      const isMain = mainI >= 0 && rec.id === `${f.id}:f${mainI}`;
      if (!front || !isMain) { if (rec.kind === 'street') rec.kind = 'alley'; }
      else if (plain) rec.kind = 'landmark';
    }
    for (const c of r.colliders) col(c);
    out.facades.push(...r.facades);
    out.plan.push({ poly, h: r.height, base: lv.lo, id: f.id, style, storeys: f.storeys, corridor: true });
    // the building's own name on its street face (plain 〇〇ビル plates by the entrance; the big ones up top)
    if (mainI >= 0 && f.name && T && front) {
      const a = poly[mainI], b = poly[(mainI + 1) % n], [nx, nz] = L.edgeNormal(poly, mainI), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
      if (kind === 'cinema') {
        // 渋東シネタワー (pass 16: no red blade — the 2025 photos show none): the black TOHO podium is dressLook's
        S.signQuad(batch, (a[0] + b[0]) / 2 + nx * 0.45, lv.lo + 3.55, (a[1] + b[1]) / 2 + nz * 0.45, nx, nz, { text: '渋東シネタワー', sub: 'SHIBUTO CINE TOWER', w: Math.min(len - 6, 5), h: 0.6, bg: '#101012', fg: '#e8e2d0', emissive: 0.7, weight: '700' });
        out.stats.signs++;
      } else if (kind === 'mall') {
        // THE PRIME: its name is a small plate over the entrance (the front is the tiles and the UNIQRO boxes)
        S.signQuad(batch, a[0] + tx * (len - 3.5) + nx * 0.35, lv.lo + 3.7, a[1] + tz * (len - 3.5) + nz * 0.35, nx, nz, { text: f.T.name, sub: 'SHIBUYA DOGENZAKA', w: 3.6, h: 0.7, bg: '#101012', fg: '#ffffff', emissive: 0.8, weight: '800' });
        out.stats.signs++;
      } else if (kind === 'glass' || kind === 'office' || f.storeys >= 7 || plain) {
        S.signQuad(batch, (a[0] + b[0]) / 2 + nx * 0.2, lv.lo + r.height - 1.6, (a[1] + b[1]) / 2 + nz * 0.2, nx, nz, { text: T.name, w: Math.min(len - 2, 1 + [...T.name].length * 0.9), h: 1.2, bg: '#1a1c20', fg: '#f2f2ee', emissive: 0.7, weight: '700' });
        out.stats.signs++;
      }
    }
    if (LOOK && mainI >= 0) dressLook(ctx, M, out, LOOK, poly, faces, mainI, lv.lo, r.height, spec.sh, f.storeys, S0);
    if (gusto) gustoCorner(ctx, M, out, col, gusto, f);
    out.stats.buildings++;
  }

  // ---- 渋谷ソラスタ: the glass office tower behind the up-hill right frontage at the top (curtain wall, lit lobby)
  for (const T of DG.TOWERS) {
    const b = DG.BACKDROP.find((q) => q.id === T.id); if (!b) continue;
    const poly = L.ensureCW(b.poly.map((p) => [p[0], p[1]])), lv = siteLevels(poly, yAt), n = poly.length;
    const faces = poly.map((a, i) => { const q = poly[(i + 1) % n], [nx, nz] = L.edgeNormal(poly, i), mx = (a[0] + q[0]) / 2, mz = (a[1] + q[1]) / 2; return { kind: ctx.isStreetSide(mx + nx * 3.5, mz + nz * 3.5) ? 'street' : 'alley', tenants: T.tenants }; });
    const nb0 = ctx.billboards.length;
    batch.lift = inst.lift = lv.lo;
    const r = buildBuilding({ id: 'dg_' + T.id.replace('13113-bldg-', ''), poly, storeys: T.storeys, style: 'office', faces, gf: T.gf, sh: (T.height - 2 - T.gf) / (T.storeys - 1), setback: false, wall: 5, groundFloor: 'glass', noStairs: true, colliders: 'edges', seed: 77, ...(lv.hi > lv.lo + 0.02 ? { groundRel: (x, z) => yAt(x, z) - lv.lo } : {}) }, { batch, inst, rng: rng.fork(9700), pools: ctx.pools, billboards: ctx.billboards, stairOk: ctx.stairOk, CITY });
    batch.lift = inst.lift = 0;
    liftOut(r, ctx.billboards, nb0, lv.lo);
    for (const c of r.colliders) col(c);
    out.facades.push(...r.facades.map((f) => ({ ...f, kind: f.kind === 'shop' ? 'shop' : 'landmark' })));
    out.plan.push({ poly, h: r.height, base: lv.lo, id: 'dg_' + T.id, style: 'office', storeys: T.storeys, corridor: true });
    // its name on the crown, facing up 道玄坂
    const c = L.polyCentroid(poly), q = DG.nearestOn(CITY.roads.find((rr) => rr.id === 'dogenzaka_ue').path, c[0], c[1]), dx = q.x - c[0], dz = q.z - c[1], dl = Math.hypot(dx, dz) || 1;
    let best = 0, bi = 0; for (let i = 0; i < n; i++) { const [nx, nz] = L.edgeNormal(poly, i), d = nx * dx / dl + nz * dz / dl; if (d > best) { best = d; bi = i; } }
    const a = poly[bi], e2 = poly[(bi + 1) % n], [nx, nz] = L.edgeNormal(poly, bi);
    S.signQuad(batch, (a[0] + e2[0]) / 2 + nx * 0.3, lv.lo + r.height - 3, (a[1] + e2[1]) / 2 + nz * 0.3, nx, nz, { text: 'SHIBUYA SOLASTA', w: Math.min(14, Math.hypot(e2[0] - a[0], e2[1] - a[1]) - 2), h: 1.6, bg: '#0c1016', fg: '#e8eef6', emissive: 0.9, weight: '700' });
    out.stats.signs++; out.stats.buildings++;
  }

  // ---- 道玄坂上交番 ---------------------------------------------------------------------------------------------
  {
    const kp = kobanFP ? L.polyCentroid(kobanFP.poly) : koban.pos;
    const q = DG.nearestOn(CITY.roads.find((r) => r.id === 'dogenzaka_ue').path, kp[0], kp[1]);
    const fx = q.x - kp[0], fz = q.z - kp[1], fl = Math.hypot(fx, fz) || 1;
    const rotY = Math.atan2(-fz / fl, fx / fl);                               // front faces the street
    const g = yAt(kp[0], kp[1]);
    batch.lift = inst.lift = g;
    const cols = buildKoban({ batch, inst, group }, kp[0], kp[1], rotY, { w: koban.w, d: koban.d, storeys: koban.storeys, name: koban.name });
    batch.lift = inst.lift = 0;
    for (const c of cols) { c.obb.center.y += g; col(c, 'koban'); }
    // the station-name plate 「道玄坂上交番」 on the street side, a notice board and the duty bicycles
    const tx = -fz / fl, tz = fx / fl;
    S.signQuad(batch, kp[0] + fx / fl * (koban.d / 2 + 0.05) + tx * (koban.w / 2 - 0.9), g + 2.2, kp[1] + fz / fl * (koban.d / 2 + 0.05) + tz * (koban.w / 2 - 0.9), fx / fl, fz / fl, { text: '道玄坂上交番', w: 0.5, h: 2.0, bg: '#f4f4f0', fg: '#1a1a1a', vertical: true, emissive: 0.45, weight: '800' });
    S.signQuad(batch, kp[0] + tx * (koban.w / 2 + 0.06), g + 1.5, kp[1] + tz * (koban.w / 2 + 0.06), tx, tz, { text: '警視庁 渋谷警察署', sub: '事件・事故は110番', w: 1.6, h: 1.0, bg: '#1d3f8a', fg: '#ffffff', emissive: 0.5, weight: '800' });
    for (const k of [0, 1]) { const bx = kp[0] - tx * (koban.w / 2 + 0.9) + fx / fl * (0.8 - k * 1.1), bz = kp[1] - tz * (koban.w / 2 + 0.9) + fz / fl * (0.8 - k * 1.1); bike(inst, M, bx, g + SW_H, bz, Math.atan2(fx, fz) + Math.PI / 2, 0xe8e8e8); }
    out.plan.push({ poly: L.rectPoly(kp[0], kp[1], koban.w, koban.d, L.rotYOf(tx, tz)), h: 6.2, base: g, id: 'dg_koban', style: 'koban', storeys: 2, corridor: true });
    out.koban = { pos: kp, rotY, y: g };
  }

  // ---- the 道玄坂二丁目南地区 yard ----------------------------------------------------------------------------------
  works(ctx, M, out, col);
  // ---- マークシティ's true west end behind the yard: the landmark's own podium look (panel walls, ledges, parapet),
  // its materials so it merges into the landmark's draw calls; out of reach (beyond the corridor outline), no colliders
  if (DG.MARKCITY_WING) {
    const { batch } = ctx, wp = L.ensureCW(DG.MARKCITY_WING.poly), top = DG.MARKCITY_WING.top;
    // Keep an actual opening through the west facade for the 4F concourse
    // and the higher vehicle ramp, instead of drawing a solid wall over both.
    const entry=clipHalf(wp,-276,0,-1,0),rear=clipHalf(wp,-276,0,1,0);
    S.prism(batch,M.panelGrey,rear,-.5,top,{uvScale:3.5/4.25});
    S.prism(batch,M.panelGrey,entry,-.5,15.2,{uvScale:3.5/4.25});
    S.prism(batch,M.panelGrey,entry,24,top,{uvScale:3.5/4.25});
    S.rings(batch, M.whiteMetal, wp, 25, top - 0.5, 4.25, { out: 0.35, h: 0.35 });
    for(const z of [179,191,204])batch.add(M.whiteMetal,L.boxAt(-299,19.6,z,.7,8.8,.7,0,false),-299,z);
    S.signQuad(batch,-302,23,191,-1,0,{text:'SHIBUYA MARK CITY',w:19,h:1.2,bg:'#e1e4e2',fg:'#235b54',emissive:.55,weight:'700'});
    S.signQuad(batch,-304,20.6,196,-1,0,{text:'5F バス・駐車場',w:7,h:.8,bg:'#174b55',fg:'#ffffff',emissive:.7});
    S.signQuad(batch,-304,18.4,186,-1,0,{text:'4F アベニュー入口',w:6,h:.8,bg:'#174b55',fg:'#ffffff',emissive:.7});
    const accessAsphalt=L.std({color:0x34383b,roughness:.95});
    // Render the raised vehicle and pedestrian decks independently of terrain.
    for(let x=-340;x< -278;x+=1){
      const t=(x+340)/62,t1=(x+341)/62,z=196-t,z1=196-t1;
      const y=Math.max(ctx.yAt(x,z),15.377+3.6*t)+.025,y1=Math.max(ctx.yAt(x+1,z1),15.377+3.6*t1)+.025;
      batch.add(accessAsphalt,L.quad([x,y,z-3.5],[x,y,z+3.5],[x+1,y1,z1+3.5],[x+1,y1,z1-3.5],[0,1,0]),x,z);
      if(x%5===0)batch.add(M.whiteMetal,L.boxAt(x,y+.03,z,2,.03,.1,0,false),x,z);
    }
    batch.add(M.whiteMetal,L.boxAt(-303,16.16,187,50,.08,3,0,false),-303,187);
    const blue=L.std({color:0x326b92,metalness:.55,roughness:.35});
    batch.add(blue,L.boxAt(-310,20.2,187,42,.16,3.8,0,false),-310,187);
    // Slender blue portal frames above the pedestrian approach, as in the west entrance reference.
    for(let x=-330;x<=-290;x+=5){
      for(const z of [185.3,188.7])batch.add(M.silver,L.boxAt(x,18.2,z,.13,4,.13,0,false),x,z);
      batch.add(blue,L.boxAt(x,20.2,187,.25,.18,3.8,0,false),x,187);
    }
    S.parapet(batch, M.whiteMetal, wp, top, { h: 1.2, t: 0.4 });
    out.plan.push({ poly: wp, h: top, base: 0, id: 'dg_markcity_wing', style: 'landmark', storeys: 6, corridor: true });
  }

  // ---- 玉川通り at 道玄坂上: the 首都高3号 viaducts, the 渋谷出口 ramp, the underpass between the side roads -------
  expressway(ctx, M, out, col);

  // ---- street furniture ---------------------------------------------------------------------------------------
  furniture(ctx, M, out, col);
  out.signals = signals(ctx, M, out, col);

  // (pass 16) the canopy: props.js's foliage cut-out once it exists, the sway clock, the night tint + lamp spill
  const TC = { ready: false, night: -1, day: new THREE.Color(0xe2ebd4), dark: new THREE.Color(0x353d31), lamp: new THREE.Color(1.0, 0.84, 0.58) };
  const canopy = (engine) => {
    if (!TC.ready) {
      const pm = engine.get('props'), map = pm && pm.M && pm.M.leaf && pm.M.leaf.map;
      if (map) { for (const m of [M.leaf, M.leafCast]) { m.map = map; m.visible = true; m.needsUpdate = true; } TC.ready = true; }
    }
    TREE_U.uTime.value = typeof engine.elapsed === 'number' ? engine.elapsed : performance.now() / 1000;
    const lg = engine.get('lighting'), night = lg && typeof lg.nightFactor === 'number' ? lg.nightFactor : 1;
    if (Math.abs(night - TC.night) > 0.01) {
      TC.night = night;
      M.leaf.color.lerpColors(TC.day, TC.dark, night).multiplyScalar(1 - 0.4 * night);
      TREE_U.uGlow.value.copy(TC.lamp).multiplyScalar(0.12 + 0.7 * night);   // day: a little skylight fill under the crown
    }
  };
  out.update = (engine) => {
    canopy(engine);
    const S2 = out.signals; if (!S2 || !S2.lamps.length) return;
    const tr = engine.get('traffic');
    if (!tr) return;
    let dirty = false;
    for (const g of S2.heads) {
      let st;
      if (g.xing) { const c = tr.crossingSignal && tr.crossingSignal(g.xing); st = c ? (g.ped ? c.pedestrian : c.vehicle) : null; }
      else if (g.jid) { const v = tr.junctionState ? tr.junctionState(g.jid, g.group) : 'red'; st = g.ped ? (v === 'green' ? 'walk' : v === 'amber' ? 'flash' : 'stop') : v; }
      if (!st) st = g.ped ? 'stop' : 'red';
      const flashOn = (performance.now() % 700) < 380;
      const key = st + (st === 'flash' ? (flashOn ? 1 : 0) : '');
      if (key === g.key) continue;
      g.key = key; dirty = true;
      for (const L2 of g.lamps) {
        const on = g.ped ? (L2.c === 'green' ? (st === 'walk' || (st === 'flash' && flashOn)) : st === 'stop') : L2.c === (st === 'green' ? 'green' : st === 'amber' ? 'amber' : 'red');
        const lp = S2.lamps[L2.i];
        S2.mesh.setColorAt(L2.i, on ? lp.col : lp.off);
      }
    }
    if (dirty) S2.mesh.instanceColor.needsUpdate = true;
  };
  out.stats.ms = Math.round(performance.now() - t0);
  return out;
}

// ------------------------------------------------------------------------------------------------ small parts
function bike(inst, M, x, y, z, ry, color = 0x2a2c30) {
  // a parked city bicycle (ママチャリ): two wheels, frame, basket, saddle — 6 instanced boxes / discs
  const c = Math.cos(ry), s = Math.sin(ry), at = (u) => [x + c * u, z - s * u];
  for (const u of [-0.55, 0.55]) { const [px, pz] = at(u); S.ibox(inst, 'dg_wheel', M.darkMetal, px, y + 0.33, pz, 0.66, 0.66, 0.05, ry); }
  const [fx, fz] = at(0); S.ibox(inst, 'dg_frame', M.silver, fx, y + 0.55, fz, 1.0, 0.06, 0.06, ry, color);
  const [sx, sz] = at(-0.2); S.ibox(inst, 'dg_frame', M.darkMetal, sx, y + 0.85, sz, 0.26, 0.06, 0.12, ry);
  const [bx, bz] = at(0.62); S.ibox(inst, 'dg_frame', M.silver, bx, y + 0.9, bz, 0.34, 0.24, 0.3, ry);
}
/** A run of white pedestrian guard fence (posts + two rails) from a to b at pavement level. */
function fence(batch, M, yAt, a, b, out, col) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1) return;
  const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len, rot = L.rotYOf(tx, tz), n = Math.max(1, Math.round(len / 2));
  for (let k = 0; k <= n; k++) { const x = a[0] + tx * len * k / n, z = a[1] + tz * len * k / n, y = yAt(x, z) + SW_H; batch.add(M.whiteMetal, L.boxAt(x, y + 0.45, z, 0.06, 0.9, 0.06, rot, false), x, z); }
  for (const hy of [0.85, 0.45]) { const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, y = (yAt(a[0], a[1]) + yAt(b[0], b[1])) / 2 + SW_H; batch.add(M.whiteMetal, L.boxAt(mx, y + hy, mz, len, 0.05, 0.05, rot, false), mx, mz); }
  const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
  col(S.boxCollider(mx, mz, len, 0.95, 0.12, rot, yAt(mx, mz) + SW_H), 'rail');
}

// ------------------------------------------------------------------------------------------------ the yard
function works(ctx, M, out, col) {
  const { batch, inst, yAt, field } = ctx;
  const W = DG.WORKS, H = W.hoarding;
  const site = W.site, notch = W.notch;
  // the yard floor (dirt / plates) over the pavement inside the hoarding: the site and the notch
  for (const poly of [site, notch]) {
    const c = L.polyCentroid(poly), y = siteLevels(poly, yAt).lo;
    batch.add(M.dirt, L.polygonCap(L.offsetPolygon(L.ensureCW(poly), -0.3), y + SW_H + 0.05, 0.25), c[0], c[1]);
  }
  // hoarding along every edge that faces a street or the open yard (not the backs against マークシティ West)
  const hoard = (a, b, print, cen) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1.5) return;
    const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len, rot = L.rotYOf(tx, tz);
    // (nx, nz) points INTO the yard (away from the street side the print faces)
    let nx = tz, nz = -tx; if ((cen[0] - (a[0] + b[0]) / 2) * nx + (cen[1] - (a[1] + b[1]) / 2) * nz < 0) { nx = -nx; nz = -nz; }
    const segs = Math.ceil(len / 6);
    for (let k = 0; k < segs; k++) {
      const u0 = len * k / segs, u1 = len * (k + 1) / segs, mx = a[0] + tx * (u0 + u1) / 2, mz = a[1] + tz * (u0 + u1) / 2, y0 = Math.min(yAt(a[0] + tx * u0, a[1] + tz * u0), yAt(a[0] + tx * u1, a[1] + tz * u1)) + SW_H;
      batch.add(M.hoard, L.boxAt(mx, y0 + H / 2 - 0.05, mz, u1 - u0 + 0.02, H + 0.1, 0.1, rot, true), mx, mz);
      batch.add(M.glowOrange, L.boxAt(mx, y0 + H + 0.08, mz, 0.18, 0.1, 0.18, rot, false), mx, mz);   // the LED warning lamps along the top rail
      col(S.boxCollider(mx, mz, u1 - u0 + 0.02, H, 0.3, rot, y0), 'works');
    }
    // the green site band along the foot and the top, the posts every 2 m on the inside
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, y = yAt(mx, mz) + SW_H;
    batch.add(M.glowGreen, L.boxAt(mx - nx * 0.06, y + H - 0.25, mz - nz * 0.06, len, 0.18, 0.02, rot, false), mx, mz);
    batch.add(M.jrGreen, L.boxAt(mx - nx * 0.06, y + 0.15, mz - nz * 0.06, len, 0.3, 0.02, rot, false), mx, mz);
    if (print && len > 30) {                                               // a safety board or two along the long runs
      const q0 = S.signQuad(batch, mx - nx * 0.08 + tx * (len * 0.3), y + 1.7, mz - nz * 0.08 + tz * (len * 0.3), -nx, -nz, { text: '安全第一', sub: '無災害記録更新中', w: 1.4, h: 1.4, bg: '#1d8f3e', fg: '#ffffff', emissive: 0.5, weight: '900' });
      if (q0) out.stats.signs++;
    }
    if (print && len > 10) {
      const pw = Math.min(len - 2, 14);
      S.signQuad(batch, mx - nx * 0.08, y + 1.9, mz - nz * 0.08, -nx, -nz, { text: print[0], sub: print[1], w: pw, h: 1.6, bg: '#f7f7f3', fg: '#1d5a3a', emissive: 0.35, weight: '800' });
      out.stats.signs++;
      // yellow graphic panels either side of the print, every ~15 m (one lettered 'Love each other?' per run)
      let lettered = false;
      for (const dir of [1, -1]) {
        for (let u = pw / 2 + 5; u + 3.5 < len / 2 - 1; u += 15) {
          const cx = mx + tx * u * dir - nx * 0.07, cz = mz + tz * u * dir - nz * 0.07, yy = Math.min(yAt(cx - tx * 3.5, cz - tz * 3.5), yAt(cx + tx * 3.5, cz + tz * 3.5)) + SW_H;
          batch.add(M.hoardYellow, L.boxAt(cx, yy + 0.4 + (H - 0.9) / 2, cz, 7, H - 0.9, 0.03, rot, false), cx, cz);
          if (!lettered && S.signQuad(batch, cx - nx * 0.03, yy + H * 0.62, cz - nz * 0.03, -nx, -nz, { text: 'Love each other?', w: 5.4, h: 0.9, bg: '#f3cb14', fg: '#1a1a1a', emissive: 0.3, weight: '800' })) { lettered = true; out.stats.signs++; }
        }
      }
    }
  };
  const P = L.ensureCW(site), NP = L.ensureCW(notch);
  const streetEdge = (a, b) => field.sample((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) < 14;
  // (edges of the site polygon that ARE the notch boundary get the APA site's own hoarding instead)
  const onNotch = (a, b) => NP.some((q) => Math.hypot(q[0] - a[0], q[1] - a[1]) < 0.5) && NP.some((q) => Math.hypot(q[0] - b[0], q[1] - b[1]) < 0.5);
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    if (onNotch(a, b)) continue;
    hoard(a, b, streetEdge(a, b) ? ['道玄坂二丁目南地区第一種市街地再開発事業', '新築工事  2027年2月 竣工予定   施工 戸田建説'] : null, L.polyCentroid(P));
  }
  for (let i = 0; i < NP.length; i++) { const a = NP[i], b = NP[(i + 1) % NP.length]; hoard(a, b, streetEdge(a, b) ? ['（仮称）アバホテル〈渋谷駅前〉新築工事', '地上15階  ご迷惑をおかけします'] : null, L.polyCentroid(NP)); }
  // the notice boards at the office tower's gate: 建築計画のお知らせ and the 完成予想 panel
  {
    const a = P.find((q) => Math.hypot(q[0] + 250.4, q[1] - 64) < 1) || P[0];
    const q = DG.nearestOn(ctx.CITY.roads.find((r) => r.id === 'dogenzaka').path, a[0], a[1]);
    const nx = -(q.x - a[0]), nz = -(q.z - a[1]), l = Math.hypot(nx, nz) || 1;
    const along = DG.nearestOn(P, a[0], a[1]);
    const g = yAt(a[0], a[1]) + SW_H;
    const bx = a[0] - along.tx * 8 - nx / l * 0.12, bz = a[1] - along.tz * 8 - nz / l * 0.12;
    S.signQuad(batch, bx, g + 1.55, bz, -nx / l, -nz / l, { text: '建築計画のお知らせ', sub: '用途 事務所・ホテル・店舗  地上30階 地下3階  高さ152.56m', w: 1.8, h: 1.25, bg: '#ffffff', fg: '#1a1a1a', emissive: 0.3, weight: '700' });
    S.signQuad(batch, bx - along.tx * 6, g + 2.0, bz - along.tz * 6, -nx / l, -nz / l, { text: 'SHIBUYA DOGENZAKA 2-CHOME', sub: '渋谷と道玄坂を、つなぐ。 2027 SPRING', w: 5.2, h: 2.2, bg: '#0e2a3c', bg2: '#3a6a8a', fg: '#ffffff', emissive: 0.9, weight: '800' });
    out.stats.signs += 2;
  }
  // the three buildings going up
  const tower = (spec, floorH, gfH, craneN, seed) => {
    const poly = L.ensureCW(spec.poly), c = L.polyCentroid(poly), y0 = siteLevels(poly, yAt).lo + SW_H;
    const nF = spec.steelTo, topSteel = gfH + (nF - 1) * floorH, clad = gfH + (spec.cladTo - 1) * floorH;
    // curtain wall on the clad floors (office: glass; hotels: panels), the core above it, the bare frame and its
    // floor edges on the rest, the construction net on the two floors under the working deck
    S.prism(batch, spec.floors >= 20 ? M.glassTower2 : M.panelWhite, poly, y0, y0 + clad, { cap: false });
    // the hotels are still wrapped in scaffold sheeting over their cladding (grey 養生シート, Commons 2026-03-13_038)
    if (spec.floors < 20) S.prism(batch, M.net, L.offsetPolygon(poly, 1.2), y0 + H + 0.3, y0 + clad + floorH, { cap: false });
    const inner = L.offsetPolygon(poly, -0.6);
    const core = L.offsetPolygon(poly, -Math.min(9, Math.sqrt(Math.abs(L.polyArea(poly))) * 0.3));
    S.prism(batch, M.concrete, core, y0 + clad, y0 + topSteel + floorH * 1.5, { cap: true, capMat: M.concrete });
    for (let fl = spec.cladTo; fl <= nF; fl++) {
      const y = y0 + gfH + (fl - 1) * floorH;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]), rot = L.rotYOf(b[0] - a[0], b[1] - a[1]);
        batch.add(M.steel, L.boxAt((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2, len, 0.6, 0.35, rot, false), c[0], c[1]);       // edge girder
      }
      batch.add(M.deckDark, L.polygonCap(inner, y + 0.05, 0.25), c[0], c[1]);                                              // deck plate
      if (fl >= nF - 2 && fl < nF) S.prism(batch, spec.floors >= 20 ? M.netBlue : M.net, L.offsetPolygon(poly, 0.9), y - floorH + 0.3, y + 1.0, { cap: false });
      if ((fl + seed) % 3 === 0) for (let i = 0; i < poly.length; i++) { const a = poly[i]; batch.add(M.glowWhite, L.boxAt(a[0] + (c[0] - a[0]) * 0.1, y + 1.6, a[1] + (c[1] - a[1]) * 0.1, 0.5, 0.12, 0.5, 0, false), c[0], c[1]); }   // work lights
    }
    // columns at every vertex and every ~8 m between, from the clad top to the steel top
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.round(len / 8));
      for (let j = 0; j < k; j++) { const x = a[0] + (b[0] - a[0]) * j / k, z = a[1] + (b[1] - a[1]) * j / k; batch.add(M.steel, L.boxAt(x, y0 + (clad + topSteel) / 2, z, 0.55, topSteel - clad, 0.55, 0, false), c[0], c[1]); }
    }
    // construction hoist up one face, tower cranes on the core
    { const a = poly[0], b = poly[1], [nx, nz] = L.edgeNormal(poly, 0), mx = (a[0] + b[0]) / 2 + nx * 1.6, mz = (a[1] + b[1]) / 2 + nz * 1.6; batch.add(M.crane, L.boxAt(mx, y0 + topSteel / 2, mz, 1.6, topSteel, 1.6, L.rotYOf(b[0] - a[0], b[1] - a[1]), false), c[0], c[1]); }
    for (let k = 0; k < craneN; k++) {
      const ang = seed * 1.3 + k * 2.4, cx = c[0] + Math.cos(ang) * 4, cz = c[1] + Math.sin(ang) * 4, base = y0 + topSteel + floorH * 1.5, mast = 16;
      batch.add(M.crane, L.boxAt(cx, base + mast / 2, cz, 1.8, mast, 1.8, 0, false), cx, cz);
      batch.add(M.craneWhite, L.boxAt(cx, base + mast + 1.2, cz, 2.6, 2.4, 2.6, 0, false), cx, cz);                        // slewing unit + cab
      const jr = ang + 0.9, jl = 36, jx = Math.cos(jr), jz = Math.sin(jr), lift = 0.55;                                      // luffing jib raised ~30°
      const j0 = new THREE.Vector3(cx, base + mast + 2.4, cz), j1 = new THREE.Vector3(cx + jx * jl * Math.cos(lift), base + mast + 2.4 + jl * Math.sin(lift), cz + jz * jl * Math.cos(lift));
      batch.add(M.crane, beamGeo(j0, j1, 1.1), cx, cz);
      batch.add(M.steelGrey, beamGeo(new THREE.Vector3(cx, base + mast + 6, cz), j1, 0.12), cx, cz);                      // luffing ropes
      batch.add(M.concrete, L.boxAt(cx - jx * 5, base + mast + 2.2, cz - jz * 5, 7, 1.4, 2.2, L.rotYOf(jx, jz), false), cx, cz);   // counter-jib + ballast
      batch.add(M.glowRed, L.boxAt(cx + jx * jl * Math.cos(lift), base + mast + 2.9 + jl * Math.sin(lift), cz + jz * jl * Math.cos(lift), 0.5, 0.5, 0.5, 0, false), cx, cz);
      batch.add(M.glowRed, L.boxAt(cx, base + mast + 3.0, cz, 0.5, 0.5, 0.5, 0, false), cx, cz);
    }
    out.plan.push({ poly, h: topSteel, base: y0 - SW_H, id: 'dg_works_' + seed, style: 'works', storeys: nF, corridor: true });
    out.stats.works++;
  };
  tower(W.office, 4.4, 6.5, 2, 1);
  tower(W.hotel, 3.6, 5.5, 1, 2);
  tower(W.apa, 2.9, 4.2, 1, 3);
  // floodlights on masts inside the hoarding
  for (const p of [[-262, 84], [-300, 150], [-298, 118]]) { const g = yAt(p[0], p[1]) + SW_H; batch.add(M.steelGrey, L.boxAt(p[0], g + 5, p[1], 0.3, 10, 0.3, 0, false), p[0], p[1]); batch.add(M.glowWhite, L.boxAt(p[0], g + 10.1, p[1], 1.2, 0.5, 0.5, 0.5, false), p[0], p[1]); }
}

// ------------------------------------------------------------------------------------------------ 首都高 / 246
function expressway(ctx, M, out, col) {
  const { batch, yAt } = ctx;
  const X0 = -650, X1 = -300;                                               // the stretch drawn (beyond it: impostor country)
  const deck = (line, w, id) => {
    const pts = line.filter((p) => p[0] >= X0 - 20 && p[0] <= X1 + 20);
    const res = L.resample(pts, 6);
    for (let i = 0; i < res.length - 1; i++) {
      const a = res[i], b = res[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.5) continue;
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, rot = L.rotYOf(b[0] - a[0], b[1] - a[1]), nx = (b[1] - a[1]) / len, nz = -(b[0] - a[0]) / len;
      const g = Math.max(yAt(mx, mz), yAt(mx + nx * 12, mz + nz * 12), yAt(mx - nx * 12, mz - nz * 12));
      const top = g + 14.2;                                                 // road deck ~14 m over 玉川通り
      batch.add(M.deck, L.boxAt(mx, top - 1.1, mz, len + 0.05, 2.2, w, rot, true), mx, mz);                 // box girder
      batch.add(M.deckDark, L.boxAt(mx, top + 0.02, mz, len + 0.05, 0.06, w - 0.6, rot, false), mx, mz);  // asphalt
      for (const s of [1, -1]) {
        batch.add(M.deck, L.boxAt(mx + nx * s * (w / 2 - 0.2), top + 0.55, mz + nz * s * (w / 2 - 0.2), len + 0.05, 1.1, 0.4, rot, false), mx, mz);   // parapet
        batch.add(M.soundWall, L.boxAt(mx + nx * s * (w / 2 - 0.2), top + 2.1, mz + nz * s * (w / 2 - 0.2), len + 0.05, 2.0, 0.08, rot, false), mx, mz);   // transparent sound barrier
        if (i % 2 === 0) batch.add(M.glowWarm, L.boxAt(mx + nx * s * (w / 2 + 0.05), top - 2.3, mz + nz * s * (w / 2 + 0.05), 0.8, 0.12, 0.14, rot, false), mx, mz);   // fascia lamps
      }
      // lamp standards on the deck every other segment
      if (i % 3 === 0) { batch.add(M.silver, L.boxAt(mx + nx * (w / 2 - 0.6), top + 5, mz + nz * (w / 2 - 0.6), 0.2, 10, 0.2, 0, false), mx, mz); batch.add(M.glowWarm, L.boxAt(mx + nx * (w / 2 - 2), top + 9.9, mz + nz * (w / 2 - 2), 0.6, 0.18, 0.35, rot, false), mx, mz); }
    }
    return res;
  };
  const wb = deck(DG.SHUTO.wb, 9.6, 'wb'), eb = deck(DG.SHUTO.eb, 9.6, 'eb');
  // piers: one column per carriageway pair every ~40 m, standing in the median between the side roads (clear of
  // every carriageway), T-caps under both decks
  const all = L.resample(DG.SHUTO.eb.filter((p) => p[0] >= X0 && p[0] <= X1), 40);
  for (const p of all) {
    const q = DG.nearestOn(DG.SHUTO.wb, p[0], p[1]), mx = (p[0] + q.x) / 2, mz = (p[1] + q.z) / 2;
    if (ctx.field.sample(mx, mz) < 1.2) continue;
    const g = yAt(mx, mz), top = Math.max(g, yAt(p[0], p[1])) + 14.2 - 2.2;
    const dx = q.x - p[0], dz = q.z - p[1], l = Math.hypot(dx, dz) || 1;
    batch.add(M.deck, L.boxAt(mx, (g + top) / 2, mz, 3.0, top - g, 2.4, L.rotYOf(dx, dz), true), mx, mz);
    batch.add(M.deck, L.boxAt(mx, top - 0.9, mz, l + 9, 1.8, 2.6, L.rotYOf(dx, dz), true), mx, mz);
    col(S.boxCollider(mx, mz, 3.2, top - g, 2.6, L.rotYOf(dx, dz), g), 'pier');
  }
  // the green 首都高 signs on the fascia over the junction, facing up 道玄坂
  {
    const j = DG.UE_JCT, q = DG.nearestOn(DG.SHUTO.wb, j[0], j[1]), g = yAt(q.x, q.z) + 14.2;
    const dx = j[0] - q.x, dz = j[1] - q.z, l = Math.hypot(dx, dz) || 1;
    S.signQuad(batch, q.x + dx / l * 5.2, g - 1.2, q.z + dz / l * 5.2, dx / l, dz / l, { text: '首都高速 3号渋谷線', sub: 'SHUTO EXPWY  ③  渋谷 SHIBUYA', w: 7.5, h: 1.3, bg: '#1d6b3a', fg: '#ffffff', emissive: 0.9, weight: '800' });
    S.signQuad(batch, q.x + dx / l * 5.3, g - 3.0, q.z + dz / l * 5.3, dx / l, dz / l, { text: '道玄坂上', sub: 'Dogenzaka-ue', w: 3.2, h: 1.0, bg: '#1d4f9a', fg: '#ffffff', emissive: 0.8, weight: '800' });
    out.stats.signs += 2;
  }
  // the 渋谷出口 off-ramp coming down on the west side of the junction (OSM 311740422): a descending deck
  {
    const ex = DG.SHUTO.exit.filter((p) => p[0] <= -470), n = ex.length;
    for (let i = 0; i < n - 1; i++) {
      const a = ex[i], b = ex[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const t = (i + 0.5) / (n - 1), top = yAt(mx, mz) + 14.2 * (1 - t) + 0.2;
      if (top - yAt(mx, mz) < 1.2) continue;
      batch.add(M.deck, L.boxAt(mx, top - 0.8, mz, len + 0.1, 1.6, 7.5, L.rotYOf(b[0] - a[0], b[1] - a[1]), true), mx, mz);
    }
  }
  // the underpass: 玉川通り's main lanes dive between the side roads — a dark trench strip with its parapets
  {
    const u = DG.T246.under.filter((p) => p[0] <= -330 && p[0] >= -480);
    const res = L.resample(u, 4);
    for (let i = 0; i < res.length - 1; i++) {
      const a = res[i], b = res[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, rot = L.rotYOf(b[0] - a[0], b[1] - a[1]);
      const nx = (b[1] - a[1]) / len, nz = -(b[0] - a[0]) / len, g = yAt(mx, mz);
      const depth = Math.min(1, (-330 - mx) / 60);                          // the ramp down: open for the first 60 m
      batch.add(M.void, L.boxAt(mx, g + 0.2, mz, len + 0.05, 0.04, 7.5 * depth + 0.5, rot, false), mx, mz);
      for (const s of [1, -1]) { batch.add(M.concrete, L.boxAt(mx + nx * s * 4.3, g + 0.6, mz + nz * s * 4.3, len + 0.05, 1.1, 0.35, rot, true), mx, mz); batch.add(M.silver, L.boxAt(mx + nx * s * 4.3, g + 1.5, mz + nz * s * 4.3, len + 0.05, 0.06, 0.06, rot, false), mx, mz); }
    }
  }
  // the big blue direction gantry over 道玄坂上, facing up 道玄坂 (玉川通り 国道246: 三軒茶屋 ← → 渋谷駅)
  {
    const r = ctx.CITY.roads.find((q) => q.id === 'dogenzaka_ue'), p = r.path, a = p[p.length - 4], b = p[p.length - 3];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz), nx = -dz / l, nz = dx / l, g = yAt(a[0], a[1]);
    for (const s of [1, -1]) { const px = a[0] + nx * s * 8.4, pz = a[1] + nz * s * 8.4; batch.add(M.steelGrey, L.boxAt(px, g + 3.8, pz, 0.35, 7.6, 0.35, 0, false), px, pz); col(S.boxCollider(px, pz, 0.5, 7.6, 0.5, 0, g), 'pole'); }
    batch.add(M.steelGrey, L.boxAt(a[0], g + 7.4, a[1], 17.2, 0.4, 0.4, L.rotYOf(nx, nz), false), a[0], a[1]);
    S.signQuad(batch, a[0] - dx / l * 0.3, g + 6.2, a[1] - dz / l * 0.3, -dx / l, -dz / l, { text: '← 三軒茶屋  246  渋谷駅 →', sub: 'Sangenjaya  Tamagawa-dori  Shibuya Sta.', w: 8.5, h: 2.1, bg: '#1d4f9a', fg: '#ffffff', emissive: 0.8, weight: '800' });
    out.stats.signs++;
  }
}

// ------------------------------------------------------------------------------------------------ the three spots
// (pass 16) Dressing over the generic facade for the buildings a visitor recognises (dogenzakaData LOOK).
function dressLook(ctx, M, out, K, poly, faces, mainI, y0, H, sh, storeys, gfH) {
  const { batch, CITY } = ctx, n = poly.length;
  const road = CITY.roads.find((r) => r.id === 'dogenzaka').path;
  const edge = (i) => {
    const a = poly[i], b = poly[(i + 1) % n], len = Math.hypot(b[0] - a[0], b[1] - a[1]), [nx, nz] = L.edgeNormal(poly, i);
    return { a, b, len, tx: (b[0] - a[0]) / len, tz: (b[1] - a[1]) / len, nx, nz, mx: (a[0] + b[0]) / 2, mz: (a[1] + b[1]) / 2 };
  };
  const m = edge(mainI);
  // u (m along the main face) of its down-hill (109-side) end
  const downU = DG.nearestOn(road, m.a[0], m.a[1]).s < DG.nearestOn(road, m.b[0], m.b[1]).s ? 0 : m.len;
  const at = (e, u, out0) => [e.a[0] + e.tx * u + e.nx * out0, e.a[1] + e.tz * u + e.nz * out0];
  if (K.tiles) {
    // THE PRIME: the white square tiles with dark joints over every street face above the shop floor (~1.1 m tiles)
    for (let i = 0; i < n; i++) {
      if (faces[i].kind !== 'street') continue;
      const e = edge(i); if (e.len < 3) continue;
      const gf = 4.6, hh = H - gf - 0.3;
      const pl = new THREE.PlaneGeometry(e.len - 0.1, hh), uv = pl.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * e.len / 13.2, uv.getY(k) * hh / 13.2);
      pl.rotateY(Math.atan2(e.nx, e.nz)); pl.translate(e.mx + e.nx * 0.16, y0 + gf + hh / 2, e.mz + e.nz * 0.16);
      batch.add(M.tile, pl, e.mx, e.mz);
      batch.add(M.darkMetal, L.boxAt(e.mx + e.nx * 0.2, y0 + gf - 0.15, e.mz + e.nz * 0.2, e.len, 0.3, 0.12, L.rotYOf(e.tx, e.tz), false), e.mx, e.mz);
    }
  }
  if (K.uniqro) {
    // the red UNIQRO boxes: one high on the down-hill corner, one over the shop entrance
    for (const [u, y] of [[Math.abs(downU - 1.8), H * 0.62], [Math.abs(downU - m.len * 0.42), 6.2]]) {
      const [x, z] = at(m, u, 0.45), rot = L.rotYOf(m.tx, m.tz);
      batch.add(M.redPaint, L.boxAt(x, y0 + y, z, 2.7, 2.7, 0.5, rot, false), x, z);
      for (const [t, dy] of [['UNI', 0.62], ['QRO', -0.62]]) S.signQuad(batch, x + m.nx * 0.27, y0 + y + dy, z + m.nz * 0.27, m.nx, m.nz, { text: t, w: 2.3, h: 1.1, bg: '#d8203a', fg: '#ffffff', emissive: 1.0, weight: '900' });
      out.stats.signs += 2;
    }
  }
  if (K.podium) {
    // 渋東シネタワー: the black cinema podium (2F–3F) under the glass, 「TOHO CINEMA」 and the red TOHO roundel
    for (let i = 0; i < n; i++) {
      if (faces[i].kind !== 'street') continue;
      const e = edge(i); if (e.len < 3) continue;
      batch.add(M.innerDark, L.boxAt(e.mx + e.nx * 0.3, y0 + 4.4 + 3.1, e.mz + e.nz * 0.3, e.len + 0.5, 6.2, 0.35, L.rotYOf(e.tx, e.tz), false), e.mx, e.mz);
    }
    // the blue glass skin over the tower floors (the generic facade stays behind it)
    S.prism(batch, M.glassHikarie, L.offsetPolygon(poly, 0.12), y0 + 10.7, y0 + H - 0.4, { cap: false, uvScale: 3.5 / 3.6 });
    const w = Math.min(m.len - 4, 9), [x, z] = at(m, m.len / 2, 0.5);
    S.signQuad(batch, x, y0 + 7.6, z, m.nx, m.nz, { text: K.podium, w, h: 1.4, bg: '#050507', fg: '#ffffff', emissive: 1.25, weight: '800', letterSpacing: 6 });
    const [lx, lz] = at(m, m.len / 2 - w / 2 - 1.1, 0.5);
    S.signQuad(batch, lx, y0 + 7.6, lz, m.nx, m.nz, { text: 'TOHO', w: 1.5, h: 1.5, bg: '#d6101e', fg: '#ffffff', emissive: 1.1, weight: '900' });
    out.stats.signs += 2;
  }
  if (K.bands) {
    // 道玄坂センタービル: the white spandrel bands between its dark window strips, round every street face
    for (let i = 0; i < n; i++) {
      if (faces[i].kind !== 'street') continue;
      const e = edge(i); if (e.len < 3) continue;
      for (let k = 1; k < storeys; k++) {
        const yb = y0 + gfH + (k - 1) * sh;
        batch.add(M.whiteMetal, L.boxAt(e.mx + e.nx * 0.12, yb + 0.08 * sh, e.mz + e.nz * 0.12, e.len + 0.2, 0.42 * sh, 0.14, L.rotYOf(e.tx, e.tz), false), e.mx, e.mz);
      }
      batch.add(M.whiteMetal, L.boxAt(e.mx + e.nx * 0.12, y0 + H - 0.45, e.mz + e.nz * 0.12, e.len + 0.2, 0.9, 0.14, L.rotYOf(e.tx, e.tz), false), e.mx, e.mz);
    }
  }
  if (K.board) {
    // 楽苑: the tall white board with the red name, projecting from the front so it reads up and down the street
    const u = Math.abs(downU - Math.min(3, m.len * 0.3)), [x, z] = at(m, u, 1.7), bh = Math.min(11, H * 0.5), yc = y0 + H - 1.2 - bh / 2;
    batch.add(M.whiteMetal, L.boxAt(x, yc, z, 0.3, bh + 0.3, 3.3, L.rotYOf(m.tx, m.tz), false), x, z);
    batch.add(M.darkMetal, L.boxAt(x - m.nx * 0.95, yc, z - m.nz * 0.95, 0.12, bh * 0.8, 0.12, 0, false), x, z);
    S.signQuad(batch, x, yc, z, m.tx, m.tz, { text: K.board, sub: 'パチンコ', w: 2.9, h: bh - 0.3, bg: '#ffffff', fg: '#d01020', vertical: true, emissive: 1.1, weight: '900', double: true });
    out.stats.signs++;
  }
  void sh;
}
/** The Gusto lot: the 2-storey corner block (depth back from its 道玄坂 face) and the 9F block behind it. */
function gustoSplit(f, CITY) {
  const poly = f.poly, G = DG.GUSTO_CORNER, road = CITY.roads.find((r) => r.id === 'dogenzaka').path;
  let best = -1, bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 4) continue;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, [nx, nz] = L.edgeNormal(poly, i), q = DG.nearestOn(road, mx, mz);
    if ((q.x - mx) * nx + (q.z - mz) * nz <= 0) continue;
    if (q.d < bd) { bd = q.d; best = i; }
  }
  if (best < 0) return null;
  const a = poly[best], [nx, nz] = L.edgeNormal(poly, best), px = a[0] - nx * G.depth, pz = a[1] - nz * G.depth;
  const podium = L.ensureCW(clipHalf(poly, px, pz, nx, nz, 1)), tower = L.ensureCW(clipHalf(poly, px, pz, nx, nz, -1));
  if (podium.length < 3 || tower.length < 3) return null;
  return { podium, tower };
}
/** The Gusto / セブンイレブ block at 交番前 (Commons 2024-12 / 2026-03 night): 1F convenience store glass under the
 *  striped fascia, 2F dining room behind wooden lattice, the dark 「GUSTD」 band, the red logo box over the corner, the
 *  roof LED screen (its panel is signage.js's, anchored here) on a steel frame. */
function gustoCorner(ctx, M, out, col, g, f) {
  const { batch } = ctx, P = g.podium, n = P.length, y0 = siteLevels(P, ctx.yAt).lo + SW_H, G = DG.GUSTO_CORNER;
  const H1 = 4.3, H2 = 3.5, BAND = 1.15, top = H1 + H2 + BAND;
  S.prism(batch, M.concrete, L.offsetPolygon(P, -0.4), y0 - 0.4, y0 + top, { cap: true, capMat: M.concrete });
  const street = [];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 2) { street.push(false); continue; }
    const [nx, nz] = L.edgeNormal(P, i), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len, rot = L.rotYOf(tx, tz);
    const st = ctx.isStreetSide(mx + nx * 3.5, mz + nz * 3.5); street.push(st);
    if (!st) continue;
    const box = (mat, y, h, o, d, w = len) => batch.add(mat, L.boxAt(mx + nx * o, y0 + y, mz + nz * o, w, h, d, rot, false), mx, mz);
    box(M.interior, 1.75, 3.1, -0.25, 0.06, len - 0.5);                 // 1F: the store's lit shelves behind the glass
    box(M.glassClear, 1.75, 3.3, 0.02, 0.06, len - 0.3);
    for (const sy of [0.75, 1.45, 2.15]) box(M.darkMetal, sy, 0.07, -0.18, 0.05, len - 0.8);   // shelf lines behind the glass
    for (let u = 1.8; u < len - 0.6; u += 1.9) { const x = a[0] + tx * u + nx * 0.06, z = a[1] + tz * u + nz * 0.06; batch.add(M.darkMetal, L.boxAt(x, y0 + 1.75, z, 0.1, 3.3, 0.1, rot, false), mx, mz); }
    box(M.whiteMetal, H1 - 0.5, 0.95, 0.22, 0.2);                         // 1F fascia and its three stripes
    box(M.glowOrange, H1 - 0.82, 0.1, 0.33, 0.02); box(M.glowGreen, H1 - 0.7, 0.1, 0.33, 0.02); box(M.glowRed, H1 - 0.58, 0.1, 0.33, 0.02);
    box(M.interiorDim, H1 + H2 / 2 + 0.1, H2 - 0.7, -0.2, 0.06, len - 0.6);   // 2F: the dining room's warm light
    for (let u = 0.4; u < len - 0.3; u += 0.42) { const x = a[0] + tx * u + nx * 0.12, z = a[1] + tz * u + nz * 0.12; batch.add(M.wood, L.boxAt(x, y0 + H1 + H2 / 2 + 0.1, z, 0.07, H2 - 0.8, 0.07, rot, false), mx, mz); }
    box(M.wood, H1 + 0.65, 0.12, 0.16, 0.1); box(M.wood, H1 + H2 - 0.2, 0.12, 0.16, 0.1);
    box(M.darkMetal, H1 + H2 + BAND / 2, BAND, 0.3, 0.35, len + 0.4);     // the dark name band
    const y7 = y0 + H1 - 0.5, uS = len > 7 ? len * 0.33 : len / 2;
    S.signQuad(batch, a[0] + tx * uS + nx * 0.34, y7, a[1] + tz * uS + nz * 0.34, nx, nz, { text: 'セブンイレブ', w: Math.min(3.2, len * 0.4), h: 0.6, bg: '#ffffff', fg: '#d02020', emissive: 0.9, weight: '900' });
    S.signQuad(batch, mx + nx * 0.49, y0 + H1 + H2 + BAND / 2, mz + nz * 0.49, nx, nz, { text: 'GUSTD', w: Math.min(6.4, len * 0.62), h: 1.0, bg: '#141414', fg: '#ffffff', emissive: 1.2, weight: '800', letterSpacing: 4 });
    out.stats.signs += 2;
  }
  // the corner: the vertex between the two street faces
  let ci = -1;
  for (let i = 0; i < n; i++) if (street[i] && street[(i - 1 + n) % n]) { ci = i; break; }
  if (ci < 0) ci = street.indexOf(true);
  const cv = P[ci], [n1x, n1z] = L.edgeNormal(P, ci), [n0x, n0z] = L.edgeNormal(P, (ci - 1 + n) % n);
  let bx = n1x + n0x, bz = n1z + n0z; const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;
  // red logo box on a short mast at the corner
  const lx = cv[0] - bx * 0.9, lz = cv[1] - bz * 0.9, ly = y0 + top + 1.45;
  batch.add(M.darkMetal, L.boxAt(lx, y0 + top + 0.2, lz, 0.18, 0.5, 0.18, 0, false), lx, lz);
  batch.add(M.redPaint, L.boxAt(lx, ly, lz, 2.3, 2.3, 0.45, L.rotYOf(-bz, bx), false), lx, lz);
  S.signQuad(batch, lx + bx * 0.24, ly, lz + bz * 0.24, bx, bz, { text: 'ガスド', sub: 'Café レストラン', w: 2.1, h: 2.1, bg: '#c8102e', fg: '#ffffff', emissive: 1.15, weight: '900', double: true });
  out.stats.signs++;
  // the LED screen on the roof, a little back from the corner, on a steel frame
  const sc = G.screen, sx = cv[0] - bx * 3.0, sz = cv[1] - bz * 3.0, sy = y0 + top + sc.over + sc.h / 2, srot = L.rotYOf(-bz, bx);
  batch.add(M.darkMetal, L.boxAt(sx - bx * 0.25, sy, sz - bz * 0.25, sc.w + 0.5, sc.h + 0.5, 0.4, srot, false), sx, sz);
  for (const s of [-1, 1]) { const px = sx - bx * 0.5 - bz * s * sc.w * 0.35, pz = sz - bz * 0.5 + bx * s * sc.w * 0.35; batch.add(M.darkMetal, L.boxAt(px, y0 + top + sc.over / 2, pz, 0.3, sc.over + 0.2, 0.3, 0, false), sx, sz); }
  (out.anchors.screens ||= []).push({ position: new THREE.Vector3(sx + bx * 0.02, sy, sz + bz * 0.02), normal: new THREE.Vector3(bx, 0, bz), size: [sc.w, sc.h], name: 'ガスド前ビジョン' });
  for (const c of L.edgeColliders(P, top)) { c.obb.center.y += y0; col(c, 'building'); }
  out.plan.push({ poly: P, h: top, base: y0 - SW_H, id: 'dg_gusto', style: 'tenant', storeys: 2, corridor: true });
  void f;
}

// ------------------------------------------------------------------------------------------------ street trees
// (pass 16) ケヤキ rows on both kerbs (dogenzakaData STREET_TREES): two instanced silhouettes + the big one at the
// monuments; square pits (granite edge + grating) merged into the corridor batch; none on a zebra, a side-street mouth,
// an exit, the bus stop, a bike rack or a monument.
function streetTrees(ctx, M, out, col) {
  const { batch, inst, yAt, field, CITY } = ctx, TR = DG.STREET_TREES;
  const pave = (x, z) => yAt(x, z) + (field.sample(x, z) > 0.3 ? SW_H : 0);
  const V = [zelkovaGeo(14.2, 5.4, 1), zelkovaGeo(12.6, 4.6, 2)];
  const mainIds = new Set(['dogenzaka', 'dogenzaka_ue', 'dogenzaka_shita', 'tamagawa_ue', 'tamagawa_ue_wb', 'tamagawa_ue_wb2']);
  const crossRoads = CITY.roads.filter((r) => !mainIds.has(r.id) && r.width <= 12);
  const zebra = (x, z) => (CITY.crosswalksExtra || []).some((c) => L.distToSegment(x, z, c.a[0], c.a[1], c.b[0], c.b[1]) < c.width / 2 + 2.4);
  const mouth = (x, z) => crossRoads.some((r) => { for (let i = 0; i < r.path.length - 1; i++) if (L.distToSegment(x, z, r.path[i][0], r.path[i][1], r.path[i + 1][0], r.path[i + 1][1]) < r.width / 2 + 2.2) return true; return false; });
  const bs = (CITY.busStops || []).find((s) => s.terminal === 'dogenzaka');
  const avoid = [...DG.EXITS.map((e) => [e.pos, 4.6]), ...DG.BIKE_PARKING.map((p) => [p, 3.4]), ...DG.MONUMENTS.map((m) => [m.pos, 3.0]), [DG.KOBAN.pos, 5.5], ...(bs ? [[bs.pole, 3.2]] : [])];
  const blocked = (x, z) => avoid.some(([p, r]) => Math.hypot(x - p[0], z - p[1]) < r) || zebra(x, z) || mouth(x, z) || L.pointInPoly(x, z, DG.WORKS.site) || L.pointInPoly(x, z, DG.WORKS.notch);
  const spots = [];
  for (const row of TR.rows) {
    const road = CITY.roads.find((r) => r.id === row.road); if (!road) continue;
    const o = road.width / 2 + TR.kerb;
    let s = row.anchor - Math.ceil((row.anchor - row.s0) / row.step) * row.step;
    for (; s <= row.s1; s += row.step) {
      if (s < row.s0) continue;
      // a blocked spot moves up to 3 m along the kerb before it is dropped (as a real pit sits between driveways)
      for (const ds of [0, 1.5, -1.5, 3, -3]) {
        const [x0, z0, tx, tz] = DG.pointAtS(road.path, s + ds), x = x0 - tz * o * row.side, z = z0 + tx * o * row.side;
        const fs = field.sample(x, z);
        if (fs < 0.45 || fs > 2.6 || blocked(x, z)) continue;
        if (spots.some((q) => Math.hypot(q.x - x, q.z - z) < 7)) break;
        spots.push({ x, z, k: hashS(`${row.road}${row.side}${Math.round(s)}`) });
        break;
      }
    }
  }
  for (const b of TR.big) spots.push({ x: b.pos[0], z: b.pos[1], k: 0.5, big: b.h / 14.2 });
  for (const t of spots) {
    const y = pave(t.x, t.z), v = t.big ? 0 : t.k < 0.55 ? 0 : 1, sc = t.big || 0.9 + 0.22 * ((t.k * 7.3) % 1), ry = t.k * TAU;
    inst.add(`dg_zk${v}_bark`, V[v].bark, M.bark, t.x, y, t.z, ry, sc, sc, sc);
    inst.add(`dg_zk${v}_leaf`, V[v].leaf, M.leaf, t.x, y, t.z, ry, sc, sc, sc);
    if (!MOBILE) inst.add(`dg_zk${v}_cast`, V[v].cast, M.leafCast, t.x, y, t.z, ry, sc, sc, sc);
    // the pit: granite edge, cast-iron grating
    const q = DG.nearestOn(CITY.roads.find((r) => r.id === 'dogenzaka').path, t.x, t.z), rot = L.rotYOf(q.tx, q.tz);
    for (const u of [0.72, -0.72]) {
      batch.add(M.granite, L.boxAt(t.x - q.tz * u, y + 0.04, t.z + q.tx * u, 1.56, 0.1, 0.12, rot, false), t.x, t.z);   // along the kerb
      batch.add(M.granite, L.boxAt(t.x + q.tx * u, y + 0.04, t.z + q.tz * u, 0.12, 0.1, 1.56, rot, false), t.x, t.z);   // across it
    }
    batch.add(M.darkMetal, L.boxAt(t.x, y + 0.015, t.z, 1.32, 0.04, 1.32, rot, false), t.x, t.z);
    col(S.boxCollider(t.x, t.z, 0.55, 3.2, 0.55, 0, y), 'tree');
  }
  out.stats.trees = spots.length;
}

// ------------------------------------------------------------------------------------------------ furniture
function furniture(ctx, M, out, col) {
  const { batch, inst, yAt, field, CITY } = ctx;
  const pave = (x, z) => yAt(x, z) + (field.sample(x, z) > 0.3 ? SW_H : 0);
  // ---- the 道玄坂上（交番前） bus stop: pole with the round stop plate and the timetable box, a bench behind
  const bs = (CITY.busStops || []).find((s) => s.terminal === 'dogenzaka');
  if (bs) {
    let [px, pz] = bs.pole;
    for (let k = 0; k < 30 && field.sample(px, pz) < 0.6; k++) { const gx = field.sample(px + 0.25, pz) - field.sample(px - 0.25, pz), gz = field.sample(px, pz + 0.25) - field.sample(px, pz - 0.25), gl = Math.hypot(gx, gz) || 1; px += gx / gl * 0.2; pz += gz / gl * 0.2; }
    const y = pave(px, pz), dx = Math.cos(bs.heading), dz = -Math.sin(bs.heading);
    batch.add(M.silver, L.boxAt(px, y + 1.3, pz, 0.08, 2.6, 0.08, 0, false), px, pz);
    S.signQuad(batch, px, y + 2.35, pz, dx, dz, { text: '道玄坂上', sub: '交番前  のりば', w: 0.6, h: 0.6, bg: '#f2f2ee', fg: '#b8141c', emissive: 0.6, weight: '900', double: true });
    S.signQuad(batch, px, y + 1.6, pz, dx, dz, { text: '東光バス', sub: '渋谷駅 ・ 大橋 ・ 三軒茶屋', w: 0.6, h: 0.5, bg: '#b8141c', fg: '#ffffff', emissive: 0.5, weight: '800', double: true });
    const lx = dz, lz = -dx;                                                  // back from the kerb
    const bx = px + lx * 1.4 - dx * 2.2, bz = pz + lz * 1.4 - dz * 2.2;
    batch.add(M.silver, L.boxAt(bx, pave(bx, bz) + 0.44, bz, 1.8, 0.06, 0.42, L.rotYOf(dx, dz), false), bx, bz);
    col(S.boxCollider(px, pz, 0.2, 2.6, 0.2, 0, y), 'pole');
    out.stats.signs += 2;
  }
  // ---- 渋谷町駅 A0 / A1: stairs down to the 道玄坂 underground passage (東京メトロ / 東急), canopy with the blue fascia
  for (const e of DG.EXITS) {
    let [x, z] = e.pos;
    for (let k = 0; k < 30 && field.sample(x, z) < 2.4; k++) { const gx = field.sample(x + 0.25, z) - field.sample(x - 0.25, z), gz = field.sample(x, z + 0.25) - field.sample(x, z - 0.25), gl = Math.hypot(gx, gz) || 1; x += gx / gl * 0.2; z += gz / gl * 0.2; }
    const q = DG.nearestOn(CITY.roads.find((r) => r.id === 'dogenzaka').path, x, z), rot = L.rotYOf(q.tx, q.tz), y = pave(x, z);
    const tx = q.tx, tz = q.tz, nx = x - q.x, nz = z - q.z, nl = Math.hypot(nx, nz) || 1;
    batch.add(M.innerDark, L.boxAt(x, y + 0.02, z, 4.2, 0.04, 2.0, rot, false), x, z);                         // the well (a dark recess)
    for (const s of [1, -1]) batch.add(M.granite, L.boxAt(x + nx / nl * s * 1.15, y + 0.5, z + nz / nl * s * 1.15, 4.4, 1.0, 0.25, rot, true), x, z);
    batch.add(M.granite, L.boxAt(x + tx * 2.1, y + 0.5, z + tz * 2.1, 0.25, 1.0, 2.5, rot, true), x, z);
    batch.add(M.darkMetal, L.boxAt(x, y + 2.6, z, 4.8, 0.14, 2.8, rot, false), x, z);                       // canopy
    batch.add(M.glowBlue, L.boxAt(x - tx * 2.45, y + 2.55, z - tz * 2.45, 0.08, 0.3, 2.8, rot, false), x, z);
    for (const s of [1, -1]) for (const u of [-2.2, 2.2]) batch.add(M.silver, L.boxAt(x + tx * u + nx / nl * s * 1.3, y + 1.3, z + tz * u + nz / nl * s * 1.3, 0.1, 2.6, 0.1, 0, false), x, z);
    S.signQuad(batch, x - tx * 2.55, y + 2.1, z - tz * 2.55, -tx, -tz, { text: e.ref, sub: '渋谷町駅', w: 0.9, h: 0.9, bg: '#1d56b8', fg: '#ffffff', emissive: 0.9, weight: '900' });
    col(S.boxCollider(x, z, 4.6, 1.05, 2.6, rot, y), 'prop');
    out.stats.signs++;
  }
  // ---- 道玄坂乃碑 / 道玄坂道供養碑 at the 交番前 junction's east corner
  for (const m of DG.MONUMENTS) {
    const [x, z] = m.pos, y = pave(x, z), q = DG.nearestOn(CITY.roads.find((r) => r.id === 'dogenzaka').path, x, z), nx = q.x - x, nz = q.z - z, l = Math.hypot(nx, nz) || 1, rot = L.rotYOf(-nz, nx);
    batch.add(M.granite, L.boxAt(x, y + 0.15, z, 1.6, 0.3, 1.0, rot, true), x, z);
    if (m.kind === 'stele') { batch.add(M.stele, L.boxAt(x, y + 1.15, z, 1.1, 1.7, 0.28, rot, true), x, z); S.signQuad(batch, x + nx / l * 0.15, y + 1.3, z + nz / l * 0.15, nx / l, nz / l, { text: '道玄坂', sub: '大和田太郎道玄 ・ 大山道', w: 0.8, h: 1.1, bg: '#3c3d40', fg: '#d8d4c8', vertical: false, emissive: 0.2, weight: '700' }); out.stats.signs++; }
    else { batch.add(M.rough, L.boxAt(x, y + 0.85, z, 0.8, 1.1, 0.55, rot + 0.2, true), x, z); batch.add(M.rough, L.boxAt(x, y + 1.45, z, 0.6, 0.3, 0.45, rot - 0.1, true), x, z); }
    col(S.boxCollider(x, z, 1.6, 1.8, 1.0, rot, y), 'prop');
    // the square granite 道標 post 「道玄坂」 at the kerb in front of the stones, by the 交番前 zebra (Commons 2026-03-13_090)
    if (m.kind === 'stele') {
      const rd = CITY.roads.find((r) => r.id === 'dogenzaka'), o = rd.width / 2 + 0.7;
      const px = q.x - nx / l * o + q.tx * 2.5, pz = q.z - nz / l * o + q.tz * 2.5, py = pave(px, pz);
      batch.add(M.granite, L.boxAt(px, py + 1.2, pz, 0.36, 2.4, 0.36, rot, true), px, pz);
      batch.add(M.granite, L.boxAt(px, py + 2.45, pz, 0.42, 0.1, 0.42, rot, true), px, pz);
      for (const s of [1, -1]) S.signQuad(batch, px + nx / l * 0.185 * s, py + 1.55, pz + nz / l * 0.185 * s, nx / l * s, nz / l * s, { text: '道玄坂', w: 0.3, h: 1.2, bg: '#e9e6de', fg: '#1b1b1b', vertical: true, emissive: 0.15, weight: '800' });
      col(S.boxCollider(px, pz, 0.4, 2.5, 0.4, rot, py), 'prop');
      out.stats.signs += 2;
    }
  }
  // ---- the マークシティ car-park entrance: a lit blue 「P」 board on a pole at the ramp mouth
  {
    const mp = CITY.roads.find((r) => r.id === 'dg_markcity_p');
    if (mp) {
      const [a, b] = mp.path, dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tx = (b[0] - a[0]) / dl, tz = (b[1] - a[1]) / dl;
      const o = mp.width / 2 + 0.9, x = a[0] + tx * 2 + tz * o, z = a[1] + tz * 2 - tx * o, y = pave(x, z);
      batch.add(M.silver, L.boxAt(x, y + 1.7, z, 0.12, 3.4, 0.12, 0, false), x, z);
      S.signQuad(batch, x - tx * 0.1, y + 3.0, z - tz * 0.1, -tx, -tz, { text: 'P', sub: 'マークシティ駐車場 入口', w: 1.1, h: 1.3, bg: '#1d4fb0', fg: '#ffffff', emissive: 0.9, weight: '900' });
      col(S.boxCollider(x, z, 0.2, 3.4, 0.2, 0, y), 'prop');
      out.stats.signs++;
    }
  }
  // ---- the 百軒店 gate over its approach (pass 16, Commons 2017-12): two red round posts with globe lamps, the maroon
  // tie beam lettered 「Hyakkendana」 and, above it, the violet-lit 「しぶや百軒店」 board with the small 百軒店 plaque
  {
    const side = CITY.roads.find((r) => r.id === 'dg_hyakkendana');
    if (side) {
      const [x, z, tx, tz] = DG.pointAtS(side.path, 5), nx = -tz, nz = tx, w = side.width + 1.4, y = yAt(x, z), rot = L.rotYOf(nx, nz);
      for (const s of [1, -1]) {
        const px = x + nx * s * w / 2, pz = z + nz * s * w / 2;
        inst.add('dg_gatepost', UNIT_CYL, M.redPaint, px, y, pz, 0, 0.2, 7.3, 0.2);
        batch.add(M.darkMetal, L.boxAt(px - nx * s * 0.2, y + 4.3, pz - nz * s * 0.2, 0.3, 0.06, 0.06, rot, false), px, pz);   // lamp arm + globe
        batch.add(M.glowWarm, L.boxAt(px - nx * s * 0.36, y + 4.3, pz - nz * s * 0.36, 0.3, 0.3, 0.3, 0, false), px, pz);
        col(S.boxCollider(px, pz, 0.45, 7.3, 0.45, 0, y), 'pole');
      }
      batch.add(M.redPaint, L.boxAt(x, y + 5.45, z, w + 0.9, 0.55, 0.32, rot, false), x, z);          // tie beam (maroon)
      S.signQuad(batch, x - tx * 0.18, y + 5.45, z - tz * 0.18, -tx, -tz, { text: 'Hyakkendana', w: Math.min(w * 0.5, 3.4), h: 0.42, bg: '#6e1420', fg: '#f4f0e8', emissive: 0.7, weight: '700', double: true });
      batch.add(M.darkMetal, L.boxAt(x, y + 6.72, z, w + 1.1, 1.5, 0.45, rot, false), x, z);        // the board's frame
      S.signQuad(batch, x - tx * 0.25, y + 6.72, z - tz * 0.25, -tx, -tz, { text: 'しぶや百軒店', w: w + 0.7, h: 1.25, bg: '#2a1a8a', bg2: '#5a3ae0', fg: '#fff2dc', emissive: 1.25, weight: '800', font: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif', letterSpacing: 10, double: true });
      S.signQuad(batch, x - tx * 0.28, y + 6.72, z - tz * 0.28, -tx, -tz, { text: '百軒店', w: 0.55, h: 1.2, bg: '#6e1420', fg: '#e8d8b0', vertical: true, emissive: 0.8, weight: '800', double: true });
      out.stats.signs += 3;
    }
  }
  // ---- bicycle parking (OSM amenity=bicycle_parking) and the bikes left along the upper street
  for (const [k, p] of DG.BIKE_PARKING.entries()) {
    let [x, z] = p;
    if (field.sample(x, z) < 1.0) continue;
    const q = DG.nearestOn([...CITY.roads.find((r) => r.id === 'dogenzaka').path, ...CITY.roads.find((r) => r.id === 'dogenzaka_ue').path.slice(1)], x, z), ry = Math.atan2(q.x - x, q.z - z);
    const tx = q.tx, tz = q.tz;
    for (let i = 0; i < 7; i++) { const u = (i - 3) * 0.62, bx = x + tx * u, bz = z + tz * u; if (field.sample(bx, bz) < 0.8) continue; bike(inst, M, bx, pave(bx, bz), bz, ry + (i % 2 ? 0.08 : -0.05), [0x2a2c30, 0xd8d8d0, 0x8a1a1a, 0x1c3a6a, 0x3a3a3a][(i + k) % 5]); }
    batch.add(M.silver, L.boxAt(x, pave(x, z) + 0.35, z, 4.6, 0.05, 0.05, L.rotYOf(tx, tz), false), x, z);
    col(S.boxCollider(x, z, 4.6, 1.0, 1.8, L.rotYOf(tx, tz), pave(x, z)), 'prop');
  }
  // ---- street trees (pass 16): the ケヤキ rows on both kerbs
  streetTrees(ctx, M, out, col);
  const ue = CITY.roads.find((r) => r.id === 'dogenzaka_ue'), dg = CITY.roads.find((r) => r.id === 'dogenzaka');
  // ---- guard fences at the two junctions' corners (kept off the zebras' landings)
  const zebraNear = (x, z) => (CITY.crosswalksExtra || []).some((c) => L.distToSegment(x, z, c.a[0], c.a[1], c.b[0], c.b[1]) < c.width / 2 + 1.2);
  for (const [road, s0, s1] of [[dg, 355, 378], [ue, 12, 34], [ue, 142, 160]]) {
    for (const side of [1, -1]) {
      let run = null;
      for (let s = s0; s <= s1; s += 2) {
        const [x0, z0, tx, tz] = DG.pointAtS(road.path, s), o = road.width / 2 + 0.45, x = x0 - tz * o * side, z = z0 + tx * o * side;
        const ok = field.sample(x, z) > 0.25 && !zebraNear(x, z);
        if (ok) { if (!run) run = [x, z]; else { fence(batch, M, yAt, run, [x, z], out, col); run = [x, z]; } } else run = null;
      }
    }
  }
  // ---- street-name plates (blue, 道路標識) on the lamp line near the junctions
  for (const [road, s, side, text, sub] of [[dg, 150, -1, '道玄坂', 'Dogenzaka'], [dg, 372, 1, '道玄坂上交番前', 'Dogenzakaue Koban'], [ue, 150, -1, '道玄坂上', 'Dogenzaka-ue']]) {
    const [x0, z0, tx, tz] = DG.pointAtS(road.path, s), o = road.width / 2 + 0.6, x = x0 - tz * o * side, z = z0 + tx * o * side;
    if (field.sample(x, z) < 0.3) continue;
    const y = pave(x, z);
    batch.add(M.silver, L.boxAt(x, y + 1.9, z, 0.08, 3.8, 0.08, 0, false), x, z);
    S.signQuad(batch, x, y + 3.45, z, -tx, -tz, { text, sub, w: 1.6, h: 0.55, bg: '#1d4f9a', fg: '#ffffff', emissive: 0.6, weight: '800', double: true });
    col(S.boxCollider(x, z, 0.2, 3.8, 0.2, 0, y), 'pole');
    out.stats.signs++;
  }
}

// ------------------------------------------------------------------------------------------------ signal heads
// Pedestrian heads at both ends of every corridor crossing, vehicle heads (mast arm over the lanes) on each
// approach of the signalled mid-block zebras (the junctions' own vehicle heads are traffic.js's). Lenses: one
// InstancedMesh, colours set from traffic's aspects in update().
function signals(ctx, M, out, col) {
  const { batch, yAt, field, CITY, group } = ctx;
  const lamps = [], heads = [];
  const add = (x, y, z, ry, c, ped) => { lamps.push({ x, y, z, ry, c, ped, col: new THREE.Color(ped ? (c === 'green' ? 0x39f0b0 : 0xff4030) : c === 'green' ? 0x2bffb8 : c === 'amber' ? 0xffb020 : 0xff3020).multiplyScalar(ped ? 2.2 : 2.8), off: new THREE.Color(0x121414) }); return lamps.length - 1; };
  const J = { kobanmae: { a: ['dogenzaka', 'dogenzaka_ue'] }, dogenzakaue: { a: ['tamagawa_ue'] } };
  for (const c of CITY.crosswalksExtra || []) {
    if (!c.corridor) continue;
    const road = CITY.roads.find((r) => {
      const q = DG.nearestOn(r.path, (c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2); return q.d < 1.5 && Math.abs(q.tx * (c.b[0] - c.a[0]) + q.tz * (c.b[1] - c.a[1])) < 0.5 * Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]);
    });
    if (!c.signals && !c.junction) continue;
    // which aspect walks: a zebra's own cycle, else (at a junction) the group running parallel to it
    let jid = null, group2 = null;
    if (c.junction) { jid = c.junction; const inA = road && J[jid] && J[jid].a.includes(road.id); group2 = inA ? 'b' : 'a'; }
    const ux = c.b[0] - c.a[0], uz = c.b[1] - c.a[1], ul = Math.hypot(ux, uz) || 1;
    for (const [end, dir] of [[c.a, 1], [c.b, -1]]) {
      // the post stands on the pavement just beside the zebra's landing, facing across it
      let x = end[0] - ux / ul * dir * 0.3, z = end[1] - uz / ul * dir * 0.3;
      const sx = -uz / ul, sz = ux / ul;
      x += sx * (c.width / 2 + 0.5); z += sz * (c.width / 2 + 0.5);
      for (let k = 0; k < 12 && field.sample(x, z) < 0.4; k++) { x -= ux / ul * dir * 0.3; z -= uz / ul * dir * 0.3; }
      if (field.sample(x, z) < 0.3) continue;
      const y = yAt(x, z) + SW_H, fx = ux / ul * dir, fz = uz / ul * dir, ry = Math.atan2(-fx, -fz) + Math.PI;
      batch.add(M.sigPole, L.boxAt(x, y + 1.6, z, 0.13, 3.2, 0.13, 0, false), x, z);
      batch.add(M.sigBody, L.boxAt(x + fx * 0.1, y + 2.95, z + fz * 0.1, 0.42, 0.86, 0.18, L.rotYOf(-fz, fx), false), x, z);
      col(S.boxCollider(x, z, 0.25, 3.3, 0.25, 0, y), 'pole');
      const h = { xing: c.signals ? c.id : null, jid, group: group2, ped: true, lamps: [], key: '' };
      h.lamps.push({ c: 'red', i: add(x + fx * 0.2, y + 3.16, z + fz * 0.2, ry, 'red', true) });
      h.lamps.push({ c: 'green', i: add(x + fx * 0.2, y + 2.74, z + fz * 0.2, ry, 'green', true) });
      heads.push(h);
    }
    // vehicle heads for the mid-block zebras: on the left kerb before the zebra for each direction, arm over the lanes
    if (c.signals && c.stops && road) {
      for (const st of c.stops) {
        const mx = (st.a[0] + st.b[0]) / 2, mz = (st.a[1] + st.b[1]) / 2;
        const q = DG.nearestOn(road.path, mx, mz), sgn = Math.sign((mx - q.x) * q.tz - (mz - q.z) * q.tx) || 1;
        // travel direction for this half: its left is where the stop line lies
        const dx = q.tx * sgn, dz = q.tz * sgn, lx = dz, lz = -dx;
        let px = q.x + lx * (road.width / 2 + 0.6), pz = q.z + lz * (road.width / 2 + 0.6);
        for (let k = 0; k < 10 && field.sample(px, pz) < 0.4; k++) { px += lx * 0.2; pz += lz * 0.2; }
        const y = yAt(px, pz) + SW_H, reach = road.width / 2 - 0.6;
        batch.add(M.sigPole, L.boxAt(px, y + 2.8, pz, 0.2, 5.6, 0.2, 0, false), px, pz);
        const hx = px - lx * reach, hz = pz - lz * reach;
        batch.add(M.sigPole, L.boxAt((px + hx) / 2, y + 5.5, (pz + hz) / 2, reach, 0.12, 0.12, L.rotYOf(-lx, -lz), false), px, pz);
        batch.add(M.sigBody, L.boxAt(hx, y + 5.2, hz, 1.6, 0.5, 0.22, L.rotYOf(-lx, -lz), false), hx, hz);
        col(S.boxCollider(px, pz, 0.3, 5.6, 0.3, 0, y), 'pole');
        const h = { xing: c.id, ped: false, lamps: [], key: '' };
        const ry = Math.atan2(-dx, -dz);
        // 青 on the driver's left (+l), 赤 on the right
        for (const [cn, o] of [['green', 0.5], ['amber', 0], ['red', -0.5]]) h.lamps.push({ c: cn, i: add(hx + lx * o - dx * 0.13, y + 5.2, hz + lz * o - dz * 0.13, ry, cn, false) });
        heads.push(h);
      }
    }
  }
  if (!lamps.length) return { lamps, heads };
  const geo = new THREE.CircleGeometry(0.15, 16);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, name: 'dg_siglens' }), lamps.length);
  mesh.name = 'dg:siglens';
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), P = new THREE.Vector3(), SC = new THREE.Vector3(1, 1, 1);
  lamps.forEach((l, i) => { q4.setFromAxisAngle(UP, l.ry); m4.compose(P.set(l.x, l.y, l.z), q4, SC.setScalar(l.ped ? 1.1 : 1)); mesh.setMatrixAt(i, m4); mesh.setColorAt(i, l.off); });
  mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = true; mesh.computeBoundingSphere();
  if (ctx.engine && ctx.engine.layers && ctx.engine.layers.BLOOM != null) mesh.layers.enable(ctx.engine.layers.BLOOM);
  group.add(mesh);
  return { lamps, heads, mesh };
}

export default { buildDogenzaka, corridorFootprints };
