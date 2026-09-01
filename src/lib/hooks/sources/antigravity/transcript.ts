/**
 * Turning antigravity's own transcript JSONL back into the reply it wrote
 * (Issue #2198).
 *
 * The fourth of these readers, after `../opencode/transcript` (#2041, push),
 * `../claude/transcript` (#2121, pull) and `../codex/transcript` (#2197, pull).
 * Same job for the same reason: what the poller can save is a *rendering* — the
 * agent's Markdown after agy's TUI has wrapped it to the pane width and drawn a
 * spinner through it — while the agent writes the source down as it goes.
 *
 * ## This Issue began as a go/no-go, and the answer was go
 *
 * The Issue was written not knowing whether agy kept anything readable, because
 * agy shares its state between the CLI and an IDE backend. It does, and
 * `docs/design/antigravity-transcript-reader.md` is the measurement. Two of its
 * findings shape everything below:
 *
 *  - **agy writes the conversation twice.** Once as protobuf blobs inside
 *    `conversations/<conversationId>.db` (a SQLite file whose `steps.step_payload`
 *    is an unpublished proto, and which grows a `-wal` the moment it is opened),
 *    and once as `brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
 *    — plain JSONL, one object per step, `content` holding the Markdown source.
 *    The JSONL is what agy's own hook payload names in `transcriptPath`, so
 *    there is no judgement call about which is authoritative.
 *  - **`transcript.jsonl` next to it is a truncated view, not a second copy.**
 *    Records carrying `truncated_fields` number 106 of 1,156 there and **0 of
 *    1,024** in `transcript_full.jsonl`. `_full` is the one with the whole
 *    reply in it.
 *
 * ## The vocabulary is closed, and was counted rather than guessed
 *
 * Every rule below comes from a full scan of the 41 transcripts on the capture
 * machine (1,024 records, 0 malformed lines). The load-bearing counts:
 *
 *  - **The agent's prose lives on `MODEL`/`PLANNER_RESPONSE` and nowhere else.**
 *    Every other `MODEL` type — `RUN_COMMAND`, `VIEW_FILE`, `LIST_DIRECTORY`,
 *    `GREP_SEARCH`, `SEARCH_WEB`, `CODE_ACTION`, `GENERATE_IMAGE`, `GENERIC` —
 *    is a tool *result*, and its `content` opens with agy's own
 *    `Created At: …` header on all 372 of them.
 *  - **`tool_calls` appears on `PLANNER_RESPONSE` only** (439 of 439), and every
 *    one of those calls carries a human-readable `args.toolAction`.
 *  - **The operator's text is always wrapped**, `<USER_REQUEST>…</USER_REQUEST>`
 *    on 63 of 63 records, with `<ADDITIONAL_METADATA>` and sometimes
 *    `<USER_SETTINGS_CHANGE>` appended after it by agy rather than by the person.
 *
 * ## Two differences from codex, both measured
 *
 *  1. **There is no record that closes a turn.** codex writes `task_complete`;
 *     agy writes nothing. So this follows claude's shape — the newest turn is
 *     the one written, and the moment to write it is the one the `Stop` hook
 *     already gives the poller.
 *  2. **`step_index` is the turn's name.** No `turn_id` exists, and none is
 *     needed: the value is unique inside a conversation on all 41 files. It is
 *     *not* contiguous (10 files have gaps, where a refused tool call's step was
 *     dropped) and *not* always ascending (one file goes 8 → 7), which is why
 *     turns are grouped in file order and never sorted.
 *
 * ## Pure on purpose
 *
 * No filesystem, no database, no `globalThis` — `./history` owns all three, the
 * same split the other three readers use, so "the saved body equals the
 * transcript's text" is a property a test asserts against a real fixture rather
 * than a claim.
 *
 * @module lib/hooks/sources/antigravity/transcript
 */

import { isPlainObject, readStringField } from '../event-mapper';

/**
 * `brain` — the directory agy keeps one conversation's working state under.
 *
 * The transcript sits at `<agyHome>/brain/<conversationId>/.system_generated/logs/`,
 * which is a path this reader *computes* rather than searches for. That is the
 * one place agy is easier to read than codex, whose rollout file name embeds the
 * local wall-clock time the session started and therefore has to be scanned for.
 */
export const ANTIGRAVITY_BRAIN_DIR_SEGMENT = 'brain';

/** The rest of the path, below `brain/<conversationId>`. */
export const ANTIGRAVITY_TRANSCRIPT_PATH_SEGMENTS: readonly string[] = [
  '.system_generated',
  'logs',
  'transcript_full.jsonl',
];

