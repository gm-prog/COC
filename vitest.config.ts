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
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      thresholds: {
        // Raised per-package as rules land in Phase 1+.
        lines: 0,
        functions: 0,
        statements: 0,
        branches: 0,
      },
    },
  },
});
