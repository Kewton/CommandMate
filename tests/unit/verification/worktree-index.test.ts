/**
 * Unit tests for the per-worktree index (Issue #1771).
 *
 * The two properties the registry exists to guarantee are asserted directly,
 * because CommandMate does not number worktrees and this module invents the
 * number: the same worktree always gets the same one, and no two worktrees ever
 * share one. A hash would have satisfied only the first.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  defaultWorktreeIndexRoot,
  hashWorktreeIndex,
  MAX_WORKTREE_INDEX,
  resolveWorktreeIndex,
  resolveWorktreeIndexRoot,
  WORKTREE_INDEX_DIR_NAME,
  WORKTREE_INDEX_ROOT_ENV,
} from '@/lib/verification/worktree-index';
import { removeTempDir } from '@tests/helpers/temp-dir';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worktree-index-'));
});

afterEach(() => {
  removeTempDir(root);
});

const index = (worktreeId: string): number => resolveWorktreeIndex(worktreeId, { root });

describe('resolveWorktreeIndexRoot', () => {
  it('defaults under ~/.commandmate', () => {
    expect(resolveWorktreeIndexRoot({})).toBe(defaultWorktreeIndexRoot());
    expect(
      defaultWorktreeIndexRoot().endsWith(join('.commandmate', WORKTREE_INDEX_DIR_NAME))
    ).toBe(true);
  });

  it('honours the override so a test never claims a slot in the shared registry', () => {
    expect(resolveWorktreeIndexRoot({ [WORKTREE_INDEX_ROOT_ENV]: '/tmp/reg' })).toBe('/tmp/reg');
  });
});

describe('resolveWorktreeIndex', () => {
  it('gives the same worktree the same number every time', () => {
    const first = index('commandmate-issue-1771');
    expect(index('commandmate-issue-1771')).toBe(first);
    expect(index('commandmate-issue-1771')).toBe(first);
  });

  it('never gives two worktrees the same number', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `worktree-${i}`);
    const assigned = ids.map(index);
    expect(new Set(assigned).size).toBe(ids.length);
  });

  it('starts at 0 and fills the lowest free slot', () => {
    expect(index('a')).toBe(0);
    expect(index('b')).toBe(1);
    expect(index('c')).toBe(2);
  });

  it('keeps a deleted worktree\'s slot rather than reusing it', () => {
    // Reusing a freed number would move a *live* worktree onto a port a stale
    // server from the deleted one may still hold.
    index('a');
    const b = index('b');
    index('c');

    // `b` never comes back; a fourth worktree must not inherit its number.
    expect(index('d')).not.toBe(b);
    expect(index('b')).toBe(b);
  });

  it('survives the process: the assignment is on disk, not in memory', () => {
    const first = index('persisted');
    expect(readdirSync(root)).toContain(String(first));
    expect(readFileSync(join(root, String(first)), 'utf8').trim()).toBe('persisted');
  });

  it('takes over a slot claim written by another runner for the same worktree', () => {
    // The standalone runner follows the same convention; a slot it wrote is the
    // answer here, not a reason to claim a second one.
    writeFileSync(join(root, '7'), 'external\n');
    expect(index('external')).toBe(7);
    expect(readdirSync(root).sort()).toEqual(['7']);
  });

  it('ignores entries that are not slot numbers', () => {
    writeFileSync(join(root, 'README'), 'not a slot\n');
    expect(index('only')).toBe(0);
  });

  it('falls back to a deterministic hash when the registry cannot be used', () => {
    // A file where the directory should be: mkdir fails, and the gate still has
    // to receive *some* number — an unset CM_WORKTREE_INDEX expands to 0 in
    // shell arithmetic, which would give every worktree the same port.
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'not a directory\n');
    const viaHash = resolveWorktreeIndex('wt', { root: join(blocked, 'registry') });
    expect(viaHash).toBe(hashWorktreeIndex('wt'));
    expect(resolveWorktreeIndex('wt', { root: join(blocked, 'registry') })).toBe(viaHash);
  });

  it('always returns a number inside the documented range', () => {
    for (const id of ['a', 'b', 'zzzzzzzzzzzz', '1', 'worktree-with-a-very-long-identifier']) {
      const value = index(id);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(MAX_WORKTREE_INDEX);
    }
  });
});
