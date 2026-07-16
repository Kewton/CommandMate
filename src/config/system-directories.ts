/**
 * System Directories Configuration
 * Issue #135: DB path resolution logic fix
 * Issue #1285: Path boundary matching and symlink resolution
 *
 * Centralized list of system directories that are not allowed for DB storage.
 * This supports security measures SEC-001, SEC-002, SEC-005.
 *
 * @module system-directories
 */

import fs from 'fs';
import path from 'path';

/**
 * System directories that are not allowed for DB storage
 *
 * SEC-001: System directory protection
 * These directories are protected to prevent writing database files
 * to critical system paths which could cause security issues.
 */
export const SYSTEM_DIRECTORIES = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/tmp',
  '/dev',
  '/sys',
  '/proc',
] as const;

/**
 * POSIX separator. SYSTEM_DIRECTORIES are POSIX absolute paths and this guard
 * protects POSIX platforms, so the boundary is always '/' rather than path.sep.
 */
const POSIX_SEP = '/';

/**
 * Check whether `target` is `dir` itself or lives underneath it.
 *
 * Issue #1285: A bare startsWith() has no path boundary, so '/tmp' matched
 * '/tmpfoo' and '/var' matched '/variance'. Requiring an exact match or a
 * separator after the prefix keeps unrelated siblings out of the match.
 *
 * @param target - Absolute path to test
 * @param dir - Absolute directory path to test against
 * @returns true if target is dir or is contained in dir
 */
export function isPathWithin(target: string, dir: string): boolean {
  const normalizedDir = dir.endsWith(POSIX_SEP) ? dir.slice(0, -1) : dir;
  return target === normalizedDir || target.startsWith(normalizedDir + POSIX_SEP);
}

/**
 * SYSTEM_DIRECTORIES plus their physical locations.
 *
 * Issue #1285: On macOS '/tmp', '/var' and '/etc' are symlinks into '/private'.
 * A resolved path such as '/private/tmp/x.db' therefore never matches the
 * literal '/tmp' entry. Both sides of the comparison must be resolved, so the
 * literal and physical forms are both kept as match candidates.
 *
 * Mount layout does not change while the process runs, so this is computed once.
 */
let resolvedSystemDirectoriesCache: string[] | null = null;

function getSystemDirectoryCandidates(): string[] {
  if (resolvedSystemDirectoriesCache !== null) {
    return resolvedSystemDirectoriesCache;
  }

  const candidates = new Set<string>();
  for (const dir of SYSTEM_DIRECTORIES) {
    // Always keep the literal form: it must stay enforced even when the
    // directory does not exist on this platform (e.g. /proc and /sys on macOS).
    candidates.add(dir);
    try {
      candidates.add(fs.realpathSync(dir));
    } catch {
      // Not present on this platform; the literal form still applies.
    }
  }

  resolvedSystemDirectoriesCache = Array.from(candidates);
  return resolvedSystemDirectoriesCache;
}

/**
 * Resolve symlinks in an absolute path, tolerating components that do not exist.
 *
 * Issue #1285: fs.realpathSync() throws on a missing path, but a DB file is
 * validated *before* it is created, so "does not exist" is the normal case.
 * The nearest existing ancestor is resolved and the remaining (not yet created)
 * components are re-appended, which yields the physical location the path would
 * occupy. Because the input is already lexically resolved it contains no '..',
 * so the re-appended tail cannot escape the resolved ancestor.
 *
 * @param absolutePath - A lexically resolved absolute path
 * @returns The physical path, or the input unchanged if nothing could be resolved
 */
function resolvePhysicalPath(absolutePath: string): string {
  const pendingComponents: string[] = [];
  let current = absolutePath;

  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return pendingComponents.length > 0
        ? path.join(real, ...pendingComponents)
        : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the root without resolving anything.
        return absolutePath;
      }
      pendingComponents.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Check if a path is within a system directory
 *
 * Issue #1285: Resolution happens here rather than at each call site. The check
 * is only correct when the candidate path *and* the system directory list are
 * resolved consistently; resolving at a call site and comparing against the
 * unresolved literals silently defeats the guard (that is what made the SEC-002
 * call site in db-migration-path.ts miss '/tmp'). Centralizing keeps every
 * caller correct by construction.
 *
 * The literal and physical forms are both matched, so a path is rejected if
 * either form lands in a system directory. This fails closed: a symlink placed
 * inside a system directory that points elsewhere is still rejected.
 *
 * This performs filesystem I/O and is therefore not a pure function.
 *
 * @param inputPath - The absolute path to check (relative paths are resolved against cwd)
 * @returns true if the path is within a system directory
 */
export function isSystemDirectory(inputPath: string): boolean {
  const lexicalPath = path.resolve(inputPath);
  const physicalPath = resolvePhysicalPath(lexicalPath);

  return getSystemDirectoryCandidates().some(
    (dir) => isPathWithin(lexicalPath, dir) || isPathWithin(physicalPath, dir)
  );
}
