/**
 * The stages of `POST /api/hooks/agent-event`, split out of the route handler
 * (Issue #3376) so that each one can be read — and tested — on its own. The
 * route still runs them in the same order; nothing here answers HTTP.
 *
 * See `src/app/api/hooks/agent-event/route.ts` for why the route answers the
 * way it does.
 */

import type { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { resolveWorktreeByCwd, validateHookCwd } from '@/lib/hooks/agent-event-service';
import {
  AGENT_EVENT_TYPES,
  isAgentEventType,
  MAX_EVENT_DETAIL_LENGTH,
  type AgentEventType,
} from '@/lib/hooks/agent-event-types';
import { getAgentEventSource } from '@/lib/hooks/sources';
import type { AgentEventSource, NormalizedAgentEvent } from '@/lib/hooks/sources';
import {
  agentEventKeyClaimedAt,
  isDuplicateAgentEvent,
  joinOpenTurnFromDuplicate,
  recordAgentEvent,
  recordAskUserQuestion,
  shortSessionTag,
} from '@/lib/session/agent-event-state';
import { isSessionRunning } from '@/lib/session/cli-session';
import { MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH } from '@/lib/session/structured-prompt';
import type { createLogger } from '@/lib/logger';

/** The route's logger, handed in so every line keeps the route's logger name. */
export type AgentEventLogger = ReturnType<typeof createLogger>;

/** Bound on `sessionId`; it is an opaque agent-side identifier, only ever logged. */
export const MAX_SESSION_ID_LENGTH = 256;

/** A string field, or undefined when absent or of the wrong type. */
export function readString(payload: Record<string, unknown>, key: string): string | undefined {
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
export function readEvent(
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

/** A request read and validated, before any worktree has been looked up. */
export interface AgentEventRequest {
  tool: CLIToolType;
  source: AgentEventSource;
  receivedAt: number;
  normalized: NormalizedAgentEvent;
  event: AgentEventType;
  sessionId: string | undefined;
  instanceParam: string | undefined;
  worktreeIdParam: string | undefined;
  cwd: ReturnType<typeof validateHookCwd>;
}

/** Where the event says it came from: the instance, the worktree id and `cwd`. */
type AgentEventTarget = Pick<AgentEventRequest, 'instanceParam' | 'worktreeIdParam' | 'cwd'>;

/** The tool that sent this, or an error string. */
function readTool(
  payload: Record<string, unknown>,
  query: URLSearchParams
): CLIToolType | { error: string } {
  // The injected URL carries `tool`; the relay script and manual hooks put it
  // in the body. Body first, so an operator's explicit value is never
  // overridden by a stale URL.
  const toolValue = readString(payload, 'tool') ?? query.get('tool') ?? undefined;
  if (toolValue === undefined || !isCliToolType(toolValue)) {
    return { error: 'tool must be a known CLI tool id' };
  }
  return toolValue;
}

/** The agent session id, or an error string when the sent one is malformed. */
function readSessionId(
  payload: Record<string, unknown>
): { sessionId: string | undefined } | { error: string } {
  const sessionId = readString(payload, 'sessionId') ?? readString(payload, 'session_id');
  if (
    payload.sessionId !== undefined &&
    (typeof payload.sessionId !== 'string' || payload.sessionId.length > MAX_SESSION_ID_LENGTH)
  ) {
    return { error: `sessionId must be a string of at most ${MAX_SESSION_ID_LENGTH} characters` };
  }
  return { sessionId };
}

/** The instance, the worktree id and `cwd` the event names, or an error string. */
function readTarget(
  payload: Record<string, unknown>,
  query: URLSearchParams
): AgentEventTarget | { error: string } {
  const instanceParam = readString(payload, 'instanceId') ?? query.get('instanceId') ?? undefined;
  if (instanceParam !== undefined && !isValidInstanceId(instanceParam)) {
    return { error: 'instanceId must be a safe, bounded identifier' };
  }

  const worktreeIdParam =
    readString(payload, 'worktreeId') ?? query.get('worktreeId') ?? undefined;

  // `cwd` is only required when it is the sole way to find the worktree, but
  // it is validated whenever it is sent: a malformed path is a client bug
  // worth reporting even if this request did not need it.
  const cwdSent = payload.cwd !== undefined;
  const cwd = validateHookCwd(payload.cwd);
  if (!cwd.ok && (cwdSent || worktreeIdParam === undefined)) {
    return { error: `cwd rejected: ${cwd.reason}` };
  }
  return { instanceParam, worktreeIdParam, cwd };
}

/**
 * Read and validate the request body and query, in the order the route always
 * has: tool, event, session id, instance, worktree id, `cwd`. The first problem
 * found is returned as an error string; the route answers it with a 400.
 */
export function readAgentEventRequest(
  payload: Record<string, unknown>,
  query: URLSearchParams
): AgentEventRequest | { error: string } {
  const tool = readTool(payload, query);
  if (typeof tool !== 'string') {
    return tool;
  }

  // Issue #1759: the tool decides how its own payload is read. Every tool has
  // one — a tool with no implementation yet gets the compatibility source,
  // which behaves exactly as this route did before the abstraction existed.
  const source = getAgentEventSource(tool);

  const receivedAt = Date.now();
  const normalized = readEvent(source, payload, receivedAt);
  if ('error' in normalized) {
    return normalized;
  }
  const event: AgentEventType = normalized.event;

  const session = readSessionId(payload);
  if ('error' in session) {
    return session;
  }

  const target = readTarget(payload, query);
  if ('error' in target) {
    return target;
  }

  return { tool, source, receivedAt, normalized, event, sessionId: session.sessionId, ...target };
}

/** The worktree the event names: by id when one was sent, else by `cwd`. */
export function resolveAgentEventWorktree(
  db: ReturnType<typeof getDbInstance>,
  worktreeIdParam: string | undefined,
  cwd: ReturnType<typeof validateHookCwd>
): Worktree | null {
  let worktree: Worktree | null = null;
  if (worktreeIdParam !== undefined) {
    worktree = getWorktreeById(db, worktreeIdParam) ?? null;
  } else if (cwd.ok) {
    worktree = resolveWorktreeByCwd(db, cwd.cwd);
  }
  return worktree;
}

/** The subtype of the event, or null. */
export function readEventDetail(
  normalized: NormalizedAgentEvent,
  payload: Record<string, unknown>
): string | null {
  // The source pulls the subtype out of the payload in its own dialect
  // (Issue #1759, S2); `detail` is the relay script's already-extracted value
  // and stays as the fallback, because a hand-configured hook sends that and
  // nothing else.
  return (
    normalized.detail ??
    readString(payload, 'detail')?.slice(0, MAX_EVENT_DETAIL_LENGTH) ??
    null
  );
}

/** Everything the stages after worktree resolution need. */
export interface ResolvedAgentEvent {
  worktree: Worktree;
  tool: CLIToolType;
  source: AgentEventSource;
  instanceParam: string | undefined;
  event: AgentEventType;
  sessionId: string | undefined;
  receivedAt: number;
  detail: string | null;
  normalized: NormalizedAgentEvent;
}

/**
 * Drop the event when the duplicate window says it is a copy, and log the drop.
 *
 * @returns true when the event was dropped (the route answers 202 and stops)
 */
export function dropDuplicateAgentEvent(
  ctx: ResolvedAgentEvent,
  joinsOpenTurn: boolean,
  logger: AgentEventLogger
): boolean {
  const { worktree, tool, instanceParam, event, sessionId, receivedAt, detail } = ctx;
  if (!isDuplicateAgentEvent(worktree.id, tool, instanceParam, event, sessionId, receivedAt, detail)) {
    return false;
  }
  // Issue #3330: the mark is not part of the key, so the copy that carried
  // it can be the one dropped — an unmarked relay copy landed first and
  // re-opened the running turn. The mark still decides that turn.
  const joinedOpenTurn =
    joinsOpenTurn &&
    joinOpenTurnFromDuplicate(worktree.id, tool, instanceParam, {
      event,
      sessionId: sessionId ?? null,
      joinsOpenTurn,
    });
  // Issue #3311: enough to tell, from this line alone, which instance and
  // which agent session the drop was in and how long after the applied
  // delivery it came — a copy is a few ms behind, a second turn the window
  // swallowed is not. The daily metrics count the second kind. `sessionId`
  // is non-null here (the window only drops events that carry one) and is
  // logged as a hash prefix, never as itself.
  const claimedAt = agentEventKeyClaimedAt(worktree.id, tool, instanceParam, event, sessionId, detail);
  logger.info('agent-event-duplicate-dropped', {
    worktreeId: worktree.id,
    tool,
    instanceId: instanceParam ?? tool,
    event,
    detail,
    session: sessionId ? shortSessionTag(sessionId) : null,
    sinceLastMs: claimedAt === null ? null : receivedAt - claimedAt,
    ...(joinedOpenTurn ? { joinedOpenTurn } : {}),
  });
  return true;
}

/** Apply the event to the structured state, and log it when it was held. */
export function applyAgentEventToState(
  ctx: ResolvedAgentEvent,
  payload: Record<string, unknown>,
  joinsOpenTurn: boolean,
  logger: AgentEventLogger
): void {
  const { worktree, tool, source, instanceParam, event, sessionId, receivedAt, detail, normalized } =
    ctx;
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
      // Issue #3330: a background-task notice Claude attaches to its running
      // turn fires `UserPromptSubmit` as well. The source says which prompts
      // those are; the state decides whether there is a turn to join.
      joinsOpenTurn,
      // Issue #3437: read off the declaration, never the tool id. A source that
      // reports its prompts opens its turns on them, so a `pre_tool_use` after
      // its own `Stop` with no prompt since does not begin one.
      promptOpensTurns: source.capabilities.supportedEvents.includes('user_prompt_submit'),
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
}

/** Warn, without waiting, when a codex turn was filed under an instance with no session. */
export function warnIfCodexInstanceNotRunning(
  ctx: ResolvedAgentEvent,
  logger: AgentEventLogger
): void {
  const { worktree, tool, instanceParam, event, sessionId } = ctx;
  if (event === 'user_prompt_submit' && tool === 'codex') {
    // Issue #2874: codex 0.157+ runs hooks inside a machine-wide daemon whose
    // environment belongs to whichever instance started it, so a turn can be
    // filed under an instance that has no session at all. Detect and say so;
    // routing is left alone. Not awaited — the hook is waiting on this reply —
    // and never allowed to fail it.
    const notifiedWorktreeId = worktree.id;
    const notifiedInstanceId = instanceParam ?? tool;
    void (async () => {
      try {
        if (!(await isSessionRunning(notifiedWorktreeId, tool, notifiedInstanceId))) {
          logger.warn('agent-event-instance-not-running', {
            worktreeId: notifiedWorktreeId,
            tool,
            instanceId: notifiedInstanceId,
            event,
            sessionId: sessionId ?? null,
          });
        }
      } catch {
        /* ignore */
      }
    })();
  }
}

/** File the question a `pre_tool_use` event carries, if it carries one. */
export function recordQuestionIfAsked(
  ctx: ResolvedAgentEvent,
  payload: Record<string, unknown>,
  logger: AgentEventLogger
): void {
  const { worktree, tool, source, instanceParam, event, receivedAt } = ctx;
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
}
