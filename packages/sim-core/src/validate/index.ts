/**
 * Config validation.
 *
 * "Config loader with schema validation (use Zod or similar); fail loudly with
 * helpful messages." A bad balance table is a build-time bug, so
 * {@link validateGameConfig} throws on the *first* load and lists every problem
 * it found rather than stopping at one.
 */

import { z } from 'zod';
import type { GameConfig } from '../config/types.js';

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
    productionPerHour: z.number().int().nonnegative().optional(),
    bufferCap: z.number().int().nonnegative().optional(),
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

const GameConfigSchema = z
  .object({
    version: z.string().min(1),
    buildings: z.array(BuildingDefSchema).min(1),
    obstacles: z.array(ObstacleDefSchema).default([]),
    starter: StarterConfigSchema,
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
function checkSemantics(config: GameConfig): string[] {
  const issues: string[] = [];

  const buildingIds = new Set<string>();
  for (const building of config.buildings) {
    if (buildingIds.has(building.id)) {
      issues.push(`duplicate building id "${building.id}"`);
    }
    buildingIds.add(building.id);

    const levels = building.levels.map((level) => level.level);
    const sorted = [...levels].sort((a, b) => a - b);
    if (levels.some((level, index) => level !== sorted[index])) {
      issues.push(`building "${building.id}" has out-of-order levels: [${levels.join(', ')}]`);
    }
    for (let i = 1; i < levels.length; i += 1) {
      if ((levels[i] as number) !== (levels[i - 1] as number) + 1) {
        issues.push(
          `building "${building.id}" levels must be contiguous from 1, got [${levels.join(', ')}]`,
        );
        break;
      }
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

  const obstacleIds = new Set<string>();
  for (const obstacle of config.obstacles) {
    if (obstacleIds.has(obstacle.id)) {
      issues.push(`duplicate obstacle id "${obstacle.id}"`);
    }
    obstacleIds.add(obstacle.id);
  }

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

  return issues;
}
