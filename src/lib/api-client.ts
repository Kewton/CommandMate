/**
 * API Client Utilities
 * Type-safe fetch wrapper for backend API calls
 */

import type { Worktree, ChatMessage, WorktreeMemo } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { SlashCommandGroup } from '@/types/slash-commands';
import {
  API_NO_TIMEOUT,
  API_REACHABILITY_REPORT_INTERVAL_MS,
  API_RETRY_MAX_RETRIES,
  API_RETRY_TOTAL_BUDGET_MS,
  computeRetryDelayMs,
  isIdempotentMethod,
  isRetryableStatus,
  resolveDefaultTimeoutMs,
} from '@/config/api-timeout-config';
// Issue #2501 owns the connection verdict; Issue #2499 feeds it. Imported as a
// plain module function rather than through the hook because this file is not a
// React tree — see the "External reachability reports" section there.
import { reportServerReachability } from '@/hooks/useConnectivity';

/**
 * Repository summary from API
 *
 * Issue #690: `visible` and `enabled` are surfaced via the worktrees API
 * payload so the sidebar can filter out hidden repositories without an
 * extra request. The `id` is optional because LEFT JOIN with worktrees
 * may not have a matching repositories row for legacy data.
 */
export interface RepositorySummary {
  /** Repository ID (optional — null when no repositories row exists yet) */
  id?: string;
  path: string;
  name: string;
  displayName?: string;
  worktreeCount: number;
  /** Sidebar visibility flag (Issue #690). Defaults to true. */
  visible: boolean;
  /** Sync inclusion flag (Issue #190). Defaults to true. */
  enabled: boolean;
}

/**
 * Worktrees API response
 */
export interface WorktreesResponse {
  worktrees: Worktree[];
  repositories: RepositorySummary[];
}

/**
 * What kind of failure an {@link ApiError} describes (Issue #2499).
 *
 * `status` alone cannot answer this: every transport-layer failure carries
 * `status: 0`, so "the server said 500", "the request timed out", "the device
 * is off the network" and "the caller aborted" all used to arrive as the same
 * shapeless zero with whatever string the platform happened to put on the
 * underlying error. A caller that wants to distinguish "retry might help" from
 * "there is nothing to retry with" had no way to.
 *
 * - `http`    — the server answered; `status` is its code.
 * - `network` — the request never completed (DNS, TCP, TLS, connection reset).
 * - `timeout` — the request exceeded its budget and was cut off by this client.
 * - `offline` — refused before it was sent: `navigator.onLine === false`.
 * - `aborted` — the *caller's* own `AbortSignal` fired (navigation, a newer
 *               request superseding this one). Never a failure to report.
 */
export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'offline' | 'aborted';

/**
 * API Error class
 *
 * Issue #2499 added the fourth constructor argument. It is optional and
 * defaults from `status`, so every existing `new ApiError(msg, status)` keeps
 * the meaning it had.
 */
export class ApiError extends Error {
  /** See {@link ApiErrorKind}. */
  public readonly kind: ApiErrorKind;

  constructor(
    message: string,
    public status: number,
    public data?: unknown,
    kind?: ApiErrorKind
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind ?? (status > 0 ? 'http' : 'network');
  }
}

/**
 * Whether this failure is the client's own timeout — the normalized form of the
 * `AbortError` that `fetch()` rejects with when its signal fires (Issue #2499).
 *
 * The normalization is the point: a raw `AbortError` is a `DOMException` whose
 * `name` is the only thing distinguishing it, it is indistinguishable from a
 * caller-initiated abort, and `instanceof DOMException` is not something a
 * component should be writing. Every failure out of {@link fetchApi} and
 * {@link fetchApiResponse} is an `ApiError` instead, and this is how a caller
 * asks whether it was the clock.
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'timeout';
}

/**
 * Whether this failure is the offline fail-fast: the device reported no
 * network, so the request was never attempted (Issue #2499).
 */
export function isOfflineError(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'offline';
}

/**
 * Whether this failure was the *caller's* abort rather than a fault
 * (Issue #2499) — a superseded search request, a component unmounting.
 *
 * The distinction matters at every `catch`: an aborted request is a request
 * nobody is waiting for any more, so surfacing it as an error shows the user a
 * message about something they themselves caused.
 */
export function isAbortedError(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'aborted';
}

/**
 * Safely parse a JSON response with content-type validation.
 * Returns defaultValue if content-type is not application/json or parsing fails.
 * Issue #573: Eliminates silent failures from unchecked .json() calls.
 *
 * Logging uses console.warn (not logger) because this is a client-side module
 * imported by 'use client' components. Logger depends on Node.js-only modules.
 * console.warn is guarded by NODE_ENV to avoid information leakage in production.
 * content-type values are truncated to 100 chars to mitigate MITM injection.
 */
