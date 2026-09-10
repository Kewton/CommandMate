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
import { correlatedPromptRequestId, resolveAgentTurnKey } from '@/types/agent-transcript';
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
// Turn boundaries (Issue #2458)
// ============================================================================

/**
 * What a transcript row's header says.
 *
 *  - `role` — the conventional label + clock ("Assistant · 18:18 → 18:33").
 *    Drawn at the top of a display segment and whenever the speaker changes.
 *  - `time` — a CLOCK ONLY, drawn as a thin rule between two consecutive
 *    assistant rows that belong to different turns. No role label, because
 *    repeating "Assistant" every few rows is what made the pre-#2458 surface
 *    read as a log; what the reader is missing is *when this answer finished*,
 *    not *who wrote it*.
 *  - `none` — a continuation of the row above.
 */
export type ChatRowHeaderVariant = 'none' | 'role' | 'time';

/**
 * The header above one row, and the clock it carries (Issue #2458).
 *
 * `startedAtMs` is the instant the CORRELATED USER ROW was saved — a fact read
 * off a row that is in this same segment, not an estimate of when the model
 * began working. `null` means no such row could be identified, and the header
 * then shows the end instant alone. Nothing here ever falls back to "the
 * previous user message": see {@link resolveTurnStartMs}.
 */
export interface ChatRowHeader {
  readonly variant: ChatRowHeaderVariant;
  readonly startedAtMs: number | null;
}

/** The shared "this row continues the one above it" header. */
const CHAT_ROW_HEADER_NONE: ChatRowHeader = { variant: 'none', startedAtMs: null };

/**
 * The conversation a row belongs to, as far as this transcript can tell.
 *
 * `ChatTranscript` already keys its own state on
 * `worktreeId|cliToolId|instanceId` (its `conversationKey`) and every row in one
 * call to {@link buildChatTranscriptRows} shares a worktree, so the tool and the
 * instance are the whole of what can still vary inside one list. Two rows that
 * disagree on it are two different agents whose turns happen to be interleaved
 * in one column, and correlating a claude reply with a codex prompt because
 * their ids matched would be worse than showing no start time at all.
 */
function chatRowScopeKey(message: ChatMessage): string {
  return `${message.cliToolId ?? ''}|${message.instanceId ?? ''}`;
}

/** A user row that could open a turn, reduced to the two facts the header needs. */
interface CorrelatedPrompt {
  readonly atMs: number;
  readonly scope: string;
}

/**
 * `request_id` → the user row carrying it, or `null` when more than one does.
 *
 * The `null` is the interesting half. Two saved user rows with the SAME prompt
 * id is a shape the database does not promise against — a re-read that raced
 * its own idempotency check, a row copied across instances — and when it
 * happens neither row is evidence of anything. "Ambiguous" and "absent" then
 * produce the same header, which is the conservative direction: an end time
 * alone is incomplete, a start time taken from the wrong row is wrong.
 *
 * Refused before they can be indexed:
 *
 *  - **approval rows** (`messageType === 'prompt'`), which are dialogs rather
 *    than anything the operator typed;
 *  - **optimistic rows** (#1121's pending and failed sends), whose clock is the
 *    browser's guess at a send that may not have happened;
 *  - **archived rows**, which are a previous session's (#2445 keeps them out of
 *    the list entirely, and this is the belt to that braces);
 *  - **an unusable timestamp**, which is indexed as ambiguous rather than
 *    skipped so that a second row bearing the same id still poisons the key.
 */
function buildPromptIndex(messages: readonly ChatMessage[]): Map<string, CorrelatedPrompt | null> {
  const index = new Map<string, CorrelatedPrompt | null>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (isToolApprovalMessage(message)) continue;
    if (message.optimisticState) continue;
    if (message.archived) continue;
    const requestId = message.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) continue;
    if (index.has(requestId)) {
      index.set(requestId, null);
      continue;
    }
    const atMs = message.timestamp instanceof Date ? message.timestamp.getTime() : NaN;
    index.set(
      requestId,
      Number.isFinite(atMs) ? { atMs, scope: chatRowScopeKey(message) } : null,
    );
  }
  return index;
}

/**
 * When the turn this reply belongs to was ASKED, or `null`.
 *
 * Five conditions, and every one of them is a way of saying "no" rather than a
 * way of finding a number:
 *
 *  1. the reply names a turn at all ({@link resolveAgentTurnKey});
 *  2. that turn key can name its prompt row ({@link correlatedPromptRequestId}
 *     — `null` for codex and opencode, whose two halves carry different ids);
 *  3. exactly one displayable user row in this segment carries that id;
 *  4. that row is in the same scope as the reply;
 *  5. both clocks are usable and the prompt is not AFTER the reply.
 *
 * (5)'s ordering check is not paranoia about the database: #2273 measured
 * producers writing an approval 1–2 seconds late, a row's timestamp is never
 * rewritten, and a "start" that follows its own "end" would render as
 * `18:33 → 18:18` — a header that tells the reader the surface is broken. The
 * end instant alone is the honest fallback.
 */
