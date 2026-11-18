// Turns, aims and clicks like a hand on a mouse instead of a bot: eased looks, small aim errors, human timing.
const { Part, wrapDeg, yawPitchTo, angleBetween, toNotchYaw, toNotchPitch, rand, chance, DEG, RAD, isSolid } = require('./bodykit');

const PROFILES = {
  calm: { omega: [12, 16], zeta: [0.62, 0.8], vmax: [360, 560], amax: [4200, 6000] },
  fast: { omega: [20, 26], zeta: [0.6, 0.78], vmax: [600, 850], amax: [9000, 13000] }
};

class Head {
  constructor(yaw = 0, pitch = 0, rnd = Math.random) {
    this.rnd = rnd;
    this.yaw = wrapDeg(yaw); this.pitch = pitch;
    this.vy = 0; this.vp = 0;
    this.ty = this.yaw; this.tp = this.pitch;
    this.fast = false; this.scale = 1;
    this.params = this.roll(false);
    this.holdUntil = 0;
    this.moves = 0; this.pauses = 0;
  }

  roll(fast) {
    const P = fast ? PROFILES.fast : PROFILES.calm;
    const r = (a) => rand(a[0], a[1], this.rnd);
    return { omega: r(P.omega), zeta: r(P.zeta), vmax: r(P.vmax), amax: r(P.amax) };
  }

  aim(yaw, pitch, { fast = false, now = 0, scale = 1, hesitate = 0.25 } = {}) {
    yaw = wrapDeg(yaw); pitch = Math.max(-89.5, Math.min(89.5, pitch));
    const jump = angleBetween(this.ty, this.tp, yaw, pitch);
    if (jump > 12 || fast !== this.fast) {
      this.fast = fast; this.params = this.roll(fast); this.moves++;
      const err = angleBetween(this.yaw, this.pitch, yaw, pitch);
      if (!fast && err > 60 && this.rnd() < hesitate) { this.holdUntil = now + rand(60, 170, this.rnd); this.pauses++; }
    }
    this.scale = scale;
    this.ty = yaw; this.tp = pitch;
  }

  error() { return angleBetween(this.yaw, this.pitch, this.ty, this.tp); }
  speed() { return Math.hypot(this.vy, this.vp); }

  step(dtMs, now = 0) {
    if (now < this.holdUntil) { this.vy = 0; this.vp = 0; return 0; }
    if (this.vy === 0 && this.vp === 0 && this.yaw === this.ty && this.pitch === this.tp) return 0;
    const y0 = this.yaw, p0 = this.pitch;
    const s = this.scale;
    const w = this.params.omega * Math.sqrt(s), z = this.params.zeta;
    const vmax = this.params.vmax * s, amax = this.params.amax * s;
    let left = dtMs / 1000;
    while (left > 1e-6) {
      const dt = Math.min(0.01, left); left -= dt;
      const ey = wrapDeg(this.ty - this.yaw), ep = this.tp - this.pitch;
      let ay = w * w * ey - 2 * z * w * this.vy, ap = w * w * ep - 2 * z * w * this.vp;
      const am = Math.hypot(ay, ap);
      if (am > amax) { ay *= amax / am; ap *= amax / am; }
      this.vy += ay * dt; this.vp += ap * dt;
      const vm = Math.hypot(this.vy, this.vp);
      if (vm > vmax) { this.vy *= vmax / vm; this.vp *= vmax / vm; }
      this.yaw = wrapDeg(this.yaw + this.vy * dt);
      this.pitch = Math.max(-90, Math.min(90, this.pitch + this.vp * dt));
    }

    if (this.error() < 0.12 && this.speed() < 3) { this.yaw = this.ty; this.pitch = this.tp; this.vy = 0; this.vp = 0; }
    return angleBetween(y0, p0, this.yaw, this.pitch);
  }
}

