# Verification prompt — Emberhold Phases 0 & 1

**Purpose of this file:** a self-contained prompt you can paste into ChatGPT (with the GitHub
plugin connected to `gm-prog/COC`) so it can independently audit whether Phases 0 and 1 were
actually built as claimed. Everything below is either a hard fact that can be checked against the
repository, or an explicitly labelled claim.

**Repo:** `https://github.com/gm-prog/COC.git`
**Branch:** `arena/e9537d2e-coc` (all Phase 0/1 work lives here; `main` is only the initial commit)
**Spec (authoritative):** `docs/GAME_SPEC.md`
**Status files:** `PROGRESS.md`, `DECISIONS.md`

---

## 1 · Instructions for the reviewer

You are auditing a monorepo built phase-by-phase against a design spec. Your job is to **check the
claims, not to accept them**. For every item in §7 return `PASS`, `FAIL`, or `UNVERIFIABLE` with a
one-line reason and, where possible, a file path + line number.

To do this:

1. Fetch the repo at branch `arena/e9537d2e-coc`. Use the file listing and raw file contents.
2. Read `PROGRESS.md` and `DECISIONS.md` in full — they are the primary claims.
3. Read `docs/GAME_SPEC.md` sections 8.1, 8.2 and 7.3 — the phase is supposed to implement them.
4. Spot-check the source files named in §5 against the behaviour claimed for them.
5. Run the mechanical checks in §6 (grep-based, so you can reason about them without a shell).
6. Answer the checklist in §7 and the questions in §8.

**Do not** re-plan the project, propose architecture changes, or start Phase 2. This is an audit.

If a claim is false or overstated, say so plainly and quote the evidence. If something is claimed
but missing, that is a FAIL even if the rest is excellent.

---

## 2 · What the project is

**Emberhold** — an original-IP, Clash-of-Clans-_style_ base-builder / asynchronous-raid game.
Monorepo, TypeScript strict, pnpm.

Working agreement that constrains everything:

| Rule                                                                                                                                | Where it is enforced                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| All game rules live in `packages/sim-core`, pure and clock-free                                                                     | architecture + review                  |
| Determinism: 20 ticks/s, integer/fixed-point math, seeded PRNG, stable ordering                                                     | `src/math`, `src/rng`, `src/serialize` |
| No `Date.now()` / `Math.random()` anywhere in sim-core                                                                              | §6.1                                   |
| Data-driven balance — no hard-coded game numbers in logic                                                                           | `packages/game-data` + §6.2            |
| Server is the source of truth; client may predict but never decides                                                                 | architecture                           |
| Original in-game names only (Keep, Gold, Essence, Shards, Gems, Axeman, Archer, Brute, Sapper, Vaulter, Pilferer, Mender, Wyrmling) | `docs/GAME_SPEC.md`                    |
| Phase gate: no next phase without explicit approval                                                                                 | process                                |
| No monetization before Phase 14, no clans before Phase 10                                                                           | spec                                   |

---

## 3 · Commit history to verify

`main` contains exactly one commit (`064de73 Initial commit`). Everything else is on
`arena/e9537d2e-coc`, in this order:

| #   | Commit    | Subject                                                                              | Phase |
| --- | --------- | ------------------------------------------------------------------------------------ | ----- |
| 1   | `59a445f` | docs: add the Emberhold design spec and living project docs                          | 0     |
| 2   | `bace142` | chore: pnpm monorepo tooling with strict TypeScript, ESLint, Prettier, Vitest and CI | 0     |
| 3   | `0eb435f` | feat(packages): sim-core, game-data and protocol workspace skeletons                 | 0     |
| 4   | `8ab0d73` | feat(apps): Phaser isometric-grid client, Fastify skeleton and tools CLI             | 0     |
| 5   | `f27cfc9` | feat(server): index route listing the available endpoints                            | 0     |
| 6   | `519b056` | feat(sim-core): Phase 1 — deterministic foundations                                  | 1     |

**Check:** the branch history is linear, in that order, with no merge commits, no commits on
`main` beyond `064de73`, and nothing uncommitted.

---

## 4 · Repository shape

