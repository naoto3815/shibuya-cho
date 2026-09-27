// [mobility] LOOP（ループ）— the e-kickboard share's ports inside the playable ±220 m (docs/NAMES.md: LUUP → LOOP).
//
// SOURCE: the operator publishes no open data (no GBFS; OSM holds 2 ports, both outside the area). Every port below was
// READ BY EYE from the operator's public port map (luup.sc/port-map, Tokyo) on 2026-09-26 — six overlapping views at
// Mapbox zoom 17.5 around the scramble, each pin clicked for its public name — and nothing else was fetched. A pin's
// map position was converted to local metres (origin = the scramble node 35.65948N 139.70054E, 90 544 m / ° lon,
// 110 953 m / ° lat, the reading's own calibration: zoom 17.5 vs 18.5 gives the pin-anchor offset), pushed through the
// block plan's compression (cityData.js header: 1:1 inside x −195..150 / z −150..150, 0.35–0.45× beyond) and then
// placed on the nearest pavement of the BUILT city (physics colliders: buildings, shopfronts, street furniture) that
// holds the bay, its sign and a roll-out strip clear, stays off the carriageway and is reachable from a street
// (`moved` = metres from the projected pin, game units). `lat` / `lng` are the pin as read (±1.5 m).
//
//   real      the public port name exactly as the map shows it (data only; never drawn)
//   name      the in-game name (NAMES.md near-name rule: public places as-is, brands altered)
//   x, z      bay centre (game metres);  rotY  three.js rotation.y of the bay: local +x runs along the row of slots,
//             local +z points out of the bay to the street (the boards stand nose-out);  slots  bay size (game value)
//   docked    boards docked at the start (game value — the map shows no availability)
//
// Readings that fall OUTSIDE the playable square (not built): ヴィラジュリア道玄坂, WAVE道玄坂ビル, 渋谷BEAM (all ≈5 m past the
// west edge after compression), ダイソー渋谷センター街店, 宇田川カフェ suite, 藤和エクシール道玄坂 (west), 渋谷ビジネス会館 and one
// unnamed pin (east), 渋谷グランベルホテル (south).

export const LOOP_BRAND = {
  name: 'LOOP', kana: 'ループ',
  teal: '#22b8a4',         // the mint-teal of the real livery, a hair greener
  tealDeep: '#0f7f71',
  ink: '#0b1413',
};

export const LOOP_FARE = { base: 50, perMin: 15, towFee: 1000 };   // ¥50 + ¥15 per started minute; 回送手数料 (game rule)
// km/h. Game speeds, not the real limits (特定小型原付: 20 on the carriageway, 6 in 歩道モード): at those the board was slower
// than 健人 walking (2.4 m/s) on a pavement and no faster than his run (5.6 m/s) on the road — the client: 「遅すぎる」.
// Then 「車道と歩道でスピードに差つけなくて良い。時速50キロにして」: one cap everywhere, 50 km/h (~2.5× his run).
// (Both keys stay so a split can come back by changing one number.)
export const LOOP_SPEED = { road: 50, pavement: 50 };
export const LOOP_SOURCE = 'luup.sc public map, read 2026-09-26';

