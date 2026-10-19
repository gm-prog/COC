/**
 * Stable serialization and hashing.
 *
 * `stableStringify` sorts object keys recursively so two states that differ only
 * in key order hash identically — which is what makes "same input => identical
 * result" checkable. `hashState` combines two independent 32-bit hashes so a
 * single collision is very unlikely; it is a *test* tool, not a security
 * primitive.
 */

import type { PlayerState } from '../state/index.js';

/** Deterministic JSON with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  return serializeValue(value, new Set());
}

/** Parses the output of {@link stableStringify} back into a plain value. */
export function stableParse<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}

/** 64-bit-ish fingerprint of a string: two independent 32-bit hashes. */
export function hashString(value: string): string {
  return `${fnv1a(value).toString(16).padStart(8, '0')}${sdbm(value)
    .toString(16)
    .padStart(8, '0')}`;
}

/** Fingerprint of any JSON-shaped value. */
export function hashValue(value: unknown): string {
  return hashString(stableStringify(value));
}

/** Fingerprint of a player state — the canonical determinism check. */
export function hashState(state: PlayerState): string {
  return hashString(stableStringify(state));
}

function serializeValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';

  switch (typeof value) {
    case 'number':
      // JSON.stringify turns -0 into 0; mirror that so hashes are stable.
      return Object.is(value, -0) ? '0' : Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('stableStringify: bigint is not supported in game state');
    case 'function':
    case 'symbol':
      throw new TypeError(`stableStringify: ${typeof value} is not supported in game state`);
    case 'object':
      break;
    default:
      throw new TypeError(`stableStringify: unsupported type ${typeof value}`);
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError('stableStringify: circular reference in game state');
  }
  seen.add(object);

  let result: string;
  if (Array.isArray(object)) {
    result = `[${object.map((item) => serializeValue(item, seen)).join(',')}]`;
  } else if (object instanceof Map || object instanceof Set) {
    throw new TypeError('stableStringify: Map/Set are not supported in game state');
  } else {
    const record = object as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${serializeValue(record[key], seen)}`);
    }
    result = `{${parts.join(',')}}`;
  }

  seen.delete(object);
  return result;
}

/** FNV-1a, 32-bit. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** sdbm, 32-bit. Independent of FNV-1a. */
function sdbm(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (value.charCodeAt(i) + (hash << 6) + (hash << 16) - hash) | 0;
  }
  return hash >>> 0;
}
