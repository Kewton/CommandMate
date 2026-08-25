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
 * ## Questions (Issue #2039)
 *
 * opencode publishes two kinds of pending decision on one stream and answers
 * them with two near-identical REST calls (#1758 §5.4/§5.5), so this route now
 * addresses both. **The membership rule above is unchanged and is applied
 * before the kind is looked at**: an id that is not in `listPending()` for this
 * scope is 404 whether it names an approval or a question, and widening the
 * `find` to accept questions widened WHAT can be answered, never WHERE it is
 * looked for.
 *
 * What the kind decides is only the vocabulary the answer is resolved in, and
 * the two are kept apart on purpose:
 *
 *  - `permission` -> {@link resolveStructuredDecisionOption}, three fixed
 *    verdicts (`once` / `always` / `reject`).
 *  - `question` -> {@link resolveStructuredQuestionAnswer}, the choices THIS
 *    question published, delivered as `{ kind: 'answer', answers }`.
 *
 * Neither resolver falls back to the other, and both wire formats fail closed if
 * they ever met: a verdict handed to a question is refused at the source
 * (`question-needs-answer-verdict`) and an `answer` handed to an approval has no
 * wire value (`toOpencodePermissionReply` answers null). So "3" at a
 * two-option question is `answer_out_of_range` — never `Reject`.
 *
 * ## The sole pending decision (Issue #2040)
 *
 * A third way in, and the one `commandmate respond <worktree> 3` takes:
 * `{ answer }` with no id at all. It exists because naming an id is not
 * something a person does — the id has to be lifted out of `capture --json`
 * first — and because the number typed instead used to be a KEYSTROKE, which on
 * opencode is either refused (#2033: every opencode dialog is `answerMode:
 * 'keys'`) or, before that, typed at a composer.
 *
 * The rule is stated in one sentence and the whole of it is the safety
 * argument: **the answer is delivered only when this instance is holding
 * exactly one decision.** Zero is `404 decision_not_found` — there is nothing a
 * number could name. Two or more is `409 multiple_pending_decisions`, because a
 * number is a position and the caller never said in which list: answering the
 * oldest would approve a command the operator did not look at, which is the
 * whole failure this Issue exists to prevent. Neither refusal sends anything,
 * anywhere.
 *
 * The membership rule above is untouched — there is no id to check membership
 * of, because the decision is *read back* for the scope the request already
 * resolved to, which is `lib/hooks/structured-decision-response`'s
 * by-construction property rather than this module's lookup.
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
import { isCliToolType, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { getAgentEventSource } from '@/lib/hooks/sources';
import type { AgentInstanceRef, PendingDecision, Verdict } from '@/lib/hooks/sources';
import { answerPendingDecisionWithReceipt } from '@/lib/hooks/sources/pending-decisions';
import {
  questionAnswerVerdict,
  questionDecisionOptions,
  resolveStructuredDecisionOption,
  resolveStructuredQuestionAnswer,
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

/** {@link respondToSolePendingDecision}'s input — the same, minus the id. */
export interface RespondToSolePendingDecisionParams {
  db: Database.Database;
  /** The canonical worktree id the route already resolved. */
  worktreeId: string;
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
 * The same 404, for a request that named no id (Issue #2040).
 *
 * Deliberately the same `code`. From the caller's side the fact is identical —
 * there is no decision here for this answer to reach — and a second code would
 * oblige every reader to learn two words for one outcome. What differs is only
 * the sentence, because there is no id to quote back.
 */
function noPendingDecision(): NextResponse {
  return NextResponse.json(
    {
      error: 'This agent instance is not holding a decision to answer',
      code: 'decision_not_found',
      reason: 'decision_not_found',
    },
    { status: 404 }
  );
}

/**
 * The 409 a number cannot be resolved through (Issue #2040).
 *
 * The ids are listed because the refusal is otherwise a dead end: they are what
 * `{ decisionId, answer }` takes, so an operator who wants one of these answered
 * has somewhere to go. `toolName` is included for an approval — it is what the
 * dialog is *about*, and it is already published on `structuredEvents` — and the
 * question's text is not, for the reason `PendingDecisionPayload` gives for
 * leaving `tool_input` out: this body is an error, and an error is the wrong
 * place to start serving the agent's own content from.
 */
function multiplePendingDecisions(pending: readonly PendingDecision[]): NextResponse {
  return NextResponse.json(
    {
      error:
        `This agent instance is holding ${pending.length} decisions, and an option number ` +
        'names a position in one of them. Answer them one at a time by id, or in the terminal.',
      code: 'multiple_pending_decisions',
      reason: 'multiple_pending_decisions',
      decisions: pending.map((decision) => ({
        id: decision.id,
        kind: decision.kind,
        toolName: decision.subject.kind === 'permission' ? decision.subject.toolName : null,
      })),
    },
    { status: 409 }
  );
}

/** The (tool, instance) a request resolved to, and the source that speaks for it. */
interface DecisionScope {
  cliToolId: CLIToolType;
  instanceId: string;
  source: ReturnType<typeof getAgentEventSource>;
  target: AgentInstanceRef;
}

/** Either a scope to act in, or the response to write instead. */
type ScopeResolution =
  | { ok: true; scope: DecisionScope }
  | { ok: false; response: NextResponse };

/**
 * Validate the request's optional target fields and resolve the scope.
 *
 * Shared by both entry points so the id-addressed path and the sole-decision
 * path cannot resolve differently — the tool id is half of the scope the
 * membership rule is about, and two resolvers is how a verdict gets verified
 * against one instance and delivered to another.
 */
function resolveDecisionScope({
  db,
  worktreeId,
  cliToolParam,
  instanceParam,
}: {
  db: Database.Database;
  worktreeId: string;
  cliToolParam?: unknown;
  instanceParam?: unknown;
}): ScopeResolution {
  // Same allowlists the `/prompt-response` route applies to the same two
  // fields, and rejected on the same terms: an unknown tool or a malformed
  // instance id is a client bug, not a target to guess at.
  if (cliToolParam !== undefined && !(typeof cliToolParam === 'string' && isCliToolType(cliToolParam))) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Invalid cliTool: '${String(cliToolParam)}'` },
        { status: 400 }
      ),
    };
  }
  if (instanceParam !== undefined && !(typeof instanceParam === 'string' && isValidInstanceId(instanceParam))) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid instanceId parameter' }, { status: 400 }),
    };
  }

  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) {
    return {
      ok: false,
      response: NextResponse.json({ error: `Worktree '${worktreeId}' not found` }, { status: 404 }),
    };
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
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: describeSessionTargetConflict(resolution.conflict),
          code: INSTANCE_TOOL_CONFLICT,
          reason: INSTANCE_TOOL_CONFLICT,
        },
        { status: 400 }
      ),
    };
  }
  const { cliToolId, instanceId } = resolution.target;

  return {
    ok: true,
    scope: {
      cliToolId,
      instanceId,
      source: getAgentEventSource(cliToolId),
      target: { worktreeId, cliToolId, instanceId },
    },
  };
}

