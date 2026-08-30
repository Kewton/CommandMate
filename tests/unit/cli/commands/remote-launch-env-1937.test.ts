/**
 * `commandmate remote` puts no secret, no `CM_BIND` and no Auto-Yes switch into
 * the environment of the server it starts (Issue #1937, R10 — design §9.2).
 *
 * ## What is at stake
 *
 * The server's environment is not the server's alone. §1.3 measured that
 * `src/lib/tmux/**` passes no `env:` when it spawns a pane, so a pane inherits
 * the server's environment wholesale, and `sanitizeEnvForChildProcess()` is
 * called in only two places that an agent pane does not go through. Anything
 * `remote` exports therefore ends up readable by the very Claude / Codex /
 * OpenCode processes CommandMate is driving — which is exactly why #1996 had to
 * add `CM_AUTH_TOKEN` to `SENSITIVE_ENV_KEYS` after measuring it in a real
 * child.
 *
 * §7.2's answer was to keep the secret out of the environment entirely: the
 * plaintext session token and the pairing hash go into ONE 0600 handoff file,
 * and only its PATH travels in `CM_REMOTE_PAIRING_FILE`. That decision is what
 * makes `src/lib/security/env-sanitizer.ts` untouched by this Issue — and it
 * holds only while the implementation really does keep the secret out. This
 * file is the measurement that says it does.
 *
 * ## Why an exact set, in both directions
 *
 * Modelled on `tests/unit/lib/agent-launch-plan-secrets-1933.test.ts`, which
 * pins `prepareLaunch`'s env keys exactly. An allowlist ("nothing sensitive is
 * present") passes for a key nobody has looked at; an exact set fails the
 * moment a new variable appears, whatever it is called, and equally when a
 * declared one disappears.
 *
 * What is measured is `remote`'s CONTRIBUTION: `process.env` is snapshotted
 * immediately before `runRemoteUp` and again inside the `runStart` mock, and
 * the difference is compared with `REMOTE_LAUNCH_ENV_KEYS`. Everything else the
 * child receives comes from `start`/`daemon.ts` merging `process.env` with
 * `.env`, which is the pre-existing behaviour `remote` deliberately does not
 * reimplement.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'cm-remote-env-1937-'));

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
vi.mock('../../../../src/cli/utils/server-ready', () => ({ waitForServer: vi.fn(async () => true) }));
vi.mock('../../../../src/cli/utils/prompt', () => ({
  isInteractive: vi.fn(() => false),
  confirm: vi.fn(async () => false),
  closeReadline: vi.fn(),
}));
vi.mock('../../../../src/cli/utils/daemon', () => ({
  // A class, not `vi.fn(() => ({...}))`: `remote.ts` calls `new DaemonManager()`.
  DaemonManager: class {
    async isRunning(): Promise<boolean> {
      return false;
    }
    async getStatus(): Promise<null> {
      return null;
    }
    async stop(): Promise<boolean> {
      return true;
    }
  },
}));
vi.mock('../../../../src/cli/commands/start', () => ({ runStart: vi.fn() }));
vi.mock('../../../../src/lib/remote', () => ({
  detectRemoteProviders: vi.fn(),
  createRemoteProviders: vi.fn(() => []),
}));

import {
  REMOTE_LAUNCH_ENV_KEYS,
  buildRemoteLaunchEnv,
  runRemoteUp,
} from '../../../../src/cli/commands/remote';
import { ExitCode } from '../../../../src/cli/types';
import { runStart } from '../../../../src/cli/commands/start';
import { detectRemoteProviders } from '../../../../src/lib/remote';
import {
  PAIRING_FILE_ENV_KEY,
  consumePairingHandoff,
  readPairingHandoff,
} from '../../../../src/lib/security/pairing-code';
import type { StartOptions } from '../../../../src/cli/types';
import type { RemoteHandle } from '../../../../src/lib/remote';

/** A Provider that is ready and hands back a handle, so `up` reaches the end. */
function readyProvider(): {
  provider: { id: 'tailscale-serve'; detect: () => Promise<unknown>; start: () => Promise<RemoteHandle>; stop: () => Promise<unknown> };
  detection: { available: true; ready: true };
} {
  const handle: RemoteHandle = {
    provider: 'tailscale-serve',
    url: 'https://probe-1937.example-tailnet.ts.net',
    owned: { pid: null, revert: null },
    preexisting: null,
  };
  return {
    provider: {
      id: 'tailscale-serve',
      detect: vi.fn(async () => ({ available: true, ready: true })),
      start: vi.fn(async () => handle),
      stop: vi.fn(async () => ({ reverted: true, skipped: [], warnings: [] })),
    },
    detection: { available: true, ready: true },
  };
}

/** What `runRemoteUp` added to `process.env` by the time it called `runStart`. */
interface LaunchObservation {
  exitCode: ExitCode;
  addedKeys: string[];
  added: Record<string, string | undefined>;
  startOptions: StartOptions | undefined;
}

