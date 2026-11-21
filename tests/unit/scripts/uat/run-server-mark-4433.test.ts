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
import { spawnSync } from 'node:child_process';
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
