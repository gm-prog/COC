/**
 * @coc/protocol — the contract between the Emberhold client and server.
 *
 * Phase 0 defines only the transport-level envelope plus a health/version
 * response. The command protocol (Section 8.3) lands in Phase 7 together with
 * Zod schemas validated on both sides.
 */

/** Wire protocol version. Bump on any breaking change to message shapes. */
export const PROTOCOL_VERSION = '0.1.0' as const;

/** Machine-readable error codes shared by client and server. */
export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal';

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: ApiError;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  /** Milliseconds since the server process started. */
  uptimeMs: number;
  versions: {
    protocol: string;
    simCore: string;
    config: string;
    server: string;
  };
}
