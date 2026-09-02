/**
 * Turning codex's rollout JSONL back into the reply the agent wrote
 * (Issue #2197).
 *
 * The third of these readers, after `../opencode/transcript` (#2041, push) and
 * `../claude/transcript` (#2121, pull). Same job, same reason: the poller can
 * only ever save a *rendering* of the reply — the agent's Markdown after its TUI
 * has wrapped it to the pane width, drawn `•` bullets in front of it and run a
 * spinner through it — while the agent itself writes the source down as it goes.
 *
 * ## Two parallel streams in one file, and why only one is read
 *
 * A rollout file is a sequence of `{ordinal, timestamp, type, payload}` lines,
 * and it holds the same conversation **twice**:
 *
 *  - `type: "response_item"` — what was sent to the model. `message` records
 *    with `role: developer | user | assistant`, `reasoning` records whose text
 *    is encrypted, `custom_tool_call` / `custom_tool_call_output` pairs.
 *  - `type: "event_msg"` with `payload.type: "item_completed"` — what the TUI
 *    displayed. One `item` per line: `UserMessage`, `AgentMessage`,
 *    `CommandExecution`, `FileChange`, `McpToolCall`, `Reasoning`, …
 *
 * Only the second is read, and that is the load-bearing decision of this module.
 * Three measurements force it (`docs/design/codex-transcript-reader.md` §2,
 * against codex-cli 0.151.0 live and 250 archived sessions on 0.142.0…0.151.0):
 *
 *  1. **`role: "user"` is mostly not the user.** The `response_item` stream
 *     carries `<environment_context>`, `<recommended_plugins>` and the AGENTS.md
 *     instructions as `role: "user"` records. The item stream carries none of
 *     them: a `UserMessage` item is emitted for the operator's own text and for
 *     nothing else. That is positive evidence rather than a deny list, which is
 *     the discipline #2196 settled on for the same question on claude.
 *  2. **The item stream is the only one with readable tool calls.**
 *     `custom_tool_call.input` is a JavaScript snippet
 *     (`const r = await tools.exec_command({...})`); the `CommandExecution` item
 *     carries the argv and a `parsed_cmd` with the shell line in it.
 *  3. **`content_item_kinds` — the field that marks a `response_item` as the
 *     operator's — does not exist before 0.151.0.** It is absent on 0.149.1,
 *     where the injected and the real `role: "user"` records are otherwise
 *     identical. A reader built on it would have gone quietly wrong one version
 *     back.
 *
 * `response_item` lines are therefore counted as duplicates of the item stream
 * and dropped, not reported as unknown. See {@link CodexTurnBuild}.
 *
 * ## The turn boundary is written down
 *
 * codex stamps a `turn_id` on `task_started`, on every `item_completed`, on
 * `turn_context` and on `task_complete`. This is the one place codex is easier
 * to read than claude, which has no link at all from a reply to the prompt it
 * answers and has to infer the boundary from record order (#2121). Here the
 * boundary is a field, and a turn is closed by the `task_complete` that carries
 * its id — measured on 326 of 326 archived turns.
 *
 * ## Pure on purpose
 *
 * No filesystem, no database, no `globalThis` — `./history` owns all three, the
 * same split the other two readers use, so "the saved body equals the
 * transcript's text" is a property a test asserts against a fixture rather than
 * a claim.
 *
 * @module lib/hooks/sources/codex/transcript
 */

import { isPlainObject, readStringField } from '../event-mapper';
import { separateTurnBody, type TurnRenderBlock } from '../turn-body';

/** `$CODEX_HOME/sessions` — where codex keeps one machine's rollout files. */
export const CODEX_SESSIONS_DIR_SEGMENTS: readonly string[] = ['sessions'];

/** `.jsonl`; the only extension this reader will open. */
export const CODEX_ROLLOUT_EXTENSION = '.jsonl';

/** Longest body written for one turn. Same bound and reason as claude's. */
export const MAX_CODEX_TURN_BODY_LENGTH = 200_000;

/** Appended when {@link MAX_CODEX_TURN_BODY_LENGTH} truncates a turn. */
export const CODEX_TURN_TRUNCATION_MARKER = '\n\n_(truncated)_';

