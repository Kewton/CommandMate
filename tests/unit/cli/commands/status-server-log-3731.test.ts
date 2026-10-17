/**
 * Issue #3731: `commandmate status` prints where the daemon writes its stdout/stderr,
 * in both copies of the single-server output (`--issue`/main and `--all`).
 *
 * The config directory is a private one under os.tmpdir(), so whether the log exists is real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DaemonStatus } from '../../../../src/cli/types';

const ctx = vi.hoisted(() => ({ configDir: '' }));

const daemon = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getEffectiveEnv: vi.fn(),
}));

vi.mock('dotenv', () => ({
  config: vi.fn().mockReturnValue({ parsed: {} }),
}));

vi.mock('../../../../src/cli/utils/install-context', () => ({
  getConfigDir: () => ctx.configDir,
  isGlobalInstall: () => true,
}));

vi.mock('../../../../src/cli/utils/daemon', () => ({
  DaemonManager: vi.fn(function (this: Record<string, unknown>) {
    this.getStatus = daemon.getStatus;
    this.getEffectiveEnv = daemon.getEffectiveEnv;
  }),
}));

vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: (issueNo?: number) =>
    join(ctx.configDir, issueNo !== undefined ? `envs/${issueNo}.env` : '.env'),
  getPidFilePath: (issueNo?: number) =>
    join(ctx.configDir, issueNo !== undefined ? `pids/${issueNo}.pid` : '.commandmate.pid'),
  getPidsDir: () => join(ctx.configDir, 'pids'),
}));

vi.mock('../../../../src/lib/detection/version-probes', () => ({
  getDetectorFreshness: vi.fn(async () => []),
}));

import { statusCommand } from '../../../../src/cli/commands/status';

const RUNNING: DaemonStatus = { running: true, pid: 12345, port: 3135 };

describe('status prints the server log path (Issue #3731)', () => {
  let output: string[];

  beforeEach(() => {
    ctx.configDir = mkdtempSync(join(tmpdir(), 'cm-status-log-3731-'));
    daemon.getStatus.mockResolvedValue(RUNNING);
    daemon.getEffectiveEnv.mockReturnValue({});
    output = [];
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      output.push(String(msg));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ctx.configDir, { recursive: true, force: true });
  });

  it('prints the main server log for a running server', async () => {
    mkdirSync(join(ctx.configDir, 'logs'));
    writeFileSync(join(ctx.configDir, 'logs', 'server.log'), '');

    await statusCommand({});

    expect(output).toContain(`Log:     ${join(ctx.configDir, 'logs', 'server.log')}`);
  });

  it('prints the --issue server its own log file', async () => {
    await statusCommand({ issue: 135 });

    expect(output).toContain(
      `Log:     ${join(ctx.configDir, 'logs', 'server-135.log')} (not created yet)`
    );
  });

  it('prints the log for a stale PID file, where it tells why the server died', async () => {
    daemon.getStatus.mockResolvedValue({ running: false });

    await statusCommand({});

    expect(output.join('\n')).toContain(`Log:     ${join(ctx.configDir, 'logs', 'server.log')}`);
  });

  it('prints each server its own log under --all', async () => {
    mkdirSync(join(ctx.configDir, 'pids'));
    writeFileSync(join(ctx.configDir, 'pids', '135.pid'), '');

    await statusCommand({ all: true });

    const text = output.join('\n');
    expect(text).toContain(`Log:     ${join(ctx.configDir, 'logs', 'server.log')}`);
    expect(text).toContain(`Log:     ${join(ctx.configDir, 'logs', 'server-135.log')}`);
  });

  // Negative control: a server that was never started prints no log line.
  it('prints no log line when there is no PID file', async () => {
    daemon.getStatus.mockResolvedValue(null);

    await statusCommand({});

    expect(output.join('\n')).not.toContain('Log:');
  });
});