/** `.jsonl`; the only extension this reader will open. */
export const ANTIGRAVITY_TRANSCRIPT_EXTENSION = '.jsonl';

/** Longest body written for one turn. Same bound and reason as the other three. */
export const MAX_ANTIGRAVITY_TURN_BODY_LENGTH = 200_000;

/** Appended when {@link MAX_ANTIGRAVITY_TURN_BODY_LENGTH} truncates a turn. */
export const ANTIGRAVITY_TURN_TRUNCATION_MARKER = '\n\n_(truncated)_';

/**
 * Cap on records kept for one turn.
 *
 * The same 2048 the other readers use. The longest turn in the corpus ran to 62
 * records, so this is two orders of magnitude of headroom and the overflow is
 * reported rather than hidden.
 */
export const MAX_ANTIGRAVITY_TURN_RECORDS = 2048;

/** Longest tool detail put on a summary line. */
export const MAX_ANTIGRAVITY_TOOL_DETAIL_LENGTH = 200;

/** The label a thinking block is folded behind. Same word the others use. */
export const ANTIGRAVITY_THINKING_LABEL = 'Thinking';

/** `source` on the record the operator's own text arrives on. */
export const ANTIGRAVITY_USER_SOURCE = 'USER_EXPLICIT';

/** `type` on that record. */
export const ANTIGRAVITY_USER_TYPE = 'USER_INPUT';

/** `source` on everything the agent produced. */
export const ANTIGRAVITY_MODEL_SOURCE = 'MODEL';

/** `type` on the agent's own prose — the only record its words are on. */
export const ANTIGRAVITY_PLANNER_TYPE = 'PLANNER_RESPONSE';

/**
 * `MODEL` types that are a tool's output rather than the agent's words.
 *
 * Dropped from the rendered body deliberately: the `tool_calls` line on the
 * `PLANNER_RESPONSE` that *made* the call already names it, and the result's
 * `content` is agy's raw tool transcript — a `Created At: …` header followed by
 * a directory listing or a command's whole stdout. Putting that in History would
 * bury the reply it belongs to.
 *
 * A named set rather than "anything that is not `PLANNER_RESPONSE`", so that a
 * later agy growing a sixteenth record type shows up in
 * {@link AntigravityRenderedTurn.unknownRecordTypes} instead of being silently
 * equivalent to something that was checked.
 */
export const ANTIGRAVITY_TOOL_RESULT_TYPES: ReadonlySet<string> = new Set([
  'RUN_COMMAND',
  'VIEW_FILE',
  'LIST_DIRECTORY',
  'GREP_SEARCH',
  'SEARCH_WEB',
  'CODE_ACTION',
  'GENERATE_IMAGE',
  'GENERIC',
]);

/**
 * `SYSTEM` types, all of which are context agy injected rather than anything
 * anybody said.
 *
 * `CHECKPOINT` is the summary agy writes when it truncates its own context,
 * `CONVERSATION_HISTORY` carries no content at all, and `SYSTEM_MESSAGE` /
 * `EPHEMERAL_MESSAGE` open with "The following is a … not actually sent by the
 * user". `ERROR_MESSAGE` is agy reporting a malformed tool call to itself. None
 * of them are the reply, so none of them are rendered — but they are listed here
 * so that an unrecognised `SYSTEM` type still surfaces as unknown.
 */
export const ANTIGRAVITY_SYSTEM_TYPES: ReadonlySet<string> = new Set([
  'CHECKPOINT',
  'CONVERSATION_HISTORY',
  'SYSTEM_MESSAGE',
  'EPHEMERAL_MESSAGE',
  'ERROR_MESSAGE',
]);

/** One entry of a record's `tool_calls`, reduced to what a reader needs. */
export interface AntigravityToolCall {
  /** `name` — `run_command`, `view_file`, `list_dir`, …. */
  readonly name: string;
  /**
   * The one-line summary agy itself wrote for this call.
   *
   * `args.toolAction` ("Searching for NOTES.md"), falling back to
   * `args.toolSummary` ("File search"). Both were present on 439 of 439 calls
   * in the corpus, so this is agy's own words rather than an argv this module
   * reassembled — which is what makes the summary line readable without
   * reproducing codex's per-tool argument rules.
   */
  readonly detail: string | null;
}

