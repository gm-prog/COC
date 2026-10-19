# EMBERHOLD — Gate B: Phase 2 (Economy & Construction)

**Branch:** `arena/e9537d2e-coc` · **Base:** `687f96d` (Gate A, pushed) · **Status:** code complete, all checks green, **not committed, not pushed**

---

## Summary

Phase 2 turns the Phase 1 foundation into a working economy. Every number a rule needs — prices, durations, hit points, production rates, buffer caps, storage caps, gem costs, builder prices, refund fractions — now comes out of a validated config; nothing is hard-coded in `sim-core`.

What landed:

1. **A pure, exact `catchUp(state, now)`** that every mutating command runs first. It completes finished upgrades, releases builders, finishes training-queue items, and accrues collector production with _exact_ integer arithmetic, so command frequency cannot change the outcome.
2. **Collector production with buffers and storage caps.** Overflow is lost, never banked, and always reported in a typed event.
3. **Five new commands** — `StartUpgrade`, `CancelUpgrade`, `SpeedUp`, `BuyBuilder`, `CollectResource` — each rejecting with a typed, stable error code and never leaving a partial mutation.
4. **A construction rule change**: `PlaceBuilding` now charges the level-1 cost and occupies a builder for the level-1 build time. Previously it was a free, instant layout edit, which let a player place unlimited storage for nothing and broke the economy.
5. **A balance-table generator** (`scripts/gen-balance.ts`) driven by a human-editable config, producing byte-identical output, so a designer tunes one base value and regenerates.
6. **A deterministic seven-day playthrough** that reaches Keep 3 in **13.15 simulated hours** using only legitimately earned resources (10.61 h before the Phase 2 repair corrected the §7.3 gating tables and the catch-up ordering).

One incident worth recording: the sandbox was re-cloned at the initial commit mid-session and `packages/sim-core/src/build/index.ts` (untracked at the time) was lost. It was reconstructed from its consumers and test suite; every check below was re-run afterwards on the reconstructed tree and passes.

---

## Key files changed

### `packages/sim-core` (rules — the only place rules live)

| File                    | Change                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/economy/index.ts`  | **New.** `catchUp`, `finishUpgrades`, `completeTraining`, `accrueProduction`, exact `produce`, `storageCapacity`, `remainingCapacity`, `buildingDef`, `levelDef`, `addResources`, `canAfford` |
| `src/build/index.ts`    | **New.** `checkUpgrade`, `nextLevel`/`currentLevel`, `upgradeDurationMs`, `cancelRefundFraction`, `refundFor`, `speedUpCost`, `nextBuilderCost`, `canBuyBuilder`                              |
| `src/config/types.ts`   | `BuildingLevel.produces?`; new `EconomyConfig` / `SpeedUpAnchor` / `BuilderShop` / `CancelRefund`; `GameConfig.economy` required                                                              |
| `src/state/index.ts`    | `BuildingInstance.buffer?: { amount, remainder, lastAccruedAt }`; `BuilderAssignment.toLevel`                                                                                                 |
| `src/validate/index.ts` | `EconomyConfigSchema`; `checkEconomy` and `checkCollectors` (exported for direct testing); `productionPerHour` / `bufferCap` arithmetic-safety bounds                                         |
| `src/commands/index.ts` | 5 commands, 9 error codes, 7 event types; one `catchUp` call before `dispatch()`; `requireObject` / `requireBuildingId` guards; construction costs a builder                                  |
| `src/index.ts`          | Re-exports the economy/build APIs, the new types and the semantic checkers                                                                                                                    |
| `bench/benchmark.ts`    | Reads `economy.json`; new `catchUp` benchmark; construction-aware command script                                                                                                              |

### `packages/game-data` (balance — data, not rules)

| File                                            | Change                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `data/economy.json`                             | **New.** Speed-up anchors, builder shop, cancel refunds, `msPerHour`                                                  |
| `scripts/balance.config.ts`                     | **New.** The only file a human edits: bases, growth curves, the §7.3 Keep gating table, the explicit Keep build times |
| `scripts/gen-balance.ts`                        | **New.** Deterministic generator for `data/buildings.json` + `data/obstacles.json`                                    |
| `data/buildings.json`, `data/obstacles.json`    | Regenerated                                                                                                           |
| `src/index.ts`, `package.json`, `tsconfig.json` | Wire in `economy.json`, `gen:balance`, `tsx`                                                                          |

### Tests

| File                                              | Tests                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sim-core/test/economy.test.ts`          | **41** — catch-up, monotonic time, 8-hour offline, remainders, buffer cap/overflow, upgrades, training queues, storage, serialization |
| `packages/sim-core/test/build.test.ts`            | **28** — level lookups, `checkUpgrade` rejections and ordering, refunds, speed-up anchors and interpolation, builder shop             |
| `packages/sim-core/test/economy-commands.test.ts` | **43** — the five commands end-to-end, same-millisecond idempotence, backwards time, input immutability                               |
| `packages/game-data/test/gen-balance.test.ts`     | **23** — determinism (twice), contiguity, growth anchors, Keep gating, no data loss, validator acceptance                             |
| `packages/game-data/test/playthrough.test.ts`     | **2** — the seven-day run and its determinism                                                                                         |
| `test/validate.test.ts`                           | 38 → **59** — economy block, collector consistency, obstacle identity                                                                 |
| `test/commands.test.ts`                           | 74 → **77** — construction cost/builder/refusal, builder release                                                                      |
| `test/state.test.ts`                              | 15 → **16** — missing-Keep fallback                                                                                                   |
| `test/fixtures/config.ts`                         | `economy` block, `produces` on collectors, `gold_store` levels, Keep `storageCap`                                                     |

