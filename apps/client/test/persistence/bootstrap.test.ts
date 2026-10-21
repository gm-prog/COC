import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { applyCommand, catchUp, createNewPlayerState, type PlayerState } from '@coc/sim-core';
import { bootstrapVillage, unsavedVillage } from '../../src/persistence/bootstrap';
import {
  SaveStorageError,
  createSave,
  type VillageSave,
  type VillageStorage,
} from '../../src/persistence/villageSave';

const START = 1_700_000_000_000;

/** In-memory storage double; `record` is exactly what a real store would hold. */
class MemoryStorage implements VillageStorage {
  record: unknown;
  writes = 0;
  failRead: Error | null = null;
  failWrite: Error | null = null;
  hangRead = false;

  constructor(record?: unknown) {
    this.record = record;
  }

  async read(): Promise<unknown> {
    if (this.hangRead) return new Promise<unknown>(() => undefined);
    if (this.failRead) throw this.failRead;
    return this.record === undefined ? undefined : structuredClone(this.record);
  }

  async write(save: VillageSave): Promise<void> {
    if (this.failWrite) throw this.failWrite;
    this.writes += 1;
    this.record = structuredClone(save);
  }
}

function placeGoldMine(state: PlayerState, now = START): PlayerState {
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

describe('village startup', () => {
  it('gives a new player the configured starter village', async () => {
    const storage = new MemoryStorage();

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    expect(village.source).toBe('new');
    expect(village.problem).toBeNull();
    expect(village.autosave).not.toBeNull();
    expect(village.state).toEqual(createNewPlayerState(GAME_CONFIG, START));
    village.autosave?.dispose();
  });

  it('restores a saved village instead of starting a new one', async () => {
    const saved = placeGoldMine(createNewPlayerState(GAME_CONFIG, START));
    saved.resources.gold = 777;
    const storage = new MemoryStorage(createSave(saved, GAME_CONFIG.version, START));

    const village = await bootstrapVillage({ config: GAME_CONFIG, now: () => START, storage });

    expect(village.source).toBe('restored');
    expect(village.state.resources.gold).toBe(777);
    expect(village.state.buildings.some((building) => building.x === 24 && building.y === 24)).toBe(
      true,
    );
    village.autosave?.dispose();
  });

  it('reconciles an overdue construction before the village is shown', async () => {
    const placed = placeGoldMine(createNewPlayerState(GAME_CONFIG, START));
    const storage = new MemoryStorage(createSave(placed, GAME_CONFIG.version, START));

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START + 21_000,
      storage,
    });

    expect(village.reconciled).toBe(true);
    expect(village.state.builders.busy).toEqual([]);
    expect(
      village.state.buildings.find((building) => building.x === 24 && building.y === 24)?.level,
    ).toBe(1);
    expect(village.events.length).toBeGreaterThan(0);
    village.autosave?.dispose();
  });

  it('applies offline production once, however often the save is loaded', async () => {
    const placed = placeGoldMine(createNewPlayerState(GAME_CONFIG, START));
    const save = createSave(placed, GAME_CONFIG.version, START);
    const tenMinutesLater = START + 10 * 60_000;

    const first = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => tenMinutesLater,
      storage: new MemoryStorage(save),
    });
    const second = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => tenMinutesLater,
      storage: new MemoryStorage(save),
    });

    expect(first.source).toBe('restored');
    expect(first.state).toEqual(second.state);

    // The mine finished 20 s in, so 580 s at 240 gold/hour is 38 whole units
    // plus an exact carry — buffered, not banked.
    const mine = first.state.buildings.find((building) => building.x === 24 && building.y === 24);
    expect(mine?.buffer).toEqual({
      amount: 38,
      remainder: 2_400_000,
      lastAccruedAt: tenMinutesLater,
    });
    expect(first.state.resources.gold).toBe(850);

    first.autosave?.dispose();
    second.autosave?.dispose();
  });

  it('does not duplicate production across a reload that saves in between', async () => {
    const placed = placeGoldMine(createNewPlayerState(GAME_CONFIG, START));
    const save = createSave(placed, GAME_CONFIG.version, START);

    const atTen = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START + 10 * 60_000,
      storage: new MemoryStorage(save),
    });
    const resaved = createSave(atTen.state, GAME_CONFIG.version, START + 10 * 60_000);
    const atTwenty = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START + 20 * 60_000,
      storage: new MemoryStorage(resaved),
    });
    const direct = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START + 20 * 60_000,
      storage: new MemoryStorage(save),
    });

    expect(atTwenty.state).toEqual(direct.state);
    atTen.autosave?.dispose();
    atTwenty.autosave?.dispose();
    direct.autosave?.dispose();
  });

  it('preserves the fractional remainder across a reload', async () => {
    const producing = catchUpTo(
      catchUpTo(placeGoldMine(createNewPlayerState(GAME_CONFIG, START)), START + 20_000),
      START + 30_000,
    );
    const mine = producing.buildings.find((building) => building.x === 24);
    expect(mine?.buffer?.remainder).toBe(2_400_000);

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START + 30_000,
      storage: new MemoryStorage(createSave(producing, GAME_CONFIG.version, START + 30_000)),
    });

    expect(village.state.buildings.find((building) => building.id === mine?.id)?.buffer).toEqual(
      mine?.buffer,
    );
    village.autosave?.dispose();
  });

  it('keeps the saved record and disables saving when the schema is from the future', async () => {
    const future = {
      ...createSave(createNewPlayerState(GAME_CONFIG, START), GAME_CONFIG.version, START),
      schemaVersion: 99,
    };
    const storage = new MemoryStorage(future);

    const village = await bootstrapVillage({ config: GAME_CONFIG, now: () => START, storage });

    expect(village.source).toBe('unsaved');
    expect(village.autosave).toBeNull();
    expect(village.problem?.code).toBe('unsupported_schema');
    // The starter village is playable, but the stored record is untouched.
    expect(village.state.resources.gold).toBe(1000);
    expect(storage.record).toEqual(future);
    expect(storage.writes).toBe(0);
  });

  it('keeps the saved record and disables saving when it is malformed', async () => {
    const malformed = {
      schemaVersion: 1,
      savedAt: START,
      configVersion: GAME_CONFIG.version,
      state: { resources: 'nope' },
    };
    const storage = new MemoryStorage(malformed);

    const village = await bootstrapVillage({ config: GAME_CONFIG, now: () => START, storage });

    expect(village.source).toBe('unsaved');
    expect(village.autosave).toBeNull();
    expect(village.problem?.code).toBe('malformed');
    expect(storage.record).toEqual(malformed);
    expect(storage.writes).toBe(0);
  });

  it('keeps the saved record when the config version changed', async () => {
    const other = createSave(createNewPlayerState(GAME_CONFIG, START), 'an-older-build', START);
    const storage = new MemoryStorage(other);

    const village = await bootstrapVillage({ config: GAME_CONFIG, now: () => START, storage });

    expect(village.source).toBe('unsaved');
    expect(village.problem?.code).toBe('incompatible_config');
    expect(storage.record).toEqual(other);
    expect(storage.writes).toBe(0);
  });

  it('plays in memory when the store cannot be read', async () => {
    const storage = new MemoryStorage();
    storage.failRead = new SaveStorageError('database blocked');

    const village = await bootstrapVillage({ config: GAME_CONFIG, now: () => START, storage });

    expect(village.source).toBe('unsaved');
    expect(village.autosave).toBeNull();
    expect(village.problem?.code).toBe('storage_unavailable');
    expect(village.state.resources.gold).toBe(1000);
  });

  it('gives up on a store that never answers, instead of hanging startup', async () => {
    const storage = new MemoryStorage();
    storage.hangRead = true;

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      readTimeoutMs: 10,
    });

    expect(village.source).toBe('unsaved');
    expect(village.problem?.code).toBe('storage_unavailable');
    expect(village.problem?.message).toContain('did not respond');
  });

  it('autosaves a restored village after a change', async () => {
    const storage = new MemoryStorage();
    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    village.state.resources.gold = 321;
    village.autosave?.schedule(village.state);
    await village.autosave?.flush();

    expect(storage.writes).toBe(1);
    const written = storage.record as VillageSave;
    expect(written.schemaVersion).toBe(1);
    expect(written.configVersion).toBe(GAME_CONFIG.version);
    expect(written.state.resources.gold).toBe(321);
    village.autosave?.dispose();
  });

  it('leaves the record alone when a write fails', async () => {
    const original = createSave(
      createNewPlayerState(GAME_CONFIG, START),
      GAME_CONFIG.version,
      START,
    );
    const storage = new MemoryStorage(original);
    storage.failWrite = new SaveStorageError('quota');

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });
    village.autosave?.schedule(placeGoldMine(village.state));
    await village.autosave?.flush();

    expect(storage.record).toEqual(original);
    expect(village.autosave?.currentStatus).toBe('blocked');
    village.autosave?.dispose();
  });
});

describe('unsavedVillage', () => {
  it('builds a playable in-memory village with saving switched off', () => {
    const village = unsavedVillage(GAME_CONFIG, START, {
      code: 'storage_unavailable',
      message: 'no store',
    });

    expect(village.autosave).toBeNull();
    expect(village.source).toBe('unsaved');
    expect(village.state.resources.gold).toBe(1000);
    expect(village.problem?.code).toBe('storage_unavailable');
  });
});
