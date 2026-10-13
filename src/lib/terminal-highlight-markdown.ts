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

const CHARACTER_REFERENCE = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/y;

const isWhitespace = (unit: string): boolean => /\s/.test(unit);

/**
 * What a numeric reference draws, as micromark decodes it: a code point that
 * is not a character to draw (a control, a surrogate, a noncharacter, past
 * U+10FFFF) draws U+FFFD.
 */
function drawnByNumber(code: number): string {
  if (
    code < 9 ||
    code === 11 ||
    (code > 13 && code < 32) ||
    (code > 126 && code < 160) ||
    (code > 55295 && code < 57344) ||
    (code > 64975 && code < 65008) ||
    (code & 65535) === 65535 ||
    (code & 65535) === 65534 ||
    code > 1114111
  ) {
    return '\uFFFD';
  }
  return String.fromCodePoint(code);
}

const drawnByName = new Map<string, string | null>();

/**
 * What a named reference draws, or `null` for a name Markdown does not know
 * (it is then drawn as written). Read through the DOM's HTML decoder, which
 * knows the same HTML names micromark does; the search runs where there is a
 * DOM. Without one, every name is taken as drawn as written.
 */
function drawnByNamed(reference: string): string | null {
  const known = drawnByName.get(reference);
  if (known !== undefined) return known;
  let drawn: string | null = null;
  if (typeof DOMParser !== 'undefined') {
    // `reference` is `&name;` and nothing else (CHARACTER_REFERENCE): no markup
    // of its own. Inside an element, so a reference that draws whitespace is
    // not dropped as whitespace before the body.
    const decoded = new DOMParser().parseFromString(`<b>${reference}</b>`, 'text/html').body.textContent ?? '';
    drawn = decoded !== reference && decoded !== '' ? decoded : null;
  }
  drawnByName.set(reference, drawn);
  return drawn;
}

/**
 * [Issue #3661] The character reference (`&lt;`, `&#10;`, `&NewLine;`,
 * `&fjlig;`) that starts at `at` in `raw`: where it ends, and what it draws —
 * one or more UTF-16 units (`&fjlig;` draws `fj`, `&Afr;` a surrogate pair).
 * `null` when none starts there, or the name is not one Markdown knows.
 */
function referenceAt(raw: string, at: number): { end: number; drawn: string } | null {
  CHARACTER_REFERENCE.lastIndex = at;
  const match = CHARACTER_REFERENCE.exec(raw);
  if (!match) return null;
  const end = at + match[0].length;
  const drawn =
    match[3] !== undefined
      ? drawnByNamed(match[0])
      : drawnByNumber(Number.parseInt(match[1] ?? match[2], match[1] !== undefined ? 10 : 16));
  return drawn === null ? null : { end, drawn };
}

/**
 * Place each character of `text` in the raw `spans`, in order, skipping what
 * Markdown did not draw (markers, a continuation line's `>` / indentation, an
 * escape's backslash) and never in a gap between two spans (Issue #3554: the
 * lines a chat part left out). `null` when some character is not there.
 *
 * [Issue #3661] Whitespace is placed only between the characters around it:
 * one Markdown drew without the raw text holding it (a `&NewLine;`, a line
 * break inline code drew as a space, a line chat made up) is left unplaced
 * (`-1`) instead of taking a later raw one — which put the rest of the text a
 * line late, or nowhere. A character reference that is not drawn as written
 * (outside code) has every unit it draws placed on its `&` (`&fjlig;` draws
 * two, `&Afr;` a surrogate pair), and its name is never a place for the text
 * after it. One that draws whitespace is stepped over (its whitespace waits
 * as above). A name Markdown does not know is drawn as written, and placed so.
 */
