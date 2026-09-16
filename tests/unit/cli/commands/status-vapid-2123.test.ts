/**
 * `commandmate status` reports the Web Push configuration (Issues #2123 / #2124).
 *
 * Both Issues accept "the startup log OR `commandmate status`". This file pins the
 * `status` half, which is the half that is still readable a week later: a daemon's
 * stdout goes wherever the launcher put it, and the person who notices "my phone
 * stopped buzzing" reaches for `status`.
 *
 * ## The three properties that matter
 *
 *  1. **It reports the DAEMON's configuration, not this process's.** Two tests
 *     pin the two halves of that: a `.env` value outranks an exported one
 *     (#1266), and an exported value with NOTHING in the `.env` is not the
 *     daemon's at all (#2585). The second half is the one that was missing — a
 *     shell with `CM_VAPID_*` exported silenced this warning for a server that
 *     had no keys, and #2575 spent an investigation finding that out by hand.
 *  2. **The running server outranks both.** It is the only party that knows what
 *     it was launched with, so `status` asks it (`GET /api/push/vapid`) before
 *     reporting. `fetch` is stubbed here and defaults to a refused connection, so
 *     every test that does not set an answer is exercising the fallback.
 *  3. **Silence on a healthy install.** Both Issues name the negative control
 *     explicitly. A `status` that always mentioned push would be scrolled past.
 *
 * The wording is NOT stubbed: `formatVapidReportLines` runs for real, so a message
 * that stopped naming the variables would fail here rather than pass on a mock.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

vi.mock('fs');
vi.mock('dotenv');
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getPidFilePath: vi.fn(() => '/mock/home/.commandmate/.commandmate.pid'),
  getEnvPath: vi.fn(() => '/mock/home/.commandmate/.env'),
  getPidsDir: vi.fn(() => '/mock/home/.commandmate/pids'),
}));
vi.mock('../../../../src/cli/utils/package-info', () => ({
  readPackageVersion: vi.fn(() => '0.27.1'),
}));
vi.mock('../../../../src/lib/detection/version-probes', () => ({
  getDetectorFreshness: vi.fn(async () => []),
}));
vi.mock('../../../../src/lib/server/localhost-self-check', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/lib/server/localhost-self-check')>();
  return { ...actual, readLocalhostConflict: vi.fn(() => null) };
});

import { statusCommand } from '../../../../src/cli/commands/status';
import { VAPID_DEFAULT_SUBJECT } from '../../../../src/lib/push/vapid';

const PID = 12345;
const PORT = 3000;
const STATE_FILE = `${PID}\n${JSON.stringify({
  pid: PID,
  version: '0.27.1',
  port: PORT,
  bind: '127.0.0.1',
  protocol: 'http',
  auth: false,
  startedAt: '2026-08-28T09:00:00.000Z',
})}\n`;

const HEALTHY = {
  CM_VAPID_PUBLIC_KEY: 'BPublicKeyPlaceholder',
  CM_VAPID_PRIVATE_KEY: 'PrivateKeyPlaceholder',
};

/** The URL the STATE_FILE above describes, i.e. the one the probe must dial. */
const SERVER_URL = `http://127.0.0.1:${PORT}`;

const fetchMock = vi.fn();

/** `GET /api/push/vapid` answering as a server with, or without, a key pair. */
function serverSays(configured: boolean): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ configured, publicKey: configured ? 'BServerPublicKey' : null }),
  } as unknown as Response);
}

