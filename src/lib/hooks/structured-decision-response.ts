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
 * ## Questions are answered here too, and NOT as verdicts (Issue #2039)
 *
 * Until #2039 a pending `question.asked` was declined outright, and the reason
 * given was sound but was read as one reason too many: a question is answered
 * with a *choice* from a list the agent supplied, not with one of the three
 * approval verdicts, and its numbers are the picker's rather than these. All of
 * that is still true. What #2039 adds is the *other* mapping — see
 * {@link questionDecisionOptions} and {@link resolveStructuredQuestionAnswer},
 * which turn an option number, an option label or free text into the
 * `answers: string[][]` that `POST /question/:id/reply` takes, and produce a
 * `{ kind: 'answer' }` verdict that no permission path can consume.
 *
 * The two vocabularies never meet. `resolveStructuredDecisionOption` resolves
 * against {@link STRUCTURED_DECISION_OPTIONS} — three fixed verdicts — and the
 * question resolver resolves against the choices *this question* published;
 * neither falls back to the other. A verdict delivered to a question is refused
 * at the source (`question-needs-answer-verdict` in `sources/opencode/source`)
 * and an `answer` delivered to an approval has no wire value
 * (`toOpencodePermissionReply` answers null), so a crossed wire fails closed on
 * both sides rather than approving something.
 *
 * ## What is deliberately not answered here
 *
 * A question **selected off `listPending()` by this function**. See
 * {@link answerStructuredDecision}: it goes on picking approvals only, because
 * choosing to route a bare `commandmate respond <worktree> 2` onto a pending
 * question is Issue #2040's decision (its rule is "exactly one pending decision,
 * or 404/409"), and the mapping this module now exports is what #2040 calls when
 * it makes it. The addressed path — `{ decisionId, answer }` — does not have
 * that ambiguity to resolve and answers questions today: see
 * `app/api/worktrees/[id]/respond/structured-decision`.
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
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
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

// =============================================================================
// Questions (Issue #2039)
// =============================================================================

/**
 * Cap on a free-text answer to a question.
 *
 * The same bound `ask-user-question-payload` puts on the question TEXT, applied
 * to the reply for the symmetric reason: both are prose that reaches the agent
 * verbatim, and the request body this is read from is whatever a caller chose to
 * POST. **Refused, never truncated** — the rule #1932 states for ids holds for
 * prose too, one step weaker: a truncated id answers the wrong approval, and a
 * truncated sentence answers the right question with something the operator did
 * not say.
 */
export const MAX_QUESTION_FREE_TEXT_LENGTH = 1000;

/**
 * The choices one question offers, numbered the way `respond` numbers them
 * (Issue #2039).
 *
 * Shaped as {@link StructuredDecisionOption} on purpose, and this is the design
 * judgement to know about rather than an economy of types. Issue #2040 maps a
 * bare `commandmate respond <worktree> <n>` onto whatever single decision an
 * instance is holding, and it must be able to do that without asking which KIND
 * of decision it is: an approval publishes three fixed verdicts, a question
 * publishes its own list, and both come back as `{ number, label, reply }`. What
 * `reply` MEANS still differs — for a verdict it is opencode's wire word
 * (`once` / `always` / `reject`), for a choice it is the label itself, which is
 * exactly what `answers: string[][]` carries — but neither caller has to know
 * that, because the value goes straight onto the wire in both cases.
 *
 * Only the first question is numbered. See
 * {@link resolveStructuredQuestionAnswer} for why a multi-question call is
 * refused rather than partially answered.
 *
 * @param spec - The question the agent published
 * @returns One option per choice, 1-based in payload order; empty when the spec
 *   carries no questions
 */
export function questionDecisionOptions(
  spec: AskUserQuestionSpec
): readonly StructuredDecisionOption[] {
  const entry = spec.questions[0];
  if (!entry) return [];
  return entry.choices.map((choice, index) => ({
    number: index + 1,
    label: choice.label,
    // The wire value for a question IS the label (#1758 §5.2.4:
    // `{"answers":[["Blue"]]}`), so `reply` is not a second spelling of it.
    reply: choice.label,
  }));
}

/** Why an answer could not be turned into a reply to this question. */
export type QuestionAnswerRefusal =
  /** A number outside the published list, so it names no choice. */
  | 'answer_out_of_range'
  /** Several numbers for a question the agent declared single-select. */
  | 'multi_select_not_offered'
  /** More than one question in one call; see {@link resolveStructuredQuestionAnswer}. */
  | 'multi_question_unsupported'
  /** Empty, whitespace, or longer than {@link MAX_QUESTION_FREE_TEXT_LENGTH}. */
  | 'unresolvable_answer';

/** An answer this server is prepared to POST to `/question/:id/reply`. */
export interface ResolvedQuestionAnswer {
  /** The wire value: one array of chosen labels per question. */
  answers: string[][];
  /** The choices the numbers named. Empty for a free-text answer. */
  selected: readonly StructuredDecisionOption[];
  /** Whether this is prose the agent never offered. */
  freeText: boolean;
}

/** {@link resolveStructuredQuestionAnswer}'s two outcomes. */
export type QuestionAnswerResolution =
  | { ok: true; resolved: ResolvedQuestionAnswer }
  | { ok: false; reason: QuestionAnswerRefusal; message: string };