async function safeParseJson<T>(
  response: Response,
  defaultValue: T,
  logContext: string,
): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (process.env.NODE_ENV === 'development') {
      const truncatedContentType = contentType.length > 100 ? contentType.slice(0, 100) + '...' : contentType;
      console.warn(
        `[api-client] ${logContext}: unexpected content-type: expected application/json, got ${truncatedContentType}`
      );
    }
    return defaultValue;
  }
  try {
    return await response.json() as T;
  } catch {
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        `[api-client] ${logContext}: JSON parse error: status=${response.status}`
      );
    }
    return defaultValue;
  }
}

/**
 * Auth-redirect guard used by {@link fetchApi} (Issue #573).
 *
 * `fetch` transparently follows the 307 that the auth middleware issues, so an
 * unauthenticated request resolves as the `/login` HTML page with status 200.
 * Returns the `ApiError` to throw, or `null` when the response is not a
 * redirect to the login page.
 *
 * Issue #2059: exported so callers that keep their own `fetch()` call site
 * (`useWorktreesCache`, whose polling tests pin the call shape) apply exactly
 * this rule instead of re-deriving it.
 */
export function detectAuthRedirect(response: Response): ApiError | null {
  if (response.redirected && (response.url ?? '').includes('/login')) {
    return new ApiError('Authentication required', 401);
  }
  return null;
}

/**
 * Non-JSON body guard used by {@link fetchApi} (Issue #573).
 *
 * Returns the `ApiError` to throw when the response advertises anything other
 * than `application/json` (an HTML error page, a proxy interstitial), or `null`
 * when the body can be parsed as JSON.
 *
 * A real `Response` always carries a `headers` object; when it is missing the
 * check is skipped rather than guessed, so a caller can pass a stub through.
 *
 * Issue #2059: exported alongside {@link detectAuthRedirect} — see there.
 */
export function detectNonJsonBody(response: Response): ApiError | null {
  if (!response.headers) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return new ApiError('Unexpected response format', response.status);
  }
  return null;
}

// ============================================================================
// Transport policy (Issue #2499)
// ============================================================================

/**
 * Extra request knobs {@link fetchApiResponse} and {@link fetchApi} understand,
 * on top of everything `fetch()` already takes.
 *
 * Both default sensibly, so the overwhelmingly common call site keeps passing
 * nothing. They exist for the two cases where the defaults are wrong:
 *
 *  - a polling loop, which wants the shorter {@link API_POLL_TIMEOUT_MS} and
 *    `retries: 0` because the next tick *is* the retry;
 *  - a genuinely long server-side operation, which passes
 *    `timeoutMs: API_NO_TIMEOUT` to opt out deliberately rather than by
 *    omission.
 */
export interface ApiRequestOptions extends RequestInit {
  /**
   * Per-request timeout in ms. Omit for the method's default
   * ({@link resolveDefaultTimeoutMs}); pass {@link API_NO_TIMEOUT} (or `null`)
   * for none.
   */
  timeoutMs?: number | null;
  /**
   * Retries after the first attempt. Omit for {@link API_RETRY_MAX_RETRIES}.
   *
   * **Ignored for non-idempotent methods** — see {@link isIdempotentMethod}. A
   * caller cannot opt a `POST` into retrying by passing a number here, because
   * the duplicate-send hazard is a property of the method, not of the call
   * site's confidence.
   */
  retries?: number;
}

/**
 * Last reachability verdict pushed to `useConnectivity`, and when.
 *
 * Module state rather than a parameter because the throttle is about the
 * *stream* of requests the app makes, not about any one of them. Reset by
 * {@link __resetApiReachabilityReporting} between tests.
 */
let lastReachabilityReport: { reachable: boolean; at: number } | null = null;

/**
 * Feed one request's outcome to `useConnectivity` (Issue #2499 × #2501).
 *
 * This is the line the connection banner's accuracy actually rests on. #2501's
 * own probe only runs *after* the verdict has already gone degraded and only
 * every 15s; the requests the app is making anyway are both earlier evidence
 * and free. So a response — **any** response, 200 or 500 alike, because a 500
 * proves the packet crossed the network and came back — reports reachable, and
 * a transport failure reports the opposite.
 *
 * Identical verdicts are collapsed to transitions plus one refresh per
 * {@link API_REACHABILITY_REPORT_INTERVAL_MS}: the detail screen alone polls
 * three endpoints every 2s, and re-announcing "still reachable" 90 times a
 * minute would re-render every connectivity surface in the app for no change in
 * what any of them display.
 */
function noteReachability(reachable: boolean): void {
  const now = Date.now();
  if (
    lastReachabilityReport !== null &&
    lastReachabilityReport.reachable === reachable &&
    now - lastReachabilityReport.at < API_REACHABILITY_REPORT_INTERVAL_MS
  ) {
    return;
  }
  lastReachabilityReport = { reachable, at: now };
  reportServerReachability(reachable);
}

/**
 * Drop the reachability throttle's memory.
 *
 * Exported for tests only: the throttle above is module state, so a test that
 * asserts a report was (or was not) emitted has to start from a known point
 * rather than from whatever the previous test in the file left behind.
 */
export function __resetApiReachabilityReporting(): void {
  lastReachabilityReport = null;
}

