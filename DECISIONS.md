# DECISIONS.md

Every deviation from [`docs/GAME_SPEC.md`](docs/GAME_SPEC.md), plus any judgement
call the spec left open. Format: **date · decision · why · impact**.

Nothing here is a silent change — if a decision turns out to be wrong, revert it
and record that too.

---

## D1 · 2026-10-19 · Phaser 3.90 pinned rather than the latest Phaser

The spec names **Phaser 3 + Vite**. Phaser 4 is now published, but its API
surface and plugin ecosystem are not yet proven for this project, and Phase 3+ of
the spec is written against Phaser 3 idioms (`Scale`, `Graphics`, `Cameras`).
Pinned to `phaser@^3.90.0`. Revisit after M1 ships, as a deliberate migration.

## D2 · 2026-10-19 · Workspace packages are consumed as TypeScript source

`packages/*` expose `./src/index.ts` from their `exports` map, so Vite, tsx and
Vitest all run straight from source with no build step in the dev loop. A
`tsc -p tsconfig.build.json` build still emits `dist/` for consumers that want
plain JS.

- **Why:** fastest possible edit→reload loop for a rules-heavy codebase, and it
  removes an entire class of "stale dist" bugs.
- **Impact:** production deployment (Phase 17) must either bundle with esbuild or
  switch the `exports` map to `dist/` behind a build step. Recorded as a Phase 17
  task.

## D3 · 2026-10-19 · Camera pan/zoom implemented on a Phaser `Container`, not on `Camera.scroll`

The projection is linear, so panning/zooming a single container that holds the
grid gives exact, cheap "zoom toward the pointer" behaviour and a trivially
testable clamping rule. `Camera.scroll` would work too, but its world↔screen
mapping goes through `midPoint` and is easier to get subtly wrong.

- **Impact:** none for gameplay; the same `iso.ts` helpers back both the scene
  and any future minimap.

## D4 · 2026-10-19 · `docs/GAME_SPEC.md` is excluded from Prettier

The spec is a verbatim paste of the design document. Reformatting it would create
enormous diffs that hide real changes. It is listed in `.prettierignore`.

## D5 · 2026-10-19 · Debug HUD lives in the DOM, not in Phaser

Phase 0's FPS/zoom/tile readout is plain HTML over the canvas. This keeps text
crisp and scalable, gives real accessibility semantics, and lets Playwright
assert against it in Phase 3 without pixel scraping. Phase 3 replaces it with the
production HUD.

## D6 · 2026-10-19 · One Vitest project for the whole monorepo

All tests run from a single root `vitest.config.ts` instead of per-package
configs. Less boilerplate now; split into per-package projects when a package
needs a different environment (expected in Phase 3 for client UI tests).

## D7 · 2026-10-19 · `pnpm dev` runs the client and server together

The spec only says `pnpm dev`. Since the dev loop is "browser first", the default
`dev` starts the Vite client (5173) and the Fastify server (8080) in parallel.
`dev:client` / `dev:server` / `dev:tools` start them individually.

## D8 · 2026-10-19 · No Playwright in CI yet

Playwright's browser binaries are not downloadable in the current sandbox, so the
Phase 3 client smoke test cannot be executed here. CI runs unit, typecheck, lint
and build only until Playwright is available.

## D9 · 2026-10-19 · Camera pan/zoom maths lives in a Phaser-free module

`apps/client/src/cameraTransform.ts` holds the transform/clamp/anchor maths and
`BootScene` only applies the result. This made the camera unit-testable without a
canvas, which immediately exposed a real bug: the vertical pan clamp used
`worldHeight / 2` instead of `worldHeight`, so the map could not be panned to its
bottom edge. Same reasoning will apply to the battle replay camera in Phase 6.

## D10 · 2026-10-19 · `esbuild` is an explicitly allowed build script

`tsx` depends on `esbuild`, whose platform binary is installed by a postinstall
script. pnpm 12 blocks dependency build scripts by default, so
`onlyBuiltDependencies: [esbuild]` is set in `pnpm-workspace.yaml`. Without it a
fresh `pnpm install` reports `ERR_PNPM_IGNORED_BUILDS`.

## D11 · 2026-10-19 · `requiresKeep` is a per-level unlock table, not a global ceiling

The first draft validated `level.requiresKeep <= building.unlock.keepLevel` for every level. That
is wrong for progressive upgrades: it forbids a building that unlocks at Keep 1 from demanding a
higher Keep for its later levels, which is exactly the gating the spec's "Max bldg level" table
(§7.3) describes.

Replaced with two rules that do hold:

1. **Level 1 may not require a higher Keep than the building's own unlock** — otherwise the
   building could never be placed at all.
2. **`requiresKeep` must be non-decreasing across levels** — otherwise the table is not a
   progression.

Higher levels _may_ demand a higher Keep than the unlock. `PlaceBuilding` enforces the same rule
at runtime and returns `keep_level_too_low` with the offending level.

- **Impact:** the starter village (Keep 1, walls unlocking at Keep 2) validates correctly, which
  it did not before.

## D12 · 2026-10-19 · `@coc/game-data/version` is a dependency-free subpath export

The client stamps `configVersion` into every command and needs `CONFIG_VERSION` to do it. Importing
`@coc/game-data` would have pulled the whole Zod-validated barrel — and therefore Zod — into the
browser bundle. `packages/game-data/src/version.ts` exports the constant with **zero imports**, is
re-exported by the barrel, and is exposed as a `./version` subpath in the package `exports` map.
`tsconfig.base.json` paths and `apps/client/vite.config.ts` aliases carry a matching entry.

