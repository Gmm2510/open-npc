// One block-plan builder for everything it builds or digs: places each block with a support check, walks into reach
// without breaking the build, and keeps an undo log.
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { Nope, PROTECTED_RE, LOG_RE, PLANKS_RE, AIRISH, REPLACEABLE, sleep } = require('./skills');

const MAX_CELLS = 1600;
const CAPS = { box: { w: 9, l: 9, depth: 6 }, room: { w: 9, l: 9, h: 5 }, clear: { w: 16, l: 16, above: 8 }, fill: 64, liquid: 24, hut: { w: 9, l: 9, h: 5 }, house: { w: 12, l: 12, h: 5 }, bridge: 40, seal: 40, farm: 9, help: 80 };
const DIRS6 = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
const SIDES = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

const DROP = { stone: 'cobblestone', grass_block: 'dirt', deepslate: 'cobbled_deepslate', coal_ore: 'coal', short_grass: null, tall_grass: null };

function matches(name, choice) {
  if (!name) return false;
  switch (choice) {
    case 'planks': return /_planks$/.test(name);
    case 'log': return LOG_RE.test(name);
    case 'fence': return /_fence$/.test(name);
    case 'door': return /_door$/.test(name) && !/trapdoor|iron_door/.test(name);
    case 'wool': return /_wool$/.test(name);
    case 'bed': return /_bed$/.test(name);
    case 'cheap': return /^(dirt|cobblestone|cobbled_deepslate|netherrack|coarse_dirt|andesite|diorite|granite|tuff|stone)$/.test(name);
    default: return name === choice;
  }
}
const matchesAny = (name, choices) => (choices || []).some((c) => matches(name, c));

function info(b) {
  if (!b) return { name: null, air: false, solid: false, liquid: false, loaded: false };
  const name = b.name;
  const liquid = /^(water|lava|flowing_water|flowing_lava|bubble_column)$/.test(name);
  const air = AIRISH.has(name);
  const solid = b.solid != null ? !!b.solid : (b.boundingBox === 'block' && !liquid);
  const plant = !air && !liquid && !solid && REPLACEABLE.test(name);
  let level = b.level;
  if (level == null && liquid && typeof b.getProperties === 'function') { try { level = Number(b.getProperties().level); } catch {} }
  return { name, air, solid, liquid, plant, loaded: true, level: level == null ? (b.metadata ?? 0) : level };
}

const key = (x, y, z) => `${x},${y},${z}`;

function placedOk(s, now, itemName, before) {
  if (!now) return false;
  const i = info(now);
  if (i.air || i.liquid) return false;
  if (before && now.name === before.name) return false;
  if (now.name === itemName) return true;
  if (/torch$/.test(itemName)) return /torch$/.test(now.name);
  if (/_door$/.test(itemName)) return now.name === itemName;
  if (/_bed$/.test(itemName)) return /_bed$/.test(now.name);
  if (/_sign$/.test(itemName)) return /_sign$/.test(now.name);
  if (itemName === 'wheat_seeds') return now.name === 'wheat';
  const blocks = s && s.data && s.data.blocksByName;
  return !(blocks && blocks[itemName]);
}

function toolFor(b) {
  if (!b) return null;
  const m = String(b.material || '');
  if (/pickaxe/.test(m)) return 'pickaxe';
  if (/axe/.test(m)) return 'axe';
  if (/shovel/.test(m)) return 'shovel';
  const n = b.name || '';
  if (/stone|cobble|ore$|brick|deepslate|andesite|diorite|granite|tuff|netherrack|obsidian|terracotta|concrete$|furnace|basalt|calcite/.test(n)) return 'pickaxe';
  if (/_log$|_planks$|_wood$|crafting_table|chest|_fence|_door$|bookshelf|_stem$/.test(n)) return 'axe';
  if (/dirt|grass_block|sand|gravel|clay|snow|soul_|mud|farmland|podzol|mycelium/.test(n)) return 'shovel';
  return null;
}
function boundsOf(cells) {
  const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (const c of cells) { b.x0 = Math.min(b.x0, c.x); b.y0 = Math.min(b.y0, c.y); b.z0 = Math.min(b.z0, c.z); b.x1 = Math.max(b.x1, c.x); b.y1 = Math.max(b.y1, c.y); b.z1 = Math.max(b.z1, c.z); }
  return b;
}
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

function facingSide(yaw) {
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : 'north';
}

function palette({ style = 'plain', block = null, wood = null } = {}) {
  const w = wood || (block && /_planks$|_log$/.test(block) ? block.replace(/_(planks|log)$/, '') : null);
  const planks = w ? [`${w}_planks`, 'planks'] : ['planks'];
  const logs = w ? [`${w}_log`, 'log', `${w}_planks`, 'planks'] : ['log', 'planks'];
  const given = block ? (block === 'planks' ? planks : block === 'log' ? logs : /_planks$/.test(block) ? planks : [block]) : null;
  switch (style) {
    case 'medieval': return { style, wall: given || ['cobblestone', 'stone_bricks', 'cobbled_deepslate'], corner: w ? logs : ['dark_oak_log', 'spruce_log', 'log', 'cobblestone'], roof: w ? planks : ['dark_oak_planks', 'spruce_planks', 'planks'], window: ['glass'], battlement: given || ['cobblestone', 'cobbled_deepslate'], windows: 'small', roofShape: 'battlements' };
    case 'modern': return { style, wall: given || ['stone', 'smooth_stone', 'cobblestone'], corner: null, roof: given || ['smooth_stone', 'stone', 'cobblestone'], window: ['glass'], windows: 'wide', roofShape: 'flat' };
    case 'rustic': return { style, wall: given || planks, corner: logs, roof: planks, beam: logs, window: ['glass'], windows: 'small', roofShape: 'beams' };
    default: return { style: 'plain', wall: given || ['planks', 'cobblestone', 'cobbled_deepslate', 'dirt'], corner: null, roof: given || ['planks', 'cobblestone', 'cobbled_deepslate', 'dirt'], window: null, windows: null, roofShape: 'flat' };
  }
}

function ring(x0, z0, w, l) {
  const x1 = x0 + w - 1, z1 = z0 + l - 1, out = [];
  if (w <= 0 || l <= 0) return out;
  if (w === 1 || l === 1) { for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push([x, z]); return out; }
  for (let x = x0; x <= x1; x++) out.push([x, z0]);
  for (let z = z0 + 1; z <= z1; z++) out.push([x1, z]);
  for (let x = x1 - 1; x >= x0; x--) out.push([x, z1]);
  for (let z = z1 - 1; z >= z0 + 1; z--) out.push([x0, z]);
  return out;
}