### Docs

`PROGRESS.md` and `DECISIONS.md` carry the Phase 2 report and decisions D25–D28 (see the end of this file for the decision text).

---

## Phase 1 hardening (Gate A) — pass/fail

Committed and pushed as `687f96d` before Phase 2 began. Re-verified on the current tree.

| #   | Item                                                                                                   | Result   |
| --- | ------------------------------------------------------------------------------------------------------ | -------- |
| A1  | Level-table predicate `levels.every((l, i) => l === i + 1)` with one message                           | **Pass** |
| A2  | Payload validation + grid-boundary rect validation (`invalid_rect`, `invalid_state`)                   | **Pass** |
| A3  | High-bit RNG round-trip snapshot (state > `0x7fffffff`)                                                | **Pass** |
| A4  | Clone benchmark on `clonePlayerState`                                                                  | **Pass** |
| A5  | No footprint fallback in `buildGrid` (typed `unknown_building` / `unknown_obstacle` / `invalid_state`) | **Pass** |
| A6  | Docs reconciled against source                                                                         | **Pass** |
| A7  | verify / coverage / bench / build all green                                                            | **Pass** |

---

## Phase 2 features

### B1 — Data-driven economy

Rules live in `sim-core`, balance in `game-data`. `configVersion` is preserved on the state. All amounts are non-negative safe integers. Keep gating is read from each level row's `requiresKeep` (spec §7.3). Footprints, prices, durations, HP, production, buffers and caps all come from the validated config. New schema extensions are typed; the `economy` block is required and validated at import.

### B2 — Pure `catchUp`

- Runs on a **clone**; the input is never mutated, on success or failure.
- **Monotonic time**: an earlier `now` is rejected with `time_moved_backwards`; an equal timestamp is a no-op that changes nothing (asserted by hash).
- **Exact arithmetic**: the fractional production carry is an integer numerator over `economy.msPerHour`, never rounded per call. Six 6,000 ms catch-ups and one 36,000 ms catch-up produce byte-identical states.
- **Overflow is lost, not banked**: time spent with a full buffer is discarded, fractional carry included.
- **One shared catch-up** runs in `applyCommand` before `dispatch()`, and its events are prepended to the command's own.
- Errors never leak partial mutation — every rejection is decided before any clone is made.
- New fields are cloned, stable-serialized and hash-tested.

