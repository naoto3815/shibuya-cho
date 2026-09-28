// [city] 渋谷町 environment, rebuilt from src/world/cityData.js (docs/CITY_DATA.md, docs/LANDMARKS.md).
// Streets (SDF sidewalks, kerbs, tactile strips, paint, zebra + diagonal scrambles, manholes, medians), every
// landmark from src/world/buildings/*.js, procedural infill facades for CITY.blocks, elevated rail, silhouette
// impostors. Everything static is merged per material (GeoBatch) or instanced (Instancer).
//
// Exports (module object):
//   city.landmarks   { key: { position: Vector3, size: Vector3, group, anchors, label, data } }  (cityData keys +
//                    grey-box aliases centerGai / marui / hachiko so signage keeps working)
//   city.facades[]   { id, buildingId, position: Vector3 (bottom-centre of the face), normal: Vector3, width, height,
//                      storeys, tenants[], kind:'street'|'alley'|'shop'|'landmark', groundFloorHeight }
//   city.billboards[] { buildingId, position, normal, width, height }   rooftop frames for the signage module
//   city.getMinimap() -> 512² canvas (400 m across, north up)   city.worldToMinimap(x, z)
//   city.roads [{id, name, points:[[x,z]...], width, pedestrian}]   city.lanes [{points, cum, length, axis, stopS}]
//   city.crowdPaths [{points, width}]   city.crossing {center, radius, corners}   city.plazas   city.getSpawnPoints()
//   city.field.sample(x, z)  signed distance to the nearest carriageway edge (>0 = sidewalk)
import * as THREE from 'three';
import { accessHeight } from './markcityAccess.js';
import { CITY, groundY, facing } from './cityData.js';
import * as L from './buildings/lib.js';
import { buildStreets, setWetFactor, SW_H, vistaRoads } from './buildings/streets.js';
import { buildBuilding, getAtlases, setNightFactor, tenantType, WINDOW_STATS, tickBlink , tenantStats, markTenantShown } from './buildings/genericBuilding.js';
import { buildRail } from './buildings/rail.js';
import { buildImpostors } from './buildings/impostors.js';
import * as S from './buildings/shared.js';
import { setNight as setLandmarkNight } from './buildings/shared.js';
import * as shibuya109 from './buildings/shibuya109.js';
import * as qfront from './buildings/qfront.js';
import { createInteriors } from './buildings/interiors.js';
import * as magnet from './buildings/magnet.js';
import * as ekimaeBldg from './buildings/ekimaeBldg.js';
import * as scrambleSquare from './buildings/scrambleSquare.js';
import * as hikarie from './buildings/hikarie.js';
import * as station from './buildings/station.js';
import * as markCity from './buildings/markCity.js';
import * as parco from './buildings/parco.js';
import * as modi from './buildings/marui.js';
import * as towerRecord from './buildings/towerRecord.js';
import * as loft from './buildings/loft.js';
import * as seibu from './buildings/seibu.js';
import * as miyashitaPark from './buildings/miyashitaPark.js';
import * as fukuras from './buildings/fukuras.js';
import * as stream from './buildings/stream.js';
import * as nonbei from './buildings/nonbei.js';
import * as centerGai from './buildings/centerGai.js';
import * as hachiko from './buildings/hachiko.js';
import * as smallLandmarks from './buildings/smallLandmarks.js';
import { buildRedevelopment } from './buildings/bunkamura.js';
import { dressRetail } from './buildings/retailFronts.js';
import { buildWestExit } from './buildings/westExit.js';
import { buildEastExit } from './buildings/eastExit.js';
import { buildUnderTrack } from './buildings/underTrack.js';
import { SHOP_TENANTS } from './buildings/tenantsData.js';
import { tickEscalators } from './buildings/escalator.js';
import { PRESETS as SHOT_PRESETS } from '../debug/shots.js';
import { buildDogenzaka, corridorFootprints } from './buildings/dogenzaka.js';
import * as DG from './dogenzakaData.js';
import {buildKojiStreet} from './buildings/koji.js';
import {buildScope} from './buildings/scope.js';
import {buildUpperWest} from './buildings/upperWest.js';

// Showpiece framings owned by the city (docs/reports/city.md, integration request to foundation): the built-in
// 'hachiko' looked 53° past the statue, 'centergai' stood 11 m off the street with the gate behind it. Replaced
// at module load, before applyParams() reads them. hachiko: the statue near front-on from the station side with
// 渋谷駅前ビル, 109, the センター街 gate and Q-FRONT's screen behind it; centergai: from the crossing corner at
// 2.5 m (over the waiting crowd's heads), the gate spanning the canyon.
Object.assign(SHOT_PRESETS, {
  hachiko: () => ({ pos: [14.0, 1.6, 49.5], lookAt: [2.0, 3.5, 40.5] }),   // (the statue at OSM [8.0, 46.5], facing the ハチ公口 gates)
  centergai: () => ({ pos: [-13.5, 2.5, -9.5], lookAt: [-42, 6.5, -52] }),
});

const WORLD = 400;   // metres across the 512 px minimap (hud.js assumes this)
const BUILDERS = {
  shibuya109, qfront, magnet, ekimaeBldg, scrambleSquare, hikarie, station, markCity, parco, modi, towerRecord, loft,
  seibu, seibuB: seibu, miyashitaPark, fukuras, stream, sakuraStage: stream, nonbei, centerGaiGate: centerGai,
  hachikoStatue: hachiko, moyai: smallLandmarks, udagawaKoban: smallLandmarks,
};
const ALIASES = { centerGai: 'centerGaiGate', marui: 'modi', hachiko: 'hachikoStatue' };

export function nightFactorFor(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 7 && h <= 17) return 0;
  if (h >= 19 || h <= 5) return 1;
  if (h > 17) return (h - 17) / 2;
  return 1 - (h - 5) / 2;
}
export const offsetPolyline = L.offsetPolyline;

