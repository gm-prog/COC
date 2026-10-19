/**
 * Fixed-point / integer maths for sim-core.
 *
 * Section 6.4 of the design spec: "Integer / fixed-point math only inside
 * simulation: 1 tile = 1,000 sim-units. No Math.random, no floating-point
 * accumulation, no Date.now(), no Math.sin/cos".
 *
 * Everything here operates on plain integers so results are bit-identical on
 * every machine and JS engine. Nothing in this module calls `Math` except
 * `Math.floor`/`Math.round`/`Math.abs` on values that are already integral (and
 * therefore exact).
 */

/** One tile expressed in sim units. */
export const FIXED_ONE = 1000;

/** Number of simulation ticks per second (fixed timestep). */
export const TICKS_PER_SECOND = 20;

/** Milliseconds per simulation tick. */
export const TICK_MS = 1000 / TICKS_PER_SECOND;

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

/** Rounds to the nearest multiple of `step` (halves round toward +infinity, like Math.round). */
export function roundToNearest(value: number, step: number): number {
  if (step <= 0) throw new RangeError('roundToNearest: step must be positive');
  return Math.round(value / step) * step;
}

/** Converts a tile quantity to sim units. Rejects non-integral input. */
export function toFixedUnits(tiles: number): number {
  assertInteger(tiles, 'toFixedUnits');
  return tiles * FIXED_ONE;
}

/** Converts sim units back to a tile quantity (display only — never feed back into the sim). */
export function fromFixedUnits(units: number): number {
  return units / FIXED_ONE;
}

/** (a * b) / FIXED_ONE, rounded to nearest. Both operands are sim-unit integers. */
export function fixedMul(a: number, b: number): number {
  assertInteger(a, 'fixedMul:a');
  assertInteger(b, 'fixedMul:b');
  return Math.round((a * b) / FIXED_ONE);
}

/** (a * FIXED_ONE) / b, rounded to nearest. */
export function fixedDiv(a: number, b: number): number {
  assertInteger(a, 'fixedDiv:a');
  assertInteger(b, 'fixedDiv:b');
  if (b === 0) throw new RangeError('fixedDiv: division by zero');
  return Math.round((a * FIXED_ONE) / b);
}

/**
 * Integer square root: the largest integer `r` with `r * r <= value`.
 *
 * Digit-by-digit (binary) algorithm — exact for every value below 2^53, no
 * floating point involved, and deterministic across engines.
 *
 * Note: `>>` is avoided throughout because `ToInt32` wraps above 2^31 and the
 * intermediate `bit` easily exceeds that. Division by powers of two is exact in
 * IEEE-754, so it is safe here.
 */
export function isqrt(value: number): number {
  assertInteger(value, 'isqrt');
  if (value < 0) throw new RangeError('isqrt: value must be non-negative');
  if (value < 2) return value;

  let remainder = value;
  let result = 0;
  // Largest power of four that does not exceed value / 4 (so `bit <= value`).
  let bit = 1;
  while (bit <= value / 4) bit *= 4;

  // `bit` is always an exact power of four, so dividing it by four stays exact
  // and the loop ends cleanly once it drops below 1.
  while (bit >= 1) {
    const candidate = result + bit;
    if (remainder >= candidate) {
      remainder -= candidate;
      result = Math.floor(result / 2) + bit;
    } else {
      result = Math.floor(result / 2);
    }
    bit = bit / 4;
  }
  return result;
}

/** Integer hypotenuse of two sim-unit deltas: sqrt(dx*dx + dy*dy), floored. */
export function hypotFixed(dx: number, dy: number): number {
  assertInteger(dx, 'hypotFixed:dx');
  assertInteger(dy, 'hypotFixed:dy');
  return isqrt(dx * dx + dy * dy);
}

/** Integer distance between two points expressed in sim units. */
export function distanceFixed(ax: number, ay: number, bx: number, by: number): number {
  return hypotFixed(bx - ax, by - ay);
}

/** Chebyshev distance ("king moves") between two tiles — used for range checks. */
export function chebyshevTiles(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(bx - ax), Math.abs(by - ay));
}

/**
 * Squared distance in tiles between two tile coordinates, scaled by FIXED_ONE so
 * it stays integral: ((dx*1000)^2 + (dy*1000)^2). Useful for comparisons that
 * would otherwise need a square root.
 */
export function distanceSquaredTiles(ax: number, ay: number, bx: number, by: number): number {
  const dx = (bx - ax) * FIXED_ONE;
  const dy = (by - ay) * FIXED_ONE;
  return dx * dx + dy * dy;
}

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label}: expected an integer, received ${value}`);
  }
}
