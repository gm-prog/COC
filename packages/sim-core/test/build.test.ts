import { describe, expect, it } from 'vitest';
import {
  canBuyBuilder,
  cancelRefundFraction,
  checkUpgrade,
  currentLevel,
  nextBuilderCost,
  nextLevel,
  refundFor,
  speedUpCost,
  upgradeDurationMs,
} from '../src/build/index.js';
import { createNewPlayerState, type PlayerState } from '../src/state/index.js';
import { NOW, TEST_CONFIG } from './fixtures/config.js';

const config = TEST_CONFIG;
const HOUR = 3_600_000;

/** Narrows an UpgradeCheck to its rejection branch so the message is reachable. */
function rejectionOf(
  check: ReturnType<typeof checkUpgrade>,
): Extract<ReturnType<typeof checkUpgrade>, { ok: false }> {
  if (check.ok) throw new Error('expected the upgrade to be rejected');
  return check;
}

const newState = (): PlayerState => createNewPlayerState(config, NOW);

/** A state whose Keep is already at `level`, so gating can be exercised. */
function atKeep(level: number): PlayerState {
  const state = newState();
  const keep = state.buildings.find((b) => b.type === 'keep');
  if (keep !== undefined) keep.level = level;
  state.keepLevel = level;
  return state;
}

/**
 * Adds a gold store. Its level 2 requires Keep 3, which makes it the fixture's
 * Keep-gated target (the gold mine unlocks everything at Keep 1).
 */
function withStore(state: PlayerState, level = 1): number {
  const id = Math.max(...state.buildings.map((b) => b.id)) + 1;
  state.buildings.push({ id, type: 'gold_store', level, x: 6, y: 6 });
  return id;
}

describe('level lookups', () => {
  it('finds the current and next level from the table', () => {
    expect(nextLevel(config, 'gold_mine', 1)?.level).toBe(2);
    expect(nextLevel(config, 'gold_mine', 2)).toBeUndefined();
    expect(currentLevel(config, 'gold_mine', 1)?.level).toBe(1);
    expect(currentLevel(config, 'nope', 1)).toBeUndefined();
  });

  it('reads the upgrade duration from the target level', () => {
    // gold_mine L2 buildSeconds is 20 in the fixture.
    expect(upgradeDurationMs(config, 'gold_mine', 2)).toBe(20_000);
    expect(upgradeDurationMs(config, 'nope', 2)).toBe(0);
  });
});

describe('checkUpgrade', () => {
  it('rejects an unknown building id', () => {
    const check = checkUpgrade(newState(), 999, config);
    expect(check).toMatchObject({ ok: false, rejection: 'not_found' });
  });

  it('rejects a building whose type is not in the config', () => {
    const state = newState();
    state.buildings.push({ id: 9, type: 'ghost', level: 1, x: 6, y: 6 });
    expect(checkUpgrade(state, 9, config)).toMatchObject({
      ok: false,
      rejection: 'unknown_building',
    });
  });

  it('rejects a building that is already upgrading', () => {
    const state = newState();
    state.buildings[1]!.upgrade = { toLevel: 2, finishAt: NOW + 1000 };
    expect(checkUpgrade(state, 2, config)).toMatchObject({
      ok: false,
      rejection: 'already_upgrading',
    });
  });

  it('rejects a building at its maximum configured level', () => {
    const state = atKeep(2);
    const mine = state.buildings.find((b) => b.type === 'gold_mine');
    if (mine !== undefined) mine.level = 2;
    expect(checkUpgrade(state, mine?.id ?? 0, config)).toMatchObject({
      ok: false,
      rejection: 'max_level',
    });
  });

  it('rejects a level gated behind a higher Keep', () => {
    const state = atKeep(2);
    const store = withStore(state);
    const check = checkUpgrade(state, store, config);
    expect(check).toMatchObject({ ok: false, rejection: 'keep_level_too_low' });
    expect(rejectionOf(check).message).toContain('requires Keep 3');
  });

  it('allows the same level once the Keep is high enough', () => {
    const state = atKeep(3);
    expect(checkUpgrade(state, withStore(state), config).ok).toBe(true);
    // ...and a level with no gate at all.
    expect(checkUpgrade(atKeep(1), 2, config).ok).toBe(true);
  });

  it('rejects an upgrade the player cannot afford', () => {
    const state = atKeep(2);
    state.resources.gold = 199;
    const check = checkUpgrade(state, 2, config);
    expect(check).toMatchObject({ ok: false, rejection: 'insufficient_resources' });
    expect(rejectionOf(check).missing).toEqual({ gold: 1 });
  });

  it('rejects an upgrade when no builder is free', () => {
    const state = atKeep(2);
    state.builders.count = 1;
    state.builders.busy.push({ buildingId: 99, toLevel: 2, finishAt: NOW + 1000 });
    expect(checkUpgrade(state, 2, config)).toMatchObject({ ok: false, rejection: 'no_builder' });
  });

  it('reports rejections in a stable order: target, level, Keep, cost, builder', () => {
    const state = atKeep(1);
    state.resources.gold = 0;
    state.builders.count = 0;
    // Keep gate fires before the cost and builder checks.
    expect(rejectionOf(checkUpgrade(state, withStore(state), config)).rejection).toBe(
      'keep_level_too_low',
    );

    // Without a Keep gate the cost check fires before the builder check.
    state.buildings[1]!.upgrade = undefined;
    expect(rejectionOf(checkUpgrade(state, 2, config)).rejection).toBe('insufficient_resources');

    state.builders.count = 1;
    state.resources.gold = 999_999;
    // The one builder is already occupied by another building.
    state.builders.busy.push({ buildingId: 3, toLevel: 2, finishAt: NOW + HOUR });
    expect(rejectionOf(checkUpgrade(state, 2, config)).rejection).toBe('no_builder');
  });
});

