/**
 * `commandmate remote` — selection, approval, status and stop
 * (Issue #1937, R9. Design: `docs/design/remote-qr-pairing-1937.md` §5, §6).
 *
 * The three behaviours here are the ones where being wrong is expensive and
 * silent, so each is pinned rather than described:
 *
 *  1. **No Provider ready is a dead end, never a fallback.** "Tailscale could
 *     not be used, so it published the machine to the internet instead" must be
 *     impossible, not unlikely — so the selection rule is tested directly, and
 *     separately from the probe that feeds it.
 *  2. **A public tunnel needs someone to say yes.** Non-interactive without
 *     `--yes` refuses. A default-yes here would let a script expose a machine
 *     because nobody was there to object.
 *  3. **`remote stop` with no state file does nothing at all.** Guessing a
 *     Provider and tearing down its current configuration can destroy Tailscale
 *     Serve settings the user created, with no way to restore them (§6.3-4).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'cm-remote-1937-'));

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

const daemonState = { running: false, auth: false, stopResult: true, stopCalls: 0 };
vi.mock('../../../../src/cli/utils/daemon', () => ({
  DaemonManager: class {
    async isRunning(): Promise<boolean> {
      return daemonState.running;
    }
    async getStatus(): Promise<unknown> {
      if (!daemonState.running) return null;
      return {
        running: true,
        pid: 999,
        port: 3000,
        url: 'http://127.0.0.1:3000',
        auth: daemonState.auth,
      };
    }
    async stop(): Promise<boolean> {
      daemonState.stopCalls += 1;
      daemonState.running = !daemonState.stopResult;
      return daemonState.stopResult;
    }
  },
}));
vi.mock('../../../../src/cli/commands/start', () => ({ runStart: vi.fn() }));
vi.mock('../../../../src/lib/remote', () => ({
  detectRemoteProviders: vi.fn(),
  createRemoteProviders: vi.fn(() => []),
}));

import {
  DEFAULT_PAIRING_EXPIRES,
  DEFAULT_REMOTE_EXPIRES,
  MAX_PAIRING_TTL_MS,
  MIN_PAIRING_TTL_MS,
  PUBLIC_TUNNEL_PROVIDERS,
  buildPairingUrl,
  createRemoteCommand,
  derivePairingState,
  formatRemaining,
  parsePairingDuration,
  runRemoteStatus,
  runRemoteStop,
  runRemoteUp,
  selectProvider,
} from '../../../../src/cli/commands/remote';
import { ExitCode } from '../../../../src/cli/types';
import { runStart } from '../../../../src/cli/commands/start';
import { createRemoteProviders, detectRemoteProviders } from '../../../../src/lib/remote';
import { isInteractive } from '../../../../src/cli/utils/prompt';
import {
  REMOTE_STATE_SCHEMA_VERSION,
  readRemoteState,
  removeRemoteState,
  writeRemoteState,
  type RemoteState,
} from '../../../../src/cli/utils/remote-state';
import type { ProviderCandidate, RemoteHandle, RemoteProviderId } from '../../../../src/lib/remote';

const statePath = join(configDir, 'remote.json');

/** A probe result for one Provider, with a `start`/`stop` a test can inspect. */
function candidate(
  id: RemoteProviderId,
  detection: { available: boolean; ready: boolean; reason?: string }
): ProviderCandidate {
  const handle: RemoteHandle = {
    provider: id,
    url: `https://${id}.example.test`,
    owned: { pid: null, revert: null },
    preexisting: null,
  };
  return {
    provider: {
      id,
      detect: vi.fn(async () => detection),
      start: vi.fn(async () => handle),
      stop: vi.fn(async () => ({ reverted: true, skipped: [], warnings: [] })),
    },
    detection,
  } as unknown as ProviderCandidate;
}

