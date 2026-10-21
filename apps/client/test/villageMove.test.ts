import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState, hashState, type BuildingDef, type PlayerState } from '@coc/sim-core';
import {
  beginMoveInteraction,
  cancelInteraction,
  IDLE_INTERACTION,
  isNoopMoveTarget,
  placementInteraction,
  previewBuildingMove,
  resolveMoveAttempt,
  type MoveSession,
} from '../src/villageMove';
import { listVillageEntities, type VillageEntity } from '../src/villageLayout';

/**
 * Move Mode is a client feature over the existing `MoveBuilding` command, so
 * these tests never invent placement rules: the expected codes are the ones the
 * simulation itself produces (covered in depth by
 * `packages/sim-core/test/commands.test.ts`).
 */

const START = 1_700_000_000_000;

/**
 * The configured starter village: Keep 1 at (18, 18), Gold Mine 2 at (14, 17),
 * Essence Well 3 at (23, 17), obstacles from id 4 upwards. Asserted rather than
 * assumed so a config change fails here instead of in a browser.
 */
function starter(): PlayerState {
  return createNewPlayerState(GAME_CONFIG, START);
}

const GOLD_MINE_ID = 2;
const GOLD_MINE_FROM = { x: 14, y: 17 };

function buildingEntity(state: PlayerState, id: number): VillageEntity {
  const entity = listVillageEntities(state, GAME_CONFIG).find(
    (candidate) => candidate.instance.id === id,
  );
  if (!entity) throw new Error(`no entity ${id}`);
  return entity;
}

function goldMineDef(): BuildingDef {
  const def = GAME_CONFIG.buildings.find((candidate) => candidate.id === 'gold_mine');
  if (!def) throw new Error('gold_mine is missing from the config');
  return def;
}

/** A session for the starter Gold Mine, without going through the UI. */
function goldMineSession(state: PlayerState = starter()): MoveSession {
  const entity = buildingEntity(state, GOLD_MINE_ID);
  const started = beginMoveInteraction(state, entity);
  if (!started.ok) throw new Error(`could not start move: ${started.reason}`);
  return started.interaction.session;
}

describe('the configured starter layout these tests rely on', () => {
  it('places the buildings and obstacles the tests name', () => {
    const state = starter();
    expect(state.buildings.map((b) => [b.id, b.type, b.x, b.y])).toEqual([
      [1, 'keep', 18, 18],
      [2, 'gold_mine', 14, 17],
      [3, 'essence_well', 23, 17],
    ]);
    expect(state.obstacles[0]).toMatchObject({ id: 4, type: 'tree', x: 8, y: 8 });
  });
});

describe('move preview', () => {
  it('accepts a free, buildable footprint without touching the village', () => {
    const state = starter();
    const before = hashState(state);

    const preview = previewBuildingMove(state, GAME_CONFIG, GOLD_MINE_ID, 30, 30, START);

    expect(preview).toEqual({ valid: true });
    // A preview is a prediction: the command ran and its result was discarded.
    expect(hashState(state)).toBe(before);
  });

  it('accepts the building’s own footprint, which the command treats as a no-op', () => {
    const state = starter();
    const before = hashState(state);

    expect(
      previewBuildingMove(
        state,
        GAME_CONFIG,
        GOLD_MINE_ID,
        GOLD_MINE_FROM.x,
        GOLD_MINE_FROM.y,
        START,
      ),
    ).toEqual({ valid: true });
    expect(hashState(state)).toBe(before);
  });

  it('rejects a destination overlapping another building', () => {
    const state = starter();
    const before = hashState(state);

    // The Keep occupies 18–21 on both axes.
    expect(previewBuildingMove(state, GAME_CONFIG, GOLD_MINE_ID, 18, 18, START)).toEqual({
      valid: false,
      errorCode: 'overlapping',
    });
    expect(hashState(state)).toBe(before);
  });

  it('rejects a destination overlapping an obstacle', () => {
    const state = starter();
    const before = hashState(state);

    // A tree stands on (8, 8), which is inside the buildable core.
    expect(previewBuildingMove(state, GAME_CONFIG, GOLD_MINE_ID, 8, 8, START)).toEqual({
      valid: false,
      errorCode: 'overlapping',
    });
    expect(hashState(state)).toBe(before);
  });

  it('rejects a footprint that leaves the map', () => {
    const state = starter();

    // A 3×3 footprint anchored at 47 would need tiles up to 49 on a 48-tile map.
    expect(previewBuildingMove(state, GAME_CONFIG, GOLD_MINE_ID, 47, 24, START)).toEqual({
      valid: false,
      errorCode: 'out_of_bounds',
    });
  });

  it('rejects a destination in the decorative margin', () => {
    const state = starter();

    expect(previewBuildingMove(state, GAME_CONFIG, GOLD_MINE_ID, 2, 20, START)).toEqual({
      valid: false,
      errorCode: 'margin',
    });
  });

  it('rejects an unknown building id', () => {
    const state = starter();
    const before = hashState(state);

    expect(previewBuildingMove(state, GAME_CONFIG, 999_999, 30, 30, START)).toEqual({
      valid: false,
      errorCode: 'not_found',
    });
    expect(hashState(state)).toBe(before);
  });
});

