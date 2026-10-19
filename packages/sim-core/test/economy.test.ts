import { describe, expect, it } from 'vitest';
import {
  addResources,
  buildingDef,
  canAfford,
  catchUp,
  levelDef,
  remainingCapacity,
  storageCapacity,
} from '../src/economy/index.js';
import { createNewPlayerState, type PlayerState } from '../src/state/index.js';
import { hashState, stableStringify } from '../src/serialize/index.js';
import { NOW, TEST_CONFIG } from './fixtures/config.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const config = TEST_CONFIG;

const newState = (now = NOW): PlayerState => {
  const state = createNewPlayerState(config, now);
  // The fixture starter has no essence collector; add one so essence accrual is
  // exercised alongside gold.
  state.buildings.push({ id: 3, type: 'essence_well', level: 1, x: 23, y: 17 });
  return state;
};

/** Puts a fresh buffer on a collector so accrual starts from a known point. */
function withBuffer(state: PlayerState, buildingId: number, lastAccruedAt: number): PlayerState {
  const building = state.buildings.find((candidate) => candidate.id === buildingId);
  if (building === undefined) throw new Error(`no building ${buildingId}`);
  building.buffer = { amount: 0, remainder: 0, lastAccruedAt };
  return state;
}

const mine = (state: PlayerState) => state.buildings.find((b) => b.type === 'gold_mine');
const well = (state: PlayerState) => state.buildings.find((b) => b.type === 'essence_well');

describe('catchUp — monotonic time', () => {
  it('rejects a timestamp earlier than the state time', () => {
    const state = newState(NOW);
    const result = catchUp(state, NOW - 1, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('time_moved_backwards');
      expect(result.error.message).toContain('time cannot move backwards');
    }
  });

  it('allows the same timestamp and changes nothing', () => {
    const state = newState(NOW);
    const before = hashState(state);
    const result = catchUp(state, NOW, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(hashState(result.state)).toBe(before);
      expect(result.events).toEqual([]);
    }
  });

  it('rejects a non-integer timestamp', () => {
    const result = catchUp(newState(NOW), NOW + 0.5, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_state');
  });

  it('never mutates its input, on success or failure', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);
    const snapshot = hashState(state);

    const ok = catchUp(state, NOW + 8 * HOUR, config);
    expect(ok.ok).toBe(true);
    expect(hashState(state)).toBe(snapshot);

    const bad = catchUp(state, NOW - 5, config);
    expect(bad.ok).toBe(false);
    expect(hashState(state)).toBe(snapshot);
  });

  it('advances lastSyncAt to now', () => {
    const state = newState(NOW);
    const result = catchUp(state, NOW + 8 * HOUR, config);
    if (!result.ok) throw new Error('expected ok');
    expect(result.state.lastSyncAt).toBe(NOW + 8 * HOUR);
  });
});

describe('catchUp — eight-hour offline production', () => {
  it('accrues a full eight hours at the configured rate', () => {
    // gold_mine L1: 100/hour, buffer cap 500.
    const state = newState(NOW);
    withBuffer(state, 2, NOW);

    const result = catchUp(state, NOW + 8 * HOUR, config);
    if (!result.ok) throw new Error('expected ok');

    // 8 h x 100/h = 800, capped at the 500 buffer.
    expect(mine(result.state)?.buffer?.amount).toBe(500);
    expect(well(result.state)?.buffer?.amount).toBe(500);
  });

  it('accrues only the elapsed time, not the whole window', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);

    const oneHour = catchUp(state, NOW + HOUR, config);
    if (!oneHour.ok) throw new Error('expected ok');
    expect(mine(oneHour.state)?.buffer?.amount).toBe(100);

    const threeHours = catchUp(state, NOW + 3 * HOUR, config);
    if (!threeHours.ok) throw new Error('expected ok');
    expect(mine(threeHours.state)?.buffer?.amount).toBe(300);
  });

  it('is idempotent at the same timestamp', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);
    const first = catchUp(state, NOW + 2 * HOUR, config);
    if (!first.ok) throw new Error('expected ok');

    const second = catchUp(first.state, NOW + 2 * HOUR, config);
    if (!second.ok) throw new Error('expected ok');
    expect(hashState(second.state)).toBe(hashState(first.state));
    expect(mine(second.state)?.buffer?.amount).toBe(200);
  });

  it('accrues from the previous watermark, not from zero, on a second call', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);

    const first = catchUp(state, NOW + HOUR, config);
    if (!first.ok) throw new Error('expected ok');
    const second = catchUp(first.state, NOW + 2 * HOUR, config);
    if (!second.ok) throw new Error('expected ok');

    expect(mine(second.state)?.buffer?.amount).toBe(200);
  });
});

