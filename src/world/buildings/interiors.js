// [city] Real 3D shop interiors behind the nearest ground-floor shop fronts (client: 「建物の中が薄っぺらいので、もっと
// 立体的に」 / 「実態のお店の雰囲気がわかるように」). Every ground-floor shop bay the city builds is registered
// (genericBuilding.SHOP_BAYS). Every ground floor in the showpiece area (SHOW_R around the scramble) and every
// landmark ground floor is a room at EVERY distance — nothing switches representation in view. This module:
//   1. opens the facade with a DEPTH PUNCH: the rooms (and the posed people) draw first, then a depth-only pane in each
//      opening, then the city — inside the opening the wall, the interior-mapped card and the building behind them fail
//      the depth test, outside it the facade covers the room. No city shader is touched: a fragment discard in the
//      facade materials cost ~2 fps on Apple GPUs (it defeats hidden-surface removal), a geometry split + vertex
//      collapse the same (+1.2 s at boot); the punch is free and hides the costly cards behind it (docs/reports/interiors.md);
//   2. builds that room from INSTANCED parts shared by every shop (one InstancedMesh per part kind): walls, ceiling
//      with light panels, floor, and the tenant's fixtures laid out by its recipe (interiorRecipes.js): shelves in
//      depth with aisles, gondolas, fridge walls, counters, kitchens, rails, shoe walls, lit cases, machines, POP …;
//   3. stands the client's pedestrian scans inside (crowdScan.setStatics: the crowd's own instanced VAT tiers),
//      browsing / reading / queueing / eating per recipe, and as the dressed mannequins in fashion windows (frozen);
//   4. puts an unlit glass pane with a painted sheen in the opening; postfx skips its AO inside the open windows
//      (postfx.setInteriorCuts: the obscurance estimators painted blotches over every lit room).
// Level of detail lives inside the room (far / mid / near fixture sets, people from mid range as lod2 statics), and a
// level change in view cross-fades over ≥ 0.5 s (dithered). Upper floors and ground floors outside the showpiece area
// keep the interior-mapped card (genericBuilding's shader) with its painted scan cut-outs.
import * as THREE from 'three';
import * as L from './lib.js';
import { SHOP_BAYS, PEDS, paintPed } from './genericBuilding.js';
import { recipeFor } from './interiorRecipes.js';
import { groundY } from '../cityData.js';
import { MOBILE } from '../../core/mobileProfile.js';

// the showpiece area (pass 14: the whole map square, ±SHOW_R — 明治通り at 宮益坂下 is 174 m out) where every ground
// floor is a room; the level-of-detail distances
// inside a room (near: everything + people, mid: the floor's fixtures + two people as lod2, far: shell, light, back
// wall); levels cross-fade at FADE_RATE per second (≥ 0.5 s); MAX_CUTS openings skip postfx AO; MAX_PEOPLE posed
const SHOW_R = 232, NEAR_D = 25, MID_D = 70, FADE_RATE = 1.6, MAX_CUTS = 12, MAX_PEOPLE = 140;
const WHITE_UV = [0.995, 0.995];
const _pm = new THREE.Matrix4(), _fr = new THREE.Frustum(), _sp = new THREE.Sphere();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color(), _Y = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------------------------------------ the cutaway
export const CUT = {
  uCutA: { value: Array.from({ length: MAX_CUTS }, () => new THREE.Vector4()) },
  uCutB: { value: Array.from({ length: MAX_CUTS }, () => new THREE.Vector4()) },
  uCutC: { value: Array.from({ length: MAX_CUTS }, () => new THREE.Vector4()) },
  uCutS: { value: new THREE.Vector4(0, 0, 0, -1) },
  uCutY: { value: new THREE.Vector2(0, -1) },
  uCutN: { value: 0 },
};
// ------------------------------------------------------------------------------------------------ part geometry
// The goods atlas, 1024 × 1280, no marks anywhere (generic words and prices only):
//   y    0..640   eight SHELF FACES, 256 × 320 each (≈ 1 m × 1.2 m, four shelf levels of 80 px, true-scale goods):
//                 books ×2 | packs | snacks  //  bottles | cosmetics | magazines | boxes
//   y  640..896   four posters (fashion ×2, sale, beauty)
//   y  896..1024  four menu boards (noodles, fast food, cafe, izakaya)
//   y 1024..1152  eight hand-written POP cards
//   y 1152..1536  twenty-four aisle / wall category signs (konbini / drugstore / bookshop / fashion floor)
//   y 1536..1856  a shoe wall, a lit accessory case, a mirror, face-out clothes on a wall rail
//   y 1856..2624  eight fashion lightboxes: the client's scans shot on seamless studio backdrops (no pictograms)
//   y 2624..2752  eight more category signs: the electronics floors (LABY) and the discount jungle (MEGA donki)
const AW = 1024, AH = 2752;
const px = (x0, y0, x1, y1) => [x0 / AW, 1 - y1 / AH, x1 / AW, 1 - y0 / AH];
const FACE = (i) => { const x = (i % 4) * 256, y = Math.floor(i / 4) * 320; return px(x, y, x + 256, y + 320); };
const [BOOKS1, BOOKS2, PACKS, SNACKS, BOTTLES, COSM, MAGS, BOXES] = [0, 1, 2, 3, 4, 5, 6, 7].map(FACE);
const POSTER = (i) => px(i * 256, 640, (i + 1) * 256, 896);
const MENU = (i) => px(i * 256, 896, (i + 1) * 256, 1024);
const POPC = (i) => px(i * 128, 1024, (i + 1) * 128, 1152);
const CAT = (i) => px((i % 4) * 256, 1152 + Math.floor(i / 4) * 64, (i % 4 + 1) * 256, 1216 + Math.floor(i / 4) * 64);
const SHOEW = px(0, 1536, 256, 1856), ACCW = px(256, 1536, 512, 1856), MIRR = px(512, 1536, 768, 1856), CLOTH = px(768, 1536, 1024, 1856);
const CAT2 = (i) => px((i % 4) * 256, 2624 + Math.floor(i / 4) * 64, (i % 4 + 1) * 256, 2688 + Math.floor(i / 4) * 64);
const FPOST = (i) => { const x = (i % 4) * 256, y = 1856 + Math.floor(i / 4) * 384; return px(x, y, x + 256, y + 384); };
// the scans that read as fashion models (the crowd's stylish ones first; any baked scan works)
const MODELS = ['elegant_night_out_4745', 'silver_noir_swagger_4736', 'anime_inspired_street_0039', 'man_in_black_casual_o_5836', 'confident_modern_gent_4727',
  'evening_walk_in_the_c_4029', 'casual_student_portra_4103', 'wanderlust_explorer_4828', 'smiling_businesswoman_4044', 'confident_young_stude_4122'];

