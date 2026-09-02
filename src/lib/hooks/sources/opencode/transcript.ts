/**
 * Turning opencode's part stream back into the reply the agent wrote (Issue
 * #2041).
 *
 * CommandMate's conversation history has always been a screen scrape. For the
 * five tools that only have a terminal that is the only option; for opencode it
 * is a choice, and a bad one — the pane is 200 columns wide, the agent's
 * paragraphs are not, and everything the TUI does to fit them (hard wraps, the
 * `┃ ` gutter, `…` on a long tool line) has to be guessed back out again
 * afterwards. `cleanOpenCodeResponse` is that guess, and #1911 is the list of
 * ways it was wrong.
 *
 * The server hands over the same text unwrapped, so this module accumulates it
 * and `./history` writes it.
 *
 * ## What was measured, and where the Issue text is out of date
 *
 * Against opencode **1.18.22** in an isolated `HOME` (the §4 harness), three
 * turns, 142 frames — see `docs/design/opencode-server-live-verification.md`
 * §13. Four findings shape the code below and none of them are in the Issue:
 *
 *  1. **A text part arrives twice, not incrementally.** `message.part.updated`
 *     is emitted once with `text: ""` when the part opens and once with the
 *     **whole** text when it closes. The characters in between travel on
 *     `message.part.delta`, an event the 1.18.3 fixtures do not contain at all.
 *     So this module takes the text from `message.part.updated` and ignores
 *     every delta — which makes it idempotent by construction rather than by a
 *     dedup set, and that is the whole answer to "the boundary frames are
 *     re-sent byte-identically": a repeat writes the same string into the same
 *     slot.
 *  2. **Deltas cannot be deduplicated by content.** Measured: `","` and `"."`
 *     each arrived twice with byte-identical payloads, and the concatenation of
 *     all 88 deltas equalled the final part text exactly — so both were real
 *     content, not re-sends. Accumulating deltas and dropping the repeats would
 *     have silently deleted two characters from a 967-character paragraph.
 *  3. **One turn can be several assistant messages.** The tool-calling turn
 *     produced `finish: "tool-calls"` on one message and `finish: "stop"` on the
 *     next. Both carry the same `parentID`, so the *turn* is keyed on that —
 *     see {@link OPENCODE_TURN_KEY_FIELD}.
 *  4. **`step-start` / `step-finish` are parts too**, and so are seven other
 *     variants the server's own OpenAPI declares (`subtask`, `patch`, `agent`,
 *     `retry`, `compaction`, `snapshot`, `file`). Anything not understood is
 *     skipped rather than stringified.
 *
 * ## Pure on purpose
 *
 * No database, no `fetch`, no `globalThis`. The accumulator is handed in by the
 * caller, so the SSE path and the `GET /session/:id/message` backfill run the
 * *same* renderer over the same shape and cannot drift — which is what makes
 * "the saved body equals the server's text" a property the tests can assert
 * rather than a claim.
 *
 * @module lib/hooks/sources/opencode/transcript
 */

import { isPlainObject, readNestedString, readStringField } from '../event-mapper';
import { separateTurnBody, type TurnRenderBlock } from '../turn-body';

/**
 * The field that groups assistant messages into one turn.
 *
 * Named once so the SSE reader and the REST reader cannot pick different ones.
 */
export const OPENCODE_TURN_KEY_FIELD = 'parentID';

/**
 * Cap on parts kept for one turn.
 *
 * A turn is bounded by the model's own output, but the accumulator is fed from
 * a server CommandMate did not start and whose `opencode.db` is shared with
 * every other TUI on the same HOME and project (#1758 §5.6.3). The overflow is
 * logged by the caller rather than dropped in silence, the same treatment
 * `MAX_RESYNCED_DECISIONS` gets.
 */
export const MAX_OPENCODE_TURN_PARTS = 512;

/**
 * Longest body written for one turn.
 *
 * `chat_messages.content` has no length limit and the browser renders whatever
 * is in it, so the bound is the reader's, not the column's. Ten times
 * `COPILOT_MAX_MESSAGE_LENGTH` because this text has not been through a 200-
 * column pane first: the measured 967-character paragraph is one line here and
 * would have been six on screen.
 */
export const MAX_OPENCODE_TURN_BODY_LENGTH = 200_000;

/** Appended when {@link MAX_OPENCODE_TURN_BODY_LENGTH} truncates a turn. */
export const OPENCODE_TURN_TRUNCATION_MARKER = '\n\n_(truncated)_';

