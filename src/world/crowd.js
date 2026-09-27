// [crowd] Pedestrians. SIMULATION: scramble waves (one per green man, a smeared launch, company walking abreast,
// time-to-collision steering) synced to traffic.signal.ped, windowed pavement flows on city.crowdPaths, the Hachiko
// square's through-routes, plaza idlers, touts / hand-outs, koban officers, bicycles pushed over the crossing, the
// fight ring (gawk / releaseGawk / setCombatBudget, called by combat.js), street-furniture avoidance, the car
// push-out, the lens bubble, and the identity lock that binds a pool body to a pedestrian only where nobody sees it.
// RENDERING (2026-09-25, docs/PEDS.md): every pedestrian is one of the client's 19 scanned people, drawn by
// crowdScan.js -- VAT-animated instanced lod1 / lod2 tiers per scan, a pool of rigged scan bodies near the lens,
// contact decals, the wet-road mirror. The scan key (p.sk / p.pk), the height and the stride come from the scan.
// LEGACY RENDERER (?crowdLegacy=1, and the fallback when no scan loads): parts-based InstancedMesh humans with a CPU
// gait and a per-instance garment grammar, a GPU-animated far body past DET_D, and a pool of procedural humanoids
// posed bone by bone from their twins -- everything below that builds or poses those.
//   crowd.peds[]  { x, z, yaw, speed, kind:'crosser'|'walker'|'idler', state, gawk, hero, grp, sk, pk }
//   crowd.count / crowd.visible / crowd.heroes / crowd.scanR (the scanned crowd: report(), S[], heroes are its pool)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CITY, crosswalkPaths, pointInPolygon, groundY, SLOPED } from './cityData.js';
// 2026-09-25 (docs/PEDS.md, the client: 「基本的にアップロードしたイメージ以外で通行人は使わない」): the crowd is DRAWN
// by crowdScan.js -- every pedestrian is one of the client's scanned people (VAT-instanced mid / far tiers, a pool
// of rigged bodies near). Everything below that builds and poses the parts rig, the procedural far bodies and the
// procedural pool is the legacy renderer, kept only for ?crowdLegacy=1 (and as the fallback when no scan loads).
import { CrowdScan, scanSource, precompileLit } from './crowdScan.js';

// Population. ?peds=<n> scales the whole crowd for A/B measurement (1 = as authored, 0.5 = half, …).
// Client call 2026-09-22: thinned from 950/1480/620 (3051) to hold the night crossing at 60 fps.
const _PEDS = (() => {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('peds') : null;
  const n = q === null ? NaN : Number(q);
  return isFinite(n) && n >= 0 ? n : 1;
})();
// 2026-09-22: 560/820/360. 2026-09-23: 360/480/230. 2026-09-24 (critic, Plan A): the crossing at 21:30 read as a
// quiet plaza -- 55 crossers in frame on a WALK -- so the crossers go back up; the far tier is one draw and far
// slots tick at 1/4 rate, so they cost CPU rather than frame. Walkers are now windowed onto the 110 m round
// the crossing instead of being spread over every pavement in the city.
// 2026-09-24 round 2: the Hachiko square read as a waiting room (112 idlers, no walkers), so 60 idlers became
// through-walkers on the square's own routes (gate <-> crossing mouths, 宮益坂, the south end).
// 2026-09-25 fix round 1 (critic): Center-gai's mouth held ~1 person per metre against a wall of heads at 40 m
// (N_MOUTH 46 -> 110, windowed onto the lens's first 25 m), and the Hachiko square logged 178 standing / 83 moving
// (N_PLAZA 100 -> 150, the 50 taken from the idlers).
// 2026-09-25 (client: 「スクランブル交差点あたりの人口はもっと減らしていい」): the scramble thinned -- crossers 650 -> 280
// (the kerb crowds: each WALK is still a bunched wave stepping off together, a lighter one), Center-gai's mouth 110 -> 50
// (N_WALKERS down by the same 60, or they would only move to the other pavements), the Hachiko square's through-walkers
// 200 -> 90, and the standing idlers within SCRAMBLE_THIN_R of the scramble ~55 % fewer (thinNearScramble).
const N_CROSSERS = Math.round(280 * _PEDS), N_WALKERS = Math.round(500 * _PEDS), N_IDLERS = Math.round(110 * _PEDS);
const N_MOUTH = Math.round(50 * _PEDS);                     // of the walkers: Center-gai's first 25 m, the lane the lens reads
const N_PLAZA = Math.round(90 * _PEDS);                      // walkers on the Hachiko square's routes
// [city] 2026-09-27 pass 15: the 道玄坂 corridor up to 道玄坂上 (true metres, ~480 m of street past the first window):
// its own walkers on both pavements, on top of the scramble's budget (which stays where it was)
const N_CORRIDOR = Math.round(84 * _PEDS);
const SCRAMBLE_THIN_R = 60, SCRAMBLE_THIN_K = 0.55;         // idlers round the scramble: radius, fraction taken out
const SCRAMBLE_AT = 34, SCRAMBLE_LEN = 47, FLASH_LEN = 8;   // traffic.js CYCLE: ns 26 + amber 4 + allred 4, then the scramble
const COH_R = 2.6;                                           // cohesion reach, between members of one social group only
// DET_D / DET_N: the part rig (17 meshes) inside this band, the one-draw far body beyond it. 22 m / 140 bodies:
// the rig at 32 m (180 bodies plus their shadow and mirror copies) was most of the crowd's 677 k triangles.
// HAND_D: hands, phones and furled umbrellas are 2-5 px past ~22 m and were 218 tris a body out to 48 m.
// CULL 125: Plan A makes everything past ~150 m silhouette country, and a 125 m body is ~10 px.
// 2026-09-24 round 3: 19 m / 120 / 13 m, to pay for the two extra pool bodies the lens bubble needs (a 1.7 m body at
// 19 m is ~115 px: the far body's scissor walk still reads there).
// 2026-09-24 fix round 1: 18 m / 90 bodies (the 3 m lens bubble lets more of the near field onto the rig, and a WALK
// wave put 96 bodies on it), and the cull at 115 m (a body there is ~11 px): the crowd holds ~250 k triangles
const CULL = 115, FULL_D = 22, MAX_VIS = 640, MAX_FULL = 200, DET_D = 18, DET_N = 90, HAND_D = 13;
// real shadow casters: torso + legs of the nearest CAST_N bodies. The count is swapped in onBeforeShadow so
// the same InstancedMeshes that draw the crowd also cast, without a second mesh set or a second upload.
const CAST_N = 84, CAST_N_NIGHT = 4;
// reflection: the wet road mirrors the nearest REFL_N bodies as the cut far body (a blurred smear does not need the
// 17-part rig, nor the full far body), in a mesh that only the reflection camera draws
const REFL_N = 28, REFL_LAYER = 1;
// the far body is 312 triangles; past FAR2_D a 1.8 m body is under ~85 px and gets the 149-triangle cut of it
const FAR2_D = 27;
// LOD0: a small pool of real skinned humanoids recycled onto whichever pedestrians are closest to the lens.
// LOD0 is what the client's eye lands on: the nearest bodies are the only ones big enough on screen to be
// read as people rather than as crowd. One costs 5 draws and ~16 k triangles; it is kept off the mirror and
// bloom-mask layer (its far body is mirrored instead) and casts no shadow at night.
// 2026-09-24 round 2: the pool bodies are no longer driven by animation clips. Each one is posed bone by bone from
// its instanced twin's own procedural pose (the same stride solved from metres travelled, the same idle poses,
// phones, gestures), so there is no clip speed to match and no look to gate on: inside LOD0_ANY every pedestrian
// is promoted, whatever it wears. Out to LOD0_D the old gates still decide who is worth a body.
// 2026-09-24 round 3: 10 bodies (was 8): with the lens bubble below, the pool is what fills the 6 m in front of the
// camera, so it is sized to the busiest near field (the Center-gai mouth, a WALK wave passing the player).
// Out of a fight the pool now stops at 8 m (was 10): the bubble needs bodies inside 6 m, the last 2 m are hysteresis.
// 2026-09-24 fix round 1 (critic, performance): 6 bodies (was 10), 4 bound at once outside a fight -- the 3-4 nearest
// the lens -- and each built at detail 0.5 (~10.8 k triangles, was ~16 k; the slab check passes down to 0.4 now).
// A body seen from behind past LOD0_BACK stays on the part rig: from behind the rig's hair shell and garment read.
// 2026-09-25 fix round 1 (critic, performance + the part rig at 3-5 m): the pool is no longer a 6-body ring rebuilt
// at run time. Every outfit template is built ONCE at boot into a parked cache (POOL_KEYS_BOOT, ~27 bodies incl. a
// second copy of the four commonest keys, ~0.5 s behind the loading screen), so no body is ever built mid-play and a
// WALK wave's coats, dresses and cardigans all have a resident template. LOD0_BIND is how many are BOUND at once in
// a fight (LOD0_CAP outside one: 4 -> 6); POOL_MAX caps the pool if a key nobody seeded is ever asked for.
const LOD0_BIND = 8, LOD0_MIN = 3, LOD0_D = 8, LOD0_ANY = 8, LOD0_D_FIGHT = 18, LOD0_SHADOW = 25, LOD0_SHADOW_N = 2;
const LOD0_CAP = 8, LOD0_BACK = 4.5, POOL_MAX = 32;          // bound at once outside a fight; back-view reach; pool size
// 2026-09-25 (client play-test: 「いきなり作りこんだMOBが歩いていて、他の通行人から切り替わったり」): identity never changes
// in view. A pool body is bound to / unbound from a pedestrian ONLY where the swap cannot be seen -- outside the
// frustum (SWAP_R: the body plus its bag has to be clear of the frame), behind the lens, or past SWAP_D, which is
// DET_D: out there the far body is what hands over, so the pool replaces the far body inside the LOD step that already
// exists and never the part rig in view. Once bound and in view a body stays bound until the pedestrian leaves the
// view. Bodies are spent ahead of time: on whoever is going to pass nearest the lens soonest (PROSPECT_D / PROSPECT_T,
// the camera's own motion included). When the pool runs out the pedestrian keeps its instanced twin -- never a pop.
// A camera cut (camera:cut, a teleport, boot) frees everything for one pass: a cut hides any swap.
const SWAP_D = DET_D, SWAP_R = 1.6, PROSPECT_D = 27, PROSPECT_T = 9, PROSPECT_NEAR = 7;
// the scanned crowd (crowdScan.js): the pool body and its instanced twin are the same person playing the same clip at
// the same phase, so the lock only has to cover the geometry / shading step -- in view, nothing binds inside 14 m.
// SCAN_WAIT: the longest the boot waits for the scans before the legacy crowd is drawn instead.
const SCAN_SWAP_D = 14, SCAN_WAIT = 45000;
// 2026-09-25 round 5 ([pedscan]; the client looks at people at 2-5 m, and anyone inside ~7 m who was not one of the 8
// pool bodies stayed on the instanced lod1): the scanned crowd binds up to SCAN_LOD0_CAP bodies at once. Measured over
// 120 s (100 ms samples): inside 7 m AND in the frame, the static crossing_night lens sees at most 7 people, the player
// walking across the scramble into a WALK wave at most 20 (99th percentile 17; inside 14 m, 54). A bound body in view
// stays bound (the lock), so the ones between 7 and 14 m keep theirs too: with 8 bodies 18 % (static) / 26 % (walking)
// of the samples had somebody inside 7 m on the instanced tier, with 20 -> 21 %, 32 -> 0 % / ~10 %, 40 -> 6 % walking.
// 32 it is (the frame governor still takes it down to LOD0_MIN under load). Its prospects look SCAN_PROSPECT_T s ahead:
// somebody walking at the lens from 25 m is inside 14 m -- where the lock forbids a bind in view -- in ~8 s, and with a
// 9 s horizon their closest approach was judged at 12 m and they were never a prospect at all.
// ?scanPool=old is the round-4 binder (8 bodies, a 9 s / 7 m horizon) for A/B; ?scanPool=<n> another cap.
const SCAN_POOL_Q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('scanPool') : null;
const SCAN_POOL_OLD = SCAN_POOL_Q === 'old';
const SCAN_LOD0_CAP = SCAN_POOL_OLD ? LOD0_CAP : Number(SCAN_POOL_Q) > 0 ? Number(SCAN_POOL_Q) : 32;
const SCAN_PROSPECT_T = SCAN_POOL_OLD ? PROSPECT_T : 20, SCAN_PROSPECT_NEAR = SCAN_POOL_OLD ? PROSPECT_NEAR : 7.5;
const CW_BLEND = 3.0;
// 2026-09-26 (client: 「急にありえないくらい早く移動したり、足を高速にバタバタしたり」, docs/reports/crowd-motion.mjs):
//   SIM_DT      the crowd steps at most 1/30 s a frame (a long frame is slower, never a jump)
//   TICK_FULL_D everybody in the frame inside this steps every frame (past it and past the mid tier, at half rate);
//               off-screen people step at a quarter rate past TICK_OFF_D. A reduced rate is invisible: the frames
//               between two ticks carry the body on at its last tick's velocity and turn rate (carry()) -- it used to
//               stand still a frame and move two the next (a walker at 20 m read as 3.5-4.3 m/s)
//   PUSH_V      every correction that is not the person's own walking (the separation, the kerb, furniture, a car,
//               the lens, the player) moves them at most this fast; above STEP_V it is a step aside (it walks: the gait
//               counts it), below it a shuffle of the weight
//   VCAP        nobody but a runner is ever drawn moving faster than this (2.6: a walk's 2.5 steps/s at a step
//               the legs can make -- 3.0 let the player's shove carry a crosser at 2.8 m/s on 1.14 m steps)
//   LAT_V       a walker's lane (its offset across the pavement) changes at most this fast
//   YAW_RATE    nobody turns faster than this (rad/s)
const SIM_DT = 1 / 30, TICK_FULL_D = 20, TICK_OFF_D = 12, PUSH_V = 1.4, STEP_V = 0.25, VCAP = 2.6, LAT_V = 1.2, YAW_RATE = 4.5, YAW_MAX = 6.0, SEP_STILL_V = 0.15, WALK_VMAX = 2.9, WALK_OFF_V = 0.6, GAP_FADE_S = 0.6;
// clearance from a ground-floor shop front's glass / display case (city.frontClear): anyone >= FRONT_CLEAR, a window
// shopper looking in FRONT_SHOP (3.7-6 % of positions stood within 0.2 m of the glass)
const FRONT_CLEAR = 0.4, FRONT_SHOP = 0.7;
// a fight's lines of sight: nobody within LENS_W of the lens → 健人 / a fighting enemy; 健人's personal space PERSONAL_R
const LENS_W = 0.9, PERSONAL_R = 0.9;
// the same scan twice within DUP_D of each other, among the people within DUP_NEAR of the lens, is a duplicate
const DUP_NEAR = 22, DUP_D = 8;
// the outfits one notices twice (PED_SCANS roles): at most one of each within DUP_NEAR + DUP_CONSP of the lens, and a
// re-dressed person is given a plain one where it can be
const CONSP_ROLES = new Set(['tourist', 'otaku', 'host', 'nightlife']), DUP_CONSP = 30;
// ?motionDbg=1 (docs/reports/crowd-motion.mjs): every code path that moves a pedestrian tags the metres it moved them by,
// per frame, in p._md { tag: m } -- measurement only, no behaviour change
const MOTION_DBG = typeof location !== 'undefined' && /[?&]motionDbg=1/.test(location.search);                                        // m of pavement either side of a crossing eased onto its stripes
// 2026-09-25: the pool men are the procedural pedestrian body again. The client's enemy scans (?poolScan=1 for A/B)
// carry the enemies' own faces: a passer-by turned into the thug he is about to fight.
const POOL_SCAN = typeof location !== 'undefined' && /[?&]poolScan=1/.test(location.search);
// The lens bubble, in play and in every preset alike. Round 3's 6 m bubble left an empty moat round the camera (the
// critic: nobody inside 7 m at Center-gai, a ring of people standing on a circle at Hachiko). Now: a body WITHOUT a
// pool twin dissolves across the LENS_FADE band inside LENS_RIG (3 m); standing people are nudged 0.6-1.2 m sideways
// off the camera's forward axis instead of being re-seated on a rim; a pool body facing the lens is kept off that
// axis out to LENS_FACE (its painted face is not built for 3 m), one seen from behind comes to LENS_MIN. Nobody is
// drawn inside LENS_CUT.
const LENS_RIG = 3.0, LENS_FADE = 0.8, LENS_MIN = 2.4, LENS_FACE = 5.0, LENS_CUT = 1.0;
// the part rig's standing crown at scale 1 (hair cap top, measured off the geometry in init) -- the height every
// other tier (the pool bodies, the far body) is matched to, so nobody grows or shrinks at a LOD swap
const RIG_CROWN = 1.784;
// 2026-09-25: the pool is built through humanoid.js's pedestrian look API -- createHumanoid({ variant: 'pedestrian',
// seed, fem, outfit, hair, age, build, accessories }) -- one body per OUTFIT TEMPLATE. poolKey(p) names the template
// a twin's garment grammar needs (the outfit, the sex, and the cut: a coat over the suit, a skirt, a tie, a gakuran,
// a tee), poolSeedFor() searches resolvePedestrian() for a seed whose cut matches, and every twin of that key wears
// the body re-coloured in its own clothes (tintMap / retintHero: the body's vertex colours are re-keyed slot by slot
// against the look record it was resolved from, so a hoodie stays a hoodie, an apron an apron, a pleated skirt a
// pleated skirt, and the colours are the twin's). The keys the pool is seeded with at boot are the crossing's most
// common; after that it is grown toward whatever bindHeroes was denied (poolWant), one rebuild per POOL_REBUILD_T.
const POOL_KEYS_BOOT = ['suit.m.tie', 'hoodie.m', 'blouson.m', 'suit.m', 'hoodie.f', 'cardigan.f', 'dress.f.coat', 'suit.m.coat',
  'suit.f', 'dress.f', 'blouson.f', 'school.m', 'school.f', 'tourist.m', 'tourist.f', 'staff.m', 'suit.m.old', 'cardigan.f.old',
  'suit.f.skirt', 'school.m.gakuran', 'tourist.m.tee', 'tourist.f.tee', 'staff.f',
  'suit.m.tie', 'hoodie.m', 'blouson.m', 'suit.m'];                                // the second copies
const POOL_REBUILD_T = 2.5;
// The pool body is lit by humanoid.js's character shader: a sky / ground hemisphere (3.4 / 5.0 on cloth, lerped toward
// the nearest sign's colour), a 1.2 key and a 1.85 sign-hued rim that the instanced twin never gets -- under the
// SHIBUYA SKY blue LED that turned a navy twin's pool body electric cobalt with its shirt gone maroon under the Tojo
// Cola rim. The pool clones carry their own copies of those uniforms, scaled down, so the body wears the street's
// real lights like its twin does. (?poolLit=1 for A/B: the character shader's full terms.)
const POOL_LIT = typeof location !== 'undefined' && /[?&]poolLit=1/.test(location.search);
const POOL_HEMI_K = POOL_LIT ? 1 : 0.35, POOL_GND_K = POOL_LIT ? 1 : 0.35, POOL_KEY_K = POOL_LIT ? 1 : 0.55, POOL_RIM_K = POOL_LIT ? 1 : 0.45;
// A child stays on the part rig: every pool body is an adult (face, stubble, head-to-height ratio), and scaled down to
// 1.3 m it was a doll-sized grown man standing among the adults -- the client's "キャラが極端に小さくなる".
const KID_POOL = typeof location !== 'undefined' && /[?&]kidPool=1/.test(location.search);
// the template a pedestrian's look maps to (null: stays on the part rig -- the police vest, the happi collar band,
// the parka, a child). Cached on the pedestrian as p.pk once the seeders have finished (init).
function poolKey(p) {
  if (p.child && !KID_POOL) return null;
  if (p.police || p.role === 2) return null;
  const O = p.O, fem = p.fem, sx = fem ? 'f' : 'm';
  const skirt = fem && O.skirtTop > 0 && O.hemY < 0.74;
  const low = O.hemY < 0.74 && !skirt;                        // the top carried to a low hem: a coat, a parka, a dress
  switch (p.lookK) {
    case 'suit':
      if (fem) return skirt ? 'suit.f.skirt' : 'suit.f';
      return low ? 'suit.m.coat' : (O.tie === 1 ? 'suit.m.tie' : 'suit.m');
    case 'black':
      return low ? null : fem ? 'suit.f' : 'suit.m';
    case 'old':
      return fem ? 'cardigan.f.old' : 'suit.m.old';
    case 'staff':
      if (O.vest === 2) return 'staff.' + sx;
      return fem ? 'suit.f' : (O.tie === 1 ? 'suit.m.tie' : 'suit.m');
    case 'school':
      return fem ? 'school.f' : O.vBot > 1.45 ? 'school.m.gakuran' : 'school.m';
    case 'casual':
      if (skirt) return 'cardigan.f';
      if (low) return null;                                    // the parka: no template
      return (O.tie === 3 || O.openW > 0) ? 'blouson.' + sx : 'hoodie.' + sx;
    case 'shirt':
      return skirt ? 'cardigan.f' : 'blouson.' + sx;
    case 'dress':
      if (!fem) return null;
      if (skirt) return 'cardigan.f';
      return low && O.openW > 0 ? 'dress.f.coat' : 'dress.f';
    case 'colour': case 'street':
      return skirt ? 'cardigan.f' : 'hoodie.' + sx;
    case 'tourist':
      return O.bare ? 'tourist.' + sx + '.tee' : 'tourist.' + sx;
    default: return null;
  }
}
function poolable(p) { return (p.pk !== undefined ? p.pk : poolKey(p)) != null; }
// the createHumanoid options for a key, and the first seed (from a hash of the key) whose resolved cut matches it
function poolSeedFor(key, resolve, salt = 0) {
  const [outfit, sx, sub] = key.split('.'), fem = sx === 'f';
  // build: the crowd's mean girth (p.wide 0.92-1.14 for men, 0.88-1.0 for women), so the pelvis scale that maps a
  // twin's girth onto the body (updateHeroes) stays within a few percent
  const opts = { fem, outfit, hair: fem ? 'bob' : 'short', accessories: [], skin: 2, build: fem ? 0.94 : 1.03 };
  if (sub === 'old') opts.age = 0.78;
  const ok = (L) => {
    const G = L.cut;
    if (sub !== 'old' && (L.old || (L.gut || 0) > 0)) return false;
    switch (outfit) {
      case 'suit':
        if (fem) return sub === 'skirt' ? G.bottom === 'skirt' : G.bottom === 'trousers';
        if (sub === 'coat') return !!G.coat;
        return !G.coat && (sub === 'tie' ? !!G.tie : !G.tie);
      case 'dress': return sub === 'coat' ? !!G.coat : !G.coat;
      case 'school': return fem || (sub === 'gakuran' ? G.top === 'gakuran' : G.top === 'blazer');
      case 'tourist': return sub === 'tee' ? G.top === 'tee' : G.top === 'wind';
      case 'cardigan': return !fem || G.bottom === 'skirt';
      default: return true;
    }
  };
  let h = 7 + salt * 977;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const s0 = 7000 + (Math.abs(h) % 9000) * 13;
  for (let k = 0, s = s0; k < 600; k++, s += 131) { const L = resolve({ seed: s, ...opts }); if (ok(L)) return { seed: s, opts, look: L }; }
  return { seed: s0, opts, look: resolve({ seed: s0, ...opts }) };
}
// humanoid.js normalises a vertex-colour tint against the library map's mean albedo (BASE_ALBEDO, sRGB):
// vc = linear(hex) / linear(base). Retinting a pool body onto its instanced twin writes that same quantity.
const BASE_LIN = { suit: [40, 42, 50].map(c => Math.pow(c / 255, 2.2)), cloth: [128, 124, 118].map(c => Math.pow(c / 255, 2.2)), shoes: [20, 16, 14].map(c => Math.pow(c / 255, 2.2)),
  shirt: [236, 233, 226].map(c => Math.pow(c / 255, 2.2)), leather: [52, 38, 30].map(c => Math.pow(c / 255, 2.2)) };
// a pool material's tint key from its name (humanoid.js names them key + '#h')
function matKey(nm) { return nm.indexOf('suit') === 0 ? 'suit' : nm.indexOf('shoes') === 0 ? 'shoes' : nm.indexOf('shirt') === 0 ? 'shirt' : nm.indexOf('leather') === 0 ? 'leather' : nm.indexOf('cloth') === 0 ? 'cloth' : null; }
// inside this radius the instanced rig keeps its own smooth fade-out, so nothing pops against the lens
const LOD0_NEAR = 1.2;
// pool body: the Head joint's share of its bind offset (neck length), and the forearm / hand pronation (rad)
const NECK_K = 0.82, HERO_PRON = 0.9, POOL_OWN_HAIR_OFF = true;
// a scan's captured hands already hang palm-in, so the pronation the A-pose mannequin needs is per scan
const SCAN_PRON = { enforcer_a: 0, enforcer_b: 0, wanderer: 0 };
// A pool body's trousers may not be skin-like: a khaki or tan leg under the sodium key read as bare legs at 3 m
// (critic, player_closeup). A warm hue must be dark (L < 0.25) or near-grey (sat < 0.12), sRGB HSL.
const _plL = new THREE.Color(), _plS = new THREE.Color(), _plH = {}, _plH2 = {}, _cm = new THREE.Color();
// retintHero's guard: does the slot's mean rendered colour `m` still read as the twin's colour `c` (sRGB HSL:
// saturation within 0.15, hue within 20 degrees once both carry any chroma)?
function slotMatches(m, c) {
  m.getHSL(_plH, THREE.SRGBColorSpace); c.getHSL(_plH2, THREE.SRGBColorSpace);
  if (Math.abs(_plH.s - _plH2.s) > 0.15) return false;
  if (_plH.s > 0.1 && _plH2.s > 0.1) { let dh = Math.abs(_plH.h - _plH2.h); if (dh > 0.5) dh = 1 - dh; if (dh > 20 / 360) return false; }
  return true;
}
function poolLeg(c, out) {
  c.getHSL(_plH, THREE.SRGBColorSpace);
  if ((_plH.h > 0.16 && _plH.h < 0.96) || _plH.l < 0.25 || _plH.s < 0.12) return out.copy(c);
  return out.setHSL(_plH.h, 0.1, Math.min(_plH.l, 0.34), THREE.SRGBColorSpace);
}
// Round 3 held the floor at 0.72 because createHumanoid used to drop the neck / shoulder / pelvis bridges below it;
// validateRig() still guards every body, and measured 2026-09-24 the suit body passes at 0.4. 0.5 is 10.8 k triangles
// (0.72 was 15.0 k, 0.86 17.3 k): the head keeps 17 segments, the hands and shoes are detail-independent.
// Below 0.9 humanoid.js adds no eyeball draw, contact quads or LOD ladder.
const LOD0_DETAIL_MIN = 0.4;
const LOD0_DETAIL = [0.5];
// distance-sort buckets: 0.25 m in frustum, 0.5 m off-screen, one bucket for everything past CULL
const NB_VIS = CULL * 4, NB_TOTAL = NB_VIS + CULL * 2 + 1;
const GRID_N = 112, GRID_CELL = 2.0, SEP_R = 0.62;          // separation grid: 224 m window around the camera
const RESORT_T = 0.38, RESORT_D = 2.5;
const VEH_PAD = 0.35;                                        // OBB inflation for the vehicle push-out
const RG_CELL = 4, RG_HALF = 240, RG_N = 120;                // road-body grid for the car push-out (whole map)
const HALF_D = 18;                                           // past this the rig and far tier animate at 30 Hz
const VDIM = { car: [1.75, 4.4], taxi: [1.75, 4.6], van: [1.8, 4.8], bus: [2.5, 11] };

// body layout at scale 1 (1.80 m). Every part geometry is authored with its pivot at the local origin.
const HIP_Y = 0.90, KNEE_Y = 0.465, ANK_Y = 0.095, SHO_Y = 1.395;
const THIGH = HIP_Y - KNEE_Y, SHIN = KNEE_Y - ANK_Y, UARM = 0.29, FARM = 0.30;
// the arm pivot sits under the deltoid cap, just inside the 0.200 shoulder ring: the sleeve grows out of the
// shoulder line instead of hanging beside the torso. HAND_Y is the grip point (palm centre) in forearm space.
const HIP_X = 0.085, SHO_X = 0.192, HAND_Y = FARM + 0.06;
// shoe box in ankle-local space, used by the pseudo-IK ground clamp
const SHOE_Y0 = -0.095, SHOE_Y1 = -0.018, SHOE_Z0 = -0.078, SHOE_Z1 = 0.166;

// looks: coat/top colour pool, trouser pool, shoe, bare-arm chance (short sleeves), weight
const LOOKS = [
  { k: 'suit', w: 20, fem: 0.26, top: [0x1b1f2b, 0x222836, 0x14161c, 0x2b3040, 0x3a3f4e], leg: [0x14161c, 0x1b1f2b, 0x262b36], shoe: 0x0e0e12, bare: 0.02 },   // salaryman suits
  { k: 'casual', w: 13, fem: 0.38, top: [0x8e949c, 0x5f666e, 0x3d4a38, 0x7a3230, 0xcfcabe, 0x2f3a52], leg: [0x2a3450, 0x36404e, 0x1a1c22], shoe: 0x333338, bare: 0.10 }, // hoodie + jeans
  // no pure whites: a 0xf2f2f2 shirt clips to a blown paper cut-out in full sun and reads as a hole in the crowd
  { k: 'shirt', w: 10, fem: 0.34, top: [0xc9c2b2, 0xcfccc2, 0xbcb3a2, 0xa8b3bf], leg: [0x1a1c22, 0x2a2e38, 0x4a4f5a], shoe: 0x3a382f, bare: 0.34 },            // shirts
  { k: 'dress', w: 9, fem: 1, top: [0xf0c8d2, 0xd2a0c0, 0xc8d8e8, 0xe8d8a0, 0xe0a890, 0x8a3a4a, 0x3a4a6a, 0xb8a890], leg: [0x3a3f52, 0x6a6a72, 0x2a2a30], shoe: 0x40342b, bare: 0.40 },    // dresses / light coats
  { k: 'school', w: 8, fem: 0.5, top: [0x1e2a44, 0x22304c], leg: [0x1a1f2e, 0x20263a], shoe: 0x14141a, bare: 0.05, school: 1 },                                 // school uniforms
  { k: 'black', w: 8, fem: 0.42, top: [0x101014, 0x18181e, 0x2a1a1a], leg: [0x101014, 0x18181e], shoe: 0x0c0c10, bare: 0.03 },                                  // all black
  { k: 'colour', w: 7, fem: 0.45, top: [0x8a2a2a, 0x2a5a8a, 0x2f6a45, 0xb05a20, 0x6a3a7a], leg: [0x2a3450, 0x4a4a52, 0x24282f], shoe: 0x2e2f33, bare: 0.28 },    // colour blocks
  { k: 'tourist', w: 6, fem: 0.45, top: [0xcfc4a6, 0xa6bece, 0xcc8420, 0x2f9c82], leg: [0x8a8a90, 0xb4ac9c, 0x5a6a80], shoe: 0x46433d, bare: 0.55, tourist: 1 },  // tourists
  { k: 'staff', w: 5, fem: 0.3, top: [0x2a3a5a, 0x1c2a3a], leg: [0x1c2230, 0x232a38], shoe: 0x101014, bare: 0.02, staff: 1 },                                  // shop / station staff
  { k: 'old', w: 4, fem: 0.45, top: [0x6a6258, 0x7a7068, 0x4a4a4a], leg: [0x4a4a50, 0x5a5348], shoe: 0x2a2620, bare: 0.08, old: 1 },                          // elderly
  // Center-gai at 21:30 is a youth street: oversized light tees and hoodies, wide beige / light-denim trousers,
  // white sneakers, caps
  { k: 'street', w: 0, fem: 0.42, top: [0xd8d0c0, 0xe8e4dc, 0xb8c4d0, 0xc8b89c, 0x9aa8b8, 0x3a3a3e], leg: [0xc8c0b0, 0x8a96a8, 0x2a2c30, 0x6a7080, 0xa89c84], shoe: 0xb8b4aa, bare: 0.24 },
  // 交番 officers: navy tunic over the light-blue shirt, a lime reflective vest band, a cap
  { k: 'police', w: 0, fem: 0.08, top: [0x1c2436], leg: [0x1c2436, 0x1a2032], shoe: 0x0c0c10, bare: 0 },
  // izakaya キャッチ in the house happi: navy (or oxblood) with the white collar band down the front
  { k: 'happi', w: 0, fem: 0.15, top: [0x1a2a4a, 0x1c2438, 0x3a1a1c], leg: [0x1a1c22, 0x2a2e38], shoe: 0x1a1a1c, bare: 0.1 },
];
const LOOK_IX = Object.fromEntries(LOOKS.map((l, i) => [l.k, i]));
// Wardrobe per zone (weights by look). The single office-district mix put four navy suits into every five men on
// Center-gai; the salaryman-heavy table now only dresses the station-side pavements.
const WARDROBE = {
  youth: { suit: 6, casual: 20, shirt: 9, dress: 9, school: 4, black: 7, colour: 14, tourist: 10, staff: 2, old: 3, street: 18 },
  cross: { suit: 11, casual: 16, shirt: 10, dress: 9, school: 5, black: 7, colour: 11, tourist: 9, staff: 3, old: 4, street: 13 },
  station: { suit: 20, casual: 13, shirt: 10, dress: 9, school: 8, black: 8, colour: 7, tourist: 6, staff: 5, old: 4, street: 4 },
};
const WARD_T = {};
for (const z in WARDROBE) { const w = WARDROBE[z], a = LOOKS.map(l => w[l.k] || 0); WARD_T[z] = { a, t: a.reduce((q, v) => q + v, 0) }; }
const YOUTH_PATHS = new Set(['centergai', 'basketball', 'spainzaka', 'koen_promenade', 'miyashita_walk', 'nonbei_w', 'nonbei_e', 'inokashira', 'koen', 'plaza', 'bunkamura']);
// 2026-09-24 (client): 道玄坂 is a real hill now and 文化村通り is back in the showpiece -- their pavements are walked
// over this first stretch from the 109 apex (the window Plan A's 110 m round the crossing cut them out of)
const SLOPE_WIN = { dogenzaka: 115, bunkamura: 100 };
// dyed browns, kept dark and warm: a light tan dome under a street lamp reads as a bald scalp at 3-6 m
// (fix round 1: 0x80603c / 0x7a5634 were exactly that dome; the whole set is a shade under 0x4a3220 now)
const DYED = [0x4a3220, 0x52381e, 0x3e2a18, 0x46301c, 0x2e2016];
const CAPCOL = [0x16181c, 0x1e2a44, 0xd8d0c0, 0x3a3a3e, 0x6a5a48, 0x8a2a2a];
const SHIRTS = [0xd8dce0, 0xc8d4e4, 0xe0dcd2, 0xd4d8dc, 0xbcc8d8];
const TIES = [0x5a1620, 0x1a2644, 0x34343c, 0x5a4a20, 0x1a3a2a, 0x6a2a4a, 0x2a3a5a];
const TIGHTS = [0x1e1a1c, 0x2a2426, 0x3a302e];
const SKIRTS = [0x2a3048, 0x3a3a44, 0x2a3a34, 0x4a2a30, 0x1a1a20, 0x6a5a48, 0x8a8478];
// what shows under an open zip jacket, parka or coat: a tee or a shirt. No skin-adjacent browns (a bare chest), and
// no navy or near-black: at 3-5 m a dark layer in an open front reads as a slot cut through the body (the critic's
// Center-gai close-up). Light and mid tees, one grey, one wine.
const INNERS = [0xd8d4ca, 0xc8ccd0, 0xb8b0a0, 0xe0dcd2, 0x9aa0a8, 0x8a8478, 0x6a3a44];
// white sneakers: a 0xd6d4cc upper clipped to a paper cut-out under the Center-gai shopfronts
const SOLE_WHITE = 0xc6c2b8;
// jackets that are cut like the pool body's suit: its deep V is theirs too
const TAILORED = new Set(['suit', 'staff', 'school', 'police', 'old', 'black', 'happi']);

// Garment grammar: what a 15-60 m silhouette needs in order to read as a PERSON IN CLOTHES rather than a colour
// on a capsule -- where the hem stops and how it flares, what shows through the neckline (shirt and tie, an open
// collar, a coat worn open over a sweater), a skirt with legs under it, a short sleeve, a white sneaker sole.
//   hemY: 0.80 jacket, 0.87 untucked top, 0.93 tucked shirt, ~0.56 long coat / dress / skirt
//   vBot/vSlope/openW: neckline opening (V bottom y, half-width per metre above it, constant half-width of an
//   open front); tie: a strip of the accent colour down the opening; skirtTop: below it the garment is the accent
function dressPed(look, fem, child, top, leg, skin, rng) {
  const O = {
    hemY: 0.87, flare: 1.0, vBot: 9, vSlope: 0, openW: 0, tie: 0, skirtTop: 0, sleeveEnd: -9, legBare: 0,
    inner: skin, acc: leg, thigh: leg, shin: leg, shoe: look.shoe, sole: look.shoe, bare: rng() < look.bare,
    shape: fem ? [rng.range(0.88, 0.94), rng.range(0.86, 0.92), rng.range(1.04, 1.09), rng.range(1.02, 1.07)] : [rng.range(0.98, 1.06), rng.range(0.96, 1.04), 1.0, 1.0],
    // drape: per-person direction of the fold bump; vest: the police lime band (painted in the acc colour)
    drape: rng() * 0.98, vest: 0, legW: 1,
  };
  const bareLegs = (tightsP) => {
    O.legBare = 1;
    const t = rng() < tightsP ? rng.pick(TIGHTS) : skin;
    O.shin = t; O.thigh = t;
  };
  const crew = () => { O.vBot = 1.455; O.vSlope = 0.55; O.inner = skin; };       // a round neck: skin in the notch
  const openCollar = () => { O.vBot = 1.36; O.vSlope = 0.42; O.inner = skin; };
  const suitV = (tie) => { O.vBot = 1.19 + rng.range(0, 0.05); O.vSlope = 0.27; O.inner = rng.pick(SHIRTS); if (tie) { O.tie = 1; O.acc = rng.pick(TIES); } };
  const coat = (len) => { O.hemY = len; O.flare = 1.12 + rng.range(0, 0.08); };
  const skirt = (len, col) => { O.hemY = len; O.flare = rng.range(1.22, 1.36); O.skirtTop = 1.0; O.acc = col; };
  switch (look.k) {
    case 'suit':
      O.hemY = 0.80; O.flare = 1.02;
      if (fem) {
        suitV(false); O.vSlope = 0.32;
        if (rng() < 0.5) { O.hemY = 0.58; O.flare = 1.10; O.skirtTop = 0.80; O.acc = top; bareLegs(0.55); O.shoe = 0x0e0e12; O.sole = 0x0e0e12; }
      } else {
        suitV(rng() < 0.82);
        // a Shibuya autumn night: one salaryman in four has the overcoat buttoned over the suit -- the V with the
        // shirt and tie at the collar, the hem at the knee, the trousers below it
        if (rng() < 0.26) { coat(rng.range(0.56, 0.62)); O.flare = 1.10 + rng.range(0, 0.06); O.top = rng.pick([0x1b1f2b, 0x222836, 0x2b2a2e, 0x3a3630, 0x1c1c22]); }
      }
      break;
    case 'casual': {
      const r = rng();
      if (r < 0.45) { O.hemY = 0.86; crew(); }                                              // hoodie / sweatshirt
      else if (r < 0.80) {                                                                     // zip jacket over a tee
        O.hemY = 0.84; O.flare = 0.98; O.inner = rng.pick(INNERS);
        if (rng() < 0.62) { O.vBot = rng.range(1.27, 1.35); O.vSlope = 0.30; O.tie = 3; }            // zipped to the chest
        else { O.openW = 0.034; O.vBot = 1.22; O.vSlope = 0.2; }                                     // worn open
      } else {                                                                                  // parka
        coat(0.62); O.inner = rng.pick(INNERS);
        if (rng() < 0.5) { O.vBot = rng.range(1.30, 1.38); O.vSlope = 0.26; O.tie = 3; } else { O.openW = 0.036; O.vBot = 1.25; O.vSlope = 0.25; }
      }
      if (fem && rng() < 0.3) skirt(rng.range(0.52, 0.64), rng.pick(SKIRTS)), bareLegs(0.6);
      if (rng() < 0.62) O.sole = SOLE_WHITE;
      break;
    }
    case 'shirt':
      if (rng() < 0.5) { O.hemY = 0.93; O.skirtTop = 1.0; O.acc = leg; } else O.hemY = 0.87;   // tucked: the waistband shows
      openCollar();
      if (O.bare) O.sleeveEnd = -0.13;
      if (fem && rng() < 0.45) { skirt(rng.range(0.50, 0.62), rng.pick(SKIRTS)); bareLegs(0.3); }
      if (rng() < 0.3) O.sole = SOLE_WHITE;
      break;
    case 'dress': {
      const r = rng();
      if (r < 0.40) { O.hemY = rng.range(0.50, 0.62); O.flare = rng.range(1.18, 1.32); crew(); bareLegs(0.35); if (O.bare) O.sleeveEnd = -0.10; }
      else if (r < 0.75) { coat(rng.range(0.50, 0.58)); O.openW = 0.034; O.vBot = 1.30; O.vSlope = 0.22; O.inner = rng.pick(INNERS); if (rng() < 0.45) bareLegs(0.6); }
      else { skirt(rng.range(0.52, 0.64), rng.pick(SKIRTS)); crew(); bareLegs(0.3); if (O.bare) O.sleeveEnd = -0.12; }
      break;
    }
    case 'school':
      if (fem) {
        O.hemY = rng.range(0.56, 0.64); O.flare = rng.range(1.28, 1.40); O.skirtTop = 0.83; O.acc = rng.pick([0x2a3048, 0x3a3a44, 0x2a3a34, 0x4a3040]);
        suitV(false); O.tie = 1; O.accTie = 1; bareLegs(0.1);
      } else if (rng() < 0.45) { O.hemY = 0.80; O.vBot = 1.49; O.vSlope = 0; }            // gakuran: stand collar, no opening
      else { O.hemY = 0.81; suitV(true); }
      break;
    case 'black':
      if (rng() < 0.45) { coat(rng.range(0.50, 0.60)); O.openW = 0.03; O.vBot = 1.28; O.vSlope = 0.22; O.inner = rng.pick([0x2a2a30, 0x3a3a40, 0x8a8478]); }
      else { O.hemY = 0.80; O.vBot = 1.22; O.vSlope = 0.26; O.inner = rng.pick([0x2a2a30, 0x4a4a52, 0xcfc8ba]); }
      if (fem && rng() < 0.4) bareLegs(0.8);
      break;
    case 'colour':
      if (rng() < 0.5) { O.hemY = 0.84; O.flare = 1.04; crew(); } else { O.hemY = 0.87; crew(); if (O.bare) O.sleeveEnd = -0.13; }
      if (fem && rng() < 0.35) { skirt(rng.range(0.52, 0.64), rng.pick(SKIRTS)); bareLegs(0.4); }
      if (rng() < 0.55) O.sole = SOLE_WHITE;
      break;
    case 'tourist':
      O.hemY = 0.87; crew();
      if (O.bare) O.sleeveEnd = -0.13;
      if (rng() < 0.38) { O.legBare = 1; O.shin = skin; }                                 // shorts
      O.sole = rng() < 0.7 ? SOLE_WHITE : O.shoe;
      break;
    case 'staff':
      if (rng() < 0.5) {
        // shop / cafe floor staff: a shirt under a bib apron to the knee, the trousers showing behind it. The top slot
        // is the apron; the torso shader (vest 2) paints the shirt over the back and shoulders and the trousers under
        // the waist behind, and the sleeves are the shirt's
        O.hemY = rng.range(0.60, 0.66); O.flare = 1.04; O.vest = 2; O.top = rng.pick(APRONS);
        O.inner = rng.pick([0xe4e0d8, 0x1a1a1e, 0x2a3a5a, 0x6a2a2a, 0xd8d4ca]); O.sleeveCol = O.inner; O.acc = leg; O.tie = 0;
        O.vBot = 9; O.vSlope = 0; O.openW = 0;
        if (O.bare) O.sleeveEnd = -0.13;
      } else { O.hemY = 0.80; O.flare = 1.0; suitV(!fem); }
      break;
    case 'old':
      O.hemY = 0.80; O.vBot = 1.22; O.vSlope = 0.26; O.inner = rng.pick([0xcfc8ba, 0x8a8478, 0x6a3a3a]);
      if (fem) { O.hemY = 0.52; O.flare = 1.18; O.skirtTop = 0.86; O.acc = rng.pick(SKIRTS); }
      else O.shape[1] = rng.range(1.02, 1.10);                                          // a waistline that has seen some dinners
      break;
    case 'street': {
      // oversized: the top hangs long and wide off dropped shoulders, the trousers are cut wide
      O.hemY = rng.range(0.76, 0.82); O.flare = rng.range(1.06, 1.12); crew();
      O.shape[0] *= rng.range(1.05, 1.10); O.shape[1] *= 1.06; O.legW = rng.range(1.18, 1.32);
      if (rng() < 0.35) { O.openW = 0.03; O.vBot = 1.22; O.vSlope = 0.2; O.inner = rng.pick([0xe8e4dc, 0x2a2a30, 0x8a8478]); }  // open overshirt / zip hoodie
      if (O.bare) O.sleeveEnd = -0.16;
      if (fem && rng() < 0.3) { skirt(rng.range(0.50, 0.62), rng.pick([0x2a2c30, 0x6a5a48, 0x8a8478])); bareLegs(0.5); O.legW = 1; }
      O.sole = SOLE_WHITE;
      break;
    }
    case 'police':
      O.hemY = 0.80; O.flare = 1.0; O.vBot = 1.24; O.vSlope = 0.24; O.inner = 0x9fb6d4; O.vest = 1; O.acc = 0xc8d040;
      O.shape[0] = rng.range(1.02, 1.08);
      break;
    case 'happi':
      O.hemY = rng.range(0.80, 0.84); O.flare = 1.04; O.openW = 0.026; O.vBot = 1.18; O.vSlope = 0.22;
      O.inner = rng.pick([0x2a2a30, 0x1a1a1e, 0xd8d4cc]); O.tie = 2; O.acc = 0xe4e0d8;
      break;
  }
  if (child) { O.hemY = Math.max(O.hemY, 0.80); O.flare = Math.min(O.flare, 1.1); }
  if (O.bare && O.sleeveEnd < -1 && look.k !== 'suit' && look.k !== 'staff' && look.k !== 'school' && look.k !== 'police' && look.k !== 'happi') O.sleeveEnd = -0.13;
  if (!O.bare) O.sleeveEnd = -9;
  return O;
}
// A garment's linear albedo never goes under 0.05: a black suit is charcoal wool with a sheen, not a hole. Under the
// crossing's neon ~70 % of the mid band read as black cardboard cut-outs with the navy and black looks at 0.005-0.015.
// Scaled up (hue kept) to 3x, then lifted with grey.
const DARK_MIN = 0.05;
function liftDark(c) {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (l >= DARK_MIN) return c;
  const s = Math.min(3, DARK_MIN / Math.max(l, 1e-4));
  c.multiplyScalar(s);
  const d = DARK_MIN - l * s;
  if (d > 0) { c.r += d; c.g += d; c.b += d; }
  return c;
}
// The far body (past DET_D) has no fold relief, no lapel and no cloth bump to carry a highlight: at 25 m against a lit
// shopfront a 0.05 navy was a paper cut-out (fix round 1, critic: half the mid band). Its floor is 0.08, applied on
// the way into the far colour buffers (writeFarCol) so the twin's own colour record is untouched. Writes into `o` at
// `k` (3 floats) and returns nothing.
const FAR_DARK_MIN = 0.08;
function farLift(r, g, b, o, k) {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (l < FAR_DARK_MIN) {
    const s = Math.min(3, FAR_DARK_MIN / Math.max(l, 1e-4)), d = Math.max(0, FAR_DARK_MIN - l * s);
    r = r * s + d; g = g * s + d; b = b * s + d;
  }
  o[k] = r; o[k + 1] = g; o[k + 2] = b;
}
// Fix round 1 (critic: an all-cream figure, cream top over beige trousers on the lightest skin, read as a nude shop
// mannequin): sRGB luminance rules on the top / trouser pair. A top over 0.55 takes one of the look's two darkest
// trousers, and no top / trouser pair may both sit within 0.15 of the skin tone.
function srgbLum(hex) { return (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255; }
function legFor(look, top, leg, skin, rng) {
  const dark = look.leg.slice().sort((a, b) => srgbLum(a) - srgbLum(b));
  const Lt = srgbLum(top), Ls = srgbLum(skin);
  if (Lt > 0.55) leg = rng.pick(dark.slice(0, 2));
  if (Math.abs(Lt - Ls) < 0.15 && Math.abs(srgbLum(leg) - Ls) < 0.15) leg = dark[0];
  return leg;
}
// Standing poses. 0 relaxed (contrapposto), 1 arms folded, 2 hands in pockets, 3 phone at the chest, 4 filming,
// 5 hands on hips, 6 hand over the mouth, 7 pointing, 9 fist up, 10 phone at the ear, 11 a hand on the bag strap.
// The critic counted 8 of 12 standing figures in the arms-at-the-sides pose: 0 is at most a fifth of a crowd now,
// and 4 / 6 / 7 / 9 belong to the fight gallery only.
function idlePoseFor(rng, p) {
  const r = rng();
  if (r < 0.21) return 0;
  if (r < 0.34) return 1;
  if (r < 0.54) return 2;
  if (r < 0.72) return 3;
  if (r < 0.83) return 10;
  if (r < 0.95) return p.bagKind === 1 ? 11 : 2;
  return 5;
}
// the two warmest tones were saturated terracotta: under a neon chroma push they went tangerine at night
const SKIN = [0xd9a983, 0xe8c4a0, 0xba9275, 0xf0d0b8, 0xa98466, 0xcf9a74];
// nobody in a Shibuya crowd is platinum at a 20 % rate: the two light entries are a dark ash and a dyed brown,
// which at 30 m read as heads rather than as light bulbs in a navy crowd
// Three light entries out of ten (0x4a463f / 0x5f564d / 0x77674f) read at 6 m as BALD SCALPS: a light dome
// sitting on a skin-toned face atlas is exactly what a bald head looks like, and a third of the gate crowd
// had one. Shibuya is overwhelmingly black-haired with a brown-dye minority, so the light end is both rarer
// (3 of 16) and darker, and the shells carry a baked crown-to-nape gradient so hair has volume instead of
// being one flat tone painted on a ball.
// Fix round 1 (critic): under the night key the darkest entries (0x0d0a09 / 0x120e0c) were holes in the frame -- a
// long-haired head at 5 m a solid black wedge -- and the two dyed browns (0x38281a / 0x46342a) lifted to scalp-tan.
// The near band's floor is 0x1a1410; the far tier (a 10-40 px head, where a black head is what separates it from a
// navy coat) keeps the darker original through cHairFar. One dyed brown of 16, darkened to 0x2e2016.
const HAIR = [
  0x1a1410, 0x1c1512, 0x1b1512, 0x1a1410, 0x1a1412, 0x1d1613, 0x241a12, 0x1c1614,
  0x2a1e16, 0x201a18, 0x322418, 0x1a1512, 0x1b1512, 0x1c1613, 0x1b1511,
  0x2e2016,
];
const HAIR_FAR = { 0x1a1410: 0x0d0a09, 0x1c1512: 0x120e0c, 0x1b1512: 0x0f0c0b, 0x1a1412: 0x100d0d, 0x1b1511: 0x13100e };
// Shibuya's dominant umbrella is the transparent vinyl one: 5 of 12 are vinyl, the rest are real colours
const UMB = [
  { c: 0xdfeaf2, v: 1 }, { c: 0xe8f0f4, v: 1 }, { c: 0xd2e0ea, v: 1 }, { c: 0xe2eef4, v: 1 },
  { c: 0xcedee8, v: 1 }, { c: 0xdae6ee, v: 1 },
  // a field of identical dark canopies is as flat as a field of identical pale bodies was: the opaque half
  // carries real chroma so the rain frames read as a Shibuya crossing and not as a mushroom farm
  { c: 0x16181c, v: 0 }, { c: 0x1e2a44, v: 0 }, { c: 0x94222c, v: 0 }, { c: 0x2a6a52, v: 0 },
  { c: 0xb4b0a4, v: 0 }, { c: 0xe0bf58, v: 0 }, { c: 0x4a3a78, v: 0 }, { c: 0xc4566a, v: 0 },
  { c: 0x2f4f7a, v: 0 }, { c: 0x6a6258, v: 0 },
];
const BAGCOL = [0x181a20, 0x2a2420, 0x5a3a2a, 0x3a4050, 0x8a2a30, 0x101014, 0xc8b898];
const APRONS = [0x1e2a24, 0x1a1a1e, 0x4a3424, 0x2a3450, 0x6a2a2a, 0x8a8478];   // the staff's bib aprons
// the wider street palette a companion's top is redrawn from (decorrelate)
const ALT_TOPS = [0x2f3a52, 0x7a3230, 0x3d4a38, 0x8e949c, 0x5a4a6a, 0xb05a20, 0x1b1f2b, 0x6a5a48, 0x2a5a8a, 0xcfc4a6, 0x3a3a3e, 0x9a4a5a];
const _hsl = {};
const BIKECOL = [0xd8d8d0, 0x2a2c30, 0x8a2a2a, 0x3a5a7a, 0xc8b070, 0x4a6a4a, 0xe4e4e0, 0x6a4a6a];
const FACE_OFF = [[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]];   // 2x2 face atlas tile origins (uv space)

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _hq = new THREE.Quaternion(), _qt = new THREE.Quaternion();
const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _m2 = new THREE.Matrix4();
const _c = new THREE.Color(), _ct = new THREE.Color();
const UPY = new THREE.Vector3(0, 1, 0), RIGHTX = new THREE.Vector3(1, 0, 0), FWDZ = new THREE.Vector3(0, 0, 1);
const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sph = new THREE.Sphere(new THREE.Vector3(), 1.3);
const _sph2 = new THREE.Sphere(new THREE.Vector3(), 1.6);    // the identity lock's in-view test (SWAP_R)

// humanoid.js bone hierarchy (parents first), for posing the pool bodies bone by bone
const BONE_ORDER = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];
const RIG_PARENT = { Hips: null, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot' };
const _W = {}, _P = {}, _qy = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _qid = new THREE.Quaternion(), _e = new THREE.Euler();
// the pool body's face atlas averages this tone (humanoid.js PED_SKINS, linear): the skin material is scaled from it to the twin's
const SKIN_LIN = [174, 130, 106].map(c => Math.pow(c / 255, 2.2));
const TC_ONE = [1, 1, 1, 0, 0, 0, 1, 1, 1];
const SIDE_BONES = ['Left', 'Right'].map(s => Object.fromEntries(['Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase'].map(k => [k, s + k])));
// poseHero / heroAcc helpers, module level so a pool body's pose allocates nothing per frame
function heroRot(ry, rx, rz, out) { _e.set(rx, ry, rz, 'YXZ'); return out.setFromEuler(_e); }
// W[name] = yaw^-1 * q (the twin's segment, yaw taken out) * (R0: bind direction -> hanging straight down) * bind
function heroLimb(W, R, name, q, r0) { return (W[name] || (W[name] = new THREE.Quaternion())).copy(_qy).multiply(q).multiply(r0 ? R.R0[name] : _qid).multiply(R.W[name]); }
// a limb turned about its own long axis after the swing (the forearm's pronation: palms to the thighs, not forward)
function heroTwist(W, name, a) { if (a) W[name].multiply(_qc.setFromAxisAngle(UPY, a)); }
// grip point (palm centre) in body space, for the hand props: no matrix walk needed
function heroGrip(H, W, P, n, dy, out) { return out.set(0, 0.08, 0).applyQuaternion(W[n]).add(P[n]).add(H.rig.host).add(_v.set(H.sway, dy, 0)); }
// torso space -> Spine2 bone space at bind: undo the bone's bind rotation, offset by its bind joint position
function accSpine(m, R, ks, x, y, z) { m.quaternion.copy(R.W.Spine2).invert(); m.scale.setScalar(ks); m.position.set(-R.P.Spine2.x + x, -R.P.Spine2.y + y, -R.P.Spine2.z + z).applyQuaternion(m.quaternion); }
// the part rig's head space (skull centre y 1.658) onto the pool body's own skull centre
function accHead(m, R, s, y, sy = s) { m.quaternion.copy(R.W.Head).invert(); m.scale.set(s, sy, s); m.position.set(-R.P.Head.x, -1.658 * sy + R.skullY - R.P.Head.y + y, -R.P.Head.z).applyQuaternion(m.quaternion); }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hash01 = (i) => (((i + 1) * 2654435761) >>> 0) / 4294967296;
// turn toward a heading at `rate` (1/s, eased) but never faster than YAW_RATE rad/s
// A person's own walking pace changes at human rates: up to speed over ~0.6 s (a green man, the end of a U-turn, a
// waiting spot) and down at ACC_DN. 0 -> 1.4 m/s in one frame was a body gliding off before its legs caught up.
const ACC_UP = 2.2, ACC_DN = 3.0;
function accel(p, vt, dt) { const c = p.cv == null || p.cv < 0 ? vt : p.cv; return (p.cv = c + clamp(vt - c, -ACC_DN * dt, ACC_UP * dt)); }
function turnTo(p, target, dt, rate) { const d = wrapPi(target - p.yaw), m = YAW_RATE * dt; p.yaw += clamp(d * Math.min(1, dt * rate), -m, m); }
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// ---- gait. u is one leg's cycle phase, 0 at heel strike (the leg fully forward), 0.5 with it fully back.
// Round 5's knee was a clipped sine that peaked late in the swing and still held 0.7 rad at heel strike, and the
// shoe followed the shin, so both legs read as a pair of compasses. These are the textbook curves, shortened.
// knee flexion: a small loading bump after contact, straight through mid-stance, the big swing flexion peaking at
// the passing position, straight again for the next heel strike
function gaitKnee(u, swing, load) {
  const a = (u - 0.10) / 0.09, d = u - 0.72;
  const g = d < 0 ? Math.exp(-(d / 0.17) * (d / 0.17)) : Math.exp(-(d / 0.10) * (d / 0.10));
  return 0.05 + load * Math.exp(-a * a) + swing * g;
}
// absolute foot pitch (+ = toe down): heel strike toe-up, flat through stance, heel rise to toe-off, toe up again
// to clear the ground through the swing
function gaitFoot(u) {
  if (u < 0.08) return -0.22 * (1 - sstep(0, 0.08, u));
  if (u < 0.38) return 0;
  if (u < 0.58) return 0.60 * sstep(0.38, 0.58, u);
  if (u < 0.74) return 0.60 - 0.70 * sstep(0.58, 0.74, u);
  return -0.10 - 0.12 * sstep(0.74, 1.0, u);
}
// hip swing amplitude (rad) for a pace; the phase then advances by pi per step LENGTH, so the planted foot keeps
// pace with the ground on average whatever the body's speed and build
function gaitStride(v, jog) { return jog ? 0.40 : clamp(0.18 + 0.13 * v, 0.16, 0.36); }
function stepLen(v, jog, scale, k) { const st = gaitStride(v, jog) * k; return 2 * 0.805 * scale * Math.sin(st) + (jog ? 0.24 : 0.12) * scale; }
function advance(p, v, dt) { if (v > 1e-3) p.phase += Math.PI * v * dt / stepLen(v, v > 1.9, p.scale, p.strideK); }
function nightK(h) { return h < 4.8 || h >= 19.4 ? 1 : h < 6.6 ? clamp((6.6 - h) / 1.8, 0, 1) : h > 17.5 ? clamp((h - 17.5) / 1.9, 0, 1) : 0; }
function wrapPi(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

// The skull's u is remapped so the front ±0.09 of the circumference owns 76 % of the tile: without this the
// 128 px feature band is smeared across two quads and minifies to a brown stain. Everything outside the window
// lands in the guard band, which is painted flat skin so nothing can smear along the cheeks.
function faceUV(g) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    let d = uv.getX(i) - 0.25;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    const e = (uv.getY(i) - 0.54) / 0.22;
    const nu = Math.abs(d) <= 0.09 ? 0.5 + (d / 0.09) * 0.38 : (d < 0 ? 0.055 : 0.945);
    const nv = Math.abs(e) <= 1 ? 0.5 + e * 0.38 : (e < 0 ? 0.055 : 0.945);
    uv.setXY(i, nu, nv);
  }
  uv.needsUpdate = true;
}

// The tile base is NOT white. The head material multiplies this map by the per-instance skin tone, so a white
// base hands back the raw tone -- a bone-coloured egg. A slightly shaded base plus a dark feature mass is what
// keeps a face reading once the tile is minified.
const FACE_BASE = '#eddfd2', FACE_BASE_SMALL = '#d6c5b7';

// one tile of the 2x2 atlas; nu/nv are tile-local, art confined to 0.12..0.88 with a guard band.
// `b` is the minification boost (0 at mip 0): features grow and gain alpha as the tile shrinks, so the eye
// band, brow and mouth survive all the way down the chain instead of averaging into flat skin.
function drawFace(g, ox, oy, S, vi, b = 0) {
  const X = (u) => ox + u * S, Y = (v) => oy + (1 - v) * S, W = (u) => u * S;
  const R = (r) => r * (1 + b * 0.85);                                          // feature growth
  const A = (a) => a + (1 - a) * b * 0.9;                                       // feature opacity
  const rgba = (r, gg, bb, a) => `rgba(${r},${gg},${bb},${A(a).toFixed(3)})`;
  const raw = (r, gg, bb, a) => `rgba(${r},${gg},${bb},${a.toFixed(3)})`;
  const ell = (u, v, ru, rv, style, gk = 1) => { const k = 1 + b * 0.85 * gk; g.fillStyle = style; g.beginPath(); g.ellipse(X(u), Y(v), W(ru * k), W(rv * k), 0, 0, Math.PI * 2); g.fill(); };
  // Heads 8-20 m out sample the S <= 64 levels. There the boosted fringe, brow and lid merged into one black bar
  // across the eyes (a square of sunglasses at night): on those levels the brow and lid are capped and do not grow
  const mid = S <= 64, capA = (a, m) => Math.min(A(a), mid ? m : 1);
  // at 32 px and below (a head 8-15 m out) a white sclera with a boosted iris averages to a pale mask with two
  // holes in it: the eye is drawn as a soft socket shadow there, and the tile base drops a step
  const small = S <= 32;
  // fix round 1 (critic: the whole of Center-gai in sunglasses at 8-20 m): on the 64 / 32 px levels the socket, the
  // lid line and the brow still merged into one bar. Socket alpha <= 0.12 and the lid <= 0.26 when small, and the
  // brow sits 0.03 higher on both levels so lid and brow never bridge. (The boost b is capped at 0.2 there too.)
  const browUp = mid ? 0.03 : 0;
  g.save(); g.beginPath(); g.rect(ox, oy, S, S); g.clip();
  g.fillStyle = small ? FACE_BASE_SMALL : FACE_BASE; g.fillRect(ox, oy, S, S);

  // rounding: temples darken toward the guard band, jaw and hairline carry the contrast pass
  const lg = g.createLinearGradient(X(0), 0, X(1), 0);
  lg.addColorStop(0, rgba(96, 66, 52, 0.46)); lg.addColorStop(0.24, 'rgba(255,255,255,0)');
  lg.addColorStop(0.76, 'rgba(255,255,255,0)'); lg.addColorStop(1, rgba(96, 66, 52, 0.46));
  g.fillStyle = lg; g.fillRect(ox, oy, S, S);
  // fringe shadow on the forehead: it stops well above the brow (it ran to v 0.60 at 0.86 and joined the brow)
  const vg = g.createLinearGradient(0, Y(0.99), 0, Y(0.80));
  vg.addColorStop(0, raw(38, 26, 19, 0.45)); vg.addColorStop(1, 'rgba(38,26,19,0)');
  g.fillStyle = vg; g.fillRect(ox, oy, S, S);
  const jg = g.createLinearGradient(0, Y(0.05), 0, Y(0.30));
  jg.addColorStop(0, rgba(52, 35, 26, 0.62)); jg.addColorStop(1, 'rgba(52,35,26,0)');
  g.fillStyle = jg; g.fillRect(ox, oy, S, S);                                   // under-jaw

  const sep = 0.246, eyeV = 0.545, browV = 0.638, noseV = 0.438, mouthV = 0.318;
  // low-frequency mass first. Round 5's band (0.30), socket (0.45), lid (0.86) and a solid brow merged into one
  // dark bar at 3-4 m that read as sunglasses: the shading is kept but at low contrast, and the eye itself stays
  // a light almond with a dark iris in it at every size
  ell(0.5, eyeV + 0.030, 0.400, 0.086, raw(46, 31, 23, 0.11), 0.3);
  const brow = [0.040, 0.046, 0.034, 0.043][vi], iris = [0.046, 0.050, 0.042, 0.048][vi];
  // a light brow-bone / cheek band between the eye line and the brow, so the two never merge into one bar
  g.fillStyle = 'rgba(255,238,224,0.12)'; g.fillRect(ox, Y(0.62), S, W(0.04));
  g.fillStyle = 'rgba(255,238,224,0.08)'; g.fillRect(ox + W(0.14), Y(0.50), W(0.72), W(0.04));
  for (let k = -1; k <= 1; k += 2) {
    const cu = 0.5 + k * sep;
    ell(cu, eyeV - 0.008, 0.132, 0.080, raw(104, 70, 54, small ? 0.12 : Math.min(A(0.22), mid ? 0.24 : 0.34)), 0.5); // socket
    if (small) {
      ell(cu, eyeV, 0.100, 0.036, rgba(196, 184, 174, 0.55));                  // sclera, lifted
      ell(cu + k * 0.008, eyeV, iris * 1.25, 0.034, rgba(52, 36, 28, 0.58));    // iris + lashes as one soft mark
    } else {
      ell(cu, eyeV, 0.104, 0.040, rgba(232, 226, 220, 0.80));                   // sclera
      ell(cu + k * 0.008, eyeV, iris, 0.042, rgba(46, 32, 25, 0.95));           // iris
      ell(cu + k * 0.008, eyeV, iris * 0.46, 0.020, 'rgba(10,8,8,0.9)');       // pupil
      ell(cu - k * 0.028, eyeV + 0.017, 0.018, 0.008, 'rgba(255,255,255,0.55)'); // catchlight
    }
    ell(cu, eyeV + 0.038, 0.108, 0.016, raw(30, 20, 16, capA(small ? 0.40 : 0.60, small ? 0.26 : 0.30)), 0.5); // upper lid line
    ell(cu, browV + browUp, 0.140, brow, raw(40, 28, 21, capA(0.70, small ? 0.34 : 0.40)), 0.3);   // brow
  }
  ell(0.5, noseV + 0.028, 0.052, 0.062, rgba(146, 104, 84, 0.26));              // nose bridge shadow
  ell(0.5, noseV, 0.062, 0.030, rgba(126, 88, 70, 0.34));                       // nose tip
  for (let k = -1; k <= 1; k += 2) ell(0.5 + k * 0.044, noseV - 0.010, 0.016, 0.010, rgba(58, 38, 30, 0.60));
  ell(0.5, mouthV, [0.150, 0.168, 0.138, 0.158][vi], 0.050, rgba(150, 90, 82, 0.46));
  ell(0.5, mouthV, [0.146, 0.164, 0.134, 0.154][vi], 0.026, rgba(70, 36, 34, 0.88));
  if (vi === 2) {                                                               // glasses
    g.strokeStyle = rgba(28, 24, 24, 0.86); g.lineWidth = Math.max(1, S * 0.014 * (1 + b));
    for (let k = -1; k <= 1; k += 2) { g.beginPath(); g.ellipse(X(0.5 + k * sep), Y(eyeV), W(0.148), W(0.086), 0, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(X(0.5 - 0.098), Y(eyeV)); g.lineTo(X(0.5 + 0.098), Y(eyeV)); g.stroke();
  }
  if (vi === 3) ell(0.5, mouthV + 0.062, 0.110, 0.030, rgba(48, 34, 26, 0.44)); // moustache shadow
  if (vi === 1) ell(0.5, mouthV - 0.070, 0.150, 0.048, rgba(60, 42, 32, 0.26)); // stubble on the chin
  g.restore();
}

// The mip chain is authored, not averaged. GL's box filter turns a 256 px face into flat skin by mip 3 (a
// ~25 px head, i.e. ~10 m), which is the "field of blank eggs" the critic measured; redrawing each level with
// the features boosted keeps the eye band and brow at every distance, and keeps trilinear filtering so 2 500
// moving heads do not sparkle.
function faceTexture(aniso) {
  const S0 = 256, mips = [];
  for (let S = S0; S >= 1; S >>= 1) {
    const c = document.createElement('canvas'); c.width = c.height = Math.max(1, S * 2);
    const g = c.getContext('2d');
    g.fillStyle = S > 32 ? FACE_BASE : S >= 8 ? FACE_BASE_SMALL : '#c0a18c'; g.fillRect(0, 0, c.width, c.height);
    if (S >= 8) {
      // capped at 0.5: the full boost painted a face brighter and harder than the backlit head it sits on
      // ...and at 0.2 on the 64 / 32 px levels (a 25-50 px head, 8-20 m): with b at 0.4-0.5 there the grown socket,
      // lid and brow met in one dark bar across the eyes
      const b = Math.min(S === 64 || S === 32 ? 0.2 : S === 16 ? 0.35 : 0.5, clamp((Math.log2(S0) - Math.log2(S)) / 5, 0, 1));
      for (let v = 0; v < 4; v++) drawFace(g, (v & 1) * S, (v >> 1) * S, S, v, b);
    }
    mips.push(c);
  }
  const t = new THREE.CanvasTexture(mips[0]);
  t.mipmaps = mips; t.generateMipmaps = false;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso || 1; t.needsUpdate = true;
  return t;
}

// Ground decals get the same authored mip chain as the face atlas, and for the same reason: a radial gradient
// painted on a white border box-filters to near-white by mip 3, at which point MultiplyBlending is a no-op and
// 300 bodies past ~15 m lose every trace of ground contact. Each level is redrawn with the dark core grown by
// the minification boost, and the border is a mid grey so even an averaged tap keeps some occlusion.
function decalTexture(S0, core, mid, coreCol = '#1a1a1a') {
  const mips = [];
  for (let S = S0; S >= 1; S >>= 1) {
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    const b = clamp((Math.log2(S0) - Math.log2(S)) / 4, 0, 1);
    // outside the disc stays a shade under white so a blurred tap cannot brighten the tile back to a no-op,
    // but the gradient itself must REACH white at the disc rim or the decal ships a hard-edged black lozenge
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, S, S);
    if (S >= 4) {
      const R = S * 0.5, k = 1 + b * 0.8;
      const gr = g.createRadialGradient(R, R, R * 0.02, R, R, R);
      gr.addColorStop(0, '#000000');
      gr.addColorStop(clamp(core * k, 0.02, 0.85), coreCol);
      gr.addColorStop(clamp(mid * k, 0.12, 0.95), '#8a8a8a');
      gr.addColorStop(1, '#ffffff');
      g.fillStyle = gr; g.beginPath(); g.arc(R, R, R, 0, Math.PI * 2); g.fill();
    } else { g.fillStyle = '#5a5a5a'; g.fillRect(0, 0, S, S); }
    mips.push(c);
  }
  const t = new THREE.CanvasTexture(mips[0]);
  t.mipmaps = mips; t.generateMipmaps = false;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}

// a small additive sprite for the phone screen spill
function glowTexture() {
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0.5, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(210,228,255,1)'); gr.addColorStop(0.30, 'rgba(150,180,225,0.55)');
  gr.addColorStop(0.70, 'rgba(90,120,175,0.14)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}

// bake a vertex-colour gradient so a limb reads as attached: darkest at the proximal end, white at the distal
function vcAO(geo, y0, y1, dark) {
  const pos = geo.attributes.position, n = pos.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    const u = clamp((y - y1) / (y0 - y1), 0, 1);                       // 1 at the proximal end
    const v = 1 - (1 - dark) * u * u;
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// hair volume: the crown catches the sky, the nape and the underside of the fringe sit in shadow. Without a
// value break the shell is one flat tone and a head reads as a painted ball rather than as hair over a skull.
function hairShade(geo) {
  const pos = geo.attributes.position, n = pos.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i), z = pos.getZ(i);
    // the crown never reaches full value: a small dome whose brightest point is its centre, wrapped in a
    // grazing-angle env specular, is exactly the silhouette of a bald scalp
    let v = 0.50 + 0.40 * clamp((y - 1.495) / 0.245, 0, 1);
    v *= 0.92 + 0.08 * clamp((z + 0.11) / 0.22, 0, 1);            // back of the head one step down
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function vcFlat(geo, v) {
  const n = geo.attributes.position.count, col = new Float32Array(n * 3);
  col.fill(v);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// Lofted tube through superelliptic cross-sections. Round 3 built every body part out of cylinders and spheres,
// and at 15-60 m -- the band most of a wide shot is made of -- that reads as a peg doll: a torso of one width from
// hip to shoulder, arms as dowels, legs as broom handles. A loft lets each part carry the real profile (chest ->
// waist -> hip taper, deltoid cap, knee, calf, trouser break) for about the same triangle count.
//   ring: { y, hw, hd, x, z, e, sl }  e = superellipse exponent (2 ellipse, 3 squarish), sl = drop at |x| = hw
// Rings may run up or down the part; the winding follows so the faces always point out. capFirst / capLast
// close ring 0 / the last ring with a fan whose centre is pushed `value` metres along +y (false = open).
// Returns { geo, ring } where ring[i] is the ring index of vertex i (caps get the end ring's index).
function loft(rings, seg, capFirst, capLast) {
  const pos = [], idx = [], ring = [];
  const down = rings[rings.length - 1].y < rings[0].y;
  for (let r = 0; r < rings.length; r++) {
    const R = rings[r], e = R.e || 2, x0 = R.x || 0, z0 = R.z || 0;
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const u = Math.sign(c) * Math.pow(Math.abs(c), 2 / e), w = Math.sign(s) * Math.pow(Math.abs(s), 2 / e);
      pos.push(x0 + R.hw * u, R.y - (R.sl || 0) * u * u, z0 + R.hd * w);
      ring.push(r);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) for (let j = 0; j < seg; j++) {
    const a = r * seg + j, b = r * seg + (j + 1) % seg, c = a + seg, d = b + seg;
    if (down) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  // a cap faces +y when its ring is the upper end of the part
  const cap = (r, dy, up) => {
    const R = rings[r], ci = pos.length / 3;
    pos.push(R.x || 0, R.y + dy, R.z || 0); ring.push(r);
    for (let j = 0; j < seg; j++) { const a = r * seg + j, b = r * seg + (j + 1) % seg; if (up) idx.push(ci, b, a); else idx.push(ci, a, b); }
  };
  if (capFirst !== false && capFirst != null) cap(0, +capFirst || 0, down);
  if (capLast !== false && capLast != null) cap(rings.length - 1, +capLast || 0, !down);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return { geo, ring };
}

// per-ring value -> vertex colour (baked AO). `f(ringIndex, x, y, z)` returns the grey value.
function vcRing(geo, ring, f) {
  const pos = geo.attributes.position, n = pos.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = f(ring[i], pos.getX(i), pos.getY(i), pos.getZ(i)); col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// the attribute set every merged crowd part must share (mergeGeometries refuses mismatched sets)
function onlyAttrs(geo, names) {
  for (const k of Object.keys(geo.attributes)) if (!names.includes(k)) geo.deleteAttribute(k);
  return geo;
}

// ------------------------------------------------------------------------------------------------- geometry
function buildParts() {
  const G = {};
  // Torso: one loft from the jacket hem to the collar. Width runs hem 0.36 -> hip 0.35 -> waist 0.31 -> chest
  // 0.34 -> shoulder 0.40 and the top two rings slope down from the neck, so the silhouette has a waist, a
  // chest and a trapezius instead of the round-3 drum. Per-ring morph weights let the vertex shader give each
  // pedestrian its own build and garment length without a second mesh: aMorph = (shoulder, waist, hip, hem).
  //   y      hw     hd     z       e    sl     shoulder waist hip  hem   ao
  const TR = [
    [0.800, 0.180, 0.127, 0.000, 2.2, 0.000, 0.0, 0.0, 0.8, 1.0, 0.70],
    [0.865, 0.178, 0.123, 0.000, 2.2, 0.000, 0.0, 0.0, 1.0, 0.5, 0.84],
    [0.930, 0.175, 0.118, -0.004, 2.3, 0.000, 0.0, 0.1, 1.0, 0.0, 0.92],
    [1.000, 0.164, 0.112, 0.000, 2.3, 0.000, 0.0, 0.6, 0.5, 0.0, 0.96],
    [1.070, 0.155, 0.108, 0.005, 2.3, 0.000, 0.0, 1.0, 0.1, 0.0, 1.00],
    [1.170, 0.160, 0.118, 0.013, 2.4, 0.000, 0.2, 0.6, 0.0, 0.0, 1.00],
    [1.270, 0.167, 0.127, 0.017, 2.6, 0.000, 0.5, 0.1, 0.0, 0.0, 1.00],
    [1.350, 0.176, 0.121, 0.011, 2.8, 0.000, 0.8, 0.0, 0.0, 0.0, 0.97],
    [1.438, 0.200, 0.104, 0.000, 3.0, 0.024, 1.0, 0.0, 0.0, 0.0, 0.94],
    [1.480, 0.132, 0.083, -0.008, 2.4, 0.022, 0.6, 0.0, 0.0, 0.0, 0.86],
    [1.505, 0.066, 0.060, 0.004, 2.0, 0.000, 0.0, 0.0, 0.0, 0.0, 0.74],
    [1.514, 0.051, 0.048, 0.006, 2.0, 0.000, 0.0, 0.0, 0.0, 0.0, 0.66],
  ];
  {
    const { geo, ring } = loft(TR.map(r => ({ y: r[0], hw: r[1], hd: r[2], z: r[3], e: r[4], sl: r[5] })), 12);
    const n = geo.attributes.position.count, mo = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { const R = TR[ring[i]]; mo[i * 4] = R[6]; mo[i * 4 + 1] = R[7]; mo[i * 4 + 2] = R[8]; mo[i * 4 + 3] = R[9]; }
    geo.setAttribute('aMorph', new THREE.BufferAttribute(mo, 4));
    // baked AO: the hem underside, the waist, the armpit where the arm shades the flank, the collar
    vcRing(geo, ring, (r, x, y, z) => {
      let v = TR[r][10];
      const u = Math.abs(x) / TR[r][1];
      if (y > 1.22 && y < 1.40 && u > 0.78) v *= 0.80;
      return v;
    });
    G.torso = geo;
  }

  // Head: the round-3 skull was a 12x8 sphere, i.e. an egg. A jaw that narrows below the cheekbones, a chin
  // that sits forward of the throat and an occiput that bulges behind the neck line are what make a head read
  // as a head at 20 m in profile; two ears give the back view a silhouette the hair shell alone does not.
  const neck = new THREE.CylinderGeometry(0.051, 0.060, 0.17, 7, 1, true); neck.translate(0, 1.487, 0.004);
  // the neck samples a plain cheek texel: the old guard-band texel sat under the fringe shadow, so every neck
  // was a darker, redder cylinder than the face above it
  const NECK_UV = [0.30, 0.40];
  const nuv = neck.attributes.uv; for (let i = 0; i < nuv.count; i++) nuv.setXY(i, NECK_UV[0], NECK_UV[1]);
  const skull = new THREE.SphereGeometry(0.086, 12, 8); faceUV(skull);
  skull.scale(1, 1.16, 1.08);
  {
    const p = skull.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const lo = clamp((-0.010 - y) / 0.085, 0, 1);            // below the cheekbone
      x *= 1 - 0.30 * lo * lo;                                 // jaw narrows to the chin
      if (z > 0) z *= 1 + 0.10 * lo - 0.06 * clamp((y - 0.03) / 0.06, 0, 1);   // chin forward, brow flat
      else z *= 1 + 0.10 * clamp((y + 0.02) / 0.07, 0, 1) - 0.18 * lo;         // occiput out, nape in
      p.setXYZ(i, x, y, z);
    }
    skull.computeVertexNormals();
  }
  skull.translate(0, 1.658, 0);
  const ears = [];
  for (let k = -1; k <= 1; k += 2) {
    const ear = new THREE.SphereGeometry(1, 5, 3); ear.scale(0.011, 0.028, 0.019);
    ear.rotateZ(k * 0.18); ear.translate(k * 0.085, 1.652, -0.010);
    const eu = ear.attributes.uv; for (let i = 0; i < eu.count; i++) eu.setXY(i, 0.27, 0.40);
    ears.push(ear);
  }
  G.head = mergeGeometries([neck, skull, ...ears], false);

  // Hair shell whose lower edge follows a real hairline: at the brow in front, above the ears at the sides and
  // down to the nape behind. Round 3 shipped a full sphere cap to 122 degrees ALL the way round -- it sat 2 cm
  // in front of the face, so every instanced head seen from the front was a ball of hair with a chin under it,
  // and the face atlas was only ever visible on LOD0 bodies.
  {
    const seg = 12, rings = 4, pos = [], idx = [];
    const FRONT = Math.PI * 0.37, SIDE = Math.PI * 0.47, BACK = Math.PI * 0.80;
    // fix round 1 (critic): the cap sat 1.4 cm proud of the skull all over and a dyed head at 5 m read as a bald
    // tan dome. Rings 0-1 stand +1.2 cm further out (the crown at 1.784: RIG_CROWN), so the crown has hair volume.
    pos.push(0, 1.658 + 0.114 + 0.012, -0.004);
    for (let i = 1; i <= rings; i++) {
      const thick = i === 1 ? 0.012 : i === 2 ? 0.005 : 0;
      for (let j = 0; j < seg; j++) {
        const az = (j / seg) * Math.PI * 2, u = (1 - Math.cos(az)) / 2;
        const k = u < 0.5 ? u * 2 : (u - 0.5) * 2, sm = k * k * (3 - 2 * k);
        const tmax = u < 0.5 ? FRONT + (SIDE - FRONT) * sm : SIDE + (BACK - SIDE) * sm;
        const th = tmax * (i / rings), st = Math.sin(th);
        const rz = (Math.cos(az) > 0 ? 0.101 : 0.111) + thick;
        pos.push((0.097 + thick) * st * Math.sin(az), 1.658 + (0.114 + thick) * Math.cos(th), -0.004 + rz * st * Math.cos(az));
      }
    }
    for (let j = 0; j < seg; j++) idx.push(0, 1 + j, 1 + (j + 1) % seg);
    for (let i = 0; i < rings - 1; i++) for (let j = 0; j < seg; j++) {
      const a0 = 1 + i * seg + j, b0 = 1 + i * seg + (j + 1) % seg;
      idx.push(a0, a0 + seg, b0, b0, a0 + seg, b0 + seg);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const ed = new Float32Array(pos.length / 3);
    for (let v = 1; v < ed.length; v++) ed[v] = Math.ceil(v / seg) / rings;   // 0 at the crown, 1 on the hairline
    g.setAttribute('aEdge', new THREE.BufferAttribute(ed, 1));
    G.hairCap = hairShade(g);
  }
  // Long hair: a curtain over the back 240 degrees, following the skull and falling past the collar onto the
  // shoulders, instead of a flat-topped half cylinder that read as a bucket from behind
  {
    // fix round 1 (critic: a solid black wedge with a ruler-straight hem): the hem ring is jittered +/-2.5 cm per
    // segment (the strand shader dithers the last tenth of it away clump by clump), the crown carries a baked sheen
    // band (rings 0-1 lifted +0.25 inside a 30-degree azimuth falloff about the back of the crown) and the nape sits
    // in shade, so the curtain has a value break instead of one flat tone
    const R = [[1.705, 0.100, 0.113], [1.630, 0.106, 0.117], [1.550, 0.103, 0.114], [1.460, 0.100, 0.120], [1.370, 0.106, 0.128]];
    const seg = 10, a0 = Math.PI / 3, span = Math.PI * 4 / 3, pos = [], idx = [], col = [];
    for (let i = 0; i < R.length; i++) for (let j = 0; j <= seg; j++) {
      const az = a0 + span * (j / seg);
      const jit = i === R.length - 1 ? (((j * 7919 + 13) % 17) / 16 - 0.5) * 0.05 : 0;
      pos.push(R[i][1] * Math.sin(az), R[i][0] + jit, -0.006 + R[i][2] * Math.cos(az));
      const da = wrapPi(az - Math.PI) / 0.5236;                                    // azimuth from the back centre, in 30-degree units
      const band = Math.exp(-da * da) * (i === 0 ? 1 : i === 1 ? 0.6 : 0);
      let v = 0.50 + 0.40 * clamp((R[i][0] - 1.495) / 0.245, 0, 1);
      v = v * (i >= 3 ? (i === 3 ? 0.82 : 0.70) : 1) + 0.25 * band;
      col.push(v, v, v);
    }
    for (let i = 0; i < R.length - 1; i++) for (let j = 0; j < seg; j++) {
      const c = i * (seg + 1) + j, d = c + seg + 1;
      idx.push(c, c + 1, d, c + 1, d + 1, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const ed = new Float32Array(pos.length / 3);
    for (let i = 0; i < R.length; i++) for (let j = 0; j <= seg; j++) ed[i * (seg + 1) + j] = i / (R.length - 1) * 0.9 + 0.1;
    g.setAttribute('aEdge', new THREE.BufferAttribute(ed, 1));
    G.hairLong = g;
  }
  G.hairBun = new THREE.SphereGeometry(0.050, 5, 3); G.hairBun.translate(0, 1.706, -0.092); hairShade(G.hairBun);
  G.hairBun.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(G.hairBun.attributes.position.count), 1));

  // Legs are trouser legs, not broom handles: the thigh is deeper than it is wide and tapers into a knee, the
  // shin hangs straight from the knee (cloth does not follow the calf) and breaks over the shoe. Each leg joint
  // keeps a ball so the knee cannot open a gap when it bends. aBare is the shin's second shape -- a bare calf
  // and ankle for skirts, dresses and shorts -- blended per instance in the vertex shader.
  const TH = [[0.030, 0.080, 0.088, 0.000], [-0.050, 0.090, 0.098, 0.006], [-0.200, 0.080, 0.086, 0.008], [-0.360, 0.066, 0.071, 0.004], [-0.445, 0.061, 0.065, 0.004]];
  {
    const { geo, ring } = loft(TH.map(r => ({ y: r[0], hw: r[1], hd: r[2], z: r[3], e: 2.1 })), 6);
    vcRing(geo, ring, (r) => [0.62, 0.74, 0.92, 1.0, 0.92][r]);
    const kneeB = new THREE.SphereGeometry(0.062, 6, 3); kneeB.translate(0, -THIGH, 0.004);
    vcFlat(kneeB, 0.9); onlyAttrs(kneeB, ['position', 'normal', 'color']);
    G.thigh = mergeGeometries([geo, kneeB], false);
  }
  const SHT = [[0.012, 0.061, 0.066, 0.004], [-0.080, 0.063, 0.069, -0.004], [-0.220, 0.060, 0.064, 0.000], [-0.330, 0.058, 0.063, 0.004], [-0.372, 0.063, 0.070, 0.010], [-0.392, 0.064, 0.073, 0.013]];
  const SHB = [[0.012, 0.050, 0.054, 0.002], [-0.090, 0.054, 0.061, -0.012], [-0.220, 0.040, 0.045, -0.004], [-0.330, 0.030, 0.033, 0.000], [-0.372, 0.028, 0.031, 0.002], [-0.392, 0.028, 0.031, 0.004]];
  {
    const mk = (T) => loft(T.map(r => ({ y: r[0], hw: r[1], hd: r[2], z: r[3], e: 2.1 })), 6);
    const a = mk(SHT), b = mk(SHB);
    const pa = a.geo.attributes.position, pb = b.geo.attributes.position, d = new Float32Array(pa.count * 3);
    for (let i = 0; i < pa.count; i++) { d[i * 3] = pb.getX(i) - pa.getX(i); d[i * 3 + 1] = pb.getY(i) - pa.getY(i); d[i * 3 + 2] = pb.getZ(i) - pa.getZ(i); }
    a.geo.setAttribute('aBare', new THREE.BufferAttribute(d, 3));
    vcRing(a.geo, a.ring, (r) => [0.84, 0.96, 1.0, 1.0, 0.92, 0.80][r]);
    G.shin = a.geo;
  }
  // Shoe: lofted heel -> arch -> ball -> toe, flat sole, the toe box dropping and narrowing. Built along y and
  // turned so +y becomes -z; sole at -0.095 in ankle space (ground level when the foot is flat).
  //   z(final)  hw     half-h  centre-y
  const SH = [[-0.078, 0.034, 0.030, -0.064], [-0.055, 0.042, 0.040, -0.056], [0.030, 0.046, 0.035, -0.062],
    [0.100, 0.049, 0.027, -0.069], [0.148, 0.038, 0.019, -0.076], [0.166, 0.020, 0.011, -0.082]];
  {
    const { geo, ring } = loft(SH.map(r => ({ y: -r[0], hw: r[1], hd: r[2], z: r[3], e: 3.2 })), 6, 0, 0);
    geo.rotateX(-Math.PI / 2);
    // A flat 30 cm paddle is what the critic saw on a white sneaker at 8 m. A shoe has a heel block (the sole is
    // 2 cm deep under the heel and the arch is lifted clear of the ground in front of it) and toe spring (the tip
    // of the sole curls up ~8 degrees from the ball), so it rocks on the ball rather than lying on the street.
    {
      const p = geo.attributes.position, TS = Math.tan(8 * Math.PI / 180);
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i), z = p.getZ(i);
        const low = clamp((-0.070 - y) / 0.025, 0, 1);             // 1 on the sole face, 0 by the upper's top
        const arch = low * 0.007 * sstep(-0.018, 0.0, z) * (1 - sstep(0.055, 0.085, z));
        const spring = z > 0.105 ? (z - 0.105) * TS * (0.55 + 0.45 * low) : 0;
        p.setY(i, y + arch + spring);
      }
      geo.computeVertexNormals();
    }
    // the sole band (bottom 1.25 cm) is painted in the shader with the per-instance sole colour
    vcRing(geo, ring, (r, x, y) => (y > -0.03 ? 0.78 : 1));
    // heel block: a 2 cm lift under the heel, in the sole colour (the shader paints everything under the band)
    const hb = new THREE.BoxGeometry(0.062, 0.022, 0.058); hb.translate(0, -0.084, -0.052);
    vcFlat(hb, 0.9); onlyAttrs(hb, ['position', 'normal', 'color']);
    G.shoe = mergeGeometries([onlyAttrs(geo, ['position', 'normal', 'color']), hb], false);
  }

  // Arms: a sleeve with a deltoid cap that sits ON the shoulder line (so the arm grows out of the torso rather
  // than hanging beside it as a dowel), narrowing to the elbow; the forearm ends in a cuff that stands a few mm
  // proud of the wrist. aSleeve is not needed: the shader reads the local y against the per-instance sleeve end.
  const UA = [[0.058, 0.018, 0.018], [0.046, 0.044, 0.044], [0.020, 0.060, 0.058], [-0.020, 0.062, 0.060], [-0.110, 0.056, 0.055], [-0.200, 0.051, 0.050], [-UARM - 0.012, 0.047, 0.047]];
  {
    const { geo, ring } = loft(UA.map(r => ({ y: r[0], hw: r[1], hd: r[2], e: 2 })), 6, 0.004, false);
    vcRing(geo, ring, (r, x) => [0.80, 0.82, 0.86, 0.90, 0.96, 1.0, 0.94][r]);
    G.uarm = geo;
  }
  const FA = [[0.034, 0.024, 0.024], [0.016, 0.045, 0.045], [-0.030, 0.049, 0.047], [-0.160, 0.044, 0.041], [-0.272, 0.036, 0.034], [-0.286, 0.041, 0.038], [-FARM - 0.004, 0.041, 0.038]];
  {
    const { geo, ring } = loft(FA.map(r => ({ y: r[0], hw: r[1], hd: r[2], e: 2 })), 6, 0.003, 0);
    vcRing(geo, ring, (r) => [0.78, 0.80, 0.90, 1.0, 1.0, 0.86, 0.80][r]);
    G.farm = geo;
  }
  // Hand: a mitten with a thumb. Its plane is the body's sagittal plane (thin in x, wide in z), which is how a
  // hanging hand sits, and it is symmetric in x so one geometry serves both sides.
  {
    const HN = [[0.004, 0.018, 0.027, 0.000], [-0.034, 0.017, 0.041, 0.002], [-0.085, 0.015, 0.043, 0.000], [-0.140, 0.011, 0.035, -0.004], [-0.160, 0.006, 0.018, -0.006]];
    const { geo, ring } = loft(HN.map(r => ({ y: r[0], hw: r[1], hd: r[2], z: r[3], e: 2.4 })), 5, false, -0.006);
    vcRing(geo, ring, (r) => [0.86, 0.96, 1.0, 1.0, 1.0][r]);
    const TB = [[0.000, 0.011, 0.012], [-0.030, 0.010, 0.010], [-0.058, 0.007, 0.007]];
    const t = loft(TB.map(r => ({ y: r[0], hw: r[1], hd: r[2] })), 4, false, -0.004);
    t.geo.rotateX(-0.55); t.geo.translate(0, -0.028, 0.032);
    vcRing(t.geo, t.ring, () => 0.92);
    G.hand = mergeGeometries([geo, t.geo], false); G.hand.translate(0, -FARM, 0);
  }

  // Far body (beyond DET_D): the whole person in ONE geometry and one draw call, ~300 triangles, animated in the
  // vertex shader (legs and arms scissor about the hip / shoulder from a per-instance phase and stride). Past
  // ~45 m a body is under 40 px tall and the 17-part rig spends 1 500 triangles and 17 matrix composes on it;
  // this keeps the silhouette (hem, shoulders, head, legs, hands) at a fifth of the cost.
  //   aPart: 0 garment, 1 skin, 2 hair, 3 legs, 4 shoes, 5 sleeves     aLimb: 0 none, 1/2 leg L/R, 3/4 arm L/R
  G.far = buildFar(TR, false);
  G.far2 = buildFar(TR, true);

  // Bags, authored in torso space (the torso's own instance matrix places them, so they lean and twist with the
  // chest): aKind 0 is the shoulder bag, a rounded 8 cm body on a two-segment ribbon from the right shoulder, built
  // round its shoulder pivot so it can swing; aKind 1 is the backpack, bevelled, tilted back, with a strap loop over
  // each shoulder. One geometry, the other kind collapses per instance (iBag).
  {
    const parts = [];
    const strapSeg = (a, b, w, t, flat) => {
      const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = d.length();
      const g = flat ? new THREE.BoxGeometry(w, len + 0.01, t) : new THREE.BoxGeometry(t, len + 0.01, w);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UPY, d.normalize()));
      g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      return g;
    };
    const kind = (g, k, v) => {
      g = onlyAttrs(g.index ? g.toNonIndexed() : g, ['position', 'normal']);
      vcFlat(g, v);
      g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(k), 1));
      parts.push(g);
    };
    // shoulder bag, pivot at the right shoulder top (the instance adds the pivot and the swing): a bevelled body with a
    // flap over its outer face and a darker welt, on a strap that reads at 5 m
    const sb = new RoundedBoxGeometry(0.075, 0.23, 0.27, 1, 0.018); sb.translate(-0.075, -0.50, 0.03); kind(sb, 0, 1);
    const fl = new THREE.BoxGeometry(0.012, 0.11, 0.262); fl.translate(-0.116, -0.44, 0.03); kind(fl, 0, 0.82);
    kind(strapSeg([-0.062, -0.39, 0.03], [0, 0, 0.012], 0.040, 0.009, false), 0, 0.72);
    kind(strapSeg([0, 0, 0.012], [0.035, 0.012, -0.095], 0.040, 0.009, true), 0, 0.72);
    // backpack, torso space: a 1.5 cm bevel, hugging the back (its top leans in toward the shoulder blades, the way
    // the straps pull it), a front pocket, a grab handle on top, and two straps over the shoulders to the chest and
    // back under the arms to the pack's lower corners
    const bp = new RoundedBoxGeometry(0.28, 0.38, 0.12, 1, 0.015); bp.rotateX(0.05); bp.translate(0, 1.14, -0.19); kind(bp, 1, 1);
    const pk = new THREE.BoxGeometry(0.20, 0.15, 0.04); pk.translate(0, 1.03, -0.262); kind(pk, 1, 0.84);
    const hd = new THREE.TorusGeometry(0.03, 0.007, 3, 4, Math.PI); hd.translate(0, 1.33, -0.19); kind(hd, 1, 0.7);
    for (const s of [1, -1]) {
      kind(strapSeg([s * 0.085, 1.31, -0.135], [s * 0.115, 1.492, -0.01], 0.050, 0.012, true), 1, 0.72);
      kind(strapSeg([s * 0.115, 1.492, -0.01], [s * 0.105, 1.33, 0.142], 0.050, 0.012, true), 1, 0.72);
      kind(strapSeg([s * 0.105, 1.33, 0.142], [s * 0.160, 1.13, 0.085], 0.036, 0.010, false), 1, 0.72);
      kind(strapSeg([s * 0.160, 1.13, 0.085], [s * 0.125, 0.975, -0.15], 0.030, 0.010, false), 1, 0.72);
    }
    G.bag = mergeGeometries(parts, false);
  }
  // Cap: a six-panel crown and a bill, riding the head matrix (head space: skull centre at y 1.658)
  {
    const crown = new THREE.SphereGeometry(0.118, 10, 4, 0, Math.PI * 2, 0, Math.PI * 0.46);
    crown.scale(1.02, 1.0, 1.08); crown.translate(0, 1.668, -0.006);   // its top clears the hair shell's crown (1.784)
    const bill = new THREE.CylinderGeometry(0.085, 0.085, 0.008, 10, 1, false, -Math.PI * 0.42, Math.PI * 0.84);
    bill.scale(1, 1, 0.9); bill.rotateX(-0.12); bill.translate(0, 1.686, 0.055);
    const g = mergeGeometries([onlyAttrs(crown, ['position', 'normal']), onlyAttrs(bill, ['position', 'normal'])], false);
    G.cap = vcFlat(g, 1);
    const pos = G.cap.attributes.position, col = G.cap.attributes.color;
    for (let i = 0; i < pos.count; i++) { const v = 0.72 + 0.28 * clamp((pos.getY(i) - 1.66) / 0.08, 0, 1); col.setXYZ(i, v, v, v); }
  }
  G.phone = new THREE.BoxGeometry(0.072, 0.136, 0.013);
  {
    const nz = G.phone.attributes.normal, col = new Float32Array(nz.count * 3);
    for (let i = 0; i < nz.count; i++) { const v = nz.getZ(i) > 0.5 ? 1 : 0.06; col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v; }
    G.phone.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

  // Umbrella: pivot AT THE GRIP, which now rides the actual right hand (~1.43 m on a 1.8 m body), so the hem
  // lands at ~2.15 m and clears the skull by 0.35 m instead of sitting on it like a straw hat. Canopy 0.58 r /
  // 0.44 crown = a 37-degree dome, not a sunhat; 24 segments scalloped into 8 rib points with a 22 % scallop
  // and the rib tips pulled down, so the hem has a lip. The ribs themselves are baked in as vertex colour.
  // The canopy is a LATHE with a real profile, not a cone. A straight 37-degree cone is a conical hat however
  // you scallop it -- the giveaway is that the silhouette from the side is two straight lines. A real umbrella
  // sags between the ribs: the surface is nearly flat at the crown, falls away steeply through the middle and
  // flares back out into a lip over the last 4 cm. Ten profile points buy that for the same triangle count.
  const prof = [[0.004, 1.104], [0.150, 1.082], [0.300, 1.000], [0.440, 0.872],
    [0.545, 0.735], [0.598, 0.628], [0.612, 0.574]];
  const canopy = new THREE.LatheGeometry(prof.map(q => new THREE.Vector2(q[0], q[1])), 24);
  {
    const pos = canopy.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), r = Math.hypot(x, z);
      if (r < 0.10) continue;
      const w = 0.5 + 0.5 * Math.cos(Math.atan2(z, x) * 8);       // 1 at a rib tip, 0 in the scallop between
      const k = 0.78 + 0.22 * w;
      pos.setXYZ(i, x * k, pos.getY(i) - 0.05 * w * clamp(r / 0.58, 0, 1), z * k);
    }
    canopy.computeVertexNormals();
    // rib strips: the 8 radial lines of the frame, dark on the underside, painted as vertex colour so they
    // cost no draw call and still read through the translucent vinyl canopies
    const n = pos.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const w = 0.5 + 0.5 * Math.cos(Math.atan2(pos.getZ(i), pos.getX(i)) * 8);
      const v = 1 - 0.55 * Math.pow(w, 8);
      col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v * 1.02;
    }
    canopy.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const tip = vcFlat(new THREE.ConeGeometry(0.013, 0.055, 5), 0.5); tip.translate(0, 1.135, 0);
  const shaft = vcFlat(new THREE.CylinderGeometry(0.0105, 0.0105, 1.40, 5, 1, true), 0.42); shaft.translate(0, 0.41, 0);
  const grip = vcFlat(new THREE.CylinderGeometry(0.019, 0.017, 0.13, 5, 1, false), 0.30); grip.translate(0, -0.22, 0);
  G.umbrella = mergeGeometries([canopy, tip, shaft, grip], false);

  // furled umbrella: a 0.66 m sleeve with a ferrule and a hooked grip. Squeezing the open canopy down instead
  // reads as a paper dart hanging off the hand -- the cone's mouth stays visible however small you scale it.
  const fSleeve = vcFlat(new THREE.CylinderGeometry(0.035, 0.022, 0.50, 6, 1, false), 1); fSleeve.translate(0, -0.27, 0);
  const fShaft = vcFlat(new THREE.CylinderGeometry(0.010, 0.010, 0.18, 5, 1, false), 0.5); fShaft.translate(0, -0.05, 0);
  const fTip = vcFlat(new THREE.ConeGeometry(0.014, 0.05, 5), 0.4); fTip.rotateX(Math.PI); fTip.translate(0, -0.545, 0);
  const fGrip = vcFlat(new THREE.CylinderGeometry(0.017, 0.015, 0.10, 5, 1, false), 0.32); fGrip.translate(0, 0.02, 0);
  G.umbFold = mergeGeometries([fSleeve, fShaft, fTip, fGrip], false);

  G.blob = new THREE.CircleGeometry(1, 9); G.blob.rotateX(-Math.PI / 2);      // scaled to a 0.60 x 0.95 ellipse
  G.contact = new THREE.CircleGeometry(0.16, 8); G.contact.rotateX(-Math.PI / 2);
  G.smear = new THREE.CircleGeometry(1, 10); G.smear.rotateX(-Math.PI / 2);
  G.glow = new THREE.PlaneGeometry(0.17, 0.17);                               // phone-screen spill, billboarded
  return G;
}

// The one-draw far body. `lo` is the cut used past FAR2_D (a body under ~25 px): fewer ring segments, no hands,
// a 5-sided head -- ~100 triangles against ~310, with the same attribute layout and the same shader.
function buildFar(TR, lo) {
  const parts = [];
  // aVar: the silhouette variant a part belongs to (0 = everyone; 1 hip bag, 2 long hair, 8 backpack). The far
  // shader collapses a variant part unless the pedestrian's iVarF carries that bit, so one draw still covers
  // a row of people who are not all the same bowling pin.
  const add = (geo, part, limb, hemW, vbit = 0) => {
    const n = geo.attributes.position.count;
    // aPart carries the variant bit too (part + 16 * bit): the far shader is already at the 16-attribute limit
    geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part + 16 * vbit), 1));
    geo.setAttribute('aLimb', new THREE.BufferAttribute(new Float32Array(n).fill(limb), 1));
    if (!geo.attributes.aHem) geo.setAttribute('aHem', new THREE.BufferAttribute(new Float32Array(n).fill(hemW || 0), 1));
    if (!geo.attributes.color) vcFlat(geo, 1);
    parts.push(onlyAttrs(geo, ['position', 'normal', 'color', 'aPart', 'aLimb', 'aHem']));
  };
  const FT = (lo ? [0, 4, 8, 10] : [0, 2, 4, 6, 8, 10]).map(i => TR[i]);
  const t = loft(FT.map(r => ({ y: r[0], hw: r[1], hd: r[2], z: r[3], e: r[4], sl: r[5] })), lo ? 5 : 7);
  const hw = new Float32Array(t.geo.attributes.position.count);
  for (let i = 0; i < hw.length; i++) hw[i] = t.ring[i] === 0 ? 1 : 0;
  t.geo.setAttribute('aHem', new THREE.BufferAttribute(hw, 1));
  vcRing(t.geo, t.ring, lo ? (r) => [0.72, 1, 0.94, 0.72][r] : (r) => [0.72, 0.92, 1, 1, 0.94, 0.72][r]);
  add(t.geo, 0, 0);
  const sk = new THREE.SphereGeometry(0.088, lo ? 5 : 6, lo ? 3 : 4); sk.scale(1, 1.14, 1.08); sk.translate(0, 1.650, 0.004); add(sk, 1, 0);
  if (!lo) { const nk = new THREE.CylinderGeometry(0.052, 0.058, 0.12, 4, 1, true); nk.translate(0, 1.50, 0.004); add(nk, 1, 0); }
  const hr = new THREE.SphereGeometry(0.106, lo ? 5 : 6, 2, 0, Math.PI * 2, 0, Math.PI * 0.62); hr.scale(1, 1.12, 1.07); hr.translate(0, 1.652, -0.008); add(hr, 2, 0);
  for (let k = 0; k < 2; k++) {
    const sx = k === 0 ? 1 : -1;
    const lg = loft(lo ? [{ y: 0.95, hw: 0.086, hd: 0.094 }, { y: 0.47, hw: 0.062, hd: 0.066 }, { y: 0.012, hw: 0.058, hd: 0.10, z: 0.035 }]
      : [{ y: 0.95, hw: 0.086, hd: 0.094 }, { y: 0.47, hw: 0.062, hd: 0.066 }, { y: 0.13, hw: 0.060, hd: 0.066 }, { y: 0.085, hw: 0.062, hd: 0.070, z: 0.01 }], lo ? 3 : 4);
    lg.geo.translate(sx * HIP_X, 0, 0); add(lg.geo, 3, 1 + k);
    // (the cut body has no feet: at 30 m they are two pixels, and the ankle ring below the trouser reads as one)
    if (!lo) { const ft = new THREE.BoxGeometry(0.09, 0.075, 0.23); ft.translate(sx * HIP_X, 0.038, 0.045); add(ft, 4, 1 + k); }
    const ar = loft(lo ? [{ y: 1.45, hw: 0.050, hd: 0.050 }, { y: 1.40, hw: 0.060, hd: 0.058 }, { y: 0.80, hw: 0.036, hd: 0.034 }]
      : [{ y: 1.45, hw: 0.050, hd: 0.050 }, { y: 1.40, hw: 0.060, hd: 0.058 }, { y: 1.10, hw: 0.049, hd: 0.047 }, { y: 0.83, hw: 0.038, hd: 0.036 }], lo ? 3 : 4, 0.008, false);
    ar.geo.rotateZ(sx * 0.07); ar.geo.translate(sx * SHO_X + sx * 0.098, -0.007, 0);
    add(ar.geo, 5, 3 + k);
    if (!lo) {
      const hd = loft([{ y: 0.84, hw: 0.020, hd: 0.034 }, { y: 0.74, hw: 0.013, hd: 0.030 }], 3, false, -0.012);
      hd.geo.translate(sx * (SHO_X + 0.040), 0, 0.004); add(hd.geo, 1, 3 + k);
    }
  }
  const hb = new THREE.BoxGeometry(0.16, 0.22, 0.10); hb.translate(-0.235, 0.93, 0.02); vcFlat(hb, 0.8); add(hb, 6, 0, 0, 1);
  const cur = new THREE.CylinderGeometry(0.102, 0.128, 0.32, lo ? 3 : 5, 1, true, Math.PI * 0.42, Math.PI * 1.16);
  cur.translate(0, 1.55, -0.012); onlyAttrs(cur, ['position', 'normal']); vcFlat(cur, 0.9); add(cur, 2, 0, 0, 2);
  const bp = new THREE.BoxGeometry(0.29, 0.38, 0.15); bp.translate(0, 1.12, -0.19); vcFlat(bp, 0.85); add(bp, 6, 0, 0, 8);
  return mergeGeometries(parts, false);
}

function groupBoxes(geo) {
  const pos = geo.attributes.position, idx = geo.index, out = [];
  for (const g of geo.groups) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const end = g.start + g.count;
    for (let k = g.start; k < end; k += 3) {
      const i = idx.getX(k), x = pos.getX(i), y = pos.getY(i);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    out.push({ mi: g.materialIndex, x0, y0, x1, y1 });
  }
  return out;
}

// A connected body occupies every horizontal slab from the soles to the crown. Below ~0.72 detail the loft
// rings that bridge neck->chest, shoulder->arm and pelvis->thigh drop out of createHumanoid and the body
// ships as a disassembled scarecrow -- a floating torso, a head-ball 0.25 m clear of it, legs starting below
// a gap. Every one of those leaves an empty slab, which is what this measures. (A per-part box union cannot
// separate torso from thighs here: both are the SAME merged material group in the suit outfit, so the group
// boxes only answer the head-to-collar question, which is checked second.)
function validateRig(h) {
  const sk = h && h.skinned, geo = sk && sk.geometry;
  if (!geo || !geo.attributes.position || !geo.index) return false;
  const pos = geo.attributes.position, idx = geo.index, n = pos.count;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const H = maxY - minY;
  if (!(H > 1.4)) { validateRig.why = `body is only ${H.toFixed(2)} m tall`; return false; }
  // Slab coverage is measured over TRIANGLES, not vertices: the body is lofted from rings 5-8 cm apart, so a
  // vertex histogram reports holes in a perfectly continuous limb.
  const NB = 56, occ = new Uint16Array(NB), wide = new Float32Array(NB), inv = NB / H;
  const K = idx.count;
  for (let k = 0; k < K; k += 3) {
    const i0 = idx.getX(k), i1 = idx.getX(k + 1), i2 = idx.getX(k + 2);
    const y0 = pos.getY(i0), y1 = pos.getY(i1), y2 = pos.getY(i2);
    let lo = y0 < y1 ? y0 : y1; if (y2 < lo) lo = y2;
    let hi = y0 > y1 ? y0 : y1; if (y2 > hi) hi = y2;
    let b0 = clamp(((lo - minY) * inv) | 0, 0, NB - 1), b1 = clamp(((hi - minY) * inv) | 0, 0, NB - 1);
    const r = Math.max(Math.hypot(pos.getX(i0), pos.getZ(i0)), Math.hypot(pos.getX(i1), pos.getZ(i1)), Math.hypot(pos.getX(i2), pos.getZ(i2)));
    for (let b = b0; b <= b1; b++) { if (occ[b] < 65535) occ[b]++; if (r > wide[b]) wide[b] = r; }
  }
  // The band is knee-to-crown: below the knee the rig has a legitimate authored gap at the ankle (the shoe
  // covers it), but from the knee up every slab of a connected body carries surface -- a floating torso, a
  // detached head or legs hanging off a missing pelvis all open a hole here.
  for (let b = Math.round(NB * 0.24); b <= Math.round(NB * 0.93); b++) {
    if (occ[b] >= 4 && wide[b] >= 0.02) continue;
    validateRig.why = `slab ${b}/${NB} (y=${(minY + b / inv).toFixed(2)}) has ${occ[b]} faces, r=${wide[b].toFixed(3)}`;
    return false;
  }
  const boxes = groupBoxes(geo);
  const mats = Array.isArray(sk.material) ? sk.material : [sk.material];
  let head = null, garment = null;
  for (const g of boxes) {
    const nm = (mats[g.mi] && mats[g.mi].name) || '';
    if (nm.indexOf('skin') === 0) { if (!head || g.y1 > head.y1) head = g; }
    else if (nm && nm.indexOf('hair') !== 0 && (!garment || (g.y1 - g.y0) > (garment.y1 - garment.y0))) garment = g;
  }
  if (head && garment) {
    if (head.y0 > garment.y1 - 0.02) { validateRig.why = 'skull box clears the collar'; return false; }
    if (Math.max(head.x0, garment.x0) > Math.min(head.x1, garment.x1)) { validateRig.why = 'skull box misses the torso in x'; return false; }
  }
  validateRig.why = '';
  return true;
}

const crowd = {
  name: 'crowd',
  peds: [],
  count: 0, visible: 0, full: 0,

  shotPresets: {
    crowd_scramble: { pos: [-24, 3.4, 13], lookAt: [4, 0.9, -10], t: 'night', fov: 40 },
    crowd_day_wave: { pos: [-24, 3.4, 13], lookAt: [4, 0.9, -10], t: 'day', fov: 40 },
    crowd_hachiko: { pos: [16, 1.75, 20], lookAt: [32, 1.4, 42] },
    crowd_face: { pos: [-15, 1.62, 13], lookAt: [-4, 1.5, 2], t: 'night', fov: 32 },
    crowd_lod0: { pos: [-11, 1.58, 9.5], lookAt: [-3.5, 1.45, 1.5], t: 'night', fov: 26 },      // LOD0 bodies at reading distance
    crowd_lod0_day: { pos: [-11, 1.58, 9.5], lookAt: [-3.5, 1.45, 1.5], t: 'day', fov: 26 },
    crowd_plan: { pos: [-4, 52, -2], lookAt: [-4, 0, -1.9], t: 'day', fov: 46 },
    // inspection: two bicycle pushers brought up close on the crossing, and the touts outside the Center-gai karaoke
    crowd_bike: {
      pos: [-9, 1.6, 13], lookAt: [0, 1.0, 3], t: 'night', fov: 38,
      setup(engine) {
        const c = engine.get('crowd'); if (!c) return;
        c.bikeIdx.slice(0, 2).forEach((i, k) => {
          const p = c.peds[i];
          p.state = 'cross'; p.x = -3 + k * 3.2; p.z = 6.5 - k * 2.5; p.wpn = 1; p.wpi = 0; p.wp[0] = p.x + 30; p.wp[1] = p.z - 24; p.yaw = Math.atan2(30, -24);
        });
      },
    },
    crowd_touts: { pos: [-36.5, 1.6, -31], lookAt: [-45, 1.3, -41], t: 'night', fov: 40 },
    // 道玄坂 up the hill: over the carriageway from the foot of the slope (a crane's eye, so the rise reads), and at
    // eye level on the north pavement
    crowd_dogenzaka: () => {
      const y = (x, z) => groundY(x, z);
      return { pos: [-121, y(-121, 3) + 3.4, 3], lookAt: [-176, y(-176, 23) + 1.2, 23], t: 'night', fov: 42 };
    },
    crowd_dogenzaka_low: ({ engine } = {}) => {
      // on the pavement itself, 8 m up the hill from the 109 end, looking on up it
      const c = engine && engine.get && engine.get('crowd'), P = c && c.slopePaths && c.slopePaths.find(q => q.id === 'dogenzaka');
      const a = P ? c.pathPoint(P, P.sa + 8, 0.6) : [-129, -7], b = P ? c.pathPoint(P, P.sa + 48, 0) : [-166, 7];
      return { pos: [a[0], groundY(a[0], a[1]) + 0.15 + 1.7, a[1]], lookAt: [b[0], groundY(b[0], b[1]) + 1.4, b[1]], t: 'night', fov: 40 };
    },
    // inspection: the dithered fade -- four walkers held at half faded (a door / a portal / the lens bubble) at
    // 7-9 m, beside four at full; nobody may shrink
    crowd_fade: {
      pos: [-9, 1.6, 13], lookAt: [-1, 1.1, 5], t: 'night', fov: 34,
      setup(engine) {
        const c = engine.get('crowd'); if (!c) return;
        const used = new Set();
        for (let k = 0; k < 8; k++) {
          const p = c.peds.find(q => q.kind === 'crosser' && !used.has(q) && !q.bike && !q.leader && !q.members && !q.child);
          if (!p) break;
          used.add(p);
          p.stage = true; p.x = -5.2 + k * 1.05; p.z = 6.2 - (k & 1) * 1.1; p.yaw = Math.atan2(1, -0.3) + (k & 2 ? Math.PI : 0);
          p.speed = 1.2; p.fade = p.dfade = k < 4 ? 0.5 : 1;
        }
        c.resortT = 99;
      },
    },
    // inspection: five pool bodies walking across the lens at 3-6 m -- a woman with long hair and a backpack, a
    // shoulder bag, a cap, a phone reader, a suit
    crowd_hero: {
      pos: [-9, 1.6, 13], lookAt: [-2, 1.1, 6], t: 'night', fov: 40,
      setup(engine) {
        const c = engine.get('crowd'); if (!c) return;
        const used = new Set();
        const find = (f) => { const p = c.peds.find(q => q.kind === 'crosser' && !used.has(q) && !q.bike && !q.leader && !q.members && f(q)); if (p) used.add(p); return p; };
        const picks = [find(q => q.hairKind === 1 && q.bagKind === 2), find(q => q.bagKind === 1 && !q.fem), find(q => q.cCap), find(q => q.phone && q.bagKind === 0), find(q => q.lookK === 'suit' && !q.fem)];
        // staged: they walk on the spot (a treadmill), so the frame holds however long the harness waits
        picks.forEach((p, k) => {
          if (!p) return;
          p.stage = true; p.x = -6.8 + k * 1.7; p.z = 8.6 - (k & 1) * 1.4 - k * 0.35; p.yaw = Math.atan2(1, -0.35) + (k & 1 ? Math.PI : 0);
          p.speed = 1.25; p.fade = p.dfade = 1;
        });
        c.resortT = 99;
      },
    },
    // the scanned crowd (crowdScan.js) up close: a walking group 3.5-5 m from the lens (on a treadmill so the frame
    // holds), each a different person, two more standing behind them -- pool bodies and instanced twins side by side
    crowd_scan_close: {
      pos: [-9, 1.6, 13], lookAt: [-4.6, 1.15, 9.4], t: 'night', fov: 44,
      setup(engine) {
        const c = engine.get('crowd'); if (!c) return;
        const used = new Set(), keys = new Set();
        const find = (f) => {
          let p = c.peds.find(q => q.kind === 'crosser' && !used.has(q) && !q.bike && !q.leader && !q.members && !keys.has(q.sk) && f(q));
          if (!p) p = c.peds.find(q => q.kind === 'crosser' && !used.has(q) && !q.bike && f(q));
          if (p) { used.add(p); keys.add(p.sk); }
          return p;
        };
        const at = [[-6.6, 10.3, 0], [-5.4, 9.2, 1], [-7.2, 8.9, 0], [-4.2, 10.6, 1], [-3.6, 7.6, 2], [-6.0, 7.0, 2]];
        at.forEach(([x, z, v], k) => {
          const p = find(() => true); if (!p) return;
          p.x = x; p.z = z; p.fade = p.dfade = 1;
          if (v === 2) { p.stage = 2; p.moving = false; p.vel = 0; p.yaw = Math.atan2(-9 - x, 13 - z) + (k & 1 ? 0.6 : -0.5); }
          else { p.stage = true; p.speed = 1.25; p.yaw = Math.atan2(1, -0.3) + (v ? Math.PI : 0); }
        });
        // a clear stage: everybody else within 14 m is held out of the frame for the length of the shot
        for (const q of c.peds) if (!used.has(q) && Math.hypot(q.x + 5.6, q.z - 9.2) < 14) { q.stage = 2; q.fade = q.dfade = 0; }
        // &pool=0: the same group on the instanced lod1 twins (no pool body), for the twin / body comparison
        if (engine.params && engine.params.raw && engine.params.raw.pool === '0') { c.heroOff = true; for (const H of c.heroes) { H.h.group.visible = false; if (H.ped) H.ped.hero = null; H.ped = null; } }
        c.resortT = 99;
      },
    },
    // the pedestrian signals (2026-09-25): 宮益坂下, the crosswalk over 明治通り (cx_meiji_shita) at the outer junction,
    // from 宮益坂's carriageway -- walkers on the north pavement wait at the kerb while 宮益坂's vehicle green is off
    crowd_signal_miyamasu: {
      pos: [137.5, 1.75, -11.5], lookAt: [145, 1.0, -17], t: 'night', fov: 46,
      setup(engine) {
        const c = engine.get('crowd'); if (!c) return;
        // for the log: each signalled crossing's head and who is waiting at it, every 10 s of the shot
        let n = 0;
        const rep = () => {
          const S = (c.spans || []).filter(q => q.kind !== 'end' && q.kind !== 'none');
          console.info('[crowd] signals ' + S.map(q => `${q.id}${q.jid ? '@' + q.jid : ''}=${q.state} waiting ${c.peds.filter(p => p.waitS === q).length}`).join(', '));
          if (++n < 12) setTimeout(rep, 10000);
        };
        setTimeout(rep, 4000);
      },
    },
    // the scanned crowd at 40-80 m: across the scramble from a first-floor vantage on the station side (over the
    // heads of the near crowd), long lens -- the lod2 tier and the lod1 / lod2 line
    crowd_scan_far: { pos: [30, 6.5, 44], lookAt: [-16, 0.6, -26], t: 'night', fov: 24 },
    // the koban officers from the square at 15 m (their night vest, cap and 警杖 have to read at this range)
    crowd_koban: { pos: [24.5, 1.7, 28.8], lookAt: [26.6, 1.3, 43.2], t: 'night', fov: 38 },
    // inspection: four pool bodies standing 3-4.5 m from the lens -- three facing it (an open zip jacket over a tee,
    // a woman in a dress, a suit), one from behind -- for the neck, the hands, the open front and the back of the head
    crowd_pool_close: {
      pos: [-9, 1.6, 13], lookAt: [-6.2, 1.25, 9.8], t: 'night', fov: 40,
      setup(engine) {
        const c = engine.get('crowd'); if (!c) return;
        const used = new Set();
        const find = (f) => { const p = c.peds.find(q => q.kind === 'crosser' && !used.has(q) && !q.bike && !q.leader && !q.members && !q.umb && f(q)); if (p) used.add(p); return p; };
        const picks = [find(q => q.lookK === 'casual' && q.O.openW > 0 && !q.fem), find(q => q.fem && q.lookK === 'dress' && q.hairKind === 1), find(q => q.lookK === 'suit' && !q.fem), find(q => !q.fem && q.lookK === 'street')];
        const at = [[-7.7, 10.4, 0], [-6.3, 10.0, 0], [-8.9, 9.6, 0], [-5.9, 11.3, 1]];
        picks.forEach((p, k) => {
          if (!p) return;
          const [x, z, back] = at[k];
          p.stage = 2; p.x = x; p.z = z; p.yaw = Math.atan2(-9 - x, 13 - z) + (back ? Math.PI : 0) + (k - 1.5) * 0.15;
          p.idlePose = 0; p.phone = false; p.fade = p.dfade = 1; p.moving = false; p.vel = 0;
        });
        // &pool=0: the same four on the part rig (the relaxed stance, contrapposto, arms off the ribs)
        if (engine.params && engine.params.raw && engine.params.raw.pool === '0') { c.heroOff = true; for (const H of c.heroes) { H.h.group.visible = false; if (H.ped) H.ped.hero = null; H.ped = null; } }
        c.resortT = 99;
      },
    },
    // inspection: two children standing between adults at 3-5 m (one from behind, one walking on the spot).
    // &kidPool=1 is the old build for A/B: children promoted into the adult pool body, the head shrunk with the body.
    crowd_kids: {
      pos: [-9, 1.6, 13], lookAt: [-6.9, 1.0, 9.9], t: 'night', fov: 38,
      setup(engine) {
        const c = engine.get('crowd'); if (!c) return;
        const used = new Set();
        const find = (f) => { const p = c.peds.find(q => !used.has(q) && !q.bike && !q.umb && !q.role && f(q)); if (p) used.add(p); return p; };
        const adult = (q) => !q.child && !q.leader && !q.members && q.kind === 'crosser' && poolable(q);
        const picks = [find(q => q.child), find(q => adult(q) && !q.fem && q.lookK === 'suit'), find(q => q.child), find(q => adult(q) && q.fem), find(q => q.child)];
        const at = [[-7.35, 10.25, 0], [-8.25, 9.95, 0], [-6.15, 10.85, 1], [-5.45, 9.75, 0], [-8.9, 8.6, 2]];
        picks.forEach((p, k) => {
          if (!p) return;
          const [x, z, v] = at[k];
          p.stage = v === 2 ? true : 2; p.x = x; p.z = z; p.yaw = Math.atan2(-9 - x, 13 - z) + (v === 1 ? Math.PI : v === 2 ? 1.2 : 0);
          p.idlePose = 0; p.phone = false; p.fade = p.dfade = 1; p.moving = false; p.vel = 0; p.speed = 1.1;
        });
        // the crossing is mid-wave here: passers-by inside the stage are held out of the frame
        for (const q of c.peds) if (!used.has(q) && Math.hypot(q.x + 7.2, q.z - 10.2) < 5.5) { q.stage = 2; q.fade = q.dfade = 0; }
        c.resortT = 99;
      },
    },
    // inspection: the same five staged walkers, and a log of each one's height on every tier (the part rig, the
    // pool body it is promoted into, the far body): a mismatch is a person who shrinks or grows at a LOD swap
    crowd_heights: {
      pos: [-9, 1.6, 13], lookAt: [-2, 1.1, 6], t: 'night', fov: 40,
      setup(engine) {
        const c = engine.get('crowd'); if (!c) return;
        crowd.shotPresets.crowd_hero.setup(engine);
        setTimeout(() => { try { console.info('[crowd] heights ' + JSON.stringify(c.heightReport())); } catch (e) { console.warn('[crowd] heights failed ' + e.message); } }, 2500);
      },
    },
    // inspection: the part rig's garment fronts at 3-5 m with the pool off -- a zip jacket, a parka, a long coat worn
    // open, a suit V, a crew neck -- walking on the spot toward the lens
    crowd_fronts: {
      pos: [-9, 1.6, 13], lookAt: [-5.5, 1.2, 8.5], t: 'night', fov: 40,
      setup(engine) {
        const c = engine.get('crowd'); if (!c) return;
        c.heroOff = true; for (const H of c.heroes) { H.h.group.visible = false; if (H.ped) H.ped.hero = null; H.ped = null; }
        const used = new Set();
        const find = (f) => { const p = c.peds.find(q => q.kind === 'crosser' && !used.has(q) && !q.bike && !q.leader && !q.members && !q.umb && f(q)); if (p) used.add(p); return p; };
        const picks = [find(q => q.lookK === 'casual' && q.O.openW > 0 && q.O.hemY > 0.8), find(q => q.O.openW > 0 && q.O.hemY < 0.7 && !q.fem),
          find(q => q.lookK === 'suit' && !q.fem), find(q => q.O.openW > 0 && q.fem), find(q => q.lookK === 'street')];
        picks.forEach((p, k) => {
          if (!p) return;
          p.stage = true; p.x = -8.2 + k * 1.1; p.z = 9.6 - (k & 1) * 0.8; p.yaw = Math.atan2(-9 - p.x, 13 - p.z);
          p.speed = 1.1; p.fade = p.dfade = 1; p.phone = false;
        });
        c.resortT = 99;
      },
    },
    // the instanced rig on its own (LOD0 pool off) at 6-30 m: this is what most of every wide shot is made of
    crowd_lod1: {
      pos: [-11, 1.58, 9.5], lookAt: [-3.5, 1.45, 1.5], t: 'night', fov: 30,
      setup(engine) { const c = engine.get('crowd'); if (c) { c.heroOff = true; for (const H of c.heroes) { H.h.group.visible = false; if (H.ped) H.ped.hero = null; H.ped = null; } } },
    },
    // the onlooker ring from above and from the gallery's side (staged brawl, combat.js calls gawk())
    // the onlooker ring without a fight (no combat camera): gawk() called directly on the crossing
    crowd_ring: {
      pos: [2, 26, 12], lookAt: [0, 0, 0], t: 'night', fov: 50,
      setup(engine) { const c = engine.get('crowd'); if (c) c.gawk({ x: 0, z: 0 }, 8.5, 18); },
    },
    crowd_ring_low: {
      pos: [-3, 1.65, 6.5], lookAt: [6, 1.3, -9], t: 'night', fov: 50,
      setup(engine) { const c = engine.get('crowd'); if (c) c.gawk({ x: 0, z: 0 }, 8.5, 18); },
    },
    // the ring forming live (no snap): 5 s of simulation in setup, then the frame; logs how many reached a slot,
    // then the same for releaseGawk() walking them home
    crowd_ring_live: {
      pos: [-3, 1.65, 6.5], lookAt: [6, 1.3, -9], t: 'night', fov: 50,
      setup(engine) {
        const c = engine.get('crowd'); if (!c) return;
        const shot = engine.params.shot; engine.params.shot = null;
        c.gawk({ x: 0, z: 0 }, 8.5, 18);
        engine.params.shot = shot;
        let t = 100; const dt = 1 / 30;
        const report = (tag) => {
          const m = c.peds.filter(p => p.gawk), d = m.map(p => Math.hypot(p.x - (p.gawk.release ? p.gawk.rx : p.gawk.tx), p.z - (p.gawk.release ? p.gawk.rz : p.gawk.tz)));
          const face = m.filter(p => !p.gawk.release && Math.abs(wrapPi(Math.atan2(c.gk.x - p.x, c.gk.z - p.z) - p.yaw)) < 0.6).length;
          console.info(`[crowd] ring ${tag}: ${m.length} members, ${d.filter(v => v < 0.3).length} at their spot, mean ${(d.reduce((a, b) => a + b, 0) / Math.max(1, d.length)).toFixed(2)} m off, ${face} facing in`);
        };
        for (let k = 0; k < 150; k++) c.step(dt, t += dt, false);
        report('after 5 s');
        if (engine.params.raw && engine.params.raw.release) {
          c.releaseGawk();
          for (let k = 0; k < 300; k++) c.step(dt, t += dt, false);
          report('10 s after release');
        }
      },
    },
    crowd_face1: {
      pos: [-15, 1.62, 13], lookAt: [-4, 1.5, 2], t: 'night', fov: 20,
      setup(engine) { const c = engine.get('crowd'); if (c) { c.heroOff = true; for (const H of c.heroes) { H.h.group.visible = false; if (H.ped) H.ped.hero = null; H.ped = null; } } },
    },
    crowd_lod1_far: {
      pos: [-22, 1.7, 22], lookAt: [6, 1.2, -4], t: 'night', fov: 32,
      setup(engine) { const c = engine.get('crowd'); if (c) { c.heroOff = true; for (const H of c.heroes) { H.h.group.visible = false; if (H.ped) H.ped.hero = null; H.ped = null; } } },
    },
    // the ticket-gate band at ~14 m: this is where the instanced face has to still read as a face
    crowd_gate: { pos: [25, 2.05, 25.5], lookAt: [41, 1.5, 22.5] },
    crowd_gate_day: { pos: [25, 2.05, 25.5], lookAt: [41, 1.5, 22.5], t: 'day' },
    // A/B for the "bodies inside the building" report: same frame with every crowd mesh hidden
    crowd_ab_centergai: {
      pos: [-40, 1.6, -28], lookAt: [-40, 4, -100], t: 'night',
      setup(engine) { const c = engine.get('crowd'); if (c) for (const m of [...c.meshes, ...c.casters]) m.visible = false; },
    },
    // crowd-off A/B on the heaviest preset: what this module actually bills against the frame budget
    crowd_ab_day: {
      pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'day',
      setup(engine) {
        const c = engine.get('crowd');
        if (!c) return;
        for (const m of [...c.meshes, ...c.casters]) m.visible = false;
        c.heroOff = true;
        for (const H of c.heroes) { H.h.group.visible = false; H.ped = null; }
      },
    },
    // torso-only: what the body silhouette actually covers, for debugging limb/torso attachment
    crowd_dbg_torso: {
      pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'day',
      setup(engine) { const c = engine.get('crowd'); if (c) for (const m of c.meshes) m.visible = (m === c.torso); },
    },
    // isolates the REAL sun shadows: every multiply-blended ground decal is hidden, so anything dark left on
    // the asphalt under a body is a shadow map sample and nothing else
    crowd_cast: {
      pos: [-14, 9, 16], lookAt: [6, 0, -6], t: 'day', fov: 40,
      setup(engine) { const c = engine.get('crowd'); if (c) for (const m of [c.blob, c.contact, c.smear]) m.visible = false; },
    },
    // wet-road mirror with the multiply-blended contact decals off, so the reflected bodies are not masked
    crowd_refl: {
      pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'night',
      setup(engine) { const c = engine.get('crowd'); if (c) for (const m of [c.blob, c.contact, c.smear]) m.visible = false; },
    },
  },

  init(engine) {
    this.engine = engine;
    const city = engine.get('city');
    this.field = city && city.field ? city.field : null;   // signed distance to the carriageway edge
    const rng = engine.rng.fork(404);
    this.rng = rng;
    const peds = this.peds;
    this.frame = 0; this.resortT = 99; this.camAt = new THREE.Vector3(1e9, 0, 0);
    this.fightT = 0; this.shockT = 0; this.shockX = 0; this.shockZ = 0;
    this.sunYaw = 0; this.sunLen = 1; this.sunOX = 0; this.sunOZ = 0; this.nightBlob = 0;
    // the scanned people (null: the legacy procedural crowd -- ?crowdLegacy=1, or no scan registry at all)
    this.scanSrc = scanSource();
    this.scanR = null; this.swapD = SWAP_D;

    this.buildLinks();
    this.seedCrossers(rng);
    this.seedWalkers(rng, city);
    this.seedPlaza(rng, city);
    this.seedIdlers(rng, city);
    this.seedRoles(rng, city);
    this.buildSpans();
    this.dedupe(rng);
    this.thinNearScramble(engine.rng.fork(405));
    for (const q of peds) q.pk = poolKey(q);                 // the pool template each look maps to (null: part rig only)
    this.buildObstacles();
    // the officers hold their post (stepIdler, lensPush), so they are cleared of the furniture once, here
    for (const q of peds) if (q.police) { for (let k = 0; k < 8; k++) this.obstaclePush(q, true, 1); q.hx = q.x; q.hz = q.z; }
    for (let i = 0; i < peds.length; i++) peds[i].index = i;
    this.count = peds.length;
    const N = this.count;

    // ---- instanced parts
    const G = buildParts();
    this.G = G;
    const aniso = engine.renderer.capabilities.getMaxAnisotropy();
    const cloth = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, vertexColors: true });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.84, vertexColors: true });
    const trouser = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, vertexColors: true });
    const leather = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.52, metalness: 0.04, vertexColors: true });
    const shoeM = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.50, metalness: 0.04, vertexColors: true });
    const sleeveU = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.84, vertexColors: true });
    const trouserS = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, vertexColors: true });
    const skin = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, map: faceTexture(aniso) });
    const skinPlain = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.60 });
    // hair is the one part of a dark body that should catch a highlight: at 0.66 roughness a black-haired head
    // against a navy coat is one continuous dark lump and the crowd loses its heads at 20 m
    const hair = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.50, envMapIntensity: 0.85, vertexColors: true, side: THREE.DoubleSide });
    const umb = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.68, metalness: 0.06, envMapIntensity: 0.18, side: THREE.DoubleSide, vertexColors: true });
    // the transparent vinyl dome is Shibuya's signature umbrella: it has to read as vinyl -- a tight specular
    // sheen along the ribs and the neon behind it coming through -- not as a faint smudge
    const umbV = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.09, metalness: 0.0, envMapIntensity: 0.55, side: THREE.DoubleSide, transparent: true, opacity: 0.42, depthWrite: false, vertexColors: true });
    // the phone screen is the brightest thing on a person in an unlit alley: one constant colour, no per-instance
    // write (470 identical setColorAt calls per resort bought nothing), and the intensity rides the night factor
    const glass = new THREE.MeshStandardMaterial({ color: 0x8c9ab4, roughness: 0.18, metalness: 0.4, emissive: 0x8fa6c8, emissiveIntensity: 0.6, vertexColors: true });
    // iCard: the same instance slot holds a flyer / tissue pack for the hand-out people -- a pale card, unlit
    glass.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float iCard; varying float vCard;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCard = iCard;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCard;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.80, 0.78), vCard);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= 1.0 - vCard;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.85, vCard);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.r * (1.0 - vCard);');
    };
    glass.customProgramCacheKey = () => 'crowd-phone5';
    const shadow = (map) => new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true, toneMapped: false });
    const blobTex = decalTexture(64, 0.30, 0.72);
    // the standing contact pad: a 0.22 core at #4a4a4a (was 0.34 at #1a1a1a) -- under a bright shopfront the old one
    // read as the black base of a mannequin stand (fix round 1, critic: the bookstore pavement)
    const blob = shadow(blobTex), contact = shadow(decalTexture(32, 0.22, 0.74, '#4a4a4a')), smear = shadow(blobTex);
    const glow = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, color: 0x9fb6dc });
    this.mats = { cloth, sleeve, sleeveU, trouser, trouserS, leather, shoeM, skin, skinPlain, hair, umb, umbV, glass, blob, contact, smear, glow };

    // per-instance face-atlas tile: one instanceColor still drives the skin tone, the offset picks the variant
    const faceOff = new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2);
    faceOff.setUsage(THREE.DynamicDrawUsage);
    G.head.setAttribute('aFaceOff', faceOff);
    this.faceOff = faceOff;

    // ---- rim light. A flat per-instance multiply cannot separate a body from a lit shopfront behind it: under
    // the STARBEANS frontage every garment went to a black cut-out. aRim carries the summed pool colour that
    // reaches that pedestrian and a view-dependent fresnel adds it at the silhouette edge, which is where a
    // real body standing under a sign actually catches light.
    const rim = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    rim.setUsage(THREE.DynamicDrawUsage);
    for (const g of [G.torso, G.uarm, G.farm, G.thigh, G.shin, G.head, G.hairCap, G.hairLong, G.hairBun]) g.setAttribute('aRim', rim);
    this.rim = rim;
    // A rim is an EDGE. Round 2 shipped `vRimC * (0.20 + 0.80*F)`, i.e. a floor of 0.20 x vRimC on EVERY
    // fragment -- and because the body is built from thin cylinders, F is near 1 across most of a limb's
    // projected area anyway, so in practice it was a flat +0.10 add. Measured at crossing_night: the torso
    // instanceColor spans 0.004..0.765 across the 470 visible bodies while vRimC was a near-constant
    // 0.104 for all of them, against a lit night garment whose radiance is ~0.013. The additive term was
    // ~10x the albedo term and 60:1 of garment contrast collapsed to 1.2:1 -- the pale zombie horde.
    // Now: no flat term, and the rim is scaled by the body's own (sqrt-compressed) albedo, so a black wool
    // coat catches a faint edge and a cream mac catches a bright one instead of both going the same grey.
    // Soft knee on each light's direct irradiance, night only. A vending machine's face light or a shopfront pool
    // under a metre away reached these materials at 10-100x a street's irradiance, and the heads and hands beside
    // the Tojo Cola machine glowed like lamps (one of them on the machine's unlit side). A per-light knee keeps
    // ordinary street light linear and rolls a hot spot over to ~3.
    const kneeU = this.kneeU = { value: 0 };
    // linear up to a street lamp's irradiance (~1.5), then rolled off to a ~2.7 ceiling, so an ordinary street
    // is untouched and a face light at arm's length reads as a bright pool rather than a lamp
    const LIGHTS_KNEE = THREE.ShaderChunk.lights_physical_pars_fragment.replace('vec3 irradiance = dotNL * directLight.color;',
      'vec3 irradiance = dotNL * directLight.color;\n\t{ float km = max(max(irradiance.r, irradiance.g), irradiance.b);\n\t  if (km > 1.5 && crowdKnee > 0.0) irradiance *= mix(1.0, (1.5 + (km - 1.5) / (1.0 + (km - 1.5) / 1.2)) / km, crowdKnee); }');
    const knee = (sh) => {
      sh.uniforms.crowdKnee = kneeU;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float crowdKnee;')
        .replace('#include <lights_physical_pars_fragment>', () => LIGHTS_KNEE);
    };
    this.knee = knee;
    // aRim = (packed rim colour, light direction x, z): the colour of the brightest emitter near that pedestrian
    // (a sign, a screen, a shopfront, found in refreshColors), sqrt-encoded 8 bits a channel into one float, and the
    // horizontal direction to it. The critic: the mid crowd were black cut-outs a few metres from the 109 screen and
    // the karaoke neon, and the rim was an even outline on both sides whatever the light -- a sticker edge. Now the
    // rim is on the side that faces the emitter only, and the same colour fills that side of the body a little (the
    // sign's own light on the cloth), both off inside ~3 m where the real lights carry the form.
    const rimPatch = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aRim; varying vec3 vRimC; varying vec3 vRimL;
          vec3 crowdRimDecode(float pk) { float r = floor(pk / 65536.0); float g = floor((pk - r * 65536.0) / 256.0); float b = pk - r * 65536.0 - g * 256.0; vec3 e = vec3(r, g, b) / 255.0; return e * e; }`)
        .replace('#include <begin_vertex>', `vRimC = crowdRimDecode(aRim.x);
          vRimL = (abs(aRim.y) + abs(aRim.z) > 0.01) ? normalize((viewMatrix * vec4(aRim.y, 0.0, aRim.z, 0.0)).xyz) : vec3(0.0);
          #include <begin_vertex>`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRimC; varying vec3 vRimL;')
        // fix round 2: the rim is a fresnel edge on both sides (x2.5, the lit side fuller), and every normal that
        // faces down picks up a bounce of the same colour off the wet asphalt -- the neon a Kamurocho crowd wears
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
          { vec3 rN = normalize(normal);
            float rNV = 1.0 - clamp(dot(rN, normalize(vViewPosition)), 0.0, 1.0);
            float crowdF = rNV * rNV;
            float rSide = dot(vRimL, vRimL) > 0.25 ? clamp(dot(rN, vRimL) * 0.7 + 0.55, 0.3, 1.0) : 0.6;
            float rCam = clamp((length(vViewPosition) - 3.0) / 6.0, 0.0, 1.0);
            vec3 rAlb = 0.28 + 0.72 * sqrt(diffuseColor.rgb);
            float rBounce = clamp((0.3 - (vec4(rN, 0.0) * viewMatrix).y) / 1.3, 0.0, 1.0);
            gl_FragColor.rgb += vRimC * rCam * (rSide * (crowdF * 2.5 * rAlb + CROWD_FILL * diffuseColor.rgb) + 0.15 * rBounce * rAlb); }`);
      sh.fragmentShader = '#define CROWD_FILL 0.85\n' + sh.fragmentShader;
      knee(sh);
    };
    trouser.onBeforeCompile = rimPatch; trouser.customProgramCacheKey = () => 'crowd-rim3';
    // Cloth folds, near tier only: a procedural height field (horizontal creases bunched at the waist, the armpit
    // and the elbow, a slow diagonal drape) turned into a normal by screen-space derivatives -- no texture, no
    // tangents, and it fades out by 12 m, where it would only shimmer. At 1-6 m the flat vertex-colour garment
    // was the tell that these were the instanced people.
    const BUMP = `vec3 crowdBump(vec3 n, float h) {
      vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
      float dhx = dFdx(h), dhy = dFdy(h);
      vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
      float det = dot(dpx, r1);
      vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
      return normalize(abs(det) * n - grad);
    }
    float crowdNearK() { return clamp(1.0 - (length(vViewPosition) - 3.0) / 9.0, 0.0, 1.0); }
    // a fold on pale cloth is a strong value change: the same height field that reads as wool on navy printed a
    // chevron on a cream jacket, so the relief halves on light garments
    float crowdLumK(vec3 c) { return mix(1.0, 0.45, smoothstep(0.06, 0.32, dot(c, vec3(0.299, 0.587, 0.114)))); }\n`;
    this.BUMP = BUMP;
    // Hair: strand clumps as a value break around the head, a Kajiya-Kay sheen band along the strand direction,
    // and a hairline that ends strand by strand (per-clump discard over the last ring) instead of a ruler-cut
    // helmet edge. Both details fade out once a clump is under a pixel.
    hair.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aEdge; varying float vEdge; varying vec3 vHairP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdge = aEdge; vHairP = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vEdge; varying vec3 vHairP;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float hAz = atan(vHairP.x, vHairP.z + 0.004);
          float hS = hAz * CROWD_HAIR_F + sin(vHairP.y * 55.0) * 0.35;
          float hN = fract(sin(floor(hS) * 91.7) * 43758.5);
          float hN2 = fract(sin(floor(hS * 2.7 + 5.0) * 57.3) * 24634.6);
          float hW = clamp(fwidth(hS) * 1.5, 0.0, 1.0);
          diffuseColor.rgb *= mix(0.74 + 0.40 * hN * (0.55 + 0.45 * hN2), 0.94, hW);
          if (vEdge > 0.70 && hW < 0.55 && vEdge > 0.76 + 0.24 * hN) discard;
          // long hair's hem (below the skull): the last tenth dissolves as a per-clump alpha dither, at any size
          if (vHairP.y < 1.45 && vEdge > 0.90 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) < (vEdge - 0.90) * 10.0 * (0.45 + 0.55 * hN2)) discard;`);
      rimPatch(sh);
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
          { vec3 kN = normalize(normal), kV = normalize(vViewPosition);
            vec3 kU = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
            vec3 kT = normalize(kU - kN * dot(kU, kN) + 1e-4);
            float kTH = dot(kT, normalize(kV + kU));
            float kS = pow(max(0.0, 1.0 - kTH * kTH), 40.0) * (0.45 + 0.55 * hN) * (1.0 - hW * 0.7);
            gl_FragColor.rgb += kS * (vRimC * 0.55 + vec3(0.018)); }`);
    };
    hair.customProgramCacheKey = () => 'crowd-hair7';
    hair.defines = { ...(hair.defines || {}), CROWD_HAIR_F: '30.0' };
    sleeve.onBeforeCompile = (sh) => {
      inject(sh, {
        vh: 'varying vec3 vLp;', vb: 'vLp = position;',
        fh: 'varying vec3 vLp;\n' + BUMP,
      });
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { float k = crowdNearK() * crowdLumK(diffuseColor.rgb); if (k > 0.0) {
          float a = atan(vLp.x, vLp.z);
          float h = sin(vLp.y * 120.0 + sin(a * 2.0) * 1.6) * (0.25 + 0.75 * exp(-pow((vLp.y + 0.02) / 0.07, 2.0)) + 0.5 * exp(-pow((vLp.y + 0.26) / 0.03, 2.0)));
          normal = crowdBump(normal, h * 0.0018 * k); } }`);
      rimPatch(sh);
    };
    sleeve.customProgramCacheKey = () => 'crowd-farm6';

    // ---- per-instance garment data, slot-indexed exactly like instanceColor and written in refreshColors.
    //      Shapes and garments ride the SAME draw calls as round 3: a pedestrian's build, hem, neckline, skirt,
    //      sleeve length and bare calves are vertex/fragment work on the part it belongs to, not extra meshes.
    this.instBufsA = [];
    const ib = (geo, name, size) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(N * size), size);
      a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); this.instBufsA.push(a);
      return a.array;
    };
    this.iShape = ib(G.torso, 'iShape', 4); this.iStyle = ib(G.torso, 'iStyle', 4); this.iHem = ib(G.torso, 'iHem', 4);
    this.iInner = ib(G.torso, 'iInner', 4); this.iAcc = ib(G.torso, 'iAcc', 3);          // iInner.w: the dithered fade
    this.iInnerA = this.instBufsA[this.instBufsA.length - 2];
    this.iArm = ib(G.uarm, 'iArm', 4); this.iLeg = ib(G.shin, 'iLeg', 1); this.iSole = ib(G.shoe, 'iSole', 3);
    this.iCard = ib(G.phone, 'iCard', 1);
    // bags are packed (only carriers take an instance), so iBag has its own compact index like the bag matrices
    {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
      a.setUsage(THREE.DynamicDrawUsage); G.bag.setAttribute('iBag', a); this.iBagA = a; this.iBag = a.array;
    }
    leather.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aKind; attribute float iBag;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed *= 1.0 - step(0.5, abs(aKind - iBag));');
      knee(sh);
    };
    leather.customProgramCacheKey = () => 'crowd-bag5';
    const inject = (sh, { vh = '', vb = '', fh = '', fb = '' }) => {
      if (vh) sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + vh);
      if (vb) sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vb);
      if (fh) sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + fh);
      if (fb) sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n' + fb);
    };
    // garment edges are shading edges, not geometry: SMAA never sees them, so they are filtered here instead
    const AAS = 'float crowdAA(float e, float x) { float w = max(fwidth(x), 1e-4) * 0.75; return smoothstep(e - w, e + w, x); }\n';
    const MORPH = [
      'float kx = 1.0 + (iShape.x - 1.0) * aMorph.x + (iShape.y - 1.0) * aMorph.y + (iShape.z - 1.0) * aMorph.z;',
      'transformed.x *= kx;',
      'float bust = exp(-pow((transformed.y - 1.27) / 0.075, 2.0)) * step(0.0, transformed.z);',
      'transformed.z *= 1.0 + (iShape.z - 1.0) * aMorph.z * 0.5 + (iShape.w - 1.0) * bust * 2.0;',
      'transformed.y += (iHem.x - 0.80) * aMorph.w;',
      'transformed.xz *= 1.0 + (iHem.y - 1.0) * aMorph.w;',
    ].join('\n');
    cloth.onBeforeCompile = (sh) => {
      inject(sh, {
        vh: 'attribute vec4 aMorph; attribute vec4 iShape; attribute vec4 iStyle; attribute vec4 iHem; attribute vec4 iInner; attribute vec3 iAcc;\n' +
          'varying vec3 vLoc; varying vec4 vStyle; varying vec4 vHem; varying vec3 vInner; varying vec3 vAcc; varying float vAO; varying float vCheap;',
        // vCheap: one value per instance (its chest's distance from the lens), so every fragment of a body takes the
        // same branch and the derivatives inside it stay defined. Past CROWD_CHEAP_D the lapel shade, the open
        // front's turn lines, the zip, the happi band and the fold bump are skipped: at 11 m they are a pixel.
        vb: MORPH + '\nvLoc = transformed; vStyle = iStyle; vHem = iHem; vInner = iInner.rgb; vAcc = iAcc;\n#ifdef USE_COLOR\nvAO = color.r;\n#else\nvAO = 1.0;\n#endif\n' +
          '#ifdef USE_INSTANCING\nvCheap = step(CROWD_CHEAP_D, length((modelViewMatrix * instanceMatrix * vec4(0.0, 1.2, 0.0, 1.0)).xyz));\n#else\nvCheap = 0.0;\n#endif',
        fh: 'varying vec3 vLoc; varying vec4 vStyle; varying vec4 vHem; varying vec3 vInner; varying vec3 vAcc; varying float vAO; varying float vCheap;\nfloat crowdVestK; float crowdVestB;\n' + AAS,
        // neckline / lapel opening (shirt + tie, open collar, coat worn open), lapel edge shade, skirt below the
        // waistband, and the waistband itself
        fb: `{
          float y = vLoc.y, ax = abs(vLoc.x);
          float front = crowdAA(0.0, vLoc.z);
          float open = step(0.0005, vStyle.z);
          // a coat worn open hangs apart toward the hem: the two front edges diverge from the chest down instead of
          // running as two ruled parallels, which from the front read as a slot cut through the body
          float drop = clamp((vStyle.x - y) / max(0.08, vStyle.x - vHem.x), 0.0, 1.0);
          float halfW = vStyle.z * (1.0 + 0.8 * drop * drop) + vStyle.y * max(0.0, y - vStyle.x);
          float lo = open > 0.5 ? vHem.x : vStyle.x;
          float inV = front * (1.0 - crowdAA(halfW, ax)) * crowdAA(lo, y) * step(0.0005, halfW);
          vec3 c = diffuseColor.rgb;
          // what shows in the opening sits BEHIND the garment: it is shaded toward the garment's edges, darkest
          // right under them, so it reads as a layer underneath and not as a flat strip painted on
          float recess = mix(0.52, 1.0, smoothstep(0.0, 0.028, halfW - ax));
          float tw = 0.015 + 0.011 * clamp((1.45 - y) / 0.24, 0.0, 1.0);
          float isTie = step(0.5, vStyle.w) * (1.0 - step(1.5, vStyle.w));
          if (vCheap < 0.5) {
            float lap = front * crowdAA(halfW, ax) * (1.0 - crowdAA(halfW + 0.016, ax)) * crowdAA(vStyle.x, y) * step(0.001, vStyle.y) * step(vStyle.z, 0.0);
            c *= 1.0 - 0.34 * lap;
            c = mix(c, vInner * vAO * recess, inV);
            // the garment's own front edge: the cloth turns over (a thin dark line) with a lit fold just outside it
            float fe = open * front * crowdAA(vHem.x, y);
            c *= 1.0 - 0.40 * fe * crowdAA(halfW, ax) * (1.0 - crowdAA(halfW + 0.007, ax));
            c *= 1.0 + 0.12 * fe * crowdAA(halfW + 0.007, ax) * (1.0 - crowdAA(halfW + 0.032, ax));
            c = mix(c, vAcc * vAO, isTie * inV * (1.0 - crowdAA(tw, ax)) * (1.0 - crowdAA(1.47, y)));
            // happi: the white collar band (the house name's band) runs down both open edges of the front
            float hb = step(1.5, vStyle.w) * (1.0 - step(2.5, vStyle.w)) * front * crowdAA(halfW, ax) * (1.0 - crowdAA(halfW + 0.042, ax)) * crowdAA(vHem.x + 0.01, y) * (1.0 - crowdAA(1.49, y));
            c = mix(c, vAcc * vAO, hb);
            // a zip jacket zipped to the chest: the zipper and its placket from the hem up to the V
            float zip = step(2.5, vStyle.w) * front * crowdAA(vHem.x + 0.012, y) * (1.0 - crowdAA(vStyle.x, y));
            c *= 1.0 - 0.42 * zip * (1.0 - crowdAA(0.0042, ax));
            c *= 1.0 - 0.10 * zip * (1.0 - crowdAA(0.017, ax));
          } else {
            c = mix(c, vInner * vAO * recess, inV);
            c = mix(c, vAcc * vAO, isTie * inV * step(ax, tw) * step(y, 1.47));
          }
          // staff: a bib apron (vest 2) over the shirt -- the shirt shows over the back and the shoulders, the
          // trousers (vAcc) under the waist behind, a strap runs from the bib to the collar
          float apr = step(1.99, vHem.w);
          if (apr > 0.5) {
            float aprF = front * crowdAA(vHem.x + 0.004, y) * (1.0 - crowdAA(1.30, y)) * (1.0 - crowdAA(y > 0.94 ? 0.078 : 0.30, ax));
            float strap = front * crowdAA(1.30, y) * (1.0 - crowdAA(1.47, y)) * (1.0 - crowdAA(0.011, abs(ax - 0.062)));
            vec3 aprC = diffuseColor.rgb;
            c = mix(c, vInner * vAO, (1.0 - aprF) * crowdAA(0.93, y));
            c = mix(c, vAcc * vAO, (1.0 - aprF) * (1.0 - crowdAA(0.93, y)));
            c = mix(c, aprC * 0.9, strap);
            c *= 1.0 - 0.30 * aprF * (1.0 - crowdAA(0.012, abs(y - 0.93)));   // the waist seam
          }
          // police: the night-duty 反射ベスト -- a fluorescent yellow-green vest over the navy tunic with two silver
          // retroreflective bands, bright enough to read at 15-25 m at night (a little emissive below: the tape
          // catches every light in the square)
          float pol = step(0.99, vHem.w) * (1.0 - apr), vest = pol * crowdAA(0.93, y) * (1.0 - crowdAA(1.43, y)) * (1.0 - inV);
          float vb = pol * (crowdAA(1.00, y) * (1.0 - crowdAA(1.06, y)) + crowdAA(1.20, y) * (1.0 - crowdAA(1.26, y))) * (1.0 - inV);
          c = mix(c, vAcc * vAO * 1.35, vest);
          c = mix(c, vec3(0.62, 0.64, 0.62) * vAO, vb);
          crowdVestK = vest; crowdVestB = vb;
          float hasSk = step(0.1, vHem.z);
          c = mix(c, vAcc * vAO, hasSk * (1.0 - crowdAA(vHem.z, y)));
          c *= 1.0 - 0.30 * hasSk * (1.0 - crowdAA(0.015, abs(y - vHem.z)));
          c *= 1.0 - 0.22 * (1.0 - crowdAA(vHem.x + 0.02, y));
          diffuseColor.rgb = c;
        }`,
      });
      sh.fragmentShader = sh.fragmentShader.replace('float crowdVestB;\n' + AAS, 'float crowdVestB;\n' + AAS + BUMP)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vAcc * crowdVestK * 0.10 + vec3(0.30) * crowdVestB;')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { float k = vCheap < 0.5 ? crowdNearK() * crowdLumK(diffuseColor.rgb) : 0.0; if (k > 0.0) {
          vec3 q = vLoc;
          float dr = fract(vHem.w) * 6.2832;
          vec2 dd = vec2(cos(dr), sin(dr) * 0.6 + 0.4);
          float waist = exp(-pow((q.y - vHem.x - 0.20) / 0.09, 2.0)), pit = exp(-pow((q.y - 1.31) / 0.07, 2.0)) * smoothstep(0.09, 0.15, abs(q.x));
          float h = sin(q.y * 95.0 + sin(q.x * 31.0 + q.z * 23.0 + dr) * 2.2 + dr * 3.0) * (0.22 + 0.78 * waist + 0.7 * pit) + sin(dot(q.xy, dd) * 40.0 + dr) * 0.20;
          normal = crowdBump(normal, h * 0.0024 * k); } }`);
      rimPatch(sh);
    };
    cloth.customProgramCacheKey = () => 'crowd-torso8';
    cloth.defines = { ...(cloth.defines || {}), CROWD_CHEAP_D: '11.0' };
    // the short sleeve's hem is not ruler-cut: it rides up at the outside of the arm and dips under it, and it
    // stands a few millimetres proud, so it casts a thin shade line onto the arm below
    sleeveU.onBeforeCompile = (sh) => {
      inject(sh, {
        vh: 'attribute vec4 iArm; varying vec4 vArm; varying float vLy; varying vec2 vLxz; varying float vAO2;',
        vb: 'vArm = iArm; vLy = position.y; vLxz = position.xz;\n#ifdef USE_COLOR\nvAO2 = color.r;\n#else\nvAO2 = 1.0;\n#endif',
        fh: 'varying vec4 vArm; varying float vLy; varying vec2 vLxz; varying float vAO2;\n' + AAS + BUMP,
        fb: 'float sA = atan(vLxz.x, vLxz.y); float sEnd = vArm.w + 0.012 * sin(sA) + 0.004 * sin(sA * 3.0 + 1.3);\n' +
          'diffuseColor.rgb = mix(diffuseColor.rgb, vArm.rgb * mix(0.86, 1.0, vAO2), 1.0 - crowdAA(sEnd, vLy));\n' +
          'diffuseColor.rgb *= 1.0 - 0.32 * (1.0 - crowdAA(0.016, vLy - sEnd + 0.012)) * crowdAA(sEnd - 0.03, vLy) * step(-1.0, vArm.w);',
      });
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { float k = crowdNearK() * crowdLumK(diffuseColor.rgb); if (k > 0.0 && vLy > vArm.w) {
          float a = atan(vLxz.x, vLxz.y);
          float h = sin(vLy * 110.0 + sin(a * 2.0) * 1.5) * (0.25 + 0.75 * exp(-pow((vLy + 0.26) / 0.06, 2.0)) + 0.6 * exp(-pow((vLy - 0.02) / 0.05, 2.0)));
          normal = crowdBump(normal, h * 0.0018 * k); } }`);
      rimPatch(sh);
    };
    sleeveU.customProgramCacheKey = () => 'crowd-uarm6';
    trouserS.onBeforeCompile = (sh) => {
      inject(sh, { vh: 'attribute vec3 aBare; attribute float iLeg;', vb: 'transformed += aBare * iLeg;' });
      rimPatch(sh);
    };
    trouserS.customProgramCacheKey = () => 'crowd-shin5';
    shoeM.onBeforeCompile = (sh) => {
      inject(sh, {
        vh: 'attribute vec3 iSole; varying vec3 vSole; varying float vLy;',
        vb: 'vSole = iSole; vLy = position.y;',
        fh: 'varying vec3 vSole; varying float vLy;\n' + AAS,
        fb: 'diffuseColor.rgb = mix(diffuseColor.rgb, vSole, 1.0 - crowdAA(-0.0825, vLy));',
      });
      knee(sh);
    };
    shoeM.customProgramCacheKey = () => 'crowd-shoe5';
    skinPlain.onBeforeCompile = knee; skinPlain.customProgramCacheKey = () => 'crowd-hand1';
    // the hem and build morph has to reach the shadow pass too, or a long coat casts a jacket's shadow
    const torsoDepth = new THREE.MeshDepthMaterial();
    torsoDepth.onBeforeCompile = (sh) => inject(sh, { vh: 'attribute vec4 aMorph; attribute vec4 iShape; attribute vec4 iHem;', vb: MORPH });
    torsoDepth.customProgramCacheKey = () => 'crowd-torso-depth4';
    this.torsoDepth = torsoDepth;
    skin.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aFaceOff;')
        .replace('#include <begin_vertex>', '#ifdef USE_MAP\n\tvMapUv = vMapUv * 0.5 + aFaceOff;\n#endif\n#include <begin_vertex>');
      rimPatch(sh);
    };
    skin.customProgramCacheKey = () => 'crowd-face-atlas2';

    // ---- the dithered fade. Someone coming out of a door, going through a portal, rejoining a gate queue or
    //      standing inside the lens bubble dissolves as a screen-door pattern at full size. iHide per instance
    //      (0 drawn, 1 gone); a mesh without the attribute reads the WebGL default 0 and is simply drawn.
    const hideA = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    hideA.setUsage(THREE.DynamicDrawUsage);
    // (the torso and the far body are at WebGL's 16-attribute limit: theirs rides iInner.w and iHairF.w instead)
    for (const g of [G.head, G.hairCap, G.thigh, G.shin, G.shoe, G.uarm, G.farm, G.hand, G.phone, G.umbrella, G.umbFold]) g.setAttribute('iHide', hideA);
    this.hideA = hideA; this.hide = hideA.array;
    const hidePatch = (m, expr = 'iHide', decl = 'attribute float iHide;') => {
      const ob = m.onBeforeCompile, ck = m.customProgramCacheKey;
      m.onBeforeCompile = (sh, r) => {
        if (ob) ob.call(m, sh, r);
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + decl + ' varying float vCrowdHide;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCrowdHide = ' + expr + ';');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vCrowdHide;')
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n\tif (vCrowdHide > 0.003 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) < vCrowdHide) discard;');
      };
      m.customProgramCacheKey = () => (ck ? ck.call(m) : '') + '|hide1';
    };
    this.hidePatch = hidePatch;
    for (const m of [sleeve, sleeveU, trouser, trouserS, leather, shoeM, skin, skinPlain, hair, umb, umbV, glass]) hidePatch(m);
    hidePatch(cloth, 'iInner.w', ''); hidePatch(torsoDepth, 'iInner.w', 'attribute vec4 iInner;');
    // the limbs cast with their own depth material so a dissolving body's shadow dissolves with it
    const limbDepth = new THREE.MeshDepthMaterial(); limbDepth.customProgramCacheKey = () => 'crowd-limb-depth';
    hidePatch(limbDepth);

    const mk = (name, geo, mat) => {
      const im = new THREE.InstancedMesh(geo, mat, N);
      im.frustumCulled = false;                       // slot packing + the distance sort do the culling
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = false; im.receiveShadow = true;
      im.name = 'crowd:' + name;
      engine.scene.add(im);
      return im;
    };
    this.torso = mk('torso', G.torso, cloth); this.head = mk('head', G.head, skin);
    // long hair, buns, caps and bags are PACKED: only the people who wear one take an instance (they were a zero-scale
    // instance on every part-rig slot, i.e. triangles on the frame for nobody). Each keeps its own compact colour
    // and rim buffers, written with the matrices.
    this.packed = [];
    const pack = (name, geo, mat, rimOn) => {
      const col = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3); col.setUsage(THREE.DynamicDrawUsage);
      const hid = new THREE.InstancedBufferAttribute(new Float32Array(N), 1); hid.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('iHide', hid);
      let rimA = null;
      if (rimOn) { rimA = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3); rimA.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('aRim', rimA); }
      const im = mk(name, geo, mat);
      im.instanceColor = col; im.count = 0;
      const P = { im, col: col.array, colA: col, rim: rimA ? rimA.array : null, rimA, n: 0, hide: hid.array, hideA: hid };
      this.packed.push(P);
      return P;
    };
    this.hairCap = mk('hair', G.hairCap, hair);
    this.pHairLong = pack('hairLong', G.hairLong, hair, true); this.hairLong = this.pHairLong.im;
    this.pHairBun = pack('hairBun', G.hairBun, hair, true); this.hairBun = this.pHairBun.im;
    const capM = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, vertexColors: true });
    capM.onBeforeCompile = knee; capM.customProgramCacheKey = () => 'crowd-cap1';
    hidePatch(capM);
    this.mats.cap = capM;
    this.pCap = pack('cap', G.cap, capM, false); this.cap = this.pCap.im;
    this.thighL = mk('thighL', G.thigh, trouser); this.thighR = mk('thighR', G.thigh, trouser);
    this.shinL = mk('shinL', G.shin, trouserS); this.shinR = mk('shinR', G.shin, trouserS);
    this.shoeL = mk('shoeL', G.shoe, shoeM); this.shoeR = mk('shoeR', G.shoe, shoeM);
    this.uarmL = mk('uarmL', G.uarm, sleeveU); this.uarmR = mk('uarmR', G.uarm, sleeveU);
    this.torso.customDepthMaterial = this.torsoDepth;
    for (const m of [this.thighL, this.thighR, this.shinL, this.shinR]) m.customDepthMaterial = limbDepth;
    this.farmL = mk('farmL', G.farm, sleeve); this.farmR = mk('farmR', G.farm, sleeve);
    this.handL = mk('handL', G.hand, skinPlain); this.handR = mk('handR', G.hand, skinPlain);
    this.pBag = pack('bag', G.bag, leather, false); this.bag = this.pBag.im; this.phone = mk('phone', G.phone, glass);
    this.umbrella = mk('umbrella', G.umbrella, umb); this.umbrellaV = mk('umbrellaV', G.umbrella, umbV);
    this.umbFold = mk('umbFold', G.umbFold, umb);
    this.umbrellaV.renderOrder = 3;
    this.blob = mk('blob', G.blob, blob); this.contact = mk('contact', G.contact, contact);
    this.smear = mk('smear', G.smear, smear);
    this.phoneGlow = mk('phoneGlow', G.glow, glow);
    for (const m of [this.blob, this.contact, this.smear]) { m.receiveShadow = false; m.renderOrder = 2; }
    this.phoneGlow.receiveShadow = false; this.phoneGlow.renderOrder = 4;

    // ---- far tier: one mesh, one draw, its own instance index (k = slot - nDet)
    G.far.setAttribute('aAO', G.far.getAttribute('color')); G.far.deleteAttribute('color');
    const fb = (name, size) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(N * size), size);
      a.setUsage(THREE.DynamicDrawUsage); G.far.setAttribute(name, a); return a;
    };
    this.fTop = fb('iTop', 4); this.fLeg = fb('iLegF', 4); this.fSkin = fb('iSkinF', 4); this.fHair = fb('iHairF', 4); this.fRim = fb('aRim', 3);
    this.farBufs = [this.fTop, this.fLeg, this.fSkin, this.fHair, this.fRim];
    const farM = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.84 });
    farM.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart; attribute float aLimb; attribute float aHem; attribute float aAO;\n' +
          'attribute vec4 iTop; attribute vec4 iLegF; attribute vec4 iSkinF; attribute vec4 iHairF; varying vec3 vFar;')
        // legs and arms scissor about the hip / shoulder; the normal turns with them
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          float fA = 0.0; vec3 fP = vec3(0.0, 0.90, 0.0);
          float fSw = sin(iLegF.w) * iSkinF.w;
          if (aLimb > 0.5) {
            if (aLimb < 1.5) fA = -fSw; else if (aLimb < 2.5) fA = fSw;
            else { fP.y = 1.395; fA = (aLimb < 3.5 ? fSw : -fSw) * 0.75; }
          }
          float fc = cos(fA), fs = sin(fA);
          objectNormal = vec3(objectNormal.x, objectNormal.y * fc - objectNormal.z * fs, objectNormal.y * fs + objectNormal.z * fc);`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float fHemY = mod(iHairF.w, 2.0);            // iHairF.w = hem height + 2 x (fade step 0..63)
          transformed.y += (fHemY - 0.80) * aHem;
          transformed.xz *= 1.0 + (fHemY < 0.7 ? 0.22 : 0.0) * aHem;
          vec3 fq = transformed - fP;
          transformed = fP + vec3(fq.x, fq.y * fc - fq.z * fs, fq.y * fs + fq.z * fc);
          int fNeed = int(aPart + 0.5) >> 4;
          float fPart = float(int(aPart + 0.5) & 15);
          if (fNeed > 0 && (int(iTop.w + 0.5) & fNeed) == 0) transformed = vec3(0.0, 1.0, 0.0);
          vec3 fCol = iTop.rgb;
          if (fPart > 0.5) fCol = fPart < 1.5 ? iSkinF.rgb : fPart < 2.5 ? iHairF.rgb : fPart < 3.5 ? iLegF.rgb : fPart < 4.5 ? iLegF.rgb * 0.45 : fPart < 5.5 ? iTop.rgb * 0.84 : iTop.rgb * 0.30 + iLegF.rgb * 0.25;
          vFar = fCol * aAO;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFar;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vFar;');
      rimPatch(sh);
      // fix round 1 (critic: half the 15-40 m band were paper cut-outs): the far body has no fold relief, lapel or
      // bump to catch a highlight, so it takes a fuller share of the sign fill (CROWD_FILL 1.3) and a hemisphere /
      // wet-road bounce of the same neon tint -- 0.35 of the sign's light on the body's own albedo (a multiply, hue
      // kept; the sign's light is ~4x a street's, hence the 1.4), fuller on the surfaces that face the sky and the
      // wet road than on the ones that face the lens
      sh.fragmentShader = sh.fragmentShader.replace('#define CROWD_FILL 0.85', '#define CROWD_FILL 1.3')
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
          { float fUp = clamp((vec4(normalize(normal), 0.0) * viewMatrix).y * 0.5 + 0.5, 0.0, 1.0);
            gl_FragColor.rgb += vRimC * 1.4 * vFar * (0.55 + 0.45 * fUp) * (0.28 + 0.72 * sqrt(dot(vFar, vec3(0.333)))); }`);
    };
    farM.customProgramCacheKey = () => 'crowd-far7';
    hidePatch(farM, 'floor(iHairF.w * 0.5) / 63.0', '');
    this.mats.far = farM;
    this.far = new THREE.InstancedMesh(G.far, farM, N);
    this.far.frustumCulled = false; this.far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.far.castShadow = false; this.far.receiveShadow = true; this.far.name = 'crowd:far'; this.far.count = 0;
    engine.scene.add(this.far);
    // the cut far body past FAR2_D and the mirror body: same material and layout, their own instance buffers
    const farClone = (src, name) => {
      const g = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'aPart', 'aLimb', 'aHem']) g.setAttribute(k, src.attributes[k]);
      g.setAttribute('aAO', src.attributes.aAO || src.attributes.color);
      g.setIndex(src.index);
      const bufs = {};
      for (const [k, n] of [['iTop', 4], ['iLegF', 4], ['iSkinF', 4], ['iHairF', 4], ['aRim', 3]]) {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(N * n), n); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, a); bufs[k] = a;
      }
      const im = new THREE.InstancedMesh(g, farM, N);
      im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = false; im.receiveShadow = true; im.name = name; im.count = 0;
      engine.scene.add(im);
      return { im, bufs: [bufs.iTop, bufs.iLegF, bufs.iSkinF, bufs.iHairF, bufs.aRim] };
    };
    { const f2 = farClone(G.far2, 'crowd:far2'); this.far2 = f2.im; this.far2Bufs = f2.bufs; }
    {
      // The wet road mirrors the nearest REFL_N bodies as far bodies, in a mesh that only the reflection camera
      // draws (count 0 for every other camera, which three.js skips outright). The part rig no longer sits on the
      // mirror / bloom-mask layer at all: it was drawn a third time, at full count, by the bloom mask pass.
      const fr = farClone(G.far2, 'crowd:farRefl'); this.farRefl = fr.im; this.farReflBufs = fr.bufs;
      const im = this.farRefl;
      im.layers.set(REFL_LAYER);
      im.onBeforeRender = (r, sc, camera) => { im._n = im.count; if (camera.name !== 'reflectionCamera') im.count = 0; };
      im.onAfterRender = () => { if (im._n != null) { im.count = im._n; im._n = null; } };
    }

    // ---- bicycles pushed over the crossing: the props module's own ママチャリ body and wheel pair, instanced here
    //      compactly (only the pushers in view take an instance), 2 draws
    const pI = engine.get('props') && engine.get('props').I;
    const bsrc = pI && pI.get ? pI.get('bike') : null, wsrc = pI && pI.get ? pI.get('bike_wheel') : null;
    this.bikeIdx = [];
    for (let k = 0; k < N; k++) if (peds[k].bike) this.bikeIdx.push(k);
    if (bsrc && wsrc && this.bikeIdx.length) {
      // the frame is thin enough to vanish at night on the props' matte paint: a satin finish with the env turned
      // up lets the tubes catch the neon the way the 横断防止柵 rails do, so the pusher is visibly pushing something
      const bmat = bsrc.material.clone(); bmat.metalness = 0.35; bmat.roughness = 0.34; bmat.envMapIntensity = 1.8; bmat.name = 'crowd:bikePaint';
      const mkB = (src, name) => {
        const im = new THREE.InstancedMesh(src.geometry, bmat, this.bikeIdx.length);
        im.name = name; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = false; im.receiveShadow = true; im.count = 0;
        engine.scene.add(im);
        return im;
      };
      this.bikeMesh = mkB(bsrc, 'crowd:bike'); this.wheelMesh = mkB(wsrc, 'crowd:bikeWheel');
      for (let k = 0; k < this.bikeIdx.length; k++) this.wheelMesh.setColorAt(k, _c.set(0x9aa0a4));
    }

    // decals stand under every visible body; the part rig only inside DET_D; accessories only inside FULL_D
    this.tierAll = [this.blob, this.smear, this.contact];
    this.tierMid = [this.torso, this.head, this.hairCap, this.thighL, this.thighR, this.shinL, this.shinR, this.uarmL, this.uarmR,
      this.shoeL, this.shoeR, this.farmL, this.farmR];
    this.tierHand = [this.handL, this.handR, this.phone, this.phoneGlow, this.umbFold];
    this.tierNear = [this.umbrella, this.umbrellaV];
    this.meshes = [...this.tierAll, ...this.tierMid, ...this.tierHand, ...this.tierNear, this.far, this.far2, ...this.packed.map(P => P.im)];
    // the mirror mesh is not counted: every camera but the reflection camera draws it at count 0
    this.drawN = this.meshes.length + (this.bikeMesh ? 2 : 0);
    this.casters = [];                                // legacy field: the real meshes cast now (see below)

    // ---- shared per-instance colour buffers. Round 1 wrote 23 setColorAt calls and re-uploaded 24 separate
    //      buffers on every resort; parts that always carry the same tone now share one attribute, which is
    //      12 writes and 12 uploads for the identical result.
    this.colBufs = [];
    const mkCol = (list) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
      a.setUsage(THREE.DynamicDrawUsage);
      for (const m of list) m.instanceColor = a;
      this.colBufs.push(a);
      return a.array;
    };
    this.cTorso = mkCol([this.torso]);
    this.cSkinB = mkCol([this.head, this.handL, this.handR]);
    this.cHairB = mkCol([this.hairCap]);
    this.cLegB = mkCol([this.thighL, this.thighR]);
    this.cShinB = mkCol([this.shinL, this.shinR]);
    this.cShoeB = mkCol([this.shoeL, this.shoeR]);
    this.cUarmB = mkCol([this.uarmL, this.uarmR]);
    this.cFarmB = mkCol([this.farmL, this.farmR]);
    this.cUmbB = mkCol([this.umbrella, this.umbrellaV, this.umbFold]);
    this.cBlobB = mkCol([this.blob]);
    this.cContactB = mkCol([this.contact]);
    this.cSmearB = mkCol([this.smear]);
    this.colPed = new Int32Array(N).fill(-1);

    // ---- real shadow casters. The round-1 trick (a shared colorWrite:false / depthWrite:false material on
    //      alias meshes) produced a shared depth-material cache entry that never wrote depth, so under a hard
    //      13:00 sun not one of 300 pedestrians had a shadow. The beauty meshes cast directly instead, with
    //      the same count-swap used for the reflection pass -- onBeforeShadow, which three calls immediately
    //      before renderBufferDirect reads object.count.
    this.shadowSet = [this.torso, this.thighL, this.thighR, this.shinL, this.shinR];
    for (const m of this.shadowSet) {
      m.castShadow = true;
      m.onBeforeShadow = () => { m._shCount = m.count; m.count = Math.min(m.count, this.castN || CAST_N); };
      m.onAfterShadow = () => { if (m._shCount != null) { m.count = m._shCount; m._shCount = null; } };
    }

    // ---- wet-ground reflection: the farRefl mesh above (nearest REFL_N bodies, far-body quality)
    this.reflSet = [this.farRefl];

    // ---- LOD slots + separation grid (all preallocated)
    this.order = new Int32Array(N); this.slotOf = new Int32Array(N); this.key = new Float64Array(N);
    this.bucket = new Uint16Array(N); this.bCount = new Int32Array(NB_TOTAL);
    for (let i = 0; i < N; i++) { this.order[i] = i; this.slotOf[i] = i; }
    this.gHead = new Int32Array(GRID_N * GRID_N); this.gNext = new Int32Array(N);
    this.rHead = new Int32Array(RG_N * RG_N); this.rNext = new Int32Array(N);
    this.sepX = new Float32Array(N); this.sepZ = new Float32Array(N);
    const NV = 1280;                                 // vehicle capsule proxies: ~3-5 per nearby vehicle
    this.vHead = new Int32Array(GRID_N * GRID_N); this.vNext = new Int32Array(NV);
    this.vX = new Float32Array(NV); this.vZ = new Float32Array(NV); this.vR = new Float32Array(NV);
    this.nVeh = 0; this.vCap = NV;
    this.avoid = new Float32Array(64); this.nAvoid = 0;
    this.visible = Math.min(N, MAX_VIS); this.full = Math.min(N, MAX_FULL);

    this.heroes = []; this.heroOff = false; this.heroBudget = LOD0_BIND; this.frameMs = 16.7;
    // the look resolver the pool bodies are keyed against (a named export of humanoid.js, not on its module object)
    this.resolveLook = null;
    import('../characters/humanoid.js').then(m => {
      this.resolveLook = typeof m.resolvePedestrian === 'function' ? m.resolvePedestrian : null;
      if (!this.resolveLook) { this.heroOff = true; console.warn('[crowd] humanoid.js exports no resolvePedestrian: LOD0 pool off'); }
    }).catch(() => { this.heroOff = true; });
    this.heroD = new Float64Array(POOL_MAX);
    // the identity lock: the lens's own velocity (for the prospect test), the cut flag that frees a bind pass, and the
    // swap ledger the crowd-pop probe reads (a swap counts when the pedestrian is in the frustum inside 30 m)
    this.camPX = 1e9; this.camPZ = 0; this.camVX = 0; this.camVZ = 0; this.cutFree = 2;
    this.swaps = { n: 0, inView: 0, inView14: 0, cut: 0, log: [] };
    // (ONE free pass, on the crowd's next step: a second pass up to five frames after the cut was itself a pop)
    // (the scanned crowd detects its cuts at render time, on the frame that shows one: crowdScan.hook)
    engine.events.on('camera:cut', () => { if (this.scanR) { this.cutNow = true; return; } this.cutFree = 1; this.bindNow = true; });

    this.waveId = 0;                                  // step() polls traffic.signal.ped and opens a new wave on each green man
    engine.events.on('combat:start', () => { this.fightT = 14; });
    engine.events.on('combat:end', () => { this.fightT = 0; });
    engine.events.on('combat:hit', (e) => {
      const pos = e && (e.point || (e.target && e.target.position));
      if (pos) { this.shockX = pos.x; this.shockZ = pos.z; this.shockT = 0.85; }
      // the gallery reacts to the big ones: a flinch back with the hands coming up, the collective "ooh"
      if (e && (e.heavy || (e.damage || 0) >= 18)) this.gaspT = 0.9;
    });
    // a kicked or thrown prop landing near a crowd: same flinch path, scaled by whatever strength is reported
    engine.events.on('prop:impact', (e) => {
      const pos = e && (e.point || e.position);
      if (!pos) return;
      this.shockX = pos.x; this.shockZ = pos.z;
      this.shockT = Math.max(this.shockT, clamp(0.5 + (e.strength || 1) * 0.35, 0.4, 1.4));
    });

    this.warmup();
    this.resort();
    if (this.scanSrc) {
      // the scanned crowd: the legacy meshes stay built (A/B, fallback) but are never drawn -- an invisible mesh
      // uploads nothing and costs nothing. Boot waits for the bake (in slices: the page never locks for long), so
      // the first frame already has everybody in it.
      this.legacyVisible(false);
      const R = this.scanR = new CrowdScan(this, this.scanSrc);
      this.swapD = SCAN_SWAP_D;
      // (the whole cap from the first frame: the boot's cut pass is the only bind the people already standing near the
      // lens in view ever get -- started at 8 and grown by the governor, the 9th to 20th stayed instanced all shot long)
      if (!SCAN_POOL_OLD) this.heroBudget = SCAN_LOD0_CAP;
      const t0 = performance.now();
      const done = R.prepare().then(() => {
        if (this.scanR !== R) { R.root.visible = false; return; }   // it timed out and the legacy crowd took over
        this.resort();
        console.info(`[crowd] ${N} pedestrians (${this.nCrossers} crossers, ${this.nWalkers} walkers, ${this.nIdlers} idlers; ${this.thinStat ? this.thinStat.gone + ' of ' + this.thinStat.near + ' idlers round the scramble thinned' : ''}), every one a scanned person (${this.scanSrc.kind}: ${this.scanR.S.filter(Boolean).length} of ${this.scanSrc.all} loaded), ready in ${(performance.now() - t0).toFixed(0)} ms`);
      }).catch((e) => this.scanFailed(e));
      // a scan load that never finishes must not hold the boot: past SCAN_WAIT the legacy crowd takes over
      return Promise.race([done, new Promise((r) => setTimeout(r, SCAN_WAIT))]).then(() => { if (this.scanR && !this.scanR.ready) this.scanFailed(new Error('timed out')); });
    }
    this.writeMatrices(0);
    console.info(`[crowd] ${N} pedestrians (${this.nCrossers} crossers, ${this.nWalkers} walkers, ${this.nIdlers} idlers) on ${this.links.length} crossing links, ${this.drawN} draw calls, ${this.queues.length} gate queues, ${this.nRoles || 0} touts / hand-outs (${this.toutLens || 0} in the Center-gai lens), ${this.bikeIdx.length} bikes pushed, ${this.obs ? this.obs.OB.length : 0} street obstacles, ${this.nRedrawn || 0} clone tops redrawn`);
  },

  // The standing crowd round the scramble, ~55 % fewer (client, 2026-09-25): idlers within SCRAMBLE_THIN_R of the
  // crossing's centre are taken out by whole company -- a clump, a pair, a ticket-gate file goes together, so nobody is
  // left talking to someone who is not there. The koban officers and the touts / hand-outs stay (they are the square's
  // and the street's fixtures, not its crowd). Seeded (engine.rng.fork), so a preset is the same every run.
  thinNearScramble(rng) {
    const peds = this.peds, c = CITY.crossing.center, R2 = SCRAMBLE_THIN_R * SCRAMBLE_THIN_R;
    const cand = peds.filter(q => q.kind === 'idler' && !q.police && !q.role);
    const id = new Map(cand.map((q, i) => [q, i])), par = cand.map((_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const join = (a, b) => { const i = id.get(a), j = id.get(b); if (i == null || j == null) return; const ri = find(i), rj = find(j); if (ri !== rj) par[ri] = rj; };
    for (const q of cand) {
      if (q.mate) join(q, q.mate);
      if (q.leader) join(q, q.leader);
      if (q.qPair) join(q, q.qPair);
      if (Array.isArray(q.members)) for (const m of q.members) join(q, m);
      if (q.queue) for (const m of q.queue.members) join(q, m);
    }
    const comp = new Map();
    cand.forEach((q, i) => { const r = find(i); let C = comp.get(r); if (!C) comp.set(r, C = { list: [], x: 0, z: 0 }); C.list.push(q); C.x += q.x; C.z += q.z; });
    const gone = new Set();
    let near = 0;
    for (const C of comp.values()) {
      const x = C.x / C.list.length, z = C.z / C.list.length;
      if ((x - c[0]) ** 2 + (z - c[1]) ** 2 > R2) continue;
      near += C.list.length;
      if (rng() < SCRAMBLE_THIN_K) for (const q of C.list) gone.add(q);
    }
    if (!gone.size) { this.thinStat = { near, gone: 0 }; return; }
    const keep = peds.filter(q => !gone.has(q));
    peds.length = 0; for (const q of keep) peds.push(q);
    for (const q of peds) {
      if (q.mate && gone.has(q.mate)) { q.mate = null; q.talk = 0; }
      if (q.leader && gone.has(q.leader)) q.leader = null;
      if (Array.isArray(q.members)) q.members = q.members.filter(m => !gone.has(m));
    }
    this.queues = this.queues.filter(Q => !Q.members.some(m => gone.has(m)));
    this.nIdlers = (this.nIdlers || 0) - gone.size;
    this.thinStat = { near, gone: gone.size };
  },

  // ---------------------------------------------------------------------------------------- pedestrian signals
  // 2026-09-25 (client: 「歩行者用の信号を通行人は守るようにして」): the pavement walkers obey the pedestrian signals
  // everywhere, not only on the scramble. Every crowd path (city.buildCrowdPaths: a strip offset from each road, and the
  // pedestrian streets) is walked once here; each stretch of it on the carriageway (the street field < 0) is a SPAN,
  // matched to the crosswalk it lies on:
  //   scramble  a perimeter / diagonal crosswalk of the scramble   -> traffic.signal.ped
  //   zebra     a signalled zebra (traffic.crossingSignal(id))     -> its pedestrian head
  //   junction  a crosswalk at an outer signalled junction          -> walk while the vehicle group PARALLEL to it is
  //             green (Japanese practice), flashing for its last ~5 s, stop on its amber / red
  //   free      an unsignalled zebra                              -> cross when no car is within 25 m coming at it
  //   none      no crosswalk at all                               -> nobody crosses: the path is a dead end there
  // stepWalker holds a walker at the kerb (bunched with whoever is waiting there) until its span says walk; one caught
  // out on the carriageway by the change finishes at a hurry. The crossers keep their own scramble state machine.
  buildSpans() {
    const f = this.field, spans = [];
    this.spans = spans;
    if (!f) return;
    // anyone who stands (idlers, touts) is stood on the pavement: a plaza polygon that overlaps a carriageway put one
    // 5 m into the road near 南口, where keepOffRoad and its own home fought over it all night
    for (const q of this.peds) {
      if (q.kind !== 'idler' || q.police) continue;
      let x = q.x, z = q.z;
      for (let i = 0; i < 24; i++) {
        const d = f.sample(x, z); if (d >= 0.6) break;
        const e = 0.7, gx = f.sample(x + e, z) - f.sample(x - e, z), gz = f.sample(x, z + e) - f.sample(x, z - e), g = Math.hypot(gx, gz);
        if (g < 1e-4) break;
        const st = Math.min(0.9, 0.7 - d); x += gx / g * st; z += gz / g * st;
      }
      const fo = this.frontOut(x, z, FRONT_CLEAR);                   // (and off the shop glass)
      if (fo && f.sample(fo[0], fo[1]) >= 0.4) { x = fo[0]; z = fo[1]; }
      if (x !== q.x || z !== q.z) { q.x = x; q.z = z; q.hx = x; q.hz = z; q.tx = x; q.tz = z; }
    }
    const paths = [...new Set([...this.peds.filter(q => q.path && q.path.pts).map(q => q.path), ...(this.plazaRoutes || [])])];
    const XW = [...(CITY.crossing.crosswalks || []).map(c => ({ ...c, cls: 'scramble' })), ...(CITY.crossing.diagonals || []).map(c => ({ ...c, cls: 'scramble' })),
      ...(CITY.crosswalksExtra || []).map(c => ({ ...c, cls: 'extra' }))];
    const tr = this.engine.get('traffic');
    const junctions = tr && typeof tr.junctionList === 'function' ? tr.junctionList() : [];
    const roadAt = (x, z) => {
      let best = null, bd = Infinity;
      for (const r of CITY.roads) for (let i = 0; i < r.path.length - 1; i++) {
        const [ax, az] = r.path[i], [bx, bz] = r.path[i + 1], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
        const t = clamp(((x - ax) * vx + (z - az) * vz) / l2, 0, 1), d = Math.hypot(x - ax - vx * t, z - az - vz * t) - r.width / 2;
        if (d < bd) { bd = d; best = r; }
      }
      return bd < 1.5 ? best : null;
    };
    for (const P of paths) {
      P.spans = [];
      const step = 0.4, n = Math.ceil(P.len / step);
      let run = null;
      const at = (sv) => { let i = 0; while (i < P.cum.length - 2 && P.cum[i + 1] < sv) i++; const t = (sv - P.cum[i]) / Math.max(1e-6, P.cum[i + 1] - P.cum[i]); const a = P.pts[i], b = P.pts[i + 1]; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, b[0] - a[0], b[1] - a[1]]; };
      const close = (s1) => {
        const s0 = run; run = null;
        if (s1 - s0 < 1.2) return;                                   // a kerb-edge sample, not a road
        const m = at((s0 + s1) / 2), dl = Math.hypot(m[2], m[3]) || 1, dx = m[2] / dl, dz = m[3] / dl;
        let xw = null, xd = Infinity;
        for (const c of XW) {
          const ax = c.a[0], az = c.a[1], vx = c.b[0] - ax, vz = c.b[1] - az, L = Math.hypot(vx, vz) || 1;
          const t = ((m[0] - ax) * vx + (m[1] - az) * vz) / (L * L);
          if (t < -0.2 || t > 1.2) continue;
          const lat = Math.abs((m[0] - ax) * vz - (m[1] - az) * vx) / L;
          if (lat > c.width / 2 + 3 || Math.abs(dx * vx / L + dz * vz / L) < 0.55) continue;
          if (lat < xd) { xd = lat; xw = c; }
        }
        const S = { i: spans.length, path: P, s0, s1, len: s1 - s0, x: m[0], z: m[1], dx, dz, kind: 'none', id: null, jid: null, group: null, state: 'stop', gAge: 0, q: [0, 0], wave: 0 };
        // a span that runs off the path's end is the strip's tail inside a junction box (the scramble's own arms end
        // at its centre), not a crossing to another kerb: a dead end, whatever it lies on
        if (s0 < 0.5 || s1 > P.len - 0.5) S.kind = 'end';
        else if (xw) {
          S.id = xw.id;
          // the crossing is walked on the crosswalk itself: the path's kerb points projected onto the stripes' line
          // (a pavement strip meets a junction at its own angle, and crossed 明治通り up to 3 m outside the stripes)
          {
            const ax = xw.a[0], az = xw.a[1], vx = xw.b[0] - ax, vz = xw.b[1] - az, L2 = vx * vx + vz * vz || 1;
            const pr = (q) => { const t = clamp(((q[0] - ax) * vx + (q[1] - az) * vz) / L2, 0, 1); return [ax + vx * t, az + vz * t]; };
            const P0 = at(s0), P1 = at(s1), A = pr(P0), B = pr(P1);
            S.cw = { ax: A[0], az: A[1], bx: B[0], bz: B[1], hw: Math.max(0.4, xw.width / 2 - 0.5) };
            S.cwK = clamp((s1 - s0) / Math.max(0.5, Math.hypot(B[0] - A[0], B[1] - A[1])), 0.4, 2.5);
            // the ease onto / off the stripes is as long as the kerb offset it closes (x1.5): at a walking pace the body
            // drifts sideways at under its own speed (3 m over a 6 m offset was a 4 m/s sideways slide)
            S.bl0 = clamp(Math.hypot(P0[0] - A[0], P0[1] - A[1]) * 1.5, CW_BLEND, 14); S.bl1 = clamp(Math.hypot(P1[0] - B[0], P1[1] - B[1]) * 1.5, CW_BLEND, 14);
            // an end of the stripes well inside the carriageway (they stop short of a rounded kerb corner: 宮益坂下's east
            // end is 4.6 m in, 7 m from the kerb) cannot be eased onto from the pavement without crossing the road off
            // the stripes: the walker dissolves over that step instead (GAP_FADE_S, stepWalker)
            S.gap0 = f.sample(A[0], A[1]) < -1.5; S.gap1 = f.sample(B[0], B[1]) < -1.5;
          }
          if (xw.cls === 'scramble') S.kind = 'scramble';
          else if (tr && typeof tr.crossingSignal === 'function' && tr.crossingSignal(xw.id)) S.kind = 'zebra';
          else {
            // the road it crosses, and a junction within 45 m with an arm on that road: the other group runs parallel
            const cx = (xw.a[0] + xw.b[0]) / 2, cz = (xw.a[1] + xw.b[1]) / 2, road = roadAt(cx, cz);
            let J = null, jd = 45;
            for (const j of junctions) { const d = Math.hypot(j.pos[0] - cx, j.pos[1] - cz); if (d < jd && road && Object.keys(j.groups).some(k => k.slice(0, -1) === road.id)) { jd = d; J = j; } }
            if (J) {
              const mine = new Set(Object.entries(J.groups).filter(([k]) => k.slice(0, -1) === road.id).map(([, g]) => g));
              const other = [...new Set(Object.values(J.groups))].find(g => !mine.has(g));
              if (other) { S.kind = 'junction'; S.jid = J.id; S.group = other; S.road = road.id; }
              else S.kind = 'free';
            } else S.kind = 'free';
          }
        }
        spans.push(S); P.spans.push(S);
      };
      for (let k = 0; k <= n; k++) {
        const sv = Math.min(P.len, k * step), [x, z] = at(sv);
        const road = f.sample(x, z) < 0;
        if (road && run == null) run = sv;
        else if (!road && run != null) close(sv);
      }
      if (run != null) close(P.len);
      // the path's own pavement ends: past a tail in a junction box nobody walks (a plaza route's arrivals start here)
      const e0 = P.spans.find(S => S.kind === 'end' && S.s0 < 0.5), e1 = P.spans.find(S => S.kind === 'end' && S.s1 > P.len - 0.5);
      P.lo0 = e0 ? Math.min(P.len, e0.s1 + 1.2) : -1; P.hi0 = e1 ? Math.max(0, e1.s0 - 1.2) : 1e9;
      P.sigN = P.spans.filter(S => S.cw && S.kind !== 'end' && S.kind !== 'none').length;
      for (const S of P.spans) if (S.kind === 'end' || S.kind === 'none') S.cw = null;
      // a crosswalk's ease never reaches onto the next one's stripes (placeOnPath composes neighbouring eases in order
      // along the path: within the gap they share, the earlier one has the first say; each owns its own stripes)
      const cws = P.spans.filter(S => S.cw).sort((a, b) => a.s0 - b.s0);
      for (let k = 0; k + 1 < cws.length; k++) {
        const A = cws[k], B = cws[k + 1], gap = Math.max(0.5, B.s0 - A.s1);
        A.bl1 = Math.min(A.bl1 || CW_BLEND, gap); B.bl0 = Math.min(B.bl0 || CW_BLEND, gap);
      }
      P.cwSpans = cws;
    }
    // Every walker's window is clipped short of the dead ends round it (a per-walker 0.6-3.6 m before the kerb, so
    // there is no turning line), and a share of them have it carried across the next signalled crossing beyond it
    // and 8-22 m on, so the outer crossings have people waiting at them. Anyone seeded on a span goes to its kerb.
    const rng = this.engine.rng.fork(406);
    for (let qi = 0; qi < this.peds.length; qi++) {
      const q = this.peds[qi], P = q.path;
      if (q.kind !== 'walker' || !P || !P.spans || !P.spans.length) continue;
      if (q.grp && !q.wmates && q.mate && q.mate.wmates) continue;   // company takes its leader's window (below)
      let sv = P.cum[q.seg] + q.t * (P.cum[q.seg + 1] - P.cum[q.seg]);
      for (const S of P.spans) if (sv > S.s0 - 0.4 && sv < S.s1 + 0.4) { sv = (q.dir >= 0 && S.s0 > 2) || S.s1 > P.len - 2 ? Math.max(0, S.s0 - 1.4) : Math.min(P.len, S.s1 + 1.4); this.seedOnPath(q, sv); break; }
      const j = 1.2 + 3 * hash01(q.grp ? 100000 + q.grp : qi);
      let lo = -1, hi = 1e9;
      for (const S of P.spans) {
        if (S.kind !== 'end' && S.kind !== 'none') continue;
        if (S.s1 <= sv) lo = Math.max(lo, S.s1 + j); else if (S.s0 >= sv) hi = Math.min(hi, S.s0 - j);
      }
      // carried across the nearest signalled crossing beyond either end of the window (45 % of walkers)
      const sig = P.spans.filter(S => S.kind !== 'end' && S.kind !== 'none');
      if (sig.length && rng() < 0.45) {
        const up = sig.filter(S => S.s0 >= q.sB - 2 && S.s0 - q.sB < 70 && S.s1 < hi).sort((a, b) => a.s0 - b.s0)[0];
        const dn = sig.filter(S => S.s1 <= q.sA + 2 && q.sA - S.s1 < 70 && S.s0 > lo).sort((a, b) => b.s1 - a.s1)[0];
        const S = up && dn ? (rng() < 0.5 ? up : dn) : up || dn;
        if (S === up && S) q.sB = Math.min(hi, S.s1 + rng.range(8, 22));
        else if (S) q.sA = Math.max(lo, S.s0 - rng.range(8, 22));
      }
      q.sA = Math.max(q.sA, lo); q.sB = Math.min(q.sB, hi);
      // a window never ends on a crossing (the 道玄坂 corridor's windows are placed round a spot: an end on the stripes
      // was a U-turn in the middle of the road): moved to the kerb it is nearer, a body's depth off the stripes
      for (const S of sig) {
        if (q.sB > S.s0 - 1 && q.sB < S.s1 + 1) q.sB = q.sB - S.s0 < S.s1 - q.sB ? S.s0 - j : Math.min(hi, S.s1 + j);
        if (q.sA > S.s0 - 1 && q.sA < S.s1 + 1) q.sA = S.s1 - q.sA < q.sA - S.s0 ? S.s1 + j : Math.max(lo, S.s0 - j);
      }
      if (q.sB - q.sA < 3) {
        // squeezed to nothing between two carriageways: the nearest stretch of this path's pavement at least 6 m long
        // instead (centred on the squeeze, a 3 m window lay on the road itself: a walker turning round on it for ever)
        let best = null, bd = Infinity, a0 = 0;
        const cuts = P.spans.slice().sort((a, b) => a.s0 - b.s0);
        for (let k = 0; k <= cuts.length; k++) {
          const b0 = k < cuts.length ? cuts[k].s0 : P.len;
          if (b0 - a0 >= 6) { const c = clamp(sv, a0 + 1, b0 - 1), d = Math.abs(c - sv); if (d < bd) { bd = d; best = [a0 + 1, b0 - 1]; } }
          if (k < cuts.length) a0 = Math.max(a0, cuts[k].s1);
        }
        if (best) { q.sA = best[0]; q.sB = best[1]; } else { const m = (q.sA + q.sB) / 2; q.sA = m - 1.5; q.sB = m + 1.5; }
      }
    }
    for (const q of this.peds) {
      if (q.kind !== 'walker' || !q.grp || q.wmates || !q.mate || !q.mate.wmates || !q.path || !q.path.spans) continue;
      q.sA = q.mate.sA; q.sB = q.mate.sB;
      const P = q.path, sv = P.cum[q.seg] + q.t * (P.cum[q.seg + 1] - P.cum[q.seg]);
    }
    // and everyone starts inside their own window (a companion seeded beside its leader, a walker moved off a span)
    for (const q of this.peds) {
      const P = q.path;
      if (q.kind !== 'walker' || !P || !P.spans || !P.spans.length) continue;
      const sv = P.cum[q.seg] + q.t * (P.cum[q.seg + 1] - P.cum[q.seg]), lo = Math.max(0, q.sA + 0.3), hi = Math.min(P.len, q.sB - 0.3);
      if (hi > lo && (sv < lo || sv > hi)) this.seedOnPath(q, clamp(sv, lo, hi));
    }
    const byKind = spans.reduce((a, S) => { a[S.kind] = (a[S.kind] || 0) + 1; return a; }, {});
    console.info(`[crowd] pedestrian signals: ${spans.length} carriageway spans on ${paths.length} walker paths ${JSON.stringify(byKind)}` +
      (/[?&]sigDbg=1/.test(typeof location !== 'undefined' ? location.search : '') ? ' ' + spans.map(S => `${S.path.id}@${S.s0.toFixed(0)}-${S.s1.toFixed(0)}:${S.kind}${S.id ? ':' + S.id : ''}${S.jid ? ':' + S.jid + '/' + S.group : ''}`).join(' ') : ''));
  },

  // each signalled span's pedestrian head this frame: 'walk' | 'flash' | 'stop'
  spanSignals(dt, sig) {
    const spans = this.spans;
    if (!spans || !spans.length) return;
    const tr = this.engine.get('traffic');
    for (const S of spans) {
      if (S.kind === 'end' || S.kind === 'none') continue;
      const was = S.state;
      if (S.kind === 'scramble') S.state = sig || 'walk';
      else if (S.kind === 'zebra') { const c = tr && tr.crossingSignal(S.id); S.state = c ? c.pedestrian : 'stop'; }
      else if (S.kind === 'junction') {
        const v = tr && typeof tr.junctionState === 'function' ? tr.junctionState(S.jid, S.group) : 'red';
        S.gAge = v === 'green' ? S.gAge + dt : 0;
        // the pedestrian head runs with the parallel vehicle green; it flashes for the last ~5 s of it. The green is
        // vehicle-actuated (its end is not known ahead), so the flash starts at the group's maximum less 5 s when
        // traffic.js exposes it, else after 14 s of green; an early gap-out still leaves amber 3 s + all-red 2 s.
        // A green only ends when traffic waits on the other approach (a resting green is walk for as long as it
        // rests): flash once it is past its maximum less 5 s with somebody waiting across it.
        const C = this.junctionCtrl(tr, S.jid);
        let ending;
        if (C) {
          const o = C.g === 'a' ? 'b' : 'a';
          let dem = true;
          try { dem = C.lanes && typeof tr.demand === 'function' ? !!tr.demand(C.lanes[o], 60) : true; } catch (e) { dem = true; }
          ending = C.tau > (C[C.g] || 19) - 5 && dem;
        } else ending = S.gAge > 14;
        S.state = v === 'green' ? (ending ? 'flash' : 'walk') : v === 'amber' ? 'flash' : 'stop';
      } else {
        // an unsignalled zebra: cross on a gap -- no car within 25 m coming at it (or anything standing on it)
        S.state = this.zebraClear(tr, S) ? 'walk' : 'stop';
      }
      if (S.state === 'walk' && was !== 'walk') { S.q[0] = 0; S.q[1] = 0; S.wave++; }
    }
  },

  // the controller of an outer junction, read-only (traffic.js's net node; null if its layout ever changes)
  junctionCtrl(tr, id) {
    try {
      const n = tr && tr.net && tr.net.nodes && tr.net.nodes.find(q => q.cfg && q.cfg.id === id);
      return n && n.ctrl && typeof n.ctrl.g === 'string' ? n.ctrl : null;
    } catch (e) { return null; }
  },

  zebraClear(tr, S) {
    if (!tr || !tr.cars) return true;
    const hw = S.len / 2 + 2;
    for (let i = 0; i < tr.cars.length; i++) {
      const c = tr.cars[i], dx = S.x - c.x, dz = S.z - c.z;
      if (Math.abs(dx) > 30 || Math.abs(dz) > 30) continue;
      const d = Math.hypot(dx, dz);
      // on the zebra itself (within its half-length of the centre along the path's axis and 3 m across it)
      const along = Math.abs(dx * S.dx + dz * S.dz), across = Math.abs(dx * S.dz - dz * S.dx);
      if (along < hw && across < 3.5) return false;
      if (d > 25 || c.speed < 0.5) continue;
      if ((Math.sin(c.yaw) * dx + Math.cos(c.yaw) * dz) / d > 0.35) return false;   // heading this way
    }
    return true;
  },

  // A walker and the signalled spans on its street: holds it at the kerb (bunched with whoever waits there, rows
  // back from the kerb by arrival) until its span says walk, releases the rows a beat apart, and hurries anyone the
  // change caught on the carriageway. Returns the speed multiplier for this step, or 0 to stand.
  spanStep(p, dt) {
    const P = p.path, spans = P.spans;
    p.onSpan = null;
    if (!spans || !spans.length || !p.dir) { p.waitS = null; return 1; }
    const sv = P.cum[p.seg] + p.t * (P.cum[p.seg + 1] - P.cum[p.seg]);
    let next = null, nd = Infinity;
    for (let k = 0; k < spans.length; k++) {
      const S = spans[k];
      if (S.kind === 'end' || S.kind === 'none') continue;
      // on the crossing the walker is drawn along the stripes (placeOnPath): its progress along the strip is scaled so its
      // pace ON the stripes is its own pace (a strip meeting a junction at an angle is shorter or longer than the crossing)
      if (sv > S.s0 && sv < S.s1) { p.onSpan = S; p.waitS = null; return (S.state === 'walk' ? 1 : 1.5) * (S.cwK || 1); }
      const d = p.dir > 0 ? S.s0 - sv : sv - S.s1;
      if (d >= 0 && d < nd) { nd = d; next = S; }
    }
    if (!next || nd > 5) { p.waitS = null; return 1; }
    const di = p.dir > 0 ? 0 : 1;
    // can it finish? a walk that has nearly run out is not started (the scramble tells how long is left)
    const tr = next.kind === 'scramble' ? this.engine.get('traffic') : null;
    const late = tr && tr.signal && typeof tr.signal.remaining === 'number' && next.state === 'walk' && tr.signal.remaining < next.len / Math.max(0.8, p.speed) + 2;
    if (next.state === 'walk' && !late) {
      if (p.waitS !== next) return 1;
      // released: the front row first, each row behind it a beat later (the wave steps off together, not as a file)
      if (p.relT == null) p.relT = (p.waitRow || 0) * 0.45 + 0.8 * hash01(p.index * 5 + next.wave);
      p.relT -= dt;
      if (p.relT > 0) return 0;
      p.waitS = null; p.relT = null;
      return 1;
    }
    if (p.waitS !== next) { p.waitS = next; p.relT = null; const k = next.q[di]++; const per = Math.max(1, Math.floor(P.width / 0.62)); p.waitRow = Math.floor(k / per); }
    // the spot to stand: the kerb, less a row's depth per row
    const stopD = 0.45 + (p.waitRow || 0) * 0.6;
    if (nd <= stopD + 0.02) return 0;
    return nd - stopD < 1.2 ? Math.max(0.25, (nd - stopD) / 1.2) : 1;
  },

  // a waiting spot (p.tx, p.tz) walked up the street field onto the pavement (company placed beside its leader)
  frontFn() {
    // (looked up until the city has built its fronts: a null cached at seeding left the touts on the glass for good)
    if (!this._fc) { const city = this.engine && this.engine.get('city'); this._fc = city && typeof city.frontClear === 'function' ? city.frontClear : null; }
    return this._fc;
  },
  // per path segment: does any shop front come within reach of its lanes (the walker's front pass runs only there)
  pathFronts(P) {
    const fc = this.frontFn(); if (!fc) return null;
    const pts = P.pts, w = P.width / 2 + 1.0, near = new Uint8Array(Math.max(1, pts.length - 1));
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, nx = -dz / L, nz = dx / L, n = Math.ceil(L / 1.5);
      for (let i = 0; i <= n && !near[k]; i++) for (const l of [-w, 0, w]) { const u = i / n; if (fc(a[0] + dx * u + nx * l, a[1] + dz * u + nz * l) < 2.0) { near[k] = 1; break; } }
    }
    return (P.nearFront = near);
  },

  // the clearance's gradient at (x, z) (one-sided where a sample falls off the end of a front: Infinity there)
  frontGrad(fc, x, z, c0, out) {
    const e = 0.12, a = fc(x + e, z), b = fc(x - e, z), cc = fc(x, z + e), d = fc(x, z - e);
    out[0] = isFinite(a) && isFinite(b) ? (a - b) / (2 * e) : isFinite(a) ? (a - c0) / e : isFinite(b) ? (c0 - b) / e : 0;
    out[1] = isFinite(cc) && isFinite(d) ? (cc - d) / (2 * e) : isFinite(cc) ? (cc - c0) / e : isFinite(d) ? (c0 - d) / e : 0;
    return out;
  },
  // (x, z) moved straight out from the nearest shop front until it is `need` clear of it; null when it already is
  frontOut(x, z, need) {
    const fc = this.frontFn(); if (!fc) return null;
    let c = fc(x, z);
    if (!(c < need)) return null;
    const G = this._fg || (this._fg = [0, 0]);
    for (let i = 0; i < 8 && c < need; i++) {
      this.frontGrad(fc, x, z, c, G);
      const gx = G[0], gz = G[1], g = Math.hypot(gx, gz);
      if (!(g > 1e-3)) break;
      const st = need - c + 0.02; x += gx / g * st; z += gz / g * st; c = fc(x, z);
    }
    return [x, z];
  },

  spotOnPavement(p) {
    const f = this.field;
    if (!f) return;
    let x = p.tx, z = p.tz;
    for (let i = 0; i < 14; i++) {
      const d = f.sample(x, z); if (d >= 0.6) break;
      const e = 0.7, gx = f.sample(x + e, z) - f.sample(x - e, z), gz = f.sample(x, z + e) - f.sample(x, z - e), g = Math.hypot(gx, gz);
      if (g < 1e-4) break;
      const st = Math.min(0.9, 0.7 - d); x += gx / g * st; z += gz / g * st;
    }
    const fo = this.frontOut(x, z, FRONT_CLEAR);                     // (and off the shop glass)
    if (fo && f.sample(fo[0], fo[1]) >= 0.4) { x = fo[0]; z = fo[1]; }
    p.tx = x; p.tz = z;
  },

  // A walker's lane is a lateral offset from its path's centre line, and placeOnPath re-derives its position from
  // it every step, so keepOffRoad's push was undone each frame: a wide lane at a corner or a junction mouth settled
  // in the gutter. Off a crosswalk the lane is pulled in toward the centre line (kept >= 1.15 m clear of the
  // carriageway at every vertex) until the body stands on the pavement.
  // (the widest share of the lane that does, bisected: it was cut in 40% steps, and a walker the lens or a shove
  // held against the kerb flipped between two of them every frame)
  // Then FRONT_CLEAR off a shop front's glass (FRONT_SHOP for a window shopper; one going in at a door is let through):
  // the lane moves away from the front, not toward the centre line -- 道玄坂's centre line runs through the fronts'
  // display boxes (clearance -0.2 to -0.8 m at lane 0). The pavement wins where both cannot hold.
  latOnPavement(p) {
    const f = this.field;
    if (!f || p.onSpan) return;
    const l0 = p.lat;
    if (Math.abs(l0) > 0.05 && f.sample(p.x, p.z) < 0.4) {
      let lo = 0, hi = 1;
      for (let it = 0; it < 7; it++) { const m = (lo + hi) / 2; p.lat = l0 * m; this.placeOnPath(p); if (f.sample(p.x, p.z) < 0.4) hi = m; else lo = m; }
      if (p.lat !== l0 * lo) { p.lat = l0 * lo; this.placeOnPath(p); }
    }
    const fc = p.doorT > 0 ? null : this.frontFn(), NF = fc ? p.path.nearFront || this.pathFronts(p.path) : null;
    // (checked once the walker has moved 0.3 m since it was last found clear; the lane it is moved to becomes its own)
    if (fc && NF && NF[p.seg] && Math.abs(p.x - p._fcX) + Math.abs(p.z - p._fcZ) > 0.3) {
      // (the lane may use up to 1 m past the path's own half width here, the pavement permitting: ぶんかむら通り's centre
      // line is 0.9-1.5 m inside the fronts)
      const need = p.shopT > 0 ? FRONT_SHOP : FRONT_CLEAR, lk = p.lat, half = p.path.width / 2 + 0.8, G = this._fg || (this._fg = [0, 0]);
      for (let it = 0; it < 3; it++) {
        const c = fc(p.x, p.z); if (!(c < need)) break;
        this.frontGrad(fc, p.x, p.z, c, G);
        const gn = G[0] * p.nx + G[1] * p.nz;                           // d(clearance) / d(lane)
        if (Math.abs(gn) < 0.2) break;
        p.lat = clamp(p.lat + (need + 0.1 - c) / gn, -half, half); this.placeOnPath(p);   // (+0.1: the drift between checks)
      }
      // (where the fronts leave less pavement than that, as far out as the pavement goes)
      if (p.lat !== lk && f.sample(p.x, p.z) < 0.4) {
        const l1 = p.lat; let lo = 0, hi = 1;
        for (let it = 0; it < 6; it++) { const m = (lo + hi) / 2; p.lat = lk + (l1 - lk) * m; this.placeOnPath(p); if (f.sample(p.x, p.z) < 0.4) hi = m; else lo = m; }
        p.lat = lk + (l1 - lk) * lo; this.placeOnPath(p);
      }
      if (p.lat !== lk && p.shopT <= 0) p.baseLat = p.lat;
      if (!(fc(p.x, p.z) < need)) { p._fcX = p.x; p._fcZ = p.z; }
    }
    if (MOTION_DBG && p.lat !== l0) this.mdTag(p, 'latClamp', Math.abs(p.lat - l0));
  },

  // Every correction that is not the person's own walking -- the separation, the kerb, furniture, a car, the lens bubble,
  // the player, the ring -- was applied at full strength the frame it arose: a crosser shoved 1.4 m out of a car's box,
  // a waiter shoved clear of the player at 15-37 m/s. Here, once a frame: the part of each move that was not walking is
  // held to PUSH_V (a quick step aside), the whole to VCAP unless running; a push harder than a shuffle is a step (the
  // gait counts it, a standing person turns into it). What was walked plus those steps is the distance the gait
  // advances by this frame (p._wd, read by crowdScan.animate) -- never the push jitter a standing crowd trades.
  settle(dt) {
    const peds = this.peds, N = this.count, X0 = this._x0, Z0 = this._z0, DT0 = this._dt0, Y0 = this._y0;
    if (!X0) return;
    const f = this.frame;
    for (let i = 0; i < N; i++) {
      const p = peds[i];
      if (p._wdF !== f) { p._wd = 0; p._wdF = f; }
      if (p._reloc) { p._reloc = 0; p._wd = 0; p._latP = null; p._runOK = false; p._hvx = p._hvz = p._ex = p._ez = p._exU = p._ezU = p._hy = p._ey = p._eyU = p._pX = p._pZ = 0; p._dX = p.x; p._dZ = p.z; p._dOK = 1; continue; }   // moved while hidden
      let lx = p._lx, lz = p._lz;
      // not stepped this frame and nothing else moved them (a skipped tick, carried on or standing): only the gait
      if (!DT0[i] && !p._pX && !p._pZ && p.x === X0[i] + lx && p.z === Z0[i] + lz) {
        p._wd += Math.hypot(lx, lz); p._runOK = false; p._dX = p.x; p._dZ = p.z; p._dOK = 1; p._snap = 0;
        continue;
      }
      const sdt = DT0[i] || dt;
      // (the time since the body was last drawn: a half-rate tick's carried frame already showed one of its two)
      const fdt = Math.max(1e-4, sdt - (p._ctU || 0));
      let px = p.x - X0[i] - lx, pz = p.z - Z0[i] - lz;
      // (a move from outside the crowd, held back at the top of step(): taken as a push, the rest carried over)
      const qx = p._pX || 0, qz = p._pZ || 0;
      if (qx || qz) { px += qx; pz += qz; }
      const px1 = px, pz1 = pz;
      let pm = Math.hypot(px, pz);
      const cap = PUSH_V * sdt;
      if (pm > cap) { const k = cap / pm; px *= k; pz *= k; pm = cap; }
      if (!p._runOK) {
        const vc = VCAP * fdt;
        if (pm > 0 && Math.hypot(lx + px, lz + pz) > vc) {
          let lo = 0, hi = 1;
          for (let it = 0; it < 8; it++) { const k = (lo + hi) / 2; if (Math.hypot(lx + px * k, lz + pz * k) > vc) hi = k; else lo = k; }
          px *= lo; pz *= lo; pm *= lo;
        }
        // and the walking itself, drawn: a half-rate tick at a waypoint corner is the carried frame's old heading
        // against two frames of the new one (a crosser drawn at 3.3-4.7 m/s for a frame)
        const tm = Math.hypot(lx + px, lz + pz);
        if (tm > vc && p.dfade >= 0.05 && !p._snap) { const k = vc / tm; lx *= k; lz *= k; px *= k; pz *= k; pm *= k; if (MOTION_DBG) this.mdTag(p, 'vcap', tm - vc); }
      }
      // a shove from outside (a stage being cleared: radially, blind to the kerb) never walks someone off the pavement
      if ((qx || qz) && this.field && !(p.kind === 'crosser' && p.state === 'cross') && this.field.sample(X0[i] + lx + px, Z0[i] + lz + pz) < 0.35 && this.field.sample(X0[i], Z0[i]) >= 0.35) {
        px = pz = pm = 0; p._pX = p._pZ = 0;
      }
      p.x = X0[i] + lx + px; p.z = Z0[i] + lz + pz;
      if ((qx || qz) && (p._pX || p._pZ)) {
        const rx = px1 - px, rz = pz1 - pz, rm = Math.hypot(rx, rz), k = rm > 1e-3 ? Math.min(1, 3 / rm) * Math.max(0, 1 - sdt * 0.5) : 0;
        p._pX = rx * k; p._pZ = rz * k;
      }
      // someone walking steps over the ground they actually cover (a crowd holding them back shortens the stride, it
      // does not leave the legs cycling in place); someone standing only steps for a push harder than a shuffle
      let wx = lx, wz = lz;
      if (p.moving || pm > STEP_V * sdt) { wx += px; wz += pz; }
      if (!p.moving && !p.gawk && pm > 0.6 * sdt) turnTo(p, Math.atan2(px, pz), sdt, 3);
      p._wd += Math.hypot(wx, wz);
      p._runOK = false;
      // the heading: the walk, the dodge, the lens and a shove can each turn someone in the same frame; together at
      // most YAW_MAX (a U-turn is 4.7 rad/s at its fastest)
      if (Y0) { const dy = wrapPi(p.yaw - Y0[i]), m = YAW_MAX * fdt; if (dy > m || dy < -m) p.yaw = Y0[i] + (dy > 0 ? m : -m); }
      // every tick's velocity (from where the sim stood, not the carried-on frame), for a frame between two half-rate
      // ticks -- kept at full rate too, or the first skipped frame after dropping to half rate stood still
      if (DT0[i]) {
        const vx = (p.x - X0[i] + (p._exU || 0)) / sdt, vz = (p.z - Z0[i] + (p._ezU || 0)) / sdt, vm = Math.hypot(vx, vz), k = vm > VCAP ? VCAP / vm : 1;
        p._hvx = vx * k; p._hvz = vz * k;
        p._hy = Y0 ? clamp(wrapPi(p.yaw - Y0[i] + (p._eyU || 0)) / sdt, -YAW_MAX, YAW_MAX) : 0;
        p._exU = p._ezU = p._eyU = p._ctU = 0;
      }
      p._dX = p.x; p._dZ = p.z; p._dOK = 1; p._snap = 0;   // where the crowd drew them (external moves: top of step())
    }
  },

  // Someone else moved a pedestrian since the crowd drew it: run at the top of step() and again from the scanned
  // crowd's render hook (missions updates after the crowd, so its moves would be drawn -- and read -- before step()
  // saw them).
  guardExternal() {
    // Someone else moved a pedestrian since the crowd drew it (missions.clearStage pushes the stage ring at up to
    // 3.4 m/s and clears it outright on its first frame; combat.clearLens steps people out of a still's lens): a
    // path walker is held to its path (stageBlock keeps walkers off a stage; the push was undone a frame later
    // anyway, a blip), anyone else takes it as a push through settle -- a step aside at PUSH_V -- unless the camera
    // has just cut, which hides a placement.
    {
      const peds = this.peds, N = this.count, MD = MOTION_DBG;
      // (a cut is the frame the lens visibly jumped -- crowdScan's render hook measures it and sets cutF; the
      // camera:cut event also fires for mode changes that do not jump, and a placement then was drawn as a teleport)
      const cutRecent = this.cutF === this.frame;
      for (let i = 0; i < N; i++) {
        const p = peds[i];
        if (!p._dOK) continue;
        const ex = p.x - p._dX, ez = p.z - p._dZ;
        if (ex * ex + ez * ez < 1e-8) continue;
        if (MD) this.mdTag(p, 'external', Math.hypot(ex, ez));
        if (p.stage) { p._reloc = 1; p._dX = p.x; p._dZ = p.z; continue; }  // (a preset's staging places its cast)
        // (never off the pavement into the carriageway, seen or not: the stage clear places and shoves people radially,
        // blind to the kerb -- a dissolved crosser was shoved into the road and faded back in there)
        const offKerb = this.field && !(p.kind === 'crosser' && p.state === 'cross') && this.field.sample(p.x, p.z) < 0.35 && this.field.sample(p._dX, p._dZ) >= 0.35;
        // (someone dissolved -- behind a talk stage -- is already out of the shot: the shove is dropped and they walk on through
        // unseen; taken, it held a crosser treading water on the scramble for 13 s until the red man)
        if (p.dfade < 0.05 && p.fade < 0.05) { p.x = p._dX; p.z = p._dZ; continue; }
        // a path walker stays where it was drawn, cut or not: its path is where it is (a stage-clearing teleport at a
        // cut left walkers inside the stage 4-7 m off their path, and they walked back to it on screen)
        if (p.kind === 'walker' && !p.gawk) { p.x = p._dX; p.z = p._dZ; continue; }
        // (at a cut the placement stands)
        if (cutRecent && !offKerb) { p._reloc = 1; p._dX = p.x; p._dZ = p.z; continue; }
        p.x = p._dX; p.z = p._dZ;
        if (offKerb) continue;
        p._pX += ex; p._pZ += ez;
      }
    }
  },

  // a frame a reduced tick rate skips: the body carries on at its last tick's velocity and turn rate (taken back
  // before its next tick steps it), so it moves and turns every frame on screen
  carry(p, dt) {
    p._ctD += dt;                                // (time the body was drawn carried on: settle / stepWalker limits)
    if (p._hvx || p._hvz) { const ex = p._hvx * dt, ez = p._hvz * dt; p.x += ex; p.z += ez; p._ex = (p._ex || 0) + ex; p._ez = (p._ez || 0) + ez; p._lx += ex; p._lz += ez; }
    if (p._hy) { const ey = p._hy * dt; p.yaw += ey; p._ey = (p._ey || 0) + ey; }
  },

  // motion instrumentation (?motionDbg=1): the metres a code path moved p by this frame, or an event count
  mdTag(p, tag, d) { if (!(d > 1e-6)) return; const m = p._md || (p._md = {}); m[tag] = (m[tag] || 0) + d; },
  mdSnap() { const N = this.count, X = this._mdX || (this._mdX = new Float32Array(N)), Z = this._mdZ || (this._mdZ = new Float32Array(N)), L = this._mdL || (this._mdL = new Float32Array(N)); for (let i = 0; i < N; i++) { const p = this.peds[i]; X[i] = p.x; Z[i] = p.z; L[i] = p.lat || 0; } },
  mdDiff(tag) { const N = this.count, X = this._mdX, Z = this._mdZ, L = this._mdL; for (let i = 0; i < N; i++) { const p = this.peds[i]; this.mdTag(p, tag, Math.hypot(p.x - X[i], p.z - Z[i])); if (p.kind === 'walker' && p.lat != null) this.mdTag(p, 'lat:' + tag, Math.abs(p.lat - L[i])); } },

  // the legacy renderer's meshes (parts rig, far bodies, mirror, decals, props) on / off
  legacyVisible(on) {
    for (const m of [...this.meshes, this.farRefl]) m.visible = on;
  },

  // no scan could be baked (or it timed out): the legacy crowd draws, keyed to its own pool templates again
  scanFailed(e) {
    console.warn('[crowd] scanned crowd unavailable, legacy crowd drawn: ' + (e && e.message ? e.message : e));
    const R = this.scanR;
    this.scanR = null; this.swapD = SWAP_D;
    if (R) { R.ready = false; if (R.root) R.root.visible = false; }
    for (const H of this.heroes) { if (H.ped) H.ped.hero = null; H.ped = null; if (H.h) H.h.group.visible = false; }
    this.heroes = this.heroes.filter((H) => !H.sc);
    for (const q of this.peds) q.pk = poolKey(q);
    this.legacyVisible(true);
    this.resort();
  },

  // corner graph: every perimeter crosswalk / diagonal becomes a link between two named crossing corners
  buildLinks() {
    const corners = Object.values(CITY.crossing.corners);
    this.corners = corners;
    this.center = CITY.crossing.center;
    const nearest = (x, z) => {
      let b = 0, bd = Infinity;
      for (let i = 0; i < corners.length; i++) { const d = (corners[i][0] - x) ** 2 + (corners[i][1] - z) ** 2; if (d < bd) { bd = d; b = i; } }
      return b;
    };
    this.links = []; this.linksOf = corners.map(() => []);
    for (const c of crosswalkPaths()) {
      if (c.kind === 'midblock') continue;
      const ca = nearest(c.a.x, c.a.z), cb = nearest(c.b.x, c.b.z);
      if (ca === cb) continue;
      const li = this.links.length;
      // the diagonals are what makes it the scramble: Hachiko <-> Center-gai and MAGNET <-> the station-front
      // corner carry about three times a perimeter crosswalk, and they meet in a knot in the middle
      this.links.push({ ca, cb, ax: c.a.x, az: c.a.z, bx: c.b.x, bz: c.b.z, w: c.width, wt: c.kind === 'diagonal' ? 3 : 1 });
      this.linksOf[ca].push(li); this.linksOf[cb].push(li);
    }
  },

  seedCrossers(rng) {
    const nc = this.corners.length;
    // Round-robin over every corner spread 950 crossers evenly regardless of how much crossing each corner
    // actually feeds, which left the near half of the scramble -- the half the camera stands in -- bare.
    // Weight by the number of crosswalks leaving the corner and by how close the corner is to the centre.
    const cw = new Float64Array(nc);
    let tw = 0;
    const hachiko = CITY.crossing.corners.hachiko;
    for (let c = 0; c < nc; c++) {
      if (!this.linksOf[c].length) continue;
      const d = Math.hypot(this.corners[c][0] - this.center[0], this.corners[c][1] - this.center[1]);
      let lw = 0;
      for (const li of this.linksOf[c]) lw += this.links[li].wt;
      // the station exit is the biggest single source of people on the crossing
      const hk = hachiko && this.corners[c] === hachiko ? 1.4 : 1;
      cw[c] = lw * hk * (1 / (1 + 0.035 * d));
      tw += cw[c];
    }
    for (let c = 1; c < nc; c++) cw[c] += cw[c - 1];
    let made = 0;
    this.grpSeq = this.grpSeq || 0;
    while (made < N_CROSSERS) {
      const r = rng() * tw;
      let c = 0;
      while (c < nc - 1 && cw[c] < r) c++;
      if (!this.linksOf[c].length) continue;
      const p = this.makePed(rng, 'crosser');
      p.corner = c; p.state = 'wait';
      // one in forty walks a ママチャリ over rather than riding it through the crowd
      if (rng() < 0.025) { p.bike = 1; p.bikeCol = rng.pick(BIKECOL); p.bagKind = 0; p.phone = false; p.umb = false; p.speed *= 0.9; p.farVar &= ~9; }
      this.waitSpot(p, c, rng);
      p.x = p.tx; p.z = p.tz;
      const dx = this.center[0] - p.x, dz = this.center[1] - p.z;
      p.yaw = Math.atan2(dx, dz) + rng.range(-0.44, 0.44);
      p.faceYaw = p.yaw;
      p.delay = this.kerbDelay(p, rng);
      this.peds.push(p); made++;
      // Company: about a third of the people on the crossing are pairs, couples and friends of three or four.
      // They wait side by side, step off together, walk abreast on one crosswalk at the leader's pace and talk.
      if (!p.bike && rng() < 0.18 && made < N_CROSSERS) {
        const k = rng() < 0.6 ? 1 : rng() < 0.7 ? 2 : 3;
        const g = ++this.grpSeq, a = Math.atan2(dx, dz), qx = Math.cos(a), qz = -Math.sin(a);
        p.grp = g; p.talk = 1; p.members = [];
        if (p.speed < 1.0 || p.speed > 1.7) p.speed = rng.range(1.05, 1.4);   // friends walk at an easy pace
        for (let j = 0; j < k && made < N_CROSSERS; j++) {
          // a family: now and then the first companion is a child, always in step beside the adult
          const q = this.makePed(rng, 'crosser', null, null, j === 0 && rng() < 0.2);
          const off = (j & 1 ? -1 : 1) * 0.70 * Math.ceil((j + 1) / 2);
          q.corner = c; q.state = 'wait'; q.grp = g; q.talk = 1; q.leader = p; q.slot = off;
          q.speed = p.speed; q.x = q.tx = p.x + qx * off; q.z = q.tz = p.z + qz * off; q.kerbD = p.kerbD;
          q.yaw = a + rng.range(-0.3, 0.3); q.faceYaw = q.yaw; q.delay = p.delay; q.mate = p;
          q.umb = q.umb && p.umb;
          this.decorrelate(q, [p, ...p.members], rng);
          p.members.push(q);
          this.peds.push(q); made++;
        }
        p.mate = p.members[0];
      }
    }
    this.nCrossers = made;
  },

  seedWalkers(rng, city) {
    // the feeder pavements must read at least as dense as the road, so the perimeter arms are weighted up too
    // Share of the walker population each street gets. Centre-gai was 74 — ten times Dogenzaka — which piled
    // most of the crowd into one 10 m alley and made it impassable. It is still the busiest street here, by
    // about 3x, which is what the real one feels like on an ordinary night.
    const DENSE = {
      centergai: 20, basketball: 11, spainzaka: 7, nonbei_w: 3, nonbei_e: 3, koen_promenade: 4, miyashita_walk: 3,
      dogenzaka: 6, bunkamura: 4.5, ekimae_s: 7, meiji_ne: 4, koen: 4.5, inokashira: 4, miyamasu: 4,
    };
    // Walk every path point up the carriageway field until it stands clear of the kerb. Doing it ONCE here
    // beats nudging people every frame: a walker whose lane crosses the kerb line is in a tug of war with
    // its own path, and the equilibrium it settles at is 17 cm inside the roadway — against the flank of
    // whatever is queued at the lights. Clear the lane and the pedestrians simply never go there.
    const clearOfRoad = (pts) => {
      const f = this.field; if (!f) return pts;
      return pts.map(([x, z]) => {
        for (let i = 0; i < 12; i++) {
          const d = f.sample(x, z);
          if (d >= 1.15) break;                       // a body's width clear of the carriageway edge
          const e = 0.7;
          const gx = f.sample(x + e, z) - f.sample(x - e, z);
          const gz = f.sample(x, z + e) - f.sample(x, z - e);
          const g = Math.hypot(gx, gz);
          if (g < 1e-4) break;
          const step = Math.min(0.9, (1.15 - d) + 0.1);
          x += (gx / g) * step; z += (gz / g) * step;
        }
        return [x, z];
      });
    };
    // Plan A: the city past ~110 m of the crossing is silhouette country. Each pavement's walkers are windowed
    // onto the stretch of it inside NEAR (they turn round at the window's far end, which is jittered per walker so
    // there is no turning line) instead of being smeared along 400 m of 明治通り nobody will ever frame.
    const NEAR = 110, cx0 = this.center[0], cz0 = this.center[1];
    const seen = new Set(), paths = [];
    for (const cp of city.crowdPaths || []) {
      if (!cp.points || cp.points.length < 2) continue;
      const raw = cp.points.map(q => (q.isVector3 ? [q.x, q.z] : [q[0], q[1]]));
      // the city emits one Center-gai lane per side over the identical polyline: three copies of one street,
      // which is how 255 of 480 walkers ended up in it
      const key = raw.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(';');
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = clearOfRoad(raw);
      const cum = [0];
      for (let i = 0; i < pts.length - 1; i++) cum.push(cum[i] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
      const len = cum[cum.length - 1];
      if (len <= 4) continue;
      let sa = Infinity, sb = -Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        const l = cum[i + 1] - cum[i], m = Math.max(1, Math.ceil(l));
        for (let k = 0; k <= m; k++) {
          const u = k / m, x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u;
          if (Math.hypot(x - cx0, z - cz0) < NEAR) { const sv = cum[i] + u * l; if (sv < sa) sa = sv; if (sv > sb) sb = sv; }
        }
      }
      const pid = cp.roadId || cp.id || '';
      if (SLOPE_WIN[pid] && !(sb - sa > 20)) {
        // the end nearer the 109 apex is s = 0 on some polylines and s = len on others
        const d0 = Math.hypot(pts[0][0] + 112, pts[0][1] + 3), d1 = Math.hypot(pts[pts.length - 1][0] + 112, pts[pts.length - 1][1] + 3);
        if (d0 <= d1) { sa = 0; sb = Math.min(len, SLOPE_WIN[pid]); } else { sa = Math.max(0, len - SLOPE_WIN[pid]); sb = len; }
      }
      paths.push({ pts, cum, len, width: cp.width, id: pid, sa, sb, nearLen: sb > sa ? sb - sa : 0 });
    }
    this.slopePaths = paths.filter(P => SLOPE_WIN[P.id]);
    // walkers per metre of near pavement (both directions): Center-gai is the busiest street, the four arms that
    // feed the crossing next; a path that never comes near gets a token share of its length
    // (fix round 1: Center-gai's main lane 0.9 -> 0.68, a quarter thinner -- the mouth has 110 of its own now and the
    // main lane's people were the wall of heads at the bend 40 m in)
    const DENS = { centergai: 0.68, dogenzaka_shita: 0.55, ekimae_s: 0.55, koen: 0.5, miyamasu: 0.5, koen_promenade: 0.5, dogenzaka: 0.62, bunkamura: 0.48 };
    const raw = paths.map(P => (P.nearLen > 6 ? P.nearLen * (DENS[P.id] || 0.35) : P.len * 0.012));
    const rawT = raw.reduce((q, v) => q + v, 0) || 1;
    const nMain = Math.max(0, N_WALKERS - N_MOUTH);
    let n = 0;
    const place = (path, want, win, opts, cap) => {
      const half = path.width / 2 - 0.2;
      const zone = opts.zone || (YOUTH_PATHS.has(path.id) ? 'youth' : 'station');
      for (let k = 0; k < want && n < cap; k++, n++) {
        const p = this.makePed(rng, 'walker', null, zone);
        p.path = path; p.dir = rng() < 0.5 ? 1 : -1;
        const [sA, sB] = win();
        p.sA = sA; p.sB = sB;
        // Keep-left is a bias, not a partition: a dir*0.24w band plus a +/-0.26w spread pinned both streams to
        // the kerbs and left Center-gai's own centre an empty puddle. A triangular distribution over the FULL
        // half-width fills the middle of the street and still shears the two directions apart.
        p.baseLat = clamp(((rng() + rng() - 1) * (1 - Math.abs(opts.bias || 0)) + (opts.bias || 0)) * half + p.dir * 0.11 * path.width, -half, half);
        p.lat = p.baseLat;
        p.shopper = rng() < opts.shop; p.doorUser = rng() < opts.door;
        p.shopT = 0; p.shopCool = rng.range(0, 14); p.doorT = 0; p.doorPh = 0; p.dfade = 1;
        // how far off the frontage this one stops to look (fix round 1: every shopper at one distance from the
        // shelves was a file of mannequins along the bookstore)
        p.shopIn = rng.range(0, 1.0);
        const s0 = Math.max(0, sA) + rng() * (Math.min(path.len, sB) - Math.max(0, sA));
        this.seedOnPath(p, s0);
        p.state = 'walk'; p.moving = true;
        // a shopper already at a window when the frame opens, so the frontages are never empty on frame one
        if (p.shopper && rng() < opts.atShop) { const side = rng() < (opts.shopR || 0.5) ? 1 : -1; p.shopT = rng.range(2, 16); p.shopLat = side * (half - 0.1 - p.shopIn); p.lat = p.shopLat; p.shopYaw = Math.atan2(p.nx * side, p.nz * side); this.placeOnPath(p); p.yaw = p.shopYaw; }
        this.peds.push(p);
        // companions: a street of strangers all at 1.6 m spacing is a conveyor. A third of walkers travel in
        // pairs or threes abreast at the leader's pace, turning to each other as they talk. Company does not use
        // doors (that splits a pair up); a third of them do stop at windows, and then they stop together (stepWalker:
        // the mate turns to the leader, or the two turn to each other -- a browsing crowd is pairs, not a queue).
        if (rng() < 0.32) {
          const mates = rng() < 0.25 ? 2 : 1, g = ++this.grpSeq;
          p.grp = g; p.talk = 1; p.shopper = p.shopper && rng() < 0.35; p.doorUser = false; p.wmates = [];
          if (p.speed < 1.0 || p.speed > 1.7) p.speed = rng.range(1.05, 1.4);
          for (let j = 0; j < mates && n + 1 < cap; j++) {
            n++;
            const q = this.makePed(rng, 'walker', null, zone, j === 0 && rng() < 0.16);
            q.path = path; q.dir = p.dir; q.speed = p.speed;
            q.sA = p.sA; q.sB = p.sB;
            q.baseLat = clamp(p.baseLat + (j ? -1 : 1) * rng.range(0.66, 0.76), -half, half);
            q.lat = q.baseLat;
            q.shopper = false; q.doorUser = false; q.shopT = 0; q.doorT = 0; q.doorPh = 0; q.dfade = 1; q.shopIn = p.shopIn;
            q.grp = g; q.talk = 1; q.mate = p; if (!p.mate) p.mate = q;
            p.wmates.push(q);
            this.decorrelate(q, j ? [p, p.mate] : [p], rng);
            this.seedOnPath(q, s0 + rng.range(-0.25, 0.25));
            q.state = 'walk'; q.moving = true;
            this.peds.push(q);
          }
          if (p.shopT > 0) this.shopTogether(p, rng);
        }
      }
    };
    for (let i = 0; i < paths.length; i++) {
      const P = paths[i];
      // /1.4: a third of leaders bring one or two companions
      const windowed = P.nearLen > 6;
      const win = windowed
        ? () => [P.sa > 1 ? P.sa - rng.range(0, 15) : -1, P.sb < P.len - 1 ? P.sb + rng.range(0, 20) : 1e9]
        : () => [-1, 1e9];
      const n0 = n;
      place(P, Math.max(1, Math.round(nMain * raw[i] / rawT / 1.4)), win, { shop: 0.34, door: 0.05, atShop: 0.3 }, nMain);
      (this.pathStats || (this.pathStats = [])).push([P.id, Math.round(P.len), Math.round(P.nearLen), n - n0, P.pts[0].map(Math.round).join(','), P.pts[P.pts.length - 1].map(Math.round).join(',')]);
    }
    // The lens down Center-gai (?shot=centergai) reads its first ~50 m: the mouth between the 三千里 corner and
    // Q-FRONT's STARBEANS frontage, up to where the street bends west behind the corner building. Round 4 had 43
    // walkers within 40 m of it but 35 of them round that bend, behind the building. These live in the mouth only,
    // across its full 12 m (not the 8.5 m lane), with more of them stopping at the shop windows and doors.
    const cg = paths.find(P => P.id === 'centergai');
    if (cg && N_MOUTH > 0) {
      const mouth = { ...cg, width: 12.5 };
      // biased to the Q-FRONT side: the lens reads the east half of the mouth, the west half is behind the
      // vending machines and the 三千里 corner building from where it stands
      // the lens stands at s ~25 (8 m off its axis) looking up the street: s 26-52 is its first 25 m
      place(mouth, N_MOUTH, () => [rng.range(18, 28), rng.range(46, 56)], { shop: 0.46, door: 0.10, atShop: 0.45, bias: 0.38, shopR: 0.8, zone: 'youth' }, N_WALKERS);
      this.mouthPath = mouth;
    }
    // [city] pass 15: the corridor's walkers, each windowed ±30–55 m round a spot on its pavement past the first window
    // (道玄坂's lower 115 m keeps SLOPE_WIN's walkers); they obey the corridor's signals like everyone else (buildSpans)
    const corr = paths.filter(P => P.id === 'dogenzaka' || P.id === 'dogenzaka_ue');
    if (corr.length && N_CORRIDOR > 0) {
      const span = (P) => {
        if (P.id !== 'dogenzaka') return [0, P.len];
        const d0 = Math.hypot(P.pts[0][0] + 112, P.pts[0][1] + 3), d1 = Math.hypot(P.pts[P.pts.length - 1][0] + 112, P.pts[P.pts.length - 1][1] + 3);
        return d0 <= d1 ? [SLOPE_WIN.dogenzaka, P.len] : [0, P.len - SLOPE_WIN.dogenzaka];
      };
      const tot = corr.reduce((a, P) => { const [s0, s1] = span(P); return a + Math.max(0, s1 - s0); }, 0) || 1;
      for (const P of corr) {
        const [s0, s1] = span(P); if (s1 - s0 < 20) continue;
        const want = Math.round(N_CORRIDOR * (s1 - s0) / tot / 1.3);
        place(P, want, () => { const c = rng.range(s0, s1), h = rng.range(30, 55); return [Math.max(s0 - 10, c - h), Math.min(s1 + 10, c + h)]; }, { shop: 0.3, door: 0.05, atShop: 0.3, zone: 'station' }, n + want * 2);
      }
      // and two on each zebra across 道玄坂 (cityData xw_* walks, pavement to pavement): they wait for its green
      for (const P of paths) if (P.id.startsWith('xw_')) place(P, _PEDS < 0.7 ? 1 : 2, () => [-1, 1e9], { shop: 0, door: 0, atShop: 0, zone: 'station' }, n + 4);
    }
    this.nWalkers = n;
  },

  // The Hachiko square is a through-route, not a waiting room: people pour out of the Hachiko exit to the three
  // crosswalk mouths at the Hachiko corner and to 宮益坂, and come back the other way from the crossing; others cut
  // across from 宮益坂 to the bus stops at the south end. Each route starts at the crossing side (s = 0: a walker
  // arriving there joins the kerb crowd and crosses with the next wave) and ends at a portal (the ticket gates, the
  // south end, under the tracks), where it fades out and comes back later as somebody walking the other way.
  // Crossers who land at the Hachiko corner carry on along these routes instead of turning round at the kerb.
  seedPlaza(rng, city) {
    const hk = CITY.crossing.corners.hachiko, plaza = (city.plazas || []).find(q => q.id === 'hachiko');
    if (!hk || !plaza) return;
    this.hkCorner = this.corners.indexOf(hk);
    const R = [
      // weighted toward the station-frontage half of the square (the gate side a lens in the square frames):
      // the south crosswalk and the 宮益坂 route run along the edges nobody looks down
      { w: 3.4, pts: [[14.5, 16.5], [24, 18.6], [33, 20.6], [40.2, 22.2]] },                 // corner -> Hachiko exit gates
      { w: 2.8, pts: [[19.5, 13.8], [29, 15.8], [36, 18.5], [40.4, 21.2]] },                 // east crosswalk -> gates
      { w: 1.2, pts: [[11.5, 18.5], [11.8, 30], [12.6, 42], [13.4, 55]] },                   // south crosswalk -> south end
      { w: 1.0, pts: [[20, 13.2], [31, 12.9], [42, 12.6], [58, 12.2]] },                     // east crosswalk -> 宮益坂 (under the tracks)
      { w: 2.8, pts: [[15.5, 17.5], [22, 30], [28, 39.5], [33.5, 55]] },                     // corner -> across the square to the south-east
      { w: 1.6, pts: [[16, 16.5], [23, 26], [20, 40], [17.5, 55]] },                         // corner -> round the statue -> south
    ];
    const w = this.engine.world, V = new THREE.Vector3();
    // pull a route point clear of the square's furniture (planters, benches, the smoking area, bike racks)
    const clear = (x, z) => {
      if (!w || !w.overlapSphere) return [x, z];
      for (let k = 0; k < 10; k++) {
        const h = w.overlapSphere(V.set(x, 1, z), 1.0);
        const hit = h && h.find(q => q && q.tag !== 'building' && q.tag !== 'static');
        if (!hit) break;
        const px = hit.point ? hit.point.x : hit.x, pz = hit.point ? hit.point.z : hit.z;
        if (px == null) break;
        const dx = x - px, dz = z - pz, l = Math.hypot(dx, dz) || 1;
        x += dx / l * 0.5; z += dz / l * 0.5;
      }
      return [x, z];
    };
    this.plazaRoutes = R.map((r, i) => {
      const pts = r.pts.map(([x, z]) => clear(x, z)), cum = [0];
      for (let j = 0; j < pts.length - 1; j++) cum.push(cum[j] + Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1]));
      return { pts, cum, len: cum[cum.length - 1], width: 4.2, id: 'plaza', plaza: true, wt: r.w, idx: i };
    });
    const tw = this.plazaRoutes.reduce((a, P) => a + P.wt, 0);
    this.pickRoute = (rg) => { let r = rg() * tw; for (const P of this.plazaRoutes) { r -= P.wt; if (r <= 0) return P; } return this.plazaRoutes[0]; };
    let n = 0;
    while (n < N_PLAZA) {
      const P = this.pickRoute(rng);
      const p = this.makePed(rng, 'walker', null, 'youth');
      this.toPlaza(p, P, rng, rng.range(0, P.len), rng() < 0.5 ? 1 : -1);
      this.peds.push(p); n++;
      if (rng() < 0.3 && n < N_PLAZA) {
        const q = this.makePed(rng, 'walker', null, 'youth');
        q.speed = p.speed;
        this.toPlaza(q, P, rng, clamp(p.sv0 + rng.range(-0.4, 0.4), 0, P.len), p.dir, p.baseLat + (p.baseLat > 0 ? -0.72 : 0.72));
        p.grp = q.grp = ++this.grpSeq; p.talk = q.talk = 1; p.mate = q; q.mate = p;
        this.decorrelate(q, [p], rng);
        this.peds.push(q); n++;
      }
    }
    this.nWalkers += n;
  },

  // where a square route's centre line first stands on the pavement (its kerb end is up to ~0.6 m into the road)
  kerbS(P) {
    if (P.kerbS != null) return P.kerbS;
    P.kerbS = 0;
    if (this.field) for (let q = 0; q <= 4; q += 0.1) {
      let k = 0; while (k < P.pts.length - 2 && P.cum[k + 1] < q) k++;
      const A = P.pts[k], B = P.pts[k + 1], u = clamp((q - P.cum[k]) / Math.max(1e-3, P.cum[k + 1] - P.cum[k]), 0, 1);
      if (this.field.sample(A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u) >= 0.4) { P.kerbS = q; break; }
    }
    return P.kerbS;
  },

  // a pedestrian becomes a walker on one of the square's routes at arc position s0, heading dir
  toPlaza(p, P, rng, s0, dir, lat) {
    const half = P.width / 2 - 0.3;
    p.kind = 'walker'; p.state = 'walk'; p.link = -1; p.path = P; p.dir = dir; p.sA = P.lo0 != null ? P.lo0 : -1; p.sB = P.hi0 != null ? P.hi0 : 1e9;
    p.baseLat = lat != null ? clamp(lat, -half, half) : clamp((rng() + rng() - 1) * half + dir * 0.35, -half, half);
    p.lat = p.baseLat; p.latPrev = p.lat;
    p.shopper = false; p.doorUser = false; p.shopT = 0; p.doorT = 0; p.turn = 0; p.speedK = 1; p.hideT = 0;
    p.chat = 0; p.faceYaw = null; p.sv0 = s0;
    if (P.plaza) s0 = Math.max(s0, this.kerbS(P));                     // (from the kerb, not the road side of it)
    this.seedOnPath(p, s0);
    p.dfade = clamp(Math.min(P.len - s0) / 1.6, 0, 1);
    p.moving = true;
  },

  // a square walker reaching the crossing side joins the Hachiko kerb crowd for the next green man
  toKerb(p, rng) {
    const c = this.hkCorner;
    p.kind = 'crosser'; p.state = 'wait'; p.corner = c; p.wp = p.wp || new Float32Array(6); p.wpn = 0; p.wpi = 0;
    p.wave = -1; p.link = -1; p.dfade = 1; p.hurry = 1;
    this.waitSpot(p, c, rng); p.toSpot = true;
    // company waits together at the kerb: a member takes the spot beside its leader, and a leader coming up calls
    // the members already there in beside it (a child is never left standing on its own)
    const beside = (q, L) => {
      const a = Math.atan2(this.center[0] - L.tx, this.center[1] - L.tz), off = q.slot || 0.7;
      q.tx = L.tx + Math.cos(a) * off; q.tz = L.tz - Math.sin(a) * off; q.toSpot = true;
      this.spotOnPavement(q);
    };
    const Ld = p.leader;
    if (Ld && Ld.kind === 'crosser' && Ld.corner === c && Ld.state === 'wait') beside(p, Ld);
    if (p.members) for (const q of p.members) if (q.kind === 'crosser' && q.corner === c && q.state === 'wait') beside(q, p);
    p.delay = this.kerbDelay(p, rng) * 0.4; p.late = rng() < 0.35;
    p.faceYaw = Math.atan2(this.center[0] - p.tx, this.center[1] - p.tz) + rng.range(-0.4, 0.4);
  },

  seedOnPath(p, s) {
    const { cum, pts } = p.path;
    let seg = 0;
    while (seg < pts.length - 2 && cum[seg + 1] < s) seg++;
    const l = cum[seg + 1] - cum[seg] || 1;
    p.seg = seg; p.t = clamp((s - cum[seg]) / l, 0, 1);
    this.placeOnPath(p);
    p._reloc = 1; p._latP = null;             // a (re)placement: not a step (settle)
  },

  placeOnPath(p) {
    this.placeOnStrip(p);
    // A crossing is walked on the crosswalk itself: along the stripes from the kerb point the span matched to the
    // other one, the lane kept inside them. A pavement strip meets a junction at its own angle (it crossed 明治通り up
    // to 3 m outside the stripes, and rejoins the far pavement 6.6 m along the kerb), so the last and first CW_BLEND m
    // of pavement either side ease between the strip and the crosswalk's kerb ends -- on the pavement, no jump.
    // Two crossings a few metres apart share the pavement between them: the first span whose ease reached the walker
    // used to own it outright, so the hand-over to the next was a jump (0.1-0.3 m in a frame, 8-21 m/s). The eases
    // are composed in order along the path instead (each takes its share of what the earlier ones left), continuous
    // everywhere; buildSpans keeps every ease off the neighbouring stripes, so on the stripes a span is alone.
    const P = p.path;
    if (!P || !P.sigN) return;
    const sv = P.cum[p.seg] + p.t * (P.cum[p.seg + 1] - P.cum[p.seg]);
    const cws = P.cwSpans || P.spans, x0 = p.x, z0 = p.z;
    let ox = 0, oz = 0, rem = 1, hx = 0, hz = 0, full = null;
    for (let k = 0; k < cws.length && rem > 1e-4; k++) {
      const S = cws[k], C = S.cw;
      const b0 = S.bl0 || CW_BLEND, b1 = S.bl1 || CW_BLEND;
      if (!C || sv < S.s0 - b0 || sv > S.s1 + b1) continue;
      const u = clamp((sv - S.s0) / Math.max(0.1, S.s1 - S.s0), 0, 1);
      const dx = C.bx - C.ax, dz = C.bz - C.az, l = Math.hypot(dx, dz) || 1, nx = -dz / l, nz = dx / l, lat = clamp(p.lat, -C.hw, C.hw);
      const cx = C.ax + dx * u + nx * lat, cz = C.az + dz * u + nz * lat;
      let w = sv < S.s0 ? 1 - (S.s0 - sv) / b0 : sv > S.s1 ? 1 - (sv - S.s1) / b1 : 1;
      w = w * w * (3 - 2 * w);
      const e = w * rem;
      if (!(e > 0)) continue;
      if (MOTION_DBG && w < 1) p._mdCw = 1;
      ox += (cx - x0) * e; oz += (cz - z0) * e; rem -= e;
      if (l > 0.1) { hx += dx / l * e; hz += dz / l * e; }
      if (sv >= S.s0 && sv <= S.s1) full = [nx, nz];   // (on the stripes themselves: the smoothed ease reads > 0.999 a metre off them)
    }
    const W = 1 - rem;
    if (!(W > 0)) return;
    // off the stripes the ease stays on the pavement (a rounded kerb corner is not cut: it put waiters 0.6 m into
    // the road): the largest share of it that does, bisected -- it was cut in 40% steps, each a jump
    let s = 1;
    if (!full && this.field && this.field.sample(x0 + ox, z0 + oz) < 0.3) {
      let lo = 0, hi = 1;
      for (let it = 0; it < 7; it++) { const m = (lo + hi) / 2; if (this.field.sample(x0 + ox * m, z0 + oz * m) < 0.3) hi = m; else lo = m; }
      s = lo;
    }
    p.x = x0 + ox * s; p.z = z0 + oz * s;
    if (full) { p.nx = full[0]; p.nz = full[1]; }
    if (p.dir && (hx || hz)) p.yaw += wrapPi(Math.atan2(hx * p.dir, hz * p.dir) - p.yaw) * Math.min(1, W * s);
  },

  // The lane is the centre line offset by lat along its normal. Each segment's own normal made every polyline vertex
  // a jump of 2*lat*sin(turn/2) (0.5-0.7 m in one frame for a 6 m lane at a 5-7 deg bend of センター街): within rc of
  // a vertex the normal turns through the bisector instead (continuous at the vertex from both sides), rc sized so
  // the offset curve never folds back on the inside of the bend. _sf is the local ratio of lane distance to centre
  // line distance (1 + lat * dphi/ds): stepWalker divides the along-path step by it so the person keeps walking at v.
  placeOnStrip(p) {
    const pts = p.path.pts, i = p.seg, a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1, L = Math.abs(p.lat || 0);
    const a0 = Math.atan2(dx, dz), s = p.t * len;
    let ang = a0, dphi = 0;
    if (L > 0.01) {
      if (i > 0) {
        const c = pts[i - 1], d = wrapPi(a0 - Math.atan2(a[0] - c[0], a[1] - c[1]));
        const rc = Math.min(0.5 * len, 0.5 * Math.hypot(a[0] - c[0], a[1] - c[1]), Math.max(1.2, 1.2 * L * Math.abs(d)));
        if (s < rc && rc > 0.05) { ang = a0 - d * 0.5 * (1 - s / rc); dphi = d * 0.5 / rc; }
      }
      if (i + 2 < pts.length) {
        const c = pts[i + 2], d = wrapPi(Math.atan2(c[0] - b[0], c[1] - b[1]) - a0);
        const rc = Math.min(0.5 * len, 0.5 * Math.hypot(c[0] - b[0], c[1] - b[1]), Math.max(1.2, 1.2 * L * Math.abs(d)));
        if (len - s < rc && rc > 0.05) { ang = a0 + d * 0.5 * (1 - (len - s) / rc); dphi = d * 0.5 / rc; }
      }
    }
    const nx = -Math.cos(ang), nz = Math.sin(ang);
    p.nx = nx; p.nz = nz;
    p._sf = Math.max(0.35, 1 + (p.lat || 0) * dphi * Math.cos(ang - a0));
    p.x = a[0] + dx * p.t + nx * p.lat;
    p.z = a[1] + dz * p.t + nz * p.lat;
    if (p.dir) p.yaw = p.dir > 0 ? ang : ang + Math.PI;
  },

  // plaza life: standing clusters, statue photo ring, railing leaners, a ticket-gate queue, two koban police
  seedIdlers(rng, city) {
    this.queues = [];
    const plazas = (city.plazas || []).filter(p => p.polygon && p.polygon.length >= 3);
    if (!plazas.length) { this.nIdlers = 0; return; }
    const area = (poly) => { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]; return Math.abs(a) / 2; };
    const scored = plazas.map(p => ({ p, s: area(p.polygon) * (p.id === 'hachiko' ? 8 : p.statue ? 1.4 : 0.5) }));
    const total = scored.reduce((a, q) => a + q.s, 0) || 1;
    let n = 0;
    for (const { p, s } of scored) {
      const want = Math.round(N_IDLERS * s / total);
      const zoneI = p.id === 'hachiko' ? 'youth' : 'station';
      const poly = p.polygon;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
      const inside = (x, z) => pointInPolygon(x, z, poly) && (!p.koban || Math.hypot(x - p.koban.pos[0], z - p.koban.pos[1]) > 5.2) && (!p.statue || Math.hypot(x - p.statue.pos[0], z - p.statue.pos[1]) > 2.1);
      // Hachiko: the standing clusters lean toward the station-frontage (east) half of the square
      const east = p.id === 'hachiko' ? (minX + maxX) / 2 - 2 : minX;
      const sample = () => { const x0 = rng() < 0.62 ? east : minX; for (let k = 0; k < 24; k++) { const x = rng.range(x0, maxX), z = rng.range(minZ, maxZ); if (inside(x, z)) return [x, z]; } return null; };
      let made = 0;
      // koban police: two outside the door, one standing post out in the square where he can be seen. Placed in the
      // koban's own frame (its front normal from rotY, the door where smallLandmarks.koban() cuts it: a quarter of
      // the width left of centre), not at world-axis offsets: those put one officer inside the parked bicycles.
      if (p.koban && want > 6) {
        const kr = p.koban.rotY || 0, kfx = Math.cos(kr), kfz = -Math.sin(kr), ktx = -kfz, ktz = kfx;
        const KW = 5.4, KD = 4.8, door = -KW / 4 + 0.2;
        const post = [[KD / 2 + 1.2, door + 0.8, 0], [KD / 2 + 1.2, door + 1.9, 0.12], [KD / 2 + 3.6, door + 3.4, -0.35]];
        for (let k = 0; k < 3; k++) {
          const q = this.makePed(rng, 'idler', LOOK_IX.police);
          const [f, tg, turn] = post[k];
          q.x = p.koban.pos[0] + kfx * f + ktx * tg; q.z = p.koban.pos[1] + kfz * f + ktz * tg;
          q.yaw = Math.atan2(kfx, kfz) + turn; q.police = true; q.fidget = 0.25; q.scale = rng.range(0.96, 1.03);
          // at attention: heels together, the 警杖 planted by the right foot, cap on
          q.phone = false; q.bagKind = 0; q.hairKind = 0; q.idlePose = 12; q.attn = true; q.umb = false; q.farVar &= ~11;
          q.cUmb.set(0xb89c70); q.headP = 0.02; q.headY = 0; q.cCap = new THREE.Color(0x1c2436); q.capS = 1.02;
          this.peds.push(q); n++; made++;
        }
      }
      // people waiting to meet somebody 8-15 m out from the koban (the square's landmark meeting point after the
      // statue): clusters of 3-5, most of them on their phones
      if (p.koban && p.id === 'hachiko') {
        const kr = p.koban.rotY || 0, kfx = Math.cos(kr), kfz = -Math.sin(kr), ktx = -kfz, ktz = kfx;
        for (const [f, tg] of [[8, -7.5], [11, 3.5], [13.5, -0.5]]) {   // (clear of the sight line to the door)
          const cx = p.koban.pos[0] + kfx * f + ktx * tg, cz = p.koban.pos[1] + kfz * f + ktz * tg;
          if (!pointInPolygon(cx, cz, poly)) continue;
          const kk = rng.int(3, 5), a0 = rng() * Math.PI * 2, r = 0.5 + 0.1 * kk, clump = [];
          for (let j = 0; j < kk; j++) {
            const a = a0 + (j / kk) * Math.PI * 2 + rng.range(-0.2, 0.2);
            const q = this.makePed(rng, 'idler', null, zoneI, j > 0 && rng() < 0.08);
            q.x = cx + Math.cos(a) * r; q.z = cz + Math.sin(a) * r;
            q.yaw = Math.atan2(cx - q.x, cz - q.z) + rng.range(-0.3, 0.3);
            q.group = 1; const r2 = rng(); q.idlePose = r2 < 0.5 ? 3 : r2 < 0.62 ? 10 : idlePoseFor(rng, q); q.phone = q.idlePose === 3 || q.idlePose === 10;
            if (clump.length) { q.mate = clump[clump.length - 1]; q.talk = 1; if (!clump[0].mate) { clump[0].mate = q; clump[0].talk = 1; } }
            this.decorrelate(q, clump, rng); clump.push(q);
            this.peds.push(q); n++; made++;
          }
        }
      }
      // ticket-gate queues: files running normal to the station frontage. Without them the plaza edge is a
      // single evenly-spaced rank of standing bodies -- a picket fence in front of gates nobody ever uses.
      const gate = p.id === 'hachiko' && CITY.landmarks.station && CITY.landmarks.station.hachikoExit;
      if (gate && want > 20) {
        const gx = gate.pos[0], gz = gate.pos[1];
        let cx = 0, cz = 0;
        for (const [x, z] of poly) { cx += x; cz += z; }
        cx /= poly.length; cz /= poly.length;
        let bi = 0, bd = Infinity, tx = 1, tz = 0;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const mx = (poly[i][0] + poly[j][0]) / 2, mz = (poly[i][1] + poly[j][1]) / 2;
          const d = (mx - gx) ** 2 + (mz - gz) ** 2;
          if (d < bd) { bd = d; bi = i; }
        }
        const a0 = poly[(bi + poly.length - 1) % poly.length], b0 = poly[bi];
        const el = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) || 1;
        tx = (b0[0] - a0[0]) / el; tz = (b0[1] - a0[1]) / el;
        let gnx = -tz, gnz = tx;
        if ((cx - gx) * gnx + (cz - gz) * gnz < 0) { gnx = -gnx; gnz = -gnz; }   // point into the square
        for (let qi = 0; qi < 3 && made < want; qi++) {
          const off = (qi - 1) * 3.8 + rng.range(-0.6, 0.6);
          const Q = { x: gx + tx * off + gnx * 0.5, z: gz + tz * off + gnz * 0.5, nx: gnx, nz: gnz, t: rng.range(1, 9), members: [] };
          const kq = rng.int(4, 6);
          let slot = 0, prev = null;
          for (let j = 0; j < kq && made < want; j++, made++) {
            const q = this.makePed(rng, 'idler', null, zoneI);
            q.queue = Q;
            // not a row of posts: each stands a little off the file's line, turned their own way, at their own gap
            // (+/-0.5 m along the file); a third of them queue as a PAIR, side by side and turned to each other
            if (prev && !prev.qPair && rng() < 0.35) {
              q.qSlot = prev.qSlot; q.qJit = prev.qJit + 0.62; q.qPair = prev; prev.qPair = q;
              q.mate = prev; prev.mate = q; q.talk = prev.talk = 1;
            } else { q.qSlot = slot++; q.qJit = rng.range(-0.3, 0.3); }
            q.qYaw = rng.range(-0.4, 0.4); q.qGap = rng.range(-0.25, 0.5);
            q.x = Q.x + gnx * (0.55 + q.qSlot * 0.80) - gnz * q.qJit; q.z = Q.z + gnz * (0.55 + q.qSlot * 0.80) + gnx * q.qJit;
            q.yaw = Math.atan2(-gnx, -gnz) + q.qYaw;
            const r = rng();
            q.idlePose = r < 0.40 ? 3 : r < 0.52 ? 10 : r < 0.62 ? 11 : r < 0.80 ? 2 : 0; q.phone = q.idlePose === 3 || q.idlePose === 10;
            Q.members.push(q); this.peds.push(q); n++;
            prev = q;
          }
          this.queues.push(Q);
        }
      }
      // rejects must NOT count toward `want` or the plaza never fills; a guard stops a degenerate polygon looping
      let guard = want * 60;
      while (made < want && guard-- > 0) {
        const mode = rng();
        // fix round 1 (critic: the square's standers were a row facing the statue at even spacing, nobody in a
        // pair): the ring and the leaners come in pairs half the time, every group is linked as company (heads turn
        // to each other, the talk gestures), yaws carry +/-60 degrees of their own, a phone at the chest on 30 % of
        // pairs
        const pairUp = (qa, qb) => { qa.mate = qb; qb.mate = qa; qa.talk = qb.talk = 1; qa.group = qb.group = 1; if (rng() < 0.3) { qb.idlePose = 3; qb.phone = true; } };
        if (p.statue && mode < 0.20) {                 // photo ring around the statue, facing it
          const a = rng.range(0, Math.PI * 2), r = rng.range(2.3, 5.4);
          const q = this.makePed(rng, 'idler', null, zoneI);
          q.x = p.statue.pos[0] + Math.cos(a) * r; q.z = p.statue.pos[1] + Math.sin(a) * r;
          if (!pointInPolygon(q.x, q.z, poly)) continue;
          q.yaw = Math.atan2(p.statue.pos[0] - q.x, p.statue.pos[1] - q.z) + rng.range(-0.5, 0.5);
          q.phone = rng() < 0.62; q.idlePose = q.phone ? (rng() < 0.6 ? 4 : 3) : idlePoseFor(rng, q);
          this.peds.push(q); n++; made++;
          if (rng() < 0.55 && made < want) {           // in company: the friend beside them, half turned to them
            const q2 = this.makePed(rng, 'idler', null, zoneI, rng() < 0.1);
            q2.x = q.x - Math.sin(a) * 0.66; q2.z = q.z + Math.cos(a) * 0.66;
            if (pointInPolygon(q2.x, q2.z, poly)) {
              q2.yaw = q.yaw + wrapPi(Math.atan2(q.x - q2.x, q.z - q2.z) - q.yaw) * 0.5 + rng.range(-0.35, 0.35);
              q2.idlePose = idlePoseFor(rng, q2); if (q2.idlePose === 3) q2.idlePose = 1;
              pairUp(q, q2); this.decorrelate(q2, [q], rng);
              this.peds.push(q2); n++; made++;
            }
          }
        } else if (mode < 0.46) {                      // packed clump of 2-5 facing inward
          const c = sample(); if (!c) continue;
          const k = rng.int(2, 5), a0 = rng() * Math.PI * 2, clump = [];
          const r = 0.52 + 0.105 * k;                  // conversational spacing, not shoulder-to-shoulder
          for (let j = 0; j < k && made < want; j++, made++) {
            const a = a0 + (j / k) * Math.PI * 2 + rng.range(-0.18, 0.18);
            const q = this.makePed(rng, 'idler', null, zoneI, j > 0 && rng() < 0.08);
            q.x = c[0] + Math.cos(a) * r; q.z = c[1] + Math.sin(a) * r;
            q.yaw = Math.atan2(c[0] - q.x, c[1] - q.z) + rng.range(-0.6, 0.6);
            q.group = 1; q.idlePose = idlePoseFor(rng, q); if (q.idlePose === 3) q.idlePose = j === 1 && rng() < 0.5 ? 3 : 1; q.phone = q.idlePose === 3;
            if (clump.length) { q.mate = clump[clump.length - 1]; q.talk = 1; if (!clump[0].mate) { clump[0].mate = q; clump[0].talk = 1; } }
            this.decorrelate(q, clump, rng); clump.push(q);
            this.peds.push(q); n++;
          }
        } else if (mode < 0.62) {                      // leaners / queue along a polygon edge
          const e = rng.int(0, poly.length - 1), a = poly[e], b = poly[(e + 1) % poly.length];
          const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l;
          const inx = pointInPolygon(a[0] + nx * 2, a[1] + nz * 2, poly) ? 1 : -1;
          // inset with a random depth: seeding on the polygon edge itself lines everyone up on one rank
          const t = rng.range(0.08, 0.92), off = rng.range(1.5, 5.4) * inx;
          const q = this.makePed(rng, 'idler', null, zoneI);
          q.x = a[0] + (b[0] - a[0]) * t + nx * off; q.z = a[1] + (b[1] - a[1]) * t + nz * off;
          if (!pointInPolygon(q.x, q.z, poly)) continue;
          // most face the frontage they are standing at; some have turned to face whoever they are waiting for
          q.yaw = Math.atan2(-nx * inx, -nz * inx) + (rng() < 0.32 ? Math.PI : 0) + rng.range(-0.6, 0.6);
          q.phone = rng() < 0.5; q.lean = 1; q.idlePose = q.phone ? (rng() < 0.3 ? 10 : 3) : idlePoseFor(rng, q);
          this.peds.push(q); n++; made++;
          if (rng() < 0.35 && made < want) {           // a facing pair along the edge
            const q2 = this.makePed(rng, 'idler', null, zoneI);
            q2.x = q.x + (b[0] - a[0]) / l * 0.7; q2.z = q.z + (b[1] - a[1]) / l * 0.7;
            if (pointInPolygon(q2.x, q2.z, poly)) {
              q.yaw = Math.atan2(q2.x - q.x, q2.z - q.z) + rng.range(-0.3, 0.3);
              q2.yaw = q.yaw + Math.PI + rng.range(-0.3, 0.3); q2.lean = 1;
              q2.idlePose = idlePoseFor(rng, q2); if (q2.idlePose === 3) q2.idlePose = 2;
              pairUp(q, q2); this.decorrelate(q2, [q], rng);
              this.peds.push(q2); n++; made++;
            }
          }
        } else {                                       // scattered loiterers and slow strollers crossing the square
          const c = sample(); if (!c) continue;
          const q = this.makePed(rng, 'idler', null, zoneI);
          q.x = c[0]; q.z = c[1]; q.yaw = rng.range(-Math.PI, Math.PI);
          q.idlePose = idlePoseFor(rng, q); q.phone = q.idlePose === 3;
          if (rng() < 0.82) {                          // a square with nobody moving through it reads as a diorama
            q.stroll = 1; q.poly = poly; q.box = [minX, maxX, minZ, maxZ];
            q.tx = q.x; q.tz = q.z; q.wait = rng.range(0, 7);
          }
          this.peds.push(q); n++; made++;
        }
      }
    }
    for (const q of this.peds) if (q.kind === 'idler') { q.hx = q.x; q.hz = q.z; }
    this.nIdlers = n;
  },

  // Street trade. Center-gai at night without キャッチ outside the izakaya is wrong for the genre: touts stand at
  // the kerb in front of the karaoke / izakaya / bar frontages and turn to work whoever is walking past, and at
  // the station exit and the crossing corners people hand out tissue packs and flyers.
  seedRoles(rng, city) {
    const facs = city.facades || [], w = this.engine.world, V = new THREE.Vector3();
    const NIGHT = /居酒屋|カラオケ|焼鳥|BAR|Bar|バー|スナック|漁港|串|ジャンカレ|ビックエコー|笑々|鳥貴|白木|魚氏|和氏|牛閣|温野|銀の蔵|土間|甚八|ホスト|キャバ/;
    const MOUTH = [-40, -45];                      // Center-gai's mouth: its izakaya frontages carry no tenant name
    const ok = (x, z) => {
      if (this.field && this.field.sample(x, z) < 0.45) return false;
      if (w && w.overlapSphere) { const h = w.overlapSphere(V.set(x, 1, z), 0.4); if (h && h.length) return false; }
      return !this.peds.some(q => q.kind === 'idler' && Math.abs(q.x - x) < 0.8 && Math.abs(q.z - z) < 0.8);
    };
    const spots = [];
    for (const f of facs) {
      const P = f.position, Nn = f.normal;
      if (!P || !Nn || Math.hypot(P.x - this.center[0], P.z - this.center[1]) > 110) continue;
      const mouth = Math.hypot(P.x - MOUTH[0], P.z - MOUTH[1]) < 16 && f.kind !== 'landmark';
      if (!mouth && !NIGHT.test((f.tenants || []).join('|'))) continue;
      const along = rng.range(-0.25, 0.25) * (f.width || 4), tx = -Nn.z, tz = Nn.x;
      const x = P.x + Nn.x * 1.15 + tx * along, z = P.z + Nn.z * 1.15 + tz * along;
      if (spots.some(q => Math.hypot(q[0] - x, q[1] - z) < 5) || !ok(x, z)) continue;
      spots.push([x, z, Nn.x, Nn.z]);
    }
    let n = 0;
    // a キャッチ reads as one at a glance: the izakaya's own happi (navy, the white collar band down the front), or a
    // black suit holding the laminated A4 menu board against the chest
    const mk = (x, z, yaw, role) => {
      const happi = role === 1 && rng() < 0.55;
      const q = this.makePed(rng, 'idler', role === 1 ? (happi ? LOOK_IX.happi : LOOK_IX.black) : (rng() < 0.5 ? LOOK_IX.staff : LOOK_IX.casual), 'youth');
      q.x = q.hx = q.tx = x; q.z = q.hz = q.tz = z; q.yaw = q.baseYaw = q.faceYaw = yaw;
      q.role = role; q.chat = role === 1 && happi ? 1 : 0; q.phone = false; q.umb = false; q.bagKind = 0; q.farVar &= ~9;
      q.placard = role === 1 && !happi;
      q.idlePose = role === 1 ? (happi ? (rng() < 0.5 ? 0 : 5) : 13) : 3; q.ext = 0; q.mark = null; q.fidI = n & 7;
      q.fem = q.fem && role !== 1;
      this.peds.push(q); n++;
      return q;
    };
    // the first 20 m of the Center-gai lens get their own: two or three at the frontages either side of the mouth
    const lens = spots.filter(q => q[0] > -48 && q[0] < -32 && q[1] < -30 && q[1] > -52);
    // the mouth's izakaya frontages carry no tenant names, so the facade scan finds one pitch at most: stand the
    // rest at the frontage edge of the first 20 m, alternating sides, facing into the street
    const M0 = this.mouthPath;
    if (M0) for (const [sv, side] of [[34, 1], [40, -1], [46, 1], [52, -1]]) {
      if (lens.length >= 3) break;
      const lat = side * (M0.width / 2 - 0.9);
      for (let k = 0; k < 6; k++) {
        const c = this.pathPoint(M0, sv + rng.range(-2, 2), lat - side * rng.range(0, 0.6));
        if (!ok(c[0], c[1]) || lens.some(q => Math.hypot(q[0] - c[0], q[1] - c[1]) < 4)) continue;
        const a = this.pathPoint(M0, sv, 0), nx = a[0] - c[0], nz = a[1] - c[1], l = Math.hypot(nx, nz) || 1;
        lens.push([c[0], c[1], nx / l, nz / l]);
        break;
      }
    }
    const rest = spots.filter(q => lens.indexOf(q) < 0);
    const pick = [...lens.slice(0, 3), ...rest].slice(0, 14);
    for (const [x, z, nx, nz] of pick) mk(x, z, Math.atan2(nx, nz) + rng.range(-0.6, 0.6), 1);
    this.toutLens = lens.length;
    // hand-outs: the station exit, the Hachiko and Q-FRONT corners, the Center-gai mouth
    const C = CITY.crossing.corners, ex = CITY.landmarks.station && CITY.landmarks.station.hachikoExit;
    const hand = [];
    for (const c of [C.hachiko, C.qfront, C.sanzenri, C.magnet]) {
      if (!c) continue;
      const dx = c[0] - this.center[0], dz = c[1] - this.center[1], l = Math.hypot(dx, dz) || 1;
      hand.push([c[0] + dx / l * 7.5 + rng.range(-1.5, 1.5), c[1] + dz / l * 7.5 + rng.range(-1.5, 1.5)]);
    }
    if (ex) hand.push([ex.pos[0] + rng.range(-3, 3), ex.pos[1] + rng.range(3, 6)]);
    hand.push([-35.5, -36.5]);
    for (const [x0, z0] of hand) {
      let x = x0, z = z0, tries = 0;
      while (!ok(x, z) && tries++ < 12) { x = x0 + rng.range(-3, 3); z = z0 + rng.range(-3, 3); }
      if (tries >= 12) continue;
      mk(x, z, Math.atan2(this.center[0] - x, this.center[1] - z) + rng.range(-1.2, 1.2), 2);
    }
    // (a pitch against a shop's glass is taken FRONT_CLEAR out from it)
    for (const q of this.peds) if (q.role) { const fo = this.frontOut(q.x, q.z, FRONT_CLEAR); if (fo) { q.x = q.tx = fo[0]; q.z = q.tz = fo[1]; } q.hx = q.x; q.hz = q.z; }
    this.nIdlers += n; this.nRoles = n;
    // people waiting to meet somebody along the STARBEANS frontage of the Center-gai mouth, in twos and threes
    const M = this.mouthPath;
    if (M) {
      let made = 0;
      for (let g = 0; g < 14 && made < 16; g++) {
        const c = this.pathPoint(M, rng.range(30, 50), rng.range(2.6, 6.2));
        if (!ok(c[0], c[1])) continue;
        const k = rng() < 0.45 ? 1 : rng.int(2, 3), a0 = rng() * Math.PI * 2, r = k > 1 ? 0.5 + 0.1 * k : 0;
        for (let j = 0; j < k; j++) {
          const a = a0 + (j / k) * Math.PI * 2, x = c[0] + Math.cos(a) * r, z = c[1] + Math.sin(a) * r;
          if (!ok(x, z)) continue;
          const q = this.makePed(rng, 'idler');
          q.x = q.hx = x; q.z = q.hz = z;
          q.yaw = k > 1 ? Math.atan2(c[0] - x, c[1] - z) + rng.range(-0.25, 0.25) : rng.range(-Math.PI, Math.PI);
          q.group = k > 1 ? 1 : 0;
          if (k === 1) { q.idlePose = rng() < 0.6 ? 3 : 10; q.phone = q.idlePose === 3; }
          this.peds.push(q); made++;
        }
      }
      this.nIdlers += made;
      // fix round 1 (critic: the bookstore pavement was a file of standers at one distance from the shelves): six
      // to eight standing PAIRS at the shopfronts of the lens's first 25 m, both sides, a step off the frontage,
      // turned to each other, a phone at the chest on a third of them (atShop: they may stand in the shop's light)
      let pairs = 0;
      for (let g = 0; g < 40 && pairs < 8; g++) {
        const sv = rng.range(26, 52), side = g & 1 ? 1 : -1, lat = side * (M.width / 2 - rng.range(1.0, 1.9));
        const c = this.pathPoint(M, sv, lat);
        if (!ok(c[0], c[1])) continue;
        const a = this.pathPoint(M, sv - 0.34, lat), b = this.pathPoint(M, sv + 0.34, lat);
        const qa = this.makePed(rng, 'idler', null, 'youth'), qb = this.makePed(rng, 'idler', null, 'youth');
        qa.x = qa.hx = a[0]; qa.z = qa.hz = a[1]; qb.x = qb.hx = b[0]; qb.z = qb.hz = b[1];
        qa.yaw = Math.atan2(b[0] - a[0], b[1] - a[1]) + rng.range(-0.3, 0.3); qb.yaw = qa.yaw + Math.PI + rng.range(-0.3, 0.3);
        qa.group = qb.group = 1; qa.mate = qb; qb.mate = qa; qa.talk = qb.talk = 1; qa.atShop = qb.atShop = true;
        qa.idlePose = idlePoseFor(rng, qa); if (qa.idlePose === 3) qa.idlePose = 1;
        if (rng() < 0.3) { qb.idlePose = 3; qb.phone = true; } else { qb.idlePose = idlePoseFor(rng, qb); if (qb.idlePose === 3) qb.idlePose = 1; }
        this.decorrelate(qb, [qa], rng);
        this.peds.push(qa, qb); pairs++;
      }
      this.nIdlers += pairs * 2; this.mouthPairs = pairs;
    }
    // Meeting spots in the first few metres of the two street-level views the client judges the crowd from: just
    // inside the Center-gai mouth, and the crossing corner of the Hachiko square. Round 3's lens bubble left both
    // with an empty moat of paving in the bottom third of the frame; in the real street people wait right there.
    //   [x, z, yaw toward (x, z) or null, pose]: a pair talking, a phone, a threesome; a pair, a phone, a threesome
    const SPOTS = [
      [[-42.0, -31.6, -42.5, -32.6, 0], [-42.5, -32.6, -42.0, -31.6, 0], [-37.8, -33.0, null, 3], [-43.4, -35.2, -43.6, -35.8, 1], [-44.1, -35.9, -43.6, -35.8, 3], [-43.2, -36.2, -43.6, -35.8, 2],
        [-39.4, -35.6, -38.9, -36.3, 10], [-38.9, -36.3, -39.4, -35.6, 0]],
      [[18.6, 26.6, 19.2, 27.5, 0], [19.2, 27.5, 18.6, 26.6, 10], [14.4, 28.6, null, 3], [21.5, 30.5, 21.8, 31.1, 3], [22.4, 31.2, 21.8, 31.1, 1], [21.4, 31.6, 21.8, 31.1, 0]],
    ];
    let spotN = 0;
    for (const set of SPOTS) {
      const clump = [];
      for (const [x, z, fx, fz, pose] of set) {
        if (!ok(x, z)) continue;
        const q = this.makePed(rng, 'idler', null, 'youth');
        q.x = q.hx = q.tx = x; q.z = q.hz = q.tz = z;
        q.yaw = fx == null ? rng.range(-Math.PI, Math.PI) : Math.atan2(fx - x, fz - z) + rng.range(-0.25, 0.25);
        q.group = fx == null ? 0 : 1; q.idlePose = pose; q.phone = pose === 3 || pose === 10;
        this.decorrelate(q, clump, rng); clump.push(q);
        this.peds.push(q); spotN++;
      }
    }
    this.nIdlers += spotN;
  },

  pathPoint(path, sv, lat) {
    const { cum, pts } = path;
    let seg = 0;
    while (seg < pts.length - 2 && cum[seg + 1] < sv) seg++;
    const a = pts[seg], b = pts[seg + 1], l = cum[seg + 1] - cum[seg] || 1, u = clamp((sv - cum[seg]) / l, 0, 1);
    const nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l;
    return [a[0] + (b[0] - a[0]) * u + nx * lat, a[1] + (b[1] - a[1]) * u + nz * lat];
  },

  // the nearest person on the move within 5.5 m, for a tout or a hand-out to turn to
  nearestPasser(p) {
    let best = null, bd = 30.25;
    const peds = this.peds;
    for (let k = 0; k < peds.length; k++) {
      const q = peds[k];
      if (q === p || !q.moving) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      if (dx > 5.5 || dx < -5.5 || dz > 5.5 || dz < -5.5) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = q; }
    }
    return best;
  },

  waitSpot(p, c, rng) {
    const [cx, cz] = this.corners[c];
    const dx = cx - this.center[0], dz = cz - this.center[1];
    const r0 = Math.hypot(dx, dz) || 1;
    // a u*u kerb bias stacks every waiter into a thin annulus at the corner; linear in u gives the wedge depth
    // (2026-09-25, the pedestrian signals: the wedge is +/-31 degrees of a circle, and at the 駅前ビル and 三千里 corners
    // it reached out over 道玄坂下's carriageway -- people "waiting at the kerb" stood in the road and walked the
    // crossing outside its stripes. A spot is drawn again until it is on the pavement, else walked up to it.)
    const f = this.field;
    let r = 0;
    for (let k = 0; k < 12; k++) {
      const u = rng();
      r = Math.max(CITY.crossing.radius + 1.2, r0) + 0.3 + 4.3 * u;
      const a = Math.atan2(dz, dx) + rng.range(-0.55, 0.55);
      p.tx = this.center[0] + Math.cos(a) * r;
      p.tz = this.center[1] + Math.sin(a) * r;
      if (!f || f.sample(p.tx, p.tz) >= 0.6) break;
    }
    if (f && f.sample(p.tx, p.tz) < 0.6) {
      let x = p.tx, z = p.tz;
      for (let i = 0; i < 14; i++) {
        const d = f.sample(x, z); if (d >= 0.6) break;
        const e = 0.7, gx = f.sample(x + e, z) - f.sample(x - e, z), gz = f.sample(x, z + e) - f.sample(x, z - e), g = Math.hypot(gx, gz);
        if (g < 1e-4) break;
        const st = Math.min(0.9, 0.7 - d); x += gx / g * st; z += gz / g * st;
      }
      p.tx = x; p.tz = z; r = Math.hypot(x - this.center[0], z - this.center[1]);
    }
    p.kerbD = Math.max(0, r - r0);
  },

  // `kid`: only the seeders' company code asks for a child, and only as the companion of an adult -- a 1.1 m figure
  // crossing the scramble on its own read as a person who had shrunk
  // Company is not a uniform: three friends side by side in the same cream knit read as one model placed three times
  // (the critic's flagship-frame trio). A companion whose top lands in the same value / hue bin as somebody already
  // in its group redraws it -- first from its own look's palette, then from a wider street palette. Uniformed looks
  // and salarymen's suits are left alone: a row of navy suits is how an office goes out for a drink.
  decorrelate(q, group, rng) {
    if (!group.length || q.lookK === 'suit' || q.lookK === 'school' || q.lookK === 'staff' || q.lookK === 'police' || q.lookK === 'happi') return;
    const bin = (c) => {
      const L = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      c.getHSL(_hsl);
      return (L < 0.02 ? 0 : L < 0.12 ? 10 : 20) + (_hsl.s < 0.18 ? 9 : Math.floor(_hsl.h * 6) % 6);
    };
    const taken = new Set();
    for (const o of group) if (o && o !== q) taken.add(bin(o.cCloth));
    if (!taken.has(bin(q.cCloth))) return;
    const look = LOOKS[LOOK_IX[q.lookK]], pal = look.top.concat(ALT_TOPS), k0 = rng.int(0, pal.length - 1);
    for (let k = 0; k < pal.length; k++) {
      _ct.set(pal[(k0 + k) % pal.length]);
      if (taken.has(bin(_ct))) continue;
      const old = q.cCloth.getHex();
      const accOld = q.cAcc.equals(q.cCloth);
      q.cCloth.copy(_ct); q.cSleeve.copy(_ct).multiplyScalar(0.82);
      liftDark(q.cCloth); liftDark(q.cSleeve);
      if (!q.bare) q.cFarm.copy(q.cSleeve);
      if (accOld || q.cAcc.getHex() === old) q.cAcc.copy(q.cCloth);
      return;
    }
  },

  // No two of a kind in one frame. 1 489 people drawn from 13 looks x 4-8 tops x 3 trousers put the same top and
  // trousers on 5-16 people each, and two of them on the same crosswalk read as one model placed twice. A look /
  // top / trouser combination already dealt three times is redrawn from the look's palette and the wider street
  // palette, and then every top and trouser drifts a little in value and hue, so no two are the identical hex.
  // Uniforms (school, police, happi, the apron) are meant to repeat; suits and the black look keep their own palette.
  dedupe(rng) {
    const seen = new Map();
    const setTop = (q, c) => {
      const old = q.cCloth.getHex(), accSame = q.cAcc.getHex() === old;
      q.cCloth.copy(c); liftDark(q.cCloth);
      if (q.O.sleeveCol == null) { q.cSleeve.copy(q.cCloth).multiplyScalar(0.82); liftDark(q.cSleeve); if (!q.bare) q.cFarm.copy(q.cSleeve); }
      if (accSame) q.cAcc.copy(q.cCloth);
      // a redrawn light top keeps the legFor rule: the trousers under it go to the look's darkest
      if (srgbLum(q.cCloth.getHex()) > 0.55 && srgbLum(q.cLeg.getHex()) > 0.30) {
        const legSame = !q.shinSkin && q.cShin.getHex() === q.cLeg.getHex();
        q.cLeg.set(LOOKS[LOOK_IX[q.lookK]].leg.slice().sort((a, b) => srgbLum(a) - srgbLum(b))[0]); liftDark(q.cLeg);
        if (legSame) q.cShin.copy(q.cLeg);
      }
    };
    const drift = (c, v, h) => { c.getHSL(_hsl); return _ct.setHSL((_hsl.h + rng.range(-h, h) + 1) % 1, clamp(_hsl.s * rng.range(0.88, 1.12), 0, 1), clamp(_hsl.l * rng.range(1 - v, 1 + v), 0.005, 0.97)); };
    let redrawn = 0;
    for (const q of this.peds) {
      if (q.police || q.lookK === 'school' || q.lookK === 'happi' || q.O.vest) continue;
      const fixed = q.lookK === 'suit' || q.lookK === 'staff' || q.lookK === 'black';
      if (!fixed) {
        const key = (c) => `${q.lookK}|${c}|${q.cLeg.getHex()}|${q.fem ? 1 : 0}`;
        const k = key(q.cCloth.getHex()), n = (seen.get(k) || 0) + 1;
        seen.set(k, n);
        if (n >= 3) {
          const look = LOOKS[LOOK_IX[q.lookK]], pal = look.top.concat(ALT_TOPS), k0 = rng.int(0, pal.length - 1);
          for (let j = 0; j < pal.length; j++) {
            const hex = pal[(k0 + j) % pal.length], kk = key(hex);
            if ((seen.get(kk) || 0) >= 2) continue;
            seen.set(kk, (seen.get(kk) || 0) + 1); seen.set(k, n - 1);
            setTop(q, _ct.set(hex)); redrawn++;
            break;
          }
        }
      }
      setTop(q, drift(q.cCloth, 0.12, 0.012));
      const legSame = !q.shinSkin && q.cShin.getHex() === q.cLeg.getHex();
      q.cLeg.copy(drift(q.cLeg, 0.10, 0.008)); liftDark(q.cLeg);
      if (legSame) q.cShin.copy(q.cLeg);
    }
    this.nRedrawn = redrawn;
  },

  makePed(rng, kind, forceLook, zone, kid) {
    // there is no child among the scanned people: a companion the seeders wanted as a child walks as an adult
    if (this.scanSrc) kid = false;
    const W = WARD_T[zone || (kind === 'crosser' ? 'cross' : 'station')];
    if (kid) forceLook = rng.pick([LOOK_IX.casual, LOOK_IX.colour, LOOK_IX.casual, LOOK_IX.school, LOOK_IX.tourist, LOOK_IX.street]);
    const look = forceLook != null ? LOOKS[forceLook] : (() => { let r = rng() * W.t, i = 0; while (i < LOOKS.length - 1 && (r -= W.a[i]) > 0) i++; return LOOKS[i]; })();
    const child = !!kid;
    const fem = child ? rng() < 0.5 : rng() < (look.fem != null ? look.fem : 0.4);
    // standing heights (scale x RIG_CROWN): children 1.25-1.42 m, adults 1.50-1.90 m -- men 1.60-1.85 with a tall
    // tail, women 1.50-1.72, the elderly a little shorter
    let scale = child ? rng.range(0.705, 0.80)
      : fem ? (look.old ? rng.range(0.85, 0.91) : rng.range(0.855, 0.97))
      : look.old ? rng.range(0.89, 0.97) : rng() < 0.06 ? rng.range(1.04, 1.07) : rng.range(0.905, 1.045);
    if (!child) scale = clamp(scale, 1.50 / RIG_CROWN, 1.90 / RIG_CROWN);
    let top = rng.pick(look.top);
    const skin = rng.pick(SKIN);
    const leg = legFor(look, top, rng.pick(look.leg), skin, rng);
    const O = dressPed(look, fem, child, top, leg, skin, rng);
    if (O.top != null) top = O.top;                            // the garment chose its own colour (a coat, an apron)
    const sleeve = new THREE.Color(O.sleeveCol != null ? O.sleeveCol : top).multiplyScalar(0.82).getHex();
    // Pace is skewed, not a narrow band: one in ten dawdles (a phone in the hand, or old), one in twelve is in a
    // hurry, and the rest spread round 1.3 m/s. A narrow band is what made the WALK wave one wall at one depth.
    let speed = (child ? 1.32 : look.old ? 0.78 : 1.0) * rng.range(1.04, 1.52) * (0.74 + 0.26 * scale);
    const pr = rng();
    let dawdle = false;
    if (!child && pr < 0.10) { speed = rng.range(0.70, 0.90); dawdle = true; }
    else if (!look.old && pr > 0.92) speed = rng.range(1.8, 2.2);
    const um = rng.pick(UMB);
    const hairKind = fem ? (rng() < 0.52 ? 1 : rng() < 0.3 ? 2 : 0) : (rng() < 0.06 ? 1 : rng() < 0.04 ? 2 : 0);
    const dyed = zone === 'youth' && !look.old && look.k !== 'police' && rng() < 0.22;
    const hairHex = dyed ? rng.pick(DYED) : rng.pick(HAIR);
    const capP = look.k === 'police' ? 1 : look.k === 'street' ? 0.42 : look.k === 'tourist' ? 0.2 : look.k === 'casual' || look.k === 'colour' ? 0.06 : 0;
    const cap = hairKind !== 2 && rng() < capP ? (look.k === 'police' ? 0x1c2436 : rng.pick(CAPCOL)) : null;
    const ped = {
      kind, x: 0, z: 0, yaw: 0, speed, scale, phase: rng() * Math.PI * 2, fem, child, O, lookK: look.k,
      shinSkin: O.legBare && O.shin === skin, role: 0, sA: -1, sB: 1e9, wave: 0, link: -1, chat: 0, faceYaw: null,
      farVar: (O.hemY < 0.7 ? 4 : 0),
      // a persistent offset on top of phase: neighbours can never converge no matter how long the sim runs
      phaseOff: rng() * Math.PI * 2,
      cadence: (3.7 / scale) * rng.range(0.78, 1.26) * rng.range(0.88, 1.12),
      bare: O.bare,
      cCloth: new THREE.Color(top), cSleeve: new THREE.Color(sleeve), cLeg: new THREE.Color(O.thigh),
      cShin: new THREE.Color(O.shin), cFarm: new THREE.Color(O.bare ? skin : sleeve),
      cShoe: new THREE.Color(O.shoe), cSole: new THREE.Color(O.sole), cSkin: new THREE.Color(skin), cHair: new THREE.Color(hairHex),
      cHairFar: HAIR_FAR[hairHex] != null ? new THREE.Color(HAIR_FAR[hairHex]) : null,
      // far-tier only (past FAR2_D): a small per-person yaw and size jitter, so a row at 40 m is not a fence of heads
      farJ: (rng() - 0.5) * 0.24, farJs: 1 + (rng() - 0.5) * 0.08,
      cInner: new THREE.Color(O.inner), cAcc: new THREE.Color(O.acc),
      cBag: new THREE.Color(rng.pick(BAGCOL)), cUmb: new THREE.Color(um.c), umbV: um.v,
      cCap: cap != null ? new THREE.Color(cap) : null, capS: rng.range(1.0, 1.05),
      face: ((f) => (child && !KID_POOL && (f & 1) ? 0 : f))(rng.int(0, 3)),   // tiles 1 / 3: stubble / moustache
      hairKind: cap != null && hairKind === 1 && rng() < 0.5 ? 0 : hairKind,
      bagKind: look.k === 'police' || look.k === 'happi' ? 0 : look.school ? 2 : rng() < 0.35 ? 1 : rng() < 0.31 ? 2 : 0,
      phone: dawdle || rng() < 0.25, stoop: look.old ? rng.range(0.14, 0.26) : 0,
      // gait and bearing: stride length, a resting head angle of their own, company (set by the seeders)
      strideK: rng.range(0.9, 1.1), headY: rng.range(-0.14, 0.14), headP: rng.range(-0.05, 0.11),
      mate: null, talk: 0, grp: 0, leader: null, attn: false, bow: 0, placard: false,
      // build: shoulder width / girth independent of height, so a 1.75 m salaryman and a 1.75 m student differ
      wide: child ? rng.range(0.86, 0.94) : look.old ? rng.range(0.90, 1.02) : fem ? rng.range(0.88, 1.0) : rng.range(0.92, 1.14),
      // a child's head is ~0.9 of an adult's at 0.7-0.8 of the height: the part rig's head is scaled on its own,
      // or a child is an adult shrunk whole
      headK: child && !KID_POOL ? Math.min(1.26, 0.88 / scale) : 1,
      hero: null, stroll: 0, wait: 0, poly: null, box: null, police: false, lean: 0, group: 0,
      // size / tilt / spin per person: 800 canopies at one radius and one pitch is a printed pattern, and it
      // is the first thing the eye picks up in a plan-ish view of the crossing
      umb: rng() < 0.78, umbWet2: rng() < 0.45, blobK: rng.range(0.88, 1.08),
      umbSize: rng.range(0.88, 1.12), umbTilt: rng.range(-0.13, 0.11), umbYaw: rng.range(-0.55, 0.55),
      idlePose: 0, stance: rng() < 0.5 ? 1 : -1,
      // contrapposto: the weight moves from one leg to the other every 6-12 s, out of step with everyone else
      wPer: rng.range(12, 24), wPh: rng() * Math.PI * 2, elb: rng.range(0.25, 0.45),
      moving: false, delay: 0, tx: 0, tz: 0, hurry: 1, lat: 0, baseLat: 0, kerbD: 0, nx: 0, nz: 1,
      gy: 0, gyT: 0, speedK: 1, turn: 0, fade: 1, dfade: 1, fidget: rng.range(0.6, 1.5), fid: rng() * 9,
      seg: 0, t: 0, dir: 1, hx: 0, hz: 0, detX: 0, detZ: 0, vel: 0, queue: null, qSlot: 0,
      shopper: false, doorUser: false, shopT: 0, shopCool: 0, doorT: 0, doorPh: 0,
      // crossing waypoints live in a preallocated buffer: the old [[..],[..]] + push allocated ~2 850 arrays
      // per signal cycle, which is a GC saw-tooth on top of an already tight frame
      wp: kind === 'crosser' ? new Float32Array(6) : null, wpi: 0, wpn: 0,
      // motion state (step / settle / carry / stepWalker, crowdScan.animate), declared here so every pedestrian has
      // one shape: added on first use they made the per-person loops megamorphic (carry was ~300 ns a call)
      cv: -1, _lx: 0, _lz: 0, _ex: 0, _ez: 0, _exU: 0, _ezU: 0, _ey: 0, _eyU: 0, _hy: 0, _hvx: 0, _hvz: 0, _ct: 0, _ctD: 0, _ctU: 0,
      _pX: 0, _pZ: 0, _dX: 0, _dZ: 0, _dOK: 0, _ox: 0, _oz: 0, _half: false, _far: false, _stageHid: 0, _gapF: 1, _snap: 0, _fcX: 1e9, _fcZ: 1e9, _reloc: 0, _runOK: false, _latP: null,
      _wd: 0, _wdF: -1, _sf: 1, _md: null, _mdCw: 0, latPrev: null, latV: 0, ttcSt: 0, _ttc: false,
      vmax: 2.4, _si: 1, _sh: 1.7, _shK: 1, _sv: 0, _ctl: 0, _cB: 1, _wB: 1, _aw: 0, _ap: 0, _run: false,
    };
    for (const c of [ped.cCloth, ped.cSleeve, ped.cLeg, ped.cAcc, ped.cInner]) liftDark(c);
    if (!ped.shinSkin) liftDark(ped.cShin);
    if (!ped.bare) liftDark(ped.cFarm);
    ped.idlePose = idlePoseFor(rng, ped);
    ped.farVar |=(ped.bagKind === 1 ? 1 : 0) | (ped.bagKind === 2 ? 8 : 0) | (ped.hairKind === 1 ? 2 : 0);
    return ped;
  },

  // ------------------------------------------------------------------------------------------------ warm-up
  // run the sim forward at a coarse step so the first frame shows a settled crossing, not a synchronised mass start
  warmup() {
    // Run the city forward to where the signal cycle actually is. Round 4 ran 48 s of constant WALK, so every
    // crosser was mid-shuttle and the crossing was an even 3-6 m scatter with no wave in it. Now everyone starts
    // bunched at the kerbs as after a red, the green man comes on `since` seconds ago, and the waves are exactly
    // as far out as they would be.
    this._warm = true;
    const step = 1 / 15, tr = this.engine.get('traffic');
    let since = 16;
    if (tr && tr.phase === 'scramble' && tr.phaseT != null) since = tr.phaseT;
    else if (tr && typeof tr.cycleT === 'number') since = (((tr.cycleT - SCRAMBLE_AT) % 120) + 120) % 120;
    let t = 0;
    const run = (sig, secs) => { this._sig = sig; for (let e = 0; e < secs; e += step) this.step(step, t += step, true); };
    run('stop', 6);                                   // walkers and strollers smear out; the kerbs settle
    this.wasWalk = false;
    if (since < SCRAMBLE_LEN + 40) {
      run('walk', Math.min(since, SCRAMBLE_LEN - FLASH_LEN));
      if (since > SCRAMBLE_LEN - FLASH_LEN) run('flash', Math.min(since, SCRAMBLE_LEN) - (SCRAMBLE_LEN - FLASH_LEN));
      if (since > SCRAMBLE_LEN) run('stop', since - SCRAMBLE_LEN);
    }
    this._sig = null;
    this._warm = false;
    // the live clock takes over: the wave that is out there started `since` seconds before the first live frame
    this._waveAge = since < SCRAMBLE_LEN ? since : 999;
    this.waveStart = null;
  },

  // ------------------------------------------------------------------------------------------------- update
  update(dt, t, warm) {
    const engine = this.engine;
    if (!engine) return;
    if (warm) { this.step(dt, t, true); return; }
    const t0 = performance.now();
    this.simDt = Math.min(dt, SIM_DT);                      // (read by docs/reports/crowd-motion.mjs)
    this.step(this.simDt, t, false);
    const ms = performance.now() - t0;
    // steady-state cost: the first frames carry the first resort, pool growth and program compiles
    this.liveN = (this.liveN || 0) + 1;
    this.cpuMs = this.liveN < 30 ? ms : this.cpuMs + (ms - this.cpuMs) * 0.05;
    if (this.liveN === 120 && this.scanR) {
      const r = this.scanR.report();
      const hp = (CITY.plazas || []).find(q => q.id === 'hachiko'), inH = (q) => hp && pointInPolygon(q.x, q.z, hp.polygon) && q.dfade > 0.5;
      console.info(`[crowd] cpu ${this.cpuMs.toFixed(2)} ms/frame, scanned crowd: ${r.mid} mid (lod1, ${Math.round(r.midTris / 1000)}k tris) + ${r.far} far (lod2, ${Math.round(r.farTris / 1000)}k tris) + ${r.poolSeen}/${r.pool} pool bodies in view, ${r.refl} mirrored, ~${r.draws} draws; ` +
        `${this.peds.filter(q => q.gawk).length} in the fight ring, Hachiko square ${this.peds.filter(q => inH(q) && q.moving).length} moving / ${this.peds.filter(q => inH(q) && !q.moving).length} standing ${JSON.stringify(r)}`);
    } else if (this.liveN === 120) {
      let tris = 0;
      for (const m of [...this.meshes, this.farRefl]) { const g = m.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3 * m.count; }
      let ht = 0, hb = 0;
      for (const H of this.heroes) if (H.ped) { hb++; ht += H.h.tris || 0; }
      const hp = (CITY.plazas || []).find(q => q.id === 'hachiko'), inH = (q) => hp && pointInPolygon(q.x, q.z, hp.polygon) && q.dfade > 0.5;
      const hw = this.peds.filter(q => inH(q) && q.moving).length, hs = this.peds.filter(q => inH(q) && !q.moving).length;
      console.info(`[crowd] cpu ${this.cpuMs.toFixed(2)} ms/frame, ${this.visible} visible (${hb} pool bodies, ${this.mid} part rig, ${this.far.count} far, ${this.far2.count} far cut), instanced ${Math.round(tris / 1000)}k tris + pool ${Math.round(ht / 1000)}k, ${this.peds.filter(q => q.gawk).length} in the fight ring, Hachiko square ${hw} moving / ${hs} standing`);
    }
  },

  step(dt, t, warm) {
    const engine = this.engine;
    const peds = this.peds, N = this.count, rng = this.rng;
    this.frame++; this.tNow = t;
    const MD = MOTION_DBG && !warm;
    if (MD) { for (let i = 0; i < N; i++) { peds[i]._md = null; peds[i]._mdCw = 0; } this.mdSnap(); }
    const traffic = engine.get('traffic');
    const sig = this._sig || (traffic ? traffic.signal.ped : 'walk');
    const walkNow = sig === 'walk' || sig === 'flash';
    if (this.waveStart == null) this.waveStart = t - (this._waveAge || 0);
    if (walkNow && !this.wasWalk) { this.waveStart = t; this.waveId++; }
    this.wasWalk = walkNow;
    this.spanSignals(dt, sig);
    if (this.fightT > 0) this.fightT -= dt;
    if (this.shockT > 0) this.shockT -= dt;
    if (this.gaspT > 0) this.gaspT -= dt;
    // the ring keeps filling: passers-by who wander within reach of a running fight stop and join the back rows
    if (this.gk && this.gk.on && !warm && (this.gk.t += dt) > 1.2) { this.gk.t = 0; this.recruitGawkers(false); }
    if (!warm) this.fightLens(dt);
    if (!warm && this.scanR && this.scanR.ready && (this.frame % 30 === 0 || this.cutF === this.frame)) this.dedupeScans();

    // gate queues shuffle through: the head walks into the gate and rejoins the tail
    for (let qi = 0; qi < this.queues.length; qi++) {
      const Q = this.queues[qi];
      Q.t -= dt;
      if (Q.t > 0) continue;
      Q.t = 6 + rng() * 5;
      let last = 0;
      for (const q of Q.members) if (q.qSlot > last) last = q.qSlot;
      for (const q of Q.members) {
        if (q.qSlot > 0) { q.qSlot--; continue; }
        // the head walks on through the gate, dissolving, and rejoins the tail out of sight (stepIdler)
        q.qSlot = last; q.qOut = 1;
      }
    }
    if (MD) { this.mdDiff('queue'); }

    if (!warm) {
      this.resortT += dt;
      const cam = engine.camera;
      // (and on a turn of the lens: people who were off-screen step at a quarter rate until the order knows they are not)
      cam.getWorldDirection(_v);
      const turned = this.camFw ? _v.x * this.camFw.x + _v.y * this.camFw.y + _v.z * this.camFw.z < 0.978 : true;
      if (this.resortT > RESORT_T || turned || cam.position.distanceToSquared(this.camAt) > RESORT_D * RESORT_D) this.resort();
    }
    const order = this.order, nVis = this.visible;

    // ---- avoiders: player, live enemies, the preset lens (flat array, no per-frame garbage)
    const av = this.avoid; let na = 0;
    const fighting = engine.state.mode === 'combat' || this.fightT > 0;
    if (!warm) {
      if (engine.player) { av[na++] = engine.player.position.x; av[na++] = engine.player.position.z; av[na++] = fighting ? 6.2 : (engine.player.avoidR || 2.6); av[na++] = 0; }   // (avoidR: wider on a LOOP board at speed)
      const en = engine.get('enemy');
      if (en && en.list) for (const e of en.list) { if (na > 56) break; if (!(e.alive || e.stateT < 8)) continue; av[na++] = e.position.x; av[na++] = e.position.z; av[na++] = fighting ? 4.8 : 2.2; av[na++] = 0; }
    }
    this.nAvoid = na;

    const px = engine.player ? engine.player.position.x : 0, pz = engine.player ? engine.player.position.z : 0;
    // the lens bubble is on whenever the camera is down among the people (not for a plan or a crane view)
    const cam = engine.camera, lx = cam.position.x, lz = cam.position.z;
    const lensOn = !warm && cam.position.y - (engine.world ? engine.world.groundHeight(lx, lz) : 0) < 4.5;
    // the lens's velocity, smoothed; a jump of over 4 m in a frame is a cut, not a walk
    if (!warm && dt > 0) {
      const jx = lx - this.camPX, jz = lz - this.camPZ, jump = Math.hypot(jx, jz);
      if (this.camPX > 1e8 || jump > 4) { this.camVX = 0; this.camVZ = 0; if (this.camPX < 1e8 && !this.scanR) { this.cutFree = 1; this.bindNow = true; } }
      else { const k = Math.min(1, dt * 4); this.camVX += (jx / dt - this.camVX) * k; this.camVZ += (jz / dt - this.camVZ) * k; }
      this.camPX = lx; this.camPZ = lz;
    }
    cam.getWorldDirection(_v);
    const cfl = Math.hypot(_v.x, _v.z) || 1, cfx = _v.x / cfl, cfz = _v.z / cfl;
    const rigBubble = lensOn && !this.heroOff && this.heroes.length > 0;
    // (the scanned people carry no umbrella: rain is demoted, and nobody holds one unless it is raining)
    const umbSeason = !this.scanR && this.umbrella.count > 0 && engine.time.weather === 'rain';
    let inBubble = 0;

    // off-screen slots tick at a quarter rate, the one-draw far body (past DET_D, under ~110 px) at half: the frame
    // share is the budget, and a 40 px body stepping at 30 Hz reads the same
    const nMidS = this.mid || 0, keyD = this.key;
    // everybody's position at the top of the step: what their own walking moved them by is tallied in p._lx / p._lz,
    // everything else (pushes) is limited and turned into steps in settle()
    // (float64: a float32 snapshot rounded everybody's position to it every frame through settle())
    const X0 = this._x0 || (this._x0 = new Float64Array(N)), Z0 = this._z0 || (this._z0 = new Float64Array(N)), DT0 = this._dt0 || (this._dt0 = new Float32Array(N));
    const Y0 = this._y0 || (this._y0 = new Float64Array(N));
    if (!warm && !this.scanR) this.guardExternal();   // (the scanned crowd runs it from its render hook: after every module's update)
    if (!warm) for (let i = 0; i < N; i++) { const p = peds[i]; X0[i] = p.x; Z0[i] = p.z; Y0[i] = p.yaw; DT0[i] = 0; p._lx = 0; p._lz = 0; }
    for (let s = 0; s < N; s++) {
      const i = order[s], p = peds[i];
      const far = s >= nVis;
      // the distance the last sort saw (visible: d; off-screen: 1e6 + d; past the cull: 1e7 + d)
      const kd = keyD[i], dd = warm ? 1e9 : kd >= 1e7 ? kd - 1e7 : kd >= 1e6 ? kd - 1e6 : kd;
      const quarter = far && dd > TICK_OFF_D;
      // (off-screen by the last sort, but the camera may have turned since: carried on like a half-rate frame, below)
      if (quarter && ((i & 3) !== (this.frame & 3))) {
        p._ct += dt;
        if (dd < 50) this.carry(p, dt);
        continue;
      }
      // (a pedestrian wearing a pool body beyond the part-rig band still steps at full rate: the body is posed from it)
      const half = !far && s >= nMidS && !warm && !p.hero && dd > TICK_FULL_D;
      // the frame between two half-rate ticks: carried on at the last tick's velocity (and taken back before the next
      // tick steps), so a body in view moves every frame
      if (half && ((i & 1) !== (this.frame & 1))) {
        p._ct += dt;
        this.carry(p, dt);
        continue;
      }
      // a tick steps the time since this person's last one: the frames it skipped plus this one (2 x this frame's dt
      // stepped a half-rate body faster or slower than the clock as the frame times jittered: 3.2-3.9 m/s frames)
      const sdt = warm ? dt : dt + p._ct;
      p._ctU = p._ctD; p._ct = 0; p._ctD = 0;
      if (!warm) DT0[i] = sdt;
      p._half = half; p._far = far;
      if (p._ex || p._ez) { p.x -= p._ex; p.z -= p._ez; if (!warm) { p._lx -= p._ex; p._lz -= p._ez; } p._exU = p._ex; p._ezU = p._ez; p._ex = p._ez = 0; }
      if (p._ey) { p.yaw -= p._ey; p._eyU = p._ey; p._ey = 0; }
      p.fade = p.dfade; p.blocked = false;
      let mx = p.x, mz = p.z, ml = p.lat || 0;
      const mdT = MD ? (tag) => { this.mdTag(p, tag, Math.hypot(p.x - mx, p.z - mz)); if (p.kind === 'walker') this.mdTag(p, 'lat:' + tag, Math.abs((p.lat || 0) - ml)); mx = p.x; mz = p.z; ml = p.lat || 0; } : null;
      if (MD && sdt > dt) this.mdTag(p, quarter ? 'tick4' : 'tick2', 1);
      let lx0 = p.x, lz0 = p.z;
      const loco = warm ? null : () => { p._lx += p.x - lx0; p._lz += p.z - lz0; };

      // an off-screen slot only needs the avoiders if it is standing next to the player (behind the lens)
      const avOn = !far || (Math.abs(p.x - px) < 8 && Math.abs(p.z - pz) < 8);
      for (let k = 0; avOn && k < na; k += 4) {
        const ar = av[k + 2];
        const dx = p.x - av[k], dz = p.z - av[k + 1];
        const d = Math.hypot(dx, dz);
        if (d >= ar) continue;
        if (p.kind === 'walker') {
          // (held up only by someone ahead in its line of travel: once it has stepped a metre aside it walks on past --
          // it used to stand next to 健人 for as long as he stood still)
          if (!fighting) { const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw), along = -(dx * fx + dz * fz), side = Math.abs(dx * fz - dz * fx); if (along < -0.3 || side > 1.0) continue; }
          p.blocked = true; continue;
        }
        if (d > 1e-3) {
          const kk = (ar - d) * Math.min(1, sdt * 6);
          p.x += dx / d * kk; p.z += dz / d * kk;
          if (!p.stroll && (p.state === 'wait' || p.kind === 'idler')) { p.tx = p.x; p.tz = p.z; turnTo(p, Math.atan2(-dx, -dz), sdt, 5); }
        }
      }
      if (MD) mdT('avoid');
      const canBody = rigBubble && !(umbSeason && p.umb) && p.role !== 2 && poolable(p);
      if (!far && lensOn && !p.stage) inBubble += this.lensFade(p, lx, lz, canBody, umbSeason && p.umb);

      // a recruited onlooker walks to its slot on the ring and watches; everything else about it is frozen
      if (p.gawk) { lx0 = p.x; lz0 = p.z; this.stepGawker(p, sdt, t); if (loco) loco(); if (MD) mdT('gawk'); continue; }
      // nobody else walks through the arena: the ring is a wall, so the rest go round it or wait at its edge
      if (this.gk && this.gk.on) {
        const G = this.gk, dx = p.x - G.x, dz = p.z - G.z, d = Math.hypot(dx, dz), R = G.r + 2.6;
        if (d < R && d > 1e-3) {
          if (p.kind === 'walker') { p.blocked = true; p.ringFace = true; }
          const kk = Math.min(R - d, sdt * 2.2);
          if (p.kind !== 'walker') { p.x += dx / d * kk; p.z += dz / d * kk; if (p.kind === 'idler' && !p.stroll) { p.hx = p.x; p.hz = p.z; } }
        }
      }
      if (MD) mdT('ring');

      // spectate / scatter around a fight
      if (fighting && p.kind !== 'idler' && !(this.gk && this.gk.on)) {
        const d = Math.hypot(p.x - px, p.z - pz);
        if (d < 15 && d > 0.2) {
          if (d < 8.5) {
            // backing off a fight: close in, they run (the run clip, 3.3-4.5 m/s, facing away); further out they walk
            // away at their own pace -- never the old (8.5 - d) x 1.6 m/s, 13 m/s at arm's length
            const vv = d < 6 ? clamp((8.5 - d) * 1.3, 3.3, 4.5) : Math.min(p.vmax || 2.2, (8.5 - d) * 1.6);
            lx0 = p.x; lz0 = p.z;
            turnTo(p, Math.atan2(p.x - px, p.z - pz), sdt, 6);
            p.x -= (px - p.x) / d * vv * sdt; p.z -= (pz - p.z) / d * vv * sdt; p.moving = true; p.vel = vv; advance(p, vv, sdt);
            if (loco) loco(); p._runOK = vv > 3.2;
            if (MD) mdT('scatter'); continue;
          }
          turnTo(p, Math.atan2(px - p.x, pz - p.z), sdt, 4);
          if (p.kind === 'crosser' && p.state === 'wait') { p.moving = false; continue; }
        }
      }

      // missions' talk stage (stageBlock) for everyone off a path: dissolved inside the ring as a walker is (stepWalker0),
      // back in outside it. missions.clearStage shoves them out radially; hidden, that move simply stands (guardExternal)
      // -- visible, it was a person walking out of the shot for seconds, or bound to a pool body at the lens
      if (p.kind !== 'walker' && !p.gawk && !p.queue && !p.stage) {
        const SBk = this.stageBlock;
        if (SBk && (p.x - SBk.x) * (p.x - SBk.x) + (p.z - SBk.z) * (p.z - SBk.z) < SBk.r * SBk.r) {
          p.dfade = this.cutF === this.frame - 1 || this.cutF === this.frame ? 0 : Math.max(0, p.dfade - sdt * 2.5); p._stageHid = 1;
        } else if (p._stageHid) { p.dfade = Math.min(1, p.dfade + sdt * 2); if (p.dfade >= 1) p._stageHid = 0; }
      }
      if (p.stage) { if (p.stage === 2) { p.moving = false; p.vel = 0; continue; } p.moving = true; p.vel = p.speed; advance(p, p.vel, sdt); continue; }
      p._ttc = !far && s < 160;
      const kind0 = p.kind;
      lx0 = p.x; lz0 = p.z;
      if (p.kind === 'crosser') this.stepCrosser(p, sdt, t, sig, walkNow, rng);
      else if (p.kind === 'walker') {
        this.stepWalker(p, sdt, rng);
        if (p._gapF < 1) p.fade = Math.min(p.fade, p._gapF * p._gapF);
        // held up at the edge of the ring: stop and watch rather than stand staring down the street
        if (p.ringFace) { p.ringFace = false; if (!p.moving && this.gk) p.yaw += wrapPi(Math.atan2(this.gk.x - p.x, this.gk.z - p.z) - p.yaw) * Math.min(1, sdt * 2.5); }
      }
      else this.stepIdler(p, sdt, t);
      if (loco) loco();
      if (MD) { mdT(kind0 === 'crosser' ? 'crosserWp' : kind0 === 'walker' ? 'pathWalk' : 'idler'); if (kind0 !== p.kind) this.mdTag(p, 'kindSwitch', 1); }

      // the lens bubble's side-step is the person walking aside (a crosser's is a detour of its walk line)
      lx0 = p.x; lz0 = p.z;
      if (!far && lensOn) this.lensPush(p, sdt, lx, lz, canBody, cfx, cfz);
      if (loco) loco();
      if (MD) mdT('lensPush');
      // 健人's personal space (PERSONAL_R) and, in a fight, the lens's lines of sight to him and his enemies: whoever is in
      // them steps out -- walked, at up to his pace (the gallery slides round its ring instead: stepGawker)
      if (!warm && !p.stage && !p.gawk && p.dfade > 0 && engine.player) {
        const O = this._co || (this._co = [0, 0]), pp = engine.player.position, dx = p.x - pp.x, dz = p.z - pp.z;
        O[0] = O[1] = 0;
        const avx = engine.player.avoidR ? engine.player.avoidR - 2.6 : 0;          // (LOOP rider: reach and ring grow with speed)
        if (Math.abs(dx) < 3 + avx * 2 && Math.abs(dz) < 3 + avx * 2) {
          // (from where he will be in 0.4 s, so someone he walks at steps aside before he is on them)
          const pv0 = engine.player.velocity, ax = dx - (pv0 ? pv0.x * 0.4 : 0), az = dz - (pv0 ? pv0.z * 0.4 : 0);
          const d = Math.min(Math.hypot(dx, dz), Math.hypot(ax, az)), R = PERSONAL_R + 0.6 + avx * 0.6, ux = Math.hypot(ax, az) < Math.hypot(dx, dz) ? ax : dx, uz = Math.hypot(ax, az) < Math.hypot(dx, dz) ? az : dz, ul = Math.hypot(ux, uz);
          if (d < R) { if (ul > 1e-3) { O[0] = ux / ul * (R - d); O[1] = uz / ul * (R - d); } else { O[0] = R; } }
          if (d < R && p.shopT > 0) { p.shopT = 0; p.shopCool = 12; p.shopFace = null; }     // (the window can wait)
        }
        if (this._corN && Math.abs(p.x - this._cor[0]) < 45 && Math.abs(p.z - this._cor[1]) < 45) { const Q = this.corridorOut(p.x, p.z, LENS_W, this._co2 || (this._co2 = [0, 0])); O[0] += Q[0]; O[1] += Q[1]; }
        if (O[0] || O[1]) {
          const pv = engine.player.velocity, ps = pv ? Math.hypot(pv.x, pv.z) : 0;
          lx0 = p.x; lz0 = p.z;
          this.stepAside(p, O[0], O[1], sdt, Math.min(VCAP, Math.max(1.4, ps + 0.8)), pp.x, pp.z);
          if (loco) loco();
          if (MD) mdT('personal');
        }
      }
      // ---- traffic safety. Cheap and in that order: a pedestrian who never stands in the carriageway
      // cannot be run over, so keeping them on the pavement does most of the work and the per-car push-out
      // below only has to catch the ones legitimately on a crossing.
      this.keepOffRoad(p, sdt);
      // standing people are kept FRONT_CLEAR off the shop glass, eased out at a shuffle with their spot / home
      if (p.kind !== 'walker' && !p.gawk && !p.stage && (p.kind === 'idler' || p.state === 'wait')) {
        // (re-checked once they have moved 0.3 m since they were last found clear)
        const fc = Math.abs(p.x - p._fcX) + Math.abs(p.z - p._fcZ) > 0.3 ? this.frontFn() : null, fcv = fc ? fc(p.x, p.z) : Infinity;
        if (fc && !(fcv < FRONT_CLEAR)) { p._fcX = p.x; p._fcZ = p.z; }
        if (fc && fcv < FRONT_CLEAR) {
          const fo = this.frontOut(p.x, p.z, FRONT_CLEAR);
          // (never off the pavement: near a kerb, straight out from the glass is into the road)
          if (fo) { const dx = fo[0] - p.x, dz = fo[1] - p.z, d = Math.hypot(dx, dz); if (d > 1e-4) { const m = Math.min(d, SEP_STILL_V * sdt) / d; if (!this.field || this.field.sample(p.x + dx * m, p.z + dz * m) >= 0.4 || this.field.sample(p.x, p.z) < 0.4) { p.x += dx * m; p.z += dz * m; p.hx += dx * m; p.hz += dz * m; if (p.state === 'wait' && !p.toSpot) { p.tx += dx * m; p.tz += dz * m; } } } }
        }
      }
      if (MD) mdT('keepOffRoad');
      // furniture: people on the move are checked every other frame, people standing until they are clear
      if (!p.gawk && !(p.kind === 'crosser' && p.state === 'cross')) {
        if (!p.moving) { if (!p.obsOK) this.obstaclePush(p, true, sdt); }
        else if (((this.frame + p.index) & 1) === 0) this.obstaclePush(p, false, sdt * 2);
      }
      if (MD) mdT('obstaclePush');
    }
    if (MD) this.mdSnap();
    this.pushOutOfCars();
    if (MD) this.mdDiff('pushOutOfCars');
    this.inBubble = inBubble;

    if (!warm) {
      // The governor is a seatbelt, not a throttle. A 19.5 ms shrink point sits ON a 60 fps frame time, so on
      // any frame the rest of the scene ran long -- which at day_crossing is most of them, 42 fps with 4.5 ms
      // of render -- it walked the pool straight down to LOD0_MIN and parked there. That is the crowd paying
      // for somebody else's CPU with the only bodies in the frame that read as people. The window is now
      // 26 ms (~38 fps) down / 21 ms (~48 fps) up, so it only gives ground when the frame is genuinely in
      // trouble, and it climbs back twice as fast as it falls.
      const ms = dt * 1000;
      this.frameMs += (ms - this.frameMs) * 0.08;
      this.budgetT = (this.budgetT || 0) + dt;
      if (this.budgetT > 0.35) {
        const floor = this.combatBudget && this.combatBudget.lod0 ? Math.max(LOD0_MIN, this.combatBudget.lod0) : LOD0_MIN;
        if (this.frameMs > 26) { this.heroBudget = Math.max(floor, this.heroBudget - 1); this.budgetT = 0; }
        else if (this.frameMs < 21) { this.heroBudget = Math.min(this.scanR && !SCAN_POOL_OLD ? SCAN_LOD0_CAP : LOD0_BIND, this.heroBudget + 2); this.budgetT = 0; }
      }
      // between re-sorts too (every 0.1 s): a prospect is bound the moment it is out of view, not up to 0.38 s later,
      // or it has walked into the frame by then
      if (this.frame % 6 === 0 || this.bindNow) { this.bindNow = false; this.bindHeroes(); }
      if (MD) this.mdSnap();
      this.separate(dt);
      this.settle(dt);
      if (this.scanR) {
        // the scanned crowd: instances packed per frame, the pool bodies posed from their twins' clips
        this.scanR.update(dt, t);
        this.writeBikes();
        this.scanR.growPool();
      } else {
        this.writeMatrices(t);
        this.writeBikes();
        this.growHeroes();                        // the whole pool at boot; after that only a denied key, throttled
        this.updateHeroes(t);
      }
    }
  },

  // The lens bubble (LENS_RIG / LENS_MIN / LENS_CUT). lensFade runs for every visible slot before it moves: a body
  // without a pool twin dissolves across the band inside LENS_RIG (if it could have had one), and nobody at all is
  // drawn inside LENS_CUT. Returns 1 for a body inside the rig bubble that is waiting for a pool twin.
  lensFade(p, lx, lz, canBody, umbUp) {
    if (p.hero) return 0;
    const d = Math.hypot(p.x - lx, p.z - lz);
    if (d >= LENS_RIG) return 0;
    // an open canopy reaches ~0.6 m out from its holder at head height: it goes before the holder is at arm's length
    const cut = umbUp ? LENS_CUT + 2.0 : LENS_CUT;
    const a = canBody ? LENS_RIG - LENS_FADE : cut, b = canBody ? LENS_RIG : cut + (umbUp ? 1.4 : 0.8);
    p.fade = Math.min(p.fade, clamp((d - a) / (b - a), 0, 1));
    return canBody ? 1 : 0;
  },

  // ...and lensPush after it has moved. The radius depends on what the lens would see: a body without a pool twin
  // LENS_RIG (it dissolves inside it), a pool body facing the lens LENS_FACE, one seen from behind LENS_MIN.
  //   pavement walkers: path-bound, their lane drifts off the side the camera is on
  //   crossers out on the scramble: a detour round the lens, the way they go round a car's bumper
  //   people standing (kerb waiters, idlers, touts): nudged 0.6-1.2 m sideways, off the camera's forward axis only
  //     -- round 3 re-seated them on the bubble's rim, which ringed the player with people standing on a circle.
  //     The nudge is measured from where they first stood, so it never accumulates, and is undone once the camera
  //     is 9 m away. A queue file and an officer on post hold their ground.
  lensPush(p, dt, lx, lz, canBody, fx, fz) {
    if (p.stage || p.gawk || p.queue || p.police) return;
    const dx = p.x - lx, dz = p.z - lz, d = Math.hypot(dx, dz);
    if (d > 9) {
      if (p.hx0 != null) { p.hx = p.hx0; p.hz = p.hz0; p.hx0 = null; }
      p.kx0 = null;
      return;
    }
    if (d < 1e-3) return;
    const facing = -(Math.sin(p.yaw) * dx + Math.cos(p.yaw) * dz) > 0.25 * d;
    const R = p.hero ? (facing ? LENS_FACE : LENS_MIN) : canBody ? LENS_RIG + 0.3 : LENS_MIN;
    if (d >= R + 1.5) return;
    const ux = dx / d, uz = dz / d;
    if (p.kind === 'walker') {
      if (!p.moving || p.turn > 0 || !p.path) return;
      const ahead = -(dx * Math.sin(p.yaw) + dz * Math.cos(p.yaw)), side = -(dx * p.nx + dz * p.nz);
      if (ahead < -0.6 || Math.abs(side) > R) return;
      const half = p.path.width / 2 - 0.2;
      p.lat = clamp(p.lat - (side >= 0 ? 1 : -1) * 1.6 * dt, -half, half);
      return;
    }
    if (p.kind === 'crosser' && p.state === 'cross') {
      p.kx0 = null;
      // a pool body coming at the lens face-on detours from 4.5 m at a brisker pace (fix round 1: one reached 3 m
      // with its painted face on the lens; the far side of 4 m is where that face still holds)
      const heroFace = p.hero && facing, Rc = heroFace ? Math.min(R, 4.5) : R;
      if (d >= Rc) return;
      // a detour of the walk line (steering), not a shove: the step itself stays at the walker's own pace
      const k = Math.min(Rc - d, (heroFace ? 2.1 : 1.4) * dt);
      p.detX = clamp(p.detX + ux * k * 6, -3, 3); p.detZ = clamp(p.detZ + uz * k * 6, -3, 3);
      return;
    }
    if (!(p.kind === 'idler' || (p.kind === 'crosser' && p.state === 'wait'))) return;
    const along = dx * fx + dz * fz;
    if (d >= R || along < -0.3) return;
    if (p.stroll) {
      const tx = p.tx - lx, tz = p.tz - lz;
      if (tx * tx + tz * tz < R * R && tx * fx + tz * fz > 0) this.strollTarget(p);
      return;
    }
    // the sideways nudge: a person-specific 0.6-1.2 m, to whichever side of the axis they already stand on
    const m = 0.6 + 0.6 * ((p.index * 0.6180339) % 1);
    const kerb = p.kind === 'crosser';
    if (kerb) { if (p.kx0 == null) { p.kx0 = p.x; p.kz0 = p.z; } } else if (p.hx0 == null) { p.hx0 = p.hx; p.hz0 = p.hz; }
    const x0 = kerb ? p.kx0 : p.hx0, z0 = kerb ? p.kz0 : p.hz0, hl = (x0 - lx) * fz - (z0 - lz) * fx;
    const sd = Math.abs(hl) > 0.05 ? Math.sign(hl) : (p.index & 1 ? 1 : -1);
    const gx = x0 + fz * sd * m, gz = z0 - fx * sd * m;
    if (!kerb) { p.hx = gx; p.hz = gz; if (!p.role) { p.tx = gx; p.tz = gz; } }
    const tx = gx - p.x, tz = gz - p.z, td = Math.hypot(tx, tz);
    if (td < 0.05) return;
    const k = Math.min(td, 1.1 * dt);
    p.x += tx / td * k; p.z += tz / td * k;
    p.obsOK = false;
    if (k > 0.35 * dt) {
      // a side-step, not a turn-and-walk: the body keeps most of its heading
      const v = k / dt;
      p.moving = true; p.vel = v; advance(p, v, dt);
      p.yaw += wrapPi(Math.atan2(tx, tz) - p.yaw) * Math.min(1, dt * 1.2);
    }
  },

  // Street furniture as obstacles: vending machines, bike racks, benches, planters, bins, kerbside boxes, trees
  // and poles (the physics statics tagged prop / tree / pole within 140 m), plus a 1.2 m disc in front of every
  // vending machine and shopfront light, which only standing people avoid: nobody waits inside a hot spot, and
  // nobody stands inside the parked bicycles by the koban. A 4 m grid, built once.
  buildObstacles() {
    const w = this.engine.world, OB = [], cx0 = this.center[0], cz0 = this.center[1];
    const OC = 4, ON = 72, half = OC * ON / 2;
    const cells = new Array(ON * ON);
    const add = (o, x0, z0, x1, z1) => {
      const i = OB.length; OB.push(o);
      const a = Math.max(0, ((x0 - 0.6 - cx0 + half) / OC) | 0), b = Math.min(ON - 1, ((x1 + 0.6 - cx0 + half) / OC) | 0);
      const c = Math.max(0, ((z0 - 0.6 - cz0 + half) / OC) | 0), d = Math.min(ON - 1, ((z1 + 0.6 - cz0 + half) / OC) | 0);
      for (let gz = c; gz <= d; gz++) for (let gx = a; gx <= b; gx++) (cells[gz * ON + gx] || (cells[gz * ON + gx] = [])).push(i);
    };
    for (const sh of (w && w.statics) || []) {
      if (sh.tag !== 'prop' && sh.tag !== 'tree' && sh.tag !== 'pole') continue;
      if (sh.min.y > 1.2 || sh.max.x - sh.min.x > 9 || sh.max.z - sh.min.z > 9) continue;
      if (Math.abs(sh.min.x - cx0) > half - 4 || Math.abs(sh.min.z - cz0) > half - 4) continue;
      add({ sh }, sh.min.x, sh.min.z, sh.max.x, sh.max.z);
    }
    const props = this.engine.get('props'), city = this.engine.get('city');
    for (const l of (props && props.lights) || []) {
      const P = l.position; if (!P || !(l.distance < 3)) continue;
      // a vending face light reaches 2.2 m: nobody stands anywhere inside it
      const r = Math.max(1.2, l.distance || 2.2);
      add({ disc: 1, x: P.x, z: P.z, r }, P.x - r, P.z - r, P.x + r, P.z + r);
    }
    for (const f of (city && city.facades) || []) {
      if (f.kind !== 'shop' || !f.position || !f.normal) continue;
      const x = f.position.x + f.normal.x * 1.6, z = f.position.z + f.normal.z * 1.6;
      if (Math.abs(x - cx0) > half - 4 || Math.abs(z - cz0) > half - 4) continue;
      // (shop: 1 -- a window shopper or a pair standing at the frontage may stand in the shop's light; the disc
      // only marks them inLight, which shrinks and lightens their ground decal)
      add({ disc: 1, shop: 1, x, z, r: 1.2 }, x - 1.2, z - 1.2, x + 1.2, z + 1.2);
    }
    // the koban's three police bicycles: props.js parks them off its front with no colliders (same layout here)
    const hp = (CITY.plazas || []).find(q => q.id === 'hachiko');
    if (hp && hp.koban) {
      const [kx, kz] = hp.koban.pos, kry = Math.atan2(Math.cos(hp.koban.rotY), -Math.sin(hp.koban.rotY));
      for (let k = 0; k < 3; k++) {
        const t = 1.2 + k * 0.62, x = kx + Math.sin(kry) * 3.2 + Math.cos(kry) * t, z = kz + Math.cos(kry) * 3.2 - Math.sin(kry) * t;
        add({ disc: 1, x, z, r: 0.85 }, x - 0.85, z - 0.85, x + 0.85, z + 0.85);
      }
    }
    this.obs = { OB, cells, OC, ON, half };
  },

  // push p out of the furniture around it; `standing` also honours the light discs
  obstaclePush(p, standing, dt) {
    const O = this.obs; if (!O) return;
    const gx = ((p.x - this.center[0] + O.half) / O.OC) | 0, gz = ((p.z - this.center[1] + O.half) / O.OC) | 0;
    if (gx < 0 || gz < 0 || gx >= O.ON || gz >= O.ON) { p.obsOK = true; return; }
    const list = O.cells[gz * O.ON + gx]; if (!list) { p.obsOK = !p.moving; return; }
    // somebody standing keeps an arm's length off the furniture: nobody waits hugging a vending machine's face
    const R = 0.30 * p.scale + 0.04 + (standing ? 0.55 : 0);
    const atShop = p.shopT > 0 || p.atShop;
    if (standing) p.inLight = 0;
    let px = 0, pz = 0;
    for (let k = 0; k < list.length; k++) {
      const o = O.OB[list[k]];
      let nx, nz, pen;
      if (o.disc) {
        if (!standing) continue;
        const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz);
        if (d >= o.r) continue;
        if (o.shop && atShop) { p.inLight = 1; continue; }
        pen = o.r - d; nx = d > 1e-3 ? dx / d : 1; nz = d > 1e-3 ? dz / d : 0;
      } else {
        const sh = o.sh;
        if (p.x + R < sh.min.x || p.x - R > sh.max.x || p.z + R < sh.min.z || p.z - R > sh.max.z) continue;
        let lx, lz, hx, hz, c = 1, s = 0, ox, oz;
        if (sh.kind === 'obb') { ox = sh.center.x; oz = sh.center.z; c = sh.c; s = sh.s; hx = sh.half.x; hz = sh.half.z; }
        else { ox = (sh.min.x + sh.max.x) / 2; oz = (sh.min.z + sh.max.z) / 2; hx = (sh.max.x - sh.min.x) / 2; hz = (sh.max.z - sh.min.z) / 2; }
        const dx = p.x - ox, dz = p.z - oz;
        lx = c * dx - s * dz; lz = s * dx + c * dz;
        const qx = clamp(lx, -hx, hx), qz = clamp(lz, -hz, hz);
        let ex = lx - qx, ez = lz - qz, d = Math.hypot(ex, ez);
        if (d >= R) continue;
        if (d < 1e-4) {                                       // centre inside: leave by the nearest face
          const fx = hx - Math.abs(lx), fz = hz - Math.abs(lz);
          if (fx < fz) { ex = Math.sign(lx) || 1; ez = 0; pen = fx + R; } else { ex = 0; ez = Math.sign(lz) || 1; pen = fz + R; }
          d = 1;
        } else pen = R - d;
        const lnx = ex / d, lnz = ez / d;
        nx = c * lnx + s * lnz; nz = -s * lnx + c * lnz;
      }
      px += nx * pen; pz += nz * pen;
    }
    p.obsOK = !p.moving && Math.abs(px) + Math.abs(pz) < 0.01;
    if (!px && !pz) return;
    const k = Math.min(1, dt * 8);
    if (p.kind === 'walker' && !p.gawk && p.path) {
      const half = p.path.width / 2 - 0.2;
      p.lat = clamp(p.lat + (px * p.nx + pz * p.nz) * k, -half, half);
      if (!p.moving) p.shopLat = p.lat;
      return;
    }
    p.x += px * k; p.z += pz * k;
    if (p.kind === 'idler' && !p.gawk) { p.hx = p.x; p.hz = p.z; if (!p.stroll) { p.tx = p.x; p.tz = p.z; } }
    else if (p.state === 'wait') { p.tx = p.x; p.tz = p.z; }
  },

  // A pedestrian belongs on the pavement. Crossers on a crosswalk are the exception, and only while the
  // pedestrian signal lets them be there. Everyone else is steered back toward the kerb using the street
  // module's signed-distance field (>0 = pavement), which is one lookup per person per frame.
  keepOffRoad(p, dt) {
    const f = this.field; if (!f) return;
    if (p.kind === 'crosser' && p.state !== 'wait') return;      // legitimately out there on a crossing
    if (p.onSpan) return;                                         // a walker on a crosswalk, on its green
    const d = f.sample(p.x, p.z);
    if (d >= 0.35) return;                                        // safely on the pavement
    const e = 0.7;                                                // gradient points back toward the kerb
    const gx = f.sample(p.x + e, p.z) - f.sample(p.x - e, p.z);
    const gz = f.sample(p.x, p.z + e) - f.sample(p.x, p.z - e);
    const g = Math.hypot(gx, gz);
    if (g < 1e-4) return;
    const k = Math.min(2.6, (0.35 - d) * 4) * dt;
    p.x += (gx / g) * k; p.z += (gz / g) * k;
    if (p.tx !== undefined && Math.hypot(p.tx - p.x, p.tz - p.z) < 1.5) { p.tx = p.x; p.tz = p.z; }
  },

  // Anyone still overlapping a vehicle is shoved clear of it. Iterating cars near the camera and testing the
  // crowd against those is cheaper than testing every person against every car, and it catches the case a
  // character-side test cannot: the car driving into somebody who is standing still.
  pushOutOfCars() {
    const tr = this.engine.get('traffic');
    if (!tr || !tr.cars || !tr.cars.length) return;
    const cam = this.engine.camera.position;
    // Only a body that can be ON the carriageway is tested: crossers out on a crossing and the fight ring.
    // keepOffRoad holds everyone else on the pavement. They are binned into a 4 m grid once a frame and each car
    // only visits the cells under its own footprint: 650 crossers against every car within 90 m was 0.65-0.85 ms.
    const head = this.rHead, next = this.rNext, peds = this.peds;
    head.fill(-1);
    let any = 0;
    for (let k = 0; k < this.count; k++) {
      const p = peds[k];
      if (!(p.gawk || p.onSpan || (p.kind === 'crosser' && p.state !== 'wait'))) continue;
      const gx = ((p.x + RG_HALF) / RG_CELL) | 0, gz = ((p.z + RG_HALF) / RG_CELL) | 0;
      if (gx < 0 || gz < 0 || gx >= RG_N || gz >= RG_N) continue;
      const ci = gz * RG_N + gx;
      next[k] = head[ci]; head[ci] = k; any = 1;
    }
    if (!any) return;
    for (let i = 0; i < tr.cars.length; i++) {
      const c = tr.cars[i];
      if (Math.abs(c.x - cam.x) > 90 || Math.abs(c.z - cam.z) > 90) continue;
      // local x below is (cos yaw, -sin yaw) — the car's SIDE — so the half-WIDTH goes on it and the half-length on
      // local z, the way the car drives. (It was the other way round: every box turned 90°, same bug as traffic's.)
      const hw = c.w * 0.5 + 0.30, hd = c.l * 0.5 + 0.30;         // margin covers bumpers and mirrors
      const reach = hw + hd;
      const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
      const x0 = Math.max(0, ((c.x - reach + RG_HALF) / RG_CELL) | 0), x1 = Math.min(RG_N - 1, ((c.x + reach + RG_HALF) / RG_CELL) | 0);
      const z0 = Math.max(0, ((c.z - reach + RG_HALF) / RG_CELL) | 0), z1 = Math.min(RG_N - 1, ((c.z + reach + RG_HALF) / RG_CELL) | 0);
      for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
        for (let k = head[gz * RG_N + gx]; k >= 0; k = next[k]) {
          const p = peds[k];
          const dx = p.x - c.x, dz = p.z - c.z;
          const lx = cs * dx - sn * dz, lz = sn * dx + cs * dz;
          if (lx > hw || lx < -hw || lz > hd || lz < -hd) continue;
          const ox = hw - Math.abs(lx), oz = hd - Math.abs(lz);     // leave by the nearest face
          let nlx = lx, nlz = lz;
          if (ox < oz) nlx = (lx < 0 ? -hw : hw); else nlz = (lz < 0 ? -hd : hd);
          p.x = c.x + cs * nlx + sn * nlz;
          p.z = c.z - sn * nlx + cs * nlz;
          if (c.speed > 2) { p.tx = p.x; p.tz = p.z; p.moving = true; }
        }
      }
    }
  },

  // The front rank steps off on the green man and the back of a 4 m deep kerb crowd follows within ~2 s, so the
  // kerb empties as ONE wave instead of trickling out over four seconds.
  // Round 5 emptied a 4 m kerb in 2.2 s and the wave crossed as one wall at one depth. The back of the crowd now
  // takes up to ~6 s to get moving, which with the skewed paces smears the wave into streams.
  kerbDelay(p, rng) { return clamp(p.kerbD / 2.2, 0, 4.5) + rng.range(0, 1.5); },

  // a crossing from this corner, by weight -- with (tLeft, v), only among those finished within tLeft seconds at v m/s
  // (-1: none is)
  pickLink(corner, rng, tLeft, v) {
    const opts = this.linksOf[corner], ok = (li) => tLeft == null || Math.hypot(this.links[li].bx - this.links[li].ax, this.links[li].bz - this.links[li].az) <= tLeft * v;
    let tw = 0;
    for (let k = 0; k < opts.length; k++) if (ok(opts[k])) tw += this.links[opts[k]].wt;
    if (!(tw > 0)) return tLeft == null ? opts[opts.length - 1] : -1;
    let r = rng() * tw, last = -1;
    for (let k = 0; k < opts.length; k++) { if (!ok(opts[k])) continue; last = opts[k]; r -= this.links[opts[k]].wt; if (r <= 0) return opts[k]; }
    return last;
  },

  // Over the far kerb: turn round to face the crossing again (+/-25 deg), a fifth of them toward the person
  // beside them, talking. A few who got across early go straight back, so the road never quite empties.
  arrive(p, t, walkNow, rng) {
    // over at the Hachiko corner, half of them carry on into the square (chosen at launch, so the last waypoint
    // was already the route's mouth and nobody jumps)
    if (p.plazaNext) { const P = p.plazaNext; p.plazaNext = null; this.toPlaza(p, P, rng, P.lo0 > 0.3 ? P.lo0 : 0.3, 1, p.plazaLat); return; }
    p.faceYaw = Math.atan2(this.center[0] - p.x, this.center[1] - p.z) + rng.range(-0.44, 0.44);
    p.chat = rng() < 0.22 ? 1 : 0;
    if (p.chat) p.faceYaw += (rng() < 0.5 ? 1 : -1) * rng.range(0.9, 1.4);
    const since = t - (this.waveStart || 0);
    if (walkNow && since < SCRAMBLE_LEN - FLASH_LEN - 14 && rng() < 0.16) { p.wave = -1; p.delay = since + rng.range(0.6, 3.5); }
  },

  // put a waiting crosser on a crosswalk: waypoints kerb -> kerb -> a waiting spot on the far side
  launch(p, li, lane, rng, lead) {
    const L = this.links[li], fwd = L.ca === p.corner;
    const ax = fwd ? L.ax : L.bx, az = fwd ? L.az : L.bz, bx = fwd ? L.bx : L.ax, bz = fwd ? L.bz : L.az;
    const dx = bx - ax, dz = bz - az, dl = Math.hypot(dx, dz) || 1;
    const qx = -dz / dl, qz = dx / dl;
    const wp = p.wp;
    wp[2] = bx + qx * lane; wp[3] = bz + qz * lane;
    // Step onto the scramble from where you stand: the first waypoint is where the straight line from here to the
    // far kerb enters the crossing, not the crosswalk's painted mouth. Round 5 walked the whole kerb crowd sideways
    // to the mouth first, which is the dark wall at one depth along the kerb the critic caught.
    {
      const R0 = CITY.crossing.radius - 1.0, cx = this.center[0], cz = this.center[1];
      const sx = p.x - cx, sz = p.z - cz, ex = wp[2] - p.x, ez = wp[3] - p.z;
      const A = ex * ex + ez * ez, Bq = 2 * (sx * ex + sz * ez), Cq = sx * sx + sz * sz - R0 * R0;
      let tt = 0;
      if (Cq > 0 && A > 1e-6) { const D = Bq * Bq - 4 * A * Cq; if (D > 0) tt = clamp((-Bq - Math.sqrt(D)) / (2 * A), 0, 1); }
      if (tt > 0) { wp[0] = p.x + ex * tt; wp[1] = p.z + ez * tt; }
      else { wp[0] = ax + qx * lane; wp[1] = az + qz * lane; if (Math.hypot(wp[0] - p.x, wp[1] - p.z) > 6) { wp[0] = p.x + ex * 0.05; wp[1] = p.z + ez * 0.05; } }
      // ...but the step off the kerb lands on the crosswalk (2026-09-25, the pedestrian signals): whoever stands in
      // front of the stripes still steps straight on; whoever waits off to the side of them (the corner's kerb crowd
      // spans the corner) first goes along the kerb to the stripes' edge instead of cutting across the road's mouth.
      // The keep-left lanes run up to 1.3 m beside the stripes; the mouth is held to the stripes + 1.0 m.
      const ux = dx / dl, uz = dz / dl, lim = (L.w || 8) / 2 + 1.0;
      const la = (p.x - ax) * qx + (p.z - az) * qz;
      if (Math.abs(la) > lim) {
        const m = clamp(la, -lim, lim);
        wp[0] = ax + qx * m + ux * 0.9; wp[1] = az + qz * m + uz * 0.9;
      } else {
        // standing in front of the stripes: the first waypoint may still not wander past their edge
        const wa = (wp[0] - ax) * qx + (wp[1] - az) * qz;
        if (Math.abs(wa) > lim + 0.3) { const m = clamp(wa, -lim, lim), al = (wp[0] - ax) * ux + (wp[1] - az) * uz; wp[0] = ax + qx * m + ux * al; wp[1] = az + qz * m + uz * al; }
      }
    }
    p.dest = fwd ? L.cb : L.ca; p.link = li;
    if (lead) { p.tx = lead.tx + qx * (lane - lead.lane); p.tz = lead.tz + qz * (lane - lead.lane); p.kerbD = lead.kerbD; }
    else this.waitSpot(p, p.dest, rng);
    p.plazaNext = null;
    if (this.plazaRoutes && p.dest === this.hkCorner && !p.bike && (lead ? lead.plazaNext : rng() < 0.55)) {
      const P = lead ? lead.plazaNext : this.pickRoute(rng), hw = P.width / 2 - 0.3;
      p.plazaNext = P; p.plazaLat = lead ? clamp(lead.plazaLat + (lane - lead.lane), -hw, hw) : rng.range(-hw, hw);
      const q = this.pathPoint(P, P.lo0 > 0.3 ? P.lo0 : 0.3, p.plazaLat);   // (past the route's tail in the box)
      p.tx = q[0]; p.tz = q[1];
    }
    if (!p.plazaNext) this.spotOnPavement(p);          // (a companion's spot beside its leader can land in a road mouth)
    wp[4] = p.tx; wp[5] = p.tz;
    p.lane = lane;
    p.wpn = 3; p.wpi = 0; p.state = 'cross'; p.hurry = 1; p.kx0 = null; p.stWp = -1;
    p.wave = this.waveId; p.chat = 0; p.faceYaw = null;
    p.delay = this.kerbDelay(p, rng);        // for the next green man, from the kerb depth over there
  },

  stepCrosser(p, dt, t, sig, walkNow, rng) {
    if (p.state === 'wait') {
      p.moving = false; p.vel = 0;
      const cv0 = p.cv || 0; p.cv = 0;
      p.phase += p.cadence * dt * 0.09;          // keeps phases drifting apart through the red; never reset on launch
      // a group member steps off when its leader does
      const Ld = p.leader, led = Ld && Ld.kind === 'crosser' && Ld.corner === p.corner;
      // one crossing per green man: the ones who have just come over wait for the next wave. A few who missed
      // the green run for it on the flashing man.
      const since = t - (this.waveStart || 0);
      const go = !led && p.wave !== this.waveId && ((sig === 'walk' && since > p.delay) || (sig === 'flash' && p.late && since > p.delay));
      if (!go) {
        // walk up to the waiting spot (a square walker who has just come to the kerb); a shove from the crowd
        // just moves the spot
        const ddx = p.tx - p.x, ddz = p.tz - p.z, dd = Math.hypot(ddx, ddz);
        if (dd > 0.35 && p.toSpot) {
          // (eased in and braked into the spot: it was full pace to a dead stop 0.7 m short)
          p.cv = cv0;
          const v = accel(p, Math.min(p.speed * 0.8, Math.sqrt(2 * ACC_DN * 0.8 * Math.max(0, dd - 0.3))), dt);
          if (v > 0.12 || dd > 0.7) {
            p.x += ddx / dd * v * dt; p.z += ddz / dd * v * dt;
            turnTo(p, Math.atan2(ddx, ddz), dt, 5);
            p.moving = true; p.vel = v; advance(p, v, dt);
            return;
          }
          p.cv = 0;
        }
        p.toSpot = false; p.tx = p.x; p.tz = p.z;
        if (p.faceYaw != null) p.yaw += wrapPi(p.faceYaw - p.yaw) * Math.min(1, dt * 1.4);
        return;
      }
      {
        if (!this.linksOf[p.corner].length) return;
        // Nobody starts a crossing they cannot finish before the red man (3 s of grace) -- late starters were ~450 people
        // still on the road when the vehicles got their green. The crossing is chosen among those they CAN finish, at
        // up to a brisker pace than their own (x1.15, within their stride: p.vmax): the rule used to be applied after a
        // random pick, and a slow walker (0.9-1.2 m/s) who drew a 45-60 m diagonal could never finish it, so it stood
        // at the kerb through the whole green -- about half of the waiting crowd, 2026-09-27 (client: 「歩行者用の信号が
        // 青になったら歩行者が横断歩道を渡れるようにして」). Only someone for whom no crossing is short enough waits.
        const members = p.members ? p.members.filter((q) => q.kind === 'crosser' && q.state === 'wait' && q.corner === p.corner) : null;
        let vGo = Math.min((p.vmax || 2.4) * 0.97, p.speed * 1.15);
        if (members) for (const q of members) vGo = Math.min(vGo, (q.vmax || 2.4) * 0.97, q.speed * 1.15);   // (company keeps together)
        const li = this.pickLink(p.corner, rng, SCRAMBLE_LEN + 3 - since, vGo);
        if (li < 0) { p.wave = this.waveId; return; }
        const L = this.links[li], half = L.w * 0.5, need = Math.hypot(L.bx - L.ax, L.bz - L.az) / Math.max(0.1, SCRAMBLE_LEN + 3 - since);
        // spread across the full painted width, then bias to the walker's left so opposing streams shear past
        const fwd = L.ca === p.corner;
        const lane = clamp(rng.range(-half, half) * 0.92 + (fwd ? 1 : -1) * L.w * 0.20, -half - 1.3, half + 1.3);
        this.launch(p, li, lane, rng, null);
        // (a pace above their own, when the crossing asks for it)
        if (need > p.speed) p.hurry = Math.max(p.hurry, need / p.speed);
        if (sig === 'flash') p.hurry = Math.max(p.hurry, 1.7);
        if (members) for (const q of members) {
          this.launch(q, li, clamp(lane + q.slot, -half - 1.3, half + 1.3), rng, p);
          q.hurry = Math.max(p.hurry, need / Math.max(0.3, q.speed));
        }
      }
      return;
    }
    // Nobody steps off on a red man: a crosser still on the kerb (first waypoint not reached) when the walk ends
    // waits for the next green instead of pushing into the stream coming off the road. They used to lock the two
    // streams together at a corner and hold the returning crossers on the carriageway through the next green.
    if (!walkNow && p.wpi === 0 && this.field && this.field.sample(p.x, p.z) > 0.35) {
      p.state = 'wait'; p.moving = false; p.vel = 0; p.link = -1; p.plazaNext = null; p.wave = -1;
      p.tx = p.x; p.tz = p.z; p.toSpot = false; p.detX = 0; p.detZ = 0; p.faceYaw = null;
      return;
    }
    if (!walkNow) p.hurry = Math.max(p.hurry, 1.65); else if (sig === 'flash') p.hurry = Math.max(p.hurry, 1.32);
    const wx = p.wp[p.wpi * 2], wz = p.wp[p.wpi * 2 + 1];
    // A waypoint wedged in the kerb crowd or against a signal pole is never reached to the centimetre: 2.5 s without
    // getting 0.3 m closer and it counts as reached from within 3 m, after 6 s from anywhere (no snap either way).
    const dw = Math.hypot(wx - p.x, wz - p.z);
    if (p.stWp !== p.wpi || dw < p.stBest - 0.3) { p.stWp = p.wpi; p.stBest = dw; p.stT = 0; } else p.stT += dt;
    if (p.stT > 6 || (p.stT > 2.5 && dw < 3)) {
      if (MOTION_DBG) this.mdTag(p, 'wpSkip', 1);
      p.wpi++; p.stWp = -1;
      if (p.wpi >= p.wpn) { p.state = 'wait'; p.corner = p.dest; p.moving = false; p.link = -1; this.arrive(p, t, walkNow, rng); return; }
      return;
    }
    // a blocking vehicle re-targets the walk line instead of only absorbing an impulse, so crossers go round the flank
    if (p.detX || p.detZ) { const k = Math.max(0, 1 - dt * 0.9); p.detX *= k; p.detZ *= k; }
    // (the detour fades inside 3 m of the waypoint: the walk line converges on it -- held at full it parked a crosser
    // at the detoured point, 6 m off the stripes, until it decayed)
    const dk = Math.min(1, dw / 3);
    let dx = wx - p.x + p.detX * dk, dz = wz - p.z + p.detZ * dk;
    const d = Math.hypot(dx, dz);
    // a hurry is a longer stride first and a quicker step only up to a human cadence (crowdScan: p.vmax)
    // up to pace from the kerb at ACC_UP; into the last waypoint (the far pavement) on a braking curve
    let vt = Math.min(p.speed * p.hurry, p.vmax || 2.4);
    if (p.wpi >= p.wpn - 1) vt = Math.min(vt, Math.max(0.45, Math.sqrt(2 * ACC_DN * 0.8 * d)));
    const v = accel(p, vt, dt), step = v * dt;
    // reached when the waypoint itself is within a step (the last move is under a step, never a snap); a detour round a
    // car only steers (arriving at the detoured point left a crosser finishing on the carriageway; p.x = wx on reaching
    // the detoured point snapped it back by the offset)
    if (dw <= Math.max(step, 0.02)) {
      p.x = wx; p.z = wz; p.wpi++;
      if (p.wpi >= p.wpn) { p.state = 'wait'; p.corner = p.dest; p.moving = false; p.link = -1; this.arrive(p, t, walkNow, rng); return; }
    } else if (d > 1e-4) {
      const mv = Math.min(step, d);
      dx /= d; dz /= d;
      // anticipation: 2.5 s ahead, rotate the heading away from whoever is on a collision course (<= 25 deg)
      if (p._ttc) {
        // re-solved every third frame per person (staggered); the heading change in between is held
        if ((this.frame + p.index) % 3 === 0) p.ttcSt = this.ttcSteer(p, dx, dz, v);
        const st = p.ttcSt || 0;
        if (st) { const c = Math.cos(st), s2 = Math.sin(st), ex = dx * c + dz * s2, ez = -dx * s2 + dz * c; dx = ex; dz = ez; }
      } else p.ttcSt = 0;
      p.x += dx * mv; p.z += dz * mv;
      turnTo(p, Math.atan2(dx, dz), dt, 7);
    }
    p.moving = true; p.vel = v; advance(p, v, dt);
  },

  // Time-to-collision steering against the people around p (last frame's separation grid). Returns a heading
  // change in radians (+ = to the left), at most 25 degrees: the nearer and surer the collision, the harder the
  // turn, and always away from the side the other person is on.
  ttcSteer(p, dx, dz, v) {
    if (!this.gReady) return 0;
    const head = this.gHead, next = this.gNext, peds = this.peds, order = this.order;
    const cx = ((p.x - this.gOX) / GRID_CELL) | 0, cz = ((p.z - this.gOZ) / GRID_CELL) | 0;
    const vx = dx * v, vz = dz * v;
    let turn = 0;
    for (let j = -2; j <= 2; j++) {
      const zz = cz + j; if (zz < 0 || zz >= GRID_N) continue;
      for (let k = -2; k <= 2; k++) {
        const xx = cx + k; if (xx < 0 || xx >= GRID_N) continue;
        for (let o = head[zz * GRID_N + xx]; o >= 0; o = next[o]) {
          const q = peds[order[o]];
          if (q === p || (p.grp && q.grp === p.grp)) continue;
          const rx = q.x - p.x, rz = q.z - p.z;
          if (rx * dx + rz * dz < 0.2) continue;                     // behind or beside: separation handles it
          const d2 = rx * rx + rz * rz;
          if (d2 > 16) continue;
          const qv = q.moving ? (q.vel || 0) : 0;
          const wx = Math.sin(q.yaw) * qv - vx, wz = Math.cos(q.yaw) * qv - vz;
          const w2 = wx * wx + wz * wz;
          if (w2 < 1e-4) continue;
          const tc = -(rx * wx + rz * wz) / w2;
          if (tc <= 0 || tc > 2.5) continue;
          const mx = rx + wx * tc, mz = rz + wz * tc, dm = Math.hypot(mx, mz);
          if (dm > 0.75) continue;
          // q on p's right (cross > 0; +x is a body's left when it faces +z) -> turn left (positive), and vice versa
          const side = dx * rz - dz * rx > 0 ? 1 : -1;
          turn += side * (1 - dm / 0.75) * (1 - tc / 2.5) * 0.9;
        }
      }
    }
    return clamp(turn, -0.44, 0.44);
  },

  // A walker's step, then the two limits placeOnPath cannot know about: its lane (the offset across the pavement,
  // which separation, cars, furniture, the kerb pull and a turn-around all write) changes at most LAT_V m/s, and its
  // heading turns at most YAW_RATE (placeOnPath sets the segment's heading outright: a polyline corner was a snap).
  stepWalker(p, dt, rng) {
    // (measured from where the body was drawn last frame: a half-rate tick steps 2 frames from where the sim stood,
    // one of which the carried frame already showed)
    const y0 = p.yaw, lp = p._latP, px0 = p.x + (p._exU || 0), pz0 = p.z + (p._ezU || 0), fdt = Math.max(1e-4, dt - (p._ctU || 0));
    p._gapF = 1;
    this.stepWalker0(p, dt, rng);
    if (p.kind !== 'walker' || p._reloc) { p._ox = p._oz = 0; return; }
    if (lp != null && p.lat != null) {
      const m = LAT_V * dt;
      if (p.lat > lp + m || p.lat < lp - m) {
        const yy = p.yaw;
        p.lat = clamp(p.lat, lp - m, lp + m); this.placeOnPath(p); p.yaw = yy;
      }
    }
    p._latP = p.lat;
    // Where the path puts a walker is re-derived every step; anything in that derivation that is not continuous
    // (a pavement guard giving way, a span edge) is taken up here as an offset the body walks off at WALK_OFF_V, and
    // the body never covers more than WALK_VMAX a second on screen (2.4 m/s along + 1.2 across is ~2.7 at most).
    // a crosswalk end that lies in the road (S.gap0 / gap1): faded out over its last GAP_FADE_S of stripes, across the
    // gap to the pavement unseen, faded back in (p.fade, per step: the loop applies p._gapF)
    p._gapF = 1;
    const CS = p.path.cwSpans;
    if (CS) for (let k = 0; k < CS.length; k++) {
      const S = CS[k]; if (!S.gap0 && !S.gap1) continue;
      const sv = p.path.cum[p.seg] + p.t * (p.path.cum[p.seg + 1] - p.path.cum[p.seg]);
      if (S.gap0) { const d = Math.abs(sv - S.s0); if (d < GAP_FADE_S) p._gapF = Math.min(p._gapF, d / GAP_FADE_S); }
      if (S.gap1) { const d = Math.abs(sv - S.s1); if (d < GAP_FADE_S) p._gapF = Math.min(p._gapF, d / GAP_FADE_S); }
    }
    // (off-screen by the sort, or faded out -- held behind a stage, through a door, gone into a station, across a
    // crosswalk's gap: on the path outright, a snap nobody sees, and no offset left to walk off in view later)
    // (the step over a gap's edge is always within its inner third: drawn at gapF^2 <= 0.1 there)
    if (p._far || p.dfade < 0.05 || p._gapF < 0.33) { p._ox = p._oz = 0; p._snap = 1; return this.walkYaw(p, y0, dt); }
    let ox = p._ox || 0, oz = p._oz || 0;
    const om = Math.hypot(ox, oz);
    if (om > 1e-4) { const k = Math.max(0, om - WALK_OFF_V * dt) / om; ox *= k; oz *= k; }
    let x = p.x + ox, z = p.z + oz;
    const mx = x - px0, mz = z - pz0, md = Math.hypot(mx, mz), lim = WALK_VMAX * fdt;
    if (md > lim) { x = px0 + mx / md * lim; z = pz0 + mz / md * lim; if (MOTION_DBG) this.mdTag(p, 'walkLimit', md - lim); }
    p._ox = x - p.x; p._oz = z - p.z; p.x = x; p.z = z;
    this.walkYaw(p, y0, dt);
  },

  walkYaw(p, y0, dt) {
    // a U-turn starts from the heading the person had, not the segment's raw one placeOnPath just wrote (a 0.2-0.3 rad snap)
    if (p.turn > 0 && p.turn === p.turnDur && p.dir === 0) { p.yaw = p.yaw0 = y0; p.yaw1 = y0 + Math.PI; }
    else if (!(p.turn > 0)) { const tgt = p.yaw; p.yaw = y0; turnTo(p, tgt, dt, 8); }
  },

  stepWalker0(p, dt, rng) {
    const half = p.path.width / 2 - 0.2;
    // (the walking pace eases up from a standstill: any branch below that returns early has stopped the stride)
    const cv0 = p.cv; p.cv = 0;
    // missions' talk stage first: someone at a shop window or a door inside it dissolves too (they were stood in the
    // scene at 健人's elbow)
    { const SB0 = this.stageBlock;
      if (SB0 && (p.shopT > 0 || p.doorT > 0) && (p.x - SB0.x) * (p.x - SB0.x) + (p.z - SB0.z) * (p.z - SB0.z) < SB0.r * SB0.r) {
        p.dfade = this.frame - (this.cutF == null ? -99 : this.cutF) <= 2 ? 0 : Math.max(0, p.dfade - dt * 2.5); p.moving = false; p.vel = 0; p._stageHid = 1; return;
      } }
    // window shopper: parks against the facade, faces it, then rejoins the stream
    if (p.shopT > 0) {
      p.shopT -= dt; p.moving = false; p.vel = 0;
      p.lat += (p.shopLat - p.lat) * Math.min(1, dt * 2.6);
      // company at a window: turned to the friend beside them (shopFace), not to the shelves
      const want = p.shopFace ? Math.atan2(p.shopFace.x - p.x, p.shopFace.z - p.z) : p.shopYaw;
      p.yaw += wrapPi(want - p.yaw) * Math.min(1, dt * 3.2);
      this.placeOnPath(p); this.latOnPavement(p);
      if (p.shopT <= 0) { p.shopCool = rng.range(14, 40); p.shopFace = null; }
      return;
    }
    if (p.shopCool > 0) p.shopCool -= dt;
    // shopfront door: fade out at the kerb line, reappear from another door further along
    if (p.doorT > 0) {
      p.doorT -= dt;
      if (p.doorPh === 0) {
        p.dfade = clamp(p.doorT / 0.8, 0, 1);
        p.lat += (p.doorLat - p.lat) * Math.min(1, dt * 3.5);
        this.placeOnPath(p); this.latOnPavement(p); p.moving = true; p.vel = p.speed * 0.5; advance(p, p.vel, dt);
        if (p.doorT <= 0) { p.doorPh = 1; p.doorT = rng.range(1.4, 4.2); p.dfade = 0; }
        return;
      }
      if (p.doorPh === 1) {
        p.dfade = 0; p.moving = false;
        if (p.doorT <= 0) { const a = Math.max(0, p.sA), b = Math.min(p.path.len, p.sB); p.doorPh = 2; p.doorT = 0.8; this.seedOnPath(p, a + rng() * (b - a)); p.lat = p.doorLat; this.placeOnPath(p); }
        return;
      }
      p.dfade = clamp(1 - p.doorT / 0.8, 0, 1);
      p.lat += (p.baseLat - p.lat) * Math.min(1, dt * 2.2);
      if (p.doorT <= 0) { p.dfade = 1; p.doorPh = 0; p.doorCool = 30; }
    } else if (p.doorUser && (p.doorCool = (p.doorCool || 0) - dt) <= 0 && rng() < dt * 0.05) {
      p.doorPh = 0; p.doorT = 0.8; p.doorLat = (p.lat >= 0 ? 1 : -1) * half;
    } else if (p.shopper && p.shopCool <= 0 && !p.waitS && !p.onSpan && rng() < dt * 0.22) {   // (not while waiting at a crossing)
      const side = p.lat >= 0 ? 1 : -1;
      p.shopT = rng.range(6, 20); p.shopLat = side * (half - 0.1 - (p.shopIn || 0));
      p.shopYaw = Math.atan2(p.nx * side, p.nz * side);
      if (p.wmates) this.shopTogether(p, rng);
      return;
    }
    // blocked by the player: decelerate over 0.4 s and step aside instead of freezing mid-stride
    const want = p.blocked ? 0 : 1;
    p.speedK += clamp(want - p.speedK, -dt / 0.4, dt / 0.4);
    if (p.turn > 0) {
      if (MOTION_DBG) this.mdTag(p, 'turning', 1);
      p.turn -= dt;
      const k = clamp(1 - p.turn / (p.turnDur || 0.62), 0, 1), e = k * k * (3 - 2 * k);
      p.lat = p.lat0 + (p.lat1 - p.lat0) * e;
      p.yaw = p.yaw0 + wrapPi(p.yaw1 - p.yaw0) * e;
      this.placeOnPath(p); this.latOnPavement(p); p.yaw = p.yaw0 + wrapPi(p.yaw1 - p.yaw0) * e;
      p.moving = true; p.vel = p.speed * 0.45; advance(p, p.vel, dt);
      if (p.turn <= 0) { p.dir = p.dirNext; p.turn = 0; }
      return;
    }
    // a square walker gone through a portal: out of sight for a while, then back out walking the other way
    if (p.hideT > 0) {
      p.hideT -= dt; p.dfade = 0; p.moving = false; p.vel = 0;
      if (p.hideT <= 0) { p.dir = -1; p.baseLat = -p.baseLat; p.lat = p.baseLat; p.latPrev = p.lat; this.seedOnPath(p, p.path.len - 0.05); }
      return;
    }
    const pts = p.path.pts;
    const a = pts[p.seg], b = pts[p.seg + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // the pedestrian signals on this street (spanStep): 0 = waiting at the kerb for the green man
    const sk = this.spanStep(p, dt);
    if (sk === 0) {
      p.moving = false; p.vel = 0;
      // (standing at the kerb the lane is regained at a shuffle, SEP_STILL_V: at 0.8 x the gap a second it was a
      // sideways slide at 0.3 m/s on planted feet)
      p.lat += clamp((p.baseLat - p.lat) * Math.min(1, dt * 0.8), -SEP_STILL_V * dt, SEP_STILL_V * dt);
      this.placeOnPath(p);
      this.latOnPavement(p);
      p.yaw += wrapPi(Math.atan2((b[0] - a[0]) * p.dir, (b[1] - a[1]) * p.dir) - p.yaw) * Math.min(1, dt * 3);
      return;
    }
    // a little slower up the hill, a little quicker down it
    p.cv = cv0;
    const seg0 = p.seg, t0 = p.t;
    // braking into the end of the walker's window (a U-turn there, or a square route's portal): it walked in at full
    // pace and stood still the next frame
    const P0 = p.path, s0v = P0.cum[p.seg] + p.t * (P0.cum[p.seg + 1] - P0.cum[p.seg]);
    const dEnd = p.dir > 0 ? Math.min(p.sB, P0.len) - s0v : s0v - Math.max(p.sA, 0);
    const vEnd = Math.max(0.3, Math.sqrt(2 * ACC_DN * 0.8 * Math.max(0, dEnd)));
    const v = accel(p, Math.min(p.speed * p.speedK * sk * (1 - clamp((p._gA || 0) * 2.2, -0.08, 0.14)), (p.vmax || 2.4) * (p.onSpan && p.onSpan.cwK ? p.onSpan.cwK : 1), vEnd), dt);
    // (the lane is longer or shorter than the centre line through a bend: _sf keeps the walked speed at v)
    p.t += (v * dt / len / (p._sf || 1)) * p.dir;
    let flip = 0;
    // carry the overshoot into the next segment in metres (t -= 1 kept the old segment's fraction of a new length)
    const segL = (k) => Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]) || 1;
    if (p.t > 1) { if (p.seg + 2 < pts.length) { const o = (p.t - 1) * len; p.seg++; p.t = Math.min(1, o / segL(p.seg)); } else { p.t = 1; flip = -1; } }
    if (p.t < 0) { if (p.seg > 0) { const o = -p.t * len; p.seg--; p.t = Math.max(0, 1 - o / segL(p.seg)); } else { p.t = 0; flip = 1; } }
    const sv = p.path.cum[p.seg] + p.t * (p.path.cum[p.seg + 1] - p.path.cum[p.seg]);
    if (!flip && p.dir) {                                    // the end of this walker's window on the street
      if (p.dir > 0 && sv > p.sB) flip = -1; else if (p.dir < 0 && sv < p.sA) flip = 1;
    }
    // missions' talk stage (stageBlock): nobody walks through a conversation. A walker heading into it turns back at
    // its edge; one the scene opened on top of steps out of sight until it releases.
    const SB = this.stageBlock;
    if (SB) {
      const sx = p.x - SB.x, sz = p.z - SB.z, s2 = sx * sx + sz * sz;
      // (dissolved where they stand, not popped out; they fade back in when the scene releases)
      if (s2 < SB.r * SB.r) { if (MOTION_DBG && !p._stageHid) this.mdTag(p, 'stageHide', 1); p.dfade = this.frame - (this.cutF == null ? -99 : this.cutF) <= 2 ? 0 : Math.max(0, p.dfade - dt * 2.5); p.moving = false; p.vel = 0; p._stageHid = 1; p.seg = seg0; p.t = t0; p.cv = 0; return; }
      if (!flip && p.dir && s2 < (SB.r + 1.8) * (SB.r + 1.8) && ((b[0] - a[0]) * sx + (b[1] - a[1]) * sz) * p.dir < 0) flip = -p.dir;
    }
    if (p._stageHid) { p.dfade = Math.min(1, p.dfade + dt * 2); if (p.dfade >= 1) p._stageHid = 0; }
    if (p.path.plaza) {
      // a square route's kerb end sits up to ~0.6 m into the carriageway: the walker hands over to the kerb (toKerb)
      // where the route meets the pavement's edge, not on the road (keepOffRoad had shoved them back 0.17 m a frame)
      if (!flip && p.dir < 0 && sv < this.kerbS(p.path)) flip = 1;
      p.dfade = clamp((p.path.len - sv) / 1.6, 0, 1);
      // company goes through together and comes back out together (a child never walks back out alone)
      if (flip === -1) { p.hideT = p.grp ? 2 + 8 * ((p.grp * 0.6180339) % 1) : rng.range(2, 10); p.dfade = 0; p.moving = false; return; }
      if (flip === 1) { this.toKerb(p, rng); return; }
    }
    // anticipation: 2.5 s ahead, sidestep whoever is on a collision course instead of brushing into them
    if (p._ttc && v > 0.2) {
      if ((this.frame + p.index) % 3 === 0) p.ttcSt = this.ttcSteer(p, (b[0] - a[0]) / len * p.dir, (b[1] - a[1]) / len * p.dir, v);
      const st = p.ttcSt || 0;
      if (st) p.lat = clamp(p.lat + p.dir * Math.sin(st) * v * dt * 1.4, -half, half);
    } else p.ttcSt = 0;
    { const lm = Math.max(SEP_STILL_V, 0.5 * v) * dt;          // hold the keep-left lane against separation impulses
      p.lat += clamp((p.baseLat - p.lat) * Math.min(1, dt * 0.8), -lm, lm); }   // (at no more than half the pace)
    this.placeOnPath(p);
    this.latOnPavement(p);
    // the sideways part of the motion (separation, the sidestep, the lane pull) turns the body and is walked,
    // not slid: the heading leans into it and the stride counts it
    const lv = (p.lat - (p.latPrev == null ? p.lat : p.latPrev)) / Math.max(dt, 1e-3);
    p.latPrev = p.lat;
    p.latV = (p.latV || 0) + (lv - (p.latV || 0)) * Math.min(1, dt * 6);
    if (v > 0.2) p.yaw += p.dir * Math.atan2(p.latV, v) * 0.6;
    // (the step aside eases with speedK: keyed on p.blocked it was on / off by 0.35 m as the player's bubble came and went)
    if (p.speedK < 1) { p.x += Math.cos(p.yaw) * 0.35 * (1 - p.speedK); p.z -= Math.sin(p.yaw) * 0.35 * (1 - p.speedK); }
    if (flip) {
      if (MOTION_DBG) this.mdTag(p, 'turnStart', 1);
      p.yaw0 = p.yaw; p.yaw1 = p.yaw + Math.PI;
      p.lat0 = p.lat; p.baseLat = -p.baseLat; p.lat1 = clamp(p.baseLat, -half, half);
      // a U-turn takes a second, and longer when it crosses the pavement (0.62 s slid a walker 2 m sideways at 5 m/s)
      p.turn = p.turnDur = Math.max(1.0, Math.abs(p.lat1 - p.lat0) / 0.8);
      p.dirNext = flip; p.dir = 0;
    }
    p.moving = p.speedK > 0.05;
    p.vel = Math.hypot(v, p.latV * 0.7);
    advance(p, p.vel, dt);
  },

  // a leader stopping at a window takes its company with it: the mate stops a step off the frontage and turns to the
  // leader; in a third of pairs the leader turns to the mate too (two people talking in front of a shop)
  shopTogether(p, rng) {
    const side = p.shopLat >= 0 ? 1 : -1, half = p.path.width / 2 - 0.2;
    let j = 0;
    for (const q of p.wmates) {
      if (q.shopT > 0 || q.doorT > 0 || q.turn > 0) continue;
      q.shopT = p.shopT; q.shopLat = clamp(p.shopLat - side * (0.75 + 0.7 * j), -half, half); q.shopYaw = p.shopYaw; q.shopFace = p;
      if (++j === 1 && rng() < 0.35) p.shopFace = q;
      if (rng() < 0.3) { q.idlePose = 3; q.phone = true; }
    }
  },

  stepIdler(p, dt, t) {
    p.moving = false; p.vel = 0;
    if (p.police) return;
    if (p.role) {
      // work the street: turn to whoever is walking past, drift back to the pitch, reach out with the flyer
      if (((this.frame + p.fidI) & 7) === 0) p.mark = this.nearestPasser(p);
      const m = p.mark, d = m ? Math.hypot(m.x - p.x, m.z - p.z) : 99;
      const want = d < 5.5 ? Math.atan2(m.x - p.x, m.z - p.z) : p.baseYaw + Math.sin(t * 0.3 + p.fid) * 0.6;
      turnTo(p, want, dt, 3.2);
      p.ext += ((d < (p.role === 1 ? 3.5 : 2.8) ? 1 : 0) - p.ext) * Math.min(1, dt * 4);
      p.pitch = d < 5.5 ? 1 : 0;
      // a tout steps half a metre into the passer's line with a small bow, then drifts back to the pitch
      let tx = p.hx, tz = p.hz;
      if (p.role === 1 && d < 3.5 && d > 0.5) { const k = 0.5 * p.ext; tx += (m.x - p.hx) / d * k; tz += (m.z - p.hz) / d * k; }
      p.bow = p.role === 1 ? 0.20 * p.ext * (0.55 + 0.45 * Math.sin(t * 2.2 + p.fid)) : 0;
      const dx = tx - p.x, dz = tz - p.z, dd = Math.hypot(dx, dz);
      if (dd > 0.08) {
        const v = Math.min(accel(p, Math.min(0.9, dd * 2.5), dt), dd / Math.max(dt, 1e-3));
        p.x += dx / dd * v * dt; p.z += dz / dd * v * dt;
        if (v > 0.25) { p.moving = true; p.vel = v; advance(p, v, dt); }
      } else p.cv = 0;
      return;
    }
    if (p.queue) {                                                  // ticket-gate file: shuffle up, then through
      if (p.qOut) {
        const Q = p.queue, v = 0.7;
        p.dfade = Math.max(0, p.dfade - dt * 1.5);
        p.x -= Q.nx * v * dt; p.z -= Q.nz * v * dt; p.moving = true; p.vel = v;
        turnTo(p, Math.atan2(-Q.nx, -Q.nz), dt, 4);
        if (p.dfade <= 0) { p.qOut = 0; p._reloc = 1; p.x = Q.x + Q.nx * (0.55 + p.qSlot * 0.80); p.z = Q.z + Q.nz * (0.55 + p.qSlot * 0.80); p.moving = false; p.vel = 0; }
        return;
      }
      if (p.dfade < 1) p.dfade = Math.min(1, p.dfade + dt * 1.4);   // rejoined the tail: fade back in
      const Q = p.queue, d0 = 0.55 + p.qSlot * 0.80 + (p.qSlot ? p.qGap || 0 : 0), jl = p.qJit || 0;
      p.tx = Q.x + Q.nx * d0 - Q.nz * jl; p.tz = Q.z + Q.nz * d0 + Q.nx * jl;
      const dx = p.tx - p.x, dz = p.tz - p.z, d = Math.hypot(dx, dz);
      let want = Math.atan2(-Q.nx, -Q.nz) + (p.qYaw || 0);
      if (p.qPair) want += wrapPi(Math.atan2(p.qPair.x - p.x, p.qPair.z - p.z) - want) * 0.6;   // turned to the friend beside
      turnTo(p, want, dt, 3.0);
      // shuffling up a place: eased off the mark and braked into the next (it was 0.8 m/s from a standstill and a
      // 30%-a-frame tuck, 1.8 m/s on planted feet, for the last 10 cm)
      if (d > 0.10) {
        const v = Math.min(accel(p, Math.min(p.speed * 0.55, Math.sqrt(2 * ACC_DN * 0.8 * d)), dt), d / Math.max(dt, 1e-3));
        p.x += dx / d * v * dt; p.z += dz / d * v * dt;
        p.moving = v > 0.12; p.vel = v; advance(p, v, dt);
      } else { const k = Math.min(1, dt * 1.5); p.x += (p.tx - p.x) * k; p.z += (p.tz - p.z) * k; p.cv = 0; }
      return;
    }
    if (p.stroll) {
      if (p.wait > 0) { p.wait -= dt; p.cv = 0; p.yaw += Math.sin(t * 0.21 * p.fidget + p.fid) * dt * 0.22; return; }
      const dx = p.tx - p.x, dz = p.tz - p.z, d = Math.hypot(dx, dz);
      if (d < 0.38) { this.strollTarget(p); p.wait = this.rng.range(1.5, 7); p.cv = 0; return; }
      const v = accel(p, Math.min(p.speed * 0.60, Math.max(0.25, Math.sqrt(2 * ACC_DN * 0.8 * (d - 0.38)))), dt);
      p.x += dx / d * v * dt; p.z += dz / d * v * dt;
      turnTo(p, Math.atan2(dx, dz), dt, 3.2);
      p.moving = true; p.vel = v; advance(p, v, dt);
      return;
    }
    p.yaw += Math.sin(t * 0.21 * p.fidget + p.fid) * dt * 0.22;   // slow yaw drift / weight shift
    p.x += (p.hx - p.x) * Math.min(1, dt * 0.6);                  // drift back after being jostled
    p.z += (p.hz - p.z) * Math.min(1, dt * 0.6);
  },

  // ---------------------------------------------------------------------------------------------- fight ring
  // combat.js calls gawk(centre, 8.5, 18) when a fight starts and releaseGawk() when it ends. A street fight in
  // this genre is a closed ring of onlookers: everyone near stops, walks to a slot just outside the arena, turns
  // in and watches -- phones up filming, arms folded, hands in pockets, a hand over the mouth, pointing, the odd
  // one cheering. The ring is closed (slots are spread evenly by angle rank, so each person takes the slot on
  // their own side) and two or three deep, with the rows interleaved so the back row sees between shoulders.
  gawk(centre, r = 8.5, maxR = 18) {
    if (!centre) return;
    this.gk = { x: centre.x, z: centre.z, r, maxR, on: true, t: 0, n: 0 };
    this.recruitGawkers(true);
  },

  // combat.js: {centre, radius, lod0, lodScale} on combat:start / heat:action, null on combat:end. The crowd is
  // no longer the frame's heavy item (the part rig stops at DET_D and everything past it is one far-body draw),
  // so the budget is used as a floor rather than a cut: lod0 is the least the governor may shrink the LOD0 pool
  // to under frame pressure, and the pool's reach extends to LOD0_D_FIGHT so the gallery gets the real bodies.
  setCombatBudget(budget) {
    this.combatBudget = budget || null;
    this.resortT = 99;
  },

  releaseGawk() {
    if (!this.gk) return;
    this.gk.on = false;
    for (const p of this.peds) if (p.gawk) { p.gawk.release = true; p.gawk.delay = this.rng.range(0, 1.8); }
  },

  recruitGawkers(initial) {
    const G = this.gk, rng = this.rng, peds = this.peds, N = this.count;
    const snap = !!(initial && this.engine.params && this.engine.params.shot);
    const CAP = 96;
    // preallocated candidate ring (index, distance, angle) and an index array to sort: this runs every 1.2 s of a
    // fight and used to allocate an object per pedestrian, then slice and re-sort (fix round 1, GC in the combat preset)
    const gi = this._gkI || (this._gkI = new Int32Array(N)), gd = this._gkD || (this._gkD = new Float32Array(N)), ga = this._gkA || (this._gkA = new Float32Array(N));
    let have = 0, m = 0;
    for (let k = 0; k < N; k++) { const p = peds[k]; if (p.gawk && !p.gawk.release) have++; }
    if (have >= CAP) return;
    const reach = initial ? G.maxR + 4 : G.maxR;
    for (let k = 0; k < N; k++) {
      const p = peds[k];
      // a child is taken away from a fight, not stood in the front row of the gallery on its own
      if (p.gawk || p.police || p.child) continue;
      const d = Math.hypot(p.x - G.x, p.z - G.z);
      if (d > reach * 1.45) continue;
      gd[k] = d; ga[k] = Math.atan2(p.z - G.z, p.x - G.x); gi[m++] = k;
    }
    const idx = gi.subarray(0, m);
    idx.sort((u, v) => gd[u] - gd[v]);
    // everyone inside maxR, and the nearest few beyond it when the street was thin
    let take = 0;
    while (take < m && take + have < CAP && (gd[idx[take]] <= reach || take < 40)) take++;
    if (!take) return;
    const list = idx.subarray(0, take);
    if (!initial) {
      // latecomers squeeze into the back rows on their own side
      for (let k = 0; k < take; k++) { const i = list[k]; this.makeGawker(peds[i], ga[i], 1 + (rng() < 0.5 ? 1 : 0), snap); }
      G.n += take;
      return;
    }
    list.sort((u, v) => ga[u] - ga[v]);
    const n = take, rows = n > 72 ? 4 : n > 40 ? 3 : n > 16 ? 2 : 1;
    // the even spacing is rotated to the offset that moves people least (circular mean of own - even angle)
    let sx = 0, sy = 0;
    for (let k = 0; k < n; k++) { const e = ga[list[k]] - (k / n) * Math.PI * 2; sx += Math.cos(e); sy += Math.sin(e); }
    const a0 = Math.atan2(sy, sx);
    for (let k = 0; k < n; k++) {
      const i = list[k], even = a0 + (k / n) * Math.PI * 2;
      const a = even + wrapPi(ga[i] - even) * 0.25 + rng.range(-0.05, 0.05);
      this.makeGawker(peds[i], a, k % rows, snap);
    }
    G.n = n;
    console.info(`[crowd] fight ring: ${n} onlookers in ${rows} row${rows > 1 ? 's' : ''} at r ${G.r.toFixed(1)} m around (${G.x.toFixed(1)}, ${G.z.toFixed(1)})`);
  },

  makeGawker(p, a, row, snap) {
    const G = this.gk, rng = this.rng;
    const rr = G.r + 0.35 + row * 0.72 + rng.range(-0.2, 0.3);
    const g = {
      a, rr, tx: G.x + Math.cos(a) * rr, tz: G.z + Math.sin(a) * rr, rx: p.x, rz: p.z,
      delay: snap ? 0 : rng.range(0.15, 1.6), release: false, speed: rng.range(1.3, 1.9),
      pose0: p.idlePose, lean: rng.range(0, 0.07), look: rng.range(-0.25, 0.25),
      // a third of them crane sideways to see past the shoulder in front
      roll: row > 0 && rng() < 0.45 ? rng.range(0.05, 0.10) * (rng() < 0.5 ? -1 : 1) : 0,
    };
    // what they do with their hands: phones up filming dominate a street fight in 2026
    const r = rng();
    p.idlePose = r < 0.32 ? 4 : r < 0.50 ? 1 : r < 0.63 ? 2 : r < 0.70 ? 3 : r < 0.79 ? 6 : r < 0.86 ? 5 : r < 0.90 ? 7 : r < 0.95 ? 9 : 0;
    p.film2 = rng() < 0.5;                               // two-handed landscape vs one-handed portrait
    p.gawk = g;
    if (snap) {
      p.x = g.tx; p.z = g.tz; p.moving = false; p.vel = 0;
      p.yaw = Math.atan2(G.x - p.x, G.z - p.z) + g.look * 0.4;
      p.hx = p.x; p.hz = p.z;
    }
  },

  // The same scanned person twice in close view (2026-09-26, the client's review: two of the blue-jacket backpacker a few
  // metres apart by the lens). Anyone out of view (off-screen by the sort, faded out; anyone on the frame of a cut)
  // within DUP_NEAR + 13 m of the lens who shares a scan with someone near them takes the scan least seen round them,
  // never a companion's. Nobody visible is re-dressed, and a pool body keeps its person.
  dedupeScans() {
    const sc = this.scanR, cam = this.engine.camera; if (!sc || !cam) return;
    const K = sc.S.length, peds = this.peds, N = this.count, keyD = this.key, cut = this.cutF === this.frame;
    const cx = cam.position.x, cz = cam.position.z, R = DUP_NEAR + DUP_CONSP;
    // everyone near the lens, bucketed by scan (a pair test is then ~1/24 of the crowd, not all of it)
    const B = this._dupB || (this._dupB = Array.from({ length: K }, () => []));
    for (const b of B) b.length = 0;
    for (let i = 0; i < N; i++) { const p = peds[i]; if (p.sk == null || !(p.dfade > 0)) continue; const dx = p.x - cx, dz = p.z - cz; if (dx * dx + dz * dz < R * R && B[p.sk]) B[p.sk].push(p); }
    const cnt = this._dupC || (this._dupC = new Float32Array(K));
    const hid = (q) => !q.hero && !q.stage && (cut || q.fade < 0.05 || (keyD && keyD[q.index] >= 1e6));
    const consp = this._consp || (this._consp = sc.S.map((S) => !!(S && CONSP_ROLES.has(S.role))));
    // anyone out of view near the lens who shares a scan with someone near them is re-dressed before they can walk
    // into view as a twin (a pair already both in view is left alone)
    for (let k0 = 0; k0 < K; k0++) {
      const Lk = B[k0]; if (Lk.length < 2) continue;
      const sep = consp[k0] ? 1e9 : DUP_D + 4;                         // (a conspicuous outfit: one in the whole area round the lens)
      for (let a = 0; a < Lk.length; a++) {
        const q = Lk[a]; if (q.sk !== k0 || !hid(q)) continue;
        let clash = false;
        for (let b = 0; b < Lk.length; b++) { const o = Lk[b]; if (o === q || o.sk !== k0) continue; if (Math.abs(o.x - q.x) < sep && Math.abs(o.z - q.z) < sep && Math.hypot(o.x - q.x, o.z - q.z) < sep) { clash = true; break; } }
        if (!clash) continue;
        cnt.fill(0);
        for (let k = 0; k < K; k++) for (const o of B[k]) { if (o === q) continue; const dx = o.x - q.x, dz = o.z - q.z; if (Math.abs(dx) > 20 || Math.abs(dz) > 20) continue; const d = Math.hypot(dx, dz); if (d < 20) cnt[o.sk] += 1 + (20 - d) / 10; }
        for (const o of [q.mate, q.leader, ...(Array.isArray(q.members) ? q.members : [])]) if (o && o.sk != null) cnt[o.sk] += 100;
        let best = -1, bs = Infinity;
        for (let k = 0; k < K; k++) { if (!sc.S[k] || k === q.sk) continue; const c = cnt[k] + (consp[k] ? 1000 : 0); if (c < bs) { bs = c; best = k; } }
        if (best < 0) continue;
        q.sk = best; sc.keyPed(q);
        this.dupN = (this.dupN || 0) + 1;
      }
    }
  },



  // a step aside by (ox, oz), at most v m/s: a walker moves its lane (the path holds it), anyone else walks it, turning
  // into it if they were standing, and takes their spot / home with them so they do not step straight back
  stepAside(p, ox, oz, dt, v, sx0, sz0) {
    const m = Math.hypot(ox, oz); if (!(m > 1e-4)) return;
    if (p.kind === 'walker') {
      if (p.turn > 0 || !p.path) return;
      const half = p.path.width / 2 + 0.3;
      let dl = ox * p.nx + oz * p.nz;
      // pushed along its own line (someone dead ahead): the way aside is the side it is already on of them, or the
      // middle of the pavement from near its edge
      if (Math.abs(dl) < 0.5 * m && sx0 != null) { const rel = (p.x - sx0) * p.nx + (p.z - sz0) * p.nz; const sgn = Math.abs(p.lat) > half * 0.6 ? -Math.sign(p.lat) : rel !== 0 ? Math.sign(rel) : 1; dl = sgn * m; }
      p.lat = clamp(p.lat + clamp(dl, -LAT_V * dt, LAT_V * dt), -half, half);   // (placed by its next step, through the limiter)
      return;
    }
    let k = Math.min(m, v * dt) / m;
    // (someone on the pavement is not stepped off it: as far as it goes that way)
    const f = this.field;
    if (f && !(p.kind === 'crosser' && p.state === 'cross') && f.sample(p.x, p.z) >= 0.4 && f.sample(p.x + ox * k, p.z + oz * k) < 0.4) {
      let lo = 0, hi = k; for (let it = 0; it < 5; it++) { const mm = (lo + hi) / 2; if (f.sample(p.x + ox * mm, p.z + oz * mm) < 0.4) hi = mm; else lo = mm; } k = lo;
    }
    const sx = ox * k, sz = oz * k;
    p.x += sx; p.z += sz;
    if (!p.moving) turnTo(p, Math.atan2(ox, oz), dt, 4);
    if (p.kind === 'idler') { p.hx += sx; p.hz += sz; if (p.stroll) { p.tx += sx; p.tz += sz; } }
    else if (p.state === 'wait' && !p.toSpot) { p.tx += sx; p.tz += sz; }
  },

  // During a fight (2026-09-26, the client's review: "during a fight no pedestrian hides the main characters"): the
  // lens's lines of sight to 健人's and each fighting enemy's chest (engine.camera, read every step), LENS_W either
  // side, plus 健人's personal space. The ring's centre follows the fight at a walk, so the gallery goes with it.
  fightLens(dt) {
    const E = this.engine, G = this.gk, cam = E.camera, pl = E.player, en = E.get('enemy');
    const C = this._cor || (this._cor = new Float32Array(4 * 12));
    this._corN = 0;
    if (!pl || E.state.mode !== 'combat' || !cam) return;
    let n = 0, fx = pl.position.x, fz = pl.position.z, fn = 1;
    const add = (x, z) => { if (n < 11 && Math.hypot(x - cam.position.x, z - cam.position.z) < 40) { C[n * 4] = cam.position.x; C[n * 4 + 1] = cam.position.z; C[n * 4 + 2] = x; C[n * 4 + 3] = z; n++; } };
    add(pl.position.x, pl.position.z);
    if (en && en.list) for (const e of en.list) if (e.alive && e.position) { add(e.position.x, e.position.z); if (Math.hypot(e.position.x - fx, e.position.z - fz) < 12) { fx += e.position.x; fz += e.position.z; fn++; } }
    this._corN = n;
    this._psX = pl.position.x; this._psZ = pl.position.z;
    if (G && G.on) {                                     // the ring follows the fight's middle at a walking pace
      const tx = fx / fn - G.x, tz = fz / fn - G.z, d = Math.hypot(tx, tz), m = Math.min(d, 0.9 * dt);
      if (d > 1e-3) { G.x += tx / d * m; G.z += tz / d * m; }
    }
  },
  // is (x, z) within w of a line of sight (3-97 % along it) or within PERSONAL_R + 0.5 of 健人
  corridorHit(x, z, w) {
    const C = this._cor, n = this._corN;
    if (Math.hypot(x - this._psX, z - this._psZ) < PERSONAL_R + 0.5) return true;
    for (let k = 0; k < n; k++) {
      const ax = C[k * 4], az = C[k * 4 + 1], vx = C[k * 4 + 2] - ax, vz = C[k * 4 + 3] - az, L2 = vx * vx + vz * vz;
      if (L2 < 0.01) continue;
      const u = ((x - ax) * vx + (z - az) * vz) / L2;
      if (u < 0.03 || u > 0.97) continue;
      if (Math.hypot(ax + vx * u - x, az + vz * u - z) < w) return true;
    }
    return false;
  },
  // the way out of every line of sight (x, z) stands in: the sum of (w - distance) along each one's perpendicular
  corridorOut(x, z, w, out) {
    const C = this._cor, n = this._corN; out[0] = out[1] = 0;
    for (let k = 0; k < n; k++) {
      const ax = C[k * 4], az = C[k * 4 + 1], vx = C[k * 4 + 2] - ax, vz = C[k * 4 + 3] - az, L2 = vx * vx + vz * vz;
      if (L2 < 0.01) continue;
      const u = ((x - ax) * vx + (z - az) * vz) / L2;
      if (u < 0.03 || u > 0.97) continue;
      let px = x - (ax + vx * u), pz = z - (az + vz * u), d = Math.hypot(px, pz);
      if (d >= w) continue;
      if (d < 1e-3) { const L = Math.sqrt(L2); px = -vz / L; pz = vx / L; d = 1e-3; } else { px /= d; pz /= d; }
      out[0] += px * (w - d); out[1] += pz * (w - d);
    }
    return out;
  },

  stepGawker(p, dt, t) {
    const g = p.gawk, G = this.gk;
    // the slot rides the ring (its centre follows the fight: fightLens) and slides round it out of the lens's lines of
    // sight to 健人 and the enemies he is fighting, and out of his personal space
    if (G && !g.release && g.a != null) {
      const cx = G.x + Math.cos(g.a) * g.rr, cz = G.z + Math.sin(g.a) * g.rr;
      if (this._corN && this.corridorHit(cx, cz, LENS_W + 0.3)) {
        for (let k = 1; k <= 18; k++) {
          const da = k * 0.07, s1 = this.corridorHit(G.x + Math.cos(g.a + da) * g.rr, G.z + Math.sin(g.a + da) * g.rr, LENS_W + 0.3);
          if (!s1) { g.a += da; break; }
          const s2 = this.corridorHit(G.x + Math.cos(g.a - da) * g.rr, G.z + Math.sin(g.a - da) * g.rr, LENS_W + 0.3);
          if (!s2) { g.a -= da; break; }
        }
      }
      g.tx = G.x + Math.cos(g.a) * g.rr; g.tz = G.z + Math.sin(g.a) * g.rr;
    }
    if (g.delay > 0) {
      g.delay -= dt; p.moving = false; p.vel = 0;
      if (G && !g.release) turnTo(p, Math.atan2(G.x - p.x, G.z - p.z), dt, 4);
      return;
    }
    const tx = g.release ? g.rx : g.tx, tz = g.release ? g.rz : g.tz;
    const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    // once on the ring a body gives a little to its neighbours instead of stepping back into its slot every
    // time the separation pass nudges it -- that was a walk/stand flicker along the front row
    if (g.at && !g.release && d < 0.9) g.at = true;
    else if (d > 0.22) {
      g.at = false;
      const v = Math.min(g.speed, d * 2.5 + 0.3);
      p.x += dx / d * v * dt; p.z += dz / d * v * dt;
      turnTo(p, Math.atan2(dx, dz), dt, 6);
      p.moving = true; p.vel = v; advance(p, v, dt);
      return;
    }
    if (g.release) {                                    // back where they were: resume the old life
      p.idlePose = g.pose0; p.gawk = null; p.moving = false; p.vel = 0;
      if (p.kind === 'idler') { p.hx = p.x; p.hz = p.z; p.tx = p.x; p.tz = p.z; }
      return;
    }
    g.at = true;
    p.moving = false; p.vel = 0;
    // face the fight; the player drags the eyeline around a little, like a head following the action
    const pl = this.engine.player;
    const fx = pl ? pl.position.x * 0.6 + G.x * 0.4 : G.x, fz = pl ? pl.position.z * 0.6 + G.z * 0.4 : G.z;
    turnTo(p, Math.atan2(fx - p.x, fz - p.z) + g.look * 0.3, dt, 2.2);
    p.hx = p.x; p.hz = p.z;
  },

  strollTarget(p) {
    const rng = this.rng, b = p.box;
    for (let k = 0; k < 14; k++) {
      const x = rng.range(b[0], b[1]), z = rng.range(b[2], b[3]);
      if (!pointInPolygon(x, z, p.poly)) continue;
      if (Math.hypot(x - p.x, z - p.z) < 4) continue;            // a 1 m shuffle reads as a twitch, not a walk
      p.tx = x; p.tz = z; return;
    }
    p.tx = p.hx; p.tz = p.hz;
  },

  // ---------------------------------------------------------------------------------------------- LOD0 pool
  // A handful of real rigged bodies (humanoid.js) are recycled onto whichever pedestrians are closest to the lens.
  // They are NOT driven by animation clips: every bone is set each frame from the instanced twin's own pose (the
  // gait solved from metres travelled, the idle poses, phones, gestures, the tout's bow), so a promoted body walks
  // at any pace without scrubbing, keeps its phone at the chest and its hands off its groin, and swaps in and out
  // of the part rig without a pose pop. Inside LOD0_ANY everyone is promoted; out to LOD0_D the old gates apply.
  growHeroes() {
    if (this.heroOff || !this.resolveLook) return;
    const hs = this.heroes, now = this.tNow || 0;
    // Boot: every template in POOL_KEYS_BOOT is built in one go, behind the loading screen, so no body is ever built
    // mid-play (a build is a ~16 ms hitch on the render thread; the old on-demand pool logged 22 of them in 90 s of
    // walking). The pool never shrinks: the frame governor limits what is BOUND (bindHeroes), an unbound body costs
    // nothing per frame.
    if (!this._poolBoot) {
      this._poolBoot = true;
      const t0 = performance.now();
      for (const k of POOL_KEYS_BOOT) { if (this.heroOff) break; this.buildHero(k, now); }
      this._lastBuild = now;
      this.poolBootMs = performance.now() - t0;
      const T = this.poolMs || {};
      console.info(`[crowd] LOD0 pool: ${hs.length} bodies built at boot (${POOL_KEYS_BOOT.length} keys) in ${this.poolBootMs.toFixed(0)} ms (${Object.keys(T).map(k => k + ' ' + T[k].toFixed(0)).join(', ')}), ${this.heroTris || 0} tris, ${hs.length ? hs[0].h.drawCalls : 0} draws each, keys ${[...new Set(hs.map(G => G.key))].join(' ')}`);
      return;
    }
    // after boot: only for a key the binder was denied (poolWant), and only while the pool has room -- it grows, it
    // never churns; throttled so two denials in a row cannot land two builds on one frame
    const want = this.poolWant;
    this.poolWant = null;
    if (!want || hs.length >= POOL_MAX || hs.some(H => H.conf === want && !H.ped)) return;
    if (now - (this._lastBuild == null ? -9 : this._lastBuild) < POOL_REBUILD_T) { this.poolWant = want; return; }
    this._lastBuild = now;
    this.buildHero(want, now);
    this.nRebuilds = (this.nRebuilds || 0) + 1;
  },

  // one pool body of template `key` (a second copy of a key gets its own seed, so its own face)
  buildHero(key, now) {
    const hum = this.engine.get('humanoid');
    if (!hum || typeof hum.createHumanoid !== 'function') { this.heroOff = true; return; }
    const det = Math.max(LOD0_DETAIL_MIN, LOD0_DETAIL[0]);
    const [outfit, sx] = key.split('.'), slim = sx === 'f';
    // ?poolScan=1 (A/B): the men are the client's scans re-dressed per twin (humanoid.js civDress)
    const scan = slim ? null : this.poolScanFor(outfit, hum);
    let salt = 0;
    for (const H of this.heroes) if (H.conf === key) salt++;
    let h, build = 1, look = null, seed = 0;
    const T = this.poolMs || (this.poolMs = { create: 0, validate: 0, tint: 0, measure: 0, rig: 0, acc: 0 });   // boot profile
    let t0 = performance.now();
    try {
      const S = poolSeedFor(key, this.resolveLook, salt);
      seed = S.seed; look = S.look;
      build = (look.build || 1) * Math.sqrt(look.shoulderW || 1);
      h = scan ? hum.createHumanoid({ variant: scan, seed, detail: 1, lod: true, civ: true }) : hum.createHumanoid({ variant: 'pedestrian', seed, detail: det, ...S.opts });
    }
    catch (e) { this.heroOff = true; console.warn('[crowd] LOD0 pool disabled: ' + e.message); return; }
    T.create += performance.now() - t0; t0 = performance.now();
    // A hero body is the largest thing on screen; a disassembled one is a shipping blocker, so the rig is
    // checked for continuity before it ever joins the pool and the pedestrian falls back to the instanced rig.
    if (!validateRig(h)) {
      console.warn(`[crowd] LOD0 rig rejected at detail ${det.toFixed(2)}: ${validateRig.why}`);
      try { h.dispose(); } catch (e) { /* nothing to reclaim */ }
      this.heroBad = (this.heroBad || 0) + 1;
      if (this.heroBad > 2) this.heroOff = true;
      return;
    }
    T.validate += performance.now() - t0; t0 = performance.now();
    h.group.visible = false;
    h.group.name = 'crowd:hero' + this.heroes.length;
    h.skinned.castShadow = false; h.skinned.receiveShadow = true;
    // off layer 1: on it a pool body was drawn three times (frame, wet mirror, bloom mask); the mirror gets its far body
    for (const m of h.meshes || [h.skinned]) m.layers.disable(REFL_LAYER);
    if (h.lod) h.lod.layers.disable(REFL_LAYER);
    const tint = scan ? null : this.tintMap(h, look);
    T.tint += performance.now() - t0; t0 = performance.now();
    // The neck reads a head tall at 3-5 m (the critic's Center-gai close-up): the Head joint comes down to 0.82 of its
    // bind offset, which the skinning carries into the neck and throat. Done before the height is measured.
    // (A scan's neck is its own, measured.)
    const neckDrop = scan ? 0 : h.bones.Head.position.length() * (1 - NECK_K);
    if (!scan) h.bones.Head.position.multiplyScalar(NECK_K);
    // the body's real standing height at group scale 1 (crown to sole over the skinned vertices in the bind pose):
    // humanoid's own `height` is an estimate off the head joint and was 1-5 % off, so a pedestrian promoted into
    // the pool grew or shrank by up to 9 cm on the swap
    let bindH = 0;
    try {
      h.group.updateMatrixWorld(true); h.skeleton.update();
      const sk = h.skinned, n = sk.geometry.attributes.position.count, v = new THREE.Vector3();
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i += 2) { sk.getVertexPosition(i, v).applyMatrix4(sk.matrixWorld); if (v.y > hi) hi = v.y; if (v.y < lo) lo = v.y; }
      bindH = (hi - lo) / (h.group.scale.y || 1);
    } catch (e) { bindH = 0; }
    if (!(bindH > 1.2 && bindH < 2.4)) bindH = (h.height || 1.8) / (h.group.scale.y || 1);
    T.measure += performance.now() - t0; t0 = performance.now();
    this.engine.scene.add(h.group);
    const Q = () => new THREE.Quaternion();
    const H = {
      h, ped: null, det: scan ? 1 : det, slim, fem: slim, conf: key, key, outfit, look, seed, scan, base: h.group.scale.x || 1, height: h.height || 1.8, bindH, tint, build: scan ? 1 : build, lastUse: now,
      rig: this.captureRig(h), mats: this.heroMats(h, tint),
      qHead: Q(), qTorso: Q(), qThigh: [Q(), Q()], qShin: [Q(), Q()], qFoot: [Q(), Q()], qUarm: [Q(), Q()], qFarm: [Q(), Q()],
      sway: 0, bob: 0, twist: 0, shoTw: 0, lean: 0, roll: 0, holdUmb: false, acc: {}, pron: scan ? (SCAN_PRON[scan] || 0) : HERO_PRON, neckDrop,
    };
    // captureRig read the shortened neck off the bones; the crown it measured off the bind vertices did not move
    H.rig.skullY -= neckDrop;
    T.rig += performance.now() - t0; t0 = performance.now();
    this.heroAccBuild(H);
    T.acc += performance.now() - t0;
    this.parkHero(H);
    this.heroes.push(H);
    this.heroTris = (this.heroTris || 0) + h.tris;
    // compile the pool body's programs now (they share one set), not on the frame it is first promoted: that
    // first promotion was a 1.5 s hitch mid-shot
    // [render] through precompileLit: the CSM-hooked, scene-target variant (the canvas variant compileAsync built
    // before was never the one drawn)
    if (!this._heroCompiled) { this._heroCompiled = true; try { precompileLit(this.engine, h.group); } catch (e) { /* best effort */ } }
  },

  // a body leaves the pool (rebuilt as another key): its own materials, the shell geometry and the body itself
  dropHero(H) {
    const i = this.heroes.indexOf(H);
    if (i >= 0) this.heroes.splice(i, 1);
    if (H.ped) this.unbind(H, 99);
    this.engine.scene.remove(H.h.group);
    this.heroTris = Math.max(0, (this.heroTris || 0) - (H.h.tris || 0));
    for (const k in H.acc) { const m = H.acc[k]; if (!m) continue; if (m.parent) m.parent.remove(m); if (k === 'hairShell' && m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); }
    for (const M of H.mats) if (M.m && M.m.dispose && !(H.scan && H.h.civ)) M.m.dispose();
    try { H.h.dispose(); } catch (e) { /* best effort */ }
  },

  // The bind pose in character space: per bone its bind local transform, world rotation and joint position, and
  // for each driven limb the rotation that takes its bind direction to hanging straight down (the part rig's zero
  // pose -- the pool body's arms are a relaxed A-pose at bind). Also the sole contact points, in the foot and toe
  // frames, that decide how high the hips sit.
  captureRig(h) {
    const B = h.bones, L = {}, W = {}, P = {}, R0 = {};
    for (const n of BONE_ORDER) {
      const b = B[n]; if (!b) continue;
      L[n] = { q: b.quaternion.clone(), p: b.position.clone() };
      const par = RIG_PARENT[n];
      if (par && W[par]) { W[n] = W[par].clone().multiply(L[n].q); P[n] = L[n].p.clone().applyQuaternion(W[par]).add(P[par]); }
      else { W[n] = L[n].q.clone(); P[n] = L[n].p.clone(); }
    }
    const down = new THREE.Vector3(0, -1, 0), d = new THREE.Vector3();
    const aim = (n, c) => { R0[n] = new THREE.Quaternion().setFromUnitVectors(d.subVectors(P[c], P[n]).normalize(), down); };
    for (const s of ['Left', 'Right']) {
      aim(s + 'Arm', s + 'ForeArm'); aim(s + 'ForeArm', s + 'Hand'); R0[s + 'Hand'] = R0[s + 'ForeArm'];
      aim(s + 'UpLeg', s + 'Leg'); aim(s + 'Leg', s + 'Foot');
    }
    const ground = Math.min(P.LeftToeBase.y, P.RightToeBase.y) - 0.02;
    const inF = (n, v) => v.applyQuaternion(W[n].clone().invert());
    const soles = {};
    for (const s of ['Left', 'Right']) {
      const f = P[s + 'Foot'], t = P[s + 'ToeBase'];
      soles[s] = {
        heel: inF(s + 'Foot', new THREE.Vector3(0, ground - f.y, -0.06)),
        ball: inF(s + 'Foot', new THREE.Vector3(t.x - f.x, ground - f.y, t.z - f.z)),
        tip: inF(s + 'ToeBase', new THREE.Vector3(0, ground - t.y, 0.06)),
      };
    }
    // the bone host's offset inside the body group (the lift that stands the feet on y = 0)
    const host = new THREE.Vector3();
    for (let o = B.Hips.parent; o && o !== h.group; o = o.parent) host.add(o.position);
    // the body's own surface, for seating accessories on it: crown height, the back of the chest, the hip width
    const pos = h.skinned.geometry.attributes.position, cy = P.Spine2.y;
    let topY = -Infinity, backZ = 0, hipX = 0.17;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (y > topY) topY = y;
      if (Math.abs(y - cy) < 0.06 && Math.abs(x) < 0.10 && z < backZ) backZ = z;
      if (Math.abs(y - P.Hips.y + 0.04) < 0.04 && Math.abs(z) < 0.08 && Math.abs(x) > hipX && Math.abs(x) < 0.30) hipX = Math.abs(x);
    }
    return { L, W, P, R0, ground, soles, hipY: L.Hips.p.y, host, skullY: topY - 0.118, backZ, hipX };
  },

  // Per-body clones of the pool body's materials, so each can carry its twin's neon tint (a clone keeps the
  // character shader: same onBeforeCompile, same program, same shared uniforms). The track frame's jacket and
  // jeans are flat-tinted materials in humanoid.js; their clones turn vertex colour on (every part ships a white
  // colour attribute) so retintHero can paint them like the suit: a hem, a skirt, a coat's length. The weave's
  // normal map is turned down on everything but knitwear: a diagonal knit with moire on a tailored suit at 4 m
  // was the critic's tell that every body is one mesh repainted.
  heroMats(h, tint) {
    // a scan civilian already has its own material (its own wardrobe uniforms): tinted in place, never cloned
    if (h.civ) return [{ m: h.civ.material, base: h.civ.material.color.clone(), kind: 'cloth', role: 'jacket' }];
    const out = [];
    const m0 = h.skinned.material, arr = Array.isArray(m0) ? m0 : [m0];
    const cl = arr.map((m) => {
      if (!m || !m.clone) return m;
      const c = m.clone();
      // the same irradiance knee as the instanced crowd: a pool body beside a vending machine's face light glowed
      // white along every edge
      const ob = m.onBeforeCompile, ck = m.customProgramCacheKey;
      // ...and the character shader's own sky / ground hemisphere, key and rim (POOL_HEMI_K etc.) on per-clone
      // uniforms, scaled to the street's light: the shared originals light the enemies and are not touched. The
      // clone's uniforms are its own in three.js (materialProperties.uniforms), the program is still shared.
      const src = m.userData.charShader || null;
      const lit = src ? { sky: { value: new THREE.Vector3() }, gnd: { value: new THREE.Vector3() }, keyK: { value: new THREE.Vector3(1, 1, 0.12) } } : null;
      c.onBeforeCompile = (sh, r) => {
        if (ob) ob.call(m, sh, r);
        if (lit && sh.uniforms.uHemiSky) { sh.uniforms.uHemiSky = lit.sky; sh.uniforms.uHemiGnd = lit.gnd; sh.uniforms.uKeyK = lit.keyK; }
        this.knee(sh);
      };
      c.customProgramCacheKey = () => (ck ? ck.call(m) : String(ob)) + '|crowdKnee';
      c.userData = m.userData;
      const nm = m.name || '', kind = nm.indexOf('skin') === 0 ? 'skin' : nm.indexOf('hair') === 0 ? 'hair' : 'cloth';
      // the body's own alpha-strand cap is replaced by the fitted hair shell (heroAccBuild): one draw and ~1.8 k
      // triangles a body, and the strand clumps it drew on the bare nape were the 'second face' on the back of the head
      if (kind === 'hair' && POOL_OWN_HAIR_OFF) c.visible = false;
      const key = matKey(nm);
      if (kind === 'cloth' && c.normalScale) { const ns = key === 'suit' ? 0.22 : key === 'shoes' ? 0.5 : 0.3; c.normalScale.set(ns, ns); }
      // a garment material that carries its colour itself (no vertex colours) is re-keyed at bind like a vertex
      // slot: the slot is whichever of the look's colours it was tinted with
      const slot = key && BASE_LIN[key] && !c.vertexColors && tint ? tint.matSlot(c.color, key) : null;
      out.push({ m: c, base: c.color.clone(), kind, key, slot, lit, src });
      return c;
    });
    h.skinned.material = Array.isArray(m0) ? cl : cl[0];
    return out;
  },

  // Which scan a man's pool body is built from: the salaryman for the tailored looks, the bomber and the vest men for
  // the casual ones, the least-used first so two identical faces are rarely bound at once. null = procedural.
  poolScanFor(outfit, hum) {
    if (!POOL_SCAN || typeof hum.civScans !== 'function') return null;
    const ready = hum.civScans(), want = (outfit === 'suit' ? ['enforcer_b'] : ['enforcer_a', 'wanderer']).filter(s => ready.includes(s));
    if (!want.length) return null;
    let best = want[0], bn = Infinity;
    for (const s of want) { const n = this.heroes.filter(H => H.scan === s).length; if (n < bn) { bn = n; best = s; } }
    return best;
  },

  // A hidden pool body stops ticking: humanoid.update() runs mixer.update() on every resident body unless it is
  // frozen, and these bodies are posed by hand anyway, so the mixer never runs on them at all.
  parkHero(H) {
    const h = H.h;
    try { h.mixer.stopAllAction(); } catch (e) { /* nothing playing */ }
    h.frozenPose = true;
    for (const k in H.acc) if (H.acc[k]) H.acc[k].visible = false;
  },

  // Per pool body: every garment vertex is keyed to the SLOT of the look record the body was resolved from (top,
  // bottom, inner, accent, coat, legwear, shoe, sole), by its vertex colour. humanoid.js writes a vertex colour as
  // linear(hex) / linear(base albedo of the material's map), times a grey shade (the jacket at 1.10, a tie knot at
  // 1.18, a button at 0.6), so a vertex belongs to the slot whose colour divides it to a grey; the grey / base factor
  // is kept per vertex, and a bind writes factor x the twin's own colour for that slot (retintHero). Works on any
  // outfit template without knowing how it was built. A suit's jacket and trousers share one colour: on the tailoring
  // slot the 10 % lift tells them apart. The shoe material also loses its toe glint here.
  tintMap(h, L) {
    const C = (L && L.colours) || {};
    const lin = {};
    for (const s of ['top', 'bottom', 'inner', 'accent', 'coat', 'legwear', 'shoe', 'sole', 'bag', 'cap']) {
      const hex = C[s];
      if (hex == null || hex === 0) continue;
      _ct.set(hex); lin[s] = [Math.max(_ct.r, 1e-4), Math.max(_ct.g, 1e-4), Math.max(_ct.b, 1e-4)];
    }
    const names = Object.keys(lin), lists = {}, facs = {}, bases = {};
    const matSlot = (color, key) => {
      const b = BASE_LIN[key];
      let best = null, bd = 9;
      for (const s of names) { const e = lin[s], d = Math.abs(color.r - e[0] / b[0]) + Math.abs(color.g - e[1] / b[1]) + Math.abs(color.b - e[2] / b[2]); if (d < bd) { bd = d; best = s; } }
      return bd < 0.3 ? best : null;
    };
    const geo = h.skinned.geometry, col = geo && geo.attributes.color, idx = geo && geo.index;
    const out = { col, lists, facs, bases, matSlot, n: 0 };
    const mats = Array.isArray(h.skinned.material) ? h.skinned.material : [h.skinned.material];
    if (!col || !idx) return out;
    const seen = new Uint8Array(col.count), sameTB = C.top === C.bottom;
    for (const g of geo.groups) {
      const mt = mats[g.materialIndex];
      if (!mt || !mt.vertexColors) continue;
      const key = matKey(mt.name || ''), b = key && BASE_LIN[key];
      if (!b) continue;
      for (let k = g.start, e = g.start + g.count; k < e; k++) {
        const i = idx.getX(k);
        if (seen[i]) continue;
        seen[i] = 1;
        const cr = col.getX(i), cg = col.getY(i), cb = col.getZ(i);
        if (Math.abs(cr - 1) < 0.015 && Math.abs(cg - 1) < 0.015 && Math.abs(cb - 1) < 0.015) continue;   // untinted
        let best = null, bs = 9, sh = 1;
        for (const s of names) {
          const e = lin[s], r0 = cr * b[0] / e[0], r1 = cg * b[1] / e[1], r2 = cb * b[2] / e[2];
          const mx = Math.max(r0, r1, r2), mn = Math.min(r0, r1, r2);
          if (mn <= 0) continue;
          const spread = mx / mn;
          if (spread < bs) { bs = spread; best = s; sh = (r0 + r1 + r2) / 3; }
        }
        if (!best || bs > 1.08 || sh < 0.2 || sh > 3) continue;
        if (best === 'top' && sameTB && key === 'suit' && sh < 1.05) best = 'bottom';
        (lists[best] || (lists[best] = [])).push(i);
        (facs[best] || (facs[best] = [])).push(cr / lin[best][0], cg / lin[best][1], cb / lin[best][2]);
        (bases[best] || (bases[best] = [])).push(b[0], b[1], b[2]);       // the map's mean albedo under that vertex
        out.n++;
      }
    }
    for (const s in lists) { lists[s] = Uint32Array.from(lists[s]); facs[s] = Float32Array.from(facs[s]); bases[s] = Float32Array.from(bases[s]); }
    for (const mt of mats) {
      if (!mt || (mt.name || '').indexOf('shoes') !== 0 || mt.userData.crowdShoe) continue;
      mt.userData.crowdShoe = 1;
      mt.roughness = Math.max(0.75, mt.roughness);
      if (mt.userData.envBoost != null) mt.userData.envBoost = Math.min(mt.userData.envBoost, 0.9);
      mt.envMapIntensity = Math.min(mt.envMapIntensity, 0.35);
    }
    return out;
  },

  // Paint a pool body in the clothes of the pedestrian it stands in for: slot by slot (tintMap), the twin's top on
  // the top, its trousers (or its skirt) on the bottom, its shin (tights, or skin) on the legwear, the layer under
  // the top on the inner, the tie on the accent, its shoes and soles. A coat over a suit takes the twin's top for the
  // coat and a darker cut of it for the jacket inside.
  retintHero(H, p) {
    const O = p.O;
    const leg = poolLeg(p.cLeg, _plL), shin = p.shinSkin ? p.cShin : poolLeg(p.cShin, _plS);
    if (H.scan && H.h.civ) {
      // the scan re-dressed in its twin's clothes: the top, the trousers, the layer under the top, the skin tone
      const sk = [p.cSkin.r / SKIN_LIN[0], p.cSkin.g / SKIN_LIN[1], p.cSkin.b / SKIN_LIN[2]].map(v => clamp(v, 0.75, 1.3));
      H.h.civ.dress(p.cCloth, leg, TAILORED.has(p.lookK) ? p.cInner : p.cInner, sk);
      return;
    }
    const T = H.tint;
    if (!T) return;
    const skirt = p.fem && O.skirtTop > 0 && O.hemY < 0.74;
    const under = H.key === 'suit.m.coat' ? _ct.copy(p.cCloth).multiplyScalar(0.8) : null;
    // a crew neck's inner is the twin's skin (the notch): on the template the layer under the top is a real collar,
    // and painted skin it read as ten centimetres more neck -- it takes the top's own colour instead
    const inner = p.cInner.getHex() === p.cSkin.getHex() ? p.cCloth : p.cInner;
    const cols = {
      top: under || p.cCloth, coat: p.cCloth, bottom: skirt ? p.cAcc : leg, legwear: shin,
      inner, accent: O.tie === 1 ? p.cAcc : inner, shoe: p.cShoe, sole: p.cSole, bag: p.cBag, cap: p.cCap || p.cBag,
    };
    if (T.col) {
      const a = T.col.array;
      for (const s in T.lists) {
        const c = cols[s];
        if (!c) continue;
        const li = T.lists[s], f = T.facs[s], bb = T.bases[s], n = li.length;
        let mr = 0, mg = 0, mb = 0;
        for (let i = 0; i < n; i++) {
          const o = li[i] * 3, j = i * 3;
          a[o] = f[j] * c.r; a[o + 1] = f[j + 1] * c.g; a[o + 2] = f[j + 2] * c.b;
          mr += a[o] * bb[j]; mg += a[o + 1] * bb[j + 1]; mb += a[o + 2] * bb[j + 2];
        }
        // guard (fix round 1): the slot's mean RENDERED colour (map albedo x vertex colour) has to sit within 0.15
        // of saturation and 20 degrees of hue of the twin's own colour, or the slot is rewritten as the twin's colour
        // times each vertex's grey factor -- a navy top stays navy whatever the keying did
        if (n && !slotMatches(_cm.setRGB(mr / n, mg / n, mb / n), c)) {
          for (let i = 0; i < n; i++) {
            const o = li[i] * 3, j = i * 3, g = (f[j] * bb[j] + f[j + 1] * bb[j + 1] + f[j + 2] * bb[j + 2]) / 3;
            a[o] = g * c.r / bb[j]; a[o + 1] = g * c.g / bb[j + 1]; a[o + 2] = g * c.b / bb[j + 2];
          }
          this.slotResets = (this.slotResets || 0) + 1;
        }
      }
      T.col.needsUpdate = true;
    }
    // garment materials that carry their colour themselves: the base the neon tint multiplies (updateHeroes)
    for (const M of H.mats) if (M.slot) { const c = cols[M.slot], b = BASE_LIN[M.key]; if (c && b) M.base.setRGB(c.r / b[0], c.g / b[1], c.b / b[2]); }
  },

  // Runs on every re-sort (and every third frame while somebody stands inside the lens bubble). The identity lock:
  // a bound pedestrian in view keeps its body whatever else happens, and a body is given or taken only out of view
  // (behind the lens, outside the frame, or past SWAP_D where the far body is what shows). Bodies are spent ahead of
  // time on the prospects -- whoever the lens is going to see nearest, soonest, their heading and the lens's own
  // motion both counted, the face side preferred -- so a passer-by walks INTO the frame already wearing the body.
  // When no body of the right frame is free the pedestrian keeps its instanced twin. A cut (cutFree: a preset, a
  // fight just framed, a teleport) frees everyone for one pass, nearest-first, the way the old binder worked.
  bindHeroes() {
    const hs = this.heroes;
    if (!hs.length) return;
    if (this.heroOff) {                                       // kill switch (A/B presets, pool build failure)
      for (const H of hs) { if (H.ped) { H.ped.hero = null; H.ped = null; } H.h.group.visible = false; }
      return;
    }
    const cam = this.engine.camera, cx = cam.position.x, cz = cam.position.z;
    cam.updateMatrixWorld();
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    this._bindFrustum = true;
    const peds = this.peds, order = this.order, nVis = this.visible, N = this.count;
    const cand = this._cand || (this._cand = []);
    cand.length = 0;
    const fight = !!this.combatBudget, cut = this.cutFree > 0;
    const budget = Math.min(this.scanR && !SCAN_POOL_OLD ? SCAN_LOD0_CAP : fight ? LOD0_BIND : LOD0_CAP, Math.max(LOD0_MIN, Math.round(this.heroBudget)));
    // in a fight the pool reaches a little further out: the gallery at 8-15 m from the arena is what the
    // combat lens looks straight at
    // (the scanned people have real faces from every side: a cut binds the nearest, facing or not, out to 12 m)
    const lod0D = fight ? LOD0_D_FIGHT : this.scanR ? 12 : LOD0_D;
    // in the rain an umbrella carrier stays on the part rig (its canopy rides the part rig's hand)
    const umbSeason = !this.scanR && this.umbrella.count > 0 && this.engine.time.weather === 'rain';
    const scan = !!this.scanR;
    const vx = this.camVX, vz = this.camVZ, now = this.tNow || 0;
    const PT = scan ? SCAN_PROSPECT_T : PROSPECT_T, PN = scan ? SCAN_PROSPECT_NEAR : PROSPECT_NEAR;
    // 1. the bound bodies: in view the pedestrian is locked; out of view it is judged again with the prospects
    //    (a body bound under 3 s ago is locked too: a prospect whose heading changed at a path node was bound and
    //    taken back within six frames, a flicker at 27 m)
    let bound = 0;
    for (let k = 0; k < hs.length; k++) {
      const H = hs[k], p = H.ped;
      if (!p) continue;
      p._ci = -1;                                              // its index in cand, stamped after the sort
      const d = Math.hypot(p.x - cx, p.z - cz);
      const gone = p.dfade < 0.9 || p.hideT > 0 || d > CULL;
      // (a cut rebalances the pool, but not onto the people who fill the new frame at arm's length: they keep theirs)
      p._lock = !gone && (!cut || d < 4) && (this.inView(p, d) || now - (H.boundAt == null ? -9 : H.boundAt) < 3);
      if (p._lock) bound++;
      else if (gone) this.unbind(H, d);
    }
    // 2. the prospects: the frame's own slots out to PROSPECT_D, then the off-screen slots (sorted by distance
    //    behind them) out to a few metres -- the people beside and behind the lens about to walk into the frame
    const take = (s0, s1, dMax) => {
      for (let s = s0; s < s1 && cand.length < 64; s++) {
        const p = peds[order[s]];
        const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
        if (d > dMax + 4) { if (p.police) continue; break; }  // distance sorted (bar the officers' bias in resort)
        if (d > dMax || p._lock) continue;
        // dfade, not fade: a body waiting inside the lens bubble is dissolved precisely because it has no pool twin yet
        if (d < LOD0_NEAR || p.dfade < 1 || p.hideT > 0 || p.doorT > 0) continue;
        if (umbSeason && p.umb) continue;
        if ((p.role === 2 && !scan) || !poolable(p)) continue; // the flyer hand-out's card rides the part rig's hand
        const face = -(Math.sin(p.yaw) * dx + Math.cos(p.yaw) * dz) > 0.25 * d;
        if (cut) {
          // a cut: whoever is nearest, the face side first, inside the old reach
          if (d > lod0D) continue;
          if (!fight && !scan && d > LOD0_BACK && !face) continue;
          p._sc = d + (face ? 0 : 1.5);
        } else {
          if (this.inView(p, d)) continue;                    // a swap here would be seen
          // closest approach to the lens over the next PROSPECT_T s, the lens's motion included
          const mv = p.moving ? (p.vel || 0) : 0;
          const rvx = Math.sin(p.yaw) * mv - vx, rvz = Math.cos(p.yaw) * mv - vz, v2 = rvx * rvx + rvz * rvz;
          let tca = 0, dmin = d;
          if (v2 > 0.01) { tca = clamp(-(dx * rvx + dz * rvz) / v2, 0, PT); dmin = Math.hypot(dx + rvx * tca, dz + rvz * tca); }
          if (dmin > PN) continue;
          // somebody standing off the frame's edge is a prospect only if the lens is turning / moving toward them
          if (v2 <= 0.01 && d > PN) continue;
          p._sc = tca + dmin * 0.5 + (face ? 0 : 1.0) + (p.hero ? -1.5 : 0);
        }
        cand.push(p);
      }
    };
    take(0, Math.min(nVis, 320), cut ? lod0D : PROSPECT_D);
    // (the scanned crowd looks further off the frame's edges: somebody entering the frame from the side inside 14 m
    // can only be bound before they enter it)
    if (!cut) take(nVis, Math.min(N, nVis + 160), scan && !SCAN_POOL_OLD ? 16 : PN + 3);
    cand.sort((a, b) => a._sc - b._sc);
    for (let c = 0; c < cand.length; c++) cand[c]._ci = c;
    // 3. a bound body whose pedestrian is out of view and no longer a prospect is taken back (nobody sees it go)
    for (let k = 0; k < hs.length; k++) {
      const H = hs[k], p = H.ped;
      if (p && !p._lock && p._ci < 0) this.unbind(H, Math.hypot(p.x - cx, p.z - cz));
    }
    // 4. the winners, best score first, each in a body of its own template: a free one, else one taken from a worse
    //    prospect (out of view too), else none -- the next body grown (growHeroes) is of that template
    let free = budget - bound;
    this.poolWant = null;
    for (let c = 0; c < cand.length; c++) {
      const p = cand[c];
      if (free <= 0) { if (p.hero) this.unbind(p.hero, Math.hypot(p.x - cx, p.z - cz)); continue; }
      if (p.hero) { free--; continue; }
      const want = p.pk !== undefined ? p.pk : poolKey(p);
      if (!want) continue;
      let H = null;
      for (let k = 0; k < hs.length && !H; k++) { const G = hs[k]; if (!G.ped && G.conf === want && G.det >= LOD0_DETAIL_MIN) H = G; }
      if (!H) for (let k = 0; k < hs.length && !H; k++) {
        const G = hs[k];
        if (!G.ped || G.ped._lock || G.conf !== want || G.det < LOD0_DETAIL_MIN || G.ped._ci <= c) continue;
        this.unbind(G, Math.hypot(G.ped.x - cx, G.ped.z - cz)); H = G;
      }
      if (!H) { this.poolWant = this.poolWant || want; continue; }
      this.bind(H, p, Math.hypot(p.x - cx, p.z - cz));
      free--;
    }
    if (cut) this.cutFree--;
  },

  // in view: inside SWAP_D with the body's sphere cutting the frustum -- where a swap would be seen
  inView(p, d) {
    if (d >= this.swapD) return false;
    _sph2.center.set(p.x, p.gy + 0.9 * p.scale, p.z);
    return _frustum.intersectsSphere(_sph2);
  },

  bind(H, p, d) {
    this.noteSwap(p, d, 1);
    H.ped = p; p.hero = H; H.h.group.visible = true; H.h.frozenPose = true; H.lastUse = H.boundAt = this.tNow || 0;
    if (H.sc) { if (this.scanR) this.scanR.bindBody(H, p); return; }
    this.retintHero(H, p);
  },

  unbind(H, d) {
    const p = H.ped;
    if (p) { this.noteSwap(p, d, 0); p.hero = null; p._lock = false; }
    H.ped = null; H.h.group.visible = false; H.lastUse = this.tNow || 0;
    if (H.sc) { if (this.scanR) this.scanR.unbindBody(H); return; }
    this.parkHero(H);
  },

  // the swap ledger the crowd-pop probe reads: a bind or unbind inside 30 m with the body in the frustum counts as an
  // appearance swap in view (a cut pass is logged apart: the cut hides it)
  noteSwap(p, d, on) {
    const S = this.swaps;
    S.n++;
    if (d >= 30 || !this._bindFrustum) return;
    _sph2.center.set(p.x, p.gy + 0.9 * p.scale, p.z);
    if (!_frustum.intersectsSphere(_sph2)) return;
    if (this.cutFree > 0) { S.cut++; return; }
    if (p.fade < 0.05) { S.hidden = (S.hidden || 0) + 1; return; }   // (a body swapped while faded out is not seen)
    S.inView++;
    if (d < 14) S.inView14++;
    if (S.log.length < 48) S.log.push(`${on ? 'bind' : 'unbind'} #${p.index} ${p.kind}/${p.lookK} d=${d.toFixed(1)} t=${(this.tNow || 0).toFixed(1)}`);
  },

  // Bound bodies: transform, pose, tint, accessories and the shadow budget
  updateHeroes(t) {
    const hs = this.heroes;
    if (!hs.length) return;
    const cam = this.engine.camera, cx = cam.position.x, cz = cam.position.z;
    // only the closest few bodies are allowed into the shadow pass: a caster costs its whole draw list again
    // at night the moon's cascade cannot resolve a body anyway (the contact decal grounds it): no pool casters
    let cut = 0;
    if (LOD0_SHADOW_N > 0 && nightK(this.engine.time.hour) < 0.9) {
      const hd = this.heroD;
      let nd = 0;
      for (let k = 0; k < hs.length; k++) { const p = hs[k].ped; if (p) hd[nd++] = Math.hypot(p.x - cx, p.z - cz); }
      if (nd > LOD0_SHADOW_N) {                               // partial selection: nth smallest, no allocation
        cut = LOD0_SHADOW;
        for (let i = 0; i < nd; i++) {
          let over = 0;
          for (let j = 0; j < nd; j++) if (hd[j] < hd[i]) over++;
          if (over === LOD0_SHADOW_N - 1) { cut = Math.min(hd[i], LOD0_SHADOW); break; }
        }
      } else cut = LOD0_SHADOW;
    }
    let any = false;
    for (let k = 0; k < hs.length; k++) {
      const H = hs[k], p = H.ped;
      if (!p) continue;
      // going through a door or a portal: the part rig dissolves it, so the real body hands over at once
      if (p.dfade < 0.9) { this.unbind(H, Math.hypot(p.x - cx, p.z - cz)); continue; }
      any = true;
      const g = H.h.group;
      g.position.set(p.x, p.gy, p.z);
      g.rotation.set(0, p.yaw, 0);
      g.scale.setScalar(p.scale * RIG_CROWN / H.bindH);
      // the twin's own girth: the pelvis (and so the whole body) is widened across to p.wide from the girth the body
      // was built with, the neck and head scaled back so the head stays the head the face was painted for
      const w = H.wide = clamp(p.wide / (H.build || 1), 0.9, 1.1);
      if (!H.scan) { H.h.bones.Hips.scale.set(w, 1, w); H.h.bones.Neck.scale.set(1 / w, 1, 1 / w); }
      H.h.skinned.castShadow = cut > 0 && Math.hypot(p.x - cx, p.z - cz) <= cut;
      H.h.frozenPose = true;
      this.poseHero(H, p);
      // the twin's neon tint and light: cloth and hair take the garment tint, skin the skin tint scaled to the
      // twin's own skin tone (the pool body's face atlas is one of four tones)
      const tc = p._tC;
      for (const M of H.mats) {
        if (tc) {
          if (M.kind === 'skin') M.m.color.setRGB(tc[6] * p.cSkin.r / SKIN_LIN[0], tc[7] * p.cSkin.g / SKIN_LIN[1], tc[8] * p.cSkin.b / SKIN_LIN[2]);
          else if (M.kind === 'hair') M.m.color.setRGB(tc[0] * p.cHair.r * 1.4, tc[1] * p.cHair.g * 1.4, tc[2] * p.cHair.b * 1.4);
          else M.m.color.setRGB(M.base.r * tc[0], M.base.g * tc[1], M.base.b * tc[2]);
        }
        // the character shader's extra lights, this frame's values from the shared originals, scaled for the pool
        if (M.lit) {
          const u = M.src;
          M.lit.sky.value.copy(u.uHemiSky.value).multiplyScalar(POOL_HEMI_K);
          M.lit.gnd.value.copy(u.uHemiGnd.value).multiplyScalar(POOL_GND_K);
          M.lit.keyK.value.set(u.uKeyK.value.x * POOL_KEY_K, u.uKeyK.value.y * POOL_RIM_K, u.uKeyK.value.z);
        }
      }
    }
    if (!any) return;
    for (let k = 0; k < hs.length; k++) { const H = hs[k]; if (H.ped) this.heroProps(H, H.ped, t); }
  },

  // Set every bone of a pool body from its twin's segment rotations (captured in writeMatrices, world space with
  // the yaw in them). Limbs: W = Q_seg * R0 * B -- the bind frame turned to hang straight down, then turned like
  // the part rig's segment. Torso: pelvis / spine / chest share the lean and counter-twist; neck halfway to the head.
  // Then plain FK over the bind offsets finds the lowest sole and the hips are dropped onto the ground.
  poseHero(H, p) {
    const R = H.rig, B = H.h.bones, W = _W;
    _qy.setFromAxisAngle(UPY, -p.yaw);
    const tw = H.twist, ln = H.lean, rl = H.roll, st = H.shoTw || 0;
    // pelvis turns with the swinging leg, the chest the other way (shoulder counter-rotation)
    W.Hips = heroRot(tw, ln * 0.25, rl * 0.5, W.Hips || new THREE.Quaternion()).multiply(R.W.Hips);
    W.Spine = heroRot(tw * 0.35 + st * 0.2, ln * 0.55, rl * 0.2, W.Spine || new THREE.Quaternion()).multiply(R.W.Spine);
    W.Spine1 = heroRot(st * 0.6, ln * 0.85, 0, W.Spine1 || new THREE.Quaternion()).multiply(R.W.Spine1);
    W.Spine2 = heroRot(st, ln, -rl * 0.7, W.Spine2 || new THREE.Quaternion()).multiply(R.W.Spine2);
    const qh = (W.Head || (W.Head = new THREE.Quaternion())).copy(_qy).multiply(H.qHead);
    W.Neck = (W.Neck || new THREE.Quaternion()).copy(W.Spine2).multiply(_qa.copy(R.W.Spine2).invert()).slerp(qh, 0.5).multiply(R.W.Neck);
    qh.multiply(R.W.Head);
    for (let side = 0; side < 2; side++) {
      const S = SIDE_BONES[side];
      (W[S.Shoulder] || (W[S.Shoulder] = new THREE.Quaternion())).copy(W.Spine2).multiply(_qa.copy(R.W.Spine2).invert()).multiply(R.W[S.Shoulder]);
      heroLimb(W, R, S.Arm, H.qUarm[side], true);
      heroLimb(W, R, S.ForeArm, H.qFarm[side], true);
      heroLimb(W, R, S.Hand, H.qFarm[side], true);
      // the bind hand hangs palm-forward (a shop-window mannequin): pronate it toward the thigh, part at the
      // wrist, part down the forearm so the sleeve does not corkscrew
      const pr = (side === 0 ? 1 : -1) * (H.pron || 0);
      heroTwist(W, S.ForeArm, pr * 0.45); heroTwist(W, S.Hand, pr);
      heroLimb(W, R, S.UpLeg, H.qThigh[side], true);
      heroLimb(W, R, S.Leg, H.qShin[side], true);
      heroLimb(W, R, S.Foot, H.qFoot[side], false);
      // the toes stay on the ground while the heel comes up
      _e.setFromQuaternion(_qb.copy(_qy).multiply(H.qFoot[side]), 'YXZ');
      heroRot(_e.y, Math.min(_e.x, 0.06), 0, _qc);
      (W[S.ToeBase] || (W[S.ToeBase] = new THREE.Quaternion())).copy(_qc).multiply(R.W[S.ToeBase]);
    }
    // local = W(parent)^-1 * W(bone); positions by FK over the bind offsets
    const P = _P;
    for (const n of BONE_ORDER) {
      const b = B[n]; if (!b || !W[n]) continue;
      const par = RIG_PARENT[n];
      if (par) {
        b.quaternion.copy(_qa.copy(W[par]).invert().multiply(W[n]));
        (P[n] || (P[n] = new THREE.Vector3())).copy(R.L[n].p).applyQuaternion(W[par]).add(P[par]);
      } else {
        b.quaternion.copy(W[n]);
        (P[n] || (P[n] = new THREE.Vector3())).copy(R.L[n].p);
      }
    }
    // the pelvis is scaled across (updateHeroes): every joint moves out from the hip line with it
    const wk = H.wide || 1;
    if (wk !== 1) for (const n of BONE_ORDER) { const q = P[n]; if (!q || n === 'Hips') continue; q.x = P.Hips.x + (q.x - P.Hips.x) * wk; q.z = P.Hips.z + (q.z - P.Hips.z) * wk; }
    // the lowest sole, each judged against the terrain under it (the slope along and across the body)
    let low = Infinity;
    const ga = p._gA || 0, gsd = p._gS || 0;
    for (let side = 0; side < 2; side++) {
      const so = side ? R.soles.Right : R.soles.Left, fN = side ? 'RightFoot' : 'LeftFoot', tN = side ? 'RightToeBase' : 'LeftToeBase';
      _v.copy(so.heel).applyQuaternion(W[fN]).add(P[fN]); low = Math.min(low, _v.y - ga * _v.z - gsd * _v.x);
      _v.copy(so.ball).applyQuaternion(W[fN]).add(P[fN]); low = Math.min(low, _v.y - ga * _v.z - gsd * _v.x);
      _v.copy(so.tip).applyQuaternion(W[tN]).add(P[tN]); low = Math.min(low, _v.y - ga * _v.z - gsd * _v.x);
    }
    const hb = B.Hips, dy = R.ground - low;
    hb.position.copy(R.L.Hips.p);
    hb.position.x += H.sway; hb.position.y += dy;
    heroGrip(H, W, P, 'RightHand', dy, H.gripR || (H.gripR = new THREE.Vector3()));
    heroGrip(H, W, P, 'LeftHand', dy, H.gripL || (H.gripL = new THREE.Vector3()));
  },

  // the phone, the flyer, the placard, the furled umbrella or the 警杖 in the real hand; the bag on the real back;
  // long hair or a cap on the real head
  heroProps(H, p, t) {
    const h = H.h, s = this.slotOf[p.index];
    if (!H.gripR || s >= this.nHand) return;
    const sc = p.scale, yaw = p.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // body space -> world: the group's scale, yaw and position
    const gs = h.group.scale.x, gR = H.gripR, gL = H.gripL;
    this._hx = p.x + (gR.x * rx + gR.z * fx) * gs; this._hy = p.gy + gR.y * gs; this._hz = p.z + (gR.x * rz + gR.z * fz) * gs;
    this._lx = p.x + (gL.x * rx + gL.z * fx) * gs; this._ly = p.gy + gL.y * gs; this._lz = p.z + (gL.x * rz + gL.z * fz) * gs;
    _hq.copy(H.qFarm[1]);
    const pose = p.moving ? -1 : p.idlePose;
    const foldUmb = this.umbFold.count > 0 && p.umb && p.umbWet2 && !H.holdUmb && !p.phone;
    this.writeHandProps(s, p, sc, pose, H.holdUmb, foldUmb, this.phoneGlow.count > 0, this.engine.camera.position.x, this.engine.camera.position.z, yaw, fx, fz, rx, rz, this.engine.time.weather === 'rain');
    this.heroAcc(H, p, t);
  },

  // bag / long hair / cap as real meshes on the pool body's own bones (built with the body, re-coloured on bind)
  heroAccBuild(H) {
    const B = H.h.bones, A = H.acc, G = this.heroGeo || (this.heroGeo = this.buildHeroGeo());
    const mk = (key, geo, mat, bone) => {
      const m = new THREE.Mesh(geo, mat); m.name = 'crowd:heroAcc:' + key; m.castShadow = false; m.receiveShadow = true; m.visible = false;
      B[bone].add(m); A[key] = m;
    };
    mk('backpack', G.backpack, this.heroMat(0x202020, 0.55, false), 'Spine2'); mk('shoulder', G.shoulder, this.heroMat(0x202020, 0.55, false), 'Spine2');
    // hair takes the crowd's own strand shader (clumps, a sheen band, ends broken clump by clump): the plain
    // material made a woman's long hair a flat brown board from behind
    // (a pool head is 60-200 px wide: 30 clumps round it are under two pixels each and average to a flat board, so
    // the pool's hair has 9 -- the part rig's 30 are for a 10-40 px head)
    const hairMat = () => { const hm = this.mats.hair, m = hm.clone(); m.onBeforeCompile = hm.onBeforeCompile; m.customProgramCacheKey = hm.customProgramCacheKey; m.defines = { ...(m.defines || {}), CROWD_HAIR_F: '9.0' }; return m; };
    mk('hairLong', G.hairLong, hairMat(), 'Head'); mk('cap', G.cap, this.heroMat(0x202020, 0.78, false), 'Head');
    mk('hairBun', G.hairBun, hairMat(), 'Head');
    // the hair mass: a shell fitted to this body's head (see buildHairShell)
    try {
      const g = this.buildHairShell(H);
      if (g) {
        mk('hairShell', g, hairMat(), 'Head');
        A.hairShell.matrixAutoUpdate = false; A.hairShell.matrix.identity();
      }
    } catch (e) { console.warn('[crowd] pool hair shell: ' + e.message); }
  },

  // The pool body's own hair ('ped' / 'short' / 'slick') is a thin alpha-strand cap: from behind, at 3-5 m, its
  // strand clumps sat on a bald skin nape and read as a second face (eyebrows on the back of the skull). This is a
  // solid hair mass fitted to THIS body's head: every lattice direction from the skull centre takes the furthest
  // skin / hair vertex within 12 degrees plus 4-7 mm, the cap covers wherever the body's own hair is, and behind the
  // ears it is carried down to the nape, 6 cm above the collar. Built in the Head bone's bind frame (boneInverse),
  // so it is parented to the bone with an identity transform and follows the skinned head exactly. aEdge runs 0 at
  // the crown to 1 at the hairline, where the strand shader ends it clump by clump instead of with a ruler edge.
  buildHairShell(H) {
    const h = H.h, sk = h.skinned, g = sk.geometry, pos = g.attributes.position, idx = g.index;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const mats = Array.isArray(sk.material) ? sk.material : [sk.material];
    const bones = h.skeleton.bones, hi = bones.indexOf(h.bones.Head);
    if (hi < 0 || !si) return null;
    const pts = [], isHair = [];
    let x0 = 9, x1 = -9, y1 = -9, z0 = 9, z1 = -9, cTop = -9;
    const seen = new Uint8Array(pos.count);
    for (const gr of g.groups) {
      const nm = (mats[gr.materialIndex] && mats[gr.materialIndex].name) || '';
      const hair = nm.indexOf('hair') === 0, skin = nm.indexOf('skin') === 0, cloth = !hair && !skin;
      for (let k = gr.start, e = gr.start + gr.count; k < e; k++) {
        const i = idx.getX(k); if (seen[i]) continue; seen[i] = 1;
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        // the collar at the back of the neck: the highest garment vertex on the spine line
        if (cloth && Math.abs(x) < 0.04 && z < -0.02 && y > 1.3 && y < 1.62) cTop = Math.max(cTop, y);
        if (cloth) continue;
        let wh = 0;
        for (let j = 0; j < 4; j++) if (si.getComponent(i, j) === hi) wh += sw.getComponent(i, j);
        if (wh < 0.4 && !hair) continue;
        pts.push(x, y, z); isHair.push(hair ? 1 : 0);
        if (hair) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      }
    }
    if (x1 < x0) return null;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2 - 0.004, cy = y1 - 0.118;
    const napeY = (cTop > 1 ? cTop : cy - 0.16) + 0.06 + (H.neckDrop || 0);
    const NA = 28, NE = 16, EL0 = Math.PI / 2, EL1 = -1.25, win = Math.cos(12 * Math.PI / 180);
    const n = pts.length / 3, R = new Float32Array((NA + 1) * (NE + 1)).fill(-1);
    const dir = (a, el, out) => out.set(Math.cos(el) * Math.sin(a), Math.sin(el), Math.cos(el) * Math.cos(a));
    const u = new THREE.Vector3(), d = new THREE.Vector3();
    for (let r = 0; r <= NE; r++) for (let c = 0; c <= NA; c++) {
      const el = EL0 + (EL1 - EL0) * (r / NE), a = -Math.PI + 2 * Math.PI * (c / NA);
      dir(a, el, u);
      let best = -1;
      for (let k = 0; k < n; k++) {
        d.set(pts[k * 3] - cx, pts[k * 3 + 1] - cy, pts[k * 3 + 2] - cz);
        const l = d.length(); if (l < 1e-4) continue;
        const cs = d.dot(u) / l;
        if (cs < win) continue;
        const pr = l * cs;
        if (pr > best) best = pr;
      }
      R[r * (NA + 1) + c] = best;
    }
    // per column: the lowest row the shell reaches. The hairline is explicit, not "wherever the body's hair is":
    // the fringe at the front (the body's own hair, never below the brow), above the ear at the sides, and behind
    // the ears sweeping down to the nape. (Following the hair hits alone let the sides creep down over the cheeks
    // and the shell read as a helmet.)
    let fringe = 9;
    for (let k = 0; k < n; k++) if (isHair[k] && pts[k * 3 + 2] - cz > 0.04 && Math.abs(pts[k * 3] - cx) < 0.06) fringe = Math.min(fringe, pts[k * 3 + 1]);
    const frontY = Math.max(fringe < 9 ? fringe : cy + 0.05, cy + 0.035), earY = cy + 0.028;
    const low = new Int32Array(NA + 1);
    for (let c = 0; c <= NA; c++) {
      const a = Math.abs(-Math.PI + 2 * Math.PI * (c / NA)) * 180 / Math.PI;
      const hy = a < 45 ? frontY : a < 85 ? frontY + (earY - frontY) * sstep(45, 85, a) : a < 110 ? earY : a < 140 ? earY + (napeY - earY) * sstep(110, 140, a) : napeY;
      let lr = 1;
      for (let r = 1; r <= NE; r++) {
        const el = EL0 + (EL1 - EL0) * (r / NE), y = cy + Math.sin(el) * Math.max(0.05, R[r * (NA + 1) + c]);
        if (y >= hy - 0.004) lr = r; else break;
      }
      low[c] = lr;
    }
    // fill the directions no vertex answered from the ring above
    for (let r = 0; r <= NE; r++) for (let c = 0; c <= NA; c++) {
      const k = r * (NA + 1) + c;
      if (R[k] > 0) continue;
      R[k] = r > 0 ? R[(r - 1) * (NA + 1) + c] : 0.1;
    }
    const P = [], C = [], E = [], I = [], vid = new Int32Array((NA + 1) * (NE + 1)).fill(-1);
    for (let c = 0; c <= NA; c++) {
      const a = -Math.PI + 2 * Math.PI * (c / NA), back = Math.abs(a) / Math.PI;
      for (let r = 0; r <= low[c]; r++) {
        const el = EL0 + (EL1 - EL0) * (r / NE), k = r * (NA + 1) + c;
        const t = r / Math.max(1, low[c]);
        const off = 0.0022 + 0.0055 * back * back + 0.0015 * t;   // hugs the body's own cut in front, fuller behind
        dir(a, el, u);
        const rr = R[k] + off;
        vid[k] = P.length / 3;
        P.push(cx + u.x * rr, cy + u.y * rr, cz + u.z * rr);
        // value: a sheen band just behind the crown, the ends and the nape in shade
        const v = (0.66 + 0.34 * Math.exp(-Math.pow((el - 1.05) / 0.35, 2))) * (1 - 0.32 * t * t);
        C.push(v, v, v); E.push(t * t * t);   // only the last row breaks up: a short cut ends in a soft line, not in locks
      }
    }
    for (let c = 0; c < NA; c++) for (let r = 0; r < NE; r++) {
      const a = vid[r * (NA + 1) + c], b = vid[r * (NA + 1) + c + 1], cc = vid[(r + 1) * (NA + 1) + c], dd = vid[(r + 1) * (NA + 1) + c + 1];
      if (a < 0 || b < 0) continue;
      if (cc >= 0 && dd >= 0) I.push(a, cc, b, b, cc, dd);
      else if (cc >= 0) I.push(a, cc, b);
      else if (dd >= 0) I.push(a, dd, b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(E, 1));
    geo.setIndex(I);
    geo.computeVertexNormals();
    geo.applyMatrix4(h.skeleton.boneInverses[hi]);
    geo.computeBoundingSphere();
    return geo;
  },

  heroAcc(H, p, t) {
    const A = H.acc, R = H.rig, tc = p._tC || TC_ONE;
    // torso space -> Spine2 bone space at bind: undo the bone's bind rotation, offset by its bind joint position
    const ks = (H.height / H.base) / 1.8;
    const bp = A.backpack, sb = A.shoulder;
    bp.visible = p.bagKind === 2; sb.visible = p.bagKind === 1;
    // the pool body is ~6 cm taller in the shoulder than the part rig the bag geometry was authored on
    const dy = R.P.RightArm.y - (R.ground + 1.395 * ks);
    const ph = p.phase + p.phaseOff, mv = p.moving ? clamp((p.vel || 0) / 1.3, 0, 1.3) : 0;
    // the backpack's front face rides on the body's own back (measured at Spine2, whatever the build), and sags a
    // few centimetres toward the side of the leg that is swinging through
    if (bp.visible) {
      accSpine(bp, R, ks, 0.03 * mv * Math.sin(ph), R.ground + dy * 0.8 - 0.012 * mv * Math.abs(Math.cos(ph)), R.backZ + 0.13 * ks + 0.004);
      bp.material.color.setRGB(p.cBag.r * tc[0], p.cBag.g * tc[1], p.cBag.b * tc[2]);
    }
    if (sb.visible) {
      // the strap sits on the trapezius, the bag against the side of the hip just behind its centre line
      accSpine(sb, R, ks, -(R.hipX * 0.62), R.P.RightArm.y + 0.055, -0.02);
      _qa.setFromAxisAngle(RIGHTX, mv * 0.10 * Math.sin(ph - 0.9));
      // turned about the strap so the bag body rides behind the hip, where the arm swings past it
      _qb.setFromAxisAngle(UPY, -0.45).multiply(_q2.setFromAxisAngle(FWDZ, -(0.06 + R.hipX * 0.25) - mv * 0.03 * Math.abs(Math.sin(ph - 0.9)))).multiply(_qa);
      sb.quaternion.multiply(_qb);
      sb.material.color.setRGB(p.cBag.r * tc[0], p.cBag.g * tc[1], p.cBag.b * tc[2]);
    }
    // head space: the part rig's skull centre (y 1.658) onto the pool body's own skull centre (measured off its crown)
    const hl = A.hairLong, cp = A.cap, hs = A.hairShell, bn = A.hairBun;
    // a scan wears its own hair (and the vest man his own cap): the part rig's cap sat a hand clear of a scanned crown
    hl.visible = p.hairKind === 1 && !H.scan; cp.visible = !!p.cCap && !H.scan; bn.visible = p.hairKind === 2 && !H.scan;
    // a dyed (light) head is taken down a little: at 4 m a light brown shell over a skin-toned face reads as a scalp
    const hk = (p.cHair.r + p.cHair.g + p.cHair.b > 0.12 ? 0.8 : 1.1);
    if (hl.visible) { accHead(hl, R, 1.04, 0.004); hl.material.color.setRGB(p.cHair.r * tc[0] * hk, p.cHair.g * tc[1] * hk, p.cHair.b * tc[2] * hk); }
    if (bn.visible) { accHead(bn, R, 1.0, 0.0); bn.material.color.setRGB(p.cHair.r * tc[0] * hk, p.cHair.g * tc[1] * hk, p.cHair.b * tc[2] * hk); }
    if (cp.visible) { accHead(cp, R, p.capS, 0.006, p.capS * (p.police ? 1.22 : 1)); cp.material.color.setRGB(p.cCap.r * tc[0], p.cCap.g * tc[1], p.cCap.b * tc[2]); }
    if (hs) { hs.visible = true; hs.material.color.setRGB(p.cHair.r * tc[0] * hk, p.cHair.g * tc[1] * hk, p.cHair.b * tc[2] * hk); }
  },

  heroMat(color, roughness, dbl) {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02, vertexColors: true, side: dbl ? THREE.DoubleSide : THREE.FrontSide });
    m.onBeforeCompile = this.knee; m.customProgramCacheKey = () => 'crowd-heroacc' + (dbl ? 2 : 1);
    return m;
  },

  // the accessory geometries split out of the packed instanced ones (plain meshes: no per-instance kind attribute)
  buildHeroGeo() {
    const G = this.G, out = {};
    const part = (src, k) => {
      const kind = src.attributes.aKind.array, pos = src.attributes.position, nor = src.attributes.normal, col = src.attributes.color;
      const P = [], N = [], C = [];
      for (let i = 0; i < pos.count; i++) if (kind[i] === k) { P.push(pos.getX(i), pos.getY(i), pos.getZ(i)); N.push(nor.getX(i), nor.getY(i), nor.getZ(i)); C.push(col.getX(i), col.getY(i), col.getZ(i)); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      return g;
    };
    out.shoulder = part(G.bag, 0); out.backpack = part(G.bag, 1);
    const plain = (src) => { const g = new THREE.BufferGeometry(); for (const k of ['position', 'normal', 'color']) if (src.attributes[k]) g.setAttribute(k, src.attributes[k]); if (src.index) g.setIndex(src.index); return g; };
    out.cap = plain(G.cap);
    // Long hair for a real head: one shell from the crown over the whole skull, open for the face, down past the
    // ears at the sides and to the shoulders behind, flaring a little at the ends; value falls from a sheen band at
    // the crown to the shaded ends. (The part rig's curtain on a real head was a flat black box.)
    {
      const SA = 20, SR = 9, P = [], C = [], I = [];
      for (let j = 0; j <= SA; j++) {
        const a = (j / SA) * Math.PI * 2, u = Math.abs(wrapPi(a)) / Math.PI;           // 0 front, 1 back
        const bot = u < 0.26 ? 1.742 - (u / 0.26) * 0.21 : 1.532 - Math.pow((u - 0.26) / 0.74, 0.8) * 0.16;
        for (let i = 0; i <= SR; i++) {
          const t = i / SR, y = 1.775 + (bot - 1.775) * t;
          const dy = y - 1.662, sk = 0.111 * Math.sqrt(Math.max(0, 1 - (dy / 0.116) * (dy / 0.116)));
          const r = y > 1.662 ? Math.max(sk, 0.006) + 0.006 : 0.117 + (1.662 - y) * (u > 0.4 ? 0.10 : 0.02);
          P.push(r * Math.sin(a), y, -0.004 + r * Math.cos(a) * (Math.cos(a) > 0 ? 0.96 : 1.06));
          const v = (0.62 + 0.38 * Math.exp(-Math.pow((y - 1.735) / 0.03, 2))) * (1 - 0.35 * t * t);
          C.push(v, v, v);
        }
      }
      for (let j = 0; j < SA; j++) for (let i = 0; i < SR; i++) {
        const a0 = j * (SR + 1) + i, b0 = (j + 1) * (SR + 1) + i;
        I.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      // 0 at the crown, 1 at the ends: the strand shader breaks the ends up clump by clump
      const E = new Float32Array(P.length / 3);
      for (let j = 0; j <= SA; j++) for (let i = 0; i <= SR; i++) E[j * (SR + 1) + i] = i / SR;
      g.setAttribute('aEdge', new THREE.BufferAttribute(E, 1));
      g.setIndex(I); g.computeVertexNormals();
      out.hairLong = g;
    }
    return out;
  },

  // ---- uniform 2 m grid separation over a window around the camera
  separate(dt) {
    const peds = this.peds, order = this.order, n = Math.min(this.visible, this.count);
    const head = this.gHead, next = this.gNext, sx = this.sepX, sz = this.sepZ;
    head.fill(-1);
    const cam = this.engine.camera;
    const ox = cam.position.x - GRID_N * GRID_CELL * 0.5, oz = cam.position.z - GRID_N * GRID_CELL * 0.5;
    for (let s = 0; s < n; s++) {
      const p = peds[order[s]];
      sx[s] = 0; sz[s] = 0;
      const cx = ((p.x - ox) / GRID_CELL) | 0, cz = ((p.z - oz) / GRID_CELL) | 0;
      if (cx < 0 || cz < 0 || cx >= GRID_N || cz >= GRID_N) { next[s] = -2; continue; }
      const c = cz * GRID_N + cx;
      next[s] = head[c]; head[c] = s;
    }
    this.gOX = ox; this.gOZ = oz; this.gReady = true;
    const push = 2.0 * dt, coh = 0.35 * dt;
    for (let s = 0; s < n; s++) {
      if (next[s] === -2) continue;
      const p = peds[order[s]];
      const cx = ((p.x - ox) / GRID_CELL) | 0, cz = ((p.z - oz) / GRID_CELL) | 0;
      for (let j = -1; j <= 1; j++) {
        const zz = cz + j; if (zz < 0 || zz >= GRID_N) continue;
        for (let k = -1; k <= 1; k++) {
          const xx = cx + k; if (xx < 0 || xx >= GRID_N) continue;
          for (let o = head[zz * GRID_N + xx]; o >= 0; o = next[o]) {
            if (o <= s) continue;
            const q = peds[order[o]];
            let dx = q.x - p.x, dz = q.z - p.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < 1e-6) continue;
            // friends: they close up to ~0.7 m (shoulder to shoulder with a hand's gap) and are never shoved apart
            // by each other past that
            const mates = p.grp && p.grp === q.grp;
            if (mates) {
              if (d2 > 0.8 * 0.8 && d2 < COH_R * COH_R && p.moving && q.moving && p.kind === 'crosser') {
                const d = Math.sqrt(d2), f = (d - 0.72) * coh / d;
                sx[s] += dx * f; sz[s] += dz * f; sx[o] -= dx * f; sz[o] -= dz * f;
              }
              if (d2 >= 0.56 * 0.56) continue;
            } else if (d2 >= SEP_R * SEP_R) continue;
            const d = Math.sqrt(d2), R = mates ? 0.56 : SEP_R;
            dx /= d; dz /= d;
            let f = (1 - d / R) * push;
            // oncoming pair: bias each to its own right so the two streams part instead of merging
            if (p.moving && q.moving) {
              const dot = Math.sin(p.yaw) * Math.sin(q.yaw) + Math.cos(p.yaw) * Math.cos(q.yaw);
              if (dot < -0.3) { const rx = Math.cos(p.yaw) * f * 0.8, rz = -Math.sin(p.yaw) * f * 0.8; sx[s] -= rx; sz[s] -= rz; sx[o] += rx; sz[o] += rz; f *= 0.7; }
            }
            // who gives way: the one walking (a standing person shoved at 0.3-0.6 m/s on planted feet was a slide);
            // two standing people only ease apart
            const mp = p.moving ? 1 : 0.25, mq = q.moving ? 1 : 0.25, fp = 2 * mp / (mp + mq), fq = 2 * mq / (mp + mq);
            if (!p.moving && !q.moving) f *= 0.4;
            sx[s] -= dx * f * fp; sz[s] -= dz * f * fp; sx[o] += dx * f * fq; sz[o] += dz * f * fq;
          }
        }
      }
    }
    const stillV = SEP_STILL_V * dt;
    for (let s = 0; s < n; s++) {
      if (next[s] === -2) continue;
      const p = peds[order[s]];
      // someone standing is nudged, never slid: at most SEP_STILL_V, a weight shift (the walker gives way, above)
      if (!p.moving) { const m = Math.hypot(sx[s], sz[s]); if (m > stillV) { sx[s] *= stillV / m; sz[s] *= stillV / m; } }
      if (p.kind === 'walker' && !p.gawk) {                    // path-bound: take the impulse on the lateral axis
        if (p.turn > 0) continue;
        const half = p.path.width / 2 - 0.2;
        p.lat = clamp(p.lat + (sx[s] * p.nx + sz[s] * p.nz) * 0.9, -half, half);
      } else {
        p.x += sx[s]; p.z += sz[s];
        // a walker shoved sideways turns into the dodge and steps with it instead of crab-sliding on planted feet
        if (p.moving && p.vel > 0.2 && dt > 0) {
          const lv = (sx[s] * Math.cos(p.yaw) - sz[s] * Math.sin(p.yaw)) / dt;     // + = toward the body's left
          p.yaw += clamp(Math.atan2(lv, p.vel) * 0.6 * Math.min(1, dt * 12), -YAW_RATE * dt * 0.5, YAW_RATE * dt * 0.5);
          advance(p, Math.abs(lv) * 0.5, dt);
        }
      }
    }
    if (MOTION_DBG) { this.mdDiff('separate'); this.mdSnap(); }
    this.vehiclePush(n, ox, oz);
    if (MOTION_DBG) this.mdDiff('vehiclePush');
  },

  // Vehicles are statics as far as the crowd is concerned: 3-5 capsule proxies per nearby car go into a second
  // grid of the same geometry, and peds are pushed clear of the inflated OBB instead of standing on the roof.
  vehiclePush(n, ox, oz) {
    const tr = this.engine.get('traffic');
    const cars = tr && tr.cars;
    if (!cars || !cars.length) { this.nVeh = 0; return; }
    const head = this.vHead, next = this.vNext, vx = this.vX, vz = this.vZ, vr = this.vR;
    const cam = this.engine.camera, cx0 = cam.position.x, cz0 = cam.position.z;
    head.fill(-1);
    let nv = 0;
    for (let i = 0; i < cars.length && nv < this.vCap - 5; i++) {
      const c = cars[i];
      if (Math.abs(c.x - cx0) > 70 || Math.abs(c.z - cz0) > 70) continue;
      const K = VDIM[c.kind] || VDIM.car;
      const w = K[0], l = K[1];
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      const np = l > 7 ? 5 : 3, span = l - w;
      for (let k = 0; k < np; k++) {
        const u = (k / (np - 1) - 0.5) * span;
        const x = c.x + fx * u, z = c.z + fz * u;
        const gx = ((x - ox) / GRID_CELL) | 0, gz = ((z - oz) / GRID_CELL) | 0;
        if (gx < 0 || gz < 0 || gx >= GRID_N || gz >= GRID_N) continue;
        vx[nv] = x; vz[nv] = z; vr[nv] = w * 0.5 + VEH_PAD;
        const ci = gz * GRID_N + gx;
        next[nv] = head[ci]; head[ci] = nv; nv++;
      }
    }
    this.nVeh = nv;
    if (!nv) return;
    const peds = this.peds, order = this.order;
    for (let s = 0; s < n; s++) {
      const p = peds[order[s]];
      const gx = ((p.x - ox) / GRID_CELL) | 0, gz = ((p.z - oz) / GRID_CELL) | 0;
      if (gx < 1 || gz < 1 || gx >= GRID_N - 1 || gz >= GRID_N - 1) continue;
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          for (let o = head[(gz + j) * GRID_N + gx + k]; o >= 0; o = next[o]) {
            const r = vr[o] + 0.22;
            let dx = p.x - vx[o], dz = p.z - vz[o];
            const d2 = dx * dx + dz * dz;
            if (d2 >= r * r) continue;
            const d = Math.sqrt(d2) || 1e-3;
            const push = r - d;
            dx /= d; dz /= d;
            if (p.kind === 'walker' && !p.gawk) { p.lat = clamp(p.lat + (dx * p.nx + dz * p.nz) * push, -9, 9); continue; }
            p.x += dx * push; p.z += dz * push;
            if (p.kind === 'crosser' && p.state === 'cross') {
              p.detX = clamp(p.detX + dx * push * 5, -3, 3);
              p.detZ = clamp(p.detZ + dz * push * 5, -3, 3);
            } else if (p.stroll) { p.hx = p.x; p.hz = p.z; }
            else if (p.kind === 'idler' || p.state === 'wait') { p.tx = p.x; p.tz = p.z; p.hx = p.x; p.hz = p.z; }
          }
        }
      }
    }
  },

  // ---- distance sort: packs instance slots so InstancedMesh.count culls, and refreshes the neon tint
  resort() {
    const engine = this.engine, peds = this.peds, N = this.count;
    const cam = engine.camera;
    this.resortT = 0; this.camAt.copy(cam.position);
    (this.camFw || (this.camFw = new THREE.Vector3())).copy(cam.getWorldDirection(_v));
    cam.updateMatrixWorld();
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    const key = this.key, order = this.order, slotOf = this.slotOf;
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    // Fixed-bucket radix pass. A closure sort over 3 051 elements ran once every 0.38 s / 2.5 m of camera
    // travel and was the frame hitch behind the 28.6 ms frame / 8.7 ms render gap; counting-sorting 0.25 m
    // buckets is O(N) and the bucket width is far below any LOD threshold that reads the order.
    const bk = this.bucket, cnt = this.bCount;
    cnt.fill(0);
    for (let i = 0; i < N; i++) {
      const p = peds[i];
      let d = Math.hypot(p.x - cx, p.z - cz, (p.gy + 0.9 * p.scale) - cy);
      // the koban officers are a landmark of the square: on the full rig (vest bands, cap, 警杖) out to ~34 m
      if (p.police && d < 34) d = Math.max(0.5, d - 12);
      _sph.center.set(p.x, p.gy + 0.9 * p.scale, p.z);
      let b;
      if (d > CULL) { key[i] = 1e7 + d; b = NB_TOTAL - 1; }
      else if (_frustum.intersectsSphere(_sph)) { key[i] = d; b = (d * 4) | 0; if (b >= NB_VIS) b = NB_VIS - 1; }
      else { key[i] = 1e6 + d; b = NB_VIS + ((d * 2) | 0); if (b >= NB_TOTAL - 1) b = NB_TOTAL - 2; }
      bk[i] = b; cnt[b]++;
    }
    let acc = 0;
    for (let b = 0; b < NB_TOTAL; b++) { const c = cnt[b]; cnt[b] = acc; acc += c; }
    for (let i = 0; i < N; i++) { const s = cnt[bk[i]]++; order[s] = i; slotOf[i] = s; }
    let nVis = 0, nFull = 0;
    while (nVis < N && nVis < MAX_VIS && key[order[nVis]] < 1e6) nVis++;
    while (nFull < nVis && nFull < MAX_FULL && key[order[nFull]] < FULL_D) nFull++;
    let nMid = 0, nHand = 0;
    while (nMid < nVis && nMid < DET_N && key[order[nMid]] < DET_D) nMid++;
    if (nFull > nMid) nFull = nMid;
    while (nHand < nFull && key[order[nHand]] < HAND_D) nHand++;
    let hf = nHand;
    while (hf < nVis && key[order[hf]] < HALF_D) hf++;
    let f2 = nMid;
    while (f2 < nVis && key[order[f2]] < FAR2_D) f2++;
    this.halfFrom = hf; this._fullWrite = true; this.far2From = f2;
    this.visible = nVis; this.full = nFull; this.mid = nMid; this.nHand = nHand;
    this.far.count = f2 - nMid; this.far2.count = nVis - f2;
    this.farRefl.count = Math.min(nVis, REFL_N);
    for (const m of this.tierAll) m.count = nVis;
    this.contact.count = f2; this.smear.count = f2;
    for (const m of this.tierMid) m.count = nMid;
    for (const m of this.tierHand) m.count = nHand;
    for (const m of this.tierNear) m.count = nFull;
    // dry street: no umbrellas and no wet smear, so those four meshes cost nothing at all
    const wet = engine.time.wet || 0, rainy = engine.time.weather === 'rain';
    if (!rainy && wet < 0.3) { this.umbrella.count = 0; this.umbrellaV.count = 0; this.umbFold.count = 0; }
    else if (rainy) this.umbFold.count = 0;        // in rain every carrier has it up: the furled mesh is dead
    else { this.umbrella.count = 0; this.umbrellaV.count = 0; }   // after the rain they are all furled
    if (wet < 0.12) this.smear.count = 0;
    if (nightK(engine.time.hour) < 0.25) this.phoneGlow.count = 0;      // daylight: the screen spill costs nothing
    // at night the cascade only has the moon to work with and the contact decals carry the grounding: the nearest
    // two dozen still cast, the other 60 were 32 k triangles of shadow pass nobody could see
    this.castN = nightK(engine.time.hour) > 0.9 ? CAST_N_NIGHT : CAST_N;
    this.sunShadow();
    if (this.scanR) this.refreshRims(nVis);
    else this.refreshColors(nVis);
    this.bindHeroes();
  },

  // the scanned crowd's share of refreshColors: only the neon rim (the brightest emitter near each visible person).
  // No albedo tint -- the scans wear their own clothes in their own colours.
  refreshRims(n) {
    const night = nightK(this.engine.time.hour), peds = this.peds, order = this.order;
    this.kneeU.value = clamp((night - 0.2) / 0.6, 0, 1);
    for (let s = 0; s < n; s++) {
      const p = peds[order[s]], pr = p._rim || (p._rim = new Float32Array(3));
      if (((s + this.frame) & 3) !== 0 && p._rimT) continue;              // a rolling quarter; the lights do not move
      pr[0] = 0; pr[1] = 0; pr[2] = 0; p._rimT = 1;
      if (night > 0.08) this.emitter(p, night, pr);
    }
  },

  // blob shadows lean away from the sun and stretch as it drops; straight underfoot at night
  sunShadow() {
    const lg = this.engine.get('lighting');
    const ld = lg && lg.csm && lg.csm.lightDirection;
    const night = nightK(this.engine.time.hour);
    this.nightBlob = clamp((night - 0.35) / 0.45, 0, 1);
    if (!ld || night > 0.92) { this.sunYaw = 0; this.sunLen = 1; this.sunOX = 0; this.sunOZ = 0; return; }
    const h = Math.hypot(ld.x, ld.z) || 1e-3;
    const len = clamp(1 / Math.max(0.2, Math.abs(ld.y)), 1, 2.4);
    this.sunYaw = Math.atan2(ld.x / h, ld.z / h);
    this.sunLen = 1 + (len - 1) * (1 - night);
    const off = this.sunLen * 0.55 * (1 - night);   // must clear the body silhouette, not hide under it
    this.sunOX = ld.x / h * off; this.sunOZ = ld.z / h * off;
  },

  // base albedo x night drop x the pool lights around the pedestrian, folded into the per-instance tint AND
  // into an aRim edge term. Parts that always carry the same tone share one instanceColor buffer, so this is
  // 12 writes and 12 uploads rather than round 1's 23 and 24; a slot whose pedestrian has not changed is
  // refreshed on a rolling quarter instead of every resort.
  refreshColors(n) {
    const engine = this.engine;
    const lighting = engine.get('lighting');
    const pool = lighting && lighting.pool;
    const night = nightK(engine.time.hour);
    // The albedo is the albedo at every hour: the LIGHTS do the darkening. Round 2 pulled it down 20 % at
    // night and then bought the loss back with a material-wide emissive and a flat rim add -- a multiply
    // traded for an add, which is exactly the operation that flattens a crowd into one tone.
    const albedo = 1;
    const peds = this.peds, order = this.order;
    const wet = engine.time.wet || 0;
    // Round 1 traded the decals away against the wet mirror and shipped neither: shade collapsed to 0.19 at
    // night+wet and the nearest 84 to a 6.5 % multiply, so every foreground body floated. The decal is
    // narrowed to a footprint under the planted foot in writeMatrices instead, which leaves the mirror room
    // without giving up ground contact, and the value goes back up.
    const shade = Math.max(0.50, 0.78 - 0.22 * night);
    const full = this._colFull !== 0 || Math.abs(night - (this._cNight || 0)) > 0.02 || Math.abs(wet - (this._cWet || 0)) > 0.04;
    this._colFull = 0; this._cNight = night; this._cWet = wet;
    const q = this.frame & 3;
    const colPed = this.colPed, faceOff = this.faceOff.array, rim = this.rim.array;
    const cT = this.cTorso, cS = this.cSkinB, cH = this.cHairB, cL = this.cLegB, cSh = this.cShoeB,
      cU = this.cUarmB, cF = this.cFarmB, cUm = this.cUmbB, cSn = this.cShinB,
      iSh = this.iShape, iSt = this.iStyle, iHm = this.iHem, iIn = this.iInner, iAc = this.iAcc, iAr = this.iArm, iLg = this.iLeg, iSo = this.iSole,
      cBl = this.cBlobB, cCo = this.cContactB, cSm = this.cSmearB;
    let er = 0, eg = 0, eb = 0;
    const nDet = this.mid || 0, f2From = this.far2From != null ? this.far2From : n;
    this.kneeU.value = clamp((night - 0.2) / 0.6, 0, 1);
    for (let s = 0; s < n; s++) {
      const i = order[s], p = peds[i], isFar = s >= nDet;
      if (!isFar && !full && colPed[s] === i && (s & 3) !== q) continue;
      let tr = albedo, tg = albedo, tb = albedo, rr = 0, rg = 0, rb = 0, sr = albedo, sg = albedo, sb = albedo;
      // far slots are re-packed every resort (their instance index is slot - nDet), so they are always written,
      // but the pool sum behind their tint is only re-run on a rolling quarter
      const reuse = isFar && !full && p._tC && ((i + this.frame) & 3) !== 0;
      const pr = p._rim || (p._rim = new Float32Array(3));
      if (reuse) { const c = p._tC; tr = c[0]; tg = c[1]; tb = c[2]; rr = c[3]; rg = c[4]; rb = c[5]; sr = c[6]; sg = c[7]; sb = c[8]; }
      else { pr[0] = 0; pr[1] = 0; pr[2] = 0; }
      if (!reuse && night > 0.08) this.emitter(p, night, pr);
      else if (night > 0.08 && pool) {
        let nr = 0, ng = 0, nb = 0, ws = 0, cr = 0, cg = 0, cb = 0, cw = 0, fr = 0, fg = 0, fb = 0;
        for (let k = 0; k < pool.length; k++) {
          const L = pool[k].light;
          if (L.intensity <= 0.01) continue;
          const dx = L.position.x - p.x, dy = L.position.y - (p.gy + 1.1 * p.scale), dz = L.position.z - p.z;
          // true inverse-square with a small softening radius: standing 4 m under the STARBEANS frontage has
          // to look different from standing 20 m from it, which a flat +12 denominator could not express
          const d2 = dx * dx + dy * dy + dz * dz;
          const w = L.intensity / (d2 + 3.0);
          if (w < 0.003) continue;
          const lr = L.color.r, lg = L.color.g, lb = L.color.b;
          nr += lr * w; ng += lg * w; nb += lb * w; ws += w;
          // a pool light is a real PointLight: inside its range it already lights these materials, and lifting
          // the albedo from it as well counted it twice (the glowing heads by the vending machine). Only the light
          // from beyond a source's cut-off range may lift the albedo.
          if (L.distance > 0 && d2 < L.distance * L.distance) { } else { fr += lr * w; fg += lg * w; fb += lb * w; }
          // second accumulator, weighted by each source's own SATURATION. Two thirds of the pool are white
          // 128 cd shopfronts, so the plain sum normalises to near-white for every pedestrian in the frame
          // and the whole crowd catches one identical tint. The white sources set how MUCH light a body gets;
          // the pink neon two doors down is what sets what COLOUR it is, and that is the Shibuya read.
          const lmx = lr > lg ? (lr > lb ? lr : lb) : (lg > lb ? lg : lb);
          const lmn = lr < lg ? (lr < lb ? lr : lb) : (lg < lb ? lg : lb);
          if (lmx > 1e-4) {
            const sat = (lmx - lmn) / lmx;
            if (sat > 0.10) { const k2 = w * sat; cr += lr * k2; cg += lg * k2; cb += lb * k2; cw += k2; }
          }
        }
        const mx = Math.max(nr, ng, nb);
        if (mx > 1e-4) {
          const inv = 1 / mx;
          let ar = nr * inv, ag = ng * inv, ab = nb * inv;
          if (cw > 1e-5) {
            const cm = 1 / (Math.max(cr, cg, cb) || 1);
            const k3 = clamp((cw / (ws || 1)) * 2.4, 0, 0.82);     // how much of the nearby light is coloured
            ar += (cr * cm - ar) * k3; ag += (cg * cm - ag) * k3; ab += (cb * cm - ab) * k3;
            const am = 1 / (Math.max(ar, ag, ab) || 1);
            ar *= am; ag *= am; ab *= am;
          }
          // Luminance is a MULTIPLY on the albedo (mean-1 chroma push x a saturating gain), never an add to
          // the framebuffer: a navy suit under a magenta sign goes magenta-navy and stays dark.
          const avg = (ar + ag + ab) / 3;
          const ch = 0.92 * night * clamp(mx * 5, 0, 1);
          const mf = Math.max(fr, fg, fb);
          const lum = 0.66 * (mf / (mf + 10)) * night;
          tr = clamp((tr + ar * lum) * (1 + (ar - avg) * ch), 0, 1.45);
          tg = clamp((tg + ag * lum) * (1 + (ag - avg) * ch), 0, 1.45);
          tb = clamp((tb + ab * lum) * (1 + (ab - avg) * ch), 0, 1.45);
          // Skin takes the light but only 40 % of the neon chroma push, and no night lift: round 4 brightened it
          // 22 % on top of the push and every bare hand in the square glowed like a tangerine mitten
          const chS = ch * 0.4, lumS = lum * 0.6;
          sr = clamp((sr + ar * lumS) * (1 + (ar - avg) * chS), 0, 1.15);
          sg = clamp((sg + ag * lumS) * (1 + (ag - avg) * chS), 0, 1.15);
          sb = clamp((sb + ab * lumS) * (1 + (ab - avg) * chS), 0, 1.15);
          // the rim is what separates a 30 m body from the frontage behind it; at 3 m the real shading carries
          // the form and a full-strength rim drew a glowing outline round every near figure
          // ...and under 6 m none at all: the thin yellow outline round a jacket at 3-4 m was this term
          const rk = 0.95 * (mx / (mx + 9)) * night;
          rr = ar * rk; rg = ag * rk; rb = ab * rk;
          if (s < 120) { er += ar; eg += ag; eb += ab; }
        }
      }
      if (!reuse) { const c = p._tC || (p._tC = new Float32Array(9)); c[0] = tr; c[1] = tg; c[2] = tb; c[3] = rr; c[4] = rg; c[5] = rb; c[6] = sr; c[7] = sg; c[8] = sb; }
      const o = s * 3;
      // multiply-blended blob; standing in a shopfront's light it is lighter (and smaller: decals) -- under a bright
      // frontage the full pad read as a mannequin's black stand
      const g = 1 - shade * p.blobK * (p.inLight && !p.moving ? 0.55 : 1);
      cBl[o] = g; cBl[o + 1] = g; cBl[o + 2] = g * 1.02;
      const hc = 1 - (0.78 - 0.26 * wet) * p.blobK;                   // the hard patch sells weight
      cCo[o] = hc; cCo[o + 1] = hc; cCo[o + 2] = hc * 1.02;
      const w2 = 1 - 0.16 * wet;
      cSm[o] = w2; cSm[o + 1] = w2; cSm[o + 2] = w2 * 1.03;
      if (s < REFL_N) this.writeFarCol(this.farReflBufs, s, p, tr, tg, tb, sr, sg, sb, rr, rg, rb);
      if (isFar) {
        colPed[s] = -1;                                               // the part-rig buffers at s are now stale
        if (s < f2From) this.writeFarCol(this.farBufs, s - nDet, p, tr, tg, tb, sr, sg, sb, rr, rg, rb);
        else this.writeFarCol(this.far2Bufs, s - f2From, p, tr, tg, tb, sr, sg, sb, rr, rg, rb);
        continue;
      }
      colPed[s] = i;
      const fo = FACE_OFF[p.face];
      faceOff[s * 2] = fo[0]; faceOff[s * 2 + 1] = fo[1];
      rim[o] = pr[0]; rim[o + 1] = pr[1]; rim[o + 2] = pr[2];
      cT[o] = p.cCloth.r * tr; cT[o + 1] = p.cCloth.g * tg; cT[o + 2] = p.cCloth.b * tb;
      // a phone screen is the brightest thing on that person in an unlit alley: their face and hands carry it
      const gl = p.phone && night > 0.3 ? 0.15 * night : 0;
      // a face points up and forward, so it catches the sky and the signage that a vertical torso does not.
      // A MULTIPLY, so the six skin tones keep their spread -- without it every head is a dark lump at 20 m.
      // clamped at 0.96: the head material multiplies this by a 0.80-linear face tile and the hands use it as
      // the albedo outright, so the un-clamped 1.39 this reached under a shopfront was a >1 reflectance --
      // a hand that returns more light than falls on it, i.e. a white glove
      cS[o] = Math.min(0.96, p.cSkin.r * sr + gl * 0.42);
      cS[o + 1] = Math.min(0.96, p.cSkin.g * sg + gl * 0.50);
      cS[o + 2] = Math.min(0.96, p.cSkin.b * sb + gl * 0.66);
      cH[o] = p.cHair.r * tr; cH[o + 1] = p.cHair.g * tg; cH[o + 2] = p.cHair.b * tb;
      cL[o] = p.cLeg.r * tr; cL[o + 1] = p.cLeg.g * tg; cL[o + 2] = p.cLeg.b * tb;
      if (p.shinSkin) { cSn[o] = p.cShin.r * sr; cSn[o + 1] = p.cShin.g * sg; cSn[o + 2] = p.cShin.b * sb; }
      else { cSn[o] = p.cShin.r * tr; cSn[o + 1] = p.cShin.g * tg; cSn[o + 2] = p.cShin.b * tb; }
      // garment: build, hem, neckline and what shows through it, skirt, sleeve length, bare calves, sole
      const O = p.O, o4 = s * 4;
      iSh[o4] = O.shape[0]; iSh[o4 + 1] = O.shape[1]; iSh[o4 + 2] = O.shape[2]; iSh[o4 + 3] = O.shape[3];
      iSt[o4] = O.vBot; iSt[o4 + 1] = O.vSlope; iSt[o4 + 2] = O.openW; iSt[o4 + 3] = O.tie;
      iHm[o4] = O.hemY; iHm[o4 + 1] = O.flare; iHm[o4 + 2] = O.skirtTop; iHm[o4 + 3] = O.drape + O.vest;
      iIn[o4] = p.cInner.r * tr; iIn[o4 + 1] = p.cInner.g * tg; iIn[o4 + 2] = p.cInner.b * tb;
      iAc[o] = p.cAcc.r * tr; iAc[o + 1] = p.cAcc.g * tg; iAc[o + 2] = p.cAcc.b * tb;
      iAr[o4] = Math.min(0.96, p.cSkin.r * sr); iAr[o4 + 1] = Math.min(0.96, p.cSkin.g * sg); iAr[o4 + 2] = Math.min(0.96, p.cSkin.b * sb); iAr[o4 + 3] = O.sleeveEnd;
      iLg[s] = O.legBare;
      this.iCard[s] = p.role === 2 || p.placard ? 1 : 0;
      iSo[o] = p.cSole.r * tr; iSo[o + 1] = p.cSole.g * tg; iSo[o + 2] = p.cSole.b * tb;
      cSh[o] = p.cShoe.r * tr; cSh[o + 1] = p.cShoe.g * tg; cSh[o + 2] = p.cShoe.b * tb;
      cU[o] = p.cSleeve.r * tr; cU[o + 1] = p.cSleeve.g * tg; cU[o + 2] = p.cSleeve.b * tb;
      if (p.bare) { cF[o] = p.cFarm.r * sr; cF[o + 1] = p.cFarm.g * sg; cF[o + 2] = p.cFarm.b * sb; }
      else { cF[o] = p.cFarm.r * tr; cF[o + 1] = p.cFarm.g * tg; cF[o + 2] = p.cFarm.b * tb; }
      cUm[o] = p.cUmb.r * tr; cUm[o + 1] = p.cUmb.g * tg; cUm[o + 2] = p.cUmb.b * tb;
    }
    // NO material-wide emissive on the garments. It is a per-material constant, so every one of 470 bodies
    // gets the identical add whatever it is wearing and wherever it is standing -- indistinguishable from a
    // flat ambient, and at 0.045 against a ~0.013 night garment it was 3.5x the albedo on its own. A black
    // silhouette in the unlit gap between two frontages is what a Shibuya night actually looks like; the
    // hemisphere + moon + env already keep it off pure black.
    const em = Math.max(er, eg, eb);
    const mats = this.mats;
    for (const m of [mats.cloth, mats.sleeve, mats.trouser, mats.leather]) m.emissiveIntensity = 0;
    // a wet canopy catches the signs around it instead of reading as a flat black faceted cone -- but a
    // whisper only: at 0.075 every umbrella in the frame rendered as a white tent (see crowd2 night shots)
    if (em > 1e-3) { mats.umb.emissive.setRGB(er / em, eg / em, eb / em); mats.umbV.emissive.setRGB(er / em, eg / em, eb / em); }
    mats.umb.emissiveIntensity = em > 1e-3 ? 0.016 * night : 0;
    // the vinyl one is the exception to the no-emissive rule and earns it: a clear dome held over a head on a
    // neon street IS lit from behind, and there is no transmission term in this material to express that
    mats.umbV.emissiveIntensity = em > 1e-3 ? 0.075 * night : 0;
    mats.glass.emissiveIntensity = 0.5 + 1.3 * night;
    // the spill is a halo on the hands and chin, not a light source: at 0.30 m / full opacity every phone in the
    // near field was a blue orb the size of a head
    mats.glow.opacity = clamp(night * 0.55 - 0.06, 0, 0.5);
    mats.skinPlain.emissiveIntensity = mats.skin.emissiveIntensity = 0;
    for (const a of this.colBufs) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 3); a.needsUpdate = true; }
    for (const a of this.instBufsA) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
    const up = (bufs, m) => { if (m > 0) for (const a of bufs) { a.clearUpdateRanges(); a.addUpdateRange(0, m * a.itemSize); a.needsUpdate = true; } };
    up(this.farBufs, Math.max(0, Math.min(n, f2From) - nDet));
    up(this.far2Bufs, Math.max(0, n - f2From));
    up(this.farReflBufs, Math.min(n, REFL_N));
    this.rim.clearUpdateRanges(); this.rim.addUpdateRange(0, n * 3); this.rim.needsUpdate = true;
    this.faceOff.clearUpdateRanges(); this.faceOff.addUpdateRange(0, n * 2); this.faceOff.needsUpdate = true;
  },

  // The brightest emitter near a pedestrian (lighting.js's fixture list: sign and screen spill, shopfronts,
  // lanterns, streetlights), weighted toward coloured sources -- the white streetlights set how much light a body
  // gets, the pink neon two doors down what colour it is. Writes the packed rim attribute (see rimPatch):
  // out[0] = sqrt-encoded colour x strength, out[1..2] = the horizontal direction to it. A 10 m grid, built once.
  emitter(p, night, out) {
    const L = this.engine.get('lighting'), fx = L && L.fixtures;
    if (!fx || !fx.length) return;
    let G = this.fixGrid;
    if (!G || G.n !== fx.length) {
      const C = 10, NN = 48, half = C * NN / 2, cells = new Array(NN * NN), F = new Float32Array(fx.length * 8);
      for (let k = 0; k < fx.length; k++) {
        const f = fx[k], c = f.color, mx = Math.max(c.r, c.g, c.b) || 1, mn = Math.min(c.r, c.g, c.b);
        F.set([f.pos.x, f.pos.y, f.pos.z, f.intensity || 0, c.r / mx, c.g / mx, c.b / mx, 0.35 + 0.65 * (mx - mn) / mx], k * 8);
        const gx = ((f.pos.x + half) / C) | 0, gz = ((f.pos.z + half) / C) | 0;
        if (gx < 0 || gz < 0 || gx >= NN || gz >= NN) continue;
        (cells[gz * NN + gx] || (cells[gz * NN + gx] = [])).push(k);
      }
      G = this.fixGrid = { n: fx.length, C, NN, half, cells, F };
    }
    const gx = ((p.x + G.half) / G.C) | 0, gz = ((p.z + G.half) / G.C) | 0, F = G.F, py = p.gy + 1.2 * p.scale;
    let best = -1, bw = 0;
    for (let j = -1; j <= 1; j++) {
      const zz = gz + j; if (zz < 0 || zz >= G.NN) continue;
      for (let k = -1; k <= 1; k++) {
        const xx = gx + k; if (xx < 0 || xx >= G.NN) continue;
        const list = G.cells[zz * G.NN + xx]; if (!list) continue;
        for (let q = 0; q < list.length; q++) {
          const o = list[q] * 8, dx = F[o] - p.x, dy = F[o + 1] - py, dz = F[o + 2] - p.z;
          const w = F[o + 3] * F[o + 7] / (dx * dx + dy * dy + dz * dz + 3);
          if (w > bw) { bw = w; best = o; }
        }
      }
    }
    if (best < 0 || bw < 0.02) return;
    const st = night * bw / (bw + 1.5), dx = F[best] - p.x, dz = F[best + 2] - p.z, dl = Math.hypot(dx, dz) || 1;
    const enc = (v) => Math.round(Math.sqrt(clamp(v * st * 0.6, 0, 1)) * 255);
    out[0] = enc(F[best + 4]) * 65536 + enc(F[best + 5]) * 256 + enc(F[best + 6]);
    out[1] = dx / dl; out[2] = dz / dl;
  },

  // one far-body instance's colours (far, far2 and the mirror mesh share the layout)
  writeFarCol(bufs, k, p, tr, tg, tb, sr, sg, sb, rr, rg, rb) {
    const fT = bufs[0].array, fL = bufs[1].array, fS = bufs[2].array, fH = bufs[3].array, fR = bufs[4].array;
    const k3 = k * 3, k4 = k * 4;
    // the far tier's own albedo floor (FAR_DARK_MIN): a navy back at 25 m is charcoal wool, not a hole
    farLift(p.cCloth.r * tr, p.cCloth.g * tg, p.cCloth.b * tb, fT, k4); fT[k4 + 3] = p.farVar;
    if (p.shinSkin) { fL[k4] = p.cShin.r * sr; fL[k4 + 1] = p.cShin.g * sg; fL[k4 + 2] = p.cShin.b * sb; }
    else farLift(p.cShin.r * tr, p.cShin.g * tg, p.cShin.b * tb, fL, k4);
    fS[k4] = Math.min(0.96, p.cSkin.r * sr); fS[k4 + 1] = Math.min(0.96, p.cSkin.g * sg); fS[k4 + 2] = Math.min(0.96, p.cSkin.b * sb);
    const hc = p.cCap || p.cHairFar || p.cHair;                     // a cap is what the far body's hair shell shows
    fH[k4] = hc.r * tr; fH[k4 + 1] = hc.g * tg; fH[k4 + 2] = hc.b * tb; fH[k4 + 3] = p.O.hemY;
    const pr = p._rim; fR[k3] = pr ? pr[0] : 0; fR[k3 + 1] = pr ? pr[1] : 0; fR[k3 + 2] = pr ? pr[2] : 0;
  },

  // ------------------------------------------------------------------------------------------ write matrices
  writeMatrices(t = 0) {
    const engine = this.engine, world = engine.world, peds = this.peds;
    const order = this.order, nVis = this.visible, nFull = this.full, nMid = this.mid || this.full;
    const f2From = this.far2From != null ? this.far2From : nVis, nRefl = this.farRefl.count;
    const raining = engine.time.weather === 'rain';
    const cam = engine.camera, camX = cam.position.x, camZ = cam.position.z;
    // canopies go up only in the rain; after it they are carried furled (round 5 keyed that on the open-canopy
    // mesh's count, which is 0 on a wet night, so the furled ones never showed)
    const umbOn = this.umbrella.count > 0, foldOn = this.umbFold.count > 0;
    const smearOn = this.smear.count > 0, glowOn = this.phoneGlow.count > 0;
    const dtf = 1 / 60;
    // past HALF_D (a body under ~110 px) each slot is re-posed every other frame, alternating by pedestrian, so
    // half of the 17-part composes and all their decals run at 30 Hz; a re-sort frame writes everyone, since a
    // skipped slot would still hold the matrices of whoever was packed there before
    const halfFrom = this._fullWrite ? nVis : this.halfFrom, par = this.frame & 1;
    this._fullWrite = false;
    const fLegA = this.fLeg.array, fSkinA = this.fSkin.array;
    const f2Leg = this.far2Bufs[1].array, f2Skin = this.far2Bufs[2].array, frLeg = this.farReflBufs[1].array, frSkin = this.farReflBufs[2].array;
    const hideA = this.hide, innA = this.iInner, fHair = this.fHair.array, f2Hair = this.far2Bufs[3].array, frHair = this.farReflBufs[3].array;
    for (let s = 0; s < nVis; s++) {
      const i = order[s], p = peds[i];
      if (s >= halfFrom && (i & 1) !== par && s >= nRefl && !p.hero) continue;
      if (world && (s < 80 || (i & 3) === (this.frame & 3))) {
        p.gyT = world.groundHeight(p.x, p.z);
        // the terrain's gradient under them (道玄坂 / 文化村通り): feet are planted against the slope, not the level
        if (SLOPED && p.gyT > 0.02 && groundY(p.x, p.z) > 0.002) { p.gX = groundY(p.x + 0.5, p.z) - groundY(p.x - 0.5, p.z); p.gZ = groundY(p.x, p.z + 0.5) - groundY(p.x, p.z - 0.5); }
        else p.gX = p.gZ = 0;
      }
      // a kerb is stepped down over a few frames; anything bigger (somebody coming into view half way up the hill
      // with last seen's height) is snapped, or they would rise out of the pavement
      if (Math.abs(p.gyT - p.gy) > 0.35) p.gy = p.gyT;
      p.gy += (p.gyT - p.gy) * Math.min(1, dtf * 12);
      { const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw), gx = p.gX || 0, gz = p.gZ || 0; p._gA = gx * sy + gz * cy; p._gS = gx * cy - gz * sy; }
      const gA = p._gA;
      const gy = p.gy;
      const H = p.hero;
      // LOD0 draws this one as a real body instead (the part rig goes to scale 0, its hand props stay drawn). A fade
      // is a dithered dissolve at full size: fading by scale shrank people to dolls on the pavement.
      const sc = H || p.fade <= 0.004 ? 0 : p.scale;
      hideA[s] = innA[s * 4 + 3] = H ? 0 : 1 - p.fade;
      // the ground decals are NOT gated on that fade: a body promoted to LOD0 still stands on the street -- unless
      // it carries its own per-foot contact, in which case ours was a second, detached stain trailing behind it
      const gsc = H ? (H.h.contact ? 0 : p.scale) : p.scale * p.fade;
      const near = s < nFull, mid = s < nMid;
      const ph = p.phase + p.phaseOff;                        // persistent offset: neighbours never re-phase
      const sw = Math.sin(ph), cw = Math.cos(ph);
      const moving = p.moving;
      // stride from the metres actually travelled (p.vel), the phase from the step length (see advance())
      const spd = moving ? Math.max(p.vel || 0, 0.22) : 0;
      const jog = moving && spd > 1.9;
      const stride = moving ? gaitStride(spd, jog) * p.strideK : 0;
      const pace = clamp(spd / 1.3, 0, 1.2);
      const swingK = jog ? 1.35 : 0.60 + 0.34 * pace, loadK = jog ? 0.30 : 0.08 + 0.14 * pace;
      const shock = this.shockT > 0 && Math.hypot(p.x - this.shockX, p.z - this.shockZ) < 6 ? this.shockT * 0.5 : 0;
      const idleW = Math.sin(t * 1.1 + p.fid) * 0.5 + 0.5;

      if (!mid || s < nRefl) {
        // far tier and the mirror: the root transform plus phase and stride; the vertex shader swings the limbs.
        // The scissor has no knee, so it is given a little more amplitude to read as a walk at 50-200 m.
        // a pool body is mirrored as a far body too: its own meshes stay off the mirror / bloom-mask layer
        // the cut body (past FAR2_D) on the Center-gai lane takes its own yaw and size jitter: a row of identical
        // heads at one height 40 m in read as a fence, not as depth (fix round 1)
        const jit = s >= f2From && p.path && p.path.id === 'centergai';
        const fscR = (p.fade <= 0.004 ? 0 : p.scale) * (jit ? p.farJs : 1), fh = p.O.hemY + 2 * Math.round((1 - p.fade) * 63);
        _q.setFromAxisAngle(UPY, p.yaw + (jit ? p.farJ : 0));
        _m.compose(_p.set(p.x, gy + (moving ? Math.abs(cw) * 0.018 * fscR : 0), p.z), _q, _s.set(fscR * p.wide, fscR, fscR * p.wide));
        const fst = moving ? stride * 1.1 : 0;
        if (s < nRefl) { this.farRefl.setMatrixAt(s, _m); frLeg[s * 4 + 3] = ph; frSkin[s * 4 + 3] = fst; frHair[s * 4 + 3] = fh; }
        if (!mid) {
          // a pedestrian bound to a pool body out here (the identity lock binds at the far body's hand-over) is the
          // pool body alone: its far body collapses, and it falls through to the full solve the body is posed from
          if (H) _m.makeScale(0, 0, 0);
          if (s < f2From) { const k = s - nMid; this.far.setMatrixAt(k, _m); fLegA[k * 4 + 3] = ph; fSkinA[k * 4 + 3] = fst; fHair[k * 4 + 3] = fh; }
          else { const k = s - f2From; this.far2.setMatrixAt(k, _m); f2Leg[k * 4 + 3] = ph; f2Skin[k * 4 + 3] = fst; f2Hair[k * 4 + 3] = fh; }
          if (!H) { this.decals(s, p, gy, gsc, moving, cw, false, p.x, gy + ANK_Y * p.scale, p.z, smearOn, camX, camZ); continue; }
        } else if (s >= halfFrom && (i & 1) !== par && !H) continue;
      }

      // ---- pseudo-IK: solve both soles first and hang the hips off the lower one, so feet plant instead of sinking
      let plant = p.stance === 1 ? 0 : 1, lo = 0, hipShift = 0, ws = 0;
      if (moving) {
        lo = 1e9;
        for (let side = 0; side < 2; side++) {
          const lp = side === 0 ? ph : ph + Math.PI;
          const u = (((lp - Math.PI / 2) / (Math.PI * 2)) % 1 + 1) % 1;
          const hipA = -Math.sin(lp) * stride;
          const knee = gaitKnee(u, swingK, loadK);
          const th = gaitFoot(u);
          const cs = Math.cos(th), sn = Math.sin(th);
          const low = (cs >= 0 ? SHOE_Y0 * cs : SHOE_Y1 * cs) - (sn >= 0 ? SHOE_Z1 * sn : SHOE_Z0 * sn);
          // each sole is judged against the ground under it: uphill the forward foot's ground is higher
          const ay = HIP_Y - THIGH * Math.cos(hipA) - SHIN * Math.cos(hipA + knee) + low + gA * (THIGH * Math.sin(hipA) + SHIN * Math.sin(hipA + knee));
          if (ay < lo) { lo = ay; plant = side; }
        }
        lo = clamp(lo, -0.12, 0.09);
      } else if (!p.attn) {
        // Contrapposto: the weight sits on one leg (ws = +1 side 0, -1 side 1), the pelvis over it, and moves
        // across to the other leg in under a second every 6-12 s (half of wPer).
        ws = Math.tanh(Math.sin(t * (6.2832 / p.wPer) + p.wPh) * 3.2);
        hipShift = ws * 0.034;
        plant = ws >= 0 ? 0 : 1;
      }
      const loaded = plant;

      const bobY = moving ? -lo : Math.sin(t * 1.4 + p.fid) * 0.006;
      const by = gy + (bobY - shock * 0.05) * sc;
      const yaw = p.yaw;
      const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const sway = moving ? cw * (jog ? 0.028 : 0.042) : hipShift;
      const bx = p.x + rx * sway * sc, bz = p.z + rz * sway * sc;

      _q.setFromAxisAngle(UPY, yaw);
      // torso: forward lean (stoop for the elderly, a duck on shock, a tout's bow) and the walk's counter-rotation --
      // the pelvis turns with the swinging leg, the shoulders ~0.08 rad the other way. The part rig's torso is one
      // piece, so it follows the chest (the silhouette's widest line); the pool body splits them bone by bone.
      const pelTw = moving ? -sw * (jog ? 0.10 : 0.075) : Math.sin(t * 0.9 + p.fid) * 0.02 - hipShift * 1.2;
      const shoTw = moving ? sw * (jog ? 0.10 : 0.08) : 0;
      const twist = moving ? shoTw * 0.8 : pelTw;
      // gasp: 0..1 envelope of the gallery's flinch on a heavy hit; about two in three of the ring react
      const gasp = p.gawk && !moving && this.gaspT > 0 && ((p.fid * 7) % 3) > 1 ? Math.sin(Math.min(1, this.gaspT / 0.9) * Math.PI) : 0;
      const lean = 0.055 + p.stoop + (moving ? (jog ? 0.13 : 0.03) + clamp(gA, -0.12, 0.12) * 0.7 : 0) + shock * 0.6 + (p.gawk && !moving ? p.gawk.lean : 0) - gasp * 0.12 + (p.bow || 0) - (p.attn ? 0.04 : 0);
      _qt.setFromAxisAngle(UPY, yaw + twist);
      _qa.setFromAxisAngle(RIGHTX, lean); _qt.multiply(_qa);
      if (p.gawk && !moving && p.gawk.roll) { _qa.setFromAxisAngle(FWDZ, p.gawk.roll); _qt.multiply(_qa); }
      // the pelvis rolls up on the loaded side and the column leans back over the feet
      const roll = moving ? 0 : ws * 0.07;
      if (roll) { _qa.setFromAxisAngle(FWDZ, roll * 0.5); _qt.multiply(_qa); }
      const wd = p.wide, wsc = sc * wd;
      // the lean pivots at the HIP, not at the soles: tilting the whole column about the ground slid the
      // collar 9-13 cm forward of the neck and left a bare pole of neck showing behind every stooped walker
      _v.set(0, HIP_Y * sc, 0).applyQuaternion(_qt);
      const tpx = bx - _v.x, tpy = by + HIP_Y * sc - _v.y, tpz = bz - _v.z;
      _s.set(wsc, sc, wsc);                                   // girth varies independently of height
      _m.compose(_p.set(tpx, tpy, tpz), _qt, _s); this.torso.setMatrixAt(s, _m);
      _s.set(sc, sc, sc);
      _v.set(0, 1.50 * sc, 0).applyQuaternion(_qt);
      const nkx = tpx + _v.x, nky = tpy + _v.y, nkz = tpz + _v.z;     // the collar: head and neck hang from here
      // head + neck ride the torso but keep the eyeline level. Everyone carries their own resting head angle
      // (no two heads share one pitch), idlers glance around, walkers look about now and then, and a walker in
      // company turns to the person beside them while they talk.
      let hy2 = p.headY, hpt = p.headP;
      if (!moving && !p.gawk) {
        const g0 = Math.sin(t * 0.23 + p.fid * 2.7);
        hy2 += (Math.abs(g0) > 0.86 ? Math.sign(g0) * (Math.abs(g0) - 0.86) / 0.14 : 0) * 0.55;
        // a file at the ticket gates is bored: heads turn to the departures board, the concourse, the phone
        if (p.queue && !p.phone) { hy2 += Math.sin(t * 0.37 + p.fid * 1.7) * 0.32; hpt += Math.sin(t * 0.29 + p.fid * 2.3) * 0.08 - 0.04; }
      } else if (moving) {
        const g1 = Math.sin(t * 0.31 + p.fid * 3.1);
        hy2 += (Math.abs(g1) > 0.9 ? Math.sign(g1) * (Math.abs(g1) - 0.9) / 0.1 : 0) * 0.45;
      }
      const mate = p.mate;
      if (mate && p.talk) {
        const e = Math.sin(t * 0.47 + p.fid * 2.3);
        if (e > 0.15) {
          const a = wrapPi(Math.atan2(mate.x - p.x, mate.z - p.z) - yaw);
          hy2 += clamp(a, -1.0, 1.0) * 0.8 * Math.min(1, (e - 0.15) * 3);
        }
      }
      const pose = moving ? -1 : p.idlePose;
      // eyes on the screen: a phone held to read pulls the head down ~17 degrees, which at 20 m is the whole read
      const reading = p.phone && !(umbOn && p.umb && raining) && (pose <= 0 || pose === 3);
      const readK = reading || pose === 3 ? 0.30 : 0;
      _qa.setFromAxisAngle(RIGHTX, lean * 0.25 + (moving ? -sw * 0.03 : 0) + (readK || hpt));
      // the head's total turn off the body is clamped (fix round 1, critic: resting angle + glance + mate-talk +
      // twist stacked to an owl neck at 3 m): +/-0.95 rad on the move, +/-1.1 standing, +/-0.75 on a pool body
      // (its painted face is not built to be turned on the lens at arm's length)
      const hyMax = H ? 0.75 : moving ? 0.95 : 1.1;
      _q2.setFromAxisAngle(UPY, yaw + clamp(twist * 0.25 + hy2, -hyMax, hyMax)).multiply(_qa);
      if (H) H.qHead.copy(_q2);
      const hk = p.headK || 1;                                // pivots at the collar (1.50 in head space)
      _v.set(0, 1.50 * sc * hk, 0).applyQuaternion(_q2);
      const hpx = nkx - _v.x, hpy = nky - _v.y, hpz = nkz - _v.z;
      _m.compose(_p.set(hpx, hpy, hpz), _q2, hk === 1 ? _s : _s.setScalar(sc * hk)); this.head.setMatrixAt(s, _m);
      this.hairCap.setMatrixAt(s, _m);
      if (hk !== 1) _s.setScalar(sc);
      if (H) { H.qTorso.copy(_qt); H.sway = sway; H.bob = bobY; H.twist = pelTw; H.shoTw = shoTw; H.lean = lean; H.roll = roll; }

      // ---- legs: hip -> knee -> ankle -> shoe, with knee flexion through the swing and a heel-strike roll
      let pfx = p.x, pfy = gy, pfz = p.z;
      const lw = p.O.legW;
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? 1 : -1;
        const lp = side === 0 ? ph : ph + Math.PI;
        let hipA, knee, splay = 0, toe = 0, footP;
        if (moving) {
          const u = (((lp - Math.PI / 2) / (Math.PI * 2)) % 1 + 1) % 1;
          hipA = -Math.sin(lp) * stride;
          knee = gaitKnee(u, swingK, loadK);
          footP = gaitFoot(u);
          toe = 0.06;
        } else if (p.attn) {
          hipA = 0; knee = 0.02; splay = -0.01; toe = 0.14; footP = 0;
        } else {
          // the loaded leg is straight and tucked under the body; the free one is bent 0.15-0.25 at the knee,
          // a little forward and out, heel just off the ground, its foot turned out
          const k = Math.abs(ws), free = side !== loaded;
          hipA = (free ? 0.03 + 0.07 * k : -0.02) + Math.sin(t * 0.8 + p.fid + side) * 0.010;
          knee = free ? 0.06 + (0.15 + 0.09 * idleW) * k : 0.03;
          splay = free ? 0.05 * k : -0.022 * k;
          toe = free ? 0.08 + 0.26 * k : 0.08;
          footP = free ? 0.04 + 0.14 * k : 0;
        }
        const hx = bx + rx * HIP_X * sgn * wsc, hz = bz + rz * HIP_X * sgn * wsc, hy = by + (HIP_Y + sgn * HIP_X * roll) * sc;
        _qa.setFromAxisAngle(FWDZ, splay * sgn); _q2.copy(_q).multiply(_qa);
        _qa.setFromAxisAngle(RIGHTX, hipA); _q2.multiply(_qa);
        if (H) H.qThigh[side].copy(_q2);
        _s.set(sc * lw, sc, sc * lw);
        _m.compose(_p.set(hx, hy, hz), _q2, _s);
        (side === 0 ? this.thighL : this.thighR).setMatrixAt(s, _m);
        _v.set(0, -THIGH * sc, 0).applyQuaternion(_q2);
        const kx = hx + _v.x, ky = hy + _v.y, kz = hz + _v.z;
        _qa.setFromAxisAngle(FWDZ, splay * sgn); _q2.copy(_q).multiply(_qa);
        _qa.setFromAxisAngle(RIGHTX, hipA + knee); _q2.multiply(_qa);
        if (H) H.qShin[side].copy(_q2);
        _m.compose(_p.set(kx, ky, kz), _q2, _s);
        (side === 0 ? this.shinL : this.shinR).setMatrixAt(s, _m);
        _s.set(sc, sc, sc);
        _v.set(0, -SHIN * sc, 0).applyQuaternion(_q2);
        const ax = kx + _v.x, ay = ky + _v.y, az = kz + _v.z;
        if (side === plant) { pfx = ax; pfy = ay; pfz = az; }
        _qa.setFromAxisAngle(UPY, toe * sgn); _q2.copy(_q).multiply(_qa);
        _qa.setFromAxisAngle(RIGHTX, footP); _q2.multiply(_qa);
        if (H) H.qFoot[side].copy(_q2);
        _m.compose(_p.set(ax, ay, az), _q2, _s);
        (side === 0 ? this.shoeL : this.shoeR).setMatrixAt(s, _m);
      }

      // ---- arms: shoulder pivot sits outside the torso hull, elbow always carries a bend, hand at the wrist
      const holdUmb = umbOn && p.umb && raining;
      const foldUmb = foldOn && p.umb && p.umbWet2 && !holdUmb && !p.phone;
      const cheer = pose === 9 ? Math.max(0, Math.sin(t * 2.3 + p.fid * 3)) : 0;
      // a standing group talks with its hands: a two-second gesture every few seconds, out of step with the others
      // a tout with somebody in range pitches harder: the gesture comes round every 2.5 s and holds longer
      const talk = (p.group || p.chat) && !moving
        ? (p.role === 1 && p.pitch ? Math.max(0, Math.sin(t * 2.4 + p.fid * 2.1) - 0.1) / 0.9 : Math.max(0, Math.sin(t * 0.55 + p.fid * 2.1) - 0.55) / 0.45) : 0;
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? 1 : -1;
        const right = side === 1;
        // abd = upper-arm abduction; a hanging arm clears the waist by a couple of centimetres, and that sliver of
        // daylight between arm and flank is one of the strongest "person" cues at 30 m
        let armA, elbow, zrF = -0.07 * sgn, abd = 0.10;
        if (moving && p.bike && right) { armA = -0.5; elbow = 0.35; zrF = -0.1 * sgn; abd = 0.12; }   // on the bike's grip
        else if (moving && jog) {
          armA = Math.sin(ph + (side === 0 ? 0 : Math.PI)) * 0.55; elbow = 1.30 + 0.20 * Math.sin(ph + side * Math.PI + 0.5); abd = 0.16; zrF = -0.18 * sgn;
        } else if (moving) {
          // contralateral: the left arm comes forward with the RIGHT leg (armA < 0 is forward). The swing never
          // drops under 0.22 rad however slow the walk, and the forearm bends on the forward swing -- straight arms
          // hanging within a few degrees of vertical read as legs walking a mannequin
          const back = Math.sin(ph + (side === 0 ? 0 : Math.PI));
          armA = back * Math.max(0.22, stride * 1.15) * (p.bike ? 0.4 : 1);
          elbow = 0.25 + 0.30 * Math.max(0, -back);
          abd = H ? 0.10 : 0.07;
        } else if (p.role === 2) {
          // a flyer / tissue pack held out toward the passer-by, the stack held at the waist in the other hand
          const e = p.ext;
          if (right) { armA = -0.16 - 0.80 * e; elbow = 1.78 - 1.40 * e; zrF = -0.30 * sgn; abd = 0.10 + 0.08 * e; }
          else { armA = -0.12; elbow = 1.62; zrF = -0.40 * sgn; }
        } else if (p.bike && right) { armA = -0.5; elbow = 0.35; zrF = -0.1 * sgn; abd = 0.12; }
        else if (pose === 1) { armA = 0.02; elbow = 1.95; zrF = -0.82 * sgn; }         // arms folded at the chest
        else if (pose === 2) { armA = H ? 0.12 : 0.05; elbow = H ? 0.52 : 0.45; zrF = (H ? -0.10 : -0.29) * sgn; abd = H ? 0.16 : 0.10; }   // hands in the front pockets
        else if (pose === 3) { armA = -0.10; elbow = 1.95; zrF = -0.32 * sgn; abd = 0.07; }   // phone held at the chest
        else if (pose === 4) {                                                           // filming: phone up at the face
          if (right) { armA = -1.05; elbow = 1.60; zrF = -0.365 * sgn; }
          else if (p.film2) { armA = -1.05; elbow = 1.59; zrF = -0.68 * sgn; }
          else { armA = 0.0; elbow = 0.20; }
        } else if (pose === 5) { abd = 0.50; armA = 0.24; elbow = 0.61; zrF = -0.68 * sgn; }   // hands on hips
        else if (pose === 6) {                                                           // a hand over the mouth
          if (right) { armA = 0.02; elbow = 1.95; zrF = -0.82 * sgn; }
          else { abd = 0.03; armA = -0.77; elbow = 2.58; zrF = -0.46 * sgn; }
        } else if (pose === 7 && right) { abd = 0.06; armA = -1.30; elbow = 0.14; zrF = 0; }          // pointing at it
        else if (pose === 9 && right) { abd = 0.20; armA = -1.9 - 0.9 * cheer; elbow = 0.95 - 0.55 * cheer; zrF = 0.1 * sgn; }  // fist up
        else if (pose === 10 && right) { abd = 0.305; armA = -1.25; elbow = 2.53; zrF = -0.559 * sgn; }  // phone at the ear
        else if (pose === 10) { armA = 0.02; elbow = 1.72; zrF = -0.70 * sgn; }                        // the other arm across the waist
        else if (pose === 11 && right) { abd = 0.08; armA = 0.20; elbow = 2.6; zrF = -0.25 * sgn; }    // a hand on the bag strap
        else if (pose === 12) {                                                          // officer at attention, 警杖 in the right hand
          if (right) { armA = -0.20; elbow = 0.50; zrF = 0.06 * sgn; abd = 0.13; }
          else { armA = 0.03; elbow = 0.14; zrF = -0.04 * sgn; abd = 0.06; }
        } else if (pose === 13) { armA = -0.22; elbow = 1.42; zrF = -0.60 * sgn; abd = 0.12; }  // placard held at the chest
        else {
          // relaxed: soft elbows (0.25-0.4), palms turned in, the arms close to the body -- an A-shape held off the
          // ribs is the shop-window mannequin -- and the arm on the loaded side hanging a touch behind the other.
          // A wide build or a flared coat needs a little more clearance; the pool body's own hips need more still.
          const onLoad = side === loaded;
          armA = (onLoad ? 0.05 : -0.05) + Math.sin(t * 0.85 + p.fid + side * 2) * 0.03;
          elbow = 0.25 + (p.elb - 0.25) * 0.6 + idleW * 0.05 + (onLoad ? 0 : 0.05);
          zrF = -0.16 * sgn;
          abd = H ? (onLoad ? 0.12 : 0.10) : clamp(0.045 + (p.wide - 1) * 0.12 + (p.O.shape[2] - 1) * 0.25 + (p.O.hemY < 0.75 ? (p.O.flare - 1) * 0.12 : 0), 0.04, 0.08) + (onLoad ? 0.01 : 0);
        }
        if (gasp > 0 && pose !== 4) {                                   // hands come up toward the face
          armA += (-0.55 - armA) * gasp; elbow += (2.1 - elbow) * gasp; zrF += (-0.35 * sgn - zrF) * gasp;
        }
        if (talk > 0 && (right ? p.stance > 0 : p.stance < 0) && pose !== 13) {
          const k = talk * talk * (3 - 2 * talk), wob = Math.sin(t * 3.1 + p.fid * 5);
          armA += (-0.35 - armA) * k; elbow += (1.35 + 0.25 * wob - elbow) * k; zrF += (-0.25 * sgn + 0.12 * wob * sgn - zrF) * k;
        }
        // the umbrella hand goes to chin height (~1.43 m), not down by the hip: the grip has to be up there or
        // the canopy hem lands on the skull and the whole thing reads as a conical straw hat
        if (right && holdUmb) { armA = -0.30; elbow = 2.45; zrF = -0.14 * sgn; abd = 0.10; }
        // reading on the move: the upper arm hangs at the side, the elbow folds and the phone comes up in front of
        // the sternum ~30 cm out, toward the midline -- not held out at arm's length
        else if (right && reading && pose <= 0) { armA = -0.10; elbow = 2.05; zrF = -0.36 * sgn; abd = 0.07; }
        else if (!right && reading && moving) { armA *= 0.75; elbow += 0.12; }
        // shoulders ride the torso (lean and walking twist included), so the sleeve stays on the shoulder line
        _v.set(SHO_X * sgn * wsc, SHO_Y * sc, 0).applyQuaternion(_qt);
        // ...and the shoulder line counter-rolls against the pelvis: the loaded side's shoulder drops
        const shx = tpx + _v.x, shy = tpy + _v.y - sgn * SHO_X * roll * 1.07 * sc, shz = tpz + _v.z;
        _qa.setFromAxisAngle(RIGHTX, armA);
        _q2.copy(_q).multiply(_qa);
        _qa.setFromAxisAngle(FWDZ, abd * sgn); _q2.multiply(_qa);
        if (H) H.qUarm[side].copy(_q2);
        _m.compose(_p.set(shx, shy, shz), _q2, _s);
        (side === 0 ? this.uarmL : this.uarmR).setMatrixAt(s, _m);
        _v.set(0, -UARM * sc, 0).applyQuaternion(_q2);
        const ex = shx + _v.x, ey = shy + _v.y, ez = shz + _v.z;
        _qa.setFromAxisAngle(RIGHTX, armA - elbow); _q2.copy(_q).multiply(_qa);
        _qa.setFromAxisAngle(FWDZ, zrF); _q2.multiply(_qa);
        if (H) H.qFarm[side].copy(_q2);
        _m.compose(_p.set(ex, ey, ez), _q2, _s);
        (side === 0 ? this.farmL : this.farmR).setMatrixAt(s, _m);
        (side === 0 ? this.handL : this.handR).setMatrixAt(s, _m);             // hand rides the forearm frame
        _v.set(0, -HAND_Y * sc, 0).applyQuaternion(_q2);
        if (right) { this._hx = ex + _v.x; this._hy = ey + _v.y; this._hz = ez + _v.z; _hq.copy(_q2); }
        else { this._lx = ex + _v.x; this._ly = ey + _v.y; this._lz = ez + _v.z; }
      }
      if (H) H.holdUmb = holdUmb;

      if (near && !H) this.writeHandProps(s, p, sc, pose, holdUmb, foldUmb, glowOn, camX, camZ, yaw, fx, fz, rx, rz, raining);

      if (H && gsc > 0) {
        // a pool body without its own contact: the pad goes under ITS planted foot (last frame's bones), not
        // under the part rig's, which walks a different cycle and left the pad sliding behind the heel
        const bn = H.h.bones, fl = bn && bn.LeftFoot, fr = bn && bn.RightFoot;
        if (fl && fr) {
          const le = fl.matrixWorld.elements, re = fr.matrixWorld.elements, useL = le[13] < re[13];
          pfx = useL ? le[12] : re[12]; pfz = useL ? le[14] : re[14]; pfy = gy + ANK_Y * p.scale;
        }
      }
      this.decals(s, p, gy, gsc, moving, cw, holdUmb, pfx, pfy, pfz, smearOn, camX, camZ);
      _s.set(sc, sc, sc);
    }
    this.writePacked(nMid, t);
    const up = (a, n, w) => { if (n > 0) { a.clearUpdateRanges(); a.addUpdateRange(0, n * w); a.needsUpdate = true; } };
    up(this.fLeg, this.far.count, 4); up(this.fSkin, this.far.count, 4);
    up(this.far2Bufs[1], this.far2.count, 4); up(this.far2Bufs[2], this.far2.count, 4);
    up(this.farReflBufs[1], this.farRefl.count, 4); up(this.farReflBufs[2], this.farRefl.count, 4);
    up(this.farRefl.instanceMatrix, this.farRefl.count, 16);
    up(this.hideA, nMid, 1); up(this.iInnerA, nMid, 4);
    up(this.fHair, this.far.count, 4); up(this.far2Bufs[3], this.far2.count, 4); up(this.farReflBufs[3], this.farRefl.count, 4);
    // upload only the packed head of each buffer, not all N instances
    for (const m of this.meshes) up(m.instanceMatrix, m.count, 16);
  },

  // phone / flyer / placard / furled umbrella / 警杖 and the open umbrella, in the hand the arm pose just placed
  writeHandProps(s, p, sc, pose, holdUmb, foldUmb, glowOn, camX, camZ, yaw, fx, fz, rx, rz, raining) {
    const filming = pose === 4, atEar = pose === 10, card = p.role === 2, placard = pose === 13;
    const hasPhone = !holdUmb && (p.phone || pose === 3 || filming || atEar || card || placard);
    let gx2 = 0, gy2 = 0, gz2 = 0;
    if (hasPhone && atEar) {
      // held against the cheek, screen to the face, the long edge running from the ear toward the mouth
      _q2.setFromAxisAngle(UPY, yaw + Math.PI / 2);
      _qa.setFromAxisAngle(FWDZ, 0.45); _q2.multiply(_qa);
      _m.compose(_p.set(this._hx, this._hy + 0.035 * sc, this._hz), _q2, _s.set(sc, sc, sc));
    } else if (hasPhone && filming) {
      _q2.setFromAxisAngle(UPY, yaw + Math.PI);                             // screen (+z) toward the holder
      _qa.setFromAxisAngle(RIGHTX, 0.14); _q2.multiply(_qa);
      let px = this._hx, py = this._hy + 0.05 * sc, pz = this._hz;
      if (p.film2) {
        px = (this._hx + this._lx) * 0.5; py = (this._hy + this._ly) * 0.5 + 0.035 * sc; pz = (this._hz + this._lz) * 0.5;
        _qa.setFromAxisAngle(FWDZ, Math.PI / 2); _q2.multiply(_qa);           // landscape between both hands
      }
      _m.compose(_p.set(px, py, pz), _q2, _s.set(sc, sc, sc));
      gx2 = px - fx * 0.05 * sc; gy2 = py; gz2 = pz - fz * 0.05 * sc;
    } else if (placard) {
      // an A4 menu board held flat against the chest between both hands, facing out
      _q2.setFromAxisAngle(UPY, yaw); _qa.setFromAxisAngle(RIGHTX, -0.12); _q2.multiply(_qa);
      _m.compose(_p.set((this._hx + this._lx) * 0.5 + fx * 0.02 * sc, (this._hy + this._ly) * 0.5 + 0.10 * sc, (this._hz + this._lz) * 0.5 + fz * 0.02 * sc), _q2, _s.set(sc * 2.9, sc * 2.2, sc * 0.6));
    } else if (card) {
      _qa.setFromAxisAngle(RIGHTX, -0.5); _q2.copy(_hq).multiply(_qa);
      _m.compose(_p.set(this._hx + fx * 0.02 * sc, this._hy, this._hz + fz * 0.02 * sc), _q2, _s.set(sc * 1.35, sc * 1.05, sc * 0.5));
    } else if (hasPhone) {
      // screen up toward the face: the phone lies in the palm, tilted back ~55 degrees from vertical
      _q2.setFromAxisAngle(UPY, yaw + Math.PI); _qa.setFromAxisAngle(RIGHTX, -0.95); _q2.multiply(_qa);
      _m.compose(_p.set(this._hx + fx * 0.015 * sc, this._hy + 0.02 * sc, this._hz + fz * 0.015 * sc), _q2, _s.set(sc, sc, sc));
      gx2 = this._hx + fx * 0.01 * sc; gy2 = this._hy + 0.06 * sc; gz2 = this._hz + fz * 0.01 * sc;
    } else _m.makeScale(0, 0, 0);
    this.phone.setMatrixAt(s, _m);
    // the screen's own spill: a small additive billboard at the screen, facing the lens
    if (hasPhone && glowOn && !atEar && !card && !placard) {
      _q2.setFromAxisAngle(UPY, Math.atan2(camX - gx2, camZ - gz2));
      const gk = sc * p.fade;                                   // the additive halo shrinks with a dissolving holder
      _m.compose(_p.set(gx2, gy2, gz2), _q2, _s.set(gk, gk, gk));
    } else _m.makeScale(0, 0, 0);
    this.phoneGlow.setMatrixAt(s, _m);
    // umbrella: the grip rides the ACTUAL right hand, so the shaft reads as held and the canopy hem lands
    // ~0.35 m clear of the skull. Leaned back a little so it covers the head rather than the chest.
    if (holdUmb) {
      const us = sc * p.umbSize;
      _q2.setFromAxisAngle(UPY, yaw + p.umbYaw);
      _qa.setFromAxisAngle(RIGHTX, -0.145 + p.umbTilt); _q2.multiply(_qa);
      _m.compose(_p.set(this._hx - rx * 0.03 * sc, this._hy, this._hz - rz * 0.03 * sc), _q2, _s.set(us, us, us));
      if (p.umbV) { this.umbrellaV.setMatrixAt(s, _m); _m.makeScale(0, 0, 0); this.umbrella.setMatrixAt(s, _m); }
      else { this.umbrella.setMatrixAt(s, _m); _m.makeScale(0, 0, 0); this.umbrellaV.setMatrixAt(s, _m); }
      this.umbFold.setMatrixAt(s, _m.makeScale(0, 0, 0));
    } else {
      _m.makeScale(0, 0, 0);
      this.umbrella.setMatrixAt(s, _m); this.umbrellaV.setMatrixAt(s, _m);
      if (pose === 12) {                                  // the officer's staff, grip in the hand, tip on the ground
        _q2.setFromAxisAngle(UPY, yaw);
        _m.compose(_p.set(this._hx + fx * 0.02 * sc, this._hy + 0.06 * sc, this._hz + fz * 0.02 * sc), _q2, _s.set(sc * 0.55, sc * 1.62, sc * 0.55));
      } else if (foldUmb) {                               // furled, hanging from the right hand, tip just off the ground
        _qa.setFromAxisAngle(RIGHTX, -0.24); _q2.setFromAxisAngle(UPY, yaw).multiply(_qa);
        _m.compose(_p.set(this._hx, this._hy + 0.02 * sc, this._hz), _q2, _s.set(sc, sc, sc));
      }
      this.umbFold.setMatrixAt(s, _m);
    }
    _s.set(sc, sc, sc);
  },

  // The packed accessories: long hair, buns and caps ride the head matrix, bags the torso matrix, both read back
  // from the part rig's own instance buffers (so a slot skipped at 30 Hz this frame still has last frame's pose).
  writePacked(nMid, t) {
    const peds = this.peds, order = this.order;
    const hm = this.head.instanceMatrix.array, tm = this.torso.instanceMatrix.array;
    const PL = this.pHairLong, PB = this.pHairBun, PC = this.pCap, PG = this.pBag;
    let nl = 0, nb = 0, nc = 0, ng = 0;
    const put = (P, k, src, o, p, col, rimK) => {
      const d = P.im.instanceMatrix.array, k16 = k * 16;
      for (let j = 0; j < 16; j++) d[k16 + j] = src[o + j];
      const tc = p._tC, k3 = k * 3;
      P.hide[k] = 1 - p.fade;
      P.col[k3] = col.r * (tc ? tc[0] : 1); P.col[k3 + 1] = col.g * (tc ? tc[1] : 1); P.col[k3 + 2] = col.b * (tc ? tc[2] : 1);
      if (P.rim) { const pr = p._rim; P.rim[k3] = pr && rimK ? pr[0] : 0; P.rim[k3 + 1] = pr ? pr[1] : 0; P.rim[k3 + 2] = pr ? pr[2] : 0; }
    };
    for (let s = 0; s < nMid; s++) {
      const p = peds[order[s]];
      if (p.hero || p.fade <= 0.01) continue;
      const o = s * 16;
      if (p.hairKind === 1) put(PL, nl++, hm, o, p, p.cHair, 1);
      else if (p.hairKind === 2) put(PB, nb++, hm, o, p, p.cHair, 1);
      if (p.cCap) {
        // scaled about the skull, not about head space's origin at the feet: that lifted every cap 3-8 cm off the
        // hair (and an officer's 1.22-tall cap 37 cm) so it floated over the head like a hovering saucer
        const sy = p.capS * (p.police ? 1.22 : 1);
        _m.fromArray(hm, o); _m2.makeScale(p.capS, sy, p.capS); _m2.elements[13] = 1.668 * (1 - sy); _m.multiply(_m2);
        _m.toArray(PC.im.instanceMatrix.array, nc * 16);
        PC.hide[nc] = 1 - p.fade;
        const tc = p._tC, k3 = nc * 3;
        PC.col[k3] = p.cCap.r * (tc ? tc[0] : 1); PC.col[k3 + 1] = p.cCap.g * (tc ? tc[1] : 1); PC.col[k3 + 2] = p.cCap.b * (tc ? tc[2] : 1);
        nc++;
      }
      if (p.bagKind === 1 || p.bagKind === 2) {
        _m.fromArray(tm, o);
        if (p.bagKind === 1) {
          // the shoulder bag hangs from its strap at the right shoulder and swings on the pelvis phase, lagged
          const ph = p.phase + p.phaseOff, mv = p.moving ? clamp((p.vel || 0) / 1.3, 0, 1.3) : 0;
          _qa.setFromAxisAngle(RIGHTX, mv * 0.10 * Math.sin(ph - 0.9));
          _q2.setFromAxisAngle(FWDZ, -0.07 - mv * 0.03 * Math.abs(Math.sin(ph - 0.9))).multiply(_qa);
          _m2.compose(_p.set(-0.172, 1.448, 0.0), _q2, _s.set(1, 1, 1));
          _m.multiply(_m2);
        } else if (p.moving) {
          // a backpack sways a couple of centimetres to the side of the leg swinging through, and settles on the step
          const ph = p.phase + p.phaseOff, mv = clamp((p.vel || 0) / 1.3, 0, 1.3);
          _m.multiply(_m2.makeTranslation(0.022 * mv * Math.sin(ph), -0.008 * mv * Math.abs(Math.cos(ph)), 0));
        }
        _m.toArray(PG.im.instanceMatrix.array, ng * 16);
        PG.hide[ng] = 1 - p.fade;
        const tc = p._tC, k3 = ng * 3;
        PG.col[k3] = p.cBag.r * (tc ? tc[0] : 1); PG.col[k3 + 1] = p.cBag.g * (tc ? tc[1] : 1); PG.col[k3 + 2] = p.cBag.b * (tc ? tc[2] : 1);
        this.iBag[ng] = p.bagKind === 2 ? 1 : 0;
        ng++;
      }
    }
    PL.n = PL.im.count = nl; PB.n = PB.im.count = nb; PC.n = PC.im.count = nc; PG.n = PG.im.count = ng;
    for (const P of this.packed) {
      if (!P.n) continue;
      P.colA.clearUpdateRanges(); P.colA.addUpdateRange(0, P.n * 3); P.colA.needsUpdate = true;
      P.hideA.clearUpdateRanges(); P.hideA.addUpdateRange(0, P.n); P.hideA.needsUpdate = true;
      if (P.rimA) { P.rimA.clearUpdateRanges(); P.rimA.addUpdateRange(0, P.n * 3); P.rimA.needsUpdate = true; }
    }
    if (ng) { this.iBagA.clearUpdateRanges(); this.iBagA.addUpdateRange(0, ng); this.iBagA.needsUpdate = true; }
  },

  // the pushed bicycles: on the pusher's right, handlebar level with the hand on the near grip
  writeBikes() {
    const bm = this.bikeMesh;
    if (!bm) return;
    const peds = this.peds, slotOf = this.slotOf, nVis = this.visible;
    let n = 0;
    for (let k = 0; k < this.bikeIdx.length; k++) {
      const i = this.bikeIdx[k], p = peds[i];
      if (slotOf[i] >= nVis || (p.hero && !this.scanR) || p.gawk || p.fade < 0.05) continue;
      const yaw = p.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw), sc = p.scale;
      _q.setFromAxisAngle(UPY, yaw - Math.PI / 2);
      _m.compose(_p.set(p.x - rx * 0.46 * sc - fx * 0.25, p.gy, p.z - rz * 0.46 * sc - fz * 0.25), _q, _s.set(1, 1, 1));
      bm.setMatrixAt(n, _m); this.wheelMesh.setMatrixAt(n, _m);
      // the frame takes the same neon-folded tint as its pusher's coat, or it is the one unlit object in the crowd
      _c.set(p.bikeCol); const tc = p._tC;
      if (tc) _c.setRGB(_c.r * tc[0] * 1.25, _c.g * tc[1] * 1.25, _c.b * tc[2] * 1.25);
      bm.setColorAt(n, _c);
      n++;
    }
    bm.count = n; this.wheelMesh.count = n;
    if (n) {
      bm.instanceMatrix.needsUpdate = true; this.wheelMesh.instanceMatrix.needsUpdate = true;
      if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    }
  },

  // ---- ground contact: a leaned sun ellipse that clears the silhouette, plus the hard patch under the
  //      planted foot that actually reads as weight, plus a wet smear that breaks the neon reflection
  // By day this is a leaned body-shadow ellipse. At night there is no sun to lean away from, and a
  // body-sized soft stain sitting on wet asphalt is exactly what wipes the neon mirror out -- so it
  // narrows to a footprint and slides onto the planted foot instead of fading to nothing.
  decals(s, p, gy, gsc, moving, cw, holdUmb, pfx, pfy, pfz, smearOn, camX, camZ) {
    const yaw = p.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw);
    const bs = gsc * (moving ? 0.88 + Math.abs(cw) * 0.10 : p.inLight ? 0.64 : 1.0) * (holdUmb ? 1.45 : 1);
    const nb = this.nightBlob;
    // on the hill the decals lie in the slope instead of cutting into it
    const tilt = (p.gX || p.gZ) ? _qt.setFromUnitVectors(UPY, _v.set(-(p.gX || 0), 1, -(p.gZ || 0)).normalize()) : null;
    _q2.setFromAxisAngle(UPY, nb > 0.5 ? yaw : this.sunYaw);
    if (tilt) _q2.premultiply(tilt);
    _m.compose(_p.set(p.x + this.sunOX * bs + (pfx - p.x) * nb, gy + 0.02, p.z + this.sunOZ * bs + (pfz - p.z) * nb),
      _q2, _s.set(bs * (0.30 - 0.12 * nb), 1, bs * (0.475 * this.sunLen - 0.195 * nb)));
    this.blob.setMatrixAt(s, _m);
    // past FAR2_D the foot pad and the wet smear are 2-3 px: the blob alone grounds a body out there
    if (s >= this.far2From) return;
    const lift = clamp(1 - (pfy - gy - ANK_Y * p.scale) * 9, 0, 1);
    _q2.setFromAxisAngle(UPY, yaw);
    if (tilt) _q2.premultiply(tilt);
    _m.compose(_p.set(pfx + fx * 0.05 * gsc, gy + 0.012, pfz + fz * 0.05 * gsc), _q2, _s.set(gsc * lift, 1, gsc * 1.4 * lift));
    this.contact.setMatrixAt(s, _m);
    if (smearOn) {
      let tx = camX - p.x, tz = camZ - p.z;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      _q2.setFromAxisAngle(UPY, Math.atan2(tx, tz));
      if (tilt) _q2.premultiply(tilt);
      _m.compose(_p.set(p.x + tx * 0.55 * gsc, gy + 0.015 + ((p.gX || 0) * tx + (p.gZ || 0) * tz) * 0.55 * gsc, p.z + tz * 0.55 * gsc), _q2, _s.set(gsc * 0.25, 1, gsc * 0.80));
      this.smear.setMatrixAt(s, _m);
    }
  },

  // standing height (crown above the ground) of each tier at scale 1, and of every bound pool body against the
  // height its pedestrian is supposed to be (p.scale * 1.8)
  heightReport() {
    const top = (g) => { g.computeBoundingBox(); return +g.boundingBox.max.y.toFixed(3); };
    const G = this.G, box = new THREE.Box3();
    const out = { rig: { head: top(G.head), hairCap: top(G.hairCap), shoeMin: 0 }, far: top(G.far), far2: top(G.far2), pool: [] };
    for (const H of this.heroes) {
      const p = H.ped; if (!p || !H.rig) continue;
      H.h.group.updateMatrixWorld(true);
      const hw = H.h.bones.Head.getWorldPosition(new THREE.Vector3()).y - p.gy, gs = H.h.group.scale.x;
      const crown = (H.rig.skullY + 0.118) * gs;
      box.makeEmpty();
      { const sk = H.h.skinned, n = sk.geometry.attributes.position.count, v = new THREE.Vector3(); for (let i = 0; i < n; i += 3) { sk.getVertexPosition(i, v); box.expandByPoint(v.applyMatrix4(sk.matrixWorld)); } }
      out.pool.push({ want: +(p.scale * RIG_CROWN).toFixed(3), crownBind: +(H.rig.skullY + 0.118).toFixed(3), hH: +H.height.toFixed(3), gs: +gs.toFixed(3), crown: +crown.toFixed(3), headJ: +hw.toFixed(3), rigHeadJ: +(1.50 * p.scale).toFixed(3), bbox: +(box.max.y - p.gy).toFixed(3), slim: H.slim });
    }
    return out;
  },

  selfTest() {
    // ?test=crowd fires a couple of frames after boot, when the pool is still filling: prime it so the
    // reported lod0 numbers are the ones the frame actually runs with rather than a cold 0/0
    // ...and re-sort first: shots.js moves the camera to the preset AFTER the last update, so the packed
    // order (and therefore every distance the binder reads) still belongs to the boot camera and the pool
    // reports 0 bound on a frame where it is actually running a dozen bodies.
    if (!this._poolBoot && !this.scanR) this.growHeroes();
    this.resort();
    const kinds = { crosser: 0, walker: 0, idler: 0 };
    let minS = 9, maxS = 0, onPlaza = 0, centerGai = 0, hachiko = 0, dirL = 0, dirR = 0, strollers = 0;
    const wet = this.engine.time.wet || 0, raining = this.engine.time.weather === 'rain';
    let umbUp = 0, umbFold = 0, loiter = 0, queued = 0;
    for (const p of this.peds) {
      kinds[p.kind]++;
      if (p.umb && (raining || (wet > 0.55 && p.umbWet2))) umbUp++; else if (p.umb && (raining || wet > 0.3)) umbFold++;
      if (p.shopT > 0) loiter++;
      if (p.queue) queued++;
      minS = Math.min(minS, p.scale); maxS = Math.max(maxS, p.scale);
      if (p.stroll) strollers++;
      if (p.kind === 'idler') { onPlaza++; if (Math.hypot(p.x - 28, p.z - 40) < 26) hachiko++; }
      if (p.kind === 'walker' && Math.hypot(p.x + 40, p.z + 40) < 40) { centerGai++; if (p.baseLat > 0) dirL++; else dirR++; }
    }
    let tris = 0;
    for (const m of this.meshes) { const g = m.geometry, n = (g.index ? g.index.count : g.attributes.position.count) / 3; tris += n * m.count; }
    let castTris = 0;
    for (const m of this.shadowSet) { const g = m.geometry, n = (g.index ? g.index.count : g.attributes.position.count) / 3; castTris += n * Math.min(m.count, CAST_N); }
    // the scramble: who is out on it, how far along their crosswalk (quartiles of progress 0..1), and how many
    // walk in company
    const prog = [];
    let crossing = 0, waiting = 0, inGroups = 0, plaza = 0;
    for (const p of this.peds) {
      if (p.grp) inGroups++;
      if (p.kind === 'walker' && p.path && p.path.plaza && pointInPolygon(p.x, p.z, [[13, 12], [40, 12], [43, 54], [10, 54], [8, 28]])) plaza++;
      if (p.kind !== 'crosser') continue;
      if (p.state === 'wait') { waiting++; continue; }
      crossing++;
      const L = this.links[p.link];
      if (L) { const ax = p.wp[0], az = p.wp[1], bx = p.wp[2], bz = p.wp[3], l = Math.hypot(bx - ax, bz - az) || 1; prog.push(clamp(((p.x - ax) * (bx - ax) + (p.z - az) * (bz - az)) / (l * l), 0, 1)); }
    }
    prog.sort((a, b) => a - b);
    const q = (f) => prog.length ? +prog[Math.floor(f * (prog.length - 1))].toFixed(2) : 0;
    return {
      scramble: { crossing, waiting, progress: [q(0.1), q(0.25), q(0.5), q(0.75), q(0.9)], waveAge: +(this.engine.clock ? 0 : 0) },
      company: +(inGroups / this.count).toFixed(2), plazaWalkers: plaza,
      triPer: Object.fromEntries([...this.meshes, this.farRefl].map(m => [m.name.replace('crowd:', ''), (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3])),
      count: this.count, kinds, visible: this.visible, full: this.full, mid: this.mid,
      draws: this.drawN, shadowDraws: this.shadowSet.length * 2, roles: this.nRoles || 0, bikes: this.bikeMesh ? this.bikeMesh.count : 0,
      tris: Math.round(tris), castTris: Math.round(castTris), casters: Math.min(this.torso.count, CAST_N),
      heights: [+(minS * RIG_CROWN).toFixed(2), +(maxS * RIG_CROWN).toFixed(2)], children: this.peds.filter(q => q.child).length,
      lonelyChildren: this.peds.filter(q => q.child && !(q.grp || q.group)).length, inBubble: this.inBubble || 0, paths: this.pathStats,
      idlers: onPlaza, hachiko, centergaiNear: centerGai, centergaiSplit: [dirL, dirR],
      umbrellas: { up: umbUp, folded: umbFold, pct: +(100 * umbUp / this.count).toFixed(1) },
      loitering: loiter, queued, queues: this.queues.length,
      links: this.links.length, vehProxies: this.nVeh, strollers,
      lod0: { pool: this.heroes.length, bound: this.heroes.filter(h => h.ped).length, budget: +this.heroBudget.toFixed(1), tris: this.heroTris || 0, confs: this.heroes.map(h => h.conf), hairShells: this.heroes.filter(h => h.acc.hairShell).length, scans: this.heroes.filter(h => h.scan).length },
      swaps: { total: this.swaps.n, inView: this.swaps.inView, inView14: this.swaps.inView14, atCut: this.swaps.cut, rebuilds: this.nRebuilds || 0, log: this.swaps.log.slice(0, 8) },
      lens: { rig: LENS_RIG, fade: LENS_FADE, face: LENS_FACE, back: LENS_MIN, nudged: this.peds.filter(q => q.hx0 != null || q.kx0 != null).length },
      police: this.peds.filter(q => q.police).map(q => [+q.x.toFixed(1), +q.z.toFixed(1)]),
      far: this.far.count,
      ring: this.gk ? { on: this.gk.on, centre: [+this.gk.x.toFixed(1), +this.gk.z.toFixed(1)], members: this.peds.filter(p => p.gawk).length,
        poses: this.peds.filter(p => p.gawk).reduce((a, p) => { a[p.idlePose] = (a[p.idlePose] || 0) + 1; return a; }, {}) } : null,
      scan: this.scanR ? { ...this.scanR.report(), perKey: this.scanR.S.filter(Boolean).map(S => [S.key, this.peds.filter(q => q.sk === S.i).length]) } : null,
    };
  },
};

export default crowd;
