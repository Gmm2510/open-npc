// A private Minecraft server on this PC: downloads the official server from Mojang (after the player accepts the EULA),
// finds Java (the Minecraft Launcher installs its own) and runs a world only this PC can join, in offline mode so the
// companion needs no account.
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_URL = process.env.GG_MC_MANIFEST || 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const EULA_URL = 'https://aka.ms/MinecraftEULA';

const PROPERTIES = {
  'online-mode': 'false',
  'server-ip': '127.0.0.1',
  'server-port': '25565',
  motd: 'AI companion world',
  difficulty: 'easy',
  gamemode: 'survival',
  'spawn-protection': '0',
  'max-players': '4',
  'view-distance': '10',
  'simulation-distance': '8',
  'enable-command-block': 'false',
  'enforce-secure-profile': 'false',
  'allow-flight': 'true',

  'max-tick-time': '-1'
};

const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];
const propertiesFor = (difficulty) => (DIFFICULTIES.includes(difficulty) ? { ...PROPERTIES, difficulty } : PROPERTIES);

const WORLD_META = 'world-info.json';
function readWorldMeta(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, WORLD_META), 'utf8')) || {}; } catch { return {}; } }
function writeWorldMeta(dir, meta) { try { fs.writeFileSync(path.join(dir, WORLD_META), JSON.stringify(meta, null, 2)); } catch {} }

