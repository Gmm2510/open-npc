// Notices more of the game the way a teammate would: fights, danger, what the player builds and breaks, a little score.
const { goals } = require('mineflayer-pathfinder');
const { Part, Cooldowns, isAir, isLiquid, isSolid, itemKind, pretty, rand, DEG, findBlocksFast } = require('./bodykit');
const { Nope } = require('./skills');
const { blockVisible, entityVisible, inCone, keyOf } = require('./perception');

const { GoalNear } = goals;
const { Vec3 } = require('vec3');

const NOTABLE_HELD = /^(diamond|netherite)_|^(elytra|trident|mace|totem_of_undying|enchanted_golden_apple|golden_apple|spyglass|ender_eye|dragon_egg|beacon|nether_star|name_tag|axolotl_bucket|tadpole_bucket|heart_of_the_sea|recovery_compass|goat_horn|music_disc_[a-z0-9_]+|([a-z_]+_)?shulker_box)$/;
const RARE_MOBS = {
  skeleton_horse: 'a skeleton horse', zombie_horse: 'a zombie horse', panda: 'a panda', mooshroom: 'a mooshroom', polar_bear: 'a polar bear',
  fox: 'a fox', ocelot: 'an ocelot', parrot: 'a parrot', axolotl: 'an axolotl', allay: 'an allay', camel: 'a camel', sniffer: 'a sniffer',
  armadillo: 'an armadillo', wandering_trader: 'a wandering trader', trader_llama: 'a trader llama', villager: 'a villager',
  iron_golem: 'an iron golem', dolphin: 'a dolphin', turtle: 'a turtle', glow_squid: 'a glow squid', frog: 'a frog', goat: 'a goat'
};
const RARE_BLOCKS = [
  { names: ['amethyst_block', 'budding_amethyst'], min: 3, thing: 'a geode' },
  { names: ['spawner'], min: 1, thing: 'a mob spawner' },
  { names: ['bell'], min: 1, thing: 'a village bell' },
  { names: ['lava'], min: 8, thing: 'a lava lake' },
  { names: ['end_portal_frame'], min: 2, thing: 'an end portal frame' }
];
const PROTECTED_MOBS = /^(villager|wandering_trader|iron_golem|snow_golem|allay)$/;
const PET_MOBS = /^(wolf|cat|parrot|horse|donkey|mule|llama|camel|skeleton_horse)$/;
const COMMON_BIOME = /^(plains|sunflower_plains|forest|flower_forest|birch_forest|river|ocean|deep_ocean|beach|taiga|old_growth_[a-z_]*taiga|windswept_hills|stony_shore|[a-z_]*_ocean|the_void|meadow)$/;
const STONEY = /stone|deepslate|_ore$|netherrack|tuff|granite|diorite|andesite|calcite/;
const FANCY = /glass|wool|concrete|terracotta|quartz|^(gold|diamond|emerald|iron|lapis)_block$|lantern|banner|stairs|slab|fence|door|torch|bookshelf|brick|carpet|flower|lamp|copper/;
const SOLO_TASKS = /^(explore|get_my_stuff|give_loot)$/;

