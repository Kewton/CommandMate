/**
 * scripts/orchestrate/precheck.mjs — the fast check before a PR (Issue #3477).
 *
 * `git`, `npx` and `node` are replaced by a fake; the run record and the test
 * tree for findTestsNaming are under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords } from '../../../../scripts/orchestrate/run-log.mjs';
import {
  ALWAYS_TESTS,
  STEPS,
  countRemovedTests,
  findTestsNaming,
  main,
  parseNote,
  passedGates,
  planSteps,
} from '../../../../scripts/orchestrate/precheck.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

let tmp: string;
let runDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-precheck-'));
  runDir = path.join(tmp, 'runs', '2026-10-09');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Call = { command: string; args: string[] };

/** A fake for git and the checks. `fail` names the checks (by the command's first args) that exit 1. */
function harness({
  head = HEAD_A,
  changed = ['scripts/orchestrate/precheck.mjs', 'tests/unit/scripts/orchestrate/precheck.test.ts'],
  deleted = [] as string[],
  status = '',
  testsDiff = '',
  fail = [] as string[],
  naming = [] as string[],
} = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    run: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === 'git') {
        const sub = args.slice(2);
        if (sub[0] === 'rev-parse') return { status: 0, stdout: `${head}\n`, stderr: '' };
        if (sub[0] === 'status') return { status: 0, stdout: status, stderr: '' };
        if (sub.includes('--diff-filter=ACMR')) return { status: 0, stdout: changed.join('\n'), stderr: '' };
        if (sub.includes('--diff-filter=D')) return { status: 0, stdout: deleted.join('\n'), stderr: '' };
        if (sub.includes('--unified=0')) return { status: 0, stdout: testsDiff, stderr: '' };
        throw new Error(`unexpected git ${sub.join(' ')}`);
      }
      const name = `${command} ${args.slice(0, 2).join(' ')}`;
      const failed = fail.some((f) => name.includes(f));
      return { status: failed ? 1 : 0, stdout: `${name} output\n`, stderr: '' };
    },
    findTestsNaming: () => naming,
    now: () => new Date(Date.UTC(2026, 9, 9, 2, 0)),
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  };
  const checks = () => calls.filter((c) => c.command !== 'git');
  return { deps, calls, checks, out, err };
}

const argv = (...extra: string[]) => ['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', '/wt', ...extra];

describe('planSteps', () => {
  const base = 'origin/develop';

  it('lints only the changed code, and tests the changed tests, the tests naming a changed path, the guards and docs', () => {
    const plan = planSteps(
      { changed: ['src/lib/a.ts', 'docs/x.md', 'tests/unit/a.test.ts', 'tests/integration/b.test.ts'], deleted: [] },
      { base, namingTests: ['tests/unit/docs-x.test.ts', 'tests/unit/a.test.ts'] }
    );
    expect(plan.eslint.command).toEqual(['npx', ['eslint', 'src/lib/a.ts', 'tests/unit/a.test.ts', 'tests/integration/b.test.ts']]);
    expect(plan.related.command).toEqual(['npx', ['vitest', 'related', '--run', '--passWithNoTests', 'src/lib/a.ts']]);
    expect(plan.tests.command).toEqual([
      'npx',
      ['vitest', 'run', 'tests/unit/a.test.ts', 'tests/unit/docs-x.test.ts', ...ALWAYS_TESTS],
    ]);
    expect(ALWAYS_TESTS).toContain('tests/unit/guards');
    expect(plan.tsc.command).toEqual(['npx', ['tsc', '--noEmit']]);
    expect(plan.changelog.command).toEqual(['node', ['scripts/changelog-fragments.mjs', 'check']]);
  });

  it('skips ESLint and related when no code changed', () => {
    const plan = planSteps({ changed: ['.claude/commands/orchestrate.md'], deleted: [] }, { base });
    expect(plan.eslint.command).toBeNull();
    expect(plan.related.command).toBeNull();
    expect(plan.tests.command).not.toBeNull();
  });

  it('runs lint-sh only when a .sh changed — deleted ones count (#3478)', () => {
    expect(planSteps({ changed: ['src/a.ts'], deleted: [] }, { base })['lint-sh'].command).toBeNull();
    for (const changes of [
      { changed: ['scripts/x.sh'], deleted: [] },
      { changed: [], deleted: ['scripts/x.sh'] },
    ]) {
      expect(planSteps(changes, { base })['lint-sh'].command).toEqual([
        'node',
        ['scripts/run-lint-sh-if-changed.mjs', '--base', base],
      ]);
    }
  });

  it('counts suppressions for refactor and metrics Issues only (#3483)', () => {
    const changes = { changed: ['src/a.ts'], deleted: [] };
    const command = ['node', ['scripts/count-suppressions.mjs', '--base', base]];
    expect(planSteps(changes, { base, kind: 'refactor' }).suppressions.command).toEqual(command);
    expect(planSteps(changes, { base, kind: 'feature', metrics: true }).suppressions.command).toEqual(command);
    expect(planSteps(changes, { base, kind: 'feature' }).suppressions.command).toBeNull();
    expect(planSteps(changes, { base }).suppressions.command).toBeNull();
  });

  it('plans every step in STEPS', () => {
    expect(Object.keys(planSteps({ changed: [], deleted: [] }, { base })).sort()).toEqual([...STEPS].sort());
  });
});

