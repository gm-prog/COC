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
import { MAX_SPEED_UP_SECONDS } from '../src/config/types.js';
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

describe('speedUpCost — exact integer interpolation', () => {
  /**
   * A small, valid table whose midpoint is an exact half-gem: 1 s -> 1 gem,
   * 3 s -> 2 gems, so 2 s is 1.5 gems. Cloned from the fixture so the shared
   * config other tests read is untouched.
   */
  const halfGemConfig = () => {
    const clone = JSON.parse(JSON.stringify(config)) as typeof config;
    clone.economy.speedUp = {
      anchors: [
        { seconds: 1, gems: 1 },
        { seconds: 3, gems: 2 },
      ],
      minimumGems: 1,
    };
    return clone;
  };

  it('returns the configured price at every anchor', () => {
    const small = halfGemConfig();
    expect(speedUpCost(1000, small)).toBe(1);
    expect(speedUpCost(3000, small)).toBe(2);

    // The production anchors are unchanged: at each of them the interpolation
    // must reproduce the configured value exactly, not merely a rounded one.
    for (const [ms, gems] of [
      [60_000, 1],
      [3_600_000, 20],
      [86_400_000, 260],
      [604_800_000, 1000],
    ] as [number, number][]) {
      expect(speedUpCost(ms, config), `${ms} ms`).toBe(gems);
    }
  });

  it('rounds an exact half gem upward', () => {
    // 2 s sits exactly halfway between 1 s and 3 s: 1.5 gems -> 2.
    expect(speedUpCost(2000, halfGemConfig())).toBe(2);
  });

  it('rounds one millisecond either side of the halfway point correctly', () => {
    const small = halfGemConfig();
    // 1 ms below halfway is 1.4995 gems -> 1.
    expect(speedUpCost(1999, small)).toBe(1);
    // 1 ms above halfway is 1.5005 gems -> 2.
    expect(speedUpCost(2001, small)).toBe(2);
    // The production table's 60 s -> 1 h segment also has an exact .5 midpoint:
    // 1,830,000 ms is 10.5 gems, so 1 ms below rounds down to 10 and the
    // halfway point itself rounds up to 11.
    expect(speedUpCost(1_829_999, config)).toBe(10);
    expect(speedUpCost(1_830_000, config)).toBe(11);
    expect(speedUpCost(1_830_001, config)).toBe(11);
  });

  it('interpolates correctly immediately before and after an anchor', () => {
    // Approaching 1 h from below stays at 20; just past it stays at 20.
    expect(speedUpCost(3_599_999, config)).toBe(20);
    expect(speedUpCost(3_600_000, config)).toBe(20);
    expect(speedUpCost(3_600_001, config)).toBe(20);

    // One hour past the 1 h anchor: 20 + 240 * 3,600,000 / 82,800,000 = 30.43.
    expect(speedUpCost(7_200_000, config)).toBe(30);
  });

  it('still respects the configured minimum', () => {
    const small = halfGemConfig();
    expect(speedUpCost(0, small)).toBe(1);
    expect(speedUpCost(1, small)).toBe(1);
    expect(speedUpCost(999, small)).toBe(1);
  });

  it('always returns a safe integer', () => {
    const small = halfGemConfig();
    for (let ms = 0; ms <= 4_000; ms += 1) {
      const gems = speedUpCost(ms, small);
      expect(Number.isInteger(gems), `${ms} ms produced ${gems}`).toBe(true);
      expect(Number.isSafeInteger(gems), `${ms} ms produced ${gems}`).toBe(true);
    }
    for (let ms = 0; ms <= 700_000_000; ms += 60_000) {
      expect(Number.isSafeInteger(speedUpCost(ms, config)), `${ms} ms`).toBe(true);
    }
  });

  it('keeps the documented behaviour for invalid durations', () => {
    expect(speedUpCost(Number.NaN, config)).toBe(1);
    expect(speedUpCost(Number.POSITIVE_INFINITY, config)).toBe(1);
    expect(speedUpCost(-1, config)).toBe(1);
    expect(speedUpCost(-1_000_000, config)).toBe(1);
  });

  it('stays deterministic and pure across repeated calls', () => {
    const small = halfGemConfig();
    const first = speedUpCost(2500, small);
    for (let call = 0; call < 5; call += 1) {
      expect(speedUpCost(2500, small)).toBe(first);
    }
    // Repeated calls do not mutate the config the caller passed in.
    expect(small.economy.speedUp.anchors).toEqual([
      { seconds: 1, gems: 1 },
      { seconds: 3, gems: 2 },
    ]);
  });
});

