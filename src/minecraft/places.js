// What it remembers about one world: named places, house rules (places never to dig near) and unfinished builds.
const fs = require('fs');
const path = require('path');

const MAX_PLACES = 40;
const MAX_AUTO = 8;
const MAX_PLANS = 4;
const MAX_RULES = 8;
const HOME_WORDS = /^(home|house|base|the house|our house|my house|our base|the base|hut|our hut)$/;

const clean = (s, n = 24) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function normName(s) {
  const t = clean(s, 32).replace(/^(the|our|my|that|this|a) /, '').trim();
  return t.slice(0, 24);
}
const round = (p) => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function direction(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d < 6) return 'right here';
  const a = Math.atan2(dx, -dz);
  const names = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const word = names[(Math.round(a / (Math.PI / 4)) + 8) % 8];
  const r = d < 20 ? Math.round(d / 5) * 5 : d < 100 ? Math.round(d / 10) * 10 : Math.round(d / 50) * 50;
  return `about ${r} blocks ${word}`;
}

function worldKey({ host = 'localhost', port = 25565, spawn = null } = {}) {
  const s = spawn ? `${Math.round(spawn.x)}_${Math.round(spawn.z)}` : 'nospawn';
  return `${String(host).replace(/[^a-z0-9.-]+/gi, '_')}_${Number(port) || 25565}_${s}`.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
}

class Places {
  constructor() {
    this.dir = null;
    this.key = null;
    this.data = Places.empty();
    this.dirty = false;
  }

  static empty() { return { version: 1, places: [], plans: [], rules: [], snapshot: null, deaths: [] }; }

  setStorage(dir) { this.dir = dir || null; if (this.key) this.load(this.key); }

  file() { return this.dir && this.key ? path.join(this.dir, `places-${this.key}.json`) : null; }