const gy = (x, z) => groundY(x, z);
/** Lowest / highest terrain height over a footprint (edges sampled every ≤3 m, + centroid, + an optional drum). */
function siteLevels(poly, cyl = null) {
  let lo = Infinity, hi = -Infinity;
  const probe = (x, z) => { const y = groundY(x, z); if (y < lo) lo = y; if (y > hi) hi = y; };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], k = Math.max(1, Math.ceil(segLen(a, b) / 3));
    for (let t = 0; t < k; t++) probe(a[0] + (b[0] - a[0]) * t / k, a[1] + (b[1] - a[1]) * t / k);
  }
  const c = L.polyCentroid(poly); probe(c[0], c[1]);
  if (cyl) for (let t = 0; t < 24; t++) probe(cyl.center[0] + Math.cos(t * Math.PI / 12) * cyl.radius, cyl.center[1] + Math.sin(t * Math.PI / 12) * cyl.radius);
  return { lo, hi };
}
/** Raise a builder's outputs (colliders, facades, billboards pushed since `nb0`) to a sloped site's base level. */
function liftBuilt(r, billboards, nb0, dy) {
  if (!dy) return;
  for (const col of r.colliders || []) {
    if (col.obb) col.obb.center.y += dy;
    else if (col.isBox3 || (col.min && col.max)) { col.min.y += dy; col.max.y += dy; }
  }
  for (const f of r.facades || []) f.position.y += dy;
  for (let i = nb0; i < billboards.length; i++) billboards[i].position.y += dy;
}
function segLen(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
function lerp2(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

const city = {
  name: 'city',
  landmarks: {},
  facades: [],
  billboards: [],
  // street-vista terminators (a sign-heavy lot closing a framed street view): { position (face bottom-centre),
  // normal, width, height, buildingId } — signage can crowd them with its tallest blade / roof boards
  vistaAnchors: {},
  roads: [],
  lanes: [],
  crowdPaths: [],
  crossing: { center: CITY.crossing.center, radius: CITY.crossing.radius, corners: Object.values(CITY.crossing.corners) },
  plazas: CITY.plazas,
  plan: null,
  group: null,
  field: null,
  buildingCount: 0,
  minimapCanvas: null,
  data: CITY,

  async init(engine) {
    this.engine = engine;
    const t0 = performance.now();
    const materials = engine.get('materials');
    const world = engine.world;
    const rng = engine.rng.fork(101);
    const group = new THREE.Group(); group.name = 'city';
    this.group = group;
    engine.scene.add(group);
    const batch = new L.GeoBatch({ chunk: 240 });
    const inst = new L.Instancer({ chunk: 240 });
    const ctx = { engine, CITY, materials, rng, batch, inst, world, group, pools: CITY.tenantPools, facades: this.facades, billboards: this.billboards, yAt: groundY, groundRel: null };
    // physics ground = terrain (道玄坂 / 文化村通り slopes) + the sidewalk slab (set by buildStreets)
    world.groundBase = (x,z)=>accessHeight(x,z,groundY(x,z));
    this.ctx = ctx;
    { const ta = performance.now(); getAtlases(); console.info(`[city] atlases ${(performance.now() - ta).toFixed(0)} ms`); }
    S.useBatch(batch);
    setNightFactor(nightFactorFor(engine.time.hour));
    L.setNight(nightFactorFor(engine.time.hour));
    setLandmarkNight(nightFactorFor(engine.time.hour));

    // ---- streets
    const streets = buildStreets({ CITY, batch, inst, world, yAt: ctx.yAt, rng: rng.fork(3), group, materials });
    this.field = streets.field;
    ctx.field = streets.field;
    ctx.isStreetSide = (x, z) => streets.field.sample(x, z) < 6.5 || nearPedestrianStreet(x, z);
    // fire escapes only where a street camera sees them: over a pavement or a pedestrian lane, never a carriageway
    ctx.stairOk = (x, z) => { const f = streets.field.sample(x, z); return f > 0.3 && (f < 6.5 || nearPedestrianStreet(x, z)); };
    batch.noShadow.add(getAtlases().plinth);
    setWetFactor(engine.time.wet ?? 1);

    // ---- infill blocks
    cgCursor = 0;
    const plan = this.plan = { buildings: [], landmarks: {} };
    let nB = 0;
    // pass 15: the blocks after the corridor-affected ones keep the rng stream they had (their lot counts changed with
    // the re-laid 道玄坂), and no square lot stands on the corridor's real frontage (corridorDrop)
    const dropped = [];
    for (const blk of CITY.blocks) {
      if (blk.seedBase != null) nB = blk.seedBase;
      const lots = packBlock(blk, rng.fork(nB * 13 + 5), ctx);
      if (blk.id === 'bunkamura_n' || blk.id === 'dogenzaka_w1') {
        for (const lot of lots) {
          if (['bunkamura_n_0','bunkamura_n_9'].includes(lot.id)) lot.retail = 'discount';
          if (['dogenzaka_w1_9','dogenzaka_w1_10'].includes(lot.id)) lot.retail = 'electronics';
          if (lot.retail) {
            lot.storeys = 7; lot.gf = 4; lot.sh = 3.5;
            lot.groundFloor = 'wall'; lot.noRoofClutter = true; lot.noStairs = true;
            lot.setback = false; lot.bigBoard = 0;
            lot.faces = lot.poly.map(() => ({kind:'blind',tenants:[]}));
          }
        }
      }
      for (const lot of lots) {
        if (corridorDrop(lot.poly)) { dropped.push(lot.id); if (!lot.extra) nB++; continue; }
        if (L.pointInPoly(CG_VISTA.at[0], CG_VISTA.at[1], lot.poly)) cgVistaLot(lot);
        // on the slope a building stands on the LOWEST point of its footprint (never floating); the ground floor
        // steps up with the pavement (granite sills, genericBuilding groundRel) so nothing reads as buried
        const lv = siteLevels(lot.poly);
        const nb0 = this.billboards.length;
        batch.lift = inst.lift = lv.lo;
        const cen = L.polyCentroid(lot.poly);
        const spec = { ...lot, roofGlow: Math.hypot(cen[0], cen[1]) < 150, ...(lv.hi > lv.lo + 0.02 ? { groundRel: (x, z) => groundY(x, z) - lv.lo } : {}) };
        // a pencil lot split off a wide センター街 lot (packBlock) draws its own fork and does not advance nB, so every
        // other block keeps the layout it had
        const r = buildBuilding(spec, { batch, inst, rng: rng.fork(lot.extra ? nB * 7 + 7919 + lot.extra : nB * 7 + 11), pools: CITY.tenantPools, billboards: this.billboards, stairOk: ctx.stairOk, CITY });
        batch.lift = inst.lift = 0;
        liftBuilt(r, this.billboards, nb0, lv.lo);
        if (lot.retail) { dressRetail({batch,group},lot,r.height,lv.lo); r.facades.length=0; this.billboards.splice(nb0); }
        for (const col of r.colliders) world.addStatic(col, { tag: 'building' });
        this.facades.push(...r.facades);
        plan.buildings.push({ poly: lot.poly, h: r.height, base: lv.lo, id: lot.id, style: lot.style, storeys: lot.storeys });
        if (lot.vista) {
          const f = r.facades.find(q => q.id === `${lot.id}:f${lot.boardFace}`);
          if (f) {
            this.vistaAnchors.centergai = { buildingId: lot.id, position: f.position.clone(), normal: f.normal.clone(), width: f.width, height: r.height };
            // the terminator's own tenant signs: a tall vertical board down one side, lit floor boards across 3–5F
            const P = f.position, N = f.normal, tx = N.z, tz = -N.x, W = f.width, vh = Math.min(15, r.height - r.gf - 3);
            S.flatSign(group, P.x - tx * W * 0.32 + N.x * 0.3, lv.lo + r.gf + 0.8 + vh / 2, P.z - tz * W * 0.32 + N.z * 0.3, N.x, N.z, { text: 'カラオケ舘', w: Math.min(1.6, W * 0.22), h: vh, bg: '#c8102e', fg: '#ffffff', vertical: true, emissive: 1.0, weight: '900' });
            [['まんが喫茶 ・ ダーツ', '3F  24H OPEN', '#1a56b8'], ['焼肉 食べ放題', '4F  ¥2,980〜', '#101010'], ['BAR & LOUNGE', '5F  SHIBUYA-CHO', '#3a1050']].forEach(([t, sub, bg], k) => {
              const y = lv.lo + r.gf + (k + 1) * 3.3 - 0.6;
              S.flatSign(group, P.x + tx * W * 0.14 + N.x * 0.25, y, P.z + tz * W * 0.14 + N.z * 0.25, N.x, N.z, { text: t, sub, w: W * 0.58, h: 1.05, bg, fg: '#ffe9a0', emissive: 0.95, weight: '800' });
            });
          }
        }
        if (!lot.extra) nB++; else this.extraLots = (this.extraLots || 0) + 1;
      }
    }
    // the top of 文化村通り: the 東急本店 site under redevelopment closes the vista
    try {
      const r = vistaRoads(CITY).find(q => q.id === 'bunkamura'), p = r.path, a = p[p.length - 2], b = p[p.length - 1], l = segLen(a, b);
      const dx = (b[0] - a[0]) / l, dz = (b[1] - a[1]) / l, cx = b[0] + dx * 24, cz = b[1] + dz * 24;
      if (!CITY.scope) buildRedevelopment({ batch, inst, group }, cx, cz, dx, dz, groundY(cx, cz));
    } catch (e) { console.error('[city] redevelopment', e); }
    // backdrop beyond the map edge along the roads that climb out of it (道玄坂上 / 文化村通り): real infill lots on
    // both sides of the extended carriageway so the vista up the hill is a street, not a void. No colliders (they
    // stand behind the bounds wall).
    batch.clampX = -279;
    for (const r of vistaRoads(CITY).filter(q => q.vista && !CITY.scope)) {
      if (VISTA_SEED[r.id] != null) nB = VISTA_SEED[r.id];
      const p = r.path, a = p[p.length - 2], b = p[p.length - 1], l = segLen(a, b);
      const ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l;
      const off0 = r.width / 2 + r.sidewalk + 0.4, off1 = off0 + 17;
      for (const side of [1, -1]) {
        const q = (t, o) => [a[0] + ux * t - uz * o * side, a[1] + uz * t + ux * o * side];
        const blk = { id: `vista_${r.id}_${side > 0 ? 'l' : 'r'}`, polygon: [q(3, off0), q(l, off0), q(l, off1), q(3, off1)], style: side > 0 ? 'tenant' : 'hotel', minStoreys: 4, maxStoreys: 9, facadeTenants: VISTA_TENANTS[r.id] || [] };
        for (const lot of packBlock(blk, rng.fork(nB * 13 + 5), ctx)) {
          const lv = siteLevels(lot.poly);
          batch.lift = inst.lift = lv.lo;
          const r2 = buildBuilding(lv.hi > lv.lo + 0.02 ? { ...lot, groundRel: (x, z) => groundY(x, z) - lv.lo } : lot, { batch, inst, rng: rng.fork(nB * 7 + 11), pools: CITY.tenantPools, billboards: [], stairOk: ctx.stairOk, CITY });
          batch.lift = inst.lift = 0;
          r2.facades.forEach(f => { f.position.y += lv.lo; });
          this.facades.push(...r2.facades);
          nB++;
        }
      }
    }
    batch.clampX = null;
    this.buildingCount = nB;
    this.corridorDropped = dropped;
    // ---- the 道玄坂 corridor (pass 15): real buildings, the yard, 道玄坂上交番, 首都高 / 玉川通り, street furniture
    try {
      const r = buildDogenzaka({ ...ctx, rng: rng.fork(9001) });
      for (const [c, tag] of r.colliders) world.addStatic(c, { tag });
      this.facades.push(...r.facades);
      plan.buildings.push(...r.plan);
      this.corridor = r;
      console.info(`[city] 道玄坂 corridor: ${r.stats.buildings} buildings, ${r.stats.works} works, ${r.stats.trees} trees, ${r.stats.signs} signs, ${r.signals ? r.signals.heads.length : 0} signal heads, ${r.colliders.length} colliders, ${dropped.length} square lots dropped, ${r.stats.ms} ms, sign atlas ${JSON.stringify(S.signAtlasStats().map((q) => +q.used.toFixed(3)))}`);
    } catch (e) { console.error('[city] dogenzaka corridor failed', e); }
    const expanded = buildScope({...ctx, rng: rng.fork(9401)});
    const upperWest = buildUpperWest(ctx);
    plan.buildings.push(...upperWest.plan);
    this.facades.push(...upperWest.facades);
    buildKojiStreet(ctx);
    plan.buildings.push(...expanded.plan);
    this.facades.push(...expanded.facades);
    this.scopeStats = expanded.stats;
    console.info(`[city] scope expansion: ${expanded.stats.buildings} buildings`);
    // ?citypick=x,z[;x,z…]: which infill lots stand at those points (framing / dressing work)
    if (engine.params && engine.params.raw && engine.params.raw.citypick) for (const q of String(engine.params.raw.citypick).split(';')) {
      const [x, z] = q.split(',').map(Number);
      const hit = plan.buildings.filter(b => L.pointInPoly(x, z, b.poly)).map(b => `${b.id} ${b.style} ${b.storeys}F h${b.h.toFixed(1)}`);
      console.info(`[city pick] ${x},${z}: ${hit.join(' | ') || '-'}`);
    }

    // ---- landmarks
    for (const [key, data] of Object.entries(CITY.landmarks)) {
      const mod = BUILDERS[key];
      const position = new THREE.Vector3(data.pos[0], 0, data.pos[1]);
      const size = new THREE.Vector3(data.size[0], data.size[1], data.size[2]);
      let built = null;
      // landmarks on the slope (109) stand on the lowest point of their footprint like the infill
      const fp = data.polygon || L.rectPoly(data.pos[0], data.pos[1], data.size[0], data.size[2], data.rotY || 0);
      const lv = siteLevels(fp, data.cylinder);
      position.y = lv.lo;
      const nb0 = this.billboards.length, nc0 = group.children.length;
      batch.lift = inst.lift = lv.lo;
      ctx.groundRel = lv.hi > lv.lo + 0.02 ? (x, z) => groundY(x, z) - lv.lo : null;
      try {
        if (mod && typeof mod.build === 'function' && (!mod.KEYS || mod.KEYS.includes(key))) {
          built = mod.build({ key, data, ...ctx, rng: rng.fork(key.length * 31 + 7) });
        }
      } catch (e) { console.error(`[city] landmark ${key} failed, using generic massing`, e); built = null; }
      if (!built) built = genericLandmark(key, data, ctx, rng.fork(key.length * 5));
      batch.lift = inst.lift = 0; ctx.groundRel = null;
      for (let i = nc0; i < group.children.length; i++) group.children[i].position.y += lv.lo;   // unbatched signs (wrapSign)
      liftBuilt(built, this.billboards, nb0, lv.lo);
      const g = built.group || new THREE.Group();
      g.name = key;
      // builders batch their geometry in world space; the group only carries signage anchors (+ unbatched signs):
      // its origin defaults to the landmark pos, `origin` overrides it (109: drum centre), `rotation` = group yaw
      if (built.origin) g.position.set(built.origin[0], 0, built.origin[1]); else if (!built.worldSpace) g.position.copy(position);
      g.position.y = lv.lo;
      if (built.rotation) g.rotation.y = built.rotation;
      if (!g.parent) group.add(g);
      for (const col of built.colliders || []) world.addStatic(col, { tag: key });
      for (const l of built.lights || []) { l.position.y += lv.lo; group.add(l); }
      if (built.facades) this.facades.push(...built.facades);
      this.landmarks[key] = { position, size, group: g, anchors: built.anchors || {}, label: data.name, data, storeys: data.storeys };
      plan.landmarks[key] = data;
    }
    for (const [alias, key] of Object.entries(ALIASES)) if (this.landmarks[key]) this.landmarks[alias] = this.landmarks[key];
    // the real tenants that ARE a landmark (its own sign carries the name): counted as shown
    for (const [key, re] of [['qfront', /Q-FRONT|TSUTAYU|STARBEANS/], ['magnet', /MAGNET/], ['seibu', /西部|SEIBO/], ['seibuB', /西部|SEIBO/], ['loft', /LOFTY/], ['parco', /PALCO|as-is, public/], ['modi', /MOD1/], ['towerRecord', /TOWER RECORD/], ['shibuya109', /1O9/]]) {
      const l = CITY.landmarks[key]; if (l) markTenantShown(re, l.pos, 45);
    }

    // ---- 西口 bus terminal (islands, canopies, のりば, kerb shelters, guard pipes) + the 渋谷駅街区 construction yard
    try { const r = buildWestExit(ctx); for (const col of r.colliders) world.addStatic(col, { tag: 'westExit' }); } catch (e) { console.error('[city] west exit failed', e); }
    // ---- 東口 bus terminal (のりば poles, queues, canopies, the disused island, 地下広場 entrances, the 2F deck)
    try { const r = buildEastExit(ctx); for (const col of r.colliders) world.addStatic(col, { tag: 'eastExit' }); } catch (e) { console.error('[city] east exit failed', e); }
    // ---- the closed railway structure under the JR viaduct north of 宮益坂 (ガード下 shops, walls, shutters)
    try { const r = buildUnderTrack(ctx); for (const col of r.colliders) world.addStatic(col, { tag: 'underTrack' }); } catch (e) { console.error('[city] under-track failed', e); }

    // ---- rail + impostors
    try { const r = buildRail(ctx); this.trains = (r && r.trains) || null; } catch (e) { console.error('[city] rail failed', e); }
    try { buildImpostors(ctx); } catch (e) { console.error('[city] impostors failed', e); }

    // ---- emit merged / instanced meshes
    const merged = batch.build(group, { name: 'city', mergeBelow: 16000 });
    const instanced = inst.build(group, { mergeBelow: 40000 });
    this.meshCount = merged.length + instanced.length;
    group.updateMatrixWorld(true);
    this.setupLod();
    // ---- real 3D shop rooms behind the nearest ground-floor fronts (the facade is opened by a depth punch)
    try {
      const raw = (engine.params && engine.params.raw) || {};
      if (raw.interiors !== '0') {
        const tc = performance.now();
        this.interiors = createInteriors({ engine, group });
        // every ground-floor shop front is solid (pass 14, 「キャラの足がうまっている」): one box from the wall to the front
        // of the display case (or just past the glass), the whole bay wide — the doors stay closed — so nobody walks
        // into a window's stone plinth or through the depth-punched opening
        let nFront = 0;
        for (const b of this.interiors.bays) {
          if (b.hallOwner) continue;                                   // Q-FRONT's drum: its outline collider is in front of the glass
          const f = Math.max(b.front || 0.09, (b.out || 0.04) + 0.05), g = groundY(b.x, b.z), top = b.y0 + Math.max(2.4, b.gh);
          const w = (b.sw || b.w + 0.6) + 0.1;
          world.addStatic({ obb: { center: new THREE.Vector3(b.x + b.nx * (f - 0.15) / 2, (g + top) / 2, b.z + b.nz * (f - 0.15) / 2), halfSize: new THREE.Vector3(w / 2, (top - g) / 2, (f + 0.15) / 2), rotationY: Math.atan2(-b.nx, -b.nz) } }, { tag: 'shopfront' });
          nFront++;
        }
        this.interiors.state.fronts = nFront;
        // for the crowd (and anyone placing people): the clearance from (x, z) to the nearest ground-floor shop front —
        // its display case or glass — in metres, negative when inside it; Infinity away from shop fronts. The crowd
        // can keep standing / waiting people at frontClear(x, z) > their radius (the player has the colliders above).
        const FG = 8, fgrid = new Map();
        for (const b of this.interiors.bays) { if (b.hallOwner) continue; const k = Math.floor(b.x / FG) + ',' + Math.floor(b.z / FG); if (!fgrid.has(k)) fgrid.set(k, []); fgrid.get(k).push(b); }
        this.frontClear = (x, z) => {
          let best = Infinity;
          const gx = Math.floor(x / FG), gz = Math.floor(z / FG);
          for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const b of fgrid.get((gx + i) + ',' + (gz + j)) || []) {
            const dx = x - b.x, dz = z - b.z, out = dx * b.nx + dz * b.nz, along = Math.abs(dx * b.nz - dz * b.nx);
            if (along > (b.sw || b.w + 0.6) / 2 || out < -1.0) continue;
            best = Math.min(best, out - Math.max(b.front || 0.09, (b.out || 0.04) + 0.05));
          }
          return best;
        };
        console.info(`[city] interiors: ${this.interiors.bays.length} ground-floor bays (${this.interiors.show.length} rooms), ${this.interiors.halls.size} halls, ${nFront} shop-front colliders (${(performance.now() - tc).toFixed(0)} ms)`);
      }
    } catch (e) { console.error('[city] interiors failed', e); }
    if (engine.params && engine.params.raw && engine.params.raw.cityprobe) this.probe = makeProbe(this, engine);

    // ---- consumer interfaces
    this.roads = CITY.roads.map(r => ({ id: r.id, name: r.name, points: r.path, width: r.width, lanes: r.lanes, sidewalk: r.sidewalk, scope: !!r.scope, pedestrian: !!r.pedestrian }))
      .concat(CITY.pedestrianStreets.map(p => ({ id: p.id, name: p.name, points: p.path, width: p.width, pedestrian: true })));
    this.lanes = buildLanes();
    this.crowdPaths = buildCrowdPaths(ctx);
    plan.lanes = this.lanes; plan.crowdPaths = this.crowdPaths;

    // world bounds so nobody walks off the map: the square's walls, open where the 道玄坂 corridor leaves it, and the
    // corridor's own walls along its outline outside the square (pass 15)
    const B = CITY.bounds / 2 + 10;
    const corr = CITY.corridor && CITY.corridor.outline;
    if (!CITY.scope) world.addStatic(new THREE.Box3(new THREE.Vector3(-B - 30, 0, -B - 30), new THREE.Vector3(B + 30, 60, -B)), { tag: 'bounds' });
    if (!CITY.scope) world.addStatic(new THREE.Box3(new THREE.Vector3(B, 0, -B - 30), new THREE.Vector3(B + 30, 60, B + 30)), { tag: 'bounds' });
    const inSq = (x, z) => Math.abs(x) < B && Math.abs(z) < B;
    let nWall = 0;
    const wallRun = (a, b, keep) => {
      const len = segLen(a, b), n = Math.max(1, Math.ceil(len / 2)), tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
      let s0 = -1;
      const flush = (s1) => {
        if (s0 < 0) return;
        const u0 = s0 * len / n, u1 = s1 * len / n, mx = a[0] + tx * (u0 + u1) / 2, mz = a[1] + tz * (u0 + u1) / 2;
        const y0 = Math.min(groundY(a[0] + tx * u0, a[1] + tz * u0), groundY(a[0] + tx * u1, a[1] + tz * u1)) - 2;
        world.addStatic({ obb: { center: new THREE.Vector3(mx, y0 + 40, mz), halfSize: new THREE.Vector3((u1 - u0) / 2 + 1, 40, 1.5), rotationY: Math.atan2(-tz, tx) } }, { tag: 'bounds' });
        nWall++; s0 = -1;
      };
      for (let k = 0; k < n; k++) { const t = (k + 0.5) / n, ok = keep(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t); if (ok && s0 < 0) s0 = k; if (!ok) flush(k); }
      flush(n);
    };
    const notCorr = (x, z) => !(corr && L.pointInPoly(x, z, corr));
    if (!CITY.scope) wallRun([-B, B], [B, B], notCorr);                                 // south
    if (!CITY.scope) wallRun([-B, -B], [-B, B], notCorr);                               // west: open where the corridor passes
    if (!CITY.scope && corr) for (let i = 0; i < corr.length; i++) wallRun(corr[i], corr[(i + 1) % corr.length], (x, z) => !inSq(x - Math.sign(x) * 0.5, z));
    if (CITY.scope) {
      const outline = L.offsetPolygon(L.ensureCW(CITY.scope.outline), 8);
      for (let i = 0; i < outline.length; i++) wallRun(outline[i], outline[(i+1)%outline.length], () => true);
    }
    this.boundsWalls = nWall;

    let tris = 0;
    group.traverse(m => { if (m.isMesh && m.geometry) { const g = m.geometry; const n = (g.index ? g.index.count : g.attributes.position.count) / 3; tris += m.isInstancedMesh ? n * m.count : n; } });
    this.triangles = Math.round(tris);
    console.info(`[city] ${nB} infill buildings, ${Object.keys(CITY.landmarks).length} landmarks, ${this.facades.length} facades, ${this.meshCount} meshes, ${this.triangles} tris, ${WINDOW_STATS.units} window units, fascia ${getAtlases().fascia.n}/${getAtlases().fascia.cols * getAtlases().fascia.rows}, real tenants ${JSON.stringify(tenantStats())}, ${world.statics.length} colliders, ${(performance.now() - t0).toFixed(0)} ms (streets ${streets.ms.toFixed(0)} ms)`);
  },

  update(dt) {
    if (!this.engine) return;
    tickEscalators(Math.min(dt || 0, 1 / 20));
    // trains keep running while a ?shot preset holds the rest of the world still: a frozen train is the
    // one thing in a station frame that reads as broken.
    if (this.trains) for (const t of this.trains) t.update(Math.min(dt || 0, 1 / 20));
    this._t = (this._t || 0) + (dt || 0); tickBlink(this._t);
    this.updateLod();
    if (this.interiors) this.interiors.update();
    if (this.corridor && this.corridor.update) this.corridor.update(this.engine);
    if (this.probe) this.probe.tick();
    const f = nightFactorFor(this.engine.time.hour), wet = this.engine.time.wet ?? 1;
    if (Math.abs(f - this._night) > 1e-3) { this._night = f; setNightFactor(f); L.setNight(f); setLandmarkNight(f); if (this.interiors) this.interiors.setNight(f); }   // ~150 materials: only touch them on change
    if (Math.abs(wet - this._wet) > 1e-3) { this._wet = wet; setWetFactor(wet); }
  },
  _night: -1,
  _wet: -1,

  /**
   * Distance LOD for the merged / instanced city meshes (each is one 240 m chunk of one material or part): small
   * non-emissive detail (AC units, rails, tanks, pipes, stairs, balconies, awnings, lattice…) is dropped beyond 150 m
   * and every city mesh stops casting shadows beyond 80 m. Re-evaluated when the camera moves > 4 m.
   */
  setupLod() {
    // small wall / street detail goes at 150 m; the roof-silhouette parts (tanks, antennas, big condensers, board
    // frames) stay to 400 m so the skyline keeps its clutter
    const DETAIL = /^inst:(balcony|ac|pipe|stair|awning|roofRail|ladder|grate|hedge|lm_railpost|lm_post|lm_mullion|lm_fin|lm_louvre|sleeper|lm_bench|lm_bollard|lm_planter)[:$]|^city:(gb_trim|gb_pipe|gb_stair|gb_plinth|gb_metal|gb_ac|lm_wood|lm_hedge)$/;
    const ROOF = /^inst:(acBig|tank|antenna|bbframe)[:$]|^city:gb_tank$/;
    this.lod = [];
    const sph = new THREE.Sphere();
    for (const m of this.group.children) {
      if (!m.isMesh || !m.geometry) continue;
      // an InstancedMesh is measured over its instances (its base geometry's sphere sits at the origin: every
      // per-chunk detail family was culled whenever the camera was 150 m from the crossing)
      if (m.isInstancedMesh) { m.computeBoundingSphere(); sph.copy(m.boundingSphere).applyMatrix4(m.matrixWorld); }
      else { if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere(); sph.copy(m.geometry.boundingSphere).applyMatrix4(m.matrixWorld); }
      this.lod.push({ m, c: sph.center.clone(), r: sph.radius, detail: DETAIL.test(m.name) ? 150 : ROOF.test(m.name) ? 400 : 0, cast: m.castShadow });
    }
    this._lodAt = null;
  },
  updateLod() {
    if (!this.lod) return;
    const cam = this.engine.camera.position;
    if (this._lodAt && this._lodAt.distanceToSquared(cam) < 16) return;
    this._lodAt = (this._lodAt || new THREE.Vector3()).copy(cam);
    for (const e of this.lod) {
      const d = e.c.distanceTo(cam) - e.r;
      if (e.detail) e.m.visible = d < e.detail;
      if (e.cast) e.m.castShadow = d < 80;
    }
  },

  getSpawnPoints() {
    const sp = CITY.spawns;
    const dirYaw = (rotY) => Math.atan2(Math.cos(rotY), -Math.sin(rotY));   // cityData rotY → player yaw (0 faces +z)
    const player = { position: new THREE.Vector3(sp.player.pos[0], SW_H + groundY(sp.player.pos[0], sp.player.pos[1]), sp.player.pos[1]), yaw: dirYaw(sp.player.rotY) };
    const enemies = sp.fight_intro.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const safe = [new THREE.Vector3(-4, 0, -2), new THREE.Vector3(-45, SW_H, -50), new THREE.Vector3(26, SW_H, 34)];
    return { player, enemies, safe };
  },

  worldToMinimap(x, z) { const s = 512 / WORLD; return [(x + WORLD / 2) * s, (z + WORLD / 2) * s]; },

  getMinimap() {
    if (this.minimapCanvas) return this.minimapCanvas;
    const c = document.createElement('canvas'); c.width = 512; c.height = 512;
    const ctx = c.getContext('2d');
    const s = 512 / WORLD;
    const T = (x, z) => [(x + WORLD / 2) * s, (z + WORLD / 2) * s];
    const poly = (pts, fill, stroke) => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = T(p[0], p[1]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); } };
    const line = (pts, w, col, dash = null) => { ctx.lineWidth = w * s; ctx.strokeStyle = col; ctx.setLineDash(dash || []); ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = T(p[0], p[1]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); ctx.setLineDash([]); };
    ctx.fillStyle = '#3a3b40'; ctx.fillRect(0, 0, 512, 512);                     // sidewalk level
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const r of CITY.roads) line(r.path, r.width, '#1e1f24');
    ctx.fillStyle = '#1e1f24'; const [cx, cy] = T(CITY.crossing.center[0], CITY.crossing.center[1]); ctx.beginPath(); ctx.arc(cx, cy, CITY.crossing.radius * s, 0, Math.PI * 2); ctx.fill();
    for (const p of CITY.pedestrianStreets) line(p.path, p.width, '#4a463c');
    for (const p of CITY.plazas) poly(p.polygon, '#474a44', null);
    for (const r of CITY.busways || []) line(r.path, r.width, '#26272c');
    for (const a of CITY.aprons || []) poly(a.polygon, '#26272c', null);          // terminal aprons (東口 waiting area)
    for (const i of CITY.raised || []) poly(i.polygon, '#3a3b40', null);           // …and the islands standing on them
    for (const s of CITY.sites || []) poly(s.polygon, '#56575c', '#8a8a80');
    for (const b of this.plan ? this.plan.buildings : []) poly(b.poly, '#63646a', null);
    for (const [key, l] of Object.entries(CITY.landmarks)) {
      const pts = l.polygon || L.rectPoly(l.pos[0], l.pos[1], l.size[0], l.size[2], l.rotY);
      poly(pts, l.size[1] >= 100 ? '#8a8fa0' : '#7d7e86', null);
      if (l.cylinder) { const [x, y] = T(l.cylinder.center[0], l.cylinder.center[1]); ctx.fillStyle = '#9a9aa2'; ctx.beginPath(); ctx.arc(x, y, l.cylinder.radius * s, 0, Math.PI * 2); ctx.fill(); }
      void key;
    }
    for (const [id, r] of Object.entries(CITY.rail)) line(r.path, id === 'jr' ? r.width : r.width, id === 'jr' ? 'rgba(70,110,80,0.75)' : 'rgba(200,140,40,0.6)');
    ctx.globalAlpha = 0.7;
    for (const cw of [...CITY.crossing.crosswalks, ...CITY.crossing.diagonals]) line([cw.a, cw.b], cw.width, '#d8d8d8', [3, 3]);
    for (const cw of CITY.crosswalksExtra) line([cw.a, cw.b], cw.width, '#c8c8c8', [2, 2]);
    ctx.globalAlpha = 1;
    // labels
    ctx.font = 'bold 11px "Hiragino Sans", "Noto Sans JP", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.fillStyle = '#f2e6c0';
    const labelled = ['shibuya109', 'qfront', 'scrambleSquare', 'hikarie', 'station', 'markCity', 'parco', 'modi', 'towerRecord', 'loft', 'seibu', 'miyashitaPark', 'fukuras', 'stream', 'magnet', 'nonbei'];
    for (const key of labelled) { const l = CITY.landmarks[key]; if (!l) continue; const cpt = l.polygon ? L.polyCentroid(l.polygon) : l.pos; const [x, y] = T(cpt[0], cpt[1]); ctx.fillText(l.name.replace(/ \/.*$/, ''), x, y); }
    ctx.fillStyle = '#ffd24a'; const [hx, hy] = T(26, 24); ctx.fillText('ハチ公', hx, hy + 12);
    ctx.font = '10px "Hiragino Sans", "Noto Sans JP", sans-serif'; ctx.fillStyle = '#cfd6e0';
    for (const r of CITY.roads) {
      const i = Math.floor(r.path.length / 2) - 1; if (i < 0) continue;
      const a = r.path[i], b = r.path[i + 1]; const mid = lerp2(a, b, 0.5); const [x, y] = T(mid[0], mid[1]);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.abs(ang) > Math.PI / 2 ? ang + Math.PI : ang); ctx.fillText(r.name, 0, 0); ctx.restore();
    }
    ctx.shadowBlur = 0;
    this.minimapCanvas = c;
    return c;
  },

  selfTest() {
    return { buildings: this.buildingCount, landmarks: Object.keys(CITY.landmarks).length, facades: this.facades.length, meshes: this.meshCount, triangles: this.triangles, lanes: this.lanes.length, crowdPaths: this.crowdPaths.length, colliders: this.engine.world.statics.length };
  },

  shotPresets: {
    city_centergai:  { pos: [-23, 1.6, -13], lookAt: [-60, 5, -60] },
    city_109_apex:   { pos: [-100, 2.0, 4], lookAt: [-150, 22, -10] },
    city_aerial_w:   { pos: [-60, 160, 140], lookAt: [-60, 0, -40], fov: 50 },
    city_miyashita:  { pos: [148, 2, -98], lookAt: [116, 14, -172], fov: 55 },
    city_nonbei:     { pos: [82, 1.6, -30], lookAt: [82, 3, -70], fov: 55 },
    city_nonbei_lane: { pos: [86, 1.6, -40], lookAt: [86, 2.4, -76], fov: 60 },
    city_markcity:   { pos: [-28, 1.8, 50], lookAt: [-120, 28, 100], fov: 55 },
    city_koen:       { pos: [12, 1.7, -35], lookAt: [8, 20, -190], fov: 50 },
    city_station_e:  { pos: [110, 4, 10], lookAt: [70, 30, 80], fov: 55 },
    city_day_overview: { pos: [0, 220, 220], lookAt: [0, 0, 0], fov: 45, t: 'day' },
    city_day_109:    { pos: [-12, 1.7, 6], lookAt: [-140, 16, -8], t: 'day' },
    city_qfront_s:   { pos: [-2, 1.7, 14], lookAt: [-16, 16, -36], fov: 55 },
    city_hachiko_exit: { pos: [12, 1.7, 30], lookAt: [42, 8, 22], fov: 55 },
    city_scramble_sq: { pos: [-30, 1.7, 40], lookAt: [137, 120, 119], fov: 60 },
    city_hikarie:    { pos: [120, 1.7, -10], lookAt: [200, 90, 46], fov: 55 },
    city_seibu:      { pos: [17, 1.7, -56], lookAt: [-26, 12, -90], fov: 55 },
    city_parco:      { pos: [-92, 2, -213], lookAt: [-168, 44, -198], fov: 55 },
    city_towerrec:   { pos: [8, 1.7, -160], lookAt: [48, 20, -204], fov: 55 },
    city_aerial_e:   { pos: [200, 150, 140], lookAt: [60, 0, 20], fov: 50 },
    city_hachiko_statue: { pos: [11.9, 2.7, 45.3], lookAt: [8.0, 1.8, 46.6], fov: 50 },
    city_gate:       { pos: [-14, 1.6, -6], lookAt: [-30, 6, -34], fov: 55 },
    city_moyai:      { pos: [-25, 1.6, 133], lookAt: [-32, 1.6, 140], fov: 50 },
    scope_overview: { pos: [-265, 920, 240], lookAt: [-265, 0, 40], fov: 62, t: 'day' },
    scope_shinsen: () => ({pos:[-658,gy(-658,232)+1.8,232],lookAt:[-647.6,gy(-647.6,250.5)+2,250.5],fov:65,t:'day'}),
    scope_maruyama: () => ({pos:[-463.8,gy(-463.8,82)+1.8,82],lookAt:[-462.9,gy(-462.9,106.2)+2,106.2],fov:65,t:'day'}),
    scope_north: () => ({pos:[-253,gy(-253,-259.4)+1.8,-259.4],lookAt:[-290,gy(-290,-263)+2,-263],fov:60,t:'day'}),
    city_dogenzaka:  { pos: [-58, 1.7, -4], lookAt: [-175, 22, 24], fov: 55 },
    city_koban_w:    { pos: [-192, 1.6, -138], lookAt: [-204, 3, -150], fov: 55 },
    city_dbg_mouth:  { pos: [-34, 22, -10], lookAt: [-42, 0, -36], fov: 60 },
    city_centergai_mid: { pos: [-58, 1.6, -57], lookAt: [-112, 5, -75], fov: 55 },
    city_centergai_mouth: { pos: [-15, 1.65, -12], lookAt: [-44, 6, -54], fov: 55 },
    city_centergai_west: { pos: [-110, 1.65, -73], lookAt: [-170, 5, -98], fov: 55 },
    city_centergai_back: { pos: [-120, 1.6, -78], lookAt: [-40, 5, -46], fov: 55 },
    city_bunkamura:  ({ engine }) => ({ pos: [-128, 1.7 + gy(-128, -21), -21], lookAt: [-200, 5 + gy(-200, -58), -58], fov: 55 }),
    city_bunkamura_top: ({ engine }) => ({ pos: [-208, 1.7 + gy(-208, -72), -72], lookAt: [-262, 14 + gy(-262, -148), -148], fov: 55 }),
    city_donki:      ({ engine }) => ({ pos: [-178, 1.7 + gy(-178, -40), -40], lookAt: [-190, 11 + gy(-190, -62), -62], fov: 60 }),
    city_bunkamura_back: ({ engine }) => ({ pos: [-201, 1.7 + gy(-201, -63), -63], lookAt: [-120, 4 + gy(-120, -16), -16], fov: 55 }),
    city_dogenzaka_up: ({ engine }) => ({ pos: [-114, 1.7 + gy(-114, 6), 6], lookAt: [-215, 4 + gy(-215, 40), 40], fov: 55 }),
    city_dogenzaka_down: ({ engine }) => ({ pos: [-200, 1.7 + gy(-200, 38), 38], lookAt: [-100, gy(-100, -2) + 2, -2], fov: 55 }),
    city_dogenzaka_side: ({ engine }) => ({ pos: [-150, 3 + gy(-150, 4), 4], lookAt: [-170, gy(-170, 28), 28], fov: 60 }),
    city_dogenzaka_aerial: { pos: [-128, 22, 6], lookAt: [-170, 2, 22], fov: 55 },
    city_dogenzaka_n: ({ engine }) => ({ pos: [-163, 1.7 + gy(-163, 27), 27], lookAt: [-150, gy(-150, -2) + 5, -2], fov: 60 }),
    city_109_south: ({ engine }) => ({ pos: [-170, 1.7 + gy(-170, 26), 26], lookAt: [-178, 3 + gy(-178, 6), 6], fov: 60 }),
    city_dogenzaka_shops: ({ engine }) => ({ pos: [-160, 1.7 + gy(-160, 12), 12], lookAt: [-175, 3 + gy(-175, 36), 36], fov: 60 }),
    city_dogenzaka_s: ({ engine }) => ({ pos: [-150, 1.7 + gy(-150, 4), 4], lookAt: [-175, gy(-175, 40) + 4, 40], fov: 60 }),
    city_top_centergai: { pos: [-95, 190, -62], lookAt: [-95, 0, -64], fov: 45, t: 'day' },
    city_top_cgjunction: { pos: [-78, 70, -64], lookAt: [-78, 0, -65], fov: 50, t: 'day' },
    city_top_dogenzaka: { pos: [-165, 170, 20], lookAt: [-165, 0, 18], fov: 45, t: 'day' },
    city_top_miyashita: { pos: [110, 170, -150], lookAt: [110, 0, -152], fov: 45, t: 'day' },
    city_top_ekimae: { pos: [-8, 175, 80], lookAt: [-8, 0, 78], fov: 50, t: 'day' },
    city_ekimae_s:   { pos: [1.5, 1.8, 46], lookAt: [-16, 4, 112], fov: 55 },
    city_ekimae_n:   { pos: [-24, 1.7, 110], lookAt: [-6, 4, 20], fov: 55 },
    city_ekimae_w:   { pos: [-42, 1.7, 62], lookAt: [0, 5, 100], fov: 55 },
    city_ekimae_hachiko: { pos: [18, 1.7, 50], lookAt: [-20, 4, 90], fov: 55 },
    city_miyashita_w: { pos: [84, 1.7, -112], lookAt: [92, 4, -170], fov: 55 },
    // 東口 bus terminal: from the client's play-test spot (the station side of the terminal, on the 59 pavement under the
    // 銀座線 station) across the loop toward 宮益坂下, and straight down on the whole terminal (north up) to compare with
    // the OSM plan (shots/east_bus_osm_overlay.png)
    east_bus:        { pos: [125.6, 1.7, 72.5], lookAt: [154, 5, 27], fov: 62, t: 'night' },
    // the play-test framing itself: from the 宮益坂下 corner of the 東口 広場 back over the terminal to the station
    east_bus_client: { pos: [146, 1.7, 9.5], lookAt: [108, 5, 58], fov: 60, t: 'night' },
    east_bus_aerial: { pos: [132, 165, 50.5], lookAt: [132, 0, 48], fov: 45, t: 'day' },
    east_bus_s:      { pos: [150, 1.7, 84.5], lookAt: [118, 3.5, 70], fov: 60, t: 'night' },
    city_miyashita_roof: { pos: [104, 26, -104], lookAt: [118, 16, -170], fov: 60 },
    // MIYASHITA PARK (pass 11): from the 明治通り east pavement toward the footbridge, the South block corner, the
    // grand stair in the 美竹通り passage and the North block + hotel; high oblique by day; inside 渋谷横丁
    miyashita:       { pos: [166.3, 1.7, -128], lookAt: [130, 9, -170], fov: 60, t: 'night' },
    miyashita_aerial: { pos: [156, 88, -96], lookAt: [110, 4, -172], fov: 50, t: 'day' },
    miyashita_yokocho: { pos: [85.1, 1.7, -109.5], lookAt: [85.6, 2.7, -150], fov: 64, t: 'night' },
    // 東口 block (pass 11): the JR 宮益坂口 with the relocated ハチ公改札 seen from the terminal side (the client's
    // 「この目の前は山手線の改札があるはず」), the narrow ガード下 pavement along 宮益坂 (「狭いが、通れるはず」), the space
    // under the viaduct north of 宮益坂 (「高架下ってこんなにスペースが自由にあるっけ？」), Scramble Square's 明治通り
    // frontage with the 東口 アーバン・コア and the 2F deck
    jr_east_gate:    { pos: [101, 1.7, 22.5], lookAt: [70, 2.6, 21.5], fov: 60, t: 'night' },
    jr_south_gate:   { pos: [116, 1.7, 96.5], lookAt: [96, 2.4, 95.5], fov: 62, t: 'night' },
    jr_south_aerial: { pos: [132, 26, 84], lookAt: [100, 2, 100], fov: 55, t: 'day' },
    jr_gate_inside:  { pos: [83, 1.7, 21], lookAt: [66, 1.8, 27.5], fov: 62, t: 'night' },
    miyamasu_guard:  { pos: [89, 1.7, 11.8], lookAt: [40, 2.2, 13], fov: 60, t: 'night' },
    under_track:     { pos: [79, 1.7, -3.5], lookAt: [58, 3.4, -11], fov: 62, t: 'night' },
    under_track_w:   { pos: [49.5, 1.7, -12], lookAt: [53.5, 3, -60], fov: 60, t: 'night' },
    // the client's spot (images/15.webp, [66, −12]) was on the open floor under the deck; it is now inside the closed
    // structure (unreachable, colliders solid wall to wall), so the client's line of sight is taken from the nearest
    // open ground on it, 宮益坂's south pavement under the ガード; plus an oblique down the strip beside MAGNET
    under_track_client: { pos: [66, 3.6, 12.6], lookAt: [64, 3.0, -60], fov: 60, t: 'night' },
    under_track_aerial: { pos: [30, 38, 8], lookAt: [66, 0, -40], fov: 55, t: 'day' },
    scramble_square_east: { pos: [161.8, 1.7, 118.5], lookAt: [150, 7.5, 86], fov: 62, t: 'night' },
    uc_inside:       { pos: [157.6, 1.7, 91.5], lookAt: [141, 3.6, 95], fov: 64, t: 'night' },
    deck:            { pos: [172, 8.9, 70.5], lookAt: [152, 10, 92], fov: 62, t: 'night' },
    // storefronts to reality (pass 11): 公園通り by Seibu / MAGNET, センター街 (both sides), 109's ground floor
    koen_shops:      { pos: [10, 1.7, -62], lookAt: [-4, 2.2, -70], fov: 58, t: 'night' },
    // 3D shop interiors: the client's spot at Q-FRONT's corner looking into TSUTAYU, and a konbini window from 3 m
    qfront_scramble: { pos: [0, 1.65, 0], lookAt: [-14.8, 3.0, -31.2], fov: 60, t: 'night' },   // the client's spot: the scramble's centre
    qfront_tsutayu:  { pos: [-9, 1.65, -25.5], lookAt: [-17, 2.0, -38], fov: 60, t: 'night' },
    qfront_tsutayu_w: { pos: [-22, 1.65, -27.5], lookAt: [-14, 1.8, -40], fov: 60, t: 'night' },
    // pass 12: the realigned streets — 井の頭通り past LOFT / スペイン坂 to the 宇田川交番 corner, 公園通り's corner at 神宮通り
    // and its climb to PALCO, top-downs of both (north up)
    inokashira_w:    { pos: [-128, 1.7, -136], lookAt: [-196, 4, -154], fov: 58, t: 'night' },
    inokashira_top:  { pos: [-160, 130, -140], lookAt: [-160, 0, -140.1], fov: 45, t: 'day' },
    koen_corner:     { pos: [30, 1.7, -150], lookAt: [-20, 5, -178], fov: 60, t: 'night' },
    koen_uphill:     { pos: [-20, 1.7, -178], lookAt: [-100, 6, -212], fov: 58, t: 'night' },
    koen_top:        { pos: [-45, 130, -185], lookAt: [-45, 0, -185.1], fov: 45, t: 'day' },
    tenants_cg_west: { pos: [-176, 1.7, -104], lookAt: [-208, 4, -140], fov: 58, t: 'night' },
    tenants_bunkamura_w: { pos: [-186, 1.7, -50], lookAt: [-218, 5, -70], fov: 58, t: 'night' },
    tenants_seibub:  { pos: [-10, 1.7, -165], lookAt: [-40, 3.5, -170], fov: 58, t: 'night' },
    centergai_shops: { pos: [-40, 1.65, -44], lookAt: [-96, 3.5, -72], fov: 58, t: 'night' },
    centergai_shops_w: { pos: [-100, 1.6, -70], lookAt: [-92, 2, -62], fov: 58, t: 'night' },
    shops_109:       { pos: [-122, 1.7, -6], lookAt: [-140, 3, -6], fov: 58, t: 'night' },
    // 道玄坂 corridor (pass 15): mid-slope by the 百軒店 crossing looking up past the yard's tower, 道玄坂上 past the koban
    // toward the 首都高 over 玉川通り, and 道玄坂上交番 from across the street; ?shot=dg_at&s=<m along 道玄坂 from the 109
    // fork>&side=nw|se|c&ahead=<m>[&t=day] for any spot (the walk-up frames and the comparison sheets use it)
    dogenzaka_mid: () => dgView(186, 'nw', 10.9, 135, 7, 60),
    dogenzaka_ue: () => dgView(426, 'se', 9.4, 140, 9, 60),
    koban_dogenzaka_ue: () => { const k = DG.KOBAN.pos, g = gy(k[0], k[1]), q = DG.nearestOn(DG_WALK, k[0], k[1]), [x, z, tx, tz] = DG.pointAtS(DG_WALK, q.s + 17), o = 9.2, px = x + tz * o, pz = z - tx * o; /* (tz, −tx): the マークシティ side; clear of the kerb ケヤキ */ return { pos: [px, gy(px, pz) + 1.75, pz], lookAt: [k[0], g + 3.2, k[1]], fov: 55, t: 'night' }; },
    dg_at: ({ engine }) => { const r = (engine.params && engine.params.raw) || {}; return dgView(Number(r.s || 200), r.side || 'c', r.side === 'c' || !r.side ? 0 : 9, Number(r.ahead || 60), Number(r.lift || 2), Number(r.fov || 58), r.t || null); },
    // free camera for framing work: ?shot=city_cam&cam=x,y,z,lx,ly,lz[,fov]
    city_cam: ({ engine }) => { const v = String((engine.params && engine.params.raw && engine.params.raw.cam) || '0,2,0,0,2,-10').split(',').map(Number); return { pos: v.slice(0, 3), lookAt: v.slice(3, 6), fov: v[6] || 45 }; },
  },
};