async function observeLaunch(): Promise<LaunchObservation> {
  const before = { ...process.env };
  // Recorded as a plain map rather than a `NodeJS.ProcessEnv`: the repo types
  // `NODE_ENV` as required on that interface, and this is a snapshot, not an
  // environment to hand anywhere.
  let atStart: Record<string, string | undefined> | null = null;
  let startOptions: StartOptions | undefined;

  vi.mocked(runStart).mockImplementation(async (options: StartOptions) => {
    startOptions = options;
    atStart = { ...process.env };
    return { ok: true, exitCode: ExitCode.SUCCESS, url: 'http://127.0.0.1:3000', pid: 4242 };
  });

  const exitCode = await runRemoteUp({});

  const snapshot: Record<string, string | undefined> = atStart ?? {};
  const addedKeys = Object.keys(snapshot).filter((key) => before[key] !== snapshot[key]);
  const added: Record<string, string | undefined> = {};
  for (const key of addedKeys) added[key] = snapshot[key];

  return { exitCode, addedKeys, added, startOptions };
}

describe('remote launch environment (Issue #1937 R10, §9.2)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(detectRemoteProviders).mockResolvedValue([
      readyProvider(),
    ] as unknown as Awaited<ReturnType<typeof detectRemoteProviders>>);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('adds exactly the declared variables, and nothing else', async () => {
    const observed = await observeLaunch();

    expect(observed.exitCode).toBe(ExitCode.SUCCESS);
    // Both directions: a new variable fails here by name, and so does dropping
    // a declared one.
    expect(observed.addedKeys.sort()).toEqual([...REMOTE_LAUNCH_ENV_KEYS].sort());
  });

  it('does not touch CM_BIND', async () => {
    // §9.1: `remote` neither reads nor writes CM_BIND. A user already running
    // CM_BIND=0.0.0.0 keeps that setting; a user on the 127.0.0.1 default keeps
    // theirs. The Provider is handed 127.0.0.1 explicitly instead.
    // A value nothing would ever write on its own, so a mutation that sets
    // CM_BIND to any of the plausible defaults still shows up in the delta.
    process.env.CM_BIND = '127.0.0.55';
    const observed = await observeLaunch();

    expect(observed.addedKeys).not.toContain('CM_BIND');
    expect(observed.added.CM_BIND).toBeUndefined();
    expect(process.env.CM_BIND).toBe('127.0.0.55');
  });

  it('carries no Auto-Yes activation key', async () => {
    // §5.5: Auto-Yes lives in an in-memory map that is empty at server start,
    // so a server `remote` starts has it off everywhere. The structural half of
    // that promise is that no flag and no env key can turn it on at launch.
    const observed = await observeLaunch();

    for (const key of observed.addedKeys) {
      expect(key).not.toMatch(/auto[_-]?yes/i);
    }
  });

  it('carries no plaintext secret - only a hash and a path', async () => {
    const observed = await observeLaunch();

    const pairingFile = observed.added[PAIRING_FILE_ENV_KEY];
    expect(pairingFile).toBeTruthy();

    const handoff = readPairingHandoff(pairingFile as string);
    expect(handoff).not.toBeNull();

    // The two secrets in the handoff file are the session token and the code's
    // hash. Neither may appear anywhere in the launch environment - not under
    // its own key, not under any other.
    const values = Object.values(observed.added);
    expect(values).not.toContain(handoff?.sessionToken);
    expect(values).not.toContain(handoff?.pairingHash);

    // What IS exported is the hash of the token, which is what `start --auth`
    // exports too and what `middleware.ts` compares against.
    expect(observed.added.CM_AUTH_TOKEN_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(observed.added.CM_AUTH_TOKEN_HASH).not.toBe(handoff?.sessionToken);
  });

  it('writes the handoff file 0600, and it is gone once consumed', async () => {
    const observed = await observeLaunch();
    const pairingFile = observed.added[PAIRING_FILE_ENV_KEY] as string;

    expect(existsSync(pairingFile)).toBe(true);
    expect(statSync(pairingFile).mode & 0o777).toBe(0o600);
    // The plaintext token is in there, which is the whole reason for the mode.
    expect(readFileSync(pairingFile, 'utf8')).toContain('sessionToken');

    // `POST /api/remote/pair` unlinks through this same function, between
    // verifying the code and setting the cookie (§7.3 step 6); the route side
    // of that is pinned by tests/unit/app/api/remote/pair.test.ts.
    consumePairingHandoff(pairingFile);
    expect(existsSync(pairingFile)).toBe(false);
  });

  it('delegates to runStart rather than reimplementing it', async () => {
    const observed = await observeLaunch();

    expect(runStart).toHaveBeenCalledTimes(1);
    expect(observed.startOptions?.daemon).toBe(true);
    // NOT `auth: true`: that would make `runStart` mint a SECOND token and
    // overwrite the hash whose plaintext is in the handoff file, leaving the
    // pairing unable to produce a usable cookie.
    expect(observed.startOptions?.auth).toBeUndefined();
    expect(Object.keys(observed.startOptions ?? {}).sort()).toEqual(['daemon', 'port']);
  });

  it('declares the same keys the builder produces', () => {
    // Non-vacuity guard for the exact-set test above: if `buildRemoteLaunchEnv`
    // and the declaration ever drifted apart, the measurement would be checked
    // against a list that describes something else.
    const built = buildRemoteLaunchEnv({
      authTokenHash: 'a'.repeat(64),
      authExpire: '8h',
      pairingFilePath: '/tmp/handoff.json',
    });

    expect(Object.keys(built).sort()).toEqual([...REMOTE_LAUNCH_ENV_KEYS].sort());
    expect(built.CM_REMOTE_PAIRING_FILE).toBe('/tmp/handoff.json');
    expect(built.CM_AUTH_EXPIRE).toBe('8h');
  });
});
