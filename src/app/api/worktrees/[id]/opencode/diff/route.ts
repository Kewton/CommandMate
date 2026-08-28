/**
 * API Route: /api/worktrees/:id/opencode/diff (Issue #2043)
 *
 * The turn's changed files (`GET`), and the two destructive operations that act
 * on them (`POST` — `revert` / `unrevert`).
 *
 * ## Why a route at all, when `current-output` already publishes the files
 *
 * The status poll carries `structuredEvents.sessionDiff`, and the panel reads it
 * from there — so `GET` here is not how the panel *normally* gets its data. It
 * exists for the instant after a `POST`: a revert changes the working tree, and
 * leaving the operator looking at a panel that still describes the state they
 * just undid — for however long the next poll takes — is the one moment the
 * cached answer is actively wrong. `POST` therefore re-reads before it replies,
 * and `GET` is the same re-read on demand.
 *
 * ## Measured caveats this route encodes
 *
 * All from opencode 1.18.22, isolated `HOME`; see
 * `docs/design/opencode-server-live-verification.md` §16.
 *
 *  - **A revert with a well-formed but unknown `messageID` answers `200` with
 *    `revert: null`.** It did nothing. That is reported here as `no_op` rather
 *    than as success, because a UI that trusted the status code would tell the
 *    operator their work was undone when it was not.
 *  - **`409 SessionBusyError`** while the agent is mid-turn, for both routes.
 *    Passed through as 409 with a `SESSION_BUSY` code: it is the one failure
 *    that is worth retrying.
 *  - **A successful unrevert emits no `session.diff` frame**, only
 *    `session.updated`. So the stored state is written from the response here
 *    instead of waited for.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getAgentInstances, getWorktreeById } from '@/lib/db';
import { isValidInstanceId } from '@/lib/cli-tools/types';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { createLogger } from '@/lib/logger';
import { OPENCODE_CLI_TOOL_ID } from '@/lib/hooks/sources/opencode/tool-id';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import {
  fetchOpencodeMessageDiff,
  revertOpencodeMessage,
  unrevertOpencodeSession,
  type OpencodeRevertOutcome,
} from '@/lib/hooks/sources/opencode/client';
import {
  getOpencodeSessionDiff,
  recordOpencodeRevertResult,
  refreshOpencodeTurnDiff,
} from '@/lib/hooks/sources/opencode/diff';

const logger = createLogger('api/opencode-diff');

/** The actions `POST` accepts. */
const OPENCODE_DIFF_ACTIONS = ['revert', 'unrevert'] as const;
type OpencodeDiffAction = (typeof OPENCODE_DIFF_ACTIONS)[number];

function isAction(value: unknown): value is OpencodeDiffAction {
  return (
    typeof value === 'string' && (OPENCODE_DIFF_ACTIONS as readonly string[]).includes(value)
  );
}

/** Same convention as the session route: the primary instance carries no id. */
function opencodeRef(worktreeId: string, instanceId: string): AgentInstanceRef {
  return {
    worktreeId,
    cliToolId: OPENCODE_CLI_TOOL_ID,
    instanceId: instanceId === OPENCODE_CLI_TOOL_ID ? undefined : instanceId,
  };
}

function opencodeInstanceIds(worktreeId: string): string[] {
  const db = getDbInstance();
  const ids = new Set<string>([OPENCODE_CLI_TOOL_ID]);
  for (const instance of getAgentInstances(db, worktreeId)) {
    if (instance.cliTool === OPENCODE_CLI_TOOL_ID) ids.add(instance.id);
  }
  return [...ids];
}

/** What every path through this route resolves first. */
type Resolved =
  | { ok: true; worktreeId: string; instanceId: string; target: AgentInstanceRef }
  | { ok: false; response: NextResponse };

