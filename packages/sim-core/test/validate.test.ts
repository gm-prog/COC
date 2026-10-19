import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  checkEconomy,
  checkSemantics,
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
    // A 4x4 Keep must sit wholly inside the buildable core, so (0,0) — which
    // would hang it into the decorative margin — is not a legal starter.
    buildings: [{ type: 'keep', level: 1, x: 18, y: 18 }],
    obstacles: [],
  },
  // Cloned: several suites below mutate the economy block, and a shared object
  // would leak those edits into every later test.
  economy: JSON.parse(JSON.stringify(ECONOMY)),
  limits: {
    maxKeeps: 1,
    // Long enough for the level-table tests below, which rewrite the Keep's
    // levels up to level 6.
    buildingCounts: { keep: [0, 1, 1, 1, 1, 1, 1, 1] },
  },
});

/** A valid economy block, shared by the fixtures that need one. */
const ECONOMY = {
  speedUp: {
    anchors: [
      { seconds: 60, gems: 1 },
      { seconds: 3600, gems: 20 },
      { seconds: 86400, gems: 260 },
      { seconds: 604800, gems: 1000 },
    ],
    minimumGems: 1,
  },
  builders: { maxBuilders: 5, costs: [{ gems: 250 }, { gems: 500 }, { gems: 1000 }] },
  cancelRefund: { startedUpgrade: 0, queuedItem: 0.5 },
  msPerHour: 3_600_000,
};

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
    expect(issuesFor(raw)).toContain('contiguous');
  });

  // --- A1 regression: a level table must begin at level 1 -------------------
  // A table that merely happens to be contiguous — [2] or [2, 3] — used to pass
  // every check, which made level 1 unreachable and every later level's cost
  // index wrong. The single rule below replaces the two weaker ones.
  const badTable = (levels: number[]): string[] => {
    const raw = minimal();
    raw.buildings[0]!.levels = levels.map((level) => ({
      level,
      hp: 100,
      cost: {},
      buildSeconds: 0,
      requiresKeep: 1,
    }));
    return issuesFor(raw)
      .split(' | ')
      .filter((issue) => issue.length > 0);
  };

  it('rejects a single-level table that starts at 2', () => {
    const issues = badTable([2]);
    expect(issues).toContain(
      'building "keep" levels must start at 1 and be contiguous ascending, got [2]',
    );
  });

  it('rejects a contiguous table that starts at 2', () => {
    const issues = badTable([2, 3]);
    expect(issues).toContain(
      'building "keep" levels must start at 1 and be contiguous ascending, got [2, 3]',
    );
  });

  it('rejects a table that starts at 3', () => {
    expect(badTable([3, 4, 5])).toContain(
      'building "keep" levels must start at 1 and be contiguous ascending, got [3, 4, 5]',
    );
  });

  it('rejects duplicate levels', () => {
    expect(badTable([1, 1, 2])).toContain(
      'building "keep" levels must start at 1 and be contiguous ascending, got [1, 1, 2]',
    );
  });

  it('names the building and the supplied sequence in the message', () => {
    const raw = minimal();
    raw.buildings[0]!.id = 'gold_mine';
    raw.starter.buildings[0]!.type = 'gold_mine';
    raw.buildings[0]!.levels = [
      { level: 2, hp: 100, cost: {}, buildSeconds: 0, requiresKeep: 1 },
      { level: 4, hp: 100, cost: {}, buildSeconds: 0, requiresKeep: 1 },
    ];
    expect(issuesFor(raw)).toContain(
      'building "gold_mine" levels must start at 1 and be contiguous ascending, got [2, 4]',
    );
  });

  it('reports exactly one level complaint per broken table', () => {
    // The old out-of-order and contiguity checks could both fire for the same
    // table, doubling the noise without adding information.
    const issues = badTable([2, 4]);
    expect(issues.filter((issue) => issue.includes('contiguous ascending'))).toHaveLength(1);
  });

  it('still accepts well-formed tables', () => {
    expect(badTable([1])).toEqual([]);
    expect(badTable([1, 2])).toEqual([]);
    expect(badTable([1, 2, 3, 4, 5, 6])).toEqual([]);
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
    expect(config.starter.buildings).toEqual([{ type: 'keep', level: 1, x: 18, y: 18 }]);
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

describe('economy block', () => {
  /** The fixture config with its economy block patched. */
  const withEconomy = (
    patch: Record<string, unknown>,
  ): ReturnType<typeof checkEconomy> extends never ? never : any => {
    const config = JSON.parse(JSON.stringify(TEST_CONFIG)) as typeof TEST_CONFIG;
    Object.assign(config.economy, patch);
    return config;
  };

  const economyIssues = (patch: Record<string, unknown>): string[] =>
    checkEconomy(withEconomy(patch));

  it('accepts the fixture economy block', () => {
    expect(economyIssues({})).toEqual([]);
  });

  it('rejects speed-up anchors that are not strictly ascending', () => {
    expect(
      economyIssues({
        speedUp: {
          anchors: [
            { seconds: 3600, gems: 20 },
            { seconds: 3600, gems: 30 },
          ],
          minimumGems: 1,
        },
      }),
    ).toContain(
      'economy.speedUp.anchors must be strictly ascending by seconds, got 3600 then 3600',
    );
  });

  it('rejects speed-up anchors whose gem price decreases', () => {
    expect(
      economyIssues({
        speedUp: {
          anchors: [
            { seconds: 60, gems: 30 },
            { seconds: 3600, gems: 20 },
          ],
          minimumGems: 1,
        },
      }),
    ).toContain('economy.speedUp.anchors must be non-decreasing by gems, got 30 then 20');
  });

  it('rejects a minimum above the cheapest anchor', () => {
    expect(
      economyIssues({
        speedUp: {
          anchors: [
            { seconds: 60, gems: 5 },
            { seconds: 3600, gems: 20 },
          ],
          minimumGems: 6,
        },
      }),
    ).toContain('economy.speedUp.minimumGems (6) exceeds the cheapest anchor (5)');
  });

  it('accepts a minimum equal to the cheapest anchor', () => {
    expect(
      economyIssues({
        speedUp: {
          anchors: [
            { seconds: 60, gems: 5 },
            { seconds: 3600, gems: 20 },
          ],
          minimumGems: 5,
        },
      }),
    ).toEqual([]);
  });

  it('tolerates an anchor list with no first entry', () => {
    // An empty list is a schema violation, but the semantic check must not crash.
    expect(() => economyIssues({ speedUp: { anchors: [], minimumGems: 1 } })).not.toThrow();
  });

  it('rejects a builder maximum below the starter count', () => {
    expect(economyIssues({ builders: { maxBuilders: 1, costs: [{ gems: 250 }] } })).toContain(
      'economy.builders.maxBuilders (1) is below the starter builder count (2)',
    );
  });

  it('rejects a builder price that is not positive', () => {
    expect(economyIssues({ builders: { maxBuilders: 5, costs: [{ gems: 0 }] } })).toContain(
      'economy.builders.costs[0].gems must be positive, received 0',
    );
    expect(economyIssues({ builders: { maxBuilders: 5, costs: [{ gems: -5 }] } })).toContain(
      'economy.builders.costs[0].gems must be positive, received -5',
    );
  });

  it('rejects an empty builder price', () => {
    expect(economyIssues({ builders: { maxBuilders: 5, costs: [{}] } })).toContain(
      'economy.builders.costs[0] is empty',
    );
  });

  it('rejects a refund fraction outside [0, 1]', () => {
    expect(economyIssues({ cancelRefund: { startedUpgrade: 1.5, queuedItem: 0.5 } })).toContain(
      'economy.cancelRefund.startedUpgrade must be a fraction in [0, 1], received 1.5',
    );
    expect(economyIssues({ cancelRefund: { startedUpgrade: 0, queuedItem: -0.1 } })).toContain(
      'economy.cancelRefund.queuedItem must be a fraction in [0, 1], received -0.1',
    );
  });

  it('rejects a non-finite refund fraction', () => {
    expect(
      economyIssues({ cancelRefund: { startedUpgrade: Number.NaN, queuedItem: 0.5 } }),
    ).toContain('economy.cancelRefund.startedUpgrade must be a fraction in [0, 1], received NaN');
  });

  it('rejects an msPerHour that is not an hour', () => {
    expect(economyIssues({ msPerHour: 3_600_001 })).toContain(
      'economy.msPerHour must be 3,600,000, received 3600001',
    );
  });

  it('is reached through validateGameConfig, which reports economy problems', () => {
    const raw = JSON.parse(JSON.stringify(TEST_CONFIG)) as Record<string, unknown>;
    (raw.economy as Record<string, unknown>).msPerHour = 1;
    const issues = issuesFor(raw)
      .split(' | ')
      .filter((issue) => issue.length > 0);
    expect(issues).toContain('economy.msPerHour must be 3,600,000, received 1');
  });

  it('requires the economy block at all', () => {
    const raw = minimal();
    delete (raw as { economy?: unknown }).economy;
    expect(issuesFor(raw)).toContain('economy');
  });
});

describe('collector consistency', () => {
  const withLevel = (patch: Record<string, unknown>): string[] => {
    const config = JSON.parse(JSON.stringify(TEST_CONFIG)) as typeof TEST_CONFIG;
    const mine = config.buildings.find((building) => building.id === 'gold_mine');
    if (mine === undefined) throw new Error('no gold_mine in the fixture');
    Object.assign(mine.levels[1]!, patch);
    return checkSemantics(config);
  };

  it('accepts a collector that names what it produces', () => {
    expect(withLevel({ produces: 'gold', productionPerHour: 100, bufferCap: 500 })).toEqual([]);
  });

  it('rejects production with no declared resource', () => {
    const issues = withLevel({ produces: undefined, productionPerHour: 100, bufferCap: 500 });
    expect(issues.some((issue) => issue.includes('does not say which resource'))).toBe(true);
  });

  it('rejects production with no buffer cap', () => {
    const issues = withLevel({ produces: 'gold', productionPerHour: 100, bufferCap: undefined });
    expect(issues.some((issue) => issue.includes('has no bufferCap'))).toBe(true);
  });

  it('rejects a buffer cap with no declared resource', () => {
    const issues = withLevel({ produces: undefined, productionPerHour: undefined, bufferCap: 500 });
    expect(issues.some((issue) => issue.includes('which resource it buffers'))).toBe(true);
  });

  it('ignores a level that produces nothing', () => {
    expect(
      withLevel({ produces: undefined, productionPerHour: undefined, bufferCap: undefined }),
    ).toEqual([]);
  });
});

describe('obstacle identity', () => {
  it('rejects a duplicated obstacle id', () => {
    const raw = minimal();
    raw.obstacles = [
      { id: 'tree', size: { w: 1, h: 1 }, reward: { gold: 1 }, removalSeconds: 1 },
      { id: 'tree', size: { w: 1, h: 1 }, reward: { gold: 1 }, removalSeconds: 1 },
    ];
    expect(issuesFor(raw)).toContain('duplicate obstacle id "tree"');
  });

  it('accepts distinct obstacle ids', () => {
    const raw = minimal();
    raw.obstacles = [
      { id: 'tree', size: { w: 1, h: 1 }, reward: { gold: 1 }, removalSeconds: 1 },
      { id: 'rock', size: { w: 1, h: 1 }, reward: { gold: 1 }, removalSeconds: 1 },
    ];
    expect(
      issuesFor(raw)
        .split(' | ')
        .filter((issue) => issue.length > 0),
    ).toEqual([]);
  });
});

describe('quantity limits (validate 7.3)', () => {
  const withMine = (): any => {
    const raw = minimal();
    raw.buildings.push({
      id: 'gold_mine',
      category: 'economy',
      size: { w: 3, h: 3 },
      unlock: { keepLevel: 1 },
      levels: [
        {
          level: 1,
          hp: 100,
          cost: {},
          buildSeconds: 5,
          requiresKeep: 1,
          productionPerHour: 60,
          bufferCap: 100,
          produces: 'gold',
        },
      ],
    });
    raw.limits.buildingCounts.gold_mine = [0, 2];
    return raw;
  };

  it('accepts a complete limits table', () => {
    expect(validateGameConfig(withMine()).limits.maxKeeps).toBe(1);
  });

  it('rejects a missing row for a defined building', () => {
    const raw = withMine();
    delete raw.limits.buildingCounts.gold_mine;
    expect(issuesFor(raw)).toContain(
      'limits.buildingCounts is missing an entry for building "gold_mine"',
    );
  });

  it('rejects a row that does not cover every Keep level', () => {
    const raw = minimal();
    raw.buildings[0].levels.push({ level: 2, hp: 100, cost: {}, buildSeconds: 0, requiresKeep: 1 });
    raw.limits.buildingCounts.keep = [0, 1];
    expect(issuesFor(raw)).toContain('must cover Keep levels 1..2');
  });

  it('rejects a non-zero index 0', () => {
    const raw = minimal();
    raw.limits.buildingCounts.keep[0] = 1;
    expect(issuesFor(raw)).toContain('[0] is unused and must be 0');
  });

  it('rejects a row for a building that does not exist', () => {
    const raw = minimal();
    raw.limits.buildingCounts.ghost = [0, 1];
    expect(issuesFor(raw)).toContain(
      'limits.buildingCounts has an entry for unknown building "ghost"',
    );
  });

  it('allows a non-HQ row above one but bounds the HQ row by maxKeeps', () => {
    const raw = withMine();
    // Two Gold Mines at Keep 1 is legal — that is what the count table means.
    expect(() => validateGameConfig(raw)).not.toThrow();

    // Two Keeps is not.
    raw.limits.buildingCounts.keep[1] = 2;
    expect(issuesFor(raw)).toContain(
      'limits.buildingCounts["keep"] allows more than limits.maxKeeps (1)',
    );
  });

  it('rejects a maxKeeps other than one', () => {
    const raw = minimal();
    raw.limits.maxKeeps = 2;
    expect(issuesFor(raw)).toContain('limits.maxKeeps must be 1');
  });
});

describe('starter layout (validate 7.2)', () => {
  const withMine = (mineX: number, mineY: number): any => {
    const raw = minimal();
    raw.buildings.push({
      id: 'gold_mine',
      category: 'economy',
      size: { w: 3, h: 3 },
      unlock: { keepLevel: 1 },
      levels: [{ level: 1, hp: 100, cost: {}, buildSeconds: 5, requiresKeep: 1 }],
    });
    raw.limits.buildingCounts.gold_mine = [0, 2];
    raw.starter.buildings.push({ type: 'gold_mine', level: 1, x: mineX, y: mineY });
    return raw;
  };

  it('accepts a layout that sits wholly inside the buildable core', () => {
    expect(() => validateGameConfig(withMine(22, 18))).not.toThrow();
  });

  it('rejects a footprint that only leaves the core on its far edge', () => {
    // x + 3 crosses the core end even though x itself is inside it.
    const raw = withMine(42, 18);
    expect(issuesFor(raw)).toContain('leaves the 40x40 buildable core');
  });

  it('rejects a building that overlaps another', () => {
    const raw = withMine(19, 19);
    expect(issuesFor(raw)).toContain('overlaps');
  });

  it('rejects an obstacle outside the map', () => {
    const raw = minimal();
    raw.obstacles.push({ id: 'tree', size: { w: 1, h: 1 }, reward: {} });
    // Obstacles are decorative: they may sit in the margin, but not off the map.
    raw.starter.obstacles.push({ type: 'tree', x: 48, y: 39 });
    expect(issuesFor(raw)).toContain('leaves the 48x48 map');
  });

  it('accepts an obstacle in the decorative margin', () => {
    const raw = minimal();
    raw.obstacles.push({ id: 'tree', size: { w: 1, h: 1 }, reward: {} });
    raw.starter.obstacles.push({ type: 'tree', x: 0, y: 0 });
    expect(() => validateGameConfig(raw)).not.toThrow();
  });
});

describe('builder price list (spec 7.5)', () => {
  const base = (): any => minimal();

  it('derives its length from maxBuilders minus the starter count', () => {
    // 5 max, 2 starter -> exactly 3 prices.
    expect(validateGameConfig(base()).economy.builders.costs).toHaveLength(3);

    const short = base();
    short.economy.builders.costs.pop();
    expect(issuesFor(short)).toContain('must contain exactly 3 entries');

    const long = base();
    long.economy.builders.costs.push({ gems: 2000 });
    expect(issuesFor(long)).toContain('must contain exactly 3 entries');
  });

  it('rejects a fractional or non-positive price', () => {
    const fractional = base();
    fractional.economy.builders.costs[0] = { gems: 250.5 };
    // Zod rejects the fraction before the semantic integer check runs.
    expect(issuesFor(fractional)).toContain('expected int');

    const zero = base();
    zero.economy.builders.costs[0] = { gems: 0 };
    expect(issuesFor(zero)).toContain('must be positive');

    const free = base();
    free.economy.builders.costs[0] = {};
    expect(issuesFor(free)).toContain('is empty');
  });

  it('rejects a price paid in anything but gems', () => {
    const raw = base();
    raw.economy.builders.costs[0] = { gold: 250 };
    expect(issuesFor(raw)).toContain('gems');
  });
});

describe('economy bounds (D28)', () => {
  const collector = (bufferCap: number): any => {
    const raw = minimal();
    raw.buildings.push({
      id: 'gold_mine',
      category: 'economy',
      size: { w: 3, h: 3 },
      unlock: { keepLevel: 1 },
      levels: [
        {
          level: 1,
          hp: 100,
          cost: {},
          buildSeconds: 5,
          requiresKeep: 1,
          produces: 'gold',
          productionPerHour: 100,
          bufferCap,
        },
      ],
    });
    raw.limits.buildingCounts.gold_mine = [0, 2];
    return raw;
  };

  it('accepts a buffer cap of exactly 1,000,000', () => {
    expect(validateGameConfig(collector(1_000_000)).buildings[1]?.levels[0]?.bufferCap).toBe(
      1_000_000,
    );
  });

  it('rejects a buffer cap one above the bound', () => {
    expect(issuesFor(collector(1_000_001))).toContain('1000000');
  });

  it('accepts a production rate of exactly 1,000,000', () => {
    const raw = collector(100);
    raw.buildings[1].levels[0].productionPerHour = 1_000_000;
    expect(() => validateGameConfig(raw)).not.toThrow();
  });

  it('rejects a production rate one above the bound', () => {
    const raw = collector(100);
    raw.buildings[1].levels[0].productionPerHour = 1_000_001;
    expect(issuesFor(raw)).toContain('1000000');
  });
});

describe('starter layout overlaps (validate 7.2)', () => {
  it('rejects a starter obstacle that overlaps a starter building', () => {
    const raw = minimal();
    raw.obstacles.push({ id: 'tree', size: { w: 1, h: 1 }, reward: {} });
    // The Keep occupies (18,18)-(21,21); the tree sits inside it.
    raw.starter.obstacles.push({ type: 'tree', x: 19, y: 19 });
    expect(issuesFor(raw)).toContain('overlaps');
  });

  it('accepts an obstacle adjacent to a building but not inside it', () => {
    const raw = minimal();
    raw.obstacles.push({ id: 'tree', size: { w: 1, h: 1 }, reward: {} });
    raw.starter.obstacles.push({ type: 'tree', x: 22, y: 18 });
    expect(() => validateGameConfig(raw)).not.toThrow();
  });
});
