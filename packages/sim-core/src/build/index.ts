/**
 * Construction rules: upgrade eligibility, cancellation refunds, speed-up
 * pricing and the builder shop.
 *
 * Every number here comes from the validated config — no prices, durations,
 * caps or gem costs are hard-coded. The functions are pure: they never mutate
 * the state they are handed, so a command can check first and only clone once
 * it knows the action is legal.
 */

import type {
  BuildingDef,
  BuildingLevel,
  GameConfig,
  ResourceAmount,
  ResourceId,
} from '../config/types.js';
import type { PlayerState } from '../state/index.js';

/** `Number.MAX_SAFE_INTEGER` as a BigInt, for the conversion guard below. */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** Why an upgrade cannot start, in the order the checks run. */
export type UpgradeRejection =
  | 'not_found'
  | 'unknown_building'
  | 'already_upgrading'
  | 'max_level'
  | 'keep_level_too_low'
  | 'insufficient_resources'
  | 'no_builder';

export type UpgradeCheck =
  | { ok: true; def: BuildingDef; target: BuildingLevel }
  | { ok: false; rejection: UpgradeRejection; message: string; missing?: ResourceAmount };

/** The level table entry for `level`, or undefined when it does not exist. */
export function currentLevel(
  config: GameConfig,
  buildingType: string,
  level: number,
): BuildingLevel | undefined {
  return buildingTable(config, buildingType)?.levels.find((entry) => entry.level === level);
}

/** The level table entry one above `level`, or undefined at the maximum. */
export function nextLevel(
  config: GameConfig,
  buildingType: string,
  level: number,
): BuildingLevel | undefined {
  return buildingTable(config, buildingType)?.levels.find((entry) => entry.level === level + 1);
}

function buildingTable(config: GameConfig, buildingType: string): BuildingDef | undefined {
  return config.buildings.find((candidate) => candidate.id === buildingType);
}

/** How long an upgrade to `targetLevel` takes, in milliseconds. */
export function upgradeDurationMs(
  config: GameConfig,
  buildingType: string,
  targetLevel: number,
): number {
  const level = currentLevel(config, buildingType, targetLevel);
  return level === undefined ? 0 : level.buildSeconds * 1000;
}

/**
 * Decides whether `buildingId` may start its next level right now.
 *
 * The order is deliberate and stable: identity, then the building itself, then
 * its own progress, then the Keep gate, then cost, then builder availability.
 * Reporting the Keep gate before the cost means a player who is both too poor
 * and too low-level is told the thing that actually blocks them, rather than
 * being told to go and earn resources they still could not spend.
 */
export function checkUpgrade(
  state: PlayerState,
  buildingId: number,
  config: GameConfig,
): UpgradeCheck {
  const building = state.buildings.find((candidate) => candidate.id === buildingId);
  if (building === undefined) {
    return { ok: false, rejection: 'not_found', message: `no building with id ${buildingId}` };
  }

  const def = buildingTable(config, building.type);
  if (def === undefined) {
    return {
      ok: false,
      rejection: 'unknown_building',
      message: `building "${building.type}" is not defined in the config`,
    };
  }

  if (building.upgrade !== undefined) {
    return {
      ok: false,
      rejection: 'already_upgrading',
      message: `building ${building.id} is already upgrading to level ${building.upgrade.toLevel}`,
    };
  }

  const target = def.levels.find((entry) => entry.level === building.level + 1);
  if (target === undefined) {
    return {
      ok: false,
      rejection: 'max_level',
      message: `building ${building.id} ("${def.id}") is already at its maximum level ${building.level}`,
    };
  }

  // Keep gating (spec 7.3). A building's level 1 is always available; higher
  // levels are unlocked by the Keep level recorded on the target row.
  const requiredKeep = target.requiresKeep ?? 1;
  if (requiredKeep > state.keepLevel) {
    return {
      ok: false,
      rejection: 'keep_level_too_low',
      message: `"${def.id}" level ${target.level} requires Keep ${requiredKeep}, you are on Keep ${state.keepLevel}`,
    };
  }

  const missing = missingResources(state, target.cost);
  if (missing !== undefined) {
    return {
      ok: false,
      rejection: 'insufficient_resources',
      message: `"${def.id}" level ${target.level} costs ${describeCost(target.cost)}`,
      missing,
    };
  }

  if (state.builders.busy.length >= state.builders.count) {
    return {
      ok: false,
      rejection: 'no_builder',
      message: `all ${state.builders.count} builders are busy`,
    };
  }

  return { ok: true, def, target };
}

