/**
 * Client-side HTTP policy: how long a request may hang, and when it is safe to
 * repeat one. Issue #2499.
 *
 * `fetch()` has no timeout. A request whose TCP connection is still nominally
 * open but is moving no bytes — a phone that walked out of LTE range mid-request,
 * a Wi-Fi/LTE handover, a captive portal that swallows the SYN — never settles
 * and never rejects. Every caller in this app awaits it, so the promise that
 * never settles is a spinner that never stops. That is the whole bug: not a slow
 * network, but the absence of any upper bound on waiting for one.
 *
 * The numbers live here rather than inline at the call sites for two reasons.
 * The first is the ordinary one — a test can assert against the same constant
 * the code reads. The second matters more: a timeout and a retry cadence are a
 * single budget, not two independent settings. `API_GET_TIMEOUT_MS` ×
 * (`API_RETRY_MAX_RETRIES` + 1) plus the backoff between them is what the user
 * actually waits for before being told something is wrong, and that product is
 * only visible when the factors sit next to each other. {@link
 * API_RETRY_TOTAL_BUDGET_MS} is the ceiling that keeps it honest.
 *
 * The policy functions below are pure and exported for the same reason: "is
 * this method safe to repeat" is a *decision*, and a decision that can be
 * tested without a network is a decision that can be trusted.
 */

// ============================================================================
// Timeouts
// ============================================================================

/**
 * Sentinel for {@link resolveDefaultTimeoutMs} and the `timeoutMs` request
 * option: no timeout at all, the pre-#2499 behavior.
 *
 * Kept as a named zero rather than `null` so "this request is deliberately
 * unbounded" reads differently from "nobody thought about it" at the call site.
 */
export const API_NO_TIMEOUT = 0;

/**
 * Default ceiling for a read (GET/HEAD).
 *
 * 10s is chosen against the slow end of a real mobile connection rather than
 * against a local dev server: a 2G-class link on a cold TLS handshake routinely
 * needs 3-5s for a small JSON body, so anything under ~8s would start cutting
 * off requests that were going to succeed. The retry ladder covers the tail
 * that this cut-off produces, which is why the number can be this aggressive
 * without costing correctness.
 */
export const API_GET_TIMEOUT_MS = 10_000;

/**
 * Default ceiling for a write (POST/PUT/PATCH/DELETE).
 *
 * Three times the read budget because a write is *not* retried (see
 * {@link isIdempotentMethod}) — cutting one off early is not a recoverable
 * mistake, it is a message the user believes they sent and did not. The server
 * side of a send, a git operation or a session spawn can legitimately take
 * several seconds, so this bound exists to end a hang, not to police latency.
 */
export const API_MUTATION_TIMEOUT_MS = 30_000;

/**
 * Ceiling for a request issued by a polling loop.
 *
 * Shorter than {@link API_GET_TIMEOUT_MS} because a poll has a property a
 * one-shot read does not: the *next attempt is already scheduled*. Letting a
 * stalled tick hang for the full read budget stacks four or five in-flight
 * requests against a 2s cadence, each holding a connection the recovering tick
 * needs. Cutting at 8s bounds that pile-up while still clearing the slow-link
 * latency the read budget is sized for.
 */
export const API_POLL_TIMEOUT_MS = 8_000;

// ============================================================================
// Retry
// ============================================================================

/**
 * Retries *after* the first attempt, for idempotent requests only — so a GET
 * is attempted at most `API_RETRY_MAX_RETRIES + 1` times.
 *
 * Two, not more: the failures this recovers from are single dropped packets and
 * momentary radio gaps, which a second or third attempt clears. A network that
 * is still down on the third attempt is down, and further attempts only spend
 * the user's battery and the server's capacity while the spinner keeps turning.
 */
export const API_RETRY_MAX_RETRIES = 2;

/** Backoff base: the nominal wait before the first retry, in ms. */
export const API_RETRY_BASE_DELAY_MS = 500;

/** Exponential growth per retry: delay(n) = base × factor^n. */
export const API_RETRY_BACKOFF_FACTOR = 2;

/**
 * Jitter, as a fraction of the nominal delay, applied symmetrically (±).
 *
 * Every client in the app polls on the same cadence, so a server blip makes
 * them all fail at the same instant — and without jitter they would all retry
 * at the same instant too, reproducing the spike that knocked the server over
 * on a schedule. A quarter of the delay is enough spread to break the lockstep
 * without making the wait unpredictable to a user watching a spinner.
 */
