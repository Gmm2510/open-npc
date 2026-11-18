// The detailed commands: get, craft, smelt, mine, place, fight, move, remember places, build, and the jobs the AI can
// ask for with details ("get me a stack of birch").
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { Nope, LOG_RE, PLANKS_RE, ORES, RAW_FOOD, PASSIVE_FOOD, PROTECTED_RE, sleep } = require('./skills');
const spec = require('./commandspec');
const B = require('./builder');
const { chooseFood, FOOD_RE, label: itemLabel, amount, oneOf } = require('./fetcher');
const { direction } = require('./places');

const { GoalNear, GoalFollow, GoalBlock, GoalXZ } = goals;

const PROTECTED_MOBS = new Set(['villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'wolf', 'cat', 'parrot', 'horse', 'donkey', 'mule', 'llama', 'trader_llama', 'fox', 'axolotl', 'allay', 'ocelot', 'camel', 'sniffer', 'armadillo', 'turtle', 'bee', 'player']);
const HOSTILE_NAMES = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'slime', 'phantom', 'pillager', 'vindicator', 'silverfish', 'blaze', 'magma_cube', 'ghast', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'guardian', 'breeze']);
const CROPS = { wheat: { age: 7, seed: 'wheat_seeds' }, carrots: { age: 7, seed: 'carrot' }, potatoes: { age: 7, seed: 'potato' }, beetroots: { age: 3, seed: 'beetroot_seeds' } };
const TIERS = ['wooden', 'stone', 'iron', 'diamond'];

function viewDir(yaw, pitch) {
  return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
}

function raycast(from, dir, range, getBlock, hit) {
  let x = Math.floor(from.x), y = Math.floor(from.y), z = Math.floor(from.z);
  const sx = Math.sign(dir.x), sy = Math.sign(dir.y), sz = Math.sign(dir.z);
  const inv = (d) => (d === 0 ? Infinity : Math.abs(1 / d));
  const dtx = inv(dir.x), dty = inv(dir.y), dtz = inv(dir.z);
  const frac = (v, s) => (s > 0 ? Math.floor(v) + 1 - v : v - Math.floor(v));
  let tx = dir.x === 0 ? Infinity : frac(from.x, sx) * dtx;
  let ty = dir.y === 0 ? Infinity : frac(from.y, sy) * dty;
  let tz = dir.z === 0 ? Infinity : frac(from.z, sz) * dtz;
  let face = { x: 0, y: 0, z: 0 };
  let prev = { x, y, z };
  let t = 0;
  for (let i = 0; i < 400 && t <= range; i++) {
    const b = getBlock(x, y, z);
    if (i > 0 && b && hit(b, x, y, z)) return { x, y, z, block: b, face, prev, dist: t };
    prev = { x, y, z };
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += dtx; face = { x: -sx, y: 0, z: 0 }; }
    else if (ty < tz) { y += sy; t = ty; ty += dty; face = { x: 0, y: -sy, z: 0 }; }
    else { z += sz; t = tz; tz += dtz; face = { x: 0, y: 0, z: -sz }; }
  }
  return null;
}

function stopsLook(b, liquids = true) {
  const i = B.info(b);
  return i.solid || (liquids && i.liquid) || (!i.air && !i.plant && !i.liquid);
}

function lookEntity(eye, dir, entities, { range = 24, maxAngle = 0.22, clear = () => true } = {}) {
  let best = null, bestScore = Infinity;
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  for (const e of entities) {
    if (!e || !e.position) continue;
    const c = { x: e.position.x - eye.x, y: e.position.y + (e.height || 1.6) / 2 - eye.y, z: e.position.z - eye.z };
    const d = Math.hypot(c.x, c.y, c.z);
    if (d > range || d < 0.5) continue;
    const cos = (c.x * dir.x + c.y * dir.y + c.z * dir.z) / (d * len);
    const ang = Math.acos(Math.max(-1, Math.min(1, cos)));

    const allowed = maxAngle + Math.atan(0.6 / d);
    if (ang > allowed) continue;
    const score = ang + d * 0.004;
    if (score < bestScore && clear(e)) { best = e; bestScore = score; }
  }
  return best;
}

const isNamed = (e) => { const cn = e && e.metadata && e.metadata[2]; return !!(cn && (typeof cn === 'string' ? cn.trim() : JSON.stringify(cn).length > 4)); };
function mobKind(e) { return e && (e.name || '').toLowerCase(); }
function isProtectedMob(e) { return !!e && (e.type === 'player' || PROTECTED_MOBS.has(mobKind(e)) || isNamed(e)); }
function isHostileMob(e) { return !!e && (e.type === 'hostile' || HOSTILE_NAMES.has(mobKind(e))); }

function ripe(name, age) { const c = CROPS[name]; return !!c && Number(age) >= c.age; }

function sideStep(side) { return { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } }[side] || { x: 0, z: -1 }; }

class Walker {
  constructor(cmd) { this.cmd = cmd; this.w = null; this.status = null; }
  get c() { return this.cmd.c; }
  get bot() { return this.cmd.c.bot; }

  start(w) {
    const bot = this.bot;
    this.stop(null, true);
    const now = Date.now();
    const d0 = w.target() ? bot.entity.position.distanceTo(w.target()) : 0;
    this.w = { arrive: 2.5, timeoutMs: 45000, dig: true, resets: 0, ...w, started: now, best: d0, bestAt: now, dug: false, paused: false, mark: bot.entity.position.clone() };
    this.status = null;
    try { bot.pathfinder.setGoal(null); } catch {}
    this.applyMoves(this.cmd.walkMoves(!!w.avoid));
    bot.pathfinder.setGoal(this.w.goal, !!this.w.dynamic);
    return this.w;
  }

  applyMoves(m) { try { this.bot.pathfinder.setMovements(m); } catch {} }

  stop(reason = null, quiet = false) {
    const w = this.w;
    if (!w) return;
    this.w = null;
    if (this.c.moves && this.bot?.pathfinder) this.applyMoves(this.c.moves);
    if (reason && !quiet) this.cmd.h.failed(w.failTask || w.label, reason);
  }

  tick(now) {
    const w = this.w;
    const bot = this.bot;
    if (!w) return;
    if (!bot?.entity || this.c.diedAt) { this.w = null; return; }

    if (this.c.task || bot.pvp?.target || (w.mode && this.c.mode !== w.mode)) { this.w = null; if (this.c.moves) this.applyMoves(this.c.moves); return; }
    const target = w.target();
    if (!target) { this.stop("lost sight of the player"); return; }
    const d = bot.entity.position.distanceTo(target);
    if (d <= w.arrive) {
      this.w = null;
      if (this.c.moves) this.applyMoves(this.c.moves);
      try { w.onArrive && w.onArrive(); } catch (err) { this.c.emit('log', `walker arrive: ${err.message}`); }
      return;
    }
    if (w.lead) {
      const o = this.c.ownerEntity();
      const od = o ? o.position.distanceTo(bot.entity.position) : 0;
      if (!w.paused && o && od > 12) {
        w.paused = true;
        bot.pathfinder.setGoal(null);
        bot.lookAt(o.position.offset(0, 1.5, 0)).catch(() => {});
      } else if (w.paused && (!o || od < 6)) {
        w.paused = false;
        w.bestAt = now;
        bot.pathfinder.setGoal(w.goal, !!w.dynamic);
      }
      if (w.paused) { w.bestAt = now; if (o && now % 2000 < 400) bot.lookAt(o.position.offset(0, 1.5, 0)).catch(() => {}); return; }
    }
    if (d < w.best - 1) { w.best = d; w.bestAt = now; w.mark = bot.entity.position.clone(); }
    else if (bot.entity.position.distanceTo(w.mark) > 2.5) { w.best = Math.min(w.best, d); w.bestAt = now; w.mark = bot.entity.position.clone(); }

    if (bot.pathfinder.goal !== w.goal && w.resets < 3) { w.resets++; bot.pathfinder.setGoal(w.goal, !!w.dynamic); }
    const ps = this.cmd.h.pathStatus;
    const noPath = ps && ps.status === 'noPath' && now - ps.at < 1500 && now - w.started > 1500;
    if (noPath || now - w.bestAt > 7000) {
      if (w.dig && !w.dug) {
        w.dug = true;
        w.bestAt = now;
        this.applyMoves(this.cmd.digMoves());
        bot.pathfinder.setGoal(w.goal, !!w.dynamic);
        return;
      }
      this.stop(this.cmd.whyStuck(target));
      if (w.onFail) w.onFail();
      return;
    }
    if (now - w.started > w.timeoutMs) { this.stop('the walk took too long and timed out'); if (w.onFail) w.onFail(); }
  }
}

class Commands {
  constructor(hands) {
    this.h = hands;
    this.walker = new Walker(this);
    this.leave = new Map();
    this.fallBackUntil = 0;
    this.protectUntil = 0;
    this.ownerSwingAt = 0;
    this.lastRetreat = 0;
  }
  get c() { return this.h.c; }
  get bot() { return this.h.c.bot; }
  get s() { return this.h.c.skills; }

  walkMoves(avoidMobs = false) {
    const m = this.s.walkMoves();
    m.allowSprinting = true;
    if (avoidMobs) {
      const c = this.c;
      m.exclusionAreasStep.push((b) => {
        const p = b.position;
        for (const e of c.hostiles(20)) if (Math.abs(e.position.x - p.x) <= 3 && Math.abs(e.position.z - p.z) <= 3 && Math.abs(e.position.y - p.y) <= 2) return 40;
        return 0;
      });
    }
    return m;
  }
  digMoves() { return this.s.workMoves(); }

  whyStuck(target) {
    const bot = this.bot;
    if (!bot?.entity || !target) return "can't find a way over";
    const from = bot.entity.position;
    const dy = target.y - from.y;
    let water = 0, lava = 0;
    const n = Math.min(40, Math.ceil(from.distanceTo(target)));
    for (let i = 1; i < n; i++) {
      const p = from.plus(target.minus(from).scaled(i / n)).floored();
      for (const yy of [0, -1]) {
        const b = bot.blockAt(p.offset(0, yy, 0));
        if (b && /water/.test(b.name)) water++;
        if (b && /lava/.test(b.name)) lava++;
      }
    }
    if (lava) return "there's lava in the way";
    if (water >= 3) return "there's water in the way and you can't find a way around";
    if (dy > 4) return "the destination is too high up and you can't find a way up";
    if (dy < -6) return "the destination is far below and you can't find a way down";
    return "you can't find a way over there";
  }

  owner() { return this.c.ownerEntity(); }

  lookBlock(owner = this.owner(), { range = 48, liquids = true } = {}) {
    if (!owner || owner.yaw == null) return null;
    const eye = owner.position.offset(0, 1.62, 0);
    const bot = this.bot;
    return raycast(eye, viewDir(owner.yaw, owner.pitch || 0), range, (x, y, z) => bot.blockAt(new Vec3(x, y, z)), (b) => stopsLook(b, liquids));
  }

  lookMob(owner = this.owner(), opts = {}) {
    if (!owner || owner.yaw == null) return null;
    const bot = this.bot;
    const eye = owner.position.offset(0, 1.62, 0);
    const dir = viewDir(owner.yaw, owner.pitch || 0);
    const list = Object.values(bot.entities).filter((e) => e !== bot.entity && e !== owner && e.position && (e.type === 'mob' || e.type === 'hostile' || e.type === 'animal' || e.type === 'passive' || e.type === 'water_creature' || e.type === 'ambient' || e.type === 'player' || HOSTILE_NAMES.has(e.name) || PASSIVE_FOOD.includes(e.name) || PROTECTED_MOBS.has(e.name)));
    const clear = (e) => {
      const to = e.position.offset(0, (e.height || 1.6) / 2, 0);
      const d = { x: to.x - eye.x, y: to.y - eye.y, z: to.z - eye.z };
      const len = Math.hypot(d.x, d.y, d.z);
      const hit = raycast(eye, { x: d.x / len, y: d.y / len, z: d.z / len }, len, (x, y, z) => bot.blockAt(new Vec3(x, y, z)), (b) => B.info(b).solid);
      return !hit || hit.dist >= len - 0.8;
    };
    return lookEntity(eye, dir, list, { clear, ...opts });
  }

