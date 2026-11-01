/**
 * API Client for CLI Commands
 * Issue #518: HTTP communication layer with auth, error handling
 *
 * [DR1-01] Responsibilities separated:
 * - resolveAuthToken(): Token resolution (--token > CM_AUTH_TOKEN)
 * - handleApiError(): Error classification and user-friendly messages
 * - ApiClient: HTTP get/post with base URL and auth headers
 */

import { ExitCode } from '../types';
import { readPackageVersion } from './package-info';
import { isUatIsolationEnabled, UAT_ISOLATION_ENV_VAR } from '../../config/uat-isolation';
import { loadClientEnv, resolveServerEndpoint } from './server-url';
import { ApiError, handleApiError } from './api-client-errors';
import type { ApiErrorPayload } from './api-client-errors';
import { DeadlineExceededError } from './api-client-deadline';

export {
  ApiError,
  FOREIGN_SESSION_ERROR_CODE,
  foreignSessionMessage,
  handleApiError,
} from './api-client-errors';
export type { ApiErrorContext, ApiErrorPayload, ApiErrorResult } from './api-client-errors';
export {
  DeadlineExceededError,
  isDeadlineExceeded,
  rethrowIfDeadlineExceeded,
} from './api-client-deadline';

/** Maximum stop-pattern length [SEC4-06] */
export const MAX_STOP_PATTERN_LENGTH = 500;

/** Worktree ID validation pattern [SEC4-04] */
const WORKTREE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Validate worktree ID format [SEC4-04]
 * @param id - Worktree ID to validate
 * @returns True if valid
 */
export function isValidWorktreeId(id: string): boolean {
  return WORKTREE_ID_PATTERN.test(id) && id.length <= 200;
}

/**
 * Agent instance ID validation pattern (Issue #868).
 * Mirrors the server-side INSTANCE_ID_PATTERN so invalid identifiers are
 * rejected client-side before hitting the API (which embeds the id in a tmux
 * session name).
 */
const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Maximum length for an agent instance ID (mirrors server MAX_INSTANCE_ID_LENGTH). */
const MAX_INSTANCE_ID_LENGTH = 64;

/**
 * Validate agent instance ID format (Issue #868).
 * @param id - Instance ID to validate
 * @returns True if valid
 */
export function isValidInstanceId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_INSTANCE_ID_LENGTH && INSTANCE_ID_PATTERN.test(id);
}

/**
 * Resolve authentication token from options or environment.
 * [SEC4-01] Warns on stderr when --token flag is used.
 *
 * @param options - Options object with optional token
 * @returns Resolved token or undefined
 */
export function resolveAuthToken(options?: { token?: string }): string | undefined {
  if (options?.token) {
    // [SEC4-01] Warn about token exposure in process list
    console.error(
      'Warning: --token flag exposes token in process list and shell history. Use CM_AUTH_TOKEN environment variable instead.'
    );
    return options.token;
  }
  return process.env.CM_AUTH_TOKEN;
}

/**
 * Check if a URL points to a localhost address.
 */
