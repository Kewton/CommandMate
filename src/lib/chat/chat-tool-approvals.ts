/**
 * Tool-approval rows in the chat transcript (Issue #2245, extended by #2460).
 *
 * ## What this is for
 *
 * `chat_messages` stores one row per approval dialog, and three different
 * producers write them. Measured on develop `966b40f8` over the last 50 rows of
 * two live worktrees, 41 of 50 (antigravity) and 43 of 50 (codex) were rows of
 * this kind — and `ChatMessageBubble` drew every one of them as an ordinary
 * assistant reply, in full:
 *
 *  - the poller saves the dialog with `promptDetection.rawContent` as its
 *    `content`, which is the last 200 lines / 5,000 characters of the PANE, not
 *    the dialog. So each row is a 1.6–2.8 KB transcript of everything that
 *    happened to be on screen, starting at whatever byte the cap landed on;
 *  - Auto-Yes writes a SECOND row for the same dialog, because the status sweep
 *    stamps the first one `answeredBy: 'terminal'` before `recordAnsweredPrompt`
 *    goes looking for a pending row to update;
 *  - the permission hook writes an audit row per allow decision, whose `content`
 *    is `<toolName>: <toolInput JSON>` and whose `summary` starts with
 *    {@link PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX}.
 *
 * None of that is a reply, and none of it is worth 2 KB of the reader's column.
 * This module turns such a row into a one-line CHIP — a label and an outcome —
 * and folds the duplicates. It is display-only: the producers are untouched by
 * Issue #2245 (they are separate Issues), so everything here has to work on the
 * rows already in the database, with no migration.
 *
 * ## Not every `prompt` row is an approval (Issue #2460)
 *
 * `AskUserQuestion` writes rows through the same producer, and they are not
 * approvals: nobody is approving anything, the agent is ASKING. Measured on
 * `/worktrees/mycodebranchdesk` 2026-09-10 21:48, a two-question call left three
 * rows — 21:48:04 and 21:48:06 (`isAskUserQuestion: true`, `answeredBy: 'auto'`)
 * and 21:48:11, the set's `Ready to submit your answers?` screen — and the chip
 * group said "Tool approvals · 3" for two questions, with the picker's tab row
 * (`←  ☐ 実行範囲  ☐ 起動場所  ✔ Submit  →`) still glued to the front of each
 * label and the confirmation's `human` outcome standing where the questions'
 * `auto` belonged.
 *
 * So a chip now carries a {@link ToolApprovalEntry.kind}, questions normalize
 * their own label ({@link stripAskUserQuestionTabs}), and the submit
 * confirmation is folded into the question it confirms WITHOUT taking that
 * question's outcome with it — answering a question and submitting the answer
 * set are two operations by two different deciders, and merging them is what
 * made an Auto-Yes answer read as the reader's own choice.
 *
 * ## Why the reading is defensive rather than typed
 *
 * `promptData` is {@link StoredPromptData}: the answerable union PLUS #1708's
 * `UnclassifiedFrameRecord` and #1725's `StructuredPromptHistoryRecord`, and in
 * practice also `undefined` and whatever an older schema left behind.
 * {@link isAnswerablePromptData} narrows only the first case, so a reader that
 * leans on it still has to answer "what do I show for the other three?". A chat
 * transcript is the wrong place to find out: one malformed row would take the
 * whole conversation down with it. So every field is read through a `typeof`
 * check and a missing one degrades to a weaker label, never to a throw.
 */

import type { ChatMessage } from '@/types/models';
import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';
import { ASK_USER_QUESTION_TAB_BAR_PREFIX_PATTERN } from '@/lib/detection/tools/claude/picker-chrome';

// ============================================================================
// Constants
// ============================================================================

/**
 * The `summary` prefix the permission hook writes on an allow decision.
 *
 * Shared with `lib/hooks/permission-decision-service`'s producer by VALUE, not
 * by import: Issue #2245 is a display-layer fix and may not change what the
 * producer writes, and importing a server module that reaches the database into
 * a `'use client'` component is not available anyway. The cost is that a
 * producer-side rename would silently stop identifying these rows, which is why
 * the fixture-backed unit for this constant asserts the literal string that
 * `recordAllowedPermission` composes.
 */
