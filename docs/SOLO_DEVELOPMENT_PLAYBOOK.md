# Emberhold: Solo Development Playbook

**Purpose:** Keep Emberhold focused on becoming a playable, enjoyable game while it is being built by one person. Use this document to choose the next milestone, decide what not to build yet, and check whether a feature is truly done.

**Design source of truth:** [`docs/GAME_SPEC.md`](GAME_SPEC.md)  
**Living implementation status:** [`PROGRESS.md`](../PROGRESS.md)  
**Design deviations and trade-offs:** [`DECISIONS.md`](../DECISIONS.md)

This playbook captures guidance researched on 20 October 2026. It is a practical guide, not a replacement for the game specification. When the plan changes, record the reason in `DECISIONS.md` and keep the living status in `PROGRESS.md` accurate.

---

## The central principle

Phase 2 gave Emberhold its first substantial economy and construction rules. The priority now is to make those systems part of a playable experience—not to keep adding systems for their own sake.

Measure progress by whether a new player can understand the game, make meaningful decisions, see progress, and want to play again. Do not measure it only by the number of systems or files in the repository.

Established developers' lessons that are useful for a solo project:

1. **Gameplay before polish.** Use placeholder art and simple interactions until the core loop is enjoyable. Avoid elaborate tools, animation, and technology that do not help prove the game.
2. **Protect the scope.** The master spec is a long-term destination, not a demand to build every troop, social feature, and monetization system immediately. Build the smallest complete version that can test the core idea.
3. **Observe players.** Watch people try the game without coaching them. Investigate repeated confusion before reacting to every individual suggestion.
4. **Integrate small changes.** Each pull request (PR) should have one clear purpose. Run checks, review the diff, and merge only when the change is healthy.
5. **Test beyond the first demo.** A feature working once is not proof that progression is understandable or that people want to return. Validate the full loop and then observe longer sessions.

The goal is not to imitate a large studio's process. Keep only the lightweight habits that reduce rework and shorten feedback loops.

## Repository baseline and current task

_Updated 21 October 2026. This section previously described the pre-Phase-3 housekeeping; that
work is finished and is summarised here rather than repeated._

