/**
 * Tool-approval rows in the chat transcript (Issue #2245).
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
 */
export const TOOL_APPROVAL_MERGE_WINDOW_MS = 5_000;

/** Longest chip label kept before it is elided. A chip is one line, not a body. */
export const TOOL_APPROVAL_LABEL_MAX_CHARS = 160;

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
 * Which outcome survives when two rows describing one dialog are folded.
 *
 * `terminal` is the weakest ANSWERED value on purpose: it is not an observation,
 * it is `worktree-status-helper`'s inference that "the agent moved on, so
 * somebody must have answered". When the Auto-Yes row for the same dialog says
 * `auto`, that one is a record of an actual decision and it wins.
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
   */
  mergeKey: string;
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
 * Collapse a scraped question into one line of chip-sized text.
 *
 * The detector's `question` is assembled from consecutive pane rows, so it
 * arrives with the dialog's own wrapping in it ("Command\n\nRequesting
 * permission for:\n   git show …"). A chip is one line; the newlines have to go
 * or every chip is four rows tall and the fold saves nothing.
 */
function normalizeLabel(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TOOL_APPROVAL_LABEL_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, TOOL_APPROVAL_LABEL_MAX_CHARS - 1).trimEnd()}…`;
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
 * Describe one approval row as a chip.
 *
 * `content` is deliberately never read: on the scraped rows it is the whole
 * pane, which is the defect this Issue exists to stop rendering. A row with
 * nothing else to say gets an empty label and the caller supplies a translated
 * placeholder — putting the body back as a "fallback" would put 2 KB of terminal
 * back on the screen for exactly the rows that have the least to say.
 */
export function toToolApprovalEntry(message: ChatMessage): ToolApprovalEntry {
  const record = asRecord(message.promptData);
  const isPermissionAudit = isPermissionAuditMessage(message);
  const question = readString(record, 'question');
  const approvalTarget = readString(record, 'approvalTarget');
  const answeredBy = readString(record, 'answeredBy');
  const status = readString(record, 'status');
  const type = readString(record, 'type');
  const summary = typeof message.summary === 'string' ? message.summary : '';

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

  return {
    id: message.id,
    messageIds: [message.id],
    label: normalizeLabel(question || summary),
    outcome,
    isPermissionAudit,
    timestampMs: toEpochMs(message.timestamp),
    // JSON rather than a separator character: a question containing the
    // separator would otherwise be able to collide with a different pair.
    mergeKey: question ? JSON.stringify([question, approvalTarget]) : '',
  };
}

/**
 * Fold the rows that describe one dialog into one chip.
 *
 * Pure and order-preserving: the surviving chip keeps the FIRST row's position,
 * id and timestamp, so folding never moves a chip up or down the transcript, and
 * takes the strongest {@link OUTCOME_RANK} of the rows folded into it. Both
 * halves are what makes the Auto-Yes duplicate read as one approval that was
 * answered automatically, rather than as two approvals one of which was guessed.
 */
export function mergeToolApprovalEntries(
  entries: ToolApprovalEntry[],
  windowMs: number = TOOL_APPROVAL_MERGE_WINDOW_MS,
): ToolApprovalEntry[] {
  const merged: ToolApprovalEntry[] = [];

  for (const entry of entries) {
    const target = entry.mergeKey
      ? merged.find(
          (candidate) =>
            candidate.mergeKey === entry.mergeKey &&
            // Compared against the SURVIVOR's timestamp, never the latest one
            // folded in, so a long run of identical dialogs cannot chain its way
            // past the window one step at a time.
            Math.abs(entry.timestampMs - candidate.timestampMs) <= windowMs,
        )
      : undefined;

    if (!target) {
      merged.push({ ...entry, messageIds: [...entry.messageIds] });
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
  windowMs: number = TOOL_APPROVAL_MERGE_WINDOW_MS,
): ToolApprovalEntry[] {
  return mergeToolApprovalEntries(messages.map(toToolApprovalEntry), windowMs);
}
