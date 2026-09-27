// [ui] 龍が如く-style HUD (DOM + one canvas minimap). §10 API:
//   hud.setHP(v,max)  hud.setHeat(v)  hud.showEnemy(entity)  hud.hideEnemy(entity)  hud.combo(n)  hud.objective(text)
//   hud.subtitle(text, seconds, speaker?)  hud.letterbox(bool)  hud.stamp(text)  hud.damage(worldPos, amount, heavy)
//   hud.setVisible(bool)  hud.showStats(bool)  hud.objectivePos = Vector3|null (story sets it; hud draws it on the map)
//   hud.el.stamp — the stamp node; combat/camera/heatActions move it (left/top) and pause it (animationDelay/PlayState).
import * as THREE from 'three';
import { CITY, pointInPolygon } from '../world/cityData.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3(), _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3();
// "SC *" are the @font-face aliases in hud.css (installed faces per OS); the rest is the plain fallback chain
const SANS = '"SC Gothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", Meiryo, sans-serif';
const MINCHO = '"SC Mincho", "Hiragino Mincho ProN", "Noto Serif JP", "Noto Serif CJK JP", "Yu Mincho", YuMincho, serif';
const BRUSH = `"SC Brush", "Yuji Boku", "Xingkai TC", "HGSeikaishotaiPRO", ${MINCHO}`;
const STAMPS = ['極', '決', '崩', '戦', '完', '喧'];                       // every stamp the game fires, pre-baked once
const STAMP_N = 640;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const clock = () => performance.now() / 1000;
const HERO = { ja: '渋沢 健人', en: 'SHIBUSAWA KENTO' };
const COMBO_POP = [{ transform: 'scale(1.5) rotate(-4deg)' }, { transform: 'none' }];
// the first frames burn white (brightness keeps the black stroke black), then the number settles into its colour
const DMG_POP = [
  { transform: 'translate(-50%,-50%) scale(1.9)', opacity: 1, filter: 'brightness(5) saturate(0)' },
  { transform: 'translate(-50%,-50%) scale(1.5)', filter: 'brightness(5) saturate(0)', offset: 0.1 },
  { transform: 'translate(-50%,-50%) scale(.9)', opacity: 1, filter: 'brightness(1) saturate(1)', offset: 0.4 },
  { transform: 'translate(-50%,-50%) scale(1.07)', offset: 0.68 },
  { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, filter: 'none' },
];
const DMG_FS = { dmg: 38, heavy: 56, fin: 76, guard: 26 };
const STAMP_LEN = 1.15;                                                    // .stamp's CSS timeline, seconds

// minimap: canvas box (CSS px), map disc radius (px), metres from the player to the rim (explore / combat)
const MM = { box: 264, r: 108, range: 52, combat: 26 };
const COL = {
  base: '#0b0e13', walk: '#303846', paving: '#4a4231', plaza: '#2b382f', tree: '#3f5a3a', road: '#475164',
  zebra: 'rgba(200,206,216,.38)', stop: 'rgba(200,206,216,.3)', bld: '#171b23', bldEdge: '#2a313e',
  mark: '#232833', markEdge: 'rgba(222,186,96,.8)', rail: 'rgba(4,5,8,.88)', track: '#3a4250',
};

// seeded value noise for the baked brush textures
function valueNoise(seed) {
  const P = new Uint8Array(256);
  for (let i = 0; i < 256; i++) P[i] = i;
  let r = seed >>> 0 || 1;
  for (let i = 255; i > 0; i--) { r = (r * 1664525 + 1013904223) >>> 0; const j = r % (i + 1); const t = P[i]; P[i] = P[j]; P[j] = t; }
  const H = (x, y) => P[(P[x & 255] + y) & 255] / 255;
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = H(xi, yi), b = H(xi + 1, yi), c = H(xi, yi + 1), d = H(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
const mkCanvas = (n) => { const c = document.createElement('canvas'); c.width = c.height = n; return c; };
// separable running-mean blur of an N×N field, in place
function boxBlur(f, N, r) {
  const tmp = new Float32Array(N * N), w = 2 * r + 1, cl = (i) => (i < 0 ? 0 : i > N - 1 ? N - 1 : i);
  for (let y = 0; y < N; y++) {
    const o = y * N; let acc = 0;
    for (let x = -r; x <= r; x++) acc += f[o + cl(x)];
    for (let x = 0; x < N; x++) { tmp[o + x] = acc / w; acc += f[o + cl(x + r + 1)] - f[o + cl(x - r)]; }
  }
  for (let x = 0; x < N; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[cl(y) * N + x];
    for (let y = 0; y < N; y++) { f[y * N + x] = acc / w; acc += tmp[cl(y + r + 1) * N + x] - tmp[cl(y - r) * N + x]; }
  }
  return f;
}
const LABELS = {
  shibuya109: 'SHIBUYA 1O9', qfront: 'Q-FRONT', magnet: 'MAGNET', ekimaeBldg: '駅前ビル', station: '渋谷町駅',
  scrambleSquare: 'スクランブルスクエア', markCity: 'マークシティ', seibu: '西部 A館', seibuB: '西部 B館', nonbei: 'のんべい横丁',
  miyashitaPark: '宮下パーク', hikarie: 'ヒカリエ', fukuras: 'フクラス', loft: 'LOFTY', modi: 'MOD1', parco: 'PALCO',
  towerRecord: 'TOWER RECORD', stream: 'ストリーム',
};
const AREA_NAMES = { 'ハチ公前広場': 'ハチ公前広場', '西口バスターミナル': '西口バスターミナル', '西口広場(モヤイ像)': 'モヤイ像前', '東口バスターミナル': '東口バスターミナル' };

function rectPoly(cx, cz, w, d, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c]);
}
function bbox(pts, pad = 0) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
}
function centroid(p) { let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length]; }
function segDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)) : 0;
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}
function pathDist(x, z, path) { let d = Infinity; for (let i = 0; i < path.length - 1; i++) d = Math.min(d, segDist(x, z, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1])); return d; }
const tidyName = (n) => n.replace(/\(下\)/, '下').replace(/\s*\(.*?\)\s*/g, '').replace(/ 歩道$/, '');

