/**
 * Startup localhost self-check (Issue #2113)
 *
 * The defect: CommandMate binds 127.0.0.1 while every guide advertises
 * `http://localhost:<port>`. When `localhost` resolves ::1 first and another process
 * holds ::1:<port>, the browser talks to that process and CommandMate reports nothing.
 *
 * These tests drive the probe over real loopback TCP servers rather than a mocked
 * `http.request`, because the whole point of the mechanism is WHICH process received
 * the request — a mock cannot be wrong about that in the way production can. IPv6 is
 * deliberately not required here: the verdict depends on whether OUR server observed
 * the probe, so pointing the probe at a second server on 127.0.0.1 reproduces the
 * `::1`-squatter case exactly, on every CI machine. The real ::1 case is covered by
 * tests/integration/localhost-self-check-ipv6-2113.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'cm-selfcheck-'));

vi.mock('../../../src/cli/utils/install-context', () => ({
  getConfigDir: () => configDir,
  isGlobalInstall: () => true,
}));

import {
  SELF_CHECK_HEADER,
  clearLocalhostConflict,
  formatBoundUrl,
  formatLocalhostConflictWarning,
  getSelfCheckStatePath,
  probeLocalhostIdentity,
  readLocalhostConflict,
  runLocalhostSelfCheck,
  writeLocalhostConflict,
  type LocalhostConflictRecord,
} from '../../../src/lib/server/localhost-self-check';

/** Start an HTTP server on 127.0.0.1 and resolve once it is listening */
function listen(handler: (seen: string | string[] | undefined) => void = () => {}): Promise<{
  server: Server;
  port: number;
}> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      handler(req.headers[SELF_CHECK_HEADER]);
      res.statusCode = 200;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const RECORD: LocalhostConflictRecord = {
  port: 3000,
  pid: 4242,
  bind: '127.0.0.1',
  boundUrl: 'http://127.0.0.1:3000',
  probedUrl: 'http://localhost:3000',
  detectedAt: '2026-08-27T00:00:00.000Z',
};

describe('probeLocalhostIdentity (Issue #2113)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  it("returns 'self' when the probed address reaches our own server", async () => {
    const { server, port } = await listen();
    servers.push(server);

    const verdict = await probeLocalhostIdentity({
      server,
      port,
      host: '127.0.0.1',
      timeoutMs: 2000,
    });

    expect(verdict).toBe('self');
  });

  it("returns 'foreign' when a DIFFERENT process answers on the probed address", async () => {
    // `ours` stands in for CommandMate; `squatter` for the stray Next.js dev server the
    // Issue measured on ::1:3000. Probing the squatter's port while observing `ours` is
    // the exact shape of the production defect.
    const ours = await listen();
    const squatter = await listen();
    servers.push(ours.server, squatter.server);

    const verdict = await probeLocalhostIdentity({
      server: ours.server,
      port: squatter.port,
      host: '127.0.0.1',
      timeoutMs: 2000,
    });

    expect(verdict).toBe('foreign');
  });

  it("returns 'unreachable' when nothing is listening (never 'foreign')", async () => {
    const { server, port } = await listen();
    servers.push(server);
    await close(servers.pop() as Server);

    const verdict = await probeLocalhostIdentity({
      server,
      port,
      host: '127.0.0.1',
      timeoutMs: 2000,
    });

    // The normal macOS case with an empty ::1: browsers fall through to 127.0.0.1, so
    // this must stay silent. A 'foreign' here would warn on every healthy machine.
    expect(verdict).toBe('unreachable');
  });

  it('sends the nonce that identifies the request, and only that request', async () => {
    const seen: Array<string | string[] | undefined> = [];
    const { server, port } = await listen((value) => seen.push(value));
    servers.push(server);

    await probeLocalhostIdentity({
      server,
      port,
      host: '127.0.0.1',
      nonce: 'deadbeef',
      timeoutMs: 2000,
    });

    expect(seen).toEqual(['deadbeef']);
  });

  it('does not accept a mismatched nonce as proof of identity', async () => {
    // Our own server sees a request, but not OUR request: the header carries someone
    // else's value. Identity must come from the nonce, not from "a request arrived".
    const ours = await listen();
    const squatter = await listen();
    servers.push(ours.server, squatter.server);

    const probe = probeLocalhostIdentity({
      server: ours.server,
      port: squatter.port,
      host: '127.0.0.1',
      nonce: 'expected-nonce',
      timeoutMs: 2000,
    });

    // Synthetic request straight at our own server; the stub `res` is what the real
    // handler above writes to, and is never seen by the probe.
    ours.server.emit(
      'request',
      { headers: { [SELF_CHECK_HEADER]: 'other-nonce' } },
      { statusCode: 0, end: () => undefined }
    );

    expect(await probe).toBe('foreign');
  });

  it('detaches its request listener once the verdict is known', async () => {
    const { server, port } = await listen();
    servers.push(server);

    const before = server.listenerCount('request');
    await probeLocalhostIdentity({ server, port, host: '127.0.0.1', timeoutMs: 2000 });

    expect(server.listenerCount('request')).toBe(before);
  });

  it('resolves rather than throwing when the server cannot be observed', async () => {
    const broken = {
      prependListener: () => {
        throw new Error('cannot attach');
      },
      removeListener: () => undefined,
    };

    await expect(
      probeLocalhostIdentity({ server: broken, port: 1, host: '127.0.0.1', timeoutMs: 50 })
    ).resolves.toBe('unreachable');
  });
});

