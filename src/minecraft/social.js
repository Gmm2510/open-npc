// A body that hangs out with you: turns to you, walks beside you, waits when leading, crouches back.
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { Part, Cooldowns, rand, chance, dirOf, wrapDeg, isSolid, isLiquid, pretty, itemKind, DEG, lru } = require('./bodykit');
const { clearPath, entityVisible } = require('./perception');
const { Ledger } = require('../shared/ledger');

const { GoalNear } = goals;
const LEAD_TASKS = /^(explore)$/;
const HARD_MOBS = /creeper|enderman|witch|skeleton|stray|spider|vindicator|blaze|pillager|breeze/i;
const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];
const HYPE = {
  hop_look: ['jump', 'jump', 'look'],
  crouch_look_hop: ['crouch3', 'look', 'jump'],
  look_hop_crouch: ['look', 'jump', 'crouch2'],
  hop_crouch_hop: ['jump', 'crouch2', 'jump', 'look'],
  look_crouch: ['look', 'crouch4'],
  double_hop_crouch: ['jump', 'jump', 'crouch2', 'look']
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function standable(bot, p) {
  const feet = bot.blockAt(p, false), head = bot.blockAt(p.offset(0, 1, 0), false), floor = bot.blockAt(p.offset(0, -1, 0), false);
  return !!feet && !isSolid(feet) && !isSolid(head) && isSolid(floor) && !isLiquid(feet) && !isLiquid(floor) && !/fire|lava|cactus|magma/.test(`${feet?.name} ${floor?.name}`);
}

class GoalBeside extends goals.Goal {
  constructor(social, entity) {
    super();
    this.s = social; this.entity = entity;
    this.x = 0; this.y = 0; this.z = 0; this.fallback = false;
    this.compute();
  }
  compute() {
    const spot = this.s.besideSpot(this.entity);
    this.fallback = !spot;
    const p = spot || this.entity.position.floored();
    this.x = p.x; this.y = p.y; this.z = p.z;
  }
  heuristic(node) { return Math.hypot(this.x - node.x, this.z - node.z) + Math.abs(this.y - node.y); }
  isEnd(node) {
    if (this.fallback) {
      const p = this.entity.position;
      return (p.x - node.x - 0.5) ** 2 + (p.y - node.y) ** 2 + (p.z - node.z - 0.5) ** 2 <= 9;
    }
    return Math.hypot(this.x - node.x, this.z - node.z) <= 0.9 && Math.abs(this.y - node.y) <= 1;
  }
  hasChanged() {
    const prev = { x: this.x, y: this.y, z: this.z, fallback: this.fallback };
    this.compute();
    const moved = Math.hypot(this.x - prev.x, this.z - prev.z) + Math.abs(this.y - prev.y) > 1.5 || this.fallback !== prev.fallback;
    if (moved) return true;
    Object.assign(this, prev);

    const bot = this.s.c.bot;
    if (bot?.entity && !this.fallback && this.entity.position.distanceTo(bot.entity.position) < 1.1 && !this.isEnd(bot.entity.position.floored())) return true;
    return false;
  }
  isValid() { return this.entity != null; }
}

class Social extends Part {
  constructor(c) {
    super(c, 'socialBody');
    this.cool = new Cooldowns();
    this.ledger = new Ledger();
    this.protectedMoves = new Set();
    this.exclusion = (block) => (this.c.v12.awareness?.isPlayerBlock?.(block.position) ? 1000 : 0);
  }

  setup(bot) {
    const now = Date.now();
    this.side = chance(0.5) ? 1 : -1; this.dist = rand(2.3, 3.4); this.drift = rand(-25, 25); this.nextDrift = now + rand(15000, 40000);
    this.headFrom = null; this.headingDeg = null;
    this.ownerCrouched = false; this.crouchLog = []; this.crouching = false;
    this.watch = null; this.hypeWanted = null; this.hadDiamonds = false; this.hyping = false;
    this.lead = null; this.leadHold = null;
    this.repairs = []; this.repairing = false;
    this.giving = null; this.giftsGiven = 0; this.nextGiftCheck = now + 5000;
    this.cautious = false; this.tight = false; this.nextCaution = now + 2000;
    this.heldBack = new Set();
    if (/^follow-/.test(this.c.goalKind || '')) this.c.goalKind = null;
    this.listen(bot, 'entityCrouch', (e) => this.onCrouch(e, true));
    this.listen(bot, 'entityUncrouch', (e) => this.onCrouch(e, false));
    this.listen(bot, 'physicsTick', () => this.applyLeadHold());
    this.listen(this.c, 'event', (ev) => this.onEvent(ev));

    if (bot.pathfinder) {
      this.patch(bot.pathfinder, 'setMovements', (next, m) => { this.protect(m); return next(m); });
      this.protect(this.c.moves); this.protect(bot.pathfinder.movements);
    }
  }

  teardown() {
    for (const m of this.protectedMoves) { const i = m.exclusionAreasBreak?.indexOf(this.exclusion); if (i >= 0) m.exclusionAreasBreak.splice(i, 1); }
    this.protectedMoves.clear();
    this.watch = null; this.giving = null;
    if (/^follow-/.test(this.c.goalKind || '') || /^(watch|give)$/.test(this.c.goalKind || '')) this.c.goalKind = null;
  }

  protect(m) {
    if (!m || !Array.isArray(m.exclusionAreasBreak)) return;
    if (!m.exclusionAreasBreak.includes(this.exclusion)) m.exclusionAreasBreak.push(this.exclusion);
    this.protectedMoves.add(m);
  }

  motor() { return this.c.v12.motor?.installed?.() ? this.c.v12.motor : null; }
  owner() { return this.c.ownerEntity(); }
  tense() { return !!this.c.v12.awareness?.isTense?.(); }
  fighting() { const c = this.c; return !!(c.bot?.pvp?.target || c.attackTarget || c.mode === 'flee'); }
  moving() { const pf = this.c.bot?.pathfinder; return typeof pf?.isMoving === 'function' && pf.isMoving(); }
  free() { const c = this.c; return !c.task && !c.busy && !this.fighting() && !this.tense() && (c.mode === 'follow' || c.mode === 'guard' || c.mode === 'away'); }
  ownerEye(o = this.owner()) { return o.position.offset(0, o.crouching ? 1.27 : 1.62, 0); }
  look(target, opts) { const m = this.motor(); if (m) return m.lookAt(target, opts); try { return Promise.resolve(this.c.bot.lookAt(target.position ? target.position.offset(0, 1.6, 0) : target)).catch(() => {}); } catch { return Promise.resolve(); } }

  followGoal(owner) { return new GoalBeside(this, owner); }

  guarding() {
    const act = this.c.v12.awareness?.playerActivity?.();
    return this.c.mode === 'guard' || act === 'mining' || act === 'digging straight down';
  }

  besideSpot(owner) {
    const bot = this.c.bot;
    if (!bot?.entity || !owner?.position) return null;
    const p = owner.position;
    if (!this.headFrom) { this.headFrom = p.clone(); this.headingDeg = wrapDeg((owner.yaw || 0) * DEG); }
    if (p.distanceTo(this.headFrom) >= 1.5) { this.headingDeg = Math.atan2(-(p.x - this.headFrom.x), -(p.z - this.headFrom.z)) * DEG; this.headFrom = p.clone(); }
    const guard = this.guarding();
    const base = guard ? wrapDeg((owner.yaw || 0) * DEG) : this.headingDeg;
    const dist = this.tight ? Math.max(1.6, this.dist * 0.65) : this.dist;
    const tries = guard ? [['behind', 2.5], [this.side, dist], [-this.side, dist]] : [[this.side, dist], [-this.side, dist], ['behind', 2.5]];
    const eye = this.ownerEye(owner);
    for (const [s, d] of tries) {
      const ang = s === 'behind' ? base + 180 : base + s * (90 + this.drift);
      const dir = dirOf(ang, 0);
      const fx = Math.floor(p.x + dir.x * d), fz = Math.floor(p.z + dir.z * d), fy = Math.floor(p.y);
      for (const dy of [0, 1, -1, -2]) {
        const spot = new Vec3(fx, fy + dy, fz);
        if (!standable(bot, spot)) continue;
        if (!clearPath(bot, eye, spot.offset(0.5, 1.5, 0.5))) break;
        return spot;
      }
    }
    return null;
  }

  idleFacing() {
    if (!this.on() || !this.bot || !this.guarding()) return null;
    const o = this.owner();
    return o ? wrapDeg((o.yaw || 0) * DEG + 180) : null;
  }

  onCue(kind, data = {}) {
    if (!this.on() || !this.live()) return;
    if (kind === 'player_talking_start') this.turnToPlayer({ maxDist: 10, gap: 4000, p: 0.85, delay: true });
    else if (kind === 'line_start' && data.toPlayer !== false) this.turnToPlayer({ maxDist: 8, gap: 2000, p: 1, delay: false });
  }

  turnToPlayer({ maxDist, gap, p, delay }) {
    const bot = this.c.bot, o = this.owner();
    if (!o || this.c.task || this.fighting() || !bot.entity.onGround || this.moving() || this.crouching || this.hyping) return false;
    if (o.position.distanceTo(bot.entity.position) > maxDist) return false;
    const m = this.motor();
    if (m && m.facingDeg(this.ownerEye(o)) < 20) return false;
    if (!chance(p) || !this.cool.take('turn', gap)) return false;
    const go = () => { if (this.live() && !this.moving()) this.look(this.ownerEye(o)); };
    if (delay) this.later(m ? m.reactionDelay() : rand(180, 400), go); else go();
    return true;
  }

  onTick(now) {
    if (!this.on() || !this.live()) return;
    if (now > this.nextDrift) {
      this.nextDrift = now + rand(15000, 40000);
      if (chance(0.25)) this.side = -this.side;
      this.dist = rand(2.2, 3.6); this.drift = rand(-30, 30);
    }
    this.leadCheck(now);
    this.hypeCheck(now);
    this.repairCheck(now);
    if (now >= this.nextGiftCheck) { this.nextGiftCheck = now + 5000; this.giftCheck(now); }
    if (now >= this.nextCaution) { this.nextCaution = now + 2000; this.cautionCheck(now); }
  }

  takeOver(now) {
    if (!this.on() || !this.live()) return null;
    if (this.othersSteering()) { if (this.watch) this.finishWatch(false); this.giving = null; return null; }
    if (this.watch) return this.stepWatch(now);
    if (this.giving) return this.stepGive(now);
    return null;
  }

  leadCheck(now) {
    const c = this.c, t = c.task, o = this.owner();
    const leads = t && (LEAD_TASKS.test(t.name) || c.tasks[t.name]?.lead);
    if (!leads || !o) { this.lead = null; this.leadHold = null; return; }
    if (!this.lead || this.lead.task !== t) this.lead = { task: t, waits: 0, waitSince: 0, nextLook: 0, hist: [] };
    const L = this.lead, bot = c.bot;
    L.hist.push({ t: now, p: o.position.clone() });
    while (L.hist.length > 1 && now - L.hist[0].t > 6000) L.hist.shift();
    const following = o.position.distanceTo(L.hist[0].p) >= 3;
    const d = o.position.distanceTo(bot.entity.position);
    const m = this.motor();
    const glanceBack = () => { if (m && following && now >= L.nextLook) { L.nextLook = now + rand(3000, 5000); m.glance(this.ownerEye(o), { holdMs: rand(400, 800) }); } };
    if (L.waitSince) {
      if (d < 14 || now - L.waitSince > 8000 || (!following && now - L.waitSince > 3000)) { L.waitSince = 0; this.leadHold = null; return; }
      this.leadHold = { until: now + 600, set: Object.fromEntries(MOVE_KEYS.map((k) => [k, false])) };
      glanceBack();
      return;
    }
    if (d > 24 && following && L.waits < 2) {
      L.waitSince = now; L.waits++;
      this.leadHold = { until: now + 600, set: Object.fromEntries(MOVE_KEYS.map((k) => [k, false])) };
      if (m) m.glance(this.ownerEye(o), { holdMs: rand(900, 1500) });
    } else if (d > 12) {
      this.leadHold = { until: now + 600, set: { sprint: false } };
      glanceBack();
    } else this.leadHold = null;
  }

  applyLeadHold() {
    const h = this.leadHold;
    if (!h || Date.now() > h.until || !this.bot) return;
    for (const [k, v] of Object.entries(h.set)) { try { this.bot.setControlState(k, v); } catch {} }
  }

  watchBuild(summary, done) {
    const c = this.c, bot = c.bot, o = this.owner();
    if (!this.on() || !this.live() || !o || !this.free() || c.mode === 'away' || this.watch) { done(); return; }
    const center = new Vec3(summary.center.x, summary.center.y, summary.center.z);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const dir = dirOf(i * 30, 0);
      const spot = new Vec3(Math.floor(center.x + dir.x * 5), Math.floor(o.position.y), Math.floor(center.z + dir.z * 5));
      let ok = null;
      for (const dy of [0, 1, -1, 2, -2]) { const s = spot.offset(0, dy, 0); if (standable(bot, s)) { ok = s; break; } }
      if (!ok || ok.distanceTo(o.position) < 2.5) continue;
      if (!clearPath(bot, ok.offset(0.5, 1.6, 0.5), center)) continue;

      const toBuild = center.minus(o.position), toSpot = ok.minus(o.position);
      const between = (toBuild.x * toSpot.x + toBuild.z * toSpot.z) > 0 && ok.distanceTo(center) < o.position.distanceTo(center);
      const score = -ok.distanceTo(bot.entity.position) * 0.5 - (between ? 20 : 0);
      if (score > bestScore) { bestScore = score; best = ok; }
    }
    if (!best) { done(); return; }
    this.watch = { spot: best, center, done, phase: 'walk', started: Date.now(), until: Date.now() + 12000, lookUntil: 0, glances: 0, nextGlance: 0 };
    bot.pathfinder.setGoal(new GoalNear(best.x, best.y, best.z, 1));
    c.goalKind = 'watch';
  }

  stepWatch(now) {
    const w = this.watch, bot = this.c.bot;
    if (this.fighting() || this.c.task || this.tense()) return this.finishWatch(false);
    if (w.phase === 'walk') {
      const there = bot.entity.position.distanceTo(w.spot.offset(0.5, 0, 0.5)) <= 1.8;
      if (there || (!this.moving() && now - w.started > 1500)) {
        w.phase = 'look'; w.lookUntil = now + rand(3000, 5000); w.nextGlance = now + rand(900, 1500);
        try { bot.pathfinder.setGoal(null); } catch {}
        this.look(w.center);
      } else if (now > w.until) return this.finishWatch(true);
      return true;
    }
    if (now >= w.lookUntil) return this.finishWatch(true);
    const m = this.motor();
    if (m && now >= w.nextGlance && w.glances < 3) {

      w.glances++; w.nextGlance = now + rand(900, 1500);
      m.lookAt(w.center.offset(rand(-2, 2), rand(-1, 1.5), rand(-2, 2)));
    }
    return true;
  }

  finishWatch(ok) {
    const w = this.watch;
    this.watch = null;
    this.c.goalKind = null;
    if (w) w.done();
    return ok ? true : null;
  }

  onEvent(ev) {
    if (!this.on()) return;
    const d = ev.data || {};
    if (ev.event === 'loot_found' && d.by === 'companion' && /diamond/i.test(d.item || '') && !this.hadDiamonds) { this.hadDiamonds = true; this.hypeWanted = { why: 'diamonds', until: Date.now() + 90000 }; }
    else if (ev.event === 'task_done' && /diamond/i.test(d.result || '')) this.hypeWanted = { why: 'diamonds', until: Date.now() + 60000 };
    else if (ev.event === 'monster_killed' && d.by === 'companion' && (HARD_MOBS.test(d.monster || '') || (this.c.bot?.health ?? 20) <= 10)) this.hypeWanted = { why: 'kill', until: Date.now() + 15000 };
  }

  hypeCheck(now) {
    const h = this.hypeWanted, o = this.owner();
    if (!h || this.hyping) return;
    if (now > h.until) { this.hypeWanted = null; return; }
    if (!o || !this.free() || this.moving() || o.position.distanceTo(this.c.bot.entity.position) > 16) return;
    if (!this.cool.take('hype', 120000, now)) { this.hypeWanted = null; return; }
    this.hypeWanted = null;
    this.doHype(lru(this.ledger, 'idle', Object.keys(HYPE), (k) => `hype-${k}`));
  }

  async doHype(name) {
    const bot = this.c.bot, o = this.owner();
    this.hyping = true;
    this.lastHype = name;
    try {
      for (const step of HYPE[name] || []) {
        if (!this.live() || this.fighting()) break;
        if (step === 'jump') { bot.setControlState('jump', true); await sleep(rand(80, 140)); bot.setControlState('jump', false); await sleep(rand(350, 600)); }
        else if (step === 'look') { if (o) await this.look(this.ownerEye(o)); await sleep(rand(150, 400)); }
        else if (/^crouch(\d)$/.test(step)) {
          const n = Number(step.slice(6));
          for (let i = 0; i < n; i++) { bot.setControlState('sneak', true); await sleep(rand(90, 180)); bot.setControlState('sneak', false); await sleep(rand(80, 170)); }
        }
      }
    } catch {} finally { try { bot.setControlState('sneak', false); bot.setControlState('jump', false); } catch {} this.hyping = false; }
  }

  onCrouch(e, down) {
    const o = this.owner();
    if (!this.on() || !this.live() || !o || e !== o) return;
    if (down === this.ownerCrouched) return;
    this.ownerCrouched = down;
    const now = Date.now();
    this.crouchLog.push(now);
    while (this.crouchLog.length && now - this.crouchLog[0] > 2000) this.crouchLog.shift();
    if (this.crouchLog.length < 4 || this.crouching || !this.cool.ok('crouch', 2500, now)) return;
    this.crouchLog = [];
    this.cool.mark('crouch', now);
    const bot = this.c.bot;
    if (this.c.task || this.fighting() || this.tense() || o.position.distanceTo(bot.entity.position) > 8) return;
    if (!entityVisible(bot, bot.entity.position.offset(0, 1.62, 0), o)) return;
    if (!chance(0.8)) return;
    const m = this.motor();
    this.crouching = true;
    this.later(m ? m.reactionDelay() : rand(200, 450), () => this.crouchBack());
  }

  async crouchBack() {
    const bot = this.c.bot, o = this.owner();
    try {
      if (o) this.look(this.ownerEye(o));
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n && this.live(); i++) {
        bot.setControlState('sneak', true); await sleep(rand(90, 190));
        bot.setControlState('sneak', false); await sleep(rand(80, 180));
      }
    } catch {} finally { try { bot.setControlState('sneak', false); } catch {} this.crouching = false; }
  }

  onPunched(owner, hits) {
    if (!this.on() || !this.live()) return;
    if (hits > 5 || (hits > 2 && !chance(0.5))) return;
    const m = this.motor();
    if (m) this.later(m.reactionDelay(), () => m.glance(this.ownerEye(owner), { holdMs: rand(500, 900) }));
  }

  onBrokePlayerBlock(rec) {
    if (!this.on()) return;
    this.repairs.push({ rec, at: Date.now() });
    if (this.repairs.length > 6) this.repairs.shift();
  }

  repairCheck(now) {
    if (this.repairing || !this.repairs.length) return;
    this.repairs = this.repairs.filter((r) => now - r.at < 60000);
    const r = this.repairs[0];
    if (!r || this.c.task || this.c.busy || this.fighting()) return;
    this.repairs.shift();
    this.repairing = true;
    const s = this.c.skills;
    (async () => {
      let fixed = false;
      try { if (s.find(r.rec.name)) { await s.placeAt(r.rec.pos, r.rec.name); fixed = true; } } catch {}
      if (fixed) this.c.v12.awareness?.placed?.set(`${r.rec.pos.x},${r.rec.pos.y},${r.rec.pos.z}`, { ...r.rec, at: Date.now() });
      if (this.cool.take('sorry', 60000)) this.emitEvent('broke_player_block', { block: pretty(r.rec.name), fixed }, null);
    })().finally(() => { this.repairing = false; });
  }

  ownerHealth(o) {
    const keys = this.c.bot.registry?.entitiesByName?.player?.metadataKeys || [];
    const i = keys.indexOf('health');
    const v = i >= 0 ? o.metadata?.[i] : null;
    return Number.isFinite(Number(v)) && v !== null ? Number(v) : null;
  }

  giftCheck(now) {
    const o = this.owner(), bot = this.c.bot;
    if (!o || this.giving || !this.free() || this.c.mode === 'away' || this.giftsGiven >= 3) return;
    if (o.position.distanceTo(bot.entity.position) > 16 || this.c.hostiles(10).length) return;
    const held = o.heldItem;
    const tool = held && /_(pickaxe|axe|shovel|sword)$/.exec(held.name);
    if (tool && held.maxDurability && held.durabilityUsed != null && held.durabilityUsed / held.maxDurability >= 0.9) {
      const kind = tool[1];
      const spare = bot.inventory.items().find((i) => i.name.endsWith(`_${kind}`) && !/^wooden_|^golden_/.test(i.name));
      if (spare && this.cool.take(`gift-${kind}`, 600000, now)) { this.give(spare, 1, `the player's ${pretty(held.name)} is about to break`); return; }
    }
    const hp = this.ownerHealth(o);
    if (hp != null && hp <= 8) {
      const food = bot.inventory.items().find((i) => itemKind(i.name) === 'food' && /^(cooked_|bread|baked_potato|golden_carrot|pumpkin_pie)/.test(i.name));
      if (food && this.cool.take('gift-food', 600000, now)) this.give(food, Math.min(2, food.count), 'the player is low on health');
    }
  }

  give(item, count, why) {
    const o = this.owner();
    this.giving = { item, count, why, stage: 'walk', until: Date.now() + 12000 };
    this.c.bot.pathfinder.setGoal(new GoalNear(o.position.x, o.position.y, o.position.z, 2));
    this.c.goalKind = 'give';
  }

  stepGive(now) {
    const g = this.giving, bot = this.c.bot, o = this.owner();
    if (!o || this.fighting() || this.c.task || now > g.until) { this.giving = null; this.c.goalKind = null; return null; }
    if (g.stage === 'walk') {
      if (o.position.distanceTo(bot.entity.position) <= 3 && !this.moving()) {
        g.stage = 'toss';
        (async () => {
          try {
            await this.look(this.ownerEye(o));
            await bot.toss(g.item.type, null, g.count);
            this.giftsGiven++;
            this.emitEvent('gave_player', { item: `${g.count > 1 ? `${g.count} ` : ''}${g.item.displayName || pretty(g.item.name)}`, why: g.why }, null);
          } catch {} finally { this.giving = null; this.c.goalKind = null; }
        })();
      }
    }
    return true;
  }

  shouldHoldBack(block) {
    if (!this.on() || !this.live() || !block?.name) return false;
    const kind = /diamond_ore$/.test(block.name) ? 'diamonds' : /^(chest|barrel)$/.test(block.name) ? 'a chest' : null;
    if (!kind || this.heldBack.has(kind)) return false;
    const o = this.owner(), bot = this.c.bot;
    if (!o || o.position.distanceTo(block.position) > 10 || o.position.distanceTo(bot.entity.position) > 12) return false;
    this.heldBack.add(kind);
    this.emitEvent('first_find', { thing: kind === 'diamonds' ? 'diamonds' : 'a loot chest' }, null);
    return true;
  }

  cautionCheck(now) {
    const c = this.c, bot = c.bot;
    const e = bot.entity;
    const b = bot.blockAt(e.position.offset(0, 1.6, 0).floored(), false);
    const light = b && b.light != null && b.skyLight != null ? Math.max(b.light, b.skyLight - (c.isNight() ? 11 : 0)) : 15;
    const covered = b && b.skyLight === 0;
    const heard = c.v12.perception?.lastHeard && now - c.v12.perception.lastHeard.at < 30000;
    const score = (light < 5 ? 1 : 0) + (covered && e.position.y < 50 ? 1 : 0) + (c.isNight() && !covered ? 1 : 0) + (bot.health <= 10 ? 1 : 0) + (heard ? 1 : 0) + (e.position.y < 0 ? 1 : 0);
    const cautious = score >= 3;
    this.tight = cautious;
    if (cautious && !this.cautious) {
      c.equipBestWeapon();
      if (light < 5 && !c.busy && !c.task && c.skills.count('torch') && this.cool.take('torch', 30000, now)) {
        const spot = c.skills.freeSpotNear(e.position, 1, 2);
        if (spot) c.skills.placeAt(spot, 'torch').catch(() => {});
      }
    }
    this.cautious = cautious;
  }

}

module.exports = { Social, GoalBeside, standable, HYPE };
