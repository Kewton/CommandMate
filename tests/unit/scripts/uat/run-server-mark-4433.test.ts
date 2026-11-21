/**
 * Issue #4433 — scripts/uat/run-server.sh marks the isolated server it starts.
 *
 * The judge's isolated server (tcp/3871 in the Issue) is started by this script,
 * not by `commandmate start --daemon`, so env-clean could only excuse it if the
 * script leaves the same evidence: `CM_SERVER_MARK=<record>` passed through its
 * `env -i` line, and a record naming the server's process group (the script
 * starts the server as a group leader with `set -m`, so pgid = server pid), the
 * leader's start time (`LC_ALL=C TZ=UTC0 ps -o lstart=`), and the CALLER's
 * directory and tmux session — read before the script cds to its repo root and
 * before it hands the server a private tmux.
 *
 * The "server" is a small node script that listens on $CM_PORT, saved as
 * `<tmp>/dist/server/server.js` so the listener probe recognises it as
 * CommandMate. tmux is a private server on a socket under the temp dir. The
 * check at the end runs the real listener probe (lsof / ps on this test's own
 * processes) and expects the mark to be verified.
 *
 * Skipped where tmux or lsof is absent.
 *
 * @vitest-environment node
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  REAL_SHELL_TEST_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { parseServerMarkRecord } from '@/cli/types/server-mark';
import { attributeListener } from '@/lib/verification/env-clean-gate';
import { DEFAULT_ENV_PROBE_DEPS, probeListeners } from '@/lib/verification/env-snapshot';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RUN_SERVER = path.join(REPO_ROOT, 'scripts/uat/run-server.sh');

const has = (command: string): boolean =>
  spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
const HAS_TOOLS = has('tmux') && has('lsof');

const LISTEN_JS = `
const net = require('net');
const server = net.createServer((s) => s.end());
server.listen(Number(process.env.CM_PORT || 0), '127.0.0.1');
setInterval(() => {}, 1 << 30);
`;

const UID = process.getuid ? process.getuid() : 0;

let root: string;
/** As mkdtemp returned it: socket paths stay within macOS's 104 bytes (no `/private` prefix). */
let shortRoot: string;
let runDir: string;
let caller: string;
let markBase: string;
let callerSock: string;

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CM_RUN_LOCK_TOKEN;
  delete env.CM_SERVER_MARK;
  return {
    ...env,
    CM_RUN_LOCK_DIR: path.join(root, 'lock'),
    CM_UAT_SOCK_BASE: shortRoot,
    CM_UAT_SERVER_ENTRY: path.join(root, 'dist', 'server', 'server.js'),
    CM_SERVER_MARK_BASE: markBase,
    CODEX_HOME: path.join(root, 'codex'),
    HOME: path.join(root, 'home'),
    ...extra,
  };
}

function runScript(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync('bash', [RUN_SERVER, ...args], {
    cwd: caller,
    env: baseEnv(extra),
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  });
  assertSubprocessCompleted(result, `run-server.sh ${args[0]}`);
  return result;
}

