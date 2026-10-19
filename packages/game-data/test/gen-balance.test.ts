import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILDINGS,
  KEEP_BUILD_SECONDS,
  KEEP_GATING,
  requiredKeepFor,
} from '../scripts/balance.config.js';
import { generate, serialise } from '../scripts/gen-balance.js';
import type { BuildingDef, ObstacleDef } from '../../sim-core/src/index.js';
import { loadGameConfig } from '../src/index.js';
import buildingsJson from '../data/buildings.json';
import economyJson from '../data/economy.json';
import limitsJson from '../data/limits.json';
import obstaclesJson from '../data/obstacles.json';
import starterJson from '../data/starter.json';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');

const readData = (name: string): string => readFileSync(join(dataDir, name), 'utf8');

const buildings = buildingsJson as unknown as BuildingDef[];
const obstacles = obstaclesJson as unknown as ObstacleDef[];

describe('generated tables', () => {
  it('emits one contiguous ascending level run per building', () => {
    for (const building of buildings) {
      const levels = building.levels.map((level) => level.level);
      expect(levels, building.id).toEqual(levels.map((_, index) => index + 1));
    }
  });

  it('emits the configured number of levels for every building', () => {
    for (const base of BUILDINGS) {
      const building = buildings.find((candidate) => candidate.id === base.id);
      expect(building, base.id).toBeDefined();
      expect(building?.levels).toHaveLength(base.maxLevel);
    }
  });

  it('keeps a stable ordering: buildings follow the balance config, levels ascend', () => {
    expect(buildings.map((building) => building.id)).toEqual(BUILDINGS.map((b) => b.id));
    for (const building of buildings) {
      const levels = building.levels.map((level) => level.level);
      expect(levels, building.id).toEqual([...levels].sort((a, b) => a - b));
    }
  });

  it('carries every hand-authored field through to the output', () => {
    for (const base of BUILDINGS) {
      const building = buildings.find((candidate) => candidate.id === base.id);
      if (building === undefined) throw new Error(`missing ${base.id}`);
      expect(building.id).toBe(base.id);
      expect(building.category).toBe(base.category);
      expect(building.size).toEqual(base.size);
      expect(building.unlock).toEqual({ keepLevel: base.unlockKeep });
      expect(building.levels[0]?.hp).toBe(base.baseHp);
      // Level 1 of the Keep is 0 because every player starts with one; other
      // buildings build their level-1 table from `baseBuildSeconds`.
      expect(building.levels[0]?.buildSeconds).toBe(base.id === 'keep' ? 0 : base.baseBuildSeconds);
      expect(building.levels[0]?.cost).toEqual(base.baseCost);
      if (base.production !== undefined) {
        expect(building.levels[0]?.produces).toBe(base.production.produces);
        expect(building.levels[0]?.productionPerHour).toBe(base.production.basePerHour);
        expect(building.levels[0]?.bufferCap).toBe(base.production.baseBufferCap);
      }
      if (base.storage !== undefined) {
        expect(building.levels[0]?.storageCap).toEqual(base.storage.capacities);
      }
    }
  });

  it('emits no timestamps or other non-deterministic content', () => {
    const text = readData('buildings.json');
    // No ISO dates, no epoch-looking numbers beyond the configured ones.
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toMatch(/"generatedAt"|"timestamp"|"buildTime"/);
  });

  it('matches the file on disk byte for byte', () => {
    // The generator is deterministic; this asserts the checked-in file is what
    // the current balance config produces, so `gen:balance` produces no diff.
    const first = generate();
    expect(serialise(first.buildings)).toBe(readData('buildings.json'));
    expect(serialise(first.obstacles)).toBe(readData('obstacles.json'));
    expect(serialise(first.limits)).toBe(readData('limits.json'));
  });

  it('produces byte-identical output when run twice', () => {
    const a = generate();
    const b = generate();
    expect(serialise(b)).toBe(serialise(a));
    expect(serialise(b.buildings)).toBe(serialise(a.buildings));
    expect(serialise(b.obstacles)).toBe(serialise(a.obstacles));
  });

  it('produces the same output after the objects have been re-parsed', () => {
    const first = generate();
    const roundTripped = JSON.parse(serialise(first)) as typeof first;
    expect(serialise(roundTripped)).toBe(serialise(first));
  });
});

