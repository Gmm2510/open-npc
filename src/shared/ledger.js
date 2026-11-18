// One "recently used" ledger that owns rates and cooldowns, so habits feel like habits and not a script.
const RULES = {
  line: { gapMs: 30 * 60 * 1000 },
  saying: { gapMs: 4 * 60 * 1000, perWindow: [3, 10 * 60 * 1000] },
  joke: { gapMs: 20 * 60 * 1000 },
  story: { gapMs: 60 * 60 * 1000 },
  bit: { gapMs: 45 * 60 * 1000 },
  praise: { gapMs: 90 * 1000, perWindow: [3, 10 * 60 * 1000] },
  name: { gapMs: 3 * 60 * 1000 },
  question: { perWindow: [3, 10 * 60 * 1000] },
  laugh: { gapMs: 0 },
  slip: { gapMs: 6 * 60 * 1000, perWindow: [2, 30 * 60 * 1000] },
  whatq: { gapMs: 45 * 1000, perWindow: [3, 10 * 60 * 1000] },
  callback: { gapMs: 8 * 60 * 1000, perWindow: [2, 30 * 60 * 1000] },
  gripe: { gapMs: 5 * 60 * 1000 },
  tease: { gapMs: 4 * 60 * 1000, perWindow: [3, 30 * 60 * 1000] },
  thanks: { gapMs: 60 * 1000 },
  idle: { gapMs: 0 },
  unprompted: { gapMs: 20 * 1000 },
  extra: { gapMs: 0 }
};

class Ledger {
  constructor(rules = {}) {
    this.rules = { ...RULES, ...rules };
    this.uses = new Map();
    this.byKind = new Map();
  }

  static norm(text) {
    return String(text || '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  rule(kind) { return this.rules[kind] || { gapMs: 0 }; }

  lastUsed(kind, key) {
    const list = this.uses.get(`${kind}\u0000${Ledger.norm(key)}`);
    return list && list.length ? list[list.length - 1] : 0;
  }

  count(kind, key = null, windowMs = Infinity, now = Date.now()) {
    const list = this.byKind.get(kind) || [];
    const k = key == null ? null : Ledger.norm(key);
    return list.filter((u) => (k == null || u.key === k) && now - u.at <= windowMs).length;
  }

  allow(kind, key = '', now = Date.now(), rule = null) {
    const r = rule || this.rule(kind);
    if (r.gapMs && key !== null) {
      const last = this.lastUsed(kind, key);
      if (last && now - last < r.gapMs) return false;
    }
    if (r.perWindow) {
      const [n, win] = r.perWindow;
      if (this.count(kind, null, win, now) >= n) return false;
    }
    if (r.kindGapMs) {
      const list = this.byKind.get(kind) || [];
      const last = list.length ? list[list.length - 1].at : 0;
      if (last && now - last < r.kindGapMs) return false;
    }
    return true;
  }

  use(kind, key = '', now = Date.now()) {
    const k = Ledger.norm(key);
    const id = `${kind}\u0000${k}`;
    const list = this.uses.get(id) || [];
    list.push(now);
    if (list.length > 20) list.shift();
    this.uses.set(id, list);
    const kl = this.byKind.get(kind) || [];
    kl.push({ key: k, at: now });
    if (kl.length > 200) kl.shift();
    this.byKind.set(kind, kl);
    return true;
  }

  take(kind, key = '', now = Date.now()) {
    if (!this.allow(kind, key, now)) return false;
    this.use(kind, key, now);
    return true;
  }

  recent(kind, n = 10) {
    return (this.byKind.get(kind) || []).slice(-n).map((u) => u.key);
  }

  pickLru(kind, items, keyOf = (x) => x, now = Date.now()) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return null;
    let best = null, bestAt = Infinity;
    const shuffled = list.map((x) => ({ x, r: Math.random() })).sort((a, b) => a.r - b.r).map((o) => o.x);
    for (const it of shuffled) {
      const at = this.lastUsed(kind, keyOf(it));
      if (at < bestAt) { best = it; bestAt = at; }
    }
    this.use(kind, keyOf(best), now);
    return best;
  }

  allowedSayings(list, now = Date.now()) {
    return (list || []).filter((s) => typeof s === 'string' && this.allow('saying', s, now));
  }

  sayingsIn(text, list) {
    const t = ` ${Ledger.norm(text)} `;
    return (list || []).filter((s) => typeof s === 'string' && Ledger.norm(s).length >= 3 && t.includes(` ${Ledger.norm(s)} `));
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this.byKind) out[k] = v.length;
    return out;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { Ledger, RULES };
if (typeof window !== 'undefined') window.GGLedger = { Ledger, RULES };