- **Impact:** the client production bundle is byte-identical in size to Phase 0 (1,217.90 kB /
  335.73 kB gzipped), proving Zod is tree-shaken out. Library packages also gained
  `sideEffects: false` to make that reliable.

## D13 · 2026-10-19 · Vite aliases must be anchored RegExps, not strings

Vite's `resolve.alias` with a **string** key is a _prefix_ match, so `'@coc/game-data'` also
captured `'@coc/game-data/version'` and resolved it to `…/src/index.ts/version`, breaking the
client build. The aliases are now derived from the `workspaceAliases` record as
`{ find: new RegExp('^' + escaped + '$'), replacement: target }`.

- **Impact:** the record stays the single source of truth (`test/config.test.ts` still parses it
  and compares it against `tsconfig.base.json` paths), so the drift guard keeps working.
- **Lesson:** never add a workspace subpath export without anchoring the alias.

## D14 · 2026-10-19 · RNG state is unsigned throughout

`serializeRng` wrote the internal state with `>>> 0` while `nextUint32` stored it with `| 0`. A
state that had wrapped past zero therefore came back from `deserializeRng` as a different number,
and a battle resumed from a snapshot would have diverged from the original — the exact failure the
serializable-state requirement exists to prevent.

Fixed by storing the state as an unsigned uint32 everywhere. The arithmetic is unchanged (`^` and
`Math.imul` operate on the low 32 bits either way), so no drawn value moved and no golden checksum
in the suite changed. Covered by regression tests that drive the generator past the sign boundary.

## D15 · 2026-10-19 · Zod 4 issues carry no offending value, so `formatIssue` walks the raw data

Zod 4 issue objects expose `code`, `path` and `message` only — no `input`, and enum issues do not
echo the rejected value. `formatIssue(issue, raw)` therefore walks the issue path through the raw
config and appends `(received …)`, plus `[allowed: …]` for enum issues, so a failed boot names both
the path and the bad value. Assertions in the suite are written against this shape rather than
against Zod's message wording, which has already changed once between 4.x minors.

## D16 · 2026-10-19 · Config tables are arrays, not id-keyed objects

`buildings.json` was first authored as an object keyed by building id. The Zod schema wants arrays
(spec §8.1 lists buildings as a list), and an object silently fails the whole load. Arrays also
keep the file order meaningful for display and let duplicate-id detection be a real check rather
than an impossibility.

## D17 · 2026-10-19 · `GRID`/`GridGeometry` live in `src/config/geometry.ts`, and `deepClone` in `src/state/clone.ts`

Deviation from the Phase 1 file list as planned in PROGRESS.md: the grid constants were pulled out
of `state/index.ts` into their own module so `grid/` can import them without a cycle, and the clone
sits beside the state it clones for the same reason. `packages/game-data/tsconfig.build.json` was
deleted — `build` and `typecheck` are both `tsc --noEmit` there, because `exports` points at source
(D2) and nothing consumes `dist/` yet. The planned `gen:balance` script was dropped: there are no
curve parameters to generate from yet.

## D18 · 2026-10-19 · A level table is valid only as exactly `[1, 2, 3, …]`

Gate A1. The old validator checked "contiguous" and "in order" separately, and neither
implied the first level is 1 — a table of `[2]` or `[2, 3]` passed every check. Replaced
by the single predicate `level === index + 1`, which subsumes ordering, gaps,
duplicates and the start-at-1 rule. One message names the building and the supplied
sequence, so a broken table produces one complaint instead of two.

- **Impact:** a generated table that accidentally starts at level 2 now fails at load
  time instead of silently making level 1 unreachable and shifting every cost index.

## D19 · 2026-10-19 · `invalid_rect` is a first-class grid conflict reason

Gate A2. `Number.isInteger` rejects `NaN`, `±Infinity`, `undefined`, strings and
fractions, so `isValidRect` is a single predicate for "this is a rectangle". It is
checked **before** bounds in `findConflict`, because a malformed rectangle cannot be
bounds-checked meaningfully and a loop over it executes zero times — which is exactly
how the bug hid. `fill`/`clear` throw and `forEachCell` no-ops, so the mutating API
cannot silently accept one either.

- **Why a conflict reason rather than an exception:** it keeps the grid pure and lets the
  command layer map it to a stable `invalid_rect` error code, matching the existing
  bounds/margin/occupancy pattern.
- **Impact:** `CellConflict.reason` and `CommandErrorCode` each gained one member. The
  ordering for valid rectangles (bounds → margin → occupancy) is unchanged.

## D20 · 2026-10-19 · Command payloads are validated at runtime, not by their types

Gate A2. `GameCommand` is a TypeScript type, and types do not validate data that arrives
over the wire. Every coordinate is now checked with `requireTileCoordinate` before any
grid arithmetic, and `command.id` / `ctx.now` were already checked.

- **Why:** a tampered client sending `{ x: NaN }` would previously sail through the type
  and be treated as "no conflict", placing a building at a nonsensical position.
- **Impact:** rejections are `invalid_command`, matching the existing envelope checks.

## D21 · 2026-10-19 · No silent footprint fallback for unknown entities

Gate A5. `buildGrid` used `def?.size.w ?? 1`, which let an entity whose definition was
missing from the config be rebuilt into the grid as 1×1 — a phantom size that made the
grid disagree with the config and could let an unknown entity be treated as a legal
placement. A missing definition is now a typed `unknown_building`/`unknown_obstacle`
error and a malformed instance is `invalid_state`.

- **Why:** "fail loudly on bad data" is the config loader's whole contract; silently
  substituting a size contradicts it. Balance and geometry come from validated config or
  not at all.