// ---------------------------------------------------------------- 道玄坂 corridor views
// the walk line: 道玄坂 from the 109 fork (s 0) to 道玄坂上; side 'nw' = the 109 / 円山町 pavement, 'se' = the マークシティ side
const DG_WALK = [...DG.DOGEN_PATH, ...DG.DOGEN_UE_PATH.slice(1)];
function dgView(s, side, off, ahead, lift, fov, t = 'night') {
  const [x, z, tx, tz] = DG.pointAtS(DG_WALK, s), o = side === 'nw' ? off : side === 'se' ? -off : 0;
  const px = x - tz * o, pz = z + tx * o;                                   // (−tz, tx) points to the north-west side here
  const [lx, lz] = DG.pointAtS(DG_WALK, Math.min(DG.pathLen(DG_WALK), s + ahead));
  return { pos: [px, gy(px, pz) + (side === 'c' ? 1.7 : 1.75), pz], lookAt: [lx, gy(lx, lz) + lift, lz], fov, t };
}

// ---------------------------------------------------------------- infill packing
// Keep-out rects no infill lot may touch: the Center-gai mouth (the chamfered 三千里薬局 corner, where foundation's
// `centergai` camera stands) and the 道玄坂 camera spot. Lots that would overlap are shortened / narrowed instead.
const VISTA_TENANTS = {
  dogenzaka: ['道玄坂上 交番前ビル', 'ラーメン 渚', '日高家', 'ファミリマート', '温野采', 'カラオケ パセリ', 'ホテル・シルキー', '道玄坂歯科', 'アパマンショプ', '立呑み 富士屋', 'ドミーイン 渋谷町', 'マツモトキヨヒ'],
  bunkamura: ['Bunkamura', 'ドン・キホーヂ', 'ブックオン', 'タリース', 'H&N', 'ゴン茶', '松家', 'カラオケ舘', '一風道', 'ABC-MARK'],
};
const KEEP_OUT = [{ x0: -44, z0: -32, x1: -36, z1: -22 }, { x0: -69, z0: 2, x1: -63, z1: 8 }];
// pass 15: the backdrop lots along 文化村通り's vista keep the rng stream they had before 道玄坂's vista went
const VISTA_SEED = { bunkamura: 281 };
// A square lot that stands on the 道玄坂 corridor's real frontage is dropped: it overlaps a corridor footprint, the
// construction yard or the koban, or (west of x −175) it fronts the true 道玄坂 itself (within 16 m of its centre-line)
let _corrPolys = null;
function segsCross(p, q, r, s) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0;
}
function polysOverlap(A, Bp) {
  const a = L.polyBounds(A), b = L.polyBounds(Bp);
  if (a.x1 < b.x0 || b.x1 < a.x0 || a.z1 < b.z0 || b.z1 < a.z0) return false;
  if (A.some(([x, z]) => L.pointInPoly(x, z, Bp)) || Bp.some(([x, z]) => L.pointInPoly(x, z, A))) return true;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < Bp.length; j++) if (segsCross(A[i], A[(i + 1) % A.length], Bp[j], Bp[(j + 1) % Bp.length])) return true;
  return false;
}
function corridorDrop(poly) {
  if (!CITY.corridor) return false;
  const b = L.polyBounds(poly);
  if (b.x0 > -124) return false;                                      // east of the 109 apex: untouched
  if (!_corrPolys) _corrPolys = [...corridorFootprints().map((f) => L.offsetPolygon(f.poly, -0.4)), DG.WORKS.site, DG.WORKS.notch];
  if (_corrPolys.some((q) => polysOverlap(poly, q))) return true;
  if (b.x0 < -175) { const c = L.polyCentroid(poly); for (const p of [c, ...poly]) if (p[0] < -175 && DG.nearestOn(DG.DOGEN_PATH, p[0], p[1]).d < 16) return true; }
  return false;
}
const keepOutHit = (poly) => KEEP_OUT.some(r => L.polyRectOverlap(poly, r));
function nearPedestrianStreet(x, z) {
  for (const p of CITY.pedestrianStreets) for (let i = 0; i < p.path.length - 1; i++) if (L.distToSegment(x, z, p.path[i][0], p.path[i][1], p.path[i + 1][0], p.path[i + 1][1]) < p.width / 2 + 3.5) return true;
  return false;
}
// センター街 frontage: a continuous canyon of narrow 5–11 m "pencil" buildings with the real street's mix of shops
// (drugstores with goods spilling out, burger chains, game centres, karaoke, shoes, gyudon / ramen, phone shops,
// 消費者金融 signs, crepes / tapioca), fronts pulled to ≈5 m from the centre line (the real street is ≈10 m wall to
// wall), 10–30 cm party gaps, and the last lot of a run stretched to the corner so no voids open onto the street.
const CG = CITY.pedestrianStreets.find(p => p.id === 'centergai');
// the lot that closes the view down センター街 from the crossing (the `centergai` preset's focal point): taller, tenant
// floors lit to the top, stickers, and its crossing-facing face carries a big roof billboard
const CG_VISTA = { at: [-76, -82], toward: [0.653, 0.757] };
function cgVistaLot(lot) {
  const p = L.ensureCW(lot.poly);
  let bi = 0, bd = -Infinity;
  for (let i = 0; i < p.length; i++) { const [nx, nz] = L.edgeNormal(p, i), d = nx * CG_VISTA.toward[0] + nz * CG_VISTA.toward[1]; if (d > bd) { bd = d; bi = i; } }
  lot.poly = p; lot.storeys = Math.max(lot.storeys, 10); lot.style = 'cg'; lot.stickers = true; lot.bigBoard = 1; lot.boardFace = bi; lot.vista = true; lot.setback = false;
  lot.faces[bi] = { kind: 'street', tenants: lot.faces[bi] && lot.faces[bi].tenants && lot.faces[bi].tenants.length ? lot.faces[bi].tenants : ['カラオケ舘'] };
}
// センター街's real ground floors, gate → west (tenantsData.js / docs/reports/city.md pass 11, near-names): the fallback
// names for frontage lots, cycled; genericBuilding.js puts the real one at its own bay and skips a name already shown
// (a lot's face list is re-picked by position afterwards, cgFaceTenants: this list only fills faces with no survey point)
const CG_TENANTS = ['マツモトキヨヒ', 'マックドナルド', 'タイトーステーシオン', 'ABC-MARK', 'カラオケ舘', 'ロッテリヤ', '一乱', 'ゴン茶', 'ソフトバング', 'すき屋',
  'サンドラック', 'ビックエコー', 'WEGA', 'ジャンカレ', 'ドコマショップ', 'ダイソウ', 'SPINZ', 'ポッポ', '松家', 'プロミズ', 'ファミリマート', 'aU ショップ', 'タリース', 'ラウンドツー'];
