/**
 * Issue #4433: `start --daemon` marks the server it launches, so env-clean can
 * tell another worktree's server from the worker's own by evidence instead of
 * by the directory it runs in (the daemon runs in the package root, a sibling of
 * every worktree).
 *
 * The child gets `CM_SERVER_MARK=<record>`; the record names the process group
 * the detached spawn created (= the child's pid), the leader's start time read
 * as `LC_ALL=C TZ=UTC0 ps -o lstart=`, and where the CLI was launched from (its
 * own cwd, git root and tmux session — not the child's). Failing to mark never
 * fails the start, and a mark inherited from the parent never reaches the child.
 *
 * `npm` is never spawned (the spawn returns a stand-in object); the record
 * directory is under os.tmpdir() and removed afterwards; git, tmux and ps are
 * stubs.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ctx = vi.hoisted(() => ({ configDir: '' }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn(), on: vi.fn() })),
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

import { DaemonManager, type ServerMarkLauncherDeps } from '../../../../src/cli/utils/daemon';
import { parseServerMarkRecord, type ServerMarkRecord } from '../../../../src/cli/types/server-mark';
import { readServerMarkRecord, type EnvEntry } from '../../../../src/lib/verification/env-snapshot';
import { attributeListener } from '../../../../src/lib/verification/env-clean-gate';

const UID = process.getuid ? process.getuid() : 0;
const HEX = '0123456789abcdef0123456789abcdef';
const LSTART = 'Thu Nov 20 03:04:05 2026';

let root: string;
let base: string;
let launchDir: string;
let calls: Array<{ command: string; args: string[]; env?: Record<string, string> }>;

/** The launcher's pid, and the pid of the shell in the pane TMUX_PANE names. */
const LAUNCHER_PID = 5000;
const PANE_PID = 4000;

/**
 * Stubbed machine. `answers` replaces git / tmux / ps(lstart) output (null = the command fails);
 * `parents` is the `ps -o ppid=` chain (by default the launcher runs under the pane's shell).
 */
function deps(
  overrides: Partial<ServerMarkLauncherDeps> = {},
  answers: Record<string, string | null> = {},
  parents: Record<number, number> = { [LAUNCHER_PID]: 4500, 4500: PANE_PID, [PANE_PID]: 1 }
): Partial<ServerMarkLauncherDeps> {
  const table: Record<string, string | null> = {
    git: launchDir,
    tmux: `${PANE_PID} mcbd-claude-commandmate-judge`,
    ps: `  ${LSTART}`,
    ...answers,
  };
  return {
    base: () => base,
    getuid: () => UID,
    pid: () => LAUNCHER_PID,
    cwd: () => launchDir,
    env: () => ({ TMUX: '/private/tmp/tmux-501/default,999,0', TMUX_PANE: '%3' }),
    randomHex: () => HEX,
    now: () => new Date('2026-11-20T03:04:05.000Z'),
    run: (command, args, env) => {
      calls.push({ command, args, env });
      if (command === 'ps' && args[1] === 'ppid=') {
        const parent = parents[Number(args[3])];
        return parent === undefined ? { status: 1, stdout: '' } : { status: 0, stdout: ` ${parent}\n` };
      }
      const out = table[command];
      return out === null || out === undefined ? { status: 1, stdout: '' } : { status: 0, stdout: `${out}\n` };
    },
    ...overrides,
  };
}

/** How env-clean would attribute a listener carrying this record's mark, verified. */
function ownerOf(record: ServerMarkRecord): string {
  const worker = join(root, 'worker-wt');
  mkdirSync(worker, { recursive: true });
  const mark = { ...record, pid: 12346, anchor: launchDir, status: 'verified', reason: null };
  const entry = { key: 'tcp/3871', detail: 'node pid=12346', anchor: launchDir, marks: [mark] } as unknown as EnvEntry;
  return attributeListener(entry, { worktreeId: 'commandmate-issue-4433', worktreePath: worker });
}

function spawnedEnv(): NodeJS.ProcessEnv {
  const call = vi.mocked(childProcess.spawn).mock.calls.at(-1)!;
  return (call[2] as childProcess.SpawnOptions).env as NodeJS.ProcessEnv;
}

