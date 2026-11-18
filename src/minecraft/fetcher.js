// Gets an item the way a survival player would (chop, dig, mine, smelt, craft, hunt, shear), gets the missing amount,
// and hands it over. Only goes for blocks the companion could have seen.
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { Nope, ORES, LOG_RE, PLANKS_RE, RAW_FOOD, PASSIVE_FOOD, PROTECTED_RE, sleep } = require('./skills');
const spec = require('./commandspec');

const { GoalXZ } = goals;

const DIG = {
  cobblestone: { blocks: ['stone', 'cobblestone'], tier: 0, common: true },
  cobbled_deepslate: { blocks: ['deepslate', 'cobbled_deepslate'], tier: 0, common: true },
  dirt: { blocks: ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt'], common: true },
  sand: { blocks: ['sand'] }, red_sand: { blocks: ['red_sand'] }, gravel: { blocks: ['gravel'] }, flint: { blocks: ['gravel'] },
  clay_ball: { blocks: ['clay'], per: 4 }, clay: { blocks: ['clay'] }, snowball: { blocks: ['snow_block', 'snow'] },
  andesite: { blocks: ['andesite'], tier: 0, common: true }, diorite: { blocks: ['diorite'], tier: 0, common: true }, granite: { blocks: ['granite'], tier: 0, common: true },
  netherrack: { blocks: ['netherrack'], tier: 0, common: true }, ice: { blocks: ['ice'] },
  wheat_seeds: { blocks: ['short_grass', 'grass', 'tall_grass', 'fern'], common: true, chance: true },
  sugar_cane: { blocks: ['sugar_cane'] }, pumpkin: { blocks: ['pumpkin'] }, melon_slice: { blocks: ['melon'], per: 3 },
  raw_copper: { blocks: ['copper_ore', 'deepslate_copper_ore'], tier: 1 }, redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], tier: 2, per: 4 },
  lapis_lazuli: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], tier: 1, per: 4 }, emerald: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], tier: 2 }
};

const MINE = { coal: 'coal', raw_iron: 'iron', raw_gold: 'gold', diamond: 'diamond' };

