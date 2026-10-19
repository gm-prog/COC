/**
 * Config validation.
 *
 * "Config loader with schema validation (use Zod or similar); fail loudly with
 * helpful messages." A bad balance table is a build-time bug, so
 * {@link validateGameConfig} throws on the *first* load and lists every problem
 * it found rather than stopping at one.
 */

import { z } from 'zod';
import { GRID } from '../config/geometry.js';
import type { GameConfig } from '../config/types.js';
import { isValidRect, rectsOverlap, type Rect } from '../grid/index.js';

export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid game config (${issues.length} problem${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/**
 * A partial resource amount. Written as an explicit object rather than
 * `z.record` so the inferred type is `Partial<Record<ResourceId, number>>` and
 * unknown resource names are rejected instead of silently ignored.
 */
const ResourceAmountSchema = z
  .object({
    gold: z.number().int().nonnegative().optional(),
    essence: z.number().int().nonnegative().optional(),
    shards: z.number().int().nonnegative().optional(),
    gems: z.number().int().nonnegative().optional(),
  })
  .strict();

const BuildingSizeSchema = z
  .object({
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })
  .strict();

const BuildingLevelSchema = z
  .object({
    level: z.number().int().positive(),
    hp: z.number().int().positive(),
    cost: ResourceAmountSchema.default({}),
    buildSeconds: z.number().int().nonnegative(),
    requiresKeep: z.number().int().positive(),
    produces: z.enum(['gold', 'essence', 'shards', 'gems']).optional(),
    // Bounded so the fixed-point production arithmetic is provably exact: the
    // largest intermediate is `restMs * productionPerHour * FIXED_ONE`, and
    // 3,599,999 * 1,000,000 * 1,000 stays inside 2^53 with room to spare.
    productionPerHour: z.number().int().nonnegative().max(1_000_000).optional(),
    // D28: the same 1,000,000 ceiling as `productionPerHour`. A larger cap
    // would let a buffer hold more than the production arithmetic can be
    // proven exact over, so it is rejected at import rather than at runtime.
    bufferCap: z.number().int().nonnegative().max(1_000_000).optional(),
    storageCap: ResourceAmountSchema.optional(),
    housing: z.number().int().nonnegative().optional(),
    queueSlots: z.number().int().nonnegative().optional(),
    dps: z.number().int().nonnegative().optional(),
    shotDamage: z.number().int().nonnegative().optional(),
    fireIntervalTicks: z.number().int().positive().optional(),
    rangeMin: z.number().int().nonnegative().optional(),
    rangeMax: z.number().int().nonnegative().optional(),
    splashRadius: z.number().int().nonnegative().optional(),
    targets: z.array(z.enum(['ground', 'air'])).optional(),
  })
  .strict();

const BuildingDefSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, 'must be snake_case (lowercase letters, digits, underscores)'),
    category: z.enum(['economy', 'storage', 'army', 'defense', 'trap', 'wall', 'hq', 'misc']),
    size: BuildingSizeSchema,
    levels: z.array(BuildingLevelSchema).min(1),
    unlock: z.object({ keepLevel: z.number().int().positive() }).strict(),
  })
  .strict();

const ObstacleDefSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, 'must be snake_case (lowercase letters, digits, underscores)'),
    size: BuildingSizeSchema,
    reward: ResourceAmountSchema.default({}),
    removalSeconds: z.number().int().nonnegative().default(0),
  })
  .strict();

