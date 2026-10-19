import { describe, expect, it } from 'vitest';
import {
  CONFIG_VERSION,
  GAME_CONFIG,
  getBuildingDef,
  getBuildingLevel,
  getObstacleDef,
  loadGameConfig,
  rawConfig,
} from '../src/index.js';
import { GRID, createNewPlayerState, hashState } from '@coc/sim-core';

describe('game-data config', () => {
  it('validates at import time and exposes a typed config', () => {
    expect(GAME_CONFIG.version).toBe(CONFIG_VERSION);
    expect(GAME_CONFIG.buildings.length).toBeGreaterThan(0);
  });

  it('re-validates raw data on demand', () => {
    expect(loadGameConfig(rawConfig)).toEqual(GAME_CONFIG);
  });

  it('covers the Phase 1 building catalog', () => {
    expect(GAME_CONFIG.buildings.map((b) => b.id)).toEqual([
      'keep',
      'gold_mine',
      'essence_well',
      'gold_store',
      'essence_store',
      'wall',
    ]);
  });

  it('gives every building contiguous levels starting at 1', () => {
    for (const building of GAME_CONFIG.buildings) {
      const levels = building.levels.map((level) => level.level);
      expect(levels).toEqual(levels.map((_, index) => index + 1));
    }
  });

  it('gates the wall behind Keep 2, matching the progression table', () => {
    expect(getBuildingDef(GAME_CONFIG, 'wall')?.unlock.keepLevel).toBe(2);
    expect(getBuildingDef(GAME_CONFIG, 'keep')?.unlock.keepLevel).toBe(1);
  });

  it('scales wall hit points by 1.4 per level', () => {
    const wall = getBuildingDef(GAME_CONFIG, 'wall');
    const l1 = wall?.levels[0]?.hp ?? 0;
    const l2 = wall?.levels[1]?.hp ?? 0;
    expect(l1).toBe(300);
    expect(l2).toBe(Math.round(300 * 1.4));
  });

  it('gives the collectors production and a buffer cap', () => {
    const mine = getBuildingLevel(GAME_CONFIG, 'gold_mine', 1);
    expect(mine?.productionPerHour).toBeGreaterThan(0);
    expect(mine?.bufferCap).toBeGreaterThan(0);
  });

  it('gives the stores a storage cap and the Keep a small base capacity', () => {
    expect(getBuildingLevel(GAME_CONFIG, 'gold_store', 1)?.storageCap?.gold).toBeGreaterThan(0);
    expect(getBuildingLevel(GAME_CONFIG, 'keep', 1)?.storageCap?.gold).toBeGreaterThan(0);
  });

  it('defines tree and rock obstacles with rewards', () => {
    expect(getObstacleDef(GAME_CONFIG, 'tree')?.reward.gold).toBeGreaterThan(0);
    expect(getObstacleDef(GAME_CONFIG, 'rock')?.reward.gold).toBeGreaterThan(0);
  });

  it('returns undefined for unknown ids', () => {
    expect(getBuildingDef(GAME_CONFIG, 'nope')).toBeUndefined();
    expect(getBuildingLevel(GAME_CONFIG, 'nope', 1)).toBeUndefined();
    expect(getObstacleDef(GAME_CONFIG, 'nope')).toBeUndefined();
  });
});

describe('starter layout', () => {
  const state = createNewPlayerState(GAME_CONFIG, 0);

  it('starts a new player with the design resources', () => {
    expect(state.resources).toEqual({ gold: 1000, essence: 1000, shards: 0, gems: 50 });
    expect(state.builders.count).toBe(2);
    expect(state.keepLevel).toBe(1);
  });

  it('places every starter building inside the buildable core', () => {
    for (const building of state.buildings) {
      const def = getBuildingDef(GAME_CONFIG, building.type);
      expect(def).toBeDefined();
      expect(building.x).toBeGreaterThanOrEqual(GRID.margin);
      expect(building.y).toBeGreaterThanOrEqual(GRID.margin);
      expect(building.x + (def?.size.w ?? 0)).toBeLessThanOrEqual(GRID.margin + GRID.buildable);
      expect(building.y + (def?.size.h ?? 0)).toBeLessThanOrEqual(GRID.margin + GRID.buildable);
    }
  });

  it('never overlaps two starter buildings or obstacles', () => {
    const occupied = new Set<string>();
    const claim = (x: number, y: number, w: number, h: number, label: string): void => {
      for (let ty = y; ty < y + h; ty += 1) {
        for (let tx = x; tx < x + w; tx += 1) {
          const key = `${tx},${ty}`;
          expect(occupied.has(key), `${label} overlaps an existing entity at ${key}`).toBe(false);
          occupied.add(key);
        }
      }
    };

    for (const building of state.buildings) {
      const def = getBuildingDef(GAME_CONFIG, building.type);
      claim(building.x, building.y, def?.size.w ?? 1, def?.size.h ?? 1, building.type);
    }
    for (const obstacle of state.obstacles) {
      const def = getObstacleDef(GAME_CONFIG, obstacle.type);
      claim(obstacle.x, obstacle.y, def?.size.w ?? 1, def?.size.h ?? 1, obstacle.type);
    }
  });

  it('produces a stable state hash', () => {
    expect(hashState(createNewPlayerState(GAME_CONFIG, 0))).toBe(hashState(state));
  });
});
