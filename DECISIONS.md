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
