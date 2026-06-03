/**
 * API Route: /api/worktrees/:id/git/commit
 * POST: Creates a commit (`git commit -m <message> [--amend] --`).
 * Issue #780: stage/unstage/commit operations (Phase 2/5)
 *
 * Body: { message: string, amend?: boolean }
 * - message: trimmed-non-empty, length <= MAX_COMMIT_MESSAGE_LENGTH, no NULL or
 *   control chars except \n and \t (newlines are preserved within the single
 *   -m argv element). Invalid -> 400.
 * - amend: optional boolean. When false and nothing is staged -> 400.
 *
 * Structure follows git/status/route.ts; error mapping via handleGitApiError
 * (409 index lock, 504 timeout, 400 nothing-to-commit, 500 generic).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { gitCommit, getStagedStatus, getGitLog, handleGitApiError } from '@/lib/git/git-utils';
import { MAX_COMMIT_MESSAGE_LENGTH } from '@/config/git-status-config';

/**
 * Disallowed control characters in a commit message: all C0 controls and DEL,
 * EXCEPT tab (\t, 0x09) and newline (\n, 0x0A). Carriage return (\r) is also
 * rejected to keep messages canonical.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F]/;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);

    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { message, amend } = body;

    if (typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json(
        { error: 'message must be a non-empty string' },
        { status: 400 }
      );
    }
    if (message.length > MAX_COMMIT_MESSAGE_LENGTH) {
      return NextResponse.json(
        { error: `message exceeds the maximum of ${MAX_COMMIT_MESSAGE_LENGTH} characters` },
        { status: 400 }
      );
    }
    if (FORBIDDEN_CONTROL_CHARS.test(message)) {
      return NextResponse.json(
        { error: 'message contains invalid control characters' },
        { status: 400 }
      );
    }
    if (amend !== undefined && typeof amend !== 'boolean') {
      return NextResponse.json(
        { error: 'amend must be a boolean' },
        { status: 400 }
      );
    }

    const isAmend = amend === true;

    // Reject an empty commit (no staged changes) unless amending.
    if (!isAmend) {
      const status = await getStagedStatus(worktree.path);
      if (status.staged.length === 0) {
        return NextResponse.json(
          { error: 'No staged changes to commit' },
          { status: 400 }
        );
      }
    }

    await gitCommit(worktree.path, message, isAmend);

    // Return the resulting HEAD commit (best-effort; commit itself succeeded).
    const commits = await getGitLog(worktree.path, 1, 0);
    const commit = commits.length > 0 ? commits[0] : null;

    return NextResponse.json({ success: true, commit }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/commit');
  }
}
