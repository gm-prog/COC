import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';

/**
 * These tests double as the "sim-core imports cleanly into the server" proof
 * from the Phase 0 checklist: if the import were broken the build would fail.
 */
describe('server', () => {
  it('serves a health check that reports every shared version stamp', async () => {
    const app = await buildServer({ logLevel: 'silent', corsOrigins: ['*'] });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.versions).toEqual({
      protocol: '0.1.0',
      simCore: '0.1.0',
      config: '0.1.0',
      server: '0.1.0',
    });

    await app.close();
  });

  it('serves the authoritative grid geometry from sim-core', async () => {
    const app = await buildServer({ logLevel: 'silent', corsOrigins: ['*'] });
    const response = await app.inject({ method: 'GET', url: '/world' });

    expect(response.statusCode).toBe(200);
    expect(response.json().grid).toEqual({ total: 48, buildable: 40, margin: 4 });

    await app.close();
  });

  it('answers CORS preflight for the configured origin', async () => {
    const app = await buildServer({ logLevel: 'silent', corsOrigins: ['https://example.com'] });
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'https://example.com' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://example.com');

    await app.close();
  });
});
