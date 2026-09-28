// [city] Shared landmark helpers: curtain-wall / panel materials with random lit floors (canvas, metre UVs), storey
// rings, instanced vertical fins, parapets, cylinder segments (109 drum, Q-FRONT curve), wrapped lettering,
// facade records and colliders. Every builder in this folder uses these so the landmarks share a material set
// (few draw calls) and follow the same night factor (setNight).
import * as THREE from 'three';
import * as L from './lib.js';
import { getAtlases, shopUV, shopQuad, railAlong, ductRun, shopFrontDepth, claimRealTenant, realCountAlong, registerShopBay } from './genericBuilding.js';
import { TENANT_TYPE } from './tenantsData.js';
import { CANVAS_K } from '../../core/mobileProfile.js';

const nightMats = [];   // [{mat, day, night}]
let M = null;
export const HEDGE_GEO = new THREE.SphereGeometry(0.55, 7, 5);   // shared hedge blob (hachiko / parco / miyashita / medians)

// ------------------------------------------------------------------------------------------------- textures
/**
 * Curtain wall / panel facade texture covering W × H metres (bays × storeys). spandrelFrac = opaque part of each
 * storey (0 = all glass, 0.7 = slit windows). lit = probability a run of bays on a floor is lit at night.
 */
function curtainTex({ W = 12, H = 28, bays = 8, storeys = 8, glass = [70, 92, 118], spandrel = [40, 44, 52], mullion = [22, 24, 28], lit = 0.5, warm = 0.65, seed = 1, spandrelFrac = 0.26, litColor = [255, 214, 160], coolColor = [205, 222, 255], ribs = 0, joints = true, punched = 0, tint = null, bright = [0.55, 1.0], flood = 0, floodColor = [252, 248, 242], mode = 'runs', tower = false , frame = null} = {}) {
  // towers: 24 storeys × 8 bays on a 512 × 2048 canvas (84 m repeat, no visible 8-storey tiling on a 230 m shaft);
  // panels: 8 storeys on 512 × 512
  if (tower) { storeys = 24; H = 84; }
  const CW = 512, CH = tower ? 2048 : 512;
  const map = L.makeCanvas(CW, CH), emi = L.makeCanvas(CW, CH);
  const mc = map.getContext('2d'), ec = emi.getContext('2d');
  const rgb = (c, m = 1) => `rgb(${Math.min(255, c[0] * m) | 0},${Math.min(255, c[1] * m) | 0},${Math.min(255, c[2] * m) | 0})`;
  mc.fillStyle = rgb(spandrel); mc.fillRect(0, 0, CW, CH);
  // `flood` = faint uniform emissive base (sRGB 0..1) so floodlit aluminium (109, MAGNET) reads pale grey at night
  ec.fillStyle = flood ? rgb(floodColor, flood) : '#000'; ec.fillRect(0, 0, CW, CH);
  const bw = CW / bays, rh = CH / storeys;
  for (let r = 0; r < storeys; r++) {
    const y1 = CH - r * rh, y0 = y1 - rh;               // row r from the bottom (v grows upward)
    const sp = rh * spandrelFrac;
    const gy0 = y0 + 3, gy1 = y1 - sp;                  // glass band
    // lit runs: 'runs' = 1–4 bay tenant runs, 'office' = whole floors on / off, 'hotel' = sparse single rooms
    const runs = [];
    let b = 0;
    const floorOn = L.hash(r, 0, seed + 3) < lit, floorBright = bright[0] + L.hash(r, 1, seed + 5) * (bright[1] - bright[0]), floorWarm = L.hash(r, 2, seed + 7) < warm;
    while (b < bays) {
      if (mode === 'office') { runs.push({ b, len: 1, on: floorOn ? L.hash(b, r, seed + 3) < 0.9 : L.hash(b, r, seed + 3) < 0.05, bright: floorBright * (0.92 + L.hash(b, r, seed + 5) * 0.08), warm: floorWarm }); b++; continue; }
      if (mode === 'hotel') { runs.push({ b, len: 1, on: L.hash(b, r, seed + 3) < lit, bright: bright[0] + L.hash(b, r, seed + 5) * (bright[1] - bright[0]), warm: L.hash(b, r, seed + 7) < warm }); b++; continue; }
      const len = 1 + Math.floor(L.hash(b, r, seed + 11) * 4);
      const on = L.hash(b, r, seed + 3) < lit;
      runs.push({ b, len: Math.min(len, bays - b), on, bright: bright[0] + L.hash(b, r, seed + 5) * (bright[1] - bright[0]), warm: L.hash(b, r, seed + 7) < warm });
      b += len;
    }
    for (const run of runs) {
      const x0 = run.b * bw, x1 = (run.b + run.len) * bw;
      const pw = punched ? bw * punched : 0;             // punched windows: glass only in the middle of the bay
      for (let k = run.b; k < run.b + run.len; k++) {
        const bx0 = punched ? k * bw + (bw - pw) / 2 : k * bw, bx1 = punched ? bx0 + pw : (k + 1) * bw;
        if (!run.on) {
          const g = mc.createLinearGradient(0, gy0, 0, gy1);
          g.addColorStop(0, rgb(glass, 1.25)); g.addColorStop(0.45, rgb(glass, 0.95)); g.addColorStop(1, rgb(glass, 0.6));
          mc.fillStyle = g; mc.fillRect(bx0, gy0, bx1 - bx0, gy1 - gy0);
          // faint reflection streak
          mc.fillStyle = 'rgba(200,215,240,0.10)'; mc.beginPath(); mc.moveTo(bx0 + (bx1 - bx0) * 0.55, gy0); mc.lineTo(bx0 + (bx1 - bx0) * 0.85, gy0); mc.lineTo(bx0 + (bx1 - bx0) * 0.3, gy1); mc.lineTo(bx0 + (bx1 - bx0) * 0.05, gy1); mc.closePath(); mc.fill();
        } else {
          const col = run.warm ? litColor : coolColor;
          const m = run.bright;
          mc.fillStyle = rgb(col, m); mc.fillRect(bx0, gy0, bx1 - bx0, gy1 - gy0);
          ec.fillStyle = rgb(col, m); ec.fillRect(bx0, gy0, bx1 - bx0, gy1 - gy0);
          // ceiling light line + interior silhouettes
          mc.fillStyle = 'rgba(255,255,255,0.35)'; mc.fillRect(bx0, gy0 + 2, bx1 - bx0, 2);
          ec.fillStyle = 'rgba(255,255,255,0.5)'; ec.fillRect(bx0, gy0 + 2, bx1 - bx0, 2);
          if (mode === 'office') {
            // office floor: ceiling-grid line, a desk band with monitors, a dark spandrel foot
            const gh = gy1 - gy0;
            mc.fillStyle = 'rgba(0,0,0,0.18)'; mc.fillRect(bx0, gy0 + gh * 0.2, bx1 - bx0, 1); ec.fillStyle = 'rgba(0,0,0,0.25)'; ec.fillRect(bx0, gy0 + gh * 0.2, bx1 - bx0, 1);
            mc.fillStyle = 'rgba(40,36,34,0.5)'; mc.fillRect(bx0 + 2, gy1 - gh * 0.42, bx1 - bx0 - 4, gh * 0.08); ec.fillStyle = 'rgba(0,0,0,0.55)'; ec.fillRect(bx0 + 2, gy1 - gh * 0.42, bx1 - bx0 - 4, gh * 0.08);
            if (L.hash(k, r, seed + 17) < 0.6) { const mx = bx0 + (bx1 - bx0) * (0.2 + L.hash(k, r, seed + 19) * 0.5); mc.fillStyle = 'rgba(30,30,36,0.7)'; mc.fillRect(mx, gy1 - gh * 0.58, (bx1 - bx0) * 0.16, gh * 0.14); ec.fillStyle = 'rgba(0,0,0,0.5)'; ec.fillRect(mx, gy1 - gh * 0.58, (bx1 - bx0) * 0.16, gh * 0.14); }
            mc.fillStyle = 'rgba(0,0,0,0.5)'; mc.fillRect(bx0, gy1 - gh * 0.3, bx1 - bx0, gh * 0.3); ec.fillStyle = 'rgba(0,0,0,0.6)'; ec.fillRect(bx0, gy1 - gh * 0.3, bx1 - bx0, gh * 0.3);
          } else {
            const nf = Math.floor(L.hash(k, r, seed + 9) * 3);
            for (let f = 0; f < nf; f++) {
              const fx = bx0 + (bx1 - bx0) * (0.1 + L.hash(k * 3 + f, r, seed + 13) * 0.7), fw = (bx1 - bx0) * 0.12, fh = (gy1 - gy0) * (0.25 + L.hash(f, r, seed + 15) * 0.3);
              mc.fillStyle = 'rgba(20,16,14,0.55)'; mc.fillRect(fx, gy1 - fh, fw, fh);
              ec.fillStyle = 'rgba(0,0,0,0.6)'; ec.fillRect(fx, gy1 - fh, fw, fh);
            }
          }
        }
      }
      // `frame`: a coloured frame round every window (渋谷駅前ビル's red window frames)
      if (frame) { mc.strokeStyle = rgb(frame); mc.lineWidth = 7; for (let k = run.b; k < run.b + run.len; k++) { const bx0 = punched ? k * bw + (bw - bw * punched) / 2 : k * bw, bx1 = punched ? bx0 + bw * punched : (k + 1) * bw; mc.strokeRect(bx0 + 3.5, gy0 + 0.5, bx1 - bx0 - 7, gy1 - gy0 - 1); } }
      void x0; void x1;
    }
    // spandrel shading + joints
    const sg = mc.createLinearGradient(0, gy1, 0, y1);
    sg.addColorStop(0, 'rgba(255,255,255,0.10)'); sg.addColorStop(0.5, 'rgba(0,0,0,0)'); sg.addColorStop(1, 'rgba(0,0,0,0.18)');
    mc.fillStyle = sg; mc.fillRect(0, gy1, CW, sp);
    if (joints) { mc.fillStyle = rgb(mullion); mc.fillRect(0, gy1 - 1, CW, 3); mc.fillRect(0, y0, CW, 3); }
  }
  if (joints) { mc.fillStyle = rgb(mullion); for (let k = 0; k <= bays; k++) mc.fillRect(Math.round(k * bw) - 1, 0, 3, CH); }
  if (ribs) {   // corrugation every `ribs` px (12 px ≈ 30 cm real pitch): 2 px shadow + 1 px half-tone + 2 px highlight
    mc.fillStyle = 'rgba(0,0,0,0.30)'; for (let x = 0; x < CW; x += ribs) mc.fillRect(x, 0, 2, CH);
    mc.fillStyle = 'rgba(0,0,0,0.12)'; for (let x = 2; x < CW; x += ribs) mc.fillRect(x, 0, 1, CH);
    mc.fillStyle = 'rgba(255,255,255,0.22)'; for (let x = 5; x < CW; x += ribs) mc.fillRect(x, 0, 2, CH);
  }
  if (tint) { mc.fillStyle = tint; mc.fillRect(0, 0, CW, CH); }
  const tm = L.canvasTex(map, { wrap: true }), te = L.canvasTex(emi, { wrap: true });
  tm.repeat.set(1 / W, 1 / H); te.repeat.set(1 / W, 1 / H);
  return { map: tm, emissiveMap: te };
}

