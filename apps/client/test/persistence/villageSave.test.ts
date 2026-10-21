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
    // Changing a record shape must never require an IndexedDB upgrade. v2 added
    // `revision` (the concurrency token) and the database version stayed at 1.
    expect(SAVE_DB_VERSION).toBe(1);
    expect(SAVE_SCHEMA_VERSION).toBe(2);

    const save = createSave(freshState(), GAME_CONFIG.version, START);
    expect(save.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(save.revision).toBe(1);
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
    expect(validatePersistedState(outside, GAME_CONFIG).join()).toContain('buildable core');

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

  it('reports non-object building entries instead of throwing', () => {
    // `isKeepLevelConsistent` is typed against `PlayerState` and trusts its
    // input. A valid-looking array with holes in it used to reach the helper and
    // throw out of validation, which surfaced as "storage unavailable".
    for (const junk of [null, 42, 'keep', [], true]) {
      const broken = structuredCopy(state) as unknown as { buildings: unknown[] };
      broken.buildings.unshift(junk);

      let problems: string[] = [];
      expect(
        () => {
          problems = validatePersistedState(broken, GAME_CONFIG);
        },
        `building entry ${JSON.stringify(junk)}`,
      ).not.toThrow();

      expect(problems.join(), `building entry ${JSON.stringify(junk)}`).toContain(
        'state.buildings[0] is not an object',
      );
      // The real building behind the junk entry is still checked.
      expect(problems.join()).not.toContain('state.keepLevel');
    }
  });

  it('never throws on arbitrary nested junk', () => {
    const shapes: Array<(state: PlayerState) => unknown> = [
      (value) => ({ ...value, buildings: [null] }),
      (value) => ({ ...value, buildings: [{ ...value.buildings[0], upgrade: null }] }),
      (value) => ({ ...value, obstacles: [null] }),
      (value) => ({ ...value, builders: { count: 1, busy: [null] } }),
      (value) => ({ ...value, trainingQueues: [null] }),
      (value) => ({ ...value, research: { levels: { barbarian: {} } } }),
      (value) => ({ ...value, army: { barbarian: null } }),
      (value) => ({ ...value, lastSyncAt: 'yesterday' }),
    ];

    for (const shape of shapes) {
      const broken = shape(structuredCopy(state)) as unknown;
      expect(() => validatePersistedState(broken, GAME_CONFIG)).not.toThrow();
      expect(validatePersistedState(broken, GAME_CONFIG).length).toBeGreaterThan(0);
    }
  });

  it('rejects an inconsistent Keep level', () => {
    const broken = structuredCopy(state);
    const keep = broken.buildings.find((building) => building.type === 'keep');
    keep!.level = 4;
    expect(validatePersistedState(broken, GAME_CONFIG).join()).toContain('keepLevel');
  });

  it('rejects a state written against another sim schema version', () => {
    // Schema v1 is the first supported format, so "older" is not a thing yet:
    // both a future version and garbage are simply unsupported.
    for (const version of [0, 2, '1', null, undefined]) {
      const broken = structuredCopy(state) as unknown as Record<string, unknown>;
      broken.version = version;
      expect(
        validatePersistedState(broken, GAME_CONFIG).join(),
        `version ${String(version)}`,
      ).toContain('state.version');
    }
  });

  it('rejects every missing top-level field', () => {
    const fields = [
      'version',
      'configVersion',
      'keepLevel',
      'resources',
      'builders',
      'buildings',
      'obstacles',
      'army',
      'trainingQueues',
      'research',
      'spells',
      'trophies',
      'tutorialStep',
      'lastSyncAt',
    ];

    for (const field of fields) {
      const broken = structuredCopy(state) as unknown as Record<string, unknown>;
      delete broken[field];
      const problems = validatePersistedState(broken, GAME_CONFIG).join('; ');
      expect(problems, `missing ${field}`).toContain(`state.${field}`);
    }
  });

  it('rejects malformed army and spell counts', () => {
    const fractional = structuredCopy(state);
    fractional.army = { barbarian: 1.5 };
    expect(validatePersistedState(fractional, GAME_CONFIG).join()).toContain(
      'state.army.barbarian',
    );

    const negative = structuredCopy(state);
    negative.spells = { rage: -1 };
    expect(validatePersistedState(negative, GAME_CONFIG).join()).toContain('state.spells.rage');

    const notAnObject = structuredCopy(state) as unknown as { army: unknown };
    notAnObject.army = ['barbarian'];
    expect(validatePersistedState(notAnObject, GAME_CONFIG).join()).toContain(
      'state.army must be an object',
    );
  });

  it('rejects training queues without a real barracks behind them', () => {
    const dangling = structuredCopy(state);
    dangling.trainingQueues = [{ barracksId: 9999, items: [] }];
    expect(validatePersistedState(dangling, GAME_CONFIG).join()).toContain(
      'must reference a building',
    );

    // No barracks exists in this config yet, so even a real building is not a
    // legal queue owner — the validator must follow the config, not the shape.
    const notBarracks = structuredCopy(state);
    const keep = notBarracks.buildings.find((building) => building.type === 'keep')!;
    notBarracks.trainingQueues = [{ barracksId: keep.id, items: [] }];
    expect(validatePersistedState(notBarracks, GAME_CONFIG).join()).toContain('is not a barracks');

    const malformed = structuredCopy(state);
    malformed.trainingQueues = [
      {
        barracksId: keep.id,
        // Deliberately the wrong shape for items.
        items: [{ troopId: '', finishAt: -1 }],
      },
    ] as unknown as PlayerState['trainingQueues'];
    const problems = validatePersistedState(malformed, GAME_CONFIG).join('; ');
    expect(problems).toContain('items[0].troopId');
    expect(problems).toContain('items[0].finishAt');

    const notAnArray = structuredCopy(state) as unknown as { trainingQueues: unknown };
    notAnArray.trainingQueues = { barracksId: keep.id, items: [] };
    expect(validatePersistedState(notAnArray, GAME_CONFIG).join()).toContain(
      'state.trainingQueues must be an array',
    );
  });

  it('rejects malformed research levels and active metadata', () => {
    const negativeLevel = structuredCopy(state);
    negativeLevel.research.levels = { barbarian: -1 };
    expect(validatePersistedState(negativeLevel, GAME_CONFIG).join()).toContain(
      'state.research.levels.barbarian',
    );

    const active = structuredCopy(state);
    active.research.active = { unitId: '', toLevel: 0, finishAt: -5 };
    const problems = validatePersistedState(active, GAME_CONFIG).join('; ');
    expect(problems).toContain('active.unitId');
    expect(problems).toContain('active.toLevel');
    expect(problems).toContain('active.finishAt');

    const notAnObject = structuredCopy(state) as unknown as { research: unknown };
    notAnObject.research = { levels: [] };
    expect(validatePersistedState(notAnObject, GAME_CONFIG).join()).toContain(
      'state.research.levels must be an object',
    );

    // An empty research record is the honest shape for a village that has not
    // researched anything yet, and must stay valid.
    const none = structuredCopy(state);
    none.research = { levels: {} };
    expect(validatePersistedState(none, GAME_CONFIG)).toEqual([]);
  });

  it('rejects impossible trophy and tutorial counters', () => {
    const trophies = structuredCopy(state) as unknown as { trophies: unknown };
    trophies.trophies = -1;
    expect(validatePersistedState(trophies, GAME_CONFIG).join()).toContain('state.trophies');

    const tutorial = structuredCopy(state) as unknown as { tutorialStep: unknown };
    tutorial.tutorialStep = 1.5;
    expect(validatePersistedState(tutorial, GAME_CONFIG).join()).toContain('state.tutorialStep');

    const keep = structuredCopy(state) as unknown as { keepLevel: unknown };
    keep.keepLevel = 99;
    expect(validatePersistedState(keep, GAME_CONFIG).join()).toContain(
      'exceeds the configured maximum',
    );
  });

  it('rejects malformed optional timestamps and clan data', () => {
    const shield = structuredCopy(state) as unknown as { shieldUntil: unknown };
    shield.shieldUntil = -1;
    expect(validatePersistedState(shield, GAME_CONFIG).join()).toContain('state.shieldUntil');

    const guard = structuredCopy(state) as unknown as { guardUntil: unknown };
    guard.guardUntil = 'soon';
    expect(validatePersistedState(guard, GAME_CONFIG).join()).toContain('state.guardUntil');

    const clan = structuredCopy(state) as unknown as { clan: unknown };
    clan.clan = [];
    expect(validatePersistedState(clan, GAME_CONFIG).join()).toContain(
      'state.clan must be an object',
    );

    const emptyClan = structuredCopy(state) as unknown as { clan: unknown };
    emptyClan.clan = { clanId: '', role: '' };
    const problems = validatePersistedState(emptyClan, GAME_CONFIG).join('; ');
    expect(problems).toContain('state.clan.clanId');
    expect(problems).toContain('state.clan.role');

    // Valid optional data is accepted.
    const withClan = structuredCopy(state);
    withClan.shieldUntil = START + 1000;
    withClan.clan = { clanId: 'emberwatch', role: 'member' };
    expect(validatePersistedState(withClan, GAME_CONFIG)).toEqual([]);
  });

  it('rejects building levels and upgrade targets the config cannot produce', () => {
    const tooHigh = structuredCopy(state);
    tooHigh.buildings[0]!.level = 99;
    expect(validatePersistedState(tooHigh, GAME_CONFIG).join()).toContain('maximum');

    const skipsALevel = structuredCopy(state);
    skipsALevel.buildings[0]!.upgrade = { toLevel: 3, finishAt: START + 1000 };
    expect(validatePersistedState(skipsALevel, GAME_CONFIG).join()).toContain(
      'is not one level above',
    );

    const unconfigured = structuredCopy(state);
    unconfigured.buildings[0]!.level = 0;
    unconfigured.buildings[0]!.upgrade = { toLevel: 9, finishAt: START + 1000 };
    expect(validatePersistedState(unconfigured, GAME_CONFIG).join()).toContain(
      'is not a configured level',
    );

    const orphaned = structuredCopy(state);
    orphaned.buildings[0]!.level = 0;
    delete orphaned.buildings[0]!.upgrade;
    expect(validatePersistedState(orphaned, GAME_CONFIG).join()).toContain(
      'level 0 but has no upgrade',
    );

    const badTimer = structuredCopy(state);
    badTimer.buildings[0]!.upgrade = { toLevel: 2, finishAt: -1 };
    expect(validatePersistedState(badTimer, GAME_CONFIG).join()).toContain('upgrade.finishAt');
  });

  it('rejects builder assignments that disagree with the upgrade they mirror', () => {
    // The fixture already has a level-0 construction in flight (the placed Gold
    // Mine), so this adds a *second* conversion of the Keep and keeps both
    // assignments — replacing the array would test an orphan, not a mismatch.
    const upgrading = structuredCopy(state);
    const keep = upgrading.buildings.find((building) => building.type === 'keep')!;
    const finishAt = START + 60_000;
    keep.upgrade = { toLevel: 2, finishAt };
    upgrading.builders.busy.push({ buildingId: keep.id, toLevel: 2, finishAt });
    const assignmentFor = (candidate: PlayerState): { toLevel: number; finishAt: number } =>
      candidate.builders.busy.find((busy) => busy.buildingId === keep.id)!;

    // The baseline is a coherent construction site.
    expect(validatePersistedState(upgrading, GAME_CONFIG)).toEqual([]);

    const wrongLevel = structuredCopy(upgrading);
    assignmentFor(wrongLevel).toLevel = 3;
    expect(validatePersistedState(wrongLevel, GAME_CONFIG).join()).toContain(
      "toLevel does not match its building's upgrade",
    );

    const wrongTimer = structuredCopy(upgrading);
    assignmentFor(wrongTimer).finishAt = finishAt + 1;
    expect(validatePersistedState(wrongTimer, GAME_CONFIG).join()).toContain(
      "finishAt does not match its building's upgrade",
    );

    const unassigned = structuredCopy(upgrading);
    unassigned.builders.busy = unassigned.builders.busy.filter(
      (busy) => busy.buildingId !== keep.id,
    );
    expect(validatePersistedState(unassigned, GAME_CONFIG).join()).toContain(
      `building ${keep.id} has an upgrade in flight but no builder assigned`,
    );

    const shorthanded = structuredCopy(upgrading);
    shorthanded.builders.busy.push({ ...assignmentFor(shorthanded), buildingId: keep.id });
    expect(validatePersistedState(shorthanded, GAME_CONFIG).join()).toContain(
      '2 builders assigned',
    );

    const impossibleCount = structuredCopy(state);
    impossibleCount.builders.count = 6;
    expect(validatePersistedState(impossibleCount, GAME_CONFIG).join()).toContain(
      'exceeds the maximum 5',
    );
  });

  it('rejects buffers on buildings that do not produce, or that break the level invariants', () => {
    const onTheKeep = structuredCopy(state);
    const keep = onTheKeep.buildings.find((building) => building.type === 'keep')!;
    keep.buffer = { amount: 1, remainder: 0, lastAccruedAt: START };
    expect(validatePersistedState(onTheKeep, GAME_CONFIG).join()).toContain(
      'does not produce at this level',
    );

    const producing = catchUpTo(
      catchUpTo(withGoldMine(freshState()), START + 20_000),
      START + 30_000,
    );
    const stored = structuredCopy(producing);
    const mine = stored.buildings.find(
      (building) => building.type === 'gold_mine' && building.x === 24,
    )!;
    expect(mine.buffer).toBeDefined();

    const overCap = structuredCopy(stored);
    overCap.buildings.find((building) => building.id === mine.id)!.buffer!.amount = 10_000_000;
    expect(validatePersistedState(overCap, GAME_CONFIG).join()).toContain(
      'exceeds the configured cap',
    );

    const aheadOfSync = structuredCopy(stored);
    aheadOfSync.buildings.find((building) => building.id === mine.id)!.buffer!.lastAccruedAt =
      stored.lastSyncAt + 1;
    expect(validatePersistedState(aheadOfSync, GAME_CONFIG).join()).toContain(
      'ahead of state.lastSyncAt',
    );

    const notAnObject = structuredCopy(stored);
    notAnObject.buildings.find((building) => building.id === mine.id)!.buffer =
      'gold' as unknown as PlayerState['buildings'][number]['buffer'];
    expect(validatePersistedState(notAnObject, GAME_CONFIG).join()).toContain(
      'buffer must be an object',
    );
  });

  it('rejects entities that overlap each other', () => {
    const overlapping = structuredCopy(state);
    const mine = overlapping.buildings[0]!;
    overlapping.buildings.push({ ...mine, id: 9001 });
    expect(validatePersistedState(overlapping, GAME_CONFIG).join()).toContain('overlaps');

    const obstacleOnBuilding = structuredCopy(state);
    const keep = obstacleOnBuilding.buildings.find((building) => building.type === 'keep')!;
    obstacleOnBuilding.obstacles.push({
      id: 9002,
      type: 'tree',
      x: keep.x,
      y: keep.y,
    });
    expect(validatePersistedState(obstacleOnBuilding, GAME_CONFIG).join()).toContain('overlaps');
  });

  it('applies the real placement rules: obstacles may sit in the margin, buildings may not', () => {
    const margin = structuredCopy(state);
    margin.obstacles[0]!.x = 1;
    margin.obstacles[0]!.y = 1;
    expect(validatePersistedState(margin, GAME_CONFIG)).toEqual([]);

    const offMap = structuredCopy(state);
    offMap.obstacles[0]!.x = 999;
    expect(validatePersistedState(offMap, GAME_CONFIG).join()).toContain('leaves the 48×48 map');

    const unknownObstacle = structuredCopy(state);
    unknownObstacle.obstacles[0]!.type = 'dragon';
    expect(validatePersistedState(unknownObstacle, GAME_CONFIG).join()).toContain('not defined');

    const reusedId = structuredCopy(state);
    reusedId.obstacles[0]!.id = reusedId.buildings[0]!.id;
    expect(validatePersistedState(reusedId, GAME_CONFIG).join()).toContain('is already used');
  });
});

