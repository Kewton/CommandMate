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
import type { MatchPosition, TextNodeEntry } from './terminal-highlight-dom';
import { IDENTITY_RAW_OFFSET, type RawOffsetMapper } from './terminal-highlight-offsets';

/**
 * [Issue #3523] On an element Markdown drew: where it is in the message as
 * written, then each of its own text children in order — `s,e;s,e,len;,,len`
 * (a child with no position has empty offsets). Read only by search.
 *
 * [Issue #3554] A range whose raw lines are not next to each other names every
 * span it is made of: the element's as `s,e,s2,e2…`, a text child's as
 * `s,e,len,s2,e2…`. Nothing is placed in the gaps between them.
 */
export const SEARCH_RAW_ATTR = 'data-search-raw';

/** hast property name that renders as {@link SEARCH_RAW_ATTR}. */
const SEARCH_RAW_PROPERTY = 'dataSearchRaw';

const offsetOf = (point: { offset?: number } | undefined): number | null =>
  typeof point?.offset === 'number' ? point.offset : null;

/** A `[start, end)` range of the raw message. */
interface RawSpan {
  start: number;
  end: number;
}

/**
 * [Issue #3554] Where the derived range `[start, end)` is in the raw message,
 * as the raw spans its lines came from: one span when they are next to each
 * other there, several when the deriver left raw lines out between them
 * (chat's answer with a `> **Thinking**` section folded out from between two
 * of its lines). A span ends after its line's raw `\n`. `null` when some line
 * does not map. Without `source` the line breaks are unknown: the two ends.
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
    if (rawStart === null || lineEnd === null) return null;
    const rawEnd = lineEnd + (isLast ? 0 : 1);
    if (rawEnd < rawStart) return null;
    const previous = spans[spans.length - 1];
    if (previous && previous.end === rawStart) previous.end = rawEnd;
    else spans.push({ start: rawStart, end: rawEnd });
    if (isLast) return spans;
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

interface Segment {
  start: number | null;
  end: number | null;
  length: number;
  /** [Issue #3554] The raw spans it may be placed in (`[start, end)` when one). */
  spans: RawSpan[];
}

/** `s,e[,s2,e2…]` → spans, or null when malformed. */
function parseSpans(parts: readonly string[]): RawSpan[] | null {
  if (parts.length % 2 !== 0) return null;
  const spans: RawSpan[] = [];
  for (let k = 0; k < parts.length; k += 2) {
    const start = Number.parseInt(parts[k], 10);
    const end = Number.parseInt(parts[k + 1], 10);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
    spans.push({ start, end });
  }
  return spans;
}

function parseAttr(value: string): { start: number; end: number; spans: RawSpan[]; segments: Segment[] } | null {
  const [own, ...rest] = value.split(';');
  const spans = parseSpans(own.split(','));
  if (!spans || spans.length === 0) return null;
  const segments: Segment[] = [];
  for (const item of rest) {
    const [s, e, len, ...more] = item.split(',');
    const length = Number.parseInt(len, 10);
    if (!Number.isInteger(length) || length < 0) return null;
    if (s === '' || e === '') {
      segments.push({ start: null, end: null, length, spans: [] });
      continue;
    }
    const segSpans = parseSpans([s, e, ...more]);
    if (!segSpans) return null;
    segments.push({ start: segSpans[0].start, end: segSpans[segSpans.length - 1].end, length, spans: segSpans });
  }
  return { start: spans[0].start, end: spans[spans.length - 1].end, spans, segments };
}

/**
 * Place each character of `text` in the raw `spans`, in order, skipping what
 * Markdown did not draw (markers, a continuation line's `>` / indentation, an
 * escape's backslash) and never in a gap between two spans (Issue #3554: the
 * lines a chat part left out). `null` when some character is not there —
 * except, across a gap, whitespace the raw text does not hold (a `&NewLine;`,
 * a line break inline code drew as a space), which is left unplaced (`-1`)
 * rather than looked for past the gap.
 */
