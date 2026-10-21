import {
  buildingLimit,
  catchUp,
  clonePlayerState,
  GRID,
  isBuildableTile,
  isKeepLevelConsistent,
  isMapTile,
  KEEP_BUILDING_ID,
  MAX_BUILDERS,
  rectsOverlap,
  RESOURCE_IDS,
  STATE_VERSION,
  storageCapacity,
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
 * v1 shipped first. v2 adds `revision`, the optimistic-concurrency stamp that
 * stops a stale tab from silently overwriting a newer village; a v1 record is
 * migrated in place on read (see {@link migrateV1ToV2}) rather than discarded.
 */
export const SAVE_SCHEMA_VERSION = 2;

/**
 * Highest entity id a save may carry.
 *
 * The simulation allocates `highestEntityId + 1`, so an id at
 * `Number.MAX_SAFE_INTEGER` would make that addition unrepresentable and two
 * different ids could compare equal. One below the limit keeps the arithmetic
 * exact.
 */
export const MAX_ENTITY_ID = Number.MAX_SAFE_INTEGER - 1;

// -------------------------------------------------------------------- envelope

/** The record stored in IndexedDB, schema v1. Still readable; migrated on load. */
export interface VillageSaveV1 {
  schemaVersion: 1;
  /** Epoch milliseconds when the record was written (audit/debug only). */
  savedAt: number;
  /** `GAME_CONFIG.version` at write time; a mismatch means a different build. */
  configVersion: GameConfig['version'];
  /** The complete serializable village state. Plain JSON by construction. */
  state: PlayerState;
}

/**
 * The record stored in IndexedDB, schema v2.
 *
 * `revision` is the concurrency token. Every successful write bumps it by one,
 * and a write only commits if the record currently in the store carries exactly
 * the revision the session loaded. Two tabs that start from the same village
 * therefore cannot both commit: the second sees a revision it did not expect and
 * is told to reload instead of overwriting.
 */
export interface VillageSaveV2 {
  schemaVersion: 2;
  /** Epoch milliseconds when the record was written (audit/debug only). */
  savedAt: number;
  /** `GAME_CONFIG.version` at write time; a mismatch means a different build. */
  configVersion: GameConfig['version'];
  /** Monotonic per-key counter. A stored record is never revision 0. */
  revision: number;
  /** The complete serializable village state. Plain JSON by construction. */
  state: PlayerState;
}

export type VillageSave = VillageSaveV2;

// --------------------------------------------------------------------- errors

export type SaveProblemCode =
  /** IndexedDB is missing, blocked, or the transaction failed. */
  | 'storage_unavailable'
  /** The stored record is not a valid save of a supported schema. */
  | 'malformed'
  /** The record declares a schema version this build cannot read. */
  | 'unsupported_schema'
  /** The record was written against a different game-data config. */
  | 'incompatible_config'
  /**
   * The device clock is behind the saved village's `lastSyncAt`, so the
   * simulation refuses to move time backwards. Not a property of the record —
   * the record is fine — but it disables saving for this session, which is
   * exactly what `problem` communicates to the scene.
   */
  | 'clock_behind';

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
 * Result of a conditional write.
 *
 * A `conflict` is not a storage failure: the store worked, and it is telling the
 * session that somebody else owns a newer record. The caller must stop writing
 * and show the player how to recover.
 */
export type VillageWriteResult =
  | { ok: true; revision: number }
  /** The stored record carries a different revision than the write assumed. */
  | { ok: false; reason: 'conflict'; storedRevision: number }
  /** A record exists that this build cannot interpret; never overwritten. */
  | { ok: false; reason: 'unreadable_record' };

/**
 * The storage seam. Implemented by IndexedDB in the browser and by in-memory
 * doubles in tests, so the load/save logic never touches `indexedDB` directly.
 *
 * `write` is a compare-and-swap, not a blind put. It must check the stored
 * revision and commit the new record **inside the same IndexedDB transaction**:
 * a check-then-write split across two transactions leaves exactly the window
 * this exists to close.
 */
export interface VillageStorage {
  /** Resolves `undefined` when no save exists. Rejects if the store is unusable. */
  read(): Promise<unknown>;
  /**
   * Commits `save` only if the store currently holds `expectedRevision`.
   * Resolves only once the transaction commits; rejects on storage failure.
   */
  write(save: VillageSave, expectedRevision: number): Promise<VillageWriteResult>;
}

/**
 * The revision a *stored* record should be treated as, without migrating it.
 *
 * Mirrors what {@link migrateSave} would produce, so a legacy v1 record can be
 * upgraded by the session that loaded it without being rewritten on read.
 * `undefined` means "a value exists that this build cannot reason about" and is
 * never overwritten.
 */
export function storedRevisionOf(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion === 2) {
    return isPositiveInteger(raw.revision) ? raw.revision : undefined;
  }
  if (raw.schemaVersion === 1) {
    // v1 had no revision; migration assigns 1 (see `migrateV1ToV2`).
    return 1;
  }
  return undefined;
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

  /**
   * Compare-and-swap inside one `readwrite` transaction.
   *
   * IndexedDB runs `readwrite` transactions on the same store strictly one after
   * another, so the `get` that reads the stored revision and the `put` that
   * replaces it cannot be interleaved with another tab's write. Splitting them
   * into two transactions would reintroduce exactly the lost-update window this
   * is meant to close.
   */
  async write(save: VillageSave, expectedRevision: number): Promise<VillageWriteResult> {
    const db = await this.open();
    return new Promise<VillageWriteResult>((resolve, reject) => {
      const tx = db.transaction(SAVE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(SAVE_STORE_NAME);
      const current = store.get(SAVE_KEY);

      let outcome: VillageWriteResult | undefined;

      current.onsuccess = () => {
        const existing = current.result as unknown;
        const storedRevision = existing === undefined ? 0 : storedRevisionOf(existing);

        if (storedRevision === undefined) {
          // Something is stored that this build cannot interpret. Overwriting it
          // would destroy the only copy of whatever it is; refuse.
          outcome = { ok: false, reason: 'unreadable_record' };
          return; // empty transaction commits, nothing changed
        }
        if (storedRevision !== expectedRevision) {
          outcome = { ok: false, reason: 'conflict', storedRevision };
          return;
        }
        if (save.revision !== expectedRevision + 1) {
          throw new SaveStorageError(
            `refusing to write revision ${save.revision} on top of ${expectedRevision}`,
          );
        }
        store.put(save, SAVE_KEY);
      };

      tx.oncomplete = () => {
        if (outcome === undefined) {
          // The put was queued and the transaction committed.
          resolve({ ok: true, revision: save.revision });
        } else {
          resolve(outcome);
        }
      };
      tx.onerror = () =>
        reject(new SaveStorageError('IndexedDB write failed', { cause: tx.error }));
      tx.onabort = () =>
        reject(new SaveStorageError('IndexedDB write was aborted', { cause: tx.error }));
    });
  }

  /** Closes the shared connection. Safe to call more than once. */
  close(): void {
    const pending = this.openPromise;
    this.openPromise = undefined;
    void pending?.then((db) => db.close()).catch(() => undefined);
  }

  private open(): Promise<IDBDatabase> {
    // One connection per storage instance: opening on every save would leak
    // them, and browsers only allow a handful. Returning the cached promise is
    // also what keeps a persistent open failure from spawning a new rejected
    // promise (and an unhandled rejection) on every call.
    if (this.openPromise !== undefined) return this.openPromise;

    const promise: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
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
      request.onsuccess = () => {
        const db = request.result;
        // A newer build (another tab) wants to raise the database version. It
        // cannot proceed while this connection is open, so close and forget the
        // cached connection; the next operation reopens. Closing here does not
        // by itself protect against stale writes — the revision check does — it
        // only lets an upgrade finish instead of hanging on `blocked`.
        db.onversionchange = () => {
          db.close();
          if (this.openPromise === promise) this.openPromise = undefined;
        };
        resolve(db);
      };
      request.onerror = () =>
        reject(new SaveStorageError('IndexedDB open failed', { cause: request.error }));
      // `onblocked` fires while another tab holds an older version open. The
      // request stays pending until that tab closes, so the caller's timeout is
      // what bounds it; rejecting here would be premature.
    });
    this.openPromise = promise;
    return promise;
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
 * Upgrades a v1 record to v2.
 *
 * v1 stored no revision. A v1 record is by definition the state of a store whose
 * only writer never had to coordinate, so it becomes revision 1 — exactly what
 * the first v2 writer would have produced. Nothing else about the record
 * changes, so the player's village is carried across untouched; only the next
 * write (revision 2) replaces it.
 */
export function migrateV1ToV2(record: Record<string, unknown>): Record<string, unknown> {
  return { ...record, revision: 1 };
}

/**
 * Migrations from each older schema version to the next.
 *
 * Chained by `migrateSave`; a missing entry is a hard failure rather than a
 * silent skip, so a shipped format can never fall out of the chain.
 */
export const SAVE_MIGRATIONS: SaveMigrationRegistry = Object.freeze({
  1: migrateV1ToV2,
});

export type MigrationResult =
  { ok: true; record: Record<string, unknown> } | { ok: false; problem: SaveProblem };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Integer checks for persisted data.
 *
 * `Number.isInteger` is not enough: it accepts 2^53, where `x + 1 === x`, so an
 * id or timestamp at the edge of the range silently stops being unique. Every
 * persisted number is therefore required to be a *safe* integer.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** An entity id the simulation can still allocate `+ 1` from exactly. */
function isEntityId(value: unknown): value is number {
  return isPositiveInteger(value) && value <= MAX_ENTITY_ID;
}

/**
 * Reports indices missing from a sparse array.
 *
 * `forEach`/`map` skip holes, so `[ , building ]` would validate only the
 * building and accept a state with a phantom element that every later `for…of`
 * and `.filter` would read as `undefined`. Holes are rejected, never filled.
 */
function sparseHoles(array: readonly unknown[]): number[] {
  const holes: number[] = [];
  for (let index = 0; index < array.length; index += 1) {
    if (!(index in array)) holes.push(index);
  }
  return holes;
}

/**
 * Rejects holes in a persisted array and validates every present index.
 *
 * Used for every persisted array (`buildings`, `obstacles`, `builders.busy`,
 * `trainingQueues`, and each `trainingQueues[].items`) so no callback-based
 * iteration can hide an element behind a hole.
 */
function forEachDense(
  raw: unknown[],
  at: string,
  visit: (entry: unknown, position: number) => void,
  problems: string[],
): boolean {
  const holes = sparseHoles(raw);
  for (const hole of holes) {
    problems.push(`${at} has a hole at index ${hole}`);
  }
  for (let index = 0; index < raw.length; index += 1) {
    if (!(index in raw)) continue; // reported above; there is no content to check
    visit(raw[index], index);
  }
  return holes.length === 0;
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

/**
 * Checks the parts of a `PlayerState` that storage can get wrong.
 *
 * Returns human-readable reasons rather than throwing, so the caller can log a
 * precise diagnosis without a stack trace.
 */
/** Entity rect used for the overlap check below. */
interface EntityRect {
  id: number;
  label: string;
  rect: { x: number; y: number; w: number; h: number };
  valid: boolean;
}

/** Everything later checks need to know about the validated entities. */
interface EntityIndex {
  buildingById: Map<number, Record<string, unknown>>;
  rects: EntityRect[];
  ids: Set<number>;
  /** `state.lastSyncAt` when it is valid; buffers must not be ahead of it. */
  lastSyncAt: number | undefined;
}

/**
 * Validates the parts of a `PlayerState` that storage can get wrong.
 *
 * This is deliberately *shape and plausibility*, not a second rules engine.
 * `sim-core` remains the authority on what a legal command may do; here we only
 * reject records that could not have come out of this build and config — a
 * missing field, an impossible coordinate, a builder pointing at a building
 * that is not in the save, a buffer on something that does not produce.
 *
 * Every branch appends a human-readable reason rather than throwing, so a
 * rejected save produces a precise diagnosis instead of a stack trace.
 */
export function validatePersistedState(raw: unknown, config: GameConfig): string[] {
  const problems: string[] = [];
  if (!isRecord(raw)) return ['state is not an object'];

  validateScalars(raw, config, problems);

  if (!isRecord(raw.resources)) {
    problems.push('state.resources must be an object');
  } else {
    validateResourceTotals(raw.resources, problems);
  }

  const lastSyncAt = isNonNegativeInteger(raw.lastSyncAt) ? raw.lastSyncAt : undefined;
  const index: EntityIndex = {
    buildingById: new Map(),
    rects: [],
    ids: new Set(),
    lastSyncAt,
  };
  const buildingsSound = validateBuildings(
    raw.buildings,
    config,
    index,
    raw.keepLevel,
    lastSyncAt,
    problems,
  );
  validateObstacles(raw.obstacles, config, index, problems);
  validateEntityOverlaps(index.rects, problems);
  validateBuilders(raw.builders, index, problems);
  validateIdCountMap(raw.army, 'state.army', problems);
  validateIdCountMap(raw.spells, 'state.spells', problems);
  validateTrainingQueues(raw.trainingQueues, config, index, lastSyncAt, problems);
  validateResearch(raw.research, problems);

  // Gameplay invariants the engine maintains on every command. A state that
  // violates one could not have been produced by this build, so it is a bad
  // record rather than a rules question this layer gets to answer.
  if (buildingsSound) {
    validateBuildingLimits(raw, config, problems);
    validateResourceCapacity(raw, config, problems);
  }

  // Reuses the sim-core invariant rather than re-deriving the Keep rules.
  //
  // `isKeepLevelConsistent` is typed against `PlayerState` and trusts its input:
  // it calls `.find((building) => building.type === 'keep')` and compares
  // `level`. Running it on a raw array that still contains non-objects would
  // throw out of validation, so it is gated on the structural check above. An
  // empty array is sound and means "no Keep", which the helper handles.
  if (buildingsSound && !isKeepLevelConsistent(raw as unknown as PlayerState)) {
    problems.push('state.keepLevel does not match the completed Keep level');
  }

  return problems;
}

/** Identity, counters and optional fields that do not need the entity graph. */
function validateScalars(
  raw: Record<string, unknown>,
  config: GameConfig,
  problems: string[],
): void {
  if (raw.version !== STATE_VERSION) {
    problems.push(`state.version must be the supported STATE_VERSION ${STATE_VERSION}`);
  }
  if (typeof raw.configVersion !== 'string') {
    problems.push('state.configVersion must be a string');
  }

  const keepDef = config.buildings.find((definition) => definition.id === KEEP_BUILDING_ID);
  const maxKeepLevel =
    keepDef?.levels.reduce((highest, level) => Math.max(highest, level.level), 0) ?? 0;
  if (!isPositiveInteger(raw.keepLevel)) {
    problems.push('state.keepLevel must be a positive integer');
  } else if (maxKeepLevel > 0 && raw.keepLevel > maxKeepLevel) {
    problems.push(
      `state.keepLevel ${raw.keepLevel} exceeds the configured maximum ${maxKeepLevel}`,
    );
  }

  if (!isNonNegativeInteger(raw.lastSyncAt)) {
    problems.push('state.lastSyncAt must be a non-negative integer timestamp');
  }
  if (!isNonNegativeInteger(raw.trophies)) {
    problems.push('state.trophies must be a non-negative integer');
  }
  if (!isNonNegativeInteger(raw.tutorialStep)) {
    problems.push('state.tutorialStep must be a non-negative integer');
  }
  if (raw.shieldUntil !== undefined && !isNonNegativeInteger(raw.shieldUntil)) {
    problems.push('state.shieldUntil must be a non-negative integer timestamp when present');
  }
  if (raw.guardUntil !== undefined && !isNonNegativeInteger(raw.guardUntil)) {
    problems.push('state.guardUntil must be a non-negative integer timestamp when present');
  }

  if (raw.clan !== undefined) {
    if (!isRecord(raw.clan)) {
      problems.push('state.clan must be an object when present');
    } else {
      if (typeof raw.clan.clanId !== 'string' || raw.clan.clanId.length === 0) {
        problems.push('state.clan.clanId must be a non-empty string');
      }
      if (typeof raw.clan.role !== 'string' || raw.clan.role.length === 0) {
        problems.push('state.clan.role must be a non-empty string');
      }
    }
  }
}

/** Whole-unit resource totals: every known id, nothing unknown, no fractions. */
function validateResourceTotals(resources: Record<string, unknown>, problems: string[]): void {
  const known = new Set<string>(RESOURCE_IDS);
  for (const id of RESOURCE_IDS) {
    if (!isNonNegativeInteger(resources[id])) {
      problems.push(`state.resources.${id} must be a non-negative integer`);
    }
  }
  for (const key of Object.keys(resources)) {
    if (!known.has(key)) problems.push(`state.resources has unknown resource "${key}"`);
  }
}

/** `army`/`spells`: identifier -> whole count. */
function validateIdCountMap(raw: unknown, at: string, problems: string[]): void {
  if (!isRecord(raw)) {
    problems.push(`${at} must be an object`);
    return;
  }
  for (const [id, count] of Object.entries(raw)) {
    if (id.length === 0) problems.push(`${at} has an empty identifier`);
    if (!isNonNegativeInteger(count)) {
      problems.push(`${at}.${id} must be a non-negative integer count`);
    }
  }
}

function validateBuildings(
  raw: unknown,
  config: GameConfig,
  index: EntityIndex,
  keepLevelRaw: unknown,
  lastSyncAt: number | undefined,
  problems: string[],
): boolean {
  if (!Array.isArray(raw)) {
    problems.push('state.buildings must be an array');
    return false;
  }

  const msPerHour = config.economy.msPerHour;

  /**
   * Whether every entry is a usable `BuildingInstance`.
   *
   * The Keep invariant below is a *typed* helper from `sim-core`: it reads
   * `building.type` and compares levels without re-checking structure. Handing
   * it this raw array before it is known to be sound is what let a `null` entry
   * throw out of validation and be mistaken for a storage outage.
   */
  let sound = true;

  const keepLevel = isNonNegativeInteger(keepLevelRaw) ? keepLevelRaw : undefined;

  const dense = forEachDense(
    raw,
    'state.buildings',
    (entry: unknown, position: number) => {
      const at = `state.buildings[${position}]`;
      if (!isRecord(entry)) {
        problems.push(`${at} is not an object`);
        sound = false;
        return;
      }

      if (!isEntityId(entry.id)) {
        problems.push(`${at}.id must be a positive safe integer within the entity range`);
        sound = false;
      } else if (index.ids.has(entry.id)) {
        problems.push(`${at}.id ${entry.id} is duplicated`);
        sound = false;
      } else {
        index.ids.add(entry.id);
        index.buildingById.set(entry.id, entry);
      }

      const def =
        typeof entry.type === 'string'
          ? config.buildings.find((candidate) => candidate.id === entry.type)
          : undefined;
      if (typeof entry.type !== 'string' || entry.type.length === 0) {
        problems.push(`${at}.type must be a non-empty string`);
        sound = false;
      } else if (def === undefined) {
        problems.push(`${at}.type "${String(entry.type)}" is not defined by this config`);
        sound = false;
      }

      if (def !== undefined) {
        const levels = def.levels;
        const maxLevel = levels.reduce((highest, level) => Math.max(highest, level.level), 0);

        // Level 0 is a building under construction (spec §7.5); every other
        // level must exist in the definition.
        if (!isNonNegativeInteger(entry.level)) {
          problems.push(`${at}.level must be a non-negative integer`);
          sound = false;
        } else if (entry.level > maxLevel) {
          problems.push(`${at}.level ${entry.level} exceeds "${def.id}" maximum ${maxLevel}`);
          sound = false;
        }

        const levelDef =
          isNonNegativeInteger(entry.level) && entry.level >= 1
            ? levels.find((candidate) => candidate.level === entry.level)
            : undefined;

        // A completed level must clear its own Keep requirement. Level 0 has no
        // row of its own: it is a reservation, gated on the target level below.
        if (
          levelDef !== undefined &&
          keepLevel !== undefined &&
          levelDef.requiresKeep > keepLevel
        ) {
          problems.push(
            `${at} is at level ${levelDef.level}, which needs Keep ${levelDef.requiresKeep} but state.keepLevel is ${keepLevel}`,
          );
          sound = false;
        }

        validateUpgrade(at, entry, levels, keepLevel, lastSyncAt, problems);
        validateBuffer(at, entry, levelDef, msPerHour, problems);
      }

      index.rects.push(buildingRect(at, entry, def, problems));
    },
    problems,
  );

  validateWatermarks(index, problems);
  // A hole is not sound for the typed helpers below: `Array.prototype.find`
  // (used by `findKeep`) *visits* holes as `undefined`, so an otherwise valid
  // array with one gap still throws there. Density is part of structural soundness.
  return sound && dense;
}

/**
 * Upgrade metadata must describe exactly one step up, into a real level, and be
 * scheduled at or after the state's time watermark.
 *
 * The watermark rule is not cosmetic. `catchUp` starts its completion search at
 * `state.lastSyncAt` (`nextCompletionAt(state, cursor, now)` ignores any
 * `finishAt < cursor`), and every completion path filters on
 * `finishAt <= at`. A job scheduled *before* the watermark is therefore never
 * eligible again: the upgrade would never finish and the builder would never be
 * freed. Exactly *at* the watermark is valid — `catchUp` applies completions at
 * the cursor before accruing anything — so the boundary is `finishAt >=
 * lastSyncAt`.
 */
function validateUpgrade(
  at: string,
  entry: Record<string, unknown>,
  levels: readonly { level: number; requiresKeep: number }[],
  keepLevel: number | undefined,
  lastSyncAt: number | undefined,
  problems: string[],
): void {
  if (entry.upgrade === undefined) {
    // A level-0 building exists only because a builder reserved its footprint;
    // without an upgrade it would be an orphan that can never finish.
    if (entry.level === 0) {
      problems.push(`${at} is at level 0 but has no upgrade in flight`);
    }
    return;
  }

  if (!isRecord(entry.upgrade)) {
    problems.push(`${at}.upgrade must be an object`);
    return;
  }

  const toLevel = entry.upgrade.toLevel;
  if (!isPositiveInteger(toLevel)) {
    problems.push(`${at}.upgrade.toLevel must be a positive integer`);
  } else {
    if (isNonNegativeInteger(entry.level) && toLevel !== entry.level + 1) {
      problems.push(
        `${at}.upgrade.toLevel ${toLevel} is not one level above the current level ${entry.level}`,
      );
    }
    const target = levels.find((candidate) => candidate.level === toLevel);
    if (target === undefined) {
      problems.push(`${at}.upgrade.toLevel ${toLevel} is not a configured level`);
    } else if (keepLevel !== undefined && target.requiresKeep > keepLevel) {
      // `checkUpgrade` gates the *target* row on the completed Keep level.
      problems.push(
        `${at}.upgrade.toLevel ${toLevel} needs Keep ${target.requiresKeep} but state.keepLevel is ${keepLevel}`,
      );
    }
  }

  const finishAt = entry.upgrade.finishAt;
  if (!isNonNegativeInteger(finishAt)) {
    problems.push(`${at}.upgrade.finishAt must be a non-negative integer timestamp`);
  } else if (lastSyncAt !== undefined && finishAt < lastSyncAt) {
    problems.push(
      `${at}.upgrade.finishAt ${finishAt} is before state.lastSyncAt ${lastSyncAt} and could never complete`,
    );
  }
}

/**
 * Collector buffers may exist only on buildings that actually produce at their
 * current level, and must respect that level's cap and the exact-carry format.
 */
function validateBuffer(
  at: string,
  entry: Record<string, unknown>,
  levelDef: { produces?: string; productionPerHour?: number; bufferCap?: number } | undefined,
  msPerHour: number,
  problems: string[],
): void {
  if (entry.buffer === undefined) return;

  if (!isRecord(entry.buffer)) {
    problems.push(`${at}.buffer must be an object`);
    return;
  }

  const produces =
    levelDef !== undefined &&
    levelDef.produces !== undefined &&
    levelDef.productionPerHour !== undefined &&
    levelDef.bufferCap !== undefined;

  if (!produces) {
    problems.push(`${at}.buffer is present but the building does not produce at this level`);
    return;
  }

  const buffer = entry.buffer;
  if (!isNonNegativeInteger(buffer.amount)) {
    problems.push(`${at}.buffer.amount must be a non-negative integer`);
  } else if (buffer.amount > (levelDef.bufferCap as number)) {
    problems.push(
      `${at}.buffer.amount ${buffer.amount} exceeds the configured cap ${String(levelDef.bufferCap)}`,
    );
  }

  // The remainder is an exact numerator over `economy.msPerHour`; a negative or
  // out-of-range value would silently change production maths.
  if (!isNonNegativeInteger(buffer.remainder) || buffer.remainder >= msPerHour) {
    problems.push(`${at}.buffer.remainder must be an integer in [0, ${msPerHour})`);
  }
  if (!isNonNegativeInteger(buffer.lastAccruedAt)) {
    problems.push(`${at}.buffer.lastAccruedAt must be a non-negative integer timestamp`);
  }
}

/** Watermarks must not run ahead of the state they belong to. */
function validateWatermarks(index: EntityIndex, problems: string[]): void {
  const lastSyncAt = index.lastSyncAt;
  if (lastSyncAt === undefined) return;

  for (const [id, building] of index.buildingById) {
    const buffer = building.buffer;
    if (!isRecord(buffer)) continue;
    if (isNonNegativeInteger(buffer.lastAccruedAt) && buffer.lastAccruedAt > lastSyncAt) {
      problems.push(
        `building ${id} buffer.lastAccruedAt ${buffer.lastAccruedAt} is ahead of state.lastSyncAt ${lastSyncAt}`,
      );
    }
  }
}

function buildingRect(
  at: string,
  entry: Record<string, unknown>,
  def: { id: string; size: { w: number; h: number } } | undefined,
  problems: string[],
): EntityRect {
  const id = isPositiveInteger(entry.id) ? entry.id : -1;
  const base: EntityRect = {
    id,
    label: at,
    rect: { x: Number.NaN, y: Number.NaN, w: 0, h: 0 },
    valid: false,
  };

  if (!isNonNegativeInteger(entry.x) || !isNonNegativeInteger(entry.y)) {
    problems.push(`${at}.x and ${at}.y must be non-negative integer tile coordinates`);
    return base;
  }
  if (def === undefined) return base; // unknown type already reported

  const rect = { x: entry.x, y: entry.y, w: def.size.w, h: def.size.h };
  const bottomRight = { x: rect.x + rect.w - 1, y: rect.y + rect.h - 1 };
  if (
    !isBuildableTile(GRID, rect.x, rect.y) ||
    !isBuildableTile(GRID, bottomRight.x, bottomRight.y)
  ) {
    problems.push(
      `${at} occupies a ${rect.w}×${rect.h} footprint from (${rect.x},${rect.y}) that leaves the ${GRID.buildable}-tile buildable core`,
    );
    return base;
  }

  return { id, label: at, rect, valid: true };
}

function validateObstacles(
  raw: unknown,
  config: GameConfig,
  index: EntityIndex,
  problems: string[],
): void {
  if (!Array.isArray(raw)) {
    problems.push('state.obstacles must be an array');
    return;
  }

  forEachDense(
    raw,
    'state.obstacles',
    (entry: unknown, position: number) => {
      const at = `state.obstacles[${position}]`;
      if (!isRecord(entry)) {
        problems.push(`${at} is not an object`);
        return;
      }

      if (!isEntityId(entry.id)) {
        problems.push(`${at}.id must be a positive safe integer within the entity range`);
      } else if (index.ids.has(entry.id)) {
        problems.push(`${at}.id ${entry.id} is already used`);
      } else {
        index.ids.add(entry.id);
      }

      const def =
        typeof entry.type === 'string'
          ? config.obstacles.find((candidate) => candidate.id === entry.type)
          : undefined;
      if (typeof entry.type !== 'string' || entry.type.length === 0) {
        problems.push(`${at}.type must be a non-empty string`);
      } else if (def === undefined) {
        problems.push(`${at}.type "${String(entry.type)}" is not defined by this config`);
      }

      if (!isNonNegativeInteger(entry.x) || !isNonNegativeInteger(entry.y)) {
        problems.push(`${at}.x and ${at}.y must be non-negative integer tile coordinates`);
        return;
      }
      if (def === undefined) return;

      const rect = { x: entry.x, y: entry.y, w: def.size.w, h: def.size.h };
      const bottomRight = { x: rect.x + rect.w - 1, y: rect.y + rect.h - 1 };
      if (!isMapTile(GRID, rect.x, rect.y) || !isMapTile(GRID, bottomRight.x, bottomRight.y)) {
        problems.push(
          `${at} occupies a ${rect.w}×${rect.h} footprint that leaves the ${GRID.total}×${GRID.total} map`,
        );
        return;
      }

      index.rects.push({
        id: isEntityId(entry.id) ? entry.id : -1,
        label: at,
        rect,
        valid: true,
      });
    },
    problems,
  );
}

/** Two entities may not share a tile; the placement rules depend on it. */
function validateEntityOverlaps(rects: EntityRect[], problems: string[]): void {
  const valid = rects.filter((entry) => entry.valid);
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const a = valid[i] as EntityRect;
      const b = valid[j] as EntityRect;
      if (rectsOverlap(a.rect, b.rect)) {
        problems.push(`${a.label} overlaps ${b.label}`);
      }
    }
  }
}

