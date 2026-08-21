/**
 * Server capability probe (Issue #1925, design §4 D5 決定 1 / §10.6 / DR4-007).
 *
 * The CLI is routinely newer than the server it talks to: `npm i -g commandmate`
 * replaces the CLI without restarting a running daemon, and `api-responses.ts`
 * says so in two places. So a CLI that starts depending on a new endpoint has to
 * find out whether the server has it — and it cannot find that out from the
 * endpoint's own 404, because Next.js answers an unimplemented App Router path
 * with a bare 404 that is indistinguishable from "that worktree does not exist".
 *
 * The rule this module exists to enforce is the one that is easy to get wrong:
 * **anything other than a real 404 is not permission to resolve locally.** The
 * local path is a degraded resolver (design §4 D5 決定 1: it has no
 * primary-anchor stage), so quietly falling back on a 302-to-/login or on an
 * HTML error page from a reverse proxy would change where `send` and `respond`
 * land — and would do it precisely when something in the middle of the
 * connection is behaving unexpectedly. Those cases end the command instead.
 */

import { ExitCode } from '../types';
import { ApiError, handleApiError, type ApiClient } from './api-client';

/** Path of the capability endpoint (`src/app/api/capabilities/route.ts`). */
export const CAPABILITIES_PATH = '/api/capabilities';

/**
 * Capability token declared by a server that can resolve session targets.
 * Mirrors SERVER_CAPABILITIES in the route; the CLI keeps its own copy of API
 * constants (see api-responses.ts) rather than importing across the boundary.
 */
export const RESOLVE_SESSION_TARGET_CAPABILITY = 'resolve-session-target';

/** Outcome of the probe. Auth failures and undeterminable servers throw instead. */
export type ServerCapabilityProbe =
  | { kind: 'supported'; serverVersion: string; capabilities: string[] }
  /** A real 404: this server predates `/api/capabilities`. */
  | { kind: 'legacy' };

/**
 * Message for the responses that are neither "new server" nor "old server".
 * Names the two things that actually produce them, because the operator's next
 * move differs: authenticate, or stop routing the CLI through the proxy.
 */
const UNDETERMINED_MESSAGE =
  'Could not determine the CommandMate server capabilities: the response to '
  + `GET ${CAPABILITIES_PATH} was not JSON. This usually means the request was not `
  + 'authenticated (set CM_AUTH_TOKEN) or that something between the CLI and the '
  + 'server answered instead of it. Refusing to guess which agent to target.';

/**
 * Memo, keyed by the client rather than by the module.
 *
 * Design §4 D5 asks for one probe per process, and a command builds one
 * ApiClient and resolves every target through it, so per-client is per-process
 * in practice. Keying it this way keeps the answer out of module scope, where
 * it would leak between the many "processes" a test run packs into one — and a
 * probe count that depends on which test ran first is not a thing worth
 * debugging later.
 */
let probes = new WeakMap<ApiClient, Promise<ServerCapabilityProbe>>();

/**
 * Ask the server what it supports, once per client.
 *
 * @param client - API client aimed at the server
 * @returns Whether the server has the capability endpoint at all
 * @throws ApiError on 401/403, and on any response that cannot be classified
 */
export function probeServerCapabilities(client: ApiClient): Promise<ServerCapabilityProbe> {
  const existing = probes.get(client);
  if (existing) return existing;

  const probe = runProbe(client).catch((error: unknown) => {
    // A failed probe is not a fact about the server worth remembering: the
    // command is about to end anyway, and a cached rejection would outlive the
    // reason for it.
    probes.delete(client);
    throw error;
  });
  probes.set(client, probe);
  return probe;
}

/** Drop every memo. Exists for tests that reuse one client across scenarios. */
export function resetServerCapabilityProbe(): void {
  probes = new WeakMap<ApiClient, Promise<ServerCapabilityProbe>>();
}

function undetermined(status?: number): ApiError {
  return new ApiError(UNDETERMINED_MESSAGE, ExitCode.CONFIG_ERROR, status);
}

/**
 * A 404 counts as "old server" only when the body is what a 404 from this app
 * looks like: nothing, or JSON. An HTML 404 came from something else.
 */
function isRealNotFoundBody(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

async function runProbe(client: ApiClient): Promise<ServerCapabilityProbe> {
  let response: Response;
  try {
    response = await client.rawGet(CAPABILITIES_PATH, { headers: { Accept: 'application/json' } });
  } catch (error) {
    const result = handleApiError(error);
    throw new ApiError(result.message, result.exitCode);
  }

  // Authentication failed. The server is fine; the request was not allowed to
  // see the answer, and "not allowed" is not "old".
  if (response.status === 401 || response.status === 403) {
    const result = handleApiError(null, response.status);
    throw new ApiError(result.message, result.exitCode, response.status);
  }

  // A redirect means middleware sent an unauthenticated browser-shaped request
  // to /login. `/login` is in AUTH_EXCLUDED_PATHS, so following it would land on
  // a 200 whose body is HTML — which is why the request was issued with
  // `redirect: 'manual'` and why a 3xx ends the command here.
  if ((response.status >= 300 && response.status < 400) || response.redirected) {
    throw undetermined(response.status);
  }

  if (response.status === 404) {
    const text = await response.text().catch(() => '');
    if (isRealNotFoundBody(text)) return { kind: 'legacy' };
    throw undetermined(response.status);
  }

  if (!response.ok) {
    const result = handleApiError(null, response.status);
    throw new ApiError(result.message, result.exitCode, response.status);
  }

  const contentType = response.headers?.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw undetermined(response.status);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw undetermined(response.status);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw undetermined(response.status);
  }
  const record = parsed as { serverVersion?: unknown; capabilities?: unknown };
  if (!Array.isArray(record.capabilities)) {
    throw undetermined(response.status);
  }

  return {
    kind: 'supported',
    serverVersion: typeof record.serverVersion === 'string' ? record.serverVersion : '',
    capabilities: record.capabilities.filter((entry): entry is string => typeof entry === 'string'),
  };
}

/**
 * Whether this server can resolve session targets for the CLI.
 *
 * @param client - API client aimed at the server
 * @returns true when the server declares {@link RESOLVE_SESSION_TARGET_CAPABILITY}
 * @throws ApiError on 401/403 and on an unclassifiable response
 */
export async function serverResolvesSessionTargets(client: ApiClient): Promise<boolean> {
  const probe = await probeServerCapabilities(client);
  return probe.kind === 'supported'
    && probe.capabilities.includes(RESOLVE_SESSION_TARGET_CAPABILITY);
}
