/**
 * `commandmate status` reports the Web Push configuration (Issues #2123 / #2124).
 *
 * Both Issues accept "the startup log OR `commandmate status`". This file pins the
 * `status` half, which is the half that is still readable a week later: a daemon's
 * stdout goes wherever the launcher put it, and the person who notices "my phone
 * stopped buzzing" reaches for `status`.
 *
 * ## The two properties that matter
 *
 *  1. **It reads the env the DAEMON runs with, not this process's.** `.env`
 *     outranks exported variables for the server child (#1266), so reading
 *     `process.env` here would report this shell's idea of the configuration. The
 *     shadowing test below is the one that goes red on that mistake — and it is
 *     the same mistake #1266 had to fix for `CM_ALLOWED_IPS`.
 *  2. **Silence on a healthy install.** Both Issues name the negative control
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
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
});
