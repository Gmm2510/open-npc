// The AI loop. It asks any address that speaks OpenAI-style "chat completions with tools" what the companion should do next,
// and hands the answer to the body. The body does the work itself (paths, mining, crafting, building, fighting); the AI only
// picks the job and its details, the same way a player would ask a friend.
//
// When it asks:
//   - the owner typed something to it in game chat
//   - a job ended, failed, or needs something from the owner
//   - it has had nothing to do for a while (free time)
//   - an app on this PC that supports the "wait" door (GET <address>/wait) says the owner just spoke to it some other way,
//     for example out loud on a voice call. The app adds the owner's words to the next question itself.
// One question at a time, at most one every couple of seconds; whatever comes up while one is out is asked next.

const { sanitizeArgs, ACTIONS, OLD_JOBS, promptLines } = require('./minecraft/commandspec');

const BASIC = {
  follow: 'stay close to the owner (the default)',
  come: 'walk over to the owner right now',
  stay: 'wait here (90 seconds)',
  flee: 'run from danger',
  attack: 'fight the nearest hostile mob',
  guard: 'guard the owner for two minutes',
  pick_up: 'pick up items lying nearby',
  emote: 'a little wave or jump',
  stop_task: 'stop the current job and follow'
};
const JOBS = {
  gather_wood: 'chop trees {n, wood}', build_house: 'build a small house', make_tools: 'craft tools {item}',
  mine_coal: 'mine coal {n}', mine_iron: 'mine iron {n}', mine_gold: 'mine gold {n}', mine_diamonds: 'mine diamonds {n}',
  smelt: 'smelt {item}', hunt_food: 'hunt animals for food', light_up: 'place torches around', explore: 'explore {kind}',
  give_loot: 'hand the owner items {item, n}'
};
// Events that are worth a question right away. Everything else waits for the next one, as "what happened".
const ASK_ON = new Set(['task_done', 'task_failed', 'command_needs', 'free_time', 'player_died', 'companion_revived', 'mission']);
const MIN_GAP_MS = 2500;

class Brain {
  constructor({ body, url, key = '', model = '', name, owner = () => '', log = () => {}, speakInChat = true, timeoutMs = 60000, waitRetryMs = 60000, fetchFn = fetch }) {
    this.waitRetryMs = waitRetryMs;
    this.naps = new Set();
    this.body = body;
    this.url = String(url || '').replace(/\/+$/, '');
    this.key = key;
    this.model = model;
    this.name = name;
    this.owner = owner;
    this.log = log;
    this.speakInChat = speakInChat;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchFn;
    this.state = null;
    this.happened = [];      // things since the last question, in plain words
    this.done = [];          // the last few things it was told to do, and how they went
    this.typed = [];         // what the owner typed since the last question
    this.reasons = new Set();
    this.busy = false;
    this.lastAskAt = 0;
    this.timer = null;
    this.stopped = false;
    this.asks = 0;
    this.waitOn = false;
    body.on('state', (s) => { this.state = s; });
    body.on('event', (ev) => this.onEvent(ev));
    body.on('playerText', (text) => { this.typed.push(String(text).slice(0, 300)); this.typed = this.typed.slice(-3); this.want('typed'); });
  }

  actions() {
    const on = (this.body.feats) || {};
    const list = [...Object.keys(BASIC), ...OLD_JOBS];
    for (const [sw, names] of Object.entries(ACTIONS)) if (on[sw]) list.push(...names);
    return [...new Set(list)];
  }

