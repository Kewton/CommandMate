/**
 * Semantic yes/no answer resolution for detected prompts (Issue #1681).
 *
 * `respond <wt> yes|no` used to send the raw text + Enter. Cursor-navigated
 * multiple-choice menus (claude / antigravity) ignore typed characters, so the
 * Enter selected the highlighted default option — `respond no` on a
 * "1. Yes / 2. Yes, allow all / 3. No" menu approved instead of denying.
 *
 * This module resolves a semantic yes/no answer (or an explicit "pick the
 * default" request) to a concrete option number BEFORE anything is sent, and
 * refuses with {@link PromptAnswerResolutionError} when no option label can be
 * matched, so the caller sends nothing at all instead of a stray Enter.
 */

import type { MultipleChoiceOption, MultipleChoicePromptData, PromptData, PromptType } from '@/types/models';

/**
 * Checkbox-style multi-select options have no yes/no semantics.
 *
 * Issue #2755 made this the SECOND of two readings rather than the only one.
 * Command Code's reader now strips the box off the label and reports the state
 * as `multiSelect` / `checked`, so on that tool there is no bracket left to
 * match and {@link isMultiSelectPrompt} is what refuses the answer. The pattern
 * stays for every payload that still carries brackets — claude's and agy's
 * checkbox menus reach the sender through the generic parser, which does not
 * strip them — because dropping it here would silently reopen #1681's hole on
 * those tools.
 */
const CHECKBOX_OPTION_PATTERN = /^\[[ xX\u2714]\] /;

/**
 * Whether this prompt is a checkbox question (Issue #2755).
 *
 * Either reading counts: the payload saying so, or a label that still wears its
 * box. See {@link CHECKBOX_OPTION_PATTERN} for why both are needed.
 */
function isMultiSelectPrompt(promptData: MultipleChoicePromptData): boolean {
  return (
    promptData.multiSelect === true ||
    promptData.options.some(o => CHECKBOX_OPTION_PATTERN.test(o.label))
  );
}

/** Labels that mean "approve" (e.g. "Yes", "Yes, allow all edits ..."). */
const AFFIRMATIVE_LABEL_PATTERN = /^yes\b/i;

/** Labels that mean "reject" (e.g. "No", "No, and tell Claude ...", "Deny"). */
const NEGATIVE_LABEL_PATTERNS = [/^no\b/i, /\bdeny\b/i];

export type SemanticAnswer = 'yes' | 'no';

/**
 * Raised when an answer cannot be resolved to a concrete option. Messages are
 * fixed strings (no user input) per SEC-003 and are safe to return to clients.
 */
export class PromptAnswerResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptAnswerResolutionError';
  }
}

/**
 * Parse an answer as a semantic yes/no token. Only exact tokens qualify —
 * free text like "yes please" is NOT semantic and passes through unchanged.
 */
export function parseSemanticAnswer(answer: string): SemanticAnswer | null {
  const normalized = answer.trim().toLowerCase();
  if (normalized === 'yes' || normalized === 'y') return 'yes';
  if (normalized === 'no' || normalized === 'n') return 'no';
  return null;
}

/** How the concrete input was derived from the request. */
export interface ResolvedAnswerInfo {
  via: 'semantic' | 'default';
  /** Selected option number (absent for yes_no default resolution). */
  optionNumber?: number;
  /** Selected option label ('yes'/'no' for yes_no default resolution). */
  optionLabel: string;
}

export interface AnswerResolution {
  /** The input to actually send to the terminal. */
  input: string;
  /** Present only when semantic or default resolution occurred. */
  resolved?: ResolvedAnswerInfo;
}

function isNegativeLabel(label: string): boolean {
  return NEGATIVE_LABEL_PATTERNS.some(p => p.test(label));
}

function isAffirmativeLabel(label: string): boolean {
  // A label matching a negative pattern never counts as affirmative
  // (guards against future pattern overlap).
  return AFFIRMATIVE_LABEL_PATTERN.test(label) && !isNegativeLabel(label);
}