function recordedState(overrides: Partial<RemoteState> = {}): RemoteState {
  const now = Date.now();
  return {
    schemaVersion: REMOTE_STATE_SCHEMA_VERSION,
    provider: 'tailscale-serve',
    url: 'https://recorded.example.test',
    startedAt: new Date(now).toISOString(),
    expiresAt: now + 60 * 60 * 1000,
    pairing: { filePath: join(configDir, 'remote-pairing.json'), expiresAt: now + 10 * 60 * 1000 },
    handle: {
      provider: 'tailscale-serve',
      url: 'https://recorded.example.test',
      owned: { pid: null, revert: { 'https://recorded.example.test': 'off' } },
      preexisting: { keys: [], raw: null },
    },
    server: { pid: 4242, port: 3000 },
    ...overrides,
  };
}

describe('commandmate remote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    daemonState.running = false;
    daemonState.auth = false;
    daemonState.stopResult = true;
    daemonState.stopCalls = 0;
    removeRemoteState(statePath);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(runStart).mockResolvedValue({
      ok: true,
      exitCode: ExitCode.SUCCESS,
      url: 'http://127.0.0.1:3000',
      pid: 4242,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  describe('command surface (§5.1)', () => {
    it('is a factory-built command with up as the default action', () => {
      const cmd = createRemoteCommand();

      expect(cmd.name()).toBe('remote');
      // `instances`' shape: default action, verb as an optional positional.
      expect(cmd.registeredArguments.map((a) => a.name())).toEqual(['action']);
      expect(cmd.registeredArguments[0].required).toBe(false);
    });

    it('offers every declared option and nothing that mints trouble', () => {
      const flags = createRemoteCommand()
        .options.map((option) => option.long)
        .filter((long): long is string => long !== null);

      expect(flags.sort()).toEqual(
        ['--expires', '--json', '--pairing-expires', '--port', '--provider', '--yes'].sort()
      );
      // §5.1: `remote` mints its own token, so a supplied one has no hash on the
      // server to match. §5.5: no flag may switch Auto-Yes on.
      expect(flags).not.toContain('--token');
      expect(flags.some((flag) => /auto-?yes/i.test(flag))).toBe(false);
    });

    it('documents the defaults it applies', () => {
      expect(DEFAULT_REMOTE_EXPIRES).toBe('8h');
      expect(DEFAULT_PAIRING_EXPIRES).toBe('10m');
    });
  });

  describe('provider selection (§6.2)', () => {
    it('picks the first ready provider in preference order', () => {
      const selection = selectProvider([
        candidate('tailscale-serve', { available: true, ready: true }),
        candidate('cloudflare-quick', { available: true, ready: true }),
      ]);

      expect(selection.candidate?.provider.id).toBe('tailscale-serve');
      expect(selection.error).toBeUndefined();
    });

    it('reports DEPENDENCY_ERROR when nothing is ready, and names why', () => {
      const selection = selectProvider([
        candidate('tailscale-serve', { available: false, ready: false, reason: 'not installed' }),
        candidate('cloudflare-quick', { available: false, ready: false, reason: 'not installed' }),
      ]);

      expect(selection.candidate).toBeUndefined();
      expect(selection.error?.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
      expect(selection.error?.details.join(' ')).toContain('tailscale-serve');
      expect(selection.error?.details.join(' ')).toContain('cloudflare-quick');
    });

    it('does not fall through to another provider when --provider names one', () => {
      // The user asked for Tailscale. An unusable Tailscale is an error, not an
      // invitation to publish the machine through Cloudflare instead.
      const selection = selectProvider(
        [
          candidate('tailscale-serve', { available: true, ready: false, reason: 'logged out' }),
          candidate('cloudflare-quick', { available: true, ready: true }),
        ],
        'tailscale'
      );

      expect(selection.candidate).toBeUndefined();
      expect(selection.error?.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
    });

    it('rejects an unknown --provider value as a CONFIG_ERROR', () => {
      const selection = selectProvider([], 'ngrok');

      expect(selection.error?.exitCode).toBe(ExitCode.CONFIG_ERROR);
    });

    it('treats the quick tunnel as public, which is what gates it', () => {
      expect(PUBLIC_TUNNEL_PROVIDERS).toContain('cloudflare-quick');
      expect(PUBLIC_TUNNEL_PROVIDERS).not.toContain('tailscale-serve');
    });
  });

  describe('up (§5.3)', () => {
    it('exits DEPENDENCY_ERROR when no provider is usable, starting nothing', async () => {
      vi.mocked(detectRemoteProviders).mockResolvedValue([
        candidate('tailscale-serve', { available: false, ready: false }),
        candidate('cloudflare-quick', { available: false, ready: false }),
      ]);

      expect(await runRemoteUp({})).toBe(ExitCode.DEPENDENCY_ERROR);
      expect(runStart).not.toHaveBeenCalled();
    });

    it('refuses a public tunnel non-interactively without --yes', async () => {
      // The acceptance condition, and the anti-fallback rule in one: Tailscale
      // is out, Cloudflare is ready, and nothing happens anyway.
      const cloudflare = candidate('cloudflare-quick', { available: true, ready: true });
      vi.mocked(detectRemoteProviders).mockResolvedValue([
        candidate('tailscale-serve', { available: false, ready: false }),
        cloudflare,
      ]);
      vi.mocked(isInteractive).mockReturnValue(false);

      expect(await runRemoteUp({})).toBe(ExitCode.CONFIG_ERROR);
      expect(cloudflare.provider.start).not.toHaveBeenCalled();
      expect(runStart).not.toHaveBeenCalled();
    });

    it('accepts --yes as the approval and goes on to publish', async () => {
      const cloudflare = candidate('cloudflare-quick', { available: true, ready: true });
      vi.mocked(detectRemoteProviders).mockResolvedValue([cloudflare]);

      expect(await runRemoteUp({ yes: true })).toBe(ExitCode.SUCCESS);
      expect(cloudflare.provider.start).toHaveBeenCalledWith(
        expect.objectContaining({ port: 3000 })
      );
      expect(readRemoteState(statePath)?.provider).toBe('cloudflare-quick');
    });

    it('rejects an --expires outside parseDuration\'s range', async () => {
      vi.mocked(detectRemoteProviders).mockResolvedValue([
        candidate('tailscale-serve', { available: true, ready: true }),
      ]);

      expect(await runRemoteUp({ expires: '5m' })).toBe(ExitCode.CONFIG_ERROR);
      expect(runStart).not.toHaveBeenCalled();
    });

    it('stops before pairing when a server is already running with auth (U-4)', async () => {
      vi.mocked(detectRemoteProviders).mockResolvedValue([
        candidate('tailscale-serve', { available: true, ready: true }),
      ]);
      daemonState.running = true;
      daemonState.auth = true;

      expect(await runRemoteUp({})).toBe(ExitCode.CONFIG_ERROR);
      // Its token hash was fixed from its own environment at startup and the
      // plaintext was never kept, so there is nothing a pairing could hand out.
      expect(daemonState.stopCalls).toBe(0);
      expect(runStart).not.toHaveBeenCalled();
    });

    it('refuses to restart an unauthenticated server non-interactively', async () => {
      vi.mocked(detectRemoteProviders).mockResolvedValue([
        candidate('tailscale-serve', { available: true, ready: true }),
      ]);
      daemonState.running = true;
      daemonState.auth = false;
      vi.mocked(isInteractive).mockReturnValue(false);

      expect(await runRemoteUp({})).toBe(ExitCode.CONFIG_ERROR);
      expect(daemonState.stopCalls).toBe(0);
    });

    it('rolls back the server and the handoff when the provider fails', async () => {
      const broken = candidate('tailscale-serve', { available: true, ready: true });
      vi.mocked(broken.provider.start).mockRejectedValue(new Error('serve refused'));
      vi.mocked(detectRemoteProviders).mockResolvedValue([broken]);

      expect(await runRemoteUp({})).toBe(ExitCode.START_FAILED);
      // The handoff file holds the plaintext token for a server that is about to
      // stop existing, so it must not survive the failure.
      expect(existsSync(join(configDir, 'remote-pairing.json'))).toBe(false);
      expect(daemonState.stopCalls).toBe(1);
      expect(readRemoteState(statePath)).toBeNull();
    });

    it('passes the start failure through unchanged', async () => {
      vi.mocked(detectRemoteProviders).mockResolvedValue([
        candidate('tailscale-serve', { available: true, ready: true }),
      ]);
      vi.mocked(runStart).mockResolvedValue({ ok: false, exitCode: ExitCode.START_FAILED });

      expect(await runRemoteUp({})).toBe(ExitCode.START_FAILED);
      expect(readRemoteState(statePath)).toBeNull();
    });
  });

  describe('stop (§6.3-4)', () => {
    it('cleans up nothing and succeeds when no state was recorded', async () => {
      const providers = [candidate('tailscale-serve', { available: true, ready: true }).provider];
      vi.mocked(createRemoteProviders).mockReturnValue(providers);

      expect(await runRemoteStop({})).toBe(ExitCode.SUCCESS);
      // Not "found nothing to do and tore down the current config anyway".
      expect(providers[0].stop).not.toHaveBeenCalled();
    });

    it('hands the provider the recorded handle and nothing else', async () => {
      const state = recordedState();
      writeRemoteState(state, statePath);
      const providers = [candidate('tailscale-serve', { available: true, ready: true }).provider];
      vi.mocked(createRemoteProviders).mockReturnValue(providers);

      expect(await runRemoteStop({})).toBe(ExitCode.SUCCESS);
      expect(providers[0].stop).toHaveBeenCalledWith(state.handle);
      expect(readRemoteState(statePath)).toBeNull();
    });

    it('keeps the state file when the revert did not complete', async () => {
      writeRemoteState(recordedState(), statePath);
      const provider = candidate('tailscale-serve', { available: true, ready: true }).provider;
      vi.mocked(provider.stop).mockResolvedValue({
        reverted: false,
        skipped: ['https://someone-elses.example.test'],
        warnings: ['tailscale-serve: cannot revert'],
      });
      vi.mocked(createRemoteProviders).mockReturnValue([provider]);

      expect(await runRemoteStop({})).toBe(ExitCode.STOP_FAILED);
      // Kept so a second `remote stop` can retry rather than losing the receipt.
      expect(readRemoteState(statePath)).not.toBeNull();
    });

    it('ignores a state file it cannot make sense of', async () => {
      writeFileSync(statePath, '{"schemaVersion": 99}', { mode: 0o600 });
      const providers = [candidate('tailscale-serve', { available: true, ready: true }).provider];
      vi.mocked(createRemoteProviders).mockReturnValue(providers);

      expect(await runRemoteStop({})).toBe(ExitCode.SUCCESS);
      expect(providers[0].stop).not.toHaveBeenCalled();
    });
  });

  describe('status (§5.4)', () => {
    it('prints neither the pairing code nor a token', async () => {
      writeRemoteState(recordedState(), statePath);
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.join(' '));
      });

      expect(await runRemoteStatus({ json: true })).toBe(ExitCode.SUCCESS);

      const output = lines.join('\n');
      expect(output).toContain('https://recorded.example.test');
      expect(output).not.toContain('code=');
      expect(output).not.toContain('sessionToken');
      expect(output).not.toContain('pairingUrl');
    });

    it('reports an expired-unused code as expired, not as paired', async () => {
      // The teardown below deletes the handoff file, and its absence is what
      // reads as `consumed`. Reading the pairing state after the teardown would
      // report every expired session as having been paired.
      const handoffPath = join(configDir, 'expired-handoff.json');
      // Present on disk and past its TTL: nobody ever scanned this code.
      writeFileSync(handoffPath, '{}', { mode: 0o600 });
      const state = recordedState({
        expiresAt: Date.now() - 1000,
        pairing: { filePath: handoffPath, expiresAt: Date.now() - 2000 },
      });
      writeRemoteState(state, statePath);
      const provider = candidate('tailscale-serve', { available: true, ready: true }).provider;
      vi.mocked(createRemoteProviders).mockReturnValue([provider]);
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.join(' '));
      });

      expect(await runRemoteStatus({ json: true })).toBe(ExitCode.SUCCESS);

      expect(JSON.parse(lines.join('\n')).remote.pairing.state).toBe('expired');
      // ...and the teardown still took the plaintext handoff with it (§7.4).
      expect(existsSync(handoffPath)).toBe(false);
    });

    it('emits parseable JSON even while tearing an expired session down', async () => {
      writeRemoteState(recordedState({ expiresAt: Date.now() - 1000 }), statePath);
      const provider = candidate('tailscale-serve', { available: true, ready: true }).provider;
      vi.mocked(provider.stop).mockResolvedValue({
        reverted: false,
        skipped: [],
        warnings: ['tailscale-serve: cannot revert'],
      });
      vi.mocked(createRemoteProviders).mockReturnValue([provider]);
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.join(' '));
      });

      expect(await runRemoteStatus({ json: true })).toBe(ExitCode.SUCCESS);

      // The `closed` field carries what the prose lines would have said, so
      // nothing else may land on stdout to break the parse.
      expect(JSON.parse(lines.join('\n')).remote.closed).toBe(false);
    });

    it('closes the provider when the remote session has expired', async () => {
      // §5.3: the door closes on `--expires`. The SERVER is not stopped - that
      // would take the user's local session down with the remote one.
      writeRemoteState(recordedState({ expiresAt: Date.now() - 1000 }), statePath);
      const provider = candidate('tailscale-serve', { available: true, ready: true }).provider;
      vi.mocked(createRemoteProviders).mockReturnValue([provider]);

      expect(await runRemoteStatus({})).toBe(ExitCode.SUCCESS);
      expect(provider.stop).toHaveBeenCalledTimes(1);
      expect(daemonState.stopCalls).toBe(0);
      expect(readRemoteState(statePath)).toBeNull();
    });

    it('leaves a live session alone', async () => {
      writeRemoteState(recordedState(), statePath);
      const provider = candidate('tailscale-serve', { available: true, ready: true }).provider;
      vi.mocked(createRemoteProviders).mockReturnValue([provider]);

      expect(await runRemoteStatus({})).toBe(ExitCode.SUCCESS);
      expect(provider.stop).not.toHaveBeenCalled();
    });

    it('succeeds with nothing recorded', async () => {
      expect(await runRemoteStatus({})).toBe(ExitCode.SUCCESS);
    });
  });

  describe('durations and display helpers', () => {
    it('accepts a pairing window parseDuration would reject', () => {
      // The reason this parser exists: parseDuration's floor is 1h and the
      // pairing default is 10m. Widening the shared one would loosen
      // CM_AUTH_EXPIRE for every caller.
      expect(parsePairingDuration('10m')).toBe(10 * 60 * 1000);
      expect(parsePairingDuration(DEFAULT_PAIRING_EXPIRES)).toBe(10 * 60 * 1000);
      expect(parsePairingDuration('1h')).toBe(60 * 60 * 1000);
    });

    it('bounds the window the plaintext token sits on disk', () => {
      expect(() => parsePairingDuration('30s')).toThrow(/Invalid duration format/);
      expect(() => parsePairingDuration('0m')).toThrow(/too short/);
      expect(() => parsePairingDuration('48h')).toThrow(/too long/);
      expect(parsePairingDuration('1m')).toBe(MIN_PAIRING_TTL_MS);
      expect(parsePairingDuration('24h')).toBe(MAX_PAIRING_TTL_MS);
    });

    it('reads the absence of the handoff file as consumed (§7.2)', () => {
      const now = 1_000_000;
      expect(derivePairingState(true, now + 1000, now)).toBe('unused');
      expect(derivePairingState(true, now - 1000, now)).toBe('expired');
      // The route unlinks the file between verifying the code and setting the
      // cookie, so its absence IS the consumed flag.
      expect(derivePairingState(false, now + 1000, now)).toBe('consumed');
    });

    it('formats the remaining time the way status shows it', () => {
      expect(formatRemaining(-1)).toBe('expired');
      expect(formatRemaining(0)).toBe('expired');
      expect(formatRemaining(12 * 60 * 1000)).toBe('in 12m');
      expect(formatRemaining((6 * 60 + 12) * 60 * 1000)).toBe('in 6h 12m');
    });

    it('builds the pairing URL the QR encodes', () => {
      expect(buildPairingUrl('https://host.ts.net', 'ABC')).toBe('https://host.ts.net/login#code=ABC');
      // A trailing slash from a Provider must not produce `//login`.
      expect(buildPairingUrl('https://host.ts.net/', 'ABC')).toBe('https://host.ts.net/login#code=ABC');
    });
  });
});
