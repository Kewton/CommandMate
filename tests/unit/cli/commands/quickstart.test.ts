/**
 * Quickstart Command Tests
 * Issue #1195: `npx commandmate` with no arguments walks the user from zero to a running server.
 *
 * Every collaborator is mocked: the flow must never touch the real filesystem, spawn a
 * daemon or open a browser while under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import * as fs from 'fs';

vi.mock('fs');
vi.mock('dotenv', () => ({ config: vi.fn(() => ({ parsed: {} })) }));
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: vi.fn(() => '/mock/home/.commandmate/.env'),
  getPidFilePath: vi.fn(() => '/mock/home/.commandmate/.commandmate.pid'),
}));
vi.mock('../../../../src/cli/utils/prompt', () => ({ isInteractive: vi.fn(() => true) }));
vi.mock('../../../../src/cli/commands/init', () => ({ runInit: vi.fn() }));
vi.mock('../../../../src/cli/commands/start', () => ({ runStart: vi.fn() }));
vi.mock('../../../../src/cli/utils/server-ready', () => ({ waitForServer: vi.fn() }));
vi.mock('../../../../src/cli/utils/browser', () => ({
  shouldOpenBrowser: vi.fn(() => true),
  openBrowser: vi.fn(),
}));
vi.mock('../../../../src/cli/utils/daemon', () => ({ DaemonManager: vi.fn() }));
vi.mock('../../../../src/cli/utils/preflight', () => {
  const PreflightChecker = vi.fn();
  (PreflightChecker as unknown as { getInstallHint: unknown }).getInstallHint = vi.fn(
    (name: string) => `Install ${name}`
  );
  return { PreflightChecker };
});
vi.mock('../../../../src/cli/program', () => ({ buildProgram: vi.fn() }));

// Import after mocking
import { quickstartCommand } from '../../../../src/cli/commands/quickstart';
import { ExitCode } from '../../../../src/cli/types';
import { runInit } from '../../../../src/cli/commands/init';
import { runStart } from '../../../../src/cli/commands/start';
import { waitForServer } from '../../../../src/cli/utils/server-ready';
import { openBrowser, shouldOpenBrowser } from '../../../../src/cli/utils/browser';
import { DaemonManager } from '../../../../src/cli/utils/daemon';
import { PreflightChecker } from '../../../../src/cli/utils/preflight';
import { isInteractive } from '../../../../src/cli/utils/prompt';
import { buildProgram } from '../../../../src/cli/program';
import { config as dotenvConfig } from 'dotenv';

const ENV_PATH = '/mock/home/.commandmate/.env';
const SERVER_URL = 'http://127.0.0.1:3000';

let stdout: string[];
let stderr: string[];
let mockExit: Mock;

/** .env presence drives the init-vs-preflight branch */
function mockEnvExists(exists: boolean): void {
  vi.mocked(fs.existsSync).mockImplementation((path) => path === ENV_PATH && exists);
}

// Mock implementations used with `new` must be plain functions: vitest constructs them via
// Reflect.construct, which rejects arrow functions.
function mockDaemon(running: boolean, url: string = SERVER_URL): { isRunning: Mock; getStatus: Mock } {
  const instance = {
    isRunning: vi.fn().mockResolvedValue(running),
    getStatus: vi.fn().mockResolvedValue(running ? { running: true, pid: 4321, port: 3000, url } : null),
  };
  vi.mocked(DaemonManager).mockImplementation(function (): DaemonManager {
    return instance as unknown as DaemonManager;
  });
  return instance;
}

function mockPreflight(success: boolean): Mock {
  const checkAll = vi.fn().mockResolvedValue({
    success,
    results: success
      ? [{ name: 'git', status: 'ok', version: '2.39.0' }]
      : [{ name: 'tmux', status: 'missing' }],
  });
  vi.mocked(PreflightChecker).mockImplementation(function (): PreflightChecker {
    return { checkAll } as unknown as PreflightChecker;
  });
  return checkAll;
}

function mockStartSucceeds(url: string = SERVER_URL): void {
  vi.mocked(runStart).mockResolvedValue({ ok: true, exitCode: ExitCode.SUCCESS, url, pid: 4321 });
}

