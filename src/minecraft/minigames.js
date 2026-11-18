// Little games with the player: a race, a timed gather, and a friendly spar (fists, first to 3 hearts, never near dying).
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { Nope, LOG_RE, sleep } = require('./skills');

const { GoalNear, GoalFollow } = goals;
const GAMES = ['race', 'timed_gather', 'spar'];
const MAX_SWINGS = 12;
const ASK = { race: 'the player has not agreed to the race yet', timed_gather: 'the player has not agreed to the two minute gathering race yet', spar: 'the player has not agreed to the spar yet (fists, first to 3 hearts)' };

function raceResult(winner, gap) {
  const by = gap < 1.5 ? 'by under 2 blocks' : gap < 4 ? 'by under 4 blocks' : `by about ${Math.round(gap)} blocks`;
  if (winner === 'tie') return 'it was a tie';
  return winner === 'player' ? `the player won ${by}` : `you won ${by}`;
}

function handicap(rand = Math.random) {
  return { reactMs: 350 + Math.round(rand() * 350), walkShare: 0.2 + rand() * 0.3, stumble: rand() < 0.35, stumbleAt: 0.4 + rand() * 0.3 };
}

function sparScore(mine, theirs) {
  const h = (n) => n / 2;
  return { me: h(mine), you: h(theirs), over: mine >= 6 || theirs >= 6, text: `the player has hit you for ${h(theirs)} hearts, you have hit the player for ${h(mine)} hearts (first to 3)` };
}

class MiniGames {
  constructor(hands) {
    this.h = hands;
    this.active = null;
    this.pending = null;
    this.idea = null;
    this.ideaKeys = [];
    this.lastIdeaCheck = 0;
  }
  get c() { return this.h.c; }

  command(name, args) {
    const now = Date.now();
    const agreed = args.agreed || (this.pending && this.pending.name === name && now - this.pending.at < 90000);
    if (!agreed) {
      this.pending = { name, at: now };
      return { ok: false, reason: 'ask_first', ask: ASK[name] };
    }
    this.pending = null;
    this.idea = null;
    return this.h.job(name, args);
  }

  async countdown(s, what) {
    this.h.progress(`${what}, on three`, { force: true });
    await s.wait(1800);

    const blank = true;
    for (const n of ['3', '2', '1', 'go!']) { if (!blank) this.c.say(n); if (n !== 'go!') await s.wait(900); }
  }

  look(target) {
    const m = this.c.v12 && this.c.v12.motor;
    if (m && this.c.f('humanizer') && typeof m.lookAt === 'function') { try { return Promise.resolve(m.lookAt(target)).catch(() => {}); } catch {} }
    return this.c.bot.lookAt(target).catch(() => {});
  }

  swing(entity) {
    const m = this.c.v12 && this.c.v12.motor;
    if (m && this.c.f('humanizer') && typeof m.attack === 'function') { try { return m.attack(entity); } catch {} }
    try { this.c.bot.attack(entity); } catch {}
    return null;
  }