- The Phase 1 + Phase 2 baseline, and every Phase 3 slice since, is merged into `main`
  (PRs #1–#9 at the time of writing). `main` is the stable source of truth; PR #1 was merged
  from the old `arena/` branch, so no long-lived branch carries unmerged work.
- `PROGRESS.md`, `README.md` and this playbook are the living status; they are updated in the
  same PR as the work they describe.
- Build future work on short-lived feature branches off `main`, keep CI green on every PR, and
  do not redo completed work because of branch history.

**Immediate task:** Phase 3 is in progress, and the browser smoke test for the
build → wait/collect → upgrade journey now exists (`e2e/`, `pnpm test:e2e`, wired into CI). The
next Phase 3 work is what that smoke test still exposes as missing: IndexedDB persistence, move
mode and drag-to-place walls, obstacle removal, and the remaining upgrade-panel controls. See
the Gate C checklist in [`PROGRESS.md`](../PROGRESS.md).

Because branch state changes over time, verify the current GitHub state before acting on these notes.

## Roadmap: build the offline game before online expansion

The order in `docs/GAME_SPEC.md` is sensible. Preserve the offline single-player milestone (Phases 0–6) before investing in cloud accounts and PvP.

### Immediate — finish the village interaction layer

- ~~Reconcile the status documents and merge the tested Phase 1 + Phase 2 baseline into `main`.~~
  Done; keep them accurate in each PR instead of catching up later.
- ~~Add a browser smoke test for the build → collect → upgrade journey.~~ Done:
  `pnpm test:e2e` runs it in CI on Chromium with a mocked clock.
- Next: local persistence (IndexedDB), move mode, obstacle removal, and the speed-up/cancel
  controls the upgrade panel still lacks.
- Configure `main` to require the relevant CI checks and disallow force-pushes where repository settings permit it.
- Keep the working tree clean and ensure secrets, local databases, and generated build output are not committed.

### Phase 3 — make a playable village

Complete the browser experience for the economy and construction rules that already exist. Keep placeholder visuals for now.

Build in small, reviewable slices, such as:

1. Render buildings, obstacles, and walls; support selection and an information panel.
2. Show resource totals and capacity, builders, construction timers, and progress.
3. Add placement feedback, placement/move modes, construction, upgrades, and collection.
4. Add relevant speed-up/cancel interactions, obstacle interactions, toasts, and floating resource feedback as specified.
5. Save locally (IndexedDB) and restore the village reliably after reload.
6. Make mouse, touch, and keyboard interaction usable.

**Phase 3 exit condition:** a new player can start a village, place a mine, wait for construction, collect resources, upgrade a building, and reach Keep 2 with correct costs, timers, storage caps, and unlock rules. Add a browser smoke test for the build → wait/collect → upgrade journey. Meet the performance and console-error expectations in `docs/GAME_SPEC.md`.

### Phase 4 — build a basic army

Add barracks, troop training queues, army camps and housing capacity, spell/laboratory systems as scoped in the spec. Start with the smallest set of contrasting troop types that can support meaningful combat. Expand the roster only after the basic training and army-management loop works.

### Phase 5 — prove battles without graphics first

Implement the deterministic, headless battle simulator and the core rules for troop behavior, walls, defenses, results, and rewards. Build fixed test scenarios. Verify that identical inputs produce identical outputs. Do not begin with elaborate battle visuals.

### Phase 6 — complete the offline loop

Add the battle client, replay, and a small campaign; connect them to the village and economy.

**Offline-loop exit condition:** a player can build a village, collect and upgrade, train an army, attack an AI village, watch the replay, and receive the expected battle result and reward.

### Phases 7+ — online systems only after the offline loop works

After the offline game is coherent and worth replaying, move to accounts/cloud saving and server-authoritative persistence (Phase 7), then asynchronous PvP (Phases 8–9). Social systems, monetization, and launch-focused expansion stay later. Do not let future online architecture block proving the core offline game.

## A lightweight weekly workflow for one person

| Stage         | Routine                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Choose**    | Pick one player-visible outcome. Write down how you will prove it works.                                               |
| **Plan**      | Identify the affected files, rules, tests, and known risks before coding.                                              |
| **Implement** | Use one short-lived feature branch and make one cohesive change at a time.                                             |
| **Verify**    | Add appropriate rule tests. Run lint, typecheck, tests, and build; test the actual browser interaction where relevant. |
| **Integrate** | Open a PR, inspect the diff, confirm CI passes, then merge. Avoid combining unrelated changes.                         |
| **Learn**     | Play the build. Write down the three most important problems and choose the next task based on them.                   |

Keep a tiny task board with only **Now**, **Next**, and **Later**. Put one substantial feature in **Now**. A large idea can stay in **Later** until the current game earns it.

### Definition of done

A feature is not done merely because it compiles. It is done when it is:

- implemented for the intended player interaction;
- covered by appropriate tests, including edge cases for game rules;
- manually tried in the game when it changes the player experience;
- documented in the relevant living file when needed;
- integrated with green CI.

Keep the existing unit tests, deterministic simulation checks, and coverage thresholds. As the browser experience grows, add browser-level smoke tests. A passing unit test cannot tell you whether a player can discover a button or understand a timer.

## Playtesting and feedback

Do not wait for launch to get feedback, but do not present a barely functional prototype as a finished game.

1. **After Phase 3:** ask a few people to complete basic village tasks. Give them a goal, then observe without explaining the controls. Watch where they get confused, what they try to click, and whether resource costs and timers make sense.
2. **After Phase 6:** ask a small group of strategy/base-building players to play through the full offline loop, including a battle and replay.
3. **After changes:** repeat the test. Prioritize a problem when multiple players make the same wrong assumption or get stuck in the same place. Ask what they expected to happen, not just whether they liked the game.

Treat feedback as evidence, not as a list of orders. Understand the problem behind a suggestion; do not automatically add every requested feature. Fix recurring core-experience problems before spending time on minor balance adjustments.

For a future PC/Steam release, Steam Playtest can provide gated feedback without affecting the main game's reviews or wishlists. Consider a Coming Soon page only once the core feature set and art direction can be represented honestly. Early Access should not be used as a label for a tech demo: the game should be genuinely playable, and plans and limitations should be communicated clearly. These launch options are later decisions, not Phase 3 priorities.

## Solo developer action checklist

Use this list to guide the next steps. Update it as repository state changes.

- [x] Reconcile `PROGRESS.md`, `PHASE2_REPORT.md`, and `README.md` with the merged Phase 2 state.
- [x] Review an integration PR that brings the tested Phase 1 + Phase 2 baseline into `main`; verify CI before merging.
- [ ] Configure appropriate required CI checks and prevent force-pushes on `main`, where settings permit.
- [x] Break Phase 3 into small PRs, beginning with visible buildings and selection, then placement and construction interactions.
- [x] Add a browser smoke test for the build → collect → upgrade journey (`e2e/`, `pnpm test:e2e`).
- [ ] Finish and playtest the complete offline loop through Phases 4–6 before starting cloud accounts or PvP.

## Research sources

These public sources informed the principles above. Their lessons are paraphrased and adapted to Emberhold's solo-development context.

- Supercell — [10 Learnings from 10 Years](https://supercell.com/en/news/10-learnings-10-years/7436/): focus, small teams, and gameplay-first development.
- Supercell — [The Best Games Haven't Been Made Yet](https://supercell.com/en/news/the-best-games-havent-been-made-yet/): lessons from testing and developing new games, including the limits of relying on large beta numbers alone.
- Game Developer — [Overcoming Struggles in Playtesting](https://www.gamedeveloper.com/design/overcoming-struggles-in-playtesting): investigate recurring player difficulties and understand the underlying problem.
- Game Developer — [Postmortem: Project Island](https://www.gamedeveloper.com/production/postmortem-project-island): protect the core experience and budget time to finish and polish it.
- DORA — [Continuous Integration](https://dora.dev/capabilities/continuous-integration/): integrate small changes frequently and use short feedback loops.
- GitHub Docs — [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): require checks and protect the stable branch.
- Valve Steamworks — [Steam Playtest](https://partner.steamgames.com/doc/features/playtest), [Early Access](https://partner.steamgames.com/doc/store/earlyaccess), and [Coming Soon](https://partner.steamgames.com/doc/store/coming_soon): later-stage playtesting and release transparency.

---

**Default decision rule:** when choosing between adding another system and making the current player journey understandable, testable, and enjoyable, choose the current player journey.