function hutPlan({ x0, y0, z0, w = 5, l = 5, h = 3, door = 'south', pal = palette(), furniture = false, label = 'hut' }) {
  w = clampInt(w, 3, CAPS.house.w, 5); l = clampInt(l, 3, CAPS.house.l, 5); h = clampInt(h, 2, CAPS.house.h, 3);
  const x1 = x0 + w - 1, z1 = z0 + l - 1;
  const mx = x0 + Math.floor((w - 1) / 2), mz = z0 + Math.floor((l - 1) / 2);
  const dpos = door === 'north' ? [mx, z0] : door === 'east' ? [x1, mz] : door === 'west' ? [x0, mz] : [mx, z1];
  const isDoor = (x, z) => x === dpos[0] && z === dpos[1];
  const isCorner = (x, z) => (x === x0 || x === x1) && (z === z0 || z === z1);
  const nearCorner = (x, z) => (x <= x0 + 1 || x >= x1 - 1) && (z <= z0 + 1 || z >= z1 - 1);
  const nearDoor = (x, z) => Math.abs(x - dpos[0]) + Math.abs(z - dpos[1]) <= 1;
  const per = ring(x0, z0, w, l);
  const isWindow = (x, z, dy, i) => {
    if (!pal.windows || isCorner(x, z) || nearDoor(x, z)) return false;
    if (pal.windows === 'wide') return dy >= 1 && dy <= Math.min(2, h - 2) && !nearCorner(x, z);
    return dy === 1 && h >= 3 && i % 3 === 2 && !nearCorner(x, z);
  };
  const cells = [];
  for (let dy = 0; dy < h; dy++) {
    const layer = per.map((c, i) => ({ c, i })).filter(({ c }) => dy >= 2 || !isDoor(c[0], c[1]));
    if (dy >= 2) layer.sort((a, b) => (isDoor(a.c[0], a.c[1]) ? 1 : 0) - (isDoor(b.c[0], b.c[1]) ? 1 : 0));
    for (const { c: [x, z], i } of layer) {
      const corner = isCorner(x, z) && pal.corner;
      const win = !corner && isWindow(x, z, dy, i);
      cells.push({ x, y: y0 + dy, z, block: corner ? pal.corner : win ? [...pal.window, ...pal.wall] : pal.wall, part: corner ? 'corner' : win ? 'window' : 'wall' });
    }
  }

  for (let k = 0; ; k++) {
    const rw = w - 2 * k, rl = l - 2 * k;
    if (rw <= 0 || rl <= 0) break;
    const edge = k === 0 && pal.beam;
    for (const [x, z] of ring(x0 + k, z0 + k, rw, rl)) cells.push({ x, y: y0 + h, z, block: edge ? pal.beam : pal.roof, part: 'roof' });
  }
  if (pal.roofShape === 'battlements') {
    per.forEach(([x, z], i) => { if (i % 2 === 0) cells.push({ x, y: y0 + h + 1, z, block: pal.battlement, part: 'battlement', optional: true }); });
  }
  cells.push({ x: dpos[0], y: y0, z: dpos[1], block: ['door'], op: 'door', part: 'door', optional: true });
  const inX0 = x0 + 1, inZ0 = z0 + 1, inX1 = x1 - 1, inZ1 = z1 - 1;
  const away = { south: [0, -1], north: [0, 1], east: [-1, 0], west: [1, 0] }[door] || [0, -1];
  if (furniture && w >= 5 && l >= 5) {

    const bx = away[0] > 0 ? inX1 : away[0] < 0 ? inX0 : null, bz = away[1] > 0 ? inZ1 : away[1] < 0 ? inZ0 : null;
    const slots = [];
    if (bz != null) for (let x = inX0 + 1; x <= inX1 - 1 && slots.length < 3; x++) slots.push([x, bz]);
    else for (let z = inZ0 + 1; z <= inZ1 - 1 && slots.length < 3; z++) slots.push([bx, z]);
    ['crafting_table', 'chest', 'furnace'].forEach((it, i) => { if (slots[i]) cells.push({ x: slots[i][0], y: y0, z: slots[i][1], block: [it], op: 'furniture', part: 'furniture', optional: true }); });
    const bedAt = bz != null ? [inX0, bz] : [bx, inZ0];
    cells.push({ x: bedAt[0], y: y0, z: bedAt[1], block: ['bed'], op: 'bed', part: 'furniture', optional: true });
    for (const [x, z] of [[inX0, inZ0], [inX1, inZ1], [inX0, inZ1], [inX1, inZ0]].filter(([x, z]) => !slots.some((s) => s[0] === x && s[1] === z) && !(x === bedAt[0] && z === bedAt[1])).slice(0, 2)) {
      cells.push({ x, y: y0, z, block: ['torch'], op: 'torch', part: 'torch', optional: true });
    }
  } else if (w >= 3 && l >= 3) {
    cells.push({ x: inX0, y: y0, z: inZ0, block: ['torch'], op: 'torch', part: 'torch', optional: true });
  }
  const out = { dx: door === 'east' ? 1 : door === 'west' ? -1 : 0, dz: door === 'south' ? 1 : door === 'north' ? -1 : 0 };
  return {
    kind: 'hut', label, cells, anchor: { x: x0, y: y0, z: z0 }, size: { w, l, h },
    bounds: { x0, y0, z0, x1, y1: y0 + h + 1, z1 },
    door: { x: dpos[0], y: y0, z: dpos[1] }, inside: { x: mx === dpos[0] && mz === dpos[1] ? mx - out.dx : mx, y: y0, z: mz }, outside: { x: dpos[0] + out.dx * 2, y: y0, z: dpos[1] + out.dz * 2 }
  };
}

function quickHutPlan({ x0, y0, z0, door = 'south', block = null }) {
  const pal = { wall: block ? [block, 'cheap'] : ['dirt', 'cheap', 'planks'], roof: block ? [block, 'cheap'] : ['dirt', 'cheap', 'planks'], corner: null, window: null, windows: null, roofShape: 'flat' };
  const p = hutPlan({ x0, y0, z0, w: 4, l: 4, h: 2, door, pal, label: 'dirt hut' });
  p.cells = p.cells.filter((c) => c.op !== 'torch');
  p.kind = 'quick_hut';
  return p;
}

function digBoxPlan({ x0, yTop, z0, w = 1, l = 1, depth = 1, label = 'hole' }) {
  w = clampInt(w, 1, CAPS.box.w, 1); l = clampInt(l, 1, CAPS.box.l, 1); depth = clampInt(depth, 1, CAPS.box.depth, 1);
  const cells = [];
  for (let d = 0; d < depth; d++) {
    const y = yTop - d;
    for (let i = 0; i < w; i++) {
      const x = x0 + i;
      const zs = []; for (let j = 0; j < l; j++) zs.push(z0 + j);
      if (i % 2) zs.reverse();
      for (const z of zs) cells.push({ x, y, z, block: null, part: 'dig' });
    }
  }
  return { kind: 'dig', label, cells, anchor: { x: x0, y: yTop, z: z0 }, size: { w, l, h: depth }, bounds: { x0, y0: yTop - depth + 1, z0, x1: x0 + w - 1, y1: yTop, z1: z0 + l - 1 } };
}