describe('speedUpCost — anchors at the validated arithmetic limit', () => {
  /**
   * The largest span validation admits. Its millisecond form is the biggest
   * exact integer the curve can compare against; one second further would be a
   * non-safe integer, and a hand-built config far above it becomes `Infinity`,
   * which `BigInt` refuses.
   */
  function atLimitConfig() {
    const clone = JSON.parse(JSON.stringify(config)) as typeof config;
    clone.economy.speedUp = {
      anchors: [
        { seconds: 1, gems: 1 },
        { seconds: MAX_SPEED_UP_SECONDS, gems: 2 },
      ],
      minimumGems: 1,
    };
    return clone;
  }

  it('keeps the millisecond conversion exact at the limit', () => {
    const spanMs = MAX_SPEED_UP_SECONDS * 1000 - 1000;
    expect(Number.isSafeInteger(MAX_SPEED_UP_SECONDS * 1000)).toBe(true);
    // The span of this test table is even, so the halfway point is an exact
    // half-gem — which is only true if the product above is exact.
    expect(spanMs % 2).toBe(0);
  });

  it('rounds a half gem upward at the limit without throwing', () => {
    const limit = atLimitConfig();
    const spanMs = MAX_SPEED_UP_SECONDS * 1000 - 1000;
    const midpoint = 1000 + spanMs / 2;
    expect(2 * (midpoint - 1000)).toBe(spanMs);

    expect(() => speedUpCost(midpoint, limit)).not.toThrow();
    expect(speedUpCost(midpoint, limit)).toBe(2);
    expect(speedUpCost(midpoint - 1, limit)).toBe(1);
    expect(speedUpCost(midpoint + 1, limit)).toBe(2);
  });

  it('still clamps below and above the limit table', () => {
    const limit = atLimitConfig();
    expect(speedUpCost(0, limit)).toBe(1);
    expect(speedUpCost(1000, limit)).toBe(1);
    expect(speedUpCost(MAX_SPEED_UP_SECONDS * 1000, limit)).toBe(2);
    expect(speedUpCost(MAX_SPEED_UP_SECONDS * 1000 + 1, limit)).toBe(2);
    expect(speedUpCost(Number.MAX_SAFE_INTEGER, limit)).toBe(2);
  });

  it('returns a safe integer everywhere along the limit table', () => {
    const limit = atLimitConfig();
    for (const ms of [
      0,
      1,
      1000,
      1001,
      5_000_000_000,
      4_503_599_627_370_500,
      MAX_SPEED_UP_SECONDS * 1000 - 1,
      MAX_SPEED_UP_SECONDS * 1000,
    ]) {
      const gems = speedUpCost(ms, limit);
      expect(Number.isSafeInteger(gems), `${ms} ms produced ${gems}`).toBe(true);
      expect(gems).toBeGreaterThanOrEqual(1);
      expect(gems).toBeLessThanOrEqual(2);
    }
  });

  it('leaves the production curve untouched', () => {
    // Every production anchor, and the two documented midpoints.
    for (const [ms, gems] of [
      [60_000, 1],
      [3_600_000, 20],
      [86_400_000, 260],
      [604_800_000, 1000],
    ] as [number, number][]) {
      expect(speedUpCost(ms, config), `${ms} ms`).toBe(gems);
    }
    expect(speedUpCost(1_830_000, config)).toBe(11);
    expect(speedUpCost(1_829_999, config)).toBe(10);
    expect(speedUpCost(12_345_678, config)).toBe(speedUpCost(12_345_678, config));
  });
});

