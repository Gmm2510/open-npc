// The AI side of the commands: the action names, the guide the AI reads, and the checks that clean an action's details
// (names checked against the game's data, numbers capped) before the body sees them.
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'crimson', 'warped'];
const STYLES = ['medieval', 'modern', 'rustic', 'plain'];

const ACTIONS = {
  commands: ['get_item', 'get_food', 'craft_item', 'make_armor', 'smelt_item', 'teach_recipe', 'mine_vein', 'dig_down', 'strip_mine', 'dig_tunnel',
    'place_block', 'water_bucket', 'harvest', 'shear', 'kill_that', 'leave_it', 'protect', 'fall_back', 'go_there', 'go_home', 'lead_back',
    'remember_place', 'recover_items', 'look_around', 'find', 'base_spot', 'sleep', 'give_item'],
  builder: ['build', 'quick_hut', 'dig_box', 'clear_area', 'fill_hole', 'cover_liquid', 'bridge', 'door', 'seal', 'farm', 'help_build', 'undo'],
  miniGames: ['race', 'timed_gather', 'spar'],
  initiative: ['own_thing', 'plan'],
  memory2: ['house_rule', 'forget_place'],
  freeBuild: ['build_shape'],
  toolHands: ['hold_item', 'put_away'],
  boats: ['ride_boat', 'leave_boat']
};
const SWITCH_OF = {};
for (const [sw, list] of Object.entries(ACTIONS)) for (const a of list) SWITCH_OF[a] = sw;
const HANDS_SWITCHES = ['commands', 'builder', 'miniGames', 'freeBuild'];

const OLD_JOBS = ['gather_wood', 'build_house', 'make_tools', 'mine_coal', 'mine_iron', 'mine_gold', 'mine_diamonds', 'smelt', 'hunt_food', 'light_up', 'explore', 'give_loot'];

function actions12(on) {
  const o = on || {};
  const out = [];
  for (const [sw, list] of Object.entries(ACTIONS)) if (o[sw]) out.push(...list);
  return out;
}

let mcDataCache;
function mcData() {
  if (mcDataCache !== undefined) return mcDataCache;
  mcDataCache = null;
  try {
    const md = require('minecraft-data');
    for (const v of ['26.1', '1.21.4', '1.20.4']) { const d = md(v); if (d && d.itemsByName) { mcDataCache = d; break; } }
  } catch {}
  return mcDataCache;
}

const CATEGORY = {
  wood: 'log', woods: 'log', log: 'log', logs: 'log', timber: 'log', tree: 'log', trees: 'log',
  plank: 'planks', planks: 'planks', wood_planks: 'planks', wooden_planks: 'planks',
  food: 'food', meat: 'food', something_to_eat: 'food', snacks: 'food', snack: 'food',
  bed: 'bed', beds: 'bed', wool: 'wool', pickaxe: 'pickaxe', pick: 'pickaxe', sword: 'sword', axe: 'axe', shovel: 'shovel', hoe: 'hoe',
  armor: 'armor', ore: 'ore', ores: 'ore'
};
const ITEM_ALIAS = {
  cobble: 'cobblestone', stone: 'cobblestone', rock: 'cobblestone', rocks: 'cobblestone', cobbles: 'cobblestone',
  diamonds: 'diamond', diamond_ore: 'diamond', iron: 'iron_ingot', ingot: 'iron_ingot', ingots: 'iron_ingot', iron_ingots: 'iron_ingot',
  iron_ore: 'raw_iron', gold: 'gold_ingot', gold_ore: 'raw_gold', coal_ore: 'coal', torches: 'torch', sticks: 'stick',
  steak: 'cooked_beef', pork: 'cooked_porkchop', porkchops: 'cooked_porkchop', water: 'water_bucket', bucket_of_water: 'water_bucket',
  seeds: 'wheat_seeds', seed: 'wheat_seeds', door: 'oak_door', table: 'crafting_table', workbench: 'crafting_table', crafting_bench: 'crafting_table',
  clay: 'clay_ball', glass_block: 'glass', string: 'string', boat: 'oak_boat', sign: 'oak_sign', fence: 'oak_fence', ladder: 'ladder'
};
const BLOCK_ALIAS = {
  cobble: 'cobblestone', stone: 'cobblestone', rock: 'cobblestone', wood: 'planks', planks: 'planks', plank: 'planks', wooden: 'planks',
  logs: 'log', log: 'log', bricks: 'bricks', brick: 'bricks', stone_brick: 'stone_bricks', glass: 'glass', dirt: 'dirt', mud: 'dirt', sand: 'sand'
};

