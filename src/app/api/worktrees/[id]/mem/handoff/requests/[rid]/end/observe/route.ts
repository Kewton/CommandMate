/**
 * `POST /api/worktrees/:id/mem/handoff/requests/:rid/end/observe` `{ endToken }` — after the person's
 * stop, the server looks whether the instance still runs and records how the session ended
 * (§4.6 3・4, Issue #4227). **Kills nothing and starts nothing**: the one tmux call is
 * `cliTool.isRunning(target_worktree_id, instance_id)`, addressed as the kill-session route
 * addresses it (the tool from the roster, the session name built inside `isRunning`, never
 * passed in). The screen's report of its own stop is not read. A read that fails is "not
 * seen stopped". Screen only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { handoffError, requestOf } from '@/lib/handoff/common';
import { handoffObserve } from '@/lib/handoff/end';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { resolveSessionTargetStrict } from '@/lib/session/resolve-session-target';
import { isCliToolType } from '@/lib/cli-tools/types';

export const dynamic = 'force-dynamic';

const answer = (outcome: { status: number; body: unknown }) => NextResponse.json(outcome.body, { status: outcome.status });

/** Whether the request's instance runs, read as kill-session reads it; null when it cannot be read. */
async function readRunning(worktreeId: string, instanceId: string, cliToolId: string): Promise<boolean | null> {
  try {
    const resolution = resolveSessionTargetStrict(getDbInstance(), worktreeId, {
      instanceId,
      requestedCliTool: isCliToolType(cliToolId) ? cliToolId : undefined,
    });
    if (!resolution.ok) return null;
    const tool = CLIToolManager.getInstance().getTool(resolution.target.cliToolId);
    return await tool.isRunning(worktreeId, resolution.target.instanceId);
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const p = await params;
    if (!isScreenRequest(request)) return answer(handoffError('screen_only'));
    const body = await readMemBody(request);
    if (!body) return answer(memError('invalid_request'));
    const worktreeId = canonicalWorktreeId(p.id);
    const db = getDbInstance();
    const row = requestOf(db, worktreeId, p.rid);
    if (!row) return answer(handoffError('not_found'));
    // Read only for the stop this request declared; any other token is refused below without a read.
    const running =
      row.state === 'ending' && typeof body.endToken === 'string' && body.endToken === row.endToken
        ? await readRunning(row.targetWorktreeId, row.instanceId, row.cliToolId)
        : null;
    return answer(handoffObserve(db, request, worktreeId, p.rid, body, { running }));
  } catch (error: unknown) {
    return answer(memInternalError('handoff-observe-failed', error));
  }
}
