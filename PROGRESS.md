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
| 1     | Sim-core foundations                 | ⚪ Not started |
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