const slug = (s) => String(s || '').toLowerCase().replace(/^minecraft:/, '').replace(/[^a-z0-9_ -]+/g, '').trim().replace(/[\s-]+/g, '_').slice(0, 40);
function known(name) { const d = mcData(); return !d || !!(d.itemsByName[name] || d.blocksByName[name]); }
const isBlock = (name) => { const d = mcData(); return !d || !!d.blocksByName[name]; };
function singular(s) {
  if (known(s)) return s;
  for (const cut of [/ies$/, /es$/, /s$/]) {
    const t = cut.source === 'ies$' ? s.replace(/ies$/, 'y') : s.replace(cut, '');
    if (t !== s && known(t)) return t;
  }
  return s;
}

function normItem(raw) {
  let s = slug(raw);
  if (!s) return null;
  s = s.replace(/^(a|an|some|the|more)_/, '');
  if (CATEGORY[s]) return CATEGORY[s];
  if (ITEM_ALIAS[s]) return ITEM_ALIAS[s];

  const w = WOODS.find((x) => s === x || s === `${x}_wood` || s === `${x}_logs` || s === `${x}_log` || s === `${x}_tree` || s === `${x}_trees`);
  if (w) return ['crimson', 'warped'].includes(w) ? `${w}_stem` : `${w}_log`;
  const wp = WOODS.find((x) => s === `${x}_planks` || s === `${x}_plank` || s === `${x}_wood_planks`);
  if (wp) return `${wp}_planks`;
  const one = singular(s);
  if (known(one)) return one;
  if (ITEM_ALIAS[one]) return ITEM_ALIAS[one];
  if (CATEGORY[one]) return CATEGORY[one];
  return null;
}

function normBlock(raw) {
  let s = slug(raw);
  if (!s) return null;
  s = s.replace(/^(a|an|some|the)_/, '');
  if (BLOCK_ALIAS[s]) return BLOCK_ALIAS[s];
  const w = WOODS.find((x) => s === x || s === `${x}_wood` || s === `${x}_planks` || s === `${x}_plank`);
  if (w) return ['crimson', 'warped'].includes(w) ? `${w}_planks` : `${w}_planks`;
  const wl = WOODS.find((x) => s === `${x}_log` || s === `${x}_logs`);
  if (wl) return `${wl}_log`;
  const one = singular(s);
  if (BLOCK_ALIAS[one]) return BLOCK_ALIAS[one];
  return isBlock(one) && known(one) ? one : null;
}

function normWood(raw) {
  const s = slug(raw).replace(/_(wood|log|logs|planks|tree|trees)$/, '');
  return WOODS.includes(s) ? s : null;
}

const LEVELS = { diamond: -58, diamonds: -58, diamond_level: -58, redstone: -58, bedrock: -60, deepslate: -8, gold: -16, iron: 16, lapis: 0, coal: 40, copper: 48, sea_level: 62 };

const SHAPES = { tower: 'tower', pillar: 'tower', column: 'tower', pole: 'tower', stack: 'tower', nerd_pole: 'tower', dirt_tower: 'tower',
  wall: 'wall', floor: 'floor', platform: 'floor', pad: 'floor', slab: 'floor', base: 'floor', cube: 'cube', box: 'cube', block: 'cube',
  ring: 'ring', pen: 'ring', fence: 'ring', enclosure: 'ring', walls: 'ring', stairs: 'stairs', staircase: 'stairs', steps: 'stairs', stair: 'stairs',
  path: 'path', line: 'path', road: 'path', row: 'path', pyramid: 'pyramid' };
