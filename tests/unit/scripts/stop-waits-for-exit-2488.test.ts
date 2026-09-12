/**
 * Issue #2488 — a stop returns when the PROCESS is gone, not when the port
 * goes quiet.
 *
 * ## The incident
 *
 * On 2026-09-11 `/rebuild` ran `./scripts/stop.sh && ./scripts/build-and-start.sh
 * --daemon`. stop.sh printed `✓ Application stopped`; build-and-start.sh then
 * printed `Server is already running (PID: 93368)` and exited 1 BEFORE building.
 * `.next/BUILD_ID` was unchanged, nothing listened on port 3000, and the
 * production server was down for three minutes.
 *
 * Both halves read the same window wrong. `server.ts`'s gracefulShutdown closes
 * the listening socket first and only then waits — up to 3 seconds — for the
 * connections that are still open, and a browser tab on the dashboard holds
 * keep-alive sockets that nothing closes. So for those 3 seconds there is no
 * LISTENER on the port and the server process is alive, still named by
 * `logs/server.pid`. stop.sh judged "stopped" from the absent listener (SIGTERM,
 * `sleep 2`, look the port up again); build-and-start.sh judged "running" from
 * the live PID and refused at once.
 *
 * ## What the fixture is
 *
 * `slow-exit.js` is that server reduced to its timing: on SIGTERM it closes its
 * listening socket immediately and exits `shutdownMs` later. The first test
 * proves the fixture really has the incident's shape — listener gone, process
 * alive — because every assertion below would otherwise pass for the wrong
 * reason.
 *
 * ## Why the fixtures are orphaned instead of spawned as children
 *
 * "The process is gone" is asserted with `kill -0`, and a dead CHILD of this
 * process answers `kill -0` successfully until node reaps it — which cannot
 * happen while `spawnSync` is blocking the event loop. So the processes whose
 * DEATH is asserted are launched through `launch.sh` (`nohup … &`, the same
 * shape as `nohup npm start`) and are nobody's child here; the client, whose
 * SURVIVAL is asserted, stays a child, because `ChildProcess.exitCode` is the
 * authoritative answer for that direction.
 *
 * Skipped where lsof is absent, and where pm2 is on the minimal PATH (stop.sh
 * hands over to `pm2 stop` and never looks at the port).
 *
 * The #2473 rule this must not break — a process merely CONNECTED to the port
 * is never signalled — is asserted here too, and at length in
 * tests/unit/scripts/port-pids-listen-only-2473.test.ts.
 *
 * @vitest-environment node
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const HAS_LSOF = spawnSync('sh', ['-c', 'command -v lsof'], { encoding: 'utf8' }).status === 0;

/**
 * Just enough PATH for the scripts (bash, lsof, ps, xargs, kill, sleep), and
 * deliberately not enough for pm2: with pm2 on PATH stop.sh runs
 * `pm2 stop commandmate` and never looks at the port at all.
 */
const MINIMAL_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const PM2_ON_MINIMAL_PATH =
  spawnSync('sh', ['-c', 'command -v pm2'], {
    encoding: 'utf8',
    env: { NODE_ENV: 'test', PATH: MINIMAL_PATH },
  }).status === 0;

const SKIP = !HAS_LSOF || PM2_ON_MINIMAL_PATH;

/** How long the fixture stays alive after SIGTERM — server.ts's own force-exit. */
const SHUTDOWN_MS = 3000;

// =============================================================================
// Fixtures
// =============================================================================

/**
 * `slow-exit.js <shutdownMs> <listen|nolisten> [selfExitMs]`
 *
 * server.ts's shutdown timing with nothing else in it. `shutdownMs < 0` is a
 * process that ignores SIGTERM outright — the case the SIGKILL fallback is for.
 * `selfExitMs` makes it exit on its own, with no signal at all, which is how a
 * predecessor that is already on its way out is staged for the start scripts.
 */
