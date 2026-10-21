import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import {
  applyCommand,
  createNewPlayerState,
  hashState,
  type PlayerState,
  type ResourceId,
} from '@coc/sim-core';
import {
  formatResourceAmount,
  hasCappedReward,
  obstacleRemovalFeedback,
  resolveObstacleRemoval,
  type ObstacleRemovalEvent,
} from '../src/villageObstacleRemoval';
import { t, type TranslationKey } from '../src/i18n';
import { storageCapacity } from '@coc/sim-core';

/**
 * Obstacle removal is a thin client over the existing `RemoveObstacle` command,
 * so these tests never restate the command's rule suite
 * (`packages/sim-core/test/commands.test.ts` covers that). What they pin down is
 * the layer this PR adds: which state is adopted, what is left untouched, and
 * that feedback reports the *credited* reward rather than the configured one.
 */

const START = 1_700_000_000_000;

/**
 * The configured starter: Keep 1 at (18,18), Gold Mine 2 at (14,17), Essence
 * Well 3 at (23,17), obstacles numbered from 4 in `starter.json` order — so 4 is
 * the tree at (8,8), 5 the rock at (6,20), 6 the tree at (10,30).
 *
 * Asserted rather than assumed, so a config change fails here with a clear
 * message instead of somewhere in a browser.
 */
const TREE_ID = 4;
const ROCK_ID = 5;

function starter(): PlayerState {
  return createNewPlayerState(GAME_CONFIG, START);
}

function remove(
  state: PlayerState,
  obstacleId: number,
  overrides: { readOnly?: boolean; now?: number } = {},
) {
  return resolveObstacleRemoval({
    state,
    config: GAME_CONFIG,
    obstacleId,
    now: overrides.now ?? START,
    readOnly: overrides.readOnly ?? false,
  });
}

function removedEvent(attempt: ReturnType<typeof remove>): ObstacleRemovalEvent {
  if (attempt.kind !== 'removed' || attempt.removed === null) {
    throw new Error(`expected a removal, got ${attempt.kind}`);
  }
  return attempt.removed;
}

describe('the configured starter obstacles these tests rely on', () => {
  it('numbers the starter trees and rocks as the tests assume', () => {
    const state = starter();
    expect(state.obstacles.map((o) => [o.id, o.type, o.x, o.y])).toEqual([
      [TREE_ID, 'tree', 8, 8],
      [ROCK_ID, 'rock', 6, 20],
      [6, 'tree', 10, 30],
      [7, 'rock', 38, 28],
      [8, 'tree', 34, 12],
      [9, 'tree', 12, 30],
      [10, 'rock', 32, 14],
    ]);
  });

  it('gives the starter the gold cap the browser test depends on', () => {
    const state = starter();
    expect(state.resources).toMatchObject({ gold: 1000, essence: 1000, gems: 50 });
    expect(storageCapacity(state, GAME_CONFIG).gold).toBe(1000);
  });
});

describe('removing an obstacle', () => {
  it('adopts the command’s state and hands back its ObstacleRemoved event', () => {
    const state = starter();
    state.resources.gold = 100;
    const before = hashState(state);

    const attempt = remove(state, TREE_ID);

    expect(attempt.kind).toBe('removed');
    if (attempt.kind !== 'removed') return;

    // The obstacle is gone from the adopted state, and the reward landed.
    expect(attempt.state.obstacles.map((o) => o.id)).toEqual([ROCK_ID, 6, 7, 8, 9, 10]);
    expect(attempt.state.resources.gold).toBe(120);
    expect(attempt.removed).toMatchObject({
      type: 'ObstacleRemoved',
      obstacleId: TREE_ID,
      obstacleType: 'tree',
      reward: { gold: 20 },
      credited: { gold: 20 },
      overflow: {},
    });
    // The caller's state was not mutated; only the returned one changed.
    expect(hashState(state)).toBe(before);
  });

  it('leaves buildings, builders and unrelated resources alone', () => {
    const state = starter();
    state.resources.gold = 100;
    const attempt = remove(state, TREE_ID);
    if (attempt.kind !== 'removed') throw new Error('expected a removal');

    expect(attempt.state.buildings).toEqual(state.buildings);
    expect(attempt.state.builders).toEqual(state.builders);
    expect(attempt.state.keepLevel).toBe(state.keepLevel);
    expect(attempt.state.resources.essence).toBe(state.resources.essence);
    expect(attempt.state.resources.gems).toBe(state.resources.gems);
    expect(attempt.state.lastSyncAt).toBe(START);
  });

  it('frees the tile so a building can be placed there afterwards', () => {
    const attempt = remove(starter(), ROCK_ID);
    if (attempt.kind !== 'removed') throw new Error('expected a removal');

    const placed = applyCommand(
      attempt.state,
      {
        id: 'place-after-removal',
        type: 'PlaceBuilding',
        payload: { buildingType: 'gold_store', x: 6, y: 20 },
      },
      { config: GAME_CONFIG, now: START },
    );
    expect(placed.ok).toBe(true);
  });

  it('credits only the room left and reports the rest as overflow', () => {
    const state = starter();
    state.resources.gold = 995; // five gold of room in front of a 20-gold tree

    const event = removedEvent(remove(state, TREE_ID));

    expect(event.credited).toEqual({ gold: 5 });
    expect(event.overflow).toEqual({ gold: 15 });
  });

  it('credits nothing when storage is full, and says so', () => {
    const state = starter();
    expect(state.resources.gold).toBe(1000); // the starter sits at the cap

    const attempt = remove(state, TREE_ID);
    if (attempt.kind !== 'removed') throw new Error('expected a removal');

    expect(attempt.state.resources.gold).toBe(1000);
    expect(attempt.removed).toMatchObject({ credited: {}, overflow: { gold: 20 } });
    // Nothing was credited, so the command emits no ResourcesChanged event and
    // the UI must not assume one exists.
    expect(attempt.events.map((event) => event.type)).toEqual(['ObstacleRemoved']);
  });

  it('gives a rock its Gem reward even when Gold is capped', () => {
    const state = starter();

    const attempt = remove(state, ROCK_ID);
    if (attempt.kind !== 'removed') throw new Error('expected a removal');

    // Gold stays at the cap; the uncapped Gem is credited.
    expect(attempt.state.resources.gold).toBe(1000);
    expect(attempt.state.resources.gems).toBe(51);
    expect(attempt.removed).toMatchObject({
      obstacleType: 'rock',
      reward: { gold: 30, gems: 1 },
      credited: { gems: 1 },
      overflow: { gold: 30 },
    });
  });

  it('rejects a stale or unknown obstacle id without touching the state', () => {
    const state = starter();
    const before = hashState(state);

    expect(remove(state, 999_999)).toEqual({ kind: 'rejected', errorCode: 'not_found' });
    // A building id is not an obstacle id, even though it is a valid entity.
    expect(remove(state, 1)).toEqual({ kind: 'rejected', errorCode: 'not_found' });
    expect(hashState(state)).toBe(before);
  });

  it('refuses in a read-only session without running the command', () => {
    const state = starter();
    const before = hashState(state);

    expect(remove(state, ROCK_ID, { readOnly: true })).toEqual({
      kind: 'refused',
      reason: 'read_only',
    });
    expect(hashState(state)).toBe(before);
    expect(state.obstacles).toHaveLength(7);
  });

  it('removes only the obstacle that was asked for', () => {
    const state = starter();
    const others = state.obstacles.filter((obstacle) => obstacle.id !== ROCK_ID);

    const attempt = remove(state, ROCK_ID);
    if (attempt.kind !== 'removed') throw new Error('expected a removal');

    expect(attempt.state.obstacles).toEqual(others);
    expect(attempt.state.obstacles.some((obstacle) => obstacle.type === 'rock')).toBe(true);
  });
});

