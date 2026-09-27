// [foundation] Engine: renderer, scene, camera, clock, loop, system registry, resize, __ready/__stats  (§3)
import * as THREE from 'three';
import { createEvents } from './events.js';
import { createRng } from './rng.js';
import { createInput } from './input.js';
import { MOBILE, compactCanvasTextures } from './mobileProfile.js';

const MAX_DT = 1 / 20;

export function createEngine({ canvas, seed = 1 } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = new URLSearchParams(location.search).get('shadow') !== '0';   // ?shadow=0 (the phones' safe tier): none
  renderer.shadowMap.type = THREE.PCFShadowMap; // r186 removed PCFSoftShadowMap (falls back to PCF); lighting sets shadow.radius
  // Render resolution. Two ratios:
  //   the CANVAS ratio (renderer.setPixelRatio) — fixed for the session. The composer used to render at 1.25 while
  //     the canvas stayed at devicePixelRatio 2, so the last pass (SMAA) wrote 3840x2160 on a Retina 1080p window —
  //     2.6x the pixels it had any information for — and the compositor moved that 33 MB buffer every frame
  //     (0.9 ms). The canvas is now the size of the authored render (1.25) and the browser upscales it.
  //   the RENDER ratio (engine.governor.pr) — what postfx and the wet mirror allocate their targets at; the governor
  //     moves it. Never the canvas: resizing a WebGL drawing buffer stalls the GPU process for 70-110 ms (measured),
  //     a render-target resize costs ~10 ms, so a governor step is a hitch-free change. The last pass upscales.
  //   ?res=<ratio>    fixes both (1 = one device pixel per CSS pixel; capped at devicePixelRatio)
  //   ?resmax=<ratio> lets the governor climb above the start ratio on a fast frame (the canvas is allocated at it)
  //   ?gov=0          turns the adaptive governor (below) off: fixed at the start ratio, every pass on
  // Default on Retina: start at 1.25 (the authored look); the governor moves it between 1.0 and the start.
  // [mobile] the phone profile (mobileProfile.js) starts at 1.0 and lets the governor go down to 0.75: a 3x phone
  // screen at 1.25 is ~1.5x the pixels of a 1080p frame's worth of post chain on a phone GPU.
  const QS = new URLSearchParams(location.search);
  const DPR = window.devicePixelRatio || 1;
  const resQ = Number(QS.get('res'));
  const fixedRes = QS.has('res') && isFinite(resQ) && resQ > 0;
  const PR_START = fixedRes ? Math.min(DPR, resQ) : Math.min(DPR, MOBILE ? 1.0 : 1.25);
  const resMaxQ = Number(QS.get('resmax'));
  const PR_MAX = fixedRes ? PR_START : Math.min(DPR, 2.0, Math.max(PR_START, isFinite(resMaxQ) && resMaxQ > 0 ? resMaxQ : PR_START));
  renderer.setPixelRatio(PR_MAX);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x05060a, 1);
  renderer.info.autoReset = false; // we reset once per frame so composer passes are all counted
  // ?texmax=<px> (the mobile profile's 1024): the largest texture edge uploaded. three scales a bigger canvas / image /
  // bitmap down at upload (WebGLTextures.resizeImage); the procedural 2048-4096 atlases are most of the GPU memory.
  // (the scans' bitmaps are fitted at decode instead, humanoid.js loadTex: redrawn into a canvas they would obey flipY)
  // Its per-texture "has been resized" warning is expected here, so it is counted instead of logged.
  // (a scan's bitmap may be allowed more than the procedural cap — ?heroTex — and must never be resized here: redrawn into a
  // canvas it would obey flipY where the bitmap did not; so the upload cap is the larger of the two)
  const texMaxQ = Math.max(Number(QS.get('texmax')) || 0, Number(QS.get('heroTex')) || 0, Number(QS.get('scanTex')) || 0) || NaN;
  if (isFinite(texMaxQ) && texMaxQ >= 256 && texMaxQ < renderer.capabilities.maxTextureSize) {
    renderer.capabilities.maxTextureSize = texMaxQ | 0;
    const prevLog = THREE.getConsoleFunction();
    let nResized = 0;
    THREE.setConsoleFunction((type, msg, ...rest) => {
      if (type === 'warn' && /Texture has been resized|DataTexture is too big/.test(msg)) { nResized++; return; }
      if (prevLog) prevLog(type, msg, ...rest); else (console[type] || console.log)(msg, ...rest);
    });
    Object.defineProperty(renderer.capabilities, 'texResized', { get: () => nResized, configurable: true });
  }
  const texCompact = renderer.capabilities.maxTextureSize === (texMaxQ | 0);   // (the listener goes on below, with the events)

  // Opaque sort: three's default is groupOrder, renderOrder, material.id, z. A material shared by an InstancedMesh
  // and a plain Mesh (or instanced with and without instanceColor, skinned and not, with and without tangents)
  // needs a DIFFERENT program for each, and WebGLRenderer.setProgram re-resolves it — getParameters, a ~100-field
  // cache key string, a full uniform refresh — every time consecutive draws disagree. Sorted by material then z,
  // they disagree on almost every draw: measured 310 program re-resolutions a frame at the scramble (props:paint
  // alone 16). Grouping each material's draws by that object variant before depth makes it one switch per variant.
  // Depth order inside a group is kept (front to back); transparent sorting is untouched.
  const variantOf = (o, g) => (o.isInstancedMesh ? 1 : 0) | (o.instanceColor ? 2 : 0) | (o.isSkinnedMesh ? 4 : 0) |
    (o.isBatchedMesh ? 8 : 0) | (o.morphTexture ? 16 : 0) | (g && g.attributes.tangent ? 32 : 0) |
    (g && g.attributes.color && g.attributes.color.itemSize === 4 ? 64 : 0) | (g && g.morphAttributes && g.morphAttributes.position ? 128 : 0);
  renderer.setOpaqueSort((a, b) => {
    if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
    if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
    if (a.material.id !== b.material.id) return a.material.id - b.material.id;
    const va = variantOf(a.object, a.geometry), vb = variantOf(b.object, b.geometry);
    if (va !== vb) return va - vb;
    if (a.z !== b.z) return a.z - b.z;
    return a.id - b.id;
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / Math.max(1, window.innerHeight), 0.1, 1500);
  camera.position.set(0, 1.6, 30);
  camera.layers.enable(1); // BLOOM layer objects are still visible to the main camera

  // THREE.Clock is deprecated in r186 -> THREE.Timer, wrapped with the Clock API other modules expect
  const timer = new THREE.Timer();
  const clock = {
    timer, running: false,
    start() { timer.update(); clock.running = true; },
    stop() { clock.running = false; },
    getDelta() { timer.update(); return clock.running ? timer.getDelta() : 0; },
    getElapsedTime() { return timer.getElapsed(); },
  };
  const events = createEvents();
  // ?texmax: the big canvases behind the capped textures are let go once the game is up (mobileProfile.js)
  if (texCompact) events.on('engine:ready', () => { try { compactCanvasTextures(engine, (Number(QS.get('texmax')) || texMaxQ) | 0); } catch (e) { logOnce('engine', 'compactCanvasTextures', e); } });
  const rng = createRng(seed);
  const input = createInput(canvas);

  const stats = { fps: 0, ms: 0, drawCalls: 0, triangles: 0, frame: 0, points: 0, lines: 0, textures: 0, geometries: 0, programs: 0, res: PR_START, gov: '' };
  // the render ratio every render-target owner sizes against (postfx, weather's mirror): see the ratio notes above
  const renderRatio = () => gov.pr;
  const frameTimes = new Float64Array(30);
  let frameIdx = 0, frameCount = 0;

  // ---- adaptive quality governor -------------------------------------------------------------------------------
  // Target 60 fps. Input: the frame's own interval (rAF dt, which contains every pass and the GPU backpressure —
  // engine.stats.ms is CPU only), smoothed (EMA, ~0.3 s). Three knobs, degraded in this order, restored in reverse:
  //   1. the wet-road mirror at 30 Hz (weather.js reads governor.mirrorEvery; a blurred reflection one frame old)
  //   2. the render pixel ratio in 0.125 steps down to 1.0 (canvas + every post target follow it; 0.25 when far off)
  //   3. the post chain's quality tier (postfx.setQuality: AO quarter res + no far soften, then AO off + FXAA)
  // Every step down is CHECKED: if over the next ~1.3 s the frame is not at least 4% faster, the knob was not what bound
  // the frame (on ANGLE/Metal it can be draw submission or another process on the GPU, which no resolution fixes) —
  // the step is undone, so the look is never spent for nothing, and that knob rests for 30 s (doubling to 4 min).
  // Recovery: 3 s under 13.3 ms restores the last step; on a 60 Hz display (vsync never lets dt fall below 16.7)
  // 8 s held at 60 is a probe instead. An up-step followed by a down-step within 6 s is an oscillation: up-steps
  // are then held off for 10 s, doubling to 2 min.
  // Down: 0.7 s above 17.3 ms (58 fps — on a 120 Hz panel that is already a judder of 16.7 / 25 ms frames).
  // Headroom (a 120 Hz display running under 10 ms) with ?resmax=: the ratio climbs above its start toward resmax;
  // the first slow second drops it straight back to the start in one step (no ladder walk in a heavy street).
  // Off for ?shot= stills (deterministic frames), paused / frozen states and the first 90 frames (compilation).
  const gov = {
    auto: QS.get('gov') !== '0',
    prAuto: !fixedRes,
    pr: PR_START, start: PR_START, min: Math.min(DPR, MOBILE ? 0.75 : 1.0), max: PR_MAX, step: 0.125,
    mirrorEvery: 1, pfxQ: 2,
    target: 1 / 60, ema: 0, slow: 0, fast: 0, steady: 0, cool: 0,
    stack: [], pending: null, block: {}, tries: {}, upBlock: 0, upBackoff: 10, lastUp: -1e9,
    log: [],
  };
  const govNow = () => performance.now() / 1000;
  // the render ratio only: postfx re-sizes its targets (lazily reallocated on next use), the mirror follows
  // through 'render:scale'. The canvas is left alone (see the ratio notes at the renderer).
  function govSetPR(v) {
    v = Math.round(Math.max(gov.min, Math.min(gov.max, v)) * 1000) / 1000;
    if (Math.abs(v - gov.pr) < 1e-4) return;
    gov.pr = v;
    const pf = engine.systems.get('postfx');
    if (pf && typeof pf.setSize === 'function') { try { pf.setSize(window.innerWidth, window.innerHeight); } catch (e) { logOnce('postfx', 'setSize', e); } }
    events.emit('render:scale', v);
  }
  function govSetQ(q) {
    gov.pfxQ = q;
    const pf = engine.systems.get('postfx');
    if (pf && typeof pf.setQuality === 'function' && pf.quality !== q) { try { pf.setQuality(q); } catch (e) { logOnce('postfx', 'setQuality', e); } }
  }
  const KNOBS = {
    mirror: { can: () => gov.mirrorEvery === 1, down: () => { gov.mirrorEvery = 2; return 1; }, undo: (v) => { gov.mirrorEvery = v; } },
    pr: {
      can: () => gov.prAuto && gov.pr > gov.min + 1e-3,
      down: () => { const v = gov.pr; govSetPR(v - gov.step * (gov.ema > gov.target * 1.5 ? 2 : 1)); return v; },
      undo: (v) => govSetPR(v),
    },
    q: { can: () => gov.pfxQ > 0, down: () => { const v = gov.pfxQ; govSetQ(v - 1); return v; }, undo: (v) => govSetQ(v) },
  };
  const govState = () => `pr ${gov.pr} mirror 1/${gov.mirrorEvery} q${gov.pfxQ}`;
  function govNote(msg) {
    gov.log.push(`${govNow().toFixed(1)} ${msg}`); if (gov.log.length > 40) gov.log.shift();
    if (engine.params && engine.params.raw && engine.params.raw.govlog) console.info('[governor] ' + msg);
  }
  function govDegrade(now) {
    // slow again right after an up-step: the up-step was the mistake. Back off future probes, and do NOT test this
    // step for usefulness — the lower state was just measured for seconds, and a noisy 1 s check must not undo it.
    const revert = now - gov.lastUp < 6;
    if (revert) { gov.upBlock = now + gov.upBackoff; gov.upBackoff = Math.min(120, gov.upBackoff * 2); }
    // a ratio raised above its start is what made the frame slow: give all of it back at once
    if (gov.prAuto && gov.pr > gov.start + 1e-3) {
      govSetPR(gov.start); gov.cool = 0.3; gov.slow = 0;
      govNote(`down pr to start (ema ${(gov.ema * 1000).toFixed(1)} ms) -> ${govState()}`);
      return true;
    }
    for (const k of ['mirror', 'pr', 'q']) {
      if (!KNOBS[k].can() || (gov.block[k] || 0) > now) continue;
      const prev = KNOBS[k].down();
      gov.stack.push({ k, prev });
      gov.pending = revert ? null : { k, before: gov.ema, t: now, sum: 0, n: 0 };
      govNote(`down ${k} (ema ${(gov.ema * 1000).toFixed(1)} ms) -> ${govState()}`);
      gov.cool = 0.3; gov.slow = 0;
      return true;
    }
    return false;
  }
  function govUpgrade(now) {
    const top = gov.stack.pop();
    if (top) { KNOBS[top.k].undo(top.prev); govNote(`up ${top.k} (ema ${(gov.ema * 1000).toFixed(1)} ms) -> ${govState()}`); }
    else if (gov.prAuto && gov.pr < gov.max - 1e-3 && gov.ema < gov.target * 0.6) { govSetPR(gov.pr + gov.step); govNote(`up pr -> ${govState()}`); }
    else return;
    gov.lastUp = now; gov.cool = 0.3; gov.fast = 0; gov.steady = 0; gov.pending = null;
  }
  function govUpdate(raw) {
    if (!gov.auto || !booted || frameCount < 90 || raw > 0.1 || raw <= 0) return;
    if (engine.state.frozen || engine.state.mode === 'paused' || (engine.params && engine.params.shot)) { gov.slow = gov.fast = gov.steady = 0; return; }
    if (!gov.synced) {                                   // start from the tier postfx actually booted in (?postfx=q0|q1)
      gov.synced = true;
      const pf = engine.systems.get('postfx');
      if (pf && typeof pf.quality === 'number') gov.pfxQ = pf.quality;
    }
    if (gov.cool > 0) { gov.cool -= raw; return; }      // the frames right after a change carry its reallocation
    gov.ema = gov.ema ? gov.ema + (raw - gov.ema) * 0.08 : raw;
    const now = govNow();
    const p = gov.pending;
    if (p) { p.sum += raw; p.n++; }
    if (p && now - p.t > 1.3) {
      gov.pending = null;
      const after = p.n ? p.sum / p.n : gov.ema;   // the mean over the window, not the EMA's last few frames
      if (after > p.before * 0.96) {             // bought < 4%: not what binds this frame — undo it, rest the knob
        const top = gov.stack.pop();
        if (top) KNOBS[top.k].undo(top.prev);
        gov.tries[p.k] = (gov.tries[p.k] || 0) + 1;
        gov.block[p.k] = now + 30 * Math.min(8, 2 ** (gov.tries[p.k] - 1));
        govNote(`undo ${p.k}: ${(p.before * 1000).toFixed(1)} -> ${(after * 1000).toFixed(1)} ms bought nothing -> ${govState()}`);
        gov.cool = 0.4;
        return;
      }
    }
    const hi = gov.target * 1.04, lo = gov.target * (gov.stack.length ? 0.80 : 0.60);
    if (gov.ema > hi) { gov.slow += raw; gov.fast = 0; gov.steady = 0; }
    else {
      gov.slow = 0;
      if (gov.ema < lo) gov.fast += raw; else gov.fast = 0;
      if (gov.ema < gov.target * 1.04) gov.steady += raw; else gov.steady = 0;
    }
    if (gov.slow > 0.7 && !gov.pending) govDegrade(now);
    else if (now > gov.upBlock && !gov.pending && (gov.fast > 3.0 || (gov.stack.length && gov.steady > 8.0))) govUpgrade(now);
  }

  // ---- shader precompile -----------------------------------------------------------------------------------------
  // Every hitch in the live fight measured 100-280 ms was a program compiled synchronously at its first draw: a
  // landmark material the first time the camera swung onto it (lm_kobanStone 277 ms, lm_hachikoBronze), a prop's
  // glass, the enemies' materials once lighting had attached the CSM hook to them. precompile(obj) builds every
  // program obj's materials will need with KHR_parallel_shader_compile (renderer.compileAsync), off the frame.
  // The scene target is bound while it runs: tone mapping and the output colour space are program parameters, and a
  // compile against the canvas would build the ACES / sRGB variant that no scene pass ever draws with.
  // The whole scene is precompiled once at frame 4 (after lighting has hooked CSM onto every material and retired
  // its duplicate lights, so the variants are the final ones), hidden behind the title card; lighting calls it for
  // objects whose materials it hooks later (enemies spawned for a fight). ?precompile=0 turns it off for A/B.
  function precompile(obj) {
    const pf = engine.systems.get('postfx');
    const rt = pf && pf.sceneRT && pf.enabled !== false && !pf.bypass ? pf.sceneRT : null;
    const prev = renderer.getRenderTarget();
    const t0 = performance.now();
    try {
      renderer.setRenderTarget(rt);
      const target = obj && obj !== scene ? obj : scene;
      const p = renderer.compileAsync(target, camera, target === scene ? null : scene);
      const sync = performance.now() - t0;
      return p.then(() => ({ sync, total: performance.now() - t0 }), () => null);
    } catch (e) { logOnce('engine', 'precompile', e); return Promise.resolve(null); }
    finally { renderer.setRenderTarget(prev); }
  }

  const order = [];
  const errored = new Set();
  let readyRequested = false, readyFrames = 0, booted = false, elapsed = 0, rafId = 0, running = false;

  const engine = {
    renderer, scene, camera, canvas, clock, events, rng, input,
    time: { hour: 21.5, weather: 'wet', wet: 1, speed: 1 },
    systems: new Map(),
    world: null,
    player: null,
    state: { mode: 'explore', frozen: false },
    layers: { BLOOM: 1, MINIMAP: 2 },
    params: {},
    stats,
    governor: gov,
    renderRatio: () => renderRatio(),
    precompile,
    order,
    get(name) { return engine.systems.get(name); },
    register,
    boot,
    setReady,
    stop,
    resize,
    get elapsed() { return elapsed; },
    get booted() { return booted; },
  };

  function logOnce(name, phase, e) {
    const key = name + ':' + phase;
    if (errored.has(key)) return;
    errored.add(key);
    console.error(`[${name}] error in ${phase}:`, e && e.stack ? e.stack : e);
  }

  function register(mod) {
    if (!mod || typeof mod !== 'object' || !mod.name) { console.error('[engine] register: invalid module', mod); return; }
    if (engine.systems.has(mod.name)) { console.warn(`[engine] module "${mod.name}" registered twice; ignoring second`); return; }
    const rawInit = typeof mod.init === 'function' ? mod.init.bind(mod) : null;
    const rawUpdate = typeof mod.update === 'function' ? mod.update.bind(mod) : null;
    const rawDispose = typeof mod.dispose === 'function' ? mod.dispose.bind(mod) : null;
    mod.__safeInit = async () => {
      if (!rawInit) return;
      try { await rawInit(engine); mod.__inited = true; }
      catch (e) { logOnce(mod.name, 'init', e); mod.__initError = e; }
    };
    mod.__safeUpdate = (dt, t) => {
      if (!rawUpdate) return;
      try { rawUpdate(dt, t); }
      catch (e) { logOnce(mod.name, 'update', e); }
    };
    mod.__safeDispose = () => {
      if (!rawDispose) return;
      try { rawDispose(); } catch (e) { logOnce(mod.name, 'dispose', e); }
    };
    engine.systems.set(mod.name, mod);
    order.push(mod);
    return mod;
  }

  async function boot() {
    let painted = performance.now();
    for (let i = 0; i < order.length; i++) {
      const mod = order[i];
      events.emit('boot:progress', { i, n: order.length, name: mod.name });   // the loading screen's bar (main.js)
      // back-to-back inits never let the page paint: after 100 ms of them, give the loading screen one frame
      if (typeof requestAnimationFrame === 'function' && performance.now() - painted > 100) {
        await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
        painted = performance.now();
      }
      const t0 = performance.now();
      await mod.__safeInit();
      const ms = performance.now() - t0;
      if (ms > 250) console.warn(`[engine] ${mod.name}.init took ${ms.toFixed(0)} ms`);
    }
    events.emit('boot:progress', { i: order.length, n: order.length, name: '' });
    booted = true;
    clock.start();
    running = true;
    events.emit('engine:booted', engine);
    rafId = requestAnimationFrame(frame);
    return engine;
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    for (const mod of order) mod.__safeDispose();
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    const pf = engine.systems.get('postfx');
    if (pf && typeof pf.setSize === 'function') { try { pf.setSize(w, h); } catch (e) { logOnce('postfx', 'setSize', e); } }
    events.emit('resize', { width: w, height: h });
  }
  window.addEventListener('resize', resize);

  function frame() {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    const raw = clock.getDelta();
    const dtc = Math.min(raw, MAX_DT);
    const dt = dtc * (engine.time.speed || 1);
    elapsed += dtc;
    const t = elapsed;
    const t0 = performance.now();

    renderer.info.reset();
    input.update();
    for (const mod of order) mod.__safeUpdate(dt, t);

    // [mobile] engine.skipRender(frame) -> true skips drawing this frame (the phone warm-up in mobileProfile.js: nothing is
    // drawn behind the opaque title / video, while textures upload and programs compile a few per frame instead)
    const pf = engine.systems.get('postfx');
    if (typeof engine.skipRender === 'function' && engine.skipRender(frameCount)) { /* not drawn */ }
    else if (pf && typeof pf.render === 'function' && !pf.__initError) {
      try { pf.render(dt); } catch (e) { logOnce('postfx', 'render', e); renderer.render(scene, camera); }
    } else {
      renderer.render(scene, camera);
    }

    // stats
    const ms = performance.now() - t0;
    frameTimes[frameIdx] = raw;
    frameIdx = (frameIdx + 1) % 30;
    frameCount++;
    const n = Math.min(frameCount, 30);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += frameTimes[i];
    stats.fps = sum > 0 ? Math.round(n / sum) : 0;
    stats.ms = Math.round(ms * 10) / 10;
    stats.drawCalls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    stats.points = renderer.info.render.points;
    stats.lines = renderer.info.render.lines;
    stats.textures = renderer.info.memory.textures;
    stats.geometries = renderer.info.memory.geometries;
    stats.programs = renderer.info.programs ? renderer.info.programs.length : 0;
    stats.frame = frameCount;
    if (frameCount === 4 && QS.get('precompile') !== '0' && !engine.skipRender) {   // (a phone warms up in slices instead)
      const n0 = renderer.info.programs ? renderer.info.programs.length : 0;
      events.emit('precompile:start', 'scene');
      precompile(scene).then((r) => { events.emit('precompile:end'); if (r) console.info(`[engine] precompiled ${(renderer.info.programs ? renderer.info.programs.length : 0) - n0} programs (${r.sync.toFixed(0)} ms on the frame, ${r.total.toFixed(0)} ms in the background)`); });
    }
    govUpdate(raw);
    stats.res = gov.pr;
    stats.gov = `res ${gov.pr.toFixed(3)}x  mirror 1/${gov.mirrorEvery}  fx q${gov.pfxQ}${gov.auto ? '' : ' (fixed)'}`;
    if (govEl && (frameCount & 7) === 0) govEl.textContent = stats.gov + (gov.ema ? `  ~${(gov.ema * 1000).toFixed(1)} ms` : '');
    window.__stats = stats;

    if (readyRequested && !window.__ready) {
      readyFrames++;
      if (readyFrames >= 2) { window.__ready = true; events.emit('engine:ready', engine); }
    }
  }

  function setReady() { readyRequested = true; readyFrames = 0; }

  // ?fps=1: the governor's state under the hud's stats block (same look; the hud owns the block itself)
  let govEl = null;
  if (QS.get('fps') === '1') {
    govEl = document.createElement('div');
    govEl.style.cssText = 'position:fixed;left:34px;bottom:14px;padding:2px 10px;font:12px/1.5 Menlo,Consolas,monospace;color:#9f9;' +
      'background:rgba(0,0,0,.45);pointer-events:none;z-index:50;white-space:pre';
    (document.body || document.documentElement).appendChild(govEl);
  }

  window.__engine = engine;
  return engine;
}

export default createEngine;