const SLOW_EXIT_JS = [
  "const net = require('net');",
  'const shutdownMs = Number(process.argv[2]);',
  "const listening = process.argv[3] === 'listen';",
  'const selfExitMs = Number(process.argv[4] ?? 0);',
  'let server = null;',
  'if (listening) {',
  "  server = net.createServer((socket) => socket.on('error', () => {}));",
  "  server.listen(0, '127.0.0.1', () => process.stdout.write('port ' + server.address().port + '\\n'));",
  '} else {',
  "  process.stdout.write('ready\\n');",
  '}',
  "process.on('SIGTERM', () => {",
  '  if (shutdownMs < 0) return;',
  '  // Exactly server.ts: the listening socket goes first, the process later.',
  '  if (server) server.close();',
  '  setTimeout(() => process.exit(0), shutdownMs);',
  '});',
  'if (selfExitMs > 0) setTimeout(() => process.exit(0), selfExitMs);',
  'setInterval(() => {}, 1 << 30);',
].join('\n');

/** Connects to argv[2] and outlives the connection, so a kill of it is visible. */
const CLIENT_JS = [
  "const net = require('net');",
  "const socket = net.connect(Number(process.argv[2]), '127.0.0.1', () => process.stdout.write('connected\\n'));",
  "socket.on('error', () => {});",
  'setInterval(() => {}, 1 << 30);',
].join('\n');

/** `launch.sh <outFile> <command...>` -> the PID of an orphan, on stdout. */
const LAUNCH_SH = ['#!/bin/bash', 'out=$1', 'shift', 'nohup "$@" > "$out" 2>&1 &', 'echo $!', ''].join('\n');

/** A stand-in for `npm start` that just stays up until it is killed. */
const NPM_STUB = ['#!/bin/sh', 'exec sleep 120', ''].join('\n');

let fixtureDir: string;
let launched = 0;

/** Orphans this file started, by PID; killed outright in afterAll. */
const orphanPids: number[] = [];
/** Children this file started; killed outright in afterAll. */
const children: ChildProcess[] = [];

function makeFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stop-2488-'));
  fs.writeFileSync(path.join(dir, 'slow-exit.js'), SLOW_EXIT_JS);
  fs.writeFileSync(path.join(dir, 'client.js'), CLIENT_JS);
  fs.writeFileSync(path.join(dir, 'launch.sh'), LAUNCH_SH, { mode: 0o755 });
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts `slow-exit.js` detached, and returns its PID plus its output file. */
function launchOrphan(args: string[]): { pid: number; out: string } {
  launched += 1;
  const out = path.join(fixtureDir, `orphan-${launched}.out`);
  fs.writeFileSync(out, '');
  const result = spawnSync(
    'bash',
    [path.join(fixtureDir, 'launch.sh'), out, process.execPath, path.join(fixtureDir, 'slow-exit.js'), ...args],
    { encoding: 'utf8', timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS }
  );
  assertSubprocessCompleted(result, 'launch.sh');
  const pid = Number(result.stdout.trim());
  expect(Number.isInteger(pid) && pid > 0, `launch.sh printed "${result.stdout}"`).toBe(true);
  orphanPids.push(pid);
  return { pid, out };
}

/** Waits for `launch.sh`'s child to announce itself, and returns that first line. */
async function firstLineOf(file: string, label: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = fs.readFileSync(file, 'utf8');
    const newline = text.indexOf('\n');
    if (newline !== -1) return text.slice(0, newline).trim();
    if (Date.now() > deadline) throw new Error(`${label}: no output within ${timeoutMs}ms: ${text}`);
    await sleep(50);
  }
}

/** A listening orphan that exits `shutdownMs` after SIGTERM. */
async function startSlowListener(shutdownMs = SHUTDOWN_MS): Promise<{ pid: number; port: number }> {
  const { pid, out } = launchOrphan([String(shutdownMs), 'listen']);
  const line = await firstLineOf(out, 'slow listener');
  const port = Number(line.replace(/^port /, ''));
  expect(port).toBeGreaterThan(0);
  return { pid, port };
}

/** A child process holding a connection to `port` — the browser tab of #2473. */
async function startClient(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [path.join(fixtureDir, 'client.js'), String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client did not connect within 15s')), 15_000);
    child.stdout?.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('client exited before connecting'));
    });
  });
  return child;
}

