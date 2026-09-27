// [player] Player controller: camera-relative WASD, run, dodge, attacks (via combat), guard, lock-on, HP/heat.
//   engine.player = entity { id, name, kind:'player', group, position, yaw, humanoid, radius, height, hp, hpMax, heat,
//                            velocity, state, stateT, alive, lockTarget, forward(out) }
//   player.entity  player.respawn(pos, yaw)
import * as THREE from 'three';
import { createHumanoid } from './humanoid.js';
import { HERO_HEIGHT } from './heroProportions.js';
import { HERO_WALK_SPEED, RUN_SPEED } from './animations.js';

const WALK = HERO_WALK_SPEED, RUN = RUN_SPEED, DODGE_SPEED = 9.0, DODGE_T = 0.32;
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _d = new THREE.Vector3(), _m = new THREE.Vector3();

function makeEntity(engine, humanoid, pos, yaw) {
  const group = humanoid.group;
  group.position.copy(pos);
  group.rotation.y = yaw;
  engine.scene.add(group);
  const e = {
    id: 'player', name: '渋沢 健人', kind: 'player', type: 'kento', group, position: group.position, yaw, humanoid,
    radius: 0.35, height: HERO_HEIGHT, hp: 100, hpMax: 100, heat: 0, velocity: new THREE.Vector3(), state: 'idle', stateT: 0,
    alive: true, grounded: true, lockTarget: null, isPlayer: true, combo: 0, comboT: 0, guard: false, moveSpeed: 0,
    forward(out = new THREE.Vector3()) { return out.set(Math.sin(e.yaw), 0, Math.cos(e.yaw)); },
    setState(s, t = 0) { e.state = s; e.stateT = t; },
  };
  return e;
}

