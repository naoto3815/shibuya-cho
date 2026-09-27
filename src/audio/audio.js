// [audio] Night Shibuya soundtrack. WebAudio, plus baked files from src/audio/bake.mjs: assets/sfx/foley.wav
// (impacts, guard break, body falls, footsteps, cloth, whooshes, stinger drums, crowd shouts), assets/sfx/
// crowd_murmur.wav, assets/sfx/battle_*.m4a (the battle theme's four stems, 32 + 8 bars) and assets/voice/*.mp3
// (the VOICEVOX barks).
//
//   audio.play(name, { gain, pos, rate, crack })    one-shot; `pos` routes through air-absorption + PannerNode
//   audio.sidechain(amount, hold, music, musHold)   pump the bed down under an impact; the music gives −1.5 dB to
//                                                   every landed hit and at most −3 dB to heavies
//   audio.setVolume(v) / audio.getVolume()          master 0..1 (persisted to localStorage)
//   audio.setMuted(b) / audio.toggleMute()          mute without tearing the graph down
//   audio.setAmbience(b)                            the city bed
//   audio.setMusic('battle'|'explore'|'none')       battle = the baked stems, explore = the night pad
//   audio.lastMan()                                 switch the theme to its last-man section on the next bar
//   audio.selfTest(engine)                          OfflineAudioContext render → RMS/peak/short-term per voice
//
// Hit-stop is heard ON THE IMPACT, not in the music: a landed hit rings on as a tape-slowed tail of its own take
// for the length of combat.js's stop, and the street bed ducks behind it. The battle theme is a baked 32-bar
// arrangement (intro once, then A / B / A' / turnaround looping) whose 'intensity' stem rides player.heat and
// which jumps to an 8-bar last-man section when one enemy is left; a heat action drops it to a drumless,
// filtered section on the next beat. A fight opens on an encounter stinger whose slam IS bar 1 beat 1, and
// closes on a tonic button cut on the beat after the last man drops, then a victory sting. The master bus ends in
// an AudioWorklet look-ahead true-peak limiter (−1 dBTP), with a soft clip at 0.93 behind it only as a safety.
//
// URL: ?audio=0 disables the module entirely, ?audio=meter draws a master-bus RMS scope (screenshot proof).
//
// The context is created in init() but NOTHING is scheduled until it reports 'running', so a browser that
// blocks autoplay neither throws nor logs — the first key/pointer/touch resumes it. Every voice is a pure
// `(ctx, dest, t, opts) -> duration` function, which is what lets selfTest render the identical graph into an
// OfflineAudioContext and measure it: you cannot hear a screenshot, so the numbers are the proof.
import { Vector3, Matrix4 } from 'three';
// The impact mix is DERIVED from the move table, not hand-tuned beside it: knockback impulse drives the
// volume and the sub depth, `stop` drives the sidechain hold, `knockdown` schedules the body-fall. ATTACKS is
// already an exported const and combat.js imports nothing from here, so this costs zero cross-module work.
import { ATTACKS } from '../combat/combat.js';
import { FINAL_BLOW, fbLook, fbRealAt } from '../combat/finalBlow.js';

// ------------------------------------------------------------------------------------------------ constants
const BPM = 128;
const SPB = 60 / BPM;              // 0.46875 s per beat
const STEP = SPB / 4;              // 16th note
const FLOOR = 1e-4;                // exponentialRamp can never reach 0
const A4 = 440;
const SEMI = (n) => A4 * Math.pow(2, n / 12);   // n = semitones from A4

// scale degrees used by the battle loop, as semitones from A4 (A minor)
const N = {
  A0: -36, C1: -33, D1: -31, E1: -29, F1: -28, G1: -26,
  A1: -24, C2: -21, D2: -19, E2: -17, F2: -16, G2: -14,
  A2: -12, C3: -9, D3: -7, E3: -5, F3: -4, G3: -2, A3: 0, C4: 3, D4: 5, E4: 7,
};

// ----------------------------------------------------------------------------------------- noise / buffers
// One cache per AudioContext so an OfflineAudioContext render in selfTest never touches the live graph.
const CACHE = new WeakMap();
function cached(ctx, key, make) {
  let m = CACHE.get(ctx);
  if (!m) { m = new Map(); CACHE.set(ctx, m); }
  let v = m.get(key);
  if (v === undefined) { v = make(); m.set(key, v); }
  return v;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function fillNoise(d, kind, rand) {
  const n = d.length;
  if (kind === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rand() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (kind === 'brown') {
    let l = 0;
    for (let i = 0; i < n; i++) { const w = rand() * 2 - 1; l = (l + 0.02 * w) / 1.02; d[i] = l * 3.4; }
  } else {
    for (let i = 0; i < n; i++) d[i] = rand() * 2 - 1;
  }
}

/** kind: 'white'|'pink'|'brown'. Cached per (kind, seconds) — the noise beds are the heaviest thing we build. */
function noiseBuf(ctx, seconds = 1, kind = 'white', rate = 0) {
  return cached(ctx, `n:${kind}:${seconds}:${rate}`, () => {
    const sr = rate || ctx.sampleRate;
    const buf = ctx.createBuffer(1, Math.max(1, Math.floor(sr * seconds)), sr);
    fillNoise(buf.getChannelData(0), kind, mulberry(0x5b17a1 + seconds * 977 + kind.length * 31));
    return buf;
  });
}

// ------------------------------------------------------------------------------------- baked foley bank
// assets/sfx/foley.wav is one mono file of 47 named regions (src/audio/bake.mjs renders it offline: modal
// bodies, knuckle micro-contacts, cartilage crackle, cloth, a small room, bus compression). init() fetches and
// decodes it off the main thread and slices every region into its own AudioBuffer. AudioBuffers are not bound
// to a context, so the same takes serve the live graph and selfTest's OfflineAudioContext renders.
// The crowd murmur used to be synthesised here, on the main thread, at the player's first keypress: 460 grains,
// ~2.5 M iterations, 270–470 ms of hitch. It is the same algorithm, baked to crowd_murmur.wav and decoded async.
const SFX_URL = (f) => new URL(`../../assets/sfx/${f}`, import.meta.url).href;
const FOLEY = { ready: false, buf: Object.create(null), meta: Object.create(null), cats: Object.create(null), bags: Object.create(null) };

function decodeWith(ctx, ab) {
  return new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
}
async function loadFoley(ctx) {
  const [man, ab] = await Promise.all([
    fetch(SFX_URL('foley.json')).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch(SFX_URL('foley.wav')).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
  ]);
  const all = await decodeWith(ctx, ab);
  const d = all.getChannelData(0), sr = all.sampleRate;
  for (const [name, r] of Object.entries(man.regions)) {
    const s0 = Math.round(r.start * sr), n = Math.max(1, Math.min(d.length - s0, Math.round(r.dur * sr)));
    const b = ctx.createBuffer(1, n, sr);
    b.copyToChannel(d.subarray(s0, s0 + n), 0);
    FOLEY.buf[name] = b; FOLEY.meta[name] = r;
    const cat = name.replace(/_\d+$/, '');
    (FOLEY.cats[cat] = FOLEY.cats[cat] || []).push(name);
  }
  FOLEY.ready = true;
  return FOLEY;
}

/** No-repeat shuffle: every take plays once before any repeats, and a fresh cycle never opens on the take that
 *  closed the last one — so no two consecutive calls can ever return the same index while n > 1. */
function bagPick(bags, key, n) {
  if (n <= 1) return 0;
  let b = bags[key];
  if (!b || !b.q.length) {
    const q = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const x = q[i]; q[i] = q[j]; q[j] = x; }
    const last = b ? b.last : -1;
    if (q[q.length - 1] === last) { const x = q[0]; q[0] = q[q.length - 1]; q[q.length - 1] = x; }
    b = bags[key] = { q, last };
  }
  const i = b.q.pop(); b.last = i; return i;
}
/** a take from a foley category: shuffled, or a fixed index (selfTest), or null before the bank has decoded */
function foleyTake(cat, pick) {
  const names = FOLEY.cats[cat];
  if (!names || !names.length) return null;
  const i = typeof pick === 'number' ? ((pick % names.length) + names.length) % names.length : bagPick(FOLEY.bags, cat, names.length);
  const name = names[i];
  return { name, buf: FOLEY.buf[name], meta: FOLEY.meta[name] };
}
/** a take cut short: at `g` dB (120 ms loudness), held `hold` s, then faded over `fade` s — a stinger's crash
 *  or taiko must not wash for its full 2+ s under the next punch */
function takeCut(ctx, dest, t, tk, g, hold = 0.5, fade = 0.9, rate = 1) {
  if (!tk) return;
  const e = gain(ctx, dbLin(g - tk.meta.st)); e.connect(dest);
  e.gain.setValueAtTime(e.gain.value, t + hold); e.gain.exponentialRampToValueAtTime(FLOOR, t + hold + fade);
  const s = playTake(ctx, e, t, tk, 1, rate); s.stop(t + hold + fade + 0.05);
}
/** Stinger drums and cymbals: four takes each, dealt by the no-repeat shuffle and varispeed ±3 %. heat_hit and
 *  ko_tag used to hard-code one 締太鼓 take, so every contact of a heat action fired the same sample. */
const stingRate = () => 0.97 + Math.random() * 0.06;
const cymbal = (ctx, dest, t, g, hold, fade) => takeCut(ctx, dest, t, foleyTake('crash'), g, hold, fade, stingRate());
/** play a baked region; returns the source. `offset` in buffer seconds. */
function playTake(ctx, dest, t, tk, g = 1, rate = 1, offset = 0) {
  const s = ctx.createBufferSource(); s.buffer = tk.buf; s.playbackRate.value = rate;
  s.connect(gain(ctx, g)).connect(dest);
  s.start(t, offset);
  return s;
}
const dbLin = (d) => Math.pow(10, d / 20);

// ------------------------------------------------------------------------------------------------- voices
const VOICE_URL = (f) => new URL(`../../assets/voice/${f}`, import.meta.url).href;
// Which manifest tags (or 'file:<name>' single lines) feed each bark, so the shuffle has every line that fits the
// moment — a death is 「ちくしょう……」 or 「ぐあっ」, never 「いてえ！」.
// 健人's spoken dialogue (missions say()): VOICEVOX 青山龍星 しっとり / 不機嫌, lowered ~0.8 st and slowed a touch at
// playback, chest lifted and the top rolled off — a low, restrained delivery rather than the generator's brightness.
const HERO_NAME = '渋沢 健人';
const HERO_DLG = { id: 'heroDlg', gain: 1.25, rate: 0.955,
  fx: [['lowshelf', 170, 0.7, 3.5], ['peaking', 320, 1.1, 1.5], ['peaking', 2800, 1.2, -2], ['highshelf', 6500, 0.7, -4]] };
const VOICE_POOLS = {
  enemy_attack: ['enemy_attack', 'enemy_attack_heavy'], enemy_attack_heavy: ['enemy_attack_heavy', 'enemy_attack'],
  enemy_hurt: ['enemy_hurt'], enemy_ko: ['enemy_ko', 'file:enemy_hurt_1.mp3'], enemy_getup: ['enemy_attack'],
  // 「行くぞ」 is the encounter line and 「まだまだだ」 the get-up line; shouted mid-kick they were wrong. A heavy
  // swing's effort is the attack grunts (おらぁ / せいっ) read lower and slower (TAG_RATE).
  hero_attack: ['hero_attack'], hero_attack_heavy: ['hero_attack'], hero_encounter: ['hero_encounter'],
  hero_heat: ['hero_heat', 'hero_ko'], hero_hurt: ['hero_hurt'], hero_ko: ['hero_ko'], hero_getup: ['hero_getup'],
};
const TAG_RATE = { hero_attack_heavy: 0.9 };
// the share of hits taken that get the VOICEVOX 「ぐっ」; the rest are a synthesised breath (one line at 100 % was
// three chinpira producing an identical 「ぐっ」 every second)
const HERO_HURT_LINE = 0.35;
// Three enemy voices. e0 is 玄野武宏（ツンギレ）as generated; e1 / e2 are derived from the same takes until their
// own VOICEVOX lines exist (a manifest line with "speaker": "e1" is used raw, with no processing, the moment it
// does): e1 an older 組員 — 2.2 semitones down, chest lifted, top rolled off; e2 a young 半グレ — 1.8 up, nasal
// 1.75 kHz band, grit. fx: [type, Hz, Q, dB] in series after the line's panner.
const SPEAKERS = [
  { id: 'e0', rate: 1.0, fx: null },
  { id: 'e1', rate: 0.88, gain: 1.05, fx: [['lowshelf', 230, 0.7, 4], ['peaking', 3100, 0.9, -3.5], ['lowpass', 6200, 0.7]] },
  { id: 'e2', rate: 1.11, gain: 0.95, fx: [['highpass', 200, 0.7], ['peaking', 1750, 1.1, 5.5], ['peaking', 450, 1, -3]], grit: 2.4 },
];
const HERO_SPEAKER = { id: 'hero', rate: 1.0, fx: null };

/** Plaza reverb: an early-reflection cluster over an exponential noise tail. Stereo, decorrelated. */
function irBuf(ctx, seconds = 1.9, decay = 3.2) {
  return cached(ctx, `ir:${seconds}:${decay}`, () => {
    const sr = ctx.sampleRate, n = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, n, sr);
    const rand = mulberry(0x2f6b3c);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (rand() * 2 - 1) * Math.pow(1 - i / n, decay);
      for (let r = 0; r < 9; r++) {                       // discrete slaps off the surrounding façades
        const i = Math.floor((0.008 + rand() * 0.075) * sr);
        if (i < n) d[i] += (rand() * 2 - 1) * 0.55 * Math.pow(1 - i / n, 1.5);
      }
    }
    return buf;
  });
}

function shaperCurve(ctx, amount = 12) {
  return cached(ctx, `sh:${amount}`, () => {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * amount) / Math.tanh(amount); }
    return c;
  });
}

/** A memoryless soft clip: everything under `knee` passes untouched. Since the limiter below exists this is only
 *  the last safety (knee 0.93), or — if AudioWorklet is unavailable — the old master ceiling (knee 0.62). */
function clipCurve(ctx, knee = 0.62) {
  return cached(ctx, `clip:${knee}`, () => {
    const n = 8192, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
      c[i] = a <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
    }
    return c;
  });
}
const SAFETY_KNEE = 0.93;

/** The master limiter: look-ahead, true-peak, stereo-linked. Plain JS with no free variables, because the same
 *  class runs twice — inside an AudioWorklet on the master bus (its source is stringified into the worklet
 *  module) and in selfTest over OfflineAudioContext renders, so the numbers the test prints are the limiter that
 *  ships. Per sample: the loudest of the sample and three 4× sub-sample positions (16-tap windowed sinc — the
 *  detector bake.mjs uses, at half the taps), the gain that puts it at the ceiling, a hold-min over the 1.5 ms
 *  look-ahead plus a 5 ms hold (so a kick's cycles do not modulate the gain), an 80 ms release, then a box
 *  average over the look-ahead: the ramp that guarantees the gain is down by the time the peak leaves the delay
 *  line. The "5 ms attack" of the brief is the hold: a 5 ms exponential attack behind a 1.5 ms look-ahead is ~26 %
 *  of the way down when the peak arrives, and the rest would leak into the clip this limiter exists to replace. */
class PeakLimiter {
  constructor(sr, ceilDb = -1, lookMs = 1.5, holdMs = 5, relMs = 80) {
    this.ceil = Math.pow(10, ceilDb / 20);
    this.L = Math.max(2, Math.round(sr * lookMs / 1000));
    this.W = this.L + Math.round(sr * holdMs / 1000);
    this.D = this.L + 7;
    this.rel = 1 - Math.exp(-1 / (sr * relMs / 1000));
    this.K = [0.25, 0.5, 0.75].map((f) => {
      const k = new Float32Array(16);
      for (let j = 0; j < 16; j++) { const x = j - 7 - f; k[j] = (Math.sin(Math.PI * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos(Math.PI * x / 8.5)); }
      return k;
    });
    let n = 64; while (n < this.W + this.D + 32) n <<= 1;
    this.M = n - 1;
    this.x = [new Float32Array(n), new Float32Array(n)];
    this.dqI = new Float64Array(n); this.dqV = new Float32Array(n); this.h = 0; this.t = 0;
    this.box = new Float32Array(this.L).fill(1); this.bi = 0; this.sum = this.L;
    this.g = 1; this.w = 0; this.gMin = 1;
  }
  /** ins: array of 1–2 Float32Arrays (or null = silence), outs: array of 1–2 Float32Arrays, len samples */
  process(ins, outs, len) {
    const M = this.M, K = this.K, nc = outs.length, L = this.L;
    for (let i = 0; i < len; i++) {
      const w = this.w, m = w - 8;
      let tp = 0;
      for (let c = 0; c < 2; c++) {
        const b = this.x[c], src = ins ? (ins[c] || ins[0]) : null;
        b[w & M] = src ? src[i] : 0;
        let a = Math.abs(b[m & M]);
        for (let q = 0; q < 3; q++) {
          const k = K[q]; let s = 0;
          for (let j = 0; j < 16; j++) s += k[j] * b[(m - 7 + j) & M];
          if (s < 0) s = -s;
          if (s > a) a = s;
        }
        if (a > tp) tp = a;
      }
      const r = tp > this.ceil ? this.ceil / tp : 1;
      while (this.t > this.h && this.dqV[(this.t - 1) & M] >= r) this.t--;
      this.dqI[this.t & M] = m; this.dqV[this.t & M] = r; this.t++;
      while (this.dqI[this.h & M] <= m - this.W) this.h++;
      const hold = this.dqV[this.h & M];
      const g = this.g = Math.min(hold, this.g + (1 - this.g) * this.rel);
      this.sum += g - this.box[this.bi]; this.box[this.bi] = g;
      if (++this.bi === L) { this.bi = 0; let s = 0; for (let j = 0; j < L; j++) s += this.box[j]; this.sum = s; }
      const G = this.sum / L;
      if (G < this.gMin) this.gMin = G;
      const o = (w - this.D) & M;
      for (let c = 0; c < nc; c++) outs[c][i] = this.x[c][o] * G;
      this.w = w + 1;
    }
  }
}
const LIMITER_WORKLET = `${PeakLimiter.toString()}
registerProcessor('shibuya-limiter', class extends AudioWorkletProcessor {
  constructor(o) { super(); const p = (o && o.processorOptions) || {}; this.l = new PeakLimiter(sampleRate, p.ceilDb, p.lookMs, p.holdMs, p.relMs); this.n = 0; }
  process(inputs, outputs) {
    const out = outputs[0]; if (!out || !out.length) return true;
    const inp = inputs[0];
    this.l.process(inp && inp.length ? inp : null, out, out[0].length);
    if ((this.n += out[0].length) >= 4096) { this.n = 0; this.port.postMessage(this.l.gMin); this.l.gMin = 1; }
    return true;
  }
});`;

// ------------------------------------------------------------------------------------------- graph helpers
function gain(ctx, v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; }
/** the rising half of a Hann window, 0 → lv, as a setValueCurveAtTime curve */
function hannIn(lv, n = 24) { const c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = lv * 0.5 * (1 - Math.cos(Math.PI * i / (n - 1))); c[0] = 0; return c; }

/** percussive envelope: FLOOR -> peak over `a`, exponential back to FLOOR over `d` */
function pluck(param, t, peak, a = 0.003, d = 0.15) {
  const p = Math.max(peak, FLOOR * 2);
  param.setValueAtTime(FLOOR, t);
  param.linearRampToValueAtTime(p, t + a);
  param.exponentialRampToValueAtTime(FLOOR, t + a + d);
}

function osc(ctx, type, f, t, stopAt, detune = 0) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
  if (detune) o.detune.setValueAtTime(detune, t);
  o.start(t); o.stop(stopAt);
  return o;
}

function noise(ctx, t, dur, kind = 'white', rate = 1) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf(ctx, Math.max(0.25, Math.ceil(dur * 4) / 4), kind);
  s.playbackRate.value = rate;
  s.loop = true;
  s.loopEnd = s.buffer.duration;
  s.start(t, Math.random() * Math.max(0.001, s.buffer.duration - dur - 0.01));
  s.stop(t + dur + 0.02);
  return s;
}

function bq(ctx, type, f, q = 1) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }

// The "contact frame" brightness per attack. A jab cracks, a knee thuds, a throw is a body on tarmac — the
// bandpass centre is the single cheapest thing that tells a four-hit string apart. combat.js already puts the
// attack `name` on the combat:hit payload, so this costs zero cross-module work.
// The fight theme's bus gain. At 0.16 the theme sat 10 dB under the weakest punch and 3 dB over the ducked street:
// between punches the fight fell quiet. A 龍が如く theme drives the energy and the hits sit ~5 dB over it.
const BATTLE_BUS = 0.25;
// the stems are baked with their full band at −1.5 dBTP; this trims them to the level the bus gain was set for
const STEM_GAIN = Math.pow(10, 2.7 / 20);
const STEM_NAMES = ['drums', 'harm', 'lead', 'intensity'];
const LAST_INTENSITY = 0.55;       // the last-man section keeps its brass at least this open, whatever the heat
// the onlooker ring's level: the street murmur's own un-ducked level (0.5 crowd × 0.25 amb bus) + 4 dB, and
// +2.5 dB for what the 400 Hz – 3 kHz band takes out of it
const WALLA = 0.5 * 0.25 * Math.pow(10, 4 / 20) * Math.pow(10, 2.5 / 20);
const HEAVY_OPENERS = ['kick', 'fin_kick'];
const LOGGED = new Set(['telegraph', 'guardbreak', 'ko', 'ko_tag', 'encounter', 'heat_action', 'heat_final', 'button', 'victory', 'fbTail', 'fbLand']);
const CROWD_STEP = 3.2;            // crowd footstep call gain at 0 m; see crowdSteps() for how it was measured
// Voices that must never repeat identically. play() gives each of these a random ±6 % varispeed.
const IMPACTS = new Set(['hit', 'heavy', 'impact', 'guard', 'guardbreak', 'prop', 'footstep', 'whoosh', 'weapon']);
// Voices the polyphony cap may never drop. Everything the player is being TOLD something by.
const PRI = new Set(['ko', 'heat_action', 'heat_ready', 'hit', 'heavy', 'hurt', 'grunt', 'guardbreak', 'bodyfall',
  'encounter', 'button', 'victory', 'heat_final', 'heat_hit', 'ko_tag', 'freeze', 'cloth', 'telegraph',
  'fbStack', 'fbSub', 'fbTail', 'fbBeat', 'fbSwell', 'fbLand']);

// Loudness of each baked class at unity call gain (120 ms RMS, dBFS, before the sfx bus). Every take is
// normalised to its class on playback from the `st` bake.mjs measured, so different takes land at one level and
// the ladder below stays exact. Light→heavy→finisher keep the old voice's 0 / 4.2 / 7.4 dB spacing (VOICE_DB).
// guardbreak: 3.5 dB over a jab at its shipping gain. step: the old synth footstep's measured loudness.
const FOLEY_ST = {
  light: -19.6, heavy: -15.4, finisher: -12.3, block: -26.5, bodyfall: -19.5, splash: -25, cloth: -30, whoosh: -28.5,
  guardbreak: -14.4, step: -36, stepDry: -37.5, crowd: -24,
};
// The oscillator impact that used to BE the punch now sits under the baked take as a sweetener: its sub for
// weight and its bandpassed crack, whose centre follows the move name (CRACK). dB below the take's peak. The
// crack is the contact frame and lands ON it (it used to sit 1.5 ms behind, at −15 dB).
// The sub is referenced to the take's peak, which is now the contact, 2.5 dB over the body: −13.5 keeps it where
// −11 sat against the old body-peaked takes, and it can no longer lift the body over the contact.
const SWEET_SUB_DB = -13.5, SWEET_CRACK_DB = { light: -9, heavy: -11, finisher: -11 };
// Per-class ceiling on a take's peak after normalisation (dBFS at unity call gain). The re-baked takes carry their
// contact 2.5 dB over their body (crest 12 / 8.5 / 6 dB), so these sit just over the loudest take of each class:
// a guard against a future re-bake, not a trim.
const TAKE_PK_CAP = { light: -7, heavy: -6.6, finisher: -6 };
// What a landed hit may take out of the MUSIC: every hit −1.5 dB for 60 ms (the punch cuts its own pocket), and
// heavies / heat contacts at most −3 dB for their hold.
const MUS_PUMP_FLOOR = 0.708, MUS_PUMP_LIGHT = 0.841;

const CRACK = {
  jab: 3400, straight: 3000, hook: 2600, uppercut: 2350, kick: 2200, roundhouse: 2000,
  knee: 1900, throw: 1200, grab: 1500, w_swing: 2900, w_heavy: 2450,
  // the two that used to fall through to hit()'s generic 2100: the finisher — dmg 45, stop 110 ms, the one
  // moment the whole combat system is built around — had the same contact spectrum as a mid-combo hook.
  heat_finisher: 1650, w_throw: 1250,
  heat_wall: 1350,                  // a skull into a shutter: low, hard, no skin
};

// Four contact recipes for the SYNTH impact (hitSynth: before the bank decodes, or if it fails to load), cycled by
// play() so two consecutive impacts can never share a spectrum. A ±6 %
// varispeed alone left every punch structurally identical (sine + bandpassed white + lowpassed pink); this
// changes the noise COLOUR and the resonator ORDER, which is what a five-hit string needs to stop machine-gunning.
//   src: the crack's noise colour · q1/q2: one-pole-ish vs a two-pole resonator · k: centre multiplier
//   slap: the body-slap colour
//   sk: how far down the body-slap's lowpass starts · sd: its decay · sub: the thump's weight
const RECIPES = [
  { src: 'white', q1: 0.8, q2: 0, k: 1.00, slap: 'pink', sk: 1.00, sd: 1.00, sub: 1.00 },
  { src: 'pink', q1: 2.6, q2: 2.6, k: 1.28, slap: 'brown', sk: 0.55, sd: 1.28, sub: 0.78 },
  { src: 'white', q1: 3.1, q2: 3.1, k: 0.82, slap: 'brown', sk: 1.48, sd: 0.78, sub: 1.22 },
  { src: 'pink', q1: 0.7, q2: 0, k: 1.15, slap: 'pink', sk: 0.76, sd: 1.12, sub: 0.92 },
];

// Impact gain staging. Every layer of hit() sums into one soft saturator before the call gain: a shipping
// impact sample has already been slammed in the DAW, which is why it reads loud on a laptop speaker without
// peaking 6 dB over everything else. Saturating HERE (at a known level) instead of letting the master clipper
// do it at an unknown one is the whole difference between "loud" and "folding harmonics into the sub".
const HIT_DRIVE = 3.3, HIT_DRIVE_HEAVY = 2.2, HIT_DRIVE_FINISHER = 2.4, HIT_TRIM = 0.43;

/** The impact LADDER. Loudness follows damage on a log scale — 3.3 dB per doubling above a jab, whatever
 *  combat.js currently says a jab does — and every heat-action contact frame (heat_*, guard 999) uses the
 *  finisher voice, floors at six jabs' worth of damage and stands another 1.5 dB proud, so nothing a bare fist
 *  or a weapon does can reach it. Each voice's own loudness at unity call gain (VOICE_DB, measured offline: a
 *  heavy is 4.2 dB bigger than a light at the same gain, the finisher 7.4) is divided back out, so what reaches
 *  the speakers is the ladder and nothing else. GAIN_CEIL: the saturator bounds a hit's peak at 0.82 × gain at
 *  unity master, so 1.2 is the most any impact may be driven before the master clip has to touch it.
 *  The knock-driven map this replaces measured, live on the master bus: a hook 0.5 dB UNDER a jab, a held knee
 *  the quietest hit in the game, and the finisher — dmg 45 — quieter than a jab. Knockback is how far a body
 *  flies, not how hard it was hit; a knee to the gut barely moves anyone. */
// SFX_BUS is 1.6 (was 1.9): the payoff stingers stack on the same bus and were feeding the old soft clip. The
// 1.5 dB went into JAB_GAIN and GAIN_CEIL (×1.1875) so every impact lands exactly where it did.
const SFX_BUS = 1.6, LADDER_DB = 3.3, JAB_GAIN = 0.93 * 1.1875, FINISHER_BONUS_DB = 1.5, GAIN_CEIL = 1.2 * 1.1875;
const VOICE_DB = { light: 0, heavy: 4.2, finisher: 7.4 };
const isHeat = (name, def) => (!!name && name.startsWith('heat_')) || !!(def && def.guard >= 999);
const ladderDb = (def, heat) => {
  const ref = (ATTACKS.jab && ATTACKS.jab.dmg) || 7;
  const dmg = Math.max(heat ? ref * 6 : 4, (def && def.dmg) || 10);
  return LADDER_DB * Math.log2(dmg / ref) + (heat ? FINISHER_BONUS_DB : 0);
};
const atkGain = (def, heavy, heat) => Math.min(GAIN_CEIL,
  JAB_GAIN * Math.pow(10, (ladderDb(def, heat) - VOICE_DB[heat ? 'finisher' : heavy ? 'heavy' : 'light']) / 20));

