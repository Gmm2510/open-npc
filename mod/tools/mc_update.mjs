#!/usr/bin/env node
// Keeps Open NPC up with Minecraft. Used by the daily GitHub job (.github/workflows/minecraft-update.yml) and by whoever fixes
// a failed update. No packages needed (Node 20+).
//
//   node mod/tools/mc_update.mjs check            what's new: the newest Minecraft release, and whether Fabric supports it yet
//   node mod/tools/mc_update.mjs matrix           the versions this mod supports, as a GitHub Actions build list
//   node mod/tools/mc_update.mjs add <mc> <loader> <fabric_api>   add a version to mod/versions.json (marked for a release)
//
// mod/versions.json lists every Minecraft version the mod is built and tested for. The first one is the main version (the one
// in gradle.properties); the others are built from the same code with the versions passed to Gradle (-Pminecraft_version=...).
// "release": true means the daily job added it and publishes a GitHub Release for it once its tests pass.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOD = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(MOD, 'versions.json');
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const LOADERS = (mc) => `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`;
const API_META = 'https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml';

const read = () => JSON.parse(readFileSync(FILE, 'utf8'));
const get = async (url, as = 'json') => {
  const r = await fetch(url, { headers: { 'User-Agent': 'open-npc-update-check' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return as === 'json' ? r.json() : r.text();
};
// GitHub Actions outputs (when run there), and one JSON line on stdout either way
function out(obj) {
  if (process.env.GITHUB_OUTPUT) for (const [k, v] of Object.entries(obj)) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
  console.log(JSON.stringify(obj));
}

// The newest Fabric API build for a Minecraft version ("0.166.2+26.3"), or '' when there is none yet.
export function newestFabricApi(xml, mc) {
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).filter((v) => v.endsWith(`+${mc}`));
  return all.length ? all[all.length - 1] : '';
}

async function check() {
  const supported = read().versions.map((v) => v.minecraft);
  const manifest = await get(MANIFEST);
  const latest = manifest.latest.release;
  if (supported.includes(latest)) return out({ latest, new: '', ready: 'false', reason: `${latest} is already supported` });
  const loaders = await get(LOADERS(latest));
  const loader = (loaders.find((l) => l.loader && l.loader.stable) || loaders[0] || {}).loader;
  const api = newestFabricApi(await get(API_META, 'text'), latest);
  if (!loader || !api) return out({ latest, new: latest, ready: 'false', loader: loader ? loader.version : '', fabric_api: api, reason: `Fabric doesn't support ${latest} yet` });
  out({ latest, new: latest, ready: 'true', loader: loader.version, fabric_api: api, reason: `${latest} is new and Fabric supports it` });
}

function matrix() {
  const v = read().versions;
  out({ matrix: { include: v.map((x, i) => ({ ...x, main: i === 0, release: !!x.release })) } });
}

function add(mc, loader, api) {
  if (!mc || !loader || !api) { console.error('usage: mc_update.mjs add <minecraft> <loader> <fabric_api>'); process.exit(2); }
  const j = read();
  if (!j.versions.some((v) => v.minecraft === mc)) j.versions.push({ minecraft: mc, loader, fabric_api: api, release: true });
  writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n');
  out({ added: mc });
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'check') check().catch((e) => { console.error(e.message); process.exit(1); });
else if (cmd === 'matrix') matrix();
else if (cmd === 'add') add(...args);
else if (cmd !== undefined) { console.error('commands: check, matrix, add'); process.exit(2); }
