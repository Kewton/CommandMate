/**
 * Git command execution layer + per-worktree write serialization.
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 *
 * Owns the "execGit family" (execGitCommand / execGitCommandTyped /
 * execGitConflictAware / execGitNetworkAware), the per-worktree in-process
 * serialization (writeChains / runSerializedWrite / assertIndexNotLocked), and
 * the shared ConflictResult contract. Feature modules import their execution
 * primitives from here; typed errors come from git-errors.ts.
 *
 * Security considerations:
 * - Uses execFile (not exec) to prevent command injection
 * - worktreePath must be from DB only (trusted source)
 * - Error details are logged server-side, not exposed to client
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { GIT_WRITE_TIMEOUT_MS } from '@/config/git-status-config';
import {
  GitTimeoutError,
  GitNotRepoError,
  GitIndexLockedError,
  classifyNetworkStderr,
} from './git-errors';

const logger = createLogger('git-exec');

/**
 * Promisified execFile. Exported so the few helpers that must read stdout from a
 * non-zero exit (getCommitsByDateRange / getWorkingTreeDiff) share the exact same
 * binding the test suite mocks via `promisify`.
 */
export const execFileAsync = promisify(execFile);

/** Timeout for git commands in milliseconds */
const GIT_COMMAND_TIMEOUT_MS = 1000;

/** Timeout for git log/show/diff commands in milliseconds (Issue #447) */
export const GIT_LOG_TIMEOUT_MS = 3000;

/**
 * Execute a git command with timeout
 *
 * @param args - Git command arguments
 * @param cwd - Working directory (must be from DB, trusted source)
 * @returns Command output or null on error
 */
export async function execGitCommand(
  args: string[],
  cwd: string
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (error) {
    // Log error server-side only (no client exposure)
    logger.error('git:command-failed', {
      args: args.join(' '),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * Execute a git command with timeout, distinguishing error types
 * Unlike execGitCommand, this throws typed errors for API-level error handling.
 *
 * @param args - Git command arguments
 * @param cwd - Working directory (must be from DB, trusted source)
 * @param timeout - Timeout in milliseconds
 * @returns Command stdout
 * @throws {GitTimeoutError} When the command times out
 * @throws {GitNotRepoError} When the directory is not a git repository
 * @throws {Error} For other git errors
 */
export async function execGitCommandTyped(
  args: string[],
  cwd: string,
  timeout: number
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout,
    });
    return stdout;
  } catch (error) {
    const err = error as Error & { code?: string; killed?: boolean; stderr?: string };
    // Check for timeout
    if (err.killed || err.code === 'ERR_CHILD_PROCESS_EXEC_TIMEOUT' || err.code === 'ETIMEDOUT') {
      throw new GitTimeoutError(`Git command timed out after ${timeout}ms`);
    }
    // Check for "not a git repository"
    const stderr = err.stderr || err.message || '';
    if (stderr.includes('not a git repository')) {
      throw new GitNotRepoError('Not a git repository');
    }
    // Check for "unknown revision" / "bad object" (commit not found)
    const combinedMsg = `${err.stderr || ''} ${err.message || ''}`;
    if (combinedMsg.includes('unknown revision') || combinedMsg.includes('bad object')) {
      throw new Error(combinedMsg.trim());
    }
    // Issue #780: preserve "nothing to commit" so gitCommit can normalize it to
    // GitNothingToCommitError (400). Does not affect getGitStatus (execGitCommand).
    if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(combinedMsg)) {
      throw new Error(combinedMsg.trim());
    }
    // Issue #782: preserve "No local changes to save" so stashPush can normalize
    // it to GitNothingToStashError (400). Same approach as nothing-to-commit.
    if (/No local changes to save|No local changes/i.test(combinedMsg)) {
      throw new Error(combinedMsg.trim());
    }
    // Issue #781: preserve branch-operation stderr so checkout/create/delete can
    // normalize it to typed errors (branch_not_found / not_merged). Read-path
    // getGitStatus uses execGitCommand and is unaffected.
    if (
      /did not match|not a valid ref|not found|invalid reference|not fully merged|couldn't find remote ref/i.test(
        combinedMsg
      )
    ) {
      throw new Error(combinedMsg.trim());
    }
    // Log and re-throw generic error
    logger.error('git:command-failed', {
      args: args.join(' '),
      error: err.message,
    });
    throw new Error('Failed to execute git command');
  }
}