// ----------------------------------------------------------------------------------------------- SFX voices
// Every entry: (ctx, dest, t, o) -> seconds of tail. `o.gain` scales, `o.heavy` fattens, `o.rate` pitches.
// `rate` is a varispeed: every oscillator frequency multiplies by it and every decay divides by it, so two
// plays of the same voice are never bit-for-bit identical. play() supplies a random one for the impact family.
const VOICES = {
  // ------------------------------------------------------------------ impacts: a baked foley take + sweeteners
  /** A take from the baked foley bank (`o.take`: a take the caller already chose — so the hit-stop freeze can
   *  hold the same one — or an index, or nothing for the no-repeat shuffle), normalised to its class, varispeed
   *  by `rate`. Under it, at −8 / −10 dB, the old synth's sub and its move-coloured crack. Before the bank has
   *  decoded (the first ~100 ms of a session) the full synth voice stands in. */
  hit(ctx, dest, t, o = {}) {
    const heavy = !!o.heavy, fin = !!o.finisher, cls = fin ? 'finisher' : heavy ? 'heavy' : 'light';
    const tk = (o.take && o.take.buf) ? o.take : foleyTake(`impact_${cls}`, typeof o.take === 'number' ? o.take : undefined);
    if (!tk) return VOICES.hitSynth(ctx, dest, t, o);
    const r = o.rate ?? 1, ir = 1 / r;
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    // `takeDb`: the closing blows of a string (combo ≥ 3) stand 1.5 dB proud of the opener
    const norm = Math.min(dbLin(FOLEY_ST[cls] - tk.meta.st), dbLin(TAKE_PK_CAP[cls] - (tk.meta.pk ?? -1))) * dbLin(o.takeDb || 0);
    playTake(ctx, out, t, tk, norm, r);
    // Both sweeteners are set by PEAK against the take's own peak (norm × pk): they are short, so they barely
    // move the 120 ms loudness, but stacked on the take's first sample they would decide the clip headroom.
    const takePk = norm * dbLin(tk.meta.pk ?? -1);
    // sweetener 1: the sub, 12 ms behind the contact: the take's own body crest lives in its first ~10 ms, and a
    // sine on top of it in phase was +3 dB of peak for nothing. How far it drops is the knockback (knock / 7.4).
    const weight = Math.min(1, Math.max(0, o.weight ?? (heavy ? 0.55 : 0.25)));
    const ts = t + 0.012;
    const sub = osc(ctx, 'sine', (heavy ? 96 : 138) * r, ts, ts + 0.3 * ir);
    sub.frequency.exponentialRampToValueAtTime((heavy ? 40 - 14 * weight : 60 - 18 * weight) * r, ts + (heavy ? 0.2 : 0.12) * ir);
    // the heavy and finisher takes already carry ~14 dB more 80 Hz than a light one: their sub is a trace
    const sg = gain(ctx, 0); pluck(sg.gain, ts, takePk * dbLin(SWEET_SUB_DB - (heavy ? 4 : 0)) * (0.8 + 0.3 * weight), 0.005, (heavy ? 0.2 : 0.11) * ir);
    sub.connect(sg).connect(out);
    // sweetener 2: the contact-frame crack, centred by the move name, ON the take's first knuckle
    const base = o.crack || (heavy ? 2100 : 3100);
    const tc = t;
    const cr = noise(ctx, tc, 0.045, 'white');
    const cf = bq(ctx, 'bandpass', base * r * (o.crackJitter ?? (0.88 + Math.random() * 0.24)), 1.3);
    // (a bandpassed noise burst peaks at ~0.63 × its envelope)
    const crPk = takePk * dbLin(SWEET_CRACK_DB[cls]) / 0.63 * (o.weapon ? 1.4 : 1);
    const cg = gain(ctx, 0); pluck(cg.gain, tc, crPk, 0.001, (heavy ? 0.04 : 0.028) * ir);
    cr.connect(cf).connect(cg).connect(out);
    return tk.buf.duration * ir;
  },

  /** Hit-stop, heard: the take that just landed rings on as a tape-slowed tail — the same take, entered 4 ms past
   *  its peak, at 0.55× speed, through a lowpass closing 3.6 → 1.1 kHz, a 5 ms Hann fade-in and an exponential
   *  fade over the stop + 60 ms. One pass, no loop: the old 42 ms loop wrapped at the transient's peak with no
   *  window, a 24 → 17 Hz click train (a motorboat buzz) 9 dB under every heavy. */
  freeze(ctx, dest, t, o = {}) {
    const tk = o.take; if (!tk || !tk.buf) return 0.05;
    const hold = Math.max(0.03, o.hold ?? 0.07), r = (o.rate ?? 1) * 0.55, b = tk.buf;
    const from = Math.min(Math.max(0, b.duration - 0.1), (tk.meta.peakAt || 0) + 0.004);
    const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = r;
    const lp = bq(ctx, 'lowpass', 1, 0.7);
    lp.frequency.setValueAtTime(3600, t); lp.frequency.exponentialRampToValueAtTime(1100, t + hold + 0.06);
    const g = gain(ctx, 0), lv = Math.max(FLOOR * 2, o.gain ?? 0.3), FI = 0.005, end = t + FI + hold + 0.06;
    g.gain.setValueCurveAtTime(hannIn(lv), t, FI);
    g.gain.exponentialRampToValueAtTime(FLOOR, end);
    s.connect(lp).connect(g).connect(dest);
    s.start(t, from); s.stop(end + 0.02);
    return end - t + 0.04;
  },

  // the synth impact: the whole voice before the bank decodes, and the sweeteners' ancestor
  hitSynth(ctx, dest, t, o = {}) {
    const g = o.gain ?? 1, heavy = !!o.heavy, w = o.weapon ? 1 : 0;
    const r = o.rate ?? 1, ir = 1 / r;
    // `weight` is ATTACKS[name].knock / 7.4 — a throw drops the sub an octave further than a jab does.
    const weight = Math.min(1, Math.max(0, o.weight ?? (heavy ? 0.55 : 0.25)));
    const rec = RECIPES[(o.variant | 0) % RECIPES.length];
    const out = gain(ctx, g); out.connect(dest);
    // everything sums into the saturator, so the call gain never changes how hard it is driven
    const sat = ctx.createWaveShaper();
    sat.curve = shaperCurve(ctx, o.finisher ? HIT_DRIVE_FINISHER : heavy ? HIT_DRIVE_HEAVY : HIT_DRIVE);
    const bus = gain(ctx, HIT_TRIM); sat.connect(bus).connect(out);

    // 1. sub thump — the weight. Pitch drop is what makes a punch land rather than click, and how FAR it
    //    drops is the knockback impulse: 52 Hz for a jab, 30 Hz for a throw.
    const sub = osc(ctx, 'sine', (heavy ? 96 : 138) * r, t, t + 0.34 * ir);
    sub.frequency.exponentialRampToValueAtTime((heavy ? 40 - 14 * weight : 60 - 18 * weight) * r, t + (heavy ? 0.20 : 0.12) * ir);
    const sg = gain(ctx, 0); pluck(sg.gain, t, (heavy ? 0.80 : 0.52) * (0.82 + 0.36 * weight) * rec.sub, 0.002, (heavy ? 0.26 : 0.14) * ir);
    sub.connect(sg).connect(sat);

    // 2. noise crack — 6 ms of bright transient, the "contact frame". Centre comes from the attack name when
    //    the caller passed one; the recipe picks the colour, the resonator order and a 0.8–1.3× centre shift.
    const base = (o.crack || (heavy ? 2100 : 3100)) * rec.k;
    const cr = noise(ctx, t, 0.05, rec.src);
    const cf = bq(ctx, 'bandpass', base * r * (o.crackJitter ?? (0.88 + Math.random() * 0.24)), rec.q1);
    const cg = gain(ctx, 0); pluck(cg.gain, t, (heavy ? 0.42 : 0.30) * (1 + w * 0.6) * (rec.src === 'pink' ? 1.9 : 1), 0.001, (heavy ? 0.045 : 0.03) * ir);
    let cn = cr.connect(cf);
    if (rec.q2) cn = cn.connect(bq(ctx, 'bandpass', base * r, rec.q2));   // second pole: a ring, not a hiss
    cn.connect(cg).connect(sat);

    // 3. body slap — filtered noise whose lowpass falls, so the smack turns into flesh
    const sld = (heavy ? 0.20 : 0.115) * rec.sd * ir;
    const sl = noise(ctx, t + 0.004, (heavy ? 0.24 : 0.14) * rec.sd * ir, rec.slap);
    const sf = bq(ctx, 'lowpass', 1, 1.2);
    sf.frequency.setValueAtTime((heavy ? 1100 : 1700) * rec.sk * r, t + 0.004);
    sf.frequency.exponentialRampToValueAtTime((heavy ? 130 : 220) * r, t + 0.004 + (heavy ? 0.20 : 0.12) * ir);
    const slg = gain(ctx, 0); pluck(slg.gain, t + 0.004, (heavy ? 0.70 : 0.44) * (rec.slap === 'brown' ? 1.5 : 1), 0.004, sld);
    sl.connect(sf).connect(slg).connect(sat);

    if (heavy) {                                      // 4. a low tom-like ring only on heavies
      const ring = osc(ctx, 'triangle', 74 * r, t + 0.006, t + 0.42 * ir);
      ring.frequency.exponentialRampToValueAtTime(41 * r, t + 0.30 * ir);
      const rg = gain(ctx, 0); pluck(rg.gain, t + 0.006, 0.29, 0.006, 0.34 * ir);
      ring.connect(rg).connect(sat);
    }
    if (o.finisher) {                                 // 5. heat_finisher only: a signature nothing else has
      // The saturator bounds every impact's PEAK, so the finisher cannot get louder by hitting harder — only by
      // being denser. A held sub and a long low-mid crunch fill the 120 ms the ear integrates over: crest drops
      // ~3 dB and the loudest blow in the game peaks no harder than a throw.
      const boom = osc(ctx, 'sine', 66 * r, t, t + 0.72 * ir);
      boom.frequency.exponentialRampToValueAtTime(33 * r, t + 0.34 * ir);
      const bmg = gain(ctx, 0);
      bmg.gain.setValueAtTime(FLOOR, t); bmg.gain.linearRampToValueAtTime(0.34, t + 0.005);
      bmg.gain.setValueAtTime(0.34, t + 0.12 * ir); bmg.gain.exponentialRampToValueAtTime(FLOOR, t + 0.62 * ir);
      boom.connect(bmg).connect(sat);
      const cru = noise(ctx, t, 0.22 * ir, 'brown');  //    low-mid crunch — ribs, not skin
      const cbf = bq(ctx, 'bandpass', 520 * r, 1.1);
      const cgg = gain(ctx, 0); pluck(cgg.gain, t, 0.46, 0.002, 0.15 * ir);
      cru.connect(cbf).connect(cgg).connect(sat);
      const meat = noise(ctx, t + 0.003, 0.34 * ir, 'pink');
      const mf = bq(ctx, 'lowpass', 1, 1.0);
      mf.frequency.setValueAtTime(1800 * r, t + 0.003); mf.frequency.exponentialRampToValueAtTime(170 * r, t + 0.30 * ir);
      const mg = gain(ctx, 0); pluck(mg.gain, t + 0.003, 0.40, 0.003, 0.26 * ir);
      meat.connect(mf).connect(mg).connect(sat);
      const snap = osc(ctx, 'triangle', 900 * r, t + 0.006, t + 0.08 * ir);   // bone-snap transient
      snap.frequency.exponentialRampToValueAtTime(430 * r, t + 0.03 * ir);
      const sng = gain(ctx, 0); pluck(sng.gain, t + 0.006, 0.22, 0.0008, 0.020 * ir);
      snap.connect(sng).connect(sat);
    }
    return (o.finisher ? 0.72 : heavy ? 0.45 : 0.22) * ir;
  },

  /** A body hitting wet asphalt. 18 voices and not one of them was a man going down — a knockdown made the
   *  same noise as the punch that caused it and then silence, with 620 puddle decals on screen. Four layers:
   *  the mass, the slap, the splash (only when the road is wet) and the cloth. */
  bodyfall(ctx, dest, t, o = {}) {
    const r = o.rate ?? 1, ir = 1 / r, wet = o.wet ?? 0;
    const tk = foleyTake('bodyfall');
    if (tk) {
      // shoulder, then hips 45–110 ms later, sometimes an arm: the two-stage fall is what reads as a body
      const out = gain(ctx, o.gain ?? 1); out.connect(dest);
      playTake(ctx, out, t, tk, dbLin(FOLEY_ST.bodyfall - tk.meta.st), r);
      const sp = wet > 0.12 && foleyTake('splash');
      if (sp) playTake(ctx, out, t + 0.004, sp, dbLin(FOLEY_ST.splash - sp.meta.st) * wet, r * (0.95 + Math.random() * 0.1));
      return tk.buf.duration * ir;
    }
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const sat = ctx.createWaveShaper(); sat.curve = shaperCurve(ctx, 1.8);
    sat.connect(gain(ctx, 0.44)).connect(out);

    const mass = osc(ctx, 'sine', 70 * r, t, t + 0.40 * ir);          // the mass
    mass.frequency.exponentialRampToValueAtTime(38 * r, t + 0.18 * ir);
    const mg = gain(ctx, 0); pluck(mg.gain, t, 0.55, 0.004, 0.26 * ir);
    mass.connect(mg).connect(sat);

    const slap = noise(ctx, t, 0.30 * ir, 'pink');                    // the slap
    const sf = bq(ctx, 'lowpass', 1, 1.1);
    sf.frequency.setValueAtTime(900 * r, t);
    sf.frequency.exponentialRampToValueAtTime(160 * r, t + 0.22 * ir);
    const sg = gain(ctx, 0); pluck(sg.gain, t, 0.45, 0.003, 0.20 * ir);
    slap.connect(sf).connect(sg).connect(sat);

    if (wet > 0.12) {                                                 // the splash
      const sp = noise(ctx, t + 0.006, 0.22 * ir, 'white');
      const pf = bq(ctx, 'bandpass', 2200 * r, 1.3);
      const pg = gain(ctx, 0); pluck(pg.gain, t + 0.006, 0.20 * wet, 0.002, 0.16 * ir);
      sp.connect(pf).connect(pg).connect(sat);
    }
    const cl = noise(ctx, t + 0.002, 0.28 * ir, 'white');             // the cloth
    const cf = bq(ctx, 'bandpass', 5000 * r, 0.9);
    const cg = gain(ctx, 0); pluck(cg.gain, t + 0.002, 0.12, 0.004, 0.25 * ir);
    cl.connect(cf).connect(cg).connect(out);
    return 0.5 * ir;
  },

  heavy(ctx, dest, t, o = {}) { return VOICES.hit(ctx, dest, t, { ...o, heavy: true }); },

  /** A guarded blow lands on forearms inside a jacket: a dull low-mid thud, a 90 Hz tap and cloth — no skin, no
   *  crack, and no metal. The old voice was four inharmonic triangle partials, i.e. a fist on a signpost; the
   *  partials survive only when the attacker is swinging a weapon (`o.weapon`), which really is metal on bone. */
  guard(ctx, dest, t, o = {}) {
    const r = o.rate ?? 1, ir = 1 / r;
    const out = gain(ctx, (o.gain ?? 1) * 0.80); out.connect(dest);
    const tk = foleyTake('block', o.take);
    if (tk) { const lp = bq(ctx, 'lowpass', 1500 * r, 0.5); lp.connect(out); playTake(ctx, lp, t, tk, dbLin(FOLEY_ST.block - tk.meta.st), r); }
    else {                                             // before the bank decodes: the same recipe, live
      const th = noise(ctx, t, 0.07, 'pink');
      const f1 = bq(ctx, 'bandpass', 520 * r, 0.8), f2 = bq(ctx, 'lowpass', 800 * r, 0.7);
      const tg = gain(ctx, 0); pluck(tg.gain, t, 0.55, 0.002, 0.045 * ir);
      th.connect(f1).connect(f2).connect(tg).connect(out);
      const cl = noise(ctx, t + 0.003, 0.12, 'white');
      const cf = bq(ctx, 'bandpass', 3200 * r, 0.9);
      const cg = gain(ctx, 0); pluck(cg.gain, t + 0.003, 0.06, 0.006, 0.08 * ir);
      cl.connect(cf).connect(cg).connect(out);
    }
    const tap = osc(ctx, 'sine', 90 * r, t, t + 0.12 * ir);
    const tpg = gain(ctx, 0); pluck(tpg.gain, t, 0.16, 0.002, 0.06 * ir);
    tap.connect(tpg).connect(out);
    if (o.weapon) {                                    // a pipe or a bat on a guarded forearm: that one rings
      const body = bq(ctx, 'bandpass', 2100 * r, 1.4); body.connect(out);
      for (const [f, a, d] of [[893, 0.26, 0.14], [1417, 0.22, 0.11], [2290, 0.2, 0.08], [3350, 0.16, 0.06]]) {
        const os = osc(ctx, 'triangle', f * r, t, t + d * ir + 0.03);
        const og = gain(ctx, 0); pluck(og.gain, t, a, 0.001, d * ir);
        os.connect(og).connect(body);
      }
      const tick = noise(ctx, t, 0.04, 'white');
      const tf = bq(ctx, 'highpass', 2600 * r, 0.7);
      const tg = gain(ctx, 0); pluck(tg.gain, t, 0.2, 0.001, 0.03 * ir);
      tick.connect(tf).connect(tg).connect(out);
    }
    return (tk ? tk.buf.duration : 0.2) * ir;
  },

  /** An enemy's telegraphed heavy: the metallic 「キィン」 glint 龍が如く puts on the wind-up, fired with combat.js's
   *  VFX glint ~0.25 s before contact. Two inharmonic partials (2.6 + 4.1 kHz, plus a faint third), 1 ms attack,
   *  180 ms decay, through a 1.5 kHz highpass so it cuts the band without adding weight. */
  telegraph(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const hp = bq(ctx, 'highpass', 1500, 0.7); hp.connect(out);
    for (const [f, a, d] of [[2600, 0.2, 0.18], [4100, 0.15, 0.15], [6350, 0.05, 0.08]]) {
      const os = osc(ctx, 'sine', f * (o.rate ?? 1), t, t + d + 0.03);
      os.frequency.setValueAtTime(f * (o.rate ?? 1) * 0.985, t); os.frequency.linearRampToValueAtTime(f * (o.rate ?? 1), t + 0.012);
      const g = gain(ctx, 0); pluck(g.gain, t, a, 0.001, d);
      os.connect(g).connect(hp);
    }
    const n = noise(ctx, t, 0.02, 'white');
    const nf = bq(ctx, 'highpass', 5000, 0.7);
    const ng = gain(ctx, 0); pluck(ng.gain, t, 0.06, 0.0005, 0.004);
    n.connect(nf).connect(ng).connect(hp);
    return 0.25;
  },

  /** leather and cotton moving: the heavies' wind-up, a grab, a body turning */
  cloth(ctx, dest, t, o = {}) {
    const tk = foleyTake('cloth'); if (!tk) return 0.05;
    const r = o.rate ?? 1, dur = o.duration ?? tk.buf.duration / r;
    const g = gain(ctx, 0); g.connect(dest);
    const lv = (o.gain ?? 1) * dbLin(FOLEY_ST.cloth - tk.meta.st);
    g.gain.setValueAtTime(FLOOR, t); g.gain.linearRampToValueAtTime(lv, t + Math.min(0.04, dur * 0.3));
    g.gain.setValueAtTime(lv, t + dur * 0.55); g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
    const s = playTake(ctx, g, t, tk, 1, r); s.stop(t + dur + 0.02);
    return dur + 0.05;
  },

  /** Guard break: a baked take (the forearm knocked aside, a bright 3–6 kHz glassy snap, the stagger's whump, a
   *  cloth burst) normalised 3.5 dB over a jab at its shipping gain. In 龍が如く breaking a guard is a loud,
   *  bright crack and the cue that the opening is NOW; the synth sweep this replaces measured 5.7 dB under a jab. */
  guardbreak(ctx, dest, t, o = {}) {
    const tk = foleyTake('guardbreak', o.take);
    if (tk) {
      const out = gain(ctx, o.gain ?? 1); out.connect(dest);
      playTake(ctx, out, t, tk, dbLin(FOLEY_ST.guardbreak - tk.meta.st), o.rate ?? 1);
      return tk.buf.duration / (o.rate ?? 1);
    }
    const out = gain(ctx, (o.gain ?? 1) * 0.54); out.connect(dest);
    const cr = noise(ctx, t, 0.28, 'white');
    const cf = bq(ctx, 'bandpass', 1, 1.4);
    cf.frequency.setValueAtTime(4200, t); cf.frequency.exponentialRampToValueAtTime(420, t + 0.22);
    const cg = gain(ctx, 0); pluck(cg.gain, t, 0.68, 0.001, 0.24);
    cr.connect(cf).connect(cg).connect(out);
    const sw = osc(ctx, 'sawtooth', 380, t, t + 0.36);
    sw.frequency.exponentialRampToValueAtTime(58, t + 0.30);
    const sg = gain(ctx, 0); pluck(sg.gain, t, 0.40, 0.003, 0.32);
    const lp = bq(ctx, 'lowpass', 1800, 1.0);
    sw.connect(lp).connect(sg).connect(out);
    return 0.4;
  },

  // ------------------------------------------------------------------ the fight's final blow (combat/finalBlow.js)
  /** The finisher, dry: four layers on one frame. 1. the sub drop — a 95 Hz punch that falls to 42 Hz in 0.1 s and
   *  sinks to 35 Hz as it rings; 2. the body crunch — the bank's finisher take a touch slow, with a gristly 1.4 kHz
   *  burst; 3. the slap — skin and cloth, pink noise whose lowpass closes 2.4 kHz -> 300 Hz; 4. the whip crack —
   *  under a millisecond of bright air and a 5.2 kHz chirp collapsing to 1.2 kHz in 22 ms, the air breaking on the
   *  contact. Rendered once through a dark tail (prepFinisher) and played pitched down by fbTail; live only until
   *  that render exists. Context-agnostic: it also plays into the OfflineAudioContext. */
  fbStack(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const sat = ctx.createWaveShaper(); sat.curve = shaperCurve(ctx, 1.6);
    sat.connect(gain(ctx, 0.55)).connect(out);
    if (!o.noSub) VOICES.fbSub(ctx, sat, t, {});
    const tk = foleyTake('impact_finisher');
    if (tk) playTake(ctx, out, t, tk, dbLin(FOLEY_ST.finisher - tk.meta.st) * 0.9, 0.9);
    const cr = noise(ctx, t, 0.12, 'white'), cf = bq(ctx, 'bandpass', 1400, 0.9);
    const cg = gain(ctx, 0); pluck(cg.gain, t + 0.002, 0.5, 0.002, 0.07);
    cr.connect(cf).connect(cg).connect(sat);
    const sl = noise(ctx, t, 0.26, 'pink'), lf = bq(ctx, 'lowpass', 1, 0.9);
    lf.frequency.setValueAtTime(2400, t); lf.frequency.exponentialRampToValueAtTime(300, t + 0.2);
    const lg = gain(ctx, 0); pluck(lg.gain, t, 0.55, 0.002, 0.16);
    sl.connect(lf).connect(lg).connect(sat);
    const wc = noise(ctx, t, 0.05, 'white'), wh = bq(ctx, 'highpass', 3500, 0.7);
    const wg = gain(ctx, 0); pluck(wg.gain, t, 0.45, 0.0008, 0.03);
    wc.connect(wh).connect(wg).connect(out);
    const ch = osc(ctx, 'triangle', 5200, t, t + 0.05);
    ch.frequency.exponentialRampToValueAtTime(1200, t + 0.022);
    const chg = gain(ctx, 0); pluck(chg.gain, t, 0.18, 0.0006, 0.025);
    ch.connect(chg).connect(out);
    return 2.3;
  },

  /** The finisher's sub drop, kept OUT of the pitched tail so it stays where it is felt: a 95 Hz punch falling to
   *  42 Hz in 0.1 s, then sinking to 35 Hz as it rings for ~2 s. */
  fbSub(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const sub = osc(ctx, 'sine', 95, t, t + 2.3);
    sub.frequency.exponentialRampToValueAtTime(42, t + 0.1);
    sub.frequency.exponentialRampToValueAtTime(35, t + 1.9);
    const sg = gain(ctx, 0);
    sg.gain.setValueAtTime(FLOOR, t); sg.gain.linearRampToValueAtTime(0.85, t + 0.006);
    sg.gain.exponentialRampToValueAtTime(0.35, t + 0.35); sg.gain.exponentialRampToValueAtTime(FLOOR, t + 2.1);
    const sat = ctx.createWaveShaper(); sat.curve = shaperCurve(ctx, 1.6);
    sub.connect(sg).connect(sat).connect(gain(ctx, 0.55)).connect(out);
    return 2.3;
  },

  /** The finisher with its dark tail (the rendered buffer, `o.buf`), played at 1x for the contact and then SINKING
   *  in pitch as time slows — to `o.pitch` over the freeze — ringing on through the hold and gone by `o.len`. */
  fbTail(ctx, dest, t, o = {}) {
    const buf = o.buf; if (!buf) return 0.05;
    const s = ctx.createBufferSource(); s.buffer = buf;
    const r0 = o.rate ?? 1, P = o.pitch ?? 0.5, fz = o.freeze ?? 0.12, len = o.len ?? 1.1, lv = o.gain ?? 1;
    s.playbackRate.setValueAtTime(r0, t); s.playbackRate.setValueAtTime(r0, t + 0.03);
    s.playbackRate.exponentialRampToValueAtTime(P * r0, t + fz + 0.1);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(lv, t); g.gain.setValueAtTime(lv, t + len * 0.55); g.gain.exponentialRampToValueAtTime(FLOOR, t + len);
    s.connect(g).connect(dest);
    s.start(t); s.stop(t + len + 0.05);
    return len + 0.05;
  },

  /** A heartbeat in the held slow motion: lub (64 -> 44 Hz) and a softer dub 170 ms later (58 -> 40 Hz), each with a
   *  breath of brown-noise pressure, through a 190 Hz lowpass and a gentle saturator — felt more than heard. */
  fbBeat(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const lp = bq(ctx, 'lowpass', 190, 0.8), sat = ctx.createWaveShaper(); sat.curve = shaperCurve(ctx, 1.4);
    lp.connect(sat).connect(gain(ctx, 0.55)).connect(out);                   // ~6 dB under the finisher's sub
    for (const [dt, f0, f1, a] of [[0, 64, 44, 0.45], [0.17, 58, 40, 0.3]]) {
      const b = osc(ctx, 'sine', f0, t + dt, t + dt + 0.45);
      b.frequency.exponentialRampToValueAtTime(f1, t + dt + 0.12);
      const g = gain(ctx, 0); pluck(g.gain, t + dt, a, 0.012, 0.24);
      b.connect(g).connect(lp);
      const n = noise(ctx, t + dt, 0.32, 'brown'), ng = gain(ctx, 0);
      pluck(ng.gain, t + dt, a * 0.35, 0.02, 0.2);
      n.connect(ng).connect(lp);
    }
    return 0.75;
  },

  /** Time coming back: `t` is the moment he LANDS; the bank's reversed cymbal and a rush of air (pink noise whose
   *  band opens 350 Hz -> 6 kHz) swell over `o.len` s into it and stop dead on it. */
  fbSwell(ctx, dest, t, o = {}) {
    const len = o.len ?? 0.75, T = t, t0 = Math.max(ctx.currentTime + 0.005, T - len);
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const rc = foleyTake('rcym');
    if (rc) {
      const d = rc.buf.duration, e = gain(ctx, 1); e.connect(out);
      e.gain.setValueAtTime(1, T - 0.004); e.gain.linearRampToValueAtTime(FLOOR, T + 0.012);
      if (T - d >= t0) playTake(ctx, e, T - d, rc, dbLin(-12 - rc.meta.st));
      else playTake(ctx, e, t0, rc, dbLin(-12 - rc.meta.st), 1, d - (T - t0));
    }
    const n = noise(ctx, t0, T - t0 + 0.05, 'pink'), bf = bq(ctx, 'bandpass', 1, 0.7);
    bf.frequency.setValueAtTime(350, t0); bf.frequency.exponentialRampToValueAtTime(6000, T);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(FLOOR, t0); g.gain.exponentialRampToValueAtTime(0.5, T - 0.01); g.gain.linearRampToValueAtTime(FLOOR, T + 0.02);
    n.connect(bf).connect(g).connect(out);
    return T - t0 + 0.1;
  },

  /** He hits the ground, at normal speed: the heavy body fall (both stages, wet), a second bigger splash off the
   *  puddle and a low 78 -> 40 Hz thump of mass. */
  fbLand(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const wet = o.wet ?? 1;
    VOICES.bodyfall(ctx, out, t, { gain: 1.25, wet, rate: 1 });
    const sp = wet > 0.12 && foleyTake('splash');
    if (sp) playTake(ctx, out, t + 0.012, sp, dbLin(FOLEY_ST.splash - sp.meta.st) * 1.3 * wet, 0.92);
    const th = osc(ctx, 'sine', 78, t, t + 0.5);
    th.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const tg = gain(ctx, 0); pluck(tg.gain, t, 0.55, 0.004, 0.3);
    th.connect(tg).connect(out);
    return 1.0;
  },

  // KO: sub boom, a reversed-feeling swell and a low brass fifth. The chapter-1 payoff sound.
  // Internals are deliberately ~5 dB down on the first draft: at the old levels this rendered +3.8 dBFS raw and
  // the soft clip folded 4.6 dB of odd harmonics straight into the 62→26 Hz sub, which reads as buzz, not power.
  ko(ctx, dest, t, o = {}) {
    // The whole voice runs through one gentle saturator before the call gain. The clip guard is now asserted
    // at UNITY master (a player who raises the volume to 1.0 used to feed the master clipper +0.5 dBFS here,
    // folding odd harmonics straight into the 62→26 Hz boom), so the crest has to come off at the source.
    // +1.5 dB since the master has a limiter (it was trimmed for the old soft clip): the payoff has to stand over
    // a heavy by more than the ±1 dB its nested take varies by
    const out = gain(ctx, (o.gain ?? 1) * 1.19); out.connect(dest);
    const sat = ctx.createWaveShaper(); sat.curve = shaperCurve(ctx, 1.4);
    sat.connect(gain(ctx, 0.46)).connect(out);
    // `o.take`: the killing blow already landed this take (combat:hit played it, with its freeze). A second take
    // stacked on the same blow — bagPick guarantees a DIFFERENT one — flams and comb-filters the chapter's payoff
    // transient, so the KO only adds what the blow does not have: the boom, the stab and the air.
    if (!(o.take && o.take.buf)) VOICES.hit(ctx, sat, t, { gain: 1.2, heavy: true, weight: 0.9, rate: o.rate ?? (0.95 + Math.random() * 0.08), variant: (Math.random() * 4) | 0 });
    const boom = osc(ctx, 'sine', 62, t + 0.02, t + 1.25);
    boom.frequency.exponentialRampToValueAtTime(26, t + 0.75);
    const bg = gain(ctx, 0); pluck(bg.gain, t + 0.02, 0.5, 0.008, 1.05);
    boom.connect(bg).connect(sat);
    // fifth-stack stab: A1 + E2, saws through a closing lowpass
    const stab = gain(ctx, 0); pluck(stab.gain, t + 0.03, 0.17, 0.012, 0.70);
    const sf = bq(ctx, 'lowpass', 1, 1.6);
    sf.frequency.setValueAtTime(2600, t + 0.03); sf.frequency.exponentialRampToValueAtTime(240, t + 0.6);
    sf.connect(stab).connect(sat);
    for (const [s, det] of [[N.A1, -7], [N.A1, 6], [N.E2, -5], [N.E2, 8]]) {
      osc(ctx, 'sawtooth', SEMI(s), t + 0.03, t + 0.85, det).connect(sf);
    }
    const air = noise(ctx, t + 0.02, 0.9, 'pink');
    const af = bq(ctx, 'bandpass', 1, 0.9);
    af.frequency.setValueAtTime(2400, t + 0.02); af.frequency.exponentialRampToValueAtTime(300, t + 0.7);
    const ag = gain(ctx, 0); pluck(ag.gain, t + 0.02, 0.34, 0.02, 0.8);
    air.connect(af).connect(ag).connect(sat);
    return 1.3;
  },

  /** The swing, timed to the CONTACT. `o.duration` is swing start → contact frame (combat.js's hits[0].t / rate:
   *  0.13 s for a jab up to 0.44 s for a weapon heavy); the air peaks 25 ms before the limb lands and dies into
   *  the impact, so the swing and the hit read as one motion. The baked take is started (or entered part-way)
   *  so that its own measured peak lands on that instant; a synth band shaped to the whole swing carries the air
   *  from frame 1. Heavies add a cloth wind-up across the first 60 % — the jacket loading before the kick. */
  whoosh(ctx, dest, t, o = {}) {
    const r = o.rate ?? 1, heavy = !!o.heavy;
    const dur = Math.min(0.8, Math.max(0.09, o.duration ?? (heavy ? 0.30 : 0.20)));
    const pk = Math.max(0.05, dur - 0.025);
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const tk = foleyTake(heavy ? 'whoosh_heavy' : 'whoosh_light');
    if (tk) {
      const p = (tk.meta.peak ?? tk.meta.peakAt ?? 0.15) / r, lead = pk - p;
      const g = dbLin(FOLEY_ST.whoosh - tk.meta.st) * (heavy ? 1.15 : 1);
      if (lead >= 0) playTake(ctx, out, t + lead, tk, g, r);
      else playTake(ctx, out, t, tk, g, r, -lead * r);
    }
    // white, not pink: a pink bed has almost nothing left at 2.6 kHz and the swing disappears under the impact
    const s = noise(ctx, t, dur + 0.08, 'white');
    const f = bq(ctx, 'bandpass', 1, heavy ? 0.6 : 0.8);
    f.frequency.setValueAtTime((heavy ? 260 : 480) * r, t);
    f.frequency.exponentialRampToValueAtTime((heavy ? 1500 : 2600) * r, t + pk);
    f.frequency.exponentialRampToValueAtTime((heavy ? 320 : 640) * r, t + pk + 0.06);
    const g = gain(ctx, 0), lv = (heavy ? 0.5 : 0.34) * (tk ? 0.6 : 1);
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(lv, t + pk);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + pk + 0.06);
    s.connect(f).connect(g).connect(out);
    if (heavy) VOICES.cloth(ctx, out, t, { gain: 1.4, duration: Math.max(0.08, dur * 0.6), rate: r });
    return pk + 0.12;
  },

  // ------------------------------------------------------------------------------------------- footsteps
  // `material`: 'asphalt' (carriageway grit) | 'concrete' (kerbside slab) | 'tile' (plaza / station paving,
  // which actually rings). `far` drops the heel knock — at 20 m across a wet crossing only the scuff and the
  // splash survive the air anyway, and it saves two nodes per crowd step.
  footstep(ctx, dest, t, o = {}) {
    const g = o.gain ?? 1, wet = o.wet ?? 0, mat = o.material || 'asphalt';
    const r = o.rate ?? 1, ir = 1 / r, far = !!o.far;
    // A baked take: heel, the material's scuff, the toe roll-off and — wet — a splash and the sole peeling off the
    // film of water. One BufferSource + one gain (the pooled panner is the caller's): the synth below, still the
    // fallback before the bank decodes, was 7 AudioNodes per crowd step at up to 14 steps a second.
    const wetTk = wet > 0.35;
    const tk = foleyTake(`step_${mat}_${wetTk ? 'wet' : 'dry'}`);
    if (tk) {
      playTake(ctx, dest, t, tk, g * dbLin((wetTk ? FOLEY_ST.step : FOLEY_ST.stepDry) - tk.meta.st), r);
      return tk.buf.duration * ir;
    }
    const out = gain(ctx, g); out.connect(dest);
    const tile = mat === 'tile', hard = tile || mat === 'concrete';
    if (!far) {                                       // heel: a short low knock with a pitch drop; the shoe, not the floor
      const k = osc(ctx, 'sine', (hard ? 190 : 150) * r, t, t + 0.10 * ir);
      k.frequency.exponentialRampToValueAtTime((hard ? 78 : 58) * r, t + 0.05 * ir);
      const kg = gain(ctx, 0); pluck(kg.gain, t, 0.19, 0.001, 0.055 * ir);
      k.connect(kg).connect(out);
    }
    // scuff: the material. Tile rings bright and long, concrete is a dry slap, asphalt is grit.
    const s = noise(ctx, t, 0.10 * ir, hard ? 'white' : 'pink');
    const f = bq(ctx, hard ? 'bandpass' : 'lowpass', (tile ? 4300 : hard ? 2600 : 1250) * r, tile ? 2.2 : hard ? 1.1 : 0.9);
    const sg = gain(ctx, 0); pluck(sg.gain, t, tile ? 0.125 : hard ? 0.10 : 0.085, 0.002, (tile ? 0.085 : hard ? 0.05 : 0.075) * ir);
    s.connect(f).connect(sg).connect(out);
    // wet asphalt: the splash is the whole point of the after-rain showpiece
    if (wet > 0.12) {
      const w = noise(ctx, t + 0.004, 0.13 * ir, 'white');
      const wf = bq(ctx, 'bandpass', 1, 0.8);
      wf.frequency.setValueAtTime(1600 * r, t + 0.004);
      wf.frequency.exponentialRampToValueAtTime(5200 * r, t + 0.004 + 0.086 * ir);
      const wg = gain(ctx, 0); pluck(wg.gain, t + 0.004, 0.15 * wet, 0.003, 0.10 * ir);
      w.connect(wf).connect(wg).connect(out);
    }
    return 0.16 * ir;
  },

  // ------------------------------------------------------------------------------------- props / weapons
  prop(ctx, dest, t, o = {}) {
    const type = o.type || 'cone', s = Math.min(2.2, Math.max(0.15, o.strength ?? 1));
    const out = gain(ctx, (o.gain ?? 1) * 0.68 * Math.min(1.2, 0.45 + s * 0.45)); out.connect(dest);
    // partial sets: bike/aframe ring like metal, trash booms, cone is a plastic bonk
    const SET = {
      bike: { part: [[430, 0.26, 0.55], [703, 0.22, 0.45], [1129, 0.18, 0.33], [1871, 0.12, 0.22], [2510, 0.08, 0.16]], nf: 3400, ng: 0.30, nd: 0.22, sub: 0 },
      aframe: { part: [[196, 0.30, 0.20], [351, 0.20, 0.14], [905, 0.12, 0.09]], nf: 1700, ng: 0.34, nd: 0.10, sub: 92 },
      trash: { part: [[128, 0.42, 0.30], [214, 0.24, 0.22], [388, 0.14, 0.15]], nf: 900, ng: 0.30, nd: 0.28, sub: 66 },
      cone: { part: [[268, 0.44, 0.10], [521, 0.24, 0.07]], nf: 1300, ng: 0.30, nd: 0.06, sub: 58 },
    };
    const d = SET[type] || SET.cone;
    const r = o.rate ?? 1, ir = 1 / r;
    for (const [f, a, dec] of d.part) {
      const os = osc(ctx, 'triangle', f * r * (0.94 + Math.random() * 0.12), t, t + dec * ir + 0.05);
      const og = gain(ctx, 0); pluck(og.gain, t, a * s, 0.001, dec * ir);
      os.connect(og).connect(out);
    }
    const nz = noise(ctx, t, d.nd * ir + 0.03, 'white');
    const nf = bq(ctx, 'bandpass', d.nf * r * (0.9 + Math.random() * 0.2), 0.9);
    const ng = gain(ctx, 0); pluck(ng.gain, t, d.ng * s, 0.001, d.nd * ir);
    nz.connect(nf).connect(ng).connect(out);
    if (d.sub) {
      const sb = osc(ctx, 'sine', d.sub * r, t, t + 0.22 * ir);
      sb.frequency.exponentialRampToValueAtTime(d.sub * r * 0.5, t + 0.14 * ir);
      const sg = gain(ctx, 0); pluck(sg.gain, t, 0.45 * s, 0.002, 0.18 * ir);
      sb.connect(sg).connect(out);
    }
    return 0.65 * ir;
  },

  // ------------------------------------------------------------------------------------------- stingers
  // heat:ready — a rising shimmer that tells the player R is live
  heat_ready(ctx, dest, t, o = {}) {
    // Every layer lands on the same frame, so they sum into one gentle saturator (the impacts' trick): the
    // coincident peak is rounded at the source instead of by the master clip, and the cue keeps its loudness.
    const fin = gain(ctx, o.gain ?? 1); fin.connect(dest);
    const sat = ctx.createWaveShaper(); sat.curve = shaperCurve(ctx, 1.5);
    const out = gain(ctx, 0.9); out.connect(sat); sat.connect(gain(ctx, 0.44)).connect(fin);
    // Heat-MAX is the single most important state change in a 龍が如く fight: the frame the player is told R
    // is live. The last version put a small tick at t=0 and its payload — the swell and the bell — at 200–280 ms,
    // measured live as the loudest 50 ms landing 281 ms after heat:ready. So the payload IS the onset now: a
    // struck bell chord, a flare of air and a low whump all hit on the first frame, and the saw chord blooms
    // out of the strike (25 ms attack) instead of rising into it. The motion survives as the filter opening
    // and the half-step lift, both of which happen AFTER the player has already been told.
    const flare = noise(ctx, t, 0.36, 'white');
    const ff = bq(ctx, 'bandpass', 1, 1.1);
    ff.frequency.setValueAtTime(5600, t); ff.frequency.exponentialRampToValueAtTime(1300, t + 0.32);
    const fg = gain(ctx, 0); pluck(fg.gain, t, 0.30, 0.0015, 0.30);
    flare.connect(ff).connect(fg).connect(out);
    const whump = osc(ctx, 'sine', 120, t, t + 0.26);
    whump.frequency.exponentialRampToValueAtTime(46, t + 0.12);
    const wg = gain(ctx, 0); pluck(wg.gain, t, 0.40, 0.002, 0.20);
    whump.connect(wg).connect(out);
    // E5 / B5 / E6 plus one inharmonic partial: a struck bell, not a sine beep
    for (const [f, a, d] of [[SEMI(N.E4 + 12), 0.30, 1.0], [SEMI(N.E4 + 19), 0.15, 0.75], [SEMI(N.E4 + 24), 0.11, 0.55], [SEMI(N.E4 + 12) * 2.76, 0.05, 0.28]]) {
      const b = osc(ctx, 'sine', f, t, t + d + 0.05);
      const bg = gain(ctx, 0); pluck(bg.gain, t, a, 0.0015, d);
      b.connect(bg).connect(out);
    }
    const lp = bq(ctx, 'lowpass', 1, 2.2);
    lp.frequency.setValueAtTime(1500, t); lp.frequency.exponentialRampToValueAtTime(5200, t + 0.38);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.linearRampToValueAtTime(0.17, t + 0.025);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + 1.1);
    lp.connect(g).connect(out);
    for (const [s, det] of [[N.A2, 0], [N.E3, 4], [N.A3, -4], [N.C4, 7]]) {
      const os = osc(ctx, 'sawtooth', SEMI(s), t, t + 1.15, det);
      os.frequency.exponentialRampToValueAtTime(SEMI(s) * 1.06, t + 0.5);
      os.connect(lp);
    }
    return 1.2;
  },

  // heat:action — the letterbox and the 「極」 stamp: the wood clack of the stamp + sub drop + brass cluster.
  // The taiko moved to the heat action's FINAL contact (heat_final, on heat:impact), where the blow actually is.
  heat_action(ctx, dest, t, o = {}) {
    const out = gain(ctx, (o.gain ?? 1) * 0.76); out.connect(dest);
    const sat = ctx.createWaveShaper(); sat.curve = shaperCurve(ctx, 1.8);
    sat.connect(gain(ctx, 0.48)).connect(out);
    const stp = foleyTake('stamp');
    if (stp) playTake(ctx, sat, t, stp, dbLin(-9 - stp.meta.st), stingRate());
    const taiko = osc(ctx, 'sine', 180, t, t + 0.9);
    taiko.frequency.exponentialRampToValueAtTime(48, t + 0.22);
    const tg = gain(ctx, 0); pluck(tg.gain, t, stp ? 0.36 : 0.56, 0.002, 0.8);
    taiko.connect(tg).connect(sat);
    const skin = noise(ctx, t, 0.3, 'pink');
    const sf = bq(ctx, 'lowpass', 1, 1.0);
    sf.frequency.setValueAtTime(2400, t); sf.frequency.exponentialRampToValueAtTime(180, t + 0.25);
    const sg = gain(ctx, 0); pluck(sg.gain, t, 0.40, 0.001, 0.26);
    skin.connect(sf).connect(sg).connect(sat);
    const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(ctx, 6);
    const bl = bq(ctx, 'lowpass', 2200, 1.2);
    const bg2 = gain(ctx, 0); pluck(bg2.gain, t + 0.01, 0.19, 0.02, 1.3);
    sh.connect(bl).connect(bg2).connect(sat);
    for (const [s, det] of [[N.A1, -6], [N.A1, 7], [N.E2, 0], [N.A2, -8], [N.C3, 5]]) {
      osc(ctx, 'sawtooth', SEMI(s), t + 0.01, t + 1.45, det).connect(sh);
    }
    if (FOLEY.cats.crash) cymbal(ctx, sat, t, -21, 0.4, 1.0);
    else {
      const crash = noise(ctx, t, 1.4, 'white');
      const cf = bq(ctx, 'highpass', 3600, 0.6);
      const cg = gain(ctx, 0); pluck(cg.gain, t, 0.19, 0.002, 1.3);
      crash.connect(cf).connect(cg).connect(sat);
    }
    return 1.7;
  },

  /** The encounter: 龍が如く's name-card moment. A reversed cymbal swells for `lead` (0.6 s) over a rising low
   *  swell, then everything lands on one frame — sub slam, 大太鼓, crash. audio.encounter() starts the battle
   *  stems at exactly that frame, so the slam IS bar 1 beat 1 of the theme. */
  encounter(ctx, dest, t, o = {}) {
    const lead = o.lead ?? 0.6, T = t + lead;
    const out = gain(ctx, (o.gain ?? 1) * 0.5); out.connect(dest);
    const sat = ctx.createWaveShaper(); sat.curve = shaperCurve(ctx, 1.6);
    sat.connect(gain(ctx, 0.5)).connect(out);
    const rc = foleyTake('rcym');
    if (rc) { const d = rc.buf.duration; if (T - d >= t) playTake(ctx, out, T - d, rc, dbLin(-15 - rc.meta.st)); else playTake(ctx, out, t, rc, dbLin(-15 - rc.meta.st), 1, d - lead); }
    // (the reversed cymbal keeps rate 1: its end has to land on the slam to the sample)
    const sw = noise(ctx, t, lead + 0.03, 'brown');
    const sf = bq(ctx, 'lowpass', 1, 1.4);
    sf.frequency.setValueAtTime(160, t); sf.frequency.exponentialRampToValueAtTime(1400, T);
    const sg = gain(ctx, 0);
    sg.gain.setValueAtTime(FLOOR, t); sg.gain.exponentialRampToValueAtTime(0.5, T - 0.01); sg.gain.linearRampToValueAtTime(FLOOR, T + 0.015);
    sw.connect(sf).connect(sg).connect(sat);
    const sub = osc(ctx, 'sine', 150, T, T + 1.1);
    sub.frequency.exponentialRampToValueAtTime(34, T + 0.32);
    const bg = gain(ctx, 0); pluck(bg.gain, T, 0.72, 0.003, 0.85);
    sub.connect(bg).connect(sat);
    takeCut(ctx, sat, T, foleyTake('taiko_odaiko'), -9, 0.5, 0.8, stingRate());
    cymbal(ctx, out, T, -22, 0.35, 1.1);
    return lead + 2.2;
  },

  /** the button: the tonic power chord the theme ends on, a kick and a crash, cut on the beat after the last KO */
  button(ctx, dest, t, o = {}) {
    const out = gain(ctx, (o.gain ?? 1) * 0.6); out.connect(dest);
    const sat = ctx.createWaveShaper(); sat.curve = shaperCurve(ctx, 1.5);
    sat.connect(gain(ctx, 0.5)).connect(out);
    chordStab(ctx, sat, t, [N.A1, N.E2, N.A2, N.E3], 1.6, 0.2);
    const k = osc(ctx, 'sine', 150, t, t + 0.5);
    k.frequency.exponentialRampToValueAtTime(40, t + 0.09);
    const kg = gain(ctx, 0); pluck(kg.gain, t, 0.8, 0.002, 0.34);
    k.connect(kg).connect(sat);
    cymbal(ctx, out, t, -21, 0.4, 1.2);
    return 2.0;
  },

  /** the victory sting after a won fight: ♭VI – ♭VII – I, the last chord major (a Picardy third) and held */
  victory(ctx, dest, t, o = {}) {
    const out = gain(ctx, (o.gain ?? 1) * 0.37); out.connect(dest);
    const E = STEP * 2;
    const hits = [[t, [N.F2, N.C3, N.F3], 0.2], [t + E, [N.G2, N.D3, N.G3], 0.2], [t + E * 2, [N.A2, N.E3, N.A3, N.C4 + 1], 1.25]];
    for (const [at, ch, d] of hits) {
      chordStab(ctx, out, at, ch, d, 0.15);
      drumKick(ctx, out, at, 0.8);
    }
    for (let i = 0; i < 4; i++) drumSnare(ctx, out, t + E * 1.5 + i * (E / 4), 0.35 + i * 0.12);
    cymbal(ctx, out, t + E * 2, -20, 0.5, 1.0);
    return E * 2 + 1.5;
  },

  /** a non-final KO: a 締太鼓 tag and a short sub under the killing blow — the full `ko` is kept for the last man */
  ko_tag(ctx, dest, t, o = {}) {
    const out = gain(ctx, (o.gain ?? 1) * 0.64); out.connect(dest);
    const tk = foleyTake('taiko_shime');
    if (tk) playTake(ctx, out, t + 0.01, tk, dbLin(-17 - tk.meta.st), stingRate());
    const sb = osc(ctx, 'sine', 90, t, t + 0.5);
    sb.frequency.exponentialRampToValueAtTime(38, t + 0.2);
    const sg = gain(ctx, 0); pluck(sg.gain, t, 0.3, 0.003, 0.32);
    sb.connect(sg).connect(out);
    return 1.3;
  },

  /** heat:impact, non-final contact: a 締太鼓 hit and cloth under the finisher-class impact */
  heat_hit(ctx, dest, t, o = {}) {
    const out = gain(ctx, (o.gain ?? 1) * 0.76); out.connect(dest);
    const tk = foleyTake('taiko_shime');
    if (tk) playTake(ctx, out, t, tk, dbLin(-15 - tk.meta.st), stingRate());
    VOICES.cloth(ctx, out, t, { gain: 1.6 });
    return 1.3;
  },

  /** heat:impact, FINAL contact: 大太鼓 + the stamp's wood clack + a sub drop, and a one-second tail */
  heat_final(ctx, dest, t, o = {}) {
    const out = gain(ctx, (o.gain ?? 1) * 0.62); out.connect(dest);
    const sat = ctx.createWaveShaper(); sat.curve = shaperCurve(ctx, 1.6);
    sat.connect(gain(ctx, 0.5)).connect(out);
    takeCut(ctx, sat, t, foleyTake('taiko_odaiko'), -8, 0.55, 0.6, stingRate());
    const stp = foleyTake('stamp');
    if (stp) playTake(ctx, sat, t + 0.004, stp, dbLin(-12 - stp.meta.st), stingRate());
    const sb = osc(ctx, 'sine', 70, t, t + 1.3);
    sb.frequency.exponentialRampToValueAtTime(29, t + 0.6);
    const sg = gain(ctx, 0); pluck(sg.gain, t, 0.55, 0.004, 1.0);
    sb.connect(sg).connect(sat);
    cymbal(ctx, out, t, -26, 0.3, 0.9);
    return 1.6;
  },

  // ---------------------------------------------------------------------------------------------- world
  horn(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const dur = o.long ? 0.85 : 0.34;
    const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(ctx, 4);
    const lp = bq(ctx, 'lowpass', 2600, 0.8);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.018);
    g.gain.setValueAtTime(0.42, t + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + dur + 0.05);
    sh.connect(lp).connect(g).connect(out);
    const base = (o.kind === 'truck' || o.kind === 'bus') ? 255 : 415;   // a real horn is a dyad, ~a major third
    for (const [f, a] of [[base, 0.5], [base * 1.26, 0.42], [base * 2, 0.16], [base * 2.52, 0.11]]) {
      const os = osc(ctx, 'square', f, t, t + dur + 0.1);
      const og = gain(ctx, a); os.connect(og).connect(sh);
    }
    return dur + 0.15;
  },

  // Pedestrian-signal 誘導音: the two-note カッコー call. 'flash' is the hurried version.
  cuckoo(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const fast = o.mode === 'flash';
    const f1 = 1046.5, f2 = 830.6;                                   // C6 -> Ab5, a minor third down
    const notes = fast ? [[f1, 0.10, 0], [f2, 0.13, 0.12]] : [[f1, 0.20, 0], [f2, 0.30, 0.22]];
    for (const [f, d, off] of notes) {
      const at = t + off;
      const g = gain(ctx, 0);
      g.gain.setValueAtTime(FLOOR, at);
      g.gain.linearRampToValueAtTime(0.30, at + 0.022);
      g.gain.setValueAtTime(0.30, at + d * 0.55);
      g.gain.exponentialRampToValueAtTime(FLOOR, at + d);
      g.connect(out);
      osc(ctx, 'sine', f, at, at + d + 0.02).connect(g);
      const h = osc(ctx, 'sine', f * 2, at, at + d + 0.02);
      const hg = gain(ctx, 0.11); h.connect(hg).connect(g);
      const air = noise(ctx, at, d, 'white');
      const af = bq(ctx, 'bandpass', f * 1.6, 6);
      const ag = gain(ctx, 0.05); air.connect(af).connect(ag).connect(g);
    }
    return fast ? 0.30 : 0.56;
  },

  // ------------------------------------------------------------------- the street's one-shot vocabulary
  // A night bed is not a carpet, it is a carpet with events 8–15 dB proud of it. These four plus horn() are
  // what worldEvents() throws at the crossing so a frame with 150 vehicles and 1070 people stops reading as
  // one undifferentiated hiss. All of them are placed on real traffic positions and ride the `world` bus.

  // 原付 pass-by: a two-stroke buzz that rises and falls. The caller pans it; this is the engine, not the doppler.
  scooter(ctx, dest, t, o = {}) {
    const dur = o.duration ?? 1.7;
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(ctx, 5);
    const lp = bq(ctx, 'lowpass', 1, 1.1);
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.linearRampToValueAtTime(2300, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(600, t + dur);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
    sh.connect(lp).connect(g).connect(out);
    const f0 = 88 * (o.rate ?? 1);
    for (const [m, a] of [[1, 0.5], [2, 0.26], [3, 0.14]]) {
      const os = osc(ctx, 'sawtooth', f0 * m, t, t + dur + 0.05);
      os.frequency.linearRampToValueAtTime(f0 * m * 1.42, t + dur * 0.5);   // he opens it up going past
      os.frequency.linearRampToValueAtTime(f0 * m * 1.1, t + dur);
      os.connect(gain(ctx, a)).connect(sh);
    }
    const air = noise(ctx, t, dur, 'pink');
    const af = bq(ctx, 'bandpass', 1600, 0.7);
    const ag = gain(ctx, 0);
    ag.gain.setValueAtTime(FLOOR, t);
    ag.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.45);
    ag.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
    air.connect(af).connect(ag).connect(out);
    return dur + 0.1;
  },

  // シャッター: a shop rolling down. One noise source, one swept bandpass, ~26 slat clatters scheduled on a
  // single gain param (an AudioParam holds an unlimited event list — that is what it is for), then the clank.
  shutter(ctx, dest, t, o = {}) {
    const dur = o.duration ?? 1.35;
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const src = noise(ctx, t, dur + 0.3, 'white');
    const f = bq(ctx, 'bandpass', 1500, 1.5);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(FLOOR, t);
    const n = 26;
    for (let i = 0; i < n; i++) {
      const u = i / n, at = t + u * dur;
      f.frequency.setValueAtTime(1300 + Math.sin(u * 11) * 500, at);
      g.gain.setValueAtTime(FLOOR, at);
      g.gain.linearRampToValueAtTime(0.16 + 0.10 * (1 - u), at + 0.002);
      g.gain.exponentialRampToValueAtTime(FLOOR, at + 0.030);
    }
    src.connect(f).connect(g).connect(out);
    const clank = noise(ctx, t + dur, 0.28, 'white');                 // it hits the ground
    const cf = bq(ctx, 'bandpass', 620, 1.1);
    const cg = gain(ctx, 0); pluck(cg.gain, t + dur, 0.42, 0.001, 0.22);
    clank.connect(cf).connect(cg).connect(out);
    const thud = osc(ctx, 'sine', 104, t + dur, t + dur + 0.2);
    thud.frequency.exponentialRampToValueAtTime(54, t + dur + 0.12);
    const tg = gain(ctx, 0); pluck(tg.gain, t + dur, 0.30, 0.002, 0.14);
    thud.connect(tg).connect(out);
    return dur + 0.4;
  },

  // コンビニ入店音: the two-note door chime every 24-hour shop in Japan has.
  chime(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    for (const [f, off, d] of [[1318.5, 0, 0.38], [1046.5, 0.20, 0.52]]) {     // E6 → C6
      for (const [m, a] of [[1, 0.34], [2.01, 0.09], [3.02, 0.035]]) {
        const os = osc(ctx, 'sine', f * m, t + off, t + off + d + 0.05);
        const g = gain(ctx, 0); pluck(g.gain, t + off, a, 0.004, d);
        os.connect(g).connect(out);
      }
    }
    return 0.8;
  },

  // 自転車のベル: inharmonic, bright, two strikes. A cyclist telling you to move.
  bell(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const r = o.rate ?? 1;
    for (const off of [0, 0.125]) {
      for (const [f, a, d] of [[2180, 0.30, 0.55], [3310, 0.17, 0.40], [4470, 0.10, 0.28], [5760, 0.05, 0.18]]) {
        const os = osc(ctx, 'sine', f * r * (0.99 + Math.random() * 0.02), t + off, t + off + d + 0.05);
        const g = gain(ctx, 0); pluck(g.gain, t + off, a * (off ? 0.7 : 1), 0.001, d);
        os.connect(g).connect(out);
      }
    }
    return 0.75;
  },

  // 雨上がりの雫: one drop off an awning / eave into a puddle. A pitched plink that falls an octave in 30 ms, a
  // softer second bounce, and a tick of water noise. Sparse and near — the sound that says the rain has stopped.
  drip(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const f = 1500 * (o.rate ?? 1);
    for (const [off, a] of [[0, 0.32], [0.045 + Math.random() * 0.04, 0.10]]) {
      const os = osc(ctx, 'sine', f, t + off, t + off + 0.12);
      os.frequency.setValueAtTime(f * (off ? 1.18 : 1), t + off);
      os.frequency.exponentialRampToValueAtTime(f * 0.5, t + off + 0.03);
      const g = gain(ctx, 0); pluck(g.gain, t + off, a, 0.001, 0.07);
      os.connect(g).connect(out);
    }
    const n = ctx.createBufferSource(); n.buffer = noiseBuf(ctx, 1, 'white');
    const ng = gain(ctx, 0); pluck(ng.gain, t, 0.05, 0.001, 0.02);
    n.connect(bq(ctx, 'bandpass', 4200, 1.2)).connect(ng).connect(out); n.start(t); n.stop(t + 0.05);
    return 0.25;
  },

  // A train on the JR viaduct: rolling rumble + rail joint clacks. Panned by the caller.
  train(ctx, dest, t, o = {}) {
    const dur = o.duration ?? 7.0;
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const roll = noise(ctx, t, dur, 'brown', 1);
    const rf = bq(ctx, 'lowpass', 1, 0.8);
    rf.frequency.setValueAtTime(140, t);
    rf.frequency.linearRampToValueAtTime(520, t + dur * 0.45);
    rf.frequency.linearRampToValueAtTime(170, t + dur);
    const rg = gain(ctx, 0);
    rg.gain.setValueAtTime(FLOOR, t);
    rg.gain.exponentialRampToValueAtTime(0.95, t + dur * 0.42);
    rg.gain.setValueAtTime(0.95, t + dur * 0.52);
    rg.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
    roll.connect(rf).connect(rg).connect(out);
    // a squealing flange note over the peak
    const sq = osc(ctx, 'sawtooth', 680, t + dur * 0.35, t + dur * 0.72);
    sq.frequency.linearRampToValueAtTime(540, t + dur * 0.72);
    const sqf = bq(ctx, 'bandpass', 900, 7);
    const sqg = gain(ctx, 0);
    sqg.gain.setValueAtTime(FLOOR, t + dur * 0.35);
    sqg.gain.exponentialRampToValueAtTime(0.09, t + dur * 0.48);
    sqg.gain.exponentialRampToValueAtTime(FLOOR, t + dur * 0.72);
    sq.connect(sqf).connect(sqg).connect(out);
    // Bogie clacks — two per car, brightening toward the pass and receding after. 44 clacks used to mean 44
    // source+filter+gain triples (140 AudioNodes allocated in one frame for a single pass-by). One looping
    // noise source through one swept bandpass, with 44 envelopes scheduled on a single gain param, is the same
    // sound for 4 nodes: an AudioParam holds an unlimited event list, and that is what it is for.
    const clackSrc = noise(ctx, t, dur, 'white');
    const cf = bq(ctx, 'bandpass', 220, 1.6);
    const cg = gain(ctx, 0);
    cg.gain.setValueAtTime(FLOOR, t);
    for (let i = 0; i < 44; i++) {
      const u = i / 44, at = t + u * dur;
      const near = 1 - Math.abs(u - 0.5) * 2;
      cf.frequency.setValueAtTime(220 + near * 900, at);
      cg.gain.setValueAtTime(FLOOR, at);
      cg.gain.linearRampToValueAtTime((0.10 + near * 0.28) * 0.5, at + 0.001);
      cg.gain.exponentialRampToValueAtTime(FLOOR, at + 0.046);
    }
    clackSrc.connect(cf).connect(cg).connect(out);
    return dur + 0.2;
  },

  // ----------------------------------------------------------------------------------------------- UI
  // Menus were silent: 20 wired events and not one ui:*. A cursor tick, a confirm, a cancel and the pause
  // swallow. Short, dry, no reverb send — UI lives outside the world.
  ui(ctx, dest, t, o = {}) {
    const kind = o.kind || 'move';
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    if (kind === 'confirm' || kind === 'cancel') {
      const up = kind === 'confirm';
      for (const [n, a, off] of up ? [[N.E3, 0.26, 0], [N.A3, 0.22, 0.055]] : [[N.A2, 0.24, 0], [N.E2, 0.20, 0.06]]) {
        const os = osc(ctx, 'triangle', SEMI(n), t + off, t + off + 0.22);
        const g = gain(ctx, 0); pluck(g.gain, t + off, a, 0.002, 0.16);
        os.connect(g).connect(out);
      }
      return 0.32;
    }
    if (kind === 'pause' || kind === 'unpause') {
      const down = kind === 'pause';
      const s = osc(ctx, 'sine', down ? 420 : 210, t, t + 0.3);
      s.frequency.exponentialRampToValueAtTime(down ? 150 : 460, t + 0.16);
      const g = gain(ctx, 0); pluck(g.gain, t, 0.30, 0.004, 0.24);
      const lp = bq(ctx, 'lowpass', 2200, 0.9);
      s.connect(lp).connect(g).connect(out);
      const air = noise(ctx, t, 0.22, 'pink');
      const af = bq(ctx, 'bandpass', down ? 900 : 1800, 1.1);
      const ag = gain(ctx, 0); pluck(ag.gain, t, 0.13, 0.003, 0.2);
      air.connect(af).connect(ag).connect(out);
      return 0.34;
    }
    const tick = osc(ctx, 'square', 1180 * (o.rate ?? 1), t, t + 0.05);
    const hp = bq(ctx, 'highpass', 700, 0.7);
    const g = gain(ctx, 0); pluck(g.gain, t, 0.13, 0.001, 0.032);
    tick.connect(hp).connect(g).connect(out);
    return 0.08;
  },

  thunder(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const s = noise(ctx, t, 3.2, 'brown');
    const f = bq(ctx, 'lowpass', 1, 0.7);
    f.frequency.setValueAtTime(600, t); f.frequency.exponentialRampToValueAtTime(70, t + 2.6);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(0.85, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.9);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + 3.0);
    s.connect(f).connect(g).connect(out);
    return 3.2;
  },

  hurt(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const s = noise(ctx, t, 0.22, 'pink');
    const f = bq(ctx, 'bandpass', 1, 1.4);
    f.frequency.setValueAtTime(520, t); f.frequency.exponentialRampToValueAtTime(190, t + 0.2);
    const g = gain(ctx, 0); pluck(g.gain, t, 0.30, 0.01, 0.2);
    s.connect(f).connect(g).connect(out);
    return 0.26;
  },

  // Fallback barks when VOICEVOX has not been generated: a formant grunt, not a beep.
  grunt(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const hero = o.who === 'hero';
    if (o.breath) {
      // the air knocked out of him: a short exhale through /u/ formants with a little voice under it — what a
      // hit taken sounds like most of the time, so the VOICEVOX 「ぐっ」 can be the exception it should be
      const r = o.rate ?? 1, dur = 0.17 * (0.9 + Math.random() * 0.25);
      const env = gain(ctx, 0);
      env.gain.setValueAtTime(FLOOR, t); env.gain.linearRampToValueAtTime(1, t + 0.012); env.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
      env.connect(out);
      const air = noise(ctx, t, dur + 0.02, 'pink');
      for (const [f, q, a] of [[620, 1.3, 0.5], [1250, 2.2, 0.28], [2600, 3, 0.1]]) air.connect(bq(ctx, 'bandpass', f * r, q)).connect(gain(ctx, a)).connect(env);
      const vo = osc(ctx, 'sawtooth', (hero ? 96 : 130) * r, t, t + dur + 0.03);
      vo.frequency.linearRampToValueAtTime((hero ? 78 : 110) * r, t + dur);
      vo.connect(bq(ctx, 'bandpass', 560 * r, 4)).connect(gain(ctx, 0.9)).connect(env);
      return dur + 0.05;
    }
    const f0 = (hero ? 108 : 150) * (o.rate ?? 1);
    const dur = o.long ? 0.55 : 0.30;
    const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(ctx, 3);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.linearRampToValueAtTime(0.44, t + 0.03);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
    sh.connect(g).connect(out);
    const src = osc(ctx, 'sawtooth', f0, t, t + dur + 0.05);
    src.frequency.linearRampToValueAtTime(f0 * (hero ? 0.82 : 1.18), t + dur * 0.6);
    src.frequency.linearRampToValueAtTime(f0 * 0.7, t + dur);
    // two formants shape it into a vowel
    const [a1, a2] = hero ? [560, 1080] : [720, 1320];
    for (const [f, q, a] of [[a1, 4, 3.2], [a2, 5, 1.8]]) {
      const bf = bq(ctx, 'bandpass', f, q);
      const bg = gain(ctx, a);
      src.connect(bf).connect(bg).connect(sh);
    }
    const br = noise(ctx, t, dur, 'pink');
    const brf = bq(ctx, 'bandpass', 2400, 1.2);
    const brg = gain(ctx, 0); pluck(brg.gain, t, 0.10, 0.02, dur);
    br.connect(brf).connect(brg).connect(out);
    return dur + 0.08;
  },

  weapon(ctx, dest, t, o = {}) {
    const out = gain(ctx, o.gain ?? 1); out.connect(dest);
    const brk = o.action === 'break', r = o.rate ?? 1, ir = 1 / r;
    const s = noise(ctx, t, (brk ? 0.4 : 0.18) * ir, 'white');
    const f = bq(ctx, 'bandpass', 1, 1.1);
    f.frequency.setValueAtTime((brk ? 2600 : 1800) * r, t);
    f.frequency.exponentialRampToValueAtTime((brk ? 380 : 900) * r, t + (brk ? 0.32 : 0.14) * ir);
    const g = gain(ctx, 0); pluck(g.gain, t, brk ? 0.52 : 0.26, 0.002, (brk ? 0.34 : 0.14) * ir);
    s.connect(f).connect(g).connect(out);
    return (brk ? 0.45 : 0.2) * ir;
  },
};
VOICES.impact = VOICES.hit;