function isLocalhost(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * API Client for CLI HTTP communication.
 * Uses Node.js built-in fetch. Handles auth headers and error mapping.
 */
export class ApiClient {
  private baseUrl: string;
  private token?: string;
  /** Epoch ms after which every request of this client fails (Issue #3983). */
  private deadlineAt?: number;

  constructor(options?: { baseUrl?: string; token?: string }) {
    // Issue #1743: resolve through loadClientEnv() rather than `process.env.CM_PORT || '3000'`.
    // Reading process.env alone ignored ~/.commandmate/.env, so with two servers running,
    // `status` reported the .env port while every ApiClient-based subcommand (ls / send / wait
    // / capture / …) silently talked to the default port 3000. loadClientEnv() layers .env
    // *under* process.env — see its doc comment for why that order is the reverse of the one
    // `status` uses. resolveServerEndpoint() then applies the same CM_BIND / CM_HTTPS_CERT +
    // CM_HTTPS_KEY rules as `status`, which the old hardcoded `http://localhost:` ignored.
    // Issue #3360: in UAT isolation the default port 3000 is the user's production server,
    // so a client that was not told where to go must not go anywhere.
    if (!options?.baseUrl && isUatIsolationEnabled() && !process.env.CM_PORT) {
      throw new ApiError(
        `${UAT_ISOLATION_ENV_VAR}=${process.env[UAT_ISOLATION_ENV_VAR]} requires CM_PORT: refusing to fall back to the default port 3000.`,
        ExitCode.CONFIG_ERROR
      );
    }
    this.baseUrl = options?.baseUrl || resolveServerEndpoint(loadClientEnv()).url;
    this.token = resolveAuthToken(options);

    // [SEC4-02] Warn about HTTP to non-localhost
    if (this.token && !this.baseUrl.startsWith('https://') && !isLocalhost(this.baseUrl)) {
      console.error(
        'Warning: Connecting to remote server over HTTP. Auth token will be sent in plaintext. Use HTTPS for non-localhost connections.'
      );
    }
  }

  /**
   * The base URL this client actually dials (Issue #2404).
   *
   * Resolved once in the constructor: the `baseUrl` option when a caller passes
   * one (there is no CLI flag for it), else `CM_PORT` / `CM_BIND` through the
   * precedence in `loadClientEnv()` (exported > `~/.commandmate/.env` > 3000;
   * under `CM_UAT_ISOLATION=1` exported only, never 3000), which is why it is
   * read from here rather than re-derived by each
   * caller: a second derivation is a second answer, and "which server did this
   * command talk to" only helps if it is the one the request went to.
   */
  get serverUrl(): string {
    return this.baseUrl;
  }

  /**
   * This client with every request bounded by `deadlineAt` (Issue #3983).
   *
   * `wait` / `ask` / `verify` take `--timeout` as the deadline of the whole
   * command, but only the poll's own reads were bounded by it: a task-ledger
   * read, an `--instance` resolution or a capability probe before the poll had
   * no deadline at all, so a server that stopped answering held the command for
   * as long as undici's own timeouts (minutes) and then, swallowed into a
   * degraded path, kept it going. The derived client carries one deadline for
   * every method (`get` / `post` / `patch` / `rawGet`), and a request it ends
   * fails with {@link DeadlineExceededError} — exit 124 — which the
   * degrade-on-failure catches rethrow ({@link isDeadlineExceeded}).
   *
   * One request lasts until its body has been read (`json()` / `text()`), the
   * body of a {@link rawGet} response included: a server that sends headers and
   * then stalls the body is not an answer.
   *
   * @param deadlineAt - Epoch ms; undefined returns this client unchanged
   * @returns A client sharing this one's server and token
   */
  withDeadline(deadlineAt: number | undefined): ApiClient {
    if (deadlineAt === undefined || !Number.isFinite(deadlineAt)) return this;
    // Not `new ApiClient(...)`: the constructor re-resolves the endpoint and
    // re-prints the --token warning, and the derived client must dial the very
    // server this one does.
    const derived = Object.create(Object.getPrototypeOf(this) as object) as ApiClient;
    derived.baseUrl = this.baseUrl;
    derived.token = this.token;
    derived.deadlineAt = deadlineAt;
    return derived;
  }

  /** The deadline this client carries, if any (Issue #3983). */
  get deadline(): number | undefined {
    return this.deadlineAt;
  }

  /**
   * The bound of one request: a signal that fires at the deadline (combined
   * with the caller's own, when it gave one), or null without a deadline.
   */
  private startDeadline(callerSignal?: AbortSignal): RequestDeadline | null {
    if (this.deadlineAt === undefined) return null;
    return startRequestDeadline(this.deadlineAt, this.baseUrl, callerSignal);
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * GET without any status handling, for callers that must read the raw response.
   *
   * Issue #1925: the server-capability probe has to tell a real 404 (an older
   * daemon that predates the endpoint) from a 302 to /login (this request never
   * authenticated) and from an HTML body served by something in the middle.
   * {@link get} collapses all three into an exception with a message, which is
   * exactly the distinction the probe exists to make — so it issues its own
   * request, with `redirect: 'manual'` so a redirect stays visible instead of
   * being followed to a 200 that parses as nothing.
   *
   * @param path - Path appended to the client's base URL
   * @param init - Extra request headers merged over the client's own
   * @returns The raw Response, whatever its status
   */
  async rawGet(path: string, init?: { headers?: Record<string, string> }): Promise<Response> {
    const deadline = this.startDeadline();
    if (!deadline) {
      return fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { ...this.getHeaders(), ...(init?.headers ?? {}) },
        redirect: 'manual',
      });
    }
    // Issue #3983: the caller reads the body, so the deadline is not released
    // here — it stays armed (unref'd) for the body read, which it also bounds.
    try {
      const response = await deadline.run(fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { ...this.getHeaders(), ...(init?.headers ?? {}) },
        redirect: 'manual',
        signal: deadline.signal,
      }));
      return boundBodyReads(response, deadline);
    } catch (error) {
      throw deadline.classify(error);
    }
  }

  /**
   * HTTP GET request
   * [DR1-05] Generic type parameter specified at call site
   *
   * Issue #3956: `init.signal` bounds the request; an aborted one throws an
   * `ApiError` like any other network failure, so a caller that set a deadline
   * reads `signal.aborted` to tell the two apart. Omitted, the request is as
   * before (no `signal` key on the fetch init).
   */
  async get<T>(path: string, init?: { signal?: AbortSignal }): Promise<T> {
    // Issue #3983: a client with a deadline bounds the request and its body.
    const deadline = this.startDeadline(init?.signal);
    const signal = deadline ? deadline.signal : init?.signal;
    try {
      const response = await bounded(deadline, fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.getHeaders(),
        ...(signal ? { signal } : {}),
      }));

      if (!response.ok) {
        // Issue #1637: read the body first — handleApiError needs it to surface
        // the server's reason for a 5xx instead of "check the logs".
        const payload = await bounded(deadline, readErrorPayload(response));
        const errResult = handleApiError(null, response.status, payload, { serverUrl: this.baseUrl });
        throw new ApiError(errResult.message, errResult.exitCode, response.status, payload);
      }

      return (await bounded(deadline, response.json())) as T;
    } catch (error) {
      if (deadline) {
        const classified = deadline.classify(error);
        if (classified instanceof DeadlineExceededError) throw classified;
      }
      if (error instanceof ApiError) throw error;
      const errResult = handleApiError(error);
      throw new ApiError(errResult.message, errResult.exitCode);
    } finally {
      deadline?.release();
    }
  }

  /**
   * HTTP POST request
   * [DR1-05] Generic type parameter specified at call site
   */
  async post<T>(path: string, body?: unknown): Promise<T> {
    return sendWithBody<T>(this.baseUrl, 'POST', this.getHeaders(), path, body, this.startDeadline());
  }

  /**
   * HTTP PATCH request (Issue #1000: agent-instance roster mutations via
   * PATCH /api/worktrees/[id]).
   * [DR1-05] Generic type parameter specified at call site
   */
  async patch<T>(path: string, body?: unknown): Promise<T> {
    return sendWithBody<T>(this.baseUrl, 'PATCH', this.getHeaders(), path, body, this.startDeadline());
  }
}

