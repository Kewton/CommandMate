/**
 * Issue #3731: `start --daemon` (and `update`, which restarts through it) spawned the server
 * with `stdio: 'ignore'`, so everything it printed went to /dev/null and
 * `~/.commandmate/logs/server.log` (which the docs tell users to tail) never existed.
 *
 * The npm the daemon spawns is replaced by a real stand-in child that prints to stdout and
 * stderr, so these tests check the descriptors the child actually inherited, not just the
 * spawn arguments. Everything lives under a private config directory in os.tmpdir().
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ctx = vi.hoisted(() => ({ configDir: '', children: [] as childProcess.ChildProcess[] }));

const STAND_IN_SERVER =
  "process.stdout.write('stand-in stdout\\n'); process.stderr.write('stand-in stderr\\n');";

// `start()` spawns `npm run start`; route that to the stand-in. Every other spawn
// (e.g. `ps` for the start-time signature) is left real.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      if (command !== 'npm') {
        return actual.spawn(command, args as string[], options);
      }
      const child = actual.spawn(process.execPath, ['-e', STAND_IN_SERVER], options);
      ctx.children.push(child);
      return child;
    }),
  };
});
vi.mock('../../../../src/cli/utils/install-context', () => ({
  getConfigDir: () => ctx.configDir,
  isGlobalInstall: () => true,
}));
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: () => join(ctx.configDir, 'missing.env'),
}));
vi.mock('../../../../src/cli/utils/server-ready', () => ({
  isPortInUse: vi.fn(async () => false),
  waitForServer: vi.fn(async () => true),
}));
vi.mock('../../../../src/cli/utils/package-info', () => ({
  readPackageVersion: () => '1.2.3',
}));
vi.mock('../../../../src/cli/utils/logger', () => ({
  CLILogger: class {
    info(): void {}
    warn(): void {}
    error(): void {}
    success(): void {}
  },
}));

import { DaemonManager, rotateServerLog } from '../../../../src/cli/utils/daemon';
import { getServerLogPath } from '../../../../src/cli/utils/paths';
import { DaemonManagerFactory } from '../../../../src/cli/utils/daemon-factory';

/** Wait for every stand-in the daemon spawned to exit, so its output has been written. */
async function waitForChildren(): Promise<void> {
  await Promise.all(
    ctx.children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
          } else {
            child.once('exit', () => resolve());
          }
        })
    )
  );
}

function spawnStdio(): childProcess.StdioOptions | undefined {
  const call = vi.mocked(childProcess.spawn).mock.calls.find(([command]) => command === 'npm');
  return (call?.[2] as childProcess.SpawnOptions | undefined)?.stdio;
}