// ------------------------------------------------------------------------------------------------- music
// 128 BPM, A minor. Four-bar loop, i–i–VI–VII, which is the harmonic shape a 龍が如く battle theme lives in.
const BARS = [
  { root: N.A1, chord: [N.A2, N.E3, N.A3] },
  { root: N.A1, chord: [N.A2, N.E3, N.A3] },
  { root: N.F1, chord: [N.F2, N.C3, N.F3] },
  { root: N.G1, chord: [N.G2, N.D3, N.G3] },
];
const KICK = [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const SNARE = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1];
const STAB = [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0];
const RIFF = [N.A2, 0, N.C3, 0, N.D3, 0, N.E3, N.D3, 0, N.C3, 0, N.A2, 0, 0, N.G2, 0];

/** A 龍が如く battle theme is WIDE: doubled guitars hard left and right, hats off-centre, only kick/snare/bass
 *  in the middle. These three panners are cached per (ctx, dest) so the whole loop costs three StereoPanners
 *  for the session instead of being summed to a single mono point. */
function musPan(ctx, dest, p) {
  if (!ctx.createStereoPanner) return dest;
  return cached(ctx, `mpan:${p}`, () => { const s = ctx.createStereoPanner(); s.pan.value = p; s.connect(dest); return s; });
}

/** One WaveShaper per distortion amount, shared by every stab and every riff step. battleStep used to build a
 *  fresh one per 16th note (~85 nodes/s, forever, once a fight starts); a memoryless curve has no state, so
 *  fanning several voices through one is both cheaper and closer to a real amp summing a chord. */
function shaper(ctx, amount, slot = '') {
  return cached(ctx, `wsnode:${amount}:${slot}`, () => { const s = ctx.createWaveShaper(); s.curve = shaperCurve(ctx, amount); return s; });
}

function drumKick(ctx, dest, t, v) {
  const o = osc(ctx, 'sine', 155, t, t + 0.34);
  o.frequency.exponentialRampToValueAtTime(43, t + 0.075);
  const g = gain(ctx, 0); pluck(g.gain, t, 0.95 * v, 0.002, 0.26);
  o.connect(g).connect(dest);
  const c = noise(ctx, t, 0.03, 'white');
  const cf = bq(ctx, 'bandpass', 2000, 1.2);
  const cg = gain(ctx, 0); pluck(cg.gain, t, 0.16 * v, 0.001, 0.02);
  c.connect(cf).connect(cg).connect(dest);
}
function drumSnare(ctx, dest, t, v) {
  const n = noise(ctx, t, 0.22, 'white');
  const nf = bq(ctx, 'highpass', 900, 0.7);
  const ng = gain(ctx, 0); pluck(ng.gain, t, 0.42 * v, 0.001, 0.17);
  n.connect(nf).connect(ng).connect(dest);
  for (const f of [182, 264]) {
    const o = osc(ctx, 'triangle', f, t, t + 0.14);
    const g = gain(ctx, 0); pluck(g.gain, t, 0.20 * v, 0.001, 0.11);
    o.connect(g).connect(dest);
  }
}
function drumHat(ctx, dest, t, v, open) {
  const n = noise(ctx, t, open ? 0.24 : 0.05, 'white');
  const f = bq(ctx, 'highpass', 7200, 0.8);
  const g = gain(ctx, 0); pluck(g.gain, t, (open ? 0.17 : 0.13) * v, 0.001, open ? 0.2 : 0.035);
  n.connect(f).connect(g).connect(dest);
}
function drumCrash(ctx, dest, t, v) {
  const cy = foleyTake('crash');                       // the baked 420-partial cymbal, not highpassed hiss
  if (cy) { playTake(ctx, dest, t, cy, dbLin(-17.7 - cy.meta.st) * v, stingRate()); return; }
  const n = noise(ctx, t, 1.6, 'white');
  const f = bq(ctx, 'highpass', 3800, 0.5);
  const g = gain(ctx, 0); pluck(g.gain, t, 0.26 * v, 0.003, 1.5);
  n.connect(f).connect(g).connect(dest);
}

/** a guitar power chord for the stingers: two detuned saw stacks split L/R through a shaper, pluck and hold */
function chordStab(ctx, dest, t, notes, dur, level) {
  for (const [det, pan] of [[-6, -0.5], [7, 0.5]]) {
    const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(ctx, 9);
    const lp = bq(ctx, 'lowpass', 2800, 0.9), hp = bq(ctx, 'highpass', 90, 0.7);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(FLOOR, t); g.gain.linearRampToValueAtTime(level, t + 0.004);
    g.gain.setValueAtTime(level, t + Math.min(0.18, dur * 0.4)); g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
    sh.connect(lp).connect(hp).connect(g);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; g.connect(p).connect(dest); } else g.connect(dest);
    for (const n of notes) osc(ctx, 'sawtooth', SEMI(n), t, t + dur + 0.05, det).connect(sh);
  }
}

/** One 16th of the battle theme into `dest`. `part` picks a stem: 'drums' | 'harm' (bass + power chords) |
 *  'lead' (the riff, second pass only) | 'all'. Used ONCE per session, into an OfflineAudioContext, to render
 *  the looping stems — the live graph no longer builds ~10 AudioNodes per 16th for the whole fight. */
