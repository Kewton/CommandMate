/**
 * WebSocket upgrades obey the SAME ingress rule as `middleware.ts` (Issue #2489).
 *
 * ## Why this is driven through real sockets
 *
 * `commandmate remote --auth remote-only` exempts one listener from
 * authentication, and the phone drives the terminal over a WebSocket. If the
 * HTTP path and the WS path disagreed about which listener is exempt, the half
 * that is wrong is either a login screen nobody can get past or a live shell
 * handed to whoever has the tunnel URL. Neither is a failure a mocked
 * `request.headers` object can be trusted to show, because the thing under test
 * is precisely *what a client can put in those headers*.
 *
 * So this stands up two real `http.Server`s wired exactly as `server.ts` wires
 * them — a stamping `upgrade` listener registered BEFORE `setupWebSocket`, so
 * Node's registration order puts the stamp ahead of the auth check — and
 * connects a real `ws` client to each with forged headers. What it measures is
 * the real `stampIngress` and the real upgrade handler; the only thing it
 * reproduces rather than imports is `server.ts`'s call sites, which
 * `tests/integration/remote-ingress-auth-2489.test.ts` guards separately.
 *
 * @vitest-environment node
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { createHash } from 'crypto';
import { AddressInfo } from 'net';
import WebSocket from 'ws';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => null) }));
vi.mock('@/lib/tmux/tmux-control-mode-flags', () => ({
  isTmuxControlModeEnabled: () => false,
}));
vi.mock('@/lib/tmux/control-mode-tmux-transport', () => ({
  getControlModeTmuxTransport: () => ({
    subscribe: vi.fn(),
    sendInput: vi.fn(),
    resize: vi.fn(),
    getSubscriberCount: vi.fn(() => 0),
    captureSnapshot: vi.fn(),
  }),
}));

/** The plaintext a paired phone would hold, and the hash the server is given. */
const SESSION_TOKEN = 'ingress-2489-session-token';
const SESSION_TOKEN_HASH = createHash('sha256').update(SESSION_TOKEN).digest('hex');

/**
 * Headers a caller would forge to claim it is the machine's own browser.
 *
 * Every one of these is either set by the client or rewritten by a Provider, and
 * the last is the internal stamp itself — the whole point being that a listener
 * overwrites it rather than merging it.
 */
const FORGED_HEADERS: Record<string, string> = {
  'x-real-ip': '127.0.0.1',
  'x-forwarded-for': '127.0.0.1',
  'x-forwarded-host': 'localhost',
  'x-cm-ingress': 'local',
};

interface Harness {
  localPort: number;
  remotePort: number;
  close: () => Promise<void>;
}

/** Stand up the two listeners the way `server.ts` does, on ephemeral ports. */
async function startHarness(): Promise<Harness> {
  const { setupWebSocket, closeWebSocket, stampIngress } = await import('@/lib/ws-server');

  const local = createServer((_req, res) => res.end('ok'));
  const remote = createServer((_req, res) => res.end('ok'));

  // Registration order is the guarantee: the stamp has to be in place before
  // the auth check reads it.
  local.on('upgrade', (request) => stampIngress(request.headers, 'local'));
  remote.on('upgrade', (request) => stampIngress(request.headers, 'remote'));
  setupWebSocket(local, { additionalServers: [remote] });

  await Promise.all(
    [local, remote].map(
      (server: Server) =>
        new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    )
  );

  return {
    localPort: (local.address() as AddressInfo).port,
    remotePort: (remote.address() as AddressInfo).port,
    close: async () => {
      closeWebSocket();
      await Promise.all(
        [local, remote].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      );
    },
  };
}

/** What happened to one upgrade attempt. */
type UpgradeResult = { accepted: true } | { accepted: false; status: number };

function attemptUpgrade(port: number, headers: Record<string, string>): Promise<UpgradeResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
    let settled = false;
    const settle = (result: UpgradeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    ws.on('open', () => {
      settle({ accepted: true });
      ws.close();
    });
    // `ws` surfaces a rejected handshake as `unexpected-response` with the real
    // status line, which is the value this test is about (401 vs accepted).
    // Handling the event makes teardown ours: drain the body and drop the
    // request, since the socket is still CONNECTING and `close()`/`terminate()`
    // on that throws asynchronously into an unhandled error.
    ws.on('unexpected-response', (request, response) => {
      settle({ accepted: false, status: response.statusCode ?? 0 });
      response.resume();
      request.destroy();
    });
    // Left attached for the life of the socket, deliberately: `ws` reports a
    // torn-down handshake through `error`, and detaching the listener would turn
    // that into an uncaught exception in the runner.
    ws.on('error', () => settle({ accepted: false, status: 0 }));
    ws.on('close', () => settle({ accepted: false, status: 0 }));
  });
}

