/**
 * The command pipeline.
 *
 * Every mutation of player state goes through `applyCommand(state, command,
 * ctx)`, which is a pure function: it never touches a clock, never mutates its
 * input and returns either `{ ok: true, state, events }` or
 * `{ ok: false, error }`. The server is the only caller that matters; the client
 * runs the same code to predict, and the tests run it to prove the two agree.
 */

import type { BuildingDef, GameConfig, ResourceAmount, ResourceId } from '../config/types.js';
import { assertValidGeometry, GRID } from '../config/geometry.js';
import { isValidRect, OccupancyGrid, type Rect } from '../grid/index.js';
import {
  addResources,
  catchUp,
  levelDef,
  remainingCapacity,
  storageCapacity,
} from '../economy/index.js';
import {
  canBuyBuilder,
  checkUpgrade,
  nextBuilderCost,
  refundFor,
  speedUpCost,
  upgradeDurationMs,
} from '../build/index.js';
import {
  clonePlayerState,
  countBuildings,
  highestEntityId,
  type BuildingInstance,
  type PlayerState,
} from '../state/index.js';

export type CommandErrorCode =
  | 'invalid_command'
  | 'invalid_config'
  | 'invalid_state'
  | 'time_moved_backwards'
  | 'unknown_building'
  | 'unknown_obstacle'
  | 'not_found'
  | 'out_of_bounds'
  | 'margin'
  | 'invalid_rect'
  | 'overlapping'
  | 'keep_level_too_low'
  | 'no_change'
  | 'already_upgrading'
  | 'not_upgrading'
  | 'max_level'
  | 'max_builders'
  | 'no_builder'
  | 'not_a_collector'
  | 'building_limit_reached'
  | 'insufficient_resources';

export interface CommandError {
  code: CommandErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface CommandContext {
  /** Validated balance data. Never trust a raw object here. */
  config: GameConfig;
  /** Server time in epoch milliseconds. */
  now: number;
}

export interface PlaceBuildingPayload {
  buildingType: string;
  x: number;
  y: number;
}

export interface MoveBuildingPayload {
  buildingId: number;
  x: number;
  y: number;
}

export interface RemoveObstaclePayload {
  obstacleId: number;
}

export interface StartUpgradePayload {
  buildingId: number;
}

export interface CancelUpgradePayload {
  buildingId: number;
}

export interface SpeedUpPayload {
  buildingId: number;
}

export interface BuyBuilderPayload {
  /** Present for symmetry with other commands; nothing to configure. */
  _?: never;
}

export interface CollectResourcePayload {
  buildingId: number;
}

export type GameCommand =
  | { id: string; type: 'PlaceBuilding'; payload: PlaceBuildingPayload; clientSeq?: number }
  | { id: string; type: 'MoveBuilding'; payload: MoveBuildingPayload; clientSeq?: number }
  | { id: string; type: 'RemoveObstacle'; payload: RemoveObstaclePayload; clientSeq?: number }
  | { id: string; type: 'StartUpgrade'; payload: StartUpgradePayload; clientSeq?: number }
  | { id: string; type: 'CancelUpgrade'; payload: CancelUpgradePayload; clientSeq?: number }
  | { id: string; type: 'SpeedUp'; payload: SpeedUpPayload; clientSeq?: number }
  | { id: string; type: 'BuyBuilder'; payload: BuyBuilderPayload; clientSeq?: number }
  | { id: string; type: 'CollectResource'; payload: CollectResourcePayload; clientSeq?: number };

export type GameEvent =
  | {
      type: 'BuildingPlaced';
      buildingId: number;
      buildingType: string;
      level: number;
      x: number;
      y: number;
    }
  | {
      type: 'BuildingMoved';
      buildingId: number;
      buildingType: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
    }
  | {
      type: 'ObstacleRemoved';
      obstacleId: number;
      obstacleType: string;
      /** The configured reward. */
      reward: ResourceAmount;
      /** What actually fit into storage; the rest is lost (spec §7.2). */
      credited: ResourceAmount;
      overflow: ResourceAmount;
    }
  | {
      type: 'BuildingRemoved';
      buildingId: number;
      buildingType: string;
      level: number;
    }
  | {
      type: 'UpgradeStarted';
      buildingId: number;
      buildingType: string;
      fromLevel: number;
      toLevel: number;
      finishAt: number;
      cost: ResourceAmount;
    }
  | {
      type: 'UpgradeFinished';
      buildingId: number;
      buildingType: string;
      fromLevel: number;
      toLevel: number;
    }
  | {
      type: 'UpgradeCancelled';
      buildingId: number;
      buildingType: string;
      fromLevel: number;
      toLevel: number;
      refund: ResourceAmount;
    }
  | {
      type: 'SpeedUpUsed';
      buildingId: number;
      gemsSpent: number;
      remainingMs: number;
    }
  | { type: 'BuilderBought'; gemsSpent: number; builderCount: number }
  | {
      type: 'ResourceCollected';
      buildingId: number;
      buildingType: string;
      resource: ResourceId;
      accepted: number;
      overflow: number;
      bufferRemaining: number;
    }
  | { type: 'TrainingCompleted'; barracksId: number; troopId: string; count: number }
  | { type: 'ResourcesChanged'; changes: ResourceAmount; reason: string };

export type CommandResult =
  { ok: true; state: PlayerState; events: GameEvent[] } | { ok: false; error: CommandError };

const ok = (state: PlayerState, events: GameEvent[]): CommandResult => ({
  ok: true,
  state,
  events,
});
const fail = (error: CommandError): CommandResult => ({ ok: false, error });

function invalid(message: string, details?: Record<string, unknown>): CommandResult {
  return fail({ code: 'invalid_command', message, details });
}

/**
 * TypeScript types do not validate runtime data. A command payload arrives over
 * the wire (or from a tampered client), so every coordinate is checked here
 * rather than trusted: `NaN`, `±Infinity`, `undefined`, strings and fractions
 * are all rejected before any grid arithmetic runs.
 */
function requireTileCoordinate(value: unknown, field: string): CommandResult | number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return invalid(
      `payload.${field} must be an integer tile coordinate, received ${describe(value)}`,
      { field, received: typeof value },
    );
  }
  return value;
}

