/**
 * Reading the approval id off a live prompt payload (Issue #1932).
 *
 * ## Why this is a defensive read rather than a field access
 *
 * The server already HAS the id. `StructuredPromptWaitingState.decisionId`
 * (`lib/session/agent-event-state`) holds it for exactly the sources that
 * publish one, and `current-output-builder` reads that same record to decide
 * whether to publish `decisionOptions` at all — the three verdicts a dialog
 * accepts are offered precisely when an id exists to address them to.
 *
 * What it does not do is put the id ON the payload:
 * `buildStructuredPromptData` copies `source` / `message` / `toolName` /
 * `askUserQuestion` / `decisionOptions` and stops there, so
 * {@link StructuredPromptWaitingData} declares no `decisionId` and the browser
 * cannot see one. Both files live under `src/lib/session/`, which Issue #1930
 * holds for the duration of this cycle, so this Issue publishes the receiving
 * end and reads the field the moment the sending end appears — one property in
 * `buildStructuredPromptData` and one line in the interface.
 *
 * Written as a validating read, not a cast: an id that is absent, empty or not
 * a string is answered as "no addressable approval", which is what leaves the
 * panel showing its pre-#1932 "answer it in the terminal" text.
 *
 * ## The question half (Issue #2039)
 *
 * {@link readPromptQuestionChoices} is the same shape of read for the OTHER
 * thing an addressable decision can be. It lives here rather than in the panel
 * because the two answers have to be taken from ONE payload consistently — the
 * panel must never draw the three approval verdicts and a question's choices at
 * the same time, and a precedence spread across two `&&` chains in JSX is a
 * precedence nobody can test.
 *
 * @module components/worktree/prompt-decision-id
 */

import type { LivePromptData } from '@/types/models';

/**
 * The decision id this payload names, or null.
 *
 * @param promptData - The live prompt from `/current-output`, or null
 * @returns The id, or null when the payload carries none
 */
export function readPromptDecisionId(promptData: LivePromptData | null): string | null {
  if (!promptData) return null;
  const candidate = (promptData as { decisionId?: unknown }).decisionId;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}

/** What {@link readPromptQuestionChoices} answers with. */
export interface PromptQuestionChoices {
  /** The question text, as the agent wrote it. */
  question: string;
  /**
   * The option labels, in payload order.
   *
   * Their POSITION is the answer: the panel sends `String(index + 1)` and
   * `resolveStructuredQuestionAnswer` resolves that against the same list, read
   * from `listPending()`. Both orders come from one parser
   * (`parseAskUserQuestionToolInput`) over the same `questions[0].options`, so
   * they agree by construction rather than by convention.
   */
  labels: string[];
  /** How many questions the one call carries; only the first is answerable. */
  questionCount: number;
}

/**
 * The choices a question is offering, when the panel may answer it
 * (Issue #2039).
 *
 * ## Why this is gated on three things at once
 *
 * `askUserQuestion` alone is not enough. It is published for Claude too — the
 * agent's own account of an `AskUserQuestion` call whose picker only the pane
 * can see — and there the labels are deliberately shown WITHOUT numbers,
 * because the picker renumbers and appends its own entries and a number
 * published against the wrong screen answers the wrong question (#1726). What
 * makes the numbers real is the same thing that made #1898's verdict numbers
 * real: an id to deliver them to, over the agent's own API, with no key sent to
 * any pane.
 *
 * So all three must hold:
 *
 *  1. `decisionId` — there is an approval-or-question the agent is holding.
 *  2. `askUserQuestion` — it published choices, and the call carries exactly
 *     ONE question. `answers` is one array per question and a single click
 *     cannot say what the others are, so `resolveStructuredQuestionAnswer`
 *     refuses a multi-question call — and a picker whose submit is a guaranteed
 *     400 is worse than the read-only list, which at least says to answer it in
 *     the terminal.
 *  3. **no `decisionOptions`** — the payload is NOT offering the three approval
 *     verdicts for this id.
 *
 * The third is the one that carries the safety property this Issue's acceptance
 * criteria name. `decisionOptions` is `STRUCTURED_DECISION_OPTIONS` — `Allow
 * once` / `Allow always` / `Reject` — and it is published by
 * `current-output-builder` exactly when the id names a *permission*
 * (`promptWaiting.source === 'notification'` plus `eventIdentity`). A payload
 * carrying both lists would be a server that could not say which kind of thing
 * the id names, and answering the wrong one is not harmless: a verdict sent to
 * a question is refused (`question-needs-answer-verdict`) and a choice sent to
 * an approval has no wire value. Rather than guess, the panel keeps the verdict
 * buttons and this returns null — the payload's own statement about the id
 * wins.
 *
 * @param promptData - The live prompt from `/current-output`, or null
 * @returns The first question and its labels, or null when the panel must not
 *   offer to answer it
 */
export function readPromptQuestionChoices(
  promptData: LivePromptData | null
): PromptQuestionChoices | null {
  if (readPromptDecisionId(promptData) === null) return null;
  const payload = promptData as {
    askUserQuestion?: { question?: unknown; labels?: unknown; questionCount?: unknown };
    decisionOptions?: unknown;
  };
  if (Array.isArray(payload.decisionOptions) && payload.decisionOptions.length > 0) return null;

  const asked = payload.askUserQuestion;
  if (!asked || typeof asked.question !== 'string' || asked.question === '') return null;
  if (!Array.isArray(asked.labels) || asked.labels.length === 0) return null;
  const labels = asked.labels.filter(
    (label): label is string => typeof label === 'string' && label !== ''
  );
  // Partial is worse than none: the numbers are positions in this list, so a
  // list with a hole in it numbers every choice after the hole wrongly.
  if (labels.length !== asked.labels.length) return null;

  const questionCount = typeof asked.questionCount === 'number' ? asked.questionCount : 1;
  // Gate 2's second half. Kept here rather than in the panel so that "may this
  // be answered from the browser?" has one answer and one test, and so the
  // panel's fallback stays the pre-#2039 read-only list rather than a picker
  // whose submit the server would refuse.
  if (questionCount !== 1) return null;

  return { question: asked.question, labels, questionCount };
}
