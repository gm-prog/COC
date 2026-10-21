import type { CommandErrorCode, GameConfig, PlayerState } from '@coc/sim-core';
import { t, type TranslationKey, type TranslationParams } from './i18n';
import { runVillageAction } from './villageActions';

/**
 * Drag-to-place walls (spec §7.4: "Wall — 1×1 — blocks ground movement; drag to
 * place lines"; Gate C item 7).
 *
 * The client adds **no** wall rules. A wall segment is an ordinary
 * `PlaceBuilding` of the configured `wall` type, so it pays the level-1 cost,
 * occupies a builder until the build time elapses, counts against the Keep's
 * wall ceiling and obeys bounds, margin, occupancy and the Keep unlock — all of
 * it decided by `sim-core`. This module only turns a dragged trail of tiles
 * into an ordered, duplicate-free, orthogonally connected list and asks the
 * command what it would accept, in order, against a rolling draft.
 *
 * Two consequences of that rule are visible here and are deliberate:
 *
 * - a stroke stops at the **first** rejected tile, so the result is a prefix,
 *   never a set of disconnected walls beyond an obstacle; and
 * - with two builders and a five-second wall, one burst can accept at most two
 *   segments. That is D27's construction rule, not a UI limitation invented
 *   here.
 *
 * Everything below is pure — no DOM, no Phaser, no clock — so the interaction
 * is testable without a browser. The input state is never mutated: `applyCommand`
 * clones, and the rolling draft is always a returned value.
 */

export interface WallTile {
  x: number;
  y: number;
}

export type WallStrokeRejection = {
  /** The first tile the command refused. Everything after it is unassessed. */
  tile: WallTile;
  errorCode: CommandErrorCode;
};

export type WallStrokePlan =
  /** Saving is off, so the command must not reach the simulation. */
  | { kind: 'refused'; reason: 'read_only' }
  | {
      kind: 'planned';
      buildingType: string;
      /** Accepted tiles, in path order. Each one became a real construction. */
      accepted: WallTile[];
      /** Where the stroke stopped, or `null` when the whole path was accepted. */
      rejected: WallStrokeRejection | null;
      /** Rolling draft after the accepted segments (the input state when none). */
      state: PlayerState;
      /** True exactly when at least one segment was accepted. */
      changed: boolean;
    };

const keyOf = (tile: WallTile): string => `${tile.x},${tile.y}`;

/**
 * Appends `target` to a stroke, interpolating every tile a pointer jumped over.
 *
 * Sampling rules, all deterministic:
 *
 * - the trail is built from **unit steps**, so consecutive tiles are always
 *   orthogonal neighbours in the square logic grid;
 * - a diagonal delta therefore inserts connecting cells, stepping along **x
 *   first, then y** (documented tie-break, unit-tested);
 * - a tile already in the trail is never appended again, so dwelling on or
 *   re-crossing a cell can neither place it twice nor charge for it twice;
 * - the result is a new array; the input trail is not modified.
 */
export function extendWallPath(path: readonly WallTile[], target: WallTile): WallTile[] {
  const next = path.map((tile) => ({ x: tile.x, y: tile.y }));
  const seen = new Set(next.map(keyOf));

  const last = next.at(-1);
  if (last === undefined) {
    if (!seen.has(keyOf(target))) next.push({ x: target.x, y: target.y });
    return next;
  }

  const push = (x: number, y: number): void => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    next.push({ x, y });
  };

  let x = last.x;
  let y = last.y;
  while (x !== target.x) {
    x += Math.sign(target.x - x);
    push(x, y);
  }
  while (y !== target.y) {
    y += Math.sign(target.y - y);
    push(x, y);
  }

  return next;
}

/**
 * Plans — or re-plans — a stroke against the authoritative command.
 *
 * The same function serves the live preview and the release: the preview throws
 * the returned state away, the commit adopts it. Because the commit re-runs this
 * against the *current* player state and the current `now`, a preview computed a
 * second earlier cannot authorise a segment the rules would now refuse (a
 * builder may have finished, resources may have moved).
 *
 * Candidates are evaluated in path order; the first refusal ends the plan. Every
 * accepted segment becomes the input of the next one, so a second wall sees the
 * first wall's tile, cost and builder.
 */
export function planWallStroke(args: {
  state: PlayerState;
  config: GameConfig;
  buildingType: string;
  path: readonly WallTile[];
  now: number;
  readOnly: boolean;
}): WallStrokePlan {
  if (args.readOnly) return { kind: 'refused', reason: 'read_only' };

  let draft = args.state;
  const accepted: WallTile[] = [];
  let rejected: WallStrokeRejection | null = null;

  for (let index = 0; index < args.path.length; index += 1) {
    const tile = args.path[index]!;
    const result = runVillageAction(
      draft,
      {
        // Unique per candidate: a stroke must never reuse an envelope id.
        id: `wall-${args.now}-${index}-${tile.x}-${tile.y}`,
        type: 'PlaceBuilding',
        payload: { buildingType: args.buildingType, x: tile.x, y: tile.y },
      },
      { config: args.config, now: args.now, readOnly: args.readOnly },
    );

    if (!result.ok) {
      if (result.reason === 'read_only') return { kind: 'refused', reason: 'read_only' };
      rejected = { tile, errorCode: result.error.code };
      break;
    }

    draft = result.state;
    accepted.push({ x: tile.x, y: tile.y });
  }

  return {
    kind: 'planned',
    buildingType: args.buildingType,
    accepted,
    rejected,
    state: draft,
    changed: accepted.length > 0,
  };
}

/**
 * Why a stroke stopped, in the player's language.
 *
 * Keyed by the command's own error code, never by a tile guess: the command is
 * the authority on why it refused. The fallback exists so an error code added
 * later still produces a sentence instead of a raw identifier.
 */
export function wallStrokeReasonKey(code: CommandErrorCode): TranslationKey {
  switch (code) {
    case 'overlapping':
      return 'wall.reason.blocked';
    case 'margin':
      return 'wall.reason.margin';
    case 'out_of_bounds':
      return 'wall.reason.bounds';
    case 'no_builder':
      return 'wall.reason.builders';
    case 'insufficient_resources':
      return 'wall.reason.resources';
    case 'building_limit_reached':
      return 'wall.reason.limit';
    case 'keep_level_too_low':
      return 'wall.reason.keep';
    default:
      return 'wall.reason.other';
  }
}

/**
 * The sentence shown after a released stroke.
 *
 * It never claims the whole stroke was placed: the count is the number of
 * segments the command actually accepted, and the reason is only attached when
 * the stroke really stopped early.
 */
export function wallStrokeFeedback(
  plan: WallStrokePlan,
): { key: TranslationKey; params: TranslationParams } | null {
  // A refusal has no wall-stroke message: the scene shows the session's own
  // read-only hint, which explains that *nothing* can be built.
  if (plan.kind === 'refused') return null;

  const reason = plan.rejected === null ? null : t(wallStrokeReasonKey(plan.rejected.errorCode));
  const count = plan.accepted.length;

  if (count === 0) {
    // An empty trail says nothing; the scene never reaches here with one.
    return reason === null ? null : { key: 'wall.failed', params: { reason } };
  }
  if (count === 1) {
    return reason === null
      ? { key: 'wall.placedOne', params: {} }
      : { key: 'wall.partialOne', params: { reason } };
  }
  return reason === null
    ? { key: 'wall.placed', params: { count } }
    : { key: 'wall.partial', params: { count, reason } };
}