/** Building ids are positive integers; anything else is a malformed payload. */
function requireBuildingId(value: unknown): CommandResult | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return invalid(`payload.buildingId must be a positive integer, received ${describe(value)}`);
  }
  return null;
}

/** Renders a runtime value for an error message without trusting its type. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (value === undefined) return 'undefined';
  return typeof value;
}

function requireObject(value: unknown, label: string): CommandResult | null {
  if (value === null || typeof value !== 'object') return invalid(`${label} must be an object`);
  return null;
}

/**
 * Applies one command. Pure: the input state is never modified.
 *
 * Catch-up runs **once, here**, before dispatch — never inside an individual
 * command. That is what makes a command submitted after a timer expires observe
 * the completed state, and it means the "run catch-up first" rule cannot be
 * forgotten when a new command is added. Any events catch-up produced are
 * returned ahead of the command's own events, in that order.
 */
export function applyCommand(
  state: PlayerState,
  command: GameCommand,
  ctx: CommandContext,
): CommandResult {
  if (command === null || typeof command !== 'object') {
    return invalid('command must be an object');
  }
  if (typeof command.id !== 'string' || command.id.length === 0) {
    return invalid('command.id must be a non-empty string');
  }
  if (typeof ctx?.now !== 'number' || !Number.isFinite(ctx.now)) {
    return invalid('ctx.now must be a finite number (server time)');
  }
  if (!Number.isInteger(ctx.now)) {
    return invalid(`ctx.now must be an integer epoch-millisecond timestamp, received ${ctx.now}`);
  }

  const caught = catchUp(state, ctx.now, ctx.config);
  if (!caught.ok) {
    return fail({
      code: 'time_moved_backwards',
      message: caught.error.message,
      details: caught.error.details,
    });
  }

  const caughtUp: CommandContext = { config: ctx.config, now: ctx.now };
  const result = dispatch(caught.state, command, caughtUp);
  if (!result.ok) return result;

  return { ok: true, state: result.state, events: [...caught.events, ...result.events] };
}