/** One line of the transcript, reduced to what a reader needs. */
export interface AntigravityTranscriptRecord {
  /** `step_index` — unique inside a conversation; not contiguous, not sorted. */
  readonly stepIndex: number;
  /** `USER_EXPLICIT` / `MODEL` / `SYSTEM`. */
  readonly source: string;
  /** `USER_INPUT` / `PLANNER_RESPONSE` / `RUN_COMMAND` / …. */
  readonly type: string;
  /** `DONE` on 1,020 of 1,024 records; `RUNNING` for a background task. */
  readonly status: string | null;
  /** `created_at` as epoch ms, or null when absent or unparseable. */
  readonly timestampMs: number | null;
  /** `content`, verbatim. Null when the record carries none. */
  readonly content: string | null;
  /** `thinking`, verbatim. Null when the record carries none. */
  readonly thinking: string | null;
  /** `tool_calls`, in order. Empty when the record carries none. */
  readonly toolCalls: readonly AntigravityToolCall[];
}

/** One operator prompt, as the transcript recorded it. */
export interface AntigravityPrompt {
  /** The `step_index` of the `USER_INPUT` record; half of the row key. */
  readonly stepIndex: number;
  /** The text the operator typed, unwrapped from `<USER_REQUEST>`. */
  readonly text: string;
  /** When agy recorded it, epoch ms. */
  readonly timestampMs: number;
}

/** One turn: the prompt, and everything agy wrote before the next one. */
export interface AntigravityTurnAccumulator {
  /** The conversation the turn was read from. */
  readonly conversationId: string;
  /** The opening `USER_INPUT`'s `step_index`; the turn's identity. */
  readonly stepIndex: number;
  /** Epoch ms of the opening record. */
  readonly startedAt: number;
  /**
   * The prompt this turn answers, or null.
   *
   * Null only when the `<USER_REQUEST>` block was empty — agy wraps every one of
   * the 63 operator inputs in the corpus, so an unwrapped record is a shape this
   * reader has not seen rather than a normal case.
   */
  readonly prompt: AntigravityPrompt | null;
  /** Everything after the prompt, in the order agy appended it. */
  readonly records: AntigravityTranscriptRecord[];
  /** True once a record had to be dropped for {@link MAX_ANTIGRAVITY_TURN_RECORDS}. */
  overflowed: boolean;
}

/** What one rendered turn is. */
export interface AntigravityRenderedTurn {
  readonly conversationId: string;
  readonly stepIndex: number;
  /** The Markdown body, or an empty string when the turn said nothing. */
  readonly body: string;
  /** How many `PLANNER_RESPONSE` records contributed prose. */
  readonly textBlocks: number;
  /** How many tool calls were summarised. */
  readonly toolBlocks: number;
  /**
   * Record types that were neither rendered nor on a silent list.
   *
   * Never dropped in silence: a type this reader has no rule for is an agy
   * release that has grown one, and the tally is how that becomes visible before
   * somebody notices a missing paragraph.
   */
  readonly unknownRecordTypes: readonly string[];
}

/** What one pass over a transcript's lines produced. */
export interface AntigravityTranscriptParse {
  readonly records: readonly AntigravityTranscriptRecord[];
  /**
   * Lines that were not valid JSON, or were JSON but not a usable record.
   *
   * Expected to be non-zero and harmless for the reason the other readers give:
   * agy appends to this file while CommandMate reads it, so the last line of a
   * read taken mid-write is a fragment. Parsing is per line, and a failure costs
   * one record rather than the file. The corpus itself has **0 of 1,024**, so a
   * large number here means something other than a torn append.
   */
  readonly malformedLines: number;
}

/** Read one entry of `tool_calls`. */
export function readAntigravityToolCall(value: unknown): AntigravityToolCall | null {
  if (!isPlainObject(value)) return null;
  const name = readStringField(value, 'name');
  if (!name) return null;

  const args = isPlainObject(value.args) ? value.args : null;
  const detail = args
    ? (readStringField(args, 'toolAction') ?? readStringField(args, 'toolSummary'))
    : null;

  return { name, detail: detail ? boundDetailText(collapseToLine(detail)) : null };
}

/**
 * Read one parsed transcript line.
 *
 * `step_index` is required and must be a finite integer, because it is the
 * turn's identity and half of the `request_id` an idempotency check is made on.
 * A record without one cannot be named, so it is counted as malformed rather
 * than given a synthetic index that would collide on the next read.
 *
 * @returns The record, or null when the value is not a usable one
 */
