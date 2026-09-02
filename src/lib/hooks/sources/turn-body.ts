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
 * through it. Two rules:
 *
 *  1. **Prose leads.** Text the agent wrote — and the folded `Thinking` quotes
 *     that sit between the sentences — keep their transcript order and come
 *     first.
 *  2. **The tool log is one section, at the end**, in transcript order, folded
 *     into a blockquote under a labelled heading.
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

/** What one already-rendered piece of a turn is. */
export type TurnBlockKind =
  /** Text the agent wrote for the operator to read. */
  | 'prose'
  /** Already-folded subordinate prose — the `Thinking` / reasoning quotes. */
  | 'aside'
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
  /** {@link prose} and {@link toolLog}, joined; what the row stores. */
  readonly body: string;
  /** The `prose` and `aside` blocks, in order. Empty when the turn only ran tools. */
  readonly prose: string;
  /** The folded tool section, or an empty string when the turn called nothing. */
  readonly toolLog: string;
  /** How many `tool` blocks the section holds. */
  readonly toolCalls: number;
}

/**
 * Quote one already-rendered tool line.
 *
 * The four readers all render a call as a **single-line** list item — their
 * detail readers collapse whitespace precisely so a heredoc in a shell command
 * cannot put a newline here — so one prefix per line is enough and the split is
 * a guard rather than a case that is expected to fire.
 */
function quoteToolLine(line: string): string {
  return line
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
 * A turn with no tool calls comes out **byte-identical** to what the readers
 * produced before this Issue: the whole change is the section this adds.
 *
 * @param blocks - Rendered pieces in transcript order; empty text is the
 *   caller's to drop
 * @returns The body and the two halves it was built from
 */
export function separateTurnBody(blocks: readonly TurnRenderBlock[]): SeparatedTurnBody {
  const prose: string[] = [];
  const tools: string[] = [];

  for (const block of blocks) {
    if (block.text.length === 0) continue;
    if (block.kind === 'tool') tools.push(block.text);
    else prose.push(block.text);
  }

  // A blank line between every pair, which is what keeps a paragraph a paragraph
  // and stops a heading being absorbed into the text above it. #2041's join had
  // a second rule — consecutive tool lines joined by a single newline so they
  // stayed one Markdown list — which is gone because no tool line reaches this
  // list any more.
  const proseText = prose.join('\n\n');

  const toolLog =
    tools.length === 0
      ? ''
      : [
          `> **${TURN_TOOL_LOG_LABEL} (${tools.length})**`,
          '>',
          ...tools.map(quoteToolLine),
        ].join('\n');

  const body =
    proseText.length > 0 && toolLog.length > 0
      ? `${proseText}\n\n${toolLog}`
      : `${proseText}${toolLog}`;

  return { body, prose: proseText, toolLog, toolCalls: tools.length };
}
