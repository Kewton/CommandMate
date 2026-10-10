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
const LIST_ITEM_PREFIX = /^ {0,3}(?:[-*+]|(\d{1,9})[.)]) {1,4}(?=`{3,}|~{3,})/;
/** A line that starts a list item of its own (any marker, any content). */
const LIST_ITEM_START = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** A line that is not paragraph text: a heading, a fence, a thematic break, an HTML block. */
const NOT_PARAGRAPH = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$|<)/;

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
 * Whether the line before `lines[index]` ends a top-level paragraph that a
 * list item on `lines[index]` would interrupt. Decided by the block that line
 * belongs to, read upward through its run of non-blank lines (quote markers
 * taken off): not when it is blank, indented (a list item's continuation), or
 * another block's line, and not when the run holds a list item's first line —
 * then the run is that item's paragraph and the next marker is the list's next
 * item, not an interruption (CommonMark; micromark `list`). An approximation of
 * micromark's block state — the structural mapping (`fenceFromRawRange`) is
 * what a rendered diagram uses.
 */
function interruptsParagraph(text: string, lines: RawLine[], index: number): boolean {
  const contentOf = (line: RawLine): string =>
    text.slice(stripQuotes(text, line, Number.POSITIVE_INFINITY).contentStart, line.end);
  const before = contentOf(lines[index - 1]);
  if (before.trim().length === 0 || /^[ \t]/.test(before) || NOT_PARAGRAPH.test(before)) return false;
  for (let k = index - 1; k >= 0; k--) {
    const content = contentOf(lines[k]);
    if (content.trim().length === 0) break;
    if (LIST_ITEM_START.test(content)) return false;
  }
  return true;
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
    let item = LIST_ITEM_PREFIX.exec(text.slice(contentStart, lines[i].end));
    // [Issue #3525] An ordered list may interrupt a paragraph only when it
    // starts at 1 (CommonMark): `text\n2. ```mermaid` is paragraph text, not a
    // list item holding a fence.
    if (item && item[1] !== undefined && Number(item[1]) !== 1 && i > 0 && interruptsParagraph(text, lines, i)) {
      item = null;
    }
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

/**
 * [Issue #3525] The fence Markdown itself drew at `[start, end)` of `text` —
 * the range react-markdown's `node.position` gave the code block — read
 * against the body the source element shows.
 *
 * The range starts at the opening fence (after any list marker, indentation or
 * quote markers) and ends after the closing fence, or after the last body line
 * when the fence never closes. Every body line, as Markdown hands it over, is
 * what is left of its raw line once the containers' prefix (list indentation,
 * tabs, `>` markers) and the fence's own indentation are taken off — so each
 * source line must be the end of its raw line. Anything else (a range that
 * does not open with a fence, a line count that does not add up, a line that
 * is not the end of its raw line) is `null`: the caller falls back to
 * {@link findMermaidFences} rather than guess.
 */
export function fenceFromRawRange(text: string, start: number, end: number, body: string): MermaidFence | null {
  if (!(start >= 0 && end <= text.length && start < end)) return null;
  const raw = text.slice(start, end);
  if (!/^(?:`{3,}|~{3,})/.test(raw)) return null;
  const rawLines = raw.split('\n');
  const bodyLines = body.length > 0 ? body.split('\n') : [];
  const rest = rawLines.length - 1;
  if (bodyLines.length > 0 && rest !== bodyLines.length && rest !== bodyLines.length + 1) return null;

  const lines: FenceLine[] = [];
  let lineStart = start + rawLines[0].length + 1;
  let bodyOffset = 0;
  for (let k = 0; k < bodyLines.length; k++) {
    const rawLine = rawLines[k + 1];
    const line = bodyLines[k];
    if (!rawLine.endsWith(line)) return null;
    lines.push({ rawStart: lineStart + rawLine.length - line.length, length: line.length, bodyOffset });
    bodyOffset += line.length + 1;
    lineStart += rawLine.length + 1;
  }
  const opening = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
  const quoteDepth = (opening.match(/>/g) ?? []).length;
  return {
    fenceStart: start,
    bodyStart: lines.length > 0 ? start + rawLines[0].length + 1 : start + rawLines[0].length,
    bodyEnd: lines.length > 0 ? lines[lines.length - 1].rawStart + lines[lines.length - 1].length : start + rawLines[0].length,
    fenceEnd: end,
    body,
    quoteDepth,
    lines,
  };
}