  tools() {
    return [{
      type: 'function',
      function: {
        name: 'act',
        description: `Make ${this.name} do something in the game. One action per call; the body carries the job out by itself and reports back.`,
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: this.actions(), description: 'What to do.' },
            args: { type: 'object', description: 'Only the details the owner gave, like {"item": "birch_log", "n": 64}. No details: {}.' }
          },
          required: ['action']
        }
      }
    }];
  }

  system() {
    const owner = this.owner() || 'the player';
    const on = this.body.feats || {};
    const sp = { v12: { on: { ...on, leanCommands: false } }, trigger: { kind: 'player', text: '' } };
    const guide = (promptLines(sp) || []).filter(Boolean).join('\n');
    return [
      `You control ${this.name}, a companion character in a Minecraft survival world, playing alongside ${owner}.`,
      `You only decide what ${this.name} does: call the act tool. The body walks, mines, crafts, builds and fights by itself and tells you how it went.`,
      `When ${owner} asks for something, do it right away with act. Take the obvious reading of what they want.`,
      `When nobody asked for anything, keep going with the current job, or on free time pick one useful thing, or do nothing. Don't start something new in the middle of a job unless ${owner} asked.`,
      this.speakInChat
        ? `Anything you write besides the tool call shows up in the game chat as ${this.name}'s words: keep it to one short, casual line, or nothing.`
        : 'Your words are never shown to anyone: when there is something to do, only call the tool; when there is nothing to do, answer with just "nothing to do".',
      'Rules: never claim to be human. No slurs, hate, sexual content or dangerous real-world advice. Never ask for personal information.',
      '',
      `Basic actions: ${Object.entries(BASIC).map(([k, v]) => `${k} (${v})`).join(', ')}.`,
      `Jobs: ${Object.entries(JOBS).map(([k, v]) => `${k} (${v})`).join(', ')}.`,
      guide
    ].filter((x) => x !== null).join('\n');
  }

  onEvent(ev) {
    if (!ev || !ev.event) return;
    const line = describe(ev, this.owner() || 'the player');
    if (line) { this.happened.push(line); this.happened = this.happened.slice(-8); }
    if (ASK_ON.has(ev.event) || ev.priority === 'high') this.want(ev.event);
  }

  // Something worth a question came up: ask now, or as soon as the last one is back.
  want(reason) {
    if (this.stopped) return;
    this.reasons.add(reason);
    if (this.busy || this.timer) return;
    const wait = Math.max(0, this.lastAskAt + MIN_GAP_MS - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this.ask().catch((e) => this.log(`ask failed: ${e.message}`)); }, wait);
  }

  situation() {
    const s = this.state || {};
    const owner = this.owner() || 'the player';
    const lines = [];
    const show = (k, v) => { if (v !== undefined && v !== null && v !== '') lines.push(`- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`); };
    show('your health', s.your_health); show('your food', s.your_food); show('time', s.time_of_day);
    show(`distance to ${owner}`, s.distance_to_player); show('hostile mobs nearby', s.hostile_mobs_nearby);
    show('doing now', s.you_are_doing); show('your height (y)', s.your_y_level); show('your tools', s.your_tools);
    show('home', s.your_house); show('carrying', s.your_inventory);
    for (const [k, v] of Object.entries(s)) {
      if (/^(your_|time_of_day|distance_to_player|hostile_mobs_nearby|you_are_doing|difficulty|player_online)/.test(k)) continue;
      if (v === null || v === undefined || v === '' || typeof v === 'object' && !Array.isArray(v)) continue;
      show(k.replace(/_/g, ' '), v);
    }
    return lines.join('\n');
  }

  async ask() {
    if (this.stopped || this.busy) return;
    const reasons = [...this.reasons];
    this.reasons.clear();
    this.busy = true;
    this.lastAskAt = Date.now();
    const owner = this.owner() || 'the player';
    const typed = this.typed.splice(0);
    const happened = this.happened.splice(0);
    const parts = [`Now:\n${this.situation() || '- just joined'}`];
    if (this.done.length) parts.push(`What you were told to do lately:\n${this.done.map((d) => `- ${d}`).join('\n')}`);
    if (happened.length) parts.push(`What happened:\n${happened.map((h) => `- ${h}`).join('\n')}`);
    if (typed.length) parts.push(`${owner} typed to you: ${typed.map((t) => `"${t}"`).join(' then ')}`);
    else if (reasons.includes('free_time')) parts.push('You have had nothing to do for a while. Pick one useful thing, or keep following.');
    else if (reasons.includes('call')) parts.push(`${owner} is with you now.`);
    const playerAsked = typed.length > 0 || reasons.includes('words');
    try {
      const res = await this.post({ model: this.model || undefined, messages: [{ role: 'system', content: this.system() }, { role: 'user', content: parts.join('\n\n') }], tools: this.tools(), tool_choice: 'auto', max_tokens: 400, stream: false });
      this.asks++;
      const msg = res && res.choices && res.choices[0] && res.choices[0].message;
      if (!msg) { this.log('the AI answered with nothing'); return; }
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text && this.speakInChat) this.body.say(text);
      for (const c of calls.slice(0, 2)) {
        let input = {};
        try { input = JSON.parse((c.function && c.function.arguments) || '{}'); } catch {}
        const action = String(input.action || '').trim();
        if (!action) continue;
        if (!this.actions().includes(action)) { this.remember(`${action}: not something you can do`); continue; }
        const args = sanitizeArgs(input.args || {}, action);
        const r = this.body.command(action, args, { src: playerAsked ? 'player' : 'brain' }) || {};
        const how = r.ok ? 'started' : `didn't start (${String(r.reason || 'unknown').replace(/_/g, ' ')}${r.job ? `: busy ${r.job}` : ''})`;
        this.remember(`${action}${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}: ${how}`);
        this.log(`does ${action} ${JSON.stringify(args)}: ${how}`);
      }
      if (!calls.length) this.log(`no move${text ? `: "${text.slice(0, 120)}"` : ''}`);
    } catch (e) {
      this.log(`couldn't reach the AI: ${e.message}`);
    } finally {
      this.busy = false;
      if (this.reasons.size && !this.stopped) this.want([...this.reasons][0]);
    }
  }

  remember(line) { this.done.push(line.slice(0, 200)); this.done = this.done.slice(-4); }

  async post(body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this.fetch(`${this.url}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) }, body: JSON.stringify(body), signal: ctrl.signal });
      const t2 = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${t2.slice(0, 200)}`);
      return JSON.parse(t2);
    } finally { clearTimeout(t); }
  }

  // The "wait" door: an app that hears the owner some other way (a voice call) answers when they speak or a call starts,
  // and adds their words to the next question itself. Any address without the door just answers 404, and this stops.
  async waitLoop() {
    let since = null, call = false, misses = 0;
    this.waitOn = true;
    while (!this.stopped) {
      try {
        const q = since === null ? '' : `?since=${since}&call=${call ? 1 : 0}&ms=25000`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 35000);
        let r;
        try { r = await this.fetch(`${this.url}/wait${q}`, { headers: this.key ? { Authorization: `Bearer ${this.key}` } : {}, signal: ctrl.signal }); } finally { clearTimeout(t); }
        // (no door here, maybe an older app: look again now and then, in case it is updated or restarted)
        if (r.status === 404) {
          if (this.waitOn) this.log('this AI has no wait door; asking on game events only');
          this.waitOn = false; since = null;
          await this.nap(this.waitRetryMs);
          continue;
        }
        const j = await r.json();
        if (!this.waitOn) this.log('the wait door is there: asking the moment you speak');
        this.waitOn = true;
        misses = 0;
        const words = Number(j.words) || 0;
        if (since !== null && words > since) this.want('words');
        if (!!j.call && !call) this.want('call');
        since = words; call = !!j.call;
      } catch (e) {
        if (this.stopped) return;
        misses++;
        await this.nap(Math.min(30000, 1000 * 2 ** Math.min(misses, 5)));
      }
    }
  }

  // a sleep that ends early when the loop is stopped
  nap(ms) {
    return new Promise((r) => {
      const wake = () => { clearTimeout(t); this.naps.delete(wake); r(); };
      const t = setTimeout(wake, ms);
      this.naps.add(wake);
    });
  }

  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; for (const wake of this.naps) wake(); this.naps.clear(); }
}

