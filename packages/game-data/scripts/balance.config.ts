/**
 * Human-editable balance input for `scripts/gen-balance.ts`.
 *
 * This file is the *only* place a designer touches numbers. The generator reads
 * it and writes `data/buildings.json`; nothing here is a rule, and no rule reads
 * this file. Every value is a base value at level 1 plus an explicit curve, so
 * the same input always produces byte-identical output.
 *
 * Curve parameters come from the design spec:
 *   - cost:      cost(N) = baseCost x 1.55^(N-1), rounded to the nearest 10 (S7.5)
 *   - build time: level N takes baseTime x 1.6^(N-1)                 (S7.5)
 *   - hp:        x1.4 per level — the one level-scaling figure the spec states
 *                numerically ("Wall: Level scaling x1.4/level", S7.9), and the
 *                ratio the hand-authored tables already used.
 *
 * Keep upgrade times are NOT curve-generated: S7.5 lists them explicitly
 * ("level-2 Keep = 5 min, then 30 min -> 3 h -> 12 h -> 1 d -> 2 d -> 4 d").
 */

import type { ResourceAmount, ResourceId } from '../../sim-core/src/index.js';

/** One curve the generator knows how to evaluate. */
export interface Curve {
  /** Multiplier applied once per level above the first. */
  growth: number;
  /**
   * Rounds the generated value. `none` leaves it exact; `nearest10` rounds to the
   * nearest multiple of 10 (the spec's cost rule).
   */
  round: 'none' | 'nearest10';
}

export interface BuildingBase {
  id: string;
  category: 'economy' | 'storage' | 'army' | 'defense' | 'trap' | 'wall' | 'hq' | 'misc';
  size: { w: number; h: number };
  /** Keep level at which the building type first appears. */
  unlockKeep: number;
  /** Highest level the generator emits. */
  maxLevel: number;
  /** Level-1 hit points. */
  baseHp: number;
  /** Level-1 build time in seconds. */
  baseBuildSeconds: number;
  /** Level-1 cost, before growth. */
  baseCost: Partial<Record<ResourceId, number>>;
  curves: { hp: Curve; cost: Curve; buildSeconds: Curve };
  /** Present on collectors only. */
  production?: {
    produces: ResourceId;
    /** Level-1 production per hour. */
    basePerHour: number;
    /** Level-1 buffer cap. */
    baseBufferCap: number;
    growth: { perHour: number; bufferCap: number };
  };
  /** Present on storages only: the level-1 capacity, and its growth. */
  storage?: {
    capacities: Partial<Record<ResourceId, number>>;
    growth: number;
  };
}

/**
 * The Keep gating table, transcribed verbatim from spec Section 7.3.
 *
 * Read as "at Keep K, a Gold Mine may reach level `table[K].goldMine`". The
 * generator inverts it into each level's `requiresKeep`.
 */
export const KEEP_GATING = {
  maxBuildingLevel: [0, 2, 3, 4, 5, 6, 7],
  goldMine: [0, 2, 3, 4, 5, 6, 6],
  essenceWell: [0, 2, 3, 4, 5, 6, 6],
  goldStore: [0, 1, 1, 2, 2, 2, 3],
  essenceStore: [0, 1, 1, 2, 2, 2, 3],
  walls: [0, 0, 25, 50, 75, 100, 125],
} as const;

/**
 * Explicit Keep upgrade durations in seconds (S7.5), indexed by target level.
 *
 * Level 1 is 0 because every player starts with a Keep — there is nothing to
 * build. S7.5 lists levels 2-8 ("5 min, then 30 min -> 3 h -> 12 h -> 1 d ->
 * 2 d -> 4 d"); the generator stops at 6 for this vertical slice.
 */
export const KEEP_BUILD_SECONDS: Record<number, number> = {
  1: 0,
  2: 300, // 5 min
  3: 1800, // 30 min
  4: 10800, // 3 h
  5: 43200, // 12 h
  6: 86400, // 1 d
  7: 172800, // 2 d
  8: 345600, // 4 d
};

/**
 * The lowest Keep level at which `building` may reach `level`.
 *
 * This reads the **"Max bldg level"** column and nothing else. The per-building
 * columns in §7.3 are *quantity* ceilings (how many Gold Mines, how many walls),
 * not level ceilings — reading them here would cap a Gold Store at level 1
 * because Keep 1 allows only one Gold Store. Counts are a separate table,
 * `KEEP_COUNT_LIMITS`, and a separate config field.
 */