function resolveTurnStartMs(
  message: ChatMessage,
  turnKey: string | null,
  prompts: ReadonlyMap<string, CorrelatedPrompt | null>,
): number | null {
  if (turnKey === null) return null;
  const promptRequestId = correlatedPromptRequestId(turnKey);
  if (promptRequestId === null) return null;
  const prompt = prompts.get(promptRequestId);
  // Absent (`undefined`) and ambiguous (`null`) are one answer here.
  if (!prompt) return null;
  if (prompt.scope !== chatRowScopeKey(message)) return null;
  const endedAtMs = message.timestamp instanceof Date ? message.timestamp.getTime() : NaN;
  if (!Number.isFinite(endedAtMs)) return null;
  if (prompt.atMs > endedAtMs) return null;
  return prompt.atMs;
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
      /**
       * Whether the ROLE label is drawn. Unchanged in meaning since #2245, and
       * deliberately still a boolean: Issue #2458's new header is not a role
       * label, so it must not be able to turn this on (see {@link header}).
       */
      showHeader: boolean;
      /**
       * What the header above this row says, and what clock it carries
       * (Issue #2458).
       *
       * Invariant, and it is asserted rather than assumed:
       * `showHeader === (header.variant === 'role')`.
       */
      header: ChatRowHeader;
    }
  | {
      kind: 'approvals';
      /** Virtualizer key, namespaced so it can never collide with a message id. */
      key: string;
      entries: ToolApprovalEntry[];
    };

/**
 * Move each turn's approval rows ahead of its replies (Issue #2273).
 *
 * ## The defect
 *
 * A turn really goes **question → approval → answer**, and the chat surface drew
 * it as question → answer → approval. Measured on antigravity: prompt
 * `04:49:50.989Z`, reply `04:49:54.000Z`, approval dialog `04:49:57.513Z`. The
 * transcript readers dated a reply by the instant the TURN OPENED, so the reply
 * sorted three seconds before an approval that the agent had asked for on the
 * way to writing it. The readers now date a reply at its turn's END, which fixes
 * every row written from here on — and fixes nothing already in the database,
 * because a row's timestamp is never rewritten (#2264 replaces bodies, not
 * clocks).
 *
 * ## Why the display layer carries it too
 *
 * Two reasons, and either one alone would justify it:
 *
 *  - **the rows already there.** They keep the timestamp they were written with,
 *    so the only place their order can be corrected is here.
 *  - **the producers that are still late.** An approval is written by three
 *    different paths (see `./chat-tool-approvals`) and the Auto-Yes one lands
 *    1–2 seconds after the sweep's row — measured — so an approval row arriving
 *    *after* a reply that was correctly dated is a shape that still occurs.
 *
 * ## The rule, and what it gives up
 *
 * A turn is one `role: 'user'` row and everything until the next one. Inside a
 * turn, every approval row is emitted first, in its own order, and everything
 * else follows in its own order. Nothing crosses a turn boundary, so no approval
 * can be lifted onto the wrong question.
 *
 * What this gives up is the INTERLEAVING between approvals and replies inside
 * one turn: a scraped turn saved as `[a1, p1, a2]` renders as `p1, a1, a2`. That
 * is a deliberate trade and the cheap direction — a chip group is one line
 * standing for rows #2245 measured at 41–43 of every 50, and its position within
 * a turn carries far less than the turn's own shape does. The alternative, a
 * per-row rule that guessed which replies a given approval preceded, would be
 * guessing from the timestamps that are the thing at fault.
 *
 * Pure, and returns the argument itself when nothing has to move — which is
 * every turn whose rows were written after this Issue landed.
 */
export function hoistTurnApprovals(messages: ChatMessage[]): ChatMessage[] {
  const ordered: ChatMessage[] = [];
  /** This turn's approval rows, and its other rows, both in arrival order. */
  let approvals: ChatMessage[] = [];
  let spoken: ChatMessage[] = [];
  let moved = false;

  const flushTurn = (): void => {
    ordered.push(...approvals, ...spoken);
    approvals = [];
    spoken = [];
  };

  for (const message of messages) {
    // A `user` row opens a turn and stays at its head: it is the question the
    // approvals below it were asked on the way to answering.
    if (message.role === 'user' && !isToolApprovalMessage(message)) {
      flushTurn();
      ordered.push(message);
      continue;
    }
    if (!isToolApprovalMessage(message)) {
      spoken.push(message);
      continue;
    }
    // An approval with a reply already ahead of it in this turn is the defect:
    // it has to jump, and only then has anything actually moved.
    if (spoken.length > 0) moved = true;
    approvals.push(message);
  }
  flushTurn();

  // Returning the argument when nothing jumped keeps `buildChatTranscriptRows`
  // allocation-free on the path every row written after this Issue takes, and
  // keeps the `useMemo` that calls it honest.
  return moved ? ordered : messages;
}

