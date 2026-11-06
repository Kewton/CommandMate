/**
 * Keep the unit suite's HTTP off the CommandMate server running on this machine
 * (Issue #4176).
 *
 * ## Why a fence and not a value
 *
 * A worker's tmux pane inherits the server's environment, `CM_PORT=3000`
 * included. Removing that value does not move anything: every reader falls back
 * to port 3000 (`resolveServerEndpoint`, `getServerPort`, the hook relay), which
 * is the same server. Pointing `CM_PORT` somewhere else would move it, but the
 * suite has tests that assert the 3000 default without setting the variable
 * (`tests/unit/cli/commands/stop.test.ts`), and CI runs with nothing set. And a
 * fake `CM_AUTH_TOKEN` stops nothing: the local server usually has no auth.
 *
 * So `tests/setup.ts` leaves the defaults as CI has them and puts this in front
 * of `fetch` instead: a request to a loopback address on a fenced port (the
 * default 3000 and whatever `CM_PORT` / `MCBD_PORT` the suite was started with)
 * fails the way a closed port does on CI, before anything is sent. A test that
 * stubs `fetch` replaces the fence and is unaffected; a test that talks to a
 * server of its own listens on an ephemeral port and is unaffected.
 *
 * A request the fence lets through may still be answered with a redirect to a
 * fenced port. So a `redirect: 'follow'` request (the default) is followed here,
 * one hop at a time, and each `Location` is judged before it is requested;
 * `'manual'` and `'error'` go to the real `fetch` untouched.
 *
 * ## What the fence does not see
 *
 * Only `fetch`. These other clients in `src/` bypass it, and none reaches the
 * real server from the unit suite today for the reason given (checked for
 * #4176; a new caller has to keep it true):
 *
 * - `src/cli/utils/server-identity.ts` (`http.request` / `https.request`): the
 *   only unit test that runs it unmocked, `remote-publish-guard-3087.test.ts`,
 *   points it at servers it listens on with port 0; `remote.test.ts` and
 *   `remote-launch-env-1937.test.ts` mock the module.
 * - `src/lib/server/localhost-self-check.ts` (`http.request` /
 *   `https.request`): `localhost-self-check-2113.test.ts` probes its own
 *   port-0 servers (and port 1 with a server that throws before sending), and
 *   gives `runLocalhostSelfCheck` a stub `probe`; the two tests that run
 *   `server.ts`'s startup mock `http` / `https` without `request`.
 * - `src/lib/remote/cloudflare.ts` (`http.get` to the cloudflared metrics
 *   port): every unit test injects `fetchHostname`, and the port is a free one
 *   `findFreePort` picked, never 3000.
 * - `src/cli/utils/server-ready.ts` (`net.connect`, a TCP connect with no
 *   payload): the tests that reach it unmocked (`daemon-process-group-3087`)
 *   use a free port; the others mock `server-ready` or `DaemonManager`.
 * - The hook relay (`scripts/hooks/cmate-agent-event.sh`) runs `curl`;
 *   `tests/setup.ts` covers it through `CM_HOST`.
 *
 * With `CM_PORT` removed, the CLI's `ApiClient` takes its port from `.env`
 * (`loadClientEnv`: `<cwd>/.env`, or `~/.commandmate/.env` for a global
 * install), so the ports those files name are fenced as well. They are only
 * read.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';

/** The port every reader falls back to when `CM_PORT` is unset. */
export const DEFAULT_SERVER_PORT = 3000;

/**
 * The host `tests/setup.ts` gives the hook relay: `.invalid` never resolves
 * (RFC 6761), so a relay started from the suite with the real `curl` fails at
 * name resolution instead of posting to `127.0.0.1:<CM_PORT>`.
 */
export const TEST_HOOK_HOST = 'commandmate-test-no-server.invalid';

/** Marks a fetch this module wrapped, so a second setup run does not wrap it again. */
const FENCED = Symbol.for('commandmate.test.realServerFence');

/** Where the ports of the first setup run in this worker are kept. */
const FENCED_PORTS = Symbol.for('commandmate.test.realServerFencePorts');

type FencedFetch = typeof fetch & { [FENCED]?: true };

/** A record of one refused request. */
export interface RefusedRequest {
  url: string;
  port: number;
}

/**
 * The ports to fence for an environment the suite was started with.
 *
 * @param envs - The environment before `tests/setup.ts` removes anything, and
 *   the `.env` files a client would read
 * @returns 3000, plus each valid `CM_PORT` / `MCBD_PORT` any of them names
 */