/** Either the decisions this scope is holding, or the response to write. */
type PendingLookup =
  | { ok: true; pending: PendingDecision[] }
  | { ok: false; response: NextResponse };

/**
 * Read back what this instance is holding, refusing rather than guessing.
 *
 * Unreachable is NOT not-found, and it is emphatically not "deliver anyway":
 * membership could not be established, so nothing may be sent.
 * `answerStructuredDecision` fails open here because it has a keystroke path to
 * fall back to; this route has none.
 */
async function listPendingForScope(
  scope: DecisionScope,
  worktreeId: string
): Promise<PendingLookup> {
  try {
    return { ok: true, pending: await scope.source.listPending(scope.target) };
  } catch (error) {
    logger.warn('respond-decision-source-unreachable', {
      worktreeId,
      cliToolId: scope.cliToolId,
      instanceId: scope.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'The agent could not be reached to verify the decision',
          code: 'decision_source_unreachable',
          reason: 'decision_source_unreachable',
        },
        { status: 502 }
      ),
    };
  }
}

/**
 * Deliver an answer to a decision this scope has already been shown to hold.
 *
 * The one place the kind chooses a vocabulary, reached from both entry points.
 * Neither branch looks anything up: whichever way the decision was selected —
 * by the id the caller named (#1932/#2039) or by being the only one (#2040) —
 * the scope rule has already been satisfied before this is called.
 */