function summarizeBuild(list) {
  const xs = list.map((b) => b.pos.x), ys = list.map((b) => b.pos.y), zs = list.map((b) => b.pos.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const dx = maxX - minX + 1, dy = maxY - minY + 1, dz = maxZ - minZ + 1;
  const w = Math.max(dx, dz), d = Math.min(dx, dz), h = dy;
  let shape;
  if (h >= 4 && w <= 2) shape = 'a tower';
  else if (h === 1 && d <= 1 && w >= 4) shape = 'a bridge or path';
  else if (h === 1 && d >= 3) shape = 'a floor';
  else if (d <= 1 && w >= 3 && h >= 2) shape = 'a wall';
  else if (d >= 3 && h >= 2) {
    const top = list.filter((b) => b.pos.y === maxY).length;
    const roofed = top >= 0.5 * dx * dz && h >= 3;
    shape = roofed ? 'a little house' : 'some walls';
  } else shape = 'a small build';
  const counts = new Map();
  for (const b of list) counts.set(b.name, (counts.get(b.name) || 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const main = sorted.filter(([, n], i) => i === 0 || n >= list.length * 0.25).slice(0, 2).map(([n]) => pretty(n));
  const standout = sorted.slice(main.length).filter(([n]) => FANCY.test(n)).slice(0, 2).map(([n]) => pretty(n));
  const size = h === 1 ? `${dx} by ${dz}` : `${w} wide and ${h} tall`;
  return { blocks: list.length, shape, size, main: main.join(' and '), standout: standout.join(' and ') || null,
    center: { x: (minX + maxX) / 2 + 0.5, y: (minY + maxY) / 2 + 0.5, z: (minZ + maxZ) / 2 + 0.5 } };
}

function clusterFrom(list, start, { gap = 2, cap = 800 } = {}) {
  if (!list.length || !start) return [];
  const cells = new Map();
  for (const b of list) cells.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, b);
  const out = [];
  const seen = new Set();
  const first = list.find((b) => b.pos.x === start.x && b.pos.y === start.y && b.pos.z === start.z) || list[list.length - 1];
  const queue = [first];
  seen.add(`${first.pos.x},${first.pos.y},${first.pos.z}`);
  while (queue.length && out.length < cap) {
    const b = queue.shift();
    out.push(b);
    for (const c of cells.values()) {
      const k = `${c.pos.x},${c.pos.y},${c.pos.z}`;
      if (seen.has(k)) continue;
      if (Math.abs(c.pos.x - b.pos.x) <= gap && Math.abs(c.pos.y - b.pos.y) <= gap && Math.abs(c.pos.z - b.pos.z) <= gap) { seen.add(k); queue.push(c); }
    }
  }
  return out;
}

const SOLIDISH = (n) => !!n && !/^(air|cave_air|void_air|water|lava|short_grass|tall_grass|grass|fern|large_fern|snow|dead_bush|seagrass)$/.test(n) && !/flower|sapling|torch$|wall_torch|_button$|pressure_plate|carpet$|rail$|^vine$/.test(n);

function readStructure(list, getName) {
  const sum = summarizeBuild(list);
  const xs = list.map((b) => b.pos.x), ys = list.map((b) => b.pos.y), zs = list.map((b) => b.pos.z);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const dx = x1 - x0 + 1, dz = z1 - z0 + 1, h = y1 - y0 + 1;
  let doorCells = 0, glass = 0;
  const extras = new Set();
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1 + 1; y++) for (let z = z0; z <= z1; z++) {
    const n = getName(x, y, z);
    if (!n) continue;
    if (/_door$/.test(n) && !/trapdoor/.test(n)) doorCells++;
    else if (/glass/.test(n)) glass++;
    else if (/_bed$/.test(n)) extras.add('a bed');
    else if (/^(chest|barrel|trapped_chest)$/.test(n)) extras.add('a chest');
    else if (n === 'crafting_table') extras.add('a crafting table');
    else if (/^(furnace|blast_furnace|smoker)$/.test(n)) extras.add('a furnace');
    else if (/torch$|lantern$/.test(n)) extras.add('torches');
  }

  const filled = (x, y, z) => { const n = getName(x, y, z); return SOLIDISH(n) || /glass|_door$/.test(n || ''); };
  const sideFill = (pts) => (pts.length ? pts.filter(([x, y, z]) => filled(x, y, z)).length / pts.length : 0);
  const ysWall = []; for (let y = y0; y <= Math.max(y0, y1 - 1); y++) ysWall.push(y);
  const sides = [];
  if (dx >= 3 && dz >= 3 && h >= 2) {
    const line = (fix, axis) => { const pts = []; for (const y of ysWall) for (let t = (axis === 'x' ? z0 : x0); t <= (axis === 'x' ? z1 : x1); t++) pts.push(axis === 'x' ? [fix, y, t] : [t, y, fix]); return pts; };
    sides.push(sideFill(line(x0, 'x')), sideFill(line(x1, 'x')), sideFill(line(z0, 'z')), sideFill(line(z1, 'z')));
  }
  const walls = sides.filter((f) => f >= 0.5).length;
  let roof = 0, inside = 0, hollow = 0;
  if (dx >= 3 && dz >= 3) {
    let cov = 0, n = 0;
    for (let x = x0 + 1; x < x1; x++) for (let z = z0 + 1; z < z1; z++) {
      n++;
      if (filled(x, y1, z) || filled(x, y1 + 1, z)) cov++;
      for (let y = y0; y < y1; y++) { inside++; if (!filled(x, y, z)) hollow++; }
    }
    roof = n ? cov / n : 0;
  }
  const open = inside ? hollow / inside : 0;
  let shape = sum.shape;
  if (walls >= 3 && roof >= 0.6 && h >= 3 && open >= 0.4) shape = dx * dz <= 30 ? 'a little house' : 'a house';
  else if (walls >= 3 && roof < 0.3 && h >= 2) shape = 'walls for something, no roof yet';
  else if (roof >= 0.6 && walls < 3 && h >= 3) shape = 'a roofed shelter, open on the sides';
  const doors = Math.ceil(doorCells / 2);
  const parts = [];
  if (doors) parts.push(doors === 1 ? 'a door' : `${doors} doors`);
  if (glass) parts.push(glass === 1 ? 'a window' : `${glass} glass windows`);
  if (/house|shelter/.test(shape) && roof >= 0.6) parts.push('a roof');
  const size = h === 1 ? `${dx} by ${dz}` : dx >= 3 && dz >= 3 ? `about ${dx} by ${dz} and ${h} tall` : sum.size;
  const text = `${shape}, ${size}, mostly ${sum.main || 'blocks'}${parts.length ? `, with ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : ''}${extras.size ? `. Inside or on it: ${[...extras].join(', ')}` : ''} (${sum.blocks} blocks)`;
  return { ...sum, shape, size, doors, windows: glass, roof: Math.round(roof * 100) / 100, walls, extras: [...extras], text, house: /house/.test(shape) };
}

function classifyActivity(ctx, now) {
  const brk = ctx.broken.filter((b) => now - b.at <= 20000);
  const logs = brk.filter((b) => /_(log|stem)$/.test(b.name)).length;
  const stone = brk.filter((b) => STONEY.test(b.name)).length;
  const below = brk.filter((b) => b.below).length;
  if (below >= 3 && ctx.ydrop >= 3) return 'digging straight down';
  if (logs >= 3) return 'chopping wood';
  if (stone >= 4) return 'mining';
  if (ctx.placed.filter((p) => now - p.at <= 30000).length >= 6) return 'building something';
  if (ctx.fleeing) return 'running from a mob';
  if (ctx.covered && !ctx.wasCovered && ctx.moved10 >= 6) return 'heading into a cave';
  if (ctx.moved30 >= 40) return 'exploring';
  return null;
}

class Awareness extends Part {
  constructor(c) {
    super(c, ['gameAwareness', 'socialBody', 'seeBuilds']);
    this.cool = new Cooldowns();
    this.scoreboard = { companion: { kills: 0, deaths: 0, diamonds: 0 }, player: { kills: 0, deaths: 0, diamonds: 0 } };
    this.placed = new Map();
    this.death = null;
    this.running = null;
    this.tenseNow = false;
    this.tenseUntil = 0;

    c.addTask('get_my_stuff', { label: 'running back for your dropped items', run: (s) => this.runBack(s) });
  }

  ga() { return this.c.f('gameAwareness'); }

  setup(bot) {
    const now = Date.now();
    this.spawnAt = now;
    this.placeLog = []; this.breakLog = [];
    this.ownerSwingAt = 0; this.botPlace = null; this.botDig = null;
    this.tossed = new Map(); this.gift = null; this.giftTarget = null;
    this.heldSeen = new Set(); this.lastHeld = null;
    this.hits = 0;
    this.weather = bot.thunderState > 0.5 ? 'thunder' : bot.isRaining ? 'rain' : 'clear'; this.weatherSince = now;
    this.dark = false; this.brightSince = now;
    this.biome = null; this.biomeSeen = new Set(); this.biomeCand = null;
    this.ot = null; this.lastOwnerActive = now; this.idleSent = false; this.cueSeen = false;
    this.act = { current: null, since: 0 };
    this.spotted = new Set(); this.nextSpot = 0; this.nextBlockSpot = 0;
    this.retreat = null;
    this.taskWatch = null;
    this.prevEmpty = null; this.torches = this.countTorches();
    this.reportedBuild = null; this.lastBuild = null; this.lastPlaceAt = 0;

    this.listen(bot, 'entitySwingArm', (e) => { if (e === this.c.ownerEntity()) { this.ownerSwingAt = Date.now(); this.active(); } });
    this.listen(bot, 'blockUpdate', (o, n) => this.onBlockUpdate(o, n));
    this.patch(bot, '_genericPlace', (next, ref, face, opts) => { try { this.botPlace = { at: Date.now(), pos: ref.position.plus(face) }; } catch {} return next(ref, face, opts); });
    this.patch(bot, 'dig', (next, block, ...a) => { if (block?.position) this.botDig = { at: Date.now(), pos: block.position.clone() }; return next(block, ...a); });
    this.listen(bot, 'entitySpawn', (e) => this.onEntitySpawn(e));
    this.listen(bot, 'playerCollect', (who, what) => this.onCollect(who, what));
    this.listen(bot, 'entityEquip', (e) => this.onEquip(e));
    this.listen(bot, 'entityHurt', (e, src) => this.onHurt(e, src));
    this.listen(bot, 'rain', () => this.onWeather());
    this.listen(bot, 'weatherUpdate', () => this.onWeather());
    this.listen(bot, 'messagestr', (msg) => this.onMessage(msg));
    this.listen(bot, 'chat', (username) => { if (this.c.opts.owner && username.toLowerCase() === this.c.opts.owner.toLowerCase()) this.active(); });
    this.listen(bot, 'death', () => this.onDeath());
    this.listen(bot, 'soundEffectHeard', (name, pos) => { if (/item[._]break/.test(name) && pos && bot.entity && pos.distanceTo(bot.entity.position) < 3) this.breakSoundAt = Date.now(); });
    this.listen(bot.inventory, 'updateSlot', (slot, oldItem, newItem) => this.onSlot(oldItem, newItem));
    this.listen(this.c, 'event', (ev) => this.onCompanionEvent(ev));

    if (bot.pvp) this.patch(bot.pvp, 'attack', (next, target) => (this.refuseTarget(target) ? Promise.resolve() : next(target)));
  }

  teardown() { this.retreat = null; }

  active() { this.lastOwnerActive = Date.now(); if (this.idleSent) this.backNow(); }
  emitGA(event, data, priority = null) { if (this.ga()) this.emitEvent(event, data, priority); }
  owner() { return this.c.ownerEntity(); }
  social() { return this.c.f('socialBody') ? this.c.v12.social : null; }
  motor() { return this.c.v12.motor?.installed?.() ? this.c.v12.motor : null; }
  eye(e = this.c.bot.entity) { return e.position.offset(0, e === this.c.bot.entity ? (e.eyeHeight ?? 1.62) : (e.type === 'player' ? 1.62 : (e.height || 1.8) * 0.85), 0); }
  canSee(e) { return entityVisible(this.c.bot, this.eye(), e); }
  countTorches() { try { return this.c.bot.inventory.items().filter((i) => i.name === 'torch').reduce((n, i) => n + i.count, 0); } catch { return 0; } }

  isPlayerBlock(pos) { return this.placed.has(keyOf(pos)); }
  playerChests() { return [...this.placed.values()].filter((b) => /chest|barrel|shulker/.test(b.name)).map((b) => b.pos); }
  scores() { return JSON.parse(JSON.stringify(this.scoreboard)); }
  playerActivity() { return this.ga() ? this.act.current : null; }
  buildSummary() { return this.lastBuild; }

  onBlockUpdate(old, nw) {
    if (!old || !nw || !this.live()) return;
    const owner = this.owner();
    const now = Date.now();
    const pos = nw.position;
    const k = keyOf(pos);
    const near = owner && owner.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 5.8;
    const swung = now - this.ownerSwingAt <= 800;
    const wasEmpty = isAir(old) || old.boundingBox === 'empty';
    const nowEmpty = isAir(nw) || isLiquid(nw);
    if (wasEmpty && !nowEmpty && nw.boundingBox !== 'empty') {
      const botPlaced = this.botPlace && now - this.botPlace.at < 1500 && this.botPlace.pos.equals(pos);
      if (botPlaced || !near || !swung) return;
      const rec = { pos: pos.clone(), name: nw.name, at: now };
      this.placed.set(k, rec);
      if (this.placed.size > 5000) this.placed.delete(this.placed.keys().next().value);
      this.placeLog.push(rec);
      this.lastPlaceAt = now;
      this.active();
      return;
    }
    if (!isAir(old) && nowEmpty) {
      const mine = this.placed.get(k);
      if (mine) this.placed.delete(k);
      const bot = this.c.bot;
      const botBroke = (this.botDig && now - this.botDig.at < 4000 && this.botDig.pos.equals(pos)) || (bot.targetDigBlock && bot.targetDigBlock.position.equals(pos));
      if (botBroke) {
        if (mine) this.social()?.onBrokePlayerBlock?.(mine);
        return;
      }
      if (!near || !swung) return;
      this.breakLog.push({ name: old.name, at: now, below: pos.y < owner.position.y - 0.5 });
      if (this.breakLog.length > 200) this.breakLog.shift();
      this.active();

      const found = /diamond_ore$/.test(old.name) ? 'diamonds' : /emerald_ore$/.test(old.name) ? 'emeralds' : old.name === 'ancient_debris' ? 'ancient debris' : null;
      if (found && this.cool.take('found', 120000, now)) this.emitGA('player_found', { thing: found }, 'high');
    }
  }

  checkBuild(now) {
    if (this.c.f('seeBuilds')) return this.checkWholeBuild(now);
    if (!this.placeLog.length || now - this.lastPlaceAt < 4000) return;
    this.placeLog = this.placeLog.filter((p) => now - p.at < 180000 && this.placed.has(keyOf(p.pos)));
    if (this.placeLog.length < 8) return;
    const last = this.placeLog[this.placeLog.length - 1];
    const cluster = this.placeLog.filter((p) => p.pos.distanceTo(last.pos) <= 7);
    if (cluster.length < 8) return;
    const r = this.reportedBuild;
    if (r && r.center.distanceTo(last.pos) < 10 && cluster.length < r.n + 12) return;
    if (!this.cool.take('build', 150000, now)) return;
    const summary = summarizeBuild(cluster);
    this.reportedBuild = { center: last.pos.clone(), n: cluster.length };
    this.lastBuild = summary;
    if (!this.ga()) return;
    const emit = () => this.emitGA('player_build', { blocks: summary.blocks, shape: summary.shape, size: summary.size, main: summary.main, standout: summary.standout });
    const s = this.social();
    if (s?.watchBuild) s.watchBuild(summary, emit); else emit();
  }

  readBuild(cluster) {
    const bot = this.c.bot;
    return readStructure(cluster, (x, y, z) => { try { const b = bot.blockAt(new Vec3(x, y, z), false); return b ? b.name : null; } catch { return null; } });
  }

  checkWholeBuild(now) {
    if (!this.placeLog.length) return;
    if (this.placeLog.length > 3000) this.placeLog = this.placeLog.slice(-3000);
    const fresh = this.lastPlaceAt > (this.buildSeenAt || 0);
    const idle = now - this.lastPlaceAt;
    if (!fresh && !(idle >= 20000 && !this.buildIdleDone)) return;
    if (idle < 3000) return;
    this.buildSeenAt = now;
    if (fresh) this.buildIdleDone = false;
    if (idle >= 20000) this.buildIdleDone = true;
    this.placeLog = this.placeLog.filter((p) => now - p.at < 30 * 60 * 1000 && this.placed.has(keyOf(p.pos)));
    if (this.placeLog.length < 8) return;
    const last = this.placeLog[this.placeLog.length - 1];
    const cluster = clusterFrom(this.placeLog, last.pos);
    if (cluster.length < 8) return;
    const sum = this.readBuild(cluster);
    this.lastBuild = sum;
    const r = this.reportedBuild;
    const same = !!(r && r.keys && cluster.some((b) => r.keys.has(keyOf(b.pos))));
    const becameHouse = sum.house && !(same && r.house);
    const settled = idle >= 20000 && cluster.length >= 12 && (!same || cluster.length >= r.n * 1.5 + 6);
    if (!becameHouse && !settled) return;
    if (!this.cool.take('build121', 60000, now)) return;
    this.reportedBuild = { center: last.pos.clone(), n: cluster.length, house: sum.house, keys: new Set(cluster.map((b) => keyOf(b.pos))) };
    const data = { blocks: sum.blocks, shape: sum.shape, size: sum.size, main: sum.main, standout: sum.standout, doors: sum.doors || 0, windows: sum.windows || 0, roof: sum.roof >= 0.6, extras: sum.extras.join(', ') || null, added: same || null };
    const emit = () => (this.ga() ? this.emitGA('player_build', data) : this.emitEvent('player_build', data));
    const so = this.social();
    if (so?.watchBuild) so.watchBuild(sum, emit); else emit();
  }

  describeBuildNow() {
    if (!this.live()) return null;
    const bot = this.c.bot, o = this.owner();
    if (!bot?.entity || !o) return null;
    const now = Date.now();
    const list = this.placeLog.filter((p) => now - p.at < 30 * 60 * 1000 && this.placed.has(keyOf(p.pos)));
    if (!list.length) return null;
    let start = null;
    try {
      const t = this.c.v12.perception?.lookTarget?.(o, { maxDistance: 40 });
      if (t && t.position && this.placed.has(keyOf(t.position))) start = t.position;
    } catch {}
    if (!start) {
      const near = list.filter((p) => p.pos.distanceTo(o.position) <= 24);
      if (!near.length) return null;
      start = near[near.length - 1].pos;
    }
    const cluster = clusterFrom(list, start);
    if (cluster.length < 3) return null;
    const sum = this.readBuild(cluster);
    return { ...sum, text: `What the player built: ${sum.text}.` };
  }

  onEntitySpawn(e) {
    if (!this.live() || !e?.position) return;
    const owner = this.owner();
    const bot = this.c.bot;
    if (e.name === 'item' && owner) {

      const dx = Math.hypot(e.position.x - owner.position.x, e.position.z - owner.position.z);
      const dy = e.position.y - owner.position.y;
      if (dx <= 0.4 && dy >= 0.8 && dy <= 1.9) { this.tossed.set(e.id, Date.now()); if (this.tossed.size > 100) this.tossed.delete(this.tossed.keys().next().value); }
    }
    if (e.name === 'falling_block' && (this.c.task || bot.targetDigBlock)) {
      const p = bot.entity.position;
      if (Math.hypot(e.position.x - p.x, e.position.z - p.z) <= 2.5 && e.position.y > p.y + 0.5) this.hassle('gravel', 'gravel fell on you', 360000);
    }
  }

  onCollect(who, what) {
    if (!this.live()) return;
    const bot = this.c.bot;
    const item = typeof what?.getDroppedItem === 'function' ? what.getDroppedItem() : null;
    const owner = this.owner();
    if (item && item.name === 'diamond') {
      if (who === bot.entity) this.scoreboard.companion.diamonds += item.count;
      else if (owner && who === owner) this.scoreboard.player.diamonds += item.count;
    }
    if (who !== bot.entity || !this.tossed.has(what.id)) return;
    this.tossed.delete(what.id);
    if (!item) return;
    const now = Date.now();
    if (!this.gift) { this.gift = { items: new Map(), at: now }; this.later(1500, () => this.flushGift()); }
    const g = this.gift.items.get(item.name) || { count: 0, display: item.displayName || pretty(item.name) };
    g.count += item.count;
    this.gift.items.set(item.name, g);
  }

  flushGift() {
    const g = this.gift;
    this.gift = null;
    if (!g || !this.cool.take('gave', 15000)) return;
    const order = ['valuable', 'tool', 'armor', 'food', 'useful', 'junk'];
    const list = [...g.items.entries()].map(([name, v]) => ({ name, ...v, kind: itemKind(name) })).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const top = list[0];
    this.emitGA('player_gave', { item: list.map((x) => `${x.count > 1 ? `${x.count} ` : ''}${x.display}`).join(', '), count: list.reduce((n, x) => n + x.count, 0), kind: top.kind });
  }

  pickUpGift(now) {
    const c = this.c, bot = c.bot;
    if (c.busy || c.mode !== 'follow' || bot.pvp?.target || c.attackTarget) return false;
    for (const [id, at] of this.tossed) {
      const e = bot.entities[id];
      if (!e) { if (now - at > 10000) this.tossed.delete(id); continue; }
      if (now - at < 600 || e.position.distanceTo(bot.entity.position) > 12) continue;
      if (this.giftTarget === id) continue;
      if (c.hostiles(8).length) return false;
      this.giftTarget = id;
      c.setMode('pickup', 8);
      bot.pathfinder.setGoal(new GoalNear(e.position.x, e.position.y, e.position.z, 0));
      c.goalKind = 'pickup';
      return true;
    }
    return false;
  }

  onEquip(e) {
    const owner = this.owner();
    if (!this.ga() || !this.live() || !owner || e !== owner) return;
    const it = e.heldItem;
    const name = it?.name || null;
    if (name === this.lastHeld) return;
    this.lastHeld = name;
    if (!name) return;
    const enchanted = Array.isArray(it.enchants) && it.enchants.length > 0;
    if (!NOTABLE_HELD.test(name) && !enchanted) return;
    if (this.heldSeen.has(name)) return;
    const bot = this.c.bot;
    if (owner.position.distanceTo(bot.entity.position) > 12 || !this.canSee(owner)) return;
    this.heldSeen.add(name);
    if (!this.cool.take('held', 90000)) return;
    const m = this.motor();
    const delay = m ? m.reactionDelay() : 300;
    if (m) this.later(delay, () => m.glance(owner.position.offset(0, 1.2, 0), { holdMs: 900 }));
    this.later(delay + 500, () => this.emitGA('held_item', { item: `${enchanted ? 'an enchanted ' : ''}${pretty(it.displayName || name).toLowerCase()}` }));
  }

  onHurt(e, source) {
    if (!this.live()) return;
    const bot = this.c.bot, owner = this.owner(), now = Date.now();
    if (e !== bot.entity) return;
    const byPlayer = owner && ((source && source.id === owner.id)
      || (!source && now - this.ownerSwingAt <= 450 && owner.position.distanceTo(bot.entity.position) <= 4.5 && !this.c.nearestHostile(4)));
    if (byPlayer) {
      if (this.sparring()) return;
      this.hits++;
      this.social()?.onPunched?.(owner, this.hits);
      if ([1, 4, 10, 20].includes(this.hits) && this.cool.take('hit', 60000, now)) this.emitGA('player_hit_streamer', { count: this.hits, first: this.hits === 1 });
      return;
    }

    const close = this.c.nearestHostile(4);
    const archer = Object.values(bot.entities).find((x) => /^(skeleton|stray|bogged|pillager)$/.test(x.name || '') && x.position && x.position.distanceTo(bot.entity.position) <= 24);
    if (!close && (archer || /skeleton|stray|arrow/.test(source?.name || ''))) this.hassle('sniped', `a ${archer ? pretty(archer.name) : 'skeleton'} keeps shooting you`, 300000);
  }

  refuseTarget(entity) {
    if (!this.ga() || !entity) return null;
    if (entity.type === 'player') {
      const s = this.c.sparring;
      return s && (s === entity.username || s === entity.id || s === entity) ? null : true;
    }
    const name = entity.name || '';
    if (PROTECTED_MOBS.test(name)) return true;
    const keys = this.c.bot?.registry?.entitiesByName?.[name]?.metadataKeys || [];
    const md = entity.metadata || [];
    const nameIdx = keys.indexOf('custom_name');
    if (nameIdx >= 0 && md[nameIdx]) return true;
    if (PET_MOBS.test(name)) {
      const ownerIdx = keys.indexOf('owneruuid'), flagsIdx = keys.indexOf('flags');
      if ((ownerIdx >= 0 && md[ownerIdx]) || (flagsIdx >= 0 && (Number(md[flagsIdx]) & 0x04))) return true;
    }
    return null;
  }

  onWeather() {
    if (!this.live()) return;
    const bot = this.c.bot, now = Date.now();
    const w = bot.thunderState > 0.5 ? 'thunder' : bot.isRaining ? 'rain' : 'clear';
    if (w === this.weather) return;
    const prev = this.weather, prevSince = this.weatherSince;
    this.weather = w; this.weatherSince = now;
    if (now - this.spawnAt < 10000) return;
    if (w === 'clear' && now - prevSince < 60000) return;
    if (prev === 'thunder' && w === 'rain') return;
    if (this.cool.take('weather', 300000, now)) this.emitGA('weather_changed', { weather: w });
  }

  checkLight(now) {
    const bot = this.c.bot;
    const b = bot.blockAt(bot.entity.position.offset(0, 1.6, 0).floored(), false);
    if (!b || b.light == null || b.skyLight == null) return;
    const night = this.c.isNight();
    const lvl = Math.max(b.light, b.skyLight - (night ? 11 : 0));
    const covered = b.skyLight === 0;
    if (lvl >= 8) { if (!this.brightSince) this.brightSince = now; if (this.dark && now - this.brightSince >= 5000) this.dark = false; }
    else this.brightSince = 0;
    if (!this.dark && lvl < 4 && covered) {
      this.dark = true;
      if (this.cool.take('dark', 240000, now)) this.emitGA('dark_now', { where: bot.entity.position.y < 50 ? 'cave' : 'inside' });
    }
  }

  checkBiome(now) {
    const bot = this.c.bot;
    const b = bot.blockAt(bot.entity.position.floored(), false);
    const name = b?.biome?.name;
    if (!name) return;
    if (!this.biome) { this.biome = name; this.biomeSeen.add(name); return; }
    if (name === this.biome) { this.biomeCand = null; return; }
    if (!this.biomeCand || this.biomeCand.name !== name) { this.biomeCand = { name, at: now }; return; }
    if (now - this.biomeCand.at < 5000) return;
    this.biome = name; this.biomeCand = null;
    const fresh = !this.biomeSeen.has(name);
    this.biomeSeen.add(name);
    if (fresh && !COMMON_BIOME.test(name) && this.cool.take('biome', 300000, now)) this.emitGA('biome_changed', { biome: pretty(name) });
  }

  hassle(type, what, gapMs = 360000) {
    const now = Date.now();
    if (!this.ga() || !this.cool.ok('hassle', 90000, now) || !this.cool.take(`hassle-${type}`, gapMs, now)) return;
    this.cool.mark('hassle', now);
    this.emitGA('hassle', { what });
  }

  onSlot(oldItem, newItem) {
    if (!this.live()) return;
    const now = Date.now();
    if (oldItem && /_(pickaxe|axe|shovel|sword|hoe)$/.test(oldItem.name) && (!newItem || newItem.name !== oldItem.name)) {
      const worn = oldItem.maxDurability && oldItem.durabilityUsed != null && oldItem.durabilityUsed >= oldItem.maxDurability - 3;
      if (worn || now - (this.breakSoundAt || 0) < 1500) this.hassle('broke', `your ${pretty(oldItem.name)} broke`, 300000);
    }
    const t = this.countTorches();
    if (this.torches > 0 && t === 0) this.hassle('torches', 'you ran out of torches', 600000);
    this.torches = t;
  }

  checkHassles() {
    const bot = this.c.bot;
    const empty = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null;
    if (empty === 0 && this.prevEmpty > 0) this.hassle('full', 'your inventory is full', 600000);
    this.prevEmpty = empty;
    if (bot.food <= 6) {
      const food = bot.inventory.items().some((i) => itemKind(i.name) === 'food' && !/rotten|spider_eye|poison/.test(i.name));
      if (!food) this.hassle('starving', "you're starving and have no food", 600000);
    }
  }

  onCompanionEvent(ev) {
    const d = ev.data || {};
    const s = this.scoreboard;
    switch (ev.event) {
      case 'monster_killed': if (d.by === 'companion') s.companion.kills++; else if (d.by === 'player') s.player.kills++; break;
      case 'companion_downed': s.companion.deaths++; break;
      case 'player_died': s.player.deaths++; break;
      case 'task_started': {
        const owner = this.owner(), bot = this.c.bot;
        this.taskWatch = { task: this.c.task, ownerNear: !!(owner && bot?.entity && owner.position.distanceTo(bot.entity.position) <= 12), start: owner?.position?.clone() || null, together: false, farSince: 0 };
        break;
      }
      case 'companion_revived': this.maybeRunBack(); break;
      default: break;
    }
  }

  onMessage(msg) {
    const bot = this.c.bot;
    if (!this.death || !bot?.username || !msg || !msg.startsWith(`${bot.username} `)) return;
    const cause = msg.slice(bot.username.length + 1);
    this.death.cause = cause;
    if (/lava|burn|fire|flames|out of the world|void|fell from a high place into/.test(cause)) this.death.skip = true;
  }

  onDeath() {
    const bot = this.c.bot;
    if (!bot?.entity) return;
    const items = bot.inventory.items().reduce((n, i) => n + i.count, 0);
    this.death = { pos: bot.entity.position.clone(), at: Date.now(), cause: null, skip: !!this.running || items === 0 || bot.entity.position.y < -60 };
    this.retreat = null;
  }

  maybeRunBack() {
    const d = this.death;
    if (!this.ga() || !d || d.skip || d.started) return;
    d.started = true;
    this.later(rand(1500, 3000), () => {
      if (!this.ga() || !this.live() || this.c.task || this.death !== d) return;
      if (this.c.bot.entity.position.distanceTo(d.pos) > 300) return;
      this.c.startTask('get_my_stuff', {});
    });
  }

  async runBack(s) {
    const d = this.death;
    if (!d) throw new Nope('nothing to go back for');
    if (Date.now() - d.at > 4.5 * 60 * 1000) throw new Nope('your dropped items already despawned');
    const bot = this.c.bot;
    const count = () => bot.inventory.items().reduce((n, i) => n + i.count, 0);
    const before = count();
    this.running = d;
    try {
      try { await s.goto(new GoalNear(d.pos.x, d.pos.y, d.pos.z, 2), { dig: true, timeout: 90000 }); } catch (err) { if (err.cancelled) throw err; throw new Nope("couldn't get back to where you died"); }
      for (let i = 0; i < 14; i++) {
        s.check();
        const it = this.c.nearestItem(10);
        if (!it) break;
        await s.gotoNear(it.position, 0, { dig: false, timeout: 8000 }).catch((e) => { if (e.cancelled) throw e; });
        await s.wait(250);
      }
    } finally { this.running = null; }
    if (this.death === d) this.death = null;
    const got = count() - before;
    if (got <= 0) throw new Nope('your dropped items were gone');
    return `got your dropped items back (${got} items)`;
  }

  planChanged(from, to, why) {
    if (!from || !this.cool.take('plan', 60000)) return;
    this.emitGA('plan_changed', { from, to, why: why || null });
  }

  checkPlan(now) {
    const w = this.taskWatch, c = this.c, owner = this.owner();
    if (!w || !c.task || w.task !== c.task) { this.taskWatch = c.task ? this.taskWatch : null; return; }
    if (SOLO_TASKS.test(c.task.name) || !w.ownerNear) return;

    if (c.f('jobsStick') && !c.task.own12) return;
    const bot = c.bot;
    const d = owner ? owner.position.distanceTo(bot.entity.position) : Infinity;
    if (owner && w.start && owner.position.distanceTo(w.start) >= 8 && d <= 16) w.together = true;
    if (!w.together || now - c.task.started < 20000) return;
    if (d > 40) {
      if (!w.farSince) w.farSince = now;
      if (now - w.farSince >= 30000) {
        const label = c.task.label;
        c.cancelTask('you headed off');
        c.setMode('follow', 0);
        this.planChanged(label, 'catching up with the player', 'the player headed off');
        this.taskWatch = null;
      }
    } else w.farSince = 0;
  }

  takeOver(now) {
    if (!this.ga() || !this.live()) return null;
    if (this.retreat) return this.stepRetreat(now);
    if (this.othersSteering()) return null;
    const bot = this.c.bot;
    if (bot.health > 0 && bot.health < 12) {
      const threat = this.c.nearestHostile(7);
      if (threat && this.cool.ok('retreat', 15000, now)) return this.startRetreat(threat, now);
    }
    if (!this.c.busy && this.pickUpGift(now)) return true;
    return null;
  }

  startRetreat(threat, now) {
    const c = this.c, bot = c.bot;
    if (c.task) { const label = c.task.label; c.cancelTask('backing off, low health'); this.planChanged(label, 'backing off', 'low on health'); }
    c.stopAttack();
    c.setMode('flee', 0);
    c.goalKind = 'retreat';
    this.retreat = { threat, since: now, nextGoal: 0, nextLook: now + rand(500, 900), calm: 0, lastDist: threat.position.distanceTo(bot.entity.position), stuckSince: 0 };
    if (this.cool.take('lowhp', 45000, now)) this.emitGA('low_health', { health: Math.round(bot.health), retreating: true }, bot.health <= 6 ? 'high' : null);
    if (bot.food < 20) c.tryEat(true);
    return this.stepRetreat(now);
  }

  stepRetreat(now) {
    const c = this.c, bot = c.bot, r = this.retreat;
    const threat = (r.threat && bot.entities[r.threat.id]) ? r.threat : c.nearestHostile(10);
    const d = threat ? threat.position.distanceTo(bot.entity.position) : Infinity;
    if (!threat || d > 10) r.calm = r.calm || now; else r.calm = 0;

    if (threat && d < 2.2) { r.stuckSince = r.stuckSince || now; } else r.stuckSince = 0;
    const done = bot.health >= 14 || (r.calm && now - r.calm >= 3000) || now - r.since > 20000 || (r.stuckSince && now - r.stuckSince > 2000);
    if (done) { this.retreat = null; this.cool.mark('retreat', now); c.setMode('follow', 0); c.goalKind = null; return null; }
    r.threat = threat;
    if (now >= r.nextGoal && threat) {
      r.nextGoal = now + 1200;
      const owner = this.owner();
      const me = bot.entity.position;
      let spot;
      if (owner && owner.position.distanceTo(me) < 24) {
        const away = owner.position.minus(threat.position); const len = Math.hypot(away.x, away.z) || 1;
        spot = owner.position.offset((away.x / len) * 3, 0, (away.z / len) * 3);
      } else {
        const away = me.minus(threat.position); const len = Math.hypot(away.x, away.z) || 1;
        spot = me.offset((away.x / len) * 10, 0, (away.z / len) * 10);
      }
      bot.pathfinder.setGoal(new GoalNear(spot.x, spot.y, spot.z, 1.5));
    }

    const m = this.motor();
    if (m && threat && now >= r.nextLook) { r.nextLook = now + rand(1000, 1700); m.glance(threat, { holdMs: rand(250, 450), fast: true }); }
    return true;
  }

  backNow() {
    const away = Date.now() - (this.idleSince || Date.now());
    this.idleSent = false;
    if (away >= 180000 && this.cool.take('back', 60000)) this.emitGA('player_back', { away_min: Math.round(away / 60000) });
  }

  trackOwner(now) {
    const o = this.owner();
    if (!o) return;
    const p = o.position;
    if (!this.ot) this.ot = { pos: p.clone(), yaw: o.yaw, hist: [], peakY: p.y, peakAt: now, covered: false, coveredHist: [] };
    const ot = this.ot;
    const moved = p.distanceTo(ot.pos) > 0.25 || Math.abs((o.yaw || 0) - (ot.yaw || 0)) > 0.05;
    if (moved) { ot.pos = p.clone(); ot.yaw = o.yaw; this.active(); }
    ot.hist.push({ t: now, x: p.x, y: p.y, z: p.z });
    while (ot.hist.length && now - ot.hist[0].t > 30000) ot.hist.shift();

    const idleMs = this.cueSeen ? 180000 : 360000;
    if (!this.idleSent && now - this.lastOwnerActive >= idleMs) {
      this.idleSent = true; this.idleSince = this.lastOwnerActive;
      if (this.cool.take('idle', 300000, now)) this.emitGA('player_idle', { minutes: Math.round((now - this.lastOwnerActive) / 60000) });
    }

    if (p.y > ot.peakY) { ot.peakY = p.y; ot.peakAt = now; }
    const prev = ot.hist[ot.hist.length - 2];
    const stable = prev && Math.abs(prev.y - p.y) < 0.1;
    if (stable) {
      const drop = ot.peakY - p.y;
      const feet = this.c.bot.blockAt(p.floored(), false);
      if (drop >= 7 && drop / Math.max(0.2, (now - ot.peakAt) / 1000) >= 6 && !/water/.test(feet?.name || '') && this.cool.take('fall', 120000, now)) {
        this.emitGA('player_big_fall', { blocks: Math.round(drop) }, 'high');
      }
      ot.peakY = p.y; ot.peakAt = now;
    }

    ot.covered = this.coveredAt(p);
    ot.coveredHist.push({ t: now, v: ot.covered });
    while (ot.coveredHist.length && now - ot.coveredHist[0].t > 15000) ot.coveredHist.shift();
  }

  coveredAt(p) {
    const bot = this.c.bot;
    for (let dy = 2; dy <= 24; dy++) { const b = bot.blockAt(p.offset(0, dy, 0).floored(), false); if (isSolid(b)) return true; }
    return false;
  }

  checkActivity(now) {
    const ot = this.ot, o = this.owner();
    if (!ot || !o || ot.hist.length < 2) return;
    const at = (ms) => ot.hist.find((h) => now - h.t <= ms) || ot.hist[0];
    const h10 = at(10000), h20 = at(20000), h30 = at(30000);

    const h2 = at(2000);
    const mv = { x: o.position.x - h2.x, z: o.position.z - h2.z };
    const speed = Math.hypot(mv.x, mv.z) / Math.max(0.4, (now - h2.t) / 1000);
    const mob = speed >= 4 ? this.c.nearestHostile(10, o.position) : null;
    const fleeing = !!mob && (mv.x * (o.position.x - mob.position.x) + mv.z * (o.position.z - mob.position.z)) > 0;
    const ctx = {
      broken: this.breakLog, placed: this.placeLog, ydrop: h20.y - o.position.y,
      moved10: Math.hypot(o.position.x - h10.x, o.position.z - h10.z), moved30: Math.hypot(o.position.x - h30.x, o.position.z - h30.z),
      covered: ot.covered, wasCovered: ot.coveredHist.length ? ot.coveredHist[0].v : ot.covered, fleeing
    };
    const a = classifyActivity(ctx, now);
    if (a !== this.act.current) { this.act = { current: a, since: now, said: false }; return; }
    if (!a || this.act.said || now - this.act.since < 6000) return;
    this.act.said = true;
    if (this.cool.ok('act', 120000, now) && this.cool.take(`act-${a}`, 600000, now)) { this.cool.mark('act', now); this.emitGA('player_activity', { activity: a }); }
  }

  spotScan(now) {
    const bot = this.c.bot;
    if (now < this.nextSpot) return;
    this.nextSpot = now + 1200;
    if (!this.cool.ok('spotted', 240000, now)) return;
    const eye = this.eye();
    const yaw = this.c.v12.motor?.headYaw?.() ?? bot.entity.yaw * DEG, pitch = this.c.v12.motor?.headPitch?.() ?? bot.entity.pitch * DEG;
    for (const e of Object.values(bot.entities)) {
      if (!e.position || e === bot.entity) continue;
      const thing = this.rareThing(e);
      if (!thing || this.spotted.has(thing)) continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (d > 40 || !inCone(yaw, pitch, eye, e.position.offset(0, (e.height || 1) / 2, 0), 120, 100) || !entityVisible(bot, eye, e)) continue;
      this.spotted.add(thing);
      this.cool.mark('spotted', now);
      this.emitGA('spotted', { thing, distance_m: Math.round(d) });
      return;
    }
    if (now < this.nextBlockSpot) return;
    this.nextBlockSpot = now + 3000;

    this.blockTurn = ((this.blockTurn || 0) + 1) % RARE_BLOCKS.length;
    for (const r of [RARE_BLOCKS[this.blockTurn]]) {
      if (this.spotted.has(r.thing)) continue;
      const found = findBlocksFast(bot, r.names, { maxDistance: 32, count: 24, maxFullScans: 16 });
      let seen = 0, near = null;
      for (const p of found) {
        if (!inCone(yaw, pitch, eye, p.offset(0.5, 0.5, 0.5), 130, 110)) continue;
        if (blockVisible(bot, eye, p, 40)) { seen++; near = near || p; }
        if (seen >= r.min) break;
      }
      if (seen < r.min) continue;
      this.spotted.add(r.thing);
      this.cool.mark('spotted', now);
      this.emitGA('spotted', { thing: r.thing, distance_m: Math.round(near.distanceTo(bot.entity.position)) });
      return;
    }
  }

  rareThing(e) {
    if (e.name === 'sheep') {
      const keys = this.c.bot.registry?.entitiesByName?.sheep?.metadataKeys || [];
      const i = keys.indexOf('wool');
      const v = i >= 0 ? e.metadata?.[i] : null;
      return v != null && (Number(v) & 0x0f) === 6 ? 'a pink sheep' : null;
    }
    return RARE_MOBS[e.name] || null;
  }

  computeTense(now) {
    const c = this.c, bot = c.bot, e = bot.entity;
    const fight = !!(bot.pvp?.target || c.attackTarget || c.mode === 'flee' || this.retreat);
    const creeper = c.hostiles(6).some((m) => m.name === 'creeper');
    const low = bot.health <= 8 && c.hostiles(8).length > 0;
    const falling = (e.velocity?.y || 0) < -0.7;
    const building = typeof bot.pathfinder?.isBuilding === 'function' && bot.pathfinder.isBuilding();
    let lava = false, high = 0;
    const f = e.position.floored();
    for (let dx = -2; dx <= 2 && !lava; dx++) for (let dy = -1; dy <= 1 && !lava; dy++) for (let dz = -2; dz <= 2 && !lava; dz++) {
      const b = bot.blockAt(f.offset(dx, dy, dz), false);
      if (b && /lava/.test(b.name)) lava = true;
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let drop = 0;
      for (let dy = 0; dy <= 4; dy++) { if (isSolid(bot.blockAt(f.offset(dx, -1 - dy, dz), false))) break; drop++; }
      if (drop >= 4) high++;
    }
    const t = fight || creeper || low || falling || building || lava || (high >= 3 && isSolid(bot.blockAt(f.offset(0, -1, 0), false)));
    if (t) this.tenseUntil = now + 3000;
    this.tenseNow = now < this.tenseUntil;
  }

  isTense() { return !!(this.ga() && this.bot && this.tenseNow); }

  onTick(now) {
    if (!this.live()) return;
    this.trackOwner(now);
    this.checkBuild(now);
    if (!this.ga()) return;
    this.computeTense(now);
    this.checkActivity(now);
    this.checkLight(now);
    this.checkBiome(now);
    this.checkHassles(now);
    this.spotScan(now);
    this.checkPlan(now);
  }

  onCue(kind) {
    if (kind === 'player_talking_start' || kind === 'player_talking_end') { this.cueSeen = true; this.active(); }
  }

  state() {
    if (!this.ga() || !this.live()) return {};
    const out = {};
    const s = this.scoreboard;
    const any = (x) => x.kills || x.deaths || x.diamonds;
    if (any(s.companion) || any(s.player)) {
      const line = (x) => `${x.kills} kill${x.kills === 1 ? '' : 's'}, ${x.deaths} death${x.deaths === 1 ? '' : 's'}, ${x.diamonds} diamond${x.diamonds === 1 ? '' : 's'}`;
      out.score = `you ${line(s.companion)}; player ${line(s.player)}`;
    }
    if (this.tenseNow) out.tense = true;
    if (this.weather && this.weather !== 'clear') out.weather = this.weather === 'thunder' ? 'thunderstorm' : 'raining';
    if (this.dark) out.light = 'dark around you';
    if (this.biome && !COMMON_BIOME.test(this.biome)) out.biome = pretty(this.biome);
    if (this.act.current) out.player_doing = this.act.current;
    if (this.running) out.your_stuff_despawns_in = `about ${Math.max(0, Math.ceil((5 * 60 * 1000 - (Date.now() - this.running.at)) / 60000))} min`;
    return out;
  }
}

module.exports = { Awareness, summarizeBuild, clusterFrom, readStructure, classifyActivity, NOTABLE_HELD, RARE_MOBS };
