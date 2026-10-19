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
    expect(result.state.buildings[2]).toEqual({
      id: 5,
      type: 'wall',
      level: 1,
      x: 20,
      y: 25,
    });
    expect(result.events).toEqual([
      {
        type: 'BuildingPlaced',
        buildingId: 5,
        buildingType: 'wall',
        level: 1,
        x: 20,
        y: 25,
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
    const result = expectOk(
      applyCommand(
        newState(),
        command({ type: 'RemoveObstacle', payload: { obstacleId: 3 } }),
        ctx,
      ),
    );

    expect(result.state.obstacles).toEqual([{ id: 4, type: 'rock', x: 30, y: 12 }]);
    expect(result.state.resources.gold).toBe(1020);
    expect(result.events).toEqual([
      { type: 'ObstacleRemoved', obstacleId: 3, obstacleType: 'tree', reward: { gold: 20 } },
      { type: 'ResourcesChanged', changes: { gold: 20 }, reason: 'obstacle_cleared' },
    ]);
  });

  it('grants multi-resource rewards', () => {
    const result = expectOk(
      applyCommand(
        newState(),
        command({ type: 'RemoveObstacle', payload: { obstacleId: 4 } }),
        ctx,
      ),
    );
    expect(result.state.resources).toMatchObject({ gold: 1030, gems: 51 });
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
    for (const step of script) {
      const result = applyCommand(state, { id: 'c', ...step }, ctx);
      if (!result.ok) throw new Error(`unexpected failure: ${result.error.code}`);
      state = result.state;
    }
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

  it('treats a building with an unknown footprint as 1x1 when building the grid', () => {
    // A state saved under an older config still has to be placeable-checkable.
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
});