function listenPidsOn(port: number): number[] {
  const result = spawnSync(
    'bash',
    ['-c', 'source "$1" && find_listen_pids_by_port "$2"', 'port-pids', path.join(REPO_ROOT, 'scripts/lib/port-pids.sh'), String(port)],
    { encoding: 'utf8', timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS }
  );
  assertSubprocessCompleted(result, 'find_listen_pids_by_port');
  return result.stdout.split('\n').filter((line) => line.trim() !== '').map(Number);
}

// =============================================================================
// Sandbox: the scripts, run from a copy with no .env and no build
// =============================================================================

const SANDBOX_SCRIPTS = ['stop.sh', 'stop-server.sh', 'start.sh', 'load-env.sh', 'lib/port-pids.sh'] as const;

function makeSandbox(): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stop-sandbox-2488-'));
  fs.mkdirSync(path.join(sandbox, 'scripts', 'lib'), { recursive: true });
  for (const name of SANDBOX_SCRIPTS) {
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', name), path.join(sandbox, 'scripts', name));
  }
  // start.sh refuses to start something that was never built.
  fs.mkdirSync(path.join(sandbox, 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'dist/server/server.js'), '// stub\n');
  // `npm start` stands in for the real one: it just stays up.
  fs.mkdirSync(path.join(sandbox, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'bin/npm'), NPM_STUB, { mode: 0o755 });
  return sandbox;
}

type EnvOverride = Record<string, string | undefined>;

function runScript(sandbox: string, command: string, env: EnvOverride) {
  const result = spawnSync('bash', ['-c', command], {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    env: { NODE_ENV: 'test', PATH: `${sandbox}/bin:${MINIMAL_PATH}`, ...env },
  });
  assertSubprocessCompleted(result, command);
  return result;
}

const pidFileOf = (sandbox: string): string => path.join(sandbox, 'logs/server.pid');

function writePidFile(sandbox: string, pid: number): void {
  fs.mkdirSync(path.join(sandbox, 'logs'), { recursive: true });
  fs.writeFileSync(pidFileOf(sandbox), `${pid}\n`);
}