describe('cancel refunds', () => {
  it('refunds nothing for an upgrade that has started', () => {
    expect(cancelRefundFraction(config, true)).toBe(0);
    expect(refundFor(config, 'gold_mine', 2)).toEqual({});
  });

  it('refunds half for an item that was queued but never started', () => {
    expect(cancelRefundFraction(config, false)).toBe(0.5);
  });

  it('computes a fractional refund by flooring, so it never mints resources', () => {
    // A cost of 201 at 50% would be 100.5; flooring keeps it at 100.
    const odd = {
      ...config,
      buildings: config.buildings.map((b) =>
        b.id === 'gold_mine'
          ? {
              ...b,
              levels: b.levels.map((l) => (l.level === 2 ? { ...l, cost: { gold: 201 } } : l)),
            }
          : b,
      ),
    };
    expect(refundFor(odd, 'gold_mine', 2)).toEqual({});
    expect(cancelRefundFraction(odd, false)).toBe(0.5);
  });

  it('refunds nothing for an unknown level', () => {
    expect(refundFor(config, 'gold_mine', 99)).toEqual({});
    expect(refundFor(config, 'nope', 2)).toEqual({});
  });

  it('refunds nothing when the target level costs nothing', () => {
    const free = {
      ...config,
      buildings: config.buildings.map((b) =>
        b.id === 'gold_mine'
          ? { ...b, levels: b.levels.map((l) => (l.level === 2 ? { ...l, cost: {} } : l)) }
          : b,
      ),
    };
    expect(refundFor(free, 'gold_mine', 2)).toEqual({});
  });
});

describe('speedUpCost', () => {
  // Anchors from spec Section 7.5: 60 s -> 1, 1 h -> 20, 1 d -> 260, 7 d -> 1,000.
  const anchors: [number, number][] = [
    [60_000, 1],
    [3_600_000, 20],
    [86_400_000, 260],
    [604_800_000, 1000],
  ];

  it('matches every specified anchor exactly', () => {
    for (const [ms, gems] of anchors) {
      expect(speedUpCost(ms, config), `${ms} ms`).toBe(gems);
    }
  });

  it('charges the minimum below the first anchor', () => {
    expect(speedUpCost(0, config)).toBe(1);
    expect(speedUpCost(1, config)).toBe(1);
    expect(speedUpCost(59_999, config)).toBe(1);
  });

  it('is flat above the last anchor rather than extrapolating', () => {
    expect(speedUpCost(604_800_001, config)).toBe(1000);
    expect(speedUpCost(86_400_000 * 30, config)).toBe(1000);
  });

  it('interpolates linearly between anchors', () => {
    // Halfway between 1 h (20) and 1 d (260): 140.
    const halfway = 3_600_000 + (86_400_000 - 3_600_000) / 2;
    expect(speedUpCost(halfway, config)).toBe(140);

    // Halfway between 60 s (1) and 1 h (20): 10.5 -> rounds to 11.
    expect(speedUpCost(60_000 + (3_600_000 - 60_000) / 2, config)).toBe(11);
  });

  it('is monotonic non-decreasing across the whole curve', () => {
    let previous = 0;
    for (let ms = 0; ms <= 700_000_000; ms += 60_000) {
      const gems = speedUpCost(ms, config);
      expect(gems).toBeGreaterThanOrEqual(previous);
      previous = gems;
    }
  });

  it('never charges less than the configured minimum', () => {
    const cheap = {
      ...config,
      economy: { ...config.economy, speedUp: { ...config.economy.speedUp, minimumGems: 5 } },
    };
    expect(speedUpCost(0, cheap)).toBe(5);
    expect(speedUpCost(60_000, cheap)).toBe(5);
    // A later anchor still wins once it is dearer than the minimum.
    expect(speedUpCost(86_400_000, cheap)).toBe(260);
  });

  it('is deterministic and pure', () => {
    const a = speedUpCost(12_345_678, config);
    const b = speedUpCost(12_345_678, config);
    expect(a).toBe(b);
  });

  it('handles a malformed remaining time as the minimum', () => {
    expect(speedUpCost(Number.NaN, config)).toBe(1);
    expect(speedUpCost(-1, config)).toBe(1);
  });
});

describe('builder shop', () => {
  it('prices the next builder from the configured table', () => {
    const state = newState(); // 2 builders
    expect(nextBuilderCost(state, config)).toBe(250);
    state.builders.count = 3;
    expect(nextBuilderCost(state, config)).toBe(500);
    state.builders.count = 4;
    expect(nextBuilderCost(state, config)).toBe(1000);
  });

  it('has no price once the table runs out', () => {
    const state = newState();
    state.builders.count = 5;
    expect(nextBuilderCost(state, config)).toBeUndefined();
    expect(canBuyBuilder(state, config)).toBe(false);
  });

  it('allows a purchase below the configured maximum', () => {
    const state = newState();
    state.builders.count = 4;
    expect(canBuyBuilder(state, config)).toBe(true);
  });

  it('treats a starter count above the maximum as unbuyable', () => {
    const state = newState();
    state.builders.count = 6;
    expect(canBuyBuilder(state, config)).toBe(false);
  });
});