describe('speedUpCost — malformed hand-built curves (D34)', () => {
  /**
   * Builds a config that never went through `validateGameConfig`, which is the
   * only way to reach `speedUpCost` with anchors the schema would reject.
   */
  function handBuilt(anchors: { seconds: number; gems: number }[], minimumGems = 1) {
    const clone = JSON.parse(JSON.stringify(config)) as typeof config;
    clone.economy.speedUp = { anchors, minimumGems };
    return clone;
  }

  it('does not throw when an anchor converts to an infinite span', () => {
    // Number.MAX_VALUE * 1000 === Infinity, so the span of this segment is
    // Infinity and `BigInt(span)` used to raise a native RangeError.
    expect(Number.MAX_VALUE * 1000).toBe(Number.POSITIVE_INFINITY);
    const broken = handBuilt([
      { seconds: 1, gems: 1 },
      { seconds: Number.MAX_VALUE, gems: 2 },
    ]);

    for (const ms of [0, 1_000, 1_001, 5_000, 3_600_000, 1e12]) {
      expect(() => speedUpCost(ms, broken), `${ms} ms threw`).not.toThrow();
    }
  });

  it('falls back to the last usable anchor', () => {
    // The unusable anchor is dropped, so the curve is flat at the last anchor
    // that has an exact millisecond position.
    const broken = handBuilt([
      { seconds: 1, gems: 1 },
      { seconds: Number.MAX_VALUE, gems: 2 },
    ]);

    expect(speedUpCost(5_000, broken)).toBe(1);
    expect(speedUpCost(3_600_000, broken)).toBe(1);
    expect(speedUpCost(1e12, broken)).toBe(1);
    // Below and at the surviving anchor the behaviour is unchanged.
    expect(speedUpCost(0, broken)).toBe(1);
    expect(speedUpCost(1_000, broken)).toBe(1);
  });

  it('returns a safe integer for the malformed curve', () => {
    const broken = handBuilt([
      { seconds: 1, gems: 1 },
      { seconds: Number.MAX_VALUE, gems: 2 },
    ]);

    for (const ms of [0, 1_000, 5_000, 1e9, 1e12]) {
      const gems = speedUpCost(ms, broken);
      expect(Number.isSafeInteger(gems), `${ms} ms produced ${gems}`).toBe(true);
      expect(gems).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns minimumGems when no anchor is usable', () => {
    const broken = handBuilt(
      [
        { seconds: Number.MAX_VALUE, gems: 2 },
        { seconds: Number.POSITIVE_INFINITY, gems: 3 },
      ],
      7,
    );

    for (const ms of [0, 5_000, 1e12]) {
      expect(speedUpCost(ms, broken)).toBe(7);
    }
  });

  it('drops an anchor with an unusable price but keeps the valid ones', () => {
    const broken = handBuilt([
      { seconds: 10, gems: 5 },
      { seconds: 20, gems: Number.NaN },
      { seconds: 30, gems: 15 },
    ]);

    // 10 s and 30 s survive, so the curve is unchanged between them.
    expect(speedUpCost(10_000, broken)).toBe(5);
    expect(speedUpCost(20_000, broken)).toBe(10);
    expect(speedUpCost(30_000, broken)).toBe(15);
    expect(Number.isSafeInteger(speedUpCost(20_000, broken))).toBe(true);
  });

  it('is deterministic on a malformed curve', () => {
    const broken = handBuilt([
      { seconds: 1, gems: 1 },
      { seconds: Number.MAX_VALUE, gems: 2 },
    ]);
    const first = speedUpCost(5_000, broken);
    for (let i = 0; i < 100; i += 1) expect(speedUpCost(5_000, broken)).toBe(first);
  });

  it('leaves the validated production curve untouched by the guard', () => {
    // Same expectations as the unguarded path: every anchor, both midpoints.
    expect(speedUpCost(60_000, config)).toBe(1);
    expect(speedUpCost(3_600_000, config)).toBe(20);
    expect(speedUpCost(86_400_000, config)).toBe(260);
    expect(speedUpCost(604_800_000, config)).toBe(1000);
    expect(speedUpCost(1_830_000, config)).toBe(11);
    expect(speedUpCost(1_829_999, config)).toBe(10);
    expect(speedUpCost(2_000, config)).toBe(1);
    expect(speedUpCost(Number.NaN, config)).toBe(1);
  });
});
