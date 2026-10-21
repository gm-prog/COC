import { describe, expect, it } from 'vitest';
import { clonePlayerState, createNewPlayerState, hashState, type PlayerState } from '@coc/sim-core';
import { GAME_CONFIG } from '@coc/game-data';
import {
  extendWallPath,
  planWallStroke,
  wallStrokeFeedback,
  wallStrokeReasonKey,
  type WallTile,
} from '../src/villageWallPlacement';
import { cancelInteraction, IDLE_INTERACTION, placementInteraction } from '../src/villageMove';
import { previewBuildingPlacement } from '../src/villagePlacement';
import { t } from '../src/i18n';

/**
 * Drag-to-place walls is a client interaction over the unchanged `PlaceBuilding`
 * command. These tests therefore never re-derive placement rules: every expected
 * rejection code is the one `sim-core` produces (covered exhaustively in
 * `packages/sim-core/test/commands.test.ts`). What is tested here is the part
 * this slice adds — the tile trail, the rolling plan, and the honest feedback.
 *
 * The pointer lifecycle (Escape/Cancel discarding a draft, pinch aborting one,
 * and a release committing exactly the drawn prefix) is browser behaviour and is
 * proven by `e2e/phase3-wall-drag.spec.ts`; there is no Phaser in this suite.
 */

const START = 1_700_000_000_000;

/** The configured starter: Keep 1, which cannot build walls. */
function starter(): PlayerState {
  return createNewPlayerState(GAME_CONFIG, START);
}

/**
 * A Keep 2 village, which is the first Keep the config permits walls at.
 *
 * Only the two fields that encode "the Keep finished upgrading" change; the
 * starter layout, obstacles, resources and builders stay as configured. This is
 * the same shape the browser fixture seeds, and it is deliberately *not* a new
 * balance rule.
 */
function keepTwo(): PlayerState {
  const state = clonePlayerState(starter());
  const keep = state.buildings.find((building) => building.type === 'keep');
  if (!keep) throw new Error('the starter has no Keep');
  keep.level = 2;
  state.keepLevel = 2;
  return state;
}

/** A free row inside the buildable core, clear of the Keep, mines and obstacles. */
const WALL_ROW: WallTile[] = [
  { x: 14, y: 26 },
  { x: 15, y: 26 },
  { x: 16, y: 26 },
];

function plan(
  path: readonly WallTile[],
  state: PlayerState = keepTwo(),
  options: { now?: number; readOnly?: boolean; buildingType?: string } = {},
) {
  return planWallStroke({
    state,
    config: GAME_CONFIG,
    buildingType: options.buildingType ?? 'wall',
    path,
    now: options.now ?? START,
    readOnly: options.readOnly ?? false,
  });
}

function planned(result: ReturnType<typeof plan>) {
  if (result.kind !== 'planned') throw new Error(`expected a plan, got ${result.kind}`);
  return result;
}

/** True when two tiles share an edge (never just a corner) in the square grid. */
function orthogonallyAdjacent(a: WallTile, b: WallTile): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function wallAt(state: PlayerState, tile: WallTile): boolean {
  return state.buildings.some(
    (building) => building.type === 'wall' && building.x === tile.x && building.y === tile.y,
  );
}

describe('the configured rules this interaction runs on', () => {
  it('locks walls behind Keep 2 and keeps them 1×1 for 10 Gold and 5 seconds', () => {
    const wall = GAME_CONFIG.buildings.find((definition) => definition.id === 'wall');
    expect(wall).toBeDefined();
    expect(wall?.size).toEqual({ w: 1, h: 1 });
    expect(wall?.unlock.keepLevel).toBe(2);
    expect(wall?.levels[0]?.cost).toEqual({ gold: 10 });
    expect(wall?.levels[0]?.buildSeconds).toBe(5);
  });

  it('allows 25 walls at Keep 2 and none at Keep 1', () => {
    const limits = GAME_CONFIG.limits.buildingCounts.wall;
    expect(limits?.[1]).toBe(0);
    expect(limits?.[2]).toBe(25);
  });

  it('gives the starter Keep 1, so a fresh village cannot draw a wall', () => {
    const fresh = starter();
    expect(fresh.keepLevel).toBe(1);
    expect(planned(plan(WALL_ROW.slice(0, 1), fresh)).rejected?.errorCode).toBe(
      'keep_level_too_low',
    );
  });
});

