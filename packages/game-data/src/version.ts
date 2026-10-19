/**
 * The config version stamp, in a module that imports nothing.
 *
 * `@coc/game-data` (the root entry) pulls in sim-core's Zod validator, which the
 * client has no business bundling just to print a version string. Consumers that
 * only need the stamp import `@coc/game-data/version`.
 */

/** Current balance/config version. Stamped onto every state and battle. */
export const CONFIG_VERSION = '0.1.0' as const;

export type ConfigVersion = typeof CONFIG_VERSION;