describe('DaemonManager server log (Issue #3731)', () => {
  let pidFile: string;

  beforeEach(() => {
    ctx.configDir = mkdtempSync(join(tmpdir(), 'cm-server-log-3731-'));
    ctx.children = [];
    pidFile = join(ctx.configDir, '.commandmate.pid');
    vi.mocked(childProcess.spawn).mockClear();
  });

  afterEach(async () => {
    await waitForChildren();
    rmSync(ctx.configDir, { recursive: true, force: true });
  });

  describe('getServerLogPath', () => {
    it('puts the main server log at <configDir>/logs/server.log', () => {
      expect(getServerLogPath()).toBe(join(ctx.configDir, 'logs', 'server.log'));
    });

    it('gives each --issue server its own file', () => {
      expect(getServerLogPath(135)).toBe(join(ctx.configDir, 'logs', 'server-135.log'));
      expect(getServerLogPath(200)).not.toBe(getServerLogPath(135));
      expect(getServerLogPath(135)).not.toBe(getServerLogPath());
    });
  });

  describe('start()', () => {
    it("appends the child's stdout and stderr to the log file instead of discarding them", async () => {
      const logPath = getServerLogPath();
      const daemon = new DaemonManager(pidFile, undefined, () => logPath);

      await daemon.start({ port: 39731 });
      await waitForChildren();

      const stdio = spawnStdio();
      expect(Array.isArray(stdio)).toBe(true);
      expect((stdio as unknown[])[0]).toBe('ignore');
      expect(typeof (stdio as unknown[])[1]).toBe('number');
      expect((stdio as unknown[])[2]).toBe((stdio as unknown[])[1]);

      const log = readFileSync(logPath, 'utf-8');
      expect(log).toContain('stand-in stdout');
      expect(log).toContain('stand-in stderr');
      expect(log).toContain('commandmate start --daemon');
    });

    it('closes its own copy of the descriptor after spawning', async () => {
      const daemon = new DaemonManager(pidFile, undefined, () => getServerLogPath());

      await daemon.start({ port: 39731 });

      const fd = (spawnStdio() as number[])[1];
      expect(() => fstatSync(fd)).toThrow();
    });

    it('keeps what earlier servers wrote (append, not truncate)', async () => {
      const logPath = getServerLogPath();
      const daemon = new DaemonManager(pidFile, undefined, () => logPath);
      await daemon.start({ port: 39731 });
      await waitForChildren();
      // a second start, as `update` does after stopping the first server
      rmSync(pidFile, { force: true });
      await new DaemonManager(pidFile, undefined, () => logPath).start({ port: 39731 });
      await waitForChildren();

      const log = readFileSync(logPath, 'utf-8');
      expect(log.match(/stand-in stdout/g)).toHaveLength(2);
    });

    it('creates the log owner-only (0600) and tightens a looser existing one', async () => {
      const logPath = getServerLogPath();
      await new DaemonManager(pidFile, undefined, () => logPath).start({ port: 39731 });
      expect(statSync(logPath).mode & 0o777).toBe(0o600);

      chmodSync(logPath, 0o644);
      rmSync(pidFile, { force: true });
      await waitForChildren();
      await new DaemonManager(pidFile, undefined, () => logPath).start({ port: 39731 });
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    });

    it('writes --issue servers to separate files', async () => {
      const factory = new DaemonManagerFactory();
      mkdirSync(join(ctx.configDir, 'pids'));
      const savedDb = process.env.CM_DB_PATH;
      const savedIssue = process.env.CM_ISSUE_NO;
      try {
        await factory.create(135).start({ port: 39735 });
        await factory.create(200).start({ port: 39736 });
      } finally {
        // DaemonManagerWrapper.start() exports these for the child; keep them out of later tests
        if (savedDb === undefined) delete process.env.CM_DB_PATH;
        else process.env.CM_DB_PATH = savedDb;
        if (savedIssue === undefined) delete process.env.CM_ISSUE_NO;
        else process.env.CM_ISSUE_NO = savedIssue;
      }
      await waitForChildren();

      expect(readFileSync(getServerLogPath(135), 'utf-8')).toContain('stand-in stdout');
      expect(readFileSync(getServerLogPath(200), 'utf-8')).toContain('stand-in stdout');
      expect(existsSync(getServerLogPath())).toBe(false);
    });

    it('the main server from the factory (the one update restarts) writes to server.log', async () => {
      await new DaemonManagerFactory().create().start({ port: 39731 });
      await waitForChildren();

      expect(readFileSync(getServerLogPath(), 'utf-8')).toContain('stand-in stdout');
    });

    it('still starts the server, discarding output, when the log cannot be opened', async () => {
      // `logs` is a file, so the directory cannot be created
      writeFileSync(join(ctx.configDir, 'logs'), 'not a directory');
      const daemon = new DaemonManager(pidFile, undefined, () => getServerLogPath());

      const pid = await daemon.start({ port: 39731 });

      expect(pid).toBeGreaterThan(0);
      expect(spawnStdio()).toBe('ignore');
    });

    it('refuses to follow a symbolic link planted at the log path', async () => {
      const target = join(ctx.configDir, 'elsewhere.txt');
      writeFileSync(target, 'untouched');
      const logPath = getServerLogPath();
      mkdirSync(join(ctx.configDir, 'logs'));
      symlinkSync(target, logPath);

      const pid = await new DaemonManager(pidFile, undefined, () => logPath).start({ port: 39731 });
      await waitForChildren();

      expect(pid).toBeGreaterThan(0);
      expect(spawnStdio()).toBe('ignore');
      expect(readFileSync(target, 'utf-8')).toBe('untouched');
    });

    it('rotates an oversized log before the new server writes', async () => {
      const logPath = getServerLogPath();
      const daemon = new DaemonManager(pidFile, undefined, () => logPath);
      mkdirSync(join(ctx.configDir, 'logs'));
      writeFileSync(logPath, Buffer.alloc(10 * 1024 * 1024, 'x'));

      await daemon.start({ port: 39731 });
      await waitForChildren();

      expect(statSync(`${logPath}.1`).size).toBe(10 * 1024 * 1024);
      expect(statSync(logPath).size).toBeLessThan(1024);
      expect(readFileSync(logPath, 'utf-8')).toContain('stand-in stdout');
    });

    it('rotates a 0640 log left by scripts/start.sh into an owner-only (0600) .1', async () => {
      const logPath = getServerLogPath();
      mkdirSync(join(ctx.configDir, 'logs'));
      writeFileSync(logPath, Buffer.alloc(10 * 1024 * 1024 + 1, 'x'));
      chmodSync(logPath, 0o640);
      writeFileSync(`${logPath}.1`, 'older');
      chmodSync(`${logPath}.1`, 0o640);

      await new DaemonManager(pidFile, undefined, () => logPath).start({ port: 39731 });
      await waitForChildren();

      expect(statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);
      expect(statSync(`${logPath}.2`).mode & 0o777).toBe(0o600);
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    });

    // Negative control: under the limit nothing rotates; the live 0640 file is tightened in place.
    it('tightens a 0640 log under the limit to 0600 without rotating it', async () => {
      const logPath = getServerLogPath();
      mkdirSync(join(ctx.configDir, 'logs'));
      writeFileSync(logPath, 'earlier output\n');
      chmodSync(logPath, 0o640);

      await new DaemonManager(pidFile, undefined, () => logPath).start({ port: 39731 });
      await waitForChildren();

      expect(statSync(logPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(logPath, 'utf-8')).toContain('earlier output');
      expect(existsSync(`${logPath}.1`)).toBe(false);
    });

    // Negative control: a manager given no log path behaves exactly as before.
    it('discards output as before when no log path is given', async () => {
      await new DaemonManager(pidFile).start({ port: 39731 });

      expect(spawnStdio()).toBe('ignore');
      expect(existsSync(join(ctx.configDir, 'logs'))).toBe(false);
    });
  });

  describe('rotateServerLog', () => {
    let logPath: string;

    beforeEach(() => {
      logPath = join(ctx.configDir, 'server.log');
    });

    it('does nothing for a missing file or one under the limit', () => {
      expect(rotateServerLog(logPath, 10, 3)).toBe(false);
      writeFileSync(logPath, 'short');
      expect(rotateServerLog(logPath, 10, 3)).toBe(false);
      expect(readFileSync(logPath, 'utf-8')).toBe('short');
    });

    it('shifts generations and drops the oldest', () => {
      writeFileSync(logPath, 'current-over-limit');
      writeFileSync(`${logPath}.1`, 'gen1');
      writeFileSync(`${logPath}.2`, 'gen2');
      writeFileSync(`${logPath}.3`, 'gen3');

      expect(rotateServerLog(logPath, 10, 3)).toBe(true);

      expect(existsSync(logPath)).toBe(false);
      expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('current-over-limit');
      expect(readFileSync(`${logPath}.2`, 'utf-8')).toBe('gen1');
      expect(readFileSync(`${logPath}.3`, 'utf-8')).toBe('gen2');
      expect(existsSync(`${logPath}.4`)).toBe(false);
    });

    it('refuses to rotate through a symbolic link', () => {
      const target = join(ctx.configDir, 'target');
      writeFileSync(target, 'x'.repeat(100));
      symlinkSync(target, logPath);

      expect(() => rotateServerLog(logPath, 10, 3)).toThrow(/symbolic link/);
      expect(lstatSync(logPath).isSymbolicLink()).toBe(true);
    });
  });
});