/** Removes an index without shrinking the array, producing a real hole. */
function punchHole<T>(array: T[], index: number): T[] {
  Reflect.deleteProperty(array, index);
  return array;
}

/** A state with one construction in flight, so `builders.busy` is populated. */
function withUpgrade(state: PlayerState, finishAt: number): PlayerState {
  const next = state;
  const keep = next.buildings.find((building) => building.type === 'keep')!;
  keep.upgrade = { toLevel: 2, finishAt };
  next.builders.busy.push({ buildingId: keep.id, toLevel: 2, finishAt });
  return next;
}

describe('sparse arrays are rejected', () => {
  // `Array.prototype.forEach`/`map` skip holes, so a hole validates as "nothing
  // to check" while every later `for…of` reads `undefined`. These use genuine
  // holes (`delete arr[i]`), not `null` entries: JSON round-tripping turns a
  // hole into `null`, which the existing tests already cover and which is a
  // different value.
  const state = structuredCopy(withGoldMine(freshState()));

  it('rejects a hole in buildings, before or after a valid entry', () => {
    const leading = structuredCopy(state);
    punchHole(leading.buildings, 0);
    const leadingProblems = validatePersistedState(leading, GAME_CONFIG).join('; ');
    expect(leadingProblems).toContain('state.buildings has a hole at index 0');
    // The entries that *are* present are still validated.
    expect(leadingProblems).not.toContain('is not an object');

    const trailing = structuredCopy(state);
    punchHole(trailing.buildings, trailing.buildings.length - 1);
    expect(validatePersistedState(trailing, GAME_CONFIG).join('; ')).toContain(
      `state.buildings has a hole at index ${state.buildings.length - 1}`,
    );

    // A hole is not repaired by shifting or filling.
    expect(Object.keys(state.buildings)).toHaveLength(state.buildings.length);
  });

  it('rejects a hole in obstacles', () => {
    const broken = structuredCopy(state);
    punchHole(broken.obstacles, 1);
    expect(validatePersistedState(broken, GAME_CONFIG).join('; ')).toContain(
      'state.obstacles has a hole at index 1',
    );
  });

  it('rejects a hole in builders.busy', () => {
    const broken = withUpgrade(structuredCopy(freshState()), START + 1_000);
    punchHole(broken.builders.busy, 0);
    const problems = validatePersistedState(broken, GAME_CONFIG).join('; ');
    expect(problems).toContain('state.builders.busy has a hole at index 0');
  });

  it('rejects a hole in trainingQueues', () => {
    const broken = structuredCopy(state);
    broken.trainingQueues = [
      { barracksId: broken.buildings[0]!.id, items: [] },
    ];
    punchHole(broken.trainingQueues, 0);
    expect(validatePersistedState(broken, GAME_CONFIG).join('; ')).toContain(
      'state.trainingQueues has a hole at index 0',
    );
  });

  it('rejects a hole in a nested queue items array', () => {
    const broken = structuredCopy(state);
    broken.trainingQueues = [
      {
        barracksId: broken.buildings[0]!.id,
        items: [
          { troopId: 'barbarian', finishAt: START + 1_000 },
          { troopId: 'archer', finishAt: START + 2_000 },
        ],
      },
    ];
    punchHole(broken.trainingQueues[0]!.items, 0);

    const problems = validatePersistedState(broken, GAME_CONFIG).join('; ');
    expect(problems).toContain('state.trainingQueues[0].items has a hole at index 0');
    // The surviving item is still checked (and is still rejected: this config
    // defines no barracks, so a queue cannot legally exist yet).
    expect(problems).toContain('is not a barracks');
  });

  it('accepts the same arrays when they are dense', () => {
    expect(validatePersistedState(structuredCopy(state), GAME_CONFIG)).toEqual([]);
  });
});

