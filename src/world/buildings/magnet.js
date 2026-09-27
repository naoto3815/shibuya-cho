// [city] MAGNET by SHIBUYA 1O9 (旧 109MEN'S) — slim 7-storey silver-panel block on the north-east corner of the
// crossing: corner LED frame on the south-west face (screen from the signage module via anchors.screen), storey
// ledges, ground-floor shops, rooftop MAG's PARK crossing-view deck with glass balustrade and lettering.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { getAtlases, tenantType, SHOP_OF_TYPE, shopQuad, paneQuad } from './genericBuilding.js';

export const KEYS = ['magnet'];

/**
 * MAGNET's own skin: silver aluminium panels on a 1.2 m joint grid with a 2.1 m window band per storey (40 % of
 * the bays lit in tenant runs), rain streaks and a drip line hanging from under every ledge, and a roughness map
 * (panels 0.35, streaks 0.7, glass 0.1) so the IBL and the crossing's neon read on the metal. The canvas covers
 * 12 m × 6 storeys; UVs are metres, rows are aligned to the ledges by the texture offset.
 */
function magnetMaterial(GF, SH) {
  const W = 1024, ST = 6, RH = 340, H = RH * ST, PX = W / 12;
  const map = L.makeCanvas(W, H), emi = L.makeCanvas(W, H), rgh = L.makeCanvas(W, H);
  const m = map.getContext('2d'), e = emi.getContext('2d'), r = rgh.getContext('2d');
  m.fillStyle = 'rgb(168,172,180)'; m.fillRect(0, 0, W, H);
  e.fillStyle = 'rgb(74,76,82)'; e.fillRect(0, 0, W, H);                       // faint floodlight on the aluminium
  r.fillStyle = 'rgb(89,89,89)'; r.fillRect(0, 0, W, H);
  const my = RH / SH;                                                           // px per metre vertically
  for (let s = 0; s < ST; s++) {
    const yb = H - s * RH;                                                      // storey bottom (the ledge) in px
    const Y = (mm) => yb - mm * my;
    // panel tone per bay (anodised panels never match exactly)
    for (let b = 0; b < 10; b++) { const v = (L.hash(b, s, 91) - 0.5) * 16; m.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`; m.fillRect(b * 1.2 * PX, Y(SH), 1.2 * PX, Y(2.45) - Y(SH)); }
    // window band 0.35–2.45 m: a dark recess behind the real glazing (build() puts interior-mapped rooms / dark glass
    // quads in front of it on every face); the paint only shows at grazing angles and on the plant end
    {
      const y0 = Y(2.45), y1 = Y(0.35);
      const g = m.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgb(40,44,52)'); g.addColorStop(1, 'rgb(20,22,28)');
      m.fillStyle = g; m.fillRect(0, y0, W, y1 - y0);
      e.fillStyle = 'rgb(3,3,4)'; e.fillRect(0, y0, W, y1 - y0);
      r.fillStyle = 'rgb(40,40,40)'; r.fillRect(0, y0, W, y1 - y0);
    }
    m.fillStyle = 'rgb(46,48,52)'; m.fillRect(0, Y(0.35), W, Y(0) - Y(0.35)); e.fillStyle = 'rgb(20,21,23)'; e.fillRect(0, Y(0.35), W, Y(0) - Y(0.35));   // slab edge
    for (const mm of [0.35, 2.45, 3.6]) { m.fillStyle = 'rgb(86,88,94)'; m.fillRect(0, Y(mm) - 2, W, 4); }        // horizontal joints
    // rain streaks + drip line under the ledge above (top of the row)
    m.fillStyle = 'rgba(40,40,44,0.35)'; m.fillRect(0, Y(SH), W, 7);
    r.fillStyle = 'rgb(170,170,170)'; r.fillRect(0, Y(SH), W, 7);
    for (let k = 0; k < 70; k++) {
      const x = L.hash(k, s, 107) * W, len = (0.3 + L.hash(k, s, 109) * 1.6) * my, w = 2 + L.hash(k, s, 111) * 7, a = 0.08 + L.hash(k, s, 113) * 0.22;
      const g = m.createLinearGradient(0, Y(SH), 0, Y(SH) + len); g.addColorStop(0, `rgba(34,34,38,${a})`); g.addColorStop(1, 'rgba(34,34,38,0)');
      m.fillStyle = g; m.fillRect(x, Y(SH), w, len);
      const gr = r.createLinearGradient(0, Y(SH), 0, Y(SH) + len); gr.addColorStop(0, 'rgba(190,190,190,0.9)'); gr.addColorStop(1, 'rgba(190,190,190,0)');
      r.fillStyle = gr; r.fillRect(x, Y(SH), w, len);
    }
  }
  for (let b = 0; b <= 10; b++) { const x = Math.round(b * 1.2 * PX); m.fillStyle = 'rgb(92,94,100)'; m.fillRect(x - 2, 0, 4, H); m.fillStyle = 'rgba(255,255,255,0.35)'; m.fillRect(x + 2, 0, 1, H); r.fillStyle = 'rgb(120,120,120)'; r.fillRect(x - 2, 0, 4, H); }
  // the floodlight (emissive) is not uniform: every storey is uplit from the ledge lamps below and in the shadow of
  // the cantilevered ledge above (AO under each band), the drips and panel joints darken it too — so the bands, the
  // rain streaks and the panel grid read at night instead of a flat CG plaster wash
  for (let st = 0; st < ST; st++) {
    const yb = H - st * RH, Y = (mm) => yb - mm * my;
    const g = e.createLinearGradient(0, Y(SH), 0, Y(0));
    g.addColorStop(0, 'rgba(0,0,0,0.78)'); g.addColorStop(0.16, 'rgba(0,0,0,0.42)'); g.addColorStop(0.45, 'rgba(0,0,0,0.12)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    e.fillStyle = g; e.fillRect(0, Y(SH), W, Y(0) - Y(SH));
    const ga = m.createLinearGradient(0, Y(SH), 0, Y(SH) + 0.7 * my); ga.addColorStop(0, 'rgba(0,0,0,0.4)'); ga.addColorStop(1, 'rgba(0,0,0,0)');
    m.fillStyle = ga; m.fillRect(0, Y(SH), W, 0.7 * my);                                     // AO under the ledge (albedo)
    for (let k = 0; k < 70; k++) {
      const x = L.hash(k, st, 107) * W, len = (0.3 + L.hash(k, st, 109) * 1.6) * my, w = 2 + L.hash(k, st, 111) * 7, a = 0.15 + L.hash(k, st, 113) * 0.35;
      const gs = e.createLinearGradient(0, Y(SH), 0, Y(SH) + len); gs.addColorStop(0, `rgba(0,0,0,${a})`); gs.addColorStop(1, 'rgba(0,0,0,0)');
      e.fillStyle = gs; e.fillRect(x, Y(SH), w, len);
    }
    if (st === 0) { const gg = e.createLinearGradient(0, Y(1.6), 0, Y(0)); gg.addColorStop(0, 'rgba(0,0,0,0)'); gg.addColorStop(1, 'rgba(0,0,0,0.35)'); e.fillStyle = gg; e.fillRect(0, Y(1.6), W, Y(0) - Y(1.6)); }
  }
  for (let b = 0; b <= 10; b++) { const x = Math.round(b * 1.2 * PX); e.fillStyle = 'rgba(0,0,0,0.55)'; e.fillRect(x - 2, 0, 4, H); }
  const tex = (c, srgb) => { const t = L.canvasTex(c, { wrap: true, srgb }); t.repeat.set(1 / 12, 1 / (SH * ST)); t.offset.set(0, -GF / (SH * ST)); return t; };
  const mat = new THREE.MeshStandardMaterial({ map: tex(map, true), emissiveMap: tex(emi, true), emissive: 0xffffff, roughnessMap: tex(rgh, false), roughness: 1, metalness: 0.5, envMapIntensity: 1.4 });
  mat.name = 'lm_magnetPanel';
  return S.nightMaterial(mat, 0.05, 1.1);
}

/**
 * The window band of every storey as real glazing: whole tenant floors lit (a shop floor is lit end to end, not in
 * scattered bays), each lit run one interior-mapped room (the shared shop atlas: fashion rails, cosmetics counters,
 * the café floor) behind clear glass, closed floors and gaps as dark reflective glass per 1.2 m bay, a mullion on
 * every panel joint. Storeys 2F–7F: fashion, fashion, cosmetics (half lit), fashion, closed, café / restaurant.
 */
const FLOORS = [{ type: 'fashion', p: 0.95 }, { type: 'fashion', p: 0.9 }, { type: 'generic', p: 0.5 }, { type: 'fashion', p: 0.92 }, { type: 'fashion', p: 0.06 }, { type: 'cafe', p: 0.97 }];
function glazing(batch, At, M, poly, GF, SH) {
  const c = L.polyCentroid(poly), BH = 2.1, BY = 0.35 + BH / 2, BAY = 1.2;
  const dark = At.win.cells.normal.filter((q, i) => !q.lit && i % 4 !== 3);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 3) continue;
    const [nx, nz] = L.edgeNormal(poly, i), tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len, rot = L.rotYOf(tx, tz);
    const nb = Math.max(1, Math.floor((len - 0.8) / BAY)), s0 = (len - nb * BAY) / 2;
    const at = (s, out) => [a[0] + tx * s + nx * out, a[1] + tz * s + nz * out];
    for (let k = 0; k < 6; k++) {
      const F = FLOORS[k], y = GF + k * SH + BY;
      // runs of 3–8 bays; each run is lit (a room behind glass) or dark per the floor's occupancy
      let q = 0, run = 0;
      while (q < nb) {
        const n = Math.min(nb - q, 3 + Math.floor(L.hash(i * 7 + q, k, 131) * 6)), lit = L.hash(i * 13 + q, k, 137) < F.p;
        const sA = s0 + q * BAY, w = n * BAY, [cx, cz] = at(sA + w / 2, 0.05);
        if (lit) {
          const cell = At.shop.cells[F.type] || At.shop.cells.generic;
          const u0 = cell.u + (16 + Math.floor(L.hash(i, k * 5 + run, 139) * 3) * 64) / 4096, u1 = Math.min(cell.u + 0.249, u0 + w / 14 * 0.25);   // true scale: 14 m per cell
          batch.add(At.shop.mat, shopQuad(cx, y, cz, nx, nz, w, BH, 0.0, [u0, cell.v0, u1, cell.v0 + (cell.v1 - cell.v0) * (BH / 3.15)]), c[0], c[1]);
        } else {
          for (let j = 0; j < n; j++) {
            const d = dark[Math.floor(L.hash(i * 31 + q + j, k, 141) * dark.length)], [bx, bz] = at(sA + (j + 0.5) * BAY, 0.05);
            batch.add(At.win.mat, paneQuad(bx, y, bz, nx, nz, BAY, BH, 0.0, d, { shift: (i + q + j) & 3 }), c[0], c[1]);
          }
        }
        q += n; run++;
      }
      for (let j = 0; j <= nb; j++) { const [mx, mz] = at(s0 + j * BAY, 0.09); batch.add(M.silver, L.boxAt(mx, y, mz, 0.07, BH + 0.1, 0.09, rot, false), c[0], c[1]); }
      const [hx, hz] = at(len / 2, 0.09);
      for (const dy of [-BH / 2 - 0.03, BH / 2 + 0.03]) batch.add(M.silver, L.boxAt(hx, y + dy, hz, nb * BAY + 0.1, 0.06, 0.1, rot, false), c[0], c[1]);
    }
  }
}

export function build({ key, data, batch, inst, group, rng, pools, isStreetSide }) {
  const M = S.mats(), At = getAtlases();
  const [px, pz] = data.pos;
  const poly = L.ensureCW(data.polygon);
  const H = data.size[1], GF = 5.5, SH = (H - GF) / 6;
  const c = L.polyCentroid(poly);
  const colliders = L.edgeColliders(poly, H), facades = [];
  S.prism(batch, magnetMaterial(GF, SH), poly, 0, H, { uvScale: 1 });
  S.rings(batch, M.silver, poly, GF, H - 0.5, SH, { out: 0.25, h: 0.32 });
  glazing(batch, At, M, poly, GF, SH);
  // ground floor
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const [nx, nz] = L.edgeNormal(poly, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 5) continue;
    if (isStreetSide((a[0] + b[0]) / 2 + nx * 4, (a[1] + b[1]) / 2 + nz * 4)) S.shopRow(batch, At, a, b, nx, nz, ['MAGNET by SHIBUYA 1O9', 'WEGA', 'STARBEANS COFFEE', 'GO', 'ABC-MARK'], { gf: GF, rng, pools, typeOf: tenantType, shopOf: SHOP_OF_TYPE, fi: 60 + i });
  }
  // corner LED frame (south-west face)
  const [fx, fz] = S.dirOf(data.rotY);
  const e = L.bestEdge(poly, fx, fz);
  const sc = data.screen;
  if (e) {
    const w = sc.w + 1.2, h = sc.h + 1.0, cy = sc.bottom + sc.h / 2;
    const rot = L.rotYOf(e.tx, e.tz);
    const x = sc.center[0] + e.nx * 0.45, z = sc.center[1] + e.nz * 0.45;
    batch.add(M.darkMetal, L.boxAt(x, cy, z, w, h, 0.6, rot, false), c[0], c[1]);
    for (const o of [-w / 2, w / 2]) batch.add(M.darkMetal, L.boxAt(sc.center[0] + e.tx * o + e.nx * 0.7, cy, sc.center[1] + e.tz * o + e.nz * 0.7, 0.4, h + 0.8, 1.2, rot, false), c[0], c[1]);
    batch.add(M.darkMetal, L.boxAt(x + e.nx * 0.3, cy + h / 2 + 0.3, z + e.nz * 0.3, w + 0.8, 0.5, 1.2, rot, false), c[0], c[1]);
    S.poster(group, sc.center[0] + e.nx * 0.78, cy, sc.center[1] + e.nz * 0.78, e.nx, e.nz, sc.w, sc.h, 0);
    S.flatSign(group, e.mid[0] + e.nx * 0.4, H - 3.2, e.mid[1] + e.nz * 0.4, e.nx, e.nz, { text: 'MAGNET', sub: 'by SHIBUYA 1O9', w: Math.min(e.len - 1, 12), h: 2.6, bg: '#111214', fg: '#ffffff', emissive: 1.5, weight: '900' });
  }
  // framed ad hoardings beside the corner LED: two portrait boards on the 公園通り face, one on the 宮益坂 face
  const hoard = (f, s, cy, w, h, k) => {
    if (!f || f.len < s + w / 2 + 1) return;
    const rot = L.rotYOf(f.tx, f.tz), x = f.a[0] + f.tx * s + f.nx * 0.3, z = f.a[1] + f.tz * s + f.nz * 0.3;
    batch.add(M.darkMetal, L.boxAt(x, cy, z, w + 0.7, h + 0.7, 0.5, rot, false), c[0], c[1]);
    batch.add(M.silver, L.boxAt(x + f.nx * 0.3, cy - h / 2 - 0.45, z + f.nz * 0.3, w + 0.9, 0.18, 0.9, rot, false), c[0], c[1]);   // lamp bar
    S.poster(group, x + f.nx * 0.27, cy, z + f.nz * 0.27, f.nx, f.nz, w, h, k, 0.9);
  };
  const west = L.bestEdge(poly, -0.98, -0.2), south = L.bestEdge(poly, 0.05, 1);
  if (west) { const s0 = west.a[1] > west.b[1] ? 0 : west.len, dir = s0 ? -1 : 1; hoard(west, s0 + dir * 9, 15.5, 8, 10.5, 2); hoard(west, s0 + dir * 19.5, 15.5, 8, 10.5, 4); }
  if (south) { const s0 = south.a[0] < south.b[0] ? 0 : south.len, dir = s0 ? -1 : 1; hoard(south, s0 + dir * 7.5, 21.5, 9, 6.5, 1); }
  // rooftop deck: glass balustrade, posts, deck lights, lettering, stair box
  const inner = L.offsetPolygon(poly, -0.5);
  S.parapet(batch, M.glassClear, inner, H, { h: 1.3, t: 0.08 });
  S.fins(inst, 'lm_railpost', M.silver, inner, H, H + 1.3, 2.6, { w: 0.08, d: 0.08, out: -0.2 });
  batch.add(M.stoneLight, L.extrudePolygon(L.offsetPolygon(poly, -0.2), H - 0.1, H + 0.12, { cap: true, uvScale: 0.5 }), c[0], c[1]);
  // deck bollards: dark posts with a small warm head (a lit 3 m pole reads as a laser beam from the street)
  for (const p of L.alongPolyline(L.offsetPolygon(poly, -1.4), 7, 3)) { S.ibox(inst, 'lm_post', M.darkMetal, p.x, H + 0.12, p.z, 0.1, 0.8, 0.1); S.ibox(inst, 'lm_decklamp', M.glowWarm, p.x, H + 0.92, p.z, 0.22, 0.12, 0.22); }
  // plant zone at the end of the deck away from the crossing (bulkhead, tank, AC, duct) — the crossing end stays the viewing deck
  {
    const far = poly.reduce((b, p) => (Math.hypot(p[0], p[1]) > Math.hypot(b[0], b[1]) ? p : b), poly[0]);
    const zx = c[0] + (far[0] - c[0]) * 0.55, zz = c[1] + (far[1] - c[1]) * 0.55;
    const e0 = L.bestEdge(poly, far[0] - c[0], far[1] - c[1]);
    const zone = L.rectPoly(zx, zz, 14, 12, e0 ? L.rotYOf(e0.tx, e0.tz) : 0);
    batch.add(M.concrete, L.boxAt(zx, H + 1.8, zz, 6, 3.6, 5, e0 ? L.rotYOf(e0.tx, e0.tz) : 0, true), zx, zz);
    S.roofPlant(batch, inst, zone, H + 0.12, { seed: 23, tanks: 1, ac: 5, ducts: 1, rail: false, bulkhead: false, inset: 1 });
  }
  const n = L.bestEdge(poly, 0, 1);
  if (n) {
    S.flatSign(group, n.mid[0] + n.nx * 0.3, H + 2.4, n.mid[1] + n.nz * 0.3, n.nx, n.nz, { text: "MAG's PARK", sub: 'CROSSING VIEW  ROOFTOP', w: 12, h: 2, bg: '#111214', fg: '#ffffff', emissive: 1.1, weight: '900', double: true });
    // the lettering stands on a steel frame (two posts, a back truss), not in mid-air
    const rot = L.rotYOf(n.tx, n.tz);
    for (const o of [-5.2, 5.2]) batch.add(M.darkMetal, L.boxAt(n.mid[0] + n.tx * o - n.nx * 0.05, H + 1.7, n.mid[1] + n.tz * o - n.nz * 0.05, 0.16, 3.4, 0.16, rot, false), c[0], c[1]);
    for (const y of [H + 1.5, H + 3.35]) batch.add(M.darkMetal, L.boxAt(n.mid[0] - n.nx * 0.12, y, n.mid[1] - n.nz * 0.12, 12.2, 0.12, 0.12, rot, false), c[0], c[1]);
    // deck canopy behind the sign: slim roof on 4 posts, warm downlit soffit, a café counter glow under it
    const cx = n.mid[0] - n.nx * 5.5, cz = n.mid[1] - n.nz * 5.5;
    for (const [a, b] of [[-5, -2], [5, -2], [-5, 2], [5, 2]]) batch.add(M.silver, L.boxAt(cx + n.tx * a + n.nx * b, H + 1.45, cz + n.tz * a + n.nz * b, 0.12, 2.7, 0.12, rot, false), c[0], c[1]);
    batch.add(M.whiteMetal, L.boxAt(cx, H + 2.85, cz, 11.2, 0.16, 5.2, rot, false), c[0], c[1]);
    batch.add(M.interior, L.boxAt(cx, H + 2.76, cz, 10.4, 0.02, 4.4, rot, false), c[0], c[1]);                         // lit soffit
    batch.add(M.interiorDim, L.wallQuad(cx - n.nx * 2.3, H + 0.65, cz - n.nz * 2.3, n.nx, n.nz, 6, 1.0, 0.02), c[0], c[1]);   // counter
    // planters with shrubs along the balustrade on the crossing side
    for (const p of L.alongPolyline(L.offsetPolygon(poly, -1.3), 5.5, 2)) { if ((p.x - c[0]) * n.nx + (p.z - c[1]) * n.nz < 2) continue; batch.add(M.granite, L.boxAt(p.x, H + 0.42, p.z, 1.6, 0.6, 0.7, L.rotYOf(p.dx, p.dz), false), c[0], c[1]); inst.add('hedge', S.HEDGE_GEO, M.hedge, p.x, H + 0.95, p.z, 0, 1.1, 0.7, 0.8); }
  }
  // warm LED line under the balustrade handrail: the deck edge reads as a lit rail from the crossing
  { const rail = L.offsetPolygon(poly, -0.52); for (let i = 0; i < rail.length; i++) { const a = rail[i], b = rail[(i + 1) % rail.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 2) continue; batch.add(M.silver, L.boxAt((a[0] + b[0]) / 2, H + 1.33, (a[1] + b[1]) / 2, len, 0.07, 0.1, L.rotYOf(b[0] - a[0], b[1] - a[1]), false), c[0], c[1]); batch.add(M.glowWhiteDim, L.boxAt((a[0] + b[0]) / 2, H + 1.26, (a[1] + b[1]) / 2, len - 0.2, 0.03, 0.05, L.rotYOf(b[0] - a[0], b[1] - a[1]), false), c[0], c[1]); } }
  facades.push(...S.facadeRecords(key, poly, H, 7, { tenants: ['MAGNET by SHIBUYA 1O9'], isStreetSide, gf: GF }));
  const lv = (x, y, z) => new THREE.Vector3(x - px, y, z - pz);
  const anchors = e ? { screen: lv(sc.center[0] + e.nx * 1.0, sc.bottom + sc.h / 2, sc.center[1] + e.nz * 1.0), screenNormal: new THREE.Vector3(e.nx, 0, e.nz), screenSize: [sc.w, sc.h], roofSign: lv(n ? n.mid[0] : c[0], H + 2.4, n ? n.mid[1] : c[1]) } : {};
  return { group: new THREE.Group(), worldSpace: true, colliders, lights: [], anchors, facades };
}

export default { build, KEYS };
