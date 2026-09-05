/**
 * Turning Command Code's transcript JSONL back into the reply the agent wrote
 * (Issue #2252, Epic #2249 Phase C).
 *
 * The fifth of these readers, after `../claude/transcript` (#2121),
 * `../codex/transcript` (#2197) and `../antigravity/transcript` (#2198), and the
 * one whose file looks most like claude's while agreeing with **antigravity**
 * about the thing that decides the shape of the code: there is no record that
 * says a turn ended.
 *
 * ## What was measured
 *
 * Against Command Code **v1.40.1** on 2026-09-03, on the live transcripts in
 * `tests/fixtures/transcripts/command-code/` (that directory's README says which
 * bytes are the tool's and which are ours), and against the tool's own bundle
 * (`dist/cli.mjs`), which is the only complete statement of the writer:
 *
 *  1. **The file is `<header>` then entries.** Line 1 is
 *     `{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}` and every
 *     later line is `{"type":…,"id":…,"parentId":…,"timestamp":…,…}`. The
 *     bundle's `isSessionEntryV3` accepts nine `type`s —
 *     `message`, `model_change`, `effort_change`, `compaction`,
 *     `branch_summary`, `custom`, `custom_message`, `label`, `session_info` —
 *     of which only `message` carries a conversation. See
 *     {@link COMMAND_CODE_MESSAGE_RECORD_TYPE}.
 *  2. **`id` is an 8-hex short id, not a uuid** (`cb06ab09`), minted by
 *     `generateEntryId` with a collision check against the ids already in the
 *     file. `parentId` chains each entry to the previous one in file order — it
 *     is not a reply-to pointer — so turns are built from order, exactly as
 *     claude's are.
 *  3. **`message.meta.source` is the record's provenance**, and it is a first
 *     class field rather than something to infer: `user` for the operator's own
 *     prompt, `model` for the agent, `tool` for a `tool_result` carrier, and —
 *     from the bundle's agent loop — `steering` and `followup` for prompts the
 *     loop appends on the operator's behalf. `meta` also carries `createdAt`
 *     (epoch ms, when the message was *made*), `messageId`, `isMeta`,
 *     `isSummary` and `isAutomated`.
 *  4. **The entry `timestamp` is when the entry was appended to the store, not
 *     when the message was made.** The writer buffers: `persistEntry` writes
 *     nothing at all until the first *assistant* message entry, and then flushes
 *     the header and everything before it in one `writeWholeFile`. In the
 *     captured session that gave the prompt, the reply and the tool result the
 *     same `timestamp` and three different `meta.createdAt`s. So
 *     {@link CommandCodeTranscriptRecord.timestampMs} prefers `createdAt`.
 *  5. **There is no `stop_reason`.** claude's #2264 gate reads
 *     `message.stop_reason`; Command Code persists no such field on any record,
 *     and grepping the capture confirms it. What the bundle *does* show is the
 *     loop's own end condition — `if(!A){const e="max_tokens"===x.stopReason?
 *     "max_tokens":"end_turn"; … runOnStop(…)}` where `A` is `hadToolCalls` —
 *     so "the model's last message asked for no tool" **is** the end of the
 *     turn, it simply is not written down. That is
 *     {@link isCommandCodeTurnClosingRecord}, and it is the same rule
 *     `../antigravity/transcript` arrived at for the same reason.
 *
 * ## Re-measured on v1.49.0 (Issue #2304)
 *
 * All five facts above still hold, unchanged, nine minor versions later: same
 * `version: 3` header, same `type: session` / `type: message` split, same
 * `message.meta` fields, same `thinking` / `text` / `tool_use` / `tool_result`
 * content blocks, still no `stop_reason` anywhere. The capture is
 * `hook-session-1490.jsonl` in the fixtures directory, taken from the same live
 * run whose hook payloads are `hook-payloads-1490.json`, and no change to this
 * module was needed for it.
 *
 * What *did* change is the directory around the file: 1.49.0 writes
 * `<session_id>.meta.json` and `<session_id>.checkpoints.jsonl` beside the
 * transcript, and 1.40.1 wrote neither. Neither is this module's problem —
 * `./history`'s scan matches `<session_id>.jsonl` exactly — but the checkpoints
 * file is worth one sentence here because it is the one that could reach this
 * parser: its rows are `{id, messageId, turnNumber, createdAt, prompt,
 * messageCount, files}` with **no `type` field at all**, so
 * {@link readCommandCodeTranscriptRecord} declines every one of them and
 * {@link parseCommandCodeTranscript} answers zero records. Measured, not
 * assumed. That is what makes the fail-open hold without a fourth condition on
 * `acceptCommandCodeTranscriptHint`, which the file's `.jsonl` suffix would
 * otherwise satisfy.
 *
 * ## Pure on purpose
 *
 * No filesystem, no database, no `globalThis` — `./history` owns all three. The
 * consequence is that "the saved body equals the transcript's text" is a
 * property a test can assert against a fixture rather than a claim, which is why
 * all four of its siblings are written this way.
 *
 * @module lib/hooks/sources/command-code/transcript
 */