function dispatch(state: PlayerState, command: GameCommand, ctx: CommandContext): CommandResult {
  switch (command.type) {
    case 'PlaceBuilding':
      return placeBuilding(state, command.payload, ctx);
    case 'MoveBuilding':
      return moveBuilding(state, command.payload, ctx);
    case 'RemoveObstacle':
      return removeObstacle(state, command.payload, ctx);
    case 'StartUpgrade':
      return startUpgrade(state, command.payload, ctx);
    case 'CancelUpgrade':
      return cancelUpgrade(state, command.payload, ctx);
    case 'SpeedUp':
      return speedUp(state, command.payload, ctx);
    case 'BuyBuilder':
      return buyBuilder(state, command.payload, ctx);
    case 'CollectResource':
      return collectResource(state, command.payload, ctx);
    default:
      return invalid(`unknown command type "${(command as { type: string }).type}"`);
  }
}

// -------------------------------------------------------------- PlaceBuilding

function placeBuilding(
  state: PlayerState,
  payload: PlaceBuildingPayload,
  ctx: CommandContext,
): CommandResult {
  const badPayload = requireObject(payload, 'payload');
  if (badPayload) return badPayload;
  if (typeof payload.buildingType !== 'string' || payload.buildingType.length === 0) {
    return invalid(
      `payload.buildingType must be a non-empty string, received ${describe(payload.buildingType)}`,
    );
  }

  const x = requireTileCoordinate(payload.x, 'x');
  if (typeof x !== 'number') return x;
  const y = requireTileCoordinate(payload.y, 'y');
  if (typeof y !== 'number') return y;

  const def = ctx.config.buildings.find((candidate) => candidate.id === payload.buildingType);
  if (!def) {
    return fail({
      code: 'unknown_building',
      message: `unknown building type "${payload.buildingType}"`,
      details: { buildingType: payload.buildingType },
    });
  }

  const rect = footprint(def, x, y);
  const conflict = checkPlacement(state, def, rect, ctx);
  if (conflict) return conflict;

  // Quantity ceilings (spec §7.3). `state.keepLevel` is the level of the
  // *completed* Keep, so a Keep upgrade in flight does not raise any cap early.
  // Level-0 constructions count towards the ceiling, otherwise two builders
  // could each reserve a place past it.
  const limit = buildingLimit(ctx.config, def.id, state.keepLevel);
  if (limit !== undefined) {
    const existing = countBuildings(state, def.id);
    if (existing + 1 > limit) {
      return fail({
        code: 'building_limit_reached',
        message: `Keep ${state.keepLevel} allows at most ${limit} of "${def.id}" (you already have ${existing})`,
        details: {
          buildingType: def.id,
          limit,
          count: existing,
          keepLevel: state.keepLevel,
        },
      });
    }
  }

  // Construction is not a free layout edit: spec 7.5 says "each
  // upgrade/construction occupies one builder until finished", and the level-1
  // row of the table is the price and the duration. The building is recorded at
  // level 0 with an upgrade targeting level 1, so it contributes no hit points,
  // no storage and no production until the builder finishes it.
  const levelOne = def.levels.find((entry) => entry.level === 1);
  if (levelOne === undefined) {
    return fail({
      code: 'unknown_building',
      message: `building "${def.id}" has no level 1 to construct`,
      details: { buildingType: def.id },
    });
  }
  if (state.builders.busy.length >= state.builders.count) {
    return fail({
      code: 'no_builder',
      message: `all ${state.builders.count} builders are busy`,
      details: { builders: state.builders.count },
    });
  }
  const missing: ResourceAmount = {};
  for (const [resource, amount] of Object.entries(levelOne.cost)) {
    if (amount === undefined || amount === 0) continue;
    const have = state.resources[resource as ResourceId] ?? 0;
    if (have < amount) {
      missing[resource as ResourceId] = amount - have;
    }
  }
  if (Object.keys(missing).length > 0) {
    return fail({
      code: 'insufficient_resources',
      message: `constructing "${def.id}" needs ${JSON.stringify(levelOne.cost)}`,
      details: { missing },
    });
  }

  const finishAt = ctx.now + levelOne.buildSeconds * 1000;

  const next = clonePlayerState(state);
  const building: BuildingInstance = {
    id: highestEntityId(next) + 1,
    type: def.id,
    level: 0,
    x,
    y,
    upgrade: { toLevel: 1, finishAt },
  };
  next.buildings.push(building);
  next.builders.busy.push({ buildingId: building.id, toLevel: 1, finishAt });
  const spent = addResources(next.resources, negate(levelOne.cost));
  // `keepLevel` is not raised here: a Keep at level 0 has not granted anything
  // yet. `catchUp` raises it when the builder finishes (see `finishUpgradesAt`).
  next.lastSyncAt = ctx.now;

  return ok(next, [
    { type: 'ResourcesChanged', changes: spent, reason: 'construction_started' },
    {
      type: 'BuildingPlaced',
      buildingId: building.id,
      buildingType: building.type,
      level: building.level,
      x: building.x,
      y: building.y,
    },
    {
      type: 'UpgradeStarted',
      buildingId: building.id,
      buildingType: building.type,
      fromLevel: 0,
      toLevel: 1,
      finishAt,
      cost: levelOne.cost,
    },
  ]);
}

