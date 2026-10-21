import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState, type PlayerState } from '@coc/sim-core';
import { VillageAutosave, type SaveStatus } from '../../src/persistence/autosave';
import {
  IndexedDbVillageStorage,
  SAVE_DB_NAME,
  SAVE_DB_VERSION,
  SAVE_KEY,
  SAVE_SCHEMA_VERSION,
  SAVE_STORE_NAME,
  createSave,
  loadVillage,
  migrateSave,
  storedRevisionOf,
  type VillageSave,
  type VillageStorage,
  type VillageWriteResult,
} from '../../src/persistence/villageSave';

const START = 1_700_000_000_000;

function freshState(gold = 1_000): PlayerState {
  const state = createNewPlayerState(GAME_CONFIG, START);
  state.resources.gold = gold;
  return state;
}

/** Two storage instances over the same database, as two tabs would be. */
function twoTabs(): { first: IndexedDbVillageStorage; second: IndexedDbVillageStorage } {
  const factory = new IDBFactory();
  return {
    first: new IndexedDbVillageStorage(factory),
    second: new IndexedDbVillageStorage(factory),
  };
}

/** Reads the raw stored value through an independent connection. */
async function rawRead(factory: IDBFactory): Promise<unknown> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(SAVE_DB_NAME, SAVE_DB_VERSION);
    request.onupgradeneeded = () => {
      const created = request.result;
      if (!created.objectStoreNames.contains(SAVE_STORE_NAME)) {
        created.createObjectStore(SAVE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

/** Writes a value straight into the store, as a previous build would have. */
async function seedRaw(factory: IDBFactory, value: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(SAVE_DB_NAME, SAVE_DB_VERSION);
    request.onupgradeneeded = () => {
      const created = request.result;
      if (!created.objectStoreNames.contains(SAVE_STORE_NAME)) {
        created.createObjectStore(SAVE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

describe('single-writer concurrency', () => {
  it('refuses a stale write and preserves the winner', async () => {
    const { first, second } = twoTabs();
    const factory = (first as unknown as { factory: IDBFactory }).factory;

    // Both tabs load the same initial village (revision 1).
    const initial = createSave(freshState(900), GAME_CONFIG.version, START, 1);
    expect(await first.write(initial, 0)).toEqual({ ok: true, revision: 1 });

    const loadedFirst = await loadVillage(first, GAME_CONFIG);
    const loadedSecond = await loadVillage(second, GAME_CONFIG);
    expect(loadedFirst.status).toBe('loaded');
    expect(loadedSecond.status).toBe('loaded');
    if (loadedFirst.status !== 'loaded' || loadedSecond.status !== 'loaded') return;
    expect(loadedFirst.save.revision).toBe(1);
    expect(loadedSecond.save.revision).toBe(1);

    // The first tab commits revision 2.
    const winner = createSave(freshState(800), GAME_CONFIG.version, START + 1, 2);
    expect(await first.write(winner, loadedFirst.save.revision)).toEqual({
      ok: true,
      revision: 2,
    });

    // The second tab, still believing revision 1, must not overwrite it.
    const stale = createSave(freshState(700), GAME_CONFIG.version, START + 2, 2);
    expect(await second.write(stale, loadedSecond.save.revision)).toEqual({
      ok: false,
      reason: 'conflict',
      storedRevision: 2,
    });

    const stored = (await rawRead(factory)) as VillageSave;
    expect(stored.revision).toBe(2);
    expect(stored.state.resources.gold).toBe(800);

    first.close();
    second.close();
  });

  it('lets only one of two tabs win an empty store', async () => {
    const { first, second } = twoTabs();
    const factory = (first as unknown as { factory: IDBFactory }).factory;

    // Both tabs see an empty store (revision 0) and build a village.
    expect(await first.read()).toBeUndefined();
    expect(await second.read()).toBeUndefined();

    const firstSave = createSave(freshState(950), GAME_CONFIG.version, START, 1);
    const secondSave = createSave(freshState(850), GAME_CONFIG.version, START, 1);

    expect(await first.write(firstSave, 0)).toEqual({ ok: true, revision: 1 });
    expect(await second.write(secondSave, 0)).toEqual({
      ok: false,
      reason: 'conflict',
      storedRevision: 1,
    });

    const stored = (await rawRead(factory)) as VillageSave;
    expect(stored.state.resources.gold).toBe(950);

    first.close();
    second.close();
  });

  it('keeps ordinary sequential writes working', async () => {
    const { first } = twoTabs();
    const factory = (first as unknown as { factory: IDBFactory }).factory;

    for (let revision = 1; revision <= 5; revision += 1) {
      const save = createSave(freshState(revision), GAME_CONFIG.version, START + revision, revision);
      expect(await first.write(save, revision - 1)).toEqual({ ok: true, revision });
    }

    const stored = (await rawRead(factory)) as VillageSave;
    expect(stored.revision).toBe(5);
    expect(stored.state.resources.gold).toBe(5);
    first.close();
  });

  it('never treats a stale write as a storage failure', async () => {
    const { first, second } = twoTabs();
    await first.write(createSave(freshState(900), GAME_CONFIG.version, START, 1), 0);
    await first.write(createSave(freshState(800), GAME_CONFIG.version, START + 1, 2), 1);

    // A stale write resolves with a typed conflict; it does not reject. The
    // player must be told "another tab saved", not "your browser is broken".
    const outcome = await second.write(
      createSave(freshState(700), GAME_CONFIG.version, START + 2, 2),
      1,
    );
    expect(outcome).toEqual({ ok: false, reason: 'conflict', storedRevision: 2 });

    first.close();
    second.close();
  });
});

describe('schema v2 migration', () => {
  it('carries a v1 record forward without rewriting it', async () => {
    const factory = new IDBFactory();
    const storage = new IndexedDbVillageStorage(factory);

    const v1 = {
      schemaVersion: 1,
      savedAt: START,
      configVersion: GAME_CONFIG.version,
      state: freshState(875),
    };
    await seedRaw(factory, v1);

    const loaded = await loadVillage(storage, GAME_CONFIG);
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;
    expect(loaded.save.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(loaded.save.revision).toBe(1);
    expect(loaded.save.state.resources.gold).toBe(875);

    // Reading must not have rewritten the store: the v1 record is still there.
    expect(await rawRead(factory)).toEqual(v1);

    // The first v2 write upgrades it in place.
    const next = createSave(loaded.save.state, GAME_CONFIG.version, START + 1, 2);
    expect(await storage.write(next, loaded.save.revision)).toEqual({ ok: true, revision: 2 });

    const stored = (await rawRead(factory)) as VillageSave;
    expect(stored.schemaVersion).toBe(2);
    expect(stored.revision).toBe(2);
    storage.close();
  });

  it('assigns revision 1 to v1 and rejects a v2 record claiming revision 0', async () => {
    const migrated = migrateSave({
      schemaVersion: 1,
      savedAt: START,
      configVersion: GAME_CONFIG.version,
      state: freshState(),
    });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.record.schemaVersion).toBe(2);
    expect(migrated.record.revision).toBe(1);

    // A stored record always has a writer, so revision 0 is not readable.
    const zero = migrateSave({
      schemaVersion: 2,
      revision: 0,
      savedAt: START,
      configVersion: GAME_CONFIG.version,
      state: freshState(),
    });
    expect(zero.ok).toBe(true); // migration only upcasts; the envelope rejects it
    if (!zero.ok) return;
    const reader: VillageStorage = {
      read: async () => zero.record,
      write: async (): Promise<VillageWriteResult> => ({ ok: true, revision: 1 }),
    };
    await expect(loadVillage(reader, GAME_CONFIG)).resolves.toMatchObject({
      status: 'unreadable',
    });
  });

  it('reports the effective revision of a stored record without migrating it', () => {
    expect(storedRevisionOf(undefined)).toBeUndefined();
    expect(storedRevisionOf(null)).toBeUndefined();
    expect(storedRevisionOf({ schemaVersion: 1 })).toBe(1);
    expect(storedRevisionOf({ schemaVersion: 2, revision: 4 })).toBe(4);
    expect(storedRevisionOf({ schemaVersion: 2, revision: 0 })).toBeUndefined();
    expect(storedRevisionOf({ schemaVersion: 99, revision: 1 })).toBeUndefined();
  });
});

describe('autosave in two tabs', () => {
  it('stops the stale tab with a conflict instead of overwriting the winner', async () => {
    const { first, second } = twoTabs();
    const factory = (first as unknown as { factory: IDBFactory }).factory;

    await first.write(createSave(freshState(900), GAME_CONFIG.version, START, 1), 0);

    const statuses: SaveStatus[] = [];
    const conflicts: unknown[] = [];
    const staleTab = new VillageAutosave(second, {
      configVersion: GAME_CONFIG.version,
      now: () => START + 10,
      baseRevision: 1,
      debounceMs: 0,
      onStatus: (status) => statuses.push(status),
      onConflict: (info) => conflicts.push(info),
    });

    // The winning tab commits revision 2 while the stale tab holds revision 1.
    expect(
      await first.write(createSave(freshState(800), GAME_CONFIG.version, START + 1, 2), 1),
    ).toEqual({ ok: true, revision: 2 });

    staleTab.schedule(freshState(100));
    await staleTab.flush();

    expect(staleTab.currentStatus).toBe('conflict');
    expect(staleTab.currentConflict).toEqual({ storedRevision: 2, reason: 'conflict' });
    expect(conflicts).toHaveLength(1);
    expect(statuses).not.toContain('saved');
    // Crucially not `blocked`: a conflict is not a broken browser.
    expect(statuses).not.toContain('blocked');

    const stored = (await rawRead(factory)) as VillageSave;
    expect(stored.revision).toBe(2);
    expect(stored.state.resources.gold).toBe(800);

    // A conflict is terminal for the session: nothing else is written.
    staleTab.schedule(freshState(50));
    await staleTab.flush();
    expect(((await rawRead(factory)) as VillageSave).state.resources.gold).toBe(800);

    staleTab.dispose();
    first.close();
    second.close();
  });

  it('lets the winner keep saving normally', async () => {
    const { first, second } = twoTabs();
    const factory = (first as unknown as { factory: IDBFactory }).factory;
    await first.write(createSave(freshState(900), GAME_CONFIG.version, START, 1), 0);

    const winner = new VillageAutosave(first, {
      configVersion: GAME_CONFIG.version,
      now: () => START + 10,
      baseRevision: 1,
      debounceMs: 0,
    });

    winner.schedule(freshState(600));
    await winner.flush();
    expect(winner.currentStatus).toBe('saved');

    winner.schedule(freshState(500));
    await winner.flush();
    expect(winner.currentStatus).toBe('saved');

    const stored = (await rawRead(factory)) as VillageSave;
    expect(stored.revision).toBe(3);
    expect(stored.state.resources.gold).toBe(500);

    winner.dispose();
    first.close();
    second.close();
  });
});
