import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { CONFIG_VERSION } from '@coc/game-data';
import { PROTOCOL_VERSION, type HealthResponse } from '@coc/protocol';
import { GRID, SIM_CORE_VERSION } from '@coc/sim-core';
import { loadConfig, type ServerConfig } from './config.js';

const startedAt = Date.now();

/** Server build stamp. Phase 17 replaces this with injected build metadata. */
const SERVER_VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyInstance {
    config: ServerConfig;
  }
}

/**
 * Minimal CORS hook.
 *
 * Deliberately dependency-free for now: the browser client is the only consumer
 * in Phases 0-6 and the rule is simple. Swap for @fastify/cors if the policy
 * grows (credentials, per-route rules) in Phase 7.
 */
function applyCors(app: FastifyInstance, origins: string[]): void {
  const allowAll = origins.includes('*');
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    if (allowAll || origins.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
      reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
      reply.header('access-control-allow-headers', 'content-type,authorization');
    }
  });

  app.options('/*', async (_request, reply) => {
    reply.code(204).send();
  });
}

/**
 * Builds the Fastify application.
 *
 * Phase 0 keeps this deliberately thin: a health check, a version banner and a
 * world-geometry endpoint that proves the server really does import the same
 * sim-core the client renders with. Auth, the command API and the matchmaker
 * arrive in Phases 7 and 8.
 */
export async function buildServer(overrides: Partial<ServerConfig> = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...overrides };

  const app = fastify({
    logger: { level: config.logLevel },
    bodyLimit: 256 * 1024,
  });

  app.decorate('config', config);

  applyCors(app, config.corsOrigins);

  app.get('/', async () => ({
    name: 'emberhold-api',
    endpoints: ['/health', '/version', '/world'],
    client: 'the game client is served by the Vite dev server on port 5173',
  }));

  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      uptimeMs: Date.now() - startedAt,
      versions: {
        protocol: PROTOCOL_VERSION,
        simCore: SIM_CORE_VERSION,
        config: CONFIG_VERSION,
        server: SERVER_VERSION,
      },
    };
  });

  app.get('/version', async () => ({
    protocol: PROTOCOL_VERSION,
    simCore: SIM_CORE_VERSION,
    config: CONFIG_VERSION,
    server: SERVER_VERSION,
    buildId: config.buildId,
  }));

  app.get('/world', async () => ({
    grid: GRID,
    note: 'Tile geometry is authoritative in @coc/sim-core.',
  }));

  return app;
}