/** Builders, their count, and the assignments that must mirror upgrades. */
function validateBuilders(raw: unknown, index: EntityIndex, problems: string[]): void {
  if (!isRecord(raw)) {
    problems.push('state.builders must be an object');
    return;
  }

  if (!isPositiveInteger(raw.count)) {
    problems.push('state.builders.count must be a positive integer');
  } else if (raw.count > MAX_BUILDERS) {
    problems.push(`state.builders.count ${raw.count} exceeds the maximum ${MAX_BUILDERS}`);
  }

  if (!Array.isArray(raw.busy)) {
    problems.push('state.builders.busy must be an array');
    return;
  }
  if (isPositiveInteger(raw.count) && raw.busy.length > raw.count) {
    problems.push('state.builders.busy has more assignments than builders');
  }

  const assigned = new Map<number, string[]>();
  forEachDense(
    raw.busy,
    'state.builders.busy',
    (entry: unknown, position: number) => {
      const at = `state.builders.busy[${position}]`;
      if (!isRecord(entry)) {
        problems.push(`${at} is not an object`);
        return;
      }

      if (!isEntityId(entry.buildingId)) {
        problems.push(`${at}.buildingId must be a positive safe integer`);
      } else {
        const building = index.buildingById.get(entry.buildingId);
        if (building === undefined) {
          // A builder assigned to a building that is not in the save would make
          // completion lookups fail forever — the builder could never be freed.
          problems.push(`${at}.buildingId must reference a building in the save`);
        } else {
          const upgrade = building.upgrade;
          if (!isRecord(upgrade)) {
            problems.push(`${at}.buildingId ${entry.buildingId} has no upgrade in flight`);
          } else {
            if (entry.toLevel !== upgrade.toLevel) {
              problems.push(`${at}.toLevel does not match its building's upgrade`);
            }
            if (entry.finishAt !== upgrade.finishAt) {
              problems.push(`${at}.finishAt does not match its building's upgrade`);
            }
          }
          const list = assigned.get(entry.buildingId) ?? [];
          list.push(at);
          assigned.set(entry.buildingId, list);
        }
      }

      if (!isPositiveInteger(entry.toLevel)) {
        problems.push(`${at}.toLevel must be a positive integer`);
      }
      if (!isNonNegativeInteger(entry.finishAt)) {
        problems.push(`${at}.finishAt must be a non-negative integer timestamp`);
      }
    },
    problems,
  );

  for (const [id, building] of index.buildingById) {
    if (!isRecord(building.upgrade)) continue;
    const jobs = assigned.get(id) ?? [];
    if (jobs.length === 0) {
      problems.push(`building ${id} has an upgrade in flight but no builder assigned`);
    } else if (jobs.length > 1) {
      problems.push(`building ${id} has ${jobs.length} builders assigned`);
    }
  }
}

