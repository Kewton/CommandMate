/**
 * Turning Claude Code's transcript JSONL back into the reply the agent wrote
 * (Issue #2121).
 *
 * The counterpart of `../opencode/transcript`, for the tool that has no server
 * to subscribe to. Claude writes every record of a session to
 * `~/.claude/projects/<slug>/<session-id>.jsonl` as it goes, and that file holds
 * the Markdown source of the reply — unwrapped, ungutterd, and with the
 * operator's own prompt on a record of its own rather than echoed into the
 * agent's.
 *
 * ## Why this exists rather than a better cleaner
 *
 * The same argument as #2041, plus one measurement that is specific to Claude.
 * The Issue put the poller's saved `assistant` row at **13,253 characters**
 * against the transcript's **3,669**, and the extra 9,584 were *the operator's
 * own prompt*: the pane echoes it, `cleanClaudeResponse` has no way to tell the
 * echo from the reply, and so History recorded the human's words as the agent's.
 * That is not a rendering defect this module improves on — it is a defect this
 * module structurally cannot have, because the prompt and the reply arrive on
 * records with different `type`s and only `type: "assistant"` is read.
 *
 * ## What was measured
 *
 * Against Claude Code's live transcripts on 2026-08-31, and the 512 project
 * directories under `~/.claude/projects` on this machine:
 *
 *  1. **The directory name is a pure function of `cwd`** — every non
 *     alphanumeric byte becomes `-`. Checked against all 512 directories that
 *     contained a record with a `cwd`: 512 agreed, 0 disagreed. See
 *     {@link claudeProjectSlug}.
 *  2. **One assistant record carries one content block**, and a turn is made of
 *     many of them. A single unfinished prompt already held 55 assistant records
 *     across 23 `requestId`s; the Issue measured 98 for a finished one. The turn
 *     is therefore keyed on the *prompt* record, never on a `requestId`.
 *  3. **`type: "user"` is mostly not the user.** Of 19 user records in the
 *     sampled session, 18 were `tool_result` payloads. Tool results, `isMeta`
 *     placeholders (`[Image: original 1440x2170…]`), and the slash-command
 *     bookkeeping records (`<command-name>`, `<local-command-stdout>`) all have
 *     `type: "user"` and none of them is a prompt. See {@link isClaudePromptRecord}.
 *  4. **`thinking` blocks can be empty.** The block arrives with a `signature`
 *     and `thinking: ""` when the text is not retained, so an empty one is
 *     skipped rather than rendered as a blank quote.
 *
 * ## Pure on purpose
 *
 * No filesystem, no database, no `globalThis` — `./history` owns all three. The
 * consequence is that "the saved body equals the transcript's text" is a
 * property a test can assert against a fixture rather than a claim, which is
 * the same reason `../opencode/transcript` is written this way.
 *
 * @module lib/hooks/sources/claude/transcript
 */

import { isPlainObject, readStringField } from '../event-mapper';
import { separateTurnBody, type TurnRenderBlock } from '../turn-body';

/**
 * `~/.claude/projects/<slug>` — the directory Claude keeps one project's
 * sessions in, relative to the home directory.
 */
export const CLAUDE_PROJECTS_DIR_SEGMENTS: readonly string[] = ['.claude', 'projects'];

/**
 * The directory name Claude derives from a working directory.
 *
 * Every byte that is not `[A-Za-z0-9]` becomes `-`, including the separators,
 * the dots of a hidden directory and the underscores of `github_kewton`. Case is
 * preserved. Verified exhaustively rather than assumed: on 2026-08-31 the rule
 * was applied to the `cwd` recorded inside a transcript in each of the 512
 * project directories on this machine that had one, and reproduced the
 * directory name in 512 cases out of 512.
 *
 * A path that is not this instance's `cwd` produces a directory that does not
 * exist, which `./history` reads as "no transcript" and falls back to the
 * scraper for. There is no failure mode where a wrong slug reaches a *different*
 * session's file: two different `cwd`s cannot collide unless they differ only in
 * non-alphanumeric bytes, and two worktrees whose paths differ only in `_` vs
 * `-` are the same directory to nobody but this function.
 *
 * @param cwd - Absolute working directory, as the agent reports it
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Longest body written for one turn. Same bound and reason as opencode's. */
export const MAX_CLAUDE_TURN_BODY_LENGTH = 200_000;

