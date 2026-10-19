import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { applyCommand, createNewPlayerState, hashState } from '@coc/sim-core';

describe('client resource collection command flow', () => {
  it('credits buffered production and clears the collector buffer without mutating the input', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);
    state.resources.gold = 0;
    const before = hashState(state);

    const result = applyCommand(
      state,
      {
        id: 'collect-gold-test',
        type: 'CollectResource',
        payload: { buildingId: 2 },
      },
      { config: GAME_CONFIG, now: 15_000 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const collected = result.events.find((event) => event.type === 'ResourceCollected');

    expect(collected).toMatchObject({
      type: 'ResourceCollected',
      buildingId: 2,
      resource: 'gold',
      accepted: 1,
      overflow: 0,
      bufferRemaining: 0,
    });
    expect(result.state.resources.gold).toBe(1);
    expect(result.state.buildings.find((building) => building.id === 2)?.buffer?.amount).toBe(0);
    expect(hashState(state)).toBe(before);
  });

  it('discards collection overflow when storage is full', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);
    state.buildings.find((building) => building.id === 2)!.buffer = {
      amount: 25,
      remainder: 0,
      lastAccruedAt: 0,
    };

    const result = applyCommand(
      state,
      {
        id: 'collect-full-store-test',
        type: 'CollectResource',
        payload: { buildingId: 2 },
      },
      { config: GAME_CONFIG, now: 1000 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.find((event) => event.type === 'ResourceCollected')).toMatchObject({
      accepted: 0,
      overflow: 25,
      bufferRemaining: 0,
    });
    expect(result.state.resources.gold).toBe(1000);
  });
});
