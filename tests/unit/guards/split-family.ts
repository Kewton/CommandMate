/**
 * A module and the pieces split off it share the module's place in an
 * allowlist (Issue #3903).
 *
 * Splitting a large file moves functions into `<dir>/<base>-<part>.ts` next to
 * it (docs/orchestrate/refactor.md). A guard that pins "the writer is this one
 * file" fails the moment a writer moves, so #3892 / #3893 left the writers
 * where they were. The guards name the original file instead, and a piece in
 * the same directory whose name starts with `<base>-` counts as that file. A
 * file anywhere else — another directory, `<base>2.ts`, an unrelated name —
 * still does not.
 */

import { posix } from 'node:path';

/** Is `file` the module `origin` itself or a piece split off it (`<dir>/<base>-*.ts(x)`)? */
export function inFamily(file: string, origin: string): boolean {
  if (file === origin) return true;
  const dir = posix.dirname(origin);
  const base = posix.basename(origin).replace(/\.tsx?$/, '');
  return posix.dirname(file) === dir && posix.basename(file).startsWith(`${base}-`) && /\.tsx?$/.test(file);
}

/**
 * The origins `files` belong to, sorted and without duplicates. A file outside
 * every family stays as itself, so an equality against the origins names it.
 */
export function originsOf(files: readonly string[], origins: readonly string[]): string[] {
  const out = new Set(files.map((f) => origins.find((o) => inFamily(f, o)) ?? f));
  return [...out].sort();
}