describe('catchUp — fractional remainders', () => {
  it('produces the same total from many short calls as from one long call', () => {
    // 100/hour = 1 unit per 36,000 ms. A 6,000 ms window is 1/6 of a unit, so
    // six of them must make exactly one whole unit — never 0 or 2.
    const base = newState(NOW);
    withBuffer(base, 2, NOW);

    const stepped = (() => {
      let state = base;
      for (let i = 1; i <= 6; i += 1) {
        const result = catchUp(state, NOW + i * 6000, config);
        if (!result.ok) throw new Error('expected ok');
        state = result.state;
      }
      return state;
    })();

    const single = catchUp(base, NOW + 36_000, config);
    if (!single.ok) throw new Error('expected ok');

    expect(mine(stepped)?.buffer?.amount).toBe(1);
    expect(mine(single.state)?.buffer?.amount).toBe(1);
    expect(hashState(stepped)).toBe(hashState(single.state));
  });

  it('keeps a sub-unit remainder instead of rounding it away', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);

    // Half a unit: 18,000 ms at 100/hour is 0.5 of a resource, carried as the
    // exact numerator 1,800,000 over msPerHour (3,600,000).
    const result = catchUp(state, NOW + 18_000, config);
    if (!result.ok) throw new Error('expected ok');

    const buffer = mine(result.state)?.buffer;
    expect(buffer?.amount).toBe(0);
    expect(buffer?.remainder).toBe(1_800_000);
  });

  it('carries the remainder forward so nothing is lost or double-counted', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);

    const first = catchUp(state, NOW + 18_000, config);
    if (!first.ok) throw new Error('expected ok');
    const second = catchUp(first.state, NOW + 36_000, config);
    if (!second.ok) throw new Error('expected ok');

    // 18,000 ms more = another half unit; the two halves make one whole unit.
    expect(mine(second.state)?.buffer?.amount).toBe(1);
    expect(mine(second.state)?.buffer?.remainder).toBe(0);
    // The second call starts from the first call's watermark, so the two halves
    // are counted once each: no double-counted time and no dropped fraction.
    expect(mine(first.state)?.buffer?.lastAccruedAt).toBe(NOW + 18_000);
  });

  it('matches a single long call over eight uneven steps', () => {
    const base = newState(NOW);
    withBuffer(base, 2, NOW);

    let stepped = base;
    let elapsed = 0;
    const steps = [7000, 13_000, 1000, 29_000, 500, 36_000, 12_345, 1];
    for (const step of steps) {
      elapsed += step;
      const result = catchUp(stepped, NOW + elapsed, config);
      if (!result.ok) throw new Error('expected ok');
      stepped = result.state;
    }

    const single = catchUp(base, NOW + elapsed, config);
    if (!single.ok) throw new Error('expected ok');
    expect(hashState(stepped)).toBe(hashState(single.state));
  });
});

