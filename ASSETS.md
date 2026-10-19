# ASSETS.md

Ledger of every **external** art/audio/font asset used by Emberhold, with its
source and licence (design spec §4). Anything not listed here was created for
this project and is ours.

Rule: no asset enters the repo without a row in this table. Placeholder art
(flat coloured shapes generated in code) needs no entry — it is not external.

| File / pack | Used for | Source | Licence | Added      |
| ----------- | -------- | ------ | ------- | ---------- |
| _none yet_  |          |        |         | 2026-10-19 |

## Placeholder art (Phase 0)

All Phase 0 visuals are drawn procedurally with Phaser `Graphics` calls in
`apps/client/src/scenes/BootScene.ts` (flat coloured parallelograms and grid
lines). No image, sprite, font or audio file is loaded.

## Planned sources

- CC0 / CC-BY sprite packs for buildings and troops (Phase 3 art swap).
- Original generated art for anything the design names specifically (Keep,
  Axeman, Brute, Sapper, Balloon-class air units, …).
- System fonts only, until a licensed display font is chosen.