async function answerResolvedDecision({
  db,
  scope,
  decision,
  answer,
  worktreeId,
}: {
  db: Database.Database;
  scope: DecisionScope;
  decision: PendingDecision;
  answer: string;
  worktreeId: string;
}): Promise<NextResponse> {
  if (decision.kind === 'question') {
    return await answerPendingQuestion({
      db,
      source: scope.source,
      target: scope.target,
      decision,
      answer,
      worktreeId,
      cliToolId: scope.cliToolId,
      instanceId: scope.instanceId,
    });
  }
  return await answerPendingApproval({
    db,
    source: scope.source,
    target: scope.target,
    decision,
    answer,
    worktreeId,
    cliToolId: scope.cliToolId,
    instanceId: scope.instanceId,
  });
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

  const resolved = resolveDecisionScope({ db, worktreeId, cliToolParam, instanceParam });
  if (!resolved.ok) return resolved.response;
  const scope = resolved.scope;

  if (scope.source.capabilities.eventIdentity === null) {
    // This source publishes no per-decision id, so nothing it is holding can be
    // named by one. Same answer as an id that simply is not pending — from the
    // caller's side the two are the same fact.
    return decisionNotFound(decisionId);
  }

  const lookup = await listPendingForScope(scope, worktreeId);
  if (!lookup.ok) return lookup.response;

  // The scope rule, in one line: only decisions this (worktree, tool, instance)
  // is holding. Removing this filter is the mutation the acceptance test pins.
  //
  // Issue #2039 widened the predicate from `kind === 'permission' && id === …`
  // to the id alone, and what that widened is WHAT can be answered, never WHERE
  // it is looked for: the array is still `listPending(target)` for the scope
  // this request already resolved to, so a question belonging to another
  // instance is as invisible as an approval belonging to one. The kind decides
  // the vocabulary the answer is resolved in, below, and nothing else.
  const decision = lookup.pending.find((candidate) => candidate.id === decisionId);
  if (!decision) {
    logger.info('respond-decision-not-found', {
      worktreeId,
      cliToolId: scope.cliToolId,
      instanceId: scope.instanceId,
      pending: lookup.pending.length,
    });
    return decisionNotFound(decisionId);
  }

  return await answerResolvedDecision({ db, scope, decision, answer, worktreeId });
}

/**
 * Answer the one decision this instance is holding, or refuse (Issue #2040).
 *
 * `commandmate respond <worktree> 3`'s path. See the module comment for the
 * safety argument; the code below is that argument in four branches, and none
 * of them sends anything unless the count is exactly one.
 *
 * @returns The response to write. Never throws for a caller error.
 */
