// Small shared helpers for the body modules: angles, cooldowns, item and block kinds, and the base class each module uses.
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

function wrapDeg(a) {
  let x = ((a + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

function yawPitchTo(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return { yaw: Math.atan2(-dx, -dz) * DEG, pitch: Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * DEG };
}

function dirOf(yawDeg, pitchDeg) {
  const y = yawDeg * RAD, p = pitchDeg * RAD;
  return { x: -Math.sin(y) * Math.cos(p), y: Math.sin(p), z: -Math.cos(y) * Math.cos(p) };
}

function angleBetween(y1, p1, y2, p2) {
  if (y1 === y2 && p1 === p2) return 0;
  const a = dirOf(y1, p1), b = dirOf(y2, p2);
  const cx = a.y * b.z - a.z * b.y, cy = a.z * b.x - a.x * b.z, cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z) * DEG;
}

const toNotchYaw = (yawDeg) => 180 - yawDeg;
const toNotchPitch = (pitchDeg) => -pitchDeg;
const fromNotchYaw = (y) => wrapDeg(180 - y);
const fromNotchPitch = (p) => -p;

function directionWords(fromPos, yawDeg, toPos) {
  const { yaw, pitch } = yawPitchTo(fromPos, toPos);
  const rel = wrapDeg(yaw - yawDeg);
  const abs = Math.abs(rel);
  const side = rel > 0 ? 'left' : 'right';
  let words;
  if (abs <= 35) words = 'in front of you';
  else if (abs >= 145) words = 'behind you';
  else if (abs >= 100) words = `behind you on the ${side}`;
  else words = `on your ${side}`;
  if (pitch > 40) words += ', up high';
  else if (pitch < -40) words += ', down below';
  return words;
}

const rand = (a, b, r = Math.random) => a + (b - a) * r();
const chance = (p, r = Math.random) => r() < p;
const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length)];

function lru(ledger, kind, items, keyOf = (x) => x) {
  const now = Math.max(Date.now(), (ledger._bodyLast || 0) + 1);
  ledger._bodyLast = now;
  return ledger.pickLru(kind, items, keyOf, now);
}

class Cooldowns {
  constructor(clock = Date.now) { this.last = new Map(); this.clock = clock; }
  ok(key, ms, now = this.clock()) { const t = this.last.get(key); return t == null || now - t >= ms; }
  take(key, ms, now = this.clock()) { if (!this.ok(key, ms, now)) return false; this.last.set(key, now); return true; }
  mark(key, now = this.clock()) { this.last.set(key, now); }
  clear() { this.last.clear(); }
}

const PATCHES = new WeakMap();
function patch(obj, key, id, fn) {
  if (!obj || typeof obj[key] !== 'function') return false;
  let m = PATCHES.get(obj);
  if (!m) { m = new Map(); PATCHES.set(obj, m); }
  let p = m.get(key);
  if (!p || obj[key] !== p.dispatcher) {
    p = { orig: obj[key], layers: [] };
    p.dispatcher = function (...args) {
      const self = this;
      const run = (i, a) => (i < p.layers.length ? p.layers[i].fn.call(self, (...b) => run(i + 1, b), ...a) : p.orig.apply(self, a));
      return run(0, args);
    };
    m.set(key, p);
    obj[key] = p.dispatcher;
  }
  p.layers = p.layers.filter((l) => l.id !== id);
  p.layers.push({ id, fn });
  return true;
}
function unpatch(obj, key, id) {
  const m = obj && PATCHES.get(obj);
  const p = m && m.get(key);
  if (!p) return;
  p.layers = p.layers.filter((l) => l.id !== id);
  if (!p.layers.length) {
    if (obj[key] === p.dispatcher) obj[key] = p.orig;
    m.delete(key);
  }
}

function original(obj, key) {
  const p = obj && PATCHES.get(obj)?.get(key);
  return p && obj[key] === p.dispatcher ? p.orig : obj?.[key];
}

const AIRISH = new Set(['air', 'cave_air', 'void_air']);
const SEE_THROUGH = /glass|leaves|^ice$|_bars$|fence|_door$|trapdoor|^ladder$|scaffolding|^chain$|lantern|torch|flower_pot|^water$|bubble_column|cobweb/;