/**
 * Queue shape, barracks ownership, and the same temporal rule as upgrades.
 *
 * `completeTrainingAt` finishes items with `finishAt <= at`, and
 * `nextCompletionAt` ignores anything before the cursor (`lastSyncAt`). An item
 * scheduled earlier than the watermark is therefore unreachable: the troops
 * would be stuck in the queue forever. Exactly at the watermark is fine.
 */
function validateTrainingQueues(
  raw: unknown,
  config: GameConfig,
  index: EntityIndex,
  lastSyncAt: number | undefined,
  problems: string[],
): void {
  if (!Array.isArray(raw)) {
    problems.push('state.trainingQueues must be an array');
    return;
  }

  forEachDense(
    raw,
    'state.trainingQueues',
    (queue: unknown, position: number) => {
      const at = `state.trainingQueues[${position}]`;
      if (!isRecord(queue)) {
        problems.push(`${at} is not an object`);
        return;
      }

      if (!isEntityId(queue.barracksId)) {
        problems.push(`${at}.barracksId must be a positive safe integer`);
      } else {
        const building = index.buildingById.get(queue.barracksId);
        if (building === undefined) {
          problems.push(`${at}.barracksId must reference a building in the save`);
        } else {
          const def = config.buildings.find((candidate) => candidate.id === building.type);
          const level = def?.levels.find((candidate) => candidate.level === building.level);
          if (level?.queueSlots === undefined) {
            problems.push(`${at}.barracksId ${queue.barracksId} is not a barracks`);
          }
        }
      }

      if (!Array.isArray(queue.items)) {
        problems.push(`${at}.items must be an array`);
        return;
      }
      forEachDense(
        queue.items,
        `${at}.items`,
        (item: unknown, slot: number) => {
          const itemAt = `${at}.items[${slot}]`;
          if (!isRecord(item)) {
            problems.push(`${itemAt} is not an object`);
            return;
          }
          if (typeof item.troopId !== 'string' || item.troopId.length === 0) {
            problems.push(`${itemAt}.troopId must be a non-empty string`);
          }
          const finishAt = item.finishAt;
          if (!isNonNegativeInteger(finishAt)) {
            problems.push(`${itemAt}.finishAt must be a non-negative integer timestamp`);
          } else if (lastSyncAt !== undefined && finishAt < lastSyncAt) {
            problems.push(
              `${itemAt}.finishAt ${finishAt} is before state.lastSyncAt ${lastSyncAt} and could never complete`,
            );
          }
        },
        problems,
      );
    },
    problems,
  );
}