/** POST / PATCH share everything but the method; an empty body (204) is `undefined`. */
async function sendWithBody<T>(
  baseUrl: string,
  method: 'POST' | 'PATCH',
  headers: Record<string, string>,
  path: string,
  body?: unknown,
  deadline?: RequestDeadline | null
): Promise<T> {
  try {
    const response = await bounded(deadline, fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(deadline ? { signal: deadline.signal } : {}),
    }));

    if (!response.ok) {
      // Issue #1637: read the body first — handleApiError needs it to surface
      // the server's reason for a 5xx instead of "check the logs".
      const payload = await bounded(deadline, readErrorPayload(response));
      const errResult = handleApiError(null, response.status, payload, { serverUrl: baseUrl });
      throw new ApiError(errResult.message, errResult.exitCode, response.status, payload);
    }

    // Handle 204 No Content
    const text = await bounded(deadline, response.text());
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (error) {
    if (deadline) {
      const classified = deadline.classify(error);
      if (classified instanceof DeadlineExceededError) throw classified;
    }
    if (error instanceof ApiError) throw error;
    const errResult = handleApiError(error);
    throw new ApiError(errResult.message, errResult.exitCode, undefined, undefined, error);
  } finally {
    deadline?.release();
  }
}

/**
 * Read the typed error body of a failed response.
 *
 * The generic status-to-message mapping in {@link handleApiError} cannot tell
 * "a local file is in the way" from "the version does not exist" — both are 409
 * or 404 — so commands that need a stable exit code read the server's `code`
 * from here. Never throws: a body that is absent, truncated or not JSON simply
 * yields undefined and the status-based classification stands.
 */
