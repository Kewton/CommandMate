/**
 * `gracefulShutdown` closes EVERY listener, and the exit waits for all of them
 * (Issue #2489).
 *
 * ## What was wrong
 *
 * The remote ingress listener `--auth remote-only` opens was not named anywhere
 * in `gracefulShutdown`. `server.close()`'s callback fires once the LOCAL
 * listener's connections have drained, and the `process.exit(0)` inside it then
 * cut off anything still in flight through the provider: the local listener had
 * three seconds of grace and the remote one had none. That asymmetry is on the
 * door the operator cannot see, which is exactly the kind that survives review.
 *
 * ## Why this file boots the real `server.ts`
 *
 * `gracefulShutdown` is a closure inside `app.prepare().then()`, so there is
 * nothing to import and call. The two `tests/unit/lib/startup-*.test.ts` suites
 * already solve that by importing `server.ts` with the process boundaries stubbed
 * and driving the real startup path, and this follows them — for the reason their
 * own headers give: a suite that re-composes the sequence by hand stays green
 * while the line it models sits somewhere else. Stubbed here: Next, `http`,
 * `https`, the WebSocket server, and the managers shutdown calls into. The
 * listener wiring and `gracefulShutdown` itself are real.
 *
 * It lives under `tests/integration/` rather than beside the unit suites because
 * booting a module that reads the environment, registers signal handlers and
 * opens listeners is not a unit of anything — and because that is the directory
 * this task's contract allows outright.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** One stand-in for `http.createServer()`, recording what shutdown does to it. */
interface FakeListener {
  listenArgs: { port: number; host: string } | null;
  closeCalls: number;
  /** Callbacks `close()` was given but that have not been invoked yet. */
  pendingCloseCallbacks: Array<() => void>;
  on: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => {
  const created: unknown[] = [];
  const makeFakeListener = (): unknown => {
    const listener = {
      listenArgs: null as { port: number; host: string } | null,
      closeCalls: 0,
      pendingCloseCallbacks: [] as Array<() => void>,
      on: vi.fn(() => listener),
      listen: vi.fn((port: number, host: string, _cb?: () => void) => {
        listener.listenArgs = { port, host };
        return listener;
      }),
      // Deliberately does NOT invoke the callback: "has close() been called"
      // and "has this listener finished draining" are the two facts these tests
      // have to separate, and a self-resolving stub would collapse them.
      close: vi.fn((cb?: () => void) => {
        listener.closeCalls += 1;
        if (cb) listener.pendingCloseCallbacks.push(cb);
        return listener;
      }),
    };
    created.push(listener);
    return listener;
  };
  return { created, makeFakeListener };
});