import { isPlainObject, readStringField } from '../event-mapper';
import { separateTurnBody, type TurnRenderBlock } from '../turn-body';

/**
 * `~/.commandcode/projects` — the directory Command Code keeps one project's
 * sessions in, relative to the home directory.
 *
 * **The leaf below it is not computable and this module never tries.** The
 * bundle's `getProjectDirName` is `slugify(cwd)`, and the captured pair shows
 * that `slugify` splits camel case as well as replacing separators
 * (`…/MyCodeBranchDesk/probe` → `…-my-code-branch-desk-probe`), which is a
 * different function from claude's byte-for-byte `[^A-Za-z0-9] → -`.
 * Reimplementing an unpublished slug would be a rule that silently stops
 * matching the day Command Code changes it; `./history` looks the session id up
 * on the filesystem instead.
 */
export const COMMAND_CODE_PROJECTS_DIR_SEGMENTS: readonly string[] = ['.commandcode', 'projects'];

/** `.jsonl`; the only extension this reader will open. */
export const COMMAND_CODE_TRANSCRIPT_EXTENSION = '.jsonl';

/** The header line's `type`. Carries the session id and the `cwd`. */
export const COMMAND_CODE_SESSION_RECORD_TYPE = 'session';

/** The only entry `type` that carries a conversation. */
export const COMMAND_CODE_MESSAGE_RECORD_TYPE = 'message';

/**
 * `message.meta.source` for a record the person at the keyboard produced.
 *
 * The positive evidence {@link isCommandCodeOperatorPromptRecord} requires; see
 * that function for the census behind choosing an allow list over a deny list.
 */
export const COMMAND_CODE_OPERATOR_MESSAGE_SOURCE = 'user';

/** Longest body written for one turn. Same bound and reason as claude's. */
export const MAX_COMMAND_CODE_TURN_BODY_LENGTH = 200_000;

/** Appended when {@link MAX_COMMAND_CODE_TURN_BODY_LENGTH} truncates a turn. */
export const COMMAND_CODE_TURN_TRUNCATION_MARKER = '\n\n_(truncated)_';

/**
 * Cap on content blocks kept for one turn.
 *
 * claude's number, for a reason that carries over unchanged: the overflow is
 * reported rather than hidden, so the bound only has to be far above a real
 * turn, and one round of Command Code's loop already produced three blocks
 * (`thinking`, `tool_use`, `tool_use`) on a single record.
 */
export const MAX_COMMAND_CODE_TURN_BLOCKS = 2048;

/** Longest tool detail put on a summary line. */
export const MAX_COMMAND_CODE_TOOL_DETAIL_LENGTH = 200;

/** The label a thinking block is folded behind. The same word the others use. */
export const COMMAND_CODE_THINKING_LABEL = 'Thinking';

/** One content block of one record, reduced to what a reader needs. */
export interface CommandCodeContentBlock {
  /** `text` / `thinking` / `tool_use` / `tool_result` / … verbatim. */
  readonly type: string;
  /** `text` for a text block, `thinking` for a thinking block; null otherwise. */
  readonly text: string | null;
  /** `name` on a `tool_use` block (`shell_command`, `write_file`, …). */
  readonly toolName: string | null;
  /** The one-line summary of a `tool_use` block's input; null when it has none. */
  readonly toolDetail: string | null;
}

