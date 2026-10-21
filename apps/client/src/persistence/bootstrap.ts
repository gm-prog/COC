import {
  createNewPlayerState,
  type CatchUpEvent,
  type GameConfig,
  type PlayerState,
} from '@coc/sim-core';
import { VillageAutosave } from './autosave';
import {
  IndexedDbVillageStorage,
  loadVillage,
  restoreVillage,
  type SaveProblem,
  type VillageLoadResult,
  type VillageStorage,
} from './villageSave';

/**
 * Startup glue between IndexedDB and the scene.
 *
 * The village is resolved *before* the Phaser game exists, so the scene is
 * constructed with its final state. That removes the race the obvious
 * alternative has: starting on a placeholder village and swapping in the loaded
 * one would let an early tap place a building into the placeholder, which the
 * swap would then discard.
 *
 * This module never throws. A broken store must not stop the game from
 * starting, and a rejected record must not be replaced with a starter one —
 * that would destroy the player's only copy of their village.
 */

/** Where the starting state came from. */
export type VillageSource = 'restored' | 'new' | 'unsaved';

export interface VillageBootstrap {
  state: PlayerState;
  /** `null` means saving is disabled for this session (see `problem`). */
  autosave: VillageAutosave | null;
  source: VillageSource;
  /** Completion events applied while reconciling the offline window. */
  events: CatchUpEvent[];
  /** True when elapsed time was replayed through `catchUp`. */
  reconciled: boolean;
  /**
   * Why saving was disabled, or why the village could not be restored.
   *
   * `null` for both a restored save and a first-time player with a working
   * store — those are the two healthy outcomes.
   */
  problem: SaveProblem | null;
  /**
   * Revision the loaded record carried (0 when the store was empty).
   *
   * The first write from this session asserts it; if another tab has written
   * since, the store refuses the write instead of silently replacing it.
   */
  revision: number;
}

export interface BootstrapOptions {
  config: GameConfig;
  /** Injected clock, in epoch milliseconds. */
  now: () => number;
  /** Tests inject a fake; production uses IndexedDB. */
  storage?: VillageStorage;
  /** Bound on the initial read, so a blocked database cannot hang startup. */
  readTimeoutMs?: number;
  debounceMs?: number;
  onSaveError?: (error: unknown) => void;
}

export const DEFAULT_READ_TIMEOUT_MS = 3_000;

export async function bootstrapVillage(options: BootstrapOptions): Promise<VillageBootstrap> {
  const { config, now } = options;
  const storage = options.storage ?? new IndexedDbVillageStorage();
  const timeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  const loaded = await readWithTimeout(storage, config, timeoutMs);

  if (loaded.status === 'empty') {
    return {
      state: createNewPlayerState(config, now()),
      autosave: createAutosave(storage, options, 0),
      source: 'new',
      events: [],
      reconciled: false,
      problem: null,
      revision: 0,
    };
  }

  if (loaded.status === 'loaded') {
    const restored = restoreVillage(loaded.save, config, now());

    if (restored.clockWentBackwards) {
      // The device clock is behind the saved village's watermark, so `catchUp`
      // refused to run. Saving must stay off for this session: the in-memory
      // village has not been reconciled, and writing it back would replace a
      // good record with one stamped from a clock we know is wrong. The
      // original record is left exactly as it is until the clock catches up.
      return {
        state: restored.state,
        autosave: null,
        source: 'restored',
        events: [],
        reconciled: false,
        problem: {
          code: 'clock_behind',
          message: `device clock is before the saved village's lastSyncAt (${restored.state.lastSyncAt})`,
        },
        revision: loaded.save.revision,
      };
    }

    return {
      state: restored.state,
      autosave: createAutosave(storage, options, loaded.save.revision),
      source: 'restored',
      events: restored.events,
      reconciled: restored.reconciled,
      problem: null,
      revision: loaded.save.revision,
    };
  }

  // `unreadable` (a record exists but was rejected) and `unavailable` (no
  // usable store) both fall back to a starter village *in memory*. Saving is
  // disabled so a rejected record is never overwritten.
  return unsavedVillage(config, now(), loaded.problem);
}

/**
 * A village that exists only in memory, with saving switched off.
 *
 * Exported for the last-resort catch in `main.ts`: if anything unexpected
 * throws while resolving storage, the player still gets a playable game rather
 * than a blank canvas.
 */
export function unsavedVillage(
  config: GameConfig,
  now: number,
  problem: SaveProblem,
): VillageBootstrap {
  return {
    state: createNewPlayerState(config, now),
    autosave: null,
    source: 'unsaved',
    events: [],
    reconciled: false,
    problem,
    // Nothing was loaded, so no revision is claimed. There is no autosave to
    // assert one anyway.
    revision: 0,
  };
}

function createAutosave(
  storage: VillageStorage,
  options: BootstrapOptions,
  baseRevision: number,
): VillageAutosave {
  return new VillageAutosave(storage, {
    configVersion: options.config.version,
    now: options.now,
    baseRevision,
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.onSaveError === undefined ? {} : { onError: options.onSaveError }),
  });
}

/**
 * Bounds the initial read.
 *
 * A blocked upgrade (another tab holding the database open) leaves the open
 * request pending indefinitely. Timing out treats that as "storage unavailable
 * for now" instead of a blank screen.
 */
async function readWithTimeout(
  storage: VillageStorage,
  config: GameConfig,
  timeoutMs: number,
): Promise<VillageLoadResult> {
  if (timeoutMs <= 0) return loadVillage(storage, config);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    const handle = timer as unknown as { unref?: () => void };
    handle.unref?.();
  });

  try {
    const result = await Promise.race([loadVillage(storage, config), timeout]);
    if (result === 'timeout') {
      return {
        status: 'unavailable',
        problem: {
          code: 'storage_unavailable',
          message: `IndexedDB did not respond within ${timeoutMs} ms`,
        },
      };
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