const markDir = (): string => join(base, `commandmate-server-marks-${UID}`);

beforeEach(() => {
  vi.mocked(childProcess.spawn).mockClear();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cm4433-daemon-')));
  ctx.configDir = join(root, 'config');
  mkdirSync(ctx.configDir);
  base = join(root, 'base');
  mkdirSync(base);
  launchDir = join(root, 'judge-wt');
  mkdirSync(launchDir);
  calls = [];
  delete process.env.CM_SERVER_MARK;
});

afterEach(() => {
  delete process.env.CM_SERVER_MARK;
  rmSync(root, { recursive: true, force: true });
});

describe('DaemonManager marks the server it starts (#4433)', () => {
  it('passes CM_SERVER_MARK to the child and writes the record of that launch', async () => {
    const manager = new DaemonManager(join(root, 'cm.pid'), undefined, undefined, deps());
    const pid = await manager.start({ port: 3871 });
    expect(pid).toBe(12345);

    const path = join(markDir(), `${HEX}.json`);
    expect(spawnedEnv().CM_SERVER_MARK).toBe(path);
    expect(statSync(markDir()).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const record = parseServerMarkRecord(readFileSync(path, 'utf8'));
    expect(record).toEqual({
      v: 1,
      launcher: 'daemon',
      pgid: 12345,
      leaderStartTime: LSTART,
      launcherCwd: launchDir,
      worktreeRoot: launchDir,
      repoRoot: null,
      session: 'mcbd-claude-commandmate-judge',
      launchedAt: '2026-11-20T03:04:05.000Z',
    });
    // The verifier's reader accepts what the launcher wrote.
    expect(readServerMarkRecord(path, UID)).toEqual({ ok: true, record });
  });

  it('reads the leader start time with a fixed locale and time zone, for the spawned pid', async () => {
    await new DaemonManager(join(root, 'cm.pid'), undefined, undefined, deps()).start({ port: 3871 });
    const ps = calls.find((call) => call.command === 'ps' && call.args[1] === 'lstart=');
    expect(ps?.args).toEqual(['-o', 'lstart=', '-p', '12345']);
    expect(ps?.env).toMatchObject({ LC_ALL: 'C', TZ: 'UTC0' });
  });

  it('asks tmux for the launcher’s own pane on the launcher’s own socket', async () => {
    await new DaemonManager(join(root, 'cm.pid'), undefined, undefined, deps()).start({ port: 3871 });
    const tmux = calls.find((call) => call.command === 'tmux');
    expect(tmux?.args).toEqual(['-S', '/private/tmp/tmux-501/default', 'display-message', '-p', '-t', '%3', '#{pane_pid} #S']);
  });

  it('records the session only when the launcher runs inside that pane (its shell is an ancestor)', async () => {
    await new DaemonManager(join(root, 'cm.pid'), undefined, undefined, deps()).start({ port: 3871 });
    const record = parseServerMarkRecord(readFileSync(spawnedEnv().CM_SERVER_MARK!, 'utf8'))!;
    expect(record.session).toBe('mcbd-claude-commandmate-judge');
    const walk = calls.filter((call) => call.command === 'ps' && call.args[1] === 'ppid=');
    expect(walk.map((call) => call.args[3])).toEqual([String(LAUNCHER_PID), '4500']);
    expect(walk[0].env).toMatchObject({ LC_ALL: 'C' });
    // The positive control: launched from another worktree's pane, the server is that worktree's.
    expect(ownerOf(record)).toBe('other');
  });

  it('records lookup-failed — and env-clean does not excuse it — when TMUX_PANE was inherited from a pane the launcher is not in', async () => {
    // e.g. a Schedule run (outside tmux) whose server was started from someone's pane.
    const outside = { [LAUNCHER_PID]: 4600, 4600: 4700, 4700: 1 };
    await new DaemonManager(join(root, 'cm.pid'), undefined, undefined, deps({}, {}, outside)).start({ port: 3871 });
    const record = parseServerMarkRecord(readFileSync(spawnedEnv().CM_SERVER_MARK!, 'utf8'))!;
    expect(record.session).toBe('lookup-failed');
    expect(ownerOf(record)).toBe('unattributed');
  });

  it('records lookup-failed when the parent chain cannot be read, or tmux gives no pane pid', async () => {
    await new DaemonManager(join(root, 'a.pid'), undefined, undefined, deps({}, {}, { [LAUNCHER_PID]: 4500 })).start({
      port: 3871,
    });
    expect(parseServerMarkRecord(readFileSync(spawnedEnv().CM_SERVER_MARK!, 'utf8'))?.session).toBe('lookup-failed');

    rmSync(markDir(), { recursive: true, force: true });
    await new DaemonManager(join(root, 'b.pid'), undefined, undefined, deps({}, { tmux: 'mcbd-claude-commandmate-judge' })).start({
      port: 3872,
    });
    expect(parseServerMarkRecord(readFileSync(spawnedEnv().CM_SERVER_MARK!, 'utf8'))?.session).toBe('lookup-failed');
  });

  it('records no-tmux outside tmux, and lookup-failed when tmux cannot answer', async () => {
    await new DaemonManager(join(root, 'a.pid'), undefined, undefined, deps({ env: () => ({}) })).start({ port: 3871 });
    const first = parseServerMarkRecord(readFileSync(spawnedEnv().CM_SERVER_MARK!, 'utf8'));
    expect(first?.session).toBe('no-tmux');

    rmSync(markDir(), { recursive: true, force: true });
    await new DaemonManager(join(root, 'b.pid'), undefined, undefined, deps({}, { tmux: null })).start({ port: 3872 });
    const second = parseServerMarkRecord(readFileSync(spawnedEnv().CM_SERVER_MARK!, 'utf8'));
    expect(second?.session).toBe('lookup-failed');
  });

  it('records a null worktree root when the launch directory is not in git', async () => {
    await new DaemonManager(join(root, 'cm.pid'), undefined, undefined, deps({}, { git: null })).start({ port: 3871 });
    const record = parseServerMarkRecord(readFileSync(spawnedEnv().CM_SERVER_MARK!, 'utf8'));
    expect(record?.worktreeRoot).toBeNull();
  });

  it('does not mark, and still starts, when the record directory is not private — and drops an inherited mark', async () => {
    mkdirSync(markDir());
    chmodSync(markDir(), 0o755);
    process.env.CM_SERVER_MARK = '/tmp/commandmate-server-marks-0/inherited.json';
    const pid = await new DaemonManager(join(root, 'cm.pid'), undefined, undefined, deps()).start({ port: 3871 });
    expect(pid).toBe(12345);
    expect('CM_SERVER_MARK' in spawnedEnv()).toBe(false);
    expect(existsSync(join(markDir(), `${HEX}.json`))).toBe(false);
  });

  it('replaces an inherited mark with its own', async () => {
    process.env.CM_SERVER_MARK = '/tmp/commandmate-server-marks-0/inherited.json';
    await new DaemonManager(join(root, 'cm.pid'), undefined, undefined, deps()).start({ port: 3871 });
    expect(spawnedEnv().CM_SERVER_MARK).toBe(join(markDir(), `${HEX}.json`));
  });

  it('writes no record, and still starts, when the leader start time cannot be read', async () => {
    const pid = await new DaemonManager(join(root, 'cm.pid'), undefined, undefined, deps({}, { ps: null })).start({
      port: 3871,
    });
    expect(pid).toBe(12345);
    expect(existsSync(join(markDir(), `${HEX}.json`))).toBe(false);
  });

  it('does not overwrite an existing file at the record path', async () => {
    mkdirSync(markDir(), { mode: 0o700 });
    chmodSync(markDir(), 0o700);
    const path = join(markDir(), `${HEX}.json`);
    writeFileSync(path, 'planted', { mode: 0o600 });
    await new DaemonManager(join(root, 'cm.pid'), undefined, undefined, deps()).start({ port: 3871 });
    expect(readFileSync(path, 'utf8')).toBe('planted');
  });
});