/** Appended when {@link MAX_CLAUDE_TURN_BODY_LENGTH} truncates a turn. */
export const CLAUDE_TURN_TRUNCATION_MARKER = '\n\n_(truncated)_';

/**
 * Cap on content blocks kept for one turn.
 *
 * Generous because a Claude turn is genuinely large — the measured session ran
 * 32 `tool_use` blocks in one reply — and because the overflow is reported
 * rather than hidden.
 */
export const MAX_CLAUDE_TURN_BLOCKS = 2048;

/** Longest tool detail put on a summary line. */
export const MAX_CLAUDE_TOOL_DETAIL_LENGTH = 200;

/** The label a thinking block is folded behind. Same word opencode uses. */
export const CLAUDE_THINKING_LABEL = 'Thinking';

/**
 * Prefixes that mark a `type: "user"` record as bookkeeping rather than a prompt.
 *
 * All four were observed on real transcripts. `<local-command-caveat>` and the
 * `<command-…>` trio are how a slash command is recorded; `<local-command-stdout>`
 * is its output. Treating any of them as a prompt would open a turn that the
 * operator never typed, and the reply to the *next* real prompt would be filed
 * under it.
 */
const CLAUDE_SYNTHETIC_PROMPT_PREFIXES: readonly string[] = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
];

/** One content block of one record, reduced to what a reader needs. */
export interface ClaudeContentBlock {
  /** `text` / `thinking` / `tool_use` / `tool_result` / … verbatim. */
  readonly type: string;
  /** `text` for a text block, `thinking` for a thinking block; null otherwise. */
  readonly text: string | null;
  /** `name` on a `tool_use` block (`Bash`, `Read`, …); null otherwise. */
  readonly toolName: string | null;
  /** The one-line summary of a `tool_use` block's input; null when it has none. */
  readonly toolDetail: string | null;
}

/** One line of the transcript, reduced to what a reader needs. */
export interface ClaudeTranscriptRecord {
  /** `user` / `assistant` / `system` / one of the ten bookkeeping types. */
  readonly type: string;
  /** The record's own id; the turn key when this record is a prompt. */
  readonly uuid: string | null;
  /** `sessionId`, which every user and assistant record carries. */
  readonly sessionId: string | null;
  /** The agent's working directory. */
  readonly cwd: string | null;
  /** True for a sub-agent's records. See {@link buildClaudeTurns}. */
  readonly isSidechain: boolean;
  /** True for a record Claude injected on the user's behalf. */
  readonly isMeta: boolean;
  /**
   * `origin.kind` — who this record came from (Issue #2196).
   *
   * Two values were observed on 744 live transcripts: `human` (528) and
   * `task-notification` (279). See {@link isClaudeOperatorPromptRecord}.
   */
  readonly originKind: string | null;
  /**
   * `promptSource` — how the prompt reached the agent (Issue #2196).
   *
   * Observed: `typed`, `queued`, `system`, `sdk`.
   */
  readonly promptSource: string | null;
  /** True for the summary Claude injects after `/compact` (Issue #2196). */
  readonly isCompactSummary: boolean;
  /**
   * True for the `[Request interrupted by user…]` record (Issue #2196).
   *
   * Recognised by `interruptedMessageId`, which is the field the record carries
   * and the text is not — the sentence itself is localised prose and matching on
   * it would be matching on a translation.
   */
  readonly isInterruption: boolean;
  /** `timestamp` as epoch ms, or null when absent or unparseable. */
  readonly timestampMs: number | null;
  /**
   * `message.stop_reason` — why the agent stopped producing this record (#2264).
   *
   * Present on `assistant` records and null everywhere else. Two values carry
   * the whole of what this reader needs, and the census behind them is in the
   * Issue: across the transcript the incident was measured on, **170 assistant
   * records carried a `stop_reason`, 79 of them `end_turn` and 16 `tool_use`**,
   * and the correspondence was exact — a record that ends the reply says
   * `end_turn`, one that hands over to a tool says `tool_use`.
   *
   * This is the field #2264 exists because nobody read: without it the reader
   * cannot tell "the agent has finished" from "the agent is between tool calls",
   * and a Stop hook that arrives in the gap writes the second as if it were the
   * first. Re-measured on 2026-09-03 over the 40 most recently written
   * transcripts under `~/.claude/projects`: **7,147 assistant records, all 7,147
   * carrying the field** — 6,899 `tool_use` and 248 `end_turn`, none absent and
   * none null.
   *
   * See {@link ClaudeTurnAccumulator.closed}.
   */
  readonly stopReason: string | null;
  /** `message.content`, normalised; empty for records that carry no message. */
  readonly blocks: readonly ClaudeContentBlock[];
  /**
   * The record's text with every block concatenated.
   *
   * Only used to decide whether a `user` record is a prompt. Deliberately never
   * written to History — that is the whole point of this module.
   */
  readonly text: string;
}

