# PROGRESS.md

Living status file for **Emberhold**. Update at the end of every phase.
Design source of truth: [`docs/GAME_SPEC.md`](docs/GAME_SPEC.md).

---

## Architecture (restated in 10 lines)

1. **One rules core.** `packages/sim-core` holds every game rule in pure TypeScript — no DOM, no Node APIs, no `Date.now()`, no `Math.random` — so the client, the server, replays, the AI and the tests all agree by construction.
2. **Determinism by contract.** Battles run on a fixed 20 Hz tick with integer/fixed-point math, a seeded PRNG, and stable entity ordering; identical inputs must produce byte-identical results.
3. **Server authority.** The client may predict but never decides; every mutation is a validated command replayed through sim-core on the server, which owns the only clock.
4. **Data-driven balance.** Costs, times, stats and unlock tables live in `packages/game-data` and are generated from curves by script; logic never hard-codes a number.
5. **Shared protocol.** `packages/protocol` defines the wire types so client and server cannot drift apart.
6. **Client.** Phaser 3 + Vite in `apps/client` (browser first, Capacitor later); square logic grid, isometric 2:1 rendering, placeholder art until real assets land.
7. **Server.** Node + Fastify in `apps/server`, with PostgreSQL for durable state and Redis for matchmaking pools, locks and leaderboards.
8. **Async PvP.** Attackers raid a frozen snapshot of a defender's base; the server re-simulates the deployment log and settles loot/trophies/shields in one transaction.
9. **Tooling.** `apps/tools` hosts the base editor, replay CLI, balance simulator and load tester, all driving the same sim-core.
10. **Milestones.** M1 offline single-player (Phases 0–6) → M2 cloud save (7) → M3 async PvP + tutorial (8–9) → M4 social (10–12) → M5 launch-ready (13–17).

## Milestones

| Milestone | Phases | Goal                                                        | Status         |
| --------- | ------ | ----------------------------------------------------------- | -------------- |
| M1        | 0–6    | Offline single-player: build, collect, train, raid AI bases | 🟡 In progress |
| M2        | 7      | Accounts, cloud save, server-authoritative economy          | ⚪ Not started |
| M3        | 8–9    | Async PvP, loot, trophies, shields, replays, tutorial       | ⚪ Not started |
| M4        | 10–12  | Clans, donations, clan wars, leagues/seasons                | ⚪ Not started |
| M5        | 13–17  | Heroes, monetization, anti-cheat, analytics, packaging      | ⚪ Not started |

## Phase status

| Phase | Title                                | Status         |
| ----- | ------------------------------------ | -------------- |
| 0     | Bootstrap & tooling                  | ✅ Complete    |
| 1     | Sim-core foundations                 | ✅ Complete    |
| 2     | Economy & construction               | ⚪ Not started |
| 3     | Client: Village scene & building UX  | ⚪ Not started |
| 4     | Army, spells, laboratory             | ⚪ Not started |
| 5     | Battle simulator (headless)          | ⚪ Not started |
| 6     | Battle client, replays, campaign     | ⚪ Not started |
| 7     | Backend foundation & cloud save      | ⚪ Not started |
| 8     | Asynchronous PvP                     | ⚪ Not started |
| 9     | Onboarding, achievements, notifs     | ⚪ Not started |
| 10–17 | Social, heroes, monetization, launch | ⚪ Not started |

---

## Phase 0 — Bootstrap & tooling

**Goal:** a clean, testable monorepo with a running client shell.

### What was built

- pnpm workspace: `packages/{sim-core,game-data,protocol}` + `apps/{client,server,tools}`.
- TypeScript strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, …) via a shared `tsconfig.base.json`; `paths` aliases mirrored in `apps/client/vite.config.ts` and locked together by `test/config.test.ts`.
- ESLint 9 flat config + Prettier + Vitest, wired into root scripts: `dev`, `dev:client`, `dev:server`, `test`, `test:watch`, `typecheck`, `lint`, `build`, `verify`.
- GitHub Actions CI (`.github/workflows/ci.yml`): install → lint → typecheck → test → build on every push/PR.
- Client: Vite + Phaser 3 boot scene rendering the 48×48 map as an isometric grid (40×40 buildable core + 4-tile margin), with mouse-drag pan, wheel zoom, two-finger pinch zoom, keyboard pan/zoom, tile picking, a clamped camera transform and a DOM HUD with an FPS counter.
- Camera maths extracted into a Phaser-free `cameraTransform.ts` module so pan/zoom clamping and the zoom anchor are unit tested; this caught a real bug (the vertical pan clamp used half the world height, so the map could not be panned to the bottom).
- Server: minimal Fastify skeleton (`/health`, `/version`, `/world`) with env config, structured logging and CORS, importing the same sim-core as the client.
- Tools: `tools info` CLI printing the version stamps and grid geometry.