```
docs/GAME_SPEC.md              authoritative design spec (verbatim paste; Prettier-excluded)
PROGRESS.md                    living status: 10-line architecture, milestones, phase reports
DECISIONS.md                   D1–D17, every deviation + judgement call
README.md · ASSETS.md · THIRD_PARTY.md

packages/sim-core/src/         math · rng · grid · config · state · validate · commands · serialize
packages/sim-core/test/        math · rng · grid · geometry · state · commands · serialize · validate
                               sim-core (barrel smoke) · fixtures/config.ts
packages/sim-core/bench/       benchmark.ts (pnpm bench)
packages/game-data/data/       buildings.json · obstacles.json · starter.json
packages/game-data/src/        index.ts (validates at import) · version.ts (dependency-free)
packages/protocol/src/         wire types only
packages/protocol/test/        protocol.test.ts

apps/client/                   Vite 7 + Phaser 3, src/scenes/BootScene.ts, src/iso.ts,
                               src/cameraTransform.ts, test/{iso,cameraTransform}.test.ts
apps/server/                   Fastify skeleton, GET /health /version /world /
apps/tools/                    `tools info` CLI

test/config.test.ts            root-level drift guard (tsconfig paths ↔ Vite aliases)
.github/workflows/ci.yml        install → lint → typecheck → test → coverage → build
vitest.config.ts               single Vitest project + coverage thresholds
tsconfig.base.json             strict TS + workspace path aliases
```

**Check:** every path above exists on the branch. Flag anything missing.

---

## 5 · Phase 1 source inventory and claimed behaviour

### `packages/sim-core/src/math/index.ts`

`FIXED_ONE = 1000` (1.0 in 10.3 fixed point), `fixedMul`, `fixedDiv`, `isqrt`, `hypotFixed`,
`clamp`, `roundToNearest`.
**Claim:** `isqrt` is exact for every input up to `Number.MAX_SAFE_INTEGER` and never uses `>>`
(int32 wrap). **Verify:** `test/math.test.ts` asserts exactness against `Math.sqrt` across a range
and at `2**52`, `2**52 - 1`, `Number.MAX_SAFE_INTEGER`.

### `packages/sim-core/src/rng/index.ts`

mulberry32 exposed as a **pure** `(state) -> [value, nextState]` pair, not a mutating object.
`createRng`, `nextUint32`, `nextFloat`, `nextInt`, `nextChance`, `nextPick`, `deriveSeed` (FNV-1a),
`serializeRng`, `deserializeRng`.
**Claim:** `serializeRng`/`deserializeRng` are exact inverses, including after the internal state
wraps past zero.
**Verify:** `test/rng.test.ts` — 1,000,000-draw determinism, seeds diverge, and two regression
tests that drive the generator past the sign boundary and prove the round-trip.

### `packages/sim-core/src/grid/index.ts`

`OccupancyGrid` over an `Int32Array`. Public API: `fromEntries`, `ownerAt`, `countOccupied`,
`isInsideMap`, `isInsideBuildable`, `isFree`, `canPlace`, `findConflict`, `fill`, `clear`,
`forEachCell`, plus the `isValidRect` predicate and the `rectsOverlap`/`rectContains` helpers.
There is **no** `set()` and **no** `toIds()`.
`findConflict` reports **invalid_rect → bounds → margin → occupancy**, in that fixed order, so error
messages are deterministic. `invalid_rect` is checked first because a malformed rectangle cannot be
bounds-checked meaningfully, and a loop over `{ x: NaN, w: 3 }` executes zero times and would
otherwise report "no conflict".
**Verify:** `test/grid.test.ts` — out-of-bounds, margin, overlap, exact-fit edges, a margin cell
that is _not_ the first cell of the footprint, `isFree` rejecting a rectangle that leaves the map,
and 18 malformed rectangles asserted across the whole API.

### `packages/sim-core/src/config/geometry.ts` + `types.ts`

`GRID = { total: 48, buildable: 40, margin: 4 }`, frozen. `assertValidGeometry`, `isMapTile`,
`isBuildableTile`. Plus the spec §8.1 config types.
**Verify:** `test/geometry.test.ts` — 10 tests including every `assertValidGeometry` failure mode
and `Object.isFrozen(GRID)`.

### `packages/sim-core/src/validate/index.ts`

