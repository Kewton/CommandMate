/**
 * The real ::1 case for the startup self-check (Issue #2113)
 *
 * The unit tests reproduce the mechanism with two IPv4 servers, which is what makes them
 * run everywhere. This file reproduces the ACTUAL production shape the Issue measured on
 * 2026-08-27: CommandMate on `127.0.0.1:<port>` while an unrelated process holds
 * `::1:<port>`, i.e. exactly the address `localhost` prefers on macOS.
 *
 * It self-skips where the IPv6 loopback cannot be bound (containerised CI with IPv6 off),
 * because a missing ::1 makes the scenario physically impossible rather than failing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { lookup } from 'dns/promises';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'cm-selfcheck-ipv6-'));

vi.mock('../../src/cli/utils/install-context', () => ({
  getConfigDir: () => configDir,
  isGlobalInstall: () => true,
}));

import {
  probeLocalhostIdentity,
  readLocalhostConflict,
  runLocalhostSelfCheck,
} from '../../src/lib/server/localhost-self-check';

function listenOn(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function portOf(server: Server): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

/**
 * Both facts are established with TOP-LEVEL await, not in `beforeAll`: `it.runIf()` reads
 * its condition while the suite is being COLLECTED, which happens before any hook runs.
 * Deciding this in a hook silently skips every case on every machine.
 */
const ipv6LoopbackUsable = await (async () => {
  try {
    const probe = await listenOn('::1', 0);
    await close(probe);
    return true;
  } catch {
    return false;
  }
})();

/** True when `localhost` prefers IPv6, which is what makes the defect reachable */
const localhostPrefersIpv6 = await (async () => {
  try {
    const addresses = await lookup('localhost', { all: true, verbatim: true });
    return addresses[0]?.family === 6;
  } catch {
    return false;
  }
})();

describe('startup self-check against a real ::1 squatter (Issue #2113)', () => {
  const opened: Server[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map(close));
    rmSync(join(configDir, 'logs'), { recursive: true, force: true });
  });

  /**
   * CommandMate on 127.0.0.1:<port> plus an unrelated server on ::1:<port>.
   * Retries because the port has to be free on BOTH stacks.
   */
  async function stageConflict(): Promise<{ ours: Server; squatter: Server; port: number }> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const ours = await listenOn('127.0.0.1', 0);
      const port = portOf(ours);
      try {
        const squatter = await listenOn('::1', port);
        opened.push(ours, squatter);
        return { ours, squatter, port };
      } catch {
        await close(ours);
      }
    }
    throw new Error('could not stage a port free on both 127.0.0.1 and ::1');
  }

  it.runIf(ipv6LoopbackUsable)(
    'reports foreign when another process holds ::1:<port>',
    async () => {
      const { ours, port } = await stageConflict();

      const verdict = await probeLocalhostIdentity({
        server: ours,
        port,
        host: '::1',
        timeoutMs: 3000,
      });

      expect(verdict).toBe('foreign');
    }
  );

  it.runIf(ipv6LoopbackUsable)(
    'warns and records the conflict, without blocking or throwing',
    async () => {
      const { ours, port } = await stageConflict();
      const warnings: string[] = [];

      const verdict = await runLocalhostSelfCheck({
        server: ours,
        port,
        bind: '127.0.0.1',
        host: '::1',
        timeoutMs: 3000,
        pid: 999_001,
        warn: (line) => warnings.push(line),
      });

      expect(verdict).toBe('foreign');
      expect(warnings.join('\n')).toContain('Another process is answering');
      expect(readLocalhostConflict(port)).toMatchObject({
        port,
        pid: 999_001,
        bind: '127.0.0.1',
        boundUrl: `http://127.0.0.1:${port}`,
        probedUrl: `http://[::1]:${port}`,
      });
    }
  );

  it.runIf(ipv6LoopbackUsable)(
    'through the advertised `localhost` name, the verdict follows the resolver order',
    async () => {
      // This is the platform dependence the Issue describes, asserted rather than assumed:
      // macOS puts ::1 first (so the squatter wins and we must warn), most Linux setups put
      // 127.0.0.1 first (so we reach ourselves and must stay silent).
      const { ours, port } = await stageConflict();

      const verdict = await probeLocalhostIdentity({ server: ours, port, timeoutMs: 3000 });

      expect(verdict).toBe(localhostPrefersIpv6 ? 'foreign' : 'self');
    }
  );

  it('stays silent when nothing squats ::1 (negative control)', async () => {
    const ours = await listenOn('127.0.0.1', 0);
    opened.push(ours);
    const port = portOf(ours);
    const warnings: string[] = [];

    const verdict = await runLocalhostSelfCheck({
      server: ours,
      port,
      bind: '127.0.0.1',
      timeoutMs: 3000,
      warn: (line) => warnings.push(line),
    });

    // Either we were reached directly, or ::1 refused and Happy Eyeballs fell through to
    // 127.0.0.1 — never 'foreign', which is what would warn.
    expect(verdict).not.toBe('foreign');
    expect(warnings).toEqual([]);
    expect(readLocalhostConflict(port)).toBeNull();
  });
});
