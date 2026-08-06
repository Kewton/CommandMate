/**
 * Reading Claude Code's `AskUserQuestion` tool input (Issue #1726).
 *
 * The shape here is taken from the payloads the Issue #1721 spike captured from
 * a live v2.1.223 session — `tests/fixtures/hooks/claude/`
 * `pre-tool-use-ask-user-question.json` and
 * `permission-request-ask-user-question.json` — not from documentation. Where
 * the two disagree the fixtures win, and the fixtures are asserted against in
 * `tests/unit/hooks/ask-user-question-payload.test.ts` so a Claude-side shape
 * change fails a test instead of silently emptying the options.
 *
 * ```json
 * { "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion",
 *   "tool_input": { "questions": [
 *     { "question": "…", "header": "Color", "multiSelect": false,
 *       "options": [ { "label": "Blue", "description": "…" } ] } ] } }
 * ```
 *
 * Two facts about the payload decide everything downstream:
 *
 *  - **`tool_use_id` is not a correlation key.** It is present on `PreToolUse`
 *    and absent from `PermissionRequest` (D2), so nothing here reads it.
 *    Correlation is (worktree, tool, instance) from the injected hook URL, which
 *    is what every other structured state in this codebase is keyed by.
 *  - **The payload describes the *questions*, not the *screen*.** The picker
 *    renders these options and then appends its own ("Type something." / "Chat
 *    about this"), and the final step replaces them entirely with "1. Submit
 *    answers / 2. Cancel". Turning a payload into a set of answerable options is
 *    therefore `lib/session/ask-user-question-prompt`'s job, not this module's.
 *
 * Parsing is strict, and every rejection degrades to the behaviour of a machine
 * without this feature: `null` means "no structured options", which leaves the
 * scraper's parsed prompt exactly as it was.
 *
 * @module lib/hooks/ask-user-question-payload
 */

import { ASK_USER_QUESTION_TOOL } from './permission-request-payload';

/** Cap on questions in one tool call. The observed payloads carry 1–3. */
export const MAX_ASK_USER_QUESTIONS = 20;

/**
 * Cap on options in one question.
 *
 * 20 is the same ceiling `prompt-detect-multiple-choice` puts on an option
 * number, so a payload this module accepts can always be lined up against a
 * screen the detector accepted.
 */
export const MAX_ASK_USER_QUESTION_OPTIONS = 20;

/** Bound on the question text; it is displayed and stored, never matched on. */
export const MAX_ASK_USER_QUESTION_TEXT_LENGTH = 1000;

/** Bound on an option label. Labels are compared against screen text. */
export const MAX_ASK_USER_QUESTION_LABEL_LENGTH = 200;

/** Bound on an option description — prose, shown under the label. */
export const MAX_ASK_USER_QUESTION_DESCRIPTION_LENGTH = 500;

/** Bound on the tab header Claude renders for each question. */
export const MAX_ASK_USER_QUESTION_HEADER_LENGTH = 64;

/** One selectable answer the agent offered. */
export interface AskUserQuestionChoice {
  /** The option text, verbatim from `tool_input`. */
  label: string;
  /** The second line the picker renders under the label, or null. */
  description: string | null;
}

/** One question of a (possibly multi-question) `AskUserQuestion` call. */
export interface AskUserQuestionEntry {
  question: string;
  /** Short tab label, or null when the payload omitted it. */
  header: string | null;
  /** Whether the picker accepts several answers for this question. */
  multiSelect: boolean;
  choices: AskUserQuestionChoice[];
}

/** Everything one `AskUserQuestion` tool call asked. */
export interface AskUserQuestionSpec {
  questions: AskUserQuestionEntry[];
  /**
   * `prompt_id` — the only field `PreToolUse` and `PermissionRequest` share that
   * identifies the turn (D2). Recorded so two deliveries of the same call can be
   * recognised in a log; never used as an identity key.
   */
  promptId: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, max);
}

function parseChoice(value: unknown): AskUserQuestionChoice | null {
  if (!isPlainObject(value)) return null;
  const label = readBoundedString(value.label, MAX_ASK_USER_QUESTION_LABEL_LENGTH);
  if (label === null) return null;
  return {
    label,
    description: readBoundedString(value.description, MAX_ASK_USER_QUESTION_DESCRIPTION_LENGTH),
  };
}

function parseEntry(value: unknown): AskUserQuestionEntry | null {
  if (!isPlainObject(value)) return null;

  const question = readBoundedString(value.question, MAX_ASK_USER_QUESTION_TEXT_LENGTH);
  if (question === null) return null;

  if (!Array.isArray(value.options) || value.options.length === 0) return null;
  if (value.options.length > MAX_ASK_USER_QUESTION_OPTIONS) return null;

  const choices: AskUserQuestionChoice[] = [];
  for (const option of value.options) {
    const choice = parseChoice(option);
    // A question with an unreadable option is a question this server cannot
    // line up against the screen by position, and position is the whole of the
    // correspondence rule. Refuse the payload rather than shift the numbering.
    if (choice === null) return null;
    choices.push(choice);
  }

  return {
    question,
    header: readBoundedString(value.header, MAX_ASK_USER_QUESTION_HEADER_LENGTH),
    multiSelect: value.multiSelect === true,
    choices,
  };
}

/**
 * Parse the `questions` array out of an `AskUserQuestion` `tool_input`.
 *
 * @returns The questions, or null when the input is not one this server can
 *   vouch for — which every caller must treat as "no structured options".
 */
export function parseAskUserQuestionToolInput(toolInput: unknown): AskUserQuestionEntry[] | null {
  if (!isPlainObject(toolInput)) return null;
  if (!Array.isArray(toolInput.questions) || toolInput.questions.length === 0) return null;
  if (toolInput.questions.length > MAX_ASK_USER_QUESTIONS) return null;

  const questions: AskUserQuestionEntry[] = [];
  for (const raw of toolInput.questions) {
    const entry = parseEntry(raw);
    if (entry === null) return null;
    questions.push(entry);
  }
  return questions;
}

/**
 * Parse a hook body that may be an `AskUserQuestion` tool call.
 *
 * Accepts any `hook_event_name` — `PreToolUse` is what Issue #1726 injects, and
 * `PermissionRequest` carries a byte-identical `tool_input` (§5.6), so both are
 * usable evidence of the same call. What is checked is `tool_name`: a payload
 * for any other tool answers null.
 *
 * @param body - Whatever was posted to a hook receiver
 * @returns The spec, or null when this is not an `AskUserQuestion` call this
 *   server can read.
 */
export function parseAskUserQuestionPayload(body: unknown): AskUserQuestionSpec | null {
  if (!isPlainObject(body)) return null;
  if (body.tool_name !== ASK_USER_QUESTION_TOOL) return null;

  const questions = parseAskUserQuestionToolInput(body.tool_input);
  if (questions === null) return null;

  return {
    questions,
    promptId: readBoundedString(body.prompt_id, 256),
  };
}
