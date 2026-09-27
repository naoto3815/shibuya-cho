// [city] Per-tenant interior recipes for the 3D shop rooms (interiors.js): what the real store looks like inside —
// palette, light colour and level, the fixture archetype and its density, hanging POP, and what the people inside
// are doing. Matched on the tenant's (near-)name first (tenantsData.js / the bay's fascia name), then on the shop
// type. The reference description behind each recipe is in docs/reports/interiors.md. No marks: recognisable by
// look (colour, light, fixtures), never by a logo.
//
//   arch     layout generator: books | konbini | drug | donki | fashion | shoes | dept | cafe | fast | ramen | izakaya |
//            game | capsule | karaoke | pachi | bank | phone | boutique | generic
//   wall / floor / ceil / fix / accent   colours (0xRRGGBB)      light  ceiling-panel colour     glow  0..1 self-light
//   dense    fixture density 0.6..1.6      pop  hanging POP colour or null      people [min, max] (scaled by area)
//   act      browse | read | queue | eat | wait (the people's pose: 'look' clips for browse / read, 'idle' otherwise)
const R = (o) => o;

export const ARCH_DEFAULT = {
  books:   R({ arch: 'books', wall: 0xe6ddcc, floor: 0x7a5a3e, ceil: 0xf2eee6, fix: 0x9a6b42, accent: 0x2c5a3e, light: 0xffe6c4, glow: 0.55, dense: 1, pop: null, people: [2, 5], act: 'read' }),
  conv:    R({ arch: 'konbini', wall: 0xf4f4f2, floor: 0xdcdcd6, ceil: 0xffffff, fix: 0xe8e8e4, accent: 0x2a8a4a, light: 0xf6fbff, glow: 0.72, dense: 1, pop: null, people: [1, 3], act: 'browse' }),
  drug:    R({ arch: 'drug', wall: 0xf2f2ee, floor: 0xd8d8d2, ceil: 0xffffff, fix: 0xe6e6e2, accent: 0x1a56b8, light: 0xf4f8ff, glow: 0.74, dense: 1.2, pop: 0xffe000, people: [2, 5], act: 'browse' }),
  fashion: R({ arch: 'fashion', wall: 0xe8e4de, floor: 0x9a948a, ceil: 0xdedad2, fix: 0x2a2a2c, accent: 0xc8b89a, light: 0xfff0dc, glow: 0.5, dense: 0.8, pop: null, people: [1, 4], act: 'browse' }),
  cafe:    R({ arch: 'cafe', wall: 0xd8c8b0, floor: 0x6a4a30, ceil: 0x3a2a20, fix: 0x7a5234, accent: 0x1e5a3c, light: 0xffd8a8, glow: 0.45, dense: 1, pop: null, people: [2, 6], act: 'eat' }),
  fast:    R({ arch: 'fast', wall: 0xf0e8d8, floor: 0xb89a70, ceil: 0xf4f0e8, fix: 0xc8302a, accent: 0xffc820, light: 0xfff2d8, glow: 0.7, dense: 1, pop: null, people: [2, 5], act: 'queue' }),
  ramen:   R({ arch: 'ramen', wall: 0xe8dcc0, floor: 0x4a3a2c, ceil: 0xe0d4bc, fix: 0x8a5a30, accent: 0xa8261a, light: 0xffe0b0, glow: 0.6, dense: 1, pop: null, people: [2, 5], act: 'eat' }),
  izakaya: R({ arch: 'izakaya', wall: 0x6a4a30, floor: 0x3a2a1e, ceil: 0x2a1e16, fix: 0x8a5a34, accent: 0xc8482e, light: 0xffc890, glow: 0.4, dense: 1, pop: 0xc8482e, people: [2, 6], act: 'eat' }),
  bar:     R({ arch: 'izakaya', wall: 0x3a2a22, floor: 0x241a14, ceil: 0x1a1410, fix: 0x6a4a30, accent: 0xffb060, light: 0xffb878, glow: 0.3, dense: 0.8, pop: null, people: [1, 4], act: 'eat' }),
  family:  R({ arch: 'cafe', wall: 0xf2e6c8, floor: 0xb89868, ceil: 0xf6f0e0, fix: 0xa87848, accent: 0xc8302a, light: 0xfff0d0, glow: 0.65, dense: 1, pop: null, people: [2, 6], act: 'eat' }),
  game:    R({ arch: 'game', wall: 0x14183a, floor: 0x1a1a2a, ceil: 0x0a0c1c, fix: 0x2a6ad0, accent: 0xff4ec0, light: 0xa0c8ff, glow: 0.9, dense: 1, pop: 0xff4ec0, people: [2, 5], act: 'browse' }),
  pachi:   R({ arch: 'pachi', wall: 0xe8c850, floor: 0x7a2a2a, ceil: 0xfff0c0, fix: 0xd0c8b8, accent: 0xc84040, light: 0xfff4d0, glow: 0.95, dense: 1, pop: 0xffe000, people: [2, 5], act: 'wait' }),
  karaoke: R({ arch: 'karaoke', wall: 0x2a1040, floor: 0x1a1024, ceil: 0x120a1c, fix: 0x5a2a8a, accent: 0xff5ec4, light: 0xff9ae0, glow: 0.8, dense: 1, pop: null, people: [1, 4], act: 'wait' }),
  bank:    R({ arch: 'bank', wall: 0xe8eaf0, floor: 0xb0b4bc, ceil: 0xf4f6fa, fix: 0xd0d4dc, accent: 0x1a3a7a, light: 0xf2f6ff, glow: 0.6, dense: 1, pop: null, people: [1, 3], act: 'queue' }),
  elec:    R({ arch: 'phone', wall: 0xf4f6f8, floor: 0xd0d4d8, ceil: 0xffffff, fix: 0xf0f0f0, accent: 0x2a6ad0, light: 0xf4f8ff, glow: 0.8, dense: 1, pop: null, people: [1, 4], act: 'browse' }),
  generic: R({ arch: 'generic', wall: 0xe8e4dc, floor: 0xa8a49c, ceil: 0xf0ece4, fix: 0xb8b0a4, accent: 0x5a7aa6, light: 0xfff4e0, glow: 0.6, dense: 1, pop: null, people: [1, 3], act: 'browse' }),
};

