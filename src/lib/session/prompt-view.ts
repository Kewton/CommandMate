/**
 * How a waiting prompt is shown and answered, decided once (Issue #3184).
 *
 * Before this module every reader of a prompt payload re-derived the same three
 * facts for itself — "can it be answered?", "where are the choices?", "is the
 * answer a keystroke or an API call?" — from `type`, `options`,
 * `decisionOptions`, `decisionId` and `askUserQuestion`. The panel, the phone
 * sheet, the chat surface, Auto-Yes and `wait` each combined them a little
 * differently, and a fix to one surface kept missing the others (#2775 →
 * #2810 → #2822, #3181). {@link derivePromptView} is the one combination; a
 * reader takes its {@link PromptView} and does not look at the raw fields to
 * decide what to show.
 *
 * ## No imports, on purpose
 *
 * The CLI (`tsconfig.cli.json`) compiles with `"paths": {}`, so it can reach a
 * module under `src/lib` by a relative path only when nothing in that module's
 * graph uses the `@/` alias. `types/models` and `session/structured-prompt` both
 * do. The input is therefore a structural type ({@link PromptViewSource}) that
 * every existing prompt shape — `LivePromptData`, `StoredPromptData`, the CLI's
 * own `PromptData` mirror — satisfies without a cast, and this file stays
 * importable from a client component, the server and the CLI alike.
 *
 * ## What it does not replace
 *
 * `isAnswerablePromptData()` (`types/models`) stays: it narrows to the closed
 * `PromptData` union (#1725) for the code that builds an answer body. The two
 * agree by construction — `derivePromptView(x)?.kind === 'screen-choices'`
 * exactly when `isAnswerablePromptData(x)` — and
 * `tests/unit/session/prompt-view-3184.test.ts` holds that over every fixture.
 *
 * @module lib/session/prompt-view
 */

/**
 * `promptData.type` for a frame nothing could classify. Same value as
 * `UNCLASSIFIED_PROMPT_TYPE` in `types/models`, restated because this module may
 * not import it (see the module note); the test asserts the two are equal.
 */
export const UNCLASSIFIED_PROMPT_VIEW_TYPE = 'unclassified';

/**
 * The fields {@link derivePromptView} reads. Every prompt shape in the codebase
 * is assignable to it as it stands.
 */
export interface PromptViewSource {
  type: string;
  question?: string;
  status?: string;
  options?: readonly unknown[];
  defaultOption?: unknown;
  multiSelect?: boolean;
  decisionId?: unknown;
  decisionOptions?: unknown;
  askUserQuestion?: unknown;
  toolName?: unknown;
}

/**
 * How the prompt is answered. "Free text" is not a fourth value: it is the
 * orthogonal {@link PromptView.freeText}, because every prompt that takes typed
 * text today also offers choices (design §2.4).
 *
 * - `screen-choices`: keys on the pane — the option number, or y/n
 *   (`/prompt-response`).
 * - `api-choices`: the agent's own API, addressed by `decisionId` (`/respond`).
 * - `unreadable`: nothing to offer; the human answers in the terminal.
 */
export type PromptViewKind = 'screen-choices' | 'api-choices' | 'unreadable';

/** What the heading above the prompt says. */
export type PromptViewHeading =
  /** The question read off the screen. */
  | { kind: 'question'; text: string }
  /** An approval answered over the API (#3181's heading). */
  | { kind: 'approval'; toolName: string | null }
  /** A question answered over the API (#2039). */
  | { kind: 'agent-question'; text: string }
  /** "A dialog is open but its options could not be read." */
  | { kind: 'unreadable' };

/** One choice a surface may offer. */
export interface PromptViewChoice {
  /**
   * The value an answer sends: the option number (`'1'`) or `'yes'`/`'no'` on
   * the screen; the number `respond` resolves for an API decision.
   */
  answer: string;
  label: string;
  isDefault: boolean;
  /** Choosing it opens a text field (#2573's rule, {@link optionTakesTypedText}). */
  takesText: boolean;
  description?: string;
}

/** The one shape every surface reads (Issue #3184). */
export interface PromptView {
  kind: PromptViewKind;
  heading: PromptViewHeading;
  /** Always empty for `unreadable`. */
  choices: readonly PromptViewChoice[];
  /** A checkbox question (#2755). Only ever true for `screen-choices`. */
  multiSelect: boolean;
  /** Whether typed text is accepted, and by which channel; null when it is not. */
  freeText: { via: 'screen' | 'api' } | null;
  /** Non-null exactly when `kind === 'api-choices'` (#2031's biconditional). */
  decisionId: string | null;
  /** For `api-choices`, which kind of decision the id names; null otherwise. */
  apiTarget: 'approval' | 'question' | null;
}

/**
 * What a surface prints as the heading, as a `prompt.*` message key (Issue
 * #3181, #3184). `text` is set instead of `key` for a question read off the
 * screen, which is printed verbatim. Both answer surfaces translate THIS rather
 * than mapping the heading kinds themselves, so the two cannot disagree about
 * when "could not read its options" is the truth.
 */
