/**
 * terminal-highlight-mermaid.ts
 * Maps raw-text match offsets onto a DOM whose mermaid fences are drawn as
 * diagrams (split out of terminal-highlight.ts, Issue #3517).
 */

import {
  MERMAID_RAW_END_ATTR,
  MERMAID_RAW_START_ATTR,
  MERMAID_SOURCE_ATTR,
  type MatchPosition,
  type TextNodeEntry,
} from './terminal-highlight-dom';
import { fenceFromRawRange, findMermaidFences, type MermaidFence } from './terminal-highlight-fences';

/** Offsets of every (overlapping) occurrence of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let cursor = 0;
  while (true) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx === -1) return found;
    found.push(idx);
    cursor = idx + 1;
  }
}

type Span = { start: number; end: number };

/** Sorted, merged copy of `spans`. */
function normalizeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((x, y) => x.start - y.start);
  const out: Span[] = [];
  for (const span of sorted) {
    const prev = out[out.length - 1];
    if (prev && span.start <= prev.end) prev.end = Math.max(prev.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

/** `base` with every span of `cut` removed (both normalized). */
function subtractSpans(base: Span[], cut: Span[]): Span[] {
  let out = base.map((s) => ({ ...s }));
  for (const c of cut) {
    out = out.flatMap((s) => {
      if (c.end <= s.start || c.start >= s.end) return [s];
      const parts: Span[] = [];
      if (c.start > s.start) parts.push({ start: s.start, end: c.start });
      if (c.end < s.end) parts.push({ start: c.end, end: s.end });
      return parts;
    });
  }
  return out;
}

/** `spans` limited to [from, to). */
function clipSpans(spans: Span[], from: number, to: number): Span[] {
  return spans
    .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) }))
    .filter((s) => s.end > s.start);
}

/** Offsets of `needle` inside each span of `text`, in order, never across spans. */
function occurrencesIn(text: string, spans: Span[], needle: string): number[] {
  return spans.flatMap((span) =>
    occurrences(text.slice(span.start, span.end), needle)
      .filter((idx) => span.start + idx + needle.length <= span.end)
      .map((idx) => span.start + idx),
  );
}

const inSpans = (spans: Span[], pos: number): boolean =>
  spans.some((s) => pos >= s.start && pos < s.end);

/**
 * [Issue #3503] A part of a message drawn somewhere of its own — chat folds the
 * `> **Thinking**` and tool-log sections out of the answer and draws each under
 * a chip, in a different order from the raw text. `ranges` are where the part is
 * in the raw text; the DOM drawing it carries `data-search-section="<key>"`.
 */
export interface HighlightSection {
  key: string;
  ranges: MatchPosition[];
}

/** [Issue #3503] Marks the element a {@link HighlightSection} is drawn in. */
export const SEARCH_SECTION_ATTR = 'data-search-section';

interface SourceOnScreen {
  domStart: number;
  domEnd: number;
  text: string;
  element: Element;
}

/**
 * [Issue #3525] The fences of a region as Markdown drew them: each source
 * element names its fence's raw range ({@link MERMAID_RAW_START_ATTR}), so
 * fence and source pair directly. `null` unless every source in the region
 * names a range that reads back as a fence with that source's body, inside the
 * region and in order — then the region pairs by body instead.
 */
function structuralFences(sourceText: string, raw: Span[], sources: SourceOnScreen[]): MermaidFence[] | null {
  if (sources.length === 0) return null;
  const fences: MermaidFence[] = [];
  for (const source of sources) {
    const start = Number.parseInt(source.element.getAttribute(MERMAID_RAW_START_ATTR) ?? '', 10);
    const end = Number.parseInt(source.element.getAttribute(MERMAID_RAW_END_ATTR) ?? '', 10);
    if (!Number.isInteger(start) || !Number.isInteger(end) || !inSpans(raw, start)) return null;
    const fence = fenceFromRawRange(sourceText, start, end, source.text);
    const prev = fences[fences.length - 1];
    if (!fence || (prev && fence.fenceStart < prev.fenceEnd)) return null;
    fences.push(fence);
  }
  return fences;
}