vi.mock('next', () => ({
  default: () => ({
    prepare: () => Promise.resolve(),
    getRequestHandler: () => async () => {},
  }),
}));
vi.mock('http', () => ({ createServer: () => h.makeFakeListener() }));
vi.mock('https', () => ({ createServer: () => h.makeFakeListener() }));
vi.mock('@/lib/ws-server', () => ({
  setupWebSocket: vi.fn(),
  closeWebSocket: vi.fn(),
  stampIngress: vi.fn(),
}));
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => ({}),
  closeDbInstance: vi.fn(),
}));
// Everything `gracefulShutdown` calls before it touches a listener. Stubbed so
// the teardown cannot reach real timers or a real tmux/poller state.
vi.mock('@/lib/polling/response-poller', () => ({ stopAllPolling: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({ stopAllAutoYesPolling: vi.fn() }));
vi.mock('@/lib/schedule-manager', () => ({
  initScheduleManager: vi.fn(),
  stopAllSchedules: vi.fn(),
}));
vi.mock('@/lib/timer-manager', () => ({ initTimerManager: vi.fn(), stopAllTimers: vi.fn() }));
vi.mock('@/lib/resource-cleanup', () => ({
  initResourceCleanup: vi.fn(),
  stopResourceCleanup: vi.fn(),
}));

const TOKEN_HASH = 'b'.repeat(64);
const MAIN_PORT = 51951;
const INGRESS_PORT = 51952;

/** One booted `server.ts`, with the SIGTERM handler it registered. */
interface Booted {
  listeners: FakeListener[];
  sigterm: () => void;
}

/**
 * Import a fresh `server.ts` under `env`, and take the SIGTERM handler off the
 * process again.
 *
 * The handler is captured by diffing `process.listeners('SIGTERM')` rather than
 * by emitting the signal: emitting it for real would also run Vitest's own
 * handler and tear the worker down. Removing it afterwards keeps each boot
 * independent and leaves nothing behind that a later real signal could fire.
 */
async function boot(env: Record<string, string | undefined>): Promise<Booted> {
  vi.resetModules();
  h.created.length = 0;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const before = new Set(process.listeners('SIGTERM'));
  await import('../../server');
  // `app.prepare()` resolves on the microtask queue; the listeners and the
  // signal handlers are registered in its `.then()`.
  await new Promise((resolve) => setImmediate(resolve));

  const added = process.listeners('SIGTERM').filter((listener) => !before.has(listener));
  // Non-vacuity: a boot that registered no handler would make every assertion
  // below unreachable rather than red.
  expect(added, 'server.ts registered no SIGTERM handler').toHaveLength(1);
  for (const listener of added) process.off('SIGTERM', listener);

  return {
    listeners: h.created as FakeListener[],
    sigterm: added[0] as () => void,
  };
}

describe('gracefulShutdown closes every listener (Issue #2489)', () => {
  const originalEnv = { ...process.env };
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // `gracefulShutdown` ends in `process.exit`, and it must not take the runner
    // with it. Returning rather than throwing keeps the code path after the call
    // observable, which is what the "waits for both" assertions need.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  afterAll(() => {
    vi.resetModules();
  });

  describe('--auth remote-only', () => {
    const REMOTE_ONLY_ENV = {
      CM_BIND: '127.0.0.1',
      CM_PORT: String(MAIN_PORT),
      CM_AUTH_TOKEN_HASH: TOKEN_HASH,
      CM_AUTH_SCOPE: 'remote-only',
      CM_REMOTE_INGRESS_PORT: String(INGRESS_PORT),
      CM_HTTPS_CERT: undefined,
      CM_HTTPS_KEY: undefined,
    };

    it('opens the two listeners this mode is made of', async () => {
      const { listeners } = await boot(REMOTE_ONLY_ENV);

      // The premise of every assertion below: there really are two doors, and
      // the second one is loopback-only on its own port.
      expect(listeners).toHaveLength(2);
      expect(listeners[0].listenArgs).toEqual({ port: MAIN_PORT, host: '127.0.0.1' });
      expect(listeners[1].listenArgs).toEqual({ port: INGRESS_PORT, host: '127.0.0.1' });
    });

    it('stops the remote listener accepting connections on SIGTERM', async () => {
      const { listeners, sigterm } = await boot(REMOTE_ONLY_ENV);
      const [local, remote] = listeners;
      expect(remote.closeCalls).toBe(0);

      sigterm();

      // The defect: `close()` was never called on the remote listener at all,
      // so the provider's door stayed open until the process died.
      expect(remote.closeCalls).toBe(1);
      expect(local.closeCalls).toBe(1);
    });

    it('waits for the remote listener to drain before exiting', async () => {
      const { listeners, sigterm } = await boot(REMOTE_ONLY_ENV);
      const [local, remote] = listeners;

      sigterm();

      // The local listener drains first, as it did before this change. The exit
      // must NOT happen here: a request still in flight through the provider is
      // exactly what used to be cut off at this moment.
      local.pendingCloseCallbacks.forEach((cb) => cb());
      expect(exitSpy).not.toHaveBeenCalled();

      remote.pendingCloseCallbacks.forEach((cb) => cb());
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('exits once when the remote listener drains first', async () => {
      // Order must not matter, and the counter must not let the exit fire twice.
      const { listeners, sigterm } = await boot(REMOTE_ONLY_ENV);
      const [local, remote] = listeners;

      sigterm();
      remote.pendingCloseCallbacks.forEach((cb) => cb());
      expect(exitSpy).not.toHaveBeenCalled();

      local.pendingCloseCallbacks.forEach((cb) => cb());
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('--auth all (default) is unchanged', () => {
    it('opens one listener and exits when it drains', async () => {
      const { listeners, sigterm } = await boot({
        CM_BIND: '127.0.0.1',
        CM_PORT: String(MAIN_PORT),
        CM_AUTH_TOKEN_HASH: TOKEN_HASH,
        CM_AUTH_SCOPE: undefined,
        CM_REMOTE_INGRESS_PORT: undefined,
        CM_HTTPS_CERT: undefined,
        CM_HTTPS_KEY: undefined,
      });

      expect(listeners).toHaveLength(1);

      sigterm();
      expect(listeners[0].closeCalls).toBe(1);
      // Nothing waits on a listener that does not exist.
      expect(exitSpy).not.toHaveBeenCalled();

      listeners[0].pendingCloseCallbacks.forEach((cb) => cb());
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('opens one listener when remote-only is refused for a LAN bind', async () => {
      // The fail-closed path: no second door is opened, so shutdown has one
      // listener to close and the exit does not wait for a phantom.
      const { listeners, sigterm } = await boot({
        CM_BIND: '0.0.0.0',
        CM_PORT: String(MAIN_PORT),
        CM_AUTH_TOKEN_HASH: TOKEN_HASH,
        CM_AUTH_SCOPE: 'remote-only',
        CM_REMOTE_INGRESS_PORT: String(INGRESS_PORT),
        CM_HTTPS_CERT: undefined,
        CM_HTTPS_KEY: undefined,
      });

      expect(listeners).toHaveLength(1);
      expect(process.env.CM_AUTH_SCOPE).toBe('all');

      sigterm();
      listeners[0].pendingCloseCallbacks.forEach((cb) => cb());
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });
});
