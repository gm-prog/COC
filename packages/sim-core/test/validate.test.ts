import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  validateBuildingDefs,
  validateGameConfig,
} from '../src/validate/index.js';
import { NOW, TEST_CONFIG } from './fixtures/config.js';

/** Loosely typed on purpose: most of these tests mutate it into invalid shapes. */
const minimal = (): any => ({
  version: '1.0.0',
  buildings: [
    {
      id: 'keep',
      category: 'hq',
      size: { w: 4, h: 4 },
      unlock: { keepLevel: 1 },
      levels: [{ level: 1, hp: 100, cost: {}, buildSeconds: 0, requiresKeep: 1 }],
    },
  ],
  obstacles: [],
  starter: {
    resources: { gold: 0, essence: 0, shards: 0, gems: 0 },
    builders: 2,
    buildings: [{ type: 'keep', level: 1, x: 0, y: 0 }],
    obstacles: [],
  },
});

const issuesFor = (raw: unknown): string => {
  try {
    validateGameConfig(raw);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.issues.join(' | ');
    throw error;
  }
  return '';
};

describe('validateGameConfig', () => {
  it('accepts the test fixture', () => {
    expect(validateGameConfig(TEST_CONFIG)).toEqual(TEST_CONFIG);
  });

  it('defaults cost to an empty amount when omitted', () => {
    const config = validateGameConfig(minimal());
    expect(config.buildings[0]?.levels[0]?.cost).toEqual({});
  });

  it('rejects a non-object config', () => {
    expect(() => validateGameConfig('nope')).toThrow(ConfigValidationError);
    expect(() => validateGameConfig(null)).toThrow(ConfigValidationError);
  });

  it('rejects an unknown top-level key', () => {
    const raw = { ...minimal(), surprise: true };
    expect(issuesFor(raw)).toContain('surprise');
  });

  it('rejects an unknown key inside a building level', () => {
    const raw = minimal();
    raw.buildings[0]!.levels[0] = { ...raw.buildings[0]!.levels[0]!, teleports: true } as never;
    expect(issuesFor(raw)).toContain('teleports');
  });

  it('rejects an unknown resource name in a cost', () => {
    const raw = minimal();
    raw.buildings[0]!.levels[0] = {
      ...raw.buildings[0]!.levels[0]!,
      cost: { plutonium: 5 },
    } as never;
    expect(issuesFor(raw)).toContain('plutonium');
  });

  it('rejects a negative cost', () => {
    const raw = minimal();
    raw.buildings[0]!.levels[0] = {
      ...raw.buildings[0]!.levels[0]!,
      cost: { gold: -1 },
    } as never;
    expect(issuesFor(raw)).toMatch(/gold|nonnegative|expected/i);
  });

  it('rejects a non-snake_case building id', () => {
    const raw = minimal();
    raw.buildings[0]!.id = 'Gold Mine';
    expect(issuesFor(raw)).toContain('snake_case');
  });

  it('rejects an unknown building category and names the offending value', () => {
    const raw = minimal();
    raw.buildings[0]!.category = 'kitchen_sink';
    expect(issuesFor(raw)).toContain('kitchen_sink');
  });

  it('rejects a zero-sized building', () => {
    const raw = minimal();
    raw.buildings[0]!.size = { w: 0, h: 3 };
    expect(issuesFor(raw)).toMatch(/size\.w/);
    expect(issuesFor(raw)).toMatch(/>\s*0/);
  });

  it('rejects an empty buildings table', () => {
    const raw = { ...minimal(), buildings: [] };
    expect(issuesFor(raw)).toMatch(/buildings/);
    expect(issuesFor(raw)).toMatch(/>=1 items/);
  });

  it('reports duplicate building ids', () => {
    const raw = minimal();
    raw.buildings.push({ ...raw.buildings[0]! });
    expect(issuesFor(raw)).toContain('duplicate building id "keep"');
  });

  it('reports non-contiguous levels', () => {
    const raw = minimal();
    raw.buildings[0]!.levels = [
      { level: 1, hp: 100, cost: {}, buildSeconds: 0, requiresKeep: 1 },
      { level: 3, hp: 200, cost: {}, buildSeconds: 0, requiresKeep: 1 },
    ];
    expect(issuesFor(raw)).toContain('contiguous');
  });

  it('reports out-of-order levels', () => {
    const raw = minimal();
    raw.buildings[0]!.levels = [
      { level: 2, hp: 100, cost: {}, buildSeconds: 0, requiresKeep: 1 },
      { level: 1, hp: 100, cost: {}, buildSeconds: 0, requiresKeep: 1 },
    ];
    expect(issuesFor(raw)).toContain('out-of-order');
  });

  it('allows a higher level to require a higher Keep than the building unlock', () => {
    // The unlock gate says when the *building type* appears; levels may demand
    // more. This is exactly the gold_mine pattern in the real tables.
    const raw = minimal();
    raw.buildings[0]!.unlock = { keepLevel: 1 };
    raw.buildings[0]!.levels = [
      { level: 1, hp: 100, cost: {}, buildSeconds: 0, requiresKeep: 1 },
      { level: 2, hp: 200, cost: {}, buildSeconds: 0, requiresKeep: 4 },
    ];
    expect(issuesFor(raw)).toBe('');
  });

  it('reports a level 1 that requires a higher Keep than the building unlock', () => {
    const raw = minimal();
    raw.buildings[0]!.unlock = { keepLevel: 1 };
    raw.buildings[0]!.levels = [{ level: 1, hp: 100, cost: {}, buildSeconds: 0, requiresKeep: 3 }];
    expect(issuesFor(raw)).toContain('level 1 requires Keep 3');
  });

  it('reports a Keep requirement that falls between levels', () => {
    const raw = minimal();
    raw.buildings[0]!.levels = [
      { level: 1, hp: 100, cost: {}, buildSeconds: 0, requiresKeep: 2 },
      { level: 2, hp: 200, cost: {}, buildSeconds: 0, requiresKeep: 1 },
    ];
    expect(issuesFor(raw)).toContain("below level 1's Keep 2");
  });

  it('reports rangeMax below rangeMin', () => {
    const raw = minimal();
    raw.buildings[0]!.levels[0] = {
      ...raw.buildings[0]!.levels[0]!,
      rangeMin: 9,
      rangeMax: 2,
    } as never;
    expect(issuesFor(raw)).toContain('rangeMax');
  });

  it('reports a starter building that is not defined', () => {
    const raw = minimal();
    raw.starter.buildings.push({ type: 'dragon_pit', level: 1, x: 20, y: 20 });
    expect(issuesFor(raw)).toContain('dragon_pit');
  });

  it('reports a starter building at an undefined level', () => {
    const raw = minimal();
    raw.starter.buildings[0] = { type: 'keep', level: 9, x: 0, y: 0 };
    expect(issuesFor(raw)).toContain('undefined level 9');
  });

  it('reports a starter obstacle that is not defined', () => {
    const raw = minimal();
    raw.starter.obstacles.push({ type: 'cactus', x: 5, y: 5 });
    expect(issuesFor(raw)).toContain('cactus');
  });

  it('requires exactly one Keep in the starter layout', () => {
    const raw = minimal();
    raw.starter.buildings = [];
    expect(issuesFor(raw)).toContain('exactly one Keep');

    const two = minimal();
    two.starter.buildings.push({ type: 'keep', level: 1, x: 20, y: 20 });
    expect(issuesFor(two)).toContain('exactly one Keep');
  });

  it('defaults the obstacle table and the starter obstacle list to empty arrays', () => {
    const raw = minimal();
    delete (raw as Record<string, unknown>).obstacles;
    raw.starter.obstacles = undefined as never;
    const config = validateGameConfig(raw as never);
    expect(config.obstacles).toEqual([]);
    expect(config.starter.obstacles).toEqual([]);
    // The starter buildings that were written survive untouched.
    expect(config.starter.buildings).toEqual([{ type: 'keep', level: 1, x: 0, y: 0 }]);
  });

  it('still requires exactly one Keep once the lists default away', () => {
    const raw = minimal();
    raw.starter.buildings = undefined as never;
    expect(issuesFor(raw)).toContain('exactly one Keep');
  });

  it('requires a starter section', () => {
    const raw = minimal();
    delete (raw as Record<string, unknown>).starter;
    expect(issuesFor(raw)).toMatch(/starter/);
  });

  it('lists every structural problem it found in one error', () => {
    const raw = minimal();
    raw.buildings[0]!.id = 'Bad Id';
    raw.buildings[0]!.category = 'kitchen_sink';
    raw.buildings[0]!.size = { w: 0, h: 0 };
    raw.buildings[0]!.levels[0]!.cost = { gold: -5 };

    let caught: ConfigValidationError | undefined;
    try {
      validateGameConfig(raw);
    } catch (error) {
      caught = error as ConfigValidationError;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught?.issues.length).toBeGreaterThanOrEqual(4);
    expect(caught?.message).toContain('Invalid game config');
    // One header line plus one line per issue.
    expect(caught?.message.split('\n').length).toBeGreaterThanOrEqual(5);
  });

  it('names the offending value in the message', () => {
    const raw = minimal();
    raw.buildings[0]!.id = 'Gold Mine';
    expect(issuesFor(raw)).toContain('"Gold Mine"');
  });

  it('runs semantic checks once the structure is valid', () => {
    const raw = minimal();
    raw.buildings.push({ ...raw.buildings[0]! });
    raw.starter.obstacles.push({ type: 'ghost', x: 1, y: 1 });

    const issues = issuesFor(raw);
    expect(issues).toContain('duplicate building id "keep"');
    expect(issues).toContain('ghost');
  });

  it('keeps the fixture time-independent', () => {
    expect(NOW).toBe(1_800_000_000_000);
  });
});

describe('validateBuildingDefs', () => {
  it('validates a bare array of buildings', () => {
    const defs = validateBuildingDefs(TEST_CONFIG.buildings);
    expect(defs).toHaveLength(TEST_CONFIG.buildings.length);
  });

  it('throws on a malformed array', () => {
    expect(() => validateBuildingDefs([{ id: 'x' }])).toThrow(ConfigValidationError);
  });
});
