/**
 * scripts/orchestrate/precheck.mjs — a wide test step runs under the
 * machine-wide `cpu.heavy` lock, a narrow one does not (Issue #3884 H-10),
 * and the record keeps the lock wait apart from the execution.
 *
 * `git` and the checks are replaced by a fake, as precheck.test.ts does it;
 * the lock and the test trees are under os.tmpdir().
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRecords } from '../../../../scripts/orchestrate/run-log.mjs';
import {
  ALWAYS_TESTS,
  HEAVY_LOCK_TIMEOUT_SEC,
  HEAVY_MUTEX,
  HEAVY_RELATED_SOURCES,
  HEAVY_TEST_FILES,
  acquireMachineLockSync,
  estimateRelatedTests,
  machineLockRoot,
  main,
  planSteps,
} from '../../../../scripts/orchestrate/precheck.mjs';
import { UNIT_RELATED_GATE } from '../../../../scripts/orchestrate/contract.mjs';
import { acquireMachineLock, machineLockPath } from '@/lib/verification/machine-lock';

const HEAD_A = 'a'.repeat(40);
const base = 'origin/develop';

let tmp: string;
let runDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-precheck-heavy-3884-'));
  runDir = path.join(tmp, 'runs', '2026-10-25');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const manyTests = (n: number) => Array.from({ length: n }, (_, i) => `tests/unit/many/t${i}.test.ts`);

describe('planSteps: which test steps are heavy', () => {
  it('never makes the guards and docs alone heavy', () => {
    // Negative control: the step every precheck runs keeps running unlocked.
    const plan = planSteps({ changed: ['docs/x.md'], deleted: [] }, { base });
    expect(plan.tests.command).toEqual(['npx', ['vitest', 'run', ...ALWAYS_TESTS]]);
    expect(plan.tests.heavy).toBe(false);
    expect(plan.related.command).toBeNull();
  });

  it('makes the test step heavy from HEAVY_TEST_FILES explicit test files on', () => {
    const below = planSteps({ changed: [], deleted: [] }, { base, namingTests: manyTests(HEAVY_TEST_FILES - 1) });
    const at = planSteps({ changed: [], deleted: [] }, { base, namingTests: manyTests(HEAVY_TEST_FILES) });
    expect(below.tests.heavy).toBe(false);
    expect(at.tests.heavy).toBe(true);
    // The command is the same either way: the lock decides when it runs, not what.
    expect(at.tests.command?.[1].slice(-ALWAYS_TESTS.length)).toEqual(ALWAYS_TESTS);
  });

  it('makes related heavy by the estimate, or by the number of changed sources', () => {
    const one = { changed: ['src/lib/a.ts'], deleted: [] };
    expect(planSteps(one, { base, relatedTests: HEAVY_TEST_FILES - 1 }).related.heavy).toBe(false);
    expect(planSteps(one, { base, relatedTests: HEAVY_TEST_FILES }).related.heavy).toBe(true);
    const wide = { changed: Array.from({ length: HEAVY_RELATED_SOURCES }, (_, i) => `src/lib/m${i}.ts`), deleted: [] };
    expect(planSteps(wide, { base, relatedTests: 0 }).related.heavy).toBe(true);
  });

  it('takes the same lock the unit-related gate declares', () => {
    expect(HEAVY_MUTEX).toBe(UNIT_RELATED_GATE.mutex);
    expect(HEAVY_LOCK_TIMEOUT_SEC).toBe(UNIT_RELATED_GATE.timeoutSec);
  });
});

describe('estimateRelatedTests', () => {
  function write(rel: string, text: string) {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  it('counts the unit tests naming a source by import specifier or path, as whole module names', () => {
    write('tests/unit/a.test.ts', "import { x } from '@/lib/db';\n");
    write('tests/unit/b.test.ts', "import { y } from '@/lib/db/db-instance';\n");
    write('tests/unit/c.test.ts', "import { z } from '@/lib/dbx';\n");
    write('tests/unit/d.test.ts', "import { w } from '../../scripts/orchestrate/precheck.mjs';\n");
    write('tests/unit/e.test.ts', "const f = 'src/lib/db/index.ts';\n");
    write('tests/unit/helper.ts', "import { x } from '@/lib/db';\n");

    // index.ts is imported by its directory; db-instance and dbx are other modules.
    expect(estimateRelatedTests(tmp, ['src/lib/db/index.ts'])).toBe(2);
    expect(estimateRelatedTests(tmp, ['src/lib/db/db-instance.ts'])).toBe(1);
    expect(estimateRelatedTests(tmp, ['scripts/orchestrate/precheck.mjs'])).toBe(1);
    expect(estimateRelatedTests(tmp, [])).toBe(0);
    expect(estimateRelatedTests(path.join(tmp, 'absent'), ['src/lib/db/index.ts'])).toBe(0);
  });
});

/** git and the checks, faked; `naming` is what findTestsNaming answers. */
function harness({ naming = [] as string[], changed = ['scripts/orchestrate/precheck.mjs'], lockWaitMs = 0, acquired = true } = {}) {
  const events: string[] = [];
  const deps = {
    run: (command: string, args: string[]) => {
      if (command === 'git') {
        const sub = args.slice(2);
        if (sub[0] === 'rev-parse') return { status: 0, stdout: `${HEAD_A}\n`, stderr: '' };
        if (sub[0] === 'status') return { status: 0, stdout: '', stderr: '' };
        if (sub.includes('--diff-filter=ACMR')) return { status: 0, stdout: changed.join('\n'), stderr: '' };
        if (sub.includes('--diff-filter=D')) return { status: 0, stdout: '', stderr: '' };
        if (sub.includes('--unified=0')) return { status: 0, stdout: '', stderr: '' };
        if (sub[0] === 'log' && sub.includes('--first-parent')) return { status: 0, stdout: `${HEAD_A} ${'f'.repeat(40)}\n`, stderr: '' };
        if (sub[0] === 'diff-tree') return { status: 0, stdout: `${changed[0]}\n`, stderr: '' };
        throw new Error(`unexpected git ${sub.join(' ')}`);
      }
      events.push(`run ${command} ${args.slice(0, 2).join(' ')}`);
      return { status: 0, stdout: '', stderr: '' };
    },
    findTestsNaming: () => naming,
    estimateRelatedTests: () => 0,
    acquireHeavyLock: (timeoutMs: number) => {
      events.push(`lock ${timeoutMs}`);
      return {
        acquired,
        waitedMs: lockWaitMs,
        heldBy: acquired ? null : 'pid 1 on elsewhere',
        release: () => events.push('release'),
      };
    },
    home: tmp,
    now: () => new Date(Date.UTC(2026, 9, 25, 2, 0)),
    log: (line: string) => events.push(`log ${line}`),
    error: (line: string) => events.push(`error ${line}`),
  };
  return { deps, events };
}