/** process.exit is mocked to throw, so a completed run always rejects */
async function run(options: { open?: boolean } = {}): Promise<void> {
  await expect(quickstartCommand(options)).rejects.toThrow('process.exit called');
}

function output(): string {
  return [...stdout, ...stderr].join('\n');
}

describe('quickstartCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(' '));
    });

    mockExit = vi.fn().mockImplementation(() => {
      throw new Error('process.exit called');
    });
    vi.spyOn(process, 'exit').mockImplementation(mockExit as unknown as typeof process.exit);

    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(shouldOpenBrowser).mockReturnValue(true);
    vi.mocked(waitForServer).mockResolvedValue(true);
    vi.mocked(runInit).mockResolvedValue({ ok: true, exitCode: ExitCode.SUCCESS, envPath: ENV_PATH });
    mockStartSucceeds();
    mockEnvExists(true);
    mockPreflight(true);
    mockDaemon(false);
    vi.mocked(buildProgram).mockReturnValue({ outputHelp: vi.fn() } as unknown as ReturnType<typeof buildProgram>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // AC #1
  describe('interactive, no .env, server stopped', () => {
    beforeEach(() => {
      mockEnvExists(false);
    });

    it('should run init, start the daemon, wait for readiness, show the URL and open the browser', async () => {
      await run();

      expect(runInit).toHaveBeenCalledWith({});
      expect(runStart).toHaveBeenCalledWith({ daemon: true });
      expect(waitForServer).toHaveBeenCalledWith('127.0.0.1', 3000);
      expect(output()).toContain(SERVER_URL);
      expect(openBrowser).toHaveBeenCalledWith(SERVER_URL);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should run init before starting the server', async () => {
      await run();

      expect(vi.mocked(runInit).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(runStart).mock.invocationCallOrder[0]
      );
    });

    it('should exit with the init exit code and not start the server when init fails', async () => {
      vi.mocked(runInit).mockResolvedValue({ ok: false, exitCode: ExitCode.CONFIG_ERROR });

      await run();

      expect(runStart).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    });

    // AC #6: init already runs preflight internally; running it here too would double-check
    it('should not run preflight itself (init owns it)', async () => {
      const checkAll = mockPreflight(true);

      await run();

      expect(checkAll).not.toHaveBeenCalled();
      expect(PreflightChecker).not.toHaveBeenCalled();
    });
  });

  // AC #2
  describe('interactive, .env present, server stopped', () => {
    it('should run preflight, start the daemon, wait for readiness, show the URL and open the browser', async () => {
      const checkAll = mockPreflight(true);

      await run();

      expect(checkAll).toHaveBeenCalled();
      expect(runInit).not.toHaveBeenCalled();
      expect(runStart).toHaveBeenCalledWith({ daemon: true });
      expect(waitForServer).toHaveBeenCalledWith('127.0.0.1', 3000);
      expect(output()).toContain(SERVER_URL);
      expect(openBrowser).toHaveBeenCalledWith(SERVER_URL);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should exit with the start exit code when starting fails', async () => {
      vi.mocked(runStart).mockResolvedValue({ ok: false, exitCode: ExitCode.START_FAILED });

      await run();

      expect(waitForServer).not.toHaveBeenCalled();
      expect(openBrowser).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.START_FAILED);
    });

    it('should load .env before resolving the server URL', async () => {
      // PID files hold only the PID: port/bind are read from process.env (daemon.ts)
      await run();

      expect(dotenvConfig).toHaveBeenCalledWith({ path: ENV_PATH });
      expect(vi.mocked(dotenvConfig).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(DaemonManager).mock.invocationCallOrder[0]
      );
    });
  });

  // AC #3
  describe('interactive, .env present, server already running', () => {
    it('should not start the server again, report it is running and open the URL', async () => {
      const daemon = mockDaemon(true);

      await run();

      expect(daemon.isRunning).toHaveBeenCalled();
      expect(runStart).not.toHaveBeenCalled();
      expect(output()).toContain('already running');
      expect(output()).toContain(SERVER_URL);
      expect(openBrowser).toHaveBeenCalledWith(SERVER_URL);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should not wait for readiness when the server is already running', async () => {
      mockDaemon(true);

      await run();

      expect(waitForServer).not.toHaveBeenCalled();
    });

    // getStatus() derives its URL from process.env, which dotenv will not overwrite when
    // CM_PORT is exported, so the announced URL pointed at the shell's port instead.
    it('should announce the .env url, not the exported CM_PORT that getStatus reports', async () => {
      mockDaemon(true, 'http://127.0.0.1:3000');
      vi.stubEnv('CM_PORT', '3000');
      vi.mocked(dotenvConfig).mockReturnValue({
        parsed: { CM_PORT: '31951', CM_BIND: '127.0.0.1' },
      } as ReturnType<typeof dotenvConfig>);

      await run();

      expect(output()).toContain('http://127.0.0.1:31951');
      expect(openBrowser).toHaveBeenCalledWith('http://127.0.0.1:31951');
    });
  });

  // AC #4
  describe('non-interactive', () => {
    it('should print help to stderr, exit 1 and touch nothing else', async () => {
      const outputHelp = vi.fn();
      vi.mocked(isInteractive).mockReturnValue(false);
      vi.mocked(buildProgram).mockReturnValue({ outputHelp } as unknown as ReturnType<typeof buildProgram>);

      await run();

      expect(outputHelp).toHaveBeenCalledWith({ error: true });
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(runInit).not.toHaveBeenCalled();
      expect(runStart).not.toHaveBeenCalled();
      expect(PreflightChecker).not.toHaveBeenCalled();
      expect(openBrowser).not.toHaveBeenCalled();
    });
  });

  // AC #5
  describe('preflight failure', () => {
    it('should exit with DEPENDENCY_ERROR and not start the server', async () => {
      mockPreflight(false);

      await run();

      expect(runStart).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.DEPENDENCY_ERROR);
    });

    it('should report the missing dependency with an install hint', async () => {
      mockPreflight(false);

      await run();

      expect(output()).toContain('tmux');
      expect(output()).toContain('Install tmux');
    });
  });

  // AC #7
  describe('browser suppression', () => {
    it('should show the URL without opening a browser when the environment opts out', async () => {
      vi.mocked(shouldOpenBrowser).mockReturnValue(false);

      await run();

      expect(openBrowser).not.toHaveBeenCalled();
      expect(output()).toContain(SERVER_URL);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    // AC #9
    it('should not open a browser when --no-open is given', async () => {
      await run({ open: false });

      expect(openBrowser).not.toHaveBeenCalled();
      expect(shouldOpenBrowser).not.toHaveBeenCalled();
      expect(output()).toContain(SERVER_URL);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should open the browser when open is explicitly true', async () => {
      await run({ open: true });

      expect(openBrowser).toHaveBeenCalledWith(SERVER_URL);
    });
  });

  // AC #8
  describe('readiness timeout', () => {
    it('should still show the URL and exit successfully', async () => {
      vi.mocked(waitForServer).mockResolvedValue(false);

      await run();

      expect(output()).toContain(SERVER_URL);
      expect(openBrowser).toHaveBeenCalledWith(SERVER_URL);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });
  });

  describe('readiness endpoint resolution', () => {
    it('should poll the https default port when the URL has no explicit port', async () => {
      mockStartSucceeds('https://localhost');

      await run();

      expect(waitForServer).toHaveBeenCalledWith('localhost', 443);
    });

    it('should skip readiness polling when the URL cannot be parsed', async () => {
      vi.mocked(runStart).mockResolvedValue({ ok: true, exitCode: ExitCode.SUCCESS, pid: 4321 });

      await run();

      expect(waitForServer).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });
  });

  describe('unexpected failures', () => {
    it('should exit with UNEXPECTED_ERROR when a collaborator throws', async () => {
      mockPreflight(true);
      vi.mocked(DaemonManager).mockImplementation(function (): DaemonManager {
        throw new Error('boom');
      });

      await run();

      expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
      expect(output()).toContain('boom');
    });
  });
});
