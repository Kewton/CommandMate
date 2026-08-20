/**
 * A small, stable integer per worktree, handed to gates as `CM_WORKTREE_INDEX`
 * (Issue #1771).
 *
 * The point is to let a repository *remove* the collision rather than serialize
 * around it: a gate written as `E2E_PORT=$((60400+CM_WORKTREE_INDEX)) npm run
 * test:e2e` gives every worktree its own port, so N parallel worktrees keep N-way
 * parallelism. `mutex:` is the fallback for resources that cannot be
 * parameterized at all; this is the one that preserves throughput.
 *
 * **CommandMate does not number worktrees.** The Issue assumed it did; it does
 * not. `worktrees.id` is a TEXT primary key derived from the directory basename
 * (`src/lib/git/worktree-id.ts:73`), the table has no ordinal column and no
 * creation timestamp (`src/lib/db/migrations/v01-v05-initial-schema.ts:104`),
 * and the only ordering any query applies is `updated_at DESC`
 * (`src/lib/db/worktree-db.ts:113`), which reorders itself every time an agent
 * writes a message. So the number is minted here, and the requirement it has to
 * meet is stated rather than inherited:
 *
 *   - **Same worktree, same number.** The assignment is persisted, so it
 *     survives restarts, re-registration and database resets.
 *   - **No two live worktrees share a number.** The claim is an `O_EXCL` file
 *     create, which is atomic, so two processes racing for the same slot cannot
 *     both win it.
 *
 * A hash of the worktree id would have satisfied only the first: 30 worktrees
 * over 1024 slots collide about 35% of the time, and a collision here is exactly
 * the port clash the feature exists to remove. It is kept only as the fallback
 * for a machine where the registry cannot be written at all, because a gate
 * expanding `$((60400+CM_WORKTREE_INDEX))` with the variable unset would give
 * *every* worktree port 60400.
 *
 * Layout: `~/.commandmate/worktree-index/<n>` is a file whose content is the
 * worktree id that owns `n`. Deleting a worktree leaves its slot claimed, which
 * is deliberate — reusing it would move a live worktree's number.
 *
 * Server-only: reads and writes the filesystem.
 *
 * @module lib/verification/worktree-index
 */

import { createHash } from 'crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/verification/worktree-index');

/**
 * Directory under `~/.commandmate` holding the registry.
 *
 * Exported for the same reason as {@link MACHINE_LOCK_DIR_NAME}: env-clean
 * lists `~/.commandmate` and must not read the runner's own bookkeeping as
 * something the delegation left behind.
 */
export const WORKTREE_INDEX_DIR_NAME = 'worktree-index';

/** Override for the registry root; tests and isolated runners use it. */
export const WORKTREE_INDEX_ROOT_ENV = 'CM_VERIFY_WORKTREE_INDEX_ROOT';

/**
 * Highest index the registry hands out.
 *
 * Also the modulus of the fallback hash, so both paths produce a number a
 * repository can add to a port base without leaving the ephemeral range.
 */
export const MAX_WORKTREE_INDEX = 1024;

export function defaultWorktreeIndexRoot(): string {
  return join(homedir(), '.commandmate', WORKTREE_INDEX_DIR_NAME);
}

export function resolveWorktreeIndexRoot(
  env: Record<string, string | undefined> = process.env
): string {
  const override = env[WORKTREE_INDEX_ROOT_ENV];
  return override && override.trim() !== '' ? override : defaultWorktreeIndexRoot();
}

/** Last-resort number for a machine whose registry cannot be written. */
export function hashWorktreeIndex(worktreeId: string): number {
  const digest = createHash('sha256').update(worktreeId).digest('hex').slice(0, 8);
  return Number.parseInt(digest, 16) % MAX_WORKTREE_INDEX;
}

function readSlotOwner(root: string, slot: string): string | null {
  try {
    return readFileSync(join(root, slot), 'utf8').trim();
  } catch {
    return null;
  }
}

function claimSlot(root: string, index: number, worktreeId: string): boolean {
  try {
    writeFileSync(join(root, String(index)), `${worktreeId}\n`, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Lost the race — unless the winner is us, which happens when two runners
    // for the same worktree start together on different processes.
    return readSlotOwner(root, String(index)) === worktreeId;
  }
}

/**
 * The index for `worktreeId`, claiming one if it has none yet.
 *
 * @param root registry directory; defaults to {@link resolveWorktreeIndexRoot}
 * @returns a number in `[0, MAX_WORKTREE_INDEX)`; never throws
 */
export function resolveWorktreeIndex(
  worktreeId: string,
  options: { root?: string } = {}
): number {
  const root = options.root ?? resolveWorktreeIndexRoot();
  try {
    mkdirSync(root, { recursive: true });

    const taken = new Set<number>();
    for (const name of readdirSync(root)) {
      if (!/^\d+$/.test(name)) continue;
      if (readSlotOwner(root, name) === worktreeId) return Number(name);
      taken.add(Number(name));
    }

    for (let index = 0; index < MAX_WORKTREE_INDEX; index++) {
      if (taken.has(index)) continue;
      if (claimSlot(root, index, worktreeId)) return index;
    }
    logger.warn('worktree-index-exhausted', { worktreeId, root });
  } catch (error) {
    logger.warn('worktree-index-unavailable', {
      worktreeId,
      root,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // Deterministic, so a machine stuck on the fallback still gives each worktree
  // the *same* number every run — it just cannot promise they are all distinct.
  return hashWorktreeIndex(worktreeId);
}