describe('statusCommand VAPID report (Issues #2123 / #2124)', () => {
  let output: string[];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    output = [];
    savedEnv = {};
    for (const key of ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(STATE_FILE);
    vi.mocked(dotenv.config).mockReturnValue({ parsed: {} });
    // Default: nothing answers. A test that wants the server's verdict says so
    // explicitly with serverSays(), so "which authority decided this" is always
    // visible in the test that asserts it.
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3000'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('says push is disabled when the server has no VAPID keys', async () => {
    await statusCommand();

    const text = output.join('\n');
    expect(text).toContain('Status:  Running');
    expect(text).toContain('Push notifications are disabled');
    expect(text).toContain('CM_VAPID_PUBLIC_KEY');
    expect(text).toContain('CM_VAPID_PRIVATE_KEY');
    // The reader has to be able to act on the line without leaving the terminal.
    expect(text).toContain('commandmate init');
  });

  it('stays silent when the server is configured (negative control)', async () => {
    vi.mocked(dotenv.config).mockReturnValue({ parsed: { ...HEALTHY } });

    await statusCommand();

    const text = output.join('\n');
    expect(text).toContain('Status:  Running');
    // Not "no *disabled* line" but no line ABOUT PUSH AT ALL: a check that
    // announced a healthy configuration would satisfy the narrower assertion
    // while destroying the property both Issues asked for.
    expect(text).not.toMatch(/[Pp]ush/);
    expect(text).not.toContain('CM_VAPID');
  });

  it('warns about a subject APNs will reject, and names Apple', async () => {
    vi.mocked(dotenv.config).mockReturnValue({
      parsed: { ...HEALTHY, CM_VAPID_SUBJECT: 'mailto:commandmate@localhost' },
    });

    await statusCommand();

    const text = output.join('\n');
    expect(text).toContain('CM_VAPID_SUBJECT');
    expect(text).toContain('APNs');
    expect(text).toContain('mailto:commandmate@localhost');
    expect(text).toContain(VAPID_DEFAULT_SUBJECT);
    // Push IS configured, so it must NOT also claim push is off.
    expect(text).not.toContain('Push notifications are disabled');
  });

  it('stays silent for a subject that is merely unusual but resolvable', async () => {
    vi.mocked(dotenv.config).mockReturnValue({
      parsed: { ...HEALTHY, CM_VAPID_SUBJECT: 'mailto:ops@example.com' },
    });

    await statusCommand();

    const text = output.join('\n');
    expect(text).not.toMatch(/[Pp]ush/);
    expect(text).not.toContain('CM_VAPID');
  });

  it("reports the daemon's .env, not this shell (Issue #1266 precedence)", async () => {
    // The server runs with `{...process.env, ...parsed}` — .env WINS. A `status`
    // that read `process.env` would report this terminal's broken subject for a
    // server that sends a perfectly good one, which is precisely the class of bug
    // #1266 had to fix for CM_ALLOWED_IPS.
    process.env.CM_VAPID_SUBJECT = 'mailto:commandmate@localhost';
    vi.mocked(dotenv.config).mockReturnValue({
      parsed: { ...HEALTHY, CM_VAPID_SUBJECT: 'mailto:ops@example.com' },
    });

    await statusCommand();

    const text = output.join('\n');
    expect(text).not.toMatch(/[Pp]ush/);
    expect(text).not.toContain('CM_VAPID');
  });

  it('never prints a key value', async () => {
    vi.mocked(dotenv.config).mockReturnValue({
      parsed: { CM_VAPID_PUBLIC_KEY: HEALTHY.CM_VAPID_PUBLIC_KEY },
    });

    await statusCommand();

    const text = output.join('\n');
    expect(text).toContain('Push notifications are disabled');
    expect(text).toContain('CM_VAPID_PRIVATE_KEY');
    expect(text).not.toContain(HEALTHY.CM_VAPID_PUBLIC_KEY);
  });

  it('reports it under --all too, so a worktree server is covered', async () => {
    // `--all` goes through showSingleStatus(), a SECOND call site. #2113's warning
    // was wired into only one of the two for a while; this pins both.
    vi.mocked(fs.readdirSync).mockReturnValue([] as never);
    vi.mocked(dotenv.config).mockReturnValue({ parsed: {} });

    await statusCommand({ all: true });

    expect(output.join('\n')).toContain('Push notifications are disabled');
  });

  /**
   * Issue #2585: the half of "the daemon's configuration, not this process's" that the
   * tests above never covered.
   *
   * The #1266 test pins `.env` BEATING an exported value. It says nothing about the case
   * where the `.env` is silent — and there the old reader kept the shell's value, so a
   * terminal with `CM_VAPID_*` exported read as a configured daemon. Measured
   * 2026-09-16: `:60301` answered `{"configured":false,"publicKey":null}` with no
   * `CM_VAPID_*` anywhere in its `.env`, and `status` run from such a shell printed
   * nothing at all.
   */
  describe('the running server is the authority (Issue #2585)', () => {
    /** The shell #2575 was typing in: the pair exported, the `.env` empty. */
    function exportKeysInThisShell(): void {
      process.env.CM_VAPID_PUBLIC_KEY = HEALTHY.CM_VAPID_PUBLIC_KEY;
      process.env.CM_VAPID_PRIVATE_KEY = HEALTHY.CM_VAPID_PRIVATE_KEY;
    }

    it('warns when the keys are only in this shell and the server has none', async () => {
      exportKeysInThisShell();
      serverSays(false);

      await statusCommand();

      const text = output.join('\n');
      expect(text).toContain('Push notifications are disabled');
      expect(text).toContain('CM_VAPID_PUBLIC_KEY');
      // The sentence that turns "why is my phone quiet" into one action.
      expect(text).toContain('This shell exports');
      expect(text).toContain('restart the server');
      // Names only. A key value must never reach the terminal.
      expect(text).not.toContain(HEALTHY.CM_VAPID_PUBLIC_KEY);
    });

    it('stays silent when the server is configured, whatever this shell exports', async () => {
      exportKeysInThisShell();
      process.env.CM_VAPID_SUBJECT = 'mailto:commandmate@localhost';
      serverSays(true);

      await statusCommand();

      const text = output.join('\n');
      expect(text).toContain('Status:  Running');
      expect(text).not.toMatch(/[Pp]ush/);
      expect(text).not.toContain('CM_VAPID');
    });

    // The reverse false report, and the reason the probe exists at all rather than just
    // dropping `process.env`: a pair exported into the daemon at launch is in neither the
    // `.env` nor this shell, and only the server can say it is there.
    it('stays silent when the server is configured and nothing local says so', async () => {
      serverSays(true);

      await statusCommand();

      const text = output.join('\n');
      expect(text).toContain('Status:  Running');
      expect(text).not.toMatch(/[Pp]ush/);
    });

    // The endpoint reports the keys and NOT the subject, so #2124's check has to survive
    // a server that answers `configured: true`.
    it('still warns about a subject APNs rejects when the server has the keys', async () => {
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_VAPID_SUBJECT: 'mailto:commandmate@localhost' },
      });
      serverSays(true);

      await statusCommand();

      const text = output.join('\n');
      expect(text).toContain('CM_VAPID_SUBJECT');
      expect(text).toContain('APNs');
      // The keys are on the server, so it must not also claim push is off.
      expect(text).not.toContain('Push notifications are disabled');
    });

    // The documented fallback. A daemon that is "Running" but cannot be asked (auth on
    // with no CM_AUTH_TOKEN, a wedged process, something else on the port) is reported
    // from its `.env` — and never from this shell, which is the whole point.
    it('falls back to the .env verdict, not the shell, when nothing answers', async () => {
      exportKeysInThisShell();
      // fetchMock is left at its default: connection refused.

      await statusCommand();

      expect(output.join('\n')).toContain('Push notifications are disabled');
    });

    it('ignores an answer that is not this endpoint answering', async () => {
      exportKeysInThisShell();
      // Auth is on and this invocation has no token: middleware redirects to /login.
      fetchMock.mockResolvedValue({ ok: false, status: 302, json: async () => ({}) } as never);

      await statusCommand();

      expect(output.join('\n')).toContain('Push notifications are disabled');
    });

    it('tells the operator to restart when the .env has keys the server does not', async () => {
      vi.mocked(dotenv.config).mockReturnValue({ parsed: { ...HEALTHY } });
      serverSays(false);

      await statusCommand();

      const text = output.join('\n');
      expect(text).toContain('Push notifications are disabled');
      expect(text).toContain('predates that edit');
      expect(text).toContain('commandmate stop && commandmate start');
    });

    it('asks the server it just reported on, under a deadline', async () => {
      serverSays(false);

      await statusCommand();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${SERVER_URL}/api/push/vapid`);
      // Manual redirect: a 302 to /login must stay a 302, not become an HTML 200.
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('sends CM_AUTH_TOKEN so an authenticated server can answer', async () => {
      vi.stubEnv('CM_AUTH_TOKEN', 'token-for-this-invocation');
      serverSays(true);

      await statusCommand();

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.Authorization).toBe('Bearer token-for-this-invocation');
    });

    it('does not touch the network when the daemon is not running', async () => {
      // `code`, not the message: PidManager.isProcessRunning() classifies on the errno
      // and rethrows anything it does not recognise.
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      });

      await statusCommand();

      expect(output.join('\n')).toContain('Not running');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
