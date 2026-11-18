// Installs the command, builder, places and little-games modules on the body. Each checks its own switch (features.js).
const { Places, worldKey } = require('./places');
const { Fetcher } = require('./fetcher');
const { Builder, info } = require('./builder');
const { Commands } = require('./commands');
const { MiniGames } = require('./minigames');
const { taskCtx, Nope, LOG_RE, PROTECTED_RE } = require('./skills');
const spec = require('./commandspec');
const { oneOf } = require('./fetcher');
const { Ledger } = require('../shared/ledger');
const { Vec3 } = require('vec3');

const SWITCHES = ['commands', 'builder', 'miniGames', 'initiative', 'memory2', 'freeBuild'];
const MOVING = new Set(['follow', 'stay', 'flee', 'attack', 'guard', 'pick_up', 'stop_task', 'come']);
const INSTANT = { come: 'come', go_there: 'goThere', go_home: 'goHome', lead_back: 'leadBack', recover_items: 'recoverItems', kill_that: 'killThat', leave_it: 'leaveIt', protect: 'protect', fall_back: 'fallBack', remember_place: 'rememberPlace', house_rule: 'houseRule', forget_place: 'forgetPlace' };
const ORE_OF = { mine_coal: 'coal', mine_iron: 'iron', mine_gold: 'gold', mine_diamonds: 'diamond' };
const BUILD_JOBS = new Set(['build', 'quick_hut', 'dig_box', 'clear_area', 'fill_hole', 'cover_liquid', 'bridge', 'door', 'seal', 'farm', 'help_build', 'build_shape']);
const lbl = (x) => String(x || '').replace(/_/g, ' ');

function shapeLabel(a = {}) {
  const b = lbl(a.block || 'dirt');
  switch (a.shape || 'tower') {
    case 'tower': return `stacking a ${a.h || 8} high ${b} tower`;
    case 'wall': return `building a ${b} wall`;
    case 'floor': return `laying a ${a.size || '5x5'} ${b} floor`;
    case 'cube': return `building a ${a.hollow ? 'hollow ' : ''}${b} cube`;
    case 'ring': return `putting ${b} walls around ${a.size || '5x5'}`;
    case 'stairs': return `building ${b} stairs`;
    case 'path': return `laying a ${b} path`;
    case 'pyramid': return `building a ${b} pyramid`;
    default: return `building that out of ${b}`;
  }
}

