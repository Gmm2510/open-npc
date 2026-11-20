# Changelog

Each release of the mod, newest first. A release is built and tested for every Minecraft version in `versions.json`; the jar's
name says which one it is for (`open-npc-<version>+mc<minecraft>.jar`).

## 0.3.1

- **A voice app can name her.** An app with the wait door can say her name, and she takes it in the game and in her instructions,
  changing it the moment you pick another companion there. The new setting `useAppName` (on to start) allows it; `/opennpc name`
  turns it off so a name you give her stays. Names can use any language's letters now.

## 0.3.0

The first release. She is early: try her in a world you don't mind her changing.

- **A companion in any world**, single-player included: her own look, a name you choose (Ana to start), follows you at a friendly
  distance, comes when called, stays when told, comes back if she's lost or knocked out, and follows you through portals.
- **Your own AI**: any address that speaks the OpenAI-style chat completions API with tools (OpenAI, OpenRouter, or a model on
  your own PC). She asks it when you type to her, when a job ends and when she has free time. A voice app on your PC can talk to
  her through the wait door.
- **Jobs**: chops real trees and hands you the logs, mines stone, coal, iron, gold and diamonds she can see, crafts anything with
  a crafting recipe (setting down her own table and packing it up after), fights monsters near you, picks things up and hands them
  over.
- **Building**: a small wooden house near you with a door, two windows and a flat roof, from wood she gets herself.
- **Farming**: makes a hoe, plants a field near water, harvests it and sows it again.
- Not yet: smelting (so iron tools come from you), torches, glass windows, other house shapes.