const SMELT = { iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone', smooth_stone: 'stone', charcoal: 'log', brick: 'clay_ball' };
for (const [raw, cooked] of Object.entries(RAW_FOOD)) SMELT[cooked] = raw;
const FOOD_RE = /^(cooked_|bread$|baked_potato$|apple$|golden_carrot$|carrot$|melon_slice$|sweet_berries$|pumpkin_pie$|cookie$|beetroot$|mushroom_stew$)/;
const SAPLING = (log) => log.replace(/_(log|stem)$/, '_sapling');

const LONG = new Set(['diamond', 'raw_iron', 'iron_ingot', 'raw_gold', 'gold_ingot', 'coal', 'emerald', 'redstone', 'lapis_lazuli']);

const label = (name) => (name === 'log' ? 'logs' : name === 'planks' ? 'planks' : name.replace(/_/g, ' '));

const MASS = /(cobblestone|dirt|sand|gravel|planks|wool|coal|glass|stone|deepslate|netherrack|clay|redstone|lapis lazuli|food|wheat|string|leather|iron|gold|copper|logs|seeds|bricks|beef|mutton|chicken|cod|salmon|bread|meat|rabbit)$/;

function oneOf(name) {
  const base = label(name);
  return MASS.test(base) || /s$/.test(base) ? `some ${base}` : `${/^[aeiou]/.test(base) ? 'an' : 'a'} ${base}`;
}
function amount(n, name) {
  const base = label(name);
  if (n === 1 || MASS.test(base) || /s$/.test(base)) return `${n} ${base}`;
  return /(sh|ch|x)$/.test(base) ? `${n} ${base}es` : /[^aeiou]y$/.test(base) ? `${n} ${base.slice(0, -1)}ies` : `${n} ${base}s`;
}

function sourceOf(name, d = spec.mcData()) {
  if (!name) return { how: 'unknown' };
  if (name === 'log' || LOG_RE.test(name)) return { how: 'chop', logs: name === 'log' ? null : [name] };
  if (name === 'planks') return { how: 'planks' };
  if (/_planks$/.test(name)) return { how: 'planks', log: name.replace(/_planks$/, /^(crimson|warped)/.test(name) ? '_stem' : '_log') };
  if (name === 'food') return { how: 'food' };
  if (name === 'wool' || /_wool$/.test(name)) return { how: 'shear' };
  if (MINE[name]) return { how: 'mine', ore: MINE[name] };
  if (DIG[name]) return { how: 'dig', ...DIG[name] };
  if (SMELT[name]) return { how: 'smelt', input: SMELT[name] };
  if (['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'leather', 'feather'].includes(name)) return { how: 'hunt' };
  if (['pickaxe', 'sword', 'axe', 'shovel', 'hoe'].includes(name)) return { how: 'tool', kind: name };
  if (name === 'bed') return { how: 'craft', item: 'white_bed' };
  if (name === 'water_bucket') return { how: 'water' };
  const it = d && d.itemsByName[name];
  if (it && d.recipes && d.recipes[it.id]) return { how: 'craft', item: name };
  return { how: 'unknown' };
}

function craftNeeds(name, have = {}, d = spec.mcData()) {
  const it = d && d.itemsByName[name];
  const list = it && d.recipes && d.recipes[it.id];
  if (!list || !list.length) return null;
  let best = null;
  for (const r of list) {
    const ids = (r.inShape ? r.inShape.flat() : r.ingredients || []).filter((x) => x != null).map((x) => (typeof x === 'object' ? (x.id ?? x[0]) : x));
    const counts = {};
    for (const id of ids) { const n = d.items[id] && spec.groupName(d.items[id].name); if (n) counts[n] = (counts[n] || 0) + 1; }
    const missing = Object.entries(counts).reduce((s, [g, c]) => s + Math.max(0, c - (have[g] || 0)), 0);
    const rare = Object.keys(counts).some((g) => /deepslate|blackstone|bamboo|crimson|warped|copper|netherite/.test(g)) ? 100 : 0;
    const score = missing + rare;
    if (!best || score < best.score) best = { counts, makes: (r.result && r.result.count) || 1, score };
  }
  return best && { counts: best.counts, makes: best.makes };
}

function chooseFood({ cooked = 0, raw = 0, wheat = 0, ripe = 0, animals = 0 } = {}) {
  if (cooked >= 2) return { job: 'give', why: 'already have food' };
  if (raw >= 1) return { job: 'cook', why: 'have raw meat to cook' };
  if (wheat >= 3) return { job: 'bread', why: 'have wheat for bread' };
  if (ripe >= 3) return { job: 'harvest', why: 'crops are ready' };
  if (animals >= 1) return { job: 'hunt', why: 'animals nearby' };
  if (cooked >= 1) return { job: 'give', why: 'have a bit of food' };
  return { job: 'hunt_far', why: 'nothing around, going to look for animals' };
}

class Fetcher {
  constructor(hands) { this.h = hands; }
  get c() { return this.h.c; }

  visible(s, names, { maxDistance = 48, count = 1, where = null, common = false } = {}) {
    const p = this.c.v12 && this.c.v12.perception;
    const per = p && this.c.f('perception');
    const zone = (b) => !this.h.noDig(b.position) && !(this.c.f('bodyCoach') && PROTECTED_RE.test(b.name)) && !(typeof s.underPlayer === 'function' && s.underPlayer(b.position));
    if (per && typeof p.visibleBlocks === 'function') {
      try {
        const got = p.visibleBlocks(names, { maxDistance, count: count * 4 }) || [];
        const blocks = got.map((x) => (x && x.position ? x : s.bot.blockAt(x))).filter(Boolean);
        return blocks.filter((b) => zone(b) && (!where || where(b))).slice(0, count);
      } catch {}
    }
    if (per && typeof p.knows === 'function' && !common) {
      return s.findBlocks(names, { maxDistance, count, where: (b) => zone(b) && (!where || where(b)) && p.knows(b) });
    }
    return s.findBlocks(names, { maxDistance, count, where: (b) => zone(b) && (common || s.exposed(b)) && (!where || where(b)) });
  }

  async wander(s, why) {
    const bot = s.bot;
    const a = Math.random() * Math.PI * 2, dist = 30 + Math.random() * 20;
    const p = bot.entity.position;
    if (why) this.h.progress(why);
    await s.goto(new GoalXZ(Math.round(p.x + Math.cos(a) * dist), Math.round(p.z + Math.sin(a) * dist)), { dig: false, timeout: 40000 }).catch((e) => { if (e.cancelled) throw e; });
  }

  async breakUntil(s, names, countFn, target, { common = false, maxMs = 8 * 60 * 1000, what = 'that', stumps = null, half = null } = {}) {
    const bot = s.bot;
    const t0 = Date.now();
    let misses = 0, wanders = 0, saidHalf = false;
    const coached = this.c.f('bodyCoach'), failed = new Set();
    const key = (x) => `${x.position.x},${x.position.y},${x.position.z}`;
    const badTrees = [];
    this.reachMisses = 0;
    while (countFn() < target && misses < (coached ? 6 : 4) && Date.now() - t0 < maxMs) {
      s.check();

      const reach = this.c.f('bodyReach') && typeof s.pickReachable === 'function' && names.every((n) => LOG_RE.test(n));
      const offTree = (x) => !badTrees.some((m) => Math.abs(m.x - x.position.x) <= 2 && Math.abs(m.z - x.position.z) <= 2 && x.position.y >= m.y - 1);
      const [b] = reach
        ? [s.pickReachable(this.visible(s, names, { maxDistance: 64, count: 16, common, where: (x) => (!coached || !failed.has(key(x))) && offTree(x) }))].filter(Boolean)
        : this.visible(s, names, { maxDistance: 64, count: 1, common, where: coached ? (x) => !failed.has(key(x)) : null });
      if (!b) {
        if (wanders >= 2) break;
        wanders++;
        await this.wander(s, wanders === 1 ? `no ${what} right here, looking around` : null);
        continue;
      }
      const below = bot.blockAt(b.position.offset(0, -1, 0));
      if (stumps && below && /dirt|grass_block|podzol/.test(below.name)) stumps.push(b.position.clone());
      bot.pathfinder.setMovements(s.workMoves());
      const before = countFn();
      const from = bot.entity.position.clone();
      try {
        await Promise.race([bot.collectBlock.collect(b, { ignoreNoPath: true }), sleep(45000).then(() => { throw new Nope('took too long'); })]);
      } catch (err) {
        s.check();
        try { bot.collectBlock.cancelTask?.(); } catch {}
      }
      await s.wait(150);

      if (countFn() <= before && this.c.f('bodyLeaves') && typeof s.clearLeavesAround === 'function' && bot.entity.position.distanceTo(from) < 1) {
        const spot = String(bot.entity.position.floored());
        this._leafSpots = this._leafSpots || new Set();
        if (!this._leafSpots.has(spot)) { this._leafSpots.add(spot); if (await s.clearLeavesAround()) { if (coached) failed.delete(key(b)); continue; } }
      }
      if (countFn() > before) misses = 0; else { misses++; if (coached) failed.add(key(b)); if (LOG_RE.test(b.name)) { badTrees.push({ x: b.position.x, y: b.position.y, z: b.position.z }); this.reachMisses++; } }
      if (half && !saidHalf && countFn() >= target / 2 && target >= 16) { saidHalf = true; this.h.progress(half(countFn())); }
    }
    return countFn();
  }

  async get(s, want, n, { give = false, depth = 0, quiet = false } = {}) {
    s.check();
    if (depth > 4) throw new Nope(`that's too many steps to make ${label(want)}`);
    const count = () => this.countOf(s, want);
    const target = Math.max(1, Math.min(640, Math.round(n || 1)));
    if (count() >= target) { if (give) await this.handOver(s, want, target); return count(); }
    const src = sourceOf(want);
    const need = target - count();
    if (!quiet && depth > 0 && LONG.has(want)) this.h.progress(`need ${need} ${label(want)} first, going to get some`);
    switch (src.how) {
      case 'chop': await this.chop(s, src.logs, target, count); break;
      case 'planks': {
        const logs = Math.ceil(need / 4);
        if (src.log) {
          if (s.count(src.log) < logs) await this.chop(s, [src.log], logs, () => s.count(src.log));
          let guard = 0;
          while (s.count(want) < target && s.count(src.log) && guard++ < 40) await s.craft(want, Math.min(s.count(src.log), Math.ceil((target - s.count(want)) / 4)));
        } else {
          if (this.countOf(s, 'log') < logs) await this.chop(s, null, logs);
          await this.logsToPlanks(s, target);
        }
        break;
      }
      case 'dig': {
        if (src.tier != null) await s.ensurePickaxe(src.tier);
        const per = src.per || 1;
        const goal = this.countOf(s, want) + Math.ceil(need / per) * per;
        await this.breakUntil(s, src.blocks, count, Math.min(target, goal), { common: !!src.common, what: label(want), half: (k) => `got ${k} ${label(want)} so far` });
        break;
      }
      case 'mine': {
        const before = count();
        await s.mineOre(src.ore, need, { comeBack: false }).catch((e) => { if (e.cancelled || count() === before) throw e; });
        break;
      }
      case 'smelt': {
        const input = src.input;
        const have = this.countOf(s, input);
        if (have < need) await this.get(s, input, need, { depth: depth + 1 });
        const real = input === 'log' ? (s.find(LOG_RE) || {}).name : input;
        if (!real) throw new Nope(`no ${label(input)} to smelt`);
        await s.smelt(real, Math.min(need, s.count(real)));
        break;
      }
      case 'craft': await this.craft(s, src.item, target, depth); break;
      case 'tool': await this.craft(s, this.bestTool(s, src.kind), 1, depth); break;
      case 'food': await this.food(s, target); break;
      case 'hunt': for (let i = 0; i < 4 && count() < target; i++) await s.hunt().catch((e) => { if (e.cancelled) throw e; if (i === 0) throw e; }); break;
      case 'shear': await this.h.cmd.shearJob(s, { n: target }); break;
      case 'water': await this.h.cmd.waterBucketJob(s, { give: false }); break;
      default: throw new Nope(`don't know where to get ${label(want)}`);
    }
    const got = count();
    if (!got) throw new Nope(`couldn't find any ${label(want)}`);
    if (give) await this.handOver(s, want, Math.min(got, target));
    return got;
  }

  countOf(s, want) {
    if (want === 'log') return s.count(LOG_RE);
    if (want === 'planks') return s.count(PLANKS_RE);
    if (want === 'food') return s.items().filter((i) => FOOD_RE.test(i.name)).reduce((a, i) => a + i.count, 0);
    if (want === 'wool') return s.count(/_wool$/);
    if (want === 'coal') return s.count(/^(coal|charcoal)$/);
    if (want === 'bed') return s.count(/_bed$/);
    if (['pickaxe', 'sword', 'axe', 'shovel', 'hoe'].includes(want)) return s.count(new RegExp(`_${want}$`));
    return s.count(want);
  }

  async chop(s, logs, target, count = () => this.countOf(s, 'log')) {
    const all = Object.keys(s.data.blocksByName).filter((x) => LOG_RE.test(x) && !/^(crimson|warped)/.test(x));
    const names = logs && logs.length ? logs : all;
    const stumps = [];
    const what = logs && logs.length === 1 ? label(logs[0]).replace(/ log$/, '') + ' trees' : 'trees';
    const got = await this.breakUntil(s, names, count, target, { common: true, what, stumps, half: (k) => `got ${k} of ${target} logs so far` });

    let planted = 0;
    for (const p of stumps.slice(0, 6)) {
      const sap = s.find(/_sapling$/);
      if (!sap) break;
      const b = s.bot.blockAt(p);
      if (b && !s.isAir(b) && !s.isReplaceable(b)) continue;
      try { await s.placeAt(p, sap.name); planted++; } catch (err) { if (err.cancelled) throw err; }
    }
    this.replanted = planted;
    if (!got && this.c.f('bodyReach') && this.reachMisses > 0) throw new Nope(`couldn't reach any ${what} from the ground here`);
    if (!got) throw new Nope(`no ${what} around here`);
    return got;
  }

  async logsToPlanks(s, target) {
    let guard = 0;
    while (this.countOf(s, 'planks') < target && guard++ < 40) {
      const log = s.find(LOG_RE);
      if (!log) break;
      const times = Math.min(log.count, Math.ceil((target - this.countOf(s, 'planks')) / 4));
      await s.craft(s.plankNameFor(log.name), Math.max(1, times));
    }
  }

  async craft(s, item, n, depth = 0) {
    s.check();
    if (!item) throw new Nope("don't know what to make");
    const have = () => s.count(item);
    if (have() >= n) return have();
    const inv = {};
    for (const i of s.items()) { const g = spec.groupName(i.name); inv[g] = (inv[g] || 0) + i.count; }
    const needs = craftNeeds(item, inv);
    if (!needs) throw new Nope(`can't craft ${label(item)}`);
    const times = Math.ceil((n - have()) / needs.makes);
    if (times > 64) throw new Nope(`that's too many ${label(item)}`);
    for (const [group, c] of Object.entries(needs.counts)) {
      const want = group === 'coal' ? 'coal' : group;
      const total = c * times;
      if (this.countOf(s, want) < total) await this.get(s, want, total, { depth: depth + 1 });
    }

    try { await s.craft(item, times); } catch (err) {
      if (err.cancelled) throw err;
      for (let i = 0; i < times && have() < n; i++) await s.craft(item, 1);
    }
    return have();
  }

  bestTool(s, kind) {
    if (s.count('diamond') >= 3) return `diamond_${kind}`;
    if (s.count('iron_ingot') >= 3 || s.count('raw_iron') >= 3) return `iron_${kind}`;
    return `stone_${kind}`;
  }

  async food(s, target) {
    const cooked = this.countOf(s, 'food');
    const raw = Object.keys(RAW_FOOD).reduce((a, r) => a + s.count(r), 0);
    if (raw && cooked < target) {
      for (const r of Object.keys(RAW_FOOD)) if (s.count(r)) await s.smelt(r, Math.min(s.count(r), 16));
    }
    for (let i = 0; i < 4 && this.countOf(s, 'food') < target; i++) {
      await s.hunt().catch((e) => { if (e.cancelled) throw e; });
      const r2 = Object.keys(RAW_FOOD).find((r) => s.count(r));
      if (r2) await s.smelt(r2, Math.min(s.count(r2), 16)).catch((e) => { if (e.cancelled) throw e; });
    }
  }

  async handOver(s, want, n) {
    if (this.c.f('bodyHandover')) return this.handOverChecked(s, want, n);
    const bot = s.bot;
    const o = s.owner();
    if (!o) throw new Nope("can't see the player to hand it over");
    await s.gotoNear(o.position, 2, { dig: true, timeout: 60000 });
    await bot.lookAt(o.position.offset(0, 1.4, 0)).catch(() => {});
    let left = n;
    const match = (i) => (want === 'log' ? LOG_RE.test(i.name) : want === 'planks' ? PLANKS_RE.test(i.name) : want === 'food' ? FOOD_RE.test(i.name) : want === 'wool' ? /_wool$/.test(i.name) : i.name === want || i.name.endsWith(`_${want}`));
    if (this.c.f('bodyCoach')) await bot.lookAt(o.position.offset(0, 0.2, 0)).catch(() => {});
    for (const it of s.items().filter(match)) {
      if (left <= 0) break;
      const k = Math.min(left, it.count);
      try { await Promise.race([bot.toss(it.type, null, k), sleep(4000).then(() => { throw new Error('toss timed out'); })]); left -= k; } catch {}
      await sleep(120);
    }
    if (this.c.f('bodyCoach')) await s.backOffAfterToss(o);
    return n - left;
  }

  async handOverChecked(s, want, n) {
    const bot = s.bot;
    const o = s.owner();
    if (!o) throw new Nope("can't see the player to hand it over");
    const match = (i) => (want === 'log' ? LOG_RE.test(i.name) : want === 'planks' ? PLANKS_RE.test(i.name) : want === 'food' ? FOOD_RE.test(i.name) : want === 'wool' ? /_wool$/.test(i.name) : i.name === want || i.name.endsWith(`_${want}`));
    const have = () => s.items().filter(match).reduce((a, i) => a + i.count, 0);
    const start = have();
    const pre = typeof s.itemIds === 'function' ? s.itemIds() : null;
    let left = Math.min(n, start);

    const still = () => Math.max(0, Math.min(n, start) - (start - have()));
    for (let attempt = 0; attempt < 2 && (left = still()) > 0; attempt++) {
      s.check();
      await s.gotoNear(o.position, attempt ? 1 : 2, { dig: !attempt, timeout: attempt ? 15000 : 60000 }).catch((e) => { if (e.cancelled || !attempt) throw e; });
      await bot.lookAt(o.position.offset(0, this.c.f('bodyCoach') ? 0.2 : 1.4, 0)).catch(() => {});
      for (const it of s.items().filter(match)) {
        left = still();
        if (left <= 0) break;
        const k = Math.min(left, it.count);
        try {
          await Promise.race([k === it.count ? bot.tossStack(it) : bot.toss(it.type, null, k), sleep(4000).then(() => { throw new Error('toss timed out'); })]);
        } catch (err) { if (s.dbg) s.dbg(`hand-over toss ${it.name} x${k} (try ${attempt + 1}): ${String(err && err.message).slice(0, 100)}`); }
        await sleep(150);
      }
    }
    let tossed = start - have();
    if (this.c.f('bodyCoach')) await s.backOffAfterToss(o);
    else await sleep(1500);

    let onGround = typeof s.waitPickup === 'function' ? await s.waitPickup(o, match, 3000, pre) : {};
    let lying = Object.values(onGround).reduce((a, k) => a + k, 0);

    for (let again = 0; lying > 0 && again < 2 && this.c.f('bodyToss') && typeof s.itemIds === 'function'; again++) {
      s.check();
      const me0 = have();
      const near = Object.values(bot.entities).filter((e) => e && e.name === 'item' && e.position && (!pre || !pre.has(e.id)) && e.position.distanceTo((s.owner() || o).position) <= 6
        && (() => { try { const it = e.getDroppedItem(); return it && match(it); } catch { return false; } })());
      this.c._retossing = true;
      try {
        for (const e of near.slice(0, 6)) {
          s.check();
          if (!bot.entities[e.id]) continue;
          await s.gotoNear(e.position, 0, { dig: false, timeout: 5000 }).catch((err) => { if (err.cancelled) throw err; });
          await sleep(250);
        }
        await sleep(400);
      } finally { this.c._retossing = false; }
      const back = have() - me0;
      if (s.dbg) s.dbg(`bodyToss try ${again + 1}: ${lying} lying, picked ${back} back up`);
      if (back <= 0) break;
      const who = s.owner() || o;
      await s.gotoNear(who.position, 1, { dig: false, timeout: 8000 }).catch((err) => { if (err.cancelled) throw err; });
      const me = bot.entity.position, at = who.position;
      await bot.lookAt(me.offset((at.x - me.x) * 0.55, at.y - me.y + 0.05, (at.z - me.z) * 0.55)).catch(() => {});
      for (const it of s.items().filter(match)) {
        const k = Math.min(it.count, Math.max(0, back - (me0 + back - have())));
        if (k <= 0) break;
        try { await Promise.race([k === it.count ? bot.tossStack(it) : bot.toss(it.type, null, k), sleep(4000).then(() => { throw new Error('toss timed out'); })]); } catch (err) { if (s.dbg) s.dbg(`bodyToss toss: ${String(err && err.message).slice(0, 80)}`); }
        await sleep(150);
      }
      if (this.c.f('bodyCoach')) await s.backOffAfterToss(who); else await sleep(1500);
      onGround = await s.waitPickup(who, match, 3000, pre);
      lying = Object.values(onGround).reduce((a, k) => a + k, 0);
      tossed = start - have();
    }

    const kept = Math.max(0, tossed - (start - have()));
    if (kept && s.dbg) s.dbg(`hand-over: ${kept} came back into his bag`);
    const net = Math.max(0, tossed - kept);
    this.lastHandOver = { want, wanted: n, start, tossed: net, lying };
    if (s.dbg) s.dbg(`hand-over ${want}: wanted ${n}, had ${start}, tossed ${tossed}, came back ${kept}, still on the ground by you ${lying}`);
    return net;
  }

}

module.exports = { Fetcher, sourceOf, craftNeeds, chooseFood, DIG, MINE, SMELT, FOOD_RE, label, amount, oneOf };