const JOBS = {
  get_item: { sw: 'commands', label: (a) => (a.item && /log$|^log$/.test(a.item) && !a.n ? 'chopping wood' : `getting ${a.n ? `${a.n} ` : ''}${lbl(a.item === 'log' ? 'logs' : a.item || 'stuff')}`), run: (k, s, a) => k.getItemJob(s, a) },
  get_food: { sw: 'commands', label: () => 'getting food', run: (k, s, a) => k.getFoodJob(s, a) },
  craft_item: { sw: 'commands', label: (a) => `making ${a.n > 1 ? `${a.n} ` : ''}${lbl(a.item || 'something')}`, run: (k, s, a) => k.craftItemJob(s, a) },
  make_armor: { sw: 'commands', label: (a) => `making ${/diamond/.test(a.item || '') ? 'diamond' : 'iron'} armor${a.who === 'both' ? ' for you and the player' : ''}`, run: (k, s, a) => k.makeArmorJob(s, a) },
  smelt_item: { sw: 'commands', label: (a) => `smelting${a.item ? ` ${lbl(a.item)}` : ''}`, run: (k, s, a) => k.smeltItemJob(s, a) },
  teach_recipe: { sw: 'commands', label: (a) => `showing the player how to make ${a.item ? oneOf(a.item) : 'it'}`, run: (k, s, a) => k.teachRecipeJob(s, a) },
  mine_vein: { sw: 'commands', label: () => 'mining out that vein', run: (k, s, a) => k.mineVeinJob(s, a) },
  dig_down: { sw: 'commands', label: (a) => (a.y != null && a.y <= -50 ? 'digging down to diamond level' : `digging down to y ${a.y ?? -58}`), run: (k, s, a) => k.digDownJob(s, a) },
  strip_mine: { sw: 'commands', label: () => 'strip mining', run: (k, s, a) => k.stripMineJob(s, a) },
  dig_tunnel: { sw: 'commands', label: (a) => `digging a tunnel${a.len ? `, ${a.len} blocks` : ''}`, run: (k, s, a) => k.digTunnelJob(s, a) },
  place_block: { sw: 'commands', label: (a) => `putting down ${oneOf(a.item || 'block')}`, run: (k, s, a) => k.placeBlockJob(s, a) },
  water_bucket: { sw: 'commands', label: () => 'getting a water bucket', run: (k, s, a) => k.waterBucketJob(s, a) },
  harvest: { sw: 'commands', label: () => 'harvesting the crops', run: (k, s, a) => k.harvestJob(s, a) },
  shear: { sw: 'commands', label: () => 'shearing sheep', run: (k, s, a) => k.shearJob(s, a) },
  look_around: { sw: 'commands', label: () => 'climbing up to look around', run: (k, s, a) => k.lookAroundJob(s, a) },
  find: { sw: 'commands', label: (a) => `looking for a ${a.kind === 'cave' ? 'cave' : a.kind === 'water' ? 'lake' : 'village'}`, run: (k, s, a) => k.findJob(s, a) },
  base_spot: { sw: 'commands', label: () => 'scouting a spot for a base', run: (k, s, a) => k.baseSpotJob(s, a) },
  sleep: { sw: 'commands', label: () => 'going to bed', run: (k, s, a) => k.sleepJob(s, a) },
  give_item: { sw: 'commands', label: (a) => `handing over ${lbl(a.item || 'stuff')}`, run: (k, s, a) => k.giveItemJob(s, a) },
  mine_n: { sw: 'commands', label: (a) => ({ coal: 'mining for coal', iron: 'mining for iron', gold: 'mining for gold', diamond: 'digging for diamonds' }[a.kind] || 'mining'), run: (k, s, a) => s.mineOre(a.kind, Math.max(1, Math.min(64, a.n || 3))) },
  build: { sw: 'builder', label: (a) => `building a ${a.size ? `${a.size} ` : ''}${a.style ? `${a.style} ` : ''}${a.kind === 'house' || (a.w || 0) >= 8 ? 'house' : 'hut'}`, run: (k, s, a) => k.buildJob(s, a) },
  quick_hut: { sw: 'builder', label: () => 'building a dirt hut', run: (k, s, a) => k.quickHutJob(s, a) },
  dig_box: { sw: 'builder', label: (a) => (a.h ? 'digging out a room' : 'digging a hole'), run: (k, s, a) => k.digBoxJob(s, a) },
  clear_area: { sw: 'builder', label: (a) => `clearing a ${a.size || '10x10'} area`, run: (k, s, a) => k.clearAreaJob(s, a) },
  fill_hole: { sw: 'builder', label: () => 'filling in the hole', run: (k, s, a) => k.fillHoleJob(s, a) },
  cover_liquid: { sw: 'builder', label: (a) => (a.kind === 'water' || a.kind === 'pond' ? 'draining the water' : 'covering the lava'), run: (k, s, a) => k.coverLiquidJob(s, a) },
  bridge: { sw: 'builder', label: () => 'building a bridge', run: (k, s, a) => k.bridgeJob(s, a) },
  door: { sw: 'builder', label: () => 'putting in a door', run: (k, s, a) => k.doorJob(s, a) },
  seal: { sw: 'builder', label: () => 'sealing off the cave', run: (k, s, a) => k.sealJob(s, a) },
  farm: { sw: 'builder', label: (a) => `making a ${a.size || '9x9'} wheat farm`, run: (k, s, a) => k.farmJob(s, a) },
  help_build: { sw: 'builder', label: () => "helping with the player's build", run: (k, s, a) => k.helpBuildJob(s, a) },
  undo: { sw: 'builder', label: () => 'taking back the last build', run: (k, s, a) => k.undoJob(s, a) },

  build_shape: { sw: 'freeBuild', label: (a) => shapeLabel(a), run: (k, s, a) => k.shapeJob(s, a) },
  race: { sw: 'miniGames', label: () => 'racing the player', run: (k, s, a) => k.h.games.raceJob(s, a) },
  timed_gather: { sw: 'miniGames', label: (a) => `a ${a.mins || 2} minute gathering race`, run: (k, s, a) => k.h.games.gatherJob(s, a) },
  spar: { sw: 'miniGames', label: () => 'sparring with the player', run: (k, s, a) => k.h.games.sparJob(s, a) },
  own_thing: { sw: 'initiative', label: () => 'doing your own thing', run: (k, s, a) => k.ownThingJob(s, a) },
  plan: { sw: 'initiative', label: (a) => `working through the plan (${(a.steps || []).map(lbl).join(', then ')})`, run: (k, s, a) => k.planJob(s, a) },
  detour: { sw: 'initiative', label: (a) => `grabbing that ${a.what || 'thing'}`, run: (k, s, a) => k.detourJob(s, a) }
};