function resolveSemanticOption(
  promptData: MultipleChoicePromptData,
  semantic: SemanticAnswer,
): MultipleChoiceOption {
  const options = promptData.options;
  if (isMultiSelectPrompt(promptData)) {
    throw new PromptAnswerResolutionError(
      'Multi-select (checkbox) prompts cannot be answered with yes/no. Answer with the option numbers you want ticked, comma-separated (for example "1,3").'
    );
  }

  const matcher = semantic === 'yes' ? isAffirmativeLabel : isNegativeLabel;
  const matches = options.filter(o => matcher(o.label));
  if (matches.length === 0) {
    throw new PromptAnswerResolutionError(
      `No option label matches "${semantic}". Answer with an option number.`
    );
  }

  // Multiple matches (e.g. "1. Yes" / "2. Yes, allow all edits ..."): pick the
  // lowest-numbered one — in Claude-style permission menus that is the plain,
  // narrowest-scope choice.
  return matches.reduce((a, b) => (a.number <= b.number ? a : b));
}

function resolveDefaultOption(options: MultipleChoiceOption[]): MultipleChoiceOption {
  // Mirrors prompt-answer-sender: when no option carries the ❯ indicator the
  // cursor rests on option 1.
  const def = options.find(o => o.isDefault)
    ?? options.find(o => o.number === 1)
    ?? options[0];
  if (!def) {
    throw new PromptAnswerResolutionError('The prompt has no options to select a default from.');
  }
  return def;
}

export interface ResolvePromptAnswerParams {
  /** Raw answer from the request (absent when useDefault is set). */
  answer?: string;
  /** Explicit "select the default option" request (`respond --default`). */
  useDefault?: boolean;
  /** Fresh server-side prompt detection result (authoritative when present). */
  promptData?: PromptData;
  /** Client-claimed prompt type, used only when fresh detection is unavailable. */
  fallbackPromptType?: PromptType;
}

/**
 * Resolve the request to the concrete terminal input.
 *
 * - `useDefault`: resolves to the default option (multiple_choice) or the
 *   default answer (yes_no). Requires detected promptData.
 * - semantic yes/no on a detected multiple_choice prompt: resolves the option
 *   number by label; unresolvable labels raise instead of degrading to Enter.
 * - semantic yes/no when detection failed but the client claims
 *   multiple_choice: raises (option labels are unknown).
 * - everything else (numbers, free text, yes/no on yes_no prompts) passes
 *   through unchanged.
 *
 * @throws PromptAnswerResolutionError when the answer must not be sent.
 */
export function resolvePromptAnswer(params: ResolvePromptAnswerParams): AnswerResolution {
  const { answer, useDefault, promptData, fallbackPromptType } = params;

  if (useDefault) {
    if (promptData?.type === 'multiple_choice') {
      // Issue #2755: on a checkbox question the `❯` is a CURSOR, not a
      // pre-selected answer — it says which row a key would toggle. Turning it
      // into "the answer" ticked one box and stopped, and on a screen where the
      // human had already ticked that box it UNticked it (`respond --default`
      // on #2754's `multiselect-cursor-on-option-2`). Refused before anything
      // is sent, like every other unresolvable answer here.
      if (isMultiSelectPrompt(promptData)) {
        throw new PromptAnswerResolutionError(
          'Multi-select (checkbox) prompts have no default answer: the cursor marks the row a key would toggle, not a choice. Answer with the option numbers you want ticked, comma-separated (for example "1,3").'
        );
      }
      const opt = resolveDefaultOption(promptData.options);
      return {
        input: String(opt.number),
        resolved: { via: 'default', optionNumber: opt.number, optionLabel: opt.label },
      };
    }
    if (promptData?.type === 'yes_no') {
      if (promptData.defaultOption) {
        return {
          input: promptData.defaultOption,
          resolved: { via: 'default', optionLabel: promptData.defaultOption },
        };
      }
      throw new PromptAnswerResolutionError('The yes/no prompt declares no default option.');
    }
    throw new PromptAnswerResolutionError(
      'Cannot select the default option: no active prompt was detected.'
    );
  }

  const rawAnswer = answer ?? '';
  const semantic = parseSemanticAnswer(rawAnswer);
  if (semantic === null) {
    return { input: rawAnswer };
  }

  if (promptData?.type === 'multiple_choice') {
    const opt = resolveSemanticOption(promptData, semantic);
    return {
      input: String(opt.number),
      resolved: { via: 'semantic', optionNumber: opt.number, optionLabel: opt.label },
    };
  }

  // Fresh detection did not yield a multiple-choice prompt. If the client
  // claims one, the option labels are unknown — refuse rather than let the
  // text degrade into a bare Enter that picks the default.
  if (!promptData && fallbackPromptType === 'multiple_choice') {
    throw new PromptAnswerResolutionError(
      'Cannot resolve yes/no: the prompt is multiple choice but its options could not be read.'
    );
  }

  return { input: rawAnswer };
}