### How to run

```bash
pnpm install          # once
pnpm dev              # client (http://localhost:5173) + server (http://localhost:8080)
pnpm dev:client       # client only
pnpm dev:server       # server only
pnpm test             # unit tests
pnpm verify           # lint + typecheck + test
pnpm build            # emit dist/ for packages + production client bundle
```

### Test results

- `pnpm test`: **6 files, 29 tests, all passing** (sim-core grid invariants, game-data resources, protocol/health responses, iso projection round-trip, camera pan/zoom maths incl. the zoom anchor invariant, alias drift guard).
- `pnpm lint`: clean.
- `pnpm typecheck`: clean (strict mode).
- `pnpm build`: clean — `packages/*` emit `dist/`, `apps/client` produces a production bundle.

### Known gaps

- No game content yet: sim-core only carries the grid geometry and version stamps.
- No Playwright smoke test (browser binaries are not available in this environment); the client was verified via the dev server and a production build instead.
- `apps/server` has no persistence, auth or command API (Phase 7).

### Suggested next step

**Phase 1 — Sim-core foundations:** fixed-point math, seeded PRNG, occupancy grid, player-state types, the config loader with Zod validation, the `applyCommand` pipeline, and stable serialization + `hashState()`.

---

## Phase 1 — Sim-core foundations (plan, written before coding)

**Goal:** the deterministic skeleton every later rule hangs on.

### Files to add / change

`packages/sim-core/`

- `src/math/index.ts` — fixed-point constants and integer-only maths (`FIXED_ONE`, `fixedMul`, `fixedDiv`, `isqrt`, `hypotFixed`, `clamp`, `roundToNearest`)
- `src/rng/index.ts` — seeded mulberry32 as a **pure** `(state) -> [value, newState]` API with `serializeRng`/`deserializeRng`
- `src/grid/index.ts` — `OccupancyGrid` (Int32Array cells), rect overlap, bounds/margin/free checks
- `src/config/types.ts` — `GameConfig`, `BuildingDef`, `BuildingLevel`, `ObstacleDef`, `StarterConfig` (Section 8.1 verbatim)
- `src/validate/index.ts` — Zod schemas + `validateGameConfig()` that throws a loud, multi-issue `ConfigValidationError`
- `src/state/index.ts` — `PlayerState` (Section 8.2 verbatim) + `createNewPlayerState()` driven entirely by config
- `src/state/clone.ts` — dependency-free deep clone of plain state data
- `src/commands/index.ts` — `applyCommand(state, command, ctx)` returning `ok + events` or `error + code`; `PlaceBuilding`, `MoveBuilding`, `RemoveObstacle`
- `src/serialize/index.ts` — `stableStringify()`, `hashString()`, `hashState()`
- `src/index.ts` — public barrel

`packages/game-data/`

- `data/buildings.json`, `data/obstacles.json`, `data/starter.json` — hand-authored starting tables (Keep, Gold Mine, Essence Well, Gold/Essence Store, Wall + tree/rock)
- `src/index.ts` — re-export raw JSON and expose `loadGameConfig()` which validates through sim-core

### Tests to add

- `math`: `isqrt` exactness over a large range + against `Math.sqrt`, `fixedMul`/`fixedDiv` rounding, `hypotFixed`
- `rng`: 1,000,000 draws identical across two runs, different seeds diverge, serialize/deserialize mid-stream, range helpers
- `grid`: out of bounds, margin, overlap, exact-fit edges, `moving onto itself`, walls adjacent
- `state`: starter resources/builder count/layout from config, `keepLevel` invariant, JSON round-trip
- `commands`: every placement rejection reason, successful place/move/remove, reward events, purity (input state untouched)
- `serialize`: stable key ordering, round-trip, identical `hashState()` for an identical command list
- `game-data`: config validates, invalid config rejected loudly