/**
 * [Issue #3503] Translate offsets into the raw message text to offsets into the
 * container's (skip-filtered) text, for a message whose mermaid fences are drawn
 * as diagrams with their source folded underneath.
 *
 * The raw text and the DOM no longer line up there: the fence lines are not
 * drawn, the diagram is not counted, a "Source" summary is not counted, quote
 * markers are not drawn, and chat draws the reasoning and the tool log in their
 * own place. So the message is first cut into regions — each
 * {@link HighlightSection} the caller names, and the rest — matched to the DOM
 * by `data-search-section`. Inside a region, raw fences and on-screen sources
 * are paired by the raw range each source names (Issue #3525: the fence as
 * Markdown parsed it — nested lists, tabs, quoted tool logs), or, when a source
 * names none, by matching fences found in the raw text ({@link findMermaidFences};
 * Issue #3544: only where Markdown opens one) in order by equal body, and:
 *
 * - a hit inside a paired fence body maps to the same place in that source;
 * - a hit inside a fence that could not be paired (its source is not on
 *   screen, or the bodies do not line up) is `null` — never another diagram's;
 * - a hit between fences is the n-th occurrence of its text in that stretch of
 *   raw text (fences left out), and maps to the n-th occurrence of the same text
 *   in the matching stretch of the region's DOM (sources left out);
 * - a hit on a fence line (```mermaid itself) has nothing on screen: `null`.
 *
 * Returns `null` when the container shows no mermaid source at all, so the
 * caller keeps the plain offset-equals-offset behaviour every other message has.
 */