export function fencedPortsFor(...envs: ReadonlyArray<Readonly<Record<string, string | undefined>>>): number[] {
  const ports = new Set<number>([DEFAULT_SERVER_PORT]);
  for (const env of envs) {
    for (const key of ['CM_PORT', 'MCBD_PORT']) {
      const port = Number.parseInt((env[key] ?? '').trim(), 10);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * What the `.env` files at `paths` say, read-only; a missing or unreadable file
 * says nothing.
 */
export function readEnvFiles(paths: readonly string[]): Array<Record<string, string>> {
  const parsed: Array<Record<string, string>> = [];
  for (const path of paths) {
    try {
      if (existsSync(path)) parsed.push(parseDotenv(readFileSync(path, 'utf8')));
    } catch {
      // Unreadable: the client would not get a port from it either.
    }
  }
  return parsed;
}

/**
 * Whether `hostname` (as `new URL()` leaves it: lower-cased, IPv4 in dotted
 * quads whatever form it was written in, IPv6 bracketed and compressed) names
 * this machine.
 *
 * Covers `localhost` and `*.localhost` (with or without the trailing dot),
 * 127.0.0.0/8, `0.0.0.0`, `[::1]`, `[::]`, and IPv4-mapped / IPv4-compatible
 * IPv6 forms of those (`[::ffff:127.0.0.1]` parses to `[::ffff:7f00:1]`).
 */
export function isLoopbackHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.startsWith('[') && host.endsWith(']')) return isLoopbackIpv6(host.slice(1, -1));
  return isLoopbackIpv4(host);
}

function isLoopbackIpv4(host: string): boolean {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets === null) return false;
  return octets[1] === '127' || host === '0.0.0.0';
}

function isLoopbackIpv6(address: string): boolean {
  if (address === '::1' || address === '::') return true;
  // `::ffff:a.b.c.d` (mapped) and `::a.b.c.d` (compatible) both serialize the
  // IPv4 part as two hex groups.
  const embedded = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (embedded === null) return false;
  const high = Number.parseInt(embedded[1], 16);
  const low = Number.parseInt(embedded[2], 16);
  return high >> 8 === 127 || (high === 0 && low === 0);
}

function urlOf(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input !== null && typeof input === 'object' && typeof (input as { url?: unknown }).url === 'string') {
    return (input as { url: string }).url;
  }
  return undefined;
}

/**
 * The fenced port `input` would reach, or undefined when the request may go.
 *
 * Only absolute `http:` / `https:` URLs to a loopback host are judged; anything
 * else (a relative URL, another host) is left to the real `fetch`.
 */
export function fencedTarget(input: unknown, ports: readonly number[]): RefusedRequest | undefined {
  const raw = urlOf(input);
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (!isLoopbackHost(url.hostname)) return undefined;
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  return ports.includes(port) ? { url: url.href, port } : undefined;
}

/** The error undici gives for a closed port, so callers classify it as they do on CI. */
function connectionRefused(target: RefusedRequest): TypeError {
  const cause = Object.assign(
    new Error(`connect ECONNREFUSED 127.0.0.1:${target.port} (refused by tests/helpers/real-server-fence.ts, #4176)`),
    { code: 'ECONNREFUSED', errno: -61, syscall: 'connect', address: '127.0.0.1', port: target.port }
  );
  return new TypeError('fetch failed', { cause });
}

/** The statuses `fetch` follows; the same list undici uses. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** undici's limit before it fails a redirect chain. */
export const MAX_REDIRECTS = 20;

/** The headers the Fetch standard drops when a redirect changes method to GET. */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location'];

/** The headers the Fetch standard drops when a redirect leaves the origin. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/** A `Request`-shaped input, without depending on the `Request` global (tests stub it). */
interface RequestLike {
  url: string;
  method?: string;
  headers?: HeadersInit;
  redirect?: RequestRedirect;
  signal?: AbortSignal | null;
  body?: unknown;
}

function requestLike(input: FetchInput): RequestLike | undefined {
  if (typeof input === 'string' || input instanceof URL) return undefined;
  return input as unknown as RequestLike;
}

/** The redirect mode a call asked for: `init` wins over the `Request`, as in `fetch`. */
export function redirectModeOf(input: FetchInput, init?: FetchInit): RequestRedirect {
  return init?.redirect ?? requestLike(input)?.redirect ?? 'follow';
}

function fetchFailed(message: string): TypeError {
  return new TypeError('fetch failed', { cause: new Error(message) });
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or errored: nothing left to release.
  }
}

/**
 * A `redirect: 'follow'` request, followed one hop at a time so that every
 * `Location` is judged by {@link fencedTarget} before it is requested.
 *
 * Follows the Fetch standard where it matters to callers: 303 (and 301 / 302
 * after a POST) turn into a bodiless GET, 307 / 308 keep method and body (and
 * fail when the body was a stream, which cannot be sent twice), credentials are
 * dropped on a change of origin, and more than {@link MAX_REDIRECTS} hops fail.
 * `response.redirected` is set on the result when a hop was followed.
 */
