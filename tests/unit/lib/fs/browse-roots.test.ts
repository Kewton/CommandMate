/**
 * Unit tests for the allowed-browse-roots resolver (Issue #1517).
 *
 * These pin the contract the whole feature rests on: `/api/fs/browse`,
 * `/api/repositories/scan` and `/api/repositories/validate-path` all call
 * `resolveAllowedPath()`, so whatever the picker can offer must also register.
 *
 * Real directories are used rather than mocked ones because the resolver's
 * second layer is `resolveAndValidateRealPath()`, which reads the filesystem —
 * mocking it away would test nothing about symlink escapes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ CM_ROOT_DIR: '/placeholder' })),
}));

import { getEnv } from '@/lib/env';
import {
  getAllowedBrowseRoots,
  resolveAllowedPath,
  formatAllowedRoots,
} from '@/lib/fs/browse-roots';

let sandbox: string;
/** Stands in for CM_ROOT_DIR. */
let managedRoot: string;
/** Stands in for an entry in CM_BROWSE_ROOTS. */
let extraRoot: string;
/** Outside every root. */
let foreignDir: string;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'cm-1517-roots-'));
  managedRoot = path.join(sandbox, 'repos');
  extraRoot = path.join(sandbox, 'work');
  foreignDir = path.join(sandbox, 'elsewhere');

  mkdirSync(path.join(managedRoot, 'repo-a'), { recursive: true });
  mkdirSync(path.join(extraRoot, 'repo-b'), { recursive: true });
  mkdirSync(path.join(foreignDir, 'secrets'), { recursive: true });

  // A symlink inside the managed root that points outside every root.
  symlinkSync(foreignDir, path.join(managedRoot, 'escape-link'), 'dir');
  // A symlink inside the managed root that stays inside it.
  symlinkSync(path.join(managedRoot, 'repo-a'), path.join(managedRoot, 'inside-link'), 'dir');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(getEnv).mockReturnValue({ CM_ROOT_DIR: managedRoot } as never);
  delete process.env.CM_BROWSE_ROOTS;
});

describe('getAllowedBrowseRoots', () => {
  it('is just CM_ROOT_DIR when CM_BROWSE_ROOTS is unset', () => {
    expect(getAllowedBrowseRoots()).toEqual([managedRoot]);
  });

  it('unions CM_BROWSE_ROOTS with CM_ROOT_DIR, CM_ROOT_DIR first', () => {
    process.env.CM_BROWSE_ROOTS = `${extraRoot},${foreignDir}`;

    expect(getAllowedBrowseRoots()).toEqual([managedRoot, extraRoot, foreignDir]);
  });

  it('trims entries, drops blanks, and de-duplicates CM_ROOT_DIR', () => {
    process.env.CM_BROWSE_ROOTS = `  ${extraRoot} , , ${managedRoot}`;

    expect(getAllowedBrowseRoots()).toEqual([managedRoot, extraRoot]);
  });
});

describe('resolveAllowedPath', () => {
  it('accepts a directory inside CM_ROOT_DIR', () => {
    const result = resolveAllowedPath(path.join(managedRoot, 'repo-a'));

    expect(result.ok).toBe(true);
    expect(result.ok && result.resolvedPath).toBe(path.join(managedRoot, 'repo-a'));
    expect(result.ok && result.root).toBe(managedRoot);
  });

  it('accepts a directory inside an extra CM_BROWSE_ROOTS entry (OR evaluation)', () => {
    const outsideManaged = resolveAllowedPath(path.join(extraRoot, 'repo-b'));
    expect(outsideManaged.ok).toBe(false);

    process.env.CM_BROWSE_ROOTS = extraRoot;
    const result = resolveAllowedPath(path.join(extraRoot, 'repo-b'));

    expect(result.ok).toBe(true);
    expect(result.ok && result.root).toBe(extraRoot);
  });

  it('resolves a relative path against CM_ROOT_DIR', () => {
    // Pre-#1517 scan behaviour: a bare name meant "inside the managed scope".
    const result = resolveAllowedPath('repo-a');

    expect(result.ok).toBe(true);
    expect(result.ok && result.resolvedPath).toBe(path.join(managedRoot, 'repo-a'));
  });

  it.each([
    ['a directory outside every root', () => path.join(foreignDir, 'secrets')],
    ['a system directory', () => '/etc'],
    ['a relative traversal escape', () => '../../etc'],
    ['a traversal escape that re-enters the root', () => `${managedRoot}/../../etc`],
    ['a URL-encoded traversal escape', () => '%2e%2e%2f%2e%2e%2fetc'],
  ])('rejects %s as outside-roots', (_label, makePath) => {
    const result = resolveAllowedPath(makePath());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('outside-roots');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a null byte injection', 'repo-a\x00.txt'],
    ['a non-string', 42],
  ])('rejects %s as invalid', (_label, candidate) => {
    const result = resolveAllowedPath(candidate);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid');
  });

  it('rejects a symlink that escapes the root', () => {
    const result = resolveAllowedPath(path.join(managedRoot, 'escape-link'));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('symlink-escape');
  });

  it('accepts a symlink that stays inside the root', () => {
    const result = resolveAllowedPath(path.join(managedRoot, 'inside-link'));

    expect(result.ok).toBe(true);
  });

  it('skips a configured root that does not exist on disk', () => {
    const missingRoot = path.join(sandbox, 'does-not-exist');
    process.env.CM_BROWSE_ROOTS = missingRoot;

    const result = resolveAllowedPath(path.join(missingRoot, 'repo'));

    expect(result.ok).toBe(false);
    // Not "symlink-escape": a missing root simply cannot contain anything.
    expect(!result.ok && result.reason).toBe('outside-roots');
  });

  it('reports the allowed roots on every rejection so callers can explain why', () => {
    process.env.CM_BROWSE_ROOTS = extraRoot;

    const result = resolveAllowedPath('/etc');

    expect(result.roots).toEqual([managedRoot, extraRoot]);
    expect(formatAllowedRoots(result.roots)).toBe(`${managedRoot}, ${extraRoot}`);
  });
});
