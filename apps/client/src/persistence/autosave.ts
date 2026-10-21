import { clonePlayerState, type GameConfig, type PlayerState } from '@coc/sim-core';
import { createSave, type VillageSave, type VillageStorage } from './villageSave';

/**
 * Coalescing autosave.
 *
 * The village changes several times a second (production ticks once per second
 * in `catchUp`), so writing on every change would mean one IndexedDB
 * transaction per second. Two things keep that in check:
 *
 * - **Coalescing.** `schedule()` keeps only the newest state and arms a short
 *   timer, so a burst of changes produces one write.
 * - **Serialization.** At most one write is in flight. The loop takes the
 *   pending snapshot *before* awaiting the write, so a state queued during a
 *   slow write is written afterwards — an older asynchronous write can never
 *   land on top of a newer one.
 *
 * A failed write keeps the snapshot pending for the next flush (so progress is
 * not dropped on a transient error) but does not retry in a loop, which would
 * spin against a store that is refusing writes.
 */

/**
 * What the player should be told about saving.
 *
 * - `idle` — nothing has changed yet this session.
 * - `saving` — a write is queued or in flight.
 * - `saved` — the most recent write *committed* (never reported optimistically).
 * - `blocked` — the last write failed; progress is in memory only for now.
 */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'blocked';

export interface AutosaveOptions {
  /** `GAME_CONFIG.version`, stamped into each record. */
  configVersion: GameConfig['version'];
  /** Injected clock, in epoch milliseconds. */
  now: () => number;
  /** Quiet period before a scheduled write runs. Default 400 ms. */
  debounceMs?: number;
  /** Called when the status changes; never for a no-op repetition. */
  onStatus?: (status: SaveStatus) => void;
  /** Called for every write failure, after the status becomes `blocked`. */
  onError?: (error: unknown) => void;
}

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 400;

export class VillageAutosave {
  private readonly storage: VillageStorage;
  private readonly configVersion: GameConfig['version'];
  private readonly now: () => number;
  private readonly debounceMs: number;
  private onStatus: ((status: SaveStatus) => void) | undefined;
  private onError: ((error: unknown) => void) | undefined;

  private pending: PlayerState | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loop: Promise<void> | undefined;
  private disposed = false;
  private saved: VillageSave | undefined;
  private status: SaveStatus = 'idle';

  /**
   * Monotonic counter of accepted snapshots.
   *
   * Not strictly needed for correctness — the single-flight loop already orders
   * writes — but it makes the ordering guarantee observable, so a test can
   * assert that the *newest* revision is the one that ended up on disk.
   */
  private revision = 0;

  constructor(storage: VillageStorage, options: AutosaveOptions) {
    this.storage = storage;
    this.configVersion = options.configVersion;
    this.now = options.now;
    this.debounceMs = options.debounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
  }

  /**
   * Replaces the status handler.
   *
   * The scene installs one after construction so a runtime write failure can be
   * surfaced in the HUD without threading the HUD through the bootstrap layer.
   */
  setOnStatus(handler: ((status: SaveStatus) => void) | undefined): void {
    this.onStatus = handler;
  }

  /** Replaces the failure handler. */
  setOnError(handler: ((error: unknown) => void) | undefined): void {
    this.onError = handler;
  }

  /** Current status; see {@link SaveStatus}. */
  get currentStatus(): SaveStatus {
    return this.status;
  }

  /** The record most recently confirmed written, for tests and diagnostics. */
  get lastSaved(): VillageSave | undefined {
    return this.saved;
  }

  /** Revision of the most recently queued snapshot. */
  get currentRevision(): number {
    return this.revision;
  }

  /** True when a change is queued but not yet committed. */
  get hasPendingWrite(): boolean {
    return this.pending !== undefined;
  }

  /** Queues `state` for writing, replacing any older queued snapshot. */
  schedule(state: PlayerState): void {
    if (this.disposed) return;
    // Clone now: the caller keeps mutating the live village, and a queued
    // reference could otherwise be written in a later, inconsistent shape.
    this.pending = clonePlayerState(state);
    this.revision += 1;
    this.setStatus('saving');
    this.armTimer();
  }

  /** Writes anything queued, immediately. Safe to call when idle. */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.ensureLoop();
  }

  /** Stops accepting changes. Does not cancel an in-flight write. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private setStatus(status: SaveStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus?.(status);
  }

  private armTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ensureLoop();
    }, this.debounceMs);
    // Node keeps the process alive for pending timers; in the browser this is a
    // no-op. Unref-ing stops a debounce from delaying a CLI/test exit.
    const timer = this.timer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private ensureLoop(): Promise<void> {
    if (this.loop) return this.loop;

    this.loop = (async () => {
      try {
        while (this.pending !== undefined) {
          const state = this.pending;
          this.pending = undefined;
          const save = createSave(state, this.configVersion, this.now());
          try {
            await this.storage.write(save);
            this.saved = save;
            if (this.pending === undefined) this.setStatus('saved');
          } catch (error) {
            // Preserve the unsaved state, but only if nothing newer arrived
            // while the write was in flight.
            this.pending ??= state;
            this.setStatus('blocked');
            this.onError?.(error);
            return;
          }
        }
      } finally {
        this.loop = undefined;
      }
    })();

    return this.loop;
  }
}
