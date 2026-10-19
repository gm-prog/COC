/**
 * Balance table generator (design spec Phase 2).
 *
 *   pnpm --filter @coc/game-data gen:balance
 *
 * Reads `scripts/balance.config.ts` — the only file a human edits — and writes
 * `data/buildings.json`, `data/obstacles.json` and `data/limits.json`. Every
 * level table is derived from base values plus the spec's growth curves, so a
 * designer tunes a base and regenerates.
 *
 * Determinism: the same input always produces byte-identical output. Keys are
 * emitted in a fixed order, numbers are integers, and nothing time- or
 * machine-dependent enters the file.
 *
 * The output is typed with sim-core's own `BuildingDef` / `ObstacleDef` /
 * `BuildingLimits`, so the compiler — not a cast in a test — proves the
 * generated tables have the shape the rules engine consumes.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  BuildingDef,
  BuildingLevel,
  BuildingLimits,
  ObstacleDef,
  ResourceAmount,
  ResourceId,
} from '../../sim-core/src/index.js';

import {
  BUILDINGS,
  KEEP_BUILD_SECONDS,
  KEEP_COUNT_LIMITS,
  MAX_KEEPS_PER_VILLAGE,
  OBSTACLES,
  requiredKeepFor,
  type BuildingBase,
  type Curve,
} from './balance.config.js';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** Applies one curve to a base value at `level`. */
function grow(base: number, curve: Curve, level: number): number {
  const raw = base * curve.growth ** (level - 1);
  if (curve.round === 'nearest10') {
    // "rounded to nearest 10" (S7.5). Floor at 10 so a cheap building never
    // rounds down to zero, which would make an upgrade free.
    return Math.max(10, Math.round(raw / 10) * 10);
  }
  return Math.round(raw);
}

/** Grows every resource in a cost/capacity map. */
function growAmount(base: ResourceAmount, curve: Curve, level: number): ResourceAmount {
  const out: ResourceAmount = {};
  for (const [resource, value] of Object.entries(base)) {
    if (value === undefined) continue;
    out[resource as ResourceId] = grow(value, curve, level);
  }
  return out;
}

function generateLevel(base: BuildingBase, level: number): BuildingLevel {
  const entry: BuildingLevel = {
    level,
    hp: grow(base.baseHp, base.curves.hp, level),
    cost: growAmount(base.baseCost, base.curves.cost, level),
    buildSeconds:
      base.id === 'keep'
        ? (KEEP_BUILD_SECONDS[level] ??
          grow(base.baseBuildSeconds, base.curves.buildSeconds, level))
        : grow(base.baseBuildSeconds, base.curves.buildSeconds, level),
    requiresKeep: base.id === 'keep' ? 1 : requiredKeepFor(base.id, level),
  };

  if (base.production !== undefined) {
    entry.produces = base.production.produces;
    entry.productionPerHour = grow(
      base.production.basePerHour,
      { growth: base.production.growth.perHour, round: 'none' },
      level,
    );
    entry.bufferCap = grow(
      base.production.baseBufferCap,
      { growth: base.production.growth.bufferCap, round: 'none' },
      level,
    );
  }

  if (base.storage !== undefined) {
    entry.storageCap = growAmount(
      base.storage.capacities,
      { growth: base.storage.growth, round: 'nearest10' },
      level,
    );
  }

  return entry;
}

function generateBuilding(base: BuildingBase): BuildingDef {
  const levels: BuildingLevel[] = [];
  for (let level = 1; level <= base.maxLevel; level += 1) {
    levels.push(generateLevel(base, level));
  }

  return {
    id: base.id,
    category: base.category,
    size: { w: base.size.w, h: base.size.h },
    unlock: { keepLevel: base.unlockKeep },
    levels,
  };
}

/** The quantity ceilings, emitted as the runtime config's `limits` block. */
export function generateLimits(): BuildingLimits {
  const buildingCounts: Record<string, number[]> = {};
  for (const [id, counts] of Object.entries(KEEP_COUNT_LIMITS)) {
    buildingCounts[id] = [...counts];
  }
  return { maxKeeps: MAX_KEEPS_PER_VILLAGE, buildingCounts };
}

export function generate(): {
  buildings: BuildingDef[];
  obstacles: ObstacleDef[];
  limits: BuildingLimits;
} {
  return {
    buildings: BUILDINGS.map(generateBuilding),
    obstacles: OBSTACLES.map((obstacle) => ({
      id: obstacle.id,
      size: { w: obstacle.size.w, h: obstacle.size.h },
      reward: { ...obstacle.reward },
      removalSeconds: obstacle.removalSeconds,
    })),
    limits: generateLimits(),
  };
}

/** Serialises with a fixed key order and 2-space indent, ending in one newline. */
export function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main(): void {
  const output = generate();
  writeFileSync(here('../data/buildings.json'), serialise(output.buildings), 'utf8');
  writeFileSync(here('../data/obstacles.json'), serialise(output.obstacles), 'utf8');
  writeFileSync(here('../data/limits.json'), serialise(output.limits), 'utf8');

  const totalLevels = output.buildings.reduce((sum, b) => sum + b.levels.length, 0);
  console.log(
    `gen-balance: wrote ${output.buildings.length} buildings (${totalLevels} levels), ` +
      `${output.obstacles.length} obstacles and ${Object.keys(output.limits.buildingCounts).length} limit rows`,
  );
}

// Only write when executed as a script, so importing this module from a test is
// side-effect free.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
