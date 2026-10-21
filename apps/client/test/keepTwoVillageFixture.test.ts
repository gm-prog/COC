import { describe, expect, it } from 'vitest';
import { createNewPlayerState } from '@coc/sim-core';
import { GAME_CONFIG } from '@coc/game-data';
import {
  SAVE_SCHEMA_VERSION,
  checkSaveEnvelope,
  validatePersistedState,
} from '../src/persistence/villageSave';
import { listBuildingShopItems } from '../src/villageShop';
import {
  KEEP_TWO_SAVE_SCHEMA_VERSION,
  keepTwoSave,
  keepTwoState,
} from '../../../e2e/support/keepTwoVillage';

/**
 * Guards the **test-only** Keep 2 save used by `e2e/phase3-wall-drag.spec.ts`.
 *
 * The browser suite cannot build walls in the configured starter (Keep 1), and
 * it must not weaken that gate. It seeds this record instead and lets the app
 * restore it through the normal `bootstrapVillage` path, so the record has to be
 * one the real loader accepts. These checks run it through the same
 * `checkSaveEnvelope`/`validatePersistedState` the app uses, without a browser:
 * a balance or schema change fails here first, with a readable message instead
 * of a Playwright timeout.
 *
 * It is a fixture, **not** evidence that a player can reach Keep 2 — Gate C
 * item 18 is still open.
 */

const NOW = 1_700_000_000_000;

describe('Keep 2 fixture for the wall-drag browser suite', () => {
  const state = keepTwoState(NOW);
  const starter = createNewPlayerState(GAME_CONFIG, NOW);

  it('is a record the real loader accepts', () => {
    expect(KEEP_TWO_SAVE_SCHEMA_VERSION).toBe(SAVE_SCHEMA_VERSION);
    expect(validatePersistedState(state, GAME_CONFIG)).toEqual([]);
    expect(checkSaveEnvelope(keepTwoSave(NOW), GAME_CONFIG)).toMatchObject({ ok: true });
  });

  it('differs from the configured starter only by the completed Keep', () => {
    expect(state.buildings.map((building) => building.type)).toEqual(
      starter.buildings.map((building) => building.type),
    );
    expect(state.buildings[0]).toMatchObject({ type: 'keep', level: 2, x: 18, y: 18 });
    expect(starter.buildings[0]).toMatchObject({ type: 'keep', level: 1 });
    expect(state.keepLevel).toBe(2);
    expect(starter.keepLevel).toBe(1);
    expect(state.obstacles).toEqual(starter.obstacles);
    expect(state.resources).toEqual(starter.resources);
    expect(state.builders).toEqual(starter.builders);
    expect(state.configVersion).toBe(GAME_CONFIG.version);
  });

  it('is exactly the difference the wall gate needs', () => {
    const wallAtStarter = listBuildingShopItems(starter, GAME_CONFIG).find(
      (item) => item.id === 'wall',
    );
    const wallAtKeepTwo = listBuildingShopItems(state, GAME_CONFIG).find(
      (item) => item.id === 'wall',
    );

    expect(wallAtStarter?.reason).toBe('keep_level');
    expect(wallAtStarter?.requiredKeep).toBe(2);
    expect(wallAtKeepTwo?.reason).toBeNull();
    expect(wallAtKeepTwo?.limit).toBe(25);
    expect(wallAtKeepTwo?.cost).toEqual({ gold: 10 });
    expect(wallAtKeepTwo?.buildSeconds).toBe(5);
  });

  it('keeps the wall row the browser test drags along free of entities', () => {
    const occupied = new Set<string>();
    for (const building of state.buildings) {
      const definition = GAME_CONFIG.buildings.find((entry) => entry.id === building.type);
      if (!definition) continue;
      for (let x = 0; x < definition.size.w; x += 1) {
        for (let y = 0; y < definition.size.h; y += 1) {
          occupied.add(`${building.x + x},${building.y + y}`);
        }
      }
    }
    for (const obstacle of state.obstacles) {
      occupied.add(`${obstacle.x},${obstacle.y}`);
    }

    for (let x = 14; x <= 19; x += 1) {
      expect(occupied.has(`${x},26`), `tile ${x},26 is occupied`).toBe(false);
    }
    // The rock at (6, 20) is what stops the partial stroke in scenario C.
    expect(state.obstacles.some((obstacle) => obstacle.type === 'rock' && obstacle.x === 6)).toBe(
      true,
    );
  });
});
