/**
 * How a history row says it holds the agent's own words (Issue #2041, extended
 * for Claude Code in Issue #2121).
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
 * Prefix on `chat_messages.request_id` for a row whose `content` is opencode's
 * own Markdown rather than a scrape of its terminal.
 *
 * The `:` is load-bearing — it cannot appear in a claude request id, so
 * {@link isAgentAuthoredMarkdown} cannot answer true for a pre-existing row.
 */
export const AGENT_MARKDOWN_REQUEST_ID_PREFIX = 'oc-turn:';

/**
 * The same, for a turn read out of Claude Code's transcript JSONL (Issue #2121).
 *
 * A prefix of its own rather than a second use of `oc-turn:` because the marker
 * is also the idempotency key, and the two readers name their turns with ids
 * from different namespaces — opencode's `msg_…` and Claude's record `uuid`.
 * Sharing the prefix would make a collision between the two a silent "already
 * saved", which is the one failure mode a key must not have.
 *
 * `claude-` and not `cc-`: the string is what an operator reads in the row when
 * they ask why History shows Markdown, and the tool id is what they will search
 * the codebase for.
 */
export const CLAUDE_MARKDOWN_REQUEST_ID_PREFIX = 'claude-turn:';

/**
 * Prefix on `chat_messages.request_id` for a **user** row whose text was read
 * out of Claude Code's transcript rather than written by `/send` (Issue #2196).
 *
 * Deliberately *not* one of {@link AGENT_MARKDOWN_REQUEST_ID_PREFIXES}. The two
 * jobs the `request_id` column does are separable, and this constant only does
 * the first:
 *
 *  - **idempotency key** — the value is derived from the prompt record's `uuid`,
 *    so the poller reading the same finished turn twice writes one row. That is
 *    what this is for.
 *  - **"render me as Markdown"** — that is what the list above means, and a user
 *    row must not join it. The operator's own text has always been drawn
 *    verbatim (`whitespace-pre-wrap`), and a prompt that happens to contain
 *    `# ` or a `|` table row would change shape the moment it were rendered.
 *    `ConversationPairCard` is untouched by #2196 precisely because this prefix
 *    is absent from that list.
 *
 * `claude-prompt:` and not a second use of `claude-turn:`: the assistant row for
 * the same turn is keyed on the *same* `uuid`, so sharing the prefix would make
 * the two rows collide on `findMessageByRequestId` and the second writer would
 * read "already saved" and stand down.
 */
export const CLAUDE_PROMPT_REQUEST_ID_PREFIX = 'claude-prompt:';

/**
 * The same, for a turn read out of codex's rollout JSONL (Issue #2197).
 *
 * A third namespace for the third reader, for the reason
 * {@link CLAUDE_MARKDOWN_REQUEST_ID_PREFIX} gives: the value is an idempotency
 * key as well as a marker, and codex names its turns with a `turn_id` of its
 * own minting. Sharing a prefix with claude would make a collision between two
 * tools' ids read as "already saved", which is the one failure a key must not
 * have.
 */
export const CODEX_MARKDOWN_REQUEST_ID_PREFIX = 'codex-turn:';

/**
 * Prefix on a **user** row whose text was read out of codex's rollout JSONL
 * (Issue #2197).
 *
 * Deliberately absent from {@link AGENT_MARKDOWN_REQUEST_ID_PREFIXES}, for the
 * whole of the reason {@link CLAUDE_PROMPT_REQUEST_ID_PREFIX} states: the
 * operator's own text is drawn verbatim and must not change shape because it
 * happened to contain a `#` or a `|`.
 *
 * Unlike claude's, this one is **not** keyed on the same id as the turn's
 * assistant row. codex folds a prompt sent while a turn is running into that
 * same turn — measured on 23 of 326 turns in the corpus this Issue read — so a
 * turn can carry more than one operator message, and keying the user row on the
 * `turn_id` would collapse them into one row and then refuse the second as
 * already recorded. The key is the **`UserMessage` item's own id** instead, so
 * one prompt is one row however many share a turn. See {@link codexPromptRequestId}.
 */
export const CODEX_PROMPT_REQUEST_ID_PREFIX = 'codex-prompt:';

