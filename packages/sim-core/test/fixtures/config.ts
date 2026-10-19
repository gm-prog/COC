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
        {
          level: 1,
          hp: 1000,
          cost: {},
          buildSeconds: 0,
          requiresKeep: 1,
          storageCap: { gold: 1000, essence: 1000 },
        },
        {
          level: 2,
          hp: 1500,
          cost: { gold: 100 },
          buildSeconds: 60,
          requiresKeep: 1,
          storageCap: { gold: 2000, essence: 2000 },
        },
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
          produces: 'gold',
          productionPerHour: 100,
          bufferCap: 500,
        },
        {
          level: 2,
          hp: 420,
          cost: { gold: 200 },
          buildSeconds: 20,
          requiresKeep: 1,
          produces: 'gold',
          productionPerHour: 200,
          bufferCap: 1000,
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
          produces: 'essence',
          productionPerHour: 100,
          bufferCap: 500,
        },
      ],
    },
    {
      id: 'gold_store',
      category: 'storage',
      size: { w: 3, h: 3 },
      unlock: { keepLevel: 1 },
      levels: [
        {
          level: 1,
          hp: 500,
          cost: { gold: 150 },
          buildSeconds: 15,
          requiresKeep: 1,
          storageCap: { gold: 2500 },
        },
        {
          level: 2,
          hp: 700,
          cost: { gold: 300 },
          buildSeconds: 30,
          requiresKeep: 3,
          storageCap: { gold: 5000 },
        },
        {
          level: 3,
          hp: 980,
          cost: { gold: 500 },
          buildSeconds: 60,
          requiresKeep: 6,
          storageCap: { gold: 10_000 },
        },
      ],
    },
    {
      id: 'essence_store',
      category: 'storage',
      size: { w: 3, h: 3 },
      unlock: { keepLevel: 1 },
      levels: [
        {
          level: 1,
          hp: 500,
          cost: { essence: 150 },
          buildSeconds: 15,
          requiresKeep: 1,
          storageCap: { essence: 2500 },
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
  economy: {
    speedUp: {
      anchors: [
        { seconds: 60, gems: 1 },
        { seconds: 3600, gems: 20 },
        { seconds: 86400, gems: 260 },
        { seconds: 604800, gems: 1000 },
      ],
      minimumGems: 1,
    },
    builders: {
      maxBuilders: 5,
      costs: [{ gems: 250 }, { gems: 500 }, { gems: 1000 }],
    },
    cancelRefund: { startedUpgrade: 0, queuedItem: 0.5 },
    msPerHour: 3_600_000,
  },
  // Quantity ceilings (spec §7.3). The fixture deliberately allows walls from
  // Keep 1 so the 1x1 footprint can be used as a placement probe; the shipped
  // `limits.json` carries the spec's 0-at-Keep-1 wall rule and is covered in
  // `packages/game-data/test`.
  limits: {
    maxKeeps: 1,
    buildingCounts: {
      keep: [0, 1, 1],
      gold_mine: [0, 4, 4],
      essence_well: [0, 4, 4],
      gold_store: [0, 2, 2],
      essence_store: [0, 2, 2],
      wall: [0, 64, 64],
      ballista: [0, 2, 2],
    },
  },
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