/**
 * A selection is written as digits, optionally several of them.
 *
 * Anchored and digits-only so it can never half-match: `1,3` is a selection,
 * `1 apple` is not, and the fall-through for anything that is not a selection is
 * a label match and then free text. The order matters — a numeric answer is
 * resolved as a NUMBER first and refused if it is out of range, rather than
 * quietly becoming free text, because "3" typed at a two-option question is an
 * operator who miscounted and not an operator who meant to say the word three.
 */
const QUESTION_SELECTION_PATTERN = /^\d+(?:\s*[,\s]\s*\d+)*$/;

/** The `1 = Red, 2 = Blue` list every refusal quotes back. */
function describeQuestionOptions(options: readonly StructuredDecisionOption[]): string {
  return options.map((option) => `${option.number} = ${option.label}`).join(', ');
}

/**
 * Turn an operator's answer into the `answers` a question reply carries
 * (Issue #2039).
 *
 * Three forms, resolved in this order:
 *
 *  1. **option numbers** — `2`, or `1,3` when the agent declared `multiSelect`.
 *     Resolved against {@link questionDecisionOptions}, so the numbers are the
 *     payload's own order rather than a screen's.
 *  2. **an option label** — `Blue`, case-insensitively. The same convenience
 *     `resolveStructuredDecisionOption` offers, and safe for the same reason:
 *     nothing is typed at a pane, so #1681's "a word arrives as the highlighted
 *     default" cannot happen here.
 *  3. **free text** — anything else, sent as the single answer.
 *
 * ## Why a multi-question call is refused
 *
 * `answers` is one array PER QUESTION, in payload order (#1758 §5.2.4). A single
 * answer string can name choices for one of them, and there is no measured
 * meaning for the arrays belonging to the others — an empty array is not known
 * to mean "skip". Answering the first and guessing the rest would deliver an
 * answer the operator did not give, so a call carrying more than one question is
 * refused and the terminal keeps it. Every `question.asked` captured so far
 * carries exactly one (`tests/fixtures/hooks/opencode/question-asked.json`), and
 * the browser payload only ever summarises the first
 * (`summarizeAskUserQuestion`), so this is the honest bound rather than a
 * shortcut.
 *
 * @param spec - The question, as `listPending()` reported it
 * @param answer - What the operator sent
 * @returns The reply, or the reason it is not one
 */
export function resolveStructuredQuestionAnswer(
  spec: AskUserQuestionSpec,
  answer: string
): QuestionAnswerResolution {
  const trimmed = answer.trim();
  if (trimmed === '') {
    return {
      ok: false,
      reason: 'unresolvable_answer',
      message: 'An empty answer names no choice.',
    };
  }

  if (spec.questions.length !== 1) {
    return {
      ok: false,
      reason: 'multi_question_unsupported',
      message:
        `This call asks ${spec.questions.length} questions and \`answers\` carries one array ` +
        'per question; a single answer cannot say what the others are. Answer it in the terminal.',
    };
  }

  const entry = spec.questions[0];
  const options = questionDecisionOptions(spec);

  if (QUESTION_SELECTION_PATTERN.test(trimmed)) {
    const picked: StructuredDecisionOption[] = [];
    for (const token of trimmed.split(/[,\s]+/)) {
      const option = options.find((candidate) => candidate.number === Number(token));
      if (!option) {
        return {
          ok: false,
          reason: 'answer_out_of_range',
          message:
            `'${trimmed}' names no choice this question offers. ` +
            `${describeQuestionOptions(options)}.`,
        };
      }
      // A repeated number is the same choice, not a second one — de-duplicated
      // here so `1,1` cannot make a single-select answer look like two.
      if (!picked.some((already) => already.number === option.number)) picked.push(option);
    }
    if (picked.length > 1 && !entry.multiSelect) {
      return {
        ok: false,
        reason: 'multi_select_not_offered',
        message:
          'This question accepts one choice. Send a single number: ' +
          `${describeQuestionOptions(options)}.`,
      };
    }
    return {
      ok: true,
      resolved: {
        answers: [picked.map((option) => option.reply)],
        selected: picked,
        freeText: false,
      },
    };
  }

  const labelled = options.find(
    (option) => option.label.toLowerCase() === trimmed.toLowerCase()
  );
  if (labelled) {
    return {
      ok: true,
      resolved: { answers: [[labelled.reply]], selected: [labelled], freeText: false },
    };
  }

  if (trimmed.length > MAX_QUESTION_FREE_TEXT_LENGTH) {
    return {
      ok: false,
      reason: 'unresolvable_answer',
      message:
        `A free-text answer is limited to ${MAX_QUESTION_FREE_TEXT_LENGTH} characters; ` +
        'this one is longer and is refused rather than cut short.',
    };
  }

  return { ok: true, resolved: { answers: [[trimmed]], selected: [], freeText: true } };
}

/**
 * The verdict a resolved question answer is delivered as (Issue #2039).
 *
 * A one-line constructor rather than an inline object literal, because the
 * `answer` member of {@link Verdict} is the only one that carries a payload and
 * building it beside the permission verdicts is how the two get confused.
 */
export function questionAnswerVerdict(resolved: ResolvedQuestionAnswer): Verdict {
  return { kind: 'answer', answers: resolved.answers };
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