function curtainMat(name, opts, { roughness = 0.25, metalness = 0.6, env = 1.2, day = 0.05, night = 1.1 } = {}) {
  const t = curtainTex(opts);
  const m = new THREE.MeshStandardMaterial({ map: t.map, emissiveMap: t.emissiveMap, emissive: 0xffffff, emissiveIntensity: night, roughness, metalness, envMapIntensity: env });
  m.name = 'lm_' + name; m.userData.keepShadow = true;
  // the painted window layout (UV metres), so relief.js can stand real piers / sill bands on the painted grid
  const tw = !!opts.tower, st = tw ? 24 : (opts.storeys ?? 8);
  m.userData.curtain = { W: opts.W ?? 12, H: tw ? 84 : (opts.H ?? 28), bays: opts.bays ?? 8, storeys: st, punched: opts.punched ?? 0, spandrelFrac: opts.spandrelFrac ?? 0.26, topFrac: 3 / ((tw ? 2048 : 512) / st) };
  nightMats.push({ mat: m, day, night });
  return m;
}
function glow(name, color, night = 2.4, day = 0.0) {
  const m = L.std({ color, emissive: color, emissiveIntensity: night, roughness: 0.5, metalness: 0 });
  m.name = 'lm_' + name; m.userData.noShadow = true;
  nightMats.push({ mat: m, day, night });
  return m;
}