export const PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX = 'PermissionRequest allow';

/**
 * How far apart two rows describing the SAME dialog may be and still be folded.
 *
 * The Auto-Yes duplicate lands 1–2 seconds after the sweep's row (measured:
 * 13:57:00.931Z terminal → 13:57:01.917Z auto on the antigravity worktree, and
 * 13:57:59.157Z → 13:58:00.158Z on the pair before it). Five seconds leaves room
 * for a slow poll tick without reaching the next dialog, which on the same
 * capture was 20–50 seconds away.
 *
 * [#2460] The same window carries the submit confirmation, and the measured case
 * sits exactly on its edge: question 21:48:06.000 → confirmation 21:48:11.000 is
 * 5,000 ms, so the bound is INCLUSIVE and the fixture pins the millisecond.
 */
export const TOOL_APPROVAL_MERGE_WINDOW_MS = 5_000;

/** Longest chip label kept before it is elided. A chip is one line, not a body. */
export const TOOL_APPROVAL_LABEL_MAX_CHARS = 160;

/**
 * The picker chrome `AskUserQuestion` draws above the question (Issue #2460).
 *
 * `←  ☐ 実行範囲  ☐ 起動場所  ✔ Submit  →` is a tab bar: one checkbox per
 * question, `✔ Submit` for the confirmation step, and an arrow at each end. It
 * is part of a stored row's `question` because, before Issue #2486, the
 * detector's upward scan swept whole pane lines together, and it says nothing a
 * reader wants. The detector now stops the question below it; rows already in
 * the database still carry it, so the display keeps stripping it.
 *
 * The whole structure is required — both arrows, at least one checkbox and the
 * literal `✔ Submit` — rather than "a line that starts with an arrow", because
 * this runs against arbitrary prose. A tab name may hold spaces, Japanese or a
 * line break (the class excludes only the structure's own glyphs), which is what
 * `\S+` in the shape originally proposed for this could not do: it stopped at
 * the space inside `Color scheme` and left the rest of the bar in the label.
 *
 * Defined once, in the detection layer's picker-chrome leaf, so the reader that
 * stops at the bar and the one that strips it cannot disagree about its shape
 * (Issue #2486).
 */
const ASK_USER_QUESTION_TAB_ROW = ASK_USER_QUESTION_TAB_BAR_PREFIX_PATTERN;

/**
 * The sentence the submit-confirmation screen ends on (Issue #2460).
 *
 * Anchored at the END on purpose. The phrase also occurs inside pane dumps and
 * inside prose quoting this flow, and a row is only the confirmation when the
 * phrase CLOSES it — see {@link readSubmitConfirmation} for the second half of
 * the evidence, which is the screen's own `Submit answers` / `Cancel` options.
 */
const SUBMIT_CONFIRMATION_TAIL = /\s*Ready to submit your answers\?\s*$/;

/** The heading above the answer review on that screen. */
const REVIEW_HEADER = /^Review your answers\s*/;

/**
 * One `● question` of the review block, up to its `→ answer`.
 *
 * The answer is deliberately not captured: it is what was CHOSEN, and joining it
 * to the question is how `● UAT サーバーをどこで起動しますか？ → worktree で起動`
 * ended up in a chip label that claimed to be a question.
 */
const REVIEW_QUESTION = /●\s*([^●→]+)/g;

/** Options only the confirmation screen offers. */
const SUBMIT_ANSWERS_OPTION = /^submit answers$/i;
const CANCEL_OPTION = /^cancel$/i;

// ============================================================================
// Types
// ============================================================================

/**
 * What became of one approval, in the order a reader cares about it.
 *
 * `auto` covers both machine paths — the Auto-Yes poller and the permission
 * hook's allow decision — because from the transcript's point of view they are
 * the same statement: nobody was asked.
 */
