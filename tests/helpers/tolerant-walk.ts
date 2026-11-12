/**
 * Whole-tree scans that survive concurrent tests (Issue #4246).
 *
 * Guards that walk the repository race with other tests creating and removing
 * temp directories inside it (`data/test-db`, `tests/fixtures/test-*`). A
 * directory listed by `readdirSync` can be gone by the time it is `statSync`ed
 * or read, which used to fail the guard with `ENOENT ... scandir '<path>'`.
 *
 * Only the *children* met during the walk are allowed to vanish. The root the
 * caller handed in is read strictly, so a missing root still throws. Errors other
 * than ENOENT (EACCES, ...) are never swallowed.
 */

import { lstatSync, readdirSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** `fn()`, or `undefined` when it fails because the path is gone. */
export function ignoreVanished<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export interface WalkOptions {
  /** Default true (`statSync`). false uses `lstatSync` and never follows symlinks. */
  followSymlinks?: boolean;
}

/**
 * Depth-first walk of `root`. `onEntry` sees every child (absolute path, name,
 * stat); returning `false` for a directory keeps the walk out of it.
 */
export function walkTree(
  root: string,
  onEntry: (full: string, name: string, stat: Stats) => boolean | void,
  options: WalkOptions = {}
): void {
  const follow = options.followSymlinks ?? true;
  const visit = (dir: string, strict: boolean): void => {
    const names = strict ? readdirSync(dir) : ignoreVanished(() => readdirSync(dir));
    if (!names) return;
    for (const name of names) {
      const full = join(dir, name);
      const stat = ignoreVanished(() => (follow ? statSync(full) : lstatSync(full)));
      if (!stat) continue;
      const descend = onEntry(full, name, stat);
      if (stat.isDirectory() && descend !== false) visit(full, false);
    }
  };
  visit(root, true);
}
