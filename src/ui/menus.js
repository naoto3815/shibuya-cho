import { createStartScreen } from './startScreen.js';
// [ui] Title card, pause, results, subtitles. Foundation stub (DOM inside #hud so hud.css tokens apply).
//   menus.pause(bool)  menus.results({win})  menus.showTitle()
const menus = {
  name: 'menus',
  paused: false,

  init(engine) {
    this.engine = engine;
    const root = document.getElementById('hud') || document.body;
    const el = document.createElement('div');
    el.className = 'menus';
    el.innerHTML = `
      <style>
        #hud .menus .title, #hud .menus .pause, #hud .menus .over { z-index:35; }   /* over every HUD layer; the licence credit (40) stays */
        #hud .menus .title { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(0,0,0,.55); opacity:0; transition:opacity .6s; pointer-events:none; }
        #hud .menus .title.on { opacity:1; }
        #hud.titleon > :not(.menus):not(.credit) { opacity:0 !important; }   /* the gameplay HUD never shows through the title */
        #hud .menus .title .k { font-size:120px; font-weight:900; letter-spacing:.25em; margin-right:-.25em; color:#f3dc8a; text-shadow:0 0 40px rgba(217,180,90,.6), 0 6px 12px #000; }
        #hud .menus .title .r { font-size:22px; letter-spacing:.9em; margin-right:-.9em; color:#d9b45a; margin-top:8px; }
        #hud .menus .title .hint { margin-top:60px; font-size:14px; letter-spacing:.3em; color:#ccc; }
        #hud .menus .pause { position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; gap:34px; background:rgba(0,0,0,.66); pointer-events:auto; }
        #hud .menus .pause.on { display:flex; }
        #hud .menus .pause .k { font-size:64px; font-weight:900; letter-spacing:.4em; margin-right:-.4em; color:#f3dc8a; border-top:2px solid #d9b45a; border-bottom:2px solid #d9b45a; padding:8px 48px; }
        /* 操作方法: two gold-ruled columns of key caps, the way a 龍が如く pause menu lists its controls */
        #hud .menus .pause .body { display:flex; gap:28px; align-items:stretch; max-width:calc(100vw - 32px); }
        #hud .menus .pause .mapw { display:flex; flex-direction:column; background:linear-gradient(180deg, rgba(8,8,10,.92), rgba(12,12,16,.8)); border:1px solid rgba(217,180,90,.35); border-top:3px solid #d9b45a; box-shadow:0 10px 30px rgba(0,0,0,.6); padding:12px 14px 10px; }
        #hud .menus .pause .mh { display:flex; align-items:baseline; gap:14px; margin-bottom:8px; font-family:var(--mincho); color:#d9b45a; letter-spacing:.3em; }
        #hud .menus .pause .mh b { font-size:20px; font-weight:600; } #hud .menus .pause .mh .area { font-size:14px; color:#f1e3bd; letter-spacing:.2em; }
        #hud .menus .pause canvas.map { display:block; border:1px solid rgba(217,180,90,.25); }
        #hud .menus .pause .legend { display:flex; gap:18px; margin-top:8px; font-size:12px; color:#cfc2a2; letter-spacing:.1em; }
        #hud .menus .pause .legend i { display:inline-block; vertical-align:-2px; margin-right:6px; font-style:normal; }
        #hud .menus .pause .legend .me { width:0; height:0; border-left:6px solid transparent; border-right:6px solid transparent; border-bottom:13px solid #fff4d2; }
        #hud .menus .pause .legend .obj { width:10px; height:10px; background:#f3c94a; transform:rotate(45deg); }
        #hud .menus .pause .legend .sub { width:14px; height:14px; border-radius:50%; background:#c8102e; color:#fff; font-weight:900; font-size:11px; line-height:14px; text-align:center; }
        #hud .menus .pause .ctl { display:flex; flex-direction:column; gap:14px; padding:26px 44px 22px; background:linear-gradient(180deg, rgba(8,8,10,.92), rgba(12,12,16,.8)); border:1px solid rgba(217,180,90,.35); border-top:3px solid #d9b45a; box-shadow:0 10px 30px rgba(0,0,0,.6); max-width:calc(100vw - 32px); box-sizing:border-box; }
        #hud .menus .pause .ctl .col { min-width:300px; }
        #hud .menus .pause .ctl h3 { margin:0 0 12px; font-family:var(--mincho); font-weight:600; font-size:17px; letter-spacing:.4em; color:#d9b45a; border-bottom:1px solid rgba(217,180,90,.35); padding-bottom:6px; }
        #hud .menus .pause .ctl .row { display:flex; align-items:center; gap:14px; padding:5px 0; font-size:15px; color:#e8dfc8; letter-spacing:.08em; }
        #hud .menus .pause .ctl .keys { display:flex; align-items:center; gap:4px; flex:0 0 150px; }
        #hud .menus .pause .ctl .keys i { font-style:normal; color:#8a8070; font-size:12px; margin:0 3px; }
        #hud .menus .pause .kc { display:inline-block; min-width:16px; padding:2px 8px; border:1px solid #d9b45a; border-bottom-width:3px; border-radius:4px; background:linear-gradient(180deg,#2a2418,#14110a); color:#f3dc8a; font-family:var(--digits), var(--sans); font-size:13px; font-weight:700; letter-spacing:.05em; text-align:center; line-height:1.4; box-shadow:0 2px 4px rgba(0,0,0,.6); }
        #hud .menus .pause .kc.w { padding:2px 12px; }
        #hud .menus .pause .ctl .note { flex:1; }
        #hud .menus .pause .ctl .note small { color:#8a8070; margin-left:6px; font-size:12px; }
        #hud .menus .pause .hint { font-size:13px; letter-spacing:.3em; color:#999; }
        #hud .menus .pause .hint .kc { margin:0 4px; }
        @media (max-width: 1100px) { #hud .menus .pause .body { flex-direction:column; align-items:center; overflow:auto; max-height:calc(100vh - 150px); } }
        @media (max-width: 760px) { #hud .menus .pause .ctl { flex-direction:column; gap:18px; padding:18px 20px; } #hud .menus .pause .ctl .col { min-width:0; } #hud .menus .pause .k { font-size:40px; } }
        #hud .menus .results { position:absolute; left:50%; top:30%; transform:translateX(-50%); font-size:56px; font-weight:900; letter-spacing:.3em; color:#f3dc8a; text-shadow:0 4px 10px #000; opacity:0; transition:opacity .4s; }
        #hud .menus .results.on { opacity:1; }
        #hud .menus .over { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;
          background:radial-gradient(ellipse at center, rgba(60,0,0,.55) 0%, rgba(0,0,0,.92) 70%); opacity:0; transition:opacity 1.2s; pointer-events:none; }
        #hud .menus .over.on { opacity:1; pointer-events:auto; }
        #hud .menus .over .k { font-family:"Hiragino Mincho ProN","Yu Mincho",serif; font-size:150px; font-weight:900; letter-spacing:.2em; color:#c8102e;
          text-shadow:0 0 30px rgba(200,16,46,.55), 0 8px 18px #000; transform:scale(1.25); transition:transform 1.6s cubic-bezier(.2,.8,.2,1); }
        #hud .menus .over.on .k { transform:scale(1); }
        #hud .menus .over .r { font-size:22px; letter-spacing:1em; color:#d9b45a; margin:10px 0 70px 1em; }
        #hud .menus .over .opt { font-size:26px; letter-spacing:.35em; color:#8a8070; padding:10px 34px; margin:4px; cursor:pointer; border:1px solid transparent; }
        #hud .menus .over .opt.sel { color:#f3dc8a; border-color:#d9b45a; background:rgba(217,180,90,.10); }
        #hud .menus .over .opt.sel::before { content:'▶ '; }
        #hud .menus .over .hint { margin-top:40px; font-size:13px; letter-spacing:.3em; color:#777; }
      </style>
      <div class="title"><div class="k" style="font-size:clamp(36px,7vw,100px)">ツインドラゴン</div><div class="r">TWIN DRAGON</div><div class="hint">WASD 移動 / Shift 走る / J 攻撃 / K 強攻撃 / Space 回避 / R ヒートアクション</div></div>
      <div class="pause"><div class="k">PAUSE</div>
        <div class="body"><div class="mapw"><div class="mh"><b>渋谷町</b><span class="area"></span></div><canvas class="map"></canvas>
          <div class="legend"><span><i class="me"></i>現在地</span><span><i class="obj"></i>目的地</span><span><i class="sub">!</i>依頼</span></div></div>
          <div class="ctl"></div></div><div class="hint"></div></div>
      <div class="results"></div>
      <div class="over"><div class="k">敗北</div><div class="r">GAME OVER</div>
        <div class="opt sel" data-i="0">コンティニュー</div><div class="opt" data-i="1">タイトルへ戻る</div>
        <div class="hint">↑↓ 選択　/　Enter・Space・クリック 決定</div></div>`;
    root.appendChild(el);
    this.el = { title: el.querySelector('.title'), pause: el.querySelector('.pause'), ctl: el.querySelector('.pause .ctl'), pauseHint: el.querySelector('.pause .hint'),
      pmap: el.querySelector('.pause canvas.map'), parea: el.querySelector('.pause .mh .area'),
      results: el.querySelector('.results'), over: el.querySelector('.over'), opts: [...el.querySelectorAll('.over .opt')] };
    this.renderControls(false);
    this.front = createStartScreen(engine, this);
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:12px;flex-wrap:wrap";
    for (const [label, page] of [["設定", "settings"], ["相関図", "relations"], ["開始画面へ", "title"]]) {
      const b = document.createElement("button"); b.textContent = label; b.style.cssText = "padding:12px 24px;background:#201b13;color:#f3dc8a;border:1px solid #d9b45a;cursor:pointer";
      b.onclick = () => { if(page === "title") { location.href = location.pathname; return; } this.el.pause.classList.remove("on");this.front.open(page); }; actions.append(b);
    }
    this.el.pause.append(actions);
    // 勝利 comes up once the final blow's slow motion has played out and the camera is back (combat.afterFinale)
    engine.events.on('combat:end', (ev) => {
      if (ev && ev.lost) return;
      const cb = engine.get('combat');
      if (cb && cb.afterFinale) cb.afterFinale(() => this.results({ win: true })); else this.results({ win: true });
    });

    // ---- game over. HP reaching zero used to leave 健人 face down forever: player.js stops updating a dead
    // player and nothing else ever looked. Now the fall plays out, the screen goes to 敗北, and the player
    // chooses to continue (the fight is re-staged from its start with full health) or go back to the title.
    engine.events.on('combat:ko', ({ target } = {}) => {
      if (!target || target !== engine.player || this.over) return;
      clearTimeout(this._got);
      this._got = setTimeout(() => this.gameOver(), 2400);     // let the knockdown land before the screen turns
    });
    this.el.opts.forEach((o) => {
      o.addEventListener('mouseenter', () => this.selectOver(+o.dataset.i));
      o.addEventListener('click', () => { this.selectOver(+o.dataset.i); this.confirmOver(); });
    });
    this.onOverKey = (ev) => {
      if (!this.over || ev.repeat) return;
      if (ev.code === 'ArrowUp' || ev.code === 'KeyW') { this.selectOver(0); ev.preventDefault(); }
      else if (ev.code === 'ArrowDown' || ev.code === 'KeyS') { this.selectOver(1); ev.preventDefault(); }
      else if (ev.code === 'Enter' || ev.code === 'Space' || ev.code === 'NumpadEnter') { this.confirmOver(); ev.preventDefault(); }
    };
    window.addEventListener('keydown', this.onOverKey, true);
  },

  gameOver() {
    const engine = this.engine;
    this.over = true; this.overSel = 0;
    // remember which fight was lost BEFORE combat:end clears it, so continue can re-stage the same one
    const ms = engine.get('missions');
    this.lostCtx = ms ? ms.fightCtx : null;
    this.prevMode = engine.state.mode;
    engine.state.mode = 'paused'; engine.state.frozen = true;
    this.selectOver(0);
    this.el.over.classList.add('on');
    engine.events.emit('game:over', { ctx: this.lostCtx });
  },

  selectOver(i) {
    this.overSel = i;
    this.el.opts.forEach((o, k) => o.classList.toggle('sel', k === i));
  },

  confirmOver() {
    if (!this.over) return;
    if (this.overSel === 1) { location.href = location.pathname; return; }         // title: a clean restart
    this.continueGame();
  },

  continueGame() {
    const engine = this.engine;
    const en = engine.get('enemy'), pl = engine.get('player'), ms = engine.get('missions');
    const ctx = this.lostCtx;
    this.over = false;
    this.el.over.classList.remove('on');
    engine.state.frozen = false;
    // every module resets its fight state on combat:end; `lost` tells the two that would otherwise celebrate
    // (the 勝利 banner here, the results panel in missions) to stay out of it
    engine.events.emit('combat:end', { lost: true, enemies: en ? en.list.slice() : [] });
    if (en && en.clear) en.clear();
    const p = engine.player;
    if (ctx === 'main' && ms && ms.stageFight) {
      // the chapter-1 fight: back to the apron in front of ハチ公 and the same three men, straight into the fight
      ms.spawned = false;
      if (ms.stageHachiko) ms.stageHachiko();
      ms.stageFight();
      for (const e of (en && en.list) || []) { e.aggro = true; if (e.setState) e.setState('approach'); }
      engine.state.mode = 'combat';
      ms.fightCtx = 'main';
      engine.events.emit('combat:start', { enemies: en ? en.list.slice() : [] });
    } else if (['host','club'].includes(ctx) && ms?.startChapterFight) {
      ms.startChapterFight(ctx);
    } else {
      // anywhere else (a street fight, a car): get up where he fell, full health, fight over
      if (pl && pl.respawn && p) pl.respawn(p.position.clone(), p.yaw);
      engine.state.mode = 'explore';
    }
    if (p) { p.heat = 0; p.hitByCarT = 1.5; }
    engine.events.emit('game:continue', { ctx });
  },

  showTitle(seconds = 3.2) {
    const t = this.el.title, root = document.getElementById('hud');
    t.classList.add('on'); if (root) root.classList.add('titleon');
    clearTimeout(this._tt);
    if (seconds > 0) this._tt = setTimeout(() => { t.classList.remove('on'); if (root) root.classList.remove('titleon'); }, seconds * 1000);   // 0 = hold (shot preset)
  },

  // ---- 操作方法 on the pause screen. Keyboard + mouse by default; the standard-gamepad labels when a pad is
  // connected (input.js PADMAP). Each row: [keys..., '/', keys...] then the action, with an optional small note.
  renderControls(pad) {
    const K = (k, wide) => `<span class="kc${wide ? ' w' : ''}">${k}</span>`;
    const keys = (list) => list.map((k) => (k === '/' ? '<i>/</i>' : K(k, k.length > 3))).join('');
    const kb = {
      move: [
        [['W', 'A', 'S', 'D'], '移動', '矢印キーでも可'],
        [['Shift'], '走る', '移動中に長押し'],
        [['Space'], '回避', ''],
        [['マウス'], '視点', '画面クリックで視点操作が有効'],
        [['Q'], 'ロックオン', ''],
        [['E'], '話す・調べる', ''],
      ],
      fight: [
        [['J', '/', '左クリック'], '攻撃', '連打でラッシュコンボ'],
        [['K', '/', '右クリック'], '強攻撃', ''],
        [['L'], '掴み', ''],
        [['I'], 'ガード', '長押し'],
        [['R'], 'ヒートアクション', '極ゲージが溜まったとき'],
      ],
      back: [['Esc'], 'ゲームに戻る'],
    };
    const gp = {
      move: [
        [['L スティック'], '移動', ''],
        [['LT', '/', 'L3'], '走る', '移動中に押し続ける'],
        [['A'], '回避', ''],
        [['R スティック'], '視点', ''],
        [['LB'], 'ロックオン', ''],
        [['十字 ↑'], '話す・調べる', ''],
      ],
      fight: [
        [['X'], '攻撃', '連打でラッシュコンボ'],
        [['Y'], '強攻撃', ''],
        [['B'], '掴み', ''],
        [['RB'], 'ガード', '長押し'],
        [['RT'], 'ヒートアクション', '極ゲージが溜まったとき'],
      ],
      back: [['START'], 'ゲームに戻る'],
    };
    const T = pad ? gp : kb;
    const col = (title, rows) => `<div class="col"><h3>${title}</h3>${rows.map(([k, a, n]) =>
      `<div class="row"><span class="keys">${keys(k)}</span><span class="note">${a}${n ? `<small>${n}</small>` : ''}</span></div>`).join('')}</div>`;
    this.el.ctl.innerHTML = col('移動', T.move) + col('戦闘', T.fight);
    this.el.pauseHint.innerHTML = `${keys(T.back[0])} ${T.back[1]}${pad ? '' : '　　ゲームパッド接続時はパッドの割り当てを表示'}`;
    this._ctlPad = pad;
  },

  pause(on) {
    const engine = this.engine;
    if (engine.params?.shot) return;
    if (on) this.front?.save();
    this.paused = !!on;
    if (this.paused) { const pad = !!(engine.input && engine.input.gamepadConnected); if (pad !== this._ctlPad) this.renderControls(pad); }
    // the whole city with 健人 on it (client: 「Pauseボタンを押すと、マップ全体が表示され、自分が今いるところがわかるように」)
    if (this.paused) {
      const hud = engine.get('hud');
      const css = Math.max(260, Math.min(640, Math.floor(Math.min(window.innerHeight - 250, window.innerWidth * 0.5))));
      try { if (hud && hud.drawWorldMap) hud.drawWorldMap(this.el.pmap, css); } catch (e) { console.warn('[menus] pause map', e); }
      const area = hud && hud.el && hud.el.area;
      this.el.parea.textContent = area ? area.textContent : '';
    }
    this.el.pause.classList.toggle('on', this.paused);
    const root = document.getElementById('hud'); if (root) root.classList.toggle('paused', this.paused);   // shows the licence credit
    if (this.paused) { this.prevMode = engine.state.mode; engine.state.mode = 'paused'; engine.state.frozen = true; }
    else { engine.state.mode = this.prevMode || 'explore'; engine.state.frozen = false; }
  },

  results({ win = true } = {}) {
    const r = this.el.results, hud = this.engine.get('hud');
    const show = () => {
      r.textContent = win ? '勝利' : '敗北';
      r.classList.add('on');
      clearTimeout(this._rt); this._rt = setTimeout(() => r.classList.remove('on'), 2500);
    };
    // a stamp fired in the same beat (missions' 完) plays out first: the banner never sits under the stamp
    clearTimeout(this._rw);
    this._rw = setTimeout(() => { const w = hud && hud._stampT > 0 ? hud._stampT * 1000 : 0; this._rw = setTimeout(show, w); }, 0);
  },

  update() {
    this.front?.update();
    if (this.front?.active || this.engine.state.arrival || this.engine.state.videoPlaying) return;
    const input = this.engine.input;
    if (this.over) return;                       // Esc must not un-freeze the game-over screen
    if (input && input.buttons.pause.pressed) this.pause(!this.paused);
  },
};

// ?shot=title — the title card held over the night crossing
export const shotPresets = {
  title: { pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'night', setup(engine) { const m = engine.get('menus'); if (m && m.el) m.showTitle(0); } },
};
menus.shotPresets = shotPresets;

export default menus;
