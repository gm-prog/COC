import { describe, expect, it } from 'vitest';
import {
  assertValidGeometry,
  GRID,
  isBuildableTile,
  isMapTile,
  type GridGeometry,
} from '../src/config/geometry.js';

const valid = (overrides: Partial<GridGeometry> = {}): GridGeometry => ({
  total: 48,
  buildable: 40,
  margin: 4,
  ...overrides,
});

describe('GRID', () => {
  it('describes the 48x48 map with a 40x40 buildable core', () => {
    expect(GRID).toEqual({ total: 48, buildable: 40, margin: 4 });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(GRID)).toBe(true);
  });

  it('passes its own validation', () => {
    expect(() => assertValidGeometry(GRID)).not.toThrow();
  });
});

describe('assertValidGeometry', () => {
  it('rejects a non-integer or non-positive total', () => {
    expect(() => assertValidGeometry(valid({ total: 0 }))).toThrow(/total/);
    expect(() => assertValidGeometry(valid({ total: 4.5 }))).toThrow(/total/);
  });

  it('rejects a non-integer or non-positive buildable area', () => {
    expect(() => assertValidGeometry(valid({ buildable: 0 }))).toThrow(/buildable/);
    expect(() => assertValidGeometry(valid({ buildable: -1 }))).toThrow(/buildable/);
  });

  it('rejects a buildable area larger than the map', () => {
    expect(() => assertValidGeometry(valid({ buildable: 50 }))).toThrow(/must not exceed/);
  });

  it('rejects a margin that does not match the sizes', () => {
    expect(() => assertValidGeometry(valid({ margin: 5 }))).toThrow(/margin/);
    // Odd difference leaves a fractional margin.
    expect(() => assertValidGeometry(valid({ total: 49, buildable: 40, margin: 5 }))).toThrow(
      /margin/,
    );
  });

  it('accepts other consistent geometries', () => {
    expect(() => assertValidGeometry(valid({ total: 24, buildable: 24, margin: 0 }))).not.toThrow();
    expect(() => assertValidGeometry(valid({ total: 60, buildable: 44, margin: 8 }))).not.toThrow();
  });
});

describe('tile predicates', () => {
  it('knows which tiles are on the map', () => {
    expect(isMapTile(GRID, 0, 0)).toBe(true);
    expect(isMapTile(GRID, 47, 47)).toBe(true);
    expect(isMapTile(GRID, 48, 0)).toBe(false);
    expect(isMapTile(GRID, -1, 0)).toBe(false);
  });

  it('knows which tiles are buildable', () => {
    expect(isBuildableTile(GRID, 4, 4)).toBe(true);
    expect(isBuildableTile(GRID, 43, 43)).toBe(true);
    expect(isBuildableTile(GRID, 3, 4)).toBe(false);
    expect(isBuildableTile(GRID, 44, 4)).toBe(false);
    expect(isBuildableTile(GRID, 4, 3)).toBe(false);
    expect(isBuildableTile(GRID, 4, 44)).toBe(false);
  });
});