const argv = () => ['--run-dir', runDir, '--issues', '3884', '--issue', '3884', '--worktree', '/wt'];

describe('main: the lock is taken around a heavy step only', () => {
  it('runs a narrow precheck without the lock, and records the split with no wait', () => {
    const h = harness();
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.events.filter((e) => e.startsWith('lock') || e === 'release')).toEqual([]);
    const [record] = readRecords(runDir, '3884').records;
    expect(record).toMatchObject({ stage: 'precheck', result: 'ok', mutexSec: 0 });
    expect(record.runSec).toBeGreaterThanOrEqual(0);
  });

  it('holds cpu.heavy for exactly the wide test step, and records the wait apart', () => {
    const h = harness({ naming: manyTests(HEAVY_TEST_FILES), lockWaitMs: 42_000 });
    expect(main(argv(), h.deps)).toBe(0);
    const around = h.events.filter((e) => e.startsWith('lock') || e === 'release' || e.startsWith('run npx vitest'));
    // related is narrow here (one source, no importers): it runs outside the lock.
    expect(around).toEqual([
      'run npx vitest related',
      `lock ${HEAVY_LOCK_TIMEOUT_SEC * 1000}`,
      'run npx vitest run',
      'release',
    ]);
    expect(h.events.some((e) => e.includes(`tests ok (exit 0,`) && e.includes(`waited ${HEAVY_MUTEX} 42.0s`))).toBe(true);
    const [record] = readRecords(runDir, '3884').records;
    expect(record).toMatchObject({ result: 'ok', mutexSec: 42 });
  });

  it('runs the step anyway when the lock stays held for the whole budget (no verdict turns on it)', () => {
    const h = harness({ naming: manyTests(HEAVY_TEST_FILES), lockWaitMs: 1000, acquired: false });
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.events).toContain('run npx vitest run');
    expect(h.events.some((e) => e.includes(`ran without ${HEAVY_MUTEX}: held by pid 1 on elsewhere`))).toBe(true);
    expect(readRecords(runDir, '3884').records[0].result).toBe('ok');
  });
});