/**
 * Fail before the request when the device says there is no network.
 *
 * The asymmetry from `useConnectivity`'s module note applies here too and in
 * the same direction: `navigator.onLine === false` is trusted, `true` is not.
 * `false` means the OS has no route at all, so the request cannot succeed and
 * waiting the full timeout for it to not succeed is pure user-visible delay —
 * which on a phone is the whole complaint in Issue #2499. `true` is worth
 * nothing (a captive portal reports it happily) and is therefore not consulted.
 *
 * Deliberately does NOT call {@link noteReachability}: nothing was measured.
 * Reporting `false` here would put a *server* verdict on the wire from a
 * *device* signal, and `useConnectivity` already answers "offline" from
 * `browserOnline` on its own.
 */
function assertOnline(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError('No network connection', 0, undefined, 'offline');
  }
}

/** Turn whatever `fetch()` rejected with into an {@link ApiError}. */
function normalizeTransportError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  // AbortError is what a fired signal produces; TimeoutError is what
  // `AbortSignal.timeout()` produces in environments that use it directly.
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new ApiError('Request aborted', 0, error, 'aborted');
  }
  return new ApiError(
    error instanceof Error ? error.message : 'Unknown error',
    0,
    error,
    'network'
  );
}

/**
 * One attempt, bounded by `timeoutMs`.
 *
 * Built on `AbortController` + `setTimeout` rather than on `AbortSignal.timeout()`
 * for two reasons that both come down to needing to *observe* the deadline:
 *
 *  1. The rejection has to be distinguishable. `AbortSignal.timeout()` and a
 *     caller's own abort both surface as an abort on the composed signal, and
 *     telling the user "the network is slow" when they simply navigated away is
 *     a worse bug than the one being fixed. The `timedOut` flag below is the
 *     only thing that can tell them apart.
 *  2. The deadline has to be drivable by `vi.useFakeTimers()`. `AbortSignal.timeout()`
 *     runs on an internal timer no test can advance, which would leave the
 *     central promise of this Issue — "a hung request is cut off" — asserted
 *     only by hoping.
 *
 * `useConnectivity.runProbe` builds its probe timeout the same way, so the two
 * are consistent.
 */
async function fetchOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const external = init.signal ?? undefined;
  if (external?.aborted) {
    throw new ApiError('Request aborted', 0, undefined, 'aborted');
  }
  if (timeoutMs <= 0 || typeof AbortController !== 'function') {
    return fetch(url, init);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  external?.addEventListener('abort', forwardAbort);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    // Order matters: a caller who aborts at the same instant the deadline fires
    // is still a caller who aborted, but a deadline that fired while no caller
    // signal exists can only be ours.
    if (external?.aborted) {
      throw new ApiError('Request aborted', 0, error, 'aborted');
    }
    if (timedOut) {
      throw new ApiError(`Request timed out after ${timeoutMs}ms`, 0, error, 'timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', forwardAbort);
  }
}

/** Resolve after `ms`, used between retry attempts. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The transport every client request in the app should go through: bounded in
 * time, retried when that is safe, fail-fast when the device is offline, and
 * reporting what it learns to the connection banner. Issue #2499.
 *
 * Returns the raw `Response` and interprets **nothing** about it — no status
 * check, no JSON parse, no `Content-Type` header added. That is what makes it
 * usable by the call sites that cannot go through {@link fetchApi}: the file
 * poller needs to see a bare 304 and read `Last-Modified` off a response with
 * no body at all, and the chunk loader wants `res.ok ? res.json() : null`
 * rather than a throw. Those call sites keep their own body handling and gain
 * only the policy. {@link fetchApi} is this function plus the JSON contract.
 *
 * Retry applies to idempotent methods only, and only to failures that a repeat
 * could plausibly fix: a transport error, this client's timeout, or one of
 * {@link API_RETRYABLE_STATUS_CODES}. A caller's own abort ends the loop
 * immediately — it is an instruction, not a fault — and so does
 * {@link API_RETRY_TOTAL_BUDGET_MS} running out.
 *
 * @throws {ApiError} always, and only — never a raw `TypeError` or `AbortError`.
 *   A non-ok *response* is returned, not thrown; only a request that produced no
 *   response at all rejects.
 */
export async function fetchApiResponse(
  url: string,
  options?: ApiRequestOptions
): Promise<Response> {
  const { timeoutMs, retries, ...init } = options ?? {};
  const method = (init.method ?? 'GET').toUpperCase();
  // Non-idempotent methods are pinned to zero regardless of what was asked for.
  // This is the guard behind "a send is never duplicated": see
  // API_IDEMPOTENT_METHODS.
  const maxRetries = isIdempotentMethod(method)
    ? Math.max(0, retries ?? API_RETRY_MAX_RETRIES)
    : 0;
  const effectiveTimeout =
    timeoutMs === undefined ? resolveDefaultTimeoutMs(method) : timeoutMs ?? API_NO_TIMEOUT;
  const startedAt = Date.now();

  /** Whether there is another attempt left, in both count and wall clock. */
  const canRetry = (attempt: number): boolean =>
    attempt < maxRetries && Date.now() - startedAt < API_RETRY_TOTAL_BUDGET_MS;

  for (let attempt = 0; ; attempt++) {
    assertOnline();
    try {
      const response = await fetchOnce(url, init, effectiveTimeout);
      noteReachability(true);
      if (isRetryableStatus(response.status) && canRetry(attempt)) {
        await delay(computeRetryDelayMs(attempt));
        continue;
      }
      return response;
    } catch (error) {
      const apiError = normalizeTransportError(error);
      // An abort the caller asked for says nothing about the server, and a
      // retry would be answering a question nobody is still asking.
      if (apiError.kind === 'aborted') throw apiError;
      noteReachability(false);
      if (!canRetry(attempt)) throw apiError;
      await delay(computeRetryDelayMs(attempt));
    }
  }
}

