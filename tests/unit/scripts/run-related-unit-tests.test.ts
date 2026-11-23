/**
 * Tests for scripts/run-related-unit-tests.mjs (Issue #2639).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  collectChangedFiles,
  classifyChanges,
  collectRelatedSet,
  findTextScanTests,
  main,
} from '../../../scripts/run-related-unit-tests.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';

/** One group launch as `main()` hands it to its `runGroup` dependency (Issue #4577). */
interface GroupCall {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logPath: string;
}

/** The files a group was handed: everything after `run` up to the first flag. */
function handedFiles(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args.slice(1)) {
    if (a.startsWith('--')) break;
    out.push(a);
  }
  return out;
}

/**
 * A `runGroup` double: records the call, writes the json report vitest would
 * write for the files it was handed, and fails the group (exit 1, the file's
 * test marked failed) when it holds any file in `failing`.
 */
function groupDouble(root: string, calls: GroupCall[], failing: string[] = []) {
  return async (call: GroupCall) => {
    calls.push(call);
    const files = handedFiles(call.args);
    const flag = call.args.find((a) => a.startsWith('--outputFile.json='));
    if (flag) {
      const testResults = files.map((f) => ({
        name: path.join(root, f),
        status: failing.includes(f) ? 'failed' : 'passed',
        assertionResults: [{ fullName: `case of ${f}`, status: failing.includes(f) ? 'failed' : 'passed' }],
      }));
      fs.writeFileSync(flag.slice('--outputFile.json='.length), JSON.stringify({ testResults }));
    }
    fs.writeFileSync(call.logPath, '');
    return { code: files.some((f) => failing.includes(f)) ? 1 : 0, signal: null };
  };
}

/**
 * The vitest Node API as `collectRelatedSet` drives it, faked: records the
 * options and filters it was given and answers with `answer` (paths under root).
 */
function fakeVitest(root: string, answer: string[]) {
  const seen: { options: Record<string, unknown> | null; filters: string[] | null; loaded: number } = {
    options: null,
    filters: null,
    loaded: 0,
  };
  const loadVitest = async () => {
    seen.loaded++;
    return {
      createVitest: async (_mode: string, options: Record<string, unknown>) => {
        seen.options = options;
        return {
          getRelevantTestSpecifications: async (filters: string[]) => {
            seen.filters = filters;
            return answer.map((f) => ({ moduleId: path.join(root, f) }));
          },
          close: async () => undefined,
        };
      },
    };
  };
  const collectSet = (o: { root: string; mode: 'related' | 'full'; mergeBase: string; traced: string[] }) =>
    collectRelatedSet({ ...o, loadVitest });
  return { seen, collectSet };
}

/** Each test's group TMPDIRs go under os.tmpdir() (main removes them). */
const TMP_BASE = path.join(os.tmpdir(), 'cm-4577-main-');

/** `[cmd, ...args]` of every group, the report flags dropped. */
function argvOf(calls: GroupCall[]): string[][] {
  return calls.map((c) => [c.cmd, ...c.args.filter((a) => !a.startsWith('--reporter') && !a.startsWith('--outputFile'))]);
}

