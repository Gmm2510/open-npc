// What the companion could really know: only blocks and mobs it saw or heard, not everything in loaded chunks.
const { Vec3 } = require('vec3');
const { Part, DEG, wrapDeg, yawPitchTo, dirOf, seeThrough, AIRISH, Cooldowns, directionWords, pretty, rand, findBlocksFast } = require('./bodykit');

function traverse(origin, dir, maxDist, visit) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const sx = Math.sign(dir.x), sy = Math.sign(dir.y), sz = Math.sign(dir.z);
  const dx = sx ? Math.abs(1 / dir.x) : Infinity, dy = sy ? Math.abs(1 / dir.y) : Infinity, dz = sz ? Math.abs(1 / dir.z) : Infinity;
  let mx = sx > 0 ? (x + 1 - origin.x) * dx : sx < 0 ? (origin.x - x) * dx : Infinity;
  let my = sy > 0 ? (y + 1 - origin.y) * dy : sy < 0 ? (origin.y - y) * dy : Infinity;
  let mz = sz > 0 ? (z + 1 - origin.z) * dz : sz < 0 ? (origin.z - z) * dz : Infinity;
  if (visit(x, y, z, 0, null)) return true;
  for (let guard = 0; guard < 1024; guard++) {
    let t, face;
    if (mx < my && mx < mz) { x += sx; t = mx; mx += dx; face = { x: -sx, y: 0, z: 0 }; }
    else if (my < mz) { y += sy; t = my; my += dy; face = { x: 0, y: -sy, z: 0 }; }
    else { z += sz; t = mz; mz += dz; face = { x: 0, y: 0, z: -sz }; }
    if (t > maxDist) return false;
    if (visit(x, y, z, t, face)) return true;
  }
  return false;
}

const V = (x, y, z) => new Vec3(x, y, z);

function clearPath(world, a, b) {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-6) return true;
  const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
  const ax = Math.floor(a.x), ay = Math.floor(a.y), az = Math.floor(a.z);
  const bx = Math.floor(b.x), by = Math.floor(b.y), bz = Math.floor(b.z);
  let blocked = false;
  traverse(a, dir, len, (x, y, z) => {
    if (x === ax && y === ay && z === az) return false;
    if (x === bx && y === by && z === bz) return true;
    if (!seeThrough(world.blockAt(V(x, y, z), false))) { blocked = true; return true; }
    return false;
  });
  return !blocked;
}

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function blockVisible(world, eye, pos, maxDist = 48) {
  const cx = pos.x + 0.5, cy = pos.y + 0.5, cz = pos.z + 0.5;
  if (Math.hypot(cx - eye.x, cy - eye.y, cz - eye.z) > maxDist) return false;

  if (Math.floor(eye.x) === pos.x && Math.floor(eye.y) === pos.y && Math.floor(eye.z) === pos.z) return true;
  for (const [fx, fy, fz] of FACES) {
    const fc = { x: cx + fx * 0.51, y: cy + fy * 0.51, z: cz + fz * 0.51 };
    if ((eye.x - fc.x) * fx + (eye.y - fc.y) * fy + (eye.z - fc.z) * fz <= 0) continue;
    if (!seeThrough(world.blockAt(V(pos.x + fx, pos.y + fy, pos.z + fz), false))) continue;
    if (clearPath(world, eye, fc)) return true;
  }
  return false;
}

function entityPoints(e) {
  const h = e.height || 1.8, p = e.position;
  return [{ x: p.x, y: p.y + h * 0.85, z: p.z }, { x: p.x, y: p.y + h * 0.5, z: p.z }, { x: p.x, y: p.y + 0.2, z: p.z }];
}
function entityVisible(world, eye, e) {
  return entityPoints(e).some((pt) => clearPath(world, eye, pt));
}

function inCone(yaw, pitch, eye, point, fovH = 120, fovV = 100) {
  const yp = yawPitchTo(eye, point);
  return Math.abs(wrapDeg(yp.yaw - yaw)) <= fovH / 2 && Math.abs(yp.pitch - pitch) <= fovV / 2;
}

