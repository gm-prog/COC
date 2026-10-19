/**
 * @coc/sim-core — the single deterministic rules core for Emberhold.
 *
 * Everything the client, server, replays, AI and tests need to agree on lives
 * here. Phase 0 only lays down the invariants that the rest of the game hangs
 * off (world/grid geometry + version stamps); the real modules land in Phase 1
 * (math, rng, grid, state, commands), Phase 2 (economy) and Phase 5 (battle).
 *
 * Hard rules for this package (Section 6.4 of docs/GAME_SPEC.md):
 *   - no DOM, no Node APIs, no `Date.now()`, no `Math.random()`
 *   - integer / fixed-point math only (1 tile = 1,000 sim units)
 *   - stable iteration order (ascending numeric id)
 */

/** Version of the rules in this package. Bump on any behaviour change. */
export const SIM_CORE_VERSION = '0.1.0' as const;

/**
 * World geometry.
 *
 * The map is a square tile grid. `total` includes the decorative margin;
 * `buildable` is the area the player may place buildings in. Rendering is
 * isometric 2:1, but nothing in this package knows about screen space.
 */
export interface GridGeometry {
  /** Total map size in tiles (including margin). */
  readonly total: number;
  /** Buildable area size in tiles. */
  readonly buildable: number;
  /** Decorative margin in tiles on each side: (total - buildable) / 2. */
  readonly margin: number;
}

export const GRID: GridGeometry = Object.freeze({
  total: 48,
  buildable: 40,
  margin: 4,
});