const hud = {
  name: 'hud',
  root: null,
  enemies: new Map(),
  dmgs: [],
  objectivePos: null,

  init(engine) {
    this.engine = engine;
    const root = document.getElementById('hud') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'hud' }));
    this.root = root;
    root.classList.add('y8');
    root.lang = 'ja';                                                      // Han glyphs in their Japanese forms on every OS
    const segs = Array.from({ length: 3 }, () => '<div class="seg"><i class="fill"></i><i class="edge"></i></div>').join('');
    root.innerHTML = `
      <div class="danger"></div>
      <div class="lb top"></div><div class="lb bottom"></div>
      <div class="plate">
        <div class="crest"><span>健</span></div>
        <div class="name"><span class="kanji">${HERO.ja}</span><span class="romaji">${HERO.en}</span></div>
        <i class="hpsh"></i>
        <div class="bar hp"><div class="in"><i class="ghost"></i><i class="fill"></i><i class="gloss"></i><i class="ticks"></i></div></div>
        <div class="heatrow"><div class="heat">${segs}</div><div class="kiwami"><span>極</span></div></div>
      </div>
      <div class="enemies"></div>
      <div class="combo"><div class="n">0</div><div class="t"><i>連撃</i></div><div class="timer"><i></i></div></div>
      <div class="objective"><div class="head">目的</div><div class="text"></div></div>
      <div class="minimap"><canvas></canvas></div>
      <div class="district"><b>渋谷町</b><span class="area"></span></div>
      <div class="subtitle"><span class="who"></span><span class="line"></span></div>
      <div class="dmgs"></div>
      <div class="stamp"><i class="flash"></i><canvas class="ink"></canvas><canvas class="kj"></canvas></div>
      <div class="stats"></div>
      <div class="credit" data-credit-host></div>`;
    const q = (s) => root.querySelector(s);
    this.el = {
      plate: q('.plate'), hp: q('.bar.hp'), hpFill: q('.bar.hp .fill'), hpGhost: q('.bar.hp .ghost'),
      heatRow: q('.heatrow'), segs: [...root.querySelectorAll('.heat .seg')].map((s) => ({ s, f: s.querySelector('.fill'), e: s.querySelector('.edge') })),
      enemies: q('.enemies'), combo: q('.combo'), comboN: q('.combo .n'), comboTimer: q('.combo .timer i'),
      objective: q('.objective .text'), minimap: q('.minimap canvas'), area: q('.district .area'), district: q('.district'),
      subtitle: q('.subtitle'), subWho: q('.subtitle .who'), subLine: q('.subtitle .line'), dmgs: q('.dmgs'),
      stamp: q('.stamp'), ink: q('.stamp .ink'), kj: q('.stamp .kj'), stats: q('.stats'), credit: q('.credit'), danger: q('.danger'),
    };
    for (const c of [this.el.ink, this.el.kj]) c.width = c.height = STAMP_N;
    this._stampT = 0;
    this.el.stamp.addEventListener('animationend', (ev) => { if (ev.target === this.el.stamp) this.endStamp(); });
    this.hp = { v: 1, fill: 1, ghost: 1, hold: 0, flash: 0 };
    this.heat = { v: 0, shown: -1, full: false };
    this.comboN = 0; this.comboT = 0; this.moneyT = 0;
    this.mmRange = MM.range;
    // viewport cached on resize: reading innerWidth per frame after style writes forces a synchronous layout
    // the corner clusters (plate, minimap, location, objective) are laid out for 1920×1080 and scale down with a
    // smaller window (a laptop's browser is ~1500×860): at 0.7× the smallest text is still ~11 px
    const onResize = () => {
      this.vw = window.innerWidth; this.vh = window.innerHeight;
      this.uiK = Math.max(0.7, Math.min(1, this.vw / 1920, this.vh / 1080));
      if (this.root) this.root.style.setProperty('--hk', this.uiK.toFixed(3));
    };
    onResize(); window.addEventListener('resize', onResize);
    this._last = clock();
    this.setupMinimap();
    this.setupDamage();
    this.setHP(100, 100); this.setHeat(0);

    // font gate: canvas text (stamps, minimap labels) must not bake in a fallback face. Local faces resolve in a few ms;
    // the race keeps boot from ever hanging on it. The stamps are then pre-baked INSIDE the boot (init returns the
    // promise, under the loading screen): each costs 20–90 ms (ring noise, getImageData, blur), and baked on timers
    // after boot they landed one by one in the title, the intro and the ハチ公 face-off as 100–280 ms hitches.
    this.stampKanji = new Map(); this.stampRings = [];
    const fonts = document.fonts ? Promise.all([
      document.fonts.load(`700 360px ${BRUSH}`, STAMPS.join('')), document.fonts.load(`600 20px ${MINCHO}`, '目的渋谷町健連撃'),
      document.fonts.load(`800 30px ${SANS}`, '渋沢健人チンピラ半グレ兄貴分'), document.fonts.load('800 40px "SC Digits"', '0123456789'),
    ]) : Promise.resolve();
    const baked = Promise.race([fonts, new Promise((r) => setTimeout(r, 1500))]).catch(() => {}).then(async () => {
      this.fontsOK = true;
      // no installed brush face (a bare Linux box): the stamps melt a heavy gothic instead of texturing a print Mincho
      this.brushOK = [...(document.fonts || [])].some((f) => f.family.replace(/"/g, '') === 'SC Brush' && f.status === 'loaded');
      const todo = [...STAMPS.map((t) => () => this.kanjiFor(t)), ...[0, 1, 2].map((i) => () => this.ringFor(i))];
      let t = performance.now();
      for (const f of todo) {
        try { f(); } catch (e) { console.warn('[hud] stamp bake', e); break; }
        // let the loading screen paint between bakes
        if (performance.now() - t > 100) { await new Promise((r) => setTimeout(r, 0)); t = performance.now(); }
      }
    });

    engine.events.on('combat:hit', ({ target, damage, heavy, point, guarded } = {}) => {
      if (!target || target.isPlayer || target === engine.player || !target.position) return;
      if (point && point.isVector3) _w.copy(point);
      else _w.copy(target.position).setY(target.position.y + 1.4);
      this.damage(_w, damage, heavy, guarded, target);
      if (target.kind === 'enemy') this.showEnemy(target);
    });
    engine.events.on('combat:end', () => { for (const e of [...this.enemies.keys()]) this.dropEnemy(e); this.combo(0); });
    engine.events.on('combat:ko', ({ target } = {}) => this.hideEnemy(target));
    // ?hp=<n> (critics): pose the HP bar mid-hit — the bar at n with the white damage trail held 22 points above it
    const hpq = engine.params && engine.params.raw && engine.params.raw.hp;
    if (hpq != null && hpq !== '' && !isNaN(+hpq)) {
      engine.events.on('engine:ready', () => {
        const pl = engine.player; if (!pl) return;
        pl.hp = Math.max(1, Math.min(pl.hpMax || 100, +hpq));
        this.setHP(pl.hp, pl.hpMax);
        const h = this.hp; h.ghost = Math.min(1, h.v + 0.22); h.hold = engine.params.shot ? 1e9 : 0.8;
      });
    }
    if (engine.params && engine.params.stamp) {
      const fire = () => {
        this.stamp('極');
        if (engine.params.shot) { const s = this.el.stamp; s.style.animationDelay = '-0.42s'; s.style.animationPlayState = 'paused'; }
      };
      engine.events.on('engine:ready', fire);
    }
    return baked;
  },

  setVisible(v) { this.root.classList.toggle('hidden', !v); },
  showStats(v) { this.el.stats.classList.toggle('on', !!v); this.statsOn = !!v; },

  // ---------------------------------------------------------------------------------------------- HP / Heat
  setHP(v, max = 100) {
    const k = clamp01(v / Math.max(1, max)), h = this.hp;
    if (!(k >= 0) || k === h.v) return;
    if (k < h.v) { h.hold = 0.55; h.flash = 1; if (h.ghost < h.fill) h.ghost = h.fill; h.fill = k; }
    h.v = k;
  },
  setHeat(v) { this.heat.v = Math.max(0, Math.min(100, v || 0)); },

  paintBars(dt) {
    const h = this.hp;
    if (h.fill < h.v) h.fill = Math.min(h.v, h.fill + dt * 0.8);           // healing climbs, damage snaps
    if (h.hold > 0) h.hold -= dt; else if (h.ghost > h.fill) h.ghost = Math.max(h.fill, h.ghost - dt * 0.55);
    if (h.ghost < h.fill) h.ghost = h.fill;
    h.flash = Math.max(0, h.flash - dt * 4);
    const fw = h.fill.toFixed(4), gw = h.ghost.toFixed(4);
    if (fw !== this._fw) { this._fw = fw; this.el.hpFill.style.transform = `scaleX(${fw})`; }
    if (gw !== this._gw) { this._gw = gw; this.el.hpGhost.style.transform = `scaleX(${gw})`; }
    const tier = h.fill <= 0.25 ? 'low' : h.fill <= 0.5 ? 'mid' : 'ok';
    if (tier !== this._tier) { this._tier = tier; this.el.hp.dataset.tier = tier; this.el.danger.classList.toggle('on', tier === 'low' && h.fill > 0); }
    const fl = h.flash > 0.02;
    if (fl !== this._fl) { this._fl = fl; this.el.hp.classList.toggle('hit', fl); }

    const H = this.heat;
    const shown = H.shown < 0 ? H.v : H.shown + (H.v - H.shown) * Math.min(1, dt * 10);
    const snap = Math.abs(shown - H.v) < 0.2 ? H.v : shown;
    if (snap !== H.shown) {
      H.shown = snap;
      const per = 100 / this.el.segs.length;
      this.el.segs.forEach(({ s, f, e }, i) => {
        const k = clamp01((snap - i * per) / per);
        f.style.transform = `scaleX(${k.toFixed(3)})`;
        s.classList.toggle('lit', k >= 1);
        const part = k > 0.02 && k < 1;                                      // a filling stock carries a hot leading edge
        s.classList.toggle('part', part);
        if (part) e.style.transform = `translateX(${(k * 109 - 3).toFixed(1)}px)`;
      });
    }
    const full = H.v >= 100;
    if (full !== H.full) { H.full = full; this.el.heatRow.classList.toggle('max', full); this.el.plate.classList.toggle('heatmax', full); }
  },

  // ----------------------------------------------------------------------------------------- enemy plates
  showEnemy(entity) {
    if (!entity || entity.alive === false) return;
    let pl = this.enemies.get(entity);
    if (!pl) {
      const el = document.createElement('div');
      el.className = 'eplate';
      el.innerHTML = '<div class="en"><i class="mk"></i><span></span><b class="dn">ダウン</b></div><div class="ebar"><div class="in"><i class="ghost"></i><i class="fill"></i><i class="gloss"></i></div></div><i class="pin"></i>';
      // the leader: a hairline from a plate the layout had to move back to the head it belongs to
      const lead = document.createElement('i');
      lead.className = 'elead';
      this.enemies.set(entity, pl = { el, lead, name: el.querySelector('.en span'), fill: el.querySelector('.fill'), ghost: el.querySelector('.ghost'), pin: el.querySelector('.pin'),
        k: 1, g: 1, hold: 0, a: 0, dying: false, txt: '', lift: null, pinX: -1, bshow: false, bl: 0, br: 0, bt: 0 });
      this.el.enemies.appendChild(lead);
      this.el.enemies.appendChild(el);
    }
    pl.dying = false;
    const nm = entity.name || 'チンピラ';
    if (nm !== pl.txt) {
      pl.txt = nm; pl.name.textContent = nm;
      pl.elite = entity.rank === 'elite' || /兄貴|幹部/.test(nm);          // the priority target: longer bar, gold rank chip
      pl.el.classList.toggle('elite', pl.elite);
    }
  },
  hideEnemy(entity) { const pl = entity && this.enemies.get(entity); if (pl) { pl.dying = true; pl.dieT = 0.5; } },
  dropEnemy(entity) { const pl = this.enemies.get(entity); if (pl) { pl.el.remove(); pl.lead.remove(); this.enemies.delete(entity); } },

  /** a gold call-out over a man (enemy.js popText: スーパーアーマー). hud-owned so the plate layout makes room for it:
   *  it sits on top of HIS plate (never over another man's, never where a line of dialogue is), clears for a stamp
   *  like everything floating, and is gone after 1.2 s of real time */
  callout(entity, text) {
    if (!entity || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.className = 'ecall'; el.textContent = text;
    this.el.enemies.appendChild(el);
    (this.callouts || (this.callouts = [])).push({ e: entity, el, t: 0, op: -1 });
  },

  // over the head bone; a downed man's plate sits just above his pelvis (the visible middle of the body), not at his head
  anchorOf(e, out, pl, dt) {
    const h = e.humanoid, down = e.state === 'down';
    let ok = false;
    if (h && typeof h.boneWorld === 'function') { try { h.boneWorld(down ? 'Hips' : 'Head', out); ok = true; } catch (_) { ok = false; } }
    if (!ok) out.set(e.position.x, e.position.y + (down ? 0.25 : e.height || 1.8), e.position.z);
    out.y = down ? out.y + 0.35 : Math.max(out.y, e.position.y + 0.9) + 0.26;
    // held as an offset from the body root, eased, so the head → pelvis switch on a knockdown glides instead of jumping
    const ox = out.x - e.position.x, oy = out.y - e.position.y, oz = out.z - e.position.z;
    if (!pl) return out;
    if (pl.ox == null) { pl.ox = ox; pl.oy = oy; pl.oz = oz; }
    else { const r = Math.min(1, dt * 10); pl.ox += (ox - pl.ox) * r; pl.oy += (oy - pl.oy) * r; pl.oz += (oz - pl.oz) * r; }
    return out.set(e.position.x + pl.ox, e.position.y + pl.oy, e.position.z + pl.oz);
  },

  paintEnemies(dt) {
    const cam = this.engine.camera, W = this.vw, Hh = this.vh;
    const P = this.engine.player, lock = P && P.lockTarget;
    // ONE full plate (name + bar): the lock-on, else the man the camera frames (it takes whoever is winding up at
    // 健人), else the nearest. The rest are compact bars — a third of the height, dimmed — so three men never stack
    // three name plates into one block (readability review, P1).
    const camMod = this.engine.get('camera');
    let focus = lock && lock.alive !== false ? lock : camMod && camMod.target && this.enemies.has(camMod.target) ? camMod.target : null;
    const calls = this.callouts;
    if (calls) for (let i = calls.length - 1; i >= 0; i--) { const c = calls[i]; c.t += dt; if (c.t > 1.2 || c.e.gone || !this.enemies.has(c.e)) { c.el.remove(); calls.splice(i, 1); } }
    const ppmK = Hh / (2 * Math.tan((cam.fov * Math.PI) / 360));
    const boxes = this._boxes || (this._boxes = []);                     // pooled: no per-frame allocation
    let nb = 0;
    for (const [e, pl] of this.enemies) {
      const k = clamp01(e.hp / Math.max(1, e.hpMax || 1)) || 0;
      pl.bshow = false;
      if (e.alive === false && !pl.dying) this.hideEnemy(e);
      if (pl.dying) { pl.dieT -= dt; if (pl.dieT <= 0) { this.dropEnemy(e); continue; } }
      if (k < pl.k) { pl.hold = 0.45; if (pl.g < pl.k) pl.g = pl.k; pl.k = k; } else pl.k = k;
      if (pl.hold > 0) pl.hold -= dt; else if (pl.g > pl.k) pl.g = Math.max(pl.k, pl.g - dt * 0.7);
      const fw = pl.k.toFixed(3), gw = Math.max(pl.g, pl.k).toFixed(3);
      if (fw !== pl.fw) { pl.fw = fw; pl.fill.style.transform = `scaleX(${fw})`; }
      if (gw !== pl.gw) { pl.gw = gw; pl.ghost.style.transform = `scaleX(${gw})`; }

      this.anchorOf(e, _v, pl, dt);
      const dist = cam.position.distanceTo(_v);
      _d.copy(_v).project(cam);
      const vis = _d.z < 1 && Math.abs(_d.x) < 1.05 && Math.abs(_d.y) < 1.05 && dist < 34;
      const target = vis ? (pl.dying ? Math.max(0, pl.dieT / 0.5) : e.state === 'down' ? 0.85 : 1) : 0;
      pl.a += (target - pl.a) * Math.min(1, dt * 12);
      if (pl.a < 0.02) {
        if (pl.shown !== false) { pl.shown = false; pl.el.style.opacity = pl.op = '0'; pl.lead.style.opacity = pl.lop = '0'; }
        if (calls) for (const c of calls) if (c.e === e && c.op !== '0') { c.op = '0'; c.el.style.opacity = '0'; }
        continue;
      }
      pl.shown = true;
      const s = Math.max(0.78, Math.min(1.08, 9 / Math.max(1, dist)));
      const b = boxes[nb] || (boxes[nb] = {});
      nb++;
      b.pl = pl; b.e = e; b.s = s; b.dist = dist; b.lock = e === lock; b.fade = 1;
      b.ax = b.x = (_d.x * 0.5 + 0.5) * W; b.ay = b.y = (-_d.y * 0.5 + 0.5) * Hh - 10;
      b.ppm = ppmK / Math.max(0.5, dist);                                  // screen px per metre at his distance
      b.call = calls ? calls.find((c) => c.e === e) || null : null;
    }
    if (!focus && nb) { let bd = 1e9; for (let i = 0; i < nb; i++) if (boxes[i].dist < bd && boxes[i].e.state !== 'down') { bd = boxes[i].dist; focus = boxes[i].e; } }
    for (let i = 0; i < nb; i++) {
      const b = boxes[i], mini = b.e !== focus && nb > 1;
      if (mini !== b.pl.mini) { b.pl.mini = mini; b.pl.el.classList.toggle('mini', mini); }
      b.w0 = mini ? 130 : b.pl.elite ? 220 : 180; b.w = b.w0 * b.s;
      b.hp = (mini ? 20 : 44) * b.s;                                       // the plate itself
      b.h = b.hp + (b.call ? 34 : 0);                                      // + the room its call-out needs above it
      if (mini) b.fade = 0.78;
    }
    // near plates win their spot (insertion sort: a handful of plates)
    for (let i = 1; i < nb; i++) { const b = boxes[i]; let j = i - 1; while (j >= 0 && boxes[j].dist > b.dist) { boxes[j + 1] = boxes[j]; j--; } boxes[j + 1] = b; }

    // 健人's silhouette on screen (head to feet, widened): a plate never sits on the hero
    let hx0 = 0, hx1 = -1, hy0 = 0, hy1 = 0;
    if (P && P.position && nb) {
      const hm = P.humanoid;
      let ok = false;
      if (hm && typeof hm.boneWorld === 'function') { try { hm.boneWorld('Head', _h1); ok = true; } catch (_) { ok = false; } }
      if (!ok) _h1.set(P.position.x, P.position.y + (P.height || 1.8), P.position.z);
      _h1.y += 0.14; _h1.project(cam); _h2.copy(P.position).project(cam);
      if (_h1.z < 1 && _h2.z < 1) {
        const ax = (_h1.x * 0.5 + 0.5) * W, ay = (-_h1.y * 0.5 + 0.5) * Hh, bx = (_h2.x * 0.5 + 0.5) * W, by = (-_h2.y * 0.5 + 0.5) * Hh;
        const half = Math.max(24, (by - ay) * 0.2) + 40;
        hx0 = Math.min(ax, bx) - half; hx1 = Math.max(ax, bx) + half; hy0 = ay; hy1 = by;
      }
    }
    const onHero = (b) => hx1 > hx0 && b.x + b.w / 2 > hx0 && b.x - b.w / 2 < hx1 && b.y > hy0 && b.y - b.h < hy1;
    for (let i = 0; i < nb; i++) {
      const b = boxes[i];
      b.y = Math.max(150 + b.h, Math.min(Hh - 60, b.y));
      b.x = Math.max(24 + b.w / 2, Math.min(W - 24 - b.w / 2, b.x));
      if (onHero(b)) {
        // owner standing behind him: lift the plate over his head; owner beside him (a downed man): slide it to that side
        if (b.ax > hx0 + 40 && b.ax < hx1 - 40 && hy0 - 4 - b.h > 150) b.y = hy0 - 4;
        else { const nx = b.ax < (hx0 + hx1) / 2 ? hx0 - b.w / 2 - 4 : hx1 + b.w / 2 + 4; if (nx - b.w / 2 > 24 && nx + b.w / 2 < W - 24) b.x = nx; }
      }
      // never over another man's head: lift the plate above it (the leader ties it back to its own man)
      for (let j = 0; j < nb; j++) {
        if (j === i) continue;
        const o = boxes[j], hw = 0.22 * o.ppm, ht = o.ay + 4, hb = ht + 0.36 * o.ppm;
        if (b.x + b.w / 2 > o.ax - hw && b.x - b.w / 2 < o.ax + hw && b.y > ht && b.y - b.h < hb && ht - 2 - b.h > 150) b.y = ht - 2;
      }
      for (let it = 0; it < 4; it++) {
        let moved = false;
        for (let j = 0; j < i; j++) {
          const o = boxes[j];
          // boxes hang from their bottom edge (y) and are h tall — no longer all the same height (compact bars, a
          // call-out's room): overlap is tested edge to edge, and the later (farther) plate goes on top of the other
          if (Math.abs(o.x - b.x) < (o.w + b.w) / 2 && b.y - b.h < o.y - 2 && o.y - o.h < b.y - 2) { b.y = o.y - o.h - 2; moved = true; }
        }
        if (!moved) break;
      }
    }
    // keep clear of the combo counter and the minimap (1080p layout)
    const comboOn = this.comboT > 0, uiK = this.uiK || 1;
    for (let i = 0; i < nb; i++) {
      const b = boxes[i], l = b.x - b.w / 2, r = b.x + b.w / 2;
      if (comboOn && r > W - 330 && b.y > Hh * 0.35 - 4 && b.y - b.h < Hh * 0.35 + 170) b.x = W - 338 - b.w / 2;
      if (r > W - 310 * uiK && b.y > Hh - 300 * uiK) b.y = Hh - 302 * uiK;
      if (l < 620 * uiK && b.y - b.h < 150 * uiK) b.y = 150 * uiK + b.h;
      // a line of dialogue at the bottom is never covered: the plate goes above it
      const sr = this._subRect;
      if (sr && b.x + b.w / 2 > sr.x0 - 8 && b.x - b.w / 2 < sr.x1 + 8 && b.y > sr.y0 - 26 && b.y - b.h < sr.y1) b.y = sr.y0 - 28;
      if (onHero(b)) b.fade = 0.35;                                        // nowhere clean to go: step back
    }
    // the clamps above can push a plate back into one that was stacked clear of it: one last pass (up, or below
    // the other when up would leave the screen)
    for (let i = 1; i < nb; i++) {
      const b = boxes[i];
      for (let j = 0; j < i; j++) {
        const o = boxes[j];
        if (!(Math.abs(o.x - b.x) < (o.w + b.w) / 2 && b.y - b.h < o.y - 2 && o.y - o.h < b.y - 2)) continue;
        b.y = o.y - o.h - 2 - b.h > 8 ? o.y - o.h - 2 : o.y + 2 + b.h;
      }
    }
    for (let i = 0; i < nb; i++) {
      const b = boxes[i], pl = b.pl;
      pl.el.style.transform = `translate3d(${b.x.toFixed(1)}px,${b.y.toFixed(1)}px,0) scale(${b.s.toFixed(3)})`;
      const op = (pl.a * b.fade).toFixed(3);
      if (op !== pl.op) { pl.op = op; pl.el.style.opacity = op; }
      // leader: from the pin's tip to the top of his head, when the layout moved the plate off it
      const tipX = b.x + (Math.max(14, Math.min(b.w0 - 14, (b.ax - b.x) / b.s + b.w0 / 2)) - b.w0 / 2) * b.s, tipY = b.y;
      const hx = b.ax, hy = b.ay + 12, ll = Math.hypot(hx - tipX, hy - tipY);
      const lop = ll > 18 ? op : '0';
      if (lop !== pl.lop) { pl.lop = lop; pl.lead.style.opacity = lop; }
      if (ll > 18) pl.lead.style.transform = `translate3d(${tipX.toFixed(1)}px,${tipY.toFixed(1)}px,0) rotate(${Math.atan2(hy - tipY, hx - tipX).toFixed(4)}rad) scaleX(${(ll - 4).toFixed(1)})`;
      // his call-out rides on top of his plate, in the room the layout kept for it
      if (b.call) {
        const c = b.call, a = c.t < 0.9 ? 1 : Math.max(0, (1.2 - c.t) / 0.3), sc = 1 + Math.max(0, 0.12 - c.t) / 0.12 / 3;
        c.el.style.transform = `translate3d(${b.x.toFixed(1)}px,${(b.y - b.hp - 4).toFixed(1)}px,0) translate(-50%,-100%) scale(${sc.toFixed(3)})`;
        const cop = (a * pl.a).toFixed(2);
        if (cop !== c.op) { c.op = cop; c.el.style.opacity = cop; }
      }
      // the pin follows its owner when the plate was slid aside
      const px = Math.round(Math.max(14, Math.min(b.w0 - 14, (b.ax - b.x) / b.s + b.w0 / 2)));
      if (px !== pl.pinX) { pl.pinX = px; pl.pin.style.left = px + 'px'; }
      if (b.lock !== pl.lock) { pl.lock = b.lock; pl.el.classList.toggle('lock', b.lock); }
      const down = b.e.state === 'down';
      if (down !== pl.down) { pl.down = down; pl.el.classList.toggle('down', down); }
      pl.bshow = b.fade > 0.5 && pl.a > 0.3; pl.bl = b.x - b.w / 2; pl.br = b.x + b.w / 2; pl.bt = b.y - b.h;
      pl.bt = b.y - b.hp; pl.bb = b.y; pl.ax = b.ax; pl.ay = b.ay; pl.opv = pl.a * b.fade;   // (read by the readability probe)
      b.pl = b.e = null;
    }
  },
  // ---------------------------------------------------------------------------------------------- combo
  combo(n) {
    n = n | 0;
    const prev = this.comboN;
    this.comboN = n;
    if (n > 1) {
      this.el.comboN.textContent = n;
      this.el.combo.classList.add('on');
      if (n !== prev && this.el.comboN.animate) this.el.comboN.animate(COMBO_POP, { duration: 240, easing: 'cubic-bezier(.2,1.5,.4,1)' });
      this.comboT = 2.5;
    } else { this.comboT = 0; this.el.combo.classList.remove('on'); }
  },
  objective(text) {
    const t = text || '';
    if (t === this._obj) return;
    this._obj = t;
    this.el.objective.textContent = t;
    const o = this.el.objective.parentElement;
    o.classList.toggle('empty', !t);
    if (t) { o.classList.remove('new'); void o.offsetWidth; o.classList.add('new'); }
  },
  subtitle(text, seconds = 3, speaker = '') {
    let who = speaker, line = text || '';
    const m = !who && (/^([^「」：:\n]{1,12})「([\s\S]+)」$/.exec(line) || /^([^「」：:\n]{1,12})[：:]\s*([\s\S]+)$/.exec(line));
    if (m) { who = m[1]; line = m[2]; }
    this.el.subWho.textContent = who || '';
    this.el.subWho.style.display = who ? '' : 'none';
    this.el.subLine.textContent = line;
    this.el.subtitle.classList.toggle('on', !!line);
    // its box, read once per line: the enemy plates keep out of it
    if (line) { const r = this.el.subtitle.getBoundingClientRect(); this._subRect = { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }; } else this._subRect = null;
    clearTimeout(this._subT);
    if (line && seconds > 0) this._subT = setTimeout(() => { this.el.subtitle.classList.remove('on'); this._subRect = null; }, seconds * 1000);
  },
  letterbox(on) { this.root.classList.toggle('letterbox', !!on); },

  // ---------------------------------------------------------------------------------------------- stamp
  // A brush 円相 in vermilion with a dry-brush kanji slammed over it. Both layers are baked once per kanji / ring
  // variant (after the font gate) and blitted here. Everything animates off the .stamp node's own timeline
  // (children inherit its delay / play-state), so callers can hold the frame by pausing .stamp alone.
  stamp(text) {
    const s = this.el.stamp, t = text || '極', n = (this._stampN = (this._stampN || 0) + 1);
    const kj = this.kanjiFor(t), ring = this.ringFor(n % 3);
    const gi = this.el.ink.getContext('2d'), gk = this.el.kj.getContext('2d');
    gi.clearRect(0, 0, STAMP_N, STAMP_N); gi.drawImage(ring, 0, 0);
    gk.clearRect(0, 0, STAMP_N, STAMP_N); gk.drawImage(kj, 0, 0);
    s.style.setProperty('--rot', (-9 + ((n * 0.618034) % 1) * 6).toFixed(1) + 'deg');
    s.classList.remove('on'); void s.offsetWidth; s.classList.add('on');
    // the stamp owns the frame: every floating element (plates, numbers, combo) clears until it has played out
    this._stampT = STAMP_LEN; this.root.classList.add('stamping');
    for (const m of this.dmgPool) if (m.live) { m.live = false; m.op = 0; m.el.style.opacity = '0'; }
  },
  endStamp() { this._stampT = 0; this.root.classList.remove('stamping'); },
  kanjiFor(text) {
    let c = this.stampKanji.get(text);
    if (!c) { c = this.bakeKanji(text); if (this.fontsOK) this.stampKanji.set(text, c); }   // pre-gate bakes are not kept
    return c;
  },
  ringFor(i) { return this.stampRings[i] || (this.stampRings[i] = this.bakeRing(0x51ed + i * 7919)); },

  // the 円相: one vermilion stroke, fat where the brush lands and dry at the tail. Shaded per pixel in stroke space
  // (arc length along, depth across), so the bristle streaks follow the stroke and break up along their length,
  // the rims are ragged, and the tail thins out into dry-brush hairs instead of a clean vector end.
  bakeRing(seed) {
    const N = STAMP_N, C = N / 2, R = 226, cv = mkCanvas(N), g = cv.getContext('2d');
    let r = seed >>> 0;
    const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
    const a0 = -2.25 + rnd() * 0.5, sweep = 5.3 + rnd() * 0.45, TAU = Math.PI * 2;
    const width = (t) => (t < 0.1 ? 40 + t * 420 : 82 - 66 * Math.pow((t - 0.1) / 0.9, 1.3));
    const wob = (t) => R + Math.sin(t * 7 + seed * 0.001) * 6;
    const nb = valueNoise(seed), ne = valueNoise(seed ^ 0x2c1b), nt = valueNoise(seed ^ 0x7f4a);
    // ink soaking into the paper only along the stroke: an annulus, never a disc over the fight
    const gr = g.createRadialGradient(C, C, R * 0.82, C, C, R * 1.08);
    gr.addColorStop(0, 'rgba(150,10,22,0)'); gr.addColorStop(0.5, 'rgba(150,10,22,.14)'); gr.addColorStop(1, 'rgba(150,10,22,0)');
    g.fillStyle = gr; g.fillRect(0, 0, N, N);
    const img = g.getImageData(0, 0, N, N), o = img.data;
    const sx0 = C + Math.cos(a0) * wob(0), sy0 = C + Math.sin(a0) * wob(0), w0 = width(0);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x - C, dy = y - C, rad = Math.hypot(dx, dy);
        if (rad < R - 58 || rad > R + 58) continue;
        let rel = Math.atan2(dy, dx) - a0; rel = ((rel % TAU) + TAU) % TAU;
        let t = rel / sweep, d, w;
        if (t <= 1) { w = width(t); d = (rad - wob(t)) / (w / 2); }
        else {                                                               // the round landing cap before the start
          const cd = Math.hypot(x - sx0, y - sy0); if (cd > w0 / 2 + 3) continue;
          t = 0; w = w0; d = cd / (w0 / 2);
        }
        const s = (a0 + t * sweep) * R, dry = smooth(0.5, 1, t);
        const rough = (ne(s * 0.09, d * 2) - 0.5) * (0.22 + dry * 0.4);
        let al = 1 - smooth(0.84 + rough, 1 + rough, Math.abs(d));
        if (al <= 0) continue;
        const st = 0.7 * nb(s * 0.02, (rad - wob(t)) * 0.34) + 0.3 * nb(s * 0.07 + 31, (rad - wob(t)) * 0.9);
        const lo = 0.66 - dry * 0.26;                                       // bristle gaps, heavier at the rims and the tail
        al *= 1 - smooth(lo, lo + 0.1, st) * (0.45 + 0.55 * Math.max(dry, d * d)) * 0.95;
        if (t > 0.9) al *= 1 - smooth(0.9, 1, t) * smooth(0.35, 0.55, nb(s * 0.01, 5));   // the last hairs let go
        if (al < 0.01) continue;
        const fib = smooth(0.4, 0.22, st) * (1 - dry * 0.5);                // ink-heavy bristles run darker
        // 朱墨: a warm vermilion body that pools to oxblood where the brush lands, at the rims and along wet bristles
        const tone = nt(x * 0.02, y * 0.02), pool = Math.min(1, Math.max(1 - t / 0.07, 0) * 0.7 + d * d * 0.4 + fib * 0.6 + (1 - tone) * 0.18);
        const i = (y * N + x) * 4, A = al * 0.97, B = o[i + 3] / 255 * (1 - A);  // over the soak
        const rr = 178 + tone * 34 - pool * 110, gg = 34 + tone * 16 - pool * 26, bb = 30 + tone * 8 - pool * 20;
        const oa = A + B;
        o[i] = (rr * A + o[i] * B) / oa; o[i + 1] = (gg * A + o[i + 1] * B) / oa; o[i + 2] = (bb * A + o[i + 2] * B) / oa; o[i + 3] = oa * 255;
      }
    }
    g.putImageData(img, 0, 0);
    for (let k = 0; k < 8; k++) {                                          // a few drops shaken loose at the outer rim
      const tt = 0.06 + rnd() * 0.55, a = a0 + sweep * tt, d = wob(tt) + width(tt) / 2 * (0.62 + rnd() * 0.5), sz = Math.pow(rnd(), 2) * 4 + 1.2;
      g.fillStyle = `rgba(${150 + (rnd() * 30) | 0},${22 + (rnd() * 10) | 0},22,${(0.75 + rnd() * 0.2).toFixed(2)})`;
      g.beginPath(); g.ellipse(C + Math.cos(a) * d, C + Math.sin(a) * d, sz * (1 + rnd() * 1.2), sz, a + Math.PI / 2, 0, Math.PI * 2); g.fill();
    }
    return cv;
  },

  // the kanji: set in the brush face, then worked over per pixel so even a print fallback reads as 毛筆 —
  // softened terminals, a slow wobble and ragged rims, but the stroke bodies stay solid ink: dry-brush breaks live
  // only within a few px of a rim (a distance transform of the glyph), and 飛白 streaks run through the last stroke
  // along its direction (a smoothed structure tensor, so it holds at the stroke's centreline too). A 2 px oxblood
  // keyline outside the ink separates it from the street without a halo.
  bakeKanji(text, melt = this.fontsOK && !this.brushOK) {
    const N = STAMP_N, C = N / 2, ty = C + 8, NN = N * N;
    const size = text.length > 1 ? 300 / text.length + 60 : 372;
    let seed = 7;
    for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const nz = valueNoise(seed), ns = valueNoise(seed ^ 0x9e37), nh = valueNoise(seed ^ 0x51f1);
    const A = mkCanvas(N), a = A.getContext('2d', { willReadFrequently: true });
    const glyph = (blur) => {
      a.clearRect(0, 0, N, N); a.filter = blur ? `blur(${blur}px)` : 'none';
      a.font = melt ? `800 ${size * 0.94}px ${SANS}` : `700 ${size}px ${BRUSH}`; a.textAlign = 'center'; a.textBaseline = 'middle'; a.fillStyle = '#000';
      a.fillText(text, C, ty);
      return a.getImageData(0, 0, N, N).data;
    };
    const src = glyph(melt ? 4 : 1.6), wide = glyph(6), amp = melt ? 13 : 6, cut = melt ? 0.4 : 0.5;
    a.filter = 'none';
    // px inside the rim (chamfer 1 / √2) on the thresholded glyph
    const D = new Float32Array(NN), T0 = cut * 255;
    for (let i = 0; i < NN; i++) D[i] = src[i * 4 + 3] > T0 ? 1e4 : 0;
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) { const i = y * N + x; if (D[i]) D[i] = Math.min(D[i], D[i - 1] + 1, D[i - N] + 1, D[i - N - 1] + 1.414, D[i - N + 1] + 1.414); }
    for (let y = N - 2; y > 0; y--) for (let x = N - 2; x > 0; x--) { const i = y * N + x; if (D[i]) D[i] = Math.min(D[i], D[i + 1] + 1, D[i + N] + 1, D[i + N + 1] + 1.414, D[i + N - 1] + 1.414); }
    // stroke orientation: the gradient's structure tensor, box-smoothed over ~a stroke width
    const Jxx = new Float32Array(NN), Jyy = new Float32Array(NN), Jxy = new Float32Array(NN);
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const i = y * N + x, gx = wide[(i + 1) * 4 + 3] - wide[(i - 1) * 4 + 3], gy = wide[(i + N) * 4 + 3] - wide[(i - N) * 4 + 3];
      Jxx[i] = gx * gx; Jyy[i] = gy * gy; Jxy[i] = gx * gy;
    }
    for (const J of [Jxx, Jyy, Jxy]) boxBlur(J, N, 10);
    // where the brush leaves the paper: the last stroke's terminal, the inked pixel furthest to the lower right
    let x0 = N, x1 = 0, hx = C, hy = C, best = -Infinity;
    for (let y = 0; y < N; y += 2) for (let x = 0; x < N; x += 2) if (src[(y * N + x) * 4 + 3] > 128) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (x + y * 1.3 > best) { best = x + y * 1.3; hx = x; hy = y; }
    }
    const hr = Math.max(40, (x1 - x0) * 0.3);
    const out = a.createImageData(N, N), o = out.data, sil = a.createImageData(N, N), so = sil.data;
    const BINS = 16;
    for (let y = 2; y < N - 2; y++) {
      for (let x = 2; x < N - 2; x++) {
        const i = y * N + x;
        if (wide[i * 4 + 3] < 4) continue;
        const dx = (nz(x * 0.017, y * 0.017) - 0.5) * amp, dy = (nz(x * 0.017 + 41, y * 0.017 + 13) - 0.5) * amp;
        const sx = Math.min(N - 1, Math.max(0, Math.round(x + dx))), sy = Math.min(N - 1, Math.max(0, Math.round(y + dy))), si = sy * N + sx;
        const s = src[si * 4 + 3] / 255;
        if (s < 0.08) continue;
        const rim = 1 - smooth(1, 5.5, D[si]);                               // 1 on the rim, 0 from ~5 px in
        // along-stroke frame, quantised so a straight stroke gets one clean streak frame
        let ang = 0.5 * Math.atan2(2 * Jxy[si], Jxx[si] - Jyy[si]) + Math.PI / 2;
        ang = Math.round(((ang % Math.PI) + Math.PI) % Math.PI / (Math.PI / BINS)) * (Math.PI / BINS);
        const tx = Math.cos(ang), tyy = Math.sin(ang), u = x * tx + y * tyy, v = -x * tyy + y * tx;
        const st = 0.7 * ns(u * 0.014, v * 0.24) + 0.3 * ns(u * 0.04 + 17, v * 0.6);
        const th = cut + (st - 0.5) * 0.5 * (0.15 + rim);                   // ragged rims, clean bodies
        let al = smooth(th - 0.07, th + 0.07, s);
        if (al < 0.01) continue;
        so[i * 4 + 3] = al * 255;
        al *= 1 - smooth(0.62, 0.76, st) * rim * 0.85;                       // dry-brush breaks at the rims only
        // 飛白: long, thin dry streaks opening up along the last stroke as it runs out, strongest at its terminal
        const hk = clamp01(1 - Math.hypot(x - hx, y - hy) / hr);
        if (hk > 0) al *= 1 - smooth(0.62 - hk * 0.2, 0.7 - hk * 0.2, nh(u * 0.0035, v * 0.34)) * smooth(0, 0.5, hk) * 0.95;
        if (al < 0.01) continue;
        const tone = nz(x * 0.011 + 90, y * 0.011);
        const k = 1 - rim * 0.8;                                             // bodies a touch lighter, rims pooled black
        o[i * 4] = 5 + (6 + tone * 10) * k; o[i * 4 + 1] = 4 + (5 + tone * 7) * k; o[i * 4 + 2] = 4 + (5 + tone * 7) * k;
        o[i * 4 + 3] = al * 250;
      }
    }
    // keyline: the solid silhouette dilated 2 px, tinted oxblood, with the silhouette itself cut back out
    const K = mkCanvas(N), kg = K.getContext('2d');
    a.putImageData(sil, 0, 0);
    for (let j = 0; j < 12; j++) { const t = (j / 12) * Math.PI * 2; kg.drawImage(A, Math.cos(t) * 2, Math.sin(t) * 2); }
    kg.globalCompositeOperation = 'source-in'; kg.fillStyle = 'rgb(90,0,0)'; kg.fillRect(0, 0, N, N);
    kg.globalCompositeOperation = 'destination-out'; kg.drawImage(A, 0, 0);
    a.putImageData(out, 0, 0);
    const cv = mkCanvas(N), g = cv.getContext('2d');
    g.globalAlpha = 0.8; g.drawImage(K, 0, 0); g.globalAlpha = 1;
    g.drawImage(A, 0, 0);
    return cv;
  },

  // ----------------------------------------------------------------------------------------- damage numbers
  // One live number per target, from a pool of 16 nodes. A follow-up within 0.35 s tallies into it (12 → 24 → 36)
  // and re-pops it; a later hit replaces it outright, so numbers never pile into a glyph heap. Anchored to the
  // world point that was hit, re-projected every frame, drifting up a fixed 48 px on screen.
  setupDamage() {
    this.dmgPool = [];
    for (let i = 0; i < 16; i++) {
      const el = document.createElement('div');
      el.className = 'dmg'; el.innerHTML = '<b></b>';
      this.el.dmgs.appendChild(el);
      this.dmgPool.push({ el, b: el.firstChild, live: false, pos: new THREE.Vector3(), t: 0, life: 0, last: 0, amount: 0, target: null, jx: 0, anim: null, cls: 'dmg', op: 0, fs: 38, hw: 24 });
    }
    this.dmgs = this.dmgPool;
  },
  damage(worldPos, amount, heavy = false, guarded = false, target = null) {
    if (!worldPos || !(amount > 0) || this._stampT > 0) return;              // nothing floats under a stamp
    if (!target) {                                                         // a bare point: the man standing on it owns the number
      let bd = 2.6;
      for (const e of this.enemies.keys()) {
        const q = e.position; if (!q) continue;
        const d = (q.x - worldPos.x) ** 2 + (q.z - worldPos.z) ** 2;
        if (d < bd) { bd = d; target = e; }
      }
    }
    const now = clock();
    let n = null;
    for (const m of this.dmgPool) {
      if (!m.live) continue;
      const same = target ? m.target === target : !m.target && m.pos.distanceToSquared(worldPos) < 0.6;
      if (!same) continue;
      if (!n && now - m.last < 0.35 && !guarded && !m.guard) { n = m; continue; }
      m.live = false; m.op = 0; m.el.style.opacity = '0';
    }
    if (n) { n.amount += amount; n.heavy = true; n.life = n.t + 1.05; }
    else {
      n = this.dmgPool.find((m) => !m.live) || this.dmgPool.reduce((p, q) => (p.t > q.t ? p : q));
      this._dmgK = ((this._dmgK || 0) + 1) % 4;
      Object.assign(n, { live: true, amount, heavy, guard: guarded, target, t: 0, life: heavy ? 1.05 : 0.85, jx: [0, 14, -10, 8][this._dmgK] });
      n.pos.copy(worldPos);
    }
    n.last = now;
    const tier = n.guard ? 'guard' : n.amount >= 30 ? 'fin' : n.heavy ? 'heavy' : 'dmg';
    const cls = 'dmg' + (n.heavy ? ' heavy' : '') + (n.amount >= 30 ? ' fin' : '') + (n.guard ? ' guard' : '');
    if (cls !== n.cls) { n.cls = cls; n.el.className = cls; }
    n.b.textContent = Math.round(n.amount);
    n.fs = DMG_FS[tier]; n.hw = String(Math.round(n.amount)).length * n.fs * 0.27 + 4;   // half width, for the plate hook
    if (n.anim) n.anim.cancel();
    n.anim = n.b.animate ? n.b.animate(DMG_POP, { duration: 240, easing: 'ease-out', fill: 'both' }) : null;
    n.op = 1; n.el.style.opacity = '1';
    this.projectDamage(n);
  },
  // hooked to its target's plate when that plate is up (just past its right end, above its top edge), so the number
  // always reads as that man's; otherwise it rides the world point that was hit
  projectDamage(n) {
    const rise = 48 * (1 - Math.pow(1 - clamp01(n.t / 0.85), 2));
    const pl = n.target && this.enemies.get(n.target);
    let x, y;
    if (pl && pl.bshow) {
      x = pl.br + 14 + n.hw; y = pl.bt - 6 - n.fs * 0.3 - rise * 0.4;
      if (x + n.hw > this.vw - 24) x = pl.bl - 14 - n.hw;
    } else {
      _d.copy(n.pos).project(this.engine.camera);
      if (_d.z > 1) { n.el.style.opacity = '0'; n.op = -1; return; }
      x = (_d.x * 0.5 + 0.5) * this.vw + n.jx; y = (-_d.y * 0.5 + 0.5) * this.vh - rise;
    }
    n.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
  },
  paintDamage(dt) {
    for (const n of this.dmgPool) {
      if (!n.live) continue;
      n.t += dt;
      if (n.t >= n.life) { n.live = false; n.op = 0; n.el.style.opacity = '0'; continue; }
      const op = Math.round(Math.min(1, (n.life - n.t) / 0.25) * 100) / 100;
      if (op !== n.op) { n.op = op; n.el.style.opacity = String(op); }
      this.projectDamage(n);
    }
  },

  // ---------------------------------------------------------------------------------------------- minimap
  // addMapLayer(fn): fn(ctx, project(x, z) -> [sx, sy], info) draws screen-space icons on the minimap (info.mini, the
  // disc centre C / radius R in CSS px; project's array is reused — read it at once) and on the pause world map
  // (info.mini false, info.css = the map's size). Called every minimap repaint (30 Hz) and once per pause.
  mapLayers: [],
  addMapLayer(fn) { if (typeof fn === 'function' && !this.mapLayers.includes(fn)) this.mapLayers.push(fn); return fn; },

  setupMinimap() {
    const cv = this.el.minimap;
    this.mapDpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.height = Math.round(MM.box * this.mapDpr);
    this.mapCtx = cv.getContext('2d');
    this.mapT = 0; this.areaT = 0; this._mapRetry = 0;
    this.map = null; this.mapBakes = {};
    this.ring = this.paintRing();
    this.arrow = this.paintArrow();
    this.north = this.paintNorth();
    const C = MM.box / 2;
    this.cone = this.mapCtx.createRadialGradient(C, C, 4, C, C, MM.r * 0.72);
    this.cone.addColorStop(0, 'rgba(255,222,140,.3)'); this.cone.addColorStop(1, 'rgba(255,222,140,0)');
    this._mp = [0, 0]; this._lab = { n: 0, nt: 0, font: '', taken: [] };
  },

  buildMap() {
    const city = this.engine.get('city');
    const M = { roads: [], walks: [], plazas: [], blds: [], marks: [], rail: [], zebras: [], stops: [], labels: [], streets: [] };
    for (const r of CITY.roads) {
      const sw = r.width + 2 * (r.sidewalk || 0);
      M.roads.push({ path: r.path, w: r.width, sw, bb: bbox(r.path, sw / 2) });
      let acc = 35;                                                        // a street name every ~80 m of road
      for (let i = 0; i < r.path.length - 1; i++) {
        const [ax, az] = r.path[i], [bx, bz] = r.path[i + 1], L = Math.hypot(bx - ax, bz - az);
        while (acc < L) { const t = acc / L; M.streets.push({ text: tidyName(r.name), x: ax + (bx - ax) * t, z: az + (bz - az) * t, kind: 'road' }); acc += 80; }
        acc -= L;
      }
    }
    for (const p of CITY.pedestrianStreets) M.walks.push({ path: p.path, w: p.width, bb: bbox(p.path, p.width / 2) });
    for (const p of CITY.plazas) M.plazas.push({ poly: p.polygon, bb: bbox(p.polygon), trees: p.trees || [] });
    for (const b of (city && city.plan && city.plan.buildings) || []) if (b.poly && b.poly.length > 2) M.blds.push({ poly: b.poly, bb: bbox(b.poly) });
    for (const [key, l] of Object.entries(CITY.landmarks)) {
      if (!l.storeys || !l.size) continue;
      const poly = l.polygon || rectPoly(l.pos[0], l.pos[1], l.size[0], l.size[2], l.rotY || 0);
      M.marks.push({ poly, bb: bbox(poly), cyl: l.cylinder || null });
      if (LABELS[key]) { const c = l.cylinder ? l.cylinder.center : l.polygon ? centroid(l.polygon) : l.pos; M.labels.push({ text: LABELS[key], x: c[0], z: c[1], kind: 'mark' }); }
    }
    const hk = CITY.landmarks.hachikoStatue;
    if (hk) M.labels.unshift({ text: 'ハチ公', x: hk.pos[0], z: hk.pos[1], kind: 'hachiko' });
    const cg = CITY.pedestrianStreets.find((p) => p.id === 'centergai');
    if (cg) M.labels.push({ text: 'センター街', x: cg.path[4][0], z: cg.path[4][1], kind: 'street' });
    for (const r of Object.values(CITY.rail)) M.rail.push({ path: r.path, w: r.width, bb: bbox(r.path, r.width / 2) });
    const cr = CITY.crossing;
    for (const c of [...cr.crosswalks, ...cr.diagonals, ...(CITY.crosswalksExtra || [])]) M.zebras.push({ a: c.a, b: c.b, w: c.width, bb: bbox([c.a, c.b], c.width / 2) });
    M.stops = cr.stopLines || [];
    // label styles resolved once; widths are measured once (after the font gate) and cached on the label
    const LS = { hachiko: [12, `700 12px ${SANS}`, '#e9e2cc', 14, 13], street: [12, `600 12px ${SANS}`, '#e9c889', 18, 0],
      mark: [13, `600 13px ${SANS}`, '#ece2c4', 18, 0], road: [12, `500 12px ${SANS}`, '#c3cad6', 22, 0] };
    for (const l of M.labels.concat(M.streets)) { const s = LS[l.kind]; l.size = s[0]; l.font = s[1]; l.fill = s[2]; l.pad = s[3]; l.dy = s[4]; l.w = 0; }
    this.map = M; this.mapBakes = {};
  },

  // the static layer (ground, roads, zebras, blocks, landmarks, rail) for one zoom band, baked over 3× the disc around
  // (cx, cz). drawMinimap only rotates and blits it, and re-bakes when the player walks toward its edge.
  bakeMap(band, cx, cz) {
    const M = this.map, dpr = this.mapDpr, S = MM.r * 6, k = MM.r / band, half = band * 3;
    let L = this.mapBakes[band];
    if (!L) { const c = mkCanvas(Math.round(S * dpr)); L = this.mapBakes[band] = { c, g: c.getContext('2d'), k, S, cx: 0, cz: 0 }; }
    L.cx = cx; L.cz = cz;
    const ctx = L.g, x0 = cx - half, x1 = cx + half, z0 = cz - half, z1 = cz + half;
    const vis = (bb) => !(bb[2] < x0 || bb[0] > x1 || bb[3] < z0 || bb[1] > z1);
    const trace = (pts, close) => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); if (close) ctx.closePath(); };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COL.base; ctx.fillRect(0, 0, S, S);
    ctx.translate(S / 2, S / 2); ctx.scale(k, k); ctx.translate(-cx, -cz);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = COL.walk;
    for (const r of M.roads) if (vis(r.bb)) { ctx.lineWidth = r.sw; trace(r.path); ctx.stroke(); }
    ctx.strokeStyle = COL.paving;
    for (const w of M.walks) if (vis(w.bb)) { ctx.lineWidth = w.w; trace(w.path); ctx.stroke(); }
    ctx.fillStyle = COL.plaza;
    for (const pz of M.plazas) if (vis(pz.bb)) { trace(pz.poly, true); ctx.fill(); }
    ctx.fillStyle = COL.tree;
    for (const pz of M.plazas) if (vis(pz.bb)) for (const [tx, tz] of pz.trees) { ctx.beginPath(); ctx.arc(tx, tz, 2.2, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = COL.road;
    for (const r of M.roads) if (vis(r.bb)) { ctx.lineWidth = r.w; trace(r.path); ctx.stroke(); }
    const cr = CITY.crossing;
    ctx.fillStyle = COL.road; ctx.beginPath(); ctx.arc(cr.center[0], cr.center[1], cr.radius, 0, Math.PI * 2); ctx.fill();
    // zoomed in for a fight the zebras step well back: at 28 m they would otherwise be the whole disc
    ctx.lineCap = 'butt'; ctx.strokeStyle = COL.zebra; ctx.setLineDash([1.25, 1.25]); ctx.globalAlpha = band < MM.range ? 0.35 : 1;
    for (const zb of M.zebras) if (vis(zb.bb)) { ctx.lineWidth = zb.w; ctx.beginPath(); ctx.moveTo(zb.a[0], zb.a[1]); ctx.lineTo(zb.b[0], zb.b[1]); ctx.stroke(); }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.strokeStyle = COL.stop; ctx.lineWidth = 0.7;
    for (const s of M.stops) { ctx.beginPath(); ctx.moveTo(s.a[0], s.a[1]); ctx.lineTo(s.b[0], s.b[1]); ctx.stroke(); }
    ctx.lineJoin = 'miter';
    ctx.fillStyle = COL.bld; ctx.strokeStyle = COL.bldEdge; ctx.lineWidth = 1 / k;
    for (const b of M.blds) if (vis(b.bb)) { trace(b.poly, true); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = COL.mark; ctx.strokeStyle = COL.markEdge; ctx.lineWidth = 1.3 / k;
    for (const m of M.marks) if (vis(m.bb)) {
      trace(m.poly, true); ctx.fill(); ctx.stroke();
      if (m.cyl) { ctx.beginPath(); ctx.arc(m.cyl.center[0], m.cyl.center[1], m.cyl.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    for (const r of M.rail) if (vis(r.bb)) {
      ctx.strokeStyle = COL.rail; ctx.lineWidth = r.w; trace(r.path); ctx.stroke();
      ctx.strokeStyle = COL.track; ctx.lineWidth = 1.2 / k; ctx.setLineDash([3, 2]);
      for (const o of [-r.w * 0.22, r.w * 0.22]) {
        ctx.beginPath();
        r.path.forEach(([x, z], i) => {
          const q = r.path[Math.min(i + 1, r.path.length - 1)], pr = r.path[Math.max(i - 1, 0)];
          const dx = q[0] - pr[0], dz = q[1] - pr[1], D = Math.hypot(dx, dz) || 1;
          const ox = x - (dz / D) * o, oz = z + (dx / D) * o;
          if (i === 0) ctx.moveTo(ox, oz); else ctx.lineTo(ox, oz);
        });
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  },

  // ---- the pause screen's whole-city map (menus.pause): north up, every street / block / landmark, 健人 as the
  // arrow, the objective and the open substories. Drawn once per pause into the caller's canvas.
  drawWorldMap(cv, css) {
    const engine = this.engine;
    if (!this.map || !this.map.blds.length) this.buildMap();
    const M = this.map, dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.height = Math.round(css * dpr); cv.style.width = cv.style.height = css + 'px';
    const g = cv.getContext('2d');
    // frame the streets (not the empty far corners of the bounds)
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const r of M.roads) { x0 = Math.min(x0, r.bb[0]); z0 = Math.min(z0, r.bb[1]); x1 = Math.max(x1, r.bb[2]); z1 = Math.max(z1, r.bb[3]); }
    const half = Math.min(Math.max(x1 - x0, z1 - z0) / 2 + 10, (CITY.bounds || 440) / 2 + 30);
    const cx = Math.max(x0 + half - 20, Math.min(x1 - half + 20, (x0 + x1) / 2)), cz = (z0 + z1) / 2;
    const k = css / (2 * half);
    const trace = (pts, close) => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); if (close) g.closePath(); };
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = COL.base; g.fillRect(0, 0, css, css);
    g.save(); g.translate(css / 2, css / 2); g.scale(k, k); g.translate(-cx, -cz);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = COL.walk; for (const r of M.roads) { g.lineWidth = r.sw; trace(r.path); g.stroke(); }
    g.strokeStyle = COL.paving; for (const w of M.walks) { g.lineWidth = w.w; trace(w.path); g.stroke(); }
    g.fillStyle = COL.plaza; for (const pz of M.plazas) { trace(pz.poly, true); g.fill(); }
    g.strokeStyle = COL.road; for (const r of M.roads) { g.lineWidth = r.w; trace(r.path); g.stroke(); }
    const cr = CITY.crossing;
    g.fillStyle = COL.road; g.beginPath(); g.arc(cr.center[0], cr.center[1], cr.radius, 0, Math.PI * 2); g.fill();
    g.lineCap = 'butt'; g.strokeStyle = COL.zebra; g.setLineDash([1.25, 1.25]);
    for (const zb of M.zebras) { g.lineWidth = zb.w; g.beginPath(); g.moveTo(zb.a[0], zb.a[1]); g.lineTo(zb.b[0], zb.b[1]); g.stroke(); }
    g.setLineDash([]); g.lineJoin = 'miter';
    g.fillStyle = COL.bld; g.strokeStyle = COL.bldEdge; g.lineWidth = 1 / k;
    for (const b of M.blds) { trace(b.poly, true); g.fill(); g.stroke(); }
    g.fillStyle = COL.mark; g.strokeStyle = COL.markEdge; g.lineWidth = 1.4 / k;
    for (const m of M.marks) { trace(m.poly, true); g.fill(); g.stroke(); if (m.cyl) { g.beginPath(); g.arc(m.cyl.center[0], m.cyl.center[1], m.cyl.radius, 0, Math.PI * 2); g.fill(); g.stroke(); } }
    g.lineCap = 'butt';
    for (const r of M.rail) { g.strokeStyle = COL.rail; g.lineWidth = r.w; trace(r.path); g.stroke(); }
    g.restore();
    const S = (x, z) => [css / 2 + (x - cx) * k, css / 2 + (z - cz) * k];
    // labels: landmarks and streets, largest first, no overlaps
    const taken = [];
    const label = (text, x, z, font, fill, dy = 0) => {
      const [sx, sy0] = S(x, z), sy = sy0 + dy;
      if (sx < 8 || sy < 10 || sx > css - 8 || sy > css - 8) return;
      g.font = font; const w = g.measureText(text).width + 8, h = 16;
      for (const t of taken) if (Math.abs(t[0] - sx) < (t[2] + w) / 2 && Math.abs(t[1] - sy) < h) return;
      taken.push([sx, sy, w]);
      g.lineWidth = 3.5; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(text, sx, sy); g.fillStyle = fill; g.fillText(text, sx, sy);
    };
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    for (const l of M.labels) label(l.text, l.x, l.z, `700 ${l.kind === 'hachiko' ? 13 : 14}px ${SANS}`, l.kind === 'hachiko' ? '#fff0c8' : '#f1e3bd', l.kind === 'hachiko' ? 12 : 0);
    const seen = new Set();
    for (const l of M.streets) { if (seen.has(l.text)) continue; seen.add(l.text); label(l.text, l.x, l.z, `500 12px ${SANS}`, '#aeb8c8'); }
    // the open substories and the objective
    const ms = engine.get('missions');
    const subs = (ms && ms.SUBSTORIES) || [];
    for (const sb of subs) {
      if (sb.done) continue;
      const [sx, sy] = S(sb.spot[0], sb.spot[1]);
      g.fillStyle = '#c8102e'; g.strokeStyle = '#fff2d0'; g.lineWidth = 2;
      g.beginPath(); g.arc(sx, sy, 9, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.font = `900 13px ${SANS}`; g.fillText('!', sx, sy + 0.5);
      label(`${sb.no}「${sb.title}」`, sb.spot[0], sb.spot[1], `600 12px ${SANS}`, '#ffb0b8', -18);
    }
    const op = ms && ms.objectivePos;
    if (op) {
      const [sx, sy] = S(op.x, op.z);
      g.save(); g.translate(sx, sy); g.rotate(Math.PI / 4);
      g.fillStyle = '#f3c94a'; g.strokeStyle = '#1b1307'; g.lineWidth = 2; g.fillRect(-7, -7, 14, 14); g.strokeRect(-7, -7, 14, 14);
      g.restore();
      const txt = ms.current && ms.current.text;
      if (txt) label('目的：' + txt, op.x, op.z, `700 13px ${SANS}`, '#ffe08a', -20);
    }
    for (const f of this.mapLayers) { try { f(g, S, { mini: false, css, k }); } catch (e) { if (!f._err) { f._err = true; console.warn('[hud] map layer', e); } } }
    // 健人: a pulsing ring and the heading arrow (north up, so the arrow turns with him)
    const pl = engine.player;
    if (pl) {
      const [sx, sy] = S(pl.position.x, pl.position.z);
      g.strokeStyle = 'rgba(255,222,140,.55)'; g.lineWidth = 2; g.beginPath(); g.arc(sx, sy, 18, 0, Math.PI * 2); g.stroke();
      g.save(); g.translate(sx, sy); g.rotate(Math.atan2(Math.sin(pl.yaw), -Math.cos(pl.yaw)));
      g.drawImage(this.arrow || this.paintArrow(), -24, -24, 48, 48);
      g.restore();
      label('現在地', pl.position.x, pl.position.z, `800 13px ${SANS}`, '#fff4d2', 30);
    }
    // north and scale
    g.drawImage(this.north || this.paintNorth(), css - 40, 12, 28, 28);
    const bar = 100 * k;
    g.fillStyle = '#d9b45a'; g.fillRect(16, css - 22, bar, 3);
    g.font = `600 11px ${SANS}`; g.textAlign = 'left'; g.fillStyle = '#d9c9a0'; g.fillText('100 m', 20 + bar, css - 20);
    return { cx, cz, k };
  },

  paintRing() {
    const dpr = this.mapDpr, B = MM.box, C = B / 2, R = MM.r;
    const c = document.createElement('canvas');
    c.width = c.height = Math.round(B * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    // inner vignette + glass
    let gr = g.createRadialGradient(C, C, R * 0.55, C, C, R);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.8, 'rgba(0,0,0,.25)'); gr.addColorStop(1, 'rgba(0,0,0,.7)');
    g.fillStyle = gr; g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.fill();
    gr = g.createLinearGradient(C - R, C - R, C + R * 0.2, C + R * 0.2);
    gr.addColorStop(0, 'rgba(255,255,255,.10)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(C, C, R, Math.PI * 0.95, Math.PI * 1.75); g.arc(C, C, R * 0.82, Math.PI * 1.75, Math.PI * 0.95, true); g.fill();
    // bezel: black lip, bevelled gold band, black lip
    g.save(); g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 14; g.shadowOffsetY = 3;
    g.strokeStyle = '#050505'; g.lineWidth = 11; g.beginPath(); g.arc(C, C, R + 5, 0, Math.PI * 2); g.stroke(); g.restore();
    gr = g.createLinearGradient(C - R, C - R, C + R, C + R);
    gr.addColorStop(0, '#fbecb6'); gr.addColorStop(0.3, '#d9b45a'); gr.addColorStop(0.55, '#7d5c1f'); gr.addColorStop(0.8, '#c9a24a'); gr.addColorStop(1, '#f0d48a');
    g.strokeStyle = gr; g.lineWidth = 5; g.beginPath(); g.arc(C, C, R + 4.5, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,244,210,.55)'; g.lineWidth = 1; g.beginPath(); g.arc(C, C, R + 6.5, Math.PI * 1.05, Math.PI * 1.7); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,.9)'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(C, C, R + 1.6, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(C, C, R + 7.6, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 24; i++) {                                         // bezel ticks, heavier every 90°
      const a = (i / 24) * Math.PI * 2, big = i % 6 === 0;
      g.strokeStyle = big ? 'rgba(20,12,2,.95)' : 'rgba(40,26,6,.7)'; g.lineWidth = big ? 2 : 1;
      g.beginPath(); g.moveTo(C + Math.cos(a) * (R + 2.2), C + Math.sin(a) * (R + 2.2)); g.lineTo(C + Math.cos(a) * (R + (big ? 7.2 : 5)), C + Math.sin(a) * (R + (big ? 7.2 : 5))); g.stroke();
    }
    return c;
  },
  // 健人's marker, pre-rendered with its glow: a dark seat ring, then the gold arrowhead at 1.2×
  paintArrow() {
    const dpr = this.mapDpr, n = 48, c = mkCanvas(Math.round(n * dpr)), g = c.getContext('2d');
    g.scale(dpr, dpr); g.translate(n / 2, n / 2);
    g.fillStyle = 'rgba(5,6,9,.5)'; g.beginPath(); g.arc(0, 0, 15.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.9)'; g.lineWidth = 2; g.stroke();
    g.scale(1.2, 1.2);
    g.shadowColor = 'rgba(255,200,90,.8)'; g.shadowBlur = 8;
    g.fillStyle = '#fff4d2'; g.strokeStyle = '#1b1307'; g.lineWidth = 2; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(0, -11); g.lineTo(7.5, 8); g.lineTo(0, 4); g.lineTo(-7.5, 8); g.closePath(); g.fill();
    g.shadowColor = 'transparent'; g.stroke();
    g.fillStyle = '#d9a73c'; g.beginPath(); g.moveTo(0, -11); g.lineTo(0, 4); g.lineTo(-7.5, 8); g.closePath(); g.fill();
    return c;
  },
  paintNorth() {
    const dpr = this.mapDpr, n = 26, c = mkCanvas(Math.round(n * dpr)), g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#0c0b0a'; g.strokeStyle = '#e2c275'; g.lineWidth = 1.6;
    g.beginPath(); g.arc(n / 2, n / 2, 10.5, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#f6e2a0'; g.font = `800 12px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', n / 2, n / 2 + 0.5);
    return c;
  },

  // one map label: skipped past the rim, over another label, or under the player arrow; at most 6 per frame
  mapLabel(ctx, l, sx, sy) {
    const S = this._lab, C = MM.box / 2;
    if (S.n >= 6 || Math.hypot(sx - C, sy - C) > MM.r - l.pad) return;
    if (S.font !== l.font) ctx.font = S.font = l.font;
    let w = l.w;
    if (!w) { w = ctx.measureText(l.text).width + 6; if (this.fontsOK) l.w = w; }
    const h = l.size + 3, T = S.taken;
    for (let i = 0; i < S.nt; i += 3) if (Math.abs(T[i] - sx) < (T[i + 2] + w) / 2 && Math.abs(T[i + 1] - sy) < h) return;
    if (Math.abs(sx - C) < (w + 16) / 2 && Math.abs(sy - C) < 20) return;
    T[S.nt++] = sx; T[S.nt++] = sy; T[S.nt++] = w; S.n++;
    ctx.strokeText(l.text, sx, sy);
    ctx.fillStyle = l.fill; ctx.fillText(l.text, sx, sy);
  },

  drawMinimap(t) {
    const engine = this.engine, ctx = this.mapCtx; if (!ctx) return;
    // the city's block plan can land after the first frame: rebuild once it has
    if (!this.map || (!this.map.blds.length && ++this._mapRetry % 60 === 0)) this.buildMap();
    const M = this.map, dpr = this.mapDpr, B = MM.box, C = B / 2, R = MM.r, range = this.mmRange, k = R / range;
    const pl = engine.player, p = pl ? pl.position : _v.set(0, 0, 0);
    engine.camera.getWorldDirection(_d);
    let fx = _d.x, fz = _d.z;
    if (fx * fx + fz * fz < 1e-4 && pl) { fx = Math.sin(pl.yaw); fz = Math.cos(pl.yaw); }
    const th = -Math.PI / 2 - Math.atan2(fz, fx), cs = Math.cos(th), sn = Math.sin(th), px = p.x, pz = p.z, mp = this._mp;
    const toMap = (x, z) => { const rx = (x - px) * k, rz = (z - pz) * k; mp[0] = C + rx * cs - rz * sn; mp[1] = C + rx * sn + rz * cs; };

    const band = range > 40 ? MM.range : MM.combat;
    let L = this.mapBakes[band];
    if (!L || Math.max(Math.abs(px - L.cx), Math.abs(pz - L.cz)) + range * 1.1 > band * 3) { this.bakeMap(band, px, pz); L = this.mapBakes[band]; }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, B, B);
    ctx.save();
    ctx.beginPath(); ctx.arc(C, C, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = COL.base; ctx.fillRect(0, 0, B, B);
    ctx.save();
    ctx.translate(C, C); ctx.rotate(th); ctx.scale(k / L.k, k / L.k);
    ctx.drawImage(L.c, (L.cx - px) * L.k - L.S / 2, (L.cz - pz) * L.k - L.S / 2, L.S, L.S);
    ctx.restore();

    // screen-space layers (upright): view cone, labels, objective, enemies, and the player marker on top of all of it
    const combat = engine.state && engine.state.mode === 'combat';
    ctx.fillStyle = this.cone; ctx.beginPath(); ctx.moveTo(C, C); ctx.arc(C, C, R * 0.72, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6); ctx.closePath(); ctx.fill();

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(3,4,7,.92)'; ctx.lineWidth = 3.4;
    const S = this._lab; S.n = 0; S.nt = 0; S.font = '';
    const o = combat ? null : this.objectivePos;                          // in a fight the objective is the fight
    for (const l of M.labels) {
      toMap(l.x, l.z);
      const sx = mp[0], sy = mp[1];
      if (l.kind === 'hachiko') {
        const onObj = o && Math.hypot(o.x - l.x, o.z - l.z) < 8;            // the objective diamond says it already
        if (!onObj && Math.hypot(sx - C, sy - C) < R - 8) { ctx.fillStyle = '#e9e2cc'; ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill(); }
      }
      this.mapLabel(ctx, l, sx, sy + l.dy);
    }
    for (const s of M.streets) { toMap(s.x, s.z); this.mapLabel(ctx, s, mp[0], mp[1]); }

    let rim = null;
    if (o) {
      toMap(o.x, o.z);
      const ox = mp[0], oy = mp[1], dx = ox - C, dy = oy - C, dd = Math.hypot(dx, dy);
      if (dd > R - 12) rim = Math.atan2(dy, dx);                            // off the map: only the bezel notch, below
      else {
        const ph = (t * 1.6) % 1, pr = 9 + ph * 9;
        ctx.strokeStyle = `rgba(255,210,74,${(0.8 * (1 - ph)).toFixed(3)})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ox, oy, pr, 0, Math.PI * 2); ctx.stroke();
        ctx.save(); ctx.translate(ox, oy); ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#ffd24a'; ctx.strokeStyle = '#1a1204'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.rect(-5.5, -5.5, 11, 11); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#6b4a08'; ctx.fillRect(-1.8, -1.8, 3.6, 3.6);
        ctx.restore();
      }
    }

    // other modules' icons (addMapLayer: the LOOP ports): upright, under the enemies and the player marker
    if (this.mapLayers.length) {
      const proj = (x, z) => { toMap(x, z); return mp; }, info = { mini: true, C, R, k, t };
      for (const f of this.mapLayers) { try { f(ctx, proj, info); } catch (e) { if (!f._err) { f._err = true; console.warn('[hud] map layer', e); } } }
    }

    // enemies under the marker; a man closer than its seat ring is pushed out onto it, keeping his bearing
    const en = engine.get('enemy');
    if (en && en.list) for (const e of en.list) {
      if (!e.alive || !(e.aggro || this.enemies.has(e))) continue;
      toMap(e.position.x, e.position.z);
      let ex = mp[0], ey = mp[1];
      const dx = ex - C, dy = ey - C, dd = Math.hypot(dx, dy);
      if (dd > R - 6) continue;
      if (dd < 20) { if (dd < 0.01) { ex = C; ey = C - 20; } else { ex = C + (dx / dd) * 20; ey = C + (dy / dd) * 20; } }
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.arc(ex, ey, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = e.state === 'down' ? '#b8453c' : '#ff3a2e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(ex, ey, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    if (pl) {                                                               // 健人: gold arrowhead, true facing, drawn last
      const a = Math.atan2(Math.sin(pl.yaw) * sn + Math.cos(pl.yaw) * cs, Math.sin(pl.yaw) * cs - Math.cos(pl.yaw) * sn) + Math.PI / 2;
      ctx.save(); ctx.translate(C, C); ctx.rotate(a); ctx.drawImage(this.arrow, -24, -24, 48, 48); ctx.restore();
    }
    ctx.restore();

    ctx.drawImage(this.ring, 0, 0, B, B);
    if (rim != null) {                                                      // off-map objective: a notch on the bezel
      ctx.save(); ctx.translate(C + Math.cos(rim) * (R + 4.5), C + Math.sin(rim) * (R + 4.5)); ctx.rotate(rim);
      ctx.fillStyle = '#ffd24a'; ctx.strokeStyle = '#1a1204'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-5, -7.5); ctx.lineTo(-5, 7.5); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.drawImage(this.north, C + sn * (R + 4.5) - 13, C - cs * (R + 4.5) - 13, 26, 26);   // north badge rides the bezel
  },

  areaName(x, z) {
    const cr = CITY.crossing;
    if (Math.hypot(x - cr.center[0], z - cr.center[1]) <= cr.radius + 3) return 'スクランブル交差点';
    for (const p of CITY.plazas) if (pointInPolygon(x, z, p.polygon)) return AREA_NAMES[p.name] || tidyName(p.name);
    for (const [key, l] of Object.entries(CITY.landmarks)) if (l.polygon && l.storeys && pointInPolygon(x, z, l.polygon)) return LABELS[key] || l.name;
    for (const p of CITY.pedestrianStreets) if (pathDist(x, z, p.path) < p.width / 2 + 1.5) return tidyName(p.name);
    let best = null, bd = Infinity;
    for (const r of CITY.roads) { const d = pathDist(x, z, r.path) - (r.width / 2 + (r.sidewalk || 0) + 2); if (d < bd) { bd = d; best = r; } }
    if (best && bd < 0) return tidyName(best.name);
    if (x < -80 && z < -20) return '宇田川町';
    if (x < -60 && z > 0) return '道玄坂';
    if (x > 60 && z < 0) return '渋谷町 東口';
    return z < -60 ? '神南' : '渋谷町駅前';
  },

  // ---------------------------------------------------------------------------------------------- frame
  update() {
    const engine = this.engine, p = engine.player;
    const tn = clock(), dt = Math.min(0.1, Math.max(0, tn - this._last));      // real time: slow-mo must not slow the HUD
    this._last = tn;
    if (p) { this.setHP(p.hp, p.hpMax); this.setHeat(p.heat); }
    const combat = engine.state.mode === 'combat';
    if (combat !== this._combat) { this._combat = combat; this.root.classList.toggle('combat', combat); }
    this.mmRange += ((combat ? MM.combat : MM.range) - this.mmRange) * Math.min(1, dt * 7.5);   // ~0.4 s zoom
    if (this.moneyT > 0) { this.moneyT -= dt; if (this.moneyT <= 0) this.root.classList.remove('moneyon'); }
    // a stamp held on a still frame (callers pause .stamp) keeps the floating HUD cleared until it runs out
    if (this._stampT > 0 && this.el.stamp.style.animationPlayState !== 'paused') { this._stampT -= dt; if (this._stampT <= 0) this.endStamp(); }
    this.paintBars(dt);
    this.paintEnemies(dt);
    this.paintDamage(dt);
    if (this.comboT > 0) {
      this.comboT -= dt;
      this.el.comboTimer.style.transform = `scaleX(${clamp01(this.comboT / 2.5).toFixed(3)})`;
      if (this.comboT <= 0) this.el.combo.classList.remove('on');
    }
    this.mapT -= dt;
    if (this.mapT <= 0) { this.mapT = 1 / 30; try { this.drawMinimap(tn); } catch (e) { if (!this._mapErr) { this._mapErr = true; console.warn('[hud] minimap', e); } } }
    this.areaT -= dt;
    if (this.areaT <= 0 && p) {
      this.areaT = 0.25;
      const a = this.areaName(p.position.x, p.position.z);
      if (a !== this._area) { this._area = a; this.el.area.textContent = a; const d = this.el.district; d.classList.remove('new'); void d.offsetWidth; d.classList.add('new'); }
      if (!this._credit) {
        const au = engine.get('audio'), c = au && au.voiceBank && au.voiceBank.credit;
        if (c) { this._credit = c; this.el.credit.textContent = c; }
      }
      if (!this._distRO) this.watchObjectiveRow();
      // 所持金 (story's node) pops on for 4 s when its value changes, then gets out of the way
      const mv = this._moneyV || (this._moneyV = this.root.querySelector('.story .money .v'));
      if (mv) {
        const s = mv.textContent;
        if (this._money != null && s !== this._money) { this.moneyT = 4; this.root.classList.add('moneyon'); }
        this._money = s;
      }
    }
    if (this.statsOn) {
      const s = engine.stats || window.__stats || {};
      this.el.stats.textContent = `fps ${s.fps}  ms ${s.ms}\ncalls ${s.drawCalls}  tris ${s.triangles}\nprog ${s.programs} tex ${s.textures} geo ${s.geometries}\nmode ${engine.state.mode} hour ${engine.time.hour.toFixed(1)} ${engine.time.weather}`;
    }
  },

  // story's meta row (第一章 / 手順 / 残り) hangs under the objective band: the band is held at least as wide as the row,
  // so the row's left end always sits on the band's dark zone, never on bare sky
  watchObjectiveRow() {
    const row = this.root.querySelector('.story .dist'), band = this.root.querySelector('.objective');
    if (!row || !band || typeof ResizeObserver === 'undefined') return;
    this._distRO = new ResizeObserver(() => {
      const w = Math.ceil(row.offsetWidth);
      if (w !== this._distW) { this._distW = w; band.style.minWidth = w + 'px'; }
    });
    this._distRO.observe(row);
  },

  selfTest() {
    const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
    const out = { plate: r(this.el.plate), minimap: r(this.el.minimap), district: r(this.el.district), credit: this.el.credit.textContent || '(none yet)', enemies: this.enemies.size, dmgs: this.dmgPool.filter((n) => n.live).length };
    out.fonts = [...(document.fonts || [])].map((f) => `${f.family} ${f.weight} ${f.status}`);
    out.stamps = [...this.stampKanji.keys()].join('');
    if (!this.map) this.buildMap();
    out.map = { roads: this.map.roads.length, buildings: this.map.blds.length, landmarks: this.map.marks.length, zebras: this.map.zebras.length };
    out.ok = !!(this.mapCtx && this.map.roads.length && this.map.blds.length);
    return out;
  },
};

export default hud;
