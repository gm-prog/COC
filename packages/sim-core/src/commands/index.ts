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
  clonePlayerState,
  highestEntityId,
  type BuildingInstance,
  type PlayerState,
} from '../state/index.js';

export type CommandErrorCode =
  | 'invalid_command'
  | 'invalid_config'
  | 'invalid_state'
  | 'unknown_building'
  | 'unknown_obstacle'
  | 'not_found'
  | 'out_of_bounds'
  | 'margin'
  | 'invalid_rect'
  | 'overlapping'
  | 'keep_level_too_low'
  | 'no_change';

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

export type GameCommand =
  | { id: string; type: 'PlaceBuilding'; payload: PlaceBuildingPayload; clientSeq?: number }
  | { id: string; type: 'MoveBuilding'; payload: MoveBuildingPayload; clientSeq?: number }
  | { id: string; type: 'RemoveObstacle'; payload: RemoveObstaclePayload; clientSeq?: number };

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
      reward: ResourceAmount;
    }
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

/** Applies one command. Pure: the input state is never modified. */
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

  switch (command.type) {
    case 'PlaceBuilding':
      return placeBuilding(state, command.payload, ctx);
    case 'MoveBuilding':
      return moveBuilding(state, command.payload, ctx);
    case 'RemoveObstacle':
      return removeObstacle(state, command.payload, ctx);
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

  const next = clonePlayerState(state);
  const building: BuildingInstance = {
    id: highestEntityId(next) + 1,
    type: def.id,
    level: 1,
    x,
    y,
  };
  next.buildings.push(building);
  if (def.category === 'hq') next.keepLevel = building.level;
  next.lastSyncAt = ctx.now;

  return ok(next, [
    {
      type: 'BuildingPlaced',
      buildingId: building.id,
      buildingType: building.type,
      level: building.level,
      x: building.x,
      y: building.y,
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
  if (typeof payload.buildingId !== 'number' || !Number.isInteger(payload.buildingId)) {
    return invalid(
      `payload.buildingId must be an integer, received ${describe(payload.buildingId)}`,
    );
  }

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

  const changes: ResourceAmount = {};
  for (const [resource, amount] of Object.entries(def.reward)) {
    if (amount === undefined || amount === 0) continue;
    const id = resource as ResourceId;
    changes[id] = (changes[id] ?? 0) + amount;
    next.resources[id] = (next.resources[id] ?? 0) + amount;
  }
  next.lastSyncAt = ctx.now;

  const events: GameEvent[] = [
    {
      type: 'ObstacleRemoved',
      obstacleId: obstacle.id,
      obstacleType: obstacle.type,
      reward: def.reward,
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
