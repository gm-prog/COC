import {
  applyCommand,
  type CommandError,
  type GameCommand,
  type GameConfig,
  type GameEvent,
  type PlayerState,
} from '@coc/sim-core';
import type { SaveProblem } from './persistence/villageSave';

/**
 * The one place the scene is allowed to change the village.
 *
 * Every state-changing interaction (placement, collection, upgrades) goes
 * through here so a single guard can make a session read-only. That guard is
 * not cosmetic: when the device clock is behind the saved village, `autosave`
 * is `null`, so a command would mutate memory that could never be written back.
 * The player would "progress" and lose it on the next reload. Refusing the
 * command outright is the only honest option.
 *
 * `applyCommand` is still the rules engine — this module decides *whether* a
 * command may run, never what it does.
 */

export type VillageActionFailure =
  /** The session is read-only; the command never reached the simulation. */
  | { ok: false; reason: 'read_only' }
  /** The simulation evaluated the command and refused it. */
  | { ok: false; reason: 'rejected'; error: CommandError };

export type VillageActionResult =
  { ok: true; state: PlayerState; events: GameEvent[] } | VillageActionFailure;

export interface VillageActionContext {
  config: GameConfig;
  /**
   * The instant the action runs at.
   *
   * The scene clamps this to `lastSyncAt` so the simulation never sees time move
   * backwards. That clamp is only safe while the session may write: without the
   * read-only guard it would let commands succeed at a timestamp the device
   * clock has not reached. See `runVillageAction`.
   */
  now: number;
  /** True when the session must not mutate the village. */
  readOnly: boolean;
}

/**
 * A session is read-only exactly when saving is off because the device clock is
 * behind the save.
 *
 * Other disabled-saving outcomes are *not* read-only: a malformed or unavailable
 * record falls back to a fresh in-memory village, where playing on is the right
 * behaviour (there is nothing to protect). `clock_behind` is different — a real
 * record exists and the village on screen is that record.
 */
export function isReadOnlyVillage(problem: SaveProblem | null): boolean {
  return problem?.code === 'clock_behind';
}

/**
 * Runs a state-changing command, unless the session is read-only.
 *
 * Returns the new state instead of mutating: the caller decides whether to
 * adopt it, exactly as it did with `applyCommand`. A refused command returns the
 * *original* state untouched, so a caller that forgets to check `ok` still
 * cannot corrupt the village.
 */
export function runVillageAction(
  state: PlayerState,
  command: GameCommand,
  context: VillageActionContext,
): VillageActionResult {
  if (context.readOnly) return { ok: false, reason: 'read_only' };

  const result = applyCommand(state, command, { config: context.config, now: context.now });
  if (!result.ok) return { ok: false, reason: 'rejected', error: result.error };

  return { ok: true, state: result.state, events: result.events };
}
