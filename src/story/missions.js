import { ConsultingFees } from './consultingFees.js';
import { installDoubleDragon } from './doubleDragon.js';
// [story] 序章「十年ぶりの渋谷」— 渋沢 健人 / SHIBUSAWA KENTO.
// Intro cutscene (letterbox + cinematic pan + speaker dialogue, skippable), 3D objective markers, mission 1
// (ハチ公前 → 対峙 → チンピラ3人 → リザルト), three substories with NPC talk, a yen counter and the
// engine.state.mode state machine. Script source of truth: docs/STORY.md.
//   missions.current  missions.STEPS  missions.setObjective(text, worldPos)  missions.setStep(i)
//   missions.play(sceneName)  missions.skip()  missions.addYen(n)  missions.SUBSTORIES
//   shotPresets: story_intro story_phone story_hachiko story_marker story_tout story_tourist story_colleague story_results
import * as THREE from 'three';
import { PED_SCANS, pedScanReady } from '../characters/humanoid.js';
import { CITY } from '../world/cityData.js';

// ハチ公前: the statue and the apron 8.5 m in front of it, where 健人 stands for the chapter-1 confrontation. Everything
// staged there is placed from the statue, so the set piece follows it if the square is re-surveyed.
const HK_PLAZA = (CITY.plazas || []).find((q) => q.id === 'hachiko');
const HK_S = new THREE.Vector3(HK_PLAZA ? HK_PLAZA.statue.pos[0] : 26, 0, HK_PLAZA ? HK_PLAZA.statue.pos[1] : 24);
const HK_F = HK_PLAZA ? new THREE.Vector3(Math.cos(HK_PLAZA.statue.rotY || 0), 0, -Math.sin(HK_PLAZA.statue.rotY || 0)) : new THREE.Vector3(0, 0, 1);
const HK_P = HK_S.clone().addScaledVector(HK_F, 8.5);                 // 健人's mark
const HK_YAW = Math.atan2(HK_S.x - HK_P.x, HK_S.z - HK_P.z);          // facing the statue
const hk = (along, across = 0, y = 0) => { const r = new THREE.Vector3(HK_F.z, 0, -HK_F.x); return HK_P.clone().addScaledVector(HK_F, -along).addScaledVector(r, across).setY(y); };

const HERO = '渋沢 健人';
const P = (x, y, z) => [x, y, z];
const _v = new THREE.Vector3();   // per-frame scratch (projectPrompts): no allocation in the render loop

// ------------------------------------------------------------------------------------------------ script data
const CH = '第一章';
const STEPS = [
  { id: 'intro', text: '渋谷町を歩け', pos: null, radius: 0, ch: CH },
  { id: 'go_hachiko', text: 'ハチ公前へ向かえ', pos: hk(2.5), radius: 5.5, head: '目的', ch: CH },
  { id: 'first_fight', text: 'チンピラを倒せ', pos: null, radius: 0, head: '戦闘', ch: CH },
  { id: 'free', text: '渋谷町を歩け', pos: null, radius: 0, head: '自由行動', ch: CH },
];

// A beat: { t, e?, camFrom?, cam?, say?[who,text], card?, msg?, stamp?, do?(engine) }
// `e` = fraction of the beat the camera move takes; < 1 lands the framing early and holds it under the line.
const SCENES = {
  intro: [
    { t: 4.6, camFrom: { pos: P(-4, 58, 76), lookAt: P(-4, 15, -10), fov: 42 }, cam: { pos: P(-4, 33, 41), lookAt: P(-4, 9, -17), fov: 42 }, e: 1.05,
      card: { no: '第一章', title: '十年ぶりの渋谷' } },
    { t: 4.6, e: 1.05, cam: { pos: P(-47, 8.2, 27), lookAt: P(2, 11, -14), fov: 46 },
      say: [HERO, '十年前、俺は商社を辞めて九州へ帰った。今は中小企業の経営を支えている。'] },
    { t: 4.2, e: 0.5, cam: { pos: P(-33.4, 1.62, 12.9), lookAt: P(-31, 1.5, 10.5), fov: 34 },
      say: [HERO, '……渋谷町か。変わっちまったな'] },
    // reverse angle from the north: the 東急プラザ frontage and the streetlights are behind the camera, so his
    // face and the phone are lit instead of silhouetted against the crossing.
    { t: 4.8, e: 0.45, cam: { pos: P(-30.2, 1.58, 7.6), lookAt: P(-31.0, 1.45, 10.5), fov: 32 },
      msg: { from: '柊からの手紙', body: '10年前のあの事件の真相について話したい。10月1日の20時、渋谷町のハチ公前で会おう。' }, say: [HERO, '……柊。懲役八年。あの時、俺たちは何も知らされなかった。'], key: true },
    { t: 3.6, e: 0.8, cam: { pos: P(-37, 8.5, 20), lookAt: P(-30.8, 1.3, 10.2), fov: 40 },
      say: [HERO, '十年経った。今度こそ、お前から話を聞かせてもらう。'] },
  ],
  // Chapter-one dialogue is installed once by doubleDragon.js.
  hachiko: [],
  epilogue: [],
};

// Substories: approach -> ! marker -> E -> dialogue -> (fight) -> reward.
const SUBSTORIES = [
  {
    id: 'tourist', no: '依頼 01', title: '道に迷った旅人', spot: [-60, -60], reward: 3000,
    // the client's Mexican traveller scan (fallback: the hiker, while the new scan is not built yet)
    npcs: [{ key: 'miguel', name: '旅行者 ミゲル', seed: 41, off: [0, 0], face: 'player', idle: 'phone', variant: ['ped_mexican_traveler_5850', 'ped_ready_for_the_trail_4758'] }],
    lines: [
      ['旅行者 ミゲル', 'スミマセン。ノンベイ……ヨコチョウ、ドコ?'],
      [HERO, '……のんべい横丁か'],
      ['旅行者 ミゲル', 'チズ、グルグルして、ワカラナイ'],
      [HERO, '線路沿いを北へ歩け。赤い提灯が見えたらそこだ'],
      ['旅行者 ミゲル', 'キタ! ……Thank you, おじさん!'],
      ['旅行者 ミゲル', 'コレ、オレイ。トッテ'],
      [HERO, 'いらん'],
      ['旅行者 ミゲル', 'Please. ……オネガイ'],
      [HERO, '……ああ'],
    ],
    outro: [[HERO, '……道を教えただけだ']],
  },
  {
    // the fight is with the tout himself (client 2026-09-25), not two strangers who appear in his place
    id: 'tout', no: '依頼 02', title: 'センター街のキャッチ', spot: [-36, -35.5], reward: 8000, fight: 1, fightNpc: 'catch',
    npcs: [{ key: 'catch', name: 'キャッチの男', seed: 77, off: [0, 0], face: 'player', variant: 'nightlife_king' }],
    lines: [
      ['キャッチの男', 'お兄さん! カラオケ、二時間飲み放題で三千円!'],
      [HERO, '急いでる'],
      ['キャッチの男', 'まあまあ、そう言わずに'],
      [HERO, '……その手を離せ'],
      ['キャッチの男', 'あァ? サラリーマンが粋がってんじゃねえぞ'],
    ],
    outro: [[HERO, 'スーツが台無しだ']],
  },
  {
    id: 'colleague', no: '依頼 03', title: '後輩の背中', spot: [29, 38], reward: 12000, fight: 2,
    npcs: [
      { key: 'saeki', name: '佐伯 涼太', seed: 23, off: [-0.75, 0.25], face: 'npc:tout2', variant: ['ped_formal_portrait_4019'] },   // client: a male salaryman scan (was a procedural woman)
      { key: 'tout2', name: 'ぼったくりの男', seed: 91, off: [0.75, -0.25], face: 'npc:saeki', variant: 'enforcer_b' },
    ],
    lines: [
      ['ぼったくりの男', 'だからァ、八万二千円。カードでも現金でもいいんだよ'],
      ['佐伯 涼太', 'そ、そんな……ビール二杯ですよ'],
      [HERO, '……佐伯'],
      ['佐伯 涼太', '渋沢先輩!? 東京に戻っていたんですか'],
      [HERO, '人を探しに来た'],
      [HERO, '交番の前で、いい度胸だ'],
      [HERO, '明細をもらおうか。相談に乗るのが今の仕事でな'],
      ['ぼったくりの男', '……あ?'],
      [HERO, '店名、住所、代表者名。全部書け'],
      ['ぼったくりの男', 'ふざけんな、このオッサンがァ!'],
    ],
    outro: [
      ['佐伯 涼太', '先輩……いまの、なんですか'],
      [HERO, '経営指導だ。価格の説明くらい、先にしろってな'],
      [HERO, 'あの店には二度と行くな。行くなら、俺に言え'],
      ['佐伯 涼太', '……はい'],
    ],
  },
];

