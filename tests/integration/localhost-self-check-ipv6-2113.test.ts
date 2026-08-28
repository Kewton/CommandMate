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
 *
 * ## Do not derive the expected verdict from DNS order (PR #2115, CI red)
 *
 * The `localhost` case below first asserted against `dns.lookup(..., {verbatim:true})[0]`,
 * on the assumption that the first address is the one a connection uses. It is not, for
 * two independent reasons, and both produce the CI symptom
 * (`expected 'self' to be 'foreign'`, integration red while unit was green):
 *
 * 1. `net.autoSelectFamily` has defaulted to true since Node 20 (measured on Node v24.1.0:
 *    `getDefaultAutoSelectFamily() === true`,
 *    `getDefaultAutoSelectFamilyAttemptTimeout() === 250`). Node starts the first address,
 *    and if that has not connected within 250ms it starts the next family IN PARALLEL and
 *    keeps whichever completes first. On a loaded runner IPv4 can win even though `::1`
 *    heads the list.
 * 2. `verbatim: true` pins the READING to verbatim order no matter what result order the
 *    process actually resolves with. On a runtime set to resolve IPv4-first
 *    (`--dns-result-order=ipv4first`, `NODE_OPTIONS`, a distro default), the reading says
 *    `::1` while every connection lands on IPv4 — deterministically, not just under load.
 *    Reproduced locally, 12/12: reading `[::1, 127.0.0.1]`, all 12 connections landing on
 *    IPv4, the old assertion failing 12/12 and the observation-driven one 0/12.
 *
 * So the expectation is OBSERVED, never predicted. It is observed at the RECEIVING end —
 * the squatter records the probe's one-shot nonce — rather than by dialling a second
 * connection and reading `socket.remoteAddress`. A second dial is a second Happy Eyeballs
 * race under the same load that flipped the first one, so it could land on the other
 * family and would turn a deterministically-wrong test into a flaky one. The squatter's
 * record and the verdict describe the SAME single connection, so they cannot disagree by
 * chance. DNS order is still read, but only as context in the failure message.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'http';
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
  SELF_CHECK_HEADER,
  probeLocalhostIdentity,
  readLocalhostConflict,
  runLocalhostSelfCheck,
} from '../../src/lib/server/localhost-self-check';

function listenOn(
  host: string,
  port: number,
  onRequest?: (headers: IncomingHttpHeaders) => void
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      onRequest?.(req.headers);
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

/**
 * The resolver's order for `localhost`, kept ONLY as context for a failure message.
 *
 * This is deliberately not an expectation: see the header. It answers "what would a naive
 * reading predict", which is useful when a future CI run disagrees with the observation.
 */
const localhostDnsOrder = await (async () => {
  try {
    const addresses = await lookup('localhost', { all: true, verbatim: true });
    return addresses.map((a) => a.address).join(', ');
  } catch (error) {
    return `lookup failed: ${String(error)}`;
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
   *
   * `squatterSawNonce` is how the `localhost` case learns where the probe's connection
   * actually landed, without dialling a second time (see the file header).
   */
  async function stageConflict(): Promise<{
    ours: Server;
    squatter: Server;
    port: number;
    squatterSawNonce: (nonce: string) => boolean;
  }> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const ours = await listenOn('127.0.0.1', 0);
      const port = portOf(ours);
      const seen: Array<string | undefined> = [];
      try {
        const squatter = await listenOn('::1', port, (headers) => {
          const value = headers[SELF_CHECK_HEADER];
          seen.push(Array.isArray(value) ? value[0] : value);
        });
        opened.push(ours, squatter);
        return {
          ours,
          squatter,
          port,
          squatterSawNonce: (nonce) => seen.includes(nonce),
        };
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
    'through the advertised `localhost` name, the verdict names whichever process the connection actually reached',
    async () => {
      // The invariant, and the reason this case exists: however the resolver and Happy
      // Eyeballs tip on this machine, the verdict must describe the process that actually
      // received the probe. macOS lands on the ::1 squatter (so CommandMate must warn);
      // a runner whose IPv4 attempt wins lands on us (so it must stay silent). Both are
      // correct behaviour, and neither may be hard-coded — see the file header.
      const { ours, port, squatterSawNonce } = await stageConflict();
      const nonce = 'localhost-landing-2113';

      const verdict = await probeLocalhostIdentity({
        server: ours,
        port,
        nonce,
        timeoutMs: 3000,
      });

      // Observed from the receiving end of the SAME connection the verdict came from.
      const landedOnSquatter = squatterSawNonce(nonce);

      expect(
        verdict,
        `probe landed on ${landedOnSquatter ? 'the ::1 squatter' : 'our own 127.0.0.1 server'}; ` +
          `localhost resolves to [${localhostDnsOrder}] (order is a prediction, not the landing)`
      ).toBe(landedOnSquatter ? 'foreign' : 'self');
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
