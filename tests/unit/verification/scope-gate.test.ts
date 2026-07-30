/**
 * Unit tests for the built-in `scope` gate (Issue #1546, Phase 2-2).
 *
 * Canonical spec: docs/design/task-contract.md §2.2
 *
 * Two disciplines shape these tests:
 *
 *   1. Every "this is in scope" case is paired with a near-miss that must be out
 *      of scope. A matcher that returned `false` from `isViolation()` for
 *      everything would satisfy half of a one-sided suite, and this gate's whole
 *      value is that it fails when it should.
 *   2. The change set comes from real temporary git repositories, not from a
 *      stubbed `git`. The failure this gate was promoted to prevent is git output
 *      being parsed into paths that do not exist, which no mock can reproduce.
 *
 * Fixtures contain no NUL bytes, so `grep` can see every file written here.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { TaskContractScope } from '@/lib/tasks/contract-parser';
import {
  collectChangedPaths,
  evaluateScope,
  MAX_REPORTED_VIOLATIONS,
  ScopeMatcher,
  SCOPE_SKIP_NO_CONTRACT,
  SCOPE_SKIP_NOT_REQUIRED,
} from '@/lib/verification/scope-gate';

// =============================================================================
// Glob semantics
// =============================================================================

function scope(allow: string[], deny: string[] = []): TaskContractScope {
  return { allow, deny };
}

/** True when `path` is inside the declared scope. */
function inScope(patterns: string[], path: string, contractPath: string | null = null): boolean {
  return !new ScopeMatcher(scope(patterns), contractPath).isViolation(path);
}