const S = LOOP_SOURCE;
export const LOOP_PORTS = [
  { id: 'udagawacho_bldg', real: '宇田川町ビルディング', name: '宇田川町ビルディング', lat: 35.662182, lng: 139.698243,
    x: -209.24, z: -204.71, rotY: -1.713, slots: 3, docked: 2, moved: 16.0, source: S,
    note: 'west of PALCO in the compressed north-west corner. The pin\'s own spot (PALCO\'s west face) is walled in by the generated blocks in the game, so the bay stands on the nearest pavement reachable from a street, 16 game m north-west' },
  { id: 'tipx2', real: 'TIP.X TOKYO渋谷 第2ポート', name: 'TIP.Y TOKYO渋谷 第2', lat: 35.661378, lng: 139.699272,
    x: -114.05, z: -177.3, rotY: -1.761, slots: 5, docked: 3, moved: 0.8, source: S,
    note: 'three ports in a row on the lane along LOFTY\'s west end (宇田川町); this is the northern one' },
  { id: 'tipx', real: 'TIP.X TOKYO渋谷', name: 'TIP.Y TOKYO渋谷', lat: 35.661146, lng: 139.699285,
    x: -115.91, z: -167.19, rotY: -1.761, slots: 5, docked: 4, moved: 2.8, source: S,
    note: 'same lane, middle pin; slid 2.8 m out of LOFTY\'s footprint onto the lane' },
  { id: 'udagawa_cafe', real: '宇田川カフェ', name: '宇田川カフエ', lat: 35.660914, lng: 139.699272,
    x: -114.57, z: -154.81, rotY: 0, slots: 5, docked: 2, moved: 0.8, source: S,
    note: 'southern pin of the three, at LOFTY\'s south-west corner toward 井の頭通り' },
  { id: 'miyashita', real: 'MIYASHITA PARK', name: 'MIYASHITA PARK', lat: 35.662182, lng: 139.701748,
    x: 134.6, z: -213.49, rotY: 1.571, slots: 5, docked: 4, moved: 25.5, source: S,
    note: 'the pin sits inside the park building\'s north block (its ground-floor bike parking), which the game does not open; the bay stands on the 明治通り pavement at that block\'s east face' },
  { id: 'magnet', real: 'MAGNET by SHIBUYA109(マグネットバイシブヤ109)', name: 'MAGNET by SHIBUYA 1O9', lat: 35.660014, lng: 139.701071,
    x: 46.82, z: -62.45, rotY: 1.488, slots: 5, docked: 3, moved: 3.5, source: S,
    note: 'on MAGNET\'s back (east) face beside the vending machines, north of the scramble — the port closest to the crossing' },
  { id: 'laidout', real: 'LAIDOUT SHIBUYA', name: 'LAYDOUT SHIBUYA', lat: 35.661, lng: 139.702931,
    x: 177.38, z: -151.95, rotY: 0, slots: 5, docked: 2, moved: 6.5, source: S,
    note: 'east of 明治通り on the side street north of the 宮益坂 blocks (compressed east: 6.5 game m ≈ 16 m real)' },
  { id: 'lacoste', real: '渋谷ラコステビル', name: '渋谷ラコスタビル', lat: 35.660461, lng: 139.702632,
    x: 166.3, z: -108.9, rotY: -1.571, slots: 5, docked: 3, moved: 0.5, source: S,
    note: '明治通り east pavement, on the building line' },
  { id: 'kaleido', real: 'カレイド宮益坂', name: 'カレイダ宮益坂', lat: 35.660208, lng: 139.70313,
    x: 184.8, z: -80.7, rotY: 1.571, slots: 5, docked: 1, moved: 1.0, source: S,
    note: 'in the gap between the 宮益坂-north blocks right at the pin, facing east (the building behind it on its west side)' },
  { id: 'markcity', real: '渋谷マークシティ', name: '渋谷マークシティ', lat: 35.658324, lng: 139.699312,
    x: -111.2, z: 128.2, rotY: 0.416, slots: 3, docked: 2, moved: 0, source: S,
    note: 'on the narrow pavement between Mark City\'s south face and ウェーヴ通り' },
  { id: 'buzz', real: 'BUZZ渋谷東口SQUARE', name: 'BAZZ渋谷東口SQUARE', lat: 35.658346, lng: 139.703561,
    x: 198.52, z: 126.68, rotY: -1.497, slots: 5, docked: 3, moved: 1.3, source: S,
    note: 'east of 明治通り by the 青山通り junction, in the open lot behind the kerbside shops at the pin' },
  { id: 'square_a', real: '渋谷スクエアA', name: '渋谷スクエアA', lat: 35.657309, lng: 139.699279,
    x: -114.59, z: 192.09, rotY: 0.146, slots: 5, docked: 2, moved: 1.3, source: S,
    note: '桜丘, south of 玉川通り (compressed south)' },
  { id: 'repark_sakura3', real: 'リパーク渋谷桜丘第3', name: 'リパーコ渋谷桜丘第3', lat: 35.65677, lng: 139.701024,
    x: 42.74, z: 213.71, rotY: -2.996, slots: 5, docked: 3, moved: 4.3, source: S,
    note: 'a coin-parking lot on the 桜丘 side of 玉川通り, at the south edge of the map' },
  { id: 'east_bikepark', real: '渋谷駅東口地下駐輪場', name: '渋谷町駅東口地下駐輪場', lat: 35.657778, lng: 139.703296,
    x: 195.11, z: 178.26, rotY: -2.513, slots: 5, docked: 4, moved: 12, source: S,
    note: 'the pin is on the 明治通り × 玉川通り junction (the underground bike park\'s street entrance); the bay is on the nearest corner pavement toward ストリーム' },
];

export default LOOP_PORTS;