function goodsAtlas() {
  const c = L.makeCanvas(AW, AH), g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, AW, AH);
  const hash = (a, b) => L.hash(a, b, 911);
  const text = (t, x, y, sz, col, { font = L.FONT_JP, weight = '800', align = 'center', rot = 0 } = {}) => {
    g.save(); g.translate(x, y); g.rotate(rot); g.font = `${weight} ${sz}px ${font}`; g.textAlign = align; g.textBaseline = 'middle'; g.fillStyle = col; g.fillText(t, 0, 0); g.restore();
  };
  const SP = ['#8a3a2a', '#2a4a7a', '#c8b060', '#3a6a4a', '#e8e0d0', '#5a3a6a', '#b85a30', '#1a1a1a', '#d8d0c0', '#6a8aa8', '#a83a4a', '#e8c8a0'];
  const PK = ['#e05a5a', '#4a86d8', '#e8c850', '#50b070', '#d870b0', '#f4f4f0', '#e89040', '#8a70d0', '#40b8c8', '#f2e2c8', '#c83030', '#2a8a4a'];
  const PS = ['#e890b0', '#f4f0ec', '#b890d8', '#88c0e0', '#f0c070', '#90d0a0', '#e8a088', '#d04060', '#303034'];
  // one cell: bg, then four levels, each: goods standing on a board at the level's bottom
  const cell = (i, bg, board, rail, draw) => {
    const x0 = (i % 4) * 256, y0 = Math.floor(i / 4) * 320;
    g.fillStyle = bg; g.fillRect(x0, y0, 256, 320);
    for (let j = 0; j < 4; j++) {
      const top = y0 + j * 80, base = top + 74;
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x0, top, 256, 6);                  // the shelf above casts a band
      draw(x0, top, base, j);
      g.fillStyle = board; g.fillRect(x0, base, 256, 6);
      if (rail) { g.fillStyle = rail; g.fillRect(x0, base, 256, 5); for (let k = 0; k < 12; k++) { g.fillStyle = '#ffffff'; g.fillRect(x0 + 6 + k * 21, base + 1, 11, 3); } }
    }
  };
  const books = (i, seed) => cell(i, '#2e2218', '#6a4a30', null, (x0, top, base, j) => {
    let x = x0 + 2;
    while (x < x0 + 250) {
      const r = hash(x * 3 + seed, j);
      if (r < 0.08) {                                                              // a face-out cover
        const w = 40, h = 60; g.fillStyle = PK[Math.floor(hash(x, j + seed) * PK.length)]; g.fillRect(x, base - h, w, h);
        g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(x + 4, base - h + 6, w - 8, 10); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x + 8, base - h + 22, w - 16, 26);
        x += w + 2; continue;
      }
      const w = 7 + Math.floor(hash(x + seed, j + 1) * 8), h = 50 + Math.floor(hash(x + 7, j + seed) * 22);
      g.fillStyle = SP[Math.floor(hash(x + 3, j + seed) * SP.length)]; g.fillRect(x, base - h, w - 1, h);
      g.fillStyle = 'rgba(255,255,255,0.4)'; g.fillRect(x + 1, base - h + 6, w - 3, 2); g.fillRect(x + 1, base - 12, w - 3, 2);
      x += w;
    }
  });
  books(0, 0); books(1, 37);
  cell(2, '#d4d4d0', '#f0f0ee', '#ffe000', (x0, top, base, j) => {            // packs
    let x = x0 + 3;
    while (x < x0 + 248) {
      const w = 18 + Math.floor(hash(x, j + 3) * 18), h = 36 + Math.floor(hash(x + 5, j + 3) * 28), col = PK[Math.floor(hash(x + 1, j + 3) * PK.length)];
      const n = 1 + Math.floor(hash(x, j + 13) * 2);                               // facings of the same product
      for (let k = 0; k < n && x < x0 + 248; k++) { g.fillStyle = col; g.fillRect(x, base - h, w - 2, h); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillRect(x + 2, base - h * 0.62, w - 6, h * 0.2); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x + w - 4, base - h, 2, h); x += w; }
    }
  });
  cell(3, '#d8d6d0', '#f0f0ee', '#ffe000', (x0, top, base, j) => {            // snacks: bags
    let x = x0 + 2;
    while (x < x0 + 246) {
      const w = 28 + Math.floor(hash(x, j + 5) * 14), h = 46 + Math.floor(hash(x + 5, j + 5) * 20), col = PK[Math.floor(hash(x + 2, j + 5) * PK.length)];
      g.fillStyle = col; g.beginPath(); g.moveTo(x, base); g.lineTo(x, base - h + 8); g.quadraticCurveTo(x + w / 2, base - h - 6, x + w - 2, base - h + 8); g.lineTo(x + w - 2, base); g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.75)'; g.beginPath(); g.arc(x + w / 2, base - h * 0.45, w * 0.22, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x + 3, base - h * 0.85, w - 8, 4);
      x += w;
    }
  });
  cell(4, '#c8d6de', '#e8eef2', null, (x0, top, base, j) => {                 // bottles and cans (a fridge)
    let x = x0 + 3;
    const cans = j === 3;
    while (x < x0 + 248) {
      const col = PK[Math.floor(hash(x + 1, j + 7) * PK.length)];
      if (cans) { g.fillStyle = col; g.fillRect(x, base - 34, 13, 34); g.fillStyle = '#d8d8d8'; g.fillRect(x, base - 36, 13, 3); x += 15; continue; }
      const w = 16 + Math.floor(hash(x, 71) * 5), h = 54 + Math.floor(hash(x + 5, 71) * 14), clear = hash(x, j + 71) < 0.4;
      g.fillStyle = clear ? 'rgba(220,240,250,0.95)' : col; g.fillRect(x + 1, base - h + 12, w - 3, h - 12); g.fillRect(x + w / 2 - 4, base - h + 2, 6, 12);
      g.fillStyle = clear ? PK[Math.floor(hash(x, 9) * PK.length)] : '#ffffff'; g.fillRect(x + 1, base - h * 0.55, w - 3, h * 0.24);
      g.fillStyle = '#f4f4f4'; g.fillRect(x + w / 2 - 4, base - h - 2, 6, 5);
      x += w;
    }
  });
  cell(5, '#9a8c90', '#d8d2d4', '#ffe000', (x0, top, base, j) => {            // cosmetics: small bottles, tubes, jars on mirrored shelves
    let x = x0 + 3;
    while (x < x0 + 248) {
      const k = hash(x, j + 11), col = PS[Math.floor(hash(x + 1, j + 11) * PS.length)], cap = hash(x + 2, j) < 0.5 ? '#c8a860' : '#2a2a2a';
      if (k < 0.35) { const w = 12, h = 30 + Math.floor(k * 40); g.fillStyle = col; g.fillRect(x, base - h, w, h); g.fillStyle = cap; g.fillRect(x + 2, base - h - 8, w - 4, 9); x += w + 3; }
      else if (k < 0.7) { const w = 20, h = 20; g.fillStyle = col; g.fillRect(x, base - h, w, h); g.fillStyle = cap; g.fillRect(x - 1, base - h - 5, w + 2, 6); x += w + 3; }
      else { const w = 10, h = 44; g.fillStyle = col; g.fillRect(x, base - h, w, h); g.fillStyle = cap; g.fillRect(x, base - 8, w, 8); x += w + 2; }
    }
  });
  cell(6, '#e6e4de', '#cfcac2', null, (x0, top, base, j) => {                 // magazines face-out, staggered
    for (let k = 0; k < 6; k++) {
      const x = x0 + 4 + k * 42, col = PK[Math.floor(hash(k, j + 17) * PK.length)];
      g.fillStyle = col; g.fillRect(x, base - 66, 40, 66);
      g.fillStyle = '#ffffff'; g.fillRect(x + 2, base - 64, 36, 12); g.fillStyle = PK[(k + j) % PK.length]; g.fillRect(x + 4, base - 62, 30, 7);
      g.fillStyle = 'rgba(250,220,200,0.9)'; g.beginPath(); g.arc(x + 20, base - 32, 11, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(x + 3, base - 14, 34, 3); g.fillRect(x + 3, base - 9, 24, 3);
    }
  });
  cell(7, '#dcdad4', '#f0f0ee', '#ffe000', (x0, top, base, j) => {            // boxes: tissue, detergent, cartons
    let x = x0 + 3;
    while (x < x0 + 246) {
      const w = 32 + Math.floor(hash(x, j + 23) * 20), h = 34 + Math.floor(hash(x + 5, j + 23) * 32), col = PK[Math.floor(hash(x + 1, j + 23) * PK.length)];
      g.fillStyle = col; g.fillRect(x, base - h, w - 2, h); g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(x + 4, base - h + 6, w - 10, 8); g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(x + w - 5, base - h, 3, h);
      x += w;
    }
  });
  // a fashion shoot: seamless backdrop in the season's colour, a floor sweep, a soft key light from the upper left,
  // one of the client's scans (full body or a 3/4 crop), a contact shadow, a near-name wordmark and the season line
  const SERIF = '"Didot", "Bodoni 72", "Bodoni MT", "Times New Roman", serif';
  const models = PEDS ? MODELS.filter((k) => PEDS.meta.scans[k]).concat(PEDS.shoppers.filter((k) => !MODELS.includes(k))) : [];
  const shoot = (x0, y0, w, h, i, { top, bot, ink, brand, season, crop = 'full', view = 'q34', flip = false }) => {
    g.save(); g.beginPath(); g.rect(x0, y0, w, h); g.clip();
    let gr = g.createLinearGradient(0, y0, 0, y0 + h); gr.addColorStop(0, top); gr.addColorStop(0.72, bot); gr.addColorStop(1, top); g.fillStyle = gr; g.fillRect(x0, y0, w, h);
    const sweep = g.createRadialGradient(x0 + w * 0.5, y0 + h * 0.9, 4, x0 + w * 0.5, y0 + h * 0.9, w * 0.75); sweep.addColorStop(0, 'rgba(255,255,255,0.22)'); sweep.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = sweep; g.fillRect(x0, y0, w, h);
    const key = g.createRadialGradient(x0 + w * 0.22, y0 + h * 0.18, 4, x0 + w * 0.22, y0 + h * 0.18, w * 0.95); key.addColorStop(0, 'rgba(255,248,236,0.32)'); key.addColorStop(1, 'rgba(255,248,236,0)'); g.fillStyle = key; g.fillRect(x0, y0, w, h);
    const k = models.length ? models[i % models.length] : null;
    if (k) {
      if (crop === 'full') {
        const ppm = (h * 0.8) / 1.85, fy = y0 + h * 0.93;
        g.fillStyle = 'rgba(0,0,0,0.28)'; g.beginPath(); g.ellipse(x0 + w * 0.5 + 6, fy, w * 0.2, 6, 0, 0, Math.PI * 2); g.fill();
        paintPed(g, k, 'full', view, x0 + w * 0.5, fy, ppm, ppm, { flip });
      } else {
        const ppm = (h * 0.9) / 1.0;
        paintPed(g, k, 'upper', view, x0 + w * 0.52, y0 + h * 1.02, ppm, ppm, { flip });
      }
    }
    const vig = g.createRadialGradient(x0 + w / 2, y0 + h / 2, w * 0.35, x0 + w / 2, y0 + h / 2, h * 0.75); vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.35)'); g.fillStyle = vig; g.fillRect(x0, y0, w, h);
    g.save(); g.font = `400 ${Math.round(w * 0.14)}px ${SERIF}`; g.textAlign = 'center'; g.textBaseline = 'top'; g.fillStyle = ink;
    if ('letterSpacing' in g) g.letterSpacing = `${Math.round(w * 0.03)}px`; g.fillText(brand, x0 + w / 2, y0 + h * 0.05); g.restore();
    g.save(); g.font = `500 ${Math.round(w * 0.05)}px ${L.FONT_LATIN}`; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillStyle = ink;
    if ('letterSpacing' in g) g.letterSpacing = `${Math.round(w * 0.012)}px`; g.fillText(season, x0 + w / 2, y0 + h * 0.975); g.restore();
    g.restore();
  };
  const SHOOTS = [
    { top: '#cfae8a', bot: '#8e6c4e', ink: '#fbf4ea', brand: 'SEIBO', season: 'AUTUMN / WINTER 2026' },
    { top: '#a9bcaa', bot: '#5f7564', ink: '#f4f6f0', brand: 'MAGNET', season: 'NEW ARRIVALS', view: 'front' },
    { top: '#e1b3ab', bot: '#9a6a66', ink: '#fff6f2', brand: 'ZALA', season: 'COLLECTION 26', crop: 'upper' },
    { top: '#4a68bc', bot: '#1a2a60', ink: '#eef2ff', brand: 'WEGA', season: 'THE DENIM EDIT', flip: true },
    { top: '#efe9dd', bot: '#b8b0a2', ink: '#1c1a18', brand: 'GO', season: 'ESSENTIALS', view: 'front' },
    { top: '#34343a', bot: '#0e0e10', ink: '#f0e6d0', brand: 'SPINZ', season: 'NIGHT OUT', crop: 'upper', flip: true },
    { top: '#cc7452', bot: '#7a3a24', ink: '#fff0e6', brand: 'UNIQRO', season: 'WARM LAYERS' },
    { top: '#56787e', bot: '#1e3034', ink: '#eaf6f4', brand: 'SHIBUYA-CHO', season: 'STREET 26', view: 'front', flip: true },
  ];
  // posters (y 640..896): the two landscape cells are shoot crops too (the old pictogram posters are gone)
  { const Y = 640;
    shoot(0, Y, 256, 256, 3, { ...SHOOTS[0], crop: 'upper', season: 'NEW SEASON' });
    shoot(256, Y, 256, 256, 6, { ...SHOOTS[3], crop: 'upper', season: 'COLLECTION' });
    g.fillStyle = '#ffffff'; g.fillRect(512, Y, 256, 256); g.fillStyle = '#d0102a'; g.beginPath(); g.moveTo(512, Y + 178); g.lineTo(768, Y + 78); g.lineTo(768, Y + 148); g.lineTo(512, Y + 248); g.closePath(); g.fill();
    text('SALE', 640, Y + 78, 84, '#141414', { font: L.FONT_LATIN, weight: '900' }); text('30%OFF', 640, Y + 178, 40, '#ffffff', { font: L.FONT_LATIN, weight: '900', rot: -0.37 });
    g.fillStyle = '#f7d9e2'; g.fillRect(768, Y, 256, 256);
    for (const [bx, bw, bh, col] of [[800, 44, 120, '#ffffff'], [860, 36, 150, '#e8c890'], [912, 50, 100, '#ffffff'], [972, 30, 130, '#f0b8c8']]) { g.fillStyle = col; g.fillRect(bx, Y + 208 - bh, bw, bh); g.fillStyle = '#c8a870'; g.fillRect(bx + bw * 0.25, Y + 200 - bh, bw * 0.5, 10); }
    text('BEAUTY', 896, Y + 40, 40, '#b0506a', { font: L.FONT_LATIN, weight: '300' }); }
  // menu boards (y 896..1024)
  { const Y = 896;
    const photo = (x, y, fill, top) => { g.fillStyle = '#3a2e26'; g.fillRect(x, y, 52, 52); g.fillStyle = fill; g.beginPath(); g.arc(x + 26, y + 27, 21, 0, Math.PI * 2); g.fill(); if (top) { g.fillStyle = top; g.fillRect(x + 12, y + 22, 28, 4); g.fillRect(x + 14, y + 29, 24, 4); } };
    g.fillStyle = '#1e1a18'; g.fillRect(0, Y, 256, 128);
    ['醤油 ¥880', '味噌 ¥950', '特製 ¥1200'].forEach((t, i) => { photo(8 + i * 82, Y + 8, '#b8742e', '#f2d880'); text(t, 34 + i * 82, Y + 80, 17, '#f4ead8'); });
    text('大盛無料　ライス ¥150', 128, Y + 110, 16, '#ffcc40');
    g.fillStyle = '#fff4d8'; g.fillRect(256, Y, 256, 128); g.fillStyle = '#c8202a'; g.fillRect(256, Y, 256, 22); text('MENU', 384, Y + 11, 16, '#ffffff', { font: L.FONT_LATIN, weight: '900' });
    for (let i = 0; i < 3; i++) { const x = 266 + i * 82; g.fillStyle = '#d89a48'; g.beginPath(); g.ellipse(x + 30, Y + 50, 28, 13, 0, Math.PI, 0); g.fill(); g.fillStyle = '#6a3a20'; g.fillRect(x + 4, Y + 52, 52, 7); g.fillStyle = '#58a048'; g.fillRect(x + 4, Y + 50, 52, 3); g.fillStyle = '#d89a48'; g.fillRect(x + 4, Y + 59, 52, 7);
      text(['¥390', '¥590', 'SET¥750'][i], x + 30, Y + 94, 18, '#c8202a', { font: L.FONT_LATIN, weight: '900' }); }
    g.fillStyle = '#23302a'; g.fillRect(512, Y, 256, 128);
    for (let i = 0; i < 3; i++) { const x = 530 + i * 80; g.fillStyle = '#f4f0e8'; g.fillRect(x + 8, Y + 18, 34, 40); g.fillStyle = '#8a5a34'; g.fillRect(x + 8, Y + 18, 34, 8); g.fillStyle = '#6a4228'; g.fillRect(x + 12, Y + 32, 26, 18); }
    ['COFFEE ¥390', 'LATTE ¥450', 'TEA ¥420'].forEach((t, i) => text(t, 554 + i * 80, Y + 78, 14, '#f4f0e8', { font: L.FONT_LATIN, weight: '700' }));
    text('本日のおすすめ', 640, Y + 108, 17, '#e8d8a0');
    g.fillStyle = '#b89060'; g.fillRect(768, Y, 256, 128); g.fillStyle = '#6a4a2c';
    for (let i = 0; i < 6; i++) g.fillRect(776 + i * 41, Y + 8, 36, 112);
    ['生ビール', '焼鳥', '枝豆', '唐揚げ', 'ハイボール', '刺身'].forEach((t, i) => { for (let k = 0; k < t.length && k < 5; k++) text(t[k], 794 + i * 41, Y + 24 + k * 20, 16, '#fff4e0'); }); }
  // hand-written POP (y 1024..1152)
  ['激安!', '¥980', 'SALE', 'NEW', '人気No.1', 'おすすめ', '半額', '限定'].forEach((t, i) => {
    const x = i * 128, y = 1024;
    g.fillStyle = i % 3 === 2 ? '#ff4a6a' : '#ffe600'; g.fillRect(x + 4, y + 4, 120, 120);
    g.strokeStyle = '#d0102a'; g.lineWidth = 5; g.strokeRect(x + 9, y + 9, 110, 110);
    text(t, x + 64, y + 66, t.length > 4 ? 26 : 40, i % 3 === 2 ? '#ffffff' : (i % 2 ? '#141414' : '#d0102a'), { weight: '900', rot: (hash(i, 5) - 0.5) * 0.3 });
  });
  // aisle category signs (y 1152..1280)
  ['日用品', 'お菓子', 'ドリンク', 'カップ麺', '化粧品', '医薬品', '文具', '雑誌', 'コミック', '新刊', '文芸', 'ビジネス', '料理', '旅行', '洋書', '写真集', 'SALE', 'NEW ARRIVAL', 'LIMITED', 'COSMETICS', 'ACCESSORY', 'SHOES', 'BAGS', 'FRAGRANCE'].forEach((t, i) => {
    const x = (i % 4) * 256, y = 1152 + Math.floor(i / 4) * 64, col = ['#6a3fb0', '#e0602a', '#1f7ad0', '#d0302a', '#e0508a', '#2a9a5a', '#e89a20', '#3a4a8a', '#1f6a4a', '#c8302a', '#6a4a8a', '#2a5a9a', '#d8702a', '#2a8aa8', '#5a3a6a', '#3a3a3a', '#c8102e', '#1a1a1a', '#2a4a8a', '#b8905a', '#3a6a5a', '#6a3a2a', '#1e3a5a', '#7a4a7a'][i];
    g.fillStyle = col; g.fillRect(x + 2, y + 2, 252, 60); g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(x + 8, y + 8, 6, 48);
    text(t, x + 134, y + 33, t.length > 6 ? 28 : 38, '#ffffff', { weight: '900', font: /^[A-Z ]+$/.test(t) ? L.FONT_LATIN : L.FONT_JP });
  });
  // category signs for the two Bunkamura stores (y 2624..2752): electronics floors, the discount jungle
  [['テレビ', '#1f4c8a'], ['パソコン', '#1f6fc0'], ['スマートフォン', '#d8232e'], ['カメラ・ゲーム', '#2f9a4a'], ['驚安!!', '#ffd21e'], ['食品・お菓子', '#e0602a'], ['おみやげ', '#c8202e'], ['コスメ・香水', '#e0508a']].forEach(([t, col], i) => {
    const x = (i % 4) * 256, y = 2624 + Math.floor(i / 4) * 64, dark = col === '#ffd21e';
    g.fillStyle = col; g.fillRect(x + 2, y + 2, 252, 60); g.fillStyle = dark ? '#c8202e' : 'rgba(255,255,255,0.9)'; g.fillRect(x + 8, y + 8, 6, 48);
    text(t, x + 134, y + 33, t.length > 5 ? 30 : 40, dark ? '#c8202e' : '#ffffff', { weight: '900' });
  });
  // ---- y 1536..1856: shoe wall | lit accessory case | mirror | face-out clothes
  { const Y = 1536;
    // shoe wall: glass shelves, pairs of sneakers / boots / heels / loafers, price tags
    g.fillStyle = '#5e5854'; g.fillRect(0, Y, 256, 320);
    for (let j = 0; j < 5; j++) { const lg = g.createLinearGradient(0, Y + j * 62, 0, Y + 62 + j * 62); lg.addColorStop(0, 'rgba(255,236,210,0.28)'); lg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = lg; g.fillRect(0, Y + j * 62, 256, 62); }
    const SC = ['#f4f4f2', '#1a1a1c', '#c83030', '#2a4a8a', '#c8a070', '#6a4a30', '#e8e0d0', '#3a6a4a', '#d8d0c8'];
    for (let j = 0; j < 5; j++) {
      const base = Y + 58 + j * 62; g.fillStyle = 'rgba(160,180,190,0.7)'; g.fillRect(0, base, 256, 4);
      for (let q = 0; q < 4; q++) {
        const x = 10 + q * 62, col = SC[Math.floor(hash(q, j + 31) * SC.length)], sole = hash(q, j + 7) < 0.6 ? '#f8f8f6' : '#2a2a2a', kind = Math.floor(hash(q + 3, j) * 4);
        for (const dx of [0, 22]) {
          g.fillStyle = col;
          if (kind === 0) { g.beginPath(); g.moveTo(x + dx, base); g.lineTo(x + dx, base - 16); g.quadraticCurveTo(x + dx + 8, base - 22, x + dx + 20, base - 10); g.lineTo(x + dx + 22, base); g.closePath(); g.fill(); g.fillStyle = sole; g.fillRect(x + dx, base - 4, 22, 4); }
          else if (kind === 1) { g.fillRect(x + dx + 2, base - 32, 10, 30); g.fillRect(x + dx + 2, base - 10, 20, 10); g.fillStyle = sole; g.fillRect(x + dx + 2, base - 3, 20, 3); }
          else if (kind === 2) { g.beginPath(); g.moveTo(x + dx, base - 14); g.lineTo(x + dx + 18, base - 4); g.lineTo(x + dx + 20, base); g.lineTo(x + dx + 16, base); g.lineTo(x + dx + 2, base - 8); g.closePath(); g.fill(); g.fillRect(x + dx, base - 14, 3, 14); }
          else { g.beginPath(); g.moveTo(x + dx, base); g.lineTo(x + dx + 2, base - 10); g.lineTo(x + dx + 20, base - 8); g.lineTo(x + dx + 21, base); g.closePath(); g.fill(); g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillRect(x + dx + 6, base - 9, 8, 2); }
        }
        g.fillStyle = '#ffffff'; g.fillRect(x + 12, base + 6, 20, 8); g.fillStyle = '#c8102e'; g.fillRect(x + 14, base + 8, 12, 4);
      }
    }
    // accessory case interior: velvet shelves lit from inside, bags / watches / sunglasses / jewellery
    let gr = g.createLinearGradient(0, Y, 0, Y + 320); gr.addColorStop(0, '#fff4e0'); gr.addColorStop(1, '#6a4a3a'); g.fillStyle = '#3a2a24'; g.fillRect(256, Y, 256, 320);
    for (let j = 0; j < 3; j++) {
      const y0 = Y + j * 106; const lg = g.createLinearGradient(0, y0, 0, y0 + 100); lg.addColorStop(0, 'rgba(255,236,200,0.55)'); lg.addColorStop(1, 'rgba(60,30,30,0)'); g.fillStyle = lg; g.fillRect(256, y0, 256, 100);
      g.fillStyle = '#5a2a34'; g.fillRect(256, y0 + 92, 256, 12);
      for (let q = 0; q < 3; q++) {
        const cx = 256 + 44 + q * 84, base = y0 + 92, t = (j + q) % 4;
        if (t === 0) { g.fillStyle = ['#8a4a2a', '#1a1a1c', '#c8a070'][q % 3]; g.fillRect(cx - 26, base - 38, 52, 38); g.strokeStyle = g.fillStyle; g.lineWidth = 4; g.beginPath(); g.arc(cx, base - 38, 16, Math.PI, 0); g.stroke(); g.fillStyle = '#e8c870'; g.fillRect(cx - 4, base - 30, 8, 5); }
        else if (t === 1) { g.fillStyle = '#d8d0c0'; g.fillRect(cx - 18, base - 8, 36, 8); g.fillStyle = '#e8c870'; g.beginPath(); g.arc(cx, base - 22, 13, 0, Math.PI * 2); g.fill(); g.fillStyle = '#f4f0e8'; g.beginPath(); g.arc(cx, base - 22, 10, 0, Math.PI * 2); g.fill(); }
        else if (t === 2) { g.fillStyle = '#1a1a1c'; g.beginPath(); g.ellipse(cx - 13, base - 14, 12, 9, 0, 0, Math.PI * 2); g.ellipse(cx + 13, base - 14, 12, 9, 0, 0, Math.PI * 2); g.fill(); g.fillRect(cx - 2, base - 17, 4, 3); }
        else { g.strokeStyle = '#f0d890'; g.lineWidth = 2; g.beginPath(); g.arc(cx, base - 26, 16, 0.2, Math.PI - 0.2); g.stroke(); g.fillStyle = '#ffffff'; g.beginPath(); g.arc(cx, base - 10, 4, 0, Math.PI * 2); g.fill(); }
      }
    }
    // mirror: a cool gradient with two soft highlights
    gr = g.createLinearGradient(512, Y, 768, Y + 320); gr.addColorStop(0, '#c8d0d4'); gr.addColorStop(0.5, '#8a949a'); gr.addColorStop(1, '#5a6268'); g.fillStyle = gr; g.fillRect(512, Y, 256, 320);
    g.filter = 'blur(8px)'; g.fillStyle = 'rgba(255,255,255,0.45)'; g.save(); g.translate(600, Y + 160); g.rotate(-0.4); g.fillRect(-12, -200, 24, 400); g.fillRect(40, -200, 8, 400); g.restore(); g.filter = 'none';
    // face-out clothes: two levels of garments on a wall rail (shoulders, collars, sleeves)
    g.fillStyle = '#d8d2c8'; g.fillRect(768, Y, 256, 320);
    const GC2 = ['#2a2a30', '#8a4a44', '#4a5a74', '#e8e0d4', '#6a6450', '#c8b89a', '#1c2a44', '#b86a4a', '#f4f0ea', '#5a6a3a'];
    for (let j = 0; j < 2; j++) {
      const bar = Y + 20 + j * 150; g.fillStyle = '#3a3a3c'; g.fillRect(768, bar, 256, 5);
      for (let q = 0; q < 4; q++) {
        const cx = 768 + 32 + q * 64, col = GC2[Math.floor(hash(q, j + 51) * GC2.length)], len = 100 + Math.floor(hash(q + 9, j) * 26);
        g.strokeStyle = '#8a8a8c'; g.lineWidth = 2; g.beginPath(); g.moveTo(cx, bar); g.lineTo(cx, bar + 8); g.stroke();
        g.fillStyle = col; g.beginPath(); g.moveTo(cx - 12, bar + 10); g.lineTo(cx + 12, bar + 10); g.lineTo(cx + 26, bar + 24); g.lineTo(cx + 22, bar + len); g.lineTo(cx - 22, bar + len); g.lineTo(cx - 26, bar + 24); g.closePath(); g.fill();
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(cx - 1, bar + 14, 2, len - 16); g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(cx - 8, bar + 10, 16, 5);
      }
    }
  }
  // ---- y 1856..2624: eight fashion lightboxes (256 × 384)
  SHOOTS.forEach((o, i) => shoot((i % 4) * 256, 1856 + Math.floor(i / 4) * 384, 256, 384, i, o));
  const t = L.canvasTex(c, { aniso: 8 });
  t.flipY = true; t.needsUpdate = true;
  return t;
}

