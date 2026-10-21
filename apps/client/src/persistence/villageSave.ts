import {
  catchUp,
  clonePlayerState,
  GRID,
  isKeepLevelConsistent,
  RESOURCE_IDS,
  type CatchUpEvent,
  type GameConfig,
  type PlayerState,
} from '@coc/sim-core';

/**
 * Local village persistence (spec §Phase 3: "Local persistence in IndexedDB
 * (temporary), autosave on every command, safe migration versioning").
 *
 * Three concerns are deliberately separate:
 *
 * 1. **The storage envelope** is versioned by `schemaVersion`, independently of
 *    IndexedDB's own database version. Raising the database version changes the
 *    on-disk *layout* (a new object store or index); raising `schemaVersion`
 *    changes the *shape of the record* inside an existing store. Conflating them
 *    would force an `onupgradeneeded` round trip — and a blocked-upgrade dance
 *    between tabs — for what is only a JSON change.
 *
 * 2. **Validation** decides whether a persisted record may replace the running
 *    village. It is not a second rules engine: `sim-core` remains authoritative
 *    for what a legal command may do. This layer only rejects records that could
 *    not have come from this build — wrong shape, wrong config, impossible
 *    coordinates, dangling builder assignments.
 *
 * 3. **Restoration** replays elapsed time through `catchUp`, the same function
 *    the running client uses. Nothing here reads the wall clock: `now` is always
 *    a parameter.
 */

// ------------------------------------------------------------------ constants

/**
 * Database name. Stable across releases: renaming it orphans every existing
 * player's village, so it may only change with an explicit migration plan.
 */
export const SAVE_DB_NAME = 'emberhold';
/**
 * IndexedDB database version. Raise it only when the *store layout* changes,
 * never for envelope changes — those are {@link SAVE_SCHEMA_VERSION}.
 */
export const SAVE_DB_VERSION = 1;
/** Object store holding village saves. */
export const SAVE_STORE_NAME = 'village';
/** Single-key store: one local village per browser profile. */
export const SAVE_KEY = 'current';
/**
 * Version of the record stored under {@link SAVE_KEY}.
 *
 * v1 is the first format that ever shipped, so there are no historical
 * migrations to write. The dispatch machinery below exists for the *next*
 * change; inventing a v0 would mean maintaining a format no player ever had.
 */
export const SAVE_SCHEMA_VERSION = 1;

// -------------------------------------------------------------------- envelope

/** The record stored in IndexedDB, schema v1. */
export interface VillageSaveV1 {
  schemaVersion: 1;
  /** Epoch milliseconds when the record was written (audit/debug only). */
  savedAt: number;
  /** `GAME_CONFIG.version` at write time; a mismatch means a different build. */
  configVersion: GameConfig['version'];
  /** The complete serializable village state. Plain JSON by construction. */
  state: PlayerState;
}

export type VillageSave = VillageSaveV1;

// --------------------------------------------------------------------- errors

export type SaveProblemCode =
  /** IndexedDB is missing, blocked, or the transaction failed. */
  | 'storage_unavailable'
  /** The stored record is not a valid save of a supported schema. */
  | 'malformed'
  /** The record declares a schema version this build cannot read. */
  | 'unsupported_schema'
  /** The record was written against a different game-data config. */
  | 'incompatible_config';

export interface SaveProblem {
  code: SaveProblemCode;
  message: string;
}

/**
 * Outcome of reading the store.
 *
 * `unreadable` is kept distinct from `empty` on purpose: a record exists but
 * was rejected. The caller must not treat that as "new player" and overwrite
 * it — the player may still recover it with a newer build.
 */
export type VillageLoadResult =
  | { status: 'loaded'; save: VillageSave }
  | { status: 'empty' }
  | { status: 'unreadable'; problem: SaveProblem }
  | { status: 'unavailable'; problem: SaveProblem };

// ------------------------------------------------------------------- storage

/**
 * The storage seam. Implemented by IndexedDB in the browser and by in-memory
 * doubles in tests, so the load/save logic never touches `indexedDB` directly.
 */
export interface VillageStorage {
  /** Resolves `undefined` when no save exists. Rejects if the store is unusable. */
  read(): Promise<unknown>;
  /** Resolves only once the write is committed; rejects otherwise. */
  write(save: VillageSave): Promise<void>;
}

/** Thrown when the store cannot be used. Never thrown for validation problems. */
export class SaveStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SaveStorageError';
  }
}

