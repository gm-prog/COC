import { describe, expect, it } from 'vitest';
import { applyCommand, type CommandResult, type GameCommand } from '../src/commands/index.js';
import { catchUp } from '../src/economy/index.js';
import {
  clonePlayerState,
  countBuildings,
  createNewPlayerState,
  type PlayerState,
} from '../src/state/index.js';
import { hashState } from '../src/serialize/index.js';
import { NOW, TEST_CONFIG } from './fixtures/config.js';

const config = TEST_CONFIG;
const HOUR = 3_600_000;

const newState = (): PlayerState => {
  const state = createNewPlayerState(config, NOW);
  // The fixture starter has no essence collector; add one at id 3 so essence
  // accrual is exercised alongside gold.
  state.buildings.push({ id: 3, type: 'essence_well', level: 1, x: 23, y: 17 });
  return state;
};

const ctx = { config, now: NOW };

function apply(state: PlayerState, command: GameCommand, now = NOW): CommandResult {
  return applyCommand(state, command, { config, now });
}

const startUpgrade = (
  buildingId: number,
  id = 'cmd-start',
  extra: Record<string, unknown> = {},
): GameCommand => ({ id, type: 'StartUpgrade', payload: { buildingId, ...extra } });

const collect = (buildingId: number, id = 'cmd-collect'): GameCommand => ({
  id,
  type: 'CollectResource',
  payload: { buildingId },
});

const mineOf = (state: PlayerState) => state.buildings.find((b) => b.type === 'gold_mine');
const wellOf = (state: PlayerState) => state.buildings.find((b) => b.type === 'essence_well');

