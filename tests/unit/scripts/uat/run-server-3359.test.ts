/**
 * Issue #3359 — scripts/uat/run-server.sh starts and stops only its own
 * server, and scripts/uat/run-lock.sh lets one run in at a time.
 *
 * The old `.commandmate/uat.yaml` `down` stopped whatever LISTENED on the port,
 * and named its tmux socket by the port alone. A second UAT, or any other
 * owner of the port, could be stopped by it. These tests stand up the shapes
 * that made that possible, without a model and without the real server:
 *
 *   - the "server" is a small node script that listens on $CM_PORT
 *     (CM_UAT_SERVER_ENTRY), started through the script's own `env -i` line,
 *     so its environment is what the real server would see;
 *   - the "other owner" is a separate node process listening on the same port
 *     with a CM_DB_PATH outside the run;
 *   - tmux is a real, private server on a socket under this test's temp dir
 *     (CM_UAT_SOCK_BASE), never the user's;
 *   - the lock directory is moved under the temp dir (CM_RUN_LOCK_DIR).
 *
 * Positive control: the port-only recipe the old `down` used really does stop
 * the other owner in this fixture, so "it survived" below means something.
 *
 * Skipped where tmux or lsof is absent (`ps eww` must show a node process's
 * environment, which macOS and Linux both do for the caller's own processes).
 *
 * @vitest-environment node
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RUN_SERVER = path.join(REPO_ROOT, 'scripts/uat/run-server.sh');
const RUN_LOCK = path.join(REPO_ROOT, 'scripts/uat/run-lock.sh');

const has = (command: string): boolean =>
  spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
const HAS_TOOLS = has('tmux') && has('lsof');

const LISTEN_JS = `
const net = require('net');
const port = Number(process.env.CM_PORT || 0);
const server = net.createServer((s) => s.end());
server.listen(port, '127.0.0.1', () => {
  if (process.env.PRINT_PORT) process.stdout.write(String(server.address().port) + '\\n');
});
setInterval(() => {}, 1 << 30);
`;
const EXIT_JS = `process.exit(1);\n`;

let root: string;
let runDir: string;
let lockDir: string;
let listenJs: string;
let exitJs: string;
const children: ChildProcess[] = [];

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The script must reach only its private tmux server, never the caller's.
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CM_RUN_LOCK_TOKEN;
  return {
    ...env,
    CM_RUN_LOCK_DIR: lockDir,
    CM_UAT_SOCK_BASE: root,
    CM_UAT_SERVER_ENTRY: listenJs,
    CODEX_HOME: path.join(root, 'codex'),
    ...extra,
  };
}

function runScript(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync('bash', [RUN_SERVER, ...args], {
    cwd: REPO_ROOT,
    env: baseEnv(extra),
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  });
  assertSubprocessCompleted(result, `run-server.sh ${args[0]}`);
  return result;
}

function bash(script: string, extra: Record<string, string> = {}) {
  const result = spawnSync('bash', ['-c', script], {
    env: baseEnv(extra),
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  });
  assertSubprocessCompleted(result, 'bash');
  return result;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function socketDirs(): string[] {
  return fs.readdirSync(root).filter((name) => name.startsWith('cmuat-'));
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

/** Another owner of a port: a separate process whose DB is not the run's. */
async function startOtherOwner(port = 0): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, [listenJs], {
    env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', CM_PORT: String(port), PRINT_PORT: '1', CM_DB_PATH: '/elsewhere/cm.db' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.push(child);
  const bound = await new Promise<number>((resolve, reject) => {
    child.once('exit', () => reject(new Error('the other owner exited')));
    child.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
  });
  return { child, port: bound };
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

function listens(port: number, pid: number): boolean {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return result.stdout.split('\n').includes(String(pid));
}

beforeEach(() => {
  // Short: the socket path under it must stay within macOS's 104 bytes.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'u'));
  runDir = path.join(root, 'run');
  lockDir = path.join(root, 'lock');
  listenJs = path.join(root, 'listen.js');
  exitJs = path.join(root, 'exit.js');
  fs.writeFileSync(listenJs, LISTEN_JS);
  fs.writeFileSync(exitJs, EXIT_JS);
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of fs.existsSync(root) ? socketDirs() : []) {
    const sock = path.join(root, dir, 'tmux.sock');
    spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' });
  }
  for (const dir of [runDir, path.join(root, 'run2')]) {
    const pid = Number(stateOf(dir).server_pid);
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
  }
  removeTempDir(root);
});

