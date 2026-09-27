// [city] 渋谷町駅 東口 bus terminal dressing (real layout: OSM psv ways + the 2024-12-14 のりば plan — see cityData
// BUSWAYS.higashiguchi_bus / APRONS / RAISED / BUS_STOPS terminal 'higashi' / BUS_TERMINALS.higashi):
//   のりば poles (the 都営-style round number disc, 系統 plates, a lit timetable), queue lanes painted on the pavement
//   with their chain posts, the kerb canopies (lime-green fascia on the 54 / 56 / 58 pavements, Scramble Square's
//   louvred canopy over 51 / 59, glass kerb shelters at 52 / 53 on 明治通り), white guard pipes along the kerbs with
//   gaps at the doors, the disused island (fenced off, cones, its old shelters and a notice), the 待機場所 bay lines
//   and 導流帯 hatching on the apron, the 東口地下広場 stair house (B7) and lift, the terminal's name pylon with the
//   のりば map, pole lamps, and the glazed 2F deck between Scramble Square and ヒカリエ over 明治通り.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { SW_H } from './streets.js';

const left = (dx, dz) => [dz, -dx];                  // left of travel (cityData / offsetPolyline convention)
const dirOf = (rotY) => [Math.cos(rotY), -Math.sin(rotY)];
const GREEN = '#009944', TOEI_RING = '#00843d', TOKO = '#d7262b';

