/**
 * Taking the tool log out of a chat body so the reply is what the row opens
 * with (Issue #2284).
 *
 * ## What is in the rows
 *
 * Since #2234 the five transcript readers (claude / codex / opencode /
 * antigravity / command-code) all lay one turn out through `separateTurnBody`:
 * prose first, then the reasoning section, then ONE trailing blockquote whose
 * first line is `> **Tool calls (N)**`, a bare `>`, and one `> - \`Bash\` — …`
 * line per call. `ChatMarkdownBody` drew that as a blockquote — a left rule and
 * muted text — so a turn that called twenty tools put twenty lines of log
 * underneath every reply.
 *
 * ## Why the fold happens here and not in the writer
 *
 * `<details>`/`<summary>` cannot survive the chat renderer: it runs
 * `rehypeSanitize` with no `rehypeRaw`, so raw HTML in an agent-authored body
 * never becomes an element (measured in
 * `docs/design/2234-turn-prose-tool-separation.md` §3). There is therefore no
 * Markdown the writer could emit that a reader would fold. The renderer is the
 * only place the section can be turned into a chip — which is also the only
 * place that can fold the rows ALREADY saved, and #2234 does not rewrite them:
 * the legacy shape (a leading run of `- \`Bash\` — …` lines) is still on 36
 * claude rows from the last 30 days.
 *
 * ## Pure, total and byte-preserving
 *
 * Any string in, a `ChatToolLogSplit` out, no clock and no I/O. A body with no
 * tool log comes back with `prose` **byte-identical** to the input, which is
 * what keeps every hand-typed and terminal-scraped bubble exactly as #2245 and
 * #2272 left it. This function runs on every Markdown bubble in the column on
 * every render, so the cheap reject comes first.
 */

import { TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

// ============================================================================
// Shapes
// ============================================================================

/**
 * The heading `separateTurnBody` writes in front of the trailing section.
 *
 * Built from {@link TURN_TOOL_LOG_LABEL} rather than from a second copy of the
 * string: the label is baked into `chat_messages.content` at read time, so the
 * writer and this reader have to agree on it forever and two literals would
 * drift the first time either was touched. `(N)` is optional because a reader
 * that emitted the heading without a count would otherwise stop folding.
 *
 * Anchored to the whole line, so `> **Thinking (4)**` and a paragraph that
 * merely mentions tool calls cannot match.
 */
const TOOL_LOG_HEADING = new RegExp(
  `^>[ \\t]*\\*\\*${TURN_TOOL_LOG_LABEL}(?:[ \\t]*\\((\\d+)\\))?\\*\\*[ \\t]*$`,
);

/**
 * One tool call in the shape the readers wrote BEFORE #2234 put them in a
 * blockquote: an unquoted Markdown list item naming the tool in backticks,
 * optionally followed by an em-dashed detail.
 *
 * Both `renderToolBlock` (claude) and `renderToolItem` (codex) compose exactly
 * `- \`<name>\`` or `- \`<name>\` — <detail>`, and the detail is collapsed to
 * one line by the reader, so the whole call is always one line. Matching that
 * precisely is what stops an ordinary prose list — which is written `- foo`,
 * with no backticked first token — being mistaken for a tool log.
 */
const LEGACY_TOOL_LINE = /^- `[^`\n]+`(?: — .*)?$/;

/** What {@link splitToolLog} answers. */
export interface ChatToolLogSplit {
  /**
   * The body with the tool section removed. Byte-identical to the input when
   * there was none; empty for a turn that only ran tools.
   */
  readonly prose: string;
  /**
   * The tool log as plain Markdown — the `> ` quoting taken back off, so the
   * chip can render it through the same renderer as the prose. Empty when the
   * body carried no tool log.
   */
  readonly toolLog: string;
  /** How many calls the chip stands for; 0 when {@link toolLog} is empty. */
  readonly toolCalls: number;
}

/** Nothing to fold: the body is the prose, unchanged. */
function unfolded(content: string): ChatToolLogSplit {
  return { prose: content, toolLog: '', toolCalls: 0 };
}

/** Take the `> ` back off one quoted section and trim the blank edges. */
function unquoteSection(lines: readonly string[]): string {
  return lines
    .map((line) => line.replace(/^>[ \t]?/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * How many calls a section holds when its heading declared no count.
 *
 * Non-empty lines, not list items: a reader that stops writing `- ` would
 * otherwise report a section of ten calls as a section of none, and the chip
 * would claim the log is empty while showing ten rows.
 */
function countEntries(toolLog: string): number {
  return toolLog.split('\n').filter((line) => line.trim().length > 0).length;
}

// ============================================================================
// The split
// ============================================================================

/**
 * Split one Markdown body into the reply and the tool log behind it.
 *
 * Two shapes are recognised, in this order:
 *
 *  1. **#2234's section.** The LAST block of the body is a blockquote whose
 *     first line is the {@link TOOL_LOG_HEADING} and every line from there to
 *     the end is quoted. "Last block" and "opens the quote" together are what
 *     stop a heading nested in the middle of some larger quote being torn out
 *     of it, and what stop a body that merely ends in a quotation being folded.
 *  2. **The legacy leading run.** Every line from the first is a
 *     {@link LEGACY_TOOL_LINE}, which is what the readers wrote before #2234
 *     moved the log to the end — the shape that put a tool log at the TOP of
 *     24 % of claude turns and is still in the database.
 *
 * A `> **Thinking**` section is deliberately NOT touched: it stays in `prose`
 * for `splitChatThinking` to fold into its own chip, which is the reader that
 * already knows both of that section's shapes.
 *
 * @param content - The Markdown body of one message, or the live progress body
 * @returns The prose, the unquoted tool log and how many calls it holds
 */
export function splitToolLog(content: string): ChatToolLogSplit {
  if (typeof content !== 'string' || content.length === 0) return unfolded(content ?? '');

  // The cheap reject: neither shape can be present without one of these, and
  // this runs on every Markdown bubble in the column on every render.
  if (!content.includes(TURN_TOOL_LOG_LABEL) && !content.startsWith('- `')) {
    return unfolded(content);
  }

  const lines = content.split('\n');

  // --- 1. The trailing section -------------------------------------------
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim().length === 0) end -= 1;

  for (let index = end - 1; index >= 0; index -= 1) {
    const heading = TOOL_LOG_HEADING.exec(lines[index]);
    if (!heading) {
      // A line that is not quoted at all ends the candidate block: the section
      // this Issue folds is the one the body ENDS with.
      if (!lines[index].startsWith('>')) break;
      continue;
    }
    // The heading has to OPEN the quote it heads. A quoted line above it means
    // this is a heading inside somebody else's blockquote.
    if (index > 0 && lines[index - 1].startsWith('>')) break;

    const toolLog = unquoteSection(lines.slice(index + 1, end));
    const declared = heading[1] ? Number.parseInt(heading[1], 10) : 0;
    return {
      prose: lines.slice(0, index).join('\n').replace(/\n+$/, ''),
      toolLog,
      toolCalls: Number.isFinite(declared) && declared > 0 ? declared : countEntries(toolLog),
    };
  }

  // --- 2. The legacy leading run -----------------------------------------
  let run = 0;
  while (run < lines.length && LEGACY_TOOL_LINE.test(lines[run])) run += 1;
  if (run === 0) return unfolded(content);

  return {
    prose: lines.slice(run).join('\n').replace(/^\n+/, ''),
    toolLog: lines.slice(0, run).join('\n'),
    toolCalls: run,
  };
}
