// Preserve the approved photograph pixel-for-pixel; SVG silhouettes move independently.
const ART = '/shibuya-cho/assets/menu/double-dragon-duo.png';
const SILHOUETTES = {
  kento: 'M550 941L587 864 605 755 617 665Q629 577 663 550L728 519 797 480 838 457 854 435 857 411Q834 397 831 363L822 319 823 276 814 255 821 217 824 182 844 145 869 117 919 90 941 72 979 67 1015 48 1053 56 1083 58 1108 77 1127 89 1139 119 1151 148 1152 181 1144 209 1149 239 1137 270 1125 289 1125 322Q1121 351 1102 362L1103 404 1094 439 1117 466 1161 493 1220 524Q1279 551 1290 616L1306 743 1312 941Z',
  hiiragi: 'M1157 523L1174 484 1200 450 1188 443 1211 422 1210 393 1217 352 1216 289 1219 244 1230 197 1253 153 1285 118 1326 87 1381 68 1433 61 1469 72 1503 87 1528 116 1538 153 1543 195 1527 235 1529 276 1514 311 1496 337 1484 355 1477 379 1465 403 1460 420 1464 454 1494 486 1527 566 1550 655 1571 765 1604 868 1631 941 1289 941 1258 773 1215 619Z',
};
export function titleCharacters() {
  return ['hiiragi', 'kento'].map(name => `<svg class="title-character title-${name}" viewBox="0 0 1672 941" preserveAspectRatio="xMaxYMid slice" aria-hidden="true"><defs><filter id="title-edge-${name}" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="1.5"/></filter><mask id="title-cut-${name}" maskUnits="userSpaceOnUse" x="0" y="0" width="1672" height="941"><path d="${SILHOUETTES[name]}" fill="white" filter="url(#title-edge-${name})"/></mask></defs><image href="${ART}" width="1672" height="941" mask="url(#title-cut-${name})"/></svg>`).join('');
}

// Soft air sweep followed by inharmonic steel partials; no external audio download.
export function renderTitleBlade(ctx, dest, t, { pitch = 1, pan = 0, weight = 1 } = {}) {
  const nodes = [], stereo = ctx.createStereoPanner(); stereo.pan.value = pan; stereo.connect(dest);
  const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * .23), ctx.sampleRate);
  const samples = noise.getChannelData(0); let seed = 41;
  for (let i = 0; i < samples.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; samples[i] = seed / 2147483648 - 1; }
  const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), air = ctx.createGain();
  src.buffer = noise; filter.type = 'bandpass'; filter.Q.value = .8;
  filter.frequency.setValueAtTime(900, t); filter.frequency.exponentialRampToValueAtTime(6500, t + .18);
  air.gain.setValueAtTime(.0001, t); air.gain.exponentialRampToValueAtTime(.22 * weight, t + .14); air.gain.exponentialRampToValueAtTime(.0001, t + .23);
  src.connect(filter).connect(air).connect(stereo); src.start(t); src.stop(t + .24); nodes.push(src, filter, air);
  [1420, 2173, 3317, 4919].forEach((hz, i) => {
    const osc = ctx.createOscillator(), env = ctx.createGain(); const hit = t + .17;
    osc.frequency.setValueAtTime(hz * pitch * 1.14, hit); osc.frequency.exponentialRampToValueAtTime(hz * pitch, hit + .065);
    env.gain.setValueAtTime(.0001, hit); env.gain.exponentialRampToValueAtTime(.07 * weight / (1 + i * .7), hit + .006);
    env.gain.exponentialRampToValueAtTime(.0001, hit + .95 - i * .12);
    osc.connect(env).connect(stereo); osc.start(hit); osc.stop(hit + 1); nodes.push(osc, env);
  });
  return () => { for (const n of nodes) { if (n.stop) { try { n.stop(); } catch {} } n.disconnect(); } stereo.disconnect(); };
}

let artReady;
function preloadArt() {
  if (!artReady) artReady = Promise.all([ART, '/shibuya-cho/assets/menu/twin-dragon-logo-v1.png'].map(src => {
    const img = new Image(); img.src = src; return img.decode().catch(() => {});
  }));
  return artReady;
}
export function createTitleEntrance(root, getAudio) {
  let generation = 0, cleanups = [], tailTimer, cancelBootWait;
  const stop = () => {
    generation++; cancelBootWait?.(); cancelBootWait = null;
    clearTimeout(tailTimer); cleanups.forEach(fn => fn()); cleanups = [];
    root.classList.remove('title-entering', 'title-pending');
  };
  const play = async (gesture = false) => {
    stop(); const run = generation; const audio = getAudio();
    root.classList.add('title-pending');
    if (gesture) {
      audio?.ensure?.();
      if (audio?.ctx?.state === 'suspended') await audio.ctx.resume().catch(() => {});
    }
    await preloadArt();
    // Booted precedes shader warm-up. Never spend the entrance behind the loading overlay.
    const boot = document.getElementById('boot');
    if (boot && run === generation) await new Promise(resolve => {
      const observer = new MutationObserver(() => { if (!boot.isConnected) done(); });
      const done = () => { observer.disconnect(); cancelBootWait = null; resolve(); };
      cancelBootWait = done; observer.observe(document.body, {childList:true});
      if (!boot.isConnected) done();
    });
    if (run !== generation || root.hidden || root.dataset.page !== 'home') return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const button = root.querySelector('[data-action=title-replay]');
    const sound = audio?.enabled && !audio.muted && audio.ctx?.state === 'running' && audio.bus?.ui;
    if (button) button.textContent = audio?.enabled && !audio.muted && !sound ? '音付きで演出を再生 ↻' : '演出を再生 ↻';
    // A layout flush restarts all three CSS tracks together, including repeated button presses.
    void root.offsetWidth; root.classList.remove('title-pending'); root.classList.add('title-entering');
    if (sound) {
      const t = audio.ctx.currentTime + .015;
      // Steel transient is 170 ms after cue onset: match the character stops at 72% and logo lock.
      const cues = reduced ? [[0, 1, 0, .7]] : [[1.276, .88, -.35, .8], [1.776, 1.12, .35, .8], [2.58, .75, 0, 1]];
      cleanups = cues.map(([delay, pitch, pan, weight]) => renderTitleBlade(audio.ctx, audio.bus.ui, t + delay, {pitch, pan, weight}));
      tailTimer = setTimeout(() => { cleanups.forEach(fn => fn()); cleanups = []; }, 4200);
    }
  };
  const visibility = () => { if (document.hidden) stop(); };
  document.addEventListener('visibilitychange', visibility);
  return { play, stop };
}
