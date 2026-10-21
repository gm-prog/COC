import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { GAME_CONFIG } from '@coc/game-data';
import { applyCommand, catchUp, createNewPlayerState, type PlayerState } from '@coc/sim-core';
import { Hud, saveIndicatorForProblem } from '../../src/hud';
import { t } from '../../src/i18n';
import { isReadOnlyVillage, runVillageAction } from '../../src/villageActions';
import {
  bootstrapVillage,
  unsavedVillage,
  type VillageBootstrap,
} from '../../src/persistence/bootstrap';
import {
  IndexedDbVillageStorage,
  SAVE_DB_NAME,
  SAVE_DB_VERSION,
  SAVE_KEY,
  SAVE_STORE_NAME,
  SAVE_SCHEMA_VERSION,
  SaveStorageError,
  createSave,
  loadVillage,
  storedRevisionOf,
  type VillageSave,
  type VillageStorage,
  type VillageWriteResult,
} from '../../src/persistence/villageSave';

const START = 1_700_000_000_000;

/** In-memory storage double; `record` is exactly what a real store would hold. */
class MemoryStorage implements VillageStorage {
  record: unknown;
  writes = 0;
  failRead: Error | null = null;
  failWrite: Error | null = null;
  hangRead = false;
  /** Every revision assertion attempted, for conflict tests. */
  readonly expectations: number[] = [];

  constructor(record?: unknown) {
    this.record = record;
  }

  async read(): Promise<unknown> {
    if (this.hangRead) return new Promise<unknown>(() => undefined);
    if (this.failRead) throw this.failRead;
    return this.record === undefined ? undefined : structuredClone(this.record);
  }

  /** Mirrors the real store's compare-and-swap, including never overwriting. */
  async write(save: VillageSave, expectedRevision: number): Promise<VillageWriteResult> {
    this.expectations.push(expectedRevision);
    if (this.failWrite) throw this.failWrite;
    const stored = this.record === undefined ? 0 : storedRevisionOf(this.record);
    if (stored === undefined) return { ok: false, reason: 'unreadable_record' };
    if (stored !== expectedRevision) {
      return { ok: false, reason: 'conflict', storedRevision: stored };
    }
    this.writes += 1;
    this.record = structuredClone(save);
    return { ok: true, revision: save.revision };
  }
}

/** The same indicator decision `BootScene` makes at startup. */
function renderSaveIndicator(village: VillageBootstrap): {
  textContent: string;
  hidden: boolean;
  state: string | undefined;
} {
  const node = {
    dataset: {} as Record<string, string>,
    hidden: true,
    textContent: '',
  };
  const root = {
    addEventListener(): void {},
    removeEventListener(): void {},
    querySelector: (selector: string) => (selector === '#save-status' ? node : null),
  } as unknown as HTMLElement;

  const hud = new Hud(root);
  hud.setSaveIndicator(
    village.problem === null ? 'idle' : saveIndicatorForProblem(village.problem.code),
  );
  hud.dispose();

  return { textContent: node.textContent, hidden: node.hidden, state: node.dataset.saveState };
}

