import { describe, expect, it } from 'vitest';
import { GRID } from '../src/config/geometry.js';
import { OccupancyGrid, rectContains, rectsOverlap, type Rect } from '../src/grid/index.js';

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe('rect helpers', () => {
  it('detects overlap but not touching edges', () => {
    expect(rectsOverlap(rect(0, 0, 3, 3), rect(2, 2, 3, 3))).toBe(true);
    expect(rectsOverlap(rect(0, 0, 3, 3), rect(3, 0, 3, 3))).toBe(false);
    expect(rectsOverlap(rect(0, 0, 3, 3), rect(0, 3, 3, 3))).toBe(false);
    expect(rectsOverlap(rect(0, 0, 3, 3), rect(-1, 0, 2, 3))).toBe(true);
  });

  it('detects containment', () => {
    expect(rectContains(rect(0, 0, 10, 10), rect(2, 2, 3, 3))).toBe(true);
    expect(rectContains(rect(0, 0, 10, 10), rect(8, 8, 3, 3))).toBe(false);
  });
});

describe('OccupancyGrid', () => {
  it('tracks owners and the occupied count', () => {
    const grid = OccupancyGrid.fromEntries(GRID, [
      { id: 1, x: 4, y: 4, w: 3, h: 3 },
      { id: 2, x: 20, y: 20, w: 1, h: 1 },
    ]);

    expect(grid.countOccupied()).toBe(10);
    expect(grid.ownerAt(4, 4)).toBe(1);
    expect(grid.ownerAt(6, 6)).toBe(1);
    expect(grid.ownerAt(20, 20)).toBe(2);
    expect(grid.ownerAt(7, 7)).toBe(0);
    expect(grid.ownerAt(-1, 0)).toBe(-1);
    expect(grid.ownerAt(0, 99)).toBe(-1);
  });

  it('reports out_of_bounds before anything else', () => {
    const grid = new OccupancyGrid(GRID);
    const conflict = grid.findConflict(rect(45, 45, 4, 4));
    // Row-major scan: row 45 is walked first, and x=48 is the first cell off-map.
    expect(conflict).toEqual({ x: 48, y: 45, owner: 0, reason: 'out_of_bounds' });
    expect(grid.findConflict(rect(-1, 10, 3, 3))).toMatchObject({ reason: 'out_of_bounds' });
  });

  it('finds a margin cell that is not the first cell of the footprint', () => {
    const grid = new OccupancyGrid(GRID);
    // (43,4) is the last buildable column, so the first cell passes and the
    // second one is what the margin scan has to find.
    expect(grid.findConflict(rect(43, 4, 2, 1))).toMatchObject({ reason: 'margin', x: 44, y: 4 });
    expect(grid.findConflict(rect(4, 43, 1, 2))).toMatchObject({ reason: 'margin', x: 4, y: 44 });
  });

  it('reports the margin for footprints crossing into it', () => {
    const grid = new OccupancyGrid(GRID);
    const conflict = grid.findConflict(rect(2, 10, 3, 3));
    expect(conflict).toMatchObject({ reason: 'margin', x: 2, y: 10 });
    expect(grid.findConflict(rect(43, 43, 3, 3))).toMatchObject({ reason: 'margin' });
  });

  it('reports the occupying entity id on overlap', () => {
    const grid = OccupancyGrid.fromEntries(GRID, [{ id: 7, x: 10, y: 10, w: 3, h: 3 }]);
    const conflict = grid.findConflict(rect(11, 11, 3, 3));
    expect(conflict).toMatchObject({ reason: 'occupied', owner: 7, x: 11, y: 11 });
    expect(grid.canPlace(rect(11, 11, 3, 3))).toBe(false);
    expect(grid.canPlace(rect(13, 13, 3, 3))).toBe(true);
  });

  it('accepts a footprint that exactly fills the buildable core', () => {
    const grid = new OccupancyGrid(GRID);
    const full = rect(GRID.margin, GRID.margin, GRID.buildable, GRID.buildable);
    expect(grid.isInsideBuildable(full)).toBe(true);
    expect(grid.canPlace(full)).toBe(true);

    grid.fill(full, 1);
    expect(grid.countOccupied()).toBe(GRID.buildable * GRID.buildable);
    expect(grid.canPlace(rect(4, 4, 1, 1))).toBe(false);
  });

  it('rejects a footprint one tile past the buildable edge', () => {
    const grid = new OccupancyGrid(GRID);
    // A 1x1 building on the very last buildable tile is fine...
    expect(grid.canPlace(rect(43, 43, 1, 1))).toBe(true);
    // ...and one tile further is in the margin.
    expect(grid.canPlace(rect(44, 43, 1, 1))).toBe(false);
    expect(grid.findConflict(rect(44, 43, 1, 1))).toMatchObject({ reason: 'margin' });
  });

  it('allows walls to be placed adjacent to each other and to buildings', () => {
    const grid = OccupancyGrid.fromEntries(GRID, [{ id: 1, x: 10, y: 10, w: 3, h: 3 }]);
    // A wall line hugging the building's south edge.
    expect(grid.canPlace(rect(10, 13, 3, 1))).toBe(true);
    grid.fill(rect(10, 13, 3, 1), 2);
    // Adjacent walls in the same line.
    expect(grid.canPlace(rect(13, 13, 1, 1))).toBe(true);
    // But not on top of the building or the existing wall.
    expect(grid.canPlace(rect(11, 11, 1, 1))).toBe(false);
    expect(grid.canPlace(rect(11, 13, 1, 1))).toBe(false);
  });

  it('clears a rectangle and validates ownership', () => {
    const grid = OccupancyGrid.fromEntries(GRID, [{ id: 5, x: 10, y: 10, w: 3, h: 3 }]);
    grid.clear(rect(11, 11, 1, 1));
    expect(grid.ownerAt(11, 11)).toBe(0);
    expect(grid.countOccupied()).toBe(8);

    expect(() => grid.clear(rect(10, 10, 3, 3), 99)).toThrow(RangeError);
    grid.clear(rect(10, 10, 3, 3), 5);
    expect(grid.countOccupied()).toBe(0);
  });

  it('visits cells in row-major order and skips cells outside the map', () => {
    const grid = OccupancyGrid.fromEntries(GRID, [{ id: 3, x: 4, y: 4, w: 2, h: 2 }]);
    const visited: string[] = [];
    grid.forEachCell(rect(4, 4, 2, 2), (x, y, owner) => visited.push(`${x},${y}:${owner}`));
    expect(visited).toEqual(['4,4:3', '5,4:3', '4,5:3', '5,5:3']);

    const outside: string[] = [];
    grid.forEachCell(rect(-1, -1, 2, 2), (x, y) => outside.push(`${x},${y}`));
    expect(outside).toEqual(['0,0']);
  });

  it('refuses to fill outside the map or with an invalid owner', () => {
    const grid = new OccupancyGrid(GRID);
    expect(() => grid.fill(rect(47, 47, 2, 2), 1)).toThrow(RangeError);
    expect(() => grid.fill(rect(10, 10, 1, 1), 0)).toThrow(RangeError);
    expect(() => grid.fill(rect(10, 10, 1, 1), -1)).toThrow(RangeError);
  });
});

describe('isFree', () => {
  it('reports a rectangle that leaves the map as not free', () => {
    const grid = new OccupancyGrid(GRID);
    expect(grid.isFree(rect(47, 47, 2, 2))).toBe(false);
    expect(grid.isFree(rect(-1, 10, 3, 3))).toBe(false);
  });

  it('reports an occupied rectangle as not free', () => {
    const grid = OccupancyGrid.fromEntries(GRID, [{ id: 1, x: 10, y: 10, w: 2, h: 2 }]);
    expect(grid.isFree(rect(11, 11, 1, 1))).toBe(false);
    expect(grid.isFree(rect(12, 12, 1, 1))).toBe(true);
  });

  it('reports an empty rectangle as free', () => {
    const grid = new OccupancyGrid(GRID);
    expect(grid.isFree(rect(0, 0, 1, 1))).toBe(true);
  });
});
