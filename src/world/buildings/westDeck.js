// [city] 西口: the Mark City ⇄ station concourse bridge and the decks over the bus terminal, after Google Street View
// (2023-09, 駅前通り north of the terminal and under the deck) and the 2026 aerial:
//  - a two-storey glazed bridge (white fascia band, clear glass on vertical white fins, 京王井の頭線 sign) spans the
//    whole terminal from Mark City's east face to the construction yard, 18 m deep;
//  - under it and south of it a low grey slatted ceiling on round columns with yellow/black striped feet, rows of
//    square downlights, the buses and the island platforms beneath;
//  - a white steel-girder deck (covered) leaves it southward over 駅前通り and turns east along the yard's south side.
// Columns stand only on pavement or an island (street field > 0.6), never in a carriageway or a zebra.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';
import { escalator, stair } from './escalator.js';
import { SW_H } from './streets.js';

export const BRIDGE = { x0: -52, x1: -1.5, z0: 63, z1: 81 };   // plan rectangle of the glazed bridge
export const LOW_DECK = { z1: 93 };                             // the low deck continues south of the bridge to here
export const Y = { under: 6.2, floor: 7.0, band: 8.2, mid: 11.4, top: 15.8, roof: 16.6 };
// the stair + up escalator from the bus-terminal pavement along Mark City's east face up to the deck (2F), where the
// deck leads north to the 井の頭線 中央口 in Mark City EAST 2F. Rises northward from the foot (z 99) to the deck
// edge (z 86); the deck is cut open over it (z 86–92), a 1 m edge beam carrying the sign stays at z 92–93.
export const UP = { x0: -47.0, x1: -42.3, zTop: 86, zFoot: 99, zOpen: 92, stairX: -45.5, stairW: 3.0, escX: -43.05 };
const DECK_B = [[-19, 86], [-17.5, 100], [-13.5, 114], [-6, 125.5], [6, 130.5], [27, 131]];
const DECK_B_W = 9;

let stripeMat = null, ceilMat = null, glazeMat = null, coreMat = null;
// clear glass on a 2.4 m panel with two transoms per storey: tinted, reflective, the lit concourse shows through at night
function glazing() {
  if (glazeMat) return glazeMat;
  const c = L.makeCanvas(64, 256), g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 256);
  g.fillStyle = '#8c98a4'; for (const y of [0, 42, 126, 168, 252]) g.fillRect(0, y, 64, 4); g.fillRect(0, 0, 3, 256); g.fillRect(61, 0, 3, 256);
  glazeMat = L.std({ map: L.canvasTex(c, { wrap: true }), color: 0xc2d0da, roughness: 0.08, metalness: 0.55, transparent: true, opacity: 0.6, envMapIntensity: 1.9, side: THREE.DoubleSide, depthWrite: false });
  glazeMat.name = 'lm_bridgeGlass'; glazeMat.userData.noShadow = true;
  return glazeMat;
}
function core() {
  if (coreMat) return coreMat;
  coreMat = L.std({ color: 0xdedbd4, roughness: 0.85, metalness: 0, emissive: 0xfff0d6 });
  coreMat.name = 'lm_bridgeCore'; S.nightMaterial(coreMat, 0.04, 0.75);
  return coreMat;
}
function stripes() {
  if (stripeMat) return stripeMat;
  const c = L.makeCanvas(64, 128), g = c.getContext('2d');
  g.fillStyle = '#f2c417'; g.fillRect(0, 0, 64, 128);
  g.fillStyle = '#151515';
  for (let k = -4; k < 8; k++) { g.beginPath(); g.moveTo(0, k * 32); g.lineTo(64, k * 32 - 32); g.lineTo(64, k * 32 - 16); g.lineTo(0, k * 32 + 16); g.fill(); }
  stripeMat = L.std({ map: L.canvasTex(c, { wrap: true }), roughness: 0.55, metalness: 0.1 });
  stripeMat.name = 'lm_hazardStripes';
  return stripeMat;
}
function ceiling() {
  if (ceilMat) return ceilMat;
  const c = L.makeCanvas(64, 64), g = c.getContext('2d');
  g.fillStyle = '#6d7075'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#4b4e53'; for (let y = 0; y < 64; y += 8) g.fillRect(0, y, 64, 3);   // corrugated slats
  ceilMat = L.std({ map: L.canvasTex(c, { wrap: true }), roughness: 0.75, metalness: 0.25 });
  ceilMat.name = 'lm_deckCeiling';
  return ceilMat;
}