const NEEDS = {
  get_item: (a) => (!a.item && !a.wood ? 'the player did not say which item' : null),
  craft_item: (a) => (!a.item ? 'the player did not say what to make' : null),
  teach_recipe: (a) => (!a.item ? 'the player did not say which item to show' : null),
  place_block: (a) => (!a.item ? 'the player did not say which block to put down' : null),
  give_item: (a) => (!a.item ? 'the player did not say which item' : null),
  plan: (a) => (!a.steps || a.steps.length < 2 ? 'the player did not give at least 2 steps' : null)
};

class Hands {
  constructor(c) {
    this.c = c;
    this.places = new Places();
    this.fetcher = new Fetcher(this);
    this.builder = new Builder(this);
    this.cmd = new Commands(this);
    this.games = new MiniGames(this);
    this.ledger = new Ledger({
      progress: { gapMs: 0, kindGapMs: 20000 }, progressForce: { gapMs: 0, kindGapMs: 5000 }, failed: { gapMs: 10000 },
      gameOffer: { gapMs: 20 * 60 * 1000, perWindow: [2, 60 * 60 * 1000] }, gameIdea: { gapMs: 0 },
      detour: { gapMs: 0, kindGapMs: 5 * 60 * 1000, perWindow: [3, 30 * 60 * 1000] }, curiosity: { gapMs: 0, kindGapMs: 8 * 60 * 1000 },
      duskHut: { gapMs: 20 * 60 * 1000 }, sleepHint: { gapMs: 30 * 60 * 1000 }, ask: { gapMs: 8000 }
    });
    this.registered = new Set();
    this.origTasks = new Map();
    this.wrappedHostiles = false;
    this.recentGifts = [];
    this.playerBlocks = [];
    this.botPlaced = [];
    this.pathStatus = null;
    this.lastDeath = null;
    this.lastOwnerPos = null;
    this.lastFreeTimeAt = 0;
    this.lastCmd = null;
    this.currentBuild = null;
    this.spawnedAt = 0;
    this.worldLoaded = false;
    this.lastScan = 0;
    this.lastSave = 0;
    this.offers = { plan: null, base: null };
    c.on('event', (e) => { try { this.onCompanionEvent(e); } catch (err) { c.emit('log', `hands event: ${err.message}`); } });
  }

  on(id) { return this.c.f(id); }
  anyOn() { return SWITCHES.some((id) => this.c.f(id)); }

  setStorage(dir) { this.places.setStorage(dir); }

  onFeatures(f) {
    for (const [name, def] of Object.entries(JOBS)) {
      const want = !!f[def.sw];
      if (want && !this.registered.has(name)) {
        this.c.addTask(name, { label: def.label({}), run: (s, args) => this.runJob(name, s, args) });
        this.registered.add(name);
      } else if (!want && this.registered.has(name)) {
        delete this.c.tasks[name];
        this.registered.delete(name);
      }
    }

    if (f.commands) {
      for (const [name, def] of Object.entries(this.c.tasks)) {
        if (this.registered.has(name) || this.origTasks.has(name)) continue;
        this.origTasks.set(name, def);
        this.c.tasks[name] = { label: def.label, run: (s, args) => this.inTask(name, () => def.run(s, args)) };
      }
      if (!this.wrappedHostiles) this.wrapHostiles();
    } else {
      for (const [name, def] of this.origTasks) this.c.tasks[name] = def;
      this.origTasks.clear();
    }
    if (this.c.skills) this.c.skills._work = null;
  }

  wrapHostiles() {
    const c = this.c;
    const prev = Object.prototype.hasOwnProperty.call(c, 'hostiles') ? c.hostiles : null;
    const orig = (prev || Object.getPrototypeOf(c).hostiles).bind(c);
    c.hostiles = (range, from) => {
      const list = orig(range, from);
      if (!this.on('commands')) return list;
      const now = Date.now();
      return list.filter((e) => this.cmd.mayFight(e, now));
    };
    this.wrappedHostiles = true;
  }