const CSS = `
#hud .story { position:fixed; left:0; top:0; width:100vw; height:100vh; pointer-events:none; font-family:inherit; z-index:6; }

/* ---------------------------------------------------------------- dialogue box (fits its line, 28px gutters) */
#hud .story .dlg { position:absolute; left:50%; bottom:112px; transform:translateX(-50%) translateY(14px);
  width:fit-content; min-width:520px; max-width:min(1020px,76vw); padding:17px 34px 19px;
  background:linear-gradient(100deg,rgba(6,6,8,.94),rgba(10,10,14,.78));
  border-left:4px solid var(--gold,#d9b45a); border-right:1px solid rgba(217,180,90,.34);
  border-top:1px solid rgba(217,180,90,.28); border-bottom:1px solid rgba(217,180,90,.28);
  box-shadow:0 10px 34px rgba(0,0,0,.72), inset 0 1px 0 rgba(255,255,255,.06); opacity:0; transition:opacity .22s, transform .22s; }
#hud .story .dlg.on { opacity:1; transform:translateX(-50%) translateY(0); }
#hud .story.cine .dlg { bottom:calc(11vh + 58px); }
#hud .story .dlg .who { position:absolute; left:0; top:-20px; padding:4px 26px 4px 14px; font-size:19px; font-weight:800; letter-spacing:.14em;
  color:#100d06; background:linear-gradient(90deg,#f3dc8a,#d9b45a 65%,#a8862f); clip-path:polygon(0 0,100% 0,calc(100% - 15px) 100%,0 100%); }
#hud .story .dlg .txt { position:relative; display:flex; align-items:center; min-height:2.6em;
  font-size:25px; line-height:1.5; letter-spacing:.04em; color:#f6f1e4; text-shadow:0 2px 6px rgba(0,0,0,.9); }
/* .sz is an invisible copy of the finished line (cursor included) that fixes the box width and the wrap
   points; .run paints the typed text over it, so the ▼ always lands right after the last character. */
#hud .story .dlg .txt .sz { visibility:hidden; }
#hud .story .dlg .txt .run { position:absolute; left:0; right:0; top:50%; transform:translateY(-50%); }
#hud .story .dlg .cur { display:inline-block; margin-left:12px; font-size:15px; color:var(--gold2,#f3dc8a); opacity:0; animation:stbob 1s ease-in-out infinite; }
#hud .story .dlg.wait .run .cur { opacity:1; }
@keyframes stbob { 50% { transform:translateY(4px); } }

/* cutscene: the gameplay HUD steps aside. Gated on a STORY-owned class, never on .letterbox —
   heatActions.js also raises the letterbox and must keep its HP/Heat and enemy plates. */
#hud.cutscene .plate, #hud.cutscene .minimap, #hud.cutscene .objective, #hud.cutscene .district,
#hud.cutscene .enemies, #hud.cutscene .story .money, #hud.cutscene .story .dist { opacity:0 !important; transition:opacity .3s; }

/* ------------------------------------------------- objective band (story owns the objective's presentation) */
#hud .objective { right:0; top:22px; width:auto; max-width:540px; display:flex; flex-direction:column; align-items:flex-end;
  padding:11px 28px 13px 64px; background:linear-gradient(90deg,rgba(0,0,0,0),rgba(0,0,0,.76) 32%,rgba(0,0,0,.88));
  border-top:1px solid rgba(217,180,90,.26); border-bottom:1px solid rgba(217,180,90,.26); }
#hud .objective .head { align-self:flex-start; font-size:13px; letter-spacing:.34em; padding:3px 24px 3px 12px; text-shadow:none;
  clip-path:polygon(0 0,100% 0,calc(100% - 15px) 100%,0 100%); }
#hud .objective .text { margin-top:8px; font-size:20px; }

#hud .story .card { position:absolute; left:50%; top:40%; transform:translate(-50%,-50%); text-align:center; opacity:0; transition:opacity .9s;
  padding:46px 120px; background:radial-gradient(ellipse at center, rgba(0,0,0,.72) 0%, rgba(0,0,0,.45) 45%, rgba(0,0,0,0) 72%); }
#hud .story .card.on { opacity:1; }
#hud .story .card .no { font-size:17px; letter-spacing:.85em; color:var(--gold,#d9b45a); text-indent:.85em; text-shadow:0 2px 8px #000; }
#hud .story .card .ttl { margin-top:14px; font-size:70px; font-weight:900; letter-spacing:.3em; text-indent:.3em; color:#fbf4e2;
  text-shadow:0 0 46px rgba(217,180,90,.55), 0 6px 18px #000; }
#hud .story .card .rule { width:320px; height:2px; margin:20px auto 0; background:linear-gradient(90deg,transparent,var(--gold,#d9b45a),transparent); }

/* ------------------------------------------------------------------------------- 携帯: message slab, not a tooltip */
#hud .story .msg { position:absolute; right:9vw; top:14%; width:392px; opacity:0; transform:translateY(-16px);
  transition:opacity .3s, transform .3s; }
#hud .story .msg.on { opacity:1; transform:translateY(0); }
#hud .story .msg.on .ph { animation:stshake .3s steps(2,end) 1; }
#hud .story .msg::after { content:''; position:absolute; top:38px; right:-9vw; width:9vw; height:1px;
  background:linear-gradient(90deg,rgba(217,180,90,.9),rgba(217,180,90,0)); }
#hud .story .msg .ph { position:relative; padding:9px 17px 17px; border:4px solid #1b1e26; border-radius:20px;
  background:linear-gradient(180deg,#0d0f15,#05060a); box-shadow:0 18px 44px rgba(0,0,0,.85), 0 0 0 1px rgba(217,180,90,.55), inset 0 1px 0 rgba(255,255,255,.07); }
#hud .story .msg .st { display:flex; align-items:center; gap:10px; font-size:10px; letter-spacing:.16em; color:#7e8595; }
#hud .story .msg .st .sig { margin-left:auto; }
#hud .story .msg .st .bat { width:18px; height:8px; border:1px solid #545b6b; border-radius:2px; position:relative; }
#hud .story .msg .st .bat::before { content:''; position:absolute; left:1px; top:1px; bottom:1px; width:11px; background:#8b93a4; }
#hud .story .msg .hd { margin-top:10px; display:flex; align-items:center; gap:10px; padding-bottom:8px; border-bottom:1px solid rgba(217,180,90,.38); }
#hud .story .msg .hd b { font-size:15px; font-weight:800; letter-spacing:.26em; color:var(--gold,#d9b45a); }
#hud .story .msg .hd i { font-style:normal; font-size:11px; font-weight:700; letter-spacing:.28em; color:#100d06; padding:2px 9px;
  background:linear-gradient(90deg,#f3dc8a,#c9a44a); }
#hud .story .msg .row { margin-top:11px; display:flex; align-items:center; gap:10px; }
#hud .story .msg .row .ic { width:27px; height:27px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  font-size:13px; color:#aeb5c4; background:linear-gradient(180deg,#333846,#1d212a); box-shadow:inset 0 1px 0 rgba(255,255,255,.12); }
#hud .story .msg .from { font-size:15px; letter-spacing:.14em; color:#c9cedb; }
#hud .story .msg .at { margin-left:auto; font-size:11px; letter-spacing:.1em; color:#6f7688; }
#hud .story .msg .body { margin-top:11px; font-size:24px; letter-spacing:.08em; color:#fff; text-shadow:0 2px 8px rgba(0,0,0,.85); }
@keyframes stshake { 0%{transform:translate(0,0)} 30%{transform:translate(-6px,2px)} 60%{transform:translate(5px,-2px)} 100%{transform:translate(0,0)} }

#hud .story .money { position:absolute; left:28px; bottom:158px; display:flex; align-items:baseline; gap:11px; padding:5px 18px 6px 14px;
  background:rgba(0,0,0,.88); border-left:3px solid var(--gold,#d9b45a); box-shadow:0 4px 14px rgba(0,0,0,.7); }
#hud .story .money .cap { font-size:11px; letter-spacing:.32em; color:var(--gold,#d9b45a); }
#hud .story .money .v { font-size:25px; font-weight:800; letter-spacing:.05em; color:#f6f1e4; font-variant-numeric:tabular-nums; }
#hud .story .money.up .v { color:#ffe9a8; text-shadow:0 0 16px rgba(255,210,74,.85); }

#hud .story .dist { position:absolute; right:0; top:108px; display:flex; align-items:center; justify-content:flex-end; gap:13px;
  padding:5px 28px 6px 46px; background:linear-gradient(90deg,rgba(0,0,0,0),rgba(0,0,0,.54) 40%,rgba(0,0,0,.72));
  font-size:13px; letter-spacing:.2em; color:#c4b896; text-shadow:0 2px 4px #000; opacity:0; transition:opacity .25s; }
#hud .story .dist.on { opacity:1; }
#hud .story .dist i { font-style:normal; color:rgba(217,180,90,.45); }
#hud .story .dist.nodist .sp2, #hud .story .dist.nodist .m { display:none; }
#hud .story .dist .m { font-size:17px; font-weight:800; letter-spacing:.05em; color:var(--gold2,#f3dc8a); font-variant-numeric:tabular-nums; }

#hud .story .prompt { position:absolute; left:0; top:0; transform:translate(-50%,-50%); display:flex; align-items:center; gap:9px; opacity:0; transition:opacity .18s; }
#hud .story .prompt.on { opacity:1; }
#hud .story .prompt .key { width:30px; height:30px; display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:800; color:#100d06;
  background:linear-gradient(180deg,#f3dc8a,#c9a44a); border-radius:50%; box-shadow:0 0 14px rgba(217,180,90,.8), 0 2px 5px #000; }
#hud .story .prompt .cap { font-size:14px; letter-spacing:.2em; color:#fff; text-shadow:0 2px 5px #000; background:rgba(0,0,0,.5); padding:2px 9px; }

#hud .story .bang { position:absolute; left:0; top:0; transform:translate(-50%,-50%); font-size:42px; font-weight:900; font-style:italic; color:#ffd24a;
  text-shadow:0 0 26px rgba(255,190,60,1), 0 0 8px rgba(255,150,30,.9), 0 3px 8px #000; opacity:0; transition:opacity .2s; animation:stbang 1.6s ease-in-out infinite; }
#hud .story .bang.on { opacity:1; }
@keyframes stbang { 50% { transform:translate(-50%,-62%); } }

#hud .story .notice { position:absolute; left:50%; top:11%; transform:translate(-50%,-10px); text-align:center; opacity:0; transition:opacity .35s, transform .35s;
  padding:30px 96px; background:radial-gradient(ellipse at center, rgba(0,0,0,.75) 0%, rgba(0,0,0,.4) 50%, rgba(0,0,0,0) 74%); }
#hud .story .notice.on { opacity:1; transform:translate(-50%,0); }
#hud .story .notice .no { display:inline-block; padding:3px 16px; font-size:13px; font-weight:700; letter-spacing:.3em; color:#100d06;
  background:linear-gradient(90deg,#f3dc8a,#c9a44a); }
#hud .story .notice .ttl { margin-top:10px; font-size:34px; font-weight:800; letter-spacing:.16em; color:#fbf4e2; text-shadow:0 3px 12px #000; }

#hud .story .res { position:absolute; left:50%; top:46%; transform:translate(-50%,10px); width:560px; padding:20px 32px 18px;
  background:linear-gradient(180deg,rgba(10,10,13,.95),rgba(4,4,6,.95)); border:1px solid rgba(217,180,90,.65);
  box-shadow:0 18px 50px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,255,255,.05); opacity:0; transition:opacity .35s, transform .35s; }
#hud .story .res.on { opacity:1; transform:translate(-50%,0); }
#hud .story .res .hd { position:relative; font-size:15px; letter-spacing:.5em; color:var(--gold,#d9b45a); text-align:center; border-bottom:1px solid rgba(217,180,90,.4); padding-bottom:12px; }
#hud .story .res .hd .seal { position:absolute; right:-6px; top:-20px; width:52px; height:52px; display:flex; align-items:center; justify-content:center;
  font-size:26px; font-weight:900; color:#f0e4c4; background:rgba(200,36,42,.88); border:2px solid rgba(255,225,190,.8); border-radius:5px;
  transform:rotate(-11deg); box-shadow:0 4px 14px rgba(0,0,0,.7); letter-spacing:0; }
#hud .story .res .row { display:flex; justify-content:space-between; align-items:baseline; margin-top:13px; }
#hud .story .res .row span { font-size:13px; letter-spacing:.26em; color:#b6ab92; }
#hud .story .res .row b { font-size:26px; font-weight:800; color:#f6f1e4; font-variant-numeric:tabular-nums; }
#hud .story .res .row b.y { color:#ffd98a; }
#hud .story .res .row.rank b { font-size:40px; font-style:italic; color:#ffd24a; text-shadow:0 0 22px rgba(255,200,80,.6); line-height:1; }
#hud .story .res .foot { margin-top:16px; padding-top:11px; border-top:1px solid rgba(217,180,90,.24); text-align:center;
  font-size:12px; letter-spacing:.26em; color:rgba(255,255,255,.55); }

#hud .story .skip { position:absolute; right:28px; bottom:calc(11vh + 52px); display:flex; align-items:center; gap:11px; opacity:0; transition:opacity .3s; }
#hud .story .skip.on { opacity:1; }
#hud .story .skip .key { position:relative; width:22px; height:22px; display:flex; align-items:center; justify-content:center;
  font-size:12px; font-weight:800; color:#100d06; background:linear-gradient(180deg,#f3dc8a,#c9a44a); border-radius:50%;
  box-shadow:0 0 12px rgba(217,180,90,.6), 0 2px 5px #000; }
#hud .story .skip .key::after { content:''; position:absolute; inset:-5px; border-radius:50%;
  background:conic-gradient(var(--gold2,#f3dc8a) calc(var(--k,0) * 360deg), rgba(255,255,255,.14) 0);
  -webkit-mask:radial-gradient(circle, transparent 0 63%, #000 64%); mask:radial-gradient(circle, transparent 0 63%, #000 64%); }
#hud .story .skip .cap { font-size:13px; letter-spacing:.22em; color:rgba(255,255,255,.8); text-shadow:0 2px 4px #000; }
`;

