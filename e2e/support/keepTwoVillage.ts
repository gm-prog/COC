import type { PlayerState } from '../../packages/sim-core/src/state/index';
import { CONFIG_VERSION } from '../../packages/game-data/src/version';

/**
 * A **test-only** Keep 2 village, used by `e2e/phase3-wall-drag.spec.ts`.
 *
 * Walls unlock at Keep 2 (`packages/game-data/data/buildings.json`), and the
 * configured starter is Keep 1 — deliberately, so a brand-new player cannot
 * build them. The browser suite must not weaken that gate to test the drag, so
 * it seeds a valid Keep 2 record instead and lets the app restore it through the
 * normal `bootstrapVillage` path.
 *
 * This is a fixture, **not** proof that a player can reach Keep 2: the Keep
 * upgrade journey is Gate C item 18 and stays open. Nothing here is production
 * code, no validation is bypassed, and the record is written in the ordinary
 * schema-v2 envelope, so a fixture that stopped being valid would come back as
 * `unreadable` and fail the test loudly. `test/e2e-contract.test.ts` runs this
 * save through the real `checkSaveEnvelope` and `validatePersistedState` so a
 * config change fails there first, without a browser.
 *
 * The layout is the starter's, with only the Keep's completed level raised: the
 * same buildings, the same seven obstacles (including the rock at 6, 20) and the
 * same 1,000 Gold / 1,000 Essence / 50 Gems. The Keep is the only difference and
 * it is the one the fixture exists to stand in for.
 */

/** Schema version of the record written below; guarded against the real one. */
export const KEEP_TWO_SAVE_SCHEMA_VERSION = 2;

/** The starter's obstacles, ids first: `createNewPlayerState` numbers them after buildings. */
const OBSTACLES: PlayerState['obstacles'] = [
  { id: 4, type: 'tree', x: 8, y: 8 },
  { id: 5, type: 'rock', x: 6, y: 20 },
  { id: 6, type: 'tree', x: 10, y: 30 },
  { id: 7, type: 'rock', x: 38, y: 28 },
  { id: 8, type: 'tree', x: 34, y: 12 },
  { id: 9, type: 'tree', x: 12, y: 30 },
  { id: 10, type: 'rock', x: 32, y: 14 },
];

/**
 * The state a Keep 2 village would legitimately hold at `now`.
 *
 * `lastSyncAt` is the caller's clock, not a constant: the record has to be no
 * newer than the frozen browser clock, or restoration would (correctly) report
 * `clock_behind` and the scenario would test the wrong thing.
 */
export function keepTwoState(now: number): PlayerState {
  return {
    version: 1,
    configVersion: CONFIG_VERSION,
    keepLevel: 2,
    resources: { gold: 1000, essence: 1000, shards: 0, gems: 50 },
    builders: { count: 2, busy: [] },
    buildings: [
      { id: 1, type: 'keep', level: 2, x: 18, y: 18 },
      { id: 2, type: 'gold_mine', level: 1, x: 14, y: 17 },
      { id: 3, type: 'essence_well', level: 1, x: 23, y: 17 },
    ],
    obstacles: OBSTACLES.map((obstacle) => ({ ...obstacle })),
    army: {},
    trainingQueues: [],
    research: { levels: {} },
    spells: {},
    trophies: 0,
    tutorialStep: 0,
    lastSyncAt: now,
  };
}

/**
 * The complete record to put under `village/current`.
 *
 * `revision: 1` says "this store has been written once", which is what a record
 * restored from an earlier session looks like; the app's first autosave then
 * asserts revision 1 and commits revision 2, exactly as it would for a returning
 * player.
 */
export function keepTwoSave(now: number): {
  schemaVersion: number;
  savedAt: number;
  configVersion: string;
  revision: number;
  state: PlayerState;
} {
  return {
    schemaVersion: KEEP_TWO_SAVE_SCHEMA_VERSION,
    savedAt: now,
    configVersion: CONFIG_VERSION,
    revision: 1,
    state: keepTwoState(now),
  };
}
