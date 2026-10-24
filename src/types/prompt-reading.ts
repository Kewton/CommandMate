/**
 * What a prompt screen was READ as, kept beside the prompt (Issue #3881).
 *
 * The detectors hand on `PromptData` — a question, options, and the deny
 * surface — and drop what they knew about the screen while reading it: which
 * kind of dialog it was, which rows were live, whether the approval target is
 * the whole of what the panel asks about. Each later path then decided those
 * again from the cut-down strings, and they disagreed: the chat transcript drew
 * Claude's 16-column `Ready to submit your answers?` page — which the Auto-Yes
 * poller leaves to a human as `question-confirm-page` — as a tool approval,
 * because the stored options read `Submit` / `Cancel` and the review list was
 * cut off the stored question.
 *
 * So the reading is decided once, where the frame is still in hand (the
 * response poller's save, `polling/prompt-screen-reading`), and stored with
 * the row. Readers take it as stated and never derive it again from the text;
 * a row without one (written before #3881, or by a producer that has no frame)
 * goes through each reader's own compatibility rules, explicitly.
 *
 * Types only: imported by `types/models` and by client code.
 *
 * @module types/prompt-reading
 */

/**
 * The version of {@link PromptReading} a row carries. A reader that meets
 * another version treats the row as having no reading (its compatibility
 * rules), rather than guess at fields it does not know.
 */
export const PROMPT_READING_VERSION = 1 as const;

/**
 * What kind of screen the prompt is.
 *
 * - `question` — the agent asks the operator to choose (an `AskUserQuestion`
 *   picker, Command Code's question screen);
 * - `permission` — "may I run this?" (a permission dialog read by its rows'
 *   effects, a `(y/n)` confirmation);
 * - `confirmation` — the page that submits a question set's answers (Claude's
 *   `Ready to submit your answers?`, Command Code's `Submit` / `Cancel`);
 * - `menu` — a selector that is neither (reserved; no reader states it yet);
 * - `unknown` — the screen carried no evidence either way. NOT "not a
 *   question": nothing showed that it is one, and nothing showed that it is
 *   not.
 */
export type PromptReadingKind = 'question' | 'permission' | 'confirmation' | 'menu' | 'unknown';

/** Which screen of a question set the prompt is, for `question` / `confirmation`. */
export type PromptReadingPhase = 'question' | 'confirmation';

/**
 * Whether the approval target is the whole of what the panel asks about.
 *
 * - `complete` — the upward scan stopped at the previous turn's boundary (or a
 *   reader bounded the panel itself);
 * - `truncated` — the scan hit `APPROVAL_TARGET_MAX_LOOKBACK` with rows still
 *   above it: what the panel asks about may start above the target, so a deny
 *   pattern that does not match it has not been shown the whole request;
 * - `top-unknown` — the scan reached the first row of the frame without a
 *   boundary. The frame may have been cut there (a pane shorter than the
 *   panel); on the poller's deep captures it is the top of the pane's history.
 */
export type ApprovalTargetCompleteness = 'complete' | 'truncated' | 'top-unknown';

/** What the kind was read from. Empty for `unknown`. */
export type PromptReadingEvidence =
  /** The tool's own confirm-page reader matched the frame (the predicate the poller declines it by). */
  | 'confirm-page-reader'
  /** A question reader's picker chrome (`isAskUserQuestion`). */
  | 'question-picker-chrome'
  /** The agent's structured `AskUserQuestion` call was matched to the options (#1726). */
  | 'ask-user-question-payload'
  /** The rows read as a permission dialog's effects (`auto-yes-option-effect`). */
  | 'permission-option-effect'
  /** A yes/no confirmation pattern (`(y/n)`, `[y/N]`, `Approve?` …). */
  | 'yes-no-pattern';

/** The rows of the frame the reading treats as the live prompt (end exclusive). */
export interface PromptLiveRange {
  startRow: number;
  endRow: number;
}

/** What the screen was read as, stored with the row (Issue #3881). */
export interface PromptReading {
  version: typeof PROMPT_READING_VERSION;
  kind: PromptReadingKind;
  /** Set for `question` and `confirmation` only. */
  phase?: PromptReadingPhase;
  /** Absent when the reader did not measure it. */
  liveRange?: PromptLiveRange;
  /** `not-measured` when the reader built the target without the upward scan. */
  approvalTarget: ApprovalTargetCompleteness | 'not-measured';
  evidence: PromptReadingEvidence[];
}
