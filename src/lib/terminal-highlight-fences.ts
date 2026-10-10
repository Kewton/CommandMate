/**
 * terminal-highlight-fences.ts
 * Locates ```mermaid fences in raw Markdown text for the search highlighter
 * (split out of terminal-highlight.ts, Issue #3517).
 */

/** One body line of a fence: where it is in the raw text and in the body. */
interface FenceLine {
  /** Raw offset of the line's content (after any `> ` quote markers). */
  rawStart: number;
  /** Length of that content. */
  length: number;
  /** Offset of the same content inside {@link MermaidFence.body}. */
  bodyOffset: number;
}

/** One ```mermaid fence in the raw text, by offset. */
export interface MermaidFence {
  /** Start of the opening fence line. */
  fenceStart: number;
  /** Start of the first body line. */
  bodyStart: number;
  /** End of the last body line (its newline excluded). */
  bodyEnd: number;
  /** End of the closing fence line (or of the fence's last line, if it never closes). */
  fenceEnd: number;
  /** The body as Markdown reads it — what the source element shows. */
  body: string;
  /** How many `>` block-quote markers the fence sits behind (0 = not quoted). */
  quoteDepth: number;
  /** Each body line, so a raw offset behind `> ` maps into {@link body}. */
  lines: FenceLine[];
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
/** A list item whose first line is the fence (`- ```mermaid`, `1. ```mermaid`). */
const LIST_ITEM_PREFIX = /^ {0,3}(?:[-*+]|\d{1,9}[.)]) {1,4}(?=`{3,}|~{3,})/;

/** Count of leading spaces in `text` from `from`, up to `max`. */
function leadingSpaces(text: string, from: number, to: number, max: number): number {
  let n = 0;
  while (n < max && from + n < to && text[from + n] === ' ') n += 1;
  return n;
}
const QUOTE_MARKER = /^ {0,3}>[ \t]?/;

interface RawLine {
  start: number;
  end: number;
}

/** Strip up to `max` block-quote markers; how many were stripped and where the rest starts. */
function stripQuotes(text: string, line: RawLine, max: number): { depth: number; contentStart: number } {
  let depth = 0;
  let contentStart = line.start;
  while (depth < max) {
    const marker = QUOTE_MARKER.exec(text.slice(contentStart, line.end));
    if (!marker) break;
    contentStart += marker[0].length;
    depth += 1;
  }
  return { depth, contentStart };
}

/**
 * [Issue #3503] Find the ```mermaid fences in a Markdown string, including ones
 * inside a block quote (`> ```mermaid` — every saved opencode row opens with a
 * `> **Thinking**` quote, and a diagram can sit in it). A quoted fence's body is
 * its lines with the quote markers taken off, which is what Markdown renders;
 * the fence ends at its closing line or where the quote ends. Other fences are
 * tracked only so a ```mermaid line inside them is not mistaken for an opener.
 */
export function findMermaidFences(text: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  const lines: RawLine[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const nl = text.indexOf('\n', cursor);
    const end = nl === -1 ? text.length : nl;
    lines.push({ start: cursor, end });
    if (nl === -1) break;
    cursor = nl + 1;
  }

  for (let i = 0; i < lines.length; i++) {
    const { depth, contentStart } = stripQuotes(text, lines[i], Number.POSITIVE_INFINITY);
    // A fence opening a list item sits behind the item's marker; the item's
    // following lines are indented by the marker's width (CommonMark).
    const item = LIST_ITEM_PREFIX.exec(text.slice(contentStart, lines[i].end));
    const itemIndent = item ? item[0].length : 0;
    const open = FENCE_OPEN.exec(text.slice(contentStart + itemIndent, lines[i].end));
    if (!open) continue;
    // Markdown removes up to the opening fence's own indentation from every
    // body line (micromark `code-fenced`), so the body is compared — and the
    // offsets mapped — with it removed.
    const fenceIndent = open[1].length;
    const marker = open[2];
    const info = open[3].trim();
    if (marker[0] === '`' && info.includes('`')) continue; // not a fence
    const closeRe = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);

    const body: FenceLine[] = [];
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      const inner = stripQuotes(text, lines[j], depth);
      if (inner.depth < depth) break; // the quote ended, and the fence with it
      let lineStart = inner.contentStart;
      const lineEnd = lines[j].end;
      if (itemIndent > 0) {
        const spaces = leadingSpaces(text, lineStart, lineEnd, itemIndent);
        const blank = text.slice(lineStart, lineEnd).trim().length === 0;
        if (!blank && spaces < itemIndent) break; // the list item ended
        lineStart += spaces;
      }
      last = j;
      if (closeRe.test(text.slice(lineStart, lineEnd))) break;
      lineStart += leadingSpaces(text, lineStart, lineEnd, fenceIndent);
      body.push({ rawStart: lineStart, length: lineEnd - lineStart, bodyOffset: 0 });
    }

    if (info.split(/[ \t]/)[0] === 'mermaid') {
      let offset = 0;
      for (const line of body) {
        line.bodyOffset = offset;
        offset += line.length + 1;
      }
      const bodyStart = body.length > 0 ? lines[i + 1].start : lines[i].end;
      const bodyEnd = body.length > 0 ? body[body.length - 1].rawStart + body[body.length - 1].length : bodyStart;
      fences.push({
        fenceStart: lines[i].start,
        bodyStart,
        bodyEnd,
        fenceEnd: lines[last].end,
        body: body.map((line) => text.slice(line.rawStart, line.rawStart + line.length)).join('\n'),
        quoteDepth: depth,
        lines: body,
      });
    }
    i = last;
  }
  return fences;
}