/**
 * Cap on items kept for one turn.
 *
 * The same 2048 claude's reader uses, and generous for the same reason: a codex
 * turn on the archived corpus ran to 46 `Reasoning` items and 25
 * `CommandExecution`s, and the overflow is reported rather than hidden.
 */
export const MAX_CODEX_TURN_ITEMS = 2048;

/** Longest tool detail put on a summary line. */
export const MAX_CODEX_TOOL_DETAIL_LENGTH = 200;

/** The label a reasoning summary is folded behind. Same word claude uses. */
export const CODEX_THINKING_LABEL = 'Thinking';

/** One `item_completed` item, reduced to what a reader needs. */
export interface CodexRolloutItem {
  /** `UserMessage` / `AgentMessage` / `CommandExecution` / … verbatim. */
  readonly type: string;
  /** `item.id`; the key a prompt row is named with. Null when absent. */
  readonly id: string | null;
  /**
   * The item's own prose, already joined.
   *
   * `content[].text` for `UserMessage` and `AgentMessage`, `summary_text` for
   * `Reasoning`. Null for every item that carries none.
   */
  readonly text: string | null;
  /** `commentary` / `final_answer` on an `AgentMessage`; null otherwise. */
  readonly phase: string | null;
  /** The one-line summary of a tool item; null when it has none. */
  readonly detail: string | null;
}

/** One line of the rollout, reduced to what a reader needs. */
export interface CodexRolloutRecord {
  /** `session_meta` / `event_msg` / `response_item` / `turn_context` / …. */
  readonly type: string;
  /** `payload.type` — `item_completed`, `task_started`, `message`, …, or null. */
  readonly payloadType: string | null;
  /** `turn_id`, which every record inside a turn carries. */
  readonly turnId: string | null;
  /** `session_id` — on `session_meta` only; `thread_id` elsewhere. */
  readonly sessionId: string | null;
  /** `timestamp` as epoch ms, or null when absent or unparseable. */
  readonly timestampMs: number | null;
  /** The `item_completed` item, or null for every other record. */
  readonly item: CodexRolloutItem | null;
}

/** One operator prompt, as the rollout recorded it. */
export interface CodexPrompt {
  /** `UserMessage` item id; the row key. See `codexPromptRequestId`. */
  readonly itemId: string;
  /** The text the operator typed. */
  readonly text: string;
  /** When codex recorded it, epoch ms. */
  readonly timestampMs: number;
}

/** One turn: everything one `turn_id` produced. */
export interface CodexTurnAccumulator {
  /** The session the turn was read from. */
  readonly sessionId: string;
  /** `turn_id`; the turn's identity. */
  readonly turnId: string;
  /** Epoch ms of the first record bearing this id. */
  startedAt: number;
  /**
   * The operator's own messages, in order.
   *
   * Usually one. Measured at more than one on 23 of 326 archived turns — codex
   * folds a prompt submitted while a turn is running into that same turn — which
   * is why each gets a row of its own keyed on its item id.
   */
  readonly prompts: CodexPrompt[];
  /** Everything else the turn produced, in the order codex displayed it. */
  readonly items: CodexRolloutItem[];
  /** True once `task_complete` for this `turn_id` was seen. */
  closed: boolean;
  /** True once an item had to be dropped for {@link MAX_CODEX_TURN_ITEMS}. */
  overflowed: boolean;
}

/** What one rendered turn is. */
export interface CodexRenderedTurn {
  readonly sessionId: string;
  readonly turnId: string;
  /** The Markdown body, or an empty string when the turn said nothing. */
  readonly body: string;
  /** How many `AgentMessage` items contributed prose. */
  readonly textBlocks: number;
  /** How many tool items were summarised. */
  readonly toolBlocks: number;
  /** Item types that were neither rendered nor on the silent list. */
  readonly unknownBlockTypes: readonly string[];
}

/** What one pass over a rollout's lines produced. */
export interface CodexRolloutParse {
  readonly records: readonly CodexRolloutRecord[];
  /**
   * Lines that were not valid JSON, or were JSON but not an object.
   *
   * Expected to be non-zero and harmless, for the reason `../claude/transcript`
   * gives: codex appends to this file while CommandMate reads it, so the last
   * line of a read taken mid-write is a fragment. Parsing is per line, and a
   * failure costs one record rather than the file.
   */
  readonly malformedLines: number;
}

