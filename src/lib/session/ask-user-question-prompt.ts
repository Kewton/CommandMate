/**
 * Putting the agent's own question in front of the human (Issue #1726).
 *
 * `PreToolUse(AskUserQuestion)` hands this server the question and its options
 * as JSON. The screen renders something *related but not equal* to that JSON,
 * and the difference is the whole of this module's subject matter — it was
 * measured, not assumed (`tests/fixtures/canary/askuserquestion-task-panel.ts`,
 * `tests/unit/lib/detection/fixtures/claude-live-1708/`):
 *
 * | on screen                                     | in `tool_input` |
 * |-----------------------------------------------|-----------------|
 * | `1. Clear desk` + an indented description line | yes (the description is a separate line the scraper drops) |
 * | `4. Type something.`                           | **no** — the picker appends it |
 * | `5. Chat about this`                           | **no** — the picker appends it |
 * | `1. Submit answers` / `2. Cancel`              | **no** — a different screen entirely |
 * | `7. tasks (0 done, 1 in progress, 6 open)`     | **no** — a task-panel row misread as an option (#1708) |
 *
 * So the payload is authority over *what was asked*; the screen is authority
 * over *which keys answer it*. Everything below follows from refusing to
 * confuse the two:
 *
 *  - options are matched **by position** against what the scraper parsed, and
 *    the whole substitution is abandoned unless every one of them lines up. A
 *    screen this module cannot explain is a screen it does not touch.
 *  - option **numbers always come from the screen**, never from the payload's
 *    array index, because the number is what gets typed.
 *  - the two picker-added options are kept, by name; anything else the payload
 *    does not describe is dropped, which is what keeps the #1708 phantom out.
 *
 * Pure — type-only imports — so a client component can import it.
 *
 * @module lib/session/ask-user-question-prompt
 */

import type {
  AskUserQuestionEntry,
  AskUserQuestionSpec,
} from '@/lib/hooks/ask-user-question-payload';
import type { MultipleChoiceOption, MultipleChoicePromptData, PromptData } from '@/types/models';

/**
 * Options the Claude picker renders itself, which are therefore in no
 * `tool_input`.
 *
 * Observed verbatim as `Type something.` and `Chat about this` in the live
 * captures. Matched after normalisation (so the multi-select `[ ] ` prefix and
 * the trailing period do not matter) and by prefix, because a narrow terminal
 * truncates them.
 *
 * Keeping them is not cosmetic: they are selectable, so dropping them would
 * make `commandmate respond <id> 5` refuse a number the picker accepts.
 */
export const PICKER_META_OPTION_LABELS: readonly string[] = ['type something', 'chat about this'];

/**
 * Shortest text allowed to line two labels up by prefix.
 *
 * Prefix matching exists for one reason — the picker truncates a label that
 * does not fit the pane — so it must not become a way for short, unrelated
 * words to match. Anything shorter than this has to be equal.
 */
const MIN_PREFIX_MATCH_LENGTH = 8;

/** The multi-select checkbox the picker prefixes each option with. */
const CHECKBOX_PREFIX_PATTERN = /^\s*\[[ xX]\]\s*/;

/** Trailing ellipsis left by the picker truncating a label to the pane width. */
const TRAILING_ELLIPSIS_PATTERN = /(?:…|\.\.\.)\s*$/;

/** Semantic tokens that must never be delivered as text to a numbered picker. */
const SEMANTIC_ANSWER_TOKENS = new Set(['yes', 'y', 'no', 'n']);