class Part {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.lit = []; this.tint = []; this.tex = []; this.idx = []; this.keep = false; this.goods = false; }
  // tint: the instance colour applies (frames, walls, lights); textured faces (goods, spines) and `keep` boxes keep theirs
  quad(a, b, c, d, n, col, uvr = null, lit = 0, tint = uvr || this.keep ? 0 : 1) {
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) { this.pos.push(...p); this.nor.push(...n); this.col.push(col.r, col.g, col.b); this.lit.push(lit); this.tint.push(tint); this.tex.push(uvr ? (this.goods ? 2 : 1) : 0); }
    if (uvr) this.uv.push(uvr[0], uvr[1], uvr[2], uvr[1], uvr[2], uvr[3], uvr[0], uvr[3]); else for (let k = 0; k < 4; k++) this.uv.push(...WHITE_UV);
    // winding from the normal
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] >= 0) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3); else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  // axis box: centre (x, y, z), size (w, h, d); faces: { f: uvr for +z, b: uvr for −z }, lit per face
  box(x, y, z, w, h, d, hex, { f = null, b = null, litF = 0, lit = 0, noBottom = true, keep = false } = {}) {
    const k0 = this.keep; this.keep = keep || k0;
    const col = new THREE.Color(hex), x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2, z0 = z - d / 2, z1 = z + d / 2;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], col, f, f ? litF || lit : lit);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], col, b, b ? litF || lit : lit);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], col, null, lit);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], col, null, lit);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], col, null, lit);
    if (!noBottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], col, null, lit);
    this.keep = k0;
    return this;
  }
  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aLit', new THREE.Float32BufferAttribute(this.lit, 1));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 1));
    g.setAttribute('aTex', new THREE.Float32BufferAttribute(this.tex, 1));
    g.setAttribute('iFade', new THREE.Float32BufferAttribute(new Float32Array(this.pos.length / 3).fill(1), 1));   // (instanced meshes replace it)
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
const W = 0xffffff;
function makeParts() {
  const P = {};
  // room shell (walls; inward faces): x −0.5..0.5, y 0..1, z −1..0 (front open)
  P.walls = new Part();
  { const c = new THREE.Color(W);
    P.walls.quad([-0.5, 0, 0], [-0.5, 0, -1], [-0.5, 1, -1], [-0.5, 1, 0], [1, 0, 0], c);
    P.walls.quad([0.5, 0, -1], [0.5, 0, 0], [0.5, 1, 0], [0.5, 1, -1], [-1, 0, 0], c);
    P.walls.quad([-0.5, 0, -1], [0.5, 0, -1], [0.5, 1, -1], [-0.5, 1, -1], [0, 0, 1], c);
    const sk = new THREE.Color(0x3a3634);                                                 // skirting
    P.walls.quad([-0.499, 0, 0], [-0.499, 0, -1], [-0.499, 0.03, -1], [-0.499, 0.03, 0], [1, 0, 0], sk);
    P.walls.quad([0.499, 0, -1], [0.499, 0, 0], [0.499, 0.03, 0], [0.499, 0.03, -1], [-1, 0, 0], sk);
    P.walls.quad([-0.5, 0, -0.999], [0.5, 0, -0.999], [0.5, 0.03, -0.999], [-0.5, 0.03, -0.999], [0, 0, 1], sk); }
  P.ceil = new Part();
  P.ceil.quad([-0.5, 1, 0], [0.5, 1, 0], [0.5, 1, -1], [-0.5, 1, -1], [0, -1, 0], new THREE.Color(W));
  P.floor = new Part();
  P.floor.quad([-0.5, 0, 0], [0.5, 0, 0], [0.5, 0, -1], [-0.5, 0, -1], [0, 1, 0], new THREE.Color(W));
  P.panel = new Part().box(0, 0, 0, 1.2, 0.04, 0.3, W, { lit: 1 });                          // ceiling light panel (hung at its centre)
  P.spot = new Part().box(0, 0, 0, 0.18, 0.08, 0.18, W, { lit: 1 });
  // shelves: wall unit 1 × 2.2 × 0.4 (front +z), free-standing double-sided 1 × 1.8 × 0.55, gondola 1 × 1.4 × 0.9
  // shelf unit, 1 m wide, front +z: the face (and back face) stack the atlas cell n times so the goods stay true to
  // scale, and a board sits proud at every painted level
  const shelf = (p, h, d, uvf, uvb, fr) => {
    const f0 = 0.1, fh = h - 0.14, n = Math.max(1, Math.round(fh / 1.15)), sh = fh / n;
    p.goods = true;
    p.box(0, h / 2, 0, 1, h, d * 0.2, fr);                                                  // back panel
    for (let k = 0; k < n; k++) {
      const y0 = f0 + k * sh, y1 = y0 + sh;
      if (uvf) p.quad([-0.48, y0, d / 2], [0.48, y0, d / 2], [0.48, y1, d / 2], [-0.48, y1, d / 2], [0, 0, 1], new THREE.Color(W), uvf);
      if (uvb) p.quad([0.48, y0, -d / 2], [-0.48, y0, -d / 2], [-0.48, y1, -d / 2], [0.48, y1, -d / 2], [0, 0, -1], new THREE.Color(W), uvb);
    }
    p.box(-0.49, h / 2, 0, 0.03, h, d + 0.02, fr); p.box(0.49, h / 2, 0, 0.03, h, d + 0.02, fr); p.box(0, h - 0.02, 0, 1, 0.04, d + 0.02, fr);
    for (let k = 0; k < 4 * n; k++) p.box(0, f0 + (k + 1) * sh / 4 - sh / 4 * (74 / 80) + 0.004 - 0.02, 0, 0.96, 0.02, d + 0.03, fr);
    p.box(0, 0.05, 0, 0.98, 0.1, d, fr);                                                   // kick plate
    p.goods = false;
    return p;
  };
  P.wallBooks = shelf(new Part(), 2.2, 0.4, BOOKS1, null, 0x8a6a4a);
  P.bookshelf = shelf(new Part(), 2.1, 0.55, BOOKS1, BOOKS2, 0x8a6a4a);
  P.wallGoods = shelf(new Part(), 2.0, 0.45, PACKS, null, 0xdcdcd8);
  P.wallDrug = shelf(new Part(), 2.0, 0.45, COSM, null, 0xf2f2f0);
  P.gondola = shelf(new Part(), 1.45, 0.9, SNACKS, PACKS, 0xe4e4e0);
  P.gondolaDrug = shelf(new Part(), 1.45, 0.9, COSM, BOXES, 0xf0f0ee);
  P.lowGoods = shelf(new Part(), 0.9, 0.9, BOXES, BOXES, 0xe4e4e0);
  P.magRack = shelf(new Part(), 1.2, 0.4, MAGS, null, 0xd8d8d4);
  // fridge wall unit: body + lit glass front of goods
  P.fridge = new Part(); P.fridge.goods = true; P.fridge.box(0, 1.0, 0, 1, 2.0, 0.7, 0x9aa0a8).box(0, 0.625, 0.36, 0.9, 0.85, 0.02, W, { f: BOTTLES, litF: 0.45 }).box(0, 1.475, 0.36, 0.9, 0.85, 0.02, W, { f: BOTTLES, litF: 0.45 }).box(0, 1.05, 0.372, 0.9, 0.03, 0.01, 0x9aa0a8, { keep: true });
  // counter 1 × 1 × 0.7 with a lighter top and a register
  P.counter = new Part().box(0, 0.48, 0, 1, 0.96, 0.7, W).box(0, 0.98, 0, 1.02, 0.04, 0.74, 0xf0f0ec, { keep: true }).box(0.25, 1.12, 0.05, 0.3, 0.24, 0.26, 0x2a2a2e, { keep: true });
  P.glassCounter = new Part().box(0, 0.35, 0, 1, 0.7, 0.6, W).box(0, 0.85, 0, 0.96, 0.3, 0.56, 0xcfe0ea, { lit: 0.12, f: PACKS, litF: 0.3 });
  P.cosmCounter = new Part().box(0, 0.45, 0, 1, 0.9, 0.6, W).box(0, 1.05, 0, 0.96, 0.3, 0.56, 0xf4f0f2, { lit: 0.08, f: COSM, litF: 0.25 }).box(0, 1.5, -0.25, 0.9, 0.5, 0.06, 0xf8f6f4, { lit: 0.12 });
  P.table = new Part().box(0, 0.72, 0, 0.8, 0.04, 0.8, W).box(0, 0.36, 0, 0.08, 0.72, 0.08, 0x3a3a3c, { keep: true });
  P.stool = new Part().box(0, 0.62, 0, 0.36, 0.06, 0.36, W).box(0, 0.31, 0, 0.05, 0.62, 0.05, 0x3a3a3c, { keep: true });
  P.sofa = new Part().box(0, 0.22, 0, 1.8, 0.44, 0.8, W).box(0, 0.6, -0.32, 1.8, 0.5, 0.16, W);
  // clothes rail 1.2 wide with 8 garments hanging from it (vertex-coloured), a mannequin, a table of folded stock
  // garment rails, 1.2 m: chrome frame, 12 garments on hangers (shoulder + body, varied lengths), two palettes
  const rail = (GC) => {
    const p = new Part(); p.box(0, 1.52, 0, 1.24, 0.025, 0.025, 0xb8bcc0, { keep: true }); p.box(-0.6, 0.76, 0, 0.025, 1.52, 0.025, 0xb8bcc0, { keep: true }); p.box(0.6, 0.76, 0, 0.025, 1.52, 0.025, 0xb8bcc0, { keep: true });
    p.box(-0.6, 0.02, 0, 0.05, 0.04, 0.5, 0xb8bcc0, { keep: true }); p.box(0.6, 0.02, 0, 0.05, 0.04, 0.5, 0xb8bcc0, { keep: true });
    for (let k = 0; k < 12; k++) {
      const x = -0.53 + k * 0.096, len = 0.62 + ((k * 7) % 5) * 0.09, col = GC[(k * 5) % GC.length];
      p.box(x, 1.47, 0, 0.012, 0.06, 0.34, 0x6a6a6a, { keep: true });                          // hanger
      p.box(x, 1.42, 0, 0.07, 0.07, 0.4, col, { keep: true });                                   // shoulders
      p.box(x, 1.42 - len / 2, 0, 0.06, len, 0.44, col, { keep: true });                         // body
    }
    return p;
  };
  P.rail = rail([0x2a2a30, 0x8a4a44, 0x4a5a74, 0xd8d0c6, 0x6a6450, 0xc8b89a, 0x3a3a3c, 0xe8e4dc]);
  P.railB = rail([0xc86a4a, 0xe8d8b0, 0x2a4a7a, 0x9a3a4a, 0xf2efe8, 0x5a7a4a, 0xd8a040, 0x1a1a1c]);
  // a wall rail seen face-out: the clothes texture on a panel, a double bar, some garments in 3D at the ends
  { const p = new Part(); p.goods = true; p.quad([-0.5, 0.25, 0.3], [0.5, 0.25, 0.3], [0.5, 1.95, 0.3], [-0.5, 1.95, 0.3], [0, 0, 1], new THREE.Color(W), CLOTH); p.goods = false;
    p.box(0, 1.93, 0.12, 1, 0.03, 0.03, 0xb8bcc0, { keep: true }).box(0, 1.08, 0.12, 1, 0.03, 0.03, 0xb8bcc0, { keep: true });
    p.box(0, 1.1, -0.02, 1, 2.2, 0.04, W);
    P.wallRail = p; }
  // shoe wall (glass shelves), lit accessory case, mirror
  P.shoeWall = shelf(new Part(), 2.2, 0.32, SHOEW, null, 0x4a4440);
  { const p = new Part(); p.box(0, 0.45, 0, 1, 0.9, 0.5, W);
    p.goods = true; p.box(0, 1.35, 0, 0.96, 0.9, 0.46, 0xfff4e0, { f: ACCW, litF: 0.35, lit: 0.1, keep: true }); p.goods = false;
    p.box(0, 1.82, 0, 1, 0.04, 0.5, W).box(0, 1.8, 0.0, 0.9, 0.02, 0.4, 0xfff0d8, { lit: 0.9, keep: true });
    P.accCase = p; }
  { const p = new Part(); p.box(0, 1.0, 0, 0.66, 2.0, 0.04, 0x1a1a1c, { keep: true }); p.quad([-0.3, 0.06, 0.021], [0.3, 0.06, 0.021], [0.3, 1.94, 0.021], [-0.3, 1.94, 0.021], [0, 0, 1], new THREE.Color(W), MIRR, 0.15); P.mirror = p; }
  // track lighting: a black rail with four spot heads aimed down (lit lenses), one unit per metre of track
  { const p = new Part(); p.box(0, 0, 0, 1, 0.035, 0.05, 0x141414, { keep: true });
    for (const x of [-0.36, -0.12, 0.12, 0.36]) { p.box(x, -0.09, 0, 0.07, 0.14, 0.07, 0x1a1a1a, { keep: true }); p.box(x, -0.162, 0, 0.055, 0.005, 0.055, 0xfff0d8, { lit: 1.4, keep: true }); }
    P.track = p; }
  P.plinth = new Part().box(0, 0.06, 0, 0.62, 0.12, 0.62, 0xb8b2aa, { keep: true });
  // a wax food sample on its plate (the eatery window case): white plate, the dish (tinted per instance), a price tag
  P.sample = new Part().box(0, 0.012, 0, 0.26, 0.024, 0.26, 0xf4f2ee, { keep: true }).box(0, 0.06, 0, 0.19, 0.075, 0.19, W).box(0.03, 0.1, 0.06, 0.08, 0.03, 0.08, 0xf2e6c0, { keep: true }).box(0, 0.02, 0.15, 0.09, 0.05, 0.005, 0xffffff, { keep: true, lit: 0.3 });
  { const p = new Part(); p.box(0, 0.4, 0, 1.4, 0.8, 0.8, 0xd8d4cc); const FC = [0x3a4a6a, 0xc8c0b0, 0x8a4a44, 0x2a2a2c, 0xe8e4dc, 0x6a7a5a];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) p.box(-0.45 + i * 0.45, 0.86, -0.2 + j * 0.4, 0.36, 0.1 + ((i + j) % 2) * 0.06, 0.3, FC[(i * 2 + j) % FC.length], { keep: true });
    P.foldTable = p; }
  // UFO catcher: coloured body, lit glass box, lit marquee
  // UFO catcher: coloured cabinet, a neutral glass box with the prize pile inside (goods faces), a lit marquee
  { const p = new Part(); p.box(0, 0.45, 0, 0.9, 0.9, 0.9, W).box(0, 1.84, 0, 0.9, 0.08, 0.9, W);
    p.goods = true; p.box(0, 1.07, 0, 0.8, 0.34, 0.8, W, { f: SNACKS, b: SNACKS, keep: true }); p.goods = false;
    p.box(-0.43, 1.35, 0.43, 0.03, 0.9, 0.03, 0xd8dce0, { keep: true }).box(0.43, 1.35, 0.43, 0.03, 0.9, 0.03, 0xd8dce0, { keep: true }).box(-0.43, 1.35, -0.43, 0.03, 0.9, 0.03, 0xd8dce0, { keep: true }).box(0.43, 1.35, -0.43, 0.03, 0.9, 0.03, 0xd8dce0, { keep: true });
    p.box(0, 1.62, 0, 0.1, 0.12, 0.1, 0xc8c8c8, { keep: true }).box(0, 2.02, 0, 0.9, 0.28, 0.9, W, { lit: 0.45 });
    P.crane = p; }
  // capsule-toy tower (2 × 2 machines), slot / pachinko machine, ATM, ticket machine
  { const p = new Part(); for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { p.box(-0.22 + i * 0.44, 0.35 + j * 0.62, 0, 0.42, 0.58, 0.45, W); p.box(-0.22 + i * 0.44, 0.45 + j * 0.62, 0.23, 0.34, 0.3, 0.02, 0xfff4f8, { lit: 0.9 }); } P.capsule = p; }
  P.machine = new Part().box(0, 0.9, 0, 0.62, 1.8, 0.55, W).box(0, 1.25, 0.28, 0.5, 0.62, 0.02, 0xffffff, { lit: 1, f: SNACKS, litF: 1 });
  P.ticket = new Part().box(0, 0.8, 0, 0.62, 1.6, 0.45, 0xd8d8d4).box(0, 1.15, 0.23, 0.5, 0.5, 0.02, 0xf4f8ff, { f: PACKS, litF: 1 });
  // lit boards: menus 1.2 × 0.3 (noodle board / fast-food board), poster pairs 2 × 1.4, hanging POP pairs, noren
  const C1 = new THREE.Color(W);
  const face = (p, x, y, w, h, z, uvr, lit, back = false) => back
    ? p.quad([x + w / 2, y - h / 2, -z], [x - w / 2, y - h / 2, -z], [x - w / 2, y + h / 2, -z], [x + w / 2, y + h / 2, -z], [0, 0, -1], C1, uvr, lit)
    : p.quad([x - w / 2, y - h / 2, z], [x + w / 2, y - h / 2, z], [x + w / 2, y + h / 2, z], [x - w / 2, y + h / 2, z], [0, 0, 1], C1, uvr, lit);
  for (const [k, i, fr] of [['menu', 0, 0x2a2624], ['menuFast', 1, 0xd8d0c0], ['menuCafe', 2, 0x2a2624], ['menuIz', 3, 0x4a3420]]) {
    const p = new Part(); p.box(0, 0, 0, 1.04, 0.54, 0.04, fr); face(p, 0, 0, 1.0, 0.5, 0.021, MENU(i), 0.25); P[k] = p;
  }
  { const p = new Part(); p.box(0, 0, 0, 2.06, 1.1, 0.05, 0x202022); face(p, -0.5, 0, 0.98, 1.02, 0.026, POSTER(0), 0.05); face(p, 0.5, 0, 0.98, 1.02, 0.026, POSTER(1), 0.05); P.posterA = p; }
  { const p = new Part(); p.box(0, 0, 0, 2.06, 1.1, 0.05, 0xe8e8e8); face(p, -0.5, 0, 0.98, 1.02, 0.026, POSTER(2), 0.05); face(p, 0.5, 0, 0.98, 1.02, 0.026, POSTER(3), 0.05); P.posterB = p; }
  // fashion lightboxes: pairs of 0.8 × 1.2 m backlit prints (the scan shoots), thin black frames; four different pairs
  ['lbA', 'lbB', 'lbC', 'lbD'].forEach((k, i) => {
    const p = new Part(); p.box(-0.46, 0, 0, 0.86, 1.26, 0.06, 0x121212, { keep: true }); p.box(0.46, 0, 0, 0.86, 1.26, 0.06, 0x121212, { keep: true });
    face(p, -0.46, 0, 0.8, 1.2, 0.031, FPOST(i * 2), 0.18); face(p, 0.46, 0, 0.8, 1.2, 0.031, FPOST(i * 2 + 1), 0.18);
    P[k] = p;
  });
  for (const [k, i0] of [['pop', 0], ['popB', 4]]) {
    const p = new Part(); p.box(0, 0.2, 0, 0.005, 0.2, 0.005, 0x444444);
    face(p, -0.17, 0, 0.32, 0.32, 0.004, POPC(i0), 0.1); face(p, 0.17, 0, 0.32, 0.32, 0.004, POPC(i0 + 1), 0.1);
    face(p, -0.17, 0, 0.32, 0.32, 0.004, POPC(i0 + 2), 0.1, true); face(p, 0.17, 0, 0.32, 0.32, 0.004, POPC(i0 + 3), 0.1, true);
    P[k] = p;
  }
  P.noren = new Part().box(0, 0, 0, 1, 0.6, 0.01, W, { lit: 0.25 });
  ['catA', 'catB', 'catC', 'catD', 'catE', 'catF', 'catG', 'catH', 'catI', 'catJ', 'catK', 'catL'].forEach((k, i) => { const p = new Part(); p.box(0, 0.3, 0, 0.005, 0.36, 0.005, 0x555555); face(p, 0, 0, 0.9, 0.225, 0.004, CAT(i * 2), 0.12); face(p, 0, 0, 0.9, 0.225, 0.004, CAT(i * 2 + 1), 0.12, true); P[k] = p; });
  { const p = new Part(); p.box(-0.09, 0.45, 0, 0.1, 0.84, 0.1, W); p.box(0.09, 0.45, 0, 0.1, 0.84, 0.1, W);    // mannequin: legs, hips + torso
    p.box(0, 0.95, 0, 0.32, 0.2, 0.2, 0x2e2e36, { keep: true }); p.box(0, 1.3, 0, 0.36, 0.52, 0.21, 0x2e2e36, { keep: true });
    p.box(-0.24, 1.25, 0, 0.08, 0.58, 0.09, W); p.box(0.24, 1.25, 0, 0.08, 0.58, 0.09, W); p.box(0, 1.6, 0, 0.07, 0.1, 0.07, W); p.box(0, 1.74, 0, 0.15, 0.2, 0.17, W);
    p.box(0, 0.02, 0, 0.34, 0.04, 0.34, 0x9a9a9a, { keep: true }); P.mannequin = p; }
  P.lantern = new Part().box(0, 0, 0, 0.3, 0.42, 0.3, W, { lit: 1 });
  // the open kitchen along a counter shop's back wall: stainless line, pots, a hood with its lit underside, tiles
  { const p = new Part(); p.box(0, 0.45, 0, 1, 0.9, 0.7, 0xb8bcc0, { keep: true }).box(0, 0.92, 0, 1.02, 0.04, 0.74, 0xdcdfe2, { keep: true });
    p.box(-0.22, 1.1, 0.05, 0.32, 0.32, 0.32, 0x5a5e62, { keep: true }).box(0.22, 1.06, -0.05, 0.28, 0.24, 0.28, 0x6a6e72, { keep: true });
    p.box(0, 2.15, 0, 1, 0.34, 0.72, 0xa8acb0, { keep: true }).box(0, 1.97, 0.02, 0.92, 0.03, 0.56, 0xfff4e0, { keep: true, lit: 1 });
    p.quad([-0.5, 0.94, -0.349], [0.5, 0.94, -0.349], [0.5, 1.95, -0.349], [-0.5, 1.95, -0.349], [0, 0, 1], new THREE.Color(0xf2f2ee), null, 0.15, 0);
    P.kitchen = p; }
  // the lit liquor wall behind a bar counter
  P.barShelf = shelf(new Part(), 2.1, 0.32, BOTTLES, null, 0x3a281c); P.barShelf.box(0, 2.02, 0.12, 0.96, 0.03, 0.06, 0xffd8a0, { keep: true, lit: 1 });
  P.beam = new Part().box(0, 0, 0, 1, 0.14, 0.16, W);                                         // a ceiling beam (scaled to the room)
  // a lit back wall: a wash quad whose light rises to the ceiling (per-vertex self-light: dark at the fixtures' top)
  { const p = new Part(); p.quad([-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, 0], [-0.5, 1, 0], [0, 0, 1], new THREE.Color(W), null, 0);
    p.lit[p.lit.length - 4] = p.lit[p.lit.length - 3] = -0.3; p.lit[p.lit.length - 2] = p.lit[p.lit.length - 1] = 0.22; P.wash = p; }
  // ---- the Bunkamura stores (MEGA donki / LABY, retailFronts.js): vertex-coloured parts, one draw call per kind
  // the jungle's 2.3 m gondolas (two faces of goods, true-scale), and the overstock piled on top of them / in the wagons:
  // a heap of cartons in the packaging palette, no textures
  P.gondolaTall = shelf(new Part(), 2.3, 0.9, PACKS, SNACKS, 0xe4e4e0);
  P.gondolaTallB = shelf(new Part(), 2.3, 0.9, COSM, BOXES, 0xe4e4e0);
  const PKC = [0xe05a5a, 0x4a86d8, 0xe8c850, 0x50b070, 0xd870b0, 0xf4f4f0, 0xe89040, 0x8a70d0, 0x40b8c8, 0xc83030, 0xffd21e, 0x2a8a4a];
  { const p = new Part(); let sd = 11; const r = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    for (let x = -0.47; x < 0.44;) {
      const w = Math.min(0.47 - x, 0.13 + r() * 0.2); let y = 0;
      for (let l = 0, nL = 1 + Math.floor(r() * 3); l < nL; l++) { const h = 0.12 + r() * 0.18, d = 0.46 + r() * 0.34; p.box(x + w / 2, y + h / 2, (r() - 0.5) * 0.08, w - 0.012, h, d, PKC[Math.floor(r() * PKC.length)], { keep: true, lit: 0.05 }); y += h; }
      x += w;
    }
    P.pile = p; }
  // screens: [upper, lower] colours of a bright picture (sky / field, sunset, sea, anime pastel …)
  const SCR = [[0x6ab8f0, 0x3a9a4a], [0xf0a050, 0x5a3a6a], [0x3aa0d8, 0x1a3a7a], [0x60d0a0, 0x2a6a4a], [0xf06a8a, 0xffd0a0], [0x9a7ae8, 0x2a2a5a], [0xfff0c0, 0xd84a3a], [0x50c8e8, 0xf4f4f0]];
  // TV wall unit, 1 m: three lit screens stacked on a black frame (red price cards under each), a white base cabinet
  const tv = (o) => {
    const p = new Part(); p.box(0, 1.3, -0.02, 1, 2.6, 0.26, 0x24262a, { keep: true });
    [[0.62, 0.5], [1.3, 0.6], [2.1, 0.66]].forEach(([cy, h], j) => {
      const [a, b] = SCR[(j * 3 + o) % SCR.length];
      p.box(0, cy, 0.13, 0.95, h, 0.03, 0x0c0c0e, { keep: true });
      p.box(0, cy + h * 0.2, 0.146, 0.91, h * 0.52, 0.004, a, { keep: true, lit: 1 });
      p.box(0, cy - h * 0.26, 0.146, 0.91, h * 0.4, 0.004, b, { keep: true, lit: 1 });
      p.box(0.3, cy - h / 2 - 0.05, 0.15, 0.22, 0.07, 0.01, 0xd8232e, { keep: true, lit: 0.6 });
    });
    p.box(0, 0.15, 0.1, 1, 0.3, 0.5, W);
    return p;
  };
  P.tvWall = tv(0); P.tvWallB = tv(1);
  // display tables 1.6 × 0.8: laptops open both ways (lit screens) / smartphones on stands, red price cards
  { const p = new Part(); p.box(0, 0.44, 0, 1.5, 0.88, 0.7, W).box(0, 0.9, 0, 1.6, 0.04, 0.8, 0xfafafa, { keep: true });
    [[-0.55, 1], [0, 1], [0.55, 1], [-0.3, -1], [0.3, -1]].forEach(([x, f], i) => {
      p.box(x, 0.93, f * 0.12, 0.34, 0.02, 0.23, 0x9aa0a8, { keep: true });
      p.box(x, 1.04, -f * 0.01, 0.34, 0.22, 0.012, 0x1a1a1c, { keep: true });
      p.box(x, 1.04, f * 0.0, 0.31, 0.19, 0.004, SCR[i % SCR.length][0], { keep: true, lit: 1 });
      p.box(x + 0.1, 0.925, f * 0.34, 0.12, 0.012, 0.07, 0xd8232e, { keep: true, lit: 0.5 });
    });
    P.laptopTable = p; }
  { const p = new Part(); p.box(0, 0.44, 0, 1.5, 0.88, 0.7, W).box(0, 0.9, 0, 1.6, 0.04, 0.8, 0xfafafa, { keep: true });
    for (let i = 0; i < 6; i++) for (const f of [1, -1]) {
      const x = -0.65 + i * 0.26;
      p.box(x, 0.96, f * 0.22, 0.1, 0.08, 0.08, 0xdcdcdc, { keep: true }).box(x, 1.08, f * 0.22, 0.085, 0.17, 0.012, 0x1a1a1c, { keep: true });
      p.box(x, 1.08, f * 0.228, 0.075, 0.15, 0.004, SCR[(i + (f > 0 ? 0 : 3)) % SCR.length][0], { keep: true, lit: 1 });
    }
    P.phoneTable = p; }
  // escalator, local +x rising (35°) from a landing at −x through the ceiling (4.8 m rise): stepped treads with yellow
  // nosings, glass balustrades, black handrails, a silver truss. Every face is built (it reads from both sides).
  { const p = new Part(); p.keep = true;
    const L0 = -3.9, xa = -3.1, xb = 3.3, H = 4.8, hw = 0.55, k = H / (xb - xa);
    const side = (pts, z, n, hex, lit = 0) => { const c = new THREE.Color(hex), q = pts.map(([x, y]) => [x, y, z]); p.quad(q[0], q[1], q[2], q[3], n, c, null, lit); if (q.length > 4) p.quad(q[0], q[3], q[4], q[4], n, c, null, lit); };
    const prism = (pts, z0, z1, hex, lit = 0) => {
      side(pts, z1, [0, 0, 1], hex, lit); side(pts, z0, [0, 0, -1], hex, lit);
      const c = new THREE.Color(hex);
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1; p.quad([a[0], a[1], z1], [a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [ey / l, -ex / l, 0], c, null, lit); }
    };
    // truss (the silver side cladding) and the landing plate
    const tb = xa + 0.95 / k;
    for (const e of [-1, 1]) prism([[xa - 0.3, 0], [tb, 0], [xb, H - 0.95], [xb, H + 0.1], [xa - 0.3, 0.1]], e > 0 ? hw : -hw - 0.1, e > 0 ? hw + 0.1 : -hw, 0xc8ccd2);
    p.box((L0 + xa) / 2, 0.05, 0, xa - L0, 0.1, 2 * hw + 0.2, 0xb8bcc2);
    // treads with a yellow nosing
    const n = 16, sx = (xb - xa) / n;
    for (let i = 0; i < n; i++) { const x = xa + (i + 0.5) * sx, y = (i + 1) * H / n; p.box(x, y - 0.09, 0, sx, 0.18, 2 * hw, 0x3a3c40); p.box(x - sx / 2 + 0.03, y + 0.002, 0, 0.06, 0.004, 2 * hw - 0.04, 0xffd21e, { lit: 0.2 }); }
    // glass balustrades (a pale tint, faintly lit) and the black handrails on them
    for (const e of [-1, 1]) {
      const z = e * (hw + 0.05);
      prism([[L0 + 0.3, 0.1], [xa, 0.1], [xa, 1.0], [L0 + 0.3, 1.0]], z - 0.012, z + 0.012, 0xcfe2ea, 0.12);
      prism([[xa, 0.1], [xb, H + 0.1], [xb, H + 1.0], [xa, 1.0]], z - 0.012, z + 0.012, 0xcfe2ea, 0.12);
      prism([[L0 + 0.2, 1.0], [xa, 1.0], [xa, 1.08], [L0 + 0.2, 1.08]], z - 0.04, z + 0.04, 0x141414);
      prism([[xa, 1.0], [xb, H + 1.0], [xb, H + 1.08], [xa, 1.08]], z - 0.04, z + 0.04, 0x141414);
    }
    P.escalator = p; }
  // floor-standing lit signs (the category on both faces, on a pole)
  for (const [k, i] of [['standM', 0], ['standN', 2]]) {
    const p = new Part(); p.box(0, 0.02, 0, 0.42, 0.04, 0.42, 0x9a9a9a, { keep: true }).box(0, 0.75, 0, 0.04, 1.5, 0.04, 0x9a9a9a, { keep: true }).box(0, 1.6, 0, 0.94, 0.26, 0.03, 0xffffff, { keep: true });
    face(p, 0, 1.6, 0.9, 0.225, 0.016, CAT2(i), 0.2); face(p, 0, 1.6, 0.9, 0.225, 0.016, CAT2(i + 1), 0.2, true);
    P[k] = p;
  }
  ['catM', 'catN', 'catO', 'catP'].forEach((k, i) => { const p = new Part(); p.box(0, 0.3, 0, 0.005, 0.36, 0.005, 0x555555); face(p, 0, 0, 0.9, 0.225, 0.004, CAT2(i * 2), 0.12); face(p, 0, 0, 0.9, 0.225, 0.004, CAT2(i * 2 + 1), 0.12, true); P[k] = p; });
  return P;
}

