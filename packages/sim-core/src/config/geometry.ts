/**
 * World geometry.
 *
 * The map is a square tile grid: a decorative margin wrapped around a buildable
 * core. Everything here is pure data — rendering lives in the client and must
 * never feed back into these numbers.
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

export function assertValidGeometry(geometry: GridGeometry): void {
  if (!Number.isInteger(geometry.total) || geometry.total <= 0) {
    throw new RangeError(`grid.total must be a positive integer, received ${geometry.total}`);
  }
  if (!Number.isInteger(geometry.buildable) || geometry.buildable <= 0) {
    throw new RangeError(
      `grid.buildable must be a positive integer, received ${geometry.buildable}`,
    );
  }
  if (geometry.buildable > geometry.total) {
    throw new RangeError('grid.buildable must not exceed grid.total');
  }
  const expectedMargin = (geometry.total - geometry.buildable) / 2;
  if (!Number.isInteger(expectedMargin) || geometry.margin !== expectedMargin) {
    throw new RangeError(
      `grid.margin must equal (total - buildable) / 2 = ${expectedMargin}, received ${geometry.margin}`,
    );
  }
}

/** True when the tile lies inside the buildable core (not in the margin). */
export function isBuildableTile(geometry: GridGeometry, x: number, y: number): boolean {
  return (
    x >= geometry.margin &&
    y >= geometry.margin &&
    x < geometry.margin + geometry.buildable &&
    y < geometry.margin + geometry.buildable
  );
}

/** True when the tile lies anywhere on the map. */
export function isMapTile(geometry: GridGeometry, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < geometry.total && y < geometry.total;
}