async function readErrorPayload(response: Response): Promise<ApiErrorPayload | undefined> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const record = parsed as ApiErrorPayload;
    return typeof record.code === 'string' || typeof record.error === 'string'
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Command deadline (Issue #3983)
// =============================================================================

/** The longest delay `setTimeout` honours (2^31-1 ms, ~24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** One request's share of a client deadline. */
interface RequestDeadline {
  readonly signal: AbortSignal;
  /** Settle `promise`, or reject with the deadline once it fires. */
  run<T>(promise: Promise<T>): Promise<T>;
  /** The deadline error when the deadline has fired, else `error` unchanged. */
  classify(error: unknown): unknown;
  /** Disarm the timer (the request and its body are done). */
  release(): void;
}

/**
 * Arm the deadline of one request. Its signal goes to `fetch` (which then also
 * aborts the body stream), and every await of the request is raced against it
 * as well — so a stalled body or a transport that ignores the signal still ends
 * on time. Past the deadline the signal is already aborted and no request is
 * sent; started exactly at it, the request gets the current tick (a read at the
 * deadline may still bring the answer `verify` reports, Issue #1544). Beyond
 * what a timer can hold the request is left unbounded.
 */
function startRequestDeadline(
  deadlineAt: number,
  serverUrl: string,
  callerSignal?: AbortSignal,
): RequestDeadline {
  const controller = new AbortController();
  const fire = (): void => {
    if (!controller.signal.aborted) controller.abort(new DeadlineExceededError(serverUrl));
  };
  const remaining = deadlineAt - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (remaining < 0) {
    fire();
  } else if (remaining <= MAX_TIMER_MS) {
    timer = setTimeout(fire, remaining);
    // A command that is done must not stay alive for a deadline it no longer needs.
    timer.unref?.();
  }
  const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
  const deadlineError = (): DeadlineExceededError =>
    controller.signal.reason instanceof DeadlineExceededError
      ? controller.signal.reason
      : new DeadlineExceededError(serverUrl);

  return {
    signal,
    run<T>(promise: Promise<T>): Promise<T> {
      if (controller.signal.aborted) {
        promise.catch(() => {});
        return Promise.reject(deadlineError());
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(deadlineError());
        controller.signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
          (value) => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            controller.signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    },
    classify(error: unknown): unknown {
      return controller.signal.aborted ? deadlineError() : error;
    },
    release(): void {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** `promise` raced against `deadline`, or `promise` itself without one. */
function bounded<T>(deadline: RequestDeadline | null | undefined, promise: Promise<T>): Promise<T> {
  return deadline ? deadline.run(promise) : promise;
}

/**
 * A {@link ApiClient.rawGet} response whose body reads are raced against the
 * request's deadline (Issue #3983). The caller reads the body, so the bound has
 * to travel with the response.
 */
function boundBodyReads(response: Response, deadline: RequestDeadline): Response {
  const read = <T>(method: () => Promise<T>) => (): Promise<T> =>
    deadline.run(method()).catch((error: unknown) => {
      throw deadline.classify(error);
    });
  const json = response.json.bind(response);
  const text = response.text.bind(response);
  Object.defineProperty(response, 'json', { value: read(json), configurable: true });
  Object.defineProperty(response, 'text', { value: read(text), configurable: true });
  return response;
}

// =============================================================================
// Response shape validation & version-skew detection (Issue #1357)
// =============================================================================

/**
 * Build the message shown when a daemon response is malformed or the CLI/daemon
 * versions disagree. Always names the most likely cause — a stale daemon still
 * running an older build than the installed CLI — and the concrete recovery.
 */
function versionSkewMessage(detail: string): string {
  return (
    `${detail}. The running CommandMate server may be an older version than this CLI. ` +
    `Restart it to pick up the current version: commandmate stop && commandmate start`
  );
}

/**
 * Assert that a parsed API response contains the given required top-level fields
 * (Issue #1357).
 *
 * get<T>/post<T>/patch<T> cast the parsed body with `as T` and perform no runtime
 * validation, so a response from a stale daemon that omits a field silently
 * degrades to `undefined` downstream (e.g. a missing roster read as an empty
 * roster). Route responses whose fields you depend on through this guard so a
 * missing field surfaces as an actionable version-skew error instead of a silent
 * wrong value.
 *
 * @param value - Parsed response body
 * @param fields - Required top-level field names
 * @param context - Short endpoint/response label included in the error message
 * @returns value, typed as T, when it is an object and every required field is present
 * @throws ApiError when value is not an object or a required field is absent
 */
export function assertResponseShape<T>(
  value: unknown,
  fields: ReadonlyArray<keyof T & string>,
  context: string
): T {
  if (value === null || typeof value !== 'object') {
    throw new ApiError(
      versionSkewMessage(`${context}: expected an object from the server`),
      ExitCode.UNEXPECTED_ERROR
    );
  }
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    if (!(field in record)) {
      throw new ApiError(
        versionSkewMessage(`${context}: the server response is missing the "${field}" field`),
        ExitCode.UNEXPECTED_ERROR
      );
    }
  }
  return value as T;
}

/** Minimal shape of GET /api/app/update-check that the CLI relies on (Issue #1357). */
interface DaemonVersionInfo {
  currentVersion: string;
}

/**
 * Read the version the running daemon reports via GET /api/app/update-check.
 * Issue #1359 made that field a runtime package.json read, so it reflects the
 * daemon's actual running code rather than a build-time constant.
 *
 * Returns undefined when the endpoint is unreachable or omits currentVersion (an
 * older daemon predating the field) — callers treat that as "unknown", never as
 * an error. Never throws.
 */
export async function fetchDaemonVersion(client: ApiClient): Promise<string | undefined> {
  try {
    const info = await client.get<Partial<DaemonVersionInfo>>('/api/app/update-check');
    return typeof info?.currentVersion === 'string' && info.currentVersion.length > 0
      ? info.currentVersion
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compare this CLI's version against the running daemon's and print a stderr
 * warning when they differ (Issue #1357). Advisory only: never throws, and stays
 * silent when either version is unknown. Intended to run once per CLI invocation
 * that connects to the server, so a stale daemon serving an older API is called
 * out before its responses are misread.
 */
export async function warnIfVersionSkew(client: ApiClient): Promise<void> {
  const cliVersion = readPackageVersion();
  if (!cliVersion) return;
  const daemonVersion = await fetchDaemonVersion(client);
  if (!daemonVersion || daemonVersion === cliVersion) return;
  console.error(
    `Warning: this CLI is version ${cliVersion} but the running CommandMate server is version ${daemonVersion}. ` +
    `Restart the server to pick up the current version: commandmate stop && commandmate start`
  );
}
