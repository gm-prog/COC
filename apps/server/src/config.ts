/**
 * Server configuration.
 *
 * Everything comes from the environment with a safe default so a fresh clone
 * runs with zero setup. Secrets are never committed (see .gitignore).
 */

export interface ServerConfig {
  host: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** Comma-separated list of allowed CORS origins ('*' for any). */
  corsOrigins: string[];
  /** Bump on every deploy; surfaced by /health for support triage. */
  buildId: string;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: expected a number, received "${raw}"`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: readNumber('PORT', 8080),
    nodeEnv: (env.NODE_ENV as ServerConfig['nodeEnv']) ?? 'development',
    logLevel: (env.LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    corsOrigins: (env.CORS_ORIGINS ?? '*')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    buildId: env.BUILD_ID ?? 'dev',
  };
}
