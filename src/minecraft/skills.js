// What the body can do with its hands: chop, mine, craft, smelt, build, hunt, light the way, explore and hand things over.
// Everything is done the survival way (no cheats) and can be cancelled at any moment.
const { goals, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { AsyncLocalStorage } = require('async_hooks');

const { GoalNear, GoalBlock, GoalXZ, GoalInvert } = goals;

const taskCtx = new AsyncLocalStorage();

class Cancelled extends Error {
  constructor(reason = 'stopped') { super(reason); this.cancelled = true; }
}

class Nope extends Error {}

const TIERS = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
const ORES = {
  coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], drop: 'coal', tier: 0, y: 40, want: 8, label: 'coal' },
  iron: { blocks: ['iron_ore', 'deepslate_iron_ore'], drop: 'raw_iron', tier: 1, y: 16, want: 6, label: 'iron' },
  gold: { blocks: ['gold_ore', 'deepslate_gold_ore'], drop: 'raw_gold', tier: 2, y: -16, want: 6, label: 'gold' },
  diamond: { blocks: ['diamond_ore', 'deepslate_diamond_ore'], drop: 'diamond', tier: 2, y: -58, want: 3, label: 'diamonds' }
};
const LOG_RE = /^(?!stripped_|mushroom_)[a-z_]+_(log|stem)$/;
const PLANKS_RE = /_planks$/;
const BUILD_RE = /_planks$|^cobblestone$|^cobbled_deepslate$|^dirt$|^stone$|^(?!stripped_)[a-z_]+_log$/;
const AIRISH = new Set(['air', 'cave_air', 'void_air']);
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|seagrass|vine|glow_lichen|.*_sapling|red_mushroom|brown_mushroom|pink_petals)$/;
const PASSIVE_FOOD = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
const RAW_FOOD = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit' };

const PROTECTED_RE = /planks|glass|door|chest|_bed$|furnace|crafting_table|torch|lantern|wool|carpet|bricks|fence|stairs|slab|sign|bookshelf|barrel|anvil|smoker|stonecutter|loom|campfire|ladder|rail|button|lever|pressure_plate|concrete|terracotta|quartz|lamp|beacon|banner|flower_pot|shulker|enchanting|brewing|cauldron|hopper|dispenser|dropper|observer|piston|repeater|comparator|scaffolding|bell|jukebox|note_block|^cobblestone$|smooth_stone|polished_|chiseled_|cut_/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function armCollect(s) {
  const bot = s.bot;
  if (!bot || !bot.collectBlock || bot.collectBlock._ggArmed) return;
  const orig = bot.collectBlock.collect.bind(bot.collectBlock);
  bot.collectBlock.collect = async (target, opts, cb) => {
    if (s.coached()) {
      bot.collectBlock.movements = s.collectMoves();
      const list = Array.isArray(target) ? target : [target];
      const safe = list.filter((t) => !(t && t.position && typeof t.name === 'string' && PROTECTED_RE.test(t.name)));
      if (!safe.length) throw new Nope("that's part of someone's build");
      target = Array.isArray(target) ? safe : safe[0];
    }
    return orig(target, opts, cb);
  };
  bot.collectBlock._ggArmed = true;
}

function houseBlueprint(x0, y0, z0, doorSide = 'south') {
  const cells = [];
  const door = doorSide === 'north' ? [x0 + 2, z0] : doorSide === 'east' ? [x0 + 4, z0 + 2] : doorSide === 'west' ? [x0, z0 + 2] : [x0 + 2, z0 + 4];
  const perimeter = [];
  for (let x = x0; x <= x0 + 4; x++) perimeter.push([x, z0]);
  for (let z = z0 + 1; z <= z0 + 4; z++) perimeter.push([x0 + 4, z]);
  for (let x = x0 + 3; x >= x0; x--) perimeter.push([x, z0 + 4]);
  for (let z = z0 + 3; z >= z0 + 1; z--) perimeter.push([x0, z]);
  const isDoor = ([x, z]) => x === door[0] && z === door[1];
  for (let dy = 0; dy < 3; dy++) {
    const layer = perimeter.filter((c) => dy === 2 || !isDoor(c));
    if (dy === 2) layer.sort((a, b) => (isDoor(a) ? 1 : 0) - (isDoor(b) ? 1 : 0));
    for (const [x, z] of layer) cells.push({ x, y: y0 + dy, z, part: 'wall' });
  }
  for (const [x, z] of perimeter) cells.push({ x, y: y0 + 3, z, part: 'roof' });
  for (let x = x0 + 1; x <= x0 + 3; x++) for (let z = z0 + 1; z <= z0 + 3; z++) {
    if (x === x0 + 2 && z === z0 + 2) continue;
    cells.push({ x, y: y0 + 3, z, part: 'roof' });
  }
  cells.push({ x: x0 + 2, y: y0 + 3, z: z0 + 2, part: 'roof' });
  const out = { dx: Math.sign(door[0] - (x0 + 2)), dz: Math.sign(door[1] - (z0 + 2)) };
  return {
    cells,
    door: { x: door[0], y: y0, z: door[1] },
    inside: { x: x0 + 2, y: y0, z: z0 + 2 },
    outside: { x: door[0] + out.dx * 2, y: y0, z: door[1] + out.dz * 2 },
    torch: { x: x0 + 1, y: y0, z: z0 + 1 }
  };
}

function sideToward(x0, z0, px, pz) {
  const cx = x0 + 2.5, cz = z0 + 2.5;
  const dx = px - cx, dz = pz - cz;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : 'north';
}

function tierOf(name) {
  const m = /^(wooden|stone|iron|golden|diamond|netherite)_/.exec(name || '');
  if (!m) return -1;
  return m[1] === 'golden' ? 0 : TIERS.indexOf(m[1]);
}

class Skills {
  constructor(companion) {
    this.c = companion;
  }

  coached() { return !!(this.c && typeof this.c.f === 'function' && this.c.f('bodyCoach')); }

  woodFix() { return !!(this.c && typeof this.c.f === 'function' && this.c.f('bodyWood')); }

  leavesFix() { return !!(this.c && typeof this.c.f === 'function' && this.c.f('bodyLeaves')); }
  collectMoves() {
    if (this._collect && this._collectFor === this.bot) return this._collect;
    const m = new Movements(this.bot);
    m.canDig = true;
    m.allow1by1towers = true;
    m.allowParkour = true;
    m.canOpenDoors = false;
    for (const b of Object.values(this.data.blocksByName)) if (PROTECTED_RE.test(b.name)) m.blocksCantBreak.add(b.id);
    if (this.c.v12?.hands?.decorateMoves) this.c.v12.hands.decorateMoves(m);
    this._collect = m;
    this._collectFor = this.bot;
    return m;
  }

  get bot() { return this.c.bot; }
  get data() { return require('minecraft-data')(this.bot.version); }

  check() {
    if (!this.bot?.entity) throw new Cancelled('left the world');
    if (this.c.task?.cancelled) throw new Cancelled(this.c.task.cancelled);
    const own = taskCtx.getStore();
    if (own && own.cancelled) throw new Cancelled(own.cancelled);
  }