describe.skipIf(!HAS_TOOLS)('run-server.sh (Issue #3359)', () => {
  it(
    'up records the pid and its CM_DB_PATH under the run, and down stops it, its tmux server and the lock (negative control)',
    async () => {
      const port = await freePort();
      const up = runScript(['up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30']);
      expect(up.status, up.stderr).toBe(0);

      const state = stateOf(runDir);
      const pid = Number(state.server_pid);
      expect(alive(pid)).toBe(true);
      expect(state.db_path).toBe(`${runDir}/uat.db`);
      expect(state.status).toBe('up');
      expect(state.sock_dir).toMatch(new RegExp(`/cmuat-${port}-\\d{12}-[0-9a-f]{4}$`));
      expect(fs.existsSync(path.join(state.sock_dir, 'tmux.sock'))).toBe(true);
      // The lock outlives the `up` shell: its owner is the server.
      expect(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')).toContain(`pid=${pid}\n`);
      expect(await waitFor(() => listens(port, pid))).toBe(true);

      const down = runScript(['down', '--run-dir', runDir]);
      expect(down.status, down.stderr).toBe(0);
      expect(await waitFor(() => !alive(pid))).toBe(true);
      expect(fs.existsSync(state.sock_dir)).toBe(false);
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(stateOf(runDir).status).toBe('stopped');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'positive control: the old port-only stop kills the other owner in this fixture',
    async () => {
      const other = await startOtherOwner();
      const result = bash(`P=$(lsof -nP -iTCP:${other.port} -sTCP:LISTEN -t); [ -z "$P" ] || kill $P`);
      expect(result.status).toBe(0);
      expect(await waitFor(() => !alive(other.child.pid!))).toBe(true);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'down does not stop another owner listening on the port after our server died',
    async () => {
      const port = await freePort();
      expect(runScript(['up', '--port', String(port), '--run-dir', runDir]).status).toBe(0);
      const ours = Number(stateOf(runDir).server_pid);
      expect(await waitFor(() => listens(port, ours))).toBe(true);
      process.kill(ours, 'SIGKILL');
      expect(await waitFor(() => !alive(ours))).toBe(true);
      const other = await startOtherOwner(port);

      const down = runScript(['down', '--run-dir', runDir]);

      expect(down.status, down.stderr).toBe(0);
      expect(alive(other.child.pid!)).toBe(true);
      expect(listens(port, other.child.pid!)).toBe(true);
      expect(socketDirs()).toEqual([]);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'down refuses, and stops nothing, when the recorded pid is a process whose CM_DB_PATH is not under the run',
    async () => {
      const port = await freePort();
      expect(runScript(['up', '--port', String(port), '--run-dir', runDir]).status).toBe(0);
      const ours = Number(stateOf(runDir).server_pid);
      process.kill(ours, 'SIGKILL');
      expect(await waitFor(() => !alive(ours))).toBe(true);
      const other = await startOtherOwner(port);
      // As if the recorded pid had been reused by the other owner.
      const file = path.join(runDir, 'uat-run.state');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^server_pid=.*$/m, `server_pid=${other.child.pid}`));

      const down = runScript(['down', '--run-dir', runDir]);

      expect(down.status).toBe(1);
      expect(down.stderr).toContain('not stopping it');
      expect(alive(other.child.pid!)).toBe(true);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'down without a state file stops nothing by port and fails',
    async () => {
      const other = await startOtherOwner();
      fs.mkdirSync(runDir, { recursive: true });

      const down = runScript(['down', '--run-dir', runDir]);

      expect(down.status).toBe(1);
      expect(alive(other.child.pid!)).toBe(true);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'an up that fails midway (the server exits at once) removes only its own resources',
    async () => {
      const port = await freePort();

      const up = runScript(['up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30'], {
        CM_UAT_SERVER_ENTRY: exitJs,
      });

      expect(up.status).not.toBe(0);
      expect(up.stderr).toContain('up failed');
      expect(socketDirs()).toEqual([]);
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(stateOf(runDir).status).toBe('failed');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'an up that fails midway removes only its own tmux server, socket dir and lock, and leaves the other owner running',
    async () => {
      const other = await startOtherOwner();

      // Our server cannot bind the port the other owner holds and exits.
      const up = runScript(['up', '--port', String(other.port), '--run-dir', runDir, '--wait-listen', '30']);

      expect(up.status).not.toBe(0);
      expect(up.stderr).toContain('up failed');
      expect(alive(other.child.pid!)).toBe(true);
      expect(listens(other.port, other.child.pid!)).toBe(true);
      expect(socketDirs()).toEqual([]);
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(stateOf(runDir).status).toBe('failed');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'up refuses to start anything while another live run holds the lock',
    async () => {
      const port = await freePort();
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${process.pid}\nstarted_at=x\nlabel=daily\ntoken=held\n`);

      const up = runScript(['up', '--port', String(port), '--run-dir', runDir]);

      expect(up.status).toBe(1);
      expect(up.stderr).toContain('another run holds');
      expect(socketDirs()).toEqual([]);
      expect(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')).toContain('token=held');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'the next up cleans what a killed run left: its server (verified) and its socket dir',
    async () => {
      const port = await freePort();
      expect(runScript(['up', '--port', String(port), '--run-dir', runDir]).status).toBe(0);
      const first = stateOf(runDir);
      const firstPid = Number(first.server_pid);
      expect(await waitFor(() => listens(port, firstPid))).toBe(true);
      // The driver was killed and its lock went stale (its owner is dead),
      // while the server and the private tmux server are still there.
      const dead = spawnSync(process.execPath, ['-e', '']).pid!;
      const owner = path.join(lockDir, 'owner');
      fs.writeFileSync(owner, fs.readFileSync(owner, 'utf8').replace(/^pid=.*$/m, `pid=${dead}`));

      const run2 = path.join(root, 'run2');
      const second = runScript(['up', '--port', String(port), '--run-dir', run2]);

      expect(second.status, second.stderr).toBe(0);
      expect(alive(firstPid)).toBe(false);
      expect(fs.existsSync(first.sock_dir)).toBe(false);
      expect(stateOf(runDir).status).toBe('cleaned');
      expect(runScript(['down', '--run-dir', run2]).status).toBe(0);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it('keeps the default socket path within the macOS 104-byte limit', () => {
    // /tmp/cmuat-<port>-<UTC yymmddHHMMSS>-<4 hex>/tmux.sock, widest port.
    const widest = `/tmp/cmuat-65535-261005123456-abcd/tmux.sock`;
    expect(Buffer.byteLength(widest)).toBeLessThanOrEqual(103);
  });
});

describe('run-lock.sh (Issue #3359)', () => {
  function acquireScript(token: string, hold = '0'): string {
    return `. '${RUN_LOCK}'; if run_lock_acquire test $$ '${token}'; then echo GOT; sleep ${hold}; else echo "$RUN_LOCK_ERROR"; fi`;
  }

  it(
    'is never held by two callers at once',
    async () => {
      const racers = Array.from({ length: 8 }, (_, i) =>
        new Promise<string>((resolve) => {
          const child = spawn('bash', ['-c', acquireScript(`racer-${i}`, '2')], {
            env: baseEnv(),
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          let out = '';
          child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString()));
          child.on('exit', () => resolve(out.trim()));
        })
      );
      const outcomes = await Promise.all(racers);
      expect(outcomes.filter((line) => line === 'GOT')).toHaveLength(1);
      expect(outcomes.filter((line) => line.startsWith('another run holds'))).toHaveLength(7);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it('takes over a lock whose owner is dead, and not one whose owner is alive', () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${dead}\nstarted_at=x\nlabel=uat\ntoken=old\n`);
    const takeover = bash(acquireScript('new'));
    expect(takeover.stdout.trim()).toBe('GOT');
    expect(takeover.stderr).toContain('took over a stale lock');
    expect(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')).toContain('token=new');

    fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${process.pid}\nstarted_at=x\nlabel=uat\ntoken=live\n`);
    const refused = bash(acquireScript('newer'));
    expect(refused.stdout).toContain(`another run holds ${lockDir} (pid ${process.pid}, label uat`);
    expect(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')).toContain('token=live');
  });

  it('lets a child of the holder in through CM_RUN_LOCK_TOKEN, and release touches only its own token', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${process.pid}\nstarted_at=x\nlabel=daily\ntoken=parent\n`);
    expect(bash(acquireScript('child'), { CM_RUN_LOCK_TOKEN: 'parent' }).stdout.trim()).toBe('GOT');
    bash(`. '${RUN_LOCK}'; run_lock_release child`);
    expect(fs.existsSync(lockDir)).toBe(true);
    bash(`. '${RUN_LOCK}'; run_lock_release parent`);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('defaults to <TMPDIR>/commandmate-run.lock, the same place run-lock.ts uses', () => {
    const result = spawnSync('bash', ['-c', `. '${RUN_LOCK}'; run_lock_dir`], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', TMPDIR: `${root}/` },
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    });
    expect(result.stdout.trim()).toBe(path.join(root, 'commandmate-run.lock'));
  });
});
