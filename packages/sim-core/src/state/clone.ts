/**
 * Dependency-free deep clone for plain state data.
 *
 * `structuredClone` would do, but it is not part of the ES2022 lib that sim-core
 * compiles against and we deliberately keep this package free of ambient
 * globals. Player state is JSON-shaped data, so a recursive copy is exact and
 * preserves key insertion order (which `stableStringify` normalises anyway).
 */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const target: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      target[key] = deepClone(source[key]);
    }
    return target as T;
  }
  return value;
}