/** The resources still needed to afford `cost`, or undefined when affordable. */
function missingResources(state: PlayerState, cost: ResourceAmount): ResourceAmount | undefined {
  const missing: ResourceAmount = {};
  for (const [resource, amount] of Object.entries(cost)) {
    if (amount === undefined || amount === 0) continue;
    const have = state.resources[resource as ResourceId] ?? 0;
    if (have < amount) missing[resource as ResourceId] = amount - have;
  }
  return Object.keys(missing).length === 0 ? undefined : missing;
}

function describeCost(cost: ResourceAmount): string {
  const parts = Object.entries(cost)
    .filter(([, amount]) => amount !== undefined && amount !== 0)
    .map(([resource, amount]) => `${amount} ${resource}`);
  return parts.length === 0 ? 'nothing' : parts.join(' + ');
}

/**
 * Spec 7.5: cancelling refunds nothing once a builder has started the work, and
 * the configured fraction for an item that was paid for but never began.
 */
export function cancelRefundFraction(config: GameConfig, started: boolean): number {
  return started
    ? config.economy.cancelRefund.startedUpgrade
    : config.economy.cancelRefund.queuedItem;
}

/**
 * The resources returned when an upgrade to `targetLevel` is cancelled.
 *
 * `started` distinguishes work a builder has actually begun (refunds nothing)
 * from an item that was paid for but never began (refunds the configured
 * queued fraction). Callers default it to `true`; the queued branch becomes
 * reachable once the builder queue lands in Phase 4.
 */
export function refundFor(
  config: GameConfig,
  buildingType: string,
  targetLevel: number,
  started = true,
): ResourceAmount {
  const target = currentLevel(config, buildingType, targetLevel);
  if (!target) return {};

  const fraction = cancelRefundFraction(config, started);
  const refund: ResourceAmount = {};
  for (const [resource, amount] of Object.entries(target.cost)) {
    if (amount === undefined || amount === 0) continue;
    // Floor, so a fractional refund can never mint a resource the player did
    // not have.
    const value = Math.floor(amount * fraction);
    if (value > 0) refund[resource as ResourceId] = value;
  }
  return refund;
}

/**
 * Spec 7.5: the gem price of skipping `remainingMs` is piecewise-linear in the
 * remaining seconds between the configured anchors, clamped outside them and
 * never below `minimumGems`.
 *
 * This is transcribed from the anchor table, not approximated by a single
 * slope: between 60 s and 1 h the curve rises 19 gems, between 1 h and 1 d it
 * rises 240, and between 1 d and 7 d it rises 740. A linear fit across the
 * whole range would be wrong by an order of magnitude at both ends.
 */
