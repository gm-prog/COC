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

/**
 * The canonical id of the village Keep (spec Section 7.3).
 *
 * The runtime identifies the Keep by this id rather than by category:
 * `findKeep`, the `keepLevel` write in `catchUp` and the one in `SpeedUp` all
 * compare `building.type` against it. The validator therefore requires the
 * single `hq` definition to carry this id, so a config cannot add an HQ the
 * runtime would silently ignore (or a Keep the runtime would not treat as HQ).
 */
export const KEEP_BUILDING_ID = 'keep';

/**
 * Spec Section 7.5: "Player starts with 2 builders. ... Extra builders (max 5)".
 *
 * This is a game rule, not a tunable: a config that asks for more than five is
 * rejected rather than clamped, and raising it requires a specification change.
 */
export const MAX_BUILDERS = 5;

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
  /** Economy: the resource this collector produces, and how fast. */
  produces?: ResourceId;
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

/**
 * One anchor of the piecewise-linear speed-up cost curve.
 * `seconds` is the remaining duration; `gems` is what skipping it costs.
 */
export interface SpeedUpAnchor {
  seconds: number;
  gems: number;
}

/** Gem prices for extra builders, in purchase order. */
export interface BuilderShop {
  /** Hard ceiling on concurrent builders (spec Section 7.5: max 5). */
  maxBuilders: number;
  /**
   * `costs[n]` is the gem price of purchase number `n` — i.e. of the builder
   * that takes the player from `starter.builders + n` to `starter.builders + n + 1`.
   */
  costs: ResourceAmount[];
}

/** Refund fractions applied when an upgrade is cancelled (spec Section 7.5). */
export interface CancelRefund {
  /** Fraction refunded for an upgrade that has already started: 0. */
  startedUpgrade: number;
  /**
   * Fraction refunded for an item that was queued but never started: 0.5.
   * Consumed by the training queue from Phase 4; kept in data so the rule is
   * stated once rather than reinvented.
   */
  queuedItem: number;
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

/**
 * Per-Keep-level building *quantity* ceilings, transcribed from the spec's
 * §7.3 table.
 *
 * This is a different rule from `BuildingLevel.requiresKeep`:
 *
 *   - `requiresKeep` answers "what level may this building reach at Keep K?"
 *     and comes from the table's **"Max bldg level"** column.
 *   - `buildingCounts[id][K]` answers "how many of this building may exist at
 *     Keep K?" and comes from the per-building columns (Gold Mine, Gold Store,
 *     Walls (max), …).
 *
 * The two must never be inferred from one another: a Walls (max) of 25 at
 * Keep 2 is a count of walls, not a maximum wall level.
 */
export interface BuildingLimits {
  /** Maximum Keep instances per village. Phase 2 has exactly one. */
  maxKeeps: number;
  /**
   * `buildingCounts[buildingId][keepLevel]` is the maximum number of that
   * building the village may own while the *completed* Keep is at `keepLevel`.
   * Index 0 is unused, so every array is indexed directly by Keep level.
   */
  buildingCounts: Record<string, number[]>;
}

export interface GameConfig {
  /** Balance/config version stamped onto every state and battle. */
  version: string;
  buildings: BuildingDef[];
  obstacles: ObstacleDef[];
  starter: StarterConfig;
  /** Speed-up gem curve, builder shop prices and cancel refunds. */
  economy: EconomyConfig;
  /** Per-Keep-level building quantity ceilings (spec §7.3). */
  limits: BuildingLimits;
}

export interface EconomyConfig {
  /** Piecewise-linear gem cost of skipping the remaining duration. */
  speedUp: { anchors: SpeedUpAnchor[]; minimumGems: number };
  builders: BuilderShop;
  cancelRefund: CancelRefund;
  /** Milliseconds in one hour — the unit production rates are expressed in. */
  msPerHour: number;
}