async function moveDir(from, to) {
  let last = null;
  for (let i = 0; i < 8; i++) {
    try { fs.renameSync(from, to); return; } catch (err) {
      last = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error(`Couldn't move the world folder (${last?.code || last?.message}). Close anything using it (Minecraft's own server, a file window) and try again.`);
}

class LocalServer extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.proc = null;
    this.state = 'unknown';
    this.error = null;
    this.progress = null;
    this.logTail = [];
    this.players = new Set();
    this.refresh();
  }

  meta() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'server-info.json'), 'utf8')); } catch { return null; }
  }

  refresh() {
    if (this.proc) return;
    const m = this.meta();
    this.state = m && fs.existsSync(path.join(this.dir, 'server.jar')) ? 'ready' : 'not_setup';
  }

  status() {
    const m = this.meta();
    let worldExists = null;
    try { worldExists = fs.existsSync(path.join(this.dir, this.levelName())); } catch {}
    return { state: this.state, error: this.error, progress: this.progress, version: m?.version || null, javaMajor: m?.javaMajor || null, java: m?.java || null, dir: this.dir, log: this.logTail.slice(-8), players: [...this.players], eulaUrl: EULA_URL, worldExists };
  }

  set(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('status', this.status());
  }

  log(line) {
    this.logTail.push(line);
    if (this.logTail.length > 60) this.logTail.shift();
    this.emit('log', line);
  }

  async setup({ version = '26.1', acceptEula = false } = {}) {
    if (!acceptEula) throw new Error('Please read and accept the Minecraft EULA first.');
    if (this.proc) throw new Error('Stop the server before setting it up again.');
    fs.mkdirSync(this.dir, { recursive: true });
    this.set('downloading');
    try {
      const manifest = await getJson(MANIFEST_URL);
      const entry = manifest.versions.find((v) => v.id === version);
      if (!entry) throw new Error(`Minecraft ${version} isn't in Mojang's version list.`);
      const vjson = await getJson(entry.url);
      const dl = vjson.downloads?.server;
      if (!dl?.url) throw new Error(`Mojang doesn't offer a server download for ${version}.`);
      const javaMajor = vjson.javaVersion?.majorVersion || 21;

      const jar = path.join(this.dir, 'server.jar');
      await download(dl.url, `${jar}.part`, dl.size, (done, total) => {
        this.progress = total ? Math.round((done / total) * 100) : null;
        this.emit('status', this.status());
      });
      const sha1 = crypto.createHash('sha1').update(fs.readFileSync(`${jar}.part`)).digest('hex');
      if (dl.sha1 && sha1 !== dl.sha1) { fs.rmSync(`${jar}.part`, { force: true }); throw new Error("The download didn't match Mojang's checksum. Try again."); }
      fs.renameSync(`${jar}.part`, jar);
      this.progress = null;

      fs.writeFileSync(path.join(this.dir, 'eula.txt'), `# Accepted by the player on ${new Date().toISOString()} (${EULA_URL})\neula=true\n`);
      writeProperties(path.join(this.dir, 'server.properties'), PROPERTIES);
      const java = await findJava(javaMajor);
      fs.writeFileSync(path.join(this.dir, 'server-info.json'), JSON.stringify({ version, javaMajor, java: java?.path || null, setupAt: new Date().toISOString() }, null, 2));
      this.set('ready', java ? null : `Java ${javaMajor} not found yet. Launch Minecraft ${version} once from the Minecraft Launcher, then press Start.`);
      return this.status();
    } catch (err) {
      this.progress = null;
      this.set('not_setup', err.message);
      throw err;
    }
  }

  async start({ difficulty, port } = {}) {
    if (this.proc) return this.status();
    const m = this.meta();
    if (!m) throw new Error('Set up the server first.');
    let java = m.java && fs.existsSync(m.java) ? { path: m.java } : await findJava(m.javaMajor || 21);
    if (!java) throw new Error(`Java ${m.javaMajor || 21} or newer wasn't found. Launch Minecraft ${m.version} once from the Minecraft Launcher (it installs its own Java), then try again.`);
    if (java.path !== m.java) fs.writeFileSync(path.join(this.dir, 'server-info.json'), JSON.stringify({ ...m, java: java.path }, null, 2));
    writeProperties(path.join(this.dir, 'server.properties'), { ...propertiesFor(difficulty), ...(Number(port) > 0 ? { 'server-port': String(Number(port)) } : {}) });

    this.logTail = [];
    this.players.clear();
    this.set('starting');
    const proc = spawn(java.path, ['-Xms1G', '-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: this.dir, windowsHide: true });
    this.proc = proc;
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        this.log(line);
        if (/Done \(.*\)! For help/.test(line)) this.set('running');
        if (/FAILED TO BIND|Address already in use/.test(line)) this.set('starting', `Port ${Number(port) || 25565} is already in use. Is another Minecraft server running?`);
        const joined = /\]: ([A-Za-z0-9_]{2,16}) joined the game/.exec(line);
        const left = /\]: ([A-Za-z0-9_]{2,16}) left the game/.exec(line);
        if (joined) { this.players.add(joined[1]); this.emit('status', this.status()); }
        if (left) { this.players.delete(left[1]); this.emit('status', this.status()); }
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => { this.proc = null; this.set('ready', `Couldn't start Java: ${err.message}`); });
    proc.on('exit', (code) => {
      this.proc = null;
      this.set('ready', code && this.state !== 'stopping' ? `The server stopped unexpectedly (code ${code}). See the log.` : null);
    });
    return this.status();
  }

  command(line) {
    const cmd = String(line || '').replace(/^\//, '').replace(/[\r\n]/g, ' ').trim().slice(0, 200);
    if (!cmd) return false;
    if (!this.proc || this.state !== 'running') throw new Error('Start the world first.');
    this.log(`> ${cmd}`);
    this.proc.stdin.write(`${cmd}\n`);
    return true;
  }

  setDifficulty(difficulty) {
    if (!DIFFICULTIES.includes(difficulty)) throw new Error(`Unknown difficulty: ${difficulty}`);
    const file = path.join(this.dir, 'server.properties');
    if (fs.existsSync(file)) writeProperties(file, { difficulty });
    if (this.proc && this.state === 'running') this.command(`difficulty ${difficulty}`);
    return this.status();
  }

  levelName() {
    try {
      const m = /^level-name=(.*)$/m.exec(fs.readFileSync(path.join(this.dir, 'server.properties'), 'utf8'));
      const n = m ? m[1].trim() : '';
      if (n && !/[\\/:*?"<>|]|\.\./.test(n)) return n;
    } catch {}
    return 'world';
  }

  backupDir() { return path.join(this.dir, 'world-backups'); }

  worlds() {
    const cur = path.join(this.dir, this.levelName());
    const saved = [];
    let names = [];
    try { names = fs.readdirSync(this.backupDir(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
    for (const name of names) {
      const meta = readWorldMeta(path.join(this.backupDir(), name));
      let savedAt = meta.savedAt || null;
      if (!savedAt) { try { savedAt = fs.statSync(path.join(this.backupDir(), name)).mtime.toISOString(); } catch {} }
      saved.push({ name, savedAt, madeAt: meta.madeAt || null, why: meta.why || null });
    }
    saved.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    return { current: { name: this.levelName(), exists: fs.existsSync(cur) }, saved };
  }

  async newWorld({ madeAt = null, why = 'new world' } = {}) {
    if (this.proc) throw new Error('Stop the world first.');
    const saved = await this._saveCurrent({ madeAt, why });
    this.emit('status', this.status());
    return { saved };
  }

  async restoreWorld(name, { madeAt = null } = {}) {
    if (this.proc) throw new Error('Stop the world first.');
    const pick = this.worlds().saved.find((w) => w.name === name);
    if (!pick) throw new Error("That saved world isn't there anymore.");
    const from = path.join(this.backupDir(), pick.name);
    const saved = await this._saveCurrent({ madeAt, why: 'swapped out' });
    await moveDir(from, path.join(this.dir, this.levelName()));
    return { restored: pick.name, saved, madeAt: pick.madeAt };
  }

  async _saveCurrent({ madeAt, why }) {
    const cur = path.join(this.dir, this.levelName());
    if (!fs.existsSync(cur)) return null;
    fs.mkdirSync(this.backupDir(), { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const base = `${this.levelName()}-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}`;
    let name = base;
    for (let i = 2; fs.existsSync(path.join(this.backupDir(), name)); i++) name = `${base}-${i}`;
    writeWorldMeta(cur, { madeAt: madeAt || null, savedAt: d.toISOString(), why });
    await moveDir(cur, path.join(this.backupDir(), name));
    return name;
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.proc) return resolve(this.status());
      const proc = this.proc;
      this.set('stopping');
      const t = setTimeout(() => { try { proc.kill(); } catch {} }, 25000);
      proc.once('exit', () => { clearTimeout(t); resolve(this.status()); });
      try { proc.stdin.write('stop\n'); } catch { proc.kill(); }
    });
  }
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't reach Mojang (${res.status}).`);
  return res.json();
}

async function download(url, file, size, onProgress) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
  const out = fs.createWriteStream(file);
  let done = 0, last = 0;
  for await (const chunk of res.body) {
    out.write(chunk);
    done += chunk.length;
    if (Date.now() - last > 250) { last = Date.now(); onProgress(done, size); }
  }
  await new Promise((r) => out.end(r));
  onProgress(done, size);
}

function writeProperties(file, wanted) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : ['#Minecraft server properties (managed by the companion)'];
  const seen = new Set();
  const out = lines.map((l) => {
    const m = /^([^#=\s][^=]*)=(.*)$/.exec(l);
    if (m && m[1] in wanted) { seen.add(m[1]); return `${m[1]}=${wanted[m[1]]}`; }
    return l;
  });
  for (const [k, v] of Object.entries(wanted)) if (!seen.has(k)) out.push(`${k}=${v}`);
  fs.writeFileSync(file, out.filter((l, i, a) => l !== '' || i < a.length - 1).join('\n') + '\n');
}

function javaVersion(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stderr) return resolve(null);
      const m = /version "(\d+)(?:\.(\d+))?/.exec(`${stderr}${stdout}`);
      if (!m) return resolve(null);
      const major = m[1] === '1' ? Number(m[2]) : Number(m[1]);
      resolve(major);
    });
  });
}

