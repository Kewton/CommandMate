/**
 * `middleware.ts` decides authentication from the listener, never from the
 * address or a caller-set header (Issue #2489).
 *
 * ## What is at stake
 *
 * `commandmate remote --auth remote-only` has to tell "the browser on this
 * machine" from "the phone on the other side of a Tailscale Serve / Cloudflare
 * Quick Tunnel". Every obvious signal fails here, and fails OPEN:
 *
 *  - `req.socket.remoteAddress` and the `X-Real-IP` that `server.ts` derives
 *    from it are `127.0.0.1` for BOTH, because a Provider's upstream is
 *    `http://127.0.0.1:<port>`.
 *  - `Host` / `X-Forwarded-*` are set by the caller, and a Provider was measured
 *    rewriting `Host` to the upstream's own (`docs/qa/1937-remote-uat-record.md`
 *    D-2).
 *
 * So the answer comes from which socket the request landed on, stamped by
 * `server.ts` into `x-cm-ingress` over whatever the client sent. The tests below
 * hand middleware every forgery at once and require it to keep asking for a
 * token; `tests/unit/lib/ws-server-ingress-2489.test.ts` proves the stamping
 * itself over real sockets.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

const mockNextResponseNext = vi.fn().mockReturnValue({ type: 'next' });
const mockNextResponseJson = vi
  .fn()
  .mockImplementation((body: unknown, init?: { status?: number }) => ({
    type: 'json',
    body,
    status: init?.status,
  }));
const mockNextResponseRedirect = vi.fn().mockImplementation((url: URL) => ({
  type: 'redirect',
  url: url.toString(),
}));

vi.mock('next/server', () => ({
  NextResponse: class {
    status: number;
    constructor(_body?: unknown, init?: { status?: number }) {
      this.status = init?.status ?? 200;
    }
    static next = () => mockNextResponseNext();
    static json = (body: unknown, init?: { status?: number }) => mockNextResponseJson(body, init);
    static redirect = (url: URL) => mockNextResponseRedirect(url);
  },
}));

const ipRestrictionState = { enabled: false, allowed: true };
vi.mock('../../src/lib/security/ip-restriction', () => ({
  isIpRestrictionEnabled: () => ipRestrictionState.enabled,
  getAllowedRanges: () => [],
  isIpAllowed: () => ipRestrictionState.allowed,
  getClientIp: () => '127.0.0.1',
  normalizeIp: (ip: string) => ip,
}));

const SESSION_TOKEN = 'ingress-2489-middleware-token';
const SESSION_TOKEN_HASH = createHash('sha256').update(SESSION_TOKEN).digest('hex');

/** Everything a caller could set to claim it is the machine's own browser. */
const FORGERIES: Record<string, string> = {
  'x-real-ip': '127.0.0.1',
  'x-forwarded-for': '127.0.0.1',
  'x-forwarded-host': 'localhost',
  host: 'localhost:3000',
  'x-cm-ingress': 'local',
};

interface RequestSpec {
  pathname?: string;
  /** What the LISTENER stamped. Omitted means nothing stamped it. */
  ingress?: 'local' | 'remote';
  cookie?: string;
  authHeader?: string;
  upgrade?: boolean;
  /** Header values the client sent, applied UNDER the stamp. */
  clientHeaders?: Record<string, string>;
}

