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
  findTextScanTests,
  main,
} from '../../../scripts/run-related-unit-tests.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';

/**
 * The options object `main()` hands its `run` dependency at every call site.
 * The parameter itself arrives as `unknown`: the script's JSDoc types it from a
 * `= {}` default, so a narrower annotation on the double is not assignable.
 */
interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
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
  it('returns 2 and does not call run when --base is missing', () => {
    let runCalled = false;
    const run = () => {
      runCalled = true;
      return 0;
    };

    const exitCode = main([], { run, root: '/dummy' });
    expect(exitCode).toBe(2);
    expect(runCalled).toBe(false);
  });

  it('handles related mode: exit 1 on failure, runs both, logs outputs and passes --changed, mergeBase, --passWithNoTests', () => {
    const calls: { cmd: string; args: string[]; opts: RunOptions }[] = [];
    let callCount = 0;
    const run = (cmd: string, args: string[], opts: unknown) => {
      calls.push({ cmd, args, opts: opts as RunOptions });
      callCount++;
      // 1st call fails (1), 2nd call succeeds (0)
      return callCount === 1 ? 1 : 0;
    };

    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    const collectChangedFilesMock = () => ({
      mergeBase: 'deadbeef123',
      files: ['src/feature.ts'],
    });

    const findTextScanTestsMock = () => ['tests/unit/scan.test.ts'];

    const exitCode = main(['--base', 'origin/develop'], {
      run,
      log,
      root: '/dummy',
      collectChangedFiles: collectChangedFilesMock,
      findTextScanTests: findTextScanTestsMock,
    });

    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(2);

    // 1st call verification
    expect(calls[0].cmd).toBe(path.join('/dummy', 'node_modules', '.bin', 'vitest'));
    expect(calls[0].args).toEqual([
      'run',
      'tests/unit',
      '--changed',
      'deadbeef123',
      '--passWithNoTests',
    ]);
    expect(calls[0].opts.env.NODE_ENV).toBe('test');

    // 2nd call verification
    expect(calls[1].cmd).toBe(path.join('/dummy', 'node_modules', '.bin', 'vitest'));
    expect(calls[1].args).toEqual(['run', 'tests/unit/scan.test.ts']);
    expect(calls[1].opts.env.NODE_ENV).toBe('test');

    expect(logs).toContain('run-related-unit-tests: mode=related changed=1 textscan=1');
    expect(logs).toContain('run-related-unit-tests: related exit=1 textscan exit=0');
  });

  it('handles full mode: calls only npm run test:unit', () => {
    const calls: { cmd: string; args: string[]; opts: RunOptions }[] = [];
    const run = (cmd: string, args: string[], opts: unknown) => {
      calls.push({ cmd, args, opts: opts as RunOptions });
      return 0;
    };

    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    const collectChangedFilesMock = () => ({
      mergeBase: 'sha1',
      files: ['vitest.config.ts'],
    });

    const exitCode = main(['--base', 'origin/develop'], {
      run,
      log,
      root: '/dummy',
      collectChangedFiles: collectChangedFilesMock,
    });

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('npm');
    expect(calls[0].args).toEqual(['run', 'test:unit']);
    expect(logs).toContain('run-related-unit-tests: mode=full reason=vitest.config.ts');
    expect(logs).toContain('run-related-unit-tests: full exit=0');
  });

  it('handles none mode: run is not called and returns 0', () => {
    let runCalled = false;
    const run = () => {
      runCalled = true;
      return 0;
    };

    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    const collectChangedFilesMock = () => ({
      mergeBase: 'sha1',
      files: ['CHANGELOG.md'],
    });

    const exitCode = main(['--base', 'origin/develop'], {
      run,
      log,
      root: '/dummy',
      collectChangedFiles: collectChangedFilesMock,
    });

    expect(exitCode).toBe(0);
    expect(runCalled).toBe(false);
    expect(logs).toContain('run-related-unit-tests: mode=none');
  });
});