/** Normalise a label or a question for comparison against the other source. */
function normalize(value: string): string {
  return value
    .replace(CHECKBOX_PREFIX_PATTERN, '')
    .replace(TRAILING_ELLIPSIS_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The `[ ] ` / `[x] ` the screen carried, so a rewritten label keeps it. */
function checkboxPrefix(screenLabel: string): string {
  return CHECKBOX_PREFIX_PATTERN.exec(screenLabel)?.[0] ?? '';
}

/**
 * Whether two normalised strings describe the same thing.
 *
 * Equality, or the shorter being a prefix of the longer — the only way the
 * picker distorts a label is by cutting it off at the pane width.
 */
function corresponds(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < MIN_PREFIX_MATCH_LENGTH) return false;
  return longer.startsWith(shorter);
}

/**
 * Whether the screen is showing this question.
 *
 * Containment rather than the prefix rule the labels use, because the two are
 * extracted differently. An option label is a parsed line; the question is
 * whatever the detector's upward scan swept together, and on a real capture that
 * is several lines glued into one — the canary frame yields
 * `"⏺ I'll load the TaskCreate tool schema first. ☐ First task Which task would
 * you like to start with?"` for a question that is only its last clause.
 *
 * The floor stops a short question ("Continue?") from matching unrelated prose;
 * the uniqueness requirement in {@link matchAskUserQuestion} does the rest. On
 * the "Review your answers" screen, which lists every question at once, a
 * multi-question call matches them all and is refused for exactly that reason.
 */
function questionCorresponds(entryQuestion: string, screenQuestion: string): boolean {
  const [shorter, longer] =
    entryQuestion.length <= screenQuestion.length
      ? [entryQuestion, screenQuestion]
      : [screenQuestion, entryQuestion];
  // The floor applies to whichever side is being looked for, not to the payload:
  // a one-character screen question is contained in every question ever written.
  if (shorter.length < MIN_PREFIX_MATCH_LENGTH) return shorter === longer;
  return longer.includes(shorter);
}

/** Whether this screen option is one the picker adds rather than the agent. */
export function isPickerMetaOption(label: string): boolean {
  const normalized = normalize(label);
  return PICKER_META_OPTION_LABELS.some(
    (meta) => normalized === meta || normalized.startsWith(meta),
  );
}

/** One question of a spec, with the index it sits at. */
export interface MatchedAskUserQuestion {
  entry: AskUserQuestionEntry;
  index: number;
}

/**
 * Which of the call's questions the screen is showing, or null.
 *
 * Null is the right answer for more of the flow than it might look. A single
 * `AskUserQuestion` tool call walks through one screen per question, then
 * "Review your answers", then "Ready to submit your answers?" with its own
 * `1. Submit answers / 2. Cancel` — and no event is emitted at any of those
 * transitions (§5.6), so the *only* way to know which screen is up is to read
 * the question off it. A screen whose question matches nothing in the payload is
 * a screen this module has nothing to say about, and the scraper's own parse
 * stands.
 *
 * Ambiguity answers null too: two questions that both match cannot be told
 * apart, and picking either would put one question's options under the other's.
 */
export function matchAskUserQuestion(
  spec: AskUserQuestionSpec,
  screenQuestion: string,
): MatchedAskUserQuestion | null {
  const screen = normalize(screenQuestion);
  if (screen === '') return null;

  const matches = spec.questions
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => questionCorresponds(normalize(entry.question), screen));

  return matches.length === 1 ? matches[0] : null;
}

/**
 * Rebuild a scraper-parsed picker's options from the agent's own payload.
 *
 * @param promptData - What the detection layer read off the pane
 * @param spec - The `AskUserQuestion` call in flight for this instance
 * @returns The corrected prompt, or **null** when the payload cannot be lined up
 *   against this screen — in which case the caller must publish `promptData`
 *   unchanged. Null is the answer for the confirmation and review screens, for
 *   any prompt that is not a multiple choice, and for any rendering this module
 *   does not recognise.
 */
export function applyAskUserQuestion(
  promptData: PromptData,
  spec: AskUserQuestionSpec,
): MultipleChoicePromptData | null {
  if (promptData.type !== 'multiple_choice') return null;

  const matched = matchAskUserQuestion(spec, promptData.question);
  if (matched === null) return null;

  const { entry, index } = matched;
  const byNumber = new Map(promptData.options.map((option) => [option.number, option]));

  // Position is the correspondence: the picker renders the payload's options in
  // array order as 1..n. Verifying every one of them before substituting is what
  // makes this safe to do at all — if the screen has moved on to something else
  // (or the scraper mis-parsed it), the check fails and nothing is replaced.
  const options: MultipleChoiceOption[] = [];
  for (const [position, choice] of entry.choices.entries()) {
    const number = position + 1;
    const screenOption = byNumber.get(number);
    if (!screenOption) return null;
    if (!corresponds(normalize(screenOption.label), normalize(choice.label))) return null;

    options.push({
      ...screenOption,
      // The checkbox prefix is load-bearing, not decoration: `prompt-answer-sender`
      // recognises a multi-select picker by `^\[[ x]\] ` on the labels and sends a
      // different key sequence for it. Dropping it while "improving" the label
      // would silently turn Space-toggle-then-Next into a bare Enter.
      label: `${checkboxPrefix(screenOption.label)}${choice.label}`,
      ...(choice.description ? { description: choice.description } : {}),
    });
  }

  // Everything past the payload's options is the picker's own doing — or it is
  // not an option at all. `7. tasks (0 done, 1 in progress, 6 open)` is the
  // second kind: a task-panel row that `NORMAL_OPTION_PATTERN` reads as an
  // option whenever the panel's task count lands exactly one past the real
  // options (#1708). The detector has its own guard for that since #1708; this
  // is the second line, and it is the one that does not depend on recognising
  // the panel's wording.
  const metaOptionNumbers: number[] = [];
  for (const option of promptData.options) {
    if (option.number <= entry.choices.length) continue;
    if (!isPickerMetaOption(option.label)) continue;
    options.push(option);
    metaOptionNumbers.push(option.number);
  }

  options.sort((a, b) => a.number - b.number);

  return {
    ...promptData,
    // The payload's text, not the pane's: the picker wraps and truncates the
    // question to the pane width, and this is the string `respond` echoes and
    // the audit trail keeps.
    question: entry.question,
    options,
    isAskUserQuestion: true,
    askUserQuestion: {
      ...(entry.header ? { header: entry.header } : {}),
      multiSelect: entry.multiSelect,
      questionIndex: index,
      questionCount: spec.questions.length,
      metaOptionNumbers,
    },
  };
}