/**
 * Base fetch wrapper with error handling.
 *
 * Issue #2499: the request itself now goes through {@link fetchApiResponse}, so
 * every caller of this function inherited the timeout, the retry ladder, the
 * offline fail-fast and the reachability reporting without changing a line. The
 * body handling below — the `Content-Type` header, the two response guards, the
 * error-body parse — is unchanged.
 */
async function fetchApi<T>(url: string, options?: ApiRequestOptions): Promise<T> {
  try {
    const headers = new Headers(options?.headers);
    headers.set('Content-Type', 'application/json');

    const response = await fetchApiResponse(url, {
      ...options,
      headers,
    });

    // Detect auth redirect: fetch follows 307 to /login, returning HTML with 200.
    // Check content-type to avoid parsing HTML as JSON.
    const redirectError = detectAuthRedirect(response);
    if (redirectError) {
      throw redirectError;
    }

    if (!response.ok) {
      const errorBody = await safeParseJson<{ error?: string }>(
        response, {}, 'error-body'
      );
      throw new ApiError(
        errorBody.error || `HTTP error ${response.status}`,
        response.status,
        errorBody
      );
    }

    const formatError = detectNonJsonBody(response);
    if (formatError) {
      throw formatError;
    }

    return response.json();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      error instanceof Error ? error.message : 'Unknown error',
      0,
      error
    );
  }
}

/**
 * Revive a message's `timestamp` after the JSON round trip (Issue #2213).
 *
 * `ChatMessage.timestamp` is typed `Date`, but JSON has no date type, so a row
 * that came off the wire carries an ISO string in that field — and every
 * consumer of it (`usePendingMessages`' reconciliation ordering,
 * `useSplitMessages`' sort and pair trim) calls `.getTime()` on it. The same
 * `new Date(...)` `useSplitMessages.parseMessageTimestamps` applies to a fetched
 * list, applied to a single created row so the two producers hand out the same
 * shape.
 *
 * Tolerant of a body that is not an object: a caller has enough problems when
 * the server answered 201 with something else, and a `TypeError` from here
 * would hide it.
 */
export function reviveMessageTimestamp(message: ChatMessage): ChatMessage {
  if (message === null || typeof message !== 'object') return message;
  if (message.timestamp instanceof Date) return message;
  return { ...message, timestamp: new Date(message.timestamp) };
}

/**
 * Worktree API client
 */
