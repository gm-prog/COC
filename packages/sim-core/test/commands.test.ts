import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  type CommandContext,
  type CommandError,
  type GameCommand,
} from '../src/commands/index.js';

/** `Omit` does not distribute over unions, which would break discriminated commands. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type CommandWithoutEnvelope = DistributiveOmit<GameCommand, 'id' | 'clientSeq'>;
import { GRID } from '../src/config/geometry.js';
import { createNewPlayerState, type PlayerState } from '../src/state/index.js';
import { hashState } from '../src/serialize/index.js';
import { NOW, TEST_CONFIG } from './fixtures/config.js';

const ctx: CommandContext = { config: TEST_CONFIG, now: NOW };

const newState = (): PlayerState => createNewPlayerState(TEST_CONFIG, NOW);

const command = (partial: CommandWithoutEnvelope): GameCommand =>
  ({
    ...partial,
    id: 'cmd-1',
    clientSeq: 1,
  }) as GameCommand;

function expectOk(
  result: ReturnType<typeof applyCommand>,
): Extract<ReturnType<typeof applyCommand>, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  return result;
}

function expectError(result: ReturnType<typeof applyCommand>): CommandError {
  if (result.ok) throw new Error('expected an error, got ok');
  return result.error;
}

describe('PlaceBuilding', () => {
  it('places a building and reports an event', () => {
    const result = expectOk(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 20, y: 25 } }),
        ctx,
      ),
    );

    expect(result.state.buildings).toHaveLength(3);
    // Construction starts at level 0 and occupies a builder until it finishes.
    expect(result.state.buildings[2]).toEqual({
      id: 5,
      type: 'wall',
      level: 0,
      x: 20,
      y: 25,
      upgrade: { toLevel: 1, finishAt: NOW + 5000 },
    });
    expect(result.state.builders.busy).toEqual([
      { buildingId: 5, toLevel: 1, finishAt: NOW + 5000 },
    ]);
    expect(result.state.resources.gold).toBe(990); // the wall costs 10 gold
    expect(result.events).toEqual([
      { type: 'ResourcesChanged', changes: { gold: -10 }, reason: 'construction_started' },
      { type: 'BuildingPlaced', buildingId: 5, buildingType: 'wall', level: 0, x: 20, y: 25 },
      {
        type: 'UpgradeStarted',
        buildingId: 5,
        buildingType: 'wall',
        fromLevel: 0,
        toLevel: 1,
        finishAt: NOW + 5000,
        cost: { gold: 10 },
      },
    ]);
    expect(result.state.lastSyncAt).toBe(NOW);
  });

  it('never mutates the state it was given', () => {
    const before = newState();
    const snapshot = hashState(before);
    applyCommand(
      before,
      command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 20, y: 25 } }),
      ctx,
    );
    expect(hashState(before)).toBe(snapshot);
  });

  it('rejects an unknown building type', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'dragon_pit', x: 20, y: 25 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('unknown_building');
  });

  it('rejects a footprint that leaves the map', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'keep', x: 45, y: 45 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('out_of_bounds');
    expect(error.message).toContain('48x48');
  });

  it('rejects a footprint in the decorative margin', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'gold_mine', x: 1, y: 10 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('margin');
    expect(error.message).toContain('4-tile');
  });

  it('accepts a footprint that exactly fits the buildable edge', () => {
    const result = expectOk(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 43, y: 43 } }),
        ctx,
      ),
    );
    expect(result.state.buildings.at(-1)).toMatchObject({ x: 43, y: 43 });
  });

  it('rejects a footprint that overlaps an existing building', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'gold_mine', x: 18, y: 18 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('overlapping');
    expect(error.details).toMatchObject({ owner: 1 });
  });

  it('rejects a footprint that overlaps an obstacle', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 10, y: 10 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('overlapping');
    expect(error.details).toMatchObject({ owner: 3 });
  });

  it('rejects a building whose Keep unlock is above the player Keep level', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'ballista', x: 20, y: 30 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('keep_level_too_low');
    expect(error.message).toContain('Keep 3');
  });

  it('allows a wall next to an existing building', () => {
    const result = expectOk(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 18, y: 22 } }),
        ctx,
      ),
    );
    expect(result.state.buildings.at(-1)).toMatchObject({ type: 'wall', x: 18, y: 22 });
  });
});

describe('MoveBuilding', () => {
  it('moves a building to a free tile and reports both ends', () => {
    const result = expectOk(
      applyCommand(
        newState(),
        command({ type: 'MoveBuilding', payload: { buildingId: 2, x: 30, y: 30 } }),
        ctx,
      ),
    );
    const moved = result.state.buildings.find((b) => b.id === 2);
    expect(moved).toMatchObject({ x: 30, y: 30 });
    expect(result.events).toEqual([
      {
        type: 'BuildingMoved',
        buildingId: 2,
        buildingType: 'gold_mine',
        from: { x: 14, y: 17 },
        to: { x: 30, y: 30 },
      },
    ]);
  });

  it('treats moving a building onto its own tiles as a legal no-op', () => {
    const result = expectOk(
      applyCommand(
        newState(),
        command({ type: 'MoveBuilding', payload: { buildingId: 2, x: 14, y: 17 } }),
        ctx,
      ),
    );
    expect(result.state.buildings.find((b) => b.id === 2)).toMatchObject({ x: 14, y: 17 });
    expect(result.events[0]).toMatchObject({ from: { x: 14, y: 17 }, to: { x: 14, y: 17 } });
  });

  it('rejects moving onto another building', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'MoveBuilding', payload: { buildingId: 2, x: 18, y: 18 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('overlapping');
  });

  it('rejects moving into the margin', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'MoveBuilding', payload: { buildingId: 2, x: 2, y: 20 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('margin');
  });

  it('rejects an unknown building id', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'MoveBuilding', payload: { buildingId: 999, x: 20, y: 20 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('not_found');
  });

  it('frees the old tiles so the destination can be re-occupied afterwards', () => {
    const moved = expectOk(
      applyCommand(
        newState(),
        command({ type: 'MoveBuilding', payload: { buildingId: 2, x: 30, y: 30 } }),
        ctx,
      ),
    ).state;

    const back = expectOk(
      applyCommand(
        moved,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'essence_well', x: 14, y: 17 } }),
        ctx,
      ),
    );
    expect(back.state.buildings.at(-1)).toMatchObject({ type: 'essence_well', x: 14, y: 17 });
  });
});

describe('RemoveObstacle', () => {
  it('removes the obstacle, grants the reward and reports both events', () => {
    // Below the Keep's storage cap: the reward has room to land.
    const state = newState();
    state.resources.gold = 100;
    const result = expectOk(
      applyCommand(state, command({ type: 'RemoveObstacle', payload: { obstacleId: 3 } }), ctx),
    );

    expect(result.state.obstacles).toEqual([{ id: 4, type: 'rock', x: 30, y: 12 }]);
    expect(result.state.resources.gold).toBe(120);
    expect(result.events).toEqual([
      {
        type: 'ObstacleRemoved',
        obstacleId: 3,
        obstacleType: 'tree',
        reward: { gold: 20 },
        credited: { gold: 20 },
        overflow: {},
      },
      { type: 'ResourcesChanged', changes: { gold: 20 }, reason: 'obstacle_cleared' },
    ]);
  });

  it('grants multi-resource rewards', () => {
    const state = newState();
    state.resources.gold = 100;
    const result = expectOk(
      applyCommand(state, command({ type: 'RemoveObstacle', payload: { obstacleId: 4 } }), ctx),
    );
    expect(result.state.resources).toMatchObject({ gold: 130, gems: 51 });
  });

  it('discards a reward that does not fit in storage (spec 7.2: overflow is lost)', () => {
    // The starter sits at the Keep's 1,000 gold cap, so a 20-gold tree reward
    // has nowhere to go. It must be lost, not banked for later.
    const state = newState();
    expect(state.resources.gold).toBe(1000);
    const result = expectOk(
      applyCommand(state, command({ type: 'RemoveObstacle', payload: { obstacleId: 3 } }), ctx),
    );
    expect(result.state.resources.gold).toBe(1000);
    expect(result.events).toEqual([
      {
        type: 'ObstacleRemoved',
        obstacleId: 3,
        obstacleType: 'tree',
        reward: { gold: 20 },
        credited: {},
        overflow: { gold: 20 },
      },
    ]);
  });

  it('credits only the room that is left and discards the rest', () => {
    const state = newState();
    state.resources.gold = 995;
    const result = expectOk(
      applyCommand(state, command({ type: 'RemoveObstacle', payload: { obstacleId: 3 } }), ctx),
    );
    expect(result.state.resources.gold).toBe(1000);
    expect(result.events[0]).toMatchObject({ credited: { gold: 5 }, overflow: { gold: 15 } });
  });

  it('frees the tiles the obstacle occupied', () => {
    const result = expectOk(
      applyCommand(
        newState(),
        command({ type: 'RemoveObstacle', payload: { obstacleId: 3 } }),
        ctx,
      ),
    ).state;
    const placed = expectOk(
      applyCommand(
        result,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 10, y: 10 } }),
        ctx,
      ),
    );
    expect(placed.state.buildings.at(-1)).toMatchObject({ type: 'wall', x: 10, y: 10 });
  });

  it('rejects an unknown obstacle id', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'RemoveObstacle', payload: { obstacleId: 42 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('not_found');
  });
});

describe('command envelope validation', () => {
  it('rejects a command without an id', () => {
    const error = expectError(
      applyCommand(
        newState(),
        { type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 20, y: 20 } } as never,
        ctx,
      ),
    );
    expect(error.code).toBe('invalid_command');
  });

  it('rejects an unknown command type', () => {
    const error = expectError(applyCommand(newState(), { id: 'x', type: 'Nuke' } as never, ctx));
    expect(error.code).toBe('invalid_command');
  });

  it('rejects a context without a usable server time', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 20, y: 20 } }),
        { config: TEST_CONFIG, now: Number.NaN },
      ),
    );
    expect(error.code).toBe('invalid_command');
  });

  it('rejects a non-object command', () => {
    const error = expectError(applyCommand(newState(), null as never, ctx));
    expect(error.code).toBe('invalid_command');
  });
});

describe('determinism', () => {
  const script: CommandWithoutEnvelope[] = [
    { type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 20, y: 25 } },
    { type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 21, y: 25 } },
    { type: 'MoveBuilding', payload: { buildingId: 2, x: 30, y: 30 } },
    { type: 'RemoveObstacle', payload: { obstacleId: 3 } },
    { type: 'PlaceBuilding', payload: { buildingType: 'essence_well', x: 14, y: 17 } },
  ];

  function runOnce(): string {
    let state = createNewPlayerState(TEST_CONFIG, NOW);
    // Construction occupies a builder, so the clock has to move between steps
    // for the later placements to find a free one.
    script.forEach((step, index) => {
      const result = applyCommand(
        state,
        { id: 'c', ...step },
        { config: TEST_CONFIG, now: NOW + index * 10_000 },
      );
      if (!result.ok) throw new Error(`unexpected failure: ${result.error.code}`);
      state = result.state;
    });
    return hashState(state);
  }

  it('gives an identical hashState() for the same command list, every time', () => {
    const first = runOnce();
    for (let i = 0; i < 50; i += 1) {
      expect(runOnce()).toBe(first);
    }
  });

  it('gives a different hash when the command list differs', () => {
    let state = createNewPlayerState(TEST_CONFIG, NOW);
    state = expectOk(
      applyCommand(
        state,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 20, y: 25 } }),
        ctx,
      ),
    ).state;
    expect(hashState(state)).not.toBe(runOnce());
  });

  it('lets a builder start a new job once the previous one has finished', () => {
    const state = createNewPlayerState(TEST_CONFIG, NOW);
    const first = expectOk(
      applyCommand(
        state,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 20, y: 25 } }),
        ctx,
      ),
    ).state;
    expect(first.builders.busy).toHaveLength(1);

    const second = expectOk(
      applyCommand(
        first,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 21, y: 25 } }),
        ctx,
      ),
    ).state;
    expect(second.builders.busy).toHaveLength(2);

    // Both builders are now busy, so a third placement is refused...
    const refused = applyCommand(
      second,
      command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 22, y: 25 } }),
      ctx,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('no_builder');

    // ...until both walls' 5 s are up, at which point both are finished and the
    // third placement takes the freed builder.
    const third = expectOk(
      applyCommand(
        second,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 22, y: 25 } }),
        { config: TEST_CONFIG, now: NOW + 10_000 },
      ),
    ).state;
    expect(third.builders.busy).toHaveLength(1);
    expect(third.buildings.find((b) => b.x === 20 && b.y === 25)?.level).toBe(1);
    expect(third.buildings.find((b) => b.x === 21 && b.y === 25)?.level).toBe(1);
    expect(third.buildings.find((b) => b.x === 22 && b.y === 25)?.level).toBe(0);
  });

  it('charges the level-1 cost and records the construction', () => {
    const state = createNewPlayerState(TEST_CONFIG, NOW);
    const result = expectOk(
      applyCommand(
        state,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'gold_mine', x: 6, y: 6 } }),
        ctx,
      ),
    );
    expect(result.state.resources.gold).toBe(state.resources.gold - 100);
    expect(result.state.buildings.at(-1)).toEqual({
      id: 5,
      type: 'gold_mine',
      level: 0,
      x: 6,
      y: 6,
      upgrade: { toLevel: 1, finishAt: NOW + 10_000 },
    });
    expect(result.events).toEqual([
      { type: 'ResourcesChanged', changes: { gold: -100 }, reason: 'construction_started' },
      { type: 'BuildingPlaced', buildingId: 5, buildingType: 'gold_mine', level: 0, x: 6, y: 6 },
      {
        type: 'UpgradeStarted',
        buildingId: 5,
        buildingType: 'gold_mine',
        fromLevel: 0,
        toLevel: 1,
        finishAt: NOW + 10_000,
        cost: { gold: 100 },
      },
    ]);
  });

  it('refuses a construction the player cannot afford', () => {
    const poor = createNewPlayerState(TEST_CONFIG, NOW);
    poor.resources.gold = 99;
    const error = expectError(
      applyCommand(
        poor,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'gold_mine', x: 6, y: 6 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('insufficient_resources');
    expect(error.details).toEqual({ missing: { gold: 1 } });
  });

  it('keeps the grid geometry used by placement consistent', () => {
    expect(GRID.total).toBe(48);
    expect(GRID.buildable).toBe(40);
  });
});

describe('state that no longer matches the config', () => {
  it('rejects moving a building whose type was removed from the config', () => {
    const broken: CommandContext = {
      now: NOW,
      config: {
        ...TEST_CONFIG,
        buildings: TEST_CONFIG.buildings.filter((b) => b.id !== 'gold_mine'),
      },
    };
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'MoveBuilding', payload: { buildingId: 2, x: 30, y: 30 } }),
        broken,
      ),
    );
    expect(error.code).toBe('unknown_building');
    expect(error.message).toContain('gold_mine');
  });

  it('rejects clearing an obstacle whose type was removed from the config', () => {
    const broken: CommandContext = { now: NOW, config: { ...TEST_CONFIG, obstacles: [] } };
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'RemoveObstacle', payload: { obstacleId: 3 } }),
        broken,
      ),
    );
    expect(error.code).toBe('unknown_obstacle');
    expect(error.message).toContain('tree');
  });

  it('still places against a state whose other buildings are all known', () => {
    const stale = newState();
    stale.buildings = stale.buildings.filter((b) => b.type === 'keep');
    const result = expectOk(
      applyCommand(
        stale,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 14, y: 17 } }),
        ctx,
      ),
    );
    expect(result.state.buildings.at(-1)).toMatchObject({ type: 'wall', x: 14, y: 17 });
  });

  // --- A5 regression: no silent 1x1 fallback -------------------------------
  // An entity whose definition is missing from the config used to be rebuilt
  // into the grid as 1x1 (`def?.size.w ?? 1`). That let an unknown entity be
  // treated as a legal placement and made the grid disagree with the config.
  it('rejects a state containing a building type the config does not define', () => {
    const stale = newState();
    stale.buildings = [...stale.buildings, { id: 99, type: 'ghost_factory', level: 1, x: 6, y: 6 }];

    for (const cmd of [
      command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 30, y: 30 } }),
      command({ type: 'MoveBuilding', payload: { buildingId: 1, x: 30, y: 30 } }),
    ] as const) {
      const error = expectError(applyCommand(stale, cmd, ctx));
      expect(error.code).toBe('unknown_building');
      expect(error.message).toContain('ghost_factory');
      expect(error.details).toMatchObject({ buildingId: 99, buildingType: 'ghost_factory' });
    }
  });

  it('never accepts an unknown building as a legal 1x1 entity', () => {
    const stale = newState();
    stale.buildings = [{ id: 1, type: 'keep', level: 1, x: 18, y: 18 }];
    // The ghost sits exactly where the wall wants to go. If it were still
    // treated as 1x1 the placement would be rejected as an overlap; either way
    // it must not be silently accepted.
    stale.buildings.push({ id: 2, type: 'ghost_factory', level: 1, x: 30, y: 30 });
    const result = applyCommand(
      stale,
      command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 30, y: 30 } }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_building');
  });

  it('rejects a state containing an obstacle type the config does not define', () => {
    const stale = newState();
    stale.obstacles = [...stale.obstacles, { id: 77, type: 'ufo', x: 12, y: 12 }];
    const error = expectError(
      applyCommand(
        stale,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 30, y: 30 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('unknown_obstacle');
    expect(error.message).toContain('ufo');
    expect(error.details).toMatchObject({ obstacleId: 77, obstacleType: 'ufo' });
  });

  it('rejects a state whose entity position or footprint is malformed', () => {
    const stale = newState();
    stale.buildings = [{ id: 1, type: 'keep', level: 1, x: Number.NaN, y: 18 }];
    const error = expectError(
      applyCommand(
        stale,
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 30, y: 30 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('invalid_state');
    expect(error.message).toContain('malformed');
  });
});

// --- A2 regression: malformed runtime payloads ----------------------------
// TypeScript types do not validate external data. These arrive over the wire,
// so every coordinate is checked before any grid arithmetic runs.
describe('malformed placement payloads', () => {
  const badCoordinates: Record<string, unknown> = {
    NaN: Number.NaN,
    Infinity: Number.POSITIVE_INFINITY,
    '-Infinity': Number.NEGATIVE_INFINITY,
    undefined: undefined,
    string: '30',
    fractional: 30.5,
    negativeFraction: -0.5,
    null: null,
    object: {},
    boolean: true,
  };

  for (const [label, value] of Object.entries(badCoordinates)) {
    it(`rejects PlaceBuilding with ${label} x`, () => {
      const error = expectError(
        applyCommand(
          newState(),
          command({
            type: 'PlaceBuilding',
            payload: { buildingType: 'wall', x: value as number, y: 30 },
          }),
          ctx,
        ),
      );
      expect(error.code).toBe('invalid_command');
      expect(error.message).toContain('payload.x');
    });

    it(`rejects PlaceBuilding with ${label} y`, () => {
      const error = expectError(
        applyCommand(
          newState(),
          command({
            type: 'PlaceBuilding',
            payload: { buildingType: 'wall', x: 30, y: value as number },
          }),
          ctx,
        ),
      );
      expect(error.code).toBe('invalid_command');
      expect(error.message).toContain('payload.y');
    });

    it(`rejects MoveBuilding with ${label} x`, () => {
      const error = expectError(
        applyCommand(
          newState(),
          command({ type: 'MoveBuilding', payload: { buildingId: 1, x: value as number, y: 30 } }),
          ctx,
        ),
      );
      expect(error.code).toBe('invalid_command');
      expect(error.message).toContain('payload.x');
    });
  }

  it('rejects a missing buildingType', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { x: 30, y: 30 } as never }),
        ctx,
      ),
    );
    expect(error.code).toBe('invalid_command');
    expect(error.message).toContain('payload.buildingType');
  });

  it('rejects a non-integer buildingId and obstacleId', () => {
    for (const cmd of [
      command({ type: 'MoveBuilding', payload: { buildingId: 1.5, x: 30, y: 30 } }),
      command({ type: 'MoveBuilding', payload: { buildingId: Number.NaN, x: 30, y: 30 } }),
      command({ type: 'RemoveObstacle', payload: { obstacleId: '3' as never } }),
      command({ type: 'RemoveObstacle', payload: { obstacleId: undefined as never } }),
    ] as const) {
      const error = expectError(applyCommand(newState(), cmd, ctx));
      expect(error.code).toBe('invalid_command');
    }
  });

  it('rejects a non-object payload', () => {
    for (const cmd of [
      command({ type: 'PlaceBuilding', payload: null as never }),
      command({ type: 'MoveBuilding', payload: 7 as never }),
      command({ type: 'RemoveObstacle', payload: 'x' as never }),
    ] as const) {
      expect(applyCommand(newState(), cmd, ctx).ok).toBe(false);
    }
  });

  it('leaves the input state untouched for every malformed payload', () => {
    const before = newState();
    const snapshot = hashState(before);
    for (const cmd of [
      command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: Number.NaN, y: 30 } }),
      command({ type: 'MoveBuilding', payload: { buildingId: 1, x: 30.5, y: 30 } }),
      command({ type: 'RemoveObstacle', payload: { obstacleId: Number.NaN } }),
      command({ type: 'PlaceBuilding', payload: { buildingType: 'ghost', x: 30, y: 30 } }),
    ] as const) {
      const result = applyCommand(before, cmd, ctx);
      expect(result.ok).toBe(false);
      expect(hashState(before)).toBe(snapshot);
    }
  });

  it('still rejects out-of-bounds, margin, overlap and exact-fit edges', () => {
    // The invalid_rect guard must not have disturbed the ordering for valid rects.
    const cases = [
      { payload: { buildingType: 'wall', x: 30, y: 48 }, code: 'out_of_bounds' },
      { payload: { buildingType: 'wall', x: 3, y: 30 }, code: 'margin' },
      { payload: { buildingType: 'wall', x: 14, y: 17 }, code: 'overlapping' },
      { payload: { buildingType: 'wall', x: 48, y: 30 }, code: 'out_of_bounds' },
      { payload: { buildingType: 'wall', x: 30, y: 44 }, code: 'margin' },
    ] as const;
    for (const { payload, code } of cases) {
      expect(
        expectError(applyCommand(newState(), command({ type: 'PlaceBuilding', payload }), ctx))
          .code,
      ).toBe(code);
    }
  });

  it('still accepts an exact-fit footprint in the buildable corner', () => {
    // A 3x3 filling the last three buildable tiles: bounds, margin and
    // occupancy all pass. This is the exact-fit edge the invalid_rect guard
    // must not have broken.
    const result = expectOk(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'gold_mine', x: 41, y: 41 } }),
        ctx,
      ),
    );
    expect(result.state.buildings.at(-1)).toMatchObject({ x: 41, y: 41 });
  });

  it('still allows moving a building onto its own current footprint', () => {
    const result = expectOk(
      applyCommand(
        newState(),
        command({ type: 'MoveBuilding', payload: { buildingId: 2, x: 14, y: 17 } }),
        ctx,
      ),
    );
    expect(result.state.buildings.find((b) => b.id === 2)).toMatchObject({ x: 14, y: 17 });
    expect(result.events).toEqual([
      {
        type: 'BuildingMoved',
        buildingId: 2,
        buildingType: 'gold_mine',
        from: { x: 14, y: 17 },
        to: { x: 14, y: 17 },
      },
    ]);
  });
});

// --- A2 regression: defense at the config/state boundary -------------------
// `GameConfig` is a structural type, so a caller can hand applyCommand an
// object that type-checks but was never produced by validateGameConfig. These
// tests prove the boundary guards fire instead of treating a nonsense
// footprint as "free".
describe('malformed config and state at the grid boundary', () => {
  const withBadSize = (): CommandContext => {
    const config = JSON.parse(JSON.stringify(TEST_CONFIG)) as typeof TEST_CONFIG;
    const wall = config.buildings.find((b) => b.id === 'wall');
    if (wall) wall.size = { w: Number.NaN, h: 1 };
    return { config, now: NOW };
  };

  const withBadObstaclePosition = (): PlayerState => {
    const state = newState();
    state.obstacles = [{ id: 3, type: 'tree', x: Number.NaN, y: 10 }];
    return state;
  };

  it('reports invalid_rect when the config supplies a malformed footprint', () => {
    const error = expectError(
      applyCommand(
        newState(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 30, y: 30 } }),
        withBadSize(),
      ),
    );
    expect(error.code).toBe('invalid_rect');
    expect(error.message).toContain('positive integer footprint');
  });

  it('reports invalid_state when an obstacle has a malformed position', () => {
    const error = expectError(
      applyCommand(
        withBadObstaclePosition(),
        command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 30, y: 30 } }),
        ctx,
      ),
    );
    expect(error.code).toBe('invalid_state');
    expect(error.message).toContain('obstacle 3');
  });

  it('leaves the input state untouched when the boundary guard fires', () => {
    const before = withBadObstaclePosition();
    const snapshot = hashState(before);
    const result = applyCommand(
      before,
      command({ type: 'PlaceBuilding', payload: { buildingType: 'wall', x: 30, y: 30 } }),
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(hashState(before)).toBe(snapshot);
  });
});
