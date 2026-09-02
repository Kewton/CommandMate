/**
 * Layout math and content splitting for the chat transcript (Issue #2232).
 *
 * `ChatTranscript` is a second transcript implementation, deliberately: Epic
 * #2192's original decision ("the chat surface IS `HistoryPane`") was withdrawn
 * once the shipped screen was looked at — a history browser wants density and a
 * conversation wants the reply, and one component cannot be both. What is NOT
 * duplicated is this module: the numbers and the pure functions the bubble list
 * needs live here so they can be asserted without a layout engine, exactly the
 * way `lib/history-virtualization` serves `HistoryPane`.
 *
 * The scroll predicate is NOT redefined here. `isNearBottom` is imported from
 * `lib/history-virtualization` by both surfaces, because "the reader is at the
 * end" is one fact about one scroll box and two copies of it would drift.
 */

import type { ChatMessage } from '@/types/models';
import {
  buildToolApprovalEntries,
  isToolApprovalMessage,
  type ToolApprovalEntry,
} from './chat-tool-approvals';

// ============================================================================
// Virtualization tuning
// ============================================================================

/**
 * Extra rows mounted above and below the visible window.
 *
 * Larger than `HISTORY_VIRTUAL_OVERSCAN` would need to be per *pair*, because a
 * row here is one MESSAGE: the same screen holds roughly twice as many rows, and
 * a flick covers twice as many of them.
 */
export const CHAT_VIRTUAL_OVERSCAN = 8;

/**
 * Initial per-message height estimate (px), used until `measureElement`
 * reports the real height.
 *
 * Only the scrollbar and the first frame depend on it. Deliberately smaller
 * than `HISTORY_ESTIMATED_PAIR_HEIGHT_PX` (160): that number estimates a
 * user+assistant card, and this one estimates a single bubble.
 */
export const CHAT_ESTIMATED_MESSAGE_HEIGHT_PX = 120;

/**
 * How many leading messages are rendered in plain flow when the virtualizer has
 * measured no viewport and therefore materialized no rows.
 *
 * This is #1123's fallback, kept verbatim in intent: the virtualizer reports a
 * zero-size viewport on the first render (before the layout effect measures) and
 * in every layout-less environment — jsdom included — and without this branch
 * the transcript renders an empty box in both. `HISTORY_FALLBACK_RENDER_COUNT`
 * is 30 pairs; 40 messages is the same amount of conversation, since a pair is
 * usually two rows.
 */
export const CHAT_FALLBACK_RENDER_COUNT = 40;

// ============================================================================
// Role grouping
// ============================================================================

/**
 * Whether this message needs a role/time header, or is a continuation of the
 * one above it.
 *
 * Chat reads as a conversation only when the labels mark the TURNS rather than
 * every row: two assistant rows in a row are one answer that happened to be
 * saved twice (a tool call and the sentence about its output, say), and
 * stamping "Assistant" on both makes the surface look like a log again.
 *
 * Deliberately role-only, with no time gap rule. A gap threshold would put a
 * header back in the middle of one reply whenever the two rows were written
 * minutes apart — which is normal for a long turn — and the label would then be
 * saying something the reader cannot act on.
 */
export function shouldShowRoleHeader(
  previous: ChatMessage | undefined,
  current: ChatMessage,
): boolean {
  if (!previous) return true;
  return previous.role !== current.role;
}

// ============================================================================
// Rows (Issue #2245)
// ============================================================================

/**
 * One row of the transcript.
 *
 * A row stopped being a message here. `messageType === 'prompt'` rows are
 * approval dialogs, not replies (see `chat-tool-approvals` for the measurement),
 * and a run of them collapses into ONE row carrying every chip — which is what
 * turns codex's 41 consecutive `Bash: git worktree remove …` bubbles into a
 * single line the reader can open if they want it.
 */
export type ChatTranscriptRow =
  | {
      kind: 'message';
      /** Virtualizer key. The message id, which is already unique per row. */
      key: string;
      message: ChatMessage;
      showHeader: boolean;
    }
  | {
      kind: 'approvals';
      /** Virtualizer key, namespaced so it can never collide with a message id. */
      key: string;
      entries: ToolApprovalEntry[];
    };

