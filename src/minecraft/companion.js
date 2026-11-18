// The companion's body: joins a Minecraft Java world as a real player (Mineflayer), follows, fights, flees, picks up loot,
// and runs jobs (chop, mine, craft, smelt, build, hunt, light up, explore, hand things over). The AI picks what to do;
// the body decides how. Reports what happens as events and a short state.
const { EventEmitter } = require('events');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvpPlugin = require('mineflayer-pvp').plugin;
const collectPlugin = require('mineflayer-collectblock').plugin;
const { Skills, Nope, taskCtx } = require('./skills');

const { Motor } = require('./motor');
const { Perception } = require('./perception');
const { Awareness } = require('./awareness');
const { Social } = require('./social');
const { Habits } = require('./habits');
const jobstick = require('../shared/jobstick');
const { GoalGap, pickHeld } = require('./gap');

const { GoalFollow, GoalNear, GoalInvert } = goals;

const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'creeper', 'spider',
  'cave_spider', 'witch', 'enderman', 'slime', 'phantom', 'pillager', 'vindicator', 'silverfish',
  'blaze', 'magma_cube', 'ghast', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'guardian', 'breeze'
]);
const NOTABLE = /diamond|emerald|netherite|ancient_debris|gold_ingot|iron_ingot|enchanted|totem|trident|elytra/;
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];
const DEATH_VERBS = /(was |were |fell|drowned|burned|blew up|hit the ground|tried to swim|went up in flames|walked into|starved|suffocated|froze|died|withered|experienced kinetic|discovered the floor)/;
const DEFAULT_TRAITS = { bravery: 3, greed: 8, loyalty: 6, panic: 8, chattiness: 7 };

const TASKS = {
  gather_wood: { label: 'chopping wood', run: async (s, args) => {
    const n = Math.max(1, Math.min(16, Number(args.count) || 6));
    const got = await s.getLogs(n);
    if (args.keep) return `${got} logs`;
    if (await s.backToPlayer()) {
      const o = s.owner();
      if (o && s.coached()) {
        if (s.c && s.c.f && s.c.f('bodyHandover')) {
          const held = () => s.items().filter((i) => /_log$/.test(i.name)).reduce((a, i) => a + i.count, 0);
          const before = held();
          const pick = (i) => /_log$/.test(i.name);
          if (s.c.f('bodyToss') && typeof s.retossLying === 'function') {

            const pre = s.itemIds();
            await s.tossTo(o, pick);
            let lying = await s.waitPickup(s.owner() || o, pick, 3000, pre);
            if (Object.keys(lying).length) lying = await s.retossLying(o, pick, pre);
            const lyingN = Object.values(lying).reduce((a, k) => a + k, 0);
            const left = held(), gone = Math.max(0, before - left), reached = Math.max(0, gone - lyingN);
            s.dbg && s.dbg(`gather_wood hand-over: had ${before}, left his bag ${gone}, still on the ground ${lyingN}, with him ${left}`);
            if (!gone) return `${got} logs, but couldn't hand them over (still with you)`;
            if (!reached) return `${got} logs, dropped them right by the player (still on the ground)`;
            const extra = [lyingN ? `${lyingN} still on the ground by the player` : '', left ? `${left} still with you` : ''].filter(Boolean).join(', ');
            return `${got} logs, gave the player ${reached}${extra ? ` (${extra})` : ''}`;
          }
          await s.tossTo(o, pick);
          const given = before - held();
          s.dbg && s.dbg(`gather_wood hand-over: had ${before}, gave ${given}`);
          if (!given) return `${got} logs, but couldn't hand them over (still with you)`;
          if (given < before) return `${got} logs, gave the player ${given} (${before - given} still with you)`;
          return `${got} logs, gave the player ${given}`;
        }
        await s.tossTo(o, (i) => /_log$/.test(i.name)); return `${got} logs`;
      }
      if (o) await s.bot.lookAt(o.position.offset(0, 1.6, 0)).catch(() => {});
      for (const it of s.items().filter((i) => /_log$/.test(i.name))) await s.bot.tossStack(it).catch(() => {});
    }
    return `${got} logs`;
  } },
  build_house: { label: 'building a house', run: (s) => s.buildHouse() },
  make_tools: { label: 'crafting tools', run: (s) => s.makeGear() },
  mine_coal: { label: 'mining for coal', run: (s) => s.mineOre('coal', 8) },
  mine_iron: { label: 'mining for iron', run: (s) => s.mineOre('iron', 6) },
  mine_gold: { label: 'mining for gold', run: (s) => s.mineOre('gold', 6) },
  mine_diamonds: { label: 'digging for diamonds', run: (s) => s.mineOre('diamond', 3) },
  smelt: { label: 'smelting', run: (s) => s.smeltAll() },
  hunt_food: { label: 'hunting for food', run: (s) => s.hunt() },
  light_up: { label: 'putting torches down', run: (s) => s.lightUp() },
  explore: { label: 'exploring', run: (s) => s.explore() },
  give_loot: { label: 'handing over loot', run: (s) => s.giveLoot() }
};
const FREE_GAP_MS = [75 * 1000, 150 * 1000];

function validUsername(name) {
  const clean = String(name || 'Companion').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  return clean.length >= 3 ? clean : 'Companion_AI';
}