function openRaw(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(SAVE_DB_NAME, SAVE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SAVE_STORE_NAME)) {
        db.createObjectStore(SAVE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Writes through a second connection, as another tab or a buggy writer would. */
async function writeRawRecord(factory: IDBFactory, value: unknown): Promise<void> {
  const db = await openRaw(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SAVE_STORE_NAME, 'readwrite');
      tx.objectStore(SAVE_STORE_NAME).put(value, SAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function readRawRecord(factory: IDBFactory): Promise<unknown> {
  const db = await openRaw(factory);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(SAVE_STORE_NAME, 'readonly');
      const request = tx.objectStore(SAVE_STORE_NAME).get(SAVE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Returns the stored value untouched, so getters run inside `loadVillage`. */
class RawStorage implements VillageStorage {
  constructor(private readonly value: unknown) {}

  async read(): Promise<unknown> {
    return this.value;
  }

  async write(): Promise<VillageWriteResult> {
    throw new Error('read-only test double: nothing may be written');
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
    expect(written.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
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

describe('a stored null is not an empty slot', () => {
  it('reports it as malformed, leaves it in place, and disables saving', async () => {
    // The whole point: the record exists. Only a *missing* key may mean "new
    // player"; a null must never be silently replaced by a starter village.
    const factory = new IDBFactory();
    await writeRawRecord(factory, null);
    const storage = new IndexedDbVillageStorage(factory);

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    expect(village.source).toBe('unsaved');
    expect(village.problem?.code).toBe('malformed');
    expect(village.autosave).toBeNull();
    expect(village.reconciled).toBe(false);
    expect(await readRawRecord(factory)).toBeNull();

    // Playable, but strictly in memory.
    expect(village.state.resources.gold).toBe(1000);

    storage.close();
  });

  it('shows the unreadable warning instead of a healthy save indicator', async () => {
    const factory = new IDBFactory();
    await writeRawRecord(factory, null);
    const storage = new IndexedDbVillageStorage(factory);

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });
    const indicator = renderSaveIndicator(village);

    expect(indicator.hidden).toBe(false);
    expect(indicator.state).toBe('unreadable');
    expect(indicator.textContent).toBe(t('save.unreadable'));
    // Never claim success: this session is not saving.
    expect(indicator.textContent).not.toBe(t('save.saved'));
    expect(indicator.textContent).not.toBe(t('save.saving'));

    storage.close();
  });

  it('still reads a missing key in an existing store as a new player', async () => {
    const factory = new IDBFactory();
    // Creating the database is enough; nothing is written under the key.
    const db = await openRaw(factory);
    db.close();

    const storage = new IndexedDbVillageStorage(factory);
    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    expect(village.source).toBe('new');
    expect(village.problem).toBeNull();
    expect(village.autosave).not.toBeNull();
    expect(await readRawRecord(factory)).toBeUndefined();
    village.autosave?.dispose();
    storage.close();
  });

  it('still treats a fresh database as a new player', async () => {
    const factory = new IDBFactory();
    const storage = new IndexedDbVillageStorage(factory);

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    expect(village.source).toBe('new');
    expect(village.problem).toBeNull();
    expect(village.autosave).not.toBeNull();
    village.autosave?.dispose();
    storage.close();
  });
});

describe('deep state validation in the load path', () => {
  it('rejects a structurally complete but impossible village without touching the record', async () => {
    const impossible = placeGoldMine(createNewPlayerState(GAME_CONFIG, START));
    // Correct shape, impossible content: a research level no rule can produce.
    impossible.research = { levels: { barbarian: -3 } } as PlayerState['research'];
    const record = createSave(impossible, GAME_CONFIG.version, START);
    const storage = new MemoryStorage(record);

    const loaded = await loadVillage(storage, GAME_CONFIG);
    expect(loaded.status).toBe('unreadable');
    if (loaded.status !== 'unreadable') return;
    expect(loaded.problem.code).toBe('malformed');
    expect(loaded.problem.message).toContain('state.research.levels.barbarian');

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    expect(village.source).toBe('unsaved');
    expect(village.autosave).toBeNull();
    // Malformed, not "storage unavailable": the player must be told the record
    // is unreadable rather than that saving is impossible.
    expect(village.problem?.code).toBe('malformed');
    expect(storage.record).toEqual(record);
    expect(storage.writes).toBe(0);
    expect(renderSaveIndicator(village).state).toBe('unreadable');
  });
});

describe('device clock skew', () => {
  const saved = catchUpTo(placeGoldMine(createNewPlayerState(GAME_CONFIG, START)), START + 5_000);
  const record = createSave(saved, GAME_CONFIG.version, saved.lastSyncAt);

  it('keeps the saved village, leaves the record alone, and switches saving off', async () => {
    const storage = new MemoryStorage(record);
    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => saved.lastSyncAt - 60_000,
      storage,
      debounceMs: 0,
    });

    expect(village.source).toBe('restored');
    expect(village.autosave).toBeNull();
    expect(village.problem?.code).toBe('clock_behind');
    // Nothing was replayed, and nothing may claim it was.
    expect(village.reconciled).toBe(false);
    expect(village.events).toEqual([]);

    // The saved village is shown exactly as stored: no timer resets and no
    // fabricated timestamp to sneak past the monotonic rule.
    expect(village.state).toEqual(saved);
    expect(village.state.lastSyncAt).toBe(saved.lastSyncAt);

    expect(storage.record).toEqual(record);
    expect(storage.writes).toBe(0);

    // Even an explicit change cannot reach the store: there is no autosave.
    village.state.resources.gold = 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storage.writes).toBe(0);
    expect(storage.record).toEqual(record);
  });

  it('warns accessibly instead of presenting saving as healthy', async () => {
    const storage = new MemoryStorage(record);
    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => saved.lastSyncAt - 1,
      storage,
      debounceMs: 0,
    });

    const indicator = renderSaveIndicator(village);
    expect(indicator.hidden).toBe(false);
    expect(indicator.state).toBe('clock_behind');
    expect(indicator.textContent).toBe(t('save.clockBehind'));

    // The warning has to say all three things: what is wrong, that actions are
    // unavailable, and what the player can do about it.
    const warning = indicator.textContent.toLowerCase();
    expect(warning).toContain('clock is behind');
    expect(warning).toContain('read-only');
    expect(warning).toContain('actions are unavailable');
    expect(warning).toContain('clock is corrected');
    expect(warning).toContain('reloaded');
    expect(warning).toContain('nothing has been overwritten');

    // The healthy states stay hidden/reassuring only when saving really works.
    expect(indicator.textContent).not.toBe(t('save.saved'));
  });

  it('starts saving normally once the timestamps are valid again', async () => {
    const storage = new MemoryStorage(record);

    const behind = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => saved.lastSyncAt - 1,
      storage,
      debounceMs: 0,
    });
    expect(behind.autosave).toBeNull();
    expect(storage.record).toEqual(record);

    const validAt = saved.lastSyncAt + 60_000;
    const ahead = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => validAt,
      storage,
      debounceMs: 0,
    });

    expect(ahead.source).toBe('restored');
    expect(ahead.problem).toBeNull();
    expect(ahead.autosave).not.toBeNull();
    expect(ahead.reconciled).toBe(true);
    expect(ahead.state.lastSyncAt).toBe(validAt);

    ahead.autosave?.schedule(ahead.state);
    await ahead.autosave?.flush();

    expect(storage.writes).toBe(1);
    expect((storage.record as VillageSave).state.lastSyncAt).toBe(validAt);
    ahead.autosave?.dispose();
  });
});