/** One turn: everything the agent produced in reply to one prompt. */
export interface ClaudeTurnAccumulator {
  /** The session the turn was read from. */
  readonly sessionId: string;
  /** `uuid` of the user record that opened the turn; the turn's identity. */
  readonly promptUuid: string;
  /** Epoch ms of the prompt record, so the row is dated by the agent's clock. */
  readonly startedAt: number;
  /**
   * The prompt record's own text (Issue #2196).
   *
   * Written to History as a `user` row — but only when
   * {@link promptIsOperatorInput} says a person produced it. Note that #2121
   * documents this text as "deliberately never written to History"; that held
   * while the only row a turn produced was the *assistant* row, and the sentence
   * it was defending — the prompt must never end up inside the reply — is still
   * true and still asserted.
   */
  readonly promptText: string;
  /** Whether {@link isClaudeOperatorPromptRecord} accepted the prompt record. */
  readonly promptIsOperatorInput: boolean;
  /** Assistant content blocks, in the order the agent produced them. */
  readonly blocks: ClaudeContentBlock[];
  /** How many `type: "assistant"` records contributed. */
  assistantRecords: number;
  /**
   * True when the agent said this turn was over (Issue #2264).
   *
   * The rule is {@link isClaudeTurnClosingRecord} applied to the turn's **last**
   * assistant record: `stop_reason === "end_turn"` *and* a non-empty `text`
   * block on the same record. Both halves are load-bearing and both come off the
   * incident:
   *
   *  - `end_turn` alone is not enough. The sampled transcript held an `end_turn`
   *    record whose only block was `thinking`, and a turn that stops after
   *    thinking is one Claude Code resumes.
   *  - the text block alone is not enough either, and this is the failure that
   *    was measured: a turn cut off after its `tool_use` records still renders a
   *    non-empty body — `renderClaudeTurn` draws the calls as a trailing tool
   *    section — so the emptiness guard on the writer never fires and a reply
   *    with **no prose in it at all** was written and frozen under the turn key.
   *
   * False is therefore the honest answer for a turn in flight, and
   * `./history`'s writer treats it as "hand this back to the scraper", exactly
   * as `../codex/history` treats a `turn_id` with no `task_complete`.
   */
  closed: boolean;
  /**
   * True when a later prompt record opened another turn (Issue #2264).
   *
   * The second, independent proof that nothing more will be appended here, and
   * the reason {@link closed} did not have to be made a *precondition of
   * writing* — which would have regressed #2246's backfill.
   *
   * A turn is superseded exactly when it is not the last one in the window, and
   * an agent that has moved on to another prompt will never add a record to the
   * one before it. That covers the case `closed` cannot: a turn the operator
   * **interrupted** ends on a `tool_use` record and never gets its `end_turn`,
   * and it is still a finished turn whose reply nobody else is going to write.
   * The real antigravity capture in `tests/fixtures/transcripts/antigravity`
   * contains exactly that shape, which is how the omission was noticed.
   *
   * So the writable predicate is `closed || superseded`
   * ({@link isClaudeTurnWritable}), and the gate #2264 adds bites on precisely
   * the turn the incident was about: the newest one, still open.
   */
  superseded: boolean;
  /**
   * True once an assistant record of this turn carried a `stop_reason` (#2264).
   *
   * The evidence check behind {@link closed}, and the reason a Claude release
   * that stopped writing the field would degrade rather than break. Measured on
   * 2026-09-03 over the 40 most recently written transcripts under
   * `~/.claude/projects`: **7,147 assistant records, 7,147 with a `stop_reason`**
   * (6,899 `tool_use`, 248 `end_turn`) and not one without. So in production this
   * is true for every turn that has an assistant record at all, and the branch it
   * guards is unreachable.
   *
   * It is here for the shape that measurement cannot rule out — a later Claude
   * that drops or renames the field. `closed` would then be false on every turn
   * forever, and a writer that refuses every turn forever is a transcript reader
   * that has silently switched itself off. Falling back to the pre-#2264
   * behaviour instead loses the #2264 guarantee and nothing else; see
   * {@link isClaudeTurnWritable}.
   */
  stopReasonObserved: boolean;
  /** True once a block had to be dropped for {@link MAX_CLAUDE_TURN_BLOCKS}. */
  overflowed: boolean;
}