/** The real names over / at a センター街 frontage (tenantsData.js survey, same side, ≤ 12 m along): the upper-floor
 *  signs first (they make the building's vertical sign stack), then the ground-floor shop. */
function cgFaceTenants(a, b, nx, nz) {
  const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const near = SHOP_TENANTS.filter((t) => t.street === 'center').map((t) => {
    const dx = t.pos[0] - mx, dz = t.pos[1] - mz, lat = dx * nx + dz * nz, along = Math.abs(-dx * nz + dz * nx);
    return { t, lat, along };
  }).filter((q) => q.lat > -4 && q.lat < 8 && q.along < len / 2 + 4).sort((p, q) => (q.t.floor > 1) - (p.t.floor > 1) || p.along - q.along);
  return near.slice(0, 4).map((q) => q.t.name);
}
let cgCursor = 0;
function cgDist(x, z) {
  if (!CG) return Infinity;
  let d = Infinity;
  for (let i = 0; i < CG.path.length - 1; i++) d = Math.min(d, L.distToSegment(x, z, CG.path[i][0], CG.path[i][1], CG.path[i + 1][0], CG.path[i + 1][1]));
  return d;
}
/** The OSM block outlines along センター街 run inside the street (some vertices sit on its centre line), so the corridor
 *  trim pushed whole lots back and left 15–20 m plazas. Vertices closer than the real street line (5.45 m from the
 *  centre line, ≈ 11 m wall to wall) are moved out onto it first. */