export async function respondToSolePendingDecision({
  db,
  worktreeId,
  answer,
  cliToolParam,
  instanceParam,
}: RespondToSolePendingDecisionParams): Promise<NextResponse> {
  if (typeof answer !== 'string') {
    return NextResponse.json({ error: 'answer must be a string' }, { status: 400 });
  }

  const resolved = resolveDecisionScope({ db, worktreeId, cliToolParam, instanceParam });
  if (!resolved.ok) return resolved.response;
  const scope = resolved.scope;

  if (scope.source.capabilities.eventIdentity === null) {
    // The capability read, never a tool check (§4 D3). A source with no
    // per-decision id has no decision this path could deliver to, and the
    // keystroke path it would otherwise fall back to is a DIFFERENT route
    // (`/prompt-response`) — so this is refused with its own code rather than
    // sharing `decision_not_found`, which a caller must not retry through.
    return NextResponse.json(
      {
        error:
          `The '${scope.cliToolId}' agent publishes no per-decision id, so a structured ` +
          'answer cannot be addressed to it. Answer it through /prompt-response instead.',
        code: 'decision_source_unaddressable',
        reason: 'decision_source_unaddressable',
      },
      { status: 404 }
    );
  }

  const lookup = await listPendingForScope(scope, worktreeId);
  if (!lookup.ok) return lookup.response;
  const pending = lookup.pending;

  if (pending.length === 0) {
    logger.info('respond-sole-decision-none-pending', {
      worktreeId,
      cliToolId: scope.cliToolId,
      instanceId: scope.instanceId,
    });
    return noPendingDecision();
  }
  if (pending.length > 1) {
    // Refused, never resolved to the oldest. `answerStructuredDecision` does
    // take the oldest and says why (it is a tie-break on a list an agent fills
    // one at a time), but that path has a keystroke to fall back to and this one
    // delivers a verdict over the agent's own API: the day it is not a tie, the
    // caller would have approved a command it never saw.
    logger.info('respond-sole-decision-ambiguous', {
      worktreeId,
      cliToolId: scope.cliToolId,
      instanceId: scope.instanceId,
      pending: pending.length,
    });
    return multiplePendingDecisions(pending);
  }

  return await answerResolvedDecision({
    db,
    scope,
    decision: pending[0],
    answer,
    worktreeId,
  });
}

/**
 * Answer an approval with one of the three verdicts (Issue #1932).
 *
 * Reached only once the scope rule has been satisfied — see
 * {@link answerResolvedDecision}. Lifted out of `respondByDecisionId` by Issue
 * #2040 so the sole-decision path resolves the SAME three verdicts against the
 * SAME list; a second copy is how `3` would come to mean `Reject` on one path
 * and something else on the other.
 */
