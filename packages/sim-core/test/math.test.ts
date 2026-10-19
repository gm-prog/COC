import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  TICKS_PER_SECOND,
  TICK_MS,
  chebyshevTiles,
  clamp,
  clampInt,
  distanceFixed,
  distanceSquaredTiles,
  fixedDiv,
  fixedMul,
  fromFixedUnits,
  hypotFixed,
  isqrt,
  roundToNearest,
  toFixedUnits,
} from '../src/math/index.js';

describe('fixed-point constants', () => {
  it('uses 1000 sim units per tile', () => {
    expect(FIXED_ONE).toBe(1000);
  });

  it('runs the simulation at 20 ticks per second', () => {
    expect(TICKS_PER_SECOND).toBe(20);
    expect(TICK_MS).toBe(50);
  });
});

describe('clamp', () => {
  it('keeps values inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });

  it('rounds when asked for an integer', () => {
    expect(clampInt(5.4, 0, 10)).toBe(5);
    expect(clampInt(5.6, 0, 10)).toBe(6);
  });
});

describe('roundToNearest', () => {
  it('rounds to the nearest multiple', () => {
    expect(roundToNearest(1234, 10)).toBe(1230);
    expect(roundToNearest(1235, 10)).toBe(1240);
    // Math.round rounds halves toward +infinity.
    expect(roundToNearest(-1235, 10)).toBe(-1230);
  });

  it('rejects a non-positive step', () => {
    expect(() => roundToNearest(10, 0)).toThrow(RangeError);
  });
});

describe('unit conversion', () => {
  it('converts tiles to sim units and back', () => {
    expect(toFixedUnits(3)).toBe(3000);
    expect(fromFixedUnits(3000)).toBe(3);
  });

  it('refuses fractional tiles', () => {
    expect(() => toFixedUnits(1.5)).toThrow(RangeError);
  });
});

describe('fixedMul / fixedDiv', () => {
  it('multiplies and divides in fixed point', () => {
    expect(fixedMul(1500, 1500)).toBe(2250);
    expect(fixedDiv(2250, 1500)).toBe(1500);
  });

  it('rounds to the nearest integer', () => {
    expect(fixedMul(1, 500)).toBe(1); // 0.5 rounds up
    expect(fixedDiv(1, 3)).toBe(333); // 333.33 rounds down
    expect(fixedDiv(2, 3)).toBe(667); // 666.67 rounds up
  });

  it('rejects division by zero and non-integers', () => {
    expect(() => fixedDiv(1, 0)).toThrow(RangeError);
    expect(() => fixedMul(1.5, 2)).toThrow(RangeError);
    expect(() => fixedDiv(1.5, 2)).toThrow(RangeError);
  });
});

describe('isqrt', () => {
  it('matches floor(sqrt(n)) for every n below 30000', () => {
    for (let n = 0; n < 30_000; n += 1) {
      expect(isqrt(n)).toBe(Math.floor(Math.sqrt(n)));
    }
  });

  it('is exact for perfect squares and their neighbours', () => {
    for (let root = 1; root < 5000; root += 1) {
      const square = root * root;
      expect(isqrt(square)).toBe(root);
      expect(isqrt(square - 1)).toBe(root - 1);
      expect(isqrt(square + 1)).toBe(root);
    }
  });

  it('handles values far beyond 2^32', () => {
    // (2^26)^2 = 2^52 — well past the point where 32-bit shifts wrap.
    expect(isqrt(2 ** 52)).toBe(2 ** 26);
    expect(isqrt(2 ** 52 - 1)).toBe(2 ** 26 - 1);
    // Just below the largest exactly-representable integer.
    expect(isqrt(Number.MAX_SAFE_INTEGER)).toBe(94_906_265);
  });

  it('rejects negative and non-integer input', () => {
    expect(() => isqrt(-1)).toThrow(RangeError);
    expect(() => isqrt(2.5)).toThrow(RangeError);
  });
});

describe('hypotFixed / distanceFixed', () => {
  it('computes integer hypotenuses', () => {
    expect(hypotFixed(3000, 4000)).toBe(5000);
    expect(hypotFixed(0, 0)).toBe(0);
    expect(hypotFixed(-3000, 4000)).toBe(5000);
  });

  it('measures the distance between two points', () => {
    expect(distanceFixed(0, 0, 3000, 4000)).toBe(5000);
  });

  it('rejects non-integer deltas', () => {
    expect(() => hypotFixed(1.5, 0)).toThrow(RangeError);
  });
});

describe('tile helpers', () => {
  it('measures Chebyshev distance in tiles', () => {
    expect(chebyshevTiles(0, 0, 3, 5)).toBe(5);
    expect(chebyshevTiles(0, 0, -3, 5)).toBe(5);
  });

  it('measures squared distance scaled by FIXED_ONE', () => {
    expect(distanceSquaredTiles(0, 0, 3, 4)).toBe(25 * FIXED_ONE * FIXED_ONE);
  });
});