describe('catchUp — buffer cap and overflow', () => {
  it('stops accruing at the buffer cap', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);
    const result = catchUp(state, NOW + 8 * HOUR, config);
    if (!result.ok) throw new Error('expected ok');
    expect(mine(result.state)?.buffer?.amount).toBe(500); // cap, not 800
  });

  it('does not bank the time spent full', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);

    // Fill the buffer (5 h at 100/h), then keep it full for 3 more hours.
    const filled = catchUp(state, NOW + 5 * HOUR, config);
    if (!filled.ok) throw new Error('expected ok');
    expect(mine(filled.state)?.buffer?.amount).toBe(500);

    const later = catchUp(filled.state, NOW + 8 * HOUR, config);
    if (!later.ok) throw new Error('expected ok');

    // Still exactly the cap: the 3 h spent full produced nothing banked.
    expect(mine(later.state)?.buffer?.amount).toBe(500);
    expect(mine(later.state)?.buffer?.remainder).toBe(0);
  });

  it('discards the fractional carry produced while full', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);

    // Fill to the cap, then add a partial unit that cannot fit.
    const filled = catchUp(state, NOW + 5 * HOUR, config);
    if (!filled.ok) throw new Error('expected ok');
    const partial = catchUp(filled.state, NOW + 5 * HOUR + 18_000, config);
    if (!partial.ok) throw new Error('expected ok');

    expect(mine(partial.state)?.buffer?.amount).toBe(500);
    expect(mine(partial.state)?.buffer?.remainder).toBe(0);
  });

  it('resumes accruing after the buffer is emptied', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);

    const filled = catchUp(state, NOW + 5 * HOUR, config);
    if (!filled.ok) throw new Error('expected ok');
    // Simulate a collection: the buffer empties but the watermark stays put.
    if (filled.state.buildings[1]?.buffer !== undefined) {
      filled.state.buildings[1].buffer.amount = 0;
    }

    const later = catchUp(filled.state, NOW + 6 * HOUR, config);
    if (!later.ok) throw new Error('expected ok');
    expect(mine(later.state)?.buffer?.amount).toBe(100);
  });
});

describe('catchUp — upgrades', () => {
  const upgrading = (finishAt: number): PlayerState => {
    const state = newState(NOW);
    state.builders.busy.push({ buildingId: 2, toLevel: 2, finishAt });
    const building = mine(state);
    if (building !== undefined) building.upgrade = { toLevel: 2, finishAt };
    return state;
  };

  it('completes an upgrade whose finish time has passed', () => {
    const state = upgrading(NOW + 20_000);
    const result = catchUp(state, NOW + 20_000, config);
    if (!result.ok) throw new Error('expected ok');

    expect(mine(result.state)?.level).toBe(2);
    expect(mine(result.state)?.upgrade).toBeUndefined();
    expect(result.state.builders.busy).toEqual([]);
    expect(result.events).toEqual([
      {
        type: 'UpgradeFinished',
        buildingId: 2,
        buildingType: 'gold_mine',
        fromLevel: 1,
        toLevel: 2,
      },
    ]);
  });

  it('leaves an unfinished upgrade alone', () => {
    const state = upgrading(NOW + 20_000);
    const result = catchUp(state, NOW + 19_999, config);
    if (!result.ok) throw new Error('expected ok');

    expect(mine(result.state)?.level).toBe(1);
    expect(mine(result.state)?.upgrade).toEqual({ toLevel: 2, finishAt: NOW + 20_000 });
    expect(result.state.builders.busy).toHaveLength(1);
    expect(result.events).toEqual([]);
  });

  it('updates keepLevel when the Keep finishes', () => {
    const state = newState(NOW);
    const keep = state.buildings.find((b) => b.type === 'keep');
    if (keep === undefined) throw new Error('no keep');
    keep.upgrade = { toLevel: 2, finishAt: NOW + 300_000 };
    state.builders.busy.push({ buildingId: keep.id, toLevel: 2, finishAt: NOW + 300_000 });

    const result = catchUp(state, NOW + 300_000, config);
    if (!result.ok) throw new Error('expected ok');
    expect(result.state.keepLevel).toBe(2);
    expect(keep.level).toBe(1); // input untouched
  });

  it('completes several upgrades in ascending building-id order', () => {
    const state = newState(NOW);
    // A second collector so two different buildings can be upgrading at once.
    state.buildings.push({ id: 4, type: 'gold_mine', level: 1, x: 26, y: 17 });
    // Deliberately push the higher id first: the event order must not depend on
    // the order the busy list was assembled in.
    state.builders.busy.push({ buildingId: 4, toLevel: 2, finishAt: NOW + 1000 });
    state.builders.busy.push({ buildingId: 2, toLevel: 2, finishAt: NOW + 1000 });
    for (const id of [2, 4]) {
      const building = state.buildings.find((b) => b.id === id);
      if (building !== undefined) building.upgrade = { toLevel: 2, finishAt: NOW + 1000 };
    }

    const result = catchUp(state, NOW + 1000, config);
    if (!result.ok) throw new Error('expected ok');
    expect(result.events.map((event) => (event as { buildingId: number }).buildingId)).toEqual([
      2, 4,
    ]);
    expect(result.state.builders.busy).toEqual([]);
  });

  it('releases exactly the finished builders', () => {
    const state = newState(NOW);
    state.builders.busy.push({ buildingId: 2, toLevel: 2, finishAt: NOW + 1000 });
    state.buildings.push({ id: 4, type: 'gold_mine', level: 1, x: 26, y: 17 });
    state.builders.busy.push({ buildingId: 4, toLevel: 2, finishAt: NOW + 999_999 });
    for (const id of [2, 4]) {
      const building = state.buildings.find((b) => b.id === id);
      if (building !== undefined) {
        building.upgrade = { toLevel: 2, finishAt: NOW + (id === 2 ? 1000 : 999_999) };
      }
    }

    const result = catchUp(state, NOW + 1000, config);
    if (!result.ok) throw new Error('expected ok');
    expect(result.state.builders.busy).toEqual([
      { buildingId: 4, toLevel: 2, finishAt: NOW + 999_999 },
    ]);
  });
});