/** Why an answer was refused before anything reached the terminal. */
export type AskUserQuestionAnswerRejection = 'answer_out_of_range' | 'unresolvable_answer';

/** The outcome of checking an answer against the agent's own options. */
export type AskUserQuestionAnswerResolution =
  | {
      ok: true;
      /** What to send. Equal to the input unless a label was resolved to a number. */
      input: string;
      /** Present only when a label was resolved. */
      resolved?: { via: 'semantic'; optionNumber: number; optionLabel: string };
    }
  | { ok: false; reason: AskUserQuestionAnswerRejection; message: string };

/**
 * Messages are fixed strings and never quote the answer (SEC-003, as in
 * `prompt-answer-semantic`), so they are safe to return to a client verbatim.
 */
const OUT_OF_RANGE_MESSAGE =
  'The option number is outside the range this prompt offers. ' +
  'Use `commandmate capture <worktree-id> --json` to list the current options.';
const NO_MATCH_MESSAGE =
  'No option label matches the answer. Answer with an option number ' +
  '(yes/no is not resolved on a numbered picker — Issue #1681).';
const AMBIGUOUS_MESSAGE =
  'The answer matches more than one option label. Answer with an option number.';

/** Every option label this answer matches, exactly or by prefix. */
function matchingOptions(options: MultipleChoiceOption[], answer: string): MultipleChoiceOption[] {
  const normalized = normalize(answer);
  if (normalized === '') return [];

  const exact = options.filter((option) => normalize(option.label) === normalized);
  if (exact.length > 0) return exact;

  // A prefix is allowed here for the human's benefit rather than the picker's:
  // `respond <id> vim` for "Vim / Neovim". Two characters is enough of a floor,
  // because a prefix matching several options is refused as ambiguous anyway.
  if (normalized.length < 2) return [];
  return options.filter((option) => normalize(option.label).startsWith(normalized));
}

/**
 * Check an answer against the options the agent actually offered (Issue #1726).
 *
 * Only ever called with a prompt {@link applyAskUserQuestion} vouched for, which
 * is what makes refusing legitimate: the option list is the agent's own, so a
 * number outside it cannot be right, and a word that matches no label cannot be
 * resolved. Without that vouching the pre-#1726 behaviour applies and this
 * function is not consulted at all.
 *
 * The refusal that matters most is `yes` / `no`. On a cursor-navigated picker
 * typed text is not a selection — the Enter that follows it takes whatever
 * option is highlighted — so `respond <id> no` has been able to deliver an
 * approval (Issue #1681). Here it is refused before anything is sent.
 *
 * @param promptData - A prompt `applyAskUserQuestion` produced
 * @param answer - The raw answer from the request
 */
export function resolveAskUserQuestionAnswer(
  promptData: MultipleChoicePromptData,
  answer: string,
): AskUserQuestionAnswerResolution {
  const trimmed = answer.trim();

  if (/^\d+$/.test(trimmed)) {
    const number = Number.parseInt(trimmed, 10);
    return promptData.options.some((option) => option.number === number)
      ? { ok: true, input: String(number) }
      : { ok: false, reason: 'answer_out_of_range', message: OUT_OF_RANGE_MESSAGE };
  }

  const matches = matchingOptions(promptData.options, trimmed);
  if (matches.length === 1) {
    const [option] = matches;
    return {
      ok: true,
      input: String(option.number),
      resolved: { via: 'semantic', optionNumber: option.number, optionLabel: option.label },
    };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'unresolvable_answer', message: AMBIGUOUS_MESSAGE };
  }

  // An option that takes free text ("Tell Claude what to do differently") makes
  // arbitrary text a legitimate answer, so it passes through as it did before.
  // `yes` / `no` never do: they are the Issue #1681 accident, not free text.
  const acceptsFreeText = promptData.options.some((option) => option.requiresTextInput === true);
  if (acceptsFreeText && !SEMANTIC_ANSWER_TOKENS.has(trimmed.toLowerCase())) {
    return { ok: true, input: answer };
  }

  return { ok: false, reason: 'unresolvable_answer', message: NO_MATCH_MESSAGE };
}
