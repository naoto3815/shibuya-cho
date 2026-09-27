// [city] 道玄坂 corridor — the hand-authored layer over the generated geometry (dogenzakaOsm.js: OSM + PLATEAU + GSI).
//
// The playable city is the approved ±220 m square (compressed beyond its 1:1 core, see cityData.js) PLUS this corridor,
// laid in TRUE metres: 道玄坂 from the SHIBUYA 1O9 apex up past 道玄坂上交番 to the 道玄坂上 junction on 玉川通り
// (国道246, 首都高3号渋谷線 overhead). Everything here is data; cityData.js turns it into roads / crossings / signals /
// the ground ramp / the corridor outline, buildings/dogenzaka.js builds it.
//
// Sources (docs/reports/dogenzaka.md): OSM (Overpass 2026-07 base) centre-lines, crossings, signals, POIs, names;
// PLATEAU 2020 footprints + measured heights; GSI DEM profile; 渋谷道玄坂商店街振興組合 member list + its public map
// (shibuyadogenzaka.com, 2026-09); 三菱地所 / 渋谷区 releases for the 道玄坂二丁目南地区 redevelopment; the July 2026
// construction report (building-pc.cocolog-nifty.com). Brand / shop names are near-names per docs/NAMES.md; public
// places, streets, monuments and plain building names (〇〇ビル) as-is.
//
// Deterministic, no DOM: imported by cityData.js (and so by node tests).
import { CENTRE, PROFILE, BUILDINGS, BACKDROP, SITE, T246, SHUTO, DG_SOURCES } from './dogenzakaOsm.js';

export { CENTRE, PROFILE, BUILDINGS, BACKDROP, SITE, T246, SHUTO, DG_SOURCES };

// ------------------------------------------------------------------------------------------------ geometry helpers
const hyp = Math.hypot;
function chaikin(pts, iters = 1) {                   // open corner cutting, ends fixed
  let p = pts;
  for (let k = 0; k < iters; k++) {
    const o = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      if (i > 0) o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      if (i < p.length - 2) o.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    o.push(p[p.length - 1]);
    p = o;
  }
  return p.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
}
const idxOf = (x, z) => CENTRE.findIndex((q) => hyp(q[0] - x, q[1] - z) < 0.2);
/** Nearest point on a polyline: { d, s, x, z, tx, tz, i } (s = arc length). */
export function nearestOn(path, x, z) {
  let best = null, acc = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1], vx = bx - ax, vz = bz - az, l = hyp(vx, vz) || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (l * l))), px = ax + vx * t, pz = az + vz * t, d = hyp(x - px, z - pz);
    if (!best || d < best.d) best = { d, s: acc + t * l, x: px, z: pz, tx: vx / l, tz: vz / l, i, side: Math.sign(vx * (z - az) - vz * (x - ax)) };
    acc += l;
  }
  return best;
}
export function pathLen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += hyp(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return L; }
export function pointAtS(p, s) {
  let acc = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const l = hyp(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    if (acc + l >= s || i === p.length - 2) { const t = Math.max(0, Math.min(1, (s - acc) / (l || 1))); return [p[i][0] + (p[i + 1][0] - p[i][0]) * t, p[i][1] + (p[i + 1][1] - p[i][1]) * t, (p[i + 1][0] - p[i][0]) / (l || 1), (p[i + 1][1] - p[i][1]) / (l || 1)]; }
    acc += l;
  }
  return [p[0][0], p[0][1], 1, 0];
}
function offsetLine(p, o) {
  return p.map((q, i) => {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = hyp(dx, dz) || 1;
    return [q[0] - dz / l * o, q[1] + dx / l * o];
  });
}

// ------------------------------------------------------------------------------------------------ the streets
// 道玄坂 (game road 'dogenzaka'): the approved head (109 fork → x −180, unchanged) then the OSM centre-line in true
// metres up to the 道玄坂上交番前 junction (OSM signal node, (−396.3, 219.5)); 'dogenzaka_ue' from there to the 道玄坂上
// junction on 玉川通り. One Chaikin pass rounds the OSM vertices (≤ 0.6 m off the OSM line).
const HEAD = [[-112, -3], [-121.2, 2.6], [-130.4, 7.3], [-139.8, 11.5], [-149.3, 15.1], [-159.8, 18.7], [-170.8, 22.3], [-180.2, 25.4]];
export const KOBANMAE = [-396.3, 219.5];            // 道玄坂上交番前 (the signal node)
export const UE_JCT = [-490.7, 402.2];              // 道玄坂上 (the node where 道玄坂's link meets 玉川通り's side road)
const i0 = idxOf(-205.8, 33.7), iK = idxOf(KOBANMAE[0], KOBANMAE[1]);
export const DOGEN_PATH = [...HEAD, ...chaikin(CENTRE.slice(i0, iK + 1)).slice(0)];
export const DOGEN_UE_PATH = chaikin([...CENTRE.slice(iK), [-485, 392], UE_JCT]);
// 玉川通り at 道玄坂上: the east-bound side road's alignment through the junction (OSM 659059738 … 775467747), laid as
// one two-way carriageway so traffic can turn in and out of 道玄坂 (the real west-bound side road, the underpass
// between them and the 首都高 over both are drawn by buildings/dogenzaka.js)
// (its ends stand > 130 m from the junction, out of the traffic spawner's sight: cars come and go unseen)
export const TAMAGAWA_UE_PATH = [[-583, 495], [-569, 471], [-556, 451], ...T246.eb.slice(0, 8), [-400, 377.5], [-360, 367], [-327.3, 358.4], [-300, 353]];
// the west-bound side road (visual only: its asphalt and kerbs, no traffic)
export const TAMAGAWA_UE_WB_PATH = [[-405, 404], ...T246.wb.slice(2)];
export const TAMAGAWA_UE_WB_OUT = [...T246.wbOut, [-531, 473]];

