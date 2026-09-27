// [foundation] keyboard / mouse / gamepad -> actions  (§4)
//   input.move    THREE.Vector2  x: right(+)/left(-), y: forward(+)/back(-)  -- relative to the camera view, length <= 1
//   input.look    THREE.Vector2  mouse delta (pointer-locked) or right stick, per frame
//   input.buttons { attack, heavy, grab, dodge, guard, run, interact, lockOn, pause, heat } each { down, pressed, released }
//   input.pointerLocked, input.gamepadConnected, input.update() (called by engine at the start of every frame)
import * as THREE from 'three';

const KEYMAP = {
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  ShiftLeft: 'run', ShiftRight: 'run', Space: 'dodge',
  KeyJ: 'attack', KeyK: 'heavy', KeyL: 'grab', KeyI: 'guard', KeyE: 'interact',
  KeyQ: 'lockOn', KeyR: 'heat', Escape: 'pause',
};
export const BUTTONS = ['attack', 'heavy', 'grab', 'dodge', 'guard', 'run', 'interact', 'lockOn', 'pause', 'heat'];
// standard gamepad mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 back, 9 start, 10 LS, 11 RS, 12..15 dpad
const PADMAP = { dodge: [0], grab: [1], attack: [2], heavy: [3], lockOn: [4], guard: [5], run: [6, 10], heat: [7], pause: [9], interact: [12] };

export function createInput(canvas) {
  const keys = new Set();
  const mouse = { left: false, right: false, dx: 0, dy: 0 };
  const buttons = {};
  for (const b of BUTTONS) buttons[b] = { down: false, pressed: false, released: false };
  // [mobile] the on-screen controls (src/ui/touchControls.js) write here and update() merges it like a gamepad:
  //   virtual.active   the touch layer is up (camera.js then takes input.look like a locked mouse)
  //   virtual.move     joystick, same axes as input.move      virtual.look  drag delta in px, consumed every frame
  //   virtual.press(b) / virtual.release(b)  a button held on screen; a tap shorter than one frame still counts once
  const virtual = {
    active: false, move: new THREE.Vector2(), look: new THREE.Vector2(), held: {}, latch: {},
    press(b) { virtual.held[b] = true; virtual.latch[b] = true; },
    release(b) { virtual.held[b] = false; },
    releaseAll() { for (const k in virtual.held) virtual.held[k] = false; virtual.move.set(0, 0); },
  };
  const input = {
    move: new THREE.Vector2(),
    look: new THREE.Vector2(),
    buttons,
    pointerLocked: false,
    gamepadConnected: false,
    enabled: true,
    anyKeyDown: false,
    virtual,
    update,
    dispose,
  };

  const onKeyDown = (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (KEYMAP[e.code] && e.code !== 'Escape') e.preventDefault();
  };
  const onKeyUp = (e) => { keys.delete(e.code); };
  const onBlur = () => { keys.clear(); mouse.left = mouse.right = false; };
  const onMouseDown = (e) => {
    if (e.button === 0) mouse.left = true; else if (e.button === 2) mouse.right = true;
    if (e.target === canvas && !input.pointerLocked) {
      try { canvas.requestPointerLock?.(); } catch (_) { /* headless / unsupported */ }
    }
  };
  const onMouseUp = (e) => { if (e.button === 0) mouse.left = false; else if (e.button === 2) mouse.right = false; };
  const onMouseMove = (e) => {
    if (!input.pointerLocked) return;
    mouse.dx += e.movementX || 0; mouse.dy += e.movementY || 0;
  };
  const onLockChange = () => { input.pointerLocked = document.pointerLockElement === canvas; };
  const onContext = (e) => e.preventDefault();
  const onPadConnect = () => { input.gamepadConnected = true; };
  const onPadDisconnect = () => { input.gamepadConnected = false; };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onLockChange);
  canvas.addEventListener('contextmenu', onContext);
  window.addEventListener('gamepadconnected', onPadConnect);
  window.addEventListener('gamepaddisconnected', onPadDisconnect);

  const prev = {};
  for (const b of BUTTONS) prev[b] = false;

  function readPad() {
    let pad = null;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) { if (p && p.connected) { pad = p; break; } }
    } catch (_) { pad = null; }
    return pad;
  }

  function update() {
    const pad = readPad();
    input.gamepadConnected = !!pad;
    const dead = (v) => (Math.abs(v) < 0.18 ? 0 : v);
    // --- move
    let mx = 0, my = 0;
    if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) my += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) my -= 1;
    if (pad) { mx += dead(pad.axes[0] || 0); my -= dead(pad.axes[1] || 0); }
    if (virtual.active) { mx += virtual.move.x; my += virtual.move.y; }
    input.move.set(mx, my);
    if (input.move.lengthSq() > 1) input.move.normalize();
    // --- look
    let lx = mouse.dx, ly = mouse.dy;
    if (pad) { lx += dead(pad.axes[2] || 0) * 18; ly += dead(pad.axes[3] || 0) * 18; }
    lx += virtual.look.x; ly += virtual.look.y; virtual.look.set(0, 0);
    input.look.set(lx, ly);
    mouse.dx = 0; mouse.dy = 0;
    // --- buttons
    const keyAct = new Set();
    for (const code of keys) { const a = KEYMAP[code]; if (a) keyAct.add(a); }
    let vAny = false;
    for (const b of BUTTONS) {
      let down = keyAct.has(b);
      if (b === 'attack' && mouse.left) down = true;
      if (b === 'heavy' && mouse.right) down = true;
      if (virtual.held[b] || virtual.latch[b]) { down = true; vAny = true; }
      virtual.latch[b] = false;
      if (pad && PADMAP[b]) for (const i of PADMAP[b]) { const pb = pad.buttons[i]; if (pb && (pb.pressed || pb.value > 0.5)) down = true; }
      if (!input.enabled && b !== 'pause') down = false;
      const st = buttons[b];
      st.pressed = down && !prev[b];
      st.released = !down && prev[b];
      st.down = down;
      prev[b] = down;
    }
    input.anyKeyDown = keys.size > 0 || mouse.left || mouse.right || vAny;
    if (!input.enabled) { input.move.set(0, 0); input.look.set(0, 0); }
  }

  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('pointerlockchange', onLockChange);
    canvas.removeEventListener('contextmenu', onContext);
    window.removeEventListener('gamepadconnected', onPadConnect);
    window.removeEventListener('gamepaddisconnected', onPadDisconnect);
  }
  return input;
}

export default createInput;