### B3 — Collectors, storage, `CollectResource`

Rate and cap come from the current level. The transfer is clamped by remaining storage; overflow is lost and reported as `ResourceCollected { accepted, overflow, bufferRemaining }`. A resource with no configured capacity has zero room, not unlimited room. Repeated, partial, full and same-millisecond collection never duplicate.

### B4 — Construction commands

`StartUpgrade` (spend → assign builder → record `finishAt`), `CancelUpgrade` (0 refund once started, 50% for a paid-but-unstarted item), `SpeedUp` (piecewise gem cost on _remaining_ time), `BuyBuilder` (2 → 5 at 250 / 500 / 1,000 gems). Rejections: `not_found`, `unknown_building`, `already_upgrading`, `max_level`, `keep_level_too_low`, `insufficient_resources`, `no_builder`, in that stable order. A command issued exactly at a finish timestamp sees the completed upgrade first.

### B5 — Balance generator

`pnpm --filter @coc/game-data gen:balance` writes both tables from `scripts/balance.config.ts`. Deterministic and byte-identical across runs. Curves: cost ×1.55 rounded to the nearest 10, time ×1.6, HP ×1.4 (the one level-scaling figure the spec states numerically, §7.9). Keep times are transcribed verbatim from §7.5 rather than curve-fitted.

### B6 — Seven-day playthrough

Fixed start `1_700_000_000_000`, public APIs only, no injected resources, no forced `keepLevel`. Invariants asserted after **every** step: non-negative integer resources, `busy ≤ count`, busy entries matching building upgrades, `keepLevel` mirroring the Keep, no overlap, everything inside the buildable core, buffers within cap.

```
Keep level at 7 days: 6
Keep 3 reached at: 47338000 ms = 13.15 h
commands applied: 85
resources: gold 20490, essence 20490, shards 0, gems 50
buildings: keep L6, gold_mine L6, essence_well L6, gold_store L3, essence_store L3
builders: 2 owned
```

These figures were re-measured by the Phase 2 repair; the earlier run in this document
(10.61 h, 83 commands) predates the corrected §7.3 quantity/level split and the
chronological `catchUp`.

Gems were never spent — the economy did not need them.

### B7 — Test list

Every item in the Phase 2 "Done when" list has a test: 8-hour offline catch-up, rate + buffer cap, fractional equivalence, overflow not banked, collection with empty/partial/full/missing storage, storage overflow lost and evented, upgrade completion + builder release, third concurrent upgrade rejected, Keep gates including max level, affordability and deterministic costs, cancel/refund at every boundary, SpeedUp at every anchor and around the piecewise boundaries, BuyBuilder cost/limits/success/failure, same-millisecond idempotence, backwards time rejected, input untouched on success and failure, stable serialization/hash, generator determinism/levels/validation/growth anchors, and the seven-day playthrough.

---

## Verification results

All commands run from the repository root on the reconstructed tree.