/**
 * Turn a message list into the rows the transcript renders.
 *
 * Two things happen here and both are load-bearing:
 *
 *  1. consecutive approval rows fold into one `approvals` row;
 *  2. `showHeader` is computed against the previous NON-approval message.
 *
 * (2) is what keeps the role labels honest. A chip group is not an assistant
 * turn, so it must not be able to add or remove an "Assistant" header:
 * `[user, assistant]` and `[user, prompt, prompt, assistant]` render the same
 * one header, and `[assistant, prompt, assistant]` still renders exactly one.
 * Asking {@link shouldShowRoleHeader} about the chip row instead — which is
 * what the pre-#2245 code did, since a chip row was an assistant bubble — gives
 * the second list ZERO assistant headers, because the reply is reading itself as
 * a continuation of an audit row.
 */
export function buildChatTranscriptRows(messages: ChatMessage[]): ChatTranscriptRow[] {
  const rows: ChatTranscriptRow[] = [];
  /** The last row that speaks: approval chips are skipped over. */
  let previousSpoken: ChatMessage | undefined;
  let run: ChatMessage[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    rows.push({
      kind: 'approvals',
      key: `approvals:${run[0].id}`,
      entries: buildToolApprovalEntries(run),
    });
    run = [];
  };

  for (const message of messages) {
    if (isToolApprovalMessage(message)) {
      run.push(message);
      continue;
    }
    flushRun();
    rows.push({
      kind: 'message',
      key: message.id,
      message,
      showHeader: shouldShowRoleHeader(previousSpoken, message),
    });
    previousSpoken = message;
  }
  flushRun();

  return rows;
}

// ============================================================================
// File paths in message bodies
// ============================================================================

/** One run of a message body: plain text, or a path worth linking. */
export interface ChatContentPart {
  type: 'text' | 'path';
  content: string;
}

/**
 * Absolute-looking paths with an extension. Same shape `ConversationPairCard`
 * matches on, and intentionally not shared with it: that file is frozen by this
 * Issue's scope, and a regex copied WITH the reason for its shape is a smaller
 * liability than an import that cannot be made.
 */
const FILE_PATH_REGEX = /(\/[^\s\n<>"']+\.[a-zA-Z0-9]+)/g;

/**
 * Split a body into alternating text and path runs.
 *
 * Returns a single text part when there is nothing to link, so the caller can
 * render the common case without allocating a list of one-character spans.
 */
export function splitFilePathParts(content: string): ChatContentPart[] {
  // A row whose `content` is not a string is a data defect somewhere upstream,
  // and the transcript is the wrong place to turn it into a white screen: one
  // bad row would take the whole conversation, live region and all, down with
  // it. Render it as empty and let the defect be visible as a blank bubble.
  if (typeof content !== 'string' || content.length === 0) {
    return [{ type: 'text', content: '' }];
  }

  const matches = content.match(FILE_PATH_REGEX);
  if (!matches || matches.length === 0) {
    return [{ type: 'text', content }];
  }

  const parts: ChatContentPart[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    const index = content.indexOf(match, lastIndex);
    if (index === -1) continue;
    if (index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, index) });
    }
    parts.push({ type: 'path', content: match });
    lastIndex = index + match.length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) });
  }

  return parts;
}

// ============================================================================
// The in-flight turn (Issue #2233)
// ============================================================================

/**
 * Whether the live bubble at the tail needs an "Assistant" header.
 *
 * The same rule {@link shouldShowRoleHeader} applies to a settled row, asked
 * about a row that does not exist yet: the in-flight reply IS an assistant
 * message, it is simply not saved. Deriving it here rather than inlining
 * `previous?.role !== 'assistant'` at the call site is what guarantees the
 * header does not appear or disappear at the moment the turn settles — the two
 * answers are computed from the same `previous` by the same predicate, so a
 * change to one is a change to both.
 */
export function shouldShowLiveRoleHeader(previous: ChatMessage | undefined): boolean {
  if (!previous) return true;
  return previous.role !== 'assistant';
}