describe('scheduled work must be reachable by catchUp', () => {
  it('rejects an upgrade scheduled before the watermark', () => {
    // `nextCompletionAt` skips anything earlier than `lastSyncAt`, so this job
    // could never run and the builder would never be freed.
    const broken = withUpgrade(structuredCopy(freshState()), START - 1);
    const problems = validatePersistedState(broken, GAME_CONFIG).join('; ');
    expect(problems).toContain('is before state.lastSyncAt');
    expect(problems).toContain('could never complete');
  });

  it('accepts an upgrade scheduled exactly at the watermark', () => {
    // `catchUp` applies completions at the cursor *before* accruing anything,
    // so `finishAt === lastSyncAt` is a legitimate, completable job.
    const boundary = withUpgrade(structuredCopy(freshState()), START);
    expect(validatePersistedState(boundary, GAME_CONFIG)).toEqual([]);
  });

  it('rejects a queue item scheduled before the watermark', () => {
    const broken = structuredCopy(freshState());
    broken.trainingQueues = [
      {
        barracksId: broken.buildings[0]!.id,
        items: [{ troopId: 'barbarian', finishAt: START - 1 }],
      },
    ];
    const problems = validatePersistedState(broken, GAME_CONFIG).join('; ');
    expect(problems).toContain('items[0].finishAt');
    expect(problems).toContain('could never complete');
  });

  it('does not claim research is completed by catchUp', () => {
    // Honest limitation: the simulation has no research completion path at all,
    // so a temporal rule there would be invented rather than enforced.
    const broken = structuredCopy(freshState());
    broken.research = {
      levels: { barbarian: 1 },
      active: { unitId: 'archer', toLevel: 2, finishAt: START - 5_000 },
    };
    // Shape is valid; the checker must not pretend to know more than it does.
    expect(validatePersistedState(broken, GAME_CONFIG)).toEqual([]);
  });

  it('still allows an overdue job that is ahead of the watermark', () => {
    // The save was written at START, the job finishes at START+1s, and the
    // device clock is far later. That is a normal offline completion.
    const saved = withUpgrade(structuredCopy(freshState()), START + 1_000);
    const restored = restoreVillage(
      createSave(saved, GAME_CONFIG.version, START),
      GAME_CONFIG,
      START + 60_000,
    );

    expect(restored.reconciled).toBe(true);
    const keep = restored.state.buildings.find((building) => building.type === 'keep')!;
    expect(keep.level).toBe(2);
    expect(keep.upgrade).toBeUndefined();
    expect(restored.state.builders.busy).toEqual([]);
  });
});

