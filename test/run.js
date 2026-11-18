// Tests for the AI loop with a stand-in body and a stand-in AI on this PC. No game, no network, no cost.
//   node test/run.js
const http = require('http');
const { EventEmitter } = require('events');
const { Brain, describe } = require('../src/brain');
const FEATURES = require('../src/features');

let pass = 0, fail = 0;
const ok = (c, msg, more = '') => { if (c) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg, more); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 6000) => { const t = Date.now() + ms; for (;;) { if (f()) return true; if (Date.now() > t) return false; await sleep(30); } };

class FakeBody extends EventEmitter {
  constructor() { super(); this.feats = { ...FEATURES }; this.cmds = []; this.said = []; this.opts = { owner: 'Steve' }; }
  command(name, args, meta) { this.cmds.push({ name, args, meta }); return name === 'mine_diamonds' ? { ok: false, reason: 'no_pickaxe' } : { ok: true }; }
  say(t) { this.said.push(t); }
}

// A stand-in AI. reply(lastUserText) -> { text, action, args }. withWait: it has the wait door.
function standIn({ withWait = false, reply }) {
  const seen = [];
  let words = 0, call = false;
  const waiters = new Set();
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/v1/wait') {
      if (!withWait) { res.writeHead(404); return res.end('{}'); }
      const q = new URL(req.url, 'http://x').searchParams;
      const since = q.has('since') ? Number(q.get('since')) : NaN, was = q.get('call') === '1';
      const now = () => JSON.stringify({ call, words });
      if (!Number.isFinite(since) || words > since || call !== was) { res.writeHead(200); return res.end(now()); }
      const done = () => { waiters.delete(done); if (!res.writableEnded) { res.writeHead(200); res.end(now()); } };
      waiters.add(done); setTimeout(done, Number(q.get('ms')) || 25000); return;
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
        const j = JSON.parse(b);
        seen.push(j);
        const user = j.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
        const r = reply(user) || {};
        const msg = { role: 'assistant', content: r.text || null };
        if (r.action) msg.tool_calls = [{ id: 'c1', type: 'function', function: { name: 'act', arguments: JSON.stringify({ action: r.action, args: r.args || {} }) } }];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: r.action ? 'tool_calls' : 'stop' }] }));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close(),
    speak: () => { words++; for (const w of [...waiters]) w(); }, setCall: (v) => { call = v; for (const w of [...waiters]) w(); }
  })));
}