describe('malformed nested data is a bad record, not a storage outage', () => {
  /** A save whose `buildings` array looks valid but hides a null entry. */
  function saveWithNullBuilding(): VillageSave {
    const save = createSave(
      placeGoldMine(createNewPlayerState(GAME_CONFIG, START)),
      GAME_CONFIG.version,
      START,
    );
    // Insert *before* the otherwise valid buildings: the helper used to walk
    // the array and dereference `null.type` before validation could report it.
    (save.state.buildings as unknown[]).unshift(null);
    return save;
  }

  it('rejects it as malformed and keeps the record', async () => {
    const record = saveWithNullBuilding();
    const storage = new MemoryStorage(record);

    const loaded = await loadVillage(storage, GAME_CONFIG);
    expect(loaded.status).toBe('unreadable');
    if (loaded.status !== 'unreadable') return;
    expect(loaded.problem.code).toBe('malformed');
    expect(loaded.problem.message).toContain('state.buildings[0] is not an object');

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    // Playable in memory...
    expect(village.source).toBe('unsaved');
    expect(village.state.buildings.some((building) => building === null)).toBe(false);
    expect(village.state.resources.gold).toBe(1000);
    // ...saving stays off, with the honest reason and notice...
    expect(village.autosave).toBeNull();
    expect(village.problem?.code).toBe('malformed');
    expect(renderSaveIndicator(village).state).toBe('unreadable');
    // ...and the record is untouched.
    expect(storage.record).toEqual(record);
    expect(storage.writes).toBe(0);
  });

  it('classifies a validator exception as malformed rather than storage_unavailable', async () => {
    // A record whose first property read throws. `migrateSave` touches
    // `schemaVersion`, so the failure happens inside validation, after the read
    // succeeded — exactly the case that must not be blamed on IndexedDB.
    const hostile = {
      get schemaVersion(): number {
        throw new Error('hostile getter');
      },
    };
    const storage = new RawStorage(hostile);

    const loaded = await loadVillage(storage, GAME_CONFIG);
    expect(loaded.status).toBe('unreadable');
    if (loaded.status !== 'unreadable') return;
    expect(loaded.problem.code).toBe('malformed');
    expect(loaded.problem.message).toContain('save could not be validated');
    expect(loaded.problem.message).toContain('hostile getter');

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    expect(village.source).toBe('unsaved');
    expect(village.autosave).toBeNull();
    // The distinction this test exists for.
    expect(village.problem?.code).not.toBe('storage_unavailable');
    expect(village.problem?.code).toBe('malformed');
    expect(renderSaveIndicator(village).state).toBe('unreadable');
  });
});

