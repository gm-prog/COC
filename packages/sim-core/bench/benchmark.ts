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
import obstacles from '../../game-data/data/obstacles.json' with { type: 'json' };
import starter from '../../game-data/data/starter.json' with { type: 'json' };
import { applyCommand, type GameCommand } from '../src/commands/index.js';
import { createRng, deserializeRng, nextUint32, serializeRng } from '../src/rng/index.js';
import { hashState } from '../src/serialize/index.js';
import { createNewPlayerState } from '../src/state/index.js';
import { loadGameConfig } from '../src/validate/index.js';

const config = loadGameConfig({ version: '1.0.0', buildings, obstacles, starter });

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

const commands: readonly DistributiveOmit<GameCommand, 'id'>[] = [
  { type: 'PlaceBuilding', payload: { buildingType: 'gold_mine', x: 26, y: 17 } },
  { type: 'PlaceBuilding', payload: { buildingType: 'gold_mine', x: 30, y: 17 } },
  { type: 'RemoveObstacle', payload: { obstacleId: 4 } },
  { type: 'MoveBuilding', payload: { buildingId: 2, x: 34, y: 34 } },
];

function openVillage(): string {
  let state = createNewPlayerState(config, 0);
  let id = 0;
  for (const command of commands) {
    id += 1;
    const result = applyCommand(state, { ...command, id: String(id) }, { now: id, config });
    if (!result.ok) throw new Error(`command failed: ${result.error.code} ${result.error.message}`);
    state = result.state;
  }
  return hashState(state);
}

const hashes: string[] = [];
timed(`commands: ${OPENINGS} openings x ${commands.length} cmds`, () => {
  for (let i = 0; i < OPENINGS; i += 1) hashes.push(openVillage());
});

const firstHash = hashes[0] as string;
console.log(`commands: hash stable over repeats ${hashes.every((hash) => hash === firstHash)}`);
console.log(`commands: hash                    ${firstHash}`);

// --- State cloning ---------------------------------------------------------
timed(`state: ${CLONES.toLocaleString('en-US')} clones`, () => {
  const state = createNewPlayerState(config, 0);
  for (let i = 0; i < CLONES; i += 1) {
    // Re-clone the same state; the point is the per-call cost, not the result.
    void createNewPlayerState(config, 0);
    void state;
  }
});
