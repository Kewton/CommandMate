/**
 * Cloudflare Quick Tunnel Provider (Issue #1937, R2; design §6.4 and §9.2).
 *
 * ## What is pinned here, and why each one is structural rather than stylistic
 *
 * 1. **The argv only ever names loopback.** §9.2 asks for two assertions on the
 *    command line `start()` builds: the upstream is always `127.0.0.1`, and
 *    `--metrics` starts with `127.0.0.1:`. The second is the one that is easy to
 *    lose: `cloudflared tunnel --help` says the metrics default "binds to all
 *    interfaces" under a virtual environment, so an omitted flag is an open port
 *    on every interface — while CommandMate's own `CM_BIND` default is loopback.
 *    The rule is written as a function (`loopbackViolations`) and **fired at
 *    input that must fail**, because a checker that finds nothing and a checker
 *    that is broken produce the same green.
 *
 * 2. **`stop()` signals one pid and does nothing else.** It never spawns. That
 *    is asserted directly, so "shell out to something that acts on every tunnel
 *    on this machine" cannot arrive without this test going red — a second line
 *    of defence behind the text guard in
 *    `tests/unit/config/remote-destructive-command-guard.test.ts`. One test
 *    signals a **real** child process, so the default wiring to `process.kill`
 *    is proven rather than assumed.
 *
 * 3. **The first URL candidate is genuinely first.** Measured on 2026-08-29
 *    against cloudflared 2025.4.0 (`dev-reports/issue/1937/u3-quicktunnel-url.md`):
 *    the stderr banner appears about a second *before* the metrics server starts
 *    listening. A loop that consulted both every round would therefore take the
 *    banner every single time, and `/quicktunnel` — the route U-3 went and
 *    measured — would never run. The preference window is what prevents that,
 *    and the pair of tests at the bottom shows the window is load-bearing: same
 *    inputs, different window, different source wins.
 *
 * Every fixture in this file is copied from that live capture. The stderr
 * fixture keeps the two unrelated `https://…cloudflare.com` URLs cloudflared
 * really prints, so the banner parser is tested against the distractors it will
 * actually meet rather than against a tidied-up version of them.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { spawn as realSpawn } from 'child_process';
import type {
  SpawnOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from 'child_process';
import { PassThrough } from 'stream';

import {
  buildQuickTunnelArgs,
  CLOUDFLARED_PIDFILE_NAME,
  cloudflareProvider,
  createCloudflareProvider,
  DEFAULT_QUICK_TUNNEL_TIMING,
  DETECT_TIMEOUT_MS,
  findFreeLoopbackPort,
  isQuickTunnelHostname,
  LOOPBACK_HOST,
  parseBannerUrl,
  parseQuickTunnelHostname,
  type CloudflareProviderDeps,
  type QuickTunnelProcess,
} from '@/lib/remote/cloudflare';
import type { RemoteHandle } from '@/lib/remote/types';

// ---------------------------------------------------------------------------
// Fixtures captured from the live U-3 run (cloudflared 2025.4.0, 2026-08-29)
// ---------------------------------------------------------------------------

/** The hostname that run actually handed out. */
const MEASURED_HOSTNAME = 'villas-activists-hey-barbie.trycloudflare.com';

/** The `/quicktunnel` body, verbatim. Note: no scheme, and served as text/plain. */
const MEASURED_QUICKTUNNEL_BODY = `{"hostname":"${MEASURED_HOSTNAME}"}`;

/**
 * cloudflared's stderr, verbatim except for the trailing box rules being
 * shortened. Three lines here are distractors the parser must not take:
 * the Terms-of-Use URL, the developer-docs URL, and the `Requesting new quick
 * Tunnel on trycloudflare.com...` line, which names the domain with no scheme.
 */
const MEASURED_STDERR = [
  '2026-08-29T01:59:11Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps',
  '2026-08-29T01:59:11Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2026-08-29T01:59:14Z INF +-----------------------------------------------------+',
  '2026-08-29T01:59:14Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  `2026-08-29T01:59:14Z INF |  https://${MEASURED_HOSTNAME}                          |`,
  '2026-08-29T01:59:14Z INF +-----------------------------------------------------+',
  '2026-08-29T01:59:15Z INF Starting metrics server on 127.0.0.1:60758/metrics',
  '',
].join('\n');