describe('catchUp — training queues', () => {
  it('moves completed items into the army in FIFO order per barracks', () => {
    const state = newState(NOW);
    state.trainingQueues = [
      {
        barracksId: 10,
        items: [
          { troopId: 'axeman', finishAt: NOW + 1000 },
          { troopId: 'axeman', finishAt: NOW + 2000 },
          { troopId: 'archer', finishAt: NOW + 3000 },
        ],
      },
    ];

    const result = catchUp(state, NOW + 2500, config);
    if (!result.ok) throw new Error('expected ok');

    expect(result.state.army).toEqual({ axeman: 2 });
    expect(result.state.trainingQueues[0]?.items).toEqual([
      { troopId: 'archer', finishAt: NOW + 3000 },
    ]);
    // Catch-up is chronological, so items finishing at different instants are
    // reported at their own instants rather than collapsed into one batch.
    expect(result.events).toEqual([
      { type: 'TrainingCompleted', barracksId: 10, troopId: 'axeman', count: 1 },
      { type: 'TrainingCompleted', barracksId: 10, troopId: 'axeman', count: 1 },
    ]);
  });

  it('adds to an existing army count rather than replacing it', () => {
    const state = newState(NOW);
    state.army = { axeman: 4 };
    state.trainingQueues = [{ barracksId: 10, items: [{ troopId: 'axeman', finishAt: NOW + 1 }] }];

    const result = catchUp(state, NOW + 1, config);
    if (!result.ok) throw new Error('expected ok');
    expect(result.state.army).toEqual({ axeman: 5 });
  });

  it('processes barracks in ascending id order', () => {
    const state = newState(NOW);
    state.trainingQueues = [
      { barracksId: 20, items: [{ troopId: 'archer', finishAt: NOW + 1 }] },
      { barracksId: 10, items: [{ troopId: 'axeman', finishAt: NOW + 1 }] },
    ];

    const result = catchUp(state, NOW + 1, config);
    if (!result.ok) throw new Error('expected ok');
    expect(result.events.map((event) => (event as { barracksId: number }).barracksId)).toEqual([
      10, 20,
    ]);
  });

  it('does nothing when the queue is empty', () => {
    const result = catchUp(newState(NOW), NOW + DAY, config);
    if (!result.ok) throw new Error('expected ok');
    expect(result.state.army).toEqual({});
    expect(result.state.trainingQueues).toEqual([]);
  });
});

