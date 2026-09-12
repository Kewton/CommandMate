/**
 * The two halves of the `--auth remote-only` decision agree, and `server.ts`
 * really stamps every listener (Issue #2489).
 *
 * ## Why this file exists next to the two unit suites
 *
 * `tests/unit/middleware-ingress-2489.test.ts` and
 * `tests/unit/lib/ws-server-ingress-2489.test.ts` each prove one side. Two
 * things are left over, and both are the kind of gap that fails OPEN:
 *
 *  1. **The two implementations are separate copies.** `middleware.ts` runs on
 *     the Edge runtime and cannot import `src/lib/ws-server.ts` (`http`, `net`,
 *     `ws`, SQLite), so the predicate is written twice — the same C001
 *     constraint that already duplicates the auth constants. A drift between
 *     them means HTTP and WebSocket disagree about which listener is exempt, and
 *     a phone drives the terminal over the WebSocket. The matrix below runs the
 *     same inputs through both and requires the same verdict.
 *  2. **Nothing can import `server.ts`.** It calls `app.prepare()` at module
 *     scope, so "every listener is built through the stamping factory" cannot be
 *     asserted by running it. It is asserted over its source instead, the way
 *     `tests/unit/config/remote-destructive-command-guard.test.ts` guards
 *     `src/lib/remote/**`. A listener wired up any other way would leave the
 *     caller's own `x-cm-ingress` in place — the single way this scheme can be
 *     bypassed.
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const SERVER_TS = readFileSync(join(process.cwd(), 'server.ts'), 'utf8');

const mockNextResponseNext = vi.fn().mockReturnValue({ type: 'next' });
vi.mock('next/server', () => ({
  NextResponse: class {
    status: number;
    constructor(_body?: unknown, init?: { status?: number }) {
      this.status = init?.status ?? 200;
    }
    static next = () => mockNextResponseNext();
    static json = (body: unknown, init?: { status?: number }) => ({
      type: 'json',
      body,
      status: init?.status,
    });
    static redirect = (url: URL) => ({ type: 'redirect', url: url.toString() });
  },
}));
vi.mock('@/lib/security/ip-restriction', () => ({
  isIpRestrictionEnabled: () => false,
  getAllowedRanges: () => [],
  isIpAllowed: () => true,
  getClientIp: () => '127.0.0.1',
  normalizeIp: (ip: string) => ip,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => null) }));
vi.mock('@/lib/tmux/tmux-control-mode-flags', () => ({ isTmuxControlModeEnabled: () => false }));
vi.mock('@/lib/tmux/control-mode-tmux-transport', () => ({
  getControlModeTmuxTransport: () => ({
    subscribe: vi.fn(),
    sendInput: vi.fn(),
    resize: vi.fn(),
    getSubscriberCount: vi.fn(() => 0),
    captureSnapshot: vi.fn(),
  }),
}));

const TOKEN_HASH = createHash('sha256').update('agreement-2489').digest('hex');

/** Every combination the two copies have to answer identically. */
const MATRIX: readonly { scope: string | undefined; stamp: string | undefined }[] = [
  { scope: 'remote-only', stamp: 'local' },
  { scope: 'remote-only', stamp: 'remote' },
  { scope: 'remote-only', stamp: undefined },
  { scope: 'remote-only', stamp: 'LOCAL' },
  { scope: 'remote-only', stamp: 'local, remote' },
  { scope: 'remote-only', stamp: '' },
  { scope: 'all', stamp: 'local' },
  { scope: 'all', stamp: 'remote' },
  { scope: undefined, stamp: 'local' },
  { scope: 'remote_only', stamp: 'local' },
  { scope: 'Remote-Only', stamp: 'local' },
];