describe('growth anchors', () => {
  const keep = buildings.find((b) => b.id === 'keep');
  const mine = buildings.find((b) => b.id === 'gold_mine');

  it('matches the spec Keep cost curve at the published anchors', () => {
    // Keep L1..L6 at 1,000 base with x1.55 rounded to the nearest 10.
    expect(keep?.levels.map((l) => l.cost.gold)).toEqual([1000, 1550, 2400, 3720, 5770, 8950]);
    expect(keep?.levels.map((l) => l.cost.essence)).toEqual([1000, 1550, 2400, 3720, 5770, 8950]);
  });

  it('matches the spec Keep time curve exactly', () => {
    expect(keep?.levels.map((l) => l.buildSeconds)).toEqual([0, 300, 1800, 10800, 43200, 86400]);
  });

  it('scales hit points by 1.4 per level', () => {
    const hp = keep?.levels.map((l) => l.hp) ?? [];
    expect(hp[0]).toBe(1500);
    for (let index = 1; index < hp.length; index += 1) {
      expect(hp[index]).toBe(Math.round(1500 * 1.4 ** index));
    }
  });

  it('scales collector production and buffer cap together', () => {
    const rate = mine?.levels.map((l) => l.productionPerHour) ?? [];
    const cap = mine?.levels.map((l) => l.bufferCap) ?? [];
    expect(rate).toEqual([240, 360, 540, 810, 1215, 1823]);
    expect(cap).toEqual([600, 900, 1350, 2025, 3038, 4556]);
    for (let index = 1; index < rate.length; index += 1) {
      expect(rate[index]).toBe(Math.round(240 * 1.5 ** index));
    }
  });

  it('scales build time by 1.6^(N-1) for non-Keep buildings', () => {
    const times = mine?.levels.map((l) => l.buildSeconds) ?? [];
    expect(times[0]).toBe(20);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBe(Math.round(20 * 1.6 ** index));
    }
  });

  it('scales storage capacity by its own curve', () => {
    const store = buildings.find((b) => b.id === 'gold_store');
    expect(store?.levels.map((l) => l.storageCap?.gold)).toEqual([2500, 5000, 10_000]);
  });
});