Zod 4 schemas + `validateGameConfig()` / `loadGameConfig()` returning a `GameConfig`, throwing a
`ConfigValidationError` that lists **every** problem at once.
Semantic rules Zod cannot express: non-empty ids, unique ids, positive levels, **level 1 may not
require a higher Keep than the building's own unlock**, and **`requiresKeep` must be non-decreasing
across levels**. Higher levels _may_ demand a higher Keep than the unlock — that is the gating
table (spec §7.3).
`formatIssue(issue, raw)` walks the issue path through the raw data and appends `(received …)`
and `[allowed: …]` for enum issues, because Zod 4 issues carry no offending value.
**Verify:** `test/validate.test.ts` — 31 tests, including structural Zod issues _and_ each
semantic rule, and a "lists every problem" case.

### `packages/sim-core/src/state/index.ts` + `state/clone.ts`

`PlayerState` per spec §8.2, `createNewPlayerState(config, now)` driven entirely by config,
`findKeep`, `isKeepLevelConsistent`, `highestEntityId`, `clonePlayerState`. The clone is
hand-written (`structuredClone` is unavailable under this tsconfig's `lib`/`types` settings).
**Verify:** `test/state.test.ts` — 15 tests: starter resources/builder count/layout come from
config, obstacle ids continue after building ids, `keepLevel` invariant, JSON round-trip, deep
independence of clones.

### `packages/sim-core/src/commands/index.ts`

`applyCommand(state, command, ctx) → { ok: true, state, events } | { ok: false, error }`. Pure —
never mutates its input. `CommandErrorCode` union: `invalid_command`, `invalid_config`,
`unknown_building`, `unknown_obstacle`, `not_found`, `out_of_bounds`, `margin`, `overlapping`,
`keep_level_too_low`, `no_change`.
Commands: `PlaceBuilding`, `MoveBuilding`, `RemoveObstacle`.
**Notable rule:** `MoveBuilding` frees the building's _own_ footprint before checking overlap, so a
building can be "moved" onto its current tile as a legal no-op. `applyCommand` also rejects a
missing/invalid `command.id` and a non-finite `ctx.now` as `invalid_command`.
**Verify:** `test/commands.test.ts` — 30 tests covering every rejection reason, successful
place/move/remove, reward events, purity (input untouched), and the config-drift cases
(`unknown_building`, `unknown_obstacle`).

### `packages/sim-core/src/serialize/index.ts`

`stableStringify` (recursively sorted keys; `-0` → `0`; non-finite → `null`; bigint/function/symbol,
circular references and `Map`/`Set` rejected), `stableParse`, `hashValue`, `hashState`.
`hashString` is **FNV-1a (32-bit) concatenated with sdbm (32-bit)**, each rendered as 8 lowercase
hex digits, producing a 16-character hex string. It is _not_ base36 and not a single hash.
**Verify:** `test/serialize.test.ts` — 18 tests including key ordering, `-0`/non-finite
normalisation, and each rejection.

### `packages/sim-core/src/index.ts`

Public barrel re-exporting every module above.

### `packages/game-data/`

- `data/buildings.json` — **arrays**, not id-keyed objects: `keep` (4×4, hq, L1 hp 1500 storage
  1000/1000; L2 hp 2200 storage 2000/2000, 1000 gold + 1000 essence, 300 s), `gold_mine` (3×3,
  L1 hp 300 cost 150 gold 20 s, 240/h, buffer 600; L2 hp 420 cost 250 gold 60 s, 400/h, buffer
  1000), `essence_well` (mirror of the mine), `gold_store` / `essence_store` (3×3, L1 hp 500 cost
  200 30 s cap 2500; L2 hp 700 cost 350 90 s cap 5000), `wall` (1×1, L1 hp 300 cost 10 gold 5 s;
  L2 hp 420 cost 20 gold 10 s, unlocks at Keep 2).
- `data/obstacles.json` — `tree` and `rock`.
- `data/starter.json` — 1000 gold / 1000 essence / 0 shards / 50 gems, 2 builders, Keep L1 4×4 at
  (18,18), gold mine at (14,17), essence well at (23,17), 7 obstacles with 20/30 gold rewards and
  3/5 s removal.
- `src/index.ts` — re-exports the raw JSON and exposes `loadGameConfig()`, which validates through
  sim-core **at import time**, so a broken table fails loudly on boot.
- `src/version.ts` — `CONFIG_VERSION`, **zero imports**, exposed as a `./version` subpath so the
  client can stamp the config version without pulling Zod into its bundle.

**Verify:** `packages/game-data/test/game-data.test.ts` — 14 tests.

---

## 6 · Mechanical checks (run these yourself)

### 6.1 No clock or randomness inside the rules core

```bash
grep -rn "Date\.now\|Math\.random\|new Date\|performance\.now" packages/sim-core/src/
```

Expected: **only matches inside doc comments** (the files quote the spec's "no `Date.now()`, no
`Math.random()`" rule). No call sites.

### 6.2 No hard-coded balance numbers in logic

Open `packages/sim-core/src/commands/index.ts` and `src/state/index.ts`. Expected: costs, times,
hit points, sizes and unlock levels are all read from `ctx.config` / `config` — never literalled.
Literals that _are_ allowed: `1` for default level, `0` for initial resource/id counters, and
grid geometry in `config/geometry.ts` (which is itself a config constant, not a rule).

### 6.3 Alias / exports coherence

`tsconfig.base.json` `paths` and the `workspaceAliases` record in `apps/client/vite.config.ts` must
agree, and the Vite aliases must be **anchored RegExps**, not strings (string aliases are prefix
matches, which previously made `@coc/game-data` swallow `@coc/game-data/version` and break the
client build). `test/config.test.ts` enforces this: it re-derives the anchored pattern for every alias key,
asserts each matches its own key and rejects `key/version` and `keyx`, and proves the unanchored
form really does swallow the subpath.

```bash
grep -n "new RegExp" apps/client/vite.config.ts          # expected: present
grep -n "alias: aliasEntries" apps/client/vite.config.ts # expected: present
grep -n "alias: workspaceAliases" apps/client/vite.config.ts  # expected: absent
```

### 6.4 Coverage thresholds are real

`vitest.config.ts` must contain `lines: 90, functions: 90, statements: 90, branches: 85`, and
`.github/workflows/ci.yml` must run `pnpm test:coverage` as a step (so a regression below the
threshold fails CI rather than silently shrinking the net).

### 6.5 Zod is not in the browser bundle

`apps/client` depends on `@coc/game-data` only for `./version`, which is import-free. `packages/
{sim-core,game-data,protocol}/package.json` must each carry `"sideEffects": false`. The production
client bundle must be the same size as it was before Phase 1
(`dist/assets/index-*.js` ≈ 1,217.90 kB, 335.73 kB gzipped) — if Zod leaked in, the number jumps by
hundreds of kB.

---

## 7 · Audit checklist

Mark each `PASS` / `FAIL` / `UNVERIFIABLE` with evidence.

### Phase 0 — bootstrap & tooling

| #    | Claim                                                                                                        | How to verify                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 0.1  | pnpm workspace with `packages/{sim-core,game-data,protocol}` + `apps/{client,server,tools}`                  | `pnpm-workspace.yaml`, directory listing                              |
| 0.2  | TypeScript strict incl. `noUncheckedIndexedAccess` and `verbatimModuleSyntax`                                | `tsconfig.base.json`                                                  |
| 0.3  | ESLint 9 flat config + Prettier + Vitest wired into root scripts                                             | `eslint.config.js`, `package.json` scripts                            |
| 0.4  | CI runs install → lint → typecheck → test → coverage → build on push/PR                                      | `.github/workflows/ci.yml`                                            |
| 0.5  | Client renders the 48×48 map isometrically with pan, wheel zoom, pinch zoom, keyboard pan/zoom, tile picking | `apps/client/src/scenes/BootScene.ts`, `iso.ts`, `cameraTransform.ts` |
| 0.6  | Camera maths is Phaser-free and unit-tested; a real clamp bug was found and fixed                            | `test/cameraTransform.test.ts` (10 tests)                             |
| 0.7  | Server: Fastify skeleton with `/health`, `/version`, `/world`, `/`                                           | `apps/server/src/app.ts`, `test/app.test.ts` (3 tests)                |
| 0.8  | `tools info` CLI prints version stamps and grid geometry                                                     | `apps/tools/src/index.ts`                                             |
| 0.9  | Spec is byte-verbatim and Prettier-excluded                                                                  | `docs/GAME_SPEC.md`, `.prettierignore`                                |
| 0.10 | `pnpm-workspace.yaml` allows the `esbuild` build script                                                      | `onlyBuiltDependencies: [esbuild]`                                    |

### Phase 1 — sim-core foundations

| #     | Claim                                                                                                     | How to verify                                                       |
| ----- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1.1   | Fixed-point math with exact integer `isqrt`/`hypotFixed`                                                  | `src/math/index.ts`, 20 tests                                       |
| 1.2   | Seeded PRNG with a pure state-passing API                                                                 | `src/rng/index.ts`, 18 tests                                        |
| 1.3   | RNG determinism across 1,000,000 draws                                                                    | `test/rng.test.ts` ("produces the same sequence for the same seed") |
| 1.4   | RNG serialization is an exact inverse, past the sign boundary                                             | `test/rng.test.ts` round-trip block                                 |
| 1.4b  | The high-bit state itself is snapshotted and round-tripped (Gate A3)                                      | captured at `state > 0x7fffffff`, 5 subsequent draws compared       |
| 1.5   | Occupancy grid with bounds/margin/overlap/free checks                                                     | `src/grid/index.ts`, 42 tests                                       |
| 1.5b  | Malformed rects rejected at the grid boundary (Gate A2)                                                   | 18 malformed cases across the whole grid API                        |
| 1.6   | State types match spec §8.2; `createNewPlayerState` is config-driven                                      | `src/state/index.ts`, 15 tests                                      |
| 1.7   | Config loader fails loudly with **all** issues listed                                                     | `src/validate/index.ts`, 38 tests                                   |
| 1.8   | `requiresKeep` is a per-level table with the two rules in D11, **not** `requiresKeep <= unlock.keepLevel` | `src/validate/index.ts`; confirm the wrong rule is absent           |
| 1.9   | Initial configs exist for Keep, Gold Mine, Essence Well, Gold/Essence Store, Wall, obstacles              | `packages/game-data/data/*.json`                                    |
| 1.10  | `applyCommand` returns typed `ok + events` or `error + code`, never mutates input                         | `src/commands/index.ts`, 74 tests                                   |
| 1.10b | Malformed runtime payloads rejected before grid work (Gate A2)                                            | 10 bad-coordinate cases × 3 commands                                |
| 1.10c | No silent 1×1 footprint fallback for unknown entities (Gate A5)                                           | typed `unknown_building`/`unknown_obstacle`/`invalid_state`         |
| 1.11  | `PlaceBuilding`, `MoveBuilding` (move-onto-self allowed), `RemoveObstacle` (reads configured reward)      | `src/commands/index.ts`                                             |
| 1.12  | Stable sorted-key JSON + `hashState()`                                                                    | `src/serialize/index.ts`, 18 tests                                  |
| 1.13  | Identical `hashState()` for a repeated command list                                                       | `test/serialize.test.ts` + `pnpm bench`                             |
| 1.14  | ≥90% line coverage on state/grid/commands                                                                 | `pnpm test:coverage` (claimed 99.33%)                               |
| 1.15  | Placement tests cover bounds/overlap/margin/exact-fit/move-onto-self/walls-adjacent                       | `test/commands.test.ts`, `test/grid.test.ts`                        |
| 1.16  | Invalid-config rejection is tested                                                                        | `test/validate.test.ts`, `test/game-data.test.ts`                   |
| 1.17  | No `Date.now`/`Math.random` in sim-core                                                                   | §6.1                                                                |
| 1.18  | No hard-coded balance numbers in logic                                                                    | §6.2                                                                |
| 1.19  | Config version is importable without Zod                                                                  | `src/version.ts`, `./version` export, §6.5                          |
| 1.20  | `PROGRESS.md` and `DECISIONS.md` are up to date and internally consistent with the code                   | read both                                                           |

### Cross-cutting

| #    | Claim                                                                                 | How to verify                                        |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| X.1  | The tsconfig-paths ↔ Vite-alias drift guard actually compares the two                 | `test/config.test.ts` (6 tests)                      |
| X.2  | `packages/protocol` has a test (this was missing after Phase 0)                       | `packages/protocol/test/protocol.test.ts` (4 tests)  |
| X.3  | Reported test counts match reality                                                    | §8 "Expected numbers"                                |
| X.3b | The clone benchmark measures `clonePlayerState`, not `createNewPlayerState` (Gate A4) | `packages/sim-core/bench/benchmark.ts`               |
| X.4  | Reported coverage numbers match reality                                               | `vitest.config.ts` thresholds + `pnpm test:coverage` |
| X.5  | No reference-game names/art/sounds used as branding                                   | grep for trademarked terms across the repo           |

---

## 8 · Expected numbers (compare against what you actually find)

| Metric                                          | Expected after Gate A hardening                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commits on branch                               | 8 total (`064de73` + 6 Phase 0/1 + 1 hardening); `main` has 1                                                                                                                              |
| Test files                                      | 15                                                                                                                                                                                         |
| Tests                                           | **281**                                                                                                                                                                                    |
| Tests per file                                  | rng 18 · math 20 · server 3 · cameraTransform 10 · commands 74 · validate 38 · grid 42 · iso 6 · game-data 14 · state 15 · serialize 18 · geometry 10 · config 6 · protocol 4 · sim-core 4 |
| sim-core coverage — statements                  | 99.33% (threshold 90)                                                                                                                                                                      |
| sim-core coverage — branches                    | 95.88% (threshold 85)                                                                                                                                                                      |
| sim-core coverage — functions                   | 100% (threshold 90)                                                                                                                                                                        |
| sim-core coverage — lines                       | 99.33% (threshold 90)                                                                                                                                                                      |
| Client production bundle                        | 1,217.90 kB / 335.73 kB gzip (must equal the Phase 0 figure)                                                                                                                               |
| Benchmark — 1,000,000 RNG draws                 | ~36 ms, checksum `3856587346`                                                                                                                                                              |
| Benchmark — 1000 commands (250 openings × 4)    | ~56 ms                                                                                                                                                                                     |
| Benchmark — 10,000 **`clonePlayerState`** calls | ~40 ms (must measure the clone, not `createNewPlayerState`)                                                                                                                                |
| Benchmark — stable hash                         | `fb5a3f0d6ef30c08`                                                                                                                                                                         |
| `GRID`                                          | total 48 / buildable 40 / margin 4                                                                                                                                                         |
| `FIXED_ONE`                                     | 1000                                                                                                                                                                                       |
| `SIM_CORE_VERSION`                              | `0.1.0`                                                                                                                                                                                    |
| `STATE_VERSION`                                 | 1                                                                                                                                                                                          |
| `PROTOCOL_VERSION`                              | `0.1.0`                                                                                                                                                                                    |
| `hashString`                                    | 16 lowercase hex chars (FNV-1a ‖ sdbm, 32-bit each)                                                                                                                                        |

---

## 9 · Known gaps — deliberately NOT done

These are **expected absences**, not failures. Flag them only if the reviewer thinks the spec
demanded them earlier than claimed.

1. `RemoveObstacle` grants a fixed stub reward and does not touch the economy. Costs, builder
   time, timers and catch-up are **Phase 2**.
2. `PlaceBuilding` does not check resources, builder availability or level. **Phase 2**.
3. No transport or session layer; `applyCommand` is the whole contract. Wire protocol is
   **Phase 7**.
4. Balance tables are hand-authored, not curve-generated. The generator is deferred until curve
   parameters exist (**Phase 4+**); nothing in the code assumes generated data.
5. `apps/server` has no persistence, auth or command endpoint. **Phase 7**.
6. No Playwright browser binaries were available in the build sandbox, so the Phaser render path
   is verified via dev-server transform, production build and pure-maths unit tests only
   (recorded as D8).
7. `packages/sim-core` and `packages/protocol` still emit `dist/` via `tsconfig.build.json`,
   while `packages/game-data` was switched to `tsc --noEmit` because it ships JSON data. `dist/`
   is gitignored and nothing consumes it, so this is an inconsistency to clean up in Phase 17
   (when `exports` moves to built output) rather than a defect now.
8. Coverage is measured on `packages/sim-core/src` only; `apps/*` are not yet thresholded.
9. `checkPlacement`'s `invalid_rect` mapping is defense-in-depth: command payloads are validated
   first, so it is only reachable when a caller hands `applyCommand` a `GameConfig` that was never
   produced by `validateGameConfig` (the type is structural). It is tested that way deliberately
   rather than deleted, because that is exactly the untrusted-input path the spec worries about.
10. The `!moved` re-check after `clonePlayerState` in `MoveBuilding` is unreachable in practice and
    is the single remaining uncovered branch; it is kept as a clone-fidelity guard rather than
    papered over with a test that cannot fail.
11. The checkout this was built in arrived with the local branch pointer at `064de73` while the
    working tree still held every Phase 0/1 file and `origin` was at `4b7d98e`.
    `git reset --mixed 4b7d98e` restored the pointer and the working tree matched exactly, so no
    work was lost. See the recon note at the end of `PROGRESS.md`.

---

## 10 · Two bugs the phase claims to have caught

Verify both are genuinely fixed in the current code, not just described:

1. **RNG round-trip.** `nextUint32` stored the internal state with `| 0` (signed) while
   `serializeRng` wrote it with `>>> 0` (unsigned), so a battle resumed from a snapshot would have
   diverged. Fixed by storing it unsigned throughout; the arithmetic is bit-identical so no drawn
   value moved. **Verify:** `packages/sim-core/src/rng/index.ts` has no `| 0` on the state, and
   `test/rng.test.ts` has a regression test that drives past the sign boundary.
2. **Level tables could start at 2.** `checkSemantics` verified contiguity and ordering but never
   that the first level is 1, so a table like `[2]` or `[2, 3]` passed every check. Level 1 became
   unreachable and every later level's cost index was wrong. Replaced by one predicate
   (`level === index + 1`) with a single actionable message. **Verify:**
   `packages/sim-core/src/validate/index.ts` and the A1 block in `test/validate.test.ts`.
3. **Malformed rectangles looked free.** A loop over `{ x: NaN, w: 3 }` executes zero times, so
   `findConflict` reported "no conflict" for something that is not a rectangle. Fixed with
   `isValidRect` checked first in `findConflict`/`isFree` and enforced in `fill`/`clear`/
   `forEachCell`/`fromEntries`, surfaced as the new `invalid_rect` conflict reason and
   `invalid_rect` error code. **Verify:** `packages/sim-core/src/grid/index.ts` and the A2 blocks in
   `test/grid.test.ts` / `test/commands.test.ts`.
4. **A silent 1×1 footprint fallback.** `buildGrid` used `def?.size.w ?? 1`, so an entity whose
   definition was missing from the config was rebuilt into the grid as 1×1 and could be treated as a
   legal placement. Removed; a missing definition is now a typed `unknown_building` /
   `unknown_obstacle` error and a malformed instance is `invalid_state`. **Verify:** the A5 block in
   `test/commands.test.ts`.
5. **Vite alias prefix match.** String `resolve.alias` entries are prefix matches, so
   `'@coc/game-data'` also captured `'@coc/game-data/version'` and resolved it to
   `…/src/index.ts/version`, breaking the client build. Fixed with anchored RegExps.
   **Verify:** `apps/client/vite.config.ts` builds `find: new RegExp('^' + escaped + '$')`.

---

## 11 · Questions the reviewer should answer

1. Does the code in `packages/sim-core/src/commands/index.ts` actually match the behaviour
   described in §5, line for line? Quote any divergence.
2. Is the `requiresKeep` validation in `src/validate/index.ts` exactly the two rules in D11, and
   is the old (wrong) `requiresKeep <= unlock.keepLevel` rule genuinely absent?
3. Do the numbers in §8 match what the repo actually produces?
4. Is anything claimed in `PROGRESS.md` / `DECISIONS.md` that the code does not support?
5. Is anything in the code that `PROGRESS.md` / `DECISIONS.md` fails to mention?
6. Are there any remaining determinism hazards — unsorted iteration over objects, floating-point
   accumulation in a tick loop, or anything time- or locale-dependent?
7. Would a fresh `pnpm install && pnpm verify && pnpm build` succeed from the committed state?
   (If you cannot run it, say so and mark the affected items `UNVERIFIABLE`.)
8. Anything that looks like scope creep beyond Phases 0–1?

---

## 12 · Output format requested from the reviewer

```
VERDICT: <sound / sound with caveats / not sound>

PASS: <n> items
FAIL: <n> items   (list each with file:line evidence)
UNVERIFIABLE: <n> items (list each and why)

Most serious problem: <one paragraph>
Second most serious: <one paragraph, or "none">

Answers to §11: <numbered, one line each>

Recommendation: <accept Phase 1 / fix these N items first — list them>
```

---

_This file is a verification artifact, not design documentation. It is regenerated at the end of
each phase so the reviewer always audits the current state of the branch._