// -------------------------------------------------------------- MoveBuilding

function moveBuilding(
  state: PlayerState,
  payload: MoveBuildingPayload,
  ctx: CommandContext,
): CommandResult {
  const badPayload = requireObject(payload, 'payload');
  if (badPayload) return badPayload;
  const badId = requireBuildingId(payload.buildingId);
  if (badId) return badId;

  const x = requireTileCoordinate(payload.x, 'x');
  if (typeof x !== 'number') return x;
  const y = requireTileCoordinate(payload.y, 'y');
  if (typeof y !== 'number') return y;

  const building = state.buildings.find((candidate) => candidate.id === payload.buildingId);
  if (!building) {
    return fail({
      code: 'not_found',
      message: `no building with id ${payload.buildingId}`,
      details: { buildingId: payload.buildingId },
    });
  }

  const def = ctx.config.buildings.find((candidate) => candidate.id === building.type);
  if (!def) {
    return fail({
      code: 'unknown_building',
      message: `building ${building.id} has unknown type "${building.type}"`,
    });
  }

  const target = footprint(def, x, y);

  // Free the building's own footprint first so a building can be "moved" onto
  // its current position (a legal no-op) without tripping the overlap check.
  // buildGrid has already proved every entity's rectangle is well-formed, so
  // the building's own footprint is safe to clear without re-checking.
  const grid = buildGrid(state, ctx.config);
  if ('code' in grid) return fail(grid);
  grid.clear({ x: building.x, y: building.y, w: def.size.w, h: def.size.h }, building.id);

  const conflict = checkPlacement(state, def, target, ctx, grid);
  if (conflict) return conflict;

  const from = { x: building.x, y: building.y };
  const next = clonePlayerState(state);
  const moved = next.buildings.find((candidate) => candidate.id === building.id);
  if (!moved) {
    return fail({ code: 'not_found', message: `no building with id ${payload.buildingId}` });
  }
  moved.x = x;
  moved.y = y;
  next.lastSyncAt = ctx.now;

  return ok(next, [
    {
      type: 'BuildingMoved',
      buildingId: moved.id,
      buildingType: moved.type,
      from,
      to: { x: moved.x, y: moved.y },
    },
  ]);
}

// ------------------------------------------------------------ RemoveObstacle

function removeObstacle(
  state: PlayerState,
  payload: RemoveObstaclePayload,
  ctx: CommandContext,
): CommandResult {
  const badPayload = requireObject(payload, 'payload');
  if (badPayload) return badPayload;
  if (typeof payload.obstacleId !== 'number' || !Number.isInteger(payload.obstacleId)) {
    return invalid(
      `payload.obstacleId must be an integer, received ${describe(payload.obstacleId)}`,
    );
  }

  const obstacle = state.obstacles.find((candidate) => candidate.id === payload.obstacleId);
  if (!obstacle) {
    return fail({
      code: 'not_found',
      message: `no obstacle with id ${payload.obstacleId}`,
      details: { obstacleId: payload.obstacleId },
    });
  }

  const def = ctx.config.obstacles.find((candidate) => candidate.id === obstacle.type);
  if (!def) {
    return fail({
      code: 'unknown_obstacle',
      message: `obstacle ${obstacle.id} has unknown type "${obstacle.type}"`,
    });
  }

  const next = clonePlayerState(state);
  next.obstacles = next.obstacles.filter((candidate) => candidate.id !== obstacle.id);

  // Spec §7.2: storage caps how much of a resource the player can hold and
  // "overflow is lost". The reward obeys the same rule as collection — what
  // does not fit is discarded, never banked. Gems have no storage capacity
  // (they are not held in buildings), so they are not capped.
  const capacity = storageCapacity(next, ctx.config);
  const changes: ResourceAmount = {};
  const overflow: ResourceAmount = {};
  for (const [resource, amount] of Object.entries(def.reward)) {
    if (amount === undefined || amount === 0) continue;
    const id = resource as ResourceId;
    const cap = capacity[id];
    const room = cap === undefined ? amount : Math.max(0, cap - (next.resources[id] ?? 0));
    const credited = Math.min(amount, room);
    if (credited > 0) {
      changes[id] = (changes[id] ?? 0) + credited;
      next.resources[id] = (next.resources[id] ?? 0) + credited;
    }
    if (credited < amount) overflow[id] = amount - credited;
  }
  next.lastSyncAt = ctx.now;

  const events: GameEvent[] = [
    {
      type: 'ObstacleRemoved',
      obstacleId: obstacle.id,
      obstacleType: obstacle.type,
      reward: def.reward,
      credited: changes,
      overflow,
    },
  ];
  if (Object.keys(changes).length > 0) {
    events.push({ type: 'ResourcesChanged', changes, reason: 'obstacle_cleared' });
  }

  return ok(next, events);
}

