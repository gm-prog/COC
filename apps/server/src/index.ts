import { buildServer } from './app.js';

/**
 * Server entry point.
 *
 * `pnpm dev:server` runs this through tsx (TypeScript straight from source);
 * Phase 17 adds a real bundling/deploy path.
 */
async function main(): Promise<void> {
  const app = await buildServer();

  try {
    await app.listen({ host: app.config.host, port: app.config.port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
