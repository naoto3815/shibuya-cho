// [city] 渋谷町駅 西口 bus terminal dressing (real layout, OSM 2026-09 — see cityData BUSWAYS / BUS_STOPS / SITES):
// long lit canopies on the island platforms east of the bus-only lane, のりば poles at every stop, kerb shelters on the
// 南行 pavement, white guard pipes on the separator and along the platforms, and the 渋谷駅街区 中央棟・西棟 construction
// yard between the 南行 pavement and the JR station (printed hoarding with work lamps, a rising steel frame with
// netting either side of the 銀座線 viaduct, a luffing tower crane with its red lamps).
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { SW_H } from './streets.js';

let hoardMat = null, netMat = null, hoardMatE = null;
/** 16 m × 3.2 m hoarding print: steel panels, green cap band, the project artwork and the apology line. */
function hoarding(print) {
  if (print === 'higashi') return hoardingEast();
  if (hoardMat) return hoardMat;
  const W = 2048, H = 410, c = L.makeCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#e9ebe6'; g.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 64) { g.fillStyle = 'rgba(80,86,90,0.28)'; g.fillRect(x, 0, 2, H); g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(x + 2, 0, 1, H); }
  g.fillStyle = '#2f8f4e'; g.fillRect(0, 0, W, 22); g.fillStyle = '#3b3f44'; g.fillRect(0, H - 26, W, 26);
  // navy panel: wordmark + project line + a white line skyline
  g.fillStyle = '#1b2748'; g.fillRect(40, 58, 1080, 290);
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 3; g.beginPath(); g.moveTo(70, 318);
  const sky = [[70, 318], [120, 318], [120, 250], [170, 250], [170, 200], [205, 200], [205, 150], [240, 150], [240, 110], [262, 96], [284, 110], [284, 318], [330, 318], [330, 230], [380, 230], [380, 318], [430, 318]];
  for (const [x, y] of sky) g.lineTo(x, y);
  g.stroke();
  g.fillStyle = '#ffffff'; g.font = `800 96px ${L.FONT_LATIN}`; g.textBaseline = 'alphabetic';
  g.save(); g.translate(470, 190); g.fillText('SHIBUYA', 0, 0); g.restore();
  g.font = `700 34px ${L.FONT_JP}`; g.fillText('渋谷町駅街区 開発計画  中央棟 ・ 西棟', 470, 250);
  g.font = `500 26px ${L.FONT_JP}`; g.fillStyle = '#c9d4ea'; g.fillText('2027年度 開業予定  ―  新しい渋谷町駅へ', 470, 296);
  // light panel: pale rendering of the finished towers
  const gr = g.createLinearGradient(0, 58, 0, 348); gr.addColorStop(0, '#cfe3f2'); gr.addColorStop(1, '#f4f7f8');
  g.fillStyle = gr; g.fillRect(1180, 58, 820, 290);
  for (const [x, w, h] of [[1260, 120, 250], [1400, 150, 200], [1570, 90, 270], [1680, 140, 160]]) {
    g.fillStyle = 'rgba(120,150,180,0.55)'; g.fillRect(x, 348 - h, w, h);
    g.fillStyle = 'rgba(255,255,255,0.55)'; for (let yy = 348 - h + 10; yy < 340; yy += 14) g.fillRect(x + 6, yy, w - 12, 4);
  }
  g.fillStyle = '#1b2748'; g.font = `800 40px ${L.FONT_JP}`; g.fillText('未来の渋谷町駅へ。', 1830 - 330, 110);
  g.font = `500 22px ${L.FONT_JP}`; g.fillStyle = '#3a4150'; g.fillText('ご通行の皆様にはご迷惑をおかけしております', 1470, 380);
  hoardMat = L.signMaterial(c, { emissive: 0.42, roughness: 0.62 });
  hoardMat.name = 'wx_hoarding';
  return hoardMat;
}
/** The 東口 yard's print (渋谷駅東口 土地区画整理, the future 東口 広場): white panels, a green band, the plaza rendering
 *  and the works notice. */