/** One line of the transcript, reduced to what a reader needs. */
export interface CommandCodeTranscriptRecord {
  /** `session` for the header, `message` for a conversation entry. */
  readonly type: string;
  /** The entry's own 8-hex id; the turn key when this record is a prompt. */
  readonly id: string | null;
  /** The previous entry in file order. Read only for the diagnostic below. */
  readonly parentId: string | null;
  /** `message.role` — `user` or `assistant`; null on every non-message entry. */
  readonly role: string | null;
  /** The header's `id`, which is the session id. Null on every other line. */
  readonly sessionId: string | null;
  /** The header's `cwd`. Null on every other line. */
  readonly cwd: string | null;
  /**
   * The header's `parentSession` — the file this session was forked from.
   *
   * Written by the bundle's `resolveParentSessionPath` when `meta.parentSessionId`
   * is set, which is what `--fork` and `--clone` do. Never read for a decision:
   * it is the one honest piece of evidence that a window's records may belong to
   * another conversation, and `./history` logs it. Rebuilding the fork tree is
   * out of this Issue's scope by name.
   */
  readonly parentSession: string | null;
  /** `message.meta.source` — `user` / `model` / `tool` / `steering` / … */
  readonly source: string | null;
  /** `message.meta.isMeta` — the flag `filterVisibleMessages` hides a record on. */
  readonly isMeta: boolean;
  /** `message.meta.isSummary` — a compaction or branch summary. */
  readonly isSummary: boolean;
  /** `message.meta.isAutomated` — a message the tool produced for the operator. */
  readonly isAutomated: boolean;
  /**
   * When this message was made, as epoch ms.
   *
   * `meta.createdAt` when it is there, and the entry's own `timestamp` only as a
   * fallback — see measurement 4 in the module comment: the entry timestamp is
   * the moment the store appended it, and the store buffers until the first
   * assistant record, so three records of one turn can share one.
   */
  readonly timestampMs: number | null;
  /** `message.content`, normalised; empty for entries that carry no message. */
  readonly blocks: readonly CommandCodeContentBlock[];
  /**
   * The record's text with every text block concatenated.
   *
   * Used to decide whether a `user` record is a prompt, and — for a prompt —
   * written to History as the operator's own row (#2196's shape). Never part of
   * the *assistant* body: that is the whole point of this module.
   */
  readonly text: string;
}

/** One turn: everything the agent produced in reply to one prompt. */
export interface CommandCodeTurnAccumulator {
  /** The session the turn was read from. */
  readonly sessionId: string;
  /** `id` of the user record that opened the turn; the turn's identity. */
  readonly promptId: string;
  /** Epoch ms of the prompt record, so the row is dated by the agent's clock. */
  readonly startedAt: number;
  /** The prompt, as it stood in the composer. */
  readonly promptText: string;
  /** Whether {@link isCommandCodeOperatorPromptRecord} accepted the record. */
  readonly promptIsOperatorInput: boolean;
  /** Assistant content blocks, in the order the agent produced them. */
  readonly blocks: CommandCodeContentBlock[];
  /** How many `role: "assistant"` records contributed. */
  assistantRecords: number;
  /**
   * True when the agent's last word in this turn was a finished answer (#2264).
   *
   * Command Code writes **no** end-of-turn record — there is no `stop_reason` on
   * any persisted record and no `task_complete` of codex's kind — so the
   * evidence has to be the shape of the last assistant record:
   * {@link isCommandCodeTurnClosingRecord}, which is prose with **no `tool_use`
   * block beside it**.
   *
   * Both halves are load-bearing and both come off measurements:
   *
   *  - **The `tool_use` half is the loop's own rule.** The bundle ends a turn on
   *    `if(!hadToolCalls){ … stopReason = "end_turn" … }`, so a record that
   *    reaches for a tool is the agent mid-loop by the tool's own definition. The
   *    captured turn writes `thinking` + two `tool_use` on one record and the
   *    sentence about their output on the next, which is exactly the shape that
   *    would be mistaken for a finished reply without this half.
   *  - **The prose half is claude's, and #2264 is what it is for.** A turn cut
   *    off after its tool calls still renders a *non-empty* body — the tool log
   *    is a section of its own — so the writer's emptiness guard cannot see
   *    anything wrong with it, and the row it writes is keyed and therefore
   *    frozen. `end_turn` after nothing but `thinking` is the same trap.
   *
   * Assigned per assistant record rather than or-ed, so the value left standing
   * is the *last* one's answer: a turn that answered and then reached for another
   * tool is open again, which is what a resumed loop means.
   */
  closed: boolean;
  /**
   * True when a later prompt record opened another turn (Issue #2264).
   *
   * The second, independent proof that nothing more will be appended here, and
   * the one {@link closed} cannot supply: a turn the operator **interrupted**
   * ends on a `tool_use` record and never gets its closing prose, and it is
   * still a finished turn whose reply nobody else is going to write.
   *
   * A turn is superseded exactly when it is not the last one in the window, and
   * an agent that has moved on to another prompt will never add a record to the
   * one before it. So the writable predicate is `closed || superseded`
   * ({@link isCommandCodeTurnWritable}) and the gate bites on precisely the turn
   * #2264 was reported about: the newest one, still open.
   */
  superseded: boolean;
  /** True once a block had to be dropped for {@link MAX_COMMAND_CODE_TURN_BLOCKS}. */
  overflowed: boolean;
}