export type ToolApprovalOutcome =
  | 'human'
  | 'auto'
  | 'terminal'
  | 'pending'
  | 'unclassified'
  | 'unknown';

/**
 * What the row is (Issue #2460).
 *
 * `approval` is a permission dialog — "may I run this?" — and `question` is an
 * `AskUserQuestion` picker, which asks the reader to CHOOSE. One word of chrome
 * ("Tool approvals") over both sends the reader looking for a command that was
 * never there.
 */
export type ToolApprovalKind = 'approval' | 'question';

/**
 * Which screen of a question the row holds (Issue #2460).
 *
 * A single `AskUserQuestion` call walks one screen per question and then a
 * `Review your answers` / `Ready to submit your answers?` screen. The second is
 * not another question: it is the SUBMISSION of the answers to the questions
 * already on screen, and counting it as a question is what turned two questions
 * into "3 件".
 */
export type ToolApprovalPhase = 'question' | 'confirmation';

/**
 * Which outcome survives when two rows describing one dialog are folded.
 *
 * `terminal` is the weakest ANSWERED value on purpose: it is not an observation,
 * it is `worktree-status-helper`'s inference that "the agent moved on, so
 * somebody must have answered". When the Auto-Yes row for the same dialog says
 * `auto`, that one is a record of an actual decision and it wins.
 *
 * [#2460] This rank orders DUPLICATES of one dialog — two records of the same
 * decision. It is deliberately not applied across a question and its submit
 * confirmation: those are two decisions, and the stronger-wins rule would print
 * the confirmer over the answerer every time somebody confirmed by hand what
 * Auto-Yes had answered. See {@link ToolApprovalEntry.confirmationOutcome}.
 */
const OUTCOME_RANK: Record<ToolApprovalOutcome, number> = {
  human: 5,
  auto: 4,
  terminal: 3,
  pending: 2,
  unclassified: 1,
  unknown: 0,
};

/** One chip: a dialog, what it asked, and what became of it. */
export interface ToolApprovalEntry {
  /** The id of the first message folded into this chip. Stable React key. */
  id: string;
  /** Every message this chip stands for, in transcript order. Never empty. */
  messageIds: string[];
  /** One-line label. Empty when the row carried nothing readable. */
  label: string;
  outcome: ToolApprovalOutcome;
  /** True when a folded row was the permission hook's allow audit row. */
  isPermissionAudit: boolean;
  /** `timestamp` as epoch ms, or 0 when the row carried none. */
  timestampMs: number;
  /**
   * Identity of the DIALOG, for folding. Empty means "never fold this row".
   *
   * `question` alone is what Issue #2245 asks for, and it is not enough on its
   * own: the hook's audit rows all ask `Approve Bash?`, so eight unrelated
   * commands 20 seconds apart would collapse into one chip if the window ever
   * widened. `approvalTarget` is the dialog's own panel (#1699) and is
   * byte-identical across the terminal/auto pair — measured — while differing
   * per command, so the two together identify the dialog rather than its shape.
   *
   * [#2460] A question's key is built from its UNTRUNCATED normalized text plus
   * the scope, the structured `questionIndex` and the option labels. Two
   * questions whose first 160 characters agree are a real shape (the measured
   * pair share a `/uat` preamble), so keying on the elided label would fold two
   * different questions into one chip.
   */
  mergeKey: string;
  /** Approval dialog, or `AskUserQuestion` picker (Issue #2460). */
  kind: ToolApprovalKind;
  /** Which screen of the question this is. Absent on an approval. */
  phase?: ToolApprovalPhase;
  /**
   * The question's normalized, UNTRUNCATED text — the identity `label` cannot
   * carry once it is elided. Empty on an approval and on a confirmation.
   */
  questionText: string;
  /** Every question a confirmation's review lists. Empty on anything else. */
  reviewQuestions: string[];
  /** The pane this row came from: worktree + resolved instance + CLI tool. */
  scopeKey: string;
  /**
   * Which run of consecutive `prompt` rows this row came from in the INPUT
   * order, before #2273's hoist moved chips ahead of the replies they preceded.
   *
   * Adjacency after the hoist is not evidence of one operation: `[q1, reply,
   * q2]` renders as `[q1, q2, reply]`, and folding across that would attach a
   * confirmation to a question the agent asked before it said something else.
   * 0 when the caller supplied no run map, which is the single-run default.
   */
  runId: number;
  /**
   * Who submitted the answer set, when this question absorbed its confirmation.
   *
   * Kept beside {@link outcome} rather than merged into it: the measured row is
   * a question Auto-Yes answered (`auto`) whose set a person then submitted
   * (`human`), and one field cannot say both without claiming the person chose
   * the answer.
   */
  confirmationOutcome?: ToolApprovalOutcome;
}

