'use strict';
// Playing alone when nobody gives orders: picks the next job from a goal ladder (shelter, tools, iron gear), stays safe
// at night and keeps fed. Off unless connect() is given solo settings.
const { goals } = require('mineflayer-pathfinder');
const { Nope } = require('./skills');

const { GoalNear, GoalXZ } = goals;
const { Vec3 } = require('vec3');
const FOOD_RE = /^(bread|cooked_[a-z_]+|baked_potato|apple|golden_apple|carrot|melon_slice|sweet_berries|pumpkin_pie|beef|porkchop|chicken|mutton|rabbit|cod|salmon|potato|beetroot|cookie|mushroom_stew|rabbit_stew|beetroot_soup|dried_kelp)$/;
const TICK_MS = 2000;
const STUCK_MS = 20000;
const RECOVER_MS = 4 * 60000;

class SoloDirector {
  constructor(c, opts = {}) {
    this.c = c;
    this.goals = new Set(opts.goals || []);
    this.cool = new Map();
    this.fails = new Map();
    this.ver = 0;
    this.cur = null;
    this.death = null;
    this.timer = null;
    this.watch = { pos: null, inv: '', at: 0 };
    this.missions = [];
  }

  get bot() { return this.c.bot; }
  get s() { return this.c.skills; }
  log(line) { try { this.c.emit('log', `solo: ${line}`); } catch {} }

  start() {
    if (this.timer || !this.bot) return;
    const bot = this.bot;

    this.safe = !!(typeof this.c.f === 'function' && this.c.f('bodySoloSafe'));

    this.water = this.safe && !!(typeof this.c.f === 'function' && this.c.f('bodySoloWater'));

    this.mem = this.safe && !!(typeof this.c.f === 'function' && this.c.f('bodySoloMem'));

    this.mem2 = this.mem && !!(typeof this.c.f === 'function' && this.c.f('bodySoloMem2'));

    this.day = this.safe && !!(typeof this.c.f === 'function' && this.c.f('bodySoloDay'));

    this.night2 = this.safe && !!(typeof this.c.f === 'function' && this.c.f('bodySoloNight'));
    this.breathe = this.safe && !!(typeof this.c.f === 'function' && this.c.f('bodySoloBreathe'));

    this.air = this.water && !!(typeof this.c.f === 'function' && this.c.f('bodySoloAir'));
    this.night3 = this.night2 && !!(typeof this.c.f === 'function' && this.c.f('bodySoloNight2'));
    this.cave2 = this.day && !!(typeof this.c.f === 'function' && this.c.f('bodySoloCave'));
    this.farm2 = this.day && !!(typeof this.c.f === 'function' && this.c.f('bodySoloFarm'));

    this.climb = this.air && !!(typeof this.c.f === 'function' && this.c.f('bodySoloClimb'));

    this.night4 = this.night3 && !!(typeof this.c.f === 'function' && this.c.f('bodySoloNight3'));

    if (this.safe && bot.pathfinder && !(bot.pathfinder.searchRadius > 0)) bot.pathfinder.searchRadius = 96;
    this._onDeath = () => {
      const p = bot.entity && bot.entity.position;
      const items = Math.max(bot.inventory ? bot.inventory.items().length : 0, this.safe ? this.lastItems || 0 : 0);
      this.death = p && items ? { pos: p.clone(), at: Date.now(), items } : null;
      if (this.cur) this.endMission('quit', 'I died');
    };
    bot.on('death', this._onDeath);
    this._onEvent = (e) => this.onEvent(e);
    this.c.on('event', this._onEvent);
    this.addJobs();
    if (this.safe) this.addSafeJobs();
    if (this.water) this.c.addTask('solo_explore', { label: 'exploring', run: (s) => this.dryExplore(s) });
    if (this.day) this.addDayJobs();
    if (this.night2) this.c.addTask('solo_dig_in', { label: 'digging in for the night', run: (s) => this.digIn(s) });
    if (this.night4) this.c.addTask('solo_shift', { label: 'finding a better spot', run: (s) => this.shift(s) });
    try { this.lastItems = bot.inventory.items().length; } catch {}
    this.timer = setInterval(() => { try { this.tick(); } catch (err) { this.log(`tick: ${err.message}`); } }, TICK_MS);
    this.log(`started (goals: ${[...this.goals].join(', ') || 'ladder'})`);
  }

  stop() {
    clearInterval(this.timer); this.timer = null;
    try { this.bot && this.bot.removeListener('death', this._onDeath); } catch {}
    try { this.c.removeListener('event', this._onEvent); } catch {}
  }

  addJobs() {
    const c = this.c;
    c.addTask('solo_recover', { label: 'going back for my stuff', run: async (s) => {
      const d = this.death;
      if (!d) throw new Nope('nothing to go back for');
      s.progress('heading back to where I died');
      await s.goto(new GoalNear(d.pos.x, d.pos.y, d.pos.z, 2), { dig: true, timeout: 120000 });
      let got = 0;
      for (let i = 0; i < 12; i++) {
        const it = c.nearestItem(10);
        if (!it) break;
        await s.gotoNear(it.position, 0, { dig: false, timeout: 8000 }).catch((e) => { if (e.cancelled) throw e; });
        await s.wait(350);
        got++;
      }
      this.death = null;
      return got ? 'got my stuff back' : 'went back, nothing left there';
    } });
    c.addTask('solo_home', { label: 'heading home for the night', run: async (s) => {
      const h = c.home;
      if (!h) throw new Nope('no home yet');
      await s.goto(new GoalNear(h.x, h.y, h.z, 1), { dig: true, timeout: 90000 });
      return 'home for the night';
    } });
    c.addTask('solo_food', { label: 'getting food', run: async (s) => {
      const f = c.v12.hands && c.v12.hands.fetcher;
      if (!f) throw new Nope('no way to get food');
      await f.food(s, 4);
      const n = s.items().filter((i) => FOOD_RE.test(i.name)).reduce((a, i) => a + i.count, 0);
      if (!n) throw new Nope('no food around here');
      return `got food (${n})`;
    } });
    c.addTask('solo_armor', { label: 'making iron armor', run: async (s) => {
      const f = c.v12.hands && c.v12.hands.fetcher;
      if (!f) throw new Nope('no way to get iron');
      if (!s.find('iron_chestplate')) await f.craft(s, 'iron_chestplate', 1);
      await s.equipArmor();
      return 'made an iron chestplate and put it on';
    } });
  }