- **Impact:** `buildGrid` returns `OccupancyGrid | CommandError` instead of throwing, so a
  state/config mismatch surfaces as a typed command result rather than an exception.

## D22 · 2026-10-19 · The RNG round-trip test must snapshot the high-bit state itself

Gate A3. The previous test observed that a high-bit state occurred _somewhere_ in a loop
and then serialized the final state, so it never proved the high-bit state round-trips —
which was the exact regression it was written for. It now captures the snapshot at the
moment `state > 0x7fffffff`, asserts exact state equality, and compares five subsequent
draws; a second test round-trips every high-bit state in a 20,000-draw run and asserts
more than 1,000 such states were exercised.

## D23 · 2026-10-19 · Benchmarks must measure the function they name

Gate A4. The "10,000 clones" measurement called `createNewPlayerState`, which builds a
state from config — cheaper and structurally different from deep-copying an existing one.
It now calls the exported `clonePlayerState` on a representative nested state, consumes
the result via a checksum, and asserts the clone is neither the input object nor a
different hash.

- **Why:** a benchmark that measures the wrong function is worse than no benchmark — it
  makes the real cost invisible.
- **Impact:** the reported figure moved from ~13 ms to ~40 ms, i.e. the clone is roughly
  3× more expensive than the number that was being published.

## D24 · 2026-10-19 · `docs/VERIFICATION_PROMPT.md` is corrected against source, not the reverse

Gate A6. Several Phase 1 claims in the verification prompt did not match the code: the
grid API was listed as having `set()`/`toIds()` (it has `fill`/`clear`/`forEachCell`),
`RemoveObstacle` was described as a stub reward (it reads `def.reward`, credits resources
and emits both `ObstacleRemoved` and `ResourcesChanged`), `hashString` was described as
"FNV-1a → base36" (it is FNV-1a concatenated with sdbm, 16 lowercase hex chars), and
anchored Vite aliases were claimed as tested when no test checked them.

The working code was left alone and the prose corrected, except for the alias claim, where
the missing assertion was **added** to `test/config.test.ts` rather than the claim being
narrowed — the property is real and worth enforcing.

- **Impact:** the verification prompt now distinguishes source-verified facts from claims,
  and a reviewer re-running it against the current branch gets the same numbers.

## D25 · 2026-10-19 · The buffer is explicit (`amount`/`remainder`/`lastAccruedAt`), not `bufferStartedAt`

The spec's §8.2 sketch offers `bufferStartedAt?` as the single buffer field. Phase 2 needs
three things that field cannot express: how much is currently held (so collection is a
read, not a recomputation), the exact fractional carry (so command frequency cannot change
production), and a watermark that survives a collection.

- `amount` — whole units held. Capped by `bufferCap`; overflow is discarded, never banked.
- `remainder` — the exact fractional production still owed, stored as an **integer numerator
  over `economy.msPerHour`**. This is the part that matters: rounding it to fixed-point per
  call loses up to a unit per invocation, so six 6,000 ms catch-ups would produce 996
  fixed-point units where one 36,000 ms call produces 1,000. The exact numerator makes the
  two indistinguishable, which is what "command frequency must not change output" requires.
- `lastAccruedAt` — the watermark. Advances even when the buffer is full, which is what makes
  "time spent full is not banked" true rather than merely asserted.

A collector that has never produced anything keeps `buffer` absent, so a catch-up at the
current timestamp does not add fields to the state.

## D26 · 2026-10-19 · HP growth is ×1.4 per level, an explicit conservative default

The spec gives no HP curve. It states exactly one level-scaling figure numerically — "Wall:
Level scaling ×1.4/level" (§7.9) — and ×1.4 is also the ratio the hand-authored tables
already used. So ×1.4 is used for every building, applied uniformly, with the rationale
recorded here rather than a silent per-building guess.

This is the most likely number to be revised in playtesting; because it is a single curve
parameter in `scripts/balance.config.ts`, revising it is a one-line change plus a
regeneration, not a code change. The generator test asserts the ×1.4 relationship at every
level, so a deliberate change to the curve fails loudly rather than drifting.

## D27 · 2026-10-19 · `PlaceBuilding` now costs resources and occupies a builder