describe('ingress decision: the Edge copy and the Node copy agree (Issue #2489)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = TOKEN_HASH;
    delete process.env.CM_AUTH_EXPIRE;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it.each(MATRIX)('scope=$scope stamp=$stamp', async ({ scope, stamp }) => {
    if (scope === undefined) delete process.env.CM_AUTH_SCOPE;
    else process.env.CM_AUTH_SCOPE = scope;

    const headers: Record<string, string> = {};
    if (stamp !== undefined) headers['x-cm-ingress'] = stamp;

    // Node side: the predicate `ws-server.ts` applies on upgrade.
    const { isIngressAuthExempt } = await import('@/lib/ws-server');
    const nodeVerdict = isIngressAuthExempt(headers);

    // Edge side: an unauthenticated request with no cookie and no Bearer token
    // is let through only when middleware considers it exempt.
    const { middleware } = await import('@/middleware');
    const response = (await middleware({
      nextUrl: { pathname: '/', clone: () => new URL('http://localhost:3000/') },
      url: 'http://localhost:3000/',
      cookies: { get: () => undefined },
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    } as never)) as { type?: string };
    const edgeVerdict = response.type === 'next';

    expect(edgeVerdict).toBe(nodeVerdict);
  });
});

describe('server.ts stamps every listener it builds (Issue #2489)', () => {
  /** Lines that construct an HTTP(S) server, with their 1-based line numbers. */
  const listenerLines = SERVER_TS.split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => /create(Http|Https)Server\(/.test(text));

  it('builds every listener through the stamping factory', () => {
    // Non-vacuity: there are listeners to check at all.
    expect(listenerLines.length).toBeGreaterThan(0);
    for (const { line, text } of listenerLines) {
      expect(
        text.includes('requestHandlerFor('),
        `server.ts:${line} creates a listener without requestHandlerFor(): ${text.trim()}`
      ).toBe(true);
    }
  });

  it('stamps HTTP requests inside that factory', () => {
    expect(SERVER_TS).toContain('stampIngress(req.headers, ingress)');
  });

  it('stamps upgrades on both listeners', () => {
    // HTTP and WS have to agree, and the upgrade event does not go through the
    // request handler — so it needs its own stamp, on each listener.
    expect(SERVER_TS).toContain("stampIngress(request.headers, 'local')");
    expect(SERVER_TS).toContain("stampIngress(request.headers, 'remote')");
  });

  it('never reads the header it stamps', () => {
    // `server.ts` is the writer. A read here would mean some decision in the
    // server was being made from a value a client might still own.
    expect(SERVER_TS).not.toContain("'x-cm-ingress'");
    expect(SERVER_TS).not.toContain('"x-cm-ingress"');
  });

  it('binds the remote listener to loopback, not to CM_BIND', () => {
    // `remote-only` is refused for a non-loopback CM_BIND, but the provider
    // listener must be loopback-only regardless of how that check evolves.
    expect(SERVER_TS).toContain("const REMOTE_INGRESS_BIND = '127.0.0.1'");
    expect(SERVER_TS).toContain('remoteServer.listen(remoteIngressPort, REMOTE_INGRESS_BIND');
  });

  it('opens the second listener only for the remote-only scope', () => {
    expect(SERVER_TS).toContain(
      "const remoteServer = remoteIngressPort === null ? null : createListener('remote')"
    );
    expect(SERVER_TS).toContain(
      'if (process.env.CM_AUTH_SCOPE !== REMOTE_ONLY_AUTH_SCOPE) return null;'
    );
  });

  it('spells the scope exactly as ws-server.ts exports it', async () => {
    // server.ts reads CM_AUTH_SCOPE at module scope and cannot import the
    // constant there, so the literal is duplicated. A rename that touched only
    // one of the two would leave a server that opens a listener nothing exempts.
    const { REMOTE_ONLY_AUTH_SCOPE } = await import('@/lib/ws-server');
    expect(SERVER_TS).toContain(`const REMOTE_ONLY_AUTH_SCOPE = '${REMOTE_ONLY_AUTH_SCOPE}'`);
  });

  it('withdraws the exemption in process.env when it refuses the scope', () => {
    // A degradation kept in a local variable would leave middleware and
    // ws-server still reading `remote-only` per request.
    expect(SERVER_TS).toContain("process.env.CM_AUTH_SCOPE = 'all';");
  });
});
