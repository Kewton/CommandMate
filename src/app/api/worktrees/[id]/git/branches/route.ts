/**
 * API Route: /api/worktrees/:id/git/branches
 * GET: Returns the branch list (`{ branches: BranchInfo[] }`).
 * Issue #781: branch list / checkout / create / delete (Phase 3/5)
 *
 * Query: ?include=local|remote|all (default: local).
 * - remote uses `git branch -r` (cached remote-tracking refs only; NO network).
 *
 * READ-only: listBranches degrades best-effort and never throws, so this route
 * normally returns 200. Structure follows git/status/route.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listBranches, handleGitApiError } from '@/lib/git/git-utils';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import type { BranchInclude } from '@/types/git';

/** Coerce an arbitrary `include` query value to a valid BranchInclude. */
function parseInclude(value: string | null): BranchInclude {
  if (value === 'remote' || value === 'all') {
    return value;
  }
  return 'local';
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const worktree = resolveWorktreeOr404(params.id);
    if (worktree instanceof NextResponse) {
      return worktree;
    }

    const include = parseInclude(request.nextUrl.searchParams.get('include'));
    const branches = await listBranches(worktree.path, include);

    return NextResponse.json({ branches }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'GET /api/worktrees/:id/git/branches');
  }
}
