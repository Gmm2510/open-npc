// Small human habits on top of the motor module: glances, look-arounds, a half step, eating, looking back at the player.
const { Part, Cooldowns, rand, chance, wrapDeg, dirOf, isSolid, isLiquid, DEG, lru, findBlocksFast } = require('./bodykit');
const { reactionDelay } = require('./motor');
const { entityVisible } = require('./perception');
const { Ledger } = require('../shared/ledger');

const IDLES = ['glance_player', 'look_around', 'look_down', 'look_far', 'look_thing', 'check_hand', 'half_step', 'shuffle'];
const GAP_FILLERS = ['check_hand', 'half_step', 'look_down', 'shuffle', 'look_thing'];
const ARRIVAL = ['look_around', 'look_far', 'glance_player', 'look_down', 'check_hand'];
const THINGS = /^(crafting_table|furnace|chest|barrel|torch|wall_torch|lantern|[a-z_]+_door|[a-z_]+_bed|poppy|dandelion|[a-z_]+_tulip|cornflower|campfire|bell|anvil)$/;
const HOSTILE_NAMES = /zombie|husk|drowned|skeleton|stray|bogged|creeper|spider|witch|enderman|slime|phantom|pillager|vindicator|silverfish|blaze|ghast|piglin_brute|hoglin|zoglin|guardian|breeze/;

class Habits extends Part {
  constructor(c) {
    super(c, ['humanizer', 'reactions']);
    this.ledger = new Ledger();
    this.cool = new Cooldowns();
    this.away = false;
    this.arrival = null;
    this.lastIdle = null;
  }

  hz() { return this.c.f('humanizer'); }
  motor() { return this.c.v12.motor?.installed?.() ? this.c.v12.motor : null; }
  owner() { return this.c.ownerEntity(); }

  setup(bot) {
    const now = Date.now();
    this.nextIdle = now + rand(2000, 4000);
    this.nextLookBack = now + rand(6000, 15000);
    this.nextJump = now + rand(1500, 5000);
    this.nextEdge = now + rand(4, 9) * 60000;
    this.edge = null;
    this.linePause = null;
    this.yawHist = [];
    this.lastHealth = bot.health;
    this.lastTalk = now; this.cueSeen = false; this.gapShortened = false;
    this.away = false;
    this.arrival = this.hz() ? { until: now + rand(3500, 6000), next: now + rand(300, 700) } : null;
    this.listen(bot, 'physicsTick', () => this.physics());
    this.listen(bot, 'soundEffectHeard', (name, pos) => this.onSound(name, pos));
    this.listen(bot, 'entityHurt', (e, src) => this.onHurt(e, src));
    this.listen(bot, 'entitySpawn', (e) => this.onSpawnEntity(e));
    this.listen(bot, 'health', () => { this.prevHealth = this.lastHealth; this.lastHealth = bot.health; });
  }

  teardown() { this.arrival = null; this.away = false; this.edge = null; }

  fighting() { const c = this.c; return !!(c.bot?.pvp?.target || c.attackTarget || c.mode === 'flee'); }
  moving() { const pf = this.c.bot?.pathfinder; return typeof pf?.isMoving === 'function' && pf.isMoving(); }
  socialBusy() { const s = this.c.v12.social; return !!(s && (s.crouching || s.hyping || s.watch || s.giving)); }
  isIdle() {
    const c = this.c, bot = c.bot;
    if (c.task || c.busy || c.eating || this.fighting() || this.moving() || this.socialBusy() || this.edge) return false;
    if (!['follow', 'stay', 'guard'].includes(c.mode) || !bot.entity.onGround || bot.targetDigBlock) return false;
    const v = bot.entity.velocity || {};
    return Math.hypot(v.x || 0, v.z || 0) < 0.03;
  }

  onTick(now) {
    if (!this.live() || !this.hz()) return;
    const m = this.motor();
    if (!m) return;
    if (this.arrival) this.arrivalStep(now, m);
    if (this.away) return;
    if (this.isIdle()) this.idleStep(now, m);
    else if (this.moving() && !this.fighting() && !this.c.v12.awareness?.isTense?.() && (this.c.mode === 'follow' || /^explore$/.test(this.c.task?.name || ''))) this.lookBackStep(now, m);
    this.freeWillGap(now);
    if (!this.edge && now >= this.nextEdge && this.isIdle()) this.edgeFind(now);
  }