export type PromptHeadingMessage =
  | { text: string }
  | { key: 'structuredApprovalTitle'; values: { toolName: string } }
  | { key: 'structuredApprovalTitleNoTool' | 'structuredQuestionTitle' | 'unclassifiedTitle' };

export function promptHeadingMessage(heading: PromptViewHeading): PromptHeadingMessage {
  switch (heading.kind) {
    case 'question':
      return { text: heading.text };
    case 'approval':
      return heading.toolName
        ? { key: 'structuredApprovalTitle', values: { toolName: heading.toolName } }
        : { key: 'structuredApprovalTitleNoTool' };
    case 'agent-question':
      return { key: 'structuredQuestionTitle' };
    case 'unreadable':
      return { key: 'unclassifiedTitle' };
  }
}

// =============================================================================
// Field readers (moved from components/worktree/prompt-decision-id, #1932/#2039/#3181)
// =============================================================================

/**
 * Labels of the rows measured to BE a text field on screen (Issue #2573).
 *
 * `requiresTextInput` (from {@link TEXT_INPUT_PATTERNS}) reads the WORDS of a
 * label — "tell … what to do differently", "custom", "enter …" — and says the
 * option is about the user's own text. It does not say where typed characters
 * land, and for two rows it flags alike the measured answer is opposite:
 *
 * | row | on screen | free text + Enter |
 * |-----|-----------|-------------------|
 * | Command Code `AskUserQuestion` `Type something...` (#2522) | a `TextInput` | lands in the field — the answer |
 * | Command Code permission `No, tell Command Code what to do differently` | a menu row | ignored; the Enter confirms the highlighted `1. Yes` |
 *
 * The second is how a "No + reason" was delivered as an approval. The same
 * words sit on codex's and copilot's approval rows (codex's also name letter
 * hotkeys, `(y)` / `(p)`), and the generic patterns match inside the command an
 * approval row quotes (`… commands that start with 'npm run custom'`).
 *
 * So this is an allowlist of what was measured, not a denylist of what went
 * wrong: a flagged row is a field only when its label is one of these. Anchored
 * at the start so Command Code's folded description (`Type something... Give me
 * a branch name …`) still matches. Command Code's reader
 * (`tools/command-code/dialog.ts`) marks the same rows with the same expression.
 *
 * The one definition since Issue #3218: `isTypedTextFieldOption` in
 * `lib/detection/prompt-detect-multiple-choice`, whose graph reaches `fs`,
 * reads it through `optionTakesTypedText` below.
 */
export const TYPED_TEXT_FIELD_LABEL_PATTERNS: readonly RegExp[] = [
  /^[^\S\n]*type\s+something\b/i,
];

/**
 * Whether an option is a text field on screen, so its answer is the typed TEXT
 * rather than its number (Issue #2573). `requiresTextInput` alone is also true
 * for a menu row such as `No, tell Command Code what to do differently`.
 */
export function optionTakesTypedText(
  option: { readonly label: string; readonly requiresTextInput?: boolean },
): boolean {
  return option.requiresTextInput === true
    && TYPED_TEXT_FIELD_LABEL_PATTERNS.some((pattern) => pattern.test(option.label));
}

/**
 * The decision id a payload names, or null (Issue #1932). A validating read:
 * absent, empty or not a string is "no addressable decision".
 */
export function readDecisionId(source: PromptViewSource | null | undefined): string | null {
  if (!source) return null;
  const candidate = source.decisionId;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}

function hasDecisionOptions(source: PromptViewSource): boolean {
  return Array.isArray(source.decisionOptions) && source.decisionOptions.length > 0;
}

/** The choices of a question answered over the API (Issue #2039 / #2951). */
export interface QuestionChoices {
  question: string;
  /** In payload order; the answer is the 1-based POSITION in this list. */
  labels: string[];
  questionCount: number;
  /** A typed answer is accepted besides the choices (#2951). */
  custom?: true;
}

/**
 * The choices a question offers when it may be answered over the API, or null
 * (Issue #2039). All three must hold: a decision id, exactly one question with
 * a complete label list, and NO approval verdicts on the same payload.
 */
export function readQuestionChoices(
  source: PromptViewSource | null | undefined,
): QuestionChoices | null {
  if (!source || readDecisionId(source) === null) return null;
  if (hasDecisionOptions(source)) return null;

  const asked = source.askUserQuestion as {
    question?: unknown;
    labels?: unknown;
    questionCount?: unknown;
    custom?: unknown;
  } | null | undefined;
  if (!asked || typeof asked.question !== 'string' || asked.question === '') return null;
  if (!Array.isArray(asked.labels) || asked.labels.length === 0) return null;
  const labels = asked.labels.filter(
    (label): label is string => typeof label === 'string' && label !== ''
  );
  // Partial is worse than none: the numbers are positions in this list.
  if (labels.length !== asked.labels.length) return null;

  const questionCount = typeof asked.questionCount === 'number' ? asked.questionCount : 1;
  if (questionCount !== 1) return null;

  return {
    question: asked.question,
    labels,
    questionCount,
    ...(asked.custom === true ? { custom: true as const } : {}),
  };
}