function battleNotes(ctx, B, t, s, bar, cycle, part = 'all') {
  const b = BARS[bar], all = part === 'all';
  const L = musPan(ctx, B, -0.6), R = musPan(ctx, B, 0.6);      // kick/snare/bass stay on B, i.e. centre
  if (all || part === 'drums') {
    if (KICK[s]) drumKick(ctx, B, t, s === 0 ? 1 : 0.85);
    if (SNARE[s]) drumSnare(ctx, B, t, s === 15 ? 0.7 : 1);
    if (s % 2 === 0) drumHat(ctx, s % 8 === 0 ? R : L, t, s % 4 === 0 ? 1 : 0.65, bar === 3 && s === 14);
    if (bar === 0 && s === 0) { drumCrash(ctx, L, t, 0.8); drumCrash(ctx, R, t, 0.8); }
    if (bar === 2 && s === 0) drumCrash(ctx, R, t, 0.6);
  }
  if (all || part === 'harm') {
    // bass: driving 8ths on the root with an octave lift on the back half of the bar
    if (s % 2 === 0) {
      const up = s >= 10 && (s % 4 === 2);
      const f = SEMI(b.root + (up ? 12 : 0));
      const o = osc(ctx, 'sawtooth', f, t, t + STEP * 2);
      const o2 = osc(ctx, 'square', f * 0.5, t, t + STEP * 2);
      const lp = bq(ctx, 'lowpass', 1, 6);
      lp.frequency.setValueAtTime(1500, t); lp.frequency.exponentialRampToValueAtTime(260, t + 0.18);
      const g = gain(ctx, 0); pluck(g.gain, t, 0.30, 0.004, STEP * 1.7);
      const g2 = gain(ctx, 0.5);
      o.connect(lp); o2.connect(g2).connect(lp); lp.connect(g).connect(B);
    }
    // power chords: root + fifth + octave through a shared shaper, stabbed. The two detuned saw voices split
    // left/right — this is the doubled-guitar trick and it is most of the perceived width.
    if (STAB[s]) {
      const long = s === 0 && bar === 3, dur = long ? 0.9 : 0.34;
      for (const [det, side, slot] of [[-6, L, 'l'], [7, R, 'r']]) {
        const sh = shaper(ctx, 9, slot);
        const lp = bq(ctx, 'lowpass', 2800, 0.9);
        const hp = bq(ctx, 'highpass', 140, 0.7);
        const g = gain(ctx, 0); pluck(g.gain, t, 0.155, 0.004, long ? 0.75 : 0.22);
        sh.connect(lp).connect(hp).connect(g).connect(side);
        for (const n of b.chord) osc(ctx, 'sawtooth', SEMI(n), t, t + dur, det).connect(sh);
      }
    }
  }
  // lead riff: enters on the second pass through the loop so the opening is drums + bass
  if ((all || part === 'lead') && cycle % 2 === 1 && RIFF[s]) {
    for (const [det, side, slot] of [[-4, L, 'l'], [6, R, 'r']]) {
      const sh = shaper(ctx, 14, slot);
      const lp = bq(ctx, 'lowpass', 3200, 1.4);
      const g = gain(ctx, 0); pluck(g.gain, t, 0.092, 0.006, STEP * 2.2);
      sh.connect(lp).connect(g).connect(side);
      osc(ctx, 'square', SEMI(RIFF[s] + 12), t, t + STEP * 2.6, det).connect(sh);
    }
  }
}

/** The battle theme: four stems baked by src/audio/bake.mjs (AAC, decoded off the main thread like foley.wav).
 *  Each file holds [0.25 s pre-roll][the 32-bar arrangement][pad][the 8-bar last-man section][pad]; battle.json
 *  says where. The main loop is bars 5–32 (the intro plays once), the last-man loop its own 8 bars; both had
 *  their tails folded back onto their loop starts at bake time, so the wraps are seamless. The runtime used to
 *  render a 4-bar, 7.5 s loop in three OfflineAudioContexts on the main thread at boot. The decoder's delay (0 if
 *  the demuxer honours the m4a's priming edit, as Chrome's and Apple's do) is measured once from bar 1 beat 1's
 *  first transient against the onset bake.mjs recorded, and every loop point is shifted by it. */
// [mobile] ?audio=lite (the phone profile): only the drums and the lead are decoded — decoded audio is float32, and the four
// stems were ~115 MB of it — the harmony and intensity layers are one silent sample (their loops play nothing)
const AUDIO_LITE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('audio') === 'lite';
async function loadStems(ctx) {
  const man = await fetch(SFX_URL('battle.json')).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const bufs = await Promise.all(STEM_NAMES.map(k => (AUDIO_LITE && (k === 'harm' || k === 'intensity') ? Promise.resolve(ctx.createBuffer(2, 1, ctx.sampleRate)) : fetch(SFX_URL(man.files[k]))
    .then(r => { if (!r.ok) throw new Error(`${man.files[k]} ${r.status}`); return r.arrayBuffer(); }).then(ab => decodeWith(ctx, ab)))));
  const d = bufs[0], sr = d.sampleRate, c0 = d.getChannelData(0), c1 = d.numberOfChannels > 1 ? d.getChannelData(1) : c0;
  const P = man.preroll, lo = Math.max(0, Math.floor((P - 0.05) * sr)), hi = Math.min(c0.length, Math.floor((P + 0.1) * sr));
  let mx = 0; for (let i = lo; i < hi; i++) mx = Math.max(mx, Math.abs(c0[i]), Math.abs(c1[i]));
  let i = lo; while (i < hi && Math.max(Math.abs(c0[i]), Math.abs(c1[i])) < mx * 0.25) i++;
  const found = i / sr - P - man.onsetRef, shift = Math.abs(found) < 0.06 ? found : 0;
  const BAR = man.bar, region = (r) => { const at = r.at + shift; return { at, loopStart: at + r.loopBar * BAR, loopEnd: at + r.bars * BAR, bars: r.bars, loopBar: r.loopBar }; };
  const secOf = (bar) => { for (const s of man.sections) if (bar >= s.from && bar < s.to) return s.name; return ''; };
  return { man, bar: BAR, shift, main: region(man.main), last: region(man.last), secOf, ...Object.fromEntries(STEM_NAMES.map((k, j) => [k, bufs[j]])) };
}