function rayAabb(o, d, b) {
  let tmin = 0, tmax = Infinity;
  for (const [oa, da, lo, hi] of [[o.x, d.x, b.minX, b.maxX], [o.y, d.y, b.minY, b.maxY], [o.z, d.z, b.minZ, b.maxZ]]) {
    if (Math.abs(da) < 1e-9) { if (oa < lo || oa > hi) return null; continue; }
    let t1 = (lo - oa) / da, t2 = (hi - oa) / da;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

const NOT_A_TARGET = /^(water|lava|flowing_water|flowing_lava|light|bubble_column|structure_void)$/;

function crosshair(world, eye, yaw, pitch, maxDist, entities = [], skip = null) {
  const dir = dirOf(yaw, pitch);
  let hit = null;
  const ex = Math.floor(eye.x), ey = Math.floor(eye.y), ez = Math.floor(eye.z);
  traverse(eye, dir, maxDist, (x, y, z, t, face) => {
    if (x === ex && y === ey && z === ez) return false;
    const b = world.blockAt(V(x, y, z), false);
    if (!b) return true;
    if (AIRISH.has(b.name) || NOT_A_TARGET.test(b.name)) return false;
    hit = { block: b, entity: null, distance: t, face, pos: { x: eye.x + dir.x * t, y: eye.y + dir.y * t, z: eye.z + dir.z * t } };
    return true;
  });
  let best = null;
  for (const e of entities) {
    if (!e || e === skip || !e.position) continue;
    const w = (e.width || 0.6) / 2, h = e.height || 1.8, p = e.position;
    if (Math.abs(p.x - eye.x) > maxDist + 2 || Math.abs(p.z - eye.z) > maxDist + 2) continue;
    const t = rayAabb(eye, dir, { minX: p.x - w, maxX: p.x + w, minY: p.y, maxY: p.y + h, minZ: p.z - w, maxZ: p.z + w });
    if (t != null && t <= maxDist && (!best || t < best.t)) best = { e, t };
  }
  if (best && (!hit || best.t < hit.distance)) {
    return { block: null, entity: best.e, distance: best.t, face: null, pos: { x: eye.x + dir.x * best.t, y: eye.y + dir.y * best.t, z: eye.z + dir.z * best.t } };
  }
  return hit;
}

const SOUNDS = [
  { re: /creeper\.primed/, mob: 'creeper', what: 'a creeper hissing', threat: true },
  { re: /(^|\.)zombie(\.villager)?\.ambient/, mob: 'zombie', what: 'a zombie groaning', threat: true },
  { re: /husk\.ambient/, mob: 'husk', what: 'a husk groaning', threat: true },
  { re: /drowned\.ambient/, mob: 'drowned', what: 'a drowned gurgling', threat: true },
  { re: /(^|\.)skeleton\.(ambient|step)/, mob: 'skeleton', what: 'bones rattling', threat: true },
  { re: /(skeleton|stray)\.shoot|arrow\.shoot/, mob: 'skeleton', what: 'an arrow being shot', threat: true },
  { re: /(^|\.)spider\.ambient/, mob: 'spider', what: 'a spider hissing', threat: true },
  { re: /enderman\.(ambient|stare|scream)/, mob: 'enderman', what: 'an enderman', threat: true },
  { re: /witch\.ambient/, mob: 'witch', what: 'a witch laughing', threat: true },
  { re: /generic\.explode/, mob: null, what: 'an explosion', threat: true },
  { re: /ambient\.cave/, mob: null, what: 'a cave ambient sound', threat: false }
];
const canonSound = (name) => String(name || '').replace(/^minecraft:/, '').replace(/_/g, '.');
function soundInfo(name) { const c = canonSound(name); return SOUNDS.find((s) => s.re.test(c)) || null; }

const REMEMBER = /_ore$|^(ancient_debris|chest|trapped_chest|barrel|spawner|amethyst_block|budding_amethyst|bell|cave_air)$/;
const GOOD_ORE = { iron: 'iron', gold: 'gold', diamond: 'diamonds', emerald: 'emeralds', ancient_debris: 'ancient debris' };
const keyOf = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const isEntity = (x) => !!x && !!x.position && typeof x.type !== 'number' && (typeof x.type === 'string' || x.username != null || x.id != null);

class Perception extends Part {
  constructor(c) {
    super(c, 'perception');
    this.seenBlocks = new Map();
    this.seenEnt = new Map();
    this.heardEnt = new Map();
    this.kcache = new Map();
    this.cool = new Cooldowns();
    this.ownerAim = { key: null, since: 0, target: null };
    this.lastHeard = null;
  }

  setup(bot) {
    this.seenBlocks.clear(); this.seenEnt.clear(); this.heardEnt.clear(); this.kcache.clear();
    this.scanQueue = []; this.nextScan = 0;
    this.listen(bot, 'soundEffectHeard', (name, pos) => this.onSound(name, pos));
    this.listen(bot, 'hardcodedSoundEffectHeard', (id, cat, pos) => { const n = bot.registry?.sounds?.[id]?.name; if (n) this.onSound(n, pos); });
  }

  world() { return this.c.bot; }
  eye() { const e = this.c.bot.entity; return e.position.offset(0, e.eyeHeight ?? 1.62, 0); }
  headYaw() { return this.c.v12.motor?.headYaw?.() ?? wrapDeg((this.c.bot?.entity?.yaw || 0) * DEG); }
  headPitch() { return this.c.v12.motor?.headPitch?.() ?? (this.c.bot?.entity?.pitch || 0) * DEG; }

  viewRange(pos) {
    const b = this.c.bot.blockAt(pos instanceof Vec3 ? pos.floored() : V(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)), false);
    if (!b || b.light == null || b.skyLight == null) return 48;
    const t = this.c.bot.time?.timeOfDay;
    const night = t != null && t >= 13000 && t <= 23000;
    const lvl = Math.max(b.light, b.skyLight - (night ? 11 : 0));
    return lvl >= 8 ? 48 : lvl >= 4 ? 20 : 8;
  }

  lineOfSight(from, to) { return !!this.c.bot && clearPath(this.world(), from, to); }

  knows(x) {
    if (!this.on() || !this.bot) return true;
    if (!x || !this.c.bot?.entity) return false;
    return isEntity(x) ? this.knowsEntity(x) : this.knowsBlock(x);
  }

  knowsEntity(e, now = Date.now()) {
    const bot = this.c.bot;
    if (e === bot.entity) return true;
    if (e.type === 'player' && e.username && this.c.opts.owner && e.username.toLowerCase() === this.c.opts.owner.toLowerCase()) return true;
    if (!e.position) return false;
    const eye = this.eye();
    const d = e.position.distanceTo(eye);
    if (d <= 3) return true;
    if (now - (this.seenEnt.get(e.id) || 0) < 8000) return true;
    if (now - (this.heardEnt.get(e.id) || 0) < 10000) return true;
    const k = this.kcache.get(e.id);
    if (k && now - k.t < 300) return k.v;
    const v = d <= this.viewRange(e.position) && entityVisible(this.world(), eye, e)
      && (d <= 6 || inCone(this.headYaw(), this.headPitch(), eye, e.position.offset(0, (e.height || 1.8) / 2, 0)));
    this.kcache.set(e.id, { t: now, v });
    if (this.kcache.size > 400) this.kcache.clear();
    if (v) this.seenEnt.set(e.id, now);
    return v;
  }

  knowsBlock(b) {
    const pos = b.position || b;
    const key = keyOf(pos);
    const rec = this.seenBlocks.get(key);
    if (rec && (!b.name || rec.name === b.name)) return true;
    const eye = this.eye();
    const p = V(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const range = this.viewRange(p.offset(0, 1, 0));
    const vis = blockVisible(this.world(), eye, p, range);
    if (vis && b.name && REMEMBER.test(b.name)) this.remember(b.name, p);
    return vis;
  }

  remember(name, pos) {
    const key = keyOf(pos);
    const fresh = !this.seenBlocks.has(key);
    this.seenBlocks.set(key, { name, pos: V(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)), at: Date.now() });
    if (this.seenBlocks.size > 4000) { const first = this.seenBlocks.keys().next().value; this.seenBlocks.delete(first); }
    return fresh;
  }

  remembered(names, maxDistance = 64) {
    const bot = this.c.bot;
    if (!bot?.entity) return [];
    const set = new Set(names);
    const out = [];
    for (const rec of this.seenBlocks.values()) {
      if (!set.has(rec.name) || rec.pos.distanceTo(bot.entity.position) > maxDistance) continue;
      const b = bot.blockAt(rec.pos);
      if (b && b.name === rec.name) out.push(b);
    }
    return out;
  }

  visibleBlocks(names, { maxDistance = 48, count = 1 } = {}) {
    const bot = this.c.bot;
    if (!bot?.entity) return [];
    if (!this.on() || !this.bot) return this.c.skills.findBlocks(names, { maxDistance, count });
    const positions = findBlocksFast(bot, names, { maxDistance, count: Math.min(256, Math.max(16, count * 16)) });
    const out = new Map();
    for (const p of positions) {
      const b = bot.blockAt(p);
      if (b && this.knowsBlock(b)) out.set(keyOf(p), b);
    }
    for (const b of this.remembered(names, maxDistance)) out.set(keyOf(b.position), b);
    const me = bot.entity.position;
    return [...out.values()].sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me)).slice(0, count);
  }

  lookTarget(entity, { maxDistance = 40 } = {}) {
    const bot = this.c.bot;
    const e = entity || this.c.ownerEntity();
    if (!bot?.entity || !e?.position) return null;
    const eyeH = e.type === 'player' ? (e.crouching ? 1.27 : 1.62) : (e.height || 1.8) * 0.85;
    const eye = e.position.offset(0, eyeH, 0);
    const yaw = (e.headYaw ?? e.yaw ?? 0) * DEG, pitch = (e.pitch || 0) * DEG;
    const ents = Object.values(bot.entities).filter((x) => x !== e && x.position && x.position.distanceTo(eye) <= maxDistance + 2);
    const r = crosshair(this.world(), eye, yaw, pitch, maxDistance, ents, e);
    if (!r) return null;
    const out = { block: r.block, entity: r.entity, pos: V(r.pos.x, r.pos.y, r.pos.z), distance: Math.round(r.distance * 10) / 10, heldMs: 0,

      position: r.block ? r.block.position : undefined, face: r.face ? V(r.face.x, r.face.y, r.face.z) : undefined, dist: Math.round(r.distance * 10) / 10,
      name: r.block ? r.block.name : r.entity ? r.entity.name : undefined };
    if (e === this.c.ownerEntity() && this.ownerAim.key && this.ownerAim.key === targetKey(r)) out.heldMs = Date.now() - this.ownerAim.since;
    return out;
  }

  onTick(now) {
    if (!this.on() || !this.live()) return;
    const bot = this.c.bot;

    const owner = this.c.ownerEntity();
    if (owner) {
      const r = this.lookTarget(owner);
      const key = r ? targetKey(r) : null;
      if (key !== this.ownerAim.key) this.ownerAim = { key, since: now, target: r };
      else this.ownerAim.target = r;
    }

    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position || e.type === 'object' || e.name === 'item') continue;
      if (e.position.distanceTo(bot.entity.position) > 32) continue;
      this.knowsEntity(e, now);
    }
    if (this.seenEnt.size > 500) this.seenEnt.clear();

    this.scan(now);
  }

  scan(now) {
    const bot = this.c.bot;
    if (!this.scanQueue.length && now >= this.nextScan) {
      this.nextScan = now + 2000;
      if (!this.rememberNames) this.rememberNames = Object.keys(bot.registry?.blocksByName || {}).filter((n) => REMEMBER.test(n));
      this.scanQueue = findBlocksFast(bot, this.rememberNames, { maxDistance: 20, count: 48, maxFullScans: 24 }).filter((p) => !this.seenBlocks.has(keyOf(p)));
    }
    const eye = this.eye();
    for (let i = 0; i < 12 && this.scanQueue.length; i++) {
      const p = this.scanQueue.shift();
      const b = bot.blockAt(p, false);
      if (!b || !REMEMBER.test(b.name)) continue;
      if (!blockVisible(this.world(), eye, p, this.viewRange(p.offset(0, 1, 0)))) continue;

      if (p.distanceTo(eye) > 6 && !inCone(this.headYaw(), this.headPitch(), eye, p.offset(0.5, 0.5, 0.5), 140, 120)) continue;
      if (this.remember(b.name, p)) this.noticed(b, p, now);
    }
  }

  noticed(b, p, now) {
    const m = /(iron|gold|diamond|emerald)_ore$/.exec(b.name) || (b.name === 'ancient_debris' ? [0, 'ancient_debris'] : null);
    if (!m) return;
    const d = p.distanceTo(this.c.bot.entity.position);
    if (d > 12) return;
    const kind = m[1];
    if (this.c.task && (this.c.task.name || '').includes(kind)) return;
    const gap = kind === 'diamond' ? 60000 : 180000;
    if (!this.cool.ok('ore', 60000, now) || !this.cool.take(`ore-${kind}`, gap, now)) return;
    this.cool.mark('ore', now);
    this.emitEvent('ore_spotted', { ore: GOOD_ORE[kind], distance_m: Math.round(d) }, kind === 'diamond' ? 'high' : null);
  }

  onSound(name, pos) {
    if (!this.on() || !this.live() || !pos) return;
    const info = soundInfo(name);
    if (!info) return;
    const bot = this.c.bot, now = Date.now();
    const me = bot.entity.position;
    const d = pos.distanceTo(me);
    if (d > 16) return;

    let source = null, sourceSeen = false;
    for (const e of Object.values(bot.entities)) {
      if (!e.position || !info.mob || !(e.name || '').includes(info.mob)) continue;
      if (e.position.distanceTo(pos) > 4) continue;
      sourceSeen = sourceSeen || now - (this.seenEnt.get(e.id) || 0) < 8000;
      this.heardEnt.set(e.id, now);
      source = source || e;
    }
    this.lastHeard = { what: info.what, mob: info.mob, pos, at: now };
    if (sourceSeen) return;

    const owner = this.c.ownerEntity();
    if (owner && owner.position.distanceTo(pos) > 20) return;

    const motor = this.c.v12.motor;
    if (motor?.installed?.() && !bot.pvp?.target && this.cool.take('flick', 4000, now)) {
      const target = pos.clone ? pos.clone() : V(pos.x, pos.y, pos.z);
      this.later(motor.reactionDelay(), () => motor.glance(target, { holdMs: rand(450, 900) }));
    }

    if (!info.threat || (info.mob === 'creeper' && d < 7)) return;
    if (!this.cool.ok('heard', 180000, now) || !this.cool.take(`heard-${info.mob || info.what}`, 360000, now)) return;
    this.cool.mark('heard', now);
    this.emitEvent('heard', { sound: info.what, direction: directionWords(me, this.headYaw(), pos), guess: info.mob ? `maybe a ${info.mob}` : null }, null);
  }

  state() {
    if (!this.on() || !this.live()) return {};
    const a = this.ownerAim;
    if (!a.key || !a.target || Date.now() - a.since < 600) return {};
    const t = a.target;
    const owner = this.c.ownerEntity();

    if (t.block && owner && t.distance < 2.6 && t.block.position.y < owner.position.y) return {};
    const what = t.entity ? (t.entity === this.c.bot.entity ? 'you' : t.entity.username || pretty(t.entity.displayName || t.entity.name)) : pretty(t.block.name);
    return { player_looking_at: `${what}, ${Math.max(1, Math.round(t.distance))} blocks away` };
  }
}

function targetKey(r) {
  if (!r) return null;
  if (r.entity) return `e${r.entity.id}`;
  if (r.block) return `b${keyOf(r.block.position)}`;
  return null;
}

module.exports = { Perception, traverse, clearPath, blockVisible, entityVisible, inCone, rayAabb, crosshair, soundInfo, canonSound, isEntity, keyOf };
