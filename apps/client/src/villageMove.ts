import {
  applyCommand,
  type CommandErrorCode,
  type GameConfig,
  type GameEvent,
  type PlayerState,
} from '@coc/sim-core';
import { runVillageAction } from './villageActions';
import type { VillageEntity } from './villageLayout';

/**
 * Move mode: the client half of the existing `MoveBuilding` command.
 *
 * `sim-core` already owns every placement rule, so nothing here re-implements
 * geometry, occupancy, margin or Keep gating. Both the preview and the commit
 * ask the command itself:
 *
 * - the preview *predicts* a move by running `applyCommand` on a snapshot and
 *   throwing the result away;
 * - the commit runs the *same* command through `runVillageAction`, so it is
 *   subject to the read-only gate, and only its returned state is ever adopted.
 *
 * Everything in this module is pure — no DOM, no Phaser, no clock — which is
 * what makes the interaction testable without a browser.
 */

export type BuildingMovePreview = { valid: true } | { valid: false; errorCode: CommandErrorCode };

/**
 * Predicts whether `MoveBuilding` would accept this destination.
 *
 * `applyCommand` never mutates its input and the resulting state is discarded,
 * so this cannot move anything, spend anything or dirty the save. It is a
 * prediction of a possible action, not the action.
 */
export function previewBuildingMove(
  state: PlayerState,
  config: GameConfig,
  buildingId: number,
  x: number,
  y: number,
  now: number,
): BuildingMovePreview {
  const result = applyCommand(
    state,
    {
      id: 'move-preview',
      type: 'MoveBuilding',
      payload: { buildingId, x, y },
    },
    { config, now },
  );

  return result.ok ? { valid: true } : { valid: false, errorCode: result.error.code };
}

/** The building being moved, captured when Move Mode is entered. */
export interface MoveSession {
  buildingId: number;
  buildingType: string;
  /** Where the building stands now; the no-op destination and the anchor. */
  fromX: number;
  fromY: number;
}

/**
 * What the player is currently doing on the map.
 *
 * Placement and moving are variants of one union rather than two independent
 * flags, so "placing while moving" is not representable. Assigning a variant
 * replaces the previous one, which is exactly the mutual exclusion the scene
 * needs, and no branch has to remember to clear a second field.
 */
export type VillageInteraction =
  | { kind: 'idle' }
  | { kind: 'placing'; buildingType: string }
  | { kind: 'moving'; session: MoveSession };

export const IDLE_INTERACTION: VillageInteraction = { kind: 'idle' };

export function placementInteraction(buildingType: string): VillageInteraction {
  return { kind: 'placing', buildingType };
}

export type BeginMoveResult =
  | { ok: true; interaction: Extract<VillageInteraction, { kind: 'moving' }> }
  /**
   * `no_selection`: nothing to move. `not_a_building`: obstacles are layout
   * entities but have no move command in the spec. `not_found`: the selection
   * is stale — its id is no longer in the state.
   */
  | { ok: false; reason: 'no_selection' | 'not_a_building' | 'not_found' };

/**
 * Validates a selection for Move Mode and captures its session.
 *
 * The session records the entity id, not just the type: a village can contain
 * several Gold Mines and the command addresses one of them.
 */
export function beginMoveInteraction(
  state: PlayerState,
  entity: VillageEntity | null,
): BeginMoveResult {
  if (entity === null) return { ok: false, reason: 'no_selection' };
  if (entity.kind !== 'building') return { ok: false, reason: 'not_a_building' };

  const building = state.buildings.find((candidate) => candidate.id === entity.instance.id);
  if (!building) return { ok: false, reason: 'not_found' };

  return {
    ok: true,
    interaction: {
      kind: 'moving',
      session: {
        buildingId: building.id,
        buildingType: building.type,
        fromX: building.x,
        fromY: building.y,
      },
    },
  };
}

/** Leaves placement and move mode. The next interaction starts from idle. */
export function cancelInteraction(): VillageInteraction {
  return IDLE_INTERACTION;
}

/**
 * True when the destination is the building's current anchor tile.
 *
 * The command would accept it as a legal no-op, but running it would emit an
 * event, bump `lastSyncAt` and trigger a save for a village that did not change.
 * The UI treats it as "the player is done moving" instead. This is a client
 * optimisation only: the simulation's contract is untouched.
 */
export function isNoopMoveTarget(session: MoveSession, x: number, y: number): boolean {
  return session.fromX === x && session.fromY === y;
}

export type MoveAttempt =
  /** The destination is where the building already stands; nothing to do. */
  | { kind: 'noop' }
  /** Saving is off, so the command must not reach the simulation. */
  | { kind: 'refused'; reason: 'read_only' }
  /** The simulation evaluated the command and refused it. */
  | { kind: 'rejected'; errorCode: CommandErrorCode }
  | { kind: 'moved'; state: PlayerState; events: GameEvent[] };

/**
 * Resolves a click in Move Mode.
 *
 * Returns the outcome instead of mutating: the caller adopts `moved.state` only
 * after checking `kind`, so a rejected destination cannot leave the village in
 * the predicted state. Nothing is written unless the caller sees `moved`.
 */
export function resolveMoveAttempt(args: {
  state: PlayerState;
  config: GameConfig;
  session: MoveSession;
  x: number;
  y: number;
  now: number;
  readOnly: boolean;
}): MoveAttempt {
  const { state, config, session, x, y, now, readOnly } = args;

  // Checked first: in a read-only session even a no-op must not look like an
  // accepted action, and the hint that explains why has to be reachable.
  if (readOnly) return { kind: 'refused', reason: 'read_only' };
  if (isNoopMoveTarget(session, x, y)) return { kind: 'noop' };

  const result = runVillageAction(
    state,
    {
      id: `move-${now}-${session.buildingId}-${x}-${y}`,
      type: 'MoveBuilding',
      payload: { buildingId: session.buildingId, x, y },
    },
    { config, now, readOnly },
  );

  if (!result.ok) {
    return result.reason === 'read_only'
      ? { kind: 'refused', reason: 'read_only' }
      : { kind: 'rejected', errorCode: result.error.code };
  }

  return { kind: 'moved', state: result.state, events: result.events };
}
