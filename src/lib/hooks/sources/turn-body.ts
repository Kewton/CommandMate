/**
 * Separating an agent's own words from its tool log (Issue #2234).
 *
 * Four readers — `./claude/transcript`, `./opencode/transcript`,
 * `./codex/transcript` and `./antigravity/transcript` — turn one agent turn into
 * the single Markdown body that becomes one `chat_messages` row. Each of them
 * used to lay the pieces out in transcript order and join them, which put a run
 * of tool-call lines at the **top** of every body that opened with a tool call.
 * Measured on 400 real Claude Code transcripts (2026-09-02,
 * `docs/design/2234-turn-prose-tool-separation.md` §1): **141 of 586 non-empty
 * turns (24 %)** began with `- \`Bash\` — …`. The chat surface (#2232) shows the
 * body in full, so those 141 bubbles opened with a tool log instead of a reply.
 *
 * This module is the one place that decides the layout, and every reader goes
 * through it. Three rules:
 *
 *  1. **Prose leads.** Text the agent wrote keeps its transcript order and comes
 *     first.
 *  2. **The tool log is one section, at the end**, in transcript order, folded
 *     into a blockquote under a labelled heading.
 *  3. **Reasoning is one section too** (Issue #2272), between the two, on the
 *     same shape — see {@link TURN_REASONING_LABEL}.
 *
 * ## Why reasoning became a section of its own (Issue #2272)
 *
 * #2234 moved the tool calls and deliberately left the folded `Thinking` quotes
 * where they sat, on the argument that they are the agent's own words about the
 * reply. Measured against opencode 1.18.22 that argument does not survive
 * contact: opencode emits a `reasoning` part before *every* text part, so the
 * body opens with `> **Thinking**` on a one-line answer and carries four such
 * quotes on a long one — which is exactly the failure #2234 set out to fix, from
 * the other producer.
 *
 * The distinction is therefore drawn on the **block kind**, not on the reader:
 * `reasoning` carries the raw text and is folded into the trailing section,
 * `aside` carries text a reader already folded itself and stays with the prose.
 * The four readers that push `aside` (claude, codex, antigravity, command-code)
 * are untouched by this Issue because none of them has been measured the way
 * opencode has; they can move a block at a time by switching kind, with no
 * change here.
 *
 * ## Why the order claim from #2041 / #2121 is narrowed rather than dropped
 *
 * Those Issues kept strict transcript order on the argument that "the order is
 * the only record of what happened when, and this row is the record". That is
 * still true *within* each kind and is still what this module emits: the tool
 * lines are in call order, and the paragraphs are in the order they were
 * written. What is given up is the interleaving **between** the two — which
 * paragraph a given call sat under. It is given up deliberately, because the
 * surface that reads this row is a chat bubble, and a bubble whose first line is
 * `- \`Bash\` — git status` has already failed the reader before the ordering
 * argument gets a hearing.
 *
 * ## Why a blockquote and not `<details>`
 *
 * Measured, not assumed (§3 of the design note). The card renders with
 * `remarkGfm` + `rehypeSanitize` + `rehypeHighlight` and deliberately **no**
 * `rehypeRaw`, so raw HTML never becomes an element: a `<details>` /
 * `<summary>` wrapper is dropped whole and takes its summary text with it,
 * leaving a bare list and no label. A blockquote with a bold first line is
 * Markdown's own way of saying "subordinate", survives the sanitiser untouched,
 * and is the same shape the four readers already use for `Thinking`.
 *
 * @module lib/hooks/sources/turn-body
 */

/**
 * The bold first line of the folded tool section.
 *
 * English, like the `Thinking` label the four readers already share, and for the
 * same reason: the string is written into `chat_messages.content` at read time,
 * so it is baked into rows that outlive any later locale change and cannot be
 * re-translated by the UI.
 */
export const TURN_TOOL_LOG_LABEL = 'Tool calls';

/**
 * The bold first line of the folded reasoning section (Issue #2272).
 *
 * The same string the five readers already used for their own inline quotes, on
 * purpose: it is baked into `chat_messages.content` at read time, so the rows
 * written before this Issue carry `> **Thinking**` and the rows written after it
 * carry `> **Thinking (N)**`. Keeping the label identical is what lets one
 * reader on the chat surface fold both shapes — see `splitChatThinking` in
 * `components/worktree/ChatMessageBubble`.
 */
export const TURN_REASONING_LABEL = 'Thinking';

