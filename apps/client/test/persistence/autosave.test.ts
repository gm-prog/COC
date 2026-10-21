import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState, type PlayerState } from '@coc/sim-core';
import { VillageAutosave, type SaveStatus } from '../../src/persistence/autosave';
import {
  SaveStorageError,
  type VillageSave,
  type VillageStorage,
  type VillageWriteResult,
} from '../../src/persistence/villageSave';

const START = 1_700_000_000_000;

/**
 * Storage double that records committed writes and can stall or fail them.
 *
 * `deferred` returns a promise per write, so a test can hold write A open while
 * queueing B and then fail A at a moment it chooses — no sleeps, no luck.
 */
class RecordingStorage implements VillageStorage {
  readonly writes: VillageSave[] = [];
  /** Writes that were attempted, committed or not. */
  readonly attempts: { save: VillageSave; expectedRevision: number }[] = [];
  private readonly delays: number[];
  failWith: Error | null = null;
  /** Set to answer the next write with a concurrency result instead of writing. */
  conflictWith: VillageWriteResult | null = null;

  constructor(delays: number[] = []) {
    this.delays = [...delays];
  }

  read(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  async write(save: VillageSave, expectedRevision: number): Promise<VillageWriteResult> {
    this.attempts.push({ save, expectedRevision });
    const delay = this.delays.shift() ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.conflictWith) {
      const outcome = this.conflictWith;
      this.conflictWith = null;
      return outcome;
    }
    if (this.failWith) throw this.failWith;
    this.writes.push(save);
    return { ok: true, revision: save.revision };
  }
}

function stateWithGold(gold: number): PlayerState {
  const state = createNewPlayerState(GAME_CONFIG, START);
  state.resources.gold = gold;
  return state;
}

function autosaveFor(storage: VillageStorage, debounceMs = 5_000) {
  let clock = START;
  const statuses: SaveStatus[] = [];
  const autosave = new VillageAutosave(storage, {
    configVersion: GAME_CONFIG.version,
    now: () => clock++,
    debounceMs,
    onStatus: (status) => statuses.push(status),
  });
  return { autosave, statuses };
}

