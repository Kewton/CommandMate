/**
 * Issue #3087: `remote` must not publish a server it cannot prove is its own,
 * authenticated one.
 *
 * In the incident an orphaned, unauthenticated server held the port, the
 * server `remote` launched died on EADDRINUSE, and the TCP readiness check
 * passed against the orphan — so a public tunnel fronted a CommandMate with
 * no login. Here the listeners are REAL loopback HTTP servers on free ports;
 * only the Provider (no cloudflared / tailscale is ever run), the daemon and
 * `runStart` are stubbed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { createServer as createHttpServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'cm-remote-guard-3087-'));

vi.mock('../../../../src/cli/utils/install-context', () => ({
  getConfigDir: () => configDir,
  ensureConfigDir: () => configDir,
  isGlobalInstall: () => false,
  isNpxExecution: () => false,
}));
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: () => join(configDir, '.env'),
  getPidFilePath: () => join(configDir, '.commandmate.pid'),
}));
vi.mock('../../../../src/cli/utils/security-logger', () => ({ logSecurityEvent: vi.fn() }));
vi.mock('../../../../src/cli/utils/prompt', () => ({
  isInteractive: vi.fn(() => false),
  confirm: vi.fn(async () => false),
  closeReadline: vi.fn(),
}));
const daemonState = { stopCalls: 0 };
vi.mock('../../../../src/cli/utils/daemon', () => ({
  DaemonManager: class {
    async isRunning(): Promise<boolean> {
      return false;
    }
    async getStatus(): Promise<unknown> {
      return null;
    }
    async stop(): Promise<boolean> {
      daemonState.stopCalls += 1;
      return true;
    }
  },
}));
vi.mock('../../../../src/cli/commands/start', () => ({ runStart: vi.fn() }));
vi.mock('../../../../src/lib/remote', () => ({
  detectRemoteProviders: vi.fn(),
  createRemoteProviders: vi.fn(() => []),
  findFreeLoopbackPort: vi.fn(),
}));

import { runRemoteUp } from '../../../../src/cli/commands/remote';
import { ExitCode } from '../../../../src/cli/types';
import { runStart } from '../../../../src/cli/commands/start';
import { detectRemoteProviders, findFreeLoopbackPort } from '../../../../src/lib/remote';
import type { ProviderCandidate, RemoteHandle } from '../../../../src/lib/remote';
import { hashToken } from '../../../../src/lib/security/auth';
import { verifyLaunchedServer } from '../../../../src/cli/utils/server-identity';

const statePath = join(configDir, 'remote.json');
const pairingPath = join(configDir, 'remote-pairing.json');
const servers: Server[] = [];

/** The hash `remote` handed to the server it launched, captured at `runStart`. */
let launchedHash: string | undefined;

/** A server that answers 200 to everything: a CommandMate started without auth. */
function unauthenticatedServer(): Promise<number> {
  return listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}

/** A server that behaves like the middleware: Bearer must hash to `expectedHash()`. */
function authenticatedServer(expectedHash: () => string | undefined): Promise<number> {
  return listen((req, res) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const ok = token !== '' && hashToken(token) === expectedHash();
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(ok ? '{}' : '{"error":"Unauthorized"}');
  });
}

