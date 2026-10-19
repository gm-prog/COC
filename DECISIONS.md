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
