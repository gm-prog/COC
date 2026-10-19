import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type ApiError,
  type ApiResponse,
  type ErrorCode,
  type HealthResponse,
} from '../src/index.js';

describe('protocol envelope', () => {
  it('exposes a semver-looking protocol version', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('models a success response with data and no error', () => {
    const response: ApiResponse<{ ping: number }> = { ok: true, data: { ping: 1 } };
    expect(response.ok).toBe(true);
    expect(response.data?.ping).toBe(1);
    expect(response.error).toBeUndefined();
  });

  it('models a failure response carrying a known error code', () => {
    const codes: ErrorCode[] = [
      'bad_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'rate_limited',
      'internal',
    ];
    for (const code of codes) {
      const error: ApiError = { code, message: 'nope' };
      const response: ApiResponse<never> = { ok: false, error };
      expect(response.error?.code).toBe(code);
    }
  });

  it('models a health response with every version field', () => {
    const health: HealthResponse = {
      status: 'ok',
      uptimeMs: 0,
      versions: {
        protocol: PROTOCOL_VERSION,
        simCore: '0.1.0',
        config: '1.0.0',
        server: '0.1.0',
      },
    };
    expect(Object.keys(health.versions).sort()).toEqual([
      'config',
      'protocol',
      'server',
      'simCore',
    ]);
  });
});