/**
 * Read one `item_completed` item.
 *
 * @returns The item, or null when the value is not an object with a `type`
 */
export function readCodexRolloutItem(value: unknown): CodexRolloutItem | null {
  if (!isPlainObject(value)) return null;
  const type = readStringField(value, 'type');
  if (!type) return null;

  return {
    type,
    id: readStringField(value, 'id'),
    text: readItemText(type, value),
    phase: readStringField(value, 'phase'),
    detail: readItemDetail(type, value),
  };
}

/**
 * The prose an item carries, or null.
 *
 * Read per item type rather than by trying every text-shaped field on every
 * item, so that a later codex adding a `text` to a tool item does not silently
 * start rendering tool output as the agent's prose. `content` is a list of
 * `{type, text}` on both message items — spelled `"text"` on `UserMessage` and
 * `"Text"` on `AgentMessage`, which is why the element's own type is not
 * checked.
 */
function readItemText(type: string, item: Record<string, unknown>): string | null {
  if (type === 'UserMessage' || type === 'AgentMessage') {
    return joinContentText(item.content);
  }
  if (type === 'Reasoning') {
    // `summary_text` is a list of strings. Measured empty on 12,084 of 12,084
    // archived reasoning items — the summaries are not retained on this
    // account — so an empty one is skipped rather than rendered as a blank
    // quote, exactly as #2121 does for claude's empty `thinking` blocks.
    return joinStringList(item.summary_text);
  }
  return null;
}

/** Concatenate a `content` array's `text` fields. */
function joinContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  let out = '';
  for (const entry of content) {
    if (!isPlainObject(entry)) continue;
    const text = readStringField(entry, 'text');
    if (text) out += text;
  }
  return out.length > 0 ? out : null;
}

/** Join a list of strings, dropping anything that is not one. */
function joinStringList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * The one-line summary of a tool item, or null.
 *
 * One rule per measured item type. Every shape below was dumped off a real
 * rollout rather than read out of a schema — see the design doc's §2.3 table —
 * and an item type that is not here produces no detail, which is what puts it in
 * {@link CodexRenderedTurn.unknownBlockTypes} unless it is deliberately silent.
 */
function readItemDetail(type: string, item: Record<string, unknown>): string | null {
  if (type === 'CommandExecution') {
    // `parsed_cmd[0].cmd` is the shell line codex itself displays; `command` is
    // the argv it ran it with (`["/bin/zsh","-lc","<the line>"]`). Preferring
    // the parsed form keeps the summary readable, and the argv is the fallback
    // for a call codex could not parse.
    const parsed = readParsedCommand(item.parsed_cmd);
    if (parsed) return boundDetailText(collapseToLine(parsed));
    const argv = readArgv(item.command);
    return argv ? boundDetailText(collapseToLine(argv)) : null;
  }
  if (type === 'FileChange') {
    const changes = item.changes;
    if (!isPlainObject(changes)) return null;
    const paths = Object.keys(changes);
    return paths.length > 0 ? boundDetailText(paths.join(', ')) : null;
  }
  if (type === 'McpToolCall') {
    const server = readStringField(item, 'server');
    const tool = readStringField(item, 'tool');
    if (!server && !tool) return null;
    return boundDetailText([server, tool].filter(Boolean).join('.'));
  }
  if (type === 'ImageView') {
    const path = readStringField(item, 'path');
    return path ? boundDetailText(path) : null;
  }
  if (type === 'Extension') {
    const query = readStringField(item, 'query') ?? readStringField(item, 'action');
    return query ? boundDetailText(collapseToLine(query)) : null;
  }
  return null;
}

/** `parsed_cmd[].cmd`, joined. */
function readParsedCommand(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const cmd = readStringField(entry, 'cmd');
    if (cmd) parts.push(cmd);
  }
  return parts.length > 0 ? parts.join(' ; ') : null;
}

/** `command`, joined with spaces. */
function readArgv(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.filter((entry): entry is string => typeof entry === 'string');
  return parts.length > 0 ? parts.join(' ') : null;
}

