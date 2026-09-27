// [mobile] Phone / tablet profile. main.js imports this FIRST, so it runs before any module has read location.search.
//   ?mobile=1  forces the mobile quality profile on a desktop     ?mobile=0  turns it off on a phone (auto on phones/tablets)
//   ?touch=1   forces the on-screen controls                      ?touch=0   hides them (auto on touch / coarse pointers)
//   ?tier=mobile|safe  picks the phone tier by hand (it is consumed: the choice is remembered, the switch leaves the URL)
// The quality profile is the game's own URL switches (docs/PLAY.md, docs/reports/mobile.md), written into the address
// with history.replaceState before any module reads them. A switch already in the URL wins, so every knob can still be
// A/B'd by hand (?mobile=1&peds=1). Switches this profile wrote on an earlier load are recognised and re-decided.
//
// Crash breadcrumbs (phones only): every boot stage — module imports, each module's init, atlases, precompile / warm-up,
// first frames, title, video, game start — is written to localStorage as it happens, with a small memory estimate.
// iOS kills a page that runs out of memory (or whose GPU work stalls) without any event; the next load then finds a boot
// that never finished, shows 「前回は『…』の途中で停止しました」 and starts in the lighter "safe" tier, with a button
// to retry the normal mobile tier. Leaving the page normally (pagehide / hidden) is not a crash.
import * as THREE from 'three';

const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
const mm = (s) => typeof matchMedia === 'function' && matchMedia(s).matches;
const nav = typeof navigator !== 'undefined' ? navigator : {};
const ua = nav.userAgent || '';
const iPadOS = /Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1;       // iPadOS asks for the desktop site
const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua) || iPadOS;
const coarse = mm('(pointer: coarse)');
const auto = mobileUA || (coarse && mm('(hover: none)'));

export const MOBILE = q.get('mobile') === '1' || (q.get('mobile') !== '0' && auto);
export const TOUCH = q.get('touch') === '1' || (q.get('touch') !== '0' && (auto || coarse));

const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode / full */ } },
};
const K_BOOT = 'shibuya.boot.v1', K_PROFILE = 'shibuya.profile.v1';

// what a phone gets (docs/reports/mobile.md has the measurements behind each one)
//   peds / cars      crowd and traffic (1 = 1,740 people / 150 cars)
//   scanPool         rigged pedestrian bodies bound near the lens at once (desktop 32)
//   scanPer          of those, built per person at boot (desktop 3; the rest are built on demand)
//   scanMid          metres inside which a pedestrian uses the textured lod1 (desktop 20)
//   pedScans         how many of the 24 passer-by scans are downloaded (the story's own always are)
//   pool             street lights in every lit shader's loop (desktop 28)
//   msaa / postfx    no MSAA on the scene target; the post chain's cheapest tier (no AO, FXAA)
//   texmax           largest texture edge on the GPU; a bigger procedural canvas is redrawn at that size as soon as its
//                    texture is made (lib.canvasTex / materials.canvasTexture) and the full-size canvas is let go
//   canvasK          the incrementally painted atlases (signage pages, landmark signs, fascia names) are painted at this scale
//   scanTex / pedTex / heroTex   the scanned characters' maps are decoded at most this size (enemies & cast / passers-by / hero)
//   shadow           the near shadow cascade's map (the far one is half; 0 = no shadows at all)
//   shadowEvery      the near cascade re-renders every n-th frame (desktop every frame)
//   mirror           the wet-road reflection pass (0 = off; 0.25 = a quarter-res mirror)
//   audio            'lite': a 22 kHz audio context and two of the four battle-music stems (decoded audio is float32)
//   vatK / vatClips  the crowd's vertex-animation bake: frames per clip scaled, and only these clips (the rest fall back)
//   matTex           (safe) the procedural material sets are generated at this size (1024 as authored)
export const TIERS = {
  mobile: {
    peds: '0.4', cars: '70', scanPool: '6', scanPer: '1', scanMid: '12', pedScans: '12', pool: '12', msaa: '0', postfx: 'q0',
    texmax: '384', canvasK: '0.5', scanTex: '512', pedTex: '256', heroTex: '1024', shadow: '1024', shadowEvery: '2', mirror: '0', audio: 'lite',
    vatK: '0.5', vatClips: 'walk,idle,run',
  },
  // after a boot that never finished: everything lighter again, no shadows, no shop interiors, a fixed 0.75 render ratio
  safe: {
    peds: '0.2', cars: '30', scanPool: '3', scanPer: '1', scanMid: '8', pedScans: '6', pool: '6', msaa: '0', postfx: 'q0',
    texmax: '256', canvasK: '0.25', scanTex: '256', pedTex: '128', heroTex: '512', shadow: '0', mirror: '0', audio: 'lite',
    interiors: '0', res: '0.75', vatK: '0.34', vatClips: 'walk,idle', matTex: '512',
  },
};
export const MOBILE_DEFAULTS = TIERS.mobile;