function seeThrough(b) {
  if (!b) return false;
  if (AIRISH.has(b.name)) return true;
  if (b.name === 'lava') return false;
  if (b.boundingBox === 'empty') return true;
  return SEE_THROUGH.test(b.name);
}
const isLiquid = (b) => !!b && /^(water|lava|flowing_water|flowing_lava)$/.test(b.name);
const isSolid = (b) => !!b && b.boundingBox === 'block' && !/leaves$/.test(b.name);
const isAir = (b) => !b || AIRISH.has(b.name);

const VALUABLE = /diamond|emerald|netherite|ancient_debris|gold_ingot|gold_block|iron_block|totem|elytra|trident|enchanted|nether_star|beacon|shulker|heart_of_the_sea|echo_shard|music_disc|golden_apple|dragon_egg/;
const FOOD = /^(cooked_[a-z_]+|bread|apple|golden_carrot|baked_potato|pumpkin_pie|cake|cookie|melon_slice|sweet_berries|glow_berries|carrot|potato|beetroot|[a-z_]+_stew|[a-z_]+_soup|honey_bottle|dried_kelp|beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/;
const TOOL = /_(pickaxe|axe|shovel|hoe|sword)$|^(bow|crossbow|shield|fishing_rod|shears|flint_and_steel|spyglass)$/;
const ARMOR = /_(helmet|chestplate|leggings|boots)$/;
const JUNK = /^(dirt|cobblestone|cobbled_deepslate|gravel|sand|red_sand|netherrack|rotten_flesh|wheat_seeds|[a-z_]+_seeds|stick|poisonous_potato|spider_eye|bone|string|andesite|diorite|granite|tuff|deepslate|stone|grass_block|coarse_dirt|flint|feather|kelp|seagrass|short_grass|dead_bush)$/;

function itemKind(name) {
  const n = String(name || '');
  if (VALUABLE.test(n)) return 'valuable';
  if (TOOL.test(n)) return 'tool';
  if (ARMOR.test(n)) return 'armor';
  if (FOOD.test(n)) return 'food';
  if (JUNK.test(n)) return 'junk';
  return 'useful';
}
const pretty = (name) => String(name || '').replace(/^minecraft:/, '').replace(/_/g, ' ');

const STATE_SETS = new WeakMap();
function stateSet(reg, names) {
  let byKey = STATE_SETS.get(reg);
  if (!byKey) { byKey = new Map(); STATE_SETS.set(reg, byKey); }
  const key = names.join(',');
  let set = byKey.get(key);
  if (!set) {
    set = new Set();
    for (const n of names) { const b = reg.blocksByName?.[n]; if (b) for (let s = b.minStateId ?? b.id; s <= (b.maxStateId ?? b.minStateId ?? b.id); s++) set.add(s); }
    byKey.set(key, set);
  }
  return set;
}
function sectionMayHave(section, states) {
  if (!section) return false;
  const d = section.data;
  if (d && Array.isArray(d.palette)) return d.palette.some((s) => states.has(s));
  if (d && !d.palette && typeof d.value === 'number' && typeof d.get === 'function' && d.constructor?.name === 'SingleValueContainer') return states.has(d.value);
  return true;
}
function findBlocksFast(bot, names, opts = {}) {
  try { return findBlocksFastInner(bot, names, opts); } catch {
    const ids = names.map((n) => bot.registry?.blocksByName?.[n]?.id).filter((x) => x != null);
    return ids.length ? bot.findBlocks({ matching: ids, maxDistance: opts.maxDistance || 32, count: opts.count || 16 }) : [];
  }
}
function findBlocksFastInner(bot, names, { maxDistance = 32, count = 16, point = null, maxFullScans = 96 } = {}) {
  const { Vec3 } = require('vec3');
  const origin = (point || bot.entity.position).floored();
  const reg = bot.registry;
  if (!reg || typeof bot.world?.getColumn !== 'function' || !bot.game) {
    const ids = names.map((n) => reg?.blocksByName?.[n]?.id).filter((x) => x != null);
    return ids.length ? bot.findBlocks({ matching: ids, maxDistance, count, point: origin }) : [];
  }
  const states = stateSet(reg, names);
  if (!states.size) return [];
  const minY = bot.game.minY ?? 0, nSec = (bot.game.height ?? 256) >> 4;
  const r = Math.ceil(maxDistance / 16);
  const cx0 = origin.x >> 4, cz0 = origin.z >> 4, cy0 = (origin.y - minY) >> 4;
  const secs = [];
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) {
    const sy = cy0 + dy;
    if (sy < 0 || sy >= nSec) continue;
    const near = Math.hypot(Math.max(0, Math.abs(dx) - 1), Math.max(0, Math.abs(dy) - 1), Math.max(0, Math.abs(dz) - 1)) * 16;
    if (near > maxDistance) continue;
    secs.push([cx0 + dx, sy, cz0 + dz, near]);
  }
  secs.sort((a, b) => a[3] - b[3]);
  const out = [];
  let full = 0;
  for (const [cx, sy, cz, near] of secs) {
    if (out.length >= count && near > out[count - 1].d) break;
    const col = bot.world.getColumn(cx, cz);
    const section = col?.sections?.[sy];
    if (!sectionMayHave(section, states)) continue;
    if (++full > maxFullScans) break;
    const d = section.data, bx = cx * 16, by = minY + sy * 16, bz = cz * 16;
    if (typeof d?.get !== 'function') throw new Error('unknown chunk section format');
    for (let i = 0; i < 4096; i++) {
      if (!states.has(d.get(i))) continue;
      const x = bx + (i & 15), y = by + (i >> 8), z = bz + ((i >> 4) & 15);
      const dist = Math.hypot(x - origin.x, y - origin.y, z - origin.z);
      if (dist <= maxDistance) out.push({ p: new Vec3(x, y, z), d: dist });
    }
    out.sort((a, b) => a.d - b.d);
  }
  return out.slice(0, count).map((o) => o.p);
}

