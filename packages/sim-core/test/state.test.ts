import { describe, expect, it } from 'vitest';
import {
  clonePlayerState,
  createNewPlayerState,
  findKeep,
  highestEntityId,
  isKeepLevelConsistent,
} from '../src/state/index.js';
import { hashState, stableStringify } from '../src/serialize/index.js';
import { NOW, TEST_CONFIG } from './fixtures/config.js';

describe('createNewPlayerState', () => {
  const state = createNewPlayerState(TEST_CONFIG, NOW);

  it('starts at state version 1 with the config version stamped on', () => {
    expect(state.version).toBe(1);
    expect(state.configVersion).toBe('test-1.0.0');
  });

  it('grants the starting resources from config', () => {
    expect(state.resources).toEqual({ gold: 1000, essence: 1000, shards: 0, gems: 50 });
  });

  it('starts with the configured number of builders and no work in flight', () => {
    expect(state.builders).toEqual({ count: 2, busy: [] });
  });

  it('places the starter buildings with sequential ids', () => {
    expect(state.buildings).toEqual([
      { id: 1, type: 'keep', level: 1, x: 18, y: 18 },
      { id: 2, type: 'gold_mine', level: 1, x: 14, y: 17 },
    ]);
  });

  it('places the starter obstacles with ids that continue after the buildings', () => {
    expect(state.obstacles).toEqual([
      { id: 3, type: 'tree', x: 10, y: 10 },
      { id: 4, type: 'rock', x: 30, y: 12 },
    ]);
  });

  it('derives keepLevel from the Keep building level', () => {
    expect(findKeep(state)).toMatchObject({ type: 'keep', level: 1 });
    expect(state.keepLevel).toBe(1);
    expect(isKeepLevelConsistent(state)).toBe(true);
  });

  it('starts with an empty army, research, spells and trophies', () => {
    expect(state.army).toEqual({});
    expect(state.trainingQueues).toEqual([]);
    expect(state.research).toEqual({ levels: {} });
    expect(state.spells).toEqual({});
    expect(state.trophies).toBe(0);
    expect(state.tutorialStep).toBe(0);
  });

  it('records the injected server time', () => {
    expect(state.lastSyncAt).toBe(NOW);
  });

  it('has no shield, guard or clan yet', () => {
    expect(state.shieldUntil).toBeUndefined();
    expect(state.guardUntil).toBeUndefined();
    expect(state.clan).toBeUndefined();
  });

  it('tracks the highest entity id across buildings and obstacles', () => {
    expect(highestEntityId(state)).toBe(4);
  });
});

describe('serialization round-trip', () => {
  const state = createNewPlayerState(TEST_CONFIG, NOW);

  it('survives a stable-stringify / JSON round-trip unchanged', () => {
    expect(JSON.parse(stableStringify(state))).toEqual(state);
  });

  it('produces the same hash regardless of key insertion order', () => {
    const reordered = {
      lastSyncAt: state.lastSyncAt,
      tutorialStep: state.tutorialStep,
      trophies: state.trophies,
      spells: state.spells,
      research: state.research,
      trainingQueues: state.trainingQueues,
      army: state.army,
      obstacles: state.obstacles,
      buildings: state.buildings,
      builders: state.builders,
      resources: state.resources,
      keepLevel: state.keepLevel,
      configVersion: state.configVersion,
      version: state.version,
    };
    expect(hashState(reordered)).toBe(hashState(state));
  });

  it('clones deeply so mutations do not leak', () => {
    const clone = clonePlayerState(state);
    expect(clone).toEqual(state);
    expect(clone).not.toBe(state);

    clone.buildings[0]!.x = 99;
    clone.resources.gold = 0;
    clone.obstacles.pop();
    expect(state.buildings[0]!.x).toBe(18);
    expect(state.resources.gold).toBe(1000);
    expect(state.obstacles).toHaveLength(2);
  });
});

it('defaults keepLevel to 1 when the starter layout has no Keep', () => {
  // The validator refuses such a config, but createNewPlayerState must still
  // produce a usable state rather than reading `undefined.level`.
  const broken = {
    ...TEST_CONFIG,
    starter: { ...TEST_CONFIG.starter, buildings: [] },
  };
  const state = createNewPlayerState(broken, NOW);
  expect(state.keepLevel).toBe(1);
  expect(state.buildings).toEqual([]);
  expect(state.builders).toEqual({ count: 2, busy: [] });
});

describe('isKeepLevelConsistent without a Keep', () => {
  it('treats a village with no Keep as consistent', () => {
    const state = createNewPlayerState(TEST_CONFIG, 0);
    state.buildings = state.buildings.filter((b) => b.type !== 'keep');
    expect(findKeep(state)).toBeUndefined();
    expect(isKeepLevelConsistent(state)).toBe(true);
  });

  it('notices a keepLevel that disagrees with the Keep', () => {
    const state = createNewPlayerState(TEST_CONFIG, 0);
    state.keepLevel = 3;
    expect(isKeepLevelConsistent(state)).toBe(false);
  });
});
