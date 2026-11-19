# open-npc

An AI companion for Minecraft Java Edition that joins your world as a real player and does what you ask: chops trees, mines,
crafts, smelts, builds, farms, fights and follows you around. You bring the AI. Free and open source (MIT).

There are two ways to run it:

- **The mod** (`mod/`, Fabric, Minecraft 26.1.2): she lives in any world you open, single-player included. She follows,
  comes, stays, chops, mines, crafts, fights, hands you things, builds a small house and farms. Download it from the
  [Releases page](https://github.com/Gmm2510/open-npc/releases); how to install and set it up is in [mod/README.md](mod/README.md).
- **The side program** (this folder, Node and Mineflayer): it joins a private world on your PC as a second player and has the
  full set of jobs below.

You talk to it in the game chat ("get me 20 oak logs", "build a hut here", "come here", "mine some iron"). The AI decides what
to do; the companion's body does the work itself: it finds the trees, walks there, picks the right tool, and hands you the logs.

## What it can do

- **Gather:** wood of any kind, food, any block or item you name ("a stack of cobblestone", "5 iron").
- **Craft and smelt:** tools, armor for both of you, anything with a recipe; it can show you a recipe while it crafts one.
- **Mine:** ore veins, dig down to a level, strip mine, tunnels.
- **Build:** huts and small houses in a few styles, towers, walls, floors, stairs, paths, bridges, doors, farms; it can help with
  what you are building and undo its last build.
- **Fight and protect:** fights hostile mobs, guards you, falls back to you. It never hits players (except a friendly spar you ask for).
- **Move:** follows you, comes when called, waits, goes where you look, remembers named places and leads you back to them.
- **Little games:** races, timed gathering, sparring.
- **Careful in your world:** it does not break blocks you placed and does not dig near your builds.

## What you need

- Minecraft Java Edition (the game you already play).
- [Node.js](https://nodejs.org) 20 or newer.
- An AI that speaks the OpenAI-style "chat completions" API with tool calls. Any of these work: OpenAI, OpenRouter, a model on
  your own PC (LM Studio, Ollama and llama.cpp all offer this API), or an app on your PC that serves it.

## Start

```bash
npm install
npm start
```

The first start makes `config.json`. Open it and set:

- `ai.url`: the AI's address, ending in `/v1` (for example `https://api.openai.com/v1` or `http://localhost:11434/v1`).
- `ai.key`: your API key for that address (leave it empty for a local model). You can also set it in the `NPC_AI_KEY` environment variable instead.
- `ai.model`: the model name (for example `gpt-4.1-mini`).
- `npc.name`: the companion's name in the game (3 to 16 letters, digits or `_`).
- `npc.owner`: your Minecraft name, so it knows who to listen to (empty: the first player who joins).

### The world

By default it runs a private world on your PC (`world.mode: "local"`), using Mojang's official Minecraft server. That server needs
you to accept the [Minecraft EULA](https://aka.ms/MinecraftEULA): if you agree, set `world.acceptEula` to `true`. The first start
downloads the server from Mojang and makes the world.

Then, in Minecraft, pick the same version (`world.version`, 26.1 by default) in the launcher, and go to
**Multiplayer, Direct Connection, `localhost`**. The companion joins with you.

Because the companion has no Minecraft account of its own, the world runs in offline mode and only accepts players from this PC.
To use a server you already run instead, set `world.mode` to `"join"` and `world.host` / `world.port`; that server has to allow
offline players. Only do that on a server you own.

Type `stop` in the window (or press Ctrl+C) to save the world and quit.

## Talking to it another way (voice)

The companion asks its AI when something happens in the game: you type to it, a job finishes, it has free time. An app that hears
you some other way, like a voice call app on your PC, can serve one more address next to the AI: `GET <ai.url>/wait`.

- `GET /wait` answers right away with `{ "call": true|false, "words": <number> }`.
- `GET /wait?since=<words>&call=<0|1>&ms=<up to 30000>` answers as soon as `words` grows past `since` (the player said something)
  or `call` changes, or after `ms`.

When it answers, the companion asks the AI at once, and the app adds the player's words to that question. If the address has no
`/wait`, the companion simply doesn't use it.

## How it asks the AI

One question at a time, at most one every couple of seconds. Each question has short instructions, the companion's situation
(health, food, time, what it carries, what it is doing, how its last jobs went, what just happened) and what you typed. The AI
answers with the `act` tool (`{ "action": "gather_wood", "args": { "n": 10, "wood": "birch" } }`), plain words for the chat, or
nothing. The details are checked and capped before the body sees them, and an action it doesn't have is never run.

## Tests

```bash
npm test
```

## License

MIT, see `LICENSE`. Built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) and its plugins (MIT).

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