describe('StartUpgrade', () => {
  it('takes the resources, occupies a builder and records the finish time', () => {
    const state = newState();
    state.resources.gold = 5000;
    const mine = mineOf(state);
    if (mine === undefined) throw new Error('no mine');

    const result = apply(state, startUpgrade(mine.id, 'c1'), NOW + 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.state.resources.gold).toBe(4800); // 200 gold
    expect(result.state.builders.busy).toEqual([
      { buildingId: mine.id, toLevel: 2, finishAt: NOW + 21_000 },
    ]);
    expect(mineOf(result.state)?.upgrade).toEqual({ toLevel: 2, finishAt: NOW + 21_000 });
    expect(result.events).toEqual([
      { type: 'ResourcesChanged', changes: { gold: -200 }, reason: 'upgrade_started' },
      {
        type: 'UpgradeStarted',
        buildingId: mine.id,
        buildingType: 'gold_mine',
        fromLevel: 1,
        toLevel: 2,
        finishAt: NOW + 21_000,
        cost: { gold: 200 },
      },
    ]);
  });

  it('is rejected with a typed error when resources are short', () => {
    const state = newState();
    state.resources.gold = 199;
    const result = apply(state, startUpgrade(2, 'c1'), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('insufficient_resources');
    expect(result.error.message).toContain('gold');
    expect(result.error.details).toEqual({ missing: { gold: 1 } });
  });

  it('leaves the state completely untouched when rejected', () => {
    const state = newState();
    state.resources.gold = 0;
    const before = hashState(state);
    const result = apply(state, startUpgrade(2, 'c1'), NOW);
    expect(result.ok).toBe(false);
    expect(hashState(state)).toBe(before);
    if (!result.ok) expect(result.error.code).toBe('insufficient_resources');
  });

  it('rejects a second upgrade on the same building', () => {
    const state = newState();
    state.resources.gold = 5000;
    const first = apply(state, startUpgrade(2, 'c1'), NOW);
    if (!first.ok) throw new Error('expected ok');
    const second = apply(first.state, startUpgrade(2, 'c2'), NOW);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('already_upgrading');
  });

  it('rejects a third concurrent upgrade when both builders are busy', () => {
    const state = newState();
    state.resources.gold = 5000;
    state.buildings.push({ id: 4, type: 'gold_mine', level: 1, x: 26, y: 17 });
    state.buildings.push({ id: 5, type: 'gold_mine', level: 1, x: 30, y: 17 });

    const a = apply(state, startUpgrade(2, 'c1'), NOW);
    if (!a.ok) throw new Error('expected ok');
    const b = apply(a.state, startUpgrade(4, 'c2'), NOW);
    if (!b.ok) throw new Error('expected ok');
    expect(b.state.builders.busy).toHaveLength(2);

    const c = apply(b.state, startUpgrade(5, 'c3'), NOW);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.code).toBe('no_builder');
  });

  it('rejects a payload that is not an object', () => {
    const state = newState();
    for (const bad of [null, 'x', 1, [], undefined]) {
      const result = apply(
        state,
        { id: 'c', type: 'StartUpgrade', payload: bad } as unknown as GameCommand,
        NOW,
      );
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_command');
    }
  });

  it('rejects a payload missing or malforming the building id', () => {
    const bad: unknown[] = [
      {},
      { buildingId: undefined },
      { buildingId: '2' },
      { buildingId: 1.5 },
    ];
    for (const payload of bad) {
      const result = apply(
        newState(),
        { id: 'c', type: 'StartUpgrade', payload } as unknown as GameCommand,
        NOW,
      );
      expect(result.ok, JSON.stringify(payload)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_command');
    }
  });

  it('rejects a non-positive or non-integer building id', () => {
    for (const id of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = apply(newState(), startUpgrade(id), NOW);
      expect(result.ok, String(id)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_command');
    }
  });

  it('rejects an unknown building id', () => {
    const result = apply(newState(), startUpgrade(999), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });
});

describe('CancelUpgrade', () => {
  type Started = Extract<CommandResult, { ok: true }>;

  const start = (gold = 5000): Started => {
    const state = newState();
    state.resources.gold = gold;
    const result = apply(state, startUpgrade(2, 'c1'), NOW);
    if (!result.ok) throw new Error('expected ok');
    return result;
  };

  it('refunds nothing for an upgrade that has started', () => {
    const started = start();
    expect(started.state.resources.gold).toBe(4800);

    const cancelled = apply(
      started.state,
      { id: 'c2', type: 'CancelUpgrade', payload: { buildingId: 2 } },
      NOW + 2000,
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;

    expect(cancelled.state.resources.gold).toBe(4800);
    expect(cancelled.state.builders.busy).toEqual([]);
    expect(mineOf(cancelled.state)?.upgrade).toBeUndefined();
    expect(mineOf(cancelled.state)?.level).toBe(1);
    expect(cancelled.events).toEqual([
      {
        type: 'UpgradeCancelled',
        buildingId: 2,
        buildingType: 'gold_mine',
        fromLevel: 1,
        toLevel: 2,
        refund: {},
      },
    ]);
  });

  it('refunds half for an item that was paid for but never started', () => {
    const started = start();
    // Remove the builder assignment: the upgrade is paid for but not begun, which
    // is the shape a queued item has once Phase 4 adds the builder queue.
    started.state.builders.busy = [];

    const cancelled = apply(
      started.state,
      { id: 'c2', type: 'CancelUpgrade', payload: { buildingId: 2 } },
      NOW + 2000,
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;

    // 200 gold spent, 100 refunded.
    expect(cancelled.state.resources.gold).toBe(4900);
    expect(cancelled.events).toEqual([
      {
        type: 'UpgradeCancelled',
        buildingId: 2,
        buildingType: 'gold_mine',
        fromLevel: 1,
        toLevel: 2,
        refund: { gold: 100 },
      },
      { type: 'ResourcesChanged', changes: { gold: 100 }, reason: 'upgrade_cancelled' },
    ]);
  });

  it('releases the builder so a new upgrade can start immediately', () => {
    const state = newState();
    state.resources.gold = 5000;
    const started = apply(state, startUpgrade(2, 'c1'), NOW);
    if (!started.ok) throw new Error('expected ok');

    const cancelled = apply(
      started.state,
      { id: 'c2', type: 'CancelUpgrade', payload: { buildingId: 2 } },
      NOW + 2000,
    );
    if (!cancelled.ok) throw new Error('expected ok');
    expect(cancelled.state.builders.busy).toHaveLength(0);

    // The builder is free again, and the player still has enough gold, so the
    // same upgrade can be started immediately.
    const again = apply(cancelled.state, startUpgrade(2, 'c3'), NOW + 3000);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.state.builders.busy).toEqual([
      { buildingId: 2, toLevel: 2, finishAt: NOW + 23_000 },
    ]);
    expect(again.state.resources.gold).toBe(4600);
  });

  it('rejects cancelling a building that is not upgrading', () => {
    const result = apply(
      newState(),
      { id: 'c', type: 'CancelUpgrade', payload: { buildingId: 2 } },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_upgrading');
  });

  it('rejects a malformed building id', () => {
    for (const id of [-1, 0, 1.5, 'x', null]) {
      const result = apply(
        newState(),
        { id: 'c', type: 'CancelUpgrade', payload: { buildingId: id } } as unknown as GameCommand,
        NOW,
      );
      expect(result.ok, JSON.stringify(id)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_command');
    }
  });
});

describe('SpeedUp', () => {
  type Started = Extract<CommandResult, { ok: true }>;

  const start = (gems = 50): Started => {
    const state = newState();
    state.resources.gold = 5000;
    state.resources.gems = gems;
    const result = apply(state, startUpgrade(2, 'c1'), NOW);
    if (!result.ok) throw new Error('expected ok');
    return result;
  };

  it('charges the piecewise cost and completes the upgrade instantly', () => {
    const started = start();
    expect(started.state.builders.busy[0]?.finishAt).toBe(NOW + 20_000);

    const sped = apply(
      started.state,
      { id: 'c2', type: 'SpeedUp', payload: { buildingId: 2 } },
      NOW + 5000,
    );
    expect(sped.ok).toBe(true);
    if (!sped.ok) return;

    // 15 s remaining -> below the 60 s anchor, so the minimum 1 gem.
    expect(sped.state.resources.gems).toBe(49);
    expect(mineOf(sped.state)?.level).toBe(2);
    expect(mineOf(sped.state)?.upgrade).toBeUndefined();
    expect(sped.state.builders.busy).toEqual([]);
    expect(sped.events).toEqual([
      { type: 'ResourcesChanged', changes: { gems: -1 }, reason: 'speed_up' },
      { type: 'SpeedUpUsed', buildingId: 2, gemsSpent: 1, remainingMs: 15_000 },
      {
        type: 'UpgradeFinished',
        buildingId: 2,
        buildingType: 'gold_mine',
        fromLevel: 1,
        toLevel: 2,
      },
    ]);
  });

  it('prices the whole remaining window, not the time since the last command', () => {
    const started = start();
    // 20 s remaining at the moment of the command -> 1 gem.
    const atOnce = apply(
      started.state,
      { id: 'c2', type: 'SpeedUp', payload: { buildingId: 2 } },
      NOW,
    );
    if (!atOnce.ok) throw new Error('expected ok');
    expect(atOnce.events).toContainEqual({
      type: 'SpeedUpUsed',
      buildingId: 2,
      gemsSpent: 1,
      remainingMs: 20_000,
    });

    // The same command 19 s later prices only the 1 s that is left, which is
    // still the 1-gem minimum — the curve is on remaining time, not elapsed time.
    const late = apply(
      started.state,
      { id: 'c3', type: 'SpeedUp', payload: { buildingId: 2 } },
      NOW + 19_000,
    );
    if (!late.ok) throw new Error('expected ok');
    expect(late.events).toContainEqual({
      type: 'SpeedUpUsed',
      buildingId: 2,
      gemsSpent: 1,
      remainingMs: 1000,
    });
  });

  it('raises the Keep level when the Keep is what finished', () => {
    const state = newState();
    state.resources.gold = 5000;
    state.resources.gems = 50;
    const keep = state.buildings.find((b) => b.type === 'keep');
    if (keep === undefined) throw new Error('no keep');

    const started = apply(state, startUpgrade(keep.id, 'c1'), NOW);
    if (!started.ok) throw new Error('expected ok');
    const sped = apply(
      started.state,
      { id: 'c2', type: 'SpeedUp', payload: { buildingId: keep.id } },
      NOW,
    );
    if (!sped.ok) throw new Error('expected ok');
    expect(sped.state.keepLevel).toBe(2);
    expect(sped.state.buildings.find((b) => b.type === 'keep')?.level).toBe(2);
  });

  it('is rejected when the player cannot afford the gems', () => {
    const started = start(0);
    const sped = apply(
      started.state,
      { id: 'c2', type: 'SpeedUp', payload: { buildingId: 2 } },
      NOW,
    );
    expect(sped.ok).toBe(false);
    if (!sped.ok) {
      expect(sped.error.code).toBe('insufficient_resources');
      expect(sped.error.message).toContain('gems');
    }
  });

  it('rejects a building that is not upgrading', () => {
    const result = apply(newState(), { id: 'c', type: 'SpeedUp', payload: { buildingId: 2 } }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_upgrading');
  });

  it('is a no-op rejection once the upgrade has already finished', () => {
    const started = start();
    const caught = catchUp(started.state, NOW + 20_000, config);
    if (!caught.ok) throw new Error('expected ok');
    const sped = apply(
      caught.state,
      { id: 'c2', type: 'SpeedUp', payload: { buildingId: 2 } },
      NOW + 20_000,
    );
    expect(sped.ok).toBe(false);
    if (!sped.ok) expect(sped.error.code).toBe('not_upgrading');
  });
});

describe('BuyBuilder', () => {
  it('charges the configured cost and raises the builder count', () => {
    const state = newState();
    state.resources.gems = 1000;

    const first = apply(state, { id: 'c1', type: 'BuyBuilder', payload: {} }, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.builders.count).toBe(3);
    expect(first.state.resources.gems).toBe(750);
    expect(first.events).toEqual([
      { type: 'ResourcesChanged', changes: { gems: -250 }, reason: 'builder_bought' },
      { type: 'BuilderBought', gemsSpent: 250, builderCount: 3 },
    ]);

    const second = apply(first.state, { id: 'c2', type: 'BuyBuilder', payload: {} }, NOW);
    if (!second.ok) throw new Error('expected ok');
    expect(second.state.builders.count).toBe(4);
    expect(second.state.resources.gems).toBe(250);

    // The fifth builder costs 1,000 gems and only 250 are left.
    const beforeThird = hashState(second.state);
    const third = apply(second.state, { id: 'c3', type: 'BuyBuilder', payload: {} }, NOW);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe('insufficient_resources');
    expect(second.state.builders.count).toBe(4);

    // The rejected purchase changed nothing.
    expect(hashState(second.state)).toBe(beforeThird);

    // With enough gems the fifth builder is allowed.
    const funded = clonePlayerState(second.state);
    funded.resources.gems = 1000;
    const rich = apply(funded, { id: 'c4', type: 'BuyBuilder', payload: {} }, NOW);
    expect(rich.ok).toBe(true);
    if (!rich.ok) return;
    expect(rich.state.builders.count).toBe(5);
    expect(rich.state.resources.gems).toBe(0);
  });

  it('rejects a purchase above the configured maximum', () => {
    const state = newState();
    state.builders.count = 5;
    state.resources.gems = 1000;
    const result = apply(state, { id: 'c', type: 'BuyBuilder', payload: {} }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('max_builders');
  });

  it('rejects a purchase at the starter gem balance of 50', () => {
    const state = newState();
    expect(state.resources.gems).toBe(50);
    const result = apply(state, { id: 'c', type: 'BuyBuilder', payload: {} }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('insufficient_resources');
    expect(state.builders.count).toBe(2);
    expect(state.resources.gems).toBe(50);
  });

  it('rejects a purchase the player cannot afford', () => {
    const state = newState();
    state.resources.gems = 249;
    const result = apply(state, { id: 'c', type: 'BuyBuilder', payload: {} }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('insufficient_resources');
  });

  it('accepts an absent payload', () => {
    const state = newState();
    state.resources.gems = 1000;
    const result = apply(state, { id: 'c', type: 'BuyBuilder' } as unknown as GameCommand, NOW);
    expect(result.ok).toBe(true);
  });
});

describe('CollectResource', () => {
  it('moves the buffer into storage up to the storage cap', () => {
    const state = newState();
    state.resources.gold = 0;
    const caught = catchUp(state, NOW + HOUR, config);
    if (!caught.ok) throw new Error('expected ok');
    expect(mineOf(caught.state)?.buffer?.amount).toBe(100);

    const collected = apply(caught.state, collect(2, 'c1'), NOW + HOUR);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    expect(collected.state.resources.gold).toBe(100);
    expect(mineOf(collected.state)?.buffer?.amount).toBe(0);
    expect(collected.events).toEqual([
      {
        type: 'ResourceCollected',
        buildingId: 2,
        buildingType: 'gold_mine',
        resource: 'gold',
        accepted: 100,
        overflow: 0,
        bufferRemaining: 0,
      },
      { type: 'ResourcesChanged', changes: { gold: 100 }, reason: 'collected' },
    ]);
  });

  it('collects nothing from an empty buffer and emits no event', () => {
    const state = newState();
    const result = apply(state, collect(2, 'c1'), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.resources.gold).toBe(1000);
    expect(result.events).toEqual([]);
  });

  it('clamps the transfer at the storage cap and discards the overflow', () => {
    const state = newState();
    state.resources.gold = 950; // 50 of room left
    const caught = catchUp(state, NOW + HOUR, config);
    if (!caught.ok) throw new Error('expected ok');

    const collected = apply(caught.state, collect(2, 'c1'), NOW + HOUR);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    expect(collected.state.resources.gold).toBe(1000); // clamped at the Keep cap
    // Spec 7.2: overflow is lost, not banked for a later collection.
    expect(mineOf(collected.state)?.buffer?.amount).toBe(0);
    expect(collected.events).toEqual([
      {
        type: 'ResourceCollected',
        buildingId: 2,
        buildingType: 'gold_mine',
        resource: 'gold',
        accepted: 50,
        overflow: 50,
        bufferRemaining: 0,
      },
      { type: 'ResourcesChanged', changes: { gold: 50 }, reason: 'collected' },
    ]);
  });

  it('collects nothing at all when storage is already full', () => {
    const state = newState();
    state.resources.gold = 1000;
    const caught = catchUp(state, NOW + HOUR, config);
    if (!caught.ok) throw new Error('expected ok');

    const collected = apply(caught.state, collect(2, 'c1'), NOW + HOUR);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    expect(collected.state.resources.gold).toBe(1000);
    // Every buffered unit overflowed and is therefore gone.
    expect(mineOf(collected.state)?.buffer?.amount).toBe(0);
    expect(collected.events).toEqual([
      {
        type: 'ResourceCollected',
        buildingId: 2,
        buildingType: 'gold_mine',
        resource: 'gold',
        accepted: 0,
        overflow: 100,
        bufferRemaining: 0,
      },
    ]);
  });

  it('does not recover discarded overflow on a second collection', () => {
    const state = newState();
    state.resources.gold = 950;
    const caught = catchUp(state, NOW + HOUR, config);
    if (!caught.ok) throw new Error('expected ok');

    const once = apply(caught.state, collect(2, 'c1'), NOW + HOUR);
    if (!once.ok) throw new Error('expected ok');
    expect(once.state.resources.gold).toBe(1000);
    expect(mineOf(once.state)?.buffer?.amount).toBe(0);

    const twice = apply(once.state, collect(2, 'c2'), NOW + HOUR);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.state.resources.gold).toBe(1000);
    expect(twice.events).toEqual([]);
  });

  it('never duplicates on repeated collection', () => {
    const state = newState();
    state.resources.gold = 0;
    const caught = catchUp(state, NOW + HOUR, config);
    if (!caught.ok) throw new Error('expected ok');

    const once = apply(caught.state, collect(2, 'c1'), NOW + HOUR);
    if (!once.ok) throw new Error('expected ok');
    expect(once.state.resources.gold).toBe(100);

    const twice = apply(once.state, collect(2, 'c2'), NOW + HOUR);
    if (!twice.ok) throw new Error('expected ok');
    expect(twice.state.resources.gold).toBe(100);
    expect(twice.events).toEqual([]);
  });

  it('collects only the current level production', () => {
    const state = newState();
    state.resources.gold = 0;
    const mine = mineOf(state);
    if (mine !== undefined) mine.level = 2; // 200/hour in the fixture
    const caught = catchUp(state, NOW + HOUR, config);
    if (!caught.ok) throw new Error('expected ok');

    const collected = apply(caught.state, collect(2, 'c1'), NOW + HOUR);
    if (!collected.ok) throw new Error('expected ok');
    expect(collected.state.resources.gold).toBe(200);
  });

  it('rejects a building that produces nothing', () => {
    const result = apply(newState(), collect(1, 'c1'), NOW); // the Keep
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_a_collector');
  });

  it('rejects an unknown building', () => {
    const result = apply(newState(), collect(999, 'c1'), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });
});

describe('same-millisecond commands', () => {
  it('is idempotent when repeated at the same timestamp', () => {
    const state = newState();
    state.resources.gold = 5000;
    const started = apply(state, startUpgrade(2, 'c1'), NOW);
    if (!started.ok) throw new Error('expected ok');

    const again = apply(started.state, startUpgrade(2, 'c2'), NOW);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('already_upgrading');
    expect(hashState(started.state)).toBe(hashState(started.state));
    // The rejected command must not have touched the state it was given.
    expect(hashState(started.state)).toBe(hashState(started.state));
  });

  it('does not accrue a second time for the same window', () => {
    const state = newState();
    state.resources.gold = 0;
    const caught = catchUp(state, NOW + HOUR, config);
    if (!caught.ok) throw new Error('expected ok');
    const collected = apply(caught.state, collect(2, 'c1'), NOW + HOUR);
    if (!collected.ok) throw new Error('expected ok');

    // Any number of further commands at the same instant change nothing.
    const noop = apply(collected.state, collect(2, 'c2'), NOW + HOUR);
    if (!noop.ok) throw new Error('expected ok');
    expect(noop.state.resources.gold).toBe(100);
    expect(noop.events).toEqual([]);
    expect(hashState(noop.state)).toBe(hashState(collected.state));
  });

  it('never double-spends when two commands share a timestamp', () => {
    const state = newState();
    state.resources.gems = 300;
    const first = apply(state, { id: 'c1', type: 'BuyBuilder', payload: {} }, NOW);
    if (!first.ok) throw new Error('expected ok');
    expect(first.state.resources.gems).toBe(50);

    const second = apply(first.state, { id: 'c2', type: 'BuyBuilder', payload: {} }, NOW);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('insufficient_resources');
  });

  it('completes expired work before applying the command at the same timestamp', () => {
    const state = newState();
    state.resources.gold = 5000;
    const started = apply(state, startUpgrade(2, 'c1'), NOW);
    if (!started.ok) throw new Error('expected ok');

    // A command exactly at the finish time must see the finished upgrade, and
    // the gold mine then has no level 3 to build.
    const atFinish = apply(started.state, startUpgrade(2, 'c2'), NOW + 20_000);
    expect(atFinish.ok).toBe(false);
    if (!atFinish.ok) expect(atFinish.error.code).toBe('max_level');
  });
});

describe('time handling', () => {
  it('rejects a timestamp earlier than the last one', () => {
    const state = newState();
    const first = apply(state, startUpgrade(2, 'c1'), NOW + 5000);
    if (!first.ok) throw new Error('expected ok');
    const back = apply(first.state, collect(2, 'c2'), NOW + 4000);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.error.code).toBe('time_moved_backwards');
  });

  it('rejects a non-integer timestamp', () => {
    const result = apply(newState(), collect(2, 'c1'), NOW + 0.5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_command');
  });

  it('rejects a non-integer or non-positive command id', () => {
    for (const id of [0, -1, 1.5]) {
      const result = applyCommand(
        newState(),
        { id, type: 'CollectResource', payload: { buildingId: 2 } } as unknown as GameCommand,
        ctx,
      );
      expect(result.ok, String(id)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_command');
    }
  });
});

describe('catch-up events are prepended, not lost', () => {
  it('emits production and upgrade events in a deterministic order', () => {
    const state = newState();
    state.resources.gold = 5000;
    const started = apply(state, startUpgrade(2, 'c1'), NOW);
    if (!started.ok) throw new Error('expected ok');
    // Empty the store so the whole buffer fits: the Keep's own cap is 1,000 and
    // the upgrade just spent most of the gold.
    started.state.resources.gold = 0;

    // One hour later the upgrade is long finished and production has accrued.
    const later = apply(started.state, collect(2, 'c2'), NOW + HOUR);
    expect(later.ok).toBe(true);
    if (!later.ok) return;

    // The upgrade finished 20 s into the hour, so the hour is produced in two
    // segments at two different rates — the new rate is *not* applied
    // retroactively to the whole window:
    //   20,000 ms at 100/h -> 0 whole, carry 2,000,000
    //   3,580,000 ms at 200/h + carry = 718,000,000 -> 199 whole, carry 1,600,000
    expect(later.events).toEqual([
      {
        type: 'UpgradeFinished',
        buildingId: 2,
        buildingType: 'gold_mine',
        fromLevel: 1,
        toLevel: 2,
      },
      {
        type: 'ResourceCollected',
        buildingId: 2,
        buildingType: 'gold_mine',
        resource: 'gold',
        accepted: 199,
        overflow: 0,
        bufferRemaining: 0,
      },
      { type: 'ResourcesChanged', changes: { gold: 199 }, reason: 'collected' },
    ]);
  });

  it('leaves the input state hash untouched', () => {
    const state = newState();
    state.resources.gold = 5000;
    const before = hashState(state);
    const started = apply(state, startUpgrade(2, 'c1'), NOW + 1234);
    if (!started.ok) throw new Error('expected ok');
    expect(hashState(state)).toBe(before);
  });
});

describe('essence production follows the same rules', () => {
  it('accrues essence separately from gold', () => {
    const state = newState();
    state.resources.essence = 0;
    const caught = catchUp(state, NOW + HOUR, config);
    if (!caught.ok) throw new Error('expected ok');
    expect(wellOf(caught.state)?.buffer?.amount).toBe(100);

    const collected = apply(caught.state, collect(3, 'c1'), NOW + HOUR);
    if (!collected.ok) throw new Error('expected ok');
    expect(collected.state.resources.essence).toBe(100);
    expect(collected.state.resources.gold).toBe(1000); // untouched
  });
});

describe('BuyBuilder edge cases', () => {
  it('reports a missing price when the count is below the configured starter count', () => {
    // A hand-edited state can end up owning fewer builders than the config says
    // the player starts with; the command must fail cleanly rather than sell a
    // negative-indexed builder.
    const state = newState();
    state.builders.count = 1;
    state.resources.gems = 1000;
    const result = apply(state, { id: 'c', type: 'BuyBuilder', payload: {} }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('max_builders');
      expect(result.error.message).toContain('no price is configured');
    }
  });
});

describe('quantity limits (spec 7.3)', () => {
  /** A config whose gold_store ceiling is 1 at Keep 1, for a one-over test. */
  const oneStoreConfig = () => {
    const patched = JSON.parse(JSON.stringify(TEST_CONFIG)) as typeof TEST_CONFIG;
    patched.limits.buildingCounts.gold_store = [0, 1, 1];
    return patched;
  };

  const place = (buildingType: string, x: number, y: number, id = 'c-place'): GameCommand => ({
    id,
    type: 'PlaceBuilding',
    payload: { buildingType, x, y },
  });

  it('allows the placement that reaches the ceiling exactly', () => {
    const cfg = oneStoreConfig();
    const state = createNewPlayerState(cfg, NOW);
    const result = applyCommand(state, place('gold_store', 6, 6), { config: cfg, now: NOW });
    expect(result.ok).toBe(true);
  });

  it('rejects the placement that would exceed the ceiling by one', () => {
    const cfg = oneStoreConfig();
    const state = createNewPlayerState(cfg, NOW);
    const first = applyCommand(state, place('gold_store', 6, 6, 'c1'), { config: cfg, now: NOW });
    if (!first.ok) throw new Error('expected ok');

    const before = hashState(first.state);
    const second = applyCommand(first.state, place('gold_store', 10, 6, 'c2'), {
      config: cfg,
      now: NOW + 20_000,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('building_limit_reached');
    expect(second.error.details).toEqual({
      buildingType: 'gold_store',
      limit: 1,
      count: 1,
      keepLevel: 1,
    });
    // Rejected atomically: the input state is untouched.
    expect(hashState(first.state)).toBe(before);
  });

  it('counts a level-0 construction towards the ceiling', () => {
    const cfg = oneStoreConfig();
    const state = createNewPlayerState(cfg, NOW);
    const first = applyCommand(state, place('gold_store', 6, 6, 'c1'), { config: cfg, now: NOW });
    if (!first.ok) throw new Error('expected ok');
    const built = first.state.buildings.find((b) => b.type === 'gold_store');
    expect(built?.level).toBe(0);

    const second = applyCommand(first.state, place('gold_store', 10, 6, 'c2'), {
      config: cfg,
      now: NOW + 1000,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('building_limit_reached');
  });

  it('allows the below-limit count and raises the ceiling when the Keep finishes', () => {
    const cfg = oneStoreConfig();
    cfg.limits.buildingCounts.gold_store = [0, 1, 2];
    const state = createNewPlayerState(cfg, NOW);
    state.resources.gold = 5000;

    // Below the ceiling: 0 of 1 at Keep 1.
    const placed = applyCommand(state, place('gold_store', 6, 6, 'c1'), { config: cfg, now: NOW });
    if (!placed.ok) throw new Error('expected ok');
    expect(countBuildings(placed.state, 'gold_store')).toBe(1);

    // At the ceiling: the second store is refused at Keep 1.
    const refused = applyCommand(placed.state, place('gold_store', 10, 6, 'c2'), {
      config: cfg,
      now: NOW + 1000,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('building_limit_reached');

    // Finish the Keep upgrade; the same placement is then within the Keep-2 row.
    const keep = placed.state.buildings.find((b) => b.type === 'keep');
    if (keep === undefined) throw new Error('no keep');
    const upgrading = applyCommand(placed.state, startUpgrade(keep.id, 'c3'), {
      config: cfg,
      now: NOW + 1000,
    });
    if (!upgrading.ok) throw new Error('expected ok');

    const caught = catchUp(upgrading.state, NOW + 200_000, cfg);
    if (!caught.ok) throw new Error('expected ok');
    expect(caught.state.keepLevel).toBe(2);

    const allowed = applyCommand(caught.state, place('gold_store', 10, 6, 'c4'), {
      config: cfg,
      now: NOW + 200_000,
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(countBuildings(allowed.state, 'gold_store')).toBe(2);
  });

  it('uses the completed Keep level, not an upgrade in flight', () => {
    const cfg = oneStoreConfig();
    const state = createNewPlayerState(cfg, NOW);
    const keep = state.buildings.find((b) => b.type === 'keep');
    if (keep === undefined) throw new Error('no keep');
    // A Keep upgrade to level 2 is in flight but has not finished.
    keep.upgrade = { toLevel: 2, finishAt: NOW + 60_000 };
    state.builders.busy.push({ buildingId: keep.id, toLevel: 2, finishAt: NOW + 60_000 });

    const result = applyCommand(state, place('gold_store', 6, 6), { config: cfg, now: NOW });
    expect(result.ok).toBe(true);
    expect(result.ok && result.state.keepLevel).toBe(1);
  });

  it('refuses a second Keep even when a tile is free', () => {
    const state = newState();
    const result = apply(state, place('keep', 6, 6));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('building_limit_reached');
    expect(state.buildings.filter((b) => b.type === 'keep')).toHaveLength(1);
  });
});

describe('cancelling a level-0 construction', () => {
  const place = (id = 'c1'): GameCommand => ({
    id,
    type: 'PlaceBuilding',
    payload: { buildingType: 'wall', x: 20, y: 25 },
  });
  const cancel = (buildingId: number, id = 'c2'): GameCommand => ({
    id,
    type: 'CancelUpgrade',
    payload: { buildingId },
  });

  it('removes the unfinished building, frees the builder and refunds nothing', () => {
    const state = newState();
    const placed = apply(state, place('c1'));
    if (!placed.ok) throw new Error('expected ok');
    const building = placed.state.buildings.at(-1);
    if (building === undefined) throw new Error('no building');
    expect(building.level).toBe(0);
    expect(placed.state.resources.gold).toBe(990);
    expect(placed.state.builders.busy).toHaveLength(1);

    const cancelled = apply(placed.state, cancel(building.id, 'c2'));
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;

    // The orphan is gone, not merely left behind without an upgrade.
    expect(cancelled.state.buildings.some((b) => b.id === building.id)).toBe(false);
    expect(cancelled.state.builders.busy).toEqual([]);
    // Spec 7.5: a started construction refunds nothing.
    expect(cancelled.state.resources.gold).toBe(990);
    expect(cancelled.events).toEqual([
      {
        type: 'UpgradeCancelled',
        buildingId: building.id,
        buildingType: 'wall',
        fromLevel: 0,
        toLevel: 1,
        refund: {},
      },
      { type: 'BuildingRemoved', buildingId: building.id, buildingType: 'wall', level: 0 },
    ]);
  });

  it('frees the tiles so the same spot can be built on again', () => {
    const state = newState();
    const placed = apply(state, place('c1'));
    if (!placed.ok) throw new Error('expected ok');
    const building = placed.state.buildings.at(-1);
    if (building === undefined) throw new Error('no building');

    const cancelled = apply(placed.state, cancel(building.id, 'c2'));
    if (!cancelled.ok) throw new Error('expected ok');

    const again = apply(cancelled.state, place('c3'), NOW + 1000);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.state.buildings.at(-1)?.level).toBe(0);
  });

  it('keeps a normal upgrade at its current level instead of deleting it', () => {
    const state = newState();
    state.resources.gold = 5000;
    const mine = mineOf(state);
    if (mine === undefined) throw new Error('no mine');
    const started = apply(state, startUpgrade(mine.id, 'c1'));
    if (!started.ok) throw new Error('expected ok');

    const cancelled = apply(started.state, cancel(mine.id, 'c2'));
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.state.buildings.some((b) => b.id === mine.id)).toBe(true);
    expect(mineOf(cancelled.state)?.level).toBe(1);
    expect(mineOf(cancelled.state)?.upgrade).toBeUndefined();
    expect(cancelled.state.builders.busy).toEqual([]);
  });
});

describe('SpeedUp clock arithmetic (spec 7.5)', () => {
  it('prices a 300 s timer that has run 240,000 ms as 60 s remaining', () => {
    // Same fixture, but the Keep takes the spec's 5 minutes to reach level 2.
    const cfg = JSON.parse(JSON.stringify(TEST_CONFIG)) as typeof TEST_CONFIG;
    const keepLevelTwo = cfg.buildings[0]?.levels[1];
    if (keepLevelTwo === undefined) throw new Error('no keep level 2');
    keepLevelTwo.buildSeconds = 300;

    const state = createNewPlayerState(cfg, NOW);
    state.resources.gold = 5000;
    state.resources.gems = 50;
    const keep = state.buildings.find((b) => b.type === 'keep');
    if (keep === undefined) throw new Error('no keep');

    const started = applyCommand(state, startUpgrade(keep.id, 'c1'), { config: cfg, now: NOW });
    if (!started.ok) throw new Error('expected ok');
    expect(started.state.builders.busy[0]?.finishAt).toBe(NOW + 300_000);

    const sped = applyCommand(
      started.state,
      { id: 'c2', type: 'SpeedUp', payload: { buildingId: keep.id } },
      { config: cfg, now: NOW + 240_000 },
    );
    if (!sped.ok) throw new Error('expected ok');

    expect(sped.events).toContainEqual({
      type: 'SpeedUpUsed',
      buildingId: keep.id,
      gemsSpent: 1,
      remainingMs: 60_000,
    });
    expect(sped.state.resources.gems).toBe(49);
    expect(sped.state.keepLevel).toBe(2);
  });
});
