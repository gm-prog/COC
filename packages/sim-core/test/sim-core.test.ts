import { describe, expect, it } from 'vitest';
import { GRID, SIM_CORE_VERSION } from '../src/index';

describe('sim-core', () => {
  it('exposes a semantic version stamp', () => {
    expect(SIM_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('describes a 48x48 map with a 40x40 buildable core and a 4-tile margin', () => {
    expect(GRID.total).toBe(48);
    expect(GRID.buildable).toBe(40);
    expect(GRID.margin).toBe(4);
  });

  it('keeps the grid geometry self-consistent', () => {
    expect(GRID.buildable + GRID.margin * 2).toBe(GRID.total);
  });

  it('is frozen so no code path can mutate world geometry at runtime', () => {
    expect(Object.isFrozen(GRID)).toBe(true);
  });
});