let plateMat = null, plateUV = null;
/** One canvas for every のりば: number discs, 系統 plates, timetables, the terminal map, the closed-island notice. */
function plates(CITY) {
  if (plateMat) return { mat: plateMat, uv: plateUV };
  const T = CITY.busTerminals.higashi, stops = (CITY.busStops || []).filter(s => s.terminal === 'higashi');
  const W = 2048, H = 1536, c = L.makeCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, W, H);
  const uv = {};
  const rect = (x, y, w, h) => [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H];
  const fit = (txt, px, weight, fam, maxW) => { g.font = `${weight} ${px}px ${fam}`; while (g.measureText(txt).width > maxW && px > 10) { px -= 2; g.font = `${weight} ${px}px ${fam}`; } };
  const col = (no) => (T.routeColors && T.routeColors[no]) || GREEN;
  stops.forEach((s, i) => {
    const toko = /東光/.test(s.op), ring = toko ? TOKO : TOEI_RING;
    // disc: white face, coloured ring, the のりば number
    { const x = i * 256, y = 0; g.fillStyle = '#e9ebe6'; g.fillRect(x, y, 256, 256);
      g.fillStyle = ring; g.beginPath(); g.arc(x + 128, y + 128, 124, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x + 128, y + 128, 104, 0, Math.PI * 2); g.fill();
      g.fillStyle = ring; g.textAlign = 'center'; g.textBaseline = 'middle'; fit(s.ref, 130, 900, L.FONT_LATIN, 170); g.fillText(s.ref, x + 128, y + 136);
      g.font = `700 22px ${L.FONT_JP}`; g.fillText(toko ? '東光バス' : '都営バス', x + 128, y + 52);
      uv['disc' + s.ref] = rect(x + 2, y + 2, 252, 252); }
    // 系統 plate: one row per route — badge, 行き先, 経由
    { const x = (i % 4) * 512, y = 256 + Math.floor(i / 4) * 160, n = s.routes.length;
      g.fillStyle = '#ffffff'; g.fillRect(x, y, 512, 160); g.fillStyle = ring; g.fillRect(x, y, 512, 10); g.fillRect(x, y + 150, 512, 10);
      s.routes.forEach((r, k) => {
        const ry = y + 14 + k * (132 / n), rh = 132 / n - 6;
        g.fillStyle = col(r.no); g.fillRect(x + 10, ry, 118, rh);
        g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle'; fit(r.no, Math.min(52, rh * 0.8), 800, L.FONT_LATIN, 108); g.fillText(r.no, x + 69, ry + rh / 2 + 2);
        g.fillStyle = '#16181c'; g.textAlign = 'left'; fit(r.to + ' 行', Math.min(44, rh * 0.62), 800, L.FONT_JP, 360); g.fillText(r.to + ' 行', x + 142, ry + rh * 0.36);
        g.fillStyle = '#50545c'; fit(r.via + ' 経由', Math.min(24, rh * 0.32), 600, L.FONT_JP, 360); g.fillText(r.via + ' 経由', x + 142, ry + rh * 0.8);
      });
      uv['plate' + s.ref] = rect(x + 1, y + 1, 510, 158); }
    // timetable: header in the route colour, hour rows 5–23 with the minutes (deterministic)
    { const x = i * 256, y = 576, r0 = s.routes[0];
      g.fillStyle = '#fbfbf7'; g.fillRect(x, y, 256, 384); g.strokeStyle = '#9aa0a6'; g.lineWidth = 3; g.strokeRect(x + 2, y + 2, 252, 380);
      g.fillStyle = col(r0.no); g.fillRect(x + 6, y + 6, 244, 52);
      g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.textBaseline = 'middle'; fit(`${s.ref} のりば  ${s.routes.map(r => r.no).join('・')}`, 24, 800, L.FONT_JP, 232); g.fillText(`${s.ref} のりば  ${s.routes.map(r => r.no).join('・')}`, x + 12, y + 22);
      fit(`${r0.to} 行   平日`, 18, 700, L.FONT_JP, 232); g.fillText(`${r0.to} 行   平日`, x + 12, y + 45);
      g.font = `600 13px ${L.FONT_LATIN}`;
      for (let h = 5, row = 0; h <= 23; h++, row++) {
        const ty = y + 70 + row * 16;
        g.fillStyle = row % 2 ? '#eef0ea' : '#ffffff'; g.fillRect(x + 6, ty - 7, 244, 16);
        g.fillStyle = '#1b1d22'; g.textAlign = 'right'; g.fillText(String(h), x + 30, ty + 1);
        g.textAlign = 'left'; g.fillStyle = '#2a2e34';
        const per = h >= 7 && h <= 9 ? 6 : h >= 22 ? 2 : 4, mins = [];
        for (let k = 0; k < per; k++) mins.push(String(Math.floor((k * 60 / per + L.hash(i, h, k) * 9) % 60)).padStart(2, '0'));
        g.fillText(mins.join('  '), x + 40, ty + 1);
      }
      g.fillStyle = '#50545c'; g.font = `600 13px ${L.FONT_JP}`; g.textAlign = 'center'; g.fillText('渋谷駅東口  ―  時刻表', x + 128, y + 372);
      uv['time' + s.ref] = rect(x + 1, y + 1, 254, 382); }
  });
  // terminal map (のりば案内): the loop drawn north-up with each のりば and its 系統
  { const x = 0, y = 960, w = 1024, h = 512;
    g.fillStyle = '#1b2748'; g.fillRect(x, y, w, h); g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = `800 40px ${L.FONT_JP}`; g.fillText('渋谷町駅 東口バスターミナル  のりば案内', x + 28, y + 38);
    g.font = `600 20px ${L.FONT_LATIN}`; g.fillStyle = '#c9d4ea'; g.fillText('SHIBUYA-CHO STA. EAST EXIT BUS TERMINAL', x + 30, y + 76);
    const mx = (px) => x + 90 + (px - 105) * 7.2, mz = (pz) => y + 110 + (pz - 18) * 5.2;   // plan → board
    g.fillStyle = '#e9ebe6'; g.fillRect(x + 20, y + 100, 560, 392);
    const bw = CITY.busways.find(b => b.id === T.busway);
    g.strokeStyle = '#3a3f46'; g.lineWidth = 18; g.lineJoin = 'round'; g.beginPath();
    bw.path.forEach(([px, pz], k) => (k ? g.lineTo(mx(px), mz(pz)) : g.moveTo(mx(px), mz(pz)))); g.stroke();
    g.strokeStyle = '#ffd400'; g.lineWidth = 3; g.setLineDash([10, 8]); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#6b7079'; g.font = `700 18px ${L.FONT_JP}`; g.textAlign = 'center';
    g.fillText('宮益坂', mx(122), mz(9)); g.fillText('明治通り', mx(150), mz(50)); g.fillText('スクランブルスクエア', mx(128), mz(88)); g.fillText('工事中', mx(101), mz(58));
    stops.filter(s => s.road).forEach((s) => {
      const toko = /東光/.test(s.op), [px, pz] = s.pole;
      g.fillStyle = toko ? TOKO : TOEI_RING; g.beginPath(); g.arc(mx(px), mz(pz), 17, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff'; g.font = `800 20px ${L.FONT_LATIN}`; g.fillText(s.ref, mx(px), mz(pz) + 1);
    });
    g.textAlign = 'left';
    stops.forEach((s, k) => {
      const ty = y + 118 + k * 46, toko = /東光/.test(s.op);
      g.fillStyle = toko ? TOKO : TOEI_RING; g.beginPath(); g.arc(x + 616, ty + 12, 17, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.font = `800 20px ${L.FONT_LATIN}`; g.fillText(s.ref, x + 616, ty + 13);
      g.textAlign = 'left'; g.font = `700 22px ${L.FONT_JP}`;
      g.fillText(s.routes.map(r => `${r.no} ${r.to}`).join('  /  '), x + 644, ty + 4);
      g.fillStyle = '#c9d4ea'; g.font = `500 15px ${L.FONT_JP}`; g.fillText(`${s.op}${s.road ? '' : '  ・  明治通り ヒカリエ前'}`, x + 646, ty + 28);
    });
    uv.map = rect(x + 2, y + 2, w - 4, h - 4); }
  // closed island notice
  { const x = 1024, y = 960, w = 512, h = 256;
    g.fillStyle = '#ffffff'; g.fillRect(x, y, w, h); g.fillStyle = '#e60012'; g.fillRect(x, y, w, 56);
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `800 32px ${L.FONT_JP}`; g.fillText('お知らせ', x + w / 2, y + 30);
    g.fillStyle = '#16181c'; g.font = `800 30px ${L.FONT_JP}`; g.fillText('こののりばは使用しておりません', x + w / 2, y + 100);
    g.font = `600 21px ${L.FONT_JP}`; g.fillText('2024年12月14日より のりばの位置が変わりました', x + w / 2, y + 150);
    g.fillText('51・54・56・58・59番のりばをご利用ください', x + w / 2, y + 184);
    g.fillStyle = '#50545c'; g.font = `600 16px ${L.FONT_JP}`; g.fillText('東京都交通局 ・ 渋谷町駅東口土地区画整理事業', x + w / 2, y + 226);
    uv.notice = rect(x + 1, y + 1, w - 2, h - 2); }
  // name board for the pylon
  { const x = 1536, y = 960, w = 512, h = 256;
    g.fillStyle = '#1b2748'; g.fillRect(x, y, w, h); g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `800 58px ${L.FONT_JP}`; g.fillText('東口', x + 110, y + 98); g.font = `800 40px ${L.FONT_JP}`; g.fillText('バスのりば', x + 340, y + 98);
    g.font = `700 26px ${L.FONT_LATIN}`; g.fillStyle = '#c9d4ea'; g.fillText('EAST EXIT  ―  BUS TERMINAL', x + w / 2, y + 170);
    g.fillStyle = TOEI_RING; g.fillRect(x + 20, y + 214, 150, 22); g.fillStyle = TOKO; g.fillRect(x + 180, y + 214, 150, 22); g.fillStyle = '#f39700'; g.fillRect(x + 340, y + 214, 150, 22);
    uv.name = rect(x + 1, y + 1, w - 2, h - 2); }
  // 地下広場 / lift signs
  { const x = 1024, y = 1216, w = 512, h = 128;
    g.fillStyle = '#20252b'; g.fillRect(x, y, w, h); g.fillStyle = '#ffd400'; g.fillRect(x + 12, y + 20, 88, 88);
    g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `800 50px ${L.FONT_LATIN}`; g.fillText('B7', x + 56, y + 66);
    g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.font = `800 34px ${L.FONT_JP}`; g.fillText('東口地下広場', x + 118, y + 44);
    g.font = `600 18px ${L.FONT_JP}`; g.fillText('半蔵門線・副都心線・田園都市線 ・ 地下通路', x + 120, y + 92);
    uv.b7 = rect(x + 1, y + 1, w - 2, h - 2); }
  { const x = 1536, y = 1216, w = 512, h = 128;
    g.fillStyle = '#20252b'; g.fillRect(x, y, w, h); g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = `800 38px ${L.FONT_JP}`; g.fillText('エレベーター', x + 24, y + 46); g.font = `600 20px ${L.FONT_JP}`; g.fillText('東口地下広場  B2F ↔ 1F', x + 26, y + 96);
    uv.lift = rect(x + 1, y + 1, w - 2, h - 2); }
  plateMat = L.signMaterial(c, { emissive: 0.4, roughness: 0.5 });
  plateMat.name = 'ex_plates';
  plateUV = uv;
  return { mat: plateMat, uv };
}

let mats = null;
function localMats() {
  if (mats) return mats;
  const fascia = L.std({ color: 0x6ea83a, roughness: 0.55, metalness: 0.05, emissive: 0x5a8a2a, emissiveIntensity: 0.03 });
  S.nightMaterial(fascia, 0.0, 0.03); fascia.name = 'ex_fascia';
  const soffit = L.std({ color: 0xe8e8e4, roughness: 0.7, metalness: 0.05 }); soffit.name = 'ex_soffit';
  const decal = (color, name) => { const m = L.std({ color, roughness: 0.65, metalness: 0 }); m.polygonOffset = true; m.polygonOffsetFactor = -3; m.polygonOffsetUnits = -3; m.userData.noShadow = true; m.name = name; return m; };
  const barrier = L.std({ color: 0xf2f2ee, roughness: 0.5, metalness: 0.05 }); barrier.name = 'ex_barrier';
  const barrierG = L.std({ color: 0x1f9a4a, roughness: 0.5, metalness: 0.05 }); barrierG.name = 'ex_barrierG';
  const cone = L.std({ color: 0xff5a14, roughness: 0.55, metalness: 0, emissive: 0x401000, emissiveIntensity: 0.2 }); cone.name = 'ex_cone';
  mats = { fascia, soffit, barrier, barrierG, cone, paintY: decal(0xe0b62a, 'ex_paintY'), paintW: decal(0xb8b8b0, 'ex_paintW'), tactile: decal(0xd8b01c, 'ex_tactile') };
  return mats;
}

/** Guard pipes (0.8 m, white) along a polyline, only where the field says pavement and keep(x, z) holds. */
function guardRun(batch, M, pts, field, colliders, keep) {
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1], b = run[i], l = Math.hypot(b.x - a.x, b.z - a.z), r = Math.atan2(-(b.z - a.z), b.x - a.x), mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        for (const y of [0.45, 0.8]) batch.add(M.whiteMetal, L.boxAt(mx, SW_H + y, mz, l, 0.05, 0.05, r, false), mx, mz);
        colliders.push(S.boxCollider(mx, mz, l, 1.0, 0.2, r, SW_H));
      }
      for (const p of run) batch.add(M.whiteMetal, L.boxAt(p.x, SW_H + 0.42, p.z, 0.07, 0.84, 0.07, 0, false), p.x, p.z);
    }
    run = [];
  };
  for (const p of L.alongPolyline(pts, 2, 1)) { if (field.sample(p.x, p.z) > 0.3 && keep(p.x, p.z)) run.push(p); else flush(); }
  flush();
}

