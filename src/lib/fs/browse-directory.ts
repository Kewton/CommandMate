/**
 * Directory listing for the repository picker (Issue #1517).
 *
 * Deliberately narrow: it returns *directories only*. The picker exists to
 * choose a repository folder, and returning file names would turn an allowed
 * root into a filesystem read oracle for anyone who reaches the API.
 */

import path from 'path';
import { readdirSync, existsSync, statSync } from 'fs';
import { resolveAndValidateRealPath } from '@/lib/security/path-validator';
import { BROWSE_ENTRY_LIMIT } from './browse-roots';

export interface BrowseEntry {
  /** Directory base name. */
  name: string;
  /** Absolute path of the directory. */
  path: string;
  /** Whether the directory looks like a git repository or linked worktree. */
  isGitRepo: boolean;
  /** Worktrees the repository owns, or null when it is not a repository. */
  worktreeCount: number | null;
}

export interface DirectoryListing {
  entries: BrowseEntry[];
  /** True when the directory held more than BROWSE_ENTRY_LIMIT subdirectories. */
  truncated: boolean;
}

/**
 * Count worktrees without shelling out to git.
 *
 * `git worktree list` per entry would mean up to BROWSE_ENTRY_LIMIT child
 * processes for one keystroke-driven listing. Git records each linked worktree
 * as a directory under `.git/worktrees`, so `1 + <that count>` matches what
 * `git worktree list` reports for a main repository, read with two stat calls.
 * A linked worktree has `.git` as a file and therefore reports 1.
 */
export function countWorktrees(repoPath: string): number {
  const worktreesDir = path.join(repoPath, '.git', 'worktrees');
  try {
    if (!statSync(worktreesDir).isDirectory()) return 1;
    return 1 + readdirSync(worktreesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .length;
  } catch {
    return 1;
  }
}

/**
 * Whether a directory is a git repository or a linked worktree.
 * Mirrors the existing convention in `lib/git/worktrees.ts`.
 */
export function isGitRepositoryPath(candidatePath: string): boolean {
  return existsSync(path.join(candidatePath, '.git'));
}

/**
 * List the immediate subdirectories of `absolutePath`.
 *
 * @param absolutePath - Already validated against `root` by `resolveAllowedPath`.
 * @param root - The allowed root that admitted `absolutePath`; symlinked
 *   children are only listed while their real path stays inside it.
 */
export function listDirectories(absolutePath: string, root: string): DirectoryListing {
  const dirents = readdirSync(absolutePath, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  let truncated = false;

  for (const dirent of dirents) {
    // Hidden by default: dotfiles are noise for repository selection and
    // include credential stores such as ~/.ssh.
    if (dirent.name.startsWith('.')) continue;

    const entryPath = path.join(absolutePath, dirent.name);

    if (dirent.isSymbolicLink()) {
      // A symlink is only offered when it points at a directory that is still
      // inside the same allowed root, so following it cannot leave the root.
      if (!resolveAndValidateRealPath(entryPath, root)) continue;
      try {
        if (!statSync(entryPath).isDirectory()) continue;
      } catch {
        continue;
      }
    } else if (!dirent.isDirectory()) {
      continue;
    }

    if (entries.length >= BROWSE_ENTRY_LIMIT) {
      truncated = true;
      break;
    }

    const isGitRepo = isGitRepositoryPath(entryPath);
    entries.push({
      name: dirent.name,
      path: entryPath,
      isGitRepo,
      worktreeCount: isGitRepo ? countWorktrees(entryPath) : null,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  return { entries, truncated };
}
