/**
 * API Route: POST /api/hooks/agent-event
 *
 * The generalised receiver for structured agent lifecycle events (Issue #1549):
 * Claude Code's Stop hook, Codex's `notify`, and whatever comes next. It
 * supersedes `/api/hooks/claude-done`, which stays for compatibility and shares
 * this route's stop handling.
 *
 * Two things shape the responses. First, the caller identifies a worktree by
 * `cwd` rather than by id, because a hook script running inside an agent knows
 * its directory and nothing else. Second, an unrecognised `cwd` answers 202 with
 * the same body a recognised one gets: this endpoint is reachable by anything
 * that can reach the server, and a distinguishable response would turn it into a
 * probe for which directories are registered.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { isCliToolType } from '@/lib/cli-tools/types';
import {
  applyAgentStopEvent,
  isAgentEventType,
  resolveWorktreeByCwd,
  validateHookCwd,
} from '@/lib/hooks/agent-event-service';
import { AGENT_EVENT_TYPES } from '@/lib/hooks/agent-event-service';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/hooks-agent-event');

/** Bound on `sessionId`; it is an opaque agent-side identifier, only ever logged. */
const MAX_SESSION_ID_LENGTH = 256;

/** Identical body for every accepted request. See the module comment. */
const ACCEPTED = { accepted: true } as const;

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const payload = body as Record<string, unknown>;

    if (typeof payload.tool !== 'string' || !isCliToolType(payload.tool)) {
      return NextResponse.json({ error: 'tool must be a known CLI tool id' }, { status: 400 });
    }
    const tool = payload.tool;

    if (!isAgentEventType(payload.event)) {
      return NextResponse.json(
        { error: `event must be one of: ${AGENT_EVENT_TYPES.join(', ')}` },
        { status: 400 }
      );
    }
    const event = payload.event;

    const cwd = validateHookCwd(payload.cwd);
    if (!cwd.ok) {
      return NextResponse.json({ error: `cwd rejected: ${cwd.reason}` }, { status: 400 });
    }

    if (
      payload.sessionId !== undefined &&
      (typeof payload.sessionId !== 'string' || payload.sessionId.length > MAX_SESSION_ID_LENGTH)
    ) {
      return NextResponse.json(
        { error: `sessionId must be a string of at most ${MAX_SESSION_ID_LENGTH} characters` },
        { status: 400 }
      );
    }

    const db = getDbInstance();
    const worktree = resolveWorktreeByCwd(db, cwd.cwd);
    if (!worktree) {
      // Accepted and dropped: a hook left configured after a worktree was
      // removed is a normal state, not an error the agent can act on.
      logger.info('agent-event-unresolved-cwd', { tool, event });
      return NextResponse.json(ACCEPTED, { status: 202 });
    }

    if (event !== 'stop') {
      // Recorded for operators wiring hooks up; no state change yet (#1549).
      logger.info('agent-event-received', { worktreeId: worktree.id, tool, event });
      return NextResponse.json(ACCEPTED, { status: 202 });
    }

    const outcome = await applyAgentStopEvent(db, worktree, tool, tool);
    logger.info('agent-event-stop-applied', {
      worktreeId: worktree.id,
      tool,
      taskId: outcome.taskId,
      taskEventApplied: outcome.taskEventApplied,
      verificationRunId: outcome.verificationRunId,
    });

    return NextResponse.json(ACCEPTED, { status: 202 });
  } catch (error: unknown) {
    logger.error('error-processing-agent-event:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to process agent event' }, { status: 500 });
  }
}
