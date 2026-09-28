// [cityData] 渋谷町 block plan — the single source of truth for every world module (see docs/CITY_DATA.md).
//
// Units: metres. Origin = centre of the scramble crossing (the OSM junction node 渋谷駅前, 35.65948N 139.70054E).
// +x = east, +z = south, −z = north, y up. Angles in radians.
//
// rotY convention (three.js): counter-clockwise from +x when viewed from above, i.e. an object with rotation.y = rotY
// has its local +x axis pointing along (cos rotY, −sin rotY) in the (x, z) plane. "facing" values below are the
// direction the front/sign/screen points: east = 0, north = +π/2, west = π, south = −π/2. Use facing(dx, dz).
//
// Geometry source: OpenStreetMap building footprints, road centre-lines (with lane counts), rail alignments and
// crossing nodes around the Hachiko exit, projected to local metres (pulled 2026-09-19, see docs/LANDMARKS.md).
// The core (x ∈ [−195, 150], z ∈ [−150, 150]) is 1:1. Beyond it the plan is compressed per axis so the whole
// ±220 m playable square holds Parco / Tower Record (real 250–310 m north), Hikarie (real 220–400 m east) and
// Fukuras / Stream (real 170–280 m south):
//   west  x < −195 : x' = −195 + 0.35·(x + 195)      east  x > 150 : x' = 150 + 0.40·(x − 150)
//   north z < −150 : z' = −150 + 0.45·(z + 150)      south z > 150 : z' = 150 + 0.45·(z − 150)
// Landmark footprints keep their real proportions (they are re-sized around the compressed centre, not squashed);
// infill blocks are the compressed real blocks. Heights are never compressed.
//
// Deterministic: no Math.random anywhere in this module. Imports 'three' and the 道玄坂 corridor data.
//
// 道玄坂 corridor (2026-09-27, client: 「道玄坂沿いの建物を作りを徹底的に実態と合わせたい。道玄坂上の交番あたりまでは作り込んで。」):
// 道玄坂 is no longer compressed. From the approved head at the 109 (x −180) it runs on its OSM centre-line in TRUE
// metres up to 道玄坂上交番前 and the 道玄坂上 junction on 玉川通り, and the playable city is the square PLUS a corridor
// one street deep along it (CITY.corridor, dogenzakaData.js; the buildings are buildings/dogenzaka.js).
import * as THREE from 'three';
import * as DG from './dogenzakaData.js';
import {NORTH_BLOCKS} from './udagawaInfill.js';
import {northRoad,PARCO_CROSSINGS} from './northRoads.js';
import {ROAD_FRONTAGES} from './roadFrontages.js';
import {BUNKAMURA_PATH,BUNKAMURA_WIDTH} from './roadLayout.js';
import {kojiRoad} from './kojiData.js';
import {SCOPE_ROADS} from './scopeData.js';
import {SCOPE_OUTLINE} from './scopeProjection.js';
import {scopeGround} from './scopeTerrain.js';
import {shotoGround} from './shotoGrade.js';
import {MARKCITY_VEHICLE_PATH,MARKCITY_WALK_PATH} from './markcityAccess.js';

const PI = Math.PI;
/** rotY for something whose front points along (dx, dz). */
export function facing(dx, dz) { return Math.atan2(-dz, dx); }

// --------------------------------------------------------------------------------------------- tenant name pools
// Near-names per docs/NAMES.md (brands are altered, public names are as-is). Every list is specific — no "SHOP".
const T = {
  fast: ['マックドナルド', 'モズバーガー', 'ロッテリヤ', 'ケンタッキ', 'サブウェー', 'スマイルバーガー', 'バーガーキンク'],
  gyudon: ['松家', '吉野屋', 'すき屋'],
  ramen: ['一乱', '天下一本', '一風道', '博多天真', '富土そば', '日高家', 'ラーメン 渚'],
  family: ['ガスド', 'サイゼリア', 'デニース', 'ジョナソン', '大戸家'],
  izakaya: ['鳥貴賊', '磯丸漁港', '牛閣', '温野采', '和氏', '笑々', '白木家', '魚氏', '銀の蔵', '土間々', '居酒屋 甚八', '焼鳥 おやひな屋'],
  cafe: ['STARBEANS COFFEE', 'ドトルコーヒー', 'タリース', 'エクセルシオル', '珈琲舘', 'ゴン茶', 'マリオソクレープ', 'スイーツパラダイズ'],
  karaoke: ['カラオケ舘', 'ジャンカレ', 'ビックエコー', 'カラオケ パセリ'],
  drug: ['三千里薬局', 'マツモトキヨヒ', 'サンドラック', 'ココカラファイソ', 'ウエルシヤ'],
  conv: ['ポッポ', 'セブンイレブ', 'ファミリマート'],
  fashion: ['UNIQRO', 'GO', 'H&N', 'ZALA', 'WEGA', 'SPINZ', 'ベルシュケ', 'ABC-MARK', '無地良品', 'ビレッジバンガード', 'ドン・キホーヂ'],
  elec: ['ビッグカメラ', 'ヤマド電機 LABY', 'ノジモ', 'ソフトバング', 'aU ショップ', 'ドコマショップ'],
  game: ['タイトーステーシオン', 'アドアース', 'GIGA', '快活CLAB', 'マンボウ ネットカフェ', 'ラウンドツー'],
  pachi: ['マルハソ 渋谷', 'エスパズ日拓', 'ビッグアポロ'],
  money: ['アコン', 'プロミズ', 'アイフリ', 'レイク ALSO'],
  bank: ['三稜UFJ銀行', 'みずぼ銀行', 'りそね銀行', '三井住本銀行', 'SMBK信託'],
  office: ['渋谷町総合法律事務所', '東光不動産', 'エイブレ', 'アパマンショプ', '日本旅遊', 'ヒューマクス', '大和證研'],
  clinic: ['渋谷町クリニック', '道玄坂歯科', '宇田川皮フ科', '神南メンタルクリニック', '渋谷町眼科'],
  hotel: ['ホテル・シルキー', 'ドミーイン 渋谷町', '東急ステー', 'アバホテル 渋谷町', 'ホテル・マヨビエンテ'],
  books: ['大盛道書店', 'ブックオン', 'TSUTAYU', 'まんだらげ'],
  cinema: ['TOHOシネマ 渋谷町', 'シネマライス', 'シネクイソト'],
  bar: ['のんべい', 'BAR 鳥渡', 'スナック 美晴', '立呑み 富士屋', 'BAR ピアノ', '串焼 ひろし', '小料理 ちどり', 'BAR 弐拾壱', '焼酎 ゆうき', 'おでん 和', 'モツ焼 みつ', 'Bar 月の舟'],
};

// ------------------------------------------------------------------------------------------------------ roads
// Vehicle roads, centre-line polylines ([x, z] metres). width = carriageway (kerb to kerb), sidewalk = each side.
const ROADS = [
  // West arm. Real 道玄坂下: 4 lanes, ~21 m kerb-to-kerb, between the crossing and the SHIBUYA 109 apex (x≈−132).
  { id: 'dogenzaka_shita', name: '道玄坂(下)', path: [[-4, -2], [-14, -5], [-38, -6], [-70, -9], [-100, -5], [-112, -3]], width: 22, lanes: 4, sidewalk: 5, oneway: false },
  // 道玄坂 proper climbs south-west from the 109 apex (≈3.5 %). 2 lanes + bus/taxi bays.
  // pass 14 (client: 「道玄坂がまっすぐになっているけど、実際は、左にうねる上り坂だよね」): the centre-line from OSM (ways
  // 1110356210 … 907042281, real 18–22° south of west up to x −205, then bending left 23° → 37° → 45° → 56° → 61°
  // toward 道玄坂上), projected with the plan's compression (x′ = −195 + 0.35 (x + 195): the bend lands in the last
  // 25 m of the map and turns ≈50° there), Chaikin-smoothed (no kink at the compression line) and within 1.1 m of every
  // OSM point. The 109 fork node (−112, −3) is kept (traffic / junction topology), the line joins OSM by x −140.
  // pass 15 (the corridor): the compressed bend is gone. The head to x −180 is unchanged; from there the true OSM
  // centre-line runs up to 道玄坂上交番前 (−396.3, 219.5), 385 m from the 109 fork (dogenzakaData.js DOGEN_PATH).
  { id: 'dogenzaka', name: '道玄坂', path: DG.DOGEN_PATH, width: 13.5, lanes: 2, sidewalk: 4, oneway: false, slope: 0.047 },
  // 交番前 → 道玄坂上: 4 lanes (OSM lanes=4), 14 m between the kerbs, 3.5 m pavements (OSM sidewalk lines 8.1–9.8 m off)
  { id: 'dogenzaka_ue', name: '道玄坂', path: DG.DOGEN_UE_PATH, width: 12, lanes: 4, sidewalk: 3.5, oneway: false },
  // 玉川通り (国道246) at 道玄坂上: the east-bound side road's line through the junction, two-way for the game's traffic
  // (the real west-bound side road beside it, the underpass and the 首都高 over them are drawn by buildings/dogenzaka.js)
  { id: 'tamagawa_ue', name: '玉川通り', path: DG.TAMAGAWA_UE_PATH, width: 10, lanes: 2, sidewalk: 0, oneway: false },
  { id: 'tamagawa_ue_wb', name: '玉川通り', path: DG.TAMAGAWA_UE_WB_PATH, width: 7, lanes: 2, sidewalk: 0, oneway: true, traffic: false },
  { id: 'tamagawa_ue_wb2', name: '玉川通り', path: DG.TAMAGAWA_UE_WB_OUT, width: 7, lanes: 2, sidewalk: 0, oneway: true, traffic: false },
  // the side streets' mouths along the corridor (no traffic: asphalt, kerbs, lamps and poles only)
  ...DG.SIDE_STREETS.map((s) => ({ id: s.id, name: s.name, path: s.path, width: s.width, lanes: 1, sidewalk: 0, oneway: !!s.oneway, traffic: false, side: true })),
  // 文化村通り leaves the 109 apex west-north-west toward Bunkamura / 東急本店 (off-map).
  { id: 'bunkamura', name: '文化村通り', path: BUNKAMURA_PATH, width: BUNKAMURA_WIDTH, lanes: 2, sidewalk: 3, oneway: false },
  // South arm (real: 神宮通り south of the scramble, OSM 2026-09). A divided road around the 西口 bus terminal:
  //   南行 3 lanes along the station side (bus stops 29–33 on its east kerb, the 渋谷駅街区 construction hoarding behind),
  //   北行 1 lane + a kerb/bus lane along 渋谷駅前ビル / Mark City (stops 0–5 on its west kerb, 西口通り / ウェーヴ通り leave it
  //   westward), and between them a bus-only lane (CITY.busways) with the island platforms 21–26.
  // There is no taxi rank at ハチ公口 (never was) and the 西口 surface rank closed 2025-03-29 (redevelopment yard).
  // ekimae_s is the shared two-way throat from the scramble's stop line to the island nose, so the scramble keeps its
  // 'ns' signal arm; it forks into ekimae_sb / ekimae_nb (+ 西口通り) at the nose. Width 26 = the real kerb-to-kerb of
  // 北行 + the U-turn apron + 南行 here (and the approved scramble frame: its kerbs, lamps and pavements stay put).
  { id: 'ekimae_s', name: '駅前通り', path: [[-4, -2], [-8, 14], [-10, 30], [-15, 46]], width: 26, lanes: 4, sidewalk: 6, oneway: false },
  { id: 'ekimae_sb', name: '駅前通り(南行)', path: [[-11, 49], [-11.6, 58], [-12.4, 64], [-12.7, 68.2], [-11.8, 79.5], [-10.9, 87.9], [-9.5, 94.3], [-6.8, 102.4], [-4.1, 108.6], [-0.4, 115], [7.8, 128.6], [9, 140.7], [9.8, 150], [14, 160], [18, 170], [22.5, 180], [27, 188]], width: 10.5, lanes: 3, sidewalk: 6, oneway: true, islandSide: 'right' },
  { id: 'ekimae_nb', name: '駅前通り(北行)', path: [[15, 190], [13, 182], [9, 172], [5, 162], [2.5, 152], [-4, 146], [-9, 142], [-14.5, 137], [-20.4, 129.9], [-24.9, 112.5], [-26.3, 103.6], [-28.7, 87.1], [-29.5, 81.8], [-31.5, 68], [-31.2, 63], [-22, 56]], width: 7.2, lanes: 2, sidewalk: 5, oneway: true, islandSide: 'right' },
  // North arm (officially 神宮通り, sign-posted 公園通り in-game): between Q-FRONT and MAGNET, past Seibu, then it forks —
  // 神宮通り keeps north (jingu_n) and 公園通り bends north-west past MODI / Parco.
  // (pass 12: 公園通り leaves 神宮通り at the real corner, z −165 — OSM 976275941 / 261815523 — not 15 m short of it, and
  // climbs to PARCO on the real line; the old one ran 3–5 m south of it)
  { id: 'koen', name: '公園通り', path: [[-4, -2], [3, -6], [5, -20], [11, -40], [15, -60], [19, -76], [22, -93], [23, -106], [23, -130], [23, -165], [11, -165.5], [1, -167], [-2, -168], [-30, -180], [-42, -185], [-57, -191], [-70, -197], [-86, -204], [-97, -210], [-104, -215], [-111, -222]], width: 14, lanes: 3, sidewalk: 5, oneway: false },
  { id: 'jingu_n', name: '神宮通り(北)', path: [[23, -165], [23, -222]], width: 16, lanes: 4, sidewalk: 5, oneway: false },
  // East arm: under the JR viaduct to 宮益坂下 (明治通り), then 宮益坂 climbs east.
  { id: 'miyamasu', name: '宮益坂', path: [[-4, -2], [8, -2], [24, 0], [50, 2], [78, 3], [105, 1], [130, -2], [155, -7], [167, -13], [184, -21], [210, -34], [226, -42]], width: 16, lanes: 4, sidewalk: 4, oneway: false },
  // 明治通り runs north–south east of the tracks (Miyashita Park / Hikarie side).
  { id: 'meiji_ne', name: '明治通り', path: [[152, -222], [150, -133], [153, -42], [155, -7], [157, 10], [166, 69], [175, 127], [183, 149], [192, 166]], width: 22, lanes: 4, sidewalk: 5, oneway: false },
  // 井の頭通り starts at 公園通り, runs between Seibu A館 / B館 and on past Loft toward 宇田川交番 (one-way westbound).
  // (pass 12: on OSM 202129903 — west of LOFT the old line ran up to 13 m south of the real road, so the whole 宇田川町
  // frontage on both sides was off; the blocks either side follow it)
  { id: 'inokashira', name: '井の頭通り', path: [[23, -106], [7, -108], [-14, -112], [-39, -117], [-48, -120], [-72, -127], [-82, -129], [-100, -132], [-134, -137], [-147, -139], [-158, -142], [-167, -147], [-190, -155], [-196, -158], [-202, -167], [-204, -172], [-207, -176], [-214, -192], [-216, -197], [-220, -205]], width: 12, lanes: 2, sidewalk: 4, oneway: true },
  // 玉川通り (国道246) skirts the south edge; 首都高3号 runs above it (not modelled).
  { id: 'tamagawa', name: '玉川通り', path: [[-192, 238], [-108, 218], [-57, 210], [-37, 206], [16, 196], [50, 191], [114, 187], [147, 181], [167, 172], [184, 166], [206, 150], [226, 140]], width: 30, lanes: 6, sidewalk: 5, oneway: false },
  // 西口通り along Mark City's north face: one-way westbound (2 lanes) out of the terminal toward 道玄坂上. It leaves the
  // 北行 carriageway at the island nose (the fork node with ekimae_s / _sb / _nb).
  { id: 'nishiguchi', name: '渋谷駅西口通り', path: [[-24, 50], [-31, 53.8], [-38, 55.6], [-46, 57.2], [-59, 59.3], [-98, 69.5], [-124, 80], [-146, 95], [-177, 115], [-202, 130]], width: 7, lanes: 2, sidewalk: 3, oneway: true },
  // ウェーヴ通り along Mark City's south face toward 桜丘.
  { id: 'wave', name: 'ウェーヴ通り', path: [[-29, 104], [-49, 108], [-69, 117], [-98, 128], [-137, 145], [-157, 154]], width: 8, lanes: 1, sidewalk: 2, oneway: true },
  // One-lane 宇田川町 street from 道玄坂下 north across Center-gai to 井の頭通り.
  { id: 'centergai_w_st', name: 'センター街西通り', path: [[-77, -8], [-76, -23], [-71, -65], [-67, -77], [-64, -84], [-53, -114], [-51, -120]], width: 6, lanes: 1, sidewalk: 1.5, oneway: true },
  // Underpass road along Miyashita Park's south end: 公園通り → under the JR tracks → 明治通り.
  { id: 'miyashita_st', name: '宮下通り', path: [[23, -106], [32, -104], [50, -100], [100, -100], [140, -101], [152, -102]], width: 8, lanes: 1, sidewalk: 2, oneway: true },
];