describe('storage capacity', () => {
  it('sums the Keep base capacity', () => {
    const state = newState(NOW);
    expect(storageCapacity(state, config)).toMatchObject({ gold: 1000, essence: 1000 });
  });

  it('adds each storage building at its current level', () => {
    const state = newState(NOW);
    state.buildings.push({ id: 10, type: 'gold_store', level: 1, x: 30, y: 30 });
    state.buildings.push({ id: 11, type: 'gold_store', level: 1, x: 34, y: 30 });
    expect(storageCapacity(state, config).gold).toBe(1000 + 2500 + 2500);
  });

  it('reports remaining room and never a negative amount', () => {
    const state = newState(NOW);
    state.resources.gold = 900;
    expect(remainingCapacity(state, config, 'gold')).toBe(100);

    state.resources.gold = 1500;
    expect(remainingCapacity(state, config, 'gold')).toBe(0);
  });

  it('treats a resource with no configured capacity as zero room, not unlimited', () => {
    const state = newState(NOW);
    expect(remainingCapacity(state, config, 'shards')).toBe(0);
  });
});

describe('resource helpers', () => {
  it('clamps at zero rather than going negative', () => {
    const target = { gold: 10, essence: 0, shards: 0, gems: 0 };
    const applied = addResources(target, { gold: -25 });
    expect(target.gold).toBe(0);
    expect(applied.gold).toBe(-25);
  });

  it('ignores zero and missing amounts', () => {
    const target = { gold: 10, essence: 0, shards: 0, gems: 0 };
    expect(addResources(target, { gold: 0, essence: undefined })).toEqual({});
    expect(target.gold).toBe(10);
  });

  it('reports exactly what is missing', () => {
    const state = newState(NOW);
    state.resources.gold = 40;
    expect(canAfford(state, { gold: 40, essence: 10 })).toEqual({ ok: true });
    expect(canAfford(state, { gold: 41 })).toEqual({ ok: false, missing: { gold: 1 } });
    expect(canAfford(state, { gold: 100, essence: 5 })).toEqual({
      ok: false,
      missing: { gold: 60 },
    });
  });
});

describe('config lookups', () => {
  it('finds definitions and levels by building', () => {
    const state = newState(NOW);
    const goldMine = mine(state);
    if (goldMine === undefined) throw new Error('no mine');
    expect(buildingDef(config, goldMine)?.id).toBe('gold_mine');
    expect(levelDef(config, goldMine)?.level).toBe(1);
  });

  it('returns undefined for an unknown type', () => {
    expect(buildingDef(config, { id: 9, type: 'nope', level: 1, x: 0, y: 0 })).toBeUndefined();
  });
});

describe('stable serialization with the new fields', () => {
  it('round-trips a state carrying buffers, upgrades and busy builders', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);
    state.builders.busy.push({ buildingId: 3, toLevel: 2, finishAt: NOW + 1000 });
    const wellBuilding = well(state);
    if (wellBuilding !== undefined) wellBuilding.upgrade = { toLevel: 2, finishAt: NOW + 1000 };

    const result = catchUp(state, NOW + HOUR, config);
    if (!result.ok) throw new Error('expected ok');

    const text = stableStringify(result.state);
    expect(stableStringify(JSON.parse(text))).toBe(text);
    expect(hashState(result.state)).toBe(hashState(JSON.parse(text)));
  });

  it('gives the same hash when the same state is re-parsed from its serialization', () => {
    const state = newState(NOW);
    withBuffer(state, 2, NOW);
    const result = catchUp(state, NOW + HOUR, config);
    if (!result.ok) throw new Error('expected ok');

    const text = stableStringify(result.state);
    // Key order inside a buffer object is fixed by the serializer, not by the
    // order the fields happened to be assigned in.
    expect(text.indexOf('"amount"')).toBeLessThan(text.indexOf('"lastAccruedAt"'));
    expect(hashState(JSON.parse(text) as PlayerState)).toBe(hashState(result.state));
  });
});