export const worktreeApi = {
  /**
   * Get all worktrees and repositories
   */
  async getAll(): Promise<WorktreesResponse> {
    return fetchApi<WorktreesResponse>('/api/worktrees');
  },

  /**
   * Get a specific worktree by ID
   */
  async getById(id: string): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`);
  },

  /**
   * Update worktree description
   */
  async updateDescription(id: string, description: string): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ description }),
    });
  },

  /**
   * Update worktree link
   */
  async updateLink(id: string, link: string): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ link }),
    });
  },

  /**
   * Toggle worktree favorite status
   */
  async toggleFavorite(id: string, favorite: boolean): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ favorite }),
    });
  },

  /**
   * Update worktree status
   */
  async updateStatus(id: string, status: 'ready' | 'in_progress' | 'in_review' | 'done' | null): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },

  /**
   * Update worktree CLI tool
   */
  async updateCliTool(id: string, cliToolId: CLIToolType): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ cliToolId }),
    });
  },

  /**
   * Mark worktree as viewed (for unread tracking - Issue #31)
   * Updates last_viewed_at timestamp to current time
   */
  async markAsViewed(id: string): Promise<{ success: boolean }> {
    return fetchApi<{ success: boolean }>(`/api/worktrees/${id}/viewed`, {
      method: 'PATCH',
    });
  },

  /**
   * Get messages for a worktree, optionally filtered by CLI tool
   * Issue #168: Added includeArchived parameter for session history retention
   * Issue #701: Added limit parameter for user-selectable display count (50-250)
   */
  async getMessages(
    id: string,
    cliTool?: CLIToolType,
    includeArchived?: boolean,
    limit?: number,
  ): Promise<ChatMessage[]> {
    const params = new URLSearchParams();
    if (cliTool) {
      params.append('cliTool', cliTool);
    }
    if (includeArchived) {
      params.append('includeArchived', 'true');
    }
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      params.append('limit', String(limit));
    }
    const url = `/api/worktrees/${id}/messages${params.toString() ? `?${params.toString()}` : ''}`;
    return fetchApi<ChatMessage[]>(url);
  },

  /**
   * Send a message to a worktree
   * Issue #474: [S1-M2] Changed 3rd argument to options object for type safety
   *
   * Issue #2213: resolves with the row the server created. `/send` has always
   * answered 201 with the saved {@link ChatMessage} (`NextResponse.json(
   * result.message, { status: 201 })`); this client declared the response as
   * `{ success: boolean }` and threw the body away in the type. Callers that
   * only care whether the send resolved are unaffected — they already ignore
   * the value.
   *
   * @param id - Worktree ID
   * @param content - Message content
   * @param options - Optional settings (cliToolId, instanceId, imagePath)
   * @returns The created message, with its `timestamp` revived to a `Date`
   */
  async sendMessage(
    id: string,
    content: string,
    options?: { cliToolId?: CLIToolType; instanceId?: string; imagePath?: string }
  ): Promise<ChatMessage> {
    const body: { content: string; cliToolId?: string; instanceId?: string; imagePath?: string } = { content };
    if (options?.cliToolId) {
      body.cliToolId = options.cliToolId;
    }
    // Issue #869: target a specific agent instance (defaults to primary === cliToolId).
    if (options?.instanceId) {
      body.instanceId = options.instanceId;
    }
    if (options?.imagePath) {
      body.imagePath = options.imagePath;
    }
    const created = await fetchApi<ChatMessage>(`/api/worktrees/${id}/send`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return reviveMessageTimestamp(created);
  },

  /**
   * Upload an image file for attachment
   * Issue #474: [S2-M3] Uses fetch() directly (not fetchApi) for FormData/multipart support
   *
   * @param worktreeId - Worktree ID
   * @param file - Image file to upload
   * @returns Upload result with server-side path
   */
  async uploadImageFile(
    worktreeId: string,
    file: File
  ): Promise<{ path: string }> {
    const timestamp = Date.now();
    const filename = `${timestamp}-${file.name}`;
    const uploadPath = `.commandmate/attachments`;
    const formData = new FormData();
    formData.append('file', new File([file], filename, { type: file.type }));

    const response = await fetch(`/api/worktrees/${worktreeId}/upload/${uploadPath}`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await safeParseJson<{ error?: { message?: string } }>(
        response, {}, 'error-body'
      );
      throw new Error(errorBody?.error?.message || `Upload failed (HTTP ${response.status})`);
    }

    const data = await safeParseJson<{ path?: string; filename?: string }>(
      response, {}, 'response-body'
    );
    return { path: data.path || `${uploadPath}/${filename}` };
  },

  /**
   * Get log files for a worktree
   */
  async getLogs(id: string): Promise<string[]> {
    return fetchApi<string[]>(`/api/worktrees/${id}/logs`);
  },

  /**
   * Get content of a specific log file
   * @param id - Worktree ID
   * @param filename - Log filename
   * @param options - Optional parameters (sanitize: apply privacy sanitization)
   */
  async getLogFile(id: string, filename: string, options?: { sanitize?: boolean }): Promise<{
    filename: string;
    cliToolId: string;
    content: string;
    size: number;
    modifiedAt: string;
  }> {
    const queryParams = options?.sanitize ? '?sanitize=true' : '';
    return fetchApi(`/api/worktrees/${id}/logs/${filename}${queryParams}`);
  },

  /**
   * Kill the tmux session for a worktree
   * @param id - Worktree ID
   * @param cliToolId - Optional CLI tool ID (claude, codex, gemini). If not specified, uses worktree's default.
   * @param instanceId - Optional agent instance ID (Issue #875). When provided,
   *   scopes the kill to that single instance; the primary instance uses
   *   instanceId === cliToolId. Sent as the `instance` query parameter that the
   *   kill-session route already understands.
   */
  async killSession(
    id: string,
    cliToolId?: CLIToolType,
    instanceId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const query = new URLSearchParams();
    if (cliToolId) query.set('cliTool', cliToolId);
    if (instanceId) query.set('instance', instanceId);
    const queryString = query.toString();
    return fetchApi<{ success: boolean; message: string }>(
      `/api/worktrees/${id}/kill-session${queryString ? `?${queryString}` : ''}`,
      { method: 'POST' }
    );
  },
};

/**
 * Excluded repository from API
 * Issue #190: Repository exclusion on sync
 */
export interface ExcludedRepository {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  cloneSource: string;
  isEnvManaged: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Repository list item returned by GET /api/repositories
 * Issue #644: Repository list display and inline display_name edit UI
 * Issue #690: `visible` field added for sidebar visibility toggle
 */
export interface RepositoryListItem {
  id: string;
  name: string;
  displayName: string | null;
  path: string;
  enabled: boolean;
  /** Sidebar visibility flag (Issue #690). Defaults to true. */
  visible: boolean;
  worktreeCount: number;
  /**
   * Paths of the OTHER enabled scan roots that are the same git repository as
   * this one — i.e. sibling worktrees registered as separate roots (Issue
   * #1662). Empty for the normal case of one root per repository.
   *
   * Optional rather than required: the server always sends it, but typing it as
   * required would make every existing `RepositoryListItem` literal a compile
   * error for a field that means "nothing to report" when absent.
   */
  duplicateOf?: string[];
}

/**
 * Response type for PUT /api/repositories/[id]
 *
 * Issue #644: Originally introduced for the `displayName` partial-update.
 * Issue #690: Now also handles the `visible` partial-update; the canonical
 *             name is `UpdateRepositoryResponse`. `UpdateRepositoryDisplayNameResponse`
 *             remains as a back-compat alias for any external consumer that
 *             imported the original name.
 *
 * NOTE: The API returns the updated repository WITHOUT worktreeCount
 * (the PUT handler does not re-aggregate). The client is expected to
 * preserve its current worktreeCount locally when merging the update.
 */
export interface UpdateRepositoryResponse {
  success: boolean;
  repository: Omit<RepositoryListItem, 'worktreeCount'>;
}

/**
 * Back-compat alias for `UpdateRepositoryResponse` (Issue #644).
 * Prefer `UpdateRepositoryResponse` in new code.
 */
export type UpdateRepositoryDisplayNameResponse = UpdateRepositoryResponse;

/**
 * Delete repository response type
 */
export interface DeleteRepositoryResponse {
  success: boolean;
  deletedWorktreeCount: number;
  deletedWorktreeIds: string[];
  warnings?: string[];
}

/**
 * Clone job start response type
 * Issue #71: Clone URL registration feature
 */
export interface CloneStartResponse {
  success: true;
  jobId: string;
  status: 'pending';
  message: string;
}

/**
 * Clone job status response type
 * Issue #71: Clone URL registration feature
 */
export interface CloneStatusResponse {
  success: true;
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  repositoryId?: string;
  error?: {
    category: string;
    code: string;
    message: string;
  };
}

/**
 * Repository API client
 */
export const repositoryApi = {
  /**
   * Scan a new repository path for worktrees
   */
  async scan(repositoryPath: string): Promise<{
    success: boolean;
    message: string;
    worktreeCount: number;
    repositoryPath: string;
    repositoryName: string;
  }> {
    return fetchApi('/api/repositories/scan', {
      method: 'POST',
      body: JSON.stringify({ repositoryPath }),
    });
  },

  /**
   * Re-sync all configured repositories
   */
  async sync(): Promise<{
    success: boolean;
    message: string;
    worktreeCount: number;
    repositoryCount: number;
    repositories: string[];
  }> {
    return fetchApi('/api/repositories/sync', {
      method: 'POST',
    });
  },

  /**
   * Delete a repository and all its worktrees
   * Issue #69: Repository delete feature
   *
   * @param repositoryPath - Path of the repository to delete
   * @returns Delete result with count and any warnings
   */
  async delete(repositoryPath: string): Promise<DeleteRepositoryResponse> {
    return fetchApi<DeleteRepositoryResponse>('/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({ repositoryPath }),
    });
  },

  /**
   * Start a clone job for a remote repository
   * Issue #71: Clone URL registration feature
   * Issue #1480: optional fork-and-add
   *
   * @param cloneUrl - Git clone URL (HTTPS or SSH)
   * @param options.fork - When true, fork into the authenticated user's namespace
   *   first and clone that fork (origin = own fork, upstream = original)
   * @returns Clone job response with job ID
   */
  async clone(cloneUrl: string, options?: { fork?: boolean }): Promise<CloneStartResponse> {
    return fetchApi<CloneStartResponse>('/api/repositories/clone', {
      method: 'POST',
      body: JSON.stringify({ cloneUrl, fork: options?.fork ?? false }),
    });
  },

  /**
   * Get the status of a clone job
   * Issue #71: Clone URL registration feature
   *
   * @param jobId - Clone job ID
   * @returns Clone job status
   */
  async getCloneStatus(jobId: string): Promise<CloneStatusResponse> {
    return fetchApi<CloneStatusResponse>(`/api/repositories/clone/${jobId}`);
  },

  /**
   * Get excluded (disabled) repositories
   * Issue #190: Repository exclusion on sync
   *
   * @returns List of excluded repositories
   */
  async getExcluded(): Promise<{ success: boolean; repositories: ExcludedRepository[] }> {
    return fetchApi('/api/repositories/excluded');
  },

  /**
   * Restore an excluded repository
   * Issue #190: Repository exclusion on sync
   *
   * @param repositoryPath - Path of the repository to restore
   * @returns Restore result with worktree count
   */
  async restore(repositoryPath: string): Promise<{
    success: boolean;
    worktreeCount: number;
    message?: string;
    warning?: string;
  }> {
    return fetchApi('/api/repositories/restore', {
      method: 'PUT',
      body: JSON.stringify({ repositoryPath }),
    });
  },

  /**
   * List all repositories with worktree counts.
   * Issue #644: Repository list display
   *
   * @returns Object containing the repository list.
   *          Includes disabled repositories (enabled=false) with worktreeCount.
   */
  async list(): Promise<{ success: boolean; repositories: RepositoryListItem[] }> {
    return fetchApi<{ success: boolean; repositories: RepositoryListItem[] }>(
      '/api/repositories'
    );
  },

  /**
   * Update the display_name (alias) for a repository.
   * Issue #644: Repository list inline edit
   *
   * @param id - Repository ID
   * @param displayName - New display name. Pass an empty string or null to clear.
   * @returns The updated repository (without worktreeCount).
   */
  async updateDisplayName(
    id: string,
    displayName: string | null
  ): Promise<UpdateRepositoryResponse> {
    return fetchApi<UpdateRepositoryResponse>(
      `/api/repositories/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ displayName }),
      }
    );
  },

  /**
   * Update the sidebar visibility flag for a repository.
   * Issue #690: Repositories screen visibility toggle.
   *
   * @param id - Repository ID
   * @param visible - true => shown in sidebar, false => hidden
   * @returns The updated repository (without worktreeCount).
   */
  async updateVisibility(
    id: string,
    visible: boolean
  ): Promise<UpdateRepositoryResponse> {
    return fetchApi<UpdateRepositoryResponse>(
      `/api/repositories/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ visible }),
      }
    );
  },

  /**
   * Update the scan-inclusion flag for a repository (Issue #1658).
   *
   * This is the NON-DESTRUCTIVE exclusion: the server writes one column and
   * touches neither the worktree rows nor the running tmux sessions. Contrast
   * with {@link repositoryApi.delete}, which excludes **and purges**.
   *
   * Note that the reverse direction has two flavours: this call with
   * `enabled: true` only flips the flag back, whereas
   * {@link repositoryApi.restore} additionally re-scans the repository so its
   * worktrees reappear immediately. The Repositories screen uses `restore` for
   * re-enabling, because "restore" is what a user pressing it means.
   *
   * @param id - Repository ID
   * @param enabled - true => included in scans, false => excluded
   * @returns The updated repository (without worktreeCount).
   */
  async updateEnabled(
    id: string,
    enabled: boolean
  ): Promise<UpdateRepositoryResponse> {
    return fetchApi<UpdateRepositoryResponse>(
      `/api/repositories/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }
    );
  },

  /**
   * Check a local path before scanning it (Issue #1517).
   *
   * Answers the question `scan` will answer — is this inside an allowed root,
   * is it a git repository, how many worktrees — so the form can say so while
   * the user types instead of failing after submit.
   */
  async validatePath(repositoryPath: string): Promise<ValidatePathResponse> {
    return fetchApi<ValidatePathResponse>('/api/repositories/validate-path', {
      method: 'POST',
      body: JSON.stringify({ repositoryPath }),
    });
  },
};