// ------------------------------------------------------------------------------------------------- the crossing
// Five perimeter zebra crossings (pentagon) + two diagonals. Corner names: 三千里 (NW, Center-gai mouth west side),
// Q-FRONT (N), MAGNET (NE), ハチ公 (SE, Hachiko square), 渋谷駅前ビル (SW). Real crossing nodes from OSM:
// W [-32,-5], N [5,-20], E [18,2], S [0,18] / SW-lane [-22,14].
const CROSSWALKS = [
  { id: 'cw_w', name: '道玄坂側', a: [-33, 8], b: [-33, -15], width: 9, stripes: true },     // SW corner ↔ 三千里 corner (across 道玄坂下)
  { id: 'cw_nw', name: 'センター街口', a: [-34, -19], b: [-21, -30], width: 8, stripes: true }, // 三千里 corner ↔ Q-FRONT corner (across the Center-gai mouth)
  { id: 'cw_n', name: 'Q-FRONT前', a: [-4, -24], b: [17, -20], width: 9, stripes: true },     // Q-FRONT ↔ MAGNET (across 公園通り arm)
  { id: 'cw_e', name: 'ハチ公口北', a: [19, -11], b: [19, 12], width: 9, stripes: true },      // MAGNET ↔ Hachiko square (across 宮益坂 arm)
  { id: 'cw_s', name: 'ハチ公前', a: [11, 17], b: [-33, 11], width: 10, stripes: true },       // Hachiko square ↔ 渋谷駅前ビル corner (across 駅前通り, the long one ≈45 m)
];
const DIAGONALS = [
  { id: 'dg_1', name: 'ハチ公↔センター街', a: [13, 15], b: [-34, -19], width: 9 },
  { id: 'dg_2', name: 'MAGNET↔駅前ビル', a: [19, -17], b: [-34, 10], width: 9 },
];
const STOP_LINES = [
  { road: 'dogenzaka_shita', a: [-40, -16], b: [-40, 5] },
  { road: 'koen', a: [-2, -30], b: [17, -30] },
  { road: 'miyamasu', a: [26, -11], b: [26, 10] },
  { road: 'ekimae_s', a: [-24, 21], b: [-6, 25] },
];
// Mid-block / other zebra crossings used by the crowd module.
const CROSSWALKS_EXTRA = [
  { id: 'cx_koen_60', a: [4, -60], b: [26, -60], width: 6 },
  { id: 'cx_koen_ino', a: [12, -100], b: [34, -100], width: 6 },
  { id: 'cx_dogen_77', a: [-77, -22], b: [-77, 10], width: 6 },
  { id: 'cx_dogen_109', a: [-120, -16], b: [-122, 10], width: 8 },
  { id: 'cx_bunka_150', a: [-150, -43], b: [-146, -24], width: 6 },
  // (cx_dogen_170 moved to the real signalled crossing, see the corridor crossings below)
  // 西口: the signalled zebra across the whole terminal (北行 + separator + bus lane + platform + 南行) under the Mark City
  // walkway; one stop line per carriageway (`stops`, travel direction toward the zebra), none painted automatically.
  { id: 'cx_ekimae_80', a: [-35.6, 82.7], b: [-3.8, 78.4], width: 4.5, signals: true,
    stops: [{ road: 'ekimae_nb', a: [-33.3, 86.6], b: [-26.2, 85.6] }, { road: 'nishiguchi_bus', a: [-24.8, 76.6], b: [-20.8, 76.1] }, { road: 'ekimae_sb', a: [-17.2, 75.2], b: [-6.8, 73.8] }] },
  { id: 'cx_ekimae_150', a: [-3, 150], b: [17, 150], width: 6 },
  { id: 'cx_miyamasu_100', a: [100, -12], b: [100, 12], width: 6 },
  { id: 'cx_meiji_shita', a: [140, -16], b: [170, -16], width: 8 },
  { id: 'cx_meiji_100', a: [140, -100], b: [168, -100], width: 6 },
  // 宮益坂下, south arm (OSM footway=crossing 355252213): from the 東口 plaza corner across 明治通り to the りそな side.
  // (There is no surface zebra across 明治通り by the 東口 terminal — the old z = 70 one stood in the bus entrance.)
  { id: 'cx_meiji_shita_s', a: [145.2, 5.6], b: [168.6, 1.8], width: 6 },
  { id: 'cx_ino_60', a: [-60, -128], b: [-60, -117], width: 5 },
  { id: 'cx_ino_150', a: [-150, -147], b: [-150, -133], width: 5 },
  { id: 'cx_jingu_190', a: [10, -190], b: [36, -190], width: 6 },
  { id: 'cx_koen_parco', a: [-70, -190], b: [-78, -212], width: 6 },
  { id: 'cx_nishi_100', a: [-100, 62], b: [-100, 78], width: 5 },
];
// 道玄坂 corridor crossings (OSM highway=crossing nodes, dogenzakaData.js CROSSINGS): the zebra square across its road
// through `at`, kerb to kerb + 0.8 m; a signalled mid-block one gets a stop line per carriageway half, 2 m before it
// (left-hand traffic: the half on the left of each direction of travel).
// (a zebra across a side road at a junction sits where the walkers' pavement line along 道玄坂 crosses that road —
// the crowd walks an offset of the main road, not the real pavement's kink into the side street)
const DG_PAVE = ['dogenzaka','dogenzaka_ue'].map(id=>{const r=ROADS.find(r=>r.id===id);return [id,r.width/2+r.sidewalk/2+.2];});
function segHit(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + r[0] * t, a[1] + r[1] * t] : null;
}
for (const c of DG.CROSSINGS) {
  const r = ROADS.find((q) => q.id === c.road); if (!r) continue;
  if (c.junction && r.side) {
    let best = null;
    for (const [rid, off] of DG_PAVE) for (const o of [off, -off]) {
      const main = ROADS.find((q) => q.id === rid).path, L = main.map((p, i) => { const a = main[Math.max(0, i - 1)], b = main[Math.min(main.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [p[0] - dz / l * o, p[1] + dx / l * o]; });
      for (let i = 0; i < L.length - 1; i++) for (let j = 0; j < r.path.length - 1; j++) { const h = segHit(L[i], L[i + 1], r.path[j], r.path[j + 1]); if (h && (!best || Math.hypot(h[0] - c.at[0], h[1] - c.at[1]) < Math.hypot(best[0] - c.at[0], best[1] - c.at[1]))) best = h; }
    }
    if (best) c.at = best;
  }
  const q = DG.nearestOn(r.path, c.at[0], c.at[1]), nx = -q.tz, nz = q.tx, half = r.width / 2 + 0.8;
  const e = { id: c.id, a: [q.x + nx * half, q.z + nz * half], b: [q.x - nx * half, q.z - nz * half], width: c.width, corridor: true };
  if (c.junction) e.junction = c.junction;
  if (c.signals) {
    e.signals = true;
    const off = c.width / 2 + 2, h2 = r.width / 2 - 0.3;
    // travelling +t: its lanes are on its left, (tz, −tx); the line stands `off` before the zebra, i.e. at −t
    const lx = q.tz, lz = -q.tx;
    e.stops = [
      { road: r.id, a: [q.x - q.tx * off + lx * 0.2, q.z - q.tz * off + lz * 0.2], b: [q.x - q.tx * off + lx * h2, q.z - q.tz * off + lz * h2] },
      { road: r.id, a: [q.x + q.tx * off - lx * 0.2, q.z + q.tz * off - lz * 0.2], b: [q.x + q.tx * off - lx * h2, q.z + q.tz * off - lz * h2] },
    ];
  }
  CROSSWALKS_EXTRA.push(e);
}

// Signals: one vehicle head per arm on the far right-hand corner (lamps pointing at the approaching traffic),
// pedestrian heads at both ends of every crosswalk pointing along it.
const SIGNALS = [
  { pos: [-36, 10], facing: PI, type: 'vehicle', road: 'dogenzaka_shita' },      // faces west → eastbound traffic
  { pos: [19, -25], facing: PI / 2, type: 'vehicle', road: 'koen' },             // faces north → southbound traffic
  { pos: [21, 14], facing: 0, type: 'vehicle', road: 'miyamasu' },               // faces east → westbound traffic
  { pos: [-36, 14], facing: -PI / 2, type: 'vehicle', road: 'ekimae_s' },        // faces south → northbound traffic
];
for (const c of [...CROSSWALKS, ...DIAGONALS]) {
  const dx = c.b[0] - c.a[0], dz = c.b[1] - c.a[1];
  SIGNALS.push({ pos: [c.a[0], c.a[1]], facing: facing(dx, dz), type: 'pedestrian', crosswalk: c.id });
  SIGNALS.push({ pos: [c.b[0], c.b[1]], facing: facing(-dx, -dz), type: 'pedestrian', crosswalk: c.id });
}

// ------------------------------------------------------------------------------------------ pedestrian streets
const PEDESTRIAN_STREETS = [
  // センター街 (Basketball Street): 8–10 m paved street, mouth between the 三千里薬局 corner and Q-FRONT's west face.
  // (the gate stands 5.5 m inside the mouth, beyond the 三千里 ↔ Q-FRONT zebra, square to the street along Q-FRONT's west
  // face — pass 12; it stood on the scramble's carriageway, in front of the zebra)
  { id: 'centergai', name: 'センター街', path: [[-20, -10], [-21, -14], [-22, -18], [-25, -25], [-32, -31], [-45, -46], [-64, -63], [-71, -66], [-98, -71], [-114, -75], [-132, -83], [-159, -94], [-180, -103]], width: 10, surface: 'paving', gate: { pos: [-30.1, -29.4], rotY: facing(0.73, 0.68), width: 10, height: 9 } },
  // Its western continuation to the 宇田川交番 (one-way service access in the morning only).
  { id: 'basketball', name: 'バスケットボールストリート(西)', path: [[-180, -103], [-201, -121], [-214, -140]], width: 8, surface: 'paving' },
  // スペイン坂: 5 m stepped lane from 井の頭通り up to Parco (19 steps at the top).
  { id: 'spainzaka', name: 'スペイン坂', path: [[-165, -146], [-161, -151], [-157, -158], [-155, -168], [-157, -178], [-160, -186]], width: 5, surface: 'stone', steps: { from: [-157, -178], to: [-160, -186], count: 19 } },
  // のんべい横丁: two parallel 2.5 m lanes of 2-storey bars squeezed between the JR viaduct wall and 渋谷東映プラザ.
  { id: 'nonbei_w', name: 'のんべい横丁(西)', path: [[78, -36], [78, -76]], width: 2.5, surface: 'asphalt', lanterns: true },
  { id: 'nonbei_e', name: 'のんべい横丁(東)', path: [[86, -36], [86, -76]], width: 3, surface: 'asphalt', lanterns: true },
  // 宇田川町 back alleys (love-hotel / club / izakaya lanes north of the 109 wedge).
  { id: 'udagawa_1', name: '宇田川町 路地(文化村通り→センター街)', path: [[-137, -29], [-134, -36], [-115, -76]], width: 5, surface: 'asphalt' },
  { id: 'udagawa_2', name: '宇田川町 路地(センター街→井の頭通り)', path: [[-122, -79], [-113, -100], [-105, -122], [-104, -128]], width: 5, surface: 'asphalt' },
  { id: 'udagawa_3', name: '宇田川町 路地(西)', path: [[-181, -49], [-176, -58], [-164, -86], [-162, -92]], width: 5, surface: 'asphalt' },
  // 公園通り's west pavement from Q-FRONT / Seibu up to the MODI fork: pale grey stone slabs, not red brick (client:
  // 「ここに赤い色の歩道っぽいのはないよね」). It IS the road's own west pavement: the centreline is 公園通り's path offset
  // 9.6 m west (7 m half-carriageway + the 5 m pavement's middle), 4.6 m wide so it stops short of the kerb, broken
  // at the 井の頭通り mouth. (The old strip ran 3–7 m east of that, down the carriageway's west lane, and its
  // utility poles / trees stood in the traffic: client 「道路の真ん中に電柱立ってたりおかしいよね」.) The kerb trees are
  // the road's own (props: 公園通り street trees), so the strip carries none, and no utility poles (cables buried).
  { id: 'koen_promenade', name: '公園通り 歩道(西)', path: [[1.7, -42.3], [5.6, -62.1], [9.6, -78], [12.2, -93]], width: 4.6, surface: 'stone', trees: false, poles: false },
  { id: 'koen_promenade_n', name: '公園通り 歩道(西・北)', path: [[13.4, -118], [13.4, -130], [13.4, -152], [10.1, -155.6], [-1.2, -157.6], [-5.7, -159.1], [-12, -161.8]], width: 4.6, surface: 'stone', trees: false, poles: false },
  // 渋谷横丁 (MIYASHITA PARK South 1F, pass 11): the walk between the JR viaduct face (x 76) and the covered stall
  // arcade (x 82.75–87.5, the builder's own floor), from 宮下通り to the 美竹通り passage between the blocks.
  { id: 'miyashita_walk', name: '渋谷横丁', path: [[80.5, -106.5], [80.5, -169]], width: 4.5, surface: 'paving', lanterns: true, poles: false },
];

// 道玄坂 corridor (pass 15): the walk across each zebra over 道玄坂 itself, pavement to pavement (the crowd's pavement
// strips run along the street and never cross it): a few walkers use each, waiting for its green
for (const c of DG.CROSSINGS) {
  if (c.road !== 'dogenzaka' && c.road !== 'dogenzaka_ue') continue;
  const r = ROADS.find((q) => q.id === c.road), q = DG.nearestOn(r.path, c.at[0], c.at[1]), nx = -q.tz, nz = q.tx, h = r.width / 2 + r.sidewalk * 0.6;
  PEDESTRIAN_STREETS.push({ id: 'xw_' + c.id, name: '道玄坂', path: [[q.x + nx * h, q.z + nz * h], [q.x - nx * h, q.z - nz * h]], width: c.width - 1, surface: 'asphalt', poles: false, trees: false, crossing: true });
}

// ------------------------------------------------------------------------------------------------------ plazas
const PLAZAS = [
  {
    id: 'hachiko', name: 'ハチ公前広場',
    polygon: [[13, 12], [40, 12], [43, 54], [3, 54], [3, 30], [8, 26]],
    // the real statue (OSM node 597685675 忠犬ハチ公像, 35.659060N 139.700628E) stands in the square's south-west
    // corner by 駅前通り, 29 m from where it was (client: 「場所がちょっとずれてる」); it faces the ハチ公口 gates
    statue: { pos: [8.0, 46.5], rotY: 0.347 },
    koban: { pos: [27, 46], rotY: PI / 2 },           // 渋谷駅前交番, 2-storey, faces north into the square
    trees: [[14, 34], [26, 22], [36, 50], [38, 28]],  // zelkovas (the one at (16, 46) stood on the statue's apron)
    props: ['smokingArea', 'hachikoFamilyMural', 'greenTramStop'],
  },
  {
    // the west pavement in front of Mark City's east end: 北行 bus stops 2–4 (bus in the kerb lane, shelter 3.2 m west).
    // The island platforms (stops 21–26) and the 南行 kerb stops (29–33) are CITY.busStops, dressed by the city module.
    id: 'nishiguchi_w', name: '西口バスのりば',
    polygon: [[-51.5, 61], [-37, 61], [-35.2, 64], [-35.2, 70], [-33.8, 80], [-32.3, 90], [-31, 98.5], [-46.7, 98.5], [-48.5, 90], [-50, 80], [-51, 70], [-52, 64]],
    busBays: [[-32.9, 65], [-30.5, 89], [-25.9, 115.5]],
  },
  {
    id: 'moyai', name: '西口広場(モヤイ像)',
    polygon: [[-40, 128], [-24, 128], [-22, 150], [-40, 150]],
    statue: { pos: [-32, 140], rotY: 0 },
    trees: [[-37, 132], [-37, 146]],
  },
  {
    // 東口 広場: the pavement between 宮益坂 and the 東口 bus terminal's north leg (のりば 56 / 58, the 東口地下広場
    // stair house and lift). The terminal itself is CITY.busTerminals.higashi; `terminal` = no plaza dressing
    // (bollard rim, planters, benches, shelters), the bus stops and canopies are the city module's (eastExit.js).
    id: 'east_bus', name: '東口バスターミナル', terminal: 'higashi',
    polygon: [[92, 14.5], [112, 12.4], [131, 9.4], [146.5, 6.9], [147.5, 12], [140, 19.6], [128, 19.8], [121, 21.5], [116, 25], [112.5, 29.5], [108.5, 26.6], [107.2, 25.6], [100.4, 25.6], [88.6, 27.4]],
  },
  {
    id: 'inaribashi', name: '稲荷橋広場',
    polygon: [[174, 170], [190, 180], [186, 187], [170, 178]],   // in front of Stream, over the 渋谷川
  },
];

// ------------------------------------------------------------------------------------ 西口 bus terminal (real)
// Bus-only lane between the carriageways (OSM access=no bus=yes): it leaves the 南行 carriageway at the island nose,
// runs south between the separator (west, 1–2 m, guard fence) and the island platforms (east, 4–13 m, long canopies),
// turns east at the south end and rejoins 南行 at z ≈ 140. Buses stop on their left, so the platforms are EAST of it.
// Asphalt in the street field, but not in CITY.roads: traffic may route buses along it (see docs/reports/city.md).
const BUSWAYS = [
  { id: 'nishiguchi_bus', name: '西口 バス専用', path: [[-11, 52], [-17, 54.5], [-21.5, 57], [-23.6, 60], [-24.6, 64], [-24.4, 69.2], [-22.8, 81.1], [-20.3, 97.1], [-17.4, 112.9], [-15.7, 121.7], [-14.2, 126.5], [-12.5, 129.7], [-9.8, 132.7], [-6, 134.8], [2.6, 138.1], [8.5, 140.5]], width: 4, lanes: 1, oneway: true, busOnly: true },
  // 東口 (real, OSM psv ways 1462557421 … 350053202 + the 2024-12-14 のりば plan): one clockwise loop. Buses leave 明治通り
  // 北行 at Scramble Square's north-east corner (a T, at right angles), run west along the Scramble Square face (のりば
  // 51), turn up the diagonal west leg that follows the OSM bus way 5 m to its west, beside the 東口 construction yard
  // (59, 54, 56), turn east along the 東口 広場 (58) and rejoin 明治通り 32 m short of 宮益坂下. The path is the kerb
  // lane's centre (kerb 2 m to its left, the doors' side); the loop's interior is the terminal apron (CITY.aprons: the
  // bus waiting area round the disused island).
  { id: 'higashiguchi_bus', name: '東口 バス専用', terminal: 'higashi',
    path: [[166.8, 74], [160, 74.3], [152, 75.3], [146, 77.1], [143.8, 77.4], [142.4, 77.5], [141, 77.4], [139.7, 77], [138.4, 76.3], [137.3, 75.5], [136.4, 74.5], [135.6, 73.3], [135, 72], [122.3, 33.7], [122, 32.3], [122, 30.8], [122.3, 29.4], [122.9, 28], [123.8, 26.8], [124.8, 25.8], [126.1, 25.1], [127.5, 24.7], [129, 24.5], [136, 24.5], [141.5, 24.5], [147, 24.8], [152.5, 25.7], [159.6, 27]],
    width: 4, lanes: 1, oneway: true, busOnly: true },
];
// Terminal aprons: carriageway that is no traffic lane (the buses' waiting area, turn flares). The street field
// treats them as road (kerbs, keepOffRoad), CITY.raised islands stand on them.
const APRONS = [
  // the loop's interior: the former island's surroundings, now the 待機場所 where each route's buses lay over
  { id: 'higashi_wait', polygon: [[151, 75.4], [146, 77.1], [143.8, 77.4], [142.4, 77.5], [141, 77.4], [139.7, 77], [138.4, 76.3], [137.3, 75.5], [136.4, 74.5], [135.6, 73.3], [135, 72], [122.3, 33.7], [122, 32.3], [122, 30.8], [122.3, 29.4], [122.9, 28], [123.8, 26.8], [124.8, 25.8], [126.1, 25.1], [127.5, 24.7], [129, 24.5], [136, 24.5], [141.5, 24.5], [147, 24.8], [144.1, 31], [149.4, 66]] },
  // exit throat: over the 明治通り west pavement between 宮益坂下 and the taxi island
  { id: 'higashi_exit', polygon: [[139, 19.3], [145.5, 11.3], [146.6, 11.3], [149.7, 31], [143.9, 31], [140, 24]] },
  // entry throat: the 明治通り west pavement south of the taxi island and Scramble Square's north-east corner
  { id: 'higashi_entry', polygon: [[143.5, 79.6], [150, 80.4], [156.2, 82], [157.4, 82], [157.4, 80.6], [155, 66], [149.4, 66], [151, 75.4]] },
  // the two right-hand corners: a bus's nose swings ~1.7 m out over the kerb line on a 7–8 m turn, so the outer kerb
  // stands 4.2 m off the lane there (tapering back to 2 m either side; a bus pulling in for 59 / 58 is already 0.3 m
  // toward the kerb as it leaves the corner)
  { id: 'higashi_sw', polygon: [[144.1, 79.4], [143, 80], [141.6, 80.5], [139.7, 80.8], [138.6, 81.1], [137, 80.3], [135.6, 79.5], [134.8, 78.9], [133.5, 77.6], [132.5, 76.3], [131.7, 74.9], [131.3, 74], [130.8, 72.6], [130.5, 71.6], [130.1, 70.7], [129.8, 69.7], [129.5, 68.8], [129.2, 67.8], [128.9, 66.9], [128.8, 65.8], [129.4, 64.6], [130.6, 63.9], [132.4, 63.6], [132.9, 65.6], [133.8, 68.4], [134.8, 71.3], [136, 74], [138.1, 76.1], [140.8, 77.3], [143.8, 77.4]] },
  { id: 'higashi_nw', polygon: [[120.7, 35.3], [119.9, 34.5], [119.1, 33.4], [118.4, 31.8], [117.9, 29.9], [118.1, 28.9], [118.7, 27.2], [119.6, 25.4], [120.2, 24.6], [121.2, 23.4], [123, 22], [123.8, 21.5], [125.6, 20.9], [127.2, 20.5], [128.2, 20.4], [129.7, 20.3], [130.7, 20.3], [131.7, 20.3], [132.7, 20.3], [133.7, 20.3], [134.7, 20.3], [135.7, 20.3], [136.7, 20.3], [137.7, 20.4], [138.7, 21.7], [138.7, 24.5], [135.7, 24.5], [132.7, 24.5], [129.7, 24.5], [126.8, 24.9], [124.2, 26.4], [122.5, 28.8], [122, 31.8], [122.6, 34.7]] },
];
// Raised islands standing on an apron: the 東口 terminal's former island platform (都01 / 都06 / 田87 until
// 2024-12-14), fenced off and disused under the 銀座線 station.
const RAISED = [
  { id: 'higashi_old_island', terminal: 'higashi', disused: true, polygon: [[130.7, 44.6], [134.5, 43.3], [139.7, 59.3], [139.7, 60.2], [136.8, 61.2], [135.9, 60.6]] },
];
// Every bus stop of the terminal: pos = where the bus stands (kerb lane / bay centre), heading = travel direction
// (rotY, as facing()), kerb = which pavement the pole stands on. ref = the real 渋谷駅 のりば number.
const BUS_STOPS = [
  // 北行, west pavement (京王 / 小田急 / 東急): 2–4 also carry props shelters via PLAZAS.nishiguchi_w.busBays
  { id: 'nb2', ref: '2', road: 'ekimae_nb', pos: [-32.9, 65], heading: facing(0, -1), kerb: 'west', op: '京王バス' },
  { id: 'nb3', ref: '3', road: 'ekimae_nb', pos: [-30.5, 89], heading: facing(0.15, -1), kerb: 'west', op: '小田急バス' },
  { id: 'nb4', ref: '4', road: 'ekimae_nb', pos: [-25.9, 115.5], heading: facing(0.25, -1), kerb: 'west', op: '東急バス' },
  { id: 'nb5', ref: '5', road: 'ekimae_nb', pos: [-19.1, 134], heading: facing(-0.64, -0.77), kerb: 'west', op: '東急バス' },
  // island platforms, served from the bus lane (door side = east; 26 from the eastbound return leg, door side = north)
  { id: 'i21', ref: '21', road: 'nishiguchi_bus', pos: [-24.3, 63], heading: facing(0, 1), kerb: 'island', op: '東急バス', alight: true },
  { id: 'i22', ref: '22', road: 'nishiguchi_bus', pos: [-24.1, 71.5], heading: facing(0.1, 1), kerb: 'island', op: '東急バス' },
  { id: 'i23', ref: '23', road: 'nishiguchi_bus', pos: [-20.8, 94], heading: facing(0.16, 1), kerb: 'island', op: '東急バス' },
  { id: 'i24', ref: '24', road: 'nishiguchi_bus', pos: [-18.1, 109], heading: facing(0.18, 1), kerb: 'island', op: '京王バス', alight: true },
  { id: 'i25', ref: '25', road: 'nishiguchi_bus', pos: [-15.4, 123.5], heading: facing(0.3, 1), kerb: 'island', op: '京王バス' },
  { id: 'i26', ref: '26', road: 'nishiguchi_bus', pos: [1.5, 137.7], heading: facing(1, 0.38), kerb: 'island', op: '京王バス' },
  // 南行, east pavement along the construction hoarding (ハチ公バス / 富士急 / 東急)
  { id: 's29', ref: '29', road: 'ekimae_sb', pos: [-9.3, 66], heading: facing(-0.05, 1), kerb: 'east', op: '富士急バス' },
  { id: 's30', ref: '30', road: 'ekimae_sb', pos: [-6.6, 92.5], heading: facing(0.2, 1), kerb: 'east', op: 'ハチ公バス' },
  { id: 's31', ref: '31', road: 'ekimae_sb', pos: [1.3, 111], heading: facing(0.5, 0.87), kerb: 'east', op: '東急バス' },
  { id: 's32', ref: '32', road: 'ekimae_sb', pos: [10.1, 126.1], heading: facing(0.52, 0.86), kerb: 'east', op: '東急バス' },
  { id: 's33', ref: '33', road: 'ekimae_sb', pos: [12.6, 144], heading: facing(0.08, 1), kerb: 'east', op: '東急バス' },
  // ---- 東口 (渋谷駅東口 / 渋谷駅前(東口)), the のりば plan in force since 2024-12-14 (東京都交通局 notice; the island
  // platform was closed and became the 待機場所): on the loop's outer kerbs, each bus serving ONE のりば (its route's).
  // `routes` = the real 系統 at that のりば (行き先 / 主な経由地 as on the official plan), `pole` = the のりば pole, `queue` =
  // where its passengers line up (along the kerb behind the pole, 0.75 m apart, first = head of the line; set back
  // from the kerb where a corner's wider kerb runs past the bay: 58, 59).
  // `doors`: a bus standing here opens its middle door (traffic). Near-names per docs/NAMES.md: 東急バス → 東光バス.
  { id: 'e51', ref: '51', road: 'higashiguchi_bus', terminal: 'higashi', kerb: 'south', op: '都営バス', doors: true, canopy: 'scramble',
    pos: [143.3, 77.4], heading: facing(-0.997, 0.071), pole: [144.1, 80.1],
    routes: [{ no: '都01', to: '新橋駅', via: '赤坂アークヒルズ', en: 'SHIMBASHI STA.' }, { no: 'RH01', to: '六本木ヒルズ', via: '西麻布', en: 'ROPPONGI HILLS' }],
    queue: [[145.2, 81.4], [145.9, 81.4], [146.7, 81.3], [147.4, 81.3], [148.2, 81.2], [148.9, 81.2], [149.7, 81.1], [150.4, 81.1]] },
  { id: 'e59', ref: '59', road: 'higashiguchi_bus', terminal: 'higashi', kerb: 'west', op: '都営バス', doors: true, canopy: 'station',
    // (2 m further up the straight than the OSM pole: a bus braking into the bay had its tail still on the corner arc)
    pos: [131.4, 61.1], heading: facing(-0.315, -0.949), pole: [128.6, 62.7],
    routes: [{ no: '渋88', to: '新橋駅', via: '神谷町駅', en: 'SHIMBASHI STA.' }],
    queue: [[126.9, 64.3], [127.1, 65], [127.3, 65.7], [127.6, 66.4], [127.8, 67.1], [128, 67.8]] },
  { id: 'e54', ref: '54', road: 'higashiguchi_bus', terminal: 'higashi', kerb: 'west', op: '都営バス', doors: true, canopy: 'green',
    pos: [128, 50.9], heading: facing(-0.315, -0.949), pole: [125.6, 52.3],
    routes: [{ no: '学03', to: '日赤医療センター', via: '国学院大学', en: 'JAPANESE RED CROSS MEDICAL CENTER' }],
    queue: [[125.1, 53.5], [125.4, 54.2], [125.6, 54.9], [125.8, 55.6], [126.1, 56.3], [126.3, 57.1], [126.5, 57.8], [126.8, 58.5]] },
  { id: 'e56', ref: '56', road: 'higashiguchi_bus', terminal: 'higashi', kerb: 'west', op: '都営バス', doors: true, canopy: 'green',
    pos: [124, 38.7], heading: facing(-0.315, -0.949), pole: [121.5, 40.1],
    routes: [{ no: '田87', to: '田町駅', via: '白金高輪駅・魚籃坂下', en: 'TAMACHI STA.' }],
    queue: [[121.1, 41.3], [121.3, 42.1], [121.6, 42.8], [121.8, 43.5], [122, 44.2], [122.3, 44.9], [122.5, 45.6], [122.7, 46.3]] },
  { id: 'e58', ref: '58', road: 'higashiguchi_bus', terminal: 'higashi', kerb: 'north', op: '都営バス', doors: true, canopy: 'green',
    pos: [138, 24.5], heading: facing(1, 0), pole: [137.4, 19.9],
    routes: [{ no: '都06', to: '新橋駅', via: '赤羽橋駅', en: 'SHIMBASHI STA.' }],
    queue: [[136.4, 19], [135.6, 19], [134.9, 19], [134.1, 19], [133.4, 19], [132.6, 19], [131.9, 19], [131.1, 19]] },
  // 52 / 53 (東光バス 渋71 / 渋72) stand on 明治通り 南行's kerb in front of ヒカリエ; 明治通り's lanes run 5 m off
  // that kerb here, so they are kerb-only (road: null — traffic does not stop its buses mid-road for them).
  { id: 'e53', ref: '53', road: null, terminal: 'higashi', kerb: 'east', op: '東光バス', canopy: 'shelter',
    pos: [172.6, 52], heading: facing(0.153, 0.988), pole: [175.3, 51.6],
    routes: [{ no: '渋72', to: '五反田駅', via: '恵比寿駅・目黒不動尊', en: 'GOTANDA STA.' }],
    queue: [[175.9, 49.9], [175.7, 49.1], [175.6, 48.4], [175.5, 47.6], [175.4, 46.9], [175.3, 46.2], [175.2, 45.4], [175, 44.7]] },
  { id: 'e52', ref: '52', road: null, terminal: 'higashi', kerb: 'east', op: '東光バス', canopy: 'shelter',
    pos: [179.4, 96], heading: facing(0.153, 0.988), pole: [182.1, 95.6],
    routes: [{ no: '渋71', to: '洗足駅', via: '代官山駅入口・目黒区総合庁舎', en: 'SENZOKU STA.' }],
    queue: [[182.7, 93.9], [182.6, 93.1], [182.5, 92.4], [182.4, 91.6], [182.3, 90.9], [182.2, 90.2], [182.1, 89.4], [182, 88.7]] },
];
// 道玄坂上（交番前）: the up-hill kerb stop on 道玄坂 (OSM bus_stop node), served from the kerb lane of 'dogenzaka_ue'
// (terminal 'dogenzaka': westExit.js leaves it alone, buildings/dogenzaka.js stands its pole and bench)
{
  const b = DG.BUS_STOP, r = ROADS.find((q) => q.id === b.road), q = DG.nearestOn(r.path, b.pole[0], b.pole[1]);
  const lx = q.tz, lz = -q.tx;                                    // left of the up-hill direction = the pole's kerb
  BUS_STOPS.push({ id: b.id, ref: b.ref, name: b.name, road: b.road, terminal: 'dogenzaka', kerb: 'left', op: b.op,
    pos: [Math.round((q.x + lx * 5.2) * 10) / 10, Math.round((q.z + lz * 5.2) * 10) / 10], heading: facing(q.tx, q.tz), pole: b.pole });
}
// 渋谷町駅 東口 バスターミナル (the terminal-level data; the stops are in BUS_STOPS, its carriageway in BUSWAYS /
// APRONS / RAISED). Layover = the buses standing in the 待機場所 [x, z, rotY, route no]; routeColors = the 系統 badge
// colours of the 方向幕 / のりば plates.
const BUS_TERMINALS = {
  higashi: {
    name: '渋谷町駅 東口バスターミナル', busway: 'higashiguchi_bus',
    outline: [[92, 14.5], [146.5, 6.9], [149.7, 31], [157.2, 80], [156.8, 82.7], [107.4, 90.1], [97.6, 70.2], [88.2, 27.5]],
    // (rotY as facing(): the layover buses nose north, toward the exit; a 東光 bus stands at 53 on 明治通り)
    layover: [[143, 43.5, facing(0.02, -1), '都01'], [143.2, 57, facing(0.02, -1), '渋88']],
    kerbside: [[172.6, 52, facing(0.153, 0.988), '渋72']],
    routeColors: { '都01': '#e4007f', 'RH01': '#00a0e9', '渋88': '#0068b7', '学03': '#009944', '田87': '#e4007f', '都06': '#0068b7', '渋71': '#d7262b', '渋72': '#d7262b' },
    operators: { '都営バス': { body: 0x4f9f3f, en: 'TOEI BUS' }, '東光バス': { body: 0xe9e7df, en: 'TOKO BUS' } },
  },
};
// 渋谷駅街区 中央棟・西棟: the former 東急東横店 site between the 南行 pavement and the JR station is a construction yard
// (OSM landuse=construction) behind a 3 m white hoarding; the 銀座線 viaduct and the Mark City walkway cross it.
// Openings in the ground (stair / escalator wells down to the station levels): streets.js leaves them out of the
// terrain grid and the pavement, the owning builder lines and fences them. Axis-aligned rectangles.
// The JR station's south block under the tracks (1F 南改札 + 東口), pass 12: from the station's east face to Scramble
// Square's west face / the viaduct's east edge, z 84 → 玉川通り; `opening` = the 東口 recess on its east face (two
// consecutive outline vertices)
const STATION_SOUTH = {
  polygon: [[84, 84], [96.1, 84], [98.6, 90.1], [102.4, 99.3], [104.5, 104.4], [107.1, 104.4], [114.2, 123.8], [125.3, 145.1], [133.5, 157], [136, 164], [104.5, 166], [100.8, 159.6], [88.1, 135.2], [84, 124]],
  opening: [[98.6, 90.1], [102.4, 99.3]],
};
const GROUND_HOLES = [
  {id:'shinsen_rail_cutting',x0:-646,z0:240,x1:-578,z1:258},
  { id: 'higashiguchi', x0: 108.5, z0: 91, x1: 115, z1: 94.5 },   // JR 東口 前: escalators down to the 地下鉄 gates
  { id: 'uc', x0: 140, z0: 96, x1: 146.5, z1: 99.5 },             // Scramble Square 東口 アーバン・コア: escalators to B1/B2
  { id: 'exit15', x0: 149.5, z0: 116, x1: 155.5, z1: 119.5 },     // 東京メトロ 渋谷駅 15番出口 (明治通り): stair
];
const SITES = [
  { id: 'eki_central', name: '渋谷駅街区 中央棟・西棟 新築工事', polygon: [[-1.5, 58], [28, 58], [28, 122], [14, 122], [9, 114.5], [5, 106], [1.5, 97], [-0.5, 84], [-1.5, 70]], hoarding: 3.2, frames: true },
  // 東口: the strip between the JR station's east face and the terminal's west pavement (OSM landuse=construction
  // 1333409432, 渋谷駅東口 土地区画整理 — the future 東口 広場) as mapped, short of Scramble Square, leaving the stair house
  // of the 東口地下広場 (B7) at its north-west corner.
  { id: 'higashi_yard', name: '渋谷町駅東口 土地区画整理事業 東口広場整備工事', polygon: [[100.2, 25.6], [107.2, 25.4], [108.5, 26.4], [127, 82.6], [125.4, 85.5], [119.2, 86.8], [108.1, 88.4], [104.3, 81.7], [99, 69.7], [94.4, 44.6], [101.4, 42.6]], hoarding: 3.0, print: 'higashi' },
];

// -------------------------------------------------------------------------------------------------------- rail
const RAIL = {
  // JR (山手線 ×2 + 湘南新宿/埼京 ×2) on a viaduct/embankment east of Hachiko square, curving south-east.
  jr: { name: 'JP 山手線', path: [[63, -222], [63, -160], [63, -113], [65, -40], [66, 20], [72, 60], [80, 80], [89, 100], [100, 130], [112, 153], [125, 172], [140, 198]], elevation: 7, width: 26, tracks: 4 },
  // 東京メトロ銀座線: 3F-level viaduct that runs THROUGH Mark City, over the bus island and the JR tracks, to its
  // station (2020) whose hall spans the 東口 bus terminal and 明治通り to Hikarie. East of the JR tracks the line is the
  // OSM alignment (railway=subway 16688536 / the station building 810356690), i.e. over the terminal's south half.
  ginza: { name: '東京メトロ 銀座線', path: [[-72, 102], [-44, 98], [0, 88], [60, 75], [102, 66.8], [129, 60.8], [150, 50], [164, 36.5], [170, 27.5], [185, 8], [205, -4], [224, -14]], elevation: 12, width: 8, tracks: 2, station: { from: [104, 66], to: [181, 13] } },
  // 京王井の頭線: terminates on Mark City's 2F; only the tail south-west of Mark City is visible.
  inokashira: { name: '井の頭線', path: [[-226, 152], [-190, 137], [-160, 125], [-124, 105]], elevation: 6, width: 12, tracks: 2 },
};

// --------------------------------------------------------------------------------------------------- landmarks
// footprint: 'rect' (size [w, h, d] centred on pos, rotated rotY), 'wedge' / 'polygon' (polygon given in world
// [x, z]; size is the real-proportion bounding box [w, h, d]). storeys = above-ground floors.
const LANDMARKS = {
  shibuya109: {
    name: 'SHIBUYA ARC', real: 'SHIBUYA 109', pos: [-163, -13], rotY: facing(132, 8), footprint: 'wedge',
    size: [63, 42, 51], storeys: 10,
    polygon: [[-132, -8], [-136, -14], [-142, -19], [-150, -13], [-161, -27], [-184, -39], [-195, -24], [-195, -17], [-185, -2], [-179, 12], [-137, -1]],
    // (pass 12: the drum on the real tip — OSM 55895868's apex curve — 20 m across; the old 30 m one centred 6 m back
    // stood 2.9 m into 道玄坂's carriageway)
    cylinder: { center: [-140.8, -9.8], radius: 10 },
    screen: { w: 10, h: 6, faces: facing(132, 8), name: '109フォーラムビジョン' },
    notes: 'Contemporary exterior: silver square-panel cylinder, open gold entrance truss and side stair; original ARC identity and fictional campaign. See docs/reports/109-exterior.md.',
  },
  qfront: {
    name: 'Q-FRONT', pos: [-18, -43], rotY: facing(0.25, 0.97), footprint: 'polygon', size: [36, 35, 28], storeys: 8,
    polygon: [[-31, -59], [-1, -50], [-2, -47], [-6, -33], [-11, -32], [-17, -31], [-23, -32], [-37, -45]],
    screen: { w: 20, h: 12, faces: facing(0.25, 0.97), center: [-14, -32], bottom: 5, name: "Q's EYE" },
    tenants: ['TSUTAYU', 'STARBEANS COFFEE'],
    notes: 'Curved glass corner directly north of the crossing between the Center-gai mouth (west) and 公園通り (east); Q\'s EYE LED covers floors 2–8 of the south face; rooftop steel sign frame to ≈46 m.',
  },
  magnet: {
    name: 'MAGNET by SHIBUYA 1O9', real: 'MAGNET by SHIBUYA109 (旧 109MEN\'S)', pos: [33, -42], rotY: facing(-0.85, 0.52), footprint: 'polygon', size: [27, 34, 61], storeys: 7,
    polygon: [[19, -22], [26, -13], [43, -12], [43, -29], [46, -65], [36, -66], [37, -71], [30, -73]],
    screen: { w: 14, h: 10, faces: facing(-0.85, 0.52), center: [22, -18], bottom: 6, name: '109フォーラムビジョン' },
    rooftop: 'MAG\'s PARK crossing view deck',
    notes: 'Slim 7-storey silver-panel building on the north-east corner; big LED on its south-west corner; roof deck looks down on the crossing.',
  },
  ekimaeBldg: {
    name: '渋谷駅前ビル', pos: [-58, 30], rotY: facing(0.7, -0.7), footprint: 'polygon', size: [31, 35, 48], storeys: 9,
    polygon: [[-70, 7], [-53, 8], [-45, 17], [-43, 20], [-49, 52], [-59, 55], [-74, 34], [-74, 26]],
    screens: [{ w: 12, h: 8, faces: facing(0.7, -0.7), center: [-44, 18], bottom: 8, name: 'DHCチャンネル' }, { w: 10, h: 6, faces: facing(0.7, -0.7), center: [-44, 18], bottom: 18, name: 'グリコビジョン' }],
    tenants: ['ブックオン', 'ドトルコーヒー', 'アコン', 'カラオケ舘', '渋谷町クリニック'],
    notes: 'Glass 9-storey block on the south-west corner (道玄坂 × 駅前通り) carrying two stacked LED screens aimed at the crossing.',
  },
  scrambleSquare: {
    name: '渋谷スクランブルスクエア', pos: [137, 119], rotY: 0.15, footprint: 'rect', size: [50, 230, 66], storeys: 47,
    crown: 'SHIBUYA SKY', deck: { level: 46, name: 'SHIBUYA SKY' },
    // the ground floor's real outline (OSM 617560918; the 明治通り face moved onto the game's pavement line = the road
    // offset 16.2 m west, the west face kept 2.5 m off the JR viaduct): `corner` = the 東口 アーバン・コア corner, `north` /
    // `east` = the next vertices along the terminal face / the 明治通り face, `before` / `after` = the rest of the ring,
    // exit15 = the Metro exit's recess in the 明治通り face (x of the face at z0 / z1, back wall x)
    groundFloor: {
      corner: [151.9, 83.5], north: [122.9, 98.2], east: [159.2, 130.4],
      before: [[107.1, 104.4], [122.9, 98.2]],
      after: [[159.2, 130.4], [166.9, 151.9], [133.5, 157], [125.3, 145.1], [114.2, 123.8]],
      exit15: { z0: 115.5, z1: 120, face0: 156.88, face1: 157.58, x: 149 },
      deckEnd: [158.2, 88],                             // where the 2F deck from ヒカリエ (eastExit.js) lands in the core
    },
    notes: 'The 230 m glass tower rises directly above the station east of the JR tracks and south of the Ginza-line viaduct; slightly rotated to follow the tracks.',
  },
  hikarie: {
    // (pass 12: podium 46 × 60 pulled back 5 m from 明治通り onto the real building line — OSM 204091879's west face at
    // x 181–187 — the old one stood 2.7 m into the kerb lane at its north-west corner)
    name: 'ヒカリエ', pos: [205, 43], rotY: 0, footprint: 'rect', size: [38, 182, 54], storeys: 34,
    notes: 'Across 明治通り east of the tracks. Stacked "glass box" tower; 4-storey podium ShinQs on 明治通り with the Ginza-line deck on its north side.',
  },
  station: {
    name: '渋谷町駅', real: '渋谷駅 ハチ公口 (JR)', pos: [62, 68], rotY: 0, footprint: 'rect', size: [44, 18, 112], storeys: 3,
    hachikoExit: { pos: [41, 22], rotY: PI, sign: 'JP 渋谷町駅 ハチ公口' },
    notes: 'Long low concourse block under and beside the JR viaduct from the 宮益坂 arm south to the west deck; Hachiko-exit ticket gates at its north-west corner facing the square, green JP signage.',
  },
  markCity: {
    name: '渋谷マークシティ', pos: [-135, 112], rotY: 0.55, footprint: 'polygon', size: [175, 100, 45], storeys: 25, podiumStoreys: 5,
    // (pass 12: the south face on the real building line along ウェーヴ通り — OSM 87250190 — instead of 3–4 m into it)
    polygon: [[-53, 64], [-47.4, 101.5], [-51.3, 102.4], [-71.1, 111.3], [-102.5, 123.3], [-159.6, 148.5], [-162.2, 150.9], [-165, 152], [-201, 160], [-224, 168], [-225, 150], [-201, 141], [-173, 135], [-154, 112], [-120, 92], [-84, 78], [-64, 67]],
    towers: [{ pos: [-90, 96], size: [40, 100, 34], name: 'EAST (エクセル東急)' }, { pos: [-190, 148], size: [40, 92, 30], name: 'WEST' }],
    notes: 'Long low-rise (5-storey podium, two 25-storey towers) south of 道玄坂 along the 井の頭線; the Ginza line passes through its 3F; 井の頭線 terminus on 2F.',
  },
  parco: {
    name: '渋谷PALCO', real: '渋谷PARCO', pos: [-158, -204], rotY: 0, footprint: 'polygon', size: [85, 100, 38], storeys: 19,
    polygon: [[-196, -186], [-158, -192], [-134, -197], [-116, -204], [-124, -216], [-132, -222], [-198, -222], [-200, -208]],
    notes: '2019 rebuild: 19 storeys / 100 m, stepped dark-glass volume with the spiralling "立体街路" terrace ramp; south-east face on 公園通り, スペイン坂 arrives at its south-west corner.',
  },
  modi: {
    name: '渋谷マルコ / MOD1', real: '渋谷モディ (MODI)', pos: [-4, -188], rotY: 0, footprint: 'polygon', size: [31, 35, 30], storeys: 9,
    // (south faces pulled back to 公園通り's north pavement line — the old tip stood 5 m into the carriageway: props audit)
    polygon: [[11, -199], [10.1, -177.9], [8.5, -178.3], [-3.2, -180.8], [-19.2, -190.4], [-18, -203], [-6, -203], [-6, -198]],
    notes: 'Slim 9-storey white-panel block in the wedge where 公園通り forks from 神宮通り; big "MOD1" sign on the south tip facing the fork.',
  },
  towerRecord: {
    name: 'TOWER RECORD 渋谷', real: 'タワーレコード渋谷店', pos: [48, -204], rotY: 0, footprint: 'rect', size: [27, 40, 30], storeys: 8,
    notes: 'Yellow façade, red "TOWER RECORD" lettering on the west face onto 神宮通り, north of the MODI fork.',
  },
  loft: {
    name: 'LOFTY', real: '渋谷ロフト (西武渋谷店ロフト館)', pos: [-92, -162], rotY: 0, footprint: 'polygon', size: [50, 34, 42], storeys: 7,
    polygon: [[-67, -163], [-83, -141], [-111, -156], [-117, -156], [-112, -182], [-72, -183]],
    notes: 'Yellow LOFT signage on a tan tile block on 井の頭通り north side, west of Seibu B館; スペイン坂 climbs past its west end.',
  },
  seibu: {
    name: '西部渋谷店 A館', real: '西武渋谷店A館', pos: [-28, -85], rotY: 0, footprint: 'polygon', size: [70, 30, 59], storeys: 8,
    polygon: [[-48, -110], [-55, -98], [-61, -83], [-41, -73], [-36, -66], [-37, -62], [-1, -51], [9, -93], [6, -99], [-24, -105]],
    notes: 'Big irregular department-store block north of Q-FRONT between Center-gai and 公園通り; dark-brown vertical fins, "SEIBO" logo on the 公園通り face.',
  },
  seibuB: {
    name: '西部渋谷店 B館', real: '西武渋谷店B館', pos: [-27, -142], rotY: 0, footprint: 'polygon', size: [76, 31, 52], storeys: 8,
    // (pass 12: the 公園通り face out to the realigned road's building line)
    polygon: [[6, -116], [-35, -124], [-62, -132], [-56, -146], [-64, -160], [-50, -173], [-34.7, -168.5], [-6.6, -156.5], [-1.7, -155], [11, -153], [11, -120]],
    notes: 'Twin of A館 across 井の頭通り; sky-bridge between them over 井の頭通り at 3F.',
  },
  miyashitaPark: {
    name: '宮下パーク', real: 'MIYASHITA PARK', pos: [108, -163], rotY: 0, footprint: 'polygon', size: [51, 18, 113], storeys: 4,
    // pass 11: the South block (tip on 宮下通り, east face behind the 明治通り office row), the 美竹通り passage with the
    // grand stair, the North block + hotel; layout and OSM sources in buildings/miyashitaParkData.js
    polygon: [[83, -107], [104, -107], [123, -144], [128.5, -144], [128.5, -158], [133.5, -170], [133.5, -220], [84, -220], [84, -170], [83, -158]],
    notes: 'RAYARD MIYASHITA PARK: 3 open-gallery retail floors under 渋谷区立宮下公園 (+17.5 m: skate park, bouldering, sand court, lawn, STARBEANS) between the JR tracks and 明治通り, split by the 美竹通り passage and its grand stair; 渋谷横丁 on the South block 1F track side; hotel sequense on the north end; footbridges over 明治通り.',
  },
  fukuras: {
    name: '渋谷フクラス', real: '渋谷フクラス (東急プラザ渋谷)', pos: [-36, 172], rotY: 0.15, footprint: 'rect', size: [66, 104, 32], storeys: 18,
    notes: 'South-west of the station at the end of 駅前通り: 18-storey dark-metal grid tower over a bus terminal; 東急プラザ signage; the Moyai statue stands at its north side.',
  },
  stream: {
    // (pass 12: OSM 521438304 in the compressed map, clear of 玉川通り: `fitted` = size is the podium outline, the
    // tower is inset 3 m; the old 58 × 48 podium stood 12 m into the carriageway)
    name: 'ストリーム', real: '渋谷ストリーム', pos: [193.5, 203.1], rotY: 0.74, footprint: 'rect', size: [27, 180, 34], storeys: 35, fitted: true,
    notes: 'South-east across 玉川通り on the old 東横線 platforms; 180 m tower with the reopened 渋谷川 promenade and 稲荷橋広場 at its foot.',
  },
  sakuraStage: {
    // (pass 12: SHIBUYA Tower, OSM 1200029947, in the compressed map and clear of 玉川通り — it stood 15 m into it)
    name: 'サクラステージ', real: 'Shibuya Sakura Stage', pos: [124, 220.5], rotY: 1.32, footprint: 'rect', size: [19, 180, 52], storeys: 39,
    notes: 'South-west of the tracks beyond the station; 39-storey tower — a skyline silhouette at the south edge of the map.',
  },
  nonbei: {
    name: 'のんべい横丁', pos: [84, -56], rotY: PI / 2, footprint: 'polygon', size: [14, 7, 42], storeys: 2,
    polygon: [[76, -34], [92, -34], [92, -78], [76, -78]],
    lanes: ['nonbei_w', 'nonbei_e'],
    notes: 'Post-war row of ~40 tiny 2-storey wooden bars (each ≈2 × 3 m) in two rows between the JR viaduct wall and 渋谷東映プラザ; red lanterns and noren.',
  },
  centerGaiGate: {
    name: 'センター街', pos: [-30.1, -29.4], rotY: facing(0.73, 0.68), footprint: 'rect', size: [10, 9, 1], storeys: 0,
    sign: '渋谷センター街 Basketball Street',
    notes: 'Red-pink arch sign spanning the 10 m mouth of Center-gai; faces the crossing.',
  },
  hachikoStatue: {
    name: '忠犬ハチ公', pos: [8.0, 46.5], rotY: 0.347, footprint: 'rect', size: [2, 3, 1.2], storeys: 0,
    notes: 'Bronze Akita on a granite plinth (≈1.6 m dog + 1.2 m plinth), facing east toward the Hachiko exit.',
  },
  moyai: {
    name: 'モヤイ像', pos: [-32, 140], rotY: 0, footprint: 'rect', size: [1.6, 2.5, 1.6], storeys: 0,
    notes: 'Grey stone moai-like head (2.5 m) at the west exit in front of Fukuras.',
  },
  udagawaKoban: {
    // (pass 12: at the real corner of 井の頭通り and 宇田川通り — OSM 136730001, [-204, −161] — set 1 m clear of the kerb)
    name: '宇田川交番', pos: [-209, -159], rotY: facing(0.7, 0.7), footprint: 'rect', size: [6, 7, 5], storeys: 2,
    notes: 'Tiny 2-storey police box at the west end of Center-gai / 井の頭通り bend; red lamp, 交番 sign.',
  },
};

// ------------------------------------------------------------------------------------------------------ blocks
// Infill blocks (everything that is not a landmark). polygon in world [x, z]; the city module packs facades along
// every edge. facadeTenants are cycled deterministically along the block faces.
// `seedBase` (pass 15): the block's rng stream starts where it did before the corridor (city.js), so the blocks after
// the re-laid 道玄坂 keep their faces although the lots of s2 / s4 / w1 changed
const BLOCKS = [
  // ---- north-west: 宇田川町 / Center-gai
  { id: 'sanzenri_corner', polygon: [[-73, -23], [-42, -24], [-36, -30], [-65, -59], [-72, -57]], style: 'tenant', minStoreys: 6, maxStoreys: 8,
    facadeTenants: ['三千里薬局', 'マックドナルド', 'ジャンカレ', 'ABC-MARK', 'ポッポ', '一乱', 'ビックエコー', 'タイトーステーシオン'] },
  { id: 'qfront_back', polygon: [[-38, -46], [-31, -60], [-38, -67], [-46, -56]], style: 'tenant', minStoreys: 2, maxStoreys: 3,
    facadeTenants: ['ドトルコーヒー', 'カラオケ舘', 'ガチャガチャ館', 'マリオソクレープ'] },
  { id: 'udagawa_s1', polygon: [[-81, -23], [-81, -63], [-112, -71], [-133, -36], [-127, -26], [-116, -21]], style: 'tenant', minStoreys: 4, maxStoreys: 8,
    facadeTenants: ['マツモトキヨヒ', 'サンドラック', 'ABC-MARK', '天下一本', 'UNIQRO', 'GO', 'ビックエコー', '松家', '吉野屋', '磯丸漁港', '大盛道書店', 'アイフリ'] },
  { id: 'udagawa_n1', polygon: [[-100, -74], [-79, -70], [-73, -80], [-61, -112], [-59, -121], [-100, -123], [-108, -98], [-114, -85]], style: 'entertainment', minStoreys: 3, maxStoreys: 8,
    facadeTenants: ['鳥貴賊', '磯丸漁港', 'ビックエコー', 'サイゼリア', 'ガスド', 'カラオケ舘', 'ラウンドツー', 'GIGA', 'マルハソ 渋谷', '快活CLAB', '牛閣', 'すき屋'] },
  { id: 'udagawa_n2', polygon: [[-62, -70], [-45, -55], [-38, -70], [-57, -86], [-64, -84], [-69, -76]], style: 'tenant', minStoreys: 5, maxStoreys: 7,
    facadeTenants: ['ジャンカレ', 'ポッポ', 'スマイルバーガー', 'だし茶漬け えん', 'JINZ', 'プロミズ'] },
  // (pass 12: to the realigned 井の頭通り, and on west over the triangle to the Basketball Street — GiGO, どうとんぼり神座,
  // セアブラノ神 … stand there)
  { id: 'udagawa_w1', polygon: [[-121, -83], [-110, -96], [-107, -122], [-135.5, -127.1], [-149, -129.2], [-161.7, -132.7], [-170.8, -137.7], [-193.5, -145.7], [-204, -147.5], [-209.5, -143.1], [-197, -124.7], [-176.4, -107.2], [-170, -106], [-160, -99], [-134, -88]], style: 'tenant', minStoreys: 3, maxStoreys: 7,
    facadeTenants: ['ドン・キホーヂ', 'WEGA', 'SPINZ', 'H&N', '博多天真', '土間々', 'ダイソウ', 'ビレッジバンガード', 'ゴン茶', 'エスパズ日拓', 'アドアース'] },
  { id: 'udagawa_s2', polygon: [[-138, -34], [-119, -76], [-125, -82], [-158, -95], [-166, -88], [-176, -56]], style: 'entertainment', minStoreys: 3, maxStoreys: 8,
    facadeTenants: ['カラオケ舘', 'クラブ キャメロト', 'WOMP', '一風道', '笑々', '白木家', 'ホテル・シルキー', 'マンボウ ネットカフェ', 'BAR 弐拾壱'] },
  { id: 'bunkamura_n', polygon: [[-178, -56], [-168, -88], [-183, -105], [-205, -112], [-220, -100], [-220, -70], [-205, -64]], style: 'tenant', minStoreys: 4, maxStoreys: 8,
    facadeTenants: ['PRIZE SPOT', 'カラオケ舘', 'ジャンカレ', '日高家', '温野采', 'アコン', 'ソフトバング', 'ブックオン'] },
  { id: 'zerogate', polygon: [[-160, -155], [-154.3, -151.3], [-145, -148.8], [-132.5, -146.9], [-120, -145], [-118, -174], [-153, -176], [-151, -160]], style: 'entertainment', minStoreys: 3, maxStoreys: 5,
    facadeTenants: ['ゼロゲート', 'シネマライス', 'ベルシュケ', 'H&N', 'スイーツパラダイズ', 'タリース'] },
  { id: 'udagawa_nw', polygon: [[-163.2, -156.3], [-186.5, -164.3], [-188.9, -165.1], [-193.3, -172], [-195.3, -176.9], [-197, -182], [-190, -184], [-160, -184], [-158, -170], [-160, -157]], style: 'tenant', minStoreys: 3, maxStoreys: 7,
    facadeTenants: ['東急ハンド', 'ビレッジバンガード', 'まんだらげ', 'ノジモ', 'ラーメン 渚', 'セブンイレブ', '和氏', '宇田川皮フ科'] },
  // (pass 12) the west side of 井の頭通り's climb past the 宇田川交番 (ファミリーマート, はやし田, GU, すき家 …)
  { id: 'udagawa_w_edge', polygon: [[-211.5, -164], [-212.7, -167.1], [-215.9, -171.5], [-223.2, -188.1], [-225.5, -194], [-232, -194], [-232, -164]], style: 'tenant', minStoreys: 4, maxStoreys: 8,
    facadeTenants: ['ファミリマート', 'らぁ麺 はやし由', 'GO', 'すき屋'] },
  { id: 'parco_w', polygon: [[-214, -186], [-198, -186], [-202, -218], [-214, -218]], style: 'residential', minStoreys: 3, maxStoreys: 6,
    facadeTenants: ['山手マンション', 'コクサイビル', '珈琲舘', 'ファミリマート'] },
  { id: 'udagawa_koen_s', polygon: [[-118, -184], [-74, -184], [-74, -198], [-100, -204], [-118, -206]], style: 'office', minStoreys: 3, maxStoreys: 11,
    facadeTenants: ['ヒューマクス', '渋谷町眼科', 'エイブレ', 'STARBEANS COFFEE', 'ジョナソン'] },
  // (pass 12) the north side of 公園通り's climb between MOD1 and PALCO (Chacot, Appel Store, JOURNAL STANDART …): the
  // game had no lots there, so the real shops had nowhere to stand
  { id: 'koen_n1', polygon: [[-20, -186], [-30, -191], [-42, -196], [-57, -202], [-70, -208], [-84, -214], [-92, -219], [-20, -219]], style: 'tenant', minStoreys: 4, maxStoreys: 8,
    facadeTenants: ['Chacot', 'Appel Store', 'オーマイグラズ東京', 'JOURNAL STANDART FURNITURE', 'Ray-Bam SHIBUYA'] },
  // ---- north: 神南 / 公園通り
  { id: 'jinnan_e1', polygon: [[31, -78], [49, -78], [51, -146], [34, -146]], style: 'tenant', minStoreys: 5, maxStoreys: 9,
    facadeTenants: ['ZALA', 'ビックエコー', 'タリース', 'ポッポ', 'ソフトバング', '三稜UFJ銀行', 'aU ショップ', 'エクセルシオル'] },
  { id: 'jinnan_e2', polygon: [[33, -150], [51, -150], [52, -186], [34, -186]], style: 'office', minStoreys: 8, maxStoreys: 12,
    facadeTenants: ['サンクズ', '東光不動産', '大和證研', 'ドコマショップ', 'デニース'] },
  { id: 'marui_n', polygon: [[-16, -206], [10, -206], [10, -222], [-16, -222]], style: 'tenant', minStoreys: 6, maxStoreys: 9,
    facadeTenants: ['渋谷マルコ アネックス', 'JINZ', 'Zoft', 'ゴン茶'] },
  // ---- east of the tracks: のんべい横丁 neighbours, 宮益坂, 明治通り
  { id: 'toei_plaza', polygon: [[96, -13], [138, -13], [140, -40], [128, -66], [96, -66]], style: 'entertainment', minStoreys: 7, maxStoreys: 11,
    facadeTenants: ['渋谷東栄プラザ', 'TOHOシネマ 渋谷町', 'ドトルコーヒー', 'エクセルシオル', 'プロミズ', '富土そば', 'ビッグアポロ'] },
  { id: 'toei_n', polygon: [[96, -70], [140, -70], [140, -94], [96, -94]], style: 'office', minStoreys: 9, maxStoreys: 13,
    facadeTenants: ['東京海上日勤', 'みずぼ銀行', '渋谷町総合法律事務所', 'アバホテル 渋谷町'] },
  // pass 14: 宮益坂 got its slope; the lots keep their pre-slope widths (narrowOnSlope: false) so the 明治通り corner
  // the client knows (ウエルシヤ at 宮益坂下) is unchanged — the ground floors step with the grade (genericBuilding groundRel)
  { id: 'miyamasu_s1', narrowOnSlope: false, polygon: [[168, -3], [196, -16], [220, -28], [220, 4], [195, 10], [172, 14]], style: 'office', minStoreys: 8, maxStoreys: 15,
    facadeTenants: ['りそね銀行', '宮益坂ビルディング', 'SMBK信託', 'STARBEANS COFFEE'] },
  // pass 14: 宮益坂 got its slope; the lots keep their pre-slope widths (narrowOnSlope: false) so the 明治通り corner
  // the client knows (ウエルシヤ at 宮益坂下) is unchanged — the ground floors step with the grade (genericBuilding groundRel)
  { id: 'miyamasu_n1', narrowOnSlope: false, polygon: [[168, -32], [220, -58], [220, -105], [168, -105]], style: 'tenant', minStoreys: 6, maxStoreys: 10,
    facadeTenants: ['カラオケ舘', 'ビッグカメラ 渋谷東口', '三千里薬局', '吉野屋', '牛閣', 'アイフリ', 'ドコマショップ', 'サブウェー', 'ウエルシヤ'] },
  { id: 'miyamasu_n2', polygon: [[168, -108], [220, -108], [220, -150], [168, -150]], style: 'office', minStoreys: 6, maxStoreys: 9,
    facadeTenants: ['東口二葉ビル', 'Doctor\'s Building', '神南メンタルクリニック', '日本旅遊', 'ポッポ'] },
  { id: 'meiji_e3', polygon: [[168, -153], [220, -153], [220, -222], [168, -222]], style: 'residential', minStoreys: 5, maxStoreys: 18,
    facadeTenants: ['テラス渋谷美竹', 'レイドアウト渋谷', 'KIビル', 'セブンイレブ', 'ドミーイン 渋谷町'] },
  { id: 'meiji_se1', polygon: [[188, 84], [220, 84], [220, 126], [204, 134], [192, 138]], style: 'office', minStoreys: 7, maxStoreys: 10,
    facadeTenants: ['名取ビル', '渋谷東口マイアミビル', 'タキザワビル', '三井住本銀行', 'ケンタッキ'] },
  // ---- south: station south, 桜丘, 道玄坂 south side
  { id: 'station_s', polygon: [[28, 128], [84, 128], [98, 150], [110, 178], [60, 182], [26, 172]], style: 'office', minStoreys: 4, maxStoreys: 8,
    facadeTenants: ['渋谷町駅 南改札', 'JP トラベルサービスセンター', 'ポッポ', 'ドトルコーヒー'] },
  { id: 'dogenzaka_s1', polygon: [[-78, 9], [-104, 9], [-118, 14], [-121, 40], [-118, 66], [-100, 61], [-62, 51], [-60, 44]], style: 'tenant', minStoreys: 3, maxStoreys: 8,
    facadeTenants: ['ビッグカメラ 渋谷ハチ公口店', '磯丸漁港', 'ファミリマート', 'スマイルバーガー', '焼鳥 おやひな屋', '松家', 'アコン', '岩崎ビル'] },
  { id: 'dogenzaka_s2', seedBase: 179, polygon: [[-124, 16], [-150, 26], [-172, 34], [-168, 60], [-150, 84], [-126, 72]], style: 'entertainment', minStoreys: 6, maxStoreys: 14,
    facadeTenants: ['TOHOシネマ 渋谷町', '渋東シネタワー', 'ドトルコーヒー', 'タリース', '大戸家', 'ラウンドツー'] },
  // (pass 15: dogenzaka_s3 — the compressed bend's south frontage — is gone: that stretch is now the corridor's real
  //  frontage, buildings/dogenzaka.js; the lots of s2 / s4 / w1 that stand on a corridor building are dropped in city.js)
  { id: 'dogenzaka_s4', seedBase: 198, polygon: [[-160, 86], [-190, 92], [-216, 100], [-216, 130], [-176, 124], [-150, 104]], style: 'hotel', minStoreys: 3, maxStoreys: 7,
    facadeTenants: ['ホテル・シルキー', 'コスモ渋谷館', '渋谷道玄坂ビル', '長岩医院', '加藤ビル', '東急ステー'] },
  // (pass 12: the 文化村通り face out to its building line — LABI, 洋服の青山, Taco Bell stand on it)
  { id: 'dogenzaka_w1', seedBase: 207, polygon: [[-192, -43], [-198, -47.2], [-210.7, -57.1], [-220, -69], [-220, 38.6], [-219.4, 37.9], [-216, 33.9], [-212.5, 30.2], [-208.8, 26.4], [-203.7, 22.2], [-198.4, 19.1], [-193.8, 17], [-189, 15.1], [-186, 14.4], [-186, -2]], style: 'tenant', minStoreys: 6, maxStoreys: 8,   // pass 14: south edge on the re-laid 道玄坂's bend (pass 15: its style fields had slipped into this comment — every lot came out 1 storey)
    facadeTenants: ['ヤマド電機 LABY', 'THE PRIMA', 'UNIQRO', '若槻ビル', '第六セントラルビル', 'マンボウ ネットカフェ'] },
  { id: 'sakuragaoka_1', seedBase: 222, polygon: [[-42, 116], [-42, 152], [-75, 160], [-92, 156], [-98, 136], [-70, 124]], style: 'office', minStoreys: 7, maxStoreys: 10,
    facadeTenants: ['渋谷駅前会館', '渋谷三菱ビルヂング', '日本旅遊', 'みずぼ銀行', '東急ハンド', 'THE RENGE'] },
  { id: 'sakuragaoka_2', seedBase: 229, polygon: [[-100, 134], [-144, 152], [-158, 160], [-180, 178], [-176, 200], [-108, 190], [-78, 183], [-78, 164], [-96, 158]], style: 'hotel', minStoreys: 3, maxStoreys: 10,
    facadeTenants: ['渋谷SEDE', '照力ビル', '東京 FIVE BLD', 'ホテル・マヨビエンテ', 'セブンイレブ', 'SNT渋谷ビル', '大和ビル'] },
];

// the 道玄坂 ramp's own line (pass 14's straight-axis ramp, kept for the square): 道玄坂下 from x −60 and 道玄坂's head to
// x −192.6, where the square and the true corridor meet. Pass 15 cuts it there (its compressed bend and vista are gone)
// and caps its profile (`maxAlong`): the corridor's own ramp (DG_RAMP below) carries the street on up the hill.
const DOGEN_RAMP = [[-60, -8.1], [-70, -9], [-100, -5], [-112, -3], [-121.2, 2.6], [-130.4, 7.3], [-139.8, 11.5], [-149.3, 15.1], [-159.8, 18.7], [-170.8, 22.3], [-180.2, 25.4], [-184.8, 26.9], [-188.9, 28.5], [-192.6, 30.2]];
// …and the square's own south-west corner keeps the hill pass 14 gave it (西口通り / マークシティ west / 玉川通り's west end
// rising 5–7 m toward the edge, like the real 道玄坂一丁目 / 桜丘 slope): that ramp's line through the compressed bend
// and its vista, frozen, masked to the square south of the corridor (x > −250, z > 40) so it never reaches the corridor.
const DOGEN_RAMP_SW = [[-60, -8.1], [-70, -9], [-100, -5], [-112, -3], [-121.2, 2.6], [-130.4, 7.3], [-139.8, 11.5], [-149.3, 15.1], [-159.8, 18.7], [-170.8, 22.3], [-180.2, 25.4], [-184.8, 26.9], [-188.9, 28.5], [-192.6, 30.2], [-196.6, 32.5], [-200.4, 35.6], [-203.5, 38.8], [-206.7, 42.2], [-209.8, 45.9], [-212.9, 49.7], [-215.7, 53.6], [-218.2, 57.7], [-220.4, 61.9], [-222.5, 66.1], [-224.3, 70.5], [-226, 74.7], [-227.9, 79.7], [-280.9, 220.1]];

// The corridor's ground (pass 15): the GSI DEM along the OSM centre-line (dogenzakaData.js PROFILE, 12 m steps), less
// the datum (道玄坂下 15.4 m = the game's 0): +0.7 m at the 109 fork, +3.6 at x −202, +8.1 at the 百軒店 crossing, +16.5
// at 道玄坂上交番前, +19.9 on the 道玄坂上 plateau (4.5–4.8 % on the long middle stretch). Across the street it is level
// for the frontage (`hw`: 13 m on the 109 side below s 110 as before, 40 m further up) and then falls away over `fade`.
// Baked once on first use into a 2 m grid (bilinear): the per-frame height queries of walkers and cars stay cheap.
const DG_RAMP = (() => {
  const x0 = -588, z0 = -64, x1 = -124, z1 = 508, st = 4, nx = Math.round((x1 - x0) / st) + 1, nz = Math.round((z1 - z0) / st) + 1;
  const segs = (pts) => { const a = []; for (let i = 0; i < pts.length - 1; i++) a.push(pts[i][0], pts[i][1], pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return Float64Array.from(a); };
  const C = segs(DG.CENTRE), CUM = [0];
  for (let i = 0; i < C.length; i += 4) CUM.push(CUM[CUM.length - 1] + Math.hypot(C[i + 2], C[i + 3]));
  const Lz = segs([...DG.DOGEN_PATH.filter((p) => p[0] <= -110)]), Lu = segs(DG.DOGEN_UE_PATH), Lt = segs(DG.TAMAGAWA_UE_PATH);
  const dist2 = (S, x, z) => { let m = Infinity; for (let i = 0; i < S.length; i += 4) { const vx = S[i + 2], vz = S[i + 3], l2 = vx * vx + vz * vz || 1e-9; let t = ((x - S[i]) * vx + (z - S[i + 1]) * vz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t; const dx = x - S[i] - vx * t, dz = z - S[i + 1] - vz * t, d = dx * dx + dz * dz; if (d < m) m = d; } return m; };
  let grid = null;
  const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  function value(x, z) {
    // along: the nearest point of the OSM centre-line (its bends are gentle, ≤ 8°, so the arc length never jumps)
    let m = Infinity, s = 0, side = 1;
    for (let i = 0, k = 0; i < C.length; i += 4, k++) {
      const vx = C[i + 2], vz = C[i + 3], l2 = vx * vx + vz * vz; let t = ((x - C[i]) * vx + (z - C[i + 1]) * vz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - C[i] - vx * t, dz = z - C[i + 1] - vz * t, d = dx * dx + dz * dz;
      if (d < m) { m = d; s = CUM[k] + t * Math.sqrt(l2); side = vx * (z - C[i + 1]) - vz * (x - C[i]) > 0 ? 1 : -1; }
    }
    const h = DG.elevationAt(s) - DG.DATUM;
    const d = Math.sqrt(Math.min(dist2(Lz, x, z), dist2(Lu, x, z), dist2(Lt, x, z)));
    const north = side > 0, k = smooth((s - 110) / 40);
    const hw = north ? 13 + 27 * k : 34 + 6 * k, fade = north ? 26 + 4 * k : 40 + 1.2 * Math.max(0, h);
    // east of the 109 apex the square's own ramp alone (the corridor fades in over x −126 → −138)
    const e = smooth((-126 - x) / 12);
    if (d <= hw) return h * e;
    const t = 1 - (d - hw) / fade;
    return t <= 0 ? 0 : h * smooth(t) * e;
  }
  function bake() {
    grid = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) grid[j * nx + i] = value(x0 + i * st, z0 + j * st);
  }
  return {
    bb: [x0, x1, z0, z1],
    y(x, z) {
      if (x <= x0 || x >= x1 || z <= z0 || z >= z1) return 0;
      if (!grid) bake();
      const gx = (x - x0) / st, gz = (z - z0) / st, i = Math.min(nx - 2, gx | 0), j = Math.min(nz - 2, gz | 0), tx = gx - i, tz = gz - j, k = j * nx + i;
      return (grid[k] * (1 - tx) + grid[k + 1] * tx) * (1 - tz) + (grid[k + nx] * (1 - tx) + grid[k + nx + 1] * tx) * tz;
    },
    value,
  };
})();

// ------------------------------------------------------------------------------------------------------- CITY
export const CITY = {
  bounds: 440,
  // real: crossing ≈15 m, 109 base 16.2 m, 道玄坂上 ≈32 m (≈3.5–5 %, the lower part is the steepest); 文化村通り climbs
  // more gently toward Bunkamura. Heights are never compressed, the far (compressed) end of 道玄坂 reaches ≈5.5 m.
  // 道玄坂 (pass 7): a 1.5 % lead-in from x ≈ −70 on 道玄坂(下), 6.5 % for the first 120 m above the 109 apex (the
  // steep lower street), then 4.5 % to 道玄坂上 (≈ +15 m at the top of the vista, ≈ +21 m on the far plateau).
  // `grades` = [[along, grade], ...] (grade changes ease over `ease` m); the axis runs down the carriageway, the north
  // (109 / 文化村通り) side fades out quickly so 文化村通り keeps its own gentle climb.
  ground: { slope: [
    // 道玄坂 (pass 14): the ramp's sideways reach FOLLOWS the re-laid, bending street (`path`: from 道玄坂下 up the road
    // and on up its vista) while its height runs along the old straight axis (smooth, no jump inside the bend); the
    // south fade widens with the height it loses (`maxCross`, ≤ 5 % sideways: the ground south-west of the bend is a hill — real 西口通り climbs 5.2 m to its west end, 玉川通り climbs to 道玄坂上 too). Grades are the real ones, checked against the GSI 1 m laser DEM along the OSM centre-line:
    // 道玄坂下 15.4 m → 109 fork 16.0 → x −130 16.6 → x −160 17.4 → x −195 18.7 → the bend 20.0–23.7 → 道玄坂上 31.9 m,
    // i.e. 1.8–1.9 % past the 109, 2.5 %, 3.5 %, then 4.6–5.2 % from the bend up (the pass-7 profile had 6.5 % on the
    // lower street, 2–3× the real grade): the lower street now matches the DEM within 0.1 m; 6 % on the axis in the
    // bend is ≈ 4.8 % along the bending road (kept per game metre like 宮益坂 — the bend lies in the compressed west).
    // North (`halfWidthN`, the 109 side) narrow, south wide, as before.
    // (pass 15: cut at x −192.6 and capped at its along 124 m (+2.9 m), where the corridor ramp (`baked`) takes over:
    // groundY is the max of the ramps, and the two agree within 0.2 m on the shared stretch x −130 … −192)
    { along: 'dogenzaka', apex: [-70, -19], dir: [-112, 43], path: DOGEN_RAMP, grades: [[-5, 0.0185], [60, 0.025], [92, 0.035], [128, 0.06], [300, 0]], ease: 12, halfWidth: 34, fade: 50, maxCross: 0.05, halfWidthN: 13, fadeN: 26, maxAlong: 124 },
    { along: 'dogenzaka_corridor', baked: DG_RAMP },
    { along: 'dogenzaka_sw', apex: [-70, -19], dir: [-112, 43], path: DOGEN_RAMP_SW, grades: [[-5, 0.0185], [60, 0.025], [92, 0.035], [128, 0.06], [300, 0]], ease: 12, halfWidth: 34, fade: 50, maxCross: 0.05, halfWidthN: 13, fadeN: 26, mask: { x0: -250, x1: -228, z0: 40, z1: 85 } },
    { along: 'bunkamura', rise: 0.028, apex: [-116, -15], dir: [-114, -82], halfWidth: 14, fade: 24, maxRun: 190, ease: 30 },
    // 宮益坂 (pass 14, client: 「宮益坂が平らになっているから坂を作って」). Real profile from the GSI 1 m laser DEM along the
    // OSM centre-line (ways 213526434 / 375809353): 宮益坂下 17.9 m → 19.2 m at +30 m (4.3 %) → 25.1 m at +140 m →
    // 32.0 m at 青山通り (+285 m): 5.0 % on average, 5.6–6.1 % on the steep middle and upper parts. The street lies in
    // the plan's compressed east (0.40× beyond x = 150), so the GRADE is kept per game metre (the real rises would make
    // it 12 %): 4.5 % off the 明治通り kerb, 6 % from +36 m (the real steepest), ≈ +3.4 m at the map edge. 明治通り stays
    // level: the climb starts 16 m east of the junction centre (its east pavement). dir runs up the (straight) game
    // path; here `halfWidth` is the north side (lat < 0), `halfWidthN` the south.
    { along: 'miyamasu', apex: [155, -7], dir: [71, -35], grades: [[16, 0.045], [36, 0.06], [400, 0]], ease: 15, halfWidth: 24, fade: 30, halfWidthN: 24, fadeN: 30 },
  ] },
  crossing: {
    center: [-4, -2], radius: 28,
    corners: { sanzenri: [-34, -19], qfront: [-12, -28], magnet: [19, -17], hachiko: [13, 15], ekimaeBldg: [-34, 10] },
    crosswalks: CROSSWALKS,
    diagonals: DIAGONALS,
    stopLines: STOP_LINES,
    signals: SIGNALS,
  },
  roads: [...ROADS, ...SCOPE_ROADS.filter(r=>r.osm!==153108795).map(kojiRoad)].map(northRoad).filter(Boolean).map(r=>r.id==='dg_markcity_p'?{...r,path:MARKCITY_VEHICLE_PATH,width:7,lanes:2,oneway:false}:r),
  busways: BUSWAYS,
  busStops: BUS_STOPS,
  busTerminals: BUS_TERMINALS,
  // queue spots per のりば for the crowd: [{ id, ref, terminal, op, pole: [x, z], face: rotY (the queue faces the
  // bus's travel direction), spots: [[x, z], ...] (head of the line first) }]
  busQueues: BUS_STOPS.filter(s => s.queue).map(s => ({ id: s.id, ref: s.ref, terminal: s.terminal || null, op: s.op, pole: s.pole, face: s.heading, spots: s.queue })),
  aprons: APRONS,
  raised: RAISED,
  sites: SITES,
  crosswalksExtra: [...CROSSWALKS_EXTRA,...PARCO_CROSSINGS],
  pedestrianStreets: [...PEDESTRIAN_STREETS,{id:'markcity_avenue',name:'マークシティ 4階入口',path:MARKCITY_WALK_PATH,width:3,surface:'paving',poles:false,trees:false}],
  plazas: PLAZAS,
  rail: RAIL,
  groundHoles: GROUND_HOLES,
  stationSouth: STATION_SOUTH,
  landmarks: LANDMARKS,
  blocks: BLOCKS.map(b=>NORTH_BLOCKS[b.id]||ROAD_FRONTAGES[b.id]?{...b,polygon:NORTH_BLOCKS[b.id]||ROAD_FRONTAGES[b.id]}:b),
  spawns: {
    player: { pos: [22, 20], rotY: facing(-26, -22) },                       // Hachiko square, looking at the crossing
    fight_intro: [[-8, -4], [-14, 2], [-2, -10], [-20, -8], [4, 4]],          // on the scramble itself
    // taxi ranks that exist today: 東口 (明治通り west kerb, the taxi island between the east bus terminal's exit and
    // entry, cabs facing north toward the Hikarie deck; the head stands ~20 m short of the exit T so it can pull out).
    // None at ハチ公口 / 西口 (closed 2025-03). Head of the rank first.
    taxiStand: [[152.9, 49], [153.8, 55], [154.8, 61]],
  },
  minimap: { size: 512, scale: 1.1 },
  tenantPools: T,
  // pass 15: the playable 道玄坂 corridor beyond the square's west edge (true metres). `outline` = its bounds polygon
  // (the city's walls follow it outside the square), `roads` = the ids laid in it, `koban` = 道玄坂上交番.
  corridor: { id: 'dogenzaka', name: '道玄坂', outline: DG.CORRIDOR, roads: ['dogenzaka', 'dogenzaka_ue', 'tamagawa_ue'], koban: DG.KOBAN, halfWidth: DG.CORR_HW },
  // named areas the HUD checks before the streets (道玄坂上 round the koban and the junction)
  areas: [...DG.AREAS,
    { name:'神泉',polygon:[[-760,210],[-615,210],[-595,410],[-700,400]] },
    { name:'円山町',polygon:[[-700,40],[-440,40],[-440,310],[-615,310],[-615,210],[-740,210]] },
    { name:'百軒店',polygon:[[-420,-25],[-255,-25],[-255,90],[-400,180],[-460,120]] },
  ],
  // the pause map's frame [x0, z0, x1, z1]: the square and the corridor up to 道玄坂上
  worldMapBox: [-780, -320, 240, 455],
  scope: { outline: SCOPE_OUTLINE, source: 'user red outline, 2026-09-27' },
};
/** True if (x, z) is inside the 道玄坂 corridor's outline (true-metre corridor west of the square). */
export function inCorridor(x, z) { return pointInPolygon(x, z, CITY.corridor.outline); }

// ----------------------------------------------------------------------------------------------------- helpers
const v3 = (x, z) => new THREE.Vector3(x, groundY(x, z), z);

/** [{id, name, points:[Vector3...], width, lanes, sidewalk, oneway}] */
export function roadPolylines() {
  return CITY.roads.map(r => ({ id: r.id, name: r.name, points: r.path.map(([x, z]) => v3(x, z)), width: r.width, lanes: r.lanes, sidewalk: r.sidewalk, oneway: !!r.oneway }));
}

/** [{a: Vector3, b: Vector3, width, side:'left'|'right', roadId}] — one slab per road segment per side,
 *  offset by width/2 + sidewalk/2. 'right' = right-hand side when travelling a→b (map north up). */
export function sidewalks() {
  const out = [];
  for (const r of CITY.roads) {
    if (!r.sidewalk) continue;
    const off = r.width / 2 + r.sidewalk / 2;
    for (let i = 0; i < r.path.length - 1; i++) {
      const [ax, az] = r.path[i], [bx, bz] = r.path[i + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      const rx = -dz, rz = dx;                                                    // right-hand normal (east→south)
      out.push({ a: v3(ax + rx * off, az + rz * off), b: v3(bx + rx * off, bz + rz * off), width: r.sidewalk, side: 'right', roadId: r.id });
      out.push({ a: v3(ax - rx * off, az - rz * off), b: v3(bx - rx * off, bz - rz * off), width: r.sidewalk, side: 'left', roadId: r.id });
    }
  }
  return out;
}

/** Pedestrian crossing paths for the crowd module: the five perimeter crossings, the two diagonals and the
 *  mid-block zebras. [{id, a: Vector3, b: Vector3, width, kind:'perimeter'|'diagonal'|'midblock'}] */
export function crosswalkPaths() {
  const mk = (c, kind) => ({ id: c.id, a: v3(c.a[0], c.a[1]), b: v3(c.b[0], c.b[1]), width: c.width, kind });
  return [...CROSSWALKS.map(c => mk(c, 'perimeter')), ...DIAGONALS.map(c => mk(c, 'diagonal')), ...CROSSWALKS_EXTRA.map(c => mk(c, 'midblock'))];
}

/** Pedestrian streets / alleys as Vector3 polylines. [{id, name, points, width}] */
export function pedestrianPaths() {
  return PEDESTRIAN_STREETS.map(p => ({ id: p.id, name: p.name, points: p.path.map(([x, z]) => v3(x, z)), width: p.width }));
}

/** Elevated rail centre-lines. [{id, name, points:[Vector3 at track elevation], width, elevation}] */
export function railPaths() {
  return Object.entries(RAIL).map(([id, r]) => ({ id, name: r.name, points: r.path.map(([x, z]) => new THREE.Vector3(x, r.elevation, z)), width: r.width, elevation: r.elevation }));
}

/** [{key, ...landmark}] */
export function landmarkList() {
  return Object.entries(LANDMARKS).map(([key, l]) => ({ key, ...l }));
}

function distToSegment(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

/** True if (x, z) lies on a vehicle carriageway (kerb to kerb) or inside the paved crossing. */
export function isRoad(x, z) {
  const c = CITY.crossing;
  if (Math.hypot(x - c.center[0], z - c.center[1]) <= c.radius) return true;
  for (const r of CITY.roads) {
    const half = r.width / 2;
    for (let i = 0; i < r.path.length - 1; i++) {
      const [ax, az] = r.path[i], [bx, bz] = r.path[i + 1];
      if (distToSegment(x, z, ax, az, bx, bz) <= half) return true;
    }
  }
  return false;
}

/** Point-in-polygon (ray casting) on [x, z] polygons. */
export function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Ground height (road surface, sidewalks sit SW_H above it). 道玄坂 climbs ≈5 % south-west from the 109 apex,
 *  文化村通り ≈3 % west-north-west and 宮益坂 ≈6 % east from 明治通り; everything else (crossing, Center-gai, the
 *  station side) is flat at 0.
 *  Each ramp eases in / out over `ease` metres (vertical curves, no kinks) and fades out sideways with a
 *  smoothstep, so the street geometry (buildings/streets.js), buildings, physics, props, traffic and crowd can all
 *  sample it anywhere. The whole world follows this one function. */
export const SLOPED = true;
const RAMPS = CITY.ground.slope.map((s) => {
  if (s.baked) return s;                                                      // the corridor's own baked grid
  const dl = s.dir ? Math.hypot(s.dir[0], s.dir[1]) : 1;
  const r = { ...s, ux: s.dir ? s.dir[0] / dl : 0, uz: s.dir ? s.dir[1] / dl : 0, ease: s.ease || 1, halfWidthN: s.halfWidthN ?? s.halfWidth, fadeN: s.fadeN ?? s.fade };
  if (s.path) {
    let cum = 0;
    r.seg = [];
    for (let i = 0; i < s.path.length - 1; i++) {
      const [ax, az] = s.path[i], [bx, bz] = s.path[i + 1], dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
      r.seg.push({ ax, az, dx, dz, len, l2: len * len || 1, cum }); cum += len;
    }
    r.total = cum;
    r._d = new Float64Array(r.seg.length); r._a = new Float64Array(r.seg.length);
  }
  if (s.grades) {
    // grade profile: g(a) = Σ Δg_k · clamp((a − a_k) / ease, 0, 1), integrated in closed form (C¹ height, no kinks)
    let prev = 0;
    r.steps = s.grades.map(([a, g]) => { const d = g - prev; prev = g; return [a, d]; });
    r.top = profileY(r, s.maxAlong != null ? Math.min(s.maxAlong, r.total || 1e6) : (r.total || 1e6));
  } else r.top = s.rise * (s.maxRun - r.ease);
  if (s.path) {                                                               // reject box: the widest fade it can make
    const m = Math.max(r.halfWidth + (r.maxCross ? Math.max(r.fade, 1.5 * r.top / r.maxCross) : r.fade), r.halfWidthN + r.fadeN);
    r.bb = [Math.min(...s.path.map((q) => q[0])) - m, Math.max(...s.path.map((q) => q[0])) + m, Math.min(...s.path.map((q) => q[1])) - m, Math.max(...s.path.map((q) => q[1])) + m];
  }
  if (r.mask) r.inner = { ...r, mask: null };
  return r;
});
function profileY(s, along) {
  const e = s.ease;
  let h = 0;
  for (let k = 0; k < s.steps.length; k++) {
    const q = along - s.steps[k][0];
    if (q <= 0) break;
    h += s.steps[k][1] * (q < e ? q * q / (2 * e) : q - e / 2);
  }
  return h;
}
// a ramp that follows a polyline: `along` = arc length of the projection, blended over the nearest segments with a
// softmin (continuous also on the inside of a bend, where the nearest segment switches), `lat` = the distance to
// the line, signed + on the right of travel (north for a west-running street: `halfWidthN` / `fadeN`)
// (`along` only when asked: the ground-height query needs `lat` alone, and it runs for every walker and car on the
// slope every frame — the softmin's exp per segment was most of its cost)
const _pf = { along: 0, lat: 0 };
function pathFrame(s, x, z, wantAlong = false) {
  if (x < s.bb[0] || x > s.bb[1] || z < s.bb[2] || z > s.bb[3]) return null;
  let dmin = Infinity, side = 1;
  const D = s._d, A = s._a;
  for (let i = 0; i < s.seg.length; i++) {
    const g = s.seg[i], t = Math.max(0, Math.min(1, ((x - g.ax) * g.dx + (z - g.az) * g.dz) / g.l2));
    const qx = g.ax + g.dx * t - x, qz = g.az + g.dz * t - z, d = Math.hypot(qx, qz);
    D[i] = d; A[i] = g.cum + t * g.len;
    if (d < dmin) { dmin = d; side = g.dx * (z - g.az) - g.dz * (x - g.ax) > 0 ? 1 : -1; }
  }
  _pf.lat = dmin * side; _pf.along = NaN;
  if (wantAlong) {
    let w = 0, a = 0;
    for (let i = 0; i < s.seg.length; i++) { const k = Math.exp(-(D[i] - dmin) / 4); w += k; a += k * A[i]; }
    _pf.along = a / w;
  }
  return _pf;
}
function rampY(s, x, z) {
  if (s.baked) return s.baked.y(x, z);
  if (s.mask) {
    const M = s.mask, u = (x - M.x0) / (M.x1 - M.x0), v = (z - M.z0) / (M.z1 - M.z0);
    if (u <= 0 || v <= 0) return 0;
    const m = (u >= 1 ? 1 : u * u * (3 - 2 * u)) * (v >= 1 ? 1 : v * v * (3 - 2 * v));
    return m * rampY(s.inner, x, z);
  }
  if (s.path) {
    const f = pathFrame(s, x, z); if (!f) return 0;
    // along: the straight axis (a smooth tilted plane — the path's own arc length jumps across the inside of a bend);
    // sideways: the distance to the real, bending street
    const al = (x - s.apex[0]) * s.ux + (z - s.apex[1]) * s.uz;
    const h = profileY(s, s.maxAlong != null && al > s.maxAlong ? s.maxAlong : al), lateral = Math.abs(f.lat), hw = f.lat > 0 ? s.halfWidthN : s.halfWidth;
    // the fade widens with the height it has to lose (`maxCross`: the steepest sideways grade it may make), so a high
    // upper street does not drop off a cliff into the streets beside it (西口通り beside the bend / vista of 道玄坂)
    const fd = f.lat > 0 ? s.fadeN : (s.maxCross ? Math.max(s.fade, 1.5 * h / s.maxCross) : s.fade);
    let w = 1;
    if (lateral > hw) { const t = 1 - (lateral - hw) / fd; if (t <= 0) return 0; w = t * t * (3 - 2 * t); }
    return h * w;
  }
  const px = x - s.apex[0], pz = z - s.apex[1];
  const along = px * s.ux + pz * s.uz;
  if (along <= 0) return 0;
  const lat = px * -s.uz + pz * s.ux, lateral = Math.abs(lat);
  const hw = lat > 0 ? s.halfWidthN : s.halfWidth, fd = lat > 0 ? s.fadeN : s.fade;
  let w = 1;
  if (lateral > hw) { const t = 1 - (lateral - hw) / fd; if (t <= 0) return 0; w = t * t * (3 - 2 * t); }
  if (s.steps) return profileY(s, along) * w;
  const e = s.ease, m = s.maxRun;
  let h;
  if (along >= m) h = s.top;
  else if (along > m - e) h = s.top - s.rise * (m - along) * (m - along) / (2 * e);
  else if (along < e) h = s.rise * along * along / (2 * e);
  else h = s.rise * (along - e / 2);
  return h * w;
}
export function legacyGroundY(x, z) {
  if (!SLOPED) return 0;
  let y = 0;
  for (let i = 0; i < RAMPS.length; i++) { const h = rampY(RAMPS[i], x, z); if (h > y) y = h; }
  return y;
}
export function groundY(x,z) { return shotoGround(x,z,scopeGround(x,z,legacyGroundY(x,z))); }

/** Convert world (x, z) to minimap pixels (north up, origin at the image centre). */
export function worldToMinimap(x, z) {
  const { size, scale } = CITY.minimap;
  return [size / 2 + x * scale, size / 2 + z * scale];
}

export default CITY;
