/**
 * Seeded pseudo-random number generator (mulberry32).
 *
 * The spec demands "No Math.random" inside sim-core and "Seeded PRNG ... in the
 * battle context; the seed is part of the battle record". The API is therefore
 * **pure and explicit**: every draw takes a state and returns the value plus the
 * next state, so a battle's RNG can be snapshotted, replayed and re-simulated
 * byte-for-byte. `Math.imul` keeps every step in 32-bit integer arithmetic.
 */

export interface RngState {
  /** The seed this generator was created from (kept for serialization). */
  readonly seed: number;
  /**
   * Current internal state, always an unsigned 32-bit integer. Keeping it
   * unsigned (rather than `| 0`) is what makes `serializeRng`/`deserializeRng`
   * an exact inverse: a signed state would come back positive and the resumed
   * stream would diverge from the original.
   */
  readonly state: number;
}

/** Creates a generator from a 32-bit seed. */
export function createRng(seed: number): RngState {
  const normalized = normalizeSeed(seed);
  return { seed: normalized, state: normalized };
}

/** Draws the next raw uint32 and the state that follows it. */
export function nextUint32(rng: RngState): readonly [number, RngState] {
  const nextState = (rng.state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(nextState ^ (nextState >>> 15), 1 | nextState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = (t ^ (t >>> 14)) >>> 0;
  return [value, { seed: rng.seed, state: nextState }];
}

/** Draws a float in [0, 1). */
export function nextFloat(rng: RngState): readonly [number, RngState] {
  const [value, next] = nextUint32(rng);
  return [value / 0x100000000, next];
}

/** Draws an integer in [minInclusive, maxExclusive). */
export function nextInt(
  rng: RngState,
  minInclusive: number,
  maxExclusive: number,
): readonly [number, RngState] {
  if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
    throw new RangeError('nextInt: bounds must be integers');
  }
  if (maxExclusive <= minInclusive) {
    throw new RangeError('nextInt: maxExclusive must be greater than minInclusive');
  }
  const span = maxExclusive - minInclusive;
  const [value, next] = nextUint32(rng);
  return [minInclusive + (value % span), next];
}

/** Draws a boolean that is true with probability `numerator / denominator`. */
export function nextChance(
  rng: RngState,
  numerator: number,
  denominator: number,
): readonly [boolean, RngState] {
  if (denominator <= 0) throw new RangeError('nextChance: denominator must be positive');
  const [value, next] = nextUint32(rng);
  return [value % denominator < numerator, next];
}

/** Picks one element of a non-empty list. */
export function nextPick<T>(rng: RngState, items: readonly T[]): readonly [T, RngState] {
  if (items.length === 0) throw new RangeError('nextPick: list is empty');
  const [index, next] = nextInt(rng, 0, items.length);
  return [items[index] as T, next];
}

/** Serializes a generator state to a compact stable string. */
export function serializeRng(rng: RngState): string {
  return `${rng.seed}:${rng.state >>> 0}`;
}

/** Inverse of {@link serializeRng}. Throws on malformed input. */
export function deserializeRng(serialized: string): RngState {
  const parts = serialized.split(':');
  if (parts.length !== 2) {
    throw new RangeError(`deserializeRng: expected "seed:state", received "${serialized}"`);
  }
  const seed = Number(parts[0]);
  const state = Number(parts[1]);
  if (!Number.isInteger(seed) || !Number.isInteger(state)) {
    throw new RangeError(`deserializeRng: non-integer components in "${serialized}"`);
  }
  return { seed: normalizeSeed(seed), state: normalizeSeed(state) };
}

/**
 * Derives a stable 32-bit seed from arbitrary parts (FNV-1a). Lets a battle be
 * keyed by e.g. `deriveSeed(battleId, configVersion, tick)` without any of it
 * depending on wall-clock time.
 */
export function deriveSeed(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    // Separator so ['ab','c'] and ['a','bc'] differ.
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) throw new RangeError('RNG seed must be a finite number');
  return seed >>> 0;
}