// ----------------------------------------------------------------------------
// Per-worktree in-process serialization + index.lock detection
// ----------------------------------------------------------------------------

/**
 * Module-level chain of in-flight write operations keyed by worktree path.
 * git's index can only safely accept one mutating operation at a time, so we
 * serialize all write ops for the same worktree within this process. (We do NOT
 * reuse the clone-manager DB-job pattern, which is built for long-lived clones.)
 */
const writeChains = new Map<string, Promise<unknown>>();

/**
 * Throw GitIndexLockedError if `.git/index.lock` exists for the worktree, which
 * indicates another git process (CLI, another server) is mid-write.
 *
 * Note: `.git` may be a file (worktree gitdir pointer) — in that case we cannot
 * cheaply resolve the lock path, so we skip the FS check and rely on git itself
 * to fail (which execGitCommandTyped surfaces). This is best-effort defense.
 */
function assertIndexNotLocked(worktreePath: string): void {
  const lockPath = path.join(worktreePath, '.git', 'index.lock');
  let exists = false;
  try {
    exists = fs.existsSync(lockPath);
  } catch {
    exists = false;
  }
  if (exists) {
    throw new GitIndexLockedError('Git index is locked (.git/index.lock exists)');
  }
}

/**
 * Run a write operation serialized per worktree path, after verifying the index
 * is not externally locked. Subsequent calls for the same path queue behind the
 * current one; failures do not break the chain for later callers.
 */
export async function runSerializedWrite<T>(
  worktreePath: string,
  op: () => Promise<T>
): Promise<T> {
  const previous = writeChains.get(worktreePath) ?? Promise.resolve();

  const run = previous
    .catch(() => undefined) // isolate prior failures from this op's gate
    .then(() => {
      assertIndexNotLocked(worktreePath);
      return op();
    });

  // Keep the chain alive regardless of this op's outcome. Store the SAME
  // settled promise we later compare against so cleanup can drop a stale entry.
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  writeChains.set(worktreePath, settled);

  try {
    return await run;
  } finally {
    // Best-effort cleanup: if no newer op queued behind us, drop the entry.
    if (writeChains.get(worktreePath) === settled) {
      writeChains.delete(worktreePath);
    }
  }
}

/**
 * Result of a stash pop/apply (and revert): clean completion vs. a conflict left
 * in the working tree (Issue #782). A conflict is a SUCCESS (the operation ran),
 * surfaced as `conflict: true` with the conflicted paths — never a throw.
 */
export interface ConflictResult {
  conflict: boolean;
  conflictFiles?: string[];
  /** For `pop`: git keeps the stash entry when the pop conflicts. */
  stashRetained?: boolean;
}

/** Extract `CONFLICT ... in <path>` file paths from git stdout (Issue #782). */
function parseConflictFiles(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/);
    if (m) files.push(m[1].trim());
  }
  return files;
}

/**
 * Run a git command that may legitimately exit non-zero on a CONFLICT, via
 * execFileAsync directly so the conflict patch on `err.stdout` is recoverable
 * (Issue #782, S3-002). execGitCommandTyped discards stdout on reject, so it
 * cannot be used here. We MANUALLY re-create the normalization
 * execGitCommandTyped would otherwise provide:
 *   - killed / ETIMEDOUT          -> GitTimeoutError (504)
 *   - "not a git repository"      -> GitNotRepoError (400)
 *   - exit-1 with CONFLICT stdout -> { conflict: true, conflictFiles }
 *   - any other failure           -> generic Error (500)
 *
 * The caller is responsible for running this inside runSerializedWrite (which
 * also performs the index.lock check), so serialization + lock detection are
 * preserved on this path too.
 */
