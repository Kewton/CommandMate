/**
 * Issue #3044: the thin wrappers around the measuring tools. A missing tool,
 * a timeout and a thrown error all end as a skip with the reason — never as a
 * crash of the run. Everything happens under os.tmpdir().
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUN_ORDER,
  aggregateServerLog,
  listServerLogFiles,
  listSourceFiles,
  measureAll,
  runCommand,
  type RunnerContext,
} from '../../../../scripts/agent-health/metrics-runners';
import { METRIC_IDS } from '@/lib/agent-health/metrics-types';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-metrics-runners-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<RunnerContext> = {}): RunnerContext {
  return {
    repoRoot: root,
    workDir: path.join(root, 'work'),
    deadline: Date.now() + 60_000,
    env: process.env,
    log: () => undefined,
    ...overrides,
  };
}

describe('runCommand', () => {
  it('captures stdout and the exit code', async () => {
    const result = await runCommand('node', ['-e', 'process.stdout.write("hi"); process.exit(3)'], {
      cwd: root,
      env: process.env,
      timeoutMs: 20_000,
    });
    expect(result).toMatchObject({ code: 3, stdout: 'hi', timedOut: false, missing: false });
  });

  it('reports a missing executable instead of throwing', async () => {
    const result = await runCommand('cm-no-such-tool-3044', [], { cwd: root, env: process.env, timeoutMs: 5_000 });
    expect(result.missing).toBe(true);
  });

  it('stops a command at its timeout', async () => {
    const started = Date.now();
    const result = await runCommand('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: root,
      env: process.env,
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('listSourceFiles', () => {
  it('lists source files under src/, skipping node_modules and dot dirs', () => {
    for (const file of ['src/a.ts', 'src/lib/b.tsx', 'src/lib/c.md', 'src/node_modules/x.ts', 'src/.cache/y.ts', 'other/z.ts']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'x\n');
    }
    expect(listSourceFiles(root)).toEqual(['src/a.ts', 'src/lib/b.tsx']);
  });
});

describe('measureAll', () => {
  it('runs every metric in RUN_ORDER', () => {
    expect([...RUN_ORDER].sort()).toEqual([...METRIC_IDS].sort());
  });

  it('turns an exhausted budget and a thrown error into skips', async () => {
    fs.mkdirSync(path.join(root, 'work'), { recursive: true });
    // no src/ → the file walk throws; the deadline has passed → npm is not started
    const results = await measureAll(ctx({ deadline: Date.now() - 1 }), ['file-size', 'outdated']);
    const byId = Object.fromEntries(results.map((r) => [r.metricId, r]));
    expect(byId['file-size']).toMatchObject({ status: 'skip' });
    expect(byId.outdated).toMatchObject({ status: 'skip', reason: '全体の時間上限に達したため実行しない' });
  });

  it('measures file-size and type-safety from the files', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const a: any = 1;\n// @ts-ignore\nexport {};\n');
    const results = await measureAll(ctx(), ['file-size', 'type-safety']);
    const byId = Object.fromEntries(results.map((r) => [r.metricId, r]));
    expect(byId['file-size']).toMatchObject({ status: 'ok', items: { 'src/a.ts': 3 } });
    expect(byId['type-safety']).toMatchObject({ status: 'ok', items: { any: 1, 'ts-ignore': 1 } });
  });
});

describe('performance from the production log (Issue #3054)', () => {
  const NOW = new Date('2026-10-01T21:30:00.000Z');
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
  const write = (name: string, lines: string[]) => {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'logs', name), `${lines.join('\n')}\n`);
  };

  it('lists server.log and up to 3 rotated files in order', () => {
    for (const name of ['server.log', 'server.log.2', 'server.log.1', 'server.log.10', 'server.log.4', 'server.log.x', 'other.log.1']) {
      write(name, []);
    }
    expect(listServerLogFiles(path.join(root, 'logs', 'server.log')).map((f) => path.basename(f))).toEqual([
      'server.log',
      'server.log.1',
      'server.log.2',
      'server.log.4',
    ]);
  });

  it('reads the rotated files too, by each line\'s time', async () => {
    write('server.log', [`[${at(1)}] [ERROR] [git-exec] git:command-failed {"args":"x"}`, '> npm banner']);
    write('server.log.1', [`[${at(30)}] [ERROR] [git-exec] git:command-failed`, `[${at(20)}] [ERROR] [git-exec] git:command-failed`]);
    const agg = await aggregateServerLog(listServerLogFiles(path.join(root, 'logs', 'server.log')), NOW);
    expect(agg.lines).toBe(2);
    expect(agg.errors).toEqual({ 'git-exec git:command-failed': 2 });
  });

  it('measures the three log metrics from one read; skips them without a log or 24 hours of lines', async () => {
    write('server.log', [
      `[${at(30)}] [INFO] [boot] ready`,
      `[${at(2)}] [WARN] [api/worktrees] list:slow {"totalMs":6000,"probeMs":5000,"worktreeId":"wt-secret"}`,
      `[${at(1)}] [ERROR] [git-exec] git:command-failed {"error":"/Users/someone/repo"}`,
    ]);
    const serverLog = path.join(root, 'logs', 'server.log');
    const results = await measureAll(ctx({ serverLog, now: NOW }), ['api-latency', 'log-volume', 'error-rate']);
    const byId = Object.fromEntries(results.map((r) => [r.metricId, r]));
    expect(byId['api-latency']).toMatchObject({ status: 'ok', value: 6000 });
    expect(byId['log-volume']).toMatchObject({ status: 'ok', value: 2 });
    expect(byId['error-rate']).toMatchObject({ status: 'ok', value: 1 });
    expect(JSON.stringify(results)).not.toMatch(/wt-secret|\/Users\//);

    const none = await measureAll(ctx({ serverLog: null, now: NOW }), ['log-volume']);
    expect(none[0]).toMatchObject({ status: 'skip', reason: '本番ログ（logs/server.log）が無い' });
    write('server.log', [`[${at(2)}] [INFO] [a] b`]);
    const short = await measureAll(ctx({ serverLog, now: NOW }), ['error-rate']);
    expect(short[0]).toMatchObject({ status: 'skip' });
  });

  it('server-process is skipped when the server is not running', async () => {
    write('server.log', []);
    const serverLog = path.join(root, 'logs', 'server.log');
    const noPid = await measureAll(ctx({ serverLog, apiUrl: null }), ['server-process']);
    expect(noPid[0]).toMatchObject({ status: 'skip', reason: 'server.pid が無い（サーバーが動いていない）' });
    // a pid that is not a node server.js process (this test's own runner is not one)
    fs.writeFileSync(path.join(root, 'logs', 'server.pid'), '999999999');
    const gone = await measureAll(ctx({ serverLog, apiUrl: null, sampleCount: 1, sampleIntervalMs: 0 }), ['server-process']);
    expect(gone[0]).toMatchObject({ status: 'skip' });
  });
});

describe('bug-flow (Issue #3185)', () => {
  const NOW = new Date('2026-10-04T00:00:00.000Z');
  const fakeGh = (script: string) => {
    const file = path.join(root, 'fake-gh');
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
  };

  it('a missing or failing gh is a skip, not a crash of the run', async () => {
    const missing = await measureAll(ctx({ now: NOW, ghCommand: 'cm-no-such-gh-3185' }), ['bug-flow']);
    expect(missing[0]).toMatchObject({ metricId: 'bug-flow', status: 'skip' });
    const failing = await measureAll(ctx({ now: NOW, ghCommand: fakeGh('echo "HTTP 401" >&2; exit 4') }), ['bug-flow']);
    expect(failing[0]).toMatchObject({ metricId: 'bug-flow', status: 'skip' });
    expect(failing[0].status === 'skip' && failing[0].reason).toContain('exit 4');
  });

  it('counts the Issues gh returns', async () => {
    const issues = [{ number: 1, body: '## 分類\n- 原因の PR: #9\n- 発見経路: uat\n- 影響する経路: chat\n', labels: [{ name: 'bug' }], createdAt: '2026-10-03T00:00:00Z' }];
    const file = path.join(root, 'issues.json');
    fs.writeFileSync(file, JSON.stringify(issues));
    const results = await measureAll(ctx({ now: NOW, ghCommand: fakeGh(`cat '${file}'`) }), ['bug-flow']);
    expect(results[0]).toMatchObject({ metricId: 'bug-flow', status: 'ok', value: 1, details: { regressionRate: 1 } });
  });
});
