/**
 * The prompt the structured layer publishes for a dialog nobody could parse
 * (Issue #1725).
 *
 * `Notification(notification_type=permission_prompt)` tells us a dialog is on
 * screen; it does not tell us what is in it. The live capture (#1721 §5.5)
 * measured the whole payload: a `message` written for a human
 * (`"Claude needs your permission to use Bash"`), a `notification_type`, and
 * nothing resembling the options the dialog is offering. So the fact the
 * structured layer can contribute is "a human has to act", and the shape below
 * is that fact and no more — a question, no options, and the agent's own line
 * kept verbatim for display.
 *
 * ## Why `type` is `unclassified` rather than a new prompt type
 *
 * `UNCLASSIFIED_PROMPT_TYPE` already means exactly this to every reader that
 * matters: `commandmate wait` reports it as the kind of exit 10 that nobody can
 * answer programmatically (#1708), `capture --prompts` renders it as its own
 * state instead of a pending prompt, and PromptPanel now degrades on it. Adding
 * a second word for "we know it is there, we cannot read it" would oblige each
 * of them to learn both. It is deliberately NOT a member of `PromptType` —
 * widening that union would force every exhaustive map over it (the contract
 * parser's promptType allowlist among them) to grow a case for a value no
 * prompt-answering path may accept. See the note on `UNCLASSIFIED_PROMPT_TYPE`
 * in `types/models.ts`.
 *
 * ## Pure on purpose
 *
 * Type-only imports and string building, exactly like `status-mapping`, so a
 * client component can import it: `PromptPanel`'s prop type widens to include
 * {@link StructuredPromptWaitingData} and it must be able to name the type.
 *
 * @module lib/session/structured-prompt
 */

import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';

/**
 * Where the structured layer learned that a dialog is open.
 *
 * - `notification` — `Notification(permission_prompt)`, which the spike
 *   measured firing ~6 s after the dialog is drawn and only then (§5.5). It is
 *   proof the dialog exists.
 * - `permission-request` — the `PermissionRequest` hook was answered with
 *   no-decision, which D5 measured as landing in the ordinary TUI approval
 *   flow, i.e. a dialog is about to be drawn. It arrives *before* the dialog,
 *   which is why a record from this source stays provisional until something
 *   corroborates it (see `agent-event-state`).
 */
export type StructuredPromptSource = 'notification' | 'permission-request';

/** Bound on the agent's `message`, which is prose and only ever displayed. */
export const MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH = 500;

/**
 * The question an `AskUserQuestion` call asked, for a dialog nobody parsed
 * (Issue #1726).
 *
 * Attached to the degraded form and *only* to it. When the scraper can read the
 * picker, the options are published properly — as a `multiple_choice` with real
 * option numbers (`ask-user-question-prompt`). This is what is left to say when
 * it cannot: the text of what was asked, so the human is not told merely that
 * "a dialog is open" while the server is holding the question.
 *
 * There are no numbers here on purpose. A single tool call walks through one
 * screen per question and then a `1. Submit answers / 2. Cancel` confirmation,
 * emitting no event at any transition (§5.6), so a layer that cannot see the
 * screen cannot know which of them is up — and a number published against the
 * wrong screen is an answer to the wrong question.
 */
export interface StructuredAskUserQuestionSummary {
  /** The first question of the call. */
  question: string;
  /** Its option labels, in the order the payload listed them. */
  labels: string[];
  /** How many questions the one tool call carries. */
  questionCount: number;
}

/** What a structured prompt is built from, from either source. */
export interface StructuredPromptFacts {
  source: StructuredPromptSource;
  /**
   * The agent's own human-facing line (`Notification.message`), or null.
   *
   * Display only. `notification_type` is the machine key (D3); this string is
   * English prose that Claude is free to reword, so nothing may branch on it.
   */
  message: string | null;
  /** Tool the pre-empted request named, when the source knows it. */
  toolName?: string | null;
  /** The `AskUserQuestion` call in flight, when there is one (Issue #1726). */
  askUserQuestion?: StructuredAskUserQuestionSummary | null;
}

/**
 * The prompt published on `currentOutput.promptData` while the structured layer
 * — and only the structured layer — can see a dialog.
 *
 * Not a `PromptData`: it has no options, so nothing that answers prompts by
 * option number may be handed it by a path that only checks `messageType`.
 * `status` is `'pending'` because, unlike #1708's record of a detection
 * failure, this one *is* waiting for an answer — a human can give it in the
 * terminal.
 */