describe('resource maps with explicit holes', () => {
  it('skips an explicit undefined amount when adding', () => {
    const target = { gold: 10, essence: 0, shards: 0, gems: 0 };
    expect(addResources(target, { gold: undefined, essence: 5 })).toEqual({ essence: 5 });
    expect(target.gold).toBe(10);
  });

  it('skips an explicit zero amount when adding', () => {
    const target = { gold: 10, essence: 0, shards: 0, gems: 0 };
    expect(addResources(target, { gold: 0 })).toEqual({});
    expect(target.gold).toBe(10);
  });

  it('skips an explicit undefined amount when checking affordability', () => {
    const state = newState(NOW);
    expect(canAfford(state, { gold: undefined, essence: 0 })).toEqual({ ok: true });
  });

  it('treats a storage table with an explicit hole as contributing nothing', () => {
    const state = newState(NOW);
    state.buildings.push({ id: 10, type: 'gold_store', level: 1, x: 30, y: 30 });
    const store = state.buildings.find((b) => b.id === 10);
    if (store === undefined) throw new Error('no store');
    // The config table for this fixture has no essence entry, which is exactly
    // the "hole" the loop has to skip.
    expect(storageCapacity(state, config).essence).toBe(1000);
    expect(storageCapacity(state, config).gold).toBe(1000 + 2500);
  });
});