/** What one rendered turn is. */
export interface CommandCodeRenderedTurn {
  readonly sessionId: string;
  readonly promptId: string;
  /** The Markdown body, or an empty string when the turn said nothing. */
  readonly body: string;
  /** How many text blocks contributed. */
  readonly textBlocks: number;
  /** How many tool calls were summarised. */
  readonly toolBlocks: number;
  /** Block types that were neither rendered nor on the silent list. */
  readonly unknownBlockTypes: readonly string[];
}

/** What one pass over a transcript's lines produced. */
export interface CommandCodeTranscriptParse {
  readonly records: readonly CommandCodeTranscriptRecord[];
  /**
   * Lines that were not valid JSON, or were JSON but not an object with a `type`.
   *
   * Expected to be non-zero and harmless. Command Code appends to this file
   * while CommandMate reads it, so the last line of a read taken mid-write is a
   * fragment — which is exactly why parsing is per line and a failure costs one
   * record rather than the file.
   */
  readonly malformedLines: number;
  /** The header's session id, when the window reached back far enough for it. */
  readonly sessionId: string | null;
  /** The header's `cwd`, when the window held the header. */
  readonly cwd: string | null;
  /** The header's `parentSession`, when it had one. See the field's own comment. */
  readonly parentSession: string | null;
}

/**
 * The fields of a `tool_use` input worth putting on the summary line, in
 * preference order.
 *
 * The first two are measured on this tool: `shell_command` carries `command` and
 * `description`, and the file tools (`write_file` / `read_file` / `edit_file`)
 * carry `file_path` — the bundle's own `fileArgOf` is `input.file_path ??
 * input.path`, which is why `path` follows it. The rest are the same fall-back
 * order claude's reader uses, and every one of them is a *miss* rather than a
 * mistake: a tool whose input matches none of them renders as the bare tool
 * name, which is what the operator saw on the TUI's tool row anyway.
 */
const COMMAND_CODE_TOOL_DETAIL_FIELDS: readonly string[] = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'description',
];

/**
 * Read one `message.content` element.
 *
 * @returns The block, or null when it is not an object with a `type`
 */
export function readCommandCodeContentBlock(value: unknown): CommandCodeContentBlock | null {
  if (!isPlainObject(value)) return null;
  const type = readStringField(value, 'type');
  if (!type) return null;

  if (type === 'tool_use') {
    return {
      type,
      text: null,
      toolName: readStringField(value, 'name'),
      toolDetail: readToolDetail(value.input),
    };
  }

  // `text` on a text block, `thinking` on a thinking block. Read by name rather
  // than by trying both on every block, so that a future block type carrying an
  // unrelated `text` field is not silently rendered as prose. Note that a
  // `tool_result` block *does* carry nested `content[].text` on this tool and is
  // deliberately not reached by either lookup.
  const text =
    type === 'text'
      ? (readStringField(value, 'text') ?? '')
      : type === 'thinking'
        ? (readStringField(value, 'thinking') ?? '')
        : null;

  return { type, text, toolName: null, toolDetail: null };
}

/** The first present detail field of a `tool_use` input, collapsed to a line. */
function readToolDetail(input: unknown): string | null {
  if (!isPlainObject(input)) return null;
  for (const field of COMMAND_CODE_TOOL_DETAIL_FIELDS) {
    const value = readStringField(input, field);
    if (value) return boundToolDetail(collapseToLine(value));
  }
  return null;
}