describe('Keep gating', () => {
  it('derives requiresKeep from the transcribed gating table', () => {
    const mine = buildings.find((b) => b.id === 'gold_mine');
    expect(mine?.levels.map((l) => l.requiresKeep)).toEqual([1, 1, 2, 3, 4, 5]);

    // The per-building columns in §7.3 are *counts*; a building's level ceiling
    // comes from the "Max bldg level" column for every building alike.
    const store = buildings.find((b) => b.id === 'gold_store');
    expect(store?.levels.map((l) => l.requiresKeep)).toEqual([1, 1, 2]);
  });

  it('never requires a Keep level above the maximum the table allows', () => {
    for (const building of buildings) {
      for (const level of building.levels) {
        expect(level.requiresKeep, `${building.id} L${level.level}`).toBeGreaterThanOrEqual(1);
        expect(level.requiresKeep, `${building.id} L${level.level}`).toBeLessThanOrEqual(6);
      }
    }
  });

  it('inverts the gating table monotonically', () => {
    for (const building of buildings) {
      const gates = building.levels.map((l) => l.requiresKeep);
      for (let index = 1; index < gates.length; index += 1) {
        expect(gates[index], `${building.id} L${index + 1}`).toBeGreaterThanOrEqual(
          gates[index - 1] as number,
        );
      }
    }
  });

  it('agrees with requiredKeepFor for the named rows', () => {
    expect(requiredKeepFor('gold_mine', 1)).toBe(1);
    expect(requiredKeepFor('gold_mine', 6)).toBe(5);
    expect(requiredKeepFor('gold_store', 2)).toBe(1);
    expect(requiredKeepFor('gold_store', 3)).toBe(2);
    expect(requiredKeepFor('keep', 2)).toBe(1);
    // The building name is irrelevant: only the level matters.
    expect(requiredKeepFor('gold_mine', 4)).toBe(requiredKeepFor('gold_store', 4));
  });

  it('uses the generic max-building-level column for unnamed buildings', () => {
    // The wall row is a *count*, not a level, so walls fall back to the generic
    // "max building level" column: Keep 1 allows level 2, Keep 2 allows level 3.
    const wall = buildings.find((b) => b.id === 'wall');
    expect(wall?.levels.map((l) => l.requiresKeep)).toEqual(
      Array.from({ length: 6 }, (_, index) => requiredKeepFor('wall', index + 1)),
    );
    expect(wall?.levels.map((l) => l.requiresKeep)).toEqual([1, 1, 2, 3, 4, 5]);
  });

  it('derives the shipped quantity ceilings from the §7.3 count columns', () => {
    // Walls are the headline rule: none at Keep 1, then 25/50/75/100/125.
    expect(limitsJson.buildingCounts.wall).toEqual([0, 0, 25, 50, 75, 100, 125]);
    expect(limitsJson.buildingCounts.gold_mine).toEqual([0, 2, 3, 4, 5, 6, 6]);
    expect(limitsJson.buildingCounts.gold_store).toEqual([0, 1, 1, 2, 2, 2, 3]);
    // One HQ at every Keep level, and index 0 is unused for every row.
    expect(limitsJson.maxKeeps).toBe(1);
    for (const counts of Object.values(limitsJson.buildingCounts)) {
      expect(counts[0]).toBe(0);
      expect(counts).toHaveLength(7);
    }
  });

  it('transcribes the published Keep gating table', () => {
    expect(KEEP_GATING.maxBuildingLevel).toEqual([0, 2, 3, 4, 5, 6, 7]);
    expect(KEEP_GATING.goldMine).toEqual([0, 2, 3, 4, 5, 6, 6]);
    expect(KEEP_GATING.walls).toEqual([0, 0, 25, 50, 75, 100, 125]);
    expect(KEEP_BUILD_SECONDS[2]).toBe(300);
    expect(KEEP_BUILD_SECONDS[8]).toBe(345_600);
  });
});

describe('the generated data satisfies the validator', () => {
  it('loads through loadGameConfig without complaints', () => {
    const config = loadGameConfig({
      version: '0.1.0',
      buildings,
      obstacles,
      economy: economyJson,
      limits: limitsJson,
      starter: starterJson,
    });
    expect(config.buildings).toHaveLength(buildings.length);
    expect(config.obstacles).toHaveLength(obstacles.length);
    expect(config.limits.maxKeeps).toBe(1);
  });

  it('reports no semantic problems', () => {
    // A second config assembled from the generated tables plus a starter that
    // actually references them, so the Keep-gating rules can be checked.
    // Keep 1 allows two Gold Mines, one Gold Store and no walls; the layout is
    // spread out so full footprints stay inside the buildable core and nothing
    // overlaps.
    const starter = {
      resources: { gold: 0, essence: 0, shards: 0, gems: 0 },
      builders: 2,
      buildings: [
        { type: 'keep', level: 1, x: 18, y: 18 },
        { type: 'gold_mine', level: 1, x: 14, y: 17 },
        { type: 'gold_store', level: 1, x: 24, y: 13 },
      ],
      obstacles: obstacles.map((obstacle, index) => ({
        type: obstacle.id,
        x: 20 + index,
        y: 0,
      })),
    };
    expect(() =>
      loadGameConfig({
        version: '0.1.0',
        buildings,
        obstacles,
        economy: economyJson,
        limits: limitsJson,
        starter,
      }),
    ).not.toThrow();
  });

  it('keeps obstacles authored rather than curve-generated', () => {
    expect(obstacles.map((o) => o.id)).toEqual(['tree', 'rock']);
    expect(obstacles[0]?.reward).toEqual({ gold: 20 });
    expect(obstacles[1]?.reward).toEqual({ gold: 30, gems: 1 });
    expect(obstacles[0]?.removalSeconds).toBe(3);
    expect(obstacles[1]?.removalSeconds).toBe(5);
  });
});