/**
 * IndexedDB-backed storage.
 *
 * Writes resolve on `transaction.oncomplete`, not on the `put` request's
 * `success` event: the request succeeding only means the value was queued, and
 * the transaction can still abort afterwards (quota, disk error). Resolving
 * early would let the client report a save that never committed.
 */
export class IndexedDbVillageStorage implements VillageStorage {
  private readonly factory: IDBFactory | undefined;
  private openPromise: Promise<IDBDatabase> | undefined;

  constructor(factory?: IDBFactory) {
    this.factory =
      factory ?? (typeof globalThis.indexedDB !== 'undefined' ? globalThis.indexedDB : undefined);
  }

  async read(): Promise<unknown> {
    const db = await this.open();
    return new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(SAVE_STORE_NAME, 'readonly');
      const request = tx.objectStore(SAVE_STORE_NAME).get(SAVE_KEY);
      request.onsuccess = () => resolve(request.result as unknown);
      request.onerror = () =>
        reject(new SaveStorageError('IndexedDB read failed', { cause: request.error }));
      tx.onabort = () =>
        reject(new SaveStorageError('IndexedDB read was aborted', { cause: tx.error }));
    });
  }

  async write(save: VillageSave): Promise<void> {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SAVE_STORE_NAME, 'readwrite');
      tx.objectStore(SAVE_STORE_NAME).put(save, SAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(new SaveStorageError('IndexedDB write failed', { cause: tx.error }));
      tx.onabort = () =>
        reject(new SaveStorageError('IndexedDB write was aborted', { cause: tx.error }));
    });
  }

  /** Closes the shared connection. Safe to call more than once. */
  close(): void {
    void this.openPromise?.then((db) => db.close()).catch(() => undefined);
    this.openPromise = undefined;
  }

  private open(): Promise<IDBDatabase> {
    // One connection per storage instance: opening on every save would leak
    // them, and browsers only allow a handful.
    this.openPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const factory = this.factory;
      if (!factory) {
        reject(new SaveStorageError('IndexedDB is not available in this environment'));
        return;
      }

      let request: IDBOpenDBRequest;
      try {
        request = factory.open(SAVE_DB_NAME, SAVE_DB_VERSION);
      } catch (error) {
        reject(new SaveStorageError('IndexedDB could not be opened', { cause: error }));
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SAVE_STORE_NAME)) {
          db.createObjectStore(SAVE_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new SaveStorageError('IndexedDB open failed', { cause: request.error }));
      // `onblocked` fires while another tab holds an older version open. The
      // request stays pending until that tab closes, so the caller's timeout is
      // what bounds it; rejecting here would be premature.
    });
    return this.openPromise;
  }
}

// ----------------------------------------------------------------- migrations

/**
 * Transforms a record of version `N` into version `N + 1`.
 *
 * Receives the raw stored value and returns the raw replacement. It must not
 * mutate its input; the caller commits the result only after the whole chain
 * succeeds.
 */
export type SaveMigration = (record: Record<string, unknown>) => Record<string, unknown>;

export type SaveMigrationRegistry = Readonly<Record<number, SaveMigration>>;

/**
 * Migrations from each older schema version to the next.
 *
 * Empty by design: {@link SAVE_SCHEMA_VERSION} is 1 and no player has ever
 * written another format. When v2 ships, add `1: migrateV1ToV2` here and raise
 * `SAVE_SCHEMA_VERSION`.
 */
export const SAVE_MIGRATIONS: SaveMigrationRegistry = Object.freeze({});

export type MigrationResult =
  { ok: true; record: Record<string, unknown> } | { ok: false; problem: SaveProblem };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Brings a raw record up to {@link SAVE_SCHEMA_VERSION}.
 *
 * Future versions are rejected outright: a v2 record read by a v1 build may
 * carry fields this build cannot interpret, and silently dropping them would
 * destroy the player's progress on the next save. The record is left intact.
 */