const CG_LINE = 5.45;
function snapToStreetLine(polyIn) {
  if (!CG) return polyIn;
  const [gx, gz] = L.polyCentroid(polyIn);
  let hit = false;
  const out = polyIn.map(([x, z]) => {
    let best = null, bd = Infinity;
    for (let i = 0; i < CG.path.length - 1; i++) {
      const [ax, az] = CG.path[i], [bx, bz] = CG.path[i + 1], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)), cx = ax + vx * t, cz = az + vz * t, d = Math.hypot(x - cx, z - cz);
      if (d < bd) { bd = d; best = { cx, cz, vx, vz }; }
    }
    if (bd >= CG_LINE) return [x, z];
    // push toward the block's own side (some outlines even cross the centre line)
    const l = Math.hypot(best.vx, best.vz);
    let nx = -best.vz / l, nz = best.vx / l;
    if ((gx - best.cx) * nx + (gz - best.cz) * nz < 0) { nx = -nx; nz = -nz; }
    const cur = (x - best.cx) * nx + (z - best.cz) * nz;
    if (cur >= CG_LINE) return [x, z];
    hit = true;
    return [x + nx * (CG_LINE - cur), z + nz * (CG_LINE - cur)];
  });
  return hit ? out : polyIn;
}
/** センター街 frontage gaps left by the packer (junction corners, lots trimmed off the corridor or a side street): filler
 *  lots on the street line so the canyon stays wall to wall (≈ 11 m), with the side streets / alleys left open. */