describe('classifyChanges', () => {
  it('classifies src/x.tsx alone as related', () => {
    const result = classifyChanges(['src/x.tsx']);
    expect(result).toEqual({
      mode: 'related',
      reason: null,
      considered: ['src/x.tsx'],
    });
  });

  it('classifies tests/unit/x.test.tsx and tests/helpers/y.ts as related', () => {
    const result = classifyChanges(['tests/helpers/y.ts', 'tests/unit/x.test.tsx']);
    expect(result).toEqual({
      mode: 'related',
      reason: null,
      considered: ['tests/helpers/y.ts', 'tests/unit/x.test.tsx'],
    });
  });

  it('classifies CHANGELOG.md and docs/module-reference.md alone as none', () => {
    const result = classifyChanges(['CHANGELOG.md', 'docs/module-reference.md']);
    expect(result).toEqual({
      mode: 'none',
      reason: null,
      considered: [],
    });
  });

  it('classifies .commandmate/tasks/1.yaml and dev-reports/changelog/1.md alone as none', () => {
    const result = classifyChanges([
      '.commandmate/tasks/1.yaml',
      'dev-reports/changelog/1.md',
    ]);
    expect(result).toEqual({
      mode: 'none',
      reason: null,
      considered: [],
    });
  });

  it('classifies src/lib/foo.ts and changelog.d/2865.md as related', () => {
    const result = classifyChanges(['src/lib/foo.ts', 'changelog.d/2865.md']);
    expect(result).toEqual({
      mode: 'related',
      reason: null,
      considered: ['src/lib/foo.ts'],
    });
  });

  it('classifies changelog.d/2865.md alone as none', () => {
    const result = classifyChanges(['changelog.d/2865.md']);
    expect(result).toEqual({
      mode: 'none',
      reason: null,
      considered: [],
    });
  });

  it('classifies changelog.d/2865.md and locales/ja/worktree.json as full with locales reason', () => {
    const result = classifyChanges([
      'changelog.d/2865.md',
      'locales/ja/worktree.json',
    ]);
    expect(result).toEqual({
      mode: 'full',
      reason: 'locales/ja/worktree.json',
      considered: ['locales/ja/worktree.json'],
    });
  });

  it('classifies src/a.ts and locales/ja/worktree.json as full with reason', () => {
    const result = classifyChanges(['locales/ja/worktree.json', 'src/a.ts']);
    expect(result).toEqual({
      mode: 'full',
      reason: 'locales/ja/worktree.json',
      considered: ['locales/ja/worktree.json', 'src/a.ts'],
    });
  });

  it('classifies fixture .txt as full', () => {
    const result = classifyChanges(['tests/fixtures/sample.txt']);
    expect(result).toEqual({
      mode: 'full',
      reason: 'tests/fixtures/sample.txt',
      considered: ['tests/fixtures/sample.txt'],
    });
  });

  it('classifies vitest.config.ts as full', () => {
    const result = classifyChanges(['vitest.config.ts']);
    expect(result).toEqual({
      mode: 'full',
      reason: 'vitest.config.ts',
      considered: ['vitest.config.ts'],
    });
  });

  it('classifies src/app/globals.css as full', () => {
    const result = classifyChanges(['src/app/globals.css']);
    expect(result).toEqual({
      mode: 'full',
      reason: 'src/app/globals.css',
      considered: ['src/app/globals.css'],
    });
  });
});

describe('collectChangedFiles', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-git-'));
    execFileSync('git', ['init'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo });

    fs.writeFileSync(path.join(tmpRepo, 'initial.txt'), 'base');
    execFileSync('git', ['add', 'initial.txt'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpRepo });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: tmpRepo });
  });

  afterEach(() => {
    removeTempDir(tmpRepo);
  });

  it('collects committed, uncommitted, and untracked files', () => {
    // 1. Committed file after base
    fs.writeFileSync(path.join(tmpRepo, 'committed.ts'), 'export const a = 1;');
    execFileSync('git', ['add', 'committed.ts'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'add committed.ts'], { cwd: tmpRepo });

    // 2. Uncommitted tracked file
    fs.writeFileSync(path.join(tmpRepo, 'initial.txt'), 'modified base');

    // 3. Untracked file
    fs.writeFileSync(path.join(tmpRepo, 'untracked.ts'), 'export const b = 2;');

    const { mergeBase, files } = collectChangedFiles({ cwd: tmpRepo, base: 'main~1' });
    expect(mergeBase).toBeTruthy();
    expect(files).toEqual(['committed.ts', 'initial.txt', 'untracked.ts']);
  });

  it('throws when base ref does not exist', () => {
    expect(() => {
      collectChangedFiles({ cwd: tmpRepo, base: 'non-existent-base-ref' });
    }).toThrow(/collectChangedFiles failed/);
  });
});

