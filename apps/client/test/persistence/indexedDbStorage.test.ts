import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState } from '@coc/sim-core';
import {
  IndexedDbVillageStorage,
  SAVE_DB_NAME,
  SAVE_DB_VERSION,
  SAVE_KEY,
  SAVE_SCHEMA_VERSION,
  SAVE_STORE_NAME,
  SaveStorageError,
  createSave,
  loadVillage,
  type VillageSave,
} from '../../src/persistence/villageSave';

const START = 1_700_000_000_000;

/**
 * Each test gets its own in-memory IndexedDB, so state never leaks between
 * tests and nothing touches a real browser database.
 */
function storage(): IndexedDbVillageStorage {
  return new IndexedDbVillageStorage(new IDBFactory());
}

function freshSave(): VillageSave {
  return createSave(createNewPlayerState(GAME_CONFIG, START), GAME_CONFIG.version, START);
}

/** Reads the store through a separate connection, bypassing the class under test. */
async function rawRead(factory: IDBFactory): Promise<unknown> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(SAVE_DB_NAME);
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

describe('IndexedDB village storage', () => {
  it('creates the documented store in a fresh database', async () => {
    const factory = new IDBFactory();
    // Let the storage class create the database, then inspect it as a second
    // connection would see it.
    const store = new IndexedDbVillageStorage(factory);
    await store.write(freshSave());
    store.close();

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(SAVE_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    expect(db.name).toBe('emberhold');
    expect(db.version).toBe(SAVE_DB_VERSION);
    expect(Array.from(db.objectStoreNames)).toEqual([SAVE_STORE_NAME]);
    db.close();
  });

  it('round-trips a v1 envelope through a real transaction', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbVillageStorage(factory);
    const save = freshSave();

    await store.write(save);

    expect(await store.read()).toEqual(save);
    // And it is really under `village`/`current`, not somewhere incidental.
    expect(await rawRead(factory)).toEqual(save);
    store.close();
  });

  it('reports a missing record as undefined, which loads as a new player', async () => {
    const store = storage();

    expect(await store.read()).toBeUndefined();
    await expect(loadVillage(store, GAME_CONFIG)).resolves.toEqual({ status: 'empty' });
    store.close();
  });

  it('keeps the record across connections, as after a reload', async () => {
    const factory = new IDBFactory();
    const save = freshSave();

    const first = new IndexedDbVillageStorage(factory);
    await first.write(save);
    first.close();

    const second = new IndexedDbVillageStorage(factory);
    expect(await second.read()).toEqual(save);
    second.close();
  });

  it('persists a later write over an earlier one', async () => {
    const store = storage();
    const older = freshSave();
    const newerState = createNewPlayerState(GAME_CONFIG, START);
    newerState.resources.gold = 42;
    const newer = createSave(newerState, GAME_CONFIG.version, START + 1);

    await store.write(older);
    await store.write(newer);

    expect(await store.read()).toEqual(newer);
    store.close();
  });

  it('rejects a record it cannot read and leaves it in place', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbVillageStorage(factory);
    const corrupt = {
      schemaVersion: SAVE_SCHEMA_VERSION + 5,
      savedAt: START,
    } as unknown as VillageSave;
    await store.write(corrupt);

    const loaded = await loadVillage(store, GAME_CONFIG);

    expect(loaded.status).toBe('unreadable');
    if (loaded.status !== 'unreadable') return;
    expect(loaded.problem.code).toBe('unsupported_schema');
    // Nothing may have replaced the record: the player can still recover it
    // with a newer build.
    expect(await rawRead(factory)).toEqual(corrupt);
    store.close();
  });

  it('rejects garbage rather than treating it as a village', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbVillageStorage(factory);
    await store.write('not a village' as unknown as VillageSave);

    const loaded = await loadVillage(store, GAME_CONFIG);

    expect(loaded.status).toBe('unreadable');
    if (loaded.status !== 'unreadable') return;
    expect(loaded.problem.code).toBe('malformed');
    expect(await rawRead(factory)).toBe('not a village');
    store.close();
  });

  it('reports an unusable store as unavailable, not as "no save"', async () => {
    // No factory passed and none on globalThis in Node: every operation must
    // reject, never resolve as if it had saved.
    const unavailable = new IndexedDbVillageStorage();

    await expect(unavailable.read()).rejects.toBeInstanceOf(SaveStorageError);
    await expect(unavailable.write(freshSave())).rejects.toBeInstanceOf(SaveStorageError);

    // The loader must not mistake that for an empty database.
    await expect(loadVillage(unavailable, GAME_CONFIG)).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('rejects a read whose request errors', async () => {
    const fake = new FakeDatabase();
    fake.failReadRequest.current = true;
    const store = new IndexedDbVillageStorage({ open: () => fake.open() } as unknown as IDBFactory);

    await expect(store.read()).rejects.toBeInstanceOf(SaveStorageError);
  });
});

