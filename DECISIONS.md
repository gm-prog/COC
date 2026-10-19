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
