/**
 * Answering an approval by decision id, for the sources that have one
 * (Issue #1898-3).
 *
 * `commandmate respond` sends a keystroke. That is the only thing it could ever
 * do for a screen-scraped dialog, and it is why the route it posts to
 * (`/api/worktrees/:id/prompt-response`) re-captures the pane, runs
 * `detectPrompt`, and refuses with `prompt_no_longer_active` when nothing
 * parses. On opencode that refusal was the *normal* outcome: the structured
 * layer knew perfectly well a dialog was open — `wait` said so, in a sentence
 * telling the operator to use `respond` — and `respond` then exited 99, leaving
 * pressing a key in the tmux pane as the only way to answer.
 *
 * The dialog was never the thing to answer. opencode's approval is a REST
 * object with an id, held open until somebody replies to it (#1758 §5.5), and
 * that is what this module answers.
 *
 * ## The capability gate
 *
 * {@link AgentSourceCapabilities.eventIdentity} — "where a frame-unique id for
 * this source comes from" — is the declared value that decides whether an
 * approval can be addressed at all, and it is read rather than inferred from a
 * tool id (§4 D3 of `docs/design/multi-agent-state-architecture.md`). A source
 * that publishes no per-decision id has nothing for `respond` to name, so it
 * falls through to the pre-#1898 keystroke path unchanged.
 *
 * ## The scope rule (DR4-003 / S6)
 *
 * The decision id is **never taken from the caller**. It is read back from the
 * source for the (worktree, tool, instance) the request already resolved to,
 * and the answer selects among *those* by option number. A cross-instance or
 * cross-worktree id therefore cannot be expressed, let alone delivered — the
 * IDOR the design policy asks to be closed is closed by construction rather
 * than by a lookup that has to remember to filter.
 *
 * ## What is deliberately not answered here
 *
 * A pending `question.asked`. It is answered with a *choice* from a list the
 * agent supplied, not with one of the three approval verdicts, and its numbers
 * are the picker's rather than these. Questions keep the existing path.
 *
 * A `permissionDecision` record. That field says what **this server** decided
 * on the agent's behalf while nobody was looking, which is the thing that would
 * otherwise be invisible; a verdict a person typed is already visible in the
 * response they got back, and filing it there would make the field's own
 * question ("did Auto-Yes approve something?") unanswerable.
 *
 * @module lib/hooks/structured-decision-response
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import {
  STRUCTURED_DECISION_OPTIONS,
  type StructuredDecisionOption,
} from '@/lib/session/structured-prompt';
import { answerPendingDecisionWithReceipt } from './sources/pending-decisions';
import { getAgentEventSource } from './sources/registry';
import type { AgentInstanceRef, PendingDecision, Verdict } from './sources/types';
import { PERMISSION_REPLIED_DETAIL } from './agent-event-types';

const logger = createLogger('lib/hooks/structured-decision-response');

/** The message a rejection carries to the agent. It reaches it verbatim. */
export const STRUCTURED_REJECT_MESSAGE = 'Rejected by the operator via `commandmate respond`.';

/**
 * Spellings each verdict accepts, beyond its own number and `reply` word.
 *
 * `yes` resolves to **once** rather than to `always`, and that asymmetry is the
 * safety rule this whole subsystem is built on: a wrong allow executes a
 * command, so an ambiguous approval takes the narrowest of the two. `no`
 * resolves to `reject` because there is nothing narrower for it to mean.
 *
 * Resolving words at all is safe *here* and nowhere else. #1681's rule — that
 * `respond <id> no` must never be sent at a numbered dialog — is about
 * keystrokes: Enter takes whatever the cursor is on, so a word that is not a
 * number arrives as the highlighted default. Nothing is typed on this path; the
 * word picks a verdict, and the verdict is POSTed by name.
 */
const VERDICT_ALIASES: Readonly<Record<number, readonly string[]>> = {
  1: ['once', 'allow once', 'allow', 'yes', 'y'],
  2: ['always', 'allow always', 'allow-always'],
  3: ['reject', 'deny', 'no', 'n'],
};

/** The verdict each option number stands for. */
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

/** What a `respond` attempt did, or why it did nothing. */
export type StructuredDecisionOutcome =
  /**
   * This source publishes no decision id, or nothing is pending on it. The
   * caller must carry on with the keystroke path exactly as before — this is
   * the answer for every hook tool and for every opencode session with no
   * approval open.
   */
  | { kind: 'not-applicable'; reason: StructuredDecisionSkip }
  /** The answer named no verdict. Nothing was sent anywhere. */
  | { kind: 'refused'; reason: 'answer_out_of_range' | 'unresolvable_answer'; message: string }
  /** A verdict was delivered — or an attempt was made and reported. */
  | {
      kind: 'answered';
      decisionId: string;
      option: StructuredDecisionOption;
      delivered: boolean;
    };

/** Why the structured path declined to handle this request. */
export type StructuredDecisionSkip =
  /** `AgentSourceCapabilities.eventIdentity` is null: no id to address. */
  | 'no-decision-identity'
  /** The source was asked and is holding no approval. */
  | 'no-pending-decision'
  /** The source could not be reached. Fail-open onto the keystroke path. */
  | 'source-unreachable';

