import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';

/**
 * Issue #1728 — which worktree-id scheme `hooks-git.sh` can resolve.
 *
 * The counters in hooks-git.sh are only as good as the path they are pointed at,
 * and the resolver matched an id against the **branch** only. CommandMate has
 * not minted branch-derived ids since Issue #1621: `deriveWorktreeId()`
 * (src/lib/git/worktree-id.ts) is `sanitize(basename(resolvedPath))`, fixed at
 * first registration so the id survives branch switches. In a repository that
 * names checkouts after issues — `commandmate-issue-1728` on
 * `fix/1728-monitor-git-hooks` — the branch match could not hit **anything**,
 * not one worker and not even the main worktree, and every poll reported
 * `commits=0 uncommitted=0` for workers that had already committed.
 *
 * That is why the whole existing suite stayed green through the defect: its
 * fixture repo is `myrepo-x` on `feature/x` with id `myrepo-feature-x`, an id
 * built the retired way. Every case below therefore pins a repo whose
 * **directory name differs from its branch name**, which is the shape the tests
 * were missing rather than a shape they got wrong.
 *
 * The zeros are what makes this expensive: verify-completion.sh reads
 * `commits=0 && uncommitted=0` as "the task never left the composer", so the
 * STARTED guard — the thing standing between an unstarted worker and a COMPLETE
 * report — was adjudicating on numbers nobody had measured.
 */
const SCRIPTS = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts');
const HOOKS_GIT = path.join(SCRIPTS, 'hooks-git.sh');
// Issue #1950: the guard is shared, and the vitest budget that tests/setup.ts
// gives this family is deliberately larger than it, so a run that overruns is
// reported by the guard (naming itself) rather than by a 5000ms wall clock that
// names nothing. The per-file values this replaced (15s / 20s / 25s) were all
// UNDER the 5s default budget's reach, so none of them could ever fire.
const HARD_TIMEOUT_MS = REAL_SHELL_SUBPROCESS_TIMEOUT_MS;