function listen(handler: Parameters<typeof createHttpServer>[1]): Promise<number> {
  return new Promise((resolve) => {
    const server = createHttpServer(handler!);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function stubCloudflare(): ProviderCandidate {
  const handle: RemoteHandle = {
    provider: 'cloudflare-quick',
    url: 'https://stub.trycloudflare.test',
    owned: { pid: null, revert: null },
    preexisting: null,
  };
  return {
    provider: {
      id: 'cloudflare-quick',
      detect: vi.fn(async () => ({ available: true, ready: true })),
      start: vi.fn(async () => handle),
      stop: vi.fn(async () => ({ reverted: true, skipped: [], warnings: [] })),
    },
    detection: { available: true, ready: true },
  } as unknown as ProviderCandidate;
}

describe('remote up publishes only its own authenticated server (Issue #3087)', () => {
  const originalEnv = { ...process.env };
  let candidate: ProviderCandidate;

  function launchOn(port: number): void {
    vi.mocked(runStart).mockImplementation(async () => {
      launchedHash = process.env.CM_AUTH_TOKEN_HASH;
      return { ok: true, exitCode: ExitCode.SUCCESS, url: `http://127.0.0.1:${port}`, pid: 4242 };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    daemonState.stopCalls = 0;
    launchedHash = undefined;
    candidate = stubCloudflare();
    vi.mocked(detectRemoteProviders).mockResolvedValue([candidate]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rmSync(statePath, { force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
    rmSync(statePath, { force: true });
    rmSync(pairingPath, { force: true });
  });

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('refuses when an unauthenticated process answers on the port: nothing is published', async () => {
    launchOn(await unauthenticatedServer());

    const code = await runRemoteUp({ provider: 'cloudflare', yes: true });

    expect(code).not.toBe(ExitCode.SUCCESS);
    expect(candidate.provider.start).not.toHaveBeenCalled();
    expect(existsSync(statePath)).toBe(false);
    // Rolled back: the plaintext handoff is gone and the launched server stopped.
    expect(existsSync(pairingPath)).toBe(false);
    expect(daemonState.stopCalls).toBe(1);
  });

  it('refuses when an authenticated server that is not ours answers (different token)', async () => {
    const otherHash = hashToken('someone-elses-token');
    launchOn(await authenticatedServer(() => otherHash));

    const code = await runRemoteUp({ provider: 'cloudflare', yes: true });

    expect(code).not.toBe(ExitCode.SUCCESS);
    expect(candidate.provider.start).not.toHaveBeenCalled();
    expect(existsSync(statePath)).toBe(false);
  });

  it('publishes when the listener is the authenticated server it launched', async () => {
    const port = await authenticatedServer(() => launchedHash);
    launchOn(port);

    const code = await runRemoteUp({ provider: 'cloudflare', yes: true });

    expect(code).toBe(ExitCode.SUCCESS);
    expect(candidate.provider.start).toHaveBeenCalledWith(expect.objectContaining({ port }));
    expect(existsSync(statePath)).toBe(true);
  });

  it('remote-only: checks the published ingress port, not the auth-exempt local one', async () => {
    // The local listener is exempt from auth by design (#2489) and is never published.
    const localPort = await unauthenticatedServer();
    const ingressPort = await authenticatedServer(() => launchedHash);
    vi.mocked(findFreeLoopbackPort).mockResolvedValue(ingressPort);
    launchOn(localPort);

    const code = await runRemoteUp({ provider: 'cloudflare', yes: true, auth: 'remote-only' });

    expect(code).toBe(ExitCode.SUCCESS);
    expect(candidate.provider.start).toHaveBeenCalledWith(expect.objectContaining({ port: ingressPort }));
  });

  it('remote-only: refuses when the ingress port answers without authentication', async () => {
    const localPort = await authenticatedServer(() => launchedHash);
    const ingressPort = await unauthenticatedServer();
    vi.mocked(findFreeLoopbackPort).mockResolvedValue(ingressPort);
    launchOn(localPort);

    const code = await runRemoteUp({ provider: 'cloudflare', yes: true, auth: 'remote-only' });

    expect(code).not.toBe(ExitCode.SUCCESS);
    expect(candidate.provider.start).not.toHaveBeenCalled();
  });
});

describe('verifyLaunchedServer (Issue #3087)', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });

  it('does not send the session token to a server that answered without authentication', async () => {
    const seen: string[] = [];
    const port = await listen((req, res) => {
      seen.push(req.headers.authorization ?? '');
      res.writeHead(200);
      res.end();
    });

    const verdict = await verifyLaunchedServer({
      protocol: 'http',
      host: '127.0.0.1',
      port,
      sessionToken: 'session-token-under-test',
    });

    expect(verdict.ok).toBe(false);
    expect(seen.some((h) => h.includes('session-token-under-test'))).toBe(false);
  });

  it('fails closed when nothing listens', async () => {
    const port = await listen(() => {});
    await new Promise((resolve) => servers.pop()!.close(resolve));

    const verdict = await verifyLaunchedServer({
      protocol: 'http',
      host: '127.0.0.1',
      port,
      sessionToken: 't',
      timeoutMs: 300,
      intervalMs: 50,
    });

    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining('nothing answered') });
  });

  it('fails closed on a redirect (e.g. a login page) instead of treating it as success', async () => {
    const port = await listen((req, res) => {
      res.writeHead(307, { location: '/login' });
      res.end();
    });

    const verdict = await verifyLaunchedServer({
      protocol: 'http',
      host: '127.0.0.1',
      port,
      sessionToken: 't',
    });

    expect(verdict.ok).toBe(false);
  });
});
