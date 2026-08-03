/**
 * Shared worktree-resolution helper for git API routes (Issue #781).
 *
 * Collapses the `isValidWorktreeId -> getDbInstance -> getWorktreeById -> 404`
 * boilerplate that every git route repeats verbatim. Returns either the resolved
 * Worktree or a ready-to-return NextResponse (400 invalid id / 404 not found),
 * with byte-identical error bodies to the inlined versions so client-visible
 * behavior is unchanged.
 *
 * Kept in its own module (NOT git-route-helpers.ts, which is deliberately
 * db-free so its validator survives `vi.mock('@/lib/git/git-utils')` and pulls
 * in no SQLite). The route unit tests mock `@/lib/db`, `@/lib/db/db-instance`,
 * and `@/lib/security/path-validator`; vitest hoists those module mocks globally,
 * so this helper transparently resolves to the mocked implementations.
 *
 * Issue #1621 Phase 2 adds {@link canonicalWorktreeId}, the single place API
 * routes turn a possibly-historical ID from the URL into the ID the rest of the
 * request should use.
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { resolveWorktreeIdWithAlias } from '@/lib/db/worktree-alias-db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import type { Worktree } from '@/types/models';

/**
 * Map a worktree ID that may be historical onto the ID that is current.
 *
 * Called at the very top of an API route, before anything else touches the ID.
 * That placement is the point: a route resolves the *worktree* through one
 * lookup but then keeps using the raw segment for a dozen other things — child
 * tables (`getMessages(db, id)`), tmux session names
 * (`cliTool.getSessionName(id)`), poller and Auto-Yes keys, WS broadcasts. Only
 * translating the existence check would turn a clean 404 into something worse:
 * a request that finds the worktree and then reads an empty message list, or
 * starts a *second* agent session under the old name. Canonicalising the
 * variable everything reads keeps the whole request on one key.
 *
 * Deliberately total — it never throws and never returns empty:
 *
 * - an ID that fails `isValidWorktreeId` is handed back untouched, so the
 *   route's own 400 still reports what the caller actually sent;
 * - an unknown ID is handed back untouched, so the route's own 404 still names
 *   it;
 * - any failure at all degrades to "no alias", which is exactly the behaviour
 *   this code replaced.
 *
 * The last bullet is why *everything*, including the format check, sits inside
 * the try. This function is called from ~70 routes whose unit tests each mock a
 * different subset of `@/lib/db`, `@/lib/db/db-instance` and
 * `@/lib/security/path-validator` with hand-written factories: any name a
 * factory omits is `undefined` at call time. A throw here would surface as a
 * 500 from a route that has nothing to do with aliases (measured:
 * tests/unit/api/files-download.test.ts mocks path-validator without
 * `isValidWorktreeId`).
 *
 * @param requestedId - The `params.id` route segment, verbatim
 * @returns The current worktree ID, or `requestedId` when nothing maps it
 */
export function canonicalWorktreeId(requestedId: string): string {
  if (!requestedId) return requestedId;

  try {
    if (!isValidWorktreeId(requestedId)) return requestedId;
    const db = getDbInstance();
    return resolveWorktreeIdWithAlias(db, requestedId) ?? requestedId;
  } catch {
    return requestedId;
  }
}

/**
 * Validate the route `id` and resolve its Worktree.
 *
 * Accepts a historical ID (Issue #1621): the returned Worktree always carries
 * the CURRENT id in `worktree.id`, so callers must key their follow-up work on
 * `worktree.id` rather than on the segment they were given.
 *
 * @param id - The `params.id` route segment
 * @returns The Worktree on success, or a 400 (invalid id format) / 404 (not
 *          found) NextResponse to return directly.
 */
export function resolveWorktreeOr404(id: string): Worktree | NextResponse {
  if (!isValidWorktreeId(id)) {
    return NextResponse.json(
      { error: 'Invalid worktree ID format' },
      { status: 400 }
    );
  }

  const db = getDbInstance();
  const worktree = getWorktreeById(db, canonicalWorktreeId(id));

  if (!worktree) {
    return NextResponse.json(
      { error: 'Worktree not found' },
      { status: 404 }
    );
  }

  return worktree;
}