function stateOf(dir: string): Record<string, string> {
  const file = path.join(dir, 'uat-run.state');
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** The file's content once it exists and ends a line (written by a command in a pane). */
async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + REAL_SHELL_SUBPROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.endsWith('\n')) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${file} was not written within ${REAL_SHELL_SUBPROCESS_TIMEOUT_MS} ms`);
}

function serverEnvironment(pid: number): string[] {
  return spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.split(' ');
}

/**
 * A server that listens only once `<run dir>/bind` exists and exits (without listening) once
 * `<run dir>/die` exists: the test decides when, no timing in the script under test.
 */
const CONTROLLED_JS = `
const fs = require('fs');
const net = require('net');
const path = require('path');
const dir = path.dirname(process.env.CM_DB_PATH);
const timer = setInterval(() => {
  if (fs.existsSync(path.join(dir, 'die'))) process.exit(4);
  if (fs.existsSync(path.join(dir, 'bind'))) {
    clearInterval(timer);
    net.createServer((s) => s.end()).listen(Number(process.env.CM_PORT), '127.0.0.1');
    setInterval(() => {}, 1 << 30);
  }
}, 50);
`;

interface Finished {
  status: number | null;
  stderr: string;
}

/** run-server.sh in the background (a test seam pauses it); `done` settles when it exits. */
function startScript(args: string[], extra: Record<string, string> = {}): { done: Promise<Finished>; exited: () => boolean } {
  const child = spawn('bash', [RUN_SERVER, ...args], { cwd: caller, env: baseEnv(extra), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let finished = false;
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const done = new Promise<Finished>((resolve) => {
    child.on('close', (status) => {
      finished = true;
      resolve({ status, stderr });
    });
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), REAL_SHELL_SUBPROCESS_TIMEOUT_MS);
  void done.then(() => clearTimeout(timer));
  return { done, exited: () => finished };
}

/** Resolves once `file` exists; rejects when `exited()` says the script ended first, or on the deadline. */
async function waitForPath(file: string, exited: () => boolean = () => false): Promise<void> {
  const deadline = Date.now() + REAL_SHELL_SUBPROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    if (exited()) throw new Error(`the script ended before ${file} was written`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${file} was not written within ${REAL_SHELL_SUBPROCESS_TIMEOUT_MS} ms`);
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + REAL_SHELL_SUBPROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${what} did not happen within ${REAL_SHELL_SUBPROCESS_TIMEOUT_MS} ms`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The leader start time the way the script and the probe read it. */
function lstartOf(pid: number): string {
  return spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
  })
    .stdout.replace(/\s+/g, ' ')
    .trim();
}

function markDirOf(): string {
  return path.join(markBase, `commandmate-server-marks-${UID}`);
}

/** A record in the record directory as another run would have written it. */
function writeForeignRecord(name: string, pgid: number, leaderStartTime: string): string {
  const file = path.join(markDirOf(), name);
  fs.mkdirSync(markDirOf(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      v: 1,
      launcher: 'run-server',
      pgid,
      leaderStartTime,
      launcherCwd: caller,
      worktreeRoot: null,
      repoRoot: fs.realpathSync(REPO_ROOT),
      session: 'no-tmux',
      launchedAt: '2026-11-21T00:00:00Z',
    })}\n`,
    { mode: 0o600 }
  );
  return file;
}

/** Replaces keys of the run's state file, as the script's state_set would. */
function rewriteState(dir: string, values: Record<string, string>): void {
  const merged = { ...stateOf(dir), ...values };
  fs.writeFileSync(
    path.join(dir, 'uat-run.state'),
    Object.entries(merged)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('')
  );
}

function recordOf(dir: string): string {
  return stateOf(dir).mark_path ?? '';
}

beforeEach(() => {
  shortRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm'));
  root = fs.realpathSync(shortRoot);
  runDir = path.join(root, 'run');
  caller = path.join(root, 'caller');
  markBase = path.join(root, 'marks');
  callerSock = path.join(shortRoot, 'c.sock');
  fs.mkdirSync(caller);
  fs.mkdirSync(markBase);
  fs.mkdirSync(path.join(root, 'codex'));
  fs.mkdirSync(path.join(root, 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'server', 'server.js'), LISTEN_JS);
});

afterEach(() => {
  const pid = Number(stateOf(runDir).server_pid);
  if (fs.existsSync(path.join(runDir, 'uat-run.state'))) {
    runScript(['down', '--run-dir', runDir]);
  }
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (name.startsWith('cmuat-')) {
      const sock = path.join(shortRoot, name, 'tmux.sock');
      spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' });
    }
  }
  spawnSync('tmux', ['-S', callerSock, 'kill-server'], { stdio: 'ignore' });
  removeTempDir(root);
});

