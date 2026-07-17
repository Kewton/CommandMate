/**
 * Daemon Manager Tests
 * Tests for daemon process management (start/stop)
 * Issue #125: Add .env loading and security warning tests
 * Note: Testing DaemonManager methods via integration with PidManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

vi.mock('child_process');
vi.mock('fs');
vi.mock('dotenv');
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: vi.fn(() => '/mock/.commandmate/.env'),
}));
// Issue #1354: the daemon records the installed version into the state file at start()
vi.mock('../../../../src/cli/utils/package-info', () => ({
  readPackageVersion: () => '1.2.3',
}));

// Import after mocking
import { DaemonManager } from '../../../../src/cli/utils/daemon';

describe('DaemonManager', () => {
  let daemonManager: DaemonManager;
  const testPidPath = '/tmp/test-commandmate.pid';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for dotenv.config - used by start()
    vi.mocked(dotenv.config).mockReturnValue({ parsed: {} });
    daemonManager = new DaemonManager(testPidPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('should start daemon process when not running', async () => {
      // Mock PidManager.isProcessRunning() via fs checks
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      const pid = await daemonManager.start({});

      expect(pid).toBe(12345);
      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        ['run', 'start'],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
        })
      );
      expect(mockChild.unref).toHaveBeenCalled();
    });

    it('should throw error if already running', async () => {
      // Mock process already running
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('99999');

      // Mock process.kill to return true (process exists)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await expect(daemonManager.start({})).rejects.toThrow('already running');

      killSpy.mockRestore();
    });

    it('should persist version, effective settings, and identity to the state file (Issue #1354/#1355/#1358)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: {
          CM_PORT: '4000',
          CM_BIND: '127.0.0.1',
          CM_HTTPS_CERT: '/certs/localhost.pem',
          CM_HTTPS_KEY: '/certs/localhost-key.pem',
          CM_AUTH_TOKEN_HASH: 'deadbeef',
        },
      });
      vi.mocked(childProcess.spawn).mockReturnValue({
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      } as unknown as childProcess.ChildProcess);

      await daemonManager.start({});

      const written = vi.mocked(fs.writeSync).mock.calls[0][1] as string;
      const state = JSON.parse(written);
      expect(state).toMatchObject({
        pid: 12345,
        version: '1.2.3',
        port: 4000,
        bind: '127.0.0.1',
        protocol: 'https',
        auth: true,
      });
      expect(typeof state.startedAt).toBe('string');
    });

    it('should use dev mode when specified', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await daemonManager.start({ dev: true });

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        ['run', 'dev'],
        expect.any(Object)
      );
    });
  });

  describe('stop', () => {
    it('should stop daemon and remove PID file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

      // kill(pid, 0) for isProcessRunning returns true
      // kill(pid, SIGTERM) succeeds
      // Subsequent kill(pid, 0) throws ESRCH (process exited)
      const killSpy = vi.spyOn(process, 'kill')
        .mockImplementationOnce(() => true)  // isProcessRunning check
        .mockImplementationOnce(() => true)  // SIGTERM
        .mockImplementation(() => {
          // waitForExit: process no longer running
          const error = new Error('No such process') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        });

      const result = await daemonManager.stop();

      expect(result).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');

      killSpy.mockRestore();
    });

    it('should return false when no PID file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await daemonManager.stop();

      expect(result).toBe(false);
    });

    it('should clean up stale PID when process not running', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

      // Process not found
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

      const result = await daemonManager.stop();

      expect(result).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalled();

      killSpy.mockRestore();
    });
  });

  describe('getStatus', () => {
    it('should return running status with details', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const status = await daemonManager.getStatus();

      expect(status).not.toBeNull();
      expect(status?.running).toBe(true);
      expect(status?.pid).toBe(12345);

      killSpy.mockRestore();
    });

    it('should return not running when process is dead', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

      const status = await daemonManager.getStatus();

      expect(status?.running).toBe(false);

      killSpy.mockRestore();
    });

    it('should return null when no PID file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const status = await daemonManager.getStatus();

      expect(status).toBeNull();
    });

    /**
     * Issue #1266: getStatus() read process.env directly, which dotenv leaves untouched when
     * CM_PORT is already exported, so it reported the shell's port while the server that
     * start() spawned with {...process.env, ...parsed} was listening on the .env port.
     */
    describe('URL resolution (Issue #1266)', () => {
      beforeEach(() => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('12345');
        vi.spyOn(process, 'kill').mockImplementation(() => true);
      });

      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it('should report the .env port, not the exported CM_PORT', async () => {
        vi.stubEnv('CM_PORT', '3000');
        vi.mocked(dotenv.config).mockReturnValue({ parsed: { CM_PORT: '3101' } });

        const status = await daemonManager.getStatus();

        expect(status?.port).toBe(3101);
        expect(status?.url).toBe('http://127.0.0.1:3101');
      });

      it('should report the .env bind address, not the exported CM_BIND', async () => {
        vi.stubEnv('CM_BIND', '127.0.0.1');
        vi.mocked(dotenv.config).mockReturnValue({
          parsed: { CM_BIND: '192.168.1.5', CM_PORT: '3101' },
        });

        const status = await daemonManager.getStatus();

        expect(status?.url).toBe('http://192.168.1.5:3101');
      });

      it('should keep an exported CM_PORT that .env does not override', async () => {
        vi.stubEnv('CM_PORT', '4000');
        vi.mocked(dotenv.config).mockReturnValue({ parsed: { CM_BIND: '127.0.0.1' } });

        const status = await daemonManager.getStatus();

        expect(status?.port).toBe(4000);
      });

      it('should read the worktree .env it was constructed with', async () => {
        const worktreeManager = new DaemonManager(testPidPath, '/mock/.commandmate/envs/135.env');
        vi.mocked(dotenv.config).mockImplementation(((options: { path: string }) =>
          options.path === '/mock/.commandmate/envs/135.env'
            ? { parsed: { CM_PORT: '3135' } }
            : { parsed: { CM_PORT: '3101' } }) as unknown as typeof dotenv.config);

        const status = await worktreeManager.getStatus();

        expect(dotenv.config).toHaveBeenCalledWith({ path: '/mock/.commandmate/envs/135.env' });
        expect(status?.port).toBe(3135);
      });
    });

    /**
     * Issue #1354/#1355: a state file records the version and effective settings the daemon was
     * started with, so getStatus() reports the real server instead of re-deriving from .env.
     */
    describe('recorded state (Issue #1354/#1355)', () => {
      it('should report version, protocol, auth and the recorded URL', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({
            pid: 12345,
            version: '1.2.3',
            port: 4000,
            bind: '0.0.0.0',
            protocol: 'https',
            auth: true,
          })
        );
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

        const status = await daemonManager.getStatus();

        expect(status).toMatchObject({
          running: true,
          pid: 12345,
          version: '1.2.3',
          port: 4000,
          protocol: 'https',
          auth: true,
          url: 'https://127.0.0.1:4000',
        });

        killSpy.mockRestore();
      });

      it('should prefer the recorded port over the current .env port (Issue #1355)', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({ pid: 12345, port: 4000, bind: '127.0.0.1', protocol: 'http' })
        );
        // .env now says 3000, but the server was started on 4000
        vi.mocked(dotenv.config).mockReturnValue({ parsed: { CM_PORT: '3000' } });
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

        const status = await daemonManager.getStatus();

        expect(status?.port).toBe(4000);
        expect(status?.url).toBe('http://127.0.0.1:4000');

        killSpy.mockRestore();
      });
    });
  });

  describe('isRunning', () => {
    it('should return true when process is running', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      expect(await daemonManager.isRunning()).toBe(true);

      killSpy.mockRestore();
    });

    it('should return false when process is not running', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(await daemonManager.isRunning()).toBe(false);
    });
  });

  /**
   * Issue #1266: server.ts:160 upgrades to HTTPS only when both cert and key are set, so the
   * startup banner must not announce a scheme the spawned child does not actually speak.
   */
  describe('start startup banner protocol (Issue #1266)', () => {
    function mockSpawnableDaemon(parsed: Record<string, string>): void {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      vi.mocked(dotenv.config).mockReturnValue({ parsed });
      vi.mocked(childProcess.spawn).mockReturnValue({
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      } as unknown as childProcess.ChildProcess);
    }

    it('should announce https when both cert and key are configured', async () => {
      mockSpawnableDaemon({
        CM_PORT: '3101',
        CM_HTTPS_CERT: '/certs/localhost.pem',
        CM_HTTPS_KEY: '/certs/localhost-key.pem',
      });
      const logSpy = vi.spyOn(console, 'log');

      await daemonManager.start({});

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('https://127.0.0.1:3101'));
    });

    it('should announce http when a cert is configured without a key', async () => {
      mockSpawnableDaemon({ CM_PORT: '3101', CM_HTTPS_CERT: '/certs/localhost.pem' });
      const logSpy = vi.spyOn(console, 'log');

      await daemonManager.start({});

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:3101'));
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('https://'));
    });
  });

  describe('start security warnings (Issue #125)', () => {
    it('should log warning when binding to 0.0.0.0 without auth token', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_BIND: '0.0.0.0', CM_PORT: '3000' },
      });

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      // Spy on console to verify warning logs
      const warnSpy = vi.spyOn(console, 'log');

      const pid = await daemonManager.start({});

      expect(pid).toBe(12345);
      // Verify warning was logged (CLILogger uses console.log)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('0.0.0.0')
      );
    });

    it('should log reverse proxy warning when binding to 0.0.0.0 (Issue #179)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_BIND: '0.0.0.0', CM_PORT: '3000' },
      });

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      const logSpy = vi.spyOn(console, 'log');

      const pid = await daemonManager.start({});

      expect(pid).toBe(12345);
      // Should log reverse proxy warning (contains "reverse proxy" or "authentication")
      const reverseProxyWarnings = logSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('reverse proxy')
      );
      expect(reverseProxyWarnings.length).toBeGreaterThan(0);
    });

    it('should not log warning when binding to localhost', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_BIND: '127.0.0.1', CM_PORT: '3000' },
      });

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      const warnSpy = vi.spyOn(console, 'log');

      const pid = await daemonManager.start({});

      expect(pid).toBe(12345);
      // Should not log any external access warning
      const externalAccessWarnings = warnSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('external networks')
      );
      expect(externalAccessWarnings).toHaveLength(0);
    });
  });

  describe('CLAUDECODE environment variable removal (Issue #265, SF-003)', () => {
    it('should remove CLAUDECODE from spawn env object', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      vi.mocked(dotenv.config).mockReturnValue({ parsed: {} });

      // Simulate CLAUDECODE being set in process.env
      const originalClaudeCode = process.env.CLAUDECODE;
      process.env.CLAUDECODE = '1';

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await daemonManager.start({});

      // Verify spawn was called with env that does NOT contain CLAUDECODE
      const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
      const spawnEnv = (spawnCall[2] as { env: NodeJS.ProcessEnv }).env;
      expect(spawnEnv.CLAUDECODE).toBeUndefined();

      // Restore original value
      if (originalClaudeCode === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = originalClaudeCode;
      }
    });

    it('should not affect other environment variables when removing CLAUDECODE', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_PORT: '3000' },
      });

      const originalClaudeCode = process.env.CLAUDECODE;
      process.env.CLAUDECODE = '1';

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await daemonManager.start({});

      // Verify CLAUDECODE is removed but other env vars preserved
      const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
      const spawnEnv = (spawnCall[2] as { env: NodeJS.ProcessEnv }).env;
      expect(spawnEnv.CLAUDECODE).toBeUndefined();
      expect(spawnEnv.CM_PORT).toBe('3000');

      if (originalClaudeCode === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = originalClaudeCode;
      }
    });
  });

  describe('start with .env loading (Issue #125)', () => {
    it('should load .env file using dotenv', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_PORT: '3000', CM_ROOT_DIR: '/repos' },
      });

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      const pid = await daemonManager.start({});

      expect(pid).toBe(12345);
      expect(dotenv.config).toHaveBeenCalledWith({ path: '/mock/.commandmate/.env' });
    });

    it('should pass .env variables to child process', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_PORT: '4000', CM_ROOT_DIR: '/custom/repos' },
      });

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await daemonManager.start({});

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            CM_PORT: '4000',
            CM_ROOT_DIR: '/custom/repos',
          }),
        })
      );
    });

    it('should fallback when .env loading fails', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      // Mock error response - use type casting to handle DotenvError type
      const mockError = new Error('File not found') as Error & { code: string };
      mockError.code = 'NOT_FOUND_DOTENV_ENVIRONMENT';
      vi.mocked(dotenv.config).mockReturnValue({
        error: mockError as dotenv.DotenvConfigOutput['error'],
      });

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      // Should not throw, should fallback to process.env
      const pid = await daemonManager.start({});

      expect(pid).toBe(12345);
    });

    it('should allow command line port to override .env port', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_PORT: '3000' },
      });

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await daemonManager.start({ port: 5000 });

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            CM_PORT: '5000',
          }),
        })
      );
    });
  });
});