describe('safe integers and domain bounds', () => {
  const state = structuredCopy(withGoldMine(freshState()));
  const UNSAFE = Number.MAX_SAFE_INTEGER + 1;

  it('rejects unsafe entity ids that would break id allocation', () => {
    for (const id of [UNSAFE, Number.MAX_SAFE_INTEGER]) {
      const broken = structuredCopy(state);
      broken.buildings[0]!.id = id;
      expect(validatePersistedState(broken, GAME_CONFIG).join('; '), `id ${id}`).toContain(
        'state.buildings[0].id',
      );
    }

    const obstacle = structuredCopy(state);
    obstacle.obstacles[0]!.id = UNSAFE;
    expect(validatePersistedState(obstacle, GAME_CONFIG).join('; ')).toContain(
      'state.obstacles[0].id',
    );

    const builder = structuredCopy(state);
    builder.builders.count = UNSAFE;
    expect(validatePersistedState(builder, GAME_CONFIG).join('; ')).toContain(
      'state.builders.count',
    );
  });

  it('rejects unsafe timestamps, balances and counters', () => {
    const cases: Array<[string, (state: PlayerState) => void, string]> = [
      ['lastSyncAt', (value) => { value.lastSyncAt = UNSAFE; }, 'state.lastSyncAt'],
      ['trophies', (value) => { value.trophies = UNSAFE; }, 'state.trophies'],
      ['tutorialStep', (value) => { value.tutorialStep = UNSAFE; }, 'state.tutorialStep'],
      ['resources.gold', (value) => { value.resources.gold = UNSAFE; }, 'state.resources.gold'],
      ['army', (value) => { value.army = { barbarian: UNSAFE }; }, 'state.army.barbarian'],
      ['spells', (value) => { value.spells = { rage: UNSAFE }; }, 'state.spells.rage'],
      ['research', (value) => { value.research = { levels: { barbarian: UNSAFE } }; }, 'state.research.levels'],
    ];

    for (const [label, corrupt, expected] of cases) {
      const broken = structuredCopy(state);
      corrupt(broken);
      expect(validatePersistedState(broken, GAME_CONFIG).join('; '), label).toContain(expected);
    }
  });

  it('rejects unsafe coordinates rather than computing a bogus footprint', () => {
    const broken = structuredCopy(state);
    broken.buildings[0]!.x = UNSAFE;
    const problems = validatePersistedState(broken, GAME_CONFIG).join('; ');
    expect(problems).toContain('state.buildings[0].x');
  });

  it('rejects unsafe scheduled times and buffer amounts', () => {
    const upgrade = withUpgrade(structuredCopy(freshState()), UNSAFE);
    expect(validatePersistedState(upgrade, GAME_CONFIG).join('; ')).toContain(
      'upgrade.finishAt',
    );

    const producing = catchUpTo(withGoldMine(freshState()), START + 30_000);
    const mine = producing.buildings.find((building) => building.type === 'gold_mine')!;
    expect(mine.buffer).toBeDefined();
    mine.buffer!.amount = UNSAFE;
    expect(validatePersistedState(producing, GAME_CONFIG).join('; ')).toContain(
      'buffer.amount',
    );
  });

  it('keeps accepting ordinary and maximum-supported values', () => {
    const ordinary = structuredCopy(state);
    ordinary.trophies = 4_321;
    ordinary.tutorialStep = 7;
    expect(validatePersistedState(ordinary, GAME_CONFIG)).toEqual([]);

    const atTheEdge = structuredCopy(state);
    atTheEdge.obstacles[0]!.id = Number.MAX_SAFE_INTEGER - 1; // == MAX_ENTITY_ID
    expect(validatePersistedState(atTheEdge, GAME_CONFIG)).toEqual([]);
  });
});

