/**
 * Issue #2473 — `scripts/lib/port-pids.sh` answers with the server, not with
 * whoever is connected to it.
 *
 * On 2026-09-11 `./scripts/stop.sh` stopped the server (61813) and one more
 * process (51331) that, going by what Chrome relaunched right after, was
 * Chrome's network service. `lsof -ti:3000` returns every process with a
 * socket whose local OR remote port is 3000, and a browser showing CommandMate
 * holds several connections whose remote port is exactly that.
 *
 * The fixture rebuilds that shape from two real processes on an OS-assigned
 * free port (never 3000, which this machine uses for the user's production
 * server): a listener, and a separate client holding a connection to it. They
 * have to be separate processes because lsof answers with PIDs; a client
 * inside the listener's own process would be indistinguishable from it.
 *
 * The mutation control is the Issue's own: drop `-sTCP:LISTEN` from the helper
 * and the client comes back in the answer.
 *
 * Skipped where lsof is absent. The helper's ss+fuser fallback is not what is
 * under test, and `fuser <port>/tcp` names the local port only anyway.
 *
 * The static side (every script goes through this helper, no recipe kills a
 * loose lookup) is tests/unit/config/port-kill-listen-only-2473.test.ts.
 *
 * @vitest-environment node
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const HELPER = path.join(REPO_ROOT, 'scripts/lib/port-pids.sh');

const HAS_LSOF = spawnSync('sh', ['-c', 'command -v lsof'], { encoding: 'utf8' }).status === 0;

/**
 * Just enough PATH for the stop scripts (bash, lsof, ps, xargs, kill, sleep),
 * and deliberately not enough for pm2: with pm2 on PATH, stop.sh runs
 * `pm2 stop commandmate`, which does not look at the port at all.
 */
const MINIMAL_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const PM2_ON_MINIMAL_PATH =
  spawnSync('sh', ['-c', 'command -v pm2'], { encoding: 'utf8', env: { NODE_ENV: 'test', PATH: MINIMAL_PATH } })
    .status === 0;

// =============================================================================
// Fixture: a listener and a separate client connected to it
// =============================================================================

/** Listens on an OS-assigned loopback port and prints it. */
const LISTENER_JS = [
  "const net = require('net');",
  "const server = net.createServer((socket) => socket.on('error', () => {}));",
  "server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));",
].join('\n');

/**
 * Connects to argv[2] and outlives the connection, so that a test can tell
 * "the client survived the stop" from "the client was killed".
 */
const CLIENT_JS = [
  "const net = require('net');",
  "const socket = net.connect(Number(process.argv[2]), '127.0.0.1', () => process.stdout.write('connected\\n'));",
  "socket.on('error', () => {});",
  'setInterval(() => {}, 1 << 30);',
].join('\n');

interface ListenerWithClient {
  port: number;
  listener: ChildProcess;
  client: ChildProcess;
  listenerPid: number;
  clientPid: number;
}

/** Every child this file started, so that nothing outlives it whatever fails. */
const spawned: ChildProcess[] = [];

function makeFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-port-pids-2473-'));
  fs.writeFileSync(path.join(dir, 'listener.js'), LISTENER_JS);
  fs.writeFileSync(path.join(dir, 'client.js'), CLIENT_JS);
  return dir;
}

function firstLine(child: ChildProcess, label: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let timer: NodeJS.Timeout | undefined;
    const onOut = (chunk: Buffer): void => {
      out += chunk.toString();
      const newline = out.indexOf('\n');
      if (newline !== -1) finish(undefined, out.slice(0, newline).trim());
    };
    const onErr = (chunk: Buffer): void => {
      err += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`${label} exited early (code=${code}, signal=${signal}): ${err.trim()}`));
    };
    function finish(error: Error | undefined, line = ''): void {
      clearTimeout(timer);
      child.stdout?.off('data', onOut);
      child.stderr?.off('data', onErr);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(line);
    }
    timer = setTimeout(() => finish(new Error(`${label}: no output within ${timeoutMs}ms: ${err.trim()}`)), timeoutMs);
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onErr);
    child.on('exit', onExit);
  });
}

function exited(child: ChildProcess, label: string, timeoutMs = 15_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} still running after ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function reapAll(): Promise<void> {
  const live = spawned.splice(0).filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of live) child.kill('SIGKILL');
  await Promise.all(live.map((child) => exited(child, `fixture pid ${child.pid}`)));
}