function fillCgGaps(polyIn, blk, lots, placed, rng, ctx) {
  // the OSM outlines stop short of the side streets: fillers may reach 4.5 m past the block, never onto a pavement
  const poly = L.offsetPolygon(polyIn, 4.5);
  const P = CG.path, inLot = (x, z) => placed.some(p => L.pointInPoly(x, z, p.poly));
  const alleyAt = (x, z) => CORRIDORS.some(c => c.id !== 'centergai' && x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1 && c.pts.some(([px, pz]) => Math.hypot(px - x, pz - z) < c.half + 0.6));
  const overlaps = (q) => {
    const b = L.polyBounds(q);
    for (let x = b.x0 + 0.4; x < b.x1; x += 1) for (let z = b.z0 + 0.4; z < b.z1; z += 1) if (L.pointInPoly(x, z, q) && inLot(x, z)) return true;
    return placed.some(p => p.poly.some(([x, z]) => L.pointInPoly(x, z, q)));
  };
  const blocked = (q) => overlaps(q) || corridorHit(q) || roadHit(q, ctx.field, 1.7) || keepOutHit(q);
  // lots set back behind the street line (corridor trims, deep OSM outlines): bring their front out onto it
  const cgNearest = (x, z) => {
    let bd = Infinity, bx = 0, bz = 0;
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, az] = P[i], [qx, qz] = P[i + 1], vx = qx - ax, vz = qz - az, t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
      const d = Math.hypot(x - ax - vx * t, z - az - vz * t); if (d < bd) { bd = d; bx = ax + vx * t; bz = az + vz * t; }
    }
    return { d: bd, x: bx, z: bz };
  };
  for (const lot of lots) {
    if (lot.faces.length !== 4 || lot.poly.length !== 4) continue;
    for (let ei = 0; ei < 4; ei++) {
      const q = lot.poly, i0 = ei, i1 = (ei + 1) % 4, [nx, nz] = L.edgeNormal(q, ei), mx = (q[i0][0] + q[i1][0]) / 2, mz = (q[i0][1] + q[i1][1]) / 2, c = cgNearest(mx, mz);
      if (c.d < CG_LINE + 0.4 || c.d > CG_LINE + 10 || ((c.x - mx) * nx + (c.z - mz) * nz) / c.d < 0.6) continue;
      const e0 = cgNearest(q[i0][0], q[i0][1]).d - CG_LINE, e1 = cgNearest(q[i1][0], q[i1][1]).d - CG_LINE;
      const others = placed.filter(p => p.poly !== q);
      for (const k of [1, 0.75, 0.5, 0.3]) {
        if (Math.max(e0, e1) * k < 0.4) break;
        const t = q.slice(); t[i0] = [q[i0][0] + nx * Math.max(0, e0 * k), q[i0][1] + nz * Math.max(0, e0 * k)]; t[i1] = [q[i1][0] + nx * Math.max(0, e1 * k), q[i1][1] + nz * Math.max(0, e1 * k)];
        if (L.polyArea(t) <= 0 || t.some(([x, z]) => cgNearest(x, z).d < CG_LINE - 0.15)) continue;
        const hitOther = others.some(p => p.poly.some(([x, z]) => L.pointInPoly(x, z, t)) || t.some(([x, z]) => L.pointInPoly(x, z, p.poly)));
        if (hitOther || corridorHit(t) || roadHit(t, ctx.field, 1.7) || keepOutHit(t)) continue;
        const pi = placed.findIndex(p => p.poly === q); lot.poly = t; if (pi >= 0) placed[pi] = { poly: t };
        if (lot.faces[ei].kind !== 'street') lot.faces[ei] = { kind: 'street', tenants: [CG_TENANTS[(cgCursor++) % CG_TENANTS.length]] };
        break;
      }
    }
  }
  for (let i = 0; i < P.length - 1; i++) {
    const [ax, az] = P[i], len = segLen(P[i], P[i + 1]), ux = (P[i + 1][0] - ax) / len, uz = (P[i + 1][1] - az) / len;
    for (const side of [1, -1]) {
      const nx = -uz * side, nz = ux * side;
      const make = (t0, t1) => {
        const s0 = Math.max(0, t0 - 0.5), s1 = Math.min(len, t1 + 0.5);
        const F = (s) => [ax + ux * s + nx * CG_LINE, az + uz * s + nz * CG_LINE];
        let a = side > 0 ? F(s0) : F(s1), b = side > 0 ? F(s1) : F(s0);
        const probe = (p) => Math.min(1.2 + L.rayToPolygon(p[0] + nx * 1.2, p[1] + nz * 1.2, nx, nz, poly, -1, 30), ...placed.map(q => L.rayToPolygon(p[0], p[1], nx, nz, q.poly, -1, 30)));
        let depth = Math.min(rng.range(9, 14), probe(a), probe(b), probe([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) - 0.3;
        const mk = () => [a, b, [b[0] + nx * depth, b[1] + nz * depth], [a[0] + nx * depth, a[1] + nz * depth]];
        let lot = mk();
        const MIN_D = 2.6;   // a shallow corner shop still closes the frontage; its side wall is the neighbour's
        while (depth >= MIN_D && blocked(lot)) { depth -= 0.5; lot = mk(); }
        for (let k = 0; k < 6 && depth < MIN_D; k++) {   // trim the ends (side street / alley mouths) and retry
          const tx = b[0] - a[0], tz = b[1] - a[1], w = Math.hypot(tx, tz); if (w < 3.5) return;
          a = [a[0] + tx / w * 0.5, a[1] + tz / w * 0.5]; b = [b[0] - tx / w * 0.5, b[1] - tz / w * 0.5];
          depth = Math.min(12, probe(a), probe(b)) - 0.3; lot = mk();
          while (depth >= MIN_D && blocked(lot)) { depth -= 0.5; lot = mk(); }
        }
        if (depth < MIN_D || segLen(a, b) < 3) return;
        const faces = [{ kind: 'street', tenants: [CG_TENANTS[(cgCursor++) % CG_TENANTS.length]] }, { kind: 'alley', tenants: [] }, { kind: 'blind', tenants: [] }, { kind: 'alley', tenants: [] }];
        const st = depth < 5 ? rng.int(2, 3) : rng.int(Math.max(3, blk.minStoreys), Math.max(4, blk.maxStoreys));
        lots.push({ id: `${blk.id}_${lots.length}`, poly: lot, storeys: st, style: 'tenant', faces, seed: lots.length, cgFill: true, noStairs: depth < 5 });
        placed.push({ poly: lot });
      };
      let run0 = -1;
      for (let t = 0.5; t <= len; t += 1) {
        const qx = ax + ux * t + nx * (CG_LINE + 1.2), qz = az + uz * t + nz * (CG_LINE + 1.2);
        const gap = L.pointInPoly(qx, qz, poly) && !inLot(qx, qz) && ctx.field.sample(qx, qz) > 2 && !alleyAt(qx, qz);
        if (gap && run0 < 0) run0 = t;
        if (!gap && run0 >= 0) { if (t - 1 - run0 >= 2.5) make(run0, t - 1); run0 = -1; }
      }
      if (run0 >= 0 && len - run0 >= 2.5) make(run0, len);
    }
  }
}
// pedestrian corridors no lot may stand on (the OSM block polygons overlap センター街's west half and cut across the
// 宇田川町 alleys, so lots used to sit in the street and the crowd walked through them): lots are trimmed back from
// the front / back until the corridor is clear, else dropped (the gap IS the alley)
const CORRIDORS = CITY.pedestrianStreets.filter(p => !/^nonbei|miyashita_walk|koen_promenade/.test(p.id)).map(p => {
  const pts = L.resample(p.path, 1), b = L.polyBounds(pts);
  return { id: p.id, half: p.width / 2 + 0.3, pts, x0: b.x0 - p.width, x1: b.x1 + p.width, z0: b.z0 - p.width, z1: b.z1 + p.width };
});
function corridorHit(poly) {
  const b = L.polyBounds(poly);
  for (const c of CORRIDORS) {
    if (b.x1 < c.x0 || b.x0 > c.x1 || b.z1 < c.z0 || b.z0 > c.z1) continue;
    for (const [x, z] of c.pts) {
      if (x < b.x0 - c.half || x > b.x1 + c.half || z < b.z0 - c.half || z > b.z1 + c.half) continue;
      if (L.pointInPoly(x, z, poly)) return true;
      for (let i = 0; i < poly.length; i++) { const a = poly[i], q = poly[(i + 1) % poly.length]; if (L.distToSegment(x, z, a[0], a[1], q[0], q[1]) < c.half) return true; }
    }
  }
  return false;
}
/** True if any part of the polygon stands on a carriageway (the OSM blocks overlap 文化村通り's bend, for one). */
function roadHit(poly, field, clear = 0.4) {
  if (!field) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(segLen(a, b)));
    for (let k = 0; k < n; k++) if (field.sample(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) < clear) return true;
  }
  return false;
}
// blocks whose interior is filled with a set-back back-building (no courtyard voids seen through party gaps)
const FILL_BLOCKS = new Set(['sanzenri_corner', 'udagawa_s1', 'udagawa_n1', 'udagawa_n2', 'udagawa_w1', 'udagawa_s2', 'bunkamura_n', 'dogenzaka_s1', 'dogenzaka_s2', 'dogenzaka_s3', 'dogenzaka_s4', 'dogenzaka_w1', 'zerogate', 'udagawa_nw']);
function simplePoly(p) {
  const n = p.length;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const a = p[i], b = p[(i + 1) % n], c = p[j], d = p[(j + 1) % n];
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return false;
  }
  return true;
}
/** 文化村通り's MEGA ドン・キホーヂ: the ≥10 m building face nearest the real store's frontage that looks onto the street
 *  (corner lots often front 文化村通り with their side face). */
