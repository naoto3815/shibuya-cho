// [combat] The fight's final blow (龍が如く, Dragon Engine era: 極2 / 6 / 7外伝) — ONE tuning block + the shared timeline.
//
// Every module that plays a part reads the same clock (combat.finale.t, REAL seconds since the contact frame) through
// the curves below, so time, lens, grade and sound always move together:
//   combat.js   owns engine.time.speed (freeze -> slow hold -> ease-in ramp); the contact (white-hot core, shockwave
//               rings, sparks, hanging sweat / spit), his flight (a higher arc, a turn in the air) and the landing splash
//   camera.js   whips in to the close shot on the victim, drifts (dolly + orbit + roll swing) while he flies, eases back
//   postfx.js   radial speed streaks on the contact, the grade (colour out, hot highlights, deeper blacks), CA
//   audio.js    the layered finisher (sub drop, crunch, whip crack) ringing into a dark tail that sinks in pitch with
//               time, heartbeat pulses in the hold, a reversed swell landing on his body fall + splash; street and
//               music low-passed and pitched down, back with the ramp
// The results flow (勝利 / missions' results card) waits for the sequence to finish (combat.afterFinale).
//
// Timeline, real seconds from the contact frame (defaults):
//   0.00 - 0.12  freeze at 0.02x, 2-frame white-hot flash on the contact, one hard kick, radial blur (fades by 0.35)
//   0.00 - 0.15  the lens whips in from the gameplay framing to the close shot (quartic ease-out)
//   0.12 - 1.02  slow motion at 0.13x; the lens creeps in and orbits round him as he is launched
//   1.02 - 1.72  time ramps back to 1.0 (ease-in); grade and sound ease back with it; the swell rises into ...
//   ~1.72        ... his landing (0.42 s of game time after the contact): body fall + splash at normal speed
//   1.02 - 1.97  the lens eases back to the gameplay framing (no cut); then the results run
//
// Tune by eye: change a number here and reload. ?shot=final_blow&t=<seconds> freezes the sequence at any instant.
export const FINAL_BLOW = {
  // --- time
  freeze: 0.12,        // s real: impact freeze on the contact frame
  freezeSpeed: 0.02,   // game speed during the freeze
  slow: 0.13,          // game speed of the slow motion that follows
  hold: 0.90,          // s real the slow motion holds
  ramp: 0.70,          // s real to ease back to 1.0 (ease-in: slow at first, then quickly)
  // --- lens
  whip: 0.15,          // s real: gameplay framing -> close shot (strong ease-out)
  back: 0.95,          // s real: close shot -> gameplay framing, starting with the ramp
  fovIn: 27,           // deg field of view of the close shot (widened up to fovMax only if the faces do not fit)
  fovMax: 30,
  dist: 2.5,           // m lens -> victim (horizontal); the search tries dist -0.4 / +0.3
  height: 1.38,        // m lens above his feet: under the eye line, looking a touch up
  roll: 4,             // deg Dutch roll (the side that sends his fall downhill)
  orbit: 12,           // deg the lens orbits round him during the slow motion
  dolly: 0.35,         // m it creeps in over the same time
  kick: 0.18,          // m the one hard camera kick along the blow ...
  trauma: 0.45,        // ... and the rumble under it (0..1, over 0.25 s)
  rollSwing: 3,        // deg the Dutch roll swings further (and back) as the lens orbits
  // --- picture
  blur: 1.7,           // radial speed streaks on the contact at t = 0 ...
  blurT: 0.4,          // ... gone after this many seconds
  flash: 0.034,        // s the white-hot core burns (2 frames at 60 fps)
  flashGain: 1.7,      // brightness of that core (1 = an ordinary heavy's burst x 2.5)
  screenFlash: 0.12,   // the two-frame full-screen lift under it
  ring: 2.2,           // m the shockwave ring round the contact grows to
  sparks: 70,          // sparks thrown from the contact
  spray: 40,           // sweat / spit droplets that hang in the air through the slow motion
  splash: 2.4,         // the wet-road splash where he lands (1 = an ordinary knockdown)
  launch: 0.45,        // m his flight arcs this much higher than the knockdown alone
  spin: 40,            // deg he turns in the air on the way down
  land: 0.42,          // s of GAME time from the contact to his landing (the knockdown clip's floor frame)
  desat: 0.22,         // colour pulled out during the slow motion (warm light and the contact kept)
  warm: 1.3,           // hot highlights: the bright end runs amber-white
  crush: 0.45,         // deeper blacks: the toe is pulled down this much
  contrast: 0.2,       // added contrast
  vignette: 0.22,      // added vignette
  ca: 0.0035,          // added lateral chromatic aberration
  // --- sound
  lp: 600,             // Hz: the street and the music are low-passed to this at full slow motion
  pitch: 0.86,         // playback rate of the street murmur / onlooker ring / stems at full slow motion
  voice: 0.72,         // playback rate of his KO cry
  sfx: 1.0,            // gain of the final blow's own layers (the hit, tail, pulses, swell, landing)
  tail: 1.1,           // s real the finisher's dark tail rings through the slow motion
  tailPitch: 0.5,      // playback rate the tail sinks to as time slows (0.5 = an octave down)
  beats: [0.36, 0.8],  // s real: heartbeat / pressure pulses during the hold
  swell: 0.75,         // s the reversed-cymbal swell rises into his landing
};

const F = FINAL_BLOW;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** the whole sequence, real seconds: the ramp and the lens return, whichever ends later */
export function fbEnd() { return F.freeze + F.hold + Math.max(F.ramp, F.back); }

/** game speed at real time t */
export function fbSpeed(t) {
  if (t < F.freeze) return F.freezeSpeed;
  const h = t - F.freeze - F.hold;
  if (h < 0) return F.slow;
  if (h >= F.ramp) return 1;
  const u = h / F.ramp;
  return F.slow + (1 - F.slow) * u * u;
}

/** 0..1 weight of the slow-motion LOOK and SOUND (1 through the freeze and the hold, easing out with the ramp) */
export function fbLook(t) {
  const h = t - F.freeze - F.hold;
  if (h <= 0) return t < 0 ? 0 : 1;
  if (h >= F.ramp) return 0;
  const u = h / F.ramp;
  return 1 - u * u;
}

/** 0..1 weight of the close shot over the gameplay framing */
export function fbCam(t) {
  if (t <= 0) return 0;
  if (t < F.whip) { const k = 1 - t / F.whip; return 1 - k * k * k * k; }
  const h = t - F.freeze - F.hold;
  if (h <= 0) return 1;
  if (h >= F.back) return 0;
  const u = h / F.back;
  return 1 - u * u * u * (u * (u * 6 - 15) + 10);          // smootherstep: no velocity step at either end
}

/** 0..1 progress of the lens drift (dolly + orbit), from the contact to the end of the return */
export function fbDrift(t) {
  const u = clamp01(t / (F.freeze + F.hold + F.back));
  return Math.sin(u * Math.PI * 0.5);                         // moving from the first frame, settling at the end
}

/** the REAL time (s from the contact) at which `game` seconds of game time have passed along fbSpeed — when his
 *  landing (FINAL_BLOW.land) will happen, so the swell can be scheduled to arrive on it to the sample */
export function fbRealAt(game) {
  let g = 0, t = 0;
  const dt = 1 / 240;
  while (g < game && t < 10) { g += fbSpeed(t) * dt; t += dt; }
  return t;
}

/** radial blur weight at real time t */
export function fbBlur(t) {
  if (t < 0 || t >= F.blurT) return 0;
  const k = 1 - t / F.blurT;
  return F.blur * k * k;
}