/** Only the noise, with the banner line removed. The parser must find nothing. */
const MEASURED_STDERR_WITHOUT_BANNER = MEASURED_STDERR.split('\n')
  .filter((line) => !line.includes(`https://${MEASURED_HOSTNAME}`))
  .join('\n');

/** `cloudflared --version` on the measured machine. */
const MEASURED_VERSION_OUTPUT =
  'cloudflared version 2025.4.0 (built 2025-04-01T19:23:54Z)\n';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function spawnSyncResult(
  overrides: Partial<SpawnSyncReturns<string>> = {},
): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null, ...overrides };
}

interface FakeCloudflared {
  child: QuickTunnelProcess;
  killed: NodeJS.Signals[];
  emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  writeStderr: (text: string) => void;
}

function fakeCloudflared(options: { pid?: number | undefined } = {}): FakeCloudflared {
  const stderr = new PassThrough();
  const exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const killed: NodeJS.Signals[] = [];

  const child: QuickTunnelProcess = {
    pid: 'pid' in options ? options.pid : 4242,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    once(_event: 'exit', listener) {
      exitListeners.push(listener);
      return child;
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      killed.push(signal);
      return true;
    },
  };

  return {
    child,
    killed,
    emitExit: (code, signal = null) => {
      for (const listener of exitListeners) listener(code, signal);
    },
    writeStderr: (text) => {
      stderr.write(text);
    },
  };
}

/**
 * A `spawn` double that emits `stderr` once the Provider has attached its
 * listener. Scheduled as a microtask from inside `spawn` so it always lands
 * after `start()`'s synchronous wiring, never before it.
 */
function spawnDouble(
  fake: FakeCloudflared,
  stderrText?: string,
): ReturnType<typeof vi.fn<(c: string, a: readonly string[], o: SpawnOptions) => QuickTunnelProcess>> {
  return vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    if (stderrText !== undefined) {
      queueMicrotask(() => fake.writeStderr(stderrText));
    }
    return fake.child;
  });
}

const FAST_TIMING = { urlWaitMs: 200, metricsPreferenceMs: 0, pollIntervalMs: 1 };

function testDeps(overrides: Partial<CloudflareProviderDeps> = {}): Partial<CloudflareProviderDeps> {
  return {
    findFreePort: async () => 45678,
    fetchHostname: async () => null,
    resolveStateDir: () => '/tmp/commandmate-remote-test',
    timing: FAST_TIMING,
    ...overrides,
  };
}

const liveSignal = (): AbortSignal => new AbortController().signal;

// ---------------------------------------------------------------------------
// §9.2 — the loopback rule, written as a checker and proven to bite
// ---------------------------------------------------------------------------

/**
 * The §9.2 rule: no argument may name a non-loopback listener.
 *
 * `0.0.0.0` is every interface. `localhost` is banned too even though it usually
 * resolves to loopback: it can resolve to `::1` or, on a misconfigured host, to
 * something else entirely, and cloudflared's own default is literally
 * `localhost:0`. Naming the address numerically removes the resolver from the
 * security argument.
 */
function loopbackViolations(argv: readonly string[]): string[] {
  const violations: string[] = [];
  for (const arg of argv) {
    if (/0\.0\.0\.0/.test(arg)) violations.push(`0.0.0.0 in "${arg}"`);
    if (/localhost/i.test(arg)) violations.push(`localhost in "${arg}"`);
  }
  return violations;
}