function validateResearch(raw: unknown, problems: string[]): void {
  if (!isRecord(raw)) {
    problems.push('state.research must be an object');
    return;
  }

  if (!isRecord(raw.levels)) {
    problems.push('state.research.levels must be an object');
  } else {
    for (const [unitId, level] of Object.entries(raw.levels)) {
      if (unitId.length === 0) problems.push('state.research.levels has an empty identifier');
      if (!isNonNegativeInteger(level)) {
        problems.push(`state.research.levels.${unitId} must be a non-negative integer`);
      }
    }
  }

  if (raw.active !== undefined) {
    if (!isRecord(raw.active)) {
      problems.push('state.research.active must be an object when present');
      return;
    }
    if (typeof raw.active.unitId !== 'string' || raw.active.unitId.length === 0) {
      problems.push('state.research.active.unitId must be a non-empty string');
    }
    if (!isPositiveInteger(raw.active.toLevel)) {
      problems.push('state.research.active.toLevel must be a positive integer');
    }
    if (!isNonNegativeInteger(raw.active.finishAt)) {
      problems.push('state.research.active.finishAt must be a non-negative integer timestamp');
    }
  }
}

/**
 * Quantity ceilings from `config.limits`.
 *
 * `buildingLimit` is the simulation's own helper (exported from `sim-core` for
 * exactly this), so the ceiling is not re-derived here. Level-0 constructions
 * count, because `placeBuilding` counts them: a reservation that did not count
 * would let two builders slip past the limit. `maxKeeps` is enforced the same
 * way, against the configured Keep type rather than a literal id.
 */
