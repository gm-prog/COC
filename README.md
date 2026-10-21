# Emberhold

An original base-builder & asynchronous raid game — build a fortified settlement,
grow an army, and raid other players' villages while they are away, then watch
the replay of how they raided yours.

This repository is a **vertical slice → online MVP**, built phase by phase from
[`docs/GAME_SPEC.md`](docs/GAME_SPEC.md). It is a from-scratch original design:
all names, art direction and numbers here are ours.

> **Status:** Phases 0–2 complete (tooling, sim-core foundations, economy and construction).
> **Phase 3 — village scene and building UX — is in progress.** Rendering, selection, the build
> shop, placement, moving an existing building, clearing trees and rocks for their reward,
> collection, upgrades and local IndexedDB persistence work in the browser; drag-to-place walls
> and the remaining upgrade-panel controls are still outstanding.
> Current milestone: **M1 — offline single-player**.

## Quick start

```bash
pnpm install          # install the workspace (Node 20.19+ / 22 LTS recommended)
pnpm dev              # client on http://localhost:5173 + API on http://localhost:8080
```

Then open <http://localhost:5173>. You should see the 48×48 map drawn as an
isometric grid: the dark outer band is the 4-tile decorative margin, the lighter
square is the 40×40 buildable area.

**Controls:** drag to pan · scroll or pinch to zoom · arrow keys to pan ·
`+` / `-` to zoom · `0` to recentre · click a tile to inspect it · select a
building and press **Move** to rearrange it (Escape or **Cancel** aborts).

## Commands

| Command                               | What it does                                             |
| ------------------------------------- | -------------------------------------------------------- |
| `pnpm dev`                            | Client + API server in parallel                          |
| `pnpm dev:client`                     | Vite dev server only                                     |
| `pnpm dev:server`                     | Fastify API only (tsx watch)                             |
| `pnpm test`                           | Unit tests (Vitest)                                      |
| `pnpm test:watch`                     | Unit tests in watch mode                                 |
| `pnpm test:e2e`                       | Browser smoke test (Playwright + Chromium)               |
| `pnpm typecheck`                      | `tsc --noEmit` in every workspace project                |
| `pnpm lint`                           | ESLint across the repo                                   |
| `pnpm format`                         | Prettier write                                           |
| `pnpm build`                          | Emit `dist/` for packages + a production client bundle   |
| `pnpm verify`                         | `lint` + `typecheck` + `test` (the unit-test half of CI) |
| `pnpm --filter @coc/tools start info` | Print version stamps and grid geometry                   |

## Browser smoke test

Phase 3 ships one end-to-end test in `e2e/`: it loads a new village in a real
Chromium page, opens the build shop, places a Gold Mine on a tile whose
coordinates come from the client's own isometric helpers, advances **simulated**
time with Playwright's clock until the build finishes, waits for gold to
accumulate, collects it through the HUD button, and starts an upgrade. No mocks,
no direct state access, no real sleeps.

```bash
pnpm exec playwright install chromium   # once per machine
pnpm test:e2e                           # starts Vite on :5173 via webServer
```

The HTML report is written to `playwright-report/`; traces, screenshots and video
are kept only for failing runs under `test-results/`. Both are git-ignored and CI
uploads them when the job fails.

A second test in the same file reloads the page and checks that the village comes
back, which is what proves persistence end to end.

## Saving

The village is stored in IndexedDB — database `emberhold`, object store
`village`, key `current` — and restored when the game loads.

- **When.** After every accepted command (placement, collection, upgrade start)
  and whenever a construction or upgrade completes. Not on every frame:
  production that merely accrues is derived from each collector's
  `lastAccruedAt`, so a reload recomputes exactly what was earned instead of
  replaying or duplicating it.
- **How.** Writes are debounced and serialized: at most one write is in flight,
  and the newest state always wins. A best-effort flush runs when the page is
  hidden, but durability does not depend on it. A failed write is retried on a
  capped backoff (2 s doubling to 60 s) rather than waiting for the next
  unrelated change, so a snapshot is never left pending with nothing scheduled.
- **Format.** The record is versioned by `schemaVersion` (currently `2`),
  independently of the IndexedDB database version, and carries the
  `configVersion` it was written against. A `revision` is incremented on every
  write. A version-1 record is migrated in memory to version 2 and written back
  with revision 1 on the next save; the v1 value itself is never rewritten in
  place under the old version number.
- **Two tabs.** Each write is a compare-and-swap: inside one read-write
  transaction the stored revision is read and the next record is written, with
  no interleaving possible. A tab whose expected revision no longer matches is
  refused instead of overwriting the other tab's progress. It reports a conflict
  (not a storage failure), stops saving, and the HUD goes read-only with a
  warning telling the player to reload and continue from the newer save. Two
  tabs opening an empty database cannot both create a village; only the first
  write succeeds.
- **Failures.** A record that is malformed, newer than this build, or from
  another config is left untouched: the game starts a fresh village in memory
  with saving disabled and shows a short HUD notice. Recovery is possible with a
  newer build; nothing overwrites a save it could not read. A stored `null` is
  treated as a malformed record, not as an empty slot: only a missing key starts
  a new player.
- **Clock skew.** If the device clock is behind the saved village's
  `lastSyncAt`, the session is **read-only**: the saved village is shown as-is,
  saving is off, and a HUD warning explains that actions are unavailable until
  the clock is corrected and the game reloaded. Viewing, selection, panning and
  zooming still work. The record is not rewritten and no timestamps are
  fabricated to get past the engine's monotonic-time rule.

## Repository layout

```
docs/GAME_SPEC.md     the design document (source of truth)
PROGRESS.md           what is done, what is next
DECISIONS.md          deviations from the spec and why
ASSETS.md             external asset ledger (source + licence)
THIRD_PARTY.md        library and font licence ledger

packages/
  sim-core/           deterministic rules core (pure TS, no DOM/Node/clock/random)
  game-data/          balance tables + generator scripts
  protocol/           shared HTTP/WebSocket wire types

apps/
  client/             Phaser 3 + Vite game client
  server/             Fastify API
  tools/              developer CLI (base editor, replay, balance sim)

.github/workflows/    CI: lint, typecheck, test, coverage, build, browser smoke test
e2e/                  Playwright browser smoke test (Phase 3)
playwright.config.ts  Playwright config: Chromium, fixed viewport, Vite webServer
```

## Architecture in one paragraph

Every game rule lives in `packages/sim-core` — a pure, deterministic TypeScript
module with no DOM, no Node APIs, no `Date.now()` and no `Math.random()`. The
client uses it for placement validation, prediction and replay playback; the
server uses the **same** module to validate commands and re-simulate battles, so
the two can never disagree. Balance numbers live in `packages/game-data` and are
generated from curves, never hard-coded in logic. The client may predict, but the
server is the only authority.

## Documentation

- [`docs/GAME_SPEC.md`](docs/GAME_SPEC.md) — full design, architecture and the
  18-phase plan.
- [`PROGRESS.md`](PROGRESS.md) — phase-by-phase status and reports.
- [`DECISIONS.md`](DECISIONS.md) — deviations and judgement calls.

## Legal / IP

This is an original game built from genre conventions, not a clone: no names,
art, sounds, UI skins or map layouts are taken from any existing product. See
[`ASSETS.md`](ASSETS.md) and [`THIRD_PARTY.md`](THIRD_PARTY.md) for provenance.
Get proper legal advice before any commercial release.
