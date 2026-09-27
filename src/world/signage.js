// [signage] sign / billboard / neon / LED-screen factories. Every static sign is painted into a shared canvas atlas
// (4096² for fascia/袖看板, 2048² for neon/halo/plates/cloth) and merged into ONE mesh per atlas page, so thousands of
// signs cost a handful of draw calls. Names follow docs/NAMES.md. Placement is driven by cityData (landmark polygons,
// screen specs, roads, crossing corners) and by city.facades / city.billboards for every infill façade.
//   makeSign({text, sub, w, h, bg, fg, font, weight, glow, style, mark, stripe, vertical, channel, tag}) -> Mesh
//   makeNeon({text, w, h, color, font, border})        -> Group (dark plate + tube text + additive halo)
//   makeLed({w, h, ads, fps, seed}) / makeLedScreen()  -> Mesh with an animated canvas (10 fps), makeLedTicker()
//   makeStreetSign({name, romaji}) / makeGuideSign({rows}) / makeStationSign({kind}) / makeMetroTotem() / makeMenuBoard() / makeFlag()
//   makeVerticalStack({tenants, plateW, plateH, firstFloor}) -> Group of alternating-colour 袖看板 plates + bracket
//   makeVendingFace({brand, w, h}) -> Mesh      taxiLampKit() -> [{company, geometry, material}]  makeTaxiLamp()
//   signage.place(mesh, pos, facing, parent)   signage.batch(obj) (merge into the atlas meshes)   signage.flush()
//   Per-vertex `aGlow` scales emissive so one material serves every sign; emissive follows lighting.nightFactor.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { CANVAS_K } from '../core/mobileProfile.js';

const F = {
  gothic: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif',
  mincho: '"Hiragino Mincho ProN", "Hiragino Mincho Pro", "Yu Mincho", "Noto Serif JP", serif',
  maru: '"Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans JP", sans-serif',
  helv: '"Helvetica Neue", Helvetica, Arial, "Hiragino Sans", sans-serif',
  impact: 'Impact, "Arial Black", "Helvetica Neue", "Hiragino Sans", sans-serif',
  script: '"Snell Roundhand", "Apple Chancery", "Brush Script MT", cursive',
  narrow: '"Arial Narrow", "Helvetica Neue", "Hiragino Sans", sans-serif',
  serif: 'Georgia, "Times New Roman", "Hiragino Mincho ProN", serif',
};
const JP = /[぀-ヿ一-鿿]/;
const PAD = 6;

// ------------------------------------------------------------------------------------------------ atlas pages
// 2048² pages only (pageFor opens as many as needed); ppm is the paint density, maxPx caps the long side.
const STYLES = {
  fascia: { size: 2048, ppm: 40, maxPx: 640, kind: 'lit', rough: 0.5 },
  sode:   { size: 2048, ppm: 96, maxPx: 512, kind: 'lit', rough: 0.5 },
  neon:   { size: 2048, ppm: 160, maxPx: 1024, kind: 'lit', rough: 0.7 },
  halo:   { size: 2048, ppm: 24, maxPx: 512, kind: 'add' },
  plate:  { size: 2048, ppm: 140, maxPx: 1024, kind: 'lit', rough: 0.35 },
  cloth:  { size: 2048, ppm: 80, maxPx: 512, kind: 'cloth', rough: 0.9 },
};
const uTime = { value: 0 };

function makeMaterial(style, tex) {
  if (style.kind === 'add') {
    return new THREE.MeshBasicMaterial({ map: tex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false });
  }
  const m = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1, roughness: style.rough, metalness: 0.04, side: style.kind === 'cloth' ? THREE.DoubleSide : THREE.FrontSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aWave;\nvarying float vGlow;\nuniform float uTime;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\ntransformed += objectNormal * (sin(uTime * 2.6 + transformed.y * 2.2 + transformed.x * 0.7 + transformed.z * 0.7) * 0.06 * aWave);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow;');
  };
  m.customProgramCacheKey = () => 'signage-' + style.kind;
  return m;
}

class Page {
  constructor(name, style, index) {
    this.name = name; this.style = style; this.index = index; this.size = Math.round(style.size * CANVAS_K);   // [mobile] ?canvasK
    const c = document.createElement('canvas'); c.width = c.height = this.size;
    this.canvas = c; this.ctx = c.getContext('2d');
    this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.size, this.size);
    this.shelves = []; this.top = 0; this.used = 0; this.sealed = false;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture = tex;
    this.material = makeMaterial(style, tex);
    this.material.name = 'signage:' + name + index;
    this.geos = []; this.mesh = null; this.dirty = false;
  }
  // shelves are bucketed by exact height (rounded up to 8 px) so a 40 px plate never sits on a 56 px shelf
  alloc(w, h) {
    w = Math.ceil(w); h = Math.ceil(h / 8) * 8;
    if (this.sealed || w > this.size || h > this.size) return null;
    for (const s of this.shelves) if (h === s.h && s.x + w <= this.size) { const r = { x: s.x, y: s.y, w, h }; s.x += w; this.used += w * h; return r; }
    if (this.top + h > this.size) return null;
    const s = { x: w, y: this.top, h }; this.shelves.push(s); this.top += h; this.used += w * h;
    return { x: 0, y: s.y, w, h };
  }
  // hand the pixels to an ImageBitmap and drop the canvas backing store (r186 ignores flipY for bitmaps, so flip here)
  // [mobile] maxPx (?texmax): sealed at once into a canvas of that size (UVs are normalised; the GPU copy is capped there
  // anyway) and the page's own canvas let go — synchronously, because the city's signs are painted in one long init and a
  // bitmap promise would only settle after it, with every page still held
  seal(maxPx = 0) {
    if (this.sealed) return; this.sealed = true;
    const canvas = this.canvas, tex = this.texture;
    if (maxPx > 0 && canvas) {
      const n = Math.min(maxPx, this.size), c = document.createElement('canvas'); c.width = c.height = n;
      const g = c.getContext('2d');
      if (g) { g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, n, n); tex.image = c; tex.needsUpdate = true; canvas.width = canvas.height = 1; this.canvas = null; this.ctx = null; }
      return;
    }
    if (typeof createImageBitmap !== 'function' || !canvas) return;
    const opt = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
    createImageBitmap(canvas, opt).then((bmp) => {
      tex.image = bmp; tex.flipY = false; tex.needsUpdate = true;
      canvas.width = canvas.height = 0; this.canvas = null; this.ctx = null;
    }).catch(() => { this.sealed = false; });
  }
}

const pages = {}; // style -> [Page]
const cache = new Map();
function pageFor(styleName, w, h) {
  const style = STYLES[styleName];
  const list = pages[styleName] || (pages[styleName] = []);
  for (const p of list) { if (p.sealed) continue; const r = p.alloc(w, h); if (r) return { page: p, rect: r }; }
  // [mobile] ?texmax: the pages this style filled so far are sealed as soon as it needs another one, so a phone never holds
  // more than one open canvas per style while the city is being signed (28 open 2048² pages were 460 MB at the boot's peak)
  if (SEAL_PX >= 64) for (const q of list) q.seal(SEAL_PX);
  const p = new Page(styleName, style, list.length); list.push(p);
  const r = p.alloc(w, h);
  if (!r) { console.warn(`[signage] ${styleName} sign ${w}x${h}px too big for the atlas`); return null; }
  return { page: p, rect: r };
}
function sealPages(maxPx = 0) { for (const list of Object.values(pages)) for (const p of list) p.seal(maxPx); }
// [mobile] ?texmax=<px> (the mobile profile): once the game is up, every atlas page painted so far becomes a bitmap of that
// size and its 2048² canvas is dropped (28 pages = 450 MB of canvas memory, which iOS Safari caps per tab). A sealed page
// takes no new signs: anything painted later opens a fresh page.
const SEAL_PX = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('texmax')) || 0 : 0;

// paint a sign into an atlas: returns {page, rect(inner), u0,u1,v0,v1}. `painter(ctx, x, y, w, h)` draws the inner rect;
// the padded margin is filled with `bleed` first so mipmaps do not pull neighbours in.
function paint(styleName, wM, hM, key, bleed, painter, ppmOverride) {
  const k = styleName + '|' + key;
  if (cache.has(k)) return cache.get(k);
  const style = STYLES[styleName];
  let ppm = ppmOverride || style.ppm;
  const maxPx = style.maxPx || 1024;
  if (Math.max(wM, hM) * ppm > maxPx) ppm = maxPx / Math.max(wM, hM);
  if (Math.min(wM, hM) * ppm < 40) ppm = 40 / Math.min(wM, hM);
  ppm *= CANVAS_K;                                   // [mobile] the page and everything on it at the phone's scale
  const w = Math.round(wM * ppm), h = Math.round(hM * ppm);
  const got = pageFor(styleName, w + PAD * 2, h + PAD * 2);
  if (!got) return null;
  const { page, rect } = got;
  const ctx = page.ctx;
  ctx.save();
  ctx.fillStyle = bleed || '#000'; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.beginPath(); ctx.rect(rect.x + PAD, rect.y + PAD, w, h); ctx.clip();
  ctx.translate(rect.x + PAD, rect.y + PAD);
  try { painter(ctx, 0, 0, w, h); } catch (e) { console.warn('[signage] painter failed', e); }
  ctx.restore();
  page.texture.needsUpdate = true;
  const S = page.size;
  const out = { page, rect: { x: rect.x + PAD, y: rect.y + PAD, w, h }, u0: (rect.x + PAD) / S, u1: (rect.x + PAD + w) / S, v1: 1 - (rect.y + PAD) / S, v0: 1 - (rect.y + PAD + h) / S };
  cache.set(k, out);
  return out;
}

function remapUV(g, a, flipU = false) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) { const u = flipU ? 1 - uv.getX(i) : uv.getX(i); uv.setXY(i, a.u0 + u * (a.u1 - a.u0), a.v0 + uv.getY(i) * (a.v1 - a.v0)); }
  uv.needsUpdate = true;
}
function setAttr(g, name, v) {
  const n = g.attributes.position.count;
  g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(n).fill(v), 1));
}
function signMesh(a, geo, glow, extra = {}, flipU = false) {
  remapUV(geo, a, flipU); setAttr(geo, 'aGlow', glow); if (!geo.attributes.aWave) setAttr(geo, 'aWave', 0);
  const mesh = new THREE.Mesh(geo, a.page.material);
  mesh.userData.sign = { page: a.page, glow, ...extra };
  mesh.layers.enable(1); mesh.castShadow = false; mesh.receiveShadow = false;
  return mesh;
}