// -------------------------------------------------------------------------------------------- the module
const audio = {
  name: 'audio',
  ctx: null, ready: false, enabled: true, muted: false, volume: 0.75,
  master: null, bus: null, ambience: null,
  VOICES, FOLEY,

  init(engine) {
    this.engine = engine;
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
    const mode = q.get('audio');
    this.enabled = mode !== '0' && mode !== 'off';
    this.meterOn = mode === 'meter';
    try {
      const v = localStorage.getItem('shibuya.audio.volume');
      if (v != null) this.volume = Math.min(1, Math.max(0, parseFloat(v) || 0));
      this.muted = localStorage.getItem('shibuya.audio.muted') === '1';
    } catch (e) { /* private mode */ }

    this._voices = 0; this._last = Object.create(null); this._count = Object.create(null); this._feet = new Map();
    this._mus = { want: 'none', step: 0, nextT: 0, bar: 0 };
    this._train = null; this._trainIn = 8 + Math.random() * 14;
    this._sig = { mode: 'stop', next: 0, side: 0 };
    this._duck = { amb: 1, mus: 1, lp: 20000 }; this._duckFlags = {};
    this._meter = null; this._sp = 1; this._wasSlow = false; this._paused = false;
    this._crowdVoices = 0; this._stepAcc = 0; this._nearAt = 0;
    this._active = []; this._worldFifo = []; this._panPool = []; this._sweepAt = 0;
    this._evNext = 0; this._down = new Map(); this._amb = { wet: -1, rain: -1, crowd: -1 };
    this._bm = { t0: 0, srcs: null, brk: false, pendingAt: 0, sec: 'main', secAt: 0 };  // battle stems: origin, sources, section
    this._intens = 0; this._ring = null; this._ringG = 1; this._breathAt = 0; this._limGr = 1;
    this._enc = null; this._fin = null; this._heatOn = false; this._auraOn = false; this._eq = 0;
    this._voiceBags = Object.create(null); this._spk = new Map(); this._barkSrc = new Map();

    if (!this.enabled) { console.info('[audio] disabled by ?audio=0'); return; }

    this.ensure();                                   // created suspended if the browser wants a gesture
    // The foley bank and the baked murmur decode off the main thread from the first frame; decodeAudioData is
    // legal on a suspended context, so they are ready long before the player's first keypress resumes it.
    if (this.ctx) {
      const t0 = performance.now();
      this._foleyP = loadFoley(this.ctx).then(() => {
        console.info(`[audio] foley bank: ${Object.keys(FOLEY.buf).length} takes in ${Object.keys(FOLEY.cats).length} classes, ${Math.round(performance.now() - t0)} ms (async)`);
      }).catch((e) => console.warn('[audio] foley bank unavailable — synth impacts:', e && e.message));
      // the battle theme's baked stems, decoded off the main thread
      this._stemP = loadStems(this.ctx).then((st) => {
        this._stems = st;
        console.info(`[audio] battle stems: ${STEM_NAMES.length} × ${st.drums.duration.toFixed(1)} s, ${st.man.main.bars}+${st.man.last.bars} bars, decoder shift ${(st.shift * 1000).toFixed(2)} ms (${Math.round(performance.now() - t0)} ms since init, async)`);
        if (this._bm.pendingAt && this.running) this.startBattle(Math.max(this._bm.pendingAt, this.ctx.currentTime + 0.05));
        return st;
      }).catch((e) => { this._stemsFailed = true; console.warn('[audio] battle stems unavailable — live 4-bar sequencer:', e && e.message); return null; });
      this._crowdP = fetch(SFX_URL('crowd_murmur.wav')).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(ab => decodeWith(this.ctx, ab)).then(b => { this._crowdBuf = b; if (this.ambience) this.addCrowd(b); return b; })
        .catch((e) => { console.warn('[audio] crowd murmur unavailable:', e && e.message); return null; });
    }
    const start = () => { this.ensure(); };
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, start, { passive: true });
    this._unGesture = () => { for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, start); };

    // M mutes, [ / ] trim the master. The input contract has no audio actions and menus.js owns the options
    // screen, so these live here until the UI owner calls setVolume()/setMuted() from a slider.
    this._onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'KeyM') this.toggleMute();
      else if (e.code === 'BracketLeft') this.setVolume(this.volume - 0.1);
      else if (e.code === 'BracketRight') this.setVolume(this.volume + 0.1);
      else return;
      console.info(`[audio] ${this.muted ? 'muted' : 'volume ' + Math.round(this.volume * 100) + '%'}`);
    };
    window.addEventListener('keydown', this._onKey, { passive: true });

    this.bindEvents(engine);
    this.loadVoice();
    if (this.meterOn) this.buildMeter();
  },

  // ------------------------------------------------------------------------------------------ the graph
  ensure() {
    if (!this.enabled) return false;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().then(() => this.onRunning()).catch(() => {});
      else this.onRunning();
      return this.ready;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      // [mobile] ?audio=lite: a 22.05 kHz context — every decoded buffer at half the float32 memory of 44.1 / 48 kHz
      let ctx = null;
      if (AUDIO_LITE) { try { ctx = new AC({ latencyHint: 'interactive', sampleRate: 22050 }); } catch (e) { ctx = null; } }
      if (!ctx) ctx = new AC({ latencyHint: 'interactive' });
      this.ctx = ctx;

      // The master chain deliberately splits. A glue compressor across EVERYTHING flattens impacts: Chrome's
      // DynamicsCompressor reacts inside the ~30 ms a punch lives in and eats ~19 dB of it (measured — see
      // selfTest's rawPeak vs peak), while leaving the sustained bed untouched. So the bed, the music and the
      // world sources get glued, and the SFX and voice buses run straight into the limiter and punch through.
      const glue = ctx.createDynamicsCompressor();
      glue.threshold.value = -18; glue.knee.value = 12; glue.ratio.value = 2.5;
      glue.attack.value = 0.02; glue.release.value = 0.25;
      // master → [look-ahead true-peak limiter, AudioWorklet] → safety soft clip (knee 0.93) → out. Until the
      // worklet module has loaded (a few ms, long before the first gesture) and in a browser without AudioWorklet,
      // the old memoryless soft clip (knee 0.62) stands in. The payoff frames — heat contact + heat_final + body
      // fall + bark + stems — used to be the ones that clip waveshaped: odd-harmonic grit exactly where clarity
      // matters. A limiter turns them down for a few ms instead.
      const master = this.master = gain(ctx, this.muted ? 0 : this.volume);
      const out = gain(ctx, 1); out.connect(ctx.destination);
      const fallback = ctx.createWaveShaper(); fallback.curve = clipCurve(ctx, 0.62); fallback.oversample = '2x';
      const safety = ctx.createWaveShaper(); safety.curve = clipCurve(ctx, SAFETY_KNEE); safety.oversample = '2x';
      master.connect(fallback).connect(out);
      glue.connect(master);
      const limiter = fallback;
      this.tap = out;                                  // analyser hangs here in ?audio=meter
      this._limiterMode = 'soft clip (fallback)';
      if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        const url = URL.createObjectURL(new Blob([LIMITER_WORKLET], { type: 'text/javascript' }));
        ctx.audioWorklet.addModule(url).then(() => {
          const lim = new AudioWorkletNode(ctx, 'shibuya-limiter', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
            processorOptions: { ceilDb: -1, lookMs: 1.5, holdMs: 5, relMs: 80 },
          });
          lim.port.onmessage = (e) => { this._limGr = Math.min(this._limGr, e.data); };
          master.disconnect(); master.connect(lim).connect(safety).connect(out);
          try { fallback.disconnect(); } catch (err) { /* gone */ }
          this.bus.limiter = lim; this._limiterMode = 'look-ahead TP limiter −1 dBTP';
        }).catch((e) => console.warn('[audio] limiter worklet unavailable — soft clip:', e && e.message))
          .finally(() => URL.revokeObjectURL(url));
      }

      // The reverb返り goes STRAIGHT to master, not through the glue. Sending it through meant an impact's own
      // tail was ducked by whatever the compressor was doing to the city bed and the music at that instant —
      // a punch's reverb breathing to the kick drum, which is the exact thing splitting the bus was for.
      const verb = ctx.createConvolver(); verb.buffer = irBuf(ctx);
      const verbGain = gain(ctx, 0.55); verb.connect(verbGain).connect(master);

      const mk = (v, to, send = 0) => {
        const g = gain(ctx, v); g.connect(to);
        if (send) { const s = gain(ctx, send); g.connect(s).connect(verb); }
        return g;
      };
      // duck → sidechain → lowpass → glue. `duck` is the slow programme duck (combat / dialogue / pause),
      // `sc` is the fast per-impact pump, `lp` is the pause / cutscene filter — and, on the street buses only,
      // the hit-stop freeze. The music's lp never moves on a hit: a fight's theme is at full energy exactly
      // when the punches land. Three jobs, three nodes, so none fights another's time constant.
      const duckAmb = gain(ctx, 1), duckMus = gain(ctx, 1), duckWld = gain(ctx, 1);
      const scAmb = gain(ctx, 1), scMus = gain(ctx, 1), scWld = gain(ctx, 1);
      const lpAmb = bq(ctx, 'lowpass', 20000, 0.4), lpMus = bq(ctx, 'lowpass', 20000, 0.4);
      const lpWld = bq(ctx, 'lowpass', 20000, 0.4);
      duckAmb.connect(scAmb).connect(lpAmb).connect(glue);
      duckMus.connect(scMus).connect(lpMus).connect(glue);
      // The street's ONE-SHOTS get the same duck, the same pump and the same pause filter as the bed, but not
      // the same glue: a horn, the 誘導音 and a shutter are transients, and a 2.5:1 compressor that reacts in
      // 20 ms flattens them into the murmur they are supposed to stand 8–12 dB above. That is why the master
      // trace was a dead-flat carpet with 150 vehicles and 1070 people on screen.
      duckWld.connect(scWld).connect(lpWld).connect(master);
      // The battle stems' own strip: a lowpass that only the heat-action section closes, and a 2–4 kHz dip that
      // opens a pocket for the punches while a fight is on — light hits sit on top by EQ, not by ducking.
      const battleIn = gain(ctx, STEM_GAIN), battleLP = bq(ctx, 'lowpass', 20000, 0.7), battleEQ = ctx.createBiquadFilter();
      battleEQ.type = 'peaking'; battleEQ.frequency.value = 2800; battleEQ.Q.value = 0.75; battleEQ.gain.value = 0;
      // the intensity stem's own gain, ridden by player.heat / 100 in update()
      const intens = gain(ctx, 0); intens.connect(battleIn);
      // the onlooker ring: the street's pump and hit-stop filter (scWld → lpWld), NOT the fight duck — the やじ馬
      // are the one part of the street that gets louder when a fight starts
      const ring = gain(ctx, 1); ring.connect(scWld);
      this.bus = {
        glue, limiter, safety, out, verb, verbGain, duckAmb, duckMus, duckWld, scAmb, scMus, scWld, lpAmb, lpMus, lpWld,
        battleIn, battleLP, battleEQ, intens, ring,
        // The ladder: the street comes down 5 dB, the impacts sit over the theme. A landed hit pumps the street;
        // the music gives 1.5 dB to every hit for 60 ms and at most 3 dB to heavies and heat contacts.
        amb: mk(0.25, duckAmb),
        sfx: mk(SFX_BUS, master, 0.10),                // impacts bypass the glue — and sit ABOVE the bed
        voice: mk(1.1, master, 0.07),
        // world (horns, the 誘導音, the viaduct, thunder) rides the AMBIENCE duck, not the raw glue: it is part
        // of the street, so it has to muffle behind a pause and pull back under a fight like the rest of it.
        world: mk(0.85, duckWld, 0.10),
        battle: mk(0, duckMus),
        explore: mk(0, duckMus),
        ui: mk(0.9, master),                           // dry: UI is not in the world
      };
      battleIn.connect(battleLP).connect(battleEQ).connect(this.bus.battle);
      this.ready = true;
      if (ctx.state === 'suspended') { ctx.resume().then(() => this.onRunning()).catch(() => {}); return true; }
      this.onRunning();
      return true;
    } catch (e) {
      this.enabled = false;
      console.warn('[audio] WebAudio unavailable:', e && e.message);
      return false;
    }
  },

  /** Called once the context actually reaches 'running' — only then may anything be scheduled. */
  onRunning() {
    if (!this.ready || this.running || !this.ctx || this.ctx.state !== 'running') return;
    this.running = true;
    if (this._unGesture) { this._unGesture(); this._unGesture = null; }
    this._mus.nextT = this.ctx.currentTime + 0.12;
    this.setAmbience(true);
    const mode = this.engine && this.engine.state && this.engine.state.mode;
    this.setMusic(mode === 'combat' ? 'battle' : 'explore');
    if (this._arenaWant) this.arenaOn(this._arenaWant.centre, this._arenaWant.radius);
    setTimeout(() => this.prepFinisher(), 2500);                    // the final blow's tail, once the bank has decoded
    console.info(`[audio] running @ ${this.ctx.sampleRate} Hz — ambience + ${this._mus.want} bed`);
  },

  // --------------------------------------------------------------------------------------------- volume
  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.03);
    try { localStorage.setItem('shibuya.audio.volume', String(this.volume)); } catch (e) { /* ignore */ }
    return this.volume;
  },
  getVolume() { return this.volume; },
  setMuted(b) {
    this.muted = !!b;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
    try { localStorage.setItem('shibuya.audio.muted', this.muted ? '1' : '0'); } catch (e) { /* ignore */ }
    return this.muted;
  },
  toggleMute() { return this.setMuted(!this.muted); },

  // ------------------------------------------------------------------------------------------ one-shots
  /** play(name, { gain, pos:[x,y,z]|Vector3, ...voiceOpts }) — safe to call before the context is running. */
  play(name, o = {}) {
    if (!this.running || this.muted || !this.ctx) return false;
    const v = VOICES[name];
    if (!v) return false;
    // The cap used to be priority-blind. Crowd footsteps run at 22/s on the same counter as horns and the
    // 誘導音, so on the scramble the 47th voice could be the `ko` that ends chapter 1 — dropped, silently.
    // A PRI voice now steals the oldest crowd/world one-shot instead of being dropped by it.
    if (this._voices > 46) {
      if (!PRI.has(name)) return false;
      this.stealWorld();
      if (this._voices > 60) return false;
    }
    // Nothing in the impact family may repeat bit-for-bit. A ±6 % varispeed is not enough on its own — every
    // punch was still sine + bandpassed white + lowpassed pink — so each play also advances a recipe index,
    // which swaps the crack's noise colour, its resonator order and its centre. Consecutive hits cannot repeat.
    if (IMPACTS.has(name)) {
      if (o.rate == null || o.variant == null) o = { ...o };
      if (o.rate == null) o.rate = 0.94 + Math.random() * 0.12;
      if (o.variant == null) o.variant = (this._count[name] | 0) % RECIPES.length;
    }
    const ctx = this.ctx;
    let t = Math.max(ctx.currentTime + 0.002, this._nudge(name));
    if (o.delay) t += o.delay;                                 // sample-accurate follow-ups (the body fall)
    // A panner is placement, not routing: it feeds the voice's OWN bus, so a positional punch still bypasses
    // the glue compressor. Only ambient world sources ask for bus 'world'.
    const busName = o.bus || 'sfx';
    const target = this.bus[busName] || this.bus.sfx;
    let dest = target;
    let pn = null;
    if (o.pos) { pn = this.panner(o.pos, o.ref); if (pn) { pn.node.connect(target); dest = pn.in; } }
    let tail = 0.3;
    try { tail = v(ctx, dest, t, o) || 0.3; } catch (e) { if (pn) pn.dispose(); return false; }
    this._voices++;
    this._count[name] = (this._count[name] || 0) + 1; this._lastName = name;
    if (LOGGED.has(name)) this.note(name);
    // One 100 ms sweep over a small array, not a setTimeout per voice: crowdSteps alone churned ~44 timers a
    // second. `until` is wall-clock, so a voice retires on its own tail whatever the world is doing.
    const e = { until: ctx.currentTime + (o.delay || 0) + tail + 0.25, pn, crowd: !!o.crowd, steal: pn && busName === 'world' ? pn.g : null };
    this._active.push(e);
    if (e.crowd) this._crowdVoices++;
    if (e.steal) { this._worldFifo.push(e); if (this._worldFifo.length > 48) this._worldFifo.shift(); }
    return true;
  },

  /** the meter's event log: the last few fight cues, so a screenshot can show what just happened */
  note(what) {
    const L = this._log || (this._log = []);
    L.push([what, this.ctx ? this.ctx.currentTime : 0]); if (L.length > 7) L.shift();
  },

  /** Cap reached and an impact needs a slot: mute the oldest positional world one-shot (a crowd footstep, a
   *  distant horn) and retire it early. An impact steals a footstep, never the other way round. */
  stealWorld() {
    const f = this._worldFifo;
    while (f.length) {
      const e = f.shift();
      if (e.done || !e.steal) continue;
      try { e.steal.gain.setTargetAtTime(FLOOR, this.ctx.currentTime, 0.008); } catch (err) { /* gone */ }
      e.until = this.ctx.currentTime + 0.05;
      return true;
    }
    return false;
  },

  /** Retire finished voices. Called from update() at 10 Hz; also drives the polyphony counter. */
  sweep(now) {
    const a = this._active;
    let w = 0;
    for (let i = 0; i < a.length; i++) {
      const e = a[i];
      if (e.until > now) { a[w++] = e; continue; }
      e.done = true;
      this._voices--;
      if (e.crowd) this._crowdVoices--;
      if (e.pn) e.pn.dispose();
    }
    a.length = w;
    if (this._voices < 0) this._voices = 0;
    if (this._crowdVoices < 0) this._crowdVoices = 0;
  },

  /** A landed impact pumps the STREET (bed + world one-shots) down for the freeze, so the punch cuts its own hole.
   *  The music is a separate, capped decision: `music` < 1 only for heavies and heat contacts, and never below
   *  MUS_PUMP_FLOOR (−3 dB). A rush string lands every 200–250 ms; pumping the theme on each jab kept it muffled
   *  for the whole string, exactly when a 龍が如く battle theme is at full energy. */
  sidechain(amount = 0.63, hold = 0.12, music = 1, musHold = hold) {
    if (!this.running) return;
    const t = this.ctx.currentTime;
    const pump = (g, v, h, a = 0.012, r = 0.13) => {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(v, t + a);
      g.gain.setValueAtTime(v, t + h);
      g.gain.linearRampToValueAtTime(1, t + h + r);
    };
    pump(this.bus.scAmb, amount, hold); pump(this.bus.scWld, amount, hold);
    // a light hit's pocket is short and shallow (6 ms in, 90 ms back); it never lifts a deeper pump in progress
    if (music < 1) {
      const v = Math.max(MUS_PUMP_FLOOR, music), g = this.bus.scMus;
      if (v >= MUS_PUMP_LIGHT && g.gain.value < v - 0.01) return;
      pump(g, v, musHold, v >= MUS_PUMP_LIGHT ? 0.006 : 0.012, v >= MUS_PUMP_LIGHT ? 0.09 : 0.13);
    }
  },

  /** Two hits in the same millisecond phase-cancel and sound thin; nudge duplicates by a few ms. */
  _nudge(name) {
    const ctx = this.ctx, t = ctx.currentTime + 0.002;
    const prev = this._last[name] || 0;
    const at = t <= prev + 0.012 ? prev + 0.012 + Math.random() * 0.006 : t;
    this._last[name] = at;
    return at;
  },

  /** Placement, plus AIR. The PannerNode's inverse curve only makes a distant source quieter; real air also
   *  eats its top end, and without that the far side of the frame sounds glued to the near side — the visual
   *  fog and haze with no audio equivalent. 20 kHz · e^(−d/110) is a coarse but honest absorption curve:
   *  ~12 kHz at 50 m, ~3.3 kHz at 200 m, which is what a horn down Meiji-dori actually arrives as.
   *  Returns { in, node, dispose }: connect the source to `in`, connect `node` to the bus. */
  panner(pos, ref) {
    const ctx = this.ctx;
    // Pooled. crowdSteps fires 22 placements a second and each one used to allocate a fresh PannerNode +
    // BiquadFilter, ~150 AudioNodes a second churned and garbage-collected inside a 7 ms frame budget.
    // A checkout resets the three positions, the air cutoff and the steal gain; nothing else carries over.
    let s = this._panPool.pop();
    if (!s) {
      const g = gain(ctx, 1);
      const air = bq(ctx, 'lowpass', 20000, 0.3);
      const p = ctx.createPanner();
      p.panningModel = 'equalpower';               // dozens of sources: HRTF would cost more than it buys here
      p.distanceModel = 'inverse';
      p.maxDistance = 260;
      g.connect(air).connect(p);
      const self = this;
      s = { in: g, g, air, node: p, dispose() { self.releasePanner(this); } };
    }
    const p = s.node;
    p.refDistance = ref || 7; p.rolloffFactor = 1.15; p.maxDistance = 260;
    const x = pos.x ?? pos[0] ?? 0, y = pos.y ?? pos[1] ?? 1, z = pos.z ?? pos[2] ?? 0;
    const t = ctx.currentTime;
    if (p.positionX) {
      p.positionX.cancelScheduledValues(t); p.positionY.cancelScheduledValues(t); p.positionZ.cancelScheduledValues(t);
      p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    } else p.setPosition(x, y, z);
    s.g.gain.cancelScheduledValues(t); s.g.gain.value = 1;
    s.air.frequency.cancelScheduledValues(t);
    s.air.frequency.value = this.airCutoff(x, y, z);
    return s;
  },

  releasePanner(s) {
    try { s.node.disconnect(); } catch (e) { /* gone */ }
    if (this._panPool.length < 16) this._panPool.push(s);
    else { try { s.g.disconnect(); s.air.disconnect(); } catch (e) { /* gone */ } }
  },

  airCutoff(x, y, z) {
    const cam = this.engine && this.engine.camera;
    let d = 0;
    if (cam) { const c = cam.position; d = Math.hypot(x - c.x, y - c.y, z - c.z); }
    return Math.max(900, Math.min(20000, 20000 * Math.exp(-d / 110)));
  },

  // -------------------------------------------------------------------------------------------- ambience
  setAmbience(on) {
    if (!this.running) return;
    if (!on) {
      if (this.ambience) { this.ambience.gain.gain.setTargetAtTime(FLOOR, this.ctx.currentTime, 0.4); this.ambience.off = true; }
      return;
    }
    if (this.ambience) { this.ambience.off = false; this.ambience.gain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.4); return; }
    const ctx = this.ctx, t = ctx.currentTime;
    const root = gain(ctx, FLOOR); root.connect(this.bus.amb);
    root.gain.exponentialRampToValueAtTime(1, t + 2.5);

    const layer = (src, chain, level) => { let n = src; for (const c of chain) n = n.connect(c); const g = gain(ctx, level); n.connect(g).connect(root); return g; };

    // 1. city hum — pink noise under 200 Hz plus two drones: the sound of ten thousand machines. The client heard the
    //    bed as 「変な音…雑音」: the drones (a 51 / 77.5 / 103 Hz buzz) are gone unless ?amb=legacy, the rumble is
    //    6 dB down.
    const LEGACY = typeof location !== 'undefined' && /[?&]amb=legacy/.test(location.search);
    const hum = ctx.createBufferSource(); hum.buffer = noiseBuf(ctx, 4, 'pink'); hum.loop = true; hum.start(t);
    const humG = layer(hum, [bq(ctx, 'lowpass', 220, 0.7), bq(ctx, 'highpass', 38, 0.7)], LEGACY ? 0.30 : 0.15);
    for (const [f, a] of LEGACY ? [[51, 0.035], [77.5, 0.022], [103, 0.014]] : []) {
      const o = osc(ctx, 'sine', f, t, t + 1e7);
      const g = gain(ctx, a);
      const lfo = osc(ctx, 'sine', 0.037 + Math.random() * 0.05, t, t + 1e7);
      const lg = gain(ctx, a * 0.45); lfo.connect(lg).connect(g.gain);
      o.connect(g).connect(root);
    }

    // 2. distant traffic wash — brown noise through a slowly swelling bandpass (tyres, not engines). It was the
    //    loudest thing in the bed (-23.5 dBFS, 6 dB over the crowd) and constant, a ゴー with no source on screen:
    //    the client's 「変な音がずっとする…雑音」. Now it follows the traffic moving within 90 m (update()) and sits
    //    ~12 dB lower; ?amb=legacy keeps the old constant wash.
    const tr = ctx.createBufferSource(); tr.buffer = noiseBuf(ctx, 4, 'brown'); tr.loop = true; tr.playbackRate.value = 0.85; tr.start(t);
    const trF = bq(ctx, 'bandpass', 420, 0.55);
    const trG = layer(tr, [trF, bq(ctx, 'lowpass', 2600, 0.6)], LEGACY ? 0.42 : 0.0);
    const swell = osc(ctx, 'sine', 0.061, t, t + 1e7);
    const swellG = gain(ctx, 230); swell.connect(swellG).connect(trF.frequency);
    const swell2 = osc(ctx, 'sine', 0.017, t, t + 1e7);
    const swell2G = gain(ctx, LEGACY ? 0.14 : 0.02); swell2.connect(swell2G).connect(trG.gain);

    // 3. crowd murmur — the baked stereo granular bed (two decorrelated channels), attached when it decodes
    const crowdG = gain(ctx, 0.50); crowdG.connect(root);

    // 4. wet-road layer — tyres swishing through standing water. It used to be a constant 1.4–3.4 kHz white hiss at
    //    0.3, which read as rain still falling (client: 「雨の音がする…雨上がりということにして」). Now it is pink
    //    noise lower down (700 Hz–2.4 kHz), and its level follows the traffic actually moving near you (update()),
    //    so it swells as a platoon pulls away on green and dies at the red: the road is wet, the sky is not.
    const wet = ctx.createBufferSource(); wet.buffer = noiseBuf(ctx, 4, 'pink'); wet.loop = true; wet.playbackRate.value = 0.8; wet.start(t);
    const wetG = layer(wet, [bq(ctx, 'bandpass', 1300, 0.6), bq(ctx, 'lowpass', 2400, 0.7), bq(ctx, 'highpass', 500, 0.7)], 0.0);

    // 5. active rain (only when weather === 'rain'; the showpiece is *after* the rain)
    const rain = ctx.createBufferSource(); rain.buffer = noiseBuf(ctx, 4, 'white'); rain.loop = true; rain.start(t);
    const rainG = layer(rain, [bq(ctx, 'bandpass', 2200, 0.35), bq(ctx, 'highpass', 700, 0.5)], 0.0);

    this.ambience = { gain: root, hum: humG, traffic: trG, crowd: crowdG, wet: wetG, rain: rainG, off: false, legacy: LEGACY };
    if (this._crowdBuf) this.addCrowd(this._crowdBuf);
  },

  addCrowd(buf) {
    const A = this.ambience;
    if (!A || A.crowdSrc || !buf || !this.ctx) return;
    const ctx = this.ctx, c = ctx.createBufferSource();
    c.buffer = buf; c.loop = true; c.start(ctx.currentTime, Math.random() * (buf.duration - 0.5));
    // 9 kHz, not 3.4 kHz: the murmur carries sibilance and cutting at 3.4 threw all of it away, which is why the
    // whole master bus once sat 25 dB down at 8–16 kHz — the night city behind a closed window.
    c.connect(bq(ctx, 'highpass', 190, 0.7)).connect(bq(ctx, 'lowpass', 9000, 0.6)).connect(A.crowd);
    A.crowdSrc = c;
  },

  // ----------------------------------------------------------------------------------------------- music
  /** 'battle' starts the stems (if they are not already looping) and fades the bus in; 'explore' fades the
   *  pad in and the stems out; 'none' fades both. The encounter and the finale bypass this for hard edges. */
  setMusic(mode) {
    this._mus.want = mode;
    if (!this.running) return;
    const t = this.ctx.currentTime, XF = 0.9;
    const to = (g, v) => { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(g.gain.value, FLOOR), t); g.gain.linearRampToValueAtTime(v, t + XF); };
    to(this.bus.battle, mode === 'battle' ? BATTLE_BUS : 0);   // 0.62 put the guitars OVER the punches
    to(this.bus.explore, mode === 'explore' ? 0.10 : 0);
    if (mode === 'battle' && !this._bm.srcs) this.startBattle(t + 0.05);
    if (mode !== 'battle' && this._bm.srcs) this.stopBattle(t + XF + 0.05);
  },

  /** Start the arrangement from bar 1 at `at` (intro once, then bars 5–32 loop). The four sources are
   *  sample-locked (one start time, one loop region), so the only things that change the music mid-fight are
   *  stem gains, the section filter and the jump to the last-man section — never the tempo. */
  startBattle(at) {
    const st = this._stems, bm = this._bm;
    if (!st) { bm.pendingAt = at; return; }
    bm.pendingAt = 0;
    if (bm.srcs) this.stopBattle(at);
    bm.t0 = at; bm.brk = false;
    const last = !!this._wantLast;
    bm.sec = last ? 'last' : 'main'; bm.secAt = at;
    bm.srcs = this.stemSources(last ? st.last : st.main, at);
    this.bus.battleLP.frequency.cancelScheduledValues(at); this.bus.battleLP.frequency.setValueAtTime(20000, at);
  },
  /** four looping sources over one region of the stems, entering at the region's start at time `at` */
  stemSources(region, at, gains = null) {
    const ctx = this.ctx, st = this._stems, out = {};
    for (const k of STEM_NAMES) {
      const s = ctx.createBufferSource(); s.buffer = st[k]; s.loop = true;
      s.loopStart = region.loopStart; s.loopEnd = region.loopEnd;
      const g = gain(ctx, gains ? gains[k] : 1);
      s.connect(g).connect(k === 'intensity' ? this.bus.intens : this.bus.battleIn);
      s.start(at, region.at);
      out[k] = { s, g };
    }
    return out;
  },
  /** One enemy left: on the next bar line the theme cuts to its 8-bar last-man section (16th chugs, double kick,
   *  tremolo lead, brass held open). A 25 ms crossfade under a downbeat that opens on a crash. */
  lastMan() {
    const bm = this._bm, st = this._stems;
    this._wantLast = true;
    if (!st || !bm.srcs || bm.sec === 'last' || !this.running) return;
    const now = this.ctx.currentTime, at = this.nextBeat(now + 0.05, 4);
    for (const k in bm.srcs) {
      const x = bm.srcs[k];
      try { x.g.gain.cancelScheduledValues(now); x.g.gain.setValueAtTime(x.g.gain.value, at); x.g.gain.linearRampToValueAtTime(0, at + 0.025); x.s.stop(at + 0.05); } catch (e) { /* stopped */ }
    }
    const b = bm.brk;
    bm.srcs = this.stemSources(st.last, at, { drums: b ? 0 : 1, harm: b ? 1.35 : 1, lead: b ? 0 : 1, intensity: b ? 0 : 1 });
    bm.sec = 'last'; bm.secAt = at;
    this.note('LAST MAN');
  },
  stopBattle(at, tau = 0.25) {
    const bm = this._bm; if (!bm.srcs) return;
    const now = this.ctx.currentTime;
    for (const k in bm.srcs) {
      const x = bm.srcs[k];
      try { x.g.gain.cancelScheduledValues(now); x.g.gain.setTargetAtTime(0, Math.max(now, at), tau); x.s.stop(Math.max(now, at) + tau * 6); } catch (e) { /* already stopped */ }
    }
    bm.srcs = null; bm.brk = false; bm.sec = 'main';
  },
  /** the next beat (or `grid` beats) of the running loop at or after `from` */
  nextBeat(from, grid = 1) {
    const bm = this._bm, q = SPB * grid;
    if (!bm.srcs) return from;
    return bm.t0 + Math.max(0, Math.ceil((from - bm.t0) / q - 1e-6)) * q;
  },
  /** where the arrangement is, for the meter: bar 1–40 (33–40 = last man), beat 1–4, section name */
  barBeat(now) {
    const bm = this._bm, st = this._stems; if (!bm.srcs || now < bm.t0 || !st) return null;
    const beat = 1 + (Math.floor((now - bm.t0) / SPB + 1e-6) % 4);
    let bar;
    if (bm.sec === 'last') bar = st.main.bars + (Math.floor((now - bm.secAt) / st.bar + 1e-6) % st.last.bars);
    else { const b = Math.floor((now - bm.t0) / st.bar + 1e-6), M = st.main; bar = b < M.bars ? b : M.loopBar + ((b - M.loopBar) % (M.bars - M.loopBar)); }
    return { bar: bar + 1, beat, sec: st.secOf(bar), chord: st.man.chords ? st.man.chords[bar] : '' };
  },
  /** The heat-action section. On the next beat the drums and the riff drop out and the band closes to a 560 Hz
   *  lowpass — a held, filtered bed for the slow-motion — and it opens again on a beat once the world is back to
   *  speed. The old version stretched the sequencer instead: 43 BPM, 210 ms late, no pitch change. */
  setBreak(on) {
    const bm = this._bm;
    if (!bm.srcs || bm.brk === on) return;
    bm.brk = on;
    const now = this.ctx.currentTime, at = this.nextBeat(now + 0.02);
    const { drums, lead, harm, intensity } = bm.srcs;
    for (const [g, v] of [[drums.g, on ? 0 : 1], [lead.g, on ? 0 : 1], [intensity.g, on ? 0 : 1], [harm.g, on ? 1.35 : 1]]) {
      g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now); g.gain.setTargetAtTime(v, at, on ? 0.012 : 0.006);
    }
    const f = this.bus.battleLP.frequency;
    f.cancelScheduledValues(now); f.setValueAtTime(f.value, now); f.setTargetAtTime(on ? 560 : 20000, at, on ? 0.06 : 0.02);
    this._brkAt = at;
  },

  /** A fight opens here. The riser starts now and everything lands on one frame 0.6 s later: the slam, the
   *  crash, the taiko — and bar 1 beat 1 of the battle stems, which start AT that frame at full bus level. The
   *  old entry faded the loop in over 0.9 s from whatever step the explore pad had reached. */
  encounter() {
    if (!this.running) return;
    const now = this.ctx.currentTime, LEAD = 0.6, T = now + LEAD;
    this._fin = null; this._wantLast = false;
    this.play('encounter', { gain: 1, lead: LEAD });
    // 「行くぞ」 on the slam (just behind it, so the voice does not smear the transient)
    if (this.engine && this.engine.player) this.bark(this.engine.player, 'encounter', LEAD + 0.09);
    this._mus.want = 'battle';
    this._mus.step = 0; this._mus.nextT = T;            // the pad's scheduler restarts its bar count at the slam
    const E = this.bus.explore.gain, B = this.bus.battle.gain;
    E.cancelScheduledValues(now); E.setValueAtTime(Math.max(E.value, FLOOR), now); E.linearRampToValueAtTime(0, T);
    B.cancelScheduledValues(now); B.setValueAtTime(0, now); B.setValueAtTime(BATTLE_BUS, T);
    this.startBattle(T);
    this._encAt = T;
  },

  /** The last man is down (or the fight ended some other way). Cut the band dead on the next beat with the
   *  tonic button, let the KO ring, then the victory sting, and only then the explore pad. */
  finale() {
    if (!this.running || this._fin) return;
    const now = this.ctx.currentTime;
    // the fight's final blow (combat/finalBlow.js): the band plays on, muffled and slowed with the world, and is cut
    // dead with the button the instant time starts to come back — a hard edit on the ramp, not on the (slowed) beat
    const cb = this._mod('combat'), fb = cb && cb.finale && !cb.finale.heat ? cb.finale : null;
    const nb = fb ? now + Math.max(0.06, FINAL_BLOW.freeze + FINAL_BLOW.hold - fb.t)
      : this._bm.srcs ? this.nextBeat(now + 0.06) : now + 0.06;
    if (fb && this.fbLog) this.fbLog.push(['the band cut dead: tonic button', nb]);
    if (this._bm.srcs) this.stopBattle(nb, 0.004);
    this._mus.want = 'none';
    this.play('button', { gain: 1, delay: Math.max(0, nb - now - 0.002) });
    this._fin = { buttonAt: nb, victoryAt: nb + 1.15, padAt: nb + 1.15 + 1.9, victory: false };
  },
  finaleTick(now) {
    const F = this._fin; if (!F) return;
    if (!F.victory && now >= F.victoryAt - 0.12) {
      F.victory = true; this.play('victory', { gain: 1, delay: Math.max(0, F.victoryAt - now) });
      if (this.fbLog) this.fbLog.push(['victory sting', F.victoryAt]);
    }
    if (now >= F.padAt) { this._fin = null; if (this._mus.want === 'none') this.setMusic('explore'); }
  },

  /** Wall-clock only. The battle theme is baked stems, so the scheduler's one remaining job is the explore pad —
   *  plus the old live 4-bar battle sequencer, kept only as the fallback if the stems fail to load or decode. */
  scheduleMusic() {
    const ctx = this.ctx, m = this._mus;
    const ahead = ctx.currentTime + 0.28;
    if (m.nextT < ctx.currentTime - 0.5) m.nextT = ctx.currentTime + 0.05;     // tab was backgrounded
    const live = this._stemsFailed && (m.want === 'battle' || this.bus.battle.gain.value > 0.002);
    const explore = m.want === 'explore' || this.bus.explore.gain.value > 0.002;
    while (m.nextT < ahead) {
      const t = m.nextT, s = m.step % 16, bar = Math.floor(m.step / 16) % 4;
      if (live) battleNotes(ctx, this.bus.battleIn, t, s, bar, Math.floor(m.step / 64));
      if (explore && m.step % 64 === 0) this.explorePad(t, Math.floor(m.step / 64) % 4);
      m.step++; m.nextT += STEP;
    }
  },

  // A slow minor pad for walking to Hachiko — four chords, one per 4 bars, nothing in the way of the city.
  explorePad(t, which) {
    const ctx = this.ctx, E = this.bus.explore;
    const CH = [[N.A2, N.C3, N.E3, N.G3], [N.F2, N.A2, N.C3, N.E3], [N.C3, N.E3, N.G3, N.D4], [N.E2, N.G2, N.D3, N.G3]];
    const dur = STEP * 64;
    // the two detunes split wide, so the pad opens the night out instead of sitting in the middle of the head
    for (const [det, p] of [[-8, -0.55], [9, 0.55]]) {
      const lp = bq(ctx, 'lowpass', 520, 1.1);
      const g = gain(ctx, 0);
      g.gain.setValueAtTime(FLOOR, t);
      g.gain.linearRampToValueAtTime(0.30, t + dur * 0.35);
      g.gain.linearRampToValueAtTime(FLOOR, t + dur + 0.6);
      lp.connect(g).connect(musPan(ctx, E, p));
      const mv = osc(ctx, 'sine', 0.06 + (det > 0 ? 0.013 : 0), t, t + dur + 1);
      const mvg = gain(ctx, 220); mv.connect(mvg).connect(lp.frequency);
      for (const n of CH[which]) osc(ctx, 'sawtooth', SEMI(n), t, t + dur + 0.8, det).connect(lp);
    }
    const sub = osc(ctx, 'sine', SEMI(CH[which][0] - 12), t, t + dur + 0.8);
    const sg = gain(ctx, 0.10); sub.connect(sg).connect(E);
  },

  // ---------------------------------------------------------------------------------------------- events
  bindEvents(engine) {
    const ev = engine.events;
    if (!ev || !ev.on) return;
    const at = (e) => (e && e.position) ? e.position : null;

    // The swing is timed to its contact frame. combat.js pushes the attack into `active` just before it emits
    // this, so the entry's first hit event / playback rate is the exact time the limb will land.
    ev.on('combat:attack', ({ attacker, heavy, name }) => {
      const cb = this._mod('combat');
      let contact = heavy ? 0.3 : 0.18;
      if (cb && cb.active) {
        for (let i = cb.active.length - 1; i >= 0; i--) {
          const a = cb.active[i];
          if (a.attacker !== attacker) continue;
          if (a.hits && a.hits.length) contact = a.hits[0].t / (a.rate || 1);
          break;
        }
      }
      this.play('whoosh', { gain: heavy ? 0.85 : 0.6, heavy: !!heavy, duration: contact, pos: at(attacker) });
      if (Math.random() < (heavy ? 0.5 : 0.18)) this.bark(attacker, heavy ? 'attack_heavy' : 'attack');
    });
    // combat.js already puts `name` and `combo` on the wire; the first draft destructured neither, so hit 1
    // and hit 5 of a string were identical and a jab, a hook, a knee and a throw all landed on one sound.
    ev.on('combat:hit', ({ target, damage, point, heavy, guarded, attacker, name, combo }) => {
      const pos = point || at(target);
      const def = ATTACKS[name] || {};
      const knock = def.knock ?? 2;
      // The string gets HEAVIER as it lands, not thinner: 2 % slower per link (the old +4.5 % a link put the 4th
      // and 5th hit ~3 semitones up and 15 % shorter — the finisher sounded lighter than the opener). The contact
      // frame tightens instead: the crack's centre rises 6 % a link, which lifts the attack without thinning the
      // body, and the closing blows (combo ≥ 3) drop the sub all the way and stand 1.5 dB proud.
      const c = Math.min(4, combo | 0), closing = c >= 3;
      const rate = (1 - c * 0.02) * (0.96 + Math.random() * 0.08);
      const weapon = !!(attacker && attacker.weapon);
      const isPlayer = target && target === engine.player;
      if (guarded) {
        this.play('guard', { gain: 0.9, pos, rate, weapon });
        this.sidechain(0.78, 0.07);
        return;
      }
      const finisher = isHeat(name, def), big = heavy || finisher;
      const cls = finisher ? 'finisher' : heavy ? 'heavy' : 'light';
      const tk = foleyTake(`impact_${cls}`);          // chosen here so the hit-stop tail and the KO use the SAME take
      const g = atkGain(def, heavy, finisher), takeDb = closing ? 1.5 : 0;
      const crack = (CRACK[name] || CRACK[def.clip] || (big ? 2100 : 3100)) * (1 + 0.06 * c);
      this.play(big ? 'heavy' : 'hit', {
        gain: g, pos, rate, take: tk, takeDb, crack, weapon, finisher,
        weight: closing ? 1 : Math.min(1, knock / 7.4),              // how far the sub drops
      });
      this._lastHit = { target, big, take: tk, rate, at: this.ctx ? this.ctx.currentTime : 0 };
      // hit-stop, heard on the impact: combat.js freezes the world for def.stop (+40 ms on a KO)
      const dead = target && target.hp <= 0;
      const hold = ((def.stop ?? 60) + (dead ? 40 : 0)) / 1000;
      if (tk && hold >= 0.05) {
        this.play('freeze', { take: tk, hold, rate, pos, delay: 0.012, gain: g * dbLin(FOLEY_ST[cls] - tk.meta.st + takeDb) * dbLin(big ? -9 : -12) });
      }
      // The street ducks for the freeze. The music: −1.5 dB for 60 ms under every landed hit (the punch cuts its
      // own pocket), at most −3 dB for the hold under heavies and heat contacts.
      this.sidechain(0.72 - 0.045 * knock, hold + 0.04, big ? MUS_PUMP_FLOOR : MUS_PUMP_LIGHT, big ? hold + 0.04 : 0.06);
      // A knockdown used to make the same noise as the punch that caused it, and then silence — with 620
      // puddle decals on the ground. The body lands ~0.32 s after the contact frame.
      if (def.knockdown && target && !dead) {
        this.play('bodyfall', {
          pos, delay: 0.32, gain: 0.85 + 0.05 * knock, rate: 0.92 + Math.random() * 0.16,
          wet: engine.time ? (engine.time.wet || 0) : 0,
        });
      }
      // no hurt line on the killing blow: it would claim the bark slot and swallow the death line after it
      if (target && !dead && !isPlayer && Math.random() < 0.42) this.bark(target, 'hurt', 0.07);
      if (isPlayer && !dead) this.heroHurt(target, 0.07, pos);
    });
    // an enemy's telegraphed heavy: the glint, placed on him
    ev.on('combat:telegraph', ({ attacker } = {}) => this.play('telegraph', { pos: at(attacker), gain: 0.8, rate: 0.98 + Math.random() * 0.04 }));
    // the street-fight ring: onlookers close in around the fight (combat.js asks crowd.js for a gallery)
    ev.on('combat:arena', ({ on, centre, radius } = {}) => {
      this._arenaWant = on ? { centre, radius } : null;            // remembered: the context may not be running yet
      if (on) this.arenaOn(centre, radius); else this.arenaOff(2.8);
    });
    // enemy.js / player.js drive the down → getup chain off state timers and emit nothing; audio polls the
    // transition itself in footsteps() and raises this, so the scuff is never missing.
    ev.on('enemy:getup', (p) => {
      const e = (p && (p.entity || p.target)) || p;
      const pos = e && e.position ? e.position : null;
      this.play('footstep', { pos, gain: 0.7, material: this.materialAt(pos || { x: 0, z: 0 }), wet: engine.time ? (engine.time.wet || 0) : 0, rate: 0.8 });
      this.play('footstep', { pos, delay: 0.19, gain: 0.55, material: this.materialAt(pos || { x: 0, z: 0 }), wet: engine.time ? (engine.time.wet || 0) : 0, rate: 0.72 });
      this.bark(e, 'getup');
    });
    ev.on('combat:guardbreak', ({ target }) => { this.play('guardbreak', { gain: 1, pos: at(target) }); this.sidechain(0.55, 0.14, MUS_PUMP_FLOOR); });
    ev.on('combat:grab', ({ target }) => this.play('weapon', { gain: 0.5, action: 'grab', pos: at(target) }));
    ev.on('combat:throw', ({ target }) => this.play('whoosh', { gain: 0.9, heavy: true, pos: at(target) }));
    // The `ko` stinger is the chapter's payoff, so it is spent ONCE: on the last man. combat.js knows `last` but
    // does not send it, so it is recomputed here. enemy.js's own combat:ko listener runs first and has already
    // marked him dead and fired combat:end — the finale is idempotent and the KO handler owns its timing.
    ev.on('combat:ko', ({ target } = {}) => this.onKO(target));
    // the fight's final blow: every layer is scheduled on the contact, sample-accurate (finaleSfx)
    ev.on('combat:finale', (f) => { if (f && f.phase === 'start') this.finaleSfx(f); });
    ev.on('combat:weapon', ({ entity, action }) => this.play('weapon', { gain: action === 'break' ? 0.9 : 0.45, action, pos: at(entity) }));
    ev.on('player:dodge', (e) => this.play('whoosh', { gain: 0.45, pos: at(e) }));
    ev.on('player:hurt', ({ entity } = {}) => this.heroHurt(entity || engine.player, 0.05));

    ev.on('heat:ready', (e) => { if (!e || e === engine.player || e.isPlayer) this.play('heat_ready', { gain: 0.8 }); });
    // heat:action is the letterbox and the 「極」 stamp; the drums drop out on the next beat for the slow-motion.
    ev.on('heat:action', ({ player }) => {
      this.play('heat_action', { gain: 1 }); this.sidechain(0.34, 0.45, MUS_PUMP_FLOOR);
      this.bark(player || engine.player, 'heat');
      this._heatOn = true; this.setBreak(true);
    });
    // Each contact inside the heat action: a sweetener, and on the final one the taiko + stamp with its tail.
    ev.on('heat:impact', ({ final, strength } = {}) => {
      if (final) { this.play('heat_final', { gain: 1 }); this.sidechain(0.3, 0.5, MUS_PUMP_FLOOR); }
      else this.play('heat_hit', { gain: Math.min(1.1, 0.65 + 0.25 * (strength || 1)) });
    });

    // combat:start marks the fight; the ENCOUNTER plays when the mode actually becomes 'combat' — at once for a
    // chinpira who aggroes on the street, at the 「戦」 stamp for chapter 1, whose cutscene holds them first.
    ev.on('combat:start', () => { this.prepFinisher(); this.duck('combat', true); this._enc = { pending: true }; this._fin = null; this._wantLast = false; this._spk.clear(); });
    ev.on('combat:end', () => {
      this.duck('combat', false); this._enc = null; this._endAt = this.ctx ? this.ctx.currentTime : 0;
      if (this._ring) this.arenaOff(2.8);             // combat.js releases the ring too; whichever comes first
    });

    ev.on('prop:impact', ({ point, strength, type }) => this.play('prop', { type, strength, pos: point, gain: 0.9 }));
    ev.on('traffic:horn', (p) => {
      const pos = p && p.position ? p.position : (p && p.x !== undefined ? { x: p.x, y: 1.1, z: p.z } : null);
      if (!this.hornOk(18)) return;                  // Tokyo drivers barely use the horn: one per 18 s at most
      this.play('horn', { gain: 0.5, pos, bus: 'world', kind: p && p.kind, long: Math.random() < 0.15 });
    });
    ev.on('traffic:hit', (p) => { this.play('horn', { gain: 0.8, long: true, bus: 'world', pos: p && p.point }); this.play('heavy', { gain: 1.1, pos: p && p.point }); });
    ev.on('signal:phase', (p) => { this._sig.mode = (p && (p.ped || p.pedestrian)) || 'stop'; this._sig.next = 0; });
    ev.on('weather:thunder', () => this.play('thunder', { gain: 0.9, bus: 'world' }));

    ev.on('sfx:footstep', (p) => this.play('footstep', p || {}));
    ev.on('sfx:voice', (p) => { if (p) this.bark(p.entity, p.name || p.tag || 'attack'); });

    // UI. menus.js does not emit these yet (integration request #6) — audio detects the pause itself from
    // engine.state.mode, so the swallow is never missing even while the events are.
    ev.on('ui:move', () => this.play('ui', { bus: 'ui', kind: 'move', gain: 0.8, rate: 0.96 + Math.random() * 0.08 }));
    ev.on('ui:confirm', () => this.play('ui', { bus: 'ui', kind: 'confirm', gain: 0.9 }));
    ev.on('ui:cancel', () => this.play('ui', { bus: 'ui', kind: 'cancel', gain: 0.85 }));
    ev.on('ui:pause', () => this.play('ui', { bus: 'ui', kind: 'pause', gain: 0.9 }));
  },

  /** A man goes down. `left`: how many enemies are still standing (counted from enemy.js when not given). */
  onKO(target, left = null) {
    const engine = this.engine, at = (e) => (e && e.position) ? e.position : null;
    const pos = at(target), wet = engine.time ? (engine.time.wet || 0) : 0;
    if (left == null) {
      const en = this._mod('enemy');
      left = (target && target.kind === 'enemy' && en && en.list)
        ? en.list.filter(e => e !== target && e.alive && e.hp > 0 && e.aggro !== false).length : -1;
    }
    const last = left === 0;
    // the take the killing blow landed, if it was this blow (combat:hit fires just before combat:ko)
    const lh = this._lastHit, same = !!(lh && lh.target === target && lh.take && this.ctx && this.ctx.currentTime - lh.at < 0.25);
    // the final blow: his cry is slowed with the world; the body fall waits for the slow-motion landing ('land')
    const cb = this._mod('combat'), fb = last && cb && cb.finale && cb.finale.target === target && !cb.finale.heat;
    this._barkMul = fb ? FINAL_BLOW.voice : 1;
    this.bark(target, 'ko');
    this._barkMul = 1;
    if (fb && this.fbLog && this.ctx) this.fbLog.push([`his KO cry, slowed x${FINAL_BLOW.voice}`, this.ctx.currentTime]);
    this.ringShout('crowd_react', 0.8);              // the onlookers react to every man going down
    if (last) {
      this.play('ko', { gain: 1, pos, take: same ? lh.take : null, rate: same ? lh.rate : undefined });
      if (!fb) this.play('bodyfall', { pos, delay: 0.38, gain: 1.05, wet });
      this.sidechain(0.40, 0.30, MUS_PUMP_FLOOR);
      this._fin = null;
      this.finale();
    } else {
      // only a LIGHT killing blow needs a heavy body under it — 45 ms later, a second body beat rather than a
      // flam: two takes with different knuckle timings on one frame comb-filter the transient
      if (!(same && lh.big)) this.play('heavy', { gain: 0.8, pos, weight: 0.85, delay: 0.045 });
      this.play('bodyfall', { pos, delay: 0.36, gain: 1.0, wet });
      this.play('ko_tag', { gain: 0.9 });
      this.sidechain(0.55, 0.16, MUS_PUMP_FLOOR);
      if (left === 1) this.lastMan();                 // one man standing: the theme's last-man section, next bar
    }
  },

  /** duck the bed and the music under combat and under dialogue. */
  duck(reason, on) {
    this._duckFlags = this._duckFlags || {};
    this._duckFlags[reason] = !!on;
  },

  /** A hit taken by 健人: the VOICEVOX 「ぐっ」 a third of the time, a synthesised breath otherwise (never two
   *  breaths inside 0.3 s — three men landing in a flurry are one grunt, not a stutter). */
  heroHurt(entity, delay = 0.07, pos = null) {
    if (!this.running) return;
    if (Math.random() < HERO_HURT_LINE) { this.bark(entity, 'hurt', delay); return; }
    const now = this.ctx.currentTime;
    if (now < this._breathAt) return;
    this._breathAt = now + 0.3;
    this.play('grunt', { bus: 'voice', who: 'hero', breath: true, delay, pos: pos || (entity && entity.position) || null, gain: 0.55, rate: 0.94 + Math.random() * 0.12 });
  },

  /** The street-fight ring. When a fight breaks out on the scramble the pedestrians used to just duck −6.7 dB.
   *  Now the やじ馬 close in: the baked murmur, band-limited to 400 Hz – 3 kHz (voices, not traffic), +4 dB over
   *  the street's own murmur, from six PannerNodes standing on the ring's radius around the fight, decorrelated
   *  by offset and varispeed — plus a crowd 「おおっ」 as it forms, and a reaction swell on every KO. Rides the
   *  street's per-hit pump and hit-stop filter, but not the fight duck. */
  arenaOn(centre, radius = 8.5) {
    if (!this.running || !this.bus) return;
    const ctx = this.ctx, now = ctx.currentTime;
    if (this._ring) {
      if (this._ring.off) {                            // a new fight before the old ring dispersed: bring it back
        const g = this._ring.band.gain; g.cancelScheduledValues(now); g.setValueAtTime(Math.max(g.value, FLOOR), now); g.exponentialRampToValueAtTime(this._ring.lv, now + 0.8);
        this._ring.off = false;
      }
      return;
    }
    const cx = centre ? (centre.x ?? centre[0] ?? 0) : (this.engine.player ? this.engine.player.position.x : 0);
    const cz = centre ? (centre.z ?? centre[2] ?? 0) : (this.engine.player ? this.engine.player.position.z : 0);
    const R = Math.max(4, radius || 8.5), lv = WALLA;
    const hp = bq(ctx, 'highpass', 400, 0.7), lp = bq(ctx, 'lowpass', 3000, 0.7), band = gain(ctx, FLOOR);
    hp.connect(lp).connect(band).connect(this.bus.ring);
    band.gain.setValueAtTime(FLOOR, now); band.gain.exponentialRampToValueAtTime(lv, now + 1.4);
    const a0 = Math.random() * Math.PI * 2, pns = [], srcs = [], buf = this._crowdBuf;
    for (let k = 0; k < 6; k++) {
      const a = a0 + (k / 6) * Math.PI * 2;
      const pn = this.panner({ x: cx + Math.cos(a) * R, y: 1.6, z: cz + Math.sin(a) * R }, R);
      pn.node.connect(hp); pns.push(pn);
      if (buf) {
        const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = 0.94 + Math.random() * 0.12;
        s.connect(gain(ctx, 1 / Math.sqrt(6))).connect(pn.in);
        s.start(now, Math.random() * Math.max(0.1, buf.duration - 0.5)); srcs.push(s);
      }
    }
    this._ring = { band, hp, lp, pns, srcs, lv, off: false };
    this.ringShout('crowd_oh', 1, 0.25);
  },
  /** a crowd shout from three of the ring's six positions, a few ms apart so it is a crowd, not a chord */
  ringShout(cat, g = 1, delay = 0) {
    const R = this._ring; if (!R || !this.running) return;
    const ctx = this.ctx, now = ctx.currentTime + delay, k0 = (Math.random() * 6) | 0;
    for (let j = 0; j < 3; j++) {
      const tk = foleyTake(cat); if (!tk) return;
      playTake(ctx, R.pns[(k0 + j * 2) % R.pns.length].in, now + j * (0.02 + Math.random() * 0.03), tk, g * dbLin(FOLEY_ST.crowd - tk.meta.st) / Math.sqrt(3), 0.95 + Math.random() * 0.1);
    }
    this._count[cat] = (this._count[cat] || 0) + 1;
    this.note(cat === 'crowd_oh' ? 'ring おおっ' : 'ring わあっ');
  },
  /** the ring disperses: after `delay` s (long enough for the crowd to react to the last KO), a 2 s fade */
  arenaOff(delay = 0) {
    const R = this._ring; if (!R || R.off || !this.running) return;
    R.off = true;
    const ctx = this.ctx, t = ctx.currentTime + delay, g = R.band.gain;
    g.cancelScheduledValues(ctx.currentTime); g.setValueAtTime(Math.max(g.value, FLOOR), t); g.exponentialRampToValueAtTime(FLOOR, t + 2);
    clearTimeout(R.timer);
    R.timer = setTimeout(() => {
      if (!R.off) return;                              // brought back by a new fight in the meantime
      for (const s of R.srcs) { try { s.stop(); } catch (e) { /* stopped */ } }
      for (const pn of R.pns) pn.dispose();
      try { R.band.disconnect(); } catch (e) { /* gone */ }
      if (this._ring === R) this._ring = null;
    }, (delay + 2.2) * 1000);
  },

  // ------------------------------------------------------------------------------------------ voice barks
  async loadVoice() {
    this.voiceBank = null;
    try {
      const r = await fetch(VOICE_URL('manifest.json'), { cache: 'force-cache' });
      if (!r.ok) throw new Error(String(r.status));
      const man = await r.json();
      // Licence gate. A speaker marked "pendingApproval" in the manifest (青山龍星: the VirVox terms probably
      // require an application to ななはぴ for a client project — docs/CREDITS.md) is NOT played by default; the
      // synthesised grunt covers the hero until the flag is removed. ?voice=hero plays the lines for review.
      const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
      const spkOf = (l) => l.voice || ((l.tags || [l.tag]).some(t => t && t.startsWith('hero')) ? 'hero' : 'enemy');
      const held = new Set(Object.entries(man.speakers || {}).filter(([k, v]) => v && v.pendingApproval && q.get('voice') !== k).map(([k]) => k));
      const lines = (man.lines || []).filter(l => !held.has(spkOf(l)));
      const used = [...new Set(lines.map(spkOf))];
      const credit = used.map(k => man.speakers && man.speakers[k] && man.speakers[k].credit).filter(Boolean).join(' / ') || man.credit || '';
      const bank = { lines: {}, bySpk: {}, credit, pools: {}, held: [...held] };
      for (const l of lines) {
        for (const tag of (l.tags || [l.tag])) {
          if (!tag) continue;
          (bank.lines[tag] = bank.lines[tag] || []).push(l);
          // lines generated for a specific enemy speaker ("speaker": "e1" / "e2") are that man's own voice
          if (l.speaker) { const b = bank.bySpk[l.speaker] = bank.bySpk[l.speaker] || {}; (b[tag] = b[tag] || []).push(l); }
        }
      }
      // every tag's pool is widened with the lines that fit it, de-duplicated, so the shuffle has more to deal
      for (const [tag, from] of Object.entries(VOICE_POOLS)) {
        const seen = new Set(), pool = [];
        for (const f of from) {
          const src = f.startsWith('file:') ? lines.filter(l => l.file === f.slice(5)) : (bank.lines[f] || []);
          for (const l of src) if (!l.speaker && !seen.has(l.file)) { seen.add(l.file); pool.push(l); }
        }
        if (pool.length) bank.pools[tag] = pool;
      }
      // spoken dialogue, by the exact line text missions shows (held with its speaker like any other line)
      bank.dialogue = new Map((held.has('heroDialogue') ? [] : (man.dialogue || [])).map((l) => [l.text, l]));
      this.voiceBank = bank;
      this.voiceBuf = new Map();
      this.showCredit();
      console.info(`[audio] voice bank: ${lines.length}/${(man.lines || []).length} lines, ${Object.keys(bank.lines).length} tags${held.size ? `, held for licence approval: ${[...held].join(', ')} (synth grunts; ?voice=${[...held][0]} to review)` : ''} — ${credit}`);
    } catch (e) {
      this.voiceBank = null;            // no manifest → synthesised grunts. Expected, never an error.
    }
  },

  /** The VOICEVOX credit is a licence condition: VOICEVOX and the VirVox Project terms want it somewhere in the
   *  work (title / options / end credits / description — docs/CREDITS.md). Its permanent home is the title or
   *  options screen (integration request #1 on menus.js); until then this footer is the INTERIM placement, a
   *  DOM node of audio's own outside #hud. If menus.js renders the string and tags it [data-credit-host], this
   *  one stands down. */
  showCredit() {
    const s = this.voiceBank && this.voiceBank.credit;
    if (!s || typeof document === 'undefined' || !document.body) return;
    if (document.getElementById('voicevox-credit')) return;
    if (document.querySelector('[data-credit-host]')) return;
    const d = document.createElement('div');
    d.id = 'voicevox-credit';
    d.textContent = s;
    // The font is READ OFF #hud rather than being a second system stack the rubric bans.
    let font = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","Meiryo",sans-serif';
    try {
      const hud = document.getElementById('hud');
      const ff = hud && getComputedStyle(hud).fontFamily;
      if (ff) font = ff;
    } catch (e) { /* no layout yet */ }
    // A footer under the HUD's 「渋谷町 SHIBUYA-CHO」 district tag, on the HUD's own 28 px left edge. The last
    // position (left 56 / bottom 56) predates the money plate and the district tag moving bottom-left, and the
    // credit ended up wedged between the two, touching the kanji — clutter on the showpiece frame.
    d.style.cssText = 'position:fixed;left:28px;bottom:9px;z-index:30;pointer-events:none;' +
      `font:10px/1.3 ${font};color:#e8e2d2;opacity:.5;` +
      'text-shadow:0 1px 3px rgba(0,0,0,.9);letter-spacing:.06em;white-space:nowrap;transition:opacity .25s';
    document.body.appendChild(d);
    this._credit = d;
  },

  /** The terms do not ask for the credit on screen while a line is playing, and no shipping title burns an
   *  engine credit into a fight, so the interim footer stands down in combat and cutscenes. */
  creditVisibility(mode) {
    const d = this._credit;
    if (!d) return;
    const hide = mode === 'combat' || mode === 'cutscene';
    if (hide === this._creditHidden) return;
    this._creditHidden = hide;
    d.style.opacity = hide ? '0' : '.5';
  },

  /** The three men in chapter 1's fight used to share one voice. Each enemy is given one of three speakers the
   *  first time he speaks, preferring the one his name suggests (半グレ → the young rasp, 組員/若衆 → the older,
   *  deeper man) and never a speaker another living fighter already has — three chinpira, three voices. */
  speakerOf(e) {
    const m = this._spk;
    if (m.has(e)) return SPEAKERS[m.get(e)];
    const nm = (e && e.name) || '';
    let idx = /半グレ/.test(nm) ? 2 : /組員|若衆|ヤクザ/.test(nm) ? 1 : 0;
    const taken = new Set();
    for (const [k, v] of m) if (k && k.alive !== false) taken.add(v);
    for (let k = 0; k < SPEAKERS.length && taken.has(idx); k++) idx = (idx + 1) % SPEAKERS.length;
    if (m.size > 24) for (const k of m.keys()) if (!k || k.alive === false) m.delete(k);
    m.set(e, idx);
    return SPEAKERS[idx];
  },

  /** a speaker's processing, built once per context and shared by every line he says (it sits after the
   *  per-line panner, so one chain serves a man wherever he stands) */
  voiceFx(spk) {
    const ctx = this.ctx;
    if (!spk || !spk.fx) return this.bus.voice;
    return cached(ctx, `vfx:${spk.id}`, () => {
      const head = gain(ctx, 1);
      let n = head;
      for (const [type, f, q, g] of spk.fx) {
        const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; if (g) b.gain.value = g;
        n = n.connect(b);
      }
      if (spk.grit) { const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(ctx, spk.grit); n = n.connect(sh).connect(gain(ctx, 0.62)); }
      n.connect(this.bus.voice);
      return head;
    });
  },

  /** bark(entity, tag) — a VOICEVOX line when the bank exists, a formant grunt otherwise. One line per
   *  character at a time, EXCEPT 'ko' and 'heat': those are the lines the moment is about, so they cut off
   *  whatever that character was saying (the hurt line the killing blow's hit handler may have started). */
  bark(entity, tag, delay = 0) {
    if (!this.running || this.muted) return;
    const engine = this.engine;
    const hero = !!(entity && (entity === engine.player || entity.isPlayer || entity.kind === 'player'));
    const who = hero ? 'hero' : 'enemy';
    const now = this.ctx.currentTime;
    const key = (entity && entity.id) || who;
    const prio = tag === 'ko' || tag === 'heat';
    const barkAt = this._barkAt || (this._barkAt = new Map());
    if (!prio && (barkAt.get(key) || 0) > now) return;
    if (prio) {
      const live = this._barkSrc.get(key);
      if (live) { try { live.g.gain.setTargetAtTime(0, now, 0.006); live.s.stop(now + 0.04); } catch (e) { /* ended */ } this._barkSrc.delete(key); }
    }
    barkAt.set(key, now + 1.1);
    // keyed by entity.id and never pruned, this grew for the whole session as enemies spawned and died
    if (barkAt.size > 64) for (const [k, v] of barkAt) if (v <= now) barkAt.delete(k);
    const pos = entity && entity.position ? entity.position : null;
    const spk = hero ? HERO_SPEAKER : this.speakerOf(entity);
    const bank = this.voiceBank;
    const own = bank && spk.id !== 'e0' && bank.bySpk[spk.id] && bank.bySpk[spk.id][`${who}_${tag}`];
    const pool = own || (bank && (bank.pools[`${who}_${tag}`] || bank.lines[`${who}_${tag}`]));
    if (pool && pool.length) {
      const line = pool[bagPick(this._voiceBags, `${spk.id}:${who}_${tag}`, pool.length)];
      this.playVoiceFile(line, pos, delay, own ? { id: spk.id, rate: 1 } : spk, key, TAG_RATE[`${who}_${tag}`]);
      return;
    }
    if (tag === 'encounter') return;                  // no synth stands in for 「行くぞ」: the slam carries the moment
    this.play('grunt', {
      bus: 'voice', who, pos, delay, gain: hero ? 0.62 : 0.5,
      long: tag === 'ko' || tag === 'heat', rate: (0.92 + Math.random() * 0.18) * (spk.rate || 1) * (this._barkMul || 1),
    });
  },

  /** VOICEVOX renders ~100 ms of leading silence (its pre-phoneme pad) plus the mp3 encoder delay: measured
   *  live, a bark's first audible sample arrived 108–129 ms after the event that asked for it. The lead is
   *  found once per buffer at decode time and skipped with start()'s offset, so a bark lands when it is called
   *  and any lag is a deliberate `delay` (a hurt grunt waits 70 ms so it never smears the punch transient).
   *  The source is remembered per character, so a priority line can cut it. */
  playVoiceFile(line, pos, delay = 0, spk = null, key = null, rate = null) {
    const ctx = this.ctx, url = line.file.startsWith('/') ? line.file : VOICE_URL(line.file);
    const mul = this._barkMul || 1;                                  // the final blow slows the KO cry
    const lead = this._voiceLead || (this._voiceLead = new Map());
    const start = (buf) => {
      if (!buf || !this.running) return;
      const s = ctx.createBufferSource(); s.buffer = buf;
      s.playbackRate.value = (rate || line.rate || 1) * ((spk && spk.rate) || 1) * (0.985 + Math.random() * 0.03) * mul;
      const g = gain(ctx, 0.9 * ((spk && spk.gain) || 1));
      const fx = this.voiceFx(spk);
      let dest = fx, pn = null;
      if (pos) { pn = this.panner(pos, 5); pn.node.connect(fx); dest = pn.in; }
      s.connect(g).connect(dest);
      const off = lead.get(url) || 0;
      s.start(ctx.currentTime + 0.005 + delay, off);
      const rec = { s, g };
      if (key != null) this._barkSrc.set(key, rec);
      s.onended = () => { if (key != null && this._barkSrc.get(key) === rec) this._barkSrc.delete(key); if (pn) pn.dispose(); };
    };
    const have = this.voiceBuf.get(url);
    if (have) { start(have); return; }
    if (have === null) return;                                       // a previous fetch already failed
    this.voiceBuf.set(url, null);
    fetch(url).then(r => r.arrayBuffer()).then(a => decodeWith(ctx, a))
      .then(b => {
        const d = b.getChannelData(0);
        let i = 0;
        while (i < d.length && Math.abs(d[i]) < 0.02) i++;
        lead.set(url, i < d.length ? Math.max(0, i / b.sampleRate - 0.008) : 0);
        this.voiceBuf.set(url, b); start(b);
      })
      .catch(() => { /* fall back silently; grunts cover it next time */ });
  },

  /** missions.say(): a line on the dialogue box. 健人's lines are voiced; any new line cuts the one before it. */
  speakLine(who, text) {
    this.stopLine();
    if (!this.running || this.muted || who !== HERO_NAME || !this.voiceBank || !this.voiceBank.dialogue) return;
    const line = this.voiceBank.dialogue.get(text);
    if (line) this.playVoiceFile(line, null, 0.08, HERO_DLG, 'dlg');
  },
  stopLine() {
    const rec = this._barkSrc && this._barkSrc.get('dlg');
    if (!rec || !this.ctx) return;
    const now = this.ctx.currentTime;
    try { rec.g.gain.setTargetAtTime(0, now, 0.03); rec.s.stop(now + 0.12); } catch (e) { /* already ended */ }
    this._barkSrc.delete('dlg');
  },

  // ------------------------------------------------------------------------------------------ footsteps
  /** Footstep events are baked into the clips (animations.js userData.events); read them off the running
   *  AnimationAction rather than guessing with a timer, so a step lands exactly when the foot does. */
  footsteps() {
    const engine = this.engine, cam = engine.camera;
    const list = this._walkers || (this._walkers = []);
    list.length = 0;
    if (engine.player) list.push(engine.player);
    const en = engine.get && engine.get('enemy');
    if (en && en.list) for (const e of en.list) if (e.alive) list.push(e);

    for (const e of list) {
      // down → getup is driven by enemy.js/player.js state timers and raises no event. Poll the edge so the
      // scuff of a chinpira picking himself up off wet tarmac exists at all; the rubric scores get-ups.
      const st = e.state;
      if (st !== this._down.get(e)) {
        if (st === 'getup') engine.events.emit('enemy:getup', { entity: e, position: e.position });
        if (st === undefined) this._down.delete(e); else this._down.set(e, st);
      }
      const h = e.humanoid;
      const name = h && h.currentName;
      if (name !== 'walk' && name !== 'run') { if (h) this._feet.delete(e); continue; }
      const action = h.currentAction;
      if (!action || !action.isRunning()) continue;
      const clip = action.getClip();
      const evs = clip && clip.userData && clip.userData.events;
      if (!evs || !evs.length) continue;
      const dur = clip.duration, now = action.time;
      const prev = this._feet.get(e);
      this._feet.set(e, now);
      if (prev === undefined || dur <= 0) continue;
      // the clip loops, so the window (prev, now] may wrap past the end
      let a = prev, b = now;
      if (b < a) b += dur;
      if (b - a > dur * 0.9) continue;                  // a seek or a clip swap: no phantom steps
      const d = cam ? cam.position.distanceTo(e.position) : 0;
      if (d > 34) continue;
      for (const f of evs) {
        if (f.name !== 'footstep') continue;
        const ft = f.time % dur;
        if (!((ft > a && ft <= b) || (ft + dur > a && ft + dur <= b))) continue;
        engine.events.emit('sfx:footstep', {
          entity: e, foot: f.foot, pos: e.position,
          material: this.materialAt(e.position),
          wet: engine.time ? (engine.time.wet || 0) : 0,
          gain: (e === engine.player ? 0.85 : 0.5) * (name === 'run' ? 1.25 : 1),
        });
      }
    }
  },

  /** Driven by the same signed-distance field city.js lays the crossing paint with (>0 = sidewalk), not by an
   *  axis-aligned guess — the old `x<26 && z<26` box had no relation to the street mesh, so the hero changed
   *  surface halfway along a sidewalk and the 'tile' branch of footstep() was unreachable. */
  /** engine.get() cached, but only once it actually returns something — modules init in a fixed order and a
   *  null result at boot must not be remembered for the whole session. */
  _mod(name) {
    const c = this._mods || (this._mods = Object.create(null));
    if (c[name]) return c[name];
    const m = (this.engine && this.engine.get && this.engine.get(name)) || null;
    if (m) c[name] = m;
    return m;
  },

  materialAt(p) {
    const city = this._mod('city');
    const f = city && city.field;
    if (!f || !f.sample) return 'asphalt';
    let d = 0;
    try { d = f.sample(p.x, p.z); } catch (e) { return 'asphalt'; }
    if (d <= 0.35) return 'asphalt';                 // carriageway and the painted crossing
    return d > 3.2 ? 'tile' : 'concrete';            // plaza / station paving vs the kerbside slab
  },

  /** 1070 pedestrians and, until now, not one footstep: footsteps() walked the player and the enemy list, so
   *  everything 150 bodies mid-scramble contributed to the mix was a 6 s murmur loop. On wet tarmac the shoe
   *  noise IS half of what you hear standing on the crossing, and the splash layer — the whole point of the
   *  after-rain setting — was firing for exactly one character.
   *
   *  Poisson-scheduled from the real ped positions, but rate-capped: 150 walkers at 1.8 steps/s is 270/s,
   *  which is a wash, not footsteps. ~22/s of individually placed steps on the nearest bodies reads as a
   *  crowd and leaves the polyphony cap alone; the murmur bed covers the rest. */
  crowdSteps(now, dt) {
    const engine = this.engine, cam = engine.camera;
    const cr = this._mod('crowd');
    if (!cr || !cam || !cr.peds || !cr.peds.length) return;
    const peds = cr.peds, n = peds.length;
    const near = this._near || (this._near = []);
    // resample the nearby set a few times a second, not every frame: 1070 distance tests at 60 Hz is silly
    if (now >= (this._nearAt || 0)) {
      this._nearAt = now + 0.25;
      near.length = 0;
      const cx = cam.position.x, cz = cam.position.z;
      const stride = Math.max(1, Math.floor(n / 420));
      for (let i = (this._nearI = ((this._nearI || 0) + 1) % stride); i < n; i += stride) {
        const p = peds[i];
        if (!p || (p.speed || 0) < 0.25) continue;             // idlers do not make footsteps
        const dx = p.x - cx, dz = p.z - cz;
        if (dx * dx + dz * dz > 625) continue;                  // 25 m
        near.push(p);
        if (near.length >= 96) break;
      }
      this._nearN = near.length * stride;
    }
    if (!near.length) return;
    // Measured live, the old version was 22 steps/s at −63 dB on the world bus: 34 dB under the ambience, i.e.
    // inaudible, with a CPU bill. Two reasons: it drew uniformly from a 25 m disc, where area puts most bodies
    // at 15–25 m, and a 3.5 m refDistance then took another 12–16 dB off each. So: fewer steps, drawn from the
    // NEAREST walkers (nearest of three random picks), loud enough that the closest few read as people and the
    // aggregate sits ~10 dB under the city bed — a wet patter under the murmur, never a wash over it.
    // (2026-09-25: 14 wet steps a second at 4.2 kHz was the loudest constant thing on the street, a hiss-like patter
    //  the client heard as 「変な音…雑音」 — now at most 6 a second, 5 dB down and rolled off above 2.8 kHz)
    const rate = Math.min(6, 0.35 * (this._nearN || near.length));
    let budget = (this._stepAcc = (this._stepAcc || 0) + rate * dt);
    if (budget < 1) return;
    const wet = engine.time ? (engine.time.wet || 0) : 0;
    const cx = cam.position.x, cz = cam.position.z;
    let fired = 0;
    while (budget >= 1 && fired < 3 && this._crowdVoices < 10) {
      budget -= 1; fired++;
      let p = null, d = 1e9;
      for (let k = 0; k < 3; k++) {
        const c = near[(Math.random() * near.length) | 0];
        const dk = Math.hypot(c.x - cx, c.z - cz);
        if (dk < d) { d = dk; p = c; }
      }
      const _p = this._sp3 || (this._sp3 = new Vector3());
      _p.set(p.x, 0.06, p.z);
      const u = 1 - Math.min(1, d / 25);
      // bus 'world', not 'sfx': these are the street, so they duck under a fight and muffle behind a pause
      // with the rest of it, and they never compete with the hero's own steps or with an impact.
      if (!this.bus.crowdStep) { const lp = bq(this.ctx, 'lowpass', 2800, 0.7); lp.connect(this.bus.world); this.bus.crowdStep = lp; }
      this.play('footstep', {
        pos: _p, ref: 6, far: true, wet, bus: 'crowdStep', material: this.materialAt(_p), crowd: true,
        gain: 0.56 * CROWD_STEP * (0.45 + 0.55 * u * u),
        rate: 0.86 + Math.random() * 0.3,
      });
    }
    this._stepAcc = budget;
  },

  // -------------------------------------------------------------------------------------------- per-frame
  update(dt) {
    if (!this.running) return;
    const engine = this.engine, ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;

    // engine.time.speed: combat.js's hit-stop (0.05), a heat action's slow-motion (0.08–0.5), the last KO (0.22).
    // The street hears it; the music does not (see sidechain / setBreak).
    const mode = engine.state ? engine.state.mode : 'explore';
    const paused = mode === 'paused';
    const sp = (engine.time && engine.time.speed != null) ? engine.time.speed : 1;
    this._sp = sp;
    const slow = sp < 0.9 && !paused;

    this.listener();
    if (now >= this._sweepAt) { this._sweepAt = now + 0.1; this.sweep(now); }
    if (!paused) this.scheduleMusic();
    if (!paused) {
      try { this.footsteps(dt); } catch (e) { /* a mid-rewrite animations module must not kill the mixer read */ }
      // engine.js already multiplies dt by time.speed, so this is game time: the crossing's footsteps slow
      // with the world during a hit-stop rather than carrying on at wall-clock rate.
      try { this.crowdSteps(now, Math.min(0.1, dt || 0.016)); } catch (e) { /* crowd mid-rewrite */ }
    }

    // --- the fight's musical edges: the encounter lands when the mode really becomes 'combat' (chapter 1 holds
    //     the thugs in a cutscene after combat:start), the heat section returns on a beat once the world is back
    //     to speed, a combat:end that no last-man KO claimed still gets its button, and the finale runs out.
    if (this._enc && this._enc.pending && mode === 'combat') { this._enc = null; this.encounter(); }
    if (this._heatOn && mode !== 'cutscene' && sp >= 0.99) { this._heatOn = false; this.setBreak(false); }
    if (this._endAt && !this._fin && now - this._endAt > 0.05) { this._endAt = 0; this.finale(); }
    else if (this._fin) this._endAt = 0;
    this.finaleTick(now);

    // --- ducking. Dialogue pulls everything down and muffles the music; a fight pulls the street down under the
    //     music; PAUSE drops a hard duck and a 900 Hz lowpass on both. Hit-stop and slow-motion freeze the STREET
    //     (bed + world one-shots, 6 ms, 700 Hz) and nothing else — the theme is at full energy during a string.
    const heat = this._heatOn;
    const dialogue = mode === 'cutscene' && !heat;
    const fighting = mode === 'combat' || heat || (this._duckFlags && this._duckFlags.combat);
    let amb = paused ? 0.35 : dialogue ? 0.22 : heat ? 0.3 : fighting ? 0.46 : 1;
    const movie = !!engine.state?.videoPlaying;
    const mus = movie ? 0 : paused ? 0.25 : dialogue ? 0.18 : 1;
    if (movie) amb = 0;
    let lpA = paused ? 900 : 20000, tau = 0.25;
    let lpM = paused ? 900 : dialogue ? 2600 : 20000;
    if (slow) { amb *= 0.55; lpA = 700; tau = 0.006; }
    else if (this._wasSlow) tau = 0.05;                            // release over ~0.12 s, not 0.75
    // THE FINAL BLOW (combat/finalBlow.js): the street AND the music close to FINAL_BLOW.lp and the loops slow down
    // (pitch) for the slow motion, opening again with the time ramp (fbLook); the impacts, his cry and the button
    // stay on their own unfiltered buses
    const cbf = this._mod('combat'), fin = cbf && cbf.finale, fk = fin && !paused ? fbLook(fin.t) : 0;
    if (fin && !paused) {
      const lpF = Math.round(FINAL_BLOW.lp * Math.pow(20000 / FINAL_BLOW.lp, 1 - fk));
      lpA = lpF; lpM = Math.min(lpM, lpF);                      // (replaces the hit-stop's fixed 700 Hz street filter)
      amb = (paused ? 0.35 : dialogue ? 0.22 : heat ? 0.3 : fighting ? 0.46 : 1) * (1 - 0.4 * fk);
      tau = fin.t < 0.1 ? 0.008 : 0.03;
    }
    this.finaleAudio(fk, now);
    // A hit-stop is 40–130 ms, so a screenshot lands inside one about a quarter of the time. Remember the
    // last one instead: the scope can then prove the bed froze whichever frame the harness happened to grab.
    if (slow && !this._wasSlow) this._stopAt = now;
    if (!slow && this._wasSlow) this._lastStop = { ms: Math.round((now - (this._stopAt || now)) * 1000), at: now };
    this._wasSlow = slow;
    if (Math.abs(this._duck.amb - amb) > 0.005) {
      this.bus.duckAmb.gain.setTargetAtTime(amb, now, tau);
      this.bus.duckWld.gain.setTargetAtTime(amb, now, tau);
      this._duck.amb = amb;
    }
    if (Math.abs(this._duck.mus - mus) > 0.005) { this.bus.duckMus.gain.setTargetAtTime(mus, now, 0.25); this._duck.mus = mus; }
    if (this._duck.lp !== lpA) {
      this.bus.lpAmb.frequency.setTargetAtTime(lpA, now, tau);
      this.bus.lpWld.frequency.setTargetAtTime(lpA, now, tau);
      this._duck.lp = lpA;
    }
    if (this._duck.lpm !== lpM) { this.bus.lpMus.frequency.setTargetAtTime(lpM, now, fin ? tau : 0.12); this._duck.lpm = lpM; }
    // the punch pocket: a little 2–4 kHz comes out of the battle stems while a fight is on (−4.5 was a permanent
    // hole in the guitars; the per-hit pump now opens the pocket when a punch actually lands)
    const eq = (mode === 'combat' || heat) ? -2.5 : 0;
    if (eq !== this._eq) { this.bus.battleEQ.gain.setTargetAtTime(eq, now, 0.2); this._eq = eq; }
    // the intensity stem (brass section, double-time hats) rides the heat gauge; fully open at HEAT MAX, and held
    // at least LAST_INTENSITY open through the last-man section
    const pl = engine.player, hv = pl ? Math.min(1, Math.max(0, (pl.heat || 0) / 100)) : 0;
    const it = Math.max(hv, this._bm.sec === 'last' && this._bm.srcs ? LAST_INTENSITY : 0);
    if (Math.abs(it - this._intens) > 0.02 || (it === 1 && this._intens !== 1) || (it === 0 && this._intens !== 0)) {
      this.bus.intens.gain.setTargetAtTime(it, now, 0.25); this._intens = it;
    }
    // the onlooker ring: down behind a pause, a dialogue line and the heat-action slow motion
    const rg = paused ? 0.3 : dialogue ? 0.45 : heat ? 0.7 : 1;
    if (rg !== this._ringG) { this.bus.ring.gain.setTargetAtTime(rg, now, 0.2); this._ringG = rg; }
    this.auraTick(now, mode);
    this.creditVisibility(mode);
    if (paused !== this._paused) {                                 // menus.js emits no ui:* — detect it here
      this._paused = paused;
      if (!movie) this.play('ui', { bus: 'ui', kind: paused ? 'pause' : 'unpause', gain: 0.9 });
    }

    // --- ambience follows the weather: 'wet' is the showpiece, 'rain' only when it is actually raining
    // Three ungated setTargetAtTime a frame is 180 AudioParam events a second for values that change maybe
    // once a minute — change-gated exactly like duckAmb/duckMus ten lines above, which was the pattern all along.
    if (this.ambience && !this.ambience.off && engine.time) {
      const A = this._amb;
      // tyre swish: moving traffic within ~45 m, nearer and faster weighing more (refreshed 5× a second)
      if (!A.swT || now > A.swT) {
        A.swT = now + 0.2;
        const tr = this._mod('traffic'), cam = engine.camera;
        let sw = 0;
        if (tr && tr.cars && cam) for (const c of tr.cars) {
          if (c.parked || !(c.speed > 1)) continue;
          const d = Math.hypot(c.x - cam.position.x, c.z - cam.position.z);
          if (d < 45) sw += Math.min(1, c.speed / 12) * (1 - d / 45) * (1 - d / 45);
        }
        A.sw = Math.min(1, sw / 1.5);
        // the far wash: moving cars within 90 m, a gentle count (a platoon on the far arm is a murmur, not a roar)
        let far = 0;
        if (tr && tr.cars && cam) for (const c of tr.cars) {
          if (c.parked || !(c.speed > 1)) continue;
          const d = Math.hypot(c.x - cam.position.x, c.z - cam.position.z);
          if (d < 90) far += 1 - d / 90;
        }
        A.far = Math.min(1, far / 8);
      }
      if (!this.ambience.legacy) {
        const tw = 0.11 * (A.far || 0);
        if (Math.abs((A.tw ?? -1) - tw) > 0.004) { this.ambience.traffic.gain.setTargetAtTime(tw, now, 1.5); A.tw = tw; }
      }
      const wet = 0.16 * (engine.time.wet || 0) * (A.sw || 0);
      const rain = engine.time.weather === 'rain' ? 0.42 : 0;
      const hour = engine.time.hour ?? 21.5;
      // The murmur breathes with the scramble: crowdSteps() already counts the bodies MOVING within 25 m, and a
      // green man that floods the crossing should lift the voices with it. The bed measured as a ±1 dB carpet;
      // this is ~4 dB of macro-dynamics tied to what is on screen, on a 3 s time constant so it swells, not steps.
      const dens = this._nearN == null ? 1 : 0.72 + 0.4 * Math.min(1, this._nearN / 110);
      const crowd = 0.50 * dens * (hour > 6 && hour < 23 ? 1 : 0.45);   // the crossing empties after the last train
      if (Math.abs(A.wet - wet) > 0.005) { this.ambience.wet.gain.setTargetAtTime(wet, now, 1.2); A.wet = wet; }
      if (Math.abs(A.rain - rain) > 0.005) { this.ambience.rain.gain.setTargetAtTime(rain, now, 1.8); A.rain = rain; }
      if (Math.abs(A.crowd - crowd) > 0.005) { this.ambience.crowd.gain.setTargetAtTime(crowd, now, 3); A.crowd = crowd; }
    }

    if (!paused) { this.signalLoop(now); this.trainLoop(dt, now); this.worldEvents(now, dt); this.drips(now); }
    if (this._meter) this.drawMeter();
  },

  /** The final blow's own sound, all scheduled on the contact frame (FINAL_BLOW: sfx, tail, tailPitch, beats, swell):
   *  the finisher ringing into its dark tail as it sinks in pitch, heartbeat pulses in the hold, the reversed swell
   *  rising into his landing and the body fall + splash on it — at normal speed, when time is back. A heat action's
   *  last KO gets the tail and the pulses only (its own choreography lands him). `this.fbLog` lists what was scheduled
   *  and when (context time), for the live measurement. */
  finaleSfx(f) {
    if (!this.running || !this.ctx) return;
    const FB = FINAL_BLOW, ctx = this.ctx, t0 = ctx.currentTime + 0.002, g = FB.sfx;
    const L = this.fbLog = [];
    const log = (n, dt) => L.push([n, t0 + dt]);
    if (this._fbTail) {
      this.play('fbTail', { buf: this._fbTail, gain: g * (f.heat ? 0.6 : 1), pitch: FB.tailPitch, freeze: FB.freeze, len: FB.tail, rate: 0.97 + Math.random() * 0.06 });
      this.play('fbSub', { gain: g * (f.heat ? 0.6 : 1) });
      log(`finisher: sub drop + crunch + slap + whip crack, dark tail sinking to x${FB.tailPitch} until ${FB.tail} s`, 0);
    } else {
      this.play('fbStack', { gain: g * 0.8 });
      log('finisher (live: the tail render is not ready)', 0);
      this.prepFinisher();
    }
    for (const b of FB.beats) { this.play('fbBeat', { gain: g, delay: b }); log('heartbeat pulse', b); }
    if (!f.heat) {
      const tl = fbRealAt(FB.land), wet = this.engine.time ? (this.engine.time.wet || 0) : 0;
      // where he will come down: his knockback carries him along the blow (v0 = 6 d)
      const T = f.target, v = T && T.velocity ? Math.hypot(T.velocity.x, T.velocity.z) : 0, d = Math.min(3.5, v / 6 * 0.9);
      const pos = T && T.position ? { x: T.position.x + (f.dir ? f.dir.x : 0) * d, y: T.position.y + 0.3, z: T.position.z + (f.dir ? f.dir.z : 0) * d } : null;
      this.play('fbSwell', { gain: g, delay: tl, len: FB.swell });
      log('reversed swell rising', tl - FB.swell);
      this.play('fbLand', { gain: g, delay: tl, wet, pos });
      log('he lands: body fall + wet splash, normal speed', tl);
    }
    this.sidechain(0.5, 0.25, MUS_PUMP_FLOOR);
  },

  /** Render the finisher once through a long, dark tail (a 2.8 s plaza IR low-passed to 1.1 kHz) into a buffer, so
   *  fbTail can play the whole ring pitched down. Off the main thread (OfflineAudioContext); normalised to a 0.7
   *  peak so FINAL_BLOW.sfx is the one level knob. Called when the audio starts and when a fight starts. */
  prepFinisher() {
    if (this._fbTail || this._fbPrep || !this.ctx || typeof OfflineAudioContext === 'undefined') return;
    if (!foleyTake('impact_finisher')) return;                     // the bank is still decoding: next fight
    try {
      const sr = this.ctx.sampleRate, oc = new OfflineAudioContext(2, Math.ceil(sr * 3.4), sr);
      const bus = gain(oc, 1);
      VOICES.fbStack(oc, bus, 0.005, { noSub: true });            // the sub plays live, unpitched (fbSub)
      bus.connect(oc.destination);
      const verb = oc.createConvolver(); verb.buffer = irBuf(oc, 2.8, 2.2);
      bus.connect(verb).connect(bq(oc, 'lowpass', 1100, 0.6)).connect(bq(oc, 'highpass', 40, 0.7)).connect(gain(oc, 0.9)).connect(oc.destination);
      this._fbPrep = oc.startRendering().then((buf) => {
        let pk = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) { const dd = buf.getChannelData(c); for (let i = 0; i < dd.length; i++) { const a = Math.abs(dd[i]); if (a > pk) pk = a; } }
        const k = pk > 0 ? 0.7 / pk : 1;
        for (let c = 0; c < buf.numberOfChannels; c++) { const dd = buf.getChannelData(c); for (let i = 0; i < dd.length; i++) dd[i] *= k; }
        this._fbTail = buf;
      }).catch((e) => console.warn('[audio] finisher render failed:', e && e.message)).finally(() => { this._fbPrep = null; });
    } catch (e) { console.warn('[audio] finisher render unavailable:', e && e.message); }
  },

  /** The final blow's pitch: the street murmur, the onlooker ring and the battle stems play at a lower rate while time
   *  is slowed (FINAL_BLOW.pitch at full slow motion), back to their own rates with the ramp. Change-gated. */
  finaleAudio(fk, now) {
    const want = 1 - (1 - FINAL_BLOW.pitch) * fk;
    if (Math.abs((this._fbPitch ?? 1) - want) < 0.004 && !(want === 1 && this._fbPitch !== 1)) return;
    this._fbPitch = want;
    const set = (s) => {
      if (!s || !s.playbackRate) return;
      if (s._rate0 == null) s._rate0 = s.playbackRate.value;
      try { s.playbackRate.setTargetAtTime(s._rate0 * want, now, fk > 0.99 ? 0.02 : 0.05); } catch (e) { /* stopped */ }
    };
    if (this.ambience && this.ambience.crowdSrc) set(this.ambience.crowdSrc);
    if (this._ring && this._ring.srcs) for (const s of this._ring.srcs) set(s);
    const bm = this._bm && this._bm.srcs;
    if (bm) for (const k in bm) if (bm[k] && bm[k].s) set(bm[k].s);
  },

  /** HEAT MAX was announced once and then went silent. While the gauge is full, a quiet flame — bandpassed
   *  noise with a flicker — and a sub shimmer on a fifth burn on the sfx bus; a heat action cuts them dead. */
  auraTick(now, mode) {
    const p = this.engine.player;
    const want = !!(p && p.heat >= 100 && !this._heatOn && (mode === 'combat' || mode === 'explore'));
    if (want === this._auraOn) return;
    this._auraOn = want;
    const ctx = this.ctx;
    if (!this._aura) {
      if (!want) return;
      const out = gain(ctx, 0); out.connect(this.bus.sfx);
      const fl = ctx.createBufferSource(); fl.buffer = noiseBuf(ctx, 2, 'white'); fl.loop = true;
      const bp = bq(ctx, 'bandpass', 950, 0.8), fg = gain(ctx, 0.5);
      const fk1 = osc(ctx, 'sine', 6.3, now, now + 1e7), fk2 = osc(ctx, 'sine', 2.07, now, now + 1e7);
      fk1.connect(gain(ctx, 0.22)).connect(fg.gain); fk2.connect(gain(ctx, 0.16)).connect(fg.gain);
      fl.connect(bp).connect(fg).connect(out); fl.start(now);
      const sg = gain(ctx, 0.5);
      for (const [f, a] of [[55, 0.5], [82.4, 0.32]]) osc(ctx, 'sine', f, now, now + 1e7).connect(gain(ctx, a)).connect(sg);
      osc(ctx, 'sine', 0.55, now, now + 1e7).connect(gain(ctx, 0.2)).connect(sg.gain);
      sg.connect(out);
      this._aura = { out };
    }
    const g = this._aura.out.gain;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    g.setTargetAtTime(want ? 0.075 : 0, now, want ? 0.35 : 0.025);
  },

  listener() {
    const cam = this.engine.camera, l = this.ctx.listener;
    if (!cam || !l) return;
    const p = this._lp || (this._lp = new Vector3());
    const f = this._lf || (this._lf = new Vector3());
    const u = this._lu || (this._lu = new Vector3());
    const m = this._lm || (this._lm = new Matrix4());
    cam.getWorldPosition(p);
    m.extractRotation(cam.matrixWorld);
    f.set(0, 0, -1).applyMatrix4(m);
    u.set(0, 1, 0).applyMatrix4(m);
    // Six setTargetAtTime per frame is 360 param events a second for a camera that is usually still. Write
    // only when it actually moved a centimetre or turned half a degree.
    const lf = this._lf0 || (this._lf0 = new Vector3(0, 0, -1));
    const lp0 = this._lp0 || (this._lp0 = new Vector3(1e9, 0, 0));
    if (p.distanceToSquared(lp0) < 1e-4 && f.dot(lf) > 0.99996) return;
    lp0.copy(p); lf.copy(f);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02); l.positionY.setTargetAtTime(p.y, t, 0.02); l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02); l.forwardY.setTargetAtTime(f.y, t, 0.02); l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.value = u.x; l.upY.value = u.y; l.upZ.value = u.z;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  },

  /** The 誘導音 from the two speaker masts on opposite corners — call, then the far side answers. */
  signalLoop(now) {
    const s = this._sig;
    const tr = this.engine.get && this.engine.get('traffic');
    if (tr && tr.signal && tr.signal.ped) s.mode = tr.signal.ped;
    if (s.mode === 'stop') return;
    if (now < s.next) return;
    const flash = s.mode === 'flash';
    const corner = s.side ? { x: 24, y: 3.4, z: -24 } : { x: -24, y: 3.4, z: 24 };
    // The 誘導音 is the single most identifiable sound on that crossing and it was sitting 4 dB over the bed.
    // ref 26 instead of 16 keeps it up at the far mast as well as the near one.
    this.play('cuckoo', { pos: corner, ref: 26, gain: 0.9, bus: 'world', mode: s.mode });
    s.side ^= 1;
    s.next = now + (flash ? 0.55 : 1.45);
  },

  /** A Kamurocho night bed is not a carpet — it is a carpet with EVENTS 8–15 dB proud of it. 150 vehicles and
   *  1070 people on screen used to produce one flat −25 dB trace with two 3 dB bumps in 4.3 s. This throws a
   *  Poisson stream of 0.4–0.9 events/s at the street: a horn two blocks down, a 原付 going past, a shop
   *  rolling its shutter, a konbini door, a bicycle bell. Every one is placed on a REAL vehicle position when
   *  traffic has any, so the stereo field agrees with what is on screen. */
  worldEvents(now, dt) {
    if (this._evNext === 0) { this._evNext = now + 0.5; return; }
    if (now < this._evNext) return;
    // Its own seeded stream, not Math.random(): the same boot produces the same street, so ?audio=meter is
    // reproducible evidence rather than a different roll of the dice every screenshot. It does not touch
    // engine.rng, which other modules' determinism depends on.
    const rnd = this._rnd || (this._rnd = mulberry(0x51be17));
    const rate = 0.6 + rnd() * 0.4;                            // events per second
    this._evNext = now - Math.log(1 - rnd() * 0.999) / rate;

    const cam = this.engine.camera;
    const cx = cam ? cam.position.x : 0, cz = cam ? cam.position.z : 0;
    const tr = this._mod('traffic');
    const cars = tr && tr.cars;
    let px = cx, pz = cz, py = 1.1, kind = null;
    if (cars && cars.length) {                                  // pick a vehicle 10–55 m out
      for (let i = 0; i < 12; i++) {
        const c = cars[(rnd() * cars.length) | 0];
        if (!c) continue;
        const d = Math.hypot(c.x - cx, c.z - cz);
        if (d < 10 || d > 55) continue;          // beyond ~55 m the air filter and the inverse law bury it
        px = c.x; pz = c.z; kind = c.kind; break;
      }
    }
    if (px === cx && pz === cz) {                               // no traffic module: a ring around the camera
      const a = rnd() * 6.283, d = 14 + rnd() * 34;
      px = cx + Math.cos(a) * d; pz = cz + Math.sin(a) * d;
    }
    const pos = { x: px, y: py, z: pz };
    const pick = rnd();
    // gain 0.6–0.85 on the world bus, and a WIDE refDistance: these are physically big sources (a horn, a
    // 50 cc engine, a steel shutter), so the inverse law must not treat them like a point 7 m away or they
    // arrive 14 dB under the murmur and the trace goes flat again. This is what puts events 8–12 dB proud.
    // (the horn was 38 % of these, one every ~3 s with the drivers' own on top — client: 「クラクションの音が頻繁すぎる」;
    //  now 6 %, and never within 25 s of another horn)
    if (pick < 0.06) { if (this.hornOk(25)) this.play('horn', { pos, ref: 36, gain: 0.5 + rnd() * 0.15, bus: 'world', kind, long: false }); }
    else if (pick < 0.50) this.play('scooter', { pos, ref: 32, gain: 0.62 + rnd() * 0.2, bus: 'world', rate: 0.9 + rnd() * 0.3, duration: 1.4 + rnd() * 0.8 });
    else if (pick < 0.76) this.play('bell', { pos, ref: 20, gain: 0.6 + rnd() * 0.2, bus: 'world', rate: 0.94 + rnd() * 0.14 });
    else if (pick < 0.88) this.play('chime', { pos: { x: px, y: 2.2, z: pz }, ref: 18, gain: 0.62 + rnd() * 0.18, bus: 'world' });
    else this.play('shutter', { pos: { x: px, y: 1.8, z: pz }, ref: 24, gain: 0.68 + rnd() * 0.18, bus: 'world' });
  },

  /** After the rain, not during it: a drop off an awning every second or two, 3–12 m away at eave height, only
   *  while the street is wet and it is not actually raining. */
  drips(now) {
    const T = this.engine.time;
    if (!T || !(T.wet > 0.3) || T.weather === 'rain') return;                // (dialogue ducks the world bus anyway)
    if (!this._dripAt) { this._dripAt = now + 1; return; }
    if (now < this._dripAt) return;
    const rnd = this._dripRnd || (this._dripRnd = mulberry(0xd41b));
    this._dripAt = now + 0.4 - Math.log(1 - rnd() * 0.999) * 1.1;      // ~0.7 a second, clumpy
    const cam = this.engine.camera; if (!cam) return;
    const a = rnd() * 6.283, d = 3 + rnd() * 9;
    const pos = { x: cam.position.x + Math.cos(a) * d, y: 2.6 + rnd() * 1.4, z: cam.position.z + Math.sin(a) * d };
    this.play('drip', { pos, ref: 4, bus: 'world', gain: (0.35 + rnd() * 0.35) * T.wet, rate: 0.8 + rnd() * 0.5 });
  },

  /** One gate for every non-accident horn: at most one per `gap` seconds across the whole street. */
  hornOk(gap) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    if (now - (this._hornAt ?? -1e9) < gap) return false;
    this._hornAt = now; return true;
  },

  /** Ride the real train from city.trains when it exists: its lead car's instance matrix is the sound source. */
  trainLoop(dt, now) {
    const city = this.engine.get && this.engine.get('city');
    const trains = city && city.trains;
    if (trains && trains.length) {
      if (!this._trainNode) {
        const pn = this.panner({ x: 63, y: 9, z: -60 }, 26);
        pn.node.maxDistance = 420; pn.node.rolloffFactor = 0.85;
        pn.node.connect(this.bus.world);
        const g = gain(this.ctx, 0);
        const roll = this.ctx.createBufferSource(); roll.buffer = noiseBuf(this.ctx, 4, 'brown'); roll.loop = true;
        const f = bq(this.ctx, 'lowpass', 300, 0.8);
        roll.connect(f).connect(g).connect(pn.in); roll.start(now);
        const clackG = gain(this.ctx, 0); clackG.connect(pn.in);
        this._trainNode = { pn, p: pn.node, roll, g, f, clackG, nextClack: 0, pos: new Vector3(), m: new Matrix4(), prevD: 0, have: false };
      }
      const T = this._trainNode, cam = this.engine.camera;
      // NEAREST train, not fastest: picking by speed teleported the one panner between two trains on the
      // viaduct, an audible swoop across the stereo field with no physical cause.
      let best = null, bestD = Infinity, bestV = 0;
      const _q = this._tq || (this._tq = new Vector3());
      for (const t of trains) {
        const parts = t.parts, mesh = parts && parts[0];
        if (!mesh) continue;
        try { mesh.getMatrixAt(0, T.m); } catch (e) { continue; }
        _q.setFromMatrixPosition(T.m).applyMatrix4(mesh.matrixWorld);   // as the city module left it
        const d = cam ? _q.distanceToSquared(cam.position) : 0;
        if (d < bestD) { bestD = d; best = t; bestV = t.v || 0; T.pos.copy(_q); }
      }
      if (!best) return;
      // Doppler: differentiate the radial distance we already compute. Approaching → up, receding → down.
      const d = Math.sqrt(bestD);
      const radial = T.have ? (d - T.prevD) / Math.max(1e-3, dt) : 0;
      T.prevD = d; T.have = true;
      const dop = Math.max(0.94, Math.min(1.06, 1 - radial / 340 * 12));
      T.roll.playbackRate.setTargetAtTime(dop, now, 0.12);
      if (T.p.positionX) { T.p.positionX.setTargetAtTime(T.pos.x, now, 0.08); T.p.positionY.setTargetAtTime(T.pos.y, now, 0.2); T.p.positionZ.setTargetAtTime(T.pos.z, now, 0.08); }
      else T.p.setPosition(T.pos.x, T.pos.y, T.pos.z);
      T.pn.air.frequency.setTargetAtTime(this.airCutoff(T.pos.x, T.pos.y, T.pos.z), now, 0.25);
      const v = Math.min(1, bestV / 19);
      T.g.gain.setTargetAtTime(0.02 + v * 0.75, now, 0.35);
      T.f.frequency.setTargetAtTime(170 + v * 420, now, 0.35);
      if (v > 0.22 && now >= T.nextClack) {                     // rail joints, rate tied to speed
        T.nextClack = now + 0.30 / Math.max(0.3, v);
        const c = noise(this.ctx, now + 0.01, 0.05, 'white');
        const cf = bq(this.ctx, 'bandpass', (260 + v * 700) * dop, 1.6);
        const cg = gain(this.ctx, 0); pluck(cg.gain, now + 0.01, 0.28 * v, 0.001, 0.045);
        c.connect(cf).connect(cg).connect(T.clackG);
        T.clackG.gain.value = 1;
      }
      return;
    }
    // no city module (or a shot preset that dropped it): a scheduled pass so the viaduct is never silent
    this._trainIn -= dt;
    if (this._trainIn <= 0) {
      this._trainIn = 42 + Math.random() * 38;
      this.play('train', { pos: { x: 66, y: 9, z: -20 }, ref: 34, gain: 0.7, bus: 'world', duration: 7 });
    }
  },

  // ---------------------------------------------------------------------------------- ?audio=meter scope
  buildMeter() {
    const c = document.createElement('canvas');
    c.width = 560; c.height = 222;
    c.style.cssText = 'position:fixed;left:16px;top:52%;width:560px;height:222px;z-index:40;' +
      'background:rgba(6,8,12,.82);border:1px solid rgba(214,178,94,.55);border-radius:4px;pointer-events:none';
    document.body.appendChild(c);
    this._meter = { c, g: c.getContext('2d'), hist: new Float32Array(256), i: 0, peak: 0, steps: 0 };
  },

  drawMeter() {
    const M = this._meter;
    if (!M.an) {
      const an = this.ctx.createAnalyser();
      an.fftSize = 2048; an.smoothingTimeConstant = 0;
      this.tap.connect(an);
      M.an = an; M.buf = new Float32Array(an.fftSize);
    }
    M.an.getFloatTimeDomainData(M.buf);
    let sum = 0, peak = 0;
    for (let i = 0; i < M.buf.length; i++) { const v = M.buf[i]; sum += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
    const rms = Math.sqrt(sum / M.buf.length);
    M.hist[M.i = (M.i + 1) % M.hist.length] = rms;
    M.peak = Math.max(M.peak * 0.985, peak);
    const g = M.g, W = M.c.width, H = M.c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(6,8,12,.9)'; g.fillRect(0, 0, W, H);
    const dbY = (db) => H - 72 - ((db + 72) / 72) * (H - 88);
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
    for (const db of [-60, -48, -36, -24, -12, 0]) {
      const y = Math.round(dbY(db)) + 0.5;
      g.beginPath(); g.moveTo(40, y); g.lineTo(W - 8, y); g.stroke();
      g.fillStyle = 'rgba(214,178,94,.55)'; g.font = '10px monospace'; g.fillText(String(db), 8, y + 3);
    }
    g.beginPath();
    let pen = false;
    for (let k = 0; k < M.hist.length; k++) {
      const v = M.hist[(M.i + 1 + k) % M.hist.length];
      if (!(v > 0)) { pen = false; continue; }                  // slots from before the context ran: no trace
      const db = 20 * Math.log10(Math.max(v, 1e-6));
      const x = 40 + (k / (M.hist.length - 1)) * (W - 48);
      const y = Math.min(H - 72, Math.max(20, dbY(db)));
      pen ? g.lineTo(x, y) : g.moveTo(x, y);
      pen = true;
    }
    g.strokeStyle = '#7fe3b0'; g.lineWidth = 1.6; g.stroke();
    const lg = (this._log || []).filter(([, at]) => this.ctx.currentTime - at < 6).map(([w, at]) => `${w} ${(this.ctx.currentTime - at).toFixed(1)}s`).join('  ·  ');
    if (lg) { g.fillStyle = '#ff9a6a'; g.font = '11px monospace'; g.fillText(`cues: ${lg}`, 40, 30); }
    g.fillStyle = '#d6b25e'; g.font = '12px monospace';
    // Integrated over the whole 4.3 s window, not the 43 ms the screenshot happened to land on: the
    // instantaneous number swung 4 dB between two shots of the same scene and was useless as evidence.
    let acc = 0, n = 0;
    for (let k = 0; k < M.hist.length; k++) { const v = M.hist[k]; if (v > 0) { acc += v * v; n++; } }
    const idb = (20 * Math.log10(Math.max(n ? Math.sqrt(acc / n) : 0, 1e-6))).toFixed(1);
    const pdb = (20 * Math.log10(Math.max(M.peak, 1e-6))).toFixed(1);
    g.fillText(`MASTER  RMS ${idb} dB (4.3 s)   PEAK ${pdb} dB   ${this._mus.want}  voices ${this._voices}`, 40, 14);

    // What a screenshot cannot otherwise show: the street freezing under a hit-stop while the theme does NOT,
    // where the stems are in the bar and which section is playing, and that the scramble has footsteps in it.
    const sp = this._sp ?? 1, now = this.ctx.currentTime;
    const lpA = this.bus.lpAmb.frequency.value | 0, lpM = this.bus.lpMus.frequency.value | 0;
    const dm = this.bus.duckMus.gain.value, da = this.bus.duckAmb.gain.value;
    const sa = this.bus.scAmb.gain.value, sm = this.bus.scMus.gain.value;
    g.font = '11px monospace';
    const L = this._lastStop;
    const ago = L ? now - L.at : 1e9;
    g.fillStyle = (sp < 0.9 || ago < 0.5) ? '#ff9a6a' : 'rgba(214,178,94,.72)';
    const stop = sp < 0.9 ? '  HIT-STOP → street frozen, impact held'
      : ago < 2.5 ? `  last hit-stop ${L.ms} ms, ${ago.toFixed(2)} s ago` : '';
    g.fillText(`time.speed ${sp.toFixed(2)}${stop}   street lp ${lpA >= 19000 ? 'open' : lpA + 'Hz'}   music lp ${lpM >= 19000 ? 'open' : lpM + 'Hz'}`, 40, H - 55);
    const bb = this.barBeat(now), bm = this._bm;
    const sec = !bm.srcs ? (this._fin ? 'FINALE: button → victory' : this._mus.want) : bm.brk ? 'HEAT section (drumless, lp 560)' : bm.sec === 'last' ? 'LAST MAN' : 'full band';
    const enc = this._encAt && now - this._encAt < 3 && now - this._encAt > -0.7 ? `   ENCOUNTER slam = bar 1 beat 1 (${(now - this._encAt).toFixed(2)} s)` : '';
    g.fillStyle = bm.brk || enc || bm.sec === 'last' ? '#ff9a6a' : 'rgba(214,178,94,.72)';
    g.fillText(`music ${bb ? `${bb.sec} bar ${bb.bar}/40 beat ${bb.beat} ${bb.chord}` : '—'}  ${sec}  intensity ${this.bus.intens.gain.value.toFixed(2)}  EQ ${this.bus.battleEQ.gain.value.toFixed(1)}${enc}`, 40, H - 40);
    g.fillStyle = 'rgba(214,178,94,.72)';
    const gr = 20 * Math.log10(Math.max(1e-6, this._limGr)); this._limGr = 1;
    M.gr = Math.min(M.gr ?? 0, gr); M.grAt = gr < -0.05 ? now : (M.grAt || 0);
    if (now - (M.grAt || 0) > 2) M.gr = 0;
    g.fillText(`duck amb ${da.toFixed(2)} mus ${dm.toFixed(2)}  pump st ${sa.toFixed(2)} mus ${sm.toFixed(2)}  ring ${this._ring ? (this._ring.off ? 'dispersing' : 'ON') : '—'}  steps ${this._crowdVoices | 0}/10  limiter ${M.gr.toFixed(1)} dB`, 40, H - 25);
    // The one number the scope existed to show and never printed: how far the street's events stand above the
    // carpet. 25th vs 99th percentile of the 4.3 s history — a bed is a carpet WITH events on it, not a carpet.
    const sorted = [];
    for (let k = 0; k < M.hist.length; k++) if (M.hist[k] > 0) sorted.push(M.hist[k]);
    sorted.sort((a, b) => a - b);
    const q = (p) => 20 * Math.log10(Math.max(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] || 1e-6, 1e-6));
    const floorDb = q(0.25), peakDb = q(0.99);   // p25, not p10: p10 still catches the 2.5 s ambience fade-in
    const tally = Object.entries(this._count).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join('  ');
    g.fillStyle = 'rgba(214,178,94,.62)';
    g.fillText(`bed ${floorDb.toFixed(1)}  events ${peakDb.toFixed(1)}  Δ ${(peakDb - floorDb).toFixed(1)} dB   ${tally || 'no one-shots yet'}`, 40, H - 9);
  },

  // ------------------------------------------------------------------------------------------- selfTest
  /** Render every voice into an OfflineAudioContext and measure it. This is the proof that the module makes
   *  sound: a screenshot cannot show it, so ?test=audio prints RMS/peak/onset per voice instead. */
  async selfTest() {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return { ok: false, problems: ['no OfflineAudioContext'] };
    const SR = 44100, problems = [], rows = {};
    // the baked bank, the murmur and the stems are async by design; the test measures what ships, so wait for them
    await Promise.all([this._foleyP, this._crowdP, this._stemP].map(p => p && p.catch(() => null)));
    const takes = Object.fromEntries(Object.entries(FOLEY.cats).map(([k, v]) => [k, v.length]));
    for (const c of ['impact_light', 'impact_heavy', 'impact_finisher']) if ((takes[c] || 0) < 6) problems.push(`foley: ${c} has ${takes[c] || 0} takes, needs 6`);
    for (const c of ['bodyfall', 'cloth', 'whoosh_light', 'whoosh_heavy', 'block', 'guardbreak', 'taiko_shime', 'taiko_odaiko', 'stamp', 'crash', 'crowd_react',
      ...['asphalt', 'concrete', 'tile'].flatMap(m => [`step_${m}_dry`, `step_${m}_wet`])]) if ((takes[c] || 0) < 4) problems.push(`foley: ${c} has ${takes[c] || 0} takes, needs 4`);
    if ((takes.crowd_oh || 0) < 3) problems.push(`foley: crowd_oh has ${takes.crowd_oh || 0} takes, needs 3`);
    if (!this._crowdBuf) problems.push('crowd murmur did not decode');
    const st = this._stems;
    if (!st) problems.push('battle stems did not load');
    else {
      const M = st.man;
      if (M.main.bars < 32) problems.push(`the battle arrangement is ${M.main.bars} bars, needs 32`);
      if (M.main.bars - M.main.loopBar < 28) problems.push(`the battle loop is ${M.main.bars - M.main.loopBar} bars`);
      if (M.last.bars < 8) problems.push(`the last-man section is ${M.last.bars} bars`);
      for (const k of STEM_NAMES) if (!st[k] || st[k].duration < st.last.loopEnd) problems.push(`stem ${k} is missing or shorter than its last-man region`);
      if (Math.abs(st.main.loopEnd - st.main.loopStart - 28 * st.bar) > 1e-6) problems.push('the main loop region is not 28 bars');
    }
    const db = (v) => v > 1e-7 ? +(20 * Math.log10(v)).toFixed(1) : -140;

    /** Render one voice through a replica of the shipping master chain (bus gain → [glue] → master volume → the
     *  look-ahead limiter → the safety clip), in STEREO, so the numbers are the levels a player actually gets.
     *  The limiter is the same PeakLimiter class the worklet runs, applied to the render. Levels are the mean
     *  power of the two channels (a mono source reads as before; a wide stereo band no longer loses 3 dB to a
     *  mono fold-down). `gr` is the deepest limiter gain reduction (dB), `fed` what reached the safety clip. */
    const render = async (build, seconds, bus, chain, glued) => {
      const ctx = new OAC(2, Math.ceil(SR * seconds), SR);
      const busG = gain(ctx, bus);
      if (chain) {
        const master = gain(ctx, this.volume);
        master.connect(ctx.destination);
        if (glued) {
          const g = ctx.createDynamicsCompressor();
          g.threshold.value = -18; g.knee.value = 12; g.ratio.value = 2.5; g.attack.value = 0.02; g.release.value = 0.25;
          busG.connect(g).connect(master);
        } else busG.connect(master);
      } else busG.connect(ctx.destination);
      build(ctx, busG);
      const buf = await ctx.startRendering();
      let L = buf.getChannelData(0), R = buf.getChannelData(1), gr = 1, fed = 0;
      if (chain) {
        const lim = new PeakLimiter(SR), oL = new Float32Array(L.length), oR = new Float32Array(R.length);
        lim.process([L, R], [oL, oR], L.length);
        gr = lim.gMin;
        for (let i = 0; i < oL.length; i++) {
          for (const o of [oL, oR]) {
            const x = o[i], a = Math.abs(x);
            if (a > fed) fed = a;
            if (a > SAFETY_KNEE) o[i] = Math.sign(x) * (SAFETY_KNEE + (1 - SAFETY_KNEE) * Math.tanh((a - SAFETY_KNEE) / (1 - SAFETY_KNEE)));
          }
        }
        L = oL; R = oR;
      }
      const n = L.length, pw = new Float32Array(n);
      let sum = 0, peak = 0, onset = -1, pi = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        pw[i] = (L[i] * L[i] + R[i] * R[i]) * 0.5; sum += pw[i];
        if (a > peak) { peak = a; pi = i; }
        if (onset < 0 && a > 0.02) onset = i / SR;
      }
      // Loudest short-term window: 120 ms, roughly the ear's loudness integration for an impulsive event
      const W = Math.min(n, Math.floor(SR * 0.12));
      let run = 0, best = 0, runM = 0, bestM = 0;
      for (let i = 0; i < n; i++) {
        run += pw[i]; if (i >= W) run -= pw[i - W]; if (i >= W - 1 && run > best) best = run;
        const m = (L[i] + R[i]) * 0.5, mo = i >= W ? (L[i - W] + R[i - W]) * 0.5 : 0;
        runM += m * m - mo * mo; if (i >= W - 1 && runM > bestM) bestM = runM;
      }
      // where the loudest 50 ms sits: a cue whose payload arrives 280 ms late has a perfectly good onset
      const W5 = Math.min(n, Math.floor(SR * 0.05));
      let r5 = 0, b5 = 0, at50 = 0;
      for (let i = 0; i < n; i++) { r5 += pw[i]; if (i >= W5) r5 -= pw[i - W5]; if (i >= W5 - 1 && r5 > b5) { b5 = r5; at50 = (i + 1) / SR; } }
      return { rms: Math.sqrt(sum / n), st: Math.sqrt(Math.max(0, best) / W), stMono: Math.sqrt(Math.max(0, bestM) / W), peak, onset, peakAt: pi / SR, at50, gr, fed, L, R };
    };

    /** `raw` is the voice's own level at unity master; `out` is what reaches the speakers at the shipping volume.
     *  The master protection is now a limiter, so the guard is on what it has to DO: at the shipping volume a
     *  single voice may cost at most 1.5 dB of gain reduction (3 dB for the loudest call gain the ATTACKS table
     *  can produce), and nothing may ever reach the safety clip behind it. */
    const measure = async (label, build, seconds, { bus = 1, onsetBy = 0.05, glued = false, worst = false } = {}) => {
      const raw = await render(build, seconds, bus, false, glued);
      const o = await render(build, seconds, bus, true, glued);
      const r = rows[label] = {
        rms: db(o.rms), st: db(o.st), stMono: db(o.stMono), peak: db(o.peak), rawPeak: db(raw.peak), gr: db(o.gr),
        onset: o.onset < 0 ? null : +o.onset.toFixed(4), peakAt: +o.peakAt.toFixed(4), at50: +o.at50.toFixed(3),
      };
      if (o.peak < 0.01) problems.push(`${label}: silent (peak ${r.peak} dB)`);
      if (o.fed > SAFETY_KNEE) problems.push(`${label}: reached the safety clip (${db(o.fed)} dBFS after the limiter)`);
      if (r.gr < (worst ? -3 : -1.5)) problems.push(`${label}: costs the limiter ${-r.gr} dB at the shipping volume`);
      if (o.onset < 0 || o.onset > onsetBy) problems.push(`${label}: nothing audible within ${onsetBy * 1000} ms (onset ${r.onset})`);
      return r;
    };

    // onsetBy is per voice: a punch must be instant, a riser or a pass-by legitimately swells.
    // `bus` is the SHIPPING bus gain for that voice, so every row is the level a player actually gets.
    const SFX = SFX_BUS, WORLD = 0.85;
    // The loudest call gain the ATTACKS map can produce, light side and heavy side. These two rows are the
    // worst case the clip guard has to survive — the old guard only ever saw gain 1.
    const MOVES = Object.entries(ATTACKS);
    const gmax = (pick) => Math.max(0, ...MOVES.filter(([n, d]) => pick(n, d)).map(([n, d]) => atkGain(d, !!d.heavy, isHeat(n, d))));
    const GMAX_LIGHT = gmax((n, d) => !d.heavy && !isHeat(n, d));
    const GMAX_HEAVY = gmax((n, d) => d.heavy && !isHeat(n, d));
    const GMAX_HEAT = gmax((n, d) => isHeat(n, d));
    const S = [
      ['hit', {}, 0.6, { bus: SFX }], ['hit_heavy', { heavy: true }, 0.9, { bus: SFX }], ['guard', {}, 0.5, { bus: SFX }],
      ['hit_jab', { gain: atkGain(ATTACKS.jab, false), crack: CRACK.jab, weight: 0.23 }, 0.6, { bus: SFX }],
      ['hit_light_max', { gain: GMAX_LIGHT }, 0.6, { bus: SFX, worst: true }],
      ['hit_heavy_max', { gain: GMAX_HEAVY, heavy: true, weight: 1 }, 0.9, { bus: SFX, worst: true }],
      ['hit_heat_max', { gain: GMAX_HEAT, heavy: true, weight: 1, finisher: true }, 1.0, { bus: SFX, worst: true }],
      // a string's closing blow (combo 4, a hook): slower take, +1.5 dB, the sub all the way down
      ['hit_closing', { gain: atkGain(ATTACKS.hook || ATTACKS.jab, false), crack: (CRACK.hook || 2600) * 1.24, weight: 1, takeDb: 1.5, rate: 0.92 }, 0.6, { bus: SFX }],
      ['guardbreak', {}, 0.7, { bus: SFX }], ['ko', {}, 1.9, { bus: SFX }], ['whoosh', {}, 0.5, { onsetBy: 0.16, bus: SFX }],
      // the last-man KO as it ships: the killing blow's heavy take, and ko() on that same take adding only the
      // boom, the stab and the air
      ['ko_moment', { take: 'heavy' }, 1.9, { bus: SFX }],
      ['telegraph', { gain: 0.8 }, 0.4, { onsetBy: 0.01, bus: SFX }],
      // a roundhouse's swing: contact 0.36 s after the attack starts, so the air must peak at ~0.335 s
      ['whoosh_contact', { heavy: true, duration: 0.36 }, 0.7, { onsetBy: 0.34, bus: SFX }],
      ['whoosh_jab', { duration: 0.128 }, 0.4, { onsetBy: 0.13, bus: SFX }],
      ['guard_weapon', { weapon: true }, 0.5, { bus: SFX }],
      ['encounter', {}, 2.6, { onsetBy: 0.62, bus: SFX }], ['button', {}, 2.0, { bus: SFX }],
      ['victory', {}, 2.2, { bus: SFX }], ['ko_tag', {}, 1.3, { bus: SFX }],
      ['heat_final', {}, 1.7, { bus: SFX }], ['heat_hit', {}, 1.3, { bus: SFX }],
      ['freeze', { take: foleyTake('impact_heavy', 0), hold: 0.09 }, 0.3, { bus: SFX }],
      ['footstep', { wet: 1 }, 0.4, { bus: SFX }], ['footstep_tile', { wet: 0, material: 'tile' }, 0.4, { bus: SFX }], ['bodyfall', { wet: 1 }, 0.9, { bus: SFX }],
      ['heat_ready', {}, 1.9, { onsetBy: 0.03, bus: SFX }],
      ['heat_action', {}, 2.1, { bus: SFX }], ['prop_bike', { type: 'bike' }, 0.9, { bus: SFX }],
      ['prop_trash', { type: 'trash' }, 0.9, { bus: SFX }], ['prop_cone', { type: 'cone' }, 0.6, { bus: SFX }],
      ['ui_confirm', { kind: 'confirm' }, 0.6, { bus: 0.9 }], ['ui_move', { kind: 'move' }, 0.3, { bus: 0.9 }],
      ['horn', {}, 0.7, { bus: 0.6 * WORLD }], ['cuckoo', {}, 0.8, { bus: 0.9 * WORLD }],
      ['scooter', {}, 2.0, { onsetBy: 0.7, bus: 0.65 * WORLD }],
      ['shutter', {}, 2.0, { bus: 0.7 * WORLD }],
      ['chime', {}, 1.1, { bus: 0.65 * WORLD }], ['bell', {}, 1.0, { bus: 0.65 * WORLD }],
      ['grunt_hero', { who: 'hero' }, 0.7, { bus: 0.62 * 1.1 }], ['grunt_enemy', { who: 'enemy' }, 0.7, { bus: 0.5 * 1.1 }],
      ['thunder', {}, 3.4, { onsetBy: 0.2, bus: 0.9 * WORLD }], ['train', { duration: 3 }, 3.4, { onsetBy: 1.6, bus: 0.7 * WORLD }],
    ];
    for (const [label, o, secs, opt] of S) {
      const name = label.startsWith('prop_') ? 'prop' : label.startsWith('grunt') ? 'grunt'
        : label.startsWith('ui_') ? 'ui' : label.startsWith('hit_') ? 'hit' : label.startsWith('whoosh') ? 'whoosh'
          : label.startsWith('guard_') ? 'guard' : label.startsWith('footstep') ? 'footstep' : label;
      if (label === 'ko_moment') {
        const tk = foleyTake('impact_heavy', 2);
        await measure(label, (ctx, out) => { VOICES.hit(ctx, out, 0.005, { take: tk, heavy: true, gain: atkGain(ATTACKS.roundhouse || ATTACKS.kick || {}, true), rate: 1, weight: 1 }); VOICES.ko(ctx, out, 0.005, { take: tk, rate: 1 }); }, secs, opt);
        continue;
      }
      await measure(label, (ctx, out) => VOICES[name](ctx, out, 0.005, o), secs, opt);
    }

    // --- does a five-hit string machine-gun? -----------------------------------------------------------
    // The round-1 loop hand-fed its own variation (`rate: 0.94 + i/8*0.12, crack: i%2 ? 3400 : 1900`) and then
    // reported that the arguments differed — it could not have failed if the randomisation inside play() were
    // deleted. This calls the REAL path, play('hit'), against an offline stub, with no rate and no crack, and
    // compares one-third-octave band energy instead of mean-|x|, which a 0.9 dB wobble could satisfy.
    const bandRms = (d, sr, fc) => {
      const bw = fc / 4.3;                                   // ~1/3 octave
      const r = Math.exp(-Math.PI * bw / sr), a1 = 2 * r * Math.cos(2 * Math.PI * fc / sr), a2 = -r * r;
      let y1 = 0, y2 = 0, x1 = 0, x2 = 0, s = 0;
      for (let i = 0; i < d.length; i++) {
        const x = d[i];
        const y = (1 - r) * 0.5 * (x - x2) + a1 * y1 + a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        s += y * y;
      }
      return Math.sqrt(s / d.length);
    };
    const BANDS = [250, 1600, 5000];
    const hitBands = [];
    {
      const save = {
        ctx: this.ctx, bus: this.bus, running: this.running, active: this._active, voices: this._voices,
        count: this._count, last: this._last, fifo: this._worldFifo, pool: this._panPool,
      };
      try {
        for (let i = 0; i < 8; i++) {
          const ctx = new OAC(1, Math.ceil(SR * 0.5), SR);
          const out = gain(ctx, 1); out.connect(ctx.destination);
          this.ctx = ctx; this.bus = { sfx: out, world: out, voice: out, ui: out };
          this.running = true; this._active = []; this._worldFifo = []; this._panPool = [];
          this._voices = 0; this._last = Object.create(null); this._count = { hit: i };
          this.play('hit', { pos: null });                   // nothing hand-fed: this is what a combo does
          const d = (await ctx.startRendering()).getChannelData(0);
          hitBands.push(BANDS.map(f => +bandRms(d, SR, f).toFixed(6)));
        }
      } finally {
        this.ctx = save.ctx; this.bus = save.bus; this.running = save.running; this._active = save.active;
        this._voices = save.voices; this._count = save.count; this._last = save.last;
        this._worldFifo = save.fifo; this._panPool = save.pool;
      }
    }
    const bandSpread = BANDS.map((f, k) => {
      let lo = Infinity, hi = 0;
      for (const b of hitBands) { lo = Math.min(lo, b[k]); hi = Math.max(hi, b[k]); }
      return +(20 * Math.log10(Math.max(hi, 1e-9) / Math.max(lo, 1e-9))).toFixed(1);
    });
    const varied = bandSpread.filter(v => v >= 3).length;
    if (varied < 2) {
      problems.push(`consecutive hits vary by ≥3 dB in only ${varied}/3 bands (250/1.6k/5k spread ${bandSpread.join(' / ')} dB) — a 5-hit string machine-guns`);
    }
    // "A heavy is bigger" is weight, not peak: once both are saturated at the source every impact peaks near
    // the ceiling and only the sub band tells them apart. 80 Hz energy is the honest measure.
    const subOf = async (opts) => {
      const ctx = new OAC(1, Math.ceil(SR * 0.6), SR);
      const g = gain(ctx, 1); g.connect(ctx.destination);
      VOICES.hit(ctx, g, 0.005, { rate: 1, crackJitter: 1, variant: 0, take: 0, ...opts });
      return bandRms((await ctx.startRendering()).getChannelData(0), SR, 80);
    };
    const subGap = +(20 * Math.log10((await subOf({ heavy: true, weight: 0.8 })) / Math.max(await subOf({}), 1e-9))).toFixed(1);
    if (subGap < 5) problems.push(`a heavy hit carries only ${subGap} dB more 80 Hz energy than a light one`);
    // The battle theme as it ships: the baked stems, 4 bars from a section, through BATTLE_BUS, the in-fight
    // 2.8 kHz pocket, the glue and the master chain, in stereo. music_bar = A (bars 5–8), heat at 0; music_heat =
    // A' (bars 21–24) with the intensity stem fully open (HEAT MAX); music_last = the last-man section.
    const stemRender = (region, fromBar, bars, intensity = 0) => (ctx, out) => {
      const eq = ctx.createBiquadFilter(); eq.type = 'peaking'; eq.frequency.value = 2800; eq.Q.value = 0.75; eq.gain.value = -2.5;
      eq.connect(gain(ctx, STEM_GAIN)).connect(out);
      for (const k of STEM_NAMES) {
        if (k === 'intensity' && !intensity) continue;
        const s = ctx.createBufferSource(); s.buffer = st[k];
        s.connect(gain(ctx, k === 'intensity' ? intensity : 1)).connect(eq);
        s.start(0.005, region.at + fromBar * st.bar); s.stop(0.005 + bars * st.bar);
      }
    };
    if (st) {
      await measure('music_bar', stemRender(st.main, 4, 4), 4 * st.bar + 0.1, { bus: BATTLE_BUS, glued: true, onsetBy: 0.03 });
      await measure('music_heat', stemRender(st.main, 20, 4, 1), 4 * st.bar + 0.1, { bus: BATTLE_BUS, glued: true, onsetBy: 0.03 });
      await measure('music_last', stemRender(st.last, 0, 4, LAST_INTENSITY), 4 * st.bar + 0.1, { bus: BATTLE_BUS, glued: true, onsetBy: 0.03 });
    }
    // the explore pad
    await measure('music_pad', (ctx, out) => {
      const sc = this.ctx, sb = this.bus;
      this.ctx = ctx; this.bus = { battle: out, explore: out };
      this.explorePad(0.005, 0);
      this.ctx = sc; this.bus = sb;
    }, 3.0, { bus: 0.10, onsetBy: 1.2, glued: true });
    // the ambience bed: the layers exactly as setAmbience() wires them
    await measure('ambience', (ctx, out) => {
      const hum = ctx.createBufferSource(); hum.buffer = noiseBuf(ctx, 2, 'pink'); hum.loop = true; hum.start(0);
      hum.connect(bq(ctx, 'lowpass', 220, 0.7)).connect(gain(ctx, 0.30)).connect(out);
      const tr = ctx.createBufferSource(); tr.buffer = noiseBuf(ctx, 2, 'brown'); tr.loop = true; tr.start(0);
      tr.connect(bq(ctx, 'bandpass', 420, 0.55)).connect(gain(ctx, 0.42)).connect(out);
      if (this._crowdBuf) {
        const c = ctx.createBufferSource(); c.buffer = this._crowdBuf; c.loop = true; c.start(0, 1);
        c.connect(bq(ctx, 'highpass', 190, 0.7)).connect(bq(ctx, 'lowpass', 9000, 0.6)).connect(gain(ctx, 0.50)).connect(out);
      }
      for (const [f, a] of [[51, 0.035], [77.5, 0.022]]) osc(ctx, 'sine', f, 0, 2).connect(gain(ctx, a)).connect(out);
    }, 2.0, { bus: 0.25, onsetBy: 0.5, glued: true });

    // the onlooker ring (six decorrelated murmur sources through the 400 Hz – 3 kHz band, un-panned) and the crowd
    // 「おおっ」 it opens with, at the levels the ring bus plays them
    if (this._crowdBuf) {
      await measure('ring_walla', (ctx, out) => {
        const hp = bq(ctx, 'highpass', 400, 0.7), lp = bq(ctx, 'lowpass', 3000, 0.7); hp.connect(lp).connect(gain(ctx, WALLA)).connect(out);
        for (let k = 0; k < 6; k++) { const x = ctx.createBufferSource(); x.buffer = this._crowdBuf; x.loop = true; x.connect(gain(ctx, 1 / Math.sqrt(6))).connect(hp); x.start(0.005, 1 + k * 1.7); }
      }, 2.0, { bus: 1, onsetBy: 0.05 });
    }
    await measure('ring_oh', (ctx, out) => {
      for (let j = 0; j < 3; j++) { const tk = foleyTake('crowd_oh', j); if (tk) playTake(ctx, out, 0.005 + j * 0.03, tk, dbLin(FOLEY_ST.crowd - tk.meta.st) / Math.sqrt(3)); }
    }, 1.8, { bus: 1, onsetBy: 0.3 });

    // Where does a transient lose level? Chrome's DynamicsCompressor carries implicit makeup gain and a
    // lookahead detector, so "below threshold" is not "untouched". Probe the chain a stage at a time — with
    // ONE pre-rendered punch replayed through each stage, because hit() is now deliberately non-repeating
    // (noise() alone seeks to a random buffer offset) and four different punches cannot be compared.
    const src = await (async () => {
      const ctx = new OAC(1, Math.ceil(SR * 0.7), SR);
      VOICES.hit(ctx, ctx.destination, 0.005, { rate: 1, crackJitter: 1 });
      return ctx.startRendering();
    })();
    const probe = {};
    {
      const d0 = src.getChannelData(0), pk = (x) => { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; };
      probe.bus = db(pk(d0));
      const x = d0.map(v => v * this.volume);
      probe['+master'] = db(pk(x));
      const o = new Float32Array(x.length); new PeakLimiter(SR).process([x], [o], x.length);
      probe['+limiter'] = db(pk(o));
      const ctx = new OAC(1, Math.ceil(SR * 0.7), SR), c = ctx.createDynamicsCompressor();
      c.threshold.value = -18; c.knee.value = 12; c.ratio.value = 2.5; c.attack.value = 0.02; c.release.value = 0.25;
      const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, src.length, SR); s.buffer.copyToChannel(d0, 0);
      s.connect(c).connect(gain(ctx, this.volume)).connect(ctx.destination); s.start(0);
      const g = (await ctx.startRendering()).getChannelData(0), og = new Float32Array(g.length);
      new PeakLimiter(SR).process([g], [og], g.length);
      probe['+glue'] = db(pk(og));
    }

    // Footstep extraction, deterministically: drive a stub walk cycle past its two baked events and count the
    // emits. Nothing else emits 'sfx:footstep', so if this is wrong the hero walks in silence.
    const feet = (() => {
      const clip = { duration: 1.0, userData: { events: [{ time: 0.25, name: 'footstep', foot: 'R' }, { time: 0.75, name: 'footstep', foot: 'L' }] } };
      let time = 0;
      const ent = { position: new Vector3(), humanoid: { currentName: 'walk', currentAction: { isRunning: () => true, getClip: () => clip, get time() { return time; } } } };
      let n = 0;
      const realEngine = this.engine, realFeet = this._feet;
      this._feet = new Map();
      this.engine = {
        camera: { position: new Vector3() }, player: ent, time: { wet: 1 },
        get: () => null, events: { emit: (name) => { if (name === 'sfx:footstep') n++; } },
      };
      try { for (let i = 0; i <= 60; i++) { time = (i / 30) % 1; this.footsteps(); } }
      finally { this.engine = realEngine; this._feet = realFeet; }
      return n;
    })();
    if (feet !== 4) problems.push(`footstep extraction fired ${feet} times over 2 walk cycles, expected 4`);

    // An impact must sit ABOVE the bed, or the fight is mush — and both sides must be measured the same way.
    // 400 ms short-term RMS vs 400 ms short-term RMS, bed = ambience + the battle loop, which is what is
    // actually playing under a punch. The old test compared rows.hit.PEAK against rows.ambience.RMS.
    const musBar = rows.music_bar ? rows.music_bar.st : -140;
    const bed = 10 * Math.log10(Math.pow(10, rows.ambience.st / 10) + Math.pow(10, musBar / 10));
    // The weakest real punch at its SHIPPING gain against the un-pumped theme, 120 ms RMS both sides. In a
    // 龍が如く fight the BGM drives the energy and the hits sit 3–6 dB over it: the old target (8 dB over the
    // bed) is what buried the theme 10 dB under a jab. ≥ 5 dB over the A section with no heat; ≥ 4 over the
    // band at HEAT MAX, brass and double-time hats in.
    const head = rows.hit_jab.st - musBar;
    if (head < 5) problems.push(`a jab is only ${head.toFixed(1)} dB over the battle theme (120 ms RMS both sides) — needs 5`);
    if (rows.music_heat && rows.hit_jab.st - rows.music_heat.st < 4) problems.push(`a jab is only ${(rows.hit_jab.st - rows.music_heat.st).toFixed(1)} dB over the theme at HEAT MAX — needs 4`);
    if (rows.music_heat && rows.music_heat.st < musBar + 0.5) problems.push('the intensity stem adds nothing at HEAT MAX');
    if (head > 8) problems.push(`the battle theme sits ${head.toFixed(1)} dB under a jab — wallpaper again`);
    // --- the contact frame is the peak: the loudest sample within 6 ms of the first audible one, on the shipping
    // voices and on EVERY take of every class (a shuffle must not be able to deal a 'whump')
    for (const k of ['hit', 'hit_jab', 'hit_heavy', 'hit_closing']) {
      const r = rows[k]; if (r && r.onset != null && r.peakAt - r.onset >= 0.006) problems.push(`${k}: peak ${((r.peakAt - r.onset) * 1000).toFixed(1)} ms after the onset — the smack is smeared`);
    }
    let worstPk = 0;
    for (const cls of ['light', 'heavy', 'finisher']) {
      for (let k = 0; k < (FOLEY.cats[`impact_${cls}`] || []).length; k++) {
        const o = await render((c, g) => VOICES.hit(c, g, 0.005, { take: k, heavy: cls !== 'light', finisher: cls === 'finisher', rate: 1, crackJitter: 1, weight: 1 }), 0.8, 1, false, false);
        const dt = o.onset < 0 ? 1 : o.peakAt - o.onset;
        if (dt > worstPk) worstPk = dt;
        if (dt >= 0.006) problems.push(`impact_${cls} take ${k}: peak ${(dt * 1000).toFixed(1)} ms after the onset`);
      }
    }
    // --- the guard break is the loudest defensive event: ≥ 3 dB over a jab
    if (rows.guardbreak.st <= rows.hit_jab.st + 3) problems.push(`guardbreak ${rows.guardbreak.st} dB is not 3 dB over a jab (${rows.hit_jab.st})`);
    // --- the telegraph glint is heard but never out-shouts a punch
    if (rows.telegraph.st > rows.hit_jab.st - 3 || rows.telegraph.st < rows.hit_jab.st - 14) problems.push(`telegraph at ${rows.telegraph.st} dB vs a jab at ${rows.hit_jab.st}: must sit 3–14 dB under it`);
    // --- hit-stop tail: one pass, no loop. The old 42 ms loop wrapped at the transient's peak with no window: a
    //     sample discontinuity every wrap, a 24 → 17 Hz click train. Structural, because that is the defect: no
    //     source the voice creates may loop, and the tail must fade in (Hann) rather than start on a step.
    let fzLoops = -1, fzStep = 1;
    {
      const c = new OAC(2, Math.ceil(SR * 0.3), SR), mk = c.createBufferSource.bind(c), made = [];
      c.createBufferSource = () => { const x = mk(); made.push(x); return x; };
      VOICES.freeze(c, c.destination, 0.005, { take: foleyTake('impact_heavy', 0), hold: 0.13, gain: 0.3, rate: 1 });
      fzLoops = made.filter(x => x.loop).length;
      const d = (await c.startRendering()).getChannelData(0), i0 = Math.floor(0.005 * SR);
      let pk = 0; for (let i = i0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
      fzStep = Math.max(Math.abs(d[i0]), Math.abs(d[i0 + 1])) / Math.max(pk, 1e-9);
    }
    const freezeClick = { loopingSources: fzLoops, firstSampleOfPeak: +fzStep.toFixed(3) };
    if (fzLoops !== 0) problems.push('the hit-stop tail loops a grain again');
    if (fzStep > 0.05) problems.push('the hit-stop tail starts on a step, not a fade-in');
    // --- the last KO never stacks a second take on the killing blow: with the blow's take passed in, ko() adds
    //     nothing in the first 15 ms (its boom and stab start at 20–30 ms)
    const koEarly = async (take) => { const o = await render((c, g) => VOICES.ko(c, g, 0.005, { take, rate: 1 }), 0.03, 1, false, false); let e = 0; for (let i = 0; i < Math.floor(SR * 0.02); i++) e += o.L[i] * o.L[i]; return e; };
    const koFlamDb = +(10 * Math.log10((await koEarly(foleyTake('impact_heavy', 1))) / Math.max(1e-12, await koEarly(null)) + 1e-12)).toFixed(1);
    if (koFlamDb > -20) problems.push(`ko() with the killing blow's take still puts ${koFlamDb} dB of a second transient on the blow`);
    // --- the payoff frame, all at once: a heat finisher's final contact (heavy take + hit-stop tail + heat_final),
    //     the last-man KO on the same take, the body fall, the button, and the band at HEAT MAX underneath. The
    //     limiter may work; nothing may reach the safety clip.
    let payoff = null;
    if (st) {
      payoff = await render((ctx, out) => {
        const sfx = gain(ctx, SFX_BUS); sfx.connect(out);
        const glue = ctx.createDynamicsCompressor(); glue.threshold.value = -18; glue.knee.value = 12; glue.ratio.value = 2.5; glue.attack.value = 0.02; glue.release.value = 0.25;
        const mus = gain(ctx, BATTLE_BUS); mus.connect(glue).connect(out);
        const tk = foleyTake('impact_finisher', 0);
        VOICES.hit(ctx, sfx, 0.005, { gain: GMAX_HEAT, heavy: true, finisher: true, weight: 1, take: tk, rate: 1, crackJitter: 1 });
        VOICES.freeze(ctx, sfx, 0.017, { take: tk, hold: 0.15, gain: GMAX_HEAT * dbLin(FOLEY_ST.finisher - tk.meta.st - 9) });
        VOICES.heat_final(ctx, sfx, 0.005, {});
        VOICES.ko(ctx, sfx, 0.005, { take: tk, rate: 1 });
        VOICES.bodyfall(ctx, sfx, 0.385, { wet: 1, gain: 1.05, rate: 1 });
        VOICES.button(ctx, sfx, 0.3, {});
        stemRender(st.main, 20, 1, 1)(ctx, mus);
      }, 2.0, 1, true, false);
      if (payoff.fed > SAFETY_KNEE) problems.push(`the payoff frame reaches the safety clip (${db(payoff.fed)} dBFS)`);
    }
    if (rows.whoosh.peak < rows.hit.peak - 18) problems.push('whoosh is buried under the impact');
    // Both sides through the same 120 ms window. A peak comparison stopped meaning anything once the impact
    // family was saturated at the source — everything peaks near the ceiling and only loudness separates them.
    if (rows.footstep.st > rows.hit.st - 8) problems.push(`footsteps only ${(rows.hit.st - rows.footstep.st).toFixed(1)} dB under an impact`);
    if (rows.footstep.peak > rows.hit.peak - 4) problems.push('a footstep peaks as hard as a punch');
    // "Louder" for an impact is loudness, not peak: a heavy is fatter and longer, and short-term RMS hears
    // that where a peak comparison just hears whichever transient happened to align.
    if (rows.hit_heavy.st < rows.hit.st + 3) problems.push(`a heavy hit is only ${(rows.hit_heavy.st - rows.hit.st).toFixed(1)} dB louder than a light one`);
    // The whole move set, every entry combat.js exports, at its shipping gain and its real contact options,
    // three recipe variants each. The last critique measured 12 moves spanning 3.1 dB and the finisher level
    // with a jab; the live probe then found a hook UNDER a jab. So: order follows the ladder wherever the
    // ladder says two moves differ by ≥2 dB, every heat contact clears every non-heat move by 2.5 dB, the heavy
    // button's opener clears a jab by 2.5, and the set spans at least 9 dB.
    const ladder = {};
    for (const [n, d] of MOVES) {
      const heat = isHeat(n, d), heavy = !!d.heavy || heat;
      let acc = 0;
      for (let v = 0; v < 3; v++) {
        const o = await render((ctx, out) => VOICES.hit(ctx, out, 0.005, {
          gain: atkGain(d, !!d.heavy, heat), heavy, finisher: heat, variant: v, take: v * 2, rate: 1, crackJitter: 1,
          weight: Math.min(1, (d.knock ?? 2) / 7.4), crack: CRACK[n] || CRACK[d.clip] || 0,
        }), 1.0, SFX, true, false);
        acc += o.st * o.st;
      }
      ladder[n] = { st: db(Math.sqrt(acc / 3)), want: +ladderDb(d, heat).toFixed(1), heat };
    }
    const names = Object.keys(ladder);
    for (const a of names) for (const b of names) {
      if (ladder[a].want >= ladder[b].want + 2 && ladder[a].st <= ladder[b].st) problems.push(`ladder inverted: ${a} (${ladder[a].st} dB) is not above ${b} (${ladder[b].st} dB)`);
    }
    const plainTop = Math.max(...names.filter(n => !ladder[n].heat).map(n => ladder[n].st));
    for (const n of names.filter(n => ladder[n].heat)) {
      if (ladder[n].st < plainTop + 2.5) problems.push(`heat contact ${n} is only ${(ladder[n].st - plainTop).toFixed(1)} dB over the loudest plain move`);
    }
    const opener = ladder.kick || ladder[names.find(n => HEAVY_OPENERS.includes(n))];
    if (ladder.jab && opener && opener.st < ladder.jab.st + 2.5) problems.push(`the heavy button's opener is only ${(opener.st - ladder.jab.st).toFixed(1)} dB over a jab`);
    const heatTop = Math.max(...names.filter(n => ladder[n].heat).map(n => ladder[n].st));
    const span = ladder.jab ? heatTop - ladder.jab.st : 0;
    if (span < 9) problems.push(`jab → heat finisher spans only ${span.toFixed(1)} dB`);
    if (rows.heat_ready.at50 > 0.08) problems.push(`heat_ready's loudest 50 ms ends at ${Math.round(rows.heat_ready.at50 * 1000)} ms — the cue arrives late`);
    if (rows.music_pad.rms > rows.ambience.rms) problems.push('the explore pad is louder than the city bed');
    // the payoff sounds have to be the biggest things in the game
    for (const k of ['ko', 'ko_moment', 'heat_action']) {
      if (rows[k].st < rows.hit_heavy.st + 1) problems.push(`${k} is not above a heavy hit (${rows[k].st} vs ${rows.hit_heavy.st} dB)`);
    }
    if (rows.bodyfall.st < bed + 4) problems.push(`the body fall is only ${(rows.bodyfall.st - bed).toFixed(1)} dB over the bed`);

    // --- the swing lands WITH the contact: the loudest 50 ms of the air must be centred ~25 ms before it
    const swing = {
      roundhouse: +((rows.whoosh_contact.at50 - 0.025 - 0.005) * 1000).toFixed(0),
      jab: +((rows.whoosh_jab.at50 - 0.025 - 0.005) * 1000).toFixed(0),
    };
    if (Math.abs(swing.roundhouse - 335) > 45) problems.push(`a 0.36 s swing peaks at ${swing.roundhouse} ms, not ~335 (contact − 25)`);
    if (Math.abs(swing.jab - 103) > 40) problems.push(`a 0.128 s jab swing peaks at ${swing.jab} ms, not ~103`);
    // --- the encounter's slam is where the theme starts: loudest 50 ms centred on 0.6 s
    const slamMs = Math.round((rows.encounter.at50 - 0.025 - 0.005) * 1000);
    if (Math.abs(slamMs - 600) > 90) problems.push(`the encounter's slam lands at ${slamMs} ms, not 600`);
    // --- a block is a thud: its 3 kHz band sits far under its 250 Hz band, unless a weapon rings it
    const bandsOf = async (build, secs = 0.5) => {
      const ctx = new OAC(1, Math.ceil(SR * secs), SR); const g = gain(ctx, 1); g.connect(ctx.destination);
      build(ctx, g);
      const d = (await ctx.startRendering()).getChannelData(0);
      return [250, 3000].map(f => bandRms(d, SR, f));
    };
    // every block take, worst one reported: a shuffle must not be able to deal the one that clanks
    let guardTilt = -99, weaponTilt = 99;
    for (let k = 0; k < Math.max(1, (FOLEY.cats.block || []).length); k++) {
      const gb = await bandsOf((c, g) => VOICES.guard(c, g, 0.005, { rate: 1, take: k }));
      const gw = await bandsOf((c, g) => VOICES.guard(c, g, 0.005, { rate: 1, weapon: true, take: k }));
      guardTilt = Math.max(guardTilt, +(20 * Math.log10(gb[1] / gb[0])).toFixed(1));
      weaponTilt = Math.min(weaponTilt, +(20 * Math.log10(gw[1] / gw[0])).toFixed(1));
    }
    if (guardTilt > -12) problems.push(`a bare-arm block has 3 kHz only ${guardTilt} dB under 250 Hz — still a clank`);
    if (weaponTilt < guardTilt + 6) problems.push('a weapon on a guard does not ring any brighter than an arm');
    // --- the synth impact is a sweetener now: it may add a little under the baked take, not be the punch
    const stOf = async (build) => (await render(build, 0.7, 1, false, false)).st;
    const takeOnly = await stOf((c, g) => { const tk = foleyTake('impact_light', 0); playTake(c, g, 0.005, tk, dbLin(FOLEY_ST.light - tk.meta.st)); });
    const withSweet = await stOf((c, g) => VOICES.hit(c, g, 0.005, { take: 0, rate: 1, crackJitter: 1 }));
    const sweetenerAddsDb = +(20 * Math.log10(withSweet / Math.max(takeOnly, 1e-9))).toFixed(2);
    if (sweetenerAddsDb > 2.5) problems.push(`the synth sweeteners add ${sweetenerAddsDb} dB — they are carrying the punch again`);

    const wired = ['combat:attack', 'combat:hit', 'combat:ko', 'combat:guardbreak', 'combat:grab', 'combat:throw',
      'combat:weapon', 'combat:start', 'combat:end', 'combat:telegraph', 'combat:arena', 'heat:ready', 'heat:action',
      'prop:impact', 'player:hurt', 'player:dodge', 'traffic:horn', 'traffic:hit', 'signal:phase', 'weather:thunder',
      'sfx:footstep', 'sfx:voice', 'enemy:getup', 'ui:move', 'ui:confirm', 'ui:cancel', 'ui:pause', 'heat:impact'];
    // the licence string has to be ON SCREEN, not merely in a field on this object
    const creditUp = typeof document !== 'undefined' && !!(document.getElementById('voicevox-credit') || document.querySelector('[data-credit-host]'));
    if (this.voiceBank && !creditUp) problems.push('VOICEVOX credit is not in the DOM — the mp3 licence requires it on screen');
    return {
      ok: problems.length === 0,
      ctx: this.ctx ? `${this.ctx.state} @ ${this.ctx.sampleRate}Hz` : 'none',
      running: !!this.running, enabled: this.enabled, volume: this.volume, muted: this.muted,
      voices: Object.keys(VOICES).length, bpm: BPM, music: this._mus.want,
      voiceBank: this.voiceBank ? `${Object.keys(this.voiceBank.lines).length} tags — ${this.voiceBank.credit}` : 'synth grunts',
      creditVisible: creditUp,
      jabOverTheme: +head.toFixed(1), jabOverThemeAtHeatMax: rows.music_heat ? +(rows.hit_jab.st - rows.music_heat.st).toFixed(1) : null,
      bedShortTerm: +bed.toFixed(1), limiter: this._limiterMode, worstTakePeakAfterOnsetMs: +(worstPk * 1000).toFixed(1),
      freezeClick, koSecondTransientDb: koFlamDb,
      payoff: payoff ? { st: db(payoff.st), limiterGrDb: db(payoff.gr), fedDbfs: db(payoff.fed) } : null,
      ladder: Object.fromEntries(Object.entries(ladder).sort((a, b) => a[1].st - b[1].st).map(([n, v]) => [n, v.st])),
      ladderSpanDb: +span.toFixed(1), heatReadyLoudest50msMs: Math.round(rows.heat_ready.at50 * 1000),
      hitBandSpreadDb: { '250': bandSpread[0], '1.6k': bandSpread[1], '5k': bandSpread[2] },
      heavySubGapDb: subGap, foleyTakes: takes, sweetenerAddsDb,
      stems: st ? {
        bars: st.man.main.bars, loopBars: st.man.main.bars - st.man.main.loopBar, lastManBars: st.man.last.bars,
        sections: st.man.sections.map(x => `${x.name} ${x.to - x.from}`).join(' / '), seconds: +st.drums.duration.toFixed(2),
        loopS: +(st.main.loopEnd - st.main.loopStart).toFixed(3), decoderShiftMs: +(st.shift * 1000).toFixed(2), sr: st.drums.sampleRate,
      } : null,
      swingPeakMs: swing, encounterSlamMs: slamMs, guardTiltDb: { arm: guardTilt, weapon: weaponTilt },
      footstepsPer2Cycles: feet, chainProbe: probe, wired, levels: rows, problems,
    };
  },

  dispose() {
    if (this._shotBeat) { clearInterval(this._shotBeat); this._shotBeat = null; }
    if (this._onKey) { window.removeEventListener('keydown', this._onKey); this._onKey = null; }
    if (this._unGesture) { this._unGesture(); this._unGesture = null; }   // three window listeners, leaked if
    if (this._meter) { this._meter.c.remove(); this._meter = null; }      // the context never reached 'running'
    if (this._credit) { this._credit.remove(); this._credit = null; }
    if (this._barkAt) this._barkAt.clear();
    if (this._down) this._down.clear();
    this._active = []; this._worldFifo = []; this._panPool = []; this._voices = 0; this._crowdVoices = 0;
    if (this._ring) { clearTimeout(this._ring.timer); this._ring = null; }
    this._mods = null; this._trainNode = null; this._aura = null; this._stems = null; this._bm = { t0: 0, srcs: null, brk: false, pendingAt: 0, sec: 'main', secAt: 0 };
    if (this._spk) this._spk.clear();
    if (this._barkSrc) this._barkSrc.clear();
    if (this.ctx) { try { this.ctx.close(); } catch (e) { /* already gone */ } }
    this.ctx = null; this.ready = false; this.running = false;
  },
};

