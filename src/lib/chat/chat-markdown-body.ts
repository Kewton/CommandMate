/**
 * One split for what a Markdown bubble draws and what its copy button hands
 * over (Issue #2544).
 *
 * ## What was wrong
 *
 * `ChatMarkdownBody` drew the answer and folded everything after it into chips:
 * `splitToolLog` (#2284) took the trailing `Tool calls (N)` section off, then
 * `splitChatThinking` (#2272) took the reasoning. The copy button in
 * `ChatMessageBubble` never went through either of them — it handed over
 * `message.content`, the whole stored row — so a reader who copied a reply got
 * the answer they could see plus every thought and every tool call they could
 * not.
 *
 * ## Why one function rather than calling the two splitters twice
 *
 * The order is load-bearing — `separateTurnBody` lays a turn out as prose, then
 * `Thinking (N)`, then `Tool calls (N)` at the very end, and `splitChatThinking`
 * is written against a body whose tool section is already gone — and so is every
 * rule either splitter adds later. Two call sites composing them by hand are two
 * places for the screen and the clipboard to disagree the first time one of
 * them is touched. The renderer and the copy button both call
 * {@link splitChatMarkdownBody}, and nothing else decides what "the answer" is.
 *
 * ## Pure, total and byte-preserving
 *
 * Any string in, a {@link ChatMarkdownBodySplit} out, no clock and no I/O. A body
 * neither splitter folds comes back with `body` **byte-identical** to the input,
 * which is what keeps the copy of every such row exactly what it was before
 * this Issue.
 */

import { splitChatThinking } from './chat-thinking';
import { splitToolLog } from './chat-tool-log';

/** What {@link splitChatMarkdownBody} answers. */
export interface ChatMarkdownBodySplit {
  /**
   * The answer: the Markdown the bubble draws above its chips, and the Markdown
   * source its copy button hands over. Byte-identical to the input when
   * {@link folded} is false; empty for a turn that only ran tools.
   */
  readonly body: string;
  /** The reasoning chip's contents, unquoted, or null when there is no chip. */
  readonly reasoning: string | null;
  /** How many blocks the reasoning chip stands for; 0 when there is none. */
  readonly reasoningBlocks: number;
  /** The tool-log chip's contents, unquoted; empty when there is no chip. */
  readonly toolLog: string;
  /** How many calls the tool-log chip stands for; 0 when there is none. */
  readonly toolCalls: number;
  /**
   * Whether either splitter took anything out of the input — including a tool
   * heading with no calls under it, which draws no chip but is still not in
   * {@link body}. False means `body === content`.
   */
  readonly folded: boolean;
}

/**
 * Split one agent-authored Markdown body into the answer and the sections that
 * are folded behind it.
 *
 * Both shapes of both sections are recognised, because that is what the two
 * splitters already read: #2234's trailing `> **Tool calls (N)**` section and
 * the legacy leading run of `- \`Bash\` — …` lines; #2272's `> **Thinking (N)**`
 * section and the legacy inline `> **Thinking**` quotes.
 *
 * @param content - The Markdown body of one message, or the live progress body
 * @returns The answer, what each chip holds, and whether anything was folded
 */
export function splitChatMarkdownBody(content: string): ChatMarkdownBodySplit {
  // The tool log comes off FIRST: see the file header on why the order matters.
  const tools = splitToolLog(content);
  const thinking = splitChatThinking(tools.prose);

  return {
    body: thinking.body,
    reasoning: thinking.reasoning,
    reasoningBlocks: thinking.blocks,
    toolLog: tools.toolLog,
    toolCalls: tools.toolCalls,
    folded: tools.prose !== content || thinking.reasoning !== null,
  };
}

/**
 * What the copy button on a Markdown bubble puts on the clipboard, or null when
 * the bubble should offer no copy at all.
 *
 * The answer only, as Markdown source. Null when that answer is blank — a turn
 * that only ran tools draws nothing but its chips, and a copy button there
 * would either put an empty string on the clipboard or, falling back to the
 * whole row, put exactly the folded sections this Issue keeps off it. Copying
 * the whole row is a separate operation (Issue #2545), not a fallback.
 *
 * @param split - {@link splitChatMarkdownBody}'s answer for the row
 */
export function chatMarkdownCopyText(split: ChatMarkdownBodySplit): string | null {
  return split.body.trim().length > 0 ? split.body : null;
}