export function migrateSave(
  raw: unknown,
  migrations: SaveMigrationRegistry = SAVE_MIGRATIONS,
  /**
   * Target schema version. Defaults to this build's. Tests raise it to exercise
   * the chaining logic without shipping a migration for a format no player has.
   */
  targetVersion: number = SAVE_SCHEMA_VERSION,
): MigrationResult {
  if (!isRecord(raw)) {
    return { ok: false, problem: { code: 'malformed', message: 'save record is not an object' } };
  }

  const version = raw.schemaVersion;
  if (!isPositiveInteger(version)) {
    return {
      ok: false,
      problem: { code: 'malformed', message: 'save record has no valid schemaVersion' },
    };
  }

  if (version > targetVersion) {
    return {
      ok: false,
      problem: {
        code: 'unsupported_schema',
        message: `save schema v${version} is newer than this build supports (v${targetVersion})`,
      },
    };
  }

  let current = raw;
  for (let from = version; from < targetVersion; from += 1) {
    const migration = migrations[from];
    if (!migration) {
      return {
        ok: false,
        problem: {
          code: 'unsupported_schema',
          message: `no migration path from save schema v${from} to v${from + 1}`,
        },
      };
    }
    try {
      current = migration(current);
    } catch (error) {
      return {
        ok: false,
        problem: {
          code: 'malformed',
          message: `migration from save schema v${from} failed: ${String(error)}`,
        },
      };
    }
    if (!isRecord(current)) {
      return {
        ok: false,
        problem: {
          code: 'malformed',
          message: `migration from save schema v${from} produced a non-object`,
        },
      };
    }
    // The migration owns the payload, not the version bookkeeping; stamping it
    // here stops a forgetful migration from silently no-op'ing the chain.
    current = { ...current, schemaVersion: from + 1 };
  }

  return { ok: true, record: current };
}

// ---------------------------------------------------------------- validation

const RESOURCE_ID_SET = new Set<string>(RESOURCE_IDS);

/**
 * Checks the parts of a `PlayerState` that storage can get wrong.
 *
 * Returns human-readable reasons rather than throwing, so the caller can log a
 * precise diagnosis without a stack trace.
 */