// ---- the previous boot: did it finish?
const prevBoot = MOBILE ? LS.get(K_BOOT) : null;
const CRASHED = !!(prevBoot && prevBoot.state === 'running' && Date.now() - (prevBoot.at || 0) < 7 * 864e5);
const prevProfile = LS.get(K_PROFILE) || {};

// ---- tier + URL
const injected = {};
let TIER = 'desktop';
if (MOBILE && typeof history !== 'undefined' && history.replaceState) {
  // switches an earlier load of this profile wrote (still in the address) are ours to re-decide, not the user's
  if (prevProfile.params) for (const [k, v] of Object.entries(prevProfile.params)) if (q.get(k) === v) q.delete(k);
  const asked = q.get('tier');
  q.delete('tier');
  let sticky = prevProfile.sticky || null;
  if (asked === 'mobile' || asked === 'safe') sticky = asked === 'safe' ? 'safe' : null;
  else if (CRASHED) sticky = 'safe';
  TIER = asked === 'mobile' ? 'mobile' : sticky === 'safe' ? 'safe' : 'mobile';
  for (const [k, v] of Object.entries(TIERS[TIER])) if (!q.has(k)) { q.set(k, v); injected[k] = v; }
  LS.set(K_PROFILE, { tier: TIER, sticky, params: injected });
  const s = q.toString();
  try { history.replaceState(history.state, '', location.pathname + (s ? '?' + s : '') + location.hash); }
  catch (e) { console.warn('[mobile] could not apply the profile to the URL', e); }
}
export { TIER };
const P = (k) => q.get(k);
// the procedural-canvas caps other modules read (0 = off: desktop)
export const TEX_MAX = Number(P('texmax')) >= 64 ? Number(P('texmax')) | 0 : 0;
export const CANVAS_K = Number(P('canvasK')) > 0 && Number(P('canvasK')) < 1 ? Number(P('canvasK')) : 1;

if (typeof document !== 'undefined') {
  const c = document.documentElement.classList;
  if (MOBILE) c.add('is-mobile');
  if (TOUCH) c.add('is-touch');
}