function roomPlan({ hit, face, w = 5, l = 5, h = 3, floorY = null }) {
  w = clampInt(w, 1, CAPS.room.w, 5); l = clampInt(l, 1, CAPS.room.l, 5); h = clampInt(h, 2, CAPS.room.h, 3);
  if (!face || face.y) {
    return digBoxPlan({ x0: hit.x - Math.floor((w - 1) / 2), yTop: hit.y, z0: hit.z - Math.floor((l - 1) / 2), w, l, depth: h, label: 'room' });
  }
  const nx = -Math.sign(face.x), nz = -Math.sign(face.z);
  const px = nz ? 1 : 0, pz = nx ? 1 : 0;
  const fy = floorY != null && Math.abs(floorY - hit.y) <= 2 ? floorY : hit.y;
  const cells = [];
  const half = Math.floor((w - 1) / 2);
  for (let d = 0; d < l; d++) {
    for (let dy = h - 1; dy >= 0; dy--) {
      for (let a = -half; a < w - half; a++) {
        cells.push({ x: hit.x + nx * d + px * a, y: fy + dy, z: hit.z + nz * d + pz * a, block: null, part: 'dig' });
      }
    }
  }
  const b = boundsOf(cells);
  return { kind: 'dig', label: 'room', cells, anchor: { x: hit.x, y: fy, z: hit.z }, size: { w, l, h }, bounds: b, into: { x: nx, z: nz } };
}

function clearPlan({ cx, y0, cz, w = 10, l = 10, above = 8, getBlock }) {
  w = clampInt(w, 1, CAPS.clear.w, 10); l = clampInt(l, 1, CAPS.clear.l, 10); above = clampInt(above, 1, CAPS.clear.above, 8);
  const x0 = cx - Math.floor((w - 1) / 2), z0 = cz - Math.floor((l - 1) / 2);
  const digs = [], fills = [];
  let skipped = 0;
  for (let y = y0 + above - 1 + 12; y >= y0; y--) {
    for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + l; z++) {
      const b = info(getBlock(x, y, z));
      if (!b.loaded || b.air || b.liquid) continue;
      if (y >= y0 + above && !/_(log|leaves|stem)$|^(short_grass|tall_grass|vine)$/.test(b.name)) continue;
      if (PROTECTED_RE.test(b.name)) { skipped++; continue; }
      digs.push({ x, y, z, block: null, part: 'clear' });
    }
  }
  for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + l; z++) {
    for (const y of [y0 - 2, y0 - 1]) {
      const b = info(getBlock(x, y, z));
      if (!b.loaded) continue;
      if (b.air || b.liquid || b.plant) fills.push({ x, y, z, block: ['dirt', 'cheap'], part: 'fill' });
    }
  }

  const fillSet = new Set(fills.map((c) => key(c.x, c.y, c.z)));
  const fillsOk = fills.filter((c) => c.y === y0 - 1 || fillSet.has(key(c.x, c.y + 1, c.z)));
  const cells = [...digs, ...fillsOk];
  return { kind: 'clear', label: 'clearing', cells, anchor: { x: x0, y: y0, z: z0 }, size: { w, l, h: above }, bounds: { x0, y0: y0 - 2, z0, x1: x0 + w - 1, y1: y0 + above + 12, z1: z0 + l - 1 }, skipped };
}

function fillHolePlan({ start, maxY, getBlock, block = null, cap = CAPS.fill }) {
  const seen = new Set();
  const out = [];
  const q = [start];
  seen.add(key(start.x, start.y, start.z));
  while (q.length) {
    const c = q.shift();
    const b = info(getBlock(c.x, c.y, c.z));
    if (!b.loaded || !(b.air || b.plant || (b.liquid && b.level !== 0))) continue;
    if (c.y > maxY) continue;
    out.push(c);
    if (out.length > cap) return { kind: 'fill', tooBig: true, count: out.length, cells: [] };
    for (const [dx, dy, dz] of DIRS6) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      const k = key(n.x, n.y, n.z);
      if (seen.has(k) || n.y > maxY) continue;
      seen.add(k);
      q.push(n);
    }
  }
  out.sort((a, b) => a.y - b.y || (Math.abs(a.x - start.x) + Math.abs(a.z - start.z)) - (Math.abs(b.x - start.x) + Math.abs(b.z - start.z)));
  const choices = block ? [block, 'dirt', 'cheap'] : ['dirt', 'cheap'];
  const cells = out.map((c) => ({ x: c.x, y: c.y, z: c.z, block: choices, part: 'fill' }));
  return { kind: 'fill', label: 'filling the hole', cells, count: cells.length, anchor: start, bounds: cells.length ? boundsOf(cells) : null };
}

function liquidPlan({ target, kind = 'lava', getBlock, r = 5, cap = CAPS.liquid }) {
  const want = kind === 'water' ? 'water' : 'lava';
  const found = [];
  for (let x = target.x - r; x <= target.x + r; x++) for (let y = target.y - 3; y <= target.y + 2; y++) for (let z = target.z - r; z <= target.z + r; z++) {
    const b = info(getBlock(x, y, z));
    if (b.name === want && (b.level === 0 || b.level == null)) found.push({ x, y, z });
  }
  found.sort((a, b) => (Math.abs(a.x - target.x) + Math.abs(a.y - target.y) + Math.abs(a.z - target.z)) - (Math.abs(b.x - target.x) + Math.abs(b.y - target.y) + Math.abs(b.z - target.z)));
  if (want === 'water' && found.length > cap) return { kind: 'drain', tooBig: true, count: found.length, cells: [] };
  const use = found.slice(0, cap);

  use.sort((a, b) => (want === 'lava' ? b.y - a.y : a.y - b.y));
  const cells = use.map((c) => ({ ...c, block: ['cobblestone', 'cheap', 'dirt'], part: 'cover', liquidOk: true }));
  if (want === 'water') for (const c of use.slice().sort((a, b) => b.y - a.y)) cells.push({ ...c, block: null, part: 'drain', after: true });
  return { kind: want === 'water' ? 'drain' : 'cover', label: want === 'water' ? 'draining the water' : 'covering the lava', cells, count: use.length, more: Math.max(0, found.length - use.length), anchor: target, bounds: cells.length ? boundsOf(cells) : null };
}

function bridgePlan({ start, side, getBlock, cap = CAPS.bridge, block = null }) {
  const [dx, dz] = SIDES[side] || SIDES.north;
  const px = dz ? 1 : 0, pz = dx ? 1 : 0;
  const deckY = start.y - 1;
  const solidAt = (i) => info(getBlock(start.x + dx * i, deckY, start.z + dz * i)).solid;
  let gap = -1;
  for (let i = 1; i <= 6; i++) if (!solidAt(i)) { gap = i; break; }
  if (gap < 0) return { kind: 'bridge', noGap: true, cells: [] };
  let end = -1;
  for (let i = gap + 1; i <= gap + cap; i++) if (solidAt(i) && solidAt(i + 1)) { end = i; break; }
  const last = end < 0 ? gap + cap - 1 : end - 1;
  const deck = block ? [block, 'planks', 'cheap'] : ['planks', 'cobblestone', 'cheap'];
  const rail = ['fence', ...deck];
  const cells = [];
  for (let i = gap; i <= last; i++) {
    const x = start.x + dx * i, z = start.z + dz * i;
    for (const a of [0, -1, 1]) cells.push({ x: x + px * a, y: deckY, z: z + pz * a, block: deck, part: 'deck', liquidOk: true });
    for (const a of [-1, 1]) cells.push({ x: x + px * a, y: deckY + 1, z: z + pz * a, block: rail, part: 'rail', liquidOk: true });
  }
  return { kind: 'bridge', label: 'building a bridge', cells, length: last - gap + 1, reachesLand: end >= 0, anchor: { x: start.x + dx * gap, y: deckY, z: start.z + dz * gap }, bounds: boundsOf(cells), side };
}

