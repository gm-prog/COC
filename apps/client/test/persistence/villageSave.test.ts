import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { applyCommand, catchUp, createNewPlayerState, type PlayerState } from '@coc/sim-core';
import {
  SAVE_DB_VERSION,
  SAVE_SCHEMA_VERSION,
  checkSaveEnvelope,
  createSave,
  migrateSave,
  restoreVillage,
  validatePersistedState,
  type VillageSave,
} from '../../src/persistence/villageSave';

const START = 1_700_000_000_000;

function freshState(now = START): PlayerState {
  return createNewPlayerState(GAME_CONFIG, now);
}

/** Places a Gold Mine at (24, 24) — the same tile the browser smoke test uses. */
function withGoldMine(state: PlayerState, now = START): PlayerState {
  const result = applyCommand(
    state,
    {
      id: `place-${now}`,
      type: 'PlaceBuilding',
      payload: { buildingType: 'gold_mine', x: 24, y: 24 },
    },
    { config: GAME_CONFIG, now },
  );
  if (!result.ok) throw new Error(`placement rejected: ${JSON.stringify(result.error)}`);
  return result.state;
}

function catchUpTo(state: PlayerState, now: number): PlayerState {
  const result = catchUp(state, now, GAME_CONFIG);
  if (!result.ok) throw new Error(`catchUp rejected: ${JSON.stringify(result.error)}`);
  return result.state;
}

/** Simulates IndexedDB's structured clone: only JSON-shaped data survives. */
function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function accepted(record: unknown): VillageSave {
  const checked = checkSaveEnvelope(record, GAME_CONFIG);
  if (!checked.ok) throw new Error(`envelope rejected: ${checked.problem.message}`);
  return checked.save;
}

