/**
 * @coc/sim-core — the single deterministic rules core for Emberhold.
 *
 * Phase 1 lays the foundation every later phase hangs on:
 *   math     fixed-point / integer-only maths
 *   rng      seeded, pure, serialisable PRNG
 *   grid     tile occupancy and footprint checks
 *   config   the shapes every tunable number must satisfy
 *   validate Zod schemas that fail loudly on bad balance data
 *   state    the authoritative player state
 *   commands applyCommand(state, command, ctx) — pure, typed, event-producing
 *   serialize stable JSON + hashState() for determinism checks
 *
 * Hard rules for this package (design spec Section 6.4):
 *   - no DOM, no Node APIs, no `Date.now()`, no `Math.random()`
 *   - integer / fixed-point maths only (1 tile = 1,000 sim units)
 *   - stable iteration order (ascending numeric id)
 *   - pure functions: same input => same output, on every machine
 */

export const SIM_CORE_VERSION = '0.1.0' as const;

// math
export {
  FIXED_ONE,
  TICKS_PER_SECOND,
  TICK_MS,
  clamp,
  clampInt,
  roundToNearest,
  toFixedUnits,
  fromFixedUnits,
  fixedMul,
  fixedDiv,
  isqrt,
  hypotFixed,
  distanceFixed,
  chebyshevTiles,
  distanceSquaredTiles,
} from './math/index.js';

// rng
export {
  createRng,
  nextUint32,
  nextFloat,
  nextInt,
  nextChance,
  nextPick,
  serializeRng,
  deserializeRng,
  deriveSeed,
  type RngState,
} from './rng/index.js';

// grid
export {
  OccupancyGrid,
  rectsOverlap,
  rectContains,
  type Rect,
  type CellConflict,
} from './grid/index.js';

// config
export {
  GRID,
  assertValidGeometry,
  isBuildableTile,
  isMapTile,
  type GridGeometry,
} from './config/geometry.js';
export {
  KEEP_BUILDING_ID,
  MAX_BUILDERS,
  MAX_SPEED_UP_GEMS,
  MAX_SPEED_UP_SECONDS,
  RESOURCE_IDS,
  type ResourceId,
  type ResourceAmount,
  type BuildingCategory,
  type BuildingDef,
  type BuildingLevel,
  type BuildingSize,
  type EconomyConfig,
  type SpeedUpAnchor,
  type BuilderShop,
  type CancelRefund,
  type BuildingLimits,
  type ObstacleDef,
  type StarterConfig,
  type StarterBuilding,
  type StarterObstacle,
  type GameConfig,
} from './config/types.js';

// validate
export {
  ConfigValidationError,
  validateGameConfig,
  loadGameConfig,
  validateBuildingDefs,
  checkEconomy,
  checkLimits,
  checkSemantics,
  checkStarterLayout,
  type ValidatedGameConfig,
} from './validate/index.js';

// economy (lazy time evaluation, production, storage)
export {
  catchUp,
  storageCapacity,
  remainingCapacity,
  addResources,
  canAfford,
  buildingDef,
  levelDef,
  type CatchUpEvent,
  type CatchUpResult,
  type CatchUpError,
} from './economy/index.js';

// build (upgrade, cancel, speed-up, builder shop)
export {
  checkUpgrade,
  nextLevel,
  currentLevel,
  cancelRefundFraction,
  refundFor,
  speedUpCost,
  nextBuilderCost,
  canBuyBuilder,
  upgradeDurationMs,
  type UpgradeCheck,
  type UpgradeRejection,
} from './build/index.js';

// state
export {
  STATE_VERSION,
  createNewPlayerState,
  countBuildings,
  findKeep,
  isKeepLevelConsistent,
  highestEntityId,
  clonePlayerState,
  deepClone,
  type PlayerState,
  type BuildingInstance,
  type ObstacleInstance,
  type BuilderAssignment,
  type TrainingQueueItem,
  type ResearchState,
} from './state/index.js';

// commands
export {
  applyCommand,
  type CommandContext,
  type CommandError,
  type CommandErrorCode,
  type CommandResult,
  type GameCommand,
  type GameEvent,
  type PlaceBuildingPayload,
  type MoveBuildingPayload,
  type RemoveObstaclePayload,
  type StartUpgradePayload,
  type CancelUpgradePayload,
  type SpeedUpPayload,
  type BuyBuilderPayload,
  type CollectResourcePayload,
} from './commands/index.js';

// serialize
export {
  stableStringify,
  stableParse,
  hashString,
  hashValue,
  hashState,
} from './serialize/index.js';