function findJavaFiles(root, depth = 6, out = []) {
  if (depth < 0 || out.length > 40) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isFile() && (e.name === 'java.exe' || e.name === 'java') && path.basename(root) === 'bin') out.push(p);
    else if (e.isDirectory() && !e.name.startsWith('.git')) findJavaFiles(p, depth - 1, out);
  }
  return out;
}

async function findJava(minMajor = 21) {
  const env = process.env;
  const roots = [];
  if (env.APPDATA) roots.push(path.join(env.APPDATA, '.minecraft', 'runtime'));
  if (env.LOCALAPPDATA) {
    const pk = path.join(env.LOCALAPPDATA, 'Packages');
    try { for (const d of fs.readdirSync(pk)) if (/^Microsoft\.4297127D64EC6/i.test(d)) roots.push(path.join(pk, d, 'LocalCache', 'Local', 'runtime')); } catch {}
  }
  for (const pf of [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean)) {
    roots.push(path.join(pf, 'Minecraft Launcher', 'runtime'));
    roots.push(path.join(pf, 'Eclipse Adoptium'));
    roots.push(path.join(pf, 'Microsoft'));
    roots.push(path.join(pf, 'Java'));
  }
  if (env.GG_JAVA_ROOTS) roots.push(...env.GG_JAVA_ROOTS.split(path.delimiter));

  const candidates = [];
  if (env.JAVA_HOME) candidates.push(path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  for (const r of roots) findJavaFiles(r, 6, candidates);
  candidates.push('java');

  let best = null;
  for (const c of [...new Set(candidates)]) {
    const major = await javaVersion(c);
    if (major && major >= minMajor && (!best || major < best.major)) best = { path: c, major };
  }
  return best;
}

module.exports = { LocalServer, findJava, writeProperties, EULA_URL, DIFFICULTIES, propertiesFor };