const KINDS = new Set(['hut', 'house', 'dirt_hut', 'tower', 'wall', 'room', 'hole', 'village', 'cave', 'water', 'lava', 'trees', 'animals', 'sprint', 'logs', 'pond', 'floor']);
const DIRS = new Set(['north', 'south', 'east', 'west', 'up', 'down', 'forward', 'left', 'right', 'back']);
const WHERE = { here: 'here', there: 'there', me: 'here', at_me: 'here', my_feet: 'here', that: 'there', over_there: 'there', look: 'there' };

function intIn(v, lo, hi) {
  let n = v;
  if (typeof n === 'string') {
    const t = n.toLowerCase();
    const st = /(\d+(?:\.\d+)?)\s*stacks?/.exec(t);
    if (st) n = Number(st[1]) * 64;
    else if (/half a stack/.test(t)) n = 32;
    else if (/^(a )?stack$/.test(t.trim())) n = 64;
    else n = Number(t.replace(/[^0-9.-]/g, ''));
  }
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}

function parseSize(v, lo = 1, hi = 16) {
  if (v == null || v === '') return null;
  let w, l;
  if (Array.isArray(v)) { w = v[0]; l = v[1] ?? v[0]; }
  else if (typeof v === 'object') { w = v.w ?? v.width ?? v.x; l = v.l ?? v.length ?? v.z ?? w; }
  else {
    const m = /(\d+)\s*(?:x|by|\*|×)\s*(\d+)/i.exec(String(v));
    if (m) { w = m[1]; l = m[2]; } else { w = l = String(v).replace(/[^0-9]/g, ''); }
  }
  w = intIn(w, lo, hi); l = intIn(l, lo, hi);
  if (!w || !l) return null;
  return { w, l };
}