const STILL_MS = 1500;
const STILL_MS_126 = 3000;
const HAND_ITEMS = /^(pickaxe|sword|axe|shovel|hoe|food|log|planks|torch|bow|crossbow|shield|fishing_rod|bucket|water_bucket|lava_bucket|flint_and_steel|shears|compass|clock|map|spyglass|trident|mace)$|_(pickaxe|sword|axe|shovel|hoe|log|planks)$/;

class MinecraftCompanion extends EventEmitter {
  constructor() {
    super();
    this.bot = null;
    this.state = 'offline';
    this.error = null;
    this.opts = {};
    this.traits = { ...DEFAULT_TRAITS };
    this.mode = 'follow';
    this.modeUntil = 0;
    this.goalKind = null;
    this.seen = new Map();
    this.decided = new Set();
    this.lastEmit = {};
    this.attackTarget = null;
    this.busy = false;
    this.wasNight = null;
    this.lastHealth = 20;
    this.diedAt = 0;
    this.timer = null;
    this.stateTimer = null;
    this.skills = new Skills(this);
    this.task = null;
    this.home = null;
    this.lastCommandAt = 0;
    this.lastTaskEnd = 0;
    this.lastFreeTime = 0;
    this.freeGap = this.pickFreeGap();
    this.recent = [];

    this.feats = {};
    this.followGapN = 6;
    this.handHold = null;
    this.handsOff = null;
    this.ownerTrail = [];
    this.tasks = { ...TASKS };
    this.mods = [];
    this.v12 = {};
    this.sparring = null;
    this.use('motor', new Motor(this));
    this.use('perception', new Perception(this));
    this.use('awareness', new Awareness(this));
    this.use('social', new Social(this));
    this.use('habits', new Habits(this));
    this.use('boats', new (require('./boats').Boats)(this));
    require('./hands').install(this);
  }

  f(id) { return !!this.feats[id]; }
  setFeatures(f) {
    const before = !!this.feats.followGap;
    this.feats = { ...(f || {}) };
    if (before !== !!this.feats.followGap && /^follow-/.test(this.goalKind || '')) this.goalKind = null;
    if (!this.feats.toolHands) this.handHold = null;
    if (!this.feats.movesStill) this.handsOff = null;
    this.hook('onFeatures', this.feats);
  }

  setFollowGap(n) {
    const v = Math.max(2, Math.min(12, Math.round(Number(n) || 6)));
    if (v === this.followGapN) return;
    this.followGapN = v;
    if (/^follow-/.test(this.goalKind || '')) this.goalKind = null;
  }
  followGap() {

    return this.feats.socialBody && this.v12.social?.tight ? Math.min(this.followGapN, 3) : this.followGapN;
  }
  followGoalFor(owner) {

    if (this.feats.followGap && this.mode !== 'guard') return new GoalGap(owner, () => this.followGap(), this.bot);

    return this.feats.socialBody && this.v12.social ? this.v12.social.followGoal(owner) : new GoalFollow(owner, 2);
  }

  handsCommand(name, args = {}) {
    const bot = this.bot;
    if (name === 'put_away') {
      this.handHold = { empty: true, at: Date.now() };
      if (!this.busy && !this.attackTarget && bot.heldItem) bot.unequip('hand').catch(() => {});
      return { ok: true };
    }
    const want = String(args.item || args.kind || '').toLowerCase();
    if (!want) return { ok: false, reason: 'unknown_command' };
    const it = pickHeld(bot.inventory.items(), want, (i) => this.isFood(i));
    if (!it) return { ok: false, reason: 'dont_have_that', item: want };
    this.handHold = { item: it.name, at: Date.now() };
    if (!this.busy && !this.attackTarget && bot.heldItem?.name !== it.name) bot.equip(it, 'hand').catch(() => {});
    return { ok: true };
  }
  isFood(i) {
    try { const d = require('minecraft-data')(this.bot.version); return !!(d.foodsByName?.[i.name] && !/rotten|spider_eye|poison|pufferfish/.test(i.name)); } catch { return false; }
  }

  keepHand() {
    const bot = this.bot, h = this.handHold;
    if (!bot || !h) return false;
    if (h.empty) { if (bot.heldItem) bot.unequip('hand').catch(() => {}); return true; }
    const it = bot.inventory.items().find((i) => i.name === h.item);
    if (!it) { this.handHold = null; return false; }
    if (bot.heldItem?.name !== it.name) bot.equip(it, 'hand').catch(() => {});
    return true;
  }

  handsCue(kind, data = {}) {
    const now = Date.now();
    if (kind === 'move_start') {
      this.handsOff = { until: now + Math.max(2000, Math.min(8000, Number(data.ms) || 5000)) };

      if (this.mode === 'follow' && !this.attackTarget && !this.bot?.pvp?.target && this.bot?.pathfinder && /^follow-/.test(this.goalKind || '')) {
        try { this.bot.pathfinder.setGoal(null); this.goalKind = 'hands-off'; } catch {}
      }
    }
    else if (kind === 'line_end' && this.handsOff) this.handsOff.until = Math.min(this.handsOff.until, now + 1500);
  }
  ownerMoving(now = Date.now()) {
    const tr = this.ownerTrail;
    if (!tr.length) return false;
    const last = tr[tr.length - 1];
    if (now - last.t > 2000) return false;
    return tr.some((x) => now - x.t <= STILL_MS_126 && x.p.distanceTo(last.p) > 1);
  }
  use(name, mod) { this.v12[name] = mod; this.mods.push(mod); return mod; }
  addTask(name, def) { this.tasks[name] = def; }

