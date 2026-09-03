'use client';

/**
 * ChatDialogCard — the pane's last rows, drawn on the chat surface (Issue #2254).
 *
 * Epic #2192's decision 5 was that a TUI dialog, a selection list, a pager and
 * an unclassified frame are terminal-only: the chat surface raised a banner and
 * offered one button, "open the terminal". **That decision is withdrawn.** The
 * banner said what was happening and then took the screen away from the user; on
 * a phone, where the terminal is a different tab and the transcript is what they
 * were reading, that is the difference between answering a dialog and losing it.
 *
 * This card is the missing half: the same rows the terminal surface would show,
 * clipped to the tail by {@link extractDialogFrameTail}, with the state's own
 * controls directly underneath (the caller supplies those as `actions`).
 *
 * ## It is a permanently dark island, on purpose and by token
 *
 * `docs/design-system.md` classifies a surface that reproduces a fixed xterm
 * palette as #1075 category (a): it stays dark in BOTH themes, because the
 * frame's own SGR colours were chosen against a dark background and a light card
 * would render an agent's grey-on-black dialog as grey-on-white. The colours
 * come from `bg-terminal-surface` / `text-terminal-foreground`, the tokens #1892
 * added for exactly this, and NOT from raw `gray-*` utilities — the guard's
 * `*Terminal*` filename exclusion is explicitly not the route to take for a new
 * island (design-system.md: 「新しい常時ダーク島をこの除外に足さないこと」),
 * because it hangs the design on a spelling. That is also why this file is
 * `ChatDialogCard` and not `ChatTerminalDialogCard`.
 *
 * The chrome AROUND the frame (the border, the label, the action row) is
 * theme-following, like the surface it sits on. Only the frame itself is dark.
 *
 * ## Why not `TerminalDisplay`
 *
 * Issue #2254 asks for `TerminalDisplay` reused at a height limit, and that is
 * the right instinct — it is the component that already turns a raw frame into
 * safe HTML. Two of its behaviours are global rather than per-instance, and both
 * misfire when a second copy is mounted beside the first:
 *
 *  1. it subscribes to the `terminal-search-open` WINDOW event (the phone's
 *     actions sheet and the PC pane header both dispatch it), so a second mount
 *     opens a second search bar over the card for a search aimed at the pane;
 *  2. it renders its own scroll FAB pinned `absolute bottom-4 right-4`, which in
 *     a 16-row card lands on top of the dialog's footer row.
 *
 * What is actually load-bearing is `sanitizeTerminalOutput` — the ANSI→HTML
 * conversion plus DOMPurify with `ALLOWED_TAGS: ['span','br']` — and that is a
 * pure function this uses directly, so the two surfaces cannot render the same
 * escape sequence differently. The rest of `TerminalDisplay` (selection-
 * preserving chunk diffing, auto-follow, search) exists for a streaming
 * thousand-row log; this card is a dozen rows that change when the user presses
 * a key.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { sanitizeTerminalOutput } from '@/lib/security/sanitize';
import {
  DIALOG_FRAME_DEFAULT_LINES,
  extractDialogFrameTail,
} from '@/lib/chat/dialog-frame';

export interface ChatDialogCardProps {
  /** A raw `capture-pane -p -e` frame — `PaneTerminalState.output`. */
  frame: string;
  /**
   * Rows to draw, clamped by {@link extractDialogFrameTail} into the Issue's
   * 12–20 window. The phone passes the low end (Issue #2106's budget).
   */
  maxLines?: number;
  /**
   * Height cap for the scrolling frame, as a Tailwind `max-h-*` class.
   *
   * A class rather than a number because Tailwind cannot see a computed one, and
   * the card must never be able to grow without bound: it is inside the
   * `shrink-0` live region, so every pixel it takes comes out of the transcript.
   */
  maxHeightClassName?: string;
  /** The state's own controls, rendered directly under the frame. */
  actions?: React.ReactNode;
  /** Why the card is up. Published as `data-reason` for the unit suite. */
  reason?: string;
  className?: string;
}

export function ChatDialogCard({
  frame,
  maxLines = DIALOG_FRAME_DEFAULT_LINES,
  maxHeightClassName = 'max-h-64',
  actions,
  reason,
  className = '',
}: ChatDialogCardProps) {
  const t = useTranslations('worktree');

  // Both steps memoised on the frame: the pane polls every couple of seconds and
  // usually returns the same bytes, and `sanitizeTerminalOutput` runs DOMPurify.
  const tail = useMemo(() => extractDialogFrameTail(frame, { maxLines }), [frame, maxLines]);
  const html = useMemo(() => (tail ? sanitizeTerminalOutput(tail) : ''), [tail]);

  if (!tail) return null;

  return (
    <div
      data-testid="chat-dialog-card"
      data-reason={reason}
      role="group"
      aria-label={t('chatSurface.dialogCardLabel')}
      className={['flex min-w-0 flex-col gap-2', className].filter(Boolean).join(' ')}
    >
      {/* The dark island. `overflow-auto` in both axes: rows are captured at
          `TUI_PANE_WIDTH` (200 columns) and re-wrapping a box-drawn dialog at a
          phone's width would break every border it draws, so the card scrolls
          sideways the way `TerminalDisplay`'s `wrapMode: 'frame'` does. */}
      <div
        data-testid="chat-dialog-card-frame"
        // `role="log"` would claim this is a live region; it is a still frame the
        // reader is being shown, and the surface already owns one live region.
        className={`overflow-auto rounded-lg border border-border bg-terminal-surface p-2 font-mono text-[11px] leading-snug text-terminal-foreground ${maxHeightClassName}`}
      >
        <div
          className="whitespace-pre w-max"
          // Same converter, same DOMPurify allow-list (`span` / `br` + `style`)
          // as the terminal surface — see the docblock for why this is the piece
          // of `TerminalDisplay` that is reused and the rest is not.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      {actions ? (
        <div data-testid="chat-dialog-card-actions" className="min-w-0">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export default ChatDialogCard;
