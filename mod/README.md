# Open NPC, the mod

An AI companion who lives in any Minecraft Java world, single-player included. She has her own look, follows you at a
friendly distance, comes when you call her and stays when you tell her to. You bring the AI: anything that speaks the
OpenAI-style "chat completions with tools" API.

This is the Fabric mod. The side program in the folder above (`src/`, Node and Mineflayer) is the other way to run her: as a
second player in a private world. Both ask the AI the same way.

**Status: step 1.** Following, coming, staying and the AI link work. Jobs (chopping, mining, crafting, fighting, handing you
things), building and farming come next.

## Install

1. Minecraft Java Edition **26.1.2** with **Fabric Loader 0.20.1** or newer ([fabricmc.net/use](https://fabricmc.net/use)).
2. Put these in the `mods` folder of that installation:
   - `open-npc-<version>.jar` (from `build/libs/` after building, or a release)
   - [Fabric API](https://modrinth.com/mod/fabric-api) for 26.1.2
3. Start the game and open or make a world. She shows up a few seconds later, a few steps behind you.

In multiplayer the server and every player need the mod.

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

Type in the game chat. She asks the AI, which answers with the `act` tool (`follow`, `come`, `stay`, `emote`, `stop_task`)
and, if it likes, a short line that shows in chat as hers.

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
stand-in AI move her (typed in chat, and through the wait door). Nothing in the tests reaches the network.

`tools/make_skin.py` draws her default skin.

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