export function mapRawPositionsToDom(
  container: Element,
  textNodes: TextNodeEntry[],
  sourceText: string,
  positions: MatchPosition[],
  sections: HighlightSection[],
): Array<MatchPosition | null> | null {
  const sourceElements = Array.from(container.querySelectorAll(`[${MERMAID_SOURCE_ATTR}]`));
  if (sourceElements.length === 0) return null;
  let lineFences: MermaidFence[] | null = null;
  const fencesByLine = (): MermaidFence[] => (lineFences ??= findMermaidFences(sourceText));
  const domText = textNodes.map((entry) => entry.node.nodeValue ?? '').join('');

  // Which region a DOM node belongs to: the named section it is drawn in, or ''.
  const sectionKeys = new Set(sections.map((section) => section.key));
  const regionOfNode = (node: Node): string => {
    const holder = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))
      ?.closest(`[${SEARCH_SECTION_ATTR}]`);
    const key = holder && container.contains(holder) ? holder.getAttribute(SEARCH_SECTION_ATTR) : null;
    return key !== null && sectionKeys.has(key) ? key : '';
  };

  const sectionRaw = new Map(sections.map((section) => [section.key, normalizeSpans(section.ranges)]));
  const allSectionRaw = normalizeSpans(sections.flatMap((section) => section.ranges));
  const regions = ['', ...sectionKeys].map((key) => {
    const raw =
      key === '' ? subtractSpans([{ start: 0, end: sourceText.length }], allSectionRaw) : sectionRaw.get(key)!;
    const dom = normalizeSpans(
      textNodes.filter((entry) => regionOfNode(entry.node) === key).map(({ start, end }) => ({ start, end })),
    );
    const sources: SourceOnScreen[] = [];
    for (const element of sourceElements) {
      if (regionOfNode(element) !== key) continue;
      const inside = textNodes.filter((entry) => element.contains(entry.node));
      if (inside.length === 0) continue;
      const domStart = inside[0].start;
      const domEnd = inside[inside.length - 1].end;
      sources.push({ domStart, domEnd, text: domText.slice(domStart, domEnd), element });
    }
    const structural = structuralFences(sourceText, raw, sources);
    const regionFences = structural ?? fencesByLine().filter((fence) => inSpans(raw, fence.fenceStart));

    // Pair in order by equal body. Equal counts must match one-to-one; otherwise
    // a source takes the next fence with its body.
    const pairs: Array<{ fence: MermaidFence; source: SourceOnScreen }> = [];
    if (structural) {
      structural.forEach((fence, k) => pairs.push({ fence, source: sources[k] }));
    } else if (
      regionFences.length === sources.length &&
      regionFences.every((fence, k) => fence.body === sources[k].text)
    ) {
      regionFences.forEach((fence, k) => pairs.push({ fence, source: sources[k] }));
    } else {
      let cursor = 0;
      for (const source of sources) {
        for (let k = cursor; k < regionFences.length; k++) {
          if (regionFences[k].body === source.text) {
            pairs.push({ fence: regionFences[k], source });
            cursor = k + 1;
            break;
          }
        }
      }
    }

    // Stretches between paired fences, each with its DOM counterpart. Every
    // fence and every source is left out of the stretches, so a word between
    // diagrams can only land on text between diagrams.
    const fenceSpans = normalizeSpans(regionFences.map((f) => ({ start: f.fenceStart, end: f.fenceEnd })));
    const sourceSpans = normalizeSpans(sources.map((src) => ({ start: src.domStart, end: src.domEnd })));
    const gaps: Array<{ raw: Span[]; dom: Span[]; rawFrom: number; rawTo: number }> = [];
    let rawFrom = 0;
    let domFrom = 0;
    const bounds = [
      ...pairs.map((pair) => ({
        rawStart: pair.fence.fenceStart,
        rawEnd: pair.fence.fenceEnd,
        domStart: pair.source.domStart,
        domEnd: pair.source.domEnd,
      })),
      { rawStart: Number.POSITIVE_INFINITY, rawEnd: 0, domStart: Number.POSITIVE_INFINITY, domEnd: 0 },
    ];
    for (const bound of bounds) {
      gaps.push({
        raw: subtractSpans(clipSpans(raw, rawFrom, bound.rawStart), fenceSpans),
        dom: subtractSpans(clipSpans(dom, domFrom, bound.domStart), sourceSpans),
        rawFrom,
        rawTo: bound.rawStart,
      });
      rawFrom = bound.rawEnd;
      domFrom = bound.domEnd;
    }
    return { raw, fences: regionFences, pairs, gaps };
  });

  const lowerRaw = sourceText.toLowerCase();
  const lowerDom = domText.toLowerCase();

  return positions.map((pos) => {
    const length = pos.end - pos.start;
    const region = regions.find((r) => inSpans(r.raw, pos.start));
    if (!region) return null;

    const fence = region.fences.find((f) => pos.start >= f.fenceStart && pos.start < f.fenceEnd);
    if (fence) {
      const pair = region.pairs.find((p) => p.fence === fence);
      if (!pair) return null;
      const line = fence.lines.find((l) => pos.start >= l.rawStart && pos.start < l.rawStart + l.length);
      if (!line) return null;
      const start = pair.source.domStart + line.bodyOffset + (pos.start - line.rawStart);
      return { start, end: Math.min(start + length, pair.source.domEnd) };
    }

    const gap = region.gaps.find((g) => pos.start >= g.rawFrom && pos.start < g.rawTo);
    if (!gap) return null;
    const needle = lowerRaw.slice(pos.start, pos.end);
    const ordinal = occurrencesIn(lowerRaw, gap.raw, needle).indexOf(pos.start);
    const onScreen = occurrencesIn(lowerDom, gap.dom, needle);
    if (ordinal === -1 || ordinal >= onScreen.length) return null;
    return { start: onScreen[ordinal], end: onScreen[ordinal] + length };
  });
}

/**
 * [Issue #3503] A hit inside a folded mermaid source is shown by unfolding it.
 * Only a `<details>` that holds a mermaid source is opened — nothing else the
 * container happens to fold.
 */
export function openFoldedSource(range: Range, container: Element): void {
  const start = range.startContainer;
  const element = start.nodeType === Node.TEXT_NODE ? start.parentElement : (start as Element);
  const details = element?.closest('details');
  if (
    details instanceof HTMLDetailsElement &&
    !details.open &&
    container.contains(details) &&
    details.querySelector(`[${MERMAID_SOURCE_ATTR}]`)
  ) {
    details.open = true;
  }
}