  addSafeJobs() {
    const c = this.c;
    c.addTask('solo_surface', { label: 'getting out of the water', run: async (s) => {
      const bot = s.bot;

      if (!this.water) bot.setControlState('jump', true);
      try {

        if (this.air) await this.comeUp(s);
        const me = bot.entity.position;

        const lands = bot.findBlocks({ point: me, maxDistance: 16, count: this.climb ? 600 : 80, matching: (b) => b && b.boundingBox === 'block' && !/water|lava|leaves|ice/.test(b.name) })
          .filter((p) => { const a = bot.blockAt(p.offset(0, 1, 0)), a2 = bot.blockAt(p.offset(0, 2, 0)); return a && a2 && /^(air|cave_air|short_grass|tall_grass)$/.test(a.name) && /^(air|cave_air|short_grass|tall_grass)$/.test(a2.name); })
          .filter((p) => !this.water || p.y >= Math.floor(me.y) - 1)
          .sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
        const land = lands[0];
        if (!land && this.water) return await this.swimBack(s);
        if (!land) throw new Nope('no land in sight');
        for (const l of this.water ? lands.slice(0, 3) : [land]) {

          try { await s.goto(new GoalNear(l.x, l.y + 1, l.z, 1), { dig: true, timeout: this.water ? 7000 : 8000 }); if (!this.air || !this.inWater()) return 'out of the water'; }
          catch (err) { if (err.cancelled) throw err; }
          if (this.air && this.inWater()) await this.comeUp(s);
          if (!this.inWater() && bot.entity.onGround) return 'out of the water';
        }

        if (this.climb && land.y >= Math.floor(bot.entity.position.y) + 1) {
          try { const r = await this.climbOut(s, land); if (r) return r; } catch (err) { if (err.cancelled) throw err; this.log(`climb out: ${err.message}`); }
          if (!this.inWater() && bot.entity.onGround) return 'climbed out of the water';
        }
        if (this.water) bot.setControlState('jump', true);

        const end = Date.now() + 20000;
        while (Date.now() < end) {
          s.check();
          await bot.lookAt(land.offset(0.5, this.water ? 1 : 1.6, 0.5), true).catch(() => {});
          bot.setControlState('forward', true); bot.setControlState('jump', true);
          await s.wait(250);
          if (!this.inWater() && bot.entity.onGround) return 'swam out of the water';
        }
        if (this.water) return await this.swimBack(s);
        throw new Nope("couldn't get out of the water");
      } finally { bot.setControlState('jump', false); bot.setControlState('forward', false); }
    } });
    c.addTask('solo_burrow', { label: 'digging in for the night', run: async (s) => {
      const bot = s.bot;
      const feet = bot.entity.position.floored();
      for (const dy of [1, 2]) await s.digAt(feet.offset(0, -dy, 0)).catch((e) => { if (e.cancelled) throw e; });
      await s.wait(800);
      const nf = bot.entity.position.floored();
      if (nf.y > feet.y - 1) throw new Nope("couldn't dig down here");
      const roof = nf.offset(0, 2, 0);
      if (!s.find(/^(dirt|cobblestone|cobbled_deepslate|netherrack|stone)$/)) throw new Nope('nothing to close the roof with');
      await s.placeAt(roof, /^(dirt|cobblestone|cobbled_deepslate|netherrack|stone)$/);
      c.home = { x: nf.x, y: nf.y, z: nf.z };
      return 'dug in for the night';
    } });
  }

  hasBed() {
    const s = this.s, bot = this.bot;
    if (s.find(/_bed$/)) return true;
    const h = this.c.home;
    if (!h) return false;
    try { return s.findBlocks(Object.keys(s.data.blocksByName).filter((n) => /_bed$/.test(n)), { point: new Vec3(h.x, h.y, h.z), maxDistance: 8, count: 1 }).length > 0; } catch { return false; }
  }

  dayLadder(st) {
    const L = [];
    if (this.goals.has('cave')) {
      L.push(
        { key: 'coal', done: st.count('coal') >= 4, job: 'mine_n', args: { kind: 'coal', n: 4 }, why: 'coal for torches' },
        { key: 'iron_ore', done: st.count('raw_iron') + st.count('iron_ingot') >= 3, job: 'mine_n', args: { kind: 'iron', n: 3 }, why: 'iron next' },
        { key: 'back_home', done: !st.home || Math.hypot(st.pos.x - st.home.x, st.pos.z - st.home.z) <= 4, job: 'solo_back', args: {}, why: 'got what I came for, heading home' });

      if (this.cave2) {
        const got = st.count('coal') >= 4 && st.count('raw_iron') + st.count('iron_ingot') >= 3;
        const late = st.t >= 11500 && st.t < 23500;
        if (!got && !late) L[2].done = true;
        if (!got && late) L[2].why = "it's getting late, heading home";
      }
      return L;
    }
    if (this.goals.has('farm')) {
      L.push({ key: 'farm', done: st.farm, job: 'solo_farm', args: {}, why: 'time to start a farm' });
      return L;
    }
    L.push(
      { key: 'wooden_pickaxe', done: st.pick >= 0, job: 'craft_item', args: { item: 'wooden_pickaxe', keep: true }, why: 'I need a pickaxe to get going' },
      { key: 'stone_pickaxe', done: st.pick >= 1, job: 'craft_item', args: { item: 'stone_pickaxe', keep: true }, why: 'stone tools next' },
      { key: 'stone_sword', done: st.sword >= 1, job: 'craft_item', args: { item: 'stone_sword', keep: true }, why: 'something to fight with' },
      { key: 'food_stock', done: st.food >= 4, job: 'solo_food', args: {}, why: 'some food for later' },
      { key: 'wool', done: st.bed || st.wool >= 3, job: 'solo_wool', args: {}, why: 'wool for a bed' },
      { key: 'bed', done: st.bed, job: 'solo_bed', args: {}, why: 'making a bed' },
      { key: 'house', done: st.house, job: 'solo_house', args: {}, why: 'time to build a house' },
      { key: 'torches', done: st.count('torch') >= 8, job: 'craft_item', args: { item: 'torch', n: 8, keep: true }, why: 'torches so I can see' },
      { key: 'furnace', done: st.has('furnace'), job: 'craft_item', args: { item: 'furnace', keep: true }, why: 'a furnace for iron' },
      { key: 'iron_pickaxe', done: st.pick >= 2, job: 'craft_item', args: { item: 'iron_pickaxe', keep: true }, why: 'iron pickaxe time' },
      { key: 'iron_sword', done: st.sword >= 2, job: 'craft_item', args: { item: 'iron_sword', keep: true }, why: 'an iron sword' },
      { key: 'farm', done: st.farm || !st.has('water_bucket'), job: 'solo_farm', args: {}, why: 'a farm by the house' },
      { key: 'iron_chestplate', done: st.chest, job: 'solo_armor', args: {}, why: 'iron armor' },
      { key: 'diamonds', done: st.count('diamond') >= 3, job: 'mine_n', args: { kind: 'diamond', n: 3 }, why: 'going for diamonds' });
    return L;
  }

  buildSpots(w, l, n = 3, radius = 16) {
    const bot = this.bot, me = bot.entity.position.floored();
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
    const solid = (b) => !!b && b.boundingBox === 'block' && !/leaves|water|lava|ice|_log$|_wood$/.test(b.name);
    const clear = (b) => !b || (b.boundingBox === 'empty' && !/water|lava|bubble/.test(b.name));
    const sky = (b) => !b || b.skyLight == null || b.skyLight >= 14;
    const h = this.c.v12 && this.c.v12.hands;
    const cmd = h && h.cmd;
    let B = null; try { B = require('./builder'); } catch {}
    const cand = [];
    for (let dx = -radius; dx <= radius; dx += 2) for (let dz = -radius; dz <= radius; dz += 2) {
      for (let dy = 4; dy >= -4; dy--) {
        const x = me.x + dx, y = me.y + dy, z = me.z + dz;
        const f = at(x, y, z);
        if (!clear(f) || !clear(at(x, y + 1, z)) || !solid(at(x, y - 1, z))) continue;
        if (sky(f)) cand.push({ x, y, z, d: Math.hypot(dx, dz) + Math.abs(dy) });
        break;
      }
    }
    cand.sort((a, b) => a.d - b.d);
    const out = [];
    const wet = (p) => { for (let x = p.x - 1; x <= p.x + w; x++) for (let z = p.z - 1; z <= p.z + l; z++) for (let y = p.y - 1; y <= p.y + 1; y++) { const b = at(x, y, z); if (b && /water|lava/.test(b.name)) return true; } return false; };
    for (const c of cand.slice(0, 80)) {
      const p = { x: c.x - Math.floor(w / 2), y: c.y, z: c.z - Math.floor(l / 2) };
      if (wet(p)) continue;
      if (cmd && B && typeof cmd.prepareSite === 'function') {
        try { const plan = B.hutPlan({ x0: p.x, y0: p.y, z0: p.z, w, l, h: 3, door: 'south', pal: B.palette({ style: 'rustic' }), label: 'check' }); cmd.prepareSite(this.s, plan); } catch { continue; }
      }
      out.push(p);
      if (out.length >= n) break;
    }
    return out;
  }

