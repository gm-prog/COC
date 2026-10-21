import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { createNewPlayerState, type PlayerState } from '@coc/sim-core';
import { isReadOnlyVillage, runVillageAction } from '../src/villageActions';
import type { SaveProblem, SaveProblemCode } from '../src/persistence/villageSave';
import type { GameCommand } from '@coc/sim-core';

const START = 1_700_000_000_000;

function freshState(): PlayerState {
  return createNewPlayerState(GAME_CONFIG, START);
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function placement(): GameCommand {
  return {
    id: 'place-1',
    type: 'PlaceBuilding',
    payload: { buildingType: 'gold_mine', x: 24, y: 24 },
  };
}

describe('read-only village sessions', () => {
  it('treats only a backwards clock as read-only', () => {
    const problem = (code: SaveProblemCode): SaveProblem => ({ code, message: code });

    expect(isReadOnlyVillage(problem('clock_behind'))).toBe(true);

    // A broken record is *not* read-only: the player gets a fresh in-memory
    // village, and playing on is the honest behaviour there.
    for (const code of [
      'malformed',
      'unsupported_schema',
      'incompatible_config',
      'storage_unavailable',
    ] as const) {
      expect(isReadOnlyVillage(problem(code)), code).toBe(false);
    }
    expect(isReadOnlyVillage(null)).toBe(false);
  });

  it('refuses every command-backed action and leaves the state untouched', () => {
    const state = freshState();
    const before = copy(state);
    const context = { config: GAME_CONFIG, now: state.lastSyncAt, readOnly: true };

    const commands: GameCommand[] = [
      placement(),
      { id: 'upgrade-1', type: 'StartUpgrade', payload: { buildingId: state.buildings[0]!.id } },
      { id: 'collect-1', type: 'CollectResource', payload: { buildingId: state.buildings[1]!.id } },
      // Even a command the engine would reject is refused *before* the rules
      // run: the gate is not a side effect of the command being invalid.
      { id: 'upgrade-bogus', type: 'StartUpgrade', payload: { buildingId: 999_999 } },
    ];

    for (const command of commands) {
      expect(runVillageAction(state, command, context), command.type).toEqual({
        ok: false,
        reason: 'read_only',
      });
    }

    expect(state).toEqual(before);
    expect(state).toBe(state);
  });

  it('does not hand back a mutated state a forgetful caller could adopt', () => {
    const state = freshState();
    const result = runVillageAction(state, placement(), {
      config: GAME_CONFIG,
      now: state.lastSyncAt,
      readOnly: true,
    });

    // There is no `state` on a refusal at all, so a caller cannot accidentally
    // assign "the result of a refused action" to the running village.
    expect('state' in result).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('still lets the engine accept the same commands when the session is writable', () => {
    const state = freshState();
    const context = { config: GAME_CONFIG, now: START, readOnly: false };

    const placed = runVillageAction(state, placement(), context);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.state.buildings).toHaveLength(state.buildings.length + 1);
    expect(placed.events.some((event) => event.type === 'BuildingPlaced')).toBe(true);
    // Purity: the input was not mutated in place.
    expect(state.buildings).toHaveLength(createNewPlayerState(GAME_CONFIG, START).buildings.length);
  });

  it('reports a rule rejection distinctly from a read-only refusal', () => {
    const state = freshState();
    const rejected = runVillageAction(
      state,
      { id: 'upgrade-bogus', type: 'StartUpgrade', payload: { buildingId: 999_999 } },
      { config: GAME_CONFIG, now: START, readOnly: false },
    );

    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toBe('rejected');
    if (rejected.reason !== 'rejected') return;
    expect(rejected.error.code).toBe('not_found');
  });
});