function validateBuildingLimits(
  raw: Record<string, unknown>,
  config: GameConfig,
  problems: string[],
): void {
  const buildings = raw.buildings as unknown[];
  const keepLevel = raw.keepLevel as number;

  // Iterate indices, not the iterator: `for…of` on a sparse array yields
  // `undefined` for every hole, so counting would either throw or credit the
  // hole to a bogus type. Holes are reported by `validateBuildings`; here they
  // are simply skipped, and so is any entry that is not an object.
  const counts = new Map<string, number>();
  for (let index = 0; index < buildings.length; index += 1) {
    if (!(index in buildings)) continue;
    const entry = buildings[index];
    if (!isRecord(entry) || typeof entry.type !== 'string') continue;
    counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
  }

  for (const [type, count] of counts) {
    const limit = buildingLimit(config, type, keepLevel);
    if (limit !== undefined && count > limit) {
      problems.push(
        `state.buildings has ${count} × "${type}" but Keep ${keepLevel} allows ${limit}`,
      );
    }
  }

  const keeps = counts.get(KEEP_BUILDING_ID) ?? 0;
  if (keeps > config.limits.maxKeeps) {
    problems.push(
      `state.buildings has ${keeps} Keep(s) but this config allows ${config.limits.maxKeeps}`,
    );
  }
}

