// Prints the release notes for one release: the CHANGELOG.md section for the mod version, then how to install it.
//   node tools/release_notes.mjs <mod version> <minecraft> <loader> <fabric api> [automatic]
import { readFileSync } from 'node:fs';

const [modVersion, mc, loader, api, automatic] = process.argv.slice(2);
if (!api) { console.error('usage: release_notes.mjs <mod version> <minecraft> <loader> <fabric api> [automatic]'); process.exit(2); }

const log = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const at = log.indexOf(`\n## ${modVersion}\n`);
if (at < 0) { console.error(`CHANGELOG.md has no "## ${modVersion}" section`); process.exit(1); }
const rest = log.slice(at + 1);
const next = rest.indexOf('\n## ', 4);
const section = (next < 0 ? rest : rest.slice(0, next)).split('\n').slice(1).join('\n').trim();

console.log(`${automatic ? `Built and tested automatically for Minecraft ${mc}.\n\n` : ''}${section}

## Install

1. Minecraft Java Edition **${mc}** with **Fabric Loader ${loader}** or newer ([fabricmc.net/use](https://fabricmc.net/use)).
2. Put two jars in that installation's \`mods\` folder: \`open-npc-${modVersion}+mc${mc}.jar\` (below) and
   [Fabric API](https://modrinth.com/mod/fabric-api) ${api} or newer for ${mc}.
3. Start the game once, then set your AI's address in \`config/opennpc.json\` (see the
   [mod's README](https://github.com/Gmm2510/open-npc/blob/main/mod/README.md#settings)).

She only talks to the AI address you set: she sends it what she sees around her, what she is doing, and what you type in the
game chat. In multiplayer the server and every player need the mod.`);
