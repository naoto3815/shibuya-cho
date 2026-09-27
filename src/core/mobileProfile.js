// [mobile] Phone / tablet profile. main.js imports this FIRST, so it runs before any module has read location.search.
//   ?mobile=1  forces the mobile quality profile on a desktop     ?mobile=0  turns it off on a phone (auto on phones/tablets)
//   ?touch=1   forces the on-screen controls                      ?touch=0   hides them (auto on touch / coarse pointers)
// The quality profile is the game's own URL switches (docs/PLAY.md, docs/reports/mobile.md), written into the address
// with history.replaceState before any module reads them. A switch already in the URL always wins, so every knob can
// still be A/B'd by hand: ?mobile=1&peds=1 is the mobile profile with the full crowd.
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

// what a phone gets (docs/reports/mobile.md has the measurements behind each one)
//   peds / cars      crowd and traffic (1 = 1,740 people / 150 cars)
//   scanPool         rigged pedestrian bodies bound near the lens at once (desktop 32)
//   scanPer          of those, built per person at boot (desktop 3; the rest are built on demand)
//   scanMid          metres inside which a pedestrian uses the textured lod1 (desktop 20)
//   pedScans         how many of the 24 passer-by scans are downloaded (the story's own always are)
//   pool             street lights in every lit shader's loop (desktop 28)
//   msaa / postfx    no MSAA on the scene target; the post chain's cheapest tier (no AO, FXAA)
//   texmax           largest texture edge uploaded to the GPU (bigger ones are scaled down at upload)
//   pedTex           the same for the passers-by's scan maps (small on a phone's screen)
//   shadow           the near shadow cascade's map (the far one is half)
//   shadowEvery      the near cascade re-renders every n-th frame (desktop every frame)
//   mirror           the wet-road reflection pass (0 = off; 0.25 = a quarter-res mirror)
export const MOBILE_DEFAULTS = {
  peds: '0.4', cars: '70', scanPool: '6', scanPer: '1', scanMid: '12', pedScans: '12',
  pool: '12', msaa: '0', postfx: 'q0', texmax: '1024', pedTex: '512', shadow: '1024', shadowEvery: '2', mirror: '0',
};

const injected = {};
if (MOBILE && typeof history !== 'undefined' && history.replaceState) {
  let changed = false;
  for (const [k, v] of Object.entries(MOBILE_DEFAULTS)) if (!q.has(k)) { q.set(k, v); injected[k] = v; changed = true; }
  if (changed) {
    try { history.replaceState(history.state, '', location.pathname + '?' + q.toString() + location.hash); }
    catch (e) { console.warn('[mobile] could not apply the profile to the URL', e); }
  }
}
if (typeof document !== 'undefined') {
  const c = document.documentElement.classList;
  if (MOBILE) c.add('is-mobile');
  if (TOUCH) c.add('is-touch');
}
// ?texmax: once the game is up, a big canvas texture that stayed unchanged for a few seconds is handed to the GPU as a
// bitmap at the capped size, so the texture no longer pins its full-size canvas (the procedural atlases are ~600 MB of
// canvas memory; iOS Safari caps canvas memory per page and kills tabs well before a desktop would). If its owner draws
// into the canvas again later (the texture's version moves), the canvas is put back — as long as the owner still holds
// it, which it must to draw into it. Signage seals its own pages (signage.js).
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
export const profile = { mobile: MOBILE, touch: TOUCH, injected };
if (typeof window !== 'undefined') window.__profile = profile;
export default profile;
