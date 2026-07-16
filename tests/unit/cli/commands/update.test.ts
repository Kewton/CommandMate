/**
 * Update Command Tests
 * Issue #1194: commandmate update (stop -> npm install -g -> start)
 *
 * Seams are module-level vi.mock (D-9 / S1-015): no DI refactor of production
 * code. npm execution is asserted through the real npm-runner on top of a
 * mocked child_process, and the health check runs for real on a mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as childProcess from 'child_process';

vi.mock('fs');
vi.mock('child_process');
vi.mock('dotenv', () => ({
  config: vi.fn(() => ({ parsed: {} })),
}));
vi.mock('../../../../src/cli/utils/paths', () => ({
  getPackageJsonPath: vi.fn(() => '/mock/global/commandmate/package.json'),
  getPackageRoot: vi.fn(() => '/mock/global/commandmate'),
}));
vi.mock('../../../../src/cli/utils/install-context', () => ({
  isGlobalInstall: vi.fn(() => true),
}));
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: vi.fn(() => '/mock/home/.commandmate/.env'),
}));
vi.mock('../../../../src/cli/utils/daemon-factory', () => ({
  getDaemonManagerFactory: vi.fn(),
}));
vi.mock('../../../../src/cli/utils/worktree-servers', () => ({
  listRunningWorktreeServers: vi.fn(async () => []),
}));
vi.mock('../../../../src/cli/utils/prompt', () => ({
  confirm: vi.fn(async () => true),
  isInteractive: vi.fn(() => true),
  closeReadline: vi.fn(),
}));

// Import after mocking
import { updateCommand } from '../../../../src/cli/commands/update';
import { ExitCode, type UpdateOptions } from '../../../../src/cli/types';
import { isGlobalInstall } from '../../../../src/cli/utils/install-context';
import { getDaemonManagerFactory } from '../../../../src/cli/utils/daemon-factory';
import { getEnvPath } from '../../../../src/cli/utils/env-setup';
import { listRunningWorktreeServers } from '../../../../src/cli/utils/worktree-servers';
import { confirm, isInteractive } from '../../../../src/cli/utils/prompt';
import { config as dotenvConfig } from 'dotenv';

/** Mocked IDaemonManager */
interface MockDaemon {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
}

let mockExit: ReturnType<typeof vi.fn>;
let mockFetch: ReturnType<typeof vi.fn>;
let daemon: MockDaemon;
let logs: string[];

/** All console output produced by the command */
const output = (): string => logs.join('\n');

/** Build a spawnSync result */
function spawnResult(
  overrides: Partial<childProcess.SpawnSyncReturns<string>>
): childProcess.SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  } as childProcess.SpawnSyncReturns<string>;
}

/**
 * Wire npm: `npm view` returns latestVersion, `npm install` returns the
 * given status/stderr.
 */
function mockNpm(options: {
  latest?: string;
  viewStatus?: number;
  viewStderr?: string;
  viewError?: NodeJS.ErrnoException;
  installStatus?: number;
  installStderr?: string;
}): void {
  vi.mocked(childProcess.spawnSync).mockImplementation(((
    _command: string,
    args: readonly string[]
  ) => {
    if (args[0] === 'view') {
      if (options.viewError) {
        return spawnResult({ status: null, error: options.viewError });
      }
      return spawnResult({
        status: options.viewStatus ?? 0,
        stdout: `${options.latest ?? '1.0.0'}\n`,
        stderr: options.viewStderr ?? '',
      });
    }
    if (args[0] === 'install') {
      return spawnResult({
        status: options.installStatus ?? 0,
        stdout: options.installStatus ? '' : 'added 1 package\n',
        stderr: options.installStderr ?? '',
      });
    }
    return spawnResult({});
  }) as unknown as typeof childProcess.spawnSync);
}

/** Sequence of versions returned by reading package.json (step 2, then step 8) */
function mockPackageJson(...versions: string[]): void {
  const mock = vi.mocked(fs.readFileSync);
  mock.mockReset();
  for (const version of versions) {
    mock.mockReturnValueOnce(JSON.stringify({ name: 'commandmate', version }));
  }
  mock.mockReturnValue(
    JSON.stringify({ name: 'commandmate', version: versions[versions.length - 1] })
  );
}

/** A 200 + JSON + success:true response */
function readyResponse(): Response {
  return {
    status: 200,
    headers: { get: (): string => 'application/json' },
    json: async (): Promise<unknown> => ({ success: true, data: [] }),
  } as unknown as Response;
}

