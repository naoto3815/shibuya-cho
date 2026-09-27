// [physics] Collision world. Foundation wrote a working simple version; physics owner may replace internals
// but MUST keep this interface (§5):
//   world.addStatic(mesh | Box3 | {obb:{center, halfSize, rotationY}}, {tag}) -> id
//   world.removeStatic(id)
//   world.moveCapsule(pos, radius, height, delta) -> Vector3 (with .grounded)
//   world.raycast(origin, dir, maxDist, {tags}) -> {point, normal, distance, tag} | null
//   world.overlapSphere(center, r, {tags}) -> [hits]
//   world.addDynamic({mesh, mass, radius|halfSize}) -> body
//   world.groundHeight(x, z) -> y
//   world.debugDraw(bool)
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

function makeShape(input, tag, id) {
  if (input && input.isBox3) {
    return { kind: 'aabb', id, tag, min: input.min.clone(), max: input.max.clone() };
  }
  if (input && input.isObject3D) {
    input.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(input);
    return { kind: 'aabb', id, tag, min: b.min, max: b.max, mesh: input };
  }
  if (input && input.obb) {
    const o = input.obb;
    const rot = o.rotationY || 0;
    const half = new THREE.Vector3().copy(o.halfSize);
    const s = { kind: 'obb', id, tag, center: new THREE.Vector3().copy(o.center), half, rot, c: Math.cos(rot), s: Math.sin(rot) };
    const ex = Math.abs(half.x * s.c) + Math.abs(half.z * s.s);
    const ez = Math.abs(half.x * s.s) + Math.abs(half.z * s.c);
    s.min = new THREE.Vector3(s.center.x - ex, s.center.y - half.y, s.center.z - ez);
    s.max = new THREE.Vector3(s.center.x + ex, s.center.y + half.y, s.center.z + ez);
    return s;
  }
  if (input && input.min && input.max) {
    return { kind: 'aabb', id, tag, min: new THREE.Vector3().copy(input.min), max: new THREE.Vector3().copy(input.max) };
  }
  return null;
}

// closest point on shape (XZ footprint) to (x,z); returns {cx, cz, inside}
function closestXZ(sh, x, z, out) {
  if (sh.kind === 'aabb') {
    out.cx = Math.min(Math.max(x, sh.min.x), sh.max.x);
    out.cz = Math.min(Math.max(z, sh.min.z), sh.max.z);
    out.inside = (out.cx === x && out.cz === z);
    if (out.inside) {
      const px1 = x - sh.min.x, px2 = sh.max.x - x, pz1 = z - sh.min.z, pz2 = sh.max.z - z;
      const m = Math.min(px1, px2, pz1, pz2);
      if (m === px1) out.nx = -1, out.nz = 0, out.cx = sh.min.x, out.cz = z;
      else if (m === px2) out.nx = 1, out.nz = 0, out.cx = sh.max.x, out.cz = z;
      else if (m === pz1) out.nx = 0, out.nz = -1, out.cx = x, out.cz = sh.min.z;
      else out.nx = 0, out.nz = 1, out.cx = x, out.cz = sh.max.z;
    }
    return out;
  }
  // obb: to local
  const dx = x - sh.center.x, dz = z - sh.center.z;
  const lx = sh.c * dx - sh.s * dz, lz = sh.s * dx + sh.c * dz;
  let cx = Math.min(Math.max(lx, -sh.half.x), sh.half.x);
  let cz = Math.min(Math.max(lz, -sh.half.z), sh.half.z);
  let nx = 0, nz = 0;
  const inside = (cx === lx && cz === lz);
  if (inside) {
    const px1 = lx + sh.half.x, px2 = sh.half.x - lx, pz1 = lz + sh.half.z, pz2 = sh.half.z - lz;
    const m = Math.min(px1, px2, pz1, pz2);
    if (m === px1) { nx = -1; cx = -sh.half.x; cz = lz; }
    else if (m === px2) { nx = 1; cx = sh.half.x; cz = lz; }
    else if (m === pz1) { nz = -1; cx = lx; cz = -sh.half.z; }
    else { nz = 1; cx = lx; cz = sh.half.z; }
  }
  out.cx = sh.center.x + sh.c * cx + sh.s * cz;
  out.cz = sh.center.z - sh.s * cx + sh.c * cz;
  out.inside = inside;
  out.nx = sh.c * nx + sh.s * nz;
  out.nz = -sh.s * nx + sh.c * nz;
  return out;
}

