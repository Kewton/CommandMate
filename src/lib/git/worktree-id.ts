/**
 * Minting a worktree ID from its directory — the pure half of Issue #1621.
 *
 * Split out of `worktrees.ts` for one reason: a **migration** has to mint IDs
 * (the Phase 4 renumbering in #1645), and `worktrees.ts` imports `@/lib/db`,
 * which re-exports `db-migrations` — importing it from a migration closes a
 * cycle. It also drags every `vi.mock('@/lib/git/worktrees')` in the suite into
 * `runMigrations`, which is exactly how v52 was made to throw before it was
 * moved (see `migrations/worktree-child-tables.ts`).
 *
 * This module imports nothing but `crypto` and `path`, so it is safe from both
 * directions.
 */

import { createHash } from 'crypto';
import path from 'path';

/**
 * Lower-case, URL- and shell-safe slug of one identifier segment.
 *
 * Kept byte-identical to the rule the branch-derived `generateWorktreeId` has
 * always used so the path-derived scheme produces IDs from the same alphabet:
 * lower-case, `[^a-z0-9-]` collapsed to `-`, runs of `-` compressed, edges
 * trimmed. The result always satisfies `isValidWorktreeId`.
 */
export function sanitizeIdSegment(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-') // Replace non-alphanumeric (except hyphen) with hyphen
    .replace(/-+/g, '-') // Replace consecutive hyphens with single hyphen
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Base used when a directory name sanitizes to the empty string (`/`, `///`,
 * a name made entirely of separators…). Without it the ID would be `''`, which
 * `isValidWorktreeId` rejects and SQLite would happily store.
 */
export const FALLBACK_ID_BASE = 'worktree';

/**
 * Mint the ID for a worktree that has never been registered before.
 *
 * The ID is a function of the **directory**, never of the branch, and — this is
 * the part that actually buys stability — it is computed **once**, at first
 * registration. `syncWorktreesToDB` looks an existing row up by path and keeps
 * whatever ID that row already carries, so this function is only reached for a
 * genuinely new path. A worktree's ID therefore survives every branch switch,
 * every detached-HEAD commit, and any future change to the rule below.
 *
 * Rule (Issue #1621):
 *
 *     id = sanitize(basename(resolvedPath))
 *     on collision only: `${id}-${sha256(resolvedPath).slice(0, 8)}`
 *
 * `takenIds` must contain every ID that is already spoken for — worktree rows
 * across *all* repositories (the ID is a global primary key, not a per-repo one)
 * plus historical IDs still resolvable as aliases, so a fresh worktree can never
 * shadow an old ID that redirects somewhere else.
 *
 * Deterministic: same `(resolvedPath, takenIds)` always yields the same ID.
 *
 * @param resolvedPath - Absolute, `path.resolve()`d worktree directory
 * @param takenIds - IDs that are unavailable
 * @returns A URL-safe ID satisfying `isValidWorktreeId`
 *
 * @example
 * ```typescript
 * deriveWorktreeId('/repos/commandmate-issue-1644', []) // => 'commandmate-issue-1644'
 * deriveWorktreeId('/b/main', ['main'])                 // => 'main-3f2a91cc'
 * ```
 */
export function deriveWorktreeId(
  resolvedPath: string,
  takenIds: Iterable<string> = []
): string {
  const taken = takenIds instanceof Set ? takenIds : new Set(takenIds);
  const base = sanitizeIdSegment(path.basename(resolvedPath)) || FALLBACK_ID_BASE;

  if (!taken.has(base)) {
    return base;
  }

  // Collision. Disambiguate with a digest of the path itself (not a counter):
  // the result stays a pure function of the directory, so re-deriving the same
  // path against the same set never produces a second, different ID.
  const digest = createHash('sha256').update(resolvedPath).digest('hex');
  for (let length = 8; length <= digest.length; length += 8) {
    const candidate = `${base}-${digest.slice(0, length)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  // Unreachable short of a full SHA-256 collision on two different paths with
  // the same basename; kept so the function is total rather than returning a
  // duplicate ID and violating the worktrees PK.
  for (let ordinal = 2; ; ordinal++) {
    const candidate = `${base}-${digest}-${ordinal}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
