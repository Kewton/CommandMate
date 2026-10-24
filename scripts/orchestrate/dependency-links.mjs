/**
 * Links in a worktree's dependency tree that lead out of it (Issue #3883 P6).
 *
 * A consistency review (5-2b) once linked another worktree's `node_modules`
 * to the reviewed tree to try something; the other worktree's dependencies then
 * resolved into a tree it did not own. The review template already said "read
 * only", but nothing kept the reviewer from writing, and env-clean does not
 * look into `node_modules`. This is the check that does: the symbolic links
 * directly under `node_modules` (and under its `@scope` directories) whose real
 * path is outside the worktree that owns them. consistency-review.mjs reads the
 * reviewed worktree and every worktree of its repository before and after the
 * review, and a link that appeared (or now points elsewhere) keeps the review
 * from being a verdict.
 *
 * A worktree owns its own directory and the real directory of its
 * `node_modules` (which may be a link to a shared tree); a link into either is
 * the worktree's own (a workspace package, a hoisted copy) and not reported.
 * The entry `node_modules` itself is read too (#3883 N4): when it is a link
 * whose target is outside the worktree, it is reported like any other link, so
 * a `node_modules` that becomes a link to another tree during the review — or
 * a shared one pointed elsewhere — is a link that appeared (or moved), while a
 * shared tree that was already there before the review stays the baseline.
 */
import fs from 'node:fs';
import path from 'node:path';

function realOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isInside(target, root) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/** Where a link leads: its real path, or for a dangling link the path it names. */
function linkTarget(link) {
  return realOrNull(link) ?? path.resolve(path.dirname(link), fs.readlinkSync(link));
}

function entriesOf(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The links under `<worktree>/node_modules` (direct entries and `@scope/*`),
 * and `node_modules` itself, whose target is outside the worktree, as `{ link, target }`.
 */
export function foreignLinks(worktree) {
  const nodeModules = path.join(worktree, 'node_modules');
  const realWorktree = realOrNull(worktree) ?? path.resolve(worktree);
  const found = [];
  let entry;
  try {
    entry = fs.lstatSync(nodeModules);
  } catch {
    return [];
  }
  if (entry.isSymbolicLink()) {
    const target = linkTarget(nodeModules);
    if (!isInside(target, realWorktree)) found.push({ link: nodeModules, target });
  }
  const realModules = realOrNull(nodeModules);
  if (!realModules) return found;
  const roots = [realWorktree, realModules];
  const look = (dir) => {
    for (const entry of entriesOf(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = linkTarget(full);
        if (!roots.some((root) => isInside(target, root))) found.push({ link: full, target });
      } else if (entry.isDirectory() && entry.name.startsWith('@') && dir === realModules) {
        look(full);
      }
    }
  };
  look(realModules);
  return found;
}

/** The foreign links of several worktrees, as a map from link to target. */
export function snapshotForeignLinks(worktrees) {
  const links = new Map();
  for (const worktree of new Set(worktrees)) {
    for (const { link, target } of foreignLinks(worktree)) links.set(link, target);
  }
  return links;
}

/** The links of `after` that `before` did not have, or that point elsewhere now. */
export function addedLinks(before, after) {
  return [...after].filter(([link, target]) => before.get(link) !== target).map(([link, target]) => ({ link, target }));
}

/** The worktrees `git worktree list --porcelain` names (`worktree <path>` lines). */
export function parseWorktreeList(porcelain) {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}
