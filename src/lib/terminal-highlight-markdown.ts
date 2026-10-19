/**
 * terminal-highlight-markdown.ts
 * Places search hits counted in a message as written onto the text Markdown
 * drew from it (Issue #3523).
 *
 * Search counts in `message.content`; the highlighter used to count the DOM.
 * Every character Markdown does not draw — `**`, `` ` ``, a link's `[..](url)`,
 * a heading's `#`, a list's `- `, the second newline between paragraphs — put
 * the mark that many characters after the word. A rehype pass
 * ({@link rehypeSearchRawText}) writes on each element where its own text is in
 * the raw message (react-markdown's `node.position`, mapped back the way the
 * mermaid source's range is, Issue #3525); {@link mapMarkdownPositionsToDom}
 * reads those back off the DOM.
 */

import type { ElementContent, Root, RootContent } from 'hast';
import { IDENTITY_RAW_OFFSET, type RawOffsetMapper } from './terminal-highlight-offsets';
import { SEARCH_RAW_ATTR, type RawSpan } from './terminal-highlight-markdown-align';

export { SEARCH_RAW_ATTR, mapMarkdownPositionsToDom } from './terminal-highlight-markdown-align';

/** hast property name that renders as {@link SEARCH_RAW_ATTR}. */
const SEARCH_RAW_PROPERTY = 'dataSearchRaw';

const offsetOf = (point: { offset?: number } | undefined): number | null =>
  typeof point?.offset === 'number' ? point.offset : null;

/**
 * [Issue #3554] Where the derived range `[start, end)` is in the raw message,
 * as the raw spans its lines came from: one span when they are next to each
 * other there, several when the deriver left raw lines out between them
 * (chat's answer with a `> **Thinking**` section folded out from between two
 * of its lines). A span ends after its line's raw `\n`. A line no raw line
 * holds (the blank line chat makes up to join two reasoning sections) is a gap
 * too (Issue #3661: a code block across the join kept nothing). `null` when no
 * line maps, or a line maps at one end only. Without `source` the line breaks
 * are unknown: the two ends.
 */
function rawSpans(start: number, end: number, toRaw: RawOffsetMapper, source: string | undefined): RawSpan[] | null {
  const ends = (): RawSpan[] | null => {
    const rawStart = toRaw(start);
    const rawEnd = toRaw(end);
    return rawStart !== null && rawEnd !== null && rawEnd >= rawStart ? [{ start: rawStart, end: rawEnd }] : null;
  };
  if (source === undefined) return ends();
  const spans: RawSpan[] = [];
  let lineStart = start;
  for (let at = source.indexOf('\n', start); ; at = source.indexOf('\n', at + 1)) {
    const isLast = at === -1 || at >= end;
    const rawStart = toRaw(lineStart);
    const lineEnd = toRaw(isLast ? end : at);
    if ((rawStart === null) !== (lineEnd === null)) return null;
    if (rawStart !== null && lineEnd !== null) {
      const rawEnd = lineEnd + (isLast ? 0 : 1);
      if (rawEnd < rawStart) return null;
      const previous = spans[spans.length - 1];
      if (previous && previous.end === rawStart) previous.end = rawEnd;
      else spans.push({ start: rawStart, end: rawEnd });
    }
    if (isLast) return spans.length > 0 ? spans : null;
    lineStart = at + 1;
  }
}

const formatSpans = (spans: readonly RawSpan[]): string => spans.map((span) => `${span.start},${span.end}`).join(',');

/**
 * [Issue #3554] One text child's segments: `s,e,len` for its whole range, or —
 * when its raw range has gaps ({@link rawSpans}) — one `s,e,len` per drawn line
 * placed only in the raw line it came from, when its text has a `\n` for every
 * line break of the source (else one `s,e,len,s2,e2,…` naming every span, so
 * the gaps are still no candidates: a `&NewLine;` adds a `\n` the source has
 * not, inline code turns one into a space). A single range would span the
 * folded lines, and search would place the answer's text on the same text
 * inside the reasoning.
 */