function mergeGeos(list) {
  const pos = [], nor = [], uv = [], idx = []; let base = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0); }
    for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + base);
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); out.setIndex(idx);
  return out;
}
/** Paper lantern (提灯) instance: bottom-centred, scaled to (w, h, w). */
export function lantern(inst, x, y, z, w = 0.3, h = 0.44) { inst.add('lm_chochin', mats().lanternGeo, mats().lantern, x, y, z, 0, w, h, w); }
/** Shared material set (built once). */
export function mats() {
  if (M) return M;
  M = {
    // curtain walls / panels (metre UVs: 12 m × 28 m per repeat unless noted)
    // metalness stays low on the opaque panel walls: a metal has no diffuse term, so under the dim night IBL a
    // metallic spandrel goes black. Floodlit landmarks (109 drum, MAGNET, Q-FRONT) get a faint emissive base.
    // towers: 24-storey canvases, offices light whole floors (p 0.6), the hotel lights sparse single rooms (p 0.35)
    glassTower:   curtainMat('glassTower',   { seed: 21, glass: [64, 84, 112], spandrel: [30, 34, 42], lit: 0.6, spandrelFrac: 0.22, flood: 0.08, tower: true, mode: 'office' }, { roughness: 0.28, metalness: 0.45 }),
    glassTower2:  curtainMat('glassTower2',  { seed: 41, glass: [58, 78, 104], spandrel: [44, 46, 52], lit: 0.55, spandrelFrac: 0.3, bays: 6, warm: 0.45, flood: 0.08, litColor: [232, 236, 255], tower: true, mode: 'office' }, { roughness: 0.3, metalness: 0.4 }),
    glassTower3:  curtainMat('glassTower3',  { seed: 42, glass: [72, 88, 108], spandrel: [92, 88, 82], lit: 0.35, spandrelFrac: 0.4, bays: 10, warm: 0.85, flood: 0.1, litColor: [255, 206, 150], tower: true, mode: 'hotel' }, { roughness: 0.35, metalness: 0.3 }),
    glassSakura:  curtainMat('glassSakura',  { seed: 43, glass: [80, 92, 116], spandrel: [36, 38, 44], lit: 0.55, spandrelFrac: 0.2, bays: 9, warm: 0.55, flood: 0.06, tower: true, mode: 'office' }, { roughness: 0.26, metalness: 0.45 }),
    glassHikarie: curtainMat('glassHikarie', { seed: 22, glass: [88, 104, 124], spandrel: [58, 62, 70], lit: 0.6, spandrelFrac: 0.18, warm: 0.5, flood: 0.08, tower: true, mode: 'office' }, { roughness: 0.28, metalness: 0.45 }),
    glassDark:    curtainMat('glassDark',    { seed: 23, glass: [38, 42, 50], spandrel: [22, 24, 28], lit: 0.32, spandrelFrac: 0.3, flood: 0.05 }, { roughness: 0.3, metalness: 0.5 }),
    glassStream:  curtainMat('glassStream',  { seed: 24, glass: [70, 100, 110], spandrel: [120, 124, 128], lit: 0.55, spandrelFrac: 0.34, flood: 0.08, tower: true, mode: 'office' }, { roughness: 0.3, metalness: 0.35 }),
    // 渋谷駅前ビル: white panels, every window in a red frame (Street View 2023-09, the 西口 face)
    panelRedFrame: curtainMat('panelRedFrame', { seed: 33, glass: [46, 58, 78], spandrel: [230, 228, 222], mullion: [206, 204, 198], frame: [204, 34, 42], lit: 0.4, spandrelFrac: 0.36, bays: 6, punched: 0.74, flood: 0.14 }, { roughness: 0.5, metalness: 0.1 }),
    panelWhite:   curtainMat('panelWhite',   { seed: 25, glass: [48, 60, 78], spandrel: [214, 212, 206], mullion: [150, 150, 146], lit: 0.45, spandrelFrac: 0.55, flood: 0.14 }, { roughness: 0.5, metalness: 0.15 }),
    // 109 drum / MAGNET spandrels: cool aluminium, strong 30 cm corrugation, cool floodlight
    panelSilver:  curtainMat('panelSilver',  { seed: 26, glass: [40, 46, 56], spandrel: [168, 172, 180], mullion: [120, 122, 126], lit: 0.15, spandrelFrac: 0.82, ribs: 12, joints: false, bright: [0.3, 0.8], flood: 0.32, floodColor: [236, 240, 248] }, { roughness: 0.5, metalness: 0.2, env: 1.0 }),
    panelGrey:    curtainMat('panelGrey',    { seed: 27, glass: [40, 48, 60], spandrel: [150, 156, 170], mullion: [90, 94, 104], lit: 0.4, spandrelFrac: 0.6, flood: 0.26 }, { roughness: 0.55, metalness: 0.15, env: 1.0 }),
    brownFins:    curtainMat('brownFins',    { seed: 28, glass: [34, 30, 28], spandrel: [72, 50, 38], mullion: [40, 26, 20], lit: 0.35, spandrelFrac: 0.5, bays: 12, flood: 0.06 }, { roughness: 0.6, metalness: 0.2 }),
    tileTan:      curtainMat('tileTan',      { seed: 29, glass: [50, 58, 70], spandrel: [198, 178, 142], mullion: [140, 122, 96], lit: 0.4, spandrelFrac: 0.45, punched: 0.6, flood: 0.12 }, { roughness: 0.8, metalness: 0.05 }),
    yellow:       curtainMat('yellow',       { seed: 30, glass: [50, 50, 56], spandrel: [250, 205, 20], mullion: [200, 160, 10], lit: 0.5, spandrelFrac: 0.62, punched: 0.5, flood: 0.18 }, { roughness: 0.6, metalness: 0.05 }),
    darkGrid:     curtainMat('darkGrid',     { seed: 31, glass: [46, 50, 58], spandrel: [34, 36, 40], mullion: [80, 82, 86], lit: 0.4, spandrelFrac: 0.3, bays: 6, flood: 0.1 }, { roughness: 0.45, metalness: 0.3 }),
    concreteWin:  curtainMat('concreteWin',  { seed: 32, glass: [52, 58, 70], spandrel: [150, 148, 142], mullion: [100, 98, 94], lit: 0.35, spandrelFrac: 0.5, punched: 0.7, flood: 0.1 }, { roughness: 0.85, metalness: 0.05 }),
    // plain
    darkMetal: L.std({ color: 0x2a2c30, roughness: 0.45, metalness: 0.7 }),
    silver: L.std({ color: 0xc8ccd0, roughness: 0.4, metalness: 0.35, envMapIntensity: 1.2 }),   // small trim only
    // storey ledges / parapets: dielectric so they do not mirror the magenta sky IBL into pink stripes
    ledge: L.std({ color: 0xb0b4b8, roughness: 0.6, metalness: 0.1, envMapIntensity: 0.5 }),
    whiteMetal: L.std({ color: 0xe6e6e2, roughness: 0.55, metalness: 0.12, envMapIntensity: 0.6 }),
    redPaint: L.std({ color: 0xd8203a, roughness: 0.45, metalness: 0.3 }),
    pink: L.std({ color: 0xe8306a, roughness: 0.5, metalness: 0.2 }),
    concrete: L.std({ map: L.noiseTex({ size: 256, base: [150, 148, 142], variance: 12, seed: 601, low: 1.0, draw: (ctx, s) => { ctx.fillStyle = 'rgba(0,0,0,0.25)'; for (let i = 0; i <= 3; i++) { ctx.fillRect(Math.round(i * s / 3), 0, 2, s); ctx.fillRect(0, Math.round(i * s / 3), s, 2); } for (let k = 0; k < 24; k++) { ctx.fillStyle = `rgba(0,0,0,${0.04 + L.hash(k, 1, 6) * 0.12})`; ctx.fillRect(L.hash(k, 2, 6) * s, L.hash(k, 3, 6) * s, 3, 20 + L.hash(k, 4, 6) * 80); } } }), roughness: 0.9 }),
    granite: L.std({ map: L.noiseTex({ size: 256, base: [120, 116, 110], variance: 22, seed: 602, low: 0.4 }), roughness: 0.55, metalness: 0.05, envMapIntensity: 0.8 }),
    stoneLight: L.std({ map: L.noiseTex({ size: 256, base: [186, 180, 168], variance: 12, seed: 603, low: 0.6 }), roughness: 0.7 }),
    bronze: L.std({ map: L.noiseTex({ size: 128, base: [88, 66, 40], variance: 26, seed: 607, low: 0.9, draw: (ctx, s) => { for (let k = 0; k < 30; k++) { ctx.fillStyle = `rgba(60,110,80,${0.08 + L.hash(k, 1, 8) * 0.18})`; ctx.fillRect(L.hash(k, 2, 8) * s, L.hash(k, 3, 8) * s, 6 + L.hash(k, 4, 8) * 30, 4 + L.hash(k, 5, 8) * 20); } } }), roughness: 0.58, metalness: 0.75, envMapIntensity: 0.8 }),   // patinated statue bronze
    bronzeDark: L.std({ color: 0x3a2a18, roughness: 0.45, metalness: 0.85 }),
    wood: L.std({ map: L.noiseTex({ size: 128, base: [96, 66, 42], variance: 18, seed: 604, low: 0.5, draw: (ctx, s) => { ctx.fillStyle = 'rgba(0,0,0,0.35)'; for (let i = 0; i < 10; i++) ctx.fillRect(0, i * s / 10, s, 2); } }), roughness: 0.85 }),
    lawn: L.std({ map: L.noiseTex({ size: 256, base: [72, 118, 52], variance: 22, seed: 605, low: 0.5 }), roughness: 0.95 }),
    hedge: L.std({ color: 0x2f5a2a, roughness: 0.95 }),
    tile: L.std({ map: L.noiseTex({ size: 256, base: [222, 220, 214], variance: 8, seed: 606, draw: (ctx, s) => { ctx.fillStyle = 'rgba(90,90,88,0.5)'; for (let i = 0; i <= 12; i++) { ctx.fillRect(Math.round(i * s / 12), 0, 1, s); ctx.fillRect(0, Math.round(i * s / 12), s, 1); } } }), roughness: 0.6, metalness: 0.05 }),
    glassClear: L.std({ color: 0xaac4dc, roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0.45, envMapIntensity: 1.5 }),   // FrontSide: every user is a box / outward wall
    glassGreen: L.std({ color: 0x8fb8b0, roughness: 0.12, metalness: 0.8, transparent: true, opacity: 0.5, envMapIntensity: 1.5 }),
    glowWhite: glow('glowWhite', 0xf4f0e6, 1.35),   // crown / rim strips: kept low so bloom does not smear them into bars
    glowWhiteDim: glow('glowWhiteDim', 0xf4f0e6, 0.6),   // 0.4 m parapet marker lights (rimLights)
    glowWarm: glow('glowWarm', 0xffd9a0, 2.2),
    glowRed: glow('glowRed', 0xff2a2a, 2.8),
    glowOrange: glow('glowOrange', 0xff8c30, 2.6),
    glowGreen: glow('glowGreen', 0x1d8f3e, 1.8),
    glowYellow: glow('glowYellow', 0xffd400, 2.0),
    glowBlue: glow('glowBlue', 0x2a6ad0, 1.8),
    lantern: glow('lantern', 0xff4a20, 2.4, 0.15),
    interior: glow('interior', 0xfff0d0, 1.3, 0.35),
    interiorDim: glow('interiorDim', 0xf6e6c8, 0.5, 0.2),   // walkways / bridges / long glazed bands
    jrGreen: (() => { const m = L.std({ color: 0x2f7d3a, emissive: 0x2f7d3a, emissiveIntensity: 0.4, roughness: 0.6, metalness: 0.1 }); nightMats.push({ mat: m, day: 0.05, night: 0.4 }); return m; })(),
    lampGlass: (() => { const m = L.std({ color: 0xff3030, emissive: 0xff2a2a, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0, transparent: true, opacity: 0.85 }); m.userData.noShadow = true; nightMats.push({ mat: m, day: 0.3, night: 1.2 }); return m; })(),
    innerDark: L.std({ color: 0x0a0a0c, roughness: 1, metalness: 0 }),
  };
  M.lanternGeo = (() => { const g = new THREE.CylinderGeometry(0.42, 0.42, 1, 10); g.translate(0, 0.5, 0); const cap = new THREE.CylinderGeometry(0.2, 0.2, 0.06, 8); cap.translate(0, 1.0, 0); const cap2 = cap.clone(); cap2.translate(0, -1.0, 0); const out = mergeGeos([g, cap, cap2]); return out; })();
  for (const [k, m] of Object.entries(M)) if (!m.name || !m.name.startsWith('lm_')) m.name = 'lm_' + k;
  M.glassClear.userData.noShadow = true; M.glassGreen.userData.noShadow = true;
  M.stoneLight.userData.noShadow = true; M.jrGreen.userData.noShadow = true;   // deck / floor surfaces and the thin JR band
  return M;
}
/** Register a builder's own material so its emissive follows the night factor like the shared set. */
export function nightMaterial(mat, day, night) { nightMats.push({ mat, day, night }); mat.emissiveIntensity = night; return mat; }
export function setNight(f) {
  f = Math.max(0, Math.min(1, f));
  for (const e of nightMats) e.mat.emissiveIntensity = e.day + (e.night - e.day) * f;
}