/** How many of each kind a group holds, after folding (Issue #2460). */
export interface ToolApprovalCounts {
  approvals: number;
  questions: number;
  /** Confirmations that could NOT be attached to the question they confirm. */
  confirmations: number;
  /** Chips in total. Not the number of ROWS, which folding makes larger. */
  total: number;
}

/** What {@link readSubmitConfirmation} could establish about a row. */
export interface SubmitConfirmationShape {
  /** `Ready to submit your answers?` CLOSES the text rather than appearing in it. */
  hasTail: boolean;
  /** The options are the confirmation screen's own `Submit answers` / `Cancel`. */
  hasSubmitOptions: boolean;
  /** Each `●` entry of the answer review, normalized the way a question is. */
  reviewQuestions: string[];
}

/** Per-call knobs for {@link buildToolApprovalEntries}. */
export interface ToolApprovalBuildOptions {
  windowMs?: number;
  /**
   * `message.id` → the input-order run it belongs to
   * ({@link ToolApprovalEntry.runId}). Supplied by the row builder, which is the
   * only caller that still holds the pre-hoist order.
   */
  runIds?: ReadonlyMap<string, number>;
}

// ============================================================================
// Defensive readers
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

/** `timestamp` as epoch ms. Tolerates the ISO string the API hands back. */
function toEpochMs(value: unknown): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/**
 * Option labels, whichever shape the row stored them in.
 *
 * `yes_no` stores `['yes', 'no']` and `multiple_choice` stores
 * `[{ number, label }]`; #1708's record stores `[]`. Anything else is a data
 * defect and reads as no options rather than as a throw.
 */
function readOptionLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const option of value) {
    if (typeof option === 'string') {
      labels.push(option);
      continue;
    }
    const label = readString(asRecord(option), 'label');
    if (label) labels.push(label);
  }
  return labels;
}

/**
 * The pane a row belongs to, as one comparable string.
 *
 * `instanceId` defaults to `cliToolId` and `cliToolId` defaults to `claude` —
 * the resolution every other reader of these two fields uses (#868). Two panes
 * of one worktree can ask the same question seconds apart, and folding across
 * them would delete one of the two agents' questions.
 */
function readScopeKey(message: ChatMessage): string {
  const cliToolId = typeof message.cliToolId === 'string' && message.cliToolId
    ? message.cliToolId
    : 'claude';
  const instanceId = typeof message.instanceId === 'string' && message.instanceId
    ? message.instanceId
    : cliToolId;
  const worktreeId = typeof message.worktreeId === 'string' ? message.worktreeId : '';
  return JSON.stringify([worktreeId, cliToolId, instanceId]);
}

// ============================================================================
// Label normalization
// ============================================================================

