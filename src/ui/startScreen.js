import { INITIAL_FACTS, STORY_REVISION, migrateStorySave } from '../story/storyState.js';
import { playTrainOpening } from './trainOpening.js';
import { playCityArrival } from './cityArrival.js';
import { createTitleEntrance, titleCharacters } from './titleEntrance.js';
import { renderRelationshipMap, mountRelationshipMap } from './relationshipMap.js';
// Front-end and versioned exploration checkpoints. Story revelations are explicit, never inferred from time.
const SAVE = 'shibuya.save.v1', SETTINGS = 'shibuya.settings.v1';
const FACTS = {
  letter: ['柊 誠司', '同期・かつての親友', '十年前の事件の真相を話したい、という手紙が届いた。約束はXX月XX日の20時、渋谷町のハチ公前。'],
  junior: ['商社時代の後輩', 'ハチ公前で救出', '後輩も柊に呼ばれ、ハチ公前で待っていた。玄凪会の男たちに絡まれたところを健人が救出。'],
  fightclub_conflict: ['ファイトクラブ', '撮影をきっかけに対立', '朝比奈未空・朝比奈快・那珂川天真。ホストから金を取る場面を撮影され、衝突した。'],
  fightclub_allies: ['ファイトクラブ', '誤解を解いた仲間', '後輩の証言とホストへの確認で誤解が解けた。3人と協力して街の背後にある力を探る。'],
  messengers: ['ハチ公前の男たち', '柊からの伝言を持つ', '健人に接触し、柊の名前を口にした。柊との詳しい関係は不明。'],
  reunion: ['柊 誠司', '再会した親友', '渋谷で再会。かつての商社マンとは異なる、冷たい態度を見せる。'],
  company: ['丸菱通商', '二人のかつての勤務先', '渋谷スクランブルスクエアに本社を置く商社。健人と柊は同期のライバルであり親友だった。'],
  past_case: ['十年前の機密事件', '二人の人生を変えた事件', '二人は社内の機密を知った。柊は罪を着せられて懲役八年。健人は退職して九州へ帰り、中小企業向けの経営コンサルを始めた。'],
  dtc: ['DTC', '調査対象の企業', 'デトロイトトーマスコンサルティング。経営支援を行う企業。'],
  gang: ['玄凪会', '九州から渋谷へ勢力を拡大', 'ハチ公前の男たちが所属する組織。男の証言によれば、柊も所属している。'],
  hiiragi_whereabouts: ['柊の行方', 'センター街へ', '玄凪会の男から、柊がセンター街へ入ったと聞き出した。'],
  infiltration: ['柊と組織', '組織の内部へ', '柊は冤罪の真相を追うため、組織に入っていた。'],
};
export function validSave(s) {
  return !!s && s.version === 1 && [1, 3, 4, 6].includes(s.step) && Number.isFinite(s.yen) && s.yen >= 0 &&
    Array.isArray(s.position) && s.position.length === 3 && s.position.every(v => Number.isFinite(v) && Math.abs(v) < 10000) &&
    Number.isFinite(s.yaw) && Number.isFinite(s.hp) && s.hp > 0 && s.hp <= 100 && Number.isFinite(s.heat) && s.heat >= 0 && s.heat <= 100 &&
    Array.isArray(s.done) && s.done.every(v => typeof v === 'string') && Array.isArray(s.facts) && s.facts.every(v => Object.hasOwn(FACTS, v)) && Number.isFinite(s.at);
}
function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
export function createStartScreen(engine, menus) {
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/shibuya-cho/src/ui/startScreen.css'; document.head.append(css);
  const relationCss = document.createElement('link'); relationCss.rel='stylesheet'; relationCss.href='/shibuya-cho/src/ui/relationshipMap.css'; document.head.append(relationCss);
  let relationView=null;
  const relationFacts=()=>f.started?[...f.facts]:f.saved()?.facts||INITIAL_FACTS;
  const el = document.createElement('section'); el.id = 'start-screen'; el.setAttribute('aria-label', 'ツインドラゴン 開始メニュー');
  document.body.append(el);
  const f = { engine, active: false, started: false, facts: new Set(INITIAL_FACTS), page: 'home', elapsed: 0, lastSave: 0, dirty: true };
  const entrance = createTitleEntrance(el, () => engine.get('audio'));
  const settings = read(SETTINGS) || {};
  f.settings = { sensitivity: Math.max(.5, Math.min(2, Number(settings.sensitivity) || 1)), hud: settings.hud === 'compact' ? 'compact' : 'normal' };
  f.write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { f.message('保存できません。ブラウザの保存領域を確認してください。'); return false; } };
  f.message = text => { const node = el.querySelector('[role=status]'); if (node) node.textContent = text; else console.warn('[save]', text); };
  f.applySettings = () => { const c = engine.get('camera'); if(c) c.sensitivity = .0024 * f.settings.sensitivity; document.body.classList.toggle('compact-hud', f.settings.hud === 'compact'); };
  const button = (id, jp, en) => `<button type="button" data-action="${id}"><span>${jp}</span><small>${en}</small><b aria-hidden="true">↗</b></button>`;
  f.saved = () => { const s = read(SAVE); return validSave(s) ? migrateStorySave(s) : null; };
  f.render = () => {
    entrance.stop();
    relationView?.destroy(); relationView=null;
    const saved = f.saved();
    el.dataset.page = f.page;
    let content = '';
    if (f.page === 'home') content = `<div class="brand"><p class="eyebrow">A STORY OF TRUST & BETRAYAL</p><h1 class="title-logo"><img src="/shibuya-cho/assets/menu/twin-dragon-logo-v1.png" width="1774" height="887" alt="ツインドラゴン — TWIN DRAGON"></h1><p class="tagline">十年ぶりの街。<br>一通の手紙。終わらない過去。</p></div><nav aria-label="開始メニュー">${button('new','ニューゲーム','NEW GAME')}${button('load','ロードゲーム','LOAD GAME')}${button('settings','設定','SETTINGS')}${button('relations','相関図','RELATIONSHIPS')}</nav><p class="save-note">${saved ? '保存あり · '+new Date(saved.at).toLocaleString('ja-JP') : '保存データなし · 探索中に自動保存'}</p>`;
    if (f.page === 'load') content = `<h2>ロードゲーム</h2><p class="lead">最後に保存された探索地点から再開します。</p>${saved ? `<div class="save-card"><span>AUTO SAVE / 01</span><h3>${({1:'第一章・ハチ公前へ',3:'第一章クリア後・自由探索',4:'第一章・センター街へ',6:'第一章・ファイトクラブとの遭遇'})[saved.step]}</h3><p>${new Date(saved.at).toLocaleString('ja-JP')}</p><p>所持金 ¥${saved.yen.toLocaleString('ja-JP')} · 判明情報 ${saved.facts.length}件</p>${button('resume','このデータで再開','CONTINUE')}</div>` : '<div class="empty">読み込める保存データがありません。<p>ニューゲームを始めると、探索中に自動保存されます。</p></div>'}`;
    if (f.page === 'new') content = `<h2>新しい物語を始める</h2><p class="lead">現在の自動保存は、新しい物語の保存時に置き換わります。</p>${button('begin','ニューゲームを開始','START')}`;
    if (f.page === 'settings') { const a = engine.get('audio'); content = `<h2>設定</h2><p class="lead">変更はすぐに適用・保存されます。</p><label class="setting">マスター音量 <output id="volume-value">${Math.round((a?.getVolume?.() ?? .75)*100)}%</output><input aria-label="マスター音量" type="range" min="0" max="100" value="${Math.round((a?.getVolume?.() ?? .75)*100)}" data-setting="volume"></label><label class="setting check">ミュート<input type="checkbox" data-setting="muted" ${a?.muted ? 'checked' : ''}></label><label class="setting">カメラ感度 <output id="sensitivity-value">${f.settings.sensitivity.toFixed(1)}×</output><input aria-label="カメラ感度" type="range" min="0.5" max="2" step="0.1" value="${f.settings.sensitivity}" data-setting="sensitivity"></label><label class="setting">HUD表示<select data-setting="hud"><option value="normal" ${f.settings.hud==='normal'?'selected':''}>標準</option><option value="compact" ${f.settings.hud==='compact'?'selected':''}>コンパクト</option></select></label>`; }
    if (f.page === 'relations') {
      content = renderRelationshipMap(relationFacts());
    }
    el.innerHTML = `${titleCharacters()}<div class="title-slash" aria-hidden="true"></div><div class="screen-shade"></div><div class="screen-content ${f.page==='home'?'home':'panel'}">${content}<p role="status" aria-live="polite"></p>${f.page!=='home' ? button('back','戻る','BACK') : ''}</div>${f.page==='home' ? '<button type="button" class="title-replay" data-action="title-replay">演出を再生 ↻</button>' : ''}<footer><span>TWIN DRAGON <i>／</i> ツインドラゴン</span><span>↑ ↓ 選択　Enter 決定　Esc 戻る</span></footer>`;
    if(f.page==='relations') relationView=mountRelationshipMap(el,relationFacts);
    requestAnimationFrame(() => el.querySelector('button')?.focus({preventScroll:true}));
    if (f.page === 'home') entrance.play();
  };
  f.open = (page='home') => { f.page=page; f.active=true; engine.state.mode='paused'; engine.state.frozen=true; document.exitPointerLock?.(); document.body.classList.add('front-open'); el.hidden=false; f.render(); };
  f.close = () => { entrance.stop(); relationView?.destroy(); relationView=null; f.active=false; el.hidden=true; document.body.classList.remove('front-open'); };
  f.begin = (save=null) => {
    const m=engine.get('missions'), p=engine.player;
    if(!m || !p) { f.message('読み込み中です。少し待ってから開始してください。'); return; }
    if(save)save=migrateStorySave(save);
    m.resetChapter();
    f.started=true; f.facts=new Set(save?.facts || INITIAL_FACTS); f.close();
    engine.state.mode='explore'; engine.state.frozen=false; menus.paused=false;
    if(save) {
      m.startAt=null; m.startScene=null;
      engine.get('player').respawn(p.position.clone().set(...save.position),save.yaw);
      p.hp=save.hp; p.heat=save.heat;
      m.setYen(save.yen,true); m.SUBSTORIES.forEach(s => { s.done=s.id==='tout' || save.done.includes(s.id); });
      m.setStep(save.step); if(save.step!==1) m.dropBriefcase();
    } else {
      m.startScene=null; m.startAt=null;
      playTrainOpening(engine, () => {
        m.setStep(1);
        playCityArrival(engine, () => {
          engine.state.mode='explore'; engine.state.frozen=false;
          engine.events.emit('story:reveal', {id:'letter'});
          f.dirty=true; document.getElementById('game')?.focus();
        });
      });
    }
    f.lastSave=performance.now(); if(save)document.getElementById('game')?.focus();
  };
  f.save = () => {
    const m=engine.get('missions'),p=engine.player;
    if(!f.started || !m || !p || p.hp<=0 || engine.state.mode!=='explore' || m.scene || m.talk || m._resHold || ![1,3,4,6].includes(m.index)) return false;
    const s={version:1,storyRevision:STORY_REVISION,at:Date.now(),step:m.index,position:p.position.toArray(),yaw:p.yaw,hp:p.hp,heat:p.heat,yen:m.yen,done:m.SUBSTORIES.filter(s=>s.done).map(s=>s.id),facts:[...f.facts]};
    if(!validSave(s)) return false;
    return f.write(SAVE,s);
  };
  el.addEventListener('click',ev => {
    const action=ev.target.closest('[data-action]')?.dataset.action; if(!action)return;
    if(action==='title-replay') { entrance.play(true); return; }
    if(action==='new') { if(f.saved()) { f.page='new';f.render(); } else f.begin(); }
    else if(action==='begin') f.begin();
    else if(action==='resume') { const s=f.saved(); if(s)f.begin(s); else {f.page='load';f.render();} }
    else if(action==='back') { if(f.started) {f.close();menus.el.pause.classList.add('on');} else { f.page='home';f.render(); } }
    else { f.page=action;f.render(); }
  });
  el.addEventListener('input',ev => {
    const t=ev.target,k=t.dataset.setting,a=engine.get('audio'); if(!k)return;
    if(k==='volume') {a?.setVolume(+t.value/100);el.querySelector('#volume-value').textContent=t.value+'%';}
    else if(k==='muted') a?.setMuted(t.checked);
    else { f.settings[k]=k==='sensitivity'?+t.value:t.value; f.applySettings();f.write(SETTINGS,f.settings);if(k==='sensitivity')el.querySelector('#sensitivity-value').textContent=(+t.value).toFixed(1)+'×'; }
  });
  window.addEventListener('keydown',ev => {
    if(!f.active)return;
    engine.get('audio')?.ensure?.();
    ev.stopImmediatePropagation();
    if(relationView?.key(ev))return;
    if(ev.key==='Escape') {ev.preventDefault();el.querySelector('[data-action=back]')?.click();return;}
    if(['ArrowDown','ArrowUp'].includes(ev.key) && !['INPUT','SELECT'].includes(ev.target.tagName)) {
      ev.preventDefault();const list=[...el.querySelectorAll('button,input,select')];const i=list.indexOf(document.activeElement);list[(i+(ev.key==='ArrowDown'?1:-1)+list.length)%list.length]?.focus();
    }
  },true);
  // Keep pointer events in menus from turning into gameplay attacks or story skips.
  el.addEventListener('pointerdown', () => engine.get('audio')?.ensure?.(), {capture:true});
  for(const type of ['mousedown','mouseup','pointerdown','pointerup']) el.addEventListener(type,ev=>ev.stopPropagation());
  engine.events.on('story:reveal', ({id}={}) => {if(Object.hasOwn(FACTS,id)){f.facts.add(id);f.dirty=true;if(f.active && f.page==='relations')f.render();}});
  engine.events.on('mission:step',({index}={})=>{f.dirty=true;});
  engine.events.on('engine:booted',()=>{f.applySettings(); if(engine.params?.raw?.arrivalPreview==='1'){
    // Explicit review entry: replay the real arrival without starting a game or touching saves.
    engine.state.mode='paused';engine.state.frozen=true;
    const review=document.createElement('aside');review.id='arrival-review';
    review.style.cssText='position:fixed;bottom:24px;left:24px;z-index:150;background:#10131ee8;color:#fff;padding:18px;border:1px solid #bba36c;font:14px sans-serif';
    review.innerHTML='<p>交差点の斜め俯瞰 → 渋沢 / 8秒</p><button style="padding:12px 20px">上空からの演出を再生</button> <a href="/shibuya-cho/" style="color:#e5c880">タイトル画面へ</a>';
    document.body.append(review);
    if(engine.params.raw.arrivalCapture==='1')import('../debug/arrivalCapture.js').then(({attachArrivalCapture})=>attachArrivalCapture(engine,review,playCityArrival));
    review.querySelector('button').onclick=()=>{review.hidden=true;playCityArrival(engine,()=>{engine.state.mode='paused';engine.state.frozen=true;review.hidden=false;review.querySelector('button').textContent='もう一度再生';});};
    return;
  } if(!engine.params?.shot && !engine.params?.cutscene && !engine.params?.raw?.sub){ f.open(); }});
  f.update=()=>{if(!f.started || f.active)return;const now=performance.now();if(now-f.lastSave>15000 || f.dirty){if(f.save()){f.lastSave=now;f.dirty=false;}}};
  window.addEventListener('pagehide',()=>f.save());
  el.hidden=true;
  return f;
}
