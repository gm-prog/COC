/**
 * @coc/game-data — every tunable number in Emberhold lives here, never in logic.
 *
 * Phase 0 only stamps the config version. The actual tables (Keep levels,
 * buildings, troops, spells, traps) and `scripts/gen-balance.ts` arrive in
 * Phase 1/2; consumers must always read numbers from this package rather than
 * hard-coding them.
 */

/** Current balance/config version. Stored on player state and every battle. */
export const CONFIG_VERSION = '0.1.0' as const;

export type ConfigVersion = typeof CONFIG_VERSION;

/**
 * The set of resources defined by the design (Section 7.2).
 * Kept here (not in sim-core) because it is balance data, not a rule.
 */
export const RESOURCE_IDS = ['gold', 'essence', 'shards', 'gems'] as const;

export type ResourceId = (typeof RESOURCE_IDS)[number];
