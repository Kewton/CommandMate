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
 * `fetch` is the only HTTP client in `src/` (no `http.request`, no `undici`
 * import). The hook relay (`scripts/hooks/cmate-agent-event.sh`) runs `curl`,
 * which no `fetch` wrapper sees; `tests/setup.ts` covers it through `CM_HOST`.
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

const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '[::1]', '[::]', '[::ffff:127.0.0.1]']);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host);
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

/**
 * `realFetch`, except that a request to a fenced port is refused unsent.
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
  const fenced: FencedFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = fencedTarget(input, ports);
    if (target !== undefined) {
      onRefused(target);
      return Promise.reject(connectionRefused(target));
    }
    return realFetch(input, init);
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
