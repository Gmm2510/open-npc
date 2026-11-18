'use strict';
// Do no harm: never breaks blocks the player placed and never hurts the player.
const { patch } = require('./bodykit');
const { PROTECTED_RE } = require('./skills');

const ID = { name: 'bodyNoHarm' };
const DEPTH = 6;
const key = (p) => `${p.x},${p.y},${p.z}`;

function install(c, bot) {
  if (!bot || bot._ggNoHarm) return;
  bot._ggNoHarm = true;
  const mine = new Set();
  const log = (line) => { try { c.emit('log', `[dbg] noHarm: ${line}`); } catch {} };

  const underPlayer = (p) => {
    try {
      const o = c.ownerEntity && c.ownerEntity();
      if (!o || !o.position || !p) return false;
      const fy = Math.floor(o.position.y + 0.01);
      if (p.y > fy - 1 || p.y < fy - DEPTH) return false;
      for (const dx of [-0.31, 0.31]) for (const dz of [-0.31, 0.31]) {
        if (Math.floor(o.position.x + dx) === p.x && Math.floor(o.position.z + dz) === p.z) return true;
      }
      return false;
    } catch { return false; }
  };
  const playerBlock = (p) => { try { return !!c.v12?.awareness?.isPlayerBlock?.(p); } catch { return false; } };

  const baseGround = !!(typeof c.f === 'function' && c.f('bodyBaseGround'));
  const isNamed = (e) => { const cn = e && e.metadata && e.metadata[2]; return !!(cn && (typeof cn === 'string' ? cn.trim() : JSON.stringify(cn).length > 4)); };
  const theirs = (b) => !!b && !!b.position && !mine.has(key(b.position)) && (playerBlock(b.position) || PROTECTED_RE.test(b.name || ''));

  const ubCache = new Map(); let ubAt = 0;
  const underBuild = (p, wide = true) => {
    if (!baseGround || !p) return false;
    const now = Date.now();
    if (now - ubAt > 2000) { ubCache.clear(); ubAt = now; }
    const k = key(p);
    if (ubCache.has(k)) return ubCache.get(k);
    const r = underBuildNow(p, wide);
    ubCache.set(k, r);
    return r;
  };
  const underBuildNow = (p, wide) => {
    try {
      for (let dy = 1; dy <= 8; dy++) {
        if (wide) { for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (theirs(bot.blockAt(p.offset(dx, dy, dz)))) return true; }
        else if (theirs(bot.blockAt(p.offset(0, dy, 0)))) return true;
      }
    } catch {}
    return false;
  };
  let pets = [], petsAt = 0;
  const underPet = (p) => {
    if (!baseGround || !p) return false;
    try {
      const now = Date.now();
      if (now - petsAt > 1000) {
        petsAt = now;
        pets = Object.values(bot.entities).filter((e) => e && e !== bot.entity && e.type !== 'player' && e.position && isNamed(e)).map((e) => e.position.clone());
      }
      for (const q of pets) if (Math.hypot(q.x - (p.x + 0.5), q.z - (p.z + 0.5)) <= 3 && p.y <= q.y) return true;
    } catch {}
    return false;
  };
  const why = (block) => {
    if (!block || !block.position) return null;
    const p = block.position;
    if (mine.has(key(p))) return null;
    if (playerBlock(p)) return `the player placed that ${block.name}`;
    if (PROTECTED_RE.test(block.name || '')) return `${block.name} is something players build with`;
    if (underPlayer(p)) return 'the player is standing over that';
    if (underPet(p)) return 'a named pet is right there';
    if (underBuild(p)) return "that's ground under the player's build";
    return null;
  };

  patch(bot, 'placeBlock', ID, function (next, ref, face, ...a) {
    return Promise.resolve(next(ref, face, ...a)).then((r) => {
      try { if (ref && ref.position && face) mine.add(key(ref.position.plus(face))); } catch {}
      return r;
    });
  });

  if (typeof bot._genericPlace === 'function') {
    patch(bot, '_genericPlace', ID, function (next, ref, face, ...a) {
      return Promise.resolve(next(ref, face, ...a)).then((r) => {
        try { if (ref && ref.position && face) mine.add(key(ref.position.plus(face))); } catch {}
        return r;
      });
    });
  }
  patch(bot, 'dig', ID, function (next, block, ...a) {
    const w = why(block);
    if (w) {
      log(`won't dig ${block.name} at ${key(block.position)}: ${w}`);
      return Promise.reject(new Error(`noHarm: ${w}`));
    }
    return next(block, ...a);
  });

  const data = () => { try { return require('minecraft-data')(bot.version); } catch { return null; } };
  const protect = (m) => {
    if (!m || m._ggNoHarm) return;
    m._ggNoHarm = true;
    const d = data();
    if (d && m.blocksCantBreak && m.blocksCantBreak.add) {
      for (const b of Object.values(d.blocksByName)) if (PROTECTED_RE.test(b.name)) m.blocksCantBreak.add(b.id);
    }
    if (Array.isArray(m.exclusionAreasBreak)) {
      m.exclusionAreasBreak.push((b) => (b && b.position && !mine.has(key(b.position)) && (playerBlock(b.position) || underPlayer(b.position) || underBuild(b.position) || underPet(b.position)) ? 100000 : 0));
    }
  };
  if (bot.pathfinder) {
    patch(bot.pathfinder, 'setMovements', ID, function (next, m, ...a) { protect(m); return next(m, ...a); });
    protect(bot.pathfinder.movements);
  }
  if (bot.collectBlock && bot.collectBlock.movements) protect(bot.collectBlock.movements);
  log('installed');
}

module.exports = { install };
