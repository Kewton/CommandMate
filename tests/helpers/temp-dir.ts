/**
 * Sandbox temp-directory helpers (Issue #1663).
 *
 * Tests that spawn real processes (git, tmux, the CLI) against a `mkdtemp`
 * sandbox used to tear the sandbox down with a bare
 * `rmSync(dir, { recursive: true, force: true })`. That is correct only while
 * nothing else writes into the tree: the recursive walk reads a directory,
 * removes what it saw, then `rmdir`s the directory itself. A file that appears
 * *after* the walk read that directory makes the final `rmdir` fail with
 * `ENOTEMPTY`, and because the call sits in `afterEach`, the whole test file
 * goes red for a reason that has nothing to do with what it asserted
 * (PR #1660: `ENOTEMPTY: rmdir '/tmp/gate-runner-UwYY3F/.git/objects'`).
 *
 * Node's own `maxRetries`/`retryDelay` are necessary but *not* sufficient here.
 * Their retry loop only re-issues `rmdir()` on the same path — it never
 * re-scans — so once a child directory has been re-created with content in it,
 * every internal retry fails the same way. `removeTempDir` therefore wraps the
 * whole recursive walk in its own attempt loop: a fresh `rmSync` re-reads the
 * tree and clears whatever appeared during the previous pass.
 *
 * Cleanup failure is reported, not thrown. The assertions of a test that has
 * already finished are not invalidated by a leftover sandbox, and throwing out
 * of `afterEach` is exactly the flake this helper exists to remove. But a
 * silently abandoned sandbox eats disk, so a failed removal writes the path to
 * stderr and is recorded in `getLeakedTempDirs()`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Attempts of the *whole* recursive walk. Each one re-scans the tree. */
export const TEMP_DIR_REMOVE_ATTEMPTS = 4;
/** Handed to `rmSync`: retries of the final `rmdir` within a single walk. */
export const TEMP_DIR_RM_MAX_RETRIES = 5;
/** Node waits `retryDelay * i` before internal retry `i` (linear backoff). */
export const TEMP_DIR_RM_RETRY_DELAY_MS = 20;
/** Pause before re-walking, so a writer that is finishing up can finish. */
const ATTEMPT_BACKOFF_MS = 25;

/** Prefix of the stderr line written when a sandbox survives every attempt. */
export const TEMP_DIR_LEAK_PREFIX = '[temp-dir] left behind sandbox:';

const leakedTempDirs: string[] = [];

/** Sleep without touching timers, so fake-timer tests are unaffected. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RemoveTempDirOptions {
  /** Total attempts of the full recursive walk. */
  attempts?: number;
  /** Called after a failed attempt that will be retried. */
  onRetry?: (error: NodeJS.ErrnoException, attempt: number) => void;
}

/**
 * Create a sandbox under the OS temp directory.
 *
 * `prefix` is used verbatim, so pass the trailing separator you want
 * (`makeTempDir('gate-runner-')` → `/tmp/gate-runner-XXXXXX`).
 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Remove a sandbox, tolerating writes that land during the walk.
 *
 * Never throws. Returns `true` when the path is gone, `false` when it survived
 * every attempt — in which case the path is reported on stderr and appended to
 * `getLeakedTempDirs()`.
 */
export function removeTempDir(
  target: string | null | undefined,
  options: RemoveTempDirOptions = {}
): boolean {
  if (!target) return true;

  const attempts = Math.max(1, options.attempts ?? TEMP_DIR_REMOVE_ATTEMPTS);
  let lastError: NodeJS.ErrnoException | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: TEMP_DIR_RM_MAX_RETRIES,
        retryDelay: TEMP_DIR_RM_RETRY_DELAY_MS,
      });
      return true;
    } catch (error) {
      lastError = error as NodeJS.ErrnoException;
      if (attempt === attempts) break;
      options.onRetry?.(lastError, attempt);
      sleepSync(ATTEMPT_BACKOFF_MS * attempt);
    }
  }

  leakedTempDirs.push(target);
  // stderr rather than console.warn: plenty of tests spy on console, and a
  // cleanup warning must not show up in their assertions.
  process.stderr.write(
    `${TEMP_DIR_LEAK_PREFIX} ${target} (${lastError?.code ?? 'unknown'}: ${lastError?.message ?? 'no error'})\n`
  );
  return false;
}

/** Sandboxes this process failed to remove, oldest first. */
export function getLeakedTempDirs(): readonly string[] {
  return [...leakedTempDirs];
}

/** Test-only: clear the leak ledger. */
export function resetLeakedTempDirs(): void {
  leakedTempDirs.length = 0;
}