describe('findTextScanTests', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-scan-'));
    fs.mkdirSync(path.join(tmpRoot, 'tests', 'unit'), { recursive: true });
  });

  afterEach(() => {
    removeTempDir(tmpRoot);
  });

  it('returns only test files matching both regex A and regex B', () => {
    // Both A and B
    const matchFile = path.join(tmpRoot, 'tests', 'unit', 'match.test.ts');
    fs.writeFileSync(
      matchFile,
      `import fs from 'fs';
       const content = fs.readFileSync('src/index.ts', 'utf-8');`
    );

    // Only A
    const onlyAFile = path.join(tmpRoot, 'tests', 'unit', 'only-a.test.ts');
    fs.writeFileSync(
      onlyAFile,
      `import fs from 'fs';
       const content = fs.readFileSync('/tmp/foo.txt', 'utf-8');`
    );

    // Only B
    const onlyBFile = path.join(tmpRoot, 'tests', 'unit', 'only-b.test.ts');
    fs.writeFileSync(
      onlyBFile,
      `const p = 'src/index.ts';
       console.log(p);`
    );

    // Both A and B, but not a test file
    const helperFile = path.join(tmpRoot, 'tests', 'unit', 'helper.ts');
    fs.writeFileSync(
      helperFile,
      `import fs from 'fs';
       const content = fs.readFileSync('src/index.ts', 'utf-8');`
    );

    const results = findTextScanTests({ root: tmpRoot });
    expect(results).toEqual(['tests/unit/match.test.ts']);
  });
});

describe('main', () => {
  it('returns 2 and does not call run when --base is missing', async () => {
    let runCalled = false;
    const runGroup = async () => {
      runCalled = true;
      return { code: 0, signal: null };
    };

    const exitCode = await main([], { runGroup, root: '/dummy', tmpBase: TMP_BASE });
    expect(exitCode).toBe(2);
    expect(runCalled).toBe(false);
  });

  it('handles related mode: exit 1 on failure, runs both, logs outputs and passes --changed, mergeBase, --passWithNoTests', async () => {
    // #4577: 2 回の起動は 1 回の和集合 × LPT 4 組に替わった（名前は #4577 の前のまま）
    const calls: GroupCall[] = [];
    const logs: string[] = [];
    const vitest = fakeVitest('/dummy', ['tests/unit/feature.test.ts']);

    const exitCode = await main(['--base', 'origin/develop'], {
      runGroup: groupDouble('/dummy', calls, ['tests/unit/feature.test.ts']),
      log: (msg: string) => logs.push(msg),
      out: () => undefined,
      root: '/dummy',
      tmpBase: TMP_BASE,
      collectChangedFiles: () => ({ mergeBase: 'deadbeef123', files: ['src/feature.ts'] }),
      findTextScanTests: () => ['tests/unit/scan.test.ts'],
      collectSet: vitest.collectSet,
    });

    // A failure in the related set fails the gate.
    expect(exitCode).toBe(1);

    // The related set is what `vitest run tests/unit --changed <mergeBase>` selects.
    expect(vitest.seen.options).toMatchObject({ changed: 'deadbeef123', passWithNoTests: true });
    expect(vitest.seen.options).not.toHaveProperty('related');
    expect(vitest.seen.filters).toEqual(['tests/unit']);

    // Both the related test and the text-scan test run, through vitest, with --passWithNoTests.
    expect(calls.flatMap((c) => handedFiles(c.args)).sort()).toEqual([
      'tests/unit/feature.test.ts',
      'tests/unit/scan.test.ts',
    ]);
    for (const c of calls) {
      expect(c.cmd).toBe(path.join('/dummy', 'node_modules', '.bin', 'vitest'));
      expect(c.args[0]).toBe('run');
      expect(c.args).toContain('--passWithNoTests');
      expect(c.env.NODE_ENV).toBe('test');
    }

    expect(logs).toContain('run-related-unit-tests: mode=related changed=1 textscan=1');
    expect(logs).toContain('run-related-unit-tests: set related=1 textscan=1 overlap=0 union=2');
    expect(logs).toContain('run-related-unit-tests: failed tests/unit/feature.test.ts > case of tests/unit/feature.test.ts');
    expect(logs).toContain('run-related-unit-tests: result exit=1 groups=2 union=2');
  });

  it('handles a former full change (vitest.config.ts) as related: no npm run test:unit, text-scan tests only (Issue #4467)', async () => {
    const calls: GroupCall[] = [];
    const logs: string[] = [];
    const vitest = fakeVitest('/dummy', ['tests/unit/never.test.ts']);

    const exitCode = await main(['--base', 'origin/develop'], {
      runGroup: groupDouble('/dummy', calls),
      log: (msg: string) => logs.push(msg),
      out: () => undefined,
      root: '/dummy',
      tmpBase: TMP_BASE,
      collectChangedFiles: () => ({ mergeBase: 'sha1', files: ['vitest.config.ts'] }),
      findTextScanTests: () => ['tests/unit/scan.test.ts'],
      collectSet: vitest.collectSet,
    });

    expect(exitCode).toBe(0);
    // Nothing traceable: the related set is not even asked for, and only vitest runs (no npm).
    expect(vitest.seen.loaded).toBe(0);
    expect(argvOf(calls)).toEqual([
      [path.join('/dummy', 'node_modules', '.bin', 'vitest'), 'run', 'tests/unit/scan.test.ts', '--passWithNoTests'],
    ]);
    expect(logs).toContain(
      'run-related-unit-tests: mode=related reason=non-source:vitest.config.ts changed=1 traced=0 textscan=1'
    );
    expect(logs).toContain('run-related-unit-tests: set related=0 textscan=1 overlap=0 union=1');
    expect(logs.some((l) => l.includes('mode=full') || l.includes('full exit='))).toBe(false);
  });

  it('handles none mode: run is not called and returns 0', async () => {
    let runCalled = false;
    const runGroup = async () => {
      runCalled = true;
      return { code: 0, signal: null };
    };

    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    const collectChangedFilesMock = () => ({
      mergeBase: 'sha1',
      files: ['CHANGELOG.md'],
    });

    const exitCode = await main(['--base', 'origin/develop'], {
      runGroup,
      log,
      root: '/dummy',
      tmpBase: TMP_BASE,
      collectChangedFiles: collectChangedFilesMock,
    });

    expect(exitCode).toBe(0);
    expect(runCalled).toBe(false);
    expect(logs).toContain('run-related-unit-tests: mode=none');
  });
});