function gaussian(r = Math.random) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function reactionDelay(kind = 'reflex', { busy = false, mood = null, rnd = Math.random } = {}) {
  if (kind === 'startle') return Math.round(rand(150, 260, rnd));
  let ms = 260 * Math.exp(0.33 * gaussian(rnd));
  if (kind === 'busy' || busy) ms += rand(60, 140, rnd);
  if (mood === 'scared') ms -= 30;
  else if (mood === 'calm') ms += 40;
  return Math.round(Math.max(150, Math.min(600, ms)));
}

const CLICK_JITTER = [[-1, 0.04], [0, 0.24], [1, 0.30], [2, 0.20], [3, 0.12], [4, 0.06], [5, 0.04]];
function clickJitter(rnd = Math.random) {
  let x = rnd(), acc = 0;
  for (const [ticks, p] of CLICK_JITTER) { acc += p; if (x < acc) return ticks; }
  return 2;
}
class HumanRate {
  constructor(old, rnd = Math.random) { this.old = old; this.rnd = rnd; }
  getTicks(bot) {
    let base = null;
    try {
      const { getCooldown } = require('mineflayer-pvp/lib/Cooldown');
      const held = bot.inventory?.slots?.[bot.getEquipmentDestSlot('hand')];
      base = getCooldown(held?.name);
    } catch {}
    if (!Number.isFinite(base)) return this.old?.getTicks ? this.old.getTicks(bot) : 12;
    return Math.max(1, base + clickJitter(this.rnd));
  }
}

function straightness(points) {
  if (!points || points.length < 2) return 1;
  let walked = 0;
  for (let i = 1; i < points.length; i++) walked += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  if (walked < 0.05) return 1;
  const a = points[0], b = points[points.length - 1];
  return Math.min(1, Math.hypot(b.x - a.x, b.z - a.z) / walked);
}

const MOOD_FAMILY = { hype: 'hype', hyped: 'hype', happy: 'hype', excited: 'hype', scared: 'scared', nervous: 'scared', afraid: 'scared',
  calm: 'calm', chill: 'calm', sad: 'calm', bored: 'calm', tired: 'calm', annoyed: 'annoyed', frustrated: 'annoyed', angry: 'annoyed' };
function moodScaleFor(mood, level) {
  const out = { turn: 1, jumps: 1, lookBacks: 1, idleGap: 1, hesitate: 1, sprint: true, family: null };
  const fam = MOOD_FAMILY[String(mood || '').toLowerCase()];
  if (!fam) return out;
  const L = Math.max(0, Math.min(1, level > 1 ? (level - 1) / 4 : level));
  out.family = fam;
  if (fam === 'hype') { out.turn = 1 + 0.15 * L; out.jumps = 1 + 1.2 * L; out.idleGap = 1 - 0.3 * L; }
  else if (fam === 'scared') { out.turn = 1 - 0.1 * L; out.jumps = 1 - 0.8 * L; out.lookBacks = 1 + 1.5 * L; out.idleGap = 1 - 0.2 * L; out.hesitate = 1 + L; out.sprint = L < 0.35; }
  else if (fam === 'calm') { out.turn = 1 - 0.15 * L; out.jumps = 1 - 0.7 * L; out.lookBacks = 1 - 0.3 * L; out.idleGap = 1 + 0.4 * L; }
  else if (fam === 'annoyed') { out.turn = 1 + 0.1 * L; out.jumps = 1 - 0.4 * L; out.hesitate = 1 - 0.5 * L; }
  return out;
}

const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];

class Motor extends Part {
  constructor(c) {
    super(c, 'humanizer');
    this.rnd = Math.random;
    this.mood = null;
    this.head = null;
    this.whiffs = 0;
    this.smoothed = 0;
  }