// -------------------------------------------------------------------- helpers

function footprint(def: BuildingDef, x: number, y: number): Rect {
  return { x, y, w: def.size.w, h: def.size.h };
}

/**
 * The quantity ceiling for `buildingType` at `keepLevel`, read from the
 * config's limit table. Returns undefined when the table has no row, which the
 * validator rejects up front; treating a missing row as unlimited here keeps
 * the command path total rather than throwing on malformed input.
 */
function buildingLimit(
  config: GameConfig,
  buildingType: string,
  keepLevel: number,
): number | undefined {
  const counts = config.limits.buildingCounts[buildingType];
  if (counts === undefined || counts.length === 0) return undefined;
  const index = Math.min(Math.max(keepLevel, 0), counts.length - 1);
  return counts[index];
}

/**
 * Rebuilds the occupancy map from a state snapshot.
 *
 * Every entity's definition and geometry is resolved from the *validated*
 * config. A missing definition or a malformed instance is a state/config
 * mismatch, which is reported as a typed error rather than silently shrunk to a
 * 1×1 footprint: a phantom size would let an unknown entity be treated as a
 * legal placement and would make the grid disagree with what is on screen.
 */
function buildGrid(state: PlayerState, config: GameConfig): OccupancyGrid | CommandError {
  assertValidGeometry(GRID);
  const entries: { id: number; x: number; y: number; w: number; h: number }[] = [];

  for (const building of state.buildings) {
    const def = config.buildings.find((candidate) => candidate.id === building.type);
    if (!def) {
      return {
        code: 'unknown_building',
        message: `building ${building.id} has unknown type "${building.type}"`,
        details: { buildingId: building.id, buildingType: building.type },
      };
    }
    const rect = { x: building.x, y: building.y, w: def.size.w, h: def.size.h };
    if (!isValidRect(rect)) {
      return {
        code: 'invalid_state',
        message: `building ${building.id} has a malformed position or footprint`,
        details: { buildingId: building.id, rect },
      };
    }
    entries.push({ id: building.id, ...rect });
  }

  for (const obstacle of state.obstacles) {
    const def = config.obstacles.find((candidate) => candidate.id === obstacle.type);
    if (!def) {
      return {
        code: 'unknown_obstacle',
        message: `obstacle ${obstacle.id} has unknown type "${obstacle.type}"`,
        details: { obstacleId: obstacle.id, obstacleType: obstacle.type },
      };
    }
    const rect = { x: obstacle.x, y: obstacle.y, w: def.size.w, h: def.size.h };
    if (!isValidRect(rect)) {
      return {
        code: 'invalid_state',
        message: `obstacle ${obstacle.id} has a malformed position or footprint`,
        details: { obstacleId: obstacle.id, rect },
      };
    }
    entries.push({ id: obstacle.id, ...rect });
  }

  return OccupancyGrid.fromEntries(GRID, entries);
}

/**
 * Shared placement rules: bounds, margin, occupancy and Keep unlock.
 *
 * `grid` may be supplied pre-adjusted (used by MoveBuilding, which frees the
 * building's own tiles first).
 */
