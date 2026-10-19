/**
 * Authoritative player state (design spec Section 8.2).
 *
 * The server owns this object; the client keeps a predicted copy. Everything in
 * it is plain JSON so it can be stored in a JSONB column, diffed, hashed and
 * re-simulated. `now` is always injected — never read from a clock here.
 */

import type { GameConfig, ResourceId } from '../config/types.js';
import { deepClone } from './clone.js';

export { deepClone };

export interface BuildingInstance {
  id: number;
  /** Building definition id from the config, e.g. 'gold_mine'. */
  type: string;
  level: number;
  x: number;
  y: number;
  upgrade?: { toLevel: number; finishAt: number };
  bufferStartedAt?: number;
}

export interface ObstacleInstance {
  id: number;
  type: string;
  x: number;
  y: number;
}

export interface BuilderAssignment {
  buildingId: number;
  finishAt: number;
}

export interface TrainingQueueItem {
  troopId: string;
  finishAt: number;
}

export interface ResearchState {
  active?: { unitId: string; toLevel: number; finishAt: number };
  levels: Record<string, number>;
}

export interface PlayerState {
  /** Optimistic concurrency token. */
  version: number;
  configVersion: string;
  keepLevel: number;
  resources: Record<ResourceId, number>;
  builders: { count: number; busy: BuilderAssignment[] };
  buildings: BuildingInstance[];
  obstacles: ObstacleInstance[];
  /** troopId -> count */
  army: Record<string, number>;
  trainingQueues: { barracksId: number; items: TrainingQueueItem[] }[];
  research: ResearchState;
  /** spellId -> count */
  spells: Record<string, number>;
  trophies: number;
  shieldUntil?: number;
  guardUntil?: number;
  clan?: { clanId: string; role: string };
  tutorialStep: number;
  /** Server time of the last catch-up, in epoch milliseconds. */
  lastSyncAt: number;
}

export const STATE_VERSION = 1;

/**
 * Builds the state a brand-new player starts from.
 *
 * Every value comes from `config.starter` — resources, builder count, the
 * initial layout and the decorative obstacles — so a designer can change the
 * opening without touching this function.
 */
export function createNewPlayerState(config: GameConfig, now: number): PlayerState {
  const starter = config.starter;
  const buildings: BuildingInstance[] = starter.buildings.map((entry, index) => ({
    id: index + 1,
    type: entry.type,
    level: entry.level,
    x: entry.x,
    y: entry.y,
  }));

  const obstacles: ObstacleInstance[] = starter.obstacles.map((entry, index) => ({
    id: buildings.length + index + 1,
    type: entry.type,
    x: entry.x,
    y: entry.y,
  }));

  const keep = buildings.find((building) => {
    const def = config.buildings.find((candidate) => candidate.id === building.type);
    return def?.category === 'hq';
  });

  return {
    version: STATE_VERSION,
    configVersion: config.version,
    keepLevel: keep?.level ?? 1,
    resources: { ...starter.resources },
    builders: { count: starter.builders, busy: [] },
    buildings,
    obstacles,
    army: {},
    trainingQueues: [],
    research: { levels: {} },
    spells: {},
    trophies: 0,
    tutorialStep: 0,
    lastSyncAt: now,
  };
}

/** The Keep building instance, if the player has one. */
export function findKeep(state: PlayerState): BuildingInstance | undefined {
  return state.buildings.find((building) => building.type === 'keep');
}

/** `state.keepLevel` must always match the Keep building's level. */
export function isKeepLevelConsistent(state: PlayerState): boolean {
  const keep = findKeep(state);
  return keep === undefined || keep.level === state.keepLevel;
}

/** Highest numeric id currently used by buildings or obstacles. */
export function highestEntityId(state: PlayerState): number {
  let highest = 0;
  for (const building of state.buildings) highest = Math.max(highest, building.id);
  for (const obstacle of state.obstacles) highest = Math.max(highest, obstacle.id);
  return highest;
}

export function clonePlayerState(state: PlayerState): PlayerState {
  return deepClone(state);
}
