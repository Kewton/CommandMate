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
  EXIT_HELD,
  HELD,
  HEAVY_LOCK_TIMEOUT_SEC,
  HEAVY_MUTEX,
  HEAVY_RELATED_SOURCES,
  HEAVY_TEST_FILES,
  acquireMachineLockSync,
  estimateRelatedTests,
  machineLockRoot,
  main,
  parseNote,
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

  it('counts the tests reaching a source through another module, as vitest related does (N2)', () => {
    // src/lib/env.ts -> src/lib/logger.ts -> HEAVY_TEST_FILES tests: only one test names env.ts.
    write('src/lib/env.ts', 'export const env = {};\n');
    write('src/lib/logger.ts', "import { env } from './env';\nexport const logger = env;\n");
    write('src/lib/session/run.ts', "export { logger } from '@/lib/logger';\n");
    for (let i = 0; i < HEAVY_TEST_FILES; i++) {
      // Some through logger directly, some one module further, by alias or relative path.
      const spec = i % 3 === 0 ? '@/lib/session/run' : i % 3 === 1 ? '@/lib/logger' : '../../../src/lib/logger.js';
      write(`tests/unit/many/t${i}.test.ts`, `import { logger } from '${spec}';\n`);
    }
    write('tests/unit/env.test.ts', "import { env } from '@/lib/env';\n");
    write('tests/unit/other.test.ts', "import { other } from '@/lib/other';\n");
    write('src/lib/other.ts', 'export const other = 1;\n');

    const count = estimateRelatedTests(tmp, ['src/lib/env.ts']);
    expect(count).toBe(HEAVY_TEST_FILES + 1);
    expect(planSteps({ changed: ['src/lib/env.ts'], deleted: [] }, { base, relatedTests: count }).related.heavy).toBe(true);
  });

  it('does not follow type-only references, which the transform erases (N5)', () => {
    // src/lib/types.ts: read as types by many modules and tests, at run time by two.
    write('src/lib/types.ts', 'export interface T { a: number }\nexport const KIND = 1;\n');
    write('src/lib/a.ts', "import type { T } from './types';\nexport const a = (t: T) => t;\n");
    write('src/lib/b.ts', "import { type T } from '@/lib/types';\nexport type { T } from './types';\nexport const b = 1;\n");
    write('src/lib/c.ts', "export type { T } from './types';\nimport type * as all from './types';\nexport const c = 1;\n");
    write('src/lib/runtime.ts', "import { type T, KIND } from './types';\nexport const r: T = { a: KIND };\n");
    for (let i = 0; i < HEAVY_TEST_FILES; i++) {
      const module = ['a', 'b', 'c'][i % 3];
      write(`tests/unit/many/t${i}.test.ts`, `import { ${module} } from '@/lib/${module}';\n`);
    }
    write('tests/unit/runtime.test.ts', "import { r } from '@/lib/runtime';\n");
    write('tests/unit/kind.test.ts', "import { KIND } from '../../src/lib/types';\n");

    const count = estimateRelatedTests(tmp, ['src/lib/types.ts']);
    // runtime.test (through the mixed import) and kind.test (a value import).
    expect(count).toBe(2);
    expect(planSteps({ changed: ['src/lib/types.ts'], deleted: [] }, { base, relatedTests: count }).related.heavy).toBe(false);
  });

  it('stays heavy for a source with HEAVY_TEST_FILES runtime readers, type imports beside them', () => {
    write('src/lib/types.ts', 'export const KIND = 1;\n');
    write('src/lib/mixed.ts', "import { type T, KIND } from './types';\nimport type { U } from './types';\nexport const m = KIND;\n");
    write('src/lib/default.ts', "import KIND_DEFAULT, { type T } from './types';\nexport const d = KIND_DEFAULT;\n");
    for (let i = 0; i < HEAVY_TEST_FILES; i++) {
      write(`tests/unit/many/t${i}.test.ts`, `import { x } from '@/lib/${i % 2 === 0 ? 'mixed' : 'default'}';\n`);
    }

    const count = estimateRelatedTests(tmp, ['src/lib/types.ts']);
    expect(count).toBe(HEAVY_TEST_FILES);
    expect(planSteps({ changed: ['src/lib/types.ts'], deleted: [] }, { base, relatedTests: count }).related.heavy).toBe(true);
  });

  it.each([
    ['import { type as value }', "import { type as value } from './source';\nexport const m = value;\n"],
    ['export { type as value }', "export { type as value } from './source';\n"],
    ['import type /* comment */ from', "import type /* the default export */ from './source';\nexport const m = type;\n"],
  ])('follows %s, which binds a value named type, to the tests behind it (N6)', (_form, middle) => {
    write('src/lib/source.ts', 'const type = 1;\nexport { type };\nexport default type;\n');
    write('src/lib/middle.ts', middle);
    for (let i = 0; i < HEAVY_TEST_FILES; i++) write(`tests/unit/many/t${i}.test.ts`, "import { m } from '@/lib/middle';\n");

    const count = estimateRelatedTests(tmp, ['src/lib/source.ts']);
    expect(count).toBe(HEAVY_TEST_FILES);
    expect(planSteps({ changed: ['src/lib/source.ts'], deleted: [] }, { base, relatedTests: count }).related.heavy).toBe(true);
  });

  it('keeps a truly narrow source narrow, a cycle and a helper included (negative control)', () => {
    write('src/lib/leaf.ts', "import { b } from './cycle-b';\nexport const leaf = b;\n");
    write('src/lib/cycle-b.ts', "import { leaf } from './leaf';\nexport const b = 1;\nexport const c = leaf;\n");
    write('tests/helpers/leaf-helper.ts', "export { leaf } from '@/lib/leaf';\n");
    write('tests/unit/leaf.test.ts', "import { leaf } from '@tests/helpers/leaf-helper';\n");
    write('tests/unit/cycle.test.ts', "vi.mock('@/lib/cycle-b');\n");
    write('tests/unit/pkg.test.ts', "import { describe } from 'vitest';\n");
    for (let i = 0; i < HEAVY_TEST_FILES; i++) write(`tests/unit/many/t${i}.test.ts`, "import { x } from '@/lib/unrelated';\n");

    const count = estimateRelatedTests(tmp, ['src/lib/leaf.ts']);
    expect(count).toBe(2);
    expect(planSteps({ changed: ['src/lib/leaf.ts'], deleted: [] }, { base, relatedTests: count }).related.heavy).toBe(false);
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

  it('leaves the step unrun and the precheck undecided when the lock stays held for the whole budget (N1)', () => {
    const h = harness({ naming: manyTests(HEAVY_TEST_FILES), lockWaitMs: 1000, acquired: false });
    // Neither ok (0) nor a failed step (1): a held precheck is to be run again.
    expect(main(argv(), h.deps)).toBe(EXIT_HELD);
    expect(h.events).not.toContain('run npx vitest run');
    expect(h.events.some((e) => e.includes(`tests ${HELD} (not run: ${HEAVY_MUTEX} held by pid 1 on elsewhere`))).toBe(true);
    const [record] = readRecords(runDir, '3884').records;
    expect(record).toMatchObject({ stage: 'precheck', result: 'skip', mutexSec: 1 });
    expect(parseNote(record.note).tests).toBe(HELD);
    // The narrow related step still ran, outside the lock, and passed.
    expect(parseNote(record.note).related).toBe('ok');
  });

  it('does not wait again for the second heavy step once the first was held', () => {
    const h = harness({ naming: manyTests(HEAVY_TEST_FILES), acquired: false, lockWaitMs: 5 });
    h.deps.estimateRelatedTests = () => HEAVY_TEST_FILES;
    expect(main(argv(), h.deps)).toBe(EXIT_HELD);
    expect(h.events.filter((e) => e.startsWith('lock'))).toHaveLength(1);
    expect(h.events.filter((e) => e.startsWith('run npx vitest'))).toEqual([]);
    const note = parseNote(readRecords(runDir, '3884').records[0].note);
    expect(note).toMatchObject({ related: HELD, tests: HELD });
  });

  it('still reports a failed step as a failure when another step was held', () => {
    const h = harness({ naming: manyTests(HEAVY_TEST_FILES), acquired: false });
    const run = h.deps.run;
    h.deps.run = (command: string, args: string[]) =>
      command === 'npx' && args[0] === 'tsc' ? { status: 2, stdout: '', stderr: 'TS2322' } : run(command, args);
    expect(main(argv(), h.deps)).toBe(1);
    expect(readRecords(runDir, '3884').records[0].result).toBe('fail');
  });

  it('does not reuse a held precheck: the next run on the same HEAD runs again', () => {
    const held = harness({ naming: manyTests(HEAVY_TEST_FILES), acquired: false });
    expect(main(argv(), held.deps)).toBe(EXIT_HELD);
    const free = harness({ naming: manyTests(HEAVY_TEST_FILES) });
    expect(main(argv(), free.deps)).toBe(0);
    expect(free.events).toContain('run npx vitest run');
    expect(readRecords(runDir, '3884').records.map((r: { result: string }) => r.result)).toEqual(['skip', 'ok']);
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