  spot(where, { needLook = false } = {}) {
    const o = this.owner();
    if (!o) return { ask: 'the player is not in sight' };
    if (where === 'there' || needLook) {
      const t = this.lookBlock(o, { range: 40 });
      if (!t) return { ask: 'the player is not pointing at a spot' };
      return { hit: new Vec3(t.x, t.y, t.z), face: t.face, prev: new Vec3(t.prev.x, t.prev.y, t.prev.z), look: true, owner: o };
    }
    const feet = o.position.floored();
    return { hit: feet.offset(0, -1, 0), face: { x: 0, y: 1, z: 0 }, prev: feet, look: false, owner: o };
  }

  mayFight(e, now = Date.now()) {
    if (now < this.fallBackUntil) return false;
    const until = this.leave.get(e.id);
    if (until && now < until) return false;
    if (until) this.leave.delete(e.id);
    if (isNamed(e)) return false;
    if (now < this.protectUntil && now - this.ownerSwingAt < 1500) {
      const o = this.owner();
      if (o && e.position.distanceTo(o.position) < 3.5) return false;
    }
    return true;
  }

  checkRetreat(now) {
    const c = this.c, bot = this.bot;
    if (!bot?.entity || c.diedAt || this.h.games?.active) return;
    if (!(bot.pvp?.target || c.attackTarget)) return;
    if (now - this.lastRetreat < 25000) return;
    const near = c.hostiles(6);
    const hp = bot.health;
    const sword = c.skills.bestTier('sword') >= 1;
    const creeper = near.find((e) => e.name === 'creeper' && e.position.distanceTo(bot.entity.position) < 2.5);
    let why = null;
    if (hp <= 6) { const h = Math.max(1, Math.ceil(hp / 2)); why = `you're down to ${h} heart${h === 1 ? '' : 's'}`; }
    else if (hp <= 10 && near.length >= 3) why = `there are ${near.length} of them and you're hurt`;
    else if (near.length >= 4 && !sword) why = `there are ${near.length} of them and you've got no sword`;
    else if (creeper && hp <= 14) why = 'a creeper is right on you';
    if (!why) return;
    this.lastRetreat = now;
    this.fallBack({ reason: why });
  }

  come() {
    const c = this.c, bot = this.bot;
    const o = this.owner();
    if (!o) return { ok: false, reason: 'player_not_in_sight', ask: 'the player is not in sight' };
    c.cancelTask('you called me back');
    c.stopAttack();
    this.h.stopGames();
    c.setMode('follow', 0);
    this.walker.start({
      kind: 'come', label: 'going to the player', failTask: 'going to the player', mode: 'follow', dynamic: true,
      goal: new GoalFollow(o, 2), target: () => this.owner()?.position, arrive: 3.2, timeoutMs: 40000,
      onArrive: () => { c.lastCommandAt = Date.now(); const b = this.bot; const ow = this.owner(); if (b && ow) b.lookAt(ow.position.offset(0, 1.5, 0)).catch(() => {}); }
    });
    c.goalKind = `follow-${o.id}`;
    return { ok: true, started: true };
  }

  goThere(args) {
    const c = this.c;
    const sp = this.spot('there', { needLook: true });
    if (sp.ask) return { ok: false, reason: 'no_target', ask: sp.ask };
    const dest = sp.prev;
    const d = this.bot.entity.position.distanceTo(dest);
    if (d > 44) return { ok: false, reason: 'too_far', ask: 'that spot is more than 44 blocks away' };
    return this.walkTo(dest, { label: 'walking over there', arrive: 2, stayAfter: 90 });
  }

  walkTo(dest, { label, arrive = 2, stayAfter = 60, lead = false, onArrive = null, timeoutMs = 60000, avoid = false }) {
    const c = this.c;
    c.cancelTask('heading over');
    c.stopAttack();
    this.h.stopGames();
    c.setMode('stay', Math.max(90, timeoutMs / 1000 + 30));
    const goal = new GoalNear(dest.x, dest.y, dest.z, Math.max(1, arrive - 0.5));
    this.walker.start({
      kind: 'walk', label, failTask: label, mode: 'stay', goal, target: () => dest, arrive, lead, timeoutMs, avoid,
      onArrive: () => { c.setMode(stayAfter ? 'stay' : 'follow', stayAfter || 0); if (onArrive) onArrive(); }
    });
    return { ok: true, started: true };
  }

  goHome(args) {
    const pl = this.h.places;
    const name = args.name || 'home';
    const p = pl.find(name) || (name === 'home' && this.c.home ? { name: 'home', pos: this.c.home } : null);
    if (!p) return { ok: false, reason: 'unknown_place', ask: name === 'home' ? 'no home is saved' : `no place called ${name} is saved` };
    const dest = new Vec3(p.pos.x, p.pos.y, p.pos.z);
    return this.walkTo(dest, { label: `heading to ${p.name}`, arrive: 3, stayAfter: 120, timeoutMs: 180000, onArrive: () => this.h.done(`heading to ${p.name}`, 'made it, waiting here') });
  }

  leadBack(args) {
    const pl = this.h.places;
    const p = args.name ? pl.find(args.name) : (pl.home() || pl.find('base') || (this.c.home ? { name: 'home', pos: this.c.home } : null));
    if (!p) return { ok: false, reason: 'unknown_place', ask: args.name ? `no place called ${args.name} is saved` : 'no home is saved' };
    const dest = new Vec3(p.pos.x, p.pos.y, p.pos.z);
    return this.walkTo(dest, { label: `leading the player to ${p.name}`, arrive: 3, stayAfter: 60, lead: true, timeoutMs: 300000, onArrive: () => this.h.done(`leading the player to ${p.name}`, `you and the player are at ${p.name}`) });
  }

  recoverItems() {
    const d = this.h.places.lastDeath() || this.h.lastDeath;
    if (!d) return { ok: false, reason: 'no_death_spot', ask: "the player's death spot is not known" };
    const dest = new Vec3(d.pos.x, d.pos.y, d.pos.z);
    const age = Date.now() - d.at;
    const label = "leading the player back to the player's dropped items";
    this.recovering = { at: d.at, said: 0 };
    const r = this.walkTo(dest, {
      label, arrive: 3, stayAfter: 45, lead: true, timeoutMs: 300000,
      onArrive: () => { this.recovering = null; this.h.done(label, Date.now() - d.at > 5 * 60 * 1000 ? "you and the player are at the player's dropped items; it has been over 5 minutes, so they may have despawned" : "you and the player are at the player's dropped items"); }
    });
    if (age > 5 * 60 * 1000) this.h.progress("it has been over 5 minutes; the player's items may have despawned; going to look", { force: true });
    return r;
  }

  recoverTick(now) {
    const r = this.recovering;
    if (!r || !this.walker.w || this.walker.w.label !== "leading the player back to the player's dropped items") { this.recovering = null; return; }
    const left = 5 * 60 * 1000 - (now - r.at);
    if (r.said === 0 && left < 3 * 60 * 1000 && left > 90 * 1000) { r.said = 1; this.h.progress("about two minutes before the player's dropped items despawn", { force: true }); }
    else if (r.said === 1 && left < 60 * 1000 && left > 0) { r.said = 2; this.h.progress("the player's dropped items despawn in under a minute", { force: true }); }
  }

  killThat(args) {
    const c = this.c;
    const o = this.owner();
    let e = this.lookMob(o);
    if (!e && args.mob) {
      e = Object.values(this.bot.entities).filter((x) => x.name === args.mob && x.position && o && x.position.distanceTo(o.position) < 20)
        .sort((a, b) => a.position.distanceTo(o.position) - b.position.distanceTo(o.position))[0] || null;
    }
    if (!e) return { ok: false, reason: 'no_target', ask: 'the player is not looking at a mob' };
    if (e.type === 'player') return { ok: false, reason: 'protected_mob', ask: 'that is a player; you do not attack players' };
    if (isProtectedMob(e) && !args.sure) return { ok: false, reason: 'protected_mob', ask: `that's a ${(e.displayName || e.name || 'friendly mob').toLowerCase()}${isNamed(e) ? ' with a name' : ''}; the player has not confirmed` };
    this.leave.delete(e.id);
    c.cancelTask('going for it');
    this.walker.stop(null, true);
    c.setMode('attack', 20);
    c.attack(e);
    return { ok: true, started: true, target: e.name };
  }

  leaveIt() {
    const c = this.c, bot = this.bot;
    const e = bot.pvp?.target || c.attackTarget || this.lookMob();
    if (!e) return { ok: true };
    this.leave.set(e.id, Date.now() + 3 * 60 * 1000);
    if (bot.pvp?.target === e || c.attackTarget === e) { c.stopAttack(); c.setMode('follow', 0); }
    return { ok: true, left: e.name };
  }

  protect(args) {
    const c = this.c;
    const mins = Math.max(1, Math.min(15, args.mins || 5));
    c.cancelTask('watching your back');
    this.walker.stop(null, true);
    c.stopAttack();
    c.setMode('guard', mins * 60);
    this.protectUntil = Date.now() + mins * 60 * 1000;
    return { ok: true, started: true };
  }

  fallBack({ reason = null } = {}) {
    const c = this.c;
    const o = this.owner();
    c.cancelTask('falling back');
    c.stopAttack();
    this.fallBackUntil = Date.now() + 6000;
    if (reason) this.h.failed('fighting', `${reason}, backing off to the player`);
    if (!o) { c.setMode('flee', 5); return { ok: true }; }
    c.setMode('follow', 0);
    this.walker.start({
      kind: 'fallback', label: 'falling back to the player', failTask: 'falling back to the player', mode: 'follow', dynamic: true, avoid: true, dig: false,
      goal: new GoalFollow(o, 2), target: () => this.owner()?.position, arrive: 3.2, timeoutMs: 20000
    });
    c.goalKind = `follow-${o.id}`;
    return { ok: true, started: true };
  }

  rememberPlace(args) {
    const o = this.owner();
    let pos = o ? o.position : this.bot.entity.position;
    if (args.where === 'there') { const t = this.lookBlock(o, { range: 64 }); if (t) pos = new Vec3(t.prev.x, t.prev.y, t.prev.z); }
    const name = args.name || 'this spot';
    const p = this.h.places.add(name, pos, { note: args.note || '', kind: args.coined || this.c.f('memory2') ? 'coined' : 'named', by: 'player' });
    if (p && p.kind === 'home') this.c.home = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
    this.h.places.save();
    return p ? { ok: true, saved: p.name } : { ok: false, reason: 'bad_name', ask: 'the player did not give a name for the place' };
  }

  forgetPlace(args) {
    if (!args.name) return { ok: false, reason: 'no_name', ask: 'the player did not say which place to forget' };
    const ok = this.h.places.remove(args.name) || this.h.places.removeRule(args.name);
    this.h.places.save();
    return ok ? { ok: true } : { ok: false, reason: 'unknown_place', ask: `no place called ${args.name} is saved` };
  }

  houseRule(args) {
    const o = this.owner();
    const named = args.name ? this.h.places.find(args.name) : null;
    const center = named ? named.pos : this.h.places.home()?.pos || (o ? o.position : this.bot.entity.position);
    const r = this.h.places.addRule({ name: args.name || (named ? named.name : 'here'), center, radius: args.radius || 10 });
    this.h.places.save();
    this.s._work = null;
    return r ? { ok: true, rule: `${r.radius} blocks around ${r.name}` } : { ok: false, reason: 'no_spot' };
  }

