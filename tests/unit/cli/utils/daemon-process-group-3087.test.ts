/**
 * Issue #3087: `stop` must stop the server, not just npm.
 *
 * `start --daemon` records npm's PID. On Linux npm did not forward SIGTERM to
 * the server it ran, so `kill(npmPid)` left `node server.js` listening as an
 * orphan — which `remote` then published without authentication.
 *
 * These tests use REAL processes: a stand-in for npm (dies on SIGTERM without
 * forwarding it, exactly the failure) that launches a stand-in server holding
 * a free loopback port. Everything lives under os.tmpdir() and is killed in
 * afterEach whatever the outcome.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const workDir = mkdtempSync(join(tmpdir(), 'cm-daemon-pgrp-3087-'));
const fakeNpmPath = join(workDir, 'fake-npm.cjs');
const fakeServerPath = join(workDir, 'fake-server.cjs');

// `start()` spawns `npm run start`; route that to the stand-in. Every other
// spawn (e.g. `ps` for the start-time signature) is left real.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) =>
      command === 'npm'
        ? actual.spawn(process.execPath, [fakeNpmPath], options)
        : actual.spawn(command, args, options)) as typeof actual.spawn,
  };
});
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: () => join(workDir, 'missing.env'),
}));
vi.mock('../../../../src/cli/utils/logger', () => ({
  CLILogger: class {
    info(): void {}
    warn(): void {}
    error(): void {}
    success(): void {}
  },
}));

import { DaemonManager } from '../../../../src/cli/utils/daemon';
import { isPortInUse, waitForServer } from '../../../../src/cli/utils/server-ready';

// npm stand-in: launches the server in its own process group and does NOT
// forward signals. SIGTERM's default action kills only this process.
writeFileSync(
  fakeNpmPath,
  `const { spawn } = require('child_process');
const fs = require('fs');
const child = spawn(process.execPath, [${JSON.stringify(fakeServerPath)}], { stdio: 'ignore', env: process.env });
fs.writeFileSync(process.env.CM_TEST_CHILD_PID_FILE, String(child.pid));
setInterval(() => {}, 1000);
`
);
writeFileSync(
  fakeServerPath,
  `require('http').createServer((req, res) => res.end('ok')).listen(Number(process.env.CM_PORT), '127.0.0.1');
setInterval(() => {}, 1000);
`
);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

function readChildPid(): number | null {
  try {
    const pid = parseInt(readFileSync(childPidFile, 'utf-8'), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

let childPidFile: string;
let pidFile: string;
let port: number;
const leaders: number[] = [];
const holders: Server[] = [];

describe('DaemonManager process group (Issue #3087)', () => {
  beforeEach(async () => {
    const caseDir = mkdtempSync(join(workDir, 'case-'));
    childPidFile = join(caseDir, 'child.pid');
    pidFile = join(caseDir, '.commandmate.pid');
    process.env.CM_TEST_CHILD_PID_FILE = childPidFile;
    port = await freePort();
  });

  afterEach(async () => {
    const child = readChildPid();
    for (const pid of [...leaders, ...(child === null ? [] : [child])]) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    leaders.length = 0;
    await Promise.all(holders.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
    delete process.env.CM_TEST_CHILD_PID_FILE;
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('control: signalling only npm leaves the server listening (the #3087 failure)', async () => {
    const leader: ChildProcess = spawn(process.execPath, [fakeNpmPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CM_PORT: String(port) },
    });
    leaders.push(leader.pid!);
    expect(await waitForServer('127.0.0.1', port, { timeoutMs: 10000 })).toBe(true);
    const child = readChildPid();
    expect(child).not.toBeNull();

    const exited = new Promise((resolve) => leader.once('exit', resolve));
    process.kill(leader.pid!, 'SIGTERM');
    await exited;

    expect(isAlive(child!)).toBe(true);
    expect(await isPortInUse('127.0.0.1', port)).toBe(true);
  });

  it('start --daemon -> stop leaves no server process and frees the port', async () => {
    const daemon = new DaemonManager(pidFile);
    const leader = await daemon.start({ port });
    leaders.push(leader);
    expect(await waitForServer('127.0.0.1', port, { timeoutMs: 10000 })).toBe(true);
    expect(await waitUntil(() => readChildPid() !== null)).toBe(true);
    const child = readChildPid()!;

    expect(await daemon.stop()).toBe(true);

    expect(await waitUntil(() => !isAlive(child), 2000)).toBe(true);
    expect(await isPortInUse('127.0.0.1', port)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('stops a server orphaned by an npm that already exited', async () => {
    const daemon = new DaemonManager(pidFile);
    const leader = await daemon.start({ port });
    leaders.push(leader);
    expect(await waitForServer('127.0.0.1', port, { timeoutMs: 10000 })).toBe(true);
    expect(await waitUntil(() => readChildPid() !== null)).toBe(true);
    const child = readChildPid()!;

    // What a pre-fix `stop` did: npm dies, the server keeps the port.
    process.kill(leader, 'SIGTERM');
    expect(await waitUntil(() => !isAlive(leader))).toBe(true);
    expect(isAlive(child)).toBe(true);

    expect(await daemon.stop()).toBe(true);

    expect(await waitUntil(() => !isAlive(child), 2000)).toBe(true);
    expect(await isPortInUse('127.0.0.1', port)).toBe(false);
  });

  it('a later start keeps the stale PID file while the orphaned server lives, so stop can still find it', async () => {
    const daemon = new DaemonManager(pidFile);
    const leader = await daemon.start({ port });
    leaders.push(leader);
    expect(await waitForServer('127.0.0.1', port, { timeoutMs: 10000 })).toBe(true);
    expect(await waitUntil(() => readChildPid() !== null)).toBe(true);
    const child = readChildPid()!;

    // npm (the recorded PID) alone dies, e.g. kill -9; the server keeps the port.
    process.kill(leader, 'SIGKILL');
    expect(await waitUntil(() => !isAlive(leader))).toBe(true);

    // What `remote` / `start` run next: refused, and the PID file is not removed.
    await expect(new DaemonManager(pidFile).start({ port })).rejects.toThrow(/still running/);
    expect(existsSync(pidFile)).toBe(true);

    expect(await new DaemonManager(pidFile).stop()).toBe(true);
    expect(await waitUntil(() => !isAlive(child), 2000)).toBe(true);
    expect(await isPortInUse('127.0.0.1', port)).toBe(false);
  });

  it('start refuses a port another process already answers on, and spawns nothing', async () => {
    const holder = createServer();
    holders.push(holder);
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));

    const daemon = new DaemonManager(pidFile);
    await expect(daemon.start({ port })).rejects.toThrow(/already in use by another process/);

    expect(existsSync(pidFile)).toBe(false);
    expect(readChildPid()).toBeNull();
  });
});