// Side streets that meet 道玄坂 — their MOUTHS only (the corridor is one street deep). Roads without traffic
// (`traffic: false`): asphalt at ground level with kerbs, poles and lamps. Most start behind 道玄坂's pavement (the
// pavement runs across the mouth, as on the real street), the three arms of the 交番前 junction start at its centre
// (their zebras are signalled).
export const SIDE_STREETS = [
  { id: 'dg_2chome_lane', name: '道玄坂二丁目', osm: 31855878, path: [[-207.8, 46.3], [-199.5, 64.4]], width: 4.5 },
  { id: 'dg_koji', name: '道玄坂小路', osm: 46867241, path: [[-256, 40.4], [-256.4, 27.4], [-255.8, 15.3], [-254.4, 3]], width: 4.4, oneway: true },
  { id: 'dg_2chome_s', name: '道玄坂二丁目', osm: 136587664, path: [[-250.3, 63.4], [-241.2, 81.6]], width: 5 },
  { id: 'dg_hyakkendana', name: '百軒店', osm: 627697964, path: [[-299.5, 73.6], [-311.5, 58.9], [-323.5, 44.3]], width: 6, oneway: true },
  { id: 'dg_maruyama_lane', name: '円山町', osm: 87250189, path: [[-377.4, 168.9], [-400.5, 154.3]], width: 5 },
  { id: 'dg_markcity_p', name: '渋谷マークシティ 駐車場', osm: 627697975, path: [[-362.2, 188.6], [-350.4, 196.1], [-344.8, 196.2], [-330, 190]], width: 6, oneway: true },
  { id: 'dg_rambling', name: 'ランブリングストリート', osm: 1110672666, path: [KOBANMAE, [-403.5, 213.3], [-424.2, 195.4], [-431, 181]], width: 8, junction: true },
  { id: 'dg_1chome', name: '道玄坂一丁目', osm: 32621918, path: [KOBANMAE, [-385.4, 235.9], [-366, 258.7]], width: 8, junction: true },
  { id: 'dg_east_svc', name: '道玄坂一丁目', osm: 59075778, path: [KOBANMAE, [-380.1, 214.4], [-360, 211]], width: 7, junction: true },
  { id: 'dg_urashibuya', name: '裏渋谷通り', osm: 30012066, path: [[-419.6, 239.9], [-426, 241], [-441, 245], [-449, 247]], width: 5.5, oneway: true },
  { id: 'dg_1chome_n', name: '道玄坂一丁目', osm: 968189472, path: [[-434.6, 309.9], [-420, 317.3]], width: 6 },
  { id: 'dg_maruyama_a', name: '円山町', osm: 87250208, path: [[-469.5, 329.4], [-490, 314.3]], width: 4 },
  { id: 'dg_maruyama_b', name: '円山町', osm: 1336649818, path: [[-481.9, 352.8], [-500, 341.3]], width: 4 },
  { id: 'dg_ue_w', name: '円山町', osm: 297827762, path: [[-499.9, 383.5], [-520, 372]], width: 5 },
];

// a mouth that starts behind 道玄坂's pavement starts far enough back that its carriageway (a capsule: its round end
// reaches w/2 past the first point) stays clear of the pavement the walkers use: ≥ building line + w/2 + 0.6 m
{
  const lines = [[DOGEN_PATH, 12], [DOGEN_UE_PATH, 10.5]];
  for (const s of SIDE_STREETS) {
    if (s.junction) continue;
    const p = s.path, need = (d) => { let best = Infinity; for (const [L, e] of lines) best = Math.min(best, nearestOn(L, d[0], d[1]).d - e); return best; };
    const [ax, az] = p[0], [bx, bz] = p[1], l = hyp(bx - ax, bz - az), ux = (bx - ax) / l, uz = (bz - az) / l;
    let k = 0;
    while (k < l - 2 && need([ax + ux * k, az + uz * k]) < s.width / 2 + 0.6) k += 0.25;
    p[0] = [Math.round((ax + ux * k) * 10) / 10, Math.round((az + uz * k) * 10) / 10];
  }
}