/** What one rendered turn is. */
export interface ClaudeRenderedTurn {
  readonly sessionId: string;
  readonly promptUuid: string;
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
export interface ClaudeTranscriptParse {
  readonly records: readonly ClaudeTranscriptRecord[];
  /**
   * Lines that were not valid JSON, or were JSON but not an object.
   *
   * Expected to be non-zero and harmless. Claude appends to this file while
   * CommandMate reads it, so the last line of a read taken mid-write is a
   * fragment — which is exactly why parsing is per line and a failure costs one
   * record rather than the file. The Issue lists this as unmeasured; it is
   * handled by construction instead of by measurement, because a reader that
   * only works when the writer happens to be idle is not a reader.
   */
  readonly malformedLines: number;
}

/**
 * Read one `message.content` element.
 *
 * @returns The block, or null when it is not an object with a `type`
 */
export function readClaudeContentBlock(value: unknown): ClaudeContentBlock | null {
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
  // than by trying both on every block so that a future block type carrying an
  // unrelated `text` field is not silently rendered as prose.
  const text =
    type === 'text'
      ? (readStringField(value, 'text') ?? '')
      : type === 'thinking'
        ? (readStringField(value, 'thinking') ?? '')
        : null;

  return { type, text, toolName: null, toolDetail: null };
}

/**
 * The fields of a `tool_use` input worth putting on the summary line, in
 * preference order.
 *
 * The command for `Bash`, the path for the file tools, the pattern for the
 * search tools, and `description` last as the tool's own words about itself.
 * Anything else renders as the bare tool name, which is what the operator saw
 * on the TUI's tool row anyway.
 */
const CLAUDE_TOOL_DETAIL_FIELDS: readonly string[] = [
  'command',
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'query',
  'url',
  'description',
];

/** The first present detail field of a `tool_use` input, collapsed to a line. */
function readToolDetail(input: unknown): string | null {
  if (!isPlainObject(input)) return null;
  for (const field of CLAUDE_TOOL_DETAIL_FIELDS) {
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
  return value.length <= MAX_CLAUDE_TOOL_DETAIL_LENGTH
    ? value
    : `${value.slice(0, MAX_CLAUDE_TOOL_DETAIL_LENGTH - 1)}…`;
}

/**
 * Read one parsed transcript line.
 *
 * @returns The record, or null when the value is not an object with a `type`
 */
export function readClaudeTranscriptRecord(value: unknown): ClaudeTranscriptRecord | null {
  if (!isPlainObject(value)) return null;
  const type = readStringField(value, 'type');
  if (!type) return null;

  const message = isPlainObject(value.message) ? value.message : null;
  const rawContent = message?.content;

  const blocks: ClaudeContentBlock[] = [];
  let text = '';
  if (typeof rawContent === 'string') {
    // A prompt the operator typed arrives as a bare string, not as an array.
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    for (const entry of rawContent) {
      const block = readClaudeContentBlock(entry);
      if (!block) continue;
      blocks.push(block);
      if (block.text) text += block.text;
    }
  }

  const timestamp = readStringField(value, 'timestamp');
  const parsed = timestamp ? Date.parse(timestamp) : NaN;
  const origin = isPlainObject(value.origin) ? value.origin : null;

  return {
    type,
    uuid: readStringField(value, 'uuid'),
    sessionId: readStringField(value, 'sessionId') ?? readStringField(value, 'session_id'),
    cwd: readStringField(value, 'cwd'),
    isSidechain: value.isSidechain === true,
    isMeta: value.isMeta === true,
    originKind: origin ? readStringField(origin, 'kind') : null,
    promptSource: readStringField(value, 'promptSource'),
    isCompactSummary: value.isCompactSummary === true,
    isInterruption: readStringField(value, 'interruptedMessageId') !== null,
    timestampMs: Number.isFinite(parsed) ? parsed : null,
    stopReason: message ? readStringField(message, 'stop_reason') : null,
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
export function parseClaudeTranscript(text: string): ClaudeTranscriptParse {
  const records: ClaudeTranscriptRecord[] = [];
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
    const record = readClaudeTranscriptRecord(parsed);
    if (record) records.push(record);
    else malformedLines += 1;
  }

  return { records, malformedLines };
}

/**
 * Whether this record is the operator's own prompt.
 *
 * Four things disqualify a `type: "user"` record, and all four were observed:
 *
 *  - it carries a `tool_result` block — 18 of the 19 user records in the sampled
 *    session were these;
 *  - `isMeta` is true — the image placeholders and the local-command caveat;
 *  - its text opens with one of {@link CLAUDE_SYNTHETIC_PROMPT_PREFIXES} — the
 *    slash-command bookkeeping;
 *  - it has no text at all, or no `uuid` to name the turn with.
 *
 * Everything else is treated as a prompt, including `[Request interrupted by
 * user]`. That is deliberate: an interruption really does end the turn, and the
 * records after it really do belong to whatever came next.
 */
export function isClaudePromptRecord(record: ClaudeTranscriptRecord): boolean {
  if (record.type !== 'user') return false;
  if (record.isMeta) return false;
  if (!record.uuid) return false;
  if (record.blocks.some((block) => block.type === 'tool_result')) return false;
  const text = record.text.trim();
  if (text.length === 0) return false;
  return !CLAUDE_SYNTHETIC_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * `origin.kind` for a record the person at the keyboard produced (Issue #2196).
 */
export const CLAUDE_HUMAN_ORIGIN_KIND = 'human';

/**
 * `promptSource` values that mean "the operator's own input" (Issue #2196).
 *
 * `typed` is the composer. `queued` is the composer too — text entered while the
 * agent was still answering the previous prompt, which Claude holds and submits
 * when the turn ends. The two that are excluded are excluded on measurement:
 * `system` (always paired with `origin.kind = "task-notification"`) and `sdk`
 * (a headless `claude -p` run, which has no chat pane to appear in).
 */
export const CLAUDE_HUMAN_PROMPT_SOURCES: readonly string[] = ['typed', 'queued'];

/**
 * Whether this record is text a human typed at the terminal (Issue #2196).
 *
 * Strictly narrower than {@link isClaudePromptRecord}, and the two are not
 * interchangeable. That one answers "does a turn start here", which every
 * prompt-shaped record does — a task notification really is answered, and the
 * reply really does belong to it. This one answers "should this text appear in
 * History as the operator's message", which is a different question with a
 * different cost of being wrong: a wrong `true` puts machinery
 * (`<task-notification>…`, a compaction summary, a skill's whole SKILL.md) in
 * the chat pane as if the operator had said it.
 *
 * ## Positive evidence, not a deny list
 *
 * The rule is `origin.kind === "human"` **or** a `promptSource` on
 * {@link CLAUDE_HUMAN_PROMPT_SOURCES} — a record that claims neither produces no
 * row. That direction was chosen on a census rather than on taste: across all
 * 744 transcripts under `~/.claude/projects` on 2026-09-01, of the 4,943
 * `type: "user"` records that survive {@link isClaudePromptRecord}, **4,909
 * carried one of the two markers and 34 did not — and all 34 were `/compact` or
 * `[Request interrupted by user for tool use]`, not one of them a prompt.** The
 * markers are present on every version in the sample (2.1.215 … 2.1.252).
 *
 * So the deny-list framing had nothing left to deny that the markers do not
 * already exclude, and it fails the wrong way: a record shape a later Claude
 * invents would default to *being shown*. This defaults to being skipped, which
 * is the pre-#2196 behaviour — an orphaned assistant pair, which is untidy, and
 * not a fabricated user message, which is wrong.
 *
 * `isCompactSummary` and `isInterruption` are then checked explicitly even
 * though nothing observed carries a human marker *and* either flag. They are not
 * redundant by construction: compaction and interruption are both things the
 * operator initiates, so a later version stamping `origin.kind = "human"` on
 * them would be defensible from Claude's side and wrong from this one's.
 */
export function isClaudeOperatorPromptRecord(record: ClaudeTranscriptRecord): boolean {
  if (!isClaudePromptRecord(record)) return false;
  if (record.isCompactSummary) return false;
  if (record.isInterruption) return false;
  if (record.originKind !== null) return record.originKind === CLAUDE_HUMAN_ORIGIN_KIND;
  return record.promptSource !== null && CLAUDE_HUMAN_PROMPT_SOURCES.includes(record.promptSource);
}

/**
 * `message.stop_reason` on the record that ends a reply (Issue #2264).
 *
 * The other value this reader cares about is `tool_use`, which is not named as
 * a constant because nothing branches on it: everything that is not `end_turn`
 * leaves the turn open.
 */
export const CLAUDE_END_TURN_STOP_REASON = 'end_turn';

/**
 * Whether this assistant record is the one that ended the reply (Issue #2264).
 *
 * `end_turn` **and** prose on the same record. See
 * {@link ClaudeTurnAccumulator.closed} for why neither half alone is the rule,
 * and note that the emptiness test here is the one `renderClaudeTurn` applies to
 * a text block — a block whose `text` trims to nothing is not rendered, so it
 * cannot be what makes a turn look finished either.
 */
export function isClaudeTurnClosingRecord(record: ClaudeTranscriptRecord): boolean {
  if (record.type !== 'assistant') return false;
  if (record.stopReason !== CLAUDE_END_TURN_STOP_REASON) return false;
  return record.blocks.some(
    (block) => block.type === 'text' && (block.text ?? '').trim().length > 0
  );
}

/**
 * Whether a writer may record this turn (Issue #2264).
 *
 * Either proof that nothing more is coming: the agent said so
 * ({@link ClaudeTurnAccumulator.closed}), or it has moved on to another prompt
 * ({@link ClaudeTurnAccumulator.superseded}).
 */
export function isClaudeTurnWritable(turn: ClaudeTurnAccumulator): boolean {
  if (turn.closed || turn.superseded) return true;
  // No record of this turn said why it stopped, so there is no evidence to
  // refuse it on. See {@link ClaudeTurnAccumulator.stopReasonObserved}: this is
  // unreachable against every Claude version measured, and it is what keeps a
  // version that stops writing the field from silently disabling the reader.
  return !turn.stopReasonObserved;
}

/** A brand-new accumulator for one turn. */
export function createClaudeTurn(record: ClaudeTranscriptRecord, sessionId: string): ClaudeTurnAccumulator {
  return {
    sessionId: record.sessionId ?? sessionId,
    promptUuid: record.uuid as string,
    startedAt: record.timestampMs ?? 0,
    promptText: record.text,
    promptIsOperatorInput: isClaudeOperatorPromptRecord(record),
    blocks: [],
    assistantRecords: 0,
    closed: false,
    superseded: false,
    stopReasonObserved: false,
    overflowed: false,
  };
}

/** What one pass over a transcript's records produced. */
export interface ClaudeTurnBuild {
  readonly turns: readonly ClaudeTurnAccumulator[];
  /**
   * Assistant records that arrived before any prompt record.
   *
   * Non-zero means the read started inside a turn — the tail window `./history`
   * uses did not reach back as far as the prompt. Their text is dropped rather
   * than attached to a turn key that would be invented for it, because an
   * invented key is a row no later run can recognise as already written.
   */
  readonly orphanedAssistantRecords: number;
  /** Sub-agent records skipped. See below. */
  readonly sidechainRecords: number;
}

/**
 * Group a transcript's records into turns.
 *
 * File order, and a prompt record opens a turn. Deliberately **not** the
 * `parentUuid` chain, which does not link a reply to its prompt: in the sampled
 * session the first assistant record's `parentUuid` named a record that is not
 * the prompt at all (the bookkeeping lines Claude writes between the two are
 * part of the chain). Order is what actually holds.
 *
 * `isSidechain` records are skipped. They are a sub-agent's conversation, held
 * in the same file as the session that spawned it, and folding a sub-agent's
 * narration into the reply the operator is reading would reintroduce exactly the
 * "work-in-progress muttering runs into the answer" problem the Issue asks this
 * module to solve. The Issue lists sidechains as unmeasured — the sampled
 * session had none — so they are excluded and counted rather than guessed at.
 *
 * @param records - In file order
 * @param sessionId - Fallback for records that carry no `sessionId`
 */
export function buildClaudeTurns(
  records: readonly ClaudeTranscriptRecord[],
  sessionId: string
): ClaudeTurnBuild {
  const turns: ClaudeTurnAccumulator[] = [];
  let current: ClaudeTurnAccumulator | null = null;
  let orphanedAssistantRecords = 0;
  let sidechainRecords = 0;

  for (const record of records) {
    if (record.isSidechain) {
      sidechainRecords += 1;
      continue;
    }

    if (isClaudePromptRecord(record)) {
      current = createClaudeTurn(record, sessionId);
      turns.push(current);
      continue;
    }

    if (record.type !== 'assistant') continue;
    if (!current) {
      orphanedAssistantRecords += 1;
      continue;
    }

    current.assistantRecords += 1;
    // Assigned rather than or-ed, so the value left standing is the *last*
    // assistant record's answer. A turn that ends on a `tool_use` record after
    // an earlier `end_turn` — which is what a turn Claude resumed looks like —
    // is open again, and that is the reading the Issue's census supports.
    current.closed = isClaudeTurnClosingRecord(record);
    if (record.stopReason !== null) current.stopReasonObserved = true;
    for (const block of record.blocks) {
      if (current.blocks.length >= MAX_CLAUDE_TURN_BLOCKS) {
        current.overflowed = true;
        break;
      }
      current.blocks.push(block);
    }
  }

  // Every turn but the last one has a later prompt behind it, and a prompt is
  // proof the agent moved on. See {@link ClaudeTurnAccumulator.superseded}.
  for (let index = 0; index < turns.length - 1; index += 1) {
    turns[index].superseded = true;
  }

  return { turns, orphanedAssistantRecords, sidechainRecords };
}

/**
 * Block types that carry nothing a reader wants.
 *
 * A deny set rather than an allow set, for the reason `../opencode/transcript`
 * gives: a block type a later Claude adds should surface in the unknown tally
 * instead of being silently equivalent to a tool result. `tool_result` is on it
 * because those blocks live on `user` records, which never reach a turn's body.
 */
const CLAUDE_SILENT_BLOCK_TYPES: ReadonlySet<string> = new Set(['tool_result']);

/** One tool call as a single Markdown line. */
function renderToolBlock(block: ClaudeContentBlock): string {
  const name = block.toolName ?? 'tool';
  return block.toolDetail ? `- \`${name}\` — ${block.toolDetail}` : `- \`${name}\``;
}

/**
 * Thinking, folded.
 *
 * A blockquote and not `<details>`, for the reason `../opencode/transcript`
 * documents: `<details>` would require running raw HTML through the card's
 * sanitiser, and that costs every unfenced `<T>` in ordinary prose.
 */
function renderThinkingBlock(text: string): string {
  const quoted = text
    .trim()
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
  return `> **${CLAUDE_THINKING_LABEL}**\n>\n${quoted}`;
}

/**
 * Render one turn to Markdown.
 *
 * Every block is kept — #2121 asked for a decision between "show every block as
 * a process" and "show only the final block" and this is the first, because the
 * order is the only record of what happened when and this row is the record.
 * What makes it readable rather than a run-on paragraph is that the blocks are
 * *separated*: prose blocks are paragraphs, thinking is a quote, and tool calls
 * are list items folded into one labelled section at the end.
 *
 * The layout itself belongs to `../turn-body` (#2234), which is what stops this
 * turn's body opening with a run of `- \`Bash\` — …` lines; see
 * {@link separateTurnBody} for why the interleaving between prose and tool calls
 * is the one thing given up.
 */
export function renderClaudeTurn(turn: ClaudeTurnAccumulator): ClaudeRenderedTurn {
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
      // Measured empty on the sampled session: the block arrives with its
      // `signature` and no text when the thinking is not retained.
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
    if (!CLAUDE_SILENT_BLOCK_TYPES.has(block.type)) unknown.add(block.type);
  }

  let body = separateTurnBody(rendered).body;
  if (body.length > MAX_CLAUDE_TURN_BODY_LENGTH) {
    body =
      body.slice(0, MAX_CLAUDE_TURN_BODY_LENGTH - CLAUDE_TURN_TRUNCATION_MARKER.length) +
      CLAUDE_TURN_TRUNCATION_MARKER;
  }

  return {
    sessionId: turn.sessionId,
    promptUuid: turn.promptUuid,
    body,
    textBlocks,
    toolBlocks,
    unknownBlockTypes: [...unknown],
  };
}
