/**
 * Tailscale Serve Provider (Issue #1937, R3).
 *
 * Every fixture in this file is a verbatim capture from the U-2 measurement on
 * 2026-08-29 against Tailscale 1.102.3 on macOS. The raw session, including the
 * commands that were deliberately *not* run, is in
 * `dev-reports/issue/1937/u2-tailscale-serve.md`.
 *
 * The suite is built around a small simulator rather than a bag of stubs
 * (`harness()` below), because the property that matters most — "`stop()`
 * removes our handler and leaves the user's alone" — is a statement about the
 * configuration *afterwards*, not about which functions were called. The
 * simulator reproduces the two measured behaviours that make that property
 * non-trivial:
 *
 * - `serve ... --set-path <path> off` removes exactly one handler.
 * - `serve` over an already-served path silently overwrites it and exits 0.
 *
 * So the live measurement and this suite assert the same thing in the same
 * shape, and a regression in either is visible in the other.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'child_process';

import {
  BACKEND_STATE_RUNNING,
  buildServeArgs,
  buildServeOffArgs,
  buildServeUrl,
  createTailscaleProvider,
  DETECT_TIMEOUT_MS,
  LOOPBACK_HOST,
  normalizeDnsName,
  parseServeConfig,
  parseServeHandlerKey,
  readServeReadiness,
  SERVE_HTTPS_PORT,
  SERVE_PATH,
  serveHandlerKey,
  serveHandlerKeys,
  snapshotServeConfig,
  TAILSCALE_BIN,
  TAILSCALE_VERSION_ARG,
  tailscaleProvider,
  type ServeConfig,
} from '@/lib/remote/tailscale';
import type { RemoteHandle } from '@/lib/remote/types';

// ---------------------------------------------------------------------------
// Measured fixtures
// ---------------------------------------------------------------------------

/** `tailscale version` — first line is the number, the rest is provenance. */
const VERSION_STDOUT = [
  '1.102.3',
  '  tailscale commit: 9329c3677031109ff6d0b80abee0cddc8f35ff6f',
  '  long version: 1.102.3-t9329c3677-ga522f65e9',
  '',
].join('\n');

const NODE_DNS_NAME = 'maenomac-studio.taile4f402.ts.net';

/** `tailscale status --json`, reduced to the keys this Provider reads. */
const STATUS_JSON = JSON.stringify({
  BackendState: 'Running',
  MagicDNSSuffix: 'taile4f402.ts.net',
  CertDomains: [NODE_DNS_NAME],
  // Measured with a trailing dot; the Serve config's own key has none.
  Self: { DNSName: `${NODE_DNS_NAME}.`, Online: true, HostName: 'maenomac-studio' },
  Version: '1.102.3-t9329c3677-ga522f65e9',
});

/** Measured: what the command prints when nothing at all is served. */
const SERVE_STATUS_EMPTY = '{}\n';

/** Measured: the user's own handler alongside CommandMate's, both on 443. */
const SERVE_STATUS_TWO_HANDLERS = JSON.stringify(
  {
    TCP: { '443': { HTTPS: true } },
    Web: {
      [`${NODE_DNS_NAME}:443`]: {
        Handlers: {
          '/': { Proxy: 'http://127.0.0.1:19002' },
          '/u2-existing-user': { Proxy: 'http://127.0.0.1:19001' },
        },
      },
    },
  },
  null,
  2,
);

/** The key the user's own handler is known by, in the shared keyspace. */
const USER_KEY = `${NODE_DNS_NAME}:443/u2-existing-user`;
/** The key CommandMate publishes on. */
const OURS_KEY = `${NODE_DNS_NAME}:443/`;

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

interface Invocation {
  command: string;
  args: string[];
  options: SpawnSyncOptionsWithStringEncoding;
}