/** A tool detail on one line. A heredoc `command` puts newlines in it. */
function collapseToLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function boundToolDetail(value: string): string {
  return value.length <= MAX_COMMAND_CODE_TOOL_DETAIL_LENGTH
    ? value
    : `${value.slice(0, MAX_COMMAND_CODE_TOOL_DETAIL_LENGTH - 1)}…`;
}

/** `message.meta`, when the entry has one. */
function readMessageMeta(message: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!message) return null;
  return isPlainObject(message.meta) ? message.meta : null;
}

/**
 * Read one parsed transcript line.
 *
 * @returns The record, or null when the value is not an object with a `type`
 */
export function readCommandCodeTranscriptRecord(
  value: unknown
): CommandCodeTranscriptRecord | null {
  if (!isPlainObject(value)) return null;
  const type = readStringField(value, 'type');
  if (!type) return null;

  const isHeader = type === COMMAND_CODE_SESSION_RECORD_TYPE;
  const message = isPlainObject(value.message) ? value.message : null;
  const meta = readMessageMeta(message);
  const rawContent = message?.content;

  const blocks: CommandCodeContentBlock[] = [];
  let text = '';
  if (typeof rawContent === 'string') {
    // Not observed on v1.40.1 — every captured `content` is an array — but the
    // bundle's own `hasValidV2Content` accepts a bare string for a non-tool
    // role, so a session migrated from the v1/v2 format can hold one.
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    for (const entry of rawContent) {
      const block = readCommandCodeContentBlock(entry);
      if (!block) continue;
      blocks.push(block);
      if (block.type === 'text' && block.text) text += block.text;
    }
  }

  const timestamp = readStringField(value, 'timestamp');
  const parsedTimestamp = timestamp ? Date.parse(timestamp) : NaN;
  const createdAt = meta && typeof meta.createdAt === 'number' ? meta.createdAt : null;

  return {
    type,
    // The header's `id` is the session id, not an entry id, so it must not
    // become a turn key. Only `message` entries and their siblings have one.
    id: isHeader ? null : readStringField(value, 'id'),
    parentId: readStringField(value, 'parentId'),
    role: message ? readStringField(message, 'role') : null,
    sessionId: isHeader ? readStringField(value, 'id') : null,
    cwd: isHeader ? readStringField(value, 'cwd') : null,
    parentSession: isHeader ? readStringField(value, 'parentSession') : null,
    source: meta ? readStringField(meta, 'source') : null,
    isMeta: meta?.isMeta === true,
    isSummary: meta?.isSummary === true,
    isAutomated: meta?.isAutomated === true,
    timestampMs:
      createdAt !== null && Number.isFinite(createdAt)
        ? createdAt
        : Number.isFinite(parsedTimestamp)
          ? parsedTimestamp
          : null,
    blocks,
    text,
  };
}

/**
 * Parse a slice of a transcript file, one line at a time.
 *
 * A line that does not parse is counted and dropped; the rest of the slice is
 * still read. That is the entire answer to "the file is being appended to while
 * we read it": the only line a concurrent write can damage is the last one, and
 * the cost of losing it is that this turn is written on the next poll instead of
 * this one.
 *
 * @param text - The bytes read, decoded as UTF-8
 */
export function parseCommandCodeTranscript(text: string): CommandCodeTranscriptParse {
  const records: CommandCodeTranscriptRecord[] = [];
  let malformedLines = 0;
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let parentSession: string | null = null;

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const record = readCommandCodeTranscriptRecord(parsed);
    if (!record) {
      malformedLines += 1;
      continue;
    }
    records.push(record);
    if (record.sessionId) {
      sessionId = record.sessionId;
      cwd = record.cwd;
      parentSession = record.parentSession;
    }
  }

  return { records, malformedLines, sessionId, cwd, parentSession };
}