  async raceJob(s) {
    const bot = s.bot;
    const o = this.c.ownerEntity();
    if (!o) throw new Nope('the player is not in sight');
    const t = this.h.cmd.lookBlock(o, { range: 80 });
    if (!t) throw new Nope('the player is not pointing at a spot to race to');
    const goal = new Vec3(t.prev.x, t.prev.y, t.prev.z);
    const dist = o.position.distanceTo(goal);
    if (dist < 8) throw new Nope('that spot is under 8 blocks away, too close to race to');

    await s.gotoNear(o.position, 1.5, { dig: false, timeout: 15000 }).catch((e) => { if (e.cancelled) throw e; });
    const hc = handicap();
    this.active = { name: 'race', goal, started: 0 };
    try {
      await this.countdown(s, 'race to that spot');
      await s.wait(hc.reactMs);
      const start = bot.entity.position.clone();
      const total = Math.max(1, start.distanceTo(goal));
      const moves = this.h.cmd.walkMoves();
      moves.allowSprinting = false;
      bot.pathfinder.setMovements(moves);
      bot.pathfinder.setGoal(new GoalNear(goal.x, goal.y, goal.z, 1));
      let sprinting = false, stumbled = false, winner = null, gap = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        s.check();
        await sleep(100);
        const ow = this.c.ownerEntity();
        const me = bot.entity.position;
        const done = (p) => Math.hypot(p.x - (goal.x + 0.5), p.z - (goal.z + 0.5)) <= 1.8 && Math.abs(p.y - goal.y) <= 2.5;
        const meDone = done(me), youDone = ow && done(ow.position);
        if (meDone || youDone) {
          winner = meDone && youDone ? 'tie' : meDone ? 'me' : 'player';
          const other = meDone ? ow?.position : me;
          gap = other ? Math.max(0, Math.hypot(other.x - goal.x, other.z - goal.z) - 1.5) : 0;
          if (gap < 0.6 && winner !== 'tie') winner = 'tie';
          break;
        }
        const share = 1 - me.distanceTo(goal) / total;
        if (!sprinting && share >= hc.walkShare) {
          sprinting = true;
          const m2 = this.h.cmd.walkMoves(); m2.allowSprinting = true;
          bot.pathfinder.setMovements(m2);
        }
        if (hc.stumble && !stumbled && share >= hc.stumbleAt) {
          stumbled = true;
          bot.pathfinder.setGoal(null);
          await sleep(350 + Math.random() * 250);
          bot.pathfinder.setGoal(new GoalNear(goal.x, goal.y, goal.z, 1));
        }
      }
      bot.pathfinder.setGoal(null);
      if (!winner) return 'nobody made it, race called off';
      return raceResult(winner, gap);
    } finally {
      this.active = null;
      if (this.c.moves) bot.pathfinder.setMovements(this.c.moves);
    }
  }

  async gatherJob(s, args) {
    const bot = s.bot;
    const item = args.item || 'log';
    const mins = Math.max(1, Math.min(5, args.mins || 2));
    const names = item === 'log' || LOG_RE.test(item) ? Object.keys(s.data.blocksByName).filter((x) => (item === 'log' ? LOG_RE.test(x) : x === item)) : item === 'cobblestone' ? ['stone', 'cobblestone'] : item === 'dirt' ? ['dirt', 'grass_block'] : [item];
    const counts = (n) => (item === 'log' ? LOG_RE.test(n) : item === 'cobblestone' ? n === 'cobblestone' : item === 'dirt' ? n === 'dirt' : n === item);
    const mine0 = s.items().filter((i) => counts(i.name)).reduce((a, i) => a + i.count, 0);
    const [first] = this.h.fetcher.visible(s, names, { maxDistance: 48, count: 1, common: true });
    if (!first) throw new Nope(`no ${item === 'log' ? 'trees' : item.replace(/_/g, ' ')} around to race for`);
    this.active = { name: 'timed_gather', item, theirs: 0, broken: 0, counts, names };
    try {
      await this.countdown(s, `most ${item === 'log' ? 'logs' : item.replace(/_/g, ' ')} in ${mins} minute${mins > 1 ? 's' : ''}`);
      const end = Date.now() + mins * 60 * 1000;
      let saidHalf = false;
      while (Date.now() < end) {
        s.check();
        const [b] = this.h.fetcher.visible(s, names, { maxDistance: 48, count: 1, common: true });
        if (!b) { await s.wait(500); continue; }
        bot.pathfinder.setMovements(s.workMoves());
        const left = end - Date.now();
        try { await Promise.race([bot.collectBlock.collect(b, { ignoreNoPath: true }), sleep(Math.min(30000, left)).then(() => { throw new Error('time'); })]); } catch (err) {
          s.check();
          try { bot.collectBlock.cancelTask?.(); } catch {}
        }
        if (!saidHalf && Date.now() > end - mins * 30000) { saidHalf = true; this.h.progress('half the time is gone', { force: true }); }
      }
      try { bot.collectBlock.cancelTask?.(); } catch {}
      bot.pathfinder.setGoal(null);
      if (!true) this.c.say('time!');
      const mine = s.items().filter((i) => counts(i.name)).reduce((a, i) => a + i.count, 0) - mine0;
      const theirs = Math.max(this.active.theirs, this.active.broken);
      const word = item === 'log' ? 'logs' : item.replace(/_/g, ' ');
      return `time is up: you got ${mine} ${word}, the player got about ${theirs} as far as you saw (${mine > theirs ? 'you have more' : mine < theirs ? 'the player has more' : 'a tie'})`;
    } finally { this.active = null; }
  }

  onCollect(collector, item) {
    const a = this.active;
    if (!a || a.name !== 'timed_gather' || !item) return;
    const o = this.c.ownerEntity();
    if (o && collector === o && a.counts(item.name)) a.theirs += item.count || 1;
  }
  onBlockGone(oldBlock, pos) {
    const a = this.active;
    if (!a || a.name !== 'timed_gather' || !oldBlock || !a.names.includes(oldBlock.name)) return;
    const o = this.c.ownerEntity(), bot = this.c.bot;
    if (!o || !bot?.entity) return;
    const dO = o.position.distanceTo(pos), dB = bot.entity.position.distanceTo(pos);
    if (dO <= 5.5 && dO < dB) a.broken++;
  }

  async sparJob(s) {
    const bot = s.bot;
    const o0 = this.c.ownerEntity();
    if (!o0) throw new Nope('the player is not in sight');
    if (bot.health < 14) throw new Nope('your health is too low to spar');
    if (this.c.hostiles(16).length) throw new Nope('not with mobs around');
    await bot.unequip('hand').catch(() => {});
    await s.gotoNear(o0.position, 2.5, { dig: false, timeout: 15000 }).catch((e) => { if (e.cancelled) throw e; });
    this.active = { name: 'spar', mine: 0, theirs: 0, lastSwingAt: 0, swings: 0, hpStart: bot.health };
    let reason = null;
    try {
      await this.countdown(s, 'first to 3 hearts, fists only');
      const t0 = Date.now();
      let next = Date.now() + 500;
      while (Date.now() - t0 < 120000) {
        s.check();
        await sleep(100);
        const a = this.active;
        const o = this.c.ownerEntity();
        if (!o) { reason = 'the player ran off'; break; }
        if (this.c.hostiles(10).length) { reason = 'a mob showed up'; break; }
        if (bot.health <= 8) { reason = 'your health got low'; break; }
        if (sparScore(a.mine, a.theirs).over) break;

        if (a.swings >= MAX_SWINGS) { reason = 'the swing limit was reached'; break; }
        const hp = typeof o.health === 'number' ? o.health : typeof o.metadata?.[9] === 'number' ? o.metadata[9] : null;
        if (hp != null && hp <= 10) { reason = "the player's health got low"; break; }
        const d = o.position.distanceTo(bot.entity.position);
        if (d > 12) { reason = 'the player ran off'; break; }
        if (d > 2.8) { if (!bot.pathfinder.goal) bot.pathfinder.setGoal(new GoalFollow(o, 2), true); }
        else if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
        await this.look(o.position.offset(0, 1.5, 0));
        if (d <= 3.1 && Date.now() >= next) {
          next = Date.now() + 650 + Math.random() * 450;
          if (Math.random() < 0.25) { try { bot.swingArm(); } catch {} }
          else { a.lastSwingAt = Date.now(); a.swings++; this.swing(o); }
        }
      }
      bot.pathfinder.setGoal(null);
      const sc = sparScore(this.active.mine, this.active.theirs);
      if (reason && !sc.over) return `spar stopped (${reason}), ${sc.text}`;
      return sc.you > sc.me ? `the player won the spar, ${sc.text}` : sc.me > sc.you ? `you won the spar, ${sc.text}` : `spar ended even, ${sc.text}`;
    } finally {
      this.active = null;
      this.c.equipBestWeapon();
    }
  }

  onHurt(entity) {
    const a = this.active;
    if (!a || a.name !== 'spar') return;
    const bot = this.c.bot, o = this.c.ownerEntity();
    if (o && entity === o && Date.now() - a.lastSwingAt < 600) a.mine++;
    else if (entity === bot.entity && o && o.position.distanceTo(bot.entity.position) < 4.5 && Date.now() - this.h.cmd.ownerSwingAt < 600) a.theirs++;
  }

  tick(now) {
    if (this.idea && now > this.idea.until) this.idea = null;
    if (this.active || this.idea || now - this.lastIdeaCheck < 5000) return;
    this.lastIdeaCheck = now;
    const c = this.c, bot = c.bot;
    if (!bot?.entity || c.task || c.busy || c.mode !== 'follow' || c.diedAt || c.isNight()) return;
    if (now - Math.max(c.lastCommandAt || 0, c.lastTaskEnd || 0) < 2 * 60 * 1000) return;
    if (now - (this.h.spawnedAt || now) < 5 * 60 * 1000) return;
    const o = c.ownerEntity();
    if (!o || o.position.distanceTo(bot.entity.position) > 10 || c.hostiles(20).length) return;
    if (!this.h.ledger.allow('gameOffer', 'any', now)) return;
    const ideas = [];
    const tree = this.h.fetcher.visible(c.skills, Object.keys(c.skills.data.blocksByName).filter((x) => LOG_RE.test(x)), { maxDistance: 40, count: 1, common: true })[0];
    if (tree && tree.position.distanceTo(o.position) > 12) ideas.push('a race to the tree over there');
    if (tree) ideas.push('who gets more logs in 2 minutes');
    if (bot.health >= 18) ideas.push('a spar, fists only, first to 3 hearts');
    if (!ideas.length) return;
    const pick = this.h.ledger.pickLru('gameIdea', ideas, (x) => x, now);
    this.h.ledger.use('gameOffer', 'any', now);
    this.idea = { text: pick, until: now + 3 * 60 * 1000 };
  }

  stateLine() {
    const a = this.active;
    if (a && a.name === 'spar') return `spar going, ${sparScore(a.mine, a.theirs).text}`;
    if (a && a.name === 'timed_gather') return 'timed gather going';
    if (a && a.name === 'race') return 'racing the player';
    return null;
  }

  stop() { this.active = null; this.pending = null; }
}

module.exports = { MiniGames, raceResult, handicap, sparScore, GAMES, ASK };
