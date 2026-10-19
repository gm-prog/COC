/**
 * Tile occupancy grid.
 *
 * A flat `Int32Array` of `total * total` cells; 0 means empty and any positive
 * value is the id of the entity occupying it. Pure geometry — it knows nothing
 * about buildings, obstacles or resources, so it stays trivially testable and
 * cheap to rebuild from a state snapshot.
 */

import { assertValidGeometry, type GridGeometry } from '../config/geometry.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CellConflictReason =
  /** The rectangle itself is malformed; checked before anything else. */
  'invalid_rect' | 'out_of_bounds' | 'margin' | 'occupied';

export interface CellConflict {
  x: number;
  y: number;
  /** Id of the entity already occupying the cell, or 0 when the cell is outside the buildable core. */
  owner: number;
  reason: CellConflictReason;
}

/**
 * True when a rectangle is well-formed: a finite integer origin and a finite
 * positive integer size.
 *
 * `Number.isInteger` already rejects `NaN`, `±Infinity`, `undefined`, strings
 * and fractions, so this single predicate covers every malformed payload. It
 * matters because a loop over `{ x: NaN, w: 3 }` runs zero times and would
 * otherwise report "no conflict" for a rectangle that is not a rectangle.
 */
export function isValidRect(rect: Rect): boolean {
  return (
    Number.isInteger(rect.x) &&
    Number.isInteger(rect.y) &&
    Number.isInteger(rect.w) &&
    Number.isInteger(rect.h) &&
    rect.w > 0 &&
    rect.h > 0
  );
}

/** Axis-aligned rectangle overlap test (touching edges do not overlap). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export class OccupancyGrid {
  readonly width: number;
  readonly height: number;
  readonly geometry: GridGeometry;

  private readonly cells: Int32Array;
  private occupiedCount = 0;

  constructor(geometry: GridGeometry) {
    assertValidGeometry(geometry);
    this.geometry = geometry;
    this.width = geometry.total;
    this.height = geometry.total;
    this.cells = new Int32Array(geometry.total * geometry.total);
  }

  /** Rebuilds a grid from anything with an id and a footprint. */
  static fromEntries(
    geometry: GridGeometry,
    entries: readonly { id: number; x: number; y: number; w: number; h: number }[],
  ): OccupancyGrid {
    const grid = new OccupancyGrid(geometry);
    for (const entry of entries) {
      const rect = { x: entry.x, y: entry.y, w: entry.w, h: entry.h };
      if (!isValidRect(rect)) {
        throw new RangeError(
          `OccupancyGrid.fromEntries: entity ${entry.id} has a malformed rectangle ${JSON.stringify(rect)}`,
        );
      }
      grid.fill(rect, entry.id);
    }
    return grid;
  }

  private index(x: number, y: number): number {
    return y * this.width + x;
  }

  ownerAt(x: number, y: number): number {
    if (!this.isInsideMap(x, y)) return -1;
    return this.cells[this.index(x, y)] as number;
  }

  countOccupied(): number {
    return this.occupiedCount;
  }

  isInsideMap(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** True when the whole rectangle lies inside the buildable core. */
  isInsideBuildable(rect: Rect): boolean {
    return (
      rect.x >= this.geometry.margin &&
      rect.y >= this.geometry.margin &&
      rect.x + rect.w <= this.geometry.margin + this.geometry.buildable &&
      rect.y + rect.h <= this.geometry.margin + this.geometry.buildable
    );
  }

  /** True when every cell of the rectangle is empty. Never true for a malformed rect. */
  isFree(rect: Rect): boolean {
    if (!isValidRect(rect)) return false;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        if (!this.isInsideMap(x, y)) return false;
        if ((this.cells[this.index(x, y)] as number) !== 0) return false;
      }
    }
    return true;
  }

  /**
   * The first reason the rectangle cannot be placed, or null when it can.
   * Ordering matters for error messages: bounds, then margin, then occupancy.
   */
  findConflict(rect: Rect): CellConflict | null {
    // A malformed rectangle cannot be bounds-checked meaningfully, so it is
    // rejected first and reported with its own coordinates.
    if (!isValidRect(rect)) return { x: rect.x, y: rect.y, owner: 0, reason: 'invalid_rect' };

    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        if (!this.isInsideMap(x, y)) return { x, y, owner: 0, reason: 'out_of_bounds' };
      }
    }
    if (!this.isInsideBuildable(rect)) {
      // Report the first cell that falls in the margin.
      for (let y = rect.y; y < rect.y + rect.h; y += 1) {
        for (let x = rect.x; x < rect.x + rect.w; x += 1) {
          if (
            x < this.geometry.margin ||
            y < this.geometry.margin ||
            x >= this.geometry.margin + this.geometry.buildable ||
            y >= this.geometry.margin + this.geometry.buildable
          ) {
            return { x, y, owner: 0, reason: 'margin' };
          }
        }
      }
    }
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        const owner = this.cells[this.index(x, y)] as number;
        if (owner !== 0) return { x, y, owner, reason: 'occupied' };
      }
    }
    return null;
  }

  canPlace(rect: Rect): boolean {
    return this.findConflict(rect) === null;
  }

  /** Marks every cell of the rectangle as owned by `id`. */
  fill(rect: Rect, id: number): void {
    if (!isValidRect(rect)) {
      throw new RangeError(
        `OccupancyGrid.fill: rectangle must have finite integer origin and positive integer size, received ${JSON.stringify(rect)}`,
      );
    }
    if (!Number.isInteger(id) || id <= 0) {
      throw new RangeError(`OccupancyGrid.fill: owner id must be a positive integer, got ${id}`);
    }
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        if (!this.isInsideMap(x, y)) {
          throw new RangeError(`OccupancyGrid.fill: (${x},${y}) is outside the map`);
        }
        const cell = this.index(x, y);
        if ((this.cells[cell] as number) === 0) this.occupiedCount += 1;
        this.cells[cell] = id;
      }
    }
  }

  /** Clears the rectangle. Pass `expectedOwner` to assert ownership first. */
  clear(rect: Rect, expectedOwner?: number): void {
    if (!isValidRect(rect)) {
      throw new RangeError(
        `OccupancyGrid.clear: rectangle must have finite integer origin and positive integer size, received ${JSON.stringify(rect)}`,
      );
    }
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        if (!this.isInsideMap(x, y)) continue;
        const cell = this.index(x, y);
        const current = this.cells[cell] as number;
        if (current === 0) continue;
        if (expectedOwner !== undefined && current !== expectedOwner) {
          throw new RangeError(
            `OccupancyGrid.clear: cell (${x},${y}) is owned by ${current}, expected ${expectedOwner}`,
          );
        }
        this.cells[cell] = 0;
        this.occupiedCount -= 1;
      }
    }
  }

  /** Visits every cell of a rectangle in row-major order. No-op for a malformed rect. */
  forEachCell(rect: Rect, visit: (x: number, y: number, owner: number) => void): void {
    if (!isValidRect(rect)) return;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        if (!this.isInsideMap(x, y)) continue;
        visit(x, y, this.cells[this.index(x, y)] as number);
      }
    }
  }
}
