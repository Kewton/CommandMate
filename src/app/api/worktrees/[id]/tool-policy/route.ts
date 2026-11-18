/**
 * API Route: GET /api/worktrees/:id/tool-policy (Issue #4437, I7c)
 *
 * Would a send to this target, from this origin, be refused by the tool policy —
 * asked BEFORE anything is written. `send --register --role`, `--contract` and
 * `--auto-yes` write the roster, a role setting, a task row or a grant before the
 * message goes out; the send route refuses only once it is reached, which left those
 * writes behind a refused send. The CLI asks here first and stops with exit 33, so a
 * refusal leaves nothing (no "undo after the refusal": a crash in between would keep it).
 *
 * Read-only: it resolves the target the way `POST /send` does
 * (`resolveSessionTargetStrict`), asks the same table (`findToolPolicyDenial`) under
 * the declaration as stated, and records nothing (no `lastSend`, no relay, no task).
 * With `replyTo*`, the relay `send --reply-to` would open is asked too (rule 0 of
 * `relay-policy`, both ends), first — the order the CLI opens them in.
 *
 * Query: `cliToolId`, `instanceId`, `operation` (`send` | `ask`, default `send`),
 * `origin`, `originEvidence`, `replyToWorktreeId` + `replyToInstanceId`.
 * 200 `{ allowed: true, cliToolId }` or 200 `{ allowed: false, refusal }`, where
 * `refusal` is the very body the 409 of `POST /send` (`TOOL_POLICY_DENIED`) or of
 * `POST /api/relays` (`RELAY_TOOL_POLICY_DENIED`) carries. A target that cannot be
 * resolved answers as `POST /send` would (400 / 409 conflict): the CLI then goes on
 * and lets the send say it.
 *
 * The origin is the caller's claim and is not verified: a guard against accidental
 * use, not a guarantee of compliance with the Google Antigravity terms.
 *
 * Issue #4449: the CLI no longer asks here. The writes themselves (`POST/PUT
 * instances/roles`, `POST tasks`, the Auto-Yes grant's relay) refuse in the same
 * request with the same bodies (`send/write-tool-policy`), so an ask that failed, or a
 * default changed after it, can no longer let a write through. Kept read-only for any
 * other caller that wants the verdict without writing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { resolveSessionTargetStrict } from '@/lib/session/resolve-session-target';
import { sessionTargetConflictResponse } from '@/lib/session/session-target-conflict-response';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { readBodyOrigin } from '../send/send-tool-policy';
import { findWriteToolPolicyRefusal } from '../send/write-tool-policy';

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: requestedWorktreeId } = await params;
  const id = canonicalWorktreeId(requestedWorktreeId);
  const db = getDbInstance();
  if (!getWorktreeById(db, id)) {
    return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
  }

  const query = request.nextUrl.searchParams;
  const requestedCliTool = query.get('cliToolId') ?? undefined;
  if (requestedCliTool !== undefined && !(CLI_TOOL_IDS as readonly string[]).includes(requestedCliTool)) {
    return badRequest(`Invalid CLI tool ID. Must be one of: ${CLI_TOOL_IDS.join(', ')}`);
  }
  const instanceId = query.get('instanceId') ?? undefined;
  if (instanceId !== undefined && !isValidInstanceId(instanceId)) {
    return badRequest('Invalid instanceId. Must be an alphanumeric/underscore/hyphen identifier.');
  }
  const operation = query.get('operation') ?? 'send';
  if (operation !== 'send' && operation !== 'ask') return badRequest('operation must be send or ask');
  const origin = readBodyOrigin(query.get('origin') ?? undefined);
  if (!origin.ok) return badRequest(origin.error);
  const replyToWorktreeId = query.get('replyToWorktreeId') ?? undefined;
  const replyToInstanceId = query.get('replyToInstanceId') ?? undefined;
  if ((replyToWorktreeId === undefined) !== (replyToInstanceId === undefined)) {
    return badRequest('replyToWorktreeId and replyToInstanceId go together');
  }
  if (replyToInstanceId !== undefined && !isValidInstanceId(replyToInstanceId)) {
    return badRequest('Invalid replyToInstanceId.');
  }

  const resolution = resolveSessionTargetStrict(db, id, {
    instanceId,
    requestedCliTool: requestedCliTool as CLIToolType | undefined,
  });
  if (!resolution.ok) return sessionTargetConflictResponse(resolution.conflict);
  const cliToolId = resolution.target.cliToolId;

  // Issue #4449 (P3-3): the very verdict the writes give (`findWriteToolPolicyRefusal`):
  // the relay `send --reply-to` would open first, then the send.
  const refusal = findWriteToolPolicyRefusal(db, {
    worktreeId: id,
    tool: cliToolId,
    instanceId: instanceId ?? cliToolId,
    operation,
    request: {
      origin: origin.origin,
      originEvidence: query.get('originEvidence') ?? undefined,
      replyTo: replyToWorktreeId !== undefined && replyToInstanceId !== undefined
        ? { worktreeId: replyToWorktreeId, instanceId: replyToInstanceId }
        : null,
    },
  });
  if (refusal) return NextResponse.json({ allowed: false, refusal });
  return NextResponse.json({ allowed: true, cliToolId });
}