class Part {
  constructor(c, switches) {
    this.c = c;
    this.switches = [].concat(switches);
    this.bot = null;
    this._subs = [];
    this._patches = [];
    this._timers = new Set();
  }
  on(id = this.switches[0]) { return this.c.f(id); }
  wanted() { return this.switches.some((id) => this.c.f(id)); }
  onFeatures() { this.sync(); }
  onSpawn() { this.sync(); }
  onLeave() { this.uninstall(); }
  sync() {
    const bot = this.c.bot;
    const want = !!(bot && bot.entity && this.c.state === 'online' && this.wanted());
    if (this.bot && (this.bot !== bot || !want)) this.uninstall();
    if (want && !this.bot) {
      this.bot = bot;
      try { this.setup(bot); } catch (err) { this.c.emit('log', `${this.constructor.name} setup: ${err.message}`); }
    }
  }
  uninstall() {
    if (!this.bot) return;
    for (const [em, ev, fn] of this._subs) { try { em.removeListener(ev, fn); } catch {} }
    for (const [obj, key] of this._patches) unpatch(obj, key, this);
    for (const t of this._timers) clearTimeout(t);
    this._subs = []; this._patches = []; this._timers.clear();
    try { this.teardown(); } catch {}
    this.bot = null;
  }
  setup() {}
  teardown() {}
  listen(em, ev, fn, prepend = false) {
    if (!em) return;
    const safe = (...a) => { try { fn(...a); } catch (err) { this.c.emit('log', `${this.constructor.name}.${ev}: ${err.message}`); } };
    if (prepend && em.prependListener) em.prependListener(ev, safe); else em.on(ev, safe);
    this._subs.push([em, ev, safe]);
  }
  patch(obj, key, fn) { if (patch(obj, key, this, fn)) this._patches.push([obj, key]); }
  later(ms, fn) {
    const t = setTimeout(() => { this._timers.delete(t); try { fn(); } catch (err) { this.c.emit('log', `${this.constructor.name} timer: ${err.message}`); } }, Math.max(0, ms));
    this._timers.add(t);
    return t;
  }

  live() { const b = this.bot; return !!(b && b === this.c.bot && b.entity && this.c.state === 'online' && !this.c.diedAt); }
  emitEvent(event, data, priority = null) { this.c.emitEvent(event, data, priority); }

  othersSteering() { const h = this.c.v12?.hands; return !!(h && (h.cmd?.walker?.w || h.games?.active)); }

  sparring() { const h = this.c.v12?.hands; return !!(this.c.sparring || h?.games?.active?.name === 'spar'); }
}

module.exports = {
  DEG, RAD, wrapDeg, yawPitchTo, dirOf, angleBetween, toNotchYaw, toNotchPitch, fromNotchYaw, fromNotchPitch, directionWords,
  rand, chance, pick, lru, Cooldowns, patch, unpatch, original, findBlocksFast,
  AIRISH, seeThrough, isLiquid, isSolid, isAir, itemKind, pretty, Part
};