describe('catchUp — chronological, piecewise production', () => {
  /** Puts the fixture mine mid-upgrade to level 2 (100/h -> 200/h). */
  const upgradingMine = (state: PlayerState, finishAt: number): PlayerState => {
    const building = mine(state);
    if (building === undefined) throw new Error('no gold_mine in the fixture');
    building.upgrade = { toLevel: 2, finishAt };
    state.builders.busy.push({ buildingId: building.id, toLevel: 2, finishAt });
    return state;
  };

  it('accrues each segment at the rate that was active during it', () => {
    const state = upgradingMine(withBuffer(newState(), 2, NOW), NOW + 20_000);

    const result = catchUp(state, NOW + HOUR, config);
    if (!result.ok) throw new Error('expected ok');

    // 20 s at 100/h: 2,000,000 numerator -> 0 whole, carry 2,000,000.
    // 3,580 s at 200/h: 716,000,000 + 2,000,000 = 718,000,000 -> 199 whole,
    // carry 1,600,000. Applying 200/h to the whole hour would wrongly give 200.
    expect(mine(result.state)?.buffer?.amount).toBe(199);
    expect(mine(result.state)?.buffer?.remainder).toBe(1_600_000);
  });

  it('applies a completion exactly at the start before any production', () => {
    const state = upgradingMine(withBuffer(newState(), 2, NOW), NOW);

    const result = catchUp(state, NOW + HOUR, config);
    if (!result.ok) throw new Error('expected ok');

    expect(mine(result.state)?.level).toBe(2);
    // Nothing is produced at the old rate: the whole hour is at 200/h.
    expect(mine(result.state)?.buffer?.amount).toBe(200);
    expect(result.events[0]).toMatchObject({ type: 'UpgradeFinished', toLevel: 2 });
  });

  it('applies a completion exactly at the end after accruing the whole window', () => {
    const state = upgradingMine(withBuffer(newState(), 2, NOW), NOW + HOUR);

    const result = catchUp(state, NOW + HOUR, config);
    if (!result.ok) throw new Error('expected ok');

    // The entire hour is at 100/h, then the upgrade lands with zero time left
    // to produce at the new rate.
    expect(mine(result.state)?.buffer?.amount).toBe(100);
    expect(mine(result.state)?.buffer?.remainder).toBe(0);
    expect(mine(result.state)?.level).toBe(2);
  });

  it('resolves two upgrades finishing at the same timestamp in ascending id order', () => {
    const finishAt = NOW + 20_000;
    const state = upgradingMine(withBuffer(newState(), 2, NOW), finishAt);
    const wellBuilding = well(state);
    if (wellBuilding === undefined) throw new Error('no essence_well in the fixture');
    wellBuilding.upgrade = { toLevel: 2, finishAt };
    state.builders.busy.push({ buildingId: wellBuilding.id, toLevel: 2, finishAt });

    const result = catchUp(state, NOW + 30_000, config);
    if (!result.ok) throw new Error('expected ok');

    expect(result.events).toEqual([
      {
        type: 'UpgradeFinished',
        buildingId: 2,
        buildingType: 'gold_mine',
        fromLevel: 1,
        toLevel: 2,
      },
      {
        type: 'UpgradeFinished',
        buildingId: 3,
        buildingType: 'essence_well',
        fromLevel: 1,
        toLevel: 2,
      },
    ]);
    expect(mine(result.state)?.level).toBe(2);
    expect(well(result.state)?.level).toBe(2);
  });

  it('reaches the same state through six short catch-ups as one long one', () => {
    const once = catchUp(
      upgradingMine(withBuffer(newState(), 2, NOW), NOW + 20_000),
      NOW + HOUR,
      config,
    );
    if (!once.ok) throw new Error('expected ok');

    let stepped: PlayerState = upgradingMine(withBuffer(newState(), 2, NOW), NOW + 20_000);
    for (let step = 1; step <= 6; step += 1) {
      const next = catchUp(stepped, NOW + (step * HOUR) / 6, config);
      if (!next.ok) throw new Error('expected ok');
      stepped = next.state;
    }

    expect(mine(stepped)?.buffer?.amount).toBe(199);
    expect(mine(stepped)?.buffer?.remainder).toBe(1_600_000);
    expect(hashState(stepped)).toBe(hashState(once.state));
  });

  it('leaves the input state untouched when time moves backwards', () => {
    const state = upgradingMine(withBuffer(newState(), 2, NOW), NOW + 20_000);
    const before = hashState(state);

    const result = catchUp(state, NOW - 1, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('time_moved_backwards');
    expect(hashState(state)).toBe(before);
  });
});

describe('catchUp — reaching the cap exactly', () => {
  it('discards a fractional carry produced at the instant the buffer fills', () => {
    const state = newState(NOW);
    const building = mine(state);
    if (building === undefined) throw new Error('no gold_mine in the fixture');
    // 400 of 500 held; one hour + 30 s at 100/h produces exactly the 100 that
    // remain, plus a 3,000,000/3,600,000 fractional unit.
    building.buffer = { amount: 400, remainder: 0, lastAccruedAt: NOW };

    const result = catchUp(state, NOW + HOUR + 30_000, config);
    if (!result.ok) throw new Error('expected ok');

    expect(mine(result.state)?.buffer?.amount).toBe(500);
    expect(mine(result.state)?.buffer?.remainder).toBe(0);
  });

  it('does not resurrect the discarded fraction after collection', () => {
    const state = newState(NOW);
    state.resources.gold = 0;
    const building = mine(state);
    if (building === undefined) throw new Error('no gold_mine in the fixture');
    building.buffer = { amount: 400, remainder: 0, lastAccruedAt: NOW };

    const filled = catchUp(state, NOW + HOUR + 30_000, config);
    if (!filled.ok) throw new Error('expected ok');
    expect(mine(filled.state)?.buffer?.amount).toBe(500);

    const emptied = mine(filled.state);
    if (emptied?.buffer !== undefined) emptied.buffer.amount = 0;
    const later = catchUp(filled.state, NOW + HOUR + 30_000, config);
    if (!later.ok) throw new Error('expected ok');

    // No time passed, so the discarded carry cannot reappear as production.
    expect(mine(later.state)?.buffer?.amount).toBe(0);
    expect(mine(later.state)?.buffer?.remainder).toBe(0);
  });

  it('produces nothing while the buffer is already full', () => {
    const state = newState(NOW);
    const building = mine(state);
    if (building === undefined) throw new Error('no gold_mine in the fixture');
    building.buffer = { amount: 500, remainder: 0, lastAccruedAt: NOW };

    const result = catchUp(state, NOW + HOUR, config);
    if (!result.ok) throw new Error('expected ok');
    expect(mine(result.state)?.buffer?.amount).toBe(500);
    expect(mine(result.state)?.buffer?.remainder).toBe(0);
  });
});
