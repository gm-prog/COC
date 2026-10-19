/**
 * Phase 1 performance and determinism benchmark.
 *
 * Run with: `pnpm bench`
 *
 * This is not a test — it prints numbers so regressions in the hot paths are
 * visible. The determinism assertions it makes are also covered by unit tests;
 * what is unique here is the cost per operation on realistic input.
 */

// The balance tables are read straight from game-data rather than imported
// through the package: sim-core must not depend on game-data (game-data depends
// on sim-core), and this is a dev script, not shipped code.
import buildings from '../../game-data/data/buildings.json' with { type: 'json' };
import economy from '../../game-data/data/economy.json' with { type: 'json' };
import obstacles from '../../game-data/data/obstacles.json' with { type: 'json' };
import starter from '../../game-data/data/starter.json' with { type: 'json' };
import { applyCommand, type GameCommand } from '../src/commands/index.js';
import { catchUp } from '../src/economy/index.js';
import { createRng, deserializeRng, nextUint32, serializeRng } from '../src/rng/index.js';
import { hashState } from '../src/serialize/index.js';
import { clonePlayerState, createNewPlayerState, type PlayerState } from '../src/state/index.js';
import { loadGameConfig } from '../src/validate/index.js';

const config = loadGameConfig({ version: '1.0.0', buildings, obstacles, economy, starter });

function timed(label: string, run: () => void): void {
  const start = process.hrtime.bigint();
  run();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms`);
}

const RNG_DRAWS = 1_000_000;
const OPENINGS = 250;
const CLONES = 10_000;

const seed = 0xc0ffee;

// --- RNG throughput and serialization round-trip ---------------------------
let checksum = 0;
timed(`rng: ${RNG_DRAWS.toLocaleString('en-US')} draws`, () => {
  let rng = createRng(seed);
  for (let i = 0; i < RNG_DRAWS; i += 1) {
    const [value, next] = nextUint32(rng);
    checksum = (checksum + value) >>> 0;
    rng = next;
  }
});

let rngForSerialization = createRng(seed);
for (let i = 0; i < RNG_DRAWS; i += 1) rngForSerialization = nextUint32(rngForSerialization)[1];
const serialized = serializeRng(rngForSerialization);
const restored = deserializeRng(serialized);
const resumed = nextUint32(restored)[0];
const original = nextUint32(rngForSerialization)[0];
console.log(`rng: checksum                     ${checksum.toString().padStart(8)}`);
console.log(`rng: round-trips exactly          ${serializeRng(restored) === serialized}`);
console.log(`rng: resumed stream matches       ${resumed === original}`);

// --- Command pipeline ------------------------------------------------------
/** Distributive `Omit`, so the union keeps its discriminant. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

// Construction occupies a builder for the level-1 build time, so each step is
// spaced far enough apart for the previous one to have finished.
const STEP_MS = 60_000;

const commands: readonly DistributiveOmit<GameCommand, 'id'>[] = [
  { type: 'PlaceBuilding', payload: { buildingType: 'gold_mine', x: 26, y: 17 } },
  { type: 'PlaceBuilding', payload: { buildingType: 'gold_mine', x: 30, y: 17 } },
  { type: 'RemoveObstacle', payload: { obstacleId: 4 } },
  { type: 'MoveBuilding', payload: { buildingId: 2, x: 34, y: 34 } },
  { type: 'CollectResource', payload: { buildingId: 2 } },
];

function openVillage(): PlayerState {
  let state = createNewPlayerState(config, 0);
  let id = 0;
  for (const command of commands) {
    id += 1;
    const result = applyCommand(
      state,
      { ...command, id: String(id) },
      { now: id * STEP_MS, config },
    );
    if (!result.ok) throw new Error(`command failed: ${result.error.code} ${result.error.message}`);
    state = result.state;
  }
  return state;
}

const hashes: string[] = [];
timed(`commands: ${OPENINGS} openings x ${commands.length} cmds`, () => {
  for (let i = 0; i < OPENINGS; i += 1) hashes.push(hashState(openVillage()));
});

const firstHash = hashes[0] as string;
console.log(`commands: hash stable over repeats ${hashes.every((hash) => hash === firstHash)}`);
console.log(`commands: hash                    ${firstHash}`);

// --- State cloning ---------------------------------------------------------
// A4: this must measure `clonePlayerState`, not `createNewPlayerState` — the
// latter builds a fresh state from config, which is a different (and much
// cheaper) operation than deep-copying an existing one.
const cloneTarget = (): PlayerState => {
  const base = createNewPlayerState(config, 0);
  base.buildings.push(
    { id: 10, type: 'gold_mine', level: 2, x: 26, y: 17 },
    { id: 11, type: 'gold_store', level: 1, x: 30, y: 17 },
  );
  base.obstacles.push({ id: 20, type: 'tree', x: 12, y: 30 });
  base.builders.busy.push({ buildingId: 10, toLevel: 3, finishAt: 60_000 });
  base.trainingQueues.push({
    barracksId: 12,
    items: [
      { troopId: 'axeman', finishAt: 10_000 },
      { troopId: 'archer', finishAt: 20_000 },
    ],
  });
  return base;
};

let cloneChecksum = 0;
timed(`state: ${CLONES.toLocaleString('en-US')} clones`, () => {
  const state = cloneTarget();
  let last: PlayerState = state;
  for (let i = 0; i < CLONES; i += 1) {
    // Clone the previous result each round so the work is a genuine deep copy
    // of a realistic nested state, and consume the result so nothing is
    // optimised away.
    last = clonePlayerState(state);
    cloneChecksum = (cloneChecksum + last.buildings.length + last.builders.busy.length) >>> 0;
  }
  // A clone must be structurally equal but not the same object.
  if (last === state) throw new Error('clone returned the input object');
  if (hashState(last) !== hashState(state)) throw new Error('clone changed the state');
});
console.log(`state: clone checksum              ${cloneChecksum.toString().padStart(8)}`);

// --- Lazy time evaluation ---------------------------------------------------
// Every mutating command runs catchUp first, so its cost over a long offline
// window is on the hot path of the whole server.
const OFFLINE_MS = 8 * 3_600_000;
const offlineBase = openVillage();

let catchUpChecksum = 0;
timed(`catchUp: ${OPENINGS} x ${OFFLINE_MS / 3_600_000} h offline`, () => {
  for (let i = 0; i < OPENINGS; i += 1) {
    // catchUp is pure, so the same input is reused; the checksum proves the
    // accrual path actually ran rather than being optimised away.
    const result = catchUp(offlineBase, OFFLINE_MS, config);
    if (!result.ok) throw new Error(`catchUp failed: ${result.error.code}`);
    catchUpChecksum = (catchUpChecksum + result.state.resources.gold) >>> 0;
  }
});
console.log(`catchUp: gold checksum             ${catchUpChecksum.toString().padStart(8)}`);