// [name regex, overrides] — the first match wins; the nearest showcase shops first
export const TENANT_RECIPES = [
  [/TSUTAYU/, { arch: 'books', wall: 0xd8c0a0, ceil: 0x5a4c40, floor: 0x8a6040, fix: 0xa87444, accent: 0x1f5c3f, light: 0xffe6c0, glow: 0.8, dense: 1.1, people: [10, 12], act: 'read', cafe: true, ref: 'tsutaya' }],
  [/STARBEANS/, { arch: 'cafe', wall: 0xd6c4a6, floor: 0x5a3e28, ceil: 0x3a2a1c, fix: 0x6e4a2c, accent: 0x1e5a3c, light: 0xffd6a0, glow: 0.5, people: [3, 6], act: 'eat', ref: 'starbucks' }],
  [/マツモトキヨヒ SHIBUYA SCRAMBLE FLAG/, { arch: 'drug', wall: 0xfafaf8, floor: 0xf0f0ec, ceil: 0xffffff, fix: 0xf6f6f4, accent: 0xd8c890, light: 0xf8fbff, glow: 0.82, dense: 1.0, pop: 0xf0e070, people: [3, 6], ref: 'matsukiyo_flag' }],
  [/マツモトキヨヒ/, { arch: 'drug', accent: 0x1a56b8, pop: 0xffe000, dense: 1.35, people: [3, 6], ref: 'matsukiyo' }],
  [/三千里薬局/, { arch: 'drug', accent: 0xc8102e, pop: 0xffe000, dense: 1.4, people: [2, 5], ref: 'sanzenri' }],
  [/サンドラック|ヨコダ薬局|スキ薬局|薬局/, { arch: 'drug', accent: 0xd02020, pop: 0xffe000, dense: 1.3, ref: 'drug' }],
  [/ドン・キホーヂ/, { arch: 'donki', wall: 0x1a2a6a, floor: 0x2a2a30, ceil: 0x101838, fix: 0xe8e2d0, accent: 0xffe000, light: 0xf8fbff, glow: 0.95, dense: 1.6, pop: 0xffe000, people: [3, 6], ref: 'donki' }],
  [/ヴィレッジヴァンガート/, { arch: 'donki', wall: 0x3a2a1a, floor: 0x5a4028, ceil: 0x2a1e14, fix: 0x8a6a40, accent: 0xffd400, light: 0xffe0a8, glow: 0.7, dense: 1.5, pop: 0xffd400, people: [2, 5], act: 'browse', ref: 'vv' }],
  [/ビックエコー|カラオケ|ジャンカレ|パセリ/, { arch: 'karaoke', ref: 'karaoke' }],
  [/#C-plu|ガチャ|カプセル/, { arch: 'capsule', wall: 0xf4f0ea, floor: 0xe0dcd4, ceil: 0xffffff, fix: 0xffffff, accent: 0xff5a8a, light: 0xffffff, glow: 0.9, dense: 1.3, pop: 0xff9ac8, people: [2, 5], ref: 'capsule' }],
  [/GiGU|タイトー|GIGA|ラウンドツー|アミューズ/, { arch: 'game', ref: 'gamecentre' }],
  [/すき屋|吉野屋|松家/, { arch: 'ramen', wall: 0xf4f2ee, floor: 0xb8b0a4, ceil: 0xffffff, fix: 0xe8a040, accent: 0xd8541e, light: 0xf8fbff, glow: 0.9, dense: 1, people: [2, 5], act: 'eat', ref: 'gyudon' }],
  [/カレー/, { arch: 'ramen', wall: 0xf0dcb0, floor: 0x6a4a2c, ceil: 0xf4ead8, fix: 0x9a6a30, accent: 0xe8a020, light: 0xffe4b0, glow: 0.65, people: [2, 4], ref: 'curry' }],
  [/ラーメン|らーめん|家系|汐ラーメン|金殿丸|マーラータン|うどん|そば|天下一本|一乱|豚骨/, { arch: 'ramen', ref: 'ramen' }],
  [/GASPANIK|SUMADOLI|\bBAR\b|バー(?!ガ|キ)/, { arch: 'izakaya', wall: 0x1e1a24, floor: 0x141018, ceil: 0x0e0c12, fix: 0x3a3040, accent: 0x40b0ff, light: 0x9a7aff, glow: 0.35, pop: null, people: [2, 5], ref: 'bar' }],
  [/酒場|居酒屋|鳥貴|魚民|笑々|和民|和氏|焼鳥|漁港|白木家/, { arch: 'izakaya', ref: 'izakaya' }],
  [/ティファニ/, { arch: 'boutique', wall: 0xf4f6f4, floor: 0xe8e6e0, ceil: 0xffffff, fix: 0xf2f2ee, accent: 0x86d0c6, light: 0xfff8f0, glow: 0.85, dense: 0.7, people: [1, 3], act: 'browse', ref: 'lux_jewel' }],
  [/シャネリ/, { arch: 'boutique', wall: 0xf2f0ec, floor: 0x1e1e20, ceil: 0xffffff, fix: 0x141416, accent: 0xf2f0ec, light: 0xfff8f0, glow: 0.8, dense: 0.7, people: [1, 3], act: 'browse', ref: 'lux_mono' }],
  [/ルイ・ヴィトソ|SEIBO/, { arch: 'boutique', wall: 0xc8a878, floor: 0x5a4030, ceil: 0xe8dcc4, fix: 0x6a4a30, accent: 0xc8a050, light: 0xffe8c8, glow: 0.7, dense: 0.7, people: [1, 3], act: 'browse', ref: 'lux_warm' }],
  [/ゴディバ/, { arch: 'boutique', wall: 0x4a2e22, floor: 0x3a2418, ceil: 0x2a1c14, fix: 0x5a3626, accent: 0xc8a050, light: 0xffd8a8, glow: 0.6, dense: 0.8, people: [1, 3], act: 'queue', ref: 'chocolatier' }],
  [/ノースフェイズ/, { arch: 'fashion', wall: 0xd8d0c4, floor: 0x6a5a48, ceil: 0x2a2826, fix: 0x1a1a1c, accent: 0xc8302a, light: 0xfff0dc, glow: 0.6, dense: 0.9, people: [1, 4], ref: 'outdoor' }],
  [/ABC-MARK|HOCA|NYKE|adidos|アディダズ|Onitsuka/, { arch: 'shoes', wall: 0xeeeeea, floor: 0x5a5a5e, ceil: 0xf6f6f4, fix: 0x2a2a2c, accent: 0xd02020, light: 0xf8f8ff, glow: 0.75, dense: 1.1, people: [2, 5], ref: 'shoes' }],
  [/MAGNET/, { arch: 'fashion', wall: 0xf2f0ec, floor: 0xcfcbc4, ceil: 0xffffff, fix: 0x1a1a1c, accent: 0xff4e8a, light: 0xfff6ec, glow: 0.7, dense: 0.9, people: [2, 5], ref: 'magnet' }],
  [/西部/, { arch: 'dept', wall: 0xe8e0d4, floor: 0xd8d0c4, ceil: 0xf4f0e8, fix: 0x2a2224, accent: 0xc8a870, light: 0xfff0dc, glow: 0.74, dense: 1, people: [3, 6], ref: 'seibu' }],
  [/チュチュアンヌ/, { arch: 'fashion', wall: 0xfff0f4, floor: 0xe6d8d0, ceil: 0xffffff, fix: 0xffffff, accent: 0xff8ab0, light: 0xfff6f2, glow: 0.8, dense: 1.3, people: [1, 4], ref: 'tutuanna' }],
  [/UNIQRO|GO\b|H&N|ZALA|WEGA|SPINZ|ZAPA|BRAND OF SHIBUYA|IKEYA|Pandara/, { arch: 'fashion', ref: 'fashion' }],
  [/銀行|証券|信託|アコン|プロミズ|アイフリ/, { arch: 'bank', ref: 'bank' }],
  [/マックドナルド|バーガー|MOM'Z|松家|吉野屋|すき屋|ロッテリヤ|ケンタッキ|サブウェー/, { arch: 'fast', ref: 'fastfood' }],
  [/ココカラ/, { arch: 'drug', accent: 0xd0302a, pop: 0xffe000, dense: 1.3, people: [2, 5], ref: 'drug' }],
  [/タリース/, { arch: 'cafe', wall: 0x3a2a24, floor: 0x4a3226, ceil: 0x1e1814, fix: 0x5a3a2a, accent: 0x8a1a2a, light: 0xffcf98, glow: 0.45, people: [2, 5], act: 'eat', ref: 'cafe_dark' }],
  [/ドトル/, { arch: 'cafe', wall: 0xf2e8d0, floor: 0x8a6a48, ceil: 0xfaf6ec, fix: 0xa87a4a, accent: 0xf2c020, light: 0xfff2d8, glow: 0.75, people: [2, 6], act: 'eat', ref: 'cafe_bright' }],
  [/CAFE|カフェ|珈琲|喫茶/, { arch: 'cafe', ref: 'cafe' }],
  [/ファミリマート/, { arch: 'konbini', accent: 0x1a8a4a, ref: 'konbini' }],
  [/セブンイレブ/, { arch: 'konbini', accent: 0xf28c1a, ref: 'konbini' }],
  [/ポッポ|ローソ/, { arch: 'konbini', accent: 0x1a56b8, ref: 'konbini' }],
  [/書店|BOOK|ブック/, { arch: 'books', ref: 'books' }],
  [/mineco|楽電|ソフトバング|ドコマ|aU|モバイル/, { arch: 'phone', ref: 'phone' }],
  [/ジュエリー|眼鏡|OOKURA|メガネ|Zolf|JlNS/, { arch: 'boutique', wall: 0xf4f2ee, floor: 0xd6d0c6, fix: 0xf0ece4, accent: 0xc8a870, light: 0xfff8ec, glow: 0.8, dense: 0.8, people: [1, 3], ref: 'boutique' }],
  [/フルーツ|パーラー|エンジェル/, { arch: 'cafe', wall: 0xfff4e8, floor: 0xe8d8c0, ceil: 0xffffff, fix: 0xf0e0c8, accent: 0xe8506a, light: 0xfff6ea, glow: 0.8, people: [2, 5], ref: 'parlour' }],
];

const TYPE_ALIAS = { gyudon: 'ramen', cinema: 'game', money: 'bank', office: 'generic', clinic: 'generic', hotel: 'generic' };

/** The recipe for a bay: tenant name first, then its shop type. */
export function recipeFor(bay) {
  const t = TYPE_ALIAS[bay.type] || bay.type;
  const base = ARCH_DEFAULT[t] || ARCH_DEFAULT.generic;
  const name = (bay.real && bay.real.name) || bay.name || '';
  for (const [re, o] of TENANT_RECIPES) if (re.test(name)) return { ...base, ...(ARCH_DEFAULT[o.arch === 'konbini' ? 'conv' : o.arch] || {}), ...o, name };
  return { ...base, name };
}