// ------------------------------------------------------------------------------------------------ text helpers
function fit(ctx, text, maxW, maxH, weight = '700', family = F.gothic) {
  let size = Math.max(6, maxH);
  for (let i = 0; i < 10; i++) {
    ctx.font = `${weight} ${size}px ${family}`;
    const w = ctx.measureText(text).width;
    if (w <= maxW) break;
    size = Math.max(6, Math.floor(size * Math.min(0.93, maxW / w)));
  }
  return size;
}
function famFor(text, pref) { return pref || (JP.test(text) ? F.gothic : F.helv); }
function shade(hex, k) { // k<0 darken, k>0 lighten
  const c = new THREE.Color(hex); const t = k < 0 ? 0 : 1; const a = Math.abs(k);
  c.r += (t - c.r) * a; c.g += (t - c.g) * a; c.b += (t - c.b) * a; return '#' + c.getHexString();
}
function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function vtext(ctx, text, cx, top, h, size, family, weight, fill) {
  const chars = [...text]; const step = Math.min(size * 1.12, h / chars.length);
  ctx.font = `${weight} ${size}px ${family}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = fill;
  chars.forEach((ch, i) => {
    const y = top + step * (i + 0.5);
    if (/[ー―－]/.test(ch)) { ctx.save(); ctx.translate(cx, y); ctx.rotate(Math.PI / 2); ctx.fillText(ch, 0, 0); ctx.restore(); }
    else ctx.fillText(ch, cx, y);
  });
}
// linear luminance of a hex colour; bright acrylic boxes get less emissive than dark panels so nothing blows out
const lumCache = new Map();
function lumOf(hex) {
  if (!hex) return 0.2;
  if (lumCache.has(hex)) return lumCache.get(hex);
  let l = 0.2; try { const c = new THREE.Color(hex); l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; } catch (e) { /* keep default */ }
  lumCache.set(hex, l); return l;
}
// bright acrylic boxes get less emissive than dark panels, floored at 60 % so white plates still read as lit
function glowFor(bg, base) { const l = Math.min(1, lumOf(bg)); return base * Math.max(0.6, 1 - 0.62 * l * l - 0.1 * l); }
// lighten a hex colour until its linear luminance reaches `min` (LED ad backgrounds must not read as matte)
function liftLum(hex, min) {
  let l = lumOf(hex); if (l >= min) return hex;
  const c = new THREE.Color(hex);
  for (let i = 0; i < 12 && l < min; i++) { c.r += (1 - c.r) * 0.16; c.g += (1 - c.g) * 0.16; c.b += (1 - c.b) * 0.16; l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
  return '#' + c.getHexString();
}
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const q2 = (v) => Math.max(0.5, Math.round(v * 2) / 2), q5 = (v) => Math.max(0.2, Math.round(v * 5) / 5);

// ------------------------------------------------------------------------------------------------ painters
// back-lit acrylic fascia / panel sign (o.channel: dark panel with lit channel letters)
function paintFascia(ctx, x, y, w, h, o) {
  const channel = !!o.channel;
  const bg = channel ? '#17181c' : (o.bg || '#d7262b'), fg = o.fg || '#ffffff';
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, channel ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.16)'); g.addColorStop(0.45, 'rgba(255,255,255,0.02)'); g.addColorStop(1, 'rgba(0,0,0,0.20)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  if (!channel) { // fluorescent tube hot-spots behind the acrylic
    const tubes = Math.max(1, Math.round(w / h / 1.6));
    for (let i = 0; i < tubes; i++) {
      const cx = (i + 0.5) * w / tubes;
      const r = ctx.createRadialGradient(cx, h * 0.45, 0, cx, h * 0.45, Math.max(w / tubes, h) * 0.75);
      r.addColorStop(0, 'rgba(255,255,255,0.13)'); r.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = r; ctx.fillRect(0, 0, w, h);
    }
  } else { // brushed panel lines
    ctx.fillStyle = 'rgba(255,255,255,0.03)'; for (let yy = 0; yy < h; yy += 3) ctx.fillRect(0, yy, w, 1);
  }
  if (o.stripe) { ctx.fillStyle = o.stripe; ctx.fillRect(0, 0, w, Math.max(3, h * 0.11)); }
  if (o.stripeBottom) { ctx.fillStyle = o.stripeBottom; ctx.fillRect(0, h - Math.max(3, h * 0.11), w, Math.max(3, h * 0.11)); }
  const fw = Math.max(2, Math.min(w, h) * 0.035);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = fw; ctx.strokeRect(fw / 2, fw / 2, w - fw, h - fw);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.strokeRect(fw + 0.5, fw + 0.5, w - 2 * fw - 1, h - 2 * fw - 1);
  const family = famFor(o.text, o.font), weight = o.weight || '800';
  let left = w * 0.06, right = w * 0.94;
  if (o.mark) { // logo glyph: coloured disc/square with the first character
    const s = h * 0.62, mx = w * 0.05 + s / 2, my = h / 2;
    ctx.fillStyle = o.markBg || fg; if (o.mark === 'square') ctx.fillRect(mx - s / 2, my - s / 2, s, s); else { ctx.beginPath(); ctx.arc(mx, my, s / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = o.markFg || (channel ? '#17181c' : bg); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ch = o.markText || [...o.text][0]; ctx.font = `900 ${s * 0.66}px ${famFor(ch, o.markFont)}`; ctx.fillText(ch, mx, my + s * 0.03);
    left = w * 0.05 + s + w * 0.03;
  }
  ctx.textBaseline = 'middle'; ctx.fillStyle = fg;
  if (channel) { ctx.shadowColor = fg; ctx.shadowBlur = h * 0.14; ctx.shadowOffsetY = 0; }
  else { ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = h * 0.04; ctx.shadowOffsetY = h * 0.015; }
  const align = o.align || 'center'; const tx = align === 'left' ? left : align === 'right' ? right : (left + right) / 2;
  ctx.textAlign = align;
  if (o.vertical) { if (!channel) ctx.shadowBlur = 0; vtext(ctx, o.text, w / 2, h * 0.05, h * 0.9, Math.min(w * 0.78, h * 0.9 / [...o.text].length), family, weight, fg); }
  else if (o.twoLine) { // equal-size two-line name (long tenant names on 袖看板 plates)
    const s1 = fit(ctx, o.text, right - left, h * 0.36, weight, family), s2 = fit(ctx, o.twoLine, right - left, h * 0.36, weight, family), s = Math.min(s1, s2);
    ctx.font = `${weight} ${s}px ${family}`; ctx.fillText(o.text, tx, h * 0.3); ctx.fillText(o.twoLine, tx, h * 0.7);
  }
  else if (o.sub) {
    const size = fit(ctx, o.text, right - left, h * (o.stripe ? 0.46 : 0.52), weight, family);
    ctx.font = `${weight} ${size}px ${family}`; ctx.fillText(o.text, tx, h * (o.stripe ? 0.44 : 0.38));
    if (channel) ctx.fillText(o.text, tx, h * (o.stripe ? 0.44 : 0.38));
    const sf = famFor(o.sub, o.subFont); const s2 = fit(ctx, o.sub, right - left, h * 0.22, o.subWeight || '600', sf);
    ctx.font = `${o.subWeight || '600'} ${s2}px ${sf}`; ctx.fillStyle = o.subFg || fg; ctx.fillText(o.sub, tx, h * (o.stripe ? 0.8 : 0.76));
  } else {
    const size = fit(ctx, o.text, right - left, h * (o.stripe ? 0.56 : 0.66), weight, family);
    ctx.font = `${weight} ${size}px ${family}`; ctx.fillText(o.text, tx, h * (o.stripe ? 0.57 : 0.52));
    if (channel) ctx.fillText(o.text, tx, h * (o.stripe ? 0.57 : 0.52));
  }
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  if (o.tag) { // small corner tag (2F / 24H / TEL)
    ctx.fillStyle = o.tagBg || 'rgba(0,0,0,0.6)'; const tw = h * 0.42, th = h * 0.22; ctx.fillRect(w - tw - fw * 2, fw * 2, tw, th);
    ctx.fillStyle = o.tagFg || '#fff'; ctx.textAlign = 'center'; ctx.font = `700 ${th * 0.7}px ${F.helv}`; ctx.fillText(o.tag, w - tw / 2 - fw * 2, fw * 2 + th * 0.55);
  }
}

// neon tube text on a dark plate
function paintNeon(ctx, x, y, w, h, o) {
  const color = o.color || '#ff2d7a';
  ctx.fillStyle = o.bg || '#0b0a0e'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.05)'; for (let i = 0; i < 40; i++) ctx.fillRect((i * 97) % w, (i * 57) % h, 2, 2);
  const family = famFor(o.text, o.font), weight = o.weight || '700';
  const inner = o.border ? 0.62 : 0.74;
  const lines = o.sub ? [o.text, o.sub] : [o.text];
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const tube = (txt, cx, cy, size, fam, wt) => {
    ctx.font = `${wt} ${size}px ${fam}`;
    ctx.shadowColor = color; ctx.shadowBlur = size * 0.45; ctx.strokeStyle = color; ctx.lineWidth = size * 0.11; ctx.strokeText(txt, cx, cy); ctx.strokeText(txt, cx, cy);
    ctx.shadowBlur = size * 0.14; ctx.lineWidth = size * 0.075; ctx.strokeText(txt, cx, cy);
    ctx.shadowBlur = 0; ctx.strokeStyle = shade(color, 0.75); ctx.lineWidth = size * 0.03; ctx.strokeText(txt, cx, cy);
  };
  if (o.vertical) {
    const chars = [...o.text]; const size = Math.min(w * 0.6, h * inner / chars.length * 0.9); const step = h * inner / chars.length; const top = h * (1 - inner) / 2;
    chars.forEach((c, i) => tube(c, w / 2, top + step * (i + 0.5), size, family, weight));
  } else if (lines.length === 2) {
    const s1 = fit(ctx, lines[0], w * 0.8, h * inner * 0.55, weight, family); tube(lines[0], w / 2, h * 0.38, s1, family, weight);
    const f2 = famFor(lines[1], o.subFont); const s2 = fit(ctx, lines[1], w * 0.8, h * inner * 0.3, '600', f2); tube(lines[1], w / 2, h * 0.75, s2, f2, '600');
  } else {
    const s1 = fit(ctx, o.text, w * 0.82, h * inner, weight, family); tube(o.text, w / 2, h * 0.52, s1, family, weight);
  }
  if (o.border) {
    const bc = o.borderColor || shade(color, 0.2), m = Math.min(w, h) * 0.08;
    ctx.shadowColor = bc; ctx.shadowBlur = m * 1.4; ctx.strokeStyle = bc; ctx.lineWidth = m * 0.32; rrect(ctx, m, m, w - 2 * m, h - 2 * m, m); ctx.stroke(); ctx.stroke();
    ctx.shadowBlur = 0; ctx.strokeStyle = shade(bc, 0.7); ctx.lineWidth = m * 0.1; ctx.stroke();
  }
  ctx.shadowBlur = 0;
}
// additive halo (blurred copy) for the neon
function paintHalo(ctx, x, y, w, h, o) {
  const color = o.color || '#ff2d7a';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  const family = famFor(o.text, o.font), weight = o.weight || '700';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.globalAlpha = 0.5;
  const blob = (txt, cx, cy, size, fam) => { ctx.font = `${weight} ${size}px ${fam}`; ctx.shadowColor = color; ctx.shadowBlur = size * 0.9; ctx.fillText(txt, cx, cy); ctx.shadowBlur = size * 0.45; ctx.fillText(txt, cx, cy); };
  if (o.vertical) { const chars = [...o.text]; const size = Math.min(w * 0.6, h * 0.74 / chars.length * 0.9); const step = h * 0.74 / chars.length; chars.forEach((c, i) => blob(c, w / 2, h * 0.13 + step * (i + 0.5), size, family)); }
  else if (o.sub) { blob(o.text, w / 2, h * 0.38, fit(ctx, o.text, w * 0.8, h * 0.34, weight, family), family); blob(o.sub, w / 2, h * 0.75, fit(ctx, o.sub, w * 0.8, h * 0.19, '600', famFor(o.sub)), famFor(o.sub)); }
  else blob(o.text, w / 2, h * 0.52, fit(ctx, o.text, w * 0.82, h * 0.7, weight, family), family);
  if (o.border) { const m = Math.min(w, h) * 0.08; ctx.strokeStyle = o.borderColor || color; ctx.lineWidth = m * 0.5; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = m * 1.5; rrect(ctx, m, m, w - 2 * m, h - 2 * m, m); ctx.stroke(); }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}
// blue Tokyo street-name plate
function paintStreet(ctx, x, y, w, h, o) {
  ctx.fillStyle = '#0d2a6a'; ctx.fillRect(0, 0, w, h);
  const m = h * 0.06; ctx.fillStyle = '#ffffff'; rrect(ctx, m, m, w - 2 * m, h - 2 * m, h * 0.08); ctx.fill();
  ctx.fillStyle = '#1b4fa8'; rrect(ctx, m * 2.2, m * 2.2, w - 4.4 * m, h - 4.4 * m, h * 0.06); ctx.fill();
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(0,0,0,0.12)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const size = fit(ctx, o.name, w * 0.72, h * 0.5, '600', F.gothic); ctx.font = `600 ${size}px ${F.gothic}`; ctx.fillText(o.name, w * 0.46, h * 0.4);
  const s2 = fit(ctx, o.romaji, w * 0.7, h * 0.2, '500', F.helv); ctx.font = `500 ${s2}px ${F.helv}`; ctx.fillText(o.romaji, w * 0.46, h * 0.74);
  // ward tag
  ctx.fillStyle = '#fff'; const tw = w * 0.14, th = h * 0.5; ctx.fillRect(w - tw - m * 3, h / 2 - th / 2, tw, th);
  ctx.fillStyle = '#1b4fa8'; ctx.font = `600 ${tw * 0.42}px ${F.gothic}`; [...(o.ward || '渋谷区')].forEach((c, i) => ctx.fillText(c, w - tw / 2 - m * 3, h / 2 - th / 2 + th * (i + 0.5) / 3));
}
function paintGuide(ctx, x, y, w, h, o) {
  ctx.fillStyle = o.bg || '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = o.fg || '#10306a'; ctx.lineWidth = Math.max(2, h * 0.02); ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - 2 * ctx.lineWidth, h - 2 * ctx.lineWidth);
  const rows = o.rows; const rh = h / rows.length; ctx.textBaseline = 'middle';
  const ARROW = { left: '←', right: '→', up: '↑', down: '↓' };
  rows.forEach((r, i) => {
    const cy = rh * (i + 0.5);
    if (i > 0) { ctx.fillStyle = 'rgba(16,48,106,0.25)'; ctx.fillRect(w * 0.04, rh * i, w * 0.92, 1.5); }
    ctx.fillStyle = r.color || o.fg || '#10306a';
    const arrow = ARROW[r.dir] || '';
    const size = fit(ctx, r.jp, w * 0.62, rh * 0.5, '600', F.gothic); ctx.textAlign = 'left';
    ctx.font = `700 ${rh * 0.62}px ${F.helv}`; if (arrow && r.dir === 'left') ctx.fillText(arrow, w * 0.05, cy);
    ctx.font = `600 ${size}px ${F.gothic}`; ctx.fillText(r.jp, w * 0.17, cy - rh * 0.12);
    ctx.font = `500 ${size * 0.55}px ${F.helv}`; ctx.fillText(r.en, w * 0.17, cy + rh * 0.26);
    if (arrow && r.dir !== 'left') { ctx.textAlign = 'right'; ctx.font = `700 ${rh * 0.62}px ${F.helv}`; ctx.fillText(arrow, w * 0.95, cy); }
  });
}
function paintStationJP(ctx, x, y, w, h, o) {
  ctx.fillStyle = '#f4f4f0'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1d8f3e'; ctx.fillRect(0, 0, w, h * 0.16); ctx.fillRect(0, h * 0.9, w, h * 0.1);
  const bx = w * 0.03, bs = h * 0.5; ctx.fillStyle = '#1d8f3e'; ctx.fillRect(bx, h * 0.25, bs * 1.25, bs);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `900 ${bs * 0.62}px ${F.helv}`; ctx.fillText('JP', bx + bs * 0.625, h * 0.5);
  ctx.fillStyle = '#111'; ctx.textAlign = 'left';
  const size = fit(ctx, o.text, w * 0.5, h * 0.42, '600', F.gothic); ctx.font = `600 ${size}px ${F.gothic}`; ctx.fillText(o.text, w * 0.22, h * 0.45);
  ctx.font = `500 ${h * 0.14}px ${F.helv}`; ctx.fillText(o.romaji, w * 0.225, h * 0.76);
  if (o.right) { ctx.textAlign = 'right'; ctx.fillStyle = '#111'; ctx.font = `600 ${h * 0.24}px ${F.gothic}`; ctx.fillText(o.right, w * 0.97, h * 0.43); ctx.font = `500 ${h * 0.13}px ${F.helv}`; ctx.fillText(o.rightEn, w * 0.97, h * 0.72); }
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = `600 ${h * 0.1}px ${F.gothic}`; ctx.fillText('JP 山手線 ・ 埼京線 ・ 湘南新宿ライン', w * 0.03, h * 0.08);
}
const METRO_LINES = [['G', '01', '#f39700', '銀座線'], ['Z', '01', '#8f76d6', '半蔵門線'], ['F', '16', '#9c5e31', '副都心線']];
function lineCircle(ctx, cx, cy, r, L, n, col) {
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `800 ${r * 0.62}px ${F.helv}`; ctx.fillText(L, cx, cy - r * 0.28); ctx.font = `700 ${r * 0.55}px ${F.helv}`; ctx.fillText(n, cx, cy + r * 0.36);
}
function paintMetro(ctx, x, y, w, h, o) {
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#0b6bb5'; ctx.fillRect(0, 0, w, h * 0.06);
  const ms = h * 0.5, mx = w * 0.04 + ms / 2, my = h * 0.5; ctx.fillStyle = '#0b6bb5'; ctx.beginPath(); ctx.arc(mx, my, ms / 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `900 ${ms * 0.72}px ${F.helv}`; ctx.fillText('M', mx, my + ms * 0.04);
  ctx.fillStyle = '#0b6bb5'; ctx.textAlign = 'left'; ctx.font = `700 ${h * 0.2}px ${F.gothic}`; ctx.fillText('東京メトロ', w * 0.04 + ms + w * 0.02, h * 0.3);
  ctx.fillStyle = '#222'; ctx.font = `600 ${h * 0.17}px ${F.gothic}`; ctx.fillText('渋谷町駅', w * 0.04 + ms + w * 0.02, h * 0.63); ctx.font = `500 ${h * 0.1}px ${F.helv}`; ctx.fillText('Shibuya-cho', w * 0.04 + ms + w * 0.02, h * 0.83);
  const r = h * 0.19; let cx = w * 0.58;
  for (const [L, n, col, name] of (o.lines || METRO_LINES)) {
    lineCircle(ctx, cx, h * 0.42, r, L, n, col);
    ctx.fillStyle = '#222'; ctx.textAlign = 'center'; ctx.font = `600 ${h * 0.1}px ${F.gothic}`; ctx.fillText(name, cx, h * 0.78);
    cx += r * 2.5;
  }
}
// vertical metro entrance totem: blue band, M mark, station, exit number, line circles stacked
function paintMetroTotem(ctx, x, y, w, h, o) {
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#0b6bb5'; ctx.fillRect(0, 0, w, h * 0.2);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `900 ${w * 0.55}px ${F.helv}`; ctx.fillText('M', w / 2, h * 0.1);
  ctx.fillStyle = '#0b6bb5'; ctx.font = `700 ${w * 0.17}px ${F.gothic}`; ctx.fillText('東京メトロ', w / 2, h * 0.26);
  ctx.fillStyle = '#111'; ctx.font = `700 ${w * 0.2}px ${F.gothic}`; ctx.fillText('渋谷町駅', w / 2, h * 0.34); ctx.font = `500 ${w * 0.11}px ${F.helv}`; ctx.fillText('Shibuya-cho Sta.', w / 2, h * 0.4);
  const r = w * 0.19; METRO_LINES.forEach(([L, n, col], i) => lineCircle(ctx, w * 0.3 + (i % 2) * w * 0.4, h * 0.52 + Math.floor(i / 2) * r * 2.4, r, L, n, col));
  ctx.fillStyle = '#ffd400'; ctx.fillRect(w * 0.1, h * 0.8, w * 0.8, h * 0.14);
  ctx.fillStyle = '#111'; ctx.font = `800 ${w * 0.22}px ${F.helv}`; ctx.fillText(`出入口 ${o.exit || '3'}`, w / 2, h * 0.87);
}
function paintTokyu(ctx, x, y, w, h, o) {
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#c8102e'; ctx.fillRect(0, 0, w * 0.34, h);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `800 ${h * 0.42}px ${F.gothic}`; ctx.fillText('東急', w * 0.17, h * 0.42); ctx.font = `600 ${h * 0.13}px ${F.helv}`; ctx.fillText('TOKYU', w * 0.17, h * 0.76);
  const lines = [['TY', '01', '#c8102e', '東横線'], ['DT', '01', '#20a05a', '田園都市線']];
  const r = h * 0.2; let cx = w * 0.48;
  for (const [L, n, col, name] of lines) {
    lineCircle(ctx, cx, h * 0.42, r, L, n, col);
    ctx.fillStyle = '#222'; ctx.textAlign = 'center'; ctx.font = `600 ${h * 0.11}px ${F.gothic}`; ctx.fillText(name, cx, h * 0.8);
    cx += r * 3.2;
  }
  ctx.fillStyle = '#222'; ctx.textAlign = 'right'; ctx.font = `600 ${h * 0.16}px ${F.gothic}`; ctx.fillText('渋谷町駅', w * 0.97, h * 0.42); ctx.font = `500 ${h * 0.1}px ${F.helv}`; ctx.fillText('Shibuya-cho', w * 0.97, h * 0.7);
}
function paintMenu(ctx, x, y, w, h, o) {
  ctx.fillStyle = o.bg || '#1c1a18'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#6b4e2e'; ctx.lineWidth = Math.max(2, w * 0.03); ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  ctx.fillStyle = o.head || '#ffd75a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const hs = fit(ctx, o.title, w * 0.86, h * 0.13, '700', F.gothic); ctx.font = `700 ${hs}px ${F.gothic}`; ctx.fillText(o.title, w / 2, h * 0.1);
  ctx.fillStyle = '#ffd75a'; ctx.fillRect(w * 0.1, h * 0.17, w * 0.8, 2);
  const items = o.items || []; const rh = (h * 0.78) / Math.max(1, items.length);
  items.forEach(([name, price], i) => {
    const cy = h * 0.2 + rh * (i + 0.5);
    ctx.fillStyle = '#f2ece0'; ctx.textAlign = 'left'; const s = fit(ctx, name, w * 0.55, rh * 0.45, '500', F.gothic); ctx.font = `500 ${s}px ${F.gothic}`; ctx.fillText(name, w * 0.08, cy);
    ctx.fillStyle = '#ffd75a'; ctx.textAlign = 'right'; ctx.font = `700 ${Math.min(s, rh * 0.45)}px ${F.helv}`; ctx.fillText(price, w * 0.92, cy);
  });
}
function paintFlag(ctx, x, y, w, h, o) {
  ctx.fillStyle = o.bg || '#d7262b'; ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, 'rgba(0,0,0,0.18)'); g.addColorStop(0.35, 'rgba(255,255,255,0.08)'); g.addColorStop(1, 'rgba(0,0,0,0.12)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  if (o.band) { ctx.fillStyle = o.band; ctx.fillRect(0, 0, w, h * 0.09); ctx.fillRect(0, h * 0.91, w, h * 0.09); }
  const fam = o.font || F.gothic;
  vtext(ctx, o.text, w / 2, h * 0.12, h * 0.76, Math.min(w * 0.72, h * 0.76 / [...o.text].length * 0.92), fam, o.weight || '800', o.fg || '#ffffff');
}
function paintVending(ctx, x, y, w, h, o) {
  const brand = o.brand || 'Tojo Cola', col = o.color || '#c8102e';
  ctx.fillStyle = '#e9e9ea'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = col; ctx.fillRect(0, 0, w, h * 0.16);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const bs = fit(ctx, brand, w * 0.86, h * 0.1, '800', famFor(brand, o.font)); ctx.font = `800 ${bs}px ${famFor(brand, o.font)}`; ctx.fillText(brand, w / 2, h * 0.08);
  // lit display window with product samples
  ctx.fillStyle = '#f7f4ea'; ctx.fillRect(w * 0.05, h * 0.19, w * 0.9, h * 0.4);
  const rows = 3, cols = 5; const pw = w * 0.9 / cols, ph = h * 0.4 / rows;
  const colors = ['#d7262b', '#1c56b7', '#f5c400', '#0d8a4f', '#ff6a00', '#8a4b2a', '#00a0c8', '#7b2cbf'];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const px = w * 0.05 + pw * (c + 0.5), py = h * 0.19 + ph * (r + 0.55);
    ctx.fillStyle = colors[(r * 3 + c * 5 + (o.seed || 0)) % colors.length]; rrect(ctx, px - pw * 0.24, py - ph * 0.36, pw * 0.48, ph * 0.66, pw * 0.1); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(px - pw * 0.2, py - ph * 0.34, pw * 0.1, ph * 0.6);
    ctx.fillStyle = r === 1 && c < 2 ? '#d7262b' : '#1c56b7'; ctx.fillRect(px - pw * 0.3, py + ph * 0.32, pw * 0.6, ph * 0.1);
    ctx.fillStyle = '#fff'; ctx.font = `700 ${ph * 0.09}px ${F.helv}`; ctx.fillText('¥' + (130 + (c % 3) * 10), px, py + ph * 0.37);
  }
  ctx.fillStyle = '#1c56b7'; ctx.fillRect(w * 0.05, h * 0.55, w * 0.62, h * 0.04); ctx.fillStyle = '#d7262b'; ctx.fillRect(w * 0.67, h * 0.55, w * 0.28, h * 0.04);
  ctx.fillStyle = '#fff'; ctx.font = `700 ${h * 0.028}px ${F.gothic}`; ctx.fillText('つめた〜い', w * 0.36, h * 0.57); ctx.fillText('あったか〜い', w * 0.81, h * 0.57);
  // body: coin slot, buttons, dispenser
  ctx.fillStyle = '#d5d5d8'; ctx.fillRect(w * 0.05, h * 0.62, w * 0.9, h * 0.34);
  ctx.fillStyle = '#2a2a2e'; ctx.fillRect(w * 0.74, h * 0.64, w * 0.16, h * 0.16); ctx.fillStyle = '#9ad'; ctx.fillRect(w * 0.77, h * 0.66, w * 0.1, h * 0.05);
  ctx.fillStyle = '#333'; ctx.fillRect(w * 0.1, h * 0.84, w * 0.8, h * 0.1);
  ctx.fillStyle = col; ctx.fillRect(w * 0.08, h * 0.64, w * 0.6, h * 0.02);
}
function paintTaxi(ctx, x, y, w, h, o) {
  ctx.fillStyle = o.bg || '#ffffff'; ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0.15)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = o.fg || '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const s = fit(ctx, o.text, w * 0.86, h * 0.7, '800', famFor(o.text, o.font)); ctx.font = `800 ${s}px ${famFor(o.text, o.font)}`; ctx.fillText(o.text, w / 2, h * 0.52);
}
// "SHIBUYA 1O9" band wrapped around the cylinder
function paint109(ctx, x, y, w, h, o) {
  ctx.fillStyle = '#f4f4f2'; ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0.12)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#c8102e'; ctx.fillRect(0, 0, w, h * 0.07); ctx.fillRect(0, h * 0.93, w, h * 0.07);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const n = o.repeat || 2; const seg = w / n;
  for (let i = 0; i < n; i++) {
    const x0 = seg * i;
    ctx.fillStyle = '#6a6f78'; ctx.font = `700 ${h * 0.3}px ${F.helv}`; const sw = ctx.measureText('SHIBUYA').width;
    ctx.fillStyle = '#c8102e'; ctx.font = `800 ${h * 0.66}px ${F.maru}`; const nw = ctx.measureText('1O9').width;
    const total = sw + nw + h * 0.18; const sx = x0 + (seg - total) / 2;
    ctx.fillStyle = '#6a6f78'; ctx.font = `700 ${h * 0.3}px ${F.helv}`; ctx.fillText('SHIBUYA', sx, h * 0.5);
    ctx.fillStyle = '#c8102e'; ctx.font = `800 ${h * 0.66}px ${F.maru}`; ctx.fillText('1O9', sx + sw + h * 0.18, h * 0.5);
  }
}
function paintCenterGai(ctx, x, y, w, h, o) {
  ctx.fillStyle = '#e8306a'; ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(0,0,0,0.18)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, h * 0.03); ctx.strokeRect(h * 0.06, h * 0.06, w - h * 0.12, h - h * 0.12);
  // basketball
  const r = h * 0.3, bx = h * 0.5, by = h * 0.5; ctx.fillStyle = '#f08a2a'; ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#3a2410'; ctx.lineWidth = r * 0.09; ctx.beginPath(); ctx.moveTo(bx - r, by); ctx.lineTo(bx + r, by); ctx.moveTo(bx, by - r); ctx.lineTo(bx, by + r); ctx.stroke();
  ctx.beginPath(); ctx.arc(bx - r * 1.1, by, r * 0.95, -0.9, 0.9); ctx.stroke(); ctx.beginPath(); ctx.arc(bx + r * 1.1, by, r * 0.95, Math.PI - 0.9, Math.PI + 0.9); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const s = fit(ctx, o.text, w * 0.62, h * 0.5, '800', F.gothic); ctx.font = `800 ${s}px ${F.gothic}`; ctx.lineWidth = s * 0.06; ctx.strokeStyle = '#7a0f36'; ctx.strokeText(o.text, h * 1.0, h * 0.4); ctx.fillText(o.text, h * 1.0, h * 0.4);
  const s2 = fit(ctx, o.sub, w * 0.6, h * 0.24, 'italic 700', F.helv); ctx.font = `italic 700 ${s2}px ${F.helv}`; ctx.fillStyle = '#fff2c8'; ctx.fillText(o.sub, h * 1.05, h * 0.78);
}
// corrugated silver aluminium (109 drum stand-in), tiled
function paintRibbed(ctx, x, y, w, h) {
  ctx.fillStyle = '#b9bcc1'; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < w; i += 8) { ctx.fillStyle = '#d6d8dc'; ctx.fillRect(i, 0, 3, h); ctx.fillStyle = '#8d9096'; ctx.fillRect(i + 5, 0, 2, h); }
  ctx.fillStyle = 'rgba(40,42,48,0.55)'; ctx.fillRect(0, h - 4, w, 4);
}

// ------------------------------------------------------------------------------------------------ factories
export function makeSign(o = {}) {
  const { text = '看板', w = 4, h = 1, glow = 1.1 } = o;
  const qw = q2(w), qh = q5(h);
  const key = ['fascia', text, o.sub, o.bg, o.fg, o.font, o.weight, o.mark, o.stripe, o.stripeBottom, o.vertical, o.tag, o.align, o.channel ? 'c' : '', qw, qh, o.ppm || ''].join('~');
  const bleed = o.channel ? '#17181c' : (o.bg || '#d7262b');
  const a = paint(o.style || 'fascia', qw, qh, key, bleed, (ctx, x, y, W, H) => paintFascia(ctx, x, y, W, H, { ...o, text }), o.ppm);
  if (!a) return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color: bleed }));
  const g = o.emissive != null ? o.emissive : glowFor(bleed, glow);
  const mesh = signMesh(a, new THREE.PlaneGeometry(w, h), g, { w, h, text });
  mesh.name = 'sign:' + text;
  signage.signs.push(mesh);
  return mesh;
}
// arbitrary painter into a chosen atlas style; returns a mesh (plane) or applies to a given geometry
export function makePainted({ style = 'plate', w = 1, h = 1, key, bleed = '#000', painter, glow = 1.0, geometry = null, ppm } = {}) {
  const a = paint(style, w, h, key || painter.toString().slice(0, 40) + w + 'x' + h, bleed, painter, ppm);
  if (!a) return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color: bleed }));
  const mesh = signMesh(a, geometry || new THREE.PlaneGeometry(w, h), glow, { w, h });
  signage.signs.push(mesh);
  return mesh;
}
export function makeNeon(o = {}) {
  const { text = 'BAR', w = 3, h = 1, color = '#ff2d7a', glow = 2.6 } = o;
  const qw = q2(w), qh = q5(h);
  const key = ['neon', text, o.sub, color, o.font, o.weight, o.border, o.vertical, qw, qh].join('~');
  const g = new THREE.Group(); g.name = 'neon:' + text;
  const a = paint('neon', qw, qh, key, o.bg || '#0b0a0e', (ctx, x, y, W, H) => paintNeon(ctx, x, y, W, H, { ...o, text, color }));
  if (a) { const m = signMesh(a, new THREE.PlaneGeometry(w, h), glow, { w, h, text }); m.name = 'neon'; g.add(m); signage.signs.push(m); }
  const hb = paint('halo', qw * 1.35, qh * 1.6, key, '#000', (ctx, x, y, W, H) => paintHalo(ctx, x, y, W, H, { ...o, text, color }));
  if (hb) { const hm = signMesh(hb, new THREE.PlaneGeometry(w * 1.35, h * 1.6), 1, { halo: true }); hm.position.z = 0.05; hm.name = 'halo'; g.add(hm); signage.halos.push(hm); }
  return g;
}
export function makeStreetSign({ name = '道玄坂', romaji = 'Dogenzaka', ward = '渋谷区', w = 1.4, h = 0.42 } = {}) {
  const m = makePainted({ style: 'plate', w, h, key: 'street~' + name + romaji, bleed: '#0d2a6a', painter: (ctx, x, y, W, H) => paintStreet(ctx, x, y, W, H, { name, romaji, ward }), glow: 0.75 });
  m.name = 'street:' + name; return m;
}
export function makeGuideSign({ rows = [{ jp: 'ハチ公前広場', en: 'Hachiko Square', dir: 'left' }, { jp: '渋谷町駅', en: 'Shibuya-cho Sta.', dir: 'right' }], w = 1.6, h = 0.9, bg = '#ffffff', fg = '#10306a' } = {}) {
  return makePainted({ style: 'plate', w, h, key: 'guide~' + rows.map(r => r.jp + r.dir).join(','), bleed: bg, painter: (ctx, x, y, W, H) => paintGuide(ctx, x, y, W, H, { rows, bg, fg }), glow: 0.55 });
}
export function makeStationSign({ kind = 'jp', w = 12, h = 2.2, text = '渋谷町駅', romaji = 'Shibuya-cho Station', right = 'ハチ公改札', rightEn = 'Hachiko Exit' } = {}) {
  const painter = kind === 'metro' ? paintMetro : kind === 'tokyu' ? paintTokyu : paintStationJP;
  return makePainted({ style: 'plate', w, h, key: 'station~' + kind + text + right + w, bleed: kind === 'jp' ? '#1d8f3e' : '#ffffff', painter: (ctx, x, y, W, H) => painter(ctx, x, y, W, H, { text, romaji, right, rightEn }), glow: 0.7 });
}
// free-standing 東京メトロ entrance totem (lit box on a plinth)
export function makeMetroTotem({ exit = '3', w = 0.9, h = 3.0 } = {}) {
  const g = new THREE.Group(); g.name = 'metroTotem';
  const face = makePainted({ style: 'plate', w, h, key: 'totem~' + exit, bleed: '#ffffff', painter: (ctx, x, y, W, H) => paintMetroTotem(ctx, x, y, W, H, { exit }), glow: 0.6, ppm: 120 });
  face.position.set(0, h / 2 + 0.25, 0.2); g.add(face);
  const back = face.clone(); back.rotation.y = Math.PI; back.position.z = -0.2; g.add(back);
  const box = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.38), frameMat()); box.position.y = h / 2 + 0.25; box.userData.frame = true; g.add(box);
  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.25, 0.7), frameMat()); base.position.y = 0.125; base.userData.frame = true; g.add(base);
  return g;
}
export function makeMenuBoard({ title = '本日のおすすめ', items = [['唐揚げ定食', '¥780'], ['生ビール', '¥390'], ['ハイボール', '¥290']], w = 0.6, h = 0.9, bg = '#1c1a18' } = {}) {
  const board = makePainted({ style: 'plate', w, h, key: 'menu~' + title + items.map(i => i.join('')).join(','), bleed: bg, painter: (ctx, x, y, W, H) => paintMenu(ctx, x, y, W, H, { title, items, bg }), glow: 0.5, ppm: 220 });
  const g = new THREE.Group(); g.name = 'menu';
  board.position.set(0, h / 2 + 0.05, 0.12); board.rotation.x = -0.18; g.add(board);
  const back = board.clone(); back.rotation.set(0.18, Math.PI, 0); back.position.z = -0.12; g.add(back);
  const legs = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.04, 0.5), frameMat()); legs.position.y = 0.02; legs.userData.frame = true; g.add(legs);
  return g;
}
export function makeFlag({ text = 'ラーメン', bg = '#d7262b', fg = '#ffffff', band = null, w = 0.6, h = 1.8, font = null, weight = '800' } = {}) {
  const key = 'flag~' + text + bg + fg + band;
  const a = paint('cloth', w, h, key, bg, (ctx, x, y, W, H) => paintFlag(ctx, x, y, W, H, { text, bg, fg, band, font, weight }));
  const g = new THREE.Group(); g.name = 'flag:' + text;
  const geo = new THREE.PlaneGeometry(w, h, 3, 6);
  if (a) {
    remapUV(geo, a); setAttr(geo, 'aGlow', 0.35);
    const pos = geo.attributes.position, wave = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) wave[i] = Math.max(0, (pos.getX(i) + w / 2) / w) ** 1.5;
    geo.setAttribute('aWave', new THREE.BufferAttribute(wave, 1));
    const m = new THREE.Mesh(geo, a.page.material); m.userData.sign = { page: a.page, glow: 0.35 }; m.layers.enable(1); m.position.set(w / 2 + 0.03, h / 2 + 0.55, 0); g.add(m); signage.signs.push(m);
  }
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, h + 0.8, 6), frameMat()); pole.position.y = (h + 0.8) / 2; pole.userData.frame = true; g.add(pole);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, w + 0.05, 5), frameMat()); arm.rotation.z = Math.PI / 2; arm.position.set(w / 2, h + 0.55, 0); arm.userData.frame = true; g.add(arm);
  return g;
}
// vertical 袖看板 stack: plates alternate colours, hang on a bracket off the façade edge, readable from both sides.
// tenants[0] is the TOP plate; floor tags count down from firstFloor + n - 1.
export function makeVerticalStack({ tenants = ['カラオケ舘', '一乱', 'ジャンカレ', 'アコン', 'BAR 月の舟', '渋谷町歯科'], plateW = 0.9, plateH = 0.75, gap = 0.12, palette = null, seed = 0, floors = true, firstFloor = 2, projection = 1.0 } = {}) {
  const g = new THREE.Group(); g.name = 'sode';
  const pal = palette || PALETTE;
  const n = tenants.length; const total = n * plateH + (n - 1) * gap;
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, total + 0.3, 0.07), frameMat()); rail.position.set(0, total / 2, projection * 0.5); rail.userData.frame = true; g.add(rail);
  for (let i = 0; i < n; i++) {
    const t = tenants[i]; const [bg, fg] = brandColors(t) || pal[(i * 2 + seed) % pal.length];
    const y = total - plateH / 2 - i * (plateH + gap);
    const floor = floors ? `${firstFloor + n - 1 - i}F` : null;
    const cat = category(t);
    const key = ['sode', t, bg, fg, floor, cat, plateW, plateH].join('~');
    const chars = [...t]; let line1 = t, line2 = null;
    if (chars.length >= 6 && plateH <= plateW * 1.1) { const sp = t.indexOf(' '); const cut = sp > 1 && sp < chars.length - 2 ? sp : Math.ceil(chars.length / 2); line1 = chars.slice(0, cut).join('').trim(); line2 = chars.slice(cut).join('').trim(); }
    const a = paint('sode', plateW, plateH, key, bg, (ctx, x, yy, W, H) => paintFascia(ctx, x, yy, W, H, { text: line1, twoLine: line2, bg, fg, vertical: chars.length >= 4 && plateH > plateW * 1.1, tag: floor, weight: cat === 'clinic' || cat === 'office' ? '600' : '800', font: cat === 'bar' ? F.mincho : cat === 'clinic' ? F.maru : null }));
    if (!a) continue;
    const glow = glowFor(bg, 1.35 + (i % 3) * 0.12);
    const front = signMesh(a, new THREE.PlaneGeometry(plateW, plateH), glow, { w: plateW, h: plateH, text: t });
    front.position.set(0.035, y, projection * 0.5); front.rotation.y = Math.PI / 2;
    const back = signMesh(a, new THREE.PlaneGeometry(plateW, plateH), glow, { w: plateW, h: plateH, text: t });
    back.position.set(-0.035, y, projection * 0.5); back.rotation.y = -Math.PI / 2;
    g.add(front, back); signage.signs.push(front, back);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, projection * 0.5), frameMat()); arm.position.set(0, y + plateH / 2 - 0.05, projection * 0.25); arm.userData.frame = true; g.add(arm);
  }
  return g;
}
export function makeVendingFace({ brand = 'Tojo Cola', color = '#c8102e', w = 1.0, h = 1.85, seed = 0, font = null } = {}) {
  return makePainted({ style: 'plate', w, h, key: 'vend~' + brand + color + seed, bleed: '#e9e9ea', painter: (ctx, x, y, W, H) => paintVending(ctx, x, y, W, H, { brand, color, seed, font }), glow: 0.8, ppm: 200 });
}
const TAXI = [['日本交道', '#f5d000', '#111'], ['国際自転車 KM', '#ffffff', '#1c56b7'], ['帝都', '#f7f7f7', '#c8102e'], ['渋谷町交通', '#7ed957', '#111']];
export function taxiLampKit(w = 0.5, h = 0.18, d = 0.22) {
  return TAXI.map(([company, bg, fg]) => {
    const a = paint('plate', w, h, 'taxi~' + company, bg, (ctx, x, y, W, H) => paintTaxi(ctx, x, y, W, H, { text: company, bg, fg }), 320);
    const geo = new THREE.BoxGeometry(w, h, d);
    if (a) { const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, a.u0 + uv.getX(i) * (a.u1 - a.u0), a.v0 + uv.getY(i) * (a.v1 - a.v0)); setAttr(geo, 'aGlow', 2.2); setAttr(geo, 'aWave', 0); }
    return { company, geometry: geo, material: a ? a.page.material : frameMat() };
  });
}
export function makeTaxiLamp({ company = '日本交道' } = {}) {
  const kit = taxiLampKit().find(k => k.company === company) || taxiLampKit()[0];
  const m = new THREE.Mesh(kit.geometry, kit.material); m.layers.enable(1); m.name = 'taxiLamp'; return m;
}

let _frameMat = null, _drumMat = null;
function frameMat() { return _frameMat || (_frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.55, metalness: 0.6, name: 'signage:frame' })); }
function drumMat() {
  if (_drumMat) return _drumMat;
  const c = document.createElement('canvas'); c.width = 256; c.height = 256; paintRibbed(c.getContext('2d'), 0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 8;
  return (_drumMat = new THREE.MeshStandardMaterial({ map: tex, color: 0xd0d3d8, roughness: 0.42, metalness: 0.7, name: 'signage:drum' }));
}
function frameBox(w, h, d = 0.3) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat()); m.userData.frame = true; return m; }

export function place(mesh, pos, facing, parent) {
  mesh.position.copy(pos);
  const target = new THREE.Vector3().copy(pos).add(facing);
  mesh.lookAt(target);
  if (parent) parent.add(mesh);
  return mesh;
}

// ------------------------------------------------------------------------------------------------ geometry helpers
// polygons are world [x, z]; faces get outward normals (city convention: polyArea > 0 -> outward = (dz, -dx)).
function polyArea(p) { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; }
function polyFaces(polyIn) {
  const poly = polyArea(polyIn) < 0 ? polyIn.slice().reverse() : polyIn;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
    out.push({ a, b, len, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], n: [dz / len, -dx / len], r: [-dx / len, -dz / len] }); // r = rightward tangent seen from the street
  }
  return out;
}
function rectPoly(cx, cz, w, d, rotY = 0) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c]);
}
function dirOfRotY(r) { return [Math.cos(r), -Math.sin(r)]; }
// face whose outward normal best matches (dx,dz); longer faces win ties
function faceToward(faces, dx, dz, minLen = 4) {
  const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
  let best = null, bs = -Infinity;
  for (const f of faces) { const d = f.n[0] * dx + f.n[1] * dz; if (d < 0.35 || f.len < minLen) continue; const s = d * Math.sqrt(f.len); if (s > bs) { bs = s; best = f; } }
  return best;
}
const onFace = (f, along, y, out) => new THREE.Vector3(f.mid[0] + f.r[0] * along + f.n[0] * out, y, f.mid[1] + f.r[1] * along + f.n[1] * out);
const nOf = (f) => new THREE.Vector3(f.n[0], 0, f.n[1]);

// ------------------------------------------------------------------------------------------------ tenants
const PALETTE = [
  ['#d7262b', '#ffffff'], ['#f5c400', '#1a1a1a'], ['#1c56b7', '#ffffff'], ['#ffffff', '#d7262b'], ['#0d8a4f', '#ffffff'],
  ['#ff6a00', '#ffffff'], ['#ffffff', '#1c56b7'], ['#7b2cbf', '#ffffff'], ['#ff2d7a', '#ffffff'], ['#101010', '#ffd400'],
  ['#00a0c8', '#ffffff'], ['#f2e8c8', '#5a2a10'], ['#e8e8e8', '#111111'], ['#8a0a0a', '#ffe9a0'], ['#004b8d', '#ffd400'],
  ['#ffffff', '#0d8a4f'], ['#1a1a1a', '#ff2d7a'], ['#ffe600', '#d7262b'],
];
const BRAND = {
  'マックドナルド': ['#d7262b', '#ffd400'], 'ポッポ': ['#1c56b7', '#ffffff'], 'セブンイレブ': ['#ffffff', '#e8571d'], 'ファミリマート': ['#ffffff', '#00a24a'],
  'マツモトキヨヒ': ['#ffe600', '#1c56b7'], 'サンドラック': ['#ffffff', '#d7262b'], '三千里薬局': ['#ffffff', '#d7262b'], 'ウエルシヤ': ['#ffffff', '#0a7a3a'], 'ココカラファイソ': ['#ffffff', '#ff6a00'],
  'カラオケ舘': ['#ff2d7a', '#ffffff'], 'ジャンカレ': ['#ffd400', '#d7262b'], 'ビックエコー': ['#1c56b7', '#ffd400'], 'カラオケ パセリ': ['#0d8a4f', '#ffffff'],
  'アコン': ['#d7262b', '#ffffff'], 'プロミズ': ['#ff6a00', '#ffffff'], 'アイフリ': ['#1c56b7', '#ffffff'], 'レイク ALSO': ['#0057b8', '#ffffff'],
  '三稜UFJ銀行': ['#d7262b', '#ffffff'], 'みずぼ銀行': ['#1c56b7', '#ffffff'], 'りそね銀行': ['#0d8a4f', '#ffffff'], '三井住本銀行': ['#006e54', '#ffffff'], 'SMBK信託': ['#006e54', '#ffffff'],
  'UNIQRO': ['#d7262b', '#ffffff'], 'GO': ['#1a1a1a', '#e91e63'], 'ABC-MARK': ['#ffffff', '#d7262b'], 'ドン・キホーヂ': ['#1c56b7', '#ffe600'], 'ドン・キホーヂ 渋谷本店': ['#1c56b7', '#ffe600'],
  'ビッグカメラ': ['#d7262b', '#ffffff'], 'ビッグカメラ 渋谷東口': ['#d7262b', '#ffffff'], 'ビッグカメラ 渋谷ハチ公口店': ['#d7262b', '#ffffff'], 'ヤマド電機 LABY': ['#ffffff', '#d7262b'], 'ノジモ': ['#ffffff', '#d7262b'],
  'ソフトバング': ['#ffffff', '#111111'], 'aU ショップ': ['#ff6a00', '#ffffff'], 'ドコマショップ': ['#d7262b', '#ffffff'],
  'STARBEANS COFFEE': ['#0b3d2e', '#ffffff'], 'ドトルコーヒー': ['#ffd400', '#111111'], 'タリース': ['#ffffff', '#111111'], 'エクセルシオル': ['#1a1a1a', '#e8c070'], '珈琲舘': ['#4a2a10', '#f2e0c0'],
  '一乱': ['#ffffff', '#d7262b'], '天下一本': ['#ffe600', '#111111'], '一風道': ['#ffffff', '#111111'], '博多天真': ['#d7262b', '#ffffff'], '富土そば': ['#0d8a4f', '#ffffff'], '日高家': ['#ffe600', '#d7262b'],
  '松家': ['#ffd400', '#1c56b7'], '吉野屋': ['#ff6a00', '#111111'], 'すき屋': ['#d7262b', '#ffe600'],
  'ガスド': ['#d7262b', '#ffffff'], 'サイゼリア': ['#0d8a4f', '#ffffff'], 'デニース': ['#ffffff', '#d7262b'], 'ジョナソン': ['#ffffff', '#0d8a4f'], '大戸家': ['#f2e8c8', '#5a2a10'],
  '鳥貴賊': ['#d7262b', '#ffe600'], '磯丸漁港': ['#0057b8', '#ffffff'], '牛閣': ['#1a1a1a', '#e8c070'], '温野采': ['#ffffff', '#0d8a4f'], '和氏': ['#8a0a0a', '#ffe9a0'], '笑々': ['#ffe600', '#111111'], '白木家': ['#ffffff', '#111111'], '魚氏': ['#004b8d', '#ffffff'], '銀の蔵': ['#1a1a1a', '#c8c8c8'], '土間々': ['#f2e8c8', '#111111'],
  'TSUTAYU': ['#f7d100', '#0b2a5a'], 'ブックオン': ['#ffe600', '#1c56b7'], '大盛道書店': ['#ffffff', '#111111'], 'まんだらげ': ['#1a1a1a', '#ffd400'],
  'タイトーステーシオン': ['#ffffff', '#d7262b'], 'アドアース': ['#ff2d7a', '#ffffff'], 'GIGA': ['#1a1a1a', '#00e0ff'], '快活CLAB': ['#0d8a4f', '#ffffff'], 'ラウンドツー': ['#d7262b', '#ffffff'], 'マンボウ ネットカフェ': ['#1c56b7', '#ffffff'],
  'マルハソ 渋谷': ['#d7262b', '#ffe600'], 'エスパズ日拓': ['#1c56b7', '#ffe600'], 'ビッグアポロ': ['#ffe600', '#d7262b'],
  'ホテル・シルキー': ['#f2e8c8', '#5a2a10'], 'ドミーイン 渋谷町': ['#8a0a0a', '#ffffff'], 'アバホテル 渋谷町': ['#ffffff', '#d7262b'], '東急ステー': ['#d7262b', '#ffffff'], 'ホテル・マヨビエンテ': ['#1a1a1a', '#e8c070'],
  'H&N': ['#ffffff', '#d7262b'], 'ZALA': ['#ffffff', '#111111'], 'WEGA': ['#1a1a1a', '#ffffff'], 'SPINZ': ['#ffffff', '#111111'], 'ベルシュケ': ['#1a1a1a', '#ffffff'], '無地良品': ['#8a0a0a', '#ffffff'], 'ビレッジバンガード': ['#ffe600', '#111111'], 'JINZ': ['#ffffff', '#111111'], 'Zoft': ['#ffffff', '#1c56b7'], 'ダイソウ': ['#ff2d7a', '#ffffff'],
  'TOHOシネマ 渋谷町': ['#1a1a1a', '#ffd400'], 'シネマライス': ['#0057b8', '#ffffff'], 'ゼロゲート': ['#1a1a1a', '#ffffff'], 'スイーツパラダイズ': ['#ff2d7a', '#ffffff'], 'ゴン茶': ['#1a1a1a', '#ffd400'], 'マリオソクレープ': ['#ffe600', '#d7262b'],
  '東急ハンド': ['#0d8a4f', '#ffffff'], '渋谷マルコ アネックス': ['#d7262b', '#ffffff'], 'モズバーガー': ['#d7262b', '#ffffff'], 'ロッテリヤ': ['#ffffff', '#d7262b'], 'ケンタッキ': ['#d7262b', '#ffffff'], 'サブウェー': ['#ffe600', '#0d8a4f'], 'スマイルバーガー': ['#ff6a00', '#ffffff'], 'バーガーキンク': ['#8a0a0a', '#ffd400'],
};
function brandColors(t) { return BRAND[t] || null; }
function category(t) {
  if (/カラオケ|ジャンカレ|エコー|パセリ/.test(t)) return 'karaoke';
  if (/BAR|Bar|バー|スナック|立呑|串焼|小料理|焼酎|おでん|モツ|居酒屋|鳥貴|磯丸|牛閣|温野|和氏|笑々|白木|魚氏|銀の蔵|土間|甚八|おやひな|クラブ|WOMP|横丁|のんべい/.test(t)) return 'bar';
  if (/ラーメン|一乱|天下一本|一風道|博多|そば|日高|松家|吉野|すき屋|バーガー|マック|モズ|ロッテ|ケンタ|サブウ|ガスド|サイゼ|デニース|ジョナ|大戸|茶漬|鮨|渚/.test(t)) return 'food';
  if (/薬局|ドラッグ|キヨヒ|サンドラ|ココカラ|ウエル/.test(t)) return 'drug';
  if (/銀行|信託|証|證|海上/.test(t)) return 'bank';
  if (/クリニック|歯科|眼科|皮フ|医院|Doctor/.test(t)) return 'clinic';
  if (/アコン|プロミズ|アイフリ|レイク/.test(t)) return 'money';
  if (/ホテル|イン |ステー|ドミー/.test(t)) return 'hotel';
  if (/COFFEE|コーヒー|珈琲|タリース|エクセル|茶|クレープ|スイーツ/.test(t)) return 'cafe';
  if (/ビル|事務所|不動産|エイブレ|アパマン|旅遊|ヒューマ|マンション|会館|プラザ|BLD|SEDE|センター|ビルヂング|證研|PRIMA|RENGE/.test(t)) return 'office';
  if (/パチ|マルハソ|エスパズ|アポロ|ステーシオン|アドアース|GIGA|CLAB|ネットカフェ|ラウンド|シネマ|ゲート/.test(t)) return 'amuse';
  return 'shop';
}
const POOL = {
  ground: ['ポッポ', 'セブンイレブ', 'ファミリマート', 'マツモトキヨヒ', 'サンドラック', 'ドトルコーヒー', 'マックドナルド', '松家', '吉野屋', 'すき屋', '一乱', '天下一本', 'ABC-MARK', 'ソフトバング', 'ドコマショップ', 'aU ショップ', 'タリース', 'STARBEANS COFFEE', '日高家', '富土そば', 'モズバーガー', 'ロッテリヤ', 'ケンタッキ', 'サブウェー', 'スマイルバーガー', '大盛道書店', 'ビレッジバンガード', 'ダイソウ', 'JINZ', 'GO', 'UNIQRO'],
  upper: ['カラオケ舘', 'ジャンカレ', 'ビックエコー', '鳥貴賊', '磯丸漁港', '牛閣', '温野采', '和氏', '笑々', '白木家', '魚氏', '銀の蔵', '土間々', '居酒屋 甚八', '焼鳥 おやひな屋', '渋谷町クリニック', '道玄坂歯科', '宇田川皮フ科', '神南メンタルクリニック', '渋谷町眼科', '快活CLAB', 'マンボウ ネットカフェ', 'ガスド', 'サイゼリア', 'デニース', 'ジョナソン', '大戸家', 'エイブレ', 'アパマンショプ', '東光不動産', '日本旅遊', '渋谷町総合法律事務所', 'BAR 鳥渡', 'スナック 美晴', 'BAR ピアノ', 'Bar 月の舟', 'BAR 弐拾壱', '小料理 ちどり', 'おでん 和', 'ラウンドツー', 'GIGA', 'タイトーステーシオン', '立呑み 富士屋', '串焼 ひろし', '焼酎 ゆうき', 'モツ焼 みつ'],
  office: ['渋谷町総合法律事務所', '東光不動産', 'エイブレ', 'アパマンショプ', '日本旅遊', 'ヒューマクス', '大和證研', '渋谷町クリニック', '道玄坂歯科', '神南メンタルクリニック', '渋谷町眼科', '東京海上日勤', '税理士 山本事務所', '渋谷町司法書士会'],
  amuse: ['カラオケ舘', 'ジャンカレ', 'ビックエコー', 'カラオケ パセリ', 'タイトーステーシオン', 'アドアース', 'GIGA', '快活CLAB', 'マンボウ ネットカフェ', 'ラウンドツー', '鳥貴賊', '磯丸漁港', '牛閣', '笑々', '白木家', 'BAR 鳥渡', 'スナック 美晴', 'Bar 月の舟', 'クラブ キャメロト'],
  hotel: ['ホテル・シルキー', 'ドミーイン 渋谷町', '東急ステー', 'アバホテル 渋谷町', 'ホテル・マヨビエンテ'],
  resi: ['渋谷町クリニック', '宇田川皮フ科', 'ピアノ教室', '英会話 NOVO', '珈琲舘', 'エイブレ', '税理士 山本事務所'],
  money: ['アコン', 'プロミズ', 'アイフリ', 'レイク ALSO'],
  bank: ['三稜UFJ銀行', 'みずぼ銀行', 'りそね銀行', '三井住本銀行'],
  flags: [['ラーメン', '#d7262b', '#fff'], ['居酒屋', '#8a0a0a', '#ffe9a0'], ['飲み放題 ¥1980', '#ffe600', '#d7262b'], ['新装開店', '#d7262b', '#ffe600'], ['SALE 開催中', '#ffffff', '#d7262b'], ['カラオケ 30分 ¥100', '#ff2d7a', '#fff'], ['タピオカ', '#1a1a1a', '#ffd400'], ['焼鳥 1本 ¥90', '#f2e8c8', '#5a2a10'], ['たこ焼', '#ff6a00', '#fff'], ['当店 全席禁煙', '#1c56b7', '#fff'], ['クレープ', '#ff2d7a', '#fff'], ['iPhone 買取', '#ffffff', '#111']],
  menus: [{ title: '本日のおすすめ', items: [['唐揚げ定食', '¥780'], ['生姜焼き', '¥820'], ['生ビール', '¥390']] }, { title: 'ランチ', items: [['醤油ラーメン', '¥850'], ['味玉つけ麺', '¥980'], ['餃子 6個', '¥350']] }, { title: '飲み放題', items: [['2時間', '¥1,980'], ['ハイボール', '¥290'], ['レモンサワー', '¥350']] }, { title: '本日のケーキ', items: [['ショートケーキ', '¥520'], ['モンブラン', '¥580'], ['カフェラテ', '¥480']] }, { title: 'おすすめ', items: [['焼鳥 盛合せ', '¥880'], ['刺身 三点', '¥980'], ['日本酒', '¥600']] }],
  slogans: { karaoke: ['24H フリータイム ¥980', '30分 ¥100〜', 'カラオケ・パーティルーム'], bar: ['2F・3F', '17:00〜翌5:00', '飲み放題 ¥1,980'], food: ['24時間営業', 'ランチ ¥850〜', '本場の味'], drug: ['ドラッグ・コスメ', '処方せん受付', '24H OPEN'], bank: ['ATM 24H', 'Bank'], clinic: ['内科・皮膚科', '予約制 2F', '土日診療'], money: ['ご融資は当店へ', 'ATM 24H', 'はじめてなら30日無利息'], hotel: ['HOTEL', 'ビジネスホテル', '素泊り ¥6,800〜'], cafe: ['COFFEE & CAKE', 'Wi-Fi FREE', '7:00 OPEN'], office: ['OFFICE', '3F〜8F', 'テナント募集中'], amuse: ['ゲーム・プリクラ', 'AMUSEMENT', 'ネットカフェ 24H'], shop: ['NEW OPEN', 'SALE', 'SHIBUYA-CHO'] },
};
const NEON_COLORS = ['#ff2d7a', '#ff3b3b', '#ffb020', '#39ff88', '#3ad7ff', '#c86bff', '#ffffff', '#ff7a1a'];

// ------------------------------------------------------------------------------------------------ LED screens
const ADS = [
  { title: 'STARBEANS', sub: 'COFFEE — 渋谷町店 OPEN', bg: ['#0b3d2e', '#1e7a58'], fg: '#f5f1e6', kind: 'cup' },
  { title: 'サンシャインビール', sub: '今夜も、乾杯。', bg: ['#f2b705', '#e4791b'], fg: '#1a1208', kind: 'beer' },
  { title: 'Tojo Cola', sub: 'ICE COLD / キンキンに冷えてやがる', bg: ['#8c0a0a', '#e01c1c'], fg: '#ffffff', kind: 'can' },
  { title: 'Bumblebee', sub: 'カラオケ 24H / フリータイム ¥980', bg: ['#111', '#3a2f00'], fg: '#ffd400', kind: 'mic' },
  { title: '純愛', sub: '映画 — 9.19 ROADSHOW', bg: ['#2b1a3a', '#6b2d6b'], fg: '#f8e8ff', kind: 'movie' },
  { title: '龍', sub: 'PERFUME by KAMURO', bg: ['#000', '#2a2a2a'], fg: '#d9b45a', kind: 'bottle' },
  { title: 'SHIBUYA46', sub: 'NEW SINGLE「スクランブル」', bg: ['#ff2d7a', '#ff8ac2'], fg: '#ffffff', kind: 'idol' },
  { title: 'SHIBUYA SKY', sub: '展望台 チケット発売中 — 14F', bg: ['#0b1a3a', '#2a5fa8'], fg: '#ffffff', kind: 'sky' },
  { title: 'ソフトバング', sub: '5G 新プラン 月額 ¥1,980〜', bg: ['#111111', '#3a3a3a'], fg: '#ffffff', kind: 'phone' },
];

function drawAdArt(ctx, ad, W, H, f, t) {
  const cx = W * 0.26, cy = H * 0.5, s = Math.min(W, H) * 0.6;
  ctx.save();
  switch (ad.kind) {
    case 'cup': { // takeaway cup with steam
      ctx.fillStyle = '#f5f1e6'; ctx.beginPath(); ctx.moveTo(cx - s * 0.22, cy - s * 0.18); ctx.lineTo(cx + s * 0.22, cy - s * 0.18); ctx.lineTo(cx + s * 0.16, cy + s * 0.34); ctx.lineTo(cx - s * 0.16, cy + s * 0.34); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#0b3d2e'; ctx.fillRect(cx - s * 0.2, cy - s * 0.02, s * 0.4, s * 0.12);
      ctx.fillStyle = '#e8e0d0'; ctx.fillRect(cx - s * 0.26, cy - s * 0.27, s * 0.52, s * 0.09);
      ctx.fillStyle = '#f5f1e6'; ctx.beginPath(); ctx.arc(cx, cy + s * 0.04, s * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = s * 0.02; for (let i = -1; i <= 1; i++) { ctx.beginPath(); const x0 = cx + i * s * 0.09; ctx.moveTo(x0, cy - s * 0.3); ctx.bezierCurveTo(x0 - s * 0.05, cy - s * 0.4 - Math.sin(t * 2 + i) * s * 0.03, x0 + s * 0.05, cy - s * 0.46, x0, cy - s * 0.56); ctx.stroke(); }
      break; }
    case 'beer': {
      ctx.fillStyle = '#ffcf3a'; ctx.fillRect(cx - s * 0.18, cy - s * 0.2, s * 0.36, s * 0.55);
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(cx - s * 0.14, cy - s * 0.16, s * 0.06, s * 0.47);
      ctx.fillStyle = '#fff8e8'; ctx.beginPath(); ctx.ellipse(cx, cy - s * 0.2, s * 0.22, s * 0.1, 0, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx - s * 0.12, cy - s * 0.28, s * 0.09, 0, Math.PI * 2); ctx.arc(cx + s * 0.08, cy - s * 0.3, s * 0.1, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffcf3a'; ctx.lineWidth = s * 0.05; ctx.beginPath(); ctx.arc(cx + s * 0.26, cy + s * 0.08, s * 0.13, -Math.PI / 2, Math.PI / 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; for (let i = 0; i < 7; i++) { const by = cy + s * 0.3 - ((t * 0.35 + i * 0.14) % 0.45) * s; ctx.beginPath(); ctx.arc(cx - s * 0.1 + (i % 4) * s * 0.06, by, s * 0.012 + (i % 3) * s * 0.006, 0, Math.PI * 2); ctx.fill(); }
      break; }
    case 'can': {
      const rot = Math.sin(t * 1.5) * 0.08; ctx.translate(cx, cy); ctx.rotate(-0.25 + rot);
      ctx.fillStyle = '#c8102e'; rrect(ctx, -s * 0.16, -s * 0.32, s * 0.32, s * 0.64, s * 0.05); ctx.fill();
      ctx.fillStyle = '#d8d8dc'; ctx.fillRect(-s * 0.16, -s * 0.32, s * 0.32, s * 0.05); ctx.fillRect(-s * 0.16, s * 0.27, s * 0.32, s * 0.05);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `italic 900 ${s * 0.1}px ${F.helv}`; ctx.fillText('Tojo', 0, -s * 0.06); ctx.fillText('Cola', 0, s * 0.06);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = s * 0.02; ctx.beginPath(); ctx.moveTo(-s * 0.15, s * 0.18); ctx.bezierCurveTo(-s * 0.05, s * 0.12, s * 0.05, s * 0.24, s * 0.15, s * 0.16); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(-s * 0.13, -s * 0.28, s * 0.05, s * 0.56);
      break; }
    case 'mic': {
      ctx.fillStyle = '#ffd400'; for (let i = 0; i < 6; i++) { ctx.fillRect(0, (i * 2 + ((t * 0.5) % 2)) * H / 12, W * 0.02, H / 12); }
      ctx.translate(cx, cy); ctx.rotate(-0.6);
      ctx.fillStyle = '#c8c8cc'; ctx.beginPath(); ctx.arc(0, -s * 0.16, s * 0.15, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#555'; ctx.lineWidth = s * 0.012; for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(-s * 0.15, -s * 0.16 + i * s * 0.045); ctx.lineTo(s * 0.15, -s * 0.16 + i * s * 0.045); ctx.stroke(); }
      ctx.fillStyle = '#222'; rrect(ctx, -s * 0.07, -s * 0.02, s * 0.14, s * 0.4, s * 0.04); ctx.fill();
      ctx.fillStyle = '#ffd400'; ctx.fillRect(-s * 0.07, s * 0.02, s * 0.14, s * 0.04);
      break; }
    case 'movie': {
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, W * 0.5, H);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.5); g.addColorStop(0, 'rgba(255,200,240,0.6)'); g.addColorStop(1, 'rgba(255,200,240,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W * 0.5, H);
      ctx.fillStyle = '#f8e8ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `300 ${s * 0.09}px ${F.mincho}`;
      [...'この恋は、渋谷で終わる'].forEach((c, i) => ctx.fillText(c, cx - s * 0.32, cy - s * 0.42 + i * s * 0.08));
      ctx.font = `400 ${s * 0.07}px ${F.mincho}`; ['神室 龍', '澤村 遥'].forEach((n, i) => ctx.fillText(n, cx + s * 0.1 + i * s * 0.2, cy + s * 0.36));
      break; }
    case 'bottle': {
      ctx.fillStyle = '#d9b45a'; ctx.fillRect(cx - s * 0.06, cy - s * 0.38, s * 0.12, s * 0.12);
      const g = ctx.createLinearGradient(cx - s * 0.2, 0, cx + s * 0.2, 0); g.addColorStop(0, '#7a5a1a'); g.addColorStop(0.5, '#f0d080'); g.addColorStop(1, '#7a5a1a'); ctx.fillStyle = g;
      rrect(ctx, cx - s * 0.2, cy - s * 0.26, s * 0.4, s * 0.6, s * 0.06); ctx.fill();
      ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `500 ${s * 0.22}px ${F.mincho}`; ctx.fillText('龍', cx, cy + s * 0.06);
      ctx.fillStyle = `rgba(255,255,255,${0.3 + 0.3 * Math.sin(t * 3)})`; ctx.fillRect(cx - s * 0.16, cy - s * 0.22, s * 0.04, s * 0.5);
      break; }
    case 'idol': {
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; for (let i = 0; i < 5; i++) { const px = cx + (i - 2) * s * 0.16, ph = s * (0.55 + (i % 2) * 0.08); ctx.beginPath(); ctx.arc(px, cy - ph * 0.28, s * 0.07, 0, Math.PI * 2); ctx.fill(); rrect(ctx, px - s * 0.07, cy - ph * 0.18, s * 0.14, ph * 0.55, s * 0.03); ctx.fill(); }
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.46); ctx.lineTo(cx + s * 0.1, cy - s * 0.3); ctx.lineTo(cx - s * 0.1, cy - s * 0.3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * Math.sin(t * 6)})`; for (let i = 0; i < 12; i++) { ctx.beginPath(); ctx.arc((i * 131 + t * 40) % W, (i * 71) % H, 3, 0, Math.PI * 2); ctx.fill(); }
      break; }
    case 'sky': { // sunset skyline seen from the deck
      const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0b1a3a'); g.addColorStop(0.55, '#c85a3a'); g.addColorStop(1, '#f2b45a'); ctx.fillStyle = g; ctx.fillRect(0, 0, W * 0.52, H);
      ctx.fillStyle = '#ffd9a0'; ctx.beginPath(); ctx.arc(cx + s * 0.1, cy + s * 0.05 + Math.sin(t * 0.4) * s * 0.02, s * 0.11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a1626'; for (let i = 0; i < 9; i++) { const bw = W * 0.06, bh = s * (0.2 + ((i * 37) % 5) * 0.08); ctx.fillRect(i * bw - s * 0.05, cy + s * 0.32 - bh, bw * 0.8, bh); }
      ctx.fillStyle = '#ffe9a0'; for (let i = 0; i < 40; i++) if (((i * 7 + Math.floor(t)) % 3) > 0) ctx.fillRect(((i * 53) % Math.floor(W * 0.5)), cy + s * 0.12 + ((i * 29) % 6) * s * 0.03, 2, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(0, cy + s * 0.34, W * 0.52, s * 0.02);
      break; }
    case 'phone': {
      ctx.translate(cx, cy); ctx.rotate(-0.15 + Math.sin(t) * 0.03);
      ctx.fillStyle = '#0a0a0c'; rrect(ctx, -s * 0.16, -s * 0.34, s * 0.32, s * 0.68, s * 0.05); ctx.fill();
      const g = ctx.createLinearGradient(0, -s * 0.3, 0, s * 0.3); g.addColorStop(0, '#3a8dff'); g.addColorStop(1, '#c04dff'); ctx.fillStyle = g; rrect(ctx, -s * 0.14, -s * 0.31, s * 0.28, s * 0.62, s * 0.04); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `900 ${s * 0.12}px ${F.helv}`; ctx.fillText('5G', 0, -s * 0.05); ctx.font = `600 ${s * 0.05}px ${F.gothic}`; ctx.fillText('つながる、はやい。', 0, s * 0.08);
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(-s * 0.13, -s * 0.28, s * 0.05, s * 0.56);
      break; }
  }
  ctx.restore();
}

