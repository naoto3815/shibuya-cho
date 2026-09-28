// [traffic] Vehicles, taxis, buses and the scramble signal cycle for 渋谷町.
//   cityData roads become a lane graph (left-hand traffic: lane centres are offset to the LEFT of travel): every
//   junction is found and gets smooth clothoid turn paths between its lanes, every pair of paths that could put two
//   bodies on the same patch of road gets a conflict zone, and a car only enters a junction once it holds every zone
//   of its path. The scramble runs the 120 s cycle below; 109, 神宮前, 宮益坂下 and 渋谷駅南口 are vehicle-actuated.
//   Vehicles enter at each map-edge source at the rate its roads can carry (SRC_RATE) and leave at the edges, out of
//   sight; nobody enters a junction whose exit cannot take them, a driver kept waiting takes another exit, a side
//   road given way to for too long claims the next real gap, and a car noses past a pedestrian who never moves.
//   Taxi ranks flow (the front cab pulls out, the line moves up, empty cabs pull in) and buses serve their stops.
//   The kerbs live: cabs drop fares at the ハチ公 kerb (door open, hazards), vans unload with their doors open,
//   scooters filter up to the stop line. At night the lamps glare through the scramble crowd (depth-less, hidden
//   by buildings and vehicles by hand) and smear long across the wet road toward the eye.
//   Bodies are procedural: a lofted lower body with a rounded shoulder, a separate greenhouse whose glass is a
//   material class inside the same loft (duplicated rings give crisp frames), bumpers, mirrors, sills, grille,
//   canvas licence plates and emissive lamps on the BLOOM layer.
//   The nearest buses (busPax) are drawn open: glass over a real saloon with the client's scanned people seated and
//   strap-hanging in it (crowdScan statics, moved with the bus every frame); further out the saloon is an interior map.
//
//   traffic.phase   'ns'|'ns_amber'|'allred'|'scramble'|'ew'|'ew_amber'      traffic.phaseT seconds into it
//   traffic.signal  { ns, ew, ped:'walk'|'flash'|'stop', vehicle, remaining }
//   traffic.isScramble()   traffic.laneGreen(axis)   traffic.cars[] { x, z, yaw, speed, kind, type, w, l }
//   events out:  'signal:phase' { vehicle, pedestrian, ped, ns, ew, remaining, phase, cycle }   (on every change)
//                'traffic:horn' { x, z, kind }
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, groundY } from './cityData.js';
import { MOBILE, TIER } from '../core/mobileProfile.js';

// ---------------------------------------------------------------------------------------------- signal cycle
// (a 3 s amber, as on a 40–50 km/h road; the clearances are as short as the box allows, so each arm's red — 90 s from
//  the start of its amber — is no longer than it must be around a 47 s walk)
const CYCLE = [
  { name: 'ns', dur: 30 }, { name: 'ns_amber', dur: 3 }, { name: 'allred', dur: 3 },
  { name: 'scramble', dur: 47 }, { name: 'allred', dur: 2 },
  { name: 'ew', dur: 30 }, { name: 'ew_amber', dur: 3 }, { name: 'allred', dur: 2 },
];
const CYCLE_LEN = CYCLE.reduce((a, p) => a + p.dur, 0);   // 120 s
const FLASH_T = 8;                                        // last seconds of the scramble flash the green man

const CROSS = CITY.crossing ? CITY.crossing.center : [-4, -2];

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color();
const _pm = new THREE.Matrix4(), _frustum = new THREE.Frustum(), _sph = new THREE.Sphere();
const UPY = new THREE.Vector3(0, 1, 0), RX = new THREE.Vector3(1, 0, 0);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sq = (v) => v * v;                                   // (per-frame code uses sqrt, never Math.hypot: that allocates)
const smooth01 = (t) => { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x); };

// LOD cuts (metres unless noted). `far` is a projected-size test, not a distance one.
const PX_CUT = 6;        // below this many screen pixels of vehicle length, drop the trim entirely
const D_DRAW = 620;      // hard draw distance (impostors are ~100 tris, so the aerial can keep the whole map)
const D_SHADOW = 34;     // inside this a body is the full loft and goes into the shadow-casting mesh
const D_IMPOSTOR = 78;   // beyond this the body is swapped for a ~70-tri stand-in
const D_WHEEL = 120;     // a 0.62 m wheel is still ~7 px here (13 px at 60 m): impostors keep theirs too
const D_LAMP = 90;       // beyond this the 4 lenses collapse into one streak quad
const D_CONE = 250;      // headlight pools on the wet road
const D_CONTACT = 150;
const SHADOW_ONLY_LAYER = 7; // traffic:shadowOnly lives here, seen only by the sun's (CSM) shadow cameras
const CONE_SEG = 4;      // the pool is sliced along z so it follows the 道玄坂 gradient
const WH_NEAR = 34;      // a bus's or truck's wheels are pressed-steel discs inside this
// The glare drawn over the crowd is depth-tested, but pulled in along the line of sight to this distance from the eye
// (and scaled to keep its size on screen): whoever stands nearer the eye than that cuts it off at their silhouette, so a
// lamp 50 m off never lands on the hair of somebody 3 m away; the far crowd, whose heads it is meant to clear, does not.
const GLARE_PULL = 12;
const ENV_LAYER = 6;     // seen only by the night reflection capture (the shop-front band)
const STAR_LEAK = 0.35;  // a headlamp behind somebody still twinkles between the heads at this strength
// busPax: inside PAX_D (leaving past PAX_OUT, still inside D_SHADOW) the nearest PAX_BUSES buses are drawn open — real
// glazing, a real saloon and the client's scanned people in it (lod1 inside PAX_MID, lod2 beyond); further out, and on
// the phones' safe tier or ?busPax=0, the saloon stays the interior map. A phone carries one bus, fewer riders.
const PAX_D = MOBILE ? 18 : 30, PAX_OUT = PAX_D + 3.5, PAX_BUSES = MOBILE ? 1 : 3, PAX_MID = MOBILE ? 5 : 7;
const PAX_OCC = MOBILE ? 0.34 : 0.55;   // share of the seats taken

// ---------------------------------------------------------------------------------------------- material kit
// One patched MeshStandardMaterial covers paint, glass, chrome and rubber: aPaint mixes the per-instance colour
// over the vertex colour, aRM overrides roughness/metalness per vertex, aEmis adds a self-lit term.
const MAT = {
  // car paint is a dielectric with a clearcoat: low metalness, low roughness. High metalness went black at night.
  paint:  { paint: 1, rough: 0.22, metal: 0.16, col: 0xffffff },
  matte:  { paint: 1, rough: 0.55, metal: 0.06, col: 0xffffff },
  // Car glazing. metal 0.62 made a mirror that had nothing to reflect: every side window went pure black,
  // day and night, and read as a hole punched through the body. Low metalness + a slate tint + a small
  // self-lit term keeps it dark without ever going to zero.
  glass:  { paint: 0, rough: 0.13, metal: 0.18, col: 0x4b5464, emis: 0.17 },
  trim:   { paint: 0, rough: 0.46, metal: 0.30, col: 0x23262b },
  bumper: { paint: 0, rough: 0.52, metal: 0.10, col: 0x2a2e34 },
  chrome: { paint: 0, rough: 0.26, metal: 0.52, col: 0xbcc2ca },
  rubber: { paint: 0, rough: 0.92, metal: 0.03, col: 0x17181a },
  dark:   { paint: 0, rough: 0.74, metal: 0.08, col: 0x0d0f12 },
  cream:  { paint: 0, rough: 0.46, metal: 0.08, col: 0xcfc8b4 },
  // painted panel that is not the instance colour but still clearcoated (a negative roughness flags the coat): a bus's
  // cream roof and waist band pick the street's neon up from the night capture
  creamcoat: { paint: 0, rough: -0.40, metal: 0.08, col: 0xcfc8b4 },
  white:  { paint: 0, rough: 0.30, metal: 0.10, col: 0xedeff2 },
  silver: { paint: 0, rough: 0.28, metal: 0.55, col: 0xa6adb5 },
  lens:   { paint: 0, rough: 0.10, metal: 0.35, col: 0x2a1512 },
  amber:  { paint: 0, rough: 0.10, metal: 0.35, col: 0x3a2405 },
  skin:   { paint: 0, rough: 0.72, metal: 0.03, col: 0xc39a7a },
  cloth:  { paint: 0, rough: 0.88, metal: 0.02, col: 0x1b1f28 },
  sign:   { paint: 0, rough: 0.35, metal: 0.10, col: 0xffb43c, emis: 1.0 },
  // lit interior seen through bus / van glazing — a Tokyu bus at night is one of the brightest things on the street
  // Emissive shares the diffuse colour in this material, so the tint is picked to read as tinted glass in
  // daylight (uEmis 0.35) and as a lit saloon at night (uEmis 1.5).
  litglass: { paint: 0, rough: 0.06, metal: 0.0, col: 0x1c2128, emis: 0.81 },
  // passengers seen against the lit window band. The body material is opaque, so the interior is read as
  // silhouettes sitting on the outside face of the glazing rather than as volumes trapped behind it.
  sil:    { paint: 0, rough: 0.86, metal: 0.02, col: 0x3a352e },
  silskin:{ paint: 0, rough: 0.78, metal: 0.02, col: 0x6d5545 },
  // bus windscreen: low metalness so the cab does not go black at night and hide the driver
  busglass: { paint: 0, rough: 0.10, metal: 0.16, col: 0x353c45, emis: 0.10 },
  // van / truck cab glazing — same reasoning, one shade lighter so the dash glow reads through it
  cabglass: { paint: 0, rough: 0.12, metal: 0.14, col: 0x424a56, emis: 0.19 },
  rim:    { paint: 0, rough: 0.38, metal: 0.38, col: 0xc4cad1 },
  // pressed-steel disc wheel of a bus or truck: painted silver, duller than an alloy
  steelWheel: { paint: 0, rough: 0.40, metal: 0.22, col: 0xc3c8cd },
  // the black-masked face of a modern bus (windscreen surround, 方向幕 band): gloss, so it keeps a reflection
  glossBlack: { paint: 0, rough: 0.16, metal: 0.30, col: 0x0a0b0d },
  hub:    { paint: 0, rough: 0.50, metal: 0.30, col: 0x6e747c },
  // taxis wear a harder-worn clearcoat: keeps the KM livery from re-saturating under the sky probe
  taxipaint: { paint: 1, rough: 0.30, metal: 0.12, col: 0xffffff },
  // a cab's glazing: privacy-tinted, darker than a private car's, so the saloon reads as a dark volume and the
  // occupant silhouettes on it never stand out (same rough / metal / emis band as `glass`: the night mirror still applies)
  taxiglass: { paint: 0, rough: 0.13, metal: 0.18, col: 0x2c3340, emis: 0.10 },
};

const U = { emis: { value: 1 }, env: { value: 0 }, night: { value: 1 }, time: { value: 0 } };

// Car paint is a clearcoated dielectric (MeshPhysicalMaterial, the clearcoat masked to painted vertices), with a
// grazing fresnel rim of the environment so dark bodies keep their silhouette against a dark street. At night the
// environment is a capture of the scramble itself (signage included), so black cabs pick up the neon.
// The lit saloon of a bus (aEmis == 0.81) is an interior map: a cool ceiling strip over dim seat rows and two
// parallax layers of passengers, looked up along the view ray inside the body, never boxes on the glass.
function vehicleMaterial() {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.3, metalness: 0.7, envMapIntensity: 1.35, name: 'traffic:body',
    clearcoat: 1, clearcoatRoughness: 0.04,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uEmis = U.emis;
    sh.uniforms.uEnvRim = U.env;
    sh.uniforms.uNight = U.night;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aPaint;
attribute vec2 aRM;
attribute float aEmis;
attribute float aSign;
varying vec2 vRM;
varying float vEmis;
varying float vPaint;
varying vec3 vLoc;
varying vec3 vLocV;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb = mix( color.rgb, instanceColor.xyz, aPaint );
        #else
          vColor.rgb = color.rgb;
        #endif
        vRM = aRM; vEmis = aEmis; vPaint = aPaint;
        if ( aEmis > 1.55 && aEmis < 1.65 ) vEmis *= aSign;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        {
          mat4 mm = modelMatrix;
          #ifdef USE_INSTANCING
            mm = modelMatrix * instanceMatrix;
          #endif
          vec4 wp = mm * vec4( transformed, 1.0 );
          vLoc = transformed;
          vLocV = transpose( mat3( mm ) ) * ( cameraPosition - wp.xyz );
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uEmis;
uniform float uEnvRim;
uniform float uNight;
varying vec2 vRM;
varying float vEmis;
varying float vPaint;
varying vec3 vLoc;
varying vec3 vLocV;
const vec3 LEDC = vec3( 0.84, 0.89, 0.95 );
float hsh( float n ) { return fract( sin( n * 91.345 ) * 47453.5453 ); }
// passengers on a plane inside the saloon (x along the bus, y up). seat: a seat row every 1.32 m, some of them empty,
// the sitters of every height and build; stand: strap-hangers every ~1.15 m down the aisle, one arm up to the strap
// (either arm). m = coverage; the colour is who it is (a dark suit, a navy coat, a beige mac, a red jacket …), faces
// warm under the LEDs; ph = the lit screen of the phone three in ten of them are looking at.
vec3 paxLayer( vec2 p, float seed, float stand, float seat, out float m, out float ph ) {
  float row = floor( ( p.x + 4.1 ) / 1.32 );
  float cx = -4.1 + ( row + 0.5 ) * 1.32 + ( hsh( row + seed ) - 0.5 ) * 0.36;
  float occ = step( 0.42, hsh( row * 3.1 + seed ) ) * seat;
  float hy = 1.90 + hsh( row * 5.7 + seed * 1.3 ) * 0.2;
  float sw = 0.16 + hsh( row * 7.9 + seed ) * 0.08;
  float head = 1.0 - smoothstep( 0.8, 1.1, length( vec2( ( p.x - cx ) / 0.105, ( p.y - hy ) / 0.125 ) ) );
  vec2 tq = vec2( p.x - cx, p.y - ( hy - 0.36 ) );
  float td = length( max( abs( tq ) - vec2( sw - 0.08, 0.2 ), 0.0 ) ) - 0.08;
  float o = max( head, ( 1.0 - smoothstep( 0.0, 0.025, td ) ) * step( 1.36, p.y ) ) * occ;
  float srow = floor( ( p.x + 3.0 ) / 1.15 );
  float scx = -3.0 + ( srow + 0.5 ) * 1.15 + ( hsh( srow * 2.3 + seed ) - 0.5 ) * 0.4;
  float st = step( 0.42, hsh( srow * 7.3 + seed ) ) * stand;
  float shy = 2.00 + hsh( srow * 4.1 + seed ) * 0.18;
  float sd = hsh( srow * 5.3 + seed ) > 0.5 ? 1.0 : -1.0;
  float shead = 1.0 - smoothstep( 0.8, 1.1, length( vec2( ( p.x - scx ) / 0.11, ( p.y - shy ) / 0.13 ) ) );
  float sbody = ( 1.0 - smoothstep( 0.0, 0.05, abs( p.x - scx ) - 0.17 - 0.05 * hsh( srow * 3.7 + seed ) ) ) * step( p.y, shy - 0.1 );
  float sarm = ( 1.0 - smoothstep( 0.0, 0.02, abs( p.x - scx - sd * 0.13 ) - 0.035 ) ) * step( shy - 0.22, p.y ) * step( p.y, 2.26 );
  float so = max( max( shead, sbody ), sarm ) * st;
  m = max( o, so );
  bool isS = so > o;
  float id = isS ? srow * 9.1 + seed : row * 9.1 + seed;
  float pick = hsh( id );
  vec3 cloth = pick < 0.35 ? vec3( 0.10, 0.11, 0.13 ) : pick < 0.6 ? vec3( 0.12, 0.15, 0.24 )
    : pick < 0.8 ? vec3( 0.42, 0.36, 0.27 ) : pick < 0.9 ? vec3( 0.45, 0.13, 0.12 ) : vec3( 0.55, 0.55, 0.52 );
  // (the screen held low in front, and its cold light on the face above it)
  float pcx = isS ? scx - sd * 0.05 : cx + 0.04, pcy = ( isS ? shy : hy ) - 0.40;
  float own = step( hsh( id * 1.7 + 3.3 ), 0.3 ) * ( isS ? st : occ );
  ph = own * max( 1.0 - smoothstep( 0.0, 0.01, max( abs( p.x - pcx ) - 0.026, abs( p.y - pcy ) - 0.042 ) ), 0.3 * ( isS ? shead : head ) );
  return mix( cloth, vec3( 0.62, 0.47, 0.38 ), isS ? shead : head );
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = abs( vRM.x );\n\tfloat coat = max( vPaint, step( vRM.x, -0.001 ) );')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = vRM.y;')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n\tmaterial.clearcoat *= coat;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float em = vEmis;
        vec3 ecol = vColor.rgb;
        if ( abs( vEmis - 0.81 ) < 0.004 ) {
          // lit saloon: 5000 K LEDs, bright under the roof and down to 40 % at the seat line, looked into along the view
          // ray: the near seat row (moquette backs, whoever sits there, the yellow grab poles), then across the aisle
          // the far row, the standees and the straps hanging off the rail
          float y = vLoc.y;
          float grad = mix( 0.4, 1.0, smoothstep( 1.45, 2.3, y ) );
          float strip = 0.9 * smoothstep( 2.17, 2.26, y ) * ( 1.0 - smoothstep( 2.28, 2.33, y ) );
          vec3 V = normalize( vLocV );
          float side = sign( vLoc.x );
          vec3 LED = vec3( 0.84, 0.89, 0.95 );
          vec3 col = LED * grad;
          if ( abs( V.x ) > 0.05 && abs( vLoc.x ) > 1.1 ) {
            // three layers into the saloon: the near seat row, the strap-hangers down the aisle, the far seat row. At
            // night everyone is backlit by the ceiling strip: near-black shapes against it, a phone screen lit here
            // and there; by day they are lit through the glass.
            float t1 = 0.42 / abs( V.x ), ta = 1.05 / abs( V.x ), t2 = 1.75 / abs( V.x );
            vec2 p1 = vec2( vLoc.z - V.z * t1, vLoc.y - V.y * t1 );
            vec2 pa = vec2( vLoc.z - V.z * ta, vLoc.y - V.y * ta );
            vec2 p2 = vec2( vLoc.z - V.z * t2, vLoc.y - V.y * t2 );
            float m1, ma, m2, h1, ha, h2;
            vec3 c2 = paxLayer( p2, 3.0 + side, 0.0, 1.0, m2, h2 );
            vec3 ca = paxLayer( pa, 5.0 + side, 1.0, 0.0, ma, ha );
            vec3 c1 = paxLayer( p1, 7.0 + side * 2.0, 0.0, 1.0, m1, h1 );
            float sil = 1.0 - 0.86 * uNight;
            float g2 = mix( 0.4, 1.0, smoothstep( 1.45, 2.3, p2.y ) ), g1 = mix( 0.4, 1.0, smoothstep( 1.45, 2.3, p1.y ) );
            float ga = mix( 0.4, 1.0, smoothstep( 1.45, 2.3, pa.y ) );
            vec3 far = LED * g2 * ( 0.55 + 0.45 * step( 1.5, p2.y ) );
            far = mix( far, c2 * g2 * sil, m2 );
            float strap = step( 2.02, pa.y ) * step( pa.y, 2.2 ) * step( 0.84, fract( pa.x * 2.4 ) );
            float rail = step( 2.23, pa.y ) * step( pa.y, 2.26 );
            far = mix( far, vec3( 0.06 ), max( strap * 0.7, rail * 0.85 ) );
            far = mix( far, ca * ga * sil, ma );
            float sx = fract( ( p1.x + 4.1 ) / 1.32 );
            vec2 sq = vec2( ( sx - 0.5 ) * 1.32, p1.y - 1.56 );
            float seat = 1.0 - smoothstep( 0.0, 0.03, length( max( abs( sq ) - vec2( 0.21, 0.18 ), 0.0 ) ) - 0.05 );
            float pole = ( 1.0 - smoothstep( 0.014, 0.024, abs( fract( ( p1.x + 4.1 ) / 2.64 ) - 0.5 ) * 2.64 ) ) * step( 1.3, p1.y );
            col = mix( far, vec3( 0.13, 0.16, 0.30 ) * mix( 0.45, 0.8, smoothstep( 1.4, 1.75, p1.y ) ), seat );
            col = mix( col, c1 * g1 * sil, m1 );
            col = mix( col, vec3( 0.80, 0.64, 0.16 ) * g1, pole );
            col += vec3( 0.45, 0.66, 1.3 ) * max( h1, max( ha * 0.85, h2 * 0.6 ) );
          }
          // (the rear window looks down the length of the saloon, through tinted glass)
          if ( vLoc.z < -5.0 ) col *= 0.6;
          // at night one of the brightest things on the street; the ceiling strip at 1.6x (at 2.5x it clipped)
          ecol = ( col + LED * strip ) * ( 1.0 + 0.6 * uNight );
          em = 0.2;
        } else if ( abs( vEmis - 0.10 ) < 0.004 && vLoc.z > 4.0 ) {
          // bus windscreen: through it the saloon's ceiling light falling away down the cab, the driver against it on
          // the offside, the amber dash; the neon mirrored in the glass goes on top (lights_fragment_end)
          float y = vLoc.y, x = vLoc.x;
          float sal = smoothstep( 1.5, 2.28, y ) * 0.5;
          float body = 1.0 - smoothstep( 0.0, 0.03, length( max( abs( vec2( x + 0.62, y - 1.66 ) ) - vec2( 0.16, 0.2 ), 0.0 ) ) - 0.06 );
          float hd = 1.0 - smoothstep( 0.09, 0.12, length( vec2( x + 0.62, y - 1.99 ) * vec2( 1.0, 0.85 ) ) );
          float wheel = ( 1.0 - smoothstep( 0.015, 0.03, abs( length( vec2( x + 0.62, ( y - 1.52 ) * 2.4 ) ) - 0.2 ) ) ) * step( y, 1.56 );
          float dash = smoothstep( 1.40, 1.43, y ) * ( 1.0 - smoothstep( 1.46, 1.5, y ) ) * ( 0.6 + 0.4 * step( x, -0.2 ) );
          float cut = max( max( body, hd ), wheel );
          ecol = ( LEDC * sal * ( 1.0 - 0.92 * cut ) + vec3( 1.0, 0.72, 0.38 ) * dash * 0.55 ) * ( 0.3 + 0.9 * uNight );
          em = 0.2;
        }
        totalEmissiveRadiance += ecol * ( em * uEmis );`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #ifdef USE_ENVMAP
          // black / 濃藍 paint is all clearcoat: its grazing rim never drops under 0.85, twice over, and its whole mirror is
          // 1.8x, so a black cab in the night street is drawn by the signage and shop fronts it reflects, never a void
          float fres = pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), 5.0 );
          float dark = ( 1.0 - smoothstep( 0.03, 0.08, dot( vColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ) ) * vPaint;
          reflectedLight.indirectSpecular *= 1.0 + 0.8 * dark;
          #ifdef USE_CLEARCOAT
            clearcoatSpecularIndirect *= 1.0 + 0.8 * dark;
          #endif
          float rimK = mix( uEnvRim, max( uEnvRim, 0.85 ), dark );
          reflectedLight.indirectSpecular += coat * fres * rimK * ( 1.0 + dark ) * getIBLRadiance( geometryViewDir, geometryNormal, 0.06 );
          // glazing at night: a Schlick mirror of the capture (the street's signage) over the BRDF's own, so a windscreen
          // reads as a sheet of reflected neon and never as a black slab; a bus windscreen, big and upright, four times over
          float glz = ( 1.0 - vPaint ) * ( 1.0 - step( 0.14, abs( vRM.x ) ) ) * ( 1.0 - step( 0.2, vRM.y ) ) * ( 1.0 - step( 0.5, vEmis ) );
          if ( glz > 0.5 && uNight > 0.01 ) {
            float F = 0.04 + 0.96 * pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), 5.0 );
            float busW = 1.0 - step( 0.004, abs( vEmis - 0.10 ) );
            reflectedLight.indirectSpecular += F * uNight * uEnvRim * ( 2.0 + 6.0 * busW ) * getIBLRadiance( geometryViewDir, geometryNormal, 0.03 );
          }
        #endif`);
  };
  m.customProgramCacheKey = () => 'traffic:body5';
  return m;
}

// ---------------------------------------------------------------------------------------------- geometry kit
function tag(g, spec) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), pa = new Float32Array(n), rm = new Float32Array(n * 2), em = new Float32Array(n);
  _c.set(spec.col === undefined ? 0xffffff : spec.col);
  for (let i = 0; i < n; i++) {
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
    pa[i] = spec.paint || 0; rm[i * 2] = spec.rough; rm[i * 2 + 1] = spec.metal; em[i] = spec.emis || 0;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPaint', new THREE.BufferAttribute(pa, 1));
  g.setAttribute('aRM', new THREE.BufferAttribute(rm, 2));
  g.setAttribute('aEmis', new THREE.BufferAttribute(em, 1));
  if (!g.attributes.uv) {
    const uv = new Float32Array(n * 2);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  return g;
}

// per-vertex material classes (used by the greenhouse loft)
function tagClasses(g, classOf, specs) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), pa = new Float32Array(n), rm = new Float32Array(n * 2), em = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = specs[classOf(i)] || specs[0];
    _c.set(s.col === undefined ? 0xffffff : s.col);
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
    pa[i] = s.paint || 0; rm[i * 2] = s.rough; rm[i * 2 + 1] = s.metal; em[i] = s.emis || 0;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPaint', new THREE.BufferAttribute(pa, 1));
  g.setAttribute('aRM', new THREE.BufferAttribute(rm, 2));
  g.setAttribute('aEmis', new THREE.BufferAttribute(em, 1));
  return g;
}

function box(w, h, d, x, y, z, spec, rot) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) {
    if (rot[0]) g.rotateX(rot[0]);
    if (rot[1]) g.rotateY(rot[1]);
    if (rot[2]) g.rotateZ(rot[2]);
  }
  g.translate(x, y, z);
  return tag(g, spec);
}

function cyl(r, h, x, y, z, spec, seg = 8, axis = 'y') {
  const g = new THREE.CylinderGeometry(r, r, h, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return tag(g, spec);
}

// Rounded rectangle in the car's plan (x = lateral, z = fore/aft). cls 1 marks pillar columns.
function rr(hw, hl, r, sideN = 4, arcN = 3) {
  r = Math.max(0.02, Math.min(r, hw * 0.95, hl * 0.95));
  const ax = hw - r, az = hl - r;
  const pts = [], cls = [];
  const arc = (cx, cz, a0, a1) => {
    for (let i = 0; i <= arcN; i++) {
      const a = a0 + (a1 - a0) * i / arcN;
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
      cls.push(i > 0 && i < arcN ? 1 : 0);
    }
  };
  pts.push([0, hl]); cls.push(0);
  arc(ax, az, Math.PI / 2, 0);
  for (let i = 1; i < sideN; i++) { pts.push([hw, az - 2 * az * (i / sideN)]); cls.push(i * 2 === sideN ? 1 : 0); }
  arc(ax, -az, 0, -Math.PI / 2);
  pts.push([0, -hl]); cls.push(0);
  arc(-ax, -az, -Math.PI / 2, -Math.PI);
  for (let i = 1; i < sideN; i++) { pts.push([-hw, -az + 2 * az * (i / sideN)]); cls.push(i * 2 === sideN ? 1 : 0); }
  arc(-ax, az, Math.PI, Math.PI / 2);
  return { pts, cls };
}

// duplicate points across class boundaries so the loft gets crisp material edges instead of a gradient
function crispen(ring) {
  const n = ring.pts.length, pts = [], cls = [];
  for (let i = 0; i < n; i++) {
    const prev = ring.cls[(i - 1 + n) % n];
    if (prev !== ring.cls[i]) { pts.push([ring.pts[i][0], ring.pts[i][1]]); cls.push(prev); }
    pts.push(ring.pts[i]); cls.push(ring.cls[i]);
  }
  return { pts, cls };
}

function ensureOutward(g) {
  g.computeVertexNormals();
  const pos = g.attributes.position, nor = g.attributes.normal;
  let best = -1e9, bi = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getX(i) > best) { best = pos.getX(i); bi = i; }
  if (nor.getX(bi) < 0) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.index.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

// rings: [{ y | shape(x,z), pts, cls }]  rowCls: per-row class override (null = use the ring's own cls)
function loft(rings, specs, rowCls) {
  const cols = rings[0].pts.length, rows = rings.length;
  const pos = new Float32Array(rows * cols * 3), uv = new Float32Array(rows * cols * 2);
  const idx = [];
  for (let r = 0; r < rows; r++) {
    const R = rings[r];
    for (let c = 0; c < cols; c++) {
      const p = R.pts[c], i = r * cols + c;
      pos[i * 3] = p[0]; pos[i * 3 + 1] = R.shape ? R.shape(p[0], p[1]) : R.y; pos[i * 3 + 2] = p[1];
      uv[i * 2] = c / cols; uv[i * 2 + 1] = r / Math.max(1, rows - 1);
    }
  }
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c++) {
    const c2 = (c + 1) % cols, a = r * cols + c, b = r * cols + c2, d = (r + 1) * cols + c, e = (r + 1) * cols + c2;
    idx.push(a, d, e, a, e, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  ensureOutward(g);
  tagClasses(g, (i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const rc = rowCls && rowCls[r];
    return rc === null || rc === undefined ? (rings[r].cls ? rings[r].cls[c] : 0) : rc;
  }, specs);
  return g;
}

function cap(ring, y, up, spec, shape) {
  const n = ring.length;
  const pos = new Float32Array((n + 1) * 3), uv = new Float32Array((n + 1) * 2);
  const idx = [];
  let cx = 0, cz = 0;
  for (const p of ring) { cx += p[0]; cz += p[1]; }
  cx /= n; cz /= n;
  const yy = (x, z) => (shape ? shape(x, z) : y);
  pos[0] = cx; pos[1] = yy(cx, cz); pos[2] = cz; uv[0] = 0.5; uv[1] = 0.5;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    pos[(i + 1) * 3] = p[0]; pos[(i + 1) * 3 + 1] = yy(p[0], p[1]); pos[(i + 1) * 3 + 2] = p[1];
    uv[(i + 1) * 2] = 0.5 + p[0] * 0.2; uv[(i + 1) * 2 + 1] = 0.5 + p[1] * 0.2;
  }
  for (let i = 0; i < n; i++) {
    const a = 1 + i, b = 1 + (i + 1) % n;
    if (up > 0) idx.push(0, a, b); else idx.push(0, b, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if ((g.attributes.normal.getY(0) > 0) !== (up > 0)) {
    const a = g.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    g.index.needsUpdate = true;
    g.computeVertexNormals();
  }
  return tag(g, spec);
}

// low rounded box used for bumpers, cargo boxes, scooter parts
function roundBox(w, h, d, r, x, y, z, spec) {
  const hw = w / 2, hl = d / 2, hh = h / 2;
  const mk = (sy, s) => ({ y: y + sy * hh, pts: rr(hw * s, hl * s, Math.min(r, hw * s * 0.9, hl * s * 0.9), 2, 1).pts.map(p => [p[0] + x, p[1] + z]) });
  const rings = [mk(-1, 0.88), mk(0, 1), mk(1, 0.88)];
  const parts = [loft(rings, [spec], [0, 0, 0])];
  parts.push(cap(rings[2].pts, rings[2].y, 1, spec));
  parts.push(cap(rings[0].pts, rings[0].y, -1, spec));
  return mergeGeometries(parts, false);
}

// ---------------------------------------------------------------------------------------------- car bodies
// A "car" is a lower body loft (sill → shoulder) with a sculpted deck (hood drops at the front, boot at the rear)
// and a greenhouse loft on top whose side/front/back panels are glass and whose corner arcs are body-colour pillars.
function carBody(P, lod = 0) {
  const parts = [];
  const pm = P.paintSpec || MAT.paint;
  const hw = P.hw, zF = P.zF, zB = P.zB, belt = P.belt;
  const zCF = P.cabF, zCR = P.cabR;
  const deck = (x, z) => {
    let y = belt;
    if (z > zCF) { const t = clamp((z - zCF) / Math.max(0.01, zF - zCF), 0, 1); y -= P.hoodDrop * t * t; }
    else if (z < zCR) { const t = clamp((zCR - z) / Math.max(0.01, zCR - zB), 0, 1); y -= P.bootDrop * t * t; }
    return y - P.crown * (x * x) / (hw * hw);
  };
  const plan = (s, zf, zb, r) => rr(hw * s, (zf - zb) / 2, r, lod ? 2 : 4, lod ? 2 : 3).pts.map(p => [p[0], p[1] + (zf + zb) / 2]);
  const bodyRings = [
    { y: P.sillY, pts: plan(0.86, zF - 0.10, zB + 0.10, P.rPlan + 0.06) },
    { y: P.sillY + (belt - P.sillY) * 0.34, pts: plan(1.00, zF, zB, P.rPlan) },
    { y: belt - 0.22, pts: plan(0.998, zF - 0.01, zB, P.rPlan + 0.02) },
    { y: belt - 0.055, pts: plan(0.982, zF - 0.03, zB - 0.01, P.rPlan + 0.06) },   // shoulder roll
    { shape: deck, pts: plan(P.shoulder, zF - 0.06, zB - 0.02, P.rPlan + 0.10) },
  ];
  if (lod) bodyRings.splice(2, 2);
  parts.push(loft(bodyRings, [pm], bodyRings.map(() => 0)));
  parts.push(cap(bodyRings[bodyRings.length - 1].pts, belt, 1, pm, deck));
  parts.push(cap(bodyRings[0].pts, P.sillY, -1, MAT.dark));

  // greenhouse: duplicated rows give a crisp beltline seal and roof rail
  const gp = (s, zf, zb, r) => crispen({ ...rr(hw * s, (zf - zb) / 2, r, lod ? 2 : 4, lod ? 1 : 3) });
  const shift = (ring, cz) => ({ pts: ring.pts.map(p => [p[0], p[1] + cz]), cls: ring.cls });
  const g0 = shift(gp(P.cabW0, (zCF - zCR) / 2, -(zCF - zCR) / 2, P.rCab), (zCF + zCR) / 2);
  const roofF = zCF - P.rakeF, roofR = zCR + P.rakeR;
  const g1 = shift(gp(P.cabW1, (roofF - roofR) / 2, -(roofF - roofR) / 2, P.rCab * 0.9), (roofF + roofR) / 2);
  const yB = deck(0, (zCF + zCR) / 2), yR = P.roofY;
  const lerpRing = (a, b, t) => ({ pts: a.pts.map((p, i) => [p[0] + (b.pts[i][0] - p[0]) * t, p[1] + (b.pts[i][1] - p[1]) * t]), cls: a.cls });
  // The greenhouse used to hold g0's section almost to the roof and then fold to g1 in one row, which read as
  // a flat slab with a crease across the screen pillar. The rake is spread over the whole height instead.
  const hSpan = Math.max(0.12, yR - yB);
  const cabRings = lod ? [
    { y: yB - 0.02, ...g0 },
    { y: yB + hSpan * 0.42, ...lerpRing(g0, g1, 0.40) },
    { y: yR, ...g1 },
  ] : [
    { y: yB - 0.02, ...g0 },
    { y: yB + 0.05, ...lerpRing(g0, g1, 0.055) },
    { y: yB + hSpan * 0.34, ...lerpRing(g0, g1, 0.31) },
    { y: yB + hSpan * 0.68, ...lerpRing(g0, g1, 0.67) },
    { y: yR - 0.05, ...lerpRing(g0, g1, 0.94) },
    { y: yR, ...g1 },
  ];
  parts.push(loft(cabRings, [MAT.glass, pm], lod ? [1, null, 1] : [1, 1, null, null, null, 1]));
  parts.push(cap(g1.pts.map(p => [p[0], p[1]]), yR, 1, pm));

  // bumpers, sills, grille, mirrors, wheel wells, lamp bezels, plate recesses
  const bMat = P.bumperPaint ? pm : MAT.bumper;
  if (lod) {
    parts.push(box(hw * 1.94, 0.34, 0.30, 0, P.sillY + 0.10, zF - 0.10, bMat));
    parts.push(box(hw * 1.94, 0.34, 0.30, 0, P.sillY + 0.10, zB + 0.10, bMat));
  } else {
    parts.push(roundBox(hw * 1.98, 0.36, 0.34, 0.12, 0, P.sillY + 0.10, zF - 0.10, bMat));
    parts.push(roundBox(hw * 1.98, 0.36, 0.34, 0.12, 0, P.sillY + 0.10, zB + 0.10, bMat));
  }
  parts.push(box(hw * 1.72, 0.17, 0.10, 0, belt - P.hoodDrop - 0.06, zF - 0.10, MAT.dark));       // grille recess
  if (!lod) parts.push(box(hw * 1.30, 0.06, 0.06, 0, belt - P.hoodDrop - 0.06, zF - 0.06, MAT.chrome)); // grille bar
  for (const s of [-1, 1]) {
    if (!lod) {
      parts.push(box(0.10, 0.11, 0.55, s * hw * 1.00, P.sillY - 0.03, 0, MAT.dark));                // rocker sill
      parts.push(box(0.035, 0.045, (zCF - zCR) * 0.94, s * hw * 1.005, belt - 0.045, (zCF + zCR) / 2, MAT.chrome)); // beltline strip
      parts.push(box(0.03, 0.035, (roofF - roofR) * 0.96, s * hw * P.cabW1 * 1.02, P.roofY - 0.075, (roofF + roofR) / 2, MAT.chrome)); // window surround
      parts.push(box(0.035, 0.05, 0.055, s * hw * 1.004, belt - 0.30, zCR + (zCF - zCR) * 0.06, MAT.trim));         // door shut line
      parts.push(box(0.035, 0.05, 0.055, s * hw * 1.004, belt - 0.30, zCR + (zCF - zCR) * 0.52, MAT.trim));
      parts.push(box(0.05, 0.045, 0.17, s * hw * 1.012, belt - 0.20, zCR + (zCF - zCR) * 0.30, MAT.chrome));        // door handles
      parts.push(box(0.05, 0.045, 0.17, s * hw * 1.012, belt - 0.20, zCR + (zCF - zCR) * 0.72, MAT.chrome));
      parts.push(box(0.20, 0.09, 0.06, s * (hw * 1.02 + 0.09), belt - 0.04, zCF - 0.08, MAT.trim));  // mirror stalk
      parts.push(box(0.09, 0.13, 0.21, s * (hw * 1.02 + 0.17), belt - 0.03, zCF - 0.11, pm)); // mirror shell
    }
    parts.push(box(0.34, 0.17, 0.13, s * (hw * 0.94), belt - P.hoodDrop - 0.02, zF - 0.08, MAT.dark));  // head bezel
    parts.push(box(0.32, 0.19, 0.12, s * (hw * 0.94), belt - P.bootDrop - 0.10, zB + 0.08, MAT.dark));  // tail bezel
  }
  // arch liners (both tiers: a queue head 50–70 m out is the mid tier, and without them its tyres float)
  for (let i = 0; i < P.axles.length; i++) {
    parts.push(box(hw * 1.88, 0.34, P.wheelR * 1.9, 0, P.wheelR + 0.15, P.axles[i], MAT.dark));
  }
  if (!lod) {
    parts.push(box(hw * 0.86, 0.20, 0.05, 0, P.sillY + 0.14, zB + 0.06, MAT.dark));               // rear plate recess
    // Occupants. The body material is opaque, so anything modelled behind the glazing is invisible from
    // outside; these are thin silhouette plates riding on the outer face, tracking the greenhouse taper.
    // Right-hand drive: the driver is on the offside, local -x (local +x is the kerb side).
    const span = Math.max(0.12, P.roofY - belt);
    const wAt = (dy) => hw * (P.cabW0 + (P.cabW1 - P.cabW0) * clamp(dy / span, 0, 1)) + 0.010;
    const zD = zCR + (zCF - zCR) * 0.66;
    parts.push(box(0.014, 0.28, 0.30, -wAt(0.15), belt + 0.15, zD, MAT.sil));            // driver torso
    parts.push(box(0.014, 0.18, 0.17, -wAt(0.37), belt + 0.37, zD - 0.02, MAT.silskin)); // driver head
    parts.push(box(0.014, 0.18, 0.26, wAt(0.13), belt + 0.13, zD, MAT.sil));             // empty nearside seat
    parts.push(box(0.014, 0.15, 0.24, -wAt(0.12), belt + 0.12, zCR + (zCF - zCR) * 0.22, MAT.sil));
  }
  return mergeGeometries(parts, false);
}

// a flat polygon in the x-y plane at z, facing +z (dir 1) or -z (dir -1); pts are [x, y] pairs, counter-clockwise
function plate(pts, z, dir, spec) {
  const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))));
  if (dir < 0) g.rotateY(Math.PI);
  g.translate(0, 0, z);
  return tag(g, spec);
}

// a quad strip between two polylines of equal length ([x, y, z] points), wound to face away from the body's centreline
function ribbon(A, B, spec) {
  const n = A.length, pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), idx = [];
  for (let i = 0; i < n; i++) {
    pos.set(A[i], i * 6); pos.set(B[i], i * 6 + 3);
    uv[i * 4] = i / (n - 1); uv[i * 4 + 1] = 0; uv[i * 4 + 2] = i / (n - 1); uv[i * 4 + 3] = 1;
  }
  for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 3, a, a + 3, a + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nor = g.attributes.normal;
  let cx = 0, cz = 0, nx = 0, nz = 0;
  for (let i = 0; i < n * 2; i++) { cx += pos[i * 3]; cz += pos[i * 3 + 2]; nx += nor.getX(i); nz += nor.getZ(i); }
  if (cx * nx + cz * nz < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(idx); g.computeVertexNormals();
  }
  return tag(g, spec);
}

// The 行灯 base on the roof's front edge and the 空車 sign, which sits ON the windscreen's outer face (the glazing is
// opaque, so anything behind it is never seen), tilted with the screen's rake. Both taxi kinds share it.
function taxiExtras(P, lod = 0) {
  const parts = [];
  parts.push(box(0.12, 0.03, 0.36, 0, P.roofY + 0.02, P.andonZ, MAT.dark));
  const rake = Math.atan2(P.rakeF, P.roofY - P.belt), dy = 0.15;
  const zs = P.cabF - P.rakeF * dy / (P.roofY - P.belt);
  parts.push(box(0.24, 0.09, 0.02, 0.22, P.belt + dy + 0.012 * Math.sin(rake), zs + 0.012 * Math.cos(rake), { ...MAT.sign, col: 0xff3320, emis: 1.6 }, [-rake, 0, 0]));
  return mergeGeometries(parts, false);
}

// ---------------------------------------------------------------------------------------------- JPN TAXI
// トヨタ JPN TAXI (2017–), the cab Tokyo runs today: 4.40 × 1.695 × 1.75 m on a 2.75 m wheelbase, a one-and-a-half box
// like a London cab. A very short bonnet with the fender mirrors standing on it, a windscreen raked ~45° up into a tall
// flat roof (the 行灯 on its front edge), a high waistline over slab sides, the front door hinged and the rear kerb-side
// door SLIDING (its lower track a chrome rail along the sill, its upper guide a groove under the quarter window), a small
// quarter light at the foot of the A-pillar, a gloss-black B-pillar, a tall quarter window, a near-vertical tailgate
// with a tall red cluster standing up each rear corner, black lower bumpers carrying a wide trapezoid grille. The sill
// sits at 0.20 m, so the flanks are lofted with the wheels cut into real arches (bus style): the sedan trick (a sill
// above the wheel's centre) would swallow the tyres.
// Local frame: +x is the vehicle's left (the kerb side under left-hand traffic), +z the nose.
function jpnTaxiBody(P, lod = 0) {
  const parts = [];
  const pm = P.paintSpec || MAT.taxipaint;
  const hw = P.hw, zF = P.zF, zB = P.zB, belt = P.belt, yR = P.roofY, y0 = P.sillY;
  const cowl = P.cabF, noseZ = zF - 0.22;                // windscreen base; the bonnet's leading edge
  const AR = P.wheelR + 0.09, WD = 0.34;                  // arch radius, well depth inside the flank
  const A = lod ? 2 : 3;                                  // plan-corner arc segments

  // the top surface: the belt along the sides, the bonnet falling from the cowl to its leading edge, a slight crown
  const deck = (x, z) => {
    let y = belt;
    if (z > cowl) { const t = clamp((z - cowl) / (noseZ - cowl), 0, 1); y = belt + 0.02 - (P.hoodDrop + 0.02) * (0.7 * t + 0.3 * t * t); }
    return y - P.crown * (x * x) / (hw * hw);
  };
  // flank stations (the same z list on every ring so the loft columns line up), dense round each axle
  const ZS = [], KA = lod ? 2 : 9;
  for (const a of P.axles) { for (let k = 0; k <= KA; k++) ZS.push(a + AR * Math.cos(k * Math.PI / KA)); ZS.push(a + AR + 0.06, a - AR - 0.06); }
  ZS.sort((p, q) => q - p);
  for (let i = ZS.length - 1; i > 0; i--) if (ZS[i - 1] - ZS[i] < 0.03) ZS.splice(i, 1);
  // a rounded-rectangle plan of half-width hw·s from zb to zf, corner radius r, the flanks sampled at ZS
  const plan = (s, zf, zb, r) => {
    const w = hw * s, ax = w - r, aF = zf - r, aB = zb + r, pts = [];
    const arc = (cx, cz, a0, a1) => { for (let i = 0; i <= A; i++) { const a = a0 + (a1 - a0) * i / A; pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); } };
    pts.push([0, zf]);
    arc(ax, aF, Math.PI / 2, 0);
    for (const z of ZS) pts.push([w, clamp(z, aB, aF)]);
    arc(ax, aB, 0, -Math.PI / 2);
    pts.push([0, zb]);
    arc(-ax, aB, -Math.PI / 2, -Math.PI);
    for (let i = ZS.length - 1; i >= 0; i--) pts.push([-w, clamp(ZS[i], aB, aF)]);
    arc(-ax, aF, Math.PI, Math.PI / 2);
    return pts;
  };
  const archY = (x, z) => {
    if (Math.abs(x) < hw * 0.8) return 0;
    let y = 0;
    for (const a of P.axles) { const d = z - a; if (Math.abs(d) < AR) y = Math.max(y, P.wheelR + Math.sqrt(AR * AR - d * d)); }
    return y;
  };
  // rings by fraction of the local height (bottom → deck), so the whole stack follows the bonnet down at the nose;
  // the two lowest rows are carved up round the wheels into arches
  const yAt = (f) => (x, z) => y0 + (deck(x, z) - y0) * f;
  const y25 = yAt(0.25);
  const low0 = (x, z) => Math.max(y0, archY(x, z) - 0.03), low1 = (x, z) => Math.max(y25(x, z), archY(x, z));
  const rings = lod ? [
    { shape: low0, pts: plan(0.95, zF - 0.10, zB + 0.10, 0.30) },
    { shape: low1, pts: plan(1.00, zF - 0.02, zB + 0.02, 0.30) },
    { shape: yAt(0.66), pts: plan(1.00, zF - 0.06, zB + 0.04, 0.28) },
    { shape: deck, pts: plan(P.shoulder, noseZ, zB + 0.12, 0.26) },
  ] : [
    { shape: low0, pts: plan(0.95, zF - 0.10, zB + 0.10, 0.30) },
    { shape: low1, pts: plan(1.00, zF - 0.02, zB + 0.02, 0.30) },
    { shape: yAt(0.64), pts: plan(1.00, zF - 0.05, zB + 0.04, 0.28) },
    { shape: yAt(0.87), pts: plan(0.995, zF - 0.14, zB + 0.08, 0.27) },
    { shape: deck, pts: plan(P.shoulder, noseZ, zB + 0.12, 0.26) },
  ];
  const shell = loft(rings, [pm], rings.map(() => 0));
  {
    // the lifted arch rows would bend the flank's normals and shade the panel round each arch: the slab sides face out
    const pa = shell.attributes.position, na = shell.attributes.normal;
    for (let i = 0; i < pa.count; i++) if (Math.abs(pa.getX(i)) > hw * 0.985 && pa.getY(i) < belt - 0.06) na.setXYZ(i, Math.sign(pa.getX(i)), 0, 0);
  }
  parts.push(shell);
  parts.push(cap(rings[rings.length - 1].pts, belt, 1, pm, deck));
  parts.push(cap(rings[0].pts, y0, -1, MAT.dark, low0));
  // the wheel wells: a curved roof (seen from inside) and an inner wall, dark
  for (const a of P.axles) for (const s of [-1, 1]) {
    const roof = new THREE.CylinderGeometry(AR, AR, WD, lod ? 4 : 12, 1, true, 0, Math.PI);
    roof.rotateZ(Math.PI / 2); roof.translate(s * (hw - WD / 2), P.wheelR, a);
    parts.push(tag(flipGeo(roof), MAT.dark));
    if (!lod) parts.push(box(0.02, AR + P.wheelR - 0.20, AR * 2 + 0.04, s * (hw - WD), (AR + P.wheelR + 0.20) / 2, a, MAT.dark));
  }

  // greenhouse. The A-pillar is the raked front corner arc, the B-pillar (gloss black) and the C-pillar (paint) stand at
  // fixed z on both flanks, the D-pillar is the rear corner; everything between is glass. A point's class is the class
  // of the segment leaving it (crispen() duplicates the boundary points): 0 glass, 1 paint, 2 gloss black.
  const [bz0, bz1] = P.pillarB, [cz0, cz1] = P.pillarC, rB = 0.24;
  const cabPlan = (w, zf, zb, rF) => {
    const pts = [], cls = [];
    const put = (x, z, c) => { pts.push([x, z]); cls.push(c); };
    const pil = (i) => (i >= 1 && i < A ? 1 : 0);
    const arc = (cx, cz, r, a0, a1) => { for (let i = 0; i <= A; i++) { const a = a0 + (a1 - a0) * i / A; put(cx + Math.cos(a) * r, cz + Math.sin(a) * r, pil(i)); } };
    const aF = zf - rF, aB = zb + rB;
    put(0, zf, 0);
    arc(w - rF, aF, rF, Math.PI / 2, 0);
    for (const [z, c] of [[bz0, 2], [bz1, 0], [cz0, 1], [cz1, 0]]) put(w, clamp(z, aB, aF), c);
    arc(w - rB, aB, rB, 0, -Math.PI / 2);
    put(0, zb, 0);
    arc(-(w - rB), aB, rB, -Math.PI / 2, -Math.PI);
    for (const [z, c] of [[cz1, 1], [cz0, 0], [bz1, 2], [bz0, 0]]) put(-w, clamp(z, aB, aF), c);
    arc(-(w - rF), aF, rF, Math.PI, Math.PI / 2);
    return crispen({ pts, cls });
  };
  const lerpRing = (a, b, t) => ({ pts: a.pts.map((p, i) => [p[0] + (b.pts[i][0] - p[0]) * t, p[1] + (b.pts[i][1] - p[1]) * t]), cls: a.cls });
  const yB = belt, hSpan = yR - yB;
  const roofF = cowl - P.rakeF, roofR = P.cabR + P.rakeR;
  const g0 = cabPlan(hw * P.cabW0, cowl, P.cabR, P.rCab);
  const g1 = cabPlan(hw * P.cabW1, roofF, roofR, P.rCab);
  const gT = cabPlan(hw * P.cabW1 - 0.07, roofF - 0.06, roofR + 0.06, P.rCab);   // the rolled roof edge's top
  const cabRings = lod ? [
    { y: yB - 0.02, ...g0 },
    { y: yB + 0.03, ...lerpRing(g0, g1, 0.05) },
    { y: yR - 0.07, ...lerpRing(g0, g1, 0.89) },
    { y: yR, ...gT },
  ] : [
    { y: yB - 0.02, ...g0 },
    { y: yB + 0.03, ...lerpRing(g0, g1, 0.05) },
    { y: yB + 0.03, ...lerpRing(g0, g1, 0.05) },
    { y: yB + hSpan * 0.50, ...lerpRing(g0, g1, 0.50) },
    { y: yR - 0.08, ...lerpRing(g0, g1, 0.875) },
    { y: yR - 0.08, ...lerpRing(g0, g1, 0.875) },
    { y: yR - 0.03, ...lerpRing(g1, gT, 0.35) },
    { y: yR, ...gT },
  ];
  parts.push(loft(cabRings, [MAT.taxiglass, pm, MAT.glossBlack], lod ? [1, null, null, 1] : [1, 1, null, null, null, 1, 1, 1]));
  // roof: a fan cap crowned 2 cm at its centre, flat at the rim
  const xw = hw * P.cabW1 - 0.07, zc = (roofF + roofR) / 2, zl = (roofF - roofR) / 2 - 0.06;
  parts.push(cap(gT.pts, yR, 1, pm, (x, z) => yR + 0.02 * Math.max(0, 1 - sq(x / xw) - sq((z - zc) / zl))));

  // bumpers: black below the body colour, their faces just behind the number plates (drawn at zF + 0.035 / zB − 0.035)
  const bF = zF - 0.12, bB = zB + 0.12;
  parts.push(lod ? box(hw * 1.96, 0.30, 0.28, 0, 0.30, bF, MAT.bumper) : roundBox(hw * 2.0, 0.30, 0.28, 0.10, 0, 0.30, bF, MAT.bumper));
  parts.push(lod ? box(hw * 1.96, 0.28, 0.28, 0, 0.28, bB, MAT.bumper) : roundBox(hw * 2.0, 0.28, 0.28, 0.10, 0, 0.28, bB, MAT.bumper));
  // the wide trapezoid lower grille across the bumper (slatted), the slim upper grille between the headlamps under the
  // bonnet's edge with its chrome bar and the badge
  parts.push(plate([[-0.42, 0.20], [0.42, 0.20], [0.50, 0.41], [-0.50, 0.41]], zF + 0.025, 1, MAT.dark));
  if (!lod) for (const yy of [0.25, 0.31, 0.37]) parts.push(box(0.84 + (yy - 0.20) * 0.7, 0.018, 0.012, 0, yy, zF + 0.031, MAT.trim));
  parts.push(box(0.60, 0.10, 0.05, 0, 0.85, zF - 0.155, MAT.dark));
  parts.push(box(0.58, 0.02, 0.02, 0, 0.875, zF - 0.135, MAT.chrome));
  if (!lod) parts.push(box(0.09, 0.05, 0.02, 0, 0.845, zF - 0.115, MAT.chrome));
  // The nose's plan at height yy (the loft's rings interpolated: the face recedes as it climbs to the bonnet's edge)
  const noseW = (yy) => hw * (1.0 - 0.06 * (yy - 0.70)), noseF = (yy) => zF - 0.05 - 0.53 * (yy - 0.67), noseR = 0.28;
  const SWEEP = [90, 72, 54, 36, 18, 0, -20].map((d) => d * Math.PI / 180);
  for (const s of [-1, 1]) {
    // headlamp units: gloss-black swept housings, a strip of quads standing 1.5 cm off the body that runs from beside
    // the upper grille round the corner and back along the fender, its top edge rising as it sweeps back (the lenses,
    // jpnTaxiLamps, sit on the front part)
    const pt = (k, yy) => {
      const w = noseW(yy), zf = noseF(yy);
      if (k === 0) return [s * 0.30, yy, zf + 0.015];
      const a = SWEEP[k - 1];
      return [s * (w - noseR + (noseR + 0.015) * Math.cos(a)), yy, zf - noseR + (noseR + 0.015) * Math.sin(a)];
    };
    const lo = [], hi = [];
    for (let k = 0; k <= 7; k++) { const f = k / 7; lo.push(pt(k, 0.715 + 0.085 * f)); hi.push(pt(k, 0.885 + 0.075 * f)); }
    parts.push(ribbon(lo, hi, MAT.glossBlack));
    // the tall rear clusters standing up both corners of the tailgate, wrapping onto the quarter
    parts.push(box(0.17, 0.46, 0.09, s * (hw - 0.14), P.tailY, zB + 0.10, MAT.glossBlack));
    if (!lod) parts.push(box(0.05, 0.42, 0.16, s * (hw - 0.04), P.tailY, zB + 0.20, MAT.glossBlack, [0, s * 0.30, 0]));
  }
  if (!lod) parts.push(box(0.12, 0.04, 0.02, 0, 1.00, zB + 0.085, MAT.chrome));          // tailgate badge
  parts.push(taxiExtras(P, lod));
  if (lod) return mergeGeometries(parts, false);

  // trim. Door cuts at the A-post base, the B-pillar and the sliding door's rear edge; chrome handles either side of
  // the B-pillar; the sill garnish, which on the kerb side runs on as the sliding door's lower track; the black rocker
  const rake = Math.atan2(P.rakeF, hSpan);
  for (const s of [-1, 1]) {
    const kerb = s > 0;
    parts.push(box(0.04, 0.09, 1.85, s * hw * 0.99, y0 + 0.03, 0.02, MAT.dark));                     // rocker
    for (const z of [P.doorZ[0], bz0, cz0]) parts.push(box(0.012, belt - 0.13 - y0, 0.03, s * hw * 1.003, (belt - 0.03 + y0 + 0.10) / 2, z, MAT.trim));
    parts.push(box(0.03, 0.035, 0.16, s * hw * 1.012, belt - 0.20, bz0 + 0.15, MAT.chrome));           // front door handle
    parts.push(box(0.03, 0.035, 0.16, s * hw * 1.012, belt - 0.20, bz1 - 0.10, MAT.chrome));           // rear door handle
    parts.push(box(0.025, 0.03, bz0 - P.doorZ[0] + 0.02, s * hw * 1.005, y0 + 0.045, (P.doorZ[0] + bz0) / 2, MAT.chrome)); // sill garnish
    if (kerb) {
      parts.push(box(0.035, 0.04, cz0 - bz0 + 0.02, hw * 1.010, y0 + 0.045, (bz0 + cz0) / 2, MAT.chrome));    // lower track
      parts.push(box(0.012, 0.03, P.cabR + 0.14 - cz0, hw * 1.003, belt - 0.06, (cz0 + P.cabR + 0.14) / 2, MAT.dark)); // upper guide
    } else {
      parts.push(box(0.025, 0.03, cz0 - bz0 + 0.02, s * hw * 1.005, y0 + 0.045, (bz0 + cz0) / 2, MAT.chrome));
    }
    // the quarter light: the front door's leading frame runs up from the belt, 0.20 m behind the A-pillar's foot, to
    // meet the pillar 0.30 m up, closing a small triangle of fixed glass at the pillar's base
    {
      const zA = (dy) => cowl - P.rakeF * dy / hSpan - P.rCab;   // the pillar's flank edge, dy over the belt
      const z0 = zA(0.02) - 0.20, z1 = zA(0.30), dyL = 0.28, L = Math.sqrt(sq(dyL) + sq(z1 - z0)), ang = Math.atan2(z0 - z1, dyL);
      const xq = hw * (P.cabW0 - (P.cabW0 - P.cabW1) * 0.25) + 0.014;
      parts.push(box(0.03, L, 0.025, s * xq, belt + 0.02 + dyL / 2, (z0 + z1) / 2, MAT.trim, [-ang, 0, 0]));
    }
    // fender mirrors: a black pod on a stalk standing on the front wing
    parts.push(box(0.035, 0.18, 0.05, s * hw * 0.70, deck(s * hw * 0.70, P.mirrorZ) + 0.08, P.mirrorZ, MAT.dark));
    parts.push(box(0.14, 0.10, 0.08, s * hw * 0.70, deck(s * hw * 0.70, P.mirrorZ) + 0.21, P.mirrorZ, MAT.dark));
  }
  // Occupants. The glazing is opaque, so they are thin silhouettes riding on its outer face, dark against the lit
  // street: a seated figure is a torso, a rounded pair of shoulders and a head. Right-hand drive: the driver sits on
  // the offside (local −x), seen in the front door glass and, through the windscreen, against the dash; the seat
  // headrests show low in the other windows.
  const SIL = { ...MAT.sil, col: 0x232120 }, SKIN = { ...MAT.sil, col: 0x3a2f28 };
  const wAt = (dy) => hw * (P.cabW0 + (P.cabW1 - P.cabW0) * clamp(dy / hSpan, 0, 1)) + 0.010;
  // (built in the x-y plane facing +z, the torso's foot at y = 0, the head's centre at (0, hy); then placed by m)
  const figure = (hy, w, m) => {
    const g = [];
    const hd = new THREE.CircleGeometry(0.085, 12); hd.scale(1, 1.15, 1); hd.translate(0, hy, 0); g.push(tag(hd, SKIN));
    const sh = new THREE.CircleGeometry(w / 2, 12, 0, Math.PI); sh.scale(1, 0.42, 1); sh.translate(0, hy - 0.19, 0); g.push(tag(sh, SIL));
    g.push(box(w, hy - 0.19, 0.012, 0, (hy - 0.19) / 2, 0, SIL));
    const fg = mergeGeometries(g, false); fg.applyMatrix4(m);
    return fg;
  };
  const headrest = (x, dy, z, s) => {
    const g = new THREE.CircleGeometry(0.10, 10); g.scale(1, 0.62, 1); g.rotateY(s * Math.PI / 2); g.translate(x, belt + dy, z);
    return tag(g, SIL);
  };
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
  // the driver in the offside front door glass (the plate faces −x, its width running along the car)
  Q.setFromAxisAngle(UPY, -Math.PI / 2);
  parts.push(figure(0.42, 0.40, M.compose(V.set(-wAt(0.2), belt, bz0 + 0.34), Q, S)));
  // …and through the windscreen, tilted with the screen (a local y step is a step up the rake)
  Q.setFromAxisAngle(RX, -rake);
  parts.push(figure(0.62, 0.42, M.compose(V.set(-0.36, belt + 0.012 * Math.sin(rake), cowl + 0.012 * Math.cos(rake)), Q, S)));
  parts.push(headrest(wAt(0.09), 0.09, bz0 + 0.34, 1));                                   // the empty nearside front seat
  for (const s of [-1, 1]) parts.push(headrest(s * wAt(0.08), 0.08, cz0 + 0.36, s));      // the rear bench
  return mergeGeometries(parts, false);
}

// A 日野ブルーリボン / いすゞエルガ-type city bus: slab sides straight up to a roof edge rolled on a 0.12 m radius, square
// shouldered in plan, a flat upright windscreen in a black-masked face with the LED 方向幕 above it, two axles (twin
// tyres on the rear one), tall combination lamps down the rear corners and the saloon lit through the rear window.
// pax (near buses with passengers, busPax): the glazing is an opening instead of the interior map — the masks behind the
// windscreen and the rear window become frames round them, the painted cab and back-row cut-outs are left out — and the
// result is { body, glass }: the glazing's own triangles go to the see-through glass mesh.
function busBody(P, lod = 0, pax = false) {
  const parts = [];
  const hw = P.hw, zF = P.zF, zB = P.zB;
  const rp = 0.22, R = 0.12, Y = 2.98;                        // plan corner radius, roof-edge radius, roof height
  const AR = 0.64, WD = 0.65;                                  // wheel-arch radius, depth of the well inside the flank
  // The plan: a rounded rectangle whose straight flanks are sampled at ZS (the same z list on every ring, so the loft
  // columns line up), densely round each axle, where the two lowest rings are carved up round the wheels into real
  // arches with a dark well behind them (the pressed-steel wheel sits inside the body line and has to be seen through
  // an opening, not painted on the side)
  const ZS = [], KA = lod ? 6 : 12;
  for (let z = 4.8; z >= -4.8; z -= lod ? 1.8 : 0.9) ZS.push(z);
  for (const a of P.axles) { for (let k = 0; k <= KA; k++) ZS.push(a + AR * Math.cos(k * Math.PI / KA)); ZS.push(a + AR + 0.08, a - AR - 0.08); }
  ZS.sort((p, q) => q - p);
  for (let i = ZS.length - 1; i > 0; i--) if (ZS[i - 1] - ZS[i] < 0.03) ZS.splice(i, 1);
  const plan = (s, inz, r) => {
    const w = hw * s, hl = (zF - zB) / 2 - inz, ax = w - r, az = hl - r, A = lod ? 2 : 3, pts = [];
    const arc = (cx, cz, a0, a1) => { for (let i = 0; i <= A; i++) { const a = a0 + (a1 - a0) * i / A; pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); } };
    pts.push([0, hl]);
    arc(ax, az, Math.PI / 2, 0);
    for (const z of ZS) pts.push([w, z]);
    arc(ax, -az, 0, -Math.PI / 2);
    pts.push([0, -hl]);
    arc(-ax, -az, -Math.PI / 2, -Math.PI);
    for (let i = ZS.length - 1; i >= 0; i--) pts.push([-w, ZS[i]]);
    arc(-ax, az, Math.PI, Math.PI / 2);
    return pts;
  };
  const archY = (x, z) => {
    if (Math.abs(x) < hw * 0.8) return 0;
    let y = 0;
    for (const a of P.axles) { const d = z - a; if (Math.abs(d) < AR) y = Math.max(y, P.wheelR + Math.sqrt(AR * AR - d * d)); }
    return y;
  };
  const low0 = (x, z) => Math.max(0.32, archY(x, z) - 0.03), low1 = (x, z) => Math.max(0.55, archY(x, z));
  const roll = (a) => { const d = R - R * Math.cos(a); return { y: Y - R + R * Math.sin(a), pts: plan(1 - d / hw, d, rp - d) }; };
  const rings = [
    { shape: low0, pts: plan(0.92, 0.12, 0.30) },
    { shape: low1, pts: plan(1.00, 0, rp) },
    { y: 1.22, pts: plan(1.00, 0, rp) },   // green body up to the waist rail
    { y: 1.22, pts: plan(1.00, 0, rp) },
    { y: 1.38, pts: plan(1.00, 0, rp) },   // cream waist band
    { y: 1.38, pts: plan(1.00, 0, rp) },
    { y: 2.34, pts: plan(1.00, 0, rp) },   // glazing
    { y: 2.34, pts: plan(1.00, 0, rp) },
    roll(0), roll(Math.PI / 6), roll(Math.PI / 3), roll(Math.PI / 2),   // cream cove and the rolled roof edge
  ];
  const shell = loft(rings, [MAT.litglass, MAT.paint, MAT.cream], [1, 1, 1, 2, 2, 0, 0, 2, 2, 2, 2, 2]);
  {
    // the lifted arch rows would bend the flank's normals and shade the panel round each arch: flat sides face out
    const pa = shell.attributes.position, na = shell.attributes.normal;
    for (let i = 0; i < pa.count; i++) if (Math.abs(pa.getX(i)) > hw * 0.995 && pa.getY(i) < 2.4) na.setXYZ(i, Math.sign(pa.getX(i)), 0, 0);
  }
  parts.push(shell);
  parts.push(cap(rings[rings.length - 1].pts, Y, 1, MAT.cream));
  parts.push(cap(rings[0].pts, 0.32, -1, MAT.dark, low0));
  // Front: one gloss-black mask from the headlamp line to the roof edge (windscreen surround, pillars, 方向幕 band)
  // across the flat of the face and round both corners, the upright windscreen proud of it. The lit dot-matrix face
  // of the 方向幕 is an instanced plane (destBoards) at P.destZ.
  const fw = (hw - rp) * 2;
  if (pax) {
    // round the windscreen (x ±(fw - 0.16) / 2, y 1.05-2.39): the lower bar up to the dash line, the sides, the 方向幕 band
    const wx = (fw - 0.16) / 2, mx = (fw + 0.02) / 2;
    parts.push(box(fw + 0.02, 0.42, 0.03, 0, 1.19, zF + 0.012, MAT.glossBlack));
    parts.push(box(fw + 0.02, 0.45, 0.03, 0, 2.615, zF + 0.012, MAT.glossBlack));
    for (const s of [-1, 1]) parts.push(box(mx - wx, 0.99, 0.03, s * (wx + mx) / 2, 1.895, zF + 0.012, MAT.glossBlack));
  } else parts.push(box(fw + 0.02, 1.86, 0.03, 0, 1.91, zF + 0.012, MAT.glossBlack));
  for (const s of [-1, 1]) {
    for (const a of [Math.PI / 8, Math.PI * 3 / 8]) {
      const x = hw - rp + (rp + 0.012) * Math.sin(a), z = zF - rp + (rp + 0.012) * Math.cos(a);
      parts.push(box(0.175, 1.86, 0.02, s * x, 1.91, z, MAT.glossBlack, [0, s * a, 0]));
    }
  }
  parts.push(box(fw - 0.16, 1.34, 0.03, 0, 1.72, zF + 0.030, MAT.busglass));
  parts.push(box(hw * 1.5, 0.07, 0.06, 0, 2.90, zF - 0.01, MAT.dark));                    // 車幅灯 strip
  // Rear: a black band across the top carrying the route-number box, the rear window under it (the saloon's ceiling
  // light through it), and the combination lamps' housings down both corners
  parts.push(box(fw + 0.02, 0.34, 0.03, 0, 2.62, zB - 0.012, MAT.glossBlack));
  if (pax) {
    // round the rear window (x ±(fw - 0.26) / 2, y 1.455-2.355)
    const wx = (fw - 0.26) / 2, mx = (fw - 0.10) / 2;
    parts.push(box(fw - 0.10, 0.055, 0.03, 0, 1.4275, zB - 0.012, MAT.glossBlack));
    parts.push(box(fw - 0.10, 0.055, 0.03, 0, 2.3825, zB - 0.012, MAT.glossBlack));
    for (const s of [-1, 1]) parts.push(box(mx - wx, 0.90, 0.03, s * (wx + mx) / 2, 1.905, zB - 0.012, MAT.glossBlack));
  } else parts.push(box(fw - 0.10, 1.01, 0.03, 0, 1.905, zB - 0.012, MAT.glossBlack));
  parts.push(box(fw - 0.26, 0.90, 0.03, 0, 1.905, zB - 0.024, MAT.litglass));
  for (const s of [-1, 1]) parts.push(box(0.25, 0.64, 0.16, s * (hw - 0.155), 0.85, zB + 0.03, MAT.glossBlack));
  // the wheel wells: a curved roof (seen from inside) and an inner wall, dark
  for (const a of P.axles) for (const s of [-1, 1]) {
    const roof = new THREE.CylinderGeometry(AR, AR, WD, lod ? 8 : 14, 1, true, 0, Math.PI);
    roof.rotateZ(Math.PI / 2); roof.translate(s * (hw - WD / 2), P.wheelR, a);
    parts.push(tag(flipGeo(roof), MAT.dark));
    parts.push(box(0.02, AR + P.wheelR - 0.25, AR * 2 + 0.06, s * (hw - WD), (AR + P.wheelR + 0.25) / 2, a, MAT.dark));
  }
  parts.push(lod ? box(hw * 1.96, 0.32, 0.24, 0, 0.42, zF - 0.06, MAT.bumper)
    : roundBox(hw * 2.0, 0.34, 0.26, 0.10, 0, 0.42, zF - 0.06, MAT.bumper));
  parts.push(lod ? box(hw * 1.96, 0.32, 0.24, 0, 0.42, zB + 0.06, MAT.bumper)
    : roundBox(hw * 2.0, 0.34, 0.26, 0.10, 0, 0.42, zB + 0.06, MAT.bumper));
  // roof clutter: AC pack, escape hatches and cross ribs, so the lid is not a white cardboard plane in the sun
  parts.push(box(hw * 1.5, 0.24, 2.6, 0, Y + 0.10, -0.9, MAT.silver));
  if (!lod) {
    parts.push(box(hw * 1.34, 0.08, 2.2, 0, Y + 0.23, -0.9, MAT.dark));
    for (const s of [-1, 1]) parts.push(box(0.7, 0.08, 0.7, s * 0.55, Y + 0.02, s > 0 ? 1.8 : 3.4, MAT.dark));
    for (const z of [-3.6, 0.6, 3.0]) parts.push(box(hw * 1.8, 0.04, 0.10, 0, Y + 0.01, z, MAT.cream));
    parts.push(cyl(0.035, 1.5, hw * 0.72, Y + 0.44, -3.9, MAT.dark, 5));                // aerial
  }
  if (lod) {
    // cheap tier: the livery cove stripes and the lamp bezels are the whole read at 40 m+
    for (const s of [-1, 1]) {
      parts.push(box(0.04, 0.10, zF - zB - 1.1, s * hw * 0.996, 2.46, 0, { paint: 0, rough: 0.40, metal: 0.10, col: 0xb8342c }));
      parts.push(box(0.04, 0.05, zF - zB - 1.4, s * hw * 0.986, 2.60, 0, { paint: 0, rough: 0.40, metal: 0.10, col: 0x2f6b45 }));
      parts.push(box(0.05, 0.08, zF - zB - 0.9, s * hw * 1.006, 1.42, 0, MAT.silver));
      parts.push(box(0.36, 0.18, 0.14, s * hw * 0.80, 0.76, zF - 0.10, MAT.dark));
    }
    parts.push(box((hw - WD) * 2 - 0.04, 0.28, (P.axles[0] - P.axles[1]) + P.wheelR * 2.6, 0, P.wheelR + 0.24, (P.axles[0] + P.axles[1]) / 2, MAT.dark));
    return mergeGeometries(parts, false);
  }
  // the saloon's passengers, seats and grab handles are drawn by the interior map in vehicleMaterial() (and, on a pax
  // body, by the real saloon mesh and the scanned passengers seen through the open glazing)
  // right-hand drive: the driver sits on the offside, local -x (local +x is the kerb side)
  if (!pax) parts.push(box(0.46, 0.52, 0.016, -hw * 0.52, 1.60, zF + 0.052, MAT.sil));
  if (!pax) parts.push(box(0.25, 0.25, 0.016, -hw * 0.52, 1.97, zF + 0.052, MAT.silskin));
  if (!pax) parts.push(box(0.30, 0.30, 0.016, -hw * 0.52, 1.56, zF + 0.054, MAT.dark));            // steering wheel
  // the back row seen through the rear window, dark against the saloon light, over the tops of the seat backs: two
  // sitters of different builds (one with his head on one side) and an empty seat, a strap-hanger further up the aisle
  if (!pax) parts.push(box(fw - 0.30, 0.15, 0.012, 0, 1.62, zB - 0.046, { ...MAT.sil, col: 0x1c2233 }));
  if (!pax) for (const [x, hy, r, w, tilt, dz] of [[-0.60, 2.04, 0.092, 0.40, 0.16, 0.042], [0.50, 2.08, 0.1, 0.44, -0.05, 0.042], [0.02, 2.13, 0.07, 0.26, 0.0, 0.040]]) {
    const hd = new THREE.CircleGeometry(r, 12); hd.scale(1, 1.2, 1); hd.rotateZ(tilt); hd.rotateY(Math.PI); hd.translate(x + tilt * 0.12, hy, zB - dz);
    parts.push(tag(hd, MAT.sil));
    parts.push(box(r * 0.8, r * 1.2, 0.012, x, hy - r * 1.3, zB - dz, MAT.sil));             // neck
    const sh = new THREE.CircleGeometry(w / 2, 14, 0, Math.PI); sh.scale(1, 0.42, 1); sh.rotateY(Math.PI); sh.translate(x, hy - r * 2.3, zB - dz);
    parts.push(tag(sh, MAT.sil));
    parts.push(box(w, hy - r * 2.3 - 1.55, 0.012, x, (hy - r * 2.3 + 1.55) / 2, zB - dz, MAT.sil));
  }
  // window pillars, waist rail, lamps, mirrors
  for (const s of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const z = zB + 1.2 + i * ((zF - zB - 2.4) / 5);
      parts.push(box(0.05, 0.96, 0.075, s * hw * 1.004, 1.86, z, MAT.paint));
    }
    parts.push(box(0.05, 0.08, zF - zB - 0.9, s * hw * 1.006, 1.42, 0, MAT.silver));
    // roof-cove stripes: the only part of the bus that clears a crowd line, so it carries the livery
    parts.push(box(0.04, 0.10, zF - zB - 1.1, s * hw * 0.996, 2.46, 0, { paint: 0, rough: 0.40, metal: 0.10, col: 0xb8342c }));
    parts.push(box(0.04, 0.05, zF - zB - 1.4, s * hw * 0.986, 2.60, 0, { paint: 0, rough: 0.40, metal: 0.10, col: 0x2f6b45 }));
    // mirrors ride above the glazing band, where a Japanese bus carries them — inside it they read as
    // black holes punched through the window line
    parts.push(box(0.18, 0.07, 0.07, s * (hw + 0.10), 2.70, zF - 0.20, MAT.dark));      // mirror arm
    parts.push(box(0.07, 0.30, 0.13, s * (hw + 0.21), 2.58, zF - 0.20, MAT.dark));      // mirror
    parts.push(box(0.36, 0.18, 0.14, s * hw * 0.80, 0.76, zF - 0.10, MAT.dark));        // head bezel
  }
  // passenger door: kerb side only (local +x is LEFT = the kerb under left-hand traffic), two glazed leaves
  for (const o of [-0.19, 0.19]) {
    parts.push(box(0.05, 0.98, 0.36, hw * 1.008, 1.88, P.doorZ + o, MAT.litglass));
    parts.push(box(0.055, 1.14, 0.03, hw * 1.010, 1.88, P.doorZ + o + (o > 0 ? 0.195 : -0.195), MAT.trim));
    for (const dy of [-0.50, 0.48]) parts.push(box(0.055, 0.03, 0.39, hw * 1.010, 1.88 + dy, P.doorZ + o, MAT.trim));
  }
  parts.push(box(0.06, 1.16, 0.035, hw * 1.012, 1.88, P.doorZ, MAT.rubber));            // centre seal
  parts.push(box(0.07, 0.34, 0.80, hw * 1.004, 0.92, P.doorZ, MAT.dark));               // step well
  parts.push(box((hw - WD) * 2 - 0.04, 0.28, (P.axles[0] - P.axles[1]) + P.wheelR * 2.6, 0, P.wheelR + 0.24, (P.axles[0] + P.axles[1]) / 2, MAT.dark)); // chassis
  parts.push(box(hw * 0.8, 0.22, 0.03, 0, 0.62, zB - 0.012, MAT.dark));
  // flank panel seams, a skirt line and the framed side-ad panels (the artwork is an instanced livery quad)
  for (const s of [-1, 1]) {
    for (const z of [-1.85, 0.55, 2.35]) {
      if (s > 0 && Math.abs(z - P.doorZ) < 0.6) continue;
      parts.push(box(0.012, 0.62, 0.022, s * hw * 1.003, 0.88, z, MAT.trim));
    }
    parts.push(box(0.014, 0.024, zF - zB - 0.7, s * hw * 1.003, 0.575, 0, MAT.trim));
  }
  for (const ad of P.ads) {
    const x = ad.s * (hw * 1.004 + 0.006), y = 0.90, h = 0.58;
    parts.push(box(0.02, 0.035, ad.l + 0.07, x, y + h / 2 + 0.017, ad.z, MAT.silver));
    parts.push(box(0.02, 0.035, ad.l + 0.07, x, y - h / 2 - 0.017, ad.z, MAT.silver));
    for (const e of [-1, 1]) parts.push(box(0.02, h + 0.07, 0.035, x, y, ad.z + e * (ad.l / 2 + 0.017), MAT.silver));
  }
  // rear: engine louvres and a bumper step
  parts.push(box(hw * 1.36, 0.46, 0.03, 0, 0.93, zB - 0.02, MAT.dark));
  for (let i = 0; i < 5; i++) parts.push(box(hw * 1.30, 0.035, 0.05, 0, 0.75 + i * 0.09, zB - 0.035, MAT.silver));
  parts.push(box(hw * 1.76, 0.05, 0.16, 0, 0.27, zB + 0.02, MAT.rubber));
  const g = mergeGeometries(parts, false);
  return pax ? splitGlass(g, (zF - zB) / 2) : g;
}

// the glazing (the saloon's lit glass and the windscreen) out of a merged body, as its own index over the same vertices.
// The shell's own glazing band across the flat of the nose and the tail (|z| = zEnd) goes: the windscreen and the rear
// window are their own panes in front of it, and two tinted layers would darken the view in.
function splitGlass(g, zEnd = 5.40) {
  const em = g.attributes.aEmis.array, pz = g.attributes.position.array, idx = g.index.array, body = [], glass = [];
  const isG = (v) => Math.abs(em[v] - MAT.litglass.emis) < 0.004 || Math.abs(em[v] - MAT.busglass.emis) < 0.004;
  const end = (v) => Math.abs(Math.abs(pz[v * 3 + 2]) - zEnd) < 0.002;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (!(isG(a) && isG(b) && isG(c))) body.push(a, b, c);
    else if (!(end(a) && end(b) && end(c))) glass.push(a, b, c);
  }
  const mk = (list) => {
    const o = new THREE.BufferGeometry();
    for (const k in g.attributes) o.setAttribute(k, g.attributes[k]);
    o.setIndex(list); o.computeBoundingSphere();
    return o;
  };
  return { body: mk(body), glass: mk(glass) };
}

// ------------------------------------------------------------------------------------------ the bus saloon (busPax)
// What the open glazing of a near bus shows (bus local: +x the kerb side, +z forward, y up from the road): a low floor
// ahead of the centre door and the raised rear half behind a step, the lit ceiling with its two LED strips, the grey
// walls under the windows and over them, forward-facing blue moquette seats (singles down the front, 2 + 2 behind, the
// back bench), orange grab poles, two ceiling rails with their straps over the front standing area, and the driver's
// seat, wheel and dash behind the windscreen. The passengers are the client's scans, posed by traffic.writeMatrices into
// crowdScan's statics. One merged mesh in the vehicle material; its surfaces are self-lit (aEmis) so the saloon glows
// at night as the interior map did.
const BUS_SAL = {
  floorF: 0.40, floorR: 0.80, stepZ: -0.35, ceil: 2.50, railX: 0.30, railY: 2.36, ringY: 2.14,
  // [x, z, seat surface y] facing forward
  seats: [
    [-0.80, 3.35, 1.10], [0.80, 3.35, 1.10], [-0.80, 2.50, 0.85], [0.80, 2.50, 0.85], [-0.80, 1.70, 0.85], [-0.80, 0.90, 0.85],
    ...[-0.95, -1.75, -2.55, -3.35, -4.15].flatMap((z) => [-0.83, -0.40, 0.40, 0.83].map((x) => [x, z, 1.25])),
    ...[-0.84, -0.42, 0, 0.42, 0.84].map((x) => [x, -4.92, 1.28]),
  ],
  driver: [-0.62, 4.52, 1.02],
  // straps over the front standing area: [rail side, z]
  straps: [-1, 1].flatMap((s) => [-0.05, 0.28, 0.61, 0.94, 1.27, 1.60, 1.93, 2.26, 2.59].map((z) => [s, z])),
  poles: [[-0.52, 3.00], [0.52, 3.00], [-0.52, 2.10], [0.46, 1.98], [0.46, 0.52], [-0.52, 0.45], [-0.14, -0.50], [0.14, -0.50], [-0.18, -2.15], [0.18, -2.15], [-0.18, -3.75], [0.18, -3.75]],
};
const SAL = {
  ceil:  { paint: 0, rough: 0.85, metal: 0.02, col: 0xdcdedc, emis: 0.42 },
  led:   { paint: 0, rough: 0.50, metal: 0.00, col: 0xf0f4fa, emis: 1.30 },
  wall:  { paint: 0, rough: 0.75, metal: 0.04, col: 0xbcc0c2, emis: 0.34 },
  lower: { paint: 0, rough: 0.70, metal: 0.04, col: 0x8a8f94, emis: 0.24 },     // the panels under the windows
  floor: { paint: 0, rough: 0.92, metal: 0.02, col: 0x474b52, emis: 0.22 },
  seat:  { paint: 0, rough: 0.95, metal: 0.00, col: 0x2d3f8c, emis: 0.32 },
  shell: { paint: 0, rough: 0.55, metal: 0.05, col: 0x50555c, emis: 0.24 },
  pole:  { paint: 0, rough: 0.40, metal: 0.10, col: 0xe6a21a, emis: 0.30 },
  rail:  { paint: 0, rough: 0.30, metal: 0.45, col: 0xc5cacf, emis: 0.12 },
  strap: { paint: 0, rough: 0.80, metal: 0.02, col: 0x26282c, emis: 0.12 },
  ring:  { paint: 0, rough: 0.50, metal: 0.05, col: 0xeee6cf, emis: 0.34 },
  dash:  { paint: 0, rough: 0.60, metal: 0.05, col: 0x1b1d21, emis: 0.06 },
};
function busSaloon(P) {
  const S = BUS_SAL, parts = [], hw = P.hw, zF = P.zF, zB = P.zB, iw = hw - 0.05, L = zF - zB - 0.3;
  const zs = (a, b) => [b - a, (a + b) / 2];                   // [length, centre] of a z span
  // floors, the step between them and the driver's platform
  { const [l, c] = zs(S.stepZ, zF - 0.30); parts.push(box(iw * 2, 0.02, l, 0, S.floorF - 0.01, c, SAL.floor)); }
  { const [l, c] = zs(zB + 0.15, S.stepZ); parts.push(box(iw * 2, 0.02, l, 0, S.floorR - 0.01, c, SAL.floor)); }
  parts.push(box(iw * 2, S.floorR - S.floorF, 0.03, 0, (S.floorR + S.floorF) / 2, S.stepZ, SAL.shell));
  parts.push(box(0.95, 0.22, 1.25, -0.66, S.floorF + 0.11, 4.62, SAL.shell));
  for (const s of [-1, 1]) parts.push(box(0.60, 0.25, 0.95, s * 0.80, S.floorF + 0.125, 3.40, SAL.shell));   // front arch plinths
  // ceiling, its LED strips, the walls under and over the glazing, the pillar trims, the front and back walls
  parts.push(box(iw * 2, 0.02, L, 0, S.ceil, 0, SAL.ceil));
  for (const s of [-1, 1]) parts.push(box(0.12, 0.014, L - 0.8, s * 0.46, S.ceil - 0.017, 0, SAL.led));
  for (const s of [-1, 1]) {
    parts.push(box(0.02, 1.38 - 0.36, L, s * iw, (1.38 + 0.36) / 2, 0, SAL.lower));
    parts.push(box(0.07, 0.03, L, s * (iw - 0.03), 1.385, 0, SAL.wall));                     // the sill
    parts.push(box(0.02, S.ceil - 2.34, L, s * iw, (S.ceil + 2.34) / 2, 0, SAL.wall));
    for (let i = 0; i < 6; i++) parts.push(box(0.03, 0.96, 0.11, s * (iw - 0.01), 1.86, zB + 1.2 + i * ((zF - zB - 2.4) / 5), SAL.wall));
  }
  parts.push(box(iw * 2, 1.40 - S.floorF, 0.02, 0, (1.40 + S.floorF) / 2, zF - 0.12, SAL.dash));
  parts.push(box(iw * 2, 1.455 - S.floorR, 0.02, 0, (1.455 + S.floorR) / 2, zB + 0.10, SAL.lower));
  // the cab: dash top under the windscreen, the instrument binnacle, the driver's seat, the wheel on its column, the fare box
  parts.push(box(iw * 2, 0.06, 0.40, 0, 1.40, zF - 0.30, SAL.dash));
  parts.push(box(0.50, 0.16, 0.22, S.driver[0], 1.48, zF - 0.42, SAL.dash));
  { const [x, z, y] = S.driver;
    parts.push(box(0.50, 0.10, 0.48, x, y - 0.05, z, SAL.dash));
    parts.push(box(0.50, 0.80, 0.09, x, y + 0.40, z - 0.28, SAL.dash, [-0.10, 0, 0]));
    const wh = new THREE.TorusGeometry(0.22, 0.02, 4, 14); wh.rotateX(Math.PI / 2 - 0.35); wh.translate(x, 1.46, z + 0.46);
    parts.push(tag(wh, SAL.dash));
    parts.push(cyl(0.03, 0.40, x, 1.28, z + 0.56, SAL.dash, 6));
    parts.push(box(0.30, 0.80, 0.34, x + 0.52, S.floorF + 0.40, z + 0.05, SAL.shell));
  }
  // seats: a moquette cushion and back, the back's grey shell, a grab handle on top; the back bench in one piece
  for (const [x, z, y] of S.seats) {
    if (z < -4.5) continue;
    parts.push(box(0.42, 0.10, 0.42, x, y - 0.05, z, SAL.seat));
    parts.push(box(0.42, 0.60, 0.07, x, y + 0.30, z - 0.235, SAL.seat, [-0.12, 0, 0]));
    parts.push(box(0.43, 0.56, 0.02, x, y + 0.29, z - 0.285, SAL.shell, [-0.12, 0, 0]));
    parts.push(box(0.24, 0.035, 0.035, x + (x > 0 ? -0.06 : 0.06), y + 0.62, z - 0.31, SAL.pole));
  }
  { const b = S.seats.filter((s) => s[1] < -4.5), y = b[0][2], z = b[0][1];
    parts.push(box(2.14, 0.10, 0.44, 0, y - 0.05, z, SAL.seat));
    parts.push(box(2.14, 0.62, 0.08, 0, y + 0.31, z - 0.24, SAL.seat, [-0.10, 0, 0])); }
  // poles floor to ceiling, the two rails and their straps (a black belt, a pale ring)
  for (const [x, z] of S.poles) { const f = z < S.stepZ ? S.floorR : S.floorF; parts.push(cyl(0.018, S.ceil - f, x, (S.ceil + f) / 2, z, SAL.pole, 6)); }
  for (const s of [-1, 1]) parts.push(cyl(0.016, 3.40, s * S.railX, S.railY, 1.20, SAL.rail, 6, 'z'));
  for (const [s, z] of S.straps) {
    parts.push(box(0.022, S.railY - S.ringY - 0.03, 0.012, s * S.railX, (S.railY + S.ringY + 0.03) / 2, z, SAL.strap));
    const r = new THREE.TorusGeometry(0.036, 0.008, 3, 8); r.translate(s * S.railX, S.ringY, z);
    parts.push(tag(r, SAL.ring));
  }
  return mergeGeometries(parts, false);
}

function truckBody(P, lod = 0) {
  const parts = [];
  const hw = P.hw;
  const cabF = P.zF, cabR = P.zF - P.cabL;
  const plan = (s, zf, zb, r) => {
    const g = crispen(rr(hw * s, (zf - zb) / 2, r, lod ? 2 : 3, lod ? 1 : 2));
    return { pts: g.pts.map(p => [p[0], p[1] + (zf + zb) / 2]), cls: g.cls };
  };
  const cabRings = lod ? [
    { y: 0.50, ...plan(0.95, cabF - 0.04, cabR, 0.28) },
    { y: 1.16, ...plan(1.00, cabF, cabR, 0.26) },
    { y: 2.00, ...plan(0.99, cabF - 0.16, cabR, 0.34) },
    { y: 2.16, ...plan(0.92, cabF - 0.32, cabR, 0.40) },
  ] : [
    { y: 0.42, ...plan(0.90, cabF - 0.08, cabR, 0.30) },
    { y: 0.62, ...plan(1.00, cabF, cabR, 0.26) },
    { y: 1.16, ...plan(1.00, cabF, cabR, 0.26) },
    { y: 1.16, ...plan(1.00, cabF - 0.04, cabR, 0.30) },
    { y: 2.00, ...plan(0.99, cabF - 0.16, cabR, 0.34) },
    { y: 2.00, ...plan(0.99, cabF - 0.16, cabR, 0.34) },
    { y: 2.16, ...plan(0.92, cabF - 0.32, cabR, 0.40) },
  ];
  parts.push(loft(cabRings, [MAT.cabglass, MAT.paint], lod ? [1, null, null, 1] : [1, 1, 1, null, null, 1, 1]));
  parts.push(cap(cabRings[cabRings.length - 1].pts, 2.16, 1, MAT.paint));
  parts.push(box(hw * 1.84, 0.80, 0.07, 0, 1.62, cabF - 0.14, MAT.cabglass));
  if (!lod) {
    // the cab is glazed on three sides and used to read as a black hole at night: give it a dash glow and a
    // driver silhouette sitting on the offside (right-hand drive), painted onto the outside of the glazing
    parts.push(box(hw * 1.50, 0.10, 0.05, 0, 1.28, cabF - 0.115, { ...MAT.litglass, col: 0xb3a483, emis: 0.55 }));
    parts.push(box(0.40, 0.46, 0.016, -hw * 0.46, 1.58, cabF - 0.105, MAT.sil));
    parts.push(box(0.22, 0.22, 0.016, -hw * 0.46, 1.90, cabF - 0.105, MAT.silskin));
    parts.push(box(0.26, 0.26, 0.016, -hw * 0.46, 1.53, cabF - 0.108, MAT.dark));   // wheel
    parts.push(box(0.016, 0.44, 0.40, -hw * 1.012, 1.58, cabR + 0.62, MAT.sil));
  }
  // cargo box. The 4 t アルミバン stands its box on a sub-frame over the wheels, ~3.2 m to the roof: taller than its
  // cab, and the one body in a stop-line queue that clears the crowd's heads from the middle of the scramble.
  const bF = cabR + 0.06, bB = P.zB, bBot = P.boxBot, bTop = P.boxTop, bH = bTop - bBot, bY = (bTop + bBot) / 2;
  parts.push(lod ? box(hw * 2.02, bH, bF - bB, 0, bY, (bF + bB) / 2, P.boxMat || MAT.white)
    : roundBox(hw * 2.02, bH, bF - bB, 0.08, 0, bY, (bF + bB) / 2, P.boxMat || MAT.white));
  parts.push(box(hw * 2.04, 0.10, bF - bB - 0.1, 0, bTop + 0.01, (bF + bB) / 2, MAT.silver));
  if (bBot > 0.7) {
    // sub-frame between the chassis and the box floor, and a wind deflector over the low cab
    parts.push(box(hw * 1.84, bBot - 0.74, bF - bB - 0.3, 0, (bBot + 0.74) / 2, (bF + bB) / 2, MAT.dark));
    parts.push(box(hw * 1.70, 0.10, 1.25, 0, 2.52, cabR + 0.72, P.boxMat || MAT.white, [-0.46, 0, 0]));
    for (const s of [-1, 1]) parts.push(box(0.03, bTop - 2.20, 0.95, s * hw * 0.85, 2.42, cabR + 0.52, MAT.dark, [-0.46, 0, 0]));
  }
  parts.push(box(hw * 1.62, 0.07, 0.06, 0, 2.19, cabF - (P.cabL > 1.9 ? 0.27 : 0.23), MAT.dark));   // 車幅灯 strip
  // wheel arches: dark wells in the flanks round every axle (the tandem pair shares one), so a tyre never floats
  const wells = P.tandem ? [[P.axles[0], P.axles[0]], [P.axles[1] - 0.58, P.axles[1] + 0.58]] : P.axles.map((z) => [z, z]);
  const track = hw * 0.84, R2 = P.wheelR * 2;
  for (const [z0, z1] of wells) {
    const inCab = z1 > cabR, L = z1 - z0 + P.wheelR * 2.3;
    if (inCab || bBot < R2) {
      const x = inCab ? hw * 1.004 + 0.006 : hw * 1.012 + 0.006, y0 = inCab ? 0.14 : bBot + 0.01, y1 = R2 + 0.10;
      for (const s of [-1, 1]) parts.push(box(0.02, y1 - y0, L, s * x, (y0 + y1) / 2, (z0 + z1) / 2, MAT.dark));
    } else {
      // tyres under a raised box: a black mudguard over each side
      for (const s of [-1, 1]) {
        parts.push(box(P.wheelW + 0.12, 0.04, L, s * track, R2 + 0.07, (z0 + z1) / 2, MAT.dark));
        parts.push(box(0.03, 0.22, L, s * (track + P.wheelW / 2 + 0.06), R2 - 0.03, (z0 + z1) / 2, MAT.dark));
      }
    }
    parts.push(box(hw * 1.70, 0.30, z1 - z0 + P.wheelR * 2.1, 0, P.wheelR + 0.12, (z0 + z1) / 2, MAT.dark));   // arch liner
  }
  for (const s of [-1, 1]) {
    parts.push(box(0.34, 0.18, 0.13, s * hw * 0.78, 0.74, cabF - 0.10, MAT.dark));
    parts.push(box(0.30, 0.34, 0.10, s * hw * 0.82, 0.86, bB + 0.08, MAT.dark));
    if (lod) continue;
    parts.push(box(0.03, bH - 0.20, 0.06, s * hw * 1.02, bY, bB + 0.4, MAT.silver));
    parts.push(box(0.16, 0.12, 0.08, s * (hw + 0.10), 1.72, cabF - 0.30, MAT.dark));
    parts.push(roundBox(0.09, 0.42, 0.15, 0.05, s * (hw + 0.20), 1.66, cabF - 0.30, MAT.dark));
    // corner posts down both ends of the cargo box + mud flaps behind the rear axle
    parts.push(box(0.055, bH - 0.02, 0.055, s * hw * 1.015, bY, bB + 0.06, MAT.silver));
    parts.push(box(0.055, bH - 0.02, 0.055, s * hw * 1.015, bY, bF - 0.06, MAT.silver));
    parts.push(box(0.035, 0.34, 0.24, s * hw * 0.92, 0.22, P.axles[1] - P.wheelR - (P.tandem ? 0.74 : 0.16), MAT.rubber));
    parts.push(box(0.05, 0.10, bF - bB - 0.2, s * hw * 1.016, bTop - 0.43, (bF + bB) / 2, MAT.silver)); // roof rib rail
  }
  if (!lod) {
    // roll-up shutter on the rear face: three horizontal ribs + a pull bar
    for (let i = 0; i < 3; i++) parts.push(box(hw * 1.86, 0.06, 0.05, 0, bBot + 0.41 + i * (bH - 0.62) / 2, bB + 0.035, MAT.silver));
    parts.push(box(hw * 1.20, 0.07, 0.07, 0, bBot + 0.19, bB + 0.02, MAT.dark));
    parts.push(box(hw * 1.5, 0.16, 0.10, 0, 1.04, cabF - 0.04, MAT.chrome));
    parts.push(box(hw * 0.8, 0.22, 0.05, 0, 0.62, bB + 0.03, MAT.dark));
  }
  parts.push(lod ? box(hw * 1.94, 0.30, 0.24, 0, 0.44, cabF - 0.02, MAT.bumper)
    : roundBox(hw * 1.98, 0.32, 0.26, 0.08, 0, 0.44, cabF - 0.02, MAT.bumper));
  parts.push(box(hw * 1.20, 0.26, (P.axles[0] - P.axles[1]) + P.wheelR * 2.4, 0, P.wheelR + 0.22, (P.axles[0] + P.axles[1]) / 2, MAT.dark)); // chassis rail
  return mergeGeometries(parts, false);
}

// a box laid from one point to another (a limb), th thick
function limbGeo(x0, y0, z0, x1, y1, z1, th, spec) {
  const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0), L = d.length();
  const g = new THREE.BoxGeometry(th, L, th);
  g.translate(0, L / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UPY, d.normalize()));
  g.translate(x0, y0, z0);
  return tag(g, spec);
}
// The rider's helmet and left leg are not in the body: riderParts() places them each frame, so the helmet turns to
// watch the lights while he waits and the left foot goes down to the tarmac when he stops. So is what he carries (a
// courier's backpack or a box on the rack), which differs from rider to rider.
function scooterBody(P, lod = 0) {
  const parts = [];
  const rider = () => {
    for (const s of [-1, 1]) parts.push(box(0.10, 0.10, 0.52, s * 0.20, 1.22, 0.22, MAT.cloth, [0.5, 0, 0]));    // arms to the bars
    for (const s of [-1, 1]) parts.push(box(0.09, 0.09, 0.09, s * 0.25, 1.21, 0.46, MAT.dark));                 // gloves
    parts.push(limbGeo(-0.16, 0.94, -0.04, -0.17, 0.80, 0.20, 0.13, MAT.cloth));                                 // right thigh
    parts.push(limbGeo(-0.17, 0.80, 0.20, -0.17, 0.47, 0.26, 0.12, MAT.cloth));                                  // right shin
    parts.push(box(0.11, 0.09, 0.26, -0.17, 0.46, 0.31, MAT.dark));                                              // right boot
    parts.push(box(0.12, 0.10, 0.10, 0, 1.44, -0.04, MAT.silskin));                                              // neck
  };
  if (lod) {
    parts.push(box(0.36, 0.34, 0.94, 0, 0.60, -0.12, MAT.paint));
    parts.push(box(0.32, 0.44, 0.36, 0, 0.80, 0.60, MAT.paint));
    parts.push(box(0.56, 0.05, 0.06, 0, 1.22, 0.54, MAT.trim));
    parts.push(box(0.40, 0.58, 0.32, 0, 1.18, -0.06, MAT.cloth));
    parts.push(box(0.14, 0.11, 0.07, 0, 0.96, 0.78, MAT.dark));
    rider();
    return mergeGeometries(parts, false);
  }
  parts.push(roundBox(0.34, 0.30, 0.92, 0.12, 0, 0.60, -0.12, MAT.paint));      // body / engine cowl
  parts.push(roundBox(0.36, 0.14, 0.44, 0.08, 0, 0.36, 0.28, MAT.dark));        // floorboard
  parts.push(roundBox(0.30, 0.42, 0.34, 0.10, 0, 0.78, 0.62, MAT.paint));       // front apron
  parts.push(box(0.10, 0.62, 0.10, 0, 0.98, 0.62, MAT.trim, [0.22, 0, 0]));     // fork
  parts.push(box(0.56, 0.05, 0.06, 0, 1.22, 0.54, MAT.trim));                   // handlebar
  parts.push(roundBox(0.30, 0.10, 0.44, 0.06, 0, 0.82, -0.10, MAT.cloth));      // seat
  parts.push(box(0.36, 0.05, 0.30, 0, 0.83, -0.52, MAT.trim));
  parts.push(box(0.14, 0.11, 0.07, 0, 0.96, 0.78, MAT.dark));                   // headlamp bezel
  parts.push(box(0.16, 0.16, 0.03, 0, 0.50, -0.70, MAT.dark));                  // plate recess
  parts.push(roundBox(0.40, 0.56, 0.30, 0.10, 0, 1.18, -0.06, MAT.cloth));      // rider's torso
  rider();
  return mergeGeometries(parts, false);
}

// ---------------------------------------------------------------------------------------------- shared meshes
function wheelGeo(seg = 12) {
  // unit wheel: radius 1 in the y-z plane, 1 unit thick along x (scaled per instance)
  const parts = [];
  const tyre = new THREE.CylinderGeometry(1, 1, 1, seg, 1, true); tyre.rotateZ(Math.PI / 2);
  parts.push(tag(tyre, MAT.rubber));
  for (const s of [-1, 1]) {
    const face = new THREE.RingGeometry(0.66, 1, seg); face.rotateY(s * Math.PI / 2); face.translate(s * 0.5, 0, 0);
    parts.push(tag(face, MAT.rubber));
    const rim = new THREE.RingGeometry(0.26, 0.68, seg); rim.rotateY(s * Math.PI / 2); rim.translate(s * 0.44, 0, 0);
    parts.push(tag(rim, MAT.rim));
    const hub = new THREE.CircleGeometry(0.28, 6); hub.rotateY(s * Math.PI / 2); hub.translate(s * 0.40, 0, 0);
    parts.push(tag(hub, MAT.hub));
  }
  return mergeGeometries(parts, false);
}

// near LOD (under 15 m): a 20-sided tyre with rounded shoulders and bulged sidewalls, a dished alloy with five
// spokes and a centre cap on each face. Same unit space as wheelGeo.
function wheelGeoHi() {
  const parts = [];
  const prof = [[0.64, -0.5], [0.8, -0.505], [0.92, -0.48], [0.975, -0.44], [1.0, -0.34], [1.0, 0.34], [0.975, 0.44],
    [0.92, 0.48], [0.8, 0.505], [0.64, 0.5]].map(([r, h]) => new THREE.Vector2(r, h));
  const tyre = new THREE.LatheGeometry(prof, 20); tyre.rotateZ(-Math.PI / 2);
  parts.push(tag(tyre, MAT.rubber));
  for (const s of [-1, 1]) {
    const face = (g, x, spec) => { g.rotateY(s * Math.PI / 2); g.translate(s * x, 0, 0); parts.push(tag(g, spec)); };
    face(new THREE.RingGeometry(0.58, 0.66, 20), 0.47, MAT.chrome);        // rim lip
    face(new THREE.CircleGeometry(0.6, 20), 0.34, MAT.dark);               // brake / barrel behind the spokes
    face(new THREE.RingGeometry(0.5, 0.6, 20), 0.43, MAT.rim);             // outer rim band
    for (let k = 0; k < 5; k++) {
      const sp = new THREE.BoxGeometry(0.06, 0.34, 0.12);
      sp.translate(0, 0.33, 0); sp.rotateX(k * Math.PI * 2 / 5); sp.translate(s * 0.43, 0, 0);
      parts.push(tag(sp, MAT.rim));
    }
    parts.push(cyl(0.17, 0.08, s * 0.44, 0, 0, MAT.rim, 10, 'x'));        // hub
    face(new THREE.CircleGeometry(0.08, 10), 0.49, MAT.hub);               // centre cap
  }
  return mergeGeometries(parts, false);
}

// near LOD for the cabs: a JPN TAXI's 15-inch steel wheel under its plain silver cover, sixteen slots round a dished
// centre (the spokes between them are the cover), a chrome-less lip and a small centre badge. Same unit space as wheelGeo.
function wheelGeoCover() {
  const parts = [];
  const prof = [[0.60, -0.5], [0.78, -0.505], [0.92, -0.48], [0.975, -0.44], [1.0, -0.34], [1.0, 0.34], [0.975, 0.44],
    [0.92, 0.48], [0.78, 0.505], [0.60, 0.5]].map(([r, h]) => new THREE.Vector2(r, h));
  const tyre = new THREE.LatheGeometry(prof, 20); tyre.rotateZ(-Math.PI / 2);
  parts.push(tag(tyre, MAT.rubber));
  const cover = { ...MAT.steelWheel, col: 0xb9bec4 };
  for (const s of [-1, 1]) {
    const face = (g, x, spec) => { g.rotateY(s * Math.PI / 2); g.translate(s * x, 0, 0); parts.push(tag(g, spec)); };
    face(new THREE.RingGeometry(0.555, 0.62, 20), 0.475, MAT.rim);          // the cover's rolled lip
    face(new THREE.CircleGeometry(0.565, 20), 0.462, cover);                // the cover
    for (let k = 0; k < 16; k++) {                                          // the slots between its spokes
      const g = plate([[-0.022, 0.26], [0.022, 0.26], [0.036, 0.50], [-0.036, 0.50]], 0, 1, MAT.dark);
      g.rotateZ(k * Math.PI / 8); g.rotateY(s * Math.PI / 2); g.translate(s * 0.470, 0, 0);
      parts.push(g);
    }
    face(new THREE.RingGeometry(0.16, 0.20, 12), 0.470, MAT.hub);           // the pressed step round the centre
    face(new THREE.CircleGeometry(0.16, 12), 0.474, cover);                 // centre badge
  }
  return mergeGeometries(parts, false);
}

// turn a geometry inside out (winding and normals), so its inner face is the one drawn
function flipGeo(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}
// near LOD for buses and trucks: a pressed-steel disc wheel. A deep-sidewalled tyre on a small rim, the disc dished well
// inside the rim flange with eight hand-holes round it, a ring of ten wheel nuts and a domed hub cap. Same unit space
// as wheelGeo (radius 1 in y-z, 1 unit thick along x).
function wheelGeoHeavy() {
  const parts = [];
  const prof = [[0.57, -0.5], [0.70, -0.515], [0.84, -0.51], [0.93, -0.48], [0.98, -0.42], [1.0, -0.32], [1.0, 0.32],
    [0.98, 0.42], [0.93, 0.48], [0.84, 0.51], [0.70, 0.515], [0.57, 0.5]].map(([r, h]) => new THREE.Vector2(r, h));
  const tyre = new THREE.LatheGeometry(prof, 20); tyre.rotateZ(-Math.PI / 2);
  parts.push(tag(tyre, MAT.rubber));
  const dz = 0.16;                                        // the disc face, inboard of the tyre's outer face (0.5)
  for (const s of [-1, 1]) {
    const face = (g, x, spec) => { g.rotateY(s * Math.PI / 2); g.translate(s * x, 0, 0); parts.push(tag(g, spec)); };
    face(new THREE.RingGeometry(0.53, 0.585, 20), 0.49, MAT.steelWheel);            // rim flange
    const well = new THREE.CylinderGeometry(0.535, 0.535, 0.49 - dz, 20, 1, true);   // the rim's barrel, seen from inside
    well.rotateZ(Math.PI / 2); well.translate(s * (0.49 + dz) / 2, 0, 0);
    parts.push(tag(flipGeo(well), MAT.steelWheel));
    face(new THREE.RingGeometry(0.30, 0.535, 20), dz, MAT.steelWheel);             // the dished disc
    face(new THREE.RingGeometry(0.30, 0.34, 20), dz + 0.012, MAT.hub);              // the pressed step round the centre
    face(new THREE.CircleGeometry(0.30, 16), dz + 0.02, MAT.steelWheel);            // centre plate
    for (let k = 0; k < 8; k++) {                                                   // hand-holes
      const a = (k + 0.5) * Math.PI / 4, g = new THREE.CircleGeometry(0.068, 8);
      g.translate(Math.sin(a) * 0.43, Math.cos(a) * 0.43, 0);
      g.rotateY(s * Math.PI / 2); g.translate(s * (dz + 0.004), 0, 0);
      parts.push(tag(g, MAT.dark));
    }
    for (let k = 0; k < 10; k++) {                                                  // wheel nuts
      const a = k * Math.PI / 5, g = new THREE.CylinderGeometry(0.034, 0.034, 0.07, 6);
      g.rotateZ(Math.PI / 2); g.translate(s * (dz + 0.05), Math.cos(a) * 0.235, Math.sin(a) * 0.235);
      parts.push(tag(g, MAT.chrome));
    }
    const capG = new THREE.CylinderGeometry(0.10, 0.155, 0.12, 12);                 // hub cap
    capG.rotateZ(-s * Math.PI / 2); capG.translate(s * (dz + 0.08), 0, 0);
    parts.push(tag(capG, MAT.chrome));
  }
  return mergeGeometries(parts, false);
}

function lampGeo() {
  // a slightly domed rounded lens, facing +z, 1x1 unit (scaled per instance)
  const s = new THREE.Shape();
  const w = 0.5, h = 0.5, r = 0.18;
  s.moveTo(-w + r, -h); s.lineTo(w - r, -h); s.quadraticCurveTo(w, -h, w, -h + r);
  s.lineTo(w, h - r); s.quadraticCurveTo(w, h, w - r, h);
  s.lineTo(-w + r, h); s.quadraticCurveTo(-w, h, -w, h - r);
  s.lineTo(-w, -h + r); s.quadraticCurveTo(-w, -h, -w + r, -h);
  const g = new THREE.ShapeGeometry(s, 3);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i, 0.12 * (1 - Math.min(1, (x * x + y * y) * 3.2)));
  }
  g.computeVertexNormals();
  return g;
}

function radialCanvas(size, fn) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    const a = clamp(fn(u, v), 0, 1);
    const i = (y * size + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function radialTexture(size, fn) {
  const t = new THREE.CanvasTexture(radialCanvas(size, fn));
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------------------------- additive fx atlas
// One page for every additive glow that lives in the depth buffer, so they cost one draw call: each instance picks
// its window (offset.xy, size.zw) through aUvT. Cells are drawn inset so mips never bleed between them.
const FX = { halo: 0, star: 1, refl: 2, cone: 3, tail: 4, veil: 5 };
const FX_FN = [
  // halo: soft round glow
  (u, v) => Math.pow(Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 2), 2.6) * 0.9,
  // star: a hot core with a horizontal flare, the way a headlamp reads past ~25 m
  (u, v) => {
    const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
    const core = Math.pow(Math.max(0, 1 - Math.hypot(x, y)), 5.5);
    const hb = Math.pow(Math.max(0, 1 - Math.abs(x)), 2.1) * Math.pow(Math.max(0, 1 - Math.abs(y) * 7), 1.4);
    const vb = Math.pow(Math.max(0, 1 - Math.abs(y)), 2.1) * Math.pow(Math.max(0, 1 - Math.abs(x) * 7), 1.4);
    return Math.min(1, core * 0.75 + hb * 0.6 + vb * 0.4);
  },
  // refl: the mirror smear under a lamp, brightest a third of the way out from its foot
  (u, v) => {
    const lat = Math.pow(Math.max(0, 1 - Math.abs(u - 0.5) * 2), 1.8);
    const lon = smooth01(v / 0.3) * Math.pow(Math.max(0, 1 - (v - 0.3) / 0.7), 1.5) * 0.8 + 0.2 * Math.max(0, 1 - v * 3);
    return lat * Math.min(1, lon);
  },
  // cone: dipped low beam on the road, wide at the bumper, the kerb side (+x) throwing further
  (u, v) => {
    const z = v, x = (u - 0.5) * 2;
    const spread = 0.55 + z * 0.5;
    const lat = Math.max(0, 1 - Math.abs(x) / spread);
    const reach = 0.72 + 0.28 * smooth01((x + 0.2) / 0.6);
    const lon = Math.pow(Math.max(0, 1 - z / reach), 1.35) * Math.min(1, z * 8 + 0.1);
    return Math.pow(lat, 1.4) * lon;
  },
  // tail: the long run of a smear toward the eye (v = 0 at the lamp end), dying away over the last 40 % of its run;
  // the quad widens with the length of the run, so the core narrows a little toward the eye and the smear holds a
  // steady, slightly growing width on screen
  (u, v) => {
    const w = 1 - 0.45 * v;
    const lat = Math.pow(Math.max(0, 1 - Math.abs(u - 0.5) * 2 / w), 1.6);
    return lat * (1 - 0.45 * v) * (1 - smooth01((v - 0.6) / 0.4)) * smooth01(v / 0.1);
  },
  // veil: the broad haze of light a bank of dipped beams throws over the heads of a crowd
  (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    return Math.pow(Math.max(0, 1 - d), 3.2) * 0.55 + Math.pow(Math.max(0, 1 - d), 1.4) * 0.45;
  },
];
function fxAtlas() {
  const C = 128, cols = 3, rows = 2, pad = 3, S = C - pad * 2;
  const c = document.createElement('canvas'); c.width = C * cols; c.height = C * rows;
  const ctx = c.getContext('2d');
  const win = [];
  FX_FN.forEach((fn, i) => {
    const x = (i % cols) * C, y = Math.floor(i / cols) * C;
    ctx.drawImage(radialCanvas(S, fn), x + pad, y + pad);
    win.push([(x + pad) / c.width, 1 - (y + pad + S) / c.height, S / c.width, S / c.height]);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // the pool is cut into CONE_SEG slices along the car, each with its band of the gradient (slice 0 at the bumper)
  const cw = win[FX.cone], cones = [];
  for (let k = 0; k < CONE_SEG; k++) cones.push([cw[0], cw[1] + cw[3] * (1 - (k + 1) / CONE_SEG), cw[2], cw[3] / CONE_SEG]);
  return { tex, win, cones };
}
// a vertical unit quad laid flat on the road, running from the instance origin along +z
const FLAT = new THREE.Matrix4().makeTranslation(0, 0, 0.5).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

// the atlas-window variant of uvOffBasic. `tail` (an atlas window) gets the rain shimmer: the drops on the water film
// break a lamp's smear into slow ripples along its run
// (clampOut: no single quad adds more than 1.2 linear to a pixel, so a smear can never clip white through the bloom)
function uvWindowBasic(tex, name, opts = {}, tail = null, clampOut = false) {
  const m = new THREE.MeshBasicMaterial({ map: tex, toneMapped: true, name, ...opts });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time;
    sh.uniforms.uTail = { value: new THREE.Vector2(tail ? tail[0] : -1, tail ? tail[1] : -1) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aUvT;\nvarying vec4 vUvT;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvUvT = aUvT;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vUvT;\nuniform float uTime;\nuniform vec2 uTail;')
      .replace('#include <map_fragment>', `\tdiffuseColor *= texture2D( map, vUvT.xy + vMapUv * vUvT.zw );
        if ( abs( vUvT.x - uTail.x ) < 1e-4 && abs( vUvT.y - uTail.y ) < 1e-4 ) {
          float r1 = sin( vMapUv.y * 41.0 + uTime * 1.3 + vMapUv.x * 4.0 ) * 0.5 + 0.5;
          float r2 = sin( vMapUv.y * 97.0 - uTime * 2.1 + vMapUv.x * 9.0 + 1.7 ) * 0.5 + 0.5;
          diffuseColor.a *= 0.64 + 0.5 * r1 * ( 0.45 + 0.55 * r2 );
        }`);
    if (clampOut) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>',
        '#include <opaque_fragment>\n\tgl_FragColor.rgb = min( gl_FragColor.rgb, vec3( 1.2 ) / max( gl_FragColor.a, 1e-3 ) );');
    }
  };
  m.customProgramCacheKey = () => name + (clampOut ? ':c' : '');
  return m;
}

// ---------------------------------------------------------------------------------------------- glare occlusion
// The headlight glare is drawn without a depth test so it reads through the crowd, which means buildings have to hide
// it by hand: the city's building colliders (physics statics, minus poles, props and trees) binned on an 8 m grid,
// and a 2.5D segment test from the eye to the lamp.
const OCC_CELL = 8;
const OCC_SKIP = new Set(['pole', 'prop', 'tree', 'vehicle', 'rail', 'bounds', 'hachikoStatue', 'moyai']);
function buildOccluders(world) {
  const st = world && world.statics;
  if (!st || !st.length) return null;
  const boxes = [];
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  for (const s of st) {
    if (OCC_SKIP.has(s.tag)) continue;
    let b;
    if (s.kind === 'aabb' && s.min && s.max) {
      b = { cx: (s.min.x + s.max.x) / 2, cz: (s.min.z + s.max.z) / 2, hx: (s.max.x - s.min.x) / 2, hz: (s.max.z - s.min.z) / 2, c: 1, s: 0, y0: s.min.y, y1: s.max.y };
    } else if (s.center && s.half && isFinite(s.c)) {
      b = { cx: s.center.x, cz: s.center.z, hx: s.half.x, hz: s.half.z, c: s.c, s: s.s, y0: s.center.y - s.half.y, y1: s.center.y + s.half.y };
    } else continue;
    if (b.y1 - Math.max(0, b.y0) < 2.2 || Math.min(b.hx, b.hz) < 0.3) continue;
    b.ex = Math.abs(b.c) * b.hx + Math.abs(b.s) * b.hz; b.ez = Math.abs(b.s) * b.hx + Math.abs(b.c) * b.hz; b.st = 0;
    x0 = Math.min(x0, b.cx - b.ex); x1 = Math.max(x1, b.cx + b.ex); z0 = Math.min(z0, b.cz - b.ez); z1 = Math.max(z1, b.cz + b.ez);
    boxes.push(b);
  }
  if (!boxes.length) return null;
  const nx = Math.ceil((x1 - x0) / OCC_CELL) + 1, nz = Math.ceil((z1 - z0) / OCC_CELL) + 1;
  const cells = new Array(nx * nz);
  boxes.forEach((b, i) => {
    const gx0 = Math.floor((b.cx - b.ex - x0) / OCC_CELL), gx1 = Math.floor((b.cx + b.ex - x0) / OCC_CELL);
    const gz0 = Math.floor((b.cz - b.ez - z0) / OCC_CELL), gz1 = Math.floor((b.cz + b.ez - z0) / OCC_CELL);
    for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) (cells[gz * nx + gx] || (cells[gz * nx + gx] = [])).push(i);
  });
  return { boxes, cells, x0, z0, nx, nz, stamp: 0 };
}
function segBox(b, ax, ay, az, dx, dy, dz) {
  const rx = ax - b.cx, rz = az - b.cz;
  const lx = b.c * rx - b.s * rz, lz = b.s * rx + b.c * rz;
  const ldx = b.c * dx - b.s * dz, ldz = b.s * dx + b.c * dz;
  let t0 = 0.03, t1 = 0.97;                           // the eye and the lamp themselves never count
  if (Math.abs(ldx) < 1e-9) { if (Math.abs(lx) > b.hx) return false; } else {
    let u0 = (-b.hx - lx) / ldx, u1 = (b.hx - lx) / ldx;
    if (u0 > u1) { const q = u0; u0 = u1; u1 = q; }
    if (u0 > t0) t0 = u0; if (u1 < t1) t1 = u1; if (t0 > t1) return false;
  }
  if (Math.abs(ldz) < 1e-9) { if (Math.abs(lz) > b.hz) return false; } else {
    let u0 = (-b.hz - lz) / ldz, u1 = (b.hz - lz) / ldz;
    if (u0 > u1) { const q = u0; u0 = u1; u1 = q; }
    if (u0 > t0) t0 = u0; if (u1 < t1) t1 = u1; if (t0 > t1) return false;
  }
  const ya = ay + dy * t0, yb = ay + dy * t1;
  return Math.min(ya, yb) < b.y1 && Math.max(ya, yb) > b.y0;
}
function occBlocked(O, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dz = bz - az, L = Math.sqrt(sq(dx) + sq(dz));
  if (L < 1) return false;
  const stamp = ++O.stamp, n = Math.ceil(L / (OCC_CELL * 0.35));
  let last = -1;
  for (let i = 0; i <= n; i++) {
    const gx = Math.floor((ax + dx * i / n - O.x0) / OCC_CELL), gz = Math.floor((az + dz * i / n - O.z0) / OCC_CELL);
    if (gx < 0 || gz < 0 || gx >= O.nx || gz >= O.nz) continue;
    const ci = gz * O.nx + gx;
    if (ci === last) continue;
    last = ci;
    const list = O.cells[ci];
    if (!list) continue;
    for (let k = 0; k < list.length; k++) {
      const b = O.boxes[list[k]];
      if (b.st === stamp) continue;
      b.st = stamp;
      if (segBox(b, ax, ay, az, dx, by - ay, dz)) return true;
    }
  }
  return false;
}
// How much of the crowd stands between the eye and a lamp: people in crowd's carriageway grid (4 m cells over ±240 m)
// at three points out along the ray, 0 (clear) .. 1 (packed).
const OCC_S = [5, 13, 26];
function crowdOcc(cr, cx, cz, gx, gz) {
  const head = cr.rHead, next = cr.rNext;
  if (!head || !next) return 0;
  const dx = gx - cx, dz = gz - cz, d = Math.sqrt(sq(dx) + sq(dz)) || 1;
  let occ = 0;
  for (let k = 0; k < 3; k++) {
    const s = Math.min(d * 0.8, OCC_S[k]);
    const ix = ((cx + dx / d * s + 240) / 4) | 0, iz = ((cz + dz / d * s + 240) / 4) | 0;
    if (ix < 0 || iz < 0 || ix > 119 || iz > 119) continue;
    let n = 0;
    for (let i = head[iz * 120 + ix]; i >= 0 && n < 6; i = next[i]) n++;
    occ += Math.min(1, n / 5);
  }
  return occ / 3;
}
// Is the straight line from the eye to a lamp cut by somebody out on the carriageway (crowd's grid again)? A person is
// their shoulders (a 0.24 m post up to 0.82 of their height) with a 0.1 m head on top, up to the crown (crowd.js
// RIG_CROWN 1.772 m x scale): a line passing at head height slips between two heads. Walking the ray outward through
// 4 m cells finds the few who matter; the result is how far out the first of them stands (about: to within a cell),
// or -1 for a clear line.
const P_CROWN = 1.772, P_SHOULDER = 1.45, P_BODY = 0.24, P_HEAD = 0.1;
function personCuts(lat, y, sc) {
  if (y >= P_CROWN * sc || lat > P_BODY * sc) return false;
  return y < P_SHOULDER * sc || lat < P_HEAD * sc;
}
function crowdBlocks(cr, ax, ay, az, bx, by, bz) {
  const head = cr.rHead, next = cr.rNext, peds = cr.peds;
  if (!head || !next || !peds) return -1;
  const dx = bx - ax, dz = bz - az, L = Math.sqrt(sq(dx) + sq(dz));
  if (L < 1) return -1;
  const ux = dx / L, uz = dz / L, n = Math.ceil(L / 2);
  let l1 = -1, l2 = -1;
  for (let i = 0; i <= n; i++) {
    const s = (i * L) / n;
    const ix = ((ax + ux * s + 240) / 4) | 0, iz = ((az + uz * s + 240) / 4) | 0;
    if (ix < 0 || iz < 0 || ix > 119 || iz > 119) continue;
    const ci = iz * 120 + ix;
    if (ci === l1 || ci === l2) continue;
    l2 = l1; l1 = ci;
    for (let k = head[ci]; k >= 0; k = next[k]) {
      const p = peds[k];
      if (!p) continue;
      const rx = p.x - ax, rz = p.z - az, t = rx * ux + rz * uz;
      if (t < 0.4 || t > L - 0.6) continue;
      const sc = p.scale || 1;
      if (personCuts(Math.abs(rx * uz - rz * ux), ay + (by - ay) * (t / L), sc)) return t;
    }
  }
  return -1;
}

// The same test for n points close together at the far end of one line (a vehicle's lamps, its 行灯, its 方向幕): one
// walk along the ray to their middle collects everybody within reach of any of them, and each point's own line is then
// tested against those few. out[k]: how far out the first person cutting point k's line stands, or -1.
const _CBL = new Float32Array(24 * 3);
function crowdBlocksMulti(cr, ax, ay, az, P, n, out) {
  for (let k = 0; k < n; k++) out[k] = -1;
  const head = cr && cr.rHead, next = cr && cr.rNext, peds = cr && cr.peds;
  if (!head || !next || !peds || !n) return;
  let cx = 0, cz = 0;
  for (let k = 0; k < n; k++) { cx += P[k * 3]; cz += P[k * 3 + 2]; }
  cx /= n; cz /= n;
  const dx = cx - ax, dz = cz - az, L = Math.sqrt(sq(dx) + sq(dz));
  if (L < 1) return;
  const ux = dx / L, uz = dz / L;
  // each point's own ray (unit direction, length), and how far off the middle ray the farthest of them lies
  let spread = 0;
  for (let k = 0; k < n; k++) {
    const ex = P[k * 3] - ax, ez = P[k * 3 + 2] - az, Lk = Math.sqrt(sq(ex) + sq(ez)) || 1;
    _CBL[k * 3] = ex / Lk; _CBL[k * 3 + 1] = ez / Lk; _CBL[k * 3 + 2] = Lk;
    spread = Math.max(spread, Math.abs(ex * uz - ez * ux));
  }
  const steps = Math.ceil(L / 2);
  let l1 = -1, l2 = -1, left = n;
  for (let i = 0; i <= steps && left > 0; i++) {
    const s = (i * L) / steps;
    const ix = ((ax + ux * s + 240) / 4) | 0, iz = ((az + uz * s + 240) / 4) | 0;
    if (ix < 0 || iz < 0 || ix > 119 || iz > 119) continue;
    const ci = iz * 120 + ix;
    if (ci === l1 || ci === l2) continue;
    l2 = l1; l1 = ci;
    for (let q = head[ci]; q >= 0; q = next[q]) {
      const p = peds[q];
      if (!p) continue;
      const rx = p.x - ax, rz = p.z - az, t = rx * ux + rz * uz;
      if (t < 0.4 || t > L + 1) continue;
      const sc = p.scale || 1;
      if (Math.abs(rx * uz - rz * ux) > 0.24 * sc + spread * t / L + 0.05) continue;
      for (let k = 0; k < n; k++) {
        if (out[k] >= 0) continue;
        const vx = _CBL[k * 3], vz = _CBL[k * 3 + 1], Lk = _CBL[k * 3 + 2];
        const tk = rx * vx + rz * vz;
        if (tk < 0.4 || tk > Lk - 0.6) continue;
        if (personCuts(Math.abs(rx * vz - rz * vx), ay + (P[k * 3 + 1] - ay) * (tk / Lk), sc)) { out[k] = tk; left--; }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------- licence plates
const PLATE_REGIONS = ['品川', '世田谷', '練馬', '足立', '多摩', '横浜', '川崎', '渋谷'];
const PLATE_KANA = ['さ', 'す', 'せ', 'そ', 'た', 'な', 'は', 'ま', 'わ', 'れ'];
const PLATE_COLS = 4, PLATE_ROWS = 4;

function plateAtlas(rng) {
  const CW = 256, CH = 128;
  const c = document.createElement('canvas');
  c.width = CW * PLATE_COLS; c.height = CH * PLATE_ROWS;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const cells = [];
  for (let i = 0; i < PLATE_COLS * PLATE_ROWS; i++) {
    // 0-7 private (white/green), 8-11 commercial (green/white), 12-15 kei (yellow/black)
    const kind = i < 8 ? 0 : i < 12 ? 1 : 2;
    const bg = kind === 0 ? '#f2f3ee' : kind === 1 ? '#0e6b3a' : '#f5d21a';
    const fg = kind === 0 ? '#1d6b40' : kind === 1 ? '#f3f5f0' : '#17181a';
    const x = (i % PLATE_COLS) * CW, y = Math.floor(i / PLATE_COLS) * CH;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = bg; ctx.fillRect(4, 4, CW - 8, CH - 8);
    ctx.strokeStyle = fg; ctx.lineWidth = 4; ctx.strokeRect(9, 9, CW - 18, CH - 18);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const region = PLATE_REGIONS[rng.int(0, PLATE_REGIONS.length - 1)];
    const code = String(rng.int(1, 5)) + String(rng.int(0, 9)) + String(rng.int(0, 9));
    ctx.font = '600 30px "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.fillText(region, CW * 0.36, 36);
    ctx.font = '600 34px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(code, CW * 0.70, 36);
    ctx.font = '600 40px "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.fillText(PLATE_KANA[rng.int(0, PLATE_KANA.length - 1)], CW * 0.16, 84);
    ctx.font = '700 58px "Helvetica Neue", Arial, sans-serif';
    const n = rng.int(10, 99) + '-' + String(rng.int(0, 99)).padStart(2, '0');
    ctx.fillText(n, CW * 0.60, 86);
    ctx.restore();
    cells.push(kind);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, cells };
}

function plateMaterial(tex, name = 'traffic:plate', rough = 0.5) {
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: rough, metalness: 0.0, name });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aUvOff;\nvarying vec2 vUvOff;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvUvOff = aUvOff;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vUvOff;')
      .replace('#include <map_fragment>', '\tdiffuseColor *= texture2D( map, vMapUv + vUvOff );');
  };
  m.customProgramCacheKey = () => name;
  return m;
}

// Same per-instance atlas-cell trick on an unlit material: one page serves boards, roof lamps and van flanks.
function uvOffBasic(tex, name, opts = {}) {
  const m = new THREE.MeshBasicMaterial({ map: tex, toneMapped: true, name, ...opts });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aUvOff;\nvarying vec2 vUvOff;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvUvOff = aUvOff;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vUvOff;')
      .replace('#include <map_fragment>', '\tdiffuseColor *= texture2D( map, vMapUv + vUvOff );');
  };
  m.customProgramCacheKey = () => name;
  return m;
}

function atlasCanvas(cols, rows, cw, ch) {
  const c = document.createElement('canvas');
  c.width = cols * cw; c.height = rows * ch;
  return { c, ctx: c.getContext('2d'), cols, rows, cw, ch };
}
function atlasTex(a, aniso) {
  const t = new THREE.CanvasTexture(a.c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso || 8;
  return t;
}
// cell -> the uv offset that shifts a 1/cols x 1/rows tile onto it
function cellUv(a, i) {
  return [(i % a.cols) / a.cols, 1 - (Math.floor(i / a.cols) + 1) / a.rows];
}
function remapUv(geo, cols, rows) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / cols, uv.getY(i) / rows);
  return geo;
}
// A Tokyo cab's 行灯: a small fin on the roof's front edge, 34 cm long, 13 cm tall and 9 cm across, the company name on
// its two long faces (the sign is read from the kerb); the narrow ends and the top carry the sign's colour alone, a
// patch of the atlas cell's clear margin (BoxGeometry face order: +x, −x, +y, −y, +z, −z, four vertices each).
function andonGeo(cols, rows) {
  const g = new THREE.BoxGeometry(0.09, 0.13, 0.34);
  const uv = g.attributes.uv;
  for (let i = 8; i < 24; i++) uv.setXY(i, 0.02 + 0.01 * uv.getX(i), 0.40 + 0.2 * uv.getY(i));
  return remapUv(g, cols, rows);
}

// --------------------------------------------------------------------------------- 方向幕 (bus destination board)
const DESTS = [['渋51', '渋谷駅前'], ['東98', '三軒茶屋'], ['渋12', '大橋'], ['都06', '新橋']];
const N_GENERIC_DEST = DESTS.length;           // the fleet's random boards; the 東口 terminal's own come after them
// 東口 bus terminal (cityData busTerminals.higashi, busStops[].terminal === 'higashi'): every 系統 at its のりば, in the
// order of the stops. `dyn` = served by the loop's traffic (its のりば stands on the busway).
const EAST_T = CITY.busTerminals && CITY.busTerminals.higashi;
const EAST_BW = EAST_T ? EAST_T.busway : null;
const EAST_ROUTES = [];
for (const st of CITY.busStops || []) {
  if (st.terminal !== 'higashi') continue;
  for (const r of st.routes || []) EAST_ROUTES.push({ ...r, stop: st.id, ref: st.ref, op: st.op, dyn: !!st.road, dest: DESTS.length + EAST_ROUTES.length });
}
for (const r of EAST_ROUTES) DESTS.push([r.no, r.to, r]);
const DEST_COLS = 4, DEST_FRONT_ROWS = Math.ceil(DESTS.length / 4), DEST_ROWS = 2 * DEST_FRONT_ROWS;
const DEST_DIMS = { cols: DEST_COLS, rows: DEST_ROWS };
const destUvOf = (i) => [...cellUv(DEST_DIMS, i), ...cellUv(DEST_DIMS, DEST_FRONT_ROWS * DEST_COLS + i)];

function destAtlas() {
  const CW = 320, CH = 96;
  const a = atlasCanvas(DEST_COLS, DEST_ROWS, CW, CH), ctx = a.ctx;
  ctx.fillStyle = '#080604'; ctx.fillRect(0, 0, a.c.width, a.c.height);
  // amber LED dot matrix: paint the glyphs, then punch a pixel grid through them
  const dots = (x, y, w, h) => {
    ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = '#000';
    for (let gy = 0; gy < h; gy += 4) ctx.fillRect(x, y + gy + 3, w, 1);
    for (let gx = 0; gx < w; gx += 4) ctx.fillRect(x + gx + 3, y, 1, h);
    ctx.restore();
  };
  const fit = (txt, px, weight, fam, maxW) => {
    ctx.font = `${weight} ${px}px ${fam}`;
    while (ctx.measureText(txt).width > maxW && px > 18) { px -= 2; ctx.font = `${weight} ${px}px ${fam}`; }
  };
  const LAT = '"Helvetica Neue", Arial, sans-serif', JP = '"Hiragino Sans", "Noto Sans JP", sans-serif';
  for (let i = 0; i < DESTS.length; i++) {
    const d = DESTS[i], east = d[2];
    for (const rear of [false, true]) {
      const cell = rear ? DEST_FRONT_ROWS * DEST_COLS + i : i;
      const x = (cell % DEST_COLS) * CW, y = Math.floor(cell / DEST_COLS) * CH;
      ctx.save(); ctx.translate(x, y);
      ctx.fillStyle = '#0a0806'; ctx.fillRect(0, 0, CW, CH);
      ctx.textBaseline = 'middle';
      if (east) {
        // full-colour LED as on the 都営 / 東光 fleets: the 系統 in its colour box, the 行き先 in white, the English under it
        const col = (EAST_T.routeColors && EAST_T.routeColors[d[0]]) || '#e4007f';
        if (!rear) {
          ctx.fillStyle = col; ctx.fillRect(8, 14, 92, CH - 28);
          ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
          fit(d[0], 44, 800, LAT, 84); ctx.fillText(d[0], 54, CH * 0.52);
          ctx.fillStyle = '#fff4d8'; ctx.textAlign = 'center';
          fit(d[1], 50, 700, JP, CW - 124); ctx.fillText(d[1], 112 + (CW - 124) / 2, CH * 0.42);
          ctx.fillStyle = '#ffc860'; fit(east.en || '', 16, 700, LAT, CW - 124); ctx.fillText(east.en || '', 112 + (CW - 124) / 2, CH * 0.82);
        } else {
          ctx.fillStyle = col; ctx.fillRect(40, 10, CW - 80, CH - 20);
          ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; fit(d[0], 62, 800, LAT, CW - 100); ctx.fillText(d[0], CW / 2, CH * 0.53);
        }
      } else if (!rear) {                      // front board: route badge + destination
        ctx.fillStyle = '#ffb02a'; ctx.textAlign = 'left';
        ctx.font = `700 46px ${LAT}`;
        ctx.fillText(d[0], 16, CH * 0.52);
        ctx.font = `700 60px ${JP}`;
        ctx.textAlign = 'right';
        ctx.fillText(d[1], CW - 16, CH * 0.53);
        ctx.fillStyle = '#7a4a10';
        ctx.fillRect(14, CH - 14, CW - 28, 3);
      } else {                                 // rear plate: route number only
        ctx.fillStyle = '#ffb02a'; ctx.textAlign = 'center';
        ctx.font = `700 62px ${LAT}`;
        ctx.fillText(d[0], CW / 2, CH * 0.53);
      }
      ctx.restore();
      dots(x, y, CW, CH);
    }
  }
  // re-lay the black背景 under the punched grid so the panel stays opaque
  const out = atlasCanvas(DEST_COLS, DEST_ROWS, CW, CH);
  out.ctx.fillStyle = '#0a0806'; out.ctx.fillRect(0, 0, out.c.width, out.c.height);
  out.ctx.drawImage(a.c, 0, 0);
  return atlasTex(out, 8);
}

// --------------------------------------------------------------------------------- taxi 行灯 (roof lamp)
// Painted here rather than pulled from signage so the lit company name can never drift out of sync.
function roofAtlas(companies) {
  const CW = 320, CH = 128, cols = 2, rows = 2;
  const a = atlasCanvas(cols, rows, CW, CH), ctx = a.ctx;
  const index = new Map();
  companies.forEach((co, i) => {
    if (i >= cols * rows) return;
    index.set(co.name, i);
    const x = (i % cols) * CW, y = Math.floor(i / cols) * CH;
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = co.bg; ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(0, 0, CW, 10); ctx.fillRect(0, CH - 10, CW, 10);
    ctx.fillStyle = co.fg;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const txt = co.name;
    let px = 74;
    ctx.font = `700 ${px}px "Hiragino Sans", "Noto Sans JP", sans-serif`;
    while (ctx.measureText(txt).width > CW - 34 && px > 22) {
      px -= 3; ctx.font = `700 ${px}px "Hiragino Sans", "Noto Sans JP", sans-serif`;
    }
    ctx.fillText(txt, CW / 2, CH * 0.53);
    ctx.restore();
  });
  return { tex: atlasTex(a, 8), index, cols, rows };
}

// --------------------------------------------------------------------------------- 運送 van / truck flank livery
const CARRIERS = [
  { name: '飛脚急便', bg: '#f2f4f6', fg: '#123f8f', band: '#123f8f', sub: 'HIKYAKU EXPRESS' },
  { name: '日本通連', bg: '#f4f1ea', fg: '#c8461e', band: '#c8461e', sub: 'NIPPON TSUREN' },
  { name: 'クロネヨ運輸', bg: '#f2f4f2', fg: '#175b3a', band: '#e2c21a', sub: 'KURONEYO' },
  { name: '渋谷町運送', bg: '#eef1f4', fg: '#1d2430', band: '#9b1f24', sub: 'SHIBUYACHO LOGISTICS' },
];
// 側面広告 in the framed panel along a bus's flank, between the axles. The panel is ~5.4:1 and the cell 2:1, so the
// artwork is painted squeezed to 0.37 width and stretched back out by the quad.
const BUS_ADS = [
  { bg: ['#2a0f3c', '#7a1f6e'], lines: [['SHIBUYA46', '#ffffff', '800 150px "Helvetica Neue", Arial, sans-serif'], ['新曲「スクランブル」配信中', '#ffd6f2', '700 92px "Hiragino Sans", "Noto Sans JP", sans-serif']] },
  { bg: ['#0f2a5c', '#1d58a8'], lines: [['サンシャインビール', '#ffd24a', '800 132px "Hiragino Sans", "Noto Sans JP", sans-serif'], ['キレのある、夜の一杯。', '#ffffff', '700 88px "Hiragino Sans", "Noto Sans JP", sans-serif']] },
];
function liveryAtlas() {
  const CW = 512, CH = 256, cols = 2, rows = 3;
  const a = atlasCanvas(cols, rows, CW, CH), ctx = a.ctx;
  BUS_ADS.forEach((ad, j) => {
    const i = CARRIERS.length + j, x = (i % cols) * CW, y = Math.floor(i / cols) * CH;
    ctx.save(); ctx.translate(x, y);
    const g = ctx.createLinearGradient(0, 0, CW, 0); g.addColorStop(0, ad.bg[0]); g.addColorStop(1, ad.bg[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
    ctx.scale(0.37, 1);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ad.lines.forEach(([t, col, font], k) => { ctx.fillStyle = col; ctx.font = font; ctx.fillText(t, CW / 0.37 / 2, CH * (k ? 0.74 : 0.36)); });
    ctx.restore();
  });
  CARRIERS.forEach((k, i) => {
    const x = (i % cols) * CW, y = Math.floor(i / cols) * CH;
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = k.bg; ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = k.band; ctx.fillRect(0, CH * 0.70, CW, CH * 0.075);
    ctx.fillStyle = k.band; ctx.globalAlpha = 0.14; ctx.fillRect(0, 0, CW, CH * 0.10); ctx.globalAlpha = 1;
    ctx.fillStyle = k.fg; ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '700 92px "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.fillText(k.name, 34, CH * 0.38);
    ctx.font = '600 26px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(k.sub, 38, CH * 0.58);
    // a phone strip and the 貨物 badge down the tail of the flank
    ctx.font = '600 24px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = k.bg;
    ctx.fillText('0120-' + (410 + i * 37) + '-' + (100 + i * 13), CW - 26, CH * 0.737);
    ctx.fillStyle = k.fg;
    ctx.font = '700 34px "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.fillText('宅配便', CW - 30, CH * 0.90);
    ctx.strokeStyle = k.band; ctx.lineWidth = 6; ctx.strokeRect(3, 3, CW - 6, CH - 6);
    ctx.restore();
  });
  return { tex: atlasTex(a, 8), cols, rows, n: CARRIERS.length, ads: BUS_ADS.map((_, j) => CARRIERS.length + j) };
}

// --------------------------------------------------------------------------------- distant impostors
// ~100-tri stand-ins swapped in past the projected-size cut. Unit space: x = width, y = 0..height, z = length.
function impostorGeo(kind) {
  const parts = [];
  const px = { paint: 1, rough: 0.42, metal: 0.10, col: 0xffffff };
  if (kind === 'car') {
    parts.push(box(1.0, 0.40, 0.98, 0, 0.36, 0, px));
    parts.push(box(0.86, 0.34, 0.60, 0, 0.72, -0.06, px));
    parts.push(box(0.88, 0.20, 0.56, 0, 0.74, -0.06, { paint: 0, rough: 0.12, metal: 0.30, col: 0x121822 }));
    parts.push(box(1.02, 0.16, 0.92, 0, 0.14, 0, MAT.dark));
    parts.push(box(0.76, 0.10, 0.04, 0, 0.44, 0.50, { ...MAT.sign, col: 0xfff2dd, emis: 0.9 }));
    parts.push(box(0.76, 0.10, 0.04, 0, 0.44, -0.50, { ...MAT.sign, col: 0xff2a14, emis: 0.9 }));
  } else {
    parts.push(box(1.0, 0.76, 1.0, 0, 0.50, 0, px));
    parts.push(box(1.01, 0.26, 0.92, 0, 0.72, 0.01, { paint: 0, rough: 0.14, metal: 0.0, col: 0xfff0d2, emis: 0.55 }));
    parts.push(box(1.02, 0.18, 0.98, 0, 0.10, 0, MAT.dark));
    parts.push(box(0.80, 0.10, 0.04, 0, 0.26, 0.50, { ...MAT.sign, col: 0xfff2dd, emis: 0.9 }));
    parts.push(box(0.80, 0.10, 0.04, 0, 0.30, -0.50, { ...MAT.sign, col: 0xff2a14, emis: 0.9 }));
  }
  return mergeGeometries(parts, false);
}

// ---------------------------------------------------------------------------------------------- vehicle types
const SEDAN = {
  hw: 0.885, zF: 2.40, zB: -2.40, belt: 0.86, cabF: 1.05, cabR: -1.85, hoodDrop: 0.14, bootDrop: 0.07,
  crown: 0.022, sillY: 0.30, rPlan: 0.42, shoulder: 0.95, rCab: 0.42, cabW0: 0.94, cabW1: 0.79,
  rakeF: 0.80, rakeR: 0.44, roofY: 1.44, wheelR: 0.33, wheelW: 0.23, axles: [1.45, -1.45],
};
const HATCH = {
  ...SEDAN, hw: 0.845, zF: 2.02, zB: -2.00, belt: 0.84, cabF: 0.78, cabR: -1.70, hoodDrop: 0.12, bootDrop: 0.03,
  rakeF: 0.64, rakeR: 0.16, roofY: 1.50, cabW1: 0.84, axles: [1.22, -1.20], wheelR: 0.31,
};
const KEI = {
  ...SEDAN, hw: 0.735, zF: 1.70, zB: -1.70, belt: 0.80, cabF: 0.70, cabR: -1.50, hoodDrop: 0.09, bootDrop: 0.02,
  rakeF: 0.44, rakeR: 0.08, roofY: 1.74, cabW0: 0.97, cabW1: 0.92, rCab: 0.34, axles: [1.08, -1.08], wheelR: 0.28,
};
const WAGON = {
  ...SEDAN, hw: 0.885, zF: 2.38, zB: -2.36, belt: 0.88, cabF: 1.02, cabR: -2.05, hoodDrop: 0.13, bootDrop: 0.03,
  rakeF: 0.62, rakeR: 0.10, roofY: 1.70, cabW1: 0.86, axles: [1.42, -1.42],
};
// トヨタ JPN TAXI (jpnTaxiBody): 4.40 × 1.695 × 1.75 m, wheelbase 2.75 m with the wheels at the very corners, the sill
// at 0.20 m, the waist at 1.10 m, the windscreen from the cowl (cabF) up 0.64 m and back 0.65 m, the tailgate glass
// raked 0.21 m. The Crown Comfort it replaced has been retired from the fleet (Tokyo no longer runs one).
const JPN_TAXI = {
  paintSpec: MAT.taxipaint,
  hw: 0.8475, zF: 2.20, zB: -2.20, belt: 1.10, sillY: 0.20, roofY: 1.74,
  cabF: 1.16, cabR: -2.06, rakeF: 0.72, rakeR: 0.21, rCab: 0.26, cabW0: 0.975, cabW1: 0.915,
  hoodDrop: 0.16, bootDrop: 0.0, crown: 0.02, rPlan: 0.28, shoulder: 0.985,
  wheelR: 0.31, wheelW: 0.20, axles: [1.40, -1.35],
  pillarB: [-0.02, -0.14], pillarC: [-1.21, -1.36],   // the B-pillar between the doors, the C-pillar ahead of the quarter window
  doorZ: [0.86],                                       // the front door's leading cut, at the foot of the A-post
  andonZ: 0.22, mirrorZ: 1.56, slide: true,            // 行灯 on the roof's front edge; fender mirrors; the rear door slides
  headY: 0.80, headZ: 2.11, tailY: 0.98, tailZ: -2.16, // lamp faces (jpnTaxiLamps)
};
// (the kerb-side door is the middle 中降り door, between the axles; the side ads sit behind it and along the offside)
// (two axles, twin tyres on the rear one, like a 日野ブルーリボン / いすゞエルガ; the 方向幕 face stands proud of the
//  black-masked front, destZ ahead of zF)
const BUS = { hw: 1.235, zF: 5.40, zB: -5.40, doorZ: 1.25, wheelR: 0.50, wheelW: 0.30, axles: [3.70, -3.40], dual: true,
  destZ: 0.046, ads: [{ s: 1, z: -0.95, l: 2.3 }, { s: -1, z: 0.15, l: 3.2 }] };
const TRUCK = { hw: 1.055, zF: 3.50, zB: -3.50, cabL: 2.05, wheelR: 0.45, wheelW: 0.27, axles: [2.40, -2.05], tandem: true, boxBot: 0.96, boxTop: 3.22 };
const VAN = { hw: 0.905, zF: 2.60, zB: -2.62, cabL: 1.66, wheelR: 0.34, wheelW: 0.22, axles: [1.62, -1.48], boxMat: MAT.white, boxBot: 0.59, boxTop: 2.65 };
const SCOOT = { hw: 0.36, zF: 0.92, zB: -0.80, wheelR: 0.25, wheelW: 0.12, axles: [0.62, -0.58], single: true };

// (local +x is the vehicle's left, the kerb side: the left indicators sit at +x)
function carLamps(P, opt = {}) {
  const yH = P.belt - P.hoodDrop - 0.02, yT = P.belt - P.bootDrop - 0.10;
  const hx = P.hw * (opt.hx || 0.94), ix = P.hw * (opt.ix || 0.62);
  return [
    { x: -hx, y: yH, z: P.zF + 0.02, w: opt.hw0 || 0.32, h: 0.15, dir: 1, role: 'head' },
    { x: hx, y: yH, z: P.zF + 0.02, w: opt.hw0 || 0.32, h: 0.15, dir: 1, role: 'head' },
    { x: ix, y: yH - 0.02, z: P.zF + 0.02, w: 0.16, h: 0.10, dir: 1, role: 'indL' },
    { x: -ix, y: yH - 0.02, z: P.zF + 0.02, w: 0.16, h: 0.10, dir: 1, role: 'indR' },
    { x: -hx, y: yT, z: P.zB - 0.02, w: 0.28, h: 0.17, dir: -1, role: 'tail' },
    { x: hx, y: yT, z: P.zB - 0.02, w: 0.28, h: 0.17, dir: -1, role: 'tail' },
    { x: ix, y: yT - 0.03, z: P.zB - 0.02, w: 0.15, h: 0.10, dir: -1, role: 'indL' },
    { x: -ix, y: yT - 0.03, z: P.zB - 0.02, w: 0.15, h: 0.10, dir: -1, role: 'indR' },
  ];
}
// JPN TAXI: swept headlamps either side of the slim upper grille, the turn lenses at their inner ends; at the back the
// tall vertical cluster up each corner of the tailgate, stop/tail over the turn lens over the reversing lamp
function jpnTaxiLamps(P) {
  const hx = P.hw * 0.65, ix = P.hw * 0.44, tx = P.hw - 0.14;
  return [
    { x: -hx, y: P.headY, z: P.headZ, w: 0.22, h: 0.13, dir: 1, role: 'head' },
    { x: hx, y: P.headY, z: P.headZ, w: 0.22, h: 0.13, dir: 1, role: 'head' },
    { x: ix, y: P.headY - 0.01, z: P.headZ, w: 0.12, h: 0.08, dir: 1, role: 'indL' },
    { x: -ix, y: P.headY - 0.01, z: P.headZ, w: 0.12, h: 0.08, dir: 1, role: 'indR' },
    { x: -tx, y: P.tailY + 0.10, z: P.tailZ, w: 0.14, h: 0.22, dir: -1, role: 'tail' },
    { x: tx, y: P.tailY + 0.10, z: P.tailZ, w: 0.14, h: 0.22, dir: -1, role: 'tail' },
    { x: tx, y: P.tailY - 0.08, z: P.tailZ, w: 0.14, h: 0.10, dir: -1, role: 'indL' },
    { x: -tx, y: P.tailY - 0.08, z: P.tailZ, w: 0.14, h: 0.10, dir: -1, role: 'indR' },
    { x: tx, y: P.tailY - 0.18, z: P.tailZ, w: 0.14, h: 0.07, dir: -1, role: 'rev' },
    { x: -tx, y: P.tailY - 0.18, z: P.tailZ, w: 0.14, h: 0.07, dir: -1, role: 'rev' },
  ];
}
// A Japanese box truck or city bus carries a row of amber 車幅灯 along the top of its cab. They sit at
// 2.2–2.9 m, which is the only vehicle light on the street that clears a scramble crowd, so they are what
// makes a queue read as traffic from eye level in the middle of the crossing.
function markerLamps(hw, y, z, n, w = 0.085) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ x: hw * (-0.74 + 1.48 * (i / (n - 1))), y, z, w, h: 0.065, dir: 1, role: 'mark' });
  }
  return out;
}

// the 車幅灯 at the top corners of a box body: amber ahead (on the box's front face, over the cab), red behind. At 3 m they
// are what shows of a box truck over a crowd's heads at night.
function boxCorners(P) {
  const x = P.hw * 0.93, y = P.boxTop - 0.09, zf = P.zF - P.cabL + 0.04;
  return [
    { x: -x, y, z: zf, w: 0.10, h: 0.075, dir: 1, role: 'mark' }, { x, y, z: zf, w: 0.10, h: 0.075, dir: 1, role: 'mark' },
    { x: -x, y, z: P.zB - 0.02, w: 0.10, h: 0.075, dir: -1, role: 'rmark' }, { x, y, z: P.zB - 0.02, w: 0.10, h: 0.075, dir: -1, role: 'rmark' },
  ];
}
function bigLamps(P, yH, yT, zF, zB, rear = true) {   // bus / truck: bigger lenses, set wider apart
  const hx = P.hw * 0.80, ix = P.hw * 0.50;
  const out = [
    { x: -hx, y: yH, z: zF + 0.02, w: 0.34, h: 0.17, dir: 1, role: 'head' },
    { x: hx, y: yH, z: zF + 0.02, w: 0.34, h: 0.17, dir: 1, role: 'head' },
    { x: ix, y: yH, z: zF + 0.02, w: 0.16, h: 0.12, dir: 1, role: 'indL' },
    { x: -ix, y: yH, z: zF + 0.02, w: 0.16, h: 0.12, dir: 1, role: 'indR' },
  ];
  if (rear) out.push(
    { x: -hx, y: yT, z: zB - 0.02, w: 0.30, h: 0.20, dir: -1, role: 'tail' },
    { x: hx, y: yT, z: zB - 0.02, w: 0.30, h: 0.20, dir: -1, role: 'tail' },
    { x: ix, y: yT - 0.02, z: zB - 0.02, w: 0.16, h: 0.12, dir: -1, role: 'indL' },
    { x: -ix, y: yT - 0.02, z: zB - 0.02, w: 0.16, h: 0.12, dir: -1, role: 'indR' },
  );
  return out;
}
// A Tokyo city bus's rear: a tall combination cluster down each corner, stop/tail over the turn lamp over the reversing
// lamp, and the same amber 車幅灯 pair up at the roof line as at the front
function busRearLamps(P) {
  const x = P.hw - 0.155, z = P.zB - 0.06, out = [];
  for (const s of [1, -1]) {
    out.push({ x: s * x, y: 0.99, z, w: 0.19, h: 0.27, dir: -1, role: 'tail' });
    out.push({ x: s * x, y: 0.775, z, w: 0.19, h: 0.13, dir: -1, role: s > 0 ? 'indL' : 'indR' });
    out.push({ x: s * x, y: 0.635, z, w: 0.19, h: 0.10, dir: -1, role: 'rev' });
  }
  return out;
}

// paint palettes: Tokyo streets are mostly white / silver / black, with a few colours
const WHITEISH = [0xe9ebec, 0xf2f3f4, 0xdfe2e4, 0xc8ccd0, 0xa9aeb4];
const DARKISH = [0x24282f, 0x2c313a, 0x383e48, 0x454c57];
const COLOURED = [0x8e1f24, 0x1b3a6b, 0x25503a, 0x6d5a34, 0x5a2a52, 0x2f6a78];
const CAR_COLS = [...WHITEISH, ...WHITEISH, ...DARKISH, ...DARKISH, 0x8a9096, 0x6c757d, ...COLOURED];

const TYPES = {
  sedan:  { fam: 'car', P: SEDAN, build: carBody, lamps: carLamps(SEDAN), cols: CAR_COLS, plate: 'private', wheels: 4 },
  hatch:  { fam: 'car', P: HATCH, build: carBody, lamps: carLamps(HATCH), cols: CAR_COLS, plate: 'private', wheels: 4 },
  kei:    { fam: 'car', P: KEI, build: carBody, lamps: carLamps(KEI, { hx: 0.90, hw0: 0.26 }), cols: [...WHITEISH, 0xd8dde0, 0x9fb7c8, 0xc9a24a, 0x2b3038, 0xb4655a], plate: 'kei', wheels: 4 },
  wagon:  { fam: 'van', P: WAGON, build: carBody, lamps: carLamps(WAGON), cols: [...WHITEISH, ...WHITEISH, ...DARKISH, 0x2f4a3a], plate: 'private', wheels: 4 },
  // Both cab kinds are the JPN TAXI now (the Crown Comfort is gone from Tokyo): `taxi` in the big fleets' near-black
  // company colours, `taxikm` mostly 深藍 with the KM yellow-green now and then
  taxi:   { fam: 'taxi', P: JPN_TAXI, build: jpnTaxiBody, lamps: jpnTaxiLamps(JPN_TAXI), cols: [0x24282f, 0x202429, 0x272c34, 0x2c3139], plate: 'biz', wheels: 4, taxi: true, companies: ['日本交運', '帝都自働車', '渋谷町交通'] },
  taxikm: { fam: 'taxi', P: JPN_TAXI, build: jpnTaxiBody, lamps: jpnTaxiLamps(JPN_TAXI), cols: [0x1a2130, 0x1a2130, 0x1d2431, 0x202429, 0x1a2130, 0x8d9840], plate: 'biz', wheels: 4, taxi: true, companies: ['日本交運', '帝都自働車', '渋谷町交通', '国際自働車 KM'],
            companyOf: (col, rng) => (col === 0x8d9840 ? '国際自働車 KM' : rng.pick(['日本交運', '日本交運', '帝都自働車', '渋谷町交通'])) },
  bus:    { fam: 'bus', P: BUS, build: busBody, cols: [0x2f6b45, 0x2f6b45, 0x2f6b45, 0x35754c, 0x27604a, 0x1d5f8a], plate: 'biz', wheels: 4, dual: true,
            lamps: [...bigLamps(BUS, 0.80, 1.02, BUS.zF, BUS.zB, false), ...busRearLamps(BUS), ...markerLamps(BUS.hw, 2.90, BUS.zF + 0.02, 4, 0.10),
              ...markerLamps(BUS.hw, 2.90, BUS.zB - 0.02, 2, 0.10).map((l) => ({ ...l, dir: -1 }))] },
  truck:  { fam: 'van', P: TRUCK, build: truckBody, cols: [0xe6e8ea, 0xd2d6da, 0x2a5aa0, 0x9aa2aa, 0x224a32], plate: 'biz', wheels: 6,
            lamps: [...bigLamps(TRUCK, 0.76, 0.90, TRUCK.zF, TRUCK.zB), ...markerLamps(TRUCK.hw, 2.19, TRUCK.zF - 0.30, 5), ...boxCorners(TRUCK)] },
  van:    { fam: 'van', P: VAN, build: truckBody, cols: [0xe9ebec, 0xe9ebec, 0xd0d4d8, 0x2a5aa0, 0xc8501e], plate: 'biz', wheels: 4,
            lamps: [...bigLamps(VAN, 0.72, 0.86, VAN.zF, VAN.zB), ...markerLamps(VAN.hw, 2.19, VAN.zF - 0.26, 4), ...boxCorners(VAN)] },
  scooter:{ fam: 'car', P: SCOOT, build: scooterBody, cols: [0xe6e8ea, 0x1c2026, 0x2a5aa0, 0xc8501e], plate: 'kei', wheels: 2,
            lamps: [{ x: 0, y: 0.96, z: 0.88, w: 0.16, h: 0.12, dir: 1, role: 'head' }, { x: 0, y: 0.92, z: -0.76, w: 0.14, h: 0.10, dir: -1, role: 'tail' }] },
};
// 行灯 faces, painted in roofAtlas(). Keep in step with the `companies` lists above.
const ROOF_COMPANIES = [
  { name: '日本交運', bg: '#f5d000', fg: '#141414' },
  { name: '国際自働車 KM', bg: '#fbfcfd', fg: '#1c56b7' },
  { name: '帝都自働車', bg: '#f7f7f7', fg: '#c8102e' },
  { name: '渋谷町交通', bg: '#7ed957', fg: '#141414' },
];

// Every type (and its body parameters) is rebuilt with one key set in one order, so the per-vehicle code sees a single
// shape of T and of P: six P shapes made every P.* read in the draw loop megamorphic, and each of those boxed a double.
{
  const PK = [...new Set(Object.values(TYPES).flatMap((T) => Object.keys(T.P)))];
  const TK = [...new Set(Object.values(TYPES).flatMap((T) => Object.keys(T)))];
  for (const k in TYPES) {
    const T0 = TYPES[k], P = {}, T = {};
    for (const q of PK) P[q] = T0.P[q];
    for (const q of TK) T[q] = q === 'P' ? P : T0[q];
    TYPES[k] = T;
  }
}
for (const k in TYPES) {
  const T = TYPES[k];
  T.len = T.P.zF - T.P.zB;
  T.wid = T.P.hw * 2;
  T.lamps = T.lamps || [];
  T.hgt = T.fam === 'bus' ? 3.24 : T.P.roofY !== undefined ? T.P.roofY + 0.06 : T.P.boxTop ? T.P.boxTop + 0.06 : T.wheels === 2 ? 1.7 : 2.7;
  // where a cab's 行灯 stands on its roof (the JPN TAXI carries it on the roof's front edge)
  T.andonZ = T.P.andonZ !== undefined ? T.P.andonZ : T.P.cabR + (T.P.cabF - T.P.cabR) * 0.62;
  T.imp = T.fam === 'bus' || (T.wheels === 6 && T.fam === 'van') || k === 'van' ? 'box' : 'car';
  // buses and the box-bodied trucks and vans run pressed-steel disc wheels, not alloys
  T.heavy = T.fam === 'bus' || T.build === truckBody;
  // the cabs run steel wheels under plain covers (wheelsCover), not alloys
  T.cover = !!T.taxi;
  // Bicycle-model pose: a reference point xr ahead of the rear axle rides the path and the rear axle trails it
  // with no side slip. xr = (wheelbase + front overhang)/√2 balances the swept body about the path: the nose
  // swings out and the tail cuts in by about sweep·κ each (a bus on R 11 m: ±1.8 m, a sedan ±0.34 m).
  const rearA = T.P.axles[T.P.axles.length - 1], wb = T.P.axles[0] - rearA, oF = T.P.zF - T.P.axles[0];
  T.xc = -rearA;
  T.xr = Math.max(T.xc, (wb + oF) / Math.SQRT2);
  T.wb = wb;
  T.sweep = (wb + oF) * (wb + oF) / 4;
}
// the swept-path half-excess of a vehicle class of length L on curvature κ is sweepL(L)·κ
const sweepL = (L) => L * L * 0.16;
// IDM driver per family: max acceleration, comfortable deceleration (m/s²)
const DRIVE = { car: [2.1, 2.6], taxi: [2.3, 2.7], van: [1.6, 2.3], bus: [1.2, 1.9] };

// legacy shape used by crowd.js / older callers
const KINDS = {
  car: { w: 1.77, l: 4.8 }, taxi: { w: 1.72, l: 4.62 }, van: { w: 2.11, l: 7.0 }, bus: { w: 2.47, l: 10.8 },
};

// ---------------------------------------------------------------------------------------------- queues / kerbs
// How deep each scramble approach queues per lane behind its painted stop line during the all-red scramble, and
// whether it is a bus corridor (those put their tall silhouettes at the head of the queue, where they clear a crowd).
// `heads` sets the first ranks per lane (k = 0 inner … kerb): at most one bus per arm. From the eye in the scramble
// (crossing_night) the heads stand 50–65 m off, behind a crowd whose heads cover everything under ~2.4 m, so on the two
// arms in frame both lanes are led by a tall body (bus / 4 t box truck), whose roofs and 車幅灯 stand over the heads.
// The lit cabs queue behind them where nothing tall stands in front of them on screen (公園通り's inner lane recedes
// to the left, clear of the bus), so their 行灯 read between and over the heads.
const APPROACH = {
  // (crossing_night looks up 公園通り and 宮益坂: a JPN Taxi heads the lane nearest the eye on each, its 行灯 the
  //  highest light of a car, with the 4 t box truck right behind it and the bus beside)
  koen:            { depth: 5, heads: [['taxikm', 'truck', 'taxikm', 'van'], ['bus', 'taxi', 'taxikm', 'truck']] },   // 公園通り, north arm
  miyamasu:        { depth: 5, heads: [['bus', 'taxikm', 'taxi'], ['taxikm', 'truck', 'taxi']] },    // 宮益坂, east arm
  // 駅前通り, the throat by the bus terminal, beside the ハチ公前 zebra: one cab, not a line of them (there is no rank at
  // ハチ公口, and from the square a red queue of cabs reads as one)
  ekimae_s:        { depth: 2, heads: [['sedan', 'taxikm'], ['bus', 'wagon']] },
  dogenzaka_shita: { depth: 4, heads: [['taxi', 'taxikm'], ['van', 'taxi']] },   // 道玄坂下, west arm
};

// A 渋谷 arm at a red light is roughly a third taxis by day, closer to half at night. Weights sum to 1.
const QUEUE_MIX = [
  ['taxi', 0.155], ['taxikm', 0.085], ['sedan', 0.155], ['hatch', 0.135], ['kei', 0.115],
  ['wagon', 0.085], ['van', 0.105], ['truck', 0.065], ['bus', 0.045], ['scooter', 0.055],
];
const QUEUE_MIX_NIGHT = [
  ['taxi', 0.16], ['taxikm', 0.25], ['sedan', 0.13], ['hatch', 0.10], ['kei', 0.07],
  ['wagon', 0.06], ['van', 0.08], ['truck', 0.05], ['scooter', 0.10],
];
// what drives onto a wide road that feeds the scramble at night: the black JPN Taxi is the silhouette of 渋谷 at 21:30
// (a tenth are 原付 and delivery scooters: 出前 riders filter up every red queue in the evening)
const ROAD_MIX_NIGHT = [
  ['bus', 0.04], ['truck', 0.03], ['van', 0.06], ['taxikm', 0.24], ['taxi', 0.16], ['scooter', 0.10],
  ['kei', 0.08], ['hatch', 0.10], ['wagon', 0.07], ['sedan', 0.12],
];

function pickWeighted(table, rng) {
  let r = rng();
  for (let i = 0; i < table.length; i++) { r -= table[i][1]; if (r <= 0) return table[i][0]; }
  return table[table.length - 1][0];
}

// Stationary kerbside vehicles, laid nose-to-tail from `from` metres along the road (side 1 = the kerb on the left
// of the road's drawing direction, facing along it; -1 = the far kerb, facing back). A slot is only used if the whole
// body is on the carriageway, off every zebra and clear of every lane and turn path (parkedSlots checks), so a road
// too narrow for a kerb lane simply gets none.
const PARKED = [
  // 東口 タクシー乗り場 — the one rank at 渋谷駅 today, on 明治通り's west kerb by the east bus terminal (cityData
  // spawns.taxiStand; there is none at ハチ公口 and the 西口 surface rank closed in 2025). It flows: see stepRanks.
  { road: 'meiji_ne', at: 'taxiStand', side: -1, rank: true, flow: true, kinds: ['taxi', 'taxikm', 'taxi', 'taxi', 'taxikm'] },
  // 道玄坂下: delivery vans on the unloading kerb, hazards on
  // (doors: the first van or truck of the line is unloading, both rear doors swung open)
  { road: 'dogenzaka_shita', from: 42, to: 100, side: 1, gap: 3.4, hazard: true, kinds: ['truck', 'van', 'kei'] },
  { road: 'dogenzaka_shita', from: 64, to: 100, side: -1, gap: 3.0, hazard: true, doors: true, kinds: ['van', 'truck'] },
  { road: 'bunkamura', from: 22, side: 1, gap: 3.0, hazard: true, doors: true, kinds: ['van'] },
  // 道玄坂: 空車 cabs waiting on the uphill kerb for a fare, 行灯 lit and hazards on; the line moves up as the front
  // cab takes a fare and pulls away, and passing empty cabs join the back
  { road: 'dogenzaka', from: 28, to: 132, side: 1, gap: 1.0, rank: true, hazard: true, flow: true,
    kinds: ['taxi', 'taxikm', 'taxi', 'taxi', 'taxikm', 'taxi', 'taxi', 'taxi', 'taxikm', 'taxi', 'taxi', 'taxikm'] },
  { road: 'dogenzaka', from: 118, to: 150, side: 1, gap: 3.0, hazard: true, kinds: ['van'] },
  // 明治通り / 玉川通り: the aerial needs kerb content too
  { road: 'meiji_ne', from: 96, side: 1, gap: 4.0, hazard: true, kinds: ['truck', 'van'] },
  { road: 'meiji_ne', from: 210, side: -1, gap: 3.0, hazard: true, kinds: ['van'] },
  { road: 'tamagawa', from: 150, side: 1, gap: 3.0, hazard: true, kinds: ['truck', 'van'] },
];
// Where cabs drop a fare: the ハチ公 kerb of 駅前通り 南行, beside the square (there is no rank here: one cab at a time
// stops, briefly, and the lane runs on past it). A cab with a fare aboard pulls over (left indicator), stands on its
// hazards with the kerb-side rear door open for ~4 s, then its 行灯 lights (空車) and it pulls out on the right
// indicator. The spot is near the end of the lane so the cab has the lane's length to steer over to the kerb.
const DROPS = [{ road: 'ekimae_s', pos: [-7.2, 36.5] }];
// arms the client looks at (2026-09-24: 道玄坂, センター街 / 文化村通り, 宮下パーク) get their share of the moving traffic
const FOCUS_ROADS = {
  dogenzaka: 1.3, dogenzaka_ue: 1.1, dogenzaka_shita: 1, bunkamura: 1, koen: 0.9, miyamasu: 0.9, meiji_ne: 0.8, inokashira: 0.8,
  miyashita_st: 0.8, ekimae_s: 0.7, centergai_w_st: 0.7,
};
// Vehicles a minute entering the map on each source road (split over its source lanes). An arm of the scramble passes
// about 11 a minute (26 s of green in 120 s over two lanes); the roads that feed one are held to ~70 % of that so a
// red queue always clears on the next green. The roads that never reach the scramble carry the rest.
const SCRAMBLE_FEED = new Set(['dogenzaka', 'bunkamura', 'koen', 'jingu_n', 'miyamasu', 'tamagawa_ue']);
const FILTER_ARMS = new Set(['koen', 'miyamasu', 'dogenzaka_shita']);
const SRC_RATE = {
  dogenzaka: 3.9, bunkamura: 1.4, koen: 3.6, jingu_n: 4.3, miyamasu: 4.4, ekimae_s: 1.9, ekimae_sb: 1.9, ekimae_nb: 1.9,
  nishiguchi: 1.9, wave: 1.4, meiji_ne: 10.4, tamagawa: 38,
  tamagawa_ue: 7,                                      // [city] pass 15: both ends of 道玄坂上's 246 stub (道玄坂's feed now)
};
const CW_ALL = [...(CITY.crossing.crosswalks || []), ...(CITY.crossing.diagonals || []), ...(CITY.crosswalksExtra || [])];

// ---------------------------------------------------------------------------------------------- road network
// The roads in cityData become a graph. Every road is split at the junctions found on it; each piece carries lanes
// per direction (edges) that stop short of the junction box, and every junction carries connectors: smooth turn
// paths from an incoming lane's stop point to an outgoing lane's start. A car drives edge to edge and picks a
// connector at each junction. Wherever two paths come within a vehicle width of each other (turns crossing,
// merging, splitting) a conflict zone is precomputed that only one side may hold at a time, so no two vehicles
// can ever occupy the same patch of road, signalled or not.

// lanes per direction, lane width and speed per road (cityData only gives a total lane count)
const ROAD_CFG = {
  // 道玄坂 uphill (drawing direction) keeps one running lane: its kerb lane is where the cabs wait
  dogenzaka_shita: { n: 2, w: 3.25, v: 12.5 }, dogenzaka: { n: 2, w: 3.1, v: 12, dirN: { 1: 1 } }, bunkamura: { n: 1, w: 3.4, v: 11 },
  ekimae_s: { n: 2, w: 3.3, v: 11.5 }, koen: { n: 2, w: 3.0, v: 11.5 }, jingu_n: { n: 2, w: 3.2, v: 12 },
  miyamasu: { n: 2, w: 3.2, v: 12.5 }, meiji_ne: { n: 2, w: 3.3, v: 14 }, inokashira: { n: 2, w: 3.1, v: 10 },
  tamagawa: { n: 3, w: 3.3, v: 15 }, nishiguchi: { n: 1, w: 3.3, v: 9 }, wave: { n: 1, w: 3.2, v: 8 },
  centergai_w_st: { n: 1, w: 3.0, v: 7 }, miyashita_st: { n: 1, w: 3.2, v: 9 },
  // [city] pass 15, the 道玄坂 corridor: 交番前 → 道玄坂上 is 4 lanes; 玉川通り's side road at 道玄坂上 one each way
  dogenzaka_ue: { n: 2, w: 2.8, v: 11.5 }, tamagawa_ue: { n: 1, w: 3.5, v: 12 },
};
function roadCfg(rd) {
  if (rd.busOnly) return { n: rd.lanes || 1, w: 3.3, v: 8, narrow: false, two: false, dirN: null, busOnly: true };
  const c = ROAD_CFG[rd.id] || {};
  const two = !rd.oneway;
  const n = c.n || Math.max(1, two ? Math.floor((rd.lanes || 2) / 2) : (rd.lanes || 1));
  const w = c.w || clamp((rd.width / (two ? 2 : 1) - 0.8) / n, 2.8, 3.3);
  // (narrow = a one-lane alley: no buses or trucks. A 7 m one-way pair of lanes, like 駅前通り 北行, takes them.)
  return { n, w, v: c.v || 11, narrow: rd.width < 7, two, dirN: c.dirN || null };
}
// + = left of travel. k = 0 is the inner lane (beside the centre line), n-1 the kerb lane.
function laneOffset(cfg, k) { return cfg.two ? 0.15 + (k + 0.5) * cfg.w : (k - (cfg.n - 1) / 2) * cfg.w; }

// Signalled junctions. Arms are keyed road+ (the piece leaving the node toward the road's far end) and road- .
const JUNCTIONS = [
  { at: CROSS, id: 'scramble', sig: 'scramble', trim: 12,
    groups: { 'dogenzaka_shita+': 'ew', 'miyamasu+': 'ew', 'koen+': 'ns', 'ekimae_s+': 'ns' } },
  // the outer junctions run a 60 s cycle locked to the scramble's 120 s, offset so each one is green for the
  // platoon the scramble releases toward it (see sigState: green 'a' starts at cycle time −off mod 60)
  // 109 (道玄坂下 / 文化村通り入口) is 44 m from the scramble's west stop line, and 道玄坂 and 文化村通り both feed that
  // same 44 m, which only empties while the scramble's 東西 green discharges it. 'a' is the main road westbound (its
  // inner lane forks right into 文化村通り, across 道玄坂's downhill stream) with 文化村通り inbound; 'b' is 道玄坂
  // downhill. The junction is locked to that 東西 green (sync windows, cycle seconds from the phase's start): 'b'
  // from 6 s before it to 8 s into it, so 道玄坂 moves down into the room the scramble queue leaves, then 'a' from 13 s
  // into it to 9 s after its amber, for the platoon the scramble sends west (a red 109 then backs it up into the box's
  // exits, and the 宮益坂 queue behind them misses its green). Between the windows it is vehicle-actuated.
  { at: [-112, -7], id: '109', sig: { a: 36, b: 22, off: 30, sync: [{ g: 'b', phase: 'ew', from: -6, to: 8 }, { g: 'a', phase: 'ew', from: 13, to: 42 }] }, groups: { 'dogenzaka_shita-': 'a', 'bunkamura+': 'a', 'dogenzaka+': 'b' } },
  { at: [23, -165], id: 'jingu', sig: { a: 32, b: 22, off: 18 }, rights: true, groups: { 'koen-': 'a', 'jingu_n+': 'a', 'koen+': 'b' } },
  { at: [155, -7], id: 'miyamasushita', sig: { a: 30, b: 26, off: 8 }, groups: { 'miyamasu-': 'a', 'miyamasu+': 'a', 'meiji_ne-': 'b', 'meiji_ne+': 'b' } },
  // 国道246 (玉川通り) at 渋谷駅南口, where 駅前通り 南行 joins: its traffic turns right across three lanes of 246 as well
  // as left, and cannot find a gap, so it is signalled like the real one. (At 並木橋 明治通り only turns left into
  // the kerb lanes, and gives way.)
  // 東口 bus terminal (cityData busways.higashiguchi_bus): unsignalled T's where the loop leaves and rejoins 明治通り.
  // The arms a bus turns between are trimmed back far enough for an R ≈ 7–9 m turn; the rest keep a small trim, so the
  // 32 m to 宮益坂下 still holds a (5 m) lane and the taxi island's rank between the two T's keeps its slots.
  // `lookThrough`: traffic crossing the exit T reads 宮益坂下's light from before the mouth ((b') in drive): nobody
  // can stop for it in a 5 m lane.
  { at: [166.8, 74], id: 'higashi_in', trim: 3, trimArm: { 'meiji_ne+': 10, 'higashiguchi_bus+': 13.4 } },
  { at: [159.6, 27], id: 'higashi_out', trim: 3, trimArm: { 'meiji_ne-': 12.8, 'higashiguchi_bus-': 17 }, lookThrough: true },
  { at: [22, 195], id: 'minamiguchi', sig: { a: 36, b: 22, minA: 18, off: 12 }, rights: ['ekimae_sb-'], trimArm: { 'tamagawa-': 23 }, groups: { 'tamagawa-': 'a', 'tamagawa+': 'a', 'ekimae_sb-': 'b', 'ekimae_nb+': 'b' } },
  // [city] pass 15, the 道玄坂 corridor. 道玄坂上交番前: 道玄坂 through ('a'); its side roads carry no traffic in the game,
  // so 'b' is their phase with nobody in it — `fixed` cycles a / b on time (not on demand) and the zebras across 道玄坂
  // walk in 'b' (the crowd and the corridor's heads read the group running parallel to each zebra).
  { at: [-396.3, 219.5], id: 'kobanmae', sig: { a: 42, b: 20, off: 6, fixed: true }, groups: { 'dogenzaka-': 'a', 'dogenzaka_ue+': 'a', 'dg_rambling+': 'b', 'dg_1chome+': 'b', 'dg_east_svc+': 'b' } },
  // 道玄坂上: 玉川通り's side road ('a') and 道玄坂 coming up to it ('b'), vehicle-actuated
  { at: [-490.7, 402.2], id: 'dogenzakaue', sig: { a: 34, b: 24, off: 20 }, rights: true, trimArm: { 'dogenzaka_ue-': 8 }, groups: { 'tamagawa_ue-': 'a', 'tamagawa_ue+': 'a', 'dogenzaka_ue-': 'b' } },
];
// Route choice at particular junctions (multiplies the movement's weight): 明治通り southbound mostly turns off at
// 宮益坂下 rather than carrying on to give way into 246 at 並木橋.
const TURN_W = [
  { at: [155, -7], road: 'meiji_ne', type: 'through', w: 0.3 },
  // …and more of 246 turns up 駅前通り 北行 toward the station, more of 宮益坂 turns down the station side:
  // the south arm is in the showpiece's frame and was nearly empty
  { at: [22, 195], road: 'tamagawa', type: 'left', w: 3.2 },
  { at: [-4, -2], road: 'miyamasu', type: 'left', w: 2.2 },
  // [city] pass 15: most of 玉川通り's side road at 道玄坂上 turns down 道玄坂 (the corridor's own traffic)
  { at: [-490.7, 402.2], road: 'tamagawa_ue', type: 'left', w: 4 },
  { at: [-490.7, 402.2], road: 'tamagawa_ue', type: 'right', w: 4 },
];
const A_LAT = 2.2;        // comfortable lateral acceleration in a turn (m/s²): R 11 m → 4.9 m/s
const B_CURVE = 1.8;      // deceleration used to come down to a turn's speed
const B_STOP = 3.1;       // comfortable braking toward a stop point
const R_TURN = 12;        // target radius of a 90° junction turn
// busways that are a bus terminal's own carriageway (cityData busways[].terminal: the 東口 loop)
const TERMINAL_BUSWAYS = new Set((CITY.busways || []).filter((b) => b.terminal).map((b) => b.id));
const Z_MARGIN = 0.3;     // clearance two bodies on crossing paths must keep
const Z_MARGIN_PAR = 0.12; // …and two bodies running alongside each other
const ZPAD = 0.6;
const GATE_TAIL = 16;     // metres of the exit lane that belong to a junction gate
const EDGE_FAR = 130;     // at the map boundary a vehicle may come and go in view, as long as it is this far away
const STUB_MAX = 40;      // a piece cut short by pavement this close to its junction is a stub, not a road

const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const hdgOf = (dx, dz) => Math.atan2(dx, dz);            // yaw convention: forward = (sin h, cos h)
const fwdOf = (h) => [Math.sin(h), Math.cos(h)];
const leftOf = (h) => [Math.cos(h), -Math.sin(h)];      // unit vector to the left of heading h
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function cumOf(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist2(pts[i], pts[i - 1]));
  return cum;
}
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = dist2(a, b);
    const n = Math.max(1, Math.ceil(l / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
// road bends become circular arcs (the cityData polylines have hard vertices)
function smoothRoad(raw, R = 55) {
  const out = [raw[0]];
  for (let i = 1; i < raw.length - 1; i++) {
    const a = raw[i - 1], v = raw[i], b = raw[i + 1];
    const la = dist2(a, v), lb = dist2(v, b);
    const h0 = hdgOf(v[0] - a[0], v[1] - a[1]), h1 = hdgOf(b[0] - v[0], b[1] - v[1]);
    const th = wrapA(h1 - h0);
    if (Math.abs(th) < 0.01 || Math.abs(th) > 2.6) { out.push(v); continue; }
    const Lt = Math.min(R * Math.tan(Math.abs(th) / 2), 0.45 * Math.min(la, lb));
    const r = Lt / Math.tan(Math.abs(th) / 2), sg = th > 0 ? 1 : -1;
    const f0 = fwdOf(h0), S = [v[0] - f0[0] * Lt, v[1] - f0[1] * Lt];
    const l0 = leftOf(h0), C = [S[0] + l0[0] * r * sg, S[1] + l0[1] * r * sg];
    const n = Math.max(2, Math.ceil(r * Math.abs(th) / 1.0));
    for (let k = 0; k <= n; k++) {
      const h = h0 + th * k / n, l = leftOf(h);
      out.push([C[0] - l[0] * r * sg, C[1] - l[1] * r * sg]);
    }
  }
  out.push(raw[raw.length - 1]);
  return out;
}

// straight → clothoid → arc → clothoid → straight, fitted into the corner between two lane lines. The steering
// ramps in and out instead of snapping to full lock, and the lanes meet it tangentially, so heading never jumps.
function turnPath(p0, h0, p1, h1, Rt) {
  const th = wrapA(h1 - h0), A = Math.abs(th), sg = th > 0 ? 1 : -1;
  if (A < 0.3 || A > 2.5) return null;
  const f0 = fwdOf(h0), f1 = fwdOf(h1);
  const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
  const det = f0[0] * f1[1] - f0[1] * f1[0];
  if (Math.abs(det) < 1e-6) return null;
  const a = (dx * f1[1] - dz * f1[0]) / det, b = (f0[0] * dz - f0[1] * dx) / det;   // p0 + a·f0 = p1 − b·f1
  if (a < 1 || b < 1) return null;
  const X = [p0[0] + f0[0] * a, p0[1] + f0[1] * a];
  // unit fillet (R = 1): clothoid ramps of length c each side
  const c = Math.min(0.55, 0.5 * A), L = 2 * c + (A - c);
  const loc = [];
  let x = 0, y = 0, psi = 0;
  const ds = 0.004;
  for (let s = 0; s <= L + 1e-9; s += ds) {
    if (loc.length === 0 || s - loc[loc.length - 1][2] >= 0.04) loc.push([x, y, s]);
    const k = s < c ? s / c : s > L - c ? Math.max(0, (L - s) / c) : 1;
    psi += k * ds;
    x += Math.cos(psi) * ds; y += Math.sin(psi) * ds;
  }
  loc.push([x, y, L]);
  const Lt1 = x - y / Math.tan(A);
  const R = Math.min(Rt, (a - 0.2) / Lt1, (b - 0.2) / Lt1);
  if (R < 3.2) return null;
  const Lt = Lt1 * R;
  const S = [X[0] - f0[0] * Lt, X[1] - f0[1] * Lt], l0 = leftOf(h0);
  const pts = [p0];
  const dA = a - Lt;
  for (let d = 0.8; d < dA - 0.3; d += 0.8) pts.push([p0[0] + f0[0] * d, p0[1] + f0[1] * d]);
  for (const q of loc) pts.push([S[0] + (f0[0] * q[0] + l0[0] * q[1] * sg) * R, S[1] + (f0[1] * q[0] + l0[1] * q[1] * sg) * R]);
  const E = pts[pts.length - 1], dB = dist2(E, p1);
  for (let d = 0.8; d < dB - 0.3; d += 0.8) pts.push([E[0] + f1[0] * d, E[1] + f1[1] * d]);
  pts.push(p1);
  return { pts, R };
}
function hermitePath(p0, h0, p1, h1, k = 1 / 3) {
  const D = dist2(p0, p1), f0 = fwdOf(h0), f1 = fwdOf(h1);
  const c0 = [p0[0] + f0[0] * D * k, p0[1] + f0[1] * D * k], c1 = [p1[0] - f1[0] * D * k, p1[1] - f1[1] * D * k];
  const n = Math.max(4, Math.ceil(D / 0.5)), pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * p1[1],
    ]);
  }
  return pts;
}

// an edge: a polyline with per-sample arc length, heading, curvature and the turn speed it allows
function mkEdge(pts, meta) {
  const P = [pts[0]];
  for (let i = 1; i < pts.length; i++) if (dist2(pts[i], P[P.length - 1]) > 0.05) P.push(pts[i]);
  const n = P.length, cum = cumOf(P), hdg = new Float32Array(n), kap = new Float32Array(n), vk = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    hdg[i] = hdgOf(b[0] - a[0], b[1] - a[1]);
  }
  if (meta.h0 !== undefined) hdg[0] = meta.h0;
  if (meta.h1 !== undefined) hdg[n - 1] = meta.h1;
  const raw = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) raw[i] = wrapA(hdg[i + 1] - hdg[i - 1]) / Math.max(0.05, cum[i + 1] - cum[i - 1]);
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { s += raw[j]; w++; }
    kap[i] = s / w;
    vk[i] = Math.min(30, Math.sqrt(A_LAT / Math.max(1e-3, Math.abs(kap[i]))));
  }
  return { pts: P, cum, len: cum[n - 1], hdg, kap, vk, next: [], prev: [], cars: [], zones: [], sig: null, _h: 1, ...meta };
}

// position / heading / curvature at arc length s (clamped), written into out
function sampleEdge(e, s, out) {
  const { pts, cum } = e;
  const t = s <= 0 ? 0 : s >= e.len ? e.len : s;
  let lo = e._h;
  if (lo < 1 || lo >= pts.length || cum[lo - 1] > t || cum[lo] < t) {
    let a = 1, b = pts.length - 1; lo = b;
    while (a <= b) { const m = (a + b) >> 1; if (cum[m] < t) a = m + 1; else { lo = m; b = m - 1; } }
  }
  e._h = lo;
  const i = lo - 1, f = (t - cum[i]) / Math.max(1e-6, cum[lo] - cum[i]);
  out[0] = pts[i][0] + (pts[lo][0] - pts[i][0]) * f;
  out[1] = pts[i][1] + (pts[lo][1] - pts[i][1]) * f;
  out[2] = e.hdg[i] + wrapA(e.hdg[lo] - e.hdg[i]) * f;
  out[3] = e.kap[i] + (e.kap[lo] - e.kap[i]) * f;
  if (s > e.len) { out[0] += Math.sin(out[2]) * (s - e.len); out[1] += Math.cos(out[2]) * (s - e.len); }
  else if (s < 0) { out[0] += Math.sin(out[2]) * s; out[1] += Math.cos(out[2]) * s; }
  return out;
}

function nearestOn(pts, cum, x, z) {
  let best = 1e9, bs = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9;
    const u = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / l2, 0, 1);
    const d = Math.hypot(a[0] + dx * u - x, a[1] + dz * u - z);
    if (d < best) { best = d; bs = cum[i - 1] + u * (cum[i] - cum[i - 1]); }
  }
  return { d: best, s: bs };
}
function pointAt(R, s) {
  const o = [0, 0, 0, 0];
  return sampleEdge(R, s, o);
}
function segX(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], q = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-9) return -1;
  const w = [c[0] - a[0], c[1] - a[1]];
  const t = (w[0] * q[1] - w[1] * q[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}
function inRectSeg(x, z, a, b, halfW, pad) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  const ux = dx / l, uz = dz / l;
  const px = x - a[0], pz = z - a[1];
  const al = px * ux + pz * uz, lat = Math.abs(px * uz - pz * ux);
  return al > -pad && al < l + pad && lat < halfW + pad;
}

// a zone's waiting episode ends when its side gets in
function Z0(Z, side) { Z.wT[side] = -1; Z.w0[side] = 0; }
// Holders of each side of a zone. The zone is drawn for the worst pair (a bus swinging through a turn); whether it
// actually separates two given vehicles is decided from their real widths and lengths against the closest approach
// of the two paths, so two cars can pass where two buses could not.
function zTake(Z, side, c) { Z.hs[side].push(c); Z.hold[side]++; }
function zDrop(Z, side, c) {
  const i = Z.hs[side].indexOf(c);
  if (i >= 0) { Z.hs[side].splice(i, 1); Z.hold[side]--; }
}
function zPair(Z, side, a, b) {
  const ka = Z.k[side], kb = Z.k[1 - side];
  const need = (a.w + b.w) / 2 + Math.max(a.T.sweep * ka, b.T.sweep * kb) + (Z.par ? Z_MARGIN_PAR : Z_MARGIN);
  return Z.dmin < need;
}
// A holder that is standing still in a lane (held at its stop line, in a queue) does not block a path that actually
// passes clear of where its body stands: the zone was drawn for the worst pair, the stationary car is one known box.
// It is then told to stay put until the other side has cleared the zone.
function zBlocks(Z, side, c) {
  const hs = Z.hs[1 - side];
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    if (h === c || !zPair(Z, side, c, h)) continue;
    if (h.speed < 0.3 && h.aDes < 0.3 && h.e && h.e.kind === 'lane' && standClear(Z, side, c, h)) { h.byp = { Z, side: 1 - side }; continue; }
    return true;
  }
  return false;
}
const _t4c = [0, 0, 0, 0];
function standClear(Z, side, c, h) {
  const e = Z.e[side], o = _t4c;
  const cs = Math.cos(h.yaw), sn = Math.sin(h.yaw), hl = h.l * 0.5 + 0.15, hw = h.w * 0.5 + 0.1;
  const b = Math.min(e.len, Z.hi[side] + c.l * 0.5);
  for (let s = Math.max(0, Z.lo[side] - c.l * 0.5); s <= b; s += 0.5) {
    sampleEdge(e, s, o);
    const dx = o[0] - h.x, dz = o[1] - h.z;
    const ox = Math.max(0, Math.abs(dx * cs - dz * sn) - hw), oz = Math.max(0, Math.abs(dx * sn + dz * cs) - hl);
    if (Math.hypot(ox, oz) < c.w * 0.5 + 0.17 + c.T.sweep * Math.abs(o[3]) + Z_MARGIN) return false;
  }
  return true;
}

// Drive a vehicle of type T through lane ei → pts → lane eo with the bicycle pose the runtime uses (reference point
// on the path, rear axle trailing) and report whether any corner or side of its body crosses onto the pavement.
function sweepFits(ei, pts, eo, T, field) {
  if (!field) return true;
  const path = [];
  const ip = ei.pts, ic = ei.cum;
  for (let i = 0; i < ip.length; i++) if (ic[ic.length - 1] - ic[i] < T.xr + 3) path.push(ip[i]);
  for (let i = 1; i < pts.length; i++) path.push(pts[i]);
  const op = eo.pts, oc = eo.cum;
  for (let i = 1; i < op.length && oc[i] < T.len + 4; i++) path.push(op[i]);
  return sweepPath(path, T, field, 0.02);
}
// the same test along one path, with `pad` metres of body width to spare either side
function sweepPath(path, T, field, pad) {
  if (!field) return true;
  const R = mkEdge(path, {});
  const o = [0, 0, 0, 0], hw = T.P.hw + pad, zF = T.P.zF, zB = T.P.zB;
  sampleEdge(R, 0, o);
  let rx = o[0] - Math.sin(o[2]) * T.xr, rz = o[1] - Math.cos(o[2]) * T.xr;
  for (let s = 0.25; s <= R.len; s += 0.25) {
    sampleEdge(R, s, o);
    let hx = o[0] - rx, hz = o[1] - rz;
    const d = Math.hypot(hx, hz) || 1e-6;
    hx /= d; hz /= d;
    rx = o[0] - hx * T.xr; rz = o[1] - hz * T.xr;
    if (s < T.xr + 1) continue;
    const cx = rx + hx * T.xc, cz = rz + hz * T.xc;
    for (const u of [zF, 0, T.P.axles[T.P.axles.length - 1], zB]) {
      for (const v of [-hw, hw]) {
        const x = cx + hx * u + hz * v, z = cz + hz * u - hx * v;
        if (field.sample(x, z) > 0) return false;
      }
    }
  }
  return true;
}

// samples of a path whose bus-width body would touch the pavement
function paveHits(pts, field, hw = 1.3) {
  if (!field) return 0;
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const h = hdgOf(b[0] - a[0], b[1] - a[1]), l = leftOf(h), p = pts[i];
    for (const sd of [0, hw, -hw]) if (field.sample(p[0] + l[0] * sd, p[1] + l[1] * sd) > -0.05) n++;
  }
  return n;
}

// A busway is only built into the network when a bus can drive it end to end; otherwise its junctions would only
// chop the road it leaves and rejoins into short pieces that nobody but a bus may use. Each busway is judged on its
// own (the 東口 terminal's loop does not go down with the 西口 lane): the failing ones are dropped and the network is
// built again without them.
function buildNetwork(field) {
  const all = (CITY.busways || []).map((b) => b.id);
  let keep = all, net = null;
  const why = [];
  for (let pass = 0; pass <= all.length; pass++) {
    net = buildNetworkWith(field, keep);
    const bad = net.lanes.filter((e) => e.busOnly && (e.okL < 10.8 || e.trap));
    if (!bad.length) break;
    for (const e of bad) why.push(`${e.road} okL ${e.okL} fitL ${e.fitL} trap ${!!e.trap} end ${e.pts[e.pts.length - 1].map((v) => v.toFixed(1))} next ${e.next.map((c) => `${c.type}:${c.fitL}/${c.maxL}→${c.to.road}:${c.to.okL}@${c.to.pts[0].map((v) => v.toFixed(1))}`).join(' ')} dropped ${(e.n1.dropped || []).join(',')}`);
    const badIds = new Set(bad.map((e) => e.road));
    keep = keep.filter((id) => !badIds.has(id));
  }
  if (keep.length < all.length) { net.buswayDropped = true; net.buswayWhy = why; }
  net.buswaysKept = keep;
  return net;
}
function buildNetworkWith(field, keepBusways) {
  const B = (CITY.bounds || 440) / 2;
  const roads = [];
  // the bus-only lanes (西口 / 東口 busways) are roads too, that only buses are routed onto
  for (const rd of [...CITY.roads, ...(CITY.busways || []).filter((b) => keepBusways.includes(b.id)).map((b) => ({ ...b, busOnly: true }))]) {
    if (!rd.path || rd.path.length < 2) continue;
    if (rd.traffic === false) continue;                   // [city] pass 15: side-street mouths / the 246 side road drawn only
    const pts = densify(smoothRoad(rd.path), 1.0);
    const R = mkEdge(pts, {});
    roads.push({ id: rd.id, rd, cfg: roadCfg(rd), pts: R.pts, cum: R.cum, len: R.len, hdg: R.hdg, kap: R.kap, _h: 1, half: rd.width / 2 });
  }

  // ---- nodes: clustered road ends, T-junctions onto another road's interior, and interior crossings
  const ends = [];
  for (const R of roads) { ends.push({ R, s: 0, p: R.pts[0] }, { R, s: R.len, p: R.pts[R.pts.length - 1] }); }
  const clusters = [];
  for (const e of ends) {
    let cl = clusters.find((c) => c.ends.some((f) => dist2(f.p, e.p) < 14));
    if (!cl) clusters.push(cl = { ends: [] });
    cl.ends.push(e);
  }
  const nodes = [];
  for (const cl of clusters) {
    let p = [0, 0];
    for (const e of cl.ends) { p[0] += e.p[0] / cl.ends.length; p[1] += e.p[1] / cl.ends.length; }
    const members = cl.ends.map((e) => ({ R: e.R, s: e.s }));
    for (const R of roads) {
      if (cl.ends.some((e) => e.R === R)) continue;
      const q = nearestOn(R.pts, R.cum, p[0], p[1]);
      if (q.d <= R.half + 1.5 && q.s > 3 && q.s < R.len - 3) {
        members.push({ R, s: q.s, interior: true });
        const o = pointAt(R, q.s); p = [o[0], o[1]];
      }
    }
    const junction = members.length >= 2;
    nodes.push({ p, members, kind: junction ? 'j' : (Math.abs(p[0]) > B - 25 || Math.abs(p[1]) > B - 25 ? 'edge' : 'dead') });
  }
  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const A = roads[i], C = roads[j], pa = A.rd.path, pcx = C.rd.path;
    for (let a = 1; a < pa.length; a++) {
      for (let c = 1; c < pcx.length; c++) {
        const t = segX(pa[a - 1], pa[a], pcx[c - 1], pcx[c]);
        if (t < 0) continue;
        const P = [pa[a - 1][0] + (pa[a][0] - pa[a - 1][0]) * t, pa[a - 1][1] + (pa[a][1] - pa[a - 1][1]) * t];
        const sA = nearestOn(A.pts, A.cum, P[0], P[1]).s;
        const qC = nearestOn(C.pts, C.cum, P[0], P[1]);
        if (sA < 8 || sA > A.len - 8 || qC.s < 8 || qC.s > C.len - 8) continue;
        if (nodes.some((n) => dist2(n.p, P) < 12 && n.members.some((m) => m.R === A) && n.members.some((m) => m.R === C))) continue;
        nodes.push({ p: P, kind: 'j', members: [{ R: A, s: sA, interior: true }, { R: C, s: qC.s, interior: true }] });
      }
    }
  }
  nodes.forEach((n, i) => {
    n.id = i;
    n.cfg = n.kind === 'j' ? JUNCTIONS.find((J) => dist2(J.at, n.p) < 20) || null : null;
    if (n.cfg && n.cfg.id === 'scramble') n.p = [CROSS[0], CROSS[1]];
    n.arms = {};
  });

  // ---- pieces between consecutive nodes of each road, with the arm each end belongs to
  const pieces = [];
  for (const R of roads) {
    const list = [];
    for (const N of nodes) for (const m of N.members) if (m.R === R) list.push({ s: m.s, N });
    list.sort((a, b) => a.s - b.s);
    for (let i = 0; i + 1 < list.length; i++) {
      if (list[i + 1].s - list[i].s < 2) continue;
      pieces.push({ R, s0: list[i].s, s1: list[i + 1].s, n0: list[i].N, n1: list[i + 1].N });
    }
  }
  const armDir = (R, s, sign) => {
    const a = pointAt(R, s), b = pointAt(R, s + sign * 8);
    return hdgOf(b[0] - a[0], b[1] - a[1]);
  };
  for (const pc of pieces) {
    pc.n0.arms[pc.R.id + '+'] = { R: pc.R, h: armDir(pc.R, pc.s0, 1), half: pc.R.half };
    pc.n1.arms[pc.R.id + '-'] = { R: pc.R, h: armDir(pc.R, pc.s1, -1), half: pc.R.half };
  }
  // trim: how far along an arm its lanes stop short of the node, so they clear every other arm's carriageway
  // (plus room for the turn arcs)
  for (const N of nodes) {
    N.trim = {};
    for (const k in N.arms) {
      const A = N.arms[k];
      if (N.kind !== 'j') { N.trim[k] = N.kind === 'edge' ? 1 : 2; continue; }
      let t = 3;
      for (const k2 in N.arms) {
        if (k2 === k) continue;
        const C = N.arms[k2];
        const phi = Math.abs(wrapA(C.h - A.h));
        if (phi > 2.1) { t = Math.max(t, C.half * 0.5); continue; }
        t = Math.max(t, (C.half + A.half * Math.abs(Math.cos(phi))) / Math.max(0.35, Math.sin(phi)));
      }
      N.trim[k] = Math.min(34, t + (N.cfg && N.cfg.trim ? 0 : 5));
      if (N.cfg && N.cfg.trim) N.trim[k] = Math.max(N.trim[k], N.cfg.trim);
      if (N.cfg && N.cfg.trimArm && N.cfg.trimArm[k]) N.trim[k] = Math.max(N.trim[k], N.cfg.trimArm[k]);
    }
  }

  // ---- lanes
  const edges = [], lanes = [], cuts = [];
  const scramble = nodes.find((n) => n.cfg && n.cfg.id === 'scramble') || null;
  const cwRects = [...(CITY.crossing.crosswalks || []), ...(CITY.crossing.diagonals || [])];
  const stopLines = CITY.crossing.stopLines || [];
  const mkLanes = (pc, a, b, nA, nB) => {
    // lanes over centreline arc [a, b] of piece pc; nA / nB are the nodes at the a / b ends
    const R = pc.R, cfg = R.cfg, out = [];
    const dirs = cfg.two ? [1, -1] : [1];
    const o = [0, 0, 0, 0];
    for (const dir of dirs) {
      const nd = (cfg.dirN && cfg.dirN[dir]) || cfg.n;
      for (let k = 0; k < nd; k++) {
        const off = laneOffset(cfg, k), pts = [], arc = [];
        const n = Math.max(2, Math.ceil((b - a) / 1.0));
        for (let i = 0; i <= n; i++) {
          const s = dir > 0 ? a + (b - a) * i / n : b - (b - a) * i / n;
          sampleEdge(R, s, o);
          const h = dir > 0 ? o[2] : o[2] + Math.PI, l = leftOf(h);
          pts.push([o[0] + l[0] * off, o[1] + l[1] * off]); arc.push(s);
        }
        out.push({ pts, arc, dir, k, nd, R, n0: dir > 0 ? nA : nB, n1: dir > 0 ? nB : nA,
          arm0: R.id + (dir > 0 ? '+' : '-'), arm1: R.id + (dir > 0 ? '-' : '+') });
      }
    }
    // the scramble: incoming lanes end on the painted stop line, outgoing lanes start past the zebra
    for (const L of out) {
      if (scramble && L.n1 === scramble) {
        for (let i = L.pts.length - 1; i > 0; i--) {
          let hit = -1;
          for (const sl of stopLines) {
            const d = dist2(sl.a, sl.b), u = [(sl.b[0] - sl.a[0]) / d, (sl.b[1] - sl.a[1]) / d];
            const A2 = [sl.a[0] - u[0] * 2, sl.a[1] - u[1] * 2], B2 = [sl.b[0] + u[0] * 2, sl.b[1] + u[1] * 2];
            const t = segX(L.pts[i - 1], L.pts[i], A2, B2);
            if (t >= 0) { hit = t; break; }
          }
          if (hit >= 0) {
            const p = [L.pts[i - 1][0] + (L.pts[i][0] - L.pts[i - 1][0]) * hit, L.pts[i - 1][1] + (L.pts[i][1] - L.pts[i - 1][1]) * hit];
            L.pts = L.pts.slice(0, i).concat([p]); L.arc = L.arc.slice(0, i + 1);
            break;
          }
        }
      }
      if (scramble && L.n0 === scramble) {
        let last = -1;
        for (let i = 0; i < L.pts.length; i++) {
          const [x, z] = L.pts[i];
          if (cwRects.some((c) => inRectSeg(x, z, c.a, c.b, c.width / 2, 1.0))) last = i;
        }
        if (last >= 0 && last < L.pts.length - 3) { L.pts = L.pts.slice(last + 1); L.arc = L.arc.slice(last + 1); }
      }
    }
    return out;
  };
  const onPave = (x, z) => field && field.sample(x, z) > -0.08;
  for (const pc of pieces) {
    const t0 = pc.n0.trim[pc.R.id + '+'] || 0, t1 = pc.n1.trim[pc.R.id + '-'] || 0;
    const a = pc.s0 + t0, b = pc.s1 - t1;
    if (b - a < 4) continue;
    let ls = mkLanes(pc, a, b, pc.n0, pc.n1);
    // pavement: cut the piece wherever any of its lanes, widened to a bus, leaves the carriageway
    if (field) {
      const bad = [];
      for (const L of ls) {
        for (let i = 0; i < L.pts.length; i++) {
          const p = L.pts[i], q = L.pts[Math.min(L.pts.length - 1, i + 1)], r = L.pts[Math.max(0, i - 1)];
          const h = hdgOf(q[0] - r[0], q[1] - r[1]), l = leftOf(h);
          if (onPave(p[0], p[1]) || onPave(p[0] + l[0] * 1.3, p[1] + l[1] * 1.3) || onPave(p[0] - l[0] * 1.3, p[1] - l[1] * 1.3)) bad.push(L.arc[i]);
        }
      }
      if (bad.length) {
        bad.sort((x, y) => x - y);
        const lo = Math.min(...ls.map((L) => Math.min(L.arc[0], L.arc[L.arc.length - 1])));
        const hi = Math.max(...ls.map((L) => Math.max(L.arc[0], L.arc[L.arc.length - 1])));
        const good = [];
        let cur = lo;
        for (const s of bad) { if (s - 3.5 > cur) good.push([cur, s - 3.5]); cur = Math.max(cur, s + 3.5); }
        if (hi > cur) good.push([cur, hi]);
        ls = [];
        for (const [ga, gb] of good) {
          if (gb - ga < 10) continue;
          const nA = ga <= lo + 0.01 ? pc.n0 : (() => { const o = pointAt(pc.R, ga); const n = { id: nodes.length, p: [o[0], o[1]], kind: 'dead', members: [], arms: {}, trim: {}, cut: true }; nodes.push(n); cuts.push(n); return n; })();
          const nB = gb >= hi - 0.01 ? pc.n1 : (() => { const o = pointAt(pc.R, gb); const n = { id: nodes.length, p: [o[0], o[1]], kind: 'dead', members: [], arms: {}, trim: {}, cut: true }; nodes.push(n); cuts.push(n); return n; })();
          let got = mkLanes(pc, ga, gb, nA, nB);
          // a short stub between a junction and the pavement goes nowhere: nothing is routed into it (it would
          // fill with cars that can neither leave nor vanish in view); traffic may still come out of it
          if (gb - ga < STUB_MAX && !!nA.cut !== !!nB.cut) got = got.filter((L) => !L.n1.cut);
          ls.push(...got);
        }
      }
    }
    for (const L of ls) {
      if (L.pts.length < 2) continue;
      const e = mkEdge(L.pts, {
        kind: 'lane', road: pc.R.id, k: L.k, dir: L.dir, n0: L.n0, n1: L.n1, arm0: L.arm0, arm1: L.arm1,
        vmax: pc.R.cfg.v, narrow: pc.R.cfg.narrow, width: pc.R.cfg.busOnly ? 14 : pc.R.rd.width, nLanes: L.nd, busOnly: !!pc.R.cfg.busOnly,
        lw: pc.R.cfg.w,
      });
      if (e.len < 3) continue;
      e.id = edges.length; edges.push(e); lanes.push(e);
    }
  }

  // ---- connectors
  const conns = [];
  // Draw the path from lane ei's stop point to lane eo's start. Candidates run from the widest clothoid turn down to
  // tighter ones, then plain cubics, then (where no bus-width body fits) car-width ones; the one that admits the
  // longest vehicle wins — its body, in the bicycle pose, has to stay off the pavement all the way round, and not
  // swing further than a lane into its neighbour (a bus out of its own busway may swing wider; zones are sized
  // for the longest vehicle allowed). False if nothing fits even a car.
  const link = (N, ei, eo, type, d, fork) => {
    if (ei.next.some((c) => c.to === eo)) return true;
    const p0 = ei.pts[ei.pts.length - 1], h0 = ei.hdg[ei.hdg.length - 1];
    const p1 = eo.pts[0], h1 = eo.hdg[0];
    const Rt = R_TURN * clamp((Math.PI / 2) / Math.max(0.2, Math.abs(d)), 0.8, 2.2);
    const curved = type !== 'through' || Math.abs(d) > 0.35;
    const cands = [];
    if (curved) for (const f of [1, 0.85, 0.7, 0.58, 0.48, 0.4]) { const tp = turnPath(p0, h0, p1, h1, Rt * f); if (tp) cands.push({ pts: tp.pts, R: tp.R }); }
    for (const k of type === 'through' ? [0.36, 0.28, 0.45, 0.2, 0.55] : [0.45, 0.33, 0.55, 0.25]) cands.push({ pts: hermitePath(p0, h0, p1, h1, k), R: 0 });
    // (a bus turning into or out of a terminal's own carriageway (the 東口 loop) swings over its empty mouth)
    const swingMax = TERMINAL_BUSWAYS.has(ei.road) || TERMINAL_BUSWAYS.has(eo.road) ? 3.6 : ei.busOnly ? 2.8 : 2.2;
    let best = null;
    for (const cd of cands) {
      if (paveHits(cd.pts, field) || !sweepFits(ei, cd.pts, eo, TYPES.van, field)) continue;
      let kmax = 0;
      const tmp = mkEdge(cd.pts, {});
      for (let i = 0; i < tmp.kap.length; i++) kmax = Math.max(kmax, Math.abs(tmp.kap[i]));
      cd.maxL = 5.3;
      for (const [L, key, sw] of eo.narrow ? [] : [[11, 'bus', swingMax], [7.1, 'truck', 1.45]]) {
        if (sweepL(L) * kmax <= sw && sweepFits(ei, cd.pts, eo, TYPES[key], field)) { cd.maxL = L; break; }
      }
      if (!best || cd.maxL > best.maxL) best = cd;
      if (best.maxL >= 11) break;
    }
    if (!best) {
      // nothing a bus-width body could follow: a car-width path will do, and only cars are routed onto it
      for (const cd of cands) if (!paveHits(cd.pts, field, 0.95) && sweepFits(ei, cd.pts, eo, TYPES.van, field)) { best = cd; cd.maxL = 5.3; break; }
    }
    if (!best) return false;
    const pts = best.pts, R = best.R;
    const c = mkEdge(pts, {
      kind: 'conn', node: N, type: fork ? 'fork' : type, turn: type === 'left' ? 'L' : type === 'right' ? 'R' : null,
      n0: N, n1: N, from: ei, to: eo, vmax: Math.min(ei.vmax, eo.vmax), narrow: eo.narrow, R, h0, h1,
      w: type === 'through' ? (fork ? 0.8 : 1) : type === 'left' ? 0.5 : 0.3,
    });
    c.maxL = best.maxL;
    for (const tw of TURN_W) if (tw.road === ei.road && tw.type === type && dist2(tw.at, N.p) < 20) c.w *= tw.w;
    c.id = edges.length; edges.push(c); conns.push(c);
    ei.next.push(c); c.prev.push(ei);
    c.next.push(eo); eo.prev.push(c);
    return true;
  };
  for (const N of nodes) {
    if (N.kind !== 'j') continue;
    const inA = {}, outA = {};
    for (const e of lanes) {
      if (e.n1 === N) (inA[e.arm1] || (inA[e.arm1] = [])).push(e);
      if (e.n0 === N) (outA[e.arm0] || (outA[e.arm0] = [])).push(e);
    }
    for (const k in inA) inA[k].sort((a, b) => a.k - b.k);
    for (const k in outA) outA[k].sort((a, b) => a.k - b.k);
    const rightsAt = N.cfg && N.cfg.rights;
    for (const ak in inA) {
      // right turns: at junctions that allow them, from every approach or only the ones listed
      const rights = Array.isArray(rightsAt) ? rightsAt.includes(ak) : !!rightsAt;
      const Lin = inA[ak], hIn = Lin[0].hdg[Lin[0].hdg.length - 1];
      const mv = [];
      for (const bk in outA) {
        if (bk === ak) continue;                                  // U-turn
        if (outA[bk][0].busOnly && !Lin[0].busOnly) continue;     // (bus-only exits are added below)
        const Lout = outA[bk], d = wrapA(Lout[0].hdg[0] - hIn);
        const ad = Math.abs(d);
        if (ad > 2.2) continue;
        const type = ad <= 0.70 ? 'through' : d > 0 ? 'left' : 'right';
        if (type === 'right' && !rights) continue;
        mv.push({ bk, Lout, d, type });
      }
      const th = mv.filter((m) => m.type === 'through').sort((a, b) => b.d - a.d);   // leftmost first
      const nIn = Lin.length;
      for (const m of mv) {
        let ins, outs;
        if (m.type === 'left') { ins = [Lin[nIn - 1]]; outs = [m.Lout[m.Lout.length - 1]]; }
        else if (m.type === 'right') { ins = [Lin[0]]; outs = [m.Lout[0]]; }
        else if (th.length > 1 && nIn > 1) {
          ins = m === th[0] ? Lin.slice(1) : m === th[th.length - 1] ? [Lin[0]] : Lin;
          outs = m.Lout;
        } else { ins = Lin; outs = m.Lout; }
        const pairs = [];
        if (ins.length >= outs.length) ins.forEach((e, i) => pairs.push([e, outs[Math.min(outs.length - 1, Math.round(i * (outs.length - 1) / Math.max(1, ins.length - 1)))]]));
        else outs.forEach((o, i) => pairs.push([ins[Math.min(ins.length - 1, Math.round(i * (ins.length - 1) / Math.max(1, outs.length - 1)))], o]));
        if (outs.length === 1 && ins.length === 1) { pairs.length = 0; pairs.push([ins[0], outs[0]]); }
        const fork = m.type === 'through' && th.length > 1 && m !== th.reduce((a, b) => (Math.abs(a.d) <= Math.abs(b.d) ? a : b));
        for (const [ei, eo0] of pairs) {
          // a left turn that cannot clear a sharp kerb corner into the kerb lane may still make the next lane out
          const tries = m.type === 'left' ? [eo0, ...m.Lout.slice().reverse().filter((o) => o !== eo0)] : [eo0];
          let made = false;
          for (const eo of tries) {
            if (link(N, ei, eo, m.type, m.d, fork)) { made = true; break; }
          }
          if (!made) (N.dropped || (N.dropped = [])).push(`${ak}->${m.bk}`);
        }
      }
      // a bus-only exit is an extra way out of whichever incoming lane ends nearest to it
      if (!Lin[0].busOnly) for (const bk in outA) {
        const Lout = outA[bk];
        if (bk === ak || !Lout[0].busOnly) continue;
        const d = wrapA(Lout[0].hdg[0] - hIn);
        if (Math.abs(d) > 1.6) continue;
        const ei = Lin.slice().sort((x, y) => dist2(x.pts[x.pts.length - 1], Lout[0].pts[0]) - dist2(y.pts[y.pts.length - 1], Lout[0].pts[0]))[0];
        link(N, ei, Lout[0], Math.abs(d) <= 0.7 ? 'through' : d > 0 ? 'left' : 'right', d, false);
      }
      // a lane left with no way out (its only turn could not be drawn) takes whatever its neighbours can do
      for (const ei of Lin) {
        if (ei.next.length) continue;
        // …into the lane that matches its own place across the road (counted from the kerb on a left turn, from
        // the centre line otherwise), so a double left turns side by side instead of crossing into one lane
        for (const m of mv.slice().sort((x, y) => Math.abs(x.d) - Math.abs(y.d))) {
          const rank = (e, n) => (m.type === 'left' ? n - 1 - e.k : e.k);
          const want = rank(ei, nIn);
          const outs = m.Lout.slice().sort((x, y) => Math.abs(rank(x, m.Lout.length) - want) - Math.abs(rank(y, m.Lout.length) - want));
          if (outs.some((eo) => link(N, ei, eo, m.type, m.d, false))) break;
        }
        if (!ei.next.length && rights === false) {
          for (const bk in outA) {
            if (bk === ak) continue;
            const Lout = outA[bk], d = wrapA(Lout[0].hdg[0] - hIn);
            if (Math.abs(d) > 2.2 || d > -0.7) continue;
            if (Lout.some((eo) => link(N, ei, eo, 'right', d, false))) break;
          }
        }
      }
    }
  }
  for (const e of lanes) {
    e.source = e.n0.kind !== 'j';
    e.sink = e.next.length === 0;
    e.deadEnd = e.n1.kind === 'dead';
    // signal head at the end of this lane
    const N = e.n1;
    if (N.kind === 'j' && N.cfg && N.cfg.groups) {
      const g = N.cfg.groups[e.arm1];
      if (g) e.sig = { node: N, group: g };
    }
  }

  // the longest vehicle whose body (in the bicycle pose, with room for its own offset in the lane) stays off the
  // pavement along each lane itself: a kerb notch on a bend keeps buses out of that lane
  for (const e of lanes) {
    e.fitL = 5.3;
    for (const [L, key] of e.narrow ? [] : [[11, 'bus'], [7.1, 'truck']]) if (sweepPath(e.pts, TYPES[key], field, 0.06)) { e.fitL = L; break; }
  }
  // the longest vehicle that can drive on from each lane to some way out without meeting a turn too tight for it
  for (const e of lanes) e.okL = e.next.length ? 0 : e.fitL;
  for (let it = 0; it < 12; it++) {
    for (const e of lanes) {
      if (!e.next.length) continue;
      let m = 0;
      for (const c of e.next) m = Math.max(m, Math.min(c.maxL || 11, c.to.okL));
      e.okL = Math.min(m, e.fitL);
    }
  }

  // A lane that cannot be left — no way out, and its end is neither the map edge nor a dead end far out of town —
  // is a trap, and so is every lane whose only ways out lead into traps. Nothing is routed or spawned into one.
  for (const e of lanes) {
    e.farDead = e.n1.kind === 'dead' && dist2(e.n1.p, CROSS) > 150;
    e.trap = !e.next.length && e.n1.kind !== 'edge' && !e.farDead;
  }
  for (let it = 0; it < 12; it++) for (const e of lanes) if (!e.trap && e.next.length && e.next.every((c) => c.to.trap)) e.trap = true;

  // ---- conflict zones
  const zones = buildZones(edges);

  return { roads, nodes, pieces, edges, lanes, conns, zones, cuts };
}

// Every pair of paths that pass within a vehicle width of each other (and are not simply one after the other)
// gets a zone: an interval on each path. A car may only enter its side of a zone when the other side is empty.
function buildZones(edges) {
  const CELL = 4, grid = new Map(), key = (gx, gz) => gx * 100003 + gz;
  const samp = [];
  for (const e of edges) {
    // the body's swing depends on the curvature under its whole length, not at one point
    const L = e.kind === 'conn' ? (e.maxL || 5.3) : 11;
    const kw = new Float32Array(e.kap.length);
    for (let i = 0; i < e.kap.length; i++) {
      let m = 0;
      for (let j = i; j >= 0 && e.cum[i] - e.cum[j] <= L / 2; j--) m = Math.max(m, Math.abs(e.kap[j]));
      for (let j = i; j < e.kap.length && e.cum[j] - e.cum[i] <= L / 2; j++) m = Math.max(m, Math.abs(e.kap[j]));
      kw[i] = m;
    }
    e.kw = kw;
    const list = [];
    for (let s = 0; s <= e.len + 1e-6; s += 0.8) list.push(s);
    if (list[list.length - 1] < e.len - 0.2) list.push(e.len);
    const o = [0, 0, 0, 0];
    for (const s of list) {
      sampleEdge(e, s, o);
      // a body of length class L on curvature k sweeps about sweepL(L)·k either side of its path (bicycle pose)
      let ki = 0;
      { let a = 0, b = e.cum.length - 1; while (a < b) { const m = (a + b) >> 1; if (e.cum[m] < s) a = m + 1; else b = m; } ki = a; }
      const it = { e, s, x: o[0], z: o[1], h: o[2], k: kw[ki], sw: sweepL(L), hw: L > 7.2 ? 1.24 : L > 5.4 ? 1.06 : 0.91 };
      samp.push(it);
      const k = key(Math.floor(o[0] / CELL), Math.floor(o[1] / CELL));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(it);
    }
  }
  // lanes of one road are laid out to run side by side; only turn paths and other roads can conflict with them
  const seq = (a, b) => a.next.includes(b) || b.next.includes(a) || (a.kind === 'lane' && b.kind === 'lane' && a.road === b.road);
  const pairs = new Map();
  for (const A of samp) {
    const gx = Math.floor(A.x / CELL), gz = Math.floor(A.z / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = grid.get(key(gx + i, gz + j));
      if (!cell) continue;
      for (const Bq of cell) {
        if (Bq.e === A.e || Bq.e.id < A.e.id) continue;
        // two bodies can only touch where their centre lines come within the sum of their half-widths, plus the
        // swing of each on a curve and a small margin
        const D0 = A.hw + Bq.hw + Math.max(A.k * A.sw, Bq.k * Bq.sw);
        if (Math.abs(Bq.x - A.x) > D0 + Z_MARGIN || Math.abs(Bq.z - A.z) > D0 + Z_MARGIN) continue;
        const dd = Math.hypot(Bq.x - A.x, Bq.z - A.z);
        if (dd > D0 + (Math.abs(Math.cos(A.h - Bq.h)) > 0.94 ? Z_MARGIN_PAR : Z_MARGIN)) continue;
        if (seq(A.e, Bq.e)) continue;
        const pk = A.e.id * 100000 + Bq.e.id;
        if (!pairs.has(pk)) pairs.set(pk, { a: A.e, b: Bq.e, m: [] });
        pairs.get(pk).m.push([A.s, Bq.s, dd, Math.abs(Math.cos(A.h - Bq.h)) > 0.94 ? 1 : 0, A.k, Bq.k]);
      }
    }
  }
  const zones = [];
  for (const { a, b, m } of pairs.values()) {
    m.sort((x, y) => x[0] - y[0]);
    let run = [m[0]];
    const flush = () => {
      let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9, dmin = 1e9, par = 0, ka = 0, kb = 0;
      for (const [sa, sb, dd, pp, qa, qb] of run) {
        a0 = Math.min(a0, sa); a1 = Math.max(a1, sa); b0 = Math.min(b0, sb); b1 = Math.max(b1, sb);
        dmin = Math.min(dmin, dd); par += pp; ka = Math.max(ka, qa); kb = Math.max(kb, qb);
      }
      const Z = { e: [a, b], lo: [a0 - ZPAD, b0 - ZPAD], hi: [a1 + ZPAD, b1 + ZPAD], hold: [0, 0], hs: [[], []],
        yield: [false, false], w0: [0, 0], wT: [-1, -1], id: zones.length,
        dmin, par: par > run.length * 0.5, k: [ka, kb] };
      zones.push(Z);
      a.zones.push({ Z, side: 0 }); b.zones.push({ Z, side: 1 });
    };
    for (let i = 1; i < m.length; i++) {
      if (m[i][0] - m[i - 1][0] > 2.5) { flush(); run = []; }
      run.push(m[i]);
    }
    if (run.length) flush();
  }
  // Two turn paths leaving the same lane share its first metres (a split), two arriving on the same lane share its
  // last (a merge). A split is not a conflict at all: the cars are still in single file, so each follows whoever
  // went first down the other branch. A merge at a signal is a zip; anywhere else the turning side gives way.
  const isTurn = (e) => e.kind === 'conn' && e.type !== 'through';
  const signalled = (e) => e.kind === 'conn' && e.node && e.node.cfg && e.node.cfg.sig;
  for (const Z of zones) {
    const [a, b] = Z.e;
    const cc = a.kind === 'conn' && b.kind === 'conn';
    if (cc && a.from === b.from && Z.lo[0] <= ZPAD + 1.5 && Z.lo[1] <= ZPAD + 1.5) {
      Z.type = 'split';
      (a.sibs || (a.sibs = [])).push({ e: b, upto: Z.hi[1] });
      (b.sibs || (b.sibs = [])).push({ e: a, upto: Z.hi[0] });
      continue;
    }
    if (cc && a.to === b.to && Z.hi[0] >= a.len - 1.5 && Z.hi[1] >= b.len - 1.5 && signalled(a)) {
      Z.type = 'zip';
      (a.zips || (a.zips = [])).push({ e: b, from: Z.lo[1] });
      (b.zips || (b.zips = [])).push({ e: a, from: Z.lo[0] });
      continue;
    }
    Z.type = 'cross';
    Z.fair = cc && signalled(a) && signalled(b) && a.node === b.node;
    // on a green, a right turn waits for the oncoming stream (turn-taking made 246 stop for every right-turner)
    if (Z.fair && (a.turn === 'R') !== (b.turn === 'R')) { Z.fair = false; Z.yield[a.turn === 'R' ? 0 : 1] = true; continue; }
    if (signalled(a) || signalled(b)) continue;
    if (isTurn(a) && !isTurn(b)) Z.yield[0] = true;
    else if (isTurn(b) && !isTurn(a)) Z.yield[1] = true;
  }
  for (const e of edges) e.zones = e.zones.filter((zr) => zr.Z.type === 'cross');
  // a junction gate covers the turn path and the first metres of the lane it runs into, so a car never has to
  // take a zone while it is still inside the junction
  for (const e of edges) {
    if (e.kind !== 'conn') continue;
    e.gz = e.zones.map((zr) => ({ Z: zr.Z, side: zr.side, off: 0 }));
    for (const zr of e.to.zones) if (zr.Z.lo[zr.side] < GATE_TAIL) e.gz.push({ Z: zr.Z, side: zr.side, off: e.len });
  }
  for (const e of edges) e.zones.sort((x, y) => x.Z.lo[x.side] - y.Z.lo[y.side]);
  return zones;
}

// ---------------------------------------------------------------------------------------------- module
// Scratch for think(): the nearest stop requirement (for the gate and the debug), the nearest static stop point,
// the strongest leader interaction and the bumper gap to the leader. Plain functions, no per-car closures.
const S0_STOP = 0.3, TH_STOP = 0.5;
const PED_WAIT = 6;       // seconds a driver waits on a crowd member who does not get out of the way before nosing through
const PED_WAIT_STILL = 2.5; // …or on one who is standing still in the carriageway (a straggler stranded there)
const PED_WAIT_KNOWN = 1.2; // …or on one another car has just gone round (a still one is not waited on at all: the queue
                          //    follows the first car round, it does not stop and re-queue behind each straggler)
const NUDGE_V = 1.1;      // …at this speed
const NUDGE_PASS = 2.2;   // …or round a straggler who stands there (twice that when they are off to one side)
const YIELD_WAIT = 10;    // seconds a side road gives way to a steady main-road stream before it claims the next gap
const REPICK_T = 9;       // seconds at the head of a lane with no room / no gate before the driver takes another exit
const _K = { d: 1e9, why: null, o: null, dS: 1e9, rL: 0, gap: 1e9 };
function limS(d, why, o) {
  if (d < _K.d) { _K.d = d; _K.why = why; _K.o = o; }
  if (d < _K.dS) _K.dS = d;
}
function limL(c, v, g, vl, why, o) {
  const d = g - 1.9 - v * 0.25 + (vl * vl) / (2 * 6.5);
  if (d < _K.d) { _K.d = d; _K.why = why; _K.o = o; }
  if (g < _K.gap) _K.gap = g;
  const ss = c.s0 + Math.max(0, v * c.th + (v * (v - vl)) / (2 * Math.sqrt(c.a0 * c.bc)));
  const s = Math.max(0.05, g);
  const r = (ss / s) * (ss / s);
  if (r > _K.rL) _K.rL = r;
}
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _qw = new THREE.Quaternion();
const _t4 = [0, 0, 0, 0], _t4b = [0, 0, 0, 0];
// How a member of the crowd is actually moving, as the drivers have seen it (sampled whenever a car scans them; the
// crowd's own moving / vel flags describe intent and go stale whenever its update does not run). `passed`: when a
// car last went round them.
const _pv = new WeakMap();
function pedMotion(p, now) {
  let m = _pv.get(p);
  if (!m) {
    const v = p.moving === false ? 0 : p.vel || 0, y = p.yaw || 0;
    m = { x: p.x, z: p.z, t: now, vx: Math.sin(y) * v, vz: Math.cos(y) * v, still: v < 0.25 ? now : -1, passed: -1e9, ax: p.x, az: p.z, aT: now };
    _pv.set(p, m);
    return m;
  }
  const dt = now - m.t;
  if (dt >= 0.3) {
    const k = dt > 1.5 ? 1 : 0.65;
    m.vx += ((p.x - m.x) / dt - m.vx) * k; m.vz += ((p.z - m.z) / dt - m.vz) * k;
    m.x = p.x; m.z = p.z; m.t = now;
    if (m.vx * m.vx + m.vz * m.vz < 0.07) { if (m.still < 0) m.still = now; } else m.still = -1;
    // somebody milling about on one spot of the carriageway (a crosser the crowd has stranded there, stepping to and
    // fro) is as much a straggler as one standing still: `loiter` is the time since they last moved 2.5 m away
    if (Math.abs(p.x - m.ax) + Math.abs(p.z - m.az) > 2.5) { m.ax = p.x; m.az = p.z; m.aT = now; }
  }
  return m;
}
// one sample of a car's path against a pedestrian (crowdAhead): along / lateral in the path's frame. Somebody walking
// across who will be out of the car's corridor before its bonnet could possibly get there (flat out from its present
// speed) is no obstacle: the driver rolls on behind them as a real one does, instead of waiting for the kerb.
const _PT = { x: 0, z: 0, sn: 0, cs: 1, half: 1, base: 0, best: 1e9, still: false, lat: 0, vc: 0, nose: 3, now: 0, m: null, vAl: 0 };
function pedTest(p) {
  const P = _PT, dx = p.x - P.x, dz = p.z - P.z;
  const along = dx * P.sn + dz * P.cs, lat = dx * P.cs - dz * P.sn;   // lat > 0: to the left of the path
  if (along < -1.3 || along > 1.3 || Math.abs(lat) > P.half) return;
  const d = P.base + along;
  if (d >= P.best) return;
  const m = pedMotion(p, P.now);
  const vlat = m.vx * P.cs - m.vz * P.sn;
  if (vlat > 0.3 || vlat < -0.3) {
    const H = P.half + 0.2, tOut = ((vlat > 0 ? H : -H) - lat) / vlat, D = d - P.nose;
    const tArr = D <= 0 ? 0 : (Math.sqrt(P.vc * P.vc + 5.2 * D) - P.vc) / 2.6;
    if (tOut + 0.3 < tArr) return;
  }
  P.best = d; P.lat = lat; P.obj = p; P.m = m;
  P.vAl = m.vx * P.sn + m.vz * P.cs;
  P.still = (m.still >= 0 && P.now - m.still > 0.8) || P.now - m.aT > 4;
}

const traffic = {
  name: 'traffic',
  cars: [],
  lanes: [],
  edges: [],
  phase: 'scramble', phaseT: 0, cycleT: 0,
  signal: { ns: 'red', ew: 'red', ped: 'walk', vehicle: 'red', remaining: 47 },
  // Every vehicle that exists: the ~22 kerbside ones, the 85–95 the source rates keep driving, and a small reserve off
  // the map for the sources to draw on. (It was 196, and a third of that sat hidden in the reserve all the time.)
  budget: 124,
  seedActive: 100,      // how many are driving at t = 0; the source rates set how many drive after that

  init(engine) {
    this.engine = engine;
    const rng = engine.rng.fork(0x7a5);
    const q = engine.params && engine.params.raw ? Number(engine.params.raw.cars) : NaN;
    if (isFinite(q) && q >= 0) this.budget = q;          // ?cars=<n> for perf A/B
    const city = engine.get && engine.get('city');
    // start the cycle a little into the scramble for screenshots (pedestrians crossing, every car stopped)
    const pre = CYCLE[0].dur + CYCLE[1].dur + CYCLE[2].dur;
    const shot = engine.params && engine.params.shot;
    // traffic presets that need moving traffic say where in the cycle they want the capture; the lead-in is
    // simulated with the signal running, so queues discharge and turners are caught mid-turn
    const want = shot && SHOT_CYCLE[shot] !== undefined ? SHOT_CYCLE[shot] : null;
    const t0 = want !== null ? want - SHOT_LEAD : shot ? pre + 16 : rng.range(0, CYCLE_LEN);
    this.shotSeed = !!shot;
    const t1 = performance.now();
    this.initSim(engine, city && city.field ? city.field : null, rng, t0);
    if (!this.lanes.length) { console.warn('[traffic] no lanes from cityData'); return; }
    this._netMs = Math.round(performance.now() - t1);
    this.bindMovers();
    this.buildMeshes(engine, rng);
    for (const c of this.cars) if (c.eRoute) this.applyEastRoute(c, c.eRoute);   // their own 方向幕 and livery
    this._env = this.initEnv();                            // capture shaders and PMREM compiled now; captures once ready
    this.emitPhase();
    // screenshots: settle the queues deterministically, then hold still so a preset framed on a vehicle
    // still finds it there when the harness captures (the signal keeps ticking for crowd/props).
    if (want !== null) {
      for (let i = 0; i < SHOT_LEAD * 30; i++) { this.cycleT += 1 / 30; this.evalPhase(); this.drive(1 / 30); }
      this.cycleT = want; this.evalPhase(); this.lastSig = null; this.emitPhase();
      this.holdStill = true;
    } else if (shot) {
      const save = this.cycleT;
      for (let i = 0; i < 240; i++) this.drive(1 / 30);
      this.cycleT = save;
      this.evalPhase();
      this.holdStill = true;
    }
    this.writeMatrices(0);
    const net = this.net;
    console.info(`[traffic] ${this.cars.length} vehicles / ${net.lanes.length} lanes + ${net.conns.length} turn paths / `
      + `${net.nodes.filter((n) => n.kind === 'j').length} junctions / ${net.zones.length} conflict zones (${this._netMs} ms) / `
      + `${this.meshCount} draw meshes, cycle ${CYCLE_LEN}s, body tris full/mid ${this._geoBill}`);
  },

  // the simulation half of init, callable without a renderer (tools / selfTest)
  initSim(engine, field, rng, t0) {
    this.engine = engine;
    this.rng = rng;
    this.field = field;
    this.cars = [];
    this.buildNet(field);
    if (!this.lanes.length) return;
    this.cycleT = t0;
    this.lastSig = null;
    this.evalPhase();
    this.spawn(rng);
  },

  // ---- solid vehicles ------------------------------------------------------------------------------
  // Every car owns a physics "mover": an OBB updated in place each frame so characters cannot walk through
  // it, plus the velocity a body needs to be thrown with when the car runs it down.
  bindMovers() {
    const world = this.engine.world;
    if (!world || typeof world.addMover !== 'function') return;
    for (const c of this.cars) {
      // the box is the body plus a margin: bumpers, mirrors and wheel arches all sit outside T.len/T.wid,
      // and without it a character's shoulder visibly enters the bodywork before anything pushes back
      // physics' local x is (cos yaw, -sin yaw) — the car's SIDE — and local z is (sin yaw, cos yaw), the way it
      // drives. The first version put the length on local x, so every hitbox was turned 90°: wide across the
      // lane and short along the car, which is why people sank into bonnets and boots.
      c.mover = world.addMover({
        cx: c.x, cz: c.z, rot: c.yaw, hw: c.w * 0.5 + 0.30, hd: c.l * 0.5 + 0.30,
        yTop: (c.T.h || 1.5) + 0.6, tag: 'vehicle', userData: c,
      });
    }
  },

  updateMovers(step) {
    const world = this.engine.world;
    if (!world || !world.movers) return;
    const inv = step > 1e-4 ? 1 / step : 0;
    for (const c of this.cars) {
      const m = c.mover;
      if (!m) continue;
      const jump = Math.abs(c.x - m.cx) + Math.abs(c.z - m.cz) > 12;   // a despawn / respawn is not a velocity
      m.vx = jump ? 0 : (c.x - m.cx) * inv; m.vz = jump ? 0 : (c.z - m.cz) * inv;
      world.setMoverPose(m, c.x, c.z, c.yaw);
    }
    this.checkRunDown();
  },

  // Distance from a car's centre to the nearest person standing in its path (player or an enemy), or 1e9.
  // "In its path" is a corridor along the heading: ahead of the car, no further than 28 m, and within the car's
  // half-width plus a body. This is what a driver brakes for.
  personAhead(c) {
    const best = this._crowd ? this.crowdAhead(c, this._crowd) : 1e9;
    return Math.min(best, this.peopleAhead(c));
  },
  peopleAhead(c) {
    let best = 1e9;
    const people = this._people;
    if (!people || !people.length) return best;
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);             // the way the car drives (measured off its velocity)
    const half = c.w * 0.5 + 0.55;
    for (let i = 0; i < people.length; i++) {
      const p = people[i].position;
      const dx = p.x - c.x, dz = p.z - c.z;
      const along = dx * fx + dz * fz;
      if (along < 0 || along > 28) continue;
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat > half) continue;
      if (along < best) best = along;
    }
    return best;
  },

  // The nearest member of the crowd in the car's path, measured ALONG the path (a turning car sees the zebra it is
  // turning across), as a distance from the car's centre. Uses crowd.agentsNear(x, z, r) when crowd provides it,
  // otherwise crowd's road grid (4 m cells over ±240 m holding everyone who may legitimately be on the
  // carriageway: crossers out on a crossing and a fight's ring). Rescanned every other frame.
  crowdAhead(c, cr) {
    if (c.parked) return 1e9;
    const cam = this.engine.camera && this.engine.camera.position;
    if (cam && Math.abs(c.x - cam.x) + Math.abs(c.z - cam.z) > 220) return 1e9;
    if (((this._frame || 0) + c.id) & 1 && c._pedO !== undefined) return c._pedD < 1e8 ? c._pedD - (c.odo - c._pedO) : 1e9;
    const api = typeof cr.agentsNear === 'function';
    const head = cr.rHead, next = cr.rNext, peds = cr.peds;
    if (!api && (!head || !next || !peds)) return 1e9;
    const half = c.w * 0.5 + 0.55, o = _t4b, s0 = c.s + c.l * 0.5;
    let best = 1e9;
    _PT.still = false; _PT.obj = null; _PT.m = null; _PT.vAl = 0;
    _PT.vc = c.speed; _PT.nose = c.l * 0.5 + 0.6; _PT.now = this.simT || 0;
    for (let k = 0; k <= 10 && best > 1e8; k++) {
      const ds = k * 2.5;
      this.pathAt(c, s0 + ds, o);
      const P = _PT;
      P.x = o[0]; P.z = o[1]; P.sn = Math.sin(o[2]); P.cs = Math.cos(o[2]); P.half = half; P.base = c.l * 0.5 + ds; P.best = best;
      if (api) { const list = cr.agentsNear(P.x, P.z, half + 1.3); for (let i = 0; i < list.length; i++) pedTest(list[i]); }
      else {
        const R = half + 1.3;
        const gx0 = Math.max(0, ((P.x - R + 240) / 4) | 0), gx1 = Math.min(119, ((P.x + R + 240) / 4) | 0);
        const gz0 = Math.max(0, ((P.z - R + 240) / 4) | 0), gz1 = Math.min(119, ((P.z + R + 240) / 4) | 0);
        for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
          for (let i = head[gz * 120 + gx]; i >= 0; i = next[i]) { const p = peds[i]; if (p) pedTest(p); }
        }
      }
      best = P.best;
    }
    c._pedD = best; c._pedO = c.odo; c.pedLat = _PT.lat;
    c.pedObj = best < 1e8 ? _PT.obj : null; c.pedM = best < 1e8 ? _PT.m : null;
    c.pedStill = best < 1e8 && _PT.still; c.pedVal = best < 1e8 ? _PT.vAl : 0;
    return best;
  },

  // Move a character to the surface of a car's box along its nearest face, plus the character's radius.
  shoveClear(v, m) {
    const p = v.position, r = (v.radius || 0.35);
    const dx = p.x - m.cx, dz = p.z - m.cz;
    const lx = m.c * dx - m.s * dz, lz = m.s * dx + m.c * dz;
    const ox = m.hw + r - Math.abs(lx), oz = m.hd + r - Math.abs(lz);
    if (ox <= 0 || oz <= 0) return;                    // already outside on one axis
    let nlx = lx, nlz = lz;
    if (ox < oz) nlx = (lx < 0 ? -1 : 1) * (m.hw + r); else nlz = (lz < 0 ? -1 : 1) * (m.hd + r);
    p.x = m.cx + m.c * nlx + m.s * nlz;
    p.z = m.cz - m.s * nlx + m.c * nlz;
  },

  // A car that is actually moving and overlaps a character throws them clear and hurts them.
  checkRunDown() {
    const engine = this.engine, world = engine.world;
    const victims = this._victims || (this._victims = []);
    victims.length = 0;
    if (engine.player && engine.player.alive !== false) victims.push(engine.player);
    const enemy = engine.get('enemy');
    // (this read enemy.enemies, which does not exist — enemy.js keeps them in `list` — so no thug was ever hit)
    if (enemy && Array.isArray(enemy.list)) for (const en of enemy.list) if (en && en.alive !== false) victims.push(en);
    for (const v of victims) {
      const p = v.position; if (!p) continue;
      const m = world.moverAt(p.x, p.z, (v.radius || 0.35) + 0.12, p.y + 0.2);
      if (!m) continue;
      // Standing still inside a car's box means the CAR moved into US, so nothing on the character side
      // ever ran a sweep. Resolve it here, every frame, whether or not the hit reaction is on cooldown.
      this.shoveClear(v, m);
      if (v.hitByCarT > 0) { v.hitByCarT -= this._lastStep || 0.016; continue; }
      const speed = Math.hypot(m.vx, m.vz);
      if (speed < 1.6) continue;                      // crawling traffic just blocks you
      // a LOOP rider at 50 km/h catches the cars ahead of him: running into a car's back or side only stops him (the
      // shove above; loop.js bumps him). Only a car closing on HIM — its velocity toward him beyond his own — knocks
      // him off. On foot nothing changes.
      if (v.riding) {
        const vx = v.velocity ? v.velocity.x : 0, vz = v.velocity ? v.velocity.z : 0;
        const nx = p.x - m.cx, nz = p.z - m.cz, nl = Math.hypot(nx, nz) || 1;
        if (((m.vx - vx) * nx + (m.vz - vz) * nz) / nl < 1.6) continue;
      }
      const c = m.userData;
      const mass = c && c.kind === 'bus' ? 1.5 : c && c.kind === 'truck' ? 1.35 : 1;
      engine.events.emit('traffic:hit', {
        target: v, car: c, speed, mass,
        point: { x: p.x, y: p.y + 0.9, z: p.z },
        dir: { x: speed > 0 ? m.vx / speed : 0, z: speed > 0 ? m.vz / speed : 1 },
      });
      engine.events.emit('traffic:horn', { position: { x: m.cx, y: 1, z: m.cz } });
      v.hitByCarT = 1.6;                              // no re-hits while they tumble
      // and the driver stands on the brakes and stays there: at least 3 s, then for as long as the person is
      // still in front of the bonnet (personAhead in drive() holds it). No more driving on through them.
      if (c) { c.hitHold = 3.0; c.speed = Math.min(c.speed, 0.5); }
    }
  },

  // ------------------------------------------------------------------------------------------ network + spawning
  buildNet(field) {
    const net = buildNetwork(field || null);
    this.net = net;
    this.edges = net.edges;
    this.lanes = net.lanes;
    this.actuated = [];
    for (const N of net.nodes) {
      if (!N.cfg || !N.cfg.sig) continue;
      if (N.cfg.sig === 'scramble') { N.ctrl = { scramble: true }; continue; }
      const S = N.cfg.sig;
      N.ctrl = { a: S.a, b: S.b, min: { a: S.minA || 8, b: S.minB || 7 }, g: 'a', st: 'green', tau: S.off % S.a, lanes: { a: [], b: [] }, fixed: !!S.fixed };
      // sync windows: [{ g, phase, from, to }] in seconds from the start of that scramble phase
      if (S.sync) N.ctrl.sync = S.sync.map((W) => {
        let t0 = 0, i = 0;
        while (CYCLE[i].name !== W.phase) t0 += CYCLE[i++].dur;
        return { g: W.g, from: t0 + W.from, to: t0 + W.to };
      });
      for (const e of net.lanes) if (e.sig && e.sig.node === N) N.ctrl.lanes[e.sig.group].push(e);
      this.actuated.push(N);
    }
    this.sources = net.lanes.filter((e) => e.source && e.len >= 20 && !e.trap);
    // signalled mid-block zebras (cityData crosswalksExtra with stop lines per carriageway): a stop point on every
    // lane that crosses one of its stop lines
    this.xings = [];
    for (const cx of CITY.crosswalksExtra || []) {
      if (!cx.signals || !cx.stops) continue;
      const X = { id: cx.id, width: cx.width || 4 };
      for (const st of cx.stops) for (const e of net.lanes) {
        if (e.road !== st.road) continue;
        for (let i = 1; i < e.pts.length; i++) {
          const u = segX(e.pts[i - 1], e.pts[i], st.a, st.b);
          if (u < 0) continue;
          const sx = e.cum[i - 1] + u * (e.cum[i] - e.cum[i - 1]);
          if (sx > 6) (e.xings || (e.xings = [])).push({ s: sx, X });
          break;
        }
      }
      this.xings.push(X);
    }
    // bus stops (cityData busStops) on the lane a bus can reach them from: the kerb-side lane of their road
    for (const st of CITY.busStops || []) {
      let best = null, bd = 6, bs = 0;
      for (const e of net.lanes) {
        if (e.road !== st.road || e.okL < 10.8) continue;
        const q = nearestOn(e.pts, e.cum, st.pos[0], st.pos[1]);
        if (q.d < bd && q.s > 10 && q.s < e.len - 4) { bd = q.d; best = e; bs = q.s; }
      }
      if (!best) continue;
      // how far toward the kerb a bus can pull in here: the kerb's distance off the lane centre, less the body
      let kerbD = st.kerb === 'island' || !field ? 0 : 9;
      if (kerbD) for (let ds = -7; ds <= 7; ds += 1) {
        const o = pointAt(best, clamp(bs + ds, 0, best.len)), l = leftOf(o[2]);
        let k = 0;
        while (k < 4 && field.sample(o[0] + l[0] * k, o[1] + l[1] * k) < -0.05) k += 0.1;
        kerbD = Math.min(kerbD, k);
      }
      // a terminal's のりば (st.terminal) is served only by the buses of its own 系統 (eRoute); `doors`: they open there
      (best.stops || (best.stops = [])).push({ s: bs, id: st.id, lat: clamp(kerbD - 1.24 - 0.5, 0, 0.45), only: !!st.terminal, doors: !!st.doors });
      best.stops.sort((a, b) => a.s - b.s);
    }
    // taxi drop-off spots: on the kerb lane, a cab pulls in as far toward the kerb as the road allows (up to 2.4 m)
    this.drops = [];
    for (const D of DROPS) {
      let best = null, bd = 7, bs = 0;
      for (const e of net.lanes) {
        if (e.road !== D.road || e.k !== e.nLanes - 1 || e.okL < 4.7) continue;
        const q = nearestOn(e.pts, e.cum, D.pos[0], D.pos[1]);
        if (q.d < bd && q.s > 7 && q.s < e.len - 3) { bd = q.d; best = e; bs = q.s; }
      }
      if (!best) continue;
      let kerbD = 2.4 + 0.85 + 0.45;
      if (field) for (let ds = -3; ds <= 3; ds += 1) {
        const o = pointAt(best, clamp(bs + ds, 0, best.len)), l = leftOf(o[2]);
        let k = 0;
        while (k < kerbD && field.sample(o[0] + l[0] * k, o[1] + l[1] * k) < -0.05) k += 0.1;
        kerbD = Math.min(kerbD, k);
      }
      const st = { s: bs, lat: clamp(kerbD - 0.85 - 0.45, 0, 2.4), busy: null, e: best, pre: new Map() };
      // how far back along a straight path into the lane the cab may already start over toward the kerb: as far as
      // the tarmac beyond it stays carriageway (at 駅前通り the U-turn apron runs on to the scramble box)
      for (const P of best.prev) {
        if (P.kind !== 'conn' || P.type !== 'through') continue;
        let pre = 0;
        for (let back = 1; back <= 18 && field; back++) {
          const o = pointAt(P, Math.max(0, P.len - back)), l = leftOf(o[2]);
          if (field.sample(o[0] + l[0] * (st.lat + 1.3), o[1] + l[1] * (st.lat + 1.3)) > -0.3) break;
          pre = back;
        }
        st.pre.set(P, pre);
      }
      (best.drops || (best.drops = [])).push(st);
      this.drops.push(st);
    }
    const perRoad = {};
    for (const e of this.sources) perRoad[e.road] = (perRoad[e.road] || 0) + 1;
    // ?tds= / ?tdo= scale the demand of the roads that feed the scramble / of the rest (tuning A/B)
    const raw = (this.engine && this.engine.params && this.engine.params.raw) || {};
    const kS = isFinite(+raw.tds) && raw.tds !== undefined ? +raw.tds : 1, kO = isFinite(+raw.tdo) && raw.tdo !== undefined ? +raw.tdo : 1;
    this.srcRate = this.sources.map((e) => (SRC_RATE[e.road] !== undefined ? SRC_RATE[e.road] : 2) * (SCRAMBLE_FEED.has(e.road) ? kS : kO) / 60 / perRoad[e.road]);
    this.srcTok = this.sources.map((e, i) => (i * 0.37) % 1);
    return net;
  },

  // signal aspect for a lane's group at its junction
  sigState(e) {
    const g = e.sig.group, C = e.sig.node.ctrl;
    if (!C) return 'green';
    if (C.scramble) return this.signal[g] || 'red';
    return C.g !== g ? 'red' : C.st === 'allred' ? 'red' : C.st;
  },

  // The outer junctions are vehicle-actuated, as most of 渋谷's are: a green stays with its approach until someone
  // waits on the other one, then runs at least `min` s and at most its maximum, and ends early once its own approach
  // has emptied (gap-out). Amber 3 s, all-red 2 s; only one group is ever anything but red.
  // A junction synchronised to the scramble (sync) holds a group green through each of its windows, and hands the
  // other group amber 5 s before a window opens.
  stepSignals(step) {
    const u = ((this.cycleT % CYCLE_LEN) + CYCLE_LEN) % CYCLE_LEN;
    const inWin = (a, b) => ((u - a) % CYCLE_LEN + CYCLE_LEN) % CYCLE_LEN < ((b - a) % CYCLE_LEN + CYCLE_LEN) % CYCLE_LEN;
    for (let i = 0; i < this.actuated.length; i++) {
      const C = this.actuated[i].ctrl;
      C.tau += step;
      if (C.st === 'green') {
        const o = C.g === 'a' ? 'b' : 'a';
        let W = null;
        if (C.sync) for (const w of C.sync) if (inWin(w.from - 5, w.to)) { W = w; break; }
        if (W) { if (C.g !== W.g) { C.st = 'amber'; C.tau = 0; } }
        else if (C.fixed ? C.tau >= C[C.g] : C.tau >= C.min[C.g] && this.demand(C.lanes[o], 60) && (C.tau >= C[C.g] || !this.demand(C.lanes[C.g], 28))) { C.st = 'amber'; C.tau = 0; }
      } else if (C.st === 'amber') { if (C.tau >= 3) { C.st = 'allred'; C.tau = 0; } }
      else if (C.tau >= 2) { C.g = C.g === 'a' ? 'b' : 'a'; C.st = 'green'; C.tau = 0; }
    }
  },
  // Somebody on these lanes who could use a green: the front vehicle is near the line and is not held by a full
  // exit (a green given to a queue that has nowhere to go is wasted, and starves the other approach).
  demand(lanes, range) {
    for (let i = 0; i < lanes.length; i++) {
      const e = lanes[i], c = e.cars[e.cars.length - 1];
      if (c && e.len - c.s - c.l / 2 < range && !(c.why === 'room' && c.speed < 0.5)) return true;
    }
    return false;
  },

  nightNow() {
    const lt = this.engine && this.engine.get && this.engine.get('lighting');
    return lt && isFinite(lt.nightFactor) ? lt.nightFactor : 1;
  },

  pickType(e, rng) {
    const r = rng();
    if (e.narrow || e.width <= 8) return r < 0.18 ? 'scooter' : r < 0.45 ? 'van' : r < 0.68 ? 'kei' : 'hatch';
    const bigOk = e.width >= 14;
    if (SCRAMBLE_FEED.has(e.road) && this.nightNow() > 0.5) {
      const k = pickWeighted(ROAD_MIX_NIGHT, rng);
      return k === 'bus' && !bigOk ? 'truck' : k;
    }
    if (bigOk && r < 0.055) return 'bus';
    if (r < 0.10) return 'truck';
    if (r < 0.175) return 'van';
    if (r < 0.245) return 'taxi';
    if (r < 0.30) return 'taxikm';
    if (r < 0.345) return 'taxi';
    if (r < 0.40) return 'scooter';
    if (r < 0.50) return 'kei';
    if (r < 0.64) return 'hatch';
    if (r < 0.74) return 'wagon';
    return 'sedan';
  },

  // A vehicle keeps its own small lateral offset in the lane (real queues are never a ruled line). It is a fixed
  // offset of the path, eased in and out over 20 m of travel, so the body steers onto it instead of sliding.
  // Each driver is an IDM with their own headway, standstill gap, reaction time and throttle.
  mkCar(e, s, key, rng, extra) {
    const T = TYPES[key];
    const D = DRIVE[T.fam] || DRIVE.car;
    const two = T.wheels === 2;
    const c = {
      id: this._nid = (this._nid || 0) + 1, e, s, speed: 0, vf: rng.range(0.88, 1.10),
      lat: two || T.fam === 'bus' || key === 'truck' ? 0 : rng.range(-0.17, 0.17), latNow: 0,
      key, T, color: rng.pick(T.cols), yaw: 0, x: 0, z: 0, y: 0, plan: [], held: [], odo: 0, sigGo: null,
      pitch: 0, roll: 0, bob: rng.range(0, 6.283), spin: rng.range(0, 6.283), steer: 0, acc: 0, accLP: 0, aDes: 0,
      a0: D[0] * rng.range(0.88, 1.12), bc: D[1], th: rng.range(0.95, 1.35), s0: rng.range(1.5, 2.4),
      rt: rng.range(0.35, 0.8), go: 0, emerg: false, brakeT: 0, gapF: 1e9, pedT: 0, pedWait: 0, jamT: 0, yWait: 0,
      brake: 0, indL: 0, indR: 0, stuck: 0, hidden: false, big: T.fam === 'bus' || key === 'truck',
      kind: T.fam, w: T.wid, l: T.len, company: T.companies ? rng.pick(T.companies) : null,
      vacant: rng() < 0.58,
      far: false, lit: false, wb: Math.max(0.8, T.wb),
      // Everything the simulation and the draw ever set on a vehicle is declared here, in one order, so every vehicle
      // shares one hidden class: with 80-odd shapes every access to a car went megamorphic and boxed its doubles
      // (~120 KB of garbage a frame). The undefined ones are sentinels tested with === undefined.
      yawJit: 0, kap: 0, yawRate: 0, latV: 0, rx: undefined, rz: 0, parked: false, rank: false, flowRank: undefined,
      rs: 0, roff: 0, ryaw: 0, rsPosed: 0, rankR: null, slot: -1, rv: 0, rWait: 0, mover: null,
      wheelPos: null, wheelBase: 0, plateBase: 0, plateUv: null, roofUv: null, roofCol: null, destUv: null, livUv: null,
      nudgeM: null, gate: null, hitHold: 0, pullT: 0, join: null, joinSeen: null, keepLat: false, easeLat: false,
      _pedD: 0, _pedO: undefined, pedLat: 0, pedObj: null, pedM: null, pedStill: false, pedVal: 0,
      want: 0, why: null, whyO: null, dStop: 0, _mv: -1, stopLat: 0, dodge: 0, byp: null,
      _gsT: 0, _goT: 0, _gnT: 0, _gaT: 0, _gs: 0, _go: 0, _gn: 0, _ga: 0, _gvF: undefined, _lv: null,
      _despawn: false, _park: false, _kerb: false, stopFor: null, willStop: false, dwell: 0, served: null,
      dropFor: null, dropped: null, willDrop: false, dropT: 0, doorK: 0, kerbed: null,
      fLat: undefined, fE: null, fLead: null, goRank: null, doors: false, doorsOf: -1, queued: false,
      footK: undefined, bag: 0, heavy: T.heavy, _cbS: 0,
      eRoute: null, eDepot: false, eServed: false, eDoorT: 0,   // 東口 terminal service (stepEast)
    };
    if (T.companyOf) c.company = T.companyOf(c.color, rng);
    if (extra) Object.assign(c, extra);
    if (e) this.poseCar(c, 0);
    return c;
  },

  insertCar(c, e) {
    const list = e.cars;
    let i = list.length;
    while (i > 0 && list[i - 1].s > c.s) i--;
    list.splice(i, 0, c);
    c.e = e;
  },
  removeCar(c) {
    const list = c.e.cars, i = list.indexOf(c);
    if (i >= 0) list.splice(i, 1);
  },

  // choose the connector at the end of edge e (weighted; buses and trucks never turn into the narrow streets)
  choose(e, c, rng) {
    const opts = e.next;
    if (!opts.length) return null;
    if (opts.length === 1) return opts[0];
    let tot = 0;
    const w = this._w || (this._w = []);
    w.length = 0;
    for (const o of opts) {
      let v = o.w || 1;
      const X = o.kind === 'conn' ? o.to : o;
      if (c.big && X.narrow) v = 0;
      if (X.busOnly) v = c.kind === 'bus' ? v * 4 : 0;
      if (c.eRoute && !c.eServed && X.busOnly && X.road === EAST_BW) v *= 60;   // a 東口 service bus on its way in
      if (o.maxL && c.l > o.maxL + 0.05) v = 0;
      if (X.okL !== undefined && c.l > X.okL + 0.05) v = 0;
      if (X.deadEnd) v *= this.roomOn(X, c) < c.l + 6 ? 0 : 0.35;
      if (X.trap) v = 0;
      if (X.rank && c.T.taxi && c.vacant && !X.rank.joining && X.rank.occ[X.rank.slots.length - 1] === null) v *= 6;
      if (c.goRank) { const d = c.goRank.dist.get(X); if (d !== undefined) v *= 40 / (1 + d); }
      w.push(v); tot += v;
    }
    if (tot <= 0) {
      // nothing fits this vehicle (it should never have been routed here): take the widest turn
      let best = opts[0];
      for (const o of opts) if ((o.maxL || 11) > (best.maxL || 11)) best = o;
      return best;
    }
    let r = rng() * tot;
    for (let i = 0; i < opts.length; i++) { r -= w[i]; if (r <= 0) return opts[i]; }
    return opts[opts.length - 1];
  },

  // An exit lane's free length once everything already on it or heading for it has closed up. A vehicle that is
  // still running at speed will mostly have driven on through it by then, so it counts for a third of its length:
  // counting a whole platoon in flight across the 50 m scramble as parked on a 28 m exit throttled every green.
  // Only while the exit is itself flowing, though: once its front vehicle is held, everything counts in full.
  // (Strict — everything in full — for the last seconds of a scramble green: whoever crosses then must be able to
  // leave the box before the walk phase, whatever the traffic beyond does.)
  roomOn(X, c, strict = false) {
    let room = X.len;
    const head = X.cars[X.cars.length - 1];
    let flow = !strict && (!head || head.speed > 3);
    // a short exit (16–28 m between two junctions) only counts as flowing if the lane beyond it has room too:
    // otherwise a queue backing up from the next light fills it under the cars already committed into the box
    if (flow && X.len < 30) {
      const nx = X.next.length === 1 ? X.next[0].to : head && head.plan[0] && head.plan[0].kind === 'conn' ? head.plan[0].to : null;
      if (nx && this.roomOn(nx, head || c, true) < 12) flow = false;
    }
    for (const o of X.cars) room -= (o.l + 2) * (flow && o.speed > 5 ? 0.35 : 1);
    for (const P of X.prev) for (const o of P.cars) if (o !== c) room -= (o.l + 2) * (flow && o.speed > 5 ? 0.35 : 1);
    return room;
  },

  repick(c, E) {
    c.jamT = 0;
    const cur = c.plan[0];
    let best = null, bestRoom = c.l + 2.5;
    for (const o of E.next) {
      if (o === cur) continue;
      const X = o.kind === 'conn' ? o.to : o;
      if ((c.big && X.narrow) || (X.busOnly && c.kind !== 'bus') || (o.maxL && c.l > o.maxL + 0.05) || (X.okL !== undefined && c.l > X.okL + 0.05)) continue;
      const room = this.roomOn(X, c);
      if (room > bestRoom) { bestRoom = room; best = o; }
    }
    if (!best) return false;
    if (c.gate === cur) this.ungate(c, cur);
    c.plan.length = 0; c.plan.push(best);
    this.ensurePlan(c);
    return true;
  },

  // keep at least ~90 m of planned path beyond the current edge
  ensurePlan(c) {
    const rng = this.rng;
    let d = 0;
    let last = c.plan.length ? c.plan[c.plan.length - 1] : c.e;
    for (const p of c.plan) d += p.len;
    while (d < 90) {
      const nx = this.choose(last, c, rng);
      if (!nx) break;
      c.plan.push(nx); d += nx.len; last = nx;
    }
  },

  // position / heading / curvature at path distance s from the start of c's edge, continuing into its plan
  pathAt(c, s, o) {
    let E = c.e, k = 0;
    while (s > E.len && k < c.plan.length) { s -= E.len; E = c.plan[k++]; }
    return sampleEdge(E, s, o);
  },

  // Bicycle pose. The reference point (T.xr ahead of the rear axle) rides the path plus the car's lane offset;
  // the rear axle is dragged after it and never slides sideways (a tractrix), so the body turns about its rear
  // axle, the nose leads into a turn and the tail cuts inside, and the front wheels steer atan(wheelbase·κ).
  poseCar(c, step) {
    const o = _t4, T = c.T, E = c.e;
    this.pathAt(c, c.s + (T.xr - T.xc), o);
    // lane offset: fixed per car on a lane, none on a turn path, eased over 20 m of travel either way
    // (critically damped in distance, so the offset is picked up along an S, never with a kink)
    let tgt = 0;
    const L = E.kind === 'lane' ? E : E.type === 'through' || E.type === 'fork' ? E.to : null;
    if (L) tgt = (T.wheels === 2 ? (L.k === L.nLanes - 1 ? Math.min(0.9, (L.width / (L.nLanes || 1)) * 0.25 - 0.2) : 0) : c.lat) + (c.stopLat || 0) + (c.dodge || 0);
    // a scooter filtering up a queue holds its line beside the cars until it leaves the lane; standing, it is
    // paddled sideways in time rather than eased in over distance
    if (c.fLat !== undefined) {
      if (E !== c.fE) { c.fLat = undefined; c.fE = null; c.fLead = null; } else tgt = c.fLat;
    }
    if (step > 0 && (c.fLat !== undefined || c.easeLat) && c.speed < 2) {
      c.latNow += (tgt - c.latNow) * Math.min(1, step * 1.6); c.latV = 0;
    } else if (step > 0) {
      // (the S is as long as the speed needs: its peak lateral acceleration is ~0.8 m/s² per metre of offset, and never
      //  much over 2, whatever the speed, so a cab pulling over from 40 km/h takes 40 m about it and one crawling to the
      //  kerb takes 6)
      const ds = c.speed * step, iv = 1 / Math.max(0.1, c.speed), kL = Math.min(0.9, Math.sqrt(2 / Math.max(0.05, Math.abs(tgt - c.latNow))));
      const w = T.wheels === 2 ? clamp(1.3 * iv, 0.1, 0.8) : clamp(kL * iv, 0.06, 0.6);
      c.latV = (c.latV || 0) + ((tgt - c.latNow) * w * w - 2 * w * (c.latV || 0)) * ds;
      c.latNow += c.latV * ds;
    } else if (!c.keepLat) { c.latNow = tgt; c.latV = 0; }
    const l = leftOf(o[2]);
    const fx = o[0] + l[0] * c.latNow, fz = o[1] + l[1] * c.latNow;
    let rx = c.rx, rz = c.rz;
    const reset = !(step > 0) || rx === undefined || Math.abs(Math.hypot(fx - rx, fz - rz) - T.xr) > 1.5;
    if (reset) {
      const q = this.pathAt(c, c.s - T.xc, [0, 0, 0, 0]), ql = leftOf(q[2]);
      rx = q[0] + ql[0] * c.latNow; rz = q[1] + ql[1] * c.latNow;
    }
    let hx = fx - rx, hz = fz - rz;
    const d = Math.hypot(hx, hz) || 1e-6;
    hx /= d; hz /= d;
    rx = fx - hx * T.xr; rz = fz - hz * T.xr;
    c.rx = rx; c.rz = rz;
    const yaw = Math.atan2(hx, hz);
    c.x = rx + hx * T.xc; c.z = rz + hz * T.xc;
    if (step > 0 && !reset) {
      const rate = wrapA(yaw - c.yaw) / step;
      c.yawRate = rate;
      const v = c.speed;
      c.kap = v > 0.3 ? rate / v : c.kap || 0;
      c.roll += (clamp(v * v * c.kap * 0.013, -0.05, 0.05) - c.roll) * Math.min(1, step * 4);
      // Ackermann: the steer that gives this rear-axle curvature, rate-limited; wheels stay put while stopped
      if (v > 0.3) {
        const target = clamp(Math.atan(T.wb * c.kap), -0.62, 0.62);
        const r = 1.2 * step;
        c.steer += clamp(target - c.steer, -r, r);
      }
    } else if (reset) { c.kap = o[3]; c.yawRate = 0; c.steer = clamp(Math.atan(T.wb * o[3]), -0.62, 0.62); }
    c.yaw = yaw;
  },

  // walk back from (e, s) by `back` metres along the through-most predecessor chain, skipping connectors
  walkBack(e, s, back) {
    s -= back;
    let guard = 0;
    while (s < 0 && guard++ < 8) {
      const prevs = e.prev.filter((p) => p.kind === 'conn');
      if (!prevs.length) return null;
      const cn = prevs.find((p) => p.type === 'through') || prevs[0];
      const pe = cn.prev[0];
      if (!pe) return null;
      s += pe.len;
      e = pe;
    }
    return s < 0 ? null : { e, s };
  },

  queueType(e, rng, rank) {
    if (e.narrow || e.width <= 8) return this.pickType(e, rng);
    let key = pickWeighted(this.nightNow() > 0.5 ? QUEUE_MIX_NIGHT : QUEUE_MIX, rng);
    // one bus per arm is enough near the line: nose to tail they merge into a single grey wall
    if (key === 'bus' && (e.width < 14 || rank < 4)) key = 'truck';
    if (key === 'scooter' && rank === 0) key = 'kei';
    return key;
  },

  // A scooter stands at the line beside the head of a red queue, on the kerb side of the kerb lane or astride the
  // lane line of the inner one; the head keeps to the offside of its lane to leave it room. It is the front of the
  // lane for car-following, so on the green it goes first and the car beside it waits for it to get clear.
  filterScooter(e, head, rng) {
    // (the arms crossing_night and the 道玄坂 walk look along get one on every lane whose head leaves room)
    const busy = FILTER_ARMS.has(e.road);
    if (head.T.wheels === 2 || (!busy && rng() > 0.8)) return null;
    const lw = e.lw || 3.2, kerb = e.k === e.nLanes - 1;
    const F = this._filt || (this._filt = new Set());
    const fk = busy ? e : e.road;
    if (F.has(fk)) return null;
    // (the kerb lane's edge has 0.8 m or more of gutter beyond it on every scramble arm: the scooter rides in it; on the
    //  inner lane it stands astride the lane line, far enough over that a bus heading the kerb lane still clears it)
    const lat = kerb ? lw / 2 + 0.1 : lw / 2 - 0.35, hl = kerb ? -0.15 : -0.3;
    if (lat - hl < head.w / 2 + 0.5 || (!kerb && head.w > 1.8)) return null;
    const T = TYPES.scooter;
    const s = head.s + head.l / 2 - T.len / 2 - 0.1;
    const sc = this.mkCar(e, s, 'scooter', rng, { speed: 0, brake: 1, queued: true, fLat: lat, fE: e });
    head.lat = hl; this.poseCar(head, 0);
    this.poseCar(sc, 0);
    this.insertCar(sc, e);
    F.add(fk);
    return sc;
  },

  // in play: a scooter stopped right behind the head of a red queue on the kerb lane slides out to the kerb side
  // and rolls up the gap to the line (tryFilter arms it; think() swaps it to the front once it is clear sideways)
  tryFilter(c, E, lead) {
    if (E.cars[E.cars.length - 1] !== lead || E.k !== E.nLanes - 1 || lead.T.wheels === 2 || c.fLat !== undefined) return;
    if (lead.speed > 0.2 || lead.why !== 'red' || this.sigState(E) !== 'red' || this.signal.remaining < 9) return;
    if ((lead.s - c.s) - (lead.l + c.l) / 2 > 6) return;
    const lat = (E.lw || 3.2) / 2 + 0.1;
    if (lat - lead.latNow < lead.w / 2 + 0.5) return;
    c.fLat = lat; c.fE = E; c.fLead = lead;
  },

  // does a vehicle of length l fit at (e, s) without touching anything already placed?
  fits(e, s, l) {
    for (const o of e.cars) if (Math.abs(o.s - s) < (o.l + l) / 2 + 1.2) return false;
    return s - l / 2 > 0.3 && s + l / 2 < e.len - 0.3;
  },

  spawn(rng) {
    const cars = this.cars;
    const edges = this.edges;
    let left = this.budget;
    // --- 1. stationary kerbside vehicles
    const kerb = [];
    if (left > 0) for (const p of this.parkedSlots(rng)) {
      if (left <= 0) break;
      cars.push(p); kerb.push(p); left--;
    }
    this.ranks = this.buildRanks(kerb, rng);
    // --- 2. the queues at the scramble. Every approach lane is seeded nose-to-tail back from its painted stop
    //        line (spilling back past a minor junction if it has to), so the front rank sits ON the line in frame 0.
    const scr = this.lanes.filter((e) => e.sig && e.sig.node.ctrl && e.sig.node.ctrl.scramble);
    for (const e of scr) {
      const A = APPROACH[e.road] || { depth: 4 };
      // a screenshot freezes the end of a long red; in play the queue is as deep as this arm's red is old
      const depth = this.shotSeed ? A.depth : Math.min(A.depth, Math.round(this.redAge(e.sig.group) / 20));
      // (the lane ends ON the painted 停止線; the zebra is another 2.6–4.6 m on, so the head noses right up to the paint)
      let cur = { e, s: e.len - 0.32 };
      const heads = A.heads ? A.heads[Math.min(e.k, A.heads.length - 1)] : null;
      let head = null;
      for (let rank = 0; rank < depth && left > 0; rank++) {
        // The heads are set, not rolled (APPROACH.heads): a lit cab, a bus face, a tall van — the things that clear
        // a scramble crowd from eye level.
        let key = heads && rank < heads.length && !cur.e.narrow ? heads[rank] : this.queueType(cur.e, rng, rank);
        if (key === 'bus' && cur.e.width < 14) key = 'truck';
        if (TYPES[key].len > cur.e.okL + 0.05) key = TYPES[key].len > 7.2 && cur.e.okL >= 7.1 ? 'truck' : 'sedan';
        const T = TYPES[key];
        const gap = rank ? rng.range(1.4, 2.9) : 0;
        let at = this.walkBack(cur.e, cur.s, T.len * 0.5 + gap);
        if (at && at.s < T.len * 0.5 + 0.3) {
          // straddling the start of the lane: carry on behind the junction upstream instead
          const up = this.walkBack(at.e, at.s, at.s + 1);
          at = up ? { e: up.e, s: up.e.len - T.len * 0.5 - 1.5 } : null;
        }
        if (!at || at.s < T.len * 0.5 + 0.3) break;
        if (!this.fits(at.e, at.s, T.len)) break;
        const c = this.mkCar(at.e, at.s, key, rng, { speed: 0, brake: 1, queued: true });
        if (rank < 4 && c.T.taxi) c.vacant = true;            // 空車: the 行灯 is lit
        this.insertCar(c, at.e); cars.push(c); left--;
        if (rank === 0) head = c;
        cur = { e: at.e, s: at.s - T.len * 0.5 };
      }
      // a scooter has filtered up to the line beside the head, on its kerb side
      if (head && left > 0 && head.e === e && !e.narrow) {
        const sc = this.filterScooter(e, head, rng);
        if (sc) { cars.push(sc); left--; }
      }
    }
    // --- 2b. a cab already standing at each drop-off spot, its fare getting out
    for (const st of this.drops || []) {
      if (left <= 0) break;
      const key = rng() < 0.7 ? 'taxikm' : 'taxi', T = TYPES[key];
      const s = st.s - T.len / 2 - 0.4;
      if (!this.fits(st.e, s, T.len)) continue;
      const c = this.mkCar(st.e, s, key, rng, { speed: 0, brake: 1, vacant: false, dropFor: st, willDrop: true, dropT: rng.range(1.6, 3.4) - (this.shotSeed ? 8 : 0), doorK: 1, stopLat: st.lat, lat: 0 });
      st.busy = c; c.kerbed = st;
      cars.push(c); left--;
    }
    // --- 3. the rest of the budget spread along every lane, denser near the crossing and on the arms in scope
    const pool = this.lanes.slice();
    let guard = 0, driving = cars.filter((c) => !c.parked).length;
    while (left > 0 && driving < this.seedActive && guard++ < 6000) {
      const e = pool[Math.floor(rng() * pool.length)];
      if (e.trap || e.busOnly) continue;
      const mid = e.pts[Math.floor(e.pts.length / 2)];
      const d = Math.hypot(mid[0] - CROSS[0], mid[1] - CROSS[1]);
      const want = clamp(1.25 - d / 260, 0.25, 1) * (FOCUS_ROADS[e.road] || 0.6) * clamp(e.len / 60, 0.3, 1.6);
      if (rng() > want) continue;
      const key = this.pickType(e, rng), T = TYPES[key];
      if (T.fam === 'bus' && e.width < 14) continue;
      if (T.len > e.okL + 0.05) continue;
      const s = rng.range(T.len, Math.max(T.len + 0.1, e.len - T.len));
      if (!this.fits(e, s, T.len + 10)) continue;
      const c = this.mkCar(e, s, key, rng, { speed: e.vmax * 0.6 });
      this.insertCar(c, e); cars.push(c); left--; driving++;
    }
    // --- 4. the rest wait off the map; the sources let them in at the rate their roads can carry
    const wide = this.sources.filter((e) => e.width >= 14);
    const reserve = [];
    for (; left > 0 && wide.length; left--) {
      const e = wide[Math.floor(rng() * wide.length)];
      const c = this.mkCar(null, 0, this.pickType(e, rng), rng, { hidden: true, x: 1e5, z: 1e5 });
      c.e = e;
      cars.push(c); reserve.push(c);
    }
    // plans for everyone that drives, and the zones they are already standing in
    for (const c of cars) {
      if (c.parked || c.hidden) continue;
      this.ensurePlan(c);
      for (const zr of c.e.zones) {
        const Z = zr.Z, lo = Z.lo[zr.side], hi = Z.hi[zr.side];
        if (c.s + c.l / 2 > lo && c.s - c.l / 2 < hi) {
          zTake(Z, zr.side, c);
          c.held.push({ Z, side: zr.side, rel: c.odo + (hi - c.s) + c.l / 2 });
        }
      }
    }
    this.pool = reserve;
    this.spawnEast(rng.fork(0x1e57));
  },

  // ------------------------------------------------------------------------------------------ 東口 bus terminal
  // Its own small fleet, outside the budget and on a forked rng (so the rest of the seeding is untouched): the buses
  // laying over in the 待機場所 (cityData busTerminals.higashi.layover) and the 東光 bus at 53 on 明治通り (kerbside),
  // two service buses already standing at their のりば, and a depot that stepEast lets in from 明治通り 北行 one at a
  // time. A service bus carries its 系統 (eRoute: 方向幕, livery), stops at its own のりば only, dwells there with the
  // middle door open, leaves by the exit to 宮益坂下 and goes back to the depot when it despawns.
  spawnEast(rng) {
    this.eDepot = []; this.eIn = null; this.eBw = null; this.eT = 0;
    if (!EAST_T || !EAST_ROUTES.length) return;
    const cars = this.cars;
    const byNo = (no) => EAST_ROUTES.find((r) => r.no === no) || EAST_ROUTES[0];
    const standing = [...(EAST_T.layover || []).map((q) => [...q, false]), ...(EAST_T.kerbside || []).map((q) => [...q, true])];
    for (const [x, z, rotY, no, open] of standing) {
      const c = this.mkCar(null, 0, 'bus', rng, { speed: 0, bob: 0, lat: 0, yawJit: 0, x, z, yaw: hdgOf(Math.cos(rotY), -Math.sin(rotY)), kap: 0,
        indL: 0, indR: 0, parked: true, vacant: true, doorK: open ? 1 : 0 });
      c.eRoute = byNo(no);
      cars.push(c);
    }
    const bw = this.lanes.find((e) => e.busOnly && e.road === EAST_BW);
    if (!bw) return;
    this.eBw = bw;
    // the lane a service bus is let in on: 明治通り 北行's lane that turns into the terminal
    this.eIn = this.lanes.filter((e) => !e.busOnly && e.n1 === bw.n0 && e.next.some((c) => c.to === bw) && e.len > 30).sort((a, b) => b.k - a.k)[0] || null;
    // two already at their のりば, doors open (the loop is never empty on arrival)
    const dyn = EAST_ROUTES.filter((r) => r.dyn);
    for (const no of ['都01', '田87']) {
      const r = dyn.find((q) => q.no === no), st = r && (bw.stops || []).find((q) => q.id === r.stop);
      if (!st) continue;
      const c = this.mkCar(bw, st.s - TYPES.bus.len / 2 - 0.3, 'bus', rng, { speed: 0, brake: 1, eRoute: r, eDepot: true, stopFor: st, willStop: true,
        dwell: rng.range(16, 30), stopLat: st.lat, latNow: st.lat, doorK: 1, eDoorT: 2 });
      this.insertCar(c, bw); cars.push(c); this.ensurePlan(c);
    }
    for (let k = 0; k < 3; k++) {
      const c = this.mkCar(null, 0, 'bus', rng, { hidden: true, x: 1e5, z: 1e5, eDepot: true });
      cars.push(c); this.eDepot.push(c);
    }
  },

  applyEastRoute(c, r) {
    if (!r) return;
    c.eRoute = r;
    if (this.destBoards) c.destUv = destUvOf(r.dest);
    const op = EAST_T && EAST_T.operators && EAST_T.operators[r.op];
    if (op && c.color !== op.body) {
      c.color = op.body;
      // the body colour is uploaded when an instance slot changes hands: let this bus's slots re-upload it
      for (const im of this._bodyList || []) for (let i = 0; i < im.__slots.length; i++) if (im.__slots[i] === c) im.__slots[i] = null;
    }
  },

  pickEastRoute() {
    const dyn = EAST_ROUTES.filter((r) => r.dyn);
    return dyn.length ? dyn[Math.min(dyn.length - 1, Math.floor(this.rng() * dyn.length))] : null;
  },

  // Let the next service bus in from the depot when fewer than two are on their way in or standing at a のりば,
  // where nobody is looking and the lane has room (the same checks as respawn).
  stepEast(step) {
    if (!this.eIn || !this.eDepot || !this.eDepot.length) return;
    this.eT -= step;
    if (this.eT > 0) return;
    this.eT = 2;
    let active = 0;
    for (const c of this.cars) if (c.eRoute && c.eDepot && !c.eServed && !c.hidden && !c.parked) active++;
    if (active >= 2) return;
    const e = this.eIn, first = e.cars[0];
    if (first && first.s - first.l / 2 < 16) return;
    if (e.zones.some((zr) => zr.Z.lo[zr.side] < 14 && zr.Z.hold[1 - zr.side] > 0)) return;
    const p = e.pts[0];
    if (this.seen(p[0], p[1])) { this.eT = 0.5; return; }
    const c = this.eDepot.pop();
    this.applyEastRoute(c, this.pickEastRoute());
    const s = c.l / 2 + 0.3, room = (first ? first.s - first.l / 2 - 3 : e.len - 1) - (s + c.l / 2);
    c.hidden = false; c.s = s; c.speed = Math.min(e.vmax * c.vf, 8, Math.sqrt(2 * 2.2 * Math.max(0, room)));
    c.plan.length = 0; c.sigGo = null; c.stuck = 0; c.hitHold = 0; c.pedWait = 0; c.nudgeM = null; c.jamT = 0; c.yWait = 0; c.gate = null; c.acc = 0;
    c.stopFor = null; c.served = null; c.willStop = false; c.dwell = 0; c.doorK = 0; c.eDoorT = 0; c.eServed = false;
    this.insertCar(c, e);
    this.ensurePlan(c);
    this.poseCar(c, 0);
    if (c.mover) { c.mover.cx = c.x; c.mover.cz = c.z; c.mover.vx = 0; c.mover.vz = 0; }
  },

  // Kerbside vehicles: a taxi rank, delivery vans on their hazards, a bus at its stop. Each slot is dropped unless
  // the whole body sits on the carriageway and clear of every lane and turn path.
  parkedSlots(rng) {
    const out = [];
    const field = this.field;
    const o = [0, 0, 0, 0];
    const roadsById = new Map(this.net.roads.map((R) => [R.id, R]));
    const placed = [];
    const clearOf = (x, z, h, hw, hl) => {
      const f = fwdOf(h), l = leftOf(h);
      for (let u = -1; u <= 1; u += 0.5) for (const v of [-1, 1]) {
        const px = x + f[0] * hl * u + l[0] * hw * v, pz = z + f[1] * hl * u + l[1] * hw * v;
        if (field && field.sample(px, pz) > -0.18) return false;
        for (const cw of CW_ALL) {
          if (inRectSeg(px, pz, cw.a, cw.b, cw.width / 2, 0.8)) return false;
        }
      }
      // lanes and turn paths: nothing may pass within a bus half-width + margin of the body
      for (const e of this.edges) {
        const b0 = e.pts[0];
        if (Math.abs(b0[0] - x) > e.len + 20 && Math.abs(b0[1] - z) > e.len + 20) continue;
        for (let i = 0; i < e.pts.length; i++) {
          const p = e.pts[i];
          const dx = p[0] - x, dz = p[1] - z;
          if (Math.abs(dx) > hl + 3 || Math.abs(dz) > hl + 3) continue;
          const al = Math.abs(dx * f[0] + dz * f[1]), lat = Math.abs(dx * l[0] + dz * l[1]);
          // a turn path also carries the swept excess of the longest vehicle allowed on it
          const sw = e.kind === 'conn' ? sweepL(e.maxL || 5.3) * Math.abs(e.kap[i]) : 0;
          if (al < hl + 1.0 && lat < hw + 1.45 + sw) return false;
        }
      }
      for (const q of placed) if (Math.hypot(q[0] - x, q[1] - z) < (q[2] + hl) + 0.6) return false;
      return true;
    };
    for (let ki = 0; ki < PARKED.length; ki++) {
      const K = PARKED[ki];
      const R = roadsById.get(K.road);
      if (!R) continue;
      if (K.at) {
        // explicit kerb points from cityData (head of the rank first)
        const pts = (CITY.spawns && CITY.spawns[K.at]) || [];
        pts.forEach((p, i) => {
          const key = K.kinds[i % K.kinds.length], T = TYPES[key];
          const q = nearestOn(R.pts, R.cum, p[0], p[1]);
          sampleEdge(R, q.s, o);
          const h = o[2] + (K.side === -1 ? Math.PI : 0);
          if (!clearOf(p[0], p[1], h, T.wid / 2, T.len / 2)) return;
          out.push(this.mkCar(null, 0, key, rng, {
            speed: 0, bob: 0, lat: 0, yawJit: 0, x: p[0], z: p[1], yaw: h + rng.range(-0.01, 0.01), kap: 0,
            indL: 0, indR: 0, parked: true, rank: !!K.rank, vacant: true, flowRank: K.flow ? ki : undefined,
          }));
          placed.push([p[0], p[1], T.len / 2]);
        });
        continue;
      }
      let s = K.from;
      for (const key of K.kinds) {
        const T = TYPES[key];
        let ok = false;
        while (s < Math.min(R.len - 5, K.to || R.len)) {
          const sc = s + T.len / 2;
          sampleEdge(R, sc, o);
          const side = K.side === -1 ? -1 : 1;
          const off = side * (R.half - 0.42 - T.wid / 2);
          const l = leftOf(o[2]);
          const x = o[0] + l[0] * off, z = o[1] + l[1] * off;
          const h = o[2] + (side < 0 ? Math.PI : 0);
          if (clearOf(x, z, h, T.wid / 2, T.len / 2)) {
            const c = this.mkCar(null, 0, key, rng, {
              speed: 0, bob: 0, lat: 0, yawJit: 0, x, z, yaw: h + rng.range(-0.012, 0.012), kap: 0,
              indL: K.hazard ? 1 : 0, indR: K.hazard ? 1 : 0, parked: true, rank: !!K.rank, vacant: true,
              flowRank: K.flow ? ki : undefined,
              doors: !!K.doors && !out.some((o) => o.doorsOf === ki) && TYPES[key].build === truckBody,
            });
            if (c.doors) c.doorsOf = ki;
            out.push(c); placed.push([x, z, T.len / 2]);
            s = sc + T.len / 2 + (K.gap || 1.2);
            ok = true;
            break;
          }
          s += 1;
        }
        if (!ok) break;
      }
    }
    return out;
  },

  // ------------------------------------------------------------------------------------------ taxi ranks
  // A rank is a line of kerb slots beside one lane. The front cab takes a fare now and then and pulls out into the
  // lane when there is a gap (right indicator, an S onto the lane over ~20 m); the cabs behind move up a slot one
  // after the other; an empty cab passing in that lane may pull in (left indicator) to the free slot at the back.
  // Parked cabs are off the lane, so nothing waits on the rank but the cab that is pulling in or out.
  buildRanks(kerb, rng) {
    const groups = new Map();
    for (const c of kerb) if (c.flowRank !== undefined) { if (!groups.has(c.flowRank)) groups.set(c.flowRank, []); groups.get(c.flowRank).push(c); }
    const ranks = [], o = [0, 0, 0, 0];
    for (const [ki, list] of groups) {
      const K = PARKED[ki];
      let lane = null, bd = 1e9;
      for (const e of this.lanes) {
        if (e.road !== K.road) continue;
        const q = nearestOn(e.pts, e.cum, list[0].x, list[0].z);
        sampleEdge(e, q.s, o);
        if (Math.abs(wrapA(o[2] - list[0].yaw)) > 0.5 || q.d > 7) continue;
        if (q.d < bd) { bd = q.d; lane = e; }
      }
      if (!lane) continue;
      const cabs = [];
      for (const c of list) {
        const q = nearestOn(lane.pts, lane.cum, c.x, c.z);
        if (q.s < 6 || q.s > lane.len - 4) continue;
        sampleEdge(lane, q.s, o);
        const l = leftOf(o[2]);
        c.rs = q.s; c.roff = (c.x - o[0]) * l[0] + (c.z - o[1]) * l[1]; c.ryaw = wrapA(c.yaw - o[2]);
        cabs.push(c);
      }
      if (cabs.length < 2) continue;
      cabs.sort((a, b) => b.rs - a.rs);                        // the head of the rank first
      const R = { lane, slots: cabs.map((c) => ({ s: c.rs, off: c.roff })), occ: cabs.slice(), joining: null, big: cabs.length > 6, t: 0, incoming: 0 };
      // how many junctions each lane is from the rank's lane, so a cab sent to it can find the way
      R.dist = new Map([[lane, 0]]);
      for (let q = [lane], d = 1; q.length && d < 12; d++) {
        const nq = [];
        for (const X of q) for (const P of X.prev) { const F = P.kind === 'conn' ? P.from : P; if (F && !R.dist.has(F)) { R.dist.set(F, d); nq.push(F); } }
        q = nq;
      }
      R.t = this.rankGap(R, rng) * rng.range(0.2, 1);
      cabs.forEach((c, i) => { c.rankR = R; c.slot = i; c.rv = 0; c.rWait = 0; });
      lane.rank = R;
      ranks.push(R);
    }
    return ranks;
  },
  rankGap(R, rng) { return R.big ? rng.range(35, 70) : rng.range(25, 50); },

  // where the cab in position i of the rank should stand: its slot, or closer back if a longer cab is in front
  rankTarget(R, i) {
    let t = R.slots[i].s;
    for (let k = i - 1; k >= 0; k--) {
      const a = R.occ[k];
      if (!a) continue;
      t = Math.min(t, this.rankTarget(R, k) - (a.l + R.occ[i].l) / 2 - 1.0);
      break;
    }
    return t;
  },

  stepRanks(step) {
    const rng = this.rng, o = _t4b;
    for (const R of this.ranks || []) {
      const n = R.slots.length, e = R.lane;
      // move up into a place the cab in front has left (a wave: each starts a moment after the one ahead)
      for (let i = 1; i < n; i++) {
        const c = R.occ[i];
        if (!c || R.occ[i - 1] || (R.joining && R.joining.join && R.joining.join.i === i - 1)) continue;
        R.occ[i - 1] = c; R.occ[i] = null; c.slot = i - 1;
        c.rWait = (R.occ[i - 2] && R.occ[i - 2].rv > 0 ? 0.8 : 0.3) + rng.range(0, 0.6);
      }
      let aheadS = 1e9, aheadL = 0;
      for (let i = 0; i < n; i++) {
        const c = R.occ[i];
        if (!c) continue;
        const tgt = this.rankTarget(R, i);
        const lim = Math.min(tgt, aheadS - (aheadL + c.l) / 2 - 0.9);
        if (c.rWait > 0) c.rWait -= step;
        else if (lim - c.rs > 0.03) {
          // roll up at a walking pace: accelerate gently, and brake to arrive exactly
          const d = lim - c.rs;
          c.rv = Math.min(c.rv + 1.2 * step, 2.4, Math.sqrt(2 * 1.5 * d));
          const ds = Math.min(d, c.rv * step);
          c.rs += ds;
          c.spin -= ds / Math.max(0.05, c.T.P.wheelR);
        } else c.rv = 0;
        c.speed = c.rv;
        c.brake = c.rv > 0.05 ? 0 : 1;
        if (c.rv > 0 || c.rs !== c.rsPosed) {
          sampleEdge(e, c.rs, o);
          const l = leftOf(o[2]);
          c.x = o[0] + l[0] * c.roff; c.z = o[1] + l[1] * c.roff; c.yaw = o[2] + c.ryaw; c.rsPosed = c.rs;
        }
        aheadS = c.rs; aheadL = c.l;
      }
      // the head cab takes a fare and pulls out
      R.t -= step;
      const head = R.occ[0];
      if (R.t <= 0 && head && head.rv === 0 && head.rWait <= 0 && occN(R.occ) >= (R.slots.length <= 5 ? R.slots.length : Math.ceil(R.slots.length * 0.6))) {
        if (this.rankPullOut(R, head)) { R.occ[0] = null; R.t = this.rankGap(R, rng); } else R.t = 0.4;
      }
    }
  },

  // pull the rank's head cab out into its lane if the lane is clear behind and beside it
  rankPullOut(R, c) {
    const e = R.lane;
    for (const o of e.cars) {
      const rel = o.s - c.rs;
      if (rel < 9 + (o.l + c.l) / 2 && rel > -(o.speed * 3.5 + 10 + (o.l + c.l) / 2)) return false;
    }
    if (c.rs < 30) for (const P of e.prev) if (P.cars.length) return false;
    c.parked = false; c.rankR = null; c.slot = -1; c.vacant = false; c.rank = false;
    c.s = c.rs; c.speed = 0; c.acc = 0; c.go = 0; c.lat = 0; c.latNow = c.roff; c.latV = 0; c.rx = undefined;
    c.plan.length = 0; c.held.length = 0; c.sigGo = null; c.stuck = 0; c.pedWait = 0; c.nudgeM = null; c.jamT = 0; c.yWait = 0;
    c.gate = null; c.hitHold = 0; c.indL = 0; c.indR = 1; c.pullT = 4.5; c.join = null; c.joinSeen = e;
    this.insertCar(c, e);
    this.ensurePlan(c);
    c.keepLat = true; this.poseCar(c, 0); c.keepLat = false;
    return true;
  },

  // an empty cab that can reach a rank short of cabs is sent there (choose() steers it along the shortest way)
  sendToRank(c, e, replan = true) {
    for (const R of this.ranks || []) {
      const free = R.slots.length - occN(R.occ) - (R.joining ? 1 : 0) - R.incoming;
      if (free > 0 && R.dist.has(e) && e !== R.lane) {
        c.goRank = R; R.incoming++;
        if (replan && c.e === e) { c.plan.length = 0; this.ensurePlan(c); }
        return;
      }
    }
  },
  // an empty cab rolling along a rank's lane decides once whether to join it (there must be a free slot at the back)
  rankJoin(c, E) {
    c.joinSeen = E;
    const R = E.rank;
    const sent = c.goRank === R;
    if (sent) { c.goRank = null; R.incoming = Math.max(0, R.incoming - 1); }
    if (R.joining || (!sent && this.rng() > 0.8)) return;
    let last = -1;
    for (let i = 0; i < R.slots.length; i++) if (R.occ[i]) last = i;
    const i = last + 1;
    if (i >= R.slots.length || R.slots[i].s - c.s < 22) return;
    c.join = { R, i };
    R.joining = c;
  },
  // where a joining cab stops: its slot, or further back if the cab in front of it is longer than the slot allowed
  joinTarget(c) {
    const R = c.join.R, i = c.join.i;
    let t = R.slots[i].s;
    for (let k = i - 1; k >= 0; k--) { const a = R.occ[k]; if (a) { t = Math.min(t, a.rs - (a.l + c.l) / 2 - 1.0); break; } }
    return t;
  },
  parkInRank(c) {
    const R = c.join.R, i = c.join.i;
    this.removeCar(c);
    for (const h of c.held) zDrop(h.Z, h.side, c);
    c.held.length = 0; c.plan.length = 0; c.gate = null;
    c.parked = true; c.rank = true; c.vacant = true; c.speed = 0; c.acc = 0; c.stopLat = 0; c.easeLat = false;
    c.indL = 0; c.indR = 0; c.brake = 1;
    const o = _t4b;
    sampleEdge(R.lane, c.s, o);
    const l = leftOf(o[2]);
    c.rs = c.s; c.roff = (c.x - o[0]) * l[0] + (c.z - o[1]) * l[1]; c.ryaw = wrapA(c.yaw - o[2]); c.rsPosed = c.rs;
    c.rv = 0; c.rWait = 0;
    c.rankR = R; c.slot = i; R.occ[i] = c; R.joining = null; c.join = null;
  },

  // ------------------------------------------------------------------------------------------ drop-offs
  // the drop is off: the spot is free again for the next cab with a fare
  dropRelease(c) {
    const st = c.dropFor;
    if (st && st.busy === c) st.busy = null;
    if (c.willDrop) c.stopLat = 0;
    c.dropFor = null; c.willDrop = false; c.doorK = 0; c.dropT = 0; c.easeLat = false;
  },
  // the cab stands at the kerb, clear of the lane (the spot's lateral leaves a bus 0.4 m to pass it): off the lane's list
  kerbCab(c) {
    this.removeCar(c);
    for (const h of c.held) zDrop(h.Z, h.side, c);
    c.held.length = 0; c.gate = null;
    c.kerbed = c.dropFor; c.speed = 0; c.acc = 0; c.go = 0; c.brake = 1; c.dropT = Math.max(c.dropT, 0); c.easeLat = false;
    // settle square to the kerb (the last few centimetres / degrees of the S), so the lane beside it is clear
    c.latNow = c.lat + c.stopLat; c.latV = 0; c.rx = undefined; c.keepLat = true; this.poseCar(c, 0); c.keepLat = false;
  },
  // hazards, the kerb-side rear door open ~4 s, then 空車 and back out on the right indicator once the lane has a gap
  // behind it (whatever is on the lane or coming out of the junction onto it gives it 4 s)
  stepDrops(step) {
    for (const st of this.drops) {
      const c = st.busy;
      if (!c || c.kerbed !== st) continue;
      const tt = c.dropT += step;
      c.indL = 1; c.indR = 1; c.brake = 1; c.speed = 0;
      c.doorK = tt < 1.4 ? smooth01((tt - 0.9) / 0.5) : tt < 5.2 ? 1 : 1 - smooth01((tt - 5.2) / 0.6);
      if (tt < 6.2) continue;
      c.doorK = 0; c.vacant = true;
      const e = st.e;
      let clear = true;
      for (const o of e.cars) {
        const rel = o.s - c.s, len = (o.l + c.l) / 2;
        if (rel < 8 + len && rel > -(o.speed * 4 + 6 + len)) { clear = false; break; }
      }
      if (clear) for (const P of e.prev) for (const o of P.cars) if ((P.len - o.s) + c.s - (o.l + c.l) / 2 < o.speed * 4 + 6) clear = false;
      if (!clear) continue;
      c.kerbed = null; st.busy = null; c.dropped = st; c.dropFor = null; c.willDrop = false;
      c.stopLat = 0; c.pullT = 3; c.indL = 0; c.indR = 1; c.go = 0; c.pedWait = 0; c.jamT = 0; c.stuck = 0;
      this.insertCar(c, e);
    }
  },

  // ------------------------------------------------------------------------------------------ visibility
  // a despawn or respawn may only happen where the camera cannot see it
  seen(x, z, far = 1e9) {
    if (!this._visOK) return false;
    const cam = this.engine.camera.position;
    const d = Math.hypot(x - cam.x, z - cam.z);
    if (d < 25) return true;
    if (d > Math.min(320, far)) return false;
    _sph.center.set(x, groundY(x, z) + 1.5, z); _sph.radius = 6;
    return _frustum.intersectsSphere(_sph);
  },

  despawn(c) {
    this.removeCar(c);
    if (c.join) { c.join.R.joining = null; c.join = null; }
    if (c.goRank) { c.goRank.incoming = Math.max(0, c.goRank.incoming - 1); c.goRank = null; }
    c.stopLat = 0; c.pullT = 0; c.stopFor = null; c.served = null; c.joinSeen = null;
    for (const h of c.held) zDrop(h.Z, h.side, c);
    c.held.length = 0; c.plan.length = 0;
    c.hidden = true; c.speed = 0; c.x = 1e5; c.z = 1e5;
    if (c.dropFor && c.dropFor.busy === c) c.dropFor.busy = null;
    c.dropFor = null; c.dropped = null; c.willDrop = false; c.doorK = 0; c.kerbed = null; c.fLat = undefined; c.fE = null; c.fLead = null;
    if (c.eDepot && this.eDepot) { c.eRoute = null; c.eServed = false; this.eDepot.push(c); } else this.pool.push(c);
  },

  // Each source lane lets vehicles in at its own rate (SRC_RATE): a token accumulates, and a vehicle from the pool
  // enters once there is a token, room at the lane start and nobody looking. Demand is set per road from what the
  // junctions downstream can pass, so no queue grows from one cycle to the next.
  respawn(dt) {
    const src = this.sources, tok = this.srcTok;
    if (!src.length) return;
    for (let i = 0; i < src.length; i++) tok[i] = Math.min(1.6, tok[i] + this.srcRate[i] * dt);
    if (!this.pool.length) return;
    const n = src.length;
    let made = 0;
    for (let k = 0; k < n && this.pool.length && made < 3; k++) {
      const i = (this._srcI = ((this._srcI || 0) + 1) % n);
      if (tok[i] < 1) continue;
      const e = src[i];
      const first = e.cars[0];
      if (first && first.s - first.l / 2 < 13) continue;
      if (e.zones.some((zr) => zr.Z.lo[zr.side] < 12 && zr.Z.hold[1 - zr.side] > 0)) continue;
      const p = e.pts[0];
      if (this.seen(p[0], p[1], e.n0.kind === 'edge' ? EDGE_FAR : 1e9)) continue;
      let pi = -1;
      for (let j = 0; j < Math.min(6, this.pool.length); j++) {
        const c = this.pool[j];
        if (c.big && (e.narrow || e.width < 12)) continue;
        if (c.l > e.okL + 0.05) continue;
        pi = j; break;
      }
      if (pi < 0) continue;
      const c = this.pool.splice(pi, 1)[0];
      tok[i] -= 1; made++;
      const s = c.l / 2 + 0.3;
      const room = (first ? first.s - first.l / 2 - 3 : e.len - 1) - (s + c.l / 2);
      c.hidden = false; c.s = s; c.speed = Math.min(e.vmax * c.vf, 9, Math.sqrt(2 * 2.2 * Math.max(0, room)));
      c.plan.length = 0; c.sigGo = null; c.stuck = 0; c.hitHold = 0; c.pedWait = 0; c.nudgeM = null; c.jamT = 0; c.yWait = 0; c.gate = null; c.acc = 0;
      if (c.T.taxi) c.vacant = this.rng() < 0.58;
      c.goRank = null;
      if (c.T.taxi && c.vacant) this.sendToRank(c, e, false);
      this.insertCar(c, e);
      this.ensurePlan(c);
      this.poseCar(c, 0);
      if (c.mover) { c.mover.cx = c.x; c.mover.cz = c.z; c.mover.vx = 0; c.mover.vz = 0; }
    }
  },

  // ------------------------------------------------------------------------------------------ zones
  // Try to take zone Z for car c (side = which of its two paths c is on). A side may only enter while the other
  // side is empty; a yielding movement also waits while anything on the priority side is closing on the zone.
  // A driver who has given way for YIELD_WAIT s stops waiting for a gap in the stream and takes the next moment the
  // zone is actually empty; whoever is still coming on the main road meets a held zone and slows for them.
  acquire(c, Z, side, rel) {
    const other = 1 - side;
    if (zBlocks(Z, side, c)) return false;
    if (Z.yield[side] && c.yWait < YIELD_WAIT && this.closing(Z, other, 4.0)) return false;
    // somebody has stood at their junction gate for this patch of road for 3 s (a bus on 109's inner lane whose
    // turn sweeps the kerb lane): the stream leaves them the next gap instead of taking the zone car after car
    const now = this.simT || 0;
    if (!Z.yield[other] && Z.wT[other] > now - 0.25 && now - Z.w0[other] > 3) return false;
    zTake(Z, side, c);
    c.held.push({ Z, side, rel });
    return true;
  },
  // Is anything on the priority side about to arrive? A vehicle standing still (queued, or waiting on something
  // else) is not: counting it starved the side road for as long as the main road's queue stood there.
  closing(Z, side, T) {
    const e = Z.e[side], lo = Z.lo[side], hi = Z.hi[side];
    for (const o of e.cars) {
      if (o.s - o.l / 2 > hi) continue;
      if (o.speed < 0.5 && o.aDes < 0.5) continue;
      if (o.s + o.l / 2 >= lo - (o.speed * T + 3)) return true;
    }
    for (const p of e.prev) {
      for (const o of p.cars) {
        if (o.plan[0] !== e || (o.speed < 0.5 && o.aDes < 0.5)) continue;
        if ((p.len - o.s - o.l / 2) + lo <= o.speed * T + 3) return true;
      }
    }
    return false;
  },
  gateIn(c, cn, dStart) {
    const zs = cn.gz, now = this.simT || 0;
    let ok = true;
    for (let i = 0; i < zs.length; i++) {
      const zr = zs[i], Z = zr.Z, me = zr.side;
      if (this.holds(c, Z)) continue;
      const o = 1 - me;
      // Turn-taking between two streams that share a zone in the same phase: whoever has waited longest goes next.
      // A wait counts only while it is being renewed every frame.
      const wo = Z.wT[o] > now - 0.25 ? Z.w0[o] : 0, wm = Z.wT[me] > now - 0.25 ? Z.w0[me] : 0;
      // (and past 3 s the same goes for any zone the other side does not have to give way on: a gate that a stream
      //  keeps taking the zone from — 109's inner-lane bus against the kerb lane — gets the next gap)
      const blocked = zBlocks(Z, me, c) || (Z.yield[me] && c.yWait < YIELD_WAIT && this.closing(Z, o, 3.0))
        || (wo && (Z.fair ? now - wo > 2.5 : !Z.yield[o] && now - wo > 3) && (!wm || wo < wm || (wo === wm && o < me)));
      if (blocked) {
        // (a driver who is also held by somebody in the road could not take the turn anyway: no claim on it)
        if (c.why !== 'person') {
          if (!(Z.wT[me] > now - 0.25)) Z.w0[me] = now;
          Z.wT[me] = now;
        }
        ok = false;
      }
    }
    if (!ok) return false;
    for (let i = 0; i < zs.length; i++) Z0(zs[i].Z, zs[i].side);
    for (let i = 0; i < zs.length; i++) {
      const zr = zs[i], Z = zr.Z;
      if (this.holds(c, Z)) continue;
      zTake(Z, zr.side, c);
      c.held.push({ Z, side: zr.side, rel: c.odo + dStart + zr.off + Z.hi[zr.side] + c.l / 2, gate: cn });
    }
    c.gate = cn;
    return true;
  },
  ungate(c, cn) {
    for (let i = c.held.length - 1; i >= 0; i--) {
      const h = c.held[i];
      if (h.gate === cn) { zDrop(h.Z, h.side, c); c.held.splice(i, 1); }
    }
    c.gate = null;
  },
  holds(c, Z) {
    for (let i = 0; i < c.held.length; i++) if (c.held[i].Z === Z) return true;
    return false;
  },

  // ------------------------------------------------------------------------------------------ driving
  drive(step, t = 0) {
    if (!this.edges) return;
    this.simT = (this.simT || 0) + step;
    this.stepSignals(step);
    const edges = this.edges;
    // 1. decide: every car picks the speed it wants from the car ahead, the signal, the zones on its path,
    //    the turns coming up, and anybody standing in the road
    for (let n = 0; n < edges.length; n++) {
      const E = edges[n], list = E.cars;
      for (let i = list.length - 1; i >= 0; i--) this.think(list[i], E, list[i + 1] || null, step, t);
    }
    // 2. move
    const fr = this._frame = (this._frame || 0) + 1;
    for (let n = 0; n < edges.length; n++) {
      const list = edges[n].cars;
      for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        if (!c || c._mv === fr) continue;
        c._mv = fr;
        this.move(c, step);
      }
    }
    this.stepRanks(step);
    this.stepDrops(step);
    // 3. hand back zones whose holder's tail has cleared them, and bring despawned cars back where nobody looks
    for (const c of this.cars) {
      if (!c.held.length) continue;
      for (let i = c.held.length - 1; i >= 0; i--) {
        const h = c.held[i];
        if (c.odo >= h.rel) { zDrop(h.Z, h.side, c); c.held.splice(i, 1); }
      }
    }
    this._rsT = (this._rsT || 0) + step;
    if (this._rsT > 0.2) { this.respawn(this._rsT); this._rsT = 0; }
    this.stepEast(step);
  },

  think(c, E, lead, step, t) {
    const v = c.speed, half = c.l * 0.5, K = _K;
    K.d = 1e9; K.why = null; K.o = null; K.dS = 1e9; K.rL = 0; K.gap = 1e9;
    if (c.T.wheels === 2 && E.kind === 'lane') {
      const ld = c.fLead;
      if (ld) {
        const list = E.cars;
        if (ld.e !== E || ld.speed > 0.5 || this.sigState(E) !== 'red') { c.fLead = null; c.fLat = undefined; c.fE = null; }
        else if (lead === ld && list[list.length - 1] === ld && c.latNow - ld.latNow >= ld.w / 2 + 0.45) {
          // clear of it sideways: from here on the scooter is the front of the lane
          list.splice(list.indexOf(c), 1); list.push(c);
          c.fLead = null; lead = null;
        }
      } else if (lead && v < 0.3 && E.sig && E.sig.node.ctrl && E.sig.node.ctrl.scramble) this.tryFilter(c, E, lead);
    }
    // (a) the car ahead on this edge, or the last car on the path beyond it
    let leadAt = 1e9;                      // path distance (from c's centre) to the leader's centre
    if (lead) { leadAt = lead.s - c.s; limL(c, v, leadAt - (lead.l + c.l) / 2, lead.speed, 'lead', lead); }
    const horizon = 30 + (v * v) / (2 * B_STOP) + c.l;
    if (!lead) {
      let acc = E.len - c.s;
      for (let k = 0; k < c.plan.length && acc < horizon + 40; k++) {
        const P = c.plan[k];
        if (P.cars.length) {
          const o = P.cars[0];
          leadAt = acc + o.s;
          limL(c, v, leadAt - (o.l + c.l) / 2, o.speed, 'ahead', o);
          break;
        }
        acc += P.len;
      }
    }
    // (a2) single file through a split (whoever went first down the other branch is still in front), and the
    //      zip at a merge (whoever is nearer the merge point goes first)
    const cn1 = E.kind === 'conn' ? E : c.plan[0] && c.plan[0].kind === 'conn' ? c.plan[0] : null;
    if (cn1 && (cn1.sibs || cn1.zips)) {
      const base = cn1 === E ? 0 : E.len;
      if (cn1.sibs) for (const sb of cn1.sibs) for (const o of sb.e.cars) {
        if (o.s - o.l / 2 > sb.upto) continue;
        const at = base + o.s - c.s;
        if (at < 0 || (at === 0 && o.id > c.id)) continue;
        if (at < leadAt) { leadAt = at; limL(c, v, at - (o.l + c.l) / 2, o.speed, 'split', o); }
      }
      if (cn1.zips) {
        // order by the front bumpers: a bus standing in the box with its nose already in the merge is ahead of a
        // car whose centre happens to be nearer the merge point
        const dc = base + cn1.len - c.s, fm = dc - half;
        for (const zp of cn1.zips) for (const o of zp.e.cars) {
          if (o.s + o.l / 2 < zp.from) continue;
          const fo = zp.e.len - o.s - o.l / 2;
          if (fo > fm || (fo === fm && o.id > c.id)) continue;
          const at = dc - (zp.e.len - o.s);
          if (at < leadAt) { leadAt = at; limL(c, v, at - (o.l + c.l) / 2, o.speed, 'zip', o); }
        }
      }
    }
    const toEnd = E.len - c.s - half;          // nose to the end of this edge
    // (b) signal at the end of this lane. Amber: stop if you comfortably can, otherwise go and keep going. A car
    //     that decided to go but was then held short (a queue, a zone) loses that decision and waits for green.
    if (c.sigGo === E && v < 1) c.sigGo = null;
    if (E.sig && c.sigGo !== E && (toEnd > -0.2 || v < 1.5) && toEnd < 120) {
      const st = this.sigState(E);
      if (st === 'red') limS(toEnd - 0.3, 'red', E);
      else if (st === 'amber') {
        if (toEnd > (v * v) / (2 * 4.5) + 0.3) limS(toEnd - 0.3, 'amber', E);
        else if (v > 2) c.sigGo = E;
        else limS(toEnd - 0.3, 'amber', E);
      } else if (toEnd < 3 && v > 1) c.sigGo = E;
    }
    // (b') a junction marked lookThrough (the 東口 terminal's exit T) stands only a few metres short of the next light
    //      (宮益坂下): a car crossing it reads that light from before the T, so it never meets the red in a 5 m lane
    {
      let SL = null, dS = 0;
      const p0 = c.plan[0], p1 = c.plan[1];
      if (E.kind === 'lane' && p0 && p0.kind === 'conn' && p0.node && p0.node.cfg && p0.node.cfg.lookThrough && p1 && p1.sig) { SL = p1; dS = toEnd + p0.len + p1.len; }
      else if (E.kind === 'conn' && E.node && E.node.cfg && E.node.cfg.lookThrough && p0 && p0.sig) { SL = p0; dS = toEnd + p0.len; }
      if (SL && SL.len < 14 && c.sigGo !== SL && dS < 120) {
        const st = this.sigState(SL);
        if (st === 'red') limS(dS - 0.3, 'red', SL);
        else if (st === 'amber') {
          if (dS > (v * v) / (2 * 4.5) + 0.3) limS(dS - 0.3, 'amber', SL);
          else if (v > 2) c.sigGo = SL;
          else limS(dS - 0.3, 'amber', SL);
        }
      }
    }
    // (c) do not enter a junction without room to leave it
    const cn = c.plan[0];
    const committed = c.gate === cn && toEnd < (v * v) / (2 * 4.5) + 1;     // gated and past the point of stopping
    if (E.kind === 'lane' && cn && cn.kind === 'conn' && toEnd < 40 && !committed) {
      // (an exit shorter than the vehicle — 11 m between two junctions — only has to be empty)
      const strict = !!(E.sig && E.sig.node.ctrl && E.sig.node.ctrl.scramble && (this.signal.remaining < 7 || this.sigState(E) !== 'green'));
      if (this.roomOn(cn.to, c, strict) < Math.min(c.l + 2.5, cn.to.len - 1)) limS(toEnd - 0.3, 'room', cn.to);
    }
    // (c2) the junction gate: every conflict zone of the turn path is taken at once, before the stop line, by the
    //      first car in the lane. Nobody ever waits inside a junction for somebody else's zone, so it cannot lock up.
    const commit = (v * v) / (2 * B_STOP) + 6;
    if (E.kind === 'lane' && cn && cn.kind === 'conn') {
      const held = K.why === 'red' || K.why === 'amber' || K.why === 'room';
      if (c.gate === cn) { if (held && (toEnd > (v * v) / (2 * 5.5) + 0.3 || (v < 1.5 && toEnd > -0.2))) this.ungate(c, cn); }
      else if (!held && !lead && toEnd < commit + 2 && cn.gz.length) {
        if (!this.gateIn(c, cn, E.len - c.s)) limS(toEnd - 0.3, 'gate', cn);
      } else if (!cn.gz.length && !held) c.gate = cn;
    }
    // (d) end of the road. At the edge of the map a car simply drives on out of it; at a dead end in the middle of
    //     town it pulls up and vanishes only once nobody can see it.
    //     (Braking to a stop at an unseen map edge made every edge a bottleneck: a 24 m exit filled with cars
    //     queueing to vanish, and 玉川通り backed up behind it.)
    if (!c.plan.length && E.next.length === 0 && toEnd < 60) {
      const p = E.pts[E.pts.length - 1];
      const out = E.n1.kind === 'edge' || E.farDead;
      const hide = !this.seen(p[0], p[1], out ? EDGE_FAR : 1e9);
      if (!(out && hide)) limS(toEnd - 0.3, 'end', E);
      if (toEnd < 2.5 && hide) c._despawn = true;
    }
    // (e) conflict zones along the lanes of the path (turn paths are gated above), but only until the car ahead
    let base = 0;
    for (let k = -1; k < c.plan.length; k++) {
      const P = k < 0 ? E : c.plan[k];
      if (k >= 0 && base - c.s > horizon) break;
      if (P.kind === 'conn' && P !== E) { base += P.len; continue; }
      const zs = P.zones;
      const gated = P.kind === 'lane' && P.prev.length > 0;
      for (let j = 0; j < zs.length; j++) {
        const zr = zs[j], Z = zr.Z;
        if (gated && Z.lo[zr.side] < GATE_TAIL) continue;
        const lo = base + Z.lo[zr.side], hi = base + Z.hi[zr.side];
        if (hi < c.s - half) continue;
        if (lo > leadAt + c.s - 0.1) { k = 1e9; break; }     // the leader is between us and this zone
        const dz = lo - (c.s + half);
        if (dz > commit) { k = 1e9; break; }
        if (this.holds(c, Z)) continue;
        if (!this.acquire(c, Z, zr.side, c.odo + (hi - c.s) + half)) {
          if (dz < -0.5) {                    // already inside: never freeze in the middle of somebody's path
            zTake(Z, zr.side, c); c.held.push({ Z, side: zr.side, rel: c.odo + (hi - c.s) + half });
            this.zoneForced = (this.zoneForced || 0) + 1;
            this._forced = `${c.key}#${c.id} on ${E.kind}${E.id} zone ${Z.id} (${Z.e[0].kind}${Z.e[0].id}/${Z.e[1].kind}${Z.e[1].id}) held by side ${1 - zr.side}`;
          } else { limS(dz - 0.2, 'zone', Z); k = 1e9; break; }
        }
      }
      if (k >= 1e9) break;
      base += P.len;
    }
    // (f) the turn ahead. The road speed is capped by the curvature under the body; every tighter sample ahead asks
    //     for the deceleration that meets its speed exactly there, and the car brakes by (that)²/B_CURVE, which is
    //     gentle while the bend is far and converges on B_CURVE as it closes, arriving at the corner speed.
    let v0 = c.vf * (E.vmax || 11), bk = 0;
    {
      let P = E, off = 0, k = -1, n = 0;
      const cum = E.cum, from = c.s - half;
      let a = 0, b = cum.length - 1;
      while (a < b) { const m = (a + b) >> 1; if (cum[m] < from) a = m + 1; else b = m; }
      let i = a;
      const v2 = v * v;
      while (n++ < 180) {
        if (i >= P.cum.length) {
          off += P.len; k++;
          if (k >= c.plan.length) break;
          P = c.plan[k]; i = 0; continue;
        }
        const d = off + P.cum[i] - c.s;
        if (d > 55) break;
        const vk = P.vk[i];
        if (d < half + 0.5) { if (vk < v0) v0 = vk; }
        else if (vk < v) { const need = (v2 - vk * vk) / (2 * (d - half)); if (need > bk) bk = need; }
        i += P.kind === 'conn' ? 1 : 3;
      }
    }
    // (b2) a signalled zebra part-way along this lane: red and amber as at a junction, and no rolling onto the
    //      stripes unless the whole car will be clear of them beyond
    if (E.xings) {
      const xs = this.xingState();
      for (const xg of E.xings) {
        const d = xg.s - (c.s + half);
        if (d < -0.2) continue;
        if (d > 90) break;
        if (xs.veh === 'red' || (xs.veh === 'amber' && d > (v * v) / (2 * 4.5) + 0.3)) limS(d - 0.3, 'red', xg.X);
        else if (lead && lead.speed < 2 && lead.s - lead.l / 2 < xg.s + xg.X.width + 1.5 + c.l && d < 25) limS(d - 0.3, 'room', xg.X);
        break;
      }
    }
    // (h) the kerb: an empty cab may join the rank this lane runs past; a bus serves the stops on its lane,
    //     pulling over toward the kerb on the way in
    if (E.kind === 'lane') {
      if (E.rank && c.T.taxi && c.vacant && c.joinSeen !== E && !c.join) this.rankJoin(c, E);
      if (c.join) {
        const sl = c.join.R.slots[c.join.i], d = this.joinTarget(c) - c.s;
        if (c.e !== c.join.R.lane || d < -1.5) { c.join.R.joining = null; c.join = null; c.stopLat = 0; c.easeLat = false; }
        else {
          // (slowing as it pulls over: a 5 m S onto 道玄坂's kerb at 40 km/h was a 9 m/s² swerve)
          limS(d, 'rank', c.join.R);
          c.stopLat = d < 50 ? sl.off - c.lat : 0;
          const cap = 2.5 + 0.12 * Math.max(0, d);
          if (v0 > cap) v0 = cap;
          c.easeLat = d < 1.2 && v < 0.4;
          if (d < 0.8 && v < 0.3 && Math.abs(c.latNow - sl.off) < 0.4) c._park = true;
        }
      }
      if (c.kind === 'bus' && E.stops) {
        for (const st of E.stops) {
          const d = st.s - (c.s + half);
          if (d < -2 || c.served === st) continue;
          if (st.only) {
            // a terminal のりば: a bus that found its own way into the terminal takes one of its 系統 on the way in,
            // and every bus passes the のりば of the other 系統 by
            if (!c.eRoute) this.applyEastRoute(c, this.pickEastRoute());
            if (!c.eRoute || c.eRoute.stop !== st.id) continue;
          }
          if (c.stopFor !== st) {
            c.stopFor = st;
            if (st.only) { c.willStop = true; c.dwell = this.rng.range(24, 42); c.eDoorT = 0; }
            else { c.willStop = this.rng() < 0.85; c.dwell = this.rng.range(9, 18); }
          }
          if (!c.willStop) break;
          limS(Math.max(0, d), 'busstop', st);
          c.stopLat = d < 38 ? st.lat : 0;
          if (d < 0.9 && v < 0.2) {
            c.dwell -= step;
            // the middle door opens once she stands, and shuts again a second before she pulls out
            if (st.doors) { c.eDoorT += step; c.doorK = clamp(Math.min((c.eDoorT - 0.6) * 1.4, c.dwell * 1.1), 0, 1); }
            if (c.dwell <= 0) { c.served = st; c.stopLat = 0; c.pullT = 3; c.doorK = 0; c.eDoorT = 0; if (st.only) c.eServed = true; }
          }
          break;
        }
      }
    }
    // (h2) a cab with a fare aboard drops it at the ハチ公 kerb (DROPS). It decides while the spot is still far enough
    //      ahead to slow down gently, steers over to the kerb once it is on the spot's lane, and when it stands there it
    //      leaves the lane: the traffic behind drives on past it (nobody ever queues behind a drop, and the spot takes
    //      one cab at a time). stepDrops runs the door and brings it back out into a gap.
    if (c.T.taxi && this.drops.length) {
      let st = null, dA = E.len - c.s;
      if (E.drops) { st = E.drops[0]; dA = -c.s; }
      else for (let k = 0; k < 2 && k < c.plan.length; k++) { const P = c.plan[k]; if (P.drops) { st = P.drops[0]; break; } dA += P.len; }
      if (c.dropFor && c.dropFor !== st) this.dropRelease(c);
      if (st && c.dropped !== st) {
        const d = dA + st.s - half;              // front bumper to the spot
        if (c.dropFor !== st && d < 70) {
          // (only off a straight run in: a cab that turns into the lane has no room left to steer over)
          let inc = E.kind === 'conn' && E.to === st.e ? E : null;
          for (let k = 0; !inc && k + 1 < c.plan.length && k < 2; k++) if (c.plan[k + 1] === st.e) inc = c.plan[k];
          c.dropFor = st; c.dropT = 0;
          c.willDrop = !c.vacant && !st.busy && !!inc && (st.pre.get(inc) || 0) >= 10 && d > (v * v) / 3.2 + 4 && this.rng() < 0.6;
          if (c.willDrop) st.busy = c;
        }
        if (c.willDrop) {
          // (not over at the kerb yet: it creeps on a little further, steering in, rather than stopping half in the lane)
          //  and it comes in slowly enough to make the S on the lane: a cab pulling over, not one changing lanes)
          const creep = E === st.e && Math.abs(c.latNow - st.lat) > 0.1 ? clamp(st.e.len - 0.6 - st.s, 0, 3) : 0;
          if (E === st.e && d < -3.8) this.dropRelease(c);
          else {
            limS(Math.max(0, d + creep), 'drop', st);
            const cap = 3.2 + 0.12 * Math.max(0, d);
            if (d < 30 && v0 > cap) v0 = cap;
            if (E === st.e || E.len - c.s < (st.pre.get(E) || 0)) c.stopLat = st.lat - c.lat;
            // (the last few centimetres at a standstill, once it has crept as far as the lane allows)
            c.easeLat = E === st.e && d + creep < 0.6;
            if (E === st.e && d < 0.9 && v < 0.2 && !creep) c._kerb = true;
          }
        }
      }
    }
    // (f2) standing in a zone that a turning vehicle is passing clear of: stay put until it has gone by
    if (c.byp) {
      const B = c.byp;
      if (B.Z.hold[1 - B.side] > 0 && zBlocks(B.Z, B.side, c)) limS(0, 'yield', B.Z);
      else c.byp = null;
    }
    // (g) somebody standing in the road, and the driver who has just hit somebody. 健人 and the men he fights are
    //     waited for however long it takes. A member of the crowd who is still in the way after PED_WAIT s, while
    //     nothing else holds the car, is a straggler stranded on the carriageway (they wait for the car, the car
    //     waits for them, and a whole arm used to freeze behind that loop): the driver sounds the horn and noses
    //     through at walking pace, and the crowd's push-out steps them aside.
    const dP = this.peopleAhead(c);
    const dC = this._crowd && !c.parked ? this.crowdAhead(c, this._crowd) : 1e9;
    // (g2) a fight's arena (crowd.arena {x, z, r}): a car outside it stops short of it; one already inside it when the
    //      fight began drives out (crowd.js 2026-09-28)
    const arn = this._crowd && this._crowd.arena;
    if (arn && !c.parked) {
      const dc = Math.hypot(c.x - arn.x, c.z - arn.z);
      if (dc > arn.r + 1.5 && dc < arn.r + 32) {
        const o = _t4b, s0 = c.s + c.l * 0.5, hw = c.w * 0.5 + 0.55;
        for (let k = 0; k <= 10; k++) {
          this.pathAt(c, s0 + k * 2, o);
          if (Math.hypot(o[0] - arn.x, o[1] - arn.z) < arn.r + 1.2) { limS(k ? c.l * 0.5 + k * 2 - hw - 1.2 : -0.5, 'arena', null); break; }
        }
      }
    }
    if (dP < 1e8) limS(dP - half - 1.2, 'person', null);
    let nudge = false, known = false;
    const nowS = this.simT || 0;
    if (dC < 1e8) {
      const m = c.pedM;
      // past the one this car was nosing round: the cars behind know them now and follow it round without re-queueing
      if (c.nudgeM && c.nudgeM !== m) { c.nudgeM.passed = nowS; c.nudgeM = null; }
      known = !!m && nowS - m.passed < 20;
      const dStopC = dC - half - 1.2;
      // somebody walking on ahead along the path is followed at their pace, like a slow car
      const walker = !c.pedStill && c.pedVal > 0.35;
      if ((walker ? v < 1.8 : v < 0.6) && K.d > dStopC + 0.5 && dP > 1e8) c.pedWait += step;
      else if ((v > 2.5 && c.pedWait <= PED_WAIT) || K.d <= dStopC) c.pedWait = 0;
      // (a fight's ring of onlookers is a wall: a car outside the arena waits for the fight to end instead of nosing
      //  through them -- one caught inside it when the fight started is let out. crowd.js 2026-09-28)
      const ar = this._crowd && this._crowd.arena, po = c.pedObj;
      const ring = !!(po && po.gawk && !po.gawk.release) && !(ar && Math.hypot(c.x - ar.x, c.z - ar.z) < ar.r + 1.5);
      if (ring) c.pedWait = 0;
      if (!ring && ((known && c.pedStill) || c.pedWait > (known ? PED_WAIT_KNOWN : c.pedStill ? PED_WAIT_STILL : PED_WAIT))) { nudge = true; if (m) c.nudgeM = m; }
      else if (walker) limL(c, v, dC - half - 0.4, c.pedVal, 'person', null);
      else limS(dStopC, 'person', null);
    } else {
      if (c.nudgeM) { c.nudgeM.passed = nowS; c.nudgeM = null; }
      if (c.pedWait > 0) c.pedWait = Math.max(0, c.pedWait - step * 2);
    }
    // (the crawl is only for the last few metres: somebody 15 m up the road is passed at a slow roll, not at 4 km/h;
    //  and a straggler who stands there is gone round at a walk, not inched past)
    //  (at up to twice that when they stand off to one side of its path rather than square in front of the bonnet)
    if (nudge) {
      const vp = NUDGE_PASS * (1 + clamp((Math.abs(c.pedLat || 0) - 0.4) / 0.8, 0, 1));
      const vn = Math.max(c.pedStill || known ? vp : NUDGE_V, Math.sqrt(2 * 1.2 * Math.max(0, dC - half - 2)));
      if (v0 > vn) { v0 = vn; if (!K.why) K.why = 'nudge'; }
    }
    // …edging round somebody who is standing still rather than pushing them up the road in front of the bumper
    // (never out of its own lane: a truck on 公園通り's 3 m lanes has 0.35 m to give, a car 0.55)
    if (nudge && c.pedStill && dC - half < 6 && !c.join && E.kind === 'lane') {
      const sd = c.pedLat > 0 ? -1 : 1, room = Math.max(0, (E.lw || 3.2) / 2 - c.w / 2 - 0.08 - sd * c.lat);
      c.dodge = sd * Math.min(0.75, room);
    }
    else if (c.dodge && (dC > 1e8 || v > 3)) c.dodge = 0;
    const ob = Math.min(dP, nudge ? 1e9 : dC);
    if (ob < 1e8 || nudge) {
      if (v < 0.6) {
        c.pedT += step;
        if (c.pedT > 2 && (this.hornT === undefined || t - this.hornT > 1.2)) {
          c.pedT = -6; this.hornT = t;
          this.engine.events.emit('traffic:horn', { x: c.x, z: c.z, kind: c.kind, position: { x: c.x, y: 1, z: c.z } });
        }
      }
    } else if (c.pedT > 0) c.pedT = 0;
    else if (c.pedT < 0) c.pedT = Math.min(0, c.pedT + step);
    if (c.hitHold > 0) { c.hitHold -= step; limS(0, 'hit', null); }
    // IDM: free-road term against v0, plus the strongest interaction (a leader, or a stop point treated as a
    // stationary obstacle), and the bend braking on top.
    const sq = 2 * Math.sqrt(c.a0 * c.bc);
    let rS = 0;
    if (K.dS < 1e8) {
      const s = K.dS + S0_STOP;
      const ss = S0_STOP + v * TH_STOP + (v * v) / sq;
      rS = s > 0.04 ? (ss / s) * (ss / s) : 400;
    }
    const q = v / Math.max(0.4, v0), q2 = q * q;
    let a = c.a0 * (1 - Math.min(9, q2 * q2) - Math.max(rS, K.rL));
    if (bk > 0.02) a = Math.min(a, -Math.min(4.5, (bk * bk) / B_CURVE));
    c.aDes = Math.max(-8.5, a);
    c.want = v0;
    c.why = K.why; c.whyO = K.o;
    if (v < 0.5 && (K.why === 'gate' || K.why === 'zone')) c.yWait += step; else if (v > 2) c.yWait = 0;
    // the head of a lane that has sat at the line because the exit it chose is full, or its gate never opens,
    // takes another way out that has room: nobody waits on a queue that is itself waiting on them
    if (E.kind === 'lane' && cn && cn.kind === 'conn' && !lead && v < 0.3 && toEnd < 6 && (K.why === 'room' || K.why === 'gate')) {
      c.jamT += step;
      if (c.jamT > REPICK_T) this.repick(c, E);
    } else c.jamT = 0;
    c.dStop = K.d;
    c.gapF = K.gap;
    // a real emergency (the stop point is inside a firm stop) is exempt from the jerk limit
    c.emerg = c.hitHold > 0 || (v > 0.5 && K.d < (v * v) / (2 * 3.8)) || K.gap < 0.6;
    // indicators: the connector we are on, or the one coming up
    let iL = 0, iR = 0;
    if (E.kind === 'conn' && E.turn && c.s < E.len * 0.8) { if (E.turn === 'L') iL = 1; else iR = 1; }
    else if (cn && cn.kind === 'conn' && cn.turn && toEnd < 32) { if (cn.turn === 'L') iL = 1; else iR = 1; }
    if (c.join && c.join.R.slots[c.join.i].s - c.s < 45) iL = 1;
    if (c.kind === 'bus' && c.willStop && c.stopFor && c.served !== c.stopFor && c.e.stops && c.e.stops.includes(c.stopFor) && c.stopFor.s - c.s < 50) iL = 1;
    if (c.willDrop && c.dropFor) iL = 1;
    if (c.pullT > 0) { c.pullT -= step; iR = 1; iL = 0; }
    c.indL = iL; c.indR = iR;
    // horn: still sitting there several seconds after the light went green
    const green = E.sig ? this.sigState(E) === 'green' : false;
    if (c.speed < 0.3 && green && toEnd < 30 && !lead) c.stuck += step; else { c.stuck = Math.min(c.stuck, 0); c.stuck -= step * 2; }
    if (c.stuck > 6.5) {
      c.stuck = -14;
      if (this.hornT === undefined || t - this.hornT > 2.5) {
        this.hornT = t;
        this.engine.events.emit('traffic:horn', { x: c.x, z: c.z, kind: c.kind, position: { x: c.x, y: 1, z: c.z } });
      }
    }
  },

  move(c, step) {
    let aT = c.aDes;
    // a queue moves off as a wave: each driver needs a moment to see the gap open (or the light change)
    if (c.speed < 0.2 && aT > 0.05) {
      c.go += step;
      if (c.go < c.rt) aT = 0;
    } else if (aT <= 0.05) c.go = 0;
    // jerk-limited: the throttle is fed in at 4 m/s³, the brake at 9 m/s³ and released at 12; a real emergency
    // stamps on it
    if (aT > c.acc) c.acc = Math.min(aT, c.acc + (c.acc < 0 ? 12 : 4) * step);
    else c.acc = Math.max(aT, c.acc - (c.emerg ? 60 : 9) * step);
    c.speed += c.acc * step;
    if (c.speed <= 0) { c.speed = 0; if (c.acc < 0) c.acc = 0; }
    c.accLP += (c.acc - c.accLP) * Math.min(1, step * 3.2);
    const ds = c.speed * step;
    c.s += ds; c.odo += ds;
    // brake lights: on at once, off only after 0.3 s without braking (no flicker in a crawling queue)
    if (c.acc < -0.75 || (c.speed < 0.25 && c.aDes < 0.3)) { c.brake = 1; c.brakeT = 0.3; }
    else if (c.brakeT > 0) c.brakeT -= step;
    else c.brake = 0;
    let E = c.e, guard = 0;
    while (c.s > E.len && guard++ < 4) {
      const nx = c.plan[0];
      if (!nx) { c.s = E.len; c.speed = 0; break; }
      c.plan.shift();
      c.s -= E.len;
      this.removeCar(c);
      this.insertCar(c, nx);
      E = nx; c.sigGo = null;
      if (!c.join) c.stopLat = 0;
      if (c.T.taxi && c.vacant && !c.goRank && nx.kind === 'lane') this.sendToRank(c, nx);
      this.ensurePlan(c);
    }
    if (c._despawn) { c._despawn = false; this.despawn(c); return; }
    if (c._park) { c._park = false; this.parkInRank(c); return; }
    if (c._kerb) { c._kerb = false; this.kerbCab(c); return; }
    this.poseCar(c, step);
    c.bob += step * (3.2 + c.speed * 0.8);
    c.spin -= (c.speed / Math.max(0.05, c.T.P.wheelR)) * step;
  },

  // ------------------------------------------------------------------------------------------ meshes
  buildMeshes(engine, rng) {
    const scene = engine.scene;
    const group = new THREE.Group(); group.name = 'traffic'; scene.add(group);
    this.group = group;
    this.mat = vehicleMaterial();
    const cars = this.cars;
    let meshes = 0;

    // --- bodies. The heavy instanced meshes are *compacted* every frame by writeMatrices(): the module
    //     does its own frustum + projected-size culling and only writes the survivors, so `count` (and the
    //     triangle bill, and the shadow-pass bill) tracks what is actually on screen.
    //     Per type: a near mesh that casts shadows, a mid mesh that does not; per impostor family one
    //     ~100-tri stand-in for everything past the LOD cut.
    this.bodies = {}; this.bodiesFar = {}; this._bodyList = [];
    const mkBody = (name, geo, n, shadow) => {
      const im = new THREE.InstancedMesh(geo, this.mat, Math.max(1, n));
      im.name = name;
      im.frustumCulled = false;
      im.castShadow = shadow;
      im.receiveShadow = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, _c.set(0xffffff));
      im.__slots = []; im.__n = 0; im.__cd = 0;
      group.add(im);
      this._bodyList.push(im);
      return im;
    };
    const byType = new Map();
    for (const c of cars) { if (!byType.has(c.key)) byType.set(c.key, []); byType.get(c.key).push(c); }
    // Two tiers per type share the instance budget: the near tier is the full body and casts the sun shadow,
    // the mid tier is a reduced loft (no mirrors, handles, shut lines, pillars) that is ~4x cheaper and is
    // indistinguishable past D_MID, where a car is under 60 px tall.
    const bill = [];
    for (const [key, list] of byType) {
      const geo = TYPES[key].build(TYPES[key].P, 0);
      const mid = TYPES[key].build(TYPES[key].P, 1);
      // taxis carry a per-instance 空車 flag: the windscreen vacancy sign is lit only on a vacant cab
      if (TYPES[key].taxi) for (const g of [geo, mid]) g.setAttribute('aSign', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, list.length)), 1));
      this.bodies[key] = mkBody('traffic:' + key, geo, list.length, true);
      this.bodiesFar[key] = mkBody('traffic:' + key + ':mid', mid, list.length, false);
      bill.push(`${key} ${geo.index.count / 3}/${mid.index.count / 3}`);
      meshes += 2;
    }
    // --- busPax: the nearest buses with people in them. The body without its glazing (still the near, shadow-casting
    //     tier), the glazing as a tinted, reflecting glass over the open windows, and the saloon mesh inside; the
    //     passengers are the crowd's scanned people (crowdScan statics), placed by writeMatrices. PAX_BUSES at a time.
    const raw = (engine.params && engine.params.raw) || {};
    this.paxOn = byType.has('bus') && raw.busPax !== '0' && TIER !== 'safe';
    if (this.paxOn) {
      const B = busBody(BUS, 0, true);
      this.bodiesPax = mkBody('traffic:bus:pax', B.body, PAX_BUSES, true);
      // glass: the opacity tints what is behind it, the reflection goes on at full strength (premultiplied: the dark
      // body colour at `opacity`, the specular unscaled), so the panes read as glass without hiding the saloon
      this.paxGlassMat = new THREE.MeshStandardMaterial({ name: 'traffic:busGlass', color: 0x0b1117, roughness: 0.04, metalness: 0,
        transparent: true, premultipliedAlpha: true, opacity: 0.4, depthWrite: false, envMapIntensity: 1.8 });
      this.paxGlassMat.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <opaque_fragment>', 'gl_FragColor = vec4( totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance, diffuseColor.a );')
          .replace('#include <premultiplied_alpha_fragment>', '');
      };
      this.paxGlassMat.customProgramCacheKey = () => 'traffic:busGlass1';
      const mk = (geo, mat, name) => {
        const im = new THREE.InstancedMesh(geo, mat, PAX_BUSES);
        im.name = name; im.frustumCulled = false; im.castShadow = false; im.count = 0; im.visible = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        group.add(im);
        return im;
      };
      this.paxGlass = mk(B.glass, this.paxGlassMat, 'traffic:bus:glass');
      this.paxGlass.receiveShadow = false; this.paxGlass.renderOrder = 1;
      this.saloon = mk(busSaloon(BUS), this.mat, 'traffic:bus:saloon');
      this.saloon.receiveShadow = true;                      // (a uniform, not a program variant: the bodies' program)
      this.saloon.setColorAt(0, _c.set(0xffffff)); this.saloon.instanceColor.needsUpdate = true;
      bill.push(`bus:pax ${B.body.index.count / 3} glass ${B.glass.index.count / 3} saloon ${this.saloon.geometry.index.count / 3}`);
      meshes += 3;
    }
    this._geoBill = bill.join(' ');
    this.impostors = {};
    for (const kind of ['car', 'box']) {
      this.impostors[kind] = mkBody('traffic:impostor:' + kind, impostorGeo(kind), cars.length, false);
      meshes++;
    }

    // --- wheels (one shared unit wheel, scaled per instance)
    let nW = 0, nL = 0, nP = 0, nWH = 0, nWC = 0;
    for (const c of cars) {
      const T = c.T, P = T.P;
      // (a bus's tyres stand just proud of its dark arches) [x, z, steers, width scale]
      const track = T.fam === 'bus' ? P.hw - P.wheelW / 2 - 0.005 : key6(T) ? P.hw * 0.84 : P.hw * 0.90;
      const pos = [];
      if (T.wheels === 2) { pos.push([0, P.axles[0], 1, 1], [0, P.axles[1], 0, 1]); }
      else if (T.wheels === 6) {
        for (const s of [-1, 1]) pos.push([s * track, P.axles[0], 1, 1]);
        for (const s of [-1, 1]) { pos.push([s * track, P.axles[1] + 0.58, 0, 1], [s * track, P.axles[1] - 0.58, 0, 1]); }
      } else if (T.dual) {
        // twin rear tyres, 0.32 m apart, the outer one's face just inside the flank line (the front one's is on it)
        const xo = P.hw - 0.012 - P.wheelW * 0.45;
        for (const s of [-1, 1]) pos.push([s * track, P.axles[0], 1, 1]);
        for (const s of [-1, 1]) pos.push([s * xo, P.axles[1], 0, 0.9], [s * (xo - 0.32), P.axles[1], 0, 0.9]);
      } else { for (const s of [-1, 1]) { pos.push([s * track, P.axles[0], 1, 1], [s * track, P.axles[1], 0, 1]); } }
      c.wheelPos = pos; c.wheelBase = nW; nW += pos.length;
      if (T.heavy) nWH += pos.length;
      if (T.cover) nWC += pos.length;
      nL += T.lamps.length;
      c.plateBase = nP; nP += T.wheels === 2 ? 1 : 2;
    }
    this.wheels = new THREE.InstancedMesh(wheelGeo(8), this.mat, Math.max(1, nW));
    this.wheels.name = 'traffic:wheels'; this.wheels.frustumCulled = false;
    this.wheels.castShadow = true;                       // the sun shadow needs its contact patches
    this.wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wheels.setColorAt(0, _c.set(0xffffff)); this.wheels.instanceColor.needsUpdate = true;
    group.add(this.wheels); meshes++;
    // under 20 m the tyres are round and the alloys have spokes
    this.wheelsNear = new THREE.InstancedMesh(wheelGeoHi(), this.mat, Math.max(1, Math.min(nW, 112)));
    this.wheelsNear.name = 'traffic:wheels:near'; this.wheelsNear.frustumCulled = false;
    this.wheelsNear.castShadow = true;
    this.wheelsNear.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wheelsNear.setColorAt(0, _c.set(0xffffff)); this.wheelsNear.instanceColor.needsUpdate = true;
    group.add(this.wheelsNear); meshes++;
    // buses and box trucks close up: pressed-steel discs (past WH_NEAR the far wheel's plain disc is the right read)
    this.wheelsHeavy = new THREE.InstancedMesh(wheelGeoHeavy(), this.mat, Math.max(1, Math.min(nWH, 48)));
    this.wheelsHeavy.name = 'traffic:wheels:heavy'; this.wheelsHeavy.frustumCulled = false;
    this.wheelsHeavy.castShadow = true;
    this.wheelsHeavy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wheelsHeavy.setColorAt(0, _c.set(0xffffff)); this.wheelsHeavy.instanceColor.needsUpdate = true;
    this.wheelsHeavy.count = 0; this.wheelsHeavy.visible = false;
    group.add(this.wheelsHeavy); meshes++;
    // the cabs under 20 m: steel wheels under plain slotted covers (JPN TAXI), never the private cars' alloys
    this.wheelsCover = new THREE.InstancedMesh(wheelGeoCover(), this.mat, Math.max(1, Math.min(nWC, 40)));
    this.wheelsCover.name = 'traffic:wheels:cover'; this.wheelsCover.frustumCulled = false;
    this.wheelsCover.castShadow = true;
    this.wheelsCover.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wheelsCover.setColorAt(0, _c.set(0xffffff)); this.wheelsCover.instanceColor.needsUpdate = true;
    this.wheelsCover.count = 0; this.wheelsCover.visible = false;
    group.add(this.wheelsCover); meshes++;

    // --- off-camera vehicles near enough to throw a shadow into the frame: a box stand-in that only the shadow
    //     pass sees (it writes neither colour nor depth in the main pass), instead of the full loft
    this.shadowOnly = new THREE.InstancedMesh(impostorGeo('box'), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, name: 'traffic:shadow' }), Math.max(1, cars.length));
    this.shadowOnly.name = 'traffic:shadowOnly'; this.shadowOnly.frustumCulled = false; this.shadowOnly.castShadow = true;
    this.shadowOnly.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // on a layer of its own that only the sun's shadow cameras render, so the colour pass never even submits it
    this.shadowOnly.layers.set(SHADOW_ONLY_LAYER);
    this.shadowLayerOn();
    group.add(this.shadowOnly); meshes++;

    // --- lamps (emissive lenses on the BLOOM layer)
    const lg = lampGeo();
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true, name: 'traffic:lamp' });
    this.lamps = new THREE.InstancedMesh(lg, this.lampMat, Math.max(1, nL));
    this.lamps.name = 'traffic:lamps'; this.lamps.frustumCulled = false;
    this.lamps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lamps.layers.enable(engine.layers.BLOOM);
    group.add(this.lamps); meshes++;

    const maxAniso = engine.renderer.capabilities.getMaxAnisotropy();
    const nTaxi = cars.filter((c) => c.T.taxi).length, nBus = cars.filter((c) => c.T.fam === 'bus').length;
    // --- every additive glow that sits in the depth buffer, in one draw: lamp halos (and the 方向幕 glows and the
    //     junction signal lenses), the star of a far headlamp, the headlight pools on the road (CONE_SEG slices that
    //     follow 道玄坂) and the wet-road smears under the lamps (a mirror streak plus a long dim tail toward the eye)
    this.fxA = fxAtlas();
    this.fxA.tex.anisotropy = maxAniso;
    this.nFxCap = (nL + nBus * 2 + 96) + nL + (nL + cars.length * 2) * 2 + cars.length * CONE_SEG;
    const fxg = new THREE.PlaneGeometry(1, 1);
    fxg.setAttribute('aUvT', new THREE.InstancedBufferAttribute(new Float32Array(this.nFxCap * 4), 4));
    this.fx = new THREE.InstancedMesh(fxg, uvWindowBasic(this.fxA.tex, 'traffic:fx', {
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }, this.fxA.win[FX.tail], true), this.nFxCap);
    this.fx.name = 'traffic:fx'; this.fx.frustumCulled = false; this.fx.renderOrder = 6;
    this.fx.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fx.setColorAt(0, _c.setRGB(0, 0, 0));
    group.add(this.fx); meshes++;

    // --- headlight glare and lit 行灯 seen through the crowd. From eye level in the middle of the scramble the
    //     lenses are behind a wall of heads but their bloom is not: this glow has no depth test (renderOrder after
    //     everything), is hidden by buildings by hand (buildOccluders) and thinned where the crowd is packed. It is
    //     kept off the BLOOM layer on purpose: that layer is also mirrored into the wet road by weather.js, where a
    //     depth-less glow would shine through every building; the bloom pass is luminance-thresholded anyway.
    const glg = new THREE.PlaneGeometry(1, 1), nGlCap = cars.length * 5 + nTaxi;
    glg.setAttribute('aUvT', new THREE.InstancedBufferAttribute(new Float32Array(nGlCap * 4), 4));
    this.glareMat = uvWindowBasic(this.fxA.tex, 'traffic:glare', {
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
    });
    this.glare = new THREE.InstancedMesh(glg, this.glareMat, nGlCap);
    this.glare.name = 'traffic:glare'; this.glare.frustumCulled = false; this.glare.renderOrder = 7;
    this.glare.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glare.setColorAt(0, _c.setRGB(0, 0, 0));
    group.add(this.glare); meshes++;
    this.occ = buildOccluders(engine.world);

    // past ~90 m the lenses become two soft dots per vehicle sized in screen pixels, so an aerial framing
    // gets rivers of red and white pairs instead of nothing (and not 4 m wide bars). On BLOOM: they reflect.
    const streakTex = radialTexture(64, (u, v) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      return Math.pow(Math.max(0, 1 - d), 2.0) * 0.6 + Math.pow(Math.max(0, 1 - d * 2.2), 1.5) * 0.4;
    });
    streakTex.anisotropy = maxAniso;
    this.streakMat = new THREE.MeshBasicMaterial({
      map: streakTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      toneMapped: true, fog: false, name: 'traffic:streak',
    });
    this.streaks = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.streakMat, Math.max(1, cars.length * 2));
    this.streaks.name = 'traffic:streaks'; this.streaks.frustumCulled = false; this.streaks.renderOrder = 6;
    this.streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.streaks.layers.enable(engine.layers.BLOOM);
    group.add(this.streaks); meshes++;
    for (let i = 0; i < Math.max(1, nL); i++) this.lamps.setColorAt(i, _c.setRGB(0.02, 0.01, 0.01));
    for (let i = 0; i < Math.max(1, cars.length * 2); i++) this.streaks.setColorAt(i, _c.setRGB(0, 0, 0));
    this.lamps.instanceColor.needsUpdate = true; this.streaks.instanceColor.needsUpdate = true;

    // --- contact shadows: one soft quad per vehicle so nothing floats on the tarmac
    // an elliptical soft pad: full under the body, gone by the bumpers (it must not darken the head of the pool)
    const contactTex = radialTexture(64, (u, v) => {
      const d = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2);
      return (1 - smooth01((d - 0.45) / 0.55)) * 0.92;
    });
    contactTex.anisotropy = maxAniso;
    // Each instance's darkness rides in its instance colour's red channel. They draw after the lamp smears and pools
    // (renderOrder 6) as well as over the wet-road mirror, so no light reflects from under a body: a second, dense pad
    // under the wheelbase of a bus, truck or van shuts the tarmac under its chassis off (it was lit through).
    const qg = new THREE.PlaneGeometry(1, 1); qg.rotateX(-Math.PI / 2);
    this.contactMat = new THREE.MeshBasicMaterial({
      map: contactTex, color: 0xffffff, transparent: true, depthWrite: false, toneMapped: false,
      name: 'traffic:contact',
    });
    this.contactMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>',
        '#include <color_fragment>\n\tdiffuseColor.a = min( diffuseColor.a * diffuseColor.r, 0.88 ); diffuseColor.rgb = vec3( 0.0 );');
    };
    this.contactMat.customProgramCacheKey = () => 'traffic:contact2';
    this.contacts = new THREE.InstancedMesh(qg, this.contactMat, Math.max(1, cars.length * 2));
    this.contacts.setColorAt(0, _c.setRGB(1, 1, 1));
    this.contacts.name = 'traffic:contacts'; this.contacts.frustumCulled = false; this.contacts.renderOrder = 6.5;
    this.contacts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(this.contacts); meshes++;

    // The trim below (plates, 行灯, 方向幕, flank livery and bus ads) is compacted every frame like the bodies: each
    // vehicle keeps its atlas cell (c.plateUv, c.roofUv, c.destUv, c.livUv) and only what is on screen is submitted.
    const trimMesh = (geo, mat, n, name, bloom) => {
      geo.setAttribute('aUvOff', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 2), 2));
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
      im.name = name; im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (bloom) im.layers.enable(engine.layers.BLOOM);
      im.count = 0; im.visible = false;
      group.add(im); meshes++;
      return im;
    };

    // --- licence plates (canvas atlas, per-instance cell)
    const atlas = plateAtlas(rng.fork(11));
    this.plateTex = atlas.tex;
    const pg = new THREE.PlaneGeometry(0.33, 0.165);
    const uvs = pg.attributes.uv;
    for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) / PLATE_COLS, uvs.getY(i) / PLATE_ROWS);
    this.plates = trimMesh(pg, plateMaterial(atlas.tex), nP, 'traffic:plates');
    for (const c of cars) {
      const want = c.T.plate === 'biz' ? 1 : c.T.plate === 'kei' ? 2 : 0;
      const opts = [];
      for (let i = 0; i < atlas.cells.length; i++) if (atlas.cells[i] === want) opts.push(i);
      const cell = opts.length ? opts[rng.int(0, opts.length - 1)] : 0;
      c.plateUv = [(cell % PLATE_COLS) / PLATE_COLS, 1 - (Math.floor(cell / PLATE_COLS) + 1) / PLATE_ROWS];
    }

    // --- taxi 行灯: one atlas page, one draw call, per-instance cell. Painted in this module so the lit
    //     company name can never drift out of sync with the `companies` lists.
    this.roofs = [];
    const taxis = cars.filter((c) => c.T.taxi);
    if (taxis.length) {
      const ra = roofAtlas(ROOF_COMPANIES);
      const im = trimMesh(andonGeo(ra.cols, ra.rows), uvOffBasic(ra.tex, 'traffic:roof'), taxis.length, 'traffic:roofs', true);
      im.setColorAt(0, _c.setRGB(1, 1, 1));
      for (const c of taxis) {
        c.roofUv = cellUv(ra, ra.index.has(c.company) ? ra.index.get(c.company) : 0);
        const co = ROOF_COMPANIES.find((q) => q.name === c.company) || ROOF_COMPANIES[0];
        c.roofCol = new THREE.Color(co.bg);
      }
      this.roofMat = im.material;
      this.roofs.push(im);
      // the lit 行灯 seen through the crowd: its face as a camera-facing card, depth-less (see writeMatrices)
      this.roofGl = trimMesh(remapUv(new THREE.PlaneGeometry(1, 1), ra.cols, ra.rows), uvOffBasic(ra.tex, 'traffic:roofGlare', {
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
      }), taxis.length, 'traffic:roofGlare');
      this.roofGl.renderOrder = 7;
      this.roofGl.setColorAt(0, _c.setRGB(1, 1, 1));
    }

    // --- 方向幕 destination boards (front + rear) on the bus fleet
    const buses = cars.filter((c) => c.T.fam === 'bus');
    if (buses.length) {
      const im = trimMesh(remapUv(new THREE.PlaneGeometry(1, 1), DEST_COLS, DEST_ROWS), uvOffBasic(destAtlas(), 'traffic:dest'), buses.length * 2, 'traffic:dest', true);
      for (const c of buses) {
        const route = rng.int(0, N_GENERIC_DEST - 1);
        c.destUv = destUvOf(route);
      }
      this.destMat = im.material;
      this.destBoards = im;
    }

    // --- 運送 livery on the van / truck flanks and the framed 側面広告 on the buses (one shared page)
    const vans = cars.filter((c) => c.T.fam === 'van' && c.T.build === truckBody);
    if (vans.length || buses.length) {
      const la = liveryAtlas();
      this.liveries = trimMesh(remapUv(new THREE.PlaneGeometry(1, 1), la.cols, la.rows), plateMaterial(la.tex, 'traffic:livery', 0.62), (vans.length + buses.length) * 2, 'traffic:livery');
      for (const c of vans) c.livUv = cellUv(la, rng.int(0, la.n - 1));
      for (const c of buses) c.livUv = cellUv(la, la.ads[rng.int(0, la.ads.length - 1)]);
    }

    // --- kerb events: the doors of a delivery van standing open, a cab's rear door open on a drop-off, and the moving
    //     parts of a scooter's rider (helmet, left leg). Unit boxes in the body material, scaled and coloured per instance.
    this.kerbProps = new THREE.InstancedMesh(box(1, 1, 1, 0, 0.5, 0, { paint: 1, rough: 0.45, metal: 0.12, col: 0xffffff }), this.mat, 160);
    this.kerbProps.name = 'traffic:kerbProps'; this.kerbProps.frustumCulled = false; this.kerbProps.castShadow = true;
    this.kerbProps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.kerbProps.setColorAt(0, _c.setRGB(1, 1, 1));
    this.kerbProps.count = 0; this.kerbProps.visible = false;
    group.add(this.kerbProps); meshes++;

    this.nLamp = nL; this.nWheel = nW; this.nPlate = nP;
    this._night = -1;
    this.buildSignalHeads(group);
    meshes += this.sigHeads && this.sigHeads.length ? 2 : 0;
    this.meshCount = meshes;
  },

  // let the sun's shadow cameras see the shadow-only stand-ins (lighting's CSM lights; re-checked now and then)
  shadowLayerOn() {
    const lt = this.engine.get && this.engine.get('lighting');
    const ls = lt && lt.csm && lt.csm.lights;
    if (!ls) return;
    for (const l of ls) if (l.shadow && l.shadow.camera && !l.shadow.camera.layers.isEnabled(SHADOW_ONLY_LAYER)) l.shadow.camera.layers.enable(SHADOW_ONLY_LAYER);
  },

  // Signal heads for the outer signalled junctions (109, 神宮前, 宮益坂下), which props does not draw: a pole on the
  // pavement beside each approach's stop line, a mast arm over the lanes and a horizontal 3-lamp head (青 / 黄 / 赤,
  // red on the driver's right) facing the queue. One merged mesh plus one instanced lens mesh driven by sigState.
  // Retire this once props draws heads from junctionList().
  buildSignalHeads(group) {
    this.sigHeads = [];
    const props = this.engine.get && this.engine.get('props');
    if (props && props.drawsJunctionHeads) return;
    const field = this.field;
    const heads = [];
    for (const N of this.net.nodes) {
      if (!N.ctrl || N.ctrl.scramble) continue;
      const arms = new Map();
      for (const e of this.lanes) {
        if (!e.sig || e.sig.node !== N) continue;
        const cur = arms.get(e.arm1);
        if (!cur || e.k > cur.k) arms.set(e.arm1, e);
      }
      for (const e of arms.values()) {
        const p = e.pts[e.pts.length - 1], h = e.hdg[e.hdg.length - 1], l = leftOf(h);
        let d = 1.5;
        if (field) { while (d < 12 && field.sample(p[0] + l[0] * d, p[1] + l[1] * d) < 0.55) d += 0.25; }
        else d = 3.5;
        const px = p[0] + l[0] * d, pz = p[1] + l[1] * d;
        const reach = clamp(d + 0.3, 3.0, 6.5);
        heads.push({ node: N, group: e.sig.group, px, pz, h, l, reach, y: groundY(px, pz) });
      }
    }
    if (!heads.length) return;
    const parts = [];
    const G = { paint: 0, rough: 0.55, metal: 0.35, col: 0x5f6b63 };
    const H = { paint: 0, rough: 0.6, metal: 0.2, col: 0x4a5550 };
    const HOOD = { paint: 0, rough: 0.6, metal: 0.2, col: 0x2e3338 };
    const BAND = { paint: 0, rough: 0.5, metal: 0.1, col: 0xcfd4d6 };
    const lenses = [];
    for (const hd of heads) {
      // local frame: +z faces the approaching traffic (−heading), +x is the arm direction (over the road)
      const ry = Math.atan2(-Math.sin(hd.h), -Math.cos(hd.h));
      const local = [];
      local.push(cyl(0.2, 0.3, 0, 0.15, 0, { ...G, col: 0x2f3a34 }, 10));
      local.push(cyl(0.1, 5.6, 0, 2.8, 0, G, 10));
      local.push(cyl(0.055, hd.reach, hd.reach / 2, 5.5, 0, G, 8, 'x'));
      local.push(box(1.62, 0.62, 0.05, hd.reach - 0.1, 5.2, -0.11, H));
      local.push(box(1.66, 0.05, 0.035, hd.reach - 0.1, 5.52, -0.125, BAND));
      local.push(box(1.66, 0.05, 0.035, hd.reach - 0.1, 4.88, -0.125, BAND));
      local.push(box(1.48, 0.5, 0.2, hd.reach - 0.1, 5.2, 0, H));
      for (const dx of [-0.5, 0, 0.5]) {
        local.push(box(0.36, 0.05, 0.22, hd.reach - 0.1 + dx, 5.4, 0.1, HOOD));
        local.push(cyl(0.155, 0.02, hd.reach - 0.1 + dx, 5.2, 0.1, { ...H, col: 0x121416 }, 16, 'z'));
      }
      const g = mergeGeometries(local, false);
      // rotateY(ry) takes local +z onto −heading and local +x onto −left: the arm reaches back over the lanes
      g.rotateY(ry);
      g.translate(hd.px, hd.y, hd.pz);
      parts.push(g);
      // lenses: 青 at the left of the driver's view, 赤 on the right
      const cx = hd.px - hd.l[0] * (hd.reach - 0.1), cz = hd.pz - hd.l[1] * (hd.reach - 0.1);
      const f = fwdOf(hd.h);
      const idx = {};
      for (const [name, o] of [['green', 0.5], ['amber', 0], ['red', -0.5]]) {
        idx[name] = lenses.length;
        lenses.push({ x: cx + hd.l[0] * o - f[0] * 0.116, y: hd.y + 5.2, z: cz + hd.l[1] * o - f[1] * 0.116, yaw: Math.atan2(-f[0], -f[1]) });
      }
      this.sigHeads.push({ node: hd.node, group: hd.group, idx, st: null, x: cx, z: cz, y: hd.y + 5.2 });
    }
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3, name: 'traffic:signal' });
    const mesh = new THREE.Mesh(mergeGeometries(parts, false), mat);
    mesh.name = 'traffic:signals'; mesh.castShadow = false; mesh.receiveShadow = true;
    group.add(mesh);
    const lg = new THREE.CircleGeometry(0.15, 18);
    this.sigLens = new THREE.InstancedMesh(lg, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true, name: 'traffic:siglens' }), lenses.length);
    this.sigLens.name = 'traffic:siglens';
    this.sigLens.layers.enable(this.engine.layers.BLOOM);
    lenses.forEach((q, i) => {
      _q.setFromAxisAngle(UPY, q.yaw);
      _m.compose(_p.set(q.x, q.y, q.z), _q, _s.set(1, 1, 1));
      this.sigLens.setMatrixAt(i, _m);
      this.sigLens.setColorAt(i, _c.setRGB(0.02, 0.02, 0.02));
    });
    this.sigLensPos = lenses;
    this.sigLens.computeBoundingSphere();
    group.add(this.sigLens);
  },

  // lens colours follow the junction's aspect; only rewritten when it changes
  updateSignalHeads() {
    if (!this.sigLens) return;
    let dirty = false;
    for (const hd of this.sigHeads) {
      const st = this.sigState({ sig: { node: hd.node, group: hd.group } });
      if (st === hd.st) continue;
      hd.st = st; dirty = true;
      this.sigLens.setColorAt(hd.idx.green, st === 'green' ? _c.setRGB(0.1, 2.4, 1.5) : _c.setRGB(0.015, 0.04, 0.03));
      this.sigLens.setColorAt(hd.idx.amber, st === 'amber' ? _c.setRGB(2.6, 1.5, 0.1) : _c.setRGB(0.04, 0.03, 0.01));
      this.sigLens.setColorAt(hd.idx.red, st === 'red' ? _c.setRGB(2.8, 0.2, 0.08) : _c.setRGB(0.04, 0.012, 0.01));
    }
    if (dirty) this.sigLens.instanceColor.needsUpdate = true;
  },

  // ------------------------------------------------------------------------------------------ signal
  evalPhase() {
    let t = ((this.cycleT % CYCLE_LEN) + CYCLE_LEN) % CYCLE_LEN;
    for (const p of CYCLE) {
      if (t < p.dur) { this.phase = p.name; this.phaseT = t; this.signal.remaining = p.dur - t; break; }
      t -= p.dur;
    }
    const s = this.signal;
    s.ns = this.phase === 'ns' ? 'green' : this.phase === 'ns_amber' ? 'amber' : 'red';
    s.ew = this.phase === 'ew' ? 'green' : this.phase === 'ew_amber' ? 'amber' : 'red';
    s.ped = this.phase === 'scramble' ? (s.remaining < FLASH_T ? 'flash' : 'walk') : 'stop';
    s.vehicle = (s.ns === 'green' || s.ew === 'green') ? 'green' : (s.ns === 'amber' || s.ew === 'amber') ? 'amber' : 'red';
  },

  emitPhase() {
    const s = this.signal;
    if (this.xings && this.xings.length && this.engine && this.engine.events) {
      const xp = this.xingState().ped;
      if (xp !== this.lastXing) {
        this.lastXing = xp;
        for (const X of this.xings) this.engine.events.emit('signal:crossing', { id: X.id, pedestrian: xp, ped: xp });
      }
    }
    if (s.vehicle === this.lastSig && s.ped === this.lastSigPed) return;
    this.lastSig = s.vehicle; this.lastSigPed = s.ped;
    if (this.engine && this.engine.events) {
      this.engine.events.emit('signal:phase', {
        vehicle: s.vehicle, pedestrian: s.ped, remaining: s.remaining,
        ped: s.ped, ns: s.ns, ew: s.ew, phase: this.phase, cycle: CYCLE_LEN,
      });
    }
  },

  // The signalled zebras across 駅前通り run a 60 s cycle locked to the scramble: pedestrians walk while the
  // scramble walks (and again half a cycle later), vehicles see amber 3 s and a 2 s clearance either side.
  xingState() {
    const u = ((this.cycleT % 60) + 60) % 60;
    if (u >= 36 && u < 52) return XS_WALK;
    if (u >= 52 && u < 57) return XS_FLASH;
    if (u >= 31 && u < 34) return XS_AMBER;
    if (u >= 34 && u < 36 || u >= 57) return XS_RED;
    return XS_GREEN;
  },
  crossingPhase(id) { return this.xings && this.xings.some((X) => X.id === id) ? this.xingState().ped : null; },
  // { vehicle: 'green'|'amber'|'red', pedestrian: 'walk'|'flash'|'stop' } for a signalled zebra, for whoever draws its heads
  crossingSignal(id) {
    if (!this.xings || !this.xings.some((X) => X.id === id)) return null;
    const x = this.xingState();
    return { vehicle: x.veh, pedestrian: x.ped };
  },

  // seconds the scramble's 'ns' / 'ew' vehicle heads have been red at the current point of the cycle (0 while not red)
  redAge(g) {
    let t = ((this.cycleT % CYCLE_LEN) + CYCLE_LEN) % CYCLE_LEN, i = 0;
    while (i < CYCLE.length - 1 && t >= CYCLE[i].dur) { t -= CYCLE[i].dur; i++; }
    let age = t;
    for (let k = 0; k < CYCLE.length; k++) {
      const p = CYCLE[(i - k + CYCLE.length) % CYCLE.length];
      if (p.name === g || p.name === g + '_amber') return k === 0 ? 0 : age;
      if (k > 0) age += p.dur;
    }
    return age;
  },

  isScramble() { return this.phase === 'scramble'; },
  // The outer signalled junctions, for whoever draws their heads: [{ id, pos: [x, z], groups: { armKey: 'a'|'b' } }]
  // (arm keys are road+ / road- as in JUNCTIONS), and the aspect a group shows right now.
  junctionList() {
    return this.net ? this.net.nodes.filter((n) => n.ctrl && !n.ctrl.scramble)
      .map((n) => ({ id: n.cfg.id, pos: n.p.slice(), groups: { ...n.cfg.groups } })) : [];
  },
  junctionState(id, group) {
    const n = this.net && this.net.nodes.find((q) => q.cfg && q.cfg.id === id);
    return n ? this.sigState({ sig: { node: n, group } }) : 'red';
  },
  laneGreen(axis) {
    if (axis === 'ns') return this.signal.ns === 'green';
    if (axis === 'ew') return this.signal.ew === 'green';
    return true;
  },
  laneAmber(axis) {
    if (axis === 'ns') return this.signal.ns === 'amber';
    if (axis === 'ew') return this.signal.ew === 'amber';
    return false;
  },

  // ------------------------------------------------------------------------------------------ update
  update(dt, t) {
    if (this._dbgT === undefined) {
      const raw = this.engine.params && this.engine.params.raw;
      this._dbgT = raw && raw.tdbg ? 0 : -1;
    }
    if (this._dbgT >= 0) { this._dbgT += dt; if (this._dbgT > 1.5) { this._dbgT = -1; this.dbg = true; } }
    const step = Math.min(dt, 1 / 20);
    this.cycleT += step;
    this.evalPhase();
    this.emitPhase();
    if (!this.cars.length || !this.bodies) return;
    const blink = (Math.floor((t || 0) * 1.6) % 2) === 0;
    this.blink = blink;
    // everyone a driver has to see this frame: 健人 and the men he is fighting (enemy.js keeps them in `list`)
    const people = this._people || (this._people = []);
    people.length = 0;
    const pl = this.engine.player;
    if (pl && pl.position) people.push(pl);
    const en = this.engine.get('enemy');
    if (en && Array.isArray(en.list)) for (const e of en.list) if (e && e.position) people.push(e);
    const cr = this.engine.get('crowd');
    this._crowd = cr && (typeof cr.agentsNear === 'function' || cr.rHead) ? cr : null;
    const t0 = performance.now();
    if (!this.holdStill) this.drive(step, t || 0);
    const t1 = performance.now();
    this._lastStep = step;
    this.updateMovers(step);
    // the night reflection capture, one cube face (or its prefilter) a frame once its shaders are compiled
    this.updateEnv();
    if (((this._wf || 0) & 127) === 0) this.shadowLayerOn();
    this.writeMatrices(t || 0);
    // cost, smoothed: simulation / everything (shown by ?tdbg=1)
    this._msSim = (this._msSim || 0) * 0.95 + (t1 - t0) * 0.05;
    this._msAll = (this._msAll || 0) * 0.95 + (performance.now() - t0) * 0.05;
  },

  // At night the paint reflects the street's own lights: a cube capture of the BLOOM layer (signage, screens, neon, lamp
  // heads) plus a band of lit shop fronts (buildEnvBand) over a dim night sky, prefiltered by PMREM. Its shader variants
  // (every BLOOM-layer material with shadows off, into a half-float target) and the PMREM blur are compiled while the
  // game loads (precompileEnv: once at init, once more when every module is up), so neither the first night frame nor
  // the dusk→night change pays for them. It is then taken one cube face a frame (~1 ms each) with the PMREM on a frame
  // of its own, and re-taken the same way wherever the camera has got to once it is 70 m from the last capture, so a cab
  // on 道玄坂 does not reflect the scramble. By day the paint reflects the scene's sky probe. The capture is 256 px, the
  // size of lighting's probes, so swapping between the two is a texture swap on the same shader program.
  updateEnv() {
    const night = this.nightNow();
    const want = night > 0.55;
    const E = this._env;
    if (E && !E.pre2 && this.engine.booted) { E.pre2 = true; this.precompileEnv(E); }
    // Once its shaders are linked, the capture is drawn whole once into a 16 px cube of the same formats, on a boot frame:
    // Metal builds a pipeline per shader and target format at the first draw, not at link time, and those builds were
    // the 60–220 ms of the first real faces. The captures proper wait out the first second after boot.
    const fr = this.engine.stats ? this.engine.stats.frame : 99;
    if (E && E.ready && E.pre2 && !E.warmed && !this._envFail) this.warmEnv(E);
    if (want && !this._envFail && E && E.ready && E.warmed && fr >= 40) {
      const cam = this.engine.camera.position;
      if (E.face < 0 && (!this._envRT || Math.hypot(cam.x - E.pos.x, cam.z - E.pos.z) > 70)) {
        E.face = 0;
        E.pos.set(cam.x, groundY(cam.x, cam.z) + 3.2, cam.z);
      }
      if (E.face >= 0) this.envStep(E);
    }
    const env = want && this._envRT ? this._envRT.texture : null;
    if (this.mat.envMap !== env) this.mat.envMap = env;
    this.mat.envMapIntensity = env ? 1.1 : 1;
    if (this.paxGlassMat && this.paxGlassMat.envMap !== env) this.paxGlassMat.envMap = env;
    U.env.value = env ? 0.5 : 0.3;
  },
  initEnv() {
    try {
      const r = this.engine.renderer;
      const rt = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
      const cc = new THREE.CubeCamera(0.5, 260, rt);
      cc.layers.set(this.engine.layers.BLOOM);
      cc.layers.enable(ENV_LAYER);
      cc.coordinateSystem = r.coordinateSystem; cc.updateCoordinateSystem();
      const pm = new THREE.PMREMGenerator(r);
      pm.compileCubemapShader();
      const E = { rt, cc, pm, face: -1, pos: new THREE.Vector3(), sky: new THREE.Color(), ready: false, pre2: false, warmed: false, pending: 0, warm: null };
      this.buildEnvBand();
      // the blur passes compile on their first use: run one over the (empty) cube now; its target is reused
      E.warm = pm.fromCubemap(rt.texture);
      this.precompileEnv(E);
      return E;
    } catch (e) { this._envFail = true; console.warn('[traffic] night reflection setup failed', e); return null; }
  },
  // compile what a capture draws, in the capture's own renderer state, without drawing it, and upload the textures it
  // samples (a sign behind the camera has never been drawn: its canvas page used to go up inside the first face, 80–230
  // ms); E.ready once it is all linked
  precompileEnv(E) {
    const r = this.engine.renderer, scene = this.engine.scene;
    const layers = E.cc.layers, vis = this.group.visible;
    const prevRT = r.getRenderTarget(), se = r.shadowMap.enabled;
    // compile() takes every material of its `scene`: hand it only what the cube camera can see (lights come from the
    // real scene, filtered by the camera's layers, as in a render)
    const view = { traverseVisible() {}, traverse(fn) { scene.traverseVisible((o) => { if (o.layers.test(layers)) fn(o); }); } };
    let p = null;
    try {
      this.group.visible = false;
      const tex = new Set();
      view.traverse((o) => {
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of ms) {
          for (const k in m) { const v = m[k]; if (v && v.isTexture) tex.add(v); }
          if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k] && m.uniforms[k].value; if (v && v.isTexture) tex.add(v); }
        }
      });
      const tt0 = performance.now();
      for (const t of tex) if (!t.isRenderTargetTexture && t.image) { try { r.initTexture(t); } catch (e) { /* not uploadable yet */ } }
      console.info(`[traffic] env precompile: ${tex.size} textures ${Math.round(performance.now() - tt0)} ms`);
      r.shadowMap.enabled = false;
      r.setRenderTarget(E.rt, 0);
      p = r.compileAsync(view, E.cc.children[0], scene);
    } catch (e) { console.warn('[traffic] night reflection precompile failed', e); }
    r.setRenderTarget(prevRT); r.shadowMap.enabled = se; this.group.visible = vis;
    E.ready = false; E.pending++;
    const done = () => { if (--E.pending <= 0) E.ready = true; };
    if (p && typeof p.then === 'function') p.then(done, done); else done();
  },
  warmEnv(E) {
    const r = this.engine.renderer, scene = this.engine.scene, cam = this.engine.camera.position;
    const t0 = performance.now();
    const rt = new THREE.WebGLCubeRenderTarget(16, { type: THREE.HalfFloatType });
    const prevRT = r.getRenderTarget(), prevFace = r.getActiveCubeFace(), prevMip = r.getActiveMipmapLevel();
    const au = r.shadowMap.autoUpdate, se = r.shadowMap.enabled, bg = scene.background, vis = this.group.visible;
    try {
      r.shadowMap.autoUpdate = false; r.shadowMap.enabled = false; this.group.visible = false;
      scene.background = E.sky;
      E.cc.position.set(cam.x, groundY(cam.x, cam.z) + 3.2, cam.z); E.cc.updateMatrixWorld(true);
      for (let f = 0; f < 6; f++) { r.setRenderTarget(rt, f); r.render(scene, E.cc.children[f]); }
    } catch (e) { console.warn('[traffic] night reflection warm-up failed', e); }
    r.setRenderTarget(prevRT, prevFace, prevMip);
    r.shadowMap.autoUpdate = au; r.shadowMap.enabled = se; scene.background = bg; this.group.visible = vis;
    rt.dispose();
    E.warmed = true;
    this._envWarmMs = Math.round(performance.now() - t0);
  },
  // The lit ground floors of the street, for the capture only (ENV_LAYER: no other camera sees it). Signage is on the
  // BLOOM layer and in the capture anyway; the shop fronts are not, and without them the flank of a black cab had no
  // horizon to catch. One quad per shop front (city facades of kind 'shop'), facing the street, warm, konbini-white now
  // and then, the odd pink one.
  buildEnvBand() {
    const city = this.engine.get && this.engine.get('city');
    const fac = city && Array.isArray(city.facades) ? city.facades : null;
    if (!fac) return;
    const pos = [], col = [], idx = [];
    let n = 0;
    for (let i = 0; i < fac.length; i++) {
      const f = fac[i];
      if (f.kind !== 'shop' || !f.position || !f.normal) continue;
      const cx = f.position.x + f.normal.x * 0.35, cz = f.position.z + f.normal.z * 0.35;
      if (Math.abs(cx) > 320 || Math.abs(cz) > 320) continue;
      const hw = Math.max(1, (f.width || 4) * 0.46), tx = -f.normal.z, tz = f.normal.x;
      const gy = groundY(cx, cz), y0 = gy + 0.35, y1 = gy + Math.min(3.1, (f.groundFloorHeight || 3.2) * 0.86);
      const h = ((i * 2654435761) >>> 0) / 4294967296;
      const c = h < 0.6 ? [2.4, 1.68, 1.0] : h < 0.9 ? [1.85, 2.05, 2.3] : [2.4, 1.0, 1.45];
      for (const [u, v] of [[-1, y0], [1, y0], [1, y1], [-1, y1]]) {
        pos.push(cx + tx * hw * u, v, cz + tz * hw * u);
        col.push(c[0], c[1], c[2]);
      }
      idx.push(n, n + 2, n + 1, n, n + 3, n + 2);
      n += 4;
    }
    if (!n) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false, side: THREE.DoubleSide, name: 'traffic:envBand' }));
    m.name = 'traffic:envBand'; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
    m.layers.set(ENV_LAYER);
    this.engine.scene.add(m);
    this.envBand = m;
  },
  envStep(E) {
    const r = this.engine.renderer, scene = this.engine.scene, lt = this.engine.get('lighting');
    const t0 = performance.now();
    if (E.face >= 6) {
      // the prefilter on a frame of its own, after the sixth face
      try { this._envRT = E.pm.fromCubemap(E.rt.texture, this._envRT || E.warm); }
      catch (e) { this._envFail = true; console.warn('[traffic] night reflection prefilter failed', e); }
      E.face = -1;
    } else {
      const prevRT = r.getRenderTarget(), prevFace = r.getActiveCubeFace(), prevMip = r.getActiveMipmapLevel();
      const au = r.shadowMap.autoUpdate, se = r.shadowMap.enabled, bg = scene.background, vis = this.group.visible;
      try {
        // the same state as weather.js's mirrored BLOOM-layer pass, so the two share their shader variants
        r.shadowMap.autoUpdate = false; r.shadowMap.enabled = false; this.group.visible = false;
        // the sky over 渋谷 at night: light-polluted violet, dim (it is what a roof or a bonnet mirrors)
        if (lt && lt.fogColor && lt.fogColor.isColor) E.sky.copy(lt.fogColor).multiplyScalar(0.7); else E.sky.setRGB(0.03, 0.022, 0.045);
        scene.background = E.sky;
        E.cc.position.copy(E.pos); E.cc.updateMatrixWorld(true);
        r.setRenderTarget(E.rt, E.face);
        const pr0 = r.info.programs.length, tx0 = r.info.memory.textures;
        r.render(scene, E.cc.children[E.face]);
        this._envDbg = `p+${r.info.programs.length - pr0} t+${r.info.memory.textures - tx0}`;
        E.face++;
      } catch (e) { this._envFail = true; console.warn('[traffic] night reflection capture failed', e); }
      r.setRenderTarget(prevRT, prevFace, prevMip);
      r.shadowMap.autoUpdate = au; r.shadowMap.enabled = se; scene.background = bg; this.group.visible = vis;
    }
    const dt = performance.now() - t0;
    this._envMs = Math.round(((this._envMs || 0) + dt) * 10) / 10;
    this._envMax = Math.max(this._envMax || 0, Math.round(dt * 10) / 10);
    (this._envLog || (this._envLog = [])).length < 16 && this._envLog.push(`${E.face}:${dt.toFixed(1)}@${this.engine.stats ? this.engine.stats.frame : '?'}(${this._envDbg || ''})`);
  },

  // ------------------------------------------------------------------------------------------ transforms
  // Culling and LOD live here. Visibility is decided on *projected size*, not on an XZ distance (which
  // ignored camera height and switched every light off in any aerial framing), and every instanced mesh is
  // compacted so `count` — and therefore the triangle and shadow-pass bill — tracks what is on screen.
  writeMatrices(t) {
    const engine = this.engine;
    const lighting = engine.get('lighting');
    const night = lighting ? lighting.nightFactor : 1;
    this._night = night;
    const wet = engine.time ? (engine.time.wet || 0) : 0;
    U.emis.value = 0.35 + 1.15 * night;
    U.night.value = night;
    U.time.value = t || 0;
    const cam = engine.camera, camX = cam.position.x, camY = cam.position.y, camZ = cam.position.z;
    const blink = this.blink;
    const fr = this._wf = (this._wf || 0) + 1;

    const head = 0.26 + 1.48 * night;
    const tailBase = 0.14 + 0.66 * night;
    const lamps = this.lamps, fx = this.fx, glare = this.glare, kp = this.kerbProps;
    const plates = this.plates, wheels = this.wheels, wheelsNear = this.wheelsNear, streaks = this.streaks, contacts = this.contacts;
    const roofs = this.roofs[0] || null, dests = this.destBoards || null, livs = this.liveries || null, shadowOnly = this.shadowOnly;
    const camG = groundY(camX, camZ);                     // the road under the eye (道玄坂 is not flat)
    const reflOn = wet > 0.05 && night > 0.2 && !(engine.params && engine.params.raw && engine.params.raw.trefl === '0');
    const W = this.fxA.win, WC = this.fxA.cones;
    const coneK = clamp(0.45 + 0.35 * wet, 0, 1) * night;
    const cr = this._crowd;

    // pixels subtended by one metre at unit distance, from the real viewport height
    const kPx = ((engine.renderer.domElement.height || 1080) * 0.5) / Math.tan(cam.fov * Math.PI / 360);
    const pxW = 1 / kPx;                                   // metres per pixel at unit distance
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    this._visOK = true;

    // the draw context the module-level helpers below share (putFx, putRefl, putGlare, glVis, seeLamps …)
    const X = WX;
    X.tr = this; X.fx = fx; X.glare = glare; X.roofGl = this.roofGl || null; X.kp = kp;
    X.uvT = fx.geometry.attributes.aUvT.array; X.glUv = glare.geometry.attributes.aUvT.array;
    X.rgUv = X.roofGl ? X.roofGl.geometry.attributes.aUvOff.array : null;
    X.nFx = 0; X.nGl = 0; X.nRg = 0; X.nKp = 0;
    X.fxCap = this.nFxCap; X.glCap = glare.instanceMatrix.count; X.kpCap = kp.instanceMatrix.count;
    X.rgCap = X.roofGl ? X.roofGl.instanceMatrix.count : 0;
    X.cam = cam; X.camX = camX; X.camY = camY; X.camZ = camZ; X.camG = camG; X.pxW = pxW; X.wet = wet; X.fr = fr;
    X.occ = this.occ; X.cr = cr; X.W = W; X.self = null; X.go = 0;
    this.bucketCars();
    // the buses, trucks and vans near enough for light to be seen running on under their chassis (putRefl)
    const HV = X.hv || (X.hv = []);
    HV.length = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const o = this.cars[i];
      if (o.heavy && !o.hidden && Math.abs(o.x - camX) < 170 && Math.abs(o.z - camZ) < 170) HV.push(o);
    }
    const contactK = 0.62 * (1 - 0.45 * night);

    for (let i = 0; i < this._bodyList.length; i++) this._bodyList[i].__n = 0;
    if (this.paxOn) this.paxPick(camX, camY, camZ);
    let nSal = 0;
    let nWheel = 0, nWheelN = 0, nWheelH = 0, nWheelC = 0, nStreak = 0, nContact = 0, nLamp = 0;
    let nPl = 0, nRf = 0, nDs = 0, nLv = 0, nSh = 0;
    const capWN = wheelsNear.instanceMatrix.count, capWH = this.wheelsHeavy.instanceMatrix.count, capWC = this.wheelsCover.instanceMatrix.count;

    for (const c of this.cars) {
      if (c.hidden) continue;
      const T = c.T, P = T.P;
      const ground = groundY(c.x, c.z);
      const hl = T.len * 0.42;
      const fx_ = Math.sin(c.yaw), fz_ = Math.cos(c.yaw);
      const dx = c.x - camX, dy = ground + T.hgt * 0.5 - camY, dz = c.z - camZ;
      const d3 = Math.max(0.6, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const px = (T.len / d3) * kPx;
      const far = px < PX_CUT || d3 > D_DRAW;
      _sph.center.set(c.x, ground + T.hgt * 0.5, c.z);
      _sph.radius = Math.max(T.len, T.hgt) * 0.62;
      const inView = _frustum.intersectsSphere(_sph);
      const shadowNear = d3 < D_SHADOW;

      const yF = groundY(c.x + fx_ * hl, c.z + fz_ * hl), yB = groundY(c.x - fx_ * hl, c.z - fz_ * hl);
      const slope = Math.atan2(yF - yB, hl * 2);
      // moving: road bob; standing with the engine running: a fine idle shudder (a diesel bus or truck more so)
      let y = ground;
      if (c.speed > 0.2) y += Math.sin(c.bob) * (0.006 + 0.004 * Math.min(1, c.speed / 8));
      else if (!c.parked || c.indL || c.rank) y += Math.sin((t || 0) * (c.big ? 57 : 71) + c.id * 1.7) * (c.big ? 0.0035 : 0.0016);
      c.y = y;
      c.pitch = this.pitchOf(c, slope);
      c.far = far;
      c.lit = false;
      if (!inView || far) {
        // off camera but close enough to throw a shadow into the frame: the shadow pass gets a box stand-in
        if (shadowNear && !far) {
          _e.set(c.pitch, c.yaw, 0); _q.setFromEuler(_e);
          _m.compose(_p.set(c.x, y, c.z), _q, _s.set(T.wid * 0.96, T.hgt * 0.92, T.len * 0.96));
          shadowOnly.setMatrixAt(nSh++, _m);
        }
        continue;
      }

      // a scooter held at the line leans onto the rider's left foot
      const lean = T.wheels === 2 && c.speed < 0.2 && !c.parked ? -0.045 : 0;
      _e.set(c.pitch, c.yaw, c.roll + lean);
      _q.setFromEuler(_e);
      _p.set(c.x, y, c.z);

      // body: full mesh (shadow-casting inside D_SHADOW), the reduced loft, or a ~100-tri impostor past D_IMPOSTOR
      if (d3 > D_IMPOSTOR) {
        _m.compose(_p, _q, _s.set(T.wid, T.hgt, T.len));
        putInstance(this.impostors[T.imp], c, _m);
      } else {
        _m.compose(_p, _q, _s.set(1, 1, 1));
        if (c._pax && this.paxOn && shadowNear && nSal < PAX_BUSES) {
          // a bus with people in it: open glazing, the saloon, the glass over it (the riders: paxPose, below)
          putInstance(this.bodiesPax, c, _m);
          this.saloon.setMatrixAt(nSal, _m); this.paxGlass.setMatrixAt(nSal++, _m);
        } else putInstance(shadowNear ? this.bodies[c.key] : this.bodiesFar[c.key], c, _m);
      }
      _mc.copy(_m);

      // contact shadow: the 0.30 m gap between sill and tarmac is otherwise completely unoccluded. It stops at the
      // bumpers, pitched with the road like the body.
      if (d3 < D_CONTACT) {
        _p.set(c.x, ground + 0.015, c.z);
        _e.set(-slope, c.yaw, 0); _q2.setFromEuler(_e);
        _m.compose(_p, _q2, _s.set(T.wid * 1.15, 1, T.len * 1.04));
        contacts.setMatrixAt(nContact, _m); contacts.setColorAt(nContact++, _c.setRGB(contactK, 0, 0));
        if (c.heavy) {
          // the dense pad under a bus's or truck's chassis: body width by the wheelbase plus a metre, near-black
          const A = P.axles, zc = (A[0] + A[A.length - 1]) / 2, span = A[0] - A[A.length - 1] + (A.length > 2 || key6(T) ? 2.2 : 1);
          _p.set(c.x + fx_ * zc, ground + 0.02, c.z + fz_ * zc);
          _m.compose(_p, _q2, _s.set(T.wid * 1.15, 1, span));
          contacts.setMatrixAt(nContact, _m); contacts.setColorAt(nContact++, _c.setRGB(1.8, 0, 0));
        }
      }

      if (d3 < D_WHEEL) {
        // the wheels follow the road, not the body: no dive, squat or lean, so the tyres never leave the tarmac
        _e.set(-slope, c.yaw, 0);
        _qw.setFromEuler(_e);
        const nw = c.wheelPos.length;
        const heavyN = c.heavy && d3 < WH_NEAR && nWheelH + nw <= capWH;
        const coverN = T.cover && d3 < 20 && nWheelC + nw <= capWC;
        const near = !heavyN && !coverN && !c.heavy && !T.cover && d3 < 20 && nWheelN + nw <= capWN;
        for (let k = 0; k < nw; k++) {
          const wp = c.wheelPos[k];
          _p.set(wp[0], P.wheelR, wp[1]).applyQuaternion(_qw).add(_v(c.x, ground, c.z));
          _q2.setFromAxisAngle(RX, c.spin);
          if (wp[2]) { _q3.setFromAxisAngle(UPY, c.steer); _q2.premultiply(_q3); }
          _q3.copy(_qw).multiply(_q2);
          _m.compose(_p, _q3, _s.set(P.wheelW * wp[3], P.wheelR, P.wheelR));
          if (heavyN) this.wheelsHeavy.setMatrixAt(nWheelH++, _m);
          else if (coverN) this.wheelsCover.setMatrixAt(nWheelC++, _m);
          else if (near) wheelsNear.setMatrixAt(nWheelN++, _m); else wheels.setMatrixAt(nWheel++, _m);
        }
      }
      if (T.wheels === 2 && d3 <= D_IMPOSTOR) this.riderParts(c, t || 0);

      // which end of the vehicle faces the camera (+1 nose, −1 tail)
      const toCamX = -dx / d3, toCamZ = -dz / d3;
      const facing = fx_ * toCamX + fz_ * toCamZ;
      const af = Math.abs(facing);

      const trim = d3 <= D_LAMP;
      const lampsOn = trim && T.lamps.length > 0;
      const nL = T.lamps.length;
      // lamp positions in the world, once (the lenses, the glare and the smears all start from them)
      const glOn = night > 0.3 && d3 > 14 && d3 < 240 && T.wheels !== 2 && nL > 0;
      const LP = lampsOn || glOn ? lampPos(c, T, y, _q) : LPB;
      const andon = roofs && c.roofUv && c.vacant && night > 0.2 && trim && d3 > 14;
      const board = dests && c.destUv && trim && facing > -0.1;
      if (andon) { _p.set(0, P.roofY + 0.10, T.andonZ).applyQuaternion(_q); LP[nL * 3] = _p.x + c.x; LP[nL * 3 + 1] = _p.y + y; LP[nL * 3 + 2] = _p.z + c.z; }
      if (board) { _p.set(0, 2.64, P.zF + P.destZ).applyQuaternion(_q); LP[nL * 3 + 3] = _p.x + c.x; LP[nL * 3 + 4] = _p.y + y; LP[nL * 3 + 5] = _p.z + c.z; }
      X.self = c; X.go = c._go || 0;

      // Glare. From eye level in the scramble the lenses sit behind a crowd. A lens whose line to the eye clears every
      // head flares (depth-less, so it spills over the edges of the people beside it); a lens behind somebody draws
      // nothing, bodies being opaque. What gets over the heads is a veil: a soft, wide haze hung above the head line
      // over every line of idling lamps, the stronger the more crowd there is to hide the lenses themselves. No depth
      // test (see buildMeshes): buildings and other vehicles hide it by hand (glVis).
      let glareK = 0, starK = 0, gs = 0;
      if (glOn && (af > 0.25 || andon)) {
        const fade = af > 0.25 ? smooth01((d3 - 14) / 26) * clamp(1.6 - d3 / 150, 0, 1) * night * (af - 0.25) / 0.75 : 0;
        let lead = 1;
        if (facing > 0 && c.gapF < 12) { const tn = Math.sqrt(Math.max(0, 1 - af * af)) / Math.max(af, 0.05); lead = clamp((tn * (c.gapF + 2) - 0.6) / 1.2, 0.15, 1); }
        const nose = af > 0.25 ? (facing > 0 ? P.zF : P.zB) : 0;
        const gx = c.x + fx_ * nose, gz = c.z + fz_ * nose;
        const vy = Math.max(y + T.lamps[0].y, ground + 1.75) + 0.3;
        gs = glVis(c, gx, y + 1.2, gz, vy, andon, LP[nL * 3], LP[nL * 3 + 1] + 0.05, LP[nL * 3 + 2]);
        glareK = fade * lead * gs;
        const crowdK = smooth01(c._go / 0.25);
        starK = glareK * crowdK;
        // which of the lamps facing the eye (and the lit 行灯, the 方向幕) have a clear line through the crowd
        if (cr && (glareK > 0.01 || andon)) seeLamps(c, LP, nL, facing, af > 0.25 && glareK > 0.01, andon, board);
        const vk = 0.24 * glareK * smooth01(c._go / 0.12) * (0.4 + 0.6 * smooth01(c._go)) * c._gn;
        if (vk > 0.004) {
          if (facing > 0) putGlare(W[FX.veil], gx, vy, gz, T.wid * 2.5, 2.2, 9, d3, vk, vk * 0.86, vk * 0.66);
          else { const v = vk * 0.55 * (c.brake ? 1.8 : 1); putGlare(W[FX.veil], gx, vy, gz, T.wid * 2.2, 2.0, 7, d3, v, v * 0.09, v * 0.05); }
        }
      }
      if (lampsOn) {
        const spread = 1 + Math.min(3, d3 * 0.045);
        const hv = Math.min(1, d3 / 14) * 0.62 + 0.14;
        for (let k = 0; k < nL; k++) {
          const Lp = T.lamps[k], idx = nLamp++;
          const lx = LP[k * 3], ly = LP[k * 3 + 1], lz = LP[k * 3 + 2];
          _q2.setFromAxisAngle(UPY, Lp.dir > 0 ? 0 : Math.PI);
          _q3.copy(_q).multiply(_q2);
          _m.compose(_p.set(lx, ly, lz), _q3, _s.set(Lp.w, Lp.h, 1));   // lens core: constant in world space, stays a hot point
          lamps.setMatrixAt(idx, _m);
          let r, g, b, hs;
          if (Lp.role === 'head') { const v = head; r = v; g = v * 0.97; b = v * 0.90; hs = 2.3; }
          else if (Lp.role === 'tail') { const v = tailBase * (c.brake ? 2.6 : c.parked ? 1.7 : 1); r = v * 1.05; g = v * 0.07; b = v * 0.05; hs = 1.9; }
          else if (Lp.role === 'mark') { const v = 0.16 + 1.25 * night; r = v; g = v * 0.70; b = v * 0.26; hs = 2.6; }
          else if (Lp.role === 'rmark') { const v = 0.1 + 0.95 * night; r = v * 1.05; g = v * 0.08; b = v * 0.05; hs = 2.4; }
          else if (Lp.role === 'rev') { const v = 0.09; r = v; g = v; b = v * 1.06; hs = 0.001; }
          else {
            // (an unlit turn lens is still amber glass: a bus's rear clusters read as their three colours at rest)
            const on = (Lp.role === 'indL' ? c.indL : c.indR) && blink;
            const v = on ? 1.7 : c.big ? 0.09 : 0.02; r = v; g = v * 0.44; b = v * 0.04; hs = on ? 2.0 : 0.001;
          }
          lamps.setColorAt(idx, _c.setRGB(r, g, b));
          const hx = lx + fx_ * Lp.dir * 0.03, hy = ly, hz = lz + fz_ * Lp.dir * 0.03;
          if (hs > 0.01) putHalo(hx, hy, hz, Lp.w * hs * 1.25 * spread, Lp.h * hs * 1.9, 0, d3, r * 0.22 * hv, g * 0.22 * hv, b * 0.22 * hv);
          if (d3 > 25 && hs > 0.01) {
            _m.compose(_p.set(hx, hy, hz), cam.quaternion, _s.set(Lp.w * hs * 3.4, Lp.h * hs * 5.0, 1));
            putFx(W[FX.star], r * 0.055 * hv, g * 0.055 * hv, b * 0.055 * hv);
          }
          // through the crowd: only a lens with a clear line flares; the amber 車幅灯 along a bus or truck roof sit
          // above the heads and glow wherever they are seen
          if (glareK > 0 && facing * Lp.dir > 0.25 && Lp.role !== 'indL' && Lp.role !== 'indR' && Lp.role !== 'rev') {
            const lv = c._lv ? c._lv[k * 3 + 1] : 0;
            if (Lp.role === 'mark' || Lp.role === 'rmark') {
              const mk = glareK * 0.3 * lv * c._gn;
              if (mk > 0.01) putGlare(W[FX.halo], hx, hy, hz, 0.7, 0.7, 6, d3, r * mk, g * mk, b * mk);
            } else if (lv > 0.5) {
              const lvK = lv * starK * c._gn * (Lp.role === 'head' ? 0.8 : 0.5);
              if (lvK > 0.01) {
                putGlare(W[FX.halo], hx, hy, hz, Lp.w * 3.2, Lp.w * 3.2, 11, d3, r * lvK * 0.45, g * lvK * 0.45, b * lvK * 0.45);
                putGlare(W[FX.star], hx, hy, hz, Lp.w * 9, Lp.h * 10, 12, d3, r * lvK, g * lvK, b * lvK);
              }
            } else {
              // behind somebody: the lamp still twinkles through the gaps between them, small and dim
              const lvK = STAR_LEAK * starK * c._gn * (Lp.role === 'head' ? 1 : 0.6);
              if (lvK > 0.01) putGlare(W[FX.star], hx, hy, hz, Lp.w * 2.2, Lp.h * 2.6, 3, d3, r * lvK, g * lvK, b * lvK, behind(c, k));
            }
          }
          // the lamp on the wet road: only lamps pointing roughly at the camera leave a visible streak
          if (reflOn && (Lp.role === 'head' || Lp.role === 'tail') && facing * Lp.dir > -0.2) {
            const k2 = Lp.role === 'head' ? 1.0 : c.brake ? 1.2 : 0.7;
            putRefl(lx, ly, lz, ground, Lp.w, r * k2, g * k2, b * k2, d3, facing * Lp.dir > 0.5);
          }
        }
      }

      // past D_LAMP: two soft dots per vehicle, sized in pixels, at the end that faces the camera
      if (!lampsOn && nL) {
        const away = facing < 0;
        const lampY = T.fam === 'bus' ? 1.0 : T.wheels === 6 ? 0.9 : (P.belt || 0.86) - 0.12;
        const ez = away ? P.zB : P.zF, lx0 = c.x + fx_ * ez, lz0 = c.z + fz_ * ez;
        const v = (away ? 2.2 : 2.8) * (0.25 + 0.75 * night) * (away && c.brake ? 1.6 : 1);
        const sz = Math.max(0.3, 3.2 * d3 * pxW);
        const nD = T.wheels === 2 ? 1 : 2;
        for (let k = 0; k < nD; k++) {
          const off = nD === 1 ? 0 : (k ? 1 : -1) * P.hw * 0.78;
          const lx = lx0 + fz_ * off, lz = lz0 - fx_ * off;
          _m.compose(_p.set(lx, ground + lampY, lz), cam.quaternion, _s.set(sz, sz, 1));
          streaks.setMatrixAt(nStreak, _m);
          if (away) streaks.setColorAt(nStreak, _c.setRGB(v, v * 0.09, v * 0.06)); else streaks.setColorAt(nStreak, _c.setRGB(v, v * 0.94, v * 0.82));
          nStreak++;
          if (reflOn && d3 < 240) putRefl(lx, ground + lampY, lz, ground, 0.3, away ? v * 0.5 : v * 0.35, away ? v * 0.045 : v * 0.33, away ? v * 0.03 : v * 0.29, d3, af > 0.5);
        }
      }

      if (trim) {
        const nP = T.wheels === 2 ? 1 : 2;
        for (let k = 0; k < nP; k++) {
          const front = nP === 2 && k === 0;
          const zz = front ? P.zF + 0.035 : P.zB - 0.035;
          const yy = T.fam === 'bus' || T.wheels === 6 ? 0.62 : (P.sillY !== undefined ? P.sillY + 0.15 : 0.5);
          _p.set(0, T.wheels === 2 ? 0.5 : yy, zz).applyQuaternion(_q).add(_v(c.x, y, c.z));
          _q2.setFromAxisAngle(UPY, front ? 0 : Math.PI);
          _q3.copy(_q).multiply(_q2);
          _m.compose(_p, _q3, _s.set(1, 1, 1));
          nPl = putTrim(plates, nPl, c.plateUv);
        }
        if (roofs && c.roofUv) {
          _p.set(0, P.roofY + 0.10, T.andonZ).applyQuaternion(_q).add(_v(c.x, y, c.z));
          _m.compose(_p, _q, _s.set(1, 1, 1));
          // 空車 lights the 行灯; with a fare aboard (賃走) it is switched off, which is how a Tokyo cab reads at night
          const lv = c.vacant ? 1 : 0.13;
          roofs.setColorAt(nRf, _c.setRGB(lv, lv, lv));
          nRf = putTrim(roofs, nRf, c.roofUv);
          if (c.vacant && night > 0.2) {
            const ax = _p.x, ay = _p.y, az = _p.z, rc = c.roofCol;
            const k = 0.8 * night * (0.5 + 0.5 * smooth01((d3 - 10) / 30));
            // Through the crowd the 行灯 is the one thing that says "taxi": where the line to its top clears the heads
            // its face is drawn depth-less (company colour and shape, never under 5 px) with a tight halo; where
            // somebody stands in the way, only a faint haze of its colour gets over the heads.
            // (a vacant cab standing in a red queue keeps its lit 行灯 over the crowd, the head of the queue brightest;
            //  somebody close to the eye still hides it)
            const qRed = andon && c.speed < 0.5 && c.e && c.e.sig && this.sigState(c.e) === 'red';
            const qHead = qRed && c.why === 'red';
            const ga = andon ? c._ga : 0;
            let av = andon && c._lv ? c._lv[nL * 3 + 1] * ga : 0;
            if (qRed) av = Math.max(av, (qHead ? 0.8 : 0.55) * ga);
            av *= c._gn;
            if (av > 0.02) {
              const pb = behind(c, nL);
              putRoofCard(c.roofUv, ax, ay, az, d3, (0.34 + 1.2 * night) * av, qRed ? 6 : 5, pb);
              const hk = k * 0.55 * av;
              putGlare(W[FX.halo], ax, ay + 0.02, az, 0.95, 0.5, 8, d3, rc.r * hk, rc.g * hk, rc.b * hk, pb);
            }
            const hz = andon ? k * 0.22 * (1 - av) * ga * c._gn * smooth01(c._go / 0.25) : 0;
            if (hz > 0.01) putGlare(W[FX.veil], ax, Math.max(ay, ground + 1.75) + 0.35, az, 1.5, 1.7, 13, d3, rc.r * hz, rc.g * hz, rc.b * hz);
            putHalo(ax, ay + 0.3, az, 1.5, 1.4, 8, d3, rc.r * k * 0.3, rc.g * k * 0.3, rc.b * k * 0.3);
          }
        }
        if (dests && c.destUv) {
          _p.set(0, 2.64, P.zF + P.destZ).applyQuaternion(_q).add(_v(c.x, y, c.z));
          _m.compose(_p, _q, _s.set(P.hw * 1.36, 0.30, 1));
          nDs = putTrim(dests, nDs, c.destUv, 0);
          if (facing > -0.1) {
            // the lit 方向幕 rides above the crowd line: where its line is clear its glow spills over the heads
            // (buildings still hide it); otherwise the halo stays in the depth buffer with the board
            const bx = _p.x + fx_ * 0.06, by = _p.y, bz = _p.z + fz_ * 0.06;
            const k = 0.34 * (0.3 + 0.7 * night);
            const dv = board && glareK > 0 && c._lv ? c._lv[nL * 3 + 4] * gs * c._gn * smooth01(c._go / 0.25) : 0;
            if (dv > 0.01) { const g2 = k * 1.3 * dv; putGlare(W[FX.halo], bx, by, bz, 2.8, 0.9, 12, d3, g2, g2 * 0.6, g2 * 0.12); }
            if (dv < 0.99) { const k2 = k * (1 - dv); putHalo(bx, by, bz, 2.6, 0.8, 10, d3, k2, k2 * 0.6, k2 * 0.12); }
          }
          _p.set(0.55, 2.62, P.zB - 0.030).applyQuaternion(_q).add(_v(c.x, y, c.z));
          _q2.setFromAxisAngle(UPY, Math.PI); _q3.copy(_q).multiply(_q2);
          _m.compose(_p, _q3, _s.set(0.56, 0.24, 1));
          nDs = putTrim(dests, nDs, c.destUv, 2);
          if (facing < 0.1) { const k = 0.22 * (0.3 + 0.7 * night); putHalo(_p.x - fx_ * 0.06, _p.y, _p.z - fz_ * 0.06, 1.0, 0.5, 7, d3, k, k * 0.6, k * 0.12); }
        }
        if (livs && c.livUv) {
          if (T.fam === 'bus') {
            for (const ad of P.ads) {
              _p.set(ad.s * (P.hw * 1.009 + 0.006), 0.90, ad.z).applyQuaternion(_q).add(_v(c.x, y, c.z));
              _q2.setFromAxisAngle(UPY, ad.s * Math.PI / 2); _q3.copy(_q).multiply(_q2);
              _m.compose(_p, _q3, _s.set(ad.l, 0.58, 1));
              nLv = putTrim(livs, nLv, c.livUv);
            }
          } else {
            const bB = P.zB, bF = P.zF - P.cabL + 0.06;
            for (let k = 0; k < 2; k++) {
              const sx = k ? 1 : -1;
              _p.set(sx * (P.hw * 1.024), (P.boxBot + P.boxTop) / 2, (bF + bB) / 2).applyQuaternion(_q).add(_v(c.x, y, c.z));
              _q2.setFromAxisAngle(UPY, sx * Math.PI / 2); _q3.copy(_q).multiply(_q2);
              _m.compose(_p, _q3, _s.set((bF - bB) * 0.88, (P.boxTop - P.boxBot) * 0.74, 1));
              nLv = putTrim(livs, nLv, c.livUv);
            }
          }
        }
        // kerb events: a van unloading with both rear doors swung open and parcels on the tarmac behind it; a cab
        // on a drop-off with its kerb-side rear door open
        if (c.doors && d3 <= D_IMPOSTOR) {
          const hw = P.hw, bB = P.zB, lw = hw * 0.95, a = 1.78, b0 = P.boxBot || 0.59, bh = (P.boxTop || 2.65) - b0;
          putKP(_mc, 0, b0 + 0.13, bB - 0.03, 0, hw * 1.22, bh - 0.28, 0.02, 0x0e0f11);
          for (let s = -1; s <= 1; s += 2) {
            const dxl = -s * Math.cos(a), dzl = -Math.sin(a);
            putKP(_mc, s * hw * 0.99 + dxl * lw / 2, b0 + 0.07, bB - 0.045 + dzl * lw / 2, Math.atan2(-dzl, dxl), lw, bh - 0.16, 0.05, c.color);
          }
          putKP(_mc, 0.25, 0, bB - 1.05, 0.25, 0.52, 0.42, 0.40, 0x9a774c);
          putKP(_mc, 0.22, 0.42, bB - 1.02, 0.08, 0.44, 0.34, 0.36, 0xa8845a);
          putKP(_mc, -0.35, 0, bB - 1.25, -0.2, 0.40, 0.30, 0.34, 0x8f6f47);
        }
        if (c.doorK > 0.01 && d3 <= D_IMPOSTOR && P.cabF !== undefined) {
          const wH = Math.min(0.42, P.roofY - P.belt - 0.12);
          if (P.slide) {
            // the JPN TAXI's rear door slides: back along the quarter panel on its tracks, standing 7 cm proud of it,
            // the dark opening between the B- and C-pillars behind it
            const zh = (P.pillarB[1] + P.pillarC[0]) / 2, L = P.pillarB[1] - P.pillarC[0], k = c.doorK;
            const sx = P.hw + 0.045 + 0.05 * k, sz = zh - L * 0.86 * k;
            putKP(_mc, P.hw * 1.004, P.sillY + 0.06, zh, 0, 0.012, P.belt + 0.30 - P.sillY, L * 0.96, 0x101216);
            putKP(_mc, sx, P.sillY + 0.05, sz, 0, 0.05, P.belt - P.sillY - 0.03, L, c.color);
            putKP(_mc, sx, P.belt + wH, sz, 0, 0.03, 0.035, L * 0.84, 0x18191c);
            putKP(_mc, sx, P.belt + 0.02, sz - L * 0.42, 0, 0.03, wH, 0.035, 0x18191c);
          } else {
            const span = P.cabF - P.cabR, zh = P.cabR + span * 0.52, L = span * 0.40, a = 1.05 * c.doorK;
            const dxl = Math.sin(a), dzl = -Math.cos(a), yaw = Math.atan2(-dzl, dxl);
            const x0 = P.hw + 0.02;
            // the dark opening in the body side, the door skin, and its window frame (the glass is wound down)
            putKP(_mc, P.hw * 1.004, P.sillY + 0.06, zh - L / 2, 0, 0.012, P.belt + 0.24 - P.sillY, L * 0.96, 0x101216);
            putKP(_mc, x0 + dxl * L / 2, P.sillY + 0.05, zh + dzl * L / 2, yaw, L, P.belt - P.sillY - 0.03, 0.05, c.color);
            putKP(_mc, x0 + dxl * L * 0.46, P.belt + wH, zh + dzl * L * 0.46, yaw, L * 0.84, 0.035, 0.03, 0x18191c);
            putKP(_mc, x0 + dxl * L * 0.88, P.belt + 0.02, zh + dzl * L * 0.88, yaw, 0.035, wH, 0.03, 0x18191c);
          }
        }
        // a bus at its のりば with the middle door open (東口 terminal): the dark doorway and its step, the two glazed
        // leaves slid out along the flank either side of it (glide-slide), and the lit step well
        if (c.doorK > 0.01 && d3 <= D_IMPOSTOR && T.fam === 'bus') {
          const k = c.doorK, zc = P.doorZ, xo = P.hw + 0.035;
          putKP(_mc, xo, 0.34, zc, 0, 0.012, 2.04, 0.80 * k, 0x07080a);
          putKP(_mc, xo - 0.02, 0.30, zc, 0, 0.04, 0.05, 0.80 * k, 0xd8d2b8);
          for (const sd of [-1, 1]) {
            const zl = zc + sd * (0.19 + 0.40 * k);
            putKP(_mc, xo + 0.03 + 0.05 * k, 0.40, zl, 0, 0.045, 1.94, 0.37, 0x1f2a33);
            putKP(_mc, xo + 0.03 + 0.05 * k, 0.40, zl + sd * 0.185, 0, 0.05, 1.94, 0.03, 0x9aa0a6);
          }
        }
        c.lit = true;
      }

      // Headlight pool on the road. Each slice is pitched to the gradient between its own two ends, so on 道玄坂 the
      // pool lies on the tarmac as one continuous patch; it stops at the rear bumper of the car in front.
      if (night > 0.2 && d3 < D_CONE && nL && !this.footAt(c, c.x + fx_ * (P.zF + 0.15), c.z + fz_ * (P.zF + 0.15))) {
        const wdt = (T.fam === 'bus' ? 4.2 : T.wheels === 2 ? 2.0 : 3.3) * (1 + wet * 0.2);
        let len = (T.fam === 'bus' ? 10 : T.wheels === 2 ? 5 : 7.5) * (0.85 + 0.2 * night);
        if (!c.parked && c.gapF < len + 0.5) len = Math.max(1.2, c.gapF + 0.4);
        const seg = len / CONE_SEG;
        let sx = c.x + fx_ * (P.zF + 0.15), sz = c.z + fz_ * (P.zF + 0.15);
        let sy = groundY(sx, sz);
        for (let k = 0; k < CONE_SEG; k++) {
          const ex = sx + fx_ * seg, ez = sz + fz_ * seg, ey = groundY(ex, ez);
          const rise = ey - sy;
          _e.set(-Math.atan2(rise, seg), c.yaw, 0); _q2.setFromEuler(_e);
          _m.compose(_p.set(sx, sy + 0.025, sz), _q2, _s.set(wdt, 1, Math.sqrt(sq(seg) + sq(rise)))).multiply(FLAT);
          putFx(WC[k], coneK, coneK * 0.949, coneK * 0.867);
          sx = ex; sz = ez; sy = ey;
        }
      }
    }

    // signal lenses at the outer junctions glow too
    if (this.sigHeads && night > 0.15) {
      for (const hd of this.sigHeads) {
        if (!hd.st) continue;
        const d3 = Math.sqrt(sq(hd.x - camX) + sq(hd.y - camY) + sq(hd.z - camZ));
        if (d3 > 260) continue;
        _sph.center.set(hd.x, hd.y, hd.z); _sph.radius = 2;
        if (!_frustum.intersectsSphere(_sph)) continue;
        const q = this.sigLensPos[hd.idx[hd.st]];
        const k = 0.28 * night;
        const col = SIG_COL[hd.st] || SIG_COL.red;
        putHalo(q.x, q.y, q.z, 1.1, 1.1, 8, d3, col[0] * k, col[1] * k, col[2] * k);
      }
    }

    const nFx = X.nFx;
    fin(wheels, nWheel); fin(wheelsNear, nWheelN); fin(this.wheelsHeavy, nWheelH); fin(this.wheelsCover, nWheelC); fin(contacts, nContact, true); fin(shadowOnly, nSh);
    fin(lamps, nLamp, true); fin(streaks, nStreak, true); fin(fx, nFx, true, 'aUvT'); fin(glare, X.nGl, true, 'aUvT'); fin(kp, X.nKp, true);
    fin(plates, nPl, false, 'aUvOff'); fin(roofs, nRf, true, 'aUvOff'); fin(dests, nDs, false, 'aUvOff'); fin(livs, nLv, false, 'aUvOff');
    fin(X.roofGl, X.nRg, true, 'aUvOff');
    if (this.saloon) {
      fin(this.saloon, nSal); fin(this.paxGlass, nSal);
      if (this.paxOn) this.paxPose(night);
      // the glazing: tinted and mirroring the sky by day, near clear over the lit saloon at night
      this.paxGlassMat.opacity = 0.38 - 0.22 * night;
      // its programs off the frame, once lighting has hooked the scene (hidden meshes are not in the boot's precompile)
      if (!this._paxPre && engine.precompile && engine.stats && engine.stats.frame > 6) {
        this._paxPre = true;
        for (const im of [this.paxGlass, this.saloon]) { const v = im.visible; im.visible = true; engine.precompile(im); im.visible = v; }
      }
    }
    if (this.roofMat) { const v = 0.34 + 1.20 * night; this.roofMat.color.setRGB(v, v, v); }
    if (this.destMat) { const v = 0.80 + 0.70 * night; this.destMat.color.setRGB(v, v, v); }
    for (let i = 0; i < this._bodyList.length; i++) {
      const im = this._bodyList[i];
      im.count = im.__n;
      im.visible = im.__n > 0;
      upload(im.instanceMatrix, im.__n, 16);
      if (im.__cd) { upload(im.instanceColor, im.__n, 3); im.__cd = 0; }
      const sg = im.geometry.attributes.aSign;
      if (sg && im.__sd) { upload(sg, im.__n, 1); im.__sd = 0; }
    }
    this.updateSignalHeads();
    if (this.dbg) this.dumpDbg(cam, nStreak, nFx, nContact);
  },

  // A scooter's rider is baked into its body except the parts that move: the helmet, which turns to watch the lights
  // and the crossing while he waits, and his left leg — on the footboard while he rides, put down to the tarmac when
  // he stops. Unit boxes in the kerbProps mesh (no extra draw).
  riderParts(c, t) {
    const stop = c.speed < 0.2 && !c.parked;
    c.footK = (c.footK === undefined ? (stop ? 1 : 0) : c.footK) + ((stop ? 1 : 0) - (c.footK || 0)) * 0.12;
    const f = c.footK;
    // helmet + visor, turning about the neck
    const turn = stop ? Math.sin(t * 0.37 + c.id * 2.1) * 0.5 + Math.sin(t * 0.13 + c.id) * 0.25 : 0;
    putKP(_mc, 0, 1.44, -0.04, turn, 0.30, 0.28, 0.32, 0x1d2530);
    putKP(_mc, Math.sin(turn) * 0.16, 1.51, -0.04 + Math.cos(turn) * 0.16, turn, 0.22, 0.10, 0.03, 0x0b0d10);
    // left leg (+x): thigh from the hip, then the shin down to the footboard (riding) or out to the kerb side tarmac
    const hx = 0.16, hy = 0.94, hz = -0.04;
    const kx = 0.17 + 0.07 * f, ky = 0.80 - 0.10 * f, kz = 0.20 - 0.06 * f;
    const fx = 0.17 + 0.23 * f, fy = 0.47 - 0.42 * f, fz = 0.26 - 0.14 * f;
    limb(_mc, hx, hy, hz, kx, ky, kz, 0.13, 0x1b1f28);
    limb(_mc, kx, ky, kz, fx, fy, fz, 0.12, 0x1b1f28);
    putKP(_mc, fx, fy - 0.05, fz + 0.05, 0, 0.11, 0.09, 0.26, 0x101114);
    // what he carries: a courier's square insulated backpack worn high (its top clears the helmet), or a box on the rack
    const B = COURIER[(c.id * 7 + 3) % COURIER.length];
    if (B[2]) {
      putKP(_mc, 0, 1.24, -0.36, 0, 0.42, 0.44, 0.30, B[0]);
      putKP(_mc, 0, 1.52, -0.36, 0, 0.43, 0.05, 0.31, B[1]);
      for (const s of [-1, 1]) putKP(_mc, s * 0.13, 1.02, -0.215, 0, 0.045, 0.40, 0.03, 0x0e0f11);
    } else {
      putKP(_mc, 0, 0.86, -0.52, 0, 0.46, 0.44, 0.44, B[0]);
      putKP(_mc, 0, 1.12, -0.52, 0, 0.47, 0.05, 0.45, B[1]);
    }
  },

  // grid of the vehicles standing in view range (16 m cells), rebuilt once a frame for carBlocks / footAt. A cell is
  // { n, a }: its array keeps its slots from frame to frame (truncating it would give its backing store away)
  bucketCars() {
    const G = this._cg || (this._cg = new Map());
    const used = this._cgUsed || (this._cgUsed = []);
    for (let i = 0; i < used.length; i++) used[i].n = 0;
    used.length = 0;
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.hidden) continue;
      const key = ((Math.floor(c.x / 16) + 512) << 11) | (Math.floor(c.z / 16) + 512);
      let a = G.get(key);
      if (!a) { a = { n: 0, a: [] }; G.set(key, a); }
      if (!a.n) used.push(a);
      a.a[a.n++] = c;
    }
  },

  // does (x, z) lie inside the footprint of a vehicle other than self?
  footAt(self, x, z) {
    const G = this._cg;
    if (!G) return false;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
      const cell = G.get(((gx + 512) << 11) | (gz + 512));
      if (!cell) continue;
      for (let i = 0; i < cell.n; i++) {
        const o = cell.a[i];
        if (o === self) continue;
        const rx = x - o.x, rz = z - o.z;
        if (rx * rx + rz * rz > 36) continue;
        const f0 = Math.sin(o.yaw), f1 = Math.cos(o.yaw);
        if (Math.abs(rx * f1 - rz * f0) < o.w * 0.5 && Math.abs(rx * f0 + rz * f1) < o.l * 0.5) return true;
      }
    }
    return false;
  },

  // is the line from the eye to (bx, by, bz) cut by another vehicle's body anywhere along it? (the glare over the crowd is
  // depth-tested only against what stands within GLARE_PULL of the eye: a bus 20 m off has to hide a cab behind it here)
  carBlocks(self, ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dz = bz - az, L = Math.sqrt(sq(dx) + sq(dz));
    if (L < 2) return false;
    const ux = dx / L, uz = dz / L;
    const G = this._cg;
    if (!G) return false;
    const st = this._cbS = (this._cbS || 0) + 1, ns = Math.ceil(L / 14);
    for (let q = 0; q <= ns; q++) {
     const cx = Math.floor((ax + dx * q / ns) / 16), cz = Math.floor((az + dz * q / ns) / 16);
     for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
      const cell = G.get(((gx + 512) << 11) | (gz + 512));
      if (!cell) continue;
      for (let i = 0; i < cell.n; i++) {
        const o = cell.a[i];
        if (o === self || o._cbS === st) continue;
        o._cbS = st;
        const t = (o.x - ax) * ux + (o.z - az) * uz;
        if (t < 1 || t > L - 0.3) continue;
        const hw = o.w * 0.5, hl = o.l * 0.5, f0 = Math.sin(o.yaw), f1 = Math.cos(o.yaw);
        // the ray's 2D slab test against the body's footprint, then the height of the ray where it crosses
        const rx = ax - o.x, rz = az - o.z;
        const lx = rx * f1 - rz * f0, lz = rx * f0 + rz * f1, ldx = dx * f1 - dz * f0, ldz = dx * f0 + dz * f1;
        let t0 = 0, t1 = 1;
        if (Math.abs(ldx) < 1e-9) { if (Math.abs(lx) > hw) continue; } else {
          let u0 = (-hw - lx) / ldx, u1 = (hw - lx) / ldx; if (u0 > u1) { const q = u0; u0 = u1; u1 = q; }
          t0 = Math.max(t0, u0); t1 = Math.min(t1, u1); if (t0 > t1) continue;
        }
        if (Math.abs(ldz) < 1e-9) { if (Math.abs(lz) > hl) continue; } else {
          let u0 = (-hl - lz) / ldz, u1 = (hl - lz) / ldz; if (u0 > u1) { const q = u0; u0 = u1; u1 = q; }
          t0 = Math.max(t0, u0); t1 = Math.min(t1, u1); if (t0 > t1) continue;
        }
        if (t1 > 0.995) t1 = 0.995;
        if (t0 > t1) continue;
        const top = (o.y || 0) + o.T.hgt * 0.94;
        if (Math.min(ay + (by - ay) * t0, ay + (by - ay) * t1) < top) return true;
      }
     }
    }
    return false;
  },

  // every mesh this module submits, with its live instance count and triangle bill
  meshBill() {
    const all = [...this._bodyList, this.wheels, this.wheelsNear, this.wheelsHeavy, this.wheelsCover, this.shadowOnly, this.lamps, this.fx, this.glare, this.streaks,
      this.contacts, this.plates, this.destBoards, this.liveries, this.kerbProps, this.sigLens, this.roofGl, ...this.roofs, this.saloon, this.paxGlass];
    const gi = (m) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    let tris = 0, draws = 0;
    const rows = [];
    for (const im of all) {
      if (!im) continue;
      const t = gi(im);
      if (im.visible !== false && im.count > 0) { tris += im.count * t; draws++; }
      if (im.count > 0) rows.push(`${im.name.replace('traffic:', '')} ${im.count}x${t}`);
    }
    return { tris, draws, rows };
  },

  // ?tdbg=1 — where every vehicle lands on screen, for framing work
  dumpDbg(cam, nStreak, nCone, nContact) {
    this.dbg = false;
    const W = this.engine.renderer.domElement.width, H = this.engine.renderer.domElement.height;
    const rows = [];
    for (const c of this.cars) {
      _p.set(c.x, groundY(c.x, c.z) + c.T.hgt * 0.5, c.z).project(cam);
      if (_p.z > 1) continue;
      const sx = Math.round((_p.x * 0.5 + 0.5) * W), sy = Math.round((-_p.y * 0.5 + 0.5) * H);
      if (sx < -80 || sx > W + 80 || sy < -80 || sy > H + 80) continue;
      const d = Math.round(Math.hypot(c.x - cam.position.x, c.z - cam.position.z));
      rows.push(`${c.key}${c.parked ? '*' : ''} ${sx},${sy} d${d} px${Math.round((c.T.hgt / Math.max(1, d)) * H * 0.5 / Math.tan(cam.fov * Math.PI / 360))}`);
    }
    rows.sort();
    let live = 0;
    for (const im of this._bodyList) live += im.__n;
    const bill = this.meshBill();
    const fronts = [];
    for (const e of this.lanes) {
      if (!e.sig || !e.cars.length) continue;
      const f = e.cars[e.cars.length - 1];
      fronts.push(`${e.sig.node.cfg.id}/${e.road}k${e.k} ${this.sigState(e)} n${e.cars.length} front ${f.key} toEnd ${(e.len - f.s - f.l / 2).toFixed(1)} v ${f.speed.toFixed(1)} ${f.why || ''}${f.whyO && f.whyO.id !== undefined ? '#' + f.whyO.id : ''}`);
    }
    for (const c of this.cars) {
      if (c.hidden || !c.e || c.e.kind !== 'conn') continue;
      fronts.push(`  in ${c.e.node.cfg ? c.e.node.cfg.id : 'node' + c.e.node.id} conn${c.e.id} ${c.e.type}${c.e.turn || ''} ${c.key} s ${c.s.toFixed(1)}/${c.e.len.toFixed(0)} v ${c.speed.toFixed(1)} ${c.why || ''}${c.whyO && c.whyO.id !== undefined ? '#' + c.whyO.id : ''}${c.whyO && c.whyO.key ? ' ' + c.whyO.key + ' ' + c.whyO.e.kind + c.whyO.e.id + ' s' + c.whyO.s.toFixed(1) + ' ' + c.whyO.why : ''}`);
    }
    const audit = this.audit();
    console.info(`[traffic:dbg] phase ${this.phase} ${this.phaseT.toFixed(1)} overlaps ${audit.overlaps} pave ${audit.pave} pool ${this.pool.length}\n  ` + fronts.join('\n  '));
    console.info(`[traffic:dbg] cpu sim ${(this._msSim || 0).toFixed(2)} ms, all ${(this._msAll || 0).toFixed(2)} ms; env capture ${this._envMs} ms (worst frame ${this._envMax} ms, boot warm-up ${this._envWarmMs} ms) [${(this._envLog || []).join(' ')}]; onscreen ${rows.length}/${this.cars.length} drawn ${live} streak ${nStreak} cone ${nCone} contact ${nContact}`
      + `\n  bill ${bill.draws} draws / ${bill.tris} tris :: ${bill.rows.join(' | ')}\n  ` + rows.join('\n  '));
  },

  stats() {
    const byType = {};
    for (const c of this.cars) byType[c.key] = (byType[c.key] || 0) + 1;
    const pax = (this.paxBuses || []).map((c) => ({ id: c.id, d: +(c._paxD || 0).toFixed(1), riders: c._pax ? c._pax.filter((r) => r.p).length : 0 }));
    return { vehicles: this.cars.length, lanes: this.lanes.length, meshes: this.meshCount, byType, cycle: CYCLE_LEN, pax };
  },

  // ------------------------------------------------------------------------------------------ busPax
  // A/B at run time (shots, profiling): off puts every bus back on the interior map and takes the riders away
  setPax(on) {
    if (!this.saloon) return false;
    this.paxOn = !!on;
    if (!on) {
      for (const c of this.paxBuses || []) c._pax = null;
      if (this.paxBuses) this.paxBuses.length = 0;
      const cr = this.engine.get('crowd');
      if (cr && cr.scanR && cr.scanR.setStatics) cr.scanR.setStatics([], 'bus');
    }
    return true;
  },

  // Which buses carry people this frame: the nearest PAX_BUSES inside PAX_D (one already carrying keeps them to
  // PAX_OUT, and 2 m of preference over a newcomer). A change of that set re-casts the crowdScan statics channel 'bus'.
  paxPick(cx, cy, cz) {
    const cr = this._crowd || this.engine.get('crowd'), scan = cr && cr.scanR;
    const ok = !!(scan && scan.ready && scan.setStatics && scan.poseAnchor);
    const want = this._paxWant || (this._paxWant = []), cur = this.paxBuses || (this.paxBuses = []);
    want.length = 0;
    if (ok) {
      for (const c of this.cars) {
        if (c.T.fam !== 'bus' || c.hidden) continue;
        const dx = c.x - cx, dy = groundY(c.x, c.z) + c.T.hgt * 0.5 - cy, dz = c.z - cz, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        c._paxD = d - (c._pax ? 2 : 0);
        if (d < (c._pax ? PAX_OUT : PAX_D)) want.push(c);
      }
      want.sort((a, b) => a._paxD - b._paxD);
      if (want.length > PAX_BUSES) want.length = PAX_BUSES;
    }
    if (want.length === cur.length && want.every((c) => cur.includes(c))) return;
    for (const c of cur) if (!want.includes(c)) c._pax = null;
    for (const c of want) if (!c._pax) c._pax = this.paxCast(c, scan);
    cur.length = 0;
    for (const c of want) cur.push(c);
    if (!scan || !scan.setStatics) return;
    const list = [];
    for (const c of cur) for (const r of c._pax) list.push(r.e);
    const ps = scan.setStatics(list, 'bus') || [];
    let k = 0;
    for (const c of cur) for (const r of c._pax) r.p = ps[k++] || null;
  },

  // Who rides this bus (the same people every time it comes near: seeded by its id). The driver is one of the suited
  // scans; the seats are taken at PAX_OCC, the strap-hangers stand in the front aisle facing the windows, each with
  // the right wrist at a strap. Each rider: its static entry and its matrix in the bus's frame (the pose's anchor —
  // the pelvis over the seat, the wrist under the strap — measured on that scan at the bake).
  paxCast(c, scan) {
    const S = BUS_SAL, out = [];
    let h = ((c.id + 1) * 2654435761) >>> 0;
    const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
    const live = scan.S.filter(Boolean);
    if (!live.length) return out;
    const suits = live.filter((Q) => Q.role === 'salaryman');
    const dKey = (suits.length ? suits : live)[c.id % (suits.length || live.length)].key;
    const cast = live.map((Q) => Q.key).filter((k) => k !== dKey);
    for (let i = cast.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = cast[i]; cast[i] = cast[j]; cast[j] = t; }
    // the tourists / hikers carry packs, which a seat back would cut through: they stand, first in the strap queue
    const tourist = new Set(live.filter((Q) => Q.role === 'tourist').map((Q) => Q.key));
    const seated = cast.filter((k) => !tourist.has(k)), standing = cast.filter((k) => tourist.has(k)).concat(seated.slice().reverse());
    let ci = 0, ti = 0;
    const cap = MOBILE ? 8 : 24;
    const place = (key, clip, tx, ty, tz, yaw) => {
      if (out.length >= cap + 1) return false;
      const a = scan.poseAnchor(key, clip); if (!a) return false;
      const [ax, ay, az, si, hgt] = a, cy = Math.cos(yaw), sy = Math.sin(yaw);
      // the anchor's target in the bus frame; the root is that less the anchor turned by the rider's yaw
      const ox = ax * cy + az * sy, oz = -ax * sy + az * cy;
      const y = clip === 'bus_sit' ? ty + 0.11 * hgt / 1.784 - ay : ty;
      const L = new THREE.Matrix4().compose(new THREE.Vector3(tx - ox, y, tz - oz), new THREE.Quaternion().setFromAxisAngle(UPY, yaw), new THREE.Vector3(si, si, si));
      out.push({ e: { key, clip, x: c.x, y: c.y || 0, z: c.z, yaw: 0, phase: rnd(), midD: PAX_MID }, L, yaw, p: null });
      return true;
    };
    // the driver, then whoever has each seat (the pelvis 6 cm behind the cushion's middle, toward the backrest)
    place(dKey, 'bus_sit', S.driver[0], S.driver[2], S.driver[1] - 0.06, 0);
    for (const [x, z, y] of S.seats) if (rnd() < PAX_OCC && seated.length) place(seated[ci++ % seated.length], 'bus_sit', x, y, z - 0.06, 0);
    // strap-hangers: 1-4 (on a phone 0-1), no two within 0.6 m on the same rail, facing the rail's own side
    const n = MOBILE ? (rnd() < 0.5 ? 1 : 0) : 1 + Math.floor(rnd() * 4), taken = [];
    const straps = S.straps.slice();
    for (let i = straps.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = straps[i]; straps[i] = straps[j]; straps[j] = t; }
    for (const [s, z] of straps) {
      if (taken.length >= n || !standing.length) break;
      if (taken.some((q) => q[0] === s && Math.abs(q[1] - z) < 0.6)) continue;
      if (place(standing[ti++ % standing.length], 'bus_strap', s * S.railX, S.floorF, z, s * Math.PI / 2)) taken.push([s, z]);
    }
    return out;
  },

  // Every rider's world matrix from its bus's (the body's own pose: pitch, yaw, roll, the road bob), each frame after
  // the bodies are placed, whether or not the bus is in view; and the saloon's ceiling light on them.
  paxPose(night) {
    const k = 0.24 + 0.30 * night, rim = PAX_RIM;
    rim[0] = -rimWord(0.84 * k, 0.89 * k, 0.95 * k);
    for (const c of this.paxBuses) {
      if (!c._pax || !c._pax.length) continue;
      _e.set(c.pitch || 0, c.yaw, c.roll || 0); _q.setFromEuler(_e);
      _mb.compose(_p.set(c.x, c.y || 0, c.z), _q, _s.set(1, 1, 1));
      for (const r of c._pax) {
        const p = r.p; if (!p) continue;
        _m2.multiplyMatrices(_mb, r.L);
        const el = _m2.elements;
        if (!p.mw) p.mw = new Float32Array(16);
        for (let i = 0; i < 16; i++) p.mw[i] = el[i];
        p.x = el[12]; p.gy = el[13]; p.z = el[14]; p.yaw = c.yaw + r.yaw;
        p._rim = rim;
      }
    }
  },

  // Body pitch about local x. +x rotation dips the nose (+z), so a car climbing (front higher, slope > 0) needs the
  // negative of the gradient; braking adds a nose dive, accelerating a squat.
  pitchOf(c, slope) { return -slope - clamp((c.accLP || 0) * 0.008, -0.03, 0.036); },

  // Hard facts for tests: pairs of vehicle bodies that overlap, and bodies with a corner on the pavement.
  audit(shrink = 0.04) {
    const act = this.cars.filter((c) => !c.hidden);
    const out = { overlaps: 0, pairs: [], pave: 0, paveCars: [] };
    const box = (c) => {
      const f = [Math.sin(c.yaw), Math.cos(c.yaw)], s = [Math.cos(c.yaw), -Math.sin(c.yaw)];
      return { x: c.x, z: c.z, f, s, hl: c.l / 2 - shrink, hw: c.w / 2 - shrink };
    };
    const B = act.map(box);
    const proj = (b, ax) => b.hl * Math.abs(b.f[0] * ax[0] + b.f[1] * ax[1]) + b.hw * Math.abs(b.s[0] * ax[0] + b.s[1] * ax[1]);
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const a = B[i], b = B[j], dx = b.x - a.x, dz = b.z - a.z;
      if (Math.abs(dx) > a.hl + b.hl + 1 || Math.abs(dz) > a.hl + b.hl + 1) continue;
      let sep = false;
      for (const ax of [a.f, a.s, b.f, b.s]) {
        if (Math.abs(dx * ax[0] + dz * ax[1]) > proj(a, ax) + proj(b, ax)) { sep = true; break; }
      }
      if (!sep) { out.overlaps++; if (out.pairs.length < 12) out.pairs.push([act[i], act[j]]); }
    }
    const f = this.field;
    if (f) for (let i = 0; i < act.length; i++) {
      const b = B[i];
      for (const u of [-1, 1]) for (const v of [-1, 1]) {
        const x = b.x + b.f[0] * b.hl * u + b.s[0] * b.hw * v, z = b.z + b.f[1] * b.hl * u + b.s[1] * b.hw * v;
        if (f.sample(x, z) > 0) { out.pave++; if (out.paveCars.length < 12) out.paveCars.push(act[i]); }
      }
    }
    return out;
  },

  dispose() {
    if (this.group) this.group.parent && this.group.parent.remove(this.group);
  },
};

// ---------------------------------------------------------------------------------------------- per-frame draw helpers
// writeMatrices' helpers, hoisted out of it so a frame allocates nothing: they share this context, filled at its top.
const WX = {
  tr: null, fx: null, glare: null, roofGl: null, kp: null, uvT: null, glUv: null, rgUv: null,
  nFx: 0, nGl: 0, nRg: 0, nKp: 0, fxCap: 0, glCap: 0, rgCap: 0, kpCap: 0,
  cam: null, camX: 0, camY: 0, camZ: 0, camG: 0, pxW: 0, wet: 0, fr: 0, occ: null, cr: null, W: null,
  self: null, go: 0, hv: null,
};
const SIG_COL = { green: [0.1, 1, 0.65], amber: [1, 0.6, 0.05], red: [1, 0.08, 0.03] };
// scooter riders' loads: [bag or box colour, band colour, 1 = backpack / 0 = box on the rack]. Food-delivery black with a
// green band, red, teal; a konbini-white and an orange box for the 出前 scooters.
const COURIER = [
  [0x16181b, 0x39b54a, 1], [0xc8262c, 0xf4f4f2, 1], [0x139fae, 0xf4f4f2, 1], [0xe7e9ea, 0x2a5aa0, 0],
  [0x16181b, 0x39b54a, 1], [0x1c1c1c, 0xf2c200, 1], [0xd8452e, 0x202020, 0], [0xd23a2a, 0xf4f4f2, 1],
];
// the 駅前通り zebras' aspects (xingState), shared: a frame allocates nothing
const XS_WALK = Object.freeze({ veh: 'red', ped: 'walk' }), XS_FLASH = Object.freeze({ veh: 'red', ped: 'flash' });
const XS_AMBER = Object.freeze({ veh: 'amber', ped: 'stop' }), XS_RED = Object.freeze({ veh: 'red', ped: 'stop' });
const XS_GREEN = Object.freeze({ veh: 'green', ped: 'stop' });
function occN(occ) { let n = 0; for (let i = 0; i < occ.length; i++) if (occ[i]) n++; return n; }
const LPB = new Float32Array(24 * 3);                  // a vehicle's lamps (+ its 行灯 and 方向幕) in the world
const _SP = new Float32Array(24 * 3), _SK = new Int16Array(24), _SO = new Float32Array(24);

// one instance of the fx atlas, with the matrix already in _m
function putFx(win, r, g, b) {
  const X = WX;
  if (X.nFx >= X.fxCap) return;
  X.fx.setMatrixAt(X.nFx, _m);
  X.fx.setColorAt(X.nFx, _c.setRGB(r, g, b));
  const o = X.nFx * 4, u = X.uvT;
  u[o] = win[0]; u[o + 1] = win[1]; u[o + 2] = win[2]; u[o + 3] = win[3];
  X.nFx++;
}
// a quad laid on the road from (sx, sz) along (ux, uz), pitched to the gradient between its ends (plus the rise of
// the road under its middle, so a long one never cuts into a crest)
function flatQuad(sx, sz, ux, uz, len, wd) {
  const ex = sx + ux * len, ez = sz + uz * len;
  const y0 = groundY(sx, sz), y1 = groundY(ex, ez);
  const lift = len > 12 ? Math.max(0, groundY(sx + ux * len * 0.5, sz + uz * len * 0.5) - (y0 + y1) * 0.5) : 0;
  _e.set(-Math.atan2(y1 - y0, len), Math.atan2(ux, uz), 0); _q2.setFromEuler(_e);
  _p.set(sx, y0 + 0.03 + lift, sz);
  _m.compose(_p, _q2, _s.set(wd, 1, Math.sqrt(sq(len) + sq(y1 - y0)))).multiply(FLAT);
}
// A lamp on the wet road. The mirror image of a lamp h above the road sits h/(H+h) of the way from its foot to the eye
// (H = eye height); roughness smears it about twice that. Past it the smear runs on toward the eye, 0.9 of the way,
// spreading as it comes (the further the light has run across a rough wet road, the wider it is smeared) and broken
// by the rain on the water film (the fx shader's shimmer): a cab 60 m off lays a dim white or red smear through the legs
// of the crowd in front, the dimmer the more crowd stands on it (X.go), dying away over its last stretch. A lamp standing
// inside another vehicle's footprint throws nothing, and no smear runs on under a bus or a truck (hvCut).
function putRefl(lx, ly, lz, gy, w, r, g, b, d3, toward) {
  const X = WX;
  const tx = X.camX - lx, tz = X.camZ - lz, th = Math.sqrt(sq(tx) + sq(tz)) || 1;
  const ux = tx / th, uz = tz / th;
  const h = Math.max(0.2, ly - gy), H = Math.max(0.3, X.camY - X.camG), wet = X.wet;
  const sx = lx + ux * 0.15, sz = lz + uz * 0.15;
  if (X.tr.footAt(X.self, sx, sz)) return;
  const run = hvCut(X.self, sx, sz, ux, uz, Math.min(0.9 * th, 80));
  const len = Math.min(0.8 * th, clamp(2.4 * th * h / (H + h) + 0.6, 0.8, 34) * (0.6 + 0.4 * wet), run);
  if (len < 0.3) return;
  const fade = wet * clamp(1.4 - d3 / 160, 0, 1) * (toward ? 0.42 : 0.3) * clamp((ly - gy) / 0.5, 0.4, 1.4);
  const wd = Math.max(w * 1.3, 3 * d3 * X.pxW) * (toward ? 1.5 : 1);
  flatQuad(sx, sz, ux, uz, len, wd);
  putFx(X.W[FX.refl], r * fade, g * fade, b * fade);
  const t0 = len * 0.42, Lt = run - t0;
  if (Lt > 3 && fade > 0.004) {
    flatQuad(sx + ux * t0, sz + uz * t0, ux, uz, Lt, wd * 1.3 * (1 + 0.012 * Lt));
    const k = fade * (toward ? 0.32 : 0.26) * (1 - 0.7 * X.go);
    putFx(X.W[FX.tail], r * k, g * k, b * k);
  }
}
// how far a line on the road from (sx, sz) along (ux, uz) runs before it passes under a bus, truck or van (X.hv), up to L
function hvCut(self, sx, sz, ux, uz, L) {
  const hv = WX.hv;
  if (!hv) return L;
  for (let i = 0; i < hv.length; i++) {
    const o = hv[i];
    if (o === self) continue;
    const rx = sx - o.x, rz = sz - o.z;
    if (rx * rx + rz * rz > (L + 8) * (L + 8)) continue;
    const f0 = Math.sin(o.yaw), f1 = Math.cos(o.yaw), hw = o.w * 0.5, hl = o.l * 0.5;
    const lx = rx * f1 - rz * f0, lz = rx * f0 + rz * f1, dx = ux * f1 - uz * f0, dz = ux * f0 + uz * f1;
    let t0 = 0, t1 = L;
    if (Math.abs(dx) < 1e-9) { if (Math.abs(lx) > hw) continue; } else {
      let u0 = (-hw - lx) / dx, u1 = (hw - lx) / dx; if (u0 > u1) { const q = u0; u0 = u1; u1 = q; }
      if (u0 > t0) t0 = u0; if (u1 < t1) t1 = u1; if (t0 > t1) continue;
    }
    if (Math.abs(dz) < 1e-9) { if (Math.abs(lz) > hl) continue; } else {
      let u0 = (-hl - lz) / dz, u1 = (hl - lz) / dz; if (u0 > u1) { const q = u0; u0 = u1; u1 = q; }
      if (u0 > t0) t0 = u0; if (u1 < t1) t1 = u1; if (t0 > t1) continue;
    }
    if (t0 < L) L = t0;
  }
  return L;
}
// a camera-facing glow of at least minPx pixels: in the depth buffer (fx) or through everything (glare)
function putHalo(x, y, z, w, h, minPx, d3, r, g, b) {
  const m = minPx * d3 * WX.pxW;
  _m.compose(_p.set(x, y, z), WX.cam.quaternion, _s.set(Math.max(w, m), Math.max(h, m * (h / w)), 1));
  putFx(WX.W[FX.halo], r, g, b);
}
// (depth-tested, pulled in to GLARE_PULL from the eye: see there)
function pullIn(x, y, z, pull = GLARE_PULL) {
  const X = WX, dx = x - X.camX, dy = y - X.camY, dz = z - X.camZ, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const k = d > pull ? pull / d : 1;
  _p.set(X.camX + dx * k, X.camY + dy * k, X.camZ + dz * k);
  return k;
}
function putGlare(win, x, y, z, w, h, minPx, d3, r, g, b, pull = GLARE_PULL) {
  const X = WX;
  if (X.nGl >= X.glCap) return;
  const m = minPx * d3 * X.pxW, k = pullIn(x, y, z, pull);
  _m.compose(_p, X.cam.quaternion, _s.set(Math.max(w, m) * k, Math.max(h, m * (h / w)) * k, 1));
  X.glare.setMatrixAt(X.nGl, _m);
  X.glare.setColorAt(X.nGl, _c.setRGB(r, g, b));
  const o = X.nGl++ * 4, u = X.glUv;
  u[o] = win[0]; u[o + 1] = win[1]; u[o + 2] = win[2]; u[o + 3] = win[3];
}
// a lit 行灯's own face, camera-facing over the crowd (pulled in like the glare), never under minPx tall (its atlas cell:
// company colour and shape)
function putRoofCard(uv, x, y, z, d3, v, minPx = 5, pull = GLARE_PULL) {
  const X = WX;
  if (!X.roofGl || X.nRg >= X.rgCap) return;
  const h = Math.max(0.19, minPx * d3 * X.pxW), k = pullIn(x, y, z, pull);
  _m.compose(_p, X.cam.quaternion, _s.set(h * (0.50 / 0.19) * k, h * k, 1));
  X.roofGl.setMatrixAt(X.nRg, _m);
  X.roofGl.setColorAt(X.nRg, _c.setRGB(v, v, v));
  X.rgUv[X.nRg * 2] = uv[0]; X.rgUv[X.nRg * 2 + 1] = uv[1];
  X.nRg++;
}
// How much of a vehicle's light can reach the eye at all: nothing from behind a building or another vehicle (c._gs);
// how packed the crowd standing in between is (c._go, 0..1); and c._gn goes to 0 when somebody within 12 m of the eye
// stands on the line to the haze over the heads (vy), so nobody wears a lamp 50 m off on their head: it gates every
// glow drawn over the crowd (glare, veil, 行灯 card, 車幅灯, 方向幕). Re-tested every 4th frame, eased.
// A lit 行灯 (andon, its top at (ax, ay, az)) gets its own line (c._ga): standing a cab behind a sedan hides its lamps and
// its nose, never the 行灯 over the sedan's roof; behind a bus or a box truck it is gone.
function glVis(c, gx, gy, gz, vy, andon, ax, ay, az) {
  const X = WX, fr = X.fr;
  const fresh = c._gvF === undefined || fr - c._gvF > 4;
  if (fresh || ((fr + c.id) & 3) === 0) {
    c._gsT = (X.occ && occBlocked(X.occ, X.camX, X.camY, X.camZ, gx, gy, gz)) || X.tr.carBlocks(c, X.camX, X.camY, X.camZ, gx, gy, gz) ? 0 : 1;
    c._goT = X.cr ? crowdOcc(X.cr, X.camX, X.camZ, gx, gz) : 0;
    const nb = X.cr ? crowdBlocks(X.cr, X.camX, X.camY, X.camZ, gx, vy, gz) : -1;
    c._gnT = nb >= 0 && nb < 12 ? 0 : 1;
    c._gaT = andon ? ((X.occ && occBlocked(X.occ, X.camX, X.camY, X.camZ, ax, ay, az)) || X.tr.carBlocks(c, X.camX, X.camY, X.camZ, ax, ay, az) ? 0 : 1) : c._gsT;
    if (fresh) { c._gs = c._gsT; c._go = c._goT; c._gn = c._gnT; c._ga = c._gaT; }
    c._gvF = fr;
  }
  c._gs += (c._gsT - c._gs) * 0.3; c._go += (c._goT - c._go) * 0.3; c._gn += (c._gnT - c._gn) * 0.3; c._ga += (c._gaT - c._ga) * 0.3;
  return c._gs;
}
// the vehicle's lamps in the world (slots nL and nL+1 are left for its 行灯 and its 方向幕)
function lampPos(c, T, y, q) {
  for (let k = 0; k < T.lamps.length; k++) {
    const Lp = T.lamps[k];
    _p2.set(Lp.x, Lp.y, Lp.z).applyQuaternion(q);
    LPB[k * 3] = _p2.x + c.x; LPB[k * 3 + 1] = _p2.y + y; LPB[k * 3 + 2] = _p2.z + c.z;
  }
  return LPB;
}
// Which of a vehicle's lights have a clear line to the eye through the crowd: its lamps facing the eye, the top of a lit
// 行灯, a bus's 方向幕. c._lv[k*3] is the answer (1 clear, 0 behind somebody), c._lv[k*3+1] its eased value, so a lamp
// flashes through a gap instead of popping. One walk of the crowd grid serves them all (crowdBlocksMulti), every other
// frame.
// (c._lv[k*3+2]: how far from the eye the first person in the way stands, for the glow drawn behind them: see putGlare)
function seeLamps(c, LP, nL, facing, wantLamps, andon, board) {
  const X = WX;
  const lv = c._lv || (c._lv = new Float32Array((nL + 2) * 3).fill(-1));
  let n = 0;
  if (wantLamps) {
    for (let k = 0; k < nL; k++) {
      const Lp = c.T.lamps[k];
      if (facing * Lp.dir > 0.25 && Lp.role !== 'indL' && Lp.role !== 'indR' && Lp.role !== 'rev') n = spPut(n, k, LP[k * 3], LP[k * 3 + 1], LP[k * 3 + 2]);
    }
  }
  // (the top of a lit 行灯 and its glow, a quarter metre over its centre, is what gets over the heads)
  if (andon) n = spPut(n, nL, LP[nL * 3], LP[nL * 3 + 1] + 0.25, LP[nL * 3 + 2]);
  if (board) n = spPut(n, nL + 1, LP[nL * 3 + 3], LP[nL * 3 + 4], LP[nL * 3 + 5]);
  if (!n) return;
  let stale = false;
  for (let i = 0; i < n; i++) if (lv[_SK[i] * 3 + 1] < 0) stale = true;
  if (stale || ((X.fr + c.id) & 1) === 0) {
    crowdBlocksMulti(X.cr, X.camX, X.camY, X.camZ, _SP, n, _SO);
    for (let i = 0; i < n; i++) {
      const k = _SK[i];
      lv[k * 3] = _SO[i] < 0 ? 1 : 0;
      lv[k * 3 + 2] = _SO[i];
      if (lv[k * 3 + 1] < 0) lv[k * 3 + 1] = lv[k * 3];
    }
  }
  for (let i = 0; i < n; i++) { const k = _SK[i]; lv[k * 3 + 1] += (lv[k * 3] - lv[k * 3 + 1]) * 0.35; }
}
// where to hang a glow drawn over the crowd: GLARE_PULL from the eye, or just behind the first person in its way (so
// their head cuts it off and only what shows round it is drawn), whichever is further
function behind(c, k) {
  const t = c._lv ? c._lv[k * 3 + 2] : -1;
  return t > 0 ? Math.max(GLARE_PULL, t + 0.6) : GLARE_PULL;
}
function spPut(n, k, x, y, z) {
  if (n >= _SK.length) return n;
  _SK[n] = k; _SP[n * 3] = x; _SP[n * 3 + 1] = y; _SP[n * 3 + 2] = z;
  return n + 1;
}
// a kerb-event part: a unit box placed in the vehicle's frame (cm), turned by yaw about its own base
function putKP(cm, lx, ly, lz, yaw, sx, sy, sz, col) {
  const X = WX;
  if (X.nKp >= X.kpCap) return;
  _q2.setFromAxisAngle(UPY, yaw);
  _m2.compose(_p2.set(lx, ly, lz), _q2, _s2.set(sx, sy, sz));
  _m3.multiplyMatrices(cm, _m2);
  X.kp.setMatrixAt(X.nKp, _m3); X.kp.setColorAt(X.nKp++, _c.set(col));
}
// …and one laid from (x0, y0, z0) to (x1, y1, z1), th thick (a rider's limb)
function limb(cm, x0, y0, z0, x1, y1, z1, th, col) {
  const X = WX;
  if (X.nKp >= X.kpCap) return;
  _p2.set(x1 - x0, y1 - y0, z1 - z0);
  const L = _p2.length() || 1e-3;
  _q2.setFromUnitVectors(UPY, _p2.multiplyScalar(1 / L));
  _m2.compose(_p2.set(x0, y0, z0), _q2, _s2.set(th, L, th));
  _m3.multiplyMatrices(cm, _m2);
  X.kp.setMatrixAt(X.nKp, _m3); X.kp.setColorAt(X.nKp++, _c.set(col));
}
// finish a compacted instanced mesh: count, visibility, and upload only what was written
function fin(im, n, col, uv) {
  if (!im) return;
  im.count = n; im.visible = n > 0;
  if (!n) return;
  upload(im.instanceMatrix, n, 16);
  if (col) upload(im.instanceColor, n, 3);
  if (uv) upload(im.geometry.attributes[uv], n, uv === 'aUvT' ? 4 : 2);
}

const _vv = new THREE.Vector3();
function _v(x, y, z) { return _vv.set(x, y, z); }
function key6(T) { return T.wheels === 6; }

const _mc = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4(), _mb = new THREE.Matrix4();
// the saloon light on the bus riders: crowdScan's rim word, negative (a light they are inside), packed sqrt-RGB
const PAX_RIM = [0, 0, 0];
function rimWord(r, g, b) {
  const q = (v) => Math.round(Math.sqrt(clamp(v, 0, 1)) * 255);
  return q(r) * 65536 + q(g) * 256 + q(b);
}
const _p2 = new THREE.Vector3(), _s2 = new THREE.Vector3();

// append one compacted instance; the per-instance colour is only re-uploaded when the slot changes hands
// (the taxi 空車 flag whenever it flips: a cab that has dropped its fare lights up)
function putInstance(im, c, m) {
  const i = im.__n;
  if (i >= im.instanceMatrix.count) return;
  im.__n = i + 1;
  im.setMatrixAt(i, m);
  if (im.__slots[i] !== c) { im.__slots[i] = c; im.setColorAt(i, _c.set(c.color)); im.__cd = 1; }
  const sg = im.geometry.attributes.aSign;
  if (sg) { const v = c.vacant ? 1 : 0; if (sg.array[i] !== v) { sg.array[i] = v; im.__sd = 1; } }
}

// append one compacted trim instance (matrix in _m) with its atlas cell uv[o], uv[o + 1]
function putTrim(im, n, uv, o = 0) {
  if (n >= im.instanceMatrix.count) return n;
  im.setMatrixAt(n, _m);
  const a = im.geometry.attributes.aUvOff.array;
  a[n * 2] = uv[o]; a[n * 2 + 1] = uv[o + 1];
  return n + 1;
}

// upload only the first n items of an instanced buffer (three r186 update ranges)
function upload(attr, n, size) {
  if (!attr || n <= 0) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n * size);
  attr.needsUpdate = true;
}

// ---------------------------------------------------------------------------------------------- shots
export const shotPresets = {
  // 宮益坂 east arm: the westbound queue holding at the painted stop line during the scramble
  traffic_queue:   { pos: [47, 2.1, -9.5], lookAt: [20, 1.1, 3], t: 'night', fov: 42 },
  traffic_closeup: { pos: [34.5, 1.30, -3.0], lookAt: [28.0, 0.95, 3.2], t: 'night', fov: 38 },
  traffic_day:     { pos: [47, 2.1, -9.5], lookAt: [20, 1.1, 3], t: 'day', fov: 42 },
  traffic_wet:     { pos: [47, 2.1, -9.5], lookAt: [20, 1.1, 3], t: 'rain', fov: 42 },
  // 駅前通り south arm looking back at the crossing
  traffic_south:   { pos: [6, 2.2, 45], lookAt: [-14, 1.0, 24], t: 'night', fov: 45 },
  traffic_top:     { pos: [22, 44, 42], lookAt: [-6, 0, -4], t: 'night', fov: 45 },
  // hero framings that follow an actual vehicle instance so the shot never lands on empty tarmac
  traffic_car:    ({ engine }) => heroShot(engine, 'taxi', 'night'),
  traffic_car_day:({ engine }) => heroShot(engine, 'taxi', 'day'),
  traffic_sedan:  ({ engine }) => heroShot(engine, 'sedan', 'night'),
  traffic_km:     ({ engine }) => heroShot(engine, 'taxikm', 'night'),
  traffic_km_day: ({ engine }) => heroShot(engine, 'taxikm', 'day', 5.4, 1.7),
  // the JPN TAXI close up, at night: its nose three-quarters on (the short bonnet and fender mirrors, the raked screen
  // with the 空車 sign, the 行灯 on the roof's front edge) and its tail (the upright tailgate, the tall clusters, the
  // sliding door's track along the sill)
  // (the lens stands 5.6 m from the body's centre: 4 m off the near corner, the whole cab in frame)
  // (a 深藍 cab with its door shut, like the reference photo; not the KM green one, not one dropping a fare)
  taxi_closeup: ({ engine }) => heroShot(engine, 'taxikm', 'night', 5.6, 1.5, [0.80, -0.80], (v) => v.color !== 0x8d9840 && !v.doorK),
  taxi_rear:    ({ engine }) => heroShot(engine, 'taxikm', 'night', 5.6, 1.5, [2.40, -2.40], (v) => v.color !== 0x8d9840 && !v.doorK),
  // the ring of stopped traffic around the scramble during the all-red pedestrian phase, from above the
  // crowd's umbrella line — the queues are there in the hero framing too, they are just occluded at 1.6 m
  traffic_ring:     { pos: [-28, 5.6, 17], lookAt: [12, 1.0, -20], t: 'night', fov: 52 },
  traffic_ring_day: { pos: [-28, 5.6, 17], lookAt: [12, 1.0, -20], t: 'day', fov: 52 },
  // looking straight down the 公園通り queue from the MAGNET kerb
  traffic_koen:     { pos: [22, 2.3, -36], lookAt: [7, 1.2, -74], t: 'night', fov: 44 },
  traffic_koen_day: { pos: [22, 2.3, -36], lookAt: [7, 1.2, -74], t: 'day', fov: 44 },
  // 東口 タクシー乗り場 on 明治通り's west kerb, from its head: the line of cabs, and the lane they pull out into
  traffic_rank:     { pos: [158, 3.0, 12], lookAt: [150, 0.9, 36], t: 'night', fov: 44 },
  traffic_rank_day: { pos: [158, 3.0, 12], lookAt: [150, 0.9, 36], t: 'day', fov: 44 },
  // the 空車 line on 道玄坂's uphill kerb, looking down the hill toward 109
  traffic_dogen_rank: () => ({ pos: [-212, 3.2 + groundY(-212, 36), 36], lookAt: [-170, 1.0 + groundY(-170, 26), 26], t: 'night', fov: 42 }),
  // straight down on the new 駅前 layout: the throat, the fork, 南行 along the station and 北行 along Mark City
  traffic_island_top: { pos: [-10, 150, 82], lookAt: [-10, 0, 80], t: 'day', fov: 50 },
  traffic_ekimae_top: { pos: [-10, 150, 82], lookAt: [-10, 0, 80], t: 'day', fov: 50 },
  traffic_bus:    ({ engine }) => heroShot(engine, 'bus', 'night', 12, 2.4),
  traffic_truck:  ({ engine }) => heroShot(engine, 'truck', 'night', 9, 1.9),
  // the view most people get of a bus: its rear three-quarter from the pavement (clusters, rear window, route box)
  traffic_bus_rear: ({ engine }) => heroShot(engine, 'bus', 'night', 10.5, 1.7, [2.45, -2.45]),
  // a heavy wheel close up: the pressed-steel disc, the nut ring, the rear twin tyres
  traffic_bus_wheel: ({ engine }) => heroShot(engine, 'bus', 'night', 6.2, 1.1, [1.45, -1.45]),
  traffic_wheel:  ({ engine }) => heroShot(engine, 'sedan', 'night', 3.1, 0.75),
  traffic_scoot:  ({ engine }) => heroShot(engine, 'scooter', 'night', 3.6, 1.2),
  // mid 東西 green: traffic actually running through the box while the pedestrians wait
  traffic_flow:     ({ engine }) => flowShot(engine, 'night', [46, 5.5, -3.5], [0, 1.0, 1]),
  traffic_flow_day: ({ engine }) => flowShot(engine, 'day', [46, 5.5, -3.5], [0, 1.0, 1]),
  // the scramble from above during the east-west green: through traffic and the two kerb-side left turns
  // (道玄坂 → 公園通り, 宮益坂 → 駅前) on their arcs, everything else holding at the paint
  traffic_turns:     ({ engine }) => flowShot(engine, 'night', [-16, 58, 36], [-4, 0, -2], 55),
  traffic_turns_day: ({ engine }) => flowShot(engine, 'day', [-16, 58, 36], [-4, 0, -2], 55),
  traffic_turns_ns:  ({ engine }) => flowShot(engine, 'day', [-16, 58, 36], [-4, 0, -2], 55),
  // eye level on the 道玄坂 → 公園通り left turn
  traffic_turn_close: ({ engine }) => flowShot(engine, 'night', [6, 3.0, 2], [-14, 0.6, -12], 50),
  traffic_turn_wheel: ({ engine }) => turnWheelShot(engine),
  // 道玄坂 on its real gradient: tyres on the tarmac, bodies pitched with the hill
  traffic_dogenzaka_slope: () => ({ pos: [-166, 1.4 + groundY(-166, 17), 17], lookAt: [-196, 1.0 + groundY(-196, 30), 30], t: 'day', fov: 48 }),
  traffic_dogenzaka_slope_night: () => ({ pos: [-166, 1.4 + groundY(-166, 17), 17], lookAt: [-196, 1.0 + groundY(-196, 30), 30], t: 'night', fov: 48 }),
  // 駅前通り 南行 along the station: the north-south green running south past the bus stops
  traffic_hachiko_kerb: ({ engine }) => flowShot(engine, 'night', [-4, 11, 30], [-2, 0, 104], 52),
  traffic_ekimae_sb:    ({ engine }) => flowShot(engine, 'night', [-4, 11, 30], [-2, 0, 104], 52),
  // kerb events: a cab dropping its fare at the ハチ公 kerb (door open, hazards), a van unloading with its doors open
  traffic_drop: ({ engine }) => kerbShot(engine, (c) => c.willDrop && c.doorK > 0.5, 1, 6.2, 2.6, 1.55),
  traffic_van:  ({ engine }) => kerbShot(engine, (c) => c.doors, -1, 7.5, 2.2, 1.7),
  // the showpiece from 2 m further up the crowd's umbrella line, for judging the queue heads themselves
  traffic_heads: { pos: [-20, 2.6, 20], lookAt: [30, 6, -30], t: 'night', fov: 45 },
  // crossing_night's eye (1.6 m) through a long lens: what of the 宮益坂 and 公園通り queue heads clears the crowd
  traffic_tele_miyamasu: { pos: [-20, 1.6, 20], lookAt: [30, 1.9, 3], t: 'night', fov: 12 },
  traffic_tele_koen:     { pos: [-20, 1.6, 20], lookAt: [10, 1.9, -34], t: 'night', fov: 12 },
};

// Where in the 120 s cycle a traffic preset is captured (see init): ew green runs 86–112 s, ns green 0–26 s.
const SHOT_CYCLE = {
  traffic_flow: 99, traffic_flow_day: 99,
  traffic_turns: 97, traffic_turns_day: 97, traffic_turns_ns: 12, traffic_turn_close: 95, traffic_turn_wheel: 95,
  traffic_hachiko_kerb: 24, traffic_ekimae_sb: 24,
};
const SHOT_LEAD = 14;

function flowShot(engine, t, pos, lookAt, fov = 45) {
  return { pos, lookAt, t, fov };
}

// a close three-quarter view of whichever car is deepest into a left turn at the scramble: front wheels on lock
function turnWheelShot(engine, dist = 5.2, hgt = 1.6, fov = 40, side = 0.9) {
  const tr = engine.get('traffic');
  let c = null, best = 0;
  for (const v of (tr && tr.cars) || []) {
    if (v.hidden || v.parked || !v.e || v.e.kind !== 'conn' || !v.e.turn || v.T.fam === 'bus') continue;
    if (!v.e.node.cfg || v.e.node.cfg.id !== 'scramble') continue;
    if (Math.abs(v.steer) > best) { best = Math.abs(v.steer); c = v; }
  }
  if (!c) return { pos: [-24, 2.2, -24], lookAt: [-6, 0.8, -12], t: 'night', fov: 42 };
  const a = c.yaw + side;
  const gy = groundY(c.x, c.z);
  return { pos: [c.x + Math.sin(a) * dist, gy + hgt, c.z + Math.cos(a) * dist], lookAt: [c.x, gy + 0.6, c.z], t: 'night', fov };
}

// frame the kerb-event vehicle nearest the crossing: `side` +1 from its kerb side, −1 from behind on the road side
function kerbShot(engine, pick, side, dist, along, hgt) {
  const tr = engine.get('traffic');
  let c = null, best = 1e9;
  for (const v of (tr && tr.cars) || []) {
    if (v.hidden || !pick(v)) continue;
    const d = Math.hypot(v.x - CROSS[0], v.z - CROSS[1]);
    if (d < best) { best = d; c = v; }
  }
  if (!c) return { pos: [3, 1.6, 29], lookAt: [-5, 0.9, 34], t: 'night', fov: 44 };
  const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw), lx = Math.cos(c.yaw), lz = -Math.sin(c.yaw);
  const gy = groundY(c.x, c.z);
  const px = side > 0 ? c.x + lx * dist + fx * along : c.x - fx * dist - lx * along;
  const pz = side > 0 ? c.z + lz * dist + fz * along : c.z - fz * dist - lz * along;
  const ax = side > 0 ? 0 : -1.2;
  return { pos: [px, groundY(px, pz) + hgt, pz], lookAt: [c.x + fx * ax, gy + 0.95, c.z + fz * ax], t: 'night', fov: 44 };
}

function heroShot(engine, key, t, rad, hgt, offs = [0.85, -0.85, 2.3, -2.3], pref = null) {
  const tr = engine.get('traffic');
  const cars = tr && tr.cars;
  const r = rad || 7.6, y = hgt || 2.05;
  let c = null, best = -1e9, ba = 0.85;
  const O = tr && tr.occ;
  if (cars && cars.length) {
    for (const v of cars) {
      if (v.key !== key || v.hidden || (pref && !pref(v))) continue;
      const d = Math.hypot(v.x - CROSS[0], v.z - CROSS[1]);
      if (d < 14 || d > 95) continue;
      // three-quarter views from either side; the lens must stand in the open with a clear line to the vehicle
      for (const off of offs) {
        const a = v.yaw + off;
        const cx = v.x + Math.sin(a) * r, cz = v.z + Math.cos(a) * r;
        if (O && (occBlocked(O, cx, y, cz, v.x, 1.2, v.z) || occBlocked(O, v.x, y, v.z, cx, y, cz))) continue;
        let clear = 60;                                  // keep the lens out of another car's boot
        for (const o of cars) {
          if (o === v || o.hidden) continue;
          clear = Math.min(clear, Math.hypot(o.x - cx, o.z - cz) - o.T.len * 0.5);
        }
        const score = clear * 3 - Math.abs(d - 38) * 0.15 - Math.abs(Math.abs(off) - Math.abs(offs[0])) * 0.5;
        if (score > best) { best = score; c = v; ba = off; }
      }
    }
    if (!c) c = cars.find((v) => v.key === key) || cars[0];
  }
  if (!c) return { pos: [34, 1.5, -4], lookAt: [22, 1.0, 2], t, fov: 40 };
  const a = c.yaw + ba;
  if (offs.length === 2) {
    // (a framing that is about one end of the vehicle looks at that end, not at its middle)
    const e = Math.cos(ba) > 0 ? 0.55 : -0.55, lx = c.x + Math.sin(c.yaw) * c.T.len * e * 0.5, lz = c.z + Math.cos(c.yaw) * c.T.len * e * 0.5;
    return { pos: [c.x + Math.sin(a) * r, y, c.z + Math.cos(a) * r], lookAt: [lx, Math.min(1.1, y * 0.6), lz], t, fov: 38 };
  }
  return {
    pos: [c.x + Math.sin(a) * r, y, c.z + Math.cos(a) * r],
    lookAt: [c.x, Math.min(0.95, y * 0.5), c.z], t, fov: 36,
  };
}

export function selfTest(engine) {
  const problems = [];
  const tr = engine.get('traffic');
  if (!tr || !tr.cars.length) { problems.push('no vehicles'); return { problems }; }
  if (tr.edges.some((l) => !isFinite(l.len) || l.len <= 0)) problems.push('bad edge length');
  const scr = tr.lanes.filter((l) => l.sig && l.sig.node.ctrl && l.sig.node.ctrl.scramble);
  if (scr.length < 6) problems.push('scramble approaches missing: ' + scr.length);
  let got = null;
  const fn = (e) => { got = e; };
  engine.events.on('signal:phase', fn);
  tr.lastSig = null; tr.emitPhase();
  engine.events.off('signal:phase', fn);
  if (!got || !got.pedestrian || !got.vehicle) problems.push('signal:phase payload missing');
  if (CYCLE_LEN !== 120) problems.push('cycle is not 120 s');
  for (const c of tr.cars) {
    if (!isFinite(c.x) || !isFinite(c.z) || !isFinite(c.yaw)) { problems.push('NaN vehicle transform'); break; }
  }
  const a = tr.audit();
  if (a.overlaps) problems.push(`${a.overlaps} overlapping vehicle pairs`);
  if (a.pave) problems.push(`${a.pave} vehicle corners on the pavement`);
  return { problems, stats: tr.stats() };
}

traffic.shotPresets = shotPresets;
traffic.selfTest = selfTest;

export { CYCLE, CYCLE_LEN, KINDS, TYPES, buildNetwork, sweepFits };
export default traffic;