async function answerPendingApproval({
  db,
  source,
  target,
  decision,
  answer,
  worktreeId,
  cliToolId,
  instanceId,
}: {
  db: Database.Database;
  source: ReturnType<typeof getAgentEventSource>;
  target: AgentInstanceRef;
  decision: PendingDecision;
  answer: string;
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
}): Promise<NextResponse> {
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

  settleAnsweredDecision({
    db,
    source,
    decision,
    delivered,
    worktreeId,
    cliToolId,
    instanceId,
  });

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

/**
 * Everything both branches do once the agent has been told (Issue #2039).
 *
 * Lifted out of the approval path rather than copied into the question one. The
 * four effects here are the difference between "the POST returned 200" and "the
 * server stopped saying a human is blocked", and #1898's measurement is what
 * they cost when one of them is missed: `capture --json` read
 * `waiting / hook_permission_prompt` for the whole of the tool call that
 * followed a delivered verdict. A question blocks the session in exactly the
 * same way (§5.3.1 — the session reads `busy` and no `session.idle` arrives
 * until it is answered), so it has to be released in exactly the same way.
 */
function settleAnsweredDecision({
  db,
  source,
  decision,
  delivered,
  worktreeId,
  cliToolId,
  instanceId,
}: {
  db: Database.Database;
  source: ReturnType<typeof getAgentEventSource>;
  decision: PendingDecision;
  delivered: boolean;
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
}): void {
  if (delivered && source.capabilities.permissionReplyReleasesPrompt) {
    // The release the agent's own `permission.replied` frame would take, taken
    // here as well because that frame may be seconds away and the operator is
    // watching this response. Same call `answerStructuredDecision` makes.
    //
    // Issue #2039: taken for a question too, and the detail word stays
    // `permission_replied` on purpose. `agent-event-state` reads it as "the
    // dialog this instance was holding is gone" and retires the record by id
    // (`releaseSettledDecision`); it is the vocabulary of the STATE MACHINE, not
    // a claim about which endpoint was POSTed to. A second word would oblige
    // every reader of that machine to learn both for one meaning.
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
}

/**
 * Answer the question this instance is holding (Issue #2039).
 *
 * Reached only from {@link respondByDecisionId}, and only after the membership
 * check has already passed — this function does no lookup of its own, which is
 * how the scope rule stays stated in exactly one place.
 *
 * The answer is resolved against the choices THIS question published
 * (`resolveStructuredQuestionAnswer`), never against the three approval
 * verdicts, and the two lists cannot be reached from one another: `3` at a
 * two-option question is `answer_out_of_range` here, where the approval branch
 * would have read it as `Reject`.
 */
async function answerPendingQuestion({
  db,
  source,
  target,
  decision,
  answer,
  worktreeId,
  cliToolId,
  instanceId,
}: {
  db: Database.Database;
  source: ReturnType<typeof getAgentEventSource>;
  target: AgentInstanceRef;
  decision: PendingDecision;
  answer: string;
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
}): Promise<NextResponse> {
  if (decision.subject.kind !== 'question') {
    // The source said `kind: 'question'` and then handed back an approval
    // subject. Nothing can be resolved against a list that is not there, and the
    // caller's fact is unchanged — there is no question here it can address — so
    // this is the same 404 an absent id gets rather than a new failure mode.
    logger.warn('respond-decision-question-subject-missing', {
      worktreeId,
      cliToolId,
      instanceId,
      decisionId: decision.id,
      subjectKind: decision.subject.kind,
    });
    return decisionNotFound(decision.id);
  }

  const spec = decision.subject.spec;
  const resolution = resolveStructuredQuestionAnswer(spec, answer);
  if (!resolution.ok) {
    return NextResponse.json(
      {
        error: resolution.message,
        code: resolution.reason,
        reason: resolution.reason,
        // The list the answer was judged against, so a caller that guessed a
        // number can see the real one without a second round trip. Issue #2040
        // maps a bare `respond <worktree> <n>` onto this same list.
        options: questionDecisionOptions(spec).map((option) => ({
          number: option.number,
          label: option.label,
        })),
      },
      { status: 400 }
    );
  }

  const verdict = questionAnswerVerdict(resolution.resolved);
  const { delivery } = await answerPendingDecisionWithReceipt(source, target, decision, verdict);
  const delivered = delivery?.delivered === true;

  settleAnsweredDecision({
    db,
    source,
    decision,
    delivered,
    worktreeId,
    cliToolId,
    instanceId,
  });

  const optionNumbers = resolution.resolved.selected.map((option) => option.number);

  logger.info('respond-question-answered', {
    worktreeId,
    cliToolId,
    instanceId,
    decisionId: decision.id,
    optionNumbers,
    // The labels themselves are the agent's own text and reach the agent
    // verbatim; whether this was a choice or prose is the fact a log can act on.
    freeText: resolution.resolved.freeText,
    delivered,
  });

  return NextResponse.json({
    success: delivered,
    answer: optionNumbers.length > 0 ? optionNumbers.join(',') : answer.trim(),
    ...(delivered ? {} : { reason: 'decision_not_delivered' }),
    resolved: {
      via: 'structured-question',
      decisionId: decision.id,
      // Exactly what went on the wire. A caller reconciling its own UI against
      // what the agent was told needs the labels, not the numbers it sent.
      answers: resolution.resolved.answers,
      optionNumbers,
      optionLabels: resolution.resolved.selected.map((option) => option.label),
      freeText: resolution.resolved.freeText,
    },
  });
}