// ------------------------------------------------------------------------------------------------ materials
// Unlit on purpose: a room is lit by its own ceiling, and the pool's point lights + shadow cascades a lit material pays
// per fragment were a measurable share of the interiors' cost. Shading = a soft up/down + side term, the room's self
// light, and the lit parts (panels, fridges, boards) on top.
const SHADE_VS = `
  vec3 nW = normal;
#ifdef USE_INSTANCING
  nW = mat3(instanceMatrix) * nW;
#endif
  nW = normalize(mat3(modelMatrix) * nW);
  vShade = 0.84 + 0.16 * nW.y - 0.06 * abs(nW.z);
`;
function partMaterial(tex) {
  const U = { uSelf: { value: 0.3 }, uLit: { value: 1.6 }, uTex: { value: 0.3 }, uBase: { value: 0.3 } };
  const m = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true });
  m.name = 'interior:parts';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aLit; attribute float aTint; attribute float aTex; attribute float iFade; varying float vLit; varying float vTex; varying float vShade; varying float vFade;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLit = aLit; vTex = aTex; vFade = iFade;' + SHADE_VS)
      .replace('#include <color_vertex>', '#include <color_vertex>\n  vColor.xyz = mix(color.xyz, vColor.xyz, aTint);');
    // untextured faces skip the atlas (its white texel mips into the spines at grazing angles)
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLit; varying float vTex; varying float vShade; varying float vFade; uniform float uSelf; uniform float uLit; uniform float uTex; uniform float uBase;')
      // the LOD cross-fade: the crowd's dithered fade (interleaved gradient noise), so a room level never pops
      .replace(/void main\(\)\s*\{/, 'void main() {\n  if (vFade < 0.997 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) > vFade) discard;')
      .replace('#include <map_fragment>', '#ifdef USE_MAP\n  if (vTex > 0.5) diffuseColor *= texture2D(map, vMapUv);\n#endif')
      .replace('vec3 outgoingLight = reflectedLight.indirectDiffuse;', 'vec3 outgoingLight = reflectedLight.indirectDiffuse * (uBase * vShade + uSelf + vLit * uLit + step(1.5, vTex) * uTex);');
  };
  m.customProgramCacheKey = () => 'interior-parts-f';
  m.userData.U = U;
  return m;
}
function floorMaterial() {
  const c = L.makeCanvas(256, 256), g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { g.fillStyle = `rgba(0,0,0,${0.03 + L.hash(i, j, 77) * 0.06})`; g.fillRect(i * 64, j * 64, 64, 64); }
  g.fillStyle = 'rgba(0,0,0,0.22)'; for (let k = 0; k <= 4; k++) { g.fillRect(k * 64, 0, 2, 256); g.fillRect(0, k * 64, 256, 2); }
  const t = L.canvasTex(c, { wrap: true, aniso: 8 });
  const U = { uSelf: { value: 0.45 }, uBase: { value: 0.3 } };
  const m = new THREE.MeshBasicMaterial({ map: t, color: 0xffffff });
  m.name = 'interior:floor';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef USE_INSTANCING
  vMapUv = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xz * 0.42;
#else
  vMapUv = (modelMatrix * vec4(position, 1.0)).xz * 0.42;
#endif`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uSelf; uniform float uBase;')
      .replace('vec3 outgoingLight = reflectedLight.indirectDiffuse;', 'vec3 outgoingLight = reflectedLight.indirectDiffuse * (uBase + uSelf);');
  };
  m.customProgramCacheKey = () => 'interior-floor-u';
  m.userData.U = U;
  return m;
}