  hook(name, ...args) {
    for (const m of this.mods) {
      if (typeof m[name] !== 'function') continue;
      try { m[name](...args); } catch (err) { this.emit('log', `${m.constructor?.name || 'module'}.${name}: ${err.message}`); }
    }
  }

  ask(name, ...args) {
    for (const m of this.mods) {
      if (typeof m[name] !== 'function') continue;
      try { const r = m[name](...args); if (r) return r; } catch (err) { this.emit('log', `${m.constructor?.name || 'module'}.${name}: ${err.message}`); }
    }
    return null;
  }

  pickFreeGap() { return FREE_GAP_MS[0] + Math.random() * (FREE_GAP_MS[1] - FREE_GAP_MS[0]); }

  cue(kind, data = {}) {
    if (this.feats.movesStill) this.handsCue(String(kind || ''), data || {});
    if (this.mods.length) this.hook('onCue', String(kind || ''), data || {});
  }

  isTense() { return !!this.v12.awareness?.isTense?.(); }

  setMood(m) { this.v12.motor?.setMood?.(m); }

  status() {
    const b = this.bot;
    return {
      state: this.state,
      error: this.error,
      host: this.opts.host || 'localhost',
      port: this.opts.port || 25565,
      username: b?.username || this.opts.username || null,
      owner: this.opts.owner || null,
      version: b?.version || null,
      health: b?.health ?? null
    };
  }

  doingNow() {
    const bot = this.bot;
    if (!bot?.entity || this.state !== 'online') return null;
    if (this.task) return this.task.label || 'on a job';
    if (this.diedAt) return 'respawning';
    if (bot.pvp?.target || this.attackTarget) return 'fighting';
    if (this.mode === 'flee') return 'running away';
    if (this.eating) return 'eating';
    if (bot.targetDigBlock) return 'mining';

    if (this.feats.humanizer && this.v12.motor?.fidgeting?.()) return null;
    const v = bot.entity.velocity || {};
    const walking = (typeof bot.pathfinder?.isMoving === 'function' && bot.pathfinder.isMoving())
      || Math.hypot(v.x || 0, v.z || 0) > 0.03
      || (bot.entity.onGround === false && Math.abs(v.y || 0) > 0.1)
      || ['forward', 'back', 'left', 'right', 'jump', 'sprint'].some((k) => bot.controlState?.[k]);
    return walking ? 'walking' : null;
  }

  activity() {
    const now = Date.now();
    if (!this.bot?.entity || this.state !== 'online') {
      const out = { inWorld: false, still: true, doing: 'not in the world' };
      if (this.feats.humanizer) out.state = 'offline';
      return out;
    }

    if (this.feats.humanizer && this.v12.motor?.paused?.()) return { inWorld: true, still: true, doing: 'stopped to talk', stillMs: STILL_MS, state: this.bodyState(null) };
    const doing = this.doingNow();
    if (doing) this.lastBusyAt = now;
    const quietMs = now - (this.lastBusyAt || 0);

    const need = this.feats.movesStill ? STILL_MS_126 : STILL_MS;
    let still = !doing && quietMs >= need;
    let why = null;
    if (still && this.feats.movesStill && this.mode === 'follow' && this.ownerMoving(now)) { still = false; why = 'about to follow the player (the player is moving)'; }
    const out = { inWorld: true, still, doing: doing || (quietMs >= need ? 'standing still' : 'just stopped'), stillMs: still ? quietMs : 0 };
    if (why) out.why = why;
    if (this.feats.humanizer) out.state = this.bodyState(doing);
    return out;
  }

  bodyState(doing) {
    const h = this.v12.habits;
    if (this.diedAt) return 'respawning';
    if (h?.away) return 'away';
    if (this.bot?.pvp?.target || this.attackTarget || this.mode === 'flee') return 'fighting';
    if (this.eating) return 'eating';
    if (this.task) return /mine|dig|ore|quarry/.test(this.task.name) ? 'mining' : /build|house|hut|bridge|wall|farm|room/.test(this.task.name) ? 'building' : 'job';
    if (this.bot?.targetDigBlock) return 'mining';
    if (h?.arrival) return 'arriving';
    return doing === 'walking' ? 'walking' : 'idle';
  }

  setState(s, error = null) {
    this.state = s;
    this.error = error;
    this.emit('status', this.status());
  }

  connect({ host = 'localhost', port = 25565, username = 'Companion', version = null, owner = '', traits = {}, showChat = true, freeWill = true, solo = null } = {}) {
    this.disconnect(true);
    this.opts = { host, port: Number(port) || 25565, username: validUsername(username), version: version || false, owner: owner || '', showChat, freeWill: freeWill !== false, solo: solo || null };
    this.task = null;
    this.busy = false;
    this.home = null;
    this.lastFreeTime = Date.now();
    this.traits = { ...DEFAULT_TRAITS, ...traits };
    this.setState('connecting');
    let bot;
    try {
      bot = mineflayer.createBot({
        host: this.opts.host,
        port: this.opts.port,
        username: this.opts.username,
        auth: 'offline',
        version: this.opts.version,
        hideErrors: true,
        checkTimeoutInterval: 60 * 1000
      });
    } catch (err) {
      this.setState('offline', err.message);
      return;
    }
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvpPlugin);
    bot.loadPlugin(collectPlugin);