function markDonki(lots) {
  const T = [-190, -58];
  let best = null, bd = Infinity;
  for (const lot of lots) {
    const p = L.ensureCW(lot.poly);
    for (let i = 0; i < 4; i++) {
      const a = p[i], b = p[(i + 1) % 4], w = segLen(a, b);
      if (w < 10) continue;
      const [nx, nz] = L.edgeNormal(p, i), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if ((T[0] - mx) * nx + (T[1] - mz) * nz < 0 && Math.hypot(T[0] - mx, T[1] - mz) > 3) continue;
      const d = Math.hypot(mx - T[0], mz - T[1]);
      if (d < bd) { bd = d; best = { lot, i, a, b, nx, nz }; }
    }
  }
  if (!best || bd > 25) return;
  const f = best.lot.faces[best.i];
  f.kind = 'street'; f.tenants = ['ドン・キホーヂ 渋谷本店'];
  best.lot.storeys = Math.max(best.lot.storeys, 7); best.lot.style = 'tenant';
  best.lot.donki = { a: best.a, b: best.b, nx: best.nx, nz: best.nz };
}
/**
 * センター街 is a row of 5–9 m pencil buildings of jagged heights: any frontage lot wider than 9.5 m is cut into
 * 5–9 m pieces (6 cm party slits), each piece ±1–2 storeys from its neighbour. Hash-driven (no block rng draws) and
 * the extra pieces are flagged `extra` so city.init does not advance nB for them: every other block keeps its layout.
 */
function splitCgLots(lots) {
  const add = [];
  for (const lot of lots) {
    if (lot.poly.length !== 4 || !lot.faces || lot.faces[0].kind !== 'street') continue;
    const [p0, p1, p2, p3] = lot.poly, front = segLen(p0, p1);
    const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
    if (front <= 9.5 || cgDist(mx, mz) > CG.width / 2 + 4) continue;
    const n = Math.max(2, Math.round(front / 7)), cuts = [0];
    for (let k = 1; k < n; k++) cuts.push((k + (L.hash(Math.round(mx * 10), k, 881) - 0.5) * 0.35) / n);
    cuts.push(1);
    const at = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const gap = 0.03 / front;
    let prev = lot.storeys;
    const pieces = [];
    for (let k = 0; k < n; k++) {
      const t0 = cuts[k] + (k ? gap : 0), t1 = cuts[k + 1] - (k < n - 1 ? gap : 0);
      const poly = [at(p0, p1, t0), at(p0, p1, t1), at(p3, p2, t1), at(p3, p2, t0)];
      const faces = [k === 0 ? lot.faces[0] : { kind: 'street', tenants: [CG_TENANTS[(cgCursor++) % CG_TENANTS.length]] }, k === n - 1 ? lot.faces[1] : { kind: 'blind', tenants: [] }, lot.faces[2], k === 0 ? lot.faces[3] : { kind: 'blind', tenants: [] }];
      const h = L.hash(Math.round(mx * 10), k, 883), step = (h < 0.5 ? -1 : 1) * (h % 0.5 < 0.25 ? 1 : 2);
      const storeys = k === 0 ? lot.storeys : Math.max(3, Math.min(Math.max(lot.storeys + 3, 6), prev + step));
      prev = storeys;
      pieces.push({ poly, faces, storeys });
    }
    Object.assign(lot, pieces[0]);
    for (let k = 1; k < n; k++) add.push({ ...lot, ...pieces[k], id: `${lot.id}_p${k}`, extra: k, noStairs: lot.noStairs, donki: null });
  }
  lots.push(...add);
}
/** Split a block polygon into lots along its edges. Returns buildBuilding specs. */
export function packBlock(blk, rng, ctx) {
  const poly = L.ensureCW(snapToStreetLine(blk.polygon));
  const n = poly.length;
  const lots = [];
  const tenants = blk.facadeTenants ? blk.facadeTenants.slice() : [];
  let ti = 0;
  const nextTenants = (k) => { const out = []; for (let i = 0; i < k && tenants.length; i++) out.push(tenants[(ti++) % tenants.length]); return out; };
  const placed = [];   // [{poly}]
  const inside = (x, z) => placed.some(p => L.pointInPoly(x, z, p.poly));
  const streetEdge = poly.map((a, i) => { const b = poly[(i + 1) % n]; const [nx, nz] = L.edgeNormal(poly, i); const mx = (a[0] + b[0]) / 2 + nx * 3.5, mz = (a[1] + b[1]) / 2 + nz * 3.5; return ctx.isStreetSide(mx, mz); });
  let lastDepthPrev = 0, firstDepth = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const len = segLen(a, b);
    const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
    const [nx, nz] = L.edgeNormal(poly, i);
    if (len < 7) { lastDepthPrev = 0; continue; }
    const isStreet = streetEdge[i];
    const edgeSlope = Math.abs(groundY(b[0], b[1]) - groundY(a[0], a[1])) / len;
    let s = Math.min(len * 0.4, lastDepthPrev > 0 ? lastDepthPrev - 0.5 : 0);
    const endLimit = (i === n - 1 && firstDepth > 0) ? len - firstDepth + 0.5 : len;
    let lastDepth = 0;
    while (s < endLimit - 5) {
      const cgLot = isStreet && cgDist(a[0] + tx * (s + 4) + nx * 3, a[1] + tz * (s + 4) + nz * 3) < CG.width / 2 + 3.5;
      let w = Math.min(cgLot ? rng.range(5.5, 11) : rng.range(isStreet ? 8 : 10, isStreet ? 20 : 26), endLimit - s);
      if (edgeSlope > 0.015 && blk.narrowOnSlope !== false) w = Math.min(w, 6.5 + (w - 8) * 0.3);
      if (cgLot && endLimit - (s + w) < 5.5 && endLimit - s <= 16) w = endLimit - s;
      if (w < 5) break;
      const mid = s + w / 2;
      const px = a[0] + tx * mid, pz = a[1] + tz * mid;
      const avail = L.rayToPolygon(px, pz, -nx, -nz, poly, i, 200);
      let depth;
      let through = false;
      if (avail < 26) { depth = Math.max(4, avail - 0.6); through = true; } else depth = Math.min(rng.range(11, 19), avail * 0.55);
      if (depth < 4) { s += w + 0.8; continue; }
      if (inside(px - nx * depth * 0.5, pz - nz * depth * 0.5)) { s += w + 0.8; continue; }
      const mkLot = (s0, w0, d0) => [[a[0] + tx * s0, a[1] + tz * s0], [a[0] + tx * (s0 + w0), a[1] + tz * (s0 + w0)], [a[0] + tx * (s0 + w0) - nx * d0, a[1] + tz * (s0 + w0) - nz * d0], [a[0] + tx * s0 - nx * d0, a[1] + tz * s0 - nz * d0]];
      let lot = mkLot(s, w, depth);
      if (keepOutHit(lot)) {
        let ok = false;
        for (let d0 = depth - 1; d0 >= 4 && !ok; d0--) if (!keepOutHit(mkLot(s, w, d0))) { depth = d0; ok = true; }
        for (let w0 = w - 1; w0 >= 5 && !ok; w0--) if (!keepOutHit(mkLot(s, w0, depth))) { w = w0; ok = true; }
        if (!ok) { s += 2; continue; }
        lot = mkLot(s, w, depth);
      }
      if (cgLot) {
        // pull the front out to the real street line (≈5.4 m from the centre), never onto a carriageway
        let ext = Math.min(4, Math.max(0, Math.min(cgDist(px, pz), cgDist(lot[0][0], lot[0][1]), cgDist(lot[1][0], lot[1][1])) - 5.4));
        while (ext > 0.2 && (ctx.field.sample(px + nx * ext, pz + nz * ext) < 1 || ctx.field.sample(lot[0][0] + nx * ext, lot[0][1] + nz * ext) < 1 || ctx.field.sample(lot[1][0] + nx * ext, lot[1][1] + nz * ext) < 1)) ext -= 0.5;
        if (ext > 0.2) {
          const ext2 = [[lot[0][0] + nx * ext, lot[0][1] + nz * ext], [lot[1][0] + nx * ext, lot[1][1] + nz * ext], lot[2], lot[3]];
          if (!keepOutHit(ext2)) lot = ext2;
        }
      }
      const blocked = (q) => corridorHit(q) || roadHit(q, ctx.field);
      if (blocked(lot)) {
        let ok = false;
        const mv = (i, k, d) => [lot[i][0] + nx * d * k, lot[i][1] + nz * d * k];
        for (let cut = 0.5; cut <= depth - 4 && !ok; cut += 0.5) { const t = [mv(0, -1, cut), mv(1, -1, cut), lot[2], lot[3]]; if (!blocked(t)) { lot = t; depth -= cut; ok = true; } }
        for (let cut = 0.5; cut <= depth - 4 && !ok; cut += 0.5) { const t = [lot[0], lot[1], mv(2, 1, cut), mv(3, 1, cut)]; if (!blocked(t)) { lot = t; depth -= cut; ok = true; } }
        if (!ok) { s += w + 0.8; continue; }
      }
      const storeys = rng.int(blk.minStoreys, blk.maxStoreys);
      const style = blk.style === 'entertainment' && rng.chance(0.4) ? 'tenant' : blk.style;
      const faces = [
        { kind: isStreet ? 'street' : 'alley', tenants: cgLot ? [CG_TENANTS[(cgCursor++) % CG_TENANTS.length]] : nextTenants(Math.max(1, Math.round(w / 8))) },
        { kind: 'blind', tenants: [] },
        { kind: through && ctx.isStreetSide(px - nx * (depth + 3), pz - nz * (depth + 3)) ? 'street' : 'alley', tenants: through ? nextTenants(1) : [] },
        { kind: 'blind', tenants: [] },
      ];
      // ends of a run get an exposed side
      if (s < 1) faces[3].kind = 'alley';
      if (s + w > endLimit - 1) faces[1].kind = 'alley';
      lots.push({ id: `${blk.id}_${lots.length}`, poly: lot, storeys, style, faces, seed: lots.length });
      placed.push({ poly: lot });
      lastDepth = depth;
      if (i === 0 && s < 1) firstDepth = depth;
      s += w + (cgLot ? rng.range(0.08, 0.3) : rng.range(0.4, 1.6));
    }
    lastDepthPrev = lastDepth;
  }
  if (CG) { const b = L.polyBounds(poly); if (CG.path.some(([x, z]) => x > b.x0 - 15 && x < b.x1 + 15 && z > b.z0 - 15 && z < b.z1 + 15)) { fillCgGaps(poly, blk, lots, placed, rng, ctx); splitCgLots(lots); } }
  // Restore the short Bunkamura frontage omitted by the rectangular lot packer.
  // Extend the existing lot within its block, keeping the rear service passage open.
  if (blk.id === 'dogenzaka_w1') {
    const lot = lots.find(q => q.id === 'dogenzaka_w1_9');
    if (lot && lot.poly.length === 4) {
      const q = [lot.poly[0], lot.poly[1], [-195, lot.poly[2][1]], [-193, lot.poly[3][1]]];
      if (!corridorHit(q) && !roadHit(q, ctx.field, 2) && !keepOutHit(q)) {
        lot.poly = q;
        lot.faces[2] = { kind: 'street', tenants: ['若槻ビル'] };
      }
    }
  }
  // side / back faces that ended up exposed (run ends, keep-out cuts, corners) get a real facade instead of a blank
  // party wall: shopfronts when they face a street, windows + a service door when they face a gap or alley
  for (const lot of lots) {
    const lp = L.ensureCW(lot.poly);
    for (const fi of [1, 2, 3]) {
      const f = lot.faces[fi]; if (!f || f.kind === 'street') continue;
      const a = lp[fi], b = lp[(fi + 1) % 4];
      if (segLen(a, b) < 4) continue;
      const [nx, nz] = L.edgeNormal(lp, fi);
      const mx = (a[0] + b[0]) / 2 + nx * 1.5, mz = (a[1] + b[1]) / 2 + nz * 1.5;
      if (lots.some(o => o !== lot && L.pointInPoly(mx, mz, o.poly))) continue;
      // anything that looks onto センター街 or its mouth (≤ 15 m) is a shopping frontage, never a back wall
      const cgNear = Math.min(...[0.2, 0.5, 0.8].map(t => cgDist(a[0] + (b[0] - a[0]) * t + nx * 3.5, a[1] + (b[1] - a[1]) * t + nz * 3.5))) < 15;
      if (ctx.isStreetSide(mx + nx * 2, mz + nz * 2) || cgNear) { f.kind = 'street'; if (!f.tenants || !f.tenants.length) f.tenants = cgDist(mx, mz) < CG.width / 2 + 4 ? [CG_TENANTS[(cgCursor++) % CG_TENANTS.length]] : nextTenants(1); }
      else if (f.kind === 'blind') f.kind = 'alley';
    }
  }
  // センター街 frontage lots: tenant floors to the top, lit, condensers, window stickers, an exterior stair on ~half
  if (CG) for (const lot of lots) {
    if (lot.poly.length !== 4 || !lot.faces || lot.faces[0].kind !== 'street') continue;
    const [p0, p1] = lot.poly, mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
    if (cgDist(mx, mz) > CG.width / 2 + 4) continue;
    lot.style = 'cg'; lot.stickers = true; lot.frontStair = L.hash(Math.round(mx * 7), Math.round(mz * 7), 17) < 0.5;
    const lp = L.ensureCW(lot.poly);
    for (let fi = 0; fi < 4; fi++) {
      const f = lot.faces[fi]; if (!f || f.kind !== 'street') continue;
      const [nx, nz] = L.edgeNormal(lp, fi), real = cgFaceTenants(lp[fi], lp[(fi + 1) % 4], nx, nz);
      if (real.length) f.tenants = real;
    }
  }
  // back-building over the block interior: only its upper floors / blank party walls show through the gaps
  if (FILL_BLOCKS.has(blk.id)) {
    const core = L.offsetPolygon(poly, -9.5);
    if (core.length >= 3 && simplePoly(core) && Math.abs(L.polyArea(core)) > 80 && core.every(([x, z]) => L.pointInPoly(x, z, poly)) && !keepOutHit(core) && !corridorHit(core) && !roadHit(core, ctx.field)) {
      lots.push({ id: `${blk.id}_core`, poly: core, storeys: Math.max(blk.minStoreys, Math.round((blk.minStoreys + blk.maxStoreys) / 2)), style: blk.style === 'hotel' ? 'hotel' : 'office', faces: core.map(() => ({ kind: 'alley', tenants: [] })), seed: lots.length, groundFloor: 'wall', noStairs: true, colliders: 'edges' });
    }
  }
  return lots;
}