// ------------------------------------------------------------------------------------------------- geometry
const cxz = (poly) => L.polyCentroid(poly);
/** Dark roofing-membrane material (shared with the infill generator). */
export function roofMat() { return getAtlases().roofMat; }
/**
 * Extruded polygon into the batch (metre UVs). Masses taller than 8 m get the roof membrane as their top cap
 * (capMat: false keeps the wall material, capMat: mat overrides).
 */
export function prism(batch, mat, poly, y0, y1, { cap = true, bottom = false, uvScale = 1, capMat = undefined, uFace = 0 } = {}) {
  const c = cxz(poly);
  const rm = capMat === undefined ? (cap && y1 - y0 > 8 ? roofMat() : null) : capMat;
  if (cap && rm && rm !== mat) {
    batch.add(mat, L.extrudePolygon(poly, y0, y1, { cap: false, bottom, uvScale, uFace }), c[0], c[1]);
    batch.add(rm, L.polygonCap(poly, y1, 0.25), c[0], c[1]);
  } else batch.add(mat, L.extrudePolygon(poly, y0, y1, { cap, bottom, uvScale, uFace }), c[0], c[1]);
}
/**
 * Explicit rooftop plant for a landmark roof at height y: perimeter maintenance rail, water tanks, AC units, duct
 * runs, stair bulkhead with ladder + lit door, red aviation light on every mass above 30 m. Deterministic from `seed`.
 */