export function makeLed({ w = 16, h = 10, ads = ADS, fps = 10, seed = 0, ticker = true, name = 'led' } = {}) {
  const W = w >= 12 ? 768 : 512, H = Math.max(96, Math.round(W * h / w));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: true });
  mat.color.setScalar(1.6);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.name = name;
  mesh.layers.enable(1);
  const state = { t: seed * 3.1, acc: 0, per: 7, tickerText: '渋谷町 ' + ['21:30', '21:31'][seed % 2] + '  18℃  小雨のち曇り   ▶  スクランブル交差点 本日の通行者 推定 280,000人   ▶  SHIBUYA46 新曲「スクランブル」配信中   ▶  サンシャインビール 今夜も、乾杯。   ▶  ' };
  const draw = (t) => {
    const k = (t / state.per) % ads.length;
    const idx = Math.floor(k), f = k - idx;
    const ad = ads[idx];
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, ad.bg[0]); g.addColorStop(1, ad.bg[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const sx = ((f * 1.6) - 0.3) * W;
    const sweep = ctx.createLinearGradient(sx - 160, 0, sx + 160, 0); sweep.addColorStop(0, 'rgba(255,255,255,0)'); sweep.addColorStop(0.5, 'rgba(255,255,255,0.14)'); sweep.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sweep; ctx.fillRect(0, 0, W, H);
    drawAdArt(ctx, ad, W, H, f, t);
    const ease = Math.min(1, f * 4); const e = 1 - Math.pow(1 - ease, 3);
    ctx.fillStyle = ad.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const family = ad.kind === 'movie' || ad.kind === 'bottle' ? F.mincho : ad.kind === 'idol' ? F.impact : ad.kind === 'can' ? F.helv : famFor(ad.title);
    const weight = ad.kind === 'movie' ? '400' : ad.kind === 'can' ? 'italic 900' : '900';
    const tx = W * 0.62;
    const ts = fit(ctx, ad.title, W * 0.6, H * 0.36, weight, family);
    ctx.font = `${weight} ${ts}px ${family}`;
    ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = ts * 0.15;
    ctx.fillText(ad.title, tx + (1 - e) * W * 0.5, H * 0.4);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = Math.max(0, Math.min(1, (f - 0.2) * 4));
    const ss = fit(ctx, ad.sub, W * 0.6, H * 0.12, '600', F.gothic);
    ctx.font = `600 ${ss}px ${F.gothic}`; ctx.fillText(ad.sub, tx, H * 0.64);
    if (f > 0.55) { ctx.fillStyle = ad.fg; ctx.globalAlpha = Math.min(1, (f - 0.55) * 6); const tag = ['NOW ON SALE', 'NEW', '期間限定', 'COMING SOON', '本日公開', 'LIMITED', '配信中', 'TICKETS', '受付中'][idx % 9]; ctx.font = `800 ${H * 0.07}px ${F.helv}`; const tw = ctx.measureText(tag).width + H * 0.08; ctx.fillRect(tx - tw / 2, H * 0.73, tw, H * 0.1); ctx.fillStyle = ad.bg[0]; ctx.fillText(tag, tx, H * 0.785); }
    ctx.globalAlpha = 1;
    if (ticker) {
      ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.fillRect(0, H * 0.9, W, H * 0.1);
      ctx.fillStyle = '#ffd400'; ctx.textAlign = 'left'; ctx.font = `600 ${H * 0.065}px ${F.gothic}`;
      const tw = ctx.measureText(state.tickerText).width; const off = (t * 90) % tw;
      ctx.fillText(state.tickerText, -off, H * 0.95); ctx.fillText(state.tickerText, tw - off, H * 0.95);
    }
    // LED pixel structure
    ctx.fillStyle = 'rgba(0,0,0,0.16)'; for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    const edge = Math.min(f * 8, (1 - f) * 8, 1);
    if (edge < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - edge})`; ctx.fillRect(0, 0, W, H); }
    tex.needsUpdate = true;
  };
  draw(state.t);
  mesh.userData.tick = (dt) => { state.t += dt; state.acc += dt; if (state.acc >= 1 / fps) { state.acc = 0; draw(state.t); } };
  signage.screens.push(mesh);
  return mesh;
}
export const makeLedScreen = makeLed;
// one-line scrolling LED (crown ticker / shop marquee)
export function makeLedTicker({ w = 30, h = 1.6, text = '渋谷町スクランブルスクエア ▶ SHIBUYA SKY 本日 10:00–22:30 ▶ 気温 18℃ 小雨 ▶ ', color = '#ffb020', bg = '#0a0806', fps = 12, speed = 120, font = null } = {}) {
  const W = 2048, H = Math.max(32, Math.round(W * h / w));
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex }); mat.color.setScalar(1.8);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); mesh.name = 'ticker'; mesh.layers.enable(1);
  const st = { t: 0, acc: 0 };
  const draw = (t) => {
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = `700 ${H * 0.72}px ${font || F.gothic}`;
    const tw = ctx.measureText(text).width; const off = (t * speed) % tw;
    ctx.fillText(text, -off, H * 0.52); ctx.fillText(text, tw - off, H * 0.52);
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1); for (let x = 0; x < W; x += 3) ctx.fillRect(x, 0, 1, H);
    tex.needsUpdate = true;
  };
  draw(0);
  mesh.userData.tick = (dt) => { st.t += dt; st.acc += dt; if (st.acc >= 1 / fps) { st.acc = 0; draw(st.t); } };
  signage.screens.push(mesh);
  return mesh;
}

// ------------------------------------------------------------------------------------------------ placement helpers
const Y_AXIS = new THREE.Vector3(0, 1, 0);
function makeRng(seed) {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.range = (lo, hi) => lo + (hi - lo) * r(); r.int = (lo, hi) => Math.floor(r.range(lo, hi + 1)); r.pick = (arr) => arr[Math.floor(r() * arr.length)]; r.chance = (p) => r() < p;
  return r;
}
const tangentOf = (n) => new THREE.Vector3(-n.z, 0, n.x);   // viewer's right when looking at the face from the street
const slots = new Set();
function claimSlot(x, z, y = 0) { const k = `${Math.round(x / 1.6)},${Math.round(y / 3)},${Math.round(z / 1.6)}`; if (slots.has(k)) return false; slots.add(k); return true; }
// landmark anchors: local to the builder group (109: drum centre; world-space builders: cityData pos, rotated by the group yaw)
function lmWorld(lm, v) { const w = v.clone(); const g = lm.group; if (g && g.rotation.y) w.applyAxisAngle(Y_AXIS, g.rotation.y); if (g && g.position.lengthSq() > 1e-6) w.add(g.position); else w.add(lm.position); return w; }
function lmDir(lm, v, fb) { const w = (v && v.isVector3 ? v : fb).clone(); const g = lm.group; if (g && g.rotation.y) w.applyAxisAngle(Y_AXIS, g.rotation.y); w.y = 0; return w.normalize(); }
function lmFaces(lm) { const d = lm.data || {}; const poly = d.polygon || rectPoly(lm.position.x, lm.position.z, lm.size.x, lm.size.z, d.rotY || 0); return polyFaces(poly); }
function alongPath(path, s) {
  let acc = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    if (acc + L >= s) { const k = (s - acc) / L; return { p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], t: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] }; }
    acc += L;
  }
  const a = path[path.length - 2], b = path[path.length - 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return { p: b, t: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] };
}
function pathLength(path) { let L = 0; for (let i = 0; i < path.length - 1; i++) L += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]); return L; }
function fillTenants(base, n, rng, off = 0) {
  const src = (base || []).filter(Boolean); const out = []; const seen = new Set();
  for (let i = 0; i < 60 && out.length < n; i++) {
    const t = i < src.length ? src[(i + off) % src.length] : rng.pick(POOL.upper);
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}
function pole(h, r = 0.045) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, h, 7), frameMat()); m.position.y = h / 2; m.userData.frame = true; return m; }
function stageAdd(obj, pos, facing) { place(obj, pos, facing, signage.stage); return obj; }
const NEON_FOR = { bar: ['#ff2d7a', '#ff3b3b', '#c86bff', '#ffb020'], karaoke: ['#ff2d7a', '#3ad7ff', '#ffb020'], cafe: ['#ffb020', '#ffffff', '#39ff88'], food: ['#ff3b3b', '#ffb020', '#ffffff'], amuse: ['#3ad7ff', '#c86bff', '#39ff88'], hotel: ['#ff7a1a', '#ffffff'] };
const ROOF_ADS = [
  { text: 'サンシャインビール', sub: '今夜も、乾杯。', bg: '#f2b705', fg: '#1a1208' }, { text: 'Tojo Cola', sub: 'ICE COLD', bg: '#c8102e', fg: '#ffffff', font: F.helv, weight: 'italic 900' },
  { text: 'アコン', sub: 'ご融資は当店へ ・ ATM 24H', bg: '#d7262b', fg: '#ffffff' }, { text: 'SHIBUYA46', sub: 'NEW SINGLE「スクランブル」', bg: '#ff2d7a', fg: '#ffffff', font: F.impact },
  { text: '純愛', sub: '映画 9.19 ROADSHOW', bg: '#2b1a3a', fg: '#f8e8ff', font: F.mincho, weight: '400' }, { text: '龍 PERFUME', sub: 'by KAMURO', bg: '#0a0a0a', fg: '#d9b45a', font: F.mincho, channel: true },
  { text: 'Bumblebee カラオケ', sub: '全室 24H ・ 学割 50% OFF', bg: '#111111', fg: '#ffd400' }, { text: 'ソフトバング 5G', sub: '月額 ¥1,980〜', bg: '#ffffff', fg: '#111111' },
  { text: 'ドン・キホーヂ', sub: '渋谷本店 24時間営業', bg: '#1c56b7', fg: '#ffe600' }, { text: 'プロミズ', sub: 'はじめてなら30日無利息', bg: '#ff6a00', fg: '#ffffff' },
  { text: 'ビッグカメラ', sub: '渋谷東口店 ・ ハチ公口店', bg: '#d7262b', fg: '#ffffff' }, { text: 'アイフリ', sub: 'ATM 24H', bg: '#1c56b7', fg: '#ffffff' },
  { text: 'カラオケ舘', sub: 'フリータイム ¥980', bg: '#ff2d7a', fg: '#ffffff' }, { text: 'TSUTAYU', sub: 'レンタル ・ 書籍 ・ 24H', bg: '#f7d100', fg: '#0b2a5a' },
  { text: 'SHIBUYA SKY', sub: '展望台 チケット発売中', bg: '#0b1a3a', fg: '#ffffff', channel: true }, { text: 'マツモトキヨヒ', sub: 'ドラッグ・コスメ', bg: '#ffe600', fg: '#1c56b7' },
];

// ------------------------------------------------------------------------------------------------ façade decoration
// hanging 袖看板 stack at one end of a face (side = ±1)
function stackAt(f, side, rng, { maxPlates = 8, minPlates = 3 } = {}) {
  const t = tangentOf(f.normal); const W = f.width, gf = f.groundFloorHeight || 4, h = f.height, st = Math.max(2, f.storeys || 2);
  const sh = st > 1 ? Math.max(2.6, (h - gf) / (st - 1)) : 3.3;
  const plateH = Math.min(1.05, Math.max(0.72, sh * 0.32)), gap = 0.1;
  const avail = h - 0.7 - (gf + 0.3);
  let n = Math.min(maxPlates, Math.floor(avail / (plateH + gap)));
  n = Math.min(n, st + rng.int(0, 2));
  if (n < minPlates) return false;
  const pos = f.position.clone().addScaledVector(t, side * (W / 2 - 0.62)).addScaledVector(f.normal, 0.02); pos.y = gf + 0.3;
  if (!claimSlot(pos.x, pos.z)) return false;
  const hash = strHash(f.id);
  const tenants = fillTenants(f.tenants, n, rng, hash % 5);
  const g = makeVerticalStack({ tenants, plateW: 0.9, plateH, gap, seed: hash % 7, firstFloor: 2, projection: 1.0 });
  stageAdd(g, pos, f.normal);
  return true;
}
// back-lit boxes over the upper-floor windows
function upperFascias(f, rng, maxFloors = 5) {
  const t = tangentOf(f.normal); const W = f.width, gf = f.groundFloorHeight || 4, h = f.height, st = f.storeys || 2;
  const sh = st > 1 ? (h - gf) / (st - 1) : 3.3;
  const tenants = fillTenants(f.tenants, 6, rng, strHash(f.id) % 3 + 1);
  const maxFl = Math.min(st, maxFloors);
  let k = 0, n = 0;
  for (let fl = 2; fl <= maxFl; fl++) {
    if (!rng.chance(fl === 2 ? 0.8 : 0.5)) continue;
    const name = tenants[k++ % tenants.length]; const cat = category(name);
    const room = W - 4.8; if (room < 2.5) continue;
    const w = Math.min(room, rng.range(3.5, 8.5));
    const hh = Math.min(1.5, sh * 0.42);
    const along = rng.range(-(room - w) / 2, (room - w) / 2);
    const y = gf + (fl - 2) * sh + sh * 0.52;
    if (y + hh / 2 > h - 0.4) break;
    const [bg, fg] = brandColors(name) || rng.pick(PALETTE);
    const channel = !brandColors(name) && rng.chance(0.3);
    const slogans = POOL.slogans[cat] || POOL.slogans.shop;
    const m = makeSign({ text: name, sub: rng.chance(0.65) ? rng.pick(slogans) : null, w, h: hh, bg, fg, channel, font: cat === 'bar' ? F.mincho : cat === 'clinic' ? F.maru : cat === 'amuse' ? F.impact : null, weight: cat === 'clinic' || cat === 'office' ? '600' : '800', tag: `${fl}F`, align: rng.chance(0.3) ? 'left' : 'center' });
    const pos = f.position.clone().addScaledVector(t, along).addScaledVector(f.normal, 0.1); pos.y = y;
    stageAdd(m, pos, f.normal); n++;
  }
  return n;
}
function neonOn(f, rng) {
  const t = tangentOf(f.normal); const W = f.width, gf = f.groundFloorHeight || 4, h = f.height, st = f.storeys || 2;
  const sh = st > 1 ? (h - gf) / (st - 1) : 3.3;
  const cands = (f.tenants || []).filter(n => /bar|karaoke|amuse|cafe|hotel/.test(category(n)));
  const name = cands.length ? rng.pick(cands) : rng.pick(POOL.amuse);
  const cat = category(name);
  const fl = Math.min(st, rng.int(2, 3));
  const w = Math.min(W - 5, rng.range(2.6, 4.2)); if (w < 2) return false;
  const along = rng.range(-(W / 2 - 2.6 - w / 2), W / 2 - 2.6 - w / 2);
  const y = gf + (fl - 2) * sh + sh * 0.5;
  const short = [...name].length > 8 ? name.split(/\s+/)[0] : name;
  const g = makeNeon({ text: short, sub: rng.chance(0.4) ? rng.pick(['OPEN', 'BAR', 'SNACK', '24H', 'KARAOKE', 'CLUB', 'LIVE']) : null, w, h: rng.range(0.9, 1.3), color: rng.pick(NEON_FOR[cat] || NEON_COLORS), border: rng.chance(0.5), font: cat === 'bar' ? rng.pick([F.script, F.mincho, F.helv]) : rng.pick([F.helv, F.impact, F.gothic]) });
  const pos = f.position.clone().addScaledVector(t, along).addScaledVector(f.normal, 0.12); pos.y = y;
  stageAdd(g, pos, f.normal);
  return true;
}
// low tenant buildings (Center-gai style): full-width tenant boards on every upper floor, 1–2 tenants side by side
function floorBands(f, rng) {
  const t = tangentOf(f.normal); const W = f.width, gf = f.groundFloorHeight || 4, h = f.height, st = f.storeys || 2;
  const sh = st > 1 ? (h - gf) / (st - 1) : 3.3;
  const tenants = fillTenants(f.tenants, 8, rng, strHash(f.id) % 4 + 2);
  let k = 0, n = 0;
  for (let fl = 2; fl <= Math.min(st, 6); fl++) {
    if (!rng.chance(0.8)) continue;
    const y = gf + (fl - 2) * sh + sh * 0.5; if (y + 0.8 > h - 0.3) break;
    const room = W - 2.6; if (room < 3) return n;
    const split = room > 9 && rng.chance(0.6) ? 2 : 1;
    const segW = (room - (split - 1) * 0.3) / split;
    for (let s = 0; s < split; s++) {
      const name = tenants[k++ % tenants.length]; const cat = category(name);
      const [bg, fg] = brandColors(name) || rng.pick(PALETTE);
      const slogans = POOL.slogans[cat] || POOL.slogans.shop;
      const m = makeSign({ text: name, sub: rng.chance(0.7) ? rng.pick(slogans) : null, w: segW, h: Math.min(1.7, sh * 0.5), bg, fg, channel: !brandColors(name) && rng.chance(0.25), font: cat === 'bar' ? F.mincho : cat === 'clinic' ? F.maru : cat === 'amuse' ? F.impact : null, weight: cat === 'clinic' || cat === 'office' ? '600' : '800', tag: `${fl}F`, align: split === 1 && rng.chance(0.35) ? 'left' : 'center' });
      const along = -room / 2 + segW / 2 + s * (segW + 0.3);
      const pos = f.position.clone().addScaledVector(t, along).addScaledVector(f.normal, 0.1); pos.y = y;
      stageAdd(m, pos, f.normal); n++;
    }
  }
  return n;
}
function decorateStreetFace(f, rng, isLandmark = false) {
  const W = f.width, st = f.storeys || 1;
  if (W < 5 || st < 2 || f.height < 6.5) return;
  const both = W >= 10 && !isLandmark;
  const first = rng.chance(0.5) ? 1 : -1;
  stackAt(f, first, rng, { minPlates: st <= 3 ? 2 : 3 });
  if (both && rng.chance(0.9)) stackAt(f, -first, rng, { minPlates: st <= 3 ? 2 : 3 });
  if (W >= 24 && !isLandmark) { // mid-face stack on long frontages
    const t = tangentOf(f.normal); const mid = { ...f, position: f.position.clone().addScaledVector(t, rng.range(-W * 0.12, W * 0.12)), width: 1.3, id: f.id + ':m' };
    stackAt(mid, 1, rng);
  }
  if (st <= 4 && !isLandmark) floorBands(f, rng);
  else if (!isLandmark || rng.chance(0.5)) { upperFascias(f, rng, isLandmark ? 3 : 6); if (W >= 16 && !isLandmark) upperFascias(f, rng, 6); }
  const ent = (f.tenants || []).some(n => /bar|karaoke|amuse/.test(category(n)));
  if (rng.chance(ent ? 0.85 : 0.4)) neonOn(f, rng);
  if (W >= 18 && rng.chance(0.35)) neonOn(f, rng);
}
function decorateAlleyFace(f, rng) {
  if (f.width < 8 || (f.storeys || 1) < 3) return;
  if (rng.chance(0.5)) stackAt(f, rng.chance(0.5) ? 1 : -1, rng, { maxPlates: 6 });
  if (rng.chance(0.3)) neonOn(f, rng);
  if (rng.chance(0.3)) upperFascias(f, rng, 3);
}
function decorateShop(f, rng) {
  const name = f.tenants && f.tenants[0]; if (!name) return;
  const cat = category(name); const t = tangentOf(f.normal); const W = f.width, gf = f.groundFloorHeight || 4;
  // projecting plate on the pier between shops (just above the fascia board)
  if (W >= 4 && rng.chance(0.55)) {
    const pos = f.position.clone().addScaledVector(t, W / 2 - 0.4); pos.y = gf + 0.02;
    if (claimSlot(pos.x, pos.z)) {
      const g = makeVerticalStack({ tenants: [name], plateW: 0.7, plateH: 0.8, floors: false, projection: 0.8, seed: strHash(name) % 5 });
      stageAdd(g, pos, f.normal);
    }
  }
  const foodish = /food|cafe|bar|karaoke|drug|amuse/.test(cat);
  if (foodish && rng.chance(0.42)) {
    const [txt, bg, fg] = rng.pick(POOL.flags);
    const g = makeFlag({ text: txt, bg, fg, band: rng.chance(0.4) ? '#ffffff' : null, w: 0.55, h: 1.7, font: rng.chance(0.4) ? F.mincho : null });
    const pos = f.position.clone().addScaledVector(t, rng.range(-W / 2 + 0.7, W / 2 - 0.7)).addScaledVector(f.normal, 0.55); pos.y = 0.15;
    stageAdd(g, pos, f.normal);
  }
  if (/food|cafe|bar/.test(cat) && rng.chance(0.45)) {
    const m = rng.pick(POOL.menus);
    const g = makeMenuBoard({ ...m, bg: cat === 'cafe' ? '#2a2420' : '#1c1a18' });
    const pos = f.position.clone().addScaledVector(t, rng.range(-W / 2 + 1.2, W / 2 - 1.2)).addScaledVector(f.normal, 0.75); pos.y = 0.15;
    stageAdd(g, pos, f.normal);
  }
  const pNeon = cat === 'bar' ? 0.75 : cat === 'karaoke' || cat === 'amuse' ? 0.5 : cat === 'cafe' || cat === 'food' ? 0.3 : 0.06;
  if (rng.chance(pNeon)) {
    const text = cat === 'bar' ? (rng.chance(0.5) ? name.replace(/^(BAR|Bar|バー|スナック)\s*/, '') : rng.pick(['BAR', 'OPEN', '酒', 'SNACK'])) : rng.pick(['OPEN', '24H', 'カラオケ', 'COFFEE', 'ラーメン', '営業中']);
    const g = makeNeon({ text, w: Math.min(W * 0.4, 2.2), h: 0.75, color: rng.pick(NEON_FOR[cat] || NEON_COLORS), border: rng.chance(0.35), font: cat === 'bar' ? rng.pick([F.script, F.helv]) : null });
    const pos = f.position.clone().addScaledVector(t, rng.range(-W * 0.28, W * 0.28)).addScaledVector(f.normal, 0.08); pos.y = 2.3;
    stageAdd(g, pos, f.normal);
  }
}
function rooftopBoard(b, rng, i) {
  const ad = ROOF_ADS[(i * 7 + strHash(b.buildingId || '') ) % ROOF_ADS.length];
  const w = Math.max(3, b.width - 0.3), h = Math.min(2.8, (b.height || 3) - 0.2);
  const m = makeSign({ text: ad.text, sub: ad.sub, w, h, bg: ad.bg, fg: ad.fg, font: ad.font, weight: ad.weight, channel: !!ad.channel, glow: 1.25 });
  stageAdd(m, b.position.clone().addScaledVector(b.normal, 0.03), b.normal);
}
// distance from (x,z) to the nearest pedestrian-street centre line minus its half width (<= 0 inside the street)
function pedestrianDist(city, x, z) {
  let best = Infinity;
  for (const s of (city.data && city.data.pedestrianStreets) || []) {
    const p = s.path; if (!p || p.length < 2) continue;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t) - (s.width || 5) / 2;
      if (d < best) best = d;
    }
  }
  return best;
}
function decorateFacades(city, rng) {
  const st = { stacks: 0, shops: 0, streets: 0, alleys: 0, boards: 0, promoted: 0 };
  for (const f of city.facades || []) {
    if (!f || !f.position || !f.normal) continue;
    if (f.kind === 'alley' && pedestrianDist(city, f.position.x + f.normal.x * 3, f.position.z + f.normal.z * 3) < 4) { decorateStreetFace(f, rng); st.promoted++; continue; }
    if (f.kind === 'shop') { decorateShop(f, rng); st.shops++; }
    else if (f.kind === 'street') { decorateStreetFace(f, rng); st.streets++; }
    else if (f.kind === 'alley') { decorateAlleyFace(f, rng); st.alleys++; }
    else if (f.kind === 'landmark' && TENANT_LANDMARKS.has(f.buildingId) && (f.tenants || []).length) { decorateStreetFace(f, rng, true); st.streets++; }
  }
  (city.billboards || []).forEach((b, i) => { if (b && b.position && b.normal) { rooftopBoard(b, rng, i); st.boards++; } });
  return st;
}
const TENANT_LANDMARKS = new Set(['ekimaeBldg', 'magnet', 'seibu', 'seibuB', 'loft', 'modi', 'parco', 'towerRecord', 'markCity', 'miyashitaPark', 'nonbei']);

// ------------------------------------------------------------------------------------------------ landmarks
function bigName(lm, o, rng) {
  // largest street-facing face toward the crossing (or o.dir) carries the name near the top + a 2F fascia
  const faces = lmFaces(lm);
  const d = o.dir || [-4 - lm.position.x, -2 - lm.position.z];
  const f = faceToward(faces, d[0], d[1], 8) || faces.slice().sort((a, b) => b.len - a.len)[0];
  if (!f) return;
  const H = lm.size.y;
  const w = Math.min(f.len * 0.7, o.w || 22), h = o.h || Math.min(5, Math.max(2.4, H * 0.06));
  const top = makeSign({ text: o.text, sub: o.sub, w, h, bg: o.bg, fg: o.fg, channel: o.channel, font: o.font, weight: o.weight || '900', glow: o.glow || 1.3 });
  stageAdd(top, onFace(f, 0, Math.min(H - h / 2 - 1.2, o.y || H - h / 2 - 1.5), 0.35), nOf(f));
  if (o.low !== false) {
    const gf = o.gf || 4.2;
    const low = makeSign({ text: o.text, sub: o.lowSub || o.sub, w: Math.min(f.len * 0.8, (o.w || 22) * 0.8), h: Math.min(2.2, gf * 0.4), bg: o.bg, fg: o.fg, channel: o.channel, font: o.font, weight: o.weight || '900', glow: 1.15 });
    stageAdd(low, onFace(f, 0, gf + 1.2, 0.3), nOf(f));
  }
  // a second copy on the other big street face so the name reads from two directions
  const f2 = faces.filter(x => x !== f && x.len >= 14).sort((a, b) => b.len - a.len)[0];
  if (f2 && o.second !== false) { const m2 = makeSign({ text: o.text, sub: o.sub, w: Math.min(f2.len * 0.7, o.w || 22), h, bg: o.bg, fg: o.fg, channel: o.channel, font: o.font, weight: o.weight || '900', glow: o.glow || 1.3 }); stageAdd(m2, onFace(f2, 0, Math.min(H - h / 2 - 1.2, o.y || H - h / 2 - 1.5), 0.35), nOf(f2)); }
  void rng;
}
function ledAt(pos, normal, w, h, seed, name, ads) {
  const m = makeLed({ w, h, seed, name, ads: ads || ADS });
  stageAdd(m, pos, normal);
  const frame = frameBox(w + 0.5, h + 0.5, 0.3); frame.position.copy(pos).addScaledVector(normal, -0.2); frame.lookAt(pos.clone().addScaledVector(normal, -0.2).add(normal)); signage.stage.add(frame);
  return m;
}
function landmarkSigns(city, rng) {
  const L = city.landmarks || {}; const out = { leds: 0, names: 0 };
  const rot = (deg) => [ADS.slice(deg), ADS.slice(0, deg)].flat();
  // Q-FRONT: Q's EYE + rooftop channel letters
  const q = L.qfront;
  if (q && q.anchors && q.anchors.screen) {
    const size = q.anchors.screenSize || [18.8, 11.2];
    ledAt(lmWorld(q, q.anchors.screen), lmDir(q, q.anchors.screenNormal, new THREE.Vector3(0.25, 0, 0.97)), size[0], size[1], 0, "Q's EYE"); out.leds++;
    if (q.anchors.roofSign) {
      const rs = q.anchors.roofSignSize || [17, 4.2];
      const m = makeSign({ text: 'Q-FRONT', w: rs[0], h: rs[1], channel: true, fg: '#ffffff', font: F.helv, weight: '900', glow: 1.25 });
      stageAdd(m, lmWorld(q, q.anchors.roofSign), lmDir(q, q.anchors.roofSignNormal, new THREE.Vector3(0.25, 0, 0.97))); out.names++;
    }
  }
  // SHIBUYA 1O9: forum vision + entrance ticker
  const s109 = L.shibuya109;
  if (s109 && s109.anchors && s109.anchors.screen) {
    const size = s109.anchors.screenSize || [9.6, 5.8];
    ledAt(lmWorld(s109, s109.anchors.screen), lmDir(s109, s109.anchors.screenNormal, new THREE.Vector3(1, 0, 0)), size[0], size[1], 3, '109フォーラムビジョン', rot(3)); out.leds++;
    if (s109.anchors.entrance) {
      const n = lmDir(s109, s109.anchors.screenNormal, new THREE.Vector3(1, 0, 0));
      const p = lmWorld(s109, s109.anchors.entrance); p.y += 0.9;
      const tk = makeLedTicker({ w: 9, h: 0.6, text: 'SHIBUYA 1O9 ▶ 本日 10:00–21:00 ▶ 新作 秋物 コレクション 入荷 ▶ 1O9 SUMMER SALE 最大 70% OFF ▶ ', color: '#ff4d6d', speed: 90 });
      stageAdd(tk, p, n);
    }
  }
  // MAGNET: corner LED
  const mg = L.magnet;
  if (mg && mg.anchors && mg.anchors.screen) { const size = mg.anchors.screenSize || [14, 10]; ledAt(lmWorld(mg, mg.anchors.screen), lmDir(mg, mg.anchors.screenNormal, new THREE.Vector3(-0.85, 0, 0.52)), size[0], size[1], 5, '109フォーラムビジョン', rot(5)); out.leds++; }
  // 渋谷駅前ビル: stacked DHC / グリコ screens
  const ek = L.ekimaeBldg;
  if (ek && ek.anchors && Array.isArray(ek.anchors.screens)) ek.anchors.screens.forEach((sc, i) => { ledAt(lmWorld(ek, sc.position), lmDir(ek, sc.normal, new THREE.Vector3(0.7, 0, -0.7)), sc.size[0], sc.size[1], 7 + i * 2, sc.name, rot(7 + i)); out.leds++; });
  // [city] pass 16: 道玄坂上交番前, the Gusto corner's roof screen (world anchor + steel frame from buildings/dogenzaka.js):
  // one small panel (512 px canvas), 5 fps, no ticker
  const dgs = city.corridor && city.corridor.anchors && city.corridor.anchors.screens;
  if (Array.isArray(dgs)) dgs.forEach((sc, i) => { stageAdd(makeLed({ w: sc.size[0], h: sc.size[1], seed: 11 + i, name: sc.name, ads: rot(11 + i), fps: 5, ticker: false }), sc.position, sc.normal); out.leds++; });
  // Scramble Square crown: SHIBUYA SKY letters + ticker (north + west faces)
  const ss = L.scrambleSquare;
  if (ss && ss.anchors && ss.anchors.crownSign) {
    const H = ss.size.y;
    for (const [a, n] of [[ss.anchors.crownSign, new THREE.Vector3(0, 0, -1)], [new THREE.Vector3(-ss.size.x / 2 - 0.4, H + 5, 0), new THREE.Vector3(-1, 0, 0)]]) {
      const p = lmWorld(ss, a), nn = lmDir(ss, n, n);
      const tk = makeLedTicker({ w: 30, h: 2.2, text: '渋谷町スクランブルスクエア ▶ SHIBUYA SKY 本日 10:00–22:30 ▶ 気温 18℃ 小雨のち曇り ▶ 14F チケットカウンター ▶ ', color: '#ffb020', speed: 110 });
      stageAdd(tk, p, nn);
      const sky = makeSign({ text: 'SHIBUYA SKY', w: 24, h: 5.5, channel: true, fg: '#ffffff', font: F.helv, weight: '900', glow: 1.15 });
      stageAdd(sky, p.clone().add(new THREE.Vector3(0, 4.6, 0)), nn); out.names++;
    }
  }
  // ヒカリエ
  const hk = L.hikarie;
  if (hk && hk.anchors && hk.anchors.sign) {
    for (const [a, n] of [[hk.anchors.sign, hk.anchors.signNormal || new THREE.Vector3(0, 0, -1)], [new THREE.Vector3(-hk.size.x / 2 - 0.3, hk.anchors.sign.y, 0), new THREE.Vector3(-1, 0, 0)]]) {
      const m = makeSign({ text: 'ヒカリエ', sub: 'SHIBUYA-CHO HIKARIE', w: 18, h: 4.2, channel: true, fg: '#ffffff', weight: '800', glow: 1.5 });
      stageAdd(m, lmWorld(hk, a), lmDir(hk, n, n)); out.names++;
    }
    bigName(hk, { text: 'ShinQs', sub: 'ヒカリエ 1F–5F', w: 14, h: 2.4, bg: '#ffffff', fg: '#c8102e', font: F.helv, low: false, y: 8.5, second: false }, rng);
  }
  // generic-massed landmarks: big names from NAMES.md
  const NAMES = {
    loft: { text: 'LOFTY', sub: 'ロフティ 渋谷町', bg: '#ffe600', fg: '#111111', font: F.helv, w: 18 },
    parco: { text: '渋谷PALCO', sub: 'SHIBUYA PALCO', bg: '#101010', fg: '#ffffff', font: F.helv, channel: true, w: 26 },
    modi: { text: 'MOD1', sub: '渋谷マルコ', bg: '#111111', fg: '#ffffff', font: F.helv, w: 14, h: 4.5 },
    towerRecord: { text: 'TOWER RECORD', sub: '渋谷 SHIBUYA-CHO', bg: '#ffe600', fg: '#d7262b', font: F.helv, w: 22, h: 4 },
    seibu: { text: '西部渋谷店', sub: 'SEIBO  A館', bg: '#ffffff', fg: '#0b2a5a', font: F.mincho, w: 20 },
    seibuB: { text: '西部渋谷店', sub: 'SEIBO  B館', bg: '#ffffff', fg: '#0b2a5a', font: F.mincho, w: 20 },
    markCity: { text: '渋谷マークシティ', sub: 'SHIBUYA MARK CITY', bg: '#101820', fg: '#ffffff', channel: true, w: 26, h: 4.5 },
    miyashitaPark: { text: 'MIYASHITA PARK', sub: '宮下パーク', bg: '#ffffff', fg: '#111111', font: F.helv, w: 24, h: 3 },
    nonbei: { text: 'のんべい横丁', sub: 'NONBEI YOKOCHO', bg: '#8a0a0a', fg: '#ffe9a0', font: F.mincho, w: 8, h: 1.4, low: false },
    udagawaKoban: { text: '交番', sub: '宇田川交番 KOBAN', bg: '#ffffff', fg: '#1c56b7', w: 4, h: 1.0, low: false },
  };
  for (const [key, o] of Object.entries(NAMES)) { const lm = L[key]; if (!lm || !lm.size) continue; bigName(lm, o, rng); out.names++; }
  // Center-gai gate lettering (both faces)
  const gate = (city.data && city.data.pedestrianStreets || []).find(p => p.id === 'centergai');
  if (gate && gate.gate) {
    const g = gate.gate; const d = dirOfRotY(g.rotY); const n = new THREE.Vector3(d[0], 0, d[1]);
    const c = new THREE.Vector3(g.pos[0], 0, g.pos[1]);
    const w = (g.width || 11) - 0.5, h = 1.8, y = (g.height || 9) - 2.2;
    const front = makePainted({ style: 'plate', w, h, key: 'centergai', bleed: '#e8306a', painter: (ctx, x, yy, W, H) => paintCenterGai(ctx, x, yy, W, H, { text: '渋谷センター街', sub: 'Basketball Street' }), glow: 1.4, ppm: 90 });
    stageAdd(front, c.clone().addScaledVector(n, 0.16).setY(y), n);
    const back = makePainted({ style: 'plate', w, h, key: 'centergai', bleed: '#e8306a', painter: () => {}, glow: 1.4, ppm: 90 });
    stageAdd(back, c.clone().addScaledVector(n, -0.16).setY(y), n.clone().negate());
    const t = tangentOf(n);
    const beam = frameBox(w + 0.6, 0.32, 0.32); beam.position.copy(c).setY(y + h / 2 + 0.25); beam.lookAt(beam.position.clone().add(n)); signage.stage.add(beam);
    const box = frameBox(w + 0.2, h + 0.1, 0.26); box.position.copy(c).setY(y); box.lookAt(box.position.clone().add(n)); signage.stage.add(box);
    for (const s of [-1, 1]) { const p = pole(y + h / 2 + 0.4, 0.14); p.position.copy(c).addScaledVector(t, s * (w / 2 + 0.25)); signage.stage.add(p); }
    const sub = makeSign({ text: 'SHIBUYA-CHO CENTER-GAI', w: 5, h: 0.5, bg: '#ffffff', fg: '#e8306a', font: F.helv, weight: '800', glow: 0.9 });
    stageAdd(sub, c.clone().addScaledVector(n, 0.17).setY(y - h / 2 - 0.4), n);
    signage.lights.push(makeLight(0xff4d8a, 1.4, 18, c.clone().addScaledVector(n, 1.5).setY(y - 1)));
    out.names++;
  }
  // spill lights for the two biggest screens
  if (q && q.anchors && q.anchors.screen) signage.lights.push(makeLight(0xbfd8ff, 2.2, 40, lmWorld(q, q.anchors.screen).addScaledVector(lmDir(q, q.anchors.screenNormal, new THREE.Vector3(0, 0, 1)), 4)));
  if (mg && mg.anchors && mg.anchors.screen) signage.lights.push(makeLight(0xffd0b0, 1.6, 30, lmWorld(mg, mg.anchors.screen).addScaledVector(lmDir(mg, mg.anchors.screenNormal, new THREE.Vector3(0, 0, 1)), 3)));
  return out;
}
function makeLight(color, intensity, distance, pos) { const l = new THREE.PointLight(color, intensity, distance, 1.6); l.position.copy(pos); l.userData.base = intensity; l.castShadow = false; return l; }

// ------------------------------------------------------------------------------------------------ street furniture signs
function streetPlates(city) {
  const NAMES = { dogenzaka_shita: ['道玄坂', 'Dogenzaka'], dogenzaka: ['道玄坂', 'Dogenzaka'], bunkamura: ['文化村通り', 'Bunkamura-dori'], koen: ['公園通り', 'Koen-dori'], meiji_ne: ['明治通り', 'Meiji-dori'], inokashira: ['井の頭通り', 'Inokashira-dori'], miyamasu: ['宮益坂', 'Miyamasu-zaka'], jingu_n: ['神宮通り', 'Jingu-dori'], ekimae_s: ['駅前通り', 'Ekimae-dori'] };
  let n = 0;
  for (const r of (city.data && city.data.roads) || []) {
    const nm = NAMES[r.id]; if (!nm || !r.path || r.path.length < 2) continue;
    const len = pathLength(r.path);
    const spots = len > 90 ? [28, len - 28] : [Math.min(24, len * 0.5)];
    for (const s of spots) {
      const { p, t } = alongPath(r.path, s);
      const off = (r.width || 12) / 2 + 1.1;
      for (const side of [1, -1]) {
        if (side < 0 && len < 90) continue;
        const px = p[0] + side * -t[1] * off, pz = p[1] + side * t[0] * off;
        const g = new THREE.Group(); g.name = 'streetPlate:' + nm[0];
        g.add(pole(3.5));
        const plate = makeStreetSign({ name: nm[0], romaji: nm[1], w: 1.4, h: 0.42 }); plate.position.set(0, 3.0, 0.03); g.add(plate);
        const back = makeStreetSign({ name: nm[0], romaji: nm[1], w: 1.4, h: 0.42 }); back.position.set(0, 3.0, -0.03); back.rotation.y = Math.PI; g.add(back);
        const facing = new THREE.Vector3(t[0], 0, t[1]);   // plate reads along the road
        stageAdd(g, new THREE.Vector3(px, 0.15, pz), facing); n++;
      }
    }
  }
  return n;
}
function cornerFurniture(city) {
  const C = (city.data && city.data.crossing) || {}; const centre = C.center || [-4, -2]; const corners = C.corners || {};
  const back = (c, d) => { const dx = c[0] - centre[0], dz = c[1] - centre[1], l = Math.hypot(dx, dz) || 1; return new THREE.Vector3(c[0] + dx / l * d, 0.15, c[1] + dz / l * d); };
  const toward = (c) => { const dx = centre[0] - c[0], dz = centre[1] - c[1], l = Math.hypot(dx, dz) || 1; return new THREE.Vector3(dx / l, 0, dz / l); };
  let n = 0;
  const totems = [['hachiko', '8'], ['magnet', '7'], ['ekimaeBldg', '3a'], ['sanzenri', '6']];
  for (const [k, exit] of totems) { const c = corners[k]; if (!c) continue; stageAdd(makeMetroTotem({ exit }), back(c, 3.2), toward(c)); n++; }
  const guides = [
    ['hachiko', [{ jp: 'ハチ公前広場', en: 'Hachiko Square', dir: 'right' }, { jp: '渋谷町駅 ハチ公口', en: 'Shibuya-cho Sta. Hachiko Exit', dir: 'right' }, { jp: 'センター街', en: 'Center-gai', dir: 'left' }]],
    ['sanzenri', [{ jp: 'センター街', en: 'Center-gai', dir: 'right' }, { jp: '道玄坂 ・ SHIBUYA 1O9', en: 'Dogenzaka', dir: 'left' }, { jp: '渋谷町駅', en: 'Shibuya-cho Sta.', dir: 'down' }]],
    ['qfront', [{ jp: '公園通り ・ 渋谷PALCO', en: 'Koen-dori / PALCO', dir: 'up' }, { jp: '宮下パーク', en: 'Miyashita Park', dir: 'right' }, { jp: 'ハチ公前広場', en: 'Hachiko Square', dir: 'down' }]],
  ];
  for (const [k, rows] of guides) {
    const c = corners[k]; if (!c) continue;
    const g = new THREE.Group(); g.add(pole(3.4, 0.05));
    const s = makeGuideSign({ rows, w: 1.7, h: 1.0 }); s.position.set(0, 2.7, 0.04); g.add(s);
    const p = back(c, 5.5); p.x += 1.5; stageAdd(g, p, toward(c)); n++;
  }
  // Hachiko square: JP pillar sign + 東急 / メトロ plates by the exit
  const st = city.landmarks && city.landmarks.station;
  if (st && st.anchors && st.anchors.gate) {
    const gp = lmWorld(st, st.anchors.gate), gn = lmDir(st, st.anchors.gateNormal, new THREE.Vector3(-1, 0, 0));
    const t = tangentOf(gn);
    const pil = new THREE.Group(); pil.add(pole(4.2, 0.07));
    const jp = makeStationSign({ kind: 'jp', w: 3.2, h: 0.7, text: '渋谷町駅', romaji: 'Shibuya-cho Sta.', right: 'ハチ公口', rightEn: 'Hachiko Exit' }); jp.position.set(0, 3.6, 0.06); pil.add(jp);
    const tk = makeStationSign({ kind: 'tokyu', w: 3.2, h: 0.7 }); tk.position.set(0, 2.8, 0.06); pil.add(tk);
    const mt = makeStationSign({ kind: 'metro', w: 3.2, h: 0.7 }); mt.position.set(0, 2.0, 0.06); pil.add(mt);
    stageAdd(pil, gp.clone().addScaledVector(gn, 6).addScaledVector(t, -6).setY(0.15), gn); n++;
  }
  return n;
}

// ------------------------------------------------------------------------------------------------ batching
function flushStage() {
  const stage = signage.stage;
  stage.updateMatrixWorld(true);
  const meshes = [], keep = [];
  stage.traverse(o => { if (!o.isMesh) return; if (o.userData.tick || o.userData.keep) keep.push(o); else meshes.push(o); });
  const buckets = new Map();
  for (const o of meshes) {
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const sign = !!o.userData.sign;
    if (sign) { if (!g.attributes.aGlow) setAttr(g, 'aGlow', 1); if (!g.attributes.aWave) setAttr(g, 'aWave', 0); }
    else { g.deleteAttribute('aGlow'); g.deleteAttribute('aWave'); }
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'aGlow', 'aWave'].includes(name)) g.deleteAttribute(name);
    if (!g.index) { /* mergeGeometries needs consistent indexing */ }
    // ONE mesh per material for the whole city, not one per 140 m cell. Measured (perf-walk, Retina, scramble):
    // the cell split made 368 meshes out of 30 materials, i.e. 94 draws in the main pass and 86 more in the wet
    // mirror — 30% of the frame's draw calls for ~110 k triangles. On ANGLE/Metal the per-draw cost in the GPU
    // process is what bounds the frame, not the vertices: drawing every sign quad in the city every frame is far
    // cheaper than the extra draws the cells cost, and the cell culling saved nothing but offscreen quads.
    const cell = 'all';
    const key = o.material.uuid + '|' + (g.index ? 'i' : 'n');
    let b = buckets.get(key); if (!b) { b = { material: o.material, geos: [], bloom: sign, cell }; buckets.set(key, b); }
    b.geos.push(g);
  }
  let created = 0;
  for (const b of buckets.values()) {
    const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (!merged) { console.warn('[signage] merge failed for', b.material.name); continue; }
    if (merged !== b.geos[0]) b.geos.forEach(g => g.dispose());
    const mesh = new THREE.Mesh(merged, b.material);
    mesh.name = 'signage:' + (b.material.name || 'mat') + ':' + b.cell;
    mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = true;
    if (b.bloom) mesh.layers.enable(1);
    signage.group.add(mesh); signage.meshes.push(mesh); created++;
  }
  for (const o of meshes) if (o.geometry) o.geometry.dispose();
  for (const s of keep) { s.updateMatrixWorld(true); const m = s.matrixWorld.clone(); s.removeFromParent(); m.decompose(s.position, s.quaternion, s.scale); signage.group.add(s); }
  stage.clear();
  signage.signs.length = 0; signage.halos.length = 0;
  return created;
}
function nightOf(engine) {
  const l = engine && engine.get && engine.get('lighting');
  if (l && typeof l.nightFactor === 'number') return l.nightFactor;
  const t = engine && engine.time; if (t && typeof t.night === 'number') return t.night;
  if (t && typeof t.hour === 'number') { const h = ((t.hour % 24) + 24) % 24; return h >= 19 || h <= 5 ? 1 : h >= 7 && h <= 17 ? 0 : h > 17 ? (h - 17) / 2 : 1 - (h - 5) / 2; }
  return 1;
}

// ------------------------------------------------------------------------------------------------ module
const signage = {
  name: 'signage',
  signs: [], halos: [], screens: [], lights: [], meshes: [],
  stage: new THREE.Group(), group: null, engine: null, stats: {}, _night: -1,
  makeSign, makeNeon, makeLed, makeLedScreen, makeLedTicker, makePainted, makeStreetSign, makeGuideSign, makeStationSign, makeMetroTotem, makeMenuBoard, makeFlag, makeVerticalStack, makeVendingFace, makeTaxiLamp, taxiLampKit, place, fonts: F,
  batch(obj) { this.stage.add(obj); return obj; },
  flush() { return flushStage(); },

  init(engine) {
    this.engine = engine;
    const t0 = performance.now();
    this.group = new THREE.Group(); this.group.name = 'signage';
    this.stage.name = 'signage:stage';
    engine.scene.add(this.group);
    const city = engine.get('city') || {};
    const rng = makeRng(0x5EED + (engine.params && engine.params.seed ? engine.params.seed : 0));
    let fac = { stacks: 0 }, lm = {}, plates = 0, corner = 0;
    try { fac = decorateFacades(city, rng); } catch (e) { console.error('[signage] facades failed', e); }
    try { lm = landmarkSigns(city, rng); } catch (e) { console.error('[signage] landmarks failed', e); }
    try { plates = streetPlates(city); } catch (e) { console.error('[signage] street plates failed', e); }
    try { corner = cornerFurniture(city); } catch (e) { console.error('[signage] corner furniture failed', e); }
    const signCount = this.signs.length, haloCount = this.halos.length;
    const meshes = flushStage();
    for (const l of this.lights) this.group.add(l);
    const pageList = Object.entries(pages).map(([k, v]) => `${k}×${v.length}`).join(' ');
    this.stats = { signs: signCount, halos: haloCount, screens: this.screens.length, meshes, pages: pageList, facades: (city.facades || []).length, ...fac, ...lm, plates, corner, ms: Math.round(performance.now() - t0) };
    this._night = -1; this.update(0, 0);
    if (SEAL_PX >= 256) engine.events.on('engine:ready', () => sealPages(SEAL_PX));
    console.info(`[signage] ${signCount} signs, ${haloCount} halos, ${this.screens.length} screens, ${plates} street plates, ${fac.boards || 0} rooftop boards, ${lm.names || 0} landmark names → ${meshes} merged meshes, pages ${pageList}, ${this.stats.ms} ms`);
  },

  update(dt, t) {
    uTime.value = t;
    const night = nightOf(this.engine);
    if (Math.abs(night - this._night) > 0.004) {
      this._night = night;
      for (const list of Object.values(pages)) for (const p of list) {
        if (p.style.kind === 'add') p.material.opacity = 0.12 + 0.88 * night;
        else p.material.emissiveIntensity = 0.28 + 0.92 * night;
      }
      for (const s of this.screens) if (s.material && s.material.color) s.material.color.setScalar(1.0 + 0.38 * night);
      for (const l of this.lights) l.intensity = (l.userData.base || 1) * night;
    }
    for (const s of this.screens) if (s.userData.tick) s.userData.tick(dt);
  },

  dispose() {
    if (this.group) this.group.removeFromParent();
    for (const m of this.meshes) m.geometry.dispose();
    this.meshes.length = 0; this.screens.length = 0; this.lights.length = 0;
  },
};
export default signage;

export const shotPresets = {
  signage_centergai_low: { pos: [-33, 1.7, -34], lookAt: [-70, 9, -66], t: 'night' },
  signage_qfront_close: { pos: [-10, 1.7, 0], lookAt: [-14, 16, -34], t: 'night' },
  signage_hachiko_exit: { pos: [8, 1.7, 30], lookAt: [45, 8, 30], t: 'night' },
  signage_dogenzaka: { pos: [-60, 1.7, 0], lookAt: [-150, 16, 12], t: 'night' },
  signage_day: { pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'day' },
  signage_crown: { pos: [137, 190, -110], lookAt: [137, 232, 119], t: 'night' },
  signage_qfront_roof: { pos: [16, 1.7, 16], lookAt: [-16, 34, -44], t: 'night' },
  signage_dogenzaka_wall: { pos: [-70, 1.7, -4], lookAt: [-120, 12, -30], t: 'night' },
};
export function selfTest(engine) {
  const s = signage.stats || {};
  const ok = (signage.meshes.length > 0) && signage.screens.length >= 3 && (s.signs || 0) > 200;
  return { ok, ...s, drawMeshes: signage.meshes.length, lights: signage.lights.length, engine: !!engine };
}
signage.shotPresets = shotPresets;
signage.selfTest = selfTest;