/**
 * Result of POST /api/repositories/validate-path (Issue #1517)
 */
export interface ValidatePathResponse {
  valid: boolean;
  /** Present when `valid` is false. */
  reason?: 'invalid' | 'outside-roots' | 'symlink-escape' | 'not-found';
  resolvedPath?: string;
  roots: string[];
  /** Allowed roots pre-joined for display. */
  allowedRootsLabel: string;
  isGitRepo: boolean;
  worktreeCount: number | null;
  /**
   * Paths of already-registered scan roots that are the SAME git repository as
   * the candidate (Issue #1662). Non-empty means "registering this creates a
   * duplicate scan root" — a warning the Add form must surface, NOT a rejection:
   * `valid` is unaffected by it.
   */
  duplicateScanRoots?: string[];
}

/**
 * A browsable directory returned by GET /api/fs/browse (Issue #1517).
 * Only directories are ever returned — never file names.
 */
export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  worktreeCount: number | null;
}

/**
 * Result of GET /api/fs/browse (Issue #1517).
 * `path === null` is the top level, whose entries are the allowed roots.
 */
export interface BrowseResponse {
  path: string | null;
  parent: string | null;
  roots: string[];
  recentPaths: string[];
  entries: BrowseEntry[];
  truncated: boolean;
  entryLimit: number;
}