describe('stroke path', () => {
  it('starts at the first tile and appends neighbours in order', () => {
    expect(extendWallPath([], { x: 10, y: 10 })).toEqual([{ x: 10, y: 10 }]);

    const path = extendWallPath(extendWallPath([], { x: 10, y: 10 }), { x: 13, y: 10 });
    expect(path).toEqual([
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
      { x: 13, y: 10 },
    ]);
  });

  it('fills the cells a fast pointer jumped over, so there are no holes', () => {
    const jumped = extendWallPath([{ x: 4, y: 6 }], { x: 9, y: 6 });
    expect(jumped.map((tile) => tile.x)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(extendWallPath([], { x: 4, y: 6 })).toHaveLength(1);
  });

  it('turns a diagonal delta into an L with a documented tie-break (x first)', () => {
    const path = extendWallPath([{ x: 10, y: 10 }], { x: 12, y: 12 });

    expect(path).toEqual([
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
      { x: 12, y: 11 },
      { x: 12, y: 12 },
    ]);

    for (let index = 1; index < path.length; index += 1) {
      expect(
        orthogonallyAdjacent(path[index - 1]!, path[index]!),
        `${JSON.stringify(path[index - 1])} → ${JSON.stringify(path[index])}`,
      ).toBe(true);
    }
  });

  it('keeps every step orthogonal across a long, irregular drag', () => {
    const samples: WallTile[] = [
      { x: 10, y: 10 },
      { x: 18, y: 10 },
      { x: 18, y: 16 },
      { x: 12, y: 16 },
      { x: 12, y: 20 },
      { x: 24, y: 20 },
    ];

    const path = samples.reduce<WallTile[]>((trail, tile) => extendWallPath(trail, tile), []);

    for (let index = 1; index < path.length; index += 1) {
      expect(
        orthogonallyAdjacent(path[index - 1]!, path[index]!),
        `step ${index} of ${path.length}`,
      ).toBe(true);
    }
    expect(path[0]).toEqual(samples[0]);
    expect(path.at(-1)).toEqual(samples.at(-1));
  });

  it('includes a tile once, however often the pointer crosses or dwells on it', () => {
    const trail = [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
      { x: 11, y: 10 },
      { x: 10, y: 10 },
      { x: 11, y: 10 },
    ].reduce<WallTile[]>((path, tile) => extendWallPath(path, tile), []);

    expect(trail).toEqual([
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
    ]);
  });

  it('is deterministic: sparse samples and dense samples of one line agree', () => {
    const sparse = extendWallPath(extendWallPath([], { x: 10, y: 10 }), { x: 14, y: 10 });
    const dense = [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
      { x: 13, y: 10 },
      { x: 14, y: 10 },
    ].reduce<WallTile[]>((path, tile) => extendWallPath(path, tile), []);

    expect(dense).toEqual(sparse);
  });

  it('does not modify the trail it is given', () => {
    const before: WallTile[] = [{ x: 10, y: 10 }];
    const frozen = before.map((tile) => ({ ...tile }));
    extendWallPath(before, { x: 14, y: 10 });
    expect(before).toEqual(frozen);
  });
});

describe('planning a stroke against the command', () => {
  it('accepts more than one wall and applies cost, occupancy and builder once each', () => {
    const state = keepTwo();
    const result = planned(plan([WALL_ROW[0]!, WALL_ROW[1]!], state));

    expect(result.accepted).toEqual([WALL_ROW[0], WALL_ROW[1]]);
    expect(result.rejected).toBeNull();
    expect(result.changed).toBe(true);

    // One 10-Gold construction per accepted segment, not per stroke.
    expect(state.resources.gold).toBe(1000);
    expect(result.state.resources.gold).toBe(980);
    expect(result.state.builders.busy).toHaveLength(2);
    expect(result.state.builders.busy.map((assignment) => assignment.finishAt)).toEqual([
      START + 5_000,
      START + 5_000,
    ]);
    expect(wallAt(result.state, WALL_ROW[0]!)).toBe(true);
    expect(wallAt(result.state, WALL_ROW[1]!)).toBe(true);
    // Same instant, so nothing has completed: each wall is one construction.
    expect(result.state.buildings.filter((building) => building.type === 'wall')).toHaveLength(2);
  });

  it('never mutates the state it previews (hashState is unchanged)', () => {
    const state = keepTwo();
    const before = hashState(state);

    const preview = planned(plan(WALL_ROW, state));
    expect(preview.accepted).toHaveLength(2); // builder limit stops the third
    expect(hashState(state)).toBe(before);
    expect(wallAt(state, WALL_ROW[0]!)).toBe(false);
  });

  it('re-plans identically for a preview and a release at the same instant', () => {
    const state = keepTwo();
    const near = planned(plan(WALL_ROW.slice(0, 2), state));
    const release = planned(plan(WALL_ROW.slice(0, 2), state));

    expect(release.accepted).toEqual(near.accepted);
    expect(release.rejected).toEqual(near.rejected);
    expect(hashState(release.state)).toBe(hashState(near.state));
  });

  it('stops at the first refused tile and keeps the accepted prefix', () => {
    const state = keepTwo();
    const result = planned(
      plan(
        [
          { x: 14, y: 27 },
          { x: 18, y: 18 },
          { x: 16, y: 27 },
        ],
        state,
      ),
    );

    // (18,18) is the Keep: the second candidate is the first refusal, and the
    // third is never reached.
    expect(result.accepted).toEqual([{ x: 14, y: 27 }]);
    expect(result.rejected).toEqual({ tile: { x: 18, y: 18 }, errorCode: 'overlapping' });
    expect(wallAt(result.state, { x: 14, y: 27 })).toBe(true);
    expect(wallAt(result.state, { x: 16, y: 27 })).toBe(false);
    expect(result.state.buildings.filter((building) => building.type === 'wall')).toHaveLength(1);
  });

  it.each([
    {
      name: 'an obstacle',
      tile: { x: 6, y: 20 },
      state: () => keepTwo(),
      code: 'overlapping',
    },
    {
      name: 'the decorative margin',
      tile: { x: 1, y: 10 },
      state: () => keepTwo(),
      code: 'margin',
    },
    {
      name: 'outside the map',
      tile: { x: 60, y: 20 },
      state: () => keepTwo(),
      code: 'out_of_bounds',
    },
    {
      name: 'an unaffordable wall',
      tile: { x: 15, y: 28 },
      state: () => {
        const state = keepTwo();
        state.resources.gold = 5;
        return state;
      },
      code: 'insufficient_resources',
    },
    {
      name: 'no free builder',
      tile: { x: 15, y: 28 },
      state: () => {
        const state = keepTwo();
        state.builders.busy = [
          { buildingId: 1, toLevel: 2, finishAt: START + 10_000 },
          { buildingId: 2, toLevel: 2, finishAt: START + 10_000 },
        ];
        return state;
      },
      code: 'no_builder',
    },
    {
      name: 'the Keep gate',
      tile: { x: 15, y: 28 },
      state: () => starter(),
      code: 'keep_level_too_low',
    },
    {
      name: 'the wall ceiling',
      tile: { x: 15, y: 28 },
      state: () => {
        const state = keepTwo();
        // Keep 2 allows 25 walls; one more must be refused by the limit.
        for (let index = 0; index < 25; index += 1) {
          state.buildings.push({
            id: 200 + index,
            type: 'wall',
            level: 1,
            x: 4 + index,
            y: 40,
          });
        }
        return state;
      },
      code: 'building_limit_reached',
    },
  ])('stops at $name with the command’s own code', ({ tile, state, code }) => {
    const built = state();
    const result = planned(plan([tile], built));

    expect(result.accepted).toEqual([]);
    expect(result.rejected?.errorCode).toBe(code);
    expect(result.changed).toBe(false);
  });

  it('changes nothing at all when the first candidate is refused', () => {
    const state = keepTwo();
    const before = hashState(state);

    const result = planned(plan([{ x: 18, y: 20 }], state));

    expect(result.changed).toBe(false);
    expect(result.state).toBe(state); // the input object, not a clone
    expect(hashState(state)).toBe(before);
    // The scene persists only when `changed` is true, so zero accepted segments
    // cannot queue a save.
    expect(result.accepted).toHaveLength(0);
  });

  it('reports an exact prefix count and reason for a partial stroke', () => {
    const result = planned(plan(WALL_ROW, keepTwo()));
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual({ tile: WALL_ROW[2]!, errorCode: 'no_builder' });

    const feedback = wallStrokeFeedback(result);
    expect(feedback).not.toBeNull();
    expect(t(feedback!.key, feedback!.params)).toBe(
      'Placed 2 wall segments, then stopped: all builders are busy.',
    );
  });

  it('reports a single segment without pretending the rest was built', () => {
    const result = planned(
      plan(
        [
          { x: 14, y: 28 },
          { x: 18, y: 19 },
        ],
        keepTwo(),
      ),
    );
    const feedback = wallStrokeFeedback(result);
    expect(feedback).not.toBeNull();
    expect(t(feedback!.key, feedback!.params)).toBe(
      'Placed a wall segment, then stopped: that tile is already taken.',
    );
  });

  it('reports a fully accepted stroke as a count', () => {
    const result = planned(plan(WALL_ROW.slice(0, 2), keepTwo()));
    const feedback = wallStrokeFeedback(result);
    expect(t(feedback!.key, feedback!.params)).toBe('Placed 2 wall segments.');
  });

  it('reports nothing placed when the very first tile is refused', () => {
    const result = planned(plan([{ x: 1, y: 10 }], keepTwo()));
    const feedback = wallStrokeFeedback(result);
    expect(t(feedback!.key, feedback!.params)).toBe(
      'No wall placed: that tile is in the decorative margin.',
    );
  });

  it('refuses a read-only session before reaching the simulation', () => {
    const state = keepTwo();
    const before = hashState(state);

    const result = plan(WALL_ROW, state, { readOnly: true });

    expect(result).toEqual({ kind: 'refused', reason: 'read_only' });
    expect(wallStrokeFeedback(result)).toBeNull();
    expect(hashState(state)).toBe(before);
  });

  it('lets a freed tile be built over, because tiles are freed, not faked', () => {
    // Clear the starter rock through the real command, then wall its tile.
    const removal = planWallStroke({
      state: keepTwo(),
      config: GAME_CONFIG,
      buildingType: 'wall',
      // Walling the rock's tile is refused while the rock exists.
      path: [{ x: 6, y: 20 }],
      now: START,
      readOnly: false,
    });
    expect(planned(removal).rejected?.errorCode).toBe('overlapping');
  });
});

describe('feedback vocabulary', () => {
  it('maps every rejection the command can produce for a placement', () => {
    expect(wallStrokeReasonKey('overlapping')).toBe('wall.reason.blocked');
    expect(wallStrokeReasonKey('margin')).toBe('wall.reason.margin');
    expect(wallStrokeReasonKey('out_of_bounds')).toBe('wall.reason.bounds');
    expect(wallStrokeReasonKey('no_builder')).toBe('wall.reason.builders');
    expect(wallStrokeReasonKey('insufficient_resources')).toBe('wall.reason.resources');
    expect(wallStrokeReasonKey('building_limit_reached')).toBe('wall.reason.limit');
    expect(wallStrokeReasonKey('keep_level_too_low')).toBe('wall.reason.keep');
    expect(wallStrokeReasonKey('invalid_rect')).toBe('wall.reason.other');
  });

  it('has a translated sentence for every reason it can show', () => {
    const keys = [
      'wall.placed',
      'wall.placedOne',
      'wall.partial',
      'wall.partialOne',
      'wall.failed',
      'wall.reason.blocked',
      'wall.reason.margin',
      'wall.reason.bounds',
      'wall.reason.builders',
      'wall.reason.resources',
      'wall.reason.limit',
      'wall.reason.keep',
      'wall.reason.other',
      'placement.wallInstructions',
    ] as const;

    for (const key of keys) {
      expect(t(key), key).not.toBe(key);
    }
  });
});

describe('the rest of the interaction is untouched', () => {
  it('keeps the interaction union exclusive and cancellable', () => {
    expect(placementInteraction('wall')).toEqual({ kind: 'placing', buildingType: 'wall' });
    expect(placementInteraction('gold_mine')).not.toEqual(placementInteraction('wall'));
    expect(cancelInteraction()).toEqual(IDLE_INTERACTION);
  });

  it('leaves ordinary building placement validating exactly as before', () => {
    const state = keepTwo();
    expect(previewBuildingPlacement(state, GAME_CONFIG, 'gold_mine', 24, 24, START).valid).toBe(
      true,
    );
    const blocked = previewBuildingPlacement(state, GAME_CONFIG, 'gold_mine', 18, 18, START);
    expect(blocked.valid).toBe(false);
    expect(blocked.valid === false && blocked.errorCode).toBe('overlapping');
  });
});