describe('interaction state', () => {
  it('enters Move Mode for a selected building and remembers which one', () => {
    const state = starter();
    const started = beginMoveInteraction(state, buildingEntity(state, GOLD_MINE_ID));

    expect(started).toEqual({
      ok: true,
      interaction: {
        kind: 'moving',
        session: {
          buildingId: GOLD_MINE_ID,
          buildingType: 'gold_mine',
          fromX: GOLD_MINE_FROM.x,
          fromY: GOLD_MINE_FROM.y,
        },
      },
    });
  });

  it('refuses an obstacle, which has no move command', () => {
    const state = starter();
    const obstacle = listVillageEntities(state, GAME_CONFIG).find(
      (candidate) => candidate.kind === 'obstacle',
    );
    if (!obstacle) throw new Error('the starter has no obstacle');

    expect(beginMoveInteraction(state, obstacle)).toEqual({
      ok: false,
      reason: 'not_a_building',
    });
  });

  it('refuses no selection at all', () => {
    expect(beginMoveInteraction(starter(), null)).toEqual({ ok: false, reason: 'no_selection' });
  });

  it('refuses a stale selection whose id is no longer in the village', () => {
    const state = starter();
    const entity = buildingEntity(state, GOLD_MINE_ID);
    const stale: VillageEntity = {
      ...entity,
      instance: { ...entity.instance, id: 9_999 },
    } as VillageEntity;

    expect(beginMoveInteraction(state, stale)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('cannot place and move at the same time', () => {
    const state = starter();
    const started = beginMoveInteraction(state, buildingEntity(state, GOLD_MINE_ID));
    if (!started.ok) throw new Error('could not start move');

    // Assigning one variant is the transition, so "both modes" is not a state
    // the type can express: a placement replaces the move session outright.
    const placing = placementInteraction('gold_store');
    expect(placing).toEqual({ kind: 'placing', buildingType: 'gold_store' });

    // And entering Move Mode after placement replaces the placement.
    const moving = beginMoveInteraction(state, buildingEntity(state, GOLD_MINE_ID));
    expect(moving.ok && moving.interaction.kind).toBe('moving');
    expect(moving.ok && 'buildingType' in moving.interaction).toBe(false);
  });

  it('cancels back to idle from either mode', () => {
    expect(cancelInteraction()).toEqual(IDLE_INTERACTION);
    expect(cancelInteraction()).toEqual({ kind: 'idle' });
  });

  it('recognises the building’s own anchor as a no-op destination', () => {
    const state = starter();
    const session = goldMineSession(state);

    expect(isNoopMoveTarget(session, GOLD_MINE_FROM.x, GOLD_MINE_FROM.y)).toBe(true);
    expect(isNoopMoveTarget(session, GOLD_MINE_FROM.x + 1, GOLD_MINE_FROM.y)).toBe(false);
  });
});

describe('committing a move', () => {
  const context = (state: PlayerState, overrides: { readOnly?: boolean } = {}) => ({
    state,
    config: GAME_CONFIG,
    session: goldMineSession(state),
    now: START,
    readOnly: overrides.readOnly ?? false,
  });

  it('adopts the command’s state and leaves everything else alone', () => {
    const state = starter();
    const before = hashState(state);
    const attempt = resolveMoveAttempt({ ...context(state), x: 30, y: 30 });

    expect(attempt.kind).toBe('moved');
    if (attempt.kind !== 'moved') throw new Error('expected a move');

    const moved = attempt.state.buildings.find((building) => building.id === GOLD_MINE_ID);
    expect(moved).toMatchObject({ type: 'gold_mine', x: 30, y: 30, level: 1 });
    // Resources, builders and unrelated buildings are untouched: a move is
    // free and instant under the current contract (D27).
    expect(attempt.state.resources).toEqual(state.resources);
    expect(attempt.state.builders).toEqual(state.builders);
    expect(attempt.state.buildings.filter((building) => building.id !== GOLD_MINE_ID)).toEqual(
      state.buildings.filter((building) => building.id !== GOLD_MINE_ID),
    );
    expect(attempt.state.lastSyncAt).toBe(START);
    expect(attempt.events).toEqual([
      {
        type: 'BuildingMoved',
        buildingId: GOLD_MINE_ID,
        buildingType: 'gold_mine',
        from: GOLD_MINE_FROM,
        to: { x: 30, y: 30 },
      },
    ]);
    // The state handed in was not mutated; the caller adopts the returned one.
    expect(hashState(state)).toBe(before);
  });

  it('keeps a collector’s buffer and level when its building moves', () => {
    const state = starter();
    const mine = state.buildings.find((building) => building.id === GOLD_MINE_ID);
    if (!mine) throw new Error('missing gold mine');
    mine.buffer = { amount: 37, remainder: 0.25, lastAccruedAt: START };

    const attempt = resolveMoveAttempt({ ...context(state), x: 30, y: 30 });
    if (attempt.kind !== 'moved') throw new Error('expected a move');

    const moved = attempt.state.buildings.find((building) => building.id === GOLD_MINE_ID);
    expect(moved?.buffer).toEqual({ amount: 37, remainder: 0.25, lastAccruedAt: START });
  });

  it('can start a move for a producing building that has stored resources', () => {
    // Selecting a producer with a buffer makes the scene collect on tap; the
    // panel is refreshed afterwards, so Move has to remain available. That is
    // tested here at the layer the scene uses to start the mode.
    const state = starter();
    const mine = state.buildings.find((building) => building.id === GOLD_MINE_ID);
    if (!mine) throw new Error('missing gold mine');
    mine.buffer = { amount: 12, remainder: 0, lastAccruedAt: START };

    expect(beginMoveInteraction(state, buildingEntity(state, GOLD_MINE_ID)).ok).toBe(true);
    expect(resolveMoveAttempt({ ...context(state), x: 30, y: 30 }).kind).toBe('moved');
  });

  it('rejects an occupied destination and leaves the village untouched', () => {
    const state = starter();
    const before = hashState(state);

    const attempt = resolveMoveAttempt({ ...context(state), x: 18, y: 18 });

    expect(attempt).toEqual({ kind: 'rejected', errorCode: 'overlapping' });
    expect(hashState(state)).toBe(before);
  });

  it('rejects a destination in the margin without changing anything', () => {
    const state = starter();
    const before = hashState(state);

    expect(resolveMoveAttempt({ ...context(state), x: 2, y: 20 })).toEqual({
      kind: 'rejected',
      errorCode: 'margin',
    });
    expect(hashState(state)).toBe(before);
  });

  it('treats the current anchor as a no-op instead of writing the same village', () => {
    const state = starter();
    const before = hashState(state);

    expect(
      resolveMoveAttempt({
        ...context(state),
        x: GOLD_MINE_FROM.x,
        y: GOLD_MINE_FROM.y,
      }),
    ).toEqual({ kind: 'noop' });
    // No command ran, so nothing was bumped — `lastSyncAt` included.
    expect(hashState(state)).toBe(before);
  });

  it('refuses every destination in a read-only session, even a legal one', () => {
    const state = starter();
    const before = hashState(state);

    for (const [x, y] of [
      [30, 30],
      [GOLD_MINE_FROM.x, GOLD_MINE_FROM.y],
      [18, 18],
    ] as const) {
      expect(resolveMoveAttempt({ ...context(state, { readOnly: true }), x, y })).toEqual({
        kind: 'refused',
        reason: 'read_only',
      });
      expect(hashState(state), `${x},${y}`).toBe(before);
    }
  });
});

describe('the move command the client relies on', () => {
  it('is the authoritative rule set: preview and commit agree', () => {
    const state = starter();
    const session = goldMineSession(state);

    for (const destination of [
      { x: 30, y: 30 },
      { x: 18, y: 18 },
      { x: 2, y: 20 },
      { x: 47, y: 24 },
      { x: 8, y: 8 },
      { x: 0, y: 0 },
    ]) {
      const preview = previewBuildingMove(
        state,
        GAME_CONFIG,
        session.buildingId,
        destination.x,
        destination.y,
        START,
      );
      const attempt = resolveMoveAttempt({
        state,
        config: GAME_CONFIG,
        session,
        x: destination.x,
        y: destination.y,
        now: START,
        readOnly: false,
      });

      expect(attempt.kind === 'moved', `${destination.x},${destination.y}`).toBe(preview.valid);
      if (!preview.valid && attempt.kind === 'rejected') {
        expect(attempt.errorCode, `${destination.x},${destination.y}`).toBe(preview.errorCode);
      }
    }
  });

  it('uses the configured footprint, so a larger building needs a larger clearing', () => {
    const state = starter();
    const keep = state.buildings.find((building) => building.id === 1);
    if (!keep) throw new Error('missing keep');
    const keepDef = GAME_CONFIG.buildings.find((building) => building.id === keep.type);
    expect(keepDef?.size).toEqual({ w: 4, h: 4 });
    expect(goldMineDef().size).toEqual({ w: 3, h: 3 });

    // The map is 48 tiles wide (0–47) and the buildable core ends at 43. A 4×4
    // Keep anchored at 45 needs tiles up to 48, so it leaves the map; the same
    // anchor for a 3×3 mine fits inside the map but sits in the margin. The
    // preview gets both from the command, not from a size table of its own.
    expect(previewBuildingMove(state, GAME_CONFIG, 1, 45, 45, START)).toEqual({
      valid: false,
      errorCode: 'out_of_bounds',
    });
    expect(previewBuildingMove(state, GAME_CONFIG, GOLD_MINE_ID, 45, 45, START)).toEqual({
      valid: false,
      errorCode: 'margin',
    });
  });
});