describe('ScopeMatcher — glob semantics', () => {
  it('lets `**` cross directory boundaries under a prefix, and stops at the prefix', () => {
    expect(inScope(['src/lib/tasks/**'], 'src/lib/tasks/a.ts')).toBe(true);
    expect(inScope(['src/lib/tasks/**'], 'src/lib/tasks/deep/nested/b.ts')).toBe(true);
    expect(inScope(['src/lib/tasks/**'], 'src/lib/other/a.ts')).toBe(false);
    // A prefix must end at a segment boundary, or `src/lib/tasks-old/` would be
    // silently in scope.
    expect(inScope(['src/lib/tasks/**'], 'src/lib/tasks-old/a.ts')).toBe(false);
    expect(inScope(['src/lib/tasks/**'], 'vendor/src/lib/tasks/a.ts')).toBe(false);
  });

  it('matches everything under a bare `**`', () => {
    expect(inScope(['**'], 'anything/at/all.ts')).toBe(true);
    expect(inScope(['**'], 'CHANGELOG.md')).toBe(true);
  });

  it('lets a leading `**/` match zero directories', () => {
    expect(inScope(['**/*.ts'], 'a.ts')).toBe(true);
    expect(inScope(['**/*.ts'], 'src/lib/a.ts')).toBe(true);
    expect(inScope(['**/*.ts'], 'src/lib/a.tsx')).toBe(false);
  });

  it('lets a middle `**/` match zero directories', () => {
    expect(inScope(['a/**/b.ts'], 'a/b.ts')).toBe(true);
    expect(inScope(['a/**/b.ts'], 'a/x/y/b.ts')).toBe(true);
    expect(inScope(['a/**/b.ts'], 'a/x/y/c.ts')).toBe(false);
  });

  it('keeps `*` and `?` inside a single path segment', () => {
    expect(inScope(['*.md'], 'README.md')).toBe(true);
    expect(inScope(['*.md'], 'docs/README.md')).toBe(false);
    expect(inScope(['a?.ts'], 'ab.ts')).toBe(true);
    expect(inScope(['a?.ts'], 'abc.ts')).toBe(false);
    expect(inScope(['a?.ts'], 'a/.ts')).toBe(false);
  });

  it('treats a leading dot as an ordinary character', () => {
    expect(inScope(['.github/**'], '.github/workflows/ci.yml')).toBe(true);
    expect(inScope(['**/*.yml'], '.github/workflows/ci.yml')).toBe(true);
    expect(inScope(['.github/**'], 'github/workflows/ci.yml')).toBe(false);
  });

  it('expands `{a,b}` as alternation', () => {
    expect(inScope(['src/**/*.{ts,tsx}'], 'src/a.ts')).toBe(true);
    expect(inScope(['src/**/*.{ts,tsx}'], 'src/deep/a.tsx')).toBe(true);
    expect(inScope(['src/**/*.{ts,tsx}'], 'src/a.js')).toBe(false);
    expect(inScope(['{docs,README.md}'], 'docs/design/x.md')).toBe(true);
    expect(inScope(['{docs,README.md}'], 'README.md')).toBe(true);
    expect(inScope(['{docs,README.md}'], 'CHANGELOG.md')).toBe(false);
  });

  it('treats unbalanced braces as literal characters instead of failing to compile', () => {
    // A shell leaves `src/{a` alone; a thrown RegExp here would turn one badly
    // written pattern into an unusable gate.
    expect(inScope(['src/{a'], 'src/{a')).toBe(true);
    expect(inScope(['src/{a'], 'src/a')).toBe(false);
  });

  it('treats brackets as literal, because Next.js route segments are spelled with them', () => {
    // Read as a character class, `[...path]` would match the single character
    // `p` — so the pattern naming the real directory would match nothing, and
    // an unrelated directory would match instead.
    expect(inScope(['src/app/proxy/[...path]/**'], 'src/app/proxy/[...path]/route.ts')).toBe(true);
    expect(inScope(['src/app/proxy/[...path]/**'], 'src/app/proxy/p/route.ts')).toBe(false);
  });

  it('escapes regex metacharacters that are not glob metacharacters', () => {
    expect(inScope(['docs/module-reference.md'], 'docs/module-reference.md')).toBe(true);
    expect(inScope(['docs/module-reference.md'], 'docs/module-referenceXmd')).toBe(false);
    expect(inScope(['a+b.ts'], 'a+b.ts')).toBe(true);
    expect(inScope(['a+b.ts'], 'aab.ts')).toBe(false);
  });

  it('lets a pattern that names a directory cover everything beneath it', () => {
    // The dominant way a contract author writes a directory. Without this rule
    // every file inside it would be a violation.
    expect(inScope(['src/lib/verification'], 'src/lib/verification/scope-gate.ts')).toBe(true);
    expect(inScope(['src/lib/verification/'], 'src/lib/verification/deep/x.ts')).toBe(true);
    expect(inScope(['src/lib/verification'], 'src/lib/verification')).toBe(true);
    expect(inScope(['src/lib/verification'], 'src/lib/verification-old/x.ts')).toBe(false);
    expect(inScope(['src/lib/verification'], 'src/lib/other.ts')).toBe(false);
  });

  it('is case sensitive', () => {
    expect(inScope(['src/**'], 'SRC/a.ts')).toBe(false);
  });
});

