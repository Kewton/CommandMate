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

import type { Element as HastElement, ElementContent, Root, RootContent } from 'hast';
import type { MatchPosition, TextNodeEntry } from './terminal-highlight-dom';
import { IDENTITY_RAW_OFFSET, type RawOffsetMapper } from './terminal-highlight-offsets';

/**
 * [Issue #3523] On an element Markdown drew: where it is in the message as
 * written, then each of its own text children in order — `s,e;s,e,len;,,len`
 * (a child with no position has empty offsets). Read only by search.
 */
export const SEARCH_RAW_ATTR = 'data-search-raw';

/** hast property name that renders as {@link SEARCH_RAW_ATTR}. */
const SEARCH_RAW_PROPERTY = 'dataSearchRaw';

const offsetOf = (point: { offset?: number } | undefined): number | null =>
  typeof point?.offset === 'number' ? point.offset : null;

function rawRange(
  node: HastElement | ElementContent,
  toRaw: RawOffsetMapper,
): { start: number; end: number } | null {
  const start = offsetOf(node.position?.start);
  const end = offsetOf(node.position?.end);
  if (start === null || end === null) return null;
  const rawStart = toRaw(start);
  const rawEnd = toRaw(end);
  return rawStart !== null && rawEnd !== null && rawEnd >= rawStart ? { start: rawStart, end: rawEnd } : null;
}

function annotate(node: Root | RootContent, toRaw: RawOffsetMapper): void {
  if (node.type !== 'root' && node.type !== 'element') return;
  if (node.type === 'element') {
    const own = rawRange(node, toRaw);
    if (own) {
      const items = [`${own.start},${own.end}`];
      for (const child of node.children) {
        if (child.type !== 'text') continue;
        const range = rawRange(child, toRaw);
        items.push(range ? `${range.start},${range.end},${child.value.length}` : `,,${child.value.length}`);
      }
      node.properties = { ...node.properties, [SEARCH_RAW_PROPERTY]: items.join(';') };
    }
  }
  for (const child of node.children) annotate(child, toRaw);
}

/**
 * [Issue #3523] rehype plugin: mark every positioned element with
 * {@link SEARCH_RAW_ATTR}. `toRaw` maps an offset into the string ReactMarkdown
 * was given back to the message (chat draws parts of a message); `null` means
 * the part cannot be mapped, and nothing is marked. Run it after sanitizing
 * (the schema would drop the attribute) and before code highlighting (which
 * replaces a code block's text with spans — the same text, unmarked).
 */
export function rehypeSearchRawText(options?: { toRaw?: RawOffsetMapper | null }) {
  const toRaw = options?.toRaw === undefined ? IDENTITY_RAW_OFFSET : options.toRaw;
  return (tree: Root): void => {
    if (toRaw) annotate(tree, toRaw);
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
}

function parseAttr(value: string): { start: number; end: number; segments: Segment[] } | null {
  const [own, ...rest] = value.split(';');
  const [start, end] = own.split(',').map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const segments: Segment[] = [];
  for (const item of rest) {
    const [s, e, len] = item.split(',');
    const length = Number.parseInt(len, 10);
    if (!Number.isInteger(length) || length < 0) return null;
    const segStart = s === '' ? null : Number.parseInt(s, 10);
    const segEnd = e === '' ? null : Number.parseInt(e, 10);
    if ((segStart !== null && !Number.isInteger(segStart)) || (segEnd !== null && !Number.isInteger(segEnd))) {
      return null;
    }
    segments.push({ start: segStart, end: segEnd, length });
  }
  return { start, end, segments };
}

/**
 * Place each character of `text` in `raw[from, to)` in order, skipping what
 * Markdown did not draw (markers, a continuation line's `>` / indentation, an
 * escape's backslash). `null` when some character is not there.
 */
function alignSubsequence(text: string, raw: string, from: number, to: number): number[] | null {
  // UTF-16 units, as every other offset here (an emoji is two).
  if (raw.slice(from, from + text.length) === text) return Array.from({ length: text.length }, (_, k) => from + k);
  const out: number[] = [];
  let cursor = from;
  for (const ch of text) {
    // `for…of` walks code points; offsets are UTF-16 units, as everywhere else.
    for (let k = 0; k < ch.length; k++) {
      const idx = raw.indexOf(ch[k], cursor);
      if (idx === -1 || idx >= to) return null;
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
        placed = alignSubsequence(text, sourceText, seg.start, seg.end);
        if (placed) cursor = Math.max(cursor, seg.end);
      } else if (text.trim() !== '') {
        placed = alignSubsequence(text, sourceText, cursor, parsed.end);
        if (placed && placed.length > 0) cursor = placed[placed.length - 1] + 1;
      }
      placed?.forEach((rawIdx, k) => {
        if (rawIdx < rawToDom.length && rawToDom[rawIdx] === -1) rawToDom[rawIdx] = domAt[textOffset + k];
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