function checkPlacement(
  state: PlayerState,
  def: BuildingDef,
  rect: Rect,
  ctx: CommandContext,
  grid?: OccupancyGrid,
): CommandResult | null {
  const built = grid ?? buildGrid(state, ctx.config);
  if ('code' in built) return fail(built);
  const occupancy = built;
  const conflict = occupancy.findConflict(rect);

  if (conflict?.reason === 'invalid_rect') {
    return fail({
      code: 'invalid_rect',
      message: `"${def.id}" needs a finite integer position and a positive integer footprint`,
      details: { rect },
    });
  }

  if (conflict?.reason === 'out_of_bounds') {
    return fail({
      code: 'out_of_bounds',
      message: `"${def.id}" at (${rect.x},${rect.y}) leaves the ${GRID.total}x${GRID.total} map`,
      details: { x: conflict.x, y: conflict.y },
    });
  }
  if (conflict?.reason === 'margin') {
    return fail({
      code: 'margin',
      message: `"${def.id}" at (${rect.x},${rect.y}) overlaps the ${GRID.margin}-tile decorative margin`,
      details: { x: conflict.x, y: conflict.y },
    });
  }
  if (conflict?.reason === 'occupied') {
    return fail({
      code: 'overlapping',
      message: `"${def.id}" at (${rect.x},${rect.y}) overlaps entity ${conflict.owner} at (${conflict.x},${conflict.y})`,
      details: { x: conflict.x, y: conflict.y, owner: conflict.owner },
    });
  }

  if (state.keepLevel < def.unlock.keepLevel) {
    return fail({
      code: 'keep_level_too_low',
      message: `"${def.id}" unlocks at Keep ${def.unlock.keepLevel} (you are Keep ${state.keepLevel})`,
      details: { requiredKeep: def.unlock.keepLevel, keepLevel: state.keepLevel },
    });
  }

  return null;
}

// ---------------------------------------------------------------- StartUpgrade

function startUpgrade(
  state: PlayerState,
  payload: StartUpgradePayload,
  ctx: CommandContext,
): CommandResult {
  const badPayload = requireObject(payload, 'payload');
  if (badPayload) return badPayload;
  const badId = requireBuildingId(payload.buildingId);
  if (badId) return badId;

  const check = checkUpgrade(state, payload.buildingId, ctx.config);
  if (!check.ok) {
    return fail({
      code: check.rejection,
      message: check.message,
      details: check.missing === undefined ? undefined : { missing: check.missing },
    });
  }

  const building = state.buildings.find((candidate) => candidate.id === payload.buildingId);
  if (building === undefined) {
    return fail({ code: 'not_found', message: `no building with id ${payload.buildingId}` });
  }

  const next = clonePlayerState(state);
  const target = next.buildings.find((candidate) => candidate.id === payload.buildingId);
  if (target === undefined) {
    return fail({ code: 'not_found', message: `no building with id ${payload.buildingId}` });
  }

  const fromLevel = target.level;
  const finishAt = ctx.now + upgradeDurationMs(ctx.config, target.type, check.target.level);

  // Spend first, then assign: a failure between the two would leave the state
  // inconsistent, and `next` is a clone, so the input is untouched either way.
  const spent = addResources(next.resources, negate(check.target.cost));
  target.upgrade = { toLevel: check.target.level, finishAt };
  next.builders.busy.push({ buildingId: target.id, toLevel: check.target.level, finishAt });
  next.lastSyncAt = ctx.now;

  return ok(next, [
    { type: 'ResourcesChanged', changes: spent, reason: 'upgrade_started' },
    {
      type: 'UpgradeStarted',
      buildingId: target.id,
      buildingType: target.type,
      fromLevel,
      toLevel: check.target.level,
      finishAt,
      cost: check.target.cost,
    },
  ]);
}

// -------------------------------------------------------------- CancelUpgrade

