/**
 * Lazy time evaluation and the resource economy.
 *
 * Spec Section 7.5: "All timers use server timestamps: store finishAt; the server
 * completes things lazily when state is read/synced." That is the whole design of
 * this module. Nothing here reads a clock — `now` is always injected by the caller
 * (the server, or a test) — and nothing here mutates its input.
 *
 * Determinism rules this module must honour (spec Section 6.4):
 *   - integer / fixed-point arithmetic only;
 *   - stable iteration order (buildings by ascending id, then obstacles by id);
 *   - calling catch-up twice at the same timestamp changes nothing;
 *   - time never moves backwards.
 */

import type { BuildingDef, GameConfig, ResourceAmount, ResourceId } from '../config/types.js';
import { clonePlayerState, type BuildingInstance, type PlayerState } from '../state/index.js';

/** Something that happened while time passed. Distinct from command events. */
export type CatchUpEvent =
  | {
      type: 'UpgradeFinished';
      buildingId: number;
      buildingType: string;
      fromLevel: number;
      toLevel: number;
    }
  | {
      type: 'TrainingCompleted';
      barracksId: number;
      troopId: string;
      count: number;
    };

export type CatchUpResult =
  { ok: true; state: PlayerState; events: CatchUpEvent[] } | { ok: false; error: CatchUpError };