export function readAntigravityTranscriptRecord(
  value: unknown
): AntigravityTranscriptRecord | null {
  if (!isPlainObject(value)) return null;

  const stepIndex = value.step_index;
  if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex) || stepIndex < 0) return null;

  const source = readStringField(value, 'source');
  const type = readStringField(value, 'type');
  if (!source || !type) return null;

  const createdAt = readStringField(value, 'created_at');
  const parsed = createdAt ? Date.parse(createdAt) : NaN;

  const toolCalls: AntigravityToolCall[] = [];
  if (Array.isArray(value.tool_calls)) {
    for (const entry of value.tool_calls) {
      const call = readAntigravityToolCall(entry);
      if (call) toolCalls.push(call);
    }
  }

  return {
    stepIndex,
    source,
    type,
    status: readStringField(value, 'status'),
    timestampMs: Number.isFinite(parsed) ? parsed : null,
    content: readStringField(value, 'content'),
    thinking: readStringField(value, 'thinking'),
    toolCalls,
  };
}

/**
 * Parse a slice of a transcript file, one line at a time.
 *
 * A line that does not parse is counted and dropped; the rest of the slice is
 * still read. That is the whole answer to "the file is being appended to while
 * we read it" — the only line a concurrent write can damage is the last one, and
 * losing it costs this poll rather than the file.
 *
 * @param text - The bytes read, decoded as UTF-8
 */
export function parseAntigravityTranscript(text: string): AntigravityTranscriptParse {
  const records: AntigravityTranscriptRecord[] = [];
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
    const record = readAntigravityTranscriptRecord(parsed);
    if (record) records.push(record);
    else malformedLines += 1;
  }

  return { records, malformedLines };
}

/**
 * The `<USER_REQUEST>` block of a `USER_INPUT` record, or null.
 *
 * agy wraps the operator's text and then appends its own `<ADDITIONAL_METADATA>`
 * (the local time) and, on the first prompt of a session,
 * `<USER_SETTINGS_CHANGE>` (which model was picked). Measured at 63/63, 63/63
 * and 40/63 of the corpus's prompts — so the wrapper is the format rather than a
 * quirk, and the two trailers are agy's words rather than the operator's.
 *
 * Positive extraction rather than stripping the trailers: a prompt that itself
 * contained the string `<ADDITIONAL_METADATA>` would survive a strip and lose
 * its tail, while taking only what is inside `<USER_REQUEST>` cannot.
 *
 * @returns The operator's text, or null when the wrapper is absent or empty
 */
export function extractAntigravityUserRequest(content: string): string | null {
  const open = content.indexOf('<USER_REQUEST>');
  if (open === -1) return null;
  const start = open + '<USER_REQUEST>'.length;
  const close = content.indexOf('</USER_REQUEST>', start);
  if (close === -1) return null;
  const text = content.slice(start, close).trim();
  return text.length > 0 ? text : null;
}

/** What one pass over a transcript's records produced. */
export interface AntigravityTurnBuild {
  /** Turns in the order their prompt appeared. */
  readonly turns: readonly AntigravityTurnAccumulator[];
  /**
   * Records that arrived before the first `USER_INPUT` in the window.
   *
   * Not a loss and not an unknown. Two ordinary causes: the 4 MiB window cut the
   * file mid-conversation, and `transcript_full.jsonl` can itself be short of
   * the whole history — one of the corpus's 41 files held a single record while
   * the truncated `transcript.jsonl` beside it held 133. Counted so that "this
   * turn has no prompt" stays a visible fact rather than an assumption.
   */
  readonly preludeRecords: number;
}

/**
 * Group a transcript's records into turns.
 *
 * **File order, and a `USER_INPUT` opens a turn.** Deliberately not sorted by
 * `step_index`: the index is unique but neither contiguous (10 of 41 files have
 * gaps where a refused tool call's step was dropped) nor reliably ascending (one
 * file goes 8 → 7). File order is the order agy appended, which is the order the
 * conversation happened in.
 *
 * @param records - In file order
 * @param conversationId - The conversation these records came from
 */
export function buildAntigravityTurns(
  records: readonly AntigravityTranscriptRecord[],
  conversationId: string
): AntigravityTurnBuild {
  const turns: AntigravityTurnAccumulator[] = [];
  let preludeRecords = 0;

  for (const record of records) {
    if (isAntigravityPromptRecord(record)) {
      const text = record.content ? extractAntigravityUserRequest(record.content) : null;
      const startedAt = record.timestampMs ?? 0;
      turns.push({
        conversationId,
        stepIndex: record.stepIndex,
        startedAt,
        prompt: text
          ? { stepIndex: record.stepIndex, text, timestampMs: record.timestampMs ?? startedAt }
          : null,
        records: [],
        overflowed: false,
      });
      continue;
    }

    const turn = turns.at(-1);
    if (!turn) {
      preludeRecords += 1;
      continue;
    }

    if (turn.records.length >= MAX_ANTIGRAVITY_TURN_RECORDS) {
      turn.overflowed = true;
      continue;
    }
    turn.records.push(record);
  }

  return { turns, preludeRecords };
}

