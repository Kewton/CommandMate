/**
 * Taking the reasoning out of a chat body so the answer is what the bubble
 * opens with (Issue #2272).
 *
 * Written inside `components/worktree/ChatMessageBubble` by #2272 and moved
 * here, unchanged, by Issue #2544: the copy button now needs the same split the
 * renderer draws, and the one function both of them call
 * (`./chat-markdown-body`) is plain library code that has no business importing
 * a `'use client'` component. `ChatMessageBubble` re-exports every name below,
 * so the suites and comments that reach for them there still find them.
 */

// ============================================================================
// Folded reasoning (Issue #2272)
// ============================================================================

/**
 * The label the five transcript readers write in front of a reasoning quote.
 *
 * It is `lib/hooks/sources/turn-body`'s `TURN_REASONING_LABEL` and is spelled
 * again here rather than imported: the two are only allowed to agree on a string
 * that is already baked into `chat_messages.content` — the rows this reader has
 * to fold were written months before it existed and cannot be re-labelled.
 * `tests/unit/components/worktree/ChatThinking-2272.test.tsx` asserts the two
 * constants are equal, which is the seam that would otherwise drift.
 */
export const CHAT_THINKING_LABEL = 'Thinking';

/**
 * The first line of a reasoning section, in either shape.
 *
 *  - `> **Thinking (4)**` — what `separateTurnBody` writes since #2272.
 *  - `> **Thinking**` — what the five readers wrote inline before it, and what
 *    every row already in the database still holds.
 *
 * Anchored to the whole line so `> **Tool calls (1)**` and a paragraph that
 * merely mentions thinking cannot match.
 */
const CHAT_THINKING_HEADING = /^>[ \t]*\*\*Thinking(?:[ \t]*\((\d+)\))?\*\*[ \t]*$/;

/** What {@link splitChatThinking} answers. */
export interface ChatThinkingSplit {
  /** The body with every reasoning section removed. */
  readonly body: string;
  /** The reasoning, unquoted and joined, or null when the body had none. */
  readonly reasoning: string | null;
  /** How many blocks the chip stands for; 0 when {@link reasoning} is null. */
  readonly blocks: number;
}

/** One quoted section's lines, with the `> ` prefix taken back off. */
function unquoteSection(lines: readonly string[]): string {
  return lines
    .map((line) => line.replace(/^>[ \t]?/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * Take the reasoning out of a body so the answer is what the bubble opens with.
 *
 * ## Why the renderer and not only the writer
 *
 * #2272's writer change fixes rows written from now on. It cannot fix the rows
 * already saved — `writeOpencodeTurn` matches on `request_id` and stands down
 * rather than rewriting — and those are the ones the operator is looking at.
 * Measured against opencode 1.18.22, a `reasoning` part arrives in front of
 * every text part, so *every* saved opencode row opens with `> **Thinking**`.
 * Folding on the read side is what makes the two shapes one chip.
 *
 * ## What counts as a section
 *
 * A line matching {@link CHAT_THINKING_HEADING} that OPENS a blockquote — the
 * line above it is not itself quoted — plus every `>` line that follows it. The
 * "opens" test is what stops a `Thinking` heading nested inside some larger
 * quote being torn out of the middle of it.
 *
 * Pure and total: any string in, a string out, and a body with no section comes
 * back untouched byte for byte, which is what keeps every non-opencode bubble
 * exactly as #2245 left it.
 *
 * @param content - The Markdown body of one message
 */
export function splitChatThinking(content: string): ChatThinkingSplit {
  // The cheap reject first: this runs on every Markdown bubble in the column.
  if (!content.includes(CHAT_THINKING_LABEL)) {
    return { body: content, reasoning: null, blocks: 0 };
  }

  const lines = content.split('\n');
  const kept: string[] = [];
  const folded: string[] = [];
  let blocks = 0;
  let index = 0;

  while (index < lines.length) {
    const heading = CHAT_THINKING_HEADING.exec(lines[index]);
    const opensQuote = index === 0 || !lines[index - 1].startsWith('>');
    if (!heading || !opensQuote) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && lines[end].startsWith('>')) end += 1;
    const declared = heading[1] ? Number.parseInt(heading[1], 10) : 1;
    blocks += Number.isFinite(declared) && declared > 0 ? declared : 1;
    folded.push(unquoteSection(lines.slice(index + 1, end)));
    index = end;
  }

  if (blocks === 0) return { body: content, reasoning: null, blocks: 0 };

  return {
    // Removing a section from the middle leaves the blank lines that fenced it
    // on both sides; collapsing them is what stops a gap opening where the
    // quote used to be.
    body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    reasoning: folded.join('\n\n').replace(/^\n+/, '').replace(/\n+$/, ''),
    blocks,
  };
}