export function validatePersistedState(raw: unknown, config: GameConfig): string[] {
  const problems: string[] = [];
  if (!isRecord(raw)) return ['state is not an object'];

  // Entity types are checked against the running config: a saved building the
  // current config no longer defines would render and simulate as nothing.
  const knownBuildingTypes = new Set(config.buildings.map((definition) => definition.id));
  const knownObstacleTypes = new Set(config.obstacles.map((definition) => definition.id));

  if (!isPositiveInteger(raw.version)) problems.push('state.version must be a positive integer');
  if (typeof raw.configVersion !== 'string') problems.push('state.configVersion must be a string');
  if (!isPositiveInteger(raw.keepLevel))
    problems.push('state.keepLevel must be a positive integer');
  if (!isNonNegativeInteger(raw.lastSyncAt)) {
    problems.push('state.lastSyncAt must be a non-negative integer timestamp');
  }

  // Resources hold whole units only (spec §7.1 stores integers; fractional
  // production lives in a building buffer's remainder, never here).
  if (!isRecord(raw.resources)) {
    problems.push('state.resources must be an object');
  } else {
    for (const id of RESOURCE_IDS) {
      if (!isNonNegativeInteger(raw.resources[id])) {
        problems.push(`state.resources.${id} must be a non-negative integer`);
      }
    }
    for (const key of Object.keys(raw.resources)) {
      if (!RESOURCE_ID_SET.has(key)) problems.push(`state.resources has unknown resource "${key}"`);
    }
  }

  const entityIds = new Set<number>();
  if (!Array.isArray(raw.buildings)) {
    problems.push('state.buildings must be an array');
  } else {
    raw.buildings.forEach((entry: unknown, index: number) => {
      const at = `state.buildings[${index}]`;
      if (!isRecord(entry)) {
        problems.push(`${at} is not an object`);
        return;
      }
      if (!isPositiveInteger(entry.id)) problems.push(`${at}.id must be a positive integer`);
      else if (entityIds.has(entry.id)) problems.push(`${at}.id ${entry.id} is duplicated`);
      else entityIds.add(entry.id);

      if (typeof entry.type !== 'string' || entry.type.length === 0) {
        problems.push(`${at}.type must be a non-empty string`);
      } else if (!knownBuildingTypes.has(entry.type)) {
        problems.push(`${at}.type "${entry.type}" is not defined by this config`);
      }
      // Level 0 is a building under construction (spec §7.5), so 0 is legal.
      if (!isNonNegativeInteger(entry.level)) {
        problems.push(`${at}.level must be a non-negative integer`);
      }
      if (!isNonNegativeInteger(entry.x) || entry.x >= GRID.total) {
        problems.push(`${at}.x must be a tile column inside the ${GRID.total}×${GRID.total} grid`);
      }
      if (!isNonNegativeInteger(entry.y) || entry.y >= GRID.total) {
        problems.push(`${at}.y must be a tile row inside the ${GRID.total}×${GRID.total} grid`);
      }

      if (entry.upgrade !== undefined) {
        if (!isRecord(entry.upgrade)) {
          problems.push(`${at}.upgrade must be an object`);
        } else {
          if (!isPositiveInteger(entry.upgrade.toLevel)) {
            problems.push(`${at}.upgrade.toLevel must be a positive integer`);
          }
          if (!isNonNegativeInteger(entry.upgrade.finishAt)) {
            problems.push(`${at}.upgrade.finishAt must be a non-negative integer timestamp`);
          }
        }
      }

      if (entry.buffer !== undefined) {
        if (!isRecord(entry.buffer)) {
          problems.push(`${at}.buffer must be an object`);
        } else {
          if (!isNonNegativeInteger(entry.buffer.amount)) {
            problems.push(`${at}.buffer.amount must be a non-negative integer`);
          }
          // The remainder is an exact numerator over `economy.msPerHour`; a
          // rounded or negative value would silently change production maths.
          if (!isNonNegativeInteger(entry.buffer.remainder)) {
            problems.push(`${at}.buffer.remainder must be a non-negative integer`);
          }
          if (!isNonNegativeInteger(entry.buffer.lastAccruedAt)) {
            problems.push(`${at}.buffer.lastAccruedAt must be a non-negative integer timestamp`);
          }
        }
      }
    });
  }

  if (!Array.isArray(raw.obstacles)) {
    problems.push('state.obstacles must be an array');
  } else {
    raw.obstacles.forEach((entry: unknown, index: number) => {
      const at = `state.obstacles[${index}]`;
      if (!isRecord(entry)) {
        problems.push(`${at} is not an object`);
        return;
      }
      if (!isPositiveInteger(entry.id)) problems.push(`${at}.id must be a positive integer`);
      else if (entityIds.has(entry.id)) problems.push(`${at}.id ${entry.id} is already used`);
      else entityIds.add(entry.id);
      if (typeof entry.type !== 'string' || entry.type.length === 0) {
        problems.push(`${at}.type must be a non-empty string`);
      } else if (!knownObstacleTypes.has(entry.type)) {
        problems.push(`${at}.type "${entry.type}" is not defined by this config`);
      }
      if (!isNonNegativeInteger(entry.x) || entry.x >= GRID.total) {
        problems.push(`${at}.x must be a tile column inside the ${GRID.total}×${GRID.total} grid`);
      }
      if (!isNonNegativeInteger(entry.y) || entry.y >= GRID.total) {
        problems.push(`${at}.y must be a tile row inside the ${GRID.total}×${GRID.total} grid`);
      }
    });
  }

  if (!isRecord(raw.builders)) {
    problems.push('state.builders must be an object');
  } else {
    if (!isPositiveInteger(raw.builders.count)) {
      problems.push('state.builders.count must be a positive integer');
    }
    if (!Array.isArray(raw.builders.busy)) {
      problems.push('state.builders.busy must be an array');
    } else {
      if (raw.builders.busy.length > (raw.builders.count as number)) {
        problems.push('state.builders.busy has more assignments than builders');
      }
      raw.builders.busy.forEach((entry: unknown, index: number) => {
        const at = `state.builders.busy[${index}]`;
        if (!isRecord(entry)) {
          problems.push(`${at} is not an object`);
          return;
        }
        if (!isPositiveInteger(entry.buildingId) || !entityIds.has(entry.buildingId)) {
          // A builder assigned to a building that is not in the save would make
          // completion lookups fail forever — the builder could never be freed.
          problems.push(`${at}.buildingId must reference a building in the save`);
        }
        if (!isPositiveInteger(entry.toLevel)) {
          problems.push(`${at}.toLevel must be a positive integer`);
        }
        if (!isNonNegativeInteger(entry.finishAt)) {
          problems.push(`${at}.finishAt must be a non-negative integer timestamp`);
        }
      });
    }
  }

  // Reuses the sim-core invariant rather than re-deriving the Keep rules.
  if (
    isRecord(raw) &&
    Array.isArray(raw.buildings) &&
    entityIds.size > 0 &&
    !isKeepLevelConsistent(raw as unknown as PlayerState)
  ) {
    problems.push('state.keepLevel does not match the completed Keep level');
  }

  return problems;
}

export type EnvelopeCheck = { ok: true; save: VillageSave } | { ok: false; problem: SaveProblem };

/**
 * Validates a migrated record against this build and config.
 *
 * Order matters: shape first, then schema, then config compatibility, then
 * state contents. Reporting "different game version" for a corrupted record
 * would send the player looking for a build that could never read it.
 */