export function speedUpCost(remainingMs: number, config: GameConfig): number {
  const { anchors, minimumGems } = config.economy.speedUp;
  // A validated config carries a positive safe-integer floor; a hand-built one
  // that breaks that promise still gets a usable, in-range minimum.
  const floor = Number.isSafeInteger(minimumGems) && minimumGems > 0 ? minimumGems : 1;
  if (!Number.isFinite(remainingMs) || anchors.length === 0) return floor;

  // Defensive copy *and* defensive filtering. The validator enforces ascending,
  // in-range anchors, but this function is pure and a direct caller can hand it
  // a config that never passed validation. An anchor whose `seconds` has no
  // exact millisecond form — `Number.MAX_VALUE * 1000` is `Infinity`, and
  // `Number.MAX_SAFE_INTEGER * 1000` is off by 24 — has no trustworthy position
  // on the curve, so it is dropped instead of being allowed to poison the span
  // or reach `BigInt` as a non-integer and raise a native `RangeError`.
  const table: { ms: number; gems: number }[] = [];
  for (const anchor of anchors) {
    const anchorMs = anchor.seconds * 1000;
    if (!Number.isSafeInteger(anchor.seconds) || anchor.seconds <= 0) continue;
    if (!Number.isSafeInteger(anchorMs)) continue;
    if (!Number.isSafeInteger(anchor.gems) || anchor.gems < 0) continue;
    table.push({ ms: anchorMs, gems: anchor.gems });
  }

  // Nothing usable is left to interpolate between: fall back to the floor, the
  // same price this function quotes for a missing or non-finite duration.
  if (table.length === 0) return floor;
  table.sort((a, b) => a.ms - b.ms);

  const ms = Math.max(0, Math.floor(remainingMs));

  const first = table[0] as (typeof table)[number];
  const last = table[table.length - 1] as (typeof table)[number];

  // Below the first anchor: the cheapest anchor's price, never under the minimum.
  if (ms <= first.ms) return Math.max(floor, first.gems);

  // Above the last anchor: flat, rather than extrapolated.
  if (ms >= last.ms) return Math.max(floor, last.gems);

  for (let index = 1; index < table.length; index += 1) {
    const previous = table[index - 1] as (typeof table)[number];
    const current = table[index] as (typeof table)[number];
    const previousMs = previous.ms;
    const currentMs = current.ms;
    if (ms > currentMs) continue;

    const span = currentMs - previousMs;
    // Defensive: the validator enforces strictly ascending anchors, so a
    // non-positive span can only come from a hand-built config.
    if (span <= 0) return Math.max(floor, previous.gems);

    // Exact rational interpolation, spec Section 6.4 (integer arithmetic only):
    //
    //   gems = previous.gems + deltaGems * offsetMs / span
    //
    // rounded half up, which is `Math.round`'s convention for the non-negative
    // prices the validator admits. BigInt carries the intermediate product
    // because a schema-valid config may pair a large anchor with a large gem
    // count, and `deltaGems * offsetMs` can exceed Number.MAX_SAFE_INTEGER.
    // The result is converted back to a number only when it fits.
    const deltaGems = current.gems - previous.gems;
    const offsetMs = Math.max(0, ms - previousMs);
    const numerator = BigInt(deltaGems) * BigInt(offsetMs);
    const denominator = BigInt(span);
    // floor((2 * delta * offset + span) / (2 * span)) — round half up.
    const rounded = (2n * numerator + denominator) / (2n * denominator);

    const total = BigInt(previous.gems) + rounded;
    if (total > MAX_SAFE_BIGINT) return Math.max(floor, Number.MAX_SAFE_INTEGER);
    return Math.max(floor, Number(total));
  }

  return Math.max(floor, last.gems);
}

/**
 * The gem price of the next builder, or undefined when the shop has nothing
 * left to sell or the player somehow owns fewer than the configured starting
 * count (which would index the price table negatively).
 */
export function nextBuilderCost(state: PlayerState, config: GameConfig): number | undefined {
  const purchaseIndex = state.builders.count - config.starter.builders;
  if (purchaseIndex < 0 || purchaseIndex >= config.economy.builders.costs.length) return undefined;
  const cost = config.economy.builders.costs[purchaseIndex] as ResourceAmount | undefined;
  return cost?.gems;
}

/** True when another builder can still be bought. */
export function canBuyBuilder(state: PlayerState, config: GameConfig): boolean {
  return state.builders.count < config.economy.builders.maxBuilders;
}
