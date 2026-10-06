/**
 * API Route: POST /api/hooks/agent-event
 *
 * The generalised receiver for structured agent lifecycle events (Issue #1549):
 * Claude Code's hooks, Codex's `notify`, and whatever comes next. It supersedes
 * `/api/hooks/claude-done`, which stays for compatibility and shares this
 * route's stop handling.
 *
 * Three things shape the responses. First, an unrecognised caller answers 202
 * with the same body a recognised one gets: this endpoint is reachable by
 * anything that can reach the server, and a distinguishable response would turn
 * it into a probe for which worktrees are registered. Second, it accepts two
 * request shapes — see {@link readEvent}. Third, correlation is explicit when it
 * can be and inferred from `cwd` when it cannot.
 *
 * ## Correlation (Issue #1722)
 *
 * `cwd` identifies a worktree but *cannot* identify an instance: `claude` and
 * `claude-2` run in the same directory, which is why this route used to apply
 * every event to the primary instance. Sessions CommandMate starts now carry
 * `worktreeId` and `instanceId` in the hook URL itself, fixed at injection time.
 * When they are present they win; when they are absent — a hand-configured hook
 * from the #1549 guide — the old `cwd` path runs unchanged and still resolves to
 * the primary instance.
 *
 * `session_id` is *not* used for identity. `/clear` ends the agent session and
 * opens a new one with a different id while the instance, the worktree and the
 * pane are all untouched (Issue #1721).
 *
 * ## Which tool sent this (Issue #1759)
 *
 * This route no longer knows. It reads `tool`, asks `getAgentEventSource` for
 * that tool's {@link AgentEventSource}, and lets the source say what the payload
 * means: which native spelling maps to which of the seven words, where the
 * subtype lives, and whether the body is a question. Adding codex, copilot,
 * gemini, antigravity or opencode changes nothing in this file — which is the
 * whole point, because the five of them disagree with each other about every
 * one of those things (`docs/design/agent-hooks-phase4-live-verification.md`
 * §8.1, `docs/design/opencode-server-live-verification.md` §5.2.3).
 */

import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { applyAgentStopEvent } from '@/lib/hooks/agent-event-service';
import {
  applyAgentEventToState,
  dropDuplicateAgentEvent,
  readAgentEventRequest,
  readEventDetail,
  recordQuestionIfAsked,
  resolveAgentEventWorktree,
  warnIfCodexInstanceNotRunning,
  type ResolvedAgentEvent,
} from '@/lib/hooks/agent-event-intake';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/hooks-agent-event');

/** Identical body for every accepted request. See the module comment. */
const ACCEPTED = { accepted: true } as const;

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

/** `cwdHash` of `agent-event-unresolved-target`: SHA-256 of `cwd`, first 16 hex characters (Issue #3312). */
function hashUnresolvedCwd(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return badRequest('Request body must be a JSON object');
    }
    const payload = body as Record<string, unknown>;
    const query = new URL(request.url).searchParams;

    // Tool, event, session id, instance, worktree id and `cwd`, in that order
    // (Issue #3376: see `readAgentEventRequest`).
    const parsed = readAgentEventRequest(payload, query);
    if ('error' in parsed) {
      return badRequest(parsed.error);
    }
    const { tool, source, receivedAt, normalized, event, sessionId, instanceParam } = parsed;

    const db = getDbInstance();
    const worktree = resolveAgentEventWorktree(db, parsed.worktreeIdParam, parsed.cwd);

    if (!worktree) {
      // Accepted and dropped: a hook left configured after a worktree was
      // removed is a normal state, not an error the agent can act on.
      //
      // Issue #3312: enough to tell, from this log alone, which run a stray
      // event came from (a daily check whose hooks reached this server):
      //   worktreeId — the id the hook URL named, when it named one
      //   cwdHash    — the first 16 hex characters of the SHA-256 of `cwd`, for
      //                events that carry no id. `cwd` itself is never logged:
      //                it is a path on someone's disk, and the hash is enough
      //                to match a run that knows its own cwd.
      logger.info('agent-event-unresolved-target', {
        tool,
        event,
        ...(parsed.worktreeIdParam !== undefined ? { worktreeId: parsed.worktreeIdParam } : {}),
        ...(parsed.cwd.ok ? { cwdHash: hashUnresolvedCwd(parsed.cwd.cwd) } : {}),
      });
      return NextResponse.json(ACCEPTED, { status: 202 });
    }

    const detail = readEventDetail(normalized, payload);
    const ctx: ResolvedAgentEvent = {
      worktree,
      tool,
      source,
      instanceParam,
      event,
      sessionId,
      receivedAt,
      detail,
      normalized,
    };

    // Injection does not replace the user's own hooks, it is concatenated with
    // them, so anyone who followed the #1549 manual setup now delivers each
    // event twice. Both copies name the same agent session and arrive inside
    // the window — and so do the `stop`s of two short turns of one session,
    // which the session id cannot tell from a copy (Issue #3289). The turn
    // start that arrived between them can: `isDuplicateAgentEvent` sees every
    // delivery in arrival order, and a turn start it applies releases that
    // session's `stop`.
    //
    // The same holds the other way round (Issue #3301): two turns of one
    // session can start inside the window, and the `stop` between them is what
    // tells the second start from a copy. What the window is left to drop is a
    // second start with no `stop` before it — which on Claude is mostly not a
    // copy at all, but Claude Code firing `UserPromptSubmit` once for each
    // queued notice it attaches to a turn that is already running. Those that
    // get through join that turn rather than opening one (Issue #3330), so
    // whether the window drops them no longer decides the turn.
    const joinsOpenTurn =
      event === 'user_prompt_submit' && source.promptJoinsOpenTurn?.(payload) === true;

    if (dropDuplicateAgentEvent(ctx, joinsOpenTurn, logger)) {
      return NextResponse.json(ACCEPTED, { status: 202 });
    }

    applyAgentEventToState(ctx, payload, joinsOpenTurn, logger);

    warnIfCodexInstanceNotRunning(ctx, logger);

    recordQuestionIfAsked(ctx, payload, logger);

    if (event !== 'stop') {
      // Recorded for operators wiring hooks up; no state change yet (#1549).
      // Turning these into a completion verdict is Issue #1723.
      logger.info('agent-event-received', {
        worktreeId: worktree.id,
        tool,
        instanceId: instanceParam,
        event,
        detail,
      });
      return NextResponse.json(ACCEPTED, { status: 202 });
    }

    // Issue #1722: the instance the event actually came from, instead of the
    // primary instance this route used to assume for every caller.
    const instanceId = instanceParam ?? tool;
    const outcome = await applyAgentStopEvent(db, worktree, tool, instanceId);
    logger.info('agent-event-stop-applied', {
      worktreeId: worktree.id,
      tool,
      instanceId,
      taskId: outcome.taskId,
      taskEventApplied: outcome.taskEventApplied,
      verificationRunId: outcome.verificationRunId,
      // Issue #2246: the stop event is now the transcript reader's second
      // trigger. Logged so that "the reply never reached History" can be told
      // apart from "the reader was never asked".
      structuredHistoryCaptured: outcome.structuredHistoryCaptured,
    });

    return NextResponse.json(ACCEPTED, { status: 202 });
  } catch (error: unknown) {
    logger.error('error-processing-agent-event:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to process agent event' }, { status: 500 });
  }
}
