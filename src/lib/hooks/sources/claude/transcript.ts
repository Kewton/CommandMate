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
  /** `timestamp` as epoch ms, or null when absent or unparseable. */
  readonly timestampMs: number | null;
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
  /** Assistant content blocks, in the order the agent produced them. */
  readonly blocks: ClaudeContentBlock[];
  /** How many `type: "assistant"` records contributed. */
  assistantRecords: number;
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

  return {
    type,
    uuid: readStringField(value, 'uuid'),
    sessionId: readStringField(value, 'sessionId') ?? readStringField(value, 'session_id'),
    cwd: readStringField(value, 'cwd'),
    isSidechain: value.isSidechain === true,
    isMeta: value.isMeta === true,
    timestampMs: Number.isFinite(parsed) ? parsed : null,
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

/** A brand-new accumulator for one turn. */
export function createClaudeTurn(
  sessionId: string,
  promptUuid: string,
  startedAt: number
): ClaudeTurnAccumulator {
  return {
    sessionId,
    promptUuid,
    startedAt,
    blocks: [],
    assistantRecords: 0,
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
      current = createClaudeTurn(
        record.sessionId ?? sessionId,
        record.uuid as string,
        record.timestampMs ?? 0
      );
      turns.push(current);
      continue;
    }

    if (record.type !== 'assistant') continue;
    if (!current) {
      orphanedAssistantRecords += 1;
      continue;
    }

    current.assistantRecords += 1;
    for (const block of record.blocks) {
      if (current.blocks.length >= MAX_CLAUDE_TURN_BLOCKS) {
        current.overflowed = true;
        break;
      }
      current.blocks.push(block);
    }
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
 * Transcript order throughout, so a tool line sits where the agent called it and
 * the closing prose sits where the agent wrote it. The Issue asks for a decision
 * between "show every block as a process" and "show only the final block"; this
 * is the first, for the reason the opencode renderer gives — the order is the
 * only record of what happened when, and this row is the record. What makes it
 * readable rather than the run-on paragraph the Issue warns about is that the
 * blocks are *separated*: prose blocks are paragraphs, tool calls are list items
 * and thinking is a quote, so "作業中の独り言" and "回答" are never the same
 * paragraph even though they are in the same row.
 */
export function renderClaudeTurn(turn: ClaudeTurnAccumulator): ClaudeRenderedTurn {
  const rendered: string[] = [];
  const unknown = new Set<string>();
  let textBlocks = 0;
  let toolBlocks = 0;

  for (const block of turn.blocks) {
    if (block.type === 'text') {
      const text = block.text?.trim() ?? '';
      if (text.length === 0) continue;
      rendered.push(text);
      textBlocks += 1;
      continue;
    }
    if (block.type === 'thinking') {
      // Measured empty on the sampled session: the block arrives with its
      // `signature` and no text when the thinking is not retained.
      const text = block.text?.trim() ?? '';
      if (text.length === 0) continue;
      rendered.push(renderThinkingBlock(text));
      continue;
    }
    if (block.type === 'tool_use') {
      rendered.push(renderToolBlock(block));
      toolBlocks += 1;
      continue;
    }
    if (!CLAUDE_SILENT_BLOCK_TYPES.has(block.type)) unknown.add(block.type);
  }

  let body = joinTurnBlocks(rendered);
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
