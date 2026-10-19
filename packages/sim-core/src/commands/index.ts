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
import { OccupancyGrid, type Rect } from '../grid/index.js';
import {
  clonePlayerState,
  highestEntityId,
  type BuildingInstance,
  type PlayerState,
} from '../state/index.js';

export type CommandErrorCode =
  | 'invalid_command'
  | 'invalid_config'
  | 'unknown_building'
  | 'unknown_obstacle'
  | 'not_found'
  | 'out_of_bounds'
  | 'margin'
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
  if (payload === null || typeof payload !== 'object') return invalid('payload must be an object');

  const def = ctx.config.buildings.find((candidate) => candidate.id === payload.buildingType);
  if (!def) {
    return fail({
      code: 'unknown_building',
      message: `unknown building type "${payload.buildingType}"`,
      details: { buildingType: payload.buildingType },
    });
  }

  const rect = footprint(def, payload.x, payload.y);
  const conflict = checkPlacement(state, def, rect, ctx);
  if (conflict) return conflict;

  const next = clonePlayerState(state);
  const building: BuildingInstance = {
    id: highestEntityId(next) + 1,
    type: def.id,
    level: 1,
    x: payload.x,
    y: payload.y,
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
  if (payload === null || typeof payload !== 'object') return invalid('payload must be an object');

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

  const target = footprint(def, payload.x, payload.y);

  // Free the building's own footprint first so a building can be "moved" onto
  // its current position (a legal no-op) without tripping the overlap check.
  const grid = buildGrid(state, ctx.config);
  grid.clear({ x: building.x, y: building.y, w: def.size.w, h: def.size.h }, building.id);

  const conflict = checkPlacement(state, def, target, ctx, grid);
  if (conflict) return conflict;

  const from = { x: building.x, y: building.y };
  const next = clonePlayerState(state);
  const moved = next.buildings.find((candidate) => candidate.id === building.id);
  if (!moved) {
    return fail({ code: 'not_found', message: `no building with id ${payload.buildingId}` });
  }
  moved.x = payload.x;
  moved.y = payload.y;
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
  if (payload === null || typeof payload !== 'object') return invalid('payload must be an object');

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

function buildGrid(state: PlayerState, config: GameConfig): OccupancyGrid {
  assertValidGeometry(GRID);
  const entries = [
    ...state.buildings.map((building) => {
      const def = config.buildings.find((candidate) => candidate.id === building.type);
      return {
        id: building.id,
        x: building.x,
        y: building.y,
        w: def?.size.w ?? 1,
        h: def?.size.h ?? 1,
      };
    }),
    ...state.obstacles.map((obstacle) => {
      const def = config.obstacles.find((candidate) => candidate.id === obstacle.type);
      return {
        id: obstacle.id,
        x: obstacle.x,
        y: obstacle.y,
        w: def?.size.w ?? 1,
        h: def?.size.h ?? 1,
      };
    }),
  ];
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
  const occupancy = grid ?? buildGrid(state, ctx.config);
  const conflict = occupancy.findConflict(rect);

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