  inTask(name, fn) {
    const task = this.c.task;
    if (task) task.own12 = !!(task.own12 || (this.lastCmd && this.lastCmd.own && this.lastCmd.name === name));
    return task ? taskCtx.run(task, fn) : fn();
  }

  async runJob(name, s, args = {}) {
    const def = JOBS[name];
    return this.inTask(name, async () => {
      if (this.c.task && args.own) this.c.task.own12 = true;
      try {
        return await def.run(this.cmd, s, args || {});
      } catch (err) {

        if (BUILD_JOBS.has(name) && this.currentBuild && this.on('memory2')) {
          const done = this.builder.history.length ? Math.min(0.95, this.builder.history[this.builder.history.length - 1].ops.length / 60) : 0;
          if (done >= 0.1) { this.places.savePlan({ ...this.currentBuild, done }); this.places.save(); }
        }
        this.currentBuild = null;
        throw err;
      }
    });
  }

  labelOf(name, args = {}) {
    if (JOBS[name]) return JOBS[name].label(args);
    const t = this.c.tasks[name];
    return (t && t.label) || lbl(name);
  }

  jobRunner(name) {
    if (JOBS[name] && this.on(JOBS[name].sw)) return (s, a) => JOBS[name].run(this.cmd, s, a || {});
    const t = this.origTasks.get(name) || this.c.tasks[name];
    return t ? (s, a) => t.run(s, a || {}) : null;
  }

  job(name, args = {}) {
    const def = this.c.tasks[name];
    if (!def) return { ok: false, reason: 'not_available' };
    const ask = NEEDS[name] && NEEDS[name](args);
    if (ask) return { ok: false, reason: 'need_details', ask };
    def.label = this.labelOf(name, args);
    const cur = this.c.task;
    if (cur && cur.name === name && JSON.stringify(cur.args12 || {}) !== JSON.stringify(args)) this.c.cancelTask('switching to something else');
    this.cmd.walker.stop(null, true);
    const r = this.c.startTask(name, args);
    if (this.c.task && this.c.task.name === name) this.c.task.args12 = args;
    return r;
  }

  command(name, args = {}) {
    if (!this.anyOn()) return null;
    const r = this.route(name, args);

    if (r && !r.ok && r.ask && this.ledger.take('ask', name)) this.c.emitEvent('command_needs', { action: lbl(name), ask: r.ask }, null);
    return r;
  }

  route(name, args = {}) {
    const a = args && typeof args === 'object' ? args : {};
    const now = Date.now();
    this.lastCmd = { name, at: now, own: now - this.lastFreeTimeAt < 20000 };
    if (MOVING.has(name)) { this.cmd.walker.stop(null, true); this.cmd.recovering = null; }

    if ((name === 'build' || name === 'build_house') && ['tower', 'wall', 'floor'].includes(a.kind) && this.on('freeBuild')) {
      const { kind, ...rest } = a;
      return this.job('build_shape', { ...rest, shape: kind });
    }
    const sw = spec.SWITCH_OF[name];
    if (sw) {
      if (!this.on(sw)) return null;
      if (sw === 'miniGames') return this.games.command(name, a);
      if (INSTANT[name]) return this.cmd[INSTANT[name]](a);
      return this.job(name, a);
    }
    if (!this.on('commands')) return null;
    if (name === 'come') return this.cmd.come();
    if (Object.keys(a).length) return this.oldWithArgs(name, a);
    return null;
  }

  oldWithArgs(name, a) {
    switch (name) {
      case 'gather_wood': return this.job('get_item', { item: a.wood ? `${a.wood}_log` : (a.item && LOG_RE.test(a.item) ? a.item : 'log'), n: a.n || 6, keep: !!a.keep });
      case 'mine_coal': case 'mine_iron': case 'mine_gold': case 'mine_diamonds':
        return a.n ? this.job('mine_n', { kind: ORE_OF[name], n: a.n }) : null;
      case 'make_tools': return a.item ? this.job('craft_item', { item: a.item, n: 1 }) : null;
      case 'give_loot': return a.item ? this.job('give_item', { item: a.item, n: a.n }) : null;
      case 'smelt': return a.item ? this.job('smelt_item', a) : null;
      case 'build_house': return this.on('builder') && (a.size || a.block || a.style || a.kind || a.where) ? this.job('build', a) : null;
      case 'explore': return a.kind ? this.job('find', a) : null;
      default: return null;
    }
  }

  stopGames() { this.games.stop(); }