  async wait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { this.check(); await sleep(Math.min(250, end - Date.now())); }
  }

  progress(note, data = {}) { this.c.taskProgress(note, data); }

  items() { return this.bot.inventory.items(); }
  count(match) {
    const test = typeof match === 'string' ? (n) => n === match : (n) => match.test(n);
    return this.items().filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0);
  }
  find(match) {
    const test = typeof match === 'string' ? (n) => n === match : (n) => match.test(n);
    return this.items().find((i) => test(i.name)) || null;
  }
  bestTier(kind) {
    let best = -1;
    for (const i of this.items()) if (i.name.endsWith(`_${kind}`)) best = Math.max(best, tierOf(i.name));
    return best;
  }
  toolSummary() {
    const name = (k) => { const t = this.bestTier(k); return t < 0 ? null : `${TIERS[t]} ${k}`; };
    return [name('pickaxe'), name('sword'), name('axe')].filter(Boolean);
  }

  workMoves() {
    armCollect(this);
    if (this._work && this._workFor === this.bot) return this._work;
    const m = new Movements(this.bot);
    m.canDig = true;
    m.allow1by1towers = true;
    m.allowParkour = true;
    m.dontCreateFlow = true;
    m.canOpenDoors = false;
    for (const b of Object.values(this.data.blocksByName)) if (PROTECTED_RE.test(b.name)) m.blocksCantBreak.add(b.id);

    if (this.c.v12?.hands?.decorateMoves) this.c.v12.hands.decorateMoves(m);

    if (Array.isArray(m.exclusionAreasBreak)) m.exclusionAreasBreak.push((b) => (b && b.position && this.underPlayer(b.position) ? 100000 : 0));
    this._work = m;
    this._workFor = this.bot;
    return m;
  }

  walkMoves() {
    const m = new Movements(this.bot);
    m.canDig = false;
    m.allow1by1towers = false;
    return m;
  }

  async goto(goal, { dig = true, timeout = 30000 } = {}) {
    this.check();
    const bot = this.bot;
    bot.pathfinder.setMovements(dig ? this.workMoves() : this.walkMoves());
    let timer;
    const cancelWatch = setInterval(() => { if (this.c.task?.cancelled) bot.pathfinder.stop(); }, 200);
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((_, rej) => { timer = setTimeout(() => { bot.pathfinder.stop(); rej(new Nope("couldn't find a way there")); }, timeout); })
      ]);
    } catch (err) {
      this.check();
      if (err instanceof Nope) throw err;
      throw new Nope(/path/i.test(err.message) ? "couldn't find a way there" : err.message);
    } finally {
      clearTimeout(timer);
      clearInterval(cancelWatch);
    }
  }

  async gotoNear(pos, range = 2, opts) { return this.goto(new GoalNear(pos.x, pos.y, pos.z, range), opts); }

  owner() { return this.c.ownerEntity(); }

  underPlayer(p) {
    try {
      if (!(this.c && typeof this.c.f === 'function' && this.c.f('bodyFooting')) || !p) return false;
      const o = this.owner();
      if (!o || !o.position) return false;
      const fy = Math.floor(o.position.y + 0.01);
      if (p.y > fy - 1 || p.y < fy - 3) return false;
      for (const dx of [-0.31, 0.31]) for (const dz of [-0.31, 0.31]) if (Math.floor(o.position.x + dx) === p.x && Math.floor(o.position.z + dz) === p.z) return true;
      return false;
    } catch { return false; }
  }

  async backToPlayer({ timeout = 60000 } = {}) {
    const o = this.owner();
    if (!o) return false;
    try { await this.gotoNear(o.position, 3, { dig: true, timeout }); return true; } catch (err) { if (err.cancelled) throw err; return false; }
  }

  block(pos) { return this.bot.blockAt(pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z)); }
  isAir(b) { return !b || AIRISH.has(b.name); }
  isReplaceable(b) { return !b || REPLACEABLE.test(b.name); }
  isSolid(b) { return !!b && b.boundingBox === 'block' && !/leaves$/.test(b.name); }
  isLiquid(b) { return !!b && (b.name === 'water' || b.name === 'lava' || b.name === 'flowing_water' || b.name === 'flowing_lava'); }
  exposed(b) {
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = this.bot.blockAt(b.position.offset(...d));
      if (!n || AIRISH.has(n.name) || n.name === 'water') return true;
    }
    return false;
  }

  ids(names) {
    const list = [];
    for (const n of names) { const b = this.data.blocksByName[n]; if (b) list.push(b.id); }
    return list;
  }

  findBlocks(names, { maxDistance = 48, count = 1, where = null } = {}) {
    const ids = this.ids(names);
    if (!ids.length) return [];
    const positions = this.bot.findBlocks({ matching: ids, maxDistance, count: where ? count * 8 : count });
    const blocks = positions.map((p) => this.bot.blockAt(p)).filter(Boolean);
    return (where ? blocks.filter(where) : blocks).slice(0, count);
  }

  async collect(names, count, { maxDistance = 48, where = null, label = null } = {}) {
    const bot = this.bot;
    let got = 0;
    let misses = 0;
    const failed = new Set();
    const coached = this.coached();

    const wood = this.woodFix();
    if (wood) { const now = Date.now(); this._badTrees = (this._badTrees || []).filter((m) => now - m.at < 600000); }
    const trees = wood ? this._badTrees : [];

    let stuck = 0, stuckSince = 0;
    if (wood && names.some((n) => LOG_RE.test(n)) && this._stuck && Date.now() - this._stuck.at < 60000 && bot.entity.position.distanceTo(this._stuck.pos) < 1) {
      this.dbg('collect: still boxed in, not trying again yet');
      if (label) throw new Nope(`you are boxed in by the trees here`);
      return 0;
    }
    const allLogs = names.every((n) => LOG_RE.test(n));
    const offTree = (x) => !trees.some((m) => Math.abs(m.x - x.position.x) <= 2 && Math.abs(m.z - x.position.z) <= 2 && x.position.y >= m.y - 1);
    while (got < count && misses < (coached ? 6 : 3)) {
      this.check();
      const startPos = bot.entity.position.clone();
      const safeWhere0 = coached ? (x) => !PROTECTED_RE.test(x.name) && !failed.has(`${x.position.x},${x.position.y},${x.position.z}`) && (!where || where(x)) : where;
      const safeWhere = (x) => !this.underPlayer(x.position) && (!safeWhere0 || safeWhere0(x));
      let b;
      if (wood && allLogs) {
        const w2 = (x) => (!safeWhere || safeWhere(x)) && offTree(x);
        b = this.pickReachable(this.findBlocks(names, { maxDistance, count: 24, where: w2 }));
      } else {
        [b] = this.findBlocks(names, { maxDistance, count: 1, where: wood && trees.length ? (x) => (!safeWhere || safeWhere(x)) && (!LOG_RE.test(x.name) || offTree(x)) : safeWhere });
      }
      if (!b) break;
      bot.pathfinder.setMovements(this.workMoves());
      const before = coached ? this.items().reduce((n, i) => n + i.count, 0) : 0;
      try {

        const dropRe = !wood ? null : LOG_RE.test(b.name) ? LOG_RE : /^(stone|deepslate)$/.test(b.name) ? /^(cobblestone|cobbled_deepslate)$/ : null;
        const dropBefore = dropRe ? this.count(dropRe) : null;
        await Promise.race([
          bot.collectBlock.collect(b, { ignoreNoPath: true }),
          sleep(wood && LOG_RE.test(b.name) ? 20000 : 45000).then(() => { throw new Nope('took too long'); })
        ]);
        if (dropRe && this.count(dropRe) <= dropBefore) {
          await this.sweepDrops(b.position, 6);
          if (this.count(dropRe) <= dropBefore) throw new Nope('what you dug never reached your inventory');
        }
        got++;
        misses = 0;
        stuck = 0;
        this.dbg(`collect ok ${b.name} at ${b.position} logs now ${this.count(LOG_RE)} items ${this.items().length}`);
        if (coached && this.items().reduce((n, i) => n + i.count, 0) <= before) await this.sweepDrops(b.position, 6);
      } catch (err) {
        this.check();
        misses++;
        this.dbg(`collect miss ${b.name} at ${b.position} me ${this.bot.entity.position.floored()}: ${String(err && err.message).slice(0, 160)}`);
        if (coached) failed.add(`${b.position.x},${b.position.y},${b.position.z}`);
        if (wood && LOG_RE.test(b.name)) {
          trees.push({ x: b.position.x, y: b.position.y, z: b.position.z, at: Date.now() });
          stuck = bot.entity.position.distanceTo(startPos) < 1 ? stuck + 1 : 0;
          if (stuck === 1) stuckSince = Date.now();

          if (stuck === 1 && this.leavesFix()) {
            const key = String(bot.entity.position.floored());
            this._leafCleared = this._leafCleared || new Set();
            if (!this._leafCleared.has(key)) { this._leafCleared.add(key); try { bot.collectBlock.cancelTask?.(); } catch {} if (await this.clearLeavesAround()) { stuck = 0; trees.pop(); misses = Math.max(0, misses - 1); if (coached) failed.delete(`${b.position.x},${b.position.y},${b.position.z}`); continue; } }
          }
          if (stuck >= 3 && Date.now() - stuckSince >= 40000) { this._stuck = { at: Date.now(), pos: bot.entity.position.clone() }; this.dbg('collect: boxed in, giving up on wood here'); break; }
        }
        try { bot.collectBlock.cancelTask?.(); } catch {}
      }
    }
    if (!got && label) throw new Nope(`no ${label} around here`);
    return got;
  }

  async sweepDrops(at, radius = 6) {
    const bot = this.bot;
    const t0 = Date.now();
    await this.wait(400);
    while (Date.now() - t0 < 6000) {
      this.check();
      const items = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position && e.position.distanceTo(at) <= radius)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
      if (!items.length) return;
      await this.gotoNear(items[0].position, 0, { dig: false, timeout: 4000 }).catch((e) => { if (e.cancelled) throw e; });
      await this.wait(250);
    }
  }

  pickReachable(cands) {
    const me = this.bot.entity.position;
    let best = null, bestScore = Infinity;
    for (const b of cands) {
      let h = 0;
      while (h < 12) { const below = this.bot.blockAt(b.position.offset(0, -(h + 1), 0)); if (!below || !(LOG_RE.test(below.name) || /leaves$/.test(below.name) || below.boundingBox === 'empty')) break; h++; }
      const score = b.position.distanceTo(me) + (h >= 4 ? 10 + 4 * (h - 3) : 0);
      if (score < bestScore) { best = b; bestScore = score; }
    }
    return best;
  }

  woodKinds() {
    const m = {};
    for (const i of this.items()) {
      const lm = /^(.*)_(log|stem)$/.exec(i.name), pm = /^(.*)_planks$/.exec(i.name);
      if (lm && LOG_RE.test(i.name)) { (m[lm[1]] = m[lm[1]] || { logs: 0, planks: 0 }).logs += i.count; }
      else if (pm) { (m[pm[1]] = m[pm[1]] || { logs: 0, planks: 0 }).planks += i.count; }
    }
    let kind = null, eq = 0;
    for (const [k, v] of Object.entries(m)) { const e = v.planks + 4 * v.logs; if (e > eq) { kind = k; eq = e; } }
    return { kind, eq, all: m };
  }

  async clearLeavesAround() {
    const bot = this.bot;
    try { bot.collectBlock.cancelTask?.(); } catch {}
    try { bot.pathfinder.setGoal(null); } catch {}
    const me = bot.entity.position.floored();
    const spots = [];
    for (const dy of [0, 1]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) spots.push(me.offset(dx, dy, dz));
    spots.push(me.offset(0, 2, 0));
    let n = 0;
    for (const p of spots) {
      this.check();
      const b = bot.blockAt(p);
      if (!b || !/(_leaves|^vine$|^cave_vines|^glow_lichen$)/.test(b.name)) continue;
      if (this.noDigAt(p) || this.placedLeaves(b) || this.underPlayer(p)) continue;
      try { await Promise.race([bot.dig(b, true), sleep(4000).then(() => { throw new Nope('took too long'); })]); n++; } catch (e) { if (e.cancelled) throw e; }
    }
    if (n) await this.sweepDrops(me, 3).catch((e) => { if (e.cancelled) throw e; });
    this.dbg(`clearLeavesAround: cleared ${n} around ${me}`);
    return n;
  }

  noDigAt(p) { try { const h = this.c && this.c.v12 && this.c.v12.hands; return !!(h && typeof h.noDig === 'function' && h.noDig(p)); } catch { return false; } }

  placedLeaves(b) { try { if (!b || !/_leaves$/.test(b.name)) return false; const pr = typeof b.getProperties === 'function' ? b.getProperties() : {}; return pr.persistent === true || pr.persistent === 'true'; } catch { return false; } }

  async unboxWood() {
    const bot = this.bot;
    try { bot.collectBlock.cancelTask?.(); } catch {}
    try { bot.pathfinder.setGoal(null); } catch {}
    const names = Object.keys(this.data.blocksByName).filter((x) => LOG_RE.test(x) && !/^(crimson|warped)/.test(x));
    const eyes = () => bot.entity.position.offset(0, 1.62, 0);
    const near = this.findBlocks(names, { maxDistance: 6, count: 8, where: (x) => !PROTECTED_RE.test(x.name) && eyes().distanceTo(x.position.offset(0.5, 0.5, 0.5)) <= 4.4 });
    const before = this.count(LOG_RE);
    for (const b of near.slice(0, 4)) {
      this.check();
      try {
        if (bot.tool) await bot.tool.equipForBlock(b, {}).catch(() => {});
        await Promise.race([bot.dig(b, true), sleep(12000).then(() => { throw new Nope('took too long'); })]);
        await this.sweepDrops(b.position, 4);
      } catch (e) { if (e.cancelled) throw e; this.dbg(`unbox dig failed at ${b.position}: ${String(e && e.message).slice(0, 80)}`); }
    }
    const gained = this.count(LOG_RE) - before;
    this.dbg(`unbox: ${near.length} logs in reach, ${gained} into his bag`);
    if (gained > 0) this._stuck = null;
    return gained;
  }

  async stockWood(planks) {
    if (!this.woodFix()) return true;
    const allNames = Object.keys(this.data.blocksByName).filter((x) => LOG_RE.test(x) && !/^(crimson|warped)/.test(x));
    for (let round = 0; round < 4; round++) {
      this.check();
      const { kind, eq } = this.woodKinds();
      if (eq >= planks) return true;
      const need = Math.ceil((planks - eq) / 4);
      if (!round) this.progress(`getting wood first (${need} log${need === 1 ? '' : 's'})`);
      const same = kind ? allNames.filter((x) => x === `${kind}_log` || x === `${kind}_stem`) : [];
      let got = 0;
      if (same.length) { try { got = await this.collect(same, need, { maxDistance: round < 2 ? 64 : 96 }); } catch (e) { if (e.cancelled) throw e; } }
      if (!got) { try { got = await this.collect(allNames, need, { maxDistance: round < 2 ? 64 : 96 }); } catch (e) { if (e.cancelled) throw e; } }
      if (this.woodKinds().eq <= eq && this._stuck) await this.unboxWood();
      const after = this.woodKinds().eq;
      this.dbg(`stockWood want ${planks} planks-worth, had ${eq} ${kind || ''}, now ${after}: ${this.invSummary(/_(log|planks)$/)}`);
      if (after <= eq) break;
    }
    return this.woodKinds().eq >= planks;
  }

  async topUpFor(name, id, table) {
    if (!this.woodFix()) return null;
    const m = /^(wooden|stone|iron|golden|diamond)_(pickaxe|axe|sword|shovel|hoe)$/.exec(name);
    if (!m) return null;
    try {
      await this.ensureSticks(2);
      if (m[1] === 'wooden') await this.ensurePlanks(3);
    } catch (e) { if (e.cancelled) throw e; return null; }
    this.dbg(`topUpFor ${name}: ${this.invSummary(/_(log|planks)$|stick/)}`);
    return this.bot.recipesFor(id, null, 1, table)[0] || null;
  }

  async clearCraftGrid() {
    const inv = this.bot.inventory;
    for (const slot of [1, 2, 3, 4]) {
      if (!inv.slots[slot]) continue;
      try { await this.bot.clickWindow(slot, 0, 1); } catch {}
      await sleep(80);
    }
  }

  async craftSteady(name, times, table, id) {
    const bot = this.bot;
    await this.clearCraftGrid();
    let made = 0;
    for (let i = 0; i < times; i++) {
      let ok = false;
      for (let a = 0; a < 3 && !ok; a++) {
        this.check();
        const r = bot.recipesFor(id, null, 1, table)[0];
        if (!r) break;
        const before = this.count(name);
        try {
          await bot.craft(r, 1, table);
          ok = true;
          for (let k = 0; k < 15 && this.count(name) <= before; k++) await sleep(100);
        } catch (err) {
          if (err && err.cancelled) throw err;
          this.dbg(`craftSteady ${name} ${i + 1}/${times} try ${a + 1} failed: ${String(err && err.message).slice(0, 160)}`);
          await this.wait(400);
          await this.clearCraftGrid();
        }
      }
      if (!ok) break;
      made++;
    }
    if (!made) throw new Nope(`not enough stuff to make ${name.replace(/_/g, ' ')}`);
    await sleep(150);
    return made;
  }

  async getLogs(n) {
    const have = this.count(LOG_RE);
    if (have >= n) return have;
    if (this.woodFix()) {
      const names = Object.keys(this.data.blocksByName).filter((x) => LOG_RE.test(x) && !/^(crimson|warped)/.test(x));
      for (let round = 0; round < 4 && this.count(LOG_RE) < n; round++) {
        const before = this.count(LOG_RE);
        try { await this.collect(names, n - before, { maxDistance: round < 2 ? 64 : 96 }); } catch (e) { if (e.cancelled) throw e; }
        if (this.count(LOG_RE) <= before) break;
      }
      if (this.count(LOG_RE) < n && this._stuck) await this.unboxWood();
      this.dbg(`getLogs want ${n} had ${have} now ${this.count(LOG_RE)} (${this.invSummary(LOG_RE)})`);
      if (!this.count(LOG_RE)) throw new Nope(this._stuck ? "you are boxed in by the trees here and can't get to more wood" : 'no trees around here');
      return this.count(LOG_RE);
    }
    const names = Object.keys(this.data.blocksByName).filter((x) => LOG_RE.test(x) && !/^(crimson|warped)/.test(x));
    await this.collect(names, n - have, { maxDistance: 64, label: 'trees' }).catch((e) => { this.dbg(`getLogs collect threw: ${e.message}`); throw e; });
    this.dbg(`getLogs want ${n} had ${have} now ${this.count(LOG_RE)} (${this.invSummary(LOG_RE)})`);
    return this.count(LOG_RE);
  }

  async getStone(n) {

    const have = this.coached() ? Math.max(this.count('cobblestone'), this.count('cobbled_deepslate')) : this.count(/^(cobblestone|cobbled_deepslate)$/);
    if (have >= n) return have;
    await this.ensurePickaxe(0);

    const me = this.bot.entity.position;
    const showing = (b) => b.position.y >= Math.floor(me.y) - 1 && [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => { const nb = this.bot.blockAt(b.position.offset(x, y, z)); return nb && nb.boundingBox === 'empty' && !this.isLiquid(nb); });
    if (!this.findBlocks(['stone', 'deepslate'], { maxDistance: 32, count: 1, where: showing }).length && !this.find(/^(cobblestone|cobbled_deepslate)$/)) throw new Nope('no stone showing around here, just dirt; a hill or a cave would have some');
    await this.collect(this.coached() ? ['stone', 'deepslate'] : ['stone', 'deepslate', 'cobblestone'], n - have, { maxDistance: 32, label: 'stone', where: showing });
    if (this.coached()) {
      let guard = 0;
      while (Math.max(this.count('cobblestone'), this.count('cobbled_deepslate')) < n && guard++ < 3) {
        await this.collect(['stone', 'deepslate'], n - Math.max(this.count('cobblestone'), this.count('cobbled_deepslate')), { maxDistance: 32 });
      }
      return Math.max(this.count('cobblestone'), this.count('cobbled_deepslate'));
    }
    return this.count(/^(cobblestone|cobbled_deepslate)$/);
  }

  itemId(name) { const it = this.data.itemsByName[name]; if (!it) throw new Nope(`don't know how to make ${name.replace(/_/g, ' ')}`); return it.id; }

  nearbyTable() {
    if (this.coached() && this._badTables && this._badTables.size) {
      return this.findBlocks(['crafting_table'], { maxDistance: 24, count: 4, where: (b) => !this._badTables.has(`${b.position.x},${b.position.y},${b.position.z}`) })[0] || null;
    }
    return this.findBlocks(['crafting_table'], { maxDistance: 24 })[0] || null;
  }

  async craft(name, times = 1) {
    this.check();
    const bot = this.bot;
    const id = this.itemId(name);
    let recipe = bot.recipesFor(id, null, 1, null)[0];
    let table = null;
    if (!recipe) {
      if (!bot.recipesFor(id, null, 1, true)[0]) { this.dbg(`no recipe for ${name}: ${this.invSummary(/_(log|planks)$|stick|cobble/)}`); throw new Nope(`not enough stuff to make ${name.replace(/_/g, ' ')}`); }
      table = await this.ensureTable();
      recipe = bot.recipesFor(id, null, 1, table)[0] || await this.topUpFor(name, id, table);
      if (!recipe) throw new Nope(`not enough stuff to make ${name.replace(/_/g, ' ')}`);
      if (bot.entity.position.distanceTo(table.position) > 3.5) {
        if (this.coached()) {
          try { await this.gotoNear(table.position, 2, { timeout: 12000 }); } catch (err) {
            if (err.cancelled) throw err;
            this._badTables = this._badTables || new Set();
            this._badTables.add(`${table.position.x},${table.position.y},${table.position.z}`);
            table = await this.ensureTable();
            recipe = bot.recipesFor(id, null, 1, table)[0] || await this.topUpFor(name, id, table);
            if (!recipe) throw new Nope(`not enough stuff to make ${name.replace(/_/g, ' ')}`);
            if (bot.entity.position.distanceTo(table.position) > 3.5) await this.gotoNear(table.position, 2, { timeout: 20000 });
          }
        } else await this.gotoNear(table.position, 2, { timeout: 20000 });
      }
    }
    if (this.woodFix()) { await this.craftSteady(name, times, table, id); return; }
    if (!this.coached()) { await bot.craft(recipe, times, table); await sleep(150); return; }
    const resultBefore = this.count(name);

    try {
      await bot.craft(recipe, times, table);
    } catch (err) {
      this.dbg(`craft ${name} x${times} failed: ${String(err && err.message).slice(0, 200)} inv ${this.invSummary()}`);
      if (!/missing ingredient|did not fire within timeout/i.test(String(err && err.message))) throw err;
      await this.wait(500);
      let made = 0;
      for (let i = 0; i < times; i++) {
        this.check();
        const r = bot.recipesFor(id, null, 1, table)[0];
        if (!r) break;
        try { await bot.craft(r, 1, table); made++; } catch (e) { this.dbg(`craft one ${name} failed: ${String(e && e.message).slice(0, 160)}`); if (!/missing ingredient|did not fire within timeout/i.test(String(e && e.message))) throw e; await this.wait(400); }
      }
      if (!made) throw new Nope(`not enough stuff to make ${name.replace(/_/g, ' ')}`);
    }
    for (let i = 0; i < 20 && this.count(name) <= resultBefore; i++) await sleep(100);
    await sleep(150);
  }

  async ensureTable() {
    const near = this.nearbyTable();
    if (near) return near;
    if (!this.count('crafting_table')) {
      await this.ensurePlanks(4);
      await this.craft('crafting_table', 1);
    }
    const spot = this.freeSpotNear(this.bot.entity.position, 2, 4);
    if (!spot) throw new Nope('no room to put a crafting table down');
    await this.placeAt(spot, 'crafting_table');
    const t = this.nearbyTable();
    if (!t) throw new Nope("couldn't set up a crafting table");
    return t;
  }

  dbg(msg) { if (process.env.GG_BODY_DEBUG) try { this.c.emit('log', '[dbg] ' + msg); } catch {} }
  invSummary(re) { return this.items().filter((i) => !re || re.test(i.name)).map((i) => `${i.name}x${i.count}`).join(','); }

  plankNameFor(log) { return log.replace(/_(log|stem)$/, '_planks'); }

  async ensurePlanks(n) {
    if (this.coached()) return this.ensurePlanksSame(n);
    if (this.count(PLANKS_RE) >= n) return;
    const need = n - this.count(PLANKS_RE);
    await this.getLogs(Math.ceil(need / 4));
    let guard = 0;
    while (this.count(PLANKS_RE) < n && guard++ < 20) {
      const log = this.find(LOG_RE);
      if (!log) throw new Nope('ran out of wood');
      await this.craft(this.plankNameFor(log.name), 1);
    }
  }

  async ensurePlanksSame(n) {
    const best = () => {
      const m = {};
      for (const i of this.items()) if (PLANKS_RE.test(i.name)) m[i.name] = (m[i.name] || 0) + i.count;
      let k = null, v = 0;
      for (const [a, b] of Object.entries(m)) if (b > v) { k = a; v = b; }
      return [k, v];
    };
    let guard = 0;
    while (best()[1] < n && guard++ < 24) {
      this.check();
      const [type, have] = best();
      let log = type ? this.items().find((i) => LOG_RE.test(i.name) && this.plankNameFor(i.name) === type) : null;
      if (!log) log = this.items().filter((i) => LOG_RE.test(i.name)).sort((a, b) => b.count - a.count)[0] || null;
      if (!log) {
        await this.getLogs(Math.max(1, Math.ceil((n - (type ? have : 0)) / 4)));
        if (!this.find(LOG_RE)) { this.dbg(`ensurePlanksSame(${n}) no logs after getLogs: ${this.invSummary(/_(log|planks)$|stick/)}`); throw new Nope('ran out of wood'); }
        continue;
      }
      await this.craft(this.plankNameFor(log.name), 1);
    }
    if (best()[1] < n) { this.dbg(`ensurePlanksSame(${n}) short: ${this.invSummary(/_(log|planks)$|stick/)}`); throw new Nope('ran out of wood'); }
  }

  async ensureSticks(n) {
    while (this.count('stick') < n) {
      await this.ensurePlanks(2);
      await this.craft('stick', 1);
    }
  }

  async ensurePickaxe(tier, opts = {}) {
    if (this.bestTier('pickaxe') >= tier) return;
    if (!opts.inner && this.woodFix() && tier >= 0) {
      const best = this.bestTier('pickaxe');
      let planks = this.count('crafting_table') ? 0 : 4;
      let sticks = (opts.extraSticks || 0);
      if (best < 0) { planks += 3; sticks += 2; }
      if (tier >= 1 && best < 1) sticks += 2;
      if (tier >= 2 && best < 2) sticks += 2;
      if (tier >= 3 && best < 3) sticks += 2;
      planks += 2 * Math.ceil(Math.max(0, sticks - this.count('stick')) / 4);
      if (planks > 0) await this.stockWood(planks + 2);
    }
    if (tier >= 1) await this.ensurePickaxe(tier - 1, { inner: true });
    await this.ensureSticks(2);
    if (tier === 0) {
      await this.ensurePlanks(3);
      await this.craft('wooden_pickaxe');
      this.progress('made a wooden pickaxe');
    } else if (tier === 1) {
      await this.getStone(3);
      await this.craft('stone_pickaxe');
      this.progress('made a stone pickaxe');
    } else if (tier === 2) {
      await this.ensureIron(3);
      await this.ensureSticks(2);
      await this.craft('iron_pickaxe');
      this.progress('made an iron pickaxe', { big: true });
    } else if (tier === 3) {
      if (this.count('diamond') < 3) throw new Nope('need 3 diamonds for a diamond pickaxe');
      await this.craft('diamond_pickaxe');
      this.progress('made a diamond pickaxe', { big: true });
    }
  }

  async ensureIron(n) {
    const have = this.count('iron_ingot');
    if (have >= n) return;
    const raw = this.count('raw_iron');
    if (raw < n - have) await this.mineOre('iron', n - have - raw, { maxMs: 4 * 60 * 1000, comeBack: false });
    await this.smelt('raw_iron', Math.min(this.count('raw_iron'), n - this.count('iron_ingot')));
    if (this.count('iron_ingot') < n) throw new Nope('not enough iron');
  }

  async ensureFurnace() {
    const near = this.findBlocks(['furnace'], { maxDistance: 24 })[0];
    if (near) return near;
    if (!this.count('furnace')) {
      const fuelFix = this.c && typeof this.c.f === 'function' && this.c.f('bodyFuel');
      await this.getStone(fuelFix ? 10 : 8);

      if (fuelFix) {
        for (let k = 0; k < 2 && this.count(/^(cobblestone|cobbled_deepslate|blackstone)$/) < 8; k++) {
          this.dbg(`bodyFuel furnace stone: ${this.count(/^(cobblestone|cobbled_deepslate|blackstone)$/)} of 8, getting more`);
          await this.getStone(10);
        }
      }
      try { await this.craft('furnace'); } catch (err) {
        if (err.cancelled || !fuelFix || !/not enough stuff/.test(String(err.message))) throw err;
        this.dbg(`bodyFuel furnace: ${err.message} with ${this.count(/^(cobblestone|cobbled_deepslate|blackstone)$/)} stone, topping up once`);
        await this.getStone(10);
        await this.craft('furnace');
      }
    }
    const spot = this.freeSpotNear(this.bot.entity.position, 2, 4);
    if (!spot) throw new Nope('no room for a furnace');
    if (this.woodFix()) {
      const tried = [];
      let ok = false, last = null;
      for (let i = 0; i < 4 && !ok; i++) {
        const sp = i ? this.freeSpotsNear(this.bot.entity.position, 1, 4).find((q) => !tried.some((t) => t.equals(q))) : spot;
        if (!sp) break;
        tried.push(sp);
        try { const r = await this.placeAt(sp, 'furnace'); ok = r === 'placed' || r === 'already'; } catch (e) { if (e.cancelled) throw e; last = e; this.dbg(`furnace at ${sp} failed: ${e.message}`); }
      }
      if (!ok && last) throw last;
    } else await this.placeAt(spot, 'furnace');
    const f = this.findBlocks(['furnace'], { maxDistance: 8 })[0];
    if (!f) throw new Nope("couldn't set up a furnace");
    return f;
  }

  fuelFor(n) {
    const coal = this.find(/^(coal|charcoal)$/);
    if (coal && coal.count * 8 >= n) return { item: coal, count: Math.ceil(n / 8) };
    const planks = this.find(PLANKS_RE);
    if (planks && planks.count * 1.5 >= n) return { item: planks, count: Math.ceil(n / 1.5) };
    const log = this.find(LOG_RE);
    if (log && log.count * 1.5 >= n) return { item: log, count: Math.ceil(n / 1.5) };
    return null;
  }

  async smelt(input, n) {
    if (n <= 0) return 0;
    this.check();
    const bot = this.bot;

    const fuelFix = this.c && typeof this.c.f === 'function' && this.c.f('bodyFuel') && !LOG_RE.test(input) && !PLANKS_RE.test(input);
    if (fuelFix && !this.find(/^(coal|charcoal)$/)) {
      const furnaceNear = this.findBlocks(['furnace'], { maxDistance: 24 })[0], tableNear = this.findBlocks(['crafting_table'], { maxDistance: 24 })[0];
      const want = Math.ceil(n / 1.5) + 1 + (!furnaceNear && !this.count('furnace') && !tableNear ? 4 : 0);
      if ((this.find(PLANKS_RE) || { count: 0 }).count < want) { try { await this.ensurePlanks(want); } catch (e) { if (e.cancelled) throw e; this.dbg(`bodyFuel early planks: ${e.message}`); } }
    }
    if (!this.fuelFor(n)) await this.ensurePlanks(Math.ceil(n / 1.5) + 1);
    const block = await this.ensureFurnace();
    if (bot.entity.position.distanceTo(block.position) > 3.5) await this.gotoNear(block.position, 2, { timeout: 20000 });

    if (fuelFix && !this.fuelFor(n)) {
      try { await this.ensurePlanks(Math.ceil(n / 1.5) + 1); } catch (e) { if (e.cancelled) throw e; this.dbg(`bodyFuel planks: ${e.message}`); }
      if (!this.fuelFor(n)) { const p = this.find(PLANKS_RE), l = this.find(LOG_RE); this.dbg(`bodyFuel: still short (${p ? p.count : 0} planks, ${l ? l.count : 0} logs)`); }
      if (bot.entity.position.distanceTo(block.position) > 3.5) await this.gotoNear(block.position, 2, { timeout: 20000 });
    }
    const furnace = await bot.openFurnace(block);
    let got = 0;
    try {
      let fuel = this.fuelFor(n);

      if (!fuel && fuelFix) {

        const cands = this.items().filter((i) => i.name !== input && (/^(coal|charcoal)$/.test(i.name) || PLANKS_RE.test(i.name) || LOG_RE.test(i.name)));
        let f2 = null, best = 0;
        for (const i of cands) { const k = Math.floor(i.count * (/coal/.test(i.name) ? 8 : 1.5)); if (k > best) { best = k; f2 = i; } }
        if (f2) { const k = best; if (k >= 1) { n = Math.min(n, k); fuel = { item: f2, count: f2.count }; } }
      }
      if (!fuel) throw new Nope('nothing to burn in the furnace');
      if (!furnace.fuelItem()) await furnace.putFuel(fuel.item.type, null, fuel.count);
      await furnace.putInput(this.itemId(input), null, n);
      this.progress(`smelting ${input.replace(/^raw_/, '').replace(/_/g, ' ')}`);
      let last = Date.now();
      while (got < n && Date.now() - last < 15000) {
        await this.wait(1000);
        if (furnace.outputItem()) {
          const out = await furnace.takeOutput();
          if (out) { got += out.count; last = Date.now(); }
        }
      }
      if (furnace.inputItem()) await furnace.takeInput().catch(() => {});
    } finally {
      try { furnace.close(); } catch {}
    }
    return got;
  }

  freeSpotsNear(pos, minR = 1, maxR = 4) {
    const base = pos.floored();
    const out = [];
    for (let r = minR; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1]) {
          const p = base.offset(dx, dy, dz);
          if (this.isReplaceable(this.block(p)) && this.isReplaceable(this.block(p.offset(0, 1, 0))) && this.isSolid(this.block(p.offset(0, -1, 0)))) out.push(p);
        }
      }
    }
    return out;
  }

  freeSpotNear(pos, minR = 1, maxR = 4) {
    const base = pos.floored();
    for (let r = minR; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1]) {
          const p = base.offset(dx, dy, dz);
          if (this.isReplaceable(this.block(p)) && this.isReplaceable(this.block(p.offset(0, 1, 0))) && this.isSolid(this.block(p.offset(0, -1, 0)))) return p;
        }
      }
    }
    return null;
  }

  async placeAt(pos, pick, opts = null) {
    this.check();
    const bot = this.bot;
    const p = pos instanceof Vec3 ? pos.floored() : new Vec3(pos.x, pos.y, pos.z);
    const target = bot.blockAt(p);
    if (target && !this.isReplaceable(target)) return 'already';
    const item = typeof pick === 'string' ? this.find(pick) : this.find(pick);
    if (!item) throw new Nope(`ran out of ${typeof pick === 'string' ? pick.replace(/_/g, ' ') : 'blocks'}`);
    if (target && !this.isAir(target)) { try { await bot.dig(target, true); } catch {} }
    let ref = null, face = null;
    for (const d of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const b = bot.blockAt(p.offset(...d));
      if (b && b.boundingBox === 'block' && !this.isLiquid(b)) { ref = b; face = new Vec3(-d[0], -d[1], -d[2]); break; }
    }
    if (!ref) throw new Nope('nothing to build off of');
    const feet = bot.entity.position.floored();
    if ((feet.equals(p) || feet.offset(0, 1, 0).equals(p))) {
      await this.goto(new GoalInvert(new GoalNear(p.x, p.y, p.z, 1.5)), { dig: false, timeout: 6000 }).catch(() => {});
    }
    const eye = bot.entity.position.offset(0, bot.entity.height * 0.9, 0);
    if (eye.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.3) await this.gotoNear(p, 3, opts && opts.move ? { timeout: 15000, ...opts.move } : { timeout: 15000 });
    await bot.equip(item, 'hand');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
        await bot.placeBlock(ref, face);
      } catch {}
      await sleep(120);
      const now = bot.blockAt(p);
      if (now && !this.isReplaceable(now)) return 'placed';
    }
    throw new Nope("couldn't place a block there");
  }

  findHouseSite(center) {
    const bot = this.bot;
    const c = center.floored();
    const candidates = [];
    for (let r = 3; r <= 14; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        candidates.push([c.x + dx - 2, c.z + dz - 2]);
      }
    }
    for (const [x0, z0] of candidates) {

      if (c.x >= x0 - 1 && c.x <= x0 + 5 && c.z >= z0 - 1 && c.z <= z0 + 5) continue;
      let ground = null;
      for (let y = c.y + 4; y >= c.y - 6; y--) {
        const b = bot.blockAt(new Vec3(x0 + 2, y, z0 + 2));
        if (this.isSolid(b)) { ground = y; break; }
      }
      if (ground == null) continue;
      const y0 = ground + 1;
      let ok = true;
      for (let x = x0; x <= x0 + 4 && ok; x++) for (let z = z0; z <= z0 + 4 && ok; z++) {
        if (!this.isSolid(bot.blockAt(new Vec3(x, y0 - 1, z)))) ok = false;
        for (let dy = 0; dy < 4 && ok; dy++) {
          const b = bot.blockAt(new Vec3(x, y0 + dy, z));
          if (!this.isReplaceable(b) || this.isLiquid(b)) ok = false;
        }
      }
      if (ok) return { x0, y0, z0 };
    }
    return null;
  }

  findLevelSite(center) {
    const bot = this.bot;
    const c = center.floored();
    const NATURAL = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|stone|andesite|diorite|granite|tuff|deepslate|sand|red_sand|gravel|clay|.*_leaves|short_grass|tall_grass|fern|large_fern|dead_bush|vine|.*_sapling|snow|moss_block|moss_carpet|leaf_litter|sweet_berry_bush|bush|firefly_bush|.*_flower|dandelion|poppy|azure_bluet|oxeye_daisy|cornflower|.*_tulip|allium|blue_orchid|lily_of_the_valley|wildflowers|pink_petals)$/;
    let best = null, firstRing = null;
    const why = {};
    const no = (k) => { why[k] = (why[k] || 0) + 1; };
    for (let r = 3; r <= 20; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x0 = c.x + dx - 2, z0 = c.z + dz - 2;
        if (c.x >= x0 - 1 && c.x <= x0 + 5 && c.z >= z0 - 1 && c.z <= z0 + 5) continue;

        const counts = new Map();
        for (let x = x0; x <= x0 + 4; x++) for (let z = z0; z <= z0 + 4; z++) {
          for (let y = c.y + 3; y >= c.y - 4; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && this.isSolid(b) && !/_log$/.test(b.name)) { counts.set(y, (counts.get(y) || 0) + 1); break; } }
        }
        if (!counts.size) { no('no ground'); continue; }
        const ground = [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0] - c.y) - Math.abs(b[0] - c.y))[0][0];
        const y0 = ground + 1;
        const dig = [], fill = [];
        let bad = false;
        for (let x = x0; x <= x0 + 4 && !bad; x++) for (let z = z0; z <= z0 + 4 && !bad; z++) {
          const fl = bot.blockAt(new Vec3(x, y0 - 1, z));
          if (!fl) { bad = true; no('not loaded'); break; }
          if (this.isLiquid(fl)) { bad = true; no('water or lava'); break; }
          if (PROTECTED_RE.test(fl.name)) { bad = true; no(`player's ${fl.name}`); break; }
          if (!this.isSolid(fl)) {
            const under = bot.blockAt(new Vec3(x, y0 - 2, z));
            if (!under || this.isLiquid(under)) { bad = true; no('hole over water or nothing'); break; }
            if (!this.isSolid(under)) {
              const under2 = bot.blockAt(new Vec3(x, y0 - 3, z));
              if (!under2 || !this.isSolid(under2)) { bad = true; no('hole 3+ deep'); break; }
              if (!this.isReplaceable(under)) { if (!NATURAL.test(under.name)) { bad = true; no(`odd block ${under.name}`); break; } dig.push(under.position); }
              fill.push(under.position);
            }
            if (!this.isReplaceable(fl)) { if (!NATURAL.test(fl.name)) { bad = true; no(`odd block ${fl.name}`); break; } dig.push(fl.position); }
            fill.push(fl.position);
          }
          for (let dy = 0; dy < 4 && !bad; dy++) {
            const b = bot.blockAt(new Vec3(x, y0 + dy, z));
            if (!b) { bad = true; no('not loaded'); break; }
            if (this.isLiquid(b)) { bad = true; no('water or lava'); break; }
            if (PROTECTED_RE.test(b.name)) { bad = true; no(`player's ${b.name}`); break; }
            if (!this.isReplaceable(b)) { if (!NATURAL.test(b.name)) { bad = true; no(`odd block ${b.name}`); break; } dig.push(b.position); }
          }
        }

        if (!bad && [...dig, ...fill].some((p) => this.noDigAt(p))) { bad = true; no('house rule'); }
        if (!bad && dig.some((p) => this.hazardAt(p) || this.placedLeaves(bot.blockAt(p)) || (() => { try { const pr = bot.blockAt(p).getProperties(); return pr.waterlogged === true || pr.waterlogged === 'true'; } catch { return false; } })())) { bad = true; no('water or lava next to it'); }
        if (bad) continue;
        const work = dig.length + fill.length;
        if (work > 14) { no('too much work'); continue; }
        const score = work * 3 + r;
        if (!best || score < best.score) best = { x0, y0, z0, dig, fill, score };
      }
      if (best && best.score <= r * 1) break;
      if (best && firstRing == null) firstRing = r;
      if (firstRing != null && r >= firstRing + 2) break;
    }

    if (best) best.fill.sort((a, b) => a.y - b.y);
    this.dbg(`findLevelSite: ${best ? `spot ${best.x0},${best.y0},${best.z0} dig ${best.dig.length} fill ${best.fill.length}` : 'none'}; skipped: ${JSON.stringify(why)}`);
    return best;
  }

  async levelSite(site) {
    const bot = this.bot;
    const dig = [...site.dig].sort((a, b) => b.y - a.y);

    const under = (p) => { const o = this.owner(); if (!o) return false; const f = o.position.floored(); return f.x === p.x && f.z === p.z && f.y - p.y >= 0 && f.y - p.y <= 2; };
    for (const p of dig) {
      this.check();
      const b = bot.blockAt(p);
      if (!b || this.isReplaceable(b) || PROTECTED_RE.test(b.name) || /_log$/.test(b.name) || this.placedLeaves(b) || this.noDigAt(p) || this.hazardAt(p)) continue;
      for (let w = 0; w < 10 && under(p); w++) await this.wait(500);
      if (under(p)) { this.dbg(`levelSite: the player is standing at ${p}, left as is`); continue; }
      try {
        if (bot.entity.position.distanceTo(p) > 4) await this.gotoNear(p, 3, { dig: false, timeout: 15000 }).catch((e) => { if (e.cancelled) throw e; });
        await this.digAt(p);
      } catch (e) { if (e.cancelled) throw e; this.dbg(`levelSite dig at ${p}: ${e.message}`); }
    }
    await this.sweepDrops(new Vec3(site.x0 + 2, site.y0, site.z0 + 2), 6).catch((e) => { if (e.cancelled) throw e; });
    for (const p of site.fill) {
      this.check();
      const b = bot.blockAt(p);
      if (b && this.isSolid(b)) continue;
      const pick = this.find(/^(dirt|grass_block|coarse_dirt|cobblestone|cobbled_deepslate)$/) ? /^(dirt|grass_block|coarse_dirt|cobblestone|cobbled_deepslate)$/ : BUILD_RE;
      try { await this.placeAt(p, pick); } catch (e) { if (e.cancelled) throw e; this.dbg(`levelSite fill at ${p}: ${e.message}`); }
    }
    this.dbg(`levelSite: dug ${dig.length}, filled ${site.fill.length} at ${site.x0},${site.y0},${site.z0}`);
  }

  buildingBlocks() { return this.count(BUILD_RE); }

  async logsToPlanks() {
    let guard = 0;
    while (this.find(LOG_RE) && guard++ < 40) {
      const log = this.find(LOG_RE);
      await this.craft(this.plankNameFor(log.name), log.count);
    }
  }

  async gatherBuildingBlocks(need) {

    await this.logsToPlanks();
    if (this.buildingBlocks() >= need) return;
    const missing = need - this.buildingBlocks();
    this.progress(`gathering wood for the house (about ${Math.ceil(missing / 4)} logs)`);
    try {
      await this.getLogs(Math.min(24, Math.ceil(missing / 4)));
    } catch (err) {
      if (err.cancelled) throw err;
    }
    await this.logsToPlanks();
    if (this.buildingBlocks() < need) {
      this.progress('not enough wood, so it is going to be a dirt house');
      await this.collect(['dirt', 'grass_block', 'coarse_dirt'], need - this.buildingBlocks(), { maxDistance: 16 });
    }
    if (this.buildingBlocks() < need) throw new Nope('not enough blocks for a house');
  }

  async buildHouse() {
    const bot = this.bot;
    const owner = this.owner();
    const center = owner ? owner.position : bot.entity.position;
    let site = this.findHouseSite(center);

    let level = null;
    if (!site && this.c && typeof this.c.f === 'function' && this.c.f('bodyLevel')) {
      level = this.findLevelSite(center);
      if (level) { site = { x0: level.x0, y0: level.y0, z0: level.z0 }; this.dbg(`bodyLevel: spot ${level.x0},${level.y0},${level.z0}: dig ${level.dig.length}, fill ${level.fill.length}`); }
    }
    if (!site) throw new Nope("couldn't find a flat spot for a house around here");
    const doorSide = sideToward(site.x0, site.z0, center.x, center.z);
    const plan = houseBlueprint(site.x0, site.y0, site.z0, doorSide);
    await this.gatherBuildingBlocks(plan.cells.length + (level ? level.fill.length : 0));
    this.check();
    if (this.count(/^(coal|charcoal)$/) && !this.count('torch')) { try { await this.ensureSticks(1); await this.craft('torch', 1); } catch (err) { if (err.cancelled) throw err; } }

    if (level) {
      if (level.fill.length && !this.find(/^(dirt|grass_block|coarse_dirt|cobblestone|cobbled_deepslate)$/)) { try { await this.collect(['dirt', 'grass_block', 'coarse_dirt'], level.fill.length, { maxDistance: 16 }); } catch (e) { if (e.cancelled) throw e; } }
      this.progress('leveling a spot for the house');
      await this.levelSite(level);
    }

    const again = level ? site : this.findHouseSite(center);
    const use = again && again.x0 === site.x0 && again.z0 === site.z0 ? plan : again ? houseBlueprint(again.x0, again.y0, again.z0, sideToward(again.x0, again.z0, center.x, center.z)) : plan;
    try { await this.goto(new GoalBlock(use.inside.x, use.inside.y, use.inside.z), { dig: false, timeout: 40000 }); } catch (err) {

      if (err.cancelled || !(this.c && typeof this.c.f === 'function' && this.c.f('bodyLevel'))) throw err;
      this.dbg(`house: walking back failed (${err.message}), digging his way`);
      await this.goto(new GoalBlock(use.inside.x, use.inside.y, use.inside.z), { dig: true, timeout: 60000 });
    }
    this.progress('started building the house');
    let placed = 0;
    let lastPart = null;
    for (const cell of use.cells) {
      this.check();
      if (cell.part !== lastPart && cell.part === 'roof') this.progress('walls are up, doing the roof');
      lastPart = cell.part;
      const pref = this.find(PLANKS_RE) ? PLANKS_RE : this.find(/^(cobblestone|cobbled_deepslate)$/) ? /^(cobblestone|cobbled_deepslate)$/ : BUILD_RE;
      try { await this.placeAt(cell, pref); placed++; } catch (err) { if (err.cancelled) throw err; }
      if (bot.entity.position.distanceTo(new Vec3(use.inside.x + 0.5, use.inside.y, use.inside.z + 0.5)) > 1.5) {
        await this.goto(new GoalBlock(use.inside.x, use.inside.y, use.inside.z), { dig: false, timeout: 15000 }).catch(() => {});
      }
    }
    if (this.count('torch')) await this.placeAt(use.torch, 'torch').catch(() => {});
    await this.goto(new GoalBlock(use.outside.x, use.outside.y, use.outside.z), { dig: false, timeout: 15000 }).catch(() => {});
    if (placed < use.cells.length * 0.8) throw new Nope(`only got ${placed} of ${use.cells.length} blocks placed`);
    this.c.home = { x: use.inside.x, y: use.inside.y, z: use.inside.z };
    return `a little house, door facing ${doorSide}`;
  }

  hazardAt(p) {
    for (const d of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const b = this.bot.blockAt(p.offset(...d));
      if (b && (b.name === 'lava' || b.name === 'flowing_lava' || b.name === 'water')) return b.name;
    }
    return null;
  }

  async digAt(p) {
    const b = this.bot.blockAt(p);
    if (!b || this.isAir(b) || b.boundingBox === 'empty') return;
    if (b.name === 'bedrock') throw new Nope('hit bedrock');
    if (this.coached() && PROTECTED_RE.test(b.name)) throw new Nope("that's part of someone's build");
    if (this.underPlayer(p)) throw new Nope('the player is standing on that block');
    if (this.bot.tool) await this.bot.tool.equipForBlock(b, {}).catch(() => {});
    await this.bot.dig(b, true);
  }

  async tunnelStep(dir, down) {
    const bot = this.bot;
    const feet = bot.entity.position.floored();
    const next = feet.offset(dir.x, down ? -1 : 0, dir.z);
    const cells = down ? [feet.offset(dir.x, 1, dir.z), next.offset(0, 1, 0), next] : [next.offset(0, 1, 0), next];
    for (const c of cells) if (this.hazardAt(c)) return false;
    if (this.coached() && cells.some((c) => { const x = bot.blockAt(c); return x && PROTECTED_RE.test(x.name); })) return false;
    const floor = bot.blockAt(next.offset(0, -1, 0));
    if (!floor || this.isLiquid(floor)) return false;
    for (const c of cells) { this.check(); await this.digAt(c); }
    if (!this.isSolid(bot.blockAt(next.offset(0, -1, 0)))) {
      const filler = this.find(/^(cobblestone|cobbled_deepslate|dirt|netherrack)$/);
      if (filler) await this.placeAt(next.offset(0, -1, 0), filler.name).catch(() => {});
    }
    await this.goto(new GoalBlock(next.x, next.y, next.z), { dig: true, timeout: 8000 });
    return true;
  }

  async mineOre(kind, want, { maxMs = null, comeBack = true } = {}) {
    const ore = ORES[kind];
    if (!maxMs) maxMs = { coal: 3, iron: 5, gold: 8, diamond: 10 }[kind] * 60 * 1000;
    if (!ore) throw new Nope(`don't know how to find ${kind}`);
    await this.ensurePickaxe(ore.tier);
    const bot = this.bot;
    if (this.coached()) await this.offBuilds();
    const start = bot.entity.position.clone();
    const crumbs = [start.floored()];
    const t0 = Date.now();
    const startCount = this.count(ore.drop);
    const have = () => this.count(ore.drop) - startCount;

    const oreFix = this.c && typeof this.c.f === 'function' && this.c.f('bodyOre');
    const targetY = oreFix && kind === 'coal' ? 96 : ore.y;
    const skipOre = new Set();

    const soloOre = !!(this.c && this.c.solo && typeof this.c.f === 'function' && this.c.f('bodySoloOre'));
    if (soloOre) { const now = Date.now(); this._badOre = this._badOre || new Map(); for (const [k, t] of this._badOre) if (now - t > 600000) this._badOre.delete(k); }
    const badOre = (b) => soloOre && this._badOre.has(String(b.position));
    const tunnelTo = async (pos) => {
      for (let i = 0; i < 10; i++) {
        this.check();
        const me = bot.entity.position.floored();
        const d = pos.minus(me);
        if (Math.abs(d.x) + Math.abs(d.z) <= 1 && d.y >= -2 && d.y <= 2) return true;
        if (!d.x && !d.z) return d.y >= -2 && d.y <= 2;
        const step = Math.abs(d.x) >= Math.abs(d.z) ? new Vec3(Math.sign(d.x), 0, 0) : new Vec3(0, 0, Math.sign(d.z));
        const ok = await this.tunnelStep(step, d.y < -1).catch((e) => { if (e.cancelled) throw e; return false; });
        if (!ok) return false;
      }
      return pos.distanceTo(bot.entity.position) <= 4.5;
    };
    let dir = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)][Math.floor(Math.random() * 4)];
    let steps = 0, blocked = 0, announcedDepth = false, announcedFind = false, hitBedrock = false, backups = 0;
    const caveFix = soloOre && !!(typeof this.c.f === 'function' && this.c.f('bodySoloCave'));
    const turn = () => { dir = Math.random() < 0.5 ? new Vec3(dir.z, 0, -dir.x) : new Vec3(-dir.z, 0, dir.x); };
    const caves = soloOre && typeof this.c.f === 'function' && this.c.f('bodySoloCaves');
    let caveHops = 0, caveTries = 0; const caveSeen = new Set();
    this._mining = (this._mining || 0) + 1;
    try {
      while (have() < want && Date.now() - t0 < maxMs) {
        this.check();

        await this.wait(40);

        const seen = this.findBlocks(ore.blocks, {
          maxDistance: oreFix ? 32 : 24, count: 1,
          where: (b) => (b.position.distanceTo(bot.entity.position) <= 5 || this.exposed(b)) && !(oreFix && skipOre.has(String(b.position))) && !badOre(b)
        })[0];
        if (seen && !this.hazardAt(seen.position)) {
          if (!announcedFind) { this.progress(`found ${ore.label}!`, { big: kind === 'diamond' }); announcedFind = true; }
          const before = this.count(ore.drop);
          if (soloOre) {
            const tryIt = this.collect(ore.blocks, 1, { maxDistance: oreFix ? 32 : 24, where: (b) => b.position.equals(seen.position) }).catch((e) => { if (e.cancelled) throw e; });
            tryIt.catch(() => {});
            let timer = null;
            const late = await Promise.race([tryIt.then(() => false), new Promise((r) => { timer = setTimeout(() => r(true), 15000); })]);
            clearTimeout(timer);
            if (late) { try { bot.pathfinder.stop(); bot.pathfinder.setGoal(null); } catch {} try { bot.stopDigging(); } catch {} await this.wait(300); }
            if (this.count(ore.drop) === before && seen.position.distanceTo(bot.entity.position) <= 10) {

              const there = await tunnelTo(seen.position).catch((e) => { if (e.cancelled) throw e; return false; });
              const b = bot.blockAt(seen.position);
              if (there && b && ore.blocks.includes(b.name)) {
                await this.digAt(seen.position).catch((e) => { if (e.cancelled) throw e; });
                await this.wait(400);
                for (let i = 0; i < 3 && this.count(ore.drop) === before; i++) {
                  const it = this.c.nearestItem(5);
                  if (!it) break;
                  await this.gotoNear(it.position, 0, { dig: true, timeout: 5000 }).catch((e) => { if (e.cancelled) throw e; });
                  await this.wait(250);
                }
              }
            }
          } else await this.collect(ore.blocks, 1, { maxDistance: oreFix ? 32 : 24, where: (b) => b.position.equals(seen.position) }).catch((e) => { if (e.cancelled) throw e; });
          if (this.count(ore.drop) === before) {
            blocked++; if (blocked > 4) turn();
            if (oreFix) { skipOre.add(String(seen.position)); await this.wait(250); }
            if (soloOre) { this._badOre.set(String(seen.position), Date.now()); this.dbg(`soloOre: couldn't get the ${ore.label} at ${seen.position}, leaving it`); }
          }
          crumbs.push(bot.entity.position.floored());
          continue;
        }

        if (caves && caveHops < 4 && caveTries < 6) {
          const cave = this.findCave(caveSeen, crumbs);
          if (cave) {
            caveTries++; caveSeen.add(String(cave));
            const there = await this.goto(new GoalNear(cave.x, cave.y, cave.z, 1), { dig: false, timeout: 15000 }).then(() => true).catch((e) => { if (e.cancelled) throw e; return false; });
            if (there) { caveHops++; if (caveHops === 1) this.progress('found a cave, going in'); crumbs.push(bot.entity.position.floored()); }
            continue;
          }
          caveTries = 6;
        }
        const y = bot.entity.position.y;
        const down = y > targetY + 2;

        if (down) throw new Nope(caveHops ? 'the caves here stop going down' : 'no cave to go into around here');
        if (!down && !announcedDepth && targetY < 30) { this.progress(`made it down to ${kind} level`); announcedDepth = true; }
        const ok = await this.tunnelStep(dir, down).catch((e) => { if (e.cancelled) throw e; if (/bedrock/.test(e.message)) hitBedrock = true; return false; });

        if (!ok && blocked >= 12 && !hitBedrock && caveFix && backups < 3 && crumbs.length > 3) {
          backups++;
          const back = crumbs[Math.max(0, crumbs.length - 7)];
          crumbs.length = Math.max(1, crumbs.length - 6);
          this.dbg(`soloCave: blocked in, backing up to ${back} (try ${backups})`);
          await this.gotoNear(back, 0, { dig: true, timeout: 12000 }).catch((e) => { if (e.cancelled) throw e; });
          blocked = 0; turn(); turn();
          continue;
        }
        if (!ok) { blocked++; turn(); if (blocked > 12) throw new Nope(hitBedrock ? "hit bedrock, can't dig any deeper here" : 'too much lava and water down here'); continue; }
        blocked = 0;
        steps++;
        crumbs.push(bot.entity.position.floored());
        if (!down && steps % 14 === 0) turn();
        if (bot.food < 8) await this.c.tryEat(true);
      }
    } finally {
      this._mining = Math.max(0, (this._mining || 1) - 1);
      this.c.lastMineDepth = Math.round(bot.entity?.position?.y ?? 0);
    }
    const got = have();
    if (comeBack) await this.retrace(crumbs);
    if (!got) throw new Nope(`no ${ore.label} this time`);
    return `${got} ${ore.label}`;
  }

  findCave(seen = new Set(), crumbs = []) {
    const bot = this.bot, me = bot.entity.position.floored();
    const roofy = (b) => b && b.boundingBox === 'block' && /stone|deepslate|andesite|diorite|granite|tuff|calcite|dirt|gravel|clay|ore$/.test(b.name);
    const mine = (p) => crumbs.some((c) => Math.abs(c.x - p.x) <= 1 && Math.abs(c.z - p.z) <= 1 && Math.abs(c.y - p.y) <= 2);
    let best = null, bs = -1e9;
    for (let dx = -24; dx <= 24; dx += 2) for (let dz = -24; dz <= 24; dz += 2) {
      if (dx * dx + dz * dz > 576) continue;
      for (let dy = 1; dy >= -12; dy--) {
        const p = me.offset(dx, dy, dz), feet = bot.blockAt(p);
        if (!feet) break;
        if (!this.isAir(feet) || !this.isAir(bot.blockAt(p.offset(0, 1, 0))) || !this.isSolid(bot.blockAt(p.offset(0, -1, 0)))) continue;
        let roof = false;
        for (let k = 2; k <= 5; k++) { const b = bot.blockAt(p.offset(0, k, 0)); if (b && !this.isAir(b)) { roof = roofy(b); break; } }
        if (!roof) continue;
        let open = 0;
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) if (this.isAir(bot.blockAt(p.offset(ax, 0, az)))) open++;
        if (open >= 4 && !seen.has(String(p)) && !mine(p) && !this.hazardAt(p)) {
          const score = -(Math.abs(dx) + Math.abs(dz)) - 0.5 * dy;
          if (score > bs) { bs = score; best = p; }
        }
        break;
      }
    }
    return best;
  }

  async offBuilds() {
    const bot = this.bot;
    const clearAt = (p) => {
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 1; dy++) {
        const b = bot.blockAt(p.offset(dx, dy, dz));
        if (b && PROTECTED_RE.test(b.name)) return false;
      }
      return true;
    };
    const me = bot.entity.position.floored();
    if (clearAt(me)) return;
    let best = null, bd = 99;
    for (let dx = -12; dx <= 12; dx += 2) for (let dz = -12; dz <= 12; dz += 2) {
      for (const dy of [0, 1, -1, 2, -2]) {
        const p = me.offset(dx, dy, dz);
        const feet = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0)), under = bot.blockAt(p.offset(0, -1, 0));
        if (!feet || !head || !under || !this.isAir(feet) || !this.isAir(head) || !this.isSolid(under) || this.isLiquid(under)) continue;
        if (!clearAt(p)) continue;
        const d = Math.abs(dx) + Math.abs(dz);
        if (d < bd) { bd = d; best = p; }
        break;
      }
    }
    if (best) await this.goto(new GoalBlock(best.x, best.y, best.z), { dig: false, timeout: 20000 }).catch((e) => { if (e.cancelled) throw e; });
  }

  async retrace(crumbs) {
    this.progress('heading back up');
    for (let i = crumbs.length - 1; i >= 0; i -= 3) {
      this.check();
      const c = crumbs[i];
      try { await this.goto(new GoalNear(c.x, c.y, c.z, 1), { dig: true, timeout: 12000 }); } catch (err) { if (err.cancelled) throw err; }
    }
    await this.backToPlayer({ timeout: 45000 });
  }

  async makeGear() {
    const made = [];
    const tryCraft = async (name, label) => {
      try { await this.craft(name); made.push(label || name.replace(/_/g, ' ')); } catch (err) { if (err.cancelled) throw err; }
    };
    if (this.bestTier('pickaxe') < 1) { await this.ensurePickaxe(1, { extraSticks: 4 }); made.push('stone pickaxe'); }
    await this.ensureSticks(4).catch((e) => { if (e.cancelled) throw e; });
    if (this.count('diamond') >= 3 && this.bestTier('pickaxe') < 3) await tryCraft('diamond_pickaxe');
    if (this.count('iron_ingot') >= 3 && this.bestTier('pickaxe') < 2) await tryCraft('iron_pickaxe');
    if (this.count('diamond') >= 2 && this.bestTier('sword') < 3) await tryCraft('diamond_sword');
    if (this.count('iron_ingot') >= 2 && this.bestTier('sword') < 2) await tryCraft('iron_sword');
    if (this.bestTier('sword') < 1 && this.count(/^(cobblestone|cobbled_deepslate)$/) >= 2) await tryCraft('stone_sword');
    if (this.bestTier('axe') < 1 && this.count(/^(cobblestone|cobbled_deepslate)$/) >= 3) await tryCraft('stone_axe');
    for (const [piece, cost] of [['iron_chestplate', 8], ['iron_leggings', 7], ['iron_helmet', 5], ['iron_boots', 4]]) {
      if (this.count('iron_ingot') >= cost && !this.find(piece)) await tryCraft(piece);
    }
    await this.equipArmor();
    this.c.equipBestWeapon();
    if (!made.length) throw new Nope('nothing new to make with what you have');
    return made.join(', ');
  }

  async equipArmor() {
    const slots = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
    for (const i of this.items()) {
      const m = /_(helmet|chestplate|leggings|boots)$/.exec(i.name);
      if (m) await this.bot.equip(i, slots[m[1]]).catch(() => {});
    }
  }

  async smeltAll() {
    const results = [];
    for (const input of ['raw_iron', 'raw_gold', ...Object.keys(RAW_FOOD)]) {
      const n = this.count(input);
      if (!n) continue;
      const got = await this.smelt(input, Math.min(n, 16));
      if (got) results.push(`${got} ${input.replace(/^raw_/, '')}`);
    }
    if (!results.length) throw new Nope('nothing to smelt');
    return results.join(', ');
  }

  async hunt() {
    if (this.coached()) return this.huntCoached();
    const bot = this.bot;
    const prey = Object.values(bot.entities)
      .filter((e) => PASSIVE_FOOD.includes(e.name) && e.position && e.position.distanceTo(bot.entity.position) < 40)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!prey) throw new Nope('no animals around here');
    const name = prey.displayName || prey.name;
    this.c.equipBestWeapon();
    bot.pathfinder.setMovements(this.walkMoves());
    bot.pvp.attack(prey);
    const t0 = Date.now();
    while (bot.entities[prey.id] && Date.now() - t0 < 25000) await this.wait(300);
    bot.pvp.stop();
    await this.wait(600);
    for (let i = 0; i < 4; i++) {
      const item = this.c.nearestItem(8);
      if (!item) break;
      await this.gotoNear(item.position, 0, { dig: false, timeout: 6000 }).catch((e) => { if (e.cancelled) throw e; });
      await this.wait(300);
    }
    return `got a ${String(name).toLowerCase()}`;
  }

  async huntCoached() {
    const bot = this.bot;
    const named = (e) => { const cn = e && e.metadata && e.metadata[2]; return !!(cn && (typeof cn === 'string' ? cn.trim() : JSON.stringify(cn).length > 4)); };
    const meat = () => Object.keys(RAW_FOOD).reduce((n, r) => n + this.count(r) + this.count(RAW_FOOD[r]), 0);
    const start = meat();
    const tried = new Set();
    let lastName = null;
    const roam = this.c && typeof this.c.f === 'function' && this.c.f('bodyRoam');

    const job = this.c && this.c.task ? this.c.task : this;
    job._roams = job._roams || 0;
    let roams = job._roams;
    for (let attempt = 0; attempt < 3 && meat() === start; attempt++) {
      this.check();
      const near = (r) => Object.values(bot.entities)
        .filter((e) => PASSIVE_FOOD.includes(e.name) && e.position && !tried.has(e.id) && !named(e) && e.position.distanceTo(bot.entity.position) < r)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      let prey = near(40) || (roam ? near(64) : null);

      while (!prey && roam && roams < 2) {
        roams++; job._roams = roams;
        if (roams === 1) this.progress('no animals right here, looking around');
        const a = Math.random() * Math.PI * 2, dist = 30 + Math.random() * 15, p = bot.entity.position;
        await this.goto(new GoalXZ(Math.round(p.x + Math.cos(a) * dist), Math.round(p.z + Math.sin(a) * dist)), { dig: false, timeout: 30000 }).catch((e) => { if (e.cancelled) throw e; });
        prey = near(48);
        this.dbg(`bodyRoam: walk ${roams}, ${prey ? `found a ${prey.name}` : 'nothing yet'}`);
      }
      if (!prey) break;
      tried.add(prey.id);
      lastName = String(prey.displayName || prey.name).toLowerCase();
      let died = false, where = prey.position.clone();
      const onDead = (e) => { if (e && e.id === prey.id) { died = true; if (e.position) where = e.position.clone(); } };
      bot.on('entityDead', onDead);
      try {
        this.c.equipBestWeapon();
        bot.pathfinder.setMovements(this.walkMoves());
        bot.pvp.attack(prey);
        const t0 = Date.now();
        while (!died && bot.entities[prey.id] && Date.now() - t0 < 25000) { if (prey.position) where = prey.position.clone(); await this.wait(250); }
      } finally {
        bot.removeListener('entityDead', onDead);
        try { bot.pvp.stop(); } catch {}
      }
      if (!died) continue;

      await this.wait(500);
      await this.gotoNear(where, 1, { dig: false, timeout: 8000 }).catch((e) => { if (e.cancelled) throw e; });
      for (let i = 0; i < 5 && meat() === start; i++) {
        const item = this.c.nearestItem(8);
        if (!item) { await this.wait(400); continue; }
        await this.gotoNear(item.position, 0, { dig: false, timeout: 6000 }).catch((e) => { if (e.cancelled) throw e; });
        await this.wait(300);
      }
    }
    if (meat() === start) throw new Nope(tried.size ? "couldn't catch anything" : 'no animals around here');
    return `got a ${lastName || 'animal'}`;
  }

  async lightUp() {
    if (this.count('torch') < 4) {
      if (!this.count(/^(coal|charcoal)$/)) {
        await this.mineOre('coal', 1, { maxMs: 2 * 60 * 1000 }).catch((e) => { if (e.cancelled) throw e; });
      }
      if (!this.count(/^(coal|charcoal)$/)) throw new Nope('no coal for torches');
      await this.ensureSticks(1);
      await this.craft('torch', Math.min(4, this.count(/^(coal|charcoal)$/)));
    }
    const o = this.owner();
    const center = (o ? o.position : this.bot.entity.position).floored();
    let lit = 0;
    for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) {
      if (!this.count('torch')) break;
      const spot = this.freeSpotNear(center.offset(dx, 0, dz), 0, 1);
      if (!spot) continue;
      try { await this.placeAt(spot, 'torch'); lit++; } catch (err) { if (err.cancelled) throw err; }
    }
    if (!lit) throw new Nope("couldn't find anywhere to put torches");
    return `${lit} torches around the player`;
  }

  async explore() {
    const bot = this.bot;
    const a = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 30;
    const p = bot.entity.position;
    const tx = Math.round(p.x + Math.cos(a) * dist), tz = Math.round(p.z + Math.sin(a) * dist);
    this.progress('walking around to look');
    await this.goto(new GoalXZ(tx, tz), { dig: false, timeout: 60000 }).catch((e) => { if (e.cancelled) throw e; });
    const found = [];
    const villager = Object.values(bot.entities).find((e) => e.name === 'villager');
    if (villager) found.push('a village');
    const ore = this.findBlocks([...ORES.diamond.blocks, ...ORES.iron.blocks, ...ORES.gold.blocks], { maxDistance: 20, count: 1, where: (b) => this.exposed(b) })[0];
    if (ore) found.push(`some ${ore.name.replace(/deepslate_|_ore/g, '')} in a cave`);
    const lava = this.findBlocks(['lava'], { maxDistance: 16, count: 1 })[0];
    if (lava) found.push('a lava pool');
    const water = this.findBlocks(['water'], { maxDistance: 16, count: 1 })[0];
    if (water && !found.length) found.push('some water');
    if (found.length) this.progress(`found ${found.join(' and ')} over here`, { big: !!villager || !!ore });
    await this.backToPlayer({ timeout: 60000 });
    return found.length ? `saw ${found.join(', ')}` : 'found nothing of note';
  }

  async backOffAfterToss(o) {
    const bot = this.bot;
    if (!o || !bot.entity) return;
    const away = bot.entity.position.minus(o.position);
    const len = Math.max(0.1, Math.hypot(away.x, away.z));
    const t = bot.entity.position.offset((away.x / len) * 3, 0, (away.z / len) * 3);
    await this.goto(new GoalNear(t.x, t.y, t.z, 1), { dig: false, timeout: 4000 }).catch((e) => { if (e.cancelled) throw e; });
    await this.wait(2200);
  }

  async tossTo(o, pick) {
    const bot = this.bot;
    for (let attempt = 0; attempt < 2; attempt++) {
      const stacks = this.items().filter(pick);
      if (!stacks.length) return;
      if (attempt > 0) await this.gotoNear(o.position, 2, { dig: false, timeout: 15000 }).catch((e) => { if (e.cancelled) throw e; });
      await bot.lookAt(o.position.offset(0, 0.2, 0)).catch(() => {});
      for (const it of stacks) { await bot.tossStack(it).catch(() => {}); await sleep(120); }
      await this.backOffAfterToss(o);
    }
  }

  itemIds() { return new Set(Object.values(this.bot.entities).filter((e) => e && e.name === 'item').map((e) => e.id)); }

  async retossLying(o, pick, pre, tries = 2) {
    const bot = this.bot;
    let lying = {};
    for (let again = 0; again < tries; again++) {
      this.check();
      const who = this.owner() || o;
      const near = Object.values(bot.entities).filter((e) => e && e.name === 'item' && e.position && (!pre || !pre.has(e.id)) && e.position.distanceTo(who.position) <= 6
        && (() => { try { const it = e.getDroppedItem(); return it && pick(it); } catch { return false; } })());
      if (!near.length) return {};
      const before = this.items().filter(pick).reduce((a, i) => a + i.count, 0);
      this.c._retossing = true;
      try {
        for (const e of near.slice(0, 6)) {
          this.check();
          if (!bot.entities[e.id]) continue;
          await this.gotoNear(e.position, 0, { dig: false, timeout: 5000 }).catch((err) => { if (err.cancelled) throw err; });
          await sleep(250);
        }
        await sleep(400);
      } finally { this.c._retossing = false; }
      const back = this.items().filter(pick).reduce((a, i) => a + i.count, 0) - before;
      this.dbg(`retossLying try ${again + 1}: ${near.length} stacks lying, picked ${back} back up`);

      if (back <= 0) return this.waitPickup(this.owner() || o, pick, 300, pre);
      await this.gotoNear(who.position, 1, { dig: false, timeout: 8000 }).catch((err) => { if (err.cancelled) throw err; });
      const me = bot.entity.position, at = (this.owner() || who).position;
      await bot.lookAt(me.offset((at.x - me.x) * 0.55, at.y - me.y + 0.05, (at.z - me.z) * 0.55)).catch(() => {});
      for (const it of this.items().filter(pick)) { await Promise.race([bot.tossStack(it), sleep(4000)]).catch(() => {}); await sleep(150); }
      if (this.coached()) await this.backOffAfterToss(who); else await sleep(1500);
      lying = await this.waitPickup(who, pick, 3000, pre);
      if (!Object.keys(lying).length) return {};
    }
    return lying;
  }

  async waitPickup(o, pick, ms = 3000, ignore = null) {
    const bot = this.bot;
    const t0 = Date.now();
    let lying = {};
    do {
      lying = {};
      const at = (this.owner() || o).position;
      for (const e of Object.values(bot.entities)) {
        if (e.name !== 'item' || !e.position || e.position.distanceTo(at) > 6 || (ignore && ignore.has(e.id))) continue;
        try { const it = typeof e.getDroppedItem === 'function' ? e.getDroppedItem() : null; if (it && pick(it)) lying[it.displayName] = (lying[it.displayName] || 0) + it.count; } catch {}
      }
      if (!Object.keys(lying).length) break;
      await this.wait(300);
    } while (Date.now() - t0 < ms);
    this.dbg(`waitPickup: still on the ground ${JSON.stringify(lying)}`);
    return lying;
  }

  async giveLoot() {
    const bot = this.bot;
    const o = this.owner();
    if (!o) throw new Nope("can't see the player to hand anything over");
    const loot = this.items().filter((i) => /diamond$|^iron_ingot$|^gold_ingot$|^emerald$|^raw_(iron|gold)$|^cooked_|^bread$/.test(i.name));
    if (!loot.length) throw new Nope('no loot to give the player');
    await this.gotoNear(o.position, 2, { dig: false, timeout: 30000 });
    if (this.coached()) {
      const names = loot.map((it) => `${it.count} ${it.displayName}`);
      const pick = (i) => /diamond$|^iron_ingot$|^gold_ingot$|^emerald$|^raw_(iron|gold)$|^cooked_|^bread$/.test(i.name);
      const pre = this.c && this.c.f && this.c.f('bodyHandover') ? this.itemIds() : null;
      await this.tossTo(o, pick);
      if (this.items().some(pick)) throw new Nope("couldn't get it over to the player (still with you)");
      if (this.c && this.c.f && this.c.f('bodyHandover')) {
        let lying = await this.waitPickup(o, pick, 3000, pre);

        if (Object.keys(lying).length && this.c && this.c.f && this.c.f('bodyToss')) {
          lying = await this.retossLying(o, pick, pre);

          const kept = this.items().filter(pick);
          if (kept.length) {
            const keptN = kept.reduce((a, i) => a + i.count, 0), lyingN = Object.values(lying).reduce((a, k) => a + k, 0);
            const total = loot.reduce((a, it) => a + it.count, 0), reached = Math.max(0, total - keptN - lyingN);
            const parts = [kept.map((i) => `${i.count} ${i.displayName}`).join(', ') + ' still with you', lyingN ? `${Object.entries(lying).map(([nm, k]) => `${k} ${nm}`).join(', ')} still on the ground by the player` : ''].filter(Boolean).join('; ');
            return reached ? `gave the player some of it (${parts})` : `couldn't hand it over (${parts})`;
          }
        }
        const left = Object.entries(lying).filter(([, n]) => n > 0);
        if (left.length) {
          const onGround = left.map(([name, n]) => `${n} ${name}`).join(', ');
          const total = loot.reduce((a, it) => a + it.count, 0), lyingN = left.reduce((a, [, n]) => a + n, 0);
          return lyingN >= total ? `dropped ${onGround} right by the player (still on the ground)` : `gave the player some of it: ${onGround} still on the ground by the player`;
        }
      }
      return `gave the player ${names.join(', ')}`;
    }
    await bot.lookAt(o.position.offset(0, 1.6, 0));
    const names = [];
    for (const it of loot) { await bot.tossStack(it).catch(() => {}); names.push(`${it.count} ${it.displayName}`); }
    return `gave the player ${names.join(', ')}`;
  }
}

module.exports = { Skills, Cancelled, Nope, houseBlueprint, sideToward, tierOf, ORES, PROTECTED_RE, LOG_RE, PLANKS_RE, REPLACEABLE, AIRISH, RAW_FOOD, PASSIVE_FOOD, taskCtx, sleep };
