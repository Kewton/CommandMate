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
  SCOPE_ALLOW_GUIDANCE,
  SCOPE_EXEMPT_ALWAYS_ALLOWED,
  SCOPE_EXEMPT_CONTRACT_PATH,
  SCOPE_PATTERN_ARROW,
  SCOPE_SKIP_NO_CONTRACT,
  SCOPE_SKIP_NOT_REQUIRED,
} from '@/lib/verification/scope-gate';
import { parseScopeEvidence } from '@/cli/commands/verify';
import { removeTempDir } from '@tests/helpers/temp-dir';

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
    if (dir) removeTempDir(dir);
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

  it('drops an uncommitted contract file and keeps verify.yaml', async () => {
    const repo = createRepo();
    write(repo, '.commandmate/tasks/t.yaml', 'goal: x\n');
    write(repo, '.commandmate/verify.yaml', 'version: 1\n');
    write(repo, 'src/lib/verification/work.ts', 'export const w = 1;\n');

    expect(await changedPaths(repo)).toEqual([
      '.commandmate/verify.yaml',
      'src/lib/verification/work.ts',
    ]);
  });

  it('drops a committed contract file too', async () => {
    const repo = createRepo();
    // The orchestrator variant that commits the contract as a setup commit.
    write(repo, '.commandmate/tasks/t.yaml', 'goal: x\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'contract'], repo);
    write(repo, 'src/lib/verification/work.ts', 'export const w = 1;\n');

    expect(await changedPaths(repo)).toEqual(['src/lib/verification/work.ts']);
  });

  it('drops both paths when a contract file is renamed within the contract directory', async () => {
    const repo = createRepo();
    write(repo, '.commandmate/tasks/old.yaml', 'goal: x\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'contract'], repo);
    git(['mv', '.commandmate/tasks/old.yaml', '.commandmate/tasks/new.yaml'], repo);

    // Both the `R  <new>NUL<old>` rename record and the committed diff have to
    // be filtered, or the origin path survives as a phantom change.
    expect(await changedPaths(repo)).toEqual([]);
  });

  it('keeps the non-contract half of a rename out of the contract directory', async () => {
    const repo = createRepo();
    write(repo, '.commandmate/tasks/t.yaml', 'goal: x\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'contract'], repo);
    git(['mv', '.commandmate/tasks/t.yaml', 'src/escaped.yaml'], repo);

    expect(await changedPaths(repo)).toEqual(['src/escaped.yaml']);
  });

  it('does not drop a directory that merely starts like the contract directory', async () => {
    const repo = createRepo();
    write(repo, '.commandmate/tasks-archive/t.yaml', 'goal: x\n');
    write(repo, '.commandmate/tasks.yaml', 'goal: x\n');

    expect(await changedPaths(repo)).toEqual([
      '.commandmate/tasks-archive/t.yaml',
      '.commandmate/tasks.yaml',
    ]);
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

  it('closes every failure report with the scope.allow guidance, after the path list', async () => {
    const repo = createRepo();
    write(repo, 'package.json', '{}\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'out of scope'], repo);

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.status).toBe('failed');
    const tail = outcome.logTail ?? '';
    expect(tail.endsWith(SCOPE_ALLOW_GUIDANCE)).toBe(true);
    // The reader meets the paths before the fix for them.
    expect(tail.indexOf(SCOPE_ALLOW_GUIDANCE)).toBeGreaterThan(tail.indexOf('  - package.json'));
  });

  it('keeps the guidance out of a passing report', async () => {
    const repo = createRepo();
    write(repo, 'src/lib/verification/scope-gate.ts', 'export const gate = 1;\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'in scope'], repo);

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.status).toBe('passed');
    expect(outcome.logTail).not.toContain(SCOPE_ALLOW_GUIDANCE);
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
    // Only verify.yaml is left: the contract is dropped from the change set
    // entirely (#1580), while verify.yaml stays visible to the gate.
    expect(outcome.logTail).toContain('changed=1 violations=0');
  });

  it('fails a deny that names verify.yaml, and cannot be dodged by a deny on the contract', async () => {
    const repo = createRepo();
    write(repo, '.commandmate/tasks/t.yaml', 'version: 1\n');
    write(repo, '.commandmate/verify.yaml', 'version: 1\n');

    // A contract that forbids weakening the gates still catches verify.yaml,
    // because verify.yaml has no send-time snapshot to fall back on.
    const outcome = await evaluate(repo, scope(['src/**'], ['.commandmate/**']));
    expect(outcome.status).toBe('failed');
    expect(outcome.logTail).toContain('  - .commandmate/verify.yaml');
    expect(outcome.logTail).not.toContain('.commandmate/tasks/t.yaml');
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
    // Truncation must not swallow the actionable part.
    expect((outcome.logTail ?? '').endsWith(SCOPE_ALLOW_GUIDANCE)).toBe(true);
  });
});

// =============================================================================
// Admission evidence (Issue #1841)
// =============================================================================

/**
 * `  + <path>  \u2190 <pattern>` lines, as {path: pattern}.
 *
 * Read out of the report rather than off a return value on purpose: `log_tail`
 * is the only place this evidence is stored, so a test that asserted on an
 * in-memory structure would pass while the thing an operator actually reads
 * three days later said nothing.
 */
function admittedLines(logTail: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (logTail ?? '').split('\n')) {
    if (!line.startsWith('  + ')) continue;
    const [path, pattern] = line.slice(4).split(SCOPE_PATTERN_ARROW);
    out[path] = pattern;
  }
  return out;
}

/** `  - <path>` lines, with any trailing `\u2190 <pattern>` stripped. */
function violationLines(logTail: string | null): string[] {
  return (logTail ?? '')
    .split('\n')
    .filter((line) => line.startsWith('  - '))
    .map((line) => line.slice(4).split(SCOPE_PATTERN_ARROW)[0]);
}

describe('ScopeMatcher.classify', () => {
  it('names the first matching allow pattern, not the last', () => {
    // The reader has to be able to act on the answer: deleting the second entry
    // changes nothing about this path, so naming it would send them to a rule
    // that is not load-bearing.
    const matcher = new ScopeMatcher(scope(['src/**', 'src/lib/**']));
    expect(matcher.classify('src/lib/a.ts')).toEqual({ admitted: true, pattern: 'src/**' });
  });

  it('names the first matching deny pattern and admits nothing on a deny', () => {
    const matcher = new ScopeMatcher(scope(['src/**'], ['src/**/*.gen.ts', 'src/lib/**']));
    expect(matcher.classify('src/lib/a.gen.ts')).toEqual({
      admitted: false,
      pattern: 'src/**/*.gen.ts',
    });
  });

  it('reports a null pattern when nothing matched at all', () => {
    // The one rejection no rule can be named for. A stand-in string here would
    // send the reader looking through the contract for something not in it.
    expect(new ScopeMatcher(scope(['src/**'])).classify('README.md')).toEqual({
      admitted: false,
      pattern: null,
    });
  });

  it('marks the two exemptions apart from any declared pattern', () => {
    const matcher = new ScopeMatcher(scope(['src/**']), 'contracts/t.yaml');
    expect(matcher.classify('.commandmate/verify.yaml')).toEqual({
      admitted: true,
      pattern: SCOPE_EXEMPT_ALWAYS_ALLOWED,
    });
    expect(matcher.classify('contracts/t.yaml')).toEqual({
      admitted: true,
      pattern: SCOPE_EXEMPT_CONTRACT_PATH,
    });
    // Parenthesised so a reader grepping the contract for the reported pattern
    // finds nothing, which is the truth: nothing there put these in scope.
    expect(SCOPE_EXEMPT_ALWAYS_ALLOWED.startsWith('(')).toBe(true);
    expect(SCOPE_EXEMPT_CONTRACT_PATH.startsWith('(')).toBe(true);
  });

  it('keeps isViolation in step with classify over every glob case', () => {
    const matcher = new ScopeMatcher(scope(['src/**', 'docs/*.md'], ['src/secret/**']));
    for (const path of [
      'src/a/b.ts',
      'docs/x.md',
      'docs/nested/x.md',
      'README.md',
      'src/secret/key.ts',
      '.commandmate/verify.yaml',
    ]) {
      expect(matcher.isViolation(path)).toBe(!matcher.classify(path).admitted);
    }
  });
});

describe('evaluateScope — admitted evidence', () => {
  it('records which allow pattern admitted each changed file', async () => {
    const repo = createRepo();
    write(repo, 'src/a/b.ts', 'export const b = 1;\n');
    write(repo, 'docs/x.md', '# x\n');
    write(repo, 'README.md', 'edited\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'mixed'], repo);

    const outcome = await evaluate(repo, scope(['src/**', 'docs/*.md']));
    expect(outcome.status).toBe('failed');
    expect(admittedLines(outcome.logTail)).toEqual({
      'src/a/b.ts': 'src/**',
      'docs/x.md': 'docs/*.md',
    });
    expect(violationLines(outcome.logTail)).toEqual(['README.md']);
  });

  it('records the admitting pattern on a passing run too', async () => {
    // The evidence exists for the runs that passed: "what did `src/**` actually
    // cover that day" is unanswerable afterwards, and a green run is exactly
    // when nobody thinks to look.
    const repo = createRepo();
    write(repo, 'src/lib/verification/scope-gate.ts', 'export const gate = 1;\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'in scope'], repo);

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.status).toBe('passed');
    expect(outcome.logTail).toContain('admitted:');
    expect(admittedLines(outcome.logTail)).toEqual({
      'src/lib/verification/scope-gate.ts': 'src/lib/verification/**',
    });
  });

  it('names the exemption that admitted a path no pattern covers', async () => {
    const repo = createRepo();
    write(repo, '.commandmate/verify.yaml', 'version: 1\n');

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.status).toBe('passed');
    expect(admittedLines(outcome.logTail)).toEqual({
      '.commandmate/verify.yaml': SCOPE_EXEMPT_ALWAYS_ALLOWED,
    });
  });

  it('keeps a denied path out of admitted and names the deny pattern that rejected it', async () => {
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
    expect(admittedLines(outcome.logTail)).toEqual({
      'src/lib/verification/scope-gate.ts': 'src/lib/verification/**',
    });
    // The `deny:` header lists what was declared; this says which entry this
    // path tripped — the difference between "revert it" and "widen allow".
    expect(outcome.logTail).toContain(
      `  - src/lib/verification/gate-runner.ts${SCOPE_PATTERN_ARROW}src/lib/verification/gate-runner.ts`
    );
  });

  it('leaves an allow-miss violation with no pattern to blame', async () => {
    const repo = createRepo();
    write(repo, 'package.json', '{}\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'out of scope'], repo);

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.logTail).toContain('  - package.json\n');
    expect(outcome.logTail).not.toContain(`package.json${SCOPE_PATTERN_ARROW}`);
  });

  it('omits the admitted section entirely when nothing was admitted', async () => {
    const repo = createRepo();
    write(repo, 'package.json', '{}\n');

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(outcome.logTail).not.toContain('admitted:');
  });

  it('caps the admitted list, says so, and still judges every file', async () => {
    const repo = createRepo();
    const admittedTotal = MAX_REPORTED_VIOLATIONS + 7;
    for (let i = 0; i < admittedTotal; i += 1) {
      write(repo, `src/lib/verification/f-${String(i).padStart(3, '0')}.ts`, 'export const x = 1;\n');
    }
    write(repo, 'stray-a.ts', 'export const x = 1;\n');
    write(repo, 'stray-b.ts', 'export const x = 1;\n');

    const outcome = await evaluate(repo, ALLOW_SRC);
    expect(Object.keys(admittedLines(outcome.logTail))).toHaveLength(MAX_REPORTED_VIOLATIONS);
    expect(outcome.logTail).toContain('(+7 more)');
    // Truncation is a display rule. The summary counts every path, and the two
    // violations that share the report with a capped admitted list still decide
    // the verdict.
    expect(outcome.logTail).toContain(`changed=${admittedTotal + 2} violations=2`);
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(1);
    expect(violationLines(outcome.logTail)).toEqual(['stray-a.ts', 'stray-b.ts']);
  });

  it('puts the admitted section before the violations so a capped log keeps the verdict', async () => {
    // `verify` echoes only the LAST 40 lines of a failing gate's log
    // (MAX_PRINTED_LOG_TAIL_LINES). A long admitted list printed after the
    // violations would scroll the actionable half out of the terminal.
    const repo = createRepo();
    write(repo, 'src/lib/verification/a.ts', 'export const a = 1;\n');
    write(repo, 'package.json', '{}\n');

    const tail = (await evaluate(repo, ALLOW_SRC)).logTail ?? '';
    expect(tail.indexOf('admitted:')).toBeGreaterThan(-1);
    expect(tail.indexOf('admitted:')).toBeLessThan(tail.indexOf('out of scope:'));
    expect(tail.endsWith(SCOPE_ALLOW_GUIDANCE)).toBe(true);
  });
});

describe('scope evidence round-trip into `verify --json`', () => {
  // The gate formats the report and the CLI parses it back, in two modules that
  // cannot import each other: tsconfig.cli.json compiles `src/cli/**` with no
  // path aliases, so the CLI bundle never reaches the server's dependency
  // graph. Feeding a real report through the real parser is what keeps the two
  // copies of the format honest — asserting the constants match would only
  // prove they were copied, not that the shape survives.

  it('recovers the admitted pairs and violations a real gate report carries', async () => {
    const repo = createRepo();
    write(repo, 'src/a/b.ts', 'export const b = 1;\n');
    write(repo, 'docs/x.md', '# x\n');
    write(repo, 'README.md', 'edited\n');

    const outcome = await evaluate(repo, scope(['src/**', 'docs/*.md']));
    const evidence = parseScopeEvidence(outcome.logTail);

    expect(evidence).not.toBeNull();
    expect(evidence?.admitted).toEqual([
      { path: 'docs/x.md', pattern: 'docs/*.md' },
      { path: 'src/a/b.ts', pattern: 'src/**' },
    ]);
    expect(evidence?.violations).toEqual(['README.md']);
    expect(evidence?.totals).toEqual({ changed: 3, admitted: 2, violations: 1 });
  });

  it('recovers a deny rejection as a violation, with no admitted entry for it', async () => {
    const repo = createRepo();
    write(repo, 'src/keep.ts', 'export const k = 1;\n');
    write(repo, 'src/secret/key.ts', 'export const s = 1;\n');

    const outcome = await evaluate(repo, scope(['src/**'], ['src/secret/**']));
    const evidence = parseScopeEvidence(outcome.logTail);

    expect(evidence?.admitted).toEqual([{ path: 'src/keep.ts', pattern: 'src/**' }]);
    expect(evidence?.violations).toEqual(['src/secret/key.ts']);
  });

  it('reports totals over every path when the report truncated its lists', async () => {
    const repo = createRepo();
    const admittedTotal = MAX_REPORTED_VIOLATIONS + 3;
    for (let i = 0; i < admittedTotal; i += 1) {
      write(repo, `src/f-${String(i).padStart(3, '0')}.ts`, 'export const x = 1;\n');
    }
    write(repo, 'stray.ts', 'export const x = 1;\n');

    const evidence = parseScopeEvidence((await evaluate(repo, scope(['src/**']))).logTail);

    // A consumer branching on `violations.length` would read 1 here and be
    // right; one branching on `admitted.length` would read 100 and be wrong.
    // The totals are what the gate counted.
    expect(evidence?.admitted).toHaveLength(MAX_REPORTED_VIOLATIONS);
    expect(evidence?.totals).toEqual({
      changed: admittedTotal + 1,
      admitted: admittedTotal,
      violations: 1,
    });
  });

  it('returns null for the tails that are messages rather than reports', async () => {
    const repo = createRepo();
    write(repo, 'anything.ts', 'export const x = 1;\n');

    // An empty `admitted` on a skip would claim the gate looked and found
    // nothing in scope, which is the opposite of what happened.
    expect(parseScopeEvidence((await evaluate(repo, null)).logTail)).toBeNull();
    expect(
      parseScopeEvidence((await evaluate(repo, ALLOW_SRC, { requireScopeClean: false })).logTail)
    ).toBeNull();
    expect(parseScopeEvidence((await evaluate(repo, ALLOW_SRC, { baseRef: null })).logTail)).toBeNull();
    expect(parseScopeEvidence(null)).toBeNull();
    expect(parseScopeEvidence('skipped: the work-evidence gate did not pass.')).toBeNull();
  });
});