  progress(note, { big = false, force = false } = {}) {
    if (!this.ledger.take(force ? 'progressForce' : 'progress', note)) return false;
    if (this.c.task) this.c.taskProgress(note, { big });
    else this.c.emitEvent('task_progress', { task: this.cmd.walker.w ? this.cmd.walker.w.label : 'helping out', note }, big ? 'high' : null);
    return true;
  }
  done(task, result) { this.c.emitEvent('task_done', { task, result }, null); }
  failed(task, reason) { if (this.ledger.take('failed', task)) this.c.emitEvent('task_failed', { task, reason }, null); }

  onSpawn(bot) {
    this.spawnedAt = Date.now();
    this.worldLoaded = false;
    this.offers = { plan: null, base: null, planAt: 0, baseAt: 0 };
    bot.on('path_update', (r) => { this.pathStatus = { status: r && r.status, at: Date.now() }; });
    bot.on('blockUpdate', (o, n) => { try { this.onBlockUpdate(o, n); } catch {} });
    bot.on('playerCollect', (collector, collected) => { try { this.onCollect(collector, collected); } catch {} });
    bot.on('entitySwingArm', (e) => { const o = this.c.ownerEntity(); if (o && e === o) this.cmd.ownerSwingAt = Date.now(); });
    bot.on('entityHurt', (e) => { try { this.games.onHurt(e); } catch {} });
  }

  loadWorld() {
    const bot = this.c.bot;
    if (!bot) return;
    const sp = bot.spawnPoint || null;
    if (!sp && Date.now() - this.spawnedAt < 8000) return;
    this.places.load(worldKey({ host: this.c.opts.host, port: this.c.opts.port, spawn: sp }));
    this.worldLoaded = true;
    const home = this.places.home();
    if (home && !this.c.home && this.on('commands')) this.c.home = { ...home.pos };
  }

  onLeave() {
    if (!this.anyOn()) return;
    try {
      if (this.on('memory2')) this.snapshotBase(true);
      if (this.places.dirty) this.places.save();
    } catch {}
    this.cmd.walker.stop(null, true);
    this.games.stop();
  }

  onCompanionEvent(e) {
    if (!e || !this.anyOn()) return;
    const now = Date.now();
    if (e.event === 'free_time') this.lastFreeTimeAt = now;
    if (e.event === 'player_died' && this.on('commands')) {
      const pos = this.lastOwnerPos;
      if (pos) { this.lastDeath = { pos: { x: pos.x, y: pos.y, z: pos.z }, at: now }; this.places.addDeath(pos, now); }
    }
  }

  onBlockUpdate(oldB, newB) {
    if (!newB || !oldB || !this.c.bot?.entity) return;
    const p = newB.position;
    const oi = info(oldB), ni = info(newB);
    if (this.on('miniGames') && !oi.air && ni.air) this.games.onBlockGone(oldB, p);
    if (!this.on('builder')) return;
    if (!(oi.air || oi.plant || oi.liquid) || !ni.solid || ni.liquid) return;
    const o = this.c.ownerEntity();
    if (!o) return;
    const dO = o.position.distanceTo(p), dB = this.c.bot.entity.position.distanceTo(p);
    const now = Date.now();
    if (this.botPlaced.some((q) => q.x === p.x && q.y === p.y && q.z === p.z && now - q.at < 4000)) return;
    if (dO > 6.5 || dO >= dB) return;
    this.playerBlocks.push({ x: p.x, y: p.y, z: p.z, name: newB.name, at: now });
    if (this.playerBlocks.length > 200) this.playerBlocks.splice(0, this.playerBlocks.length - 200);
  }

  notePlaced(p) {
    const now = Date.now();
    this.botPlaced.push({ x: p.x, y: p.y, z: p.z, at: now });
    if (this.botPlaced.length > 50) this.botPlaced.shift();
  }

  onCollect(collector, collected) {
    const bot = this.c.bot;
    const item = collected && typeof collected.getDroppedItem === 'function' ? collected.getDroppedItem() : null;
    if (!item) return;
    if (this.on('miniGames')) this.games.onCollect(collector, item);
    if (collector === bot.entity && this.on('commands') && !this.c._retossing) {
      const o = this.c.ownerEntity();
      if (o && o.position.distanceTo(bot.entity.position) < 7) {
        this.recentGifts.push({ name: item.name, count: item.count, at: Date.now() });
        if (this.recentGifts.length > 12) this.recentGifts.shift();
      }
    }
  }

