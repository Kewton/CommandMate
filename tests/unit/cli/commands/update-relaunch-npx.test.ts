/**
 * `commandmate update --relaunch-npx` orchestrator tests
 * Issue #1395: npx GUI self-update — the hidden relaunch routine (design §2.1).
 *
 * Seams are module-level vi.mock (D-9, mirroring update.test.ts): npx-runner,
 * npm-runner, health-check, daemon-factory and the update lock are stubbed so
 * every branch of the routine is drivable without a real npx/daemon.
 *
 * Covered (design §8.2):
 * - fetched≠expected → abort before stop (stop NOT called) + releaseUpdateLock
 * - registry / warmup / stop / relaunch failures → abort + releaseUpdateLock
 * - ready / degraded / timeout after a successful relaunch
 * - post-start version mismatch warning
 * - user-facing `update` (no flag) under npx stays a no-op (§6)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs');
vi.mock('dotenv', () => ({ config: vi.fn(() => ({ parsed: {} })) }));
vi.mock('../../../../src/cli/utils/paths', () => ({
  getPackageJsonPath: vi.fn(() => '/npx/_npx/abc/node_modules/commandmate/package.json'),
  getPackageRoot: vi.fn(() => '/npx/_npx/abc/node_modules/commandmate'),
}));
vi.mock('../../../../src/cli/utils/install-context', () => ({
  isGlobalInstall: vi.fn(() => true),
  isNpxExecution: vi.fn(() => true),
}));
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: vi.fn(() => '/home/tester/.commandmate/.env'),
}));
vi.mock('../../../../src/cli/utils/daemon-factory', () => ({
  getDaemonManagerFactory: vi.fn(),
}));
vi.mock('../../../../src/cli/utils/npm-runner', () => ({
  viewLatestVersion: vi.fn(),
  installGlobalLatest: vi.fn(),
}));
vi.mock('../../../../src/cli/utils/npx-runner', () => ({
  warmNpxLatest: vi.fn(),
  spawnNpxDaemon: vi.fn(),
  sanitizeNpxEnv: vi.fn((e) => e),
}));
vi.mock('../../../../src/cli/utils/health-check', () => ({
  waitForReady: vi.fn(async () => 'ready'),
}));
vi.mock('../../../../src/cli/utils/api-client', () => ({
  resolveAuthToken: vi.fn(() => 'tok'),
}));
vi.mock('../../../../src/lib/app-update/update-lock', () => ({
  releaseUpdateLock: vi.fn(),
}));
vi.mock('../../../../src/cli/utils/worktree-servers', () => ({
  listRunningWorktreeServers: vi.fn(async () => []),
}));
vi.mock('../../../../src/cli/utils/prompt', () => ({
  confirm: vi.fn(async () => true),
  isInteractive: vi.fn(() => true),
  closeReadline: vi.fn(),
}));

import * as fs from 'fs';
import { updateCommand } from '../../../../src/cli/commands/update';
import { ExitCode } from '../../../../src/cli/types';
import { isNpxExecution } from '../../../../src/cli/utils/install-context';
import { getDaemonManagerFactory } from '../../../../src/cli/utils/daemon-factory';
import { viewLatestVersion } from '../../../../src/cli/utils/npm-runner';
import { warmNpxLatest, spawnNpxDaemon } from '../../../../src/cli/utils/npx-runner';
import { waitForReady } from '../../../../src/cli/utils/health-check';
import { releaseUpdateLock } from '../../../../src/lib/app-update/update-lock';

interface MockDaemon {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
}

let mockExit: ReturnType<typeof vi.fn>;
let daemon: MockDaemon;
let logs: string[];

const output = (): string => logs.join('\n');
const exitCodes = (): number[] => mockExit.mock.calls.map((c) => c[0] as number);

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  mockExit = vi.fn();
  vi.spyOn(process, 'exit').mockImplementation(mockExit as unknown as typeof process.exit);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });

  vi.mocked(isNpxExecution).mockReturnValue(true);
  vi.mocked(fs.existsSync).mockReturnValue(true);

  daemon = {
    start: vi.fn(async () => 4242),
    stop: vi.fn(async () => true),
    getStatus: vi.fn(async () => ({
      running: true,
      pid: 4242,
      port: 3000,
      url: 'http://127.0.0.1:3000',
      version: '0.11.0',
    })),
    isRunning: vi.fn(async () => true),
  };
  vi.mocked(getDaemonManagerFactory).mockReturnValue({
    create: vi.fn(() => daemon),
  } as unknown as ReturnType<typeof getDaemonManagerFactory>);

  vi.mocked(viewLatestVersion).mockReturnValue({ success: true, version: '0.11.0' });
  vi.mocked(warmNpxLatest).mockReturnValue({ success: true, version: '0.11.0' });
  vi.mocked(spawnNpxDaemon).mockReturnValue({ success: true, status: 0 });
  vi.mocked(waitForReady).mockResolvedValue('ready');
});

describe('update --relaunch-npx: happy path', () => {
  it('warms, verifies, stops, relaunches, waits ready, and exits SUCCESS', async () => {
    await updateCommand({ yes: true, relaunchNpx: true });

    expect(warmNpxLatest).toHaveBeenCalledWith('commandmate');
    expect(daemon.stop).toHaveBeenCalledTimes(1);
    expect(spawnNpxDaemon).toHaveBeenCalledWith('commandmate');
    expect(waitForReady).toHaveBeenCalledWith('http://127.0.0.1:3000', { token: 'tok' });
    expect(exitCodes()).toContain(ExitCode.SUCCESS);
  });

  it('does the warmup/verify BEFORE stopping (fail-fast ordering)', async () => {
    const order: string[] = [];
    vi.mocked(warmNpxLatest).mockImplementation(() => {
      order.push('warm');
      return { success: true, version: '0.11.0' };
    });
    daemon.stop.mockImplementation(async () => {
      order.push('stop');
      return true;
    });
    vi.mocked(spawnNpxDaemon).mockImplementation(() => {
      order.push('relaunch');
      return { success: true, status: 0 };
    });

    await updateCommand({ yes: true, relaunchNpx: true });

    expect(order).toEqual(['warm', 'stop', 'relaunch']);
  });

  it('leaves the lock in place on success (it expires; a retry must not disturb the fresh daemon)', async () => {
    await updateCommand({ yes: true, relaunchNpx: true });
    expect(releaseUpdateLock).not.toHaveBeenCalled();
  });
});

describe('update --relaunch-npx: staleness / fail-fast aborts (zero downtime)', () => {
  it('aborts before stopping and releases the lock when npx fetched a stale version', async () => {
    vi.mocked(warmNpxLatest).mockReturnValue({ success: true, version: '0.10.0' }); // != expected 0.11.0

    await updateCommand({ yes: true, relaunchNpx: true });

    expect(daemon.stop).not.toHaveBeenCalled();
    expect(spawnNpxDaemon).not.toHaveBeenCalled();
    expect(releaseUpdateLock).toHaveBeenCalledTimes(1);
    expect(exitCodes()).toContain(ExitCode.UPDATE_FAILED);
  });

  it('aborts + releases the lock when the warmup fetch fails', async () => {
    vi.mocked(warmNpxLatest).mockReturnValue({ success: false, error: 'network error' });

    await updateCommand({ yes: true, relaunchNpx: true });

    expect(daemon.stop).not.toHaveBeenCalled();
    expect(releaseUpdateLock).toHaveBeenCalledTimes(1);
  });

  it('aborts + releases the lock when the registry query fails', async () => {
    vi.mocked(viewLatestVersion).mockReturnValue({ success: false, error: 'no registry' });

    await updateCommand({ yes: true, relaunchNpx: true });

    expect(warmNpxLatest).not.toHaveBeenCalled();
    expect(daemon.stop).not.toHaveBeenCalled();
    expect(releaseUpdateLock).toHaveBeenCalledTimes(1);
  });

  it('aborts + releases the lock when no .env exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await updateCommand({ yes: true, relaunchNpx: true });

    expect(viewLatestVersion).not.toHaveBeenCalled();
    expect(daemon.stop).not.toHaveBeenCalled();
    expect(releaseUpdateLock).toHaveBeenCalledTimes(1);
  });
});

describe('update --relaunch-npx: post-stop failures', () => {
  it('does not start a new server and releases the lock when the stop fails', async () => {
    daemon.stop.mockResolvedValue(false);

    await updateCommand({ yes: true, relaunchNpx: true });

    expect(spawnNpxDaemon).not.toHaveBeenCalled();
    expect(releaseUpdateLock).toHaveBeenCalledTimes(1);
    expect(exitCodes()).toContain(ExitCode.STOP_FAILED);
  });

  it('releases the lock when the relaunch fails (server is down; allow retry)', async () => {
    vi.mocked(spawnNpxDaemon).mockReturnValue({ success: false, status: 3, error: 'start failed' });

    await updateCommand({ yes: true, relaunchNpx: true });

    expect(releaseUpdateLock).toHaveBeenCalledTimes(1);
    expect(exitCodes()).toContain(ExitCode.START_FAILED);
  });
});

describe('update --relaunch-npx: readiness outcomes after a successful relaunch', () => {
  it('exits SUCCESS and keeps the lock on a degraded readiness result', async () => {
    vi.mocked(waitForReady).mockResolvedValue('degraded');

    await updateCommand({ yes: true, relaunchNpx: true });

    expect(exitCodes()).toContain(ExitCode.SUCCESS);
    expect(releaseUpdateLock).not.toHaveBeenCalled();
  });

  it('exits START_FAILED on a readiness timeout but keeps the lock (new daemon is up)', async () => {
    vi.mocked(waitForReady).mockResolvedValue('timeout');

    await updateCommand({ yes: true, relaunchNpx: true });

    expect(exitCodes()).toContain(ExitCode.START_FAILED);
    expect(releaseUpdateLock).not.toHaveBeenCalled();
  });

  it('warns when the running server version does not match the expected latest', async () => {
    daemon.getStatus.mockResolvedValue({
      running: true,
      url: 'http://127.0.0.1:3000',
      version: '0.9.9',
    });

    await updateCommand({ yes: true, relaunchNpx: true });

    expect(output()).toMatch(/0\.9\.9/);
    expect(exitCodes()).toContain(ExitCode.SUCCESS);
  });
});

describe('update (npx, no --relaunch-npx flag): user-facing no-op preserved (§6)', () => {
  it('prints guidance and changes nothing', async () => {
    await updateCommand({ yes: true });

    expect(warmNpxLatest).not.toHaveBeenCalled();
    expect(daemon.stop).not.toHaveBeenCalled();
    expect(spawnNpxDaemon).not.toHaveBeenCalled();
    expect(exitCodes()).toContain(ExitCode.SUCCESS);
  });
});
