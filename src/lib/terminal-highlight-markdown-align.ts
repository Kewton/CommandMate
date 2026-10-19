/**
 * terminal-highlight-markdown-align.ts
 * Reads the {@link SEARCH_RAW_ATTR} marks back off the DOM and places search
 * hits on the text Markdown drew (Issue #3698: split out of
 * terminal-highlight-markdown.ts).
 */

import type { MatchPosition, TextNodeEntry } from './terminal-highlight-dom';
import { isWhitespace, referenceAt } from './terminal-highlight-markdown-reference';

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

/** A `[start, end)` range of the raw message. */
export interface RawSpan {
  start: number;
  end: number;
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
 * as above) and, when the waiting units are what it drew, they are placed on
 * its `&` too (Issue #3682: `&ThickSpace;`, `&NewLine;`). A name Markdown does
 * not know is drawn as written, and placed so.
 */
export function alignSubsequence(text: string, raw: string, spans: readonly RawSpan[], from = spans[0]?.start ?? 0): number[] | null {
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
  // Consecutive units of `text`: any other unit places the ones waiting.
  let pending: number[] = [];
  let pendingFrom = from;
  /**
   * [Issue #3682] The first reference drawing whitespace in `[at, limit)`
   * whose units are the waiting ones from `next` on — where its `&` is, the
   * raw offset after it, and how many units it drew.
   */
  const whitespaceReference = (at: number, limit: number, next: number): { idx: number; end: number; units: number } | null => {
    for (let idx = raw.indexOf('&', at); idx !== -1 && idx < limit; idx = raw.indexOf('&', idx + 1)) {
      if (inSpan(idx) === -1) continue;
      const found = referenceAt(raw, idx);
      if (!found || !/^\s+$/.test(found.drawn) || next + found.drawn.length > pending.length) continue;
      const drawn = pending.slice(next, next + found.drawn.length).map((k) => text[k]).join('');
      if (drawn === found.drawn) return { idx, end: found.end, units: found.drawn.length };
    }
    return null;
  };
  const placePending = (limit: number): void => {
    let at = pendingFrom;
    for (let next = 0; next < pending.length; next++) {
      const k = pending[next];
      const found = find(text[k], at, limit);
      // [Issue #3682] Whitespace a reference drew (`&ThickSpace;`) is on its
      // `&`, as every other unit a reference drew, when it comes before the
      // raw whitespace.
      const reference = whitespaceReference(at, found ? found.idx : limit, next);
      if (reference) {
        for (let drawn = 0; drawn < reference.units; drawn++) out[pending[next + drawn]] = reference.idx;
        next += reference.units - 1;
        at = reference.end;
      } else if (found) {
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
 * reference is placed by a hit starting on its `&` and by one ending on its
 * `;` — a hit on its whole marks every unit it drew, one or several,
 * whitespace or not (Issues #3671, #3682); a hit ending inside its name is not
 * placed. Returns
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
        // [Issue #3682] The units on one raw `&` that are what the reference
        // there drew — however many (`&lt;` → `<`, `&fjlig;` → `fj`,
        // `&ThickSpace;` → two spaces) — are the reference drawn: a hit ending
        // on its `;` ends after the last of them. Placed as written (inline
        // code), its `&` draws only `&` and the next unit is on the next raw
        // character, so `;` keeps its own place.
        if (sourceText[rawIdx] !== '&') return;
        let last = k;
        while (placed[last + 1] === rawIdx) last += 1;
        if (placed[last + 1] === rawIdx + 1) return;
        const reference = referenceAt(sourceText, rawIdx);
        if (
          reference &&
          reference.drawn.length === last - k + 1 &&
          text.startsWith(reference.drawn, k) &&
          rawEndToDom[reference.end - 1] === -1
        ) {
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