  setup(bot) {
    this.resetHead();
    this.action = null;
    this.override = null;
    this.waiters = [];
    this.holds = new Map();
    this.pausedUntil = 0;
    this.fidgetUntil = 0;
    this.walkPitch = -rand(8, 20);
    this.nextWalkPitchAt = 0;
    this.onTarget = { id: null, since: 0 };
    this.lastWhiff = 0;
    this.steerRun = 0; this.steerOffUntil = 0;
    this.telState = { look: 0, path: 0, pts: [], frozenSince: 0, frozenLast: 0, frozenPos: null, frozenHead: null };

    this.patch(bot._client, 'write', (next, name, params) => this.rewrite(next, name, params));
    this.listen(bot._client, 'position', () => { this.headValid = false; }, true);

    this.listen(bot, 'forcedMove', () => { if (!this.head) this.resetHead(); else { this.headValid = !!bot.entity; this.sent = null; } });
    this.listen(bot, 'death', () => { this.headValid = false; });
    this.listen(bot, 'physicsTick', () => this.physics());

    this.patch(bot, 'lookAt', (next, point, force) => this.actionLook(next, point, force));

    this.patch(bot, 'look', (next, yaw, pitch, force) => this.steer(next, yaw, pitch, force));

    this.patch(bot, 'attack', (next, target, swing) => this.click(next, target, swing));

    this.patch(bot, 'dig', (next, ...a) => (this.paused() ? this.whilePaused().then(() => next(...a)) : next(...a)));
    this.patch(bot, '_genericPlace', (next, ...a) => (this.paused() ? this.whilePaused().then(() => next(...a)) : next(...a)));

    if (bot.pvp && bot.pvp.meleeAttackRate && !(bot.pvp.meleeAttackRate instanceof HumanRate)) {
      this.oldRate = bot.pvp.meleeAttackRate;
      bot.pvp.meleeAttackRate = new HumanRate(this.oldRate, this.rnd);
    }
  }

  teardown() {
    const bot = this.bot;
    if (bot?.pvp && bot.pvp.meleeAttackRate instanceof HumanRate) bot.pvp.meleeAttackRate = this.oldRate;
    for (const w of this.waiters || []) w.resolve(false);
    this.waiters = [];
    this.headValid = false;
  }

  resetHead() {
    const e = this.bot?.entity;
    this.head = new Head(e ? e.yaw * DEG : 0, e ? e.pitch * DEG : 0, this.rnd);
    this.headValid = !!e;
    this.sent = null;
  }

  rewrite(next, name, params) {
    if (!this.headValid || !params || (name !== 'look' && name !== 'position_look' && name !== 'position')) return next(name, params);
    const ny = Math.fround(toNotchYaw(this.head.yaw)), np = Math.fround(toNotchPitch(this.head.pitch));
    const same = !!this.sent && this.sent.yaw === ny && this.sent.pitch === np;
    if (name === 'look') {
      if (same) return undefined;
      this.sent = { yaw: ny, pitch: np };
      return next('look', { ...params, yaw: ny, pitch: np });
    }
    if (name === 'position_look') {
      if (same) return next('position', params);
      this.sent = { yaw: ny, pitch: np };
      return next('position_look', { ...params, yaw: ny, pitch: np });
    }
    if (same) return next(name, params);
    this.sent = { yaw: ny, pitch: np };
    return next('position_look', { ...params, yaw: ny, pitch: np });
  }

  flushLook() {
    const bot = this.bot;
    if (!this.headValid || !bot?.entity || bot._client?.state !== 'play' || bot.isAlive === false) return;
    if (!Number.isFinite(bot.entity.position?.x)) return;
    const ny = Math.fround(toNotchYaw(this.head.yaw)), np = Math.fround(toNotchPitch(this.head.pitch));
    if (this.sent && this.sent.yaw === ny && this.sent.pitch === np) return;
    const onGround = !!bot.entity.onGround;
    try { bot._client.write('look', { yaw: ny, pitch: np, onGround, flags: { onGround, hasHorizontalCollision: undefined } }); } catch {}
  }

  physics() {
    const bot = this.bot;
    if (!bot?.entity || !this.head) return;
    const now = Date.now();
    this.applyHolds(now);
    if (!this.headValid) return;
    const t = this.targetNow(now);
    const ms = this.moodScale();
    this.head.aim(t.yaw, t.pitch, { fast: t.fast, now, scale: ms.turn, hesitate: 0.25 * ms.hesitate });
    const y0 = this.head.yaw, p0 = this.head.pitch;
    const moved = this.head.step(50, now);
    this.trackAim(now);
    this.checkWaiters(now);
    this.telemetry(now, moved, wrapDeg(this.head.yaw - y0), this.head.pitch - p0);

    this.flushLook();
  }

