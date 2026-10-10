/**
 * terminal-highlight-offsets.ts
 * Maps offsets into a string derived from a message line by line back to the
 * message as written (Issue #3525).
 *
 * Chat does not hand the message itself to react-markdown: it folds the tool
 * log and the `> **Thinking**` quotes out (`splitChatMarkdownBody`) and draws
 * each part with a renderer of its own, the quoted parts unquoted. A code
 * block's `node.position` is then an offset into that part, not into the
 * message search runs on. Every such part is made of the message's lines, in
 * order, each kept whole or with a prefix of quote markers / whitespace taken
 * off — so a line of the part is the end of one line of the message, and an
 * offset in it is that line's offset plus the prefix it lost.
 */

import type { MatchPosition } from './terminal-highlight-dom';

/** An offset in a derived string → the same character in the raw text, or null. */
export type RawOffsetMapper = (offset: number) => number | null;

/** Identity: the string react-markdown was given IS the raw text. */
export const IDENTITY_RAW_OFFSET: RawOffsetMapper = (offset) => offset;

/** What a line may lose on the way into a part: whitespace and `>` markers. */
const DROPPABLE_PREFIX = /^[ \t>]*$/;

/**
 * Align `derived` to the lines of `raw` (only those starting inside `spans`,
 * when given) and return the offset mapping, or `null` when some line of
 * `derived` is not the end of a later raw line — then nothing is mapped and the
 * caller keeps the line-pattern matching it had before.
 *
 * Each derived line takes the first raw line at or after the previous match
 * that ends with it behind a droppable prefix. Lines the part dropped (blank
 * lines trimmed off, a heading, another part's lines) are skipped over.
 */
export function alignDerivedText(derived: string, raw: string, spans?: MatchPosition[]): RawOffsetMapper | null {
  if (derived === raw) return IDENTITY_RAW_OFFSET;
  const rawLines: Array<{ start: number; text: string }> = [];
  let cursor = 0;
  for (const text of raw.split('\n')) {
    if (!spans || spans.some((span) => cursor >= span.start && cursor < span.end)) {
      rawLines.push({ start: cursor, text });
    }
    cursor += text.length + 1;
  }

  // For each derived line: where it starts in `derived`, and in `raw`.
  const derivedStarts: number[] = [];
  const rawStarts: number[] = [];
  let next = 0;
  let derivedOffset = 0;
  for (const line of derived.split('\n')) {
    let found = -1;
    for (let k = next; k < rawLines.length; k++) {
      const text = rawLines[k].text;
      if (text.endsWith(line) && DROPPABLE_PREFIX.test(text.slice(0, text.length - line.length))) {
        found = k;
        break;
      }
    }
    if (found === -1) return null;
    derivedStarts.push(derivedOffset);
    rawStarts.push(rawLines[found].start + rawLines[found].text.length - line.length);
    derivedOffset += line.length + 1;
    next = found + 1;
  }

  return (offset) => {
    if (offset < 0 || offset > derived.length) return null;
    let lo = 0;
    let hi = derivedStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (derivedStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return rawStarts[lo] + (offset - derivedStarts[lo]);
  };
}