/** What a heading should say when the payload carries addressable choices (#3181). */
export type DecisionHeading =
  | { kind: 'approval'; toolName: string | null }
  | { kind: 'question' };

/** The heading for addressable choices, or null when there is nothing to click (#3181). */
export function readDecisionHeading(
  source: PromptViewSource | null | undefined,
): DecisionHeading | null {
  if (!source || readDecisionId(source) === null) return null;
  if (hasDecisionOptions(source)) {
    return {
      kind: 'approval',
      toolName: typeof source.toolName === 'string' && source.toolName ? source.toolName : null,
    };
  }
  return readQuestionChoices(source) ? { kind: 'question' } : null;
}

// =============================================================================
// The view
// =============================================================================

function screenChoices(source: PromptViewSource): PromptViewChoice[] {
  const options = Array.isArray(source.options) ? source.options : [];
  const choices: PromptViewChoice[] = [];
  for (const option of options) {
    if (typeof option === 'string') {
      // yes_no: `['yes', 'no']`, answered by the word itself.
      choices.push({
        answer: option,
        label: option,
        isDefault: source.defaultOption === option,
        takesText: false,
      });
      continue;
    }
    if (!option || typeof option !== 'object') continue;
    const o = option as { number?: unknown; label?: unknown; isDefault?: unknown; requiresTextInput?: unknown; description?: unknown };
    if (typeof o.number !== 'number' || typeof o.label !== 'string') continue;
    choices.push({
      answer: String(o.number),
      label: o.label,
      isDefault: o.isDefault === true,
      takesText: optionTakesTypedText({ label: o.label, requiresTextInput: o.requiresTextInput === true }),
      ...(typeof o.description === 'string' ? { description: o.description } : {}),
    });
  }
  return choices;
}

function decisionChoices(decisionOptions: unknown): PromptViewChoice[] {
  if (!Array.isArray(decisionOptions)) return [];
  const choices: PromptViewChoice[] = [];
  for (const option of decisionOptions) {
    const o = option as { number?: unknown; label?: unknown } | null;
    if (!o || typeof o.number !== 'number' || typeof o.label !== 'string') continue;
    choices.push({ answer: String(o.number), label: o.label, isDefault: false, takesText: false });
  }
  return choices;
}

const UNREADABLE_VIEW: PromptView = {
  kind: 'unreadable',
  heading: { kind: 'unreadable' },
  choices: [],
  multiSelect: false,
  freeText: null,
  decisionId: null,
  apiTarget: null,
};

/**
 * Decide how a prompt payload is shown and answered (Issue #3184).
 *
 * Evaluated in this order (design §2.3):
 *  1. any `type` but the unclassified sentinel → `screen-choices`;
 *  2. unclassified + decision id + approval verdicts → `api-choices` (approval);
 *  3. unclassified + decision id + one complete question → `api-choices` (question);
 *  4. every other unclassified payload — no id, #1932's options-without-id half
 *     state, and both stored history records — → `unreadable`.
 *
 * @param source - A live or stored prompt payload, or null
 * @returns The view, or null when there is no prompt
 */
export function derivePromptView(source: PromptViewSource | null | undefined): PromptView | null {
  if (source == null) return null;

  if (source.type !== UNCLASSIFIED_PROMPT_VIEW_TYPE) {
    const choices = screenChoices(source);
    return {
      kind: 'screen-choices',
      heading: { kind: 'question', text: typeof source.question === 'string' ? source.question : '' },
      choices,
      multiSelect: source.multiSelect === true,
      freeText: choices.some((choice) => choice.takesText) ? { via: 'screen' } : null,
      decisionId: null,
      apiTarget: null,
    };
  }

  const decisionId = readDecisionId(source);
  if (decisionId !== null && hasDecisionOptions(source)) {
    const choices = decisionChoices(source.decisionOptions);
    if (choices.length > 0) {
      return {
        kind: 'api-choices',
        heading: {
          kind: 'approval',
          toolName: typeof source.toolName === 'string' && source.toolName ? source.toolName : null,
        },
        choices,
        multiSelect: false,
        freeText: null,
        decisionId,
        apiTarget: 'approval',
      };
    }
  }

  const question = readQuestionChoices(source);
  if (decisionId !== null && question !== null) {
    return {
      kind: 'api-choices',
      heading: { kind: 'agent-question', text: question.question },
      choices: question.labels.map((label, index) => ({
        answer: String(index + 1),
        label,
        isDefault: false,
        takesText: false,
      })),
      multiSelect: false,
      freeText: question.custom === true ? { via: 'api' } : null,
      decisionId,
      apiTarget: 'question',
    };
  }

  return UNREADABLE_VIEW;
}

/**
 * The view a `current-output` payload carries, falling back to deriving it.
 *
 * `??`, not `||`: a server from before #3184 sends no `promptView`, and its
 * absence means "this daemon does not publish the field" — the same function
 * then decides from `promptData`, so old and new servers reach the same answer.
 */
export function readPromptView(
  payload: { promptView?: PromptView | null; promptData?: PromptViewSource | null } | null | undefined,
): PromptView | null {
  if (!payload) return null;
  return payload.promptView ?? derivePromptView(payload.promptData);
}
