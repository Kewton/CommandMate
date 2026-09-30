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
