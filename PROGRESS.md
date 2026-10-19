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

Phase 3 is underway. Shipped slices render/select starter buildings and obstacles, show
resource totals/storage caps and builder countdowns, and provide a config-driven build shop with
green/red placement previews that commit through sim-core construction rules. The current slice adds tap-to-collect with storage-overflow feedback and previews/starts
building upgrades through sim-core. Move controls, obstacle-removal UX, IndexedDB persistence, and a
browser end-to-end smoke test remain outstanding.

| Phase | Title                                | Status         |
| ----- | ------------------------------------ | -------------- |
| 0     | Bootstrap & tooling                  | ✅ Complete    |
| 1     | Sim-core foundations                 | ✅ Complete    |
| 2     | Economy & construction               | ✅ Complete    |
| 3     | Client: Village scene & building UX  | 🟡 In progress |
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

---

## Recon note · sandbox reset (2026-10-19)

The checkout arrived with the local branch pointer at `064de73` while the working
tree still held every Phase 0/1 file, and `origin/arena/e9537d2e-coc` at
`4b7d98e`. `git reset --mixed 4b7d98e` restored the pointer; the working tree
matched the commit exactly (no genuine user edits were lost — the apparent
README diff was just the stale-pointer artifact). Recorded so the history table
in `docs/VERIFICATION_PROMPT.md` stays truthful.

---

## Phase 1 hardening (Gate A) + Phase 2 — plan

### Gate A — Phase 1 hardening (before any Phase 2 feature)

| #   | Change                                                                                       | Files                                                        | Regression tests                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Level tables must start at 1; collapse the out-of-order + contiguity checks into one message | `src/validate/index.ts`                                      | `test/validate.test.ts`: reject `[2]`, `[2,3]`, `[3,1,2]`, `[1,1]`; accept `[1]`, `[1,2]`                                               |
| A2  | Reject malformed coordinates/rects deterministically                                         | `src/grid/index.ts`, `src/commands/index.ts`                 | NaN, ±Infinity, undefined, string, fractional, zero/negative dims, malformed rects; keep bounds/margin/overlap/exact-fit/move-onto-self |
| A3  | RNG round-trip must snapshot the high-bit state itself                                       | `test/rng.test.ts`                                           | capture at `state > 0x7fffffff`, round-trip it, compare 3+ subsequent draws                                                             |
| A4  | Benchmark the real clone function                                                            | `bench/benchmark.ts`                                         | n/a (benchmark)                                                                                                                         |
| A5  | No silent `?? 1` footprint fallback                                                          | `src/commands/index.ts`                                      | unknown building type in state → typed error, never a phantom 1×1                                                                       |
| A6  | Docs match source                                                                            | `PROGRESS.md`, `DECISIONS.md`, `docs/VERIFICATION_PROMPT.md` | grid API names, obstacle reward, `hashString` format, Vite-alias claim, counts                                                          |

### Gate B — Phase 2 economy & construction

New module `src/economy/index.ts` (catchUp + production/storage maths) and
`src/build/index.ts` (upgrade/refund/gem-speed-up/builder rules), both exported
through the barrel. `applyCommand` runs `catchUp` first for every command.

- **State additions** (all cloned, stable-serialised, tested): per-collector
  `buffer` (stored amount), `bufferRemainder` (fixed-point carry so command
  frequency cannot change production), `lastAccruedAt`; `builders.busy` entries
  carry the target `toLevel`; `builders.purchased` count.
- **catchUp(state, now, config)**: finish upgrades (release the builder, update
  the Keep invariant), complete training-queue items into the army, accrue
  collector production capped at `bufferCap`, reject `now < lastSyncAt`, be
  idempotent at equal timestamps, and never mutate its input.
- **Commands**: `CollectResource`, `StartUpgrade`, `CancelUpgrade`, `SpeedUp`,
  `BuyBuilder`, integrated with the existing four.
- **Generator**: `packages/game-data/scripts/gen-balance.ts` + a human-editable
  `scripts/balance.config.ts`; cost ×1.55, time ×1.6, hp curve; byte-identical
  repeat output; `pnpm --filter @coc/game-data gen:balance`.