/** One part of one assistant message, in the order the server produced it. */
export interface OpencodeTranscriptPart {
  /** `prt_…`. The slot a repeat overwrites. */
  readonly id: string;
  /** `msg_…` of the assistant message this part belongs to. */
  readonly messageId: string;
  /** `text` / `reasoning` / `tool` / … verbatim from `part.type`. */
  readonly type: string;
  /** `part.text` for text and reasoning parts; null otherwise. */
  readonly text: string | null;
  /** `part.tool` for tool parts (`bash`, `read`, …); null otherwise. */
  readonly tool: string | null;
  /** `part.state.status` for tool parts; null otherwise. */
  readonly status: string | null;
  /** `part.state.title` — opencode's own one-line summary of the call. */
  readonly title: string | null;
  /** `part.state.error` on a failed tool call; null otherwise. */
  readonly error: string | null;
}

/** One turn: everything the agent produced in reply to one prompt. */
export interface OpencodeTurnAccumulator {
  /** `ses_…`. */
  readonly sessionId: string;
  /** `msg_…` of the **user** message; the turn's identity. */
  readonly userMessageId: string;
  /**
   * Parts by `prt_…`, in first-seen order.
   *
   * A `Map` rather than an array because insertion order is what the renderer
   * walks and the key is what makes a re-sent frame a no-op. Both properties
   * are load-bearing; an array with a linear scan would give the second and
   * lose the first the moment a part opened out of order.
   */
  readonly parts: Map<string, OpencodeTranscriptPart>;
  /**
   * The assistant messages this turn is made of (`msg_…`).
   *
   * The membership test a part has to pass, and the reason it exists is a
   * measured ordering this deliberately does not lean on: the user's own text
   * part arrives on the same stream, and in all three captured turns it arrived
   * *before* the assistant `message.updated` that opens the turn — so it lands
   * on no accumulator and is dropped. Were that order ever to swap, the prompt
   * would be prepended to the reply that answers it. Checking ownership makes
   * the outcome a property of the data instead of a property of the timing.
   */
  readonly assistantMessageIds: Set<string>;
  /** Epoch ms of the first frame, so the row is dated by the agent's clock. */
  readonly startedAt: number;
  /** True once a part had to be dropped for {@link MAX_OPENCODE_TURN_PARTS}. */
  overflowed: boolean;
}

/** A brand-new accumulator for one turn. */
export function createOpencodeTurn(
  sessionId: string,
  userMessageId: string,
  startedAt: number
): OpencodeTurnAccumulator {
  return {
    sessionId,
    userMessageId,
    parts: new Map(),
    assistantMessageIds: new Set(),
    startedAt,
    overflowed: false,
  };
}

/**
 * Note that an assistant message belongs to this turn.
 *
 * Called for every `message.updated` with `role: "assistant"` and this turn's
 * `parentID` — which is three frames per message on 1.18.22 (measured), all
 * idempotent here.
 */
export function claimOpencodeMessage(turn: OpencodeTurnAccumulator, messageId: string): void {
  turn.assistantMessageIds.add(messageId);
}

/** Whether a part's `messageID` is one this turn has claimed. */
export function ownsOpencodeMessage(turn: OpencodeTurnAccumulator, messageId: string): boolean {
  return turn.assistantMessageIds.has(messageId);
}

/**
 * Read one `message.part.updated` frame's `part`, or the same object as it
 * appears inside `GET /session/:id/message`.
 *
 * The two shapes are the same object — measured: the `part` nested in the frame
 * and the entry in the REST body's `parts` array are byte-identical for every
 * part in the three-turn capture. That is why one reader serves both.
 *
 * @param part - `properties.part`, or one element of `message.parts`
 * @returns The part, or null when it carries no id / messageID
 */
export function readOpencodePart(part: unknown): OpencodeTranscriptPart | null {
  if (!isPlainObject(part)) return null;
  const id = readStringField(part, 'id');
  const messageId = readStringField(part, 'messageID');
  const type = readStringField(part, 'type');
  if (!id || !messageId || !type) return null;

  const state = isPlainObject(part.state) ? part.state : null;
  return {
    id,
    messageId,
    type,
    text: typeof part.text === 'string' ? part.text : null,
    tool: readStringField(part, 'tool'),
    status: state ? readStringField(state, 'status') : null,
    title: state ? readStringField(state, 'title') : null,
    // `state.error` is a plain string on a rejected approval (the `message` the
    // REST reply carried, echoed back — see the `…-tool-error.json` fixture),
    // but the schema allows an object, so the nested `message` is tried too.
    error: state
      ? (readStringField(state, 'error') ?? readNestedString(state, ['error', 'message']))
      : null,
  };
}

