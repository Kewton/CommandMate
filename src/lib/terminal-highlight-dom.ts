/**
 * terminal-highlight-dom.ts
 * Text-node walking and Range building shared by the search highlighter
 * (split out of terminal-highlight.ts, Issue #3517).
 */

/** Match position in container.textContent */
export interface MatchPosition {
  start: number;
  end: number;
}

/**
 * [Issue #3503] Marks a subtree whose text is drawn for the eye only — a mermaid
 * diagram's SVG (its `<style>` and labels), the loading / error text around it,
 * and the "Source" summary. Search counts none of it: none of it is in the
 * message as written.
 */
export const SEARCH_SKIP_ATTR = 'data-search-skip';

/**
 * [Issue #3503] Marks the element holding a mermaid block's source, verbatim.
 * The one place a hit inside a ```mermaid fence can be shown once the fence is
 * drawn as a diagram.
 */
export const MERMAID_SOURCE_ATTR = 'data-mermaid-source';

/**
 * [Issue #3503] Fired (bubbling) from a mermaid block whenever its diagram
 * finishes drawing or fails. The diagram is drawn late — a dynamic import, an
 * async render, and again on a theme switch — so a search highlighter listens
 * for it and re-applies, rather than keeping the current-match overlay placed
 * for the height the row had before (see `useHighlightReapplyTick`).
 */
export const MERMAID_BLOCK_SETTLED_EVENT = 'commandmate:mermaid-block-settled';

export type TextNodeEntry = { node: Text; start: number; end: number };

/**
 * Collect text nodes with cumulative offsets from a container element.
 * Subtrees marked {@link SEARCH_SKIP_ATTR} are left out entirely.
 */
export function collectTextNodes(container: Element): TextNodeEntry[] {
  const textNodes: TextNodeEntry[] = [];
  let offset = 0;
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        return (node as Element).hasAttribute(SEARCH_SKIP_ATTR)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const len = text.nodeValue?.length ?? 0;
    textNodes.push({ node: text, start: offset, end: offset + len });
    offset += len;
  }
  return textNodes;
}

/**
 * Create a Range for a given [posStart, posEnd) span across text nodes.
 */
export function buildRange(
  textNodes: TextNodeEntry[],
  posStart: number,
  posEnd: number
): Range | null {
  const range = document.createRange();
  let startSet = false;

  for (const { node, start, end } of textNodes) {
    if (!startSet && posStart < end && posStart >= start) {
      range.setStart(node, posStart - start);
      startSet = true;
    }
    if (startSet && posEnd <= end) {
      range.setEnd(node, posEnd - start);
      return range;
    }
  }
  return startSet ? range : null;
}
