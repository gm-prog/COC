import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState } from '@coc/sim-core';
import { listBuildingShopItems } from '../src/villageShop';

describe('building shop availability', () => {
  it('uses Keep requirements, configured limits, builder availability, and costs', () => {
    const state = createNewPlayerState(GAME_CONFIG, 1000);
    const items = listBuildingShopItems(state, GAME_CONFIG);

    expect(items.find((item) => item.id === 'keep')).toMatchObject({
      reason: 'limit',
      count: 1,
      limit: 1,
    });
    expect(items.find((item) => item.id === 'gold_mine')).toMatchObject({ reason: null });
    expect(items.find((item) => item.id === 'gold_store')).toMatchObject({
      reason: null,
      cost: { gold: 200 },
      buildSeconds: 30,
    });
    expect(items.find((item) => item.id === 'wall')).toMatchObject({
      reason: 'keep_level',
      requiredKeep: 2,
    });
  });

  it('disables affordable items when both builders are occupied', () => {
    const state = createNewPlayerState(GAME_CONFIG, 1000);
    state.builders.busy = [
      { buildingId: 2, toLevel: 2, finishAt: 65_000 },
      { buildingId: 3, toLevel: 2, finishAt: 125_000 },
    ];

    const items = listBuildingShopItems(state, GAME_CONFIG);

    expect(items.find((item) => item.id === 'gold_store')).toMatchObject({
      reason: 'no_builder',
    });
  });

  it('distinguishes insufficient resources from a Keep-level lock', () => {
    const state = createNewPlayerState(GAME_CONFIG, 1000);
    state.resources.gold = 0;

    const items = listBuildingShopItems(state, GAME_CONFIG);

    expect(items.find((item) => item.id === 'gold_store')).toMatchObject({
      reason: 'resources',
    });
    expect(items.find((item) => item.id === 'wall')).toMatchObject({
      reason: 'keep_level',
    });
  });
});