export const API_RETRY_JITTER_RATIO = 0.25;

/** Ceiling for a single backoff wait, before jitter, in ms. */
export const API_RETRY_MAX_DELAY_MS = 4_000;

/**
 * Wall-clock ceiling on one logical request, retries and backoff included.
 *
 * Without it the worst case is the sum of every timeout plus every backoff —
 * roughly 32s for a default GET — which is long enough that the user has
 * already decided the app is broken. Once this much time has been spent the
 * loop stops and reports the failure it has, on the grounds that a person who
 * has waited 20s wants an answer more than they want another attempt.
 */
export const API_RETRY_TOTAL_BUDGET_MS = 20_000;

/**
 * HTTP statuses worth repeating an idempotent request for.
 *
 * Each one is the server saying "not now" rather than "not ever": 408/425 are
 * timing, 429 is rate limiting, and 5xx here are the shapes a restart or a
 * reverse proxy in front of a restarting server produces. Everything else —
 * 400, 401, 403, 404, 409, 422 — is a verdict about the request itself, and
 * repeating it produces the same verdict at the cost of another round trip.
 */
export const API_RETRYABLE_STATUS_CODES: readonly number[] = [408, 425, 429, 500, 502, 503, 504];

/**
 * Methods a failed attempt may be repeated for.
 *
 * This list is the guard behind the acceptance criterion that a `POST /send` is
 * never sent twice. The hazard is specifically the *ambiguous* failure: a write
 * that timed out may well have reached the server and been applied, with only
 * the response lost — so a retry is not "one more try", it is a second message
 * in the user's conversation. Read methods have no such state to duplicate.
 *
 * PUT and DELETE are idempotent in the RFC sense and still excluded, because
 * this app's routes are not all written to be: `PUT /repositories/:path/visible`
 * is safe to repeat, but the general case is not worth assuming.
 */
export const API_IDEMPOTENT_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

// ============================================================================
// Reachability reporting
// ============================================================================

/**
 * Minimum gap between two identical reachability reports out of the API client,
 * in ms. See `noteReachability` in `lib/api-client.ts`.
 *
 * Zero would be correct and wasteful: the detail screen alone polls three
 * endpoints every 2s, and each success would push an identical "still
 * reachable" through every mounted `useConnectivity`. Transitions are what the
 * banner renders from, so only transitions — plus one refresh per window, so a
 * long-lived healthy session still leaves a recent timestamp behind — need to
 * travel.
 */
export const API_REACHABILITY_REPORT_INTERVAL_MS = 30_000;

// ============================================================================
// Policy
// ============================================================================

/**
 * Whether a failed attempt with this method may be repeated.
 *
 * An absent method means GET, matching `fetch()`'s own default.
 */
export function isIdempotentMethod(method?: string | null): boolean {
  const normalized = (method ?? 'GET').toUpperCase();
  return API_IDEMPOTENT_METHODS.includes(normalized);
}

/** Whether this HTTP status is one of {@link API_RETRYABLE_STATUS_CODES}. */
export function isRetryableStatus(status: number): boolean {
  return API_RETRYABLE_STATUS_CODES.includes(status);
}

/**
 * The timeout a request gets when the call site does not name one: the poll
 * budget is opt-in, so this answers read vs. write.
 */
export function resolveDefaultTimeoutMs(method?: string | null): number {
  return isIdempotentMethod(method) ? API_GET_TIMEOUT_MS : API_MUTATION_TIMEOUT_MS;
}

/**
 * Backoff for the retry that follows attempt `attempt` (0-based: `0` is the
 * wait between the first attempt and the first retry).
 *
 * `random` is injectable purely so the jitter can be pinned in a test; callers
 * leave it alone and get `Math.random()`.
 *
 * @returns a whole number of milliseconds, never negative
 */
export function computeRetryDelayMs(attempt: number, random: number = Math.random()): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const nominal = Math.min(
    API_RETRY_BASE_DELAY_MS * API_RETRY_BACKOFF_FACTOR ** safeAttempt,
    API_RETRY_MAX_DELAY_MS,
  );
  // random ∈ [0, 1) mapped to [-1, 1) so the jitter is symmetric around the
  // nominal delay rather than only ever lengthening it.
  const jitter = nominal * API_RETRY_JITTER_RATIO * (random * 2 - 1);
  return Math.max(0, Math.round(nominal + jitter));
}
