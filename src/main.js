// [foundation] Boot: create the engine, register ALL systems in the fixed order (§2), boot.
// Registration order (do not reorder):
//   materials → physics → lighting → weather → city → signage → props → traffic → crowd → humanoid(assets) →
//   animations → player → [loop] → enemy → combat → heatActions → camera → postfx → hud → menus → audio → missions → shots
//
// Modules are loaded with dynamic import() so that a module with a syntax error or a missing default export
// (e.g. one that is mid-rewrite by its owner) is replaced by an inert stub and logged, instead of taking the
// whole game down. The engine additionally isolates init/update failures per module.
import { attachBreadcrumbs, crumb } from './core/mobileProfile.js';   // [mobile] first: the phone profile's switches go into the URL before any module reads it
import { createEngine } from './core/engine.js';
import shots, { applyParams } from './debug/shots.js';

const MODULES = [
  ['materials', './world/materials.js'], ['physics', './core/physics.js'], ['lighting', './world/lighting.js'],
  ['weather', './world/weather.js'], ['city', './world/city.js'], ['signage', './world/signage.js'],
  ['props', './world/props.js'], ['traffic', './world/traffic.js'], ['crowd', './world/crowd.js'],
  ['humanoid', './characters/humanoid.js'], ['animations', './characters/animations.js'],
  ['player', './characters/player.js'], ['loop', './world/loop.js'], ['enemy', './characters/enemy.js'], ['combat', './combat/combat.js'],
  ['heatActions', './combat/heatActions.js'], ['camera', './camera/camera.js'], ['postfx', './render/postfx.js'],
  ['hud', './ui/hud.js'], ['menus', './ui/menus.js'], ['audio', './audio/audio.js'], ['missions', './story/missions.js'],
  ['shinsen', './world/shinsen.js'],
  ['touch', './ui/touchControls.js'],   // [mobile] on-screen controls (inert unless a touch device or ?touch=1)
];

async function loadModule(name, path) {
  try {
    const ns = await import(path);
    const mod = ns.default;
    if (!mod || typeof mod !== 'object') throw new Error('no default export object');
    if (!mod.name) mod.name = name;
    return mod;
  } catch (e) {
    console.error(`[main] module "${name}" failed to load (${path}); using an inert stub:`, e && e.message ? e.message : e);
    return { name, init() {}, update() {}, __loadError: e };
  }
}

// the loading screen (index.html #boot): the imports are the first 30 % of the bar, the inits the rest, and it fades
// on the first finished frames. Under ?shot it goes at once so no capture ever has it in frame.
const bootEl = document.getElementById('boot');
const bootBar = bootEl && bootEl.querySelector('.bar i'), bootTxt = bootEl && bootEl.querySelector('span');
let bootShown = 0;
const bootProgress = (k) => {
  if (!bootEl) return;
  const pc = Math.max(bootShown, Math.min(100, Math.round(k * 100)));
  if (pc === bootShown && pc) return;
  bootShown = pc;
  bootBar.style.width = pc + '%';
  bootTxt.textContent = `読み込み中　${pc}%`;
};

const canvas = document.getElementById('game');
const engine = createEngine({ canvas, seed: 1 });
attachBreadcrumbs(engine);   // [mobile] boot stages -> localStorage (phones only)

let nLoaded = 0;
const loaded = await Promise.all(MODULES.map(([name, path]) => loadModule(name, path).then((m) => {
  bootProgress((0.05 * ++nLoaded) / MODULES.length);
  crumb('import', `${nLoaded}/${MODULES.length} ${name}`);
  return m;
})));
// the inits take 5–88 % of the bar in proportion to how long each one runs (ms, measured at 1920×1080 @2x on the
// client's machine class, 2026-09-26); the first frames (programs, shadow maps: ~1.5 s) are the last 12 %
const BOOT_MS = { materials: 440, lighting: 140, weather: 360, city: 1600, signage: 3840, props: 1840, traffic: 170, crowd: 1160, player: 100, hud: 210, audio: 90 };
let bootCum = null;
engine.events.on('boot:progress', ({ i }) => {
  if (!bootCum) {
    bootCum = [0];
    for (const m of engine.order) bootCum.push(bootCum[bootCum.length - 1] + (BOOT_MS[m.name] || 20));
  }
  bootProgress(0.05 + (0.83 * bootCum[Math.min(i, bootCum.length - 1)]) / bootCum[bootCum.length - 1]);
});
engine.events.on('engine:ready', () => {
  if (!bootEl) return;
  bootProgress(1);
  if (new URLSearchParams(location.search).has('shot')) { bootEl.remove(); return; }
  bootEl.classList.add('off');
  setTimeout(() => bootEl.remove(), 400);
});

// URL params (?shot, ?t, ?seed, ?hud, ?fps, ?anim, ?phase, ?fight) must be known before any module inits;
// register first so module-provided shot presets are visible to applyParams.
for (const mod of loaded) engine.register(mod);
engine.register(shots);
applyParams(engine);

engine.boot().then(async () => {
  if(engine.params.raw.heroReview==='1'){const {installHeroReview}=await import('./debug/heroReview.js');installHeroReview(engine);}
  const failed = engine.order.filter(m => m.__initError || m.__loadError).map(m => m.name);
  console.info(`[main] booted: ${engine.order.length} systems, ${failed.length} failed${failed.length ? ' (' + failed.join(', ') + ')' : ''}`);
}).catch((e) => {
  console.error('[main] boot failed', e);
});

export default engine;
