/**
 * Launched-server identity check
 * Issue #3087: `remote` published whatever answered on the port
 *
 * A TCP connect only proves that SOMETHING listens. In #3087 an orphaned server from an
 * earlier `start --daemon` (no authentication) kept the port, the server `remote` launched
 * died on EADDRINUSE, and `remote` put the orphan behind a public tunnel.
 *
 * Before anything is published, this asks the endpoint two questions over plain HTTP(S):
 *
 *  1. A request carrying a token nobody holds must be refused with 401. Anything else means
 *     authentication is off (or the answer is not CommandMate's middleware), so the server
 *     would be reachable without pairing.
 *  2. A request carrying the session token `remote` minted moments ago must succeed. Only
 *     the server launched with that token's hash can accept it, so this proves the listener
 *     is the one this invocation started — no new API route or nonce is needed.
 *
 * Question 1 is asked first so the session token is never sent to a server already shown to
 * be the wrong one. Every outcome that is not a clear "yes" to both is a refusal (fail-closed);
 * only connection errors and 5xx (a server still warming up) are retried until the deadline.
 *
 * @module server-identity
 */

import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { randomBytes } from 'crypto';

/** Path probed: authenticated like every API route, and it reads nothing (Issue #1925). */
export const IDENTITY_PROBE_PATH = '/api/capabilities';

export const DEFAULT_IDENTITY_TIMEOUT_MS = 30000;
export const DEFAULT_IDENTITY_INTERVAL_MS = 300;
const REQUEST_TIMEOUT_MS = 10000;

export interface VerifyLaunchedServerOptions {
  protocol: 'http' | 'https';
  host: string;
  port: number;
  /** Plaintext session token whose hash the launched server was given */
  sessionToken: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export type LaunchedServerVerdict = { ok: true } | { ok: false; reason: string };

/** Status of one probe, or null when the request itself failed (refused, reset, timed out). */
type ProbeStatus = number | null;

function probe(
  options: VerifyLaunchedServerOptions,
  bearer: string,
  timeoutMs: number
): Promise<ProbeStatus> {
  return new Promise((resolve) => {
    const send = options.protocol === 'https' ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (status: ProbeStatus): void => {
      if (settled) return;
      settled = true;
      resolve(status);
    };

    try {
      const req = send(
        {
          host: options.host,
          port: options.port,
          path: IDENTITY_PROBE_PATH,
          method: 'GET',
          headers: { Authorization: `Bearer ${bearer}` },
          timeout: timeoutMs,
          // Loopback only, and identity is proven by the token, not the certificate: a
          // self-signed CM_HTTPS_CERT must not make the check impossible.
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          finish(res.statusCode ?? null);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        finish(null);
      });
      req.on('error', () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

function isTransient(status: ProbeStatus): boolean {
  return status === null || status >= 500;
}

/**
 * Verify that the endpoint is the authenticated server this invocation launched.
 *
 * @returns `{ ok: true }` only when an unknown token is refused with 401 AND the session
 *   token is accepted; otherwise `{ ok: false, reason }`. Never throws.
 */
export async function verifyLaunchedServer(
  options: VerifyLaunchedServerOptions
): Promise<LaunchedServerVerdict> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_IDENTITY_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  // A token that cannot be anyone's: fresh random bytes, never hashed or stored anywhere.
  const decoy = randomBytes(32).toString('hex');
  const where = `${options.host}:${options.port}`;

  const ask = async (bearer: string): Promise<ProbeStatus> => {
    for (;;) {
      const remaining = deadline - Date.now();
      const status = await probe(options, bearer, Math.max(Math.min(REQUEST_TIMEOUT_MS, remaining), 1));
      if (!isTransient(status) || deadline - Date.now() <= 0) {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(deadline - Date.now(), 1))));
    }
  };

  const unauthenticated = await ask(decoy);
  if (unauthenticated !== 401) {
    return {
      ok: false,
      reason:
        unauthenticated === null
          ? `nothing answered on ${where}`
          : `the server on ${where} did not require authentication (HTTP ${unauthenticated} for an unknown token, expected 401)`,
    };
  }

  const authenticated = await ask(options.sessionToken);
  if (authenticated === null || authenticated < 200 || authenticated >= 300) {
    return {
      ok: false,
      reason:
        authenticated === null
          ? `nothing answered on ${where}`
          : `the server on ${where} is not the one this command started (HTTP ${authenticated} for this session's token)`,
    };
  }

  return { ok: true };
}
