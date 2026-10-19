import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState } from '@coc/sim-core';
import { buildVillageHudSnapshot, formatRemainingDuration } from '../src/villageHud';

describe('village HUD snapshot', () => {
  it('reads balances and storage caps from the configured starter state', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);
    const snapshot = buildVillageHudSnapshot(state, GAME_CONFIG, 0);

    expect(snapshot.resources).toEqual([
      { id: 'gold', amount: 1000, capacity: 1000 },
      { id: 'essence', amount: 1000, capacity: 1000 },
      { id: 'shards', amount: 0 },
      { id: 'gems', amount: 50 },
    ]);
    expect(snapshot.builders).toMatchObject({ total: 2, available: 2, busy: [] });
  });

  it('reports busy builders in stable order with a countdown based on injected time', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);
    state.builders.busy = [
      { buildingId: 3, toLevel: 2, finishAt: 125_000 },
      { buildingId: 2, toLevel: 2, finishAt: 65_000 },
    ];

    const snapshot = buildVillageHudSnapshot(state, GAME_CONFIG, 5000);

    expect(snapshot.builders).toEqual({
      total: 2,
      available: 0,
      busy: [
        { buildingId: 2, buildingType: 'gold_mine', remainingMs: 60_000 },
        { buildingId: 3, buildingType: 'essence_well', remainingMs: 120_000 },
      ],
    });
  });
});

describe('builder countdown formatting', () => {
  it.each([
    [0, '0s'],
    [1, '1s'],
    [999, '1s'],
    [60_000, '1m 00s'],
    [61_000, '1m 01s'],
    [3_600_000, '1h'],
    [3_660_000, '1h 1m'],
    [-10, '0s'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatRemainingDuration(ms)).toBe(expected);
  });
});