const StarterConfigSchema = z
  .object({
    resources: z
      .object({
        gold: z.number().int().nonnegative(),
        essence: z.number().int().nonnegative(),
        shards: z.number().int().nonnegative(),
        gems: z.number().int().nonnegative(),
      })
      .strict(),
    builders: z.number().int().positive(),
    buildings: z
      .array(
        z
          .object({
            type: z.string().min(1),
            level: z.number().int().positive(),
            x: z.number().int().nonnegative(),
            y: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default([]),
    obstacles: z
      .array(
        z
          .object({
            type: z.string().min(1),
            x: z.number().int().nonnegative(),
            y: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const SpeedUpAnchorSchema = z
  .object({
    seconds: z.number().int().positive(),
    gems: z.number().int().nonnegative(),
  })
  .strict();

const EconomyConfigSchema = z
  .object({
    speedUp: z
      .object({
        anchors: z.array(SpeedUpAnchorSchema).min(2),
        minimumGems: z.number().int().positive(),
      })
      .strict(),
    builders: z
      .object({
        maxBuilders: z.number().int().positive(),
        costs: z.array(ResourceAmountSchema).min(1),
      })
      .strict(),
    cancelRefund: z
      .object({
        startedUpgrade: z.number().min(0).max(1),
        queuedItem: z.number().min(0).max(1),
      })
      .strict(),
    msPerHour: z.number().int().positive(),
  })
  .strict();

const BuildingLimitsSchema = z
  .object({
    maxKeeps: z.number().int().positive(),
    buildingCounts: z.record(z.string(), z.array(z.number().int().nonnegative())),
  })
  .strict();

const GameConfigSchema = z
  .object({
    version: z.string().min(1),
    buildings: z.array(BuildingDefSchema).min(1),
    obstacles: z.array(ObstacleDefSchema).default([]),
    starter: StarterConfigSchema,
    economy: EconomyConfigSchema,
    limits: BuildingLimitsSchema,
  })
  .strict();

export type ValidatedGameConfig = z.infer<typeof GameConfigSchema>;

/**
 * Validates raw config data and returns it typed.
 *
 * @throws {ConfigValidationError} listing every problem found.
 */
export function validateGameConfig(raw: unknown): GameConfig {
  const parsed = GameConfigSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => formatIssue(issue, raw));
    throw new ConfigValidationError(issues);
  }

  const config = parsed.data as GameConfig;
  const semanticIssues = checkSemantics(config);
  if (semanticIssues.length > 0) throw new ConfigValidationError(semanticIssues);

  return config;
}

/** Alias used by call sites that read "load" more naturally than "validate". */
export const loadGameConfig = validateGameConfig;

/** Validates just the building table (used by tests and tooling). */
export function validateBuildingDefs(raw: unknown): GameConfig['buildings'] {
  const parsed = z.array(BuildingDefSchema).safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.issues.map((issue) => formatIssue(issue, raw)));
  }
  return parsed.data as GameConfig['buildings'];
}

interface ConfigIssue {
  path: PropertyKey[];
  message: string;
  code?: string;
  values?: unknown[];
}

/**
 * Zod does not attach the offending value to its issues, and "the value you
 * actually wrote" is the single most useful thing when a balance table is
 * wrong. Walk the raw data along the issue path to recover it.
 */
function formatIssue(issue: ConfigIssue, raw: unknown): string {
  const path = issue.path.map(String).join('.');
  const location = path.length > 0 ? `at "${path}"` : 'at the config root';
  const received = valueAtPath(raw, issue.path);
  const receivedText = isPrimitive(received) ? ` (received ${JSON.stringify(received)})` : '';
  const allowedText = Array.isArray(issue.values)
    ? ` [allowed: ${issue.values.map((value) => JSON.stringify(value)).join(', ')}]`
    : '';
  return `${issue.message}${receivedText}${allowedText} ${location} (code: ${issue.code})`;
}

function valueAtPath(raw: unknown, path: PropertyKey[]): unknown {
  let current: unknown = raw;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else {
      current = (current as Record<PropertyKey, unknown>)[key];
    }
  }
  return current;
}

function isPrimitive(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

/** Checks Zod cannot express: uniqueness, contiguity and cross-references. */
export function checkSemantics(config: GameConfig): string[] {
  const issues: string[] = [];

  const buildingIds = new Set<string>();
  for (const building of config.buildings) {
    if (buildingIds.has(building.id)) {
      issues.push(`duplicate building id "${building.id}"`);
    }
    buildingIds.add(building.id);

    // One rule, one message: a level table must be exactly [1, 2, 3, ...].
    // Checking it as a single predicate catches "starts at 2", "starts at 3",
    // gaps, duplicates and out-of-order entries without emitting several
    // overlapping complaints about the same broken table.
    const levels = building.levels.map((level) => level.level);
    if (!levels.every((level, index) => level === index + 1)) {
      issues.push(
        `building "${building.id}" levels must start at 1 and be contiguous ascending, got [${levels.join(', ')}]`,
      );
    }
    for (const level of building.levels) {
      if (
        level.rangeMin !== undefined &&
        level.rangeMax !== undefined &&
        level.rangeMax < level.rangeMin
      ) {
        issues.push(
          `building "${building.id}" level ${level.level} has rangeMax (${level.rangeMax}) below rangeMin (${level.rangeMin})`,
        );
      }
    }

    // Level 1 cannot be available below the building's own unlock, and the Keep
    // requirement must never fall as a building levels up. (A higher level
    // *may* require a higher Keep than the unlock — that is the gating table.)
    const first = building.levels[0];
    if (first && first.requiresKeep > building.unlock.keepLevel) {
      issues.push(
        `building "${building.id}" level 1 requires Keep ${first.requiresKeep} but the building only unlocks at Keep ${building.unlock.keepLevel}`,
      );
    }
    for (let i = 1; i < building.levels.length; i += 1) {
      const previous = building.levels[i - 1] as (typeof building.levels)[number];
      const current = building.levels[i] as (typeof building.levels)[number];
      if (current.requiresKeep < previous.requiresKeep) {
        issues.push(
          `building "${building.id}" level ${current.level} requires Keep ${current.requiresKeep}, below level ${previous.level}'s Keep ${previous.requiresKeep}`,
        );
      }
    }
  }

  const economyIssues = checkEconomy(config);
  issues.push(...economyIssues);

  const obstacleIds = new Set<string>();
  for (const obstacle of config.obstacles) {
    if (obstacleIds.has(obstacle.id)) {
      issues.push(`duplicate obstacle id "${obstacle.id}"`);
    }
    obstacleIds.add(obstacle.id);
  }

  issues.push(...checkCollectors(config));

  for (const starterBuilding of config.starter.buildings) {
    if (!buildingIds.has(starterBuilding.type)) {
      issues.push(
        `starter building "${starterBuilding.type}" is not defined in the buildings table`,
      );
      continue;
    }
    const def = config.buildings.find((b) => b.id === starterBuilding.type) as
      (typeof config.buildings)[number] | undefined;
    const level = def?.levels.find((l) => l.level === starterBuilding.level);
    if (def && !level) {
      issues.push(
        `starter building "${starterBuilding.type}" references undefined level ${starterBuilding.level}`,
      );
    }
  }

  for (const starterObstacle of config.starter.obstacles) {
    if (!obstacleIds.has(starterObstacle.type)) {
      issues.push(
        `starter obstacle "${starterObstacle.type}" is not defined in the obstacles table`,
      );
    }
  }

  const keepCount = config.starter.buildings.filter((b) => {
    const def = config.buildings.find((candidate) => candidate.id === b.type);
    return def?.category === 'hq';
  }).length;
  if (keepCount !== 1) {
    issues.push(`starter layout must contain exactly one Keep (found ${keepCount})`);
  }

  issues.push(...checkLimits(config));
  issues.push(...checkStarterLayout(config));

  return issues;
}

/**
 * The quantity rules (spec §7.3) are their own table, separate from
 * `requiresKeep`. This checks the table is complete and coherent with the
 * buildings it governs: every building has a row, every row covers every Keep
 * level the Keep definition supports, index 0 is unused, the HQ row never
 * exceeds `maxKeeps`, and no row names a building that does not exist.
 */
export function checkLimits(config: GameConfig): string[] {
  const issues: string[] = [];
  const { maxKeeps, buildingCounts } = config.limits;

  if (maxKeeps !== 1) {
    issues.push(`limits.maxKeeps must be 1 (this phase supports one Keep), received ${maxKeeps}`);
  }

  const keepDef = config.buildings.find((building) => building.category === 'hq');
  const maxKeepLevel = keepDef === undefined ? 0 : keepDef.levels.length;
  if (keepDef === undefined) {
    issues.push('config must define exactly one HQ building (category "hq")');
  }

  for (const building of config.buildings) {
    const counts = buildingCounts[building.id];
    if (counts === undefined) {
      issues.push(`limits.buildingCounts is missing an entry for building "${building.id}"`);
      continue;
    }
    if (counts.length < maxKeepLevel + 1) {
      issues.push(
        `limits.buildingCounts["${building.id}"] must cover Keep levels 1..${maxKeepLevel} at indexes 1..${maxKeepLevel}, got ${counts.length} entries`,
      );
    }
    if ((counts[0] ?? 0) !== 0) {
      issues.push(
        `limits.buildingCounts["${building.id}"][0] is unused and must be 0, received ${counts[0]}`,
      );
    }
    // Only the HQ row is bounded by `maxKeeps`; other rows are counts of
    // ordinary buildings and are legitimately larger than one.
    if (building.id === keepDef?.id) {
      const aboveCeiling = counts.slice(1).filter((count) => count > maxKeeps);
      if (aboveCeiling.length > 0) {
        issues.push(
          `limits.buildingCounts["${building.id}"] allows more than limits.maxKeeps (${maxKeeps}) at some Keep level`,
        );
      }
    }
  }

  for (const id of Object.keys(buildingCounts)) {
    if (!config.buildings.some((building) => building.id === id)) {
      issues.push(`limits.buildingCounts has an entry for unknown building "${id}"`);
    }
  }

  return issues;
}

/**
 * Starter footprints: every tile, not just the origin.
 *
 * The starter layout is placed by `createNewPlayerState` without going through
 * the command layer, so a 4×4 Keep at (0,0) would otherwise become a permanent
 * off-map building that every later placement has to route around. Buildings
 * must sit wholly inside the buildable core; obstacles only need to sit inside
 * the map, because the decorative margin is where they belong. Nothing may
 * overlap anything else.
 */
export function checkStarterLayout(config: GameConfig): string[] {
  const issues: string[] = [];
  const placed: { label: string; rect: Rect }[] = [];

  const margin = GRID.margin;
  const coreEnd = GRID.margin + GRID.buildable;

  for (const starter of config.starter.buildings) {
    const def = config.buildings.find((candidate) => candidate.id === starter.type);
    if (def === undefined) continue; // reported as an unknown reference already
    const rect = { x: starter.x, y: starter.y, w: def.size.w, h: def.size.h };
    if (!isValidRect(rect)) {
      issues.push(
        `starter building "${starter.type}" has malformed geometry ${JSON.stringify(rect)}`,
      );
      continue;
    }
    if (
      rect.x < margin ||
      rect.y < margin ||
      rect.x + rect.w > coreEnd ||
      rect.y + rect.h > coreEnd
    ) {
      issues.push(
        `starter building "${starter.type}" at (${rect.x},${rect.y}) with footprint ${rect.w}x${rect.h} leaves the ${GRID.buildable}x${GRID.buildable} buildable core`,
      );
    }
    placed.push({ label: `starter building "${starter.type}"`, rect });
  }

  for (const starter of config.starter.obstacles) {
    const def = config.obstacles.find((candidate) => candidate.id === starter.type);
    if (def === undefined) continue;
    const rect = { x: starter.x, y: starter.y, w: def.size.w, h: def.size.h };
    if (!isValidRect(rect)) {
      issues.push(
        `starter obstacle "${starter.type}" has malformed geometry ${JSON.stringify(rect)}`,
      );
      continue;
    }
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > GRID.total || rect.y + rect.h > GRID.total) {
      issues.push(
        `starter obstacle "${starter.type}" at (${rect.x},${rect.y}) with footprint ${rect.w}x${rect.h} leaves the ${GRID.total}x${GRID.total} map`,
      );
    }
    placed.push({ label: `starter obstacle "${starter.type}"`, rect });
  }

  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i] as (typeof placed)[number];
      const b = placed[j] as (typeof placed)[number];
      if (rectsOverlap(a.rect, b.rect)) {
        issues.push(`${a.label} overlaps ${b.label}`);
      }
    }
  }

  return issues;
}

