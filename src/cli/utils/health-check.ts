/**
 * Server Readiness Health Check
 * Issue #1194: update-specific readiness probe (D-5 / D-12 / D-13 / S3-001)
 *
 * The CLI has no reusable readiness primitive: `start.ts` prints the URL as soon
 * as `daemon.start()` returns a PID, and `DaemonManager.waitForExit()` waits for
 * process *exit* (S1-001). This module implements the readiness contract that
 * `commandmate update` needs.
 *
 * Why not `ApiClient.get()`: it does not set `redirect`, so fetch defaults to
 * `follow`. With auth enabled, `middleware.ts:142` redirects (307) to `/login`,
 * which is an AUTH_EXCLUDED_PATH returning 200 HTML *without touching the DB* —
 * i.e. following the redirect yields a "200 that proves nothing" before
 * migrations complete (S3-001). Adding `redirect: 'manual'` to ApiClient would
 * ripple into send/wait/respond/capture/instances, so this probe is standalone.
 *
 * @module health-check
 */

/** Poll interval while waiting for readiness */
export const HEALTH_CHECK_INTERVAL_MS = 500;

/** Maximum time to wait for readiness */
export const HEALTH_CHECK_TIMEOUT_MS = 30_000;

/**
 * Outcome of a readiness wait.
 *
 * - `ready`: migrations are proven complete (200 + JSON + `success === true`)
 * - `degraded`: the server answers but readiness cannot be proven (auth / IP / TLS)
 * - `timeout`: no conclusive answer within the timeout
 */
export type ReadinessResult = 'ready' | 'degraded' | 'timeout';

/**
 * Options for {@link waitForReady}
 */
export interface WaitForReadyOptions {
  /** Bearer token to send (from CM_AUTH_TOKEN) */
  token?: string;
  /** Poll interval in ms (default: {@link HEALTH_CHECK_INTERVAL_MS}) */
  intervalMs?: number;
  /** Overall timeout in ms (default: {@link HEALTH_CHECK_TIMEOUT_MS}) */
  timeoutMs?: number;
}

/** Result of a single probe */
type ProbeOutcome = ReadinessResult | 'retry';

/**
 * TLS verification failures. The server is listening over HTTPS but we cannot
 * verify it (e.g. self-signed certificate). We never disable
 * NODE_TLS_REJECT_UNAUTHORIZED, so this degrades instead of failing.
 */
const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Poll the server until it proves readiness.
 *
 * Probes `<baseUrl>/api/repositories`, which goes through `getDbInstance()` and
 * therefore runs `runMigrations()` idempotently — a successful JSON response
 * implies migrations completed. Note that migrations finish *after* the port is
 * bound (`server.ts:271-275`), so a naive TCP/HTML check is not sufficient.
 *
 * @param baseUrl - Server base URL, taken from `IDaemonManager.getStatus().url` (D-13)
 * @param options - Token and polling overrides
 * @returns The readiness outcome
 */
export async function waitForReady(
  baseUrl: string,
  options: WaitForReadyOptions = {}
): Promise<ReadinessResult> {
  const intervalMs = options.intervalMs ?? HEALTH_CHECK_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;

  const url = `${baseUrl.replace(/\/+$/, '')}/api/repositories`;
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const deadline = Date.now() + timeoutMs;

  // Always probe at least once, then poll until the deadline.
  for (;;) {
    const outcome = await probe(url, headers);
    if (outcome !== 'retry') {
      return outcome;
    }
    if (Date.now() >= deadline) {
      return 'timeout';
    }
    await sleep(intervalMs);
  }
}

/**
 * Perform a single readiness probe.
 *
 * Response handling contract (Issue #1194 step 9(c)):
 * | 200 + JSON + success:true | READY                 |
 * | 200 non-JSON / 5xx        | retry                 |
 * | 3xx / 401 / 403 / TLS     | degraded              |
 * | ECONNREFUSED              | retry (not listening) |
 */
async function probe(url: string, headers: Record<string, string>): Promise<ProbeOutcome> {
  let response: Response;

  try {
    // redirect: 'manual' is mandatory (S3-001) - following a 307 to /login would
    // yield a 200 HTML page that proves nothing about migration completion.
    response = await fetch(url, { redirect: 'manual', headers });
  } catch (error) {
    return isTlsError(error) ? 'degraded' : 'retry';
  }

  // Auth enabled without a (valid) token, or IP restricted: the server responds
  // but readiness cannot be proven via any auth-excluded route (they never touch
  // the DB), so degrade rather than declare a false READY.
  if (isRedirect(response) || response.status === 401 || response.status === 403) {
    return 'degraded';
  }

  if (response.status !== 200) {
    // 5xx and anything else: the server is up but not answering correctly yet.
    return 'retry';
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return 'retry';
  }

  try {
    const body: unknown = await response.json();
    return isSuccessBody(body) ? 'ready' : 'retry';
  } catch {
    return 'retry';
  }
}

/**
 * Detect a redirect response.
 * Under `redirect: 'manual'`, undici surfaces the real 3xx status; browsers
 * would surface an opaqueredirect with status 0.
 */
function isRedirect(response: Response): boolean {
  if (response.status >= 300 && response.status < 400) {
    return true;
  }
  return response.type === 'opaqueredirect';
}

/**
 * Check the `/api/repositories` success envelope (`route.ts:57`).
 * This shape is an implicit contract for the update health check.
 */
function isSuccessBody(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { success?: unknown }).success === true
  );
}

/**
 * Walk the error cause chain looking for a TLS verification failure.
 */
function isTlsError(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && TLS_ERROR_CODES.has(code)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
