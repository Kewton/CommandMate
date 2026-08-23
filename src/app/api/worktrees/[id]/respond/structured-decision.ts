/**
 * Answering an approval the caller named by its own id (Issue #1932).
 *
 * `/respond` was built for a stored chat message: the browser clicked a button
 * on a prompt row, so the row's id said which dialog was meant and the message
 * itself carried the tool and the instance to send the answer to. opencode has
 * no such row. Its approval is a REST object the agent is blocked on (#1758
 * §5.5), the scraper publishes no `promptData` for it, and the only handle
 * anything has on it is the decision id the structured layer reports.
 *
 * So this is the second way in: `{ decisionId, answer }` instead of
 * `{ messageId, answer }`, delivered over the agent's own API by
 * `answerPendingDecisionWithReceipt` rather than typed at a pane.
 *
 * ## Why the membership check is the whole module
 *
 * `lib/hooks/structured-decision-response` closes DR4-003 *by construction*:
 * it never accepts an id, it reads one back for the (worktree, tool, instance)
 * the request already resolved to. That option is not available here — the
 * caller has an id and is naming it — so the same property has to be
 * re-established by a lookup, and the rule is stated once, in one place:
 *
 *   **the id must appear in `listPending()` for the scope this request already
 *   resolved to, or nothing is delivered and the answer is 404.**
 *
 * The scope is never widened to search other instances or other worktrees
 * (§10.3 / D3 decision 3). A cross-instance id is not "a decision belonging to
 * someone else that we decline to answer" — it is a decision this request
 * cannot see at all, which is why the refusal is `decision_not_found` and not
 * `forbidden`.
 *
 * @module app/api/worktrees/[id]/respond/structured-decision
 */

import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import { getWorktreeById } from '@/lib/db';
import {
  describeSessionTargetConflict,
  resolveSessionTargetStrict,
  INSTANCE_TOOL_CONFLICT,
} from '@/lib/session/resolve-session-target';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import { getAgentEventSource } from '@/lib/hooks/sources';
import type { AgentInstanceRef, PendingDecision, Verdict } from '@/lib/hooks/sources';
import { answerPendingDecisionWithReceipt } from '@/lib/hooks/sources/pending-decisions';
import {
  resolveStructuredDecisionOption,
  STRUCTURED_REJECT_MESSAGE,
} from '@/lib/hooks/structured-decision-response';
import { STRUCTURED_DECISION_OPTIONS } from '@/lib/session/structured-prompt';
import { PERMISSION_REPLIED_DETAIL } from '@/lib/hooks/agent-event-types';
import { recordAgentEvent } from '@/lib/session/agent-event-state';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { startPolling } from '@/lib/polling/response-poller';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/respond/structured-decision');

/**
 * Longest `decisionId` accepted.
 *
 * The same bound `/api/hooks/agent-event` puts on `sessionId`, and for the same
 * reason: both are opaque agent-side tokens this server only ever compares and
 * logs. Stated here rather than imported because that one is a route-local
 * constant of a route this Issue does not own.
 */
export const MAX_DECISION_ID_LENGTH = 256;

/**
 * Characters a `decisionId` may contain — opencode's `per_…`, Claude's
 * `toolu_…`, and every other id the six sources publish.
 *
 * Mirrors `EVENT_IDENTITY_PATTERN` in `lib/hooks/sources/event-mapper`, which
 * guards the same values arriving from the other direction.
 */
const DECISION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Whether this is an id fit to be compared against a pending decision.
 *
 * **Discarded, never truncated** (§10 DR4-001). An id is compared for equality,
 * so cutting an over-long value down to the bound would make it collide with
 * every id sharing its prefix — which is a way of turning a malformed request
 * into an answer delivered to the wrong approval. Rejecting outright cannot do
 * that.
 */
export function isValidDecisionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DECISION_ID_LENGTH &&
    DECISION_ID_PATTERN.test(value)
  );
}

