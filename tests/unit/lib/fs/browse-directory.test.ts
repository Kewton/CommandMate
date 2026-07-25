/**
 * Unit tests for directory listing (Issue #1517).
 *
 * The security-relevant assertion here is the negative one: file names must
 * never appear in the result. The picker only needs folders, and returning file
 * names would make an allowed root a filesystem read oracle.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { listDirectories, countWorktrees, isGitRepositoryPath } from '@/lib/fs/browse-directory';
import { BROWSE_ENTRY_LIMIT } from '@/lib/fs/browse-roots';

let sandbox: string;
let root: string;
let outsideDir: string;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'cm-1517-listing-'));
  root = path.join(sandbox, 'root');
  outsideDir = path.join(sandbox, 'outside');

  mkdirSync(path.join(root, 'alpha'), { recursive: true });
  mkdirSync(path.join(root, 'beta'), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  // A dotfile directory and a dotfile: both must stay hidden.
  mkdirSync(path.join(root, '.hidden-dir'), { recursive: true });
  writeFileSync(path.join(root, '.env'), 'SECRET=xxx');

  // Files must not be listed at all.
  writeFileSync(path.join(root, 'notes.txt'), 'plain file');
  writeFileSync(path.join(root, 'package.json'), '{}');

  // 'alpha' is a repository with two linked worktrees -> git reports 3.
  mkdirSync(path.join(root, 'alpha', '.git', 'worktrees', 'wt-1'), { recursive: true });
  mkdirSync(path.join(root, 'alpha', '.git', 'worktrees', 'wt-2'), { recursive: true });

  // 'beta' is a repository with no linked worktrees -> git reports 1.
  mkdirSync(path.join(root, 'beta', '.git'), { recursive: true });

  mkdirSync(path.join(root, 'plain-folder'), { recursive: true });

  symlinkSync(path.join(root, 'alpha'), path.join(root, 'inside-link'), 'dir');
  symlinkSync(outsideDir, path.join(root, 'escape-link'), 'dir');
  symlinkSync(path.join(root, 'notes.txt'), path.join(root, 'file-link'), 'file');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('listDirectories', () => {
  it('returns directories only — never file names', () => {
    const { entries } = listDirectories(root, root);
    const names = entries.map((entry) => entry.name);

    expect(names).not.toContain('notes.txt');
    expect(names).not.toContain('package.json');
    expect(names).not.toContain('file-link');
    // Nothing in the serialized payload may leak a file name either.
    expect(JSON.stringify(entries)).not.toContain('notes.txt');
    expect(JSON.stringify(entries)).not.toContain('package.json');
  });

  it('hides dotfiles by default', () => {
    const { entries } = listDirectories(root, root);
    const names = entries.map((entry) => entry.name);

    expect(names).not.toContain('.hidden-dir');
    expect(names).not.toContain('.env');
  });

  it('returns entries sorted by name', () => {
    const names = listDirectories(root, root).entries.map((entry) => entry.name);

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('flags git repositories and counts their worktrees', () => {
    const byName = new Map(
      listDirectories(root, root).entries.map((entry) => [entry.name, entry])
    );

    expect(byName.get('alpha')).toMatchObject({ isGitRepo: true, worktreeCount: 3 });
    expect(byName.get('beta')).toMatchObject({ isGitRepo: true, worktreeCount: 1 });
    expect(byName.get('plain-folder')).toMatchObject({
      isGitRepo: false,
      worktreeCount: null,
    });
  });

  it('lists a symlink that stays inside the root', () => {
    const names = listDirectories(root, root).entries.map((entry) => entry.name);

    expect(names).toContain('inside-link');
  });

  it('skips a symlink whose target escapes the root', () => {
    const names = listDirectories(root, root).entries.map((entry) => entry.name);

    expect(names).not.toContain('escape-link');
  });

  it('caps the result at BROWSE_ENTRY_LIMIT and flags truncation', () => {
    const crowded = path.join(sandbox, 'crowded');
    mkdirSync(crowded, { recursive: true });
    for (let i = 0; i < BROWSE_ENTRY_LIMIT + 5; i++) {
      mkdirSync(path.join(crowded, `dir-${String(i).padStart(4, '0')}`));
    }

    const { entries, truncated } = listDirectories(crowded, crowded);

    expect(entries).toHaveLength(BROWSE_ENTRY_LIMIT);
    expect(truncated).toBe(true);
  });

  it('does not flag truncation for a directory within the limit', () => {
    expect(listDirectories(root, root).truncated).toBe(false);
  });
});

describe('countWorktrees', () => {
  it('counts the main worktree plus each linked worktree', () => {
    expect(countWorktrees(path.join(root, 'alpha'))).toBe(3);
  });

  it('returns 1 when the repository has no linked worktrees', () => {
    expect(countWorktrees(path.join(root, 'beta'))).toBe(1);
  });

  it('returns 1 for a linked worktree, whose .git is a file', () => {
    const linked = path.join(sandbox, 'linked-worktree');
    mkdirSync(linked, { recursive: true });
    writeFileSync(path.join(linked, '.git'), 'gitdir: /somewhere/.git/worktrees/wt-1');

    expect(isGitRepositoryPath(linked)).toBe(true);
    expect(countWorktrees(linked)).toBe(1);
  });
});