/** A tool detail on one line. A heredoc puts newlines in a shell command. */
function collapseToLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function boundDetailText(value: string): string {
  return value.length <= MAX_CODEX_TOOL_DETAIL_LENGTH
    ? value
    : `${value.slice(0, MAX_CODEX_TOOL_DETAIL_LENGTH - 1)}…`;
}

/**
 * Read one parsed rollout line.
 *
 * @returns The record, or null when the value is not an object with a `type`
 */
export function readCodexRolloutRecord(value: unknown): CodexRolloutRecord | null {
  if (!isPlainObject(value)) return null;
  const type = readStringField(value, 'type');
  if (!type) return null;

  const payload = isPlainObject(value.payload) ? value.payload : null;
  const payloadType = payload ? readStringField(payload, 'type') : null;

  const timestamp = readStringField(value, 'timestamp');
  const parsed = timestamp ? Date.parse(timestamp) : NaN;

  return {
    type,
    payloadType,
    turnId: payload ? readStringField(payload, 'turn_id') : null,
    sessionId: payload
      ? (readStringField(payload, 'session_id') ?? readStringField(payload, 'thread_id'))
      : null,
    timestampMs: Number.isFinite(parsed) ? parsed : null,
    item: payload && payloadType === 'item_completed' ? readCodexRolloutItem(payload.item) : null,
  };
}

/**
 * Parse a slice of a rollout file, one line at a time.
 *
 * A line that does not parse is counted and dropped; the rest of the slice is
 * still read. That is the whole answer to "the file is being appended to while
 * we read it" — the only line a concurrent write can damage is the last one, and
 * losing it costs this poll rather than the file.
 *
 * @param text - The bytes read, decoded as UTF-8
 */
export function parseCodexRollout(text: string): CodexRolloutParse {
  const records: CodexRolloutRecord[] = [];
  let malformedLines = 0;

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const record = readCodexRolloutRecord(parsed);
    if (record) records.push(record);
    else malformedLines += 1;
  }

  return { records, malformedLines };
}

/** What one pass over a rollout's records produced. */
export interface CodexTurnBuild {
  /** Turns in the order their first record appeared. */
  readonly turns: readonly CodexTurnAccumulator[];
  /**
   * `response_item` lines skipped.
   *
   * Not a loss and not an unknown: every one of them is the model-facing copy of
   * an item the `item_completed` stream already carried. Counted so that "the
   * duplicate stream is being ignored" stays a visible fact rather than an
   * assumption — a codex that stopped emitting items would show up here as a
   * large number beside zero turns.
   */
  readonly duplicateStreamRecords: number;
  /**
   * Records that belong to no turn.
   *
   * `session_meta`, `world_state`, `token_count`, `thread_settings_applied` —
   * everything codex writes without a `turn_id`. Counted for the same reason.
   */
  readonly turnlessRecords: number;
}

/**
 * Group a rollout's records into turns.
 *
 * Keyed on `turn_id` rather than on file order, which is what lets the
 * `token_count` and `thread_settings_applied` records that codex interleaves
 * between a turn's items sit between them without splitting the turn. The map
 * preserves first-seen order, so the newest turn is still the last one.
 *
 * @param records - In file order
 * @param sessionId - Fallback for records that carry no session id
 */
export function buildCodexTurns(
  records: readonly CodexRolloutRecord[],
  sessionId: string
): CodexTurnBuild {
  const turns = new Map<string, CodexTurnAccumulator>();
  let duplicateStreamRecords = 0;
  let turnlessRecords = 0;
  let fileSessionId: string | null = null;

  for (const record of records) {
    if (record.type === 'session_meta' && record.sessionId) fileSessionId = record.sessionId;

    if (record.type === 'response_item') {
      duplicateStreamRecords += 1;
      continue;
    }

    const turnId = record.turnId;
    if (!turnId) {
      turnlessRecords += 1;
      continue;
    }

    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        sessionId: record.sessionId ?? fileSessionId ?? sessionId,
        turnId,
        startedAt: record.timestampMs ?? 0,
        prompts: [],
        items: [],
        closed: false,
        overflowed: false,
      };
      turns.set(turnId, turn);
    }

    if (record.payloadType === 'task_complete') {
      turn.closed = true;
      continue;
    }

    const item = record.item;
    if (!item) continue;

    if (item.type === 'UserMessage') {
      if (item.id && item.text) {
        turn.prompts.push({
          itemId: item.id,
          text: item.text,
          timestampMs: record.timestampMs ?? turn.startedAt,
        });
      }
      continue;
    }

    if (turn.items.length >= MAX_CODEX_TURN_ITEMS) {
      turn.overflowed = true;
      continue;
    }
    turn.items.push(item);
  }

  return { turns: [...turns.values()], duplicateStreamRecords, turnlessRecords };
}