describe('countRemovedTests', () => {
  it('counts removed it / test / describe lines', () => {
    const diff = [
      '--- a/tests/unit/a.test.ts',
      '+++ b/tests/unit/a.test.ts',
      "-  it('keeps the old behaviour', () => {",
      "-describe('group', () => {",
      "-  it.each([1, 2])('case %i', (n) => {",
      '-  const x = 1;',
    ].join('\n');
    expect(countRemovedTests(diff)).toEqual([
      "it('keeps the old behaviour', () => {",
      "describe('group', () => {",
      "it.each([1, 2])('case %i', (n) => {",
    ]);
  });

  it('does not count a test moved verbatim, and counts a renamed one', () => {
    const diff = [
      "-  it('moved', () => {",
      "+    it('moved', () => {",
      "-  it('old name', () => {",
      "+  it('new name', () => {",
    ].join('\n');
    expect(countRemovedTests(diff)).toEqual(["it('old name', () => {"]);
  });

  it('counts nothing for an added test', () => {
    expect(countRemovedTests("+  it('new', () => {")).toEqual([]);
  });
});

describe('findTestsNaming', () => {
  it('finds the unit tests whose text names a changed path', () => {
    const unit = path.join(tmp, 'wt', 'tests', 'unit', 'tasks');
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(path.join(unit, 'a.test.ts'), "readFileSync('.claude/commands/orchestrate.md')");
    fs.writeFileSync(path.join(unit, 'b.test.ts'), "readFileSync('docs/other.md')");
    fs.writeFileSync(path.join(unit, 'helper.ts'), "'.claude/commands/orchestrate.md'");
    expect(findTestsNaming(path.join(tmp, 'wt'), ['.claude/commands/orchestrate.md'])).toEqual(['tests/unit/tasks/a.test.ts']);
    expect(findTestsNaming(path.join(tmp, 'wt'), [])).toEqual([]);
  });
});

describe('notes', () => {
  it('parses step=status pairs', () => {
    expect(parseNote('changelog=ok removed-tests=fail eslint=skip')).toEqual({ changelog: 'ok', 'removed-tests': 'fail', eslint: 'skip' });
  });

  it('reads the gates a passed verify record lists, and none from a failed one', () => {
    expect(passedGates({ result: 'ok', note: 'exit=0(passed) result=passed basis=hook_stop passed=lint,typecheck failed=-' })).toEqual(['lint', 'typecheck']);
    expect(passedGates({ result: 'fail', note: 'passed=lint failed=scope:FAIL' })).toEqual([]);
    expect(passedGates(null)).toEqual([]);
  });
});