/**
 * The verdict each option number stands for.
 *
 * A copy of `verdictFor` in `lib/hooks/structured-decision-response`, which does
 * not export it and which this Issue may not edit (#1930 holds that file). The
 * option LIST is imported rather than copied, so the two cannot disagree about
 * what the numbers are; what is restated is only the mapping from number to
 * verdict kind, and `tests/unit/api/respond-decision-id-1932.test.ts` pins it
 * against the wire values the source actually POSTs, so a drift shows up as a
 * wrong reply rather than as a structural difference nobody reads.
 *
 * TODO(#1930 follow-up): export `verdictFor` (or an `answerStructuredDecision`
 * variant that takes an already-verified decision) and delete this.
 */
function verdictFor(optionNumber: number): Verdict | null {
  switch (optionNumber) {
    case 1:
      return { kind: 'allowOnce' };
    case 2:
      return { kind: 'allowAlways' };
    case 3:
      return { kind: 'deny', message: STRUCTURED_REJECT_MESSAGE };
    default:
      return null;
  }
}

export interface RespondByDecisionIdParams {
  db: Database.Database;
  /** The canonical worktree id the route already resolved. */
  worktreeId: string;
  /** As sent. Unvalidated — see {@link isValidDecisionId}. */
  decisionId: unknown;
  /** As sent. An option number, a label, or a `reply` word. */
  answer: unknown;
  /** Optional `cliTool` from the body. */
  cliToolParam?: unknown;
  /** Optional `instanceId` from the body. */
  instanceParam?: unknown;
}

/** The 404 every failed lookup answers with. One body, one code, no detail. */
function decisionNotFound(decisionId: string): NextResponse {
  return NextResponse.json(
    {
      error: `Decision '${decisionId}' is not pending for this worktree instance`,
      code: 'decision_not_found',
      reason: 'decision_not_found',
    },
    { status: 404 }
  );
}

/**
 * Answer the approval this request named, if this instance is really holding it.
 *
 * @returns The response to write. Never throws for a caller error; the route's
 *   own try/catch still covers a source that throws something unexpected.
 */