  takeOver(now) {
    if (!this.edge || !this.live()) return null;
    return this.edgeStep(now);
  }

  idleStep(now, m) {
    if (now < this.nextIdle) return;
    const ms = m.moodScale();
    this.nextIdle = now + rand(2500, 7000) * ms.idleGap;
    const pool = IDLES.slice();
    const bot = this.c.bot, o = this.owner();
    if (!o || o.position.distanceTo(bot.entity.position) > 24) pool.splice(pool.indexOf('glance_player'), 1);
    if (bot.food <= 17 && this.cool.ok('eat', 90000, now) && bot.inventory.items().some((i) => /^(cooked_|bread|baked_potato|apple|carrot|golden_carrot|sweet_berries)/.test(i.name))) pool.push('eat');
    if (ms.family === 'hype') pool.push('hop');
    if (this.c.v12.social?.idleFacing?.() != null) { pool.splice(pool.indexOf('look_around'), 1); pool.push('face_out'); }
    const pick = lru(this.ledger, 'idle', pool);
    this.lastIdle = pick;
    this.perform(pick, m);
  }

  perform(kind, m) {
    const bot = this.c.bot, o = this.owner();
    const yaw = m.headYaw(), pitch = m.headPitch();
    switch (kind) {
      case 'glance_player': if (o) return m.lookAt(o.position.offset(0, o.crouching ? 1.27 : 1.62, 0)); return this.perform('look_around', m);
      case 'look_around': return m.glance({ yaw: wrapDeg(yaw + (chance(0.5) ? 1 : -1) * rand(40, 110)), pitch: rand(-10, 8) }, { holdMs: rand(800, 2000) });
      case 'look_down': return m.glance({ yaw: wrapDeg(yaw + rand(-20, 20)), pitch: -rand(30, 55) }, { holdMs: rand(700, 1500) });
      case 'look_far': return m.glance({ yaw: wrapDeg(yaw + rand(-60, 60)), pitch: rand(0, 10) }, { holdMs: rand(1000, 2500) });
      case 'check_hand': return m.glance({ yaw: wrapDeg(yaw + rand(-12, 12)), pitch: -rand(55, 70) }, { holdMs: rand(500, 1000) });
      case 'face_out': { const f = this.c.v12.social.idleFacing(); return m.glance({ yaw: wrapDeg(f + rand(-35, 35)), pitch: rand(-8, 5) }, { holdMs: rand(1500, 3000) }); }
      case 'look_thing': {
        const t = this.thingToLookAt();
        if (t) return m.glance(t, { holdMs: rand(900, 1800) });
        return m.glance({ yaw: wrapDeg(yaw + rand(-70, 70)), pitch: rand(-15, 5) }, { holdMs: rand(800, 1600) });
      }
      case 'half_step': return this.halfStep(m);
      case 'shuffle': {
        const turn = wrapDeg(bot.entity.yaw * DEG + (chance(0.5) ? 1 : -1) * rand(10, 25));
        const d = dirOf(turn, pitch);
        bot.lookAt(bot.entity.position.offset(d.x * 4, (bot.entity.eyeHeight ?? 1.62) + d.y * 4, d.z * 4)).catch(() => {});
        return this.halfStep(m);
      }
      case 'eat': this.cool.mark('eat'); return this.c.tryEat();
      case 'hop': bot.setControlState('jump', true); setTimeout(() => { try { bot.setControlState('jump', false); } catch {} }, 100); return undefined;
      default: return undefined;
    }
  }

