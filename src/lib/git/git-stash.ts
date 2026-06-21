/**
 * Git stash list (READ) + push / pop / apply / drop (WRITE).
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 */

import type { StashInfo } from '@/types/git';
import { GIT_WRITE_TIMEOUT_MS } from '@/config/git-status-config';
import { createLogger } from '@/lib/logger';
import {
  execGitCommand,
  execGitCommandTyped,
  execGitConflictAware,
  runSerializedWrite,
  type ConflictResult,
} from './git-exec';
import { GitNothingToStashError } from './git-errors';

const logger = createLogger('git-stash');

/**
 * Tab-separated `git stash list` format (Issue #782). `%x09` is a literal TAB,
 * matching the for-each-ref / commit-log delimiter policy:
 *   %gd  -> the `stash@{N}` selector
 *   %s   -> the stash subject
 *   %cI  -> committer date (ISO8601)
 *   %H   -> the stash commit's full hash
 */
const STASH_LIST_FORMAT = '--format=%gd%x09%s%x09%cI%x09%H';

/** Matches a `stash@{N}` selector (the `%gd` field) and captures N. */
const STASH_SELECTOR_PATTERN = /^stash@\{(\d+)\}$/;

/**
 * Extract the branch from a stash subject (`%s`). git writes
 * `WIP on <branch>: <sha> <msg>` (auto) or `On <branch>: <msg>` (manual `-m`).
 * Returns the branch, or null when neither prefix is present.
 */
function extractStashBranch(subject: string): string | null {
  const wip = subject.match(/^WIP on ([^:]+):/);
  if (wip) return wip[1].trim() || null;
  const on = subject.match(/^On ([^:]+):/);
  if (on) return on[1].trim() || null;
  return null;
}

/**
 * Parse `git stash list --format='%gd%x09%s%x09%cI%x09%H'` output into
 * StashInfo[] (Issue #782). Same tab-split policy as parseForEachRefTracking.
 * Lines whose `%gd` does not match `stash@{N}` are skipped; empty output -> [].
 *
 * @param output - Raw stdout from the formatted `git stash list`
 * @returns Parsed StashInfo entries in list order
 */
export function parseStashList(output: string): StashInfo[] {
  const stashes: StashInfo[] = [];
  if (!output || !output.trim()) return stashes;

  for (const rawLine of output.split('\n')) {
    if (!rawLine.trim()) continue;
    const [selector = '', message = '', date = '', sha = ''] = rawLine.split('\t');
    const match = selector.match(STASH_SELECTOR_PATTERN);
    if (!match) continue;
    stashes.push({
      index: parseInt(match[1], 10),
      message,
      branch: extractStashBranch(message),
      date,
      sha,
    });
  }
  return stashes;
}

/**
 * List the stashes for a worktree (Issue #782, READ path).
 *
 * Independent of getGitStatus / the 1s execGitCommand read path (#779/#780/#781
 * stays byte-invariant). Uses the non-throwing 1s execGitCommand and degrades
 * best-effort: any failure yields `[]` (200 at the API layer) rather than
 * breaking the section, exactly like listBranches. NEVER throws.
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @returns Array of StashInfo (empty array if the read fails)
 */
export async function getStashList(worktreePath: string): Promise<StashInfo[]> {
  const output = await execGitCommand(['stash', 'list', STASH_LIST_FORMAT], worktreePath);
  if (output === null) return [];
  return parseStashList(output);
}

/** Options for stashPush (Issue #782). */
export interface StashPushOptions {
  message?: string;
  includeUntracked?: boolean;
}

/**
 * Stash the working tree: `git stash push [--include-untracked] [-m <msg>] --`
 * (Issue #782, WRITE path). Serialized per worktree; the trailing `--` blocks
 * pathspec/option injection. "No local changes to save" is normalized to
 * GitNothingToStashError (400), mirroring gitCommit's nothing-to-commit handling.
 *
 * @throws {GitNothingToStashError} working tree is clean
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function stashPush(
  worktreePath: string,
  options: StashPushOptions
): Promise<void> {
  const { message, includeUntracked } = options;
  await runSerializedWrite(worktreePath, async () => {
    const args = ['stash', 'push'];
    if (includeUntracked) args.push('--include-untracked');
    if (message) args.push('-m', message);
    args.push('--');
    try {
      await execGitCommandTyped(args, worktreePath, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      const stderr = (error as { stderr?: string })?.stderr ?? '';
      if (/No local changes to save|No stash entries|No local changes/i.test(`${stderr} ${msg}`)) {
        throw new GitNothingToStashError('No local changes to stash');
      }
      throw error;
    }
  });
}

/**
 * Pop a stash: `git stash pop -- stash@{N}` (Issue #782, WRITE path). The index
 * is a validated non-negative integer, so the `stash@{N}` string is injection-
 * free. A conflict returns `{ conflict: true, conflictFiles, stashRetained: true }`
 * (git keeps the stash) — NOT a throw. Serialized per worktree; index.lock and
 * timeout are honored (S3-002).
 */
export async function stashPop(worktreePath: string, index: number): Promise<ConflictResult> {
  return runSerializedWrite(worktreePath, async () => {
    const result = await execGitConflictAware(
      ['stash', 'pop', '--', `stash@{${index}}`],
      worktreePath
    );
    // git does NOT drop a stash whose pop conflicted; reflect that to the client.
    if (result.conflict) {
      return { ...result, stashRetained: true };
    }
    return result;
  });
}

/**
 * Apply a stash without dropping it: `git stash apply -- stash@{N}` (Issue #782).
 * Conflict handling mirrors stashPop (apply already keeps the stash regardless).
 */
export async function stashApply(worktreePath: string, index: number): Promise<ConflictResult> {
  return runSerializedWrite(worktreePath, async () => {
    return execGitConflictAware(['stash', 'apply', '--', `stash@{${index}}`], worktreePath);
  });
}

/**
 * Drop a stash: `git stash drop -- stash@{N}` (Issue #782, WRITE path). No
 * conflict path (drop never conflicts). Serialized per worktree.
 *
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function stashDrop(worktreePath: string, index: number): Promise<void> {
  logger.warn('git:danger:stash-drop', {
    operation: 'stash-drop',
    worktreePath,
    index,
    timestamp: new Date().toISOString(),
  });
  await runSerializedWrite(worktreePath, async () => {
    await execGitCommandTyped(
      ['stash', 'drop', '--', `stash@{${index}}`],
      worktreePath,
      GIT_WRITE_TIMEOUT_MS
    );
  });
}
