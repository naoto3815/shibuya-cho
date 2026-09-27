// [mobile] On-screen controls for phones and tablets (docs/reports/mobile.md). Inert on a desktop unless ?touch=1.
//   left thumb   a floating joystick: move (camera-relative, like WASD); pushed to the rim = run
//   right thumb  drag anywhere right of the joystick zone = camera; a short tap there advances a conversation
//   buttons      攻撃 強攻撃 回避 ガード(hold) 掴み ロック ヒート — and 話す/調べる/乗る/返却 only while the game shows
//                its E prompt (missions' .prompt, LOOP's .loop-prompt), 次へ while a conversation waits
//   top          メニュー (= Esc: pause, the city map, resume) and 全画面 where the Fullscreen API exists (Android)
// Everything goes through engine.input.virtual (src/core/input.js): the game logic reads the same buttons it reads for
// the keyboard, and the LOOP scooter's throttle / steering is the joystick through input.move like W/A/S/D.
// Menus, the start screen, the opening video, the arrival, results and game over are DOM buttons and work by tap;
// a cutscene's hold-to-skip listens to window pointerdown, which a hold anywhere on the screen still reaches.
import { TOUCH } from '../core/mobileProfile.js';

const CSS = `
html.is-touch, html.is-touch body { touch-action: manipulation; overscroll-behavior: none; -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
html.is-touch body { position: fixed; inset: 0; }
#touch-ui { position: fixed; inset: 0; z-index: 60; pointer-events: none; font-family: "Hiragino Sans", "Noto Sans JP", sans-serif;
  --sl: env(safe-area-inset-left, 0px); --sr: env(safe-area-inset-right, 0px); --st: env(safe-area-inset-top, 0px); --sb: env(safe-area-inset-bottom, 0px); }
#touch-ui[hidden] { display: none; }
#touch-ui .zone { position: absolute; pointer-events: auto; touch-action: none; }
#touch-ui .zone.move { left: 0; bottom: 0; width: 42%; height: 72%; }
#touch-ui .zone.look { right: 0; top: 0; width: 58%; height: 100%; }
#touch-ui .stick-base { position: absolute; width: 124px; height: 124px; margin: -62px 0 0 -62px; border-radius: 50%; pointer-events: none;
  border: 2px solid rgba(243, 220, 138, .38); background: radial-gradient(circle, rgba(0, 0, 0, .10) 40%, rgba(0, 0, 0, .34)); transition: border-color .12s; }
#touch-ui .stick-base.run { border-color: rgba(255, 196, 80, .95); box-shadow: 0 0 18px rgba(255, 180, 60, .5); }
#touch-ui .stick-knob { position: absolute; left: 50%; top: 50%; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, rgba(255, 244, 214, .85), rgba(190, 160, 96, .7)); box-shadow: 0 2px 8px rgba(0, 0, 0, .5); }
#touch-ui .stick-base:not(.on) { opacity: .55; }
#touch-ui .btn { position: absolute; pointer-events: auto; touch-action: none; display: flex; flex-direction: column; align-items: center; justify-content: center;
  border-radius: 50%; border: 2px solid rgba(217, 180, 90, .75); background: rgba(12, 10, 8, .52); color: #f3e6c4; font-weight: 800; font-size: 15px;
  letter-spacing: .04em; line-height: 1.05; text-shadow: 0 1px 3px #000; box-sizing: border-box; }
#touch-ui .btn small { font-size: 9px; font-weight: 600; color: #bfae86; margin-top: 2px; letter-spacing: .08em; }
#touch-ui .btn.down { background: rgba(217, 180, 90, .55); color: #100d06; border-color: #fff0c0; }
#touch-ui .btn.down small { color: #2a2010; }
#touch-ui .btn[hidden] { display: none; }
#touch-ui .btn.ready { border-color: #ff5a3c; box-shadow: 0 0 16px rgba(255, 70, 40, .7); }
#touch-ui [data-btn=attack] { right: calc(20px + var(--sr)); bottom: calc(20px + var(--sb)); width: 84px; height: 84px; font-size: 20px; }
#touch-ui [data-btn=heavy]  { right: calc(114px + var(--sr)); bottom: calc(14px + var(--sb)); width: 62px; height: 62px; }
#touch-ui [data-btn=dodge]  { right: calc(28px + var(--sr)); bottom: calc(114px + var(--sb)); width: 62px; height: 62px; }
#touch-ui [data-btn=grab]   { right: calc(104px + var(--sr)); bottom: calc(92px + var(--sb)); width: 54px; height: 54px; }
#touch-ui [data-btn=guard]  { right: calc(186px + var(--sr)); bottom: calc(18px + var(--sb)); width: 56px; height: 56px; }
#touch-ui [data-btn=lockOn] { right: calc(174px + var(--sr)); bottom: calc(88px + var(--sb)); width: 48px; height: 48px; font-size: 13px; }
#touch-ui [data-btn=heat]   { right: calc(30px + var(--sr)); bottom: calc(188px + var(--sb)); width: 56px; height: 56px; }
#touch-ui [data-btn=interact] { right: calc(100px + var(--sr)); bottom: calc(156px + var(--sb)); width: auto; min-width: 104px; height: 44px; padding: 0 16px;
  border-radius: 22px; font-size: 16px; background: rgba(217, 180, 90, .9); color: #100d06; border-color: #fff0c0; text-shadow: none; flex-direction: row; gap: 6px; }
#touch-ui [data-btn=interact] small { color: #3a2c10; font-size: 10px; margin: 0; }
#touch-ui .top { position: absolute; top: calc(8px + var(--st)); left: 50%; transform: translateX(-50%); display: flex; gap: 10px; pointer-events: none; }
#touch-ui .top .btn { position: static; width: auto; height: 36px; padding: 0 14px; border-radius: 18px; flex-direction: row; gap: 6px; font-size: 13px; }
#touch-ui.riding .fight:not([data-btn=dodge]), #touch-ui.paused .play, #touch-ui.paused .zone, #touch-ui.paused .stick-base,
#touch-ui.paused .top .btn:not([data-btn=pause]) { display: none; }
#touch-ui.paused [data-btn=pause] { background: rgba(217, 180, 90, .9); color: #100d06; }
#touch-ui.paused [data-btn=pause] small { color: #2a2010; }
#touch-ui.paused .top { left: auto; right: calc(12px + var(--sr)); transform: none; }
#touch-ui.talking .fight, #touch-ui.talking .zone.move, #touch-ui.talking .stick-base, #touch-ui.talking .top { display: none; }
#touch-ui.talking .zone.look { width: 100%; }
#touch-ui.talking [data-btn=interact] { bottom: calc(28px + var(--sb)); right: calc(28px + var(--sr)); min-width: 120px; height: 52px; font-size: 18px; border-radius: 26px; }
/* the corner HUD is laid out for 1920x1080 and stops shrinking at 0.7 (hud.js): a phone needs it smaller, and the
   bottom-right cluster (minimap, district, money) moves up out of the thumb's buttons */
@media (max-height: 560px) { html.is-touch #hud { --hk: .5 !important; } }
@media (min-height: 561px) and (max-height: 900px) { html.is-touch #hud { --hk: .66 !important; } }
html.is-touch #hud .minimap { right: auto; left: 34px; bottom: auto; top: 172px; }
html.is-touch #hud .district { display: none; }
html.is-touch #hud .story .dist { zoom: var(--hk, 1); }
html.is-touch #hud.y8 .story .money { bottom: auto; top: 172px; }
html.is-touch #hud .loop-ride { left: auto; right: 38px; bottom: auto; top: 230px; }
/* the start screen on a landscape phone: the menu above the fold */
@media (max-height: 560px) {
  html.is-touch #start-screen[data-page=home] .home { padding: calc(8px + env(safe-area-inset-top, 0px)) calc(24px + env(safe-area-inset-left, 0px)) 16px; }
  html.is-touch #start-screen .home .eyebrow, html.is-touch #start-screen .home .tagline { display: none; }
  html.is-touch #start-screen .home h1.title-logo { max-width: min(270px, 38vw); margin: 2px 0 8px; }
  html.is-touch #start-screen .home nav { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; max-width: 470px; }
  html.is-touch #start-screen .home nav button { padding: 11px 14px; font-size: 15px; margin: 0; white-space: nowrap; }
  html.is-touch #start-screen .home nav button small { display: none; }
  html.is-touch #start-screen .save-note { margin: 8px 0 0; font-size: 11px; }
  html.is-touch #start-screen footer { display: none; }
  html.is-touch #start-screen button.title-replay { bottom: calc(10px + env(safe-area-inset-bottom, 0px)); right: calc(12px + env(safe-area-inset-right, 0px)); }
  html.is-touch #start-screen .panel { margin: 8px calc(8px + env(safe-area-inset-left, 0px)); min-height: 0; padding: 14px 20px 20px; }
  html.is-touch #start-screen h2 { font-size: 22px; margin-bottom: 6px; }
  html.is-touch #start-screen .lead { margin-bottom: 12px; }
  /* the pause screen: title, map and the three buttons on one landscape screen, the key list replaced by the pad's */
  html.is-touch #hud .menus .pause { gap: 6px; justify-content: flex-start; padding: calc(6px + env(safe-area-inset-top, 0px)) 12px 8px; overflow: auto; touch-action: pan-y; }
  html.is-touch #hud .menus .pause .k { font-size: 18px; padding: 2px 24px; }
  html.is-touch #hud .menus .pause .body { max-height: none; overflow: visible; }
  html.is-touch #hud .menus .pause .ctl, html.is-touch #hud .menus .pause .hint { display: none; }   /* the buttons are labelled */
  html.is-touch #hud .menus .pause .mapw { padding: 6px 8px 4px; }
  html.is-touch #hud .menus .pause .mh { margin-bottom: 4px; }
  html.is-touch #hud .menus .pause > .hint + div { position: absolute; right: calc(16px + env(safe-area-inset-right, 0px)); top: 50%; transform: translateY(-50%); flex-direction: column; }
  html.is-touch #hud .menus .over .k { font-size: 72px; } html.is-touch #hud .menus .over .r { margin-bottom: 24px; }
}
#rotate-hint { position: fixed; inset: 0; z-index: 300; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
  background: #07080b; color: #f3e6c4; font: 700 20px/1.6 "Hiragino Sans", "Noto Sans JP", sans-serif; letter-spacing: .12em; text-align: center; padding: 24px; }
#rotate-hint i { display: block; width: 58px; height: 92px; border: 3px solid #d9b45a; border-radius: 10px; animation: rot-hint 2.2s ease-in-out infinite; }
#rotate-hint small { font-size: 12px; font-weight: 500; color: #9d9480; letter-spacing: .06em; }
@keyframes rot-hint { 0%, 25% { transform: rotate(0); } 55%, 100% { transform: rotate(-90deg); } }
@media (orientation: portrait) { html.is-touch #rotate-hint { display: flex; } }
`;