describe('village autosave', () => {
  it('coalesces a burst of changes into a single write of the newest state', async () => {
    const storage = new RecordingStorage();
    const { autosave } = autosaveFor(storage);

    autosave.schedule(stateWithGold(900));
    autosave.schedule(stateWithGold(800));
    autosave.schedule(stateWithGold(700));
    await autosave.flush();

    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]?.state.resources.gold).toBe(700);
    expect(autosave.hasPendingWrite).toBe(false);
    autosave.dispose();
  });

  it('stamps the config version and a timestamp on every write', async () => {
    const storage = new RecordingStorage();
    const { autosave } = autosaveFor(storage);

    autosave.schedule(stateWithGold(500));
    await autosave.flush();

    expect(storage.writes[0]?.configVersion).toBe(GAME_CONFIG.version);
    expect(storage.writes[0]?.savedAt).toBeGreaterThanOrEqual(START);
    autosave.dispose();
  });

  it('does not let an older in-flight write replace a newer state', async () => {
    // The first write stalls long enough for a newer state to be queued.
    const storage = new RecordingStorage([60]);
    const { autosave } = autosaveFor(storage);

    autosave.schedule(stateWithGold(1000));
    const firstWrite = autosave.flush();

    await new Promise((resolve) => setTimeout(resolve, 10));
    autosave.schedule(stateWithGold(250));
    await firstWrite;
    await autosave.flush();

    expect(storage.writes.map((write) => write.state.resources.gold)).toEqual([1000, 250]);
    expect(storage.writes.at(-1)?.state.resources.gold).toBe(250);
    autosave.dispose();
  });

  it('keeps the newest revision regardless of completion order of queued updates', async () => {
    const storage = new RecordingStorage([20, 0, 0]);
    const { autosave } = autosaveFor(storage);

    autosave.schedule(stateWithGold(1));
    void autosave.flush();
    for (const gold of [2, 3, 4]) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      autosave.schedule(stateWithGold(gold));
    }
    await autosave.flush();
    await autosave.flush();

    // Whatever was written, the *last* committed record is the newest state.
    expect(storage.writes.at(-1)?.state.resources.gold).toBe(4);
    expect(autosave.currentRevision).toBe(4);
    autosave.dispose();
  });

  it('reports a failed write, keeps the state pending, and recovers on the next flush', async () => {
    const storage = new RecordingStorage();
    const errors: unknown[] = [];
    let clock = START;
    const autosave = new VillageAutosave(storage, {
      configVersion: GAME_CONFIG.version,
      now: () => clock++,
      debounceMs: 0,
      onError: (error) => errors.push(error),
    });

    storage.failWith = new SaveStorageError('quota exceeded');
    autosave.schedule(stateWithGold(300));
    await autosave.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SaveStorageError);
    expect(storage.writes).toHaveLength(0);
    expect(autosave.hasPendingWrite).toBe(true);
    expect(autosave.currentStatus).toBe('blocked');
    expect(autosave.lastSaved).toBeUndefined();

    storage.failWith = null;
    await autosave.flush();

    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]?.state.resources.gold).toBe(300);
    expect(autosave.hasPendingWrite).toBe(false);
    expect(autosave.currentStatus).toBe('saved');
    autosave.dispose();
  });

  it('never reports "saved" before the write has committed', async () => {
    const storage = new RecordingStorage([40]);
    const { autosave, statuses } = autosaveFor(storage);

    autosave.schedule(stateWithGold(10));
    expect(autosave.currentStatus).toBe('saving');
    expect(statuses).toEqual(['saving']);

    await autosave.flush();

    expect(statuses).toEqual(['saving', 'saved']);
    autosave.dispose();
  });

  it('does not repeat the same status, so the HUD is not rewritten for nothing', async () => {
    const storage = new RecordingStorage();
    const { autosave, statuses } = autosaveFor(storage);

    autosave.schedule(stateWithGold(10));
    autosave.schedule(stateWithGold(11));
    autosave.schedule(stateWithGold(12));
    await autosave.flush();

    expect(statuses).toEqual(['saving', 'saved']);
    autosave.dispose();
  });

  it('can swap its handlers after construction', async () => {
    const storage = new RecordingStorage();
    const seen: unknown[] = [];
    const statuses: SaveStatus[] = [];
    const { autosave } = autosaveFor(storage);
    autosave.setOnError((error) => seen.push(error));
    autosave.setOnStatus((status) => statuses.push(status));

    storage.failWith = new SaveStorageError('denied');
    autosave.schedule(stateWithGold(1));
    await autosave.flush();

    expect(seen).toHaveLength(1);
    expect(statuses).toContain('blocked');
    autosave.dispose();
  });

  it('stops accepting changes once disposed', async () => {
    const storage = new RecordingStorage();
    const { autosave } = autosaveFor(storage);

    autosave.dispose();
    autosave.schedule(stateWithGold(123));
    await autosave.flush();

    expect(storage.writes).toHaveLength(0);
    expect(autosave.hasPendingWrite).toBe(false);
  });

  it('snapshots the state at schedule time', async () => {
    const storage = new RecordingStorage();
    const { autosave } = autosaveFor(storage);
    const live = stateWithGold(640);

    autosave.schedule(live);
    live.resources.gold = 0; // the running village moves on before the write
    await autosave.flush();

    expect(storage.writes[0]?.state.resources.gold).toBe(640);
    autosave.dispose();
  });

  it('surfaces a failed write without an unhandled rejection', async () => {
    const storage = new RecordingStorage();
    storage.failWith = new SaveStorageError('disk full');
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const { autosave } = autosaveFor(storage);
      autosave.schedule(stateWithGold(5));
      await autosave.flush();
      // Let any stray rejection surface before checking.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([]);
      autosave.dispose();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

/**
 * Storage double whose writes are settled by the test.
 *
 * Deterministic by construction: there are no sleeps and no guessed timings, so
 * "A is still in flight when B arrives" is a fact the test creates, not a race
 * it hopes for.
 */
class DeferredStorage implements VillageStorage {
  readonly attempts: { save: VillageSave; expectedRevision: number }[] = [];
  private readonly waiting: Array<{
    resolve: (result: VillageWriteResult) => void;
    reject: (error: unknown) => void;
  }> = [];

  read(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  write(save: VillageSave, expectedRevision: number): Promise<VillageWriteResult> {
    this.attempts.push({ save, expectedRevision });
    return new Promise<VillageWriteResult>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  get inFlight(): number {
    return this.waiting.length;
  }

  /** Commits the oldest outstanding write. */
  commitOldest(): void {
    const next = this.waiting.shift();
    if (!next) throw new Error('no write in flight');
    next.resolve({ ok: true, revision: this.attempts.length });
  }

  /** Fails the oldest outstanding write. */
  failOldest(): void {
    const next = this.waiting.shift();
    if (!next) throw new Error('no write in flight');
    next.reject(new SaveStorageError('disk full'));
  }
}

/** Lets the autosave's internal await chain run until `done` holds. */
async function until(done: () => boolean, label: string): Promise<void> {
  for (let spin = 0; spin < 200; spin += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('autosave: a failed write must not strand the newest snapshot', () => {
  it('retries the snapshot whose timer was consumed while A was in flight', async () => {
    const storage = new DeferredStorage();
    const statuses: SaveStatus[] = [];
    const autosave = new VillageAutosave(storage, {
      configVersion: GAME_CONFIG.version,
      now: () => START,
      debounceMs: 1,
      retryMs: 5,
      maxRetryMs: 20,
      onStatus: (status) => statuses.push(status),
    });

    // 1. Queue A and start writing it.
    autosave.schedule(stateWithGold(900));
    const flushA = autosave.flush();
    await until(() => storage.inFlight === 1, 'write A to start');

    // 2. Queue B while A is still in flight.
    autosave.schedule(stateWithGold(800));
    // 3. B's debounce fires now. `ensureLoop` joins the in-flight loop and the
    //    timer is consumed — the exact stranding scenario.
    const flushB = autosave.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storage.attempts).toHaveLength(1);

    // 4. A fails.
    storage.failOldest();
    await Promise.all([flushA, flushB]);

    expect(autosave.currentStatus).toBe('blocked');
    expect(autosave.hasPendingWrite).toBe(true);
    expect(statuses).not.toContain('saved');

    // 5. The armed retry writes B — nothing was stranded.
    await until(() => storage.inFlight === 1, 'the retry to start');
    expect(storage.attempts).toHaveLength(2);
    storage.commitOldest();
    await until(() => autosave.currentStatus === 'saved', 'the retry to commit');

    expect(storage.attempts[1]!.save.state.resources.gold).toBe(800);
    expect(storage.attempts[1]!.expectedRevision).toBe(0);
    expect(autosave.hasPendingWrite).toBe(false);
    autosave.dispose();
  });

  it('lets a later flush write the snapshot a failure preserved', async () => {
    const storage = new DeferredStorage();
    const autosave = new VillageAutosave(storage, {
      configVersion: GAME_CONFIG.version,
      now: () => START,
      debounceMs: 1,
      // Long enough that the retry cannot fire during this test: recovery is
      // then unambiguously the second flush's doing.
      retryMs: 10_000,
      onStatus: () => undefined,
    });

    autosave.schedule(stateWithGold(700));
    const failing = autosave.flush();
    await until(() => storage.inFlight === 1, 'the first write');
    storage.failOldest();
    await failing;

    expect(autosave.currentStatus).toBe('blocked');
    expect(autosave.hasPendingWrite).toBe(true);

    const recovering = autosave.flush();
    await until(() => storage.inFlight === 1, 'the recovery write');
    storage.commitOldest();
    await recovering;

    expect(autosave.currentStatus).toBe('saved');
    expect(storage.attempts).toHaveLength(2);
    expect(storage.attempts[1]!.save.state.resources.gold).toBe(700);
    autosave.dispose();
  });

  it('backs off instead of hammering a store that keeps failing', async () => {
    let attempts = 0;
    const alwaysFails: VillageStorage = {
      read: () => Promise.resolve(undefined),
      write: () => {
        attempts += 1;
        return Promise.reject(new SaveStorageError('quota'));
      },
    };

    const autosave = new VillageAutosave(alwaysFails, {
      configVersion: GAME_CONFIG.version,
      now: () => START,
      debounceMs: 1,
      retryMs: 20,
      maxRetryMs: 40,
      onStatus: () => undefined,
    });

    autosave.schedule(stateWithGold(100));
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 20 ms, then 40 ms, then 40 ms: four attempts in 150 ms. A tight retry
    // loop would produce hundreds and would pin the main thread.
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(8);
    expect(autosave.currentStatus).toBe('blocked');
    autosave.dispose();
  });

  it('never reports saved while the newest snapshot is still pending', async () => {
    const storage = new DeferredStorage();
    const statuses: SaveStatus[] = [];
    const autosave = new VillageAutosave(storage, {
      configVersion: GAME_CONFIG.version,
      now: () => START,
      debounceMs: 1,
      retryMs: 10_000,
      onStatus: (status) => statuses.push(status),
    });

    autosave.schedule(stateWithGold(500));
    const writing = autosave.flush();
    await until(() => storage.inFlight === 1, 'the first write');
    autosave.schedule(stateWithGold(400)); // queues a newer snapshot
    storage.commitOldest();
    // The loop should immediately take the newer snapshot rather than declaring
    // the older one's success to be the end of the story.
    await until(() => storage.inFlight === 1, 'the second write');
    expect(statuses).not.toContain('saved');

    storage.commitOldest();
    await writing;
    await until(() => autosave.currentStatus === 'saved', 'the final commit');
    expect(storage.attempts.map((attempt) => attempt.save.state.resources.gold)).toEqual([
      500, 400,
    ]);
    autosave.dispose();
  });
});