/** A canopy along a polyline (the kerb-side edge first): roof slab, fascia on the bus side, posts, strip lights. */
function canopy(batch, inst, M, X, pts, depth, height, colliders, { fascia = true, postEvery = 6, field = null, fixture = null } = {}) {
  const seg = L.alongPolyline(pts, 3, 0);
  if (fixture) for (const p of L.alongPolyline(pts, 9, 3)) { const [lx, lz] = left(p.dx, p.dz); fixture(p.x + lx * depth * 0.4, SW_H + height + 0.12, p.z + lz * depth * 0.4, 0xeef3ff, 34, 12); }
  for (let i = 1; i < seg.length; i++) {
    const a = seg[i - 1], b = seg[i], l = Math.hypot(b.x - a.x, b.z - a.z) + 0.04, r = Math.atan2(-(b.z - a.z), b.x - a.x);
    const [lx, lz] = left(b.x - a.x, b.z - a.z).map(v => v / (l - 0.04));
    const mx = (a.x + b.x) / 2 + lx * depth / 2, mz = (a.z + b.z) / 2 + lz * depth / 2;
    batch.add(M.whiteMetal, L.boxAt(mx, SW_H + height + 0.12, mz, l, 0.22, depth, r, false), mx, mz);
    batch.add(X.soffit, L.boxAt(mx, SW_H + height - 0.01, mz, l, 0.03, depth - 0.1, r, false), mx, mz);
    if (fascia) batch.add(X.fascia, L.boxAt(mx - lx * depth / 2, SW_H + height + 0.02, mz - lz * depth / 2, l, 0.5, 0.08, r, false), mx, mz);
    S.ibox(inst, 'lm_stripLight', M.glowWhite, mx - lx * depth * 0.2, SW_H + height - 0.05, mz - lz * depth * 0.2, 0.14, 0.05, l - 0.4, r + Math.PI / 2);
  }
  for (const p of L.alongPolyline(pts, postEvery, 1.2)) {
    const [lx, lz] = left(p.dx, p.dz), x = p.x + lx * (depth - 0.4), z = p.z + lz * (depth - 0.4);
    if (field && field.sample(x, z) < 0.4) continue;
    batch.add(M.silver, L.boxAt(x, SW_H + height / 2, z, 0.18, height, 0.18, 0, false), x, z);
    colliders.push(S.boxCollider(x, z, 0.3, height, 0.3, 0, SW_H));
  }
}