describe('main: run and record', () => {
  it('runs the planned checks in the worktree and records precheck=ok with the HEAD', () => {
    const h = harness();
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.checks().map((c) => `${c.command} ${c.args[0]} ${c.args[1] ?? ''}`.trim())).toEqual([
      'node scripts/changelog-fragments.mjs check',
      'npx eslint scripts/orchestrate/precheck.mjs',
      'npx tsc --noEmit',
      'npx vitest related',
      'npx vitest run',
    ]);
    const { records } = readRecords(runDir, '3477');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ issue: 3477, stage: 'precheck', result: 'ok', head: HEAD_A });
    expect(parseNote(records[0].note)).toEqual({
      changelog: 'ok',
      'removed-tests': 'ok',
      eslint: 'ok',
      'lint-sh': 'skip',
      suppressions: 'skip',
      tsc: 'ok',
      related: 'ok',
      tests: 'ok',
    });
    expect(fs.existsSync(path.join(runDir, 'precheck-3477-aaaaaaa.log'))).toBe(true);
  });

  it('runs every check even after one fails, and records fail', () => {
    const h = harness({ fail: ['tsc'] });
    expect(main(argv(), h.deps)).toBe(1);
    expect(h.checks().map((c) => c.args[0])).toContain('vitest');
    const [record] = readRecords(runDir, '3477').records;
    expect(record.result).toBe('fail');
    expect(parseNote(record.note).tsc).toBe('fail');
  });

  it('fails on a removed test unless --allow-removed-tests', () => {
    const testsDiff = "-  it('was here', () => {\n";
    expect(main(argv(), harness({ testsDiff }).deps)).toBe(1);
    expect(main(argv('--allow-removed-tests', '--force'), harness({ testsDiff }).deps)).toBe(0);
    expect(fs.readFileSync(path.join(runDir, 'precheck-3477-aaaaaaa.log'), 'utf8')).toContain("it('was here', () => {");
  });

  it('refuses a dirty tree (exit 2) but ignores the contract and dev-reports', () => {
    const dirty = harness({ status: ' M src/a.ts\n?? .commandmate/tasks/issue-3477.yaml\n' });
    expect(main(argv(), dirty.deps)).toBe(2);
    expect(dirty.err.join('\n')).toMatch(/uncommitted changes .*\n {2}src\/a\.ts$/);
    expect(dirty.checks()).toEqual([]);
    expect(readRecords(runDir, '3477').records).toEqual([]);

    const clean = harness({ status: '?? .commandmate/tasks/issue-3477.yaml\n?? dev-reports/module-reference/issue-3477.md\n' });
    expect(main(argv(), clean.deps)).toBe(0);
  });

  it('exits 2 on a usage error', () => {
    const h = harness();
    expect(main(['--issues', '3477'], h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  });
});

describe('main: the same HEAD is not checked twice', () => {
  it('reuses an ok precheck for the same HEAD without running anything', () => {
    expect(main(argv(), harness().deps)).toBe(0);
    const again = harness();
    expect(main(argv(), again.deps)).toBe(0);
    expect(again.checks()).toEqual([]);
    expect(again.out.join('\n')).toMatch(/reused: ok at aaaaaaa/);
    expect(readRecords(runDir, '3477').records).toHaveLength(1);
  });

  it('runs again for a new HEAD', () => {
    main(argv(), harness().deps);
    const moved = harness({ head: HEAD_B });
    main(argv(), moved.deps);
    expect(moved.checks().length).toBeGreaterThan(0);
    expect(readRecords(runDir, '3477').records.map((r: { head: string }) => r.head)).toEqual([HEAD_A, HEAD_B]);
  });

  it('runs again after a fail on the same HEAD', () => {
    main(argv(), harness({ fail: ['eslint'] }).deps);
    const again = harness();
    expect(main(argv(), again.deps)).toBe(0);
    expect(again.checks().length).toBeGreaterThan(0);
  });

  it('runs again when the ok record lacks a step this run needs (refactor adds suppressions)', () => {
    main(argv(), harness().deps);
    const refactor = harness();
    expect(main(argv('--kind', 'refactor'), refactor.deps)).toBe(0);
    expect(refactor.checks().map((c) => c.args[0])).toContain('scripts/count-suppressions.mjs');
  });

  it('runs again with --force', () => {
    main(argv(), harness().deps);
    const forced = harness();
    main(argv('--force'), forced.deps);
    expect(forced.checks().length).toBeGreaterThan(0);
  });

  it('does not repeat what verify already passed on the same HEAD', () => {
    appendRecord(runDir, '3477', {
      issue: 3477,
      stage: 'verify',
      result: 'ok',
      head: HEAD_A,
      note: 'exit=0(passed) result=passed basis=hook_stop passed=work-evidence,scope,lint,typecheck,unit-related failed=-',
    });
    const h = harness();
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.checks().map((c) => c.args[0])).toEqual(['scripts/changelog-fragments.mjs']);
    expect(h.out.join('\n')).toMatch(/tsc ok \(verify passed typecheck at aaaaaaa\)/);
  });

  it('repeats them when verify passed on another HEAD', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_B, note: 'passed=lint,typecheck,unit' });
    const h = harness();
    main(argv(), h.deps);
    expect(h.checks().map((c) => c.args[0])).toContain('tsc');
  });
});