function alignSubsequence(text: string, raw: string, spans: readonly RawSpan[], from = spans[0]?.start ?? 0): number[] | null {
  // UTF-16 units, as every other offset here (an emoji is two).
  if (spans.length === 1 && raw.slice(from, from + text.length) === text) {
    return Array.from({ length: text.length }, (_, k) => from + k);
  }
  const out: number[] = [];
  let cursor = from;
  let span = 0;
  for (const ch of text) {
    // `for…of` walks code points; offsets are UTF-16 units, as everywhere else.
    for (let k = 0; k < ch.length; k++) {
      let idx = -1;
      let at = span;
      for (; at < spans.length; at++) {
        if (spans[at].end <= cursor) continue;
        const found = raw.indexOf(ch[k], Math.max(cursor, spans[at].start));
        if (found !== -1 && found < spans[at].end) {
          idx = found;
          break;
        }
      }
      if (idx === -1) {
        if (spans.length > 1 && /\s/.test(ch[k])) {
          out.push(-1);
          continue;
        }
        return null;
      }
      span = at;
      out.push(idx);
      cursor = idx + 1;
    }
  }
  return out;
}

/** A fenced code block's raw range starts with its opening fence line. */
const FENCE_OPENER = /^[ \t>]*(`{3,}|~{3,})/;

/**
 * [Issue #3523] Translate offsets into the raw message to offsets into the
 * container's text, through the {@link SEARCH_RAW_ATTR} marks Markdown left.
 *
 * Each marked element owns the text nodes that are nearest to it (unmarked
 * elements in between — linkified paths, highlighted code tokens — are
 * transparent). When its own text adds up to the segments it names, each
 * segment is placed in its raw range (unpositioned ones — a fenced block's
 * code — in the element's range, after its fence line; whitespace between
 * blocks is left unplaced). An element whose text does not add up (an override
 * drew something else) places nothing.
 *
 * Per hit: placed when its first and last characters are, else `null`. Returns
 * `null` when the container holds no marked element, so the caller keeps the
 * plain offset-equals-offset behaviour (terminal, plain-text rows).
 */
export function mapMarkdownPositionsToDom(
  container: Element,
  textNodes: TextNodeEntry[],
  sourceText: string,
  positions: MatchPosition[],
): Array<MatchPosition | null> | null {
  if (!container.querySelector(`[${SEARCH_RAW_ATTR}]`)) return null;

  const owned = new Map<Element, TextNodeEntry[]>();
  for (const entry of textNodes) {
    const owner = entry.node.parentElement?.closest(`[${SEARCH_RAW_ATTR}]`);
    if (!owner || !container.contains(owner)) continue;
    const list = owned.get(owner);
    if (list) list.push(entry);
    else owned.set(owner, [entry]);
  }

  const rawToDom = new Int32Array(sourceText.length).fill(-1);
  for (const [owner, entries] of owned) {
    const parsed = parseAttr(owner.getAttribute(SEARCH_RAW_ATTR) ?? '');
    if (!parsed) continue;
    const domText = entries.map((entry) => entry.node.nodeValue ?? '').join('');
    if (parsed.segments.reduce((sum, seg) => sum + seg.length, 0) !== domText.length) continue;
    // DOM offset of the k-th character of the owner's own text.
    const domAt: number[] = [];
    for (const entry of entries) for (let k = entry.start; k < entry.end; k++) domAt.push(k);

    let cursor = parsed.start;
    const opener = FENCE_OPENER.exec(sourceText.slice(parsed.start, parsed.end));
    if (opener) {
      const lineEnd = sourceText.indexOf('\n', parsed.start);
      cursor = lineEnd === -1 ? parsed.end : lineEnd + 1;
    }
    let textOffset = 0;
    for (const seg of parsed.segments) {
      const text = domText.slice(textOffset, textOffset + seg.length);
      let placed: number[] | null = null;
      if (seg.start !== null && seg.end !== null) {
        placed = alignSubsequence(text, sourceText, seg.spans);
        if (placed) cursor = Math.max(cursor, seg.end);
      } else if (text.trim() !== '') {
        placed = alignSubsequence(text, sourceText, parsed.spans, cursor);
        if (placed && placed.length > 0) cursor = placed.reduce((max, rawIdx) => Math.max(max, rawIdx + 1), cursor);
      }
      placed?.forEach((rawIdx, k) => {
        if (rawIdx >= 0 && rawIdx < rawToDom.length && rawToDom[rawIdx] === -1) rawToDom[rawIdx] = domAt[textOffset + k];
      });
      textOffset += seg.length;
    }
  }

  return positions.map((pos) => {
    if (pos.end <= pos.start || pos.end > rawToDom.length) return null;
    const start = rawToDom[pos.start];
    const last = rawToDom[pos.end - 1];
    return start !== -1 && last !== -1 && last >= start ? { start, end: last + 1 } : null;
  });
}