/**
 * Item types that carry nothing a reader wants.
 *
 * A deny set rather than an allow set, for the reason the other two readers
 * give: an item type a later codex adds should surface in the unknown tally
 * instead of being silently equivalent to something that was checked.
 * `ContextCompaction` is on it because its whole payload is `{type, id}` —
 * measured on 53 archived items, every one of them with no other field.
 */
const CODEX_SILENT_ITEM_TYPES: ReadonlySet<string> = new Set(['ContextCompaction']);

/** The word each tool item is labelled with on its summary line. */
const CODEX_TOOL_LABELS: Readonly<Record<string, string>> = {
  CommandExecution: 'exec',
  FileChange: 'edit',
  McpToolCall: 'mcp',
  ImageView: 'view',
  Extension: 'extension',
};

/** One tool call as a single Markdown line. */
function renderToolItem(item: CodexRolloutItem): string {
  const label = CODEX_TOOL_LABELS[item.type] ?? item.type;
  return item.detail ? `- \`${label}\` — ${item.detail}` : `- \`${label}\``;
}

/**
 * A reasoning summary, folded.
 *
 * A blockquote and not `<details>`, for the reason `../opencode/transcript`
 * documents: `<details>` would require running raw HTML through the card's
 * sanitiser, and that costs every unfenced `<T>` in ordinary prose.
 */
function renderReasoningItem(text: string): string {
  const quoted = text
    .trim()
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
  return `> **${CODEX_THINKING_LABEL}**\n>\n${quoted}`;
}

/**
 * Render one turn to Markdown.
 *
 * Transcript order within each kind — the same decision #2041 and #2121 took,
 * and for the same reason: the order is the only record of what happened when,
 * and this row is the record. Both `commentary` and `final_answer` messages are
 * kept; codex's TUI shows both, and dropping the commentary would remove the
 * sentence that explains what the tool line underneath it is for.
 *
 * The layout — prose first, the calls folded into one labelled section — is
 * `../turn-body`'s and is shared with the other three readers (#2234).
 */
export function renderCodexTurn(turn: CodexTurnAccumulator): CodexRenderedTurn {
  const rendered: TurnRenderBlock[] = [];
  const unknown = new Set<string>();
  let textBlocks = 0;
  let toolBlocks = 0;

  for (const item of turn.items) {
    if (item.type === 'AgentMessage') {
      const text = item.text?.trim() ?? '';
      if (text.length === 0) continue;
      rendered.push({ kind: 'prose', text });
      textBlocks += 1;
      continue;
    }
    if (item.type === 'Reasoning') {
      const text = item.text?.trim() ?? '';
      if (text.length === 0) continue;
      rendered.push({ kind: 'aside', text: renderReasoningItem(text) });
      continue;
    }
    if (item.type in CODEX_TOOL_LABELS) {
      rendered.push({ kind: 'tool', text: renderToolItem(item) });
      toolBlocks += 1;
      continue;
    }
    if (!CODEX_SILENT_ITEM_TYPES.has(item.type)) unknown.add(item.type);
  }

  let body = separateTurnBody(rendered).body;
  if (body.length > MAX_CODEX_TURN_BODY_LENGTH) {
    body =
      body.slice(0, MAX_CODEX_TURN_BODY_LENGTH - CODEX_TURN_TRUNCATION_MARKER.length) +
      CODEX_TURN_TRUNCATION_MARKER;
  }

  return {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    body,
    textBlocks,
    toolBlocks,
    unknownBlockTypes: [...unknown],
  };
}