/**
 * Turn a message list into the rows the transcript renders.
 *
 * Four things happen here and all four are load-bearing:
 *
 *  1. each turn's approval rows are lifted ahead of its replies
 *     ({@link hoistTurnApprovals}, Issue #2273);
 *  2. consecutive approval rows fold into one `approvals` row;
 *  3. `showHeader` is computed against the previous NON-approval message;
 *  4. a run of assistant rows is cut into TURNS, and each cut gets a clock
 *     ({@link ChatRowHeader}, Issue #2458).
 *
 * (4) is what this function is for now. Saved assistant rows arrive
 * back-to-back whenever a turn was opened by something other than a typed
 * prompt — a `task-notification` reply has no user row at all, because
 * `recordClaudeUserTurn` does not write one — so before this Issue four
 * separate answers rendered under ONE "Assistant 18:33" header and the reader
 * could not tell where one ended. The cut is made on the turn key the row
 * already carries (`request_id`), never on a time gap: a long turn writes its
 * rows minutes apart and a gap rule would cut it in half.
 *
 * The header's start-side clock is deliberately scarce. It is shown only when a
 * user row in THIS segment provably opened that same turn — see
 * {@link resolveTurnStartMs} — so codex and opencode rows get the boundary and
 * no start time, and nothing is ever borrowed from "the user message above".
 *
 * (3) is what keeps the role labels honest. A chip group is not an assistant
 * turn, so it must not be able to add or remove an "Assistant" header:
 * `[user, assistant]` and `[user, prompt, prompt, assistant]` render the same
 * one header, and `[assistant, prompt, assistant]` still renders exactly one.
 * Asking {@link shouldShowRoleHeader} about the chip row instead — which is
 * what the pre-#2245 code did, since a chip row was an assistant bubble — gives
 * the second list ZERO assistant headers, because the reply is reading itself as
 * a continuation of an audit row.
 *
 * (1) cannot disturb (3) for the same reason: the header of a reply is decided
 * against the last row that SPEAKS, and lifting chips over it changes neither
 * which rows speak nor their order among themselves.
 */