// ------------------------------------------------------------------------------------------------------ module
const missions = {
  name: 'missions',
  STEPS,
  SUBSTORIES,
  SCENES,
  index: 0,
  current: STEPS[0],
  yen: 12480,
  scene: null,          // { beats, i, t, name, onEnd }
  talk: null,           // { sub, lines, i, phase }
  fightCtx: null,       // 'main' | substory id
  hits: 0, bestCombo: 0, fightYen: 0, kos: 0, fightT: 0,
  holding: false, holdT: 0,
  _chain: [],           // every pending story setTimeout, so dispose()/play() can cancel the whole chain

  shotPresets: {
    story_intro:     { pos: [-4, 33, 41], lookAt: [-4, 9, -17], fov: 42, t: 'night', setup: (e) => missions.stage('intro', 0) },
    story_phone:     { pos: [-30.2, 1.58, 7.6], lookAt: [-31.0, 1.45, 10.5], fov: 32, t: 'night', setup: (e) => missions.stage('intro', 3) },
    story_hachiko:   { pos: hk(2.2, -4.2, 2.4).toArray(), lookAt: hk(2.2, 0, 1.4).toArray(), fov: 42, t: 'night', setup: (e) => missions.stage('hachiko', 2) },
    story_marker:    { pos: hk(12.5, -10.5, 3.2).toArray(), lookAt: hk(3.1, 0.2, 2.2).toArray(), fov: 42, t: 'night', setup: (e) => missions.stageMarker() },
    story_tout:      () => missions.subPreset('tout'),
    story_tourist:   () => missions.subPreset('tourist'),
    story_colleague: () => missions.subPreset('colleague'),
    story_results:   { pos: hk(0.5, -5, 3.2).toArray(), lookAt: hk(2.5, 0.5, 1.3).toArray(), fov: 44, t: 'night', setup: (e) => missions.stageResults() },
    story_epilogue:  { pos: hk(3.5, 0, 2.1).toArray(), lookAt: hk(0, 0, 1.6).toArray(), fov: 34, t: 'night', setup: (e) => missions.stage('epilogue', 1) },
  },

  // ---------------------------------------------------------------------------------------------------- boot
  init(engine) {
    this.engine = engine;
    installDoubleDragon(this, THREE);
    this.rng = engine.rng.fork ? engine.rng.fork(7717) : engine.rng;
    this.params = engine.params || {};
    this.buildUI();
    this.buildMarker();
    this.setYen(this.yen, true);
    this.nameHud();

    engine.events.on('combat:hit', ({ attacker }) => {
      if (attacker && attacker.isPlayer) { this.hits++; this.bestCombo = Math.max(this.bestCombo, attacker.combo || 0); }
    });
    this.consultingFees = new ConsultingFees();
    engine.events.on('combat:ko', ({ target }) => {
      const fee = this.consultingFees.collect(target, this.fightCtx, () => this.rng.range(800, 3000));
      if (!fee) return;
      this.kos++;
      if (!fee.amount) return;
      this.fightYen += fee.amount;
      this.addYen(fee.amount);
      this.notice('コンサル報酬 受領  +¥' + fee.amount.toLocaleString('ja-JP'), fee.reason, 2.8);
      engine.events.emit('consulting:paid', fee);
    });
    engine.events.on('combat:start', () => {
      this.consultingFees.begin(this.fightCtx);
      this.fightT = 0; this.dropBriefcase();
    });
    // a LOST fight also ends with combat:end (so every module resets its fight state), but it is not a win:
    // no results panel, no epilogue — menus.js runs the continue flow and re-stages the fight itself
    // ...and a won fight's results wait for the final blow's slow motion and camera return to play out (combat.js)
    engine.events.on('combat:end', (ev) => {
      if (ev && ev.lost) return;
      const cb = engine.get('combat');
      if (cb && cb.afterFinale) cb.afterFinale(() => this.onCombatEnd()); else this.onCombatEnd();
    });

    // Skipping a chapter opening is deliberate: only these keys, only the primary pointer button, only after
    // the scene has been running 0.6 s, and only on a 0.35 s hold (the badge fills while you hold).
    const SKIP_KEYS = { Space: 1, Enter: 1, NumpadEnter: 1, Escape: 1, KeyE: 1 };
    this.onKey = (ev) => {
      if (ev.type === 'keydown' ? ev.repeat : ev.button !== 0) return;
      if (this._resHold) { this.hideResults(); return; }          // the results panel waits for the player
      if (!this.holdable()) return;
      if (ev.type === 'keydown') { if (!SKIP_KEYS[ev.code]) return; ev.preventDefault?.(); }
      this.holding = true;
    };
    this.offKey = (ev) => {
      if (ev.type === 'keyup' && !SKIP_KEYS[ev.code]) return;
      this.holding = false; this.holdT = 0; this.setSkipFill(0);
    };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.offKey);
    window.addEventListener('pointerdown', this.onKey);
    window.addEventListener('pointerup', this.offKey);
    window.addEventListener('blur', this.offKey);

    if (this.params.shot) {
      this.setStep(1);
      // ?shot=<preset>&cutscene=<intro|hachiko> lays the cutscene UI over any camera, frozen on its key beat
      const cs = this.params.cutscene;
      if (cs && SCENES[cs]) { const i = SCENES[cs].findIndex(b => b.key); this.stage(cs, i < 0 ? 0 : i); }
      return;
    }

    // Gameplay boot: Kento has arrived in Shibuya to meet Hiiragi.
    const pl = engine.get('player');
    this.giveBriefcase();
    if (this.params.sub || (this.params.raw && this.params.raw.sub)) {
      const id = this.params.sub || this.params.raw.sub;
      const sub = SUBSTORIES.find(x => x.id === id);
      if (sub) {
        this.setStep(3);
        const npcs = this.npcFor(sub);
        if (pl && pl.respawn && sub._base) {
          const back = sub._base.clone().add(new THREE.Vector3(2.2, 0, 2.2));
          pl.respawn(new THREE.Vector3(back.x, 0, back.z), Math.atan2(sub._base.x - back.x, sub._base.z - back.z));
        }
        if (npcs && npcs.length) { this.startSubAt = 1.0; this.startSub = sub; }
        return;
      }
    }
    if (this.prepareChapterPreview?.(this.params.cutscene)) return;
    if (this.params.cutscene === 'hachiko') {                      // critics can jump straight to the confrontation
      this.stageHachiko();
      this.setStep(2);
      this.startAt = 0.6; this.startScene = 'hachiko';
      return;
    }
    if (pl && pl.respawn) pl.respawn(new THREE.Vector3(-31, 0, 10.5), 2.36);   // west arm, heading north-east for the crossing
    this.setStep(0);
    this.startScene = 'intro';
    this.startAt = this.params.cutscene === 'intro' ? 0.3 : 2.9;   // let the title card breathe
  },

  dispose() {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.offKey);
    window.removeEventListener('pointerdown', this.onKey);
    window.removeEventListener('pointerup', this.offKey);
    window.removeEventListener('blur', this.offKey);
    this.clearChain();
    for (const k of ['_cardT', '_msgT', '_notT', '_resT', '_yenT']) { clearTimeout(this[k]); this[k] = null; }
  },

  // every deferred story beat goes through here so nothing can fire after a scene, a talk or a dispose
  later(fn, ms) { const h = setTimeout(() => { this._chain = this._chain.filter(x => x !== h); fn(); }, ms); this._chain.push(h); return h; },
  clearChain() { for (const h of this._chain) clearTimeout(h); this._chain.length = 0; },

  // HUD name plate: docs/HERO.md §実装上の要求. hud.js ships a placeholder; the story owns the protagonist's name.
  nameHud() {
    const hud = this.engine.get('hud');
    const n = hud && hud.root && hud.root.querySelector('.plate .name');
    if (!n) return;
    const k = n.querySelector('.kanji'), r = n.querySelector('.romaji');
    if (k) k.textContent = HERO;
    if (r) r.textContent = 'SHIBUSAWA KENTO';
  },

  holdable() { return !!(this.scene && !this.scene.staticPose && this.scene.total > 0.6); },
  setSkipFill(k) {
    const el = this.ui && this.ui.skipKey; if (!el) return;
    if (this._skipK === k) return;
    this._skipK = k;
    el.style.setProperty('--k', k.toFixed(3));
  },

  // ------------------------------------------------------------------------------------------------------ UI
  buildUI() {
    const root = document.getElementById('hud') || document.body;
    const el = document.createElement('div');
    el.className = 'story';
    el.innerHTML = `<style>${CSS}</style>
      <div class="card"><div class="no"></div><div class="ttl"></div><div class="rule"></div></div>
      <div class="msg"><div class="ph">
        <div class="st"><span class="t">20:00</span><span class="sig">圏内</span><span class="bat"></span></div>
        <div class="hd"><b>メッセージ</b><i>受信</i></div>
        <div class="row"><span class="ic">✉</span><span class="from"></span><span class="at">たった今</span></div>
        <div class="body"></div></div></div>
      <div class="notice"><div class="no"></div><div class="ttl"></div></div>
      <div class="res"><div class="hd">戦闘終了<span class="seal">完</span></div>
        <div class="row rank"><span>評価</span><b class="r">C</b></div>
        <div class="row"><span>撃破数</span><b class="k">0</b></div>
        <div class="row"><span>ヒット数</span><b class="h">0</b></div>
        <div class="row"><span>最大コンボ</span><b class="c">0</b></div>
        <div class="row"><span>コンサル報酬</span><b class="y">¥0</b></div>
        <div class="fee-detail" style="white-space:pre-line;max-height:130px;overflow:auto;margin-top:16px;font-size:13px;line-height:1.7;color:#d9c99f;letter-spacing:.03em"></div><div class="foot">任意のキーで閉じる</div></div>
      <div class="dlg"><div class="who"></div>
        <div class="txt"><span class="sz"><span class="s"></span><span class="cur">▼</span></span><span class="run"><span class="t"></span><span class="cur">▼</span></span></div></div>
      <div class="bang">!</div>
      <div class="prompt"><span class="key">E</span><span class="cap">話す</span></div>
      <div class="dist"><span class="ch"></span><i>/</i><span class="st"></span><i class="sp2">/</i><span class="m"></span></div>
      <div class="money"><span class="cap">所持金</span><span class="v">¥0</span></div>
      <div class="skip"><span class="key">≫</span><span class="cap">長押しでスキップ</span></div>`;
    root.appendChild(el);
    const q = (s) => el.querySelector(s);
    this.ui = {
      root: el, card: q('.card'), cardNo: q('.card .no'), cardTtl: q('.card .ttl'),
      msg: q('.msg'), msgFrom: q('.msg .from'), msgBody: q('.msg .body'),
      notice: q('.notice'), noticeNo: q('.notice .no'), noticeTtl: q('.notice .ttl'),
      res: q('.res'), resR: q('.res .r'), resK: q('.res .k'), resH: q('.res .h'), resC: q('.res .c'), resY: q('.res .y'),
      dlg: q('.dlg'), who: q('.dlg .who'), txt: q('.dlg .txt .t'), sz: q('.dlg .txt .sz .s'),
      bang: q('.bang'), prompt: q('.prompt'), promptLb: q('.prompt .cap'),
      dist: q('.dist'), distCh: q('.dist .ch'), distSt: q('.dist .st'), distM: q('.dist .m'),
      money: q('.money'), moneyV: q('.money .v'), skip: q('.skip'), skipKey: q('.skip .key'),
    };
  },

  say(who, text) {
    const u = this.ui;
    const au = this.engine.get('audio');
    if (au && au.speakLine) au.speakLine(who, text);            // 健人's lines are voiced (assets/voice/hero_dlg_*)
    u.who.textContent = who || '';
    u.who.style.display = who ? '' : 'none';
    u.dlg.classList.add('on');
    u.dlg.classList.remove('wait');
    this.type = { full: text || '', n: 0, t: 0 };
    u.sz.textContent = this.type.full;   // invisible sizer: the box is the width of the finished line, so it never grows mid-type
    u.txt.textContent = '';
  },
  hideSay() { this.ui.dlg.classList.remove('on', 'wait'); this.type = null; },

  showCard(no, title) {
    const u = this.ui;
    u.cardNo.textContent = no; u.cardTtl.textContent = title;
    u.card.classList.add('on');
    clearTimeout(this._cardT); this._cardT = setTimeout(() => u.card.classList.remove('on'), 3400);
  },
  showMsg(from, body) {
    const u = this.ui;
    u.msgFrom.textContent = from; u.msgBody.textContent = body;
    u.msg.classList.remove('on'); void u.msg.offsetWidth;   // restart the 着信 shake
    u.msg.classList.add('on');
    clearTimeout(this._msgT); this._msgT = setTimeout(() => u.msg.classList.remove('on'), 6500);
  },
  notice(no, title, seconds = 3.2) {
    const u = this.ui;
    u.noticeNo.textContent = no; u.noticeTtl.textContent = title;
    u.notice.classList.add('on');
    clearTimeout(this._notT); this._notT = setTimeout(() => u.notice.classList.remove('on'), seconds * 1000);
  },

  setYen(v, silent = false) {
    this.yen = Math.max(0, Math.round(v));
    this.ui.moneyV.textContent = '¥' + this.yen.toLocaleString('en-US');
    if (silent) return;
    this.ui.money.classList.add('up');
    clearTimeout(this._yenT); this._yenT = setTimeout(() => this.ui.money.classList.remove('up'), 700);
  },
  addYen(n) { this.setYen(this.yen + n); return this.yen; },

  // -------------------------------------------------------------------------------------------- 3D marker
  // 64x256 so the shaft has a horizontal 1-|2u-1| falloff as well as the vertical ramp: a beacon, not a glass panel
  beamTexture() {
    if (this._beamTex) return this._beamTex;
    const W = 64, H = 256;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const cx = c.getContext('2d');
    const img = cx.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      const v = y / (H - 1);                                  // v=0 top of the shaft, v=1 at the ground
      const ramp = Math.pow(v, 2.1) * 0.9 + v * 0.1;
      for (let x = 0; x < W; x++) {
        const u = x / (W - 1);
        const side = Math.pow(1 - Math.abs(2 * u - 1), 1.35);  // soft edges, bright core
        const a = Math.min(1, ramp * (0.22 + side * 0.95));
        const i = (y * W + x) * 4;
        d[i] = 255; d[i + 1] = 226 - (1 - side) * 26; d[i + 2] = 160 - (1 - side) * 74; d[i + 3] = (a * 255) | 0;
      }
    }
    cx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    this._beamTex = tex;
    return tex;
  },

  glowTexture() {
    if (this._glowTex) return this._glowTex;
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const cx = c.getContext('2d');
    const g = cx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,226,150,0.85)'); g.addColorStop(0.35, 'rgba(255,206,100,0.34)');
    g.addColorStop(0.7, 'rgba(255,190,70,0.08)'); g.addColorStop(1, 'rgba(255,180,60,0)');
    cx.fillStyle = g; cx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this._glowTex = tex;
    return tex;
  },

  // a gold light shaft (camera-facing slab + bright inner core) + two counter-rotating ground rings +
  // a screen-size-clamped diamond drawn in two passes so an occluded waypoint dims instead of punching through walls
  makeMarker({ height = 10, radius = 1.25, color = 0xffd24a, chevY = 3.2, opacity = 0.74, glow = 0.82, ringOpacity = 0.82, chev = true } = {}) {
    const group = new THREE.Group();
    // the shaft is a billboard: the texture's horizontal 1-|2u-1| falloff then maps to the on-screen width,
    // so the beacon has soft side edges from every angle instead of the hard rectangle a cylinder gives.
    const beamMat = new THREE.MeshBasicMaterial({ map: this.beamTexture(), color: 0xfff0c0, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const beam = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.1, height), beamMat);
    beam.position.y = height / 2; beam.layers.enable(1); group.add(beam);
    const coreMat = new THREE.MeshBasicMaterial({ map: this.beamTexture(), color: 0xfff6dc, transparent: true, opacity: opacity * 0.8, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const core = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.1, radius * 0.19, height, 12, 1, true), coreMat);
    core.position.y = height / 2; core.layers.enable(1); group.add(core);

    // a soft pool of light on the ground separates the target from a scramble-crossing crowd
    const glowMat = new THREE.MeshBasicMaterial({ map: this.glowTexture(), color: 0xfff0c0, transparent: true, opacity: glow, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(radius * 3.8, radius * 3.8), glowMat);
    pool.rotation.x = -Math.PI / 2; pool.position.y = 0.03; pool.layers.enable(1); group.add(pool);

    const ringMat = new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: ringOpacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius * 1.16, 56), ringMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05; ring.layers.enable(1); group.add(ring);
    const ring2 = new THREE.Mesh(new THREE.RingGeometry(radius * 0.6, radius * 0.7, 40, 1, 0, Math.PI * 1.35), ringMat);
    ring2.rotation.x = -Math.PI / 2; ring2.position.y = 0.07; ring2.layers.enable(1); group.add(ring2);

    let dia = null, occ = null, halo = null;
    if (chev) {
      const geo = new THREE.OctahedronGeometry(0.34);
      // pass 1: depth-tested body at full strength. pass 2: a dim occluded ghost, so a waypoint behind a
      // wall stays findable without pasting a flat lozenge onto the wall.
      const bodyMat = new THREE.MeshBasicMaterial({ color: 0xfff4d2, transparent: true, opacity: 0.98, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      dia = new THREE.Mesh(geo, bodyMat);
      dia.scale.set(1, 1.6, 1); dia.position.y = chevY; dia.renderOrder = 998; dia.layers.enable(1); group.add(dia);
      const occMat = new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.25, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      occ = new THREE.Mesh(geo, occMat);
      occ.scale.set(1, 1.6, 1); occ.position.y = chevY; occ.renderOrder = 999; occ.layers.enable(1); group.add(occ);
      const haloMat = new THREE.MeshBasicMaterial({ map: this.glowTexture(), color: 0xffe9a8, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      halo = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.0), haloMat);
      halo.position.y = chevY; halo.renderOrder = 997; halo.layers.enable(1); group.add(halo);
    }

    this.engine.scene.add(group);
    const mats = [beamMat, coreMat, ringMat, glowMat];
    for (const m of mats) m.userData.base = m.opacity;
    return { group, beam, core, ring, ring2, chev: dia, occ, halo, mats, k: -1 };
  },

  buildMarker() {
    this.marker = this.makeMarker();
    this.marker.group.name = 'objectiveMarker';
    this.marker.group.visible = false;
  },

  // story owns when the waypoint is on screen: never during a cutscene or a conversation
  showMarker(on) {
    if (this.marker) this.marker.group.visible = !!on && !!this.objectivePos;
  },

  setObjective(text, pos, head) {
    const hud = this.engine.get('hud');
    if (hud) {
      if (hud.objective) hud.objective(text || '');
      hud.objectivePos = pos || null;
      const h = hud.root && hud.root.querySelector('.objective .head');
      if (h) h.textContent = head || '目的';
    }
    this.objectivePos = pos || null;
    if (pos && this.marker) this.marker.group.position.set(pos.x, this.groundAt(pos.x, pos.z), pos.z);
    this.showMarker(!this.scene && !this.talk);
    this.engine.events.emit('mission:objective', { text, pos });
  },

  groundAt(x, z) { const w = this.engine.world; return w && w.groundHeight ? w.groundHeight(x, z) : 0; },

  // Director's ring: while a scene is staged, push pedestrians out of the playing area so the framing reads.
  // They keep walking — we only displace them, and they flow back in as soon as the scene releases.
  clearStage(dt) {
    const c = this.stageFocus; if (!c) return;
    const peds = (this.engine.get('crowd') || {}).peds;
    if (!peds || !peds.length) return;
    const R = this.stageRadius, R2 = R * R;
    const warm = this._stageWarm;
    this._stageWarm = false;
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      const dx = p.x - c.x, dz = p.z - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R2) continue;
      const d = Math.sqrt(d2) || 1e-3;
      if (warm) {
        // first frame of a staging: clear the floor outright (the establishing shot hides it)
        const j = (((i * 2654435761) >>> 8) % 997) / 997;
        const k = (R + 0.15 + j * 1.8) / d;
        p.x = c.x + dx * k; p.z = c.z + dz * k;
      } else {
        // afterwards people just step aside as they wander back in
        const push = Math.min(3.4, (R - d) * 3.2) * dt / d;
        p.x += dx * push; p.z += dz * push;
      }
    }
  },

  setStageFocus(pos, radius = 4.6) {
    this.stageFocus = pos ? new THREE.Vector3(pos.x, 0, pos.z) : null;
    this.stageRadius = radius;
    this._stageWarm = !!pos;
    // path-bound walkers ignore a push (their position is re-read off the path every frame): the crowd keeps them out
    const cr = this.engine.get('crowd');
    if (cr) cr.stageBlock = pos ? { x: pos.x, z: pos.z, r: radius } : null;
  },

  setStep(i) {
    this.index = Math.max(0, Math.min(i, STEPS.length - 1));
    this.current = STEPS[this.index];
    this.setObjective(this.current.text, this.current.pos, this.current.head);
    this.engine.events.emit('mission:step', { id: this.current.id, index: this.index });
  },

  // ------------------------------------------------------------------------------------------- cutscenes
  play(name, onEnd = null) {
    const beats = SCENES[name];
    if (!beats) return false;
    const engine = this.engine;
    this.clearChain();
    this.hideResults();
    this.prevMode = engine.state.mode;
    engine.state.mode = 'cutscene';
    const hud = engine.get('hud');
    if (hud && hud.letterbox) hud.letterbox(true);
    if (hud && hud.root) hud.root.classList.add('cutscene');
    this.ui.root.classList.add('cine');
    this.ui.skip.classList.add('on');
    this.holding = false; this.holdT = 0; this.setSkipFill(0);
    this.showMarker(false);
    if (name === 'hachiko') this.stageHachiko();
    this.setStageFocus(engine.player ? engine.player.position : null, name === 'hachiko' ? 7.5 : 8.0);
    this.scene = { name, beats, i: -1, t: 0, total: 0, onEnd };
    this.nextBeat();
    return true;
  },

  nextBeat() {
    const s = this.scene; if (!s) return;
    s.i++;
    if (s.i >= s.beats.length) { this.endScene(); return; }
    s.t = 0;
    this.enterBeat(s.beats[s.i]);
  },

  // A beat camera expressed against the two actors: `back` along the player→enemy axis (negative = in front of
  // the player, looking back at him), `side` across it. Keeps framing valid wherever the confrontation lands.
  rig({ from = 'player', back = 2.5, side = 0, y = 1.8, look = 'enemy', lookY = 1.5, fov = 38 } = {}) {
    const p = this.engine.player ? this.engine.player.position : HK_P.clone();
    const e = this.enemyCentroid();
    const mid = new THREE.Vector3().addVectors(p, e).multiplyScalar(0.5);
    const axis = new THREE.Vector3().subVectors(e, p).setY(0);
    if (axis.lengthSq() < 1e-4) axis.set(0, 0, -1);
    axis.normalize();
    const perp = new THREE.Vector3(axis.z, 0, -axis.x);
    const anchor = from === 'enemy' ? e : from === 'mid' ? mid : p;
    const target = look === 'player' ? p : look === 'mid' ? mid : e;
    const pos = anchor.clone().addScaledVector(axis, from === 'enemy' ? back : -back).addScaledVector(perp, side);
    pos.y = this.groundAt(pos.x, pos.z) + y;
    const lookAt = target.clone(); lookAt.y += lookY;
    return { pos: pos.toArray(), lookAt: lookAt.toArray(), fov };
  },

  enemyCentroid() {
    const en = this.engine.get('enemy');
    const list = (en && en.list) ? en.list.filter(x => x.alive) : [];
    if (!list.length) {
      const p = this.engine.player ? this.engine.player.position : HK_P.clone();
      return new THREE.Vector3(p.x, p.y, p.z - 4.6);
    }
    const c = new THREE.Vector3();
    for (const x of list) c.add(x.position);
    return c.multiplyScalar(1 / list.length);
  },

  enterBeat(b) {
    const engine = this.engine, cam = engine.get('camera');
    if (b.do) { try { b.do(engine, this); } catch (err) { console.warn('[missions] beat failed', err); } }
    const shot = b.rig ? b.rig(this) : b.cam;
    if (b.camFrom && cam && cam.setFixed) cam.setFixed(new THREE.Vector3(...b.camFrom.pos), new THREE.Vector3(...b.camFrom.lookAt), { fov: b.camFrom.fov || 42 });
    if (shot && cam && cam.cinematic && !(this.scene && this.scene.staticPose)) {
      cam.cinematic({ pos: new THREE.Vector3(...shot.pos), lookAt: new THREE.Vector3(...shot.lookAt), fov: shot.fov || 40, ease: b.t * (b.e != null ? b.e : 0.55), duration: b.t + 90 });
    }
    if (b.card) this.showCard(b.card.no, b.card.title);
    if (b.msg) this.showMsg(b.msg.from, b.msg.body);
    if (b.say) this.say(b.say[0], b.say[1]); else this.hideSay();
    if (b.stamp) { const hud = engine.get('hud'); if (hud && hud.stamp) hud.stamp(b.stamp); }
  },

  skip() {
    const s = this.scene; if (!s) return;
    for (let i = s.i + 1; i < s.beats.length; i++) {
      const b = s.beats[i];
      if (b.do) { try { b.do(this.engine, this); } catch (e) { console.warn('[missions] beat failed', e); } }
    }
    s.i = s.beats.length;
    this.endScene();
  },

  endScene() {
    const s = this.scene; if (!s) return;
    this.scene = null;
    const engine = this.engine, hud = engine.get('hud'), cam = engine.get('camera');
    if (hud && hud.letterbox) hud.letterbox(false);
    if (hud && hud.root) hud.root.classList.remove('cutscene');
    this.ui.root.classList.remove('cine');
    this.ui.skip.classList.remove('on');
    this.ui.card.classList.remove('on');
    this.holding = false; this.holdT = 0; this.setSkipFill(0);
    this.hideSay();
    if (cam && cam.setFollow && engine.player) cam.setFollow(engine.player);
    this.setStageFocus(null);
    if (s.name === 'hachiko') {
      // 戦闘開始: a stamp and a short push-in hand control back on a sting instead of a bare mode flip
      engine.state.mode = 'combat';
      if (hud && hud.stamp) hud.stamp('戦');
      if (cam && cam.cinematic && engine.player) {
        const p = engine.player.position, e = this.enemyCentroid();
        const ax = new THREE.Vector3().subVectors(e, p).setY(0);
        if (ax.lengthSq() < 1e-4) ax.set(0, 0, -1);
        ax.normalize();
        const pos = p.clone().addScaledVector(ax, -3.1); pos.y = this.groundAt(pos.x, pos.z) + 1.9;
        const look = p.clone().addScaledVector(ax, 2.2); look.y += 1.3;
        cam.cinematic({ pos, lookAt: look, fov: 46, ease: 0.4, duration: 0.42 });
      }
    } else engine.state.mode = 'explore';
    this.showMarker(true);
    if (s.onEnd) { try { s.onEnd(); } catch (e) { console.warn('[missions] scene end failed', e); } }
  },

  // --------------------------------------------------------------------------------------- mission beats
  // 健人 stands on the open apron in front of ハチ公; the three are between him and the statue
  stageHachiko() {
    const pl = this.engine.get('player');
    if (pl && pl.respawn) pl.respawn(HK_P.clone(), HK_YAW);
  },

  stageFight() {
    const engine = this.engine, en = engine.get('enemy'), p = engine.player;
    if (!en || !en.spawnGroup || this.spawned) return;
    this.spawned = true;
    const base = p ? p.position : HK_P.clone();
    const yaw = p ? p.yaw : HK_YAW;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    this.fightCtx = 'main';
    this.hits = 0; this.bestCombo = 0; this.fightYen = 0; this.kos = 0; this.fightT = 0;
    const list = en.spawnGroup(3, base.clone().addScaledVector(fwd, 4.2));
    // spawnGroup rings them around the point; re-form them into a line facing 健人
    const lane = [-1.75, 0.15, 1.85], depth = [4.5, 3.7, 4.6];
    list.forEach((x, i) => {
      const q = base.clone().addScaledVector(fwd, depth[i % 3]).addScaledVector(right, lane[i % 3]);
      x.position.set(q.x, this.groundAt(q.x, q.z), q.z);
      x.yaw = Math.atan2(base.x - q.x, base.z - q.z);
      x.group.rotation.y = x.yaw;
    });
    engine.state.mode = 'cutscene';   // hold them until the last beat
  },

  giveBriefcase() {
    const h = this.engine.player && this.engine.player.humanoid;
    if (!h) return;
    try {
      if (h.setProp) h.setProp('briefcase');
      else if (h.attach) {
        const hm = this.engine.get('humanoid');
        const mesh = hm && hm.makeProp ? hm.makeProp('briefcase') : null;
        if (mesh) h.attach('briefcase', mesh, 'LeftHand');
      }
    } catch (e) { /* character module may not have props yet */ }
  },
  dropBriefcase() {
    const h = this.engine.player && this.engine.player.humanoid;
    if (!h || this.dropped) return;
    this.dropped = true;
    try { if (h.dropProp) h.dropProp(this.engine.scene); else if (h.detach) h.detach('prop'); } catch (e) { /* optional */ }
  },

  onCombatEnd() {
    const ctx = this.fightCtx;
    this.fightCtx = null;
    if (ctx === 'main') {
      this.showResults(() => this.play('epilogue', () => { this.setStep(3); this.notice('序章 完了', '十年ぶりの渋谷', 3.6); }));
      return;
    }
    const sub = SUBSTORIES.find(s => s.id === ctx);
    if (sub) this.showResults(() => this.startTalk(sub, sub.outro, true));
  },

  // S..D from how cleanly the fight went: combo length, hits taken out of the clock, KOs per second
  rank() {
    const t = Math.max(1, this.fightT);
    const score = this.bestCombo * 9 + this.kos * 14 + Math.max(0, 40 - t) * 1.1 + Math.min(this.hits, 30);
    return score >= 150 ? 'S' : score >= 118 ? 'A' : score >= 88 ? 'B' : score >= 58 ? 'C' : 'D';
  },

  showResults(onClose = null) {
    const u = this.ui, hud = this.engine.get('hud');
    u.resR.textContent = this.rank();
    u.resK.textContent = this.kos;
    u.resH.textContent = this.hits;
    u.resC.textContent = this.bestCombo;
    u.resY.textContent = '¥' + this.fightYen.toLocaleString('en-US');
    u.res.querySelector('.fee-detail').textContent = this.consultingFees.summary();
    // the 完 stamp lands first and the card comes in as it clears: stamped over the card (and the 勝利 banner) the
    // three read as one pile (readability review, P1: a stamp never shares the frame with text)
    if (hud && hud.stamp) hud.stamp('完');
    clearTimeout(this._resOnT);
    this._resOnT = setTimeout(() => { if (this._resHold) u.res.classList.add('on'); }, hud && hud.stamp ? 1050 : 0);
    this._resHold = true;
    this._resClose = onClose;
    this.engine.events.emit('mission:results', { rank: this.rank(), kos: this.kos, hits: this.hits, combo: this.bestCombo, yen: this.fightYen });
    clearTimeout(this._resT);
    this._resT = setTimeout(() => this.hideResults(), 6000);   // held until a key press, 6 s at the outside
  },

  hideResults() {
    if (!this._resHold) return;
    this._resHold = false;
    clearTimeout(this._resT); this._resT = null;
    this.ui.res.classList.remove('on');
    clearTimeout(this._resOnT);
    const fn = this._resClose; this._resClose = null;
    if (fn) this.later(() => { if (!this.scene && !this.talk) fn(); }, 700);
  },

  // ------------------------------------------------------------------------------------------ substories
  npcFor(sub) {
    if (sub._npcs) return sub._npcs;
    const engine = this.engine, hm = engine.get('humanoid');
    if (!hm || !hm.createHumanoid) return null;
    // Every person on the street is one of the client's scans (docs/PEDS.md): an NPC names its scan (or a list, the
    // first one registered wins) and is not built until that scan has loaded, or it would come out procedural.
    const pick = (v) => (Array.isArray(v) ? v.find((k) => !k.startsWith('ped_') || PED_SCANS.some((q) => q.variant === k)) : v);
    for (const def of sub.npcs) { const v = pick(def.variant); if (v && v.startsWith('ped_') && !pedScanReady(v)) return null; }
    const base = sub.fixed ? new THREE.Vector3(sub.spot[0],0,sub.spot[1]) : this.snap(sub.spot[0], sub.spot[1]);
    sub._npcs = [];
    for (const def of sub.npcs) {
      let h;
      try { h = hm.createHumanoid({ variant: pick(def.variant) || 'pedestrian', seed: def.seed }); }
      catch (e) { console.warn('[missions] npc failed', e); continue; }
      const x = base.x + def.off[0], z = base.z + def.off[1];
      h.group.position.set(x, this.groundAt(x, z), z);
      engine.scene.add(h.group);
      try { h.play(def.idle || 'idle', { fade: 0 }); h.mixer.update(this.rng() * 1.5); } catch (e) { /* clips may be missing */ }
      sub._npcs.push({ def, h, pos: h.group.position });
    }
    sub._base = base;
    if (sub._npcs.length) {
      sub._pin = this.makeMarker({ height: 3.4, radius: 0.85, opacity: 0.2, glow: 0.3, ringOpacity: 0.7, chev: false });
      const a = sub._npcs[0].pos;
      sub._pin.group.position.set(a.x, this.groundAt(a.x, a.z), a.z);
    }
    return sub._npcs;
  },

  clearNpcs(sub) {
    for (const o of sub._npcs || []) this.engine.scene.remove(o.h.group);
    if (sub._pin) { this.engine.scene.remove(sub._pin.group); sub._pin = null; }
  },

  // nudge a nominal spot to walkable ground (sidewalk / pedestrian street) using city.field
  snap(x, z) {
    const city = this.engine.get('city');
    const f = city && city.field;
    if (!f || typeof f.sample !== 'function') return new THREE.Vector3(x, 0, z);
    const world = this.engine.world;
    const _p = new THREE.Vector3();
    const roomy = (px, pz) => {                       // no wall/prop within 2.6 m: conversations need a stage
      if (!world || typeof world.overlapSphere !== 'function') return true;
      try {
        const hits = world.overlapSphere(_p.set(px, 1.1, pz), 2.6, {}) || [];
        return !hits.some(h => h && h.tag !== 'ground');
      } catch (e) { return true; }
    };
    let best = [x, z], bestD = -1e9;
    for (let r = 0; r <= 12; r += 2) {
      const n = r === 0 ? 1 : 12;
      for (let a = 0; a < n; a++) {
        const ang = (a / n) * Math.PI * 2 + r * 0.19, px = x + Math.cos(ang) * r, pz = z + Math.sin(ang) * r;
        let d;
        try { d = f.sample(px, pz); } catch (e) { return new THREE.Vector3(x, 0, z); }
        if (!roomy(px, pz)) continue;
        if (d > bestD) { bestD = d; best = [px, pz]; }
        if (d > 1.6) return new THREE.Vector3(px, 0, pz);
      }
    }
    return new THREE.Vector3(best[0], 0, best[1]);
  },

  // the most open compass direction out of a spot: used to seat 健人 and the camera where nothing blocks them
  openDir(base) {
    const world = this.engine.world, city = this.engine.get('city');
    const probe = new THREE.Vector3();
    let best = new THREE.Vector3(0, 0, 1), bestScore = -1e9;
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const d = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
      let score = 0;
      for (const r of [2.4, 4.2, 6.0]) {
        const px = base.x + d.x * r, pz = base.z + d.z * r;
        if (world && typeof world.overlapSphere === 'function') {
          try { if ((world.overlapSphere(probe.set(px, 1.1, pz), 1.5, {}) || []).some(h => h && h.tag !== 'ground')) score -= 40; } catch (e) { /* optional */ }
        }
        if (city && city.field) { try { score += city.field.sample(px, pz); } catch (e) { /* optional */ } }
      }
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  },

  // seats 健人 in front of the NPCs on open ground and returns the over-the-shoulder camera for it
  seatTwoShot(sub) {
    const base = sub._base || new THREE.Vector3(sub.spot[0], 0, sub.spot[1]);
    const dir = this.openDir(base);
    const perp = new THREE.Vector3(dir.z, 0, -dir.x);
    const p = this.engine.player;
    if (p) {
      const q = base.clone().addScaledVector(dir, 3.3);
      p.position.set(q.x, this.groundAt(q.x, q.z), q.z);
      p.yaw = Math.atan2(base.x - q.x, base.z - q.z);
      p.group.rotation.y = p.yaw;
    }
    for (const o of sub._npcs || []) o.h.group.rotation.y = Math.atan2(-dir.x, -dir.z);
    const camPos = base.clone().addScaledVector(dir, 6.1).addScaledVector(perp, 1.05);
    camPos.y = this.groundAt(camPos.x, camPos.z) + 2.05;
    const look = base.clone().addScaledVector(dir, 1.5); look.y = this.groundAt(look.x, look.z) + 1.5;
    return { pos: camPos.toArray(), lookAt: look.toArray(), fov: 40 };
  },

  startTalk(sub, lines, isOutro = false) {
    const engine = this.engine;
    if (this.scene) return;
    this.clearChain();
    this.talk = { sub, lines, i: -1, isOutro, hold: 0 };
    this.prevMode = engine.state.mode;
    engine.state.mode = 'cutscene';
    const hud = engine.get('hud');
    if (hud && hud.letterbox) hud.letterbox(true);
    if (hud && hud.root) hud.root.classList.add('cutscene');
    this.ui.root.classList.add('cine');
    this.ui.prompt.classList.remove('on');
    this.ui.bang.classList.remove('on');
    this.showMarker(false);
    if (!isOutro && !sub.started) { sub.started = true; this.notice(sub.no, sub.title, 3.0); }
    const anchor = (sub._npcs && sub._npcs[0]) ? sub._npcs[0].pos : null;
    if (sub._pin) sub._pin.visible = false;
    this.setStageFocus(anchor, 4.4);
    this.frameTalk(sub);
    this.nextLine();
  },

  frameTalk(sub) {
    const engine = this.engine, cam = engine.get('camera'), p = engine.player, npcs = sub._npcs;
    if (!cam || !cam.cinematic || !p || !npcs || !npcs.length) return;
    const n = npcs[0].pos;
    p.yaw = Math.atan2(n.x - p.position.x, n.z - p.position.z);
    p.group.rotation.y = p.yaw;
    for (const o of npcs) {
      const t = o.def.face === 'player' ? p.position : (npcs.find(q => 'npc:' + q.def.key === o.def.face) || npcs[0]).pos;
      o.h.group.rotation.y = Math.atan2(t.x - o.pos.x, t.z - o.pos.z);
    }
    // over 健人's shoulder: the ground he just walked across is the one place guaranteed to be clear
    const back = new THREE.Vector3().subVectors(p.position, n).setY(0);
    if (back.lengthSq() < 1e-4) back.set(0, 0, 1);
    back.normalize();
    const perp = new THREE.Vector3(back.z, 0, -back.x);
    const pos = p.position.clone().addScaledVector(back, 2.5).addScaledVector(perp, 0.95);
    pos.y = this.groundAt(pos.x, pos.z) + 2.0;
    const look = new THREE.Vector3().addVectors(p.position, n).multiplyScalar(0.5);
    look.y = this.groundAt(look.x, look.z) + 1.45;
    cam.cinematic({ pos, lookAt: look, fov: 40, ease: 0.7, duration: 1e4 });
  },

  nextLine() {
    const t = this.talk; if (!t) return;
    t.i++;
    if (t.i >= t.lines.length) { this.endTalk(); return; }
    const [who, text] = t.lines[t.i];
    this.say(who, text);
  },

  endTalk() {
    const t = this.talk; if (!t) return;
    const engine = this.engine, sub = t.sub, isOutro = t.isOutro;
    this.talk = null;
    this.hideSay();
    const hud = engine.get('hud'), cam = engine.get('camera');
    if (hud && hud.letterbox) hud.letterbox(false);
    if (hud && hud.root) hud.root.classList.remove('cutscene');
    this.ui.root.classList.remove('cine');
    if (cam && cam.setFollow && engine.player) cam.setFollow(engine.player);
    this.setStageFocus(null);
    this.showMarker(true);

    if (sub._pin && !sub.fight) sub._pin.visible = true;
    if (!isOutro && sub.fight) {
      engine.state.mode = 'explore';
      const en = engine.get('enemy');
      this.fightCtx = sub.id; this.hits = 0; this.bestCombo = 0; this.fightYen = 0; this.kos = 0; this.fightT = 0;
      this.setObjective(sub.fightNpc ? 'キャッチの男を黙らせろ' : '絡んできた連中を倒せ', null, '戦闘');
      // fightNpc: the one he was talking to squares up himself, in his own body and clothes, where he stood
      const lead = sub.fightNpc && (sub._npcs || []).find((o) => o.def.key === sub.fightNpc);
      const at = lead ? lead.pos.clone() : null, v = lead && (Array.isArray(lead.def.variant) ? lead.def.variant[0] : lead.def.variant);
      this.clearNpcs(sub);
      if (en && lead && en.spawn) {
        const out = [en.spawn('chinpira', at, { aggro: true, persona: 'guard', variant: v, name: lead.def.name, ownClothes: true })];
        out[0].aggro = true; if (en.go) en.go(out[0], 'approach');
        if (sub.fight > 1 && en.spawnGroup) out.push(...en.spawnGroup(sub.fight - 1, engine.player ? engine.player.position.clone() : at));
        if (engine.state.mode !== 'combat') { engine.state.mode = 'combat'; engine.events.emit('combat:start', { enemies: out }); }
      } else if (en && en.spawnGroup) en.spawnGroup(sub.fight, engine.player ? engine.player.position.clone() : new THREE.Vector3(...sub.spot));
      return;
    }
    engine.state.mode = 'explore';
    sub.done = true;
    if (sub.reward) this.addYen(sub.reward);
    this.notice('依頼 完了', sub.title, 3.4);
    this.clearNpcs(sub);
    this.setStep(3);
  },

  // -------------------------------------------------------------------------------------- preset staging
  stage(name, beatIndex) {
    const beats = SCENES[name]; if (!beats) return;
    this.scene = { name, beats, i: beatIndex, t: 0, staticPose: true, onEnd: null };
    const hud = this.engine.get('hud');
    if (hud && hud.letterbox) hud.letterbox(true);
    if (hud && hud.root) hud.root.classList.add('cutscene');
    this.ui.root.classList.add('cine');
    this.ui.skip.classList.add('on');
    this.showMarker(false);
    const b = beats[beatIndex];
    if (name === 'hachiko') {
      this.setStep(2);
      this.stageHachiko();
      this.stageFight();
    } else if (name === 'intro') this.stageIntro(b);
    else if (name === 'epilogue') { this.stageHachiko(); this.setStageFocus(hk(1.5), 5.0); }
    if (b.card) this.showCard(b.card.no, b.card.title);
    if (b.msg) this.showMsg(b.msg.from, b.msg.body);
    if (b.say) { this.say(b.say[0], b.say[1]); this.type.n = this.type.full.length; this.ui.txt.textContent = this.type.full; this.ui.dlg.classList.add('wait'); }
    // The cutscene UI is composited over the beat's OWN framing: a phone close-up laid over an unrelated wide
    // has no referent. ?keepCam=1 keeps the ?shot= preset's camera instead.
    if (!(this.params.raw && this.params.raw.keepCam === '1')) {
      const shot = b.rig ? b.rig(this) : b.cam;
      if (shot) this._stageCam = shot;
    }
    this._cardT && clearTimeout(this._cardT);
    this._msgT && clearTimeout(this._msgT);
  },

  // the intro beats are written for 健人 on the west arm of the crossing: put him there, phone in hand
  stageIntro(b) {
    const pl = this.engine.get('player'), p = this.engine.player;
    if (pl && pl.respawn) pl.respawn(new THREE.Vector3(-31, 0, 10.5), b && b.msg ? 2.36 : 1.62);
    this.setStageFocus({ x: -31, z: 10.5 }, 4.6);
    const h = p && p.humanoid; if (!h) return;
    try {
      if (b && b.msg) { if (h.setProp) h.setProp('phone'); if (h.pose) h.pose('phone', 0.45); }
      else { if (h.setProp) h.setProp('briefcase'); if (h.pose) h.pose('idle', 0.3); }
    } catch (e) { /* character module may not ship props/poses */ }
  },

  stageMarker() {
    this.setStep(1);
    this.setStageFocus(hk(2.5), 3.0);
    const p = this.engine.player, o = this.current.pos;
    if (p) { p.position.set(18.5, this.groundAt(18.5, 23), 23); p.yaw = Math.atan2(o.x - 18.5, o.z - 23); p.group.rotation.y = p.yaw; }
    this.updateDist();
  },

  stageSub(id) {
    const sub = SUBSTORIES.find(s => s.id === id); if (!sub) return null;
    this.setStep(3);
    const npcs = this.npcFor(sub);
    const shot = this.seatTwoShot(sub);
    if (npcs && npcs.length) this.setStageFocus(npcs[0].pos, 4.4);
    this.notice(sub.no, sub.title, 99);
    this.nearSub = sub;
    this.ui.bang.classList.add('on');
    this.ui.prompt.classList.add('on');
    return shot;
  },

  // shot preset for a substory: applyParams probes it before boot (no ui yet) -> return a placeholder;
  // applyPreset calls it again after init, when the staging can actually run.
  subPreset(id) {
    if (!this.ui) return { pos: [0, 3, 12], lookAt: [0, 1.5, -10], t: 'night' };
    const shot = this.stageSub(id);
    return shot ? { ...shot, t: 'night' } : { pos: [0, 3, 12], lookAt: [0, 1.5, -10], t: 'night' };
  },

  stageResults() {
    this.setStep(2);
    this.hits = 14; this.bestCombo = 7; this.fightYen = 6420; this.kos = 3; this.fightT = 26;
    this.setYen(this.yen + 6420, true);
    this.showResults();
    clearTimeout(this._resT); this._resT = null;
    this.stageHachiko();
    this.stageFight();
    this.setStageFocus(hk(2.5), 7.5);
  },

  // ------------------------------------------------------------------------------------------------ frame
  update(dt, t) {
    const engine = this.engine, p = engine.player;
    if (!this.ui) return;
    const paused = engine.state.mode === 'paused';
    if (this._stageCam) { const s = this._stageCam; this._stageCam = null; const cam = engine.get('camera'); if (cam && cam.setFixed) cam.setFixed(new THREE.Vector3(...s.pos), new THREE.Vector3(...s.lookAt), { fov: s.fov || 40 }); }
    this.animMarker(dt, t);
    this.typewriter(dt);
    this.clearStage(dt);
    this.drawObjectivePin(t);
    if (this.stageFocus && this.scene && !this.scene.staticPose && engine.player) this.stageFocus.set(engine.player.position.x, 0, engine.player.position.z);
    if (engine.state.mode === 'combat') this.fightT += dt;
    // deliberate skip: hold one of the accepted keys for 0.35 s, the badge ring fills as you do
    if (this.holding && this.holdable()) {
      this.holdT += dt;
      this.setSkipFill(Math.min(1, this.holdT / 0.35));
      if (this.holdT >= 0.35) { this.holding = false; this.holdT = 0; this.setSkipFill(0); this.skip(); }
    } else if (this.holdT > 0) { this.holdT = 0; this.setSkipFill(0); }

    if (this.params.shot) { this.updateDist(); this.projectPrompts(); return; }
    if (paused) return;

    if (this.startSubAt != null) {
      this.startSubAt -= dt;
      if (this.startSubAt <= 0) { this.startSubAt = null; this.startTalk(this.startSub, this.startSub.lines, false); }
    }
    // --- intro kick-off
    if (this.startAt != null) {
      this.startAt -= dt;
      if (this.startAt <= 0) {
        this.startAt = null;
        if (this.startScene === 'hachiko') this.play('hachiko', () => this.setObjective('チンピラを倒せ', null, '戦闘'));
        else if (this.chapterSceneEnd?.[this.startScene]) this.play(this.startScene, this.chapterSceneEnd[this.startScene]);
        else this.play('intro', () => this.setStep(1));
      }
    }

    this.updateChapterActors?.(dt);
    this.syncStoryCast?.();
    // --- cutscene timeline
    if (this.scene) { this.scene.t += dt; this.scene.total += dt; if (this.scene.t >= this.scene.beats[this.scene.i].t) this.nextBeat(); this.projectPrompts(); return; }

    // --- conversation: advance with E / attack / click
    if (this.talk) {
      const inp = engine.input;
      const adv = inp && (inp.buttons.interact.pressed || inp.buttons.attack.pressed || inp.buttons.dodge.pressed);
      this.talk.hold += dt;
      if (this.type && this.type.n < this.type.full.length) { if (adv) { this.type.n = this.type.full.length; this.ui.txt.textContent = this.type.full; } }
      else if (adv && this.talk.hold > 0.25) { this.talk.hold = 0; this.nextLine(); }
      this.projectPrompts();
      return;
    }

    if (!p || engine.state.frozen) { this.projectPrompts(); return; }

    // --- step triggers
    const step = this.current;
    const d = this.updateDist();
    if (step.pos && step.radius > 0 && d != null && d < step.radius && step.id === 'go_hachiko') {
      this.setStep(2);
      this.play('hachiko', () => this.setObjective('チンピラを倒せ', null, '戦闘'));
    }

    // --- substories (unlocked after the first fight)
    this.updateChapter?.();
    if (this.index === 3 && engine.state.mode === 'explore') this.updateSubstories(dt);
    this.projectPrompts();
  },

  updateSubstories(dt) {
    const engine = this.engine, p = engine.player;
    let near = null, nearD = 1e9;
    for (const sub of SUBSTORIES) {
      if (sub.done) continue;
      const d = Math.hypot(p.position.x - sub.spot[0], p.position.z - sub.spot[1]);
      if (d < 70) this.npcFor(sub);
      if (d < nearD) { nearD = d; near = sub; }
    }
    // point the objective marker at the closest open substory
    if (near && this.current.id === 'free' && engine.state.mode !== 'combat') {   // a substory fight keeps its own objective
      const want = near._base || new THREE.Vector3(near.spot[0], 0, near.spot[1]);
      if (!this.objectivePos || this.objectivePos.distanceToSquared(want) > 1) this.setObjective(`依頼「${near.title}」へ向かえ`, want, '依頼');
      this.updateDist(nearD);
    }
    this.nearSub = (near && nearD < 4.2 && near._npcs && near._npcs.length && engine.state.mode === 'explore') ? near : null;
    if (this.nearSub && engine.input && engine.input.buttons.interact.pressed) this.startTalk(this.nearSub, this.nearSub.lines, false);
  },

  // 第一章 / 手順 n/N / 残り N m — computed in ?shot= presets too, so the required frames actually show it
  updateDist(dist) {
    const u = this.ui, p = this.engine.player, o = this.objectivePos;
    u.distCh.textContent = this.current.ch || CH;
    u.distSt.textContent = `手順 ${[1,2,3,11,4,5,6,7,8,9,10][this.index] || this.index+1}/${STEPS.length}`;
    let d = dist;
    if (d == null && o && p) d = Math.hypot(p.position.x - o.x, p.position.z - o.z);
    u.dist.classList.toggle('nodist', d == null);
    if (d != null) u.distM.textContent = `残り ${Math.max(0, Math.round(d))} m`;
    u.dist.classList.toggle('on', !this.talk);
    return d == null ? null : d;
  },

  typewriter(dt) {
    const ty = this.type; if (!ty) return;
    if (ty.n >= ty.full.length) { this.ui.dlg.classList.add('wait'); return; }
    ty.t += dt;
    const per = 0.024;
    while (ty.t >= per && ty.n < ty.full.length) { ty.t -= per; ty.n++; }
    this.ui.txt.textContent = ty.full.slice(0, ty.n);
  },

  animMarker(dt, t) {
    const cam = this.engine.camera;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad((cam && cam.fov ? cam.fov : 45) * 0.5));
    const hpx = Math.max(360, window.innerHeight || 1080);
    const spin = (m, base, k) => {
      if (!m || !m.group.visible) return;
      m.ring.rotation.z = t * 0.6 * k;
      m.ring2.rotation.z = -t * 1.5 * k;
      const s = 1 + Math.sin(t * 2.0) * 0.05;
      m.ring.scale.set(s, s, 1);
      if (m.beam && cam) m.beam.rotation.y = Math.atan2(cam.position.x - m.group.position.x, cam.position.z - m.group.position.z);
      if (!m.chev) return;
      const y = base + Math.sin(t * 2.4) * 0.2;
      m.chev.position.y = y; m.chev.rotation.y = t * 1.1;
      // clamp the diamond's on-screen size: it shrinks with distance up to 1x, never exceeding ~40 px tall
      const d = cam ? Math.max(1.5, cam.position.distanceTo(m.group.position)) : 20;
      const sc = Math.min(1, (40 / hpx) * 2 * d * tanHalf / 1.088);
      m.chev.scale.set(sc, sc * 1.6, sc);
      if (m.occ) { m.occ.position.y = y; m.occ.rotation.y = m.chev.rotation.y; m.occ.scale.copy(m.chev.scale); }
      if (m.halo) { m.halo.position.y = y; m.halo.scale.setScalar(sc * 1.15); if (cam) m.halo.quaternion.copy(cam.quaternion); }
    };
    spin(this.marker, 3.2, 1);
    const p = this.engine.player;
    for (const sub of SUBSTORIES) {
      const pin = sub._pin; if (!pin) continue;
      // a pin fades out as 健人 walks up to it: no light shaft in anyone's face during the conversation
      let k = 1;
      if (p) {
        const d = Math.hypot(p.position.x - pin.group.position.x, p.position.z - pin.group.position.z);
        k = Math.max(0, Math.min(1, (d - 1.8) / 2.0));
      }
      if (this.talk && this.talk.sub === sub) k = 0;
      if (Math.abs(k - pin.k) > 0.01) { pin.k = k; for (const m of pin.mats) m.opacity = m.userData.base * k; }
      pin.group.visible = pin.visible !== false && !this.scene && !this.talk && k > 0.02;
      if (pin.group.visible) spin(pin, 2.6, 1.4);
    }
  },

  // The waypoint pin is painted onto hud's minimap AFTER hud has drawn its vignette — hud.js:126 draws a dot
  // under it and the vignette swallows it. 7 px + black stroke + a pulsing ring so it reads against grey.
  drawObjectivePin(t = 0) {
    const engine = this.engine, hud = engine.get('hud'), o = this.objectivePos;
    if (!hud || !hud.mctx || !o) return;
    const prev = this._mmT; this._mmT = hud.minimapT;
    if (!(hud.minimapT > (prev == null ? -1 : prev))) return;   // only on the frame hud repainted the map
    if (hud.root && hud.root.classList.contains('cutscene')) return;
    const ctx = hud.mctx, W = 236, range = 70;
    const p = engine.player ? engine.player.position : { x: 0, z: 0 };
    const ox = Math.max(8, Math.min(W - 8, ((o.x - p.x) / range + 0.5) * W));
    const oy = Math.max(8, Math.min(W - 8, ((o.z - p.z) / range + 0.5) * W));
    const r = 10 + Math.sin(t * 3.2) * 3.4;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.55)';                                          // separates the pin from map labels
    ctx.beginPath(); ctx.arc(ox, oy, 11, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,210,74,' + Math.max(0, 0.7 - (r - 7) * 0.08).toFixed(2) + ')'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.translate(ox, oy); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#ffd24a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(-5, -5, 10, 10); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#231700';
    ctx.beginPath(); ctx.rect(-1.7, -1.7, 3.4, 3.4); ctx.fill();
    ctx.restore();
  },

  projectPrompts() {
    const engine = this.engine, u = this.ui, cam = engine.camera;
    const sub = this.nearSub;
    if (!sub || !sub._npcs || !sub._npcs.length || this.talk || this.scene) {
      if (!this.params.shot) { u.prompt.classList.remove('on'); u.bang.classList.remove('on'); }
      return;
    }
    const n = sub._npcs[0];
    const v = _v.set(n.pos.x, n.pos.y + 2.55, n.pos.z).project(cam);
    if (v.z > 1) { u.prompt.classList.remove('on'); u.bang.classList.remove('on'); return; }
    const x = (v.x * 0.5 + 0.5) * window.innerWidth, y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    u.bang.style.left = x + 'px'; u.bang.style.top = y + 'px';
    u.prompt.style.left = x + 'px'; u.prompt.style.top = (y + 52) + 'px';
    u.bang.classList.add('on');
    const d = engine.player ? Math.hypot(engine.player.position.x - n.pos.x, engine.player.position.z - n.pos.z) : 99;
    u.prompt.classList.toggle('on', d < 4.2);
  },

  selfTest() {
    const out = { steps: STEPS.length, scenes: Object.keys(SCENES).length, substories: SUBSTORIES.length, lines: 0, marker: !!this.marker, ui: !!this.ui };
    if (this.ui) {
      const r = this.ui.root.getBoundingClientRect(), c = this.ui.card.getBoundingClientRect();
      out.layout = `root ${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)} | card @${Math.round(c.left)},${Math.round(c.top)} | parent ${this.ui.root.parentElement && this.ui.root.parentElement.id}`;
    }
    for (const s of Object.values(SCENES)) for (const b of s) if (b.say) out.lines++;
    for (const s of SUBSTORIES) out.lines += s.lines.length + (s.outro ? s.outro.length : 0);
    const bad = [];
    for (const s of Object.values(SCENES)) for (const b of s) if (!(b.t > 0)) bad.push('beat without duration');
    for (const s of SUBSTORIES) { if (!s.lines.length) bad.push(s.id + ': no lines'); if (!s.title) bad.push(s.id + ': no title'); }
    out.ok = bad.length === 0;
    if (bad.length) out.problems = bad;
    return out;
  },
};

export default missions;