export interface AnswerStructuredDecisionParams {
  worktreeId: string;
  /** Already resolved by the caller. The scope the id is looked up in. */
  cliToolId: CLIToolType;
  instanceId?: string;
  /** The operator's answer — an option number, a label, or a `reply` word. */
  answer?: string;
  /** `respond --default`. Refused here; see {@link answerStructuredDecision}. */
  useDefault?: boolean;
}

/**
 * Resolve an answer against the option list.
 *
 * @returns The option, or null when nothing matched
 */
export function resolveStructuredDecisionOption(answer: string): StructuredDecisionOption | null {
  const normalized = answer.trim().toLowerCase();
  if (normalized === '') return null;
  for (const option of STRUCTURED_DECISION_OPTIONS) {
    if (normalized === String(option.number)) return option;
    if (normalized === option.label.toLowerCase()) return option;
    if (normalized === option.reply) return option;
    if ((VERDICT_ALIASES[option.number] ?? []).includes(normalized)) return option;
  }
  return null;
}

/**
 * Answer the approval this instance is blocked on, if it has one.
 *
 * Never throws. Every failure resolves to `not-applicable`, which puts the
 * caller back on the path it took before this module existed — the same
 * fail-open rule the adjudicator follows, for the same reason: a `respond` that
 * cannot reach the structured layer must still be able to press a key.
 *
 * `--default` is refused rather than guessed. There is a highlighted option in
 * the TUI, but nothing on the wire says which, and inventing one would make
 * `respond --default` approve a command on the strength of an assumption.
 */
export async function answerStructuredDecision({
  worktreeId,
  cliToolId,
  instanceId,
  answer,
  useDefault = false,
}: AnswerStructuredDecisionParams): Promise<StructuredDecisionOutcome> {
  const source = getAgentEventSource(cliToolId);
  if (source.capabilities.eventIdentity === null) {
    return { kind: 'not-applicable', reason: 'no-decision-identity' };
  }

  const target: AgentInstanceRef = { worktreeId, cliToolId, instanceId };

  let pending: PendingDecision[];
  try {
    pending = await source.listPending(target);
  } catch (error) {
    logger.warn('structured-decision-unreachable', {
      worktreeId,
      cliToolId,
      instanceId: instanceId ?? cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'not-applicable', reason: 'source-unreachable' };
  }

  const permissions = pending.filter((decision) => decision.kind === 'permission');
  if (permissions.length === 0) {
    return { kind: 'not-applicable', reason: 'no-pending-decision' };
  }

  // The oldest is the one a human has been looking at. `GET /permission` lists
  // them in the order the agent raised them, and an agent asks one thing at a
  // time, so this is a tie-break rather than a policy — but it has to be
  // written down, because answering the newest would silently approve the wrong
  // command on the day it is not a tie.
  const decision = permissions[0];
  if (permissions.length > 1) {
    logger.info('structured-decision-multiple-pending', {
      worktreeId,
      cliToolId,
      instanceId: instanceId ?? cliToolId,
      pending: permissions.length,
      answering: decision.id,
    });
  }

  if (useDefault) {
    return {
      kind: 'refused',
      reason: 'unresolvable_answer',
      message:
        '--default cannot answer a structured approval: the agent publishes no default verdict. ' +
        `Send a number instead — ${STRUCTURED_DECISION_OPTIONS.map(
          (option) => `${option.number} = ${option.label}`
        ).join(', ')}.`,
    };
  }

  const option = answer === undefined ? null : resolveStructuredDecisionOption(answer);
  if (!option) {
    return {
      kind: 'refused',
      reason: 'answer_out_of_range',
      message:
        `'${answer ?? ''}' is not one of the verdicts this approval accepts. ` +
        STRUCTURED_DECISION_OPTIONS.map(
          (each) => `${each.number} = ${each.label} (${each.reply})`
        ).join(', ') +
        '.',
    };
  }

  const verdict = verdictFor(option.number);
  // Unreachable while the option list and `verdictFor` agree; refusing rather
  // than asserting keeps a future fourth option from being delivered as an
  // allow by accident.
  if (!verdict) {
    return {
      kind: 'refused',
      reason: 'unresolvable_answer',
      message: `Option ${option.number} has no verdict on this server.`,
    };
  }

  const { delivery } = await answerPendingDecisionWithReceipt(source, target, decision, verdict);
  const delivered = delivery?.delivered === true;

  if (delivered && source.capabilities.permissionReplyReleasesPrompt) {
    // The same release the agent's own `permission.replied` frame would take,
    // through the same state machine — and taken here as well because the frame
    // may be seconds away and the operator is watching this response.
    const { recordAgentEvent } = await import('@/lib/session/agent-event-state');
    recordAgentEvent(worktreeId, cliToolId, instanceId, {
      event: 'notification',
      at: Date.now(),
      detail: PERMISSION_REPLIED_DETAIL,
      sessionId: decision.conversationId,
      decisionId: decision.id,
      promptSettled: true,
    });
  }

  logger.info('structured-decision-answered', {
    worktreeId,
    cliToolId,
    instanceId: instanceId ?? cliToolId,
    decisionId: decision.id,
    optionNumber: option.number,
    reply: option.reply,
    delivered,
  });

  return { kind: 'answered', decisionId: decision.id, option, delivered };
}
