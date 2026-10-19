import { describe, expect, it } from 'vitest';
import {
  hashState,
  hashString,
  hashValue,
  stableParse,
  stableStringify,
} from '../src/serialize/index.js';
import { createNewPlayerState } from '../src/state/index.js';
import { NOW, TEST_CONFIG } from './fixtures/config.js';

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined-valued keys, like JSON does', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(JSON.parse(stableStringify({ a: 1, b: undefined }))).toEqual({ a: 1 });
  });

  it('normalises -0 and non-finite numbers', () => {
    expect(stableStringify(-0)).toBe('0');
    expect(stableStringify(Number.NaN)).toBe('null');
    expect(stableStringify(Number.POSITIVE_INFINITY)).toBe('null');
  });

  it('round-trips a player state exactly', () => {
    const state = createNewPlayerState(TEST_CONFIG, NOW);
    expect(stableParse(stableStringify(state))).toEqual(state);
  });

  it('rejects values that cannot appear in game state', () => {
    expect(() => stableStringify(10n)).toThrow(TypeError);
    expect(() => stableStringify(() => 1)).toThrow(TypeError);
    expect(() => stableStringify(new Map())).toThrow(TypeError);
    expect(() => stableStringify(new Set())).toThrow(TypeError);
  });

  it('detects circular references', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => stableStringify(circular)).toThrow(TypeError);
  });

  it('does not treat a repeated (non-circular) reference as a cycle', () => {
    const shared = { x: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe('hashing', () => {
  it('returns a 16-character hex fingerprint', () => {
    expect(hashString('emberhold')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable for the same input and different for different input', () => {
    expect(hashString('a')).toBe(hashString('a'));
    expect(hashString('a')).not.toBe(hashString('b'));
  });

  it('separates concatenations that differ only in the split point', () => {
    expect(hashString('ab')).not.toBe(hashString('a') + hashString('b').slice(0, 0) + 'ab');
    expect(hashString('ab')).not.toBe(hashString('ba'));
  });

  it('hashes whole values', () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it('fingerprints a state and changes when the state changes', () => {
    const state = createNewPlayerState(TEST_CONFIG, NOW);
    const before = hashState(state);
    const after = hashState({ ...state, resources: { ...state.resources, gold: 1 } });
    expect(before).toMatch(/^[0-9a-f]{16}$/);
    expect(after).not.toBe(before);
  });
});

describe('stableStringify edge cases', () => {
  it('mirrors JSON.stringify for negative zero and non-finite numbers', () => {
    expect(stableStringify(-0)).toBe('0');
    expect(stableStringify(Number.NaN)).toBe('null');
    expect(stableStringify(Number.POSITIVE_INFINITY)).toBe('null');
  });

  it('serialises a bare undefined as null', () => {
    expect(stableStringify(undefined)).toBe('null');
  });

  it('round-trips through stableParse', () => {
    expect(stableParse('{"a":[1,2],"b":null}')).toEqual({ a: [1, 2], b: null });
  });

  it('rejects values that JSON cannot represent', () => {
    expect(() => stableStringify(10n)).toThrow(TypeError);
    expect(() => stableStringify(() => 1)).toThrow(TypeError);
    expect(() => stableStringify(Symbol('x'))).toThrow(TypeError);
  });

  it('rejects circular structures', () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(() => stableStringify(loop)).toThrow(/circular/);
  });
});