describe('WebSocket ingress auth (Issue #2489)', () => {
  let harness: Harness;

  beforeAll(async () => {
    // `src/lib/security/auth.ts` freezes the stored hash at module load, so the
    // environment has to be right before anything imports it.
    process.env.CM_AUTH_TOKEN_HASH = SESSION_TOKEN_HASH;
    delete process.env.CM_AUTH_EXPIRE;
    delete process.env.CM_ALLOWED_IPS;
    delete process.env.CM_TRUST_PROXY;
    vi.resetModules();
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
    delete process.env.CM_AUTH_TOKEN_HASH;
    delete process.env.CM_AUTH_SCOPE;
  });

  describe('CM_AUTH_SCOPE=remote-only', () => {
    beforeAll(() => {
      process.env.CM_AUTH_SCOPE = 'remote-only';
    });

    it('accepts an unauthenticated upgrade on the local listener', async () => {
      expect(await attemptUpgrade(harness.localPort, {})).toEqual({ accepted: true });
    });

    it('rejects an unauthenticated upgrade on the provider listener', async () => {
      expect(await attemptUpgrade(harness.remotePort, {})).toEqual({ accepted: false, status: 401 });
    });

    it('rejects a forged X-Real-IP / X-Forwarded-For / x-cm-ingress on the provider listener', async () => {
      // The acceptance condition of #2489, and the reason the decision is made
      // from the socket: a Provider's upstream IS 127.0.0.1, so every one of
      // these headers looks identical on a tunnelled request and a local one.
      // The listener overwrites `x-cm-ingress`, so the client's `local` is gone
      // by the time the auth check reads it.
      expect(await attemptUpgrade(harness.remotePort, FORGED_HEADERS)).toEqual({
        accepted: false,
        status: 401,
      });
    });

    it('accepts the provider listener once the phone has paired', async () => {
      expect(
        await attemptUpgrade(harness.remotePort, { cookie: `cm_auth_token=${SESSION_TOKEN}` })
      ).toEqual({ accepted: true });
    });

    it('rejects a wrong token on the provider listener', async () => {
      expect(
        await attemptUpgrade(harness.remotePort, { cookie: 'cm_auth_token=not-the-token' })
      ).toEqual({ accepted: false, status: 401 });
    });
  });

  describe('CM_AUTH_SCOPE=all (default)', () => {
    beforeAll(() => {
      process.env.CM_AUTH_SCOPE = 'all';
    });

    it('rejects an unauthenticated upgrade on the local listener too', async () => {
      // #1937's behaviour, unchanged. This is what `--auth all` and a plain
      // `commandmate start --auth` keep.
      expect(await attemptUpgrade(harness.localPort, {})).toEqual({ accepted: false, status: 401 });
    });

    it('ignores a forged x-cm-ingress on the local listener', async () => {
      expect(await attemptUpgrade(harness.localPort, FORGED_HEADERS)).toEqual({
        accepted: false,
        status: 401,
      });
    });
  });

  describe('CM_AUTH_SCOPE unset', () => {
    beforeAll(() => {
      delete process.env.CM_AUTH_SCOPE;
    });

    it('authenticates every listener', async () => {
      // Fail-closed: an absent scope is not "remote-only by default", it is the
      // pre-#2489 server.
      expect(await attemptUpgrade(harness.localPort, {})).toEqual({ accepted: false, status: 401 });
      expect(await attemptUpgrade(harness.remotePort, {})).toEqual({ accepted: false, status: 401 });
    });
  });
});

describe('isIngressAuthExempt (Issue #2489)', () => {
  it('is exempt only for the exact scope and the exact stamp', async () => {
    const { isIngressAuthExempt, CM_INGRESS_HEADER, REMOTE_ONLY_AUTH_SCOPE } = await import(
      '@/lib/ws-server'
    );
    const remoteOnly = { CM_AUTH_SCOPE: REMOTE_ONLY_AUTH_SCOPE };

    expect(isIngressAuthExempt({ [CM_INGRESS_HEADER]: 'local' }, remoteOnly)).toBe(true);
    expect(isIngressAuthExempt({ [CM_INGRESS_HEADER]: 'remote' }, remoteOnly)).toBe(false);
    // Unstamped: no listener this process built claimed it.
    expect(isIngressAuthExempt({}, remoteOnly)).toBe(false);
    // A repeated header arrives as a comma-joined string, and an array value is
    // what a hand-built request object can carry. Neither is `'local'`.
    expect(isIngressAuthExempt({ [CM_INGRESS_HEADER]: 'local, remote' }, remoteOnly)).toBe(false);
    expect(isIngressAuthExempt({ [CM_INGRESS_HEADER]: ['local'] }, remoteOnly)).toBe(false);
    expect(isIngressAuthExempt({ [CM_INGRESS_HEADER]: 'LOCAL' }, remoteOnly)).toBe(false);
    // Scope half.
    expect(isIngressAuthExempt({ [CM_INGRESS_HEADER]: 'local' }, { CM_AUTH_SCOPE: 'all' })).toBe(false);
    expect(isIngressAuthExempt({ [CM_INGRESS_HEADER]: 'local' }, {})).toBe(false);
    expect(isIngressAuthExempt({ [CM_INGRESS_HEADER]: 'local' }, { CM_AUTH_SCOPE: 'remote_only' })).toBe(
      false
    );
  });

  it('overwrites whatever the client sent', async () => {
    const { stampIngress, CM_INGRESS_HEADER } = await import('@/lib/ws-server');
    const headers: NodeJS.Dict<string | string[]> = { [CM_INGRESS_HEADER]: 'local' };

    stampIngress(headers, 'remote');

    expect(headers[CM_INGRESS_HEADER]).toBe('remote');
  });
});