/** A response with an arbitrary status / content-type */
function makeResponse(status: number, contentType: string, body: unknown = {}): Response {
  return {
    status,
    headers: { get: (): string => contentType },
    json: async (): Promise<unknown> => body,
  } as unknown as Response;
}

/** npm install spawn calls */
function installCalls(): unknown[][] {
  return vi
    .mocked(childProcess.spawnSync)
    .mock.calls.filter((call) => (call[1] as string[] | undefined)?.[0] === 'install');
}

/** Run updateCommand while driving the health-check poll loop with fake timers */
async function runWithTimers(options: UpdateOptions): Promise<void> {
  vi.useFakeTimers();
  try {
    const promise = updateCommand(options);
    await vi.advanceTimersByTimeAsync(35_000);
    await promise;
  } finally {
    vi.useRealTimers();
  }
}

describe('updateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    logs = [];
    mockExit = vi.fn();
    vi.spyOn(process, 'exit').mockImplementation(mockExit as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    daemon = {
      start: vi.fn(async () => 4242),
      stop: vi.fn(async () => true),
      getStatus: vi.fn(async () => ({
        running: true,
        pid: 4242,
        port: 3000,
        url: 'http://127.0.0.1:3000',
      })),
      isRunning: vi.fn(async () => true),
    };
    vi.mocked(getDaemonManagerFactory).mockReturnValue({
      create: vi.fn(() => daemon),
    } as unknown as ReturnType<typeof getDaemonManagerFactory>);

    vi.mocked(isGlobalInstall).mockReturnValue(true);
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(listRunningWorktreeServers).mockResolvedValue([]);
    vi.mocked(getEnvPath).mockReturnValue('/mock/home/.commandmate/.env');

    mockFetch = vi.fn().mockResolvedValue(readyResponse());
    vi.stubGlobal('fetch', mockFetch);

    mockPackageJson('0.9.0', '1.0.0');
    mockNpm({ latest: '1.0.0' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.CM_AUTH_TOKEN;
  });

  describe('--check (D-7)', () => {
    it('should print the three-line report and exit SUCCESS', async () => {
      await updateCommand({ check: true });

      expect(output()).toContain('Current: v0.9.0');
      expect(output()).toContain('Latest: v1.0.0');
      expect(output()).toContain('Update available: yes');
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should report "no" when already up to date and still exit SUCCESS', async () => {
      mockPackageJson('1.0.0');
      mockNpm({ latest: '1.0.0' });

      await updateCommand({ check: true });

      expect(output()).toContain('Update available: no');
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should not install, stop or start anything', async () => {
      await updateCommand({ check: true });

      expect(installCalls()).toHaveLength(0);
      expect(daemon.stop).not.toHaveBeenCalled();
      expect(daemon.start).not.toHaveBeenCalled();
    });

    it('should exit UPDATE_FAILED when the registry query fails', async () => {
      mockNpm({ viewStatus: 1, viewStderr: 'E404 Not found' });

      await updateCommand({ check: true });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.UPDATE_FAILED);
    });
  });

  describe('registry query (D-15 / S3-007)', () => {
    it('should query npm view with array arguments', async () => {
      await updateCommand({ check: true });

      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        'npm',
        ['view', 'commandmate', 'version'],
        expect.objectContaining({ encoding: 'utf-8', timeout: 10000 })
      );
    });

    it('should not fetch a registry URL', async () => {
      await updateCommand({ check: true });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should exit UPDATE_FAILED when npm is missing (ENOENT)', async () => {
      const enoent = new Error('spawn npm ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      mockNpm({ viewError: enoent });

      await updateCommand({ yes: true });

      expect(installCalls()).toHaveLength(0);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.UPDATE_FAILED);
    });
  });

  describe('non-global install (D-8 / S1-006)', () => {
    beforeEach(() => {
      vi.mocked(isGlobalInstall).mockReturnValue(false);
    });

    it('should not install and should exit SUCCESS', async () => {
      await updateCommand({ yes: true });

      expect(installCalls()).toHaveLength(0);
      expect(daemon.stop).not.toHaveBeenCalled();
      expect(daemon.start).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should guide the user to npm run build:all', async () => {
      await updateCommand({ yes: true });

      expect(output()).toContain('npm run build:all');
    });

    it('should never guide the user to bare npm run build', async () => {
      await updateCommand({ yes: true });

      expect(output()).not.toMatch(/npm run build(?!:all)/);
    });

    it('should include the full manual upgrade sequence', async () => {
      await updateCommand({ yes: true });

      expect(output()).toContain('git pull');
      expect(output()).toContain('npm install');
      expect(output()).toContain('commandmate start --daemon');
    });

    it('should still report versions with --check (D-7)', async () => {
      await updateCommand({ check: true });

      expect(output()).toContain('Current: v0.9.0');
      expect(output()).toContain('Latest: v1.0.0');
      expect(output()).toContain('Update available: yes');
      expect(installCalls()).toHaveLength(0);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });
  });

  describe('version comparison (D-3 / S1-008 / S3-005)', () => {
    it('should skip when already up to date', async () => {
      mockPackageJson('1.0.0');
      mockNpm({ latest: '1.0.0' });

      await updateCommand({ yes: true });

      expect(output()).toContain('Already up to date (v1.0.0)');
      expect(installCalls()).toHaveLength(0);
      expect(daemon.stop).not.toHaveBeenCalled();
      expect(daemon.start).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should not downgrade when the local version is newer', async () => {
      mockPackageJson('1.1.0');
      mockNpm({ latest: '1.0.0' });

      await updateCommand({ yes: true });

      expect(output()).toContain('Local version v1.1.0 is newer than npm latest v1.0.0');
      expect(output()).toContain('Skipping update');
      expect(installCalls()).toHaveLength(0);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should skip when the local version is a prerelease', async () => {
      mockPackageJson('0.9.0-rc.1');
      mockNpm({ latest: '1.0.0' });

      await updateCommand({ yes: true });

      expect(output()).toContain('Local version v0.9.0-rc.1 is a prerelease');
      expect(output()).toContain('Skipping update');
      expect(installCalls()).toHaveLength(0);
      expect(daemon.stop).not.toHaveBeenCalled();
      expect(daemon.start).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should read the current version from package.json, not the require cache (S1-007)', async () => {
      await updateCommand({ check: true });

      expect(fs.readFileSync).toHaveBeenCalledWith(
        '/mock/global/commandmate/package.json',
        'utf-8'
      );
    });
  });

  describe('confirmation (D-2 / S1-005)', () => {
    it('should exit CONFIG_ERROR on a non-TTY without --yes', async () => {
      vi.mocked(isInteractive).mockReturnValue(false);

      await updateCommand({});

      expect(installCalls()).toHaveLength(0);
      expect(daemon.stop).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    });

    it('should mention --yes in the non-interactive error', async () => {
      vi.mocked(isInteractive).mockReturnValue(false);

      await updateCommand({});

      expect(output()).toContain('--yes');
    });

    it('should update without prompting on a non-TTY with --yes', async () => {
      vi.mocked(isInteractive).mockReturnValue(false);

      await updateCommand({ yes: true });

      expect(confirm).not.toHaveBeenCalled();
      expect(installCalls()).toHaveLength(1);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should prompt on a TTY without --yes', async () => {
      await updateCommand({});

      expect(confirm).toHaveBeenCalled();
      expect(installCalls()).toHaveLength(1);
    });

    it('should abort with SUCCESS when the user declines', async () => {
      vi.mocked(confirm).mockResolvedValue(false);

      await updateCommand({});

      expect(installCalls()).toHaveLength(0);
      expect(daemon.stop).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });
  });

  describe('warnings before confirmation', () => {
    it('should warn that startup options are lost (S1-003 / D-4)', async () => {
      await updateCommand({ yes: true });

      expect(output()).toContain('.env の設定のみで起動します');
    });

    it('should list the flags that will not be restored', async () => {
      await updateCommand({ yes: true });

      expect(output()).toContain('--auth');
      expect(output()).toContain('--cert');
      expect(output()).toContain('--allowed-ips');
    });

    it('should warn before the confirmation prompt is shown', async () => {
      await updateCommand({});

      const warnOrder = vi.mocked(console.log).mock.calls.findIndex((call) =>
        String(call[0]).includes('.env の設定のみで起動します')
      );
      expect(warnOrder).toBeGreaterThanOrEqual(0);
      expect(
        vi.mocked(console.log).mock.invocationCallOrder[warnOrder]
      ).toBeLessThan(vi.mocked(confirm).mock.invocationCallOrder[0]);
    });

    it('should warn about running worktree servers (S1-012 / S3-008)', async () => {
      vi.mocked(listRunningWorktreeServers).mockResolvedValue([135, 200]);

      await updateCommand({ yes: true });

      expect(output()).toContain('Issue #135');
      expect(output()).toContain('Issue #200');
    });

    it('should recommend stopping worktree servers BEFORE the update (S3-008)', async () => {
      vi.mocked(listRunningWorktreeServers).mockResolvedValue([135]);

      await updateCommand({ yes: true });

      expect(output()).toContain('commandmate stop --issue 135');
      expect(output()).toContain('update 前');
      expect(output()).toContain('異常終了');
    });

    it('should not print a worktree warning when none are running', async () => {
      await updateCommand({ yes: true });

      expect(output()).not.toContain('--issue');
    });
  });

  describe('stop / install / start sequencing (D-6)', () => {
    it('should stop, install, then start in order when the server is running', async () => {
      await updateCommand({ yes: true });

      expect(daemon.stop).toHaveBeenCalled();
      expect(installCalls()).toHaveLength(1);
      expect(daemon.start).toHaveBeenCalled();

      const stopOrder = daemon.stop.mock.invocationCallOrder[0];
      const installOrder = vi
        .mocked(childProcess.spawnSync)
        .mock.invocationCallOrder[
          vi
            .mocked(childProcess.spawnSync)
            .mock.calls.findIndex((call) => (call[1] as string[])?.[0] === 'install')
        ];
      const startOrder = daemon.start.mock.invocationCallOrder[0];

      expect(stopOrder).toBeLessThan(installOrder);
      expect(installOrder).toBeLessThan(startOrder);
    });

    it('should install commandmate@latest globally', async () => {
      await updateCommand({ yes: true });

      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', 'commandmate@latest'],
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });

    it('should neither stop nor start when the server was not running', async () => {
      daemon.isRunning.mockResolvedValue(false);

      await updateCommand({ yes: true });

      expect(daemon.stop).not.toHaveBeenCalled();
      expect(daemon.start).not.toHaveBeenCalled();
      expect(installCalls()).toHaveLength(1);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should load .env before deriving daemon state (D-13)', async () => {
      await updateCommand({ yes: true });

      expect(dotenvConfig).toHaveBeenCalledWith({ path: '/mock/home/.commandmate/.env' });
    });

    it('should restart with dev disabled', async () => {
      await updateCommand({ yes: true });

      expect(daemon.start).toHaveBeenCalledWith(expect.objectContaining({ dev: false }));
    });
  });

  describe('stop failure (step 6)', () => {
    beforeEach(() => {
      mockNpm({ latest: '1.0.0' });
      daemon.isRunning.mockResolvedValue(true);
      daemon.stop.mockResolvedValue(false);
    });

    it('should exit STOP_FAILED', async () => {
      await updateCommand({ yes: true });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.STOP_FAILED);
    });

    it('should abort before installing anything', async () => {
      await updateCommand({ yes: true });

      expect(childProcess.spawnSync).not.toHaveBeenCalledWith(
        'npm',
        expect.arrayContaining(['install']),
        expect.anything()
      );
      expect(daemon.start).not.toHaveBeenCalled();
    });
  });

  describe('npm install failure (step 10)', () => {
    it('should exit UPDATE_FAILED', async () => {
      mockNpm({ latest: '1.0.0', installStatus: 1, installStderr: 'network error' });

      await updateCommand({ yes: true });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.UPDATE_FAILED);
    });

    it('should print rollback guidance containing the pre-update version', async () => {
      mockNpm({ latest: '1.0.0', installStatus: 1, installStderr: 'network error' });

      await updateCommand({ yes: true });

      expect(output()).toContain('npm install -g commandmate@0.9.0');
    });

    it('should not start the server after a failed install', async () => {
      mockNpm({ latest: '1.0.0', installStatus: 1, installStderr: 'network error' });

      await updateCommand({ yes: true });

      expect(daemon.start).not.toHaveBeenCalled();
    });
  });

  describe('EACCES handling (step 7)', () => {
    beforeEach(() => {
      mockNpm({
        latest: '1.0.0',
        installStatus: 243,
        installStderr: 'npm ERR! code EACCES\nnpm ERR! syscall mkdir',
      });
    });

    it('should exit UPDATE_FAILED', async () => {
      await updateCommand({ yes: true });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.UPDATE_FAILED);
    });

    it('should not suggest sudo', async () => {
      await updateCommand({ yes: true });

      expect(output().toLowerCase()).not.toContain('sudo');
    });

    it('should point at the cli-setup-guide EACCES section', async () => {
      await updateCommand({ yes: true });

      expect(output()).toContain('cli-setup-guide');
    });
  });

  describe('post-install version verification (step 8 / S1-007 / D-17)', () => {
    beforeEach(() => {
      // package.json still reports the old version after install
      mockPackageJson('0.9.0', '0.9.0');
      mockNpm({ latest: '1.0.0' });
    });

    it('should exit UPDATE_FAILED', async () => {
      await updateCommand({ yes: true });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.UPDATE_FAILED);
    });

    it('should not start the server', async () => {
      await updateCommand({ yes: true });

      expect(daemon.start).not.toHaveBeenCalled();
    });

    it('should mention a possible project-local install (D-17)', async () => {
      await updateCommand({ yes: true });

      expect(output()).toContain('プロジェクトローカル');
      expect(output()).toContain('npm ls -g commandmate');
    });

    it('should print rollback guidance', async () => {
      await updateCommand({ yes: true });

      expect(output()).toContain('npm install -g commandmate@0.9.0');
    });

    it('should re-read package.json after the install', async () => {
      await updateCommand({ yes: true });

      expect(vi.mocked(fs.readFileSync).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('health check (D-5 / D-12 / D-13)', () => {
    it('should derive the base URL from getStatus().url (S3-003)', async () => {
      daemon.getStatus.mockResolvedValue({ running: true, url: 'https://127.0.0.1:3443' });

      await updateCommand({ yes: true });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://127.0.0.1:3443/api/repositories',
        expect.anything()
      );
    });

    it('should pass redirect: manual to fetch (S3-001)', async () => {
      await updateCommand({ yes: true });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: 'manual' })
      );
    });

    it('should report success and exit SUCCESS when READY', async () => {
      await updateCommand({ yes: true });

      expect(output()).toContain('http://127.0.0.1:3000');
      expect(output()).toMatch(/ready/i);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should send Authorization: Bearer when CM_AUTH_TOKEN is set', async () => {
      process.env.CM_AUTH_TOKEN = 'tok-123';

      await updateCommand({ yes: true });

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-123' });
    });

    it('should not send Authorization when CM_AUTH_TOKEN is unset', async () => {
      await updateCommand({ yes: true });

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('should degrade (not succeed) on a 307 to /login (S3-001 core)', async () => {
      mockFetch.mockResolvedValue(makeResponse(307, 'text/html'));

      await updateCommand({ yes: true });

      expect(output()).toContain('マイグレーション完了は確認できませんでした');
      expect(output()).not.toMatch(/is ready at/);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should degrade on 401', async () => {
      mockFetch.mockResolvedValue(makeResponse(401, 'application/json', { error: 'unauthorized' }));

      await updateCommand({ yes: true });

      expect(output()).toContain('マイグレーション完了は確認できませんでした');
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should degrade on 403', async () => {
      mockFetch.mockResolvedValue(makeResponse(403, 'application/json', { error: 'forbidden' }));

      await updateCommand({ yes: true });

      expect(output()).toContain('マイグレーション完了は確認できませんでした');
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should suggest commandmate status when degraded', async () => {
      mockFetch.mockResolvedValue(makeResponse(307, 'text/html'));

      await updateCommand({ yes: true });

      expect(output()).toContain('commandmate status');
    });

    it('should not treat 200 HTML as READY', async () => {
      mockFetch.mockResolvedValue(makeResponse(200, 'text/html; charset=utf-8'));

      await runWithTimers({ yes: true });

      expect(output()).not.toMatch(/is ready at/);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.START_FAILED);
    });

    it('should exit START_FAILED on timeout', async () => {
      mockFetch.mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        })
      );

      await runWithTimers({ yes: true });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.START_FAILED);
    });

    it('should not print rollback guidance on timeout (the update succeeded)', async () => {
      mockFetch.mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        })
      );

      await runWithTimers({ yes: true });

      expect(output()).not.toContain('npm install -g commandmate@0.9.0');
      expect(output()).toContain('commandmate status');
    });
  });

  describe('unexpected errors', () => {
    it('should exit UNEXPECTED_ERROR when package.json is unreadable', async () => {
      // mockReset() first: queued mockReturnValueOnce values would otherwise
      // take precedence over the throwing implementation.
      vi.mocked(fs.readFileSync).mockReset();
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      await updateCommand({ check: true });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    });
  });
});