async function followInsideFence(
  realFetch: typeof fetch,
  input: FetchInput,
  init: FetchInit | undefined,
  ports: readonly number[],
  onRefused: (request: RefusedRequest) => void
): Promise<Response> {
  const original = requestLike(input);
  let response = await realFetch(input, { ...init, redirect: 'manual' });

  let current = urlOf(input);
  let method = (init?.method ?? original?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? original?.headers ?? undefined);
  let body: unknown = init?.body ?? original?.body ?? undefined;
  const signal = init?.signal ?? original?.signal ?? undefined;

  for (let hops = 0; ; hops += 1) {
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null || current === undefined) {
      // Each hop was its own call, so the real flag is false; callers read it
      // (`api-client.ts`, `send-new-task.ts`, `server-capabilities.ts`).
      if (hops > 0) Object.defineProperty(response, 'redirected', { value: true });
      return response;
    }
    await discard(response);
    if (hops >= MAX_REDIRECTS) throw fetchFailed('redirect count exceeded');

    let next: URL;
    try {
      next = new URL(location, response.url || current);
    } catch {
      throw fetchFailed(`invalid redirect location: ${location}`);
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw fetchFailed('URL scheme must be a HTTP(S) scheme');

    const target = fencedTarget(next.href, ports);
    if (target !== undefined) {
      onRefused(target);
      throw connectionRefused(target);
    }

    const status = response.status;
    if ((status === 303 && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      for (const name of BODY_HEADERS) headers.delete(name);
    } else if (body !== undefined && body !== null && typeof (body as ReadableStream).getReader === 'function') {
      throw fetchFailed('cannot follow a redirect with a streamed body');
    }
    if (new URL(current).origin !== next.origin) {
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    }

    current = next.href;
    response = await realFetch(current, {
      ...init,
      method,
      headers,
      body: body as FetchInit['body'],
      signal,
      redirect: 'manual',
    });
  }
}

/**
 * `realFetch`, except that a request to a fenced port is refused unsent, and so
 * is a redirect to one.
 *
 * @param realFetch - The fetch to call for everything else
 * @param ports - Fenced ports, from {@link fencedPortsFor}
 * @param onRefused - Told about each refused request
 */
export function fenceFetch(
  realFetch: typeof fetch,
  ports: readonly number[],
  onRefused: (request: RefusedRequest) => void = () => {}
): typeof fetch {
  const fenced: FencedFetch = ((input: FetchInput, init?: FetchInit) => {
    const target = fencedTarget(input, ports);
    if (target !== undefined) {
      onRefused(target);
      return Promise.reject(connectionRefused(target));
    }
    if (redirectModeOf(input, init) !== 'follow') return realFetch(input, init);
    return followInsideFence(realFetch, input, init, ports, onRefused);
  }) as FencedFetch;
  fenced[FENCED] = true;
  return fenced;
}

/** True when `fn` is a fetch {@link fenceFetch} returned. */
export function isFencedFetch(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as FencedFetch)[FENCED] === true;
}

/**
 * Put the fence in front of `globalThis.fetch`, once per worker.
 *
 * The ports are read from `env` on the first call in a worker and kept: later
 * test files in the same worker see the environment after `tests/setup.ts`
 * removed `CM_PORT`, and must still fence the port the suite was started with.
 *
 * @param env - The environment before `tests/setup.ts` removes anything
 * @param envFiles - The `.env` files a client would read
 * @param where - Names the test that made a refused request, for the warning
 * @param target - The global to install on
 * @returns The fenced ports
 */
export function installRealServerFence(
  env: Readonly<Record<string, string | undefined>>,
  envFiles: readonly string[] = [],
  where: () => string = () => '',
  target: { fetch?: typeof fetch } & Record<symbol, unknown> = globalThis as unknown as {
    fetch?: typeof fetch;
  } & Record<symbol, unknown>
): number[] {
  let ports = target[FENCED_PORTS] as number[] | undefined;
  if (ports === undefined) {
    ports = fencedPortsFor(env, ...readEnvFiles(envFiles));
    target[FENCED_PORTS] = ports;
  }
  const current = target.fetch;
  if (typeof current === 'function' && !isFencedFetch(current)) {
    target.fetch = fenceFetch(current, ports, (request) => {
      const test = where();
      process.stderr.write(
        `[tests/setup] refused a request to ${request.url}: port ${request.port} is the real server's (#4176)` +
          `${test ? ` — ${test}` : ''}\n`
      );
    });
  }
  return ports;
}