// crossings (OSM highway=crossing nodes): { id, at: a point on the zebra, road: the carriageway it crosses, width,
// signals: signalled mid-block zebra (traffic xings, 60 s cycle), junction: at a signalled junction (the crowd walks
// with the parallel vehicle group) }
export const CROSSINGS = [
  { id: 'cx_dogen_170', osm: 11078620011, at: [-218.7, 38.1], road: 'dogenzaka', width: 5, signals: true },        // 道玄坂 中ほど (signal)
  { id: 'cx_dg_hyakken', osm: 0, at: [-296.9, 86.7], road: 'dogenzaka', width: 5, signals: true },                  // 百軒店前 (signal)
  { id: 'cx_dg_km_n', at: [-383.8, 200.6], road: 'dogenzaka', width: 5.5, junction: 'kobanmae' },                  // 交番前, the down-hill arm
  { id: 'cx_dg_km_s', at: [-406, 234.7], road: 'dogenzaka_ue', width: 5.5, junction: 'kobanmae' },                 // 交番前, the up-hill arm
  { id: 'cx_dg_km_w', at: [-403.5, 213.3], road: 'dg_rambling', width: 4.5, junction: 'kobanmae' },                // across ランブリングストリート
  { id: 'cx_dg_km_e', at: [-385.4, 235.9], road: 'dg_1chome', width: 4.5, junction: 'kobanmae' },                  // across the 一丁目 road
  { id: 'cx_dg_km_x', at: [-380.1, 214.4], road: 'dg_east_svc', width: 4, junction: 'kobanmae' },                 // across the service road
  { id: 'cx_dg_ue_n', at: [-483.1, 380.6], road: 'dogenzaka_ue', width: 5.5, junction: 'dogenzakaue' },            // 道玄坂上 (the named signal)
];

// the bus stop 道玄坂上（交番前）: 東急バス (near-name 東光バス) 渋谷駅 ↔ 道玄坂上 routes stop on the up-hill kerb
export const BUS_STOP = { id: 'dg_kobanmae', ref: '道玄坂上', name: '道玄坂上（交番前）', osm: 0, road: 'dogenzaka_ue', pole: [-416.9, 268.7], op: '東光バス' };

// ------------------------------------------------------------------------------------------------ the koban
// 渋谷警察署 道玄坂上交番 (OSM amenity=police, 円山町3-7): the corner of 道玄坂 and 裏渋谷通り, on the up-hill left pavement.
// A small two-storey box, white tiles with the dark eaves band, the red 赤色灯 over the door, the gold 旭日章 and 「交番」
// / 「KOBAN」 / 「道玄坂上交番」 plates, the notice board and the stand-by bicycles.
export const KOBAN = { name: '道玄坂上交番', pos: [-420.7, 233], w: 6.4, d: 5.2, storeys: 2 };

// historic markers at the 交番前 junction's east corner (OSM historic=memorial)
export const MONUMENTS = [
  { name: '道玄坂乃碑', pos: [-373, 201.6], kind: 'stele' },
  { name: '道玄坂道供養碑', pos: [-371.8, 203.5], kind: 'stone' },
];
// 東京メトロ / 東急 渋谷駅 exits on 道玄坂 (OSM railway=subway_entrance): station → 渋谷町駅 (NAMES.md)
export const EXITS = [{ ref: 'A0', pos: [-184.2, 12.5] }, { ref: 'A1', pos: [-139, 28.4] }];
export const BIKE_PARKING = [[-361.3, 230.9], [-392, 229], [-433.5, 300.2]];

// ------------------------------------------------------------------------------------------------ construction
// 道玄坂二丁目南地区第一種市街地再開発事業 (OSM 1159013859): demolition 2023, works 2024-01-16 → 2027-02. July 2026: the
// office tower (east, 30F / 152.56 m, S造) in full steel erection, the hotel (west, 11F / ~60 m, TRUNK(HOTEL)) and, in the
// notch the scheme could not take in, the (仮称)アパホテル〈渋谷駅前〉 (15F / 44.6 m) rising. Game month: late September 2026.
export const WORKS = {
  site: SITE,
  // footprints: the office tower set 8 m back from 道玄坂 behind its plaza (~36 × 33 m plate), the hotel on the west
  // frontage, the APA in the notch (estimated inside the OSM yard / notch outlines; the plan itself is not published)
  office: { name: '道玄坂二丁目南地区 オフィス棟', floors: 30, height: 152.6, steelTo: 26, cladTo: 16, poly: [[-254.7, 77.4], [-282.8, 99.7], [-262.3, 125.4], [-234.2, 103.1]] },
  hotel: { name: 'TRUNK(HOTEL) DOGENZAKA（仮称）', floors: 11, height: 60, steelTo: 11, cladTo: 6, poly: [[-316.5, 129.8], [-334.6, 156.2], [-313.2, 170.9], [-295.1, 144.5]] },
  apa: { name: '（仮称）アバホテル〈渋谷駅前〉新築工事', floors: 15, height: 44.6, steelTo: 13, cladTo: 7, poly: [[-296.1, 106.4], [-309.6, 119.8], [-297, 132.6], [-283.4, 119.2]] },
  // the notch's own boundary with the yard (the APA site sits in it, behind its own hoarding)
  notch: [[-295.4, 100], [-275, 121.6], [-297.2, 142.1], [-316.1, 120.5]],
  hoarding: 3.2,
};