export interface CatchUpError {
  code: 'time_moved_backwards' | 'invalid_state';
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Advances a state from its own recorded time to `now`.
 *
 * Pure: the input is cloned before anything is touched, so a rejected call leaves
 * the caller's state exactly as it was.
 */
export function catchUp(state: PlayerState, now: number, config: GameConfig): CatchUpResult {
  if (!Number.isInteger(now)) {
    return {
      ok: false,
      error: {
        code: 'invalid_state',
        message: `catchUp: now must be an integer epoch-millisecond timestamp, received ${String(now)}`,
      },
    };
  }
  if (now < state.lastSyncAt) {
    return {
      ok: false,
      error: {
        code: 'time_moved_backwards',
        message: `time cannot move backwards: state is at ${state.lastSyncAt}, received ${now}`,
        details: { stateTime: state.lastSyncAt, received: now },
      },
    };
  }

  const next = clonePlayerState(state);
  const events: CatchUpEvent[] = [];

  // Chronological progression. Advancing time in one jump and then completing
  // every upgrade would apply the *post*-upgrade production rate to the whole
  // window — a collector that finished an upgrade five minutes before `now`
  // would retroactively re-price the hour before it. Instead: accrue to the
  // next completion instant with the levels active up to it, apply the
  // completions landing exactly there, and repeat. A completion exactly at the
  // interval start is applied before any production; one exactly at the
  // interval end is applied after the final segment, with zero time at the new
  // rate.
  let cursor = next.lastSyncAt;

  for (;;) {
    const due = nextCompletionAt(next, cursor, now);
    if (due === undefined) break;
    if (due > cursor) {
      accrueProduction(next, cursor, due, config);
      cursor = due;
    }
    applyCompletionsAt(next, cursor, events);
  }

  accrueProduction(next, cursor, now, config);

  next.lastSyncAt = now;
  return { ok: true, state: next, events };
}

/**
 * The earliest completion timestamp in `[from, until]`, or undefined when
 * nothing is scheduled. Builder assignments and training items are considered
 * together so the two kinds of timer interleave in the correct order.
 */
function nextCompletionAt(state: PlayerState, from: number, until: number): number | undefined {
  let earliest: number | undefined;

  const consider = (at: number): void => {
    if (at < from || at > until) return;
    if (earliest === undefined || at < earliest) earliest = at;
  };

  for (const assignment of state.builders.busy) consider(assignment.finishAt);
  for (const queue of state.trainingQueues) {
    for (const item of queue.items) consider(item.finishAt);
  }
  return earliest;
}

/** Applies every completion that lands exactly on `at`. */
function applyCompletionsAt(state: PlayerState, at: number, events: CatchUpEvent[]): void {
  finishUpgradesAt(state, at, events);
  completeTrainingAt(state, at, events);
}

// ------------------------------------------------------------------ upgrades

/**
 * Completes every upgrade whose finish time is exactly `at`, updates the
 * Keep-level invariant and releases the builder.
 *
 * Iterates builders by ascending building id so the event order is stable
 * regardless of how the busy list was assembled.
 */
function finishUpgradesAt(state: PlayerState, at: number, events: CatchUpEvent[]): void {
  const due = state.builders.busy
    .filter((assignment) => assignment.finishAt <= at)
    .sort((a, b) => a.buildingId - b.buildingId);
  if (due.length === 0) return;

  for (const assignment of due) {
    const building = state.buildings.find((candidate) => candidate.id === assignment.buildingId);
    // A dangling assignment (no building, or the upgrade was cancelled between
    // the watermark and this instant) is dropped rather than retried forever.
    if (!building || building.upgrade === undefined) continue;

    const fromLevel = building.level;
    const toLevel = building.upgrade.toLevel;
    building.level = toLevel;
    building.upgrade = undefined;

    events.push({
      type: 'UpgradeFinished',
      buildingId: building.id,
      buildingType: building.type,
      fromLevel,
      toLevel,
    });

    // The Keep level is derived, never stored independently of the building.
    // A completed level-0 construction therefore raises it for the first time.
    if (building.type === 'keep') state.keepLevel = toLevel;
  }

  const dueIds = new Set(due.map((assignment) => assignment.buildingId));
  state.builders.busy = state.builders.busy.filter(
    (assignment) => !dueIds.has(assignment.buildingId),
  );
}

// ------------------------------------------------------------------ training

/**
 * Completes training-queue items whose finish time is exactly `at` and moves
 * them into the army, in FIFO order per barracks and ascending barracks id
 * overall.
 *
 * Phase 2 has no `QueueTroop` command, so in practice these queues are empty; the
 * logic exists so a state that already carries queue items (a migrated save, or a
 * hand-built fixture) resolves correctly instead of silently holding troops
 * hostage. Housing limits are Phase 4 and are deliberately not modelled here.
 */
function completeTrainingAt(state: PlayerState, at: number, events: CatchUpEvent[]): void {
  const queues = [...state.trainingQueues].sort((a, b) => a.barracksId - b.barracksId);

  for (const queue of queues) {
    const completed = queue.items.filter((item) => item.finishAt <= at);
    if (completed.length === 0) continue;

    // Group by troop so one event covers a batch rather than one per item.
    const counts = new Map<string, number>();
    for (const item of completed) {
      counts.set(item.troopId, (counts.get(item.troopId) ?? 0) + 1);
    }
    for (const [troopId, count] of counts) {
      state.army[troopId] = (state.army[troopId] ?? 0) + count;
      events.push({ type: 'TrainingCompleted', barracksId: queue.barracksId, troopId, count });
    }

    const completedKeys = new Set(completed.map((item) => `${item.troopId}@${item.finishAt}`));
    queue.items = queue.items.filter(
      (item) => !completedKeys.has(`${item.troopId}@${item.finishAt}`),
    );
  }
}

// ----------------------------------------------------------------- production

/**
 * Accrues collector production over `[from, to)` using the levels that are
 * active in that window.
 *
 * The arithmetic is exact integer arithmetic: `productionPerHour` units per
 * `config.economy.msPerHour` milliseconds, with the fractional part carried
 * forward as an exact numerator over `msPerHour` rather than rounded away. That
 * is what makes command frequency irrelevant — ten short catch-ups accrue
 * exactly what one long one does.
 *
 * Overflow rule (one rule, documented, applied everywhere): **once a buffer
 * reaches its cap the elapsed production is discarded — whole units and the
 * fractional carry alike — and the watermark still advances.** That includes the
 * case where the whole units exactly equal the remaining room: reaching the cap
 * ends the carry, so the fraction cannot reappear after the next collection.
 * `lastAccruedAt` moving forward is what stops the discarded time from being
 * counted a second time on the next call.
 */
function accrueProduction(state: PlayerState, from: number, to: number, config: GameConfig): void {
  if (to <= from) return;
  const buildings = [...state.buildings].sort((a, b) => a.id - b.id);

  for (const building of buildings) {
    const level = levelDef(config, building);
    if (level === undefined) continue;
    if (level.productionPerHour === undefined || level.productionPerHour <= 0) continue;
    if (level.produces === undefined || level.bufferCap === undefined) continue;

    // A collector that has never produced anything keeps its buffer absent
    // until there is actually something to record, so a catch-up at the current
    // timestamp does not add fields to the state.
    const existing = building.buffer;
    const startAt = Math.max(from, existing?.lastAccruedAt ?? from);
    const elapsed = to - startAt;
    if (elapsed <= 0) continue;

    const buffer = existing ?? { amount: 0, remainder: 0, lastAccruedAt: startAt };
    const produced = produce(
      elapsed,
      level.productionPerHour,
      config.economy.msPerHour,
      buffer.remainder,
    );

    const room = level.bufferCap - buffer.amount;
    if (room <= 0) {
      // Already full: everything that arrived while full is lost, carry included.
      buffer.remainder = 0;
    } else if (produced.whole >= room) {
      // Filled during this window, either past the cap or exactly onto it:
      // take the room, discard the rest and the carry.
      buffer.amount = level.bufferCap;
      buffer.remainder = 0;
    } else {
      buffer.amount += produced.whole;
      buffer.remainder = produced.carry;
    }

    buffer.lastAccruedAt = to;
    building.buffer = buffer;
  }
}

/**
 * Exact integer production for one elapsed window, carrying the fractional part
 * forward.
 *
 * The carry is an integer numerator over `msPerHour` — never a rounded
 * fixed-point value. Rounding it per call is precisely the bug this avoids: six
 * calls of 6,000 ms would each truncate 0.67 of a fixed-point unit and lose 4
 * units, while one call of 36,000 ms would not. Accumulating the exact
 * numerator makes the two indistinguishable.
 *
 * Overflow safety: `restMs` is below `msPerHour`, so `restMs * rate` stays under
 * 3.6e12 for the maximum schema-bounded rate, and `carry` is below `msPerHour`.
 * `hours * rate` is exact for any plausible elapsed window.
 */
function produce(
  elapsedMs: number,
  ratePerHour: number,
  msPerHour: number,
  carry: number,
): { whole: number; carry: number } {
  const hours = Math.floor(elapsedMs / msPerHour);
  const restMs = elapsedMs - hours * msPerHour;

  const numerator = carry + restMs * ratePerHour;
  const wholeFromCarry = Math.floor(numerator / msPerHour);

  return {
    whole: hours * ratePerHour + wholeFromCarry,
    carry: numerator % msPerHour,
  };
}

// -------------------------------------------------------------------- storage

/**
 * Total holding capacity per resource: every building level that declares a
 * `storageCap` contributes, which is how the Keep's small base capacity and the
 * dedicated stores combine (spec Section 7.2).
 */
export function storageCapacity(
  state: PlayerState,
  config: GameConfig,
): Partial<Record<ResourceId, number>> {
  const capacity: Partial<Record<ResourceId, number>> = {};
  for (const building of state.buildings) {
    const level = levelDef(config, building);
    if (level?.storageCap === undefined) continue;
    for (const [resource, amount] of Object.entries(level.storageCap)) {
      if (amount === undefined) continue;
      const id = resource as ResourceId;
      capacity[id] = (capacity[id] ?? 0) + amount;
    }
  }
  return capacity;
}

/** Free room for one resource. Missing capacity means zero room, never unlimited. */
export function remainingCapacity(
  state: PlayerState,
  config: GameConfig,
  resource: ResourceId,
): number {
  const capacity = storageCapacity(state, config)[resource] ?? 0;
  return Math.max(0, capacity - (state.resources[resource] ?? 0));
}

/** The building definition for an instance, or undefined when the config lacks it. */
export function buildingDef(
  config: GameConfig,
  building: BuildingInstance,
): BuildingDef | undefined {
  return config.buildings.find((candidate) => candidate.id === building.type);
}

/** The level definition an instance is currently at. */
export function levelDef(config: GameConfig, building: BuildingInstance) {
  return buildingDef(config, building)?.levels.find((level) => level.level === building.level);
}

/** Adds a resource amount, clamped at zero — never a negative balance. */
export function addResources(
  target: Record<ResourceId, number>,
  changes: ResourceAmount,
): ResourceAmount {
  const applied: ResourceAmount = {};
  for (const [resource, amount] of Object.entries(changes)) {
    if (amount === undefined || amount === 0) continue;
    const id = resource as ResourceId;
    target[id] = Math.max(0, (target[id] ?? 0) + amount);
    applied[id] = (applied[id] ?? 0) + amount;
  }
  return applied;
}

/** True when the state can afford `cost` in full. */
export function canAfford(
  state: PlayerState,
  cost: ResourceAmount,
): { ok: true } | { ok: false; missing: ResourceAmount } {
  const missing: ResourceAmount = {};
  for (const [resource, amount] of Object.entries(cost)) {
    if (amount === undefined || amount === 0) continue;
    const id = resource as ResourceId;
    const shortfall = amount - (state.resources[id] ?? 0);
    if (shortfall > 0) missing[id] = shortfall;
  }
  return Object.keys(missing).length === 0 ? { ok: true } : { ok: false, missing };
}