    bot.once('spawn', () => this.onFirstSpawn());
    bot.on('spawn', () => {
      if (this.diedAt) {
        this.diedAt = 0;
        this.emitEvent('companion_revived', {}, null);
      }
    });
    bot.on('death', () => {
      this.diedAt = Date.now();
      this.attackTarget = null;
      if (this.task) this.task.cancelled = 'died';
      this.emitEvent('companion_downed', { cause: this.lastDamageCause || 'something' }, 'high');
    });
    bot.on('health', () => this.onHealth());
    bot.on('entityHurt', (e) => this.onEntityHurt(e));
    bot.on('entityDead', (e) => this.onEntityDead(e));
    bot.on('playerCollect', (collector, collected) => this.onCollect(collector, collected));
    bot.on('chat', (username, message) => this.onChat(username, message));
    bot.on('messagestr', (msg, position) => this.onSystemMessage(msg, position));
    bot.on('playerJoined', (p) => { if (!this.opts.owner && p.username !== bot.username) this.opts.owner = p.username; this.emit('status', this.status()); });
    bot.on('stoppedAttacking', () => { this.attackTarget = null; this.goalKind = null; });
    bot.on('kicked', (reason) => this.setState('offline', `Kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`.slice(0, 200)));
    bot.on('error', (err) => { if (this.state !== 'online') this.setState('offline', friendlyError(err)); });
    bot.on('end', (reason) => {
      clearInterval(this.timer); clearInterval(this.stateTimer);
      if (this.bot === bot) { this.bot = null; if (this.state !== 'offline' || !this.error) this.setState('offline', this.error || (reason && reason !== 'socketClosed' ? `Disconnected: ${reason}` : null)); }
    });
  }

  disconnect(silent = false) {
    if (this.solo) { try { this.solo.stop(); } catch {} this.solo = null; }
    clearInterval(this.timer); clearInterval(this.stateTimer);
    if (this.mods.length) this.hook('onLeave');
    if (this.task) this.task.cancelled = 'left the world';
    if (this.bot) { try { this.bot.quit('session ended'); } catch {} this.bot = null; }
    if (!silent) this.setState('offline');
  }

  onFirstSpawn() {
    const bot = this.bot;
    const moves = new Movements(bot);
    moves.canDig = false;
    moves.allow1by1towers = false;
    moves.allowSprinting = true;
    this.moves = moves;
    bot.pathfinder.setMovements(moves);
    if (bot.pvp) bot.pvp.attackRange = 3;
    if (!this.opts.owner) this.opts.owner = this.findOwnerName() || '';
    this.setState('online');
    this.emitEvent('companion_joined', { world: 'Minecraft' }, null);
    this.timer = setInterval(() => { try { this.tick(); } catch (err) { this.emit('log', `tick: ${err.message}`); } }, 400);
    this.stateTimer = setInterval(() => this.sendState(), 5000);
    this.equipBestWeapon();

    if (this.opts.solo && typeof this.f === 'function' && this.f('bodySolo')) {
      try { const { SoloDirector } = require('./solo'); this.solo = new SoloDirector(this, this.opts.solo); if (this.opts.solo.autostart !== false) this.solo.start(); } catch (err) { this.emit('log', `solo: ${err.message}`); }
    }

    if (typeof this.f === 'function' && this.f('bodyNoHarm')) { try { require('./noharm').install(this, bot); } catch (err) { this.emit('log', `noHarm: ${err.message}`); } }
    this.hook('onSpawn', bot);
  }

  findOwnerName() {
    const bot = this.bot;
    if (!bot) return null;
    const names = Object.keys(bot.players).filter((n) => n !== bot.username);

    if (names.length > 1) return null;
    if (names[0]) return names[0];
    const e = Object.values(bot.entities).find((x) => x.type === 'player' && x.username && x.username !== bot.username);
    return e?.username || null;
  }

  ownerEntity() {
    const bot = this.bot;
    if (!bot) return null;
    if (!this.opts.owner) { this.opts.owner = this.findOwnerName() || ''; if (this.opts.owner) this.emit('status', this.status()); }
    if (!this.opts.owner) return null;
    if (!bot.players[this.opts.owner]) {

      const real = Object.keys(bot.players).find((n) => n.toLowerCase() === this.opts.owner.toLowerCase());
      if (real) { this.opts.owner = real; this.emit('status', this.status()); }
    }
    return bot.players[this.opts.owner]?.entity
      || Object.values(bot.entities).find((x) => x.type === 'player' && x.username === this.opts.owner)
      || null;
  }

  emitEvent(event, data = {}, priority = null) {
    this.emit('event', { event, data, priority, ts: Date.now(), source: 'minecraft' });
  }

  emitThrottled(key, ms, event, data, priority) {
    const now = Date.now();
    if (now - (this.lastEmit[key] || 0) < ms) return;
    this.lastEmit[key] = now;
    this.emitEvent(event, data, priority);
  }

  sendState() {
    const bot = this.bot;
    if (!bot?.entity) return;
    const owner = this.ownerEntity();
    const hostiles = this.hostiles(16).length;
    const items = bot.inventory.items().slice().sort((a, b) => b.count - a.count).slice(0, 5).map((i) => `${i.count} ${i.displayName}`);
    const tools = this.skills.toolSummary();
    this.emit('state', {
      your_health: `${Math.round(bot.health)}/20`,
      your_food: `${Math.round(bot.food)}/20`,
      time_of_day: this.isNight() ? 'night' : 'day',
      distance_to_player: owner ? `${Math.round(owner.position.distanceTo(bot.entity.position))} blocks` : 'player not in sight',

      difficulty: bot.game && bot.game.difficulty ? String(bot.game.difficulty) : null,
      player_online: !!(this.opts.owner && Object.keys(bot.players || {}).some((n) => n.toLowerCase() === String(this.opts.owner).toLowerCase())),
      hostile_mobs_nearby: hostiles,
      you_are_doing: this.task ? `${this.task.label} (for ${Math.round((Date.now() - this.task.started) / 1000)}s)` : this.mode,
      your_y_level: Math.round(bot.entity.position.y),
      your_tools: tools.length ? tools : ['none yet'],
      your_house: this.home ? 'a home spot is saved' : 'none yet',
      your_inventory: items.length ? items : ['empty'],
      your_free_slots: typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null,

      ...this.extraState()
    });
  }

  extraState() {
    const out = {};
    for (const m of this.mods) {
      if (typeof m.state !== 'function') continue;
      try { Object.assign(out, m.state() || {}); } catch (err) { this.emit('log', `state: ${err.message}`); }
    }
    return out;
  }

  say(text) {
    if (!this.bot || this.state !== 'online' || !this.opts.showChat || !text) return;

    if (true) {
      const all = String(text).replace(/\s+/g, ' ').trim();
      const parts = [];
      let rest = all;
      while (rest.length > 240) { let at = rest.lastIndexOf(' ', 240); if (at < 1) at = 240; parts.push(rest.slice(0, at)); rest = rest.slice(at).trim(); }
      if (rest) parts.push(rest);
      for (const p of parts) { try { this.bot.chat(p.startsWith('/') ? ` ${p}` : p); } catch {} }
      return;
    }
    const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 240);
    try { this.bot.chat(clean); } catch {}
  }

  hostiles(range, from) {
    const bot = this.bot;
    const origin = from || bot.entity.position;
    const list = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && (e.type === 'hostile' || HOSTILE.has(e.name)) && e.position.distanceTo(origin) <= range);

    if (this.feats.perception && this.v12.perception) return list.filter((e) => this.v12.perception.knows(e));
    return list;
  }

  nearestHostile(range, from) {
    const origin = from || this.bot.entity.position;
    let best = null, bd = Infinity;
    for (const e of this.hostiles(range, origin)) { const d = e.position.distanceTo(origin); if (d < bd) { bd = d; best = e; } }
    return best;
  }

  isNight() {
    const t = this.bot?.time?.timeOfDay;
    return t != null && t >= 13000 && t <= 23000;
  }

  onHealth() {
    const bot = this.bot;
    if (!bot) return;
    if (bot.health < this.lastHealth && bot.health > 0) {
      this.emitThrottled('c-hurt', 5000, 'companion_hurt', { health: Math.round(bot.health), cause: this.lastDamageCause || null }, bot.health <= 6 ? 'high' : null);
    }
    this.lastHealth = bot.health;
    if (bot.food < 14) this.tryEat();
  }

  onEntityHurt(e) {
    const bot = this.bot;
    if (!bot) return;
    const owner = this.ownerEntity();
    if (owner && e === owner) {
      const near = this.nearestHostile(5, owner.position);
      this.emitThrottled('p-hurt', 3000, 'player_hurt', { cause: near ? near.displayName || near.name : null }, null);
    }
    if (e === bot.entity) {
      const near = this.nearestHostile(5);
      this.lastDamageCause = near ? near.displayName || near.name : null;
    }
  }

  onEntityDead(e) {
    const bot = this.bot;
    if (!bot || !(e.type === 'hostile' || HOSTILE.has(e.name))) return;
    const owner = this.ownerEntity();
    const name = e.displayName || e.name;
    if (this.attackTarget && this.attackTarget.id === e.id) {
      this.emitThrottled('kill', 3000, 'monster_killed', { monster: name, by: 'companion' }, null);
      this.attackTarget = null;
    } else if (owner && e.position.distanceTo(owner.position) < 5) {
      this.emitThrottled('kill', 3000, 'monster_killed', { monster: name, by: 'player' }, null);
    }
  }

  onCollect(collector, collected) {
    const bot = this.bot;
    if (!bot) return;
    const item = typeof collected.getDroppedItem === 'function' ? collected.getDroppedItem() : null;
    if (!item) return;
    if (collector === bot.entity) {
      this.emitThrottled('loot-c', 6000, 'loot_found', { item: item.displayName, count: item.count, by: 'companion' }, null);
      setTimeout(() => this.equipBestWeapon(), 300);
    } else if (collector.username && collector.username === this.opts.owner && NOTABLE.test(item.name)) {
      this.emitThrottled('loot-p', 6000, 'loot_found', { item: item.displayName, count: item.count, by: 'player' }, null);
    }
  }

  onChat(username, message) {
    if (!this.bot || username === this.bot.username) return;
    if (!this.opts.owner) { this.opts.owner = username; this.emit('status', this.status()); }
    if (username.toLowerCase() !== this.opts.owner.toLowerCase()) return;
    if (username !== this.opts.owner) { this.opts.owner = username; this.emit('status', this.status()); }
    this.emit('playerText', String(message).slice(0, 300));
  }

  onSystemMessage(msg, position) {
    if (!msg || position === 'chat' || !this.opts.owner) return;
    const prefix = `${this.opts.owner} `;
    if (msg.startsWith(prefix) && DEATH_VERBS.test(msg.slice(prefix.length))) {
      this.emitEvent('player_died', { cause: msg.slice(prefix.length) }, 'high');
    }
  }

  setMode(mode, seconds) {
    this.mode = mode;
    this.modeUntil = seconds ? Date.now() + seconds * 1000 : 0;
    this.goalKind = null;
  }

  command(name, args = {}, meta = null) {
    const bot = this.bot;
    if (!bot || this.state !== 'online') return { ok: false, reason: 'not_in_world' };
    if (this.diedAt) return { ok: false, reason: 'companion_downed' };

    if (meta && this.feats.jobsStick && this.task && !this.task.cancelled && !this.task.own12
      && jobstick.keepJob(name, meta, { isJob: !!(this.tasks[name] || TASKS[name]) && this.task.name !== name })) {
      this.emit('log', `kept at ${this.task.label}: ignored ${name} (${meta.src === 'player' ? 'your words didn\'t call me off it' : 'nobody asked'})`);
      return { ok: false, reason: 'busy_with_job', job: this.task.label };
    }
    this.lastCommandAt = Date.now();

    if (this.feats.toolHands && (name === 'hold_item' || name === 'put_away')) {
      if (this.task && meta && meta.src !== 'player') return { ok: false, reason: 'busy_with_job', job: this.task.label };
      return this.handsCommand(name, args || {});
    }

    if (this.mods.length) { const r = this.ask('command', name, args); if (r) return r; }
    if (this.tasks[name] || TASKS[name]) return this.startTask(name, args);

    if (['follow', 'come', 'stay', 'flee', 'attack', 'guard', 'pick_up'].includes(name)) this.cancelTask(name === 'flee' ? 'had to run' : 'you called me back');
    switch (name) {
      case 'follow': this.stopAttack(); this.setMode('follow', 0); return { ok: true };
      case 'come': {
        const owner = this.ownerEntity();
        if (!owner) return { ok: false, reason: 'player_not_in_sight' };
        this.stopAttack(); this.setMode('come', 12);
        bot.pathfinder.setGoal(new GoalNear(owner.position.x, owner.position.y, owner.position.z, 1));
        this.goalKind = 'come';
        return { ok: true };
      }
      case 'stay': this.stopAttack(); this.setMode('stay', 90); bot.pathfinder.setGoal(null); this.goalKind = 'stay'; return { ok: true };
      case 'flee': this.stopAttack(); this.setMode('flee', 5); return { ok: true };
      case 'attack': {
        const target = this.nearestHostile(16) || (this.ownerEntity() && this.nearestHostile(16, this.ownerEntity().position));
        if (!target) return { ok: false, reason: 'no_enemies_nearby' };
        this.setMode('attack', 20); this.attack(target); return { ok: true };
      }
      case 'guard': this.setMode('guard', 120); return { ok: true };
      case 'pick_up': {
        const item = this.nearestItem(16);
        if (!item) return { ok: false, reason: 'nothing_nearby' };
        this.setMode('pickup', 8);
        bot.pathfinder.setGoal(new GoalNear(item.position.x, item.position.y, item.position.z, 0));
        this.goalKind = 'pickup';
        return { ok: true };
      }
      case 'emote': this.emote(); return { ok: true };
      case 'stop_task': this.cancelTask('you told me to stop'); this.setMode('follow', 0); return { ok: true };
      default: return { ok: false, reason: 'unknown_command' };
    }
  }

  stopAttack() {
    if (this.bot?.pvp?.target) this.bot.pvp.stop();
    this.attackTarget = null;
  }

  attack(entity, now = false) {
    if (this.mods.length) {
      if (this.ask('refuseTarget', entity)) return;
      if (!now && this.ask('beforeAttack', entity)) return;
    }
    this.attackTarget = entity;
    this.goalKind = 'attack';
    this.equipBestWeapon(true);
    this.bot.pvp.attack(entity);
  }

  nearestItem(range) {
    const bot = this.bot;
    let best = null, bd = range;
    for (const e of Object.values(bot.entities)) {
      if (e.name !== 'item' || !e.position) continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  startTask(name, args = {}) {
    const def = this.tasks[name] || TASKS[name];
    if (this.task && this.task.name === name) return { ok: true, already: true };
    if (this.task) this.cancelTask('switching to something else');
    const task = { name, label: def.label, started: Date.now(), cancelled: null };
    this.task = task;
    this.busy = true;
    this.stopAttack();
    this.setMode('task', 0);
    this.recent.push(name);
    if (this.recent.length > 4) this.recent.shift();
    this.emitEvent('task_started', { task: def.label }, null);
    this.emit('log', `job started: ${def.label} (${name}${args && Object.keys(args).length ? ` ${JSON.stringify(args).slice(0, 120)}` : ''})`);
    (async () => {
      let result = null, failure = null;
      try {
        if (this.moves) this.moves.canDig = true;

        result = await taskCtx.run(task, () => def.run(this.skills, args));
      } catch (err) {
        failure = err.cancelled ? null : err instanceof Nope ? err.message : `something went wrong (${String(err.message || err).slice(0, 60)})`;
        if (err.cancelled) this.emit('log', `task ${name} stopped: ${err.message}`);
        else this.emit('log', `task ${name} failed: ${err.stack || err}`);
      } finally {
        if (this.moves) this.moves.canDig = false;
        if (this.bot?.pathfinder) { this.bot.pathfinder.setMovements(this.moves); if (!task.cancelled) this.bot.pathfinder.setGoal(null); }
        if (this.task === task) { this.task = null; this.busy = false; this.setMode('follow', 0); }
        this.lastTaskEnd = Date.now();
        this.lastFreeTime = Date.now();
        this.freeGap = this.pickFreeGap();
        this.equipBestWeapon();
      }
      if (task.cancelled) return;
      this.emit('log', failure ? `job failed: ${def.label} (${failure})` : `job done: ${def.label} (${String(result || 'done').slice(0, 120)})`);
      if (failure) this.emitEvent('task_failed', { task: def.label, reason: failure }, null);
      else this.emitEvent('task_done', { task: def.label, result: result || 'done' }, null);
    })();
    return { ok: true, started: true };
  }

  cancelTask(reason = 'stopped') {
    const t = this.task;
    if (!t) return false;
    t.cancelled = reason;
    this.emit('log', `job stopped: ${t.label} (${reason})`);
    this.task = null;
    this.busy = false;
    try { this.bot?.pathfinder?.stop(); } catch {}
    try { this.bot?.collectBlock?.cancelTask?.(); } catch {}
    try { this.bot?.stopDigging?.(); } catch {}
    if (this.bot?.pathfinder && this.moves) this.bot.pathfinder.setMovements(this.moves);
    return true;
  }

  taskProgress(note, data = {}) {
    if (!this.task) return;
    this.emitThrottled(`progress-${note}`, 20000, 'task_progress', { task: this.task.label, note }, data.big ? 'high' : null);
  }

  maybeFreeTime(now) {
    if (!this.opts.freeWill || this.busy || this.mode !== 'follow' || this.diedAt) return;
    if (this.bot.pvp?.target || this.hostiles(12).length) return;
    const quietFor = now - Math.max(this.lastFreeTime, this.lastCommandAt, this.lastTaskEnd);
    if (quietFor < this.freeGap) return;
    this.lastFreeTime = now;
    this.freeGap = this.pickFreeGap();
    const s = this.skills;
    const notable = s.items().filter((i) => /diamond|iron|gold|coal|_log$|_planks$|cobblestone|torch|beef|porkchop|bread|chicken/.test(i.name))
      .sort((a, b) => b.count - a.count).slice(0, 6).map((i) => `${i.count} ${i.displayName}`);
    const pick = s.bestTier('pickaxe');
    const night = this.isNight();
    let hint;
    if (night && !this.home) hint = "It's night and you don't have a shelter yet.";
    else if (pick < 0) hint = "You don't have a pickaxe yet.";
    else if (pick < 2) hint = 'Your best pickaxe is wood or stone.';
    else if (!s.count('diamond')) hint = 'You have iron tools and no diamonds yet.';
    this.emitEvent('free_time', {
      time: night ? 'night' : 'day',
      tools: s.toolSummary().join(', ') || 'no tools',
      carrying: notable.join(', ') || 'nothing notable',
      house: this.home ? 'yes' : 'no',
      recently: this.recent.map((n) => (this.tasks[n] || TASKS[n])?.label).filter(Boolean).join(', ') || 'nothing',
      hint: hint || ''
    }, null);
  }

  async emote() {
    const bot = this.bot;
    const owner = this.ownerEntity();
    try {
      if (owner) await bot.lookAt(owner.position.offset(0, 1.6, 0));
      for (let i = 0; i < 2; i++) {
        bot.setControlState('jump', true); bot.swingArm();
        await new Promise((r) => setTimeout(r, 350));
        bot.setControlState('jump', false);
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch {}
  }

  equipBestWeapon(fight = false) {
    const bot = this.bot;
    if (!bot || this.busy) return;

    if (this.feats.toolHands && this.handHold && !fight && !this.attackTarget && this.keepHand()) return;
    const items = bot.inventory.items();
    for (const name of WEAPONS) {
      const it = items.find((i) => i.name === name);
      if (it) { if (bot.heldItem?.name !== name) bot.equip(it, 'hand').catch(() => {}); return; }
    }
  }

  async tryEat(force = false) {
    const bot = this.bot;
    if (!bot || this.eating || (this.busy && !force)) return;
    const mcData = require('minecraft-data')(bot.version);
    const food = bot.inventory.items().find((i) => mcData.foodsByName?.[i.name] && !/rotten|spider_eye|poison|pufferfish/.test(i.name));
    if (!food) return;
    this.eating = true;
    try { await bot.equip(food, 'hand'); await bot.consume(); } catch {} finally { this.eating = false; if (!this.busy) this.equipBestWeapon(); }
  }

  tick() {
    if (this.doingNow()) this.lastBusyAt = Date.now();
    const bot = this.bot;
    if (this.mods.length) this.hook('onTick', Date.now());
    if (!bot?.entity || this.diedAt) return;
    const owner = this.ownerEntity();
    const T = this.traits;
    const now = Date.now();

    if (this.feats.movesStill && owner) {
      this.ownerTrail.push({ t: now, p: owner.position.clone() });
      while (this.ownerTrail.length && now - this.ownerTrail[0].t > 4000) this.ownerTrail.shift();
    }

    const around = owner ? owner.position : bot.entity.position;
    for (const e of this.hostiles(14, around)) {
      if (this.seen.has(e.id)) continue;
      this.seen.set(e.id, now);
      const name = e.displayName || e.name;

      const key = `spot-${e.name}`;
      if (e.name !== 'creeper' && now - (this.lastEmit.spotAny || 0) < 15000) continue;
      if (now - (this.lastEmit[key] || 0) < 20000) continue;
      this.lastEmit[key] = now;
      this.lastEmit.spotAny = now;
      this.emitEvent('monster_spotted', { monster: name, distance_m: Math.round(e.position.distanceTo(around)) }, e.name === 'creeper' ? 'high' : 'normal');
    }
    if (this.seen.size > 300) this.seen.clear();
    if (this.decided.size > 500) this.decided.clear();
    const creeper = this.hostiles(5, around).find((e) => e.name === 'creeper') || this.hostiles(4).find((e) => e.name === 'creeper');
    if (creeper) this.emitThrottled('creeper', 8000, 'monster_chasing', { monster: 'Creeper' }, 'high');
    const night = this.isNight();
    if (this.wasNight !== null && night !== this.wasNight) {

      const t = this.bot?.time?.time;
      const day = !night && Number.isFinite(t) ? Math.floor((t + 1000) / 24000) + 1 : null;
      this.emitEvent(night ? 'night_started' : 'day_started', day ? { day } : {}, null);
    }
    this.wasNight = night;

    if (this.mods.length && this.ask('takeOver', now)) return;

    if (this.busy) {

      const jumped = this.nearestHostile(3.2);
      if (jumped && this.task && jumped.name !== 'enderman') {
        const label = this.task.label;
        this.cancelTask('got jumped');
        this.setMode('attack', 20);
        this.attack(jumped);
        this.emitEvent('task_failed', { task: label, reason: `a ${jumped.displayName || jumped.name} got within 3 blocks of you` }, 'high');
      }
      return;
    }
    if (this.modeUntil && now > this.modeUntil) this.setMode('follow', 0);

    const scary = this.hostiles(7).find((e) => ['creeper', 'enderman', 'witch', 'ravager', 'warden'].includes(e.name));
    if (scary && !this.decided.has(`panic-${scary.id}`) && this.mode !== 'attack') {
      this.decided.add(`panic-${scary.id}`);
      if (Math.random() < (T.panic || 0) / 12) { this.stopAttack(); this.setMode('flee', 4); }
    }

    switch (this.mode) {
      case 'flee': {
        const threat = this.nearestHostile(16);
        if (threat && this.goalKind !== `flee-${threat.id}`) {
          bot.pathfinder.setGoal(new GoalInvert(new GoalFollow(threat, 12)), true);
          this.goalKind = `flee-${threat.id}`;
        } else if (!threat) this.setMode('follow', 0);
        return;
      }
      case 'stay': {
        const close = this.nearestHostile(3.5);
        if (close && !bot.pvp.target) this.attack(close);
        return;
      }
      case 'attack': {
        if (!bot.pvp.target) {
          const next = this.nearestHostile(16);
          if (next) this.attack(next); else this.setMode('follow', 0);
        }
        return;
      }
      case 'come':
      case 'pickup':
        if (!bot.pathfinder.isMoving()) this.setMode('follow', 0);
        return;
      default: break;
    }

    if (!bot.pvp.target) {
      const radius = this.mode === 'guard' ? 12 : T.bravery >= 6 ? 10 : (T.loyalty || 0) >= 5 ? 6 : 3;
      const threat = (owner && this.nearestHostile(radius, owner.position)) || this.nearestHostile(3.5);
      if (threat && threat.name !== 'enderman') { this.attack(threat); return; }
    } else return;

    if (this.feats.toolHands && this.handHold && !this.eating && now - (this.lastHandCheck || 0) > 2000) { this.lastHandCheck = now; this.keepHand(); }

    if (this.feats.movesStill && this.handsOff && now < this.handsOff.until && this.mode === 'follow'
      && (!owner || owner.position.distanceTo(bot.entity.position) < this.followGap() + 10)) {
      if (this.goalKind !== 'hands-off') { bot.pathfinder.setGoal(null); this.goalKind = 'hands-off'; }
      return;
    }
    if (this.goalKind === 'hands-off') { this.goalKind = null; this.handsOff = null; }

    const item = this.nearestItem(7);
    if (item && !this.decided.has(`item-${item.id}`) && !this.hostiles(10).length) {
      this.decided.add(`item-${item.id}`);
      if (Math.random() < (T.greed || 0) / 10) {
        this.setMode('pickup', 6);
        bot.pathfinder.setGoal(new GoalNear(item.position.x, item.position.y, item.position.z, 0));
        this.goalKind = 'pickup';
        return;
      }
    }

    if (owner && this.goalKind !== `follow-${owner.id}`) {

      bot.pathfinder.setGoal(this.followGoalFor(owner), true);
      this.goalKind = `follow-${owner.id}`;
    }
    if (owner) this.maybeFreeTime(now);
  }
}

function friendlyError(err) {
  const m = err?.code || err?.message || String(err);
  if (/ECONNREFUSED/.test(m)) return 'No Minecraft server found at that address. Start the server first.';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'That server address could not be found.';
  if (/ETIMEDOUT/.test(m)) return 'The server did not answer in time.';
  return String(err?.message || m).slice(0, 200);
}

module.exports = { MinecraftCompanion, validUsername };