function hoardingEast() {
  if (hoardMatE) return hoardMatE;
  const W = 2048, H = 384, c = L.makeCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#eef0ec'; g.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 64) { g.fillStyle = 'rgba(80,86,90,0.25)'; g.fillRect(x, 0, 2, H); g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(x + 2, 0, 1, H); }
  g.fillStyle = '#6cbf3a'; g.fillRect(0, 0, W, 24); g.fillStyle = '#3b3f44'; g.fillRect(0, H - 24, W, 24);
  // left: the plaza rendering (trees, canopy, people) on a sky gradient
  const gr = g.createLinearGradient(0, 50, 0, 330); gr.addColorStop(0, '#bfe0f0'); gr.addColorStop(1, '#f4f7f4');
  g.fillStyle = gr; g.fillRect(40, 50, 860, 280);
  g.fillStyle = 'rgba(160,168,176,0.7)'; g.fillRect(40, 250, 860, 80);
  g.fillStyle = '#ffffff'; g.fillRect(120, 150, 560, 16); for (let x = 140; x < 680; x += 90) g.fillRect(x, 166, 8, 84);
  for (const [x, r] of [[90, 46], [760, 58], [840, 40]]) { g.fillStyle = '#5e9e4a'; g.beginPath(); g.arc(x, 250 - r, r, 0, Math.PI * 2); g.fill(); g.fillStyle = '#6b5a44'; g.fillRect(x - 4, 250 - r / 2, 8, r / 2 + 6); }
  for (let i = 0; i < 16; i++) { const x = 110 + i * 46 + (i % 3) * 7, h = 34 + (i % 4) * 5; g.fillStyle = ['#2d3a4c', '#8a4a3a', '#3a5a7a', '#555'][i % 4]; g.fillRect(x, 300 - h, 12, h); g.beginPath(); g.arc(x + 6, 300 - h - 7, 7, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#1b2748'; g.font = `800 64px ${L.FONT_JP}`; g.textBaseline = 'alphabetic';
  g.fillText('ひろがる、東口。', 950, 150);
  g.font = `700 32px ${L.FONT_JP}`; g.fillText('渋谷町駅東口 土地区画整理事業', 950, 212);
  g.font = `500 28px ${L.FONT_JP}`; g.fillStyle = '#3a4150'; g.fillText('東口広場 ・ 地上歩行者空間 整備工事', 950, 256);
  g.font = `500 22px ${L.FONT_JP}`; g.fillText('バスのりば・タクシーのりばの位置が変わっています。ご注意ください。', 950, 300);
  g.fillText('ご通行の皆様にはご迷惑をおかけしております', 950, 336);
  hoardMatE = L.signMaterial(c, { emissive: 0.42, roughness: 0.62 });
  hoardMatE.name = 'wx_hoardingE';
  return hoardMatE;
}
function netting() {
  if (netMat) return netMat;
  const c = L.makeCanvas(128, 128), g = c.getContext('2d');
  g.fillStyle = '#9aa8b4'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(40,48,56,0.55)'; for (let i = 0; i < 128; i += 8) { g.fillRect(i, 0, 2, 128); g.fillRect(0, i, 128, 2); }
  netMat = L.std({ map: L.canvasTex(c, { repeat: [1, 1], wrap: true }), transparent: true, opacity: 0.38, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, depthWrite: false, emissive: 0x3a4450, emissiveIntensity: 0.35 });
  netMat.name = 'wx_netting'; netMat.userData.noShadow = true;
  return netMat;
}
const left = (dx, dz) => [dz, -dx];   // left of travel (cityData / offsetPolyline convention)
const dirOf = (rotY) => [Math.cos(rotY), -Math.sin(rotY)];

/** Guard pipes (ガードパイプ, 0.8 m, white) along a polyline, only where the field says pavement / island. */
function guardRun(batch, M, pts, field, colliders, keep = () => true) {
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
  for (const p of L.alongPolyline(pts, 2, 1)) {
    if (field.sample(p.x, p.z) > 0.45 && keep(p.x, p.z)) run.push(p); else flush();
  }
  flush();
}

export function buildWestExit({ CITY, batch, inst, field }) {
  const M = S.mats();
  const colliders = [];
  const bus = (CITY.busways || [])[0];
  const sb = CITY.roads.find(r => r.id === 'ekimae_sb');
  const cuts = (CITY.crosswalksExtra || []).filter(c => c.stops);
  const nearCut = (x, z, pad) => cuts.some(c => L.distToSegment(x, z, c.a[0], c.a[1], c.b[0], c.b[1]) < c.width / 2 + pad);
  // ---- island platform canopies: posts every 6 m along the platform, 3.2 m roof, strip lights, fascia facing the bus
  if (bus) {
    const line = L.offsetPolyline(bus.path, bus.width / 2 + 2.1);
    let seg = [];
    const flush = () => {
      if (seg.length >= 2) {
        for (let i = 1; i < seg.length; i++) {
          const a = seg[i - 1], b = seg[i], l = Math.hypot(b.x - a.x, b.z - a.z) + 0.05, r = Math.atan2(-(b.z - a.z), b.x - a.x), mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
          const [lx, lz] = left(b.x - a.x, b.z - a.z).map(v => v / (l - 0.05));
          batch.add(M.whiteMetal, L.boxAt(mx, SW_H + 3.35, mz, l, 0.22, 3.4, r, false), mx, mz);                         // roof
          batch.add(M.silver, L.boxAt(mx - lx * 1.72, SW_H + 3.25, mz - lz * 1.72, l, 0.42, 0.06, r, false), mx, mz);   // fascia (bus side)
          batch.add(M.silver, L.boxAt(mx + lx * 1.72, SW_H + 3.25, mz + lz * 1.72, l, 0.42, 0.06, r, false), mx, mz);
          S.ibox(inst, 'lm_stripLight', M.glowWhite, mx, SW_H + 3.18, mz, 0.16, 0.05, l - 0.6, r + Math.PI / 2);
        }
        for (const [k, p] of seg.entries()) {
          if (k % 2) continue;
          batch.add(M.silver, L.boxAt(p.x, SW_H + 1.65, p.z, 0.16, 3.3, 0.16, 0, false), p.x, p.z);
          colliders.push(S.boxCollider(p.x, p.z, 0.3, 3.4, 0.3, 0, SW_H));
          if (k % 4 === 2) {   // metal bench between posts
            const [lx, lz] = left(p.dx, p.dz), r = Math.atan2(-p.dz, p.dx);
            batch.add(M.silver, L.boxAt(p.x + lx * 0.6, SW_H + 0.44, p.z + lz * 0.6, 1.8, 0.06, 0.42, r, false), p.x, p.z);
            batch.add(M.darkMetal, L.boxAt(p.x + lx * 0.6, SW_H + 0.21, p.z + lz * 0.6, 1.6, 0.42, 0.08, r, false), p.x, p.z);
          }
        }
      }
      seg = [];
    };
    for (const p of L.alongPolyline(line, 3, 1.5)) {
      const onIsland = field.sample(p.x, p.z) > 1.3 && field.sample(p.x + left(p.dx, p.dz)[0] * 1.2, p.z + left(p.dx, p.dz)[1] * 1.2) > 0.25 && field.sample(p.x - left(p.dx, p.dz)[0] * 1.2, p.z - left(p.dx, p.dz)[1] * 1.2) > 0.25;
      if (onIsland && !nearCut(p.x, p.z, 1.2) && p.z > 58) seg.push(p); else flush();
    }
    flush();
    // separator guard pipes (north-bound / bus lane) and the platform's fence along the 南行 kerb
    guardRun(batch, M, L.offsetPolyline(bus.path, -(bus.width / 2 + 0.65)), field, colliders, (x, z) => !nearCut(x, z, 0.6) && z > 60);
    if (sb) guardRun(batch, M, L.offsetPolyline(sb.path, -(sb.width / 2 + 0.45)), field, colliders, (x, z) => !nearCut(x, z, 0.6) && z > 58 && z < 132);
  }
  // ---- のりば poles for every 西口 stop, kerb shelters on the 南行 pavement (the 東口 terminal is eastExit.js's)
  for (const s of CITY.busStops || []) {
    if (s.terminal) continue;
    const [dx, dz] = dirOf(s.heading), [lx, lz] = left(dx, dz);
    // the pole stands on the stop's kerb, 0.6 m back from the edge: whichever side of the bay is pavement, walked up
    // the street field if the stop sits off the kerb, and slid along the kerb off any zebra landing (props audit)
    let px = s.pos[0] + lx * 2.75 + dx * 4.5, pz = s.pos[1] + lz * 2.75 + dz * 4.5;
    if (field) {
      const qx = s.pos[0] - lx * 2.75 + dx * 4.5, qz = s.pos[1] - lz * 2.75 + dz * 4.5;
      if (field.sample(qx, qz) > field.sample(px, pz)) { px = qx; pz = qz; }
      for (let k = 0; k < 40 && field.sample(px, pz) < 0.6; k++) {
        const gx = field.sample(px + 0.25, pz) - field.sample(px - 0.25, pz), gz = field.sample(px, pz + 0.25) - field.sample(px, pz - 0.25), gl = Math.hypot(gx, gz) || 1;
        px += gx / gl * 0.2; pz += gz / gl * 0.2;
      }
      const onZebra = (x, z) => (CITY.crosswalksExtra || []).concat((CITY.crossing && CITY.crossing.crosswalks) || []).some((c) => { const ux = c.b[0] - c.a[0], uz = c.b[1] - c.a[1], ln = Math.hypot(ux, uz) || 1, t = ((x - c.a[0]) * ux + (z - c.a[1]) * uz) / ln; return t > -1.2 && t < ln + 1.2 && Math.abs((-(x - c.a[0]) * uz + (z - c.a[1]) * ux) / ln) < (c.width || 6) / 2 + 0.4; });
      for (let k = 1; k <= 12 && onZebra(px, pz); k++) { px += dx * 0.8 * (k % 2 ? k : -k); pz += dz * 0.8 * (k % 2 ? k : -k); }
    }
    batch.add(M.silver, L.boxAt(px, SW_H + 1.3, pz, 0.08, 2.6, 0.08, 0, false), px, pz);
    const col = /京王/.test(s.op) ? '#c8102e' : /小田急/.test(s.op) ? '#1c56b7' : /ハチ公/.test(s.op) ? '#e8830c' : /富士急/.test(s.op) ? '#1d8f3e' : '#b8141c';
    S.signQuad(batch, px, SW_H + 2.25, pz, dx, dz, { text: s.ref, sub: s.alight ? '降車専用' : 'のりば', w: 0.62, h: 0.8, bg: '#dcdad2', fg: col, emissive: 0.6, weight: '900', double: true });
    S.signQuad(batch, px, SW_H + 1.55, pz, dx, dz, { text: s.op, w: 0.62, h: 0.26, bg: col, fg: '#ffffff', emissive: 0.6, weight: '800', double: true });
    colliders.push(S.boxCollider(px, pz, 0.2, 2.6, 0.2, 0, SW_H));
    if (s.kerb !== 'east') continue;
    // 8 m shelter 0.5–2.9 m behind the kerb: 3 posts, roof, back glass, bench, strip light, a lit ad panel at the end
    const cx = s.pos[0] + lx * 3.65, cz = s.pos[1] + lz * 3.65, r = Math.atan2(-dz, dx);
    batch.add(M.whiteMetal, L.boxAt(cx, SW_H + 2.65, cz, 8, 0.16, 2.6, r, false), cx, cz);
    for (const t of [-3.8, 0, 3.8]) batch.add(M.silver, L.boxAt(cx + dx * t + lx * 1.1, SW_H + 1.3, cz + dz * t + lz * 1.1, 0.1, 2.6, 0.1, 0, false), cx, cz);
    batch.add(M.glassClear, L.boxAt(cx + lx * 1.15, SW_H + 1.35, cz + lz * 1.15, 7.4, 1.9, 0.03, r, false), cx, cz);
    batch.add(M.silver, L.boxAt(cx + lx * 0.7, SW_H + 0.44, cz + lz * 0.7, 4.2, 0.06, 0.42, r, false), cx, cz);
    S.ibox(inst, 'lm_stripLight', M.glowWhite, cx, SW_H + 2.52, cz, 0.16, 0.05, 7.2, r + Math.PI / 2);
    S.signQuad(batch, cx + dx * 3.3 + lx * 1.12, SW_H + 1.35, cz + dz * 3.3 + lz * 1.12, -lx, -lz, { text: ['渋谷町交通', 'Tojo Cola', 'SHIBUYA SKY', 'サンシャインビール', '渋谷町 区政だより'][Number(s.ref) % 5], sub: '渋谷町駅 西口', w: 1.2, h: 1.8, bg: '#1b2748', bg2: '#3a5a9a', fg: '#ffffff', emissive: 1.1, weight: '800' });
    colliders.push(S.boxCollider(cx + lx * 1.15, cz + lz * 1.15, 8, 2.7, 0.2, r, SW_H));
  }
  // ---- the construction yard
  for (const site of CITY.sites || []) buildSite(site, { batch, inst, M, colliders, CITY });
  return { colliders };
}

function buildSite(site, { batch, inst, M, colliders }) {
  const poly = L.ensureCW(site.polygon), H = site.hoarding || 3.2, mat = hoarding(site.print);
  const c = L.polyCentroid(poly);
  // hoarding: steel wall + the print on the outside, green cap, work lamps and amber warning lamps along the top
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const [nx, nz] = L.edgeNormal(poly, i), tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len, r = Math.atan2(-tz, tx);
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    batch.add(M.whiteMetal, L.boxAt(mx - nx * 0.08, SW_H + H / 2, mz - nz * 0.08, len + 0.1, H, 0.14, r, false), c[0], c[1]);
    for (let s = 0; s < len - 0.2; s += 16) {
      const w = Math.min(16, len - s), cx = a[0] + tx * (s + w / 2), cz = a[1] + tz * (s + w / 2);
      batch.add(mat, L.wallQuad(cx, SW_H + H / 2, cz, nx, nz, w, H, 0.005, [0, 0, w / 16, 1]), c[0], c[1]);
    }
    for (let s = 3; s < len - 1; s += 8) {
      const x = a[0] + tx * s + nx * 0.3, z = a[1] + tz * s + nz * 0.3;
      S.ibox(inst, 'lm_downlight', M.glowWarm, x, SW_H + H + 0.02, z, 0.36, 0.12, 0.2, r);
      batch.add(M.darkMetal, L.boxAt(x - nx * 0.15, SW_H + H + 0.1, z - nz * 0.15, 0.08, 0.3, 0.4, r, false), c[0], c[1]);
    }
    for (let s = 7; s < len - 1; s += 12) S.ibox(inst, 'lm_aviation', M.glowOrange, a[0] + tx * s, SW_H + H + 0.05, a[1] + tz * s, 0.18, 0.16, 0.18);
    colliders.push(S.boxCollider(mx - nx * 0.1, mz - nz * 0.1, len, H + 0.2, 0.3, r, 0));
  }
  // project board on the terminal face (west at 西口, east at 東口) + the vehicle gate on the north face
  const east = site.print === 'higashi';
  const west = L.bestEdge(poly, east ? 1 : -1, 0), north = L.bestEdge(poly, 0, -1);
  if (west) S.signQuad(batch, west.mid[0] + west.nx * 0.03, SW_H + 1.7, west.mid[1] + west.nz * 0.03, west.nx, west.nz, east
    ? { text: '渋谷町駅東口 土地区画整理事業 東口広場整備工事', sub: '工期 2024年 〜 2028年度   施行 渋谷町駅東口土地区画整理事業共同施行者', w: 7.2, h: 1.4, bg: '#ffffff', fg: '#1b2748', emissive: 0.7, weight: '800' }
    : { text: '渋谷町駅街区 中央棟・西棟 新築工事', sub: '工期 2021年6月 〜 2027年度   施工 東光・大城 建設共同企業体', w: 7.2, h: 1.4, bg: '#ffffff', fg: '#1b2748', emissive: 0.7, weight: '800' });
  if (north) {
    const gx = north.mid[0] + north.tx * 6, gz = north.mid[1] + north.tz * 6;
    batch.add(M.darkMetal, L.boxAt(gx + north.nx * 0.05, SW_H + 1.75, gz + north.nz * 0.05, 7, 3.5, 0.1, Math.atan2(-north.tz, north.tx), false), gx, gz);
    S.signQuad(batch, gx + north.nx * 0.12, SW_H + 2.2, gz + north.nz * 0.12, north.nx, north.nz, { text: '工事用車両出入口', sub: '関係者以外立入禁止', w: 3.4, h: 0.9, bg: '#ffd400', fg: '#111111', emissive: 0.8, weight: '900' });
    S.ibox(inst, 'lm_aviation', M.glowRed, gx + north.tx * 3.6 + north.nx * 0.2, SW_H + 3.6, gz + north.tz * 3.6 + north.nz * 0.2, 0.3, 0.3, 0.3);
  }
  if (!site.frames) return;
  // steel frames either side of the 銀座線 / walkway corridor (z 73–96): columns, beams, slabs, primer caps, netting
  const blocks = [
    { x0: 2, x1: 26, z0: 60.8, z1: 71.8, nx: 5, nz: 3, done: 6, cols: 8 },
    { x0: 11, x1: 26.5, z0: 99, z1: 120.5, nx: 4, nz: 5, done: 10, cols: 12 },
  ];
  const LV = 4.2, net = netting();
  for (const [bi, bk] of blocks.entries()) {
    const xs = [], zs = [];
    for (let i = 0; i < bk.nx; i++) xs.push(bk.x0 + i * (bk.x1 - bk.x0) / (bk.nx - 1));
    for (let j = 0; j < bk.nz; j++) zs.push(bk.z0 + j * (bk.z1 - bk.z0) / (bk.nz - 1));
    const top = bk.cols * LV, cx = (bk.x0 + bk.x1) / 2, cz = (bk.z0 + bk.z1) / 2, w = bk.x1 - bk.x0, d = bk.z1 - bk.z0;
    for (const x of xs) for (const z of zs) batch.add(M.darkMetal, L.boxAt(x, SW_H + top / 2, z, 0.5, top, 0.5, 0, false), cx, cz);
    for (let l = 1; l <= bk.cols; l++) {
      const y = SW_H + l * LV;
      for (const z of zs) batch.add(l > bk.done ? M.redPaint : M.darkMetal, L.boxAt(cx, y - 0.25, z, w, 0.5, 0.3, 0, false), cx, cz);
      for (const x of xs) batch.add(l > bk.done ? M.redPaint : M.darkMetal, L.boxAt(x, y - 0.25, cz, 0.3, 0.5, d, 0, false), cx, cz);
      if (l <= bk.done) {
        batch.add(M.concrete, L.boxAt(cx, y + 0.08, cz, w - 0.4, 0.16, d - 0.4, 0, true), cx, cz);
        if (l % 2 === 0 || l === bk.done) S.rimLights(inst, L.rectPoly(cx, cz, w - 0.2, d - 0.2, 0), y + 0.5, { step: 5, out: 0.1 });
        if (l % 3 === 1) for (const [fx, fz] of [[bk.x0 - 0.3, bk.z0 + 1.5], [bk.x0 - 0.3, bk.z1 - 1.5], [cx, bi === 0 ? bk.z0 - 0.3 : bk.z1 + 0.3]]) S.ibox(inst, 'lm_downlight', M.glowWarm, fx, y + 1.6, fz, 0.5, 0.3, 0.5);
      }
    }
    // netting over the finished floors on the public faces (west + north / south), a lit site office cabin on block 0
    const nh = bk.done * LV;
    batch.add(net, L.wallQuad(bk.x0 - 0.4, SW_H + LV + nh / 2, cz, -1, 0, d + 0.8, nh - LV * 0.3, 0.0, [0, 0, d / 4, nh / 4]), cx, cz);
    batch.add(net, L.wallQuad(cx, SW_H + LV + nh / 2, bi === 0 ? bk.z0 - 0.4 : bk.z1 + 0.4, 0, bi === 0 ? -1 : 1, w + 0.8, nh - LV * 0.3, 0.0, [0, 0, w / 4, nh / 4]), cx, cz);
    colliders.push(S.boxCollider(cx, cz, w + 0.6, top, d + 0.6, 0, 0));
    if (bi === 0) {
      batch.add(M.whiteMetal, L.boxAt(cx - 4, SW_H + 1.3, cz, 6, 2.6, 2.6, 0, true), cx, cz);
      batch.add(M.interior, L.wallQuad(cx - 4, SW_H + 1.5, cz - 1.31, 0, -1, 4.6, 0.9, 0.01), cx, cz);
    }
    // tower crane on block 1: lattice mast, jib luffed toward the station, counter-jib, cab, red lamps
    if (bi === 1) {
      const mx = bk.x1 - 3, mz = bk.z0 + 3, mastH = top + 26, y0 = SW_H;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) batch.add(M.whiteMetal, L.boxAt(mx + a * 0.8, y0 + mastH / 2, mz + b * 0.8, 0.16, mastH, 0.16, 0, false), mx, mz);
      for (let y = 2; y < mastH; y += 2.4) {
        batch.add(M.whiteMetal, L.boxAt(mx, y0 + y, mz - 0.8, 1.7, 0.1, 0.1, 0, false), mx, mz); batch.add(M.whiteMetal, L.boxAt(mx, y0 + y, mz + 0.8, 1.7, 0.1, 0.1, 0, false), mx, mz);
        batch.add(M.whiteMetal, L.boxAt(mx - 0.8, y0 + y + 1.2, mz, 0.1, 0.1, 1.7, 0, false), mx, mz); batch.add(M.whiteMetal, L.boxAt(mx + 0.8, y0 + y + 1.2, mz, 0.1, 0.1, 1.7, 0, false), mx, mz);
      }
      const ja = 2.21, jx = Math.cos(ja), jz = -Math.sin(ja), jr = ja;   // jib toward the north-west, over the yard
      const lift = 12;   // luffing jib raised ~35°
      const jl = 38, jc = Math.cos(0.6), js = Math.sin(0.6);
      const jmx = mx + jx * jl / 2 * jc, jmz = mz + jz * jl / 2 * jc, jmy = y0 + mastH + 1 + jl / 2 * js;
      const jib = L.boxAt(0, 0, 0, jl, 1.1, 1.0, 0, false); jib.rotateZ(0.6); jib.rotateY(jr); jib.translate(jmx, jmy, jmz);
      batch.add(M.whiteMetal, jib, mx, mz);
      batch.add(M.whiteMetal, L.boxAt(mx - jx * 8, y0 + mastH + 1.2, mz - jz * 8, 14, 1.2, 1.6, jr, false), mx, mz);
      batch.add(M.concrete, L.boxAt(mx - jx * 13, y0 + mastH - 0.4, mz - jz * 13, 3.2, 2.6, 2.2, jr, true), mx, mz);
      batch.add(M.panelWhite, L.boxAt(mx + jx * 1.6, y0 + mastH - 0.6, mz + jz * 1.6, 2.2, 2.2, 2.2, jr, true), mx, mz);
      batch.add(M.whiteMetal, L.boxAt(mx, y0 + mastH + 3.5, mz, 1.1, 5, 1.1, jr, false), mx, mz);
      const tipX = mx + jx * jl * jc, tipZ = mz + jz * jl * jc, tipY = y0 + mastH + 1 + jl * js;
      batch.add(M.darkMetal, L.boxAt(tipX, tipY - lift - 8, tipZ, 0.04, 2 * (lift + 8) - 0.5, 0.04, 0, false), mx, mz);   // hoist line
      batch.add(M.whiteMetal, L.boxAt(tipX, tipY - 2 * (lift + 8) + 0.3, tipZ, 0.6, 0.6, 0.6, 0, false), mx, mz);
      for (const [x, y, z, s] of [[mx, y0 + mastH + 6.2, mz, 0.8], [tipX, tipY + 0.8, tipZ, 0.7], [mx + jx * jl / 2 * jc, jmy + 0.8, mz + jz * jl / 2 * jc, 0.55], [mx - jx * 14, y0 + mastH + 2, mz - jz * 14, 0.55]]) S.ibox(inst, 'lm_aviation', M.glowRed, x, y, z, s, s * 0.8, s);
      // two floodlight heads on the frame top light the deck
      for (const [x, z] of [[bk.x0 + 1, bk.z0 + 1], [bk.x0 + 1, bk.z1 - 1]]) batch.add(M.glowWhite, L.boxAt(x, SW_H + bk.done * LV + 2.2, z, 0.5, 0.35, 0.5, 0, false), x, z);
    }
  }
}

export default { buildWestExit };