const player = {
  name: 'player',
  entity: null,
  lightChain: ['jab', 'straight', 'hook', 'uppercut'],
  heavyChain: ['kick', 'roundhouse'],
  chainIdx: 0, chainT: 0,

  init(engine) {
    this.engine = engine;
    const city = engine.get('city');
    const sp = city && city.getSpawnPoints ? city.getSpawnPoints().player : { position: new THREE.Vector3(24, 0, 30), yaw: -3 * Math.PI / 4 };
    const h = createHumanoid({ variant: 'kento', seed: 1 });
    const e = makeEntity(engine, h, sp.position, sp.yaw);
    e.position.y = engine.world ? engine.world.groundHeight(e.position.x, e.position.z) : 0;
    this.entity = e;
    engine.player = e;
    const combat = engine.get('combat');
    if (combat && typeof combat.register === 'function') combat.register(e);
    h.play(engine.state.mode === 'combat' ? 'idle_combat' : 'idle', { fade: 0 });
    engine.events.on('combat:ko', ({ target }) => { if (target === e) { e.alive = false; e.setState('dead'); h.play('knockdown', { loop: false }); } });
    engine.events.on('traffic:hit', (ev) => { if (ev && ev.target === e) this.hitByCar(ev); });
  },

  // Run down by a vehicle: launched along the car's heading, damage scaled by speed and mass, then the
  // normal knockdown -> getup chain takes over (update() already drives 'down').
  hitByCar({ speed, mass = 1, dir, point }) {
    const e = this.entity, engine = this.engine;
    if (!e || !e.alive || e.state === 'down' || e.state === 'dead') return;
    const hud = engine.get('hud'), cam = engine.get('camera'), combat = engine.get('combat');
    const dmg = Math.round(Math.min(45, 6 + speed * 2.4) * mass);
    e.hp = Math.max(0, e.hp - dmg);
    // move() pins y to the ground every frame, so the throw is horizontal-only; the long slide plus the
    // knockdown clip is what sells it.
    const launch = Math.min(22, 9 + speed * 1.5) * mass;
    e.velocity.set(dir.x * launch, 0, dir.z * launch);
    e.yaw = Math.atan2(-dir.x, -dir.z);                  // thrown onto his back, facing the car
    e.setState('down');
    e.humanoid.play('knockdown', { loop: false, force: true });
    if (combat) {
      if (typeof combat.hitStop === 'function') combat.hitStop(110);
      if (combat.vfx && typeof combat.vfx.impact === 'function') combat.vfx.impact(point, 1.4);
    }
    if (cam && typeof cam.shake === 'function') cam.shake(1.0, 0.55);
    if (hud) {
      if (typeof hud.setHP === 'function') hud.setHP(e.hp, e.hpMax);
      if (typeof hud.damage === 'function') hud.damage(point, dmg, true);
    }
    engine.events.emit('player:hurt', { entity: e, damage: dmg, cause: 'vehicle' });
    if (e.hp <= 0) engine.events.emit('combat:ko', { target: e, cause: 'vehicle' });
  },

  respawn(pos, yaw) {
    const e = this.entity; if (!e) return;
    // on the ground under the mark, not at the caller's y: ハチ公前's apron is a 15 cm slab, and a cutscene never runs
    // move(), so 健人 stood sunk to the shoe tops through the whole confrontation (優先3, docs/reports/characters.md)
    e.position.copy(pos); if (this.engine && this.engine.world) e.position.y = this.engine.world.groundHeight(pos.x, pos.z);
    e.yaw = yaw ?? e.yaw; e.hp = e.hpMax; e.heat = 0; e.alive = true; e.setState('idle'); e.velocity.set(0, 0, 0);
    e.humanoid.play('idle', { fade: 0 });
  },

  update(dt) {
    const engine = this.engine, e = this.entity;
    if (!e) return;
    const world = engine.world, input = engine.input, h = e.humanoid, cam = engine.get('camera'), combat = engine.get('combat');
    const inCombat = engine.state.mode === 'combat';
    e.stateT += dt;
    if (e.comboT > 0) { e.comboT -= dt; if (e.comboT <= 0) { e.combo = 0; } }
    if (this.chainT > 0) { this.chainT -= dt; if (this.chainT <= 0) this.chainIdx = 0; }
    if (engine.state.frozen || engine.state.mode === 'cutscene' || engine.state.mode === 'paused') {
      // still render: keep an idle/combat idle pose, no input
      if (!engine.params?.anim && (e.state === 'idle' || e.state === 'move')) h.play(inCombat ? 'idle_combat' : 'idle');
      return;
    }
    if (!e.alive) return;
    if (e.riding) return;              // [mobility] on a LOOP kickboard: src/world/loop.js drives him until he returns it

    // ---- knockback / hit states (combat sets state + velocity)
    if (e.state === 'hit' || e.state === 'down' || e.state === 'attack' || e.state === 'heat') {
      this.applyVelocity(dt);
      if (e.state === 'hit' && e.stateT > 0.35) e.setState('idle');
      if (e.state === 'down' && e.stateT > 1.4) { h.play('getup', { loop: false }); e.setState('getup'); }
      if (e.state === 'attack' && (!combat || !combat.isAttacking(e))) e.setState('idle');
      return;
    }
    if (e.state === 'getup') { if (e.stateT > 1.05) e.setState('idle'); return; }

    // ---- guard
    e.guard = input.buttons.guard.down && e.state !== 'dodge';
    if (e.guard) { h.play('guard'); this.applyVelocity(dt); e.setState('guard'); return; }
    if (e.state === 'guard') e.setState('idle');

    // ---- dodge
    if (e.state === 'dodge') {
      const k = Math.max(0.15, 1 - e.stateT / DODGE_T);
      _d.copy(e.dodgeDir).multiplyScalar(DODGE_SPEED * k * dt);
      this.move(_d);
      if (e.stateT >= DODGE_T) e.setState('idle');
      return;
    }
    if (input.buttons.dodge.pressed) {
      const mv = this.moveVector(_m);
      e.dodgeDir = (mv.lengthSq() > 0.01 ? mv.clone().normalize() : e.forward(new THREE.Vector3()).negate());
      e.yaw = Math.atan2(e.dodgeDir.x, e.dodgeDir.z) + (mv.lengthSq() > 0.01 ? 0 : Math.PI);
      e.setState('dodge'); h.play('dodge', { loop: false, force: true });
      engine.events.emit('player:dodge', e);
      return;
    }

    // ---- attacks (combat module owns hitboxes / timing)
    if (combat) {
      if (input.buttons.attack.pressed) {
        const name = this.lightChain[Math.min(this.chainIdx, this.lightChain.length - 1)];
        if (combat.attack(e, name)) { this.chainIdx = (this.chainIdx + 1) % this.lightChain.length; this.chainT = 0.9; this.faceTarget(); e.setState('attack'); return; }
      }
      if (input.buttons.heavy.pressed) {
        const name = this.heavyChain[this.chainIdx > 1 ? 1 : 0];
        if (combat.attack(e, name)) { this.chainIdx = 0; this.chainT = 0.9; this.faceTarget(); e.setState('attack'); return; }
      }
      if (input.buttons.grab.pressed && combat.attack(e, 'grab')) { this.faceTarget(); e.setState('attack'); return; }
      if (input.buttons.heat.pressed) { const ha = engine.get('heatActions'); if (ha && ha.trigger && ha.trigger(e)) return; }
    }
    if (input.buttons.lockOn.pressed) this.toggleLock();

    // ---- locomotion
    const mv = this.moveVector(_m);
    const running = input.buttons.run.down && !inCombat;
    const speed = mv.length() * (running ? RUN : WALK);
    e.moveSpeed = speed;
    if (speed > 0.05) {
      const targetYaw = Math.atan2(mv.x, mv.z);
      let d = targetYaw - e.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      e.yaw += d * Math.min(1, dt * 14);
      _d.copy(mv).normalize().multiplyScalar(speed * dt);
      this.move(_d);
      h.play(running ? 'run' : 'walk');
      e.setState('move', e.stateT);
    } else {
      h.play(inCombat ? 'idle_combat' : 'idle');
      if (e.lockTarget && e.lockTarget.alive) { const t = e.lockTarget.position; e.yaw = Math.atan2(t.x - e.position.x, t.z - e.position.z); }
      e.setState('idle', e.stateT);
    }
    this.applyVelocity(dt);
  },

  moveVector(out) {
    const engine = this.engine, input = engine.input, cam = engine.get('camera');
    if (cam && cam.getForward) cam.getForward(_f); else { engine.camera.getWorldDirection(_f); _f.y = 0; _f.normalize(); }
    _r.set(-_f.z, 0, _f.x); // character right = forward × up: for f=(0,0,1) right=(-1,0,0)
    return out.copy(_f).multiplyScalar(input.move.y).addScaledVector(_r, input.move.x);
  },

  move(delta) {
    const e = this.entity, world = this.engine.world;
    if (!world) { e.position.add(delta); }
    else {
      const p = world.moveCapsule(e.position, e.radius, e.height, delta);
      e.position.set(p.x, p.y, p.z);
      e.grounded = p.grounded;
    }
    const gy = world ? world.groundHeight(e.position.x, e.position.z) : 0;
    e.position.y += (gy - e.position.y) * 0.5;
    e.group.rotation.y = e.yaw;
  },

  applyVelocity(dt) {
    const e = this.entity;
    if (e.velocity.lengthSq() > 1e-4) {
      _d.copy(e.velocity).multiplyScalar(dt);
      this.move(_d);
      e.velocity.multiplyScalar(Math.max(0, 1 - dt * 6));
    } else e.group.rotation.y = e.yaw;
  },

  faceTarget() {
    const e = this.entity, engine = this.engine, en = engine.get('enemy');
    let t = e.lockTarget && e.lockTarget.alive ? e.lockTarget : null;
    if (!t && en && en.list) {
      let best = 3.2;
      for (const x of en.list) { if (!x.alive) continue; const d = x.position.distanceTo(e.position); if (d < best) { best = d; t = x; } }
    }
    if (t) e.yaw = Math.atan2(t.position.x - e.position.x, t.position.z - e.position.z);
    e.group.rotation.y = e.yaw;
  },

  toggleLock() {
    const e = this.entity, en = this.engine.get('enemy');
    if (e.lockTarget) { e.lockTarget = null; return; }
    let best = 12, t = null;
    for (const x of (en && en.list) || []) { if (!x.alive) continue; const d = x.position.distanceTo(e.position); if (d < best) { best = d; t = x; } }
    e.lockTarget = t;
  },
};

export default player;