describe.skipIf(!HAS_TOOLS)('run-server.sh marks its server (Issue #4433)', () => {
  it(
    'passes CM_SERVER_MARK through env -i and writes a record the listener probe verifies',
    async () => {
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30']);
      expect(up.status, up.stderr).toBe(0);
      const pid = Number(stateOf(runDir).server_pid);

      const markDir = path.join(markBase, `commandmate-server-marks-${UID}`);
      const marks = serverEnvironment(pid).filter((token) => token.startsWith('CM_SERVER_MARK='));
      expect(marks).toHaveLength(1);
      const recordPath = marks[0].slice('CM_SERVER_MARK='.length);
      expect(path.dirname(recordPath)).toBe(markDir);
      expect(fs.statSync(markDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(recordPath).mode & 0o777).toBe(0o600);

      const record = parseServerMarkRecord(fs.readFileSync(recordPath, 'utf8'));
      expect(record).not.toBeNull();
      expect(record).toMatchObject({
        v: 1,
        launcher: 'run-server',
        pgid: pid,
        // The caller's directory, read before the script's `cd "$REPO_ROOT"`.
        launcherCwd: caller,
        worktreeRoot: null,
        repoRoot: fs.realpathSync(REPO_ROOT),
        session: 'no-tmux',
      });

      const probe = await probeListeners(DEFAULT_ENV_PROBE_DEPS);
      const entry = probe.entries.find((candidate) => candidate.key === `tcp/${port}`);
      expect(entry?.marks).toHaveLength(1);
      expect(entry?.marks?.[0]).toMatchObject({ pid, pgid: pid, status: 'verified' });

      // `down` removes the record once the server is stopped.
      const down = runScript(['down', '--run-dir', runDir]);
      expect(down.status, down.stderr).toBe(0);
      expect(fs.existsSync(recordPath)).toBe(false);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'records the caller’s tmux session, not the private one it gives the server',
    async () => {
      // Run from inside the pane (the pane's shell is an ancestor of the script), as a worker does.
      const port = await freePort();
      const out = path.join(root, 'up.out');
      const status = path.join(root, 'up.status');
      const command =
        `bash '${RUN_SERVER}' up --port ${port} --run-dir '${runDir}' --wait-listen 30 >'${out}' 2>&1; ` +
        `echo $? >'${status}'; sleep 600`;
      const created = spawnSync(
        'tmux',
        ['-S', callerSock, 'new-session', '-d', '-s', 'mcbd-claude-commandmate-judge', '-c', caller, command],
        { env: baseEnv() }
      );
      expect(created.status).toBe(0);
      const code = await waitForFile(status);
      expect(code.trim(), fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '').toBe('0');
      const pid = Number(stateOf(runDir).server_pid);
      const recordPath = serverEnvironment(pid)
        .find((token) => token.startsWith('CM_SERVER_MARK='))!
        .slice('CM_SERVER_MARK='.length);
      expect(parseServerMarkRecord(fs.readFileSync(recordPath, 'utf8'))?.session).toBe('mcbd-claude-commandmate-judge');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'records lookup-failed when TMUX_PANE names a pane the caller is not running in (an inherited environment)',
    async () => {
      const created = spawnSync('tmux', ['-S', callerSock, 'new-session', '-d', '-s', 'mcbd-claude-commandmate-judge', 'sleep 600']);
      expect(created.status).toBe(0);
      const pane = spawnSync('tmux', ['-S', callerSock, 'display-message', '-p', '-t', 'mcbd-claude-commandmate-judge', '#{pane_id}'], {
        encoding: 'utf8',
      }).stdout.trim();
      const tmuxPid = spawnSync('tmux', ['-S', callerSock, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }).stdout.trim();

      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30'], {
        TMUX: `${callerSock},${tmuxPid},0`,
        TMUX_PANE: pane,
      });
      expect(up.status, up.stderr).toBe(0);
      const pid = Number(stateOf(runDir).server_pid);
      const recordPath = serverEnvironment(pid)
        .find((token) => token.startsWith('CM_SERVER_MARK='))!
        .slice('CM_SERVER_MARK='.length);
      expect(parseServerMarkRecord(fs.readFileSync(recordPath, 'utf8'))?.session).toBe('lookup-failed');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'leaves no record when up fails (the record is written only once the server is up)',
    async () => {
      // The server execs and exits at once.
      fs.writeFileSync(path.join(root, 'dist', 'server', 'server.js'), 'process.exit(3);\n');
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30']);
      expect(up.status).not.toBe(0);
      expect(up.stderr).toContain('exited');
      expect(fs.readdirSync(path.join(markBase, `commandmate-server-marks-${UID}`))).toEqual([]);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'records lookup-failed when the caller’s tmux cannot be asked',
    async () => {
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30'], {
        TMUX: `${path.join(root, 'no-such.sock')},1,0`,
        TMUX_PANE: '%9',
      });
      expect(up.status, up.stderr).toBe(0);
      const pid = Number(stateOf(runDir).server_pid);
      const recordPath = serverEnvironment(pid)
        .find((token) => token.startsWith('CM_SERVER_MARK='))!
        .slice('CM_SERVER_MARK='.length);
      expect(parseServerMarkRecord(fs.readFileSync(recordPath, 'utf8'))?.session).toBe('lookup-failed');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'starts the server unmarked when the record directory is not private',
    async () => {
      const markDir = path.join(markBase, `commandmate-server-marks-${UID}`);
      fs.mkdirSync(markDir);
      fs.chmodSync(markDir, 0o755);
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30'], {
        CM_SERVER_MARK: '/tmp/commandmate-server-marks-0/inherited.json',
      });
      expect(up.status, up.stderr).toBe(0);
      const pid = Number(stateOf(runDir).server_pid);
      expect(serverEnvironment(pid).some((token) => token.startsWith('CM_SERVER_MARK='))).toBe(false);
      expect(fs.readdirSync(markDir)).toEqual([]);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );
});

/**
 * The record's lifetime (codex review s9): when it is published, and that only this run's record is
 * ever removed. The pauses and the fault are the existing test seams (CM_VERIFY_TEST_HANDOFF with
 * CM_VERIFY_TEST_HANDOFF_DIR, lock_test_pause / lock_test_fault); the server is stopped by the test,
 * never by a new line in the script.
 */
describe.skipIf(!HAS_TOOLS)('run-server.sh publishes and removes only its own record (Issue #4433)', () => {
  let seams: string;

  beforeEach(() => {
    seams = path.join(root, 'seams');
    fs.mkdirSync(seams);
    fs.writeFileSync(path.join(root, 'dist', 'server', 'server.js'), CONTROLLED_JS);
  });

  it(
    'without --wait-listen, publishes the record once the server runs, before it listens (slow bind)',
    async () => {
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir]);
      expect(up.status, up.stderr).toBe(0);
      const pid = Number(stateOf(runDir).server_pid);
      const recordPath = recordOf(runDir);
      expect(recordPath).not.toBe('');
      expect(parseServerMarkRecord(fs.readFileSync(recordPath, 'utf8'))).toMatchObject({ pgid: pid, leaderStartTime: lstartOf(pid) });
      expect(stateOf(runDir).mark_lstart).toBe(lstartOf(pid));

      fs.writeFileSync(path.join(runDir, 'bind'), '');
      let marks: unknown[] | undefined;
      const deadline = Date.now() + REAL_SHELL_SUBPROCESS_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const probe = await probeListeners(DEFAULT_ENV_PROBE_DEPS);
        marks = probe.entries.find((candidate) => candidate.key === `tcp/${port}`)?.marks;
        if (marks) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(marks?.[0]).toMatchObject({ pid, status: 'verified' });

      const down = runScript(['down', '--run-dir', runDir]);
      expect(down.status, down.stderr).toBe(0);
      expect(fs.existsSync(recordPath)).toBe(false);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'without --wait-listen, a server that ends before it listens leaves up successful and its record for down to remove',
    async () => {
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir]);
      expect(up.status, up.stderr).toBe(0);
      const pid = Number(stateOf(runDir).server_pid);
      const recordPath = recordOf(runDir);
      expect(fs.existsSync(recordPath)).toBe(true);

      fs.writeFileSync(path.join(runDir, 'die'), '');
      await waitUntil(() => !isAlive(pid), 'the server exit');
      // The record names a group that is gone: never an exemption (leader-gone), and down removes it.
      const down = runScript(['down', '--run-dir', runDir]);
      expect(down.status, down.stderr).toBe(0);
      expect(fs.existsSync(recordPath)).toBe(false);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'mark_remove removes a record only when its pgid and leader start time are the run’s (R1)',
    () => {
      const remove = (record: string, pid: string, lstart: string) =>
        spawnSync('bash', ['-c', '. "$1"; mark_remove "$2" "$3" "$4"', 'mark-remove', RUN_SERVER, record, pid, lstart], {
          env: baseEnv(),
          encoding: 'utf8',
        });
      const start = 'Sat Nov 21 01:02:03 2026';
      const otherGroup = writeForeignRecord(`${'a'.repeat(32)}.json`, 4242, start);
      const otherStart = writeForeignRecord(`${'b'.repeat(32)}.json`, 4343, 'Sat Nov 21 09:09:09 2026');
      const malformed = path.join(markDirOf(), `${'c'.repeat(32)}.json`);
      fs.writeFileSync(malformed, '{"v":1,"pgid":4444', { mode: 0o600 });
      const ours = writeForeignRecord(`${'d'.repeat(32)}.json`, 4545, start);

      remove(otherGroup, '9999', start);
      remove(otherStart, '4343', start);
      remove(malformed, '4444', start);
      remove(ours, '4545', '');
      expect(fs.existsSync(otherGroup)).toBe(true);
      expect(fs.existsSync(otherStart)).toBe(true);
      expect(fs.existsSync(malformed)).toBe(true);
      expect(fs.existsSync(ours)).toBe(true);

      remove(ours, '4545', start);
      expect(fs.existsSync(ours)).toBe(false);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'down leaves a record the state points to when its pgid or start time is not the run’s server’s (R1)',
    async () => {
      fs.writeFileSync(path.join(root, 'dist', 'server', 'server.js'), LISTEN_JS);
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30']);
      expect(up.status, up.stderr).toBe(0);
      const pid = Number(stateOf(runDir).server_pid);
      const own = recordOf(runDir);
      const foreign = writeForeignRecord(`${'e'.repeat(32)}.json`, pid + 1, lstartOf(pid));
      rewriteState(runDir, { mark_path: foreign });

      const down = runScript(['down', '--run-dir', runDir]);
      expect(down.status, down.stderr).toBe(0);
      expect(fs.existsSync(foreign)).toBe(true);
      fs.rmSync(own, { force: true });
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'down judges the record by the server it stopped, not by a state the next up rewrote meanwhile (R1)',
    async () => {
      fs.writeFileSync(path.join(root, 'dist', 'server', 'server.js'), LISTEN_JS);
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30']);
      expect(up.status, up.stderr).toBe(0);
      const own = recordOf(runDir);

      const down = startScript(['down', '--run-dir', runDir], {
        CM_VERIFY_TEST_HANDOFF: 'pause:mark-remove',
        CM_VERIFY_TEST_HANDOFF_DIR: seams,
      });
      await waitForPath(path.join(seams, 'mark-remove.reached'), down.exited);
      // A new run on the same run dir: its server (a sleep stands in) and its record.
      const stand = spawn('sleep', ['600'], { stdio: 'ignore' });
      const standPid = stand.pid!;
      try {
        const next = writeForeignRecord(`${'f'.repeat(32)}.json`, standPid, lstartOf(standPid));
        rewriteState(runDir, { server_pid: String(standPid), mark_path: next, mark_lstart: lstartOf(standPid) });
        fs.writeFileSync(path.join(seams, 'mark-remove.go'), '');
        const finished = await down.done;
        expect(finished.status, finished.stderr).toBe(0);
        expect(fs.existsSync(next)).toBe(true);
      } finally {
        stand.kill('SIGKILL');
        // The state names the stand-in now: afterEach must not stop by it. down stopped this run's server.
        fs.rmSync(path.join(runDir, 'uat-run.state'), { force: true });
        fs.rmSync(own, { force: true });
      }
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'up removes its record and fails when the server is gone once the record is written (R2)',
    async () => {
      const port = await freePort();
      const up = startScript(['up', '--port', String(port), '--run-dir', runDir], {
        CM_VERIFY_TEST_HANDOFF: 'pause:mark-written',
        CM_VERIFY_TEST_HANDOFF_DIR: seams,
      });
      await waitForPath(path.join(seams, 'mark-written.reached'), up.exited);
      const pid = Number(stateOf(runDir).server_pid);
      expect(fs.readdirSync(markDirOf())).toHaveLength(1);
      // What a `down` overtaking the publish leaves: the server stopped.
      process.kill(pid, 'SIGKILL');
      fs.writeFileSync(path.join(seams, 'mark-written.go'), '');
      const finished = await up.done;
      expect(finished.status).not.toBe(0);
      expect(stateOf(runDir).status).not.toBe('up');
      expect(fs.readdirSync(markDirOf())).toEqual([]);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'up removes its record when the state cannot hold its path (R2)',
    async () => {
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir], { CM_VERIFY_TEST_HANDOFF: 'fault:mark-state' });
      expect(up.status, up.stderr).toBe(0);
      expect(stateOf(runDir).mark_path).toBeUndefined();
      expect(fs.readdirSync(markDirOf())).toEqual([]);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'with --wait-listen, a listener is judged before its record is published and excused after, only as another worktree’s (R4)',
    async () => {
      fs.writeFileSync(path.join(root, 'dist', 'server', 'server.js'), LISTEN_JS);
      expect(spawnSync('git', ['init', '-q', caller]).status).toBe(0);
      const self = path.join(root, 'self');
      fs.mkdirSync(self);
      const port = await freePort();
      const out = path.join(root, 'up.out');
      const status = path.join(root, 'up.status');
      const command =
        `CM_VERIFY_TEST_HANDOFF=pause:mark-publish CM_VERIFY_TEST_HANDOFF_DIR='${seams}' ` +
        `bash '${RUN_SERVER}' up --port ${port} --run-dir '${runDir}' --wait-listen 30 >'${out}' 2>&1; ` +
        `echo $? >'${status}'; sleep 600`;
      const created = spawnSync(
        'tmux',
        ['-S', callerSock, 'new-session', '-d', '-s', 'mcbd-claude-commandmate-judge', '-c', caller, command],
        { env: baseEnv() }
      );
      expect(created.status).toBe(0);
      await waitForPath(path.join(seams, 'mark-publish.reached'), () => fs.existsSync(status));
      const pid = Number(stateOf(runDir).server_pid);
      const context = { worktreeId: 'mytask', worktreePath: self };

      const before = (await probeListeners(DEFAULT_ENV_PROBE_DEPS)).entries.find((entry) => entry.key === `tcp/${port}`);
      expect(before?.marks?.[0]).toMatchObject({ pid, status: 'invalid', reason: 'record-unreadable' });
      expect(attributeListener(before!, context)).toBe('unattributed');

      fs.writeFileSync(path.join(seams, 'mark-publish.go'), '');
      const code = await waitForFile(status);
      expect(code.trim(), fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '').toBe('0');
      const after = (await probeListeners(DEFAULT_ENV_PROBE_DEPS)).entries.find((entry) => entry.key === `tcp/${port}`);
      expect(after?.marks?.[0]).toMatchObject({ pid, status: 'verified', session: 'mcbd-claude-commandmate-judge' });
      expect(attributeListener(after!, context)).toBe('other');
      // The same verified record is this worktree's when the caller's directory is the task's.
      expect(attributeListener(after!, { worktreeId: 'mytask', worktreePath: caller })).toBe('self');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'the seams do nothing without their variables (the production path)',
    async () => {
      fs.writeFileSync(path.join(root, 'dist', 'server', 'server.js'), LISTEN_JS);
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30'], {
        CM_VERIFY_TEST_HANDOFF_DIR: seams,
      });
      expect(up.status, up.stderr).toBe(0);
      const recordPath = recordOf(runDir);
      expect(fs.existsSync(recordPath)).toBe(true);
      const down = runScript(['down', '--run-dir', runDir], { CM_VERIFY_TEST_HANDOFF_DIR: seams });
      expect(down.status, down.stderr).toBe(0);
      expect(fs.existsSync(recordPath)).toBe(false);
      expect(fs.readdirSync(seams)).toEqual([]);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );
});