function cancelUpgrade(
  state: PlayerState,
  payload: CancelUpgradePayload,
  ctx: CommandContext,
): CommandResult {
  const badPayload = requireObject(payload, 'payload');
  if (badPayload) return badPayload;
  const badId = requireBuildingId(payload.buildingId);
  if (badId) return badId;

  const building = state.buildings.find((candidate) => candidate.id === payload.buildingId);
  if (!building) {
    return fail({
      code: 'not_found',
      message: `no building with id ${payload.buildingId}`,
      details: { buildingId: payload.buildingId },
    });
  }
  if (building.upgrade === undefined) {
    return fail({
      code: 'not_upgrading',
      message: `building ${building.id} is not upgrading`,
      details: { buildingId: building.id },
    });
  }

  // Spec 7.5: cancelling refunds nothing once a builder has started the work,
  // and the configured fraction for an item that was paid for but never began.
  // "A builder is assigned" is the Phase 2 signal for started — the builder
  // queue itself arrives with Phase 4 (recorded in DECISIONS.md).
  const started = state.builders.busy.some((job) => job.buildingId === building.id);
  const refund = refundFor(ctx.config, building.type, building.upgrade.toLevel, started);

  const next = clonePlayerState(state);
  const target = next.buildings.find((candidate) => candidate.id === payload.buildingId);
  if (target === undefined || target.upgrade === undefined) {
    return fail({ code: 'not_found', message: `no building with id ${payload.buildingId}` });
  }

  const fromLevel = target.level;
  const toLevel = target.upgrade.toLevel;
  target.upgrade = undefined;
  next.builders.busy = next.builders.busy.filter((job) => job.buildingId !== target.id);

  // A construction that never completed is not a building yet: it sits at
  // level 0 and exists only because a builder reserved the spot. Cancelling it
  // must remove it from the map (freeing its tiles) instead of leaving a
  // level-0 orphan behind. A real upgrade keeps its existing level.
  const abandoned = target.level === 0;
  if (abandoned) {
    next.buildings = next.buildings.filter((candidate) => candidate.id !== target.id);
  }

  const refunded = addResources(next.resources, refund);
  next.lastSyncAt = ctx.now;

  const events: GameEvent[] = [
    {
      type: 'UpgradeCancelled',
      buildingId: target.id,
      buildingType: target.type,
      fromLevel,
      toLevel,
      refund,
    },
  ];
  if (abandoned) {
    events.push({
      type: 'BuildingRemoved',
      buildingId: target.id,
      buildingType: target.type,
      level: fromLevel,
    });
  }
  if (Object.keys(refunded).length > 0) {
    events.push({ type: 'ResourcesChanged', changes: refunded, reason: 'upgrade_cancelled' });
  }
  return ok(next, events);
}

// -------------------------------------------------------------------- SpeedUp

function speedUp(state: PlayerState, payload: SpeedUpPayload, ctx: CommandContext): CommandResult {
  const badPayload = requireObject(payload, 'payload');
  if (badPayload) return badPayload;
  const badId = requireBuildingId(payload.buildingId);
  if (badId) return badId;

  const building = state.buildings.find((candidate) => candidate.id === payload.buildingId);
  if (!building) {
    return fail({
      code: 'not_found',
      message: `no building with id ${payload.buildingId}`,
      details: { buildingId: payload.buildingId },
    });
  }
  if (building.upgrade === undefined) {
    return fail({
      code: 'not_upgrading',
      message: `building ${building.id} is not upgrading`,
      details: { buildingId: building.id },
    });
  }

  const remainingMs = building.upgrade.finishAt - ctx.now;
  const gems = speedUpCost(remainingMs, ctx.config);
  if ((state.resources.gems ?? 0) < gems) {
    return fail({
      code: 'insufficient_resources',
      message: `skipping ${remainingMs} ms costs ${gems} gems, you have ${state.resources.gems ?? 0}`,
      details: { gems, available: state.resources.gems ?? 0 },
    });
  }

  const next = clonePlayerState(state);
  const target = next.buildings.find((candidate) => candidate.id === payload.buildingId);
  if (target === undefined || target.upgrade === undefined) {
    return fail({ code: 'not_found', message: `no building with id ${payload.buildingId}` });
  }

  const fromLevel = target.level;
  const toLevel = target.upgrade.toLevel;
  const spent = addResources(next.resources, { gems: -gems });
  target.level = toLevel;
  target.upgrade = undefined;
  next.builders.busy = next.builders.busy.filter((job) => job.buildingId !== target.id);
  if (target.type === 'keep') next.keepLevel = toLevel;
  next.lastSyncAt = ctx.now;

  return ok(next, [
    { type: 'ResourcesChanged', changes: spent, reason: 'speed_up' },
    { type: 'SpeedUpUsed', buildingId: target.id, gemsSpent: gems, remainingMs },
    {
      type: 'UpgradeFinished',
      buildingId: target.id,
      buildingType: target.type,
      fromLevel,
      toLevel,
    },
  ]);
}

// ----------------------------------------------------------------- BuyBuilder