function createRequest(spec: RequestSpec = {}) {
  const { pathname = '/api/worktrees' } = spec;
  // The stamp is applied last, exactly as `server.ts` applies it: the client's
  // own `x-cm-ingress` is overwritten rather than merged.
  const headers: Record<string, string> = { ...(spec.clientHeaders ?? {}) };
  if (spec.upgrade) headers.upgrade = 'websocket';
  if (spec.authHeader) headers.authorization = spec.authHeader;
  if (spec.ingress !== undefined) headers['x-cm-ingress'] = spec.ingress;

  return {
    nextUrl: { pathname, clone: () => new URL(`http://localhost:3000${pathname}`) },
    url: `http://localhost:3000${pathname}`,
    cookies: {
      get: (name: string) =>
        name === 'cm_auth_token' && spec.cookie ? { name, value: spec.cookie } : undefined,
    },
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

async function runMiddleware(spec: RequestSpec = {}): Promise<{ type?: string; status?: number }> {
  const { middleware } = await import('@/middleware');
  return (await middleware(createRequest(spec) as never)) as { type?: string; status?: number };
}

describe('middleware ingress auth (Issue #2489)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    ipRestrictionState.enabled = false;
    ipRestrictionState.allowed = true;
    process.env.CM_AUTH_TOKEN_HASH = SESSION_TOKEN_HASH;
    delete process.env.CM_AUTH_EXPIRE;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  describe('CM_AUTH_SCOPE=remote-only', () => {
    beforeEach(() => {
      process.env.CM_AUTH_SCOPE = 'remote-only';
    });

    it('lets the local listener through without a token', async () => {
      expect(await runMiddleware({ ingress: 'local' })).toEqual({ type: 'next' });
    });

    it('lets a local-listener screen request through without a token', async () => {
      // The reported symptom of #2489 was the PC being sent to /login with no
      // way to log in. This is that request.
      expect(await runMiddleware({ pathname: '/', ingress: 'local' })).toEqual({ type: 'next' });
      expect(mockNextResponseRedirect).not.toHaveBeenCalled();
    });

    it('lets a local-listener CLI request through without a Bearer token', async () => {
      // `commandmate ls` / `send` / `wait` / `capture` dial the local port and
      // have no token to present during a remote session.
      expect(await runMiddleware({ ingress: 'local' })).toEqual({ type: 'next' });
      expect(mockNextResponseJson).not.toHaveBeenCalled();
    });

    it('lets a local-listener WebSocket upgrade through without a token', async () => {
      expect(await runMiddleware({ ingress: 'local', upgrade: true })).toEqual({ type: 'next' });
    });

    it('still redirects an unauthenticated browser request on the provider listener', async () => {
      const result = await runMiddleware({ pathname: '/', ingress: 'remote' });
      expect(result).toEqual({ type: 'redirect', url: 'http://localhost:3000/login' });
    });

    it('still answers 401 to an unauthenticated API request on the provider listener', async () => {
      const result = await runMiddleware({ ingress: 'remote', authHeader: 'Bearer wrong' });
      expect(result).toMatchObject({ type: 'json', status: 401 });
    });

    it('still answers 401 to an unauthenticated upgrade on the provider listener', async () => {
      const result = await runMiddleware({ ingress: 'remote', upgrade: true });
      expect(result).toMatchObject({ status: 401 });
    });

    it('ignores every forged header on the provider listener', async () => {
      // X-Real-IP, X-Forwarded-For, Host and the internal stamp, all claiming
      // "this is local". The stamp is overwritten by the listener; the other
      // three are never read by the auth decision at all.
      for (const spec of [
        { pathname: '/', ingress: 'remote' as const, clientHeaders: FORGERIES },
        { ingress: 'remote' as const, upgrade: true, clientHeaders: FORGERIES },
      ]) {
        vi.clearAllMocks();
        const result = await runMiddleware(spec);
        expect(result).not.toEqual({ type: 'next' });
      }
    });

    it('demands a token from a request no listener stamped', async () => {
      // Fail-closed. A request that reached middleware without passing a
      // listener this process built cannot prove where it came from.
      expect(await runMiddleware({ pathname: '/' })).toMatchObject({ type: 'redirect' });
    });

    it('demands a token when the stamp is not exactly "local"', async () => {
      for (const value of ['LOCAL', 'local, remote', ' local', 'localhost']) {
        vi.clearAllMocks();
        const result = await runMiddleware({
          pathname: '/',
          clientHeaders: { 'x-cm-ingress': value },
        });
        expect(result).toMatchObject({ type: 'redirect' });
      }
    });

    it('accepts the paired token on the provider listener', async () => {
      expect(await runMiddleware({ ingress: 'remote', cookie: SESSION_TOKEN })).toEqual({
        type: 'next',
      });
      expect(
        await runMiddleware({ ingress: 'remote', authHeader: `Bearer ${SESSION_TOKEN}` })
      ).toEqual({ type: 'next' });
    });

    it('does not exempt the local listener from IP restriction', async () => {
      // The exemption is about tokens only. A CM_ALLOWED_IPS the operator set
      // still applies to every listener.
      ipRestrictionState.enabled = true;
      ipRestrictionState.allowed = false;

      const result = await runMiddleware({ ingress: 'local' });
      expect(result).toMatchObject({ status: 403 });
    });
  });

  describe('CM_AUTH_SCOPE=all and unset (default behaviour)', () => {
    it('authenticates the local listener under --auth all', async () => {
      process.env.CM_AUTH_SCOPE = 'all';
      expect(await runMiddleware({ pathname: '/', ingress: 'local' })).toMatchObject({
        type: 'redirect',
      });
    });

    it('authenticates the local listener when the scope is unset', async () => {
      delete process.env.CM_AUTH_SCOPE;
      expect(await runMiddleware({ pathname: '/', ingress: 'local' })).toMatchObject({
        type: 'redirect',
      });
    });

    it('authenticates the local listener when the scope is misspelt', async () => {
      // Fail-closed: only the exact string opens the door.
      process.env.CM_AUTH_SCOPE = 'remote_only';
      expect(await runMiddleware({ pathname: '/', ingress: 'local' })).toMatchObject({
        type: 'redirect',
      });
    });

    it('leaves an auth-less server untouched in every scope', async () => {
      // `CM_AUTH_TOKEN_HASH` unset is still an immediate pass-through, which is
      // what a plain `commandmate start` is.
      delete process.env.CM_AUTH_TOKEN_HASH;
      process.env.CM_AUTH_SCOPE = 'remote-only';
      expect(await runMiddleware({ pathname: '/', ingress: 'remote' })).toEqual({ type: 'next' });
      expect(await runMiddleware({ ingress: 'remote', upgrade: true })).toEqual({ type: 'next' });
    });
  });
});