function doorPlan({ hit, face, footY, getBlock }) {
  if (!face || face.y) return { kind: 'door', notWall: true, cells: [] };
  const solid = (x, y, z) => info(getBlock(x, y, z)).solid;
  let bottom = hit.y;
  if (footY != null && Math.abs(footY - hit.y) <= 1 && solid(hit.x, footY, hit.z)) bottom = footY;
  else if (solid(hit.x, hit.y - 1, hit.z) && solid(hit.x, hit.y - 2, hit.z)) bottom = hit.y - 1;
  const cells = [];
  if (!solid(hit.x, bottom - 1, hit.z)) cells.push({ x: hit.x, y: bottom - 1, z: hit.z, block: ['cheap', 'planks', 'dirt'], part: 'floor' });
  cells.push({ x: hit.x, y: bottom + 1, z: hit.z, block: null, part: 'gap' });
  cells.push({ x: hit.x, y: bottom, z: hit.z, block: null, part: 'gap' });
  cells.push({ x: hit.x, y: bottom, z: hit.z, block: ['door'], op: 'door', part: 'door' });
  return { kind: 'door', label: 'putting in a door', cells, anchor: { x: hit.x, y: bottom, z: hit.z }, bounds: boundsOf(cells) };
}

function sealPlan({ start, getBlock, view = null, radius = 5, cap = CAPS.seal, block = null }) {
  const b0 = info(getBlock(start.x, start.y, start.z));
  if (!b0.loaded || !(b0.air || b0.plant)) return { kind: 'seal', cells: [], notAir: true };
  const sky = new Map();
  const open = (x, y, z) => {
    const k = key(x, y, z);
    if (sky.has(k)) return sky.get(k);
    let res = true;
    for (let dy = 1; dy <= 24; dy++) { const i = info(getBlock(x, y + dy, z)); if (!i.loaded) break; if (i.solid || i.liquid) { res = false; break; } }
    sky.set(k, res);
    return res;
  };
  const passable = (x, y, z) => { const i = info(getBlock(x, y, z)); return i.loaded && (i.air || i.plant); };
  const seen = new Set([key(start.x, start.y, start.z)]);
  const q = [start], region = [];
  while (q.length && region.length < 500) {
    const c = q.shift();
    region.push(c);
    for (const [dx, dy, dz] of DIRS6) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      const k = key(n.x, n.y, n.z);
      if (seen.has(k) || Math.abs(n.x - start.x) > radius || Math.abs(n.y - start.y) > radius || Math.abs(n.z - start.z) > radius) continue;
      seen.add(k);
      if (passable(n.x, n.y, n.z)) q.push(n);
    }
  }
  const inside = region.filter((c) => !open(c.x, c.y, c.z));
  let cells = inside.filter((c) => DIRS6.some(([dx, dy, dz]) => {
    const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
    return seen.has(key(n.x, n.y, n.z)) && passable(n.x, n.y, n.z) && open(n.x, n.y, n.z);
  }));
  let mode = 'opening';
  if (!cells.length) {

    mode = 'across';
    const alongX = view ? Math.abs(view.x) >= Math.abs(view.z) : true;
    cells = region.filter((c) => (alongX ? c.x === start.x : c.z === start.z) && Math.abs(c.y - start.y) <= 2 && Math.abs((alongX ? c.z - start.z : c.x - start.x)) <= 2);
  }
  if (cells.length > cap) return { kind: 'seal', tooBig: true, count: cells.length, cells: [] };
  cells.sort((a, b) => a.y - b.y);
  const choices = block ? [block, 'cheap'] : ['cobblestone', 'cheap', 'dirt', 'planks'];
  const out = cells.map((c) => ({ x: c.x, y: c.y, z: c.z, block: choices, part: 'seal' }));
  return { kind: 'seal', label: 'sealing it off', mode, cells: out, count: out.length, anchor: start, bounds: out.length ? boundsOf(out) : null };
}

function farmPlan({ cx, y0, cz, size = 9, gate = 'south' }) {
  size = clampInt(size, 3, CAPS.farm, 9);
  if (size % 2 === 0) size -= 1;
  const half = (size - 1) / 2;
  const g = y0 - 1;
  const cells = [{ x: cx, y: g, z: cz, block: ['water_bucket'], op: 'water', part: 'water' }];
  const soil = [];
  for (let i = -half; i <= half; i++) {
    const zs = []; for (let j = -half; j <= half; j++) zs.push(j);
    if ((i + half) % 2) zs.reverse();
    for (const j of zs) if (i || j) soil.push([cx + i, cz + j]);
  }
  for (const [x, z] of soil) cells.push({ x, y: g, z, block: null, op: 'till', part: 'till' });
  for (const [x, z] of soil) cells.push({ x, y: y0, z, block: ['wheat_seeds'], op: 'plant', part: 'plant', optional: true });
  const fence = ring(cx - half - 1, cz - half - 1, size + 2, size + 2);
  const [gx, gz] = SIDES[gate] || SIDES.south;
  const gateAt = [cx + gx * (half + 1), cz + gz * (half + 1)];
  for (const [x, z] of fence) if (!(x === gateAt[0] && z === gateAt[1])) cells.push({ x, y: y0, z, block: ['fence'], part: 'fence', optional: true });
  return { kind: 'farm', label: 'making a wheat farm', cells, size, anchor: { x: cx, y: g, z: cz }, bounds: { x0: cx - half - 1, y0: g, z0: cz - half - 1, x1: cx + half + 1, y1: y0, z1: cz + half + 1 } };
}