describe('removal feedback', () => {
  const event = (fields: Partial<ObstacleRemovalEvent> = {}): ObstacleRemovalEvent => ({
    type: 'ObstacleRemoved',
    obstacleId: TREE_ID,
    obstacleType: 'tree',
    reward: { gold: 20 },
    credited: { gold: 20 },
    overflow: {},
    ...fields,
  });

  const message = (removal: ObstacleRemovalEvent): string => {
    const feedback = obstacleRemovalFeedback(removal);
    return t(feedback.key, feedback.params);
  };

  it('reports the credited reward when everything fits', () => {
    expect(message(event())).toBe('Tree cleared: 20 Gold.');
  });

  it('reports the loss instead of a reward when nothing fits', () => {
    const removal = event({ credited: {}, overflow: { gold: 20 } });
    const text = message(removal);

    expect(text).toBe('Tree cleared, but nothing fit in storage — 20 Gold was lost.');
    // The one thing the player must never read is that they were paid.
    expect(text).not.toContain('Gained');
    expect(text).not.toContain('+20');
  });

  it('reports both halves of a partial credit', () => {
    const removal = event({ credited: { gold: 5 }, overflow: { gold: 15 } });
    expect(message(removal)).toBe('Tree cleared: 5 Gold; 15 Gold was lost to storage.');
  });

  it('handles a rock that loses Gold but still grants Gems', () => {
    const rock = event({
      obstacleId: ROCK_ID,
      obstacleType: 'rock',
      reward: { gold: 30, gems: 1 },
      credited: { gems: 1 },
      overflow: { gold: 30 },
    });

    expect(message(rock)).toBe('Rock cleared: 1 Gems; 30 Gold was lost to storage.');
  });

  it('falls back to a neutral message if the command emitted no removal event', () => {
    // Defensive only: the command always emits one. A missing event must not be
    // reported as a reward.
    const feedback = obstacleRemovalFeedback(event({ credited: {}, overflow: {} }));
    expect(t(feedback.key, feedback.params)).toBe('Tree cleared.');
  });

  it('formats amounts through i18n, in a stable order, skipping zero entries', () => {
    expect(formatResourceAmount({ gold: 30, gems: 1 })).toBe('30 Gold · 1 Gems');
    expect(formatResourceAmount({ gold: 0 })).toBe('');
    expect(formatResourceAmount({})).toBe('');
    // Every resource name comes from the dictionary, not a literal here.
    const resources: ResourceId[] = ['gold', 'essence', 'shards', 'gems'];
    for (const resource of resources) {
      const name = t(('resource.' + resource) as TranslationKey);
      expect(formatResourceAmount({ [resource]: 2 })).toBe(`2 ${name}`);
    }
  });

  it('flags a reward as capped only when a granted resource has a capacity', () => {
    const capacity = storageCapacity(starter(), GAME_CONFIG);

    expect(hasCappedReward({ gold: 20 }, capacity)).toBe(true);
    expect(hasCappedReward({ gold: 30, gems: 1 }, capacity)).toBe(true);
    // Gems are not held in buildings, so they have no cap to overflow.
    expect(hasCappedReward({ gems: 1 }, capacity)).toBe(false);
    expect(hasCappedReward({}, capacity)).toBe(false);
  });
});