function textSegments(
  child: ElementContent & { type: 'text' },
  toRaw: RawOffsetMapper,
  source: string | undefined,
): string[] {
  const length = child.value.length;
  const start = offsetOf(child.position?.start);
  const end = offsetOf(child.position?.end);
  const spans = start === null || end === null ? null : rawSpans(start, end, toRaw, source);
  if (!spans) return [`,,${length}`];
  if (spans.length === 1 || source === undefined || start === null || end === null) {
    return [`${spans[0].start},${spans[0].end},${length}`];
  }
  const breaks: number[] = [];
  for (let at = source.indexOf('\n', start); at !== -1 && at < end; at = source.indexOf('\n', at + 1)) breaks.push(at);
  const pieces = child.value.split('\n');
  if (pieces.length !== breaks.length + 1) {
    const [first, ...rest] = spans;
    return [[`${first.start},${first.end},${length}`, ...rest.map((span) => `${span.start},${span.end}`)].join(',')];
  }
  return pieces.map((piece, k) => {
    const isLast = k === pieces.length - 1;
    const pieceLength = piece.length + (isLast ? 0 : 1);
    // One drawn line: no `\n` inside it, so one span; its own `\n` is the raw one after it.
    const line = rawSpans(k === 0 ? start : breaks[k - 1] + 1, isLast ? end : breaks[k], toRaw, source);
    return line ? `${line[0].start},${line[0].end + (isLast ? 0 : 1)},${pieceLength}` : `,,${pieceLength}`;
  });
}

function annotate(node: Root | RootContent, toRaw: RawOffsetMapper, source: string | undefined): void {
  if (node.type !== 'root' && node.type !== 'element') return;
  if (node.type === 'element') {
    const start = offsetOf(node.position?.start);
    const end = offsetOf(node.position?.end);
    const own = start === null || end === null ? null : rawSpans(start, end, toRaw, source);
    if (own) {
      const items = [formatSpans(own)];
      for (const child of node.children) {
        if (child.type !== 'text') continue;
        items.push(...textSegments(child, toRaw, source));
      }
      node.properties = { ...node.properties, [SEARCH_RAW_PROPERTY]: items.join(';') };
    }
  }
  for (const child of node.children) annotate(child, toRaw, source);
}

/**
 * [Issue #3523] rehype plugin: mark every positioned element with
 * {@link SEARCH_RAW_ATTR}. `toRaw` maps an offset into the string ReactMarkdown
 * was given back to the message (chat draws parts of a message); `null` means
 * the part cannot be mapped, and nothing is marked. Run it after sanitizing
 * (the schema would drop the attribute) and before code highlighting (which
 * replaces a code block's text with spans — the same text, unmarked).
 *
 * [Issue #3554] `source` is that string (react-markdown's file value when not
 * given): with it, a text child whose lines come from raw lines that are not
 * next to each other is placed line by line ({@link textSegments}).
 */
export function rehypeSearchRawText(options?: { toRaw?: RawOffsetMapper | null; source?: string }) {
  const toRaw = options?.toRaw === undefined ? IDENTITY_RAW_OFFSET : options.toRaw;
  return (tree: Root, file?: { value?: unknown }): void => {
    const source = options?.source ?? (typeof file?.value === 'string' ? file.value : undefined);
    if (toRaw) annotate(tree, toRaw, source);
  };
}

/**
 * [Issue #3523] The attribute an element override must pass on so search can
 * read it (overrides that rebuild `<p>` / `<li>` / … from `children` alone drop
 * every prop react-markdown handed them).
 */
export function searchRawProps(props: object): Record<string, string> {
  const value = (props as Record<string, unknown>)[SEARCH_RAW_ATTR];
  return typeof value === 'string' ? { [SEARCH_RAW_ATTR]: value } : {};
}