function rayAABB(ox, oy, oz, dx, dy, dz, min, max, maxDist) {
  let tmin = 0, tmax = maxDist, axis = -1, sign = 0;
  const o = [ox, oy, oz], d = [dx, dy, dz], mn = [min.x, min.y, min.z], mx = [max.x, max.y, max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn[i] || o[i] > mx[i]) return null; continue; }
    const inv = 1 / d[i];
    let t1 = (mn[i] - o[i]) * inv, t2 = (mx[i] - o[i]) * inv, sg = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis < 0) return null; // origin inside
  return { t: tmin, axis, sign };
}

export function createWorld(engine) {
  const statics = [];
  const byId = new Map();
  const dynamics = [];
  let nextId = 1;
  let debugGroup = null;
  const tmp = { cx: 0, cz: 0, inside: false, nx: 0, nz: 0 };

  // Movers: solid things that move every frame (vehicles). Too expensive to add/remove as statics, so they
  // live in their own list and only participate in moveCapsule. The owner updates the fields in place.
  //   m = { cx, cz, hw, hd, rot, c, s, yTop, vx, vz, tag, userData }
  const movers = [];

  const world = {
    statics, dynamics, movers,
    gravity: -9.81,
    addMover(spec) {
      const m = {
        cx: spec.cx || 0, cz: spec.cz || 0, hw: spec.hw || 1, hd: spec.hd || 1,
        rot: spec.rot || 0, c: Math.cos(spec.rot || 0), s: Math.sin(spec.rot || 0),
        yTop: spec.yTop != null ? spec.yTop : 1.6, vx: 0, vz: 0,
        tag: spec.tag || 'mover', userData: spec.userData || null,
      };
      movers.push(m);
      return m;
    },
    removeMover(m) { const i = movers.indexOf(m); if (i >= 0) movers.splice(i, 1); },
    setMoverPose(m, cx, cz, rot) { m.cx = cx; m.cz = cz; if (rot !== m.rot) { m.rot = rot; m.c = Math.cos(rot); m.s = Math.sin(rot); } },
    // nearest mover whose footprint (expanded by r) contains (x, z), or null
    moverAt(x, z, r = 0, yFoot = 0) {
      for (let i = 0; i < movers.length; i++) {
        const m = movers[i];
        if (yFoot > m.yTop) continue;
        const dx = x - m.cx, dz = z - m.cz;
        const reach = m.hw + m.hd + r;
        if (dx > reach || dx < -reach || dz > reach || dz < -reach) continue;
        const lx = m.c * dx - m.s * dz, lz = m.s * dx + m.c * dz;
        const qx = Math.min(Math.max(lx, -m.hw), m.hw), qz = Math.min(Math.max(lz, -m.hd), m.hd);
        const ex = lx - qx, ez = lz - qz;
        if (ex * ex + ez * ez <= r * r) return m;
      }
      return null;
    },
    addStatic(input, opts = {}) {
      const id = nextId++;
      const sh = makeShape(input, opts.tag || 'static', id);
      if (!sh) { console.warn('[physics] addStatic: unsupported input', input); return -1; }
      sh.userData = opts.userData || null;
      statics.push(sh);
      byId.set(id, sh);
      if (debugGroup) addDebug(sh);
      return id;
    },
    removeStatic(id) {
      const sh = byId.get(id);
      if (!sh) return false;
      byId.delete(id);
      const i = statics.indexOf(sh);
      if (i >= 0) statics.splice(i, 1);
      if (sh.__debug && debugGroup) { debugGroup.remove(sh.__debug); }
      return true;
    },
    // optional extension (foundation): raised ground patches (sidewalk slabs / plazas). {cx,cz,hw,hd,rot,y}
    // Heights are relative to the terrain. The city sets groundBase(x, z) (terrain: 道玄坂 / 文化村通り slopes, cityData
    // groundY) and groundSlab(x, z) (sidewalk slab height, 0 on carriageways) so the ground is one O(1) lookup.
    groundPatches: [],
    groundBase: null,
    groundSlab: null,
    addGroundPatch(p) { world.groundPatches.push({ cx: p.cx, cz: p.cz, hw: p.hw, hd: p.hd, rot: p.rot || 0, c: Math.cos(p.rot || 0), s: Math.sin(p.rot || 0), y: p.y }); },
    groundHeight(x, z) {
      let y = world.groundSlab ? world.groundSlab(x, z) : 0;
      const gp = world.groundPatches;
      for (let i = 0; i < gp.length; i++) {
        const p = gp[i];
        const dx = x - p.cx, dz = z - p.cz;
        const lx = p.c * dx - p.s * dz, lz = p.s * dx + p.c * dz;
        if (lx >= -p.hw && lx <= p.hw && lz >= -p.hd && lz <= p.hd && p.y > y) y = p.y;
      }
      return world.groundBase ? world.groundBase(x, z) + y : y;
    },
    moveCapsule(pos, radius, height, delta) {
      const p = new THREE.Vector3(pos.x + delta.x, pos.y + delta.y, pos.z + delta.z);
      const gy = world.groundHeight(p.x, p.z);
      let grounded = false;
      if (p.y <= gy + 1e-4) { p.y = gy; grounded = true; }
      const yTop = p.y + height, yFoot = p.y + 0.35; // allow stepping over 35 cm ledges (curbs, plinths)
      for (let iter = 0; iter < 4; iter++) {
        let moved = false;
        for (let i = 0; i < statics.length; i++) {
          const sh = statics[i];
          if (p.x + radius < sh.min.x || p.x - radius > sh.max.x || p.z + radius < sh.min.z || p.z - radius > sh.max.z) continue;
          if (yTop < sh.min.y || yFoot > sh.max.y) continue;
          closestXZ(sh, p.x, p.z, tmp);
          if (tmp.inside) {
            p.x = tmp.cx + tmp.nx * radius; p.z = tmp.cz + tmp.nz * radius; moved = true; continue;
          }
          const dx = p.x - tmp.cx, dz = p.z - tmp.cz;
          const d2 = dx * dx + dz * dz;
          if (d2 < radius * radius) {
            const d = Math.sqrt(Math.max(d2, 1e-12));
            p.x = tmp.cx + (dx / d) * radius; p.z = tmp.cz + (dz / d) * radius; moved = true;
          }
        }
        // movers (vehicles): same push-out, but the footprint is re-derived each call because it moves
        for (let i = 0; i < movers.length; i++) {
          const m = movers[i];
          if (yFoot > m.yTop) continue;
          const dx = p.x - m.cx, dz = p.z - m.cz;
          const reach = m.hw + m.hd + radius;
          if (dx > reach || dx < -reach || dz > reach || dz < -reach) continue;
          const lx = m.c * dx - m.s * dz, lz = m.s * dx + m.c * dz;
          let qx = Math.min(Math.max(lx, -m.hw), m.hw), qz = Math.min(Math.max(lz, -m.hd), m.hd);
          let nlx, nlz;
          if (qx === lx && qz === lz) {                       // inside: leave by the nearest face
            const px = m.hw - Math.abs(lx), pz = m.hd - Math.abs(lz);
            if (px < pz) { nlx = (lx < 0 ? -1 : 1) * (m.hw + radius); nlz = lz; }
            else { nlx = lx; nlz = (lz < 0 ? -1 : 1) * (m.hd + radius); }
          } else {
            const ex = lx - qx, ez = lz - qz;
            const d2 = ex * ex + ez * ez;
            if (d2 >= radius * radius) continue;
            const d = Math.sqrt(Math.max(d2, 1e-12));
            nlx = qx + (ex / d) * radius; nlz = qz + (ez / d) * radius;
          }
          p.x = m.cx + m.c * nlx + m.s * nlz;
          p.z = m.cz - m.s * nlx + m.c * nlz;
          moved = true;
        }
        if (!moved) break;
      }
      p.grounded = grounded;
      return p;
    },
    raycast(origin, dir, maxDist = 100, opts = {}) {
      const tags = opts.tags ? new Set(opts.tags) : null;
      let best = null;
      const ox = origin.x, oy = origin.y, oz = origin.z;
      const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
      const dx = dir.x / dl, dy = dir.y / dl, dz = dir.z / dl;
      for (const sh of statics) {
        if (tags && !tags.has(sh.tag)) continue;
        let hit = null;
        if (sh.kind === 'aabb') {
          const r = rayAABB(ox, oy, oz, dx, dy, dz, sh.min, sh.max, maxDist);
          if (r && (!best || r.t < best.distance)) {
            const n = new THREE.Vector3(); n.setComponent(r.axis, r.sign);
            hit = { distance: r.t, normal: n };
          }
        } else {
          // to local
          const lox = sh.c * (ox - sh.center.x) - sh.s * (oz - sh.center.z), loz = sh.s * (ox - sh.center.x) + sh.c * (oz - sh.center.z);
          const ldx = sh.c * dx - sh.s * dz, ldz = sh.s * dx + sh.c * dz;
          const lmin = { x: -sh.half.x, y: sh.center.y - sh.half.y, z: -sh.half.z }, lmax = { x: sh.half.x, y: sh.center.y + sh.half.y, z: sh.half.z };
          const r = rayAABB(lox, oy, loz, ldx, dy, ldz, lmin, lmax, maxDist);
          if (r && (!best || r.t < best.distance)) {
            const ln = [0, 0, 0]; ln[r.axis] = r.sign;
            const n = new THREE.Vector3(sh.c * ln[0] + sh.s * ln[2], ln[1], -sh.s * ln[0] + sh.c * ln[2]);
            hit = { distance: r.t, normal: n };
          }
        }
        if (hit) {
          best = { point: new THREE.Vector3(ox + dx * hit.distance, oy + dy * hit.distance, oz + dz * hit.distance), normal: hit.normal, distance: hit.distance, tag: sh.tag, id: sh.id, shape: sh };
        }
      }
      // ground plane
      if ((!tags || tags.has('ground')) && dy < -1e-6) {
        const t = (world.groundHeight(ox, oz) - oy) / dy;
        if (t >= 0 && t <= maxDist && (!best || t < best.distance)) {
          best = { point: new THREE.Vector3(ox + dx * t, oy + dy * t, oz + dz * t), normal: new THREE.Vector3(0, 1, 0), distance: t, tag: 'ground', id: 0 };
        }
      }
      return best;
    },
    overlapSphere(center, r, opts = {}) {
      const tags = opts.tags ? new Set(opts.tags) : null;
      const hits = [];
      for (const sh of statics) {
        if (tags && !tags.has(sh.tag)) continue;
        if (center.x + r < sh.min.x || center.x - r > sh.max.x || center.z + r < sh.min.z || center.z - r > sh.max.z || center.y + r < sh.min.y || center.y - r > sh.max.y) continue;
        closestXZ(sh, center.x, center.z, tmp);
        const cy = Math.min(Math.max(center.y, sh.min.y), sh.max.y);
        const dx = center.x - tmp.cx, dz = center.z - tmp.cz, dy = center.y - cy;
        const d2 = tmp.inside ? 0 : dx * dx + dz * dz + dy * dy;
        if (d2 <= r * r) hits.push({ id: sh.id, tag: sh.tag, point: new THREE.Vector3(tmp.cx, cy, tmp.cz), distance: Math.sqrt(d2), shape: sh, userData: sh.userData });
      }
      if (!tags || tags.has('dynamic')) {
        for (const b of dynamics) {
          const d = b.position.distanceTo(center);
          if (d <= r + b.radius) hits.push({ id: b.id, tag: 'dynamic', body: b, point: b.position.clone(), distance: d });
        }
      }
      return hits;
    },
    addDynamic({ mesh, mass = 5, radius, halfSize, tag = 'dynamic' }) {
      const rad = radius != null ? radius : (halfSize ? Math.max(halfSize.x, halfSize.y, halfSize.z) : 0.5);
      const body = {
        id: nextId++, mesh, mass, radius: rad, halfSize: halfSize || null, tag,
        position: mesh ? mesh.position : new THREE.Vector3(),
        velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(),
        restY: halfSize ? halfSize.y : rad,
        sleeping: true, friction: 0.85, bounce: 0.25,
        applyImpulse(v) { body.velocity.addScaledVector(v, 1 / Math.max(0.1, body.mass)); body.sleeping = false; },
      };
      dynamics.push(body);
      return body;
    },
    removeDynamic(body) { const i = dynamics.indexOf(body); if (i >= 0) dynamics.splice(i, 1); },
    update(dt) {
      for (const b of dynamics) {
        if (b.sleeping) continue;
        b.velocity.y += world.gravity * dt;
        b.position.addScaledVector(b.velocity, dt);
        const gy = world.groundHeight(b.position.x, b.position.z) + b.restY;
        if (b.position.y < gy) {
          b.position.y = gy;
          if (b.velocity.y < 0) b.velocity.y = -b.velocity.y * b.bounce;
          b.velocity.x *= b.friction; b.velocity.z *= b.friction;
          b.angularVelocity.multiplyScalar(0.8);
        }
        // static push-out (sphere approximation)
        for (const sh of statics) {
          if (b.position.x + b.radius < sh.min.x || b.position.x - b.radius > sh.max.x || b.position.z + b.radius < sh.min.z || b.position.z - b.radius > sh.max.z) continue;
          if (b.position.y + b.radius < sh.min.y || b.position.y - b.radius > sh.max.y) continue;
          closestXZ(sh, b.position.x, b.position.z, tmp);
          if (tmp.inside) { b.position.x = tmp.cx + tmp.nx * b.radius; b.position.z = tmp.cz + tmp.nz * b.radius; b.velocity.x *= -0.3; b.velocity.z *= -0.3; continue; }
          const dx = b.position.x - tmp.cx, dz = b.position.z - tmp.cz, d2 = dx * dx + dz * dz;
          if (d2 < b.radius * b.radius) {
            const d = Math.sqrt(Math.max(d2, 1e-12));
            b.position.x = tmp.cx + dx / d * b.radius; b.position.z = tmp.cz + dz / d * b.radius;
            const vn = (b.velocity.x * dx + b.velocity.z * dz) / d;
            if (vn < 0) { b.velocity.x -= 1.3 * vn * dx / d; b.velocity.z -= 1.3 * vn * dz / d; }
          }
        }
        if (b.mesh) {
          b.mesh.rotation.x += b.angularVelocity.x * dt;
          b.mesh.rotation.y += b.angularVelocity.y * dt;
          b.mesh.rotation.z += b.angularVelocity.z * dt;
        }
        if (b.velocity.lengthSq() < 0.01 && b.position.y <= gy + 1e-3) { b.velocity.set(0, 0, 0); b.sleeping = true; }
      }
    },
    debugDraw(on) {
      if (on && !debugGroup) {
        debugGroup = new THREE.Group(); debugGroup.name = 'physics-debug';
        engine.scene.add(debugGroup);
        for (const sh of statics) addDebug(sh);
      } else if (!on && debugGroup) {
        engine.scene.remove(debugGroup); debugGroup = null;
        for (const sh of statics) sh.__debug = null;
      }
    },
  };

  function addDebug(sh) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: sh.kind === 'obb' ? 0xff8800 : 0x00ff88, wireframe: true }));
    if (sh.kind === 'aabb') {
      m.position.set((sh.min.x + sh.max.x) / 2, (sh.min.y + sh.max.y) / 2, (sh.min.z + sh.max.z) / 2);
      m.scale.set(sh.max.x - sh.min.x, sh.max.y - sh.min.y, sh.max.z - sh.min.z);
    } else {
      m.position.copy(sh.center); m.rotation.y = sh.rot; m.scale.set(sh.half.x * 2, sh.half.y * 2, sh.half.z * 2);
    }
    sh.__debug = m; debugGroup.add(m);
  }

  return world;
}

export default {
  name: 'physics',
  init(engine) {
    this.engine = engine;
    this.world = createWorld(engine);
    engine.world = this.world;
  },
  update(dt) {
    if (!this.world) return;
    if (this.engine.state.frozen) return;
    this.world.update(dt);
  },
};