export function buildChatTranscriptRows(messages: ChatMessage[]): ChatTranscriptRow[] {
  const ordered = hoistTurnApprovals(messages);
  // [#2458] Built once per segment, and from THIS segment only: the caller
  // splits the previous session from the current one (#2445) by calling this
  // function twice, so a prompt on the far side of that fold can never be
  // reached from here.
  const prompts = buildPromptIndex(ordered);

  const rows: ChatTranscriptRow[] = [];
  /** The last row that speaks: approval chips are skipped over. */
  let previousSpoken: ChatMessage | undefined;
  let run: ChatMessage[] = [];
  /**
   * [#2458] The last KNOWN turn key of the assistant run in progress, and the
   * scope it was read from.
   *
   * "Last known" and not "the previous row's": a row with no usable
   * `request_id` — a pane scrape, an Auto-Yes note, a producer this build does
   * not know — must not be able to CREATE a boundary, so it leaves the memory
   * alone. `[A, unknown, A]` is one turn and draws one header; `[A, unknown,
   * B]` is two and draws two. Treating unknown as a new key would split every
   * reply that happens to contain a scraped row, and treating it as the end of
   * the run would silently merge the two turns on either side of it.
   */
  let lastTurnKey: string | null = null;
  let lastScope: string | null = null;

  const flushRun = (): void => {
    if (run.length === 0) return;
    rows.push({
      kind: 'approvals',
      key: `approvals:${run[0].id}`,
      entries: buildToolApprovalEntries(run),
    });
    run = [];
  };

  for (const message of ordered) {
    if (isToolApprovalMessage(message)) {
      run.push(message);
      continue;
    }
    flushRun();

    const showHeader = shouldShowRoleHeader(previousSpoken, message);
    let header: ChatRowHeader = CHAT_ROW_HEADER_NONE;

    if (message.role !== 'assistant') {
      // A user row is the start of a new question, so the run it closes cannot
      // reach across it. Its own header shows its own instant and nothing else:
      // a prompt has no duration to report.
      lastTurnKey = null;
      lastScope = null;
      if (showHeader) header = { variant: 'role', startedAtMs: null };
    } else {
      const scope = chatRowScopeKey(message);
      // A role change already means a new run; a scope change means the rows
      // are two different agents' and were never one run to begin with.
      if (showHeader || lastScope !== scope) lastTurnKey = null;
      lastScope = scope;

      const turnKey = resolveAgentTurnKey(message.requestId);
      const startedAtMs = resolveTurnStartMs(message, turnKey, prompts);

      if (showHeader) {
        header = { variant: 'role', startedAtMs };
      } else if (turnKey !== null && lastTurnKey !== null && turnKey !== lastTurnKey) {
        // The one new header this Issue adds: same speaker, different turn.
        header = { variant: 'time', startedAtMs };
      }

      if (turnKey !== null) lastTurnKey = turnKey;
    }

    rows.push({
      kind: 'message',
      key: message.id,
      message,
      showHeader,
      header,
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
 * Absolute-looking paths with an extension, anchored on their LEFT edge.
 *
 * Issue #2274: without the boundary group this pattern was
 * `/(\/[^\s\n<>"']+\.[a-zA-Z0-9]+)/g`, which starts a match at ANY `/` — so
 * `commandmate-skills/docs/uat/report-template.md` in a reply linkified its
 * tail, `/docs/uat/report-template.md`, and only its tail. One path rendered in
 * two colors, and the half that became a button named a file this worktree does
 * not have. Group 1 is that boundary and it is CONSUMED rather than looked
 * behind (see {@link splitFilePathParts} for what that costs, which is nothing):
 * a match may only begin at the start of the body or right after whitespace, a
 * backtick, a quote or an opening bracket.
 *
 * Two consequences worth stating, because both are behaviour changes:
 *
 *  - a RELATIVE path is not a link. `docs/uat/x.md` stays plain text, and that
 *    is the decision this Issue makes rather than a gap in it: `a/b.md` is not
 *    distinguishable, from the text alone, from this worktree's `a/b.md`,
 *    another repository's, or prose about a ratio. The defect being fixed here
 *    is exactly a false positive of that kind, so adding a relative branch back
 *    would re-open it under a different name.
 *  - a URL is not a link either. `https://example.com/a/b.js` offers no
 *    boundary before either slash of `//` (`:` and `/` are deliberately absent
 *    from the boundary class), so it is no longer split into prose plus a
 *    fictional file. It was, before this Issue.
 *
 * `ConversationPairCard` renders History's copy of the same bodies and now
 * imports {@link splitFilePathParts} instead of carrying its own copy of this
 * pattern. Issue #2232 froze that file to keep History pixel-identical; a
 * clickable range that names the wrong file is not a look, so the freeze does
 * not reach it. One regex, one behaviour, asserted from both surfaces against
 * the same fixtures.
 */
const FILE_PATH_REGEX = /(^|[\s`"'(\[<（「『【])(\/[^\s\n<>"']+\.[a-zA-Z0-9]+)/g;

/**
 * Split a body into alternating text and path runs.
 *
 * Returns a single text part when there is nothing to link, so the caller can
 * render the common case without allocating a list of one-character spans.
 *
 * Issue #2274 replaced `String.prototype.match` + `indexOf` with `matchAll`:
 * the old loop re-FOUND each matched string by searching for it, which the
 * boundary group would have made ambiguous, and which could already land on the
 * wrong occurrence of a repeated path. `match.index` is the position the engine
 * actually matched at, so the offsets are no longer a second guess at it.
 *
 * Consuming the boundary character cannot hide a second path: the boundary sits
 * BEFORE a run, a run always ends on `[a-zA-Z0-9]`, and therefore the character
 * that terminates one path is never the character another path needs as its
 * boundary. `a /x.ts /y.ts` yields both.
 */
export function splitFilePathParts(content: string): ChatContentPart[] {
  // A row whose `content` is not a string is a data defect somewhere upstream,
  // and the transcript is the wrong place to turn it into a white screen: one
  // bad row would take the whole conversation, live region and all, down with
  // it. Render it as empty and let the defect be visible as a blank bubble.
  if (typeof content !== 'string' || content.length === 0) {
    return [{ type: 'text', content: '' }];
  }

  const parts: ChatContentPart[] = [];
  let lastIndex = 0;

  // `matchAll` copies the pattern and its `lastIndex`, so this module-level
  // `/g` regex is safe to share across calls (an `exec` loop would not be).
  for (const match of content.matchAll(FILE_PATH_REGEX)) {
    const boundary = match[1] ?? '';
    const filePath = match[2];
    if (!filePath) continue;
    const index = (match.index ?? 0) + boundary.length;
    if (index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, index) });
    }
    parts.push({ type: 'path', content: filePath });
    lastIndex = index + filePath.length;
  }

  if (parts.length === 0) {
    return [{ type: 'text', content }];
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
