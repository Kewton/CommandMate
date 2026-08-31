/**
 * API Route: POST /api/worktrees/:id/verify/runs/:runId/cancel
 * Stops a verification run that is still executing (Issue #2063).
 *
 * The Web UI could start a run from #1816 on and never stop one. That is not a
 * missing convenience: `.commandmate/verify.yaml` in this repository declares a
 * 1800s `build` gate and mutex-held `unit` / `integration` gates, so a run
 * begun by a mis-click held the worktree — and the per-worktree conflict check,
 * which refuses a second run — for as long as those gates took. The only way
 * out was to wait or to kill the server.
 *
 * What "cancel" has to mean here is *the child processes stop*. The runner's
 * {@link cancelVerification} signals the gate's process group (gates are
 * spawned `detached` exactly so a signal can reach the whole tree) and latches,
 * so nothing else is started; only then is the run closed as `cancelled`. A
 * route that flipped the status column would have left `npm run build` writing
 * into the worktree behind a UI claiming the run was over.
 *
 * Three answers, deliberately distinct:
 *   - 200 — the run stopped and closed while this request waited.
 *   - 202 — signalled and latched, still winding down (a gate ignoring SIGTERM
 *     is SIGKILLed after a grace, and a run queued for a concurrency slot
 *     closes when the slot reaches it). The caller polls, as it already does.
 *   - 409 — nothing to cancel: the run had already reached a verdict, or it is
 *     an orphan of a previous server process that no signal can reach.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getVerificationRun, getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { cancelVerification } from '@/lib/verification/gate-runner';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/verify-run-cancel');

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  try {
    const { id: requestedWorktreeId, runId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    if (!/^[1-9]\d*$/.test(runId)) {
      return NextResponse.json({ error: 'Invalid run ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    const run = getVerificationRun(db, Number(runId));
    // Run ids are global. A run belonging to another worktree is reported as
    // absent here rather than cancelled under this worktree's URL — the same
    // rule the sibling GET follows, and the one that stops a mistyped id from
    // stopping somebody else's build.
    if (!run || run.worktreeId !== id) {
      return NextResponse.json({ error: 'Verification run not found' }, { status: 404 });
    }

    if (run.status !== 'running') {
      // Already judged. Answering 409 with the verdict is more use than a bare
      // refusal: the caller's list is simply one poll behind.
      return NextResponse.json(
        { error: `Verification run ${run.id} has already finished`, status: run.status },
        { status: 409 }
      );
    }

    const outcome = await cancelVerification(run.id);

    if (outcome.kind === 'not-running') {
      // The row says `running` but this process holds no switch for it, which
      // after startup reconciliation means it is not executing anywhere. Saying
      // so beats reporting a cancel that signalled nothing.
      logger.warn('cancel-requested-for-unowned-run', { runId: run.id, worktreeId: id });
      return NextResponse.json(
        {
          error: `Verification run ${run.id} is not executing in this server process`,
          status: run.status,
        },
        { status: 409 }
      );
    }

    if (outcome.kind === 'requested') {
      return NextResponse.json({ runId: run.id, status: 'running' }, { status: 202 });
    }

    logger.info('verification-run-cancelled', { runId: run.id, worktreeId: id });
    return NextResponse.json({ runId: run.id, status: outcome.status }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-cancelling-verification-run:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to cancel verification run' }, { status: 500 });
  }
}