/**
 * Issue #4467: a change outside src/ and tests/ no longer switches the local
 * gate to the whole unit suite (CI's Unit Tests runs it). Pins what `main()`
 * asks vitest for and what it runs for the four shapes of change the contract
 * names. Since #4577 the related set and the text-scan tests run as one union.
 */
describe('main: non-source changes stay related (Issue #4467)', () => {
  let tmpRoot: string;
  const TEXTSCAN = ['tests/unit/docs/a.test.ts', 'tests/unit/guards/b.test.ts'];
  /** What the fake vitest answers for the related set. */
  const RELATED = ['tests/unit/lib/a.test.ts'];

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-related-4467-'));
  });

  afterEach(() => {
    removeTempDir(tmpRoot);
  });

  function touch(rel: string): void {
    const full = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }

  async function runMain(files: string[], failing: string[] = []) {
    const calls: GroupCall[] = [];
    const logs: string[] = [];
    const vitest = fakeVitest(tmpRoot, RELATED);
    const exitCode = await main(['--base', 'origin/develop'], {
      runGroup: groupDouble(tmpRoot, calls, failing),
      log: (msg: string) => logs.push(msg),
      out: () => undefined,
      root: tmpRoot,
      tmpBase: TMP_BASE,
      collectChangedFiles: () => ({ mergeBase: 'base123', files }),
      findTextScanTests: () => TEXTSCAN,
      collectSet: vitest.collectSet,
    });
    const ran = calls.flatMap((c) => handedFiles(c.args)).sort();
    return { exitCode, calls, logs, ran, seen: vitest.seen };
  }

  /** The log lines main() writes before any group runs. */
  const head = (logs: string[]) => logs.slice(0, 3);

  it('(1) non-source only (docs, README): runs only the text-scan tests', async () => {
    const { exitCode, ran, logs, seen } = await runMain(['README.md', 'docs/guide.md']);
    expect(exitCode).toBe(0);
    expect(seen.loaded).toBe(0);
    expect(ran).toEqual(TEXTSCAN);
    expect(head(logs)).toEqual([
      'run-related-unit-tests: mode=related reason=non-source:README.md changed=2 traced=0 textscan=2',
      'run-related-unit-tests: set related=0 textscan=2 overlap=0 union=2',
      'run-related-unit-tests: split=lpt groups=2 cache=missing known=0/2 default-weight=1ms',
    ]);
    expect(logs[logs.length - 1]).toBe('run-related-unit-tests: result exit=0 groups=2 union=2');
  });

  it('(2) non-source + src: vitest related on the existing traceable files, then the text-scan tests', async () => {
    // #4577: 2 回の起動は 1 回の和集合 × LPT 4 組に替わった（名前は #4577 の前のまま）
    touch('src/lib/a.ts');
    // src/lib/gone.ts is a deletion: it does not exist, so it is not handed to vitest related.
    const { exitCode, ran, logs, seen } = await runMain(['docs/guide.md', 'src/lib/a.ts', 'src/lib/gone.ts']);
    expect(exitCode).toBe(0);
    expect(seen.options).toMatchObject({ related: [path.join(tmpRoot, 'src/lib/a.ts')], dir: 'tests/unit' });
    expect(seen.options).not.toHaveProperty('changed');
    expect(seen.filters).toEqual([]);
    expect(ran).toEqual([...RELATED, ...TEXTSCAN].sort());
    expect(head(logs).slice(0, 2)).toEqual([
      'run-related-unit-tests: mode=related reason=non-source:docs/guide.md changed=3 traced=1 textscan=2',
      'run-related-unit-tests: set related=1 textscan=2 overlap=0 union=3',
    ]);
  });

  it('(3) scripts .mjs only: the script is traced by vitest related, and the text-scan tests run', async () => {
    touch('scripts/foo.mjs');
    const { exitCode, ran, logs, seen } = await runMain(['scripts/foo.mjs']);
    expect(exitCode).toBe(0);
    expect(seen.options).toMatchObject({ related: [path.join(tmpRoot, 'scripts/foo.mjs')], dir: 'tests/unit' });
    expect(ran).toEqual([...RELATED, ...TEXTSCAN].sort());
    expect(logs[0]).toBe(
      'run-related-unit-tests: mode=related reason=non-source:scripts/foo.mjs changed=1 traced=1 textscan=2'
    );
  });

  it('(4) none: metadata only runs nothing', async () => {
    const { exitCode, calls, logs, seen } = await runMain([
      '.commandmate/tasks/issue-1.yaml',
      'dev-reports/x.md',
      'changelog.d/1.md',
      'CHANGELOG.md',
      'docs/module-reference.md',
    ]);
    expect(exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(seen.loaded).toBe(0);
    expect(logs).toEqual(['run-related-unit-tests: mode=none']);
  });

  it('fails when either the related run or the text-scan run fails', async () => {
    // #4577: 2 回の起動は 1 回の和集合 × LPT 4 組に替わった（名前は #4577 の前のまま）
    touch('scripts/foo.mjs');
    expect((await runMain(['scripts/foo.mjs'], [RELATED[0]])).exitCode).toBe(1);
    expect((await runMain(['scripts/foo.mjs'], [TEXTSCAN[1]])).exitCode).toBe(1);
    expect((await runMain(['scripts/foo.mjs'])).exitCode).toBe(0);
    const { exitCode, logs } = await runMain(['README.md'], [TEXTSCAN[0]]);
    expect(exitCode).toBe(1);
    expect(logs).toContain(`run-related-unit-tests: failed ${TEXTSCAN[0]} > case of ${TEXTSCAN[0]}`);
    expect(logs[logs.length - 1]).toBe('run-related-unit-tests: result exit=1 groups=2 union=2');
  });

  it('negative control: src/tests only keeps the --changed run (unchanged argv)', async () => {
    // #4577: 2 回の起動は 1 回の和集合 × LPT 4 組に替わった（名前は #4577 の前のまま）
    // The --changed selection is unchanged: vitest is asked for `changed: <mergeBase>` under tests/unit.
    touch('src/lib/a.ts');
    const { ran, logs, seen } = await runMain(['src/lib/a.ts']);
    expect(seen.options).toMatchObject({ changed: 'base123', passWithNoTests: true });
    expect(seen.options).not.toHaveProperty('related');
    // As before #4577 (no --dir in the --changed argv): the changed form passes no dir.
    expect(seen.options).not.toHaveProperty('dir');
    expect(seen.filters).toEqual(['tests/unit']);
    expect(ran).toEqual([...RELATED, ...TEXTSCAN].sort());
    expect(logs[0]).toBe('run-related-unit-tests: mode=related changed=1 textscan=2');
  });
});
