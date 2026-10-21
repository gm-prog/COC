import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState, type PlayerState } from '@coc/sim-core';
import { VillageAutosave, type SaveStatus } from '../../src/persistence/autosave';
import {
  SaveStorageError,
  type VillageSave,
  type VillageStorage,
} from '../../src/persistence/villageSave';

const START = 1_700_000_000_000;

/** Storage double that records committed writes and can stall or fail them. */
class RecordingStorage implements VillageStorage {
  readonly writes: VillageSave[] = [];
  private readonly delays: number[];
  failWith: Error | null = null;

  constructor(delays: number[] = []) {
    this.delays = [...delays];
  }

  read(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  async write(save: VillageSave): Promise<void> {
    const delay = this.delays.shift() ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.failWith) throw this.failWith;
    this.writes.push(save);
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
