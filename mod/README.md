# Open NPC, the mod

An AI companion who lives in any Minecraft Java world, single-player included. She has her own look, follows you at a
friendly distance, comes when you call her and stays when you tell her to. You bring the AI: anything that speaks the
OpenAI-style "chat completions with tools" API.

This is the Fabric mod. The side program in the folder above (`src/`, Node and Mineflayer) is the other way to run her: as a
second player in a private world. Both ask the AI the same way.

She can follow, come and stay, chop, mine, craft, fight, pick up and hand you things, build a small house, and farm. What's in
each release: [CHANGELOG.md](CHANGELOG.md).

## Install

1. Minecraft Java Edition **26.1.2** with **Fabric Loader 0.20.1** or newer ([fabricmc.net/use](https://fabricmc.net/use)).
2. Download the newest `open-npc-<version>+mc26.1.2.jar` from the
   [Releases page](https://github.com/Gmm2510/open-npc/releases) (or build it, below).
3. Put it in the `mods` folder of that installation, with [Fabric API](https://modrinth.com/mod/fabric-api) for 26.1.2.
4. Start the game once, then set your AI's address in `config/opennpc.json` (below) and open or make a world. She shows up a
   few seconds later, a few steps behind you.

In multiplayer the server and every player need the mod.

**What leaves your PC:** the mod only talks to the AI address you set. Each question to it holds what she sees around her, what
she is doing and carrying, and what you (her owner) typed in the game chat. It sends nothing anywhere else.

## Settings

The first start writes `config/opennpc.json` in the game folder:

```json
{
  "name": "Ana",
  "owner": "",
  "speakInChat": "auto",
  "followGap": 4.0,
  "freeTimeMinutes": 4,
  "ai": { "url": "http://127.0.0.1:41751/v1", "key": "", "model": "" }
}
```

- `name`: her name in the game.
- `owner`: who she listens to (a Minecraft name). Empty: the first player in the world (you, in single-player).
- `ai.url`: the AI's address, ending in `/v1`. For example `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, or
  a model on your own PC (LM Studio, Ollama and llama.cpp all serve this API).
- `ai.key`: the API key for that address, or empty (you can also set the `NPC_AI_KEY` environment variable).
- `ai.model`: the model name. Empty: the first one the address lists.
- `speakInChat`: `auto` puts her words in the game chat unless the address has a wait door (see below), `yes` or `no` to choose.
- `followGap`: how many blocks behind you she keeps (2 to 12).
- `freeTimeMinutes`: after this long with nothing to do she asks the AI what to do on her own (0: never).

## Talking to her

Type in the game chat. She asks the AI, which answers with the `act` tool and, if it likes, a short line that shows in chat
as hers. What she can do:

- **Moving:** `follow`, `come`, `stay`, `emote` (a wave and a hop), `stop_task`.
- **Wood:** `gather_wood {n, wood}`: finds real trees (logs with natural leaves, never the logs of a build), knocks low leaves
  out of the way, chops the trunk as high as she can reach, picks up the logs, and hands them to you.
- **Mining:** `mine_stone`, `mine_coal`, `mine_iron`, `mine_gold`, `mine_diamonds {n}`: only what shows (hillsides, caves, the
  surface) at her level or above; she never digs straight down and never digs through blocks to reach something hidden. With
  no pickaxe she makes one first: chops wood, sets down a crafting table, crafts, packs the table up again (and mines stone for
  a stone pickaxe when iron needs one). Iron, gold and diamonds need an iron pickaxe, which you hand her for now (no furnace yet).
- **Crafting:** `make_tools {item}`, `craft_item {item, n}`: any crafting recipe in the game, from what she carries (logs into
  planks into sticks and so on); small ones in her hands, big ones at a table (one nearby, or her own she sets down and picks
  back up). `{who: "me"}` hands it to you.
- **Fighting:** `attack` (the nearest hostile mob), `guard` (two minutes around you); she fights back when a monster hits her.
  Never creepers up close, never endermen, never players or animals.
- **Items:** `pick_up` (what's lying around), `give_loot {item, n}` (walks over and tosses them to you; no item: everything but
  her tools). She picks up her own drops and what you toss her, never her own tosses.

- **Building:** `build_house`: a small wooden house near you (5 by 5, walls three high, two windows, a flat roof, the door on
  the side facing you, log corners when she has the logs to spare). She picks a level spot of natural ground with open sky
  (never on anything built), clears the grass and bumps, fills dips, gets the wood herself (chops, crafts planks and a door),
  builds the walls layer by layer walking round, the roof from the edges in, and hangs the door last, from outside.
- **Farming:** `farm {n}` (a field of n squares, 9 to start, up to 25): makes a wooden hoe if she has none, uses her seeds (or
  breaks grass for some), picks open grass or dirt near water if there's some close, tills and sows. `harvest`: picks the ripe
  crops around, collects them, and sows again (re-tilling a square that went back to dirt).

She tells the AI when a job starts, finishes or fails, and what she carries, so it can say how it went and choose what's next.

Commands (her owner only): `/opennpc` (how she is), `/opennpc come`, `/opennpc follow`, `/opennpc stay`, `/opennpc wave`,
`/opennpc summon` (bring her to you), `/opennpc name <name>`, `/opennpc gap <blocks>`, `/opennpc reload` (read the settings again).

### Voice apps: the wait door

She asks the AI when something happens in the game: you type to her, a job ends, she has free time. An app that hears you some
other way, like a voice call app on your PC, can serve one more address next to the AI: `GET <ai.url>/wait`.

- `GET /wait` answers right away with `{ "call": true|false, "words": <number> }`.
- `GET /wait?since=<words>&call=<0|1>&ms=<up to 30000>` answers as soon as `words` grows past `since` (you said something) or
  `call` changes, or after `ms`.

When it answers she asks the AI at once, and the app adds your words to that question. When the address has the door, she
types nothing in chat (the app speaks for her).

## How she moves

She heads for where you are now, and a little ahead of where you are going, never to where you were. She stops beside you and a
bit behind, on the side she is already on, out of the middle of your view. She only starts walking once you are properly away,
eases her speed up and down, turns smoothly, looks at you or glances around while standing, and shows up near you (behind you,
out of view) if you get far ahead or go through a portal.

## Build and test

Needs Java 25.

```bash
./gradlew build              # the mod jar in build/libs, and the in-game tests (a headless server)
./gradlew runGameTest        # just the in-game tests
./gradlew runClientGameTest  # the real game: a new world, screenshots in build/run/clientGameTest/screenshots
```

The in-game tests check that she spawns, follows to a friendly distance, keeps up with a walking player smoothly (no sudden
stops, no snapping turns, never faster than a running player), comes, stays, catches up from far away, and that answers from a
stand-in AI move her (typed in chat, and through the wait door). For the jobs: she chops a tree and hands over the logs, gets
through a bushy tree's leaves, leaves a log wall (a build) alone, mines coal she can see, crafts a pickaxe at a table she packs
up after, fights a monster, picks up and hands over items, and a job the AI asked for makes it ask again when it's done. For building
and farming: she builds a whole house on grass (crafting her own door), makes a hoe and plants a field, and harvests and
replants. The real-game test does the same in a new world: following, chat, chopping, crafting, mining and handing over,
building a house, planting a field and harvesting it. Nothing in the
tests reaches the network.

`tools/make_skin.py` draws her default skin, and `tools/make_icon.py` the mod's icon from it.

## Releases

Releases are on the repo's [Releases page](https://github.com/Gmm2510/open-npc/releases), one jar per Minecraft version. To put
out a new one: add a section for the new version to `CHANGELOG.md`, raise `mod_version` in `gradle.properties`, and push to
`main`. The GitHub job builds and tests it for every Minecraft version in `versions.json` and puts up a release for each one
whose tests pass (`tools/release.sh`, once per version; `DRY_RUN=1 bash tools/release.sh ...` shows what it would do).

## Staying up to date with Minecraft

`mod/versions.json` lists the Minecraft versions the mod is built and tested for; one code base builds for each
(`./gradlew build -Pminecraft_version=... -Ploader_version=... -Pfabric_api_version=...`).

A daily GitHub job (`.github/workflows/minecraft-update.yml`) checks Mojang's version list. When there is a new release that
Fabric supports, it builds and tests the mod for it (the headless in-game tests, then the real game with the built jar). If
everything passes, the version is added to `versions.json` and a GitHub Release with the jar goes up. If not, the attempt is kept
on a branch named `update/mc-<version>` with the error in `mod/UPDATE-FAILED.md`, and an issue is opened; the fix comes back as a
pull request. `node mod/tools/mc_update.mjs check` shows what the job would find. A manual run of the job is a dry run unless you
untick "dry run".

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
