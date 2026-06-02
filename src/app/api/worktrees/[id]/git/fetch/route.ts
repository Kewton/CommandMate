/**
 * API Route: /api/worktrees/:id/git/fetch
 * POST: Fetch from a remote (`git fetch [--prune] <remote> --`).
 * Issue #783: push / pull / fetch (Phase 5/5)
 *
 * Body: { remote?: string, prune?: boolean }
 * - remote defaults to 'origin'; when supplied it is validated with
 *   validateGitBranchName (DR4-001: its leading-'-' / control-char / ':' / '.'
 *   rejections are the load-bearing defense against git option-injection
 *   (--upload-pack / --receive-pack / --exec) AND arbitrary-URL SSRF — DR4-005).
 * - fetch is NOT serialized (it writes only remote-tracking refs).
 *
 * Error mapping via handleGitApiError: 400 invalid_branch_name / 401 auth_failed
 * / 502 network / 504 timeout / 400 not-a-repo / 500.
 */

import { NextRequest, NextResponse } from 'next/server';
import { gitFetch, handleGitApiError } from '@/lib/git/git-utils';
import { validateGitBranchName } from '@/lib/git/git-route-helpers';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const worktree = resolveWorktreeOr404(params.id);
    if (worktree instanceof NextResponse) {
      return worktree;
    }

    const body = await request.json().catch(() => ({}));
    const { remote, prune } = body;

    // remote defaults to 'origin'; validate any user-supplied value (DR4-001).
    let validRemote = 'origin';
    if (remote !== undefined) {
      const remoteResult = validateGitBranchName(remote);
      if (remoteResult instanceof NextResponse) {
        return remoteResult;
      }
      validRemote = remoteResult;
    }

    await gitFetch(worktree.path, { remote: validRemote, prune: prune === true });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/fetch');
  }
}