  eye() { const e = this.bot.entity; return e.position.offset(0, e.eyeHeight ?? 1.62, 0); }

  targetNow(now) {
    const bot = this.bot, e = bot.entity, eye = this.eye();
    if (this.action && now < this.action.until) { const ap = pointOf(this.action.point); if (ap) return { ...yawPitchTo(eye, ap), fast: this.action.fast }; }
    if (this.override && now < this.override.until) {
      const o = this.override;
      if (o.target && Number.isFinite(o.target.yaw)) return { yaw: o.target.yaw, pitch: o.target.pitch, fast: o.fast };
      const p = pointOf(o.target);
      if (p) return { ...yawPitchTo(eye, p), fast: o.fast };
    }
    const ft = bot.pvp?.target;
    if (ft && ft.position && ft.isValid !== false && ft.position.distanceTo(e.position) < 12) {
      return { ...yawPitchTo(eye, ft.position.offset(0, (ft.height || 1.8) * 0.8, 0)), fast: true };
    }
    let pitch = e.pitch * DEG;
    const moving = typeof bot.pathfinder?.isMoving === 'function' && bot.pathfinder.isMoving();
    if (moving && Math.abs(pitch) < 0.01) {

      if (now > this.nextWalkPitchAt) { this.walkPitch = -rand(6, 22, this.rnd); this.nextWalkPitchAt = now + rand(2500, 7000, this.rnd); }
      pitch = this.walkPitch;
    }
    return { yaw: wrapDeg(e.yaw * DEG), pitch, fast: false };
  }

  trackAim(now) {
    const ft = this.bot.pvp?.target;
    if (!ft || !ft.position) { this.onTarget = { id: null, since: 0 }; return; }
    const on = this.onCrosshair(ft);
    if (on && this.onTarget.id !== ft.id) this.onTarget = { id: ft.id, since: now };
    else if (!on) this.onTarget = { id: null, since: 0 };
  }

  onCrosshair(e) {
    const eye = this.eye();
    const h = e.height || 1.8;
    const c = e.position.offset(0, h / 2, 0);
    const yp = yawPitchTo(eye, c);
    const d = Math.max(0.5, c.distanceTo(eye));
    const size = Math.atan2(Math.max(h / 2, (e.width || 0.6) / 2), d) * DEG;
    return angleBetween(this.head.yaw, this.head.pitch, yp.yaw, yp.pitch) <= size + 4;
  }

  aimSince(target, now = Date.now()) {
    if (!target?.position || !this.head) return -1;
    if (this.onTarget.id === target.id && this.onTarget.since) return now - this.onTarget.since;
    return this.onCrosshair(target) ? 0 : -1;
  }

  actionLook(next, point, force) {
    const bot = this.bot;
    if (!point || !Number.isFinite(point.x) || !bot?.entity || !this.headValid) return next(point, force);
    next(point, true);
    const now = Date.now();
    const air = !bot.entity.onGround;
    const building = typeof bot.pathfinder?.isBuilding === 'function' && bot.pathfinder.isBuilding();
    const fast = force === true || air || building;
    const yp = yawPitchTo(this.eye(), point);
    const ang = angleBetween(this.head.yaw, this.head.pitch, yp.yaw, yp.pitch);
    const maxMs = air || building ? 120 : fast ? 300 : Math.min(700, 250 + (ang / 172) * 1000);
    let p = typeof point.clone === 'function' ? point.clone() : { x: point.x, y: point.y, z: point.z };

    const ft = bot.pvp?.target;
    if (ft?.position && Math.abs(point.x - ft.position.x) < 0.01 && Math.abs(point.z - ft.position.z) < 0.01) p = ft;
    this.action = { point: p, until: now + maxMs + 400, fast };
    return this.waitFor(p, fast ? 6 : 4, maxMs).then((ok) => { if (this.action && this.action.point === p) this.action.until = Date.now() + 250; return ok; });
  }