// ------------------------------------------------------------------------------------------------ layouts
// Local frame of a room: u along the frontage (right, seen from the street), v inward from the glass (0) to the back
// wall (D), y up from the floor. Items: { k, u, v, y, r (local yaw: 0 = faces the street), s: [sx, sy, sz], c }.
// People: { u, v, r, staff, clip }.
function layout(bay, rc, W, D, Hr, rnd) {
  const items = [], people = [];
  const vMin = bay.hallPoly ? -3.4 : -0.2;
  const put = (k, u, v, r = 0, s = [1, 1, 1], c = rc.fix, y = 0) => { if (Math.abs(u) <= W / 2 && v >= vMin && v <= D) items.push({ k, u, v, y, r, s, c }); };
  const man = (u, v, r, clip = 'look', staff = false) => { if (Math.abs(u) < W / 2 - 0.25 && v > vMin + 0.7 && v < D - 0.3) people.push({ u, v, r, clip, staff }); };
  const mannequin = (u, v, r = 0) => { if (Math.abs(u) < W / 2 - 0.3 && v > 0.35 && v < D - 0.4) { put('plinth', u, v, 0, [1, 1, 1], 0xf2f0ec); people.push({ u, v, r, clip: 'idle', staff: false, mq: true }); } };
  const dn = rc.dense || 1, HP = Math.PI / 2;
  const sideShelves = (k, from = 1.0, to = D - 0.6, c = rc.fix, sy = 1) => { for (let v = from + 0.5; v <= to - 0.45; v += 1.0) { put(k, -W / 2 + 0.22, v, HP, [1, sy, 1], c); put(k, W / 2 - 0.22, v, -HP, [1, sy, 1], c); } };
  const backShelves = (k, c = rc.fix, sy = 1) => { for (let u = -W / 2 + 0.5; u <= W / 2 - 0.5; u += 1.0) put(k, u, D - 0.22, 0, [1, sy, 1], c); };
  const panels = (c = rc.light) => { const nx = Math.max(1, Math.round(W / 2.4)), nz = Math.max(1, Math.round(D / 2.2)), cc = hot ? new THREE.Color(c).multiplyScalar(0.62).getHex() : c; for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) put('panel', -W / 2 + (i + 0.5) * W / nx, (j + 0.5) * D / nz, 0, [1, 1, 1], cc, Hr - 0.04); };
  const spots = (n = 6) => { for (let i = 0; i < n; i++) put('spot', (rnd() - 0.5) * (W - 1), 0.8 + rnd() * (D - 1.4), 0, [1, 1, 1], rc.light, Hr - 0.05); };
  let pk = 0;
  const pops = (v0, v1, on = rc.pop) => { if (!on) return; for (let v = v0; v < v1; v += 1.3 / dn) put(pk++ % 2 ? 'popB' : 'pop', (rnd() - 0.5) * (W - 1.2), v, rnd() * 0.6 - 0.3, [1, 1, 1], 0x444444, Hr - 0.55 - rnd() * 0.25); };
  const posters = (k, v = D - 0.05, y = Math.min(2.75, Hr - 0.75)) => { if (Hr < 3.0 || W < 2.4) return; const n = Math.max(1, Math.floor((W - 0.6) / 2.4)); for (let i = 0; i < n; i++) put(k, -((n - 1) * 2.4) / 2 + i * 2.4, v, 0, [1, 1, 1], 0x202022, y); };
  // category boards along the side walls above the shelving (the 2.2–3.3 m band a real shop fills with signage)
  const wallSigns = (keys, from = 1.2) => { if (Hr < 2.7) return; const y = Math.min(2.45, Hr - 0.55); let i = 0; for (let v = from; v <= D - 0.8; v += 1.6, i++) { put(keys[i % keys.length], -W / 2 + 0.06, v, HP, [1.2, 1.2, 1], 0x555555, y); put(keys[(i + 1) % keys.length], W / 2 - 0.06, v, -HP, [1.2, 1.2, 1], 0x555555, y); } };
  // AISLES (pass 14, 「店の中が薄っぺらい」): gondola rows running INWARD from the glass (as in a real konbini / drugstore:
  // from the window you look down the aisles, goods on both faces), from `v0` to `v1`, across u ∈ [uA, uB]; an
  // end-cap faced to the street at each row's window end, a category board and POP over each aisle, shoppers in the
  // aisles turned to the shelves. Returns the aisle centre-lines (u) for the caller's staff / props.
  const aisles = ({ uA, uB, v0 = 1.5, v1 = D - 1.3, k = 'gondola', k2 = null, sy = 1, gap = 1.05, cap = null, signs = ['catA', 'catB'], pop = rc.pop, people = 0 }) => {
    const rowsU = [], ais = [];
    const w0 = 0.9;                                                             // a gondola's depth (across u)
    const n = Math.max(1, Math.floor((uB - uA - gap) / (w0 + gap)));
    const span = n * w0 + (n + 1) * gap, off = uA + ((uB - uA) - span) / 2;
    for (let i = 0; i < n; i++) rowsU.push(off + gap + w0 / 2 + i * (w0 + gap));
    for (let i = 0; i <= n; i++) ais.push(off + gap / 2 + i * (w0 + gap));
    rowsU.forEach((u, i) => {
      const kk = k2 && i % 2 ? k2 : k;
      for (let v = v0 + 0.5; v <= v1 - 0.5 + 1e-6; v += 1.0) put(kk, u, v, HP, [1, sy, 1], rc.fix);
      // the end-cap at the window end: a full-height unit of goods faced to the street (a blank gondola end read as a wall)
      put(cap || (kk === 'gondolaDrug' ? 'wallDrug' : 'wallGoods'), u, v0 - 0.1, 0, [0.92, Math.min(0.85, sy * 0.83), 0.45], rc.fix);
    });
    ais.forEach((u, i) => {
      if (Hr > 2.7) put(signs[i % signs.length], u, v0 + 0.8, 0, [0.9, 0.9, 1], 0x555555, Math.min(2.55, Hr - 0.45));
      if (pop) for (let v = v0 + 1.4; v < v1 - 0.4; v += 1.6 / dn) put(pk++ % 2 ? 'popB' : 'pop', u, v, HP, [0.8, 0.8, 1], 0x444444, Math.min(2.2, Hr - 0.6));
    });
    for (let i = 0; i < people; i++) { const u = ais[(i * 2 + 1) % ais.length]; man(u + (i % 2 ? 0.12 : -0.12), v0 + 0.9 + ((i * 1.7) % Math.max(1, v1 - v0 - 1.6)), i % 2 ? HP : -HP, 'look'); }
    return ais;
  };
  // 2–6 in a small shop, more in a big one (never an empty room); the hall takes its recipe's range
  const nP = () => { const [, hi] = rc.people || [2, 5]; return bay.hallPoly ? hi : Math.max(2, Math.min(Math.round(W * D / 6), Math.max(6, Math.min(hi, 8)))); };
  // a lit back wall: a wash whose light rises to the ceiling behind whatever stands against it
  const hot = (rc.glow ?? 0.6) > 0.78;                                         // a white, brightly lit shop: no extra wash, dimmer panels
  const backWash = (c = rc.light) => { if (!hot) put('wash', 0, D - 0.03, 0, [W, Hr, 1], c, 0); };
  const steam = (u, v) => put('steam', u, v, 0, [1, 1, 1], 0xffffff, 1.6);
  // a display niche (a corner shop squeezed by its neighbour's room to under 2.6 m): a lit back wall full of the
  // trade's goods / boards right behind the glass, POP, a board above — never an empty shallow box
  // ---- MEGA ドン・キホーヂ (the whole frontage, ~10–12 m deep): the discount jungle after the store's own floor —
  // wagons of bargain goods behind the glass, the checkout row by the door with its queue, then narrow aisles between
  // 2.3 m gondolas with overstock piled to the ceiling, fluorescent tubes down every aisle, and the ceiling crammed with
  // hanging POP price cards and category boards
  if (rc.arch === 'donki' && rc.mega && W > 6 && D > 6) {
    const reg = Math.min(4.6, W * 0.3), v0 = 3.0, v1 = D - 0.9;
    backShelves('wallGoods', rc.fix, 1.15); sideShelves('wallGoods', v0 - 0.4, D - 0.6, rc.fix, 1.15);
    for (let u = -W / 2 + 0.9; u <= W / 2 - reg - 0.7; u += 1.45) {
      put('lowGoods', u, 0.8, 0, [1.25, 1, 0.9], 0xd8d2c0); put('pile', u, 0.8, rnd() * 0.3 - 0.15, [1.15, 0.8, 0.85], 0xffffff, 0.9);
      put(pk++ % 2 ? 'popB' : 'pop', u, 0.8, rnd() * 0.4 - 0.2, [1.5, 1.5, 1], 0x444444, 1.95);
    }
    const cu = W / 2 - reg / 2;                                                 // the checkout row by the door, a queue
    put('counter', cu, 1.9, 0, [reg - 0.5, 1, 0.8], rc.accent); put('catO', cu, 1.9, 0, [2.4, 2.4, 1], 0x555555, Math.min(Hr - 0.7, 3.1));
    man(cu - reg / 4, 2.55, Math.PI, 'idle', true); man(cu + reg / 4, 2.55, Math.PI, 'idle', true);
    man(cu - reg / 4, 1.2, 0, 'idle'); man(cu - reg / 4 + 0.2, 0.55, 0.2, 'idle');
    const ais = aisles({ uA: -W / 2 + 0.5, uB: W / 2 - 0.5, v0, v1, k: 'gondolaTall', k2: 'gondolaTallB', sy: 1, gap: 0.95, signs: ['catO', 'catP', 'catB', 'catC', 'catA'], pop: true, people: Math.max(2, nP() - 4) });
    // overstock on every gondola (to ~3 m), the fluorescent tubes down the aisles, a row across the entrance zone
    let gi = 0;
    for (const it of items.slice()) if ((it.k === 'gondolaTall' || it.k === 'gondolaTallB') && (!MOBILE || gi++ % 2 === 0)) put('pile', it.u, it.v, it.r + (rnd() - 0.5) * 0.1, [1, 0.8 + rnd() * 0.5, 1], 0xffffff, 2.3);
    for (const u of ais) put('panel', u, (v0 + v1) / 2, HP, [(v1 - v0) / 1.2, 1, 0.4], rc.light, Hr - 0.1);
    for (let u = -W / 2 + 1.2; u <= W / 2 - 1; u += 2.4) put('panel', u, 1.5, 0, [1.6, 1, 0.4], rc.light, Hr - 0.1);
    // the ceiling jungle: POP cards at every angle, big category boards over the aisles
    for (let v = 2.2; v < D - 0.6; v += 1.1) for (let u = -W / 2 + 0.7; u < W / 2 - 0.5; u += 1.3) if (rnd() < 0.4) put(pk++ % 2 ? 'popB' : 'pop', u + (rnd() - 0.5) * 0.5, v, rnd() * 1.2 - 0.6, [1.05, 1.05, 1], 0x444444, Hr - 0.5 - rnd() * 0.35);
    ais.forEach((u, i) => { if (i % 2) put(['catO', 'catP', 'catB'][i % 3], u, (v0 + v1) / 2 + 1, 0, [2.2, 2.2, 1], 0x555555, Hr - 0.55); });
    return { items, people };
  }
  // ---- LABY 渋谷: a white electronics floor under a bright light grid. 1F: the TV wall across the back, accessory walls,
  // laptop / smartphone display tables in rows with category boards over them, floor signs at the door, the escalator
  // pair rising through the ceiling behind the tables, a service counter. Upper floors (bay.upper, seen from the street
  // through the navy glass): the light grid, display rows and tall shelving, a TV wall on alternate floors.
  if (rc.arch === 'laby') {
    const up = !!bay.upper, fl = bay.floor || 1;
    const nx = Math.max(1, Math.round(W / 1.8)), nz = Math.max(1, Math.round(D / 1.7));
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) put('panel', -W / 2 + (i + 0.5) * W / nx, (j + 0.5) * D / nz, 0, [1, 1, 1], rc.light, Hr - 0.04);
    let ti = fl;
    const tvBack = () => { for (let u = -W / 2 + 0.5; u <= W / 2 - 0.5 + 1e-6; u += 1.0) put(ti++ % 3 ? 'tvWall' : 'tvWallB', u, D - 0.18, 0, [1, Math.min(1, (Hr - 0.3) / 2.6), 1], rc.fix); };
    if (!up) {
      tvBack(); sideShelves('wallGoods', 1.4, D - 0.8, rc.fix, 1);
      const esc = W >= 10 && D >= 7, eu = -W / 2 + 4.6;
      if (esc) { put('escalator', eu, D - 3.1, 0, [1, 1, 1], 0xc8ccd2); put('escalator', eu, D - 1.75, Math.PI, [1, 1, 1], 0xc8ccd2); }
      const vMax = esc ? D - 4.3 : D - 1.7;
      let r = 0;
      for (let v = 1.7; v <= vMax; v += 1.9, r++) {
        let c = 0;
        for (let u = -W / 2 + 1.6; u <= W / 2 - 1.4; u += 2.5, c++) {
          put((r + c) % 2 ? 'phoneTable' : 'laptopTable', u, v, 0, [1, 1, 1], rc.fix);
          if (c % 2 === 0) put(r % 2 ? 'catN' : 'catM', u, v, 0, [1.3, 1.3, 1], 0x555555, Math.min(Hr - 0.55, 3.2));
          if ((r * 3 + c) % 4 === 1) man(u + 0.3, v - 0.7, 0, 'look');
          if ((r * 3 + c) % 5 === 2) man(u - 0.4, v + 0.7, Math.PI, 'look');
        }
      }
      if (esc) put('catM', eu, D - 2.4, 0, [2, 2, 1], 0x555555, Math.min(Hr - 0.5, 3.4));
      put('standM', -W / 2 + 1.0, 0.7, 0.35, [1, 1, 1], 0xffffff); put('standN', W / 2 - 1.0, 0.7, -0.35, [1, 1, 1], 0xffffff);
      put('glassCounter', W / 2 - 0.9, D - 3.4, -HP, [2.2, 1, 1], rc.fix); man(W / 2 - 0.35, D - 3.4, -HP, 'idle', true);
      pops(1.2, D - 1.5);
    } else {
      // the upper floors: seen from below, so what reads is the lit ceiling, tall shelving and the TV walls
      if (fl % 2 === 0) tvBack(); else backShelves('gondolaTall', rc.fix, 1);
      for (let v = 1.4, r = 0; v <= D - 1.6; v += 2.2, r++) for (let u = -W / 2 + 1.4 + (r % 2) * 1.2; u <= W / 2 - 1.2; u += 2.6) put(fl % 3 === 1 ? 'gondolaTallB' : (r + fl) % 2 ? 'phoneTable' : 'laptopTable', u, v, fl % 3 === 1 ? HP : 0, [1, 1, 1], rc.fix);
      if (fl <= 3 && W > 6) man(0.4, 1.0, 0, 'look');
    }
    return { items, people };
  }
  if (D < 2.6) {
    panels(); backWash();
    const eat = /ramen|cafe|fast|izakaya/.test(rc.arch), A = rc.arch;
    const k = A === 'books' ? 'wallBooks' : A === 'shoes' ? 'shoeWall' : (A === 'fashion' || A === 'dept' || A === 'boutique') ? 'wallRail' : A === 'drug' ? 'wallDrug' : A === 'konbini' ? 'fridge' : 'wallGoods';
    if (eat) { for (let u = -W / 2 + 0.55; u <= W / 2 - 0.5; u += 1.06) put(A === 'izakaya' ? 'menuIz' : A === 'ramen' ? 'menu' : A === 'fast' ? 'menuFast' : 'menuCafe', u, D - 0.05, 0, [1, 1, 1], 0x2a2624, Math.min(1.9, Hr - 0.9)); put('counter', 0, D - 0.45, 0, [Math.max(1, W - 0.6), 1, 0.6], rc.fix); man(0, D - 0.12, Math.PI, 'idle', true); }
    else if (A === 'bank' || A === 'pachi') { for (let u = -W / 2 + 0.45; u <= W / 2 - 0.4; u += 0.7) put('machine', u, D - 0.32, 0, [1, A === 'bank' ? 0.85 : 1, 1], A === 'bank' ? 0xd0d4dc : rc.fix); if (A === 'bank') man(0, 0.55, Math.PI, 'idle'); }
    else if (A === 'game' || A === 'capsule') { for (let u = -W / 2 + 0.5; u <= W / 2 - 0.5 + 1e-6; u += 1.0) put(A === 'game' ? 'crane' : 'capsule', u, D - 0.5, 0, [1, 1, 1], [0xff4ec0, 0x4aa0e8, 0xffd400, 0x50d080][Math.round(u + 9) % 4]); }
    else if (A === 'karaoke' || A === 'phone') { for (let u = -W / 2 + 0.55; u <= W / 2 - 0.5; u += 1.06) put('menuFast', u, D - 0.05, 0, [1, 1, 1], 0xd8d0c0, Math.min(1.9, Hr - 0.9)); put(A === 'phone' ? 'glassCounter' : 'counter', 0, D - 0.5, 0, [Math.max(1, W - 0.8), 1, 0.6], rc.accent); man(0, D - 0.12, Math.PI, 'idle', true); }
    else for (let u = -W / 2 + 0.5; u <= W / 2 - 0.5 + 1e-6; u += 1.0) put(k, u, D - (k === 'fridge' ? 0.36 : 0.22), 0, [1, Math.min(1, (Hr - 0.4) / 2.2) + 0.001, 1], rc.fix);
    if (Hr > 2.8 && !/bank|pachi|game|capsule|karaoke|phone/.test(A)) put(eat ? 'catK' : A === 'books' ? 'catE' : 'catA', 0, D - 0.06, 0, [1.3, 1.3, 1], 0x555555, Math.min(Hr - 0.4, 2.7));
    if (A !== 'bank') pops(0.4, D - 0.2, true);
    return { items, people };
  }
  switch (rc.arch) {
    case 'books': {
      // rows parallel to the glass, stepping up toward the back (low new-release tables in front, 1.65 m rows rising to
      // 2.1 m, 2.2–2.5 m perimeter shelves), each row broken by aisles, spines to the street, section signs over them
      const hall = !!bay.hallPoly;
      panels(); spots(Math.round(W * D / (hall ? 6 : 12))); backWash();
      backShelves('wallBooks', rc.fix, hall ? 1.15 : 1); sideShelves('wallBooks', 1.6, D - 0.6, rc.fix, hall ? 1.15 : 1);
      if (hall) { const nx = Math.round(W / 1.7), nz = Math.round(D / 1.8); for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) put('panel', -W / 2 + (i + 0.5) * W / nx, (j + 0.5) * D / nz, HP, [1, 1, 1], rc.light, Hr - 0.1); }
      // the coffee bar: on a hall at the drum's east end (where the client's corner looks in), else by the side wall
      const cb = rc.cafe && W > 5 ? { u: hall ? W / 2 - 2.3 : -W / 2 + 1.4, v: hall ? 0.9 : 1.0 } : null;
      const v0 = hall ? 1.7 : 1.9, dv = 2.1 / Math.min(1.25, dn), rows = [];
      for (let v = v0; v <= D - 1.4; v += dv) rows.push(v);
      const gaps = W > 9 ? [-W / 4, 0, W / 4] : W > 4.5 ? [0] : [];
      rows.forEach((v, ri) => {
        const sy = 0.78 + 0.22 * (rows.length > 1 ? ri / (rows.length - 1) : 1);
        if (Hr > 2.9) (gaps.length ? gaps : [0]).forEach((g, gi) => put(['catE', 'catF', 'catG', 'catH'][(ri + gi) % 4], g + (gaps.length ? 1.3 : 0), v - 0.2, 0, [1, 1, 1], 0x555555, Math.min(2.85, Hr - 0.45)));
        for (let u = -W / 2 + 0.9; u <= W / 2 - 0.9 + 1e-6; u += 1.0) {
          if (gaps.some((g) => Math.abs(u - g) < 0.7)) continue;
          if (cb && Math.abs(u - cb.u) < 1.9 && v < cb.v + 2.2) continue;
          put('bookshelf', u, v, 0, [1, sy, 1], rc.fix);
        }
      });
      if (W > 3.5 && !hall) put('foldTable', gaps.length ? W / 4 : 0, 1.0, 0, [0.9, 1, 0.8], rc.fix);
      const cu = hall ? -W / 2 + 1.2 : W / 2 - 0.7;
      put('counter', cu, 1.1, hall ? HP : -HP, [1.6, 1, 1], rc.fix);
      man(cu + (hall ? -0.5 : 0.5), 1.1, hall ? HP : -HP, 'idle', true);
      if (hall) {                                                               // the drum's forecourt: new-release tables, browsers
        for (const u of [-4.2, 0, 4.2 - 1.2]) { put('foldTable', u, -1.4, 0, [1, 1, 0.9], rc.fix); put(u ? 'pop' : 'popB', u, -1.4, 0, [1.2, 1.2, 1], 0x444444, 1.3); }
        man(-2.1, -1.3, -HP, 'look'); man(1.5, -1.7, HP, 'look'); man(-5.4, -1.0, Math.PI * 0.8, 'look'); man(0.4, -0.9, Math.PI, 'look');
      }
      if (cb) {                                                                 // counter + back bar + lit boards facing the street, a queue
        put('counter', cb.u, cb.v, 0, [2.4, 1, 1], rc.accent); put('kitchen', cb.u - 0.6, cb.v + 1.0, 0, [1, 1, 0.8], 0xb8bcc0); put('kitchen', cb.u + 0.5, cb.v + 1.0, 0, [1, 1, 0.8], 0xb8bcc0);
        put('menuCafe', cb.u - 0.55, cb.v + 1.35, 0, [1, 1, 1], 0x2a2624, 2.45); put('menuCafe', cb.u + 0.55, cb.v + 1.35, 0, [1, 1, 1], 0x2a2624, 2.45);
        man(cb.u - 0.4, cb.v + 0.55, 0, 'idle', true); man(cb.u + 0.5, cb.v + 0.6, 0.3, 'idle', true);
        for (let i = 0; i < 3; i++) man(cb.u - 0.2 + i * 0.15, cb.v - 0.75 - i * 0.65, Math.PI, 'idle');
      }
      // readers in the aisles: facing the row behind them (back to the street) or the back of the row in front
      for (let i = 0; i < nP(); i++) {
        const ri = i % Math.max(1, rows.length), v = rows.length ? rows[ri] - 0.85 : 1.5 + i;
        let u = (rnd() - 0.5) * (W - 2.4); if (cb && Math.abs(u - cb.u) < 2 && v < cb.v + 2.2) u = -u;
        man(u, v, (i % 3) ? Math.PI : 0, 'look');
      }
      break;
    }
    case 'konbini': {
      // flat white light; the drinks fridge wall at the back, gondola AISLES running in from the window to it, the
      // magazine rack along the window, the register counter by the door with the hot-snack case and its board, a
      // queue at it
      panels(); backWash(); for (let u = -W / 2 + 0.5; u <= W / 2 - 0.5; u += 1.0) put('fridge', u, D - 0.38, 0, [1, 1, 1], 0xc8ccd0);
      for (let v = 1.3; v <= D - 1.2; v += 1.0) put('wallGoods', -W / 2 + 0.24, v, HP, [1, 0.9, 1], rc.fix);
      wallSigns(['catA', 'catB', 'catD']);
      const reg = W > 4.2 ? 1.9 : 0;                                           // the register zone on the door side
      aisles({ uA: -W / 2 + 0.5, uB: W / 2 - reg, v0: 1.25, v1: D - 1.1, k: 'gondola', k2: 'gondolaDrug', signs: ['catA', 'catB', 'catD'], pop: null, people: Math.max(1, nP() - 2) });
      for (let u = -W / 2 + 0.6; u <= W / 2 - reg - 0.5; u += 1.0) put('magRack', u, 0.3, 0, [1, 1, 0.8], rc.fix);
      if (reg) {
        put('counter', W / 2 - 0.55, 1.9, -HP, [2.6, 1, 1], rc.accent); put('glassCounter', W / 2 - 0.55, 0.5, -HP, [0.9, 1.05, 1], 0xffe8c0);
        put('menuFast', W / 2 - 0.05, 1.9, -HP, [1.2, 1.2, 1], 0xd8d0c0, Hr - 0.7);
        man(W / 2 - 0.12, 1.9, -HP, 'idle', true); man(W / 2 - 1.35, 1.7, HP, 'idle'); man(W / 2 - 1.4, 2.6, HP + 0.3, 'idle');
      } else { put('counter', 0, D - 1.3, 0, [Math.max(1, W - 1.4), 1, 0.8], rc.accent); man(0, D - 0.9, Math.PI, 'idle', true); }
      break;
    }
    case 'drug': case 'donki': {
      // drugstore: bright, tall gondolas in AISLES from the window to the back wall (cosmetics / boxes faces, yellow
      // price rails), wall shelving both sides, POP hanging down every aisle, bargain bins at the window, the counter
      // at the back; the discount jungle: taller, tighter aisles, POP everywhere
      const don = rc.arch === 'donki';
      panels(); backWash(); backShelves(don ? 'wallGoods' : 'wallDrug', rc.fix, don ? 1.2 : 1); sideShelves(don ? 'wallGoods' : 'wallDrug', 1.2, D - 0.6, rc.fix, don ? 1.15 : 1);
      if (!don) posters('posterB');
      wallSigns(don ? ['catA', 'catB', 'catC', 'catD'] : ['catC', 'catA']);
      aisles({ uA: -W / 2 + 0.45, uB: W / 2 - 0.45, v0: 1.3, v1: D - (don ? 1.0 : 1.9), k: don ? 'gondola' : 'gondolaDrug', k2: don ? 'gondolaDrug' : null, sy: don ? 1.35 : 1.15, gap: don ? 0.95 : 1.1,
        signs: don ? ['catA', 'catB', 'catC'] : ['catC', 'catA'], pop: true, people: nP() });
      if (don) pops(0.8, D - 0.4);
      if (!don) put('counter', W / 2 - 1.0, D - 0.95, 0, [1.6, 1, 1], rc.accent);
      man(W / 2 - 1.0, D - 0.45, Math.PI, 'idle', true);
      break;
    }
    case 'fashion': case 'shoes': case 'boutique': case 'dept': {
      // a fashion floor at real density: warm track spots with pools of light (few panels), dressed mannequins in the
      // window, lightboxes of the season's shoot, garments face-out along the walls, rails and folded-stock tables on the
      // floor with an aisle, a SHOES side (shoe wall) and an ACCESSORY side (lit cases), mirrors, the cash desk + staff
      const A = rc.arch, dept = A === 'dept', shoes = A === 'shoes', bout = A === 'boutique';
      const seed = Math.abs(Math.round(bay.x * 7 + bay.z * 3));
      const LB = ['lbA', 'lbB', 'lbC', 'lbD'], lb = (k) => LB[(seed + k) % 4];
      panels(new THREE.Color(rc.light).multiplyScalar(0.45).getHex());
      for (let v = 0.9; v <= D - 0.5; v += 1.5) { put('track', 0, v, 0, [Math.max(1, W - 0.8), 1, 1], 0x141414, Hr - 0.06); for (let u = -W / 2 + 1.0; u <= W / 2 - 1.0 + 1e-6; u += Math.max(1.4, (W - 2) / 3)) put('pool', u, v + 0.2, 0, [1.3, 1, 1.3], 0x3a2c1c, 0.03); }
      backWash(0xfff0dc);
      // back wall: lightboxes above, face-out rails (or shoes / cases) below
      const top = Math.min(Hr - 0.75, 2.75);
      if (Hr > 2.9) for (let u = -W / 2 + 1.1, k = 0; u <= W / 2 - 1.0; u += 2.3, k++) put(lb(k), u, D - 0.07, 0, [1, 1, 1], 0x121212, top);
      const backK = shoes ? 'shoeWall' : dept ? 'accCase' : bout ? 'accCase' : 'wallRail';
      for (let u = -W / 2 + 0.5; u <= W / 2 - 0.5 + 1e-6; u += 1.0) put(backK, u, D - (backK === 'accCase' ? 0.3 : 0.2), 0, [1, backK === 'wallRail' || backK === 'shoeWall' ? Math.min(1, (Hr - 1.5) / 2.2) + 0.001 : 1, 1], rc.fix);
      // side walls: left = apparel face-out (dept: cosmetics wall), right = SHOES then ACCESSORY; a mirror on each side
      const half = D / 2;
      for (let v = 1.0; v <= D - 0.9; v += 1.0) {
        const lk = shoes ? 'shoeWall' : dept ? 'wallDrug' : bout ? 'accCase' : 'wallRail';
        const rk = shoes ? 'shoeWall' : bout ? 'accCase' : v < half ? 'accCase' : 'shoeWall';
        if (Math.abs(v - half - 0.5) < 0.5) { put('mirror', -W / 2 + 0.05, v, HP, [1, 1, 1], 0x1a1a1c); continue; }
        put(lk, -W / 2 + (lk === 'accCase' ? 0.3 : 0.2), v, HP, [1, lk === 'wallRail' || lk === 'shoeWall' ? Math.min(1, (Hr - 1.5) / 2.2) + 0.001 : 1, 1], rc.fix);
        put(rk, W / 2 - (rk === 'accCase' ? 0.3 : 0.2), v, -HP, [1, rk === 'shoeWall' ? Math.min(1, (Hr - 1.5) / 2.2) + 0.001 : 1, 1], rc.fix);
      }
      if (Hr > 2.8) {                                                           // section boards over the side walls
        const y = Math.min(2.5, Hr - 0.5);
        put(dept ? 'catJ' : shoes ? 'catK' : 'catI', -W / 2 + 0.06, D * 0.35, HP, [1.2, 1.2, 1], 0x555555, y);
        if (!shoes && !bout) { put('catK', W / 2 - 0.06, D * 0.28, -HP, [1.2, 1.2, 1], 0x555555, y); put('catL', W / 2 - 0.06, D * 0.72, -HP, [1.2, 1.2, 1], 0x555555, y); }
        if (!bout) put(dept ? 'catI' : 'catJ', 0, D - 0.1, 0, [1.3, 1.3, 1], 0x555555, Math.min(Hr - 0.35, top + 0.85));
      }
      // floor: two columns (rails / tables / counters / shoe benches) either side of a centre aisle, to the back
      const cols = W > 5.6 ? [-W / 4 - 0.1, W / 4 + 0.1] : W > 3.6 ? [0] : [];
      let n = 0;
      for (let v = 1.8; v <= D - 1.6; v += 1.7 / Math.max(0.8, dn), n++) for (const [ci, u] of cols.entries()) {
        const k = (n + ci) % 3;
        if (dept) put(k === 2 ? 'accCase' : 'cosmCounter', u, v, 0, [k === 2 ? 1 : 1.4, 1, 1], rc.fix);
        else if (shoes) put(k === 1 ? 'sofa' : 'lowGoods', u, v, 0, k === 1 ? [0.6, 0.8, 0.55] : [1.2, 0.55, 0.7], k === 1 ? rc.accent : rc.fix);
        else if (bout) put(k === 1 ? 'foldTable' : 'accCase', u, v, 0, [1, 1, 1], rc.fix);
        else put(k === 1 ? 'foldTable' : k === 0 ? 'rail' : 'railB', u, v, k === 1 ? 0 : HP, [1, 1, 1], rc.fix);
      }
      // window: dressed mannequins facing the street (real scans on plinths, held still)
      const nm = W > 6 ? 3 : W > 3.4 ? 2 : 1;
      for (let i = 0; i < nm; i++) mannequin(-W / 2 + (i + 0.5) * W / nm + (i % 2 ? 0.2 : -0.2), 0.8 + (i % 2) * 0.35, (i - (nm - 1) / 2) * 0.35);
      // the cash desk at the back corner with its staff; staff on the floor; shoppers browsing
      put('counter', W / 2 - 0.9, D - 1.25, 0, [1.4, 1, 1], rc.fix === 0xffffff ? rc.accent : rc.fix);
      man(W / 2 - 0.9, D - 0.75, Math.PI, 'idle', true);
      if (dept) for (const u of cols) man(u + 0.2, 2.35, Math.PI, 'idle', true); else man(-W / 2 + 1.1, D * 0.6, HP, 'idle', true);
      for (let i = 0; i < nP(); i++) {
        const side = i % 3, v = 1.5 + ((i * 1.37) % Math.max(1, D - 2.8));
        const u = side === 0 ? -W / 2 + 0.95 : side === 1 ? W / 2 - 0.95 : (cols.length ? (i % 2 ? 0.05 : -0.05) : 0);
        man(u, v, side === 0 ? -HP : side === 1 ? HP : (i % 2 ? Math.PI : 0), 'look');
      }
      break;
    }
    case 'cafe': case 'fast': {
      // the order counter at the back under lit boards, a queue at it, two-seat tables toward the window
      const fast = rc.arch === 'fast', mk = fast ? 'menuFast' : 'menuCafe';
      panels(fast ? rc.light : 0xffc890); if (!fast) spots(Math.round(W * D / 10)); backWash(fast ? rc.light : 0xffc890);
      put('counter', 0, D - 0.9, 0, [Math.max(1, W - 1.4), 1, 1], rc.fix);
      const nm = Math.max(1, Math.min(4, Math.round((W - 1.4) / 1.1)));
      for (let i = 0; i < nm; i++) put(mk, -((nm - 1) * 1.08) / 2 + i * 1.08, D - 0.08, 0, [1, 1, 1], 0x2a2624, Math.min(2.45, Hr - 0.6));
      for (let u = -W / 2 + 1.0; u <= W / 2 - 1.0; u += 1.8) for (let v = 1.2; v <= D - 2.4; v += 1.8) { put('table', u, v, 0, [1, 1, 1], rc.accent); put('stool', u - 0.55, v, 0, [1, 1, 1], rc.fix); put('stool', u + 0.55, v, 0, [1, 1, 1], rc.fix); }
      if (!fast) posters('posterB', 0.02, Hr - 0.7); 
      man(0, D - 0.35, Math.PI, 'idle', true);
      for (let i = 0; i < Math.min(3, nP()); i++) man(-0.6 + i * 0.1, D - 1.75 - i * 0.7, 0, 'idle');
      for (let i = 3; i < nP(); i++) man(-W / 2 + 1.0 + ((i * 1.8) % Math.max(1.8, W - 2)) + 0.4, 1.2 + ((i * 1.8) % Math.max(1.8, D - 3)), HP, 'idle');
      break;
    }
    case 'ramen': {
      // a counter shop: the open kitchen along the back wall (hood lights, pots, steam, staff at the line), the serving
      // counter in front of it with stools and people eating, backs to the street; a narrow lot adds a side counter, a
      // wide one fills the floor with tables; the ticket machine by the door, noodle boards over the kitchen and along
      // the walls, a short noren inside the door, lanterns in the window
      panels(rc.light); backWash();
      const kv = D - 0.36;
      for (let u = -W / 2 + 0.5; u <= W / 2 - 0.5 + 1e-6; u += 1.0) put('kitchen', u, kv, 0, [1, 1, 1], 0xb8bcc0);
      for (let u = -W / 2 + 0.7; u <= W / 2 - 0.6; u += 1.2) steam(u, kv);
      const cv = D - 1.6, cw = Math.max(1, W - 1.2), ns = Math.max(2, Math.floor(cw / 0.62));
      put('counter', 0, cv, 0, [cw, 1, 0.75], rc.fix);
      const nm = Math.max(1, Math.min(5, Math.floor((W - 0.4) / 1.06)));
      for (let i = 0; i < nm; i++) put('menu', -((nm - 1) * 1.06) / 2 + i * 1.06, D - 0.05, 0, [1, 1, 1], 0x2a2624, Math.min(2.5, Hr - 0.5));
      for (let i = 0; i < ns; i++) put('stool', -cw / 2 + 0.31 + i * cw / ns, cv - 0.62, 0, [1, 1, 1], rc.accent);
      man(-W / 4, D - 1.0, 0, 'idle', true); if (W > 3.4) man(W / 4, D - 1.0, 0.2, 'idle', true);
      let n = nP();
      for (let i = 0; i < ns && n > 0; i += 2, n--) man(-cw / 2 + 0.31 + i * cw / ns, cv - 0.66, Math.PI, 'idle');
      const free = cv - 1.3;                                                    // floor between the door and the stools
      if (W < 4.6) {                                                            // side counter along the left wall
        for (let v = 1.3; v <= free; v += 1.0) put('counter', -W / 2 + 0.4, v, HP, [1, 1, 0.55], rc.fix);
        for (let v = 1.4; v <= free; v += 0.7) { put('stool', -W / 2 + 0.95, v, 0, [1, 1, 1], rc.accent); if (n-- > 0) man(-W / 2 + 1.0, v, -HP, 'idle'); }
      } else for (let v = free; v >= 1.4; v -= 2.2) for (let u = -W / 2 + 1.1; u <= W / 2 - 1.8; u += 2.4) {
        put('table', u, v, 0, [1, 1, 0.8], rc.fix); put('stool', u - 0.55, v, 0, [1, 1, 1], rc.accent); put('stool', u + 0.55, v, 0, [1, 1, 1], rc.accent);
        if (n-- > 0) man(u - 0.6, v, -HP, 'idle'); if (n-- > 0) man(u + 0.6, v, HP, 'idle');
      }
      for (let v = 1.4; v < D - 2.2; v += 1.15) { put('menu', -W / 2 + 0.03, v, HP, [1, 1, 1], 0x2a2624, Hr - 0.7); put('menu', W / 2 - 0.03, v + 0.5, -HP, [1, 1, 1], 0x2a2624, Hr - 0.7); }
      put('ticket', W / 2 - 0.45, 0.55, -HP, [1, 1, 1], 0xd8d8d4); man(W / 2 - 1.05, 0.62, HP, 'idle');
      put('noren', W / 4, 0.25, 0, [Math.min(1.5, W / 2), 0.75, 1], rc.accent, Hr - 0.3);
      for (const u of [-W / 2 + 0.6, W / 2 - 0.6]) put('lantern', u, 0.35, 0, [1, 1, 1], 0xd83a2a, Hr - 0.55);
      break;
    }
    case 'izakaya': {
      // wood and warm low light: the bar counter at the back in front of a lit bottle wall (staff), drinkers on its
      // stools; tables of groups filling the floor under beams and lanterns; slat menus along the walls
      const bar = rc.ref === 'bar';
      panels(rc.light); backWash(rc.accent);
      for (let u = -W / 2 + 0.5; u <= W / 2 - 0.5 + 1e-6; u += 1.0) put('barShelf', u, D - 0.18, 0, [1, 1, 1], rc.fix);
      const cv = D - 1.45, cw = Math.max(1, W - 1.0);
      put('counter', 0, cv, 0, [cw, 1.1, 0.7], rc.fix);
      man(-W / 5, D - 0.75, 0, 'idle', true); if (W > 3.6) man(W / 4, D - 0.75, 0.3, 'idle', true);
      let n = nP();
      for (let u = -cw / 2 + 0.4; u <= cw / 2 - 0.3; u += 0.62) { put('stool', u, cv - 0.6, 0, [1, bar ? 1.25 : 1, 1], rc.accent); if (n > 0 && ((u * 10) | 0) % 2 === 0) { man(u, cv - 0.64, Math.PI, 'idle'); n--; } }
      for (let u = -W / 2 + 1.0; u <= W / 2 - 1.0; u += 1.9) for (let v = 1.2; v <= cv - 1.6; v += 1.7) {
        put('table', u, v, 0, [1.2, 1, 1], rc.fix); put('stool', u - 0.6, v, 0, [1, 1, 1], rc.fix); put('stool', u + 0.6, v, 0, [1, 1, 1], rc.fix);
        if (n-- > 0) man(u - 0.62, v, -HP, 'idle'); if (n-- > 0) man(u + 0.62, v, HP, 'idle');
        put('lantern', u, v, 0, [0.8, 0.8, 0.8], bar ? rc.accent : (rc.pop || 0xd8602e), Hr - 0.7);
      }
      for (let v = 0.9; v < D - 0.6; v += 1.15) put('beam', 0, v, 0, [W, 1, 1], 0x2a1c12, Hr - 0.1);
      for (let v = 1.3; v < cv - 0.4; v += 1.1) { put('menuIz', -W / 2 + 0.03, v, HP, [1, 1, 1], 0x4a3420, Math.min(2.2, Hr - 0.7)); put('menuIz', W / 2 - 0.03, v + 0.5, -HP, [1, 1, 1], 0x4a3420, Math.min(2.2, Hr - 0.7)); }
      if (!bar) put('noren', 0, 0.25, 0, [Math.min(1.6, W - 1), 0.75, 1], 0x1a3a8a, Hr - 0.3);
      break;
    }
    case 'game': case 'capsule': {
      // cold bright light over rows of coloured machines to the back wall, a prize / capsule wall lit behind them,
      // players at the machines, POP over the aisles
      panels(rc.light); backWash(rc.accent);
      const k = rc.arch === 'game' ? 'crane' : 'capsule', CC = [0xff4ec0, 0x4aa0e8, 0xffd400, 0x50d080, 0xff8a30];
      let c = 0, n = nP();
      for (let u = -W / 2 + 0.5; u <= W / 2 - 0.5 + 1e-6; u += 1.0) put('capsule', u, D - 0.3, 0, [1, 1.2, 1], CC[(c + 2) % CC.length]);
      for (let v = 1.3; v <= D - 1.5; v += (k === 'crane' ? 2.1 : 1.6) / dn) for (let u = -W / 2 + 0.7; u <= W / 2 - 0.7; u += 1.0) {
        put(k, u, v, 0, [1, 1, 1], CC[c++ % CC.length]);
        if (n > 0 && c % 2) { man(u + 0.1, v - 0.78, Math.PI, 'look'); n--; }
      }
      pops(1.0, D - 0.5, true); pops(1.6, D - 0.8, true);
      break;
    }
    case 'karaoke': case 'pachi': case 'bank': case 'phone': case 'generic': default: {
      panels(rc.light); backWash();
      let n = nP();
      if (rc.arch === 'pachi') { for (let v = 2.1; v <= D - 0.8; v += 1.9) for (let u = -W / 2 + 0.6; u <= W / 2 - 0.6; u += 0.7) { put('machine', u, v, 0, [1, 1, 1], rc.fix); put('stool', u, v - 0.62, 0, [1, 1, 1], rc.accent); if (n-- > 0 && ((u * 10) | 0) % 3) man(u, v - 0.66, Math.PI, 'idle'); } pops(1, D - 1); }   // lit machine faces to the street, players' backs to the window
      else if (rc.arch === 'karaoke') {
        put('counter', 0, D - 1.0, 0, [Math.max(1, W - 2), 1, 1], rc.fix); man(-0.4, D - 0.5, Math.PI, 'idle', true); man(0.6, D - 0.5, Math.PI, 'idle', true);
        for (let v = 1.4; v <= D - 1.8; v += 2.2) { put('sofa', -W / 2 + 1.1, v, HP, [1, 1, 1], rc.accent); if (n-- > 0) man(-W / 2 + 1.0, v - 0.4, HP, 'idle'); if (n-- > 0) man(-W / 2 + 1.0, v + 0.4, HP, 'idle'); }
        for (let v = 1.2; v < D - 0.5; v += 1.2) put('menuFast', W / 2 - 0.03, v, -HP, [1, 1, 1], 0xd8d0c0, 1.7);
        posters('posterB', D - 0.05, Hr - 0.7); pops(1, D - 1, true);
        for (let i = 0; n > 0 && i < 3; i++, n--) man(-0.3 + i * 0.5, D - 1.8 - i * 0.2, Math.PI, 'idle');
      } else if (rc.arch === 'bank') {
        put('counter', 0, D - 1.2, 0, [Math.max(1, W - 1.2), 1.1, 1], rc.fix); for (let u = -W / 2 + 1; u < W / 2 - 0.6; u += 1.4) man(u, D - 0.7, Math.PI, 'idle', true);
        for (let v = 1.2; v < D - 2; v += 0.9) { put('machine', -W / 2 + 0.4, v, HP, [1, 0.85, 1], 0xd0d4dc); if (n-- > 0) man(-W / 2 + 1.05, v, -HP, 'idle'); }
        put('sofa', W / 4, 1.8, Math.PI, [0.8, 1, 1], rc.accent); for (let i = 0; n > 0 && i < 3; i++, n--) man(W / 4 - 0.5 + i * 0.5, 2.1, 0, 'idle');
      } else if (rc.arch === 'phone') {
        sideShelves('wallGoods', 1.0); put('counter', 0, D - 0.6, 0, [Math.max(1, W - 1.6), 1, 1], rc.accent); posters('posterB', D - 0.05, Hr - 0.7); wallSigns(['catA', 'catD']);
        for (let v = 1.6; v <= D - 1.4; v += 2.0) { put('glassCounter', 0, v, 0, [Math.max(1, W - 2.4), 1, 1], rc.fix); man(-0.5, v + 0.6, Math.PI, 'idle', true); if (n-- > 0) man(-0.4, v - 0.62, 0, 'look'); if (n-- > 0) man(0.6, v - 0.62, 0, 'look'); }
      } else {
        // an unknown trade gets the busiest general store, never an empty room: gondolas to the back wall, wall goods,
        // bins at the window, category signs, POP, a register and staff
        backShelves('wallGoods'); sideShelves('wallGoods', 1.0); posters('posterB', D - 0.05, Hr - 0.7); wallSigns(['catA', 'catD', 'catB']);
        aisles({ uA: -W / 2 + 0.45, uB: W / 2 - 0.45, v0: 1.3, v1: D - 1.9, k: 'gondola', k2: 'gondolaDrug', signs: ['catA', 'catB', 'catD'], pop: true, people: n });
        put('counter', W / 2 - 1.0, D - 0.95, 0, [1.4, 1, 1], rc.accent);
        man(W / 2 - 1.0, D - 0.45, Math.PI, 'idle', true);
        n = 0;
      }
      if (n > 0 && rc.arch !== 'karaoke' && rc.arch !== 'bank') for (let i = 0; i < n; i++) man((rnd() - 0.5) * (W - 1.6), 1.5 + rnd() * (D - 2.6), (rnd() - 0.5) * 3, rc.act === 'browse' ? 'look' : 'idle');
    }
  }
  return { items, people };
}

