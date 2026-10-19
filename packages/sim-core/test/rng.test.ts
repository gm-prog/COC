import { describe, expect, it } from 'vitest';
import {
  createRng,
  deriveSeed,
  deserializeRng,
  nextChance,
  nextFloat,
  nextInt,
  nextPick,
  nextUint32,
  serializeRng,
} from '../src/rng/index.js';

const DRAWS = 1_000_000;
const SEED = 0xc0ffee;

function drawSequence(seed: number, count: number): number[] {
  let rng = createRng(seed);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const [value, next] = nextUint32(rng);
    out.push(value);
    rng = next;
  }
  return out;
}

describe('rng', () => {
  it('produces the same sequence for the same seed', () => {
    expect(drawSequence(12345, DRAWS)).toEqual(drawSequence(12345, DRAWS));
  });

  it('produces different sequences for different seeds', () => {
    const a = drawSequence(1, 500);
    const b = drawSequence(2, 500);
    expect(a).not.toEqual(b);
  });

  it('normalises seeds to uint32', () => {
    expect(createRng(-1).seed).toBe(0xffffffff);
    expect(createRng(2 ** 32).seed).toBe(0);
  });

  it('never mutates the state it is given', () => {
    const rng = createRng(7);
    const before = { ...rng };
    nextUint32(rng);
    nextFloat(rng);
    nextInt(rng, 0, 10);
    expect(rng).toEqual(before);
  });

  it('draws floats inside [0, 1)', () => {
    let rng = createRng(99);
    for (let i = 0; i < 10_000; i += 1) {
      const [value, next] = nextFloat(rng);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      rng = next;
    }
  });

  it('draws integers inside [min, max)', () => {
    let rng = createRng(5);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i += 1) {
      const [value, next] = nextInt(rng, 3, 9);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThan(9);
      seen.add(value);
      rng = next;
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('rejects an empty or inverted integer range', () => {
    const rng = createRng(1);
    expect(() => nextInt(rng, 5, 5)).toThrow(RangeError);
    expect(() => nextInt(rng, 5, 4)).toThrow(RangeError);
  });

  it('respects the requested probability', () => {
    let rng = createRng(11);
    let hits = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const [value, next] = nextChance(rng, 1, 4);
      if (value) hits += 1;
      rng = next;
    }
    // 25% +/- a generous band; this is a sanity check, not a stats test.
    expect(hits).toBeGreaterThan(4300);
    expect(hits).toBeLessThan(5700);
  });

  it('picks every element of a list eventually', () => {
    let rng = createRng(3);
    const items = ['a', 'b', 'c', 'd'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const [value, next] = nextPick(rng, items);
      seen.add(value);
      rng = next;
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('round-trips through serialize/deserialize mid-stream', () => {
    let rng = createRng(4242);
    for (let i = 0; i < 1000; i += 1) {
      const [, next] = nextUint32(rng);
      rng = next;
    }
    const restored = deserializeRng(serializeRng(rng));
    expect(restored).toEqual(rng);
    const [a] = nextUint32(rng);
    const [b] = nextUint32(restored);
    expect(a).toBe(b);
  });

  it('rejects malformed serialized state', () => {
    expect(() => deserializeRng('1')).toThrow(RangeError);
    expect(() => deserializeRng('a:b')).toThrow(RangeError);
    expect(() => deserializeRng('1:2:3')).toThrow(RangeError);
  });

  it('derives stable, distinct seeds from parts', () => {
    expect(deriveSeed('battle', 1)).toBe(deriveSeed('battle', 1));
    expect(deriveSeed('battle', 1)).not.toBe(deriveSeed('battle', 2));
    // Order and separators matter.
    expect(deriveSeed('ab', 'c')).not.toBe(deriveSeed('a', 'bc'));
    expect(deriveSeed()).toBeTypeOf('number');
  });
});

describe('nextInt bounds', () => {
  it('requires integer bounds', () => {
    const rng = createRng(SEED);
    expect(() => nextInt(rng, 0.5, 3)).toThrow(RangeError);
    expect(() => nextInt(rng, 0, 3.5)).toThrow(RangeError);
  });

  it('requires a non-empty range', () => {
    const rng = createRng(SEED);
    expect(() => nextInt(rng, 5, 5)).toThrow(RangeError);
    expect(() => nextInt(rng, 5, 4)).toThrow(RangeError);
  });
});

describe('serialization round-trip', () => {
  it('restores a state whose internal counter has wrapped past zero', () => {
    // Drive the generator until the internal state is negative under the old
    // `| 0` convention, then prove the round-trip is still exact.
    let rng = createRng(0xdeadbeef);
    let sawWrapped = false;
    for (let i = 0; i < 5000; i += 1) {
      const [, next] = nextUint32(rng);
      if (next.state > 0x7fffffff) sawWrapped = true;
      rng = next;
    }
    expect(sawWrapped).toBe(true);

    const serialized = serializeRng(rng);
    const restored = deserializeRng(serialized);
    expect(serializeRng(restored)).toBe(serialized);

    // ...and the resumed stream matches the uninterrupted one.
    const [a] = nextUint32(rng);
    const [b] = nextUint32(restored);
    expect(b).toBe(a);
  });

  it('round-trips every step of a long run', () => {
    let rng = createRng(0x1234);
    const serialized: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      serialized.push(serializeRng(rng));
      const [, next] = nextUint32(rng);
      rng = next;
    }
    let cursor = createRng(0x1234);
    for (const snapshot of serialized) {
      expect(serializeRng(deserializeRng(snapshot))).toBe(snapshot);
      const [value, next] = nextUint32(cursor);
      const [resumedValue] = nextUint32(deserializeRng(snapshot));
      expect(resumedValue).toBe(value);
      cursor = next;
    }
  });

  it('rejects malformed input', () => {
    expect(() => deserializeRng('1')).toThrow(RangeError);
    expect(() => deserializeRng('1:2:3')).toThrow(RangeError);
    expect(() => deserializeRng('a:2')).toThrow(RangeError);
    expect(() => deserializeRng('1:b')).toThrow(RangeError);
  });
});