function start(dir: string, script: string, args: string[] = []): ChildProcess {
  const child = spawn(process.execPath, [path.join(dir, script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  return child;
}

async function startListenerWithClient(dir: string): Promise<ListenerWithClient> {
  const listener = start(dir, 'listener.js');
  const port = Number(await firstLine(listener, 'listener'));
  expect(port).toBeGreaterThan(0);
  const client = start(dir, 'client.js', [String(port)]);
  expect(await firstLine(client, 'client')).toBe('connected');
  if (listener.pid === undefined || client.pid === undefined) throw new Error('fixture has no PID');
  return { port, listener, client, listenerPid: listener.pid, clientPid: client.pid };
}

/** A port nobody listens on: bound, read back, released. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// =============================================================================
// Running the helper
// =============================================================================

function parsePids(stdout: string): number[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(Number)
    .sort((a, b) => a - b);
}

/** `source <helper> && <command>`, with the helper and the rest as positional arguments. */
function runHelper(helper: string, command: string, args: string[]) {
  const result = spawnSync('bash', ['-c', `source "$1" && shift && ${command}`, 'port-pids', helper, ...args], {
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  });
  assertSubprocessCompleted(result, `${command} ${args.join(' ')}`);
  return result;
}

function listenerPids(helper: string, port: number): number[] {
  const result = runHelper(helper, 'find_listen_pids_by_port "$1"', [String(port)]);
  expect(result.status, result.stderr).toBe(0);
  return parsePids(result.stdout);
}

/** The lookup stop.sh made before #2473: any socket whose local OR remote port is `port`. */
function portOnlyPids(port: number): number[] {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-t'], {
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  });
  assertSubprocessCompleted(result, `lsof -nP -iTCP:${port} -t`);
  return parsePids(result.stdout);
}

// =============================================================================
// The helper
// =============================================================================

describe.skipIf(!HAS_LSOF)('Issue #2473: find_listen_pids_by_port returns the listener only', () => {
  let dir: string;
  let fixture: ListenerWithClient;

  beforeAll(async () => {
    dir = makeFixtureDir();
    fixture = await startListenerWithClient(dir);
  });

  afterAll(async () => {
    await reapAll();
    removeTempDir(dir);
  });

  it('the fixture reproduces the incident: a port-only lookup returns the client too', () => {
    // Without this, a client that never really connected would make every
    // assertion below pass for the wrong reason.
    const pids = portOnlyPids(fixture.port);
    expect(pids).toContain(fixture.listenerPid);
    expect(pids).toContain(fixture.clientPid);
  });

  it('returns the listening server and not the connected client', () => {
    expect(listenerPids(HELPER, fixture.port)).toEqual([fixture.listenerPid]);
  });

  it('goes red when -sTCP:LISTEN is dropped from the helper (mutation control)', () => {
    const original = fs.readFileSync(HELPER, 'utf8');
    const mutated = original.replace(/ -sTCP:LISTEN(?= )/g, '');
    // The mutation really landed on the lookup, not on a comment.
    expect(mutated).not.toBe(original);
    expect(mutated).toContain('lsof -nP -iTCP:"$port" -t');
    const mutant = path.join(dir, 'port-pids.mutant.sh');
    fs.writeFileSync(mutant, mutated);

    const pids = listenerPids(mutant, fixture.port);
    // The assertion the real helper passes above fails for the mutant.
    expect(pids).not.toEqual([fixture.listenerPid]);
    expect(pids).toContain(fixture.clientPid);
  });

  it('prints nothing and returns 0 under set -e when nobody listens', async () => {
    // build-and-start.sh and start.sh call it from `set -e` scripts.
    const port = await freePort();
    const result = runHelper(HELPER, 'set -e; pids=$(find_listen_pids_by_port "$1"); echo "after:[$pids]"', [
      String(port),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('after:[]\n');
  });

  it('names each target by its command line, and says so when it cannot', () => {
    const gone = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
    const result = runHelper(HELPER, 'print_port_targets Stopping "$@"', [
      String(fixture.listenerPid),
      String(gone),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split('\n').filter((line) => line !== '')).toEqual([
      expect.stringMatching(new RegExp(`^Stopping ${fixture.listenerPid} \\(.*listener\\.js\\)$`)),
      `Stopping ${gone} (command unavailable)`,
    ]);
  });
});

// =============================================================================
// The stop scripts, end to end
// =============================================================================

/**
 * The acceptance check the Issue asks for on a real machine (open CommandMate
 * in the browser, run stop.sh: the server stops and Chrome's network service
 * keeps its PID), with the fixture standing in for both.
 *
 * Each script runs from a sandbox copy, so PROJECT_DIR is a temp dir with no
 * .env and no logs/server.pid: stop-server.sh's PID-file step has nothing to
 * reach, and the only port either script is given is the fixture's.
 */
describe.skipIf(!HAS_LSOF || PM2_ON_MINIMAL_PATH)(
  'Issue #2473: the stop scripts stop the listener and spare its client',
  () => {
    let sandbox: string;
    let dir: string;

    beforeAll(() => {
      sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stop-2473-'));
      fs.mkdirSync(path.join(sandbox, 'scripts', 'lib'), { recursive: true });
      for (const name of ['stop.sh', 'stop-server.sh', 'load-env.sh', 'lib/port-pids.sh']) {
        fs.copyFileSync(path.join(REPO_ROOT, 'scripts', name), path.join(sandbox, 'scripts', name));
      }
      dir = makeFixtureDir();
    });

    afterAll(async () => {
      await reapAll();
      removeTempDir(sandbox);
      removeTempDir(dir);
    });

    it.each(['stop.sh', 'stop-server.sh'])('%s', async (script) => {
      const fixture = await startListenerWithClient(dir);
      expect(portOnlyPids(fixture.port)).toContain(fixture.clientPid);

      const result = spawnSync('bash', [path.join(sandbox, 'scripts', script)], {
        cwd: sandbox,
        encoding: 'utf8',
        timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
        env: { NODE_ENV: 'test', PATH: MINIMAL_PATH, CM_PORT: String(fixture.port) },
      });
      assertSubprocessCompleted(result, `bash ${script}`);
      expect(result.status, result.stderr).toBe(0);

      // The target was named, by its command line, before it was signalled.
      expect(result.stdout).toMatch(new RegExp(`^Stopping ${fixture.listenerPid} \\(.*listener\\.js\\)$`, 'm'));
      // The client was never a target.
      expect(result.stdout).not.toMatch(new RegExp(`\\b${fixture.clientPid}\\b`));

      // The listener is gone; the client is not.
      await exited(fixture.listener, 'listener');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fixture.client.exitCode).toBeNull();
      expect(fixture.client.signalCode).toBeNull();
      expect(() => process.kill(fixture.clientPid, 0)).not.toThrow();
    });
  }
);
