// Following at a distance, like a friend who isn't glued to you.
const { goals } = require('mineflayer-pathfinder');

const BAND = 2;

class GoalGap extends goals.Goal {
  constructor(entity, gap, bot) {
    super();
    this.entity = entity;
    this.bot = bot || null;
    this.gapOf = typeof gap === 'function' ? gap : () => gap;
    this.walking = false;
    this.sync();

    if (this.botDist() > this.gap + BAND) this.walking = true;
  }

  get gap() { return Math.max(1, Number(this.gapOf()) || 6); }

  sync() {
    const p = this.entity.position.floored();
    this.x = p.x; this.y = p.y; this.z = p.z;
  }

  stopAt() { return this.walking ? this.gap : this.gap + BAND; }

  distTo(node) {
    const dx = this.x + 0.5 - (node.x + 0.5), dy = this.y - node.y, dz = this.z + 0.5 - (node.z + 0.5);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  botDist() {
    const b = this.bot && this.bot.entity && this.bot.entity.position;
    if (!b) return 0;
    return this.entity.position.distanceTo(b);
  }

  heuristic(node) { return Math.max(0, this.distTo(node) - this.stopAt()); }

  isEnd(node) { return this.distTo(node) <= this.stopAt(); }

  hasChanged() {
    const d = this.botDist();
    if (d <= this.gap) {
      this.walking = false;
      return false;
    }
    const p = this.entity.position.floored();
    const moved = Math.hypot(p.x - this.x, p.z - this.z) + Math.abs(p.y - this.y) > 1.5;
    if (!this.walking) {
      if (d > this.gap + BAND) { this.walking = true; this.sync(); return true; }
      return false;
    }
    if (moved) { this.sync(); return true; }
    return false;
  }

  isValid() { return this.entity != null; }
}

const TIERS = ['netherite', 'diamond', 'iron', 'copper', 'stone', 'golden', 'wooden'];
const rank = (name) => { const i = TIERS.findIndex((t) => name.startsWith(t)); return i < 0 ? 50 : i; };
const KINDS = new Set(['pickaxe', 'sword', 'axe', 'shovel', 'hoe']);
function pickHeld(items, want, isFood = () => false) {
  const w = String(want || '').toLowerCase().replace(/^minecraft:/, '').trim().replace(/[\s-]+/g, '_');
  if (!w || !Array.isArray(items)) return null;
  if (KINDS.has(w)) {
    const of = items.filter((i) => i && (i.name === w || i.name.endsWith(`_${w}`)) && !(w === 'axe' && /pickaxe$/.test(i.name)));
    of.sort((a, b) => rank(a.name) - rank(b.name));
    return of[0] || null;
  }
  if (w === 'food') return items.find((i) => i && isFood(i)) || null;
  if (w === 'log') return items.find((i) => i && /_(log|stem)$/.test(i.name)) || null;
  if (w === 'planks') return items.find((i) => i && /_planks$/.test(i.name)) || null;
  return items.find((i) => i && i.name === w) || items.find((i) => i && i.name.endsWith(`_${w}`)) || null;
}

module.exports = { GoalGap, pickHeld, BAND };