/**
 * A deliberately minimal IndexedDB double.
 *
 * `fake-indexeddb` implements the spec faithfully, which means it is hard to
 * make it fire `request.onsuccess` and *then* fail the transaction. That
 * ordering is exactly the contract this class must honour, so one test drives
 * it by hand instead of reaching for a global prototype patch.
 */
class FakeDatabase {
  readonly failTransaction = { current: false };
  readonly failReadRequest = { current: false };
  private readonly value: { current: unknown } = { current: undefined };

  readonly transactionCalls: string[] = [];

  open(): IDBOpenDBRequest {
    const request = {
      onupgradeneeded: null as null | (() => void),
      onsuccess: null as null | (() => void),
      onerror: null as null | (() => void),
      result: this.database(),
      error: null,
    };

    queueMicrotask(() => {
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });

    return request as unknown as IDBOpenDBRequest;
  }

  private database(): IDBDatabase {
    const value = this.value;
    const fail = this.failTransaction;
    const failRead = this.failReadRequest;
    const calls = this.transactionCalls;

    const database = {
      objectStoreNames: { contains: () => true },
      close: () => undefined,
      transaction: (store: string) => {
        calls.push(store);
        const tx: Record<string, unknown> = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: new Error('transaction failed'),
          objectStore: () => ({
            get: () => {
              const request: Record<string, unknown> = {
                onsuccess: null,
                onerror: null,
                result: undefined,
                error: new Error('read failed'),
              };
              queueMicrotask(() => {
                if (failRead.current) {
                  (request.onerror as (() => void) | null)?.call(request);
                  return;
                }
                request.result = value.current;
                (request.onsuccess as (() => void) | null)?.call(request);
              });
              return request;
            },
            put: (next: unknown) => {
              const request: Record<string, unknown> = { onsuccess: null, onerror: null };
              queueMicrotask(() => {
                // The request succeeds first...
                value.current = next;
                (request.onsuccess as (() => void) | null)?.call(request);
                // ...and only afterwards does the transaction fail to commit.
                if (fail.current) {
                  (tx.onerror as (() => void) | null)?.call(tx);
                } else {
                  (tx.oncomplete as (() => void) | null)?.call(tx);
                }
              });
              return request;
            },
          }),
        };
        return tx;
      },
    };

    return database as unknown as IDBDatabase;
  }
}

describe('transaction completion contract', () => {
  it('resolves a write only once the transaction completes', async () => {
    const fake = new FakeDatabase();
    const store = new IndexedDbVillageStorage({ open: () => fake.open() } as unknown as IDBFactory);

    await expect(store.write(freshSave())).resolves.toBeUndefined();
    expect(fake.transactionCalls).toEqual([SAVE_STORE_NAME]);
  });

  it('rejects a write whose request succeeded but whose transaction failed', async () => {
    const fake = new FakeDatabase();
    fake.failTransaction.current = true;
    const store = new IndexedDbVillageStorage({ open: () => fake.open() } as unknown as IDBFactory);

    // A `put` request's success only means the value was queued; reporting a
    // save here would lie to the player about their progress.
    await expect(store.write(freshSave())).rejects.toBeInstanceOf(SaveStorageError);
  });
});
