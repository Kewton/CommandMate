/**
 * Machine-wide advisory lock for verification gates (Issue #1771).
 *
 * A gate that owns a fixed resource — a hard-coded port, a local database, an
 * emulator — can only run once per machine. Two parallel worktrees running it
 * at the same time make the second one fail on the resource, and the record
 * says `GATE e2e FAIL exit=1`, which is indistinguishable from the change being
 * broken. `mutex: <name>` in verify.yaml declares that constraint, and this
 * module is what enforces it.
 *
 * Three properties decide the implementation:
 *
 *   1. **It must hold across processes.** The lock exists because CommandMate's
 *      runner and the standalone `verify-run.sh` can be started independently
 *      against the same machine, so an in-process mutex would not be a lock at
 *      all. The path convention (`~/.commandmate/locks/<name>.lock`) is part of
 *      the contract, not an implementation detail — see
 *      docs/design/verification-config.md §9.
 *   2. **It must be portable.** macOS ships no `flock(1)`, so the primitive is
 *      `mkdir`, which is atomic on every POSIX filesystem and expressible in
 *      both bash and Node.
 *   3. **A crashed holder must not wedge the machine.** The owner record names
 *      the pid and host, so a lock left behind by a process that no longer
 *      exists is broken by the next waiter rather than blocking every future
 *      run until someone deletes a directory by hand.
 *
 * Server-only: reads and writes the filesystem.
 *
 * @module lib/verification/machine-lock
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/verification/machine-lock');

/**
 * Directory under `~/.commandmate` that holds the locks.
 *
 * Exported because `env-snapshot` has to know this name: the env-clean gate
 * lists the entries directly under `~/.commandmate` and would otherwise report
 * the runner's own bookkeeping as pollution the delegation left behind.
 */
export const MACHINE_LOCK_DIR_NAME = 'locks';

/**
 * Override for the lock root.
 *
 * Tests must never take a lock under the real `~/.commandmate/locks`: parallel
 * worktrees on a developer machine share that directory, so a suite that used
 * it would serialize against — and be failed by — unrelated live runs. Also
 * useful for isolating a CI runner from a shared home.
 */
export const MACHINE_LOCK_ROOT_ENV = 'CM_VERIFY_LOCK_ROOT';

/** How often a waiter re-tries the claim. */
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 250;

/** File inside the lock directory naming who holds it. */
const OWNER_FILE = 'owner';

/** The convention both runners follow: `<root>/<name>.lock`. */
export function machineLockPath(name: string, root: string): string {
  return join(root, `${name}.lock`);
}

export function defaultMachineLockRoot(): string {
  return join(homedir(), '.commandmate', MACHINE_LOCK_DIR_NAME);
}

export function resolveMachineLockRoot(
  env: Record<string, string | undefined> = process.env
): string {
  const override = env[MACHINE_LOCK_ROOT_ENV];
  return override && override.trim() !== '' ? override : defaultMachineLockRoot();
}

interface LockOwner {
  pid: number;
  host: string;
  /**
   * Distinguishes this acquisition from any later one under the same name.
   *
   * Without it, a holder whose lock was broken as stale (because its pid looked
   * dead) would delete the *next* holder's directory when it eventually
   * released, handing the resource to two runs at once.
   */
  token: string;
  acquiredAt: number;
}

export interface MachineLockHandle {
  name: string;
  /** Absolute path of the lock directory, so a report can name it. */
  path: string;
  /** Idempotent; only removes the directory while this acquisition still owns it. */
  release(): void;
}

export type MachineLockResult =
  | { acquired: true; handle: MachineLockHandle; waitedMs: number }
  | {
      acquired: false;
      waitedMs: number;
      /** Human-readable owner (`pid 4211 on host`), or null when unreadable. */
      heldBy: string | null;
    };

export interface AcquireMachineLockOptions {
  /** Total time to wait for the lock. A gate passes its own `timeoutSec`. */
  timeoutMs: number;
  root?: string;
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, OWNER_FILE), 'utf8')) as Partial<LockOwner>;
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === 'string' ? parsed.host : '',
      token: parsed.token,
      acquiredAt: typeof parsed.acquiredAt === 'number' ? parsed.acquiredAt : 0,
    };
  } catch {
    // Either the holder has not written the record yet (it created the
    // directory microseconds ago) or the file is corrupt. Both mean "held by
    // someone we cannot identify", which is a reason to wait, never to break.
    return null;
  }
}

function describeOwner(owner: LockOwner | null): string | null {
  return owner ? `pid ${owner.pid} on ${owner.host || 'unknown host'}` : null;
}

/**
 * Whether the recorded holder is gone.
 *
 * Only decidable on the machine that wrote the record: a pid from another host
 * says nothing about a process here, and killing a lock on that guess would let
 * two machines sharing a network home run the gate at once. Pid reuse can make
 * a dead holder look alive, which only costs a wait — the safe direction.
 */
function isStaleOwner(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** @returns true when this call created the directory and now owns it */
function claim(lockPath: string, owner: LockOwner): boolean {
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  writeFileSync(join(lockPath, OWNER_FILE), JSON.stringify(owner), { encoding: 'utf8' });
  return true;
}

/** Remove a lock whose recorded holder is gone, but only if it is still that record. */
function breakStale(lockPath: string, owner: LockOwner): void {
  const current = readOwner(lockPath);
  if (!current || current.token !== owner.token) return;
  try {
    rmSync(lockPath, { recursive: true, force: true });
    logger.warn('machine-lock-broken-stale', { lockPath, pid: owner.pid });
  } catch {
    // Someone else broke or re-took it first; the next attempt sorts it out.
  }
}

/**
 * Take the machine-wide lock named `name`, waiting up to `timeoutMs`.
 *
 * Never throws for the ordinary "someone else has it" case: the caller has to
 * report *not acquired* differently from *the gate failed*, and an exception
 * would collapse the two.
 */
export async function acquireMachineLock(
  name: string,
  options: AcquireMachineLockOptions
): Promise<MachineLockResult> {
  const root = options.root ?? resolveMachineLockRoot();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  const lockPath = machineLockPath(name, root);
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, options.timeoutMs);
  const token = randomUUID();

  mkdirSync(root, { recursive: true });

  // A stale record is broken at most once per token, so a directory nobody can
  // remove degrades into ordinary waiting instead of a spin loop.
  const broken = new Set<string>();

  for (;;) {
    const owner: LockOwner = { pid: process.pid, host: hostname(), token, acquiredAt: Date.now() };
    if (claim(lockPath, owner)) {
      return {
        acquired: true,
        waitedMs: Date.now() - startedAt,
        handle: {
          name,
          path: lockPath,
          release: () => {
            const current = readOwner(lockPath);
            // Ours was broken and re-taken while we ran. Deleting it now would
            // evict a live holder.
            if (current && current.token !== token) return;
            try {
              rmSync(lockPath, { recursive: true, force: true });
            } catch (error) {
              logger.warn('machine-lock-release-failed', {
                lockPath,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        },
      };
    }

    const holder = readOwner(lockPath);
    if (holder && !broken.has(holder.token) && isStaleOwner(holder)) {
      broken.add(holder.token);
      breakStale(lockPath, holder);
      continue;
    }

    const now = Date.now();
    if (now >= deadline) {
      return { acquired: false, waitedMs: now - startedAt, heldBy: describeOwner(holder) };
    }
    await sleep(Math.min(pollIntervalMs, deadline - now));
  }
}