export function requiredKeepFor(_building: string, level: number): number {
  const table = KEEP_GATING.maxBuildingLevel as readonly number[];
  for (let keep = 1; keep < table.length; keep += 1) {
    if ((table[keep] as number) >= level) return keep;
  }
  return table.length - 1;
}

/**
 * Maximum number of each building per Keep level, transcribed from the
 * per-building columns of §7.3. Index `k` is the ceiling while the completed
 * Keep is at level `k`; index 0 is unused.
 *
 * `keep` is 1 at every level: a village has exactly one HQ. Walls are 0 at
 * Keep 1 and 25/50/75/100/125 thereafter — a wall *count*, never a wall level.
 */
export const KEEP_COUNT_LIMITS: Readonly<Record<string, readonly number[]>> = {
  keep: [0, 1, 1, 1, 1, 1, 1],
  gold_mine: [0, 2, 3, 4, 5, 6, 6],
  essence_well: [0, 2, 3, 4, 5, 6, 6],
  gold_store: [0, 1, 1, 2, 2, 2, 3],
  essence_store: [0, 1, 1, 2, 2, 2, 3],
  wall: [0, 0, 25, 50, 75, 100, 125],
};

/** Hard ceiling on Keep instances per village (spec §7.3: one HQ). */
export const MAX_KEEPS_PER_VILLAGE = 1;

const DEFAULT_CURVES = {
  hp: { growth: 1.4, round: 'none' as const },
  cost: { growth: 1.55, round: 'nearest10' as const },
  buildSeconds: { growth: 1.6, round: 'none' as const },
};

export const BUILDINGS: BuildingBase[] = [
  {
    id: 'keep',
    category: 'hq',
    size: { w: 4, h: 4 },
    unlockKeep: 1,
    maxLevel: 6,
    baseHp: 1500,
    baseBuildSeconds: KEEP_BUILD_SECONDS[2] as number,
    baseCost: { gold: 1000, essence: 1000 },
    curves: DEFAULT_CURVES,
    storage: { capacities: { gold: 1000, essence: 1000 }, growth: 1.6 },
  },
  {
    id: 'gold_mine',
    category: 'economy',
    size: { w: 3, h: 3 },
    unlockKeep: 1,
    maxLevel: 6,
    baseHp: 300,
    baseBuildSeconds: 20,
    baseCost: { gold: 150 },
    curves: DEFAULT_CURVES,
    production: {
      produces: 'gold',
      basePerHour: 240,
      baseBufferCap: 600,
      growth: { perHour: 1.5, bufferCap: 1.5 },
    },
  },
  {
    id: 'essence_well',
    category: 'economy',
    size: { w: 3, h: 3 },
    unlockKeep: 1,
    maxLevel: 6,
    baseHp: 300,
    baseBuildSeconds: 20,
    baseCost: { essence: 150 },
    curves: DEFAULT_CURVES,
    production: {
      produces: 'essence',
      basePerHour: 240,
      baseBufferCap: 600,
      growth: { perHour: 1.5, bufferCap: 1.5 },
    },
  },
  {
    id: 'gold_store',
    category: 'storage',
    size: { w: 3, h: 3 },
    unlockKeep: 1,
    maxLevel: 3,
    baseHp: 500,
    baseBuildSeconds: 30,
    baseCost: { gold: 200 },
    curves: DEFAULT_CURVES,
    storage: { capacities: { gold: 2500 }, growth: 2 },
  },
  {
    id: 'essence_store',
    category: 'storage',
    size: { w: 3, h: 3 },
    unlockKeep: 1,
    maxLevel: 3,
    baseHp: 500,
    baseBuildSeconds: 30,
    baseCost: { essence: 200 },
    curves: DEFAULT_CURVES,
    storage: { capacities: { essence: 2500 }, growth: 2 },
  },
  {
    id: 'wall',
    category: 'wall',
    size: { w: 1, h: 1 },
    unlockKeep: 2,
    maxLevel: 6,
    baseHp: 300,
    baseBuildSeconds: 5,
    baseCost: { gold: 10 },
    curves: DEFAULT_CURVES,
  },
];

export interface ObstacleBase {
  id: string;
  size: { w: number; h: number };
  reward: ResourceAmount;
  removalSeconds: number;
}

/** Obstacle definitions — authored, not curve-generated. */
export const OBSTACLES: ObstacleBase[] = [
  { id: 'tree', size: { w: 1, h: 1 }, reward: { gold: 20 }, removalSeconds: 3 },
  { id: 'rock', size: { w: 1, h: 1 }, reward: { gold: 30, gems: 1 }, removalSeconds: 5 },
];
