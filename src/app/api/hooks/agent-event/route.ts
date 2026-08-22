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

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import {
  applyAgentStopEvent,
  resolveWorktreeByCwd,
  validateHookCwd,
} from '@/lib/hooks/agent-event-service';
import {
  AGENT_EVENT_TYPES,
  isAgentEventType,
  MAX_EVENT_DETAIL_LENGTH,
  type AgentEventType,
} from '@/lib/hooks/agent-event-types';
import { getAgentEventSource } from '@/lib/hooks/sources';
import type { AgentEventSource, NormalizedAgentEvent } from '@/lib/hooks/sources';
import {
  isDuplicateAgentEvent,
  recordAgentEvent,
  recordAskUserQuestion,
} from '@/lib/session/agent-event-state';
import { MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH } from '@/lib/session/structured-prompt';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/hooks-agent-event');

/** Bound on `sessionId`; it is an opaque agent-side identifier, only ever logged. */
const MAX_SESSION_ID_LENGTH = 256;

/** Identical body for every accepted request. See the module comment. */
const ACCEPTED = { accepted: true } as const;

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

/** A string field, or undefined when absent or of the wrong type. */
function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The event, from either request shape, in the sending tool's own dialect.
 *
 * - **CommandMate's shape** (`{ tool, event, cwd }`) is what
 *   `scripts/hooks/cmate-agent-event.sh` and every hand-written hook from the
 *   #1549 guide send. The word is already resolved, so it is handed straight to
 *   the source — which is also the only channel antigravity has, since its
 *   payloads carry no event name at all (#1757 R2).
 * - **The agent's own payload** (`{ hook_event_name, cwd, session_id, … }`) is
 *   what an injected `type: "http"` hook sends, because that hook type posts the
 *   payload verbatim — the body is not configurable.
 *
 * Which spellings the second shape may use is the *source's* business, not this
 * route's (Issue #1759): Claude, codex and copilot say `Stop`, gemini says
 * `AfterAgent`, opencode says `session.idle`, and this function no longer knows
 * any of that.
 *
 * @param source - The source for the tool that sent this
 * @param payload - The request body
 * @param receivedAt - Epoch ms
 * @returns The normalised event, or an error string naming what was wrong
 */
function readEvent(
  source: AgentEventSource,
  payload: Record<string, unknown>,
  receivedAt: number
): NormalizedAgentEvent | { error: string } {
  const explicit = payload.event;
  if (explicit !== undefined && !isAgentEventType(explicit)) {
    return { error: `event must be one of: ${AGENT_EVENT_TYPES.join(', ')}` };
  }

  const normalized = source.normalizeEvent({
    payload,
    event: isAgentEventType(explicit) ? explicit : null,
    receivedAt,
  });
  if (normalized) return normalized;

  // Unmapped rather than absent: the caller named an event this tool's source
  // does not recognise. It has already been counted (C8); the request is still
  // refused, because a hook nobody can interpret is a configuration error the
  // operator wants to hear about.
  if (payload.hook_event_name !== undefined) {
    return {
      error: `hook_event_name is not a lifecycle event: ${String(payload.hook_event_name)}`,
    };
  }
  return { error: `event must be one of: ${AGENT_EVENT_TYPES.join(', ')}` };
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return badRequest('Request body must be a JSON object');
    }
    const payload = body as Record<string, unknown>;
    const query = new URL(request.url).searchParams;

    // The injected URL carries `tool`; the relay script and manual hooks put it
    // in the body. Body first, so an operator's explicit value is never
    // overridden by a stale URL.
    const toolValue = readString(payload, 'tool') ?? query.get('tool') ?? undefined;
    if (toolValue === undefined || !isCliToolType(toolValue)) {
      return badRequest('tool must be a known CLI tool id');
    }
    const tool: CLIToolType = toolValue;

    // Issue #1759: the tool decides how its own payload is read. Every tool has
    // one — a tool with no implementation yet gets the compatibility source,
    // which behaves exactly as this route did before the abstraction existed.
    const source = getAgentEventSource(tool);

    const receivedAt = Date.now();
    const normalized = readEvent(source, payload, receivedAt);
    if ('error' in normalized) {
      return badRequest(normalized.error);
    }
    const event: AgentEventType = normalized.event;

    const sessionId = readString(payload, 'sessionId') ?? readString(payload, 'session_id');
    if (
      payload.sessionId !== undefined &&
      (typeof payload.sessionId !== 'string' || payload.sessionId.length > MAX_SESSION_ID_LENGTH)
    ) {
      return badRequest(
        `sessionId must be a string of at most ${MAX_SESSION_ID_LENGTH} characters`
      );
    }

    const instanceParam = readString(payload, 'instanceId') ?? query.get('instanceId') ?? undefined;
    if (instanceParam !== undefined && !isValidInstanceId(instanceParam)) {
      return badRequest('instanceId must be a safe, bounded identifier');
    }

    const worktreeIdParam =
      readString(payload, 'worktreeId') ?? query.get('worktreeId') ?? undefined;

    // `cwd` is only required when it is the sole way to find the worktree, but
    // it is validated whenever it is sent: a malformed path is a client bug
    // worth reporting even if this request did not need it.
    const cwdSent = payload.cwd !== undefined;
    const cwd = validateHookCwd(payload.cwd);
    if (!cwd.ok && (cwdSent || worktreeIdParam === undefined)) {
      return badRequest(`cwd rejected: ${cwd.reason}`);
    }

    const db = getDbInstance();
    let worktree: Worktree | null = null;
    if (worktreeIdParam !== undefined) {
      worktree = getWorktreeById(db, worktreeIdParam) ?? null;
    } else if (cwd.ok) {
      worktree = resolveWorktreeByCwd(db, cwd.cwd);
    }

    if (!worktree) {
      // Accepted and dropped: a hook left configured after a worktree was
      // removed is a normal state, not an error the agent can act on.
      logger.info('agent-event-unresolved-target', { tool, event });
      return NextResponse.json(ACCEPTED, { status: 202 });
    }

    // The source pulls the subtype out of the payload in its own dialect
    // (Issue #1759, S2); `detail` is the relay script's already-extracted value
    // and stays as the fallback, because a hand-configured hook sends that and
    // nothing else.
    const detail =
      normalized.detail ??
      readString(payload, 'detail')?.slice(0, MAX_EVENT_DETAIL_LENGTH) ??
      null;

    // Injection does not replace the user's own hooks, it is concatenated with
    // them, so anyone who followed the #1549 manual setup now delivers each
    // event twice. Both copies name the same agent session, which is what makes
    // them distinguishable from two genuine turns.
    if (isDuplicateAgentEvent(worktree.id, tool, instanceParam, event, sessionId, receivedAt, detail)) {
      logger.info('agent-event-duplicate-dropped', { worktreeId: worktree.id, tool, event });
      return NextResponse.json(ACCEPTED, { status: 202 });
    }

    const recordOutcome = recordAgentEvent(
      worktree.id,
      tool,
      instanceParam,
      {
        event,
        at: receivedAt,
        detail,
        sessionId: sessionId ?? null,
        // Issue #1725: `Notification.message` is the agent's own one-line summary
        // ("Claude needs your permission to use Bash"). Kept for display beside
        // the prompt it announces; `notification_type` (in `detail`) remains the
        // only thing anything branches on (D3).
        message:
          readString(payload, 'message')?.slice(0, MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH) ?? null,
        // Issue #1783: which key holds the model is the source's business — it is
        // `model` on claude and codex and `modelName` on antigravity — so this
        // route reads the already-normalised value and never the payload. Already
        // bounded at extraction; null for the tools that never send one, and for
        // every Claude event except `SessionStart`, which is why the store latches
        // the last non-null rather than the newest.
        model: normalized.model,
      },
      {
        // Issue #1903: the declared value, read off the source this route already
        // asked the registry for — never compared against a tool id. copilot
        // fires `UserPromptSubmit` and then `SessionStart` 12-15 s later, and
        // without this the second one erased the first one's `running`.
        sessionStartMayArriveLate: source.capabilities.sessionStartMayArriveLate,
      }
    );

    if (!recordOutcome.recorded) {
      // Never silent: a held frame is the one thing an operator debugging
      // "my hooks fire and nothing happens" needs to be able to see.
      logger.info('agent-event-held', {
        worktreeId: worktree.id,
        tool,
        instanceId: instanceParam,
        event,
        reason: recordOutcome.skipped,
      });
    }

    if (event === 'pre_tool_use') {
      // Issue #1726: the one event whose *body* is the point. The injected hook
      // carries `matcher: "AskUserQuestion"`, but `tool_name` is re-read here
      // rather than trusted — the user's own settings.json is concatenated with
      // the injected one (#1722), so a wider matcher can land other tools on
      // this route, and a `Bash` payload must never be filed as a question.
      //
      // Recorded AFTER `recordAgentEvent`, which is what releases a previous
      // question; the order matters because this event is the one exception to
      // that release.
      //
      // Issue #1759: which fields hold the question is the source's business
      // (S7). opencode's `question.asked` carries structured choices in a shape
      // that shares no field name with Claude's `tool_input.questions`.
      const spec = source.parseQuestion(payload);
      if (spec) {
        recordAskUserQuestion(worktree.id, tool, instanceParam, spec, receivedAt);
        logger.info('ask-user-question-recorded', {
          worktreeId: worktree.id,
          tool,
          instanceId: instanceParam,
          questionCount: spec.questions.length,
          optionCounts: spec.questions.map((q) => q.choices.length),
        });
      }
    }

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
    });

    return NextResponse.json(ACCEPTED, { status: 202 });
  } catch (error: unknown) {
    logger.error('error-processing-agent-event:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to process agent event' }, { status: 500 });
  }
}
