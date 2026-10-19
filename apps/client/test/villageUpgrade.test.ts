import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState } from '@coc/sim-core';
import { getBuildingUpgradeSnapshot } from '../src/villageUpgrade';

describe('building upgrade snapshot', () => {
  it('shows the next level, configured cost, stats, and duration for an available upgrade', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);

    expect(getBuildingUpgradeSnapshot(state, GAME_CONFIG, 2, 0)).toMatchObject({
      kind: 'available',
      currentLevel: 1,
      target: {
        level: 2,
        hp: 420,
        cost: { gold: 230 },
        productionPerHour: 360,
      },
      durationMs: 32_000,
    });
  });

  it('reports insufficient resources and builder availability without mutating state', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);
    state.resources.gold = 0;

    expect(getBuildingUpgradeSnapshot(state, GAME_CONFIG, 2, 0)).toMatchObject({
      kind: 'blocked',
      reason: 'insufficient_resources',
      requiredKeep: 1,
    });

    state.resources.gold = 1000;
    state.builders.busy = [
      { buildingId: 2, toLevel: 2, finishAt: 32_000 },
      { buildingId: 3, toLevel: 2, finishAt: 32_000 },
    ];
    expect(getBuildingUpgradeSnapshot(state, GAME_CONFIG, 2, 0)).toMatchObject({
      kind: 'blocked',
      reason: 'no_builder',
    });
  });

  it('shows active upgrade countdowns and maximum-level state', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);
    const mine = state.buildings.find((building) => building.id === 2)!;
    mine.upgrade = { toLevel: 2, finishAt: 42_000 };

    expect(getBuildingUpgradeSnapshot(state, GAME_CONFIG, 2, 12_000)).toMatchObject({
      kind: 'in_progress',
      currentLevel: 1,
      targetLevel: 2,
      remainingMs: 30_000,
      target: { level: 2 },
    });

    mine.upgrade = undefined;
    mine.level = 6;
    expect(getBuildingUpgradeSnapshot(state, GAME_CONFIG, 2, 12_000)).toEqual({
      kind: 'max_level',
      currentLevel: 6,
    });
  });
});