/** A port nobody listens on: bound, read back, released. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const net = require('node:net') as typeof import('node:net');
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

// File-level, because both suites below share the fixture directory and the
// reaping: nothing this file started may outlive it, whatever fails.
beforeAll(() => {
  fixtureDir = makeFixtureDir();
});

afterAll(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const pid of orphanPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone, which is what most of these tests assert
    }
  }
  await sleep(200);
  removeTempDir(fixtureDir);
});

describe.skipIf(SKIP)('Issue #2488: the stop scripts wait for the process, not for the port', () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = makeSandbox();
  });

  afterAll(() => {
    removeTempDir(sandbox);
  });

  it('the fixture reproduces the incident: the listener is gone while the process is not', async () => {
    // The pre-condition every assertion below depends on. Without it a stop
    // script that returned instantly would look correct.
    const server = await startSlowListener();
    await startClient(server.port);
    expect(listenPidsOn(server.port)).toEqual([server.pid]);

    process.kill(server.pid, 'SIGTERM');
    await sleep(2000); // what stop.sh used to wait before declaring success

    expect(listenPidsOn(server.port)).toEqual([]);
    expect(alive(server.pid), 'the process outlives its listening socket').toBe(true);

    // And it does go, on its own, at the 3-second mark.
    await sleep(1500);
    expect(alive(server.pid)).toBe(false);
  });

  it('stop.sh returns only once the process it signalled has exited', async () => {
    const server = await startSlowListener();
    const client = await startClient(server.port);

    const started = Date.now();
    const result = runScript(sandbox, 'bash scripts/stop.sh', { CM_PORT: String(server.port) });
    const elapsed = Date.now() - started;

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^Stopping ${server.pid} \\(.*slow-exit\\.js.*\\)$`, 'm'));
    expect(result.stdout).toContain('✓ Application stopped');

    // THE assertion: at the moment `✓ Application stopped` was printed, the
    // process was already gone. `kill -0` is authoritative because the fixture
    // is nobody's child here.
    expect(alive(server.pid), 'stop.sh returned while the server was still exiting').toBe(false);
    // It got there by waiting, not by luck: the fixture takes 3s to die.
    expect(elapsed).toBeGreaterThanOrEqual(2500);

    // Issue #2473: the process that was merely CONNECTED is untouched.
    expect(result.stdout).not.toMatch(new RegExp(`\\b${client.pid}\\b`));
    await sleep(200);
    expect(client.exitCode).toBeNull();
    expect(client.signalCode).toBeNull();
  });

  it('goes red with the pre-#2488 recipe in stop.sh (mutation control)', async () => {
    // The mutation is the code this Issue replaced, verbatim: sleep two
    // seconds, then ask the PORT whether anything is left.
    const original = fs.readFileSync(path.join(REPO_ROOT, 'scripts/stop.sh'), 'utf8');
    const mutated = original.replace(
      '    REMAINING=$(wait_for_exit "$STOP_GRACE_SECONDS" $PIDS)',
      '    sleep 2\n    REMAINING=$(find_listen_pids_by_port "$PORT")'
    );
    expect(mutated, 'the mutation did not land').not.toBe(original);
    fs.writeFileSync(path.join(sandbox, 'scripts/stop.mutant.sh'), mutated);

    const server = await startSlowListener();
    await startClient(server.port);

    const result = runScript(sandbox, 'bash scripts/stop.mutant.sh', { CM_PORT: String(server.port) });

    expect(result.status, result.stderr).toBe(0);
    // It reports success, exactly as it did on 2026-09-11 …
    expect(result.stdout).toContain('✓ Application stopped');
    // … while the server is still running. This is the assertion the real
    // stop.sh passes above and the mutant cannot.
    expect(alive(server.pid)).toBe(true);
  });

  it('escalates to SIGKILL, by name, when the process ignores SIGTERM', async () => {
    const server = await startSlowListener(-1); // never handles the signal
    const result = runScript(sandbox, 'bash scripts/stop.sh', {
      CM_PORT: String(server.port),
      CM_STOP_GRACE_SECONDS: '1',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^Force killing ${server.pid} \\(.*slow-exit\\.js.*\\)$`, 'm'));
    expect(result.stdout).toContain('✓ Application stopped');
    expect(alive(server.pid)).toBe(false);
  });

  it('stops the PID file’s npm process too, and removes the file', async () => {
    // The half stop.sh did not have: build-and-start.sh writes the PID of
    // `nohup npm start`, the node process's PARENT, which no port lookup can
    // find because it does not listen. It is the PID that came back as
    // `Server is already running`.
    const npmLike = launchOrphan([String(SHUTDOWN_MS), 'nolisten']);
    await firstLineOf(npmLike.out, 'npm-like parent');
    writePidFile(sandbox, npmLike.pid);
    const port = await freePort();

    const result = runScript(sandbox, 'bash scripts/stop.sh', { CM_PORT: String(port) });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^Stopping npm process ${npmLike.pid} \\(.*slow-exit\\.js.*\\)$`, 'm'));
    expect(result.stdout).toContain('✓ Application stopped');
    expect(alive(npmLike.pid)).toBe(false);
    expect(fs.existsSync(pidFileOf(sandbox)), 'a leftover PID file is the other half of the bug').toBe(false);
  });

  it('stop-server.sh makes the same two guarantees', async () => {
    // The two stop scripts disagreeing about this is what made /rebuild's
    // failure mode depend on which one the operator happened to run.
    const server = await startSlowListener();
    const npmLike = launchOrphan([String(SHUTDOWN_MS), 'nolisten']);
    await firstLineOf(npmLike.out, 'npm-like parent');
    writePidFile(sandbox, npmLike.pid);

    const result = runScript(sandbox, 'bash scripts/stop-server.sh', { CM_PORT: String(server.port) });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('✓ Server stopped successfully');
    expect(alive(server.pid)).toBe(false);
    expect(alive(npmLike.pid)).toBe(false);
    expect(fs.existsSync(pidFileOf(sandbox))).toBe(false);
  });

  it('clears a stale PID file without claiming to have stopped anything', async () => {
    // The other direction: a PID file left by a server that died on its own.
    // Nothing is signalled, the file goes, and the script does not pretend.
    const dead = launchOrphan(['0', 'nolisten', '1']);
    await firstLineOf(dead.out, 'short-lived orphan');
    for (let i = 0; i < 100 && alive(dead.pid); i += 1) await sleep(50);
    expect(alive(dead.pid)).toBe(false);
    writePidFile(sandbox, dead.pid);
    const port = await freePort();

    const result = runScript(sandbox, 'bash scripts/stop.sh', { CM_PORT: String(port) });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Application is not running on port ${port}`);
    expect(result.stdout).not.toContain('✓ Application stopped');
    expect(fs.existsSync(pidFileOf(sandbox))).toBe(false);
  });
});

// =============================================================================
// The start side
// =============================================================================

describe.skipIf(SKIP)('Issue #2488: a start waits out a predecessor that is still exiting', () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = makeSandbox();
  });

  afterAll(() => {
    removeTempDir(sandbox);
  });

  it('start.sh --daemon proceeds when the PID file’s process exits during the wait', async () => {
    const predecessor = launchOrphan([String(SHUTDOWN_MS), 'nolisten', '1500']);
    await firstLineOf(predecessor.out, 'predecessor');
    writePidFile(sandbox, predecessor.pid);
    const port = await freePort();

    const result = runScript(sandbox, 'bash scripts/start.sh --daemon', { CM_PORT: String(port) });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Previous server (PID: ${predecessor.pid}) is still exiting`);
    expect(result.stdout).toContain(`Previous server (PID: ${predecessor.pid}) has exited.`);
    expect(result.stdout).not.toContain('Server is already running');
    expect(result.stdout).toContain('✓ Server started successfully');

    const startedPid = Number(fs.readFileSync(pidFileOf(sandbox), 'utf8').trim());
    orphanPids.push(startedPid);
    expect(alive(startedPid)).toBe(true);
  });

  it('start.sh --daemon still refuses a predecessor that is genuinely running', async () => {
    // The behaviour this Issue must NOT change: waiting is not the same as
    // giving up. A live server outlives the grace period and is refused.
    const live = launchOrphan([String(-1), 'nolisten']);
    await firstLineOf(live.out, 'live server');
    writePidFile(sandbox, live.pid);
    const port = await freePort();

    const result = runScript(sandbox, 'bash scripts/start.sh --daemon', {
      CM_PORT: String(port),
      CM_STOP_GRACE_SECONDS: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`Server is already running (PID: ${live.pid})`);
    expect(result.stdout).toContain('Use ./scripts/stop-server.sh to stop it first');
    expect(alive(live.pid)).toBe(true);
  });

  it('the acceptance case: stop.sh && start.sh --daemon, with a client connected', async () => {
    // Issue #2488's first acceptance criterion, end to end. build-and-start.sh
    // is not the script under the chain here because it runs `npm run db:init`
    // and a full `npm run build:all` first; its PID-file check is the same code,
    // which the static assertions below pin byte for byte.
    const server = await startSlowListener();
    const client = await startClient(server.port);
    const npmLike = launchOrphan([String(SHUTDOWN_MS), 'nolisten']);
    await firstLineOf(npmLike.out, 'npm-like parent');
    writePidFile(sandbox, npmLike.pid);

    const result = runScript(sandbox, 'bash scripts/stop.sh && bash scripts/start.sh --daemon', {
      CM_PORT: String(server.port),
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain('Server is already running');
    expect(result.stdout).not.toContain('is already in use');
    expect(result.stdout).toContain('✓ Application stopped');
    expect(result.stdout).toContain('✓ Server started successfully');

    expect(alive(server.pid)).toBe(false);
    expect(alive(npmLike.pid)).toBe(false);

    const startedPid = Number(fs.readFileSync(pidFileOf(sandbox), 'utf8').trim());
    orphanPids.push(startedPid);
    expect(alive(startedPid)).toBe(true);

    // #2473 again: the connected client went through both halves untouched.
    await sleep(200);
    expect(client.exitCode).toBeNull();
    expect(client.signalCode).toBeNull();
  });
});

// =============================================================================
// The four scripts agree, in source
// =============================================================================

describe('Issue #2488: all four scripts carry the same wait', () => {
  const SCRIPTS = [
    'scripts/stop.sh',
    'scripts/stop-server.sh',
    'scripts/start.sh',
    'scripts/build-and-start.sh',
  ] as const;

  const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  /** The helper as stop.sh spells it — the reference every other copy is compared to. */
  function helperSource(text: string): string {
    const start = text.indexOf('still_alive() {');
    const end = text.indexOf('\n}\n', text.indexOf('wait_for_exit() {'));
    expect(start, 'still_alive() not found').toBeGreaterThan(-1);
    expect(end, 'wait_for_exit() not found').toBeGreaterThan(-1);
    return text.slice(start, end + 3);
  }

  it('spells still_alive/wait_for_exit identically in all four', () => {
    // They are copies because each script has to run on its own; the point of
    // the assertion is that a fix to one is a fix to all, or a red test.
    const reference = helperSource(read('scripts/stop.sh'));
    expect(reference).toContain('kill -0 "$pid" 2>/dev/null');
    expect(reference).toContain('sleep 0.1');
    for (const rel of SCRIPTS) {
      expect(helperSource(read(rel)), `${rel} has drifted`).toBe(reference);
    }
  });

  it('gives the grace period a floor above server.ts’s force-exit', () => {
    // server.ts gives up on a graceful close after 3 seconds; a stop that waits
    // less than that is back to reporting a process it did not wait for.
    const forceExitMs = /forcing exit\.\.\.'\);\s*process\.exit\(1\);\s*\}, (\d+)\);/.exec(read('server.ts'));
    expect(forceExitMs, 'server.ts no longer force-exits on a timer').not.toBeNull();
    const defaults = SCRIPTS.map((rel) => {
      const match = /STOP_GRACE_SECONDS=\$\{CM_STOP_GRACE_SECONDS:-(\d+)\}/.exec(read(rel));
      expect(match, `${rel} has no grace default`).not.toBeNull();
      return Number(match?.[1]);
    });
    for (const seconds of defaults) {
      expect(seconds * 1000).toBeGreaterThan(Number(forceExitMs?.[1]));
    }
    expect(new Set(defaults).size, 'the four scripts disagree about the grace period').toBe(1);
  });

  it('neither start script judges a PID file without waiting first', () => {
    for (const rel of ['scripts/start.sh', 'scripts/build-and-start.sh'] as const) {
      const code = read(rel);
      // The refusal is still there …
      expect(code).toContain('Server is already running (PID: $OLD_PID)');
      // … but only inside the branch that the wait did not clear.
      expect(code).toMatch(
        /if \[ -n "\$\(wait_for_exit "\$STOP_GRACE_SECONDS" "\$OLD_PID"\)" \]; then\n\s+echo "Server is already running/
      );
    }
  });

  it('closes idle keep-alive connections on the way out (server.ts)', () => {
    // The other half of the 3-second window: without this the close callback
    // waits for connections that nothing will ever close.
    //
    // The call sits INSIDE the loop that shutdown runs over every listener, not
    // on `server` alone. Issue #2489 opens a second listener for the provider
    // and states the invariant that whatever shutdown does to one listener it
    // does to all of them; `server.closeIdleConnections()` would leave the
    // provider's door unable to shed its idle sockets — the same 3-second
    // window this Issue is closing, on the listener nobody watches. That the
    // call reaches BOTH listeners is measured rather than read off the source
    // by tests/integration/server-shutdown-remote-ingress-2489.test.ts; this
    // pin only keeps it from drifting back out of the loop.
    const code = read('server.ts');
    expect(code).toContain('listener.closeIdleConnections();');
    expect(code).not.toContain('server.closeIdleConnections();');
    const loop = code.indexOf('for (const listener of listeners) {');
    expect(loop).toBeGreaterThan(-1);
    expect(code.indexOf('listener.closeIdleConnections();')).toBeGreaterThan(loop);
  });
});
