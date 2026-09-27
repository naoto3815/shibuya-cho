// [foundation] ?shot presets, url params, __ready logic, stats overlay  (§1)
//   applyParams(engine)  -- called by main.js BEFORE boot: parses the URL into engine.params and primes
//                           engine.time / engine.rng / engine.state.frozen so every module inits consistently.
//   shots.init(engine)   -- registered LAST: applies the camera preset, hud/fps flags, anim pose, then setReady().
//   shots.PRESETS        -- name -> ({engine}) => { pos, lookAt } | { follow: entity, ... }
import * as THREE from 'three';

export const TIMES = {
  day:   { hour: 13.0, weather: 'clear', wet: 0.0 },
  dusk:  { hour: 18.2, weather: 'clear', wet: 0.0 },
  night: { hour: 21.5, weather: 'wet',   wet: 1.0 },   // default gameplay start: night, after rain
  rain:  { hour: 21.5, weather: 'rain',  wet: 1.0 },
  dawn:  { hour: 5.6,  weather: 'clear', wet: 0.35 },
};

function playerFrame(engine) {
  const p = engine.player;
  const pos = p ? p.position.clone() : new THREE.Vector3(24, 0, 30);
  const yaw = p ? p.yaw : -3 * Math.PI / 4;
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
  return { pos, yaw, fwd, right };
}

export const PRESETS = {
  overview:       () => ({ pos: [0, 220, 220], lookAt: [0, 0, 0], fov: 45 }),
  crossing_night: () => ({ pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'night' }),
  night_rain:     () => ({ pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'rain' }),
  day_crossing:   () => ({ pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'day' }),
  hachiko:        () => ({ pos: [15, 2.4, 24], lookAt: [30, 3, 44] }),
  '109':          () => ({ pos: [-12, 1.7, 6], lookAt: [-84, 16, 0] }),
  qfront:         () => ({ pos: [-2, 1.7, 12], lookAt: [28, 14, -28] }),
  centergai:      () => ({ pos: [-40, 1.6, -28], lookAt: [-40, 4, -100] }),
  station:        () => ({ pos: [-14, 1.7, 6], lookAt: [89, 95, 95], fov: 60 }),
  dogenzaka:      () => ({ pos: [-66, 1.7, 5], lookAt: [-180, 14, 66] }),
  combat: ({ engine }) => {
    const f = playerFrame(engine);
    const pos = f.pos.clone().addScaledVector(f.fwd, -3.4).addScaledVector(f.right, 0.9); pos.y += 1.9;
    const lookAt = f.pos.clone().addScaledVector(f.fwd, 4.5); lookAt.y += 1.2;
    return { pos: pos.toArray(), lookAt: lookAt.toArray(), fight: true };
  },
  player_closeup: ({ engine }) => {
    const f = playerFrame(engine);
    const dir = f.fwd.clone().multiplyScalar(Math.cos(Math.PI / 4)).addScaledVector(f.right, Math.sin(Math.PI / 4)).normalize();
    const pos = f.pos.clone().addScaledVector(dir, 2.5); pos.y += 1.5;
    const lookAt = f.pos.clone(); lookAt.y += 1.05;
    return { pos: pos.toArray(), lookAt: lookAt.toArray(), fov: 40 };
  },
};

export function parseUrl(search) {
  const q = new URLSearchParams(search || '');
  const num = (k, d) => (q.has(k) && q.get(k) !== '' && !isNaN(Number(q.get(k))) ? Number(q.get(k)) : d);
  const params = {
    shot: q.get('shot') || null,
    t: q.get('t') || null,
    seed: num('seed', null),
    hud: q.has('hud') ? q.get('hud') !== '0' : true,
    fps: q.get('fps') === '1',
    anim: q.get('anim') || null,
    phase: num('phase', 0),
    fight: q.get('fight') === '1',
    debug: q.get('debug') === '1',
    test: q.get('test') || null,          // ?test=<module,...> runs selfTest()
    heat: q.get('heat') === '1',          // combat: start with a full heat gauge
    stamp: q.get('stamp') === '1',        // hud: fire a kanji stamp for critics
    cutscene: q.get('cutscene') || null,  // story: play a named cutscene
    raw: Object.fromEntries(q.entries()), // anything else a module wants to read
  };
  return params;
}

export function applyTime(engine, name) {
  const t = TIMES[name];
  if (!t) return false;
  engine.time.hour = t.hour; engine.time.weather = t.weather; engine.time.wet = t.wet;
  engine.time.preset = name;
  return true;
}