  async levelSpot(s, n = 9, what = 'house') {
    const bot = s.bot, me = bot.entity.position.floored();
    const h = this.c.v12 && this.c.v12.hands;
    const B = require('./builder');
    if (!h || !h.builder) throw new Nope("can't build right now");
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
    const soft = /^(air|cave_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow)$|leaves|_log$|_wood$|flower|tulip|daisy|poppy|dandelion|orchid|allium|bluet|cornflower|lily_of|sapling|vine|bush|mushroom/;
    const ground = (x, z) => {
      for (let y = me.y + 10; y >= me.y - 10; y--) {
        const b = at(x, y, z);
        if (!b) return null;
        if (soft.test(b.name)) continue;
        if (/water|lava|ice/.test(b.name)) return { y, wet: true };
        return { y, wet: false };
      }
      return null;
    };
    const half = Math.floor(n / 2);
    let best = null;
    for (const [ox, oz] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [10, 10], [-10, 10], [10, -10], [-10, -10], [12, 0], [-12, 0], [0, 12], [0, -12]]) {
      const cx = me.x + ox, cz = me.z + oz;
      const hs = [];
      let bad = false;
      for (let dx = -half; dx <= half && !bad; dx++) for (let dz = -half; dz <= half && !bad; dz++) {
        const g = ground(cx + dx, cz + dz);
        if (!g || g.wet) bad = true; else hs.push(g.y);
      }
      if (bad) continue;
      const sorted = [...hs].sort((a, b) => a - b);
      const y0 = sorted[Math.floor(sorted.length / 2)] + 1;
      const cost = hs.reduce((a, g) => a + Math.abs(g + 1 - y0), 0) + Math.hypot(ox, oz);
      const sky = at(cx, y0 + 1, cz);
      if (sky && sky.skyLight != null && sky.skyLight < 12) continue;
      if (!best || cost < best.cost) best = { cx, cz, y0, cost };
    }
    if (!best) throw new Nope('no dry open ground to level here');
    s.progress(`leveling the ground for my ${what}`);
    const plan = B.clearPlan({ cx: best.cx, y0: best.y0, cz: best.cz, w: n, l: n, above: 6, getBlock: (x, y, z) => at(x, y, z) });
    if (plan.cells.length > 450) throw new Nope('too much ground to move here');
    await h.builder.run(s, plan, { label: 'leveling', say: false });
    return best;
  }

  async bedInside(s) {
    const hb = this.houseBuilt, bot = s.bot;
    if (!hb || !s.find(/_bed$/)) return false;
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
    const isBed = (b) => b && /_bed$/.test(b.name);
    const y = hb.y0, x0 = hb.x0 + 1, x1 = hb.x0 + hb.size - 2, z0 = hb.z0 + 1, z1 = hb.z0 + hb.size - 2;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (isBed(at(x, y, z))) return true;
    const free = (x, z) => { const b = at(x, y, z), up = at(x, y + 1, z), fl = at(x, y - 1, z); return x >= x0 && x <= x1 && z >= z0 && z <= z1 && b && b.boundingBox === 'empty' && up && up.boundingBox === 'empty' && fl && fl.boundingBox === 'block'; };
    const DIRS = [[0, -1, 0], [0, 1, Math.PI], [-1, 0, Math.PI / 2], [1, 0, -Math.PI / 2]];
    const tries = [];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) for (const [dx, dz, yaw] of DIRS) if (free(x, z) && free(x + dx, z + dz)) tries.push({ x, z, dx, dz, yaw });
    for (const t of tries.filter((q) => free(q.x - q.dx, q.z - q.dz)).slice(0, 6)) {
      s.check();

      const stand = { x: t.x - t.dx, z: t.z - t.dz };
      if (!free(stand.x, stand.z)) continue;
      try { await s.goto(new GoalNear(stand.x + 0.5, y, stand.z + 0.5, 0), { dig: false, timeout: 8000 }); } catch (e) { if (e.cancelled) throw e; continue; }
      const bed = s.find(/_bed$/);
      if (!bed) return false;
      try {
        await bot.equip(bed, 'hand');
        await bot.look(t.yaw, 0.6, true);
        await bot.placeBlock(at(t.x, y - 1, t.z), new Vec3(0, 1, 0));
      } catch {}
      await s.wait(300);
      if (isBed(at(t.x, y, t.z))) return true;
    }
    return false;
  }

  async digIn(s) {
    const bot = s.bot;
    const at = (p) => bot.blockAt(p);
    const pick = s.bestTier('pickaxe') >= 0;
    const soft = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|mud|moss_block|clay|snow_block)$/;
    const hard = /^(stone|deepslate|andesite|diorite|granite|tuff|cobblestone|terracotta|sandstone)$/;
    const diggable = (b) => !!b && b.boundingBox === 'block' && (soft.test(b.name) || (pick && hard.test(b.name)));
    const BLOCKS = /^(dirt|cobblestone|cobbled_deepslate|netherrack|stone|deepslate|granite|diorite|andesite|tuff|coarse_dirt|rooted_dirt|mud|clay)$/;
    const me = bot.entity.position.floored();
    const solidAt = (p) => { const b = at(p); return !!b && b.boundingBox === 'block' && !/water|lava/.test(b.name); };
    const SIDES4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    const openSides = (x, y, z) => { let n = 0; for (const dy of [0, 1]) for (const [dx, dz] of SIDES4) if (!solidAt(new Vec3(x + dx, y + dy, z + dz))) n++; return n; };
    const seal = async (nf) => {
      for (const dy of [0, 1]) for (const [dx, dz] of SIDES4) {
        const p = nf.offset(dx, dy, dz);
        if (solidAt(p)) continue;
        if (!s.find(BLOCKS)) throw new Nope('nothing to close it up with');
        await s.placeAt(p, BLOCKS).catch((e) => { if (e.cancelled) throw e; });
      }
      if (solidAt(nf.offset(0, 2, 0))) return;
      if (!s.find(BLOCKS)) throw new Nope('nothing to close the roof with');
      await s.placeAt(nf.offset(0, 2, 0), BLOCKS);
    };

    if (this.night3 && bot.entity.onGround) {
      const bag = s.count(BLOCKS);
      const open = openSides(me.x, me.y, me.z);
      if (open <= 3 && open + 1 <= bag && solidAt(me.offset(0, -1, 0))) {
        try { await seal(me); this.c.home = { x: me.x, y: me.y, z: me.z }; return 'closed myself in for the night'; } catch (e) { if (e.cancelled) throw e; }
      }
    }
    const spots = [];
    const R = this.night3 ? 8 : 3;
    for (let r = 0; r <= R; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) spots.push(me.offset(dx, 0, dz));

    let cands = spots;
    if (this.night3) {
      const bag = s.count(BLOCKS);
      const scored = [];
      for (const f0 of spots) {
        let f = null;
        for (const dy of [0, 1, -1, 2, -2]) { const q = f0.offset(0, dy, 0), b = at(q), b1 = at(q.offset(0, 1, 0)), g = at(q.offset(0, -1, 0)); if (b && b1 && g && b.boundingBox === 'empty' && b1.boundingBox === 'empty' && g.boundingBox === 'block' && !/water|lava/.test(b.name)) { f = q; break; } }
        if (!f) continue;
        const open = openSides(f.x, f.y - 2, f.z);
        if (open > bag + 1) continue;
        scored.push({ f, k: open * 3 + Math.hypot(f.x - me.x, f.z - me.z) + Math.abs(f.y - me.y) });
      }
      cands = scored.sort((a, b) => a.k - b.k).map((x) => x.f);
    }
    let last = null, tried = 0;
    for (const f of cands) {
      if (tried >= 6) break;
      s.check();
      const a = at(f), a1 = at(f.offset(0, 1, 0)), d1 = at(f.offset(0, -1, 0)), d2 = at(f.offset(0, -2, 0)), d3 = at(f.offset(0, -3, 0));
      if (!a || !a1 || a.boundingBox !== 'empty' || a1.boundingBox !== 'empty' || /water|lava/.test(a.name)) continue;
      if (!diggable(d1) || !diggable(d2)) { last = "can't dig down here"; continue; }
      if (!d3 || d3.boundingBox !== 'block' || /water|lava/.test(d3.name)) { last = 'there is a drop or water under here'; continue; }
      if (s.hazardAt && (s.hazardAt(f.offset(0, -1, 0)) || s.hazardAt(f.offset(0, -2, 0)))) { last = 'lava or water next to it'; continue; }
      tried++;
      try {
        if (!bot.entity.position.floored().equals(f)) await s.goto(new GoalNear(f.x + 0.5, f.y, f.z + 0.5, 0), { dig: false, timeout: this.night3 ? 9000 : 5000 });
        const end = Date.now() + 1500;
        while (Date.now() < end && Math.hypot(bot.entity.position.x - (f.x + 0.5), bot.entity.position.z - (f.z + 0.5)) > 0.2) {
          await bot.lookAt(new Vec3(f.x + 0.5, bot.entity.position.y + bot.entity.height * 0.9, f.z + 0.5), true).catch(() => {});
          bot.setControlState('forward', true); await s.wait(80); bot.setControlState('forward', false);
        }
        bot.setControlState('forward', false);
        for (const dy of [1, 2]) await s.digAt(f.offset(0, -dy, 0));
        await s.wait(700);
        if (bot.entity.position.floored().y > f.y - 2) await s.goto(new GoalNear(f.x + 0.5, f.y - 2, f.z + 0.5, 0), { dig: false, timeout: 3000 }).catch((e) => { if (e.cancelled) throw e; });

        if (this.night3 && bot.entity.position.floored().y > f.y - 2) {
          const end2 = Date.now() + 2500;
          while (Date.now() < end2 && bot.entity.position.floored().y > f.y - 2) {
            await bot.lookAt(new Vec3(f.x + 0.5, f.y - 1, f.z + 0.5), true).catch(() => {});
            bot.setControlState('forward', true); await s.wait(100); bot.setControlState('forward', false); await s.wait(100);
          }
        }

        for (let i = 0; i < (this.night3 ? 4 : 2); i++) { const it = this.c.nearestItem(2); if (!it) break; await s.wait(300); }
        const nf = bot.entity.position.floored();
        if (nf.y !== f.y - 2 || nf.x !== f.x || nf.z !== f.z) { last = "couldn't get down into it"; continue; }
        if (this.night3) { await seal(nf); this.c.home = { x: nf.x, y: nf.y, z: nf.z }; return 'dug in for the night'; }
        for (const dy of [0, 1]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const p = nf.offset(dx, dy, dz), b = at(p);
          if (b && b.boundingBox === 'block' && !/water|lava/.test(b.name)) continue;
          if (!s.find(BLOCKS)) throw new Nope('nothing to close it up with');
          await s.placeAt(p, BLOCKS).catch((e) => { if (e.cancelled) throw e; });
        }
        if (!s.find(BLOCKS)) throw new Nope('nothing to close the roof with');
        await s.placeAt(nf.offset(0, 2, 0), BLOCKS);
        this.c.home = { x: nf.x, y: nf.y, z: nf.z };
        return 'dug in for the night';
      } catch (e) {
        bot.setControlState('forward', false);
        if (e.cancelled) throw e;
        last = e.message || String(e);
      }
    }
    throw new Nope(last || "couldn't dig in here");
  }

  addDayJobs() {
    const c = this.c;
    const named = (e) => { const cn = e && e.metadata && e.metadata[2]; return !!(cn && (typeof cn === 'string' ? cn.trim() : JSON.stringify(cn).length > 4)); };
    c.addTask('solo_wool', { label: 'getting wool for a bed', run: async (s) => {
      const bot = s.bot;
      const tried = new Set();
      let walks = 0;
      for (let i = 0; i < 8 && s.count(/_wool$/) < 3; i++) {
        s.check();
        const sheep = Object.values(bot.entities)
          .filter((e) => e && e.name === 'sheep' && e.position && !tried.has(e.id) && !named(e) && e.position.distanceTo(bot.entity.position) < 48)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        if (!sheep) {
          if (walks >= 2) break;
          walks++;
          if (walks === 1) s.progress('no sheep right here, looking around');
          const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 15, p = bot.entity.position;
          await s.goto(new GoalXZ(Math.round(p.x + Math.cos(a) * d), Math.round(p.z + Math.sin(a) * d)), { dig: false, timeout: 30000 }).catch((e) => { if (e.cancelled) throw e; });
          continue;
        }
        tried.add(sheep.id);
        let died = false, where = sheep.position.clone();
        const onDead = (e) => { if (e && e.id === sheep.id) { died = true; if (e.position) where = e.position.clone(); } };
        bot.on('entityDead', onDead);
        try {
          c.equipBestWeapon();
          bot.pathfinder.setMovements(s.walkMoves());
          bot.pvp.attack(sheep);
          const t0 = Date.now();
          while (!died && bot.entities[sheep.id] && Date.now() - t0 < 25000) { if (sheep.position) where = sheep.position.clone(); await s.wait(250); }
        } finally { bot.removeListener('entityDead', onDead); try { bot.pvp.stop(); } catch {} }
        if (!died) continue;
        await s.wait(500);
        await s.gotoNear(where, 1, { dig: false, timeout: 8000 }).catch((e) => { if (e.cancelled) throw e; });
        for (let k = 0; k < 4; k++) {
          const item = c.nearestItem(8);
          if (!item) { await s.wait(300); continue; }
          await s.gotoNear(item.position, 0, { dig: false, timeout: 6000 }).catch((e) => { if (e.cancelled) throw e; });
          await s.wait(300);
        }
      }
      const n = s.count(/_wool$/);
      if (n < 3) throw new Nope(n ? `only found ${n} wool` : 'no sheep around here');
      return `got ${n} wool`;
    } });
    c.addTask('solo_bed', { label: 'making a bed', run: async (s) => {
      const f = c.v12.hands && c.v12.hands.fetcher;
      if (!f) throw new Nope("can't craft right now");
      const colors = {};
      for (const it of s.items()) { const m = /^(.+)_wool$/.exec(it.name); if (m) colors[m[1]] = (colors[m[1]] || 0) + it.count; }
      const color = Object.keys(colors).sort((a, b) => colors[b] - colors[a])[0];
      if (!color || colors[color] < 3) throw new Nope('I need 3 wool of one color for a bed');

      const kinds = {};
      for (const it of s.items()) { const m = /^(.+)_planks$/.exec(it.name); if (m) kinds[m[1]] = (kinds[m[1]] || 0) + it.count; }
      if (!Object.values(kinds).some((n) => n >= 3)) {
        const log = s.items().find((i) => /_(log|stem)$/.test(i.name) && !/stripped/.test(i.name));
        if (log) { const wood = log.name.replace(/_(log|stem)$/, ''); await s.craft(`${wood}_planks`, 1).catch((e) => { if (e.cancelled) throw e; }); }
        else if (f) await f.get(s, 'log', 1, { depth: 1, quiet: true }).catch((e) => { if (e.cancelled) throw e; }).then(async () => { const l2 = s.items().find((i) => /_(log|stem)$/.test(i.name)); if (l2) await s.craft(`${l2.name.replace(/_(log|stem)$/, '')}_planks`, 1).catch(() => {}); });
      }
      await f.craft(s, `${color}_bed`, 1, 1);
      if (!s.find(/_bed$/)) throw new Nope("couldn't make the bed");
      return `made a ${color.replace(/_/g, ' ')} bed`;
    } });
    c.addTask('solo_house', { label: 'building my house', run: async (s) => {
      const h = c.v12 && c.v12.hands, cmd = h && h.cmd;
      const B = require('./builder');
      if (!cmd || !h.builder) throw new Nope("can't build right now");

      let size = 7, spots = this.buildSpots(7, 7, 3, 20);
      if (spots.length) s.progress('found a good flat spot for my house');
      else {
        const lv = await this.levelSpot(s, 9).catch((e) => { if (e.cancelled) throw e; this.log(`leveling: ${e.message}`); return null; });
        if (lv) spots = [{ x: lv.cx - 3, y: lv.y0, z: lv.cz - 3 }];
      }
      if (!spots.length) { size = 5; spots = this.buildSpots(5, 5, 3, 28); if (spots.length) s.progress('only room for a small house here'); }
      if (!spots.length) throw new Nope('no flat open spot for a house near here');
      let last = null;
      for (const p of spots) {
        s.check();
        try {
          const pal = B.palette({ style: 'rustic' });
          if (!s.count(/glass$/)) pal.window = [];
          let plan = B.hutPlan({ x0: p.x, y0: p.y, z0: p.z, w: size, l: size, h: 3, door: 'south', pal, furniture: true, label: `${size}x${size} house` });
          plan = cmd.prepareSite(s, plan);
          const r = await h.builder.run(s, plan, { label: 'my house' });
          if (r.done < 0.8) throw new Nope(`only got ${r.placed} blocks placed`);
          this.houseBuilt = { at: Date.now(), inside: plan.inside, x0: p.x, y0: p.y, z0: p.z, size };
          c.home = plan.inside;
          const bed = await this.bedInside(s).catch((e) => { if (e.cancelled) throw e; return false; });
          return bed ? 'built my house and put my bed in' : 'built my house';
        } catch (e) {
          if (e.cancelled) throw e;
          last = e.message || String(e);
          if (!/in the way|uneven|see that spot|find a way|get to|took too long/.test(last)) throw e;
        }
      }
      throw new Nope(last || 'no good spot for a house');
    } });
    c.addTask('solo_back', { label: 'heading back home', run: async (s) => {
      const h = c.home;
      if (!h) throw new Nope('no home yet');
      await s.goto(new GoalNear(h.x, h.y, h.z, 2), { dig: true, timeout: 120000 });
      return 'back home';
    } });
    c.addTask('solo_farm', { label: 'making a farm', run: async (s) => {
      const h = c.v12 && c.v12.hands, cmd = h && h.cmd;
      const B = require('./builder');
      if (!h || !h.builder) throw new Nope("can't build right now");
      if (!s.count('water_bucket')) throw new Nope('I need a water bucket for the farm');
      const f = h.fetcher;
      if (!s.find(/_hoe$/) && f) await f.craft(s, 'wooden_hoe', 1, 1);
      if (s.count('wheat_seeds') < 8 && f) await f.get(s, 'wheat_seeds', 16, { depth: 1, quiet: true }).catch((e) => { if (e.cancelled) throw e; });
      const bot = s.bot;

      const me = bot.entity.position.floored();
      let spots = this.buildSpots(7, 7, this.farm2 ? 14 : 6, 28).filter((p) => !(me.x >= p.x - 1 && me.x <= p.x + 7 && me.z >= p.z - 1 && me.z <= p.z + 7));

      const tillable = (p) => { let n = 0, t = 0; for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { if (!dx && !dz) continue; t++; const b = bot.blockAt(new Vec3(p.x + 3 + dx, p.y - 1, p.z + 3 + dz)); if (b && /^(dirt|grass_block|dirt_path|coarse_dirt|farmland)$/.test(b.name)) n++; } return n / t; };
      if (this.farm2) spots = spots.filter((p) => tillable(p) >= 0.85);
      if (!spots.length) {
        const lv = await this.levelSpot(s, 9, 'farm').catch((e) => { if (e.cancelled) throw e; this.log(`leveling: ${e.message}`); return null; });
        if (lv) { spots = [{ x: lv.cx - 3, y: lv.y0, z: lv.cz - 3 }]; await s.goto(new GoalNear(lv.cx, lv.y0, lv.cz + 6, 1), { dig: false, timeout: 15000 }).catch((e) => { if (e.cancelled) throw e; }); }
        if (this.farm2 && spots.length && tillable(spots[0]) < 0.85) { spots = []; throw new Nope('no dirt or grass here to farm on'); }
      }
      if (!spots.length) throw new Nope(this.farm2 ? 'no flat dirt or grass near here to farm on' : 'no flat open spot for a farm near here');
      let last = null;
      for (const p of spots.slice(0, 3)) {
        s.check();
        const cx = p.x + 3, cz = p.z + 3;
        try {
          await s.goto(new GoalNear(cx, p.y, cz + 5, 1), { dig: false, timeout: 25000 });
          const plan = B.farmPlan({ cx, y0: p.y, cz, size: 5, gate: 'south' });
          await h.builder.run(s, plan, { label: 'farm', fetch: false });
          const planted = plan.cells.filter((x) => x.op === 'plant' && h.builder.isDone(s, x)).length;
          if (!planted) throw new Nope("couldn't plant anything");
          this.farmDone = { at: Date.now(), planted, cx, cz, y: p.y };
          return `made a farm, ${planted} planted`;
        } catch (e) {
          if (e.cancelled) throw e;

          if (this.farm2) await this.takeWaterBack(s, new Vec3(cx, p.y - 1, cz)).catch((e2) => { if (e2.cancelled) throw e2; });
          last = e.message || String(e);
          if (!/in the way|uneven|find a way|get to|took too long/.test(last)) throw e;
        }
      }
      throw new Nope(last || 'no good spot for a farm');
    } });
  }

  state() {
    const s = this.s, bot = this.bot;
    const t = bot.time && bot.time.timeOfDay != null ? bot.time.timeOfDay : 6000;
    const food = s.items().filter((i) => FOOD_RE.test(i.name)).reduce((a, i) => a + i.count, 0);
    const armor = (bot.inventory.slots || []).some((it, i) => it && i >= 5 && i <= 8 && /chestplate/.test(it.name));
    return {
      t, night: t >= 13000 && t <= 23000, dusk: t >= 11500 && t < 13000,
      pick: s.bestTier('pickaxe'), sword: s.bestTier('sword'), food, hunger: bot.food,
      chest: armor || !!s.find('iron_chestplate'),
      home: this.c.home, pos: bot.entity.position,
      has: (n) => s.count(n) > 0, count: (n) => s.count(n),
      wool: this.day ? s.count(/_wool$/) : 0, bed: this.day ? this.hasBed() : false, house: !!this.houseBuilt, farm: !!this.farmDone
    };
  }

  ladder(st) {
    if (this.day) return this.dayLadder(st);
    const L = [
      { key: 'wooden_pickaxe', done: st.pick >= 0, job: 'craft_item', args: { item: 'wooden_pickaxe', keep: true }, why: 'I need a pickaxe to get going' },
      { key: 'stone_pickaxe', done: st.pick >= 1, job: 'craft_item', args: { item: 'stone_pickaxe', keep: true }, why: 'stone tools next' }
    ];
    if (this.goals.has('halloween')) {
      L.push({ key: 'jack_o_lantern', done: st.has('jack_o_lantern'), job: 'craft_item', args: { item: 'jack_o_lantern', keep: true }, why: "it's Halloween, I want a jack o'lantern" });
    }
    L.push(
      { key: 'stone_sword', done: st.sword >= 1, job: 'craft_item', args: { item: 'stone_sword', keep: true }, why: 'something to fight with' },
      { key: 'shelter', done: !!st.home, job: 'quick_hut', args: {}, why: 'a shelter before night' },
      { key: 'food_stock', done: st.food >= 4, job: 'solo_food', args: {}, why: 'some food for later' },
      { key: 'furnace', done: st.has('furnace'), job: 'craft_item', args: { item: 'furnace', keep: true }, why: 'a furnace for iron' },
      { key: 'torches', done: st.count('torch') >= 8, job: 'craft_item', args: { item: 'torch', n: 8, keep: true }, why: 'torches so I can see' },
      { key: 'iron_pickaxe', done: st.pick >= 2, job: 'craft_item', args: { item: 'iron_pickaxe', keep: true }, why: 'iron pickaxe time' },
      { key: 'iron_sword', done: st.sword >= 2, job: 'craft_item', args: { item: 'iron_sword', keep: true }, why: 'an iron sword' },
      { key: 'iron_chestplate', done: st.chest, job: 'solo_armor', args: {}, why: 'iron armor' },
      { key: 'diamonds', done: st.count('diamond') >= 3, job: 'mine_n', args: { kind: 'diamond', n: 3 }, why: 'going for diamonds' }
    );
    return L;
  }

  next(st) {
    const now = Date.now();
    const ok = (key) => !(this.cool.get(key) > now);
    const J = (key, name, args, why) => ({ key, name, args, why });
    if (this.safe && this.inWater() && ok('solo_surface')) return J('solo_surface', 'solo_surface', {}, "I'm in the water, getting out first");
    if (this.death && now - this.death.at < RECOVER_MS && ok('solo_recover')) return J('solo_recover', 'solo_recover', {}, 'my stuff is still where I died');
    if (this.day && st.t >= 12542 && st.t <= 23458 && st.bed && ok('sleep')) {
      const h = st.home;
      if (h && Math.hypot(st.pos.x - h.x, st.pos.z - h.z) > 4 && ok('solo_home')) return J('solo_home', 'solo_home', {}, 'heading home to sleep');
      return J('sleep', 'sleep', {}, "it's night, bed time");
    }
    if (this.day && st.dusk && st.house && st.home && Math.hypot(st.pos.x - st.home.x, st.pos.z - st.home.z) > 4 && ok('solo_home')) return J('solo_home', 'solo_home', {}, "it's getting dark, heading home");
    if (this.day && st.t >= 12000 && st.t < 23000 && st.house && st.home && Math.hypot(st.pos.x - st.home.x, st.pos.z - st.home.z) <= 4) return null;
    if ((st.night || st.dusk) && !st.home && ok('shelter')) return J('shelter', 'quick_hut', {}, st.night ? "it's night and I have no shelter" : "it's getting dark, shelter first");

    if (this.night4 && (st.night || st.dusk) && !st.home && (this.fails.get('burrow') || 0) >= 2 && ok('night_move')) return J('night_move', 'solo_shift', {}, "can't dig in here, finding a better spot");
    if (this.safe && (st.night || st.dusk) && !st.home && ok('burrow')) return J('burrow', this.night2 ? 'solo_dig_in' : 'solo_burrow', {}, "the hut won't go up here, digging in instead");
    if (this.night2 && st.night && !st.home) return null;
    if (st.night && st.home) {
      const h = st.home;
      if (Math.hypot(st.pos.x - h.x, st.pos.z - h.z) > 4 && ok('solo_home')) return J('solo_home', 'solo_home', {}, 'heading home for the night');
      return null;
    }
    if (st.hunger < 10 && !st.food && ok('food_now')) return J('food_now', 'solo_food', {}, "I'm getting hungry");

    if (this.cave2 && this.caveMove && !(st.t >= 11500 && st.t < 23500) && ok('cave_move')) return J('cave_move', this.water ? 'solo_explore' : 'explore', {}, 'no luck here, trying somewhere else');
    for (const step of this.ladder(st)) {
      if (step.done || !ok(step.key)) continue;
      return J(step.key, step.job, step.args, step.why);
    }
    if (ok('explore')) return J('explore', this.water ? 'solo_explore' : 'explore', {}, 'looking around for what to do next');
    return null;
  }

  tick() {
    const c = this.c, bot = this.bot;
    if (!bot || !bot.entity || c.state !== 'online' || c.diedAt) return;
    const now = Date.now();
    try { this.lastItems = bot.inventory.items().length; } catch {}
    try { if (this.water && bot.entity.onGround && !this.inWater()) this.lastLand = bot.entity.position.clone(); } catch {}
    if (c.task && this.safe && c.task.name !== 'solo_surface' && this.inWater() && (bot.oxygenLevel != null && bot.oxygenLevel < 14)) {
      this.log(`running out of air on ${c.task.label}, getting out of the water`);
      if (this.cur) this.endMission('quit', 'running out of air');
      c.cancelTask('getting out of the water');
      this.cool.delete('solo_surface');
      const r = c.command('solo_surface', {}, { src: 'solo' });
      if (r && r.ok) { this.cur = { key: 'solo_surface', name: 'solo_surface', label: 'getting out of the water', why: 'running out of air', at: now }; this.mission('start', { committed: true, why: 'running out of air' }); }
      return;
    }
    if (this.breathe) this.breatheCheck(now);
    if (this.mem) this.memGuard(now);

    if (this.day && c.task && this.houseBuilt && c.home && !/^(solo_home|sleep|solo_back|solo_surface|quick_hut|solo_burrow|solo_house|solo_recover)$/.test(c.task.name)) {
      const t = bot.time && bot.time.timeOfDay;
      if (t >= 12000 && t < 23000 && (!this.duskAt || now - this.duskAt > 60000)) {
        this.duskAt = now;
        this.log(`getting dark, dropping ${c.task.label} to head home`);
        if (this.cur) this.endMission('quit', "it's getting dark, heading home");
        c.cancelTask("it's getting dark");
        return;
      }
    }
    if (c.task) { this.watchStuck(now); return; }
    if (bot.pvp && bot.pvp.target) return;
    const st = this.state();
    const pick = this.next(st);
    if (!pick) return;
    const r = c.command(pick.name, pick.args, { src: 'solo' });
    if (r && r.ok) {
      const label = c.task ? c.task.label : pick.name;
      this.cur = { key: pick.key, name: pick.name, label, why: pick.why, at: now };
      this.watch = { pos: bot.entity.position.clone(), inv: this.invSig(), at: now };
      this.mission('start', { committed: true, why: pick.why });
    } else {
      this.cool.set(pick.key, now + 60000);
      this.log(`couldn't start ${pick.name}: ${r && (r.reason || r.ask) || 'no answer'}`);
    }
  }

  async swimBack(s) {
    const bot = s.bot;
    const to = this.lastLand || null;
    const end = Date.now() + 45000;
    let yaw = bot.entity.yaw;
    while (Date.now() < end) {
      s.check();
      if (to) await bot.lookAt(to.offset(0, 1.6, 0), true).catch(() => {}); else await bot.look(yaw, 0, true).catch(() => {});
      bot.setControlState('forward', true); bot.setControlState('jump', true);
      await s.wait(250);
      if (!this.inWater() && bot.entity.onGround) return 'swam back to land';
      const land = bot.findBlocks({ point: bot.entity.position, maxDistance: 10, count: 1, matching: (b) => b && b.boundingBox === 'block' && !/water|lava|leaves|ice/.test(b.name) })[0];
      if (land) { await bot.lookAt(land.offset(0.5, 1.6, 0.5), true).catch(() => {}); }
    }
    throw new Nope("couldn't get back to land");
  }

  async comeUp(s) {
    const bot = s.bot;
    const headWet = () => { try { const h = bot.blockAt(bot.entity.position.offset(0, 1.62, 0)); return !!h && /water|bubble_column/.test(h.name); } catch { return false; } };
    if (!headWet()) return false;
    const me = bot.entity.position.floored();
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
    const wetOrOpen = (b) => !!b && (/water|bubble_column|kelp|seagrass/.test(b.name) || b.boundingBox === 'empty');
    let best = null;
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
      if (!wetOrOpen(at(me.x + dx, me.y, me.z + dz)) || !wetOrOpen(at(me.x + dx, me.y + 1, me.z + dz))) continue;
      let top = null;
      for (let y = me.y + 1; y <= me.y + 12; y++) {
        const b = at(me.x + dx, y, me.z + dz);
        if (!b) break;
        if (/water|bubble_column|kelp|seagrass/.test(b.name)) continue;
        if (b.boundingBox === 'empty') top = y;
        break;
      }
      if (top == null) continue;
      const d = Math.hypot(dx, dz) + (top - me.y) * 0.3;
      if (!best || d < best.d) best = { x: me.x + dx, z: me.z + dz, y: top, d };
    }
    s.progress && s.progress('coming up for air');
    const end = Date.now() + 8000;
    try {
      while (Date.now() < end && headWet()) {
        s.check();
        const p = bot.entity.position;
        if (best) {
          const far = Math.hypot(best.x + 0.5 - p.x, best.z + 0.5 - p.z);
          await bot.lookAt(new Vec3(best.x + 0.5, far > 0.6 ? p.y + 1.4 : best.y + 1, best.z + 0.5), true).catch(() => {});
          bot.setControlState('forward', far > 0.4);
        } else await bot.look(bot.entity.yaw, Math.PI / 2, true).catch(() => {});
        bot.setControlState('jump', true);
        await s.wait(150);
      }
    } finally { bot.setControlState('forward', false); }
    return !headWet();
  }

  async takeWaterBack(s, p) {
    const bot = s.bot;
    if (s.count('water_bucket') || !s.count('bucket')) return false;
    const b = bot.blockAt(p);
    if (!b || !/water/.test(b.name)) return false;
    await s.gotoNear(p, 2, { dig: false, timeout: 8000 }).catch((e) => { if (e.cancelled) throw e; });
    const bucket = s.find('bucket');
    if (!bucket) return false;
    await bot.equip(bucket, 'hand').catch(() => {});
    await bot.lookAt(p.offset(0.5, 0.9, 0.5), true).catch(() => {});
    try { bot.activateItem(); await s.wait(250); bot.deactivateItem(); } catch {}
    await s.wait(300);
    return s.count('water_bucket') > 0;
  }

  async climbOut(s, land) {
    const bot = s.bot;
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
    const wet = (b) => !!b && /water|bubble_column|kelp|seagrass/.test(b.name);
    const solid = (b) => !!b && b.boundingBox === 'block' && !wet(b) && !/lava/.test(b.name);
    const open = (b) => !!b && b.boundingBox === 'empty' && !wet(b) && !/lava/.test(b.name);
    const BLOCKS = /^(dirt|cobblestone|cobbled_deepslate|stone|deepslate|granite|diorite|andesite|tuff|netherrack|coarse_dirt|sand|gravel|sandstone)$/;
    if (this.air) await this.comeUp(s);
    const p0 = bot.entity.position.floored();
    let ws = p0.y;
    while (wet(at(p0.x, ws + 1, p0.z)) && ws < p0.y + 8) ws++;
    if (!wet(at(p0.x, ws, p0.z))) { if (wet(at(p0.x, ws - 1, p0.z))) ws--; else return null; }
    const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const toLand = (x, z) => Math.hypot(land.x - x, land.z - z);
    const swimTo = async (x, z, ms = 6000) => {
      const end = Date.now() + ms;
      try {
        while (Date.now() < end) {
          s.check();
          const p = bot.entity.position;
          if (Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) < 0.35) return true;
          await bot.lookAt(new Vec3(x + 0.5, ws + 1.2, z + 0.5), true).catch(() => {});
          bot.setControlState('forward', true); bot.setControlState('jump', true);
          await s.wait(120);
        }
      } finally { bot.setControlState('forward', false); }
      return false;
    };
    const hop = async (x, z, top) => {
      const end = Date.now() + 2500;
      try {
        while (Date.now() < end) {
          s.check();
          await bot.lookAt(new Vec3(x + 0.5, top + 0.6, z + 0.5), true).catch(() => {});
          bot.setControlState('forward', true); bot.setControlState('jump', true);
          await s.wait(120);
          const q = bot.entity.position;
          if (bot.entity.onGround && !this.inWater() && q.y >= top - 0.01) return true;
        }
      } finally { bot.setControlState('forward', false); bot.setControlState('jump', false); }
      return false;
    };

    const cands = [];
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
      const x = p0.x + dx, z = p0.z + dz;
      if (!wet(at(x, ws, z)) || !open(at(x, ws + 1, z)) || !open(at(x, ws + 2, z))) continue;
      const wall = D4.find(([ax, az]) => solid(at(x + ax, ws, z + az)) || solid(at(x + ax, ws + 1, z + az)));
      if (!wall) continue;
      const from = D4.map(([ax, az]) => [x + ax, z + az]).filter(([fx, fz]) => wet(at(fx, ws, fz)) && open(at(fx, ws + 1, fz))).sort((a, b) => Math.hypot(a[0] - p0.x, a[1] - p0.z) - Math.hypot(b[0] - p0.x, b[1] - p0.z))[0];
      cands.push({ x, z, wall, from, k: Math.hypot(dx, dz) + toLand(x, z) * 0.5 });
    }
    cands.sort((a, b) => a.k - b.k);
    const have = () => s.find(BLOCKS);
    s.progress('climbing out of here');
    for (const c of cands.slice(0, 3)) {
      s.check();
      if (have() && c.from) {
        if (!(await swimTo(c.from[0], c.from[1]))) continue;
        const [ax, az] = c.wall;
        const ref = solid(at(c.x + ax, ws, c.z + az)) ? at(c.x + ax, ws, c.z + az) : null;
        const blk = have();
        try {
          await bot.equip(blk, 'hand');
          if (ref) await bot.placeBlock(ref, new Vec3(-ax, 0, -az));
          else await s.placeAt(new Vec3(c.x, ws, c.z), BLOCKS);
        } catch (e) { if (e.cancelled) throw e; }
        await s.wait(200);
        if (!solid(at(c.x, ws, c.z))) continue;
        if (!(await hop(c.x, c.z, ws + 1))) continue;
      } else {

        const [ax, az] = c.wall;
        const wx = c.x + ax, wz = c.z + az;
        if (!solid(at(wx, ws, wz))) continue;
        if (!(await swimTo(c.x, c.z))) continue;
        for (const y of [ws + 1, ws + 2]) if (!open(at(wx, y, wz))) await s.digAt(new Vec3(wx, y, wz)).catch((e) => { if (e.cancelled) throw e; });
        if (!open(at(wx, ws + 1, wz)) || !open(at(wx, ws + 2, wz))) continue;
        if (!(await hop(wx, wz, ws + 1))) continue;
      }

      this.log(`climb out: on a step at y ${Math.floor(bot.entity.position.y)}, heading up to the land`);
      await s.goto(new GoalNear(land.x, land.y + 1, land.z, 1), { dig: true, timeout: 30000 }).catch((e) => { if (e.cancelled) throw e; });
      if (!this.inWater() && bot.entity.onGround) return 'climbed out of the water';
    }
    return null;
  }

  async shift(s) {
    const bot = s.bot, p = bot.entity.position;
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
    for (let i = 0; i < 12; i++) {
      s.check();
      const a = Math.random() * Math.PI * 2, d = 8 + Math.random() * 8;
      const x = Math.round(p.x + Math.cos(a) * d), z = Math.round(p.z + Math.sin(a) * d);
      let top = null;
      for (let y = Math.floor(p.y) + 6; y > Math.floor(p.y) - 6; y--) {
        const b = at(x, y, z);
        if (!b) break;
        if (b.boundingBox === 'empty' && !/water|lava/.test(b.name)) continue;
        top = b; break;
      }
      if (!top || !/^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mycelium|moss_block)$/.test(top.name)) continue;
      const a1 = at(x, top.position.y + 1, z), a2 = at(x, top.position.y + 2, z);
      if (!a1 || !a2 || a1.boundingBox !== 'empty' || a2.boundingBox !== 'empty') continue;
      s.progress('finding a better spot for the night');
      await s.goto(new GoalNear(x, top.position.y + 1, z, 1), { dig: false, timeout: 15000 });
      return 'found a better spot';
    }
    throw new Nope('nowhere better around here');
  }

  sees(bot) {
    try {
      const me = bot.entity.position;
      if (Object.values(bot.entities || {}).some((e) => e.position && /^(cow|pig|sheep|chicken|rabbit)$/.test(String(e.name || '')) && e.position.distanceTo(me) <= 16)) return true;
      const ids = Object.values(bot.registry.blocksByName).filter((b) => /_log$/.test(b.name)).map((b) => b.id);
      return bot.findBlocks({ matching: ids, maxDistance: 12, count: 3 }).length >= 3;
    } catch { return false; }
  }
  async dryExplore(s) {
    const bot = s.bot, p = bot.entity.position;
    if (this.exploreA == null) this.exploreA = Math.random() * Math.PI * 2;
    const sawAtStart = this.sees(bot);
    for (let i = 0; i < 10; i++) {
      if (i === 3 || i === 6) this.exploreA = Math.random() * Math.PI * 2;
      const a = this.exploreA + (Math.random() - 0.5) * 0.6, d = 60 + Math.random() * 40;
      const x = Math.round(p.x + Math.cos(a) * d), z = Math.round(p.z + Math.sin(a) * d);
      let top = null;
      for (let y = Math.floor(p.y) + 30; y > Math.floor(p.y) - 25; y--) {
        const b = bot.blockAt(new (require('vec3').Vec3)(x, y, z));
        if (!b) break;
        if (/^(air|cave_air|void_air)$/.test(b.name) || /leaves|grass$|fern|flower|bush|vine/.test(b.name)) continue;
        top = b; break;
      }
      if (!top || /water|lava|ice/.test(top.name)) continue;
      s.progress('going for a little walk to look around');
      const from = bot.entity.position.clone();
      let found = false;
      const look = setInterval(() => { if (!sawAtStart && bot.entity.position.distanceTo(from) > 15 && this.sees(bot)) { found = true; try { bot.pathfinder.stop(); } catch {} } }, 2000);
      try { await s.goto(new GoalNear(x, top.position.y + 1, z, 3), { dig: false, timeout: 60000 }).catch((e) => { if (e.cancelled) throw e; }); }
      finally { clearInterval(look); }

      if (bot.entity.position.distanceTo(from) < 10) continue;
      this.exploreA = a;
      return found ? 'walked somewhere new, trees or animals in sight' : 'walked somewhere new';
    }
    throw new Nope('only water around here');
  }

  inWater() {
    try {
      const bot = this.bot, p = bot.entity.position;
      const head = bot.blockAt(p.offset(0, 1.6, 0));
      return !!(bot.entity.isInWater || (head && /water/.test(head.name)));
    } catch { return false; }
  }

  breatheCheck(now) {
    const bot = this.bot;
    try {
      const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0));
      if (!head || head.boundingBox !== 'block' || /water|lava|bedrock/.test(head.name)) return;
      if (this.breathAt && now - this.breathAt < 1500) return;
      this.breathAt = now;
      this.log(`stuck inside ${head.name}, digging out`);
      bot.dig(head, true).catch(() => {});
    } catch {}
  }

  memGuard(now) {
    const c = this.c, pf = this.bot && this.bot.pathfinder;
    if (!pf) return;
    const mining = !!(c.task && (/mine|mining|dig|ore/.test(c.task.name) || /iron|diamond|gold|coal|mining|digging/.test(c.task.label || '') || c.task.name === 'solo_armor'))
      || !!(this.mem2 && this.s && this.s._mining > 0);
    pf.searchRadius = mining ? 24 : 96;
    pf.thinkTimeout = mining ? 2000 : 5000;
    let heap = 0;
    try { heap = process.memoryUsage().heapUsed; } catch {}
    if (heap > 900 * 1024 * 1024 && c.task && (!this.memAt || now - this.memAt > 20000)) {
      this.memAt = now;
      this.log(`memory at ${Math.round(heap / 1048576)} MB on ${c.task.label}, dropping it`);
      const key = this.cur ? this.cur.key : null;
      if (this.cur) this.endMission('quit', 'taking a break from that');
      if (key) this.cool.set(key, now + 5 * 60000);
      try { pf.stop(); pf.setGoal(null); } catch {}
      c.cancelTask('memory');
    }
  }

  invSig() { try { return this.bot.inventory.items().map((i) => `${i.name}${i.count}`).sort().join(','); } catch { return ''; } }

  watchStuck(now) {
    const bot = this.bot, w = this.watch;
    const moved = w.pos && bot.entity.position.distanceTo(w.pos) > 1.5;
    const inv = this.invSig();
    if (moved || inv !== w.inv || !w.at) { this.watch = { pos: bot.entity.position.clone(), inv, at: now }; return; }
    if (now - w.at > STUCK_MS && this.cur) {
      this.log(`stuck on ${this.cur.label} for ${Math.round((now - w.at) / 1000)} s, dropping it`);
      const key = this.cur.key;
      this.endMission('quit', 'got stuck');
      this.cool.set(key, now + 3 * 60000);
      this.c.cancelTask('stuck');
      this.watch = { pos: null, inv: '', at: 0 };
    }
  }

  onEvent(e) {
    if (!this.cur || !e) return;
    if (e.event === 'task_done') {
      this.fails.set(this.cur.key, 0);
      if (this.safe && this.cur.name === 'quick_hut' && !this.c.home && this.bot && this.bot.entity) { const p = this.bot.entity.position.floored(); this.c.home = { x: p.x, y: p.y, z: p.z }; }
      if (this.safe && this.cur.key === 'explore') this.cool.set('explore', Date.now() + 2 * 60000);
      if (this.cur.key === 'cave_move') this.caveMove = false;
      if (this.cur.key === 'night_move') { this.fails.set('burrow', 0); this.fails.set('shelter', 0); this.cool.delete('burrow'); this.cool.delete('shelter'); }

      try { const step = this.ladder(this.state()).find((x) => x.key === this.cur.key); if (step && !step.done) this.cool.set(this.cur.key, Date.now() + 3 * 60000); } catch {}
      this.endMission('done', e.data && e.data.result);
    }
    else if (e.event === 'task_failed') {
      const k = this.cur.key, n = (this.fails.get(k) || 0) + 1;
      this.fails.set(k, n);
      let wait = k === 'solo_surface' ? 3000 : Math.min(10, 2 * n) * 60000;
      if (this.day && k === 'sleep') wait = 20000;
      if (this.night2 && (k === 'burrow' || k === 'shelter')) { try { const st = this.state(); if ((st.night || st.dusk) && !st.home) wait = k === 'burrow' ? 15000 : 45000; } catch {} }
      if (this.cave2 && this.goals.has('cave') && (k === 'coal' || k === 'iron_ore')) { this.caveMove = true; wait = 20000; }
      if (k === 'cave_move') { this.caveMove = false; wait = 20000; }
      if (k === 'night_move') wait = 20000;
      this.cool.set(k, Date.now() + wait);
      this.endMission('quit', e.data && e.data.reason);
    }
  }

  endMission(phase, why) {
    if (!this.cur) return;
    this.mission(phase, { committed: false, why: String(why || '').slice(0, 160) });
    this.cur = null;
  }

  mission(phase, extra) {
    this.ver++;
    const m = this.cur || {};
    const rec = { phase, mission: m.label || null, job: m.name || null, key: m.key || null, state_version: this.ver, at: Date.now(), ...extra };
    this.missions.push(rec);
    if (this.missions.length > 200) this.missions.shift();
    try { this.c.emitEvent('mission', rec, null); } catch {}
  }
}

module.exports = { SoloDirector };