// the glass's reflection: an equirect panorama (the renderer converts it to a cube for the unlit material)
function glassSheen() {
  const c = L.makeCanvas(256, 256), g = c.getContext('2d');
  g.fillStyle = '#000000'; g.fillRect(0, 0, 256, 256);
  const top = g.createLinearGradient(0, 0, 0, 70); top.addColorStop(0, 'rgba(120,90,110,0.55)'); top.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = top; g.fillRect(0, 0, 256, 70);
  g.filter = 'blur(10px)';
  for (const [x, w, a] of [[40, 34, 0.22], [96, 12, 0.14], [170, 46, 0.12]]) { g.save(); g.translate(x, 128); g.rotate(-0.5); g.fillStyle = `rgba(200,210,230,${a})`; g.fillRect(-w / 2, -220, w, 440); g.restore(); }
  g.filter = 'none';
  const t = L.canvasTex(c, { mips: true, aniso: 1 });
  return t;
}

// ------------------------------------------------------------------------------------------------ the system
export function createInteriors({ engine, group }) {
  const tex = goodsAtlas();
  const mat = partMaterial(tex), matFloor = floorMaterial();
  // the pane WRITES depth (it draws after the opaque room): the AO / haze passes then see the window as a flat facade
  // surface, not a closed box (their low-res obscurance blotched every room wall), and the room keeps the haze of the
  // street line it sits on. Unlit: the reflection is a small painted night-street panorama (dark sky, the sodium and
  // neon band at eye level, wet ground), which three turns into a cube map — no PBR, no pool lights, no cascades
  // the pane: a faint painted sheen (two soft diagonal streaks, a darker foot, the street's glow along the top) added
  // over the room — reads as glass, costs one texture fetch. (An env-mapped pane showed its cube texels as blocks.)
  const glass = new THREE.MeshBasicMaterial({ map: glassSheen(), color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  glass.name = 'interior:glass';
  const P = makeParts();
  const root = new THREE.Group(); root.name = 'interiors';
  group.add(root);
  // ground floors: the bay's floor within 2.2 m of the local ground (on 道玄坂 / 宮益坂 a ground floor stands metres up)
  const bays = SHOP_BAYS.filter((b) => !b.upper && b.y0 - groundY(b.x, b.z) < 2.2 && b.gh > 1.8);
  // upper-floor rooms behind a store's glass (LABY's sales floors, retailFronts.js): shown, never a shop-front collider
  // (a phone keeps the two lowest: the ones a street-level view actually looks into)
  const uppers = SHOP_BAYS.filter((b) => b.upper && (!MOBILE || (b.floor || 2) <= 3));
  for (const b of bays.concat(uppers)) b.rc = null;
  const state = { visible: 0, people: 0, cuts: 0, rooms: 0, levels: [0, 0, 0], rebuilds: 0 };
  const PEOPLE = PEDS ? { staff: PEDS.staff, shop: PEDS.shoppers, models: (() => { const m = MODELS.filter((k) => PEDS.meta.scans[k]); return m.length ? m : PEDS.shoppers; })() } : null;
  const floorMats = [matFloor];

  function roomOf(b) {
    if (b.room) return b.room;
    const rc = b.rc || (b.rc = recipeFor(b));
    const Wd = b.roomU ? b.roomU[1] - b.roomU[0] : b.roomW || (b.w - 0.04),   // the room's side walls on the cut's edges (a corner room: narrowed, see below)
      D = b.roomDfix ?? Math.max(2.8, Math.min(b.roomD || 9, b.depth || 6)), Hr = b.hallH ? b.hallH - b.y0 - 0.03 : b.gh + 0.35;
    let seed = Math.abs(Math.round(b.x * 13 + b.z * 7)) + 1;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const lay = layout(b, rc, Wd, D, Hr, rnd);
    b.room = { rc, W: Wd, D, Hr, lay, yaw: Math.atan2(b.nx, b.nz), ext: b.ext || 0, uc: b.roomU ? (b.roomU[0] + b.roomU[1]) / 2 : 0 };
    return b.room;
  }

  // ---- halls: one shell following a landmark's ground-floor polygon, seen through all of its bays (Q-FRONT)
  const HALLS = new Map();
  const matCutWalls = partMaterial(tex); matCutWalls.name = 'interior:hallWalls';
  for (const b of bays) {
    if (!b.hallOwner || !b.hallPoly) continue;
    const rc = roomOf(b).rc, poly = L.ensureCW(b.hallPoly), open = b.hallOpen, y0 = b.y0, H = b.hallH;
    const flipped = poly !== b.hallPoly && poly[0] !== b.hallPoly[0];
    const g = new THREE.Group(); g.name = 'interior:hall:' + b.hall; g.visible = false;
    const fm = floorMaterial(); fm.color.set(rc.floor); floorMats.push(fm);
    const fl = new THREE.Mesh(L.polygonCap(poly, y0 + 0.02), fm); fl.name = 'interior:hallFloor';
    const wp = new Part(), wc = new THREE.Color(rc.wall).multiplyScalar(0.95), cc = new THREE.Color(rc.ceil);
    const n = poly.length;
    // walls along every closed edge, 0.25 m inside, drawn BEFORE the depth punch (behind the drum glass the punch would
    // hide them): at the hall's own side-face bays the wall keeps a hole (the bay's window), a lintel above it
    const members = bays.filter((q) => q.hall === b.hall && !q.hallOwner);
    for (let i = 0; i < n; i++) {
      const oi = flipped ? (n - 2 - i + n) % n : i;                                  // edge index in the given winding
      if (open && open[oi]) continue;
      const a = poly[i], c2 = poly[(i + 1) % n], [ox, oz] = L.edgeNormal(poly, i), ix = -ox * 0.25, iz = -oz * 0.25;
      const len = Math.hypot(c2[0] - a[0], c2[1] - a[1]), tx = (c2[0] - a[0]) / len, tz = (c2[1] - a[1]) / len;
      const holes = [];
      for (const q of members) {
        const t = (q.x - a[0]) * tx + (q.z - a[1]) * tz, off = (q.x - a[0]) * ox + (q.z - a[1]) * oz;
        if (t > -0.5 && t < len + 0.5 && Math.abs(off) < 0.6 && q.nx * ox + q.nz * oz > 0.9) holes.push([Math.max(0, t - q.w / 2), Math.min(len, t + q.w / 2), q.y0 + q.gh]);
      }
      holes.sort((p, q) => p[0] - q[0]);
      const P0 = (t) => [a[0] + tx * t + ix, a[1] + tz * t + iz];
      const piece = (t0, t1, yA, yB) => { if (t1 - t0 < 0.01 || yB - yA < 0.01) return; const [x0, z0] = P0(t0), [x1, z1] = P0(t1); wp.quad([x0, yA, z0], [x1, yA, z1], [x1, yB, z1], [x0, yB, z0], [-ox, 0, -oz], wc); };
      let t = 0;
      for (const [h0, h1, top] of holes) { piece(t, h0, y0, H); piece(h0, h1, top, H); t = Math.max(t, h1); }
      piece(t, len, y0, H);
    }
    const cg = L.flipGeo(L.polygonCap(poly, H));
    const pc = cg.attributes.position.count;
    cg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pc * 3).map((_, k) => [cc.r, cc.g, cc.b][k % 3]), 3));
    cg.setAttribute('aLit', new THREE.Float32BufferAttribute(new Float32Array(pc), 1));
    cg.setAttribute('aTint', new THREE.Float32BufferAttribute(new Float32Array(pc), 1));
    cg.setAttribute('aTex', new THREE.Float32BufferAttribute(new Float32Array(pc), 1));
    cg.setAttribute('iFade', new THREE.Float32BufferAttribute(new Float32Array(pc).fill(1), 1));
    cg.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pc * 2).fill(WHITE_UV[0]), 2));
    const ce = new THREE.Mesh(cg, mat); ce.name = 'interior:hallCeiling';
    const wm = new THREE.Mesh(wp.geo(), matCutWalls); wm.name = 'interior:hallWalls';
    for (const m of [fl, ce, wm]) { m.castShadow = false; m.receiveShadow = false; m.renderOrder = -2; g.add(m); }
    root.add(g);
    HALLS.set(b.hall, { owner: b, group: g });
  }

  // ---- the showpiece set: every ground-floor bay within SHOW_R of the scramble, and the landmark ground floors
  // anywhere. Each gets its room at EVERY distance (no painted card), with the level of detail inside the room.
  const LANDMARK = /TSUTAYU|STARBEANS|西部|MAGNET|1O9|109|駅前|Q-FRONT|LABY|MEGA ドン/;
  const show = bays.filter((b) => Math.max(Math.abs(b.x), Math.abs(b.z)) < SHOW_R || b.hall || LANDMARK.test(b.name || '')).concat(uppers);
  const world = (b, u, v, out) => { out.x = b.x + b.nz * u - b.nx * v; out.z = b.z - b.nx * u - b.nz * v; return out; };
  const _w = { x: 0, z: 0 };
  // a light shell colour is held under a luminance cap
  const shellK = (hex, k) => { _c.set(hex); const l = 0.2126 * _c.r + 0.7152 * _c.g + 0.0722 * _c.b; return k * Math.min(1, 0.5 / Math.max(0.05, l)); };
  // the level an item belongs to: 0 far (shell, light, back wall, big lit fixtures), 1 mid (the floor's fixtures),
  // 2 near (the small dressing: POP, boards, stools, lanterns, steam, pools, mirrors …)
  const NEAR_K = /^(pop|popB|cat[A-P]|stand[MN]|menu|menuFast|menuCafe|menuIz|stool|lantern|steam|pool|spot|noren|ticket|beam|mirror)$/;
  const FAR_K = /^(panel|wash|track|lb[A-D]|fridge|kitchen|barShelf|posterA|posterB|tvWall|tvWallB|escalator)$/;
  const levelOf = (it, D) => NEAR_K.test(it.k) ? 2 : FAR_K.test(it.k) || it.v >= D - 0.75 ? 0 : 1;
  const ADDITIVE = new Set(['steam', 'pool']);

  // rooms must not interpenetrate (a ramen shop's tables stood inside the bookshop next door). Two cases:
  //  - back-to-back rooms (a thin lot with shops on both streets): the depths split, the deeper room shortened first,
  //    in 0.5 m steps down to 2.8 m;
  //  - rooms on perpendicular faces of a corner lot: both contain the corner, so no depth separates them — the room
  //    that keeps more window is narrowed on the side toward the other (a partition behind that part of its glass,
  //    as in many real corner shops); depth only if under 2 m of it would remain.
  {
    const PRIO = { laby: 4, drug: 3, konbini: 3, donki: 3, generic: 3, books: 3, dept: 3, fashion: 2, shoes: 2, game: 2, capsule: 2 };
    const base = (b) => { const W = b.roomW || (b.w - 0.04); return [-W / 2, W / 2]; };
    const rect = (b) => { const [uL, uR] = b.roomU, D = b.roomDfix, P = []; for (const [u, v] of [[uL + 0.06, 0.05], [uR - 0.06, 0.05], [uR - 0.06, D], [uL + 0.06, D]]) P.push([b.x + b.nz * u - b.nx * v, b.z - b.nx * u - b.nz * v]); return P; };
    const proj = (P, ax) => { let lo = Infinity, hi = -Infinity; for (const q of P) { const d = q[0] * ax[0] + q[1] * ax[1]; if (d < lo) lo = d; if (d > hi) hi = d; } return [lo, hi]; };
    const hit = (A, B) => { for (const P of [A, B]) for (let i = 0; i < 4; i++) { const a = P[i], c = P[(i + 1) % 4], ax = [c[1] - a[1], a[0] - c[0]]; const [a0, a1] = proj(A, ax), [b0, b1] = proj(B, ax); if (a1 <= b0 || b1 <= a0) return false; } return true; };
    const frame = (b, P) => { let u0 = Infinity, u1 = -Infinity, v0 = Infinity; for (const [x, z] of P) { const dx = x - b.x, dz = z - b.z, u = dx * b.nz - dz * b.nx, v = -(dx * b.nx + dz * b.nz); u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); } return [u0, u1, v0]; };
    const area = (b, U = b.roomU, D = b.roomDfix) => (U[1] - U[0]) * D;
    // the ways to separate a from b, each scored by the smaller room area left (a room under 2 m wide / 2.8 m deep is
    // not an option): narrow a (or b) away from the other, shorten a (or b) to where the other begins, or — two bays
    // on one face that overlap (a split frontage) — part them at the midline
    const options = (a, b) => {
      const out = [];
      for (const [x, y] of [[a, b], [b, a]]) {
        const [o0, o1, ov0] = frame(x, rect(y)), [uL, uR] = x.roomU;
        if (uR - Math.max(uL, o1) >= 2) out.push([x, [Math.max(uL, o1), uR], x.roomDfix]);
        if (Math.min(uR, o0) - uL >= 2) out.push([x, [uL, Math.min(uR, o0)], x.roomDfix]);
        if (ov0 - 0.1 >= 2.8 && ov0 - 0.1 < x.roomDfix) out.push([x, x.roomU, ov0 - 0.1]);
      }
      if (a.nx * b.nx + a.nz * b.nz > 0.9) {                                 // same face: the midline between them
        const [c0, c1] = frame(a, [[b.x, b.z], [b.x, b.z]]), m = c0 / 2;
        const ua = m > 0 ? [a.roomU[0], Math.min(a.roomU[1], m)] : [Math.max(a.roomU[0], m), a.roomU[1]];
        const ub = m > 0 ? [Math.max(b.roomU[0], -m), b.roomU[1]] : [b.roomU[0], Math.min(b.roomU[1], -m)];
        if (ua[1] - ua[0] >= 2 && ub[1] - ub[0] >= 2) out.push(['mid', ua, ub]);
        void c1;
      }
      return out;
    };
    const rs = show.filter((b) => !b.hall);
    for (const b of rs) { b.roomDfix = Math.max(2.8, Math.min(b.roomD || 9, b.depth || 6)); b.roomU = base(b); }
    const G = 12, grid = new Map();
    for (const b of rs) { const k = Math.floor(b.x / G) + ',' + Math.floor(b.z / G); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(b); }
    let shortened = 0, trimmed = 0;
    for (const a of rs) {
      const gx = Math.floor(a.x / G), gz = Math.floor(a.z / G);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const b of grid.get((gx + i) + ',' + (gz + j)) || []) {
        if (b === a || Math.abs(b.y0 - a.y0) > 2 || !hit(rect(a), rect(b))) continue;
        let best = null, bestS = -1;
        const prA = PRIO[recipeFor(a).arch] || 0, prB = PRIO[recipeFor(b).arch] || 0;
        for (const o of options(a, b)) {
          const sa = o[0] === 'mid' ? area(a, o[1]) : o[0] === a ? area(a, o[1], o[2]) : area(a);
          const sb = o[0] === 'mid' ? area(b, o[2]) : o[0] === b ? area(b, o[1], o[2]) : area(b);
          // never cut the aisle store to spare a lesser room (a drugstore keeps its corner over the bank next door)
          const sc = Math.min(sa, sb) - ((o[0] === a && prA > prB) || (o[0] === b && prB > prA) ? 1e6 : 0);
          if (sc > bestS) { bestS = sc; best = o; }
        }
        if (best) {
          if (best[0] === 'mid') { a.roomU = best[1]; b.roomU = best[2]; } else { best[0].roomU = best[1]; best[0].roomDfix = best[2]; }
          trimmed++;
          if (!hit(rect(a), rect(b))) continue;
        }
        if (a.nx * b.nx + a.nz * b.nz < -0.5) {                                // back to back: split the depth
          let guard = 30;
          while (guard-- > 0 && hit(rect(a), rect(b))) {
            const t = a.roomDfix >= b.roomDfix ? a : b, o = t === a ? b : a;
            if (t.roomDfix > 2.8) t.roomDfix = Math.max(2.8, t.roomDfix - 0.5); else if (o.roomDfix > 2.8) o.roomDfix = Math.max(2.8, o.roomDfix - 0.5); else break;
          }
        } else {
          // two boxes cannot share this corner: the larger room keeps its depth, the other takes the largest box that
          // clears it (a narrow shop / a shallow display niche down to 1.2 m) instead of both collapsing to 2.8 m
          // who keeps the corner: the aisle stores first (a drugstore / konbini must read deep), then by room area
          const pri = (q) => (PRIO[recipeFor(q).arch] || 0) * 1000 + area(q);
          const [w, l] = pri(a) >= pri(b) ? [a, b] : [b, a];
          const [o0, o1, ov0] = frame(l, rect(w)), [uL, uR] = l.roomU, c = [];
          if (uR - Math.max(uL, o1) >= 1.2) c.push([[Math.max(uL, o1), uR], l.roomDfix]);
          if (Math.min(uR, o0) - uL >= 1.2) c.push([[uL, Math.min(uR, o0)], l.roomDfix]);
          if (ov0 - 0.1 >= 1.2) c.push([l.roomU, Math.min(l.roomDfix, ov0 - 0.1)]);
          c.sort((p, q) => (q[0][1] - q[0][0]) * q[1] - (p[0][1] - p[0][0]) * p[1]);
          if (c.length) { l.roomU = c[0][0]; l.roomDfix = c[0][1]; } else l.roomDfix = 1.2;
        }
        shortened++;
      }
    }
    state.shortened = shortened; state.trimmed = trimmed;
  }

  const ROOMS = [];
  const count = {};                                                         // instance totals per kind (buffer sizes)
  for (const b of show) {
    const owner = b.hall && HALLS.has(b.hall) ? HALLS.get(b.hall).owner : null;
    const R = roomOf(b), rc = R.rc, yaw = R.yaw, y0 = b.y0, br = 0.62 + 0.2 * (rc.glow ?? 0.6);
    const items = [];                                                       // [kind, level, x, y, z, yaw, sx, sy, sz, hex, bright]
    const furnish = !b.hall || b.hallOwner;
    if (furnish && !b.hallPoly) {
      world(b, R.uc, 0, _w);
      items.push(['walls', 0, _w.x, y0, _w.z, yaw, R.W, R.Hr, R.D, rc.wall, shellK(rc.wall, 0.34 + 0.22 * (rc.glow ?? 0.6))]);
      items.push(['ceil', 0, _w.x, y0, _w.z, yaw, R.W, R.Hr, R.D, rc.ceil, shellK(rc.ceil, 0.4 + 0.22 * (rc.glow ?? 0.6))]);
      items.push(['floor', 0, _w.x, y0 + 0.02, _w.z, yaw, R.W, 1, R.D, rc.floor, 0.9 + 0.2 * (rc.glow ?? 0.6)]);
    }
    if (furnish) for (const it of R.lay.items) {
      world(b, it.u + R.uc, it.v, _w);
      items.push([it.k, levelOf(it, R.D), _w.x, y0 + it.y, _w.z, yaw + it.r, it.s[0], it.s[1], it.s[2], it.c, it.k === 'panel' || it.k === 'spot' || it.k === 'lantern' ? 1 : br]);
    }
    // a narrowed corner room leaves strips of its window with no room behind them (the punch would show the void):
    // each strip gets a closed, lit 0.7 m display niche (a partition behind the glass, a board on it)
    if (furnish && !b.hallPoly && b.roomU) {
      const W0 = (b.roomW || (b.w - 0.04)) / 2;
      for (const [s0, s1] of [[-W0, b.roomU[0]], [b.roomU[1], W0]]) {
        const w = s1 - s0; if (w < 0.08) continue;
        const uc = (s0 + s1) / 2, nD = Math.min(0.7, R.D);
        world(b, uc, 0, _w);
        items.push(['walls', 0, _w.x, y0, _w.z, yaw, w, R.Hr, nD, rc.wall, shellK(rc.wall, 0.34 + 0.22 * (rc.glow ?? 0.6))]);
        items.push(['ceil', 0, _w.x, y0, _w.z, yaw, w, R.Hr, nD, rc.ceil, shellK(rc.ceil, 0.4 + 0.22 * (rc.glow ?? 0.6))]);
        items.push(['floor', 0, _w.x, y0 + 0.02, _w.z, yaw, w, 1, nD, rc.floor, 0.9]);
        world(b, uc, nD - 0.03, _w); items.push(['wash', 0, _w.x, y0, _w.z, yaw, w, R.Hr, 1, rc.light, 1]);
        if (w > 1.2 && R.Hr > 2.4) { world(b, uc, nD - 0.06, _w); items.push([w > 2.2 ? (rc.arch === 'fashion' || rc.arch === 'dept' || rc.arch === 'shoes' || rc.arch === 'boutique' ? 'lbA' : 'posterB') : 'pop', 0, _w.x, y0 + Math.min(1.6, R.Hr - 0.8), _w.z, yaw, 1, 1, 1, 0x202022, 1]); }
      }
    }
    // the window case in front of the glass (genericBuilding shopFrontDepth): wax food samples in an eatery's, the
    // trade's goods on a shop's bed — an empty case read as a brown box at 1.5 m
    if (b.case && furnish) {
      const C = b.case, v = -((b.caseOff ?? 0.04) + C.depth / 2), u0 = -C.s, yb = y0 + C.bed + 0.012, A = rc.arch;
      if (C.eat) {
        const n = Math.max(1, Math.floor((C.w - 0.1) / 0.3)), DISH = [0xb8742e, 0xd8a040, 0xc84a2a, 0xe8d8a8, 0x7a4a2a, 0x6aa050, 0xe8c070];
        for (let r2 = 0; r2 < 2; r2++) for (let i = 0; i < n; i++) { world(b, u0 - ((n - 1) * 0.3) / 2 + i * 0.3, v + (r2 ? 0.1 : -0.1), _w); items.push(['sample', 1, _w.x, yb + r2 * 0.06, _w.z, yaw, 1, 1, 1, DISH[(i * 3 + r2 * 5 + Math.round(b.x)) % DISH.length], 1]); }
      } else {
        const k = A === 'books' ? 'wallBooks' : A === 'shoes' ? 'shoeWall' : (A === 'fashion' || A === 'boutique' || A === 'dept') ? 'foldTable' : 'lowGoods';
        const sc = k === 'wallBooks' ? [C.w - 0.1, 0.3, 0.5] : k === 'shoeWall' ? [C.w - 0.1, 0.26, 0.9] : k === 'foldTable' ? [(C.w - 0.1) / 1.4, 0.7, 0.45] : [C.w - 0.1, 0.55, 0.4];
        world(b, u0, v, _w); items.push([k, 1, _w.x, yb, _w.z, yaw, sc[0], sc[1], sc[2], rc.fix, br]);
      }
    }
    const cuts = b.cuts || [{ x: b.x, z: b.z, nx: b.nx, nz: b.nz, w: b.w, gh: b.gh, y0: b.y0, out: b.out }];
    for (const c of cuts) {
      // the punch 5 mm in front of the card, the glass 2 cm in front of the punch (coplanar, the two z-fought in tiles);
      // window neon (signage, 8 cm out), door frames and display cases stay in front of both
      const out = c.out ?? 0.04, cy = c.y0 + c.gh / 2, ry = Math.atan2(c.nx, c.nz);
      items.push(['glass', 0, c.x + c.nx * (out + 0.025), cy, c.z + c.nz * (out + 0.025), ry, c.w, c.gh, 1, 0xffffff, 1]);
      items.push(['punch', 0, c.x + c.nx * (out + 0.005), cy, c.z + c.nz * (out + 0.005), ry, c.w - 0.04, c.gh - 0.03, 1, 0xffffff, 1]);
      // tinted glass (LABY's navy upper floors): a multiplying pane over the room, just behind the sheen
      if (b.tint) items.push(['tint', 0, c.x + c.nx * (out + 0.015), cy, c.z + c.nz * (out + 0.015), ry, c.w, c.gh, 1, b.tint, 1]);
    }
    // people: staff, then the window's dressed mannequins, then customers; the first two are shown from mid range
    // (as the crowd's lod2), the rest from near; a hall keeps more
    const people = [];
    if (furnish && PEOPLE) {
      const rank = (q) => (q.staff ? 2 : q.mq ? 1 : 0);
      const order = R.lay.people.map((q, i) => i).sort((i, j) => rank(R.lay.people[j]) - rank(R.lay.people[i]));
      const nMid = b.hallPoly ? 2 : 1, nAll = b.hallPoly ? 12 : 8;
      order.slice(0, nAll).forEach((i, oi) => {
        const q = R.lay.people[i], list = q.mq ? PEOPLE.models : q.staff ? PEOPLE.staff : PEOPLE.shop;
        world(b, q.u + R.uc, q.v, _w);
        people.push({ level: oi < nMid ? 1 : 2, e: { key: list[(Math.abs(Math.round(b.x * 3 + b.z)) + i * (q.mq ? 3 : 5)) % list.length], x: _w.x, y: y0 + 0.02 + (q.mq ? 0.12 : 0), z: _w.z, yaw: yaw + q.r, clip: q.clip, phase: q.mq ? 0.1 + 0.2 * (i % 3) : (i * 0.37 + b.x * 0.01) % 1, freeze: !!q.mq } });
      });
    }
    // chunks: per kind, per level, the instance matrices and colours (copied into the shared buffers on rebuild)
    const ch = {};
    for (const [k, lv] of items.map((it) => [it[0], it[1]])) { const e = ch[k] || (ch[k] = [0, 0, 0]); e[lv]++; }
    for (const k of Object.keys(ch)) {
      const n = ch[k];
      ch[k] = n.map((c) => (c ? { m: new Float32Array(c * 16), c: new Float32Array(c * 3), n: 0 } : null));
      count[k] = (count[k] || 0) + n[0] + n[1] + n[2];
    }
    for (const it of items) {
      const [k, lv, x, y, z, ry, sx, sy, sz, hex, bright] = it, C = ch[k][lv];
      _q.setFromAxisAngle(_Y, ry); _p.set(x, y, z); _s.set(sx, sy, sz); _m.compose(_p, _q, _s);
      _m.toArray(C.m, C.n * 16); _c.set(hex); if (bright !== 1) _c.multiplyScalar(bright); C.c[C.n * 3] = _c.r; C.c[C.n * 3 + 1] = _c.g; C.c[C.n * 3 + 2] = _c.b; C.n++;
    }
    // the room's bounds (culling) and its opening (distance for the level)
    world(b, R.uc, R.D / 2, _w);
    const rad = b.hallPoly ? Math.hypot(R.W, R.D) / 2 + 5 : Math.hypot(R.W, R.D, R.Hr) / 2 + 0.8;
    ROOMS.push({ b, R, ch, people, cuts, owner, cx: _w.x, cy: y0 + R.Hr / 2, cz: _w.z, rad, level: -1, a: [1, 0, 0], vis: false, wasVis: false });
  }

  // ---- the shared instanced meshes, sized for the whole showpiece set
  const meshes = {}, fadeAttr = {};
  const mk = (k, geo, m, cap, order = -2) => {
    cap = Math.max(1, cap);
    const im = new THREE.InstancedMesh(geo, m, cap); im.name = 'interior:' + k; im.count = 0; im.frustumCulled = false; im.renderOrder = order;
    im.castShadow = false; im.receiveShadow = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    if (m === mat) { const fa = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1); fa.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('iFade', fa); fadeAttr[k] = fa; }
    root.add(im); meshes[k] = im; return im;
  };
  for (const [k, part] of Object.entries(P)) if (count[k]) mk(k, part.geo(), k === 'floor' ? matFloor : mat, count[k]);
  mk('glass', new THREE.PlaneGeometry(1, 1), glass, count.glass, 3);
  if (count.tint) {
    // dst × colour: the room behind stays readable, only its colour and level shift (no alpha, no lighting)
    const tintMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, toneMapped: false, fog: false });
    tintMat.name = 'interior:tint';
    mk('tint', new THREE.PlaneGeometry(1, 1), tintMat, count.tint, 2.5);
  }
  // the depth punch: the opening as a depth-only pane, drawn after the rooms (and the crowd tiers that carry the posed
  // people) and before the city — inside the opening the facade, the card and the building behind them fail the depth
  // test; outside it the facade covers the room as usual. No city shader is touched.
  const punchMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true }); punchMat.name = 'interior:punch';
  mk('punch', new THREE.PlaneGeometry(1, 1), punchMat, count.punch, -1);
  // steam over a noodle kitchen, warm pools of light under the track spots: additive, faded by their colour
  const steamTex = (() => { const c = L.makeCanvas(64, 128), g = c.getContext('2d'); const gr = g.createRadialGradient(32, 80, 2, 32, 70, 34); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 128);
    const g2 = g.createRadialGradient(28, 36, 2, 30, 34, 26); g2.addColorStop(0, 'rgba(255,255,255,0.6)'); g2.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = g2; g.fillRect(0, 0, 64, 128); return L.canvasTex(c, { mips: false, aniso: 1 }); })();
  const steamMat = new THREE.MeshBasicMaterial({ map: steamTex, color: 0x5a5650, transparent: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  steamMat.name = 'interior:steam';
  if (count.steam) mk('steam', new THREE.PlaneGeometry(0.6, 1.2), steamMat, count.steam, -1.5);
  const poolTex = (() => { const c = L.makeCanvas(128, 128), g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 2, 64, 64, 62); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return L.canvasTex(c, { mips: true, aniso: 1 }); })();
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, color: 0x3a2c1c, transparent: false, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  poolMat.name = 'interior:pool';
  if (count.pool) mk('pool', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMat, count.pool, -1.5);

  // ---- per frame: levels (with hysteresis), cross-fades, CPU frustum culling, rebuild on change
  const IN = [NEAR_D - 2, MID_D - 2], OUT = [NEAR_D + 2, MID_D + 2];
  const levelFor = (r, d) => {
    const l = r.level;
    if (d < (l === 2 ? OUT[0] : IN[0])) return 2;
    if (d < (l >= 1 ? OUT[1] : IN[1])) return 1;
    return 0;
  };
  let lastT = performance.now(), sig = '', peopleSig = '', posed = [];
  const visList = [];
  function rebuild(cam) {
    state.rebuilds++;
    for (const [k, im] of Object.entries(meshes)) {
      let n = 0;
      const M = im.instanceMatrix.array, Cc = im.instanceColor.array, F = fadeAttr[k] ? fadeAttr[k].array : null, add = ADDITIVE.has(k);
      for (const r of visList) {
        const e = r.ch[k]; if (!e) continue;
        for (let lv = 0; lv < 3; lv++) {
          const C = e[lv], a = r.a[lv]; if (!C || a <= 0.003) continue;
          M.set(C.m, n * 16);
          if (add) { for (let i = 0; i < C.n * 3; i++) Cc[n * 3 + i] = C.c[i] * a; } else Cc.set(C.c, n * 3);
          if (F) F.fill(a, n, n + C.n);
          n += C.n;
        }
      }
      im.count = n; im.visible = n > 0;
      if (n) {
        im.instanceMatrix.clearUpdateRanges(); im.instanceMatrix.addUpdateRange(0, n * 16); im.instanceMatrix.needsUpdate = true;
        im.instanceColor.clearUpdateRanges(); im.instanceColor.addUpdateRange(0, n * 3); im.instanceColor.needsUpdate = true;
        if (F) { fadeAttr[k].clearUpdateRanges(); fadeAttr[k].addUpdateRange(0, n); fadeAttr[k].needsUpdate = true; }
      }
    }
    for (const [name, H] of HALLS) H.group.visible = visList.some((r) => r.b.hall === name);
    // postfx: the 12 nearest visible openings skip AO (the obscurance painted blotches over lit rooms)
    const cs = [];
    for (const r of visList) for (const c of r.cuts) cs.push([(c.x - cam.position.x) ** 2 + (c.z - cam.position.z) ** 2, c, r]);
    cs.sort((p, q) => p[0] - q[0]);
    let ci = 0, sx0 = 0, sz0 = 0, sy0 = 0, rMax = 0, y0 = 1e9, y1 = -1e9;
    for (const [, c, r] of cs) {
      if (ci >= MAX_CUTS) break;
      const cy = c.y0 + c.gh / 2;
      CUT.uCutA.value[ci].set(c.x, cy + 0.015, c.z, 0); CUT.uCutB.value[ci].set(c.nz, -c.nx, c.nx, c.nz);
      CUT.uCutC.value[ci].set(c.w / 2 - 0.02, c.gh / 2 - 0.015, (c.hdIn || r.R.D) + 0.1, c.out ?? 0.04);
      sx0 += c.x; sz0 += c.z; sy0 += cy; y0 = Math.min(y0, c.y0); y1 = Math.max(y1, c.y0 + c.gh); ci++;
    }
    CUT.uCutN.value = ci;
    if (ci) {
      sx0 /= ci; sz0 /= ci; sy0 /= ci;
      for (let i = 0; i < ci; i++) { const A = CUT.uCutA.value[i], C = CUT.uCutC.value[i]; rMax = Math.max(rMax, Math.hypot(A.x - sx0, A.y - sy0, A.z - sz0) + Math.hypot(C.x, C.y, C.z)); }
      CUT.uCutS.value.set(sx0, sy0, sz0, (rMax + 1) * (rMax + 1)); CUT.uCutY.value.set(y0 - 0.01, y1 + 0.01);
    }
    state.cuts = ci;
  }
  // people: the posed set changes only when a room's people level appears / goes; their fades are driven per frame
  function repose(scan) {
    const list = [], refs = [];
    const byD = visList.slice().sort((p, q) => p.d - q.d);
    for (const r of byD) for (const q of r.people) {
      if (r.a[q.level] <= 0.003 || list.length >= MAX_PEOPLE) continue;
      list.push({ ...q.e, fade: r.a[q.level] }); refs.push([r, q.level]);
    }
    const ps = scan.setStatics(list) || [];
    posed = ps.map((p, i) => (p ? [p, refs[i][0], refs[i][1]] : null)).filter(Boolean);
    state.people = posed.length;
  }

  // the halls' own light: two warm fixtures under the ceiling join the lighting pool (they light the scans and shelves)
  function hallLights() {
    const lighting = engine.get && engine.get('lighting');
    if (!lighting || !lighting.addFixture) return false;
    for (const [, H] of HALLS) {
      const b = H.owner, R = roomOf(b);
      for (const u of [-R.W / 4, R.W / 4]) { world(b, u, R.D * 0.35, _w); lighting.addFixture({ pos: [_w.x, b.hallH - 0.6, _w.z], color: R.rc.light, intensity: 30, distance: 16, kind: 'shop' }); }
    }
    return true;
  }
  function update() {
    const cam = engine.camera; if (!cam) return;
    if (!state.lit) state.lit = hallLights();
    if (!state.pf) { const pf = engine.get && engine.get('postfx'), raw = (engine.params && engine.params.raw) || {}; state.pf = raw.ixhaze === '0' || (!pf || !pf.setInteriorCuts ? !!engine.booted : pf.setInteriorCuts(CUT)); }   // ?ixhaze=0: keep AO in windows (profiling)
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    const cx = cam.position.x, cz = cam.position.z;
    cam.updateMatrixWorld(); _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); _fr.setFromProjectionMatrix(_pm);
    visList.length = 0;
    let fading = false, lv = [0, 0, 0];
    for (const r of ROOMS) {
      const b = r.b, d = Math.hypot(cx - b.x, cz - b.z);
      r.d = d;
      const nl = levelFor(r, d);
      _sp.center.set(r.cx, r.cy, r.cz); _sp.radius = r.rad;
      // in view: inside the frustum, and in front of its opening (a room seen only from behind its building is hidden
      // by that building anyway; a hall is seen from every side)
      const facing = b.hall ? true : (cx - b.x) * b.nx + (cz - b.z) * b.nz > -0.5;
      const vis = facing && _fr.intersectsSphere(_sp);
      if (nl !== r.level) {
        if (!vis || r.level < 0) { r.a[1] = nl >= 1 ? 1 : 0; r.a[2] = nl >= 2 ? 1 : 0; }   // out of view: switch at once
        r.level = nl;
      }
      for (let l = 1; l < 3; l++) {                                          // in view: cross-fade (≥ 0.5 s, never a pop)
        const t = r.level >= l ? 1 : 0;
        if (r.a[l] !== t) { r.a[l] = t > r.a[l] ? Math.min(1, r.a[l] + dt * FADE_RATE) : Math.max(0, r.a[l] - dt * FADE_RATE); if (vis) fading = true; if (!vis) r.a[l] = t; }
      }
      r.vis = vis;
      if (vis) { visList.push(r); lv[r.level]++; }
    }
    let s2 = '';
    for (const r of visList) s2 += ROOMS.indexOf(r) * 4 + r.level + ',';
    if (s2 !== sig || fading) { sig = s2; rebuild(cam); }
    // people: repose when the set of (room, level) with people changes; otherwise only their fades move
    const crowd = engine.get && engine.get('crowd'), scan = crowd && crowd.scanR;
    if (scan && scan.ready && scan.setStatics) {
      let ps = '';
      for (const r of visList) if (r.people.length) ps += ROOMS.indexOf(r) + ':' + (r.a[1] > 0.003 ? 1 : 0) + (r.a[2] > 0.003 ? 1 : 0) + ',';
      if (ps !== peopleSig) { peopleSig = ps; repose(scan); }
      else for (const [p, r, l] of posed) p.fade = r.a[l];
    }
    state.visible = visList.length; state.rooms = ROOMS.length; state.levels = lv;
  }

  function setNight(f) {
    mat.userData.U.uSelf.value = matCutWalls.userData.U.uSelf.value = 0.28 + 0.3 * f;
    mat.userData.U.uLit.value = matCutWalls.userData.U.uLit.value = 1.3;
    mat.userData.U.uBase.value = matCutWalls.userData.U.uBase.value = 0.5 - 0.28 * f;
    mat.userData.U.uTex.value = 0.08 + 0.22 * f;                                  // goods faces read from the street
    for (const m of floorMats) { m.userData.U.uSelf.value = 0.24 + 0.3 * f; m.userData.U.uBase.value = 0.45 - 0.25 * f; }
  }
  return { root, update, setNight, state, meshes, bays, show, ROOMS, halls: HALLS };
}

export default { createInteriors, CUT };