/**
 * Whether this record opens a turn.
 *
 * Command Code's own rule, taken verbatim from its bundle —
 * `isFreshUserTurn(e) = "user" === e.role && !e.content.some(e => "tool_result"
 * === e.type)` — plus the three guards a *reader* needs that the tool does not:
 *
 *  - it must be a `message` entry, because `label` / `session_info` /
 *    `model_change` carry no conversation;
 *  - it must have an `id`, because that is the turn key and an invented one is a
 *    row no later run can recognise as already written;
 *  - it must have text, because a turn with no prompt in it is a turn this
 *    reader cannot name in History.
 *
 * `meta.isMeta` disqualifies it too: that is the flag the tool's own
 * `filterVisibleMessages` hides a record on, so a record Command Code does not
 * show the operator is not one CommandMate should open a turn on.
 *
 * Deliberately **wider** than {@link isCommandCodeOperatorPromptRecord}: a
 * `steering` or `followup` prompt really is answered, and the reply really does
 * belong to it. The narrower question is "should this text appear as the
 * operator's message", which is asked separately and has a different cost of
 * being wrong.
 */
export function isCommandCodePromptRecord(record: CommandCodeTranscriptRecord): boolean {
  if (record.type !== COMMAND_CODE_MESSAGE_RECORD_TYPE) return false;
  if (record.role !== 'user') return false;
  if (record.isMeta) return false;
  if (!record.id) return false;
  // Command Code's own boundary. A user record that carries tool output is the
  // agent's loop feeding itself, not a new question — the captured turn has one
  // such record carrying two `tool_result` blocks.
  if (record.blocks.some((block) => block.type === 'tool_result')) return false;
  return record.text.trim().length > 0;
}

/**
 * Whether this record is text a human typed at the terminal (the #2196 rule).
 *
 * ## Positive evidence, not a deny list
 *
 * The rule is `meta.source === "user"`, and a record that claims anything else —
 * or nothing at all — produces no `user` row. That direction is the one #2196
 * settled for claude and it is *better* supported here, because Command Code
 * stamps the provenance itself rather than leaving it to be inferred: the
 * bundle's composer path writes `meta:{source:"user",createdAt:Date.now(),…}`,
 * and the agent loop writes `source:"steering"` for text queued while a turn was
 * running and `source:"followup"` for a prompt it appends on the operator's
 * behalf. Both of those pass {@link isCommandCodePromptRecord} — they are
 * genuinely turns — and neither is something a person put in the chat pane.
 *
 * A deny list would default a shape a later Command Code invents to *being
 * shown*; this defaults to being skipped, which costs the `user` row and keeps
 * the reply — the designed degradation rather than a fabricated message.
 *
 * `isSummary` and `isAutomated` are then checked explicitly even though nothing
 * observed carries `source: "user"` *and* either flag. They are not redundant by
 * construction: compaction is something the operator initiates, so a later
 * version stamping `source: "user"` on the summary it produces would be
 * defensible from Command Code's side and wrong from this one's.
 */
export function isCommandCodeOperatorPromptRecord(record: CommandCodeTranscriptRecord): boolean {
  if (!isCommandCodePromptRecord(record)) return false;
  if (record.isSummary) return false;
  if (record.isAutomated) return false;
  return record.source === COMMAND_CODE_OPERATOR_MESSAGE_SOURCE;
}

/**
 * Whether this assistant record is the one that ended the reply (Issue #2264).
 *
 * Prose, and **no `tool_use` block beside it**. See
 * {@link CommandCodeTurnAccumulator.closed} for why neither half alone is the
 * rule, and note that the emptiness test here is the one
 * {@link renderCommandCodeTurn} applies to a text block — a block whose `text`
 * trims to nothing is not rendered, so it cannot be what makes a turn look
 * finished either.
 */
export function isCommandCodeTurnClosingRecord(record: CommandCodeTranscriptRecord): boolean {
  if (record.type !== COMMAND_CODE_MESSAGE_RECORD_TYPE) return false;
  if (record.role !== 'assistant') return false;
  if (record.blocks.some((block) => block.type === 'tool_use')) return false;
  return record.blocks.some(
    (block) => block.type === 'text' && (block.text ?? '').trim().length > 0
  );
}