// One plain line for an event from the body, or ''.
function describe(ev, owner) {
  const d = ev.data || {};
  const v = (x) => (x === undefined || x === null ? '' : String(x));
  switch (ev.event) {
    case 'task_started': return `started ${v(d.task)}`;
    case 'task_progress': return `${v(d.task)}: ${v(d.note)}`;
    case 'task_done': return `finished ${v(d.task)}${d.result ? `: ${v(d.result)}` : ''}`;
    case 'task_failed': return `gave up on ${v(d.task)}${d.reason ? `: ${v(d.reason)}` : ''}`;
    case 'command_needs': return `${v(d.action) || 'that'} needs an answer from ${owner} first: ${v(d.ask).slice(0, 160)}`;
    case 'free_time': return `free time (${[d.time, d.tools && `tools: ${d.tools}`, d.carrying && `carrying: ${d.carrying}`, d.recently && `lately: ${d.recently}`, d.hint].filter(Boolean).join('; ')})`;
    case 'player_died': return `${owner} died${d.cause ? ` (${v(d.cause)})` : ''}`;
    case 'player_hurt': return `${owner} got hurt${d.cause ? ` by ${v(d.cause)}` : ''}`;
    case 'companion_hurt': return `you got hurt (health ${v(d.health)}/20${d.cause ? `, ${v(d.cause)}` : ''})`;
    case 'companion_downed': return `you died (${v(d.cause)})`;
    case 'companion_revived': return 'you came back after dying';
    case 'companion_joined': return 'you joined the world';
    case 'monster_spotted': return `spotted a ${v(d.monster)} ${v(d.distance_m)} blocks away`;
    case 'monster_chasing': return `a ${v(d.monster)} is coming at you`;
    case 'monster_killed': return `${d.by === 'player' ? owner : 'you'} killed a ${v(d.monster)}`;
    case 'loot_found': return `${d.by === 'player' ? owner : 'you'} picked up ${v(d.count)} ${v(d.item)}`;
    case 'ore_spotted': return `spotted ${v(d.ore)} ${v(d.distance_m)} blocks away`;
    case 'first_find': return `found ${v(d.thing)} for the first time`;
    case 'gave_player': return `gave ${owner} ${v(d.item)}`;
    case 'player_build': return `${owner} is building`;
    case 'broke_player_block': return `broke one of ${owner}'s blocks (${v(d.block)}) by mistake${d.fixed ? ', put it back' : ''}`;
    case 'heard': return `heard ${v(d.sound)} ${v(d.direction)}`.trim();
    case 'mission': return v(d.text || d.note).slice(0, 160);
    default: return '';
  }
}

module.exports = { Brain, describe, BASIC, JOBS };