function helpPlan({ recent, getBlock, cap = CAPS.help }) {
  const list = (recent || []).slice(-80);
  if (list.length < 3) return null;
  const counts = {};
  for (const r of list) counts[r.name] = (counts[r.name] || 0) + 1;
  const name = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const mine = list.filter((r) => r.name === name);
  if (mine.length < 3) return null;
  const solid = (x, y, z) => info(getBlock(x, y, z)).solid;
  const isMine = (x, y, z) => { const b = getBlock(x, y, z); return !!b && b.name === name; };

  const cols = new Map();
  for (const r of mine) {
    const k = `${r.x},${r.z}`;
    const c = cols.get(k) || { x: r.x, z: r.z, top: -Infinity, base: Infinity };
    c.top = Math.max(c.top, r.y); c.base = Math.min(c.base, r.y);
    cols.set(k, c);
  }
  for (const c of cols.values()) {
    while (isMine(c.x, c.top + 1, c.z)) c.top++;
    while (isMine(c.x, c.base - 1, c.z)) c.base--;
  }
  const C = [...cols.values()];
  const block = [name];
  const ys = new Set(mine.map((r) => r.y));
  const xs = new Set(C.map((c) => c.x)), zs = new Set(C.map((c) => c.z));
  const top = Math.max(...C.map((c) => c.top));
  const base = Math.min(...C.map((c) => c.base));

  if (ys.size === 1 && C.length >= 8) {
    const y = [...ys][0];
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const onEdge = (x, z) => x === x0 || x === x1 || z === z0 || z === z1;
    const outline = ring(x0, z0, x1 - x0 + 1, z1 - z0 + 1);
    const closed = x1 - x0 >= 2 && z1 - z0 >= 2 && outline.every(([x, z]) => isMine(x, y, z)) && C.every((c) => onEdge(c.x, c.z));
    if (closed) {
      const cells = [];
      for (let k = 1; ; k++) {
        const r = ring(x0 + k, z0 + k, x1 - x0 + 1 - 2 * k, z1 - z0 + 1 - 2 * k);
        if (!r.length) break;
        for (const [x, z] of r) if (!solid(x, y, z)) cells.push({ x, y, z, block, part: 'floor' });
      }
      if (cells.length && cells.length <= cap) return { kind: 'floor', cells, say: 'fill in the floor', block: name };
    }
  }

  const uneven = C.some((c) => c.top < top);
  const joined = (() => {
    const seen = new Set([0]);
    const q = [0];
    while (q.length) {
      const a = C[q.shift()];
      C.forEach((b, j) => {
        if (seen.has(j)) return;
        const dx = Math.abs(a.x - b.x), dz = Math.abs(a.z - b.z);
        if ((dx === 0 && dz <= 2) || (dz === 0 && dx <= 2)) { seen.add(j); q.push(j); }
      });
    }
    return seen.size === C.length;
  })();
  const sameGround = C.every((c) => c.base - base <= 1);
  if (C.length >= 3 && top - base >= 1 && uneven && joined && sameGround) {
    const cells = [];
    for (const c of C) for (let y = c.top + 1; y <= top; y++) if (!solid(c.x, y, c.z)) cells.push({ x: c.x, y, z: c.z, block, part: 'wall' });
    cells.sort((a, b) => a.y - b.y);
    if (cells.length && cells.length <= cap) return { kind: 'raise', cells, say: `bring the walls up to ${top - base + 1} high`, block: name };
  }

  const straightX = zs.size === 1 && xs.size >= 3, straightZ = xs.size === 1 && zs.size >= 3;
  if (straightX || straightZ) {
    const sorted = C.slice().sort((a, b) => (straightX ? a.x - b.x : a.z - b.z));
    const newest = mine[mine.length - 1];
    const first = sorted[0], lastC = sorted[sorted.length - 1];
    const towardEnd = straightX ? Math.abs(newest.x - lastC.x) <= Math.abs(newest.x - first.x) : Math.abs(newest.z - lastC.z) <= Math.abs(newest.z - first.z);
    const from = towardEnd ? lastC : first;
    const step = towardEnd ? 1 : -1;
    const height = top - base + 1;
    const cells = [];
    let n = 0;
    for (let i = 1; i <= 6; i++) {
      const x = straightX ? from.x + step * i : from.x, z = straightX ? from.z : from.z + step * i;
      if (solid(x, base, z) && solid(x, base + 1, z)) break;
      if (!solid(x, base - 1, z)) break;
      for (let y = base; y <= top; y++) if (!solid(x, y, z)) cells.push({ x, y, z, block, part: 'wall' });
      n++;
    }
    cells.sort((a, b) => (straightX ? Math.abs(a.x - from.x) - Math.abs(b.x - from.x) : Math.abs(a.z - from.z) - Math.abs(b.z - from.z)) || a.y - b.y);
    const dirWord = straightX ? (step > 0 ? 'east' : 'west') : (step > 0 ? 'south' : 'north');
    if (cells.length && cells.length <= cap) return { kind: 'extend', cells, say: `carry the wall on ${n} more to the ${dirWord}, ${height} high`, block: name };
  }
  return null;
}

const SHAPE_CAPS = { wall: { len: 16, h: 5 }, floor: { w: 12 }, cube: { w: 5, h: 5 }, ring: { w: 12, h: 4 }, stairs: { len: 16, w: 3 }, path: { len: 32, w: 3 }, pyramid: { w: 9 } };
function shapePlan({ shape, center, side = 'north', w = null, l = null, h = null, len = null, hollow = false, block = null }) {
  const choices = block ? [block] : ['dirt', 'cheap'];
  const num = (v, lo, hi, d) => (v == null || v === '' ? d : clampInt(v, lo, hi, d));
  const f = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[side] || [0, -1];
  const r = [-f[1], f[0]];
  const at = (fw, rt, y) => ({ x: center.x + f[0] * fw + r[0] * rt, y: center.y + y, z: center.z + f[1] * fw + r[1] * rt, block: choices });
  const cells = [];
  const span = (n) => { const lo = -Math.floor((n - 1) / 2); return Array.from({ length: n }, (_, i) => lo + i); };
  let label;
  switch (shape) {
    case 'wall': {
      const L = num(len ?? w, 1, SHAPE_CAPS.wall.len, 5), H = num(h, 1, SHAPE_CAPS.wall.h, 3);
      for (let y = 0; y < H; y++) for (const rt of span(L)) cells.push(at(0, rt, y));
      label = `wall, ${L} long and ${H} high`;
      break;
    }
    case 'floor': {
      const W = num(w, 1, SHAPE_CAPS.floor.w, 5), Lf = num(l ?? w, 1, SHAPE_CAPS.floor.w, W);
      for (const fw of span(Lf)) for (const rt of span(W)) cells.push(at(fw, rt, 0));
      label = `floor, ${W} by ${Lf}`;
      break;
    }
    case 'cube': {
      const W = num(w, 1, SHAPE_CAPS.cube.w, 3), Lc = num(l ?? w, 1, SHAPE_CAPS.cube.w, W), H = num(h ?? w, 1, SHAPE_CAPS.cube.h, W);
      const fws = span(Lc), rts = span(W);
      for (let y = 0; y < H; y++) for (const fw of fws) for (const rt of rts) {
        const edge = y === 0 || y === H - 1 || fw === fws[0] || fw === fws[fws.length - 1] || rt === rts[0] || rt === rts[rts.length - 1];
        if (!hollow || edge) cells.push(at(fw, rt, y));
      }
      label = `${hollow ? 'hollow cube' : 'cube'}, ${W} by ${Lc} by ${H}`;
      break;
    }
    case 'ring': {
      const W = num(w, 3, SHAPE_CAPS.ring.w, 5), Lr = num(l ?? w, 3, SHAPE_CAPS.ring.w, W), H = num(h, 1, SHAPE_CAPS.ring.h, 2);
      const fws = span(Lr), rts = span(W);
      for (let y = 0; y < H; y++) for (const fw of fws) for (const rt of rts) {
        if (fw === fws[0] || fw === fws[fws.length - 1] || rt === rts[0] || rt === rts[rts.length - 1]) cells.push(at(fw, rt, y));
      }
      label = `ring of walls, ${W} by ${Lr}`;
      break;
    }
    case 'stairs': {
      const N = num(len ?? h, 2, SHAPE_CAPS.stairs.len, 5), W = num(w, 1, SHAPE_CAPS.stairs.w, 1);

      for (let k = 0; k < N; k++) for (const rt of span(W)) { if (k > 0) cells.push(at(k, rt, k - 1)); cells.push(at(k, rt, k)); }
      label = `staircase, ${N} steps`;
      break;
    }
    case 'path': {
      const N = num(len ?? l, 1, SHAPE_CAPS.path.len, 8), W = num(w, 1, SHAPE_CAPS.path.w, 1);
      for (let k = 0; k < N; k++) for (const rt of span(W)) cells.push(at(k, rt, 0));
      label = `path, ${N} long`;
      break;
    }
    case 'pyramid': {
      let B = num(w, 3, SHAPE_CAPS.pyramid.w, 5);
      if (B % 2 === 0) B -= 1;
      for (let y = 0; B - 2 * y >= 1; y++) for (const fw of span(B - 2 * y)) for (const rt of span(B - 2 * y)) cells.push(at(fw, rt, y));
      label = `pyramid, ${B} wide at the base`;
      break;
    }
    default: return null;
  }
  return { kind: 'shape', shape, cells, label, anchor: { x: center.x, y: center.y, z: center.z } };
}

