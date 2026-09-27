// [city] MIYASHITA PARK layout data (pass 11). Game metres (+x east, +z south). Sources: OSM (relation 19370681
// MIYASHITA PARK, way 116806278 宮下公園 roof, 1243122188 sequence MIYASHITA PARK 75.1 m, pitches 1074513132 skate /
// 1074513111 bouldering / 1074513133 sand, 1074513113 MIYASHITA PARK CENTER, 1074513124 roof pavilion, footbridges
// 155786806 / 158849643 over 明治通り, the 美竹通り passage 855259082 + its stairs 1074513125–31, the 明治通り office
// row 120105790–814 / 138670880 / 155749490–91), miyashita-park.tokyo floor guide, ja.wikipedia (S block 渋谷横丁 on
// 1F along the tracks, 100 m / 19 stalls; the blocks divided by 美竹通り with the central stair; lawn on the North
// block; hotel 4F–18F at the north end).
// Plan: the real park runs 330 m; in the compressed map (north of z −150 ×0.45) it would reach z −284, past the
// ±220 playable edge. The map keeps the whole park inside the edge (as the pre-pass-11 44 × 96 rect did), so the
// OSM positions along z are mapped piecewise: South block z_real −100.5…−202 → −107…−158, the 美竹通り passage
// −202…−213 → −158…−170, North block −213…−284 → −170…−220. x stays real, except the JR-side faces, which keep the
// real 3–8 m gap to the (straight, in-game) viaduct face at x 76.

export const H = 17.5;                  // park level (the deck top, ≈4F)
export const LV = [0, 5.6, 11.0];       // 1F / 2F / 3F floor levels (2F = the footbridge level)
export const HD = H - 1.3;              // deck soffit
export const GAL = 3.0;                 // open gallery depth on the 明治通り / passage faces

export const Z = { s0: -107, p0: -158, p1: -170, n1: -220 };
// South block: JR face x 83 (渋谷横丁 arcade under it, stalls on x 87.5), south tip on 宮下通り, the east face runs
// diagonally behind the 明治通り office row and reaches 明治通り only north of it (the footbridge corner)
export const S_UP = [[83, -107], [104, -107], [123, -144], [125.5, -144], [125.5, -155], [83, -155]];   // 2F–3F walls
export const S_1F = [[87.5, -107], [91, -107], [91, -121], [101, -121], [101, -107], [104, -107], [123, -144], [125.5, -144], [125.5, -155], [87.5, -155]];
export const S_DECK = [[83, -107], [104, -107], [123, -144], [128.5, -144], [128.5, -158], [83, -158]];
export const YOKO = { x: 87.5, xOut: 83, z0: -107, z1: -158 };            // stall line, overhang line
export const ATRIUM = { x0: 91, x1: 101, z0: -107, z1: -121 };            // south entrance (escalators to 2F)
// North block (1F / walls; deck = the outer rect)
export const N_1F = [[84, -173], [130.5, -173], [130.5, -220], [84, -220]];
export const N_DECK = [[84, -170], [133.5, -170], [133.5, -220], [84, -220]];
// park-level bridges over the passage (the stair void between them is open to the sky)
export const BR_W = [[83, -158], [95, -158], [95, -170], [84, -170]];
export const BR_E = [[113, -158], [128.5, -158], [128.5, -170], [113, -170]];
export const HOTEL = { x0: 108, x1: 131, z0: -197, z1: -219.5, top: 75.1 };   // OSM 22 × 37 m, 18F, 75.1 m
// 明治通り office row between the South block and the pavement (OSM heights), back walls on the park's diagonal
export const DIAG = { a: [104, -107], b: [123, -144] };
export const OFFICES = [
  { z0: -107.5, z1: -112.6, h: 34.6, st: 10, mat: 'tileTan', t: ['三稜UFJ銀行', 'ファミリマート'] },   // 渋谷東京海上日動ビル
  { z0: -112.6, z1: -119.1, h: 31.0, st: 9, mat: 'concreteWin', t: ['ドトルコーヒー'] },
  { z0: -119.1, z1: -124.4, h: 36.2, st: 10, mat: 'glassDark', t: ['マツモトキヨヒ'] },
  { z0: -124.4, z1: -130.8, h: 38.1, st: 9, mat: 'panelGrey', t: ['一乱'] },
  { z0: -130.8, z1: -138.3, h: 45.2, st: 10, mat: 'darkGrid', t: ['セブンイレブ', '渋谷町クリニック'] },
  { z0: -138.3, z1: -144.0, h: 24.0, st: 7, mat: 'brownFins', t: ['タリース'] },
];
export const X_MEIJI = 133.9;           // 明治通り west building line (sidewalk inner edge ≈134.3–134.9 here)
// footbridges over 明治通り at the 2F level (OSM 155786806 at the South block corner, 158849643 at the hotel)
export const BRIDGES = [
  { z: -148, x0: 128.5, x1: 166.2, stairs: [{ x: 165.0, dir: 1 }], plate: 'MIYASHITA PARK' },
  { z: -211, x0: 133.5, x1: 167.6, stairs: [{ x: 166.5, dir: -1 }, { x: 137.1, dir: -1 }], plate: '宮下公園' },
];
// roof programme (South: skate park, bouldering wall, sand court, park centre; North: STARBEANS, lawn, hotel)
export const ROOF = {
  escalatorHouse: { x0: 90, x1: 100, z0: -108.5, z1: -114.5 },
  skate: { x0: 90.5, x1: 108, z0: -117.5, z1: -133 },
  boulder: { x0: 99, x1: 111, z: -135.2 },
  sand: { x0: 92, x1: 114, z0: -140, z1: -150.5 },
  center: { x0: 92, x1: 103, z0: -151.5, z1: -157.4 },
  starbeans: { x0: 112, x1: 123, z0: -172.5, z1: -179 },
  lawn: { x0: 88, x1: 129.5, z0: -180.5, z1: -196 },
};
export const YOKOCHO_STALLS = ['北海道食市', '東北食市', '関東食市', '北陸食市', '中部食市', '近畿食市', '中国四国食市', '九州食市', '沖縄食市', '韓国食市', '力士めし', '純喫茶&スナック'];