// マークシティ's real west end (PLATEAU 13113-bldg-9171) reaches x ≈ −301, but the square's compressed 渋谷マークシティ
// landmark stops at x −225: the part west of it would leave an empty lot behind the yard (GSI aerial vs top-down,
// shots/dogenzaka/compare_aerial.jpg). Filled with the podium mass in true position; the approved landmark is untouched.
const clipXMax = (P, xm) => {
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], ia = a[0] <= xm, ib = b[0] <= xm;
    if (ia) out.push(a);
    if (ia !== ib) { const t = (xm - a[0]) / (b[0] - a[0]); out.push([xm, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
};
const MC_PLATEAU = BACKDROP.find((b) => b.id === '13113-bldg-9171');
export const MARKCITY_WING = MC_PLATEAU ? { name: '渋谷マークシティ（西端）', plateau: MC_PLATEAU.id, poly: clipXMax(MC_PLATEAU.poly, -226), top: 30 } : null;

// ------------------------------------------------------------------------------------------------ street trees
// (pass 16) 道玄坂's street trees are ケヤキ (Zelkova serrata): the vase form (a ~3 m clear trunk, 5–7 limbs up and out),
// 12–16 m tall, crowns 10–14 m across that meet over the pavement. Positions: the crowns the GSI aerial shows on the
// sunlit north-west kerb (s ≈ 180 / 210 / 225 / 285 / 330–360, 道玄坂上 s ≈ 41 / 71 / 91) fix each row's phase; the
// Commons photos (2024-03 mid-slope, 2025-01 THE PRIME, 2025-06 道玄坂上, 2026-03 construction site / 交番前) show the rows
// on both kerbs about 12 m apart, in square pits (granite edge, cast-iron grating) just in from the kerb. The south-east
// kerb is in the buildings' shadow on the aerial, so its phase is the photos' (in front of TOHO at s ≈ 46).
// The old tree behind the 道玄坂乃碑 is the big one at 交番前 (Commons 2026-03-13_040 / _090).
export const STREET_TREES = {
  species: 'ケヤキ',
  kerb: 0.95,                                           // pit centre in from the kerb line (m)
  rows: [
    { road: 'dogenzaka', side: 1, s0: 80, s1: 371, step: 12, anchor: 180 },
    { road: 'dogenzaka', side: -1, s0: 34, s1: 371, step: 12, anchor: 46 },
    { road: 'dogenzaka_ue', side: 1, s0: 10, s1: 196, step: 12.5, anchor: 41 },
    { road: 'dogenzaka_ue', side: -1, s0: 10, s1: 196, step: 12.5, anchor: 22 },
  ],
  big: [{ pos: [-369.6, 200.4], h: 15.5, name: '道玄坂乃碑の欅' }],
};

// ------------------------------------------------------------------------------------------------ the three spots
// (pass 16) Per-building looks for the buildings a visitor recognises, from the Commons photos (shots/dogenzaka/ref2):
//   109 side: THE PRIME's white grid-tiled front with the red UNIQRO boxes (2014-01 / 2025-01), 渋東シネタワー's blue
//     glass curtain wall over the black TOHO CINEMA podium (2010 / 2012 / 2025-01), 楽苑's tall white board (2025-02);
//   mid-slope: 道玄坂センタービル's white spandrel bands (2025-08), the 百軒店 gate (red posts, maroon beam
//     「Hyakkendana」, the violet lit 「しぶや百軒店」 board with the 百軒店 plaque; 2017-12);
//   交番前: the Gusto corner (below).
export const LOOK = {
  9698: { wall: 3, tiles: true, uniqro: true },                   // THE PRIME (道玄坂2-29-5)
  9494: { wall: 5, style: 'office', podium: 'TOHO CINEMA' },       // 渋東シネタワー
  9439: { board: '楽苑' },                                           // 井門道玄坂ビル: パチンコ 楽苑
  9534: { wall: 3, style: 'office', bands: true },                // 道玄坂センタービル
};
// The Gusto corner at 交番前 (Commons 2024-12 and 2026-03 night photos): a 2-storey block on the junction corner —
// セブンイレブ on 1F, ガスド's dining room on 2F behind wooden lattice under the dark 「GUSTD」 band, the red logo box over
// the corner and the LED screen on its roof — in front of the 9F block (PLATEAU 38691 / OSM 136587845, 9 levels) that
// fills the rest of the lot. `depth`: the podium's depth back from the 道玄坂 face.
export const GUSTO_CORNER = { sid: '38691', depth: 10.5, towerStoreys: 9, screen: { w: 7.6, h: 4.3, over: 2.6 } };

// ------------------------------------------------------------------------------------------------ tenants
// Per building (PLATEAU id without the 13113-bldg- prefix): name = the building's own sign (building names as-is),
// gf = ground-floor shops along its 道玄坂 face (in order along the street, up-hill), up = upper-floor tenants (signage
// stacks / tenant boards), style = facade character. `src`: o = OSM POI, m = 振興組合 member map / list, w = web, e =
// estimated (a plausible 道玄坂 tenant where the real one is unknown). Real names are only in comments.
export const TENANTS = {
  // ---- up-hill LEFT (north-west, the 109 side)
  9698: { name: 'THE PRIMA', style: 'mall', gf: ['UNIQRO 渋谷道玄坂店', 'WEGA', 'HOOTERZ'], up: ['UNIQRO', 'WEGA', 'ABC-MARK', '渋谷プリマ クリニック'], src: 'o,m' },   // THE PRIME: ユニクロ / WEGO / Hooters
  9534: { name: '道玄坂センタービル', style: 'tenant', gf: ['ファミリマート', 'サンマルコカフェ', 'モズバーガー', 'すしざんない'], up: ['ソフトバング', 'The Dublinerz 2F', 'ブティック モロー', '和氏', '白木家', '土間々', '鳥郎', 'ロイヤルポスト', 'ねぎじ B1', 'いんでいろ B1', '珈琲店トッブ B1'], src: 'o,m' },
  9454: { name: 'MMビル', style: 'tenant', gf: ['金太朗 ビデオ', '無料案内所'], up: ['鳥ごこら', 'スナック 美晴', 'BAR 弐拾壱'], src: 'o' },
  9434: { name: '直盛', style: 'tenant', gf: ['ラーメン 直盛'], up: ['カラオケ パセリ', 'アコン'], src: 'o' },                           // 直成 (ラーメンとスタミナ丼)
  9424: { name: '井門ビル', style: 'office', gf: ['ひろクリニック', 'ドトルコーヒー'], up: ['井門インターナショナル', '天狗', '渋谷町クリニック', 'プロミズ'], src: 'm,o' },
  9389: { name: '道玄坂SUN-Jビル', style: 'tenant', gf: ['牛閣', '韓の台処'], up: ['月の倉', 'レイク ALSO', 'マンボウ ネットカフェ'], src: 'o,e' },   // 牛角 / 韓の台所
  9380: { name: '秀永ビル', style: 'entertainment', gf: ['ジャンカレ 道玄坂店', 'Todoz'], up: ['ジャンカレ', 'ジャンカレ', 'BAR ピアノ', 'のんべい'], src: 'o,e' },  // karaoke_box (OSM), Todos
  9335: { name: '道玄坂ハシモトビル', style: 'tenant', gf: ['スタンド うみねご'], up: ['蛍ノ庭', 'ミライサカ'], src: 'o,m' },           // スタンドうみねこ; 蛍の庭 / ミライザカ (members)
  9329: { name: '高葉屋ビル', style: 'tenant', gf: ['高葉屋', 'とりかつ チキソ'], up: ['マスタ亭', 'パソダレストラン'], src: 'm' },
  9313: { name: '野村不動産渋谷道玄坂ビル', style: 'office', gf: ['セブンイレブ', 'きらぽし銀行 渋谷支店'], up: ['道玄坂総合法律事務所', '東光不動産'], src: 'o' },   // 7-Eleven, (八千代→きらぼし) 銀行
  9241: { name: 'セントラル共立ビル', style: 'tenant', gf: ['幸楽宛'], up: ['鳥壱', 'プライズコンタクト', 'OSドラック'], src: 'o,m' },
  9218: { name: 'ケンタッキ', style: 'shop', gf: ['ケンタッキ'], up: [], src: 'o' },
  9180: { name: 'リンガーバット', style: 'tenant', gf: ['リンガーバット', '渋谷友好薬舗'], up: ['渋谷町眼科'], src: 'o' },
  9154: { name: '花菱ビル', style: 'tenant', gf: ['うなぎ 花稜'], up: ['うなぎ 花稜', '佐野政 呉服', '信州家 そば'], src: 'm' },
  9145: { name: '道玄坂ロイヤルビル', style: 'tenant', gf: ['フレッシュネズバーガー'], up: ['兆來本店', '後樂本舗', 'アイフリ'], src: 'o,m' },
  9128: { name: 'ビジネスヴィッブ渋谷道玄坂', style: 'office', gf: ['パクパクもりもる', '渋谷パソコン修理工房'], up: ['ビジネスヴィッブ', 'SAWAZAKI 紳士服', 'haneloa'], src: 'o,m' },
  9157: { name: 'ノア道玄坂', style: 'residential', gf: ['道玄坂デンタル', 'ヘアサロン NOA'], up: ['ノア道玄坂', '道玄坂歯科', 'カシワ屋 文具'], src: 'o,m' },
  9059: { name: '道玄坂上センタービル', style: 'office', gf: ['ファミリマート', '回転寿し 魚ぺい'], up: ['渋谷ピカリヱ', '快活CLAB', 'アコン'], src: 'o' },
  38691: { name: '道玄坂上ビル', style: 'tenant', gf: ['ガスド', 'セブンイレブ'], up: ['ガスド', 'サンチケッド'], src: 'o' },
  8859: { name: '吉沢利エ', style: 'shop', gf: ['吉沢利エ 工具・金物'], up: [], src: 'm' },
  8844: { name: '相騎', style: 'shop', gf: ['相騎 お弁当'], up: [], src: 'm' },
  8960: { name: 'E・スペースタワー', style: 'glass', gf: ['E・スペースタワー'], up: ['Cafe Legatto 15F'], src: 'o' },
  8730: { name: '島亀商会', style: 'shop', gf: ['島亀商会 塗料'], up: [], src: 'm' },
  8689: { name: '道玄坂スクエア', style: 'office', gf: ['道玄坂バル 克ツ', 'カリーうどん せんきぢ'], up: ['渋谷デンタルオフィス', 'Crazy Beauti', 'Mori no toshoshitu'], src: 'o' },
  8649: { name: '円山町ビル', style: 'tenant', gf: ['BAR Woo', '升屋酒店'], up: ['スナック ちどり', 'BAR 月の舟'], src: 'o,m' },
  8619: { name: '玉川屋ビル', style: 'tenant', gf: ['カフェ・ド・クリエイ', '玉川屋呉服店', 'Ikura Shibuya'], up: ['Mori no toshoshitu 3F'], src: 'o,m' },
  8543: { name: '円山町五番館', style: 'tenant', gf: ['並木化粧品舗'], up: ['勝未 日本料理'], src: 'm,e' },
  8554: { name: 'サンアイビル', style: 'tenant', gf: ['サンアイ シャッターチャソス'], up: ['サンアイ写真館'], src: 'm' },
  8514: { name: '泉也ビル', style: 'tenant', gf: ['泉也呉服店', 'TORAFUFU-TEl'], up: ['泉也 着付け教室', '茶道教室'], src: 'm,o' },
  8394: { name: '道玄坂上スクエア', style: 'office', gf: ['ポッポ', '俺流汐ラーメン'], up: ['見真ビル'], src: 'o,m' },
  8262: { name: 'アバホテル〈渋谷道玄坂上〉', style: 'hotel', gf: ['アバホテル'], up: ['アバホテル', 'APPA HOTEL'], src: 'o' },
  8166: { name: '大場ビル', style: 'tenant', gf: ['モズバーガー'], up: ['大場ビル'], src: 'm,o' },
  8090: { name: '道玄坂上ビル', style: 'office', gf: ['ファミリマート'], up: ['渋谷町ビジネスホテル'], src: 'o' },
  // ---- up-hill RIGHT (south-east, the マークシティ side)
  9503: { name: '岩崎ビル', style: 'tenant', gf: ['エクセルシオル カフェ'], up: ['エクセルシオル', 'アコン', 'カラオケ舘'], src: 'm,o' },
  9494: { name: '渋東シネタワー', style: 'cinema', gf: ['クリスピー・クリーム・ドーナッツ', 'ロールアイスクリーム ファクトリー'], up: ['TOHOシネマ 渋谷町', 'カフェ キーフェル', 'LEK 渋谷駅前本校', 'DHK', 'MEETING SPACE AP', '蒙古タソメン中本 B2'], src: 'm,w' },
  9439: { name: '井門道玄坂ビル', style: 'entertainment', gf: ['パチンコ 楽苑', '甘太朗'], up: ['パチンコ 楽苑', 'IMON Modelz'], src: 'm,o' },
  9430: { name: '鈴井ビル', style: 'tenant', gf: ['道玄坂調剤薬局'], up: ['元祖くじら家 3F', '千野時計舗 3F'], src: 'm,o' },
  9422: { name: 'ファミリマート 道玄坂中央店', style: 'tenant', gf: ['ファミリマート'], up: ['渋谷町クリニック', 'プロミズ'], src: 'm,o' },
  9412: { name: '手串屋ビル', style: 'tenant', gf: ['炭火焼鳥 手串家', 'びんちょう家'], up: ['鳥貴賊'], src: 'o' },
  9406: { name: 'ホマレヤビル', style: 'tenant', gf: ['ロッテリヤ'], up: ['油そば 春日停', '吉そぼ', 'アイフリ'], src: 'm,o' },
  9386: { name: 'イワギメガネ', style: 'shop', gf: ['イワギメガネ 渋谷店'], up: [], src: 'm,o' },
  9376: { name: '七士ビル', style: 'tenant', gf: ['らーめん 七士'], up: ['チャオタイ'], src: 'o' },
  9366: { name: '松本ビル', style: 'tenant', gf: ['天下寿し 渋谷道玄坂店', '東京チカラメソ'], up: ['渋谷ガーデソスペース 7F', '渋谷ピカリヱ 道玄坂本店', 'FUJIZU パソコンスクール'], src: 'm,o' },
  9352: { name: '光真ビル', style: 'tenant', gf: ['じゃんぱる'], up: ['光真ビル'], src: 'm,o' },
  9348: { name: '道玄坂二丁目ビル', style: 'tenant', gf: ['丸亀製麦'], up: ['鳥貴賊', 'CLUB COSTA DEL SOLE'], src: 'o' },
  9015: { name: '道玄坂一丁目商店', style: 'shop', gf: ["Y's ロード"], up: [], src: 'o' },
  9003: { name: 'マンモス', style: 'shop', gf: ['道玄坂マンモス つけ麺'], up: [], src: 'o' },
  8985: { name: 'Church', style: 'shop', gf: ['The Churchi'], up: [], src: 'o' },
  8980: { name: '王丈', style: 'shop', gf: ['餃子の王丈'], up: [], src: 'o' },
  8940: { name: "K's", style: 'shop', gf: ["K'z BAR"], up: [], src: 'o' },
  8912: { name: '道玄坂上ハイツ', style: 'shop', gf: ['OSドラック'], up: [], src: 'm' },
  8813: { name: '道玄坂プラザ 仁科屋ビル', style: 'tenant', gf: ['松家', 'わたみん屋', 'Happy Pancakes'], up: ['カリー カイラズ', '渋谷道玄坂商店街振興組合'], src: 'o,m' },
  8723: { name: '渋谷道玄坂郵便局ビル', style: 'office', gf: ['渋谷道玄坂郵便局', 'カプセルホテル ＆ サウナ'], up: ['道玄坂上歯科'], src: 'o' },
  8713: { name: '道玄坂上ビルディング', style: 'tenant', gf: ['信濃家 酒店'], up: ['翠月'], src: 'o' },
  8699: { name: '道玄坂上テラス', style: 'tenant', gf: ['ABOUT LIFE COFFEE BREWERZ'], up: [], src: 'o' },
  8663: { name: '大外商店', style: 'shop', gf: ['大外商店'], up: [], src: 'm' },
  8648: { name: '道玄坂上ファーストビル', style: 'office', gf: ['ポッポ'], up: [], src: 'e' },
  8621: { name: '渋谷BEAM道玄坂', style: 'tenant', gf: ['信濃家'], up: ['渋谷町メンタルクリニック'], src: 'o,e' },
  8580: { name: 'WAVE道玄坂ビル', style: 'office', gf: ['FabKafe'], up: [], src: 'o' },
  8502: { name: '道玄坂上ビル', style: 'tenant', gf: ['ファミリマート 渋谷道玄坂店'], up: ['翠月', 'BAR 鳥渡'], src: 'o' },
  8376: { name: 'ヴィラジュリア道玄坂', style: 'residential', gf: ['翠月 BAR'], up: [], src: 'o,e' },
  8147: { name: '道玄坂上ビル', style: 'office', gf: ['超俺流汐ラーメン 渋谷本店'], up: [], src: 'o' },
};
// Upper-floor names for buildings without a table row: a mix by street position (lower street = amusement /
// chains, upper street = offices / clinics / izakaya). Picked deterministically in the builder.
export const FILL_UP = {
  low: ['カラオケ舘', 'ジャンカレ', 'アコン', 'プロミズ', '磯丸漁港', '笑々', '鳥貴賊', 'マンボウ ネットカフェ', '渋谷町クリニック', '快活CLAB'],
  high: ['道玄坂歯科', '渋谷町眼科', '神南メンタルクリニック', '東光不動産', 'エイブレ', '大和證研', '和氏', '月の倉', '居酒屋 甚八', 'BAR 月の舟', 'スナック 美晴'],
};
export const FILL_GF = {
  low: ['ドトルコーヒー', 'マツモトキヨヒ', 'ポッポ', '松家', 'すき屋', '一風道', 'ABC-MARK', 'ソフトバング'],
  high: ['ポッポ', '居酒屋 甚八', '立呑み 富士屋', '焼鳥 おやひな屋', 'ラーメン 渚', 'セブンイレブ', 'タリース', '道玄坂歯科'],
};

// ------------------------------------------------------------------------------------------------ the corridor
// The corridor outline: a band round both roads (±CORR_HW from the centre-lines) and round the 玉川通り junction, from
// where 道玄坂 leaves the square (x −195) to past 道玄坂上. Everything inside it that is west of the square's edge is
// playable; the city's bounds walls follow its edges outside the square.
export const CORR_HW = 42;
const bandL = offsetLine([...DOGEN_PATH.filter((p) => p[0] <= -175), ...DOGEN_UE_PATH.slice(1)], CORR_HW);
const bandR = offsetLine([...DOGEN_PATH.filter((p) => p[0] <= -175), ...DOGEN_UE_PATH.slice(1)], -CORR_HW);
// the 道玄坂上 end: round the junction and 30 m along 玉川通り either way, just past the side roads
const CAP = [[-523, 432], [-512, 446], [-490, 438], [-462, 430], [-448, 418], [-440, 400]];
function simplifyBand(p) { const o = [p[0]]; for (let i = 1; i < p.length - 1; i++) if (hyp(p[i][0] - o[o.length - 1][0], p[i][1] - o[o.length - 1][1]) > 6) o.push(p[i]); o.push(p[p.length - 1]); return o; }
// the left band ends where it meets the cap at the north-west, the right band where it meets it at the south-east
export const CORRIDOR = simplifyBand([...bandL.filter((q, i) => i < bandL.length - 2), ...CAP, ...bandR.slice(0, -2).reverse()]).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);

// HUD area names (hud.areaName checks these first)
export const AREAS = [
  { name: '道玄坂上', polygon: [[-360, 180], [-420, 150], [-470, 250], [-560, 340], [-560, 470], [-440, 440], [-330, 360], [-350, 240]] },
];

/** Ground elevation (m T.P.) along CENTRE's arc length s (GSI DEM, linear between the 12 m samples). */
export function elevationAt(s) {
  const P = PROFILE;
  if (s <= P[0][0]) return P[0][1];
  for (let i = 1; i < P.length; i++) if (s <= P[i][0]) { const t = (s - P[i - 1][0]) / (P[i][0] - P[i - 1][0]); return P[i - 1][1] + (P[i][1] - P[i - 1][1]) * t; }
  return P[P.length - 1][1];
}
export const DATUM = 15.4;                         // 道玄坂下 = the game's 0 (the scramble 15.2 m, cityData.js ground)
/** Tall masses behind the frontage (outside the square only: the square's own compressed city stands there). */
// 渋谷ソラスタ (2019, 21F / 106.9 m, OSM 680254745; PLATEAU 13113-bldg-38690) stands 43 m off 道玄坂上 and is the
// street's landmark tower from the top: built as a real building (buildings/dogenzaka.js), not a backdrop prism
export const TOWERS = [{ id: '13113-bldg-38690', name: '渋谷ソラスタ', storeys: 21, height: 106.9, gf: 5.5, tenants: ['渋谷ソラスタ', 'タリース'] }];
export const BACKDROP_TRUE = BACKDROP.filter((b) => {
  if (b.id.startsWith('osm-')) return false;                               // ソラスタ is in PLATEAU (13113-bldg-38690)
  if (TOWERS.some((t) => t.id === b.id)) return false;
  const c = b.poly.reduce((a, p) => [a[0] + p[0] / b.poly.length, a[1] + p[1] / b.poly.length], [0, 0]);
  return c[0] < -236;
});

// ------------------------------------------------------------------------------------------------ shop rows
// The corridor's real ground-floor shops as tenantsData.js rows (street 'dogenzaka'): each building's gf names spread
// along its 道玄坂 face in order, 2.5 m out on the pavement (genericBuilding.js hands each shop bay the row in front of
// it — its name on the fascia, its trade inside), and the first upper tenant as the 2F board over the middle.
export function shopCat(n) {
  if (/ファミリマート|セブンイレブ|ポッポ|ローソ/.test(n)) return 'conv';
  if (/銀行/.test(n)) return 'bank';
  if (/薬|ドラック|化粧品|メガネ/.test(n)) return /メガネ/.test(n) ? 'other' : 'drug';
  if (/パチンコ/.test(n)) return 'pachi';
  if (/カラオケ|ジャンカレ/.test(n)) return 'karaoke';
  if (/カフェ|珈琲|コーヒー|COFFEE|ドーナッツ|クリエイ|FabKafe|キーフェル|アイスクリーム/i.test(n)) return 'cafe';
  if (/ラーメン|らーめん|ら〜めん|つけ麺|うどん|そば|製麦|餃子|中本|拉麺|油そば|直盛/.test(n)) return 'ramen';
  if (/バーガー|ケンタッキ|ロッテリヤ|HOOTERZ|リンガーバット|松家|Pancake|パクパク/i.test(n)) return 'fast';
  if (/ガスド|ロイヤル|パソダ|マスタ亭/.test(n)) return 'family';
  if (/BAR|Bar|バー|Churchi|Woo|うみねご|翠月|スナック/.test(n)) return 'bar';
  if (/居酒屋|酒場|鳥|串|和氏|白木家|土間々|甘太朗|わたみん|バル|牛閣|韓の|チキソ|Todoz|TORAFUFU|Ikura/.test(n)) return 'izakaya';
  if (/寿し|すし|うなぎ|天下|寿司|チカラメソ/.test(n)) return 'restaurant';
  if (/UNIQRO|WEGA|ブティック|呉服|ロード|SAWAZAKI|haneloa/.test(n)) return 'fashion';
  return 'other';
}
export const DOGEN_SHOPS = (() => {
  const rows = [], road = [...DOGEN_PATH.filter((p) => p[0] <= -110), ...DOGEN_UE_PATH.slice(1)];
  for (const b of BUILDINGS) {
    const T = TENANTS[b.id.replace('13113-bldg-', '')]; if (!T || !T.gf || !T.gf.length) continue;
    const P = b.poly, n = P.length, c = P.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
    let best = null;
    for (let i = 0; i < n; i++) {
      const a = P[i], q = P[(i + 1) % n], len = hyp(q[0] - a[0], q[1] - a[1]); if (len < 2.5) continue;
      let nx = (q[1] - a[1]) / len, nz = -(q[0] - a[0]) / len;
      const mx = (a[0] + q[0]) / 2, mz = (a[1] + q[1]) / 2;
      if ((mx - c[0]) * nx + (mz - c[1]) * nz < 0) { nx = -nx; nz = -nz; }
      const r = nearestOn(road, mx, mz); if (r.d > 18) continue;
      const tx = r.x - mx, tz = r.z - mz, tl = hyp(tx, tz) || 1; if ((tx * nx + tz * nz) / tl < 0.6) continue;
      if (!best || len > best.len) best = { a, q, len, nx, nz, s: r.s };
    }
    if (!best) continue;
    // order the gf names up-hill: from the end nearer the 109
    const sa = nearestOn(road, best.a[0], best.a[1]).s, sq = nearestOn(road, best.q[0], best.q[1]).s;
    const [A, Q] = sa <= sq ? [best.a, best.q] : [best.q, best.a];
    const k = T.gf.length;
    T.gf.forEach((name, j) => {
      const u = (j + 0.5) / k, x = A[0] + (Q[0] - A[0]) * u + best.nx * 2.5, z = A[1] + (Q[1] - A[1]) * u + best.nz * 2.5;
      rows.push({ street: 'dogenzaka', side: b.side, pos: [Math.round(x * 10) / 10, Math.round(z * 10) / 10], name, cat: shopCat(name), floor: 1 });
    });
    if (T.up && T.up[0]) { const x = (A[0] + Q[0]) / 2 + best.nx * 2.5, z = (A[1] + Q[1]) / 2 + best.nz * 2.5; rows.push({ street: 'dogenzaka', side: b.side, pos: [Math.round(x * 10) / 10, Math.round(z * 10) / 10], name: T.up[0].replace(/\s*\d+F$|\s+B\d$/, ''), cat: shopCat(T.up[0]), floor: 2 }); }
  }
  return rows;
})();
export default { DOGEN_PATH, DOGEN_UE_PATH, TAMAGAWA_UE_PATH, SIDE_STREETS, CROSSINGS, CORRIDOR, TENANTS };