class GoalReach extends goals.Goal {
  constructor(p, r = 4.0) { super(); this.p = p; this.r = r; }
  heuristic(n) { const dx = n.x - this.p.x, dy = n.y - this.p.y, dz = n.z - this.p.z; return Math.sqrt(dx * dx + dz * dz) + Math.abs(dy); }
  isEnd(n) {
    if (n.x === this.p.x && n.z === this.p.z && (n.y === this.p.y || n.y + 1 === this.p.y)) return false;
    const ex = n.x - this.p.x, ey = n.y + 1.12 - this.p.y, ez = n.z - this.p.z;
    return Math.sqrt(ex * ex + ey * ey + ez * ez) <= this.r;
  }
}

class Builder {
  constructor(hands) {
    this.h = hands;
    this.history = [];
    this.active = null;
  }
  get c() { return this.h.c; }

  breakCost(p) {
    const a = this.active;
    if (!a || !a.box) return 0;
    const b = a.box;
    if (p.x < b.x0 - 1 || p.x > b.x1 + 1 || p.y < b.y0 - 1 || p.y > b.y1 + 1 || p.z < b.z0 - 1 || p.z > b.z1 + 1) return 0;
    if (a.digs.has(key(p.x, p.y, p.z))) return 0;
    return a.placed.has(key(p.x, p.y, p.z)) || a.kind !== 'dig' ? 1000 : 0;
  }
  placeCost(p) {
    const a = this.active;
    if (!a || !a.box) return 0;
    const b = a.box;
    return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1 + 1 && p.z >= b.z0 && p.z <= b.z1 ? 1000 : 0;
  }

  isDone(s, c) {
    const b = s.bot.blockAt(new Vec3(c.x, c.y, c.z));
    if (!b) return false;
    const i = info(b);
    if (c.op === 'till') return b.name === 'farmland';
    if (c.op === 'water') return i.liquid;
    if (c.op === 'plant') return b.name === 'wheat';
    if (!c.block) return i.air || i.liquid;
    return matchesAny(b.name, c.block);
  }

  needs(s, cells) {
    const groups = new Map();
    for (const c of cells) {
      if (!c.block || c.op || c.optional) continue;
      const k = c.block.join('|');
      const g = groups.get(k) || { choices: c.block, n: 0 };
      g.n++;
      groups.set(k, g);
    }
    return [...groups.values()];
  }

  haveOf(s, choices) { return s.items().filter((i) => matchesAny(i.name, choices)).reduce((a, i) => a + i.count, 0); }

  shortfall(s, cells) {
    const inv = new Map();
    for (const i of s.items()) inv.set(i.name, (inv.get(i.name) || 0) + i.count);
    const groups = this.needs(s, cells).sort((a, b) => a.choices.length - b.choices.length);
    const short = [];
    for (const g of groups) {
      let n = g.n;
      for (const c of g.choices) {
        for (const [name, k] of inv) {
          if (!n) break;
          if (!k || !matches(name, c)) continue;
          const take = Math.min(n, k);
          inv.set(name, k - take);
          n -= take;
        }
        if (!n) break;
      }
      if (n > 0) short.push({ item: g.choices.find((c) => !['cheap', 'glass', 'fence', 'door'].includes(c)) || 'dirt', choices: g.choices, n: g.n, missing: n });
    }
    return short;
  }

  async gather(s, cells, { label = 'this' } = {}) {
    let short = this.shortfall(s, cells);
    if (!short.length) return;
    const total = this.needs(s, cells).reduce((a, g) => a + g.n, 0);
    const big = short.slice().sort((a, b) => b.missing - a.missing)[0];
    if (big.missing >= 24) {
      const planks = big.item === 'planks' || /_planks$/.test(big.item);
      const what = planks ? `${big.missing} more planks, so about ${Math.ceil(big.missing / 4)} logs` : `${big.missing} more ${big.item.replace(/_/g, ' ')}`;
      this.h.progress(`${label} needs ${what}, getting that first`);
      await s.wait(1500);
    }

    if (short.some((e) => e.item === 'planks' || /_planks$/.test(e.item)) && s.find(LOG_RE)) {
      const want = short.filter((e) => e.item === 'planks' || /_planks$/.test(e.item)).reduce((a, e) => a + e.missing, 0) + s.count(PLANKS_RE);

      const keepLogs = this.needs(s, cells).filter((g) => matches('oak_log', g.choices[0]) || /_log$/.test(g.choices[0])).reduce((a, g) => a + g.n, 0);
      if (s.count(LOG_RE) > keepLogs) await this.h.fetcher.logsToPlanks(s, Math.min(want, s.count(PLANKS_RE) + (s.count(LOG_RE) - keepLogs) * 4)).catch((err) => { if (err.cancelled) throw err; });
      short = this.shortfall(s, cells);
    }
    for (const e of short) {
      const tries = [e.item, ...e.choices.filter((c) => c !== e.item && !['cheap', 'glass', 'fence', 'door'].includes(c))];
      for (const t of tries) {
        const now = this.shortfall(s, cells).find((x) => x.choices === e.choices);
        if (!now) break;
        try { await this.h.fetcher.get(s, t, this.h.fetcher.countOf(s, t) + now.missing, { quiet: true }); } catch (err) { if (err.cancelled) throw err; }
      }
      const still = this.shortfall(s, cells).find((x) => x.choices === e.choices);
      if (still && e.choices.includes('cheap')) await this.h.fetcher.get(s, 'dirt', s.count('dirt') + still.missing, { quiet: true }).catch((err) => { if (err.cancelled) throw err; });
    }
    const left = this.shortfall(s, cells);
    const missing = left.reduce((a, e) => a + e.missing, 0);
    if (missing > total * 0.25) throw new Nope(`not enough ${left[0].item.replace(/_/g, ' ')} for ${label}`);
    if (missing) this.h.progress(`not enough ${left[0].item.replace(/_/g, ' ')}; building with what you have`);
  }