  waitFor(point, tol, maxMs) {
    return new Promise((resolve) => {
      const w = { point, tol, until: Date.now() + maxMs, resolve: null };
      const timer = setTimeout(() => done(false), maxMs + 200);
      const done = (ok) => { if (w.resolve) { clearTimeout(timer); w.resolve = null; this.waiters = this.waiters.filter((x) => x !== w); resolve(ok); } };
      w.resolve = done;
      this.waiters.push(w);
    });
  }

  checkWaiters(now) {
    if (!this.waiters.length) return;
    const eye = this.eye();
    for (const w of this.waiters.slice()) {
      const p = pointOf(w.point);
      if (!p) { w.resolve?.(false); continue; }
      const yp = yawPitchTo(eye, p);
      const err = angleBetween(this.head.yaw, this.head.pitch, yp.yaw, yp.pitch);
      if (err <= w.tol && this.head.speed() < 90) w.resolve?.(true);
      else if (now >= w.until) w.resolve?.(false);
    }
  }

  installed() { return !!(this.bot && this.head && this.headValid && this.on()); }

  lookAt(pos, { force = false, holdMs = 1000 } = {}) {
    const bot = this.c.bot;
    const p = pointOf(pos);
    if (!bot || !p) return Promise.resolve(false);
    if (!this.installed()) return Promise.resolve(bot.lookAt(p, force)).catch(() => false);
    const moving = typeof bot.pathfinder?.isMoving === 'function' && bot.pathfinder.isMoving();
    if (moving) return this.glance(pos, { holdMs, fast: force });
    return Promise.resolve(bot.lookAt(p, force)).catch(() => false);
  }

  glance(target, { holdMs = 600, fast = false } = {}) {
    if (!this.installed() || !target) return Promise.resolve(false);
    const o = { target, until: Date.now() + 1500 + holdMs, fast };
    this.override = o;
    const p = Number.isFinite(target.yaw) ? null : pointOf(target);
    const arrive = p ? this.waitFor(p, fast ? 6 : 5, 1200) : new Promise((r) => setTimeout(() => r(true), 350));
    return arrive.then(() => new Promise((resolve) => {
      if (this.override !== o) return resolve(false);
      o.until = Date.now() + holdMs;
      setTimeout(() => resolve(this.override === o), holdMs);
    }));
  }

  release() { this.override = null; }

  attack(entity) {
    const bot = this.c.bot;
    if (!bot || !entity) return Promise.resolve(false);
    if (!this.installed()) { try { bot.attack(entity); } catch {} return Promise.resolve(true); }
    const p = pointOf(entity);
    return Promise.resolve(bot.lookAt(p, true)).catch(() => {}).then(() => { try { bot.attack(entity); } catch {} return true; });
  }