// Modules may export `shotPresets = { name: { pos, lookAt, t?, fov?, fight?, setup?(engine) } }` (or a function
// returning that object); they are merged with the built-in presets here so specialists can add their own views.
export function modulePreset(engine, name) {
  for (const mod of engine.systems.values()) {
    const table = mod && mod.shotPresets;
    if (!table || !table[name]) continue;
    const entry = table[name];
    return typeof entry === 'function' ? entry : () => ({ ...entry });
  }
  return null;
}

export function applyParams(engine) {
  const params = parseUrl(typeof location !== 'undefined' ? location.search : '');
  engine.params = params;
  const preset = params.shot ? (PRESETS[params.shot] || modulePreset(engine, params.shot)) : null;
  if (params.shot && !preset) console.warn(`[shots] unknown preset "${params.shot}"`);
  // preset may imply a time / fight; explicit url params win
  const implied = preset ? preset({ engine }) : null;
  if (implied && implied.fight) params.fight = true;
  // a numeric ?t= is a moment, not a time of day (?shot=final_blow&t=0.6 holds the final blow 0.6 s in)
  const tod = params.t && isNaN(Number(params.t)) ? params.t : null;
  const timeName = tod || (implied && implied.t) || 'night';
  if (!applyTime(engine, timeName)) { console.warn(`[shots] unknown time "${timeName}", using night`); applyTime(engine, 'night'); }
  engine.rng.seed(params.seed != null ? params.seed : (params.shot ? 7 : 1));
  if (params.shot) {
    engine.state.frozen = true;      // gameplay/time frozen; ambient systems may animate
    engine.state.mode = params.fight ? 'combat' : 'explore';
  }
  return params;
}

const shots = {
  name: 'shots',
  presets: PRESETS,
  times: TIMES,
  engine: null,
  applied: null,

  applyPreset(name) {
    const engine = this.engine;
    const fn = PRESETS[name] || modulePreset(engine, name);
    if (!fn) return false;
    const p = fn({ engine });
    if (typeof p.setup === 'function') { try { p.setup(engine); } catch (e) { console.warn(`[shots] preset "${name}" setup failed`, e); } }
    const cam = engine.get('camera');
    if (cam && typeof cam.setFixed === 'function') {
      cam.setFixed(new THREE.Vector3(...p.pos), new THREE.Vector3(...p.lookAt), { fov: p.fov || 45 });
    } else {
      engine.camera.position.set(...p.pos); engine.camera.lookAt(...p.lookAt);
    }
    this.applied = { name, ...p };
    return true;
  },

  async init(engine) {
    this.engine = engine;
    const params = engine.params || parseUrl('');
    const hud = engine.get('hud');
    if (params.shot) {
      this.applyPreset(params.shot);
      engine.state.frozen = true;
    }
    if (hud) {
      if (!params.hud && typeof hud.setVisible === 'function') hud.setVisible(false);
      if (params.fps && typeof hud.showStats === 'function') hud.showStats(true);
    }
    // pose the player at a given animation phase (for animation critics)
    if (params.anim && engine.player && engine.player.humanoid) {
      const h = engine.player.humanoid;
      try {
        const action = h.play(params.anim, { fade: 0, loop: true, force: true });
        if (action) {
          const clip = action.getClip();
          h.mixer.update(0);
          action.paused = false;
          action.time = Math.max(0, Math.min(0.999, params.phase || 0)) * clip.duration;
          h.mixer.update(0);
          h.mixer.timeScale = 0;
          h.frozenPose = true;
        }
      } catch (e) { console.warn('[shots] anim pose failed', e); }
    }
    if (params.debug && engine.world) engine.world.debugDraw(true);
    // ?test=<module>[,<module>] runs that module's selfTest() and logs the result for the headless harness
    if (params.test) {
      for (const name of String(params.test).split(',')) {
        const mod = engine.get(name.trim());
        if (!mod || typeof mod.selfTest !== 'function') { console.warn(`[test ${name}] no selfTest()`); continue; }
        try { const r = await mod.selfTest(engine); console.info(`[test ${name}] ${typeof r === 'string' ? r : JSON.stringify(r)}`); }
        catch (e) { console.error(`[test ${name}] FAIL`, e); }
      }
    }
    engine.setReady();
    console.info(`[shots] preset=${params.shot || '-'} t=${engine.time.preset} hour=${engine.time.hour} seed=${engine.rng.state()} frozen=${engine.state.frozen}`);
  },

  update() {
    // keep a fixed preset camera pinned even if something else nudges it (camera module owns transform otherwise)
  },
};

export default shots;