describe('acquireMachineLockSync: the same lock as machine-lock.ts', () => {
  it('takes <root>/<name>.lock, makes a second taker wait out its budget, and releases', () => {
    const root = path.join(tmp, 'locks');
    const first = acquireMachineLockSync(HEAVY_MUTEX, { root, timeoutMs: 0 });
    expect(first.acquired).toBe(true);
    expect(fs.existsSync(machineLockPath(HEAVY_MUTEX, root))).toBe(true);

    let slept = 0;
    const second = acquireMachineLockSync(HEAVY_MUTEX, {
      root,
      timeoutMs: 1000,
      sleep: (ms: number) => {
        slept += ms;
        const until = Date.now() + ms;
        while (Date.now() < until) {
          /* the clock the budget is measured on */
        }
      },
    });
    expect(second.acquired).toBe(false);
    expect(second.heldBy).toMatch(/^pid \d+ on /);
    expect(slept).toBeGreaterThan(0);

    first.release();
    expect(fs.existsSync(machineLockPath(HEAVY_MUTEX, root))).toBe(false);
    const third = acquireMachineLockSync(HEAVY_MUTEX, { root, timeoutMs: 0 });
    expect(third.acquired).toBe(true);
    third.release();
  });

  it('waits for a lock the server runner holds, and the server runner waits for this one', async () => {
    const root = path.join(tmp, 'locks');
    const server = await acquireMachineLock(HEAVY_MUTEX, { root, timeoutMs: 0 });
    expect(server.acquired).toBe(true);
    expect(acquireMachineLockSync(HEAVY_MUTEX, { root, timeoutMs: 0 }).acquired).toBe(false);
    if (server.acquired) server.handle.release();

    const mine = acquireMachineLockSync(HEAVY_MUTEX, { root, timeoutMs: 0 });
    expect(mine.acquired).toBe(true);
    expect((await acquireMachineLock(HEAVY_MUTEX, { root, timeoutMs: 0 })).acquired).toBe(false);
    mine.release();
  });

  it('breaks a lock whose recorded holder on this host is gone', () => {
    const root = path.join(tmp, 'locks');
    const lockPath = machineLockPath(HEAVY_MUTEX, root);
    // A pid that existed and has exited.
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, 'owner'),
      JSON.stringify({ pid: Number(gone.stdout), host: os.hostname(), token: 'stale', acquiredAt: 0 })
    );
    const taken = acquireMachineLockSync(HEAVY_MUTEX, { root, timeoutMs: 0 });
    expect(taken.acquired).toBe(true);
    taken.release();
  });

  it('resolves the root the way machine-lock.ts does', () => {
    expect(machineLockRoot('/home/x', {})).toBe(path.join('/home/x', '.commandmate', 'locks'));
    expect(machineLockRoot('/home/x', { CM_VERIFY_LOCK_ROOT: '/elsewhere' })).toBe('/elsewhere');
  });
});
