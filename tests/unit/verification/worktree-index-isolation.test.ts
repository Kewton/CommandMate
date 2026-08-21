/**
 * The suite must not claim slots in the developer's real registry (Issue #1873).
 *
 * `executeRun` mints `CM_WORKTREE_INDEX` through `resolveWorktreeIndex(worktreeId)`
 * with no `root`, so without an override every `wt-*` fixture that reaches a
 * command gate burns a slot in `~/.commandmate/worktree-index/` — permanently,
 * because the registry deliberately never releases one. Measured before the fix:
 * a clean `HOME` collected 26 entries from four test files, none of which had
 * ever been a worktree.
 *
 * `tests/setup.ts` pins the override for the whole suite. This file is the guard
 * on that pin: deleting those lines turns this red instead of quietly resuming
 * the writes, which is the failure mode that let the leak run unnoticed for a
 * release. It asserts the *effective* root — the one production code will read —
 * rather than the spelling of the setup file, so an override arriving any other
 * way (isolated CI runner, `vi.stubEnv`) is equally acceptable.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';
import {
  defaultWorktreeIndexRoot,
  resolveWorktreeIndex,
  resolveWorktreeIndexRoot,
  WORKTREE_INDEX_ROOT_ENV,
} from '@/lib/verification/worktree-index';

const underHome = (path: string): boolean =>
  path === homedir() || path.startsWith(homedir() + sep);

describe('Issue #1873: the unit suite never numbers worktrees in the real home', () => {
  it('resolves the registry root outside the home directory', () => {
    // The exact assertion production code makes: no argument, real process.env.
    expect(underHome(resolveWorktreeIndexRoot())).toBe(false);
  });

  it('is not asserting a tautology — the unpinned default *is* under home', () => {
    // Without this, the test above would keep passing on a machine where
    // `homedir()` happened to be unusual, and prove nothing.
    expect(underHome(defaultWorktreeIndexRoot())).toBe(true);
    expect(resolveWorktreeIndexRoot({})).toBe(defaultWorktreeIndexRoot());
  });

  it('pins the override to a value the resolver actually honours', () => {
    // A blank value is the trap: `resolveWorktreeIndexRoot` treats empty and
    // whitespace as unset and falls back to home, so "the variable is set" is
    // not the property worth asserting.
    const pinned = process.env[WORKTREE_INDEX_ROOT_ENV];
    expect(pinned).toBeDefined();
    expect(pinned?.trim()).not.toBe('');
    expect(resolveWorktreeIndexRoot()).toBe(pinned);
  });

  it('sends a real claim to the pinned root and not to the home registry', () => {
    // The end-to-end property, exercised the way `gate-runner.ts` does it: no
    // `root` argument. Reads of the real registry are read-only on purpose —
    // it holds live worktrees' numbers and is not this suite's to tidy.
    const real = defaultWorktreeIndexRoot();
    const before = existsSync(real) ? readdirSync(real).length : 0;

    const worktreeId = 'wt-1873-isolation-probe';
    const slot = resolveWorktreeIndex(worktreeId);

    expect(readFileSync(join(resolveWorktreeIndexRoot(), String(slot)), 'utf8').trim()).toBe(
      worktreeId
    );
    expect(existsSync(real) ? readdirSync(real).length : 0).toBe(before);
  });
});