  thingToLookAt() {
    const bot = this.c.bot, eye = bot.entity.position.offset(0, 1.62, 0);
    const ents = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && e.type !== 'player' && e.position.distanceTo(eye) < 16)
      .sort((a, b) => a.position.distanceTo(eye) - b.position.distanceTo(eye));
    for (const e of ents.slice(0, 4)) if (entityVisible(bot, eye, e)) return e;
    if (!this.thingNames) this.thingNames = Object.keys(bot.registry?.blocksByName || {}).filter((n) => THINGS.test(n));
    const ps = findBlocksFast(bot, this.thingNames, { maxDistance: 8, count: 3, maxFullScans: 8 });
    return ps.length ? ps[Math.floor(Math.random() * ps.length)].offset(0.5, 0.5, 0.5) : null;
  }

  halfStep(m) {
    const bot = this.c.bot;
    const dirs = [['forward', 0], ['back', 180], ['left', 90], ['right', -90]].sort(() => Math.random() - 0.5);
    for (const [key, off] of dirs) {
      const d = dirOf(wrapDeg(bot.entity.yaw * DEG + off), 0);
      if (this.safeStep(d)) return m.fidget({ [key]: true }, 2 + Math.floor(Math.random() * 3));
    }
    return false;
  }

  safeStep(d) {
    const bot = this.c.bot, p = bot.entity.position;
    for (const k of [0.7, 1.4]) {
      const q = p.offset(d.x * k, 0, d.z * k).floored();
      const feet = bot.blockAt(q, false), head = bot.blockAt(q.offset(0, 1, 0), false), floor = bot.blockAt(q.offset(0, -1, 0), false);
      if (!feet || isSolid(feet) || isSolid(head) || !isSolid(floor)) return false;
      if (isLiquid(feet) || isLiquid(floor) || /fire|lava|magma|cactus|campfire/.test(`${feet.name} ${floor.name}`)) return false;
    }
    return true;
  }

  lookBackStep(now, m) {
    if (now < this.nextLookBack) return;
    const ms = m.moodScale();
    this.nextLookBack = now + rand(8000, 25000) / Math.max(0.3, ms.lookBacks);
    if (['come', 'pickup'].includes(this.c.mode)) return;
    const o = this.owner(), bot = this.c.bot;
    const yaw = m.headYaw();
    if (o && chance(0.4)) {
      const rel = Math.abs(wrapDeg(Math.atan2(-(o.position.x - bot.entity.position.x), -(o.position.z - bot.entity.position.z)) * DEG - yaw));
      if (rel > 60 && o.position.distanceTo(bot.entity.position) < 24) return m.glance(o.position.offset(0, 1.5, 0), { holdMs: rand(350, 700) });
    }
    return m.glance({ yaw: wrapDeg(yaw + (chance(0.5) ? 1 : -1) * rand(110, 160)), pitch: rand(-10, 5) }, { holdMs: rand(350, 700) });
  }

  physics() {
    if (!this.hz() || !this.live() || !this.motor()) return;
    const bot = this.c.bot, e = bot.entity, now = Date.now();
    this.yawHist.push(e.yaw);
    if (this.yawHist.length > 8) this.yawHist.shift();
    if (now < this.nextJump) return;
    const ok = this.moving() && bot.controlState?.sprint && bot.controlState?.forward && e.onGround && !e.isInWater && this.steadyYaw() && this.openAhead();
    if (!ok) { this.nextJump = now + 300; return; }
    bot.setControlState('jump', true);
    this.jumps = (this.jumps || 0) + 1;
    this.nextJump = now + rand(1200, 5500) / Math.max(0.15, this.motor().moodScale().jumps);
  }

  steadyYaw() {
    if (this.yawHist.length < 8) return false;
    const base = this.yawHist[0];
    return this.yawHist.every((y) => Math.abs(wrapDeg((y - base) * DEG)) < 8);
  }

  openAhead() {
    const bot = this.c.bot, p = bot.entity.position;
    const d = dirOf(bot.entity.yaw * DEG, 0);
    for (let k = 0; k <= 3; k++) {
      const q = p.offset(d.x * k, 0, d.z * k).floored();
      const floor = bot.blockAt(q.offset(0, -1, 0), false);
      if (!isSolid(floor) || isLiquid(floor)) return false;
      for (const dy of [0, 1, 2]) { const b = bot.blockAt(q.offset(0, dy, 0), false); if (!b || isSolid(b) || isLiquid(b)) return false; }
    }
    return true;
  }

  freeWillGap(now) {
    if (!this.cueSeen || this.gapShortened || now - this.lastTalk < 60000 || !this.isIdle()) return;
    this.gapShortened = true;
    this.c.freeGap = Math.min(this.c.freeGap, rand(40000, 70000));
  }

  onCue(kind, data = {}) {
    if (!this.hz() || !this.live()) return;
    const now = Date.now();
    if (kind === 'player_talking_start' || kind === 'player_talking_end') { this.cueSeen = true; this.lastTalk = now; this.gapShortened = false; return; }
    const m = this.motor();
    if (!m) return;
    if (kind === 'thinking_start') return this.fillGap(m);
    if (kind === 'line_start') return this.maybePause(m, data);
    if (kind === 'line_end') { if (this.linePause) { this.linePause = null; m.resume(); m.release(); } return; }
    if (kind === 'leaving') return this.leave(m);
    if (kind === 'back') return this.comeBack(m);
  }

  fillGap(m) {
    if (this.c.task || this.fighting() || this.moving() || this.away || this.socialBusy()) return;
    const o = this.owner(), bot = this.c.bot;
    this.later(rand(80, 250), () => {
      if (!this.live() || this.moving()) return;
      if (o && o.position.distanceTo(bot.entity.position) <= 12 && m.facingDeg(o.position.offset(0, 1.62, 0)) > 20) { this.lastGap = 'glance_player'; m.lookAt(o.position.offset(0, 1.62, 0)); return; }
      const pick = lru(this.ledger, 'gap', GAP_FILLERS);
      this.lastGap = pick;
      this.perform(pick, m);
    });
  }

  maybePause(m, data) {
    const c = this.c, bot = c.bot;
    const words = Number(data.words) || 0;
    if (!c.task || !(data.big || words >= 18) || this.fighting() || c.v12.awareness?.isTense?.() || !bot.entity.onGround) return;
    if (c.nearestHostile(8) || !this.cool.take('linepause', 45000)) return;
    const ms = Math.max(2500, Math.min(8000, (words || 12) * 330));
    if (!m.pause(ms)) return;
    this.linePause = { until: Date.now() + ms };
    const o = this.owner();
    if (o && o.position.distanceTo(bot.entity.position) <= 16) m.glance(o.position.offset(0, 1.62, 0), { holdMs: ms - 400 });
  }

  leave(m) {
    const c = this.c;
    this.away = true;
    this.arrival = null;
    if (this.linePause) { this.linePause = null; m.resume(); }
    m.release();
    if (c.task) c.cancelTask('stepped away');
    if (!this.fighting()) c.setMode('away', 0);
    c.goalKind = null;
  }

  comeBack(m) {
    if (!this.away) return;
    this.away = false;
    if (this.c.mode === 'away') { this.c.setMode('follow', 0); this.c.lastFreeTime = Date.now(); }
    this.arrival = { until: Date.now() + rand(1500, 2500), next: Date.now() + rand(200, 500) };
  }

  arrivalStep(now, m) {
    const a = this.arrival;
    if (now > a.until) { this.arrival = null; return; }
    if (now < a.next || this.fighting()) return;
    a.next = now + rand(900, 1600);
    this.perform(lru(this.ledger, 'arrive', ARRIVAL), m);
  }

  command() { if (this.arrival) this.arrival = null; return null; }

  edgeFind(now) {
    this.nextEdge = now + rand(8, 15) * 60000;
    if (!chance(0.35)) return;
    const bot = this.c.bot, p = bot.entity.position.floored();
    for (let i = 0; i < 8; i++) {
      const d = dirOf(i * 45, 0);
      let last = null;
      for (let k = 1; k <= 4; k++) {
        const q = p.offset(Math.round(d.x * k), 0, Math.round(d.z * k));
        const floor = bot.blockAt(q.offset(0, -1, 0), false);
        if (isSolid(floor)) { if (isSolid(bot.blockAt(q, false)) || isSolid(bot.blockAt(q.offset(0, 1, 0), false))) break; last = q; continue; }
        let drop = 0;
        for (let dy = 1; dy <= 10; dy++) { const b = bot.blockAt(q.offset(0, -dy, 0), false); if (isSolid(b) || isLiquid(b)) break; drop++; }
        if (drop >= 6 && last) { this.edge = { stage: 'walk', spot: last, look: q.offset(0.5, -3, 0.5), since: now }; return; }
        break;
      }
    }
  }

  edgeStep(now) {
    const e = this.edge, bot = this.c.bot, m = this.motor();
    if (!m || this.c.task || this.fighting() || now - e.since > 15000) return this.edgeDone();
    if (e.stage === 'walk') {
      if (!e.goal) { e.goal = true; const { GoalBlock } = require('mineflayer-pathfinder').goals; bot.pathfinder.setGoal(new GoalBlock(e.spot.x, e.spot.y, e.spot.z)); this.c.goalKind = 'edge'; }
      if (bot.entity.position.floored().equals(e.spot) || (!this.moving() && now - e.since > 2000)) {
        e.stage = 'peek'; e.until = now + rand(1200, 2000);
        bot.setControlState('sneak', true);
        m.glance(e.look, { holdMs: e.until - now });
      }
      return true;
    }
    if (now >= e.until) {
      bot.setControlState('sneak', false);
      m.fidget({ back: true }, 4);
      return this.edgeDone();
    }
    bot.setControlState('sneak', true);
    return true;
  }

  edgeDone() { try { this.c.bot.setControlState('sneak', false); } catch {} this.edge = null; this.c.goalKind = null; return null; }

  onSound(name, pos) {
    if (!this.c.f('reactions') || !this.live() || !pos) return;
    if (/creeper[._]primed/.test(name) && pos.distanceTo(this.c.bot.entity.position) <= 6) {
      const creeper = Object.values(this.c.bot.entities).find((e) => e.name === 'creeper' && e.position.distanceTo(pos) < 3);
      this.flinch({ from: pos, entity: creeper || null, kind: 'creeper' });
    }
  }

  onHurt(e, src) {
    if (!this.c.f('reactions') || !this.live() || e !== this.c.bot.entity) return;
    const bot = this.c.bot, owner = this.owner();
    const byPlayer = !!(src && src.type === 'player') || (!!owner && !this.c.nearestHostile(4) && owner.position.distanceTo(bot.entity.position) < 4.5 && !src);
    const drop = (this.prevHealth ?? 20) - bot.health;
    const knownBefore = this.c.nearestHostile(6);
    const sudden = drop >= 3 || !knownBefore;
    if (!sudden) return;
    const threat = src && src.position ? src : knownBefore;
    this.flinch({ from: threat?.position || null, entity: byPlayer ? null : threat, kind: 'hit', byPlayer });
  }

  onSpawnEntity(e) {
    if (!this.c.f('reactions') || !this.live() || !e?.position) return;
    if (!(e.type === 'hostile' || HOSTILE_NAMES.test(e.name || ''))) return;
    if (e.position.distanceTo(this.c.bot.entity.position) <= 3) this.flinch({ from: e.position, entity: e, kind: 'spawn' });
  }

  flinch(t) {
    if (!this.cool.take('flinch', 6000)) return false;
    const m = this.motor();
    const delay = m ? m.reactionDelay('startle') : reactionDelay('startle');
    this.lastFlinch = { ...t, at: Date.now(), delay };
    this.later(delay, () => this.doFlinch(t, m));
    return true;
  }

  doFlinch(t, m) {
    if (!this.live()) return;
    const c = this.c, bot = c.bot;
    const pathing = this.moving() || !!c.task;
    const from = t.from || (t.entity && t.entity.position);
    if (from) {
      const at = from.offset ? from.offset(0, 1.2, 0) : from;
      if (m) m.glance(at, { fast: true, holdMs: 450 });
      else if (!pathing) bot.lookAt(at, true).catch(() => {});
    }
    const close = t.entity && t.entity.position && t.entity.position.distanceTo(bot.entity.position) <= 3.2;
    if (close && !t.byPlayer && !c.v12.awareness?.refuseTarget?.(t.entity)) {
      this.lastFlinch.did = 'swing';
      try { bot.attack(t.entity); } catch {}
      return;
    }
    if (pathing || !from) { if (!t.byPlayer) { this.lastFlinch.did = 'arm'; try { bot.swingArm(); } catch {} } return; }

    const away = { x: bot.entity.position.x - from.x, z: bot.entity.position.z - from.z };
    const len = Math.hypot(away.x, away.z) || 1;
    const dir = { x: away.x / len, y: 0, z: away.z / len };
    if (!this.safeStep(dir)) { this.lastFlinch.did = t.byPlayer ? 'none' : 'arm'; if (!t.byPlayer) { try { bot.swingArm(); } catch {} } return; }
    this.lastFlinch.did = 'step';

    bot.lookAt(from.offset ? from.offset(0, 1.6, 0) : from, true).catch(() => {});
    if (m) m.hold('flinch', 220, { back: true, forward: false, sprint: false });
    else { bot.setControlState('back', true); setTimeout(() => { try { bot.setControlState('back', false); } catch {} }, 220); }
  }
}

module.exports = { Habits, IDLES, GAP_FILLERS };