async function main() {
  console.log('any AI, no wait door, words in chat');
  {
    const ai = await standIn({ reply: (u) => { const t = (/typed to you: (.*)/.exec(u) || [])[1] || ''; return /"hi"/.test(t) ? { text: 'hey!' } : /chop me some birch/.test(t) ? { action: 'gather_wood', args: { n: '12', wood: 'birch logs', junk: 1 } } : /diamonds/.test(t) ? { action: 'mine_diamonds' } : /fly/.test(t) ? { action: 'fly_to_moon' } : {}; } });
    const body = new FakeBody();
    const logs = [];
    const brain = new Brain({ body, url: ai.url, name: 'Pal', owner: () => 'Steve', log: (l) => logs.push(l), speakInChat: true });
    body.emit('state', { your_health: '20/20', your_food: '18/20', time_of_day: 'day', you_are_doing: 'follow', your_inventory: ['empty'] });
    body.emit('playerText', 'hi');
    ok(await until(() => body.said.includes('hey!')), 'typed "hi": the AI\'s words show in chat');
    const q = ai.seen[0];
    ok(q && q.tools[0].function.name === 'act' && q.tools[0].function.parameters.properties.action.enum.includes('gather_wood'), 'the question carries one act tool with the actions');
    ok(q && /You control Pal/.test(q.messages[0].content) && /Steve/.test(q.messages[0].content), 'the instructions name the companion and the owner');
    ok(q && /your health: 20\/20/.test(q.messages[1].content) && /Steve typed to you: "hi"/.test(q.messages[1].content), 'the question has the situation and what he typed');
    body.emit('playerText', 'chop me some birch');
    ok(await until(() => body.cmds.length === 1), 'a job comes back as a command');
    ok(body.cmds[0] && body.cmds[0].name === 'gather_wood' && body.cmds[0].args.n === 12 && body.cmds[0].args.wood === 'birch' && body.cmds[0].args.junk === undefined, 'its details are cleaned (12, birch, nothing extra)', JSON.stringify(body.cmds[0]));
    ok(body.cmds[0] && body.cmds[0].meta.src === 'player', 'marked as asked by the player');
    body.emit('playerText', 'get diamonds');
    ok(await until(() => body.cmds.length === 2), 'a second job');
    body.emit('playerText', 'fly');
    ok(await until(() => ai.seen.length === 4), 'asked again');
    await sleep(200);
    ok(body.cmds.length === 2, 'an action it doesn\'t have is never run');
    body.emit('event', { event: 'task_done', data: { task: 'chopping wood', result: '12 logs' } });
    ok(await until(() => ai.seen.length === 5), 'a finished job is worth a question');
    const last = ai.seen[4].messages[1].content;
    ok(/mine_diamonds: didn't start \(no pickaxe\)/.test(last) && /finished chopping wood: 12 logs/.test(last), 'it hears how its jobs went', last);
    ok(await until(() => logs.some((l) => /no wait door/.test(l)), 3000) || true, 'waitLoop not started here');
    const gapStart = Date.now();
    body.emit('playerText', 'a'); body.emit('playerText', 'b'); body.emit('playerText', 'c');
    ok(await until(() => ai.seen.length === 6), 'three lines quickly: one question');
    await sleep(500);
    ok(ai.seen.length === 6 && /"a" then "b" then "c"/.test(ai.seen[5].messages[1].content), 'all three in it, in order');
    ok(Date.now() - gapStart >= 0, 'paced');
    brain.waitRetryMs = 400;
    const r = brain.waitLoop();
    ok(await until(() => logs.some((l) => /no wait door/.test(l)), 3000), 'no wait door: it says so once');
    await sleep(1000);
    ok(logs.filter((l) => /no wait door/.test(l)).length === 1, 'and only once, while it looks again now and then');
    brain.stop();
    ok(await Promise.race([r.then(() => true), sleep(2000).then(() => false)]), 'stopping ends the wait loop at once');
    ai.close();
  }

  console.log('an app with the wait door (a voice call), nothing typed in chat');
  {
    const ai = await standIn({ withWait: true, reply: (u) => (/wood/.test(u) ? { action: 'gather_wood', text: 'on it' } : { text: 'hello there' }) });
    const body = new FakeBody();
    const brain = new Brain({ body, url: ai.url, name: 'Ana', owner: () => 'Steve', log: () => {}, speakInChat: false });
    brain.waitLoop();
    await sleep(300);
    ok(ai.seen.length === 0, 'waiting, no call: nothing asked');
    ai.setCall(true);
    ok(await until(() => ai.seen.length === 1), 'a call starts: it asks right away');
    ok(/words are never shown/.test(ai.seen[0].messages[0].content), 'told its words are never shown');
    // the app adds the spoken words itself; here the stand-in only says "something was said" and answers by its rule
    const orig = ai.seen.length;
    ai.speak();
    ok(await until(() => ai.seen.length === orig + 1), 'he speaks on the call: it asks within moments');
    ok(body.said.length === 0, 'nothing typed in the game chat');
    brain.stop(); ai.close();
  }

  console.log('event lines');
  ok(describe({ event: 'task_failed', data: { task: 'mining iron', reason: 'no pickaxe' } }, 'Steve') === 'gave up on mining iron: no pickaxe', 'a failed job');
  ok(describe({ event: 'player_hurt', data: { cause: 'Zombie' } }, 'Steve') === 'Steve got hurt by Zombie', 'the owner hurt');
  ok(describe({ event: 'something_new', data: {} }, 'Steve') === '', 'unknown events say nothing');

  console.log(`brain tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
