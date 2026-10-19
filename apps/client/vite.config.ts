import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Aliases mirror the `paths` map in tsconfig.base.json one-for-one so that the
 * dev server, the bundler and the type-checker all resolve the workspace
 * packages identically. `test/config.test.ts` fails if the two ever drift.
 */
export const workspaceAliases: Record<string, string> = {
  '@coc/sim-core': here('../../packages/sim-core/src/index.ts'),
  '@coc/game-data': here('../../packages/game-data/src/index.ts'),
  '@coc/protocol': here('../../packages/protocol/src/index.ts'),
};

export default defineConfig({
  server: {
    // Bind to all interfaces so the dev server is reachable from a phone or a
    // containerised preview environment.
    host: true,
    port: 5173,
    strictPort: true,
    // The dev server is exposed through a proxy host during development; Vite's
    // host allow-list would otherwise reject that request with a 403.
    allowedHosts: true,
  },
  preview: {
    host: true,
    port: 4173,
  },
  resolve: {
    alias: workspaceAliases,
  },
  build: {
    target: 'es2022',
    // Phaser is large; keep the warning threshold honest instead of hiding it.
    chunkSizeWarningLimit: 1600,
  },
});