/** A slice of polyline pts between arc lengths s0 and s1. */
function slice(pts, s0, s1) {
  const out = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const lerp = (s) => { const t = (s - acc) / l; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
    if (acc + l >= s0 && acc <= s1) {
      if (!out.length) out.push(lerp(Math.max(s0, acc)));
      if (acc + l <= s1) out.push(b); else { out.push(lerp(s1)); break; }
    }
    acc += l;
  }
  return out;
}
function arcAt(pts, x, z) {
  let best = 0, bd = 1e9, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let k = 0; k <= 10; k++) { const t = k / 10, px = a[0] + (b[0] - a[0]) * t, pz = a[1] + (b[1] - a[1]) * t, d = Math.hypot(px - x, pz - z); if (d < bd) { bd = d; best = acc + l * t; } }
    acc += l;
  }
  return best;
}

export function buildEastExit({ CITY, batch, inst, field, engine }) {
  const colliders = [];
  // spill lights for the lighting module's pool (the nearest fixtures to the camera become real point lights). They
  // sit just inside the canopy / soffit they belong to, so they light the ground and never the soffit itself.
  const lighting = engine && engine.get && engine.get('lighting');
  const fixture = (x, y, z, color, intensity, distance) => { if (lighting && lighting.addFixture) lighting.addFixture({ pos: [x, y, z], color, intensity, distance, kind: 'terminal' }); };
  const T = CITY.busTerminals && CITY.busTerminals.higashi;
  const bw = T && (CITY.busways || []).find(b => b.id === T.busway);
  if (!T || !bw || !field) return { colliders };
  const M = S.mats(), X = localMats(), P = plates(CITY);
  const stops = (CITY.busStops || []).filter(s => s.terminal === 'higashi');
  const loop = stops.filter(s => s.road === T.busway);
  const kerbLine = L.offsetPolyline(bw.path, 2.0);                 // the platform kerb (the doors' side)
  const sOf = (s) => arcAt(bw.path, s.pos[0], s.pos[1]);

  // ---- のりば poles: post, the number disc (both faces, across the kerb), the 系統 plate, the lit timetable box
  for (const s of stops) {
    const [dx, dz] = dirOf(s.heading), [lx, lz] = left(dx, dz), [px, pz] = s.pole;
    batch.add(M.silver, L.boxAt(px, SW_H + 1.45, pz, 0.08, 2.9, 0.08, 0, false), px, pz);
    batch.add(M.darkMetal, L.boxAt(px, SW_H + 0.06, pz, 0.36, 0.12, 0.36, 0, false), px, pz);
    for (const sg of [1, -1]) {
      batch.add(P.mat, L.wallQuad(px, SW_H + 2.55, pz, dx * sg, dz * sg, 0.62, 0.62, 0.035, P.uv['disc' + s.ref]), px, pz);
      batch.add(P.mat, L.wallQuad(px, SW_H + 2.0, pz, dx * sg, dz * sg, 0.66, 0.21, 0.035, P.uv['plate' + s.ref]), px, pz);
    }
    batch.add(M.whiteMetal, L.boxAt(px, SW_H + 2.55, pz, 0.66, 0.66, 0.05, Math.atan2(-dz, dx) + Math.PI / 2, false), px, pz);
    // timetable box on the pavement side of the post, facing the queue
    const tx = px + lx * 0.12, tz = pz + lz * 0.12;
    batch.add(M.whiteMetal, L.boxAt(tx, SW_H + 1.35, tz, 0.5, 0.74, 0.1, Math.atan2(-lz, lx) + Math.PI / 2, false), tx, tz);
    batch.add(P.mat, L.wallQuad(tx, SW_H + 1.35, tz, lx, lz, 0.44, 0.66, 0.055, P.uv['time' + s.ref]), tx, tz);
    colliders.push(S.boxCollider(px, pz, 0.3, 2.9, 0.3, 0, SW_H));
    // queue lane painted along the kerb behind the pole: two yellow lines, the のりば number at its head, and the
    // green-and-white chain posts along its pavement side
    const q = s.queue || [];
    if (q.length >= 2) {
      const qa = q[0], qb = q[q.length - 1], ql = Math.hypot(qb[0] - qa[0], qb[1] - qa[1]) + 1.4;
      const ux = (qb[0] - qa[0]) / (ql - 1.4), uz = (qb[1] - qa[1]) / (ql - 1.4), r = Math.atan2(-uz, ux);
      const cx = (qa[0] + qb[0]) / 2, cz = (qa[1] + qb[1]) / 2;
      for (const off of [-0.5, 0.5]) batch.add(X.paintY, L.stripRect(cx + lx * off, cz + lz * off, ql, 0.1, r, SW_H + 0.008), cx, cz);
      batch.add(X.paintY, L.stripRect(qa[0] - ux * 0.7, qa[1] - uz * 0.7, 0.1, 1.0, r, SW_H + 0.008), cx, cz);
      for (let k = 0; k < q.length; k += 2) batch.add(X.paintW, L.stripRect(q[k][0], q[k][1], 0.32, 0.22, r + Math.PI / 2, SW_H + 0.009), cx, cz);
      for (let k = 0; k <= 4; k++) {
        const t = k / 4, x = qa[0] + (qb[0] - qa[0]) * t + lx * 0.95, z = qa[1] + (qb[1] - qa[1]) * t + lz * 0.95;
        if (field.sample(x, z) < 0.5) continue;
        batch.add(k % 2 ? X.barrier : X.barrierG, L.boxAt(x, SW_H + 0.42, z, 0.09, 0.84, 0.09, 0, false), x, z);
        if (k) { const pxq = x - (qb[0] - qa[0]) / 8, pzq = z - (qb[1] - qa[1]) / 8; batch.add(M.darkMetal, L.boxAt(pxq, SW_H + 0.66, pzq, ql / 4, 0.03, 0.03, r, false), x, z); }
      }
    }
  }

  // ---- canopies. 54 / 56 (west pavement) and 58 (north pavement): the terminal's lime-green fascia over the bays
  const L2 = L.polylineLength(bw.path);
  const cov = (stopsIn, before, after) => {
    const ss = stopsIn.map(sOf);
    return slice(kerbLine, Math.max(0, Math.min(...ss) - before), Math.min(L2, Math.max(...ss) + after));
  };
  const west = loop.filter(s => s.canopy === 'green' && s.kerb === 'west'), north = loop.filter(s => s.canopy === 'green' && s.kerb === 'north');
  if (west.length) canopy(batch, inst, M, X, L.offsetPolyline(cov(west, 12.5, 1.5), 0.25), 3.3, 3.25, colliders, { field, fixture });
  if (north.length) canopy(batch, inst, M, X, L.offsetPolyline(cov(north, 12, 1.5), 0.25), 3.3, 3.25, colliders, { field, fixture });
  // 51 / 59: Scramble Square's canopy — a deep white slab from the tower's north face out over the pavement, angled
  // louvres on top, downlights under it
  const scr = CITY.landmarks.scrambleSquare;
  if (scr) {
    const r = scr.rotY, ex = [Math.cos(r), -Math.sin(r)], ez = [Math.sin(r), Math.cos(r)], [w, , d] = scr.size;
    const ne = [scr.pos[0] + ex[0] * w / 2 - ez[0] * d / 2, scr.pos[1] + ex[1] * w / 2 - ez[1] * d / 2];
    const nw = [scr.pos[0] - ex[0] * w / 2 - ez[0] * d / 2, scr.pos[1] - ex[1] * w / 2 - ez[1] * d / 2];
    const fx = nw[0] - ne[0], fz = nw[1] - ne[1], fl = Math.hypot(fx, fz), ux = fx / fl, uz = fz / fl, nx = -ez[0], nz = -ez[1];
    const a0 = 1.5, a1 = fl - 7, depth = 4.6, y = SW_H + 5.2, ry = Math.atan2(-uz, ux);
    const cx = ne[0] + ux * (a0 + a1) / 2 + nx * depth / 2, cz = ne[1] + uz * (a0 + a1) / 2 + nz * depth / 2;
    batch.add(M.whiteMetal, L.boxAt(cx, y, cz, a1 - a0, 0.35, depth, ry, false), cx, cz);
    batch.add(X.soffit, L.boxAt(cx, y - 0.19, cz, a1 - a0 - 0.2, 0.03, depth - 0.2, ry, false), cx, cz);
    // the soffit is a saw-tooth of white louvres across the canopy, lit between them
    for (let t = a0 + 0.9; t < a1 - 0.5; t += 1.4) {
      const x = ne[0] + ux * t + nx * depth / 2, z = ne[1] + uz * t + nz * depth / 2;
      const fin = L.boxAt(0, 0, 0, 0.9, 0.08, depth - 0.3, 0, false); fin.rotateZ(0.62); fin.rotateY(ry); fin.translate(x, y - 0.55, z);
      batch.add(M.whiteMetal, fin, x, z);
      if ((Math.round(t / 1.4)) % 2) S.ibox(inst, 'lm_downlight', M.glowWarm, x + nx * 1.3, y - 0.22, z + nz * 1.3, 0.34, 0.06, 0.34);
    }
    for (const o of [0.8, depth - 0.9]) S.ibox(inst, 'lm_stripLight', M.glowWhite, cx - nx * (depth / 2 - o), y - 0.24, cz - nz * (depth / 2 - o), 0.12, 0.04, a1 - a0 - 1, ry + Math.PI / 2);
    for (let t = a0 + 3; t < a1; t += 9) fixture(ne[0] + ux * t + nx * depth * 0.55, y + 0.1, ne[1] + uz * t + nz * depth * 0.55, 0xffe2b8, 48, 15);
    // fascia band on the kerb edge
    batch.add(M.silver, L.boxAt(cx + nx * depth / 2, y + 0.05, cz + nz * depth / 2, a1 - a0, 0.55, 0.08, ry, false), cx, cz);
    for (let t = a0 + 4; t < a1; t += 8) { const x = ne[0] + ux * t + nx * (depth - 0.5), z = ne[1] + uz * t + nz * (depth - 0.5); if (field.sample(x, z) < 0.5) continue; batch.add(M.darkMetal, L.boxAt(x, SW_H + y / 2 - 0.1, z, 0.35, y - SW_H, 0.35, 0, false), x, z); colliders.push(S.boxCollider(x, z, 0.4, y, 0.4, 0, SW_H)); }
  }
  // 52 / 53 on 明治通り: glass kerb shelters (roof, glass back, bench, strip light, a lit ad panel)
  for (const s of stops.filter(q => q.canopy === 'shelter')) {
    const [dx, dz] = dirOf(s.heading), [lx, lz] = left(dx, dz), cx = s.pos[0] + lx * 4.1 - dx * 5, cz = s.pos[1] + lz * 4.1 - dz * 5, r = Math.atan2(-dz, dx);
    batch.add(M.whiteMetal, L.boxAt(cx, SW_H + 2.65, cz, 7, 0.16, 2.2, r, false), cx, cz);
    for (const t of [-3.3, 0, 3.3]) batch.add(M.silver, L.boxAt(cx + dx * t + lx * 0.9, SW_H + 1.3, cz + dz * t + lz * 0.9, 0.1, 2.6, 0.1, 0, false), cx, cz);
    batch.add(M.glassClear, L.boxAt(cx + lx * 0.95, SW_H + 1.35, cz + lz * 0.95, 6.6, 1.9, 0.03, r, false), cx, cz);
    batch.add(M.silver, L.boxAt(cx + lx * 0.55, SW_H + 0.44, cz + lz * 0.55, 3.6, 0.06, 0.42, r, false), cx, cz);
    S.ibox(inst, 'lm_stripLight', M.glowWhite, cx, SW_H + 2.52, cz, 0.16, 0.05, 6.4, r + Math.PI / 2);
    S.signQuad(batch, cx - dx * 3.0 + lx * 0.96, SW_H + 1.35, cz - dz * 3.0 + lz * 0.96, -lx, -lz, { text: 'SHIBUYA SKY', sub: '渋谷スクランブルスクエア 屋上展望', w: 1.1, h: 1.7, bg: '#101826', bg2: '#2a3a6a', fg: '#ffffff', emissive: 1.1, weight: '800' });
    colliders.push(S.boxCollider(cx + lx * 0.95, cz + lz * 0.95, 7, 2.7, 0.2, r, SW_H));
  }

  // ---- guard pipes along the platform kerbs, open at every bay (pole to the bus's tail) and at the corners
  const bays = loop.map(s => { const s0 = sOf(s); return [s0 - 11.5, s0 + 1.5]; });
  const kerbS = (x, z) => arcAt(bw.path, x, z);
  guardRun(batch, M, L.offsetPolyline(bw.path, 2.38), field, colliders, (x, z) => { const s = kerbS(x, z); return s > 18 && s < L2 - 20 && !bays.some(([a, b]) => s > a && s < b); });

  // ---- the disused island: raised (streets), its old shelters, barricades and cones round it, the notice
  for (const isl of (CITY.raised || []).filter(r => r.terminal === 'higashi')) {
    // dressed along the island's own (diagonal) axis — the bounding box stood its shelter posts, barricades and
    // collider in the busway beside it (props audit): the axis runs from the mid of the south end to the mid of the
    // north end, everything stays 0.3 m inside the kerbs
    const poly = isl.polygon, A = [(poly[0][0] + poly[1][0]) / 2, (poly[0][1] + poly[1][1]) / 2], B = [(poly[3][0] + poly[4][0]) / 2, (poly[3][1] + poly[4][1]) / 2];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]), ux = (B[0] - A[0]) / len, uz = (B[1] - A[1]) / len, [nx, nz] = left(ux, uz);
    const hw = Math.hypot(poly[1][0] - poly[0][0], poly[1][1] - poly[0][1]) / 2 - 0.3, r = Math.atan2(-uz, ux);
    const at = (t, l) => [A[0] + ux * t + nx * l, A[1] + uz * t + nz * l];
    for (const t0 of [3.5, 10.5]) {
      const pts = [at(t0, -1.2), at(t0 + 5.5, -1.2)];
      canopy(batch, inst, M, X, pts, 2.3, 3.0, colliders, { postEvery: 4 });
      const [bx, bz] = at(t0 + 2.75, -0.7);
      batch.add(M.silver, L.boxAt(bx, SW_H + 0.44, bz, 3.4, 0.06, 0.42, r, false), bx, bz);
    }
    // green-and-white barricades along both long sides, cones at the ends
    for (const l of [-hw, hw]) for (let t = 1.6; t < len - 1.4; t += 2.2) {
      const [x, z] = at(t, l);
      batch.add(X.barrierG, L.boxAt(x, SW_H + 0.75, z, 1.9, 0.18, 0.06, r, false), x, z);
      batch.add(X.barrier, L.boxAt(x, SW_H + 0.52, z, 1.9, 0.18, 0.06, r, false), x, z);
      for (const e of [-0.85, 0.85]) batch.add(M.darkMetal, L.boxAt(x + ux * e, SW_H + 0.42, z + uz * e, 0.05, 0.84, 0.05, 0, false), x, z);
    }
    for (const [t, l] of [[0.7, -hw + 0.4], [0.7, hw - 0.4], [len - 0.7, 0], [len - 1.2, -hw + 0.4]]) {
      const [x, z] = at(t, l);
      const g = new THREE.ConeGeometry(0.2, 0.7, 10); g.translate(x, SW_H + 0.35, z); batch.add(X.cone, g, x, z);
      batch.add(M.darkMetal, L.boxAt(x, SW_H + 0.02, z, 0.42, 0.04, 0.42, 0, false), x, z);
    }
    const [qx, qz] = at(2.2, -hw + 0.2);
    batch.add(M.silver, L.boxAt(qx, SW_H + 0.9, qz, 0.06, 1.8, 0.06, 0, false), qx, qz);
    batch.add(P.mat, L.wallQuad(qx, SW_H + 1.5, qz, -nx, -nz, 1.0, 0.5, 0.04, P.uv.notice), qx, qz);
    batch.add(P.mat, L.wallQuad(qx, SW_H + 1.5, qz, -ux, -uz, 1.0, 0.5, 0.04, P.uv.notice), qx, qz);
    const [cx, cz] = at(len / 2, 0);
    colliders.push(S.boxCollider(cx, cz, len - 0.4, 1.0, 2 * hw + 0.2, r, SW_H));
  }

  // ---- apron markings: the 待機場所 bays round the layover buses, 導流帯 hatching in the throats
  for (const [x, z, rotY] of T.layover || []) {
    const [dx, dz] = dirOf(rotY), [lx, lz] = left(dx, dz), r = Math.atan2(-dz, dx);
    for (const sd of [-1, 1]) batch.add(X.paintW, L.stripRect(x + lx * 1.75 * sd, z + lz * 1.75 * sd, 13, 0.15, r, 0.014), x, z);
    batch.add(X.paintW, L.stripRect(x + dx * 6.5, z + dz * 6.5, 0.15, 3.5, r, 0.014), x, z);
    batch.add(X.paintW, L.stripRect(x - dx * 6.5, z - dz * 6.5, 0.15, 3.5, r, 0.014), x, z);
  }
  const hatch = (poly, ang = 0.75) => {
    const b = L.polyBounds(poly), ca = Math.cos(ang), sa = Math.sin(ang);
    for (let o = -40; o <= 40; o += 1.2) for (let t = -40; t <= 40; t += 0.8) {
      const x = (b.x0 + b.x1) / 2 + ca * t - sa * o, z = (b.z0 + b.z1) / 2 + sa * t + ca * o;
      if (!L.pointInPoly(x, z, poly) || field.sample(x, z) > -0.4) continue;
      batch.add(X.paintW, L.stripRect(x, z, 0.84, 0.3, -ang, 0.013), x, z);
    }
    const ring = [...poly, poly[0]];
    for (let i = 1; i < ring.length; i++) { const a = ring[i - 1], c = ring[i], l = Math.hypot(c[0] - a[0], c[1] - a[1]); batch.add(X.paintW, L.stripRect((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, l, 0.15, Math.atan2(-(c[1] - a[1]), c[0] - a[0]), 0.013), a[0], a[1]); }
  };
  hatch([[137.8, 70.6], [140.6, 68.4], [142.8, 71.4], [139.8, 73.8]], -0.75);  // inside of the SW corner
  hatch([[141.5, 28.2], [145.2, 27.6], [145.8, 33], [142.8, 33]], -0.7);         // by the exit, the taxi island's nose
  hatch([[151.5, 68], [154.6, 66.8], [155.2, 72], [152.2, 72.6]], 0.7);          // by the entry

  // ---- 東口地下広場: the B7 stair house between the JR station and the yard, the lift on the 東口 広場
  {
    const q = [[90.4, 31.8], [97.1, 29.9], [100.3, 41.1], [93.6, 43]], H = 3.6;
    batch.add(M.darkMetal, L.extrudePolygon(q, SW_H + H, SW_H + H + 0.3, { cap: true, bottom: true }), 95, 36);
    for (let i = 0; i < 4; i++) {
      const a = q[i], c = q[(i + 1) % 4], mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2, l = Math.hypot(c[0] - a[0], c[1] - a[1]);
      batch.add(i === 1 ? M.innerDark : M.glassClear, L.boxAt(mx, SW_H + H / 2, mz, l, H, 0.05, Math.atan2(-(c[1] - a[1]), c[0] - a[0]), false), 95, 36);
      for (const t of [0.1, 0.9]) batch.add(M.darkMetal, L.boxAt(a[0] + (c[0] - a[0]) * t, SW_H + H / 2, a[1] + (c[1] - a[1]) * t, 0.12, H, 0.12, 0, false), 95, 36);
    }
    S.ibox(inst, 'lm_stripLight', M.glowWhite, 95.3, SW_H + H - 0.05, 36.4, 0.3, 0.05, 9, 1.29);
    batch.add(P.mat, L.wallQuad(98.7, SW_H + H + 0.9, 35.5, 0.96, -0.27, 3.0, 0.75, 0.05, P.uv.b7), 95, 36);
    colliders.push(S.boxCollider(95.3, 36.4, 7, H + 0.3, 11.6, 1.29, SW_H));
    const lx = 112.1, lz = 14.6, lr = 1.07;
    batch.add(M.glassClear, L.boxAt(lx, SW_H + 1.75, lz, 2.8, 3.5, 3.2, lr, false), lx, lz);
    batch.add(M.darkMetal, L.boxAt(lx, SW_H + 3.6, lz, 3.0, 0.25, 3.4, lr, false), lx, lz);
    batch.add(M.interior, L.boxAt(lx, SW_H + 1.6, lz, 1.4, 2.4, 1.6, lr, false), lx, lz);
    batch.add(P.mat, L.wallQuad(lx + 0.5, SW_H + 3.2, lz - 1.35, 0.48, -0.88, 2.2, 0.55, 0.05, P.uv.lift), lx, lz);
    colliders.push(S.boxCollider(lx, lz, 2.8, 3.6, 3.2, lr, SW_H));
  }

  // ---- the terminal's name pylon with the のりば map, on the 東口 広場 by 宮益坂
  {
    const x = 124, z = 14.2, nx = 0.12, nz = 0.99, r = Math.atan2(-nz, nx) + Math.PI / 2;
    batch.add(M.darkMetal, L.boxAt(x, SW_H + 1.6, z, 2.3, 3.2, 0.36, r, false), x, z);
    batch.add(P.mat, L.wallQuad(x, SW_H + 2.55, z, nx, nz, 2.1, 1.05, 0.2, P.uv.name), x, z);
    batch.add(P.mat, L.wallQuad(x, SW_H + 1.2, z, nx, nz, 2.1, 1.05, 0.2, P.uv.map), x, z);
    batch.add(P.mat, L.wallQuad(x, SW_H + 2.55, z, -nx, -nz, 2.1, 1.05, 0.2, P.uv.name), x, z);
    batch.add(P.mat, L.wallQuad(x, SW_H + 1.2, z, -nx, -nz, 2.1, 1.05, 0.2, P.uv.map), x, z);
    colliders.push(S.boxCollider(x, z, 2.4, 3.2, 0.5, r, SW_H));
  }

  // ---- pole lamps over the apron and the pavements (8 m, twin LED heads)
  // (none under the 銀座線 station: its own soffit lights cover that; a lamp under it would only light the soffit)
  for (const [x, z] of [[133, 45.6], [147.4, 34.5], [114.5, 33], [116, 17], [128.8, 83.6]]) {
    if (field.sample(x, z) < 0.6) continue;
    batch.add(M.darkMetal, L.boxAt(x, SW_H + 4, z, 0.2, 8, 0.2, 0, false), x, z);
    for (const [ax, az] of [[1, 0], [-1, 0]]) {
      batch.add(M.darkMetal, L.boxAt(x + ax * 0.7, SW_H + 7.9, z + az * 0.7, 1.4, 0.1, 0.1, 0, false), x, z);
      S.ibox(inst, 'lm_downlight', M.glowWhite, x + ax * 1.3, SW_H + 7.82, z + az * 1.3, 0.55, 0.1, 0.28);
    }
    colliders.push(S.boxCollider(x, z, 0.3, 8, 0.3, 0, SW_H));
    fixture(x, SW_H + 7.5, z, 0xe8eeff, 115, 30);
  }

  // ---- the 銀座線 station's underside over the terminal: a 20 m white soffit under the box viaduct, lit in three rows,
  //      on three massive piers (the old island, the taxi island, the west pavement)
  const gz = CITY.rail && CITY.rail.ginza;
  if (gz) {
    const pts = slice(gz.path, arcAt(gz.path, 103, 67), arcAt(gz.path, 151.5, 49.3)), y1 = gz.elevation - 1.8, W2 = 10;
    const outline = [...L.offsetPolyline(pts, W2), ...L.offsetPolyline(pts, -W2).reverse()];
    batch.add(M.whiteMetal, L.extrudePolygon(outline, y1 - 0.9, y1 - 0.05, { cap: true, bottom: true, uvScale: 0.25 }), 128, 60);
    batch.add(X.soffit, L.extrudePolygon([...L.offsetPolyline(pts, W2 - 0.4), ...L.offsetPolyline(pts, -W2 + 0.4).reverse()], y1 - 0.94, y1 - 0.92, { cap: false, bottom: true }), 128, 60);
    for (const p of L.alongPolyline(pts, 3.2, 1.2)) {
      const r = Math.atan2(-p.dz, p.dx), [lx, lz] = left(p.dx, p.dz);
      for (const o of [-6.5, 0, 6.5]) S.ibox(inst, 'lm_stripLight', M.glowWhite, p.x + lx * o, y1 - 0.97, p.z + lz * o, 0.16, 0.05, 2.4, r);
    }
    // (each fixture sits inside the slab: it lights the ground and the buses, never its own soffit)
    for (const p of L.alongPolyline(pts, 12, 4)) fixture(p.x, y1 - 0.5, p.z, 0xf2f4ff, 95, 26);
    for (const [x, z] of [[125.4, 61.6], [136.6, 57.1], [149.5, 50.3]]) {
      if (field.sample(x, z) < 1.2) continue;
      batch.add(M.concrete, L.boxAt(x, (y1 - 0.9) / 2, z, 2.4, y1 - 0.9, 2.4, 0.4, true), x, z);
      const cap = new THREE.CylinderGeometry(2.6, 1.3, 2.2, 4, 1); cap.rotateY(Math.PI / 4 + 0.4); cap.translate(x, y1 - 2.0, z);
      batch.add(M.concrete, cap, x, z);
      colliders.push(S.boxCollider(x, z, 2.5, y1, 2.5, 0.4, 0));
    }
  }

  // ---- 2F deck from Scramble Square's north-east corner over 明治通り to ヒカリエ (glazed, lit ceiling)
  {
    const a = [158.2, 88], b = [182.1, 61.9], y0 = 6.6,   // (to ヒカリエ's west face on its real line, pass 12)
    len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
    const r = Math.atan2(-uz, ux), cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2, w = 8;
    batch.add(M.whiteMetal, L.boxAt(cx, y0, cz, len, 1.1, w, r, false), cx, cz);
    batch.add(X.soffit, L.boxAt(cx, y0 - 0.56, cz, len - 0.4, 0.02, w - 0.4, r, false), cx, cz);
    batch.add(M.whiteMetal, L.boxAt(cx, y0 + 3.9, cz, len, 0.45, w + 0.4, r, false), cx, cz);
    for (const sd of [-1, 1]) batch.add(M.glassClear, L.boxAt(cx - uz * sd * w / 2, y0 + 2.15, cz + ux * sd * w / 2, len, 3.1, 0.06, r, false), cx, cz);
    batch.add(M.interiorDim, L.boxAt(cx, y0 + 3.62, cz, len - 0.6, 0.06, w - 1.2, r, false), cx, cz);
    for (let t = 2; t < len; t += 3.2) for (const sd of [-1, 1]) { const x = a[0] + ux * t - uz * sd * w / 2, z = a[1] + uz * t + ux * sd * w / 2; batch.add(M.silver, L.boxAt(x, y0 + 2.15, z, 0.1, 3.1, 0.1, 0, false), cx, cz); }
    for (let t = 1.5; t < len; t += 2.4) S.ibox(inst, 'lm_stripLight', M.glowWhite, a[0] + ux * t, y0 - 0.58, a[1] + uz * t, 0.12, 0.04, w - 1, r + Math.PI / 2);
    S.signQuad(batch, a[0] + ux * 3 - uz * (w / 2 + 0.1), y0 + 1.2, a[1] + uz * 3 + ux * (w / 2 + 0.1), -uz, ux, { text: 'ヒカリエ ⇄ 渋谷スクランブルスクエア', sub: '2F 連絡デッキ', w: 5, h: 0.7, bg: '#1b2748', fg: '#ffffff', emissive: 0.9, weight: '800' });
  }
  return { colliders };
}

export default { buildEastExit };
