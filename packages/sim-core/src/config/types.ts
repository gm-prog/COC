/**
 * Config schemas (design spec Section 8.1), as TypeScript types.
 *
 * Every number a designer tunes lives in `packages/game-data` and is validated
 * against these shapes before it reaches any rule. Logic must never hard-code a
 * cost, a time or a stat.
 */

export type ResourceId = 'gold' | 'essence' | 'shards' | 'gems';

export const RESOURCE_IDS: readonly ResourceId[] = Object.freeze([
  'gold',
  'essence',
  'shards',
  'gems',
]);

export type ResourceAmount = Partial<Record<ResourceId, number>>;

export type BuildingCategory =
  'economy' | 'storage' | 'army' | 'defense' | 'trap' | 'wall' | 'hq' | 'misc';

export interface BuildingSize {
  w: number;
  h: number;
}

export interface BuildingLevel {
  level: number;
  hp: number;
  cost: ResourceAmount;
  buildSeconds: number;
  requiresKeep: number;
  /** Economy */
  productionPerHour?: number;
  bufferCap?: number;
  /** Storage */
  storageCap?: ResourceAmount;
  /** Army */
  housing?: number;
  queueSlots?: number;
  /** Defense */
  dps?: number;
  shotDamage?: number;
  fireIntervalTicks?: number;
  rangeMin?: number;
  rangeMax?: number;
  splashRadius?: number;
  targets?: ('ground' | 'air')[];
}

export interface BuildingDef {
  id: string;
  category: BuildingCategory;
  size: BuildingSize;
  levels: BuildingLevel[];
  unlock: { keepLevel: number };
}

/** A removable decorative obstacle (tree, rock, …). */
export interface ObstacleDef {
  id: string;
  size: BuildingSize;
  /** Reward granted when the obstacle is cleared. */
  reward: ResourceAmount;
  /** Seconds a builder would spend clearing it (enforced from Phase 2). */
  removalSeconds: number;
}

export interface StarterBuilding {
  type: string;
  level: number;
  x: number;
  y: number;
}

export interface StarterObstacle {
  type: string;
  x: number;
  y: number;
}

export interface StarterConfig {
  resources: Record<ResourceId, number>;
  builders: number;
  buildings: StarterBuilding[];
  obstacles: StarterObstacle[];
}

export interface GameConfig {
  /** Balance/config version stamped onto every state and battle. */
  version: string;
  buildings: BuildingDef[];
  obstacles: ObstacleDef[];
  starter: StarterConfig;
}