  noDig(pos) { return this.keptOut(pos) || (this.on('memory2') && !!this.places.noDig(pos)); }

  keptOut(pos) {
    const k = this.keepOut;
    if (!k || !pos) return false;
    return pos.x >= k.x0 && pos.x <= k.x1 && pos.y >= k.y0 && pos.y <= k.y1 && pos.z >= k.z0 && pos.z <= k.z1;
  }

  decorateMoves(m) {
    if (!this.anyOn()) return;
    m.exclusionAreasBreak.push((b) => (this.noDig(b.position) ? 1000 : 0) + this.builder.breakCost(b.position));
    m.exclusionAreasPlace.push((b) => this.builder.placeCost(b.position));
  }

  onTick(now) {
    if (!this.anyOn()) return;
    const c = this.c, bot = c.bot;
    if (!bot?.entity) return;
    if (!this.worldLoaded) this.loadWorld();
    const o = c.ownerEntity();
    if (o && o.position) this.lastOwnerPos = o.position.clone();
    if (c.diedAt) { this.cmd.walker.stop(null, true); return; }
    if (this.on('commands')) {
      this.cmd.walker.tick(now);
      this.cmd.recoverTick(now);

      const w = this.cmd.walker.w;
      if (w && (w.kind === 'come' || w.kind === 'fallback')) {
        for (const e of Object.values(bot.entities)) if (e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 9) c.decided.add(`item-${e.id}`);
      }
      this.cmd.checkRetreat(now);
    }
    if (this.on('miniGames')) this.games.tick(now);
    if (now - this.lastScan > 5000) {
      this.lastScan = now;
      if (this.on('commands')) this.sleepHint(now);
      if (this.on('initiative')) { this.duskHut(now); this.curiosity(now); this.impulse(now); }
      if (this.on('memory2')) this.memoryTick(now);
    }
    if (this.places.dirty && now - this.lastSave > 10000) { this.lastSave = now; this.places.save(); }
  }

  sleepHint(now) {
    const c = this.c, bot = c.bot;
    const t = bot.time?.timeOfDay;
    if (this.sleepIdea && now > this.sleepIdea.until) this.sleepIdea = null;
    if (t == null || t < 12500 || t > 14500 || bot.isSleeping || c.task) return;
    const day = Math.floor((bot.time?.time || 0) / 24000);
    if (!this.ledger.allow('sleepHint', `night${day}`, now)) return;
    const o = c.ownerEntity();
    const beds = c.skills.findBlocks(Object.keys(c.skills.data.blocksByName).filter((n) => /_bed$/.test(n)), { maxDistance: 24, count: 1 });
    this.ledger.use('sleepHint', `night${day}`, now);
    if (!beds.length || !o) return;
    this.sleepIdea = { text: `there's a bed ${Math.round(beds[0].position.distanceTo(o.position))} blocks from the player`, until: now + 90 * 1000 };
  }

  shelterNear(pos) {
    const homes = [this.c.home, this.places.home()?.pos, ...this.places.data.places.filter((p) => /hut|house|base|home/.test(p.name)).map((p) => p.pos)].filter(Boolean);
    return homes.some((h) => Math.hypot(h.x - pos.x, h.z - pos.z) < 48);
  }

  duskHut(now) {
    const c = this.c, bot = c.bot;
    if (!this.on('builder') || c.task || c.busy || c.mode !== 'follow') return;
    const t = bot.time?.timeOfDay;
    if (t == null || t < 11800 || t > 13300) return;
    const o = c.ownerEntity();
    if (!o || o.position.distanceTo(bot.entity.position) > 12 || o.position.y < 50 && o.position.y < (c.lastMineDepth ?? 999)) return;
    if (this.shelterNear(o.position)) return;
    const day = Math.floor((bot.time?.time || 0) / 24000);
    if (!this.ledger.take('duskHut', `day${day}`, now)) return;
    this.lastCmd = { name: 'quick_hut', at: now, own: true };
    this.job('quick_hut', { own: true });
  }