/**
 * Whether a writer may record this turn (Issue #2264).
 *
 * Either proof that nothing more is coming: the agent finished answering
 * ({@link CommandCodeTurnAccumulator.closed}), or it has moved on to another
 * prompt ({@link CommandCodeTurnAccumulator.superseded}).
 *
 * No third branch. claude's equivalent keeps one — a turn whose records carried
 * no `stop_reason` at all is written anyway, so that a Claude release which
 * dropped the field could not switch the reader off silently — and that escape
 * hatch has nothing to guard here: this rule reads no optional field, only the
 * presence of block types the render path already depends on. If `tool_use`
 * were renamed the bodies would be wrong long before the gate was.
 * `../antigravity/transcript` reaches the same two-branch predicate for the same
 * reason.
 */
export function isCommandCodeTurnWritable(turn: CommandCodeTurnAccumulator): boolean {
  return turn.closed || turn.superseded;
}

/** A brand-new accumulator for one turn. */
export function createCommandCodeTurn(
  record: CommandCodeTranscriptRecord,
  sessionId: string
): CommandCodeTurnAccumulator {
  return {
    sessionId,
    promptId: record.id as string,
    startedAt: record.timestampMs ?? 0,
    promptText: record.text,
    promptIsOperatorInput: isCommandCodeOperatorPromptRecord(record),
    blocks: [],
    assistantRecords: 0,
    closed: false,
    superseded: false,
    overflowed: false,
  };
}

/** What one pass over a transcript's records produced. */
export interface CommandCodeTurnBuild {
  readonly turns: readonly CommandCodeTurnAccumulator[];
  /**
   * Assistant records that arrived before any prompt record.
   *
   * Non-zero means the read started inside a turn — the tail window `./history`
   * uses did not reach back as far as the prompt. Their text is dropped rather
   * than attached to a turn key that would be invented for it, because an
   * invented key is a row no later run can recognise as already written.
   */
  readonly orphanedAssistantRecords: number;
  /**
   * Message entries whose `parentId` names no record earlier in the window.
   *
   * A diagnostic and never a decision. `parentId` is a file-order chain, so the
   * first entry of a windowed read always has one and a value of exactly 1 is
   * the normal state of a long session. What it is *for* is the case Issue #2252
   * scopes out by name — a fork or a clone, where records genuinely belong to
   * another conversation — which shows as a count that keeps growing and, on the
   * header, as a `parentSession` path. `./history` logs both.
   */
  readonly unresolvedParentRecords: number;
  /**
   * Entries whose `type` is neither the header nor `message`.
   *
   * `label`, `session_info`, `model_change`, `effort_change`, `compaction`,
   * `branch_summary`, `custom`, `custom_message` — the eight other words the
   * bundle's `isSessionEntryV3` accepts. None of them carries conversation text
   * and all of them are skipped; the count is what would show a ninth arriving.
   */
  readonly nonMessageRecords: number;
}

/**
 * Group a transcript's records into turns.
 *
 * File order, and a prompt record opens a turn. Deliberately **not** the
 * `parentId` chain: the bundle sets `parentId` to `lastEntryId` — the entry
 * before this one, whatever it was — so it links a reply to a tool result as
 * readily as to its prompt, and following it would rebuild file order the long
 * way round. `../claude/transcript` gives the same reasoning for the same
 * decision.
 *
 * @param records - In file order
 * @param sessionId - Fallback for a window that did not include the header
 */
export function buildCommandCodeTurns(
  records: readonly CommandCodeTranscriptRecord[],
  sessionId: string
): CommandCodeTurnBuild {
  const turns: CommandCodeTurnAccumulator[] = [];
  const seenIds = new Set<string>();
  let current: CommandCodeTurnAccumulator | null = null;
  let orphanedAssistantRecords = 0;
  let unresolvedParentRecords = 0;
  let nonMessageRecords = 0;
  let resolvedSessionId = sessionId;

  for (const record of records) {
    if (record.sessionId) {
      resolvedSessionId = record.sessionId;
      continue;
    }
    if (record.type !== COMMAND_CODE_MESSAGE_RECORD_TYPE) {
      nonMessageRecords += 1;
      if (record.id) seenIds.add(record.id);
      continue;
    }

    if (record.parentId !== null && !seenIds.has(record.parentId)) {
      unresolvedParentRecords += 1;
    }
    if (record.id) seenIds.add(record.id);

    if (isCommandCodePromptRecord(record)) {
      current = createCommandCodeTurn(record, resolvedSessionId);
      turns.push(current);
      continue;
    }

    if (record.role !== 'assistant') continue;
    if (!current) {
      orphanedAssistantRecords += 1;
      continue;
    }

    current.assistantRecords += 1;
    // Assigned rather than or-ed, so the value left standing is the *last*
    // assistant record's answer. See {@link CommandCodeTurnAccumulator.closed}.
    current.closed = isCommandCodeTurnClosingRecord(record);
    for (const block of record.blocks) {
      if (current.blocks.length >= MAX_COMMAND_CODE_TURN_BLOCKS) {
        current.overflowed = true;
        break;
      }
      current.blocks.push(block);
    }
  }

  // Every turn but the last one has a later prompt behind it, and a prompt is
  // proof the agent moved on. See {@link CommandCodeTurnAccumulator.superseded}.
  for (let index = 0; index < turns.length - 1; index += 1) {
    turns[index].superseded = true;
  }

  return { turns, orphanedAssistantRecords, unresolvedParentRecords, nonMessageRecords };
}