describe('the loopback checker itself (positive control)', () => {
  // Without this, every green below is equally consistent with a checker that
  // matches nothing. The repo has misread "found 0" as "not there" before.
  it('rejects an upstream on every interface', () => {
    expect(loopbackViolations(['--url', 'http://0.0.0.0:3000'])).toHaveLength(1);
  });

  it('rejects a metrics listener named by hostname', () => {
    expect(loopbackViolations(['--metrics', 'localhost:20241'])).toHaveLength(1);
  });

  it('accepts the numeric loopback form', () => {
    expect(loopbackViolations(['--url', 'http://127.0.0.1:3000'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

describe('buildQuickTunnelArgs (design §6.4)', () => {
  const args = buildQuickTunnelArgs({
    port: 3000,
    metricsPort: 60758,
    pidfile: '/home/u/.commandmate/cloudflared.pid',
  });

  it('builds exactly the command the design specifies', () => {
    expect(args).toEqual([
      'tunnel',
      '--url',
      'http://127.0.0.1:3000',
      '--no-autoupdate',
      '--metrics',
      '127.0.0.1:60758',
      '--pidfile',
      '/home/u/.commandmate/cloudflared.pid',
    ]);
  });

  it('names loopback for the upstream and for the metrics listener', () => {
    expect(args[args.indexOf('--url') + 1]).toBe(`http://${LOOPBACK_HOST}:3000`);
    expect(args[args.indexOf('--metrics') + 1]).toMatch(/^127\.0\.0\.1:/);
    expect(loopbackViolations(args)).toEqual([]);
  });

  it.each([1, 80, 3000, 3100, 8080, 65535])(
    'keeps the upstream on loopback for port %i',
    (port) => {
      const argv = buildQuickTunnelArgs({ port, metricsPort: 20241, pidfile: '/tmp/p.pid' });
      expect(argv).toContain(`http://127.0.0.1:${port}`);
      expect(loopbackViolations(argv)).toEqual([]);
    },
  );

  it('carries --no-autoupdate, so the binary cannot replace itself mid-session', () => {
    expect(args).toContain('--no-autoupdate');
  });

  it('creates an anonymous Quick Tunnel, never an account-bound one', () => {
    // A `--token` here would attach the session to the user's Cloudflare
    // account, which is a different product with different teardown semantics.
    expect(args).not.toContain('--token');
    expect(args).not.toContain('--hostname');
    expect(args[0]).toBe('tunnel');
  });
});

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

describe('detect() (design §6.2)', () => {
  it('probes with array args and no shell (MF-SEC-1)', async () => {
    const spawnSync = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        _options: SpawnSyncOptionsWithStringEncoding,
      ) => spawnSyncResult({ stdout: MEASURED_VERSION_OUTPUT }),
    );

    await createCloudflareProvider(testDeps({ spawnSync })).detect();

    const [command, args, options] = spawnSync.mock.calls[0];
    expect(command).toBe('cloudflared');
    expect(args).toEqual(['--version']);
    // The whole point of the array form: nothing here is ever parsed by a shell,
    // so there is no argument that could become a second command.
    expect(options).not.toHaveProperty('shell');
    expect(options.timeout).toBe(DETECT_TIMEOUT_MS);
    expect(DETECT_TIMEOUT_MS).toBe(5000);
  });

  it('reads the version out of the real --version output', async () => {
    const spawnSync = vi.fn(() => spawnSyncResult({ stdout: MEASURED_VERSION_OUTPUT }));
    await expect(createCloudflareProvider(testDeps({ spawnSync })).detect()).resolves.toEqual({
      available: true,
      version: '2025.4.0',
      ready: true,
    });
  });

  it('treats a Quick Tunnel as ready the moment the binary exists', async () => {
    // No account, no login, no prior configuration — so unlike Tailscale there
    // is no second question to ask. `ready` tracks `available` exactly.
    const spawnSync = vi.fn(() => spawnSyncResult({ stdout: 'cloudflared version 2099.1.2' }));
    const detection = await createCloudflareProvider(testDeps({ spawnSync })).detect();
    expect(detection.ready).toBe(detection.available);
    expect(detection.ready).toBe(true);
  });

  it('reports a missing binary as unavailable, with a reason a user can act on', async () => {
    const error: NodeJS.ErrnoException = Object.assign(new Error('spawnSync ENOENT'), {
      code: 'ENOENT',
    });
    const spawnSync = vi.fn(() => spawnSyncResult({ error }));
    await expect(createCloudflareProvider(testDeps({ spawnSync })).detect()).resolves.toEqual({
      available: false,
      ready: false,
      reason: 'cloudflared is not installed',
    });
  });

  it('reports a probe that timed out as unavailable rather than throwing', async () => {
    const error: NodeJS.ErrnoException = Object.assign(new Error('spawnSync ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    const spawnSync = vi.fn(() => spawnSyncResult({ error }));
    const detection = await createCloudflareProvider(testDeps({ spawnSync })).detect();
    expect(detection).toMatchObject({ available: false, ready: false });
    expect(detection.reason).toContain('ETIMEDOUT');
  });

  it('reports a non-zero exit as unavailable', async () => {
    const spawnSync = vi.fn(() => spawnSyncResult({ status: 127 }));
    const detection = await createCloudflareProvider(testDeps({ spawnSync })).detect();
    expect(detection).toMatchObject({ available: false, ready: false });
    expect(detection.reason).toContain('127');
  });

  it('survives a spawnSync that throws outright', async () => {
    const spawnSync = vi.fn(() => {
      throw new Error('EPERM');
    });
    const detection = await createCloudflareProvider(
      testDeps({ spawnSync: spawnSync as unknown as CloudflareProviderDeps['spawnSync'] }),
    ).detect();
    // detect() "must have no side effects" per §6.1; blowing up the caller's
    // probe loop is the side effect the registry then has to defend against.
    expect(detection).toMatchObject({ available: false, ready: false });
  });

  it('still answers when the version string is unreadable', async () => {
    const spawnSync = vi.fn(() => spawnSyncResult({ stdout: 'cloudflared (dev build)' }));
    await expect(createCloudflareProvider(testDeps({ spawnSync })).detect()).resolves.toEqual({
      available: true,
      ready: true,
    });
  });

  it('answers from the real binary without throwing, whatever this machine has', async () => {
    // Machine-independent by construction: this asserts the invariant, not the
    // laptop. It is here so the default wiring (real `spawnSync`, real PATH
    // lookup) is exercised at least once rather than only ever mocked.
    const detection = await cloudflareProvider.detect();
    expect(typeof detection.available).toBe('boolean');
    expect(detection.ready).toBe(detection.available);
    if (detection.available) expect(detection.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ---------------------------------------------------------------------------
// URL parsing — measured shapes
// ---------------------------------------------------------------------------

describe('parseQuickTunnelHostname (U-3: the first candidate)', () => {
  it('reads the hostname out of the measured /quicktunnel body', () => {
    expect(parseQuickTunnelHostname(MEASURED_QUICKTUNNEL_BODY)).toBe(MEASURED_HOSTNAME);
  });

  it('returns a bare hostname, because the response carries no scheme', () => {
    // The measured body is `{"hostname":"…"}` with no `https://`. Anything that
    // assumed a scheme was included would build `https://https://…`.
    const hostname = parseQuickTunnelHostname(MEASURED_QUICKTUNNEL_BODY);
    expect(hostname).not.toMatch(/^https?:/);
  });

  it.each([
    ['not JSON at all', 'OK'],
    ['the /healthcheck body', 'OK'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a body with no hostname key', '{"status":200,"readyConnections":1}'],
    ['a non-string hostname', '{"hostname":42}'],
    ['an empty hostname', '{"hostname":""}'],
  ])('returns null for %s', (_label, body) => {
    expect(parseQuickTunnelHostname(body)).toBeNull();
  });

  it.each([
    ['a host under someone else’s domain', 'evil.example.com'],
    ['a suffix that only looks right', 'abc.trycloudflare.com.evil.example'],
    ['a subdomain shell game', 'trycloudflare.com.evil.example'],
  ])('refuses %s', (_label, hostname) => {
    // This string becomes the URL inside a QR code a phone is asked to open, so
    // "whatever the metrics port said" is not good enough. A value that is not a
    // Quick Tunnel hostname is treated as no answer, not as a destination.
    expect(parseQuickTunnelHostname(JSON.stringify({ hostname }))).toBeNull();
    expect(isQuickTunnelHostname(hostname)).toBe(false);
  });

  it('accepts the measured hostname shape', () => {
    expect(isQuickTunnelHostname(MEASURED_HOSTNAME)).toBe(true);
  });
});

describe('parseBannerUrl (U-3: the second candidate)', () => {
  it('finds the URL in the real stderr', () => {
    expect(parseBannerUrl(MEASURED_STDERR)).toBe(`https://${MEASURED_HOSTNAME}`);
  });

  it('does not depend on the banner wording', () => {
    // Measured: the URL is on its own line, inside a box-drawn frame, *not* on
    // the "Visit it at" line. A parser anchored to the sentence would already be
    // broken against this output — and the sentence is the part Cloudflare is
    // free to reword, while the hostname suffix is the service's identity.
    const reworded = MEASURED_STDERR.replace(
      'Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):',
      'Tunnel ready. Open:',
    );
    expect(parseBannerUrl(reworded)).toBe(`https://${MEASURED_HOSTNAME}`);
  });

  it('ignores the other cloudflare.com URLs in the same output (negative control)', () => {
    // The real stderr contains the Terms-of-Use URL, the developer-docs URL and
    // a `…on trycloudflare.com...` line with no scheme. None is the tunnel.
    expect(MEASURED_STDERR_WITHOUT_BANNER).toContain('https://www.cloudflare.com/website-terms/');
    expect(MEASURED_STDERR_WITHOUT_BANNER).toContain('https://developers.cloudflare.com/');
    expect(MEASURED_STDERR_WITHOUT_BANNER).toContain('on trycloudflare.com...');
    expect(parseBannerUrl(MEASURED_STDERR_WITHOUT_BANNER)).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(parseBannerUrl('')).toBeNull();
  });

  it('prefers the most recent banner when a reconnect printed a second one', () => {
    const stderr = [
      'INF |  https://first-tunnel-name-here.trycloudflare.com  |',
      'INF Retrying connection',
      'INF |  https://second-tunnel-name-here.trycloudflare.com  |',
    ].join('\n');
    expect(parseBannerUrl(stderr)).toBe('https://second-tunnel-name-here.trycloudflare.com');
  });
});

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe('start() (design §6.4, §9.2)', () => {
  it('spawns cloudflared with a loopback-only argv', async () => {
    const fake = fakeCloudflared();
    const spawn = spawnDouble(fake);
    const provider = createCloudflareProvider(
      testDeps({ spawn, fetchHostname: async () => MEASURED_HOSTNAME }),
    );

    await provider.start({ port: 3000, signal: liveSignal() });

    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe('cloudflared');

    // §9.2, both rows, asserted on the argv that actually reached spawn.
    expect(args[args.indexOf('--url') + 1]).toBe('http://127.0.0.1:3000');
    expect(args[args.indexOf('--metrics') + 1]).toBe('127.0.0.1:45678');
    expect(args[args.indexOf('--metrics') + 1].startsWith('127.0.0.1:')).toBe(true);
    expect(loopbackViolations(args)).toEqual([]);

    expect(args[args.indexOf('--pidfile') + 1]).toBe(
      `/tmp/commandmate-remote-test/${CLOUDFLARED_PIDFILE_NAME}`,
    );
    // stderr must be piped or the second URL candidate has nothing to read.
    expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
  });

  it('returns a handle with owned.pid and preexisting null', async () => {
    const fake = fakeCloudflared({ pid: 50850 });
    const provider = createCloudflareProvider(
      testDeps({ spawn: spawnDouble(fake), fetchHostname: async () => MEASURED_HOSTNAME }),
    );

    const handle = await provider.start({ port: 3000, signal: liveSignal() });

    expect(handle).toEqual({
      provider: 'cloudflare-quick',
      url: `https://${MEASURED_HOSTNAME}`,
      owned: { pid: 50850, revert: null },
      // A Quick Tunnel writes no persistent Provider configuration, so there is
      // nothing for §6.3-2 to protect. `null` is the measured truth, not a
      // placeholder — and it is why the two Providers answer this differently
      // instead of sharing a default.
      preexisting: null,
    });
  });

  it('builds the https URL itself, since /quicktunnel gives a bare hostname', async () => {
    const fake = fakeCloudflared();
    const provider = createCloudflareProvider(
      testDeps({
        spawn: spawnDouble(fake),
        fetchHostname: async (metricsPort) => {
          expect(metricsPort).toBe(45678);
          return MEASURED_HOSTNAME;
        },
      }),
    );

    const handle = await provider.start({ port: 3000, signal: liveSignal() });
    expect(handle.url).toBe(`https://${MEASURED_HOSTNAME}`);
  });

  it.each([0, -1, 70000, 1.5, Number.NaN])(
    'refuses port %s before anything is spawned',
    async (port) => {
      const spawn = spawnDouble(fakeCloudflared());
      const provider = createCloudflareProvider(testDeps({ spawn }));
      await expect(provider.start({ port, signal: liveSignal() })).rejects.toThrow(
        /upstream port/,
      );
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('refuses to start on an already-aborted signal', async () => {
    const spawn = spawnDouble(fakeCloudflared());
    const controller = new AbortController();
    controller.abort();
    const provider = createCloudflareProvider(testDeps({ spawn }));

    await expect(provider.start({ port: 3000, signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('kills the child and throws when no URL ever appears', async () => {
    // Otherwise a public tunnel could be running with nobody holding a handle
    // that could stop it — `start()` threw, so the caller has nothing to pass
    // to `stop()`.
    const fake = fakeCloudflared();
    const provider = createCloudflareProvider(
      testDeps({
        spawn: spawnDouble(fake),
        timing: { urlWaitMs: 20, metricsPreferenceMs: 0, pollIntervalMs: 1 },
      }),
    );

    await expect(provider.start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
      /no public URL after 20ms/,
    );
    expect(fake.killed).toEqual(['SIGTERM']);
  });

  it('gives up when cloudflared exits, and says what it printed', async () => {
    const fake = fakeCloudflared();
    const spawn = vi.fn((_c: string, _a: readonly string[], _o: SpawnOptions) => {
      queueMicrotask(() => {
        fake.writeStderr('2026-08-29T01:59:11Z ERR failed to request quick Tunnel\n');
        queueMicrotask(() => fake.emitExit(1));
      });
      return fake.child;
    });
    const provider = createCloudflareProvider(
      testDeps({ spawn, timing: { urlWaitMs: 2000, metricsPreferenceMs: 0, pollIntervalMs: 1 } }),
    );

    await expect(provider.start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
      /exit code 1 before a public URL appeared/,
    );
  });

  describe('a URL is never returned for a process that has already exited', () => {
    // Paired on purpose. Both cases put the *same* readable banner in stderr;
    // they differ only in whether the child has died by the time the poll looks.
    // The resolving case proves the rejecting case is not just failing to find
    // the banner — without it, "rejects" would be equally consistent with a
    // parser that never matched anything.
    const withBanner = (fake: FakeCloudflared, alsoExit: boolean) =>
      testDeps({
        spawn: vi.fn((_c: string, _a: readonly string[], _o: SpawnOptions) => fake.child),
        fetchHostname: async () => {
          fake.writeStderr(MEASURED_STDERR);
          if (alsoExit) fake.emitExit(null, 'SIGKILL');
          // Let the stream deliver, so the banner really is in the buffer by
          // the time the poll resumes.
          await new Promise<void>((resolve) => setImmediate(resolve));
          return null;
        },
        timing: { urlWaitMs: 2000, metricsPreferenceMs: 0, pollIntervalMs: 1 },
      });

    it('returns the banner URL while the child is alive', async () => {
      const fake = fakeCloudflared();
      const provider = createCloudflareProvider(withBanner(fake, false));
      const handle = await provider.start({ port: 3000, signal: liveSignal() });
      expect(handle.url).toBe(`https://${MEASURED_HOSTNAME}`);
    });

    it('rejects instead once that same child has exited', async () => {
      // The URL names a tunnel nobody is serving. Reporting success here would
      // hand the user a QR code for a dead endpoint.
      const fake = fakeCloudflared();
      const provider = createCloudflareProvider(withBanner(fake, true));
      await expect(provider.start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
        /killed by SIGKILL/,
      );
    });
  });

  it('refuses a child that never got a pid', async () => {
    const fake = fakeCloudflared({ pid: undefined });
    const provider = createCloudflareProvider(
      testDeps({ spawn: spawnDouble(fake), fetchHostname: async () => MEASURED_HOSTNAME }),
    );

    // Without a pid there is nothing for `stop()` to signal, and `stop()` is the
    // only teardown this Provider has.
    await expect(provider.start({ port: 3000, signal: liveSignal() })).rejects.toThrow(/no pid/);
    expect(fake.killed).toEqual(['SIGTERM']);
  });
});

// ---------------------------------------------------------------------------
// The candidate order — the point of U-3
// ---------------------------------------------------------------------------

describe('URL candidates: /quicktunnel first, stderr second (U-3)', () => {
  it('takes /quicktunnel even when a banner is already sitting in stderr', async () => {
    const fake = fakeCloudflared();
    const provider = createCloudflareProvider(
      testDeps({
        spawn: spawnDouble(fake, MEASURED_STDERR),
        // A different hostname, so which source won is unambiguous.
        fetchHostname: async () => 'from-the-metrics-api.trycloudflare.com',
      }),
    );

    const handle = await provider.start({ port: 3000, signal: liveSignal() });
    expect(handle.url).toBe('https://from-the-metrics-api.trycloudflare.com');
  });

  it('falls back to the stderr banner when /quicktunnel never answers', async () => {
    // The documented second candidate. This is the path a future cloudflared
    // that drops the route would take.
    const fake = fakeCloudflared();
    const fetchHostname = vi.fn(async () => null);
    const provider = createCloudflareProvider(
      testDeps({ spawn: spawnDouble(fake, MEASURED_STDERR), fetchHostname }),
    );

    const handle = await provider.start({ port: 3000, signal: liveSignal() });

    expect(handle.url).toBe(`https://${MEASURED_HOSTNAME}`);
    // The first candidate really was tried, not skipped.
    expect(fetchHostname).toHaveBeenCalled();
    expect(fetchHostname).toHaveBeenCalledWith(45678);
  });

  it('falls back only for a URL, never for a bad one', async () => {
    const fake = fakeCloudflared();
    const provider = createCloudflareProvider(
      testDeps({
        spawn: spawnDouble(fake, MEASURED_STDERR_WITHOUT_BANNER),
        timing: { urlWaitMs: 20, metricsPreferenceMs: 0, pollIntervalMs: 1 },
      }),
    );

    // The distractor URLs are in stderr the whole time and none of them is
    // accepted, so this times out rather than returning cloudflare.com.
    await expect(provider.start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
      /no public URL/,
    );
  });

  describe('the preference window is what keeps the first candidate first', () => {
    // Measured: the banner appears ~1s BEFORE the metrics server starts
    // listening. So without a window, the banner wins every race and
    // `/quicktunnel` is dead code. These two cases differ only in the window.
    const slowMetrics = (): (() => Promise<string | null>) => {
      let calls = 0;
      return async () => {
        calls += 1;
        return calls >= 3 ? 'from-the-metrics-api.trycloudflare.com' : null;
      };
    };

    it('waits for the metrics answer while the window is open', async () => {
      const fake = fakeCloudflared();
      const provider = createCloudflareProvider(
        testDeps({
          spawn: spawnDouble(fake, MEASURED_STDERR),
          fetchHostname: slowMetrics(),
          timing: { urlWaitMs: 2000, metricsPreferenceMs: 10_000, pollIntervalMs: 1 },
        }),
      );

      const handle = await provider.start({ port: 3000, signal: liveSignal() });
      expect(handle.url).toBe('https://from-the-metrics-api.trycloudflare.com');
    });

    it('would have taken the banner instead with the window closed', async () => {
      const fake = fakeCloudflared();
      const provider = createCloudflareProvider(
        testDeps({
          spawn: spawnDouble(fake, MEASURED_STDERR),
          fetchHostname: slowMetrics(),
          timing: { urlWaitMs: 2000, metricsPreferenceMs: 0, pollIntervalMs: 1 },
        }),
      );

      const handle = await provider.start({ port: 3000, signal: liveSignal() });
      expect(handle.url).toBe(`https://${MEASURED_HOSTNAME}`);
    });

    it('ships a window long enough to cover the measured gap', () => {
      // The banner led the metrics server by about a second in the live run.
      expect(DEFAULT_QUICK_TUNNEL_TIMING.metricsPreferenceMs).toBeGreaterThanOrEqual(2000);
      expect(DEFAULT_QUICK_TUNNEL_TIMING.metricsPreferenceMs).toBeLessThan(
        DEFAULT_QUICK_TUNNEL_TIMING.urlWaitMs,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('stop() (design §6.3, §6.4)', () => {
  const ownedHandle = (pid: number | null): RemoteHandle => ({
    provider: 'cloudflare-quick',
    url: `https://${MEASURED_HOSTNAME}`,
    owned: { pid, revert: null },
    preexisting: null,
  });

  it('sends exactly one SIGTERM, to exactly the owned pid', async () => {
    const kill = vi.fn();
    const provider = createCloudflareProvider(testDeps({ kill }));

    const outcome = await provider.stop(ownedHandle(50850));

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(50850, 'SIGTERM');
    expect(outcome).toEqual({ reverted: true, skipped: [], warnings: [] });
  });

  it('never spawns anything', async () => {
    // The structural half of the "no whole-account teardown" rule: a command
    // that acts on every tunnel this machine knows about would have to be
    // spawned, and `stop()` spawns nothing at all. The measured machine had a
    // named tunnel of the user's own running for nine days at the time — that is
    // exactly what such a command would have taken down.
    const spawn = spawnDouble(fakeCloudflared());
    const spawnSync = vi.fn(() => spawnSyncResult());
    const provider = createCloudflareProvider(testDeps({ spawn, spawnSync, kill: vi.fn() }));

    await provider.stop(ownedHandle(50850));

    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('does nothing at all when there is no owned pid', async () => {
    const kill = vi.fn();
    const provider = createCloudflareProvider(testDeps({ kill }));

    const outcome = await provider.stop(ownedHandle(null));

    expect(kill).not.toHaveBeenCalled();
    expect(outcome).toEqual({ reverted: true, skipped: [], warnings: [] });
  });

  it('treats an already-dead process as a clean stop', async () => {
    // The goal state is "that process is not running". It already is. Warning
    // about it would train people to ignore the warnings that matter.
    const kill = vi.fn(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    const provider = createCloudflareProvider(testDeps({ kill }));

    await expect(provider.stop(ownedHandle(50850))).resolves.toEqual({
      reverted: true,
      skipped: [],
      warnings: [],
    });
  });

  it('reports a signal it could not deliver instead of claiming success', async () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    const provider = createCloudflareProvider(testDeps({ kill }));

    const outcome = await provider.stop(ownedHandle(50850));

    expect(outcome.reverted).toBe(false);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain('50850');
    expect(outcome.warnings[0]).toContain('EPERM');
  });

  it('routes through planStop, so a preexisting key is skipped and reported', async () => {
    // Unreachable for a handle this Provider built (`revert` is always null),
    // but the shared §6.3-2 rule still runs, so the two Providers cannot drift.
    const kill = vi.fn();
    const provider = createCloudflareProvider(testDeps({ kill }));

    const outcome = await provider.stop({
      provider: 'cloudflare-quick',
      url: `https://${MEASURED_HOSTNAME}`,
      owned: { pid: 50850, revert: { mine: 'undo', theirs: 'undo' } },
      preexisting: { keys: ['theirs'], raw: { theirs: 'the user set this up' } },
    });

    expect(outcome.skipped).toEqual(['theirs']);
    expect(outcome.warnings.some((w) => w.includes('theirs'))).toBe(false);
    expect(outcome.warnings.some((w) => w.includes('mine'))).toBe(true);
    // The pid is still signalled: the process is unambiguously ours.
    expect(kill).toHaveBeenCalledWith(50850, 'SIGTERM');
  });

  it('really does signal a real process (default wiring)', async () => {
    // Everything above goes through the `kill` seam. This one uses the shipped
    // Provider and a live child, so "the default is wired to process.kill" is
    // measured rather than assumed.
    const child = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    const exitSignal = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once('exit', (_code, signal) => resolve(signal));
    });
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    expect(child.pid).toBeGreaterThan(0);

    const outcome = await cloudflareProvider.stop({
      provider: 'cloudflare-quick',
      url: `https://${MEASURED_HOSTNAME}`,
      owned: { pid: child.pid ?? -1, revert: null },
      preexisting: null,
    });

    expect(outcome).toEqual({ reverted: true, skipped: [], warnings: [] });
    await expect(exitSignal).resolves.toBe('SIGTERM');
  });
});

// ---------------------------------------------------------------------------
// The metrics port
// ---------------------------------------------------------------------------

describe('findFreeLoopbackPort', () => {
  it('returns a usable port and does not hold it', async () => {
    const port = await findFreeLoopbackPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);

    // If the probe still held the port, this second call could not be handed
    // the same range and cloudflared would fail to bind its metrics listener.
    const second = await findFreeLoopbackPort();
    expect(Number.isInteger(second)).toBe(true);
  });
});
