// [city] 文化村通り dressing: the MEGA ドン・キホーヂ 渋谷本店 facade on the north side (blue / yellow sign wall, 驚安の殿堂
// band, corner blade, the penguin mascot board, lit entrance canopy) and the vista closer at the top of the street —
// the 東急本店 site under redevelopment (white hoarding, a rising steel frame, a luffing tower crane with its red
// aviation light), which is what the real street ends in today.
import * as THREE from 'three';
import * as L from './lib.js';
import * as S from './shared.js';

let penguinMat = null, washMat = null;
/** Additive light wash (three floodlight pools) for the redevelopment hoarding. */
function floodWash() {
  if (washMat) return washMat;
  const c = L.makeCanvas(512, 128), x = c.getContext('2d');
  for (const u of [1 / 6, 1 / 2, 5 / 6]) {
    const g = x.createRadialGradient(u * 512, 8, 4, u * 512, 40, 150);
    g.addColorStop(0, 'rgba(255,250,236,0.95)'); g.addColorStop(0.35, 'rgba(255,246,226,0.45)'); g.addColorStop(1, 'rgba(255,246,226,0)');
    x.fillStyle = g; x.fillRect(0, 0, 512, 128);
  }
  washMat = new THREE.MeshBasicMaterial({ map: L.canvasTex(c), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5 });
  washMat.name = 'bk_floodWash'; washMat.userData.noShadow = true;
  return washMat;
}
/** Painted penguin mascot (navy body, white belly, yellow beak / feet, blue night-cap) on a yellow round board. */
function penguinBoard() {
  if (penguinMat) return penguinMat;
  const c = L.makeCanvas(512, 512), g = c.getContext('2d');
  g.fillStyle = '#ffe600'; g.beginPath(); g.arc(256, 256, 250, 0, Math.PI * 2); g.fill();
  g.lineWidth = 16; g.strokeStyle = '#1c56b7'; g.stroke();
  const ell = (x, y, rx, ry, col, rot = 0) => { g.fillStyle = col; g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill(); };
  ell(256, 318, 118, 150, '#16244a');                      // body
  ell(256, 340, 82, 118, '#ffffff');                       // belly
  ell(150, 318, 34, 92, '#16244a', 0.35); ell(362, 318, 34, 92, '#16244a', -0.35);   // flippers
  ell(210, 464, 44, 18, '#ffb000'); ell(302, 464, 44, 18, '#ffb000');               // feet
  ell(256, 186, 104, 92, '#16244a');                       // head
  ell(256, 206, 72, 58, '#ffffff');                        // face
  ell(226, 196, 16, 22, '#111111'); ell(286, 196, 16, 22, '#111111');
  ell(231, 189, 5, 7, '#ffffff'); ell(291, 189, 5, 7, '#ffffff');
  g.fillStyle = '#ffb000'; g.beginPath(); g.moveTo(236, 226); g.lineTo(276, 226); g.lineTo(256, 252); g.closePath(); g.fill();
  g.fillStyle = '#1c56b7'; g.beginPath(); g.moveTo(160, 132); g.quadraticCurveTo(256, 20, 360, 128); g.lineTo(404, 70); g.lineTo(350, 150); g.closePath(); g.fill();   // night-cap
  ell(410, 64, 22, 22, '#ffffff');
  g.fillStyle = '#ffffff'; g.fillRect(156, 124, 204, 24);
  penguinMat = L.signMaterial(c, { emissive: 1.0, transparent: true });
  penguinMat.alphaTest = 0.5;
  return penguinMat;
}

/**
 * Dress an infill lot as MEGA ドン・キホーヂ: `face` = { a:[x,z], b:[x,z], nx, nz } street face (world, base-relative
 * heights), `h` building height, `y0` base level (terrain), `group` for the unbatched penguin board.
 */