describe('conflict record persistence (Issue #2113)', () => {
  beforeEach(() => {
    rmSync(join(configDir, 'logs'), { recursive: true, force: true });
  });

  it('writes the record where status can find it, keyed by port', () => {
    expect(writeLocalhostConflict(RECORD)).toBe(true);

    const statePath = getSelfCheckStatePath(3000);
    expect(statePath).toBe(join(configDir, 'logs', 'self-check-3000.json'));
    expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toEqual(RECORD);
    expect(readLocalhostConflict(3000)).toEqual(RECORD);
  });

  it('returns null when there is no record', () => {
    expect(readLocalhostConflict(3000)).toBeNull();
  });

  it('returns null for a corrupt record instead of throwing', () => {
    mkdirSync(join(configDir, 'logs'), { recursive: true });
    writeFileSync(getSelfCheckStatePath(3000), 'not json at all');

    expect(readLocalhostConflict(3000)).toBeNull();
  });

  it('returns null for a record whose shape does not match', () => {
    mkdirSync(join(configDir, 'logs'), { recursive: true });
    writeFileSync(getSelfCheckStatePath(3000), JSON.stringify({ port: 3000 }));

    expect(readLocalhostConflict(3000)).toBeNull();
  });

  it('clears the record', () => {
    writeLocalhostConflict(RECORD);
    clearLocalhostConflict(3000);

    expect(existsSync(getSelfCheckStatePath(3000))).toBe(false);
    expect(readLocalhostConflict(3000)).toBeNull();
  });

  it('tolerates clearing a record that is not there', () => {
    expect(() => clearLocalhostConflict(3000)).not.toThrow();
  });

  it('rejects a port that would not be a safe filename', () => {
    expect(() => getSelfCheckStatePath(0)).toThrow(/Invalid port/);
    expect(() => getSelfCheckStatePath(70000)).toThrow(/Invalid port/);
    expect(() => getSelfCheckStatePath(3000.5)).toThrow(/Invalid port/);
  });
});

describe('warning text (Issue #2113)', () => {
  it('names the other process, the real bind and the port to inspect', () => {
    const lines = formatLocalhostConflictWarning(RECORD).join('\n');

    expect(lines).toContain('Another process is answering on http://localhost:3000');
    expect(lines).toContain('NOT this CommandMate server');
    expect(lines).toContain('http://127.0.0.1:3000');
    expect(lines).toContain('::1');
    expect(lines).toContain('lsof -nP -iTCP:3000 -sTCP:LISTEN');
  });

  it('reports a wildcard bind as the dialable 127.0.0.1, like resolveServerEndpoint', () => {
    expect(formatBoundUrl('http', '0.0.0.0', 3000)).toBe('http://127.0.0.1:3000');
    expect(formatBoundUrl('https', '127.0.0.1', 8443)).toBe('https://127.0.0.1:8443');
  });
});

describe('runLocalhostSelfCheck (Issue #2113)', () => {
  const server = { prependListener: () => undefined, removeListener: () => undefined };

  beforeEach(() => {
    rmSync(join(configDir, 'logs'), { recursive: true, force: true });
  });

  it('warns and records the conflict on a foreign verdict', async () => {
    const warnings: string[] = [];

    const verdict = await runLocalhostSelfCheck({
      server,
      port: 3000,
      bind: '127.0.0.1',
      pid: 4242,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      warn: (line) => warnings.push(line),
      probe: async () => 'foreign',
    });

    expect(verdict).toBe('foreign');
    expect(warnings.join('\n')).toContain('Another process is answering');
    expect(readLocalhostConflict(3000)).toEqual(RECORD);
  });

  it.each(['self', 'unreachable'] as const)(
    'stays silent and clears any stale record on a %s verdict',
    async (probed) => {
      writeLocalhostConflict(RECORD);
      const warnings: string[] = [];

      const verdict = await runLocalhostSelfCheck({
        server,
        port: 3000,
        bind: '127.0.0.1',
        warn: (line) => warnings.push(line),
        probe: async () => probed,
      });

      expect(verdict).toBe(probed);
      expect(warnings).toEqual([]);
      expect(readLocalhostConflict(3000)).toBeNull();
    }
  );

  it('fails open when the probe itself throws', async () => {
    const warnings: string[] = [];

    const verdict = await runLocalhostSelfCheck({
      server,
      port: 3000,
      bind: '127.0.0.1',
      warn: (line) => warnings.push(line),
      probe: async () => {
        throw new Error('probe exploded');
      },
    });

    expect(verdict).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('records the probed URL the docs advertise, not the bind address', async () => {
    await runLocalhostSelfCheck({
      server,
      port: 3900,
      bind: '0.0.0.0',
      pid: 77,
      probe: async () => 'foreign',
      warn: () => undefined,
    });

    const record = readLocalhostConflict(3900);
    expect(record?.probedUrl).toBe('http://localhost:3900');
    expect(record?.boundUrl).toBe('http://127.0.0.1:3900');
  });
});

afterEach(() => {
  rmSync(join(configDir, 'logs'), { recursive: true, force: true });
});