function buyBuilder(
  state: PlayerState,
  _payload: BuyBuilderPayload,
  ctx: CommandContext,
): CommandResult {
  if (!canBuyBuilder(state, ctx.config)) {
    return fail({
      code: 'max_builders',
      message: `you already have the maximum of ${ctx.config.economy.builders.maxBuilders} builders`,
      details: { builders: state.builders.count, max: ctx.config.economy.builders.maxBuilders },
    });
  }

  const gems = nextBuilderCost(state, ctx.config);
  if (gems === undefined) {
    return fail({
      code: 'max_builders',
      message: `no price is configured for builder number ${state.builders.count + 1}`,
      details: { builders: state.builders.count },
    });
  }
  if ((state.resources.gems ?? 0) < gems) {
    return fail({
      code: 'insufficient_resources',
      message: `builder number ${state.builders.count + 1} costs ${gems} gems, you have ${state.resources.gems ?? 0}`,
      details: { gems, available: state.resources.gems ?? 0 },
    });
  }

  const next = clonePlayerState(state);
  const spent = addResources(next.resources, { gems: -gems });
  next.builders.count += 1;
  next.lastSyncAt = ctx.now;

  return ok(next, [
    { type: 'ResourcesChanged', changes: spent, reason: 'builder_bought' },
    { type: 'BuilderBought', gemsSpent: gems, builderCount: next.builders.count },
  ]);
}

// ------------------------------------------------------------- CollectResource

function collectResource(
  state: PlayerState,
  payload: CollectResourcePayload,
  ctx: CommandContext,
): CommandResult {
  const badPayload = requireObject(payload, 'payload');
  if (badPayload) return badPayload;
  const badId = requireBuildingId(payload.buildingId);
  if (badId) return badId;

  const building = state.buildings.find((candidate) => candidate.id === payload.buildingId);
  if (!building) {
    return fail({
      code: 'not_found',
      message: `no building with id ${payload.buildingId}`,
      details: { buildingId: payload.buildingId },
    });
  }

  const level = levelDef(ctx.config, building);
  const buffered = building.buffer?.amount ?? 0;
  if (
    level === undefined ||
    level.produces === undefined ||
    level.productionPerHour === undefined
  ) {
    return fail({
      code: 'not_a_collector',
      message: `"${building.type}" does not produce a resource`,
      details: { buildingType: building.type },
    });
  }

  const resource = level.produces;
  const room = remainingCapacity(state, ctx.config, resource);
  const accepted = Math.min(buffered, room);
  const overflow = buffered - accepted;

  const next = clonePlayerState(state);
  const target = next.buildings.find((candidate) => candidate.id === payload.buildingId);
  if (target === undefined) {
    return fail({ code: 'not_found', message: `no building with id ${payload.buildingId}` });
  }

  const changes: ResourceAmount = {};
  if (accepted > 0) {
    next.resources[resource] = (next.resources[resource] ?? 0) + accepted;
    changes[resource] = accepted;
  }
  // Spec §7.2: overflow is lost. Whatever did not fit is removed from the
  // collector along with what was credited — leaving it buffered would let the
  // player recover it later, which is exactly the banking the rule forbids.
  // The fractional carry is untouched: it is production that has not been
  // produced yet, not buffered whole units.
  if (target.buffer !== undefined) target.buffer.amount = 0;
  next.lastSyncAt = ctx.now;

  // Nothing was buffered, so nothing happened: no event at all. This is what
  // makes a repeated collection at the same millisecond a true no-op rather
  // than a stream of empty events.
  const events: GameEvent[] = [];
  if (buffered > 0) {
    events.push({
      type: 'ResourceCollected',
      buildingId: target.id,
      buildingType: target.type,
      resource,
      accepted,
      overflow,
      bufferRemaining: target.buffer?.amount ?? 0,
    });
    if (accepted > 0) {
      events.push({ type: 'ResourcesChanged', changes, reason: 'collected' });
    }
  }
  return ok(next, events);
}

// -------------------------------------------------------------------- helpers

/** A cost expressed as a negative delta, so `addResources` can spend it. */
function negate(amount: ResourceAmount): ResourceAmount {
  const out: ResourceAmount = {};
  for (const [resource, value] of Object.entries(amount)) {
    if (value === undefined || value === 0) continue;
    out[resource as ResourceId] = -value;
  }
  return out;
}

/** Total holding capacity, re-exported so callers need only the commands module. */
export { storageCapacity };