/**
 * Put one part into a turn, overwriting whatever was in its slot.
 *
 * Last write wins, and that is the idempotency: the empty `text: ""` frame that
 * opens a part is replaced by the complete one that closes it, and a re-sent
 * copy of either writes the value that is already there.
 *
 * @returns False when the part was dropped for {@link MAX_OPENCODE_TURN_PARTS}
 */
export function addOpencodePart(
  turn: OpencodeTurnAccumulator,
  part: OpencodeTranscriptPart
): boolean {
  if (!turn.parts.has(part.id) && turn.parts.size >= MAX_OPENCODE_TURN_PARTS) {
    turn.overflowed = true;
    return false;
  }
  turn.parts.set(part.id, part);
  return true;
}

/**
 * The part types that carry nothing a reader wants.
 *
 * From 1.18.22's own `GET /doc`: `Part` is a union of twelve variants and only
 * three of them say anything about the reply. The rest are bookkeeping —
 * `step-start` / `step-finish` bracket a provider round trip, `snapshot` names a
 * git object, `patch` names a hash. Listed as a deny set rather than the three
 * as an allow set so a variant added by a later opencode shows up in the
 * unknown-part log instead of being silently equivalent to `step-start`.
 */
const OPENCODE_SILENT_PART_TYPES: ReadonlySet<string> = new Set([
  'step-start',
  'step-finish',
  'snapshot',
  'patch',
]);

/** The label a reasoning block is folded behind. */
export const OPENCODE_REASONING_LABEL = 'Thinking';

/**
 * One tool call as a single Markdown line.
 *
 * `state.title` is opencode's own one-liner for the call — the string its TUI
 * puts on the tool row — so this reproduces what the operator saw rather than
 * inventing a description from the input. Measured: `"echo
 * CMATE-2041-TOOL-MARKER"` for the `bash` call in turn 2.
 *
 * The output is deliberately **not** included. It is already in the reply the
 * agent wrote about it ("It printed `CMATE-2041-TOOL-MARKER`."), it can be
 * megabytes, and the Issue asks for a summary line.
 */
function renderToolPart(part: OpencodeTranscriptPart): string {
  const name = part.tool ?? 'tool';
  const detail = part.title ?? null;
  const failed = part.status === 'error';
  const head = `- \`${name}\`${detail ? ` — ${collapseToLine(detail)}` : ''}`;
  if (!failed) return head;
  return part.error ? `${head} _(error: ${collapseToLine(part.error)})_` : `${head} _(error)_`;
}

/**
 * A tool title on one line.
 *
 * A `bash` title is the command, and a heredoc puts newlines in it. Left alone
 * they would end the list item and turn the rest of the command into body text.
 */
function collapseToLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Reasoning, folded.
 *
 * A blockquote rather than `<details>`, and the reason is a rendering decision
 * that belongs here because it decides what is *stored*: showing `<details>`
 * would mean running `rehype-raw` over agent output in `ConversationPairCard`,
 * and that costs every unfenced `<T>` in ordinary prose — the HTML parser eats
 * it as a tag. A blockquote is Markdown's own way of saying "subordinate", it
 * survives the sanitiser with no raw-HTML pass, and the card's existing
 * two-line collapse already keeps it out of the way.
 */
function renderReasoningPart(text: string): string {
  const quoted = text
    .trim()
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
  return `> **${OPENCODE_REASONING_LABEL}**\n>\n${quoted}`;
}

/** What one rendered turn is. */
export interface OpencodeRenderedTurn {
  /** `ses_…`. */
  readonly sessionId: string;
  /** `msg_…` of the user message; the row's identity. */
  readonly userMessageId: string;
  /** The Markdown body, or an empty string when the turn said nothing. */
  readonly body: string;
  /** How many text parts contributed. */
  readonly textParts: number;
  /** How many tool calls were summarised. */
  readonly toolParts: number;
  /** Part types that were neither rendered nor on the silent list. */
  readonly unknownPartTypes: readonly string[];
}

/**
 * Render one turn to Markdown.
 *
 * Stream order within each kind — reasoning sits where the agent thought it and
 * the calls are in the order they were made. #2041 kept one stream for all of
 * them and #2234 split the tool calls out into a section of their own; the
 * layout is `../turn-body`'s, shared with the other three readers, and
 * {@link separateTurnBody} carries the reasoning for both halves of that.
 *
 * @param turn - The accumulator, live or rebuilt from REST
 */
