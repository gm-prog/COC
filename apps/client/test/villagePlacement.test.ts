import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState, hashState } from '@coc/sim-core';
import { previewBuildingPlacement } from '../src/villagePlacement';

describe('building placement preview', () => {
  it('accepts a free, buildable footprint and never mutates the input state', () => {
    const state = createNewPlayerState(GAME_CONFIG, 1000);
    const before = hashState(state);

    const preview = previewBuildingPlacement(state, GAME_CONFIG, 'gold_store', 29, 29, 1000);

    expect(preview).toEqual({ valid: true });
    expect(hashState(state)).toBe(before);
  });

  it('uses sim-core bounds and occupancy rules for invalid previews', () => {
    const state = createNewPlayerState(GAME_CONFIG, 1000);

    expect(previewBuildingPlacement(state, GAME_CONFIG, 'gold_store', 2, 2, 1000)).toEqual({
      valid: false,
      errorCode: 'margin',
    });
    expect(previewBuildingPlacement(state, GAME_CONFIG, 'gold_store', 18, 18, 1000)).toEqual({
      valid: false,
      errorCode: 'overlapping',
    });
  });

  it('shows locked buildings as invalid until the required Keep level is reached', () => {
    const state = createNewPlayerState(GAME_CONFIG, 1000);

    expect(previewBuildingPlacement(state, GAME_CONFIG, 'wall', 29, 29, 1000)).toEqual({
      valid: false,
      errorCode: 'keep_level_too_low',
    });
  });
});