  async run(s, plan, { label = plan.label || 'building', fetch = true, say = true } = {}) {
    const cells = plan.cells.slice(0, MAX_CELLS);
    if (!cells.length) throw new Nope('nothing to do there');
    const first = cells.filter((c) => !c.after);
    const after = cells.filter((c) => c.after);
    const todo = first.filter((c) => !this.isDone(s, c));
    if (fetch) await this.gather(s, todo, { label: plan.kind === 'hut' ? `the ${plan.label || 'hut'}` : 'this' });
    s.check();
    const log = { label, kind: plan.kind, ops: [], at: Date.now(), anchor: plan.anchor };
    this.history.push(log);
    if (this.history.length > 3) this.history.shift();
    const digs = new Set(cells.filter((c) => !c.block && !c.op).map((c) => key(c.x, c.y, c.z)));
    this.active = { box: plan.bounds || boundsOf(cells), digs, placed: new Set(), kind: plan.kind };
    const stats = { placed: 0, dug: 0, skipped: 0, missing: 0, total: cells.length };
    let lastPart = null, saidHalf = false;
    try {
      let deferred = [];
      let failRun = 0;
      const doOne = async (cell) => {
        const r = await this.doCell(s, cell, log);

        failRun = r === 'failed' ? failRun + 1 : r === 'placed' || r === 'dug' ? 0 : failRun;
        if (failRun >= 8) throw new Nope("the blocks won't go down here");
        if (r === 'placed') stats.placed++;
        else if (r === 'dug') stats.dug++;
        else if (r === 'missing') stats.missing++;
        else if (r !== 'ok' && r !== 'defer' && r !== 'failed' && r !== 'unloaded') stats.skipped++;
        return r;
      };
      for (const cell of [...todo, ...after]) {
        s.check();
        if (say && cell.part === 'roof' && lastPart && lastPart !== 'roof' && plan.kind === 'hut') this.h.progress('walls are up, doing the roof');
        lastPart = cell.part;
        const r = await doOne(cell);
        if (r === 'defer' || r === 'failed' || r === 'unloaded') deferred.push(cell);
        const doneN = stats.placed + stats.dug;
        if (say && !saidHalf && todo.length >= 40 && doneN >= todo.length / 2 && plan.kind !== 'hut') { saidHalf = true; this.h.progress('about halfway there'); }
      }
      for (let pass = 0; pass < 3 && deferred.length; pass++) {
        const again = [];
        for (const cell of deferred) { s.check(); const r = await doOne(cell); if (r === 'defer' || r === 'failed' || r === 'unloaded') again.push(cell); }
        if (again.length === deferred.length) { stats.skipped += again.length; deferred = []; break; }
        deferred = again;
      }
      stats.skipped += deferred.length;
    } finally {
      this.active = null;
    }
    const needed = cells.filter((c) => !c.optional);
    const okNow = needed.filter((c) => this.isDone(s, c)).length;
    stats.done = needed.length ? okNow / needed.length : 1;
    return stats;
  }

  async reach(s, p) {
    const bot = s.bot;
    const eye = bot.entity.position.offset(0, 1.62, 0);
    if (eye.distanceTo(p.offset(0.5, 0.5, 0.5)) <= 4.3) return;
    try { await s.goto(new GoalReach(p, 4.0), { dig: false, timeout: 15000 }); } catch (err) {
      if (err.cancelled) throw err;
      await s.goto(new GoalReach(p, 4.0), { dig: true, timeout: 20000 });
    }
  }

  ownerIn(p) {
    const o = this.c.ownerEntity();
    if (!o) return false;
    const q = o.position;
    return Math.floor(q.x) === p.x && Math.floor(q.z) === p.z && (Math.floor(q.y) === p.y || Math.floor(q.y) + 1 === p.y);
  }

  hasSupport(s, p, liquidOk = false) {
    for (const d of DIRS6) {
      const b = s.bot.blockAt(p.offset(...d));
      const i = info(b);
      if (i.solid && !i.liquid) return { ref: b, face: new Vec3(-d[0], -d[1], -d[2]) };
    }
    return liquidOk ? null : null;
  }

  pick(s, choices) {
    for (const c of choices) { const it = s.items().find((i) => matches(i.name, c)); if (it) return it; }
    return null;
  }