  async getItemJob(s, args) {
    const item = args.item || (args.wood ? `${args.wood}_log` : null);
    if (!item) throw new Nope('the player did not say which item');
    const n = args.n || (/^(log|planks|cobblestone|dirt|sand|gravel)$|_log$|_planks$/.test(item) ? 16 : item === 'food' ? 5 : 1);
    const got = await this.h.fetcher.get(s, item, n, { give: !args.keep });
    const extra = this.h.fetcher.replanted ? `, replanted ${this.h.fetcher.replanted}` : '';
    this.h.fetcher.replanted = 0;
    const ho = this.h.fetcher.lastHandOver;
    this.h.fetcher.lastHandOver = null;
    if (!args.keep && ho && this.c.f('bodyHandover')) {

      const had = Number.isFinite(ho.start) ? ho.start : got;
      const k = Math.min(had, n), short = had < n ? ` (wanted ${n})` : '';
      if (ho.tossed <= 0) return `got ${amount(k, item)}, but couldn't hand them over (still with you)${short}${extra}`;
      if (ho.lying >= ho.tossed) return `dropped ${amount(ho.tossed, item)} right by the player (still on the ground)${short}${extra}`;
      if (this.c.f('bodyToss')) {
        const got2 = Math.max(0, ho.tossed - ho.lying);
        const parts = [ho.lying ? `${ho.lying} still on the ground by the player` : '', k > ho.tossed ? `${k - ho.tossed} still with you` : ''].filter(Boolean).join(', ');
        return `brought the player ${amount(got2, item)}${parts ? ` (${parts})` : ''}${short}${extra}`;
      }
      if (ho.tossed < k) return `brought the player ${amount(ho.tossed, item)}, ${k - ho.tossed} still with you${short}${extra}`;
      if (ho.lying) return `dropped ${amount(ho.tossed, item)} by the player (${ho.lying} still on the ground)${short}${extra}`;
      return `brought the player ${amount(ho.tossed, item)}${short}${extra}`;
    }
    return `${args.keep ? 'got' : 'brought the player'} ${amount(Math.min(got, n), item)}${got < n ? ` (wanted ${n})` : ''}${extra}`;
  }

  async getFoodJob(s) {
    const bot = s.bot;
    const cooked = s.items().filter((i) => FOOD_RE.test(i.name)).reduce((a, i) => a + i.count, 0);
    const raw = Object.keys(RAW_FOOD).reduce((a, r) => a + s.count(r), 0);
    const ripeN = this.ripeCrops(s, 16).length;
    const animals = Object.values(bot.entities).filter((e) => PASSIVE_FOOD.includes(e.name) && e.position && e.position.distanceTo(bot.entity.position) < 32 && !isNamed(e)).length;
    const pick = chooseFood({ cooked, raw, wheat: s.count('wheat'), ripe: ripeN, animals });
    this.h.progress(`food plan: ${pick.why}`);
    switch (pick.job) {
      case 'give': break;
      case 'cook': for (const r of Object.keys(RAW_FOOD)) if (s.count(r)) await s.smelt(r, Math.min(16, s.count(r))); break;
      case 'bread': await s.craft('bread', Math.floor(s.count('wheat') / 3)); break;
      case 'harvest': await this.harvestJob(s, {}); break;
      default: await this.h.fetcher.food(s, 3);
    }
    const food = s.items().filter((i) => FOOD_RE.test(i.name));
    if (!food.length) throw new Nope('no food anywhere around here');
    this.h.fetcher.lastHandOver = null;
    const given = await this.h.fetcher.handOver(s, 'food', Math.max(1, Math.min(5, Math.ceil(food.reduce((a, i) => a + i.count, 0) / 2))));
    const told = this.handTold('food', given);
    if (told) return `${told} (${pick.why})`;
    return `gave the player ${given} food (${pick.why})`;
  }

  async craftItemJob(s, args) {
    let item = args.item;
    if (!item) throw new Nope('the player did not say what to make');
    if (['pickaxe', 'sword', 'axe', 'shovel', 'hoe'].includes(item)) item = this.h.fetcher.bestTool(s, item);
    if (item === 'bed') item = 'white_bed';
    if (item === 'planks') { await this.h.fetcher.get(s, 'planks', args.n || 4); return `made ${s.count(PLANKS_RE)} planks`; }
    const n = Math.max(1, Math.min(64, args.n || 1));
    const tier = /^(wooden|stone|iron|golden|diamond|netherite)_/.exec(item);
    if (tier && tier[1] === 'diamond' && s.count('diamond') < 3) this.h.progress(`need diamonds for a diamond ${item.split('_')[1]}, going mining`, { force: true });
    if (tier && tier[1] === 'iron' && s.count('iron_ingot') < 3) this.h.progress(`need iron for that, going to get some`, { force: true });
    const before = s.count(item);
    await this.h.fetcher.craft(s, item, before + n);
    const made = s.count(item) - before;
    this.h.fetcher.lastHandOver = null;
    if (!args.keep) await this.h.fetcher.handOver(s, item, Math.min(n, s.count(item)));
    const ho = !args.keep && this.c.f('bodyHandover') ? this.h.fetcher.lastHandOver : null;
    this.h.fetcher.lastHandOver = null;
    if (ho) {
      const what = made === 1 ? oneOf(item) : amount(made, item);
      if (ho.tossed <= 0) return `made ${what}, but couldn't hand ${made > 1 ? 'them' : 'it'} over (still with you)`;
      if (ho.lying >= ho.tossed) return `made ${what} and dropped ${made > 1 ? 'them' : 'it'} right by the player (still on the ground)`;
    }
    return `made ${made === 1 ? oneOf(item) : amount(made, item)}${args.keep ? '' : made > 1 ? ' and tossed them over' : ' and tossed it over'}`;
  }

  async makeArmorJob(s, args) {
    const mat = /diamond/.test(args.item || '') ? 'diamond' : /leather/.test(args.item || '') ? 'leather' : /gold/.test(args.item || '') ? 'golden' : 'iron';
    const sets = args.who === 'both' || (args.n && args.n >= 2) ? 2 : 1;
    const pieces = [['helmet', 5], ['chestplate', 8], ['leggings', 7], ['boots', 4]];
    const per = 24;
    const raw = mat === 'iron' ? 'iron_ingot' : mat === 'diamond' ? 'diamond' : mat === 'golden' ? 'gold_ingot' : 'leather';
    const need = per * sets - s.count(raw);
    const say = (n) => (mat === 'iron' ? `${n} iron` : mat === 'golden' ? `${n} gold` : amount(n, raw));
    if (need > 0) this.h.progress(`that's ${say(per * sets)} for ${sets === 2 ? 'two sets' : 'a set'}, ${s.count(raw) ? `got ${s.count(raw)}, ` : ''}going to get the rest`, { force: true });
    if (need > 0) await this.h.fetcher.get(s, raw, per * sets, { depth: 1, quiet: true });
    const made = [];
    for (let k = 0; k < sets; k++) for (const [p] of pieces) {
      const name = `${mat}_${p}`;
      try { await s.craft(name, 1); made.push(name); } catch (err) { if (err.cancelled) throw err; }
    }
    if (!made.length) throw new Nope(`not enough ${mat === 'iron' ? 'iron' : itemLabel(raw)} for armor`);
    if (sets === 2) {
      for (const [p] of pieces) await this.h.fetcher.handOver(s, `${mat}_${p}`, 1).catch((e) => { if (e.cancelled) throw e; });
      await s.equipArmor();
      return `made two ${mat} sets, tossed the player one and put yours on`;
    }
    if (args.who === 'me') { await s.equipArmor(); return `made a ${mat} set and put it on`; }
    for (const [p] of pieces) await this.h.fetcher.handOver(s, `${mat}_${p}`, 1).catch((e) => { if (e.cancelled) throw e; });
    return `made a ${mat} set and tossed it over`;
  }

  async smeltItemJob(s, args) {
    let input = args.item;
    const recent = this.h.recentGifts.filter((g) => Date.now() - g.at < 3 * 60 * 1000).reverse();
    const smeltable = (n) => /^raw_/.test(n) || RAW_FOOD[n] || n === 'sand' || n === 'cobblestone' || LOG_RE.test(n) || n === 'clay_ball';
    if (input === 'food' || input === 'beef' && !s.count('beef')) input = Object.keys(RAW_FOOD).find((r) => s.count(r)) || input;
    if (input && !smeltable(input)) { const cooked = Object.entries(RAW_FOOD).find(([, v]) => v === input); if (cooked) input = cooked[0]; else if (input === 'iron_ingot') input = 'raw_iron'; else if (input === 'gold_ingot') input = 'raw_gold'; else if (input === 'glass') input = 'sand'; }
    if (!input || !s.count(input)) {
      const g = recent.find((x) => smeltable(x.name) && s.count(x.name));
      const held = this.owner()?.heldItem?.name;
      input = g ? g.name : held && smeltable(held) && s.count(held) ? held : null;
    }
    if (!input) {
      const any = ['raw_iron', 'raw_gold', ...Object.keys(RAW_FOOD)].find((n) => s.count(n));
      if (!any) throw new Nope('the player has not given you anything to smelt');
      input = any;
    }
    const n = Math.min(64, args.n || s.count(input));
    const got = await s.smelt(input, n);
    if (!got) throw new Nope(`the ${itemLabel(input)} didn't smelt`);
    const out = s.items().slice().reverse().find((i) => i.name !== input && (i.name === RAW_FOOD[input] || i.name === input.replace(/^raw_/, '') + '_ingot' || i.name === 'glass' || i.name === 'stone' || i.name === 'charcoal'));
    if (!args.keep && out) await this.h.fetcher.handOver(s, out.name, Math.min(got, out.count)).catch((e) => { if (e.cancelled) throw e; });
    return `smelted ${amount(got, input)}${!args.keep && out ? ' and tossed it back' : ''}`;
  }

  async teachRecipeJob(s, args) {
    const item = args.item === 'bed' ? 'white_bed' : args.item;
    if (!item) throw new Nope('the player did not say which item to show');
    const r = spec.recipeText(item, s.data) || spec.recipeText(item);
    if (!r) throw new Nope(`${itemLabel(item)} isn't crafted; it has to be found`);
    const o = this.owner();
    if (o) await s.gotoNear(o.position, 2, { dig: false, timeout: 20000 }).catch((e) => { if (e.cancelled) throw e; });
    this.h.progress(`showing the player the recipe for ${r.label}: ${r.text}`, { force: true });
    await s.wait(1500);
    try { await this.h.fetcher.craft(s, item, s.count(item) + 1, 1); } catch (err) {
      if (err.cancelled) throw err;
      return `explained how to make ${oneOf(item)} (${r.text}) but couldn't make one: ${err.message}`;
    }
    if (o) await this.h.fetcher.handOver(s, item, 1).catch((e) => { if (e.cancelled) throw e; });
    return `made ${oneOf(item)} in front of the player: ${r.text}`;
  }

  async mineVeinJob(s, args) {
    const bot = s.bot;
    const t = this.lookBlock(this.owner(), { range: 24, liquids: false });
    if (!t || !/_ore$|ancient_debris/.test(t.block.name)) throw new Nope('the player is not looking at an ore');
    const name = t.block.name;
    const tier = /diamond|gold|redstone|emerald/.test(name) ? 2 : /iron|lapis|copper/.test(name) ? 1 : 0;
    await s.ensurePickaxe(tier);
    let got = 0;
    const done = new Set();
    const queue = [new Vec3(t.x, t.y, t.z)];
    while (queue.length && got < 24) {
      s.check();
      const p = queue.shift();
      const k = `${p.x},${p.y},${p.z}`;
      if (done.has(k)) continue;
      done.add(k);
      const b = bot.blockAt(p);
      if (!b || b.name !== name) continue;
      if (this.h.noDig(p)) continue;
      try {
        const bld = new B.Builder(this.h);
        await bld.reach(s, p);
        await bld.equipFor(s, b);
        await s.digAt(p);
        got++;
      } catch (err) { if (err.cancelled) throw err; continue; }

      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = p.offset(dx, dy, dz);
        const nb = bot.blockAt(n);
        if (nb && nb.name === name && s.exposed(nb)) queue.push(n);
      }
      await s.wait(200);
    }