const BTNS = [
  // [action, label, caption, group]  group: fight (hidden while riding) / play (hidden while paused)
  ['attack', '攻撃', 'ATTACK', 'fight play'], ['heavy', '強', '強攻撃', 'fight play'], ['dodge', '回避', 'DODGE', 'fight play'],
  ['grab', '掴み', 'GRAB', 'fight play'], ['guard', 'ガード', '長押し', 'fight play'], ['lockOn', 'ロック', '', 'fight play'],
  ['heat', 'ヒート', 'HEAT', 'fight play'], ['interact', '話す', '', 'play'],
];
const LOOK_K = 1.6;            // drag px -> the mouse's px (camera.sensitivity rad/px; the settings' カメラ感度 scales it)
const RUN_AT = 0.9, DEAD = 0.12;

const touch = {
  name: 'touch',
  enabled: false,

  init(engine) {
    this.engine = engine;
    const P = engine.params || {};
    if (!TOUCH || P.shot || (P.raw && P.raw.heroReview === '1')) return;   // desktop, stills and review pages: nothing
    this.enabled = true;
    const input = engine.input, V = input.virtual;
    V.active = true;
    const style = document.createElement('style'); style.id = 'touch-ui-css'; style.textContent = CSS; document.head.append(style);

    const root = document.createElement('div'); root.id = 'touch-ui'; root.hidden = true;
    root.innerHTML = `<div class="zone look"></div><div class="zone move"></div><div class="stick-base"><div class="stick-knob"></div></div>
      ${BTNS.map(([a, l, c, g]) => `<div class="btn ${g}" data-btn="${a}" role="button" aria-label="${l}">${l}${c ? `<small>${c}</small>` : ''}</div>`).join('')}
      <div class="top"><div class="btn" data-btn="fullscreen" role="button" aria-label="全画面" hidden>⛶<small>全画面</small></div>
        <div class="btn" data-btn="pause" role="button" aria-label="メニュー">☰<small>メニュー</small></div></div>`;
    document.body.append(root);
    const rot = document.createElement('div'); rot.id = 'rotate-hint';
    rot.innerHTML = '<i></i>横向きにしてください<small>このゲームは横画面で遊べます</small>';
    document.body.append(rot);
    this.root = root;
    const $ = (s) => root.querySelector(s);
    const btn = (a) => root.querySelector(`[data-btn="${a}"]`);
    this.ui = { base: $('.stick-base'), knob: $('.stick-knob'), look: $('.zone.look'), move: $('.zone.move'), interact: btn('interact'), dodge: btn('dodge'), heat: btn('heat'), pause: btn('pause'), fs: btn('fullscreen') };

    // iOS: no pinch zoom / double-tap zoom on the game (the viewport meta asks, Safari ignores it)
    for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

    // ---- buttons: held while a finger is on them. preventDefault on pointerdown keeps the compatibility mouse events
    // (input.js reads mousedown as an attack) out; the event still bubbles to window for missions' hold-to-skip.
    root.querySelectorAll('.btn[data-btn]').forEach((el) => {
      const a = el.dataset.btn;
      const up = (e) => { if (el._pid !== e.pointerId) return; el._pid = null; el.classList.remove('down'); if (a in input.buttons) V.release(a); };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        engine.get('audio')?.ensure?.();
        if (a === 'fullscreen') { this.toggleFullscreen(); return; }
        el._pid = e.pointerId; try { el.setPointerCapture(e.pointerId); } catch (_) { /* */ }
        el.classList.add('down');
        if (a in input.buttons) V.press(a);
      });
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('lostpointercapture', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    // ---- joystick (floating inside the left zone: it centres on the thumb, and rests at its home spot)
    const st = { id: null, cx: 0, cy: 0, R: 50 };
    this.stick = st;
    const home = () => {
      const sl = parseFloat(getComputedStyle(root).getPropertyValue('--sl')) || 0;
      return [Math.max(96, 96 + sl), window.innerHeight - 96];
    };
    const place = (x, y) => { this.ui.base.style.left = x + 'px'; this.ui.base.style.top = y + 'px'; };
    const setKnob = (dx, dy) => { this.ui.knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    this.resetStick = () => { st.id = null; V.move.set(0, 0); V.release('run'); const h = home(); place(h[0], h[1]); setKnob(0, 0); this.ui.base.classList.remove('on', 'run'); };
    this.resetStick();
    const mz = this.ui.move;
    mz.addEventListener('pointerdown', (e) => {
      e.preventDefault(); if (st.id !== null) return;
      engine.get('audio')?.ensure?.();
      st.id = e.pointerId; try { mz.setPointerCapture(e.pointerId); } catch (_) { /* */ }
      st.cx = Math.max(70, e.clientX); st.cy = Math.min(window.innerHeight - 70, e.clientY);
      place(st.cx, st.cy); this.ui.base.classList.add('on'); this.moveStick(e.clientX, e.clientY);
    });
    mz.addEventListener('pointermove', (e) => { if (e.pointerId === st.id) this.moveStick(e.clientX, e.clientY); });
    const mEnd = (e) => { if (e.pointerId === st.id) this.resetStick(); };
    mz.addEventListener('pointerup', mEnd); mz.addEventListener('pointercancel', mEnd); mz.addEventListener('lostpointercapture', mEnd);
    this.moveStick = (x, y) => {
      let dx = x - st.cx, dy = y - st.cy; const d = Math.hypot(dx, dy), R = st.R;
      if (d > R) { dx *= R / d; dy *= R / d; }
      setKnob(dx, dy);
      let k = Math.min(1, d / R);
      k = k < DEAD ? 0 : (k - DEAD) / (1 - DEAD);
      const a = Math.atan2(dy, dx);
      V.move.set(Math.cos(a) * k, -Math.sin(a) * k);
      const run = k >= RUN_AT;
      if (run) V.press('run'); else V.release('run');
      this.ui.base.classList.toggle('run', run);
    };

    // ---- camera drag (any number of fingers: each one's own delta); a short still tap advances a conversation
    const looks = new Map();
    const lz = this.ui.look;
    lz.addEventListener('pointerdown', (e) => {
      e.preventDefault(); engine.get('audio')?.ensure?.();
      try { lz.setPointerCapture(e.pointerId); } catch (_) { /* */ }
      looks.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 });
    });
    lz.addEventListener('pointermove', (e) => {
      const L = looks.get(e.pointerId); if (!L) return;
      const dx = e.clientX - L.x, dy = e.clientY - L.y; L.x = e.clientX; L.y = e.clientY; L.moved += Math.abs(dx) + Math.abs(dy);
      V.look.x += dx * LOOK_K; V.look.y += dy * LOOK_K;
    });
    const lEnd = (e) => {
      const L = looks.get(e.pointerId); if (!L) return; looks.delete(e.pointerId);
      const ms = engine.get('missions');
      if (e.type === 'pointerup' && L.moved < 12 && performance.now() - L.t < 300 && ms && ms.talk) V.press('interact'), V.release('interact');
    };
    lz.addEventListener('pointerup', lEnd); lz.addEventListener('pointercancel', lEnd); lz.addEventListener('lostpointercapture', lEnd);

    // ---- fullscreen (Android Chrome / iPadOS; iPhone Safari has no element fullscreen: add to home screen instead)
    const fsOK = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    const standalone = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
    this.ui.fs.hidden = !fsOK || standalone;

    const lose = () => { V.releaseAll(); this.resetStick(); root.querySelectorAll('.btn.down').forEach((b) => b.classList.remove('down')); looks.clear(); };
    window.addEventListener('blur', lose);
    document.addEventListener('visibilitychange', () => { if (document.hidden) lose(); });
    window.addEventListener('resize', () => { if (st.id === null) this.resetStick(); });
    window.addEventListener('orientationchange', () => setTimeout(lose, 50));

    // the pause screen lists the on-screen controls instead of the keyboard's
    const menus = engine.get('menus');
    if (menus && typeof menus.renderControls === 'function' && menus.el) {
      const orig = menus.renderControls.bind(menus);
      menus.renderControls = (pad) => {
        orig(pad);
        if (pad) return;
        const row = (k, a, n) => `<div class="row"><span class="keys"><span class="kc w">${k}</span></span><span class="note">${a}${n ? `<small>${n}</small>` : ''}</span></div>`;
        menus.el.ctl.innerHTML = `<div class="col"><h3>移動</h3>${row('左スティック', '移動', '外周まで倒すと走る')}${row('右側をドラッグ', '視点', '')}${row('回避', '回避', '')}${row('話す', '話す・調べる・LOOP', 'Eの表示が出たとき')}</div>` +
          `<div class="col"><h3>戦闘</h3>${row('攻撃', '攻撃', '連打でラッシュコンボ')}${row('強', '強攻撃', '')}${row('掴み', '掴み', '')}${row('ガード', 'ガード', '長押し')}${row('ヒート', 'ヒートアクション', '極ゲージが溜まったとき')}</div>`;
        menus.el.pauseHint.innerHTML = '☰ メニューボタンでゲームに戻る';
      };
      try { menus.renderControls(!!input.gamepadConnected); } catch (e) { console.warn('[touch] controls legend', e); }
    }
    this._t = 0;
    console.info('[touch] on-screen controls on');
  },

  toggleFullscreen() {
    const d = document, el = d.documentElement;
    const on = d.fullscreenElement || d.webkitFullscreenElement;
    try {
      if (on) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else {
        const p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
        const lock = () => { try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch (_) { /* */ } };
        if (p && p.then) p.then(lock, () => {}); else lock();
      }
    } catch (e) { console.warn('[touch] fullscreen', e); }
  },

  // which controls the moment wants (a few DOM reads, 10 times a second)
  update(dt) {
    if (!this.enabled) return;
    this._t -= dt; if (this._t > 0) return; this._t = 0.1;
    const e = this.engine, s = e.state, menus = e.get('menus'), ms = e.get('missions'), loop = e.get('loop');
    // a conversation runs in 'cutscene' mode but waits for the player: only 次へ (and a tap on the right side) stay up
    const talking = !!(ms && ms.talk && !ms.scene);
    const blocked = document.body.classList.contains('front-open') || s.videoPlaying || s.arrival || (menus && menus.over) ||
      (s.mode === 'cutscene' && !talking) || (ms && ms.scene) || !document.getElementById('hud') || (e.params && e.params.hud === false);
    const paused = !!(menus && menus.paused);
    if (this.root.hidden !== !!blocked) { this.root.hidden = !!blocked; if (blocked) { e.input.virtual.releaseAll(); this.resetStick(); } }
    if (blocked) return;
    if (talking !== this.root.classList.contains('talking')) { this.root.classList.toggle('talking', talking); if (talking) { e.input.virtual.releaseAll(); this.resetStick(); } }
    this.root.classList.toggle('paused', paused);
    this.root.classList.toggle('riding', !!(loop && loop.ride));
    this.ui.pause.firstChild.textContent = paused ? '▶' : '☰';
    this.ui.pause.querySelector('small').textContent = paused ? 'ゲームに戻る' : 'メニュー';
    // the E prompt: the story's (話す / 調べる …), LOOP's (乗る / 返却), or a conversation waiting for the next line
    let label = null;
    const sp = document.querySelector('#hud .story .prompt.on');
    const lp = document.querySelector('#hud .loop-prompt.on');
    if (ms && ms.talk) label = '次へ ▶';
    else if (sp && sp.style.opacity !== '0') label = (sp.querySelector('.cap') || {}).textContent || '調べる';
    else if (lp && lp.style.opacity !== '0') label = loop && loop.ride ? '返却' : 'LOOPに乗る';
    if(loop?.ride) {
      const zone=loop.returnZone(e.player.position.x,e.player.position.z);
      label=zone && loop.freeSlots(zone)>0?'返却':loop.ride.pushing?'乗る':'降りる';
    }
    const D=this.ui.dodge;
    D.firstChild.textContent=loop?.ride?(loop.ride.pushing?'乗る':'降りる'):'回避';
    D.querySelector('small').textContent=loop?.ride?'LOOP':'DODGE';
    D.setAttribute('aria-label',D.firstChild.textContent);
    const I = this.ui.interact;
    I.hidden = !label || paused;
    if (label && I.firstChild.textContent !== label) I.firstChild.textContent = label;
    if(label) I.setAttribute('aria-label',label);
    const ha = e.get('heatActions');
    this.ui.heat.classList.toggle('ready', !!(ha && ha.prompt && ha.prompt.visible));
  },
};

export default touch;