/**
 * The same, for a turn read out of antigravity's transcript JSONL (Issue #2198).
 *
 * A fourth namespace for the fourth reader, for the reason
 * {@link CLAUDE_MARKDOWN_REQUEST_ID_PREFIX} gives: the value is an idempotency
 * key as well as a marker, and antigravity names its turns with a number —
 * `step_index` — that is only unique *inside one conversation*. Sharing a prefix
 * with another tool would make a collision between two tools' ids read as
 * "already saved", which is the one failure a key must not have; and the id
 * therefore has to carry the conversation as well as the step. See
 * {@link antigravityTurnRequestId}.
 */
export const ANTIGRAVITY_MARKDOWN_REQUEST_ID_PREFIX = 'antigravity-turn:';

/**
 * Prefix on a **user** row whose text was read out of antigravity's transcript
 * JSONL (Issue #2198).
 *
 * Deliberately absent from {@link AGENT_MARKDOWN_REQUEST_ID_PREFIXES}, for the
 * whole of the reason {@link CLAUDE_PROMPT_REQUEST_ID_PREFIX} states: the
 * operator's own text is drawn verbatim and must not change shape because it
 * happened to contain a `#` or a `|`.
 *
 * Keyed on the same `(conversationId, stepIndex)` pair as the turn's assistant
 * row, which is claude's arrangement rather than codex's. It is the right one
 * here because agy opens a turn with exactly one `USER_INPUT` record — 63 of 63
 * in the corpus #2198 measured — so a turn never carries a second prompt the way
 * a codex turn can.
 */
export const ANTIGRAVITY_PROMPT_REQUEST_ID_PREFIX = 'antigravity-prompt:';

/**
 * The same, for a turn read out of Command Code's transcript JSONL (Issue #2252).
 *
 * A fifth namespace for the fifth reader, for the reason
 * {@link CLAUDE_MARKDOWN_REQUEST_ID_PREFIX} gives: the value is an idempotency
 * key as well as a marker, and Command Code names its records with an **8-hex
 * short id of its own minting** (`cb06ab09`), which is a far smaller space than
 * claude's uuids. Sharing a prefix with claude would therefore not merely be
 * untidy — a `command-code` id is exactly the shape a claude uuid's first
 * segment has, and a collision between two tools' ids reads as "already saved",
 * which is the one failure a key must not have.
 *
 * `command-code-` and not `cc-`: the string is what an operator reads in the row
 * when they ask why History shows Markdown, and the tool id is what they will
 * search the codebase for.
 */
export const COMMAND_CODE_MARKDOWN_REQUEST_ID_PREFIX = 'command-code-turn:';

/**
 * Prefix on a **user** row whose text was read out of Command Code's transcript
 * JSONL (Issue #2252).
 *
 * Deliberately absent from {@link AGENT_MARKDOWN_REQUEST_ID_PREFIXES}, for the
 * whole of the reason {@link CLAUDE_PROMPT_REQUEST_ID_PREFIX} states: the
 * operator's own text is drawn verbatim and must not change shape because it
 * happened to contain a `#` or a `|`.
 *
 * Keyed on the same record id as the turn's assistant row, which is claude's
 * arrangement rather than codex's. It is the right one here because Command
 * Code opens a turn with exactly one fresh `role: "user"` record — its own
 * `isFreshUserTurn` is `role === 'user' && no tool_result block`, and a prompt
 * typed while a turn is running is appended as a `meta.source: "steering"`
 * record that opens a turn of its own rather than joining the one in flight.
 */
export const COMMAND_CODE_PROMPT_REQUEST_ID_PREFIX = 'command-code-prompt:';

/**
 * Every prefix that means "this row holds source, not a rendering".
 *
 * One list rather than a chain of `startsWith` calls, so that adding the third
 * tool is adding a constant here and nothing at the reader. The reader
 * (`ConversationPairCard`) has never named a prefix and still does not — which
 * is what let Issue #2121 put Claude's rows on the Markdown path without
 * touching the component (#2121 受入条件).
 */