    for (let i = 0; i < 6; i++) { const it = this.c.nearestItem(6); if (!it) break; await s.gotoNear(it.position, 0, { dig: false, timeout: 5000 }).catch((e) => { if (e.cancelled) throw e; }); }
    if (!got) throw new Nope("couldn't get at that ore");
    return `mined ${got} ${name.replace(/^deepslate_/, '').replace(/_/g, ' ')}`;
  }

  async digDownJob(s, args) {
    const bot = s.bot;
    const target = Number.isFinite(args.y) ? args.y : -58;
    const minY = (bot.game && Number.isFinite(bot.game.minY) ? bot.game.minY : -64) + 4;
    const goalY = Math.max(target, minY);
    if (bot.entity.position.y <= goalY + 1) return `already at y ${Math.round(bot.entity.position.y)}`;

    await s.ensurePickaxe(goalY < 0 ? 1 : 0).catch((e) => { if (e.cancelled) throw e; if (goalY < 0) throw e; });
    let dir = sideStep(B.facingSide(this.owner()?.yaw ?? bot.entity.yaw));
    let blocked = 0, steps = 0, said = false;
    const startY = bot.entity.position.y;
    const t0 = Date.now();
    while (bot.entity.position.y > goalY + 0.5 && Date.now() - t0 < 10 * 60 * 1000) {
      s.check();
      const ok = await s.tunnelStep(new Vec3(dir.x, 0, dir.z), true).catch((e) => { if (e.cancelled) throw e; if (/bedrock/.test(e.message)) return 'bedrock'; return false; });
      if (ok === 'bedrock') break;
      if (!ok) { blocked++; dir = { x: dir.z, z: -dir.x }; if (blocked > 8) throw new Nope(`too much lava and water to dig down here (stopped at y ${Math.round(bot.entity.position.y)})`); continue; }
      blocked = 0; steps++;
      if (!said && bot.entity.position.y < (startY + goalY) / 2 && steps > 20) { said = true; this.h.progress(`halfway down, at y ${Math.round(bot.entity.position.y)}`); }
      if (bot.food < 8) await this.c.tryEat(true);
    }
    const y = Math.round(bot.entity.position.y);
    this.c.lastMineDepth = y;
    return y <= goalY + 1 ? `made it down to y ${y}${target <= -50 ? ', diamond level' : ''}` : `got down to y ${y}, can't go deeper here`;
  }

  async stripMineJob(s, args) {
    const bot = s.bot;
    const o = this.owner();
    if (!o) throw new Nope('the player is not in sight');
    await s.ensurePickaxe(1).catch((e) => { if (e.cancelled) throw e; return s.ensurePickaxe(0); });
    const start = o.position.floored();
    await s.gotoNear(start, 0.5, { dig: true, timeout: 30000 }).catch((e) => { if (e.cancelled) throw e; });
    const main = sideStep(B.facingSide(o.yaw));
    const side = { x: main.z, z: -main.x };
    const len = Math.max(6, Math.min(48, args.len || 24));
    const ores = [];
    const grabSeen = async () => {
      const all = Object.values(ORES).flatMap((x) => x.blocks);
      const [b] = this.h.fetcher.visible(s, all, { maxDistance: 5, count: 1 });
      if (b && !s.hazardAt(b.position)) { await s.collect([b.name], 1, { maxDistance: 6, where: (x) => x.position.equals(b.position) }).catch((e) => { if (e.cancelled) throw e; }); ores.push(b.name); }
    };
    let torchGap = 0;
    for (let i = 0; i < len; i++) {
      s.check();
      const ok = await s.tunnelStep(new Vec3(main.x, 0, main.z), false).catch((e) => { if (e.cancelled) throw e; return false; });
      if (!ok) { this.h.progress('hit a hazard, stopping the strip mine here'); break; }
      await grabSeen();
      if (++torchGap >= 8 && s.count('torch')) { torchGap = 0; await s.placeAt(bot.entity.position.floored().offset(-main.x, 0, -main.z), 'torch').catch((e) => { if (e.cancelled) throw e; }); }
      if (i % 3 === 2) {

        const back = bot.entity.position.floored();
        for (const sd of [side, { x: -side.x, z: -side.z }]) {
          for (let j = 0; j < 4; j++) { const ok2 = await s.tunnelStep(new Vec3(sd.x, 0, sd.z), false).catch((e) => { if (e.cancelled) throw e; return false; }); if (!ok2) break; await grabSeen(); }
          await s.goto(new GoalBlock(back.x, back.y, back.z), { dig: true, timeout: 15000 }).catch((e) => { if (e.cancelled) throw e; });
        }
      }
      if (bot.food < 8) await this.c.tryEat(true);
    }
    await s.backToPlayer({ timeout: 60000 });
    const by = {};
    for (const o2 of ores) { const k = o2.replace(/^deepslate_/, '').replace(/_ore$/, ''); by[k] = (by[k] || 0) + 1; }
    const list = Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ');
    return list ? `strip mined ${len} blocks and found ${list}` : `strip mined ${len} blocks and found no ores`;
  }

  async digTunnelJob(s, args) {
    const bot = s.bot;
    const o = this.owner();
    const side = ['north', 'south', 'east', 'west'].includes(args.dir) ? args.dir : B.facingSide(o ? o.yaw : bot.entity.yaw);
    const step = sideStep(side);
    const len = Math.max(2, Math.min(64, args.len || 16));
    await s.ensurePickaxe(0);
    if (o) await s.gotoNear(o.position.floored(), 1, { dig: true, timeout: 20000 }).catch((e) => { if (e.cancelled) throw e; });
    this.h.progress(`tunneling ${side}, ${len} blocks`);
    let dug = 0, gap = 0;
    for (let i = 0; i < len; i++) {
      s.check();
      const ok = await s.tunnelStep(new Vec3(step.x, 0, step.z), false).catch((e) => { if (e.cancelled) throw e; return false; });
      if (!ok) break;
      dug++;
      if (++gap >= 8 && s.count('torch')) { gap = 0; await s.placeAt(bot.entity.position.floored().offset(-step.x, 0, -step.z), 'torch').catch((e) => { if (e.cancelled) throw e; }); }
      if (dug === Math.floor(len / 2) && len >= 20) this.h.progress(`halfway, ${dug} blocks in`);
    }
    if (!dug) throw new Nope('something in the way, lava or water');
    return dug < len ? `tunneled ${dug} blocks ${side}, had to stop (lava or water ahead)` : `tunneled ${dug} blocks ${side}`;
  }

  async placeBlockJob(s, args) {
    const item = args.item === 'table' ? 'crafting_table' : args.item;
    if (!item) throw new Nope('the player did not say which block to put down');
    if (!s.count(item)) await this.h.fetcher.get(s, item, 1, { depth: 1 });
    const sp = this.spot(args.where || 'there');
    let pos = null;
    if (!sp.ask && sp.look) pos = sp.prev;
    if (!pos) { const o = this.owner(); if (!o) throw new Nope('the player is not in sight'); pos = s.freeSpotNear(o.position, 1, 2); }
    if (!pos) throw new Nope('no room to put it there');
    const r = await new B.Builder(this.h).place(s, pos, [item], { ops: [] });
    if (r !== 'placed') {
      const alt = s.freeSpotNear(pos, 1, 2);
      if (!alt || (await new B.Builder(this.h).place(s, alt, [item], { ops: [] })) !== 'placed') throw new Nope("couldn't put it there");
    }
    return `put ${oneOf(item)} down`;
  }

  async waterBucketJob(s, args = {}) {
    const bot = s.bot;
    if (!s.count('water_bucket')) {
      if (!s.count('bucket')) {
        if (s.count('iron_ingot') < 3) this.h.progress("need 3 iron for a bucket, getting it");
        await this.h.fetcher.craft(s, 'bucket', 1, 1);
      }
      const [w] = this.h.fetcher.visible(s, ['water'], { maxDistance: 48, count: 1, common: true, where: (b) => B.info(b).level === 0 });
      if (!w) throw new Nope('no water around here to fill it');
      await new B.Builder(this.h).reach(s, w.position);
      await bot.equip(s.find('bucket'), 'hand').catch(() => {});
      await bot.lookAt(w.position.offset(0.5, 0.9, 0.5), true).catch(() => {});
      try { bot.activateItem(); await sleep(300); bot.deactivateItem(); } catch {}
      await s.wait(500);
      if (!s.count('water_bucket')) throw new Nope("couldn't fill the bucket");
    }
    if (args.give === false) return 'got a water bucket';
    await this.h.fetcher.handOver(s, 'water_bucket', 1);
    return 'tossed the player a water bucket';
  }

  ripeCrops(s, r = 16) {
    const names = Object.keys(CROPS);
    return s.findBlocks(names, { maxDistance: r, count: 64, where: (b) => { let age = 0; try { age = b.getProperties().age; } catch {} return ripe(b.name, age); } });
  }

  async harvestJob(s) {
    const bot = s.bot;
    const list = this.ripeCrops(s, 24);
    if (!list.length) throw new Nope('nothing ripe yet');
    let n = 0, replanted = 0;
    const builder = new B.Builder(this.h);
    for (const b of list.slice(0, 48)) {
      s.check();
      const p = b.position.clone();
      const crop = CROPS[b.name];
      const r = await builder.dig(s, p, { ops: [] }, { force: true });
      if (r !== 'dug') continue;
      n++;
      await s.wait(250);
      const it = this.c.nearestItem(3); if (it) await s.gotoNear(it.position, 0, { dig: false, timeout: 3000 }).catch((e) => { if (e.cancelled) throw e; });
      const seed = s.find(crop.seed);
      const soil = bot.blockAt(p.offset(0, -1, 0));
      if (seed && soil && soil.name === 'farmland') {
        await bot.equip(seed, 'hand').catch(() => {});
        try { await builder.reach(s, p); await bot.placeBlock(soil, new Vec3(0, 1, 0)); replanted++; } catch (e) { if (e.cancelled) throw e; }
      }
    }
    return `harvested ${n}, replanted ${replanted}`;
  }

  async shearJob(s, args = {}) {
    const bot = s.bot;
    if (!s.find('shears')) await this.h.fetcher.craft(s, 'shears', 1, 1);
    const sheep = Object.values(bot.entities).filter((e) => e.name === 'sheep' && e.position && e.position.distanceTo(bot.entity.position) < 32 && !this.sheared(e));
    if (!sheep.length) throw new Nope('no sheep with wool around');
    const before = s.count(/_wool$/);
    for (const e of sheep.slice(0, Math.max(1, Math.ceil((args.n || 6) / 2)))) {
      s.check();
      if (!bot.entities[e.id]) continue;
      await s.gotoNear(e.position, 2, { dig: false, timeout: 15000 }).catch((err) => { if (err.cancelled) throw err; });
      await bot.equip(s.find('shears'), 'hand').catch(() => {});
      await bot.lookAt(e.position.offset(0, 0.8, 0), true).catch(() => {});
      try { await bot.activateEntity(e); } catch {}
      await s.wait(400);
      for (let i = 0; i < 3; i++) { const it = this.c.nearestItem(4); if (!it) break; await s.gotoNear(it.position, 0, { dig: false, timeout: 3000 }).catch((err) => { if (err.cancelled) throw err; }); }
    }
    const got = s.count(/_wool$/) - before;
    if (!got) throw new Nope("couldn't get any wool");
    return `sheared ${got} wool`;
  }
  sheared(e) { const m = e.metadata || []; const v = m[17]; return typeof v === 'number' && (v & 0x10) !== 0; }

  async lookAroundJob(s) {
    const bot = s.bot;
    const startY = bot.entity.position.y;
    const cheap = () => s.items().filter((i) => /^(dirt|cobblestone|cobbled_deepslate|netherrack)$/.test(i.name)).reduce((a, i) => a + i.count, 0);
    if (cheap() < 4) await this.h.fetcher.get(s, 'dirt', 5, { quiet: true }).catch((e) => { if (e.cancelled) throw e; });
    const blocks = cheap();
    let climbed = 0;
    if (blocks >= 3) climbed = await this.pillarUp(s, Math.min(6, blocks));
    await s.wait(400);
    const finds = this.scanView(s, { range: 72 });

    for (let i = 0; i < climbed; i++) {
      s.check();
      const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
      if (!below || bot.entity.position.y <= startY + 0.5) break;
      try { await bot.dig(below, true); } catch {}
      await s.wait(350);
    }
    if (this.c.f('memory2')) for (const f of finds) if (f.place) this.h.places.add(f.place, f.pos, { kind: 'auto', by: 'companion' });
    if (!finds.length) return 'looked around from up high and spotted nothing of note';
    return `from up there you can see ${finds.slice(0, 2).map((f) => f.text).join(' and ')}`;
  }

  async pillarUp(s, n) {
    const bot = s.bot;
    let up = 0;
    const under = new Vec3(0, 1, 0);
    for (let i = 0, tries = 0; i < n && tries < n + 3; tries++) {
      s.check();
      const blk = s.find(/^(dirt|cobblestone|cobbled_deepslate|netherrack)$/);
      if (!blk) break;
      if (!B.info(bot.blockAt(bot.entity.position.offset(0, 2, 0))).air) break;
      const y0 = bot.entity.position.y;
      const ground = bot.blockAt(bot.entity.position.offset(0, -1, 0));
      const cell = ground.position.offset(0, 1, 0);
      await bot.equip(blk, 'hand').catch(() => {});
      await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {});
      bot.setControlState('jump', true);
      const t0 = Date.now();
      while (bot.entity.position.y < y0 + 1.05 && Date.now() - t0 < 700) await sleep(25);
      try {
        if (typeof bot._genericPlace === 'function') await bot._genericPlace(ground, under, { forceLook: 'ignore', swingArm: 'right' });
        else await bot.placeBlock(ground, under);
      } catch {}
      bot.setControlState('jump', false);
      const t1 = Date.now();
      while (Date.now() - t1 < 900 && (!bot.entity.onGround || B.info(bot.blockAt(cell)).air)) await sleep(25);
      if (!B.info(bot.blockAt(cell)).air && bot.entity.position.y >= y0 + 0.9) { up++; i++; }
      else if (s.dbg) s.dbg(`pillarUp: try ${tries + 1} didn't take (cell ${bot.blockAt(cell) && bot.blockAt(cell).name}, rose ${(bot.entity.position.y - y0).toFixed(2)})`);
    }
    return up;
  }

  async shapeJob(s, args = {}) {
    const shape = args.shape || 'tower';
    if (shape === 'tower') return this.towerJob(s, args);
    const bot = s.bot;
    const o = this.owner();
    if (!o) throw new Nope('the player is not in sight');
    const side = B.facingSide(o.yaw);
    const long = shape === 'stairs' || shape === 'path';
    const dim = Math.max(args.w || 0, args.l || 0, shape === 'wall' ? 1 : 5);
    const site = this.site(args, long ? 1 : dim, long ? 1 : dim);
    const center = this.towerBase(s, site.center) || site.center;
    const plan = B.shapePlan({ shape, center, side, w: args.w, l: args.l, h: args.h, len: args.len ?? (shape === 'wall' ? args.w : null), hollow: !!args.hollow, block: args.block || null });
    if (!plan || !plan.cells.length) throw new Nope("don't know how to build that shape");
    const name = String(args.block || 'dirt').replace(/_/g, ' ');
    const bounds = B.boundsOf(plan.cells);

    const planned = new Set(plan.cells.map((c) => `${c.x},${c.y},${c.z}`));
    const scaffold = new Map();
    const SCAF = /^(dirt|cobblestone|cobbled_deepslate|netherrack)$/;
    const onUpdate = (oldB, newB) => {
      if (!newB || !oldB || !SCAF.test(newB.name) || !(B.info(oldB).air || B.info(oldB).plant)) return;
      const p = newB.position;
      if (planned.has(`${p.x},${p.y},${p.z}`) || !bot.entity || bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > 2.6) return;
      scaffold.set(`${p.x},${p.y},${p.z}`, p.clone());
    };
    bot.on('blockUpdate', onUpdate);
    this.h.keepOut = { x0: bounds.x0 - 1, x1: bounds.x1 + 1, y0: bounds.y0 - 2, y1: bounds.y1 + 1, z0: bounds.z0 - 1, z1: bounds.z1 + 1 };
    let stats;
    try {
      stats = await this.h.builder.run(s, plan, { label: `the ${plan.label}` });
    } finally {
      bot.removeListener('blockUpdate', onUpdate);
      this.h.keepOut = null;
    }
    await this.cleanScaffold(s, scaffold, bounds);
    try { await bot.lookAt(new Vec3((bounds.x0 + bounds.x1) / 2 + 0.5, bounds.y0 + 1, (bounds.z0 + bounds.z1) / 2 + 0.5)); } catch {}
    if (!stats.placed && stats.done < 0.5) throw new Nope(stats.missing ? `ran out of ${name}` : "the blocks wouldn't go down there");
    const pct = Math.round((stats.done || 0) * 100);
    return pct >= 95 ? `built a ${name} ${plan.label}` : `built most of a ${name} ${plan.label} (about ${pct}% of it: ${stats.missing ? `ran out of ${name}` : 'some spots were in the way'})`;
  }

  async cleanScaffold(s, scaffold, bounds) {
    if (!scaffold.size) return;
    const bot = s.bot;
    const keyOf = (p) => `${p.x},${p.y},${p.z}`;
    for (let i = 0; i < 40; i++) {
      s.check();
      const under = bot.entity.position.floored().offset(0, -1, 0);
      if (!scaffold.has(keyOf(under))) break;
      const b = bot.blockAt(under);
      scaffold.delete(keyOf(under));
      if (!b || B.info(b).air) continue;
      await this.h.builder.equipFor(s, b);
      try { await bot.dig(b, true); } catch {}
      await s.wait(350);
    }
    const rest = [...scaffold.values()].sort((a, b) => b.y - a.y).slice(0, 32);
    for (const p of rest) {
      s.check();
      const b = bot.blockAt(p);
      if (!b || B.info(b).air || !/^(dirt|cobblestone|cobbled_deepslate|netherrack)$/.test(b.name)) continue;
      await this.h.builder.dig(s, p, { ops: [] }, { force: true }).catch((e) => { if (e.cancelled) throw e; });
    }
  }

  async towerJob(s, args = {}) {
    const bot = s.bot;
    const asked = Math.max(2, Math.min(24, Math.round(Number(args.h) || 8)));
    const want = args.block || 'dirt';
    const choices = [want];
    const name = want.replace(/_/g, ' ');
    const site = this.site(args, 1, 1);
    let base = this.towerBase(s, site.center);

    if (this.c.f('bodyCoach')) {
      const room = (p) => { let k = 0; for (; k < asked + 1; k++) { const i = B.info(bot.blockAt(p.offset(0, k, 0))); if (!i.loaded || !(i.air || i.plant)) break; } return k; };
      if (!base || room(base) < asked) {
        let best = null, bestD = 99;
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
          const b = this.towerBase(s, site.center.offset(dx, 0, dz));
          if (!b || room(b) < asked) continue;
          const d = Math.abs(dx) + Math.abs(dz);
          if (d < bestD) { best = b; bestD = d; }
        }
        if (best) base = best;
      }
    }
    if (!base) throw new Nope("can't find solid ground there for a tower");

    let h = 0;
    for (; h < asked; h++) { const i = B.info(bot.blockAt(base.offset(0, h, 0))); if (!i.loaded || !(i.air || i.plant)) break; }
    if (h < 2) throw new Nope("there's no room to stack anything there");
    let blocked = h < asked;
    let side = this.scaffoldSpot(s, base, h);
    if (!side) h = Math.min(h, 5);
    const climb = side ? Math.max(0, h - 4) : 0;

    const SCAFFOLD = /^(dirt|cobblestone|cobbled_deepslate|netherrack)$/;
    const sameKind = SCAFFOLD.test(want);
    const towerHave = () => s.items().filter((i) => B.matchesAny(i.name, choices)).reduce((a, i) => a + i.count, 0);
    const scafHave = () => s.items().filter((i) => SCAFFOLD.test(i.name)).reduce((a, i) => a + i.count, 0);

    const fetchTo = async (item, n) => {
      this.h.keepOut = { x0: base.x - 2, x1: base.x + 2, y0: base.y - 3, y1: base.y + 1, z0: base.z - 2, z1: base.z + 2 };
      try { await this.h.fetcher.get(s, item, n, { quiet: true }); } catch (err) { if (err.cancelled) throw err; } finally { this.h.keepOut = null; }
    };
    const spare = this.c.f('bodyTower') ? 2 : 0;
    if (sameKind) {
      const need = h + climb + spare, have = towerHave();
      if (have < need) {
        if (need - have >= 8) this.h.progress(`need ${need - have} more ${name} for the tower, getting that first`);
        await fetchTo(want, this.h.fetcher.countOf(s, want) + (need - have));
        if (this.c.f('bodyCoach') && towerHave() < need) await fetchTo(want, this.h.fetcher.countOf(s, want) + (need - towerHave()));
      }
    } else {
      if (towerHave() < h) {
        if (h - towerHave() >= 8) this.h.progress(`need ${h - towerHave()} more ${name} for the tower, getting that first`);
        await fetchTo(want, this.h.fetcher.countOf(s, want) + (h - towerHave()));
      }
      if (scafHave() < climb + spare) await fetchTo('dirt', this.h.fetcher.countOf(s, 'dirt') + (climb + spare - scafHave()));
    }
    s.check();

    const base2 = this.towerBase(s, base);
    if (!base2) throw new Nope("can't find solid ground there for a tower");
    if (!base2.equals(base)) { base.x = base2.x; base.y = base2.y; base.z = base2.z; }
    for (h = 0; h < asked; h++) { const i = B.info(bot.blockAt(base.offset(0, h, 0))); if (!i.loaded || !(i.air || i.plant)) break; }
    if (h < 2) throw new Nope("there's no room to stack anything there");
    blocked = h < asked;
    side = this.scaffoldSpot(s, base, h);
    if (!side) h = Math.min(h, 5);

    const blocks = sameKind ? towerHave() : Math.min(towerHave(), h);
    if (sameKind) { while (h > 2 && h + (side ? Math.max(0, h - 4) : 0) > blocks) h--; }
    else { h = Math.min(h, blocks); if (side) h = Math.min(h, 4 + scafHave()); }
    if (h < 2 || towerHave() < 2) throw new Nope(`couldn't get enough ${name} for a tower`);

    if (side) {
      try { await s.goto(new GoalBlock(side.x, side.y, side.z), { dig: false, timeout: 20000 }); } catch (err) {
        if (err.cancelled) throw err;
        await s.goto(new GoalBlock(side.x, side.y, side.z), { dig: true, timeout: 20000 }).catch((e) => { if (e.cancelled) throw e; throw new Nope("couldn't get over to that spot"); });
      }
    }

    const log = { label: `the ${name} tower`, kind: 'tower', ops: [], at: Date.now(), anchor: base };
    const hist = this.h.builder.history;
    hist.push(log);
    if (hist.length > 3) hist.shift();
    const feetY = () => Math.floor(bot.entity.position.y + 0.01);
    let placed = 0, climbed = 0, saidHalf = false;
    for (let k = 0; k < h; k++) {
      s.check();
      const T = base.offset(0, k, 0);
      if (side) {
        for (let tries = 0; T.y > feetY() + 3 && tries < 4; tries++) climbed += await this.pillarUp(s, 1);
        if (T.y > feetY() + 4) { s.dbg && s.dbg(`tower: stuck at feet ${feetY()} for block ${T.y}`); break; }
      }
      if (B.matchesAny(bot.blockAt(T)?.name, choices)) { placed++; continue; }
      let r = await this.h.builder.place(s, T, choices, log);
      if (r === 'failed' || r === 'defer') { await s.wait(400); r = await this.h.builder.place(s, T, choices, log); }

      if ((r === 'failed' || r === 'defer') && side && this.c.f('bodyTower')) {
        s.dbg && s.dbg(`tower: block ${k + 1} at y ${T.y} didn't go down (${r}), feet ${feetY()}, ${s.find(/^(dirt|cobblestone|cobbled_deepslate|netherrack)$/) ? 'has' : 'no'} scaffold blocks; climbing once more`);
        climbed += await this.pillarUp(s, 1);
        await s.wait(300);
        r = await this.h.builder.place(s, T, choices, log);
      }
      if (r !== 'placed') { s.dbg && s.dbg(`tower: stopped at block ${k + 1} (${r}), feet ${feetY()}, tower top ${T.y}, have ${towerHave()}`); break; }
      placed++;
      if (!saidHalf && h >= 10 && placed >= h / 2) { saidHalf = true; this.h.progress('halfway up'); }
    }

    if (side) {
      for (let i = 0; i < climbed + 4; i++) {
        s.check();
        if (feetY() <= side.y) break;
        const under = bot.entity.position.floored().offset(0, -1, 0);
        if (under.x === base.x && under.z === base.z) break;
        const b = bot.blockAt(under);
        if (!b || B.info(b).air) { await s.wait(300); continue; }
        await this.h.builder.equipFor(s, b);
        try { await bot.dig(b, true); } catch {}
        await s.wait(350);
      }
      await s.wait(500);
    }
    try { await bot.lookAt(base.offset(0.5, Math.min(placed, 6), 0.5)); } catch {}
    if (!placed) throw new Nope("the blocks wouldn't go down there");
    if (placed >= asked) return `stacked a ${placed} high ${name} tower`;
    const why = placed < h ? "couldn't get it any higher" : blocked ? 'something was in the way above it'
      : !side ? "no room next to it to climb, so that's as high as you can reach" : `ran out of ${name}`;
    return `stacked a ${placed} high ${name} tower (${why})`;
  }

  towerBase(s, center) {
    const bot = s.bot;
    const o = this.owner();
    const taken = (p) => o && o.position.floored().x === p.x && o.position.floored().z === p.z && Math.abs(o.position.floored().y - p.y) <= 1;
    for (const dy of [0, 1, -1, 2, -2, -3, -4, -5, -6]) {
      const p = new Vec3(center.x, center.y + dy, center.z);
      const here = B.info(bot.blockAt(p)), under = B.info(bot.blockAt(p.offset(0, -1, 0)));
      if (here.loaded && (here.air || here.plant) && under.solid && !under.liquid && !taken(p)) return p;
    }
    return null;
  }

  scaffoldSpot(s, base, h) {
    const bot = s.bot;
    const o = this.owner();
    const need = Math.max(0, h - 4) + 3;
    const me = bot.entity.position;
    const out = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const p = base.offset(dx, 0, dz);
      if (o && o.position.floored().x === p.x && o.position.floored().z === p.z) continue;
      const under = B.info(bot.blockAt(p.offset(0, -1, 0)));
      if (!under.solid || under.liquid) continue;
      let ok = true;
      for (let k = 0; k < need && ok; k++) { const i = B.info(bot.blockAt(p.offset(0, k, 0))); ok = i.loaded && (i.air || (k === 0 && i.plant)); }
      if (ok) out.push(p);
    }
    out.sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
    return out[0] || null;
  }

  scanView(s, { range = 64 } = {}) {
    const bot = s.bot;
    const eye = bot.entity.position.offset(0, 1.62, 0);

    const seen = (p) => [0.92, 0.5].some((fy) => {
      const d = { x: p.x + 0.5 - eye.x, y: p.y + fy - eye.y, z: p.z + 0.5 - eye.z };
      const len = Math.hypot(d.x, d.y, d.z);
      const hit = raycast(eye, { x: d.x / len, y: d.y / len, z: d.z / len }, len + 0.5, (x, y, z) => bot.blockAt(new Vec3(x, y, z)), (b) => B.info(b).solid || B.info(b).liquid);
      return !hit || (hit.x === p.x && hit.y === p.y && hit.z === p.z) || hit.dist >= len - 1;
    });
    const here = bot.entity.position;
    const finds = [];
    const where = (p) => direction(here, p);
    const villager = Object.values(bot.entities).find((e) => e.name === 'villager' && e.position && e.position.distanceTo(here) < range && seen(e.position.offset(0, 1, 0).floored()));
    const bell = !villager && s.findBlocks(['bell'], { maxDistance: range, count: 3 }).find((b) => seen(b.position));
    if (villager || bell) { const p = (villager || bell).position; finds.push({ w: 10, text: `a village ${where(p)}`, place: 'village', pos: p }); }
    const lava = s.findBlocks(['lava'], { maxDistance: Math.min(range, 40), count: 30 }).find((b) => seen(b.position));
    if (lava) finds.push({ w: 8, text: `lava ${where(lava.position)}`, pos: lava.position });
    const here0 = bot.blockAt(here.floored());
    const biome0 = here0 && here0.biome && here0.biome.name;
    if (biome0) {
      for (const r of [48, 32]) {
        for (let a = 0; a < 8; a++) {
          const x = Math.round(here.x + Math.cos(a * Math.PI / 4) * r), z = Math.round(here.z + Math.sin(a * Math.PI / 4) * r);
          const b = bot.blockAt(new Vec3(x, Math.round(here.y) - 2, z));
          const bn = b && b.biome && b.biome.name;
          if (bn && bn !== biome0 && !/river|ocean/.test(bn) && !finds.some((f) => f.biome)) finds.push({ w: 6, biome: true, text: `${/^the /.test(bn) ? '' : 'a '}${bn.replace(/_/g, ' ')} ${where(b.position)}` });
        }
      }
    }
    const water = s.findBlocks(['water'], { maxDistance: Math.min(range, 48), count: 40 }).filter((b) => seen(b.position));
    if (water.length >= 6) finds.push({ w: 4, text: `water ${where(water[0].position)}`, place: 'water', pos: water[0].position });
    const cave = this.findCaveMouth(s, seen, Math.min(range, 40));
    if (cave) finds.push({ w: 7, text: `what looks like a cave ${where(cave)}`, place: 'cave', pos: cave });
    const mobs = Object.values(bot.entities).filter((e) => isHostileMob(e) && e.position && e.position.distanceTo(here) < 32 && seen(e.position.offset(0, 1, 0).floored()));
    if (mobs.length) finds.push({ w: 3, text: `${mobs.length > 1 ? `${mobs.length} mobs` : `a ${mobs[0].name.replace(/_/g, ' ')}`} ${where(mobs[0].position)}` });
    return finds.sort((a, b) => b.w - a.w).slice(0, 2);
  }

  findCaveMouth(s, seen, range = 40) {
    const bot = s.bot;
    const stone = s.findBlocks(['stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff'], { maxDistance: range, count: 60, where: (b) => s.exposed(b) });
    for (const b of stone) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = b.position.offset(dx, 0, dz);
        const ab = bot.blockAt(a);
        if (!ab || !B.info(ab).air) continue;
        let roof = 0;
        for (let dy = 1; dy <= 4; dy++) if (B.info(bot.blockAt(a.offset(0, dy, 0))).solid) { roof = dy; break; }
        const deep = bot.blockAt(a.offset(dx, 0, dz));
        if (roof && roof <= 3 && deep && B.info(deep).air && seen(a)) return a;
      }
    }
    return null;
  }

  async findJob(s, args) {
    const bot = s.bot;
    const kind = args.kind === 'cave' ? 'cave' : args.kind === 'water' ? 'water' : 'village';
    const o = this.owner();
    let a = o ? Math.atan2(-Math.sin(o.yaw), -Math.cos(o.yaw)) : Math.random() * Math.PI * 2;
    for (let leg = 0; leg < 6; leg++) {
      s.check();
      const finds = this.scanView(s, { range: 80 }).filter((f) => f.place === kind || (kind === 'village' && /village/.test(f.text)));
      const all = this.scanView(s, { range: 80 });
      const f = finds[0] || all.find((x) => x.place === kind);
      if (f) {
        this.h.places.add(kind, f.pos, { kind: this.c.f('memory2') ? 'auto' : 'named', by: 'companion' });
        this.h.places.save();
        this.h.progress(`found ${f.text.replace(/ (about )?\d+ blocks \w+$/, '')}`, { big: true, force: true });
        await s.backToPlayer({ timeout: 90000 });
        const back = o ? direction(this.owner()?.position || bot.entity.position, f.pos) : '';
        return `found a ${kind}${back ? `, ${back} from the player` : ''}`;
      }
      if (leg === 2) this.h.progress(`no ${kind} yet, going a bit further`);
      const p = bot.entity.position;
      a += (Math.random() - 0.5) * 0.9;
      await s.goto(new GoalXZ(Math.round(p.x + Math.cos(a) * 32), Math.round(p.z + Math.sin(a) * 32)), { dig: false, timeout: 40000 }).catch((e) => { if (e.cancelled) throw e; });
    }
    await s.backToPlayer({ timeout: 90000 });
    throw new Nope(`walked a good way and didn't see a ${kind}`);
  }

  async baseSpotJob(s) {
    const bot = s.bot;
    const o = this.owner();
    const c0 = (o || bot.entity).position.floored();
    const groundY = (x, z) => { for (let y = c0.y + 8; y >= c0.y - 10; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && B.info(b).solid) return { y, b }; if (b && B.info(b).liquid) return { y, b, wet: true }; } return null; };
    const water = s.findBlocks(['water'], { maxDistance: 56, count: 200 });
    const logs = s.findBlocks(Object.keys(s.data.blocksByName).filter((n) => LOG_RE.test(n)), { maxDistance: 56, count: 200 });
    let best = null;
    for (let dx = -40; dx <= 40; dx += 8) for (let dz = -40; dz <= 40; dz += 8) {
      const cx = c0.x + dx, cz = c0.z + dz;
      const g = groundY(cx, cz);
      if (!g || g.wet) continue;
      const hs = [];
      let wet = 0;
      for (let i = -4; i <= 4; i += 2) for (let j = -4; j <= 4; j += 2) { const gg = groundY(cx + i, cz + j); if (!gg) continue; if (gg.wet) wet++; hs.push(gg.y); }
      if (hs.length < 15 || wet > 2) continue;
      const mean = hs.reduce((a, b) => a + b, 0) / hs.length;
      const spread = Math.sqrt(hs.reduce((a, b) => a + (b - mean) ** 2, 0) / hs.length);
      const p = new Vec3(cx, g.y + 1, cz);
      const nearWater = water.some((w) => w.position.distanceTo(p) < 14);
      const nearTrees = logs.filter((l) => l.position.distanceTo(p) < 20).length >= 4;
      const flat = spread < 0.6 ? 3 : spread < 1.2 ? 1.5 : 0;
      const score = flat * 2 + (nearWater ? 2 : 0) + (nearTrees ? 1.5 : 0) - Math.hypot(dx, dz) / 40;
      const reason = flat >= 3 && nearWater ? 'flat ground with water nearby' : flat >= 3 ? 'flat ground' : nearWater ? 'water nearby' : nearTrees ? 'trees nearby' : 'the best of the spots checked';
      if (!best || score > best.score) best = { score, p, reason };
    }
    if (!best) throw new Nope("couldn't find a flat spot around here");
    this.h.places.add('base spot', best.p, { note: best.reason, kind: 'named', by: 'companion' });
    this.h.places.save();
    return `found a spot ${direction(c0, best.p)}, ${best.reason}`;
  }

  async sleepJob(s) {
    const bot = s.bot;
    const t = bot.time?.timeOfDay;
    if (!(t != null && t >= 12540 && t <= 23458) && !bot.thunderState) throw new Nope("it's not night yet, can't sleep");
    const o = this.owner();
    const near = (o || bot.entity).position;
    const beds = s.findBlocks(Object.keys(s.data.blocksByName).filter((n) => /_bed$/.test(n)), { maxDistance: 24, count: 10 })
      .filter((b) => { try { return !b.getProperties().occupied; } catch { return true; } })
      .sort((a, b) => a.position.distanceTo(near) - b.position.distanceTo(near));
    let bed = beds[0];

    if (!bed && s.findBlocks(Object.keys(s.data.blocksByName).filter((n) => /_bed$/.test(n)), { maxDistance: 24, count: 1 }).length && !s.find(/_bed$/)) throw new Nope('no free bed nearby, the one here is taken');
    if (!bed) {
      if (!s.find(/_bed$/) && s.count(/_wool$/) >= 3) await this.h.fetcher.craft(s, 'white_bed', 1, 1).catch((e) => { if (e.cancelled) throw e; });
      if (!s.find(/_bed$/)) throw new Nope('you have no bed and need 3 wool to make one');
      const spot = s.freeSpotNear(near, 1, 3);
      if (!spot) throw new Nope('no room for your bed');
      await new B.Builder(this.h).place(s, spot, ['bed'], { ops: [] });
      bed = s.findBlocks(Object.keys(s.data.blocksByName).filter((n) => /_bed$/.test(n)), { maxDistance: 6, count: 4 }).find((b) => { try { return !b.getProperties().occupied; } catch { return true; } });
      if (!bed) throw new Nope("couldn't put your bed down");
    }
    await s.gotoNear(bed.position, 1.5, { dig: false, timeout: 20000 });
    try { await bot.sleep(bed); } catch (err) { throw new Nope(/monster/i.test(err.message) ? "can't sleep, there are monsters nearby" : /not night|day/i.test(err.message) ? "it's not night yet" : "couldn't get in the bed"); }
    const t0 = Date.now();
    while (bot.isSleeping && Date.now() - t0 < 60000) await s.wait(500);
    return bot.isSleeping ? `you're in bed; the night won't skip until ${o && o.username ? o.username : 'the player'} sleeps too` : 'slept through the night';
  }

  async giveItemJob(s, args) {
    let item = args.item;
    if (!item) throw new Nope('the player did not say which item');
    if (item === 'iron_ingot' && !s.count('iron_ingot') && s.count('raw_iron')) item = 'raw_iron';
    const have = this.h.fetcher.countOf(s, item);
    if (!have) throw new Nope(`you don't have any ${itemLabel(item)}`);
    const n = Math.min(have, args.n || (item === 'food' ? Math.min(5, have) : have), 64);
    this.h.fetcher.lastHandOver = null;
    const given = await this.h.fetcher.handOver(s, item, n);
    const told = this.handTold(item, given);
    if (told) return `${told}${given < (args.n || 0) && given >= n ? ' (all you had)' : ''}`;
    return `gave the player ${amount(given, item)}${given < (args.n || 0) ? ' (all you had)' : ''}`;
  }

  handTold(item, given) {
    const ho = this.c.f('bodyHandover') ? this.h.fetcher.lastHandOver : null;
    this.h.fetcher.lastHandOver = null;
    if (!ho) return null;
    const what = (k) => (item === 'food' ? `${k} food` : amount(k, item));
    if (ho.tossed <= 0) return `couldn't hand ${item === 'food' ? 'the food' : 'them'} over (still with you)`;
    if (ho.lying >= ho.tossed) return `dropped ${what(ho.tossed)} right by the player (still on the ground)`;
    if (ho.lying) return `gave the player ${what(this.c.f('bodyToss') ? Math.max(0, ho.tossed - ho.lying) : ho.tossed)} (${ho.lying} still on the ground by the player)`;
    return `gave the player ${what(given)}`;
  }

  site(args, w, l) {
    const o = this.owner();
    if (!o) throw new Nope('the player is not in sight');
    if (args.where === 'there') {
      const t = this.lookBlock(o, { range: 40 });
      if (!t) throw new Nope('the player is not pointing at a spot');
      return { x0: t.x - Math.floor((w - 1) / 2), y0: t.y + 1, z0: t.z - Math.floor((l - 1) / 2), door: B.facingSide(o.yaw + Math.PI), center: new Vec3(t.x, t.y + 1, t.z) };
    }
    const side = B.facingSide(o.yaw);
    const st = sideStep(side);
    const f = o.position.floored();
    const ahead = 2 + Math.floor((side === 'east' || side === 'west' ? w : l) / 2);
    const cx = f.x + st.x * ahead, cz = f.z + st.z * ahead;
    const back = { north: 'south', south: 'north', east: 'west', west: 'east' }[side];
    return { x0: cx - Math.floor((w - 1) / 2), y0: f.y, z0: cz - Math.floor((l - 1) / 2), door: back, center: new Vec3(cx, f.y, cz) };
  }

  prepareSite(s, plan) {
    const bot = s.bot;
    const { x0, z0, x1, z1, y0 } = plan.bounds;
    const fill = [];
    let blocked = 0, total = 0, unknown = 0;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const g = bot.blockAt(new Vec3(x, y0 - 1, z));
      if (!g) { unknown++; continue; }
      if (!B.info(g).solid) {
        fill.push({ x, y: y0 - 1, z, block: ['cheap', 'dirt', 'planks'], part: 'foundation', liquidOk: true });
        const g2 = bot.blockAt(new Vec3(x, y0 - 2, z));
        if (g2 && !B.info(g2).solid) fill.unshift({ x, y: y0 - 2, z, block: ['cheap', 'dirt', 'planks'], part: 'foundation', liquidOk: true });
      }
      for (let y = y0; y <= y0 + (plan.size?.h || 3); y++) {
        total++;
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) continue;
        const i = B.info(b);
        if (!i.air && !i.plant && !matchesPlanned(plan, x, y, z, b)) blocked++;
      }
    }
    if (unknown > (x1 - x0 + 1) * (z1 - z0 + 1) * 0.5) throw new Nope("can't see that spot well from here");
    if (fill.length > (x1 - x0 + 1) * (z1 - z0 + 1) * 0.6) throw new Nope("the ground's too uneven there");
    if (blocked > total * 0.12) throw new Nope("there's too much in the way there");
    plan.cells = [...fill, ...plan.cells];
    return plan;
  }

  async buildJob(s, args) {
    if (args.resume && this.c.f('memory2')) {
      const old = this.h.places.latestPlan();
      if (old) args = { ...old.args, ...(old.anchor ? { anchor: old.anchor } : {}), resume: true };
    }
    const kind = args.kind === 'dirt_hut' ? 'dirt_hut' : args.kind === 'house' || (args.w || 5) >= 8 ? 'house' : 'hut';
    if (kind === 'dirt_hut') return this.quickHutJob(s, args);
    const def = kind === 'house' ? { w: 10, l: 10, h: 4 } : { w: 5, l: 5, h: 3 };
    const w = Math.max(3, Math.min(B.CAPS.house.w, args.w || def.w)), l = Math.max(3, Math.min(B.CAPS.house.l, args.l || def.l));
    const h = Math.max(2, Math.min(5, args.h || (Math.max(w, l) >= 8 ? 4 : 3)));
    const style = args.style || (kind === 'house' && args.block && /_planks$|_log$/.test(args.block) ? 'rustic' : 'plain');
    const wood = args.wood || (args.block && /_planks$|_log$/.test(args.block) ? args.block.replace(/_(planks|log)$/, '') : null);
    const pal = B.palette({ style, block: args.block, wood });
    const site = args.anchor ? { x0: args.anchor.x, y0: args.anchor.y, z0: args.anchor.z, door: 'south' } : this.site(args, w, l);
    const what = `${w}x${l} ${args.block ? itemLabel(args.block).replace(/ planks$/, '') + ' ' : ''}${style !== 'plain' ? style + ' ' : ''}${kind}`;
    let plan = B.hutPlan({ x0: site.x0, y0: site.y0, z0: site.z0, w, l, h, door: site.door, pal, furniture: kind === 'house', label: what });
    plan = this.prepareSite(s, plan);
    this.h.currentBuild = { label: what, action: 'build', args: { ...args, w, l, h, kind }, anchor: { x: site.x0, y: site.y0, z: site.z0 } };
    const r = await this.h.builder.run(s, plan, { label: what });
    this.h.currentBuild = null;
    if (r.done < 0.8) throw new Nope(`only got ${r.placed} blocks placed, ran out of ${r.missing ? 'blocks' : 'room'}`);
    if (!this.c.home) this.c.home = plan.inside;
    if (!this.h.places.home()) { this.h.places.add('home', plan.inside, { kind: 'home', by: 'companion', note: what }); this.h.places.save(); }
    await s.goto(new GoalBlock(plan.outside.x, plan.outside.y, plan.outside.z), { dig: false, timeout: 15000 }).catch((e) => { if (e.cancelled) throw e; });
    return `built the ${what}, door facing ${site.door}`;
  }

  async quickHutJob(s, args = {}) {
    const o = this.owner();
    const at = (o && !args.self ? o : s.bot.entity).position.floored();

    const side = o ? B.facingSide(o.yaw) : 'south';
    const plan = B.quickHutPlan({ x0: at.x - 1, y0: at.y, z0: at.z - 1, door: side, block: args.block || null });
    for (const c of plan.cells) if (c.part === 'wall' || c.part === 'roof') c.replace = false;
    this.prepareSite(s, plan);
    const r = await this.h.builder.run(s, plan, { label: 'dirt hut' });
    if (r.done < 0.75) throw new Nope(`ran out of blocks, only ${r.placed} placed`);
    if (this.c.f('memory2')) this.h.places.add('dirt hut', at, { kind: 'auto', by: 'companion' });
    return 'built a dirt hut';
  }

  async digBoxJob(s, args) {
    const sp = this.spot(args.where || (args.h ? 'there' : 'here'));
    if (sp.ask) throw new Nope(sp.ask);
    const w = args.w || (args.h ? 5 : 1), l = args.l || (args.h ? 5 : 1);
    const isRoom = !!args.h || args.kind === 'room';
    await s.ensurePickaxe(0).catch((e) => { if (e.cancelled) throw e; });
    let plan;
    if (isRoom) plan = B.roomPlan({ hit: sp.hit, face: sp.look ? sp.face : { x: 0, y: 1, z: 0 }, w, l, h: args.h || 3, floorY: sp.owner ? Math.floor(sp.owner.position.y) : null });
    else plan = B.digBoxPlan({ x0: sp.hit.x - Math.floor((w - 1) / 2), yTop: sp.hit.y, z0: sp.hit.z - Math.floor((l - 1) / 2), w, l, depth: args.depth || 3 });
    const r = await this.h.builder.run(s, plan, { label: isRoom ? 'room' : 'hole', fetch: false });
    if (isRoom && s.count('torch')) await s.lightUp().catch((e) => { if (e.cancelled) throw e; });
    await s.backToPlayer({ timeout: 45000 });
    const size = `${plan.size.w}x${plan.size.l}`;
    return isRoom ? `dug out a ${size} room, ${plan.size.h} high${r.skipped ? ` (left ${r.skipped} blocks you shouldn't break)` : ''}` : `dug a ${size} hole, ${plan.size.h} deep`;
  }

  async clearAreaJob(s, args) {
    const o = this.owner();
    if (!o) throw new Nope('the player is not in sight');
    const w = Math.min(B.CAPS.clear.w, args.w || 10), l = Math.min(B.CAPS.clear.l, args.l || 10);
    const sp = args.where === 'there' ? this.spot('there') : null;
    const c = sp && !sp.ask ? sp.prev : o.position.floored();
    const getBlock = (x, y, z) => s.bot.blockAt(new Vec3(x, y, z));
    const plan = B.clearPlan({ cx: c.x, y0: c.y, cz: c.z, w, l, above: 8, getBlock });
    if (!plan.cells.length) return 'it was already clear';
    if (plan.cells.length > B.MAX_CELLS) throw new Nope('that area is too big to clear');
    this.h.progress(`clearing ${w}x${l}, ${plan.cells.length} blocks to deal with`);
    await s.ensurePickaxe(0).catch((e) => { if (e.cancelled) throw e; });
    const r = await this.h.builder.run(s, plan, { label: 'clearing' });
    return `cleared ${w}x${l}${plan.skipped ? `, left ${plan.skipped} built blocks alone` : ''}${r.missing ? `, ran out of dirt for some dips` : ''}`;
  }

  async fillHoleJob(s, args) {
    const o = this.owner();
    const t = this.lookBlock(o, { range: 32 });
    if (!t) throw new Nope('the player is not pointing at a hole');
    const start = t.face && t.face.y === 1 ? new Vec3(t.x, t.y + 1, t.z) : new Vec3(t.prev.x, t.prev.y, t.prev.z);
    const maxY = o ? Math.floor(o.position.y) - 1 : start.y;
    const getBlock = (x, y, z) => s.bot.blockAt(new Vec3(x, y, z));
    let from = start.y > maxY ? new Vec3(start.x, maxY, start.z) : start;

    if (!B.info(getBlock(from.x, from.y, from.z)).air) {
      let best = null;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let y = maxY; y >= maxY - 3; y--) {
        const i = B.info(getBlock(t.x + dx, y, t.z + dz));
        if (i.air || i.plant) { const d = Math.abs(dx) + Math.abs(dz) + (maxY - y) * 0.1; if (!best || d < best.d) best = { d, p: new Vec3(t.x + dx, y, t.z + dz) }; break; }
      }
      if (best) from = best.p;
    }
    const plan = B.fillHolePlan({ start: from, maxY, getBlock, block: args.block || null });
    if (plan.tooBig) throw new Nope('that hole is too big to fill');
    if (!plan.cells.length) throw new Nope('there is no hole there');
    await this.h.builder.run(s, plan, { label: 'filling the hole' });
    return `filled it in, ${plan.cells.length} blocks`;
  }

  async coverLiquidJob(s, args) {
    const t = this.lookBlock(this.owner(), { range: 32 });
    const target = t ? new Vec3(t.x, t.y, t.z) : s.bot.entity.position.floored();
    const kind = args.kind === 'water' || args.kind === 'pond' ? 'water' : 'lava';
    const plan = B.liquidPlan({ target, kind, getBlock: (x, y, z) => s.bot.blockAt(new Vec3(x, y, z)) });
    if (plan.tooBig) throw new Nope('that water is too big to drain');
    if (!plan.cells.length) throw new Nope(`no ${kind} there`);
    await this.h.builder.run(s, plan, { label: plan.label });
    return kind === 'lava' ? `covered ${plan.count} lava${plan.more ? `, there's more past that` : ''}` : `drained it, ${plan.count} water blocks`;
  }

  async bridgeJob(s, args) {
    const o = this.owner();
    if (!o) throw new Nope('the player is not in sight');
    const side = args.dir && ['north', 'south', 'east', 'west'].includes(args.dir) ? args.dir : B.facingSide(o.yaw);
    const plan = B.bridgePlan({ start: o.position.floored(), side, getBlock: (x, y, z) => s.bot.blockAt(new Vec3(x, y, z)), cap: Math.min(B.CAPS.bridge, args.len || B.CAPS.bridge), block: args.block || null });
    if (plan.noGap) throw new Nope("there's nothing to bridge in front of the player");
    if (!plan.reachesLand) this.h.progress(`the other side is more than ${plan.length} blocks out; going as far as that`);
    const bot = s.bot;
    bot.setControlState('sneak', true);
    try { await this.h.builder.run(s, plan, { label: 'bridge' }); } finally { bot.setControlState('sneak', false); }
    return plan.reachesLand ? `built a ${plan.length} block bridge to the other side` : `built ${plan.length} blocks of bridge, the other side is further`;
  }

  async doorJob(s) {
    const o = this.owner();
    const t = this.lookBlock(o, { range: 16, liquids: false });
    if (!t) throw new Nope('the player is not pointing at a wall');
    const plan = B.doorPlan({ hit: new Vec3(t.x, t.y, t.z), face: t.face, footY: o ? Math.floor(o.position.y) : null, getBlock: (x, y, z) => s.bot.blockAt(new Vec3(x, y, z)) });
    if (plan.notWall) throw new Nope('the player is not pointing at the side of a wall');
    for (const c of plan.cells) if (c.part === 'gap') c.force = true;
    const r = await this.h.builder.run(s, plan, { label: 'door' });
    if (!s.bot.blockAt(new Vec3(plan.anchor.x, plan.anchor.y, plan.anchor.z))?.name.endsWith('_door')) return r.missing ? 'made the doorway, no wood for a door though' : 'made the doorway';
    return 'put a door in';
  }

  async sealJob(s, args) {
    const o = this.owner();
    if (!o) throw new Nope('the player is not in sight');
    const getBlock = (x, y, z) => s.bot.blockAt(new Vec3(x, y, z));
    const view = viewDir(o.yaw, o.pitch || 0);

    const roofed = (x, y, z) => { for (let dy = 1; dy <= 4; dy++) if (B.info(getBlock(x, y + dy, z)).solid) return true; return false; };
    const eye = o.position.offset(0, 1.62, 0);
    const far = (x, y, z) => Math.hypot(x + 0.5 - eye.x, y + 0.5 - eye.y, z + 0.5 - eye.z) > 2.5;
    const t = raycast(eye, view, 32, getBlock, (b, x, y, z) => { const i = B.info(b); return i.solid || i.liquid || ((i.air || i.plant) && far(x, y, z) && roofed(x, y, z)); });
    if (!t) throw new Nope('the player is not pointing at a cave');
    const start = B.info(t.block).solid || B.info(t.block).liquid ? new Vec3(t.prev.x, t.prev.y, t.prev.z) : new Vec3(t.x, t.y, t.z);
    const plan = B.sealPlan({ start, getBlock, view, block: args.block || null });
    if (plan.tooBig) throw new Nope('that opening is too big to seal');
    if (!plan.cells.length) throw new Nope('there is no opening there');
    const r = await this.h.builder.run(s, plan, { label: 'sealing it' });
    const left = plan.cells.filter((c) => !this.h.builder.isDone(s, c)).length;
    if (left) throw new Nope(`couldn't close ${left} of the gaps`);
    return `sealed it, ${r.placed} blocks`;
  }

  async farmJob(s, args) {
    const o = this.owner();
    if (!o) throw new Nope('the player is not in sight');
    const size = Math.max(3, Math.min(9, args.w || 9));
    const sp = args.where === 'there' ? this.spot('there') : null;
    const side = B.facingSide(o.yaw);
    const st = sideStep(side);
    const f = o.position.floored();
    const c = sp && !sp.ask ? sp.prev : new Vec3(f.x + st.x * (Math.floor(size / 2) + 2), f.y, f.z + st.z * (Math.floor(size / 2) + 2));
    if (!s.count('water_bucket')) {
      this.h.progress('need a water bucket for the middle first');
      await this.waterBucketJob(s, { give: false });
    }
    if (!s.find(/_hoe$/)) await this.h.fetcher.craft(s, 'wooden_hoe', 1, 1);
    if (s.count('wheat_seeds') < size * size - 1) await this.h.fetcher.get(s, 'wheat_seeds', Math.min(size * size - 1, 40), { depth: 1, quiet: true }).catch((e) => { if (e.cancelled) throw e; });
    const back = { north: 'south', south: 'north', east: 'west', west: 'east' }[side];
    const plan = B.farmPlan({ cx: c.x, y0: c.y, cz: c.z, size, gate: back });
    if (s.count(/_fence$/) < 4 * size) {
      try { const need = 4 * size + 4 - s.count(/_fence$/); if (s.count(PLANKS_RE) >= Math.ceil(need / 3) * 4 + 2) await this.h.fetcher.craft(s, 'oak_fence', need, 1); } catch (e) { if (e.cancelled) throw e; }
    }
    const r = await this.h.builder.run(s, plan, { label: 'farm', fetch: false });
    const planted = s.bot ? plan.cells.filter((x) => x.op === 'plant' && this.h.builder.isDone(s, x)).length : 0;
    const water = this.h.builder.isDone(s, plan.cells[0]);
    if (!water) throw new Nope("couldn't get the water in the middle");
    return `made a ${size}x${size} farm, ${planted ? `${planted} planted` : 'no seeds to plant yet'}${s.count(/_fence$/) ? '' : ', no fence yet'}`;
  }

  async helpBuildJob(s) {
    const recent = this.h.playerBlocks.filter((b) => Date.now() - b.at < 10 * 60 * 1000);
    if (recent.length < 3) throw new Nope('the player has placed fewer than 3 blocks in the last 10 minutes');
    const plan = B.helpPlan({ recent, getBlock: (x, y, z) => s.bot.blockAt(new Vec3(x, y, z)) });
    const name = recent[recent.length - 1].name;
    if (!plan) {

      this.h.progress(`the shape of the player's build is unclear; getting the player more ${itemLabel(name)}`, { force: true });
      await this.h.fetcher.get(s, name, 32, { give: true });
      return `brought the player more ${itemLabel(name)}`;
    }
    this.h.progress(`plan: ${plan.say}`, { force: true });
    await s.wait(2500);
    if (s.count(name) < plan.cells.length) await this.h.fetcher.get(s, name, plan.cells.length, { quiet: true }).catch((e) => { if (e.cancelled) throw e; });
    const r = await this.h.builder.run(s, { ...plan, label: "the player's build", bounds: B.boundsOf(plan.cells) }, { label: "the player's build", fetch: false, say: false });
    if (!r.placed) throw new Nope(`ran out of ${itemLabel(name)}`);
    return `${plan.say.replace(/^/, 'done: ')}${r.missing ? `, ran out of ${itemLabel(name)} for ${r.missing}` : ''}`;
  }

  async undoJob(s) {
    const r = await this.h.builder.undo(s);
    return `took back the ${r.label}: removed ${r.removed}${r.restored ? `, put back ${r.restored}` : ''}`;
  }

  pickOwnJob(s, recent = []) {
    const opts = [];
    if (s.bestTier('pickaxe') < 1) opts.push({ name: 'make_tools', label: 'make some tools', run: (sk) => sk.ensurePickaxe(1).then(() => 'made a stone pickaxe') });
    if (s.count(LOG_RE) + s.count(PLANKS_RE) / 4 < 8) opts.push({ name: 'gather_wood', label: 'chop some wood', run: (sk) => sk.getLogs(8).then((n) => `${n} logs`) });
    if (!s.count(/^(coal|charcoal)$/) && s.count('torch') < 8) opts.push({ name: 'mine_coal', label: 'find some coal', run: (sk) => sk.mineOre('coal', 4, { maxMs: 3 * 60 * 1000 }) });
    if (s.count('iron_ingot') + s.count('raw_iron') < 6 && s.bestTier('pickaxe') >= 1) opts.push({ name: 'mine_iron', label: 'look for iron', run: (sk) => sk.mineOre('iron', 3, { maxMs: 4 * 60 * 1000 }) });
    opts.push({ name: 'explore', label: 'look around', run: (sk) => sk.explore() });
    return opts.find((o) => !recent.includes(o.name)) || opts[opts.length - 1];
  }

  async ownThingJob(s, args) {
    const mins = Math.max(1, Math.min(20, args.mins || 8));
    const end = Date.now() + mins * 60 * 1000;
    const did = [], recent = [];
    let lastCheck = Date.now();
    while (Date.now() < end && did.length < 6) {
      s.check();
      const pick = this.pickOwnJob(s, recent.slice(-2));
      recent.push(pick.name);
      this.h.progress(`going to ${pick.label}`);
      try { const r = await pick.run(s); if (r) did.push(String(r)); } catch (err) { if (err.cancelled) throw err; }
      if (Date.now() - lastCheck > 3 * 60 * 1000 && Date.now() < end) { lastCheck = Date.now(); this.h.progress(`checking in: ${did.slice(-2).join(', ') || 'nothing yet'}`, { force: true }); }
    }
    await s.backToPlayer({ timeout: 90000 });
    return did.length ? `did your own thing: ${did.join(', ')}` : 'wandered around and finished nothing';
  }

  async planJob(s, args) {
    const steps = (args.steps || []).slice(0, 3);
    if (steps.length < 2) throw new Nope('the player did not give at least 2 steps');
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      s.check();
      const name = steps[i];
      const run = this.h.jobRunner(name);
      if (!run) { results.push(`skipped ${name.replace(/_/g, ' ')}`); continue; }
      if (i > 0) this.h.progress(`step ${i} done (${results[i - 1]}), now ${this.h.labelOf(name)}`, { force: true });
      try { results.push(String(await run(s, {}) || 'done')); } catch (err) {
        if (err.cancelled) throw err;
        results.push(`${this.h.labelOf(name)} didn't work out (${err.message})`);
      }
    }
    return results.join(', then ');
  }

  async detourJob(s, args) {
    const b = args.block;
    if (!b) throw new Nope('nothing to grab');
    await s.collect([b.name], 1, { maxDistance: 16, where: (x) => x.position.equals(b.position) }).catch((e) => { if (e.cancelled) throw e; });
    await s.backToPlayer({ timeout: 30000 });
    return `grabbed the ${b.name.replace(/^deepslate_|_ore$/g, '').replace(/_/g, ' ')}`;
  }
}

function matchesPlanned(plan, x, y, z, b) {
  const c = plan.cells.find((q) => q.x === x && q.y === y && q.z === z);
  return !!(c && c.block && B.matchesAny(b.name, c.block));
}

module.exports = { Commands, Walker, viewDir, raycast, lookEntity, stopsLook, isProtectedMob, isHostileMob, isNamed, ripe, sideStep, PROTECTED_MOBS, CROPS };
