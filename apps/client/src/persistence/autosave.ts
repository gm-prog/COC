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
 * A failed write keeps the newest snapshot pending (so progress is not dropped on
 * a transient error) and arms a *backed-off* retry. It deliberately does not
 * spin: each failure doubles the delay up to {@link MAX_AUTOSAVE_RETRY_MS}, so a
 * store that refuses every write is retried slowly rather than in a tight loop.
 *
 * **Why the retry timer exists at all.** A snapshot queued while a write is in
 * flight arms its own debounce timer; when that timer fires it only *joins* the
 * running loop (`ensureLoop` returns the in-flight promise). If the in-flight
 * write then fails, the loop exits — and its caller's timer has already been
 * consumed. Without an explicit retry the newest snapshot would sit pending
 * forever with nothing scheduled to write it. Every failure path therefore arms
 * a timer as its last act.
 */

/**
 * What the player should be told about saving.
 *
 * - `idle` — nothing has changed yet this session.
 * - `saving` — a write is queued or in flight.
 * - `saved` — the most recent write *committed* (never reported optimistically).
 * - `blocked` — the last write failed; progress is in memory only for now, and a
 *   backed-off retry is armed.
 * - `conflict` — another tab committed a newer record. Terminal for this
 *   session: nothing will be written, and the player must reload.
 */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'blocked' | 'conflict';

export interface AutosaveOptions {
  /** `GAME_CONFIG.version`, stamped into each record. */
  configVersion: GameConfig['version'];
  /** Injected clock, in epoch milliseconds. */
  now: () => number;
  /**
   * Revision the session loaded (0 for an empty store). Every write asserts it.
   */
  baseRevision?: number;
  /** Quiet period before a scheduled write runs. Default 400 ms. */
  debounceMs?: number;
  /** First retry delay after a failed write. Default 2 s. */
  retryMs?: number;
  /** Ceiling for the exponential retry backoff. Default 60 s. */
  maxRetryMs?: number;
  /** Called when the status changes; never for a no-op repetition. */
  onStatus?: (status: SaveStatus) => void;
  /** Called for every write failure, after the status becomes `blocked`. */
  onError?: (error: unknown) => void;
  /**
   * Called once when a write is refused because another session owns a newer
   * record. The scene uses it to switch to read-only.
   */
  onConflict?: (info: SaveConflict) => void;
}

/** Details of a refused write. */
export interface SaveConflict {
  /** Revision the store held when the write was refused; -1 if unreadable. */
  storedRevision: number;
  /** Why it was refused. */
  reason: 'conflict' | 'unreadable_record';
}

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 400;
export const DEFAULT_AUTOSAVE_RETRY_MS = 2_000;
export const MAX_AUTOSAVE_RETRY_MS = 60_000;

export class VillageAutosave {
  private readonly storage: VillageStorage;
  private readonly configVersion: GameConfig['version'];
  private readonly now: () => number;
  private readonly debounceMs: number;
  private onStatus: ((status: SaveStatus) => void) | undefined;
  private onError: ((error: unknown) => void) | undefined;
  private onConflict: ((info: SaveConflict) => void) | undefined;

  private pending: PlayerState | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loop: Promise<void> | undefined;
  private disposed = false;
  private saved: VillageSave | undefined;
  private status: SaveStatus = 'idle';

  /** Revision this session believes is committed in the store. */
  private baseRevision: number;
  /** Consecutive failed attempts, driving the retry backoff. */
  private consecutiveFailures = 0;
  /** Set once a write is refused for concurrency reasons; terminal. */
  private conflict: SaveConflict | undefined;

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
    this.baseRevision = options.baseRevision ?? 0;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onConflict = options.onConflict;
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

  /** Replaces the conflict handler. */
  setOnConflict(handler: ((info: SaveConflict) => void) | undefined): void {
    this.onConflict = handler;
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

  /** Revision this session expects the store to hold. */
  get currentBaseRevision(): number {
    return this.baseRevision;
  }

  /** The conflict that stopped this session, if any. */
  get currentConflict(): SaveConflict | undefined {
    return this.conflict;
  }

  /** Queues `state` for writing, replacing any older queued snapshot. */
  schedule(state: PlayerState): void {
    if (this.disposed || this.conflict !== undefined) return;
    // Clone now: the caller keeps mutating the live village, and a queued
    // reference could otherwise be written in a later, inconsistent shape.
    this.pending = clonePlayerState(state);
    this.revision += 1;
    this.setStatus('saving');
    this.armTimer(this.debounceMs);
  }

  /**
   * Writes anything queued, as far as one pass can.
   *
   * Well-defined when it overlaps an in-flight write: it joins that write rather
   * than starting a second one (the single-flight loop already guarantees
   * ordering). If the joined write fails, the newest snapshot stays pending and
   * a backed-off retry is armed by the failure path, so this call cannot leave a
   * snapshot with nothing scheduled to write it. Calling `flush()` again retries
   * immediately — that is the documented recovery mechanism for a transient
   * failure, and it is what the page-hide path relies on.
   *
   * Resolves; never rejects. A storage error is reported through `onError` and
   * the `blocked` status, not thrown at a page-hide handler.
   */
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

  private armTimer(delayMs: number): void {
    this.clearTimer();
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ensureLoop();
    }, delayMs);
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
        while (this.pending !== undefined && !this.disposed && this.conflict === undefined) {
          const state = this.pending;
          this.pending = undefined;
          const expectedRevision = this.baseRevision;
          const save = createSave(
            state,
            this.configVersion,
            this.now(),
            expectedRevision + 1,
          );

          try {
            const outcome = await this.storage.write(save, expectedRevision);
            if (!outcome.ok) {
              // Someone else owns the store. This is terminal: retrying would
              // either fail identically or, worse, overwrite their village.
              this.pending ??= state;
              this.conflict = {
                storedRevision: outcome.reason === 'conflict' ? outcome.storedRevision : -1,
                reason: outcome.reason,
              };
              this.clearTimer();
              this.setStatus('conflict');
              this.onConflict?.(this.conflict);
              return;
            }

            this.baseRevision = outcome.revision;
            this.saved = save;
            this.consecutiveFailures = 0;
            // `saved` is only ever set from a committed transaction. A newer
            // snapshot queued during the await keeps the loop going, so the
            // status stays `saving` rather than claiming the newest state is
            // durable when only an older one is.
            if (this.pending === undefined) this.setStatus('saved');
          } catch (error) {
            // Preserve the newest unsaved snapshot — `pending` already holds a
            // later one if `schedule()` ran during the await.
            this.pending ??= state;
            this.consecutiveFailures += 1;
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
