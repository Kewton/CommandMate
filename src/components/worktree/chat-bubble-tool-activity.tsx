import React, { useCallback, useState } from 'react';

/** The row a bubble sits in. Alignment is the bubble's own `ml-auto` / `mr-auto`. */
export const CHAT_BUBBLE_ROW_CLASS = 'flex w-full flex-col gap-1 pb-3';

// ============================================================================
// Tool activity (Issue #2284)
// ============================================================================

/** What the transcript has decided about the folded logs beneath it. */
export interface ChatToolActivityState {
  /** True while every folded tool row in this subtree should be open. */
  readonly showAll: boolean;
}

/**
 * The transcript-wide answer to "is tool activity showing?".
 *
 * A context rather than a prop threaded through four components because the
 * three things it governs are at three different depths — the approval group is
 * a ROW of the virtual list, the tool log and the reasoning are inside a
 * Markdown body inside a bubble — and because the live and held bubbles reach
 * `ChatMarkdownBody` by a different path from the settled one. A prop would
 * have to be added to every one of those signatures, and the first renderer
 * that forgot to pass it would silently opt itself out of the toggle.
 *
 * Defaulting to folded matters: `ChatMessageBubble` is rendered directly by
 * several suites and by `HistoryPane`'s neighbours with no provider above it,
 * and "no provider" has to mean the same thing as "the reader has not asked for
 * the logs".
 */
const ChatToolActivityContext = React.createContext<ChatToolActivityState>({ showAll: false });

/** Publishes the transcript's verdict to every chip below it. */
export const ChatToolActivityProvider = ChatToolActivityContext.Provider;

/**
 * The value one row wears while it is holding a search hit (Issue #2284).
 *
 * A module constant, not an object literal at the call site: the provider's
 * value is compared by identity, and a fresh `{ showAll: true }` per render
 * would re-render every chip in every matched row on every keystroke.
 */
export const CHAT_TOOL_ACTIVITY_OPEN: ChatToolActivityState = { showAll: true };

/**
 * What all three folded logs are drawn as: one `rounded-full` chip.
 *
 * #2245 gave the approval run this shape and #2272 copied it for the reasoning;
 * #2284 adds the tool log and turns the third copy into the one constant. They
 * have to look the same because they ARE the same thing to a reader — a
 * subordinate log they may want and do not want first — and three chips that
 * differed by a padding value would read as three different kinds of row.
 */
export const CHAT_TOOL_ACTIVITY_CHIP_CLASS = [
  'mr-auto flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border',
  'bg-surface-2 px-2.5 py-1 text-xs text-muted-foreground transition-colors',
  'hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
].join(' ');

/**
 * One folded chip's open/closed state, obeying the transcript's toggle.
 *
 * The rule the Issue asks for is "the toggle sets every chip, and a chip the
 * reader opened by hand stays open until the toggle moves again". That is
 * exactly React's documented shape for adjusting state when a prop changes,
 * with the transcript's verdict as the prop: the local override records WHICH
 * verdict it was taken against, so the moment the verdict changes the override
 * stops applying and every chip in the column agrees again. No effect, no
 * subscription, and nothing to clean up when a virtualized row unmounts.
 *
 * @returns Whether this chip is open, and the click handler that flips it
 */
export function useChatToolActivityDisclosure(): {
  isOpen: boolean;
  toggle: () => void;
} {
  const { showAll } = React.useContext(ChatToolActivityContext);
  const [override, setOverride] = useState<{ against: boolean; isOpen: boolean } | null>(null);

  const isOpen = override !== null && override.against === showAll ? override.isOpen : showAll;
  const toggle = useCallback(
    () => setOverride({ against: showAll, isOpen: !isOpen }),
    [showAll, isOpen],
  );

  return { isOpen, toggle };
}
