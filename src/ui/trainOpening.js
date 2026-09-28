// Approved 67.25-second opening includes the letter, Voice1 and Shibuya descent.
// VP8 avoids the black video surface observed with VP9 in the in-app browser.
export const TRAIN_SHOTS = [{
  src: '/shibuya-cho/assets/opening/twin-dragon-opening-v5-vp8.webm',
  fallbackSrc: '/shibuya-cho/assets/opening/twin-dragon-opening-v5.mp4',
  poster: '/shibuya-cho/assets/opening/opening-v5-poster.jpg',
  duration: 67.25, mastered: true, cues: [],
}];

export function playTrainOpening(engine, onComplete, shots = TRAIN_SHOTS) {
  const opening = shots === TRAIN_SHOTS;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/shibuya-cho/src/ui/trainOpening.css'; document.head.append(link);
  const root = document.createElement('section');
  root.id = 'train-opening'; root.dataset.opening = String(opening);
  root.setAttribute('aria-label', opening ? 'オープニング 東京へ' : 'ファイトクラブ登場');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
  root.innerHTML = `<div class="train-stage"><div class="train-frame"><video playsinline preload="auto"></video><div class="train-shade"></div></div>
    <div class="train-card" hidden><small></small><h1></h1><p></p><span></span></div>
    <div class="train-location"></div><div class="train-caption" aria-live="polite"><small></small><p></p></div></div>
    <button class="train-resume" type="button" hidden>映像を再生</button>
    <div class="train-controls"><button class="train-pause" type="button">一時停止</button><button class="train-skip" type="button">スキップ <span>Esc</span></button></div>
    <div class="train-progress" role="progressbar" aria-label="再生進行" aria-valuemin="0" aria-valuemax="100"></div>`;
  document.body.append(root); document.body.classList.add('train-playing');
  document.exitPointerLock?.();
  const prior = { mode: engine.state.mode, frozen: engine.state.frozen, videoPlaying: engine.state.videoPlaying, input: engine.input?.enabled, focus: document.activeElement };
  engine.state.mode = 'paused'; engine.state.frozen = true; engine.state.videoPlaying = true;
  if (engine.input) engine.input.enabled = false;
  const video = root.querySelector('video'), stage = root.querySelector('.train-stage');
  const card = root.querySelector('.train-card'), frame = root.querySelector('.train-frame');
  const resume = root.querySelector('.train-resume'), pause = root.querySelector('.train-pause');
  const skip = root.querySelector('.train-skip'), caption = root.querySelector('.train-caption');
  const location = root.querySelector('.train-location'), progress = root.querySelector('.train-progress');
  const audio = engine.get('audio');
  const previousMusic = audio?._mus?.want;
  const previousAmbience = audio?.ambience ? !audio.ambience.off : undefined;
  audio?.setMusic?.('none'); audio?.setAmbience?.(false);
  video.setAttribute('aria-label', opening ? '渋沢が東京へ向かう映像' : '撮影しながら登場するファイトクラブの三人');
  let index = -1, finished = false, frameId, loadTimer, elapsed = 0, last = performance.now();
  let userPaused = false, blocked = false, waiting = false, captionText = '', usingFallback = false;
  const durations = shots.map(s => s.duration || 8);
  const total = durations.reduce((a, b) => a + b, 0);
  const isCard = () => shots[index]?.kind === 'card';
  const stopped = () => userPaused || document.hidden || blocked || waiting;
  const finish = () => {
    if (finished) return;
    finished = true; cancelAnimationFrame(frameId); clearTimeout(loadTimer);
    video.pause(); video.removeAttribute('src'); video.load();
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', visibility);
    root.remove(); link.remove(); document.body.classList.remove('train-playing');
    Object.assign(engine.state, { mode: prior.mode, frozen: prior.frozen, videoPlaying: prior.videoPlaying ?? false });
    if (engine.input) engine.input.enabled = prior.input;
    if (previousMusic !== undefined) audio?.setMusic?.(previousMusic);
    if (previousAmbience !== undefined) audio?.setAmbience?.(previousAmbience);
    prior.focus?.focus?.({ preventScroll: true });
    onComplete();
  };
  const showRetry = message => {
    if (finished) return;
    blocked = true; waiting = false; clearTimeout(loadTimer);
    resume.textContent = message; resume.hidden = false;
  };
  const play = () => {
    if (finished || isCard() || userPaused || document.hidden) return;
    blocked = false;
    video.play().then(() => { if (!finished) resume.hidden = true; }).catch(error => {
      if (!finished && !userPaused && !document.hidden && error.name !== 'AbortError') showRetry(video.error ? '動画を読み込めません — 再試行' : '映像を再生');
    });
  };
  const togglePause = () => {
    userPaused = !userPaused; pause.textContent = userPaused ? '再生' : '一時停止';
    last = performance.now();
    if (userPaused) video.pause(); else play();
  };
  const visibility = () => { last = performance.now(); if (document.hidden) video.pause(); else play(); };
  const onKey = event => {
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); finish(); }
    if (event.key === 'Tab') {
      event.preventDefault();
      const buttons = [resume, pause, skip].filter(b => !b.hidden);
      const next = (buttons.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  };
  const next = () => {
    if (finished) return;
    clearTimeout(loadTimer); video.pause(); index++;
    if (index >= shots.length) { finish(); return; }
    elapsed = 0; last = performance.now(); blocked = false; waiting = false; resume.hidden = true;
    const shot = shots[index]; root.dataset.shot = String(index); root.dataset.mastered = String(!!shot.mastered); usingFallback = false; stage.style.opacity = shot.mastered ? '1' : '0';
    card.hidden = !isCard(); frame.hidden = isCard();
    location.textContent = shot.label || '';
    caption.querySelector('small').textContent = ''; caption.querySelector('p').textContent = ''; captionText = '';
    if (isCard()) {
      card.querySelector('small').textContent = shot.eyebrow || '';
      card.querySelector('h1').textContent = shot.title || '';
      card.querySelector('p').textContent = shot.detail || '';
      card.querySelector('span').textContent = shot.signature || '';
    } else {
      waiting = true; video.poster = shot.poster || ''; video.src = shot.src; video.load();
      loadTimer = setTimeout(() => showRetry('読み込みが遅れています — 再試行'), 15000);
      play();
    }
  };
  const tick = now => {
    if (finished) return;
    const delta = Math.min((now - last) / 1000, .1); last = now;
    const shot = shots[index];
    if (shot) {
      if (isCard()) { if (!stopped()) elapsed += delta; }
      else elapsed = video.currentTime || 0;
      const duration = isCard() ? durations[index] : (Number.isFinite(video.duration) ? video.duration : durations[index]);
      // Fades follow media time, so buffering/hidden tabs cannot desynchronise subtitles.
      const envelope = shot.mastered ? 1 : Math.max(0, Math.min(1, elapsed / .55, (duration - elapsed) / .45));
      stage.style.opacity = String(envelope);
      const volume = Math.max(0, Math.min(1, audio?.getVolume?.() ?? .75));
      video.volume = volume * envelope; video.muted = !!audio?.muted;
      location.style.opacity = String(Math.max(0, Math.min(1, (4 - elapsed) / .8)));
      const cue = shot.cues?.find(c => elapsed >= c.start && elapsed < c.end);
      const text = cue?.text ?? (shot.cues ? '' : (shot.second && elapsed / duration >= .5 ? shot.second : shot.text || ''));
      if (text !== captionText) {
        captionText = text; caption.querySelector('p').textContent = text;
        caption.querySelector('small').textContent = text ? cue?.speaker || (opening ? '柊からの手紙' : '') : '';
      }
      const value = Math.min(100, (durations.slice(0, index).reduce((a, b) => a + b, 0) + Math.min(1, elapsed / duration) * durations[index]) / total * 100);
      root.style.setProperty('--progress', `${value}%`); progress.setAttribute('aria-valuenow', String(Math.round(value)));
      if (isCard() && elapsed >= duration) next();
    }
    if (!finished) frameId = requestAnimationFrame(tick);
  };
  video.addEventListener('playing', () => { if (!finished) { waiting = false; blocked = false; clearTimeout(loadTimer); resume.hidden = true; } });
  video.addEventListener('waiting', () => { waiting = true; });
  video.addEventListener('ended', next);
  video.addEventListener('error', () => {
    if (finished) return;
    const shot = shots[index];
    if (shot?.fallbackSrc && !usingFallback) {
      usingFallback = true; waiting = true;
      video.src = shot.fallbackSrc; video.load(); play();
    } else showRetry('動画を読み込めません — 再試行');
  });
  resume.onclick = () => { blocked = false; userPaused = false; pause.textContent = '一時停止'; if (video.error) video.load(); play(); };
  pause.onclick = togglePause; skip.onclick = finish;
  window.addEventListener('keydown', onKey, true); document.addEventListener('visibilitychange', visibility);
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) root.addEventListener(type, e => e.stopPropagation());
  skip.focus(); next(); frameId = requestAnimationFrame(tick);
  return { finish };
}