/**
 * A collector must name the resource it produces and must be able to hold it —
 * otherwise production has nowhere to go and the rules would have to guess.
 */
function checkCollectors(config: GameConfig): string[] {
  const issues: string[] = [];
  for (const building of config.buildings) {
    for (const level of building.levels) {
      if (level.productionPerHour !== undefined && level.productionPerHour > 0) {
        if (level.produces === undefined) {
          issues.push(
            `building "${building.id}" level ${level.level} produces ${level.productionPerHour}/hour but does not say which resource`,
          );
        }
        if (level.bufferCap === undefined) {
          issues.push(
            `building "${building.id}" level ${level.level} produces ${level.productionPerHour}/hour but has no bufferCap`,
          );
        }
      }
      if (level.bufferCap !== undefined && level.produces === undefined) {
        issues.push(
          `building "${building.id}" level ${level.level} has a bufferCap but does not say which resource it buffers`,
        );
      }
    }
  }
  return issues;
}

/** Checks the economy block: anchor ordering, builder prices, refund fractions. */
export function checkEconomy(config: GameConfig): string[] {
  const issues: string[] = [];
  const { speedUp, builders, cancelRefund, msPerHour } = config.economy;

  const anchors = speedUp.anchors;
  for (let i = 1; i < anchors.length; i += 1) {
    const previous = anchors[i - 1] as (typeof anchors)[number];
    const current = anchors[i] as (typeof anchors)[number];
    if (current.seconds <= previous.seconds) {
      issues.push(
        `economy.speedUp.anchors must be strictly ascending by seconds, got ${previous.seconds} then ${current.seconds}`,
      );
    }
    if (current.gems < previous.gems) {
      issues.push(
        `economy.speedUp.anchors must be non-decreasing by gems, got ${previous.gems} then ${current.gems}`,
      );
    }
  }
  if (anchors[0]?.gems !== undefined && speedUp.minimumGems > anchors[0].gems) {
    issues.push(
      `economy.speedUp.minimumGems (${speedUp.minimumGems}) exceeds the cheapest anchor (${anchors[0].gems})`,
    );
  }

  if (builders.maxBuilders < config.starter.builders) {
    issues.push(
      `economy.builders.maxBuilders (${builders.maxBuilders}) is below the starter builder count (${config.starter.builders})`,
    );
  }
  // The shop sells (maxBuilders - starter.builders) builders, one price each.
  // Deriving the expected length from the configuration keeps this correct when
  // a designer changes either number.
  const expectedCosts = builders.maxBuilders - config.starter.builders;
  if (builders.costs.length !== expectedCosts) {
    issues.push(
      `economy.builders.costs must contain exactly ${expectedCosts} entries (maxBuilders ${builders.maxBuilders} minus starter builders ${config.starter.builders}), got ${builders.costs.length}`,
    );
  }

  for (const [index, cost] of builders.costs.entries()) {
    for (const [resource, amount] of Object.entries(cost)) {
      if (amount === undefined) continue;
      if (resource !== 'gems') {
        issues.push(
          `economy.builders.costs[${index}].${resource} is not supported: builders are bought with gems only`,
        );
      }
      if (!Number.isInteger(amount)) {
        issues.push(
          `economy.builders.costs[${index}].${resource} must be an integer, received ${amount}`,
        );
      } else if (amount <= 0) {
        issues.push(
          `economy.builders.costs[${index}].${resource} must be positive, received ${amount}`,
        );
      }
    }
    if (cost.gems === undefined) {
      issues.push(`economy.builders.costs[${index}] must have a gems price`);
    }
    if (Object.keys(cost).length === 0) {
      issues.push(`economy.builders.costs[${index}] is empty`);
    }
  }

  for (const [field, value] of Object.entries(cancelRefund)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      issues.push(`economy.cancelRefund.${field} must be a fraction in [0, 1], received ${value}`);
    }
  }

  if (msPerHour !== 3_600_000) {
    issues.push(`economy.msPerHour must be 3,600,000, received ${msPerHour}`);
  }

  return issues;
}