/** Absolute, so a test never depends on how the runner's PATH is ordered. */
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function git(cwd: string, ...args: string[]): void {
  execFileSync(REAL_GIT, ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

/**
 * The verbatim filter from the Issue's supervision command. Every diagnostic
 * that says "these zeros are not measurements" has to survive it — a warning
 * only the unfiltered stream carries is a warning the operator does not get,
 * which is how this defect went unnoticed for a full 25-minute run.
 */
const OPERATOR_FILTER =
  /STALL|IDLE|BLOCKED|PROMPT|COMPLETE|NOT_STARTED|ERROR|FAIL|intervene|NOT delivered|rate.?limit/i;

interface Repo {
  /** Main worktree — what MONITOR_HOOKS_REPO is pointed at. */
  main: string;
  /** Directory holding every checkout. */
  root: string;
  base: string;
}

/**
 * A repository shaped exactly like the one in the Issue: the main worktree's
 * directory (`MyCodeBranchDesk`) has nothing to do with its branch (`develop`),
 * and the linked checkout (`commandmate-issue-1728`) has nothing to do with
 * `fix/1728-monitor-git-hooks`. `commits` commits ahead of the base and
 * `changes` files `git status --porcelain` would list.
 */
function makeRepo(commits: number, changes: number): Repo {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hooks-git-res-'));
  const main = path.join(root, 'MyCodeBranchDesk');
  mkdirSync(main);
  execFileSync(REAL_GIT, ['-c', 'init.defaultBranch=develop', 'init', '--quiet', main], {
    stdio: 'ignore',
  });
  writeFileSync(path.join(main, 'README.md'), 'base\n');
  git(main, 'add', '.');
  git(main, 'commit', '--quiet', '-m', 'base');

  const worker = path.join(root, 'commandmate-issue-1728');
  git(main, 'worktree', 'add', '--quiet', '-b', 'fix/1728-monitor-git-hooks', worker);
  for (let n = 1; n <= commits; n += 1) {
    writeFileSync(path.join(worker, `c${n}.txt`), `${n}\n`);
    git(worker, 'add', '.');
    git(worker, 'commit', '--quiet', '-m', `work ${n}`);
  }
  for (let n = 1; n <= changes; n += 1) {
    writeFileSync(path.join(worker, `wip${n}.txt`), `${n}\n`);
  }

  return { main, root, base: 'develop' };
}

interface ShellResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Source the hooks in `repo` and run `snippet` with the functions in scope. */
function inHooks(
  repo: Pick<Repo, 'main' | 'base'>,
  snippet: string,
  env: Record<string, string> = {},
): ShellResult {
  const proc = spawnSync('bash', ['-c', `. "${HOOKS_GIT}"; ${snippet}`], {
    encoding: 'utf8',
    timeout: HARD_TIMEOUT_MS,
    env: {
      ...process.env,
      MONITOR_HOOKS_REPO: repo.main,
      MONITOR_HOOKS_BASE: repo.base,
      // Explicitly empty: the git search is what is under test, and an inherited
      // value from the developer's shell would resolve the path for free.
      MONITOR_WORKTREE_ROOT: '',
      ...env,
    },
  });
  assertSubprocessCompleted(proc, 'hooks-git-resolution.test.ts');
  return { stdout: proc.stdout ?? '', stderr: proc.stderr ?? '', status: proc.status };
}

/** `mh_worktree_path <id>`, as the real path with macOS's /var symlink resolved. */
function resolve(repo: Pick<Repo, 'main' | 'base'>, id: string): ShellResult & { path: string } {
  const run = inHooks(repo, `mh_worktree_path "${id}"`);
  const out = run.stdout.trim();
  return { ...run, path: out ? realpathSync(out) : '' };
}

describe('hooks-git.sh resolves a worktree whose directory name is not its branch name (Issue #1728)', () => {
  it('resolves the linked checkout by its directory name', () => {
    const repo = makeRepo(2, 1);
    const run = resolve(repo, 'commandmate-issue-1728');

    // Before the fix this was '' — the branch slug is `fix-1728-monitor-git-hooks`
    // and the repo-qualified slug `mycodebranchdesk-fix-1728-monitor-git-hooks`,
    // neither of which is an id CommandMate ever hands out.
    expect(run.path).toBe(realpathSync(path.join(repo.root, 'commandmate-issue-1728')));
    expect(run.status).toBe(0);
  }, HARD_TIMEOUT_MS);

  it('resolves the MAIN worktree by its directory name', () => {
    // Called out separately because it is the sharper half of the report: the
    // main worktree is the record every other rule is derived from, and it
    // failed too. A resolver that cannot find the repository it was handed is
    // not misconfigured for one worker, it is inoperative.
    const repo = makeRepo(0, 0);
    expect(resolve(repo, 'mycodebranchdesk').path).toBe(realpathSync(repo.main));
  }, HARD_TIMEOUT_MS);

  it('counts real commits and changes for a directory-named id, not zeros', () => {
    // The end-to-end shape of the defect: resolution is upstream of BOTH
    // counters, so a miss reports a worker with two commits and a dirty tree as
    // having done nothing at all.
    const repo = makeRepo(2, 1);
    const run = inHooks(
      repo,
      `printf '%s %s\\n' "$(count_commits commandmate-issue-1728)" "$(count_uncommitted commandmate-issue-1728)"`,
    );

    expect(run.stdout.trim()).toBe('2 1');
    expect(run.stderr).toBe('');
  }, HARD_TIMEOUT_MS);

  it('resolves a detached-HEAD checkout, which has no branch record at all', () => {
    // `git worktree list --porcelain` prints `detached` instead of
    // `branch refs/heads/…` here, so the branch rules have nothing to match on
    // even in a repository that does name directories after branches.
    const repo = makeRepo(0, 0);
    const detached = path.join(repo.root, 'commandmate-detached');
    git(repo.main, 'worktree', 'add', '--quiet', '--detach', detached);

    expect(resolve(repo, 'commandmate-detached').path).toBe(realpathSync(detached));
  }, HARD_TIMEOUT_MS);

  it('normalises the directory name the same way deriveWorktreeId does', () => {
    // `sanitizeIdSegment` in src/lib/git/worktree-id.ts: lower-case,
    // `[^a-z0-9-]` to '-', runs collapsed, edges trimmed. A drift between the
    // two resolves no path and re-opens the silent 0 for every worker.
    const repo = makeRepo(0, 0);
    const odd = path.join(repo.root, 'CommandMate Issue_1728!!');
    git(repo.main, 'worktree', 'add', '--quiet', '-b', 'odd', odd);

    expect(resolve(repo, 'commandmate-issue-1728').path).toBe(realpathSync(odd));
  }, HARD_TIMEOUT_MS);
});

describe('hooks-git.sh keeps resolving the retired branch-derived ids (Issue #1728)', () => {
  // Scheme 1 was added, schemes 2 and 3 were not removed: ids minted before
  // #1621 are still handed out by long-lived DB rows and by any caller passing
  // `generateWorktreeId()` output.
  function branchNamedRepo(): Repo {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hooks-git-legacy-'));
    const main = path.join(root, 'myrepo');
    mkdirSync(main);
    execFileSync(REAL_GIT, ['-c', 'init.defaultBranch=main', 'init', '--quiet', main], {
      stdio: 'ignore',
    });
    writeFileSync(path.join(main, 'README.md'), 'base\n');
    git(main, 'add', '.');
    git(main, 'commit', '--quiet', '-m', 'base');
    git(main, 'worktree', 'add', '--quiet', '-b', 'feature/x', path.join(root, 'myrepo-x'));
    return { main, root, base: 'main' };
  }

  it('resolves <repo>-<branch> when the directory says something else', () => {
    const repo = branchNamedRepo();
    expect(resolve(repo, 'myrepo-feature-x').path).toBe(
      realpathSync(path.join(repo.root, 'myrepo-x')),
    );
  }, HARD_TIMEOUT_MS);

  it('resolves a bare <branch> id', () => {
    const repo = branchNamedRepo();
    expect(resolve(repo, 'feature-x').path).toBe(realpathSync(path.join(repo.root, 'myrepo-x')));
  }, HARD_TIMEOUT_MS);

  it('prefers the directory match when a branch match points somewhere else', () => {
    // Both schemes hit, on different checkouts. The directory-derived one is
    // what a live CommandMate would have handed out, so it has to win rather
    // than whichever record `git worktree list` happened to print last.
    const repo = branchNamedRepo();
    const decoy = path.join(repo.root, 'decoy');
    // Branch `release/x` in repo `myrepo` slugs to the same id as the directory
    // `myrepo-release-x` below.
    git(repo.main, 'worktree', 'add', '--quiet', '-b', 'release/x', decoy);
    const real = path.join(repo.root, 'myrepo-release-x');
    git(repo.main, 'worktree', 'add', '--quiet', '-b', 'unrelated', real);

    expect(resolve(repo, 'myrepo-release-x').path).toBe(realpathSync(real));
  }, HARD_TIMEOUT_MS);
});

describe('hooks-git.sh diagnostics survive the operator filter (Issue #1728)', () => {
  it('reports an unresolvable id with a token the ERROR|FAIL grep keeps', () => {
    // The reason the defect ran for 25 minutes unnoticed: the line existed, and
    // `monitor hooks: …` carried no word the supervision pipe was grepping for.
    const repo = makeRepo(1, 0);
    const run = inHooks(repo, 'count_commits nope-nope; count_uncommitted nope-nope');

    expect(run.stdout.trim().split('\n')).toEqual(['0', '0']);

    const reported = run.stderr.split('\n').filter((l) => l.includes('[nope-nope]'));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('no checkout resolved');
    expect(reported[0]).toMatch(OPERATOR_FILTER);
    expect(reported[0]).toContain('monitor hooks ERROR:');
  }, HARD_TIMEOUT_MS);

  it('reports a failing `git worktree list` with the same token', () => {
    const repo = makeRepo(1, 0);
    const run = inHooks({ main: path.join(repo.root, 'not-a-repo'), base: repo.base },
      'count_commits commandmate-issue-1728');

    expect(run.stdout.trim()).toBe('0');
    expect(run.stderr).toMatch(OPERATOR_FILTER);
    expect(run.stderr).toContain('monitor hooks ERROR:');
  }, HARD_TIMEOUT_MS);

  it('reports an unresolvable base ref at source time with a WARN token', () => {
    const repo = makeRepo(1, 0);
    const run = inHooks({ main: repo.main, base: 'origin/nowhere' }, 'true');

    expect(run.stderr).toContain('monitor hooks WARN:');
    expect(run.stderr).toContain("base ref 'origin/nowhere' does not resolve");
  }, HARD_TIMEOUT_MS);

  it('warns instead of silently picking one when two checkouts share a directory name', () => {
    // CommandMate breaks this tie at mint time with a digest of the path
    // (`<base>-<sha256[0:8]>`), so the bare basename belongs to exactly one of
    // them and this scan cannot tell which. Answering is still better than
    // sinking both counters — but not silently.
    const repo = makeRepo(0, 0);
    const a = path.join(repo.root, 'nested-a', 'shared-name');
    const b = path.join(repo.root, 'nested-b', 'shared-name');
    mkdirSync(path.dirname(a));
    mkdirSync(path.dirname(b));
    git(repo.main, 'worktree', 'add', '--quiet', '-b', 'a', a);
    git(repo.main, 'worktree', 'add', '--quiet', '-b', 'b', b);

    const run = resolve(repo, 'shared-name');
    expect(run.path).toBe(realpathSync(a));
    expect(run.stderr).toContain('monitor hooks WARN:');
    expect(run.stderr).toContain('more than one worktree has this directory name');
  }, HARD_TIMEOUT_MS);

  it('still short-circuits on MONITOR_WORKTREE_ROOT, with no diagnostic', () => {
    const repo = makeRepo(2, 1);
    const run = inHooks(
      repo,
      `printf '%s %s\\n' "$(count_commits commandmate-issue-1728)" "$(count_uncommitted commandmate-issue-1728)"`,
      { MONITOR_WORKTREE_ROOT: repo.root },
    );

    expect(run.stdout.trim()).toBe('2 1');
    expect(run.stderr).toBe('');
  }, HARD_TIMEOUT_MS);
});
