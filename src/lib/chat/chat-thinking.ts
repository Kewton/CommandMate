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
  /**
   * Each reasoning section's lines of the input as `[start, end)` line indices,
   * heading line included. Absent when {@link reasoning} is null.
   */
  readonly lineRanges?: ReadonlyArray<readonly [number, number]>;
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
  const scan = scanThinkingSections(lines);
  if (scan.blocks === 0) return { body: content, reasoning: null, blocks: 0 };

  const kept = scan.kept.map((index) => lines[index]);
  const folded = scan.sections.map(([start, end]) => unquoteSection(lines.slice(start, end)));
  return {
    // Removing a section from the middle leaves the blank lines that fenced it
    // on both sides; collapsing them is what stops a gap opening where the
    // quote used to be.
    body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    reasoning: folded.join('\n\n').replace(/^\n+/, '').replace(/\n+$/, ''),
    blocks: scan.blocks,
    lineRanges: scan.sections.map(([start, end]) => [start - 1, end] as const),
  };
}

/** Which lines {@link splitChatThinking} keeps, and which it folds. */
interface ThinkingScan {
  /** Indices of the lines left in the body, in order. */
  readonly kept: number[];
  /** Each section's quoted lines below its heading, as `[start, end)` line indices. */
  readonly sections: Array<[number, number]>;
  readonly blocks: number;
}

/** The one reading of "what counts as a section" both answers below are built from. */
function scanThinkingSections(lines: readonly string[]): ThinkingScan {
  const kept: number[] = [];
  const sections: Array<[number, number]> = [];
  let blocks = 0;
  let index = 0;

  while (index < lines.length) {
    const heading = CHAT_THINKING_HEADING.exec(lines[index]);
    const opensQuote = index === 0 || !lines[index - 1].startsWith('>');
    if (!heading || !opensQuote) {
      kept.push(index);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && lines[end].startsWith('>')) end += 1;
    const declared = heading[1] ? Number.parseInt(heading[1], 10) : 1;
    blocks += Number.isFinite(declared) && declared > 0 ? declared : 1;
    sections.push([index + 1, end]);
    index = end;
  }
  return { kept, sections, blocks };
}

// ============================================================================
// Where each line of the split came from (Issue #3554)
// ============================================================================

/**
 * One line of {@link splitChatThinking}'s `body` or `reasoning`: its text, the
 * line of the input it is the end of, and how many characters of that line's
 * front it lost. `line` is null for a line the split made up (the blank line
 * that joins two reasoning sections) — it is the end of no input line.
 */
export interface ChatThinkingLineOrigin {
  readonly text: string;
  readonly line: number | null;
  readonly column: number;
}

/** What {@link chatThinkingLineOrigins} answers. */
export interface ChatThinkingLineOrigins {
  /** `body.split('\n')`, line for line, with where each line came from. */
  readonly body: ChatThinkingLineOrigin[];
  /** The same for `reasoning`; empty when it is null or empty. */
  readonly reasoning: ChatThinkingLineOrigin[];
}

/**
 * [Issue #3554] Where each line of {@link splitChatThinking}'s answer came from.
 *
 * The split trims the body, collapses its blank runs and joins the reasoning
 * sections with a blank line, and none of that says which input line a kept
 * line is. Search lined the two up afterwards by matching strings, under a rule
 * that only knew lines losing a FRONT — so a hard break on the last line, the
 * `\r` a trim ate, a full-width space in front, or two legacy sections joined by
 * a blank line no input line holds, mapped nothing. This walks the same scan
 * and the same steps, keeping each line's origin, so nothing has to be matched.
 *
 * The texts join to exactly the strings {@link splitChatThinking} answers for
 * the same input (the caller can check, and should not map when they differ).
 *
 * @param content - The same input {@link splitChatThinking} was given
 */
export function chatThinkingLineOrigins(content: string): ChatThinkingLineOrigins {
  const lines = content.split('\n');
  const whole = (index: number): ChatThinkingLineOrigin => ({ text: lines[index], line: index, column: 0 });
  const scan: ThinkingScan = content.includes(CHAT_THINKING_LABEL)
    ? scanThinkingSections(lines)
    : { kept: [], sections: [], blocks: 0 };
  if (scan.blocks === 0) return { body: lines.map((_, index) => whole(index)), reasoning: [] };

  // body: join, `\n{3,}` → `\n\n` (a run of two or more empty lines is one), trim.
  const collapsed: ChatThinkingLineOrigin[] = [];
  for (const index of scan.kept) {
    const previous = collapsed[collapsed.length - 1];
    if (lines[index] === '' && previous?.text === '') {
      // Keep the first of the run: which empty line stands for it does not
      // change any offset inside the text.
      continue;
    }
    collapsed.push(whole(index));
  }
  const body = trimLines(collapsed);

  // reasoning: each section unquoted and its blank edges dropped, joined by a
  // made-up blank line, then the blank edges of the whole dropped.
  const joined: ChatThinkingLineOrigin[] = [];
  scan.sections.forEach(([start, end], position) => {
    if (position > 0) joined.push({ text: '', line: null, column: 0 });
    const section: ChatThinkingLineOrigin[] = [];
    for (let index = start; index < end; index++) {
      const text = lines[index].replace(/^>[ \t]?/, '');
      section.push({ text, line: index, column: lines[index].length - text.length });
    }
    while (section.length > 0 && section[0].text === '') section.shift();
    while (section.length > 0 && section[section.length - 1].text === '') section.pop();
    // An empty section still joins as one empty string.
    joined.push(...(section.length > 0 ? section : [{ text: '', line: null, column: 0 }]));
  });
  while (joined.length > 0 && joined[0].text === '') joined.shift();
  while (joined.length > 0 && joined[joined.length - 1].text === '') joined.pop();

  return { body, reasoning: joined };
}

/** `String.prototype.trim` over joined lines: blank edge lines go, the edge lines lose their whitespace. */
function trimLines(lines: ChatThinkingLineOrigin[]): ChatThinkingLineOrigin[] {
  let first = 0;
  let last = lines.length - 1;
  while (first <= last && lines[first].text.trim() === '') first += 1;
  while (last >= first && lines[last].text.trim() === '') last -= 1;
  if (first > last) return [];
  const out = lines.slice(first, last + 1);
  const head = out[0];
  const headText = head.text.trimStart();
  out[0] = { ...head, text: headText, column: head.column + head.text.length - headText.length };
  const tail = out[out.length - 1];
  out[out.length - 1] = { ...tail, text: tail.text.trimEnd() };
  return out;
}