export function roofPlant(batch, inst, polyIn, y, { seed = 1, tanks = 2, ac = 7, ducts = 2, rail = true, bulkhead = true, inset = 1.8, aviation = null } = {}) {
  const At = getAtlases(), Mm = mats();
  const poly = L.ensureCW(polyIn);
  const inner = L.offsetPolygon(poly, -inset), bb = L.polyBounds(inner);
  let k = 0;
  const pick = () => { for (let t = 0; t < 16; t++, k++) { const x = bb.x0 + L.hash(k, 1, seed) * bb.w, z = bb.z0 + L.hash(k, 2, seed) * bb.d; if (L.pointInPoly(x, z, inner)) return [x, z]; } return null; };
  const rngLite = { range: (a, b) => a + L.hash(k++, 9, seed) * (b - a) };
  if (rail) railAlong(inst, At, L.offsetPolygon(poly, -0.4), y);
  let top = null;
  if (bulkhead) {
    const p = pick();
    if (p) {
      const r = L.hash(3, 7, seed) * 3.14, cr = Math.cos(r), sr = Math.sin(r);
      batch.add(Mm.concrete, L.boxAt(p[0], y + 1.5, p[1], 4.5, 3, 5.5, r, true), p[0], p[1]);
      inst.add('ladder', At.geos.ladder, At.metal, p[0] + cr * 2.25, y, p[1] - sr * 2.25, r + Math.PI / 2);
      batch.add(Mm.interior, L.wallQuad(p[0] - cr * 2.25, y + 1.05, p[1] + sr * 2.25, -cr, sr, 1.0, 2.0, 0.03), p[0], p[1]);   // lit stair door
      top = [p[0], y + 3, p[1]];
    }
  }
  for (let i = 0; i < tanks; i++) { const p = pick(); if (p) inst.add('tank', At.geos.tank, At.tankMat, p[0], y, p[1], L.hash(i, 3, seed) * 6.28); }
  for (let i = 0; i < ac; i++) { const p = pick(); if (p) inst.add('acBig', At.geos.acBig, At.acMat, p[0], y, p[1], L.hash(i, 4, seed) * 6.28, 1, 1, 1, L.hash(i, 8, seed) < 0.7 ? 0xe0e0dc : 0xb8bcc0); }
  for (let i = 0; i < ducts; i++) { const p = pick(); if (p) ductRun(batch, At, p[0], y, p[1], L.hash(i, 5, seed) * 6.28, 4 + Math.floor(L.hash(i, 6, seed) * 4), inner, rngLite); }
  if (aviation ?? y > 30) {
    const p = top || (() => { const q = pick() || [bb.cx, bb.cz]; inst.add('lm_post', UNIT_BOX, Mm.darkMetal, q[0], y, q[1], 0, 0.12, 2.2, 0.12); return [q[0], y + 2.2, q[1]]; })();
    inst.add('lm_aviation', UNIT_BOX, Mm.glowRed, p[0], p[1], p[2], 0, 0.3, 0.3, 0.3);   // a point lamp, never a bar
  }
}
/** 0.4 m parapet marker lights every `step` metres (never a continuous lit tube on a roof edge). */
export function rimLights(inst, polyIn, y, { step = 6, out = 0.35, w = 0.4, mat = null } = {}) {
  const p = L.offsetPolygon(L.ensureCW(polyIn), out);
  for (const q of L.alongPolyline([...p, p[0]], step, step / 2)) inst.add('lm_rimlight', UNIT_BOX, mat || mats().glowWhiteDim, q.x, y, q.z, L.rotYOf(q.dx, q.dz), w, 0.12, 0.14);
}
/** Horizontal slab-edge rings every `step` metres from y0 to y1 (sticking out by `out`). */
export function rings(batch, mat, poly, y0, y1, step, { out = 0.3, h = 0.35, start = 0 } = {}) {
  const p = L.offsetPolygon(L.ensureCW(poly), out);
  const c = cxz(poly);
  for (let y = y0 + start; y <= y1 - h; y += step) batch.add(mat, L.extrudePolygon(p, y, y + h, { cap: true, bottom: true }), c[0], c[1]);
}
/** Parapet wall along the polygon edge at height y. */
export function parapet(batch, mat, poly, y, { h = 1.0, t = 0.3, out = 0 } = {}) {
  const p = L.ensureCW(poly), n = p.length, c = cxz(poly);
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const [nx, nz] = L.edgeNormal(p, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    batch.add(mat, L.boxAt((a[0] + b[0]) / 2 + nx * (out - t / 2), y + h / 2, (a[1] + b[1]) / 2 + nz * (out - t / 2), len, h, t, Math.atan2(-(b[1] - a[1]), b[0] - a[0]), true), c[0], c[1]);
  }
}
const unitBox = new THREE.BoxGeometry(1, 1, 1); unitBox.translate(0, 0.5, 0);
export const UNIT_BOX = unitBox;
/** Instanced vertical fins along every edge of a polygon (name groups instances). */
export function fins(inst, name, mat, poly, y0, y1, spacing, { w = 0.35, d = 0.7, out = 0, margin = 0.6 } = {}) {
  const p = L.ensureCW(poly), n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const [nx, nz] = L.edgeNormal(p, i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < spacing) continue;
    const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
    const rot = L.rotYOf(tx, tz);
    const k = Math.floor((len - 2 * margin) / spacing);
    const s0 = (len - k * spacing) / 2;
    for (let j = 0; j <= k; j++) {
      const s = s0 + j * spacing;
      inst.add(name, unitBox, mat, a[0] + tx * s + nx * (out + d / 2), y0, a[1] + tz * s + nz * (out + d / 2), rot, w, y1 - y0, d);
    }
  }
}
/** Instanced box helper: bottom-centred unit box scaled to (w,h,d). */
export function ibox(inst, name, mat, x, y, z, w, h, d, rotY = 0, color = null) { inst.add(name, unitBox, mat, x, y, z, rotY, w, h, d, color); }
/** Copy of a geometry scaled (s or [sx,sy,sz]), rotated (rx, rz, then ry) and moved to (x,y,z) — for sculpting from primitives. */
export function placed(geo, x, y, z, { rx = 0, ry = 0, rz = 0, s = 1 } = {}) {
  const g = geo.clone();
  if (Array.isArray(s)) g.scale(s[0], s[1], s[2]); else if (s !== 1) g.scale(s, s, s);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

function orient(pos, idx, nrm) {
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const e1x = pos[b * 3] - ax, e1y = pos[b * 3 + 1] - ay, e1z = pos[b * 3 + 2] - az;
    const e2x = pos[c * 3] - ax, e2y = pos[c * 3 + 1] - ay, e2z = pos[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (nx * nrm[a * 3] + ny * nrm[a * 3 + 1] + nz * nrm[a * 3 + 2] < 0) { idx[t + 1] = c; idx[t + 2] = b; }
  }
}
/**
 * Open cylinder wall segment centred (cx,cz), radius r, y0..y1, angles th0..th1 (x/z plane, θ=0 → +x, θ=π/2 → +z).
 * uv: u 0..uRep across the arc, v 0..vRep bottom→top (or metres when metres=true).
 */
export function cylSegment(cx, cz, r, y0, y1, th0, th1, seg = 48, { uRep = 1, vRep = 1, metres = false, inward = false, vScale = 1, flipU = false } = {}) {
  const pos = [], nor = [], uv = [], idx = [];
  const arc = Math.abs(th1 - th0) * r;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, th = th0 + (th1 - th0) * t;
    const c = Math.cos(th), s = Math.sin(th);
    const nx = inward ? -c : c, nz = inward ? -s : s;
    pos.push(cx + r * c, y0, cz + r * s, cx + r * c, y1, cz + r * s);
    nor.push(nx, 0, nz, nx, 0, nz);
    const tt = flipU ? 1 - t : t;                                          // seen from outside, text runs with decreasing θ
    const u = metres ? tt * arc : tt * uRep;
    uv.push(u, metres ? y0 * vScale : 0, u, metres ? y1 * vScale : vRep);
    if (i > 0) { const b = (i - 1) * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  orient(pos, idx, nor);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
/** Flat annulus / disc (or sector th0..th1) at height y. */
export function disc(cx, cz, r0, r1, y, { seg = 48, up = true, th0 = 0, th1 = Math.PI * 2 } = {}) {
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const th = th0 + (th1 - th0) * i / seg, c = Math.cos(th), s = Math.sin(th);
    pos.push(cx + r0 * c, y, cz + r0 * s, cx + r1 * c, y, cz + r1 * s);
    nor.push(0, up ? 1 : -1, 0, 0, up ? 1 : -1, 0);
    uv.push(r0 * c, r0 * s, r1 * c, r1 * s);
    if (i > 0) { const b = (i - 1) * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  orient(pos, idx, nor);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
/** Arc of [x,z] points (for polygon faces that must curve). */
export function arcPoints(cx, cz, r, th0, th1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) { const th = th0 + (th1 - th0) * i / n; out.push([cx + r * Math.cos(th), cz + r * Math.sin(th)]); }
  return out;
}
/** Replace polygon edge i (a→b) by an arc bulging outward by `bulge` metres. Returns a new polygon. */
export function bulgeEdge(polyIn, i, bulge, n = 10) {
  const poly = L.ensureCW(polyIn);
  const a = poly[i], b = poly[(i + 1) % poly.length];
  const [nx, nz] = L.edgeNormal(poly, i);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const R = (len * len / 4 + bulge * bulge) / (2 * bulge);         // circle radius through a, b with sagitta = bulge
  const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
  const cx = mx - nx * (R - bulge), cz = mz - nz * (R - bulge);
  const t0 = Math.atan2(a[1] - cz, a[0] - cx), t1 = Math.atan2(b[1] - cz, b[0] - cx);
  let d = t1 - t0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  const arc = arcPoints(cx, cz, R, t0, t0 + d, n);
  const out = [];
  for (let k = 0; k < poly.length; k++) {
    if (k === i) { for (let j = 0; j < arc.length - 1; j++) out.push(arc[j]); }
    else if (k === (i + 1) % poly.length) out.push(poly[k]);
    else out.push(poly[k]);
  }
  return { poly: out, cx, cz, R, t0, t1: t0 + d };
}

// ------------------------------------------------------------------------------------------------- signs
/** Wrapped lettering on a drum segment (emissive canvas). Added to `group` in world space, bloom layer. */
export function wrapSign(group, { cx, cz, r, y0, y1, th0, th1, text, sub = null, bg = '#f4f4f2', fg = '#c8102e', repeat = 1, emissive = 1.3, font = null, weight = '900', seg = 48, letterSpacing = 0 }) {
  const arc = Math.abs(th1 - th0) * r, h = y1 - y0;
  const c = L.textCanvas({ w: Math.min(2048, Math.round(arc / repeat * 48)), h: Math.min(512, Math.round(h * 48)), text, sub, bg, fg, font, weight, letterSpacing, shade: false });
  const mat = L.signMaterial(c, { emissive, roughness: 0.5 });
  mat.map.wrapS = THREE.RepeatWrapping; mat.emissiveMap.wrapS = THREE.RepeatWrapping;
  const g = cylSegment(cx, cz, r, y0, y1, th0, th1, seg, { uRep: repeat, flipU: true });
  const m = new THREE.Mesh(g, mat); m.name = 'lmSign:' + text; m.layers.enable(1);
  group.add(m);
  return m;
}
// ------------------------------------------------------------------------------------------------- sign atlas
// Every flat landmark sign / poster / vertical blade is painted into one shared 4096² canvas and emitted as quads into
// the city batch (bloom layer through mat.userData.layer), so ~150 signs cost a handful of draw calls instead of one
// mesh + one texture each. Two materials: lit (emissive follows the night factor) and dim (plaques, unlit boards).
// [mobile] ?canvasK (mobileProfile.js CANVAS_K): on a phone the atlas and every sign in it are painted at that scale
// (4096 -> 2048 at 0.5): the same signs per atlas, the same UVs, a quarter of the memory
class SignAtlas {
  constructor(size = Math.round(4096 * CANVAS_K)) {
    this.size = size; this.pad = 4;
    this.canvas = L.makeCanvas(size, size); this.ctx = this.canvas.getContext('2d');
    this.ctx.fillStyle = '#101010'; this.ctx.fillRect(0, 0, size, size);
    this.tex = L.canvasTex(this.canvas, { aniso: 8, live: true });
    this.shelves = [];   // [{y, h, x}]
    this.top = 0;
    this.full = false;
  }
  alloc(w, h) {
    const H = Math.ceil((h + this.pad) / 32) * 32, W = w + this.pad;
    let shelf = this.shelves.find(s => s.h === H && s.x + W <= this.size);
    if (!shelf) {
      if (this.top + H > this.size) { this.full = true; return null; }
      shelf = { y: this.top, h: H, x: 0 }; this.shelves.push(shelf); this.top += H;
    }
    const cell = { x: shelf.x, y: shelf.y, w, h };
    shelf.x += W;
    return cell;
  }
  /** Draw a textCanvas into the atlas, return the uv rect [u0,v0,u1,v1] (v up). */
  put(opts, w, h, ppm) {
    const K = CANVAS_K, W = Math.min(1024 * K, Math.max(48 * K, Math.round(w * ppm * K))) | 0, H = Math.min((opts.vertical ? 1024 : 320) * K, Math.max(24 * K, Math.round(h * ppm * K))) | 0;
    const cell = this.alloc(W, H);
    if (!cell) return null;
    const c = L.textCanvas({ ...opts, w: W, h: H });
    this.ctx.drawImage(c, cell.x, cell.y);
    if (CANVAS_K !== 1) c.width = c.height = 1;        // [mobile] a phone lets the scratch canvas go now, not at the next GC
    this.tex.needsUpdate = true;
    const s = this.size, i = 1.5;
    return [(cell.x + i) / s, 1 - (cell.y + H - i) / s, (cell.x + W - i) / s, 1 - (cell.y + i) / s];
  }
}
let atlases = [], activeBatch = null;
function atlasFor() {
  let a = atlases[atlases.length - 1];
  if (!a || a.full) {
    a = new SignAtlas();
    a.lit = new THREE.MeshStandardMaterial({ map: a.tex, emissiveMap: a.tex, emissive: 0xffffff, emissiveIntensity: 1.25, roughness: 0.5, metalness: 0.05 });
    a.lit.name = 'lm_signAtlas' + atlases.length; a.lit.userData.layer = 1; a.lit.userData.noShadow = true;
    a.dim = new THREE.MeshStandardMaterial({ map: a.tex, emissiveMap: a.tex, emissive: 0xffffff, emissiveIntensity: 0.3, roughness: 0.55, metalness: 0.1 });
    a.dim.name = 'lm_signAtlasDim' + atlases.length; a.dim.userData.noShadow = true;
    nightMats.push({ mat: a.lit, day: 0.12, night: 1.25 }, { mat: a.dim, day: 0.05, night: 0.3 });
    atlases.push(a);
  }
  return a;
}
/** city.js registers its GeoBatch here so flatSign / poster / blade emit atlas quads instead of meshes. */
export function useBatch(batch) { activeBatch = batch; }
export function signAtlasStats() { return atlases.map(a => ({ shelves: a.shelves.length, used: a.top / a.size })); }
/**
 * Flat sign quad in world space at (x,y,z) facing (nx,nz): painted into the sign atlas and merged into the batch.
 * opts as L.signMesh (text, sub, w, h, bg, fg, vertical, weight, letterSpacing, emissive, double, lift).
 */
export function signQuad(batch, x, y, z, nx, nz, opts) {
  const { w = 4, h = 1, emissive = 1.2, double = false, lift = 0.03, ppm = opts.vertical ? 44 : 40 } = opts;
  const a = atlasFor();
  const uv = a.put({ text: opts.text, sub: opts.sub || null, bg: opts.bg, bg2: opts.bg2 || null, fg: opts.fg, vertical: !!opts.vertical, border: opts.border || null, weight: opts.weight || '800', font: opts.font || null, letterSpacing: opts.letterSpacing || 0 }, w, h, ppm);
  if (!uv) return null;
  const mat = emissive < 0.5 ? a.dim : a.lit;
  batch.add(mat, L.wallQuad(x, y, z, nx, nz, w, h, lift, uv), x, z);
  if (double) batch.add(mat, L.wallQuad(x, y, z, -nx, -nz, w, h, lift, uv), x, z);   // second face is its own print, same uv
  return uv;
}
/** Vertical double-sided blade sign (袖看板) hanging off a wall: centre (x,y,z), reads along tangent (tx,tz). */
export function blade(batch, x, y, z, tx, tz, opts) {
  const l = Math.hypot(tx, tz) || 1;
  return signQuad(batch, x, y, z, tx / l, tz / l, { ...opts, vertical: true, double: true, lift: 0 });
}
/** Flat sign placed in world space facing (nx,nz). With a registered batch it becomes atlas quads (returns null). */
export function flatSign(group, x, y, z, nx, nz, opts) {
  if (activeBatch) { signQuad(activeBatch, x, y, z, nx, nz, { ...opts, lift: opts.lift ?? 0.03 }); return null; }
  const m = L.signMesh(opts);
  L.placeFacing(m, x, y, z, nx, nz);
  group.add(m);
  return m;
}
const ADS = [
  { text: 'SHIBUYA46', sub: 'NEW SINGLE「純愛」 NOW ON SALE', bg: '#ff2d8a', bg2: '#5a0f9c', fg: '#ffffff' },
  { text: 'Tojo Cola', sub: '爽快、東城。  ICE COLD', bg: '#c8102e', bg2: '#5a0810', fg: '#ffffff' },
  { text: 'サンシャインビール', sub: '今夜も、乾杯。', bg: '#f2b632', bg2: '#8a4a00', fg: '#ffffff' },
  { text: '龍', sub: 'PERFUME  KAMURO  ―  EAU DE PARFUM', bg: '#0e0e12', bg2: '#3a2a10', fg: '#e8c070' },
  { text: 'Bumblebee カラオケ', sub: '全室 24H ・ 学割 50% OFF', bg: '#ffd400', bg2: '#ff6a00', fg: '#111111' },
  { text: 'STARBEANS', sub: 'COFFEE ― 渋谷町店 OPEN', bg: '#0b3d2e', bg2: '#062219', fg: '#f5f1e6' },
];
/** Static fictional ad poster (fallback for LED frames until the signage module places its animated screen). */
export function poster(group, x, y, z, nx, nz, w, h, k = 0, emissive = 0.9) {
  const ad = ADS[((k % ADS.length) + ADS.length) % ADS.length];
  if (activeBatch) { signQuad(activeBatch, x, y, z, nx, nz, { text: ad.text, sub: ad.sub, w, h, bg: ad.bg, bg2: ad.bg2, fg: ad.fg, emissive, weight: '900' }); return null; }
  const m = L.signMesh({ text: ad.text, sub: ad.sub, w, h, bg: ad.bg, bg2: ad.bg2, fg: ad.fg, emissive, weight: '900' });
  L.placeFacing(m, x, y, z, nx, nz);
  group.add(m);
  return m;
}
/** Emissive bar (strip light / lit rim). */
export function glowBar(batch, mat, x, y, z, w, h, d, rotY = 0) { batch.add(mat, L.boxAt(x, y, z, w, h, d, rotY, false), x, z); }

/**
 * Ground-floor shop row along edge a→b (outward normal nx,nz) using the infill atlases (lit interiors, tenant
 * fascia, piers) so landmark ground floors match the rest of the street. At = getAtlases() from genericBuilding.
 */
export function shopRow(batch, At, a, b, nx, nz, tenants, { gf = 4.2, rng, pools, typeOf, shopOf, fi = 0, minW = 6, maxW = 9, fascia = true, lift = 0.04, depth = null, real = true, roomDepth = 6, hall = null } = {}) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 3) return;
  const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
  const list = tenants && tenants.length ? tenants : [null];
  let nShops = Math.max(1, Math.round(len / (rng ? rng.range(minW, maxW) : (minW + maxW) / 2)));
  // the real shops on this landmark frontage (tenantsData.js): one bay each, their names and trades (pass 12)
  const realK = real ? realCountAlong(a, b, nx, nz, -6) : 0;   // (a landmark's frontage may stand in front of the survey point)
  if (realK > nShops) nShops = Math.min(realK, Math.max(1, Math.floor(len / 3.5)));
  const sw = len / nShops, glassH = gf - 1.05;
  const trimMat = At.trim;
  for (let i = 0; i < nShops; i++) {
    let name = list[i % list.length];
    const s = sw * (i + 0.5);
    const cx = a[0] + tx * s, cz = a[1] + tz * s;
    const rt = realK ? claimRealTenant(cx, cz, nx, nz, sw / 2, false, -6) : null;
    if (rt) name = rt.name;
    const type = rt ? (TENANT_TYPE[rt.cat] || 'generic') : name && typeOf ? typeOf(name, pools) : (rng ? rng.pick(['cafe', 'fashion', 'books', 'conv']) : 'generic');
    batch.add(At.shop.mat, shopQuad(cx, 0.15 + glassH / 2, cz, nx, nz, sw - 0.6, glassH, lift, shopUV(rt ? type : ((shopOf && shopOf[type]) || 'generic'), 0, Math.floor(L.hash(Math.round(a[0] * 7), Math.round(a[1] * 7), fi) * 4) + i)), cx, cz);
    const fcase = depth ? shopFrontDepth(batch, depth, { cx: cx + nx * lift, cz: cz + nz * lift, nx, nz, sw, gh: glassH, y0: 0.15, type: rt ? type : ((shopOf && shopOf[type]) || 'generic'), seed: fi + i }) : null;
    if (roomDepth > 0) registerShopBay({ x: cx, z: cz, y0: (batch.lift || 0) + 0.15, nx, nz, w: sw - 0.6, gh: glassH, type: rt ? type : ((shopOf && shopOf[type]) || 'generic'), name, real: rt, depth: roomDepth, hall, out: lift, sw,
      front: depth && glassH >= 1.9 && sw >= 3.2 ? lift + 0.47 : lift + 0.05, case: fcase || null, caseOff: lift });
    batch.add(trimMat, L.boxAt(cx + nx * 0.08, gf - 0.55, cz + nz * 0.08, sw, 0.95, 0.18, Math.atan2(-tz, tx), false), cx, cz);
    if (name && fascia) { const uv = At.fascia.get(name, fi + i); batch.add(At.fascia.mat, L.wallQuad(cx, gf - 0.55, cz, nx, nz, Math.min(sw - 0.2, 9), 0.82, 0.2, [uv.u0, uv.v0, uv.u1, uv.v1]), cx, cz); }
    if (i > 0) batch.add(trimMat, L.boxAt(a[0] + tx * (sw * i) + nx * 0.1, gf / 2, a[1] + tz * (sw * i) + nz * 0.1, 0.4, gf, 0.25, Math.atan2(-tz, tx), false), cx, cz);
  }
}

// ------------------------------------------------------------------------------------------------- records
/** Facade records for the signage module: one per polygon edge (bottom-centre, outward normal). */
export function facadeRecords(id, polyIn, height, storeys, { tenants = [], kind = 'landmark', gf = 4, isStreetSide = null, minLen = 6 } = {}) {
  const poly = L.ensureCW(polyIn), out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < minLen) continue;
    const [nx, nz] = L.edgeNormal(poly, i);
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const street = isStreetSide ? isStreetSide(mx + nx * 3.5, mz + nz * 3.5) : true;
    out.push({ id: `${id}:f${i}`, buildingId: id, position: new THREE.Vector3(mx, 0.15, mz), normal: new THREE.Vector3(nx, 0, nz), width: len, height, storeys, tenants: street ? tenants : [], kind, groundFloorHeight: gf });
  }
  return out;
}
/** One OBB fitted to the polygon's first edge direction. */
export function obbOf(polyIn, h, pad = 0.1) {
  const poly = L.ensureCW(polyIn);
  const a = poly[0], b = poly[1];
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  const ux = dx / l, uz = dz / l;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [x, z] of poly) { const u = x * ux + z * uz, v = -x * uz + z * ux; if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v; }
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  return { obb: { center: new THREE.Vector3(cu * ux - cv * uz, h / 2, cu * uz + cv * ux), halfSize: new THREE.Vector3((maxU - minU) / 2 + pad, h / 2, (maxV - minV) / 2 + pad), rotationY: Math.atan2(-uz, ux) } };
}
export function boxCollider(cx, cz, w, h, d, rotY = 0, y0 = 0) {
  return { obb: { center: new THREE.Vector3(cx, y0 + h / 2, cz), halfSize: new THREE.Vector3(w / 2, h / 2, d / 2), rotationY: rotY } };
}
/** Local (lx,lz) → world for a rect landmark at (px,pz) rotated rotY (three.js convention). */
export function localToWorld(px, pz, rotY) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return (lx, lz) => [px + lx * c + lz * s, pz - lx * s + lz * c];
}
/** Group rotation.y so that local +z points along world (fx, fz). */
export function rotationFacing(fx, fz) { return Math.atan2(fx, fz); }
/** Direction vector (x,z) of a cityData rotY ("facing") value. */
export function dirOf(rotY) { return [Math.cos(rotY), -Math.sin(rotY)]; }

export default { mats, setNight, prism, roofMat, roofPlant, rimLights, rings, parapet, fins, ibox, placed, lantern, cylSegment, disc, arcPoints, bulgeEdge, wrapSign, flatSign, signQuad, blade, useBatch, signAtlasStats, glowBar, facadeRecords, obbOf, boxCollider, localToWorld, rotationFacing, dirOf, UNIT_BOX, HEDGE_GEO };
