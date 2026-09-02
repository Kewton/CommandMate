/**
 * CSS Custom Highlight namespaces for the chat transcript's in-place search
 * (Issue #2232).
 *
 * `CSS.highlights` is ONE global registry keyed by name, so every simultaneously
 * mounted surface that highlights text needs a name of its own — that is the
 * whole reason `makeHistoryNamespace(splitIndex)` exists (#744). The chat
 * transcript is a new such surface, and it can be on screen beside a
 * `HistoryPane`: on a phone the History tab and the chat surface are separate
 * screens today, but nothing structurally prevents a layout from mounting both,
 * and a split showing chat sits next to splits showing the History column.
 * Sharing `history-search-<idx>` would make one surface's search silently erase
 * the other's marks.
 *
 * Declared here rather than in `lib/terminal-highlight` because that module is
 * frozen by this Issue's scope; the type it exports is imported, which is all a
 * namespace needs to be usable by `applyHistoryHighlights`.
 *
 * Static `::highlight()` rules for `chat-search`, `chat-search-current` and
 * their per-split suffixes live in `src/app/globals.css` — `::highlight()`
 * cannot be created at runtime, so the rule set bounds the split count exactly
 * the way #744's does (MAX_SPLITS = 3, `src/config/terminal-split-config.ts`).
 */

import type { HighlightNamespace } from '@/lib/terminal-highlight';

/**
 * The single-surface namespace (phone, or any mount with no split index).
 *
 * The same blue as the History namespace on purpose: it is the same act — "the
 * text you searched for, in a transcript" — and giving chat a third color would
 * imply a distinction the user does not have.
 */
export const CHAT_SEARCH_NAMESPACE: HighlightNamespace = {
  highlightName: 'chat-search',
  currentHighlightName: 'chat-search-current',
  fallbackOverlayId: 'chat-search-fallback-overlay',
  fallbackOverlayBgColor: 'rgba(59, 130, 246, 0.6)',
};

/**
 * The namespace for a chat transcript mounted inside PC split `splitIndex`.
 *
 * @param splitIndex - 0-based split index (0..MAX_SPLITS-1)
 */
export function makeChatSearchNamespace(splitIndex: number): HighlightNamespace {
  return {
    highlightName: `chat-search-${splitIndex}`,
    currentHighlightName: `chat-search-current-${splitIndex}`,
    fallbackOverlayId: `chat-search-fallback-overlay-${splitIndex}`,
    fallbackOverlayBgColor: CHAT_SEARCH_NAMESPACE.fallbackOverlayBgColor,
  };
}

/** Resolve the namespace for a mount that may or may not be inside a split. */
export function resolveChatSearchNamespace(splitIndex: number | undefined): HighlightNamespace {
  return splitIndex === undefined ? CHAT_SEARCH_NAMESPACE : makeChatSearchNamespace(splitIndex);
}