### Out of scope (later phases)

Costs, timers, builders, catch-up, training, battles — Phases 2 and 5.

---

## Phase 1 — Sim-core foundations (report)

**Goal:** the deterministic skeleton every later rule hangs on.

### What changed

**`packages/sim-core`** — split from one file into focused modules, all pure and
clock-free:

- `src/math/index.ts` — `FIXED_ONE` (1000 = 1.0 in 10.3 fixed point), `fixedMul`, `fixedDiv`,
  `isqrt` (exact for every value up to `Number.MAX_SAFE_INTEGER`), `hypotFixed`, `clamp`,
  `roundToNearest`.
- `src/rng/index.ts` — mulberry32 as a **pure** `(state) -> [value, newState]` API, so a battle's
  RNG can be snapshotted and replayed. `deriveSeed(...parts)` (FNV-1a) keys a battle without any
  wall-clock input. `serializeRng`/`deserializeRng` are exact inverses.
- `src/grid/index.ts` — `OccupancyGrid` over an `Int32Array`, with `set`/`clear`/`isFree`,
  `canPlace`, `findConflict` (bounds → margin → occupancy, in that order so error messages are
  deterministic) and `toIds()` for serialization.
- `src/config/geometry.ts` — `GRID` (48 total / 40 buildable / 4 margin), `assertValidGeometry`,
  `isMapTile`, `isBuildableTile`.
- `src/config/types.ts` — `GameConfig`, `BuildingDef`, `BuildingLevel`, `ObstacleDef`,
  `StarterConfig`.
- `src/validate/index.ts` — Zod 4 schemas plus semantic rules that Zod cannot express
  (non-empty ids, unique ids, positive levels, unlock Keep ≤ own level at level 1, `requiresKeep`
  non-decreasing across levels, geometry consistency). Failures throw a
  `ConfigValidationError` listing **every** problem, each with the offending path and value.
- `src/state/index.ts` + `src/state/clone.ts` — `PlayerState` (spec §8.2) and
  `createNewPlayerState(config, now)`, driven entirely by config. The clone is hand-written
  because `structuredClone` is unavailable under this tsconfig's `lib`/`types` settings.
- `src/commands/index.ts` — `applyCommand(state, command, ctx)` → `{ ok: true, state, events }` or
  `{ ok: false, error }`. Never mutates its input. Implements `PlaceBuilding`, `MoveBuilding`
  (which frees the building's own footprint first, so a building may be "moved" onto its current
  tile) and `RemoveObstacle` (reward is a stub pending Phase 4).
- `src/serialize/index.ts` — `stableStringify` (sorted keys, `-0` → `0`, non-finite → `null`,
  circular/bigint/function/symbol rejected), `stableParse`, `hashString` (FNV-1a → base36),
  `hashState`.
- `src/index.ts` — public barrel.

**`packages/game-data`** — `data/buildings.json` (Keep, Gold Mine, Essence Well, Gold Store,
Essence Store, Wall — arrays, not id-keyed objects), `data/obstacles.json` (tree, rock),
`data/starter.json` (1000/1000/0/50, 2 builders, Keep L1 at 18,18, one mine and one well,
7 obstacles). `src/index.ts` re-exports the raw JSON and exposes `loadGameConfig()`, which
validates through sim-core **at import time** so a bad table fails loudly on boot.
`src/version.ts` is a dependency-free `CONFIG_VERSION` module behind a `./version` subpath, so the
client can stamp the config version without pulling Zod into its bundle.

**Config/tooling** — `@coc/game-data/version` added to `tsconfig.base.json` paths and the Vite
aliases; `@coc/game-data` added to the client's dependencies; `sideEffects: false` on the three
library packages so tree-shaking keeps Zod out of the browser bundle (verified: the production
client bundle is unchanged from Phase 0 at 1,217.90 kB / 335.73 kB gzipped); coverage thresholds
in `vitest.config.ts` raised from 0 to 90/85/90/90; `packages/protocol/test/protocol.test.ts`
added, closing the one Phase 0 gap.