/** What one already-rendered piece of a turn is. */
export type TurnBlockKind =
  /** Text the agent wrote for the operator to read. */
  | 'prose'
  /**
   * Already-folded subordinate prose the reader quoted itself.
   *
   * Stays with the prose, in transcript order. A reader that wants its
   * reasoning folded into the trailing section passes `reasoning` instead.
   */
  | 'aside'
  /**
   * RAW reasoning text, to be folded into the trailing section (Issue #2272).
   *
   * Raw and not pre-quoted because the section owns the quoting: N blocks go
   * under ONE `Thinking (N)` heading, so a block that arrived already wearing a
   * heading of its own would nest one label inside another.
   */
  | 'reasoning'
  /** One tool call, rendered as a single Markdown list item. */
  | 'tool';

/** One rendered piece of a turn, tagged with what produced it. */
export interface TurnRenderBlock {
  readonly kind: TurnBlockKind;
  /** The Markdown for this piece. Never empty — callers drop empties. */
  readonly text: string;
}

/** What {@link separateTurnBody} answers. */
export interface SeparatedTurnBody {
  /** {@link prose}, {@link reasoningLog} and {@link toolLog}, joined; what the row stores. */
  readonly body: string;
  /** The `prose` and `aside` blocks, in order. Empty when the turn only ran tools. */
  readonly prose: string;
  /** The folded reasoning section, or an empty string when the turn showed none. */
  readonly reasoningLog: string;
  /** How many `reasoning` blocks that section holds. */
  readonly reasoningBlocks: number;
  /** The folded tool section, or an empty string when the turn called nothing. */
  readonly toolLog: string;
  /** How many `tool` blocks the section holds. */
  readonly toolCalls: number;
}

/**
 * Put one block inside a blockquote, line by line.
 *
 * Every line gets its own `> ` because a blockquote ends at the first line that
 * has none — a lazy continuation would work in CommonMark for a paragraph and
 * would NOT for the list items the tool log is made of.
 *
 * For a tool line the split is a guard rather than a case that is expected to
 * fire: the five readers all render a call as a single-line list item and
 * collapse whitespace precisely so a heredoc in a shell command cannot put a
 * newline here. For a reasoning block it is the normal path — that text is
 * paragraphs.
 */
function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((part) => (part.length > 0 ? `> ${part}` : '>'))
    .join('\n');
}

/**
 * Lay one turn's rendered blocks out as the body a history row stores.
 *
 * Pure: same blocks in, same string out, no clock and no I/O. That is what lets
 * the settled row (each source's `history` module) and the live
 * `chat_turn_progress` bubble
 * (#2199) agree — both reach this function through the same renderer, so the
 * text a reader watches being written is the text that settles.
 *
 * A turn with neither a tool call nor a `reasoning` block comes out
 * **byte-identical** to what the readers produced before #2234 / #2272: the
 * whole change is the sections this adds.
 *
 * @param blocks - Rendered pieces in transcript order; empty text is the
 *   caller's to drop
 * @returns The body and the three parts it was built from
 */
export function separateTurnBody(blocks: readonly TurnRenderBlock[]): SeparatedTurnBody {
  const prose: string[] = [];
  const reasoning: string[] = [];
  const tools: string[] = [];

  for (const block of blocks) {
    if (block.text.length === 0) continue;
    if (block.kind === 'tool') tools.push(block.text);
    else if (block.kind === 'reasoning') reasoning.push(block.text);
    else prose.push(block.text);
  }

  // A blank line between every pair, which is what keeps a paragraph a paragraph
  // and stops a heading being absorbed into the text above it. #2041's join had
  // a second rule — consecutive tool lines joined by a single newline so they
  // stayed one Markdown list — which is gone because no tool line reaches this
  // list any more.
  const proseText = prose.join('\n\n');

  // One heading for the whole run, and a bare `>` between the blocks so two
  // consecutive thoughts stay two paragraphs inside the quote rather than
  // running into one another.
  const reasoningLog =
    reasoning.length === 0
      ? ''
      : [
          `> **${TURN_REASONING_LABEL} (${reasoning.length})**`,
          '>',
          reasoning.map(quoteBlock).join('\n>\n'),
        ].join('\n');

  const toolLog =
    tools.length === 0
      ? ''
      : [
          `> **${TURN_TOOL_LOG_LABEL} (${tools.length})**`,
          '>',
          ...tools.map(quoteBlock),
        ].join('\n');

  // Prose, then reasoning, then the tool log. The tool log stays last because
  // #2234 put it there and the readers' rows are matched on `request_id` rather
  // than rewritten, so moving it would split History into two layouts for no
  // gain.
  const body = [proseText, reasoningLog, toolLog].filter((part) => part.length > 0).join('\n\n');

  return {
    body,
    prose: proseText,
    reasoningLog,
    reasoningBlocks: reasoning.length,
    toolLog,
    toolCalls: tools.length,
  };
}