/** Whether this record is the one the operator's own text arrived on. */
export function isAntigravityPromptRecord(record: AntigravityTranscriptRecord): boolean {
  return record.source === ANTIGRAVITY_USER_SOURCE && record.type === ANTIGRAVITY_USER_TYPE;
}

/** One tool call as a single Markdown line. */
function renderToolCall(call: AntigravityToolCall): string {
  return call.detail ? `- \`${call.name}\` — ${call.detail}` : `- \`${call.name}\``;
}

/**
 * A thinking block, folded.
 *
 * A blockquote and not `<details>`, for the reason `../opencode/transcript`
 * documents: `<details>` would require running raw HTML through the card's
 * sanitiser, and that costs every unfenced `<T>` in ordinary prose.
 */
function renderThinking(text: string): string {
  const quoted = text
    .trim()
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
  return `> **${ANTIGRAVITY_THINKING_LABEL}**\n>\n${quoted}`;
}

function collapseToLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function boundDetailText(value: string): string {
  return value.length <= MAX_ANTIGRAVITY_TOOL_DETAIL_LENGTH
    ? value
    : `${value.slice(0, MAX_ANTIGRAVITY_TOOL_DETAIL_LENGTH - 1)}…`;
}

/**
 * Render one turn to Markdown.
 *
 * Transcript order throughout, so a tool line sits where the agent called it and
 * the closing prose sits where the agent wrote it — the same decision #2041,
 * #2121 and #2197 took, and for the same reason: the order is the only record of
 * what happened when, and this row is the record.
 *
 * Within one `PLANNER_RESPONSE` the order is thinking, then prose, then the
 * calls it made. That is agy's own causal order — it reasons, says what it is
 * about to do, and then does it — and 39 of the corpus's records carry prose and
 * `tool_calls` together, so the pairing is the common case rather than an edge.
 */
export function renderAntigravityTurn(
  turn: AntigravityTurnAccumulator
): AntigravityRenderedTurn {
  const rendered: string[] = [];
  const unknown = new Set<string>();
  let textBlocks = 0;
  let toolBlocks = 0;

  for (const record of turn.records) {
    if (record.source === ANTIGRAVITY_MODEL_SOURCE && record.type === ANTIGRAVITY_PLANNER_TYPE) {
      const thinking = record.thinking?.trim() ?? '';
      if (thinking.length > 0) rendered.push(renderThinking(thinking));

      const text = record.content?.trim() ?? '';
      if (text.length > 0) {
        rendered.push(text);
        textBlocks += 1;
      }

      for (const call of record.toolCalls) {
        rendered.push(renderToolCall(call));
        toolBlocks += 1;
      }
      continue;
    }

    if (record.source === ANTIGRAVITY_MODEL_SOURCE) {
      if (!ANTIGRAVITY_TOOL_RESULT_TYPES.has(record.type)) unknown.add(record.type);
      continue;
    }

    if (!ANTIGRAVITY_SYSTEM_TYPES.has(record.type)) unknown.add(record.type);
  }

  let body = joinTurnBlocks(rendered);
  if (body.length > MAX_ANTIGRAVITY_TURN_BODY_LENGTH) {
    body =
      body.slice(0, MAX_ANTIGRAVITY_TURN_BODY_LENGTH - ANTIGRAVITY_TURN_TRUNCATION_MARKER.length) +
      ANTIGRAVITY_TURN_TRUNCATION_MARKER;
  }

  return {
    conversationId: turn.conversationId,
    stepIndex: turn.stepIndex,
    body,
    textBlocks,
    toolBlocks,
    unknownRecordTypes: [...unknown],
  };
}

/**
 * Join the rendered blocks.
 *
 * Consecutive tool lines are joined with a single newline so they stay one
 * Markdown list; everything else is separated by a blank line, which is what
 * keeps a paragraph a paragraph and stops a heading being absorbed into the text
 * above it.
 */
function joinTurnBlocks(blocks: readonly string[]): string {
  let out = '';
  for (let i = 0; i < blocks.length; i += 1) {
    if (i === 0) {
      out = blocks[i];
      continue;
    }
    const bothToolLines = blocks[i].startsWith('- `') && blocks[i - 1].startsWith('- `');
    out += bothToolLines ? `\n${blocks[i]}` : `\n\n${blocks[i]}`;
  }
  return out;
}