/**
 * Balances may not exceed what the village can store.
 *
 * `storageCapacity` is the authoritative sum over the *completed* levels that
 * carry a `storageCap`. Resources with no cap anywhere (gems, shards) are
 * deliberately unbounded, and a resource whose capacity is `undefined` is not
 * checked at all — a village with no completed storage yet must not be rejected
 * for holding its starting balance. Collections and obstacle rewards are capped
 * on the way in (`remainingCapacity`), so any state the engine produced
 * satisfies this; one that does not could not have been played, and would let a
 * reload grant more than the live game would.
 */
function validateResourceCapacity(
  raw: Record<string, unknown>,
  config: GameConfig,
  problems: string[],
): void {
  const resources = raw.resources;
  if (!isRecord(resources)) return; // already reported by `validateResourceTotals`

  const state = raw as unknown as PlayerState;
  let capacity: Partial<Record<string, number>>;
  try {
    capacity = storageCapacity(state, config) as Partial<Record<string, number>>;
  } catch {
    // A malformed building that `storageCapacity` cannot read was already
    // reported by `validateBuildings`; never let this check throw.
    return;
  }

  for (const id of RESOURCE_IDS) {
    const cap = capacity[id];
    const amount = resources[id];
    if (cap === undefined || !isNonNegativeInteger(amount)) continue;
    if (amount > cap) {
      problems.push(`state.resources.${id} ${amount} exceeds the village storage capacity ${cap}`);
    }
  }
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
  if (!isPositiveInteger(raw.revision)) {
    // A stored record always has a writer, so revision 0 is not a legal value
    // to read; 0 is only the *absence* of a record, used as the write base.
    return {
      ok: false,
      problem: {
        code: 'malformed',
        message: 'save.revision must be a positive safe integer',
      },
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
  /**
   * Revision this record carries. The autosave passes `base + 1`; the default
   * suits fixtures, which represent a store that has been written once.
   */
  revision = 1,
): VillageSave {
  return {
    schemaVersion: 2,
    savedAt,
    configVersion,
    revision,
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

  // Only `undefined` means "no record". IndexedDB returns `undefined` for a
  // missing key, but a `null` under the key is something a writer actually put
  // there: treating it as empty would silently replace it with a starter
  // village. It falls through to validation and is rejected as malformed.
  if (raw === undefined) return { status: 'empty' };

  // Boundary around everything that inspects the stored value.
  //
  // Validation is written defensively, but it is still code reading attacker-
  // shaped input: an unexpected throw must be reported as a bad *record*, not
  // escape and be caught by `main.ts` as "storage unavailable". The two lead to
  // different messages, and only one of them is true. The record is never
  // modified here, so it remains recoverable.
  try {
    const migrated = migrateSave(raw);
    if (!migrated.ok) return { status: 'unreadable', problem: migrated.problem };

    const checked = checkSaveEnvelope(migrated.record, config);
    if (!checked.ok) return { status: 'unreadable', problem: checked.problem };

    return { status: 'loaded', save: checked.save };
  } catch (error) {
    return {
      status: 'unreadable',
      problem: {
        code: 'malformed',
        message: `save could not be validated: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}