export function dressDonki({ batch, inst, group }, face, h, y0) {
  const M = S.mats();
  const { a, b, nx, nz } = face;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]), tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
  const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, rot = Math.atan2(-tz, tx);
  const at = (s, out) => [mx + tx * s + nx * out, mz + tz * s + nz * out];
  const top = h - 1.2, bot = 5.2;
  // blue sign wall over floors 2–top with the yellow logo band and the slogan band
  batch.add(M.darkMetal, L.boxAt(mx + nx * 0.2, y0 + (bot + top) / 2, mz + nz * 0.2, len - 0.4, top - bot + 0.4, 0.3, rot, false), mx, mz);   // sign-wall frame
  S.signQuad(batch, mx + nx * 0.4, y0 + (bot + top) / 2, mz + nz * 0.4, nx, nz, { text: ' ', w: len - 0.8, h: top - bot, bg: '#1c56b7', fg: '#1c56b7', emissive: 0.35 });
  S.signQuad(batch, mx + nx * 0.52, y0 + top - 2.3, mz + nz * 0.52, nx, nz, { text: 'ドン・キホーヂ', sub: 'MEGA 渋谷本店', w: len - 1.6, h: 3.6, bg: '#ffe600', fg: '#1c56b7', emissive: 1.4, weight: '900' });
  S.signQuad(batch, mx + nx * 0.52, y0 + bot + 1.6, mz + nz * 0.52, nx, nz, { text: '驚安の殿堂', sub: '24時間営業  ・  食品 ・ 日用品 ・ コスメ ・ 家電', w: len - 2.4, h: 2.4, bg: '#e8141c', fg: '#ffe600', emissive: 1.3, weight: '900' });
  for (let k = 0; k < 3; k++) {
    const [px, pz] = at(-len / 2 + 2 + k * (len - 4) / 2, 0.52);
    S.signQuad(batch, px, y0 + (bot + top) / 2 + 0.6, pz, nx, nz, { text: ['激安', '免税', 'ドンキ'][k], w: 2.6, h: 2.6, bg: ['#ffe600', '#ffffff', '#e8141c'][k], fg: ['#e8141c', '#1c56b7', '#ffe600'][k], emissive: 1.3, weight: '900' });
  }
  // corner blade + penguin mascot board on the parapet
  const [bx, bz] = at(len / 2 - 0.4, 1.4);
  S.blade(batch, bx, y0 + (bot + top) / 2 + 1, bz, nx, nz, { text: 'ドン・キホーヂ', w: 1.8, h: top - bot - 2, bg: '#ffe600', fg: '#1c56b7', emissive: 1.4, weight: '900' });
  const pm = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), penguinBoard());
  const [ppx, ppz] = at(-len / 4, 0.8);
  L.placeFacing(pm, ppx, y0 + h + 3.2, ppz, nx, nz); pm.layers.enable(1); pm.name = 'donki_penguin';
  group.add(pm);
  for (const s of [-1.5, 1.5]) { const [qx, qz] = at(-len / 4 + s, 0.3); S.ibox(inst, 'lm_post', M.darkMetal, qx, y0 + h, qz, 0.14, 1.2, 0.14); }
  // entrance canopy with a lit soffit and piled-up goods (price-tag boxes) spilling onto the pavement
  batch.add(M.glowYellow, L.boxAt(mx + nx * 1.2, y0 + 4.3, mz + nz * 1.2, len - 1, 0.25, 2.4, rot, false), mx, mz);
  batch.add(M.darkMetal, L.boxAt(mx + nx * 1.2, y0 + 4.5, mz + nz * 1.2, len - 0.8, 0.2, 2.6, rot, false), mx, mz);
  const WARES = [0xe8141c, 0xffe600, 0x1c56b7, 0xffffff, 0x35c46a, 0xff7a1a];
  for (let k = 0; k < 14; k++) {
    const s = -len / 2 + 1.2 + (k % 7) * (len - 2.4) / 6, row = k < 7 ? 0.9 : 1.6;
    const [wx, wz] = at(s, row);
    S.ibox(inst, 'lm_hold', M.whiteMetal, wx, y0 + 0.15, wz, 1.1, 0.7 + (k % 3) * 0.25, 0.6, rot, WARES[k % WARES.length]);
  }
}

