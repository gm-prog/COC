import type { GameConfig } from '../../src/config/types.js';
import { validateGameConfig } from '../../src/validate/index.js';

/**
 * A tiny, self-contained config for sim-core's own tests.
 *
 * sim-core must be testable without `@coc/game-data` (which depends on it), so
 * the fixtures live here. `packages/game-data/test` covers the real tables.
 */
export const TEST_CONFIG: GameConfig = validateGameConfig({
  version: 'test-1.0.0',
  buildings: [
    {
      id: 'keep',
      category: 'hq',
      size: { w: 4, h: 4 },
      unlock: { keepLevel: 1 },
      levels: [
        { level: 1, hp: 1000, cost: {}, buildSeconds: 0, requiresKeep: 1 },
        { level: 2, hp: 1500, cost: { gold: 100 }, buildSeconds: 60, requiresKeep: 1 },
      ],
    },
    {
      id: 'gold_mine',
      category: 'economy',
      size: { w: 3, h: 3 },
      unlock: { keepLevel: 1 },
      levels: [
        {
          level: 1,
          hp: 300,
          cost: { gold: 100 },
          buildSeconds: 10,
          requiresKeep: 1,
          productionPerHour: 100,
          bufferCap: 500,
        },
      ],
    },
    {
      id: 'essence_well',
      category: 'economy',
      size: { w: 3, h: 3 },
      unlock: { keepLevel: 1 },
      levels: [
        {
          level: 1,
          hp: 300,
          cost: { essence: 100 },
          buildSeconds: 10,
          requiresKeep: 1,
          productionPerHour: 100,
          bufferCap: 500,
        },
      ],
    },
    {
      id: 'wall',
      category: 'wall',
      size: { w: 1, h: 1 },
      unlock: { keepLevel: 1 },
      levels: [{ level: 1, hp: 300, cost: { gold: 10 }, buildSeconds: 5, requiresKeep: 1 }],
    },
    {
      id: 'ballista',
      category: 'defense',
      size: { w: 3, h: 3 },
      unlock: { keepLevel: 3 },
      levels: [
        {
          level: 1,
          hp: 320,
          cost: { gold: 500 },
          buildSeconds: 100,
          requiresKeep: 3,
          dps: 11,
          rangeMin: 0,
          rangeMax: 9,
          targets: ['ground'],
        },
      ],
    },
  ],
  obstacles: [
    { id: 'tree', size: { w: 1, h: 1 }, reward: { gold: 20 }, removalSeconds: 3 },
    { id: 'rock', size: { w: 1, h: 1 }, reward: { gold: 30, gems: 1 }, removalSeconds: 5 },
  ],
  starter: {
    resources: { gold: 1000, essence: 1000, shards: 0, gems: 50 },
    builders: 2,
    buildings: [
      { type: 'keep', level: 1, x: 18, y: 18 },
      { type: 'gold_mine', level: 1, x: 14, y: 17 },
    ],
    obstacles: [
      { type: 'tree', x: 10, y: 10 },
      { type: 'rock', x: 30, y: 12 },
    ],
  },
});

/** A fixed "server time" so no test ever depends on the wall clock. */
export const NOW = 1_800_000_000_000;
