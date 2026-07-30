import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `.commandmate/` is excluded wholesale because the app writes runtime data into
 * it (chat attachments, caches). A few files in it are *configuration* and must
 * be committed so the team shares them:
 *
 *   .commandmate/verify.yaml    verification gates  (#1540)
 *   .commandmate/tasks/*.yaml   execution contracts (#1545)
 *
 * A config file that is silently ignored is indistinguishable from a tracked one
 * until somebody clones the repo and finds it missing, so the rule is pinned here.
 *
 * The subtlety worth protecting: adding a single `!` line for a file inside a new
 * subdirectory does NOT work, because git never descends into an excluded
 * directory and so never evaluates the negation. The directory has to be
 * un-excluded first, then its contents narrowed.
 */

const REPO_ROOT = process.cwd();
const CHECKER = path.join(REPO_ROOT, 'scripts/check-commandmate-tracking.sh');

/**
 * True when git would ignore `target`.
 *
 * Judged by exit code (0 = ignored, 1 = tracked), never by whether `-v` printed
 * something: with `-v` git also prints the matching *negation* line for paths
 * that are not ignored, so "produced output" misreads a tracked file as ignored.
 *
 * `--no-index` is load-bearing. Without it check-ignore consults the index and
 * calls any already-tracked file "not ignored" regardless of the rules, so the
 * assertions on committed files (verify.yaml) would pass even with their `!`
 * line deleted — a vacuous green. Verified by mutation: dropping the negation
 * leaves this suite passing without the flag, and fails it with the flag.
 *
 * `git check-ignore` evaluates a pathname against the rules and does not require
 * the file to exist, so these assertions never touch the working tree.
 */
function isIgnored(target: string): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', target], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git check-ignore failed for ${target}: status=${result.status} ${result.stderr}`,
    );
  }
  return result.status === 0;
}

describe('.commandmate/ tracking policy', () => {
  // Configuration: committed and shared.
  it.each([
    ['.commandmate/verify.yaml', 'verification gates (#1540)'],
    ['.commandmate/tasks/build.yaml', 'execution contract (#1545)'],
    ['.commandmate/tasks/any-name.yaml', 'contract under an arbitrary name'],
  ])('tracks %s — %s', (target) => {
    expect(isIgnored(target)).toBe(false);
  });

  // Runtime output: must stay out of the repository.
  it.each([
    ['.commandmate/attachments/a.png', 'chat attachment written by the app'],
    ['.commandmate/cache.json', 'unknown runtime file'],
    ['.commandmate/tasks/scratch.log', 'log dropped beside a contract'],
    ['.commandmate/tasks/notes.md', 'non-yaml dropped beside a contract'],
  ])('ignores %s — %s', (target) => {
    expect(isIgnored(target)).toBe(true);
  });
});

describe('scripts/check-commandmate-tracking.sh', () => {
  it('passes bash -n (bash 3.2 syntax gate)', () => {
    execFileSync('bash', ['-n', CHECKER], { encoding: 'utf8' });
  });

  it('reports OK on the current .gitignore', () => {
    // The script is what a developer runs by hand; if it and the rules above ever
    // disagree, one of them is wrong and CI should say so rather than let the
    // human-facing tool drift away from the pinned policy.
    const result = spawnSync('bash', [CHECKER], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.stdout + result.stderr).toContain('OK:');
    expect(result.status).toBe(0);
  });
});
