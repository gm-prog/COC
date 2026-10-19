import { defineConfig } from 'vitest/config';

/**
 * Single Vitest project for the whole monorepo (Phase 0).
 * Per-package vitest configs can be introduced later when a package needs a
 * different environment (e.g. a DOM environment for client UI tests).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    passWithNoTests: true,
    reporters: 'default',
    coverage: {
      provider: 'v8',
      // The rules core is the thing that must be covered; the client and server
      // get their own smoke layers in later phases.
      include: ['packages/sim-core/src/**/*.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: {
        // Phase 1 "Done when": >= 90% line coverage on state, grid and commands.
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
    },
  },
});