describe('a clock-behind session is read-only', () => {
  const saved = catchUpTo(placeGoldMine(createNewPlayerState(GAME_CONFIG, START)), START + 5_000);
  const record = createSave(saved, GAME_CONFIG.version, saved.lastSyncAt);

  async function clockBehindVillage(): Promise<{
    village: VillageBootstrap;
    storage: MemoryStorage;
  }> {
    const storage = new MemoryStorage(record);
    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => saved.lastSyncAt - 60_000,
      storage,
      debounceMs: 0,
    });
    return { village, storage };
  }

  it('refuses placement, collection and upgrades without altering the village', async () => {
    const { village, storage } = await clockBehindVillage();
    expect(isReadOnlyVillage(village.problem)).toBe(true);

    // `BootScene.getNow()` clamps to the watermark, so these are the exact
    // arguments a real tap would supply in this session.
    const now = Math.max(saved.lastSyncAt - 60_000, village.state.lastSyncAt);
    const context = { config: GAME_CONFIG, now, readOnly: isReadOnlyVillage(village.problem) };
    const before = JSON.parse(JSON.stringify(village.state)) as PlayerState;

    const goldMine = village.state.buildings.find((building) => building.type === 'gold_mine')!;
    const keep = village.state.buildings.find((building) => building.type === 'keep')!;

    const attempts = [
      {
        id: 'place-1',
        type: 'PlaceBuilding' as const,
        // Legal at Keep 1: one gold store, 200 gold, and a free builder.
        payload: { buildingType: 'gold_store', x: 30, y: 24 },
      },
      { id: 'collect-1', type: 'CollectResource' as const, payload: { buildingId: goldMine.id } },
      { id: 'upgrade-1', type: 'StartUpgrade' as const, payload: { buildingId: keep.id } },
    ];

    for (const command of attempts) {
      expect(runVillageAction(village.state, command, context), command.type).toEqual({
        ok: false,
        reason: 'read_only',
      });
    }

    // Nothing moved: same state, same record, no write.
    expect(village.state).toEqual(before);
    expect(village.state.buildings).toHaveLength(saved.buildings.length);
    expect(storage.record).toEqual(record);
    expect(storage.writes).toBe(0);
    expect(village.autosave).toBeNull();
  });

  it('would accept the same placement once the session is writable', async () => {
    // Proves the refusal above comes from the gate rather than from a village
    // that could not have been changed anyway.
    const { village } = await clockBehindVillage();
    const whenValid = saved.lastSyncAt + 1;
    const caught = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => whenValid,
      storage: new MemoryStorage(record),
      debounceMs: 0,
    });

    expect(isReadOnlyVillage(caught.problem)).toBe(false);
    expect(caught.autosave).not.toBeNull();

    const result = runVillageAction(
      caught.state,
      {
        id: 'place-1',
        type: 'PlaceBuilding',
        // Legal at Keep 1: one gold store, 200 gold, and a free builder.
        payload: { buildingType: 'gold_store', x: 30, y: 24 },
      },
      { config: GAME_CONFIG, now: whenValid, readOnly: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.buildings).toHaveLength(village.state.buildings.length + 1);
    caught.autosave?.dispose();
  });
});