describe('ScopeMatcher — allow, deny and exemptions', () => {
  it('lets deny override a matching allow', () => {
    const patterns = scope(['src/**'], ['src/lib/polling/**']);
    const matcher = new ScopeMatcher(patterns);
    expect(matcher.isViolation('src/lib/verification/x.ts')).toBe(false);
    expect(matcher.isViolation('src/lib/polling/poller.ts')).toBe(true);
  });

  it('exempts .commandmate/ from the allow requirement', () => {
    // The contract lives there: a scope that forgot to mention it would make its
    // own storage a violation.
    expect(inScope(['src/**'], '.commandmate/tasks/t.yaml')).toBe(true);
    expect(inScope(['src/**'], '.commandmate/verify.yaml')).toBe(true);
    expect(inScope(['src/**'], '.commandmateX/other.yaml')).toBe(false);
  });

  it('still honours an explicit deny inside .commandmate/', () => {
    // The exemption exists to prevent an accident, not to make a deliberate
    // prohibition unenforceable.
    const matcher = new ScopeMatcher(scope(['src/**'], ['.commandmate/verify.yaml']));
    expect(matcher.isViolation('.commandmate/verify.yaml')).toBe(true);
    expect(matcher.isViolation('.commandmate/tasks/t.yaml')).toBe(false);
  });

  it('exempts the contract file itself when it lives outside .commandmate/', () => {
    expect(inScope(['src/**'], 'custom/t.yaml', 'custom/t.yaml')).toBe(true);
    expect(inScope(['src/**'], 'custom/other.yaml', 'custom/t.yaml')).toBe(false);
  });

  it('treats every path as a violation when allow is empty', () => {
    // Reachable only through requireScopeClean: false (the parser rejects an
    // empty allow while the flag is on), but the matcher must not invert.
    expect(inScope([], 'src/a.ts')).toBe(false);
  });
});

// =============================================================================
// Change collection against real repositories
// =============================================================================