/** Fallback massing for a landmark whose builder is missing/failed: polygon or rect extrusion via the facade generator. */
function genericLandmark(key, data, ctx, rng) {
  const poly = data.polygon ? data.polygon : L.rectPoly(data.pos[0], data.pos[1], data.size[0], data.size[2], data.rotY);
  const tall = data.size[1] >= 90;
  const storeys = Math.max(1, data.storeys || Math.round(data.size[1] / 3.5));
  const sh = storeys > 1 ? (data.size[1] - 4) / (storeys - 1) : data.size[1];
  const faces = poly.map((a, i) => { const b = poly[(i + 1) % poly.length]; const [nx, nz] = L.edgeNormal(L.ensureCW(poly), i); const mx = (a[0] + b[0]) / 2 + nx * 3.5, mz = (a[1] + b[1]) / 2 + nz * 3.5; return { kind: ctx.isStreetSide(mx, mz) ? 'street' : 'alley', tenants: data.tenants || [] }; });
  if (data.size[1] < 4) return { colliders: [], anchors: {}, facades: [] };
  const r = buildBuilding({ id: key, poly, storeys, style: tall ? 'office' : 'tenant', gf: 4, sh, wall: tall ? 5 : undefined, faces, setback: false, noRoofClutter: tall, noStairs: true }, { batch: ctx.batch, inst: ctx.inst, rng, pools: ctx.pools, billboards: [] });
  r.facades.forEach(f => { f.kind = 'landmark'; });
  return { colliders: r.colliders, anchors: {}, facades: r.facades };
}

// ---------------------------------------------------------------- lanes / crowd paths
function road(id) { return CITY.roads.find(r => r.id === id); }
function chain(...ids) {
  const pts = [];
  for (const spec of ids) {
    const rev = spec.startsWith('-');
    const r = road(rev ? spec.slice(1) : spec);
    if (!r) continue;
    const p = rev ? r.path.slice().reverse() : r.path.slice();
    for (const q of p) if (!pts.length || segLen(pts[pts.length - 1], q) > 0.5) pts.push(q);
  }
  return pts;
}
function segIntersectS(points, cum, a, b) {
  // arc length where the polyline crosses segment a-b, or -1
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1], q = points[i];
    const r = [q[0] - p[0], q[1] - p[1]], s = [b[0] - a[0], b[1] - a[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-9) continue;
    const qp = [a[0] - p[0], a[1] - p[1]];
    const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return cum[i - 1] + t * (cum[i] - cum[i - 1]);
  }
  return -1;
}
function buildLanes() {
  const lanes = [];
  const stops = CITY.crossing.stopLines;
  const add = (pts, off, axis, stopRoads = [], wrap = true) => {
    const points = L.offsetPolyline(pts, off);
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + segLen(points[i - 1], points[i]));
    const length = cum[cum.length - 1];
    let stopS = -1;
    for (const sl of stops) { if (!stopRoads.includes(sl.road)) continue; const s = segIntersectS(points, cum, sl.a, sl.b); if (s > 0) { stopS = s - 0.8; break; } }
    lanes.push({ points, cum, length, axis, stopS, wrap });
  };
  const ew = chain('-dogenzaka', 'dogenzaka_shita', 'miyamasu');
  const ewR = ew.slice().reverse();
  add(ew, 2.6, 'ew', ['dogenzaka_shita']); add(ew, 5.0, 'ew', ['dogenzaka_shita']);
  add(ewR, 2.6, 'ew', ['miyamasu']); add(ewR, 5.0, 'ew', ['miyamasu']);
  const ns = chain('-koen', 'ekimae_s');
  const nsR = ns.slice().reverse();
  add(ns, 2.8, 'ns', ['koen']); add(nsR, 2.8, 'ns', ['ekimae_s']);
  const ek = road('ekimae_s').path;
  add(ek, 7.4, 'ns', []); add(ek.slice().reverse(), 7.4, 'ns', ['ekimae_s']);
  const meiji = road('meiji_ne').path;
  add(meiji, 2.8, 'meiji'); add(meiji, 8.2, 'meiji'); add(meiji.slice().reverse(), 2.8, 'meiji'); add(meiji.slice().reverse(), 8.2, 'meiji');
  const tama = road('tamagawa').path;
  add(tama, 2.6, 'meiji'); add(tama, 7.6, 'meiji'); add(tama.slice().reverse(), 2.6, 'meiji'); add(tama.slice().reverse(), 7.6, 'meiji');
  const bunka = road('bunkamura').path;
  add(bunka, 2.0, 'meiji'); add(bunka.slice().reverse(), 2.0, 'meiji');
  const ino = road('inokashira').path;
  add(ino, 3.0, 'meiji'); add(ino, -3.0, 'meiji');
  const nishi = road('nishiguchi').path;
  add(nishi, 2.4, 'meiji'); add(nishi.slice().reverse(), 2.4, 'meiji');
  const jingu = road('jingu_n').path;
  add(jingu, 2.2, 'meiji'); add(jingu, 6.2, 'meiji'); add(jingu.slice().reverse(), 2.2, 'meiji'); add(jingu.slice().reverse(), 6.2, 'meiji');
  for (const id of ['wave', 'centergai_w_st', 'miyashita_st']) { const r = road(id); if (r) add(r.path, 0, 'meiji'); }
  return lanes;
}
export function sampleLane(lane, s) {
  const { points, cum } = lane;
  if (s <= 0) return [points[0][0], points[0][1], 0];
  for (let i = 1; i < points.length; i++) {
    if (s <= cum[i]) {
      const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
      const p = lerp2(points[i - 1], points[i], t);
      return [p[0], p[1], i - 1];
    }
  }
  const l = points[points.length - 1];
  return [l[0], l[1], points.length - 2];
}
function buildCrowdPaths() {
  const P = [];
  for (const r of CITY.roads) {
    if (!r.sidewalk || r.sidewalk < 2) continue;
    const off = r.width / 2 + r.sidewalk / 2 + 0.2;
    // a divided road's inner side is the bus terminal's islands / the bus lane, not a pavement
    if (r.islandSide !== 'left') P.push({ points: L.offsetPolyline(r.path, off), width: Math.max(1.2, r.sidewalk - 1.4), roadId: r.id, side: 'left' });
    if (r.islandSide !== 'right') P.push({ points: L.offsetPolyline(r.path, -off), width: Math.max(1.2, r.sidewalk - 1.4), roadId: r.id, side: 'right' });
  }
  for (const p of CITY.pedestrianStreets) {
    const w = Math.max(1.5, p.width - 1.5);
    P.push({ points: p.path, width: w, roadId: p.id });
    if (p.id === 'centergai') { P.push({ points: p.path, width: w }); P.push({ points: p.path, width: w }); }
  }
  return P;
}

/** ?cityprobe=1: counts city draw calls (main + shadow) per mesh name over 60 frames, logs the top entries once. */
function makeProbe(cityMod, engine) {
  const main = new Map(), shadow = new Map();
  let frames = 0, done = false;
  cityMod.group.traverse((m) => {
    if (!m.isMesh) return;
    const key = m.name.replace(/:-?\d+,-?\d+$/, '');
    m.onBeforeRender = () => main.set(key, (main.get(key) || 0) + 1);
    m.onBeforeShadow = () => shadow.set(key, (shadow.get(key) || 0) + 1);
  });
  return {
    tick() {
      if (done || ++frames < 90) return;
      done = true;
      const n = frames, sum = (mp) => [...mp.values()].reduce((a, b) => a + b, 0) / n;
      const top = [...main.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}=${(v / n).toFixed(1)}`).join(' ');
      console.info(`[city probe] main ${sum(main).toFixed(0)} shadow ${sum(shadow).toFixed(0)} | ${top}`);
      void engine;
    },
  };
}

export default city;
export { CITY, groundY, facing, packBlock as _packBlock };