export const AGENT_MARKDOWN_REQUEST_ID_PREFIXES: readonly string[] = [
  AGENT_MARKDOWN_REQUEST_ID_PREFIX,
  CLAUDE_MARKDOWN_REQUEST_ID_PREFIX,
  CODEX_MARKDOWN_REQUEST_ID_PREFIX,
  ANTIGRAVITY_MARKDOWN_REQUEST_ID_PREFIX,
  COMMAND_CODE_MARKDOWN_REQUEST_ID_PREFIX,
];

/**
 * Whether this row's `content` may be rendered as Markdown.
 *
 * Conservative by construction: an absent or unrecognised `requestId` answers
 * false, which is the pre-#2041 rendering. Nothing is ever *upgraded* to
 * Markdown by guessing at its content — in particular the `requestId` the
 * scraper has always written for Claude (`req_…`, from `parseClaudeOutput`)
 * matches no prefix and keeps its verbatim rendering.
 *
 * @param requestId - `ChatMessage.requestId`, which is usually absent
 */
export function isAgentAuthoredMarkdown(requestId: string | undefined | null): boolean {
  if (typeof requestId !== 'string') return false;
  return AGENT_MARKDOWN_REQUEST_ID_PREFIXES.some((prefix) => requestId.startsWith(prefix));
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

/**
 * The row id for one Claude Code turn (Issue #2121).
 *
 * The turn is named by the **prompt record it answers** — the `uuid` of the
 * `type: "user"` line the operator's own text arrived on. Deliberately not the
 * assistant record's `uuid` and not its `requestId`, because neither is one per
 * turn: a live transcript sampled while a single prompt was still being
 * answered (2026-08-31) already held **55 assistant records across 23 distinct
 * `requestId`s**, so keying on either would have split one reply into dozens of
 * History rows. The Issue measured the finished shape: 98 assistant records
 * against the single `chat_messages` row the poller wrote.
 *
 * @param promptUuid - `uuid` of the user record that opened the turn
 */
export function claudeTurnRequestId(promptUuid: string): string {
  return `${CLAUDE_MARKDOWN_REQUEST_ID_PREFIX}${promptUuid}`;
}

/**
 * The row id for the **prompt** that opened one Claude Code turn (Issue #2196).
 *
 * Same `uuid`, different prefix, and therefore a different row: the turn's
 * assistant row is {@link claudeTurnRequestId} of this same value. One `uuid`
 * names one turn, and a turn is a user row plus an assistant row, so keying both
 * on the record that opened it is what makes the pair reconstructible from the
 * transcript alone — including on a re-read, where both halves must resolve to
 * "already there" independently.
 *
 * @param promptUuid - `uuid` of the user record the operator's text arrived on
 */
export function claudePromptRequestId(promptUuid: string): string {
  return `${CLAUDE_PROMPT_REQUEST_ID_PREFIX}${promptUuid}`;
}

/**
 * The row id for one codex turn (Issue #2197).
 *
 * The turn is named by codex's own **`turn_id`**, which it stamps on
 * `task_started`, on every `item_completed`, on `turn_context` and on
 * `task_complete` — one value for everything one prompt produced. That is a
 * stronger key than claude's equivalent rather than an analogous one: claude
 * has to infer the boundary from record order because nothing in its transcript
 * links a reply to its prompt, while codex writes the boundary down.
 *
 * Measured on codex-cli 0.151.0 and on 326 turns of the archived corpus
 * (`docs/design/codex-transcript-reader.md` §2): every turn carried exactly one
 * `turn_id`, and every one of the 326 was closed by a `task_complete` bearing
 * it.
 *
 * @param turnId - `turn_id`, as codex writes it
 */
export function codexTurnRequestId(turnId: string): string {
  return `${CODEX_MARKDOWN_REQUEST_ID_PREFIX}${turnId}`;
}

/**
 * The row id for one **prompt** inside a codex turn (Issue #2197).
 *
 * The `UserMessage` item's own id, not the `turn_id` — see
 * {@link CODEX_PROMPT_REQUEST_ID_PREFIX} for the measurement that forces the
 * distinction.
 *
 * @param promptItemId - `item.id` of the `UserMessage` the text arrived on
 */
export function codexPromptRequestId(promptItemId: string): string {
  return `${CODEX_PROMPT_REQUEST_ID_PREFIX}${promptItemId}`;
}

/**
 * The turn part of an antigravity row id (Issue #2198).
 *
 * `<conversationId>#<stepIndex>`, and both halves are load-bearing. antigravity
 * has no `turn_id` of codex's kind and no per-record uuid of claude's; what it
 * has is `step_index`, the primary key of the row in its own `steps` table. That
 * is unique inside one conversation — measured with no duplicate across all 41
 * transcripts and 1,024 records on the capture machine — and unique nowhere
 * else, so a bare `12` would collide with the twelfth step of every other
 * conversation the moment two agy instances shared a worktree.
 *
 * The `#` is a separator agy's own ids cannot contain: a conversation id is a
 * uuid and a step index is a non-negative integer.
 *
 * @param conversationId - `conversationId`, as every agy hook payload carries it
 * @param stepIndex - `step_index` of the `USER_INPUT` record that opened the turn
 */
function antigravityTurnKey(conversationId: string, stepIndex: number): string {
  return `${conversationId}#${stepIndex}`;
}

/**
 * The row id for one antigravity turn (Issue #2198).
 *
 * The turn is named by the **prompt record it answers** — the `step_index` of
 * the `USER_EXPLICIT` / `USER_INPUT` line the operator's text arrived on. That
 * is claude's arrangement (#2121) rather than codex's, because agy writes
 * nothing that closes a turn and nothing that links a reply back to its prompt;
 * what opens the turn is the only boundary in the file.
 *
 * @param conversationId - The conversation the turn was read from
 * @param stepIndex - `step_index` of the record that opened the turn
 */
export function antigravityTurnRequestId(conversationId: string, stepIndex: number): string {
  return `${ANTIGRAVITY_MARKDOWN_REQUEST_ID_PREFIX}${antigravityTurnKey(conversationId, stepIndex)}`;
}

/**
 * The row id for the **prompt** that opened one antigravity turn (Issue #2198).
 *
 * Same pair, different prefix, and therefore a different row — exactly the
 * relationship {@link claudePromptRequestId} has with {@link claudeTurnRequestId},
 * and for the same reason: one prompt record names one turn, and a turn is a
 * user row plus an assistant row, so keying both on the record that opened it is
 * what makes the pair reconstructible from the transcript alone.
 *
 * @param conversationId - The conversation the turn was read from
 * @param stepIndex - `step_index` of the record the operator's text arrived on
 */
export function antigravityPromptRequestId(conversationId: string, stepIndex: number): string {
  return `${ANTIGRAVITY_PROMPT_REQUEST_ID_PREFIX}${antigravityTurnKey(conversationId, stepIndex)}`;
}

/**
 * The row id for one Command Code turn (Issue #2252).
 *
 * The turn is named by the **prompt record it answers** — the `id` of the fresh
 * `role: "user"` record the operator's text arrived on. That is claude's
 * arrangement (#2121) and antigravity's (#2198) rather than codex's, because
 * Command Code writes nothing that closes a turn and nothing that links a reply
 * back to its prompt: `parentId` chains one record to the previous one in file
 * order, not a reply to its question, so what opens the turn is the only
 * boundary in the file.
 *
 * Deliberately not the assistant record's own `id`: one turn produces one
 * assistant record per round of the agent loop — the captured two-tool turn has
 * two — and keying on those would split one reply into several History rows.
 *
 * @param promptId - `id` of the user record that opened the turn
 */
export function commandCodeTurnRequestId(promptId: string): string {
  return `${COMMAND_CODE_MARKDOWN_REQUEST_ID_PREFIX}${promptId}`;
}

/**
 * The row id for the **prompt** that opened one Command Code turn (Issue #2252).
 *
 * Same `id`, different prefix, and therefore a different row — exactly the
 * relationship {@link claudePromptRequestId} has with {@link claudeTurnRequestId},
 * and for the same reason: one record names one turn, and a turn is a user row
 * plus an assistant row, so keying both on the record that opened it is what
 * makes the pair reconstructible from the transcript alone, including on a
 * re-read where both halves must resolve to "already there" independently.
 *
 * @param promptId - `id` of the user record the operator's text arrived on
 */
export function commandCodePromptRequestId(promptId: string): string {
  return `${COMMAND_CODE_PROMPT_REQUEST_ID_PREFIX}${promptId}`;
}