const tempDirs: string[] = [];

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(repo: string, relativePath: string, contents: string): void {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** A repo whose `work` branch starts level with `main`, so `main` stays a fixed base. */
function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scope-gate-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'scope@example.test'], dir);
  git(['config', 'user.name', 'Scope'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  write(dir, 'README.md', 'base\n');
  write(dir, 'src/lib/verification/existing.ts', 'export const a = 1;\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  return dir;
}

async function changedPaths(repo: string): Promise<string[]> {
  const result = await collectChangedPaths(repo, 'main');
  if ('error' in result) throw new Error(`collectChangedPaths failed: ${result.error}`);
  return result.paths;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('collectChangedPaths', () => {
  it('reports nothing for a worktree level with the base ref', async () => {
    expect(await changedPaths(createRepo())).toEqual([]);
  });

  it('unions committed and uncommitted change', async () => {
    const repo = createRepo();
    write(repo, 'src/committed.ts', 'export const b = 2;\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'committed work'], repo);
    write(repo, 'README.md', 'edited\n');

    // Looking only at commits would miss README.md; only at the tree would miss
    // src/committed.ts.
    expect(await changedPaths(repo)).toEqual(['README.md', 'src/committed.ts']);
  });

  it('reports untracked files individually rather than as a collapsed directory', async () => {
    const repo = createRepo();
    write(repo, 'fresh/deep/one.ts', 'export const c = 3;\n');
    write(repo, 'fresh/deep/two.ts', 'export const d = 4;\n');

    // Default porcelain output would be the single entry `fresh/`, and the gate
    // would then judge a directory name instead of the files in it.
    expect(await changedPaths(repo)).toEqual(['fresh/deep/one.ts', 'fresh/deep/two.ts']);
  });

  it('reports both paths of a staged rename', async () => {
    const repo = createRepo();
    git(['mv', 'src/lib/verification/existing.ts', 'src/moved.ts'], repo);

    expect(await changedPaths(repo)).toEqual([
      'src/lib/verification/existing.ts',
      'src/moved.ts',
    ]);
  });

  it('reports both paths of a committed rename', async () => {
    const repo = createRepo();
    git(['mv', 'src/lib/verification/existing.ts', 'src/moved.ts'], repo);
    git(['commit', '-m', 'rename'], repo);

    // `git diff --name-only` folds a detected rename into the destination only,
    // which would hide the fact that the source directory was emptied.
    expect(await changedPaths(repo)).toEqual([
      'src/lib/verification/existing.ts',
      'src/moved.ts',
    ]);
  });

  it('reports both paths of an unstaged move', async () => {
    const repo = createRepo();
    unlinkSync(join(repo, 'src/lib/verification/existing.ts'));
    write(repo, 'src/moved.ts', 'export const a = 1;\n');

    expect(await changedPaths(repo)).toEqual([
      'src/lib/verification/existing.ts',
      'src/moved.ts',
    ]);
  });

  it('keeps a path containing spaces as one path', async () => {
    const repo = createRepo();
    write(repo, 'docs/two words.md', 'text\n');

    // The human porcelain format C-quotes this as "docs/two words.md"; splitting
    // that on whitespace invents two files that do not exist.
    expect(await changedPaths(repo)).toEqual(['docs/two words.md']);
  });

  it('treats a symlink as the single path git reports', async () => {
    const repo = createRepo();
    symlinkSync('README.md', join(repo, 'link.md'));

    // Nothing here dereferences: the gate judges the path string, so a symlink
    // and a submodule are ordinary entries.
    expect(await changedPaths(repo)).toEqual(['link.md']);
    expect(new ScopeMatcher(scope(['*.md'])).isViolation('link.md')).toBe(false);
  });

  it('ignores files git itself ignores', async () => {
    const repo = createRepo();
    write(repo, '.gitignore', 'build/\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'ignore build'], repo);
    write(repo, 'build/output.js', 'compiled\n');

    expect(await changedPaths(repo)).toEqual(['.gitignore']);
  });

  it('reports an error for a base ref this worktree cannot reach', async () => {
    const result = await collectChangedPaths(createRepo(), 'origin/nonexistent');
    expect('error' in result && result.error).toContain('merge-base');
  });
});

// =============================================================================
// Gate evaluation
// =============================================================================

const ALLOW_SRC = scope(['src/lib/verification/**', 'tests/unit/verification/**']);

function evaluate(
  repo: string,
  patterns: TaskContractScope | null,
  options: { requireScopeClean?: boolean; baseRef?: string | null; contractPath?: string } = {}
) {
  return evaluateScope(
    repo,
    patterns,
    options.requireScopeClean ?? true,
    options.baseRef === undefined ? 'main' : options.baseRef,
    options.contractPath ?? null
  );
}

describe('evaluateScope', () => {
  it('passes when every change is inside allow', async () => {
    const repo = createRepo();
    write(repo, 'src/lib/verification/scope-gate.ts', 'export const gate = 1;\n');
    write(repo, 'tests/unit/verification/scope-gate.test.ts', 'test\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'in scope'], repo);

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.status).toBe('passed');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.logTail).toContain('changed=2 violations=0');
  });

  it('fails and enumerates the paths outside allow', async () => {
    const repo = createRepo();
    write(repo, 'src/lib/verification/scope-gate.ts', 'export const gate = 1;\n');
    write(repo, 'package.json', '{}\n');
    write(repo, 'src/lib/polling/poller.ts', 'export const p = 1;\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'out of scope'], repo);

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.logTail).toContain('violations=2');
    expect(outcome.logTail).toContain('  - package.json');
    expect(outcome.logTail).toContain('  - src/lib/polling/poller.ts');
    // The compliant file must not be reported as a violation.
    expect(outcome.logTail).not.toContain('  - src/lib/verification/scope-gate.ts');
    expect(outcome.logTail).toContain('allow: src/lib/verification/**, tests/unit/verification/**');
  });

  it('fails on a deny match even when allow covers the path', async () => {
    const repo = createRepo();
    write(repo, 'src/lib/verification/scope-gate.ts', 'export const gate = 1;\n');
    write(repo, 'src/lib/verification/gate-runner.ts', 'export const runner = 1;\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'touches a denied file'], repo);

    const outcome = await evaluate(
      repo,
      scope(['src/lib/verification/**'], ['src/lib/verification/gate-runner.ts'])
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.logTail).toContain('  - src/lib/verification/gate-runner.ts');
    expect(outcome.logTail).not.toContain('  - src/lib/verification/scope-gate.ts');
    expect(outcome.logTail).toContain('deny: src/lib/verification/gate-runner.ts');
  });

  it('fails on an uncommitted deviation the agent has not staged', async () => {
    const repo = createRepo();
    write(repo, 'src/lib/verification/scope-gate.ts', 'export const gate = 1;\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'in scope'], repo);
    // Never staged, never committed.
    write(repo, 'CHANGELOG.md', '## Unreleased\n');

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.status).toBe('failed');
    expect(outcome.logTail).toContain('  - CHANGELOG.md');
  });

  it('fails a rename that moved a file out of a permitted directory', async () => {
    const repo = createRepo();
    git(['mv', 'src/lib/verification/existing.ts', 'src/lib/verification/renamed.ts'], repo);
    git(['commit', '-m', 'rename inside scope'], repo);
    const inside = await evaluate(repo, ALLOW_SRC);
    expect(inside.status).toBe('passed');

    git(['mv', 'src/lib/verification/renamed.ts', 'src/elsewhere.ts'], repo);
    git(['commit', '-m', 'rename out of scope'], repo);
    const outside = await evaluate(repo, ALLOW_SRC);
    expect(outside.status).toBe('failed');
    expect(outside.logTail).toContain('  - src/elsewhere.ts');
  });

  it('passes when the change set is empty', async () => {
    // work-evidence is the gate that judges "nothing happened"; reporting it
    // here as well would present one problem as two.
    const outcome = await evaluate(createRepo(), ALLOW_SRC);
    expect(outcome.status).toBe('passed');
    expect(outcome.logTail).toContain('changed=0 violations=0');
  });

  it('does not count the contract directory against the scope', async () => {
    const repo = createRepo();
    write(repo, '.commandmate/tasks/t.yaml', 'version: 1\n');
    write(repo, '.commandmate/verify.yaml', 'version: 1\n');

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.status).toBe('passed');
    expect(outcome.logTail).toContain('changed=2 violations=0');
  });

  it('skips when no contract is attached to the run', async () => {
    const repo = createRepo();
    write(repo, 'anything.ts', 'export const x = 1;\n');

    const outcome = await evaluate(repo, null);
    expect(outcome.status).toBe('skipped');
    expect(outcome.logTail).toBe(SCOPE_SKIP_NO_CONTRACT);
    expect(outcome.exitCode).toBeNull();
  });

  it('skips when the contract sets requireScopeClean: false', async () => {
    const repo = createRepo();
    write(repo, 'out-of-scope.ts', 'export const x = 1;\n');

    const outcome = await evaluate(repo, ALLOW_SRC, { requireScopeClean: false });
    expect(outcome.status).toBe('skipped');
    expect(outcome.logTail).toBe(SCOPE_SKIP_NOT_REQUIRED);
  });

  it('errors rather than passes when no base ref resolved', async () => {
    const repo = createRepo();
    write(repo, 'out-of-scope.ts', 'export const x = 1;\n');

    const outcome = await evaluate(repo, ALLOW_SRC, { baseRef: null });
    expect(outcome.status).toBe('error');
    expect(outcome.logTail).toContain('no base ref');
  });

  it('errors rather than passes when the base ref is unreachable', async () => {
    const repo = createRepo();
    write(repo, 'out-of-scope.ts', 'export const x = 1;\n');

    const outcome = await evaluate(repo, ALLOW_SRC, { baseRef: 'origin/nonexistent' });
    expect(outcome.status).toBe('error');
    expect(outcome.logTail).toContain('merge-base');
  });

  it('caps the enumerated violations and states how many were withheld', async () => {
    const repo = createRepo();
    const total = MAX_REPORTED_VIOLATIONS + 5;
    for (let i = 0; i < total; i += 1) {
      write(repo, `stray/file-${String(i).padStart(3, '0')}.ts`, 'export const x = 1;\n');
    }

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.status).toBe('failed');
    expect(outcome.logTail).toContain(`violations=${total}`);
    expect((outcome.logTail ?? '').match(/^ {2}- /gm)?.length).toBe(MAX_REPORTED_VIOLATIONS);
    expect(outcome.logTail).toContain('... and 5 more');
  });
});
