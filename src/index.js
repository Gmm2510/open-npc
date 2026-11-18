#!/usr/bin/env node
// Starts the companion: (optionally) a private Minecraft server on this PC, the companion's body in that world, and the AI loop.
// Settings live in config.json next to this program's folder (made from config.example.json the first time).

const fs = require('fs');
const path = require('path');
const { MinecraftCompanion } = require('./minecraft/companion');
const { LocalServer, EULA_URL } = require('./minecraft/server');
const { Brain } = require('./brain');
const FEATURES = require('./features');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined; };

function loadConfig() {
  const file = path.resolve(flag('config') || path.join(ROOT, 'config.json'));
  if (!fs.existsSync(file)) {
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), file);
    console.log(`Made ${file} from the example. Change it any time; it's read when this starts.`);
  }
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, c };
}

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (who) => (line) => console.log(`[${stamp()}] [${who}] ${line}`);

async function getJson(url, key, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: ctrl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function main() {
  const { file, c } = loadConfig();
  const ai = c.ai || {};
  const url = String(flag('ai') || ai.url || 'http://127.0.0.1:41751/v1').replace(/\/+$/, '');
  const key = ai.key || process.env.NPC_AI_KEY || '';
  const npc = c.npc || {};
  const world = c.world || {};

  // Who answers at the AI address. An app on this PC with the wait door (GET <address>/wait, a voice app) speaks for the companion
  // in its own voice, so nothing is typed in chat, and its model name is the companion's name.
  const hello = await getJson(url, key);
  const models = await getJson(`${url}/models`, key);
  const door = await getJson(`${url}/wait`, key);
  const voiceApp = !!(door && typeof door.words === 'number');
  const model = ai.model || (models && models.data && models.data[0] && models.data[0].id) || '';
  const name = String(flag('name') || npc.name || (voiceApp && model ? model.charAt(0).toUpperCase() + model.slice(1) : 'Companion'));
  const speakInChat = npc.speakInChat == null ? !voiceApp : !!npc.speakInChat;
  log('ai')(`${url}: ${hello || models || door ? (voiceApp ? 'a voice app with the wait door is running' : 'answering') : 'not answering yet (it will be asked again when needed)'}${model ? `, model ${model}` : ''}`);

  // The world: a private server on this PC (offline mode, so the companion needs no account), or one you already run.
  let host = world.host || 'localhost', port = Number(world.port) || 25565;
  let server = null;
  if ((flag('local') || world.mode === 'local')) {
    const dir = path.resolve(ROOT, world.dir || 'server');
    server = new LocalServer(dir);
    server.on('log', (l) => { if (/joined the game|left the game|Done \(|ERROR|Exception|FAILED/.test(l)) log('world')(l.replace(/^\[[^\]]+\] \[[^\]]+\]: /, '')); });
    if (server.status().state === 'not_setup') {
      if (world.acceptEula !== true) {
        console.log(`\nThe private world uses Mojang's official Minecraft server, which needs you to accept the Minecraft EULA:\n  ${EULA_URL}\nIf you agree, set "acceptEula": true under "world" in ${file}, then start this again.\n`);
        process.exit(2);
      }
      log('world')(`downloading the official Minecraft ${world.version || '26.1'} server from Mojang...`);
      await server.setup({ version: world.version || '26.1', acceptEula: true });
    }
    await server.start({ difficulty: world.difficulty || 'easy', port });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The world took too long to start.')), 180000);
      const check = (st) => { if (st.state === 'running') { clearTimeout(t); resolve(); } else if (st.state === 'ready' && st.error) { clearTimeout(t); reject(new Error(st.error)); } };
      server.on('status', check); check(server.status());
    });
    log('world')(`running. In Minecraft ${server.status().version || ''}: Multiplayer, Direct Connection, localhost${port !== 25565 ? `:${port}` : ''}`);
    host = 'localhost';
  }

  const body = new MinecraftCompanion();
  body.on('log', log('body'));
  body.setFeatures(FEATURES);
  body.setFollowGap(Number(npc.followGap) || 6);
  body.setStorage(path.resolve(ROOT, npc.memoryDir || 'memory'));
  const brain = new Brain({ body, url, key, model, name, owner: () => body.opts.owner || npc.owner || '', log: log('ai'), speakInChat });

  let waiting = false;
  body.on('status', (st) => {
    log('body')(`${st.state}${st.error ? `: ${st.error}` : ''}${st.owner ? ` (owner ${st.owner})` : ''}`);
    if (st.state === 'online' && !waiting) { waiting = true; brain.waitLoop().finally(() => { waiting = false; }); }
  });
  const connect = () => body.connect({ host, port, username: name, owner: npc.owner || '', showChat: true, freeWill: npc.freeWill !== false });
  connect();
  // back in after a kick or a dropped connection
  setInterval(() => { if (body.state === 'offline' && !stopping) { log('body')('joining again...'); connect(); } }, 15000);

  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    brain.stop();
    try { body.disconnect(true); } catch {}
    if (server && server.proc) { log('world')('saving the world...'); await server.stop(); }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // typing "stop" here saves the world and closes everything
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { if (/^\s*(stop|quit|exit)\s*$/im.test(String(d))) stop(); });
  log('npc')('running. Type stop (or press Ctrl+C) to save the world and quit.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
