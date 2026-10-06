/**
 * Issue #3312 (step 1b) — the product-path check's supervisor and deadline
 * guard (scripts/agent-health/product/), without a model and without the real
 * server:
 *
 *   - the server is a small node script (CM_UAT_SERVER_ENTRY) that listens on
 *     CM_PORT, opens CM_DB_PATH and answers `[]`, started through
 *     run-server.sh's own `env -i` line, so the isolation checks of
 *     .commandmate/uat-own-home.yaml really run against it;
 *   - tmux is a stub on PATH (no tmux server is started);
 *   - the stage is a shell command (CM_PRODUCT_STAGE_CMD);
 *   - every directory is under os.tmpdir(); HOME is moved there too.
 *
 * Each crash case kills the supervisor with SIGKILL at a checkpoint
 * (CM_PRODUCT_TEST_PAUSE_AT) or while the stage runs, and checks that the next
 * supervisor or the deadline guard stops exactly what the ledger recorded —
 * and that a process whose pid was reused is NOT stopped.
 *
 * @vitest-environment node
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { judgeProductRun } from '@/lib/agent-health/product-judgement';
import { parseProductRunResult, type ProductRunResult } from '@/lib/agent-health/product-result';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SUPERVISOR = path.join(REPO_ROOT, 'scripts/agent-health/product/supervisor.sh');
const GUARD = path.join(REPO_ROOT, 'scripts/agent-health/product/deadline-guard.sh');
const DATE = '2026-10-06';
const SHA = 'abcdef1234567';
const TEST_TIMEOUT = 120_000;

const has = (command: string): boolean =>
  spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
const HAS_TOOLS = has('lsof') && has('python3') && fs.existsSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'));

const SERVER_JS = `
const http = require('http');
const fs = require('fs');
fs.openSync(process.env.CM_DB_PATH, 'a');
http
  .createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('[]');
  })
  .listen(Number(process.env.CM_PORT), '127.0.0.1');
setInterval(() => {}, 1 << 30);
`;

// tmux stub: `tmux -S <sock> <command> ...`. A regular file stands for the
// socket; every other command (stopping the server included) does nothing, and
// the socket directory's removal takes the file with it.
const FAKE_TMUX = `#!/bin/sh
sock="$2"
case "$3" in
  new-session) : > "$sock" ;;
  display-message) echo $$ ;;
esac
exit 0
`;

let root: string;
let base: string;
let publish: string;
let children: ChildProcess[];
let extraPids: number[];
let port: number;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: p } = server.address() as net.AddressInfo;
      server.close(() => resolve(p));
    });
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: Record<string, string> = {
    PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
    HOME: root,
    USER: process.env.USER ?? '',
    LOGNAME: process.env.LOGNAME ?? '',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: 'en_US.UTF-8',
    CM_PRODUCT_RUN_DIR: base,
    CM_PRODUCT_PUBLISH_DIR: publish,
    CM_PRODUCT_PORT: String(port),
    CM_PRODUCT_DATE: DATE,
    CM_PRODUCT_SHA: SHA,
    CM_PRODUCT_LATE_START: `@${nowSec() + 3600}`,
    CM_PRODUCT_STOP_AT: `@${nowSec() + 3600}`,
    CM_PRODUCT_FINAL_AT: `@${nowSec() + 3600}`,
    CM_UAT_SOCK_BASE: path.join(root, 's'),
    CM_RUN_LOCK_DIR: path.join(root, 'l'),
    CM_UAT_SERVER_ENTRY: path.join(root, 'server.js'),
    CM_PRODUCT_STOP_WAIT_TENTHS: '30',
    ...extra,
  };
  return out as unknown as NodeJS.ProcessEnv;
}

function supervise(extra: Record<string, string> = {}) {
  return spawnSync('bash', [SUPERVISOR], { cwd: REPO_ROOT, env: env(extra), encoding: 'utf8', timeout: 90_000 });
}

function guard(extra: Record<string, string> = {}) {
  return spawnSync('bash', [GUARD], { cwd: REPO_ROOT, env: env(extra), encoding: 'utf8', timeout: 90_000 });
}

function superviseInBackground(extra: Record<string, string>): ChildProcess {
  const child = spawn('bash', [SUPERVISOR], { cwd: REPO_ROOT, env: env(extra), stdio: 'ignore' });
  children.push(child);
  return child;
}

async function waitFor(predicate: () => boolean, what: string, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface LedgerJson {
  runId: string;
  status: string;
  resources: Array<{ id: string; kind: string; state: string; pid?: string; note?: string }>;
  reclaimedRuns: string[];
  unknownElsewhere: string[];
}

function ledgers(): LedgerJson[] {
  const dir = path.join(base, 'ledger');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as LedgerJson);
}

function resource(ledger: LedgerJson, id: string) {
  return ledger.resources.find((item) => item.id === id);
}

function published(): ProductRunResult {
  const file = path.join(publish, `product-${DATE}.json`);
  const result = parseProductRunResult(fs.readFileSync(file, 'utf8'));
  expect(result, 'the published result parses').not.toBeNull();
  return result!;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
}

/** Every process of this user whose command line or environment mentions the temp root. */
function pidsUnderRoot(): number[] {
  const out = spawnSync('ps', ['eww', '-U', String(process.getuid!()), '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  return out
    .split('\n')
    .filter((line) => line.includes(root) && !line.includes('vitest'))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

function serverPid(ledger: LedgerJson): number {
  const state = fs.readFileSync(path.join(base, 'runs', ledger.runId, 'uat-run.state'), 'utf8');
  return Number(/^server_pid=(\d+)$/m.exec(state)![1]);
}

beforeEach(async () => {
  // Logical (short) path for HOME and the socket base: a unix socket path is
  // capped at 104 bytes on macOS. The supervisor resolves its own base.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'p-'));
  base = path.join(root, 'b');
  publish = path.join(root, 'pub');
  fs.mkdirSync(publish);
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'tmux'), FAKE_TMUX, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server.js'), SERVER_JS);
  children = [];
  extraPids = [];
  port = await freePort();
});

afterEach(() => {
  for (const child of children) {
    if (child.pid && alive(child.pid)) process.kill(child.pid, 'SIGKILL');
  }
  for (const pid of [...extraPids, ...pidsUnderRoot()]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!HAS_TOOLS)('supervisor.sh (Issue #3312)', () => {
  it(
    'runs exclusive -> reclaim -> safety -> up -> isolation -> run -> down -> finalize and leaves nothing',
    () => {
      const res = supervise({ CM_PRODUCT_STAGE_CMD: 'test "$CM_PORT" = "$CM_PRODUCT_PORT_EXPECTED"', CM_PRODUCT_PORT_EXPECTED: String(port) });
      expect(res.status, res.stderr).toBe(0);
      const result = published();
      expect(result.stages.map((stage) => [stage.id, stage.status])).toEqual([
        ['reclaim', 'pass'],
        ['safety', 'pass'],
        ['up', 'pass'],
        ['isolation', 'pass'],
        ['run', 'pass'],
        ['down', 'pass'],
      ]);
      expect(result).toMatchObject({ date: DATE, sha: SHA, lateStart: false });
      expect(result.cleanup).toEqual({ status: 'pass', unknown: [] });
      expect(result.reclaim).toMatchObject({ status: 'pass', by: 'supervisor' });
      expect(fs.statSync(path.join(publish, `product-${DATE}.json`)).mode & 0o777).toBe(0o644);

      const [ledger] = ledgers();
      expect(ledger.status).toBe('closed');
      expect(ledger.resources.map((item) => [item.id, item.state])).toEqual([
        ['server', 'released'],
        ['tmux', 'released'],
        ['runner', 'released'],
      ]);
      expect(alive(serverPid(ledger))).toBe(false);
      expect(fs.readdirSync(path.join(root, 's'))).toEqual([]);
      expect(fs.existsSync(path.join(base, 'supervisor.lock'))).toBe(false);
      expect(pidsUnderRoot()).toEqual([]);

      const final = judgeProductRun({ date: DATE, runResult: result, leak: 'pass', now: new Date() });
      expect(final.status).toBe('pass');
    },
    TEST_TIMEOUT
  );

  it(
    'a stage that fails is a failed run stage, and still cleans up',
    () => {
      const res = supervise({ CM_PRODUCT_STAGE_CMD: 'exit 1' });
      expect(res.status, res.stderr).toBe(0);
      const result = published();
      expect(result.stages.find((stage) => stage.id === 'run')).toMatchObject({ status: 'fail' });
      expect(result.cleanup.status).toBe('pass');
      expect(pidsUnderRoot()).toEqual([]);
    },
    TEST_TIMEOUT
  );

  it(
    'a second supervisor exits 75 and touches nothing; after a kill -9 the next one takes over and reclaims',
    async () => {
      const first = superviseInBackground({ CM_PRODUCT_TEST_PAUSE_AT: 'reclaim' });
      await waitFor(() => fs.existsSync(path.join(base, 'paused-reclaim')), 'the first supervisor to pause');

      const second = supervise();
      expect(second.status, second.stderr).toBe(75);
      expect(second.stderr).toContain('busy');
      expect(ledgers()).toHaveLength(1);

      process.kill(first.pid!, 'SIGKILL');
      await waitFor(() => !alive(first.pid!), 'the first supervisor to die');
      fs.rmSync(path.join(base, 'paused-reclaim'));

      const third = supervise({ CM_PRODUCT_STAGE_CMD: 'exit 0' });
      expect(third.status, third.stderr).toBe(0);
      const [old, current] = ledgers();
      expect(old.status).toBe('reclaimed');
      expect(current.reclaimedRuns).toEqual([old.runId]);
      expect(published().reclaim).toMatchObject({ status: 'pass', reclaimed: [old.runId] });
    },
    TEST_TIMEOUT
  );

  it(
    'kill -9 while the stage runs: the deadline guard stops the server and the runner group and says so',
    async () => {
      const sup = superviseInBackground({ CM_PRODUCT_STAGE_CMD: 'sleep 60' });
      await waitFor(() => {
        const [ledger] = ledgers();
        return ledger !== undefined && resource(ledger, 'runner')?.state === 'acquired';
      }, 'the runner to be acquired');
      process.kill(sup.pid!, 'SIGKILL');
      await waitFor(() => !alive(sup.pid!), 'the supervisor to die');

      const [ledger] = ledgers();
      const server = serverPid(ledger);
      const runner = Number(resource(ledger, 'runner')!.pid);
      expect(alive(server)).toBe(true);
      expect(alive(runner)).toBe(true);

      const res = guard({ CM_PRODUCT_FINAL_AT: `@${nowSec() - 1}` });
      expect(res.status, res.stderr).toBe(0);
      expect(alive(server)).toBe(false);
      expect(alive(runner)).toBe(false);
      expect(pidsUnderRoot()).toEqual([]);
      const result = published();
      expect(result.reclaim).toMatchObject({ status: 'pass', by: 'deadline-guard' });
      expect(result.stages.find((stage) => stage.id === 'run')).toMatchObject({ status: 'unknown' });
      expect(ledgers()[0].status).toBe('closed');
      expect(fs.existsSync(path.join(base, 'supervisor.lock'))).toBe(false);

      const final = judgeProductRun({ date: DATE, runResult: result, leak: 'pass', now: new Date() });
      expect(final.status).toBe('unknown');
      expect(final.reasons.join('\n')).toContain('期限の番人が回収した');

      // Nothing left: a second guard has nothing to do.
      const again = guard({ CM_PRODUCT_FINAL_AT: `@${nowSec() - 1}` });
      expect(again.status).toBe(0);
      expect(again.stderr).toContain('nothing to reclaim');
    },
    TEST_TIMEOUT
  );

  it(
    'kill -9 in cleanup: the next supervisor stops the server it left',
    async () => {
      const sup = superviseInBackground({ CM_PRODUCT_STAGE_CMD: 'exit 0', CM_PRODUCT_TEST_PAUSE_AT: 'cleanup' });
      await waitFor(() => fs.existsSync(path.join(base, 'paused-cleanup')), 'the supervisor to reach cleanup');
      process.kill(sup.pid!, 'SIGKILL');
      await waitFor(() => !alive(sup.pid!), 'the supervisor to die');
      const server = serverPid(ledgers()[0]);
      expect(alive(server)).toBe(true);

      const next = supervise({ CM_PRODUCT_STAGE_CMD: 'exit 0' });
      expect(next.status, next.stderr).toBe(0);
      expect(alive(server)).toBe(false);
      expect(ledgers()[0].status).toBe('reclaimed');
      expect(published().stages.find((stage) => stage.id === 'run')).toMatchObject({ status: 'pass' });
      expect(pidsUnderRoot()).toEqual([]);
    },
    TEST_TIMEOUT
  );

  it(
    'a ledger written only as far as `planned`: the server is found by its CM_DB_PATH and stopped',
    async () => {
      const sup = superviseInBackground({ CM_PRODUCT_TEST_PAUSE_AT: 'up' });
      await waitFor(() => fs.existsSync(path.join(base, 'paused-up')), 'the server to be up, not yet acquired');
      process.kill(sup.pid!, 'SIGKILL');
      await waitFor(() => !alive(sup.pid!), 'the supervisor to die');
      const [ledger] = ledgers();
      expect(resource(ledger, 'server')!.state).toBe('planned');
      expect(resource(ledger, 'tmux')!.state).toBe('planned');
      const server = serverPid(ledger);
      expect(alive(server)).toBe(true);

      const res = guard({ CM_PRODUCT_FINAL_AT: `@${nowSec() - 1}` });
      expect(res.status, res.stderr).toBe(0);
      expect(alive(server)).toBe(false);
      const after = ledgers()[0];
      expect(resource(after, 'server')).toMatchObject({ state: 'released', note: 'found by name' });
      expect(resource(after, 'tmux')!.state).toBe('released');
      expect(fs.readdirSync(path.join(root, 's'))).toEqual([]);
    },
    TEST_TIMEOUT
  );

  it(
    'a reused pid is never stopped: the resource is left unknown and nothing runs today',
    () => {
      // Positive control below: the same ledger with the right start time is stopped.
      const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
      extraPids.push(sleeper.pid!);
      const runId = 'old-run';
      fs.mkdirSync(path.join(base, 'ledger'), { recursive: true });
      const ledgerFile = path.join(base, 'ledger', `${runId}.json`);
      fs.writeFileSync(
        ledgerFile,
        JSON.stringify({
          runId,
          date: '2026-10-05',
          runDir: path.join(base, 'runs', runId),
          status: 'open',
          reclaimedRuns: [],
          unknownElsewhere: [],
          resources: [
            {
              id: 'server',
              kind: 'server',
              state: 'acquired',
              pid: String(sleeper.pid),
              lstart: 'Thu Jan  1 00:00:00 2026',
              db: path.join(base, 'runs', runId, 'uat.db'),
            },
            {
              id: 'runner',
              kind: 'runner',
              state: 'acquired',
              pid: String(sleeper.pid),
              lstart: spawnSync('ps', ['-o', 'lstart=', '-p', String(sleeper.pid)], {
                encoding: 'utf8',
                env: { ...process.env, LC_ALL: 'C' },
              }).stdout.trim(),
              pgid: '1',
            },
          ],
        })
      );

      const res = supervise({ CM_PRODUCT_STAGE_CMD: 'exit 0' });
      expect(res.status, res.stderr).toBe(0);
      expect(alive(sleeper.pid!)).toBe(true);
      const old = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) as LedgerJson;
      expect(old.resources.map((item) => item.state)).toEqual(['unknown', 'unknown']);
      const result = published();
      expect(result.reclaim).toMatchObject({ status: 'unknown', unknown: ['old-run_server', 'old-run_runner'] });
      expect(result.stages.map((stage) => [stage.id, stage.status])).toEqual([
        ['reclaim', 'unknown'],
        ['safety', 'fail'],
      ]);
      expect(judgeProductRun({ date: DATE, runResult: result, leak: 'pass', now: new Date() }).status).toBe('fail');
    },
    TEST_TIMEOUT
  );

  it(
    'positive control for the reused pid: the same runner entry with its real start time and group is stopped',
    () => {
      const sleeper = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
      extraPids.push(sleeper.pid!);
      const runId = 'old-run';
      fs.mkdirSync(path.join(base, 'ledger'), { recursive: true });
      fs.writeFileSync(
        path.join(base, 'ledger', `${runId}.json`),
        JSON.stringify({
          runId,
          date: '2026-10-05',
          runDir: path.join(base, 'runs', runId),
          status: 'open',
          reclaimedRuns: [],
          unknownElsewhere: [],
          resources: [
            {
              id: 'runner',
              kind: 'runner',
              state: 'acquired',
              pid: String(sleeper.pid),
              lstart: spawnSync('ps', ['-o', 'lstart=', '-p', String(sleeper.pid)], {
                encoding: 'utf8',
                env: { ...process.env, LC_ALL: 'C' },
              }).stdout.trim(),
              pgid: String(sleeper.pid),
            },
          ],
        })
      );
      const res = supervise({ CM_PRODUCT_STAGE_CMD: 'exit 0' });
      expect(res.status, res.stderr).toBe(0);
      expect(alive(sleeper.pid!)).toBe(false);
      expect(published().reclaim).toMatchObject({ status: 'pass', reclaimed: [runId] });
    },
    TEST_TIMEOUT
  );

  it(
    'stops the runner at the deadline and cleans up',
    () => {
      const started = Date.now();
      const res = supervise({ CM_PRODUCT_STAGE_CMD: 'sleep 60', CM_PRODUCT_STOP_AT: `@${nowSec() + 8}` });
      expect(res.status, res.stderr).toBe(0);
      expect(Date.now() - started).toBeLessThan(55_000);
      const result = published();
      expect(result.stages.find((stage) => stage.id === 'run')).toMatchObject({
        status: 'unknown',
        reason: 'stopped at the deadline',
      });
      expect(result.cleanup.status).toBe('pass');
      expect(pidsUnderRoot()).toEqual([]);
    },
    TEST_TIMEOUT
  );

  it(
    'a late start runs nothing but still reclaims what an earlier run left',
    async () => {
      const sup = superviseInBackground({ CM_PRODUCT_TEST_PAUSE_AT: 'up' });
      await waitFor(() => fs.existsSync(path.join(base, 'paused-up')), 'the server to be up');
      process.kill(sup.pid!, 'SIGKILL');
      await waitFor(() => !alive(sup.pid!), 'the supervisor to die');
      const server = serverPid(ledgers()[0]);

      const res = supervise({ CM_PRODUCT_STAGE_CMD: 'exit 0', CM_PRODUCT_LATE_START: `@${nowSec() - 60}` });
      expect(res.status, res.stderr).toBe(0);
      expect(alive(server)).toBe(false);
      const result = published();
      expect(result.lateStart).toBe(true);
      expect(result.stages.map((stage) => stage.id)).toEqual(['reclaim']);
      expect(ledgers()[1].resources).toEqual([]);
      expect(judgeProductRun({ date: DATE, runResult: result, leak: 'pass', now: new Date() }).status).toBe('skip');
    },
    TEST_TIMEOUT
  );

  it(
    'refuses to publish into a symlinked directory (exit 1) and writes nothing through it',
    () => {
      const elsewhere = path.join(root, 'elsewhere');
      fs.mkdirSync(elsewhere);
      const link = path.join(root, 'pub-link');
      fs.symlinkSync(elsewhere, link);
      const res = supervise({ CM_PRODUCT_STAGE_CMD: 'exit 0', CM_PRODUCT_PUBLISH_DIR: link });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('is a symlink');
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      // The run's own resources are still gone.
      expect(pidsUnderRoot()).toEqual([]);
    },
    TEST_TIMEOUT
  );
});

describe.skipIf(!HAS_TOOLS)('deadline-guard.sh (Issue #3312)', () => {
  it(
    'leaves a live supervisor alone before its deadline (exit 75)',
    async () => {
      const sup = superviseInBackground({ CM_PRODUCT_TEST_PAUSE_AT: 'reclaim' });
      await waitFor(() => fs.existsSync(path.join(base, 'paused-reclaim')), 'the supervisor to pause');
      const res = guard();
      expect(res.status).toBe(75);
      expect(alive(sup.pid!)).toBe(true);
      expect(fs.existsSync(path.join(publish, `product-${DATE}.json`))).toBe(false);
    },
    TEST_TIMEOUT
  );

  it(
    'stops a supervisor alive past its deadline (pid and start time checked), then reclaims and publishes',
    async () => {
      const sup = superviseInBackground({ CM_PRODUCT_TEST_PAUSE_AT: 'up' });
      await waitFor(() => fs.existsSync(path.join(base, 'paused-up')), 'the server to be up');
      const server = serverPid(ledgers()[0]);
      const res = guard({ CM_PRODUCT_FINAL_AT: `@${nowSec() - 1}` });
      expect(res.status, res.stderr).toBe(0);
      await waitFor(() => !alive(sup.pid!), 'the supervisor to be stopped');
      expect(alive(server)).toBe(false);
      expect(published().reclaim.by).toBe('deadline-guard');
      expect(fs.existsSync(path.join(base, 'supervisor.lock'))).toBe(false);
    },
    TEST_TIMEOUT
  );
});

describe.skipIf(!HAS_TOOLS)('the supervisor lock (Issue #3312, review of PR #3405)', () => {
  const LIB = path.join(REPO_ROOT, 'scripts/agent-health/product/lib.sh');
  const lockDir = () => path.join(base, 'supervisor.lock');

  /** Sources lib.sh with PRODUCT_BASE set, then runs `body`. */
  function lib(body: string) {
    fs.mkdirSync(base, { recursive: true });
    return spawnSync('bash', ['-c', `PRODUCT_BASE='${base}'\n. '${LIB}'\n${body}`], {
      env: env(),
      encoding: 'utf8',
      timeout: 60_000,
    });
  }

  it('a lock still being made (no owner yet) is not taken over: the second supervisor exits 75', () => {
    fs.mkdirSync(lockDir(), { recursive: true });
    const res = supervise({ CM_PRODUCT_STAGE_CMD: 'exit 0' });
    expect(res.status).toBe(75);
    expect(res.stderr).toContain('being taken by another supervisor');
    expect(fs.existsSync(lockDir())).toBe(true);
    expect(ledgers()).toEqual([]);
  });

  it('an ownerless lock older than a minute is taken over (its maker died)', () => {
    fs.mkdirSync(lockDir(), { recursive: true });
    spawnSync('touch', ['-t', '202601010000', lockDir()]);
    const res = lib('product_lock_acquire test && echo HELD');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('HELD');
  });

  it('a lock whose owner is dead is taken over; one whose owner is alive is not', () => {
    fs.mkdirSync(lockDir(), { recursive: true });
    fs.writeFileSync(path.join(lockDir(), 'owner'), 'pid=999999\nlstart=x\nlabel=old\ntoken=t\n');
    expect(lib('product_lock_acquire test && echo HELD').stdout).toContain('HELD');

    fs.rmSync(lockDir(), { recursive: true, force: true });
    fs.mkdirSync(lockDir());
    const lstart = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    }).stdout.trim();
    fs.writeFileSync(path.join(lockDir(), 'owner'), `pid=${process.pid}\nlstart=${lstart}\nlabel=alive\ntoken=t\n`);
    const res = lib('product_lock_acquire test && echo HELD');
    expect(res.stdout).not.toContain('HELD');
    expect(res.stderr).toBe('');
    expect(fs.readFileSync(path.join(lockDir(), 'owner'), 'utf8')).toContain('label=alive');
  });

  it('of supervisors racing for the lock, exactly one gets it', () => {
    const racer = `( if product_lock_acquire race; then echo GOT; sleep 2; product_lock_release; else echo LOST; fi ) &`;
    const res = lib(`${Array.from({ length: 8 }, () => racer).join('\n')}\nwait`);
    expect(res.status, res.stderr).toBe(0);
    const lines = res.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(8);
    expect(lines.filter((line) => line === 'GOT')).toHaveLength(1);
  });

  it('release removes only its own lock', () => {
    fs.mkdirSync(lockDir(), { recursive: true });
    fs.writeFileSync(path.join(lockDir(), 'owner'), `pid=${process.pid}\nlstart=x\nlabel=other\ntoken=theirs\n`);
    lib('PRODUCT_LOCK_TOKEN=mine\nproduct_lock_release');
    expect(fs.existsSync(lockDir())).toBe(true);
  });
});
