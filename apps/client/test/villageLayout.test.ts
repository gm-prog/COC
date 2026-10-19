import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState } from '@coc/sim-core';
import { findVillageEntityAtTile, listVillageEntities } from '../src/villageLayout';

describe('village entity layout', () => {
  it('finds a building anywhere inside its configured footprint', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);

    const entity = findVillageEntityAtTile(state, GAME_CONFIG, 21, 21);

    expect(entity).toMatchObject({
      kind: 'building',
      instance: { type: 'keep', x: 18, y: 18 },
    });
  });

  it('finds starter obstacles and returns null for an empty tile', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);

    expect(findVillageEntityAtTile(state, GAME_CONFIG, 8, 8)).toMatchObject({
      kind: 'obstacle',
      instance: { type: 'tree' },
    });
    expect(findVillageEntityAtTile(state, GAME_CONFIG, 30, 30)).toBeNull();
  });

  it('uses one stable back-to-front order for both drawing and hit-testing', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);
    state.obstacles.push({ id: 100, type: 'rock', x: 18, y: 18 });

    const drawOrder = listVillageEntities(state, GAME_CONFIG);
    const selected = findVillageEntityAtTile(state, GAME_CONFIG, 18, 18);

    expect(drawOrder[drawOrder.length - 1]).toMatchObject({
      kind: 'building',
      instance: { type: 'keep' },
    });
    expect(selected).toMatchObject({
      kind: 'building',
      instance: { type: 'keep' },
    });
  });

  it('ignores invalid entity types rather than crashing rendering', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);
    state.buildings.push({ id: 99, type: 'unknown_building', level: 1, x: 30, y: 30 });

    expect(findVillageEntityAtTile(state, GAME_CONFIG, 30, 30)).toBeNull();
  });

  it('returns no entity for non-integer tile coordinates', () => {
    const state = createNewPlayerState(GAME_CONFIG, 0);

    expect(findVillageEntityAtTile(state, GAME_CONFIG, 18.5, 18)).toBeNull();
  });
});