export async function execGitConflictAware(
  args: string[],
  worktreePath: string,
  // Issue #783 (DR2-007): additive timeout param. The 3 existing callers
  // (stashPop / stashApply / gitRevert) omit it -> default GIT_WRITE_TIMEOUT_MS
  // -> byte-invariant (#782). gitPull (Part 2) will pass GIT_PULL_TIMEOUT_MS.
  timeout: number = GIT_WRITE_TIMEOUT_MS,
  // Issue #783 (DR4-002 / DR2-001): additive flag. When true (gitPull only), the
  // generic-failure branch routes stderr through classifyNetworkStderr (throwing
  // a typed network error) and does NOT log the raw err.message — which for an
  // HTTPS remote can echo a credential-bearing URL. The 3 #782 callers omit it
  // -> false -> existing log + generic Error -> byte-invariant.
  classifyNetwork = false
): Promise<ConflictResult> {
  try {
    await execFileAsync('git', args, { cwd: worktreePath, timeout });
    return { conflict: false };
  } catch (error) {
    const err = error as Error & {
      code?: string | number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };

    // Timeout BEFORE the conflict recovery so a killed process is never mistaken
    // for a "normal" conflicting exit.
    if (err.killed || err.code === 'ERR_CHILD_PROCESS_EXEC_TIMEOUT' || err.code === 'ETIMEDOUT') {
      throw new GitTimeoutError(`Git command timed out after ${timeout}ms`);
    }

    const combined = `${err.stderr || ''} ${err.message || ''}`;
    if (combined.includes('not a git repository')) {
      throw new GitNotRepoError('Not a git repository');
    }

    // A conflict leaves the merge markers and prints `CONFLICT ...` on stdout.
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    if (stdout.includes('CONFLICT')) {
      return { conflict: true, conflictFiles: parseConflictFiles(stdout) };
    }

    // Issue #783 (DR4-002 / DR2-001): the network path (gitPull) classifies the
    // stderr into a typed network error WITHOUT logging the raw message (which
    // can contain a credential-bearing remote URL). classifyNetworkStderr builds
    // the error with no message argument, so no stderr/URL is retained.
    if (classifyNetwork) {
      throw classifyNetworkStderr(combined);
    }

    logger.error('git:conflict-aware-failed', {
      args: args.join(' '),
      error: err.message,
    });
    throw new Error('Failed to execute git command');
  }
}

/**
 * Run a git NETWORK command (fetch / push) via execFileAsync directly (Issue
 * #783, §4.4.1). Mirrors execGitConflictAware's manual normalization but has no
 * conflict-recovery path (fetch/push don't leave merge markers):
 *   - killed / ETIMEDOUT     -> GitTimeoutError (504)
 *   - "not a git repository" -> GitNotRepoError (400)
 *   - any other failure      -> classifyNetworkStderr (typed network error)
 *
 * Does NOT use execGitCommandTyped (whose preserve regex stays unmodified) and
 * does NOT log the raw stderr/message (DR4-002): a failed network op's stderr can
 * echo a credential-bearing remote URL, and the typed error carries no message.
 */
export async function execGitNetworkAware(
  args: string[],
  worktreePath: string,
  timeout: number
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: worktreePath, timeout });
    return stdout;
  } catch (error) {
    const err = error as Error & { code?: string | number; killed?: boolean; stderr?: string };
    if (err.killed || err.code === 'ERR_CHILD_PROCESS_EXEC_TIMEOUT' || err.code === 'ETIMEDOUT') {
      throw new GitTimeoutError(`Git command timed out after ${timeout}ms`);
    }
    const combined = `${err.stderr || ''} ${err.message || ''}`;
    if (combined.includes('not a git repository')) {
      throw new GitNotRepoError('Not a git repository');
    }
    throw classifyNetworkStderr(combined);
  }
}