describe('save envelope', () => {
  it('stamps the current schema, the config version and a timestamp', () => {
    const save = createSave(freshState(), GAME_CONFIG.version, START + 5);

    expect(save.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(save.configVersion).toBe(GAME_CONFIG.version);
    expect(save.savedAt).toBe(START + 5);
    expect(save.state.resources.gold).toBe(1000);
  });

  it('keeps the save schema version independent of the database version', () => {
    // Changing a record shape must never require an IndexedDB upgrade.
    expect(SAVE_DB_VERSION).toBe(1);
    expect(SAVE_SCHEMA_VERSION).toBe(1);

    const save = createSave(freshState(), GAME_CONFIG.version, START);
    expect(save.schemaVersion).toBe(1);
  });

  it('snapshots the state, so later mutations cannot leak into a queued write', () => {
    const state = freshState();
    const save = createSave(state, GAME_CONFIG.version, START);

    state.resources.gold = 1;
    state.buildings.length = 0;

    expect(save.state.resources.gold).toBe(1000);
    expect(save.state.buildings.length).toBeGreaterThan(0);
  });

  it('survives a JSON round trip unchanged', () => {
    const save = createSave(withGoldMine(freshState()), GAME_CONFIG.version, START);
    const restored = structuredCopy(save);

    expect(accepted(restored)).toEqual(save);
    expect(validatePersistedState((restored as VillageSave).state, GAME_CONFIG)).toEqual([]);
  });

  it('keeps every field the simulation needs, not just the visible ones', () => {
    const placed = withGoldMine(freshState());
    const save = createSave(placed, GAME_CONFIG.version, START);
    const state = save.state;

    // Identity, position, level and the construction timer.
    const mine = state.buildings.find((building) => building.x === 24 && building.y === 24);
    expect(mine).toMatchObject({ type: 'gold_mine', level: 0 });
    expect(mine?.upgrade).toEqual({ toLevel: 1, finishAt: START + 20_000 });

    // The builder assignment that owns the timer.
    expect(state.builders.busy).toEqual([
      { buildingId: mine?.id, toLevel: 1, finishAt: START + 20_000 },
    ]);

    // Obstacles, resources and the simulation watermark.
    expect(state.obstacles.length).toBe(7);
    expect(state.resources).toEqual({ gold: 850, essence: 1000, shards: 0, gems: 50 });
    expect(state.lastSyncAt).toBe(START);
    expect(state.configVersion).toBe(GAME_CONFIG.version);
  });
});

describe('save schema migration', () => {
  const record = structuredCopy(createSave(freshState(), GAME_CONFIG.version, START));

  it('passes a current-version record through untouched', () => {
    const result = migrateSave(record);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(result.record.state).toEqual(record.state);
  });

  it('rejects an unknown future schema instead of guessing at its fields', () => {
    const result = migrateSave({ ...record, schemaVersion: SAVE_SCHEMA_VERSION + 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.code).toBe('unsupported_schema');
  });

  it('rejects a record with no usable schemaVersion', () => {
    for (const schemaVersion of [undefined, 0, -1, 1.5, '1', null]) {
      const result = migrateSave({ ...record, schemaVersion });
      expect(result.ok, `schemaVersion ${String(schemaVersion)}`).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe('malformed');
    }
  });

  it('refuses to skip a version with no registered migration', () => {
    // A build that knows v3 but has no v1 -> v2 step must not read v1 anyway.
    const result = migrateSave(record, {}, SAVE_SCHEMA_VERSION + 2);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.code).toBe('unsupported_schema');
    expect(result.problem.message).toContain(`v${SAVE_SCHEMA_VERSION}`);
  });

  it('runs registered migrations in order and stamps each version', () => {
    const order: number[] = [];
    const migrations = {
      [SAVE_SCHEMA_VERSION]: (input: Record<string, unknown>) => {
        order.push(SAVE_SCHEMA_VERSION);
        const state = input.state as PlayerState;
        return { ...input, state: { ...state, trophies: state.trophies + 7 } };
      },
      [SAVE_SCHEMA_VERSION + 1]: (input: Record<string, unknown>) => {
        order.push(SAVE_SCHEMA_VERSION + 1);
        const state = input.state as PlayerState;
        return { ...input, state: { ...state, tutorialStep: 3 } };
      },
    };

    const result = migrateSave(record, migrations, SAVE_SCHEMA_VERSION + 2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(order).toEqual([SAVE_SCHEMA_VERSION, SAVE_SCHEMA_VERSION + 1]);
    expect(result.record.schemaVersion).toBe(SAVE_SCHEMA_VERSION + 2);
    expect((result.record.state as PlayerState).trophies).toBe(7);
    expect((result.record.state as PlayerState).tutorialStep).toBe(3);
  });

  it('reports a throwing migration as malformed and keeps the input intact', () => {
    const before = structuredCopy(record);
    const result = migrateSave(
      record,
      {
        [SAVE_SCHEMA_VERSION]: () => {
          throw new Error('boom');
        },
      },
      SAVE_SCHEMA_VERSION + 1,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.code).toBe('malformed');
    expect(result.problem.message).toContain('boom');
    expect(record).toEqual(before);
  });

  it('rejects a migration that returns a non-object', () => {
    const result = migrateSave(
      record,
      { [SAVE_SCHEMA_VERSION]: () => 'nope' as unknown as Record<string, unknown> },
      SAVE_SCHEMA_VERSION + 1,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.code).toBe('malformed');
  });
});

describe('persisted state validation', () => {
  const save = createSave(withGoldMine(freshState()), GAME_CONFIG.version, START);
  const state = structuredCopy(save.state);

  it('accepts a real state', () => {
    expect(validatePersistedState(state, GAME_CONFIG)).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validatePersistedState(null, GAME_CONFIG)).not.toEqual([]);
    expect(validatePersistedState([], GAME_CONFIG)).not.toEqual([]);
    expect(validatePersistedState('village', GAME_CONFIG)).not.toEqual([]);
  });

  it('rejects missing or malformed resources', () => {
    const missing = structuredCopy(state);
    delete (missing.resources as Partial<PlayerState['resources']>).gold;
    expect(validatePersistedState(missing, GAME_CONFIG).join()).toContain('resources.gold');

    for (const value of [-5, 12.5, Number.NaN, '10']) {
      const broken = structuredCopy(state) as unknown as { resources: Record<string, unknown> };
      broken.resources.gold = value;
      expect(validatePersistedState(broken, GAME_CONFIG).join(), `gold ${String(value)}`).toContain(
        'resources.gold',
      );
    }

    const unknown = structuredCopy(state) as unknown as { resources: Record<string, number> };
    unknown.resources.platinum = 1;
    expect(validatePersistedState(unknown, GAME_CONFIG).join()).toContain('unknown resource');
  });

  it('rejects buildings outside the grid, with unknown types, or duplicated ids', () => {
    const outside = structuredCopy(state);
    outside.buildings[0]!.x = 999;
    expect(validatePersistedState(outside, GAME_CONFIG).join()).toContain('tile column');

    const unknownType = structuredCopy(state);
    unknownType.buildings[0]!.type = 'dragon_roost';
    expect(validatePersistedState(unknownType, GAME_CONFIG).join()).toContain('not defined');

    const duplicate = structuredCopy(state);
    duplicate.buildings.push({ ...duplicate.buildings[0]! });
    expect(validatePersistedState(duplicate, GAME_CONFIG).join()).toContain('duplicated');
  });

  it('rejects a builder assigned to a building that is not in the save', () => {
    const dangling = structuredCopy(state);
    dangling.builders.busy = [{ buildingId: 9999, toLevel: 2, finishAt: START + 1000 }];
    expect(validatePersistedState(dangling, GAME_CONFIG).join()).toContain('reference a building');

    const tooMany = structuredCopy(state);
    tooMany.builders.busy = [
      { buildingId: tooMany.buildings[0]!.id, toLevel: 2, finishAt: START + 1 },
      { buildingId: tooMany.buildings[1]!.id, toLevel: 2, finishAt: START + 2 },
      { buildingId: tooMany.buildings[2]!.id, toLevel: 2, finishAt: START + 3 },
    ];
    expect(validatePersistedState(tooMany, GAME_CONFIG).join()).toContain('more assignments');
  });

  it('rejects a rounded or negative collector remainder', () => {
    // A buffer only exists once something has been produced, so build one first.
    const producing = catchUpTo(
      catchUpTo(withGoldMine(freshState()), START + 20_000),
      START + 30_000,
    );
    const broken = structuredCopy(producing);
    const mine = broken.buildings.find(
      (building) => building.type === 'gold_mine' && building.x === 24,
    );
    expect(mine?.buffer).toBeDefined();

    mine!.buffer = { amount: 0, remainder: 0.5, lastAccruedAt: START };
    expect(validatePersistedState(broken, GAME_CONFIG).join()).toContain('remainder');

    mine!.buffer = { amount: 0, remainder: -1, lastAccruedAt: START };
    expect(validatePersistedState(broken, GAME_CONFIG).join()).toContain('remainder');
  });

  it('rejects invalid timestamps', () => {
    const broken = structuredCopy(state);
    broken.lastSyncAt = -1;
    expect(validatePersistedState(broken, GAME_CONFIG).join()).toContain('lastSyncAt');

    const badFinish = structuredCopy(state);
    badFinish.builders.busy[0]!.finishAt = Number.NaN;
    expect(validatePersistedState(badFinish, GAME_CONFIG).join()).toContain('finishAt');
  });

  it('rejects an inconsistent Keep level', () => {
    const broken = structuredCopy(state);
    const keep = broken.buildings.find((building) => building.type === 'keep');
    keep!.level = 4;
    expect(validatePersistedState(broken, GAME_CONFIG).join()).toContain('keepLevel');
  });
});

describe('envelope compatibility', () => {
  const save = structuredCopy(createSave(freshState(), GAME_CONFIG.version, START));

  it('rejects a save written against another config version', () => {
    const checked = checkSaveEnvelope({ ...save, configVersion: 'some-other-config' }, GAME_CONFIG);

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problem.code).toBe('incompatible_config');
  });

  it('rejects a record whose state disagrees with its envelope config', () => {
    const checked = checkSaveEnvelope(
      { ...save, state: { ...save.state, configVersion: 'other' } },
      GAME_CONFIG,
    );

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problem.code).toBe('incompatible_config');
  });

  it('reports a state with no configVersion as malformed, not incompatible', () => {
    const { configVersion: _ignored, ...stateless } = save.state;
    const checked = checkSaveEnvelope({ ...save, state: stateless }, GAME_CONFIG);

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problem.code).toBe('malformed');
  });

  it('rejects a missing savedAt rather than treating it as fresh', () => {
    const { savedAt: _ignored, ...withoutTimestamp } = save;
    const checked = checkSaveEnvelope(withoutTimestamp, GAME_CONFIG);

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problem.code).toBe('malformed');
  });

  it('rejects a record that skipped migration', () => {
    const checked = checkSaveEnvelope(
      { ...save, schemaVersion: SAVE_SCHEMA_VERSION - 1 },
      GAME_CONFIG,
    );

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problem.code).toBe('unsupported_schema');
  });
});