  async place(s, p, choices, log, { liquidOk = false } = {}) {
    const bot = s.bot;
    const before = bot.blockAt(p);
    const sup = this.hasSupport(s, p, liquidOk);
    if (!sup) return 'defer';
    const item = this.pick(s, choices);
    if (!item) return 'missing';
    if (this.ownerIn(p)) return 'defer';
    const feet = bot.entity.position.floored();
    if (feet.equals(p) || feet.offset(0, 1, 0).equals(p)) {
      await s.goto(new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, 1.5)), { dig: false, timeout: 6000 }).catch((e) => { if (e.cancelled) throw e; });
    }
    try { await this.reach(s, p); } catch (err) { if (err.cancelled) throw err; return 'failed'; }
    await bot.equip(item, 'hand').catch(() => {});
    for (let attempt = 0; attempt < 2; attempt++) {
      const ref = sup.ref, face = sup.face;
      try {
        await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
        await bot.placeBlock(ref, face);
      } catch {}
      await sleep(100);
      const now = bot.blockAt(p);
      if (placedOk(s, now, item.name, before)) {
        log.ops.push({ kind: 'placed', x: p.x, y: p.y, z: p.z, now: now.name, was: before ? before.name : 'air' });
        if (this.active) this.active.placed.add(key(p.x, p.y, p.z));
        this.h.notePlaced(p);
        return 'placed';
      }
    }
    return 'failed';
  }

  async dig(s, p, log, { force = false } = {}) {
    const b = s.bot.blockAt(p);
    const i = info(b);
    if (!b || i.air || i.liquid) return 'ok';
    if (b.name === 'bedrock') return 'blocked';
    if (PROTECTED_RE.test(b.name) && !force && !(this.active && this.active.placed.has(key(p.x, p.y, p.z)))) return 'protected';
    if (this.h.noDig(p)) return 'rule';
    try { await this.reach(s, p); } catch (err) { if (err.cancelled) throw err; return 'failed'; }
    await this.equipFor(s, b);
    try { await s.digAt(p); } catch (err) { if (err.cancelled) throw err; return 'failed'; }
    log.ops.push({ kind: 'dug', x: p.x, y: p.y, z: p.z, was: b.name });
    return 'dug';
  }

  async equipFor(s, b) {
    const kind = toolFor(b);
    if (!kind) return;
    let best = null, bt = -1;
    for (const i of s.items()) {
      if (!i.name.endsWith(`_${kind}`)) continue;
      const t = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(i.name.split('_')[0]);
      if (t > bt) { bt = t; best = i; }
    }
    if (best && s.bot.heldItem?.name !== best.name) await s.bot.equip(best, 'hand').catch(() => {});
  }

  async doCell(s, cell, log) {
    const p = new Vec3(cell.x, cell.y, cell.z);
    const b = s.bot.blockAt(p);
    if (!b) return 'unloaded';
    if (cell.op) return this.special(s, cell, p, b, log);
    if (!cell.block) return this.dig(s, p, log, { force: !!cell.force });
    if (matchesAny(b.name, cell.block)) return 'ok';
    const i = info(b);
    if (!i.air && !i.plant && !(i.liquid && cell.liquidOk)) {
      if (!cell.replace) return 'blocked';
      const r = await this.dig(s, p, log);
      if (r !== 'dug') return r;
    }
    return this.place(s, p, cell.block, log, { liquidOk: !!cell.liquidOk });
  }

  async special(s, cell, p, b, log) {
    const bot = s.bot;
    switch (cell.op) {
      case 'door': {
        if (matches(b.name, 'door')) return 'ok';
        if (!info(b).air && !info(b).plant) { const r = await this.dig(s, p, log); if (r !== 'dug') return r; }
        if (!info(bot.blockAt(p.offset(0, 1, 0))).air) { const r = await this.dig(s, p.offset(0, 1, 0), log); if (r !== 'dug' && r !== 'ok') return r; }
        if (!this.pick(s, ['door'])) await this.makeDoor(s).catch((e) => { if (e.cancelled) throw e; });
        if (!this.pick(s, ['door'])) return 'missing';
        return this.place(s, p, ['door'], log);
      }
      case 'torch': {
        if (b.name === 'torch' || b.name === 'wall_torch') return 'ok';
        if (!s.count('torch') && s.count(/^(coal|charcoal)$/)) { try { await s.ensureSticks(1); await s.craft('torch', 1); } catch (e) { if (e.cancelled) throw e; } }
        if (!s.count('torch')) return 'missing';
        return this.place(s, p, ['torch'], log);
      }
      case 'furniture': {
        const it = cell.block[0];
        if (b.name === it) return 'ok';
        if (!s.count(it)) {
          const cheap = { crafting_table: () => s.count(PLANKS_RE) >= 4, chest: () => s.count(PLANKS_RE) >= 8, furnace: () => s.count(/^(cobblestone|cobbled_deepslate)$/) >= 8 }[it];
          if (cheap && cheap()) { try { await s.craft(it, 1); } catch (e) { if (e.cancelled) throw e; } }
        }
        if (!s.count(it)) return 'missing';
        return this.place(s, p, [it], log);
      }
      case 'bed': {
        if (matches(b.name, 'bed')) return 'ok';
        if (!this.pick(s, ['bed'])) return 'missing';
        return this.place(s, p, ['bed'], log);
      }
      case 'till': {
        if (b.name === 'farmland') return 'ok';
        if (!/^(dirt|grass_block|dirt_path|coarse_dirt)$/.test(b.name)) return 'blocked';
        const above = bot.blockAt(p.offset(0, 1, 0));
        if (above && !info(above).air) { const r = await this.dig(s, p.offset(0, 1, 0), log); if (r !== 'dug') return r; }
        if (!s.find(/_hoe$/)) { try { await s.ensureSticks(2); await s.ensurePlanks(2); await s.craft('wooden_hoe', 1); } catch (e) { if (e.cancelled) throw e; } }
        const hoe = s.find(/_hoe$/);
        if (!hoe) return 'missing';
        try { await this.reach(s, p); } catch (e) { if (e.cancelled) throw e; return 'failed'; }
        await bot.equip(hoe, 'hand').catch(() => {});
        await bot.lookAt(p.offset(0.5, 1, 0.5), true).catch(() => {});
        try { await bot.activateBlock(bot.blockAt(p), new Vec3(0, 1, 0)); } catch {}
        await sleep(150);
        if (bot.blockAt(p)?.name !== 'farmland' && this.h && typeof this.h.on === 'function' && this.h.on('bodySoloDay')) await sleep(400);
        if (bot.blockAt(p)?.name === 'farmland') { log.ops.push({ kind: 'tilled', x: p.x, y: p.y, z: p.z, was: b.name }); return 'placed'; }
        return 'failed';
      }
      case 'water': {
        if (info(b).liquid) return 'ok';
        const bucket = s.find('water_bucket');
        if (!bucket) return 'missing';
        if (!info(b).air) { const r = await this.dig(s, p, log, { force: true }); if (r !== 'dug') return r; }
        try { await this.reach(s, p); } catch (e) { if (e.cancelled) throw e; return 'failed'; }
        await bot.equip(bucket, 'hand').catch(() => {});
        await bot.lookAt(p.offset(0.5, 0.05, 0.5), true).catch(() => {});
        try { bot.activateItem(); await sleep(250); bot.deactivateItem(); } catch {}
        await sleep(250);
        if (info(bot.blockAt(p)).liquid) { log.ops.push({ kind: 'water', x: p.x, y: p.y, z: p.z }); return 'placed'; }
        return 'failed';
      }
      case 'plant': {
        if (b.name === 'wheat') return 'ok';
        const soil = bot.blockAt(p.offset(0, -1, 0));
        if (!soil || soil.name !== 'farmland') return 'blocked';
        const seeds = s.find('wheat_seeds');
        if (!seeds) return 'missing';
        try { await this.reach(s, p); } catch (e) { if (e.cancelled) throw e; return 'failed'; }
        await bot.equip(seeds, 'hand').catch(() => {});
        try { await bot.lookAt(p.offset(0.5, 0, 0.5), true); await bot.placeBlock(soil, new Vec3(0, 1, 0)); } catch {}
        await sleep(100);

        if (bot.blockAt(p)?.name !== 'wheat' && this.h && typeof this.h.on === 'function' && this.h.on('bodySoloDay')) await sleep(400);
        return bot.blockAt(p)?.name === 'wheat' ? 'placed' : 'failed';
      }
      default: return 'skipped';
    }
  }

  async makeDoor(s) {
    if (s.count(PLANKS_RE) < 6) await s.ensurePlanks(6);
    const counts = {};
    for (const i of s.items()) if (PLANKS_RE.test(i.name)) counts[i.name] = (counts[i.name] || 0) + i.count;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < 6) throw new Nope('not enough planks for a door');
    await s.craft(best[0].replace(/_planks$/, '_door'), 1);
  }

  async undo(s) {
    const log = this.history.pop();
    if (!log) throw new Nope('nothing to undo');
    if (log.ops.some((o) => o.kind === 'placed' && toolFor({ name: o.now }) === 'pickaxe') && s.bestTier('pickaxe') < 0) await s.ensurePickaxe(0).catch((e) => { if (e.cancelled) throw e; });
    let removed = 0, restored = 0;
    this.active = { box: null, digs: new Set(), placed: new Set(log.ops.filter((o) => o.kind === 'placed').map((o) => key(o.x, o.y, o.z))), kind: 'undo' };
    try {
      for (const op of log.ops.slice().reverse()) {
        s.check();
        const p = new Vec3(op.x, op.y, op.z);
        const b = s.bot.blockAt(p);
        if (!b) continue;
        if (op.kind === 'placed' && b.name === op.now) { if ((await this.dig(s, p, { ops: [] }, { force: true })) === 'dug') removed++; }
        else if (op.kind === 'dug' && (info(b).air || info(b).plant)) {
          const back = op.was in DROP ? DROP[op.was] : op.was;
          if (back && s.count(back) && (await this.place(s, p, [back], { ops: [] })) === 'placed') restored++;
        }
      }
    } finally { this.active = null; }
    return { label: log.label, removed, restored };
  }
}

module.exports = { Builder, GoalReach, toolFor, palette, ring, shapePlan, SHAPE_CAPS, hutPlan, quickHutPlan, digBoxPlan, roomPlan, clearPlan, fillHolePlan, liquidPlan, bridgePlan, doorPlan, sealPlan, farmPlan, helpPlan, matches, matchesAny, info, facingSide, boundsOf, CAPS, SIDES, MAX_CELLS };