### How to run / verify

```bash
pnpm verify          # lint + typecheck + 203 tests
pnpm test:coverage   # same tests + the v8 coverage report
pnpm bench           # determinism + throughput benchmark (see below)
```

### Test results

- `pnpm test`: **15 files, 203 tests, all passing** (Phase 0: 6/29; Phase 1 adds 9 files and
  174 tests).
- `pnpm lint`: clean. `pnpm typecheck`: clean, 6 projects, strict mode.
- `pnpm build`: clean, all 5 projects; the client production bundle is 1,217.90 kB
  (335.73 kB gzipped) — **identical to Phase 0**, i.e. none of sim-core's Zod-based validator
  leaked into the browser build.
- `pnpm test:coverage` (sim-core, thresholds now 90/85/90/90):

  | Metric     | Result | Threshold |
  | ---------- | ------ | --------- |
  | Statements | 99.26% | 90%       |
  | Branches   | 93.35% | 85%       |
  | Functions  | 100%   | 90%       |
  | Lines      | 99.26% | 90%       |

  The uncovered lines are defensive unreachable guards (a `not_found` re-check after cloning,
  `keepLevel` fallback when a state has no Keep, duplicate-obstacle-id reporting).

### Benchmark (`pnpm bench`)

| Measurement                                    | Result                       |
| ---------------------------------------------- | ---------------------------- |
| RNG: 1,000,000 draws                           | ~31 ms (checksum 3856587346) |
| RNG: state round-trips exactly                 | true                         |
| RNG: resumed stream matches the original       | true                         |
| Commands: 250 openings × 4 commands (1000 ops) | ~45 ms (≈0.045 ms/op)        |
| Commands: hash stable across repeats           | true (`fb5a3f0d6ef30c08`)    |
| State: 10,000 deep clones                      | ~13 ms                       |

The RNG round-trip check found a **real bug** during the phase: the internal state was stored as a
signed `int32` (`| 0`) but serialized unsigned (`>>> 0`), so a battle resumed from a snapshot would
have diverged from the original. The state is now unsigned throughout; the drawn values are
unchanged (no golden checksum moved), and `test/rng.test.ts` now has regression tests that drive
the generator past the sign boundary and prove the round-trip.

### Known gaps

- `RemoveObstacle` grants a fixed stub reward and does not touch the economy; costs, builder
  time, timers and catch-up are Phase 2.
- `PlaceBuilding` does not yet check resources, builder availability or level — Phase 2.
- No transport/session layer: `applyCommand` is the whole contract; the wire protocol is Phase 7.
- The balance tables are hand-authored, not curve-generated. The generator is deferred until the
  curve parameters exist (Phase 4+); nothing in the code assumes generated data.
- `apps/server` still has no command endpoint (Phase 7).

### "Done when" checklist

| Criterion                                                                                | Status           |
| ---------------------------------------------------------------------------------------- | ---------------- |
| Fixed-point math + integer sqrt/hypot                                                    | ✅ pass          |
| Seeded PRNG with serializable state                                                      | ✅ pass          |
| Occupancy map with footprint checks                                                      | ✅ pass          |
| State types per spec §8.2 + `createNewPlayerState()`                                     | ✅ pass          |
| Config loader with loud Zod validation                                                   | ✅ pass          |
| Initial configs: Keep, Gold Mine, Essence Well, Stores, Wall, obstacles                  | ✅ pass          |
| `applyCommand` returning `ok + events` / `error + code`                                  | ✅ pass          |
| `PlaceBuilding`, `MoveBuilding`, `RemoveObstacle` (stub reward)                          | ✅ pass          |
| Stable sorted-key JSON serialization + `hashState()`                                     | ✅ pass          |
| Placement tests: bounds / overlap / margin / exact-fit / move-onto-self / walls adjacent | ✅ pass          |
| RNG determinism across 1,000,000 draws                                                   | ✅ pass          |
| Serialization round-trip tests                                                           | ✅ pass          |
| Invalid-config rejection tests                                                           | ✅ pass          |
| ≥90% line coverage on state/grid/commands                                                | ✅ pass (99.26%) |
| Identical `hashState()` for a repeated command list                                      | ✅ pass          |