function reply(overrides: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    pid: 4242,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

interface HarnessOptions {
  /** Handlers already configured before `start()` runs. */
  initialHandlers?: Record<string, string>;
  /** Overrides `TCP.<port>` so a non-HTTPS occupant can be simulated. */
  tcp?: ServeConfig['TCP'];
  /** `tailscale status --json` stdout. Defaults to the measured, ready node. */
  statusJson?: string;
  /** Fails `serve status --json` with this message when set. */
  serveStatusError?: string;
  /** Fails the create invocation when set. */
  serveCreateStatus?: number;
  /** Fails every `off` invocation when set. */
  serveOffStatus?: number;
  /** Makes the create a no-op, simulating "exit 0 but nothing happened". */
  swallowCreate?: boolean;
}

/**
 * A stand-in for `tailscale` that keeps real Serve state.
 *
 * Only the behaviours that were actually measured are modelled. In particular
 * `off` removes exactly the `--set-path` handler and nothing else, and a create
 * over an existing path overwrites it — the two facts the Provider is built
 * around.
 */
function harness(options: HarnessOptions = {}) {
  const handlers: Record<string, string> = { ...(options.initialHandlers ?? {}) };
  const calls: Invocation[] = [];

  const currentConfig = (): ServeConfig => {
    if (Object.keys(handlers).length === 0) return {};
    return {
      TCP: options.tcp ?? { '443': { HTTPS: true } },
      Web: {
        [`${NODE_DNS_NAME}:443`]: {
          Handlers: Object.fromEntries(
            Object.entries(handlers).map(([path, proxy]) => [path, { Proxy: proxy }]),
          ),
        },
      },
    };
  };

  const spawnSync = vi.fn(
    (
      command: string,
      args: readonly string[],
      opts: SpawnSyncOptionsWithStringEncoding,
    ): SpawnSyncReturns<string> => {
      calls.push({ command, args: [...args], options: opts });

      if (args[0] === TAILSCALE_VERSION_ARG) return reply({ stdout: VERSION_STDOUT });
      if (args[0] === 'status') return reply({ stdout: options.statusJson ?? STATUS_JSON });

      if (args[0] === 'serve' && args[1] === 'status') {
        if (options.serveStatusError !== undefined) {
          return reply({ status: 1, stderr: options.serveStatusError });
        }
        const config = currentConfig();
        // Measured: an unconfigured node prints `{}`, not an empty document.
        const text =
          Object.keys(handlers).length === 0 ? SERVE_STATUS_EMPTY : JSON.stringify(config);
        return reply({ stdout: text });
      }

      if (args[0] === 'serve' && args.includes('off')) {
        if (options.serveOffStatus !== undefined) {
          return reply({ status: options.serveOffStatus, stderr: 'off refused' });
        }
        const pathIndex = args.indexOf('--set-path');
        // The simulator refuses to model the untargeted form on purpose: if the
        // Provider ever builds one, the test fails loudly here rather than
        // quietly passing against a fiction.
        if (pathIndex === -1) throw new Error('untargeted off: the Provider must never build this');
        delete handlers[args[pathIndex + 1]];
        return reply({});
      }

      if (args[0] === 'serve') {
        if (options.serveCreateStatus !== undefined) {
          return reply({ status: options.serveCreateStatus, stderr: 'serve refused' });
        }
        if (options.swallowCreate === true) return reply({ stdout: 'Serve started' });
        const pathIndex = args.indexOf('--set-path');
        const upstream = args[args.length - 1];
        // Measured: this overwrites an existing handler without complaint.
        handlers[args[pathIndex + 1]] = upstream;
        return reply({ stdout: 'Serve started and running in the background.' });
      }

      throw new Error(`unexpected argv: ${args.join(' ')}`);
    },
  );

  return {
    spawnSync,
    calls,
    handlers,
    /** Every argv the Provider ran, flattened for substring assertions. */
    argvStrings: () => calls.map((call) => call.args.join(' ')),
    provider: (extra: Record<string, unknown> = {}) =>
      createTailscaleProvider({ spawnSync, ...extra }),
  };
}

const liveSignal = (): AbortSignal => new AbortController().signal;

// ---------------------------------------------------------------------------

describe('serve status parsing (measured shapes)', () => {
  it('reads an unconfigured node as an empty config, not as a failure', () => {
    // Measured: `{}` with exit 0. Treating this as unreadable would make the
    // Provider refuse to start on exactly the machine where it is safest.
    expect(parseServeConfig(SERVE_STATUS_EMPTY)).toEqual({});
    expect(parseServeConfig('   ')).toEqual({});
    expect(serveHandlerKeys(parseServeConfig(SERVE_STATUS_EMPTY) as ServeConfig)).toEqual([]);
  });

  it('lists both handlers of the measured two-handler config, sorted', () => {
    const config = parseServeConfig(SERVE_STATUS_TWO_HANDLERS) as ServeConfig;
    expect(serveHandlerKeys(config)).toEqual([OURS_KEY, USER_KEY]);
  });

  it('reports unparseable output as null rather than as an empty config', () => {
    // The difference decides whether `start()` refuses or proceeds believing
    // the user has nothing to protect.
    expect(parseServeConfig('not json')).toBeNull();
    expect(parseServeConfig('[1,2]')).toBeNull();
    expect(parseServeConfig('"a string"')).toBeNull();
  });

  it('snapshots into the shape planStop() reads', () => {
    const snapshot = snapshotServeConfig(parseServeConfig(SERVE_STATUS_TWO_HANDLERS) as ServeConfig);
    expect(snapshot.keys).toEqual([OURS_KEY, USER_KEY]);
    expect(snapshot.raw).toEqual(JSON.parse(SERVE_STATUS_TWO_HANDLERS));
  });
});

describe('handler keys', () => {
  it('drops the trailing dot so a status name and a serve key can be compared', () => {
    // Measured: `Self.DNSName` ends in a dot, the Serve `Web` key does not.
    expect(normalizeDnsName(`${NODE_DNS_NAME}.`)).toBe(NODE_DNS_NAME);
    expect(normalizeDnsName(NODE_DNS_NAME)).toBe(NODE_DNS_NAME);
    expect(serveHandlerKey(`${NODE_DNS_NAME}.`, 443, '/')).toBe(OURS_KEY);
  });

  it('round-trips through the undo parser', () => {
    for (const path of ['/', '/u2-existing-user', '/a/b']) {
      const key = serveHandlerKey(NODE_DNS_NAME, 443, path);
      expect(parseServeHandlerKey(key)).toEqual({ host: NODE_DNS_NAME, port: 443, path });
    }
    expect(parseServeHandlerKey(`${NODE_DNS_NAME}:8443/x`)?.port).toBe(8443);
  });

  it('returns null instead of guessing at a malformed key', () => {
    // A key with no derivable path is a key whose targeted undo cannot be
    // built, and the untargeted alternative wipes the port.
    for (const bad of [
      '',
      'no-slash',
      `${NODE_DNS_NAME}/`, // no port
      `${NODE_DNS_NAME}:/`, // empty port
      `${NODE_DNS_NAME}:notaport/`,
      `${NODE_DNS_NAME}:0/`,
      `${NODE_DNS_NAME}:70000/`,
      '/leading-slash',
    ]) {
      expect(parseServeHandlerKey(bad), bad).toBeNull();
    }
  });

  it('builds the URL the QR code will carry', () => {
    expect(buildServeUrl(`${NODE_DNS_NAME}.`, 443)).toBe(`https://${NODE_DNS_NAME}`);
    expect(buildServeUrl(NODE_DNS_NAME, 8443)).toBe(`https://${NODE_DNS_NAME}:8443`);
  });
});

describe('argv (design §9.2: the upstream is always 127.0.0.1)', () => {
  it('names loopback explicitly and never any other interface', () => {
    const args = buildServeArgs({ servePort: 443, servePath: '/', upstreamPort: 3000 });
    expect(args).toEqual([
      'serve',
      '--bg',
      '--yes',
      '--https=443',
      '--set-path',
      '/',
      'http://127.0.0.1:3000',
    ]);
    const joined = args.join(' ');
    expect(joined).toContain(`http://${LOOPBACK_HOST}:3000`);
    expect(joined).not.toContain('0.0.0.0');
    expect(joined).not.toContain('localhost');
    expect(joined).not.toContain('::');
  });

  it('keeps loopback fixed no matter what port is asked for', () => {
    for (const port of [1, 3000, 65535]) {
      const joined = buildServeArgs({ servePort: 443, servePath: '/', upstreamPort: port }).join(' ');
      expect(joined).toContain(`http://${LOOPBACK_HOST}:${String(port)}`);
      expect(joined).not.toMatch(/0\.0\.0\.0|localhost/);
    }
  });

  it('always scopes the undo to one path', () => {
    // MEASURED: without `--set-path`, `off` removes every handler on the port.
    // This is the only place an `off` argv is built, and it cannot omit it.
    const args = buildServeOffArgs({ host: NODE_DNS_NAME, port: 443, path: '/' });
    expect(args).toEqual(['serve', '--https=443', '--set-path', '/', '--yes', 'off']);
    expect(args.indexOf('--set-path')).toBeGreaterThan(-1);
    expect(args.indexOf('--set-path')).toBeLessThan(args.indexOf('off'));
    expect(args[args.indexOf('--set-path') + 1]).toBe('/');
  });

  it('carries the path from the key it is undoing, not from a default', () => {
    const args = buildServeOffArgs({ host: NODE_DNS_NAME, port: 8443, path: '/u2-existing-user' });
    expect(args).toEqual([
      'serve',
      '--https=8443',
      '--set-path',
      '/u2-existing-user',
      '--yes',
      'off',
    ]);
  });
});

describe('readServeReadiness (measured signals)', () => {
  it('is ready when the backend is Running and a MagicDNS name exists', () => {
    expect(readServeReadiness(STATUS_JSON)).toEqual({ ready: true, dnsName: NODE_DNS_NAME });
    expect(BACKEND_STATE_RUNNING).toBe('Running');
  });

  it('is not ready when the node is not connected', () => {
    const readiness = readServeReadiness(JSON.stringify({ BackendState: 'NeedsLogin' }));
    expect(readiness.ready).toBe(false);
    expect(readiness.dnsName).toBeNull();
    expect(readiness.reason).toContain('NeedsLogin');
  });

  it('is not ready when the node is Running but has no MagicDNS name', () => {
    // The two signals fail independently, which is why both are checked: a
    // tailnet with MagicDNS off is Running with nothing to publish under.
    const readiness = readServeReadiness(
      JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: 'x.ts.net', Self: {} }),
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('MagicDNS');
  });

  it('is not ready when the output cannot be parsed', () => {
    expect(readServeReadiness('tailscaled is not running').ready).toBe(false);
    expect(readServeReadiness('null').ready).toBe(false);
  });
});