Phase 1 treated placement as a free, instant layout edit. That contradicts §7.5 ("each
upgrade/construction occupies one builder until finished") and, more importantly, it broke
the economy: a player could place unlimited gold stores for nothing and never hit a storage
cap, which would have made the seven-day playthrough meaningless.

A construction now charges the level-1 cost, occupies a builder for the level-1 build time,
and records the building at `level: 0` with `upgrade: { toLevel: 1, finishAt }`. Level 0
contributes no HP, no storage and no production until the builder finishes — which is the
correct reading of "under construction", and is enforced by `levelDef` returning `undefined`
for a level the table does not contain.

`MoveBuilding` and `RemoveObstacle` are deliberately **not** changed: §8.3 groups all three
under "Layout editing", and changing only one of the three would be inconsistent. The config's
obstacle `removalSeconds` remains unenforced and is recorded as a known gap.

## D28 · 2026-10-19 · `productionPerHour` and `bufferCap` are bounded at 1,000,000

Not a game-design bound — an arithmetic-safety bound. Production is computed as
`restMs * rate` where `restMs < msPerHour` (3.6e6); at the maximum rate that product stays
under 3.6e12, comfortably inside the 2^53 exact-integer range. A larger configured rate
would silently produce non-integer accruals, which is the one failure mode this whole design
exists to prevent. The bound lives in the schema, so bad balance data is rejected at import
rather than producing wrong numbers at runtime.

## D29 · 2026-10-19 · `checkSemantics` and `checkEconomy` are exported for direct testing

Several semantic rules are deliberately redundant with the Zod schema (positive builder
prices, refund fractions in [0, 1]). That redundancy is intentional defense in depth, but it
made those branches untestable through `validateGameConfig`, because Zod rejects the input
first. Exporting the checkers lets the semantic layer be unit-tested directly on a
hand-patched config.

The alternative — deleting the redundant checks — was rejected: the schema is the contract
for _shape_, the semantic checks are the contract for _coherence_, and a config assembled in
code rather than parsed from JSON should still be checked for coherence.

## D30 · 2026-10-19 · §7.3's per-building columns are quantity ceilings, not level ceilings

The §7.3 table has one column titled **"Max bldg level"** and eleven per-building columns
(`Gold Mine`, `Essence Well`, `Gold Store`, `Ess. Store`, `Barracks`, `Camp`, `Ballista`,
`Watchtower`, `Catapult`, `Skyspear`, `Walls (max)`). The generator originally read the
per-building columns as level ceilings, which produced nonsense: `gold_store` level 2 required
Keep 3 even though the "Max bldg level" column says Keep 1 allows level 2, and a Gold Store
would have been uncapped in level but capped at one instance by the same number.

The columns are counts. Three pieces of evidence settle it:

- `Walls (max)` runs 0 / 25 / 50 / 75 / 100 / 125. A wall _level_ of 125 is meaningless; the
  numbers are the classic wall allowance (none at Keep 1, then 25 per Keep step).
- The column values for every building are the number of instances a player owns at that Keep
  in the reference game, not its max level.
- The prose says "Its level limits **how many of each building you may own** and the maximum
  level of each building" — two separate rules, and the table has exactly two kinds of column
  to carry them.

So `requiredKeepFor(level)` reads **only** the "Max bldg level" column for every building, and
the per-building columns are transcribed separately into `KEEP_COUNT_LIMITS`, emitted as
`data/limits.json`, and enforced by the command layer. This also removes a circular dependency
that the old reading created: the gating function no longer needs to know which building it is
being asked about.

Consequence: `gold_store` levels 2 and 3 require Keep 1 and 2 (not 3 and 6), and the shipped
`data/buildings.json` was regenerated. The playthrough was re-measured against the corrected
tables and the chronological catch-up: Keep 3 is reached at 13.15 h, not the 10.61 h the
superseded run recorded.

## D31 · 2026-10-19 · Cancelling a level-0 construction removes the building

A construction is a building at `level: 0` with `upgrade: { toLevel: 1 }`. Cancelling it could
either leave the level-0 record in place (an orphan that occupies tiles, counts against the
quantity ceiling and renders nothing) or delete it. Deleting is the only coherent choice: the
building never existed at any playable level, §7.5 charges a 0 refund for started work, and
`MoveBuilding`-style layout editing is not what `CancelUpgrade` means.

The command removes the building, frees the builder and emits `BuildingRemoved` after
`UpgradeCancelled`, so a client can cancel its construction animation and drop the sprite. A
normal upgrade (level ≥ 1) keeps the building at its current level, as before.

## D32 · 2026-10-19 · One canonical Keep, five builders, integer speed-up rounding

Three invariants that the runtime already relied on are now enforced where a bad balance
table can be caught: at validation time.

**The Keep has one identity.** `findKeep`, `catchUp` and `SpeedUp` locate the Keep by the
literal id `keep`, not by category. Validation therefore requires exactly one `hq` definition
_and_ requires that definition to carry `KEEP_BUILDING_ID`. Without the second half, a config
could rename the HQ and still pass: the runtime would never raise `keepLevel`, and the
`maxKeeps` ceiling would be checked against a building the game never treats as the Keep. The
ceiling now applies to every `hq` row rather than only the first one found, so a second HQ
cannot carry a larger count in its own row.

The alternative — teaching the runtime to find the Keep by category — was rejected as a larger
change: it would touch `state`, `economy` and `commands` and would still leave the id/category
pairing unchecked, whereas one validation rule makes the existing literals provably correct.

**The builder ceiling is a rule, not a tunable.** Spec §7.5 states "max 5". `MAX_BUILDERS` is a
single exported constant; `checkEconomy` rejects a larger `maxBuilders` instead of clamping it,
so an over-eager balance table fails loudly at import. The existing checks (positive integer,
not below the starter count, exactly `maxBuilders - starter.builders` prices, positive integer
gem prices) are unchanged.

**Speed-up interpolation is integer arithmetic.** Spec §6.4 requires integer/fixed-point
simulation maths, but the cost curve interpolated with a floating-point ratio and rounded
afterwards. It now computes `deltaGems * offsetMs / span` with BigInt intermediates and
half-up rounding — `floor((2n + span) / (2 * span))` — which is exactly `Math.round` for the
non-negative prices the validator admits, and stays exact for any schema-valid anchor pair
where `deltaGems * offsetMs` would exceed `Number.MAX_SAFE_INTEGER`. Anchors, prices and the
final `minimumGems` rule are unchanged.

## D33 · 2026-10-19 · Speed-up anchors are bounded by their arithmetic, not by taste

`speedUpCost` converts anchor seconds to milliseconds (`seconds * 1000`) and feeds
`deltaGems * offsetMs` and `span` to `BigInt`. Two things therefore have to be true of a
schema-valid anchor, and neither was checked:

- `seconds * 1000` must be an exact integer. `MAX_SPEED_UP_SECONDS` is
  `Math.floor(Number.MAX_SAFE_INTEGER / 1000)` = 9,007,199,254,740. One second more and the
  product is no longer safe: at `Number.MAX_SAFE_INTEGER` seconds it is 24 ms low, so the
  interpolation is silently wrong rather than loudly broken.
- Prices must be exactly representable, because the interpolated result is returned as a
  normal number. `MAX_SPEED_UP_GEMS` is `Number.MAX_SAFE_INTEGER`, applied to both anchor
  `gems` and `minimumGems`.

The bounds live in `config/types.ts` beside the other game-rule constants and are enforced by
the Zod schema, so an out-of-range table is rejected at load with the limit named — never
clamped.

Worth recording precisely, because the review report described it slightly differently: with
the Zod 4 `.int()` in use, a non-safe integer was already rejected, so `Infinity` was not
reachable _through_ `validateGameConfig`. The reachable defects were the silent 24 ms
inaccuracy at large-but-accepted seconds, and a real `RangeError` from `BigInt(Infinity)` for
a config assembled in code — which is exactly the case D29 says must still be coherent. The
explicit bounds fix both and stop depending on a validator implementation detail.

Anchors, prices, interpolation, half-up rounding and the `minimumGems` rule are unchanged.

## D34 · 2026-10-19 · `speedUpCost` ignores anchors it cannot place exactly

D33 bounded what validation _admits_, but `speedUpCost` is a pure exported function, and a
caller can hand it a config that never passed `validateGameConfig`. With anchors
`{ seconds: 1, gems: 1 }` and `{ seconds: Number.MAX_VALUE, gems: 2 }`, any finite duration
between them makes the segment span `Infinity`, and `BigInt(span)` raised a native
`RangeError` — a crash escaping a pricing function.

The function now sanitises its own input before any millisecond arithmetic:

- the floor becomes `minimumGems` when that is a positive safe integer, otherwise `1`;
- an anchor is **dropped** when its `seconds` is not a positive safe integer, when
  `seconds * 1000` is not a safe integer, or when its `gems` is not a non-negative safe
  integer;
- if no anchor survives, the result is the floor.

Drop rather than clamp: clamping a malformed anchor would invent a curve position the config
never specified, whereas dropping keeps every _valid_ anchor exactly where it was. For the
reported case the surviving anchor is `{ 1 s, 1 gem }`, so the curve is flat at 1 gem — a
safe integer, deterministic, and the same value the function already returns above its last
anchor.

This is a no-op for validated configs: every anchor of a valid table survives sanitising, so
the sort order, interpolation, half-up rounding, `minimumGems` rule, clamping and determinism
are byte-for-byte what D32 and D33 established. The schema bounds stay in place — this guard
is a second line of defence for direct callers, not a relaxation of the first.

## D35 · 2026-10-21 · Phase 3 browser test: Playwright Clock, derived coordinates, no test hooks

The Phase 3 "Tests" line in `docs/GAME_SPEC.md` asks for a Playwright smoke test of
_new game → place mine → wait (mock time) → collect → upgrade_. Four choices shaped it.

**Playwright, pinned at the root.** `@playwright/test` is an exact-version root devDependency
(`1.64.1`), so the browser build and the API move together and CI cannot silently pick up a new
major. The lockfile is generated by pnpm only.

**`e2e/` + `*.spec.ts`.** Vitest collects `**/*.test.ts` under `packages/`, `apps/` and `test/`,
so a separate directory _and_ a separate suffix keep the browser suite out of the unit run
without an exclusion list that could rot.

**Clock instead of sleeps.** `page.clock.install()` is called before `page.goto()`, because the
scene seeds its economy from `Date.now()` inside `create()`. After `install` the clock still
flows in real time (so Phaser animates and input is dispatched normally); the test then jumps it
forward instead of waiting. A jump is `fastForward(ms)` plus a little over a second of
`runFor`: the economy accrues from timestamps — `catchUp` walks completions in chronological
order and carries the fractional production remainder exactly — so one catch-up spanning a
minute yields precisely the state sixty one-second catch-ups would, while painting every frame
of that minute costs thousands of software-rendered frames (the first CI run timed out doing
exactly that). The `runFor` tail carries the scene's one-second HUD tick past its threshold,
which is what repaints the panel from the caught-up state. Between jumps the test calls
`pauseAt()` to pin the clock, so the resource numbers asserted afterwards are exact rather than
"about four" — without it, however long an assertion takes becomes extra production time.

**Coordinates from the client's own maths.** The test does not hard-code canvas pixels. It
replays `BootScene.recenter()` — `centerOnWorld(worldSizeForGrid(GRID.total, TILE_WIDTH,
TILE_HEIGHT))`, then `tileCenterToScreen` → `worldToScreen` — from `iso.ts`,
`cameraTransform.ts` and the sim-core grid. The result is verified against the running game
before it is used: the test hovers the computed point and asserts the HUD's own "Tile 24, 24"
readout, so a drifted camera fails loudly instead of clicking empty grass.

**No production test hooks.** Nothing in `apps/client` was changed to make this work. The HUD is
already real DOM with roles, labels, ids and test ids, and the geometry is already exported as
pure functions. Keeping it that way means the test exercises exactly what a player gets; the
alternative — a `window.__game` handle — would test a different program.

CI runs one worker with no retries. A retry would hide the flakiness this test exists to catch;
the fixed viewport, fixed clock and single Chromium project are what make one worker enough.

## D36 — Local village persistence

Phase 3 asks for "local persistence in IndexedDB (temporary), autosave on every command, safe
migration versioning". Six choices shaped it.

**IndexedDB, not `localStorage`.** The spec names IndexedDB, and it is the right tool: the state is
a structured object rather than a string, writes are transactional, and `localStorage` is
synchronous — a village saved on the main thread after every command would jank the game.

**Two versions, not one.** The IndexedDB _database_ version describes the on-disk layout (which
object stores and indexes exist). The record's `schemaVersion` describes the shape of the value
inside that store. Bumping the database version for every field change would force an
`onupgradeneeded` round trip, and a blocked-upgrade dance between tabs, for what is only JSON.
They are therefore independent, and only the envelope changes when the save format changes.

**No invented migration history.** `SAVE_SCHEMA_VERSION` is 1 and no player has ever written
another format, so the migration registry ships empty. A fictional v0 would mean maintaining a
format that never existed and testing a conversion nothing produces. The dispatch is still real and
tested: `migrateSave` takes the registry and a target version, so a test can prove that migrations
run in order, that a gap in the chain is refused, and that a throwing migration is reported without
touching the input. When v2 arrives it is one entry in `SAVE_MIGRATIONS`.

**A rejected record is never overwritten.** If the stored save is malformed, from a future schema,
or written against another config, the game starts a fresh village _in memory_ with saving
disabled, and the record stays exactly as it was. Seeding a starter village and autosaving it is
the tempting behaviour and would destroy the player's only copy — the one thing a persistence layer
must never do.

**Save commands and completions, not ticks.** "Autosave on every state change" would write once a
second, because `catchUp` accrues collector production every second. It is also unnecessary:
`buffer.lastAccruedAt` plus the exact `remainder` numerator make production a pure function of
elapsed time, so a reload recomputes precisely what a live village would have earned. The autosave
therefore fires after accepted commands (placement, collection, upgrade start) and when `catchUp`
reports completion events — the changes that are _not_ derivable.

**One write in flight.** The autosave takes the pending snapshot before awaiting the write and
keeps only the newest queued state, so a slow write can never land on top of a newer one. A
revision counter makes that ordering observable, and a test stalls the first write to prove it.

Two smaller consequences. The village is resolved _before_ the Phaser game is constructed, because
starting on a placeholder and swapping it out would let an early tap mutate state the swap then
discards. And `sim-core` is untouched: `catchUp` still receives an explicit `now`, injected from
`main.ts`.

**A stored `null` is a record, not an empty slot.** IndexedDB returns `undefined` for a missing
key, so only `undefined` may mean "new player". A `null` under the key is something a writer
actually put there; treating it as empty would seed a starter village over it. It goes through
validation like any other value, is rejected as malformed, and is left in place.

**The whole state is validated, not just its envelope.** The envelope only proves that a record is
an object with a plausible schema and config version; a save could still carry impossible content —
a level no config defines, a builder assigned to a building that is not in the save, a negative
research level — and either crash the restore or leave a village the engine cannot advance.
`validatePersistedState` now checks the invariants the engine itself relies on: entity ids and
footprints against the real config and the same placement rules (`isBuildableTile`, `isMapTile`,
`rectsOverlap`), upgrade targets and builder assignments agreeing with each other, collector
buffers against the producing level's cap and the state watermark, and queue/research/army
counters. It reuses `sim-core` helpers rather than duplicating the engine, and adds nothing to
`sim-core` that only a browser needs.

**A clock behind the save makes the session read-only, not just write-less.** `restoreVillage`
already refused to replay time backwards, and bootstrap turned that into `autosave: null` plus a
localised warning. That was not enough: `BootScene.getNow()` clamps `Date.now()` up to
`lastSyncAt`, so `applyCommand` saw a timestamp that was already reached and happily accepted
placements, collections and upgrades — mutating a village that could never be written back. The
player would have "progressed" and lost it on the next reload, which is worse than being stopped.

Every state-changing interaction now goes through `runVillageAction` (`src/villageActions.ts`),
which refuses outright when the problem is `clock_behind`. `applyCommand` remains the only rules
engine; this is a gate in front of it, not a copy of it. Deleting the gate makes seven tests fail,
so it cannot be quietly refactored away. Viewing, selection, panning and zooming are untouched, and
the warning names the remedy: correct the clock, then reload. `hud.readOnly` repeats that in the
hint line whenever an action is refused.

**Validation is a boundary, not a trust exercise.** `isKeepLevelConsistent` is a `sim-core` helper
typed against `PlayerState`; it reads `building.type` without re-checking structure. Calling it on a
raw, not-yet-validated `buildings` array meant a single `null` entry threw `TypeError` out of
validation — and because only `storage.read()` was guarded, that surfaced as "storage unavailable".
The player was told their browser had failed when in fact their record was bad. Two changes: the
Keep check now runs only when every building entry passed structural validation, and `loadVillage`
wraps migration + validation so an unexpected throw is reported as `malformed`, which is also what
the HUD shows. Structural junk is still rejected; genuinely unknown content is still _unknown_, and
nothing is deleted or overwritten either way. One small inaccuracy was accepted deliberately: an
entry that is an object with a valid `id` and `type` is treated as structurally sound for the Keep
check even if other fields are malformed, because the helper only reads those two fields.

`fake-indexeddb` is a client devDependency, added through pnpm. It provides a real IndexedDB
implementation in Node, so the storage tests exercise transactions, `onupgradeneeded` and
structured cloning rather than a hand-written JSON stub. One additional hand-written double covers
the case the real implementation cannot easily produce: a `put` request that succeeds and a
transaction that then fails to commit.

## D37 — 2026-10-21 · Persistence is a safety boundary, not a serialisation step

A second pass over the persistence layer, this time auditing it against the simulation it has to
survive rather than against its own happy path, found six defects. Each one is recorded here with
the rule that now prevents it.

**Sparse arrays are malformed, not "absent".** Every validator used `Array.prototype.forEach`,
which skips index holes. A record with `delete state.buildings[3]` therefore validated as if index 3
had never been mentioned, while `for…of`, `.filter()` and `.map()` downstream all read `undefined`,
and `findKeep`'s `.find()` visits holes and threw. Arrays in a save are now walked by index, every
hole is reported as a problem, the remaining entries are still validated individually, and nothing
is shifted or filled: repairing a malformed save silently would hide the corruption and, in the
worst case, silently delete a building. Density is part of structural soundness, because the
`sim-core` Keep helper is gated on it. Note that IndexedDB's structured clone preserves holes
(`1 in clone === false`), so this is reachable in practice and not only via hand-made JSON.

**Scheduled work must be reachable from the watermark.** `catchUp` completes jobs whose
`finishAt <= now`, but `nextCompletionAt` ignores timestamps before `state.lastSyncAt`. An upgrade
or queue item scheduled earlier than the watermark could therefore never complete and its builder
was never freed — a village permanently one builder short, with no action a player could take. A
persisted `finishAt` is now required to be `>= state.lastSyncAt`. Equality is the valid boundary,
not a rejection: `catchUp` applies completions at the cursor first, so `finishAt === lastSyncAt` is
a job that completes on the next catch-up. The stored timestamp is never adjusted to make a record
acceptable.

**Research is deliberately not covered by that rule.** `catchUp` has no research completion path at
all; `nextCompletionAt` considers upgrades and training queues only. Requiring a temporal rule for
research would invent engine behaviour that does not exist, so its shape and level bounds are
validated and nothing more. This is a known gap in the simulation, recorded rather than papered
over with a check that implies coverage the engine does not have.

**Safe integers, and one below the maximum for ids.** `Number.isInteger(2 ** 53)` is `true`, but
`2 ** 53 + 1 === 2 ** 53`, so an entity id at that value makes `highestEntityId() + 1` produce an
id that already exists. Ids are now safe integers capped at `Number.MAX_SAFE_INTEGER - 1`, leaving
room for the allocator to increment. Coordinates, levels, caps, balances, queue lengths, trophy
counts, tutorial steps, buffer numerators and timestamps are safe integers, non-negative where the
engine treats them as non-negative, and checked against configured domains (grid bounds, level
tables, building/queue caps) where the config establishes them. Content that is merely unusual is
still accepted: the rule is "the engine must be able to compute with this", not "this looks like
the starter village".

**Counts, Keep requirements and capacity are checked with the engine's own helpers.**
`limits.buildingCounts` is enforced per type at the player's Keep level, counting buildings under
construction the way the simulation does, because a save with more Gold Mines than the Keep allows
would otherwise be a village the engine could never have produced and cannot gate consistently.
`maxKeeps` is enforced. `requiresKeep` is checked both for completed levels and for the target of
an in-flight upgrade, against the _completed_ Keep level — an upgrade in flight does not unlock
anything. Resource balances are checked against `storageCapacity` for the level actually completed
(an uncapped resource stays uncapped; an absent cap is not treated as zero, and the legitimate
temporary over-cap state that collection can produce is not rejected). `buildingLimit` was exported
from `sim-core` for this rather than re-derived in the client, so the boundary and the engine cannot
drift apart.

**Every write is a compare-and-swap in one transaction.** The revision counter alone only made
ordering _observable_ within one autosave; two tabs each had a valid counter and the last writer
silently erased the other's progress. `VillageStorage.write(save, expectedRevision)` now reads the
stored revision and writes the new record inside a single `readwrite` transaction, so there is no
check-then-write window. A mismatch is a typed `conflict` carrying the stored revision — never
reported as a storage failure, because "your browser is broken" is the wrong advice — and the
autosave enters a terminal state that stops writing and stops presenting in-memory changes as
durable. An empty store is revision 0, so two tabs cannot both create a village. Sequential writes
are unaffected. This required a schema bump: the envelope is v2 and carries `revision`; a v1 record
is migrated in memory and becomes revision 1 on its next save. Nothing is written back under the
old version number, and v1 saves are never discarded. Connections close on `versionchange` so an
upgrade in another tab is not blocked forever by this one.

**A failed write must not strand the newest snapshot.** If a change queued while another write was
in flight, its debounce timer fired inside `ensureLoop` and was consumed joining the running loop.
When that write then failed, the newest snapshot stayed pending with no timer and no retry — it
would sit in memory until some unrelated change happened to schedule another save, and would be
lost on reload. Failures now always arm a bounded retry (2 s doubling to a 60 s cap), so there is
never a pending snapshot with nothing scheduled, and a store that refuses everything is retried
slowly rather than hammered. `flush()` overlapping an in-flight write joins it and resolves; the
snapshot is still written by the retry or by the next flush. `saved` is emitted only from a
committed transaction and never while a newer snapshot is pending.

**The conflict state is a visual state too.** `clock_behind` had been added to the HUD without a
style, so a session that had silently stopped saving looked exactly like a healthy one. `conflict`
and `clock_behind` now share one rule with the other non-durable states, and a test asserts the
whole set is in that one selector list, so a future state cannot be added without styling. The
status text and the hint line are asserted to agree, all text goes through `i18n`, and view-only
interaction (selection, panning, zooming) stays available in both states.

## D38 — 2026-10-21 · Move Mode is a client mode over an unchanged command

§7.1 asks for a way to rearrange the village ("drag to move a building in edit mode") and §8.3
lists `MoveBuilding` under "Layout editing". The command has existed and been tested since Phase 1;
what was missing was the interaction. Five choices shaped it.

**The preview _is_ the command.** `previewBuildingMove` runs `applyCommand(MoveBuilding)` on a
snapshot and throws the result away, exactly as `previewBuildingPlacement` does. A player therefore
sees green only where the engine would accept the move — footprint size, map bounds, the decorative
margin, occupancy (including obstacles) and the building's own tiles are all decided in one place.
Re-implementing any of that in the client would create a second rulebook that could disagree with
the authoritative one, and the disagreement would only show up as a rejected drop.

**One interaction union, not two flags.** `BootScene` used a nullable `placementType`; adding a
second nullable move field would have made "placing while moving" representable and forced every
branch to clear both. Instead `VillageInteraction` is `idle | placing | moving`, and entering a mode
assigns a variant (replacing whatever was there). Both modes share the placement banner, the ghost
layer and the Cancel button, so there is one copy of "a ghost on the map", one Cancel affordance and
one Escape branch. This is the smallest change that makes mutual exclusion structural rather than
remembered.

**A move costs nothing, because the command says so.** D27 made `PlaceBuilding` charge resources and
occupy a builder; it deliberately left `MoveBuilding` and `RemoveObstacle` free and instant, because
§8.3 groups all three as layout edits. Inventing a move cost here would have been a new rule added
by the client, so the client adds none — and the browser test asserts that resources and builders
are unchanged by a move.

**Tapping the building's own tiles ends the mode instead of re-placing it.** The command accepts
that destination as a legal no-op, but accepting it would emit an event, advance `lastSyncAt` and
write a save for a village that did not change. The UI treats it as "done": it leaves Move Mode and
says so. This is a client optimisation; the simulation's no-op contract is untouched and still
covered by its own tests.

**Read-only is checked twice, and a conflict closes the mode.** Entering Move Mode is refused in a
read-only session (a ghost would promise a drop that can never be saved), and every commit goes
through `resolveMoveAttempt` → `runVillageAction`, whose read-only gate is the one used by
placement, collection and upgrades. When an autosave conflict switches the session to read-only
mid-move, the mode is cancelled and the ghost cleared, so the screen never offers an action the
session cannot persist.

Two smaller notes. The pure module imports `runVillageAction` rather than calling `applyCommand`
directly for the commit, so the read-only gate cannot be forgotten by a future caller; the preview
imports `applyCommand` because a prediction must not depend on whether saving is on. And the
selection panel stays open during a move: it carries the building's details and its original
coordinates, which is the reference point the player is moving _from_.

## D39 · 2026-10-22 · A wall line is a stroke of unchanged `PlaceBuilding` commands

**The line is gestures, not a new command.** The simulation places one 1×1 wall at a time and every
wall is a real construction (D27): 10 Gold, 5 s and one busy builder. Adding a `PlaceWallLine`
command would have put a second placement rulebook in the protocol and let a line skip the
per-segment checks. Instead `villageWallPlacement.ts` is a pure planner over the existing command:
`extendWallPath` builds the tile path, `planWallStroke` replays it through `applyCommand` on a
rolling copy and stops at the first refusal. The preview and the commit call the same function, so
the green cells are exactly what the release will build — the same "the preview _is_ the command"
reasoning as D38, one level up.

**Why the path needs its own rules.** Sampled pointer positions are not a line. A fast drag can jump
several tiles, so `extendWallPath` fills every cell between two samples; the same tile can be
crossed twice, so repeats are dropped (one charge, one wall); and consecutive cells must share an
edge, so a diagonal delta inserts the connector cell chosen by a fixed tie-break (the horizontal
step first). All three are deterministic, which is what lets the unit tests assert that equivalent
gestures produce the same path. A diagonal drag therefore lays a staircase rather than a hole.

**Wall mode owns the primary pointer, and Cancel is the way back to panning.** In wall mode a
one-pointer primary drag grows the stroke and never pans; wheel and pinch still zoom, and every
other mode keeps its gestures untouched. Offering two meanings for one drag was rejected as
ambiguous: the mode statement says "Cancel first to pan by dragging", and the Cancel button is
visible the whole time. A second pointer, `pointercancel`, `pointerupoutside` (a release off the
canvas) and a read-only transition **discard** the draft rather than committing a gesture the player
did not clearly finish; the remaining finger lifting can never place a half-seen line.

**Release re-plans, saves once, and keeps the mode open.** The plan is recomputed at release rather
than reused from the last pointer move, because the village can change during a drag (a builder may
finish, the clock advances). Each accepted segment carries its own envelope id and the rolling draft
is adopted only after the prefix is known, so a partial line is one state and one autosave. Zero
accepted segments leave state, events and save untouched. A read-only session refuses the plan,
drops the draft and closes the mode with the existing hint, because the walls could never be saved.

**The builder cap is reported, not worked around.** Two builders mean at most two walls per stroke;
the suite drags four tiles and asserts the accepted prefix plus `all builders are busy`. Batching,
free walls or a queue would each be a balance change, and the rules are the authority.

**Keep 2 is a fixture, not a shortcut.** Walls stay locked at Keep 1 with the configured "Keep 2
required" reason, and scenario A proves a drag cannot sneak one in. The Keep 2 journey seeds a valid
schema-v2 record and lets the app restore it through the ordinary boot path; the record is checked
by the same envelope and state validators in a unit test. It is a test fixture, not proof that a
player can reach Keep 2 — Gate C item 18 stays open.