/**
 * Server filesystem browse API client (Issue #1517).
 *
 * The directory being chosen lives on the server, which may be a different host
 * from the browser, so `showDirectoryPicker()` / `<input webkitdirectory>`
 * cannot supply it.
 */
export const fsApi = {
  /**
   * List directories under `browsePath`, or the allowed roots when omitted.
   */
  async browse(browsePath?: string): Promise<BrowseResponse> {
    const query = browsePath
      ? `?path=${encodeURIComponent(browsePath)}`
      : '';
    return fetchApi<BrowseResponse>(`/api/fs/browse${query}`);
  },

  /**
   * Remember a directory so the picker reopens there next time.
   */
  async addRecentPath(browsePath: string): Promise<{ success: boolean }> {
    return fetchApi<{ success: boolean }>('/api/fs/recent-paths', {
      method: 'POST',
      body: JSON.stringify({ path: browsePath }),
    });
  },
};

/**
 * Slash Commands API response
 */
export interface SlashCommandsResponse {
  groups: SlashCommandGroup[];
}

/**
 * Slash Command API client
 */
export const slashCommandApi = {
  /**
   * Get all slash commands grouped by category
   */
  async getAll(): Promise<SlashCommandsResponse> {
    return fetchApi<SlashCommandsResponse>('/api/slash-commands');
  },
};