// ---------------------------------------------------------------- breadcrumbs + a small memory estimate (phones only)
const T0 = typeof performance !== 'undefined' ? performance.now() : 0;
const mem = { canvases: [], gpu: 0, audio: 0 };
const crumbs = { stage: 'start', trail: [], frames: 0, longest: 0, longestAt: '', mods: '', fetch: '' };
function memNow() {
  let cv = 0;
  for (let i = mem.canvases.length - 1; i >= 0; i--) { const c = mem.canvases[i].deref(); if (!c) { mem.canvases.splice(i, 1); continue; } cv += c.width * c.height * 4; }
  const pm = typeof performance !== 'undefined' && performance.memory;
  const r = (b) => Math.round(b / 1048576);
  return { cv: r(cv), gpu: r(mem.gpu), au: r(mem.audio), heap: pm ? r(pm.usedJSHeapSize) : null };
}
let lastWrite = 0;
function writeBoot(state = 'running') {
  lastWrite = performance.now();
  LS.set(K_BOOT, { v: 1, state, stage: crumbs.stage, t: Math.round((performance.now() - T0) / 100) / 10, at: Date.now(), tier: TIER, mem: memNow(),
    mods: crumbs.mods, frames: crumbs.frames, longest: Math.round(crumbs.longest), longestAt: crumbs.longestAt, fetch: crumbs.fetch,
    trail: crumbs.trail.slice(-10), ua: (ua.match(/(iPhone|iPad|Android)[^;)]*|OS [\d_]+|Version\/[\d.]+|Chrome\/\d+/g) || []).join(' ') });
}
// a boot stage: written at once (the next thing may be the page being killed)
export function crumb(stage, detail) {
  if (!MOBILE) return;
  const s = detail ? `${stage} ${detail}` : stage;
  if (s === crumbs.stage) return;
  crumbs.stage = s;
  if (typeof window !== 'undefined') window.__bootStage = s;
  crumbs.trail.push(`${((performance.now() - T0) / 1000).toFixed(1)} ${s}`);
  if (crumbs.trail.length > 40) crumbs.trail.shift();
  writeBoot();
}
if (MOBILE && typeof window !== 'undefined') {
  // canvases (the procedural atlases are the prime suspect for the memory peak)
  if (typeof WeakRef === 'function') {
    const ce = Document.prototype.createElement;
    Document.prototype.createElement = function (tag, o) { const el = ce.call(this, tag, o); if (el instanceof HTMLCanvasElement) mem.canvases.push(new WeakRef(el)); return el; };
  }
  // GPU bytes asked for (allocations, not frees: an upper bound), and the uploads' count per frame
  const G = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  const bpp = (f) => (f === 0x881A ? 8 : f === 0x8814 ? 16 : f === 0x8229 ? 1 : f === 0x822B ? 2 : 4);
  const wrap = (name, fn) => { const o = G && G[name]; if (o) G[name] = function (...a) { try { fn(...a); } catch (e) { /* */ } return o.apply(this, a); }; };
  wrap('texStorage2D', (t, lv, f, w, h) => { let n = 0; for (let l = 0; l < lv; l++) n += Math.max(1, w >> l) * Math.max(1, h >> l); mem.gpu += n * bpp(f) * (t === 0x8513 ? 6 : 1); });
  wrap('texStorage3D', (t, lv, f, w, h, d) => { mem.gpu += w * h * d * bpp(f) * 1.34; });
  wrap('bufferData', (t, d) => { mem.gpu += typeof d === 'number' ? d : (d && d.byteLength) || 0; });
  const A = window.BaseAudioContext || window.AudioContext;
  if (A && A.prototype.decodeAudioData) {
    const dec = A.prototype.decodeAudioData;
    A.prototype.decodeAudioData = function (data, ok, err) {
      const add = (b) => { if (b && b.length) mem.audio += b.length * b.numberOfChannels * 4; return b; };
      const p = dec.call(this, data, ok ? (b) => ok(add(b)) : undefined, err);
      return p && p.then ? p.then((b) => (ok ? b : add(b))) : p;
    };
  }
  // the last asset asked for (which group was loading when it died)
  const f0 = window.fetch;
  if (f0) window.fetch = function (u, ...a) { try { crumbs.fetch = String(u && u.url || u).replace(/^.*?\/(assets|src)\//, '$1/'); } catch (e) { /* */ } return f0.call(this, u, ...a); };
  window.addEventListener('pagehide', () => writeBoot('left'));
  document.addEventListener('visibilitychange', () => writeBoot(document.hidden ? 'left' : 'running'));
  window.addEventListener('error', (e) => { crumbs.trail.push('error ' + String(e && e.message).slice(0, 80)); writeBoot(); });
  setInterval(() => { if (!document.hidden && performance.now() - lastWrite > 900) writeBoot(); }, 1000);
  crumb('script', 'profile');
}

// ---------------------------------------------------------------- the notice after a crash
const STAGE_JA = [
  [/^script/, 'スクリプト読み込み'], [/^import/, 'モジュール読み込み'], [/^init:(\w+)/, (m) => `初期化: ${m[1]}`], [/^atlas/, '看板・壁のテクスチャ作成'],
  [/^warm:tex/, 'テクスチャ転送'], [/^warm:prog/, 'シェーダー準備'], [/^precompile/, 'シェーダー準備'], [/^frame/, '最初の描画'], [/^ready/, '読み込み完了'],
  [/^crowd/, '群衆の準備（歩行者の読み込み・アニメーション焼き込み）'], [/^title/, 'タイトル画面'], [/^video/, 'オープニング動画'], [/^arrival/, '渋谷への降下'], [/^play/, 'プレイ中'],
];
const stageJa = (s) => { for (const [re, l] of STAGE_JA) { const m = String(s).match(re); if (m) return typeof l === 'function' ? l(m) : l; } return s; };
function showCrashNotice() {
  const b = prevBoot, m = b.mem || {};
  const el = document.createElement('div');
  el.id = 'crash-notice';
  el.setAttribute('role', 'alert');
  el.style.cssText = 'position:fixed;left:50%;top:calc(10px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:400;width:min(560px,calc(100vw - 24px));box-sizing:border-box;' +
    'padding:12px 16px 10px;background:#101114f2;border:1px solid #d9b45a;border-top-width:3px;color:#f3e6c4;font:13px/1.55 "Hiragino Sans","Noto Sans JP",sans-serif;box-shadow:0 8px 30px #000c';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const trail = (b.trail || []).slice(-4).map(esc).join(' → ');
  el.innerHTML = `<div style="font-weight:800;font-size:15px;color:#fff">前回は『${esc(stageJa(b.stage))}』の途中で停止しました</div>` +
    `<div style="color:#cfc2a2">段階 <b>${esc(b.stage)}</b> · ${esc(b.t)}秒 · モジュール ${esc(b.mods || '-')} · 描画 ${esc(b.frames || 0)}フレーム · 最長 ${esc(b.longest || 0)}ms${b.longestAt ? ' (' + esc(b.longestAt) + ')' : ''}</div>` +
    `<div style="color:#cfc2a2">メモリ推定: canvas ${esc(m.cv ?? '-')}MB · GPU ${esc(m.gpu ?? '-')}MB · 音声 ${esc(m.au ?? '-')}MB${m.heap != null ? ' · JS ' + esc(m.heap) + 'MB' : ''} · 設定 ${esc(b.tier || '-')}</div>` +
    (b.fetch ? `<div style="color:#8f887a;font-size:11px">最後の読み込み: ${esc(b.fetch)}</div>` : '') +
    (trail ? `<div style="color:#8f887a;font-size:11px">${trail}</div>` : '') +
    `<div style="margin-top:6px">${TIER === 'safe' ? '今回は<b>セーフモード</b>（さらに軽い設定）で起動します。' : '今回は通常のモバイル設定で起動します。'}</div>` +
    `<div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">` +
    (TIER === 'safe' ? '<button data-a="retry" style="padding:9px 14px;background:#d9b45a;color:#100d06;border:0;font-weight:700">通常のモバイル設定で再試行</button>' : '<button data-a="safe" style="padding:9px 14px;background:#d9b45a;color:#100d06;border:0;font-weight:700">セーフモードで起動</button>') +
    '<button data-a="close" style="padding:9px 14px;background:transparent;color:#f3e6c4;border:1px solid #6e5c3e">閉じる</button></div>' +
    `<div style="color:#6f6a5e;font-size:10px;margin-top:4px">${esc(b.ua || '')} · ${new Date(b.at).toLocaleString('ja-JP')}</div>`;
  el.addEventListener('click', (e) => {
    const a = e.target && e.target.dataset && e.target.dataset.a;
    if (a === 'close') el.remove();
    else if (a === 'retry' || a === 'safe') { LS.set(K_BOOT, null); location.replace(location.pathname + '?tier=' + (a === 'retry' ? 'mobile' : 'safe')); }
  });
  for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart']) el.addEventListener(t, (e) => e.stopPropagation());
  document.body.appendChild(el);
}
if (MOBILE && CRASHED && typeof document !== 'undefined' && document.body) {
  try { showCrashNotice(); } catch (e) { console.warn('[mobile] crash notice', e); }
  console.warn(`[mobile] the previous boot stopped at "${prevBoot.stage}" (${prevBoot.t} s, tier ${prevBoot.tier}) -> tier ${TIER}`);
}

// ---------------------------------------------------------------- engine hooks (main.js calls this once the engine exists)
export function attachBreadcrumbs(engine) {
  if (!MOBILE || !engine) return;
  engine.events.on('boot:progress', ({ i, n, name }) => { crumbs.mods = `${i}/${n}`; crumb(name ? 'init:' + name : 'init:done'); });
  engine.events.on('precompile:start', (d) => crumb('precompile', d || ''));
  engine.events.on('precompile:end', () => crumb('precompile:end'));
  engine.events.on('warm', (d) => crumb('warm:' + d));
  engine.events.on('engine:ready', () => crumb('ready'));
  let last = 0, n = 0;
  engine.events.on('engine:booted', () => {
    crumb('frame', '1');
    const tick = (now) => {
      n++; crumbs.frames = n;
      if (last) { const dt = now - last; if (dt > crumbs.longest) { crumbs.longest = dt; crumbs.longestAt = `frame ${n} ${crumbs.stage}`; } }
      last = now;
      if (n <= 6) crumb('frame', String(n + 1));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  installWarmup(engine);
  // the coarse stages the player sees
  let playT = 0;
  setInterval(() => {
    const s = engine.state || {}, b = document.body.classList;
    if (s.videoPlaying) crumb('video');
    else if (s.arrival) crumb('arrival');
    else if (b.contains('front-open')) crumb('title');
    else if (engine.booted && crumbs.stage !== 'start' && (s.mode === 'explore' || s.mode === 'combat' || s.mode === 'cutscene') && !engine.params?.shot) {
      playT += 0.5; crumb('play', playT < 30 ? '' : playT < 120 ? '30s+' : '2min+');
    }
  }, 500);
}

// ---------------------------------------------------------------- warm-up in slices (phones)
// On a desktop the whole scene is drawn from the first frame and precompiled at frame 4 (engine.js). On a phone that first
// frame would upload every texture and compile ~190 programs in one go — seconds of GPU work in a single command buffer,
// the kind of frame WebKit's GPU watchdog kills. Instead nothing is drawn while an opaque screen covers the canvas (the
// loading screen, the title, the opening video), and each frame uploads textures / compiles programs for at most ~25 ms.
function installWarmup(engine) {
  if (q.get('warm') === '0') return;                 // ?warm=0: draw from the first frame, as a desktop does (A/B)
  const r = engine.renderer, BUDGET = 25;
  let tex = null, ti = 0, objs = null, oi = 0, done = false, lastPct = -1;
  const W = window.__warm = { tex: 0, texN: 0, prog: 0, progN: 0, done: false, firstDrawMs: null };
  const say = (what, i, n) => { const pct = n ? Math.floor((i / n) * 4) * 25 : 100; if (pct !== lastPct || what !== say.w) { lastPct = pct; say.w = what; engine.events.emit('warm', `${what} ${i}/${n}`); } };
  const covered = () => {
    const b = document.body.classList, s = engine.state || {};
    return !!(document.getElementById('boot') || b.contains('front-open') || b.contains('train-playing') || s.videoPlaying);
  };
  const variant = (o) => (o.isInstancedMesh ? 1 : 0) | (o.instanceColor ? 2 : 0) | (o.isSkinnedMesh ? 4 : 0) | (o.morphTargetInfluences ? 8 : 0);
  const collect = () => {
    const T = new Set(), seen = new Set(), O = [];
    engine.scene.traverseVisible((o) => {
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      if (!ms.length) return;
      for (const m of ms) for (const k in m) { const t = m[k]; if (t && t.isTexture && !t.isRenderTargetTexture && !t.isVideoTexture && t.image) T.add(t); }
      const key = ms.map((m) => m.uuid).join(',') + ':' + variant(o);
      if (!seen.has(key)) { seen.add(key); O.push(o); }
    });
    return [[...T], O];
  };
  const step = () => {
    const t0 = performance.now();
    if (!tex) { [tex, objs] = collect(); ti = oi = 0; }
    while (ti < tex.length && performance.now() - t0 < BUDGET) { try { r.initTexture(tex[ti]); } catch (e) { /* not uploadable yet */ } ti++; }
    W.tex = ti; W.texN = tex.length; W.progN = objs.length;
    if (ti < tex.length) { say('tex', ti, tex.length); return; }
    const pf = engine.get('postfx'), rt = pf && pf.sceneRT && pf.enabled !== false && !pf.bypass ? pf.sceneRT : null, prev = r.getRenderTarget();
    try {
      r.setRenderTarget(rt);                              // the scene target's variant (tone mapping / colour space are program parameters)
      while (oi < objs.length && performance.now() - t0 < BUDGET) { try { r.compile(objs[oi], engine.camera, engine.scene); } catch (e) { /* */ } oi++; }
      W.prog = oi;
    } finally { r.setRenderTarget(prev); }
    if (oi < objs.length) { say('prog', oi, objs.length); return; }
    // the post chain's own shaders (full-screen passes are not in the scene), against the chain's HalfFloat target
    if (!post) {
      post = [];
      const seen = new Set(), add = (m) => { if (m && m.isMaterial && !seen.has(m)) { seen.add(m); post.push(m); } };
      for (const ps of (pf && pf.composer && pf.composer.passes) || []) {
        if (!ps || ps.enabled === false) continue;
        for (const k of Object.keys(ps)) { const v = ps[k]; if (Array.isArray(v)) v.forEach(add); else if (v && v.isMaterial) add(v); else if (v && v.material && v.material.isMaterial) add(v.material); }
      }
      quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); pi = 0;
    }
    if (pi < post.length) {
      const prev2 = r.getRenderTarget();
      try {
        r.setRenderTarget(pf && pf.composer ? pf.composer.renderTarget1 : null);
        while (pi < post.length && performance.now() - t0 < BUDGET) { quad.material = post[pi]; try { r.compile(quad, engine.camera); } catch (e) { /* */ } pi++; }
      } finally { r.setRenderTarget(prev2); }
      say('post', pi, post.length); return;
    }
    // last: one whole frame drawn while still covered — shadow maps, the remaining variants and the vertex buffers go
    // up here, behind the title, instead of in the first frame the player sees
    if (!drawn) { drawn = true; drawNow = true; say('draw', 1, 1); return; }
    done = true; W.done = true; engine.events.emit('warm', `done ${tex.length} tex / ${objs.length} objects / ${post.length} post`);
  };
  let post = null, pi = 0, quad = null, drawn = false, drawNow = false;
  engine.skipRender = (frame) => {
    if (engine.params && engine.params.shot) return false;
    if (drawNow) { drawNow = false; return false; }
    if (!done && frame >= 4 && covered()) { try { step(); } catch (e) { done = true; console.warn('[mobile] warm-up', e); } }
    if (drawNow) { drawNow = false; return false; }
    return covered();
  };
}

// ---------------------------------------------------------------- procedural canvases at phone size
// lib.canvasTex / materials.canvasTexture call this on the texture they just made from a finished canvas. On a phone
// (?texmax) a canvas bigger than the cap is redrawn into a capped copy that becomes the texture's image, and the big one
// is shrunk to 1 x 1 — its memory goes at once, inside the module's init, instead of piling up (city + signage + materials
// held ~1.2 GB of canvases at the boot's peak). The GPU never saw more than the cap anyway (engine.js). A texture whose
// canvas is still being painted (an atlas) must not come through here.
let _fitted = 0;
export function fitCanvasTexture(t, name = '') {
  if (!TEX_MAX || !t || !t.image) return t;
  const c = t.image;
  if (typeof HTMLCanvasElement === 'undefined' || !(c instanceof HTMLCanvasElement)) return t;
  const m = Math.max(c.width, c.height);
  if (m <= TEX_MAX) return t;
  const k = TEX_MAX / m, w = Math.max(1, Math.round(c.width * k)), h = Math.max(1, Math.round(c.height * k));
  const s = document.createElement('canvas'); s.width = w; s.height = h;
  const g = s.getContext('2d');
  if (!g) return t;
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, w, h);
  t.image = s; t.needsUpdate = true;
  c.width = c.height = 1;                         // (1, not 0: a later drawImage from it must not throw)
  if (++_fitted % 8 === 1) crumb('atlas', `${_fitted} ${name}`.trim());
  return t;
}

// ?texmax: once the game is up, a big canvas texture that stayed unchanged for a few seconds is handed to the GPU as a
// bitmap at the capped size, so the texture no longer pins its full-size canvas (the sweep for canvases that did not
// come through fitCanvasTexture). If its owner draws into the canvas again later (the texture's version moves), the
// canvas is put back — as long as the owner still holds it, which it must to draw into it. Signage seals its own pages.
export function compactCanvasTextures(engine, maxPx, { wait = 4000, minArea = 1 << 20 } = {}) {
  if (typeof createImageBitmap !== 'function' || typeof WeakRef !== 'function') return;
  const found = new Map();
  engine.scene.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      for (const k in m) {
        const t = m[k];
        if (!t || !t.isTexture || t.isRenderTargetTexture || found.has(t)) continue;
        const c = t.image;
        if (typeof HTMLCanvasElement === 'undefined' || !(c instanceof HTMLCanvasElement) || c.width * c.height < minArea || Math.max(c.width, c.height) <= maxPx) continue;
        found.set(t, { c, v: t.version });
      }
    }
  });
  const live = [], stats = { candidates: found.size, converted: 0, freedPx: 0, restored: 0 };
  engine.canvasCompaction = stats;
  setTimeout(async () => {
    const done = new Set();
    for (const [t, f] of found) {
      const c = f.c;
      if (t.version !== f.v || t.image !== c || done.has(c) || !c.width) continue;   // changed while watched: a live texture
      const k = maxPx / Math.max(c.width, c.height), w = Math.max(1, Math.round(c.width * k)), h = Math.max(1, Math.round(c.height * k));
      let bmp = null;
      try { bmp = await createImageBitmap(c, { imageOrientation: t.flipY ? 'flipY' : 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none', resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }); }
      catch (e) { continue; }
      if (t.version !== f.v || t.image !== c || bmp.width !== w) { bmp.close(); continue; }
      done.add(c);
      const flip = t.flipY;
      t.image = bmp; t.flipY = false; t.needsUpdate = true;       // (a bitmap carries its orientation: flipped above)
      live.push({ t, ref: new WeakRef(c), v: t.version, flip, bmp });
      stats.converted++; stats.freedPx += c.width * c.height;
    }
    if (!live.length) return;
    const iv = setInterval(() => {
      for (let i = live.length - 1; i >= 0; i--) {
        const L = live[i];
        if (L.t.version === L.v && L.t.image === L.bmp) continue;
        live.splice(i, 1);
        const c = L.ref.deref();
        if (L.t.image === L.bmp && c && c.width) { L.t.image = c; L.t.flipY = L.flip; L.t.needsUpdate = true; stats.restored++; }
      }
      if (!live.length) clearInterval(iv);
    }, 500);
  }, wait);
}
export const profile = { mobile: MOBILE, touch: TOUCH, tier: TIER, crashed: CRASHED ? { stage: prevBoot.stage, t: prevBoot.t, tier: prevBoot.tier } : null, injected };
if (typeof window !== 'undefined') window.__profile = profile;
export default profile;