export function renderOpencodeTurn(turn: OpencodeTurnAccumulator): OpencodeRenderedTurn {
  const blocks: TurnRenderBlock[] = [];
  const unknown = new Set<string>();
  let textParts = 0;
  let toolParts = 0;

  for (const part of turn.parts.values()) {
    if (part.type === 'text') {
      // The empty frame that opens a part, or a part the agent produced and
      // then emptied. Counted as nothing rather than as a blank paragraph.
      const text = part.text?.trim() ?? '';
      if (text.length === 0) continue;
      blocks.push({ kind: 'prose', text });
      textParts += 1;
      continue;
    }
    if (part.type === 'reasoning') {
      const text = part.text?.trim() ?? '';
      if (text.length === 0) continue;
      blocks.push({ kind: 'aside', text: renderReasoningPart(text) });
      continue;
    }
    if (part.type === 'tool') {
      // Only the settled states. A `pending` / `running` part is the same call
      // as the `completed` one that overwrites it, and a turn that ended while
      // a call was still running has nothing to summarise but its name.
      if (part.status === 'pending') continue;
      blocks.push({ kind: 'tool', text: renderToolPart(part) });
      toolParts += 1;
      continue;
    }
    if (!OPENCODE_SILENT_PART_TYPES.has(part.type)) unknown.add(part.type);
  }

  let body = separateTurnBody(blocks).body;
  if (body.length > MAX_OPENCODE_TURN_BODY_LENGTH) {
    body =
      body.slice(0, MAX_OPENCODE_TURN_BODY_LENGTH - OPENCODE_TURN_TRUNCATION_MARKER.length) +
      OPENCODE_TURN_TRUNCATION_MARKER;
  }

  return {
    sessionId: turn.sessionId,
    userMessageId: turn.userMessageId,
    body,
    textParts,
    toolParts,
    unknownPartTypes: [...unknown],
  };
}


/**
 * Rebuild every turn of a session from `GET /session/:id/message`.
 *
 * The restart path. A `message.part.updated` is gone the moment it is delivered
 * — measured: a fresh subscription to `/event` replays **nothing**, one
 * `server.connected` frame and then silence — so a CommandMate that was down
 * while a turn ran has no way to reconstruct it from the stream, and this is
 * the only route to the text.
 *
 * Assistant messages are grouped by `parentID`, which is the same key the live
 * path uses, so a turn saved from the stream and the same turn rebuilt from
 * REST produce the same `request_id` and the second one is a no-op.
 *
 * A message with no `parentID` is skipped rather than guessed at: it is either
 * the user's own message (no parent by definition) or an assistant message from
 * a shape this reader has not seen, and inventing a turn key for it would
 * create a row that no later run can match.
 *
 * @param body - The parsed `GET /session/:id/message` array
 * @param sessionId - `ses_…`, for the returned turns
 */
export function buildOpencodeTurnsFromMessages(
  body: unknown,
  sessionId: string
): OpencodeTurnAccumulator[] {
  if (!Array.isArray(body)) return [];

  const turns = new Map<string, OpencodeTurnAccumulator>();
  for (const entry of body) {
    if (!isPlainObject(entry)) continue;
    const info = isPlainObject(entry.info) ? entry.info : null;
    if (!info || info.role !== 'assistant') continue;

    const userMessageId = readStringField(info, OPENCODE_TURN_KEY_FIELD);
    if (!userMessageId) continue;

    const createdAt = readNumberField(info, ['time', 'created']) ?? 0;
    let turn = turns.get(userMessageId);
    if (!turn) {
      turn = createOpencodeTurn(sessionId, userMessageId, createdAt);
      turns.set(userMessageId, turn);
    }

    const messageId = readStringField(info, 'id');
    if (messageId) claimOpencodeMessage(turn, messageId);

    for (const rawPart of Array.isArray(entry.parts) ? entry.parts : []) {
      const part = readOpencodePart(rawPart);
      // The REST body nests parts under their own message, so ownership is not
      // in question here — it is asserted anyway so the two routes cannot
      // disagree about what a turn is allowed to contain.
      if (part && ownsOpencodeMessage(turn, part.messageId)) addOpencodePart(turn, part);
    }
  }

  return [...turns.values()];
}

/** A finite number at a nested path, or null. */
function readNumberField(source: Record<string, unknown>, path: readonly string[]): number | null {
  let cursor: unknown = source;
  for (const key of path) {
    if (!isPlainObject(cursor)) return null;
    cursor = cursor[key];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : null;
}
