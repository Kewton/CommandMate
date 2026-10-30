/**
 * A faked server for the `--timeout` tests of Issue #3983: only `fetch` is
 * replaced, so a command runs its real action → helper → `ApiClient` path.
 *
 * Shared by `command-deadline-3983.test.ts` and the guard
 * `tests/unit/guards/cli-command-deadline-3983.test.ts`.
 */

import { vi } from 'vitest';

/**
 * `'hang'`, `'stall-body'`, a function of the request returning the body,
 * `{ status, data }`, `{ reject }`, `{ delayMs, data }` (`data` may be a function
 * of the request too), or any other object as the body of a 200.
 */
export type Route = 'hang' | 'stall-body' | ((url: URL, init: RequestInit | undefined) => unknown) | object;

export function json(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

/** Headers at once, then a body that never ends (and ignores the signal). */
function stalledBody(): Response {
  const never = () => new Promise<never>(() => {});
  return {
    ok: true,
    status: 200,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: never,
    text: never,
  } as unknown as Response;
}

function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
}

export const CAPABILITIES = { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] };

/** Does `key` (`METHOD path-part`, or a bare path part; `$` ends it) match the request? */
function matches(key: string, method: string, url: URL): boolean {
  const [m, part] = key.includes(' ') ? key.split(' ') : [undefined, key];
  if (m !== undefined && m !== method) return false;
  const target = url.pathname.concat(url.search);
  return part.endsWith('$') ? url.pathname.endsWith(part.slice(0, -1)) : target.includes(part);
}

/**
 * fetch routed by the first key the URL matches (`METHOD path-part`, or a bare
 * path part for any method; a trailing `$` matches the end of the path only).
 * Capabilities and resolve-target answer by default.
 */
export function mockServer(routes: Record<string, Route>): void {
  const table: Record<string, Route> = {
    '/api/capabilities': { status: 200, data: CAPABILITIES },
    '/resolve-target': (url) => ({
      cliToolId: 'claude',
      instanceId: url.searchParams.get('instance') ?? 'claude',
      resolvedBy: 'roster',
      conflict: null,
    }),
    ...routes,
  };
  // Own routes first, so a test can override the defaults above.
  const keys = [...Object.keys(routes), ...Object.keys(table).filter(k => !(k in routes))];
  global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = keys.find(k => matches(k, method, url));
    if (key === undefined) return Promise.resolve(json({ error: 'no route' }, 404));
    const route = table[key];
    if (route === 'hang') return hang(init);
    if (route === 'stall-body') return Promise.resolve(stalledBody());
    if (typeof route === 'function') return Promise.resolve(json(route(url, init)));
    const spec = route as { reject?: Error; delayMs?: number; status?: number; data?: unknown };
    if (spec.reject) return Promise.reject(spec.reject);
    if (typeof spec.delayMs === 'number') {
      const body = () => (typeof spec.data === 'function' ? spec.data(url, init) : spec.data);
      return new Promise(resolve => setTimeout(() => resolve(json(body())), spec.delayMs));
    }
    if (typeof spec.status === 'number') return Promise.resolve(json(spec.data, spec.status));
    // Anything else is the body of a 200.
    return Promise.resolve(json(route));
  }) as unknown as typeof fetch;
}

/** The requests made so far, as `METHOD path?query` with whether each carried a signal. */
export function requestsMade(): { request: string; signal: boolean }[] {
  return vi.mocked(global.fetch).mock.calls.map(([input, init]) => {
    const url = new URL(String(input));
    const options = init as RequestInit | undefined;
    return {
      request: `${options?.method ?? 'GET'} ${url.pathname}${url.search}`,
      signal: options?.signal instanceof AbortSignal,
    };
  });
}

export const calls = (method: string, part: string): number =>
  vi.mocked(global.fetch).mock.calls.filter(([input, init]) =>
    ((init as RequestInit | undefined)?.method ?? 'GET') === method && String(input).includes(part),
  ).length;

export const frame = {
  isRunning: true,
  isPromptWaiting: false,
  content: 'frame',
  fullOutput: 'frame',
  realtimeSnippet: 'frame',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId: 'claude',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
  sessionStatusReason: 'input_prompt',
};

export const verifyRun = (status: string) => ({
  run: {
    id: 7,
    worktreeId: 'wt1',
    instanceId: null,
    taskId: null,
    trigger: 'wait',
    status,
    startedAt: '2026-10-30T00:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-10-30T00:00:01.000Z',
    gates: [],
  },
});

/** A relay the server opened and bound (`POST /api/relays`). */
export const RELAY_CREATED = { relay: { id: 'relay-1', bindMode: 'bound' }, bindMode: 'bound' };

/** Runs a command and reports whether it has returned yet. */
export async function start(
  name: 'wait' | 'ask' | 'verify',
  args: string[],
): Promise<{ state: { done: boolean }; pending: Promise<void> }> {
  const mod =
    name === 'wait'
      ? (await import('../../../../src/cli/commands/wait')).createWaitCommand()
      : name === 'ask'
        ? (await import('../../../../src/cli/commands/ask')).createAskCommand()
        : (await import('../../../../src/cli/commands/verify')).createVerifyCommand();
  const state = { done: false };
  const pending = mod.parseAsync(['node', name, ...args]).then(() => {
    state.done = true;
  });
  return { state, pending };
}