const str = (v, n) => String(v ?? '').replace(/[\u2013\u2014]/g, ' ').replace(/[^\w ',.!?-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const bool = (v) => v === true || v === 'true' || v === 'yes' || v === 1;

function sanitizeArgs(raw, action = '') {
  const a = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return a;
  const n = intIn(raw.n ?? raw.amount ?? raw.count ?? raw.number, 1, 640);
  if (n) a.n = n;
  const item = raw.item != null ? normItem(raw.item) : null;
  if (item) a.item = item;
  const block = raw.block != null ? normBlock(raw.block) : raw.material != null ? normBlock(raw.material) : null;
  if (block) a.block = block;
  const wood = raw.wood != null ? normWood(raw.wood) : null;
  if (wood) a.wood = wood;
  const sz = parseSize(raw.size ?? (raw.w != null ? { w: raw.w, l: raw.l ?? raw.w } : null));
  if (sz) { a.w = sz.w; a.l = sz.l; a.size = `${sz.w}x${sz.l}`; }
  for (const [k, lo, hi] of [['h', 1, 8], ['depth', 1, 16], ['len', 1, 64], ['mins', 1, 20], ['radius', 2, 24]]) {
    const v = intIn(raw[k] ?? (k === 'h' ? raw.height : k === 'len' ? raw.length : undefined), lo, hi);
    if (v) a[k] = v;
  }
  if (raw.y != null) {
    const key = slug(raw.y).replace(/_level$/, '');
    const y = LEVELS[key] ?? LEVELS[`${key}_level`] ?? intIn(raw.y, -60, 300);
    if (y != null) a.y = y;
  }
  const style = slug(raw.style);
  if (STYLES.includes(style)) a.style = style;
  const kind = require('../shared/nohut').kindBack(slug(raw.kind ?? raw.target));
  if (KINDS.has(kind)) a.kind = kind;
  else if (kind && /village/.test(kind)) a.kind = 'village';
  else if (kind && /cave/.test(kind)) a.kind = 'cave';
  const where = WHERE[slug(raw.where)];
  if (where) a.where = where;
  const dir = slug(raw.dir ?? raw.direction);
  if (DIRS.has(dir)) a.dir = dir;
  if (raw.name != null) { const v = str(raw.name, 24).toLowerCase(); if (v) a.name = v; }
  if (raw.note != null) { const v = str(raw.note, 80); if (v) a.note = v; }
  const who = slug(raw.who);
  if (['me', 'you', 'both'].includes(who)) a.who = who;
  if (Array.isArray(raw.steps)) {
    const steps = raw.steps.map((s) => slug(typeof s === 'string' ? s : s?.action)).filter((s) => OLD_JOBS.includes(s) || SWITCH_OF[s] === 'commands' || SWITCH_OF[s] === 'builder').slice(0, 3);
    if (steps.length) a.steps = steps;
  }
  if (raw.mob != null) { const v = slug(raw.mob); if (/^[a-z_]{3,24}$/.test(v)) a.mob = v; }
  for (const k of ['agreed', 'keep', 'resume', 'coined', 'sure']) if (bool(raw[k])) a[k] = true;

  if (action === 'build_shape') {
    const shape = SHAPES[slug(raw.shape ?? raw.kind ?? raw.type ?? raw.what)];
    if (shape) a.shape = shape;
    delete a.kind;
    const tall = (a.shape || 'tower') === 'tower';
    const hv = intIn(raw.h ?? raw.height ?? (tall ? raw.n ?? raw.blocks ?? raw.amount : undefined), 1, tall ? 24 : 8);
    if (hv) a.h = hv; else delete a.h;
    const lv = intIn(raw.len ?? raw.length ?? raw.steps ?? (a.shape === 'stairs' || a.shape === 'path' ? raw.n : undefined), 1, 32);
    if (lv) a.len = lv;
    if (a.w) { a.w = Math.min(a.w, 12); a.l = Math.min(a.l || a.w, 12); a.size = `${a.w}x${a.l}`; }
    if (bool(raw.hollow)) a.hollow = true;
    delete a.n;
  }
  if (action === 'give_item' && a.n) a.n = Math.min(a.n, 64);
  if (['craft_item', 'teach_recipe'].includes(action) && a.n) a.n = Math.min(a.n, action === 'teach_recipe' ? 1 : 64);
  if (/^mine_/.test(action) && a.n) a.n = Math.min(a.n, 64);
  return a;
}

const on = (sp) => (sp && sp.v12 && sp.v12.on) || {};
const anyHands = (sp) => HANDS_SWITCHES.some((k) => on(sp)[k]) || !!on(sp).initiative || !!on(sp).memory2 || !!on(sp).toolHands || !!on(sp).boats;

const HAND_RE = /\b(take out|pull out|get out|whip out|bust out|hold|holding|equip|switch to|put (?:it|that|them|your \w+(?: \w+)?) away|put away|unequip|empty hand|hands? (?:empty|free)|holster|sheathe|stop holding)\b/i;
const playerTalking = (sp) => { const k = sp && sp.trigger && sp.trigger.kind; return k === 'player' || k === 'typed'; };

const HOW_RE = /\bhow (?:do|can|would|to) (?:(?:i|you|we) )?(?:make|craft|build)\s+(?:a |an |some |the )?([a-z][a-z ]{1,30}?)(?:\?|$|\s+(?:again|in|for|with|out|from|please|bro|man|dude)\b)/i;
function recipeAsked(text) {
  const m = HOW_RE.exec(String(text || ''));
  if (!m) return null;
  const item = normItem(m[1]);
  return item && !CATEGORY[m[1].trim()] ? item : null;
}

function groupName(name) {
  if (/_planks$/.test(name)) return 'planks';
  if (/_(log|stem)$/.test(name) && !/^stripped_/.test(name)) return 'log';
  if (/_wool$/.test(name)) return 'wool';
  if (name === 'coal' || name === 'charcoal') return 'coal';
  return name;
}
const MASS = /(planks|wool|wheat|sand|cobblestone|glass|string|coal|dirt|gravel|clay|redstone|gunpowder|sugar|leather|paper|snow|stone|deepslate|blackstone|netherrack|bricks|log|iron|gold|copper)$/;
const say = (name, n) => {
  const base = name.replace(/_/g, ' ');
  if (n === 1 || MASS.test(base) || /s$/.test(base)) return `${n} ${base}`;
  return /(sh|ch|x)$/.test(base) ? `${n} ${base}es` : /[^aeiou]y$/.test(base) ? `${n} ${base.slice(0, -1)}ies` : `${n} ${base}s`;
};

const RARE = /deepslate|blackstone|bamboo|crimson|warped|mangrove|cherry|pale_oak|jungle|acacia|dark_oak|copper|gold|netherite/;
function pickVariant(list, d) {
  const ids = (r) => (r.inShape ? r.inShape.flat() : r.ingredients || []).filter((x) => x != null).map((x) => (typeof x === 'object' ? (x.id ?? x[0]) : x));
  const score = (r) => ids(r).reduce((s, id) => s + (d.items[id] && RARE.test(d.items[id].name) ? 1 : 0), 0);
  return list.slice().sort((a, b) => score(a) - score(b))[0];
}

function recipeText(item, d = mcData()) {
  if (!d || !item) return null;
  const it = d.itemsByName[item];
  const list = it && d.recipes && d.recipes[it.id];
  if (!list || !list.length) return null;
  const r = pickVariant(list, d);
  const nameOf = (id) => {
    if (id == null) return null;
    const x = typeof id === 'object' ? (id.id ?? id[0]) : id;
    return d.items[x] ? groupName(d.items[x].name) : null;
  };
  const counts = {};
  let rows = null;
  let needsTable = false;
  if (r.inShape) {
    rows = r.inShape.map((row) => row.map(nameOf));
    needsTable = rows.length > 2 || rows.some((row) => row.length > 2);
    for (const row of rows) for (const n of row) if (n) counts[n] = (counts[n] || 0) + 1;
  } else if (r.ingredients) {
    for (const x of r.ingredients) { const n = nameOf(x); if (n) counts[n] = (counts[n] || 0) + 1; }
    needsTable = r.ingredients.length > 4;
  } else return null;
  const parts = Object.entries(counts).map(([n, c]) => say(n, c));
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  let shape = '';
  if (rows) {
    const single = rows.every((row) => row.length === 1);
    if (single && rows.length > 1) shape = `, stacked: ${rows.map((row) => (row[0] || 'nothing').replace(/_/g, ' ')).join(' on top of ')}`;
    else if (rows.length > 1 || rows[0].length > 1) shape = `, laid out ${rows.map((row) => row.map((n) => (n || 'empty').replace(/_/g, ' ')).join(', ')).join(' / ')} (top row first)`;
  } else shape = ', in any order';
  const makes = (r.result && r.result.count) || 1;

  const only = Object.keys(counts);
  if (only.length === 1 && /_block$/.test(only[0]) && makes === 9) return null;
  const label = item.replace(/_/g, ' ');
  return { label, text: `${what}${shape}${needsTable ? ', on a crafting table' : ''}${makes > 1 ? `, makes ${makes}` : ''}`, counts, makes, needsTable, rows };
}

const recipes = { recipeText };

const TOPICS = {
  gather: /\b(get|grab|bring|collect|gather|chop|wood|logs?|planks|stack of|food|hungry|eat|starving|give|hand|toss|throw|drop|out of|low on)\b/i,
  craft: /\b(make|craft|tools?|pick ?axe|sword|axe|shovel|hoe|armou?r|helmet|chestplate|boots|leggings|recipe|how (?:do|can|would|to)|smelt|cook|furnace|torch(?:es)?)\b/i,
  mine: /\b(mine|mining|dig|tunnel|diamonds?|iron|coal|gold|ores?|strip|down|cave|deeper|vein)\b/i,
  place: /\b(put|place|set (?:down|up)|chest|crafting table|furnace|water|bucket|harvest|crops?|wheat|farm|sheep|shear|wool)\b/i,
  fight: /\b(kill|attack|fight|zombie|skeleton|creeper|spider|mobs?|leave (?:it|that)|protect|guard|help|run|back off|fall back|defend|cover me)\b/i,
  move: /\b(go|come|head|there|home|back|lead|take me|remember|where|find|village|look around|base|spot|sleep|bed|night|dark|explore)\b/i,
  build: /\b(build|make|stack|tower|pillar|pole|wall|floor|platform|house|hut|shelter|base|bridge|door|farm|fill|cover|lava|seal|stairs?|steps|box|cube|room|hole|clear|flatten|path|road|pyramid|ring|fence|pen|undo|take (?:it|that) (?:back|down))\b/i,
  games: /\b(race|game|play|spar|1v1|fight me|challenge|timed|bet you|first to)\b/i
};
const ASKS = /\b(can you|could you|will you|would you|you should|go|let'?s|we (?:should|need|gotta)|i need|need|want|get|make|build|stack|dig|mine|craft|bring|give|put|place|kill|chop|come|follow|help|grab|fetch|collect|gather|light|smelt|cook|find|clear|fill|cover|farm|harvest|shear|sleep|throw|toss|hand|race|spar|try|stop|undo|getting dark|it'?s dark|hungry|starving|out of|low on|show me|teach me|how do i)\b/i;
function topicsOf(text) {
  const t = String(text || '');
  const out = new Set();
  if (!ASKS.test(t)) return out;
  for (const [k, re] of Object.entries(TOPICS)) if (re.test(t)) out.add(k);
  return out;
}

function promptLines(sp) {
  const o = on(sp);
  if (!anyHands(sp) || !playerTalking(sp)) return null;
  const cmd = !!o.commands, bld = !!o.builder, games = !!o.miniGames, free = !!o.freeBuild;
  const lean = !!o.leanCommands;
  const said = String((sp.trigger && sp.trigger.text) || '');
  const topics = lean ? topicsOf(said) : null;

  const want = (...tags) => !lean || tags.includes('*') ? (!lean || topics.size > 0) : tags.some((t) => topics.has(t));
  const out = [];
  if ((cmd || bld || free) && want('*')) {
    out.push('COMMANDS (amounts, sizes, places)');
    out.push('- When the player asks for something, pick the action and put only the details they gave in "args", like "get me a stack of birch" = get_item {"item": "birch_log", "n": 64}. A stack is 64. No details: {}.');
    if (want('build', 'place', 'move', 'fight', 'mine')) out.push('- "here" means at their feet, "there" or "that" means where they are looking: "where": "here" or "there".');
  }
  if (cmd) {
    if (want('gather', 'craft', 'mine', 'move')) out.push('- Old jobs take args too: gather_wood {n, wood}, mine_coal, mine_iron, mine_gold, mine_diamonds {n}, make_tools {item}, give_loot {item, n}, smelt {item}, explore {kind}.');
    if (want('gather', 'craft')) out.push('- get_item {item, n}: gets that many (chops, mines, digs). get_food: quickest food. craft_item {item, n}. make_armor {item, who: "both"}. smelt_item {item} ("this" is what they just gave you). teach_recipe {item}: crafts one while you explain.');
    if (want('mine')) out.push('- mine_vein: mines out the ore they look at. dig_down {y}: digs down to a level (diamonds -58, iron 16). strip_mine: branch mines from their spot. dig_tunnel {len}: tunnels the way they face.');
    if (want('place', 'gather')) out.push('- place_block {item, where}: a chest, crafting table or furnace. water_bucket. harvest: ripe crops, then replants. shear: the sheep. give_item {item, n}.');
    if (want('fight')) out.push('- kill_that: the mob they look at. leave_it: stop hitting it. protect: guard them. fall_back: stop fighting and run to them.');
    if (want('move')) out.push('- go_there: where they look. go_home. lead_back {name}. remember_place {name, note}. recover_items: lead them back to where they died. look_around: climb up and name one or two things you see. find {kind: village or cave}. base_spot. sleep.');
  }
  if (bld && want('build', 'mine')) {
    out.push('- build {kind: hut or house, size "5x5", block, style: medieval, modern or rustic, where}. quick_hut: fast dirt hut. dig_box {size, depth, where} (a hole, or a room with h). clear_area {size}. fill_hole {block}. cover_liquid {kind: lava or water}. bridge {len}. door. seal: blocks off a cave. farm {size}. help_build: carries on what they are building. undo: takes back your last build.');
  }

  if (free && want('build')) {
    out.push('- build_shape {shape, h, size, len, block, where, hollow}: builds what they describe. shape: tower (a pillar or column: "stack dirt", "dirt tower", "pillar up"), wall (size = its length), floor (a platform), cube (hollow: true for a closed box), ring (walls all around, no roof), stairs (going up away from them, len steps), path (a line, len long), pyramid (size = its base). h = height. Dirt unless they name a block. "there" = where they look, else right in front of them. "A stack of dirt" is different: that\'s get_item 64 dirt.');
  }
  if (cmd && want('*')) {
    out.push(lean
      ? '- Hints that clearly match a job are requests: pick that job. "It\'s getting dark" = light_up (or quick_hut with no shelter near), "we need food" = get_food, "I\'m out of wood" = gather_wood, "need iron" = mine_iron. Plain commentary is not a request.'
      : '- Hints that clearly match a job are requests: say a quick "I got you" and pick it. "It\'s getting dark" = light_up (or quick_hut with no shelter near), "we need food" = get_food, "I\'m out of wood" = gather_wood, "need iron" = mine_iron. Plain commentary is not a request.');
    out.push('- Only when an action truly can\'t run without it (which way, which one), ask one short question with action "none". Otherwise take the obvious reading.');
  }
  if (games && want('games')) out.push('- Little games: race (to where they look), timed_gather {item, mins}, spar (first to 3 hearts, fists): only when they asked or said yes, with "agreed": true.');
  if (o.initiative && (!lean || (topics.size > 0 && /\b(own thing|your own|plan|first|then)\b/i.test(said)))) out.push('- own_thing {mins}: go do your own stuff for a while and check in. plan {steps: up to 3 jobs}: when they give you a 2 or 3 step plan.');

  if (o.boats && /\b(boats?|raft|row|sail|water|ocean|lake|river|sea|bo[nw]e?)\b/i.test(said)) out.push('- ride_boat: get in a boat by them: theirs if they sit in one (they steer), else you put your own boat on the water and get in (you make one first if you have none) and follow them by boat. leave_boat: get out (you take your own boat back). "Put your boat in the water" or "get in" = ride_boat. Never say you put a boat down, sat in one or got out unless you picked one of these.');
  if (o.toolHands && HAND_RE.test(said)) out.push('- hold_item {item}: take out what they say and keep holding it ("take out your pickaxe" = hold_item {"item": "pickaxe"}). put_away: put away whatever you hold (empty hand).');
  if (o.memory2 && (!lean || /\b(dig near|don'?t dig|never dig|rule|forget)\b/i.test(said))) out.push('- house_rule {name, radius}: a place you must never dig near ("don\'t dig near the house"). forget_place {name}.');

  const asked = cmd ? recipeAsked(sp.trigger && sp.trigger.text) : null;
  const r = asked && recipes.recipeText(asked, mcData());
  if (r) out.push(`- The real recipe for ${r.label}: ${r.text}. If they want to learn it, say it in one or two casual lines (no numbered steps) and use teach_recipe.`);
  if (out.length && !/^COMMANDS/.test(out[0])) out.unshift('COMMANDS (put only the details the player gave in "args")');
  return out.length ? [...out, ''] : null;
}

function outputFields(sp) {
  if (!anyHands(sp) || !playerTalking(sp)) return null;
  return [{ key: 'args', spec: '{<only details the player gave, or {}>}' }];
}

function parseExtra(obj, out, sp) {
  if (!anyHands(sp) || !obj || typeof obj !== 'object' || !out) return;
  if (obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)) out.args = sanitizeArgs(obj.args, out.action);
}

module.exports = { promptLines, outputFields, parseExtra, actions12, sanitizeArgs, topicsOf, SHAPES, normItem, normBlock, normWood, parseSize, recipeAsked, recipeText, groupName, ACTIONS, SWITCH_OF, OLD_JOBS, WOODS, STYLES, LEVELS, mcData };
