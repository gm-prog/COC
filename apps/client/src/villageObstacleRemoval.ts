import type {
  CommandErrorCode,
  GameConfig,
  GameEvent,
  PlayerState,
  ResourceAmount,
  ResourceId,
} from '@coc/sim-core';
import { t, type TranslationKey, type TranslationParams } from './i18n';
import { runVillageAction } from './villageActions';

/**
 * Obstacle removal: the client half of the existing `RemoveObstacle` command.
 *
 * The command already decides everything that matters — which obstacle exists,
 * what it grants, how much of that reward fits into storage and what is lost to
 * the cap (spec §7.2). None of that is re-derived here. This module only:
 *
 * - runs the command through `runVillageAction`, so the read-only gate applies;
 * - hands back the *authoritative* `ObstacleRemoved` event so the UI can report
 *   `credited` and `overflow` instead of the configured reward; and
 * - turns that event into a translated message.
 *
 * It is pure — no DOM, no Phaser, no clock — so the interaction is testable
 * without a browser. It never mutates the state it is given.
 */

/** The command's own result event, which is the source of all removal feedback. */
export type ObstacleRemovalEvent = Extract<GameEvent, { type: 'ObstacleRemoved' }>;

export type ObstacleRemovalAttempt =
  /** Saving is off, so the command must not reach the simulation. */
  | { kind: 'refused'; reason: 'read_only' }
  /** The simulation evaluated the command and refused it. */
  | { kind: 'rejected'; errorCode: CommandErrorCode }
  | {
      kind: 'removed';
      state: PlayerState;
      events: GameEvent[];
      /**
       * The `ObstacleRemoved` event. Required in practice, nullable so a
       * contract violation degrades to a neutral message instead of a crash.
       */
      removed: ObstacleRemovalEvent | null;
    };

/**
 * Runs `RemoveObstacle` for one obstacle instance and reports what happened.
 *
 * The obstacle id is an *instance* id: a village holds several trees and rocks,
 * so the type is never an identifier. A stale id is refused by the command with
 * `not_found`, which leaves both the caller's state and the village untouched.
 */
export function resolveObstacleRemoval(args: {
  state: PlayerState;
  config: GameConfig;
  obstacleId: number;
  now: number;
  readOnly: boolean;
}): ObstacleRemovalAttempt {
  const { state, config, obstacleId, now, readOnly } = args;

  if (readOnly) return { kind: 'refused', reason: 'read_only' };

  const result = runVillageAction(
    state,
    {
      id: `remove-obstacle-${now}-${obstacleId}`,
      type: 'RemoveObstacle',
      payload: { obstacleId },
    },
    { config, now, readOnly },
  );

  if (!result.ok) {
    return result.reason === 'read_only'
      ? { kind: 'refused', reason: 'read_only' }
      : { kind: 'rejected', errorCode: result.error.code };
  }

  const removed = result.events.find(
    (event): event is ObstacleRemovalEvent => event.type === 'ObstacleRemoved',
  );

  return { kind: 'removed', state: result.state, events: result.events, removed: removed ?? null };
}

/**
 * Formats a resource amount the way the rest of the HUD does: `1 Gems · 30 Gold`.
 *
 * The names come from the i18n dictionary, so a new resource or a new language
 * needs no change here. Empty amounts format as an empty string.
 */
export function formatResourceAmount(amount: ResourceAmount): string {
  return Object.entries(amount)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .map((entry) => entry[1] + ' ' + t(('resource.' + entry[0]) as TranslationKey))
    .join(' · ');
}

/**
 * True when any resource the obstacle grants is held under a storage cap.
 *
 * Gold and Essence are capped by the Keep's `storageCap`; Gems and Shards are
 * not. Read from `storageCapacity()` rather than a hard-coded list, so the
 * preview's "overflow is lost" warning appears only when it can actually
 * happen — and follows the config if capacities change.
 */
export function hasCappedReward(
  reward: ResourceAmount,
  capacity: Partial<Record<ResourceId, number>>,
): boolean {
  return Object.entries(reward).some(
    ([resource, amount]) =>
      typeof amount === 'number' && amount > 0 && capacity[resource as ResourceId] !== undefined,
  );
}

/**
 * The message for a completed removal, built from the command's own numbers.
 *
 * Three cases, because the honest answer differs:
 * - nothing fit (`credited` empty): say what was lost, never claim a reward;
 * - everything fit (`overflow` empty): report the credited amount;
 * - part fit: report both, so the player knows why the balance moved less than
 *   the reward they were shown.
 */
export function obstacleRemovalFeedback(removed: ObstacleRemovalEvent): {
  key: TranslationKey;
  params: TranslationParams;
} {
  const obstacle = t(('obstacle.' + removed.obstacleType) as TranslationKey);
  const credited = formatResourceAmount(removed.credited);
  const lost = formatResourceAmount(removed.overflow);

  if (credited === '') {
    return lost === ''
      ? { key: 'obstacle.removedOnly', params: { obstacle } }
      : { key: 'obstacle.removedNothing', params: { obstacle, lost } };
  }
  if (lost === '') {
    return { key: 'obstacle.removed', params: { obstacle, credited } };
  }
  return { key: 'obstacle.removedPartial', params: { obstacle, credited, lost } };
}