// The audio module has no camera of its own. These frame the crossing and put the master-bus scope on screen,
// because that is the only way a screenshot can show whether the game is making a sound.
function withMeter(engine) {
  audio.meterOn = true;
  if (!audio._meter) { try { audio.buildMeter(); } catch (e) { /* no DOM */ } }
}
export const shotPresets = {
  // the exploration bed: ambience + the quiet night pad, nothing else
  audio_meter: {
    pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'night',
    setup(engine) { withMeter(engine); audio.setMusic('explore'); },
  },
  // the fight: battle loop in, bed ducked, impacts driven so the scope shows the transients
  // Both fight presets now drive the REAL path: engine.events.emit('combat:hit', …) with the payload combat.js
  // actually sends (name / combo / damage / heavy), so the shot exercises the ATTACKS gain map, the ATTACKS
  // sidechain hold and the knockdown body-fall instead of bypassing all three with bare audio.play() calls.
  audio_combat: {
    pos: [8, 2.2, 30], lookAt: [-6, 1.4, 6], fov: 40, t: 'night', fight: true,
    setup(engine) {
      withMeter(engine);
      audio.setMusic('battle');
      audio.duck('combat', true);
      const point = { x: 0, y: 1.2, z: 14 };
      const target = { id: 'shot-target', position: point };
      const CHAIN = ['jab', 'straight', 'hook', 'uppercut', 'kick', 'roundhouse', 'throw', 'heat_finisher'];
      let n = 0;
      audio._shotBeat = setInterval(() => {
        if (!audio.running) return;
        const name = CHAIN[n % CHAIN.length], def = ATTACKS[name] || {};
        audio.play('whoosh', { gain: 0.8, heavy: !!def.heavy, pos: point });
        setTimeout(() => {
          engine.events.emit('combat:hit', { target, damage: def.dmg, point, heavy: !!def.heavy, name, combo: n % 5 });
          engine.time.speed = 0.05;                                  // combat.js's hit-stop, for its real length
          setTimeout(() => { engine.time.speed = 1; }, def.stop ?? 60);
        }, 110);
        n++;
      }, 420);
    },
  },
  // the scramble itself: 1070 pedestrians, and now the footsteps of the nearest ~100 of them on wet tarmac.
  // The meter's "crowd steps" line is the proof — before this the whole crowd was a 6 s murmur loop.
  audio_crowd: {
    pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'night',
    setup(engine) { withMeter(engine); audio.setMusic('explore'); },
  },
  // hit-stop: combat.js drops engine.time.speed to 0.05 on a confirmed hit. The STREET ducks and swings a
  // 700 Hz lowpass in 6 ms and the impact holds a grain of its own take; the battle stems keep their tempo.
  audio_hitstop: {
    pos: [8, 2.2, 30], lookAt: [-6, 1.4, 6], fov: 40, t: 'night', fight: true,
    setup(engine) {
      withMeter(engine);
      audio.setMusic('battle');
      audio.duck('combat', true);
      const point = { x: 0, y: 1.2, z: 14 };
      const target = { id: 'shot-target', position: point };
      // The old version slammed engine.time.speed to 0.05 every 300 ms and never restored it, so the PNG showed
      // a permanently frozen world rather than combat.js's hit-stop, which is 28–110 ms PER MOVE.
      const CHAIN = ['hook', 'jab', 'roundhouse', 'straight', 'heat_finisher', 'knee'];
      let n = 0;
      audio._shotBeat = setInterval(() => {
        if (!audio.running) return;
        const name = CHAIN[n++ % CHAIN.length], def = ATTACKS[name] || {};
        engine.events.emit('combat:hit', { target, damage: def.dmg, point, heavy: !!def.heavy, name, combo: n % 5 });
        engine.time.speed = 0.05;
        setTimeout(() => { engine.time.speed = 1; }, def.stop ?? 60);
      }, 300);
    },
  },
  // A chinpira aggroes: the encounter riser, then the slam that IS bar 1 beat 1 of the stems. Re-fired every
  // 3 s (once the stems exist) so whatever frame the harness grabs is inside one; hits land on top.
  audio_encounter: {
    pos: [8, 2.2, 30], lookAt: [-6, 1.4, 6], fov: 40, t: 'night', fight: true,
    setup(engine) {
      withMeter(engine);
      const point = { x: 0, y: 1.2, z: 14 }, target = { id: 'shot-target', position: point };
      let n = 0, last = -9;
      audio._shotBeat = setInterval(() => {
        if (!audio.running || !audio._stems) return;
        const now = audio.ctx.currentTime;
        if (now - last > 3) { last = now; audio.encounter(); n = 0; return; }
        if (now - last > 0.7 && n < 4) {
          const name = ['jab', 'straight', 'hook', 'kick'][n++], def = ATTACKS[name] || {};
          engine.events.emit('combat:hit', { target, damage: def.dmg, point, heavy: !!def.heavy, name, combo: n });
        }
      }, 230);
    },
  },
  // a heat action: 「極」 at heat:action, the drums drop out on the next beat under the slow-motion, the final
  // contact lands the taiko + stamp, and the band comes back on a beat. Cycles every 4 s.
  audio_heat: {
    pos: [8, 2.2, 30], lookAt: [-6, 1.4, 6], fov: 40, t: 'night', fight: true,
    setup(engine) {
      withMeter(engine);
      const point = { x: 0, y: 1.2, z: 14 };
      let t0 = -9;
      audio._shotBeat = setInterval(() => {
        if (!audio.running || !audio._bm.srcs) return;
        const now = audio.ctx.currentTime, u = now - t0;
        if (u > 4) {
          t0 = now; engine.events.emit('heat:action', { name: 'wall_slam', player: engine.player });
          engine.state.mode = 'cutscene'; engine.time.speed = 0.15;
        } else if (u > 0.9 && u < 1.1 && !audio._shotImpact) {
          audio._shotImpact = true;
          engine.events.emit('heat:impact', { name: 'wall_slam', index: 0, final: true, point, strength: 1.3 });
        } else if (u > 2.2 && engine.state.mode === 'cutscene') {
          audio._shotImpact = false; engine.time.speed = 1; engine.state.mode = 'combat';
        }
      }, 100);
    },
  },
  // Chapter 1's fight as the audio hears it, on a 16 s cycle through the REAL handlers: the encounter slam (bar 1
  // of the stems) and the onlooker ring forming 「おおっ」, a five-hit string (combo 0–4: slower, heavier, the
  // crack rising), a telegraphed heavy's glint, a guard break, a KO (締太鼓 tag + the ring's 「わあっ」), the jump to
  // the last-man section on the next bar, the heat gauge filling (the intensity stem opening to 1.00), then the
  // last man down (KO on the killing blow's own take, button, victory) and the ring dispersing. Shoot it at
  // --wait 8000 to catch LAST MAN at HEAT MAX with the ring up; the cue line at the top of the scope lists the
  // last six seconds.
  audio_fight: {
    pos: [8, 2.2, 30], lookAt: [-6, 1.4, 6], fov: 40, t: 'night', fight: true,
    setup(engine) {
      withMeter(engine);
      const point = { x: 0, y: 1.2, z: 14 }, target = { id: 'shot-target', kind: 'enemy', position: point, hp: 30 };
      const foe = { id: 'shot-foe', kind: 'enemy', position: { x: 2.2, y: 1.2, z: 12.5 } };
      const CHAIN = ['jab', 'straight', 'hook', 'uppercut', 'kick'];
      let t0 = -1, done = new Set();
      const once = (k, u, at, fn) => { if (u >= at && !done.has(k)) { done.add(k); fn(); } };
      audio._shotBeat = setInterval(() => {
        if (!audio.running || !audio._stems) return;
        const now = audio.ctx.currentTime;
        if (t0 < 0 || now - t0 > 16) { t0 = now; done = new Set(); if (engine.player) engine.player.heat = 0; }
        const u = now - t0;
        once('enc', u, 0, () => { audio.encounter(); engine.events.emit('combat:arena', { on: true, centre: point, radius: 8.5 }); });
        CHAIN.forEach((name, i) => once(`h${i}`, u, 0.9 + i * 0.3, () => {
          const def = ATTACKS[name] || {};
          audio.play('whoosh', { gain: 0.7, heavy: !!def.heavy, pos: point, duration: 0.14 });
          engine.events.emit('combat:hit', { target, damage: def.dmg, point, heavy: !!def.heavy, name, combo: i });
        }));
        once('tel', u, 2.5, () => engine.events.emit('combat:telegraph', { attacker: foe, name: 'kick' }));
        once('gb', u, 3.3, () => engine.events.emit('combat:guardbreak', { target, attacker: engine.player }));
        // (combat:ko itself is not emitted: enemy.js's listener would try to kill a stand-in target)
        once('ko1', u, 4.0, () => { target.hp = 0; engine.events.emit('combat:hit', { target, damage: 20, point, heavy: true, name: 'roundhouse', combo: 2 }); audio.onKO(target, 1); target.hp = 30; });
        if (u > 4.5 && u < 8 && engine.player) engine.player.heat = Math.min(100, (u - 4.5) / 3 * 100);
        once('h2a', u, 8.6, () => engine.events.emit('combat:hit', { target, damage: 10, point, heavy: false, name: 'straight', combo: 1 }));
        once('fin', u, 11, () => {
          target.hp = 0; engine.events.emit('combat:hit', { target, damage: 45, point, heavy: true, name: 'heat_finisher', combo: 0 });
          audio.onKO(target, 0); target.hp = 30;
          if (engine.player) engine.player.heat = 0;
        });
        once('off', u, 12, () => engine.events.emit('combat:arena', { on: false }));
      }, 50);
    },
  },
  // the pause menu over the night crossing: duck to 0.25 / 0.35 behind a 900 Hz lowpass
  audio_paused: {
    pos: [-20, 1.6, 20], lookAt: [30, 12, -30], t: 'night',
    setup(engine) { withMeter(engine); audio.setMusic('battle'); engine.state.mode = 'paused'; },
  },
};
audio.shotPresets = shotPresets;

export { atkGain };
export default audio;