  load(key) {
    this.key = key;
    this.data = Places.empty();
    const f = this.file();
    if (!f) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (raw && typeof raw === 'object') this.data = { ...Places.empty(), ...raw };
    } catch {}
    return this.data;
  }

  save() {
    const f = this.file();
    this.dirty = false;
    if (!f) return false;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(this.data, null, 1));
      return true;
    } catch { return false; }
  }

  add(name, pos, { note = '', kind = 'named', by = 'player', now = Date.now() } = {}) {
    const n = normName(name);
    if (!n || !pos || !Number.isFinite(pos.x)) return null;
    const list = this.data.places;
    const isHome = HOME_WORDS.test(n) || HOME_WORDS.test(clean(name));

    const same = list.find((p) => p.name === n || (p.aliases || []).includes(n));
    if (same) {
      Object.assign(same, { pos: round(pos), note: clean(note, 80) || same.note, at: now });
      if (kind !== 'auto') { same.kind = kind; same.by = by; }
      this.dirty = true;
      return same;
    }
    const near = kind !== 'auto' && list.find((p) => p.kind !== 'death' && dist(p.pos, pos) <= 8);
    if (near && !isHome) {
      near.aliases = [...new Set([...(near.aliases || []), n])].slice(-4);
      if (near.kind === 'auto') { near.aliases = [...new Set([...(near.aliases || []), near.name])].slice(-4); near.name = n; near.kind = kind; near.by = by; }
      near.at = now;
      this.dirty = true;
      return near;
    }
    const place = { name: isHome ? 'home' : n, aliases: isHome && n !== 'home' ? [n] : [], pos: round(pos), note: clean(note, 80), kind: isHome ? 'home' : kind, by, at: now };
    if (isHome) this.data.places = list.filter((p) => p.kind !== 'home' && p.name !== 'home');
    this.data.places.push(place);

    const autos = this.data.places.filter((p) => p.kind === 'auto');
    if (autos.length > MAX_AUTO) this.remove(autos.sort((a, b) => a.at - b.at)[0].name);
    if (this.data.places.length > MAX_PLACES) {
      const drop = this.data.places.filter((p) => p.kind !== 'home').sort((a, b) => a.at - b.at)[0];
      if (drop) this.remove(drop.name);
    }
    this.dirty = true;
    return place;
  }

  remove(name) {
    const n = normName(name);
    const before = this.data.places.length;
    this.data.places = this.data.places.filter((p) => p.name !== n && !(p.aliases || []).includes(n));
    if (this.data.places.length !== before) { this.dirty = true; return true; }
    return false;
  }

  find(name) {
    const n = normName(name);
    if (!n) return null;
    const list = this.data.places;
    const exact = list.find((p) => p.name === n) || list.find((p) => (p.aliases || []).includes(n));
    if (exact) return exact;
    if (HOME_WORDS.test(n) || HOME_WORDS.test(clean(name))) return list.find((p) => p.kind === 'home') || null;
    const words = n.split(' ').filter((w) => w.length > 2);
    return list.find((p) => [p.name, ...(p.aliases || [])].some((x) => words.length && words.every((w) => x.includes(w)))) || null;
  }

  home() { return this.data.places.find((p) => p.kind === 'home') || null; }

  nearest(pos, filter = () => true) {
    let best = null, bd = Infinity;
    for (const p of this.data.places) { if (!filter(p)) continue; const d = flat(p.pos, pos); if (d < bd) { bd = d; best = p; } }
    return best ? { place: best, dist: bd } : null;
  }

  listFor(pos, n = 6, { coined = false } = {}) {
    const list = this.data.places.filter((p) => p.kind !== 'death').slice();
    if (pos) list.sort((a, b) => flat(a.pos, pos) - flat(b.pos, pos));
    return list.slice(0, n).map((p) => {
      const where = pos ? direction(pos, p.pos) : `at ${p.pos.x} ${p.pos.y} ${p.pos.z}`;
      const theirs = coined && (p.kind === 'coined' || (p.by === 'player' && p.kind !== 'home')) ? " (the player's name for it)" : '';
      const note = p.note && !true ? ` (${p.note})` : '';
      return `${p.name}${theirs}: ${where}${note}`;
    });
  }

  addDeath(pos, now = Date.now()) {
    if (!pos) return null;
    const d = { pos: round(pos), at: now };
    this.data.deaths = [...(this.data.deaths || []), d].slice(-3);
    this.dirty = true;
    return d;
  }
  lastDeath() { const l = this.data.deaths || []; return l[l.length - 1] || null; }

  addRule({ name = 'here', center, radius = 8, kind = 'nodig', now = Date.now() }) {
    if (!center) return null;
    const r = { name: normName(name) || 'here', center: round(center), radius: Math.max(2, Math.min(24, Math.round(radius))), kind, at: now };
    this.data.rules = [...(this.data.rules || []).filter((x) => x.name !== r.name), r].slice(-MAX_RULES);
    this.dirty = true;
    return r;
  }
  removeRule(name) {
    const n = normName(name);
    const before = (this.data.rules || []).length;
    this.data.rules = (this.data.rules || []).filter((r) => r.name !== n);
    this.dirty = this.dirty || before !== this.data.rules.length;
    return before !== this.data.rules.length;
  }

  noDig(pos) {
    for (const r of this.data.rules || []) {
      if (r.kind !== 'nodig') continue;
      if (flat(r.center, pos) <= r.radius && pos.y >= r.center.y - 2) return r;
    }
    return null;
  }
  ruleLines() { return (this.data.rules || []).map((r) => `no digging within ${r.radius} blocks of ${r.name}`); }

  savePlan(plan, now = Date.now()) {
    if (!plan || !plan.label) return null;
    const p = { label: String(plan.label).slice(0, 60), action: plan.action || 'build', args: plan.args || {}, anchor: plan.anchor ? round(plan.anchor) : null, done: Math.max(0, Math.min(1, Number(plan.done) || 0)), at: now, offered: false };
    this.data.plans = [...(this.data.plans || []).filter((x) => x.label !== p.label), p].slice(-MAX_PLANS);
    this.dirty = true;
    return p;
  }

  offerPlan() {
    const p = (this.data.plans || []).find((x) => !x.offered);
    if (!p) return null;
    p.offered = true;
    this.dirty = true;
    return p;
  }
  dropPlan(label) {
    const before = (this.data.plans || []).length;
    this.data.plans = (this.data.plans || []).filter((x) => x.label !== label);
    if (before !== this.data.plans.length) this.dirty = true;
  }
  latestPlan() { const l = this.data.plans || []; return l[l.length - 1] || null; }

  setSnapshot(center, counts, now = Date.now()) {
    this.data.snapshot = { center: round(center), counts: { ...counts }, at: now };
    this.dirty = true;
  }

  static diff(before, after, n = 3) {
    if (!before || !after) return [];
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changes = [];
    for (const k of names) {
      const a = before[k] || 0, b = after[k] || 0;
      if (a === b) continue;
      const label = k.replace(/_/g, ' ');
      if (!b) changes.push({ w: a + 5, text: a === 1 ? `the ${label} is gone` : `all ${a} ${label} are gone` });
      else if (!a) changes.push({ w: b + 5, text: b === 1 ? `a new ${label}` : `${b} new ${label}` });
      else if (Math.abs(b - a) >= 4) changes.push({ w: Math.abs(b - a), text: b > a ? `${b - a} more ${label}` : `${a - b} fewer ${label}` });
    }
    return changes.sort((x, y) => y.w - x.w).slice(0, n).map((c) => c.text);
  }
}

module.exports = { Places, normName, worldKey, direction, HOME_WORDS };