- **Playthrough**: `test/playthrough.test.ts` — fixed start timestamp, seven
  days, no `Date.now()`, no injected resources, Keep 3 target.

---

## Phase 1 hardening (Gate A) — report

Four real defects found and fixed, each with a regression test. No Phase 2 feature
was touched in this patch.

### What changed

| #   | Defect                                                                                                                                                                                                                                                        | Fix                                                                                                                                                                                                                                                                                                                   | Regression tests                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `checkSemantics` verified contiguity and ordering but never that a level table **starts at 1**, so `[2]` and `[2, 3]` validated. Level 1 became unreachable and every later cost index was wrong.                                                             | One predicate — `levels.every((level, index) => level === index + 1)` — with a single message naming the building and the supplied sequence. Replaces the two weaker checks, so a broken table no longer produces two overlapping complaints.                                                                         | reject `[2]`, `[2,3]`, `[3,4,5]`, `[1,1,2]`, `[2,4]`; accept `[1]`, `[1,2]`, `[1..6]`; message content; exactly one complaint per table                                            |
| A2  | A loop over `{ x: NaN, w: 3 }` runs zero times, so `findConflict` reported **"no conflict"** for a rectangle that is not a rectangle. Payload coordinates were also trusted from TypeScript types.                                                            | `isValidRect` (finite integer origin, positive integer size) checked first in `findConflict`/`isFree` and enforced in `fill`/`clear`/`forEachCell`/`fromEntries`; new `invalid_rect` conflict reason and `invalid_rect` error code, ordered **before** bounds. Every command payload coordinate validated at runtime. | 18 malformed rects asserted across the whole grid API; 10 bad-coordinate values × 3 commands; config/state boundary cases; bounds/margin/overlap/exact-fit/move-onto-self retained |
| A3  | The RNG round-trip test only _observed_ a high-bit state during a loop and then serialized whatever the final state happened to be.                                                                                                                           | The test now captures the snapshot **at the moment** `state > 0x7fffffff`, round-trips it, asserts exact state equality and compares 5 subsequent draws; a second test round-trips every high-bit state in a 20,000-draw run.                                                                                         | (test-only change)                                                                                                                                                                 |
| A4  | The benchmark labelled a measurement "10,000 clones" while calling `createNewPlayerState` — a different, cheaper operation.                                                                                                                                   | It now calls the exported `clonePlayerState` on a representative nested state, consumes the result via a checksum, and asserts the clone is neither the same object nor a different hash.                                                                                                                             | (benchmark-only change)                                                                                                                                                            |
| A5  | `buildGrid` used `def?.size.w ?? 1`, so an entity with a missing definition was rebuilt as 1×1 and could be treated as a legal placement.                                                                                                                     | `buildGrid` now returns a typed error: missing definition → `unknown_building`/`unknown_obstacle`, malformed instance → `invalid_state`. No fallback size anywhere.                                                                                                                                                   | unknown building type in state rejected for both place and move; never accepted as a 1×1; unknown obstacle type; malformed obstacle position                                       |
| A6  | `docs/VERIFICATION_PROMPT.md` claimed `set()`/`toIds()` (absent), a "stub" obstacle reward (it reads config and emits two events), `hashString` as "FNV-1a → base36" (it is FNV-1a ‖ sdbm, 16 hex chars), and anchored Vite aliases (the test never checked). | Doc corrected against source; `test/config.test.ts` now re-derives the anchored pattern for every alias key and proves the unanchored form swallows `/version`.                                                                                                                                                       | new anchoring test                                                                                                                                                                 |

### Gate A verification (all run, all green)