/**
 * Memo API response types
 */
export interface MemosResponse {
  memos: WorktreeMemo[];
}

export interface MemoResponse {
  memo: WorktreeMemo;
}

/**
 * Memo creation request body
 */
export interface CreateMemoRequest {
  title?: string;
  content?: string;
}

/**
 * Memo update request body
 */
export interface UpdateMemoRequest {
  title?: string;
  content?: string;
}

/**
 * Memo API client
 * CRUD operations for worktree memos
 */
export const memoApi = {
  /**
   * Get all memos for a worktree
   * @param worktreeId - ID of the worktree
   * @returns List of memos sorted by position
   */
  async getAll(worktreeId: string): Promise<WorktreeMemo[]> {
    const response = await fetchApi<MemosResponse>(`/api/worktrees/${worktreeId}/memos`);
    return response.memos;
  },

  /**
   * Create a new memo for a worktree
   * @param worktreeId - ID of the worktree
   * @param data - Memo data (title, content)
   * @returns Created memo
   */
  async create(worktreeId: string, data?: CreateMemoRequest): Promise<WorktreeMemo> {
    const response = await fetchApi<MemoResponse>(`/api/worktrees/${worktreeId}/memos`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
    return response.memo;
  },

  /**
   * Update an existing memo
   * @param worktreeId - ID of the worktree
   * @param memoId - ID of the memo to update
   * @param data - Fields to update (title and/or content)
   * @returns Updated memo
   */
  async update(worktreeId: string, memoId: string, data: UpdateMemoRequest): Promise<WorktreeMemo> {
    const response = await fetchApi<MemoResponse>(
      `/api/worktrees/${worktreeId}/memos/${memoId}`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
    return response.memo;
  },

  /**
   * Delete a memo
   * @param worktreeId - ID of the worktree
   * @param memoId - ID of the memo to delete
   * @returns Success status
   */
  async delete(worktreeId: string, memoId: string): Promise<{ success: boolean }> {
    return fetchApi<{ success: boolean }>(
      `/api/worktrees/${worktreeId}/memos/${memoId}`,
      { method: 'DELETE' }
    );
  },

  /**
   * Reorder the memos of a worktree (Issue #944)
   * @param worktreeId - ID of the worktree
   * @param memoIds - Complete set of memo IDs in the desired order
   */
  async reorder(worktreeId: string, memoIds: string[]): Promise<void> {
    await fetchApi<{ success: boolean }>(
      `/api/worktrees/${worktreeId}/memos`,
      {
        method: 'PATCH',
        body: JSON.stringify({ memoIds }),
      }
    );
  },
};

/**
 * Helper to handle API errors in components
 */
export function handleApiError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unknown error occurred';
}

/**
 * Update check response type
 * Issue #257: Version update notification feature
 */
export interface UpdateCheckResponse {
  status: 'success' | 'degraded';
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  /** 'npx' (Issue #1394): running from the npx cache — no in-place update */
  installType: 'global' | 'local' | 'npx' | 'unknown';
  updateCommand: string | null;
}

/**
 * Response of POST /api/app/update
 * Issue #1198: one-click self-update
 */
export interface UpdateStartResponse {
  status: 'started';
  /** False when no PID file exists: the update installs but this server keeps running the old version */
  willRestart: boolean;
  logPath: string;
}

/**
 * App-level API client
 * Issue #257: Application-wide endpoints (not worktree-specific)
 */
export const appApi = {
  /**
   * Check for application updates via GitHub Releases API.
   * Issue #257: Version update notification feature
   *
   * Note: fetchApi attaches Content-Type: application/json to all requests
   * including GET (CONS-004, IMP-SF-001). This is functionally harmless for
   * GET requests. Future developers: be aware of this behavior when adding
   * POST endpoints to /api/app/
   *
   * @returns Update check response with version info and install type
   */
  async checkForUpdate(): Promise<UpdateCheckResponse> {
    return fetchApi<UpdateCheckResponse>('/api/app/update-check', {
      method: 'GET',
    });
  },

  /**
   * Start the self-update.
   * Issue #1198: sends no body — the server runs a fixed command and ignores
   * request content by construction. Do not add a payload here.
   *
   * @throws ApiError with status 400 (not a global install) or 409 (already running)
   */
  async startUpdate(): Promise<UpdateStartResponse> {
    return fetchApi<UpdateStartResponse>('/api/app/update', {
      method: 'POST',
    });
  },

  /**
   * Liveness probe used to watch the server go down and come back during an
   * update. Issue #1198: `/api/auth/status` is an AUTH_EXCLUDED_PATH,
   * force-dynamic, and touches no DB, so it answers both before and after the
   * restart regardless of auth.
   *
   * Never throws: a rejected fetch during an update is the expected signal, not
   * an error to surface.
   *
   * @returns true when the server answered
   */
  async ping(): Promise<boolean> {
    try {
      const response = await fetch('/api/auth/status', { cache: 'no-store' });
      return response.ok;
    } catch {
      return false;
    }
  },
};