/** One line of chip-sized text, still at full length. */
function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Cut a one-line text down to a chip. */
function elide(text: string): string {
  if (text.length <= TOOL_APPROVAL_LABEL_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_APPROVAL_LABEL_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Collapse a scraped question into one line of chip-sized text.
 *
 * The detector's `question` is assembled from consecutive pane rows, so it
 * arrives with the dialog's own wrapping in it ("Command\n\nRequesting
 * permission for:\n   git show …"). A chip is one line; the newlines have to go
 * or every chip is four rows tall and the fold saves nothing.
 */
function normalizeLabel(raw: string): string {
  return elide(collapseWhitespace(raw));
}

/**
 * A question with the picker's tab bar taken off the front (Issue #2460).
 *
 * Applied to `question` rows only, and only to the LEADING structure: the tab
 * bar is chrome the scan swept in, while `☐` anywhere else in a question is the
 * author's own text. A body whose arrows or `✔ Submit` are missing — the canary
 * frame's `⏺ I'll load the TaskCreate tool schema first. ☐ First task Which
 * task …`, which has a checkbox and no bar — comes back untouched, because
 * trimming leading glyphs by shape would eat the sentence in front of it.
 */
export function stripAskUserQuestionTabs(question: string): string {
  return collapseWhitespace(question).replace(ASK_USER_QUESTION_TAB_ROW, '').trim();
}

/**
 * What a row says about being the answer-set submission screen (Issue #2460).
 *
 * Structure, never a phrase alone. `hasTail` says the confirmation sentence
 * CLOSES the text; `hasSubmitOptions` says the row's own options are the ones
 * only that screen offers; `reviewQuestions` is the `● …` list it shows above
 * them, which is also the only thing that can tie the confirmation back to the
 * question it confirms — the database stores no id for a question SET.
 */
export function readSubmitConfirmation(
  question: string,
  options: unknown,
): SubmitConfirmationShape {
  const text = stripAskUserQuestionTabs(question);
  const hasTail = SUBMIT_CONFIRMATION_TAIL.test(text);
  const labels = readOptionLabels(options);
  const body = text.replace(SUBMIT_CONFIRMATION_TAIL, '').replace(REVIEW_HEADER, '').trim();

  return {
    hasTail,
    hasSubmitOptions:
      labels.some((label) => SUBMIT_ANSWERS_OPTION.test(label.trim())) &&
      labels.some((label) => CANCEL_OPTION.test(label.trim())),
    reviewQuestions: [...body.matchAll(REVIEW_QUESTION)]
      .map((match) => (match[1] ?? '').trim())
      .filter((entry) => entry.length > 0),
  };
}

// ============================================================================
// Classification
// ============================================================================

/**
 * Whether this row is an approval dialog rather than something to read.
 *
 * Exactly `messageType === 'prompt'`, and deliberately no content heuristic:
 * "does the body look like a composer?" is a detector's job and its answers
 * change with every CLI release. `prompt_response` stays a normal row — it is
 * the ANSWER, which is short and worth reading.
 */
export function isToolApprovalMessage(message: ChatMessage | null | undefined): boolean {
  return message?.messageType === 'prompt';
}

/**
 * Whether this row is the permission hook's allow audit row.
 *
 * The `summary` prefix is the only marker that exists: `messageType` is shared
 * with the scraped dialogs and the schema change that would separate them is
 * explicitly out of scope for Issue #2245 (the `MessageType` union has CLI and
 * skills consumers).
 */
export function isPermissionAuditMessage(message: ChatMessage | null | undefined): boolean {
  const summary = message?.summary;
  return typeof summary === 'string' && summary.startsWith(PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX);
}

/**
 * Which kind of dialog a row records, and which of its screens (Issue #2460).
 *
 * In priority order, and the order is the point:
 *
 *  1. a permission audit is an approval, whatever its question says. The hook
 *     writes the tool name into `question`, and an allow decision on a `Bash`
 *     that happened to mention the picker must not become a "question";
 *  2. `promptData.isAskUserQuestion === true` is the producer's own statement
 *     (#807) and settles the kind. Which SCREEN it is comes from the structure;
 *  3. a Claude row from before that flag existed is a question only when it
 *     carries the confirmation screen's structure — the closing sentence AND
 *     either its `Submit answers`/`Cancel` options or a `●` review list. A row
 *     that merely quotes the sentence is not one, and a row whose origin cannot
 *     be established stays an approval rather than being guessed into a
 *     question;
 *  4. everything else keeps its pre-#2460 treatment.
 *
 * `content` and `instructionText` are never consulted. Both hold whole panes —
 * the measured confirmation row's `instructionText` was an unrelated
 * `echo "=== commandcode インストール状況 ==="` — so a fallback that read them
 * would classify on, and label with, whatever was on screen at the time.
 */
function classifyToolApprovalRow(
  message: ChatMessage,
  record: Record<string, unknown> | null,
  confirmation: SubmitConfirmationShape,
): { kind: ToolApprovalKind; phase?: ToolApprovalPhase } {
  if (isPermissionAuditMessage(message)) return { kind: 'approval' };

  if (record?.isAskUserQuestion === true) {
    const isConfirmation = confirmation.hasTail || confirmation.hasSubmitOptions;
    return { kind: 'question', phase: isConfirmation ? 'confirmation' : 'question' };
  }

  if (confirmation.hasTail && (confirmation.hasSubmitOptions || confirmation.reviewQuestions.length > 0)) {
    return { kind: 'question', phase: 'confirmation' };
  }

  return { kind: 'approval' };
}

/**
 * Describe one approval row as a chip.
 *
 * `content` is deliberately never read: on the scraped rows it is the whole
 * pane, which is the defect this Issue exists to stop rendering. A row with
 * nothing else to say gets an empty label and the caller supplies a translated
 * placeholder — putting the body back as a "fallback" would put 2 KB of terminal
 * back on the screen for exactly the rows that have the least to say.
 *
 * @param runId - Which input-order run of `prompt` rows this row belongs to
 *   (Issue #2460). The default is the single-run case every caller but the row
 *   builder is in.
 */
export function toToolApprovalEntry(message: ChatMessage, runId = 0): ToolApprovalEntry {
  const record = asRecord(message.promptData);
  const isPermissionAudit = isPermissionAuditMessage(message);
  const question = readString(record, 'question');
  const approvalTarget = readString(record, 'approvalTarget');
  const answeredBy = readString(record, 'answeredBy');
  const status = readString(record, 'status');
  const type = readString(record, 'type');
  const summary = typeof message.summary === 'string' ? message.summary : '';

  const confirmation = readSubmitConfirmation(question, record?.options);
  const { kind, phase } = classifyToolApprovalRow(message, record, confirmation);

  let outcome: ToolApprovalOutcome;
  if (isPermissionAudit) {
    // The prefix is the identification, not `answeredBy`: the audit row records
    // a decision the hook already made, so it is auto-approved by construction.
    outcome = 'auto';
  } else if (answeredBy === 'auto' || answeredBy === 'human' || answeredBy === 'terminal') {
    outcome = answeredBy;
  } else if (type === UNCLASSIFIED_PROMPT_TYPE || status === 'unclassified') {
    outcome = 'unclassified';
  } else if (status === 'pending') {
    outcome = 'pending';
  } else {
    outcome = 'unknown';
  }

  const scopeKey = readScopeKey(message);
  const isQuestionScreen = kind === 'question' && phase === 'question';
  const questionText = isQuestionScreen ? stripAskUserQuestionTabs(question) : '';
  // A confirmation reviewing exactly ONE question can name it; a review of
  // several names none of them, and the caller shows the translated
  // "answer submission" instead of picking one or concatenating all three.
  const confirmationLabel =
    kind === 'question' && phase === 'confirmation' && confirmation.reviewQuestions.length === 1
      ? confirmation.reviewQuestions[0]
      : '';

  let label: string;
  if (kind === 'question') {
    // No `summary` fallback on a question: the summary of these rows is written
    // by the same producer as `content` and is not the question.
    label = elide(isQuestionScreen ? questionText : confirmationLabel);
  } else {
    label = normalizeLabel(question || summary);
  }

  let mergeKey = '';
  if (isQuestionScreen) {
    const meta = asRecord(record?.askUserQuestion);
    const questionIndex = typeof meta?.questionIndex === 'number' ? meta.questionIndex : null;
    // Identity is the FULL text plus everything structured that can disagree:
    // two questions of one call differ by `questionIndex` even when their text
    // is identical, and by their options when it is not.
    mergeKey = questionText
      ? JSON.stringify(['question', scopeKey, questionText, questionIndex, readOptionLabels(record?.options)])
      : '';
  } else if (kind === 'approval') {
    // JSON rather than a separator character: a question containing the
    // separator would otherwise be able to collide with a different pair.
    // Byte-identical to the pre-#2460 key, so approval folding is unchanged.
    mergeKey = question ? JSON.stringify([question, approvalTarget]) : '';
  }

  return {
    id: message.id,
    messageIds: [message.id],
    label,
    outcome,
    isPermissionAudit,
    timestampMs: toEpochMs(message.timestamp),
    mergeKey,
    kind,
    ...(phase ? { phase } : {}),
    questionText,
    reviewQuestions: confirmation.reviewQuestions,
    scopeKey,
    runId,
  };
}

// ============================================================================
// Folding
// ============================================================================

/** A working copy nothing outside {@link mergeToolApprovalEntries} shares. */
function cloneEntry(entry: ToolApprovalEntry): ToolApprovalEntry {
  return {
    ...entry,
    messageIds: [...entry.messageIds],
    reviewQuestions: [...entry.reviewQuestions],
  };
}

/**
 * Whether `toMs` sits inside the window that opened at `fromMs`.
 *
 * Both bounds inclusive, and DIRECTED: a row dated before the one it would fold
 * into is not a later record of it. `0` is "no readable timestamp" (see
 * {@link toEpochMs}) and never folds — an unreadable clock cannot establish that
 * two rows are seconds apart.
 */
function withinWindow(fromMs: number, toMs: number, windowMs: number): boolean {
  if (fromMs <= 0 || toMs <= 0) return false;
  const delta = toMs - fromMs;
  return delta >= 0 && delta <= windowMs;
}

/** Whether `entry` is another record of the question `target` already stands for. */
function isQuestionDuplicate(
  target: ToolApprovalEntry,
  entry: ToolApprovalEntry,
  windowMs: number,
): boolean {
  return (
    target.kind === 'question' &&
    target.phase === 'question' &&
    entry.mergeKey !== '' &&
    // The key carries the scope, the untruncated text, the questionIndex and
    // the options, so this one comparison is the whole identity test.
    target.mergeKey === entry.mergeKey &&
    target.runId === entry.runId &&
    withinWindow(target.timestampMs, entry.timestampMs, windowMs)
  );
}

/**
 * Whether `entry` is the submission of the answer set `target` belongs to.
 *
 * Every clause is load-bearing, and the last two are why this is not simply
 * "the row before it":
 *
 *  - same pane. Two agents in one worktree submit their own sets;
 *  - same input-order run. Adjacency after #2273's hoist is a rendering, not a
 *    sequence — a reply between the two rows means they are different
 *    operations even though the chips end up next to each other;
 *  - the review LISTS the question. This is the only tie the data supports:
 *    there is no id for a question set anywhere in `chat_messages`;
 *  - the confirmation lands within the window, measured from the question's
 *    FIRST row so a run of duplicates cannot walk the deadline forward.
 */
function canAbsorbConfirmation(
  target: ToolApprovalEntry,
  entry: ToolApprovalEntry,
  windowMs: number,
): boolean {
  return (
    target.kind === 'question' &&
    target.phase === 'question' &&
    target.scopeKey === entry.scopeKey &&
    target.runId === entry.runId &&
    target.questionText !== '' &&
    entry.reviewQuestions.includes(target.questionText) &&
    withinWindow(target.timestampMs, entry.timestampMs, windowMs)
  );
}

/**
 * Fold the rows that describe one dialog into one chip.
 *
 * Pure and order-preserving: the surviving chip keeps the FIRST row's position,
 * id and timestamp, so folding never moves a chip up or down the transcript, and
 * takes the strongest {@link OUTCOME_RANK} of the rows folded into it. Both
 * halves are what makes the Auto-Yes duplicate read as one approval that was
 * answered automatically, rather than as two approvals one of which was guessed.
 *
 * [#2460] Questions fold under stricter rules than approvals, and only into the
 * chip IMMEDIATELY before them. An approval keeps the original search over every
 * chip in the run — the audit rows it has to tell apart are identified by
 * `approvalTarget`, not by adjacency — but a question that searched backwards
 * would reach over an unrelated dialog to a same-worded question from earlier in
 * the run, which is exactly the "different question in between" case the Issue
 * rules out. A confirmation folds into a question without changing its outcome;
 * one that fits no question stays a chip of its own, counted separately.
 */
export function mergeToolApprovalEntries(
  entries: ToolApprovalEntry[],
  windowMs: number = TOOL_APPROVAL_MERGE_WINDOW_MS,
): ToolApprovalEntry[] {
  const merged: ToolApprovalEntry[] = [];

  for (const entry of entries) {
    if (entry.kind === 'question') {
      const previous = merged[merged.length - 1];

      if (entry.phase === 'confirmation') {
        if (previous && canAbsorbConfirmation(previous, entry, windowMs)) {
          previous.messageIds.push(...entry.messageIds);
          // The confirmer is recorded BESIDE the answerer, never over it.
          previous.confirmationOutcome = entry.outcome;
          continue;
        }
        merged.push(cloneEntry(entry));
        continue;
      }

      if (previous && isQuestionDuplicate(previous, entry, windowMs)) {
        previous.messageIds.push(...entry.messageIds);
        if (!previous.label) previous.label = entry.label;
        if (OUTCOME_RANK[entry.outcome] > OUTCOME_RANK[previous.outcome]) {
          previous.outcome = entry.outcome;
        }
        continue;
      }

      merged.push(cloneEntry(entry));
      continue;
    }

    const target = entry.mergeKey
      ? merged.find(
          (candidate) =>
            candidate.kind === 'approval' &&
            candidate.mergeKey === entry.mergeKey &&
            // Compared against the SURVIVOR's timestamp, never the latest one
            // folded in, so a long run of identical dialogs cannot chain its way
            // past the window one step at a time.
            Math.abs(entry.timestampMs - candidate.timestampMs) <= windowMs,
        )
      : undefined;

    if (!target) {
      merged.push(cloneEntry(entry));
      continue;
    }

    target.messageIds.push(...entry.messageIds);
    target.isPermissionAudit = target.isPermissionAudit || entry.isPermissionAudit;
    if (!target.label) target.label = entry.label;
    if (OUTCOME_RANK[entry.outcome] > OUTCOME_RANK[target.outcome]) {
      target.outcome = entry.outcome;
    }
  }

  return merged;
}

/** Convenience: classify and fold one run of consecutive approval rows. */
export function buildToolApprovalEntries(
  messages: ChatMessage[],
  options: ToolApprovalBuildOptions = {},
): ToolApprovalEntry[] {
  const { windowMs = TOOL_APPROVAL_MERGE_WINDOW_MS, runIds } = options;
  return mergeToolApprovalEntries(
    messages.map((message) => toToolApprovalEntry(message, runIds?.get(message.id) ?? 0)),
    windowMs,
  );
}

/**
 * How many approvals, questions and loose confirmations a group holds.
 *
 * Counted over the FOLDED chips, deliberately: `messageIds.length` counts rows,
 * and rows are what the producers duplicate. The measured group holds three rows
 * and is two questions, so a summary built from row counts reports the defect
 * this Issue exists to remove.
 */
export function countToolApprovalEntries(
  entries: readonly ToolApprovalEntry[],
): ToolApprovalCounts {
  let approvals = 0;
  let questions = 0;
  let confirmations = 0;

  for (const entry of entries) {
    if (entry.kind !== 'question') approvals += 1;
    else if (entry.phase === 'confirmation') confirmations += 1;
    else questions += 1;
  }

  return { approvals, questions, confirmations, total: entries.length };
}