| Command                                         | Result                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm verify` (lint + typecheck + test)         | **Pass** — exit 0                                                                              |
| `pnpm test`                                     | **444 tests / 20 files, all passing**                                                          |
| `pnpm test:coverage`                            | **98.09% stmts / 92.49% branches / 100% funcs / 98.09% lines** vs thresholds 90 / 85 / 90 / 90 |
| `pnpm bench`                                    | rng **35.5 ms** · commands **82.3 ms** · clones **37.3 ms** · catchUp **1.3 ms**               |
| `pnpm build`                                    | **6/6 projects Done**; client bundle **1,217.90 kB / 335.73 kB gzip**, identical to Phase 0    |
| `pnpm --filter @coc/game-data gen:balance` (×2) | **byte-identical, no diff**                                                                    |

### Per-suite test counts

```
rng 18 · math 20 · playthrough 2 · build 28 · server 3 · commands 77
cameraTransform 10 · validate 59 · economy 41 · economy-commands 43 · grid 42
gen-balance 23 · serialize 18 · game-data 14 · iso 6 · state 16 · geometry 10
config 6 · protocol 4 · sim-core 4                                  = 444
```

sim-core 376 · game-data 39 · apps 29.

### Benchmark detail

```
rng: 1,000,000 draws                   35.5 ms
rng: checksum                     3856587346
rng: round-trips exactly          true
rng: resumed stream matches       true
commands: 250 openings x 5 cmds        82.3 ms
commands: hash stable over repeats true
commands: hash                    f802895eab49124d
state: 10,000 clones                   37.3 ms
state: clone checksum                 60000
catchUp: 250 x 8 h offline              1.3 ms
catchUp: gold checksum               185000
```

The rng checksum, clone checksum and clone timing match Gate A exactly. The command hash changed because the command script now includes a `CollectResource` step and construction occupies builders, so the timestamps are spaced 60 s apart.

### Generated tables (verified)

- **Keep L1–L6**: HP 1500 / 2100 / 2940 / 4116 / 5762 / 8067 · cost 1000 / 1550 / 2400 / 3720 / 5770 / 8950 gold+essence · time 0 / 300 / 1800 / 10800 / 43200 / 86400 s · storage 1000 / 1600 / 2560 / 4100 / 6550 / 10490
- **gold_mine L1–L6**: HP 300 → 1613 · cost 150 / 230 / 360 / 560 / 870 / 1340 gold · time 20 → 210 s · production 240 / 360 / 540 / 810 / 1215 / 1823 per hour · buffer cap 600 / 900 / 1350 / 2025 / 3038 / 4556 · `requiresKeep` 1 / 1 / 2 / 3 / 4 / 5
- **gold_store / essence_store L1–L3**: cost 200 / 310 / 480 · cap 2500 / 5000 / 10 000 · `requiresKeep` 1 / 3 / 6
- **wall L1–L6**: cost 10 / 20 / 20 / 40 / 60 / 90 (the nearest-10 rule makes L2 and L3 collide)
- **Obstacles**: `tree` 20 gold / 3 s · `rock` 30 gold + 1 gem / 5 s

---

## Known gaps

1. **`src/build/index.ts` was reconstructed.** The sandbox was re-cloned at the initial commit mid-session and this one untracked file was lost. It was rewritten from its consumers and its 28-test suite; all checks above were re-run afterwards and pass. It has not been committed anywhere, so its history starts here.
2. **The builder queue does not exist yet.** Spec §7.5 refunds 50% for "unstarted queue items", but §8.2's state model has only `builders.busy`, and Phase 2 requires a third concurrent upgrade to be _rejected_. So the queued branch of `refundFor` is implemented and unit-tested directly, and `CancelUpgrade` derives "started" from whether a builder is actually assigned — the branch is reachable from a hand-built state but from no Phase 2 command. Recorded as a Phase 4 item.
3. **`MoveBuilding` and `RemoveObstacle` are still free and instant.** Only `PlaceBuilding` was changed to cost resources and builder time. The config's obstacle `removalSeconds` remains unenforced.
4. **`level: 0` for a building under construction.** A newly placed building contributes no HP, storage or production until its builder finishes. This is correct behaviour but is a new state shape that Phase 3's client and Phase 6's combat must handle.
5. **Coverage is 98.09% / 92.49%, below Gate A's 99.33% / 95.88%.** The thresholds are unchanged and comfortably met. The remaining uncovered lines are defense-in-depth branches: the post-clone lookups in `startUpgrade` / `speedUp` / `collectResource` (unreachable because the pre-clone lookup already succeeded) and a few explicit-`undefined` guards in the resource-map loops.
6. **`speedUpCost` sorts a copy of the anchor table** on every call. The validator guarantees ascending anchors, so this is defensive rather than necessary; it is a small, constant, allocation-free-in-practice cost on a cold path.
7. **No Playwright binaries in this sandbox**, so the Phaser render path is verified only via dev-server transform, production build and pure-maths unit tests (unchanged from Phase 1, decision D8).
8. **Not committed, not pushed.** Gate B is a working-tree change set only, per instruction.

---

## Next permitted phase

**Phase 3 — client / rendering.** Not started.