export function checkSaveEnvelope(raw: unknown, config: GameConfig): EnvelopeCheck {
  if (!isRecord(raw)) {
    return { ok: false, problem: { code: 'malformed', message: 'save record is not an object' } };
  }
  if (raw.schemaVersion !== SAVE_SCHEMA_VERSION) {
    // `migrateSave` should have normalised this; reaching here means a caller
    // skipped the migration step, which must not be papered over.
    return {
      ok: false,
      problem: {
        code: 'unsupported_schema',
        message: `save schema v${String(raw.schemaVersion)} is not the current v${SAVE_SCHEMA_VERSION}`,
      },
    };
  }
  if (!isNonNegativeInteger(raw.savedAt)) {
    return {
      ok: false,
      problem: { code: 'malformed', message: 'save.savedAt is not a timestamp' },
    };
  }
  if (typeof raw.configVersion !== 'string') {
    return {
      ok: false,
      problem: { code: 'malformed', message: 'save.configVersion is not a string' },
    };
  }
  if (raw.configVersion !== config.version) {
    return {
      ok: false,
      problem: {
        code: 'incompatible_config',
        message: `save was written for config ${raw.configVersion}, this build runs ${config.version}`,
      },
    };
  }
  if (!isRecord(raw.state)) {
    return { ok: false, problem: { code: 'malformed', message: 'save.state is not an object' } };
  }
  if (typeof raw.state.configVersion !== 'string') {
    return {
      ok: false,
      problem: { code: 'malformed', message: 'state.configVersion is not a string' },
    };
  }
  if (raw.state.configVersion !== config.version) {
    return {
      ok: false,
      problem: {
        code: 'incompatible_config',
        message: `state.configVersion ${raw.state.configVersion} does not match ${config.version}`,
      },
    };
  }

  const stateProblems = validatePersistedState(raw.state, config);
  if (stateProblems.length > 0) {
    return { ok: false, problem: { code: 'malformed', message: stateProblems.join('; ') } };
  }

  return { ok: true, save: raw as unknown as VillageSave };
}

// ------------------------------------------------------------------ snapshot

/**
 * Builds the record to persist.
 *
 * The state is cloned: writes are asynchronous, and a snapshot that shared
 * objects with the running village could change between being queued and being
 * written.
 */
export function createSave(
  state: PlayerState,
  configVersion: GameConfig['version'],
  savedAt: number,
): VillageSave {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt,
    configVersion,
    state: clonePlayerState(state),
  };
}

// ---------------------------------------------------------------- restoration

export interface RestoredVillage {
  state: PlayerState;
  /** Completion events applied while catching up the offline window. */
  events: CatchUpEvent[];
  /** True when elapsed time was reconciled through `catchUp`. */
  reconciled: boolean;
  /** True when the device clock is behind the save; nothing was replayed. */
  clockWentBackwards: boolean;
}

/**
 * Reconciles a validated save with the current time.
 *
 * Expired constructions, finished upgrades and offline production are resolved
 * by `catchUp` — the same function the live client runs every second — so a
 * restored village cannot drift from one that had stayed open. Builder
 * assignments and `upgrade.finishAt` are absolute timestamps, so they complete
 * exactly once no matter how often this runs.
 *
 * If the device clock is behind `state.lastSyncAt`, `catchUp` refuses to run
 * (time cannot move backwards). The state is returned untouched rather than
 * rewound, and the caller can surface that.
 */
export function restoreVillage(
  save: VillageSave,
  config: GameConfig,
  now: number,
): RestoredVillage {
  const state = clonePlayerState(save.state);
  if (now < state.lastSyncAt) {
    return { state, events: [], reconciled: false, clockWentBackwards: true };
  }

  const caught = catchUp(state, now, config);
  if (!caught.ok) {
    return { state, events: [], reconciled: false, clockWentBackwards: false };
  }
  return {
    state: caught.state,
    events: caught.events,
    reconciled: true,
    clockWentBackwards: false,
  };
}

// ----------------------------------------------------------------------- load

/**
 * Reads, migrates, validates and returns the local village save.
 *
 * Never throws: every failure becomes a {@link VillageLoadResult} so startup can
 * decide between "new player", "play in memory", and "leave the record alone".
 */
export async function loadVillage(
  storage: VillageStorage,
  config: GameConfig,
): Promise<VillageLoadResult> {
  let raw: unknown;
  try {
    raw = await storage.read();
  } catch (error) {
    return {
      status: 'unavailable',
      problem: {
        code: 'storage_unavailable',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (raw === undefined || raw === null) return { status: 'empty' };

  const migrated = migrateSave(raw);
  if (!migrated.ok) return { status: 'unreadable', problem: migrated.problem };

  const checked = checkSaveEnvelope(migrated.record, config);
  if (!checked.ok) return { status: 'unreadable', problem: checked.problem };

  return { status: 'loaded', save: checked.save };
}