/**
 * The top of 文化村通り: 東急本店 site under redevelopment. (cx, cz) centre, dir (dx, dz) = direction of the street
 * (the hoarding faces back down it), y0 terrain level.
 */
export function buildRedevelopment({ batch, inst, group }, cx, cz, dx, dz, y0) {
  const M = S.mats();
  const rot = Math.atan2(-dz, dx), nx = -dx, nz = -dz;            // front faces back down the street
  const tx = -dz, tz = dx;
  const at = (u, v, y = 0) => [cx + tx * u + dx * v, y0 + y, cz + tz * u + dz * v];
  const W = 46, D = 40;
  // white hoarding (3 m panels with a green top stripe) + the project board
  const hp = L.rectPoly(cx, cz, D, W, rot);
  for (let i = 0; i < 4; i++) {
    const p = hp[i], q = hp[(i + 1) % 4], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const [ex, ez] = L.edgeNormal(L.ensureCW(hp), i);
    const ang = Math.atan2(-(q[1] - p[1]), q[0] - p[0]);
    batch.add(M.panelWhite, L.boxAt((p[0] + q[0]) / 2, y0 + 1.5, (p[1] + q[1]) / 2, len, 3, 0.12, ang, true), cx, cz);
    batch.add(M.glowGreen, L.boxAt((p[0] + q[0]) / 2 + ex * 0.07, y0 + 2.9, (p[1] + q[1]) / 2 + ez * 0.07, len, 0.12, 0.04, ang, false), cx, cz);
  }
  const [fx, , fz] = at(0, -D / 2 - 0.1);
  S.signQuad(batch, fx, y0 + 1.6, fz, nx, nz, { text: '(仮称)渋谷町 アッパー・ウエスト・プロジェクト', sub: '東急本店跡地 新築工事  2023–2027  ご迷惑をおかけします', w: 14, h: 1.6, bg: '#ffffff', fg: '#1a3a6a', emissive: 0.6, weight: '800' });
  // rising steel frame: 6 × 5 column grid, 9 levels done, top two only columns
  const cols = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) cols.push([-W / 2 + 5 + i * (W - 10) / 5, -D / 2 + 5 + j * (D - 10) / 4]);
  const LV = 4.2, done = 9, colTop = (done + 2) * LV;
  for (const [u, v] of cols) { const [x, , z] = at(u, v); S.ibox(inst, 'lm_post', M.darkMetal, x, y0, z, 0.6, colTop, 0.6, rot); }
  for (let l = 1; l <= done; l++) {
    const [x, , z] = at(0, 0);
    batch.add(M.concrete, L.boxAt(x, y0 + l * LV, z, D - 9, 0.35, W - 9, rot, true), x, z);
    if (l % 3 === 0) S.rimLights(inst, L.rectPoly(x, z, D - 9, W - 9, rot), y0 + l * LV + 0.6, { step: 7, out: 0.2 });
  }
  for (const [u] of cols.filter((c, k) => k % 5 === 0)) { const [x, , z] = at(u, 0); batch.add(M.redPaint, L.boxAt(x, y0 + colTop - 0.4, z, D - 10, 0.4, 0.4, rot, false), x, z); }
  // floodlit hoarding: three lamp heads on poles in front of the street face and their light wash on the panels
  {
    const [hx, , hz] = at(0, -D / 2 - 0.2);
    batch.add(floodWash(), L.wallQuad(hx, y0 + 1.6, hz, nx, nz, W - 2, 3.1, 0.05), cx, cz);
    for (const u of [-W / 3, 0, W / 3]) {
      const [px, , pz] = at(u, -D / 2 - 1.6);
      S.ibox(inst, 'lm_post', M.darkMetal, px, y0, pz, 0.14, 5.2, 0.14);
      batch.add(M.darkMetal, L.boxAt(px + nx * -0.4, y0 + 5.2, pz + nz * -0.4, 0.5, 0.35, 0.8, rot, false), cx, cz);
      batch.add(M.glowWhite, L.boxAt(px + nx * -0.82, y0 + 5.1, pz + nz * -0.82, 0.44, 0.26, 0.04, rot, false), cx, cz);
    }
  }
  // tower crane at the front-left corner (seen walking up the street) with its jib slewed out over the street, so
  // the jib and the aviation lamps close the vista: lattice mast (4 legs + bracing rungs), slewing unit, jib,
  // counter-jib + weights, cab, red lights
  const [mx, , mz] = at(-W / 2 + 6, -D / 2 + 6);
  const mastH = colTop + 30, legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [a, b] of legs) batch.add(M.whiteMetal, L.boxAt(mx + a * 0.8, y0 + mastH / 2, mz + b * 0.8, 0.16, mastH, 0.16, 0, false), mx, mz);
  for (let y = 2; y < mastH; y += 2.4) { batch.add(M.whiteMetal, L.boxAt(mx, y0 + y, mz - 0.8, 1.7, 0.1, 0.1, 0, false), mx, mz); batch.add(M.whiteMetal, L.boxAt(mx, y0 + y, mz + 0.8, 1.7, 0.1, 0.1, 0, false), mx, mz); batch.add(M.whiteMetal, L.boxAt(mx - 0.8, y0 + y + 1.2, mz, 0.1, 0.1, 1.7, 0, false), mx, mz); batch.add(M.whiteMetal, L.boxAt(mx + 0.8, y0 + y + 1.2, mz, 0.1, 0.1, 1.7, 0, false), mx, mz); }
  const lx0 = dz, lz0 = -dx, jx0 = lx0 * 0.9 - dx * 0.44, jz0 = lz0 * 0.9 - dz * 0.44, jl = Math.hypot(jx0, jz0);   // viewer's left, turned 25° toward them
  const jx = jx0 / jl, jz = jz0 / jl, jr = Math.atan2(-jz, jx);
  batch.add(M.whiteMetal, L.boxAt(mx + jx * 20, y0 + mastH + 1.2, mz + jz * 20, 44, 1.4, 1.2, jr, false), mx, mz);
  batch.add(M.whiteMetal, L.boxAt(mx - jx * 9, y0 + mastH + 1.2, mz - jz * 9, 16, 1.2, 1.6, jr, false), mx, mz);
  batch.add(M.concrete, L.boxAt(mx - jx * 15, y0 + mastH - 0.4, mz - jz * 15, 3.5, 2.6, 2.2, jr, true), mx, mz);
  batch.add(M.panelWhite, L.boxAt(mx + jx * 1.8, y0 + mastH - 0.6, mz + jz * 1.8, 2.2, 2.2, 2.2, jr, true), mx, mz);
  batch.add(M.whiteMetal, L.boxAt(mx, y0 + mastH + 4.5, mz, 1.1, 7, 1.1, jr, false), mx, mz);                           // A-frame peak
  batch.add(M.darkMetal, L.boxAt(mx + jx * 30, y0 + mastH - 8, mz + jz * 30, 0.04, 18, 0.04, 0, false), mx, mz);  // hoist line
  batch.add(M.whiteMetal, L.boxAt(mx + jx * 30, y0 + mastH - 17.3, mz + jz * 30, 0.6, 0.6, 0.6, 0, false), mx, mz);   // hook block
  // aviation lamps: A-frame peak, jib tip + mid, counter-jib end (what reads of a crane from the bottom of the street)
  for (const [t, dy, sz] of [[0, 8.1, 0.8], [42, 2, 0.7], [21, 2, 0.55], [-16, 2, 0.55]]) S.ibox(inst, 'lm_cranelamp', M.glowRed, mx + jx * t, y0 + mastH + dy, mz + jz * t, sz, sz * 0.8, sz);
  void group;
}

export default { dressDonki, buildRedevelopment };