```
pnpm verify         lint + typecheck (6 projects) + 282 tests, 15 files   PASS
pnpm test:coverage  statements 99.33% · branches 95.88% · functions 100% · lines 99.33%   PASS
pnpm bench          rng 1M draws ~36 ms (checksum 3856587346); round-trips true; resumed stream true
                    commands 250 openings x 4 ~56 ms; hash stable fb5a3f0d6ef30c08
                    clones 10,000 ~40 ms (clonePlayerState)              PASS
pnpm build          6/6 projects Done; client bundle 1,217.90 kB / 335.73 kB gzip
                    (unchanged from Phase 0 — Zod still tree-shaken out)  PASS
```

Coverage thresholds were **not** lowered (90/85/90/90 unchanged). The one genuinely
unreachable branch left uncovered is the `!moved` re-check after cloning in
`MoveBuilding`, kept as a clone-fidelity guard rather than papered over.

---

# Gate B — Phase 2 (Economy & Construction) · COMPLETE, MERGED (PR #1)

Full report: **`PHASE2_REPORT.md`**. Decisions D25–D29 in `DECISIONS.md`.

## Architecture (≤10 lines)

```
sim-core is the only place rules live. It never imports game-data.
game-data holds balance tables; it validates them at import and re-exports a GameConfig.
PlayerState is the authoritative server state; configVersion stamps which tables produced it.
catchUp(state, now) is the single lazy-time evaluator: every mutating command runs it first,
  on a clone, and prepends its events. Rejections are decided before any clone exists.
Production is exact integer arithmetic with the fractional carry as a numerator over
  msPerHour, so command frequency cannot change the amount produced.
Overflow is lost, never banked; the watermark advances anyway, so time spent full is discarded.
Storage caps clamp collection; what did not fit is reported in the event, not silently dropped.
Builders are a counted resource: busy.length <= count, and each busy entry matches a building.
No Date.now(), no Math.random(), no DOM, no fs, no network. Stable iteration by ascending id.
```

## Status

| Gate | Item                                                                                        | Result   |
| ---- | ------------------------------------------------------------------------------------------- | -------- |
| B1   | Data-driven economy, typed schema, Keep gating, stable error codes                          | **Pass** |
| B2   | Pure `catchUp`, monotonic time, exact arithmetic, one shared catch-up                       | **Pass** |
| B3   | Collectors, storage caps, `CollectResource`, overflow lost + evented                        | **Pass** |
| B4   | `StartUpgrade` / `CancelUpgrade` / `SpeedUp` / `BuyBuilder` + integrated place/move/collect | **Pass** |
| B5   | `gen-balance.ts` deterministic, byte-identical, satisfies the validator                     | **Pass** |
| B6   | Seven-day playthrough reaches Keep 3 in **13.15 h** of 168 (re-measured; was 10.61 h)       | **Pass** |
| B7   | Full Phase 2 test list                                                                      | **Pass** |

## Verification (all re-run after a mid-session sandbox re-clone)

| Command              | Result                                                           |
| -------------------- | ---------------------------------------------------------------- |
| `pnpm verify`        | exit 0                                                           |
| `pnpm test`          | 444 tests / 20 files                                             |
| `pnpm test:coverage` | 98.09 / 92.49 / 100 / 98.09 vs 90 / 85 / 90 / 90                 |
| `pnpm bench`         | rng 35.5 ms · commands 82.3 ms · clones 37.3 ms · catchUp 1.3 ms |
| `pnpm build`         | 6/6 Done, client bundle 1,217.90 kB / 335.73 kB gzip (unchanged) |
| `gen:balance` twice  | byte-identical, no diff                                          |

## Known gaps (see `PHASE2_REPORT.md` for the full list)

1. `src/build/index.ts` was reconstructed after the sandbox re-clone; re-verified but its
   history starts here.
2. No builder queue yet, so the 50% unstarted-item refund has no reachable command path in
   Phase 2 (unit-tested directly; Phase 4 item).
3. `MoveBuilding` / `RemoveObstacle` are still free and instant; `removalSeconds` unenforced.
4. Buildings under construction sit at `level: 0` — Phase 3 and Phase 6 must handle it.
5. Coverage 98.09/92.49 vs Gate A's 99.33/95.88; the residue is defense-in-depth branches.

## Next permitted phase

Phase 3 (client / rendering) — not started.