function alignSubsequence(text: string, raw: string, spans: readonly RawSpan[], from = spans[0]?.start ?? 0): number[] | null {
  // UTF-16 units, as every other offset here (an emoji is two).
  if (spans.length === 1 && raw.slice(from, from + text.length) === text) {
    return Array.from({ length: text.length }, (_, k) => from + k);
  }
  const lastEnd = spans[spans.length - 1]?.end ?? from;
  const inSpan = (at: number): number => spans.findIndex((span) => at >= span.start && at < span.end);
  /** First `unit` in `raw` at or after `at`, before `limit`, inside a span (from span `first` on). */
  const find = (unit: string, at: number, limit: number, first = 0): { idx: number; span: number } | null => {
    for (let k = first; k < spans.length; k++) {
      if (spans[k].end <= at) continue;
      if (spans[k].start >= limit) return null;
      const found = raw.indexOf(unit, Math.max(at, spans[k].start));
      if (found !== -1 && found < Math.min(spans[k].end, limit)) return { idx: found, span: k };
    }
    return null;
  };

  const out: number[] = new Array(text.length).fill(-1);
  let cursor = from;
  let span = 0;
  // Whitespace waiting for the next placed character, and where it may start.
  let pending: number[] = [];
  let pendingFrom = from;
  const placePending = (limit: number): void => {
    let at = pendingFrom;
    for (const k of pending) {
      const found = find(text[k], at, limit);
      if (found) {
        out[k] = found.idx;
        at = found.idx + 1;
      }
    }
    pending = [];
  };

  for (let k = 0; k < text.length; k++) {
    const unit = text[k];
    if (isWhitespace(unit)) {
      if (pending.length === 0) pendingFrom = cursor;
      pending.push(k);
      continue;
    }
    // Step over raw whitespace and references that drew whitespace (already
    // waiting above) to see whether a reference drew this character.
    let at = cursor;
    let reference: { start: number; end: number; length: number } | null = null;
    while (at < raw.length && inSpan(at) !== -1) {
      if (isWhitespace(raw[at])) {
        at += 1;
        continue;
      }
      const found = raw[at] === '&' ? referenceAt(raw, at) : null;
      if (!found || text.startsWith(raw.slice(at, found.end), k)) break;
      if (/^\s+$/.test(found.drawn)) {
        at = found.end;
        continue;
      }
      if (text.startsWith(found.drawn, k)) reference = { start: at, end: found.end, length: found.drawn.length };
      break;
    }
    let idx: number;
    let units = 1;
    if (reference) {
      idx = reference.start;
      span = inSpan(idx);
      cursor = reference.end;
      units = reference.length;
    } else {
      const found = find(unit, Math.max(cursor, at), Number.POSITIVE_INFINITY, span);
      if (!found) return null;
      idx = found.idx;
      span = found.span;
      cursor = idx + 1;
    }
    placePending(idx);
    // Every unit a reference drew is on its `&`.
    for (let drawn = 0; drawn < units; drawn++) out[k + drawn] = idx;
    k += units - 1;
  }
  placePending(lastEnd);
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
 * Per hit: placed when its first and last characters are, else `null`. A
 * reference drawing several units (`&fjlig;`) is placed by a hit starting on
 * its `&` and by one ending on its `;` — a hit on its whole marks every unit it
 * drew (Issue #3671); a hit ending inside its name is not placed. Returns
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
  // [Issue #3671] DOM end (exclusive) of a hit whose last raw character is
  // here. Kept apart from `rawToDom` (where a hit starts) so that a reference
  // drawing several units — all placed on its `&` — can also be ended on its
  // last raw character (`;`) with every unit it drew.
  const rawEndToDom = new Int32Array(sourceText.length).fill(-1);
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
        if (rawIdx < 0 || rawIdx >= rawToDom.length || rawToDom[rawIdx] !== -1) return;
        rawToDom[rawIdx] = domAt[textOffset + k];
        rawEndToDom[rawIdx] = domAt[textOffset + k] + 1;
        // A run of units on one raw offset is a reference that drew them all
        // (`&fjlig;` → `fj`, `&Afr;` → a surrogate pair): a hit ending on its
        // `;` ends after the last of them. One drawing a single unit (`&lt;`)
        // has no run and stays unplaceable by a hit on its whole, as before.
        let last = k;
        while (placed[last + 1] === rawIdx) last += 1;
        if (last === k) return;
        const reference = referenceAt(sourceText, rawIdx);
        if (reference && rawEndToDom[reference.end - 1] === -1) {
          rawEndToDom[reference.end - 1] = domAt[textOffset + last] + 1;
        }
      });
      textOffset += seg.length;
    }
  }

  return positions.map((pos) => {
    if (pos.end <= pos.start || pos.end > rawToDom.length) return null;
    const start = rawToDom[pos.start];
    const end = rawEndToDom[pos.end - 1];
    return start !== -1 && end !== -1 && end > start ? { start, end } : null;
  });
}