/**
 * Block types that carry nothing a reader wants.
 *
 * A deny set rather than an allow set, for the reason the other four readers
 * give: a block type a later Command Code adds should surface in the unknown
 * tally instead of being silently equivalent to a tool result. `tool_result` is
 * on it because those blocks live on `user` records, which never reach a turn's
 * body.
 */
const COMMAND_CODE_SILENT_BLOCK_TYPES: ReadonlySet<string> = new Set(['tool_result']);

/** One tool call as a single Markdown line. */
function renderToolBlock(block: CommandCodeContentBlock): string {
  const name = block.toolName ?? 'tool';
  return block.toolDetail ? `- \`${name}\` — ${block.toolDetail}` : `- \`${name}\``;
}

/**
 * Thinking, folded.
 *
 * A blockquote and not `<details>`, for the reason `../turn-body` documents: the
 * card renders with no `rehypeRaw`, so a `<details>` wrapper is dropped whole
 * and takes its summary text with it.
 */
function renderThinkingBlock(text: string): string {
  const quoted = text
    .trim()
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
  return `> **${COMMAND_CODE_THINKING_LABEL}**\n>\n${quoted}`;
}

/**
 * Render one turn to Markdown.
 *
 * Every block is kept, and the layout belongs to `../turn-body` (#2234): prose
 * leads, thinking stays where it was written as a folded quote, and the tool
 * calls become one labelled section at the end. Command Code needs that
 * separation more than most — its captured turn opens with `thinking` and two
 * `tool_use` blocks and does not reach prose until the *next* record, so a body
 * in transcript order would open with a tool log every time.
 */
export function renderCommandCodeTurn(turn: CommandCodeTurnAccumulator): CommandCodeRenderedTurn {
  const rendered: TurnRenderBlock[] = [];
  const unknown = new Set<string>();
  let textBlocks = 0;
  let toolBlocks = 0;

  for (const block of turn.blocks) {
    if (block.type === 'text') {
      const text = block.text?.trim() ?? '';
      if (text.length === 0) continue;
      rendered.push({ kind: 'prose', text });
      textBlocks += 1;
      continue;
    }
    if (block.type === 'thinking') {
      // Measured empty on this tool as well as on claude: the captured blocks
      // carry `signature: ""` and the text is not always retained.
      const text = block.text?.trim() ?? '';
      if (text.length === 0) continue;
      rendered.push({ kind: 'aside', text: renderThinkingBlock(text) });
      continue;
    }
    if (block.type === 'tool_use') {
      rendered.push({ kind: 'tool', text: renderToolBlock(block) });
      toolBlocks += 1;
      continue;
    }
    if (!COMMAND_CODE_SILENT_BLOCK_TYPES.has(block.type)) unknown.add(block.type);
  }

  let body = separateTurnBody(rendered).body;
  if (body.length > MAX_COMMAND_CODE_TURN_BODY_LENGTH) {
    body =
      body.slice(0, MAX_COMMAND_CODE_TURN_BODY_LENGTH - COMMAND_CODE_TURN_TRUNCATION_MARKER.length) +
      COMMAND_CODE_TURN_TRUNCATION_MARKER;
  }

  return {
    sessionId: turn.sessionId,
    promptId: turn.promptId,
    body,
    textBlocks,
    toolBlocks,
    unknownBlockTypes: [...unknown],
  };
}