export interface StructuredPromptWaitingData {
  type: typeof UNCLASSIFIED_PROMPT_TYPE;
  status: 'pending';
  /** One line naming the situation and how to answer it. Already English. */
  question: string;
  /** Always empty: the dialog's options were never in the payload. */
  options: never[];
  /** Which structured signal reported it. */
  source: StructuredPromptSource;
  /** The agent's own line, for display. See {@link StructuredPromptFacts.message}. */
  message?: string;
  /** Tool the pre-empted permission request named, when known. */
  toolName?: string;
  /** What the agent asked, when it was an `AskUserQuestion` (Issue #1726). */
  askUserQuestion?: StructuredAskUserQuestionSummary;
}

/**
 * The prompt-history row written when the structured layer saw a dialog the
 * scraper did not (Issue #1725, continuing #1708's proposal 2).
 *
 * `status` is `'unclassified'`, not `'pending'`, for the reason #1708 gives:
 * `markPendingPromptsAsAnswered()` selects on `status = 'pending'`, and this row
 * must never be stamped "(answered via terminal)" on the strength of a sweep —
 * it is an audit record of a detection gap, and the answer, if one comes, is
 * recorded by the ordinary prompt writer against its own row.
 */
export interface StructuredPromptHistoryRecord {
  type: typeof UNCLASSIFIED_PROMPT_TYPE;
  status: 'unclassified';
  question: string;
  options: never[];
  source: StructuredPromptSource;
  message?: string;
  toolName?: string;
  /** What the agent asked, when it was an `AskUserQuestion` (Issue #1726). */
  askUserQuestion?: StructuredAskUserQuestionSummary;
}

/** How each source reads in the one-line question. */
const SOURCE_LABEL: Record<StructuredPromptSource, string> = {
  notification: 'Notification(permission_prompt)',
  'permission-request': 'PermissionRequest (no decision)',
};

/**
 * The one line every surface shows for a structured prompt.
 *
 * It names the option NUMBER on purpose. `respond <id> yes` is not resolved
 * semantically on a numbered dialog — Enter takes the highlighted default
 * instead, so a "no" can be delivered as an approval (Issue #1681). This text
 * is the only guidance a caller of `wait` gets, so it has to say which form
 * actually works.
 */
export function buildStructuredPromptQuestion(
  worktreeId: string,
  facts: StructuredPromptFacts,
): string {
  const parts = [
    `A dialog is open in ${worktreeId}: the agent reported it via ${SOURCE_LABEL[facts.source]}` +
      `${facts.toolName ? ` for ${facts.toolName}` : ''}, but the detection layer published no ` +
      `options for it.`,
    `Answer it in the terminal, or send the option NUMBER with ` +
      `\`commandmate respond ${worktreeId} <number>\` — yes/no is not resolved on a numbered ` +
      `dialog (Issue #1681).`,
  ];
  if (facts.message) {
    parts.push(`Agent message: "${facts.message}"`);
  }
  if (facts.askUserQuestion) {
    const { question, labels, questionCount } = facts.askUserQuestion;
    parts.push(
      `The agent asked${questionCount > 1 ? ` ${questionCount} questions, the first being` : ''}: ` +
        `"${question}" — offering: ${labels.join(' / ')}. ` +
        `The picker renumbers and adds its own entries, so read the option NUMBER off the ` +
        `terminal rather than counting this list.`,
    );
  }
  return parts.join(' ');
}

/** The live `promptData` for a structured prompt. */
export function buildStructuredPromptData(
  worktreeId: string,
  facts: StructuredPromptFacts,
): StructuredPromptWaitingData {
  return {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'pending',
    question: buildStructuredPromptQuestion(worktreeId, facts),
    options: [],
    source: facts.source,
    ...(facts.message ? { message: facts.message } : {}),
    ...(facts.toolName ? { toolName: facts.toolName } : {}),
    ...(facts.askUserQuestion ? { askUserQuestion: facts.askUserQuestion } : {}),
  };
}

/** The prompt-history row for a structured prompt the scraper never saw. */
export function buildStructuredPromptHistoryRecord(
  worktreeId: string,
  facts: StructuredPromptFacts,
): StructuredPromptHistoryRecord {
  return {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'unclassified',
    question: buildStructuredPromptQuestion(worktreeId, facts),
    options: [],
    source: facts.source,
    ...(facts.message ? { message: facts.message } : {}),
    ...(facts.toolName ? { toolName: facts.toolName } : {}),
    ...(facts.askUserQuestion ? { askUserQuestion: facts.askUserQuestion } : {}),
  };
}

/** Whether this prompt payload is the degraded structured form. */
export function isStructuredPromptWaitingData(
  value: { type?: unknown } | null | undefined,
): value is StructuredPromptWaitingData {
  return value?.type === UNCLASSIFIED_PROMPT_TYPE;
}
