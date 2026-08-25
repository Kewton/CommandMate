/**
 * How a history row says it holds the agent's own words (Issue #2041).
 *
 * Every `chat_messages` row written before this Issue came off a terminal: the
 * poller captured a pane, cleaned the box drawing out of it and saved what was
 * left. That text is a *rendering* — the agent's Markdown after the TUI has
 * already laid it out — so the browser must show it verbatim, and it does
 * (`whitespace-pre-wrap`).
 *
 * opencode publishes the Markdown itself, and a row holding source rather than
 * a rendering has to be told apart from its neighbours, because rendering the
 * scraped rows as Markdown would be wrong in both directions: a `┌───` box
 * would become a table cell, and a `# ` a heading. The two kinds live in one
 * table, are listed by one query and are drawn by one card, so the distinction
 * has to travel on the row.
 *
 * ## Why the marker rides on `request_id`
 *
 * It is the only column on `chat_messages` that is (a) already there, (b)
 * indexed, (c) nullable, and (d) written by exactly one existing producer
 * (`parseClaudeOutput`, for `claude` rows only), so a new value cannot collide
 * with a meaning something already reads. `message_type` was the alternative
 * and was rejected: {@link MessageType} is a three-word union that a dozen call
 * sites switch on, and a fourth word would have every one of them treating a
 * perfectly ordinary reply as something they do not recognise.
 *
 * A column of its own would have been cleaner and is deliberately not taken:
 * Issue #2044 is adding schema v58 in parallel, and two v58s do not merge.
 *
 * ## It is an idempotency key as well as a marker
 *
 * The same string is what stops one turn being saved twice — see
 * {@link opencodeTurnRequestId}. That is not a coincidence being exploited: the
 * marker has to name *which* turn it came from to be a key, and a key that
 * names its origin is exactly what a provenance marker is.
 *
 * @module types/agent-transcript
 */

/**
 * Prefix on `chat_messages.request_id` for a row whose `content` is the agent's
 * own Markdown rather than a scrape of its terminal.
 *
 * The `:` is load-bearing — it cannot appear in a claude request id, so
 * {@link isAgentAuthoredMarkdown} cannot answer true for a pre-existing row.
 */
export const AGENT_MARKDOWN_REQUEST_ID_PREFIX = 'oc-turn:';

/**
 * Whether this row's `content` may be rendered as Markdown.
 *
 * Conservative by construction: an absent or unrecognised `requestId` answers
 * false, which is the pre-#2041 rendering. Nothing is ever *upgraded* to
 * Markdown by guessing at its content.
 *
 * @param requestId - `ChatMessage.requestId`, which is usually absent
 */
export function isAgentAuthoredMarkdown(requestId: string | undefined | null): boolean {
  return typeof requestId === 'string' && requestId.startsWith(AGENT_MARKDOWN_REQUEST_ID_PREFIX);
}

/**
 * The row id for one opencode turn.
 *
 * The turn is named by the **user message it answers** (`parentID` on every
 * assistant message opencode produces — measured on 1.18.22, see
 * `docs/design/opencode-server-live-verification.md` §13). Deliberately not the
 * assistant message's own id: one turn can produce several assistant messages —
 * measured, a `bash` call and the sentence about its output arrived as
 * `msg_…002` (`finish: "tool-calls"`) and `msg_…003` (`finish: "stop"`) — and
 * keying on those would split one reply into two history rows and re-split it
 * differently on a backfill.
 *
 * @param userMessageId - `msg_…`, the `parentID` the assistant messages carry
 */
export function opencodeTurnRequestId(userMessageId: string): string {
  return `${AGENT_MARKDOWN_REQUEST_ID_PREFIX}${userMessageId}`;
}
