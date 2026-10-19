/**
 * Tile occupancy grid.
 *
 * A flat `Int32Array` of `total * total` cells; 0 means empty and any positive
 * value is the id of the entity occupying it. Pure geometry — it knows nothing
 * about buildings, obstacles or resources, so it stays trivially testable and
 * cheap to rebuild from a state snapshot.
 */

import type { GridGeometry } from '../config/geometry.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CellConflict {
  x: number;
  y: number;
  /** Id of the entity already occupying the cell, or 0 when the cell is outside the buildable core. */
  owner: number;
  reason: 'out_of_bounds' | 'margin' | 'occupied';
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
      grid.fill({ x: entry.x, y: entry.y, w: entry.w, h: entry.h }, entry.id);
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

  /** True when every cell of the rectangle is empty. */
  isFree(rect: Rect): boolean {
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

  /** Visits every cell of a rectangle in row-major order. */
  forEachCell(rect: Rect, visit: (x: number, y: number, owner: number) => void): void {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        if (!this.isInsideMap(x, y)) continue;
        visit(x, y, this.cells[this.index(x, y)] as number);
      }
    }
  }
}
