/**
 * @coc/game-data — every tunable number in Emberhold.
 *
 * The JSON files in `data/` are the authored source of truth; `scripts/`
 * (Phase 2) will generate the level tables from curves. Nothing in here contains
 * a rule: it only carries data that `@coc/sim-core` validates and applies.
 */

import { validateGameConfig, type GameConfig } from '@coc/sim-core';

import buildings from '../data/buildings.json';
import economy from '../data/economy.json';
import limits from '../data/limits.json';
import obstacles from '../data/obstacles.json';
import starter from '../data/starter.json';

import { CONFIG_VERSION } from './version.js';

export { CONFIG_VERSION, type ConfigVersion } from './version.js';
export { RESOURCE_IDS, type ResourceId } from '@coc/sim-core';

/** The raw authored tables, before validation. Exported for tooling and tests. */
export const rawConfig = {
  version: CONFIG_VERSION,
  buildings,
  obstacles,
  starter,
  economy,
  limits,
} as const;

/**
 * The validated config every consumer should use.
 *
 * Validation runs at module load, so a bad balance table breaks the app
 * immediately with a readable error instead of surfacing as a weird bug three
 * phases later.
 */
export const GAME_CONFIG: GameConfig = validateGameConfig(rawConfig);

/** Re-validates raw data (used by tests and the balance simulator). */
export function loadGameConfig(raw: unknown): GameConfig {
  return validateGameConfig(raw);
}

/** Convenience lookup helpers. */
export function getBuildingDef(config: GameConfig, id: string) {
  return config.buildings.find((building) => building.id === id);
}

export function getBuildingLevel(config: GameConfig, id: string, level: number) {
  const def = getBuildingDef(config, id);
  return def?.levels.find((entry) => entry.level === level);
}

export function getObstacleDef(config: GameConfig, id: string) {
  return config.obstacles.find((obstacle) => obstacle.id === id);
}