export async function respondByDecisionId({
  db,
  worktreeId,
  decisionId,
  answer,
  cliToolParam,
  instanceParam,
}: RespondByDecisionIdParams): Promise<NextResponse> {
  if (!isValidDecisionId(decisionId)) {
    return NextResponse.json(
      { error: 'Invalid decisionId format', code: 'invalid_decision_id' },
      { status: 400 }
    );
  }
  if (typeof answer !== 'string') {
    return NextResponse.json({ error: 'answer must be a string' }, { status: 400 });
  }

  // Same allowlists the `/prompt-response` route applies to the same two
  // fields, and rejected on the same terms: an unknown tool or a malformed
  // instance id is a client bug, not a target to guess at.
  if (cliToolParam !== undefined && !(typeof cliToolParam === 'string' && isCliToolType(cliToolParam))) {
    return NextResponse.json(
      { error: `Invalid cliTool: '${String(cliToolParam)}'` },
      { status: 400 }
    );
  }
  if (instanceParam !== undefined && !(typeof instanceParam === 'string' && isValidInstanceId(instanceParam))) {
    return NextResponse.json({ error: 'Invalid instanceId parameter' }, { status: 400 });
  }

  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) {
    return NextResponse.json({ error: `Worktree '${worktreeId}' not found` }, { status: 404 });
  }

  // The one resolver (design S4 D5), rather than a fifth copy of
  // `cliTool ?? worktree.cliToolId ?? 'claude'` — the tool id is half of the
  // scope this whole module is about, so resolving it differently here than
  // `send` does would mean the id is verified against one instance and the
  // verdict delivered to another. Strict because this route has a side effect:
  // a request whose named tool contradicts the roster is refused rather than
  // guessed at (D5 decision 3 / DR3-015).
  const resolution = resolveSessionTargetStrict(db, worktreeId, {
    ...(instanceParam === undefined ? {} : { instanceId: instanceParam }),
    ...(cliToolParam === undefined ? {} : { requestedCliTool: cliToolParam }),
  });
  if (!resolution.ok) {
    return NextResponse.json(
      {
        error: describeSessionTargetConflict(resolution.conflict),
        code: INSTANCE_TOOL_CONFLICT,
        reason: INSTANCE_TOOL_CONFLICT,
      },
      { status: 400 }
    );
  }
  const { cliToolId, instanceId } = resolution.target;

  const source = getAgentEventSource(cliToolId);
  if (source.capabilities.eventIdentity === null) {
    // This source publishes no per-decision id, so nothing it is holding can be
    // named by one. Same answer as an id that simply is not pending — from the
    // caller's side the two are the same fact.
    return decisionNotFound(decisionId);
  }

  const target: AgentInstanceRef = { worktreeId, cliToolId, instanceId };

  let pending: PendingDecision[];
  try {
    pending = await source.listPending(target);
  } catch (error) {
    // Unreachable is NOT not-found, and it is emphatically not "deliver
    // anyway": membership could not be established, so nothing may be sent.
    // `answerStructuredDecision` fails open here because it has a keystroke
    // path to fall back to; this route has none.
    logger.warn('respond-decision-source-unreachable', {
      worktreeId,
      cliToolId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        error: 'The agent could not be reached to verify the decision',
        code: 'decision_source_unreachable',
        reason: 'decision_source_unreachable',
      },
      { status: 502 }
    );
  }

  // The scope rule, in one line: only decisions this (worktree, tool, instance)
  // is holding. Removing this filter is the mutation the acceptance test pins.
  const decision = pending.find(
    (candidate) => candidate.kind === 'permission' && candidate.id === decisionId
  );
  if (!decision) {
    logger.info('respond-decision-not-found', {
      worktreeId,
      cliToolId,
      instanceId,
      pending: pending.length,
    });
    return decisionNotFound(decisionId);
  }

  const option = resolveStructuredDecisionOption(answer);
  const verdict = option ? verdictFor(option.number) : null;
  if (!option || !verdict) {
    return NextResponse.json(
      {
        error:
          `'${answer}' is not one of the verdicts this approval accepts. ` +
          STRUCTURED_DECISION_OPTIONS.map(
            (each) => `${each.number} = ${each.label} (${each.reply})`
          ).join(', ') +
          '.',
        code: 'answer_out_of_range',
        reason: 'answer_out_of_range',
      },
      { status: 400 }
    );
  }

  const { delivery } = await answerPendingDecisionWithReceipt(source, target, decision, verdict);
  const delivered = delivery?.delivered === true;

  if (delivered && source.capabilities.permissionReplyReleasesPrompt) {
    // The release the agent's own `permission.replied` frame would take, taken
    // here as well because that frame may be seconds away and the operator is
    // watching this response. Same call `answerStructuredDecision` makes.
    recordAgentEvent(worktreeId, cliToolId, instanceId, {
      event: 'notification',
      at: Date.now(),
      detail: PERMISSION_REPLIED_DETAIL,
      sessionId: decision.conversationId,
      decisionId: decision.id,
      promptSettled: true,
    });
  }

  // Issue #1548: a person answered, attributed exactly as every other
  // human-answered path attributes it.
  applyEventToActiveTask(db, worktreeId, cliToolId, instanceId, 'prompt_answered_human', {
    promptType: 'multiple_choice',
  });
  startPolling(worktreeId, cliToolId, instanceId);
  void broadcastTerminalSnapshotAfterInteraction(worktreeId, cliToolId, instanceId);

  logger.info('respond-decision-answered', {
    worktreeId,
    cliToolId,
    instanceId,
    decisionId: decision.id,
    optionNumber: option.number,
    reply: option.reply,
    delivered,
  });

  return NextResponse.json({
    success: delivered,
    answer: String(option.number),
    ...(delivered ? {} : { reason: 'decision_not_delivered' }),
    resolved: {
      via: 'structured-decision',
      optionNumber: option.number,
      optionLabel: option.label,
      decisionId: decision.id,
    },
  });
}