describe('gameplay invariants the engine maintains', () => {
  const state = structuredCopy(withGoldMine(freshState()));

  it('enforces the per-Keep building count ceiling', () => {
    // Keep 1 allows one Gold Store and the village starts with none.
    const oneStore = structuredCopy(state);
    const template = oneStore.buildings.find((building) => building.type === 'gold_mine')!;
    oneStore.buildings.push({
      ...template,
      id: 900,
      type: 'gold_store',
      x: 30,
      y: 30,
    });
    expect(validatePersistedState(oneStore, GAME_CONFIG)).toEqual([]);

    oneStore.buildings.push({
      ...template,
      id: 901,
      type: 'gold_store',
      x: 34,
      y: 30,
    });
    expect(validatePersistedState(oneStore, GAME_CONFIG).join('; ')).toContain(
      '2 × "gold_store" but Keep 1 allows 1',
    );
  });

  it('counts buildings under construction towards the ceiling', () => {
    const constructing = structuredCopy(state);
    const template = constructing.buildings.find((building) => building.type === 'gold_mine')!;
    // Level 0 is a reservation; `placeBuilding` counts it, so validation must.
    constructing.buildings.push({
      ...template,
      id: 900,
      type: 'gold_store',
      level: 0,
      x: 30,
      y: 30,
      upgrade: { toLevel: 1, finishAt: START + 1_000 },
    });
    constructing.builders.busy.push({ buildingId: 900, toLevel: 1, finishAt: START + 1_000 });
    expect(validatePersistedState(constructing, GAME_CONFIG)).toEqual([]);

    // A second reservation still counts, even though neither is finished.
    constructing.buildings.push({
      ...template,
      id: 901,
      type: 'gold_store',
      level: 0,
      x: 34,
      y: 30,
      upgrade: { toLevel: 1, finishAt: START + 1_000 },
    });
    constructing.builders.busy.push({ buildingId: 901, toLevel: 1, finishAt: START + 1_000 });
    expect(validatePersistedState(constructing, GAME_CONFIG).join('; ')).toContain(
      '2 × "gold_store" but Keep 1 allows 1',
    );
  });

  it('enforces maxKeeps', () => {
    const twoKeeps = structuredCopy(state);
    const keep = twoKeeps.buildings.find((building) => building.type === 'keep')!;
    twoKeeps.buildings.push({ ...keep, id: 900, x: 30, y: 30 });
    expect(validatePersistedState(twoKeeps, GAME_CONFIG).join('; ')).toContain(
      'but this config allows 1',
    );
  });

  it('enforces the Keep requirement for a completed level', () => {
    const tooHigh = structuredCopy(state);
    const mine = tooHigh.buildings.find((building) => building.type === 'gold_mine')!;
    // Gold Mine level 3 needs Keep 2; the village is at Keep 1.
    mine.level = 3;
    expect(validatePersistedState(tooHigh, GAME_CONFIG).join('; ')).toContain('needs Keep 2');
  });

  it('enforces the Keep requirement for an upgrade target', () => {
    const tooHigh = structuredCopy(state);
    const mine = tooHigh.buildings.find(
      (building) => building.type === 'gold_mine' && building.level === 1,
    )!;
    mine.upgrade = { toLevel: 3, finishAt: START + 1_000 };
    tooHigh.builders.busy.push({ buildingId: mine.id, toLevel: 3, finishAt: START + 1_000 });
    const problems = validatePersistedState(tooHigh, GAME_CONFIG).join('; ');
    expect(problems).toContain('is not one level above');
    expect(problems).toContain('needs Keep 2');
  });

  it('enforces storage capacity but leaves uncapped resources alone', () => {
    const overFull = structuredCopy(state);
    overFull.resources.gold = 1_001; // Keep 1 stores exactly 1000
    expect(validatePersistedState(overFull, GAME_CONFIG).join('; ')).toContain(
      'exceeds the village storage capacity 1000',
    );

    const exact = structuredCopy(state);
    exact.resources.gold = 1_000;
    expect(validatePersistedState(exact, GAME_CONFIG)).toEqual([]);

    const unlimited = structuredCopy(state);
    unlimited.resources.gems = 5_000_000;
    unlimited.resources.shards = 123_456;
    expect(validatePersistedState(unlimited, GAME_CONFIG)).toEqual([]);
  });

  it('counts a completed store towards capacity', () => {
    const withStore = structuredCopy(state);
    const store = withStore.buildings.find((building) => building.type === 'gold_mine')!;
    withStore.buildings.push({
      ...store,
      id: 900,
      type: 'gold_store',
      level: 1,
      x: 30,
      y: 30,
      upgrade: undefined,
    });
    withStore.resources.gold = 3_000; // Keep 1000 + store 2500
    const problems = validatePersistedState(withStore, GAME_CONFIG).join('; ');
    expect(problems).not.toContain('storage capacity');
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
