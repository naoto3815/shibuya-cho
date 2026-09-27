// [city] 渋谷スクランブルスクエア — 230 m glass tower directly over the station east of the JR tracks (rotY 0.15):
// 5-storey podium with lit shopfronts, three stepped shaft segments of blue curtain wall with silver vertical fins
// and slab-edge rings, the SHIBUYA SKY open roof deck with a lit glass rim and bulkhead. Signage adds the crown
// lettering / tickers relative to the (rotated) landmark group.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE, railAlong } from './genericBuilding.js';
import { escalator, stair, well } from './escalator.js';


export const KEYS = ['scrambleSquare'];
export const SIZE = { w: 50, d: 66, h: 230 };

// ---- the base, to the real outline (OSM building 617560918, 2026): the ground floor follows the real walls — the
// 明治通り face on the pavement line (the old 58 × 74 m block stood on the pavement and 4 m into the kerb lane), the
// north face 7 m back from the 東口 terminal's 51 kerb, the west face clear of the JR viaduct — while floors 2–5 keep the
// old mass out to the 明治通り kerb line (a 5 m arcade over the pavement) and over the terminal pavement (the white
// soffit over のりば 51). The 東口 アーバン・コア (隈研吾, 2019) fills the north-east corner: a glazed, lattice-framed
// atrium from the street to 3F with escalators up to the 2F deck from ヒカリエ and on to 3F (JR 中央改札, 銀座線),
// and down to the 東京メトロ 副都心線・半蔵門線 / 東急東横線・田園都市線 concourse (a real well: CITY.groundHoles).
// Metro exit 15 (stairs down) is set into the 明治通り face. (client: 「ここらへんのスクランブルスクエアには上に上がる
// エスカレーターや地下鉄に行くエスカレーターがある」)
const GF_H = 5.4;                                        // the ground floor's soffit (1F is double height)
const Y2 = 7.1, Y3 = 13.1;                              // 2F (deck level) and 3F (JR 中央改札 / 銀座線 level) floors
function isect(a, b, c, d) { const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0]; if (Math.abs(den) < 1e-9) return null; const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den; return [a[0] + r[0] * t, a[1] + r[1] * t]; }
/** Sutherland–Hodgman: keep the part of `P` on `keep`'s side of every segment line of the polyline `line`. */
function clipByPolyline(P, line, keep) {
  let out = P;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1], side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const sk = Math.sign(side(keep)); if (!sk) continue;
    const next = [];
    for (let k = 0; k < out.length; k++) {
      const p = out[k], q = out[(k + 1) % out.length], sp = side(p) * sk, sq = side(q) * sk;
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    out = next;
  }
  return out;
}

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide, CITY, engine, field }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos, rot = data.rotY || 0;
  const [W, H, D] = data.size;
  const rp = (w, d) => L.rectPoly(px, pz, w, d, rot);
  const colliders = [], facades = [];
  const SH = 4.4;
  const lighting = engine && engine.get ? engine.get('lighting') : null;
  const fixture = (x, y, z, color, intensity, distance) => { if (lighting && lighting.addFixture) lighting.addFixture({ pos: [x, y, z], color, intensity, distance, kind: 'uc' }); };
  // ---- outlines
  const PH = 22, pod = rp(W + 8, D + 8);
  const meiji = (CITY.roads || []).find((r) => r.id === 'meiji_ne'), jr = CITY.rail && CITY.rail.jr;
  const kerb = meiji ? L.offsetPolyline(meiji.path, -(meiji.width / 2 + 0.3)) : null;
  const jrEdge = jr ? L.offsetPolyline(jr.path, jr.width / 2 + 1.0) : null;
  let upper = pod;
  if (kerb) upper = clipByPolyline(upper, kerb.filter((p) => p[1] > 40 && p[1] < 190), [px, pz]);
  if (jrEdge) upper = clipByPolyline(upper, jrEdge.filter((p) => p[1] > 60 && p[1] < 200), [px, pz]);
  const G = data.groundFloor;                            // real outline (cityData), corner = the アーバン・コア corner
  const c = G.corner, wN = [G.north[0] - c[0], G.north[1] - c[1]], wE = [G.east[0] - c[0], G.east[1] - c[1]];
  const nrm = (v) => { const l = Math.hypot(v[0], v[1]); return [v[0] / l, v[1] / l]; };
  const uN = nrm(wN), uE = nrm(wE);
  const U = (u, v) => [c[0] + uN[0] * u + uE[0] * v, c[1] + uN[1] * u + uE[1] * v];   // UC frame: u west along the north face, v south along the east face
  const a = U(18, 0), b = U(0, 16), d = U(18, 16);
  // the upper floors: the corner above the core is cut on the lines through a (parallel to the east face) and b
  // (parallel to the north face) out to the upper outline
  let ne = 0; upper.forEach((p, i) => { if (p[0] - p[1] > upper[ne][0] - upper[ne][1]) ne = i; });
  const cU = upper[ne], prevU = upper[(ne + upper.length - 1) % upper.length], nextU = upper[(ne + 1) % upper.length];
  const a2 = isect(a, [a[0] - uE[0], a[1] - uE[1]], prevU, cU) || a, b2 = isect(b, [b[0] - uN[0], b[1] - uN[1]], cU, nextU) || b;
  const upperN = [...upper.slice(0, ne), a2, d, b2, ...upper.slice(ne + 1)];
  const x15 = G.exit15;                                   // Metro exit 15: recess into the 明治通り face
  const gf = [...G.before, a, d, b, [x15.face0, x15.z0], [x15.x, x15.z0], [x15.x, x15.z1], [x15.face1, x15.z1], ...G.after];
  // ---- ground floor: dark glazing behind the arcade, the real shopfronts, entrances
  S.prism(batch, M.darkGrid, gf, 0, GF_H, { uvScale: 3.5 / SH });
  colliders.push(...L.edgeColliders(gf, GF_H, 1.2));
  // ---- floors 2–5 over the arcade: white soffit with downlights where they overhang the ground floor
  S.prism(batch, M.darkGrid, upperN, GF_H, PH, { uvScale: 3.5 / SH });
  batch.add(M.whiteMetal, L.extrudePolygon(upperN, GF_H - 0.36, GF_H - 0.35, { cap: false, bottom: true, sides: false, uvScale: 0.5 }), px, pz);   // the soffit
  S.rings(batch, M.darkMetal, upperN, GF_H + SH, PH - 0.5, SH, { out: 0.3, h: 0.3 });
  S.parapet(batch, M.darkMetal, upperN, PH, { h: 1.2, t: 0.4 });
  batch.add(M.silver, L.extrudePolygon(upperN, GF_H - 0.35, GF_H + 0.4, { cap: false, uvScale: 1 }), px, pz);                  // fascia band
  {
    const bb = L.polyBounds(upperN);
    for (let x = bb.x0 + 2; x < bb.x1; x += 4.5) for (let z = bb.z0 + 2; z < bb.z1; z += 4.5) {
      if (!L.pointInPoly(x, z, upperN) || L.pointInPoly(x, z, gf)) continue;
      if (L.pointInPoly(x, z, [a2, cU, b2, d])) continue;
      S.ibox(inst, 'lm_downlight', M.glowWhite, x, GF_H - 0.38, z, 0.5, 0.06, 0.5);
    }
  }
  railAlong(inst, At, L.offsetPolygon(upperN, -0.6), PH);
  facades.push(...S.facadeRecords(key, upperN, PH, 5, { tenants: ['渋谷町スクランブルスクエア'], isStreetSide, gf: GF_H }));
  // shopfronts: the 明治通り face (real 1F tenants on the east side, near-names), the terminal face (the 東口 entrance
  // and the deli), the JR-side face (ecute EDITION's station shops)
  const TY = { 'チョコガカリ': 'cafe', '5 CROSSTIES COFFEE': 'cafe', 'UNITED ARROWZ': 'fashion', 'MAKE UP FOR EVA': 'drug', 'imua HAWAIIAN DELI': 'cafe', 'ekute EDITION 渋谷町': 'generic', '資生堂パーラ 渋谷町': 'cafe', '丸山珈琲': 'cafe', '堀内果実園': 'generic' };
  const row = (p0, p1, list, fi) => { const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]); if (len < 4) return; const nx = (p1[1] - p0[1]) / len, nz = -(p1[0] - p0[0]) / len; const [ox, oz] = L.pointInPoly((p0[0] + p1[0]) / 2 + nx, (p0[1] + p1[1]) / 2 + nz, gf) ? [-nx, -nz] : [nx, nz]; S.shopRow(batch, At, p0, p1, ox, oz, list, { gf: GF_H - 0.6, rng, pools, typeOf: (n) => TY[n] || 'fashion', shopOf: SHOP_OF_TYPE, fi, minW: 7, maxW: 9, depth: inst }); };
  row(b, [x15.face0, x15.z0], ['チョコガカリ', '5 CROSSTIES COFFEE'], 100);
  row([x15.face1, x15.z1], G.after[0], ['UNITED ARROWZ', 'MAKE UP FOR EVA'], 104);
  row(G.after[0], G.after[1], ['資生堂パーラ 渋谷町', 'ekute EDITION 渋谷町'], 108);
  row(G.before[G.before.length - 1], a, ['imua HAWAIIAN DELI', '丸山珈琲'], 112);
  row(G.before[0], G.before[1], ['ekute EDITION 渋谷町', '堀内果実園'], 116);
  // name board over the terminal face + the 東口 entrance canopy
  {
    const p0 = G.before[G.before.length - 1], mx = (p0[0] + a[0]) / 2, mz = (p0[1] + a[1]) / 2, len = Math.hypot(a[0] - p0[0], a[1] - p0[1]), nx = (a[1] - p0[1]) / len, nz = -(a[0] - p0[0]) / len;
    const [ox, oz] = L.pointInPoly(mx + nx, mz + nz, gf) ? [-nx, -nz] : [nx, nz];
    S.signQuad(batch, mx + ox * 0.06, GF_H - 0.3, mz + oz * 0.06, ox, oz, { text: '渋谷スクランブルスクエア  東口', sub: 'SHIBUYA SCRAMBLE SQUARE  ―  EAST ENTRANCE  1F', w: 11, h: 0.62, bg: '#15171c', fg: '#f2efe6', emissive: 0.45, weight: '800' });
  }
  // ---- 東口 アーバン・コア: glass + lattice from the street to the roof of the podium, floors, escalators, signs
  {
    const env = [a2, cU, b2];
    const faces = [[a2, cU], [cU, b2]];
    for (const [p, q] of faces) {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]), r = Math.atan2(-(q[1] - p[1]), q[0] - p[0]);
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      const nx = (q[1] - p[1]) / len, nz = -(q[0] - p[0]) / len, [ox, oz] = L.pointInPoly(mx + nx, mz + nz, [a2, cU, b2, d]) ? [-nx, -nz] : [nx, nz];
      // glass (with the opening where the ヒカリエ deck lands on the 2F gallery)
      const deckT = G.deckEnd ? ((G.deckEnd[0] - p[0]) * (q[0] - p[0]) + (G.deckEnd[1] - p[1]) * (q[1] - p[1])) / len : -99;
      const deckOn = G.deckEnd && deckT > 0 && deckT < len && Math.abs((G.deckEnd[0] - p[0]) * oz * -1 + 0 * 0 + (G.deckEnd[1] - p[1]) * ox) < 99 && L.distToSegment(G.deckEnd[0], G.deckEnd[1], p[0], p[1], q[0], q[1]) < 2.5;
      const gl = (t0, t1, y0, y1) => { if (t1 - t0 < 0.05 || y1 - y0 < 0.05) return; const tc = (t0 + t1) / 2; batch.add(M.glassClear, L.wallQuad(p[0] + (q[0] - p[0]) * tc / len, (y0 + y1) / 2, p[1] + (q[1] - p[1]) * tc / len, ox, oz, t1 - t0, y1 - y0, 0.02), px, pz); };
      if (deckOn) { const d0 = Math.max(0, deckT - 5), d1 = Math.min(len, deckT + 5); gl(0, len, 0, Y2 - 0.6); gl(0, len, Y2 + 3.9, PH); gl(0, d0, Y2 - 0.6, Y2 + 3.9); gl(d1, len, Y2 - 0.6, Y2 + 3.9); }
      else gl(0, len, 0, PH);
      // Kuma's lattice: mullions every 1.8 m, transoms at the floor lines, and a diagonal net over the facets
      for (let t = 0; t <= len; t += 1.8) { const x = p[0] + (q[0] - p[0]) * t / len, z = p[1] + (q[1] - p[1]) * t / len; S.ibox(inst, 'lm_mullion', M.whiteMetal, x + ox * 0.05, 0, z + oz * 0.05, 0.12, PH, 0.2, r); }
      for (const y of [GF_H, Y2 + 0.3, Y3 + 0.3, 18.5, PH - 0.3]) batch.add(M.whiteMetal, L.boxAt(mx + ox * 0.06, y, mz + oz * 0.06, len, 0.18, 0.22, r, false), mx, mz);
      const nD = Math.max(2, Math.round(len / 3.6));
      for (let k = 0; k < nD; k++) for (const [y0, y1] of [[GF_H + 0.3, Y3 + 0.3], [Y3 + 0.3, PH - 0.3]]) for (const dir of [1, -1]) {
        const t0 = (k + (dir > 0 ? 0 : 1)) * len / nD, t1 = (k + (dir > 0 ? 1 : 0)) * len / nD;
        const x0 = p[0] + (q[0] - p[0]) * t0 / len + ox * 0.08, z0 = p[1] + (q[1] - p[1]) * t0 / len + oz * 0.08, x1 = p[0] + (q[0] - p[0]) * t1 / len + ox * 0.08, z1 = p[1] + (q[1] - p[1]) * t1 / len + oz * 0.08;
        const l = Math.hypot(x1 - x0, y1 - y0, z1 - z0), g = new THREE.BoxGeometry(0.09, 0.09, l);
        g.lookAt(new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0)); g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        batch.add(M.whiteMetal, g, x0, z0);
      }
      // ground-floor doors: a 4.5 m opening in the middle of each face (glass leaves drawn open, frame)
      const tm = len / 2, dx = (q[0] - p[0]) / len, dz = (q[1] - p[1]) / len;
      for (const s2 of [-2.25, 2.25]) S.ibox(inst, 'lm_post', M.darkMetal, p[0] + dx * (tm + s2) + ox * 0.1, 0.15, p[1] + dz * (tm + s2) + oz * 0.1, 0.16, 2.8, 0.16);
      batch.add(M.darkMetal, L.boxAt(p[0] + dx * tm + ox * 0.1, 2.95, p[1] + dz * tm + oz * 0.1, 4.7, 0.2, 0.18, r, false), mx, mz);
      // colliders: the glass either side of the door (and the whole upper glass is out of reach anyway)
      for (const [s0, s1] of [[0, tm - 2.3], [tm + 2.3, len]]) if (s1 - s0 > 0.3) { const cx = p[0] + dx * (s0 + s1) / 2, cz = p[1] + dz * (s0 + s1) / 2; colliders.push(S.boxCollider(cx, cz, s1 - s0, 3.0, 0.3, r)); }
    }
    // UC Vision (the LED wall on the core's back wall), the core's floors
    const vx = (d[0] + b2[0]) / 2, vz = (d[1] + b2[1]) / 2, vl = Math.hypot(b2[0] - d[0], b2[1] - d[1]), vnx = -(b2[1] - d[1]) / vl, vnz = (b2[0] - d[0]) / vl;
    const [ivx, ivz] = L.pointInPoly(vx + vnx, vz + vnz, [a2, cU, b2, d]) ? [vnx, vnz] : [-vnx, -vnz];
    S.signQuad(batch, vx + ivx * 0.1, 10.5, vz + ivz * 0.1, ivx, ivz, { text: 'SHIBUYA46  ―  純愛', sub: 'UC VISION  ・  渋谷スクランブルスクエア', w: Math.min(12, vl - 2), h: 4.2, bg: '#1b1030', fg: '#ff5ec4', emissive: 0.7, weight: '900' });
    const inner = (p, q) => { const l = Math.hypot(q[0] - p[0], q[1] - p[1]), nx = (q[1] - p[1]) / l, nz = -(q[0] - p[0]) / l, mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2, [ox, oz] = L.pointInPoly(mx + nx, mz + nz, [a2, cU, b2, d]) ? [nx, nz] : [-nx, -nz]; batch.add(M.whiteMetal, L.wallQuad(mx, PH / 2, mz, ox, oz, l, PH, 0.03), px, pz); };
    inner(a2, d); inner(d, b2);
    // 2F gallery along the 明治通り glass (the deck from ヒカリエ lands on it), 3F gallery along the terminal glass
    const g2 = [cU, b2, [b2[0] + uN[0] * 12.5, b2[1] + uN[1] * 12.5], [cU[0] + uN[0] * 12.5, cU[1] + uN[1] * 12.5]];
    const g3 = [a2, cU, [cU[0] + uE[0] * 8.5, cU[1] + uE[1] * 8.5], [a2[0] + uE[0] * 8.5, a2[1] + uE[1] * 8.5]];
    for (const [poly, y] of [[g2, Y2], [g3, Y3]]) {
      batch.add(M.stoneLight, L.extrudePolygon(poly, y - 0.45, y, { cap: true, bottom: true, uvScale: 0.5 }), px, pz);
      S.parapet(batch, M.glassClear, L.offsetPolygon(poly, -0.2), y, { h: 1.1, t: 0.06 });
      const bb = L.polyBounds(poly);
      for (let x = bb.x0 + 1.5; x < bb.x1; x += 3) for (let z = bb.z0 + 1.5; z < bb.z1; z += 3) if (L.pointInPoly(x, z, poly)) S.ibox(inst, 'lm_stripLight', M.glowWhite, x, y - 0.47, z, 1.4, 0.04, 0.14);
    }
    batch.add(M.whiteMetal, L.extrudePolygon([a2, cU, b2, d], PH - 0.5, PH - 0.2, { cap: false, bottom: true, sides: false }), px, pz);   // core ceiling
    // escalators: 1F → 2F (up + down pair), 2F → 3F, and the pair down into the well to the subway concourse
    const E = (u, v) => U(u, v);
    const [e1a, e1b] = [E(16, 3.0), E(4.5, 3.0)], [e1c, e1d] = [E(16, 4.6), E(4.5, 4.6)];
    escalator(batch, inst, e1a[0], 0.15, e1a[1], e1b[0], Y2, e1b[1], { up: true, colliders });
    escalator(batch, inst, e1c[0], 0.15, e1c[1], e1d[0], Y2, e1d[1], { up: false, colliders });
    const [e2a, e2b] = [E(-1, 14), E(-1, 3.5)];
    escalator(batch, inst, e2a[0], Y2, e2a[1], e2b[0], Y3, e2b[1], { up: true });
    // (the landing slab the upper end of the 1F run arrives on)
    batch.add(M.stoneLight, L.extrudePolygon([E(6.5, 1.8), E(3.5, 1.8), E(3.5, 5.8), E(6.5, 5.8)], Y2 - 0.45, Y2, { cap: true, bottom: true }), px, pz);
    // the well: CITY.groundHoles entry `uc` (axis-aligned), escalators descending west into the B1 concourse
    const hole = (CITY.groundHoles || []).find((h) => h.id === 'uc');
    if (hole) well(batch, inst, hole, colliders, { title: '東京メトロ 副都心線 ・ 半蔵門線  東急東横線 ・ 田園都市線', sub: 'B2F 改札  ―  Metro / Tokyu Lines  ↓', down: 'west', escalators: true, fixture });
    // signs in the core
    const sgn = (p, y, nx, nz, t, sub, bg, fg, w = 5.2) => S.signQuad(batch, p[0], y, p[1], nx, nz, { text: t, sub, w, h: 0.62, bg, fg, emissive: 0.4, weight: '800', double: true });
    sgn(E(10, 3.8), 3.9, uN[0], uN[1], 'ヒカリエ 2F デッキ ↑', 'To Hikarie  ―  2F Deck', '#1b2748', '#ffffff');
    sgn(E(-1, 9), Y2 + 3.2, uE[0], uE[1], 'JP 中央改札 ・ 銀座線 3F ↑', 'JP Central Gate  ・  Ginza Line', '#1d8f3e', '#ffffff');
    sgn(E(12.5, 7.2), 3.6, uE[0], uE[1], '副都心線 ・ 半蔵門線 ・ 東急線 ↓', 'Metro ・ Tokyu Lines  B2F', '#ffd400', '#111111');
    S.signQuad(batch, (a2[0] + cU[0]) / 2 - uE[0] * 0.2, PH + 1.1, (a2[1] + cU[1]) / 2 - uE[1] * 0.2, -uE[0], -uE[1], { text: 'SHIBUYA SCRAMBLE SQUARE', sub: '東口 アーバン・コア  EAST URBAN CORE', w: 12, h: 1.2, bg: '#101216', fg: '#f4f2ec', emissive: 0.6, weight: '900' });
    const ccx = (a2[0] + b2[0] + cU[0] + d[0]) / 4, ccz = (a2[1] + b2[1] + cU[1] + d[1]) / 4;
    fixture(ccx, 4.2, ccz, 0xfff4e6, 70, 18); fixture(ccx, Y2 + 4, ccz, 0xfff4e6, 55, 16); fixture(ccx, Y3 + 4, ccz, 0xfff4e6, 45, 16);
    // light slots up the core's back walls (the white walls glow through the glass at night)
    for (const [p, q] of [[a2, d], [d, b2]]) { const l = Math.hypot(q[0] - p[0], q[1] - p[1]); for (let t = 2; t < l - 1; t += 3.2) { const x = p[0] + (q[0] - p[0]) * t / l, z = p[1] + (q[1] - p[1]) * t / l; S.ibox(inst, 'lm_coreSlot', M.interiorDim, x + (ccx - x) * 0.02, 0.6, z + (ccz - z) * 0.02, 0.35, PH - 1.8, 0.35); } }
    (CITY.propFree || (CITY.propFree = [])).push([a2, cU, b2, d]);             // no street dressing inside the core
    void env;
  }
  // ---- Metro exit 15: a recess in the 明治通り face, stairs down the well, the M pylon and the exit board
  {
    const hole = (CITY.groundHoles || []).find((h) => h.id === 'exit15');
    if (hole) well(batch, inst, hole, colliders, { title: '東京メトロ 渋谷町駅  15', sub: '副都心線 ・ 半蔵門線 ・ 東急東横線 ・ 田園都市線', down: 'west', escalators: false, fixture });
    const zc = (x15.z0 + x15.z1) / 2, fx = (x15.face0 + x15.face1) / 2;
    batch.add(M.whiteMetal, L.boxAt((x15.x + fx) / 2, GF_H - 0.2, zc, fx - x15.x, 0.4, x15.z1 - x15.z0, 0, false), px, pz);           // recess ceiling
    for (let x = x15.x + 1; x < fx; x += 1.6) S.ibox(inst, 'lm_stripLight', M.glowWhite, x, GF_H - 0.42, zc, 0.14, 0.04, 3.2);
    S.signQuad(batch, fx + 0.1, GF_H - 1.0, zc, 1, 0, { text: 'Ⓜ 15  東京メトロ', sub: '副都心線 ・ 半蔵門線  /  東急東横線 ・ 田園都市線', w: 4.4, h: 0.8, bg: '#1c56b7', fg: '#ffffff', emissive: 0.45, weight: '900' });
    const kx = fx + 1.2, kz = x15.z0 - 1.2;                                                   // the M pylon on the pavement
    batch.add(M.darkMetal, L.boxAt(kx, 1.4, kz, 0.5, 2.8, 0.5, 0, false), kx, kz);
    for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) S.signQuad(batch, kx + nx * 0.26, 2.3, kz + nz * 0.26, nx, nz, { text: 'Ⓜ', sub: '15', w: 0.46, h: 0.8, bg: '#1c56b7', fg: '#ffffff', emissive: 0.5, weight: '900' });
    colliders.push(S.boxCollider(kx, kz, 0.6, 2.8, 0.6));
  }
  void field;
  // ---- shaft: one continuous taper (W × D → W-6 × D-6 over the height) with 4 m 45° corner cuts, lofted in 7
  //      slices so the fins / rings follow the inset; the glass ends 10 m below the crown (deck recess)
  const top = H - 10, nS = 7;
  const polyAt = (y) => { const k = Math.max(0, Math.min(1, (y - PH) / (top - PH))); return L.chamferPoly(rp(W - 6 * k, D - 6 * k), 4); };
  for (let s = 0; s < nS; s++) {
    const y0 = PH + (top - PH) * s / nS, y1 = PH + (top - PH) * (s + 1) / nS;
    const pa = polyAt(y0), pb = polyAt(y1);
    batch.add(M.glassTower, L.loft(pa, pb, y0 - 0.15, y1, { uvScale: 3.5 / SH }), px, pz);
    S.fins(inst, 'lm_finSilver', M.silver, pa, y0, y1, 3.0, { w: 0.28, d: 1.3, out: -0.5, margin: 0.4 });
    for (let y = y0 + SH; y < y1 - 0.4; y += SH) S.rings(batch, M.darkMetal, polyAt(y), y, y + 0.3, 1, { out: 0.12, h: 0.22 });
    if (s === 2 || s === 4) S.rings(batch, M.silver, pa, y0 + 0.02, y0 + 1, 2, { out: 0.55, h: 0.5 });                      // two mechanical-floor bands break the shaft
  }
  { const o = S.obbOf(rp(W, D), H - PH); o.obb.center.y += PH; colliders.push(o); }   // the shaft only: the arcade under it stays walkable
  // ---- SHIBUYA SKY: the deck sits 2 m recessed inside a 12 m silver crown lattice (posts on the octagon corners,
  //      three rings, lit inner rim), glass balustrade, central core, mast
  const pt = polyAt(top), deckY = top + 0.3;
  batch.add(M.silver, L.extrudePolygon(pt, top - 0.1, top + 2.0, { cap: false, uvScale: 1 }), px, pz);                     // upstand around the deck
  batch.add(M.silver, L.polygonCap(pt, top + 2.0, 1), px, pz);
  batch.add(M.stoneLight, L.polygonCap(L.offsetPolygon(pt, -0.5), deckY, 0.5), px, pz);
  S.parapet(batch, M.glassClear, L.offsetPolygon(pt, -0.3), top + 2.0, { h: 1.3, t: 0.08 });
  S.fins(inst, 'lm_railpost', M.silver, L.offsetPolygon(pt, -0.3), top + 2.0, top + 3.3, 3.0, { w: 0.1, d: 0.1, out: -0.15 });
  const crown = L.offsetPolygon(pt, 0.6), n8 = crown.length;
  for (const [x, z] of crown) S.ibox(inst, 'lm_post', M.silver, x, top, z, 0.7, 12, 0.7, rot);
  for (const y of [top + 4, top + 8, top + 11.6]) S.parapet(batch, M.silver, crown, y, { h: 0.45, t: 0.5, out: 0.25 });
  for (let i = 0; i < n8; i++) {                                                                                          // lit inner rim under the top ring + lattice diagonals
    const a = crown[i], b = crown[(i + 1) % n8]; const [nx, nz] = L.edgeNormal(crown, i); const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    batch.add(M.glowWhite, L.boxAt((a[0] + b[0]) / 2 - nx * 0.35, top + 11.35, (a[1] + b[1]) / 2 - nz * 0.35, len - 0.6, 0.12, 0.14, L.rotYOf(b[0] - a[0], b[1] - a[1]), false), px, pz);
    if (len > 8) { const g = L.boxAt(0, 0, 0, Math.hypot(len - 1, 7.4), 0.2, 0.2, 0, false); g.rotateZ(Math.atan2(7.4, len - 1)); g.rotateY(L.rotYOf(b[0] - a[0], b[1] - a[1])); g.translate((a[0] + b[0]) / 2, top + 4.25 + 3.7, (a[1] + b[1]) / 2); batch.add(M.silver, g, px, pz); }
  }
  const bulk = rp(20, 26);
  S.prism(batch, M.silver, bulk, deckY, top + 8, { uvScale: 1, capMat: S.roofMat() });
  S.rings(batch, M.darkMetal, bulk, deckY + 2, top + 7, 2.5, { out: 0.15, h: 0.4 });
  S.ibox(inst, 'lm_post', M.silver, px, top + 8, pz, 0.9, 20, 0.9);
  S.ibox(inst, 'lm_aviation', M.glowRed, px, top + 28, pz, 0.8, 0.8, 0.8);
  for (const p of L.alongPolyline([...L.offsetPolygon(pt, -2.2), L.offsetPolygon(pt, -2.2)[0]], 6, 3)) S.ibox(inst, 'lm_decklight', M.glowWarm, p.x, deckY, p.z, 0.16, 2.4, 0.16);
  const anchors = { crownSign: new THREE.Vector3(0, top + 6, -(D - 6) / 2 - 1.2), deck: new THREE.Vector3(0, deckY, 0), deckSize: [W - 7, D - 7] };
  return { group: new THREE.Group(), worldSpace: true, rotation: rot, colliders, lights: [], anchors, facades };
}

export default { build, KEYS, SIZE };