describe('detect(): available and ready are answered separately (§6.1)', () => {
  it('probes with array args and the shared 5s budget, never through a shell', () => {
    const h = harness();
    return h
      .provider()
      .detect()
      .then((detection) => {
        expect(detection).toEqual({ available: true, version: '1.102.3', ready: true });
        expect(h.calls[0].command).toBe(TAILSCALE_BIN);
        expect(h.calls[0].args).toEqual([TAILSCALE_VERSION_ARG]);
        expect(h.calls[0].options.timeout).toBe(DETECT_TIMEOUT_MS);
        // MF-SEC-1: no `shell`, and the args stayed an array.
        expect(h.calls[0].options).not.toHaveProperty('shell');
      });
  });

  it('has no side effects: it never touches the serve configuration', async () => {
    const h = harness({ initialHandlers: { '/u2-existing-user': 'http://127.0.0.1:19001' } });
    await h.provider().detect();
    // Reading `serve status` would be harmless, but a create or an `off` would
    // not be, and `detect()` is called on every `remote status`.
    for (const argv of h.argvStrings()) {
      expect(argv).not.toContain('off');
      expect(argv).not.toContain('--bg');
    }
    expect(h.handlers).toEqual({ '/u2-existing-user': 'http://127.0.0.1:19001' });
  });

  it('reports "not installed" for ENOENT', async () => {
    const spawnSync = vi.fn(() => {
      const error = new Error('spawn tailscale ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return reply({ error, status: null });
    });
    await expect(createTailscaleProvider({ spawnSync }).detect()).resolves.toEqual({
      available: false,
      ready: false,
      reason: 'tailscale is not installed',
    });
  });

  it('stays available but not ready when the node is logged out', async () => {
    // This is the split the orchestrator's selection rule is written against:
    // "installed but unusable" must not read as "install Tailscale".
    const h = harness({ statusJson: JSON.stringify({ BackendState: 'NeedsLogin' }) });
    const detection = await h.provider().detect();
    expect(detection.available).toBe(true);
    expect(detection.version).toBe('1.102.3');
    expect(detection.ready).toBe(false);
    expect(detection.reason).toContain('NeedsLogin');
  });

  it('stays available but not ready when status itself fails', async () => {
    const spawnSync = vi.fn((_cmd: string, args: readonly string[]) =>
      args[0] === TAILSCALE_VERSION_ARG
        ? reply({ stdout: VERSION_STDOUT })
        : reply({ status: 1, stderr: 'failed to connect to local tailscaled' }),
    );
    const detection = await createTailscaleProvider({ spawnSync }).detect();
    expect(detection.available).toBe(true);
    expect(detection.ready).toBe(false);
    expect(detection.reason).toContain('exited with 1');
  });

  it('is unavailable when the executable answers non-zero', async () => {
    const spawnSync = vi.fn(() => reply({ status: 127, stderr: 'bad' }));
    const detection = await createTailscaleProvider({ spawnSync }).detect();
    expect(detection.available).toBe(false);
    expect(detection.ready).toBe(false);
  });
});

describe('start(): fills preexisting, and refuses to overwrite (§6.3-2)', () => {
  it('returns a handle whose preexisting is the pre-start snapshot', async () => {
    // The user is already serving `/u2-existing-user`. That key must appear in
    // `preexisting` — it is what makes it untouchable later.
    const h = harness({ initialHandlers: { '/u2-existing-user': 'http://127.0.0.1:19001' } });
    const handle = await h.provider().start({ port: 3000, signal: liveSignal() });

    expect(handle.provider).toBe('tailscale-serve');
    expect(handle.url).toBe(`https://${NODE_DNS_NAME}`);
    expect(handle.owned.pid).toBeNull();
    expect(handle.owned.revert).toEqual({ [OURS_KEY]: 'http://127.0.0.1:3000' });
    expect(handle.preexisting).toEqual({
      keys: [USER_KEY],
      raw: expect.objectContaining({ Web: expect.any(Object) }),
    });
    // Snapshot before create: the snapshot must not contain our own handler.
    expect((handle.preexisting as { keys: string[] }).keys).not.toContain(OURS_KEY);
  });

  it('fills preexisting with an empty key list on a clean node', async () => {
    // Measured baseline for this machine. `keys: []` protects nothing, which is
    // correct; it is not the same as "no snapshot was taken".
    const h = harness();
    const handle = await h.provider().start({ port: 3000, signal: liveSignal() });
    expect(handle.preexisting).toEqual({ keys: [], raw: {} });
  });

  it('publishes the loopback upstream and nothing else', async () => {
    const h = harness();
    await h.provider().start({ port: 3000, signal: liveSignal() });
    const create = h.calls.find((call) => call.args.includes('--bg'));
    expect(create?.args).toEqual([
      'serve',
      '--bg',
      '--yes',
      `--https=${String(SERVE_HTTPS_PORT)}`,
      '--set-path',
      SERVE_PATH,
      'http://127.0.0.1:3000',
    ]);
    expect(create?.args.join(' ')).not.toMatch(/0\.0\.0\.0|localhost/);
  });

  it('refuses when the path it wants is already served, and creates nothing', async () => {
    // MEASURED: `serve` over an occupied path overwrites it and exits 0, with
    // the previous upstream unrecoverable. §6.3-2 protects `stop()`, not
    // `start()`, so the only safe answer is to not start.
    const h = harness({ initialHandlers: { '/': 'http://127.0.0.1:19001' } });
    await expect(h.provider().start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
      /already served/,
    );
    // The user's handler is untouched, and no create was attempted.
    expect(h.handlers).toEqual({ '/': 'http://127.0.0.1:19001' });
    expect(h.argvStrings().some((argv) => argv.includes('--bg'))).toBe(false);
  });

  it('names the upstream it refused to displace, so the message is actionable', async () => {
    const h = harness({ initialHandlers: { '/': 'http://127.0.0.1:19001' } });
    await expect(h.provider().start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
      /http:\/\/127\.0\.0\.1:19001/,
    );
  });

  it('refuses when the port is held for something other than HTTPS', async () => {
    const h = harness({
      initialHandlers: { '/keeps-the-web-block': 'http://127.0.0.1:19001' },
      tcp: { '443': { TCPForward: '127.0.0.1:5432' } },
    });
    await expect(h.provider().start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
      /TCP forwarder/,
    );
    expect(h.argvStrings().some((argv) => argv.includes('--bg'))).toBe(false);
  });

  it('refuses to start without a snapshot rather than starting with an empty one', async () => {
    // An unreadable snapshot that degraded to `{keys: []}` would tell `stop()`
    // the user has nothing to protect — the precise failure §6.3-2 exists for.
    const h = harness({ serveStatusError: 'failed to connect to local tailscaled' });
    await expect(h.provider().start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
      /snapshot/,
    );
    expect(h.argvStrings().some((argv) => argv.includes('--bg'))).toBe(false);
  });

  it('refuses when the node is not ready', async () => {
    const h = harness({ statusJson: JSON.stringify({ BackendState: 'Stopped' }) });
    await expect(h.provider().start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
      /Stopped/,
    );
  });

  it('refuses an out-of-range upstream port before anything is spawned', async () => {
    const h = harness();
    for (const port of [0, -1, 70000, 1.5, Number.NaN]) {
      await expect(h.provider().start({ port, signal: liveSignal() })).rejects.toThrow(/1-65535/);
    }
    expect(h.calls).toHaveLength(0);
  });

  it('honours an abort before anything is spawned', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.provider().start({ port: 3000, signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect(h.calls).toHaveLength(0);
  });

  it('fails when the handler did not appear, instead of returning a dead URL', async () => {
    // Exit 0 is not proof: the handle becomes a QR code, and a QR code for a
    // handler that does not exist is worse than an error.
    const h = harness({ swallowCreate: true });
    await expect(h.provider().start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
      /was not created/,
    );
  });

  it('fails when the serve command itself fails', async () => {
    const h = harness({ serveCreateStatus: 1 });
    await expect(h.provider().start({ port: 3000, signal: liveSignal() })).rejects.toThrow(
      /exited with 1/,
    );
  });
});

describe('stop(): removes only what CommandMate created (§6.3-2, U-2)', () => {
  it('is the unit mirror of the live measurement: ours goes, theirs stays', async () => {
    // The whole point of U-2. Start with the user already serving
    // `/u2-existing-user`, let the Provider publish `/`, then stop.
    const h = harness({ initialHandlers: { '/u2-existing-user': 'http://127.0.0.1:19001' } });
    const provider = h.provider();

    const handle = await provider.start({ port: 3000, signal: liveSignal() });
    expect(Object.keys(h.handlers).sort()).toEqual(['/', '/u2-existing-user']);

    const outcome = await provider.stop(handle);

    expect(outcome).toEqual({ reverted: true, skipped: [], warnings: [] });
    // Measured equivalent: `serve status --json` still lists the user's handler.
    expect(h.handlers).toEqual({ '/u2-existing-user': 'http://127.0.0.1:19001' });
  });

  it('scopes the removal argv to our path and never names theirs', async () => {
    const h = harness({ initialHandlers: { '/u2-existing-user': 'http://127.0.0.1:19001' } });
    const provider = h.provider();
    const handle = await provider.start({ port: 3000, signal: liveSignal() });
    const before = h.calls.length;

    await provider.stop(handle);

    const offCalls = h.calls.slice(before);
    expect(offCalls).toHaveLength(1);
    expect(offCalls[0].args).toEqual(['serve', '--https=443', '--set-path', '/', '--yes', 'off']);
    // The user's path must not appear anywhere in a command we ran.
    for (const argv of h.argvStrings()) {
      expect(argv).not.toContain('/u2-existing-user');
    }
  });

  it('skips - and reports - a key that was already there', async () => {
    // A handle whose owned key is also in `preexisting`. Reverting it would
    // delete the user's configuration; the skip is what makes that visible.
    const h = harness({ initialHandlers: { '/': 'http://127.0.0.1:19001' } });
    const handle: RemoteHandle = {
      provider: 'tailscale-serve',
      url: `https://${NODE_DNS_NAME}`,
      owned: { pid: null, revert: { [OURS_KEY]: 'http://127.0.0.1:3000' } },
      preexisting: { keys: [OURS_KEY], raw: {} },
    };

    const outcome = await h.provider().stop(handle);

    expect(outcome.skipped).toEqual([OURS_KEY]);
    expect(outcome.reverted).toBe(true);
    expect(outcome.warnings).toEqual([]);
    // Nothing was run at all, so the user's handler is intact.
    expect(h.calls).toHaveLength(0);
    expect(h.handlers).toEqual({ '/': 'http://127.0.0.1:19001' });
  });

  it('reverts the owned keys and skips the preexisting ones in the same handle', async () => {
    const h = harness({
      initialHandlers: {
        '/': 'http://127.0.0.1:3000',
        '/u2-existing-user': 'http://127.0.0.1:19001',
      },
    });
    const handle: RemoteHandle = {
      provider: 'tailscale-serve',
      url: `https://${NODE_DNS_NAME}`,
      owned: {
        pid: null,
        revert: { [OURS_KEY]: 'http://127.0.0.1:3000', [USER_KEY]: 'http://127.0.0.1:19001' },
      },
      preexisting: { keys: [USER_KEY], raw: {} },
    };

    const outcome = await h.provider().stop(handle);

    expect(outcome.skipped).toEqual([USER_KEY]);
    expect(h.handlers).toEqual({ '/u2-existing-user': 'http://127.0.0.1:19001' });
  });

  it('refuses to guess a removal command for an unparseable key', async () => {
    // The imprecise alternative is the one that wipes the port, so "leave it
    // and say so" is the only correct answer here.
    const h = harness({ initialHandlers: { '/': 'http://127.0.0.1:3000' } });
    const outcome = await h.provider().stop({
      provider: 'tailscale-serve',
      url: `https://${NODE_DNS_NAME}`,
      owned: { pid: null, revert: { 'garbage-key': 'http://127.0.0.1:3000' } },
      preexisting: { keys: [], raw: {} },
    });

    expect(outcome.reverted).toBe(false);
    expect(outcome.warnings.join(' ')).toContain('garbage-key');
    expect(h.calls).toHaveLength(0);
    expect(h.handlers).toEqual({ '/': 'http://127.0.0.1:3000' });
  });

  it('will not signal a pid, because this Provider never creates one', async () => {
    // Serve is configuration held by tailscaled. A handle carrying a pid did
    // not come from here, and killing an unknown process is not a teardown step
    // this Provider is entitled to take.
    const h = harness();
    const outcome = await h.provider().stop({
      provider: 'tailscale-serve',
      url: `https://${NODE_DNS_NAME}`,
      owned: { pid: 9999, revert: null },
      preexisting: { keys: [], raw: {} },
    });
    expect(outcome.reverted).toBe(false);
    expect(outcome.warnings.join(' ')).toContain('9999');
    expect(outcome.warnings.join(' ')).toContain('left alone');
  });

  it('reports a failed removal instead of claiming a clean stop', async () => {
    const h = harness({ initialHandlers: { '/': 'http://127.0.0.1:3000' }, serveOffStatus: 1 });
    const outcome = await h.provider().stop({
      provider: 'tailscale-serve',
      url: `https://${NODE_DNS_NAME}`,
      owned: { pid: null, revert: { [OURS_KEY]: 'http://127.0.0.1:3000' } },
      preexisting: { keys: [], raw: {} },
    });
    expect(outcome.reverted).toBe(false);
    expect(outcome.warnings.join(' ')).toContain(OURS_KEY);
  });

  it('is a clean no-op for a handle with nothing owned', async () => {
    const h = harness();
    await expect(
      h.provider().stop({
        provider: 'tailscale-serve',
        url: `https://${NODE_DNS_NAME}`,
        owned: { pid: null, revert: null },
        preexisting: { keys: [], raw: {} },
      }),
    ).resolves.toEqual({ reverted: true, skipped: [], warnings: [] });
    expect(h.calls).toHaveLength(0);
  });
});

describe('the shipped Provider', () => {
  it('exposes exactly the four members RemoteProvider declares (§6.3-1)', () => {
    // The deps seam stays closed over inside `createTailscaleProvider` rather
    // than becoming a fifth key, so `reset()` has nowhere to hide.
    expect(Object.keys(tailscaleProvider).sort()).toEqual(['detect', 'id', 'start', 'stop']);
    expect(tailscaleProvider.id).toBe('tailscale-serve');
  });

  it('no longer advertises itself as unimplemented', async () => {
    // R3's replacement for the stub assertions: `detect()` now reports what the
    // machine actually is. On a machine with no `tailscale` that is
    // `available: false` with an installation reason - never a hard-coded
    // "not implemented", which a caller could read and act on wrongly.
    const detection = await tailscaleProvider.detect();
    expect(detection.reason ?? '').not.toMatch(/not implemented/i);
    if (!detection.available) expect(detection.ready).toBe(false);
  });
});