describe('restoring a saved village', () => {
  it('completes an overdue construction exactly once', () => {
    const save = createSave(withGoldMine(freshState()), GAME_CONFIG.version, START);

    const first = restoreVillage(save, GAME_CONFIG, START + 21_000);
    expect(first.reconciled).toBe(true);
    expect(first.state.builders.busy).toEqual([]);
    const mine = first.state.buildings.find(
      (building) => building.type === 'gold_mine' && building.x === 24,
    );
    expect(mine?.level).toBe(1);
    expect(mine?.upgrade).toBeUndefined();
    // A construction is a level 0 -> 1 upgrade in the economy's own terms.
    expect(
      first.events.some((event) => event.type === 'UpgradeFinished' && event.fromLevel === 0),
    ).toBe(true);
  });

  it('is idempotent: replaying the same save at the same instant yields the same village', () => {
    const save = createSave(withGoldMine(freshState()), GAME_CONFIG.version, START);

    const a = restoreVillage(save, GAME_CONFIG, START + 90_000);
    const b = restoreVillage(save, GAME_CONFIG, START + 90_000);

    expect(a.state).toEqual(b.state);
  });

  it('preserves the fractional production remainder across a save/load', () => {
    const producing = catchUpTo(
      catchUpTo(withGoldMine(freshState()), START + 20_000),
      START + 30_000,
    );
    const mine = producing.buildings.find(
      (building) => building.type === 'gold_mine' && building.x === 24,
    );
    // 10 s at 240 gold/hour is two thirds of a unit: nothing banked, exact carry.
    expect(mine?.buffer).toEqual({
      amount: 0,
      remainder: 2_400_000,
      lastAccruedAt: START + 30_000,
    });

    const reloaded = restoreVillage(
      createSave(producing, GAME_CONFIG.version, START + 30_000),
      GAME_CONFIG,
      START + 30_000,
    );

    expect(reloaded.state).toEqual(producing);
  });

  it('does not duplicate production when restored repeatedly as time moves on', () => {
    const save = createSave(
      catchUpTo(catchUpTo(withGoldMine(freshState()), START + 20_000), START + 30_000),
      GAME_CONFIG.version,
      START + 30_000,
    );

    const at60 = restoreVillage(save, GAME_CONFIG, START + 60_000);
    // Saving that and reloading 30 s later must equal restoring the original
    // save once, 60 s later.
    const resaved = createSave(at60.state, GAME_CONFIG.version, START + 60_000);
    const at90FromResave = restoreVillage(resaved, GAME_CONFIG, START + 90_000);
    const at90Direct = restoreVillage(save, GAME_CONFIG, START + 90_000);

    expect(at90FromResave.state).toEqual(at90Direct.state);
  });

  it('completes an overdue upgrade and frees the builder', () => {
    const state = freshState();
    const mineId = state.buildings.find((building) => building.type === 'gold_mine')?.id;
    expect(mineId).toBeDefined();

    const upgraded = applyCommand(
      state,
      { id: 'upgrade-1', type: 'StartUpgrade', payload: { buildingId: mineId! } },
      { config: GAME_CONFIG, now: START },
    );
    expect(upgraded.ok).toBe(true);
    if (!upgraded.ok) return;
    expect(upgraded.state.builders.busy).toHaveLength(1);

    const restored = restoreVillage(
      createSave(upgraded.state, GAME_CONFIG.version, START),
      GAME_CONFIG,
      START + 33_000,
    );

    expect(restored.state.builders.busy).toEqual([]);
    expect(restored.state.buildings.find((building) => building.id === mineId)?.level).toBe(2);
    expect(
      restored.events.some((event) => event.type === 'UpgradeFinished' && event.fromLevel === 1),
    ).toBe(true);
  });

  it('leaves the village untouched when the clock is behind the save', () => {
    const save = createSave(withGoldMine(freshState()), GAME_CONFIG.version, START);
    const restored = restoreVillage(save, GAME_CONFIG, START - 5_000);

    expect(restored.reconciled).toBe(false);
    expect(restored.clockWentBackwards).toBe(true);
    expect(restored.state).toEqual(save.state);
  });
});