export function buildWestDeck({ CITY, batch, inst, group, field }) {
  const M = S.mats(), colliders = [];
  const cuts = (CITY.crosswalksExtra || []);
  const onFoot = (x, z) => field && field.sample(x, z) > 0.6 && !cuts.some(c => L.distToSegment(x, z, c.a[0], c.a[1], c.b[0], c.b[1]) < c.width / 2 + 0.8);
  const column = (x, z, top) => {
    const r = 0.55;
    batch.add(stripes(), S.cylSegment(x, z, r + 0.02, 0, 2.2, 0, Math.PI * 2, 20, { uRep: 3, vRep: 2.2 / 1.1 }), x, z);
    batch.add(M.ledge, S.cylSegment(x, z, r, 2.2, top, 0, Math.PI * 2, 20), x, z);
    batch.add(M.whiteMetal, L.boxAt(x, top - 0.25, z, 1.6, 0.5, 1.6, 0, false), x, z);    // capital plate
    colliders.push(S.boxCollider(x, z, 1.2, top, 1.2));
  };
  const { x0, x1, z0, z1 } = BRIDGE, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, W = x1 - x0, D = z1 - z0;

  // ---- low slatted ceiling under the bridge and the low deck, square downlights on a 6 m grid
  const dz1 = LOW_DECK.z1, dcz = (z0 + dz1) / 2, dD = dz1 - z0;
  // hung 6 cm below the slab soffit and the lights 8 cm below that: coplanar faces z-fought into a flickering mosaic
  const ceilY = Y.under - 0.06;
  const inOpen = (x, z, m = 0) => x < UP.x1 + m && z > UP.zTop - m && z < UP.zOpen + m;   // the stair opening (west part is inside Mark City)
  const ceilRect = (ax, az, bx, bz) => {
    const w = bx - ax, d = bz - az, g = new THREE.PlaneGeometry(w, d); g.rotateX(Math.PI / 2); g.translate((ax + bx) / 2, ceilY, (az + bz) / 2);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, (ax + uv.getX(i) * w) / 4, (az + uv.getY(i) * d) / 4);
    batch.add(ceiling(), g, (ax + bx) / 2, (az + bz) / 2);
  };
  ceilRect(x0, z0, x1, UP.zTop); ceilRect(UP.x1, UP.zTop, x1, UP.zOpen); ceilRect(x0, UP.zOpen, x1, dz1);
  for (let x = x0 + 3; x < x1 - 1; x += 6) for (let z = z0 + 3; z < dz1 - 1; z += 6) if (!inOpen(x, z, 0.8)) S.ibox(inst, 'lm_deckLight', M.glowWhite, x, ceilY - 0.1, z, 1.2, 0.09, 1.2);
  // low deck slab south of the bridge: grey fascia, stone floor, white parapet on its open south edge; the stair
  // opening leaves a north strip (z 81–86), the east part and the 1 m edge beam (z 92–93)
  const ldz = (z1 + dz1) / 2, ldD = dz1 - z1;
  const slab = (ax, az, bx, bz) => {
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    batch.add(M.ledge, L.boxAt(mx, (Y.under + Y.floor) / 2, mz, bx - ax, Y.floor - Y.under, bz - az, 0, false), mx, mz);
    batch.add(M.stoneLight, L.boxAt(mx, Y.floor + 0.02, mz, bx - ax - 0.2, 0.04, bz - az - 0.2, 0, false), mx, mz);
  };
  slab(x0, z1, x1, UP.zTop); slab(UP.x1, UP.zTop, x1, UP.zOpen); slab(x0, UP.zOpen, x1, dz1);
  batch.add(M.whiteMetal, L.boxAt(cx, Y.floor + 0.6, dz1 - 0.1, W, 1.2, 0.2, 0, false), cx, ldz);
  batch.add(M.whiteMetal, L.boxAt(x1 - 0.1, Y.floor + 0.6, ldz, 0.2, 1.2, ldD, 0, false), cx, ldz);
  // glass balustrade round the opening on the deck (east side and the edge beam); the stair head (north) stays open
  for (const [ax, az, bx, bz] of [[UP.x1 + 0.1, UP.zTop + 0.6, UP.x1 + 0.1, UP.zOpen + 0.1], [x0 + 2, UP.zOpen + 0.1, UP.x1 + 0.1, UP.zOpen + 0.1]]) {
    const l = Math.hypot(bx - ax, bz - az), r = Math.atan2(-(bz - az), bx - ax), mx = (ax + bx) / 2, mz = (az + bz) / 2;
    batch.add(M.glassClear, L.boxAt(mx, Y.floor + 0.6, mz, l, 1.0, 0.04, r, false), mx, mz);
    batch.add(M.darkMetal, L.boxAt(mx, Y.floor + 0.08, mz, l, 0.16, 0.14, r, false), mx, mz);
    batch.add(M.silver, L.boxAt(mx, Y.floor + 1.13, mz, l, 0.05, 0.08, r, false), mx, mz);
  }
  // the stair (west) and the up escalator (east) from the pavement to the deck, a cheek wall against Mark City
  stair(batch, UP.stairX, SW_H, UP.zFoot, UP.stairX, Y.floor, UP.zTop, { w: UP.stairW, mat: M.stoneLight });
  escalator(batch, inst, UP.escX, SW_H, UP.zFoot, UP.escX, Y.floor, UP.zTop, { w: 1.0, up: true, colliders });
  for (let z = UP.zTop; z < UP.zFoot; z += 0.5) {
    const t = Math.min(1, (UP.zFoot - z - 0.25) / (UP.zFoot - UP.zTop)), top = SW_H + (Y.floor - SW_H) * t + 1.0;
    batch.add(M.ledge, L.boxAt(UP.x0 - 0.12, top / 2, z + 0.25, 0.24, top, 0.5, 0, false), UP.x0, z);
  }
  for (let z = UP.zTop; z < UP.zFoot - 0.4; z += 0.5) {                                                   // stair handrails
    const t = Math.min(1, (UP.zFoot - z - 0.25) / (UP.zFoot - UP.zTop)), y = SW_H + (Y.floor - SW_H) * t;
    S.ibox(inst, 'lm_stairRail', M.silver, UP.stairX + UP.stairW / 2 - 0.1, y + 0.85, z + 0.25, 0.06, 0.05, 0.52);
  }
  // nobody walks up (the deck is scenery): one box over the flight, the ride button waits at the foot (shinsen.js)
  colliders.push(S.boxCollider(UP.stairX, (UP.zTop + UP.zFoot - 0.6) / 2, UP.stairW + 0.4, Y.floor + 1.2, UP.zFoot - 0.6 - UP.zTop, 0, -0.5));
  // signs: on the edge beam over the foot, and a blue station pylon beside the escalator foot
  S.flatSign(group, (UP.x0 + UP.x1) / 2, (Y.under + Y.floor) / 2, UP.zOpen + 1.08, 0, 1, { text: '京王井の頭線  渋谷町駅  中央口  2F  ↑', sub: 'KEIO INOKASHIRA LINE  ・  IN01  ・  渋谷マークシティ', w: 7.8, h: 0.72, bg: '#f4f4f0', fg: '#1b3a7a', emissive: 0.9, weight: '800' });
  batch.add(M.darkMetal, L.boxAt(UP.x1 + 0.9, 1.3, UP.zFoot + 0.6, 0.12, 2.6, 0.12, 0, false), UP.x1, UP.zFoot);
  S.flatSign(group, UP.x1 + 0.9, 2.35, UP.zFoot + 0.68, 0, 1, { text: '井の頭線 のりば ↑', sub: '神泉 ・ 下北沢 ・ 吉祥寺 方面', w: 1.6, h: 0.62, bg: '#1b3a7a', fg: '#ffffff', emissive: 0.9, weight: '800', double: true });

  // ---- the glazed bridge: slab, white fascia band to rail height, two storeys of clear glass on white fins
  batch.add(M.ledge, L.boxAt(cx, (Y.under + Y.floor) / 2, cz, W, Y.floor - Y.under, D, 0, false), cx, cz);
  const faces = [[cx, z0, W, 0, -1], [cx, z1, W, 0, 1], [x1, cz, D, 1, 0]];   // north, south, east (west abuts Mark City)
  for (const [fx, fz, len, nx, nz] of faces) {
    const along = nx === 0, rot = along ? 0 : Math.PI / 2;
    batch.add(M.whiteMetal, L.boxAt(fx + nx * 0.15, (Y.under + Y.band) / 2, fz + nz * 0.15, along ? len + 0.3 : 0.3, Y.band - Y.under, along ? 0.3 : len + 0.3, 0, false), cx, cz);
    batch.add(glazing(), L.wallQuad(fx, (Y.band + Y.top) / 2, fz, nx, nz, len, Y.top - Y.band, 0.02, [0, 0, len / 2.4, 1]), cx, cz);
    batch.add(M.whiteMetal, L.boxAt(fx + nx * 0.12, Y.mid, fz + nz * 0.12, along ? len : 0.24, 0.5, along ? 0.24 : len, 0, false), cx, cz);   // floor line
    for (let s = -len / 2 + 1.2; s < len / 2; s += 2.4) {                                                 // vertical fins
      const x = along ? fx + s : fx + nx * 0.3, z = along ? fz + nz * 0.3 : fz + s;
      S.ibox(inst, 'lm_bridgeFin', M.whiteMetal, x, Y.band, z, along ? 0.18 : 0.6, Y.roof - Y.band, along ? 0.6 : 0.18, 0);
    }
    void rot;
  }
  // the lit concourse behind the glass: floors, ceilings with light strips, an inner core so the glass reads as a room
  batch.add(M.stoneLight, L.boxAt(cx, Y.floor + 0.02, cz, W - 0.4, 0.04, D - 0.4, 0, false), cx, cz);
  batch.add(M.ledge, L.boxAt(cx, Y.mid, cz, W - 0.3, 0.3, D - 0.3, 0, false), cx, cz);
  batch.add(M.interiorDim, L.boxAt(cx, Y.mid - 0.2, cz, W - 0.5, 0.05, D - 0.5, 0, false), cx, cz);
  batch.add(M.interiorDim, L.boxAt(cx, Y.top - 0.2, cz, W - 0.5, 0.05, D - 0.5, 0, false), cx, cz);
  for (let x = x0 + 2; x < x1 - 1; x += 3) for (const y of [Y.mid - 0.33, Y.top - 0.33]) S.ibox(inst, 'lm_stripLight', M.glowWhite, x, y, cz, 0.2, 0.05, D - 3);
  batch.add(core(), L.boxAt(cx, (Y.floor + Y.top) / 2, cz + 3, W - 10, Y.top - Y.floor - 0.6, D - 10, 0, false), cx, cz);   // shops / mural wall core
  for (let k = 0, x = x0 + 3; x < x1 - 2; x += 1.8 + L.hash(k, 1, 71) * 3, k++) {                    // commuters on both levels
    const lvl = L.hash(k, 4, 71) < 0.6 ? Y.floor : Y.mid + 0.15;
    const pz = (L.hash(k, 2, 71) < 0.5 ? z0 + 1.3 + L.hash(k, 5, 71) * 2.2 : z1 - 1.3 - L.hash(k, 5, 71) * 2.2), ph = 1.6 + L.hash(k, 3, 71) * 0.2;
    S.ibox(inst, 'lm_commuter', M.innerDark, x, lvl + 0.04, pz, 0.46, ph - 0.24, 0.3);
    S.ibox(inst, 'lm_commuter', M.innerDark, x, lvl + ph - 0.22, pz, 0.22, 0.24, 0.24);
  }
  // roof slab + white parapet, plant on the roof
  batch.add(M.ledge, L.boxAt(cx, (Y.top + Y.roof) / 2, cz, W, Y.roof - Y.top, D, 0, false), cx, cz);
  S.parapet(batch, M.whiteMetal, L.rectPoly(cx, cz, W, D, 0), Y.roof, { h: 0.8, t: 0.3 });
  for (let x = x0 + 6; x < x1 - 4; x += 9) S.ibox(inst, 'lm_roofBox', M.ledge, x, Y.roof, cz, 3, 1.4, 2.2);
  // signs on the north fascia: the line at the Mark City end, the station at the east end
  S.flatSign(group, x0 + 12, (Y.under + Y.band) / 2, z0 - 0.35, 0, -1, { text: '京王井の頭線  渋谷町駅', sub: 'KEIO INOKASHIRA LINE', w: 12, h: 1.35, bg: '#f4f4f0', fg: '#1b3a7a', emissive: 0.9, weight: '800' });
  S.flatSign(group, x1 - 11, (Y.under + Y.band) / 2, z0 - 0.35, 0, -1, { text: 'JP線 ・ 銀座線 ・ 東急線  ←', sub: 'MARK CITY  2F  CONCOURSE', w: 10, h: 1.2, bg: '#f4f4f0', fg: '#222222', emissive: 0.8, weight: '700' });
  S.flatSign(group, cx, (Y.under + Y.band) / 2, z1 + 0.35, 0, 1, { text: '渋谷マークシティ  ⇄  渋谷町駅', sub: 'KEIO INOKASHIRA LINE  /  MARK CITY', w: 14, h: 1.3, bg: '#f4f4f0', fg: '#1b3a7a', emissive: 0.9, weight: '800' });

  // ---- columns: rows under the bridge's two faces and the low deck edge, only on foot surfaces
  for (const z of [z0 + 1.2, cz, z1 - 0.5, dz1 - 1.2]) for (let x = x0 + 4; x < x1 - 1; x += 1) {
    if (x < UP.x1 + 1.2 && z > UP.zTop - 1.5) continue;                                                   // clear of the stair
    if (!onFoot(x, z) || colliders.some(c => c.obb.halfSize.x < 2 && Math.hypot(c.obb.center.x - x, c.obb.center.z - z) < 6.5)) continue;
    column(x, z, Y.under);
  }

  // ---- the girder deck south / east: white edge girders and cross beams under a stone floor, glass-panel rails,
  //      a light roof on slim posts; columns on pavement / island every ~12 m
  const path = DECK_B, hw = DECK_B_W / 2;
  let run = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1], [bx, bz] = path[i], len = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / len, tz = (bz - az) / len;
    const r = Math.atan2(-tz, tx), mx = (ax + bx) / 2, mz = (az + bz) / 2, nx = -tz, nz = tx, l = len + 0.6;
    batch.add(M.stoneLight, L.boxAt(mx, Y.floor + 0.02, mz, l, 0.04, DECK_B_W - 0.2, r, false), mx, mz);
    batch.add(M.ledge, L.boxAt(mx, Y.floor - 0.25, mz, l, 0.5, DECK_B_W, r, false), mx, mz);
    for (const sg of [-1, 1]) {
      const ex = mx + nx * sg * (hw - 0.3), ez = mz + nz * sg * (hw - 0.3);
      batch.add(M.whiteMetal, L.boxAt(ex, Y.floor - 0.8, ez, l, 1.3, 0.5, r, false), mx, mz);            // edge girder
      batch.add(M.glassClear, L.boxAt(ex + nx * sg * 0.2, Y.floor + 0.6, ez + nz * sg * 0.2, l, 1.1, 0.05, r, false), mx, mz);
      batch.add(M.whiteMetal, L.boxAt(ex + nx * sg * 0.2, Y.floor + 1.18, ez + nz * sg * 0.2, l, 0.1, 0.12, r, false), mx, mz);
    }
    batch.add(M.ledge, L.boxAt(mx, Y.floor + 3.9, mz, l, 0.25, DECK_B_W + 1, r, false), mx, mz);         // roof
    batch.add(M.whiteMetal, L.boxAt(mx, Y.floor + 3.7, mz, l, 0.2, DECK_B_W + 1.2, r, false), mx, mz);
    for (let s = 0; s < len; s += 4) {
      const x = ax + tx * s, z = az + tz * s;
      batch.add(M.whiteMetal, L.boxAt(x, Y.floor - 0.7, z, 0.35, 1.0, DECK_B_W - 0.6, r, false), mx, mz);  // cross beam
      S.ibox(inst, 'lm_deckLight', M.glowWhite, x, Y.floor - 1.25, z, 0.9, 0.05, 0.9);
      S.ibox(inst, 'lm_stripLight', M.glowWhite, x, Y.floor + 3.55, z, 0.18, 0.05, DECK_B_W - 1.5, r);
      if (Math.round((run + s) / 4) % 2 === 0) for (const sg of [-1, 1]) S.ibox(inst, 'lm_deckPost', M.whiteMetal, x + nx * sg * (hw - 0.3), Y.floor, z + nz * sg * (hw - 0.3), 0.16, 3.6, 0.16);
    }
    for (let s = 6; s < len; s += 12) {
      const x = ax + tx * s, z = az + tz * s;
      const spot = [0, -hw + 1, hw - 1, -hw - 1.5, hw + 1.5].map(o => [x + nx * o, z + nz * o]).find(([px, pz]) => onFoot(px, pz));
      if (spot && !colliders.some(c => Math.hypot(c.obb.center.x - spot[0], c.obb.center.z - spot[1]) < 7)) column(spot[0], spot[1], Y.floor - 1.45);
    }
    run += len;
  }
  return { colliders };
}

export default { buildWestDeck, BRIDGE, Y, UP };