function resolve(worktreeId: string, rawInstanceId: unknown): Resolved {
  const worktree = getWorktreeById(getDbInstance(), worktreeId);
  if (!worktree) {
    return {
      ok: false,
      response: NextResponse.json({ error: `Worktree '${worktreeId}' not found` }, { status: 404 }),
    };
  }

  const instanceId =
    typeof rawInstanceId === 'string' && rawInstanceId.length > 0
      ? rawInstanceId
      : OPENCODE_CLI_TOOL_ID;
  if (!isValidInstanceId(instanceId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid instanceId' }, { status: 400 }),
    };
  }
  if (!opencodeInstanceIds(worktreeId).includes(instanceId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Instance '${instanceId}' is not an opencode instance` },
        { status: 400 }
      ),
    };
  }

  return { ok: true, worktreeId, instanceId, target: opencodeRef(worktreeId, instanceId) };
}

/**
 * The record as the wire reports it.
 *
 * Rebuilt rather than returned by reference so a future field on the stored
 * record cannot leak onto the wire without someone deciding it should.
 */
function serialize(target: AgentInstanceRef) {
  const record = getOpencodeSessionDiff(
    target.worktreeId,
    OPENCODE_CLI_TOOL_ID,
    target.instanceId
  );
  if (!record) return null;
  return {
    sessionId: record.sessionId,
    turnMessageId: record.turnMessageId,
    files: record.files,
    filesAt: record.filesAt,
    revertedFiles: record.revertedFiles,
    revertedMessageId: record.revertedMessageId,
    at: record.at,
  };
}

/** Translate one measured outcome into the status the browser should see. */
function respondToOutcome(
  action: OpencodeDiffAction,
  outcome: OpencodeRevertOutcome,
  target: AgentInstanceRef
): NextResponse {
  if (outcome.kind === 'busy') {
    return NextResponse.json(
      {
        error: 'opencode refused: the session is mid-turn',
        code: 'SESSION_BUSY',
      },
      { status: 409 }
    );
  }
  if (outcome.kind === 'unreachable') {
    return NextResponse.json(
      { error: 'The opencode server did not answer', code: 'OPENCODE_UNREACHABLE' },
      { status: 502 }
    );
  }
  if (outcome.kind === 'rejected') {
    return NextResponse.json(
      { error: `opencode rejected the ${action}`, code: 'OPENCODE_REJECTED' },
      { status: 502 }
    );
  }
  // `no_op` is a 200 from opencode that changed nothing, and the panel needs to
  // say so rather than celebrate. Reported as 200 with `applied: false`: the
  // request was valid and the server answered, there is simply nothing to show
  // for it.
  return NextResponse.json(
    {
      action,
      applied: outcome.kind !== 'no_op',
      revertedMessageId: outcome.kind === 'reverted' ? outcome.messageId : null,
      diff: serialize(target),
    },
    { status: 200 }
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const worktreeId = canonicalWorktreeId(requestedWorktreeId);
    const resolved = resolve(worktreeId, request.nextUrl.searchParams.get('instance'));
    if (!resolved.ok) return resolved.response;

    const record = getOpencodeSessionDiff(
      worktreeId,
      OPENCODE_CLI_TOOL_ID,
      resolved.target.instanceId
    );
    const port = getAssignedOpencodePort(resolved.target);
    // A forced re-read, unlike the poll's `ensure...`: the caller asked, so the
    // once-per-turn rule does not apply. Skipped when there is nothing to ask
    // about, which is a pane that has not run a turn.
    if (port !== null && record?.sessionId && record.turnMessageId) {
      await refreshOpencodeTurnDiff(
        resolved.target,
        port,
        record.sessionId,
        record.turnMessageId
      );
    }

    return NextResponse.json({ diff: serialize(resolved.target) }, { status: 200 });
  } catch (error: unknown) {
    logger.error('opencode-diff:get-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to read the opencode diff' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const worktreeId = canonicalWorktreeId(requestedWorktreeId);

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // An empty body is not an action; the validation below reports it.
    }

    if (!isAction(body.action)) {
      return NextResponse.json(
        { error: `action must be one of: ${OPENCODE_DIFF_ACTIONS.join(', ')}` },
        { status: 400 }
      );
    }
    const action = body.action;

    const resolved = resolve(worktreeId, body.instanceId);
    if (!resolved.ok) return resolved.response;

    const port = getAssignedOpencodePort(resolved.target);
    if (port === null) {
      return NextResponse.json(
        { error: 'No opencode server is attached to this instance', code: 'NO_OPENCODE_PORT' },
        { status: 409 }
      );
    }

    const record = getOpencodeSessionDiff(
      worktreeId,
      OPENCODE_CLI_TOOL_ID,
      resolved.target.instanceId
    );
    const sessionId = record?.sessionId ?? null;
    if (sessionId === null) {
      return NextResponse.json(
        { error: 'No opencode session has reported a turn yet', code: 'NO_OPENCODE_SESSION' },
        { status: 409 }
      );
    }

    // The turn to undo is the one the panel is showing, taken from the server's
    // own record rather than from the request. A message id supplied by the
    // browser would let a stale tab revert a turn that is no longer on screen —
    // and revert is measured to delete files.
    if (action === 'revert') {
      const messageId = record?.turnMessageId ?? null;
      if (messageId === null) {
        return NextResponse.json(
          { error: 'No opencode turn to revert', code: 'NO_OPENCODE_TURN' },
          { status: 409 }
        );
      }
      const outcome = await revertOpencodeMessage(port, sessionId, messageId);
      logger.info('opencode-diff:revert', {
        worktreeId,
        instanceId: resolved.instanceId,
        sessionId,
        messageId,
        outcome: outcome.kind,
      });
      // The `session.diff` frame that follows a revert carries the held-back
      // files, but it is a race with this response. Reading them here makes the
      // reply self-consistent; the frame then writes the same thing again.
      if (outcome.kind === 'reverted') {
        const files = await fetchOpencodeMessageDiff(port, sessionId, messageId);
        recordOpencodeRevertResult(resolved.target, outcome.messageId, files ?? []);
      }
      return respondToOutcome(action, outcome, resolved.target);
    }

    const outcome = await unrevertOpencodeSession(port, sessionId);
    logger.info('opencode-diff:unrevert', {
      worktreeId,
      instanceId: resolved.instanceId,
      sessionId,
      outcome: outcome.kind,
    });
    // Measured: an unrevert emits no `session.diff`. Nothing else will ever
    // clear the held-back files, so this call is the one that does.
    if (outcome.kind === 'restored') {
      recordOpencodeRevertResult(resolved.target, null, []);
    }
    return respondToOutcome(action, outcome, resolved.target);
  } catch (error: unknown) {
    logger.error('opencode-diff:post-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to perform the opencode diff action' },
      { status: 500 }
    );
  }
}