describe('sparse and unreachable records through the real load path', () => {
  /** A save with one extra construction in flight on the Keep. */
  function saveWithUpgrade(finishAt: number): VillageSave {
    const state = placeGoldMine(createNewPlayerState(GAME_CONFIG, START));
    const keep = state.buildings.find((building) => building.type === 'keep')!;
    keep.upgrade = { toLevel: 2, finishAt };
    state.builders.busy.push({ buildingId: keep.id, toLevel: 2, finishAt });
    return createSave(state, GAME_CONFIG.version, START);
  }

  it('rejects a record whose buildings array has a hole, preserving it', async () => {
    const factory = new IDBFactory();
    const record = createSave(
      placeGoldMine(createNewPlayerState(GAME_CONFIG, START)),
      GAME_CONFIG.version,
      START,
    );
    // A genuine hole, not a null entry: this is the shape `forEach` would skip.
    Reflect.deleteProperty(record.state.buildings, 0);
    await writeRawRecord(factory, record);

    const storedBefore = await readRawRecord(factory);
    const storage = new IndexedDbVillageStorage(factory);

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    expect(village.source).toBe('unsaved');
    expect(village.problem?.code).toBe('malformed');
    expect(village.problem?.message).toContain('hole at index 0');
    expect(village.autosave).toBeNull();
    // Playable in memory, and the hole is not "repaired" into the running state.
    expect(village.state.buildings).toHaveLength(
      createNewPlayerState(GAME_CONFIG, START).buildings.length,
    );

    // The bad record is exactly where the player left it.
    expect(await readRawRecord(factory)).toEqual(storedBefore);
    expect(renderSaveIndicator(village).state).toBe('unreadable');
    storage.close();
  });

  it('rejects an upgrade scheduled before the watermark, preserving the record', async () => {
    const record = saveWithUpgrade(START - 1);
    const storage = new MemoryStorage(record);

    const loaded = await loadVillage(storage, GAME_CONFIG);
    expect(loaded.status).toBe('unreadable');
    if (loaded.status !== 'unreadable') return;
    expect(loaded.problem.code).toBe('malformed');
    expect(loaded.problem.message).toContain('could never complete');

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });
    expect(village.autosave).toBeNull();
    expect(village.problem?.code).toBe('malformed');
    expect(storage.record).toEqual(record);
    expect(storage.writes).toBe(0);
  });

  it('accepts an upgrade scheduled exactly at the watermark and completes it', async () => {
    const record = saveWithUpgrade(START);
    const storage = new MemoryStorage(record);

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START, // exactly the boundary
      storage,
      debounceMs: 0,
    });

    expect(village.problem).toBeNull();
    expect(village.source).toBe('restored');
    const keep = village.state.buildings.find((building) => building.type === 'keep')!;
    expect(keep.level).toBe(2);
    expect(keep.upgrade).toBeUndefined();
    // The Keep's builder is released; the fixture's own construction keeps its
    // own assignment.
    expect(
      village.state.builders.busy.some((assignment) => assignment.buildingId === keep.id),
    ).toBe(false);
    village.autosave?.dispose();
  });

  it('completes an overdue job that is ahead of the watermark but behind the clock', async () => {
    const record = saveWithUpgrade(START + 1_000);
    const storage = new MemoryStorage(record);

    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START + 3_600_000,
      storage,
      debounceMs: 0,
    });

    expect(village.problem).toBeNull();
    expect(village.reconciled).toBe(true);
    expect(village.state.buildings.find((building) => building.type === 'keep')!.level).toBe(2);
    village.autosave?.dispose();
  });
});

describe('a session is scoped to the revision it loaded', () => {
  it('writes the next revision and never revision 0', async () => {
    const storage = new MemoryStorage();
    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    expect(village.revision).toBe(0);
    village.autosave?.schedule(village.state);
    await village.autosave?.flush();

    expect(storage.expectations).toEqual([0]);
    expect((storage.record as VillageSave).revision).toBe(1);
    village.autosave?.dispose();
  });

  it('carries a restored revision forward', async () => {
    const record = createSave(
      createNewPlayerState(GAME_CONFIG, START),
      GAME_CONFIG.version,
      START,
      7,
    );
    const storage = new MemoryStorage(record);
    const village = await bootstrapVillage({
      config: GAME_CONFIG,
      now: () => START,
      storage,
      debounceMs: 0,
    });

    expect(village.revision).toBe(7);
    village.autosave?.schedule(village.state);
    await village.autosave?.flush();

    expect(storage.expectations).toEqual([7]);
    expect((storage.record as VillageSave).revision).toBe(8);
    village.autosave?.dispose();
  });
});