  facingDeg(pos) {
    const bot = this.c.bot;
    const p = pointOf(pos);
    if (!bot?.entity || !p) return 180;
    const yp = yawPitchTo(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0), p);
    return angleBetween(this.headYaw(), this.headPitch(), yp.yaw, yp.pitch);
  }
  headYaw() { return this.installed() ? this.head.yaw : wrapDeg((this.c.bot?.entity?.yaw || 0) * DEG); }
  headPitch() { return this.installed() ? this.head.pitch : (this.c.bot?.entity?.pitch || 0) * DEG; }

  steer(next, yaw, pitch, force) {
    const bot = this.bot;
    if (force || pitch !== 0 || !bot?.entity || !bot.entity.onGround || bot.entity.isInWater) return next(yaw, pitch, force);
    const now = Date.now();
    if (now < this.steerOffUntil || !(typeof bot.pathfinder?.isMoving === 'function' && bot.pathfinder.isMoving()) || this.nearGoal() || !this.openGround()) {
      this.steerRun = 0;
      return next(yaw, pitch, force);
    }
    const cur = bot.entity.yaw;
    const d = wrapDeg((yaw - cur) * DEG);
    const max = Math.abs(d) <= 60 ? 20 : 45;
    if (Math.abs(d) > max) {
      this.smoothed++;
      if (++this.steerRun > 12) { this.steerOffUntil = now + 1000; this.steerRun = 0; return next(yaw, pitch, force); }
      return next(cur + Math.sign(d) * max * RAD, pitch, force);
    }
    this.steerRun = 0;
    return next(yaw, pitch, force);
  }

  nearGoal() {
    const g = this.bot.pathfinder?.goal;
    const pos = this.bot.entity.position;
    if (!g) return true;
    if (g.entity?.position) return g.entity.position.distanceTo(pos) < 3;
    if (Number.isFinite(g.x) && Number.isFinite(g.z)) return Math.hypot(g.x + 0.5 - pos.x, g.z + 0.5 - pos.z) < 2.5;
    return false;
  }

  openGround() {
    const bot = this.bot;
    const f = bot.entity.position.floored();
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const floor = bot.blockAt(f.offset(dx, -1, dz));
      const feet = bot.blockAt(f.offset(dx, 0, dz));
      const head = bot.blockAt(f.offset(dx, 1, dz));
      if (!isSolid(floor) || isSolid(feet) || isSolid(head)) return false;
      if (feet && /lava|water|fire/.test(feet.name)) return false;
    }
    return true;
  }

  click(next, target, swing = true) {

    if (target?.position && this.headValid && !this.onCrosshair(target)) {
      const start = Date.now();
      this.action = { point: target, until: start + 400, fast: true };
      const tryFire = () => {
        if (!this.bot) return;
        const waited = Date.now() - start;
        if (!this.onCrosshair(target) && waited < 200) { setTimeout(tryFire, 25); return; }
        const pvp = this.bot.pvp;
        if (pvp && pvp.target === target && waited > 25) pvp.timeToNextAttack += Math.ceil(waited / 50);
        this.fire(next, target, swing);
      };
      setTimeout(tryFire, 25);
      return undefined;
    }
    return this.fire(next, target, swing);
  }

  fire(next, target, swing = true) {
    const now = Date.now();
    this.tel({ t: now, kind: 'click', target: target?.username ? 'player' : target?.name || 'thing', ms_since_target_seen: this.aimSince(target, now) });
    const bot = this.bot;
    const risky = !target || target.type === 'player' || target.name === 'creeper' || (bot?.health ?? 20) <= 8;
    if (swing !== false && !risky && now - this.lastWhiff > 6000 && chance(0.035, this.rnd)) {

      this.lastWhiff = now; this.whiffs++;
      try { bot.swingArm(); } catch {}
      return undefined;
    }
    return next(target, swing);
  }

  beforeAttack(entity) {
    if (!this.on() || !this.bot || !entity) return null;
    const c = this.c;
    if (this.bot.pvp?.target === entity) return null;
    if (this.pending && this.pending.entity === entity) return true;
    const delay = this.reactionDelay(c.task ? 'busy' : 'reflex');
    this.pending = { entity, at: Date.now(), delay };
    c.attackTarget = entity;
    c.goalKind = 'attack';
    c.equipBestWeapon();
    this.later(delay, () => {
      const p = this.pending;
      if (!p || p.entity !== entity) return;
      this.pending = null;
      if (c.attackTarget !== entity || !this.live() || !this.bot.entities[entity.id]) return;
      c.attack(entity, true);
    });
    return true;
  }

  reactionDelay(kind = 'reflex') {
    return reactionDelay(kind, { busy: !!this.c.task, mood: this.moodScale().family, rnd: this.rnd });
  }

  hold(name, ms, set) { this.holds.set(name, { until: Date.now() + ms, set: { ...set } }); }
  unhold(name) {
    const h = this.holds?.get(name);
    if (!h) return;
    this.holds.delete(name);
    for (const [k, v] of Object.entries(h.set)) if (v === true) { try { this.bot.setControlState(k, false); } catch {} }
  }
  applyHolds(now) {
    if (!this.holds?.size) return;
    for (const [name, h] of [...this.holds]) {
      if (now >= h.until) { this.unhold(name); continue; }
      for (const [k, v] of Object.entries(h.set)) { try { this.bot.setControlState(k, v); } catch {} }
    }

    const ms = this.moodScale();
    if (!ms.sprint && this.c.mode === 'follow' && !this.c.task && !this.bot.pvp?.target) { try { this.bot.setControlState('sprint', false); } catch {} }
  }

  pause(ms) {
    if (!this.installed()) return false;
    this.pausedUntil = Date.now() + ms;
    this.hold('pause', ms, Object.fromEntries(MOVE_KEYS.map((k) => [k, false])));
    return true;
  }
  resume() { this.pausedUntil = 0; this.holds?.delete('pause'); }
  paused() { return !!this.bot && Date.now() < (this.pausedUntil || 0); }
  whilePaused() {
    return new Promise((resolve) => {
      const check = () => (this.paused() ? setTimeout(check, 100) : resolve());
      check();
    });
  }

  fidget(controls, ticks = 3) {
    if (!this.installed()) return false;
    const ms = ticks * 50;
    this.fidgetUntil = Date.now() + ms + 600;
    this.hold('fidget', ms, controls);
    return true;
  }
  fidgeting() { return !!this.bot && Date.now() < (this.fidgetUntil || 0); }

  setMood(m) {
    if (!m || typeof m !== 'object') { this.mood = null; return; }
    this.mood = { mood: String(m.mood || ''), level: Number.isFinite(Number(m.level)) ? Number(m.level) : 0.5, at: Date.now() };
  }
  moodScale() {
    const m = this.mood;
    if (!m || !this.c.f('mood') || Date.now() - m.at > 5 * 60 * 1000) return moodScaleFor(null);
    return moodScaleFor(m.mood, m.level);
  }

  tel(rec) { if (this.on()) this.c.emit('telemetry', rec); }

  telemetry(now, moved, dy, dp) {
    const s = this.telState, bot = this.bot, pos = bot.entity.position;
    if (moved > 0.05 && now - s.look >= 300) {
      s.look = now;
      this.tel({ t: now, kind: 'look', yaw: round1(toNotchYaw(this.head.yaw)), pitch: round1(toNotchPitch(this.head.pitch)), dyaw: round1(-dy), dpitch: round1(-dp) });
    }
    const v = bot.entity.velocity || { x: 0, z: 0 };
    s.pts.push({ x: pos.x, z: pos.z, t: now });
    while (s.pts.length && now - s.pts[0].t > 2000) s.pts.shift();
    if (Math.hypot(v.x || 0, v.z || 0) > 0.05 && now - s.path >= 1000) {
      s.path = now;
      this.tel({ t: now, kind: 'path', x: round1(pos.x), z: round1(pos.z), straightness: Math.round(straightness(s.pts) * 100) / 100 });
    }

    const idle = !this.c.task && !bot.targetDigBlock;
    const still = moved < 0.3 && (!s.frozenPos || s.frozenPos.distanceTo(pos) < 0.03);
    if (idle && still) {
      if (!s.frozenSince) { s.frozenSince = now; s.frozenLast = now; s.frozenPos = pos.clone(); }
      else if (now - s.frozenLast >= 10000) { this.tel({ t: now, kind: 'idle_frozen_ms', ms: now - s.frozenSince }); s.frozenLast = now; }
    } else {
      if (s.frozenSince && now - s.frozenSince >= 2000) this.tel({ t: now, kind: 'idle_frozen_ms', ms: now - s.frozenSince });
      s.frozenSince = 0; s.frozenPos = null;
    }
  }
}

function round1(x) { return Math.round(x * 10) / 10; }

function pointOf(t) {
  if (!t) return null;
  if (t.position && typeof t.type === 'number') {
    const p = t.position;
    return p.offset ? p.offset(0.5, 0.5, 0.5) : { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 };
  }
  if (t.position) {
    const h = t.height || 1.8;
    return t.position.offset ? t.position.offset(0, h * 0.85, 0) : { x: t.position.x, y: t.position.y + h * 0.85, z: t.position.z };
  }
  if (Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)) return t;
  return null;
}

module.exports = { Motor, Head, PROFILES, reactionDelay, clickJitter, HumanRate, straightness, moodScaleFor, pointOf };
