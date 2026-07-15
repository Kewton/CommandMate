/**
 * API Route: /api/worktrees/:id/git/stash
 * GET: Returns the stash list (`git stash list --format=...`).
 * Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
 *
 * Read-only and best-effort: getStashList degrades to `{ stashes: [] }` (HTTP
 * 200) on any read failure, matching the #781 listBranches contract so the UI's
 * Stash section never breaks. Structure follows git/status/route.ts; error
 * mapping via handleGitApiError for any thrown infra error.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStashList, handleGitApiError } from '@/lib/git/git-utils';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) {
      return worktree;
    }

    const stashes = await getStashList(worktree.path);

    return NextResponse.json({ stashes }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'GET /api/worktrees/:id/git/stash');
  }
}