  curiosity(now) {
    const c = this.c, s = c.skills;
    if (!c.task || !c.task.own12 || c.task.name === 'detour' || !this.ledger.allow('curiosity', 'any', now)) return;
    const [b] = this.fetcher.visible(s, ['diamond_ore', 'deepslate_diamond_ore', 'gold_ore', 'deepslate_gold_ore', 'emerald_ore', 'iron_ore', 'deepslate_iron_ore'], { maxDistance: 16, count: 1 });
    if (!b || s.hazardAt(b.position)) return;
    this.ledger.use('curiosity', 'any', now);
    const what = b.name.replace(/^deepslate_|_ore$/g, '').replace(/_/g, ' ');
    c.cancelTask(`spotted some ${what}`);
    this.job('detour', { block: b, what, own: true });
  }

  impulse(now) {
    const c = this.c, s = c.skills, bot = c.bot;
    if (c.task || c.busy || c.mode !== 'follow' || c.isNight()) return;
    const o = c.ownerEntity();
    if (!o || o.position.distanceTo(bot.entity.position) > 8 || c.hostiles(12).length) return;
    if (!this.ledger.allow('detour', 'any', now)) return;
    if (Math.random() > 0.15) return;
    const [b] = this.fetcher.visible(s, ['coal_ore', 'iron_ore', 'copper_ore', 'sugar_cane', 'pumpkin', 'melon'], { maxDistance: 10, count: 1 });
    if (!b || s.hazardAt(b.position) || PROTECTED_RE.test(b.name)) return;
    this.ledger.use('detour', 'any', now);
    const what = b.name.replace(/_ore$/, '').replace(/_/g, ' ');
    this.lastCmd = { name: 'detour', at: now, own: true };
    this.job('detour', { block: b, what, own: true });
  }

  memoryTick(now) {
    const since = now - this.spawnedAt;
    if (!this.worldLoaded) return;
    if (!this.offers.baseAt && since > 15000) { this.offers.baseAt = now; this.snapshotBase(false); }
    if (!this.offers.planAt && since > 30000) { this.offers.planAt = now; this.offers.plan = this.places.offerPlan(); if (this.offers.plan) this.places.save(); }
  }

  snapshotBase(save) {
    const bot = this.c.bot;
    const home = this.places.home();
    if (!bot || !home) return;
    const counts = {};
    let loaded = 0;
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) for (let y = -3; y <= 8; y++) {
      const b = bot.blockAt(new Vec3(home.pos.x + x, home.pos.y + y, home.pos.z + z));
      if (!b) continue;
      loaded++;
      if (PROTECTED_RE.test(b.name) || /_log$|_bed$/.test(b.name)) counts[b.name] = (counts[b.name] || 0) + 1;
    }
    if (loaded < 2000) return;
    if (!save) {
      const before = this.places.data.snapshot;
      const lines = before ? Places.diff(before.counts, counts) : [];
      this.offers.base = lines.length ? { lines, until: Date.now() + 4 * 60 * 1000 } : null;
    }
    this.places.setSnapshot(home.pos, counts);
  }

  state() {
    if (!this.anyOn()) return null;
    const out = {};
    const bot = this.c.bot;
    const here = this.c.ownerEntity()?.position || bot?.entity?.position;
    if (this.on('commands') && this.places.data.places.length) {
      const list = this.places.listFor(here, 6, { coined: this.on('memory2') });
      if (list.length) out.known_places = list;
    }
    if (this.on('commands') && this.sleepIdea && Date.now() < this.sleepIdea.until) out.sleep_idea = this.sleepIdea.text;
    if (this.on('commands') && this.cmd.walker.w) out.walking = this.cmd.walker.w.paused ? `${this.cmd.walker.w.label} (waiting for the player to catch up)` : this.cmd.walker.w.label;
    if (this.on('miniGames')) {
      const g = this.games.stateLine();
      if (g) out.little_game = g;
      else if (this.games.idea) out.little_game_idea = `${this.games.idea.text} (a game that is possible now)`;
    }
    if (this.on('memory2')) {
      const rules = this.places.ruleLines();
      if (rules.length) out.house_rules = rules;
      const p = this.offers.plan;
      if (p && Date.now() - this.offers.planAt < 4 * 60 * 1000) out.unfinished_build = `${p.label}, about ${Math.round(p.done * 100)}% done (build with resume finishes it)`;
      const b = this.offers.base;
      if (b && Date.now() < b.until) out.base_changed_since_last_time = b.lines;
    }
    return Object.keys(out).length ? out : null;
  }
}

function install(companion) {
  const hands = new Hands(companion);
  companion.use('hands', hands);
  companion.setStorage = (dir) => hands.setStorage(dir);
  return hands;
}

module.exports = { install, Hands, JOBS, NEEDS };
