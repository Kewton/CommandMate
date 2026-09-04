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
 *
 * ## Issue #2309: a search-type picker is not a dozen rows
 *
 * command-code's `/model` and opencode's pickers are tens of rows long with no
 * number keys to answer them (Issue #2297 correctly refuses those a `1`–`9` row
 * — a typed digit there is a search character, not a choice). For those, `frame`
 * is not clipped to the tail at all (`extractDialogFrameTail`'s `selectionList`
 * option, driven off `reason === 'selectionList'`); the caller raises
 * `maxHeightClassName` instead, and this card's own `overflow-auto` turns the
 * rest into a scroll. {@link findHighlightLineIndex} then keeps the arrow-moved
 * highlight inside that scroll, because a list that is merely scrollable but
 * whose current row can drift out of view is not "reachable".
 *
 * ## Issue #2318: the follow was computed against the wrong height
 *
 * #2309 shipped that follow with the row's offset taken as a fraction of the
 * SCROLLABLE distance (`scrollHeight - clientHeight`) rather than of the rows
 * themselves, which compressed every position by `scrollable / scrollHeight`
 * and left the highlight out of view on all five sampled keypresses of a live
 * `/model` card. The scroll effect below now measures the row where it really
 * is; the arithmetic and its padding term are documented there.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { sanitizeTerminalOutput } from '@/lib/security/sanitize';
import { stripAnsi } from '@/lib/detection/ansi';
import {
  DIALOG_FRAME_DEFAULT_LINES,
  extractDialogFrameTail,
} from '@/lib/chat/dialog-frame';

/**
 * A TUI's own selection caret, at the start of a line (Issue #2309).
 *
 * The three glyphs `selection-shape.ts` documents as measured across the
 * fixtures this card renders: `❯` (claude / copilot), `›` (codex), `●`
 * (gemini). Matched with leading whitespace and a trailing space rather than
 * bare — a caret glyph appearing mid-sentence in an agent's own reply must not
 * be read as a highlight, and every measured dialog puts it flush left with a
 * space before the label.
 */
const HIGHLIGHT_CARET_PATTERN = /^[^\S\n]*[❯›●][^\S\n]/;

/**
 * Index of the LAST line carrying a selection caret, or -1.
 *
 * Last, not first: a TUI redraws the whole list on every keypress, so if more
 * than one row happened to start with a caret-shaped glyph (unlikely, but the
 * fixtures are real terminal output and not a controlled vocabulary) the
 * bottom-most one is the one nearest the footer, which is where the measured
 * dialogs place the currently highlighted row relative to the rest of a long
 * list scrolled into view.
 *
 * Exported for the unit suite; not part of the render loop's public surface.
 */
export function findHighlightLineIndex(plainText: string): number {
  const lines = plainText.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (HIGHLIGHT_CARET_PATTERN.test(lines[i])) return i;
  }
  return -1;
}

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

  // Issue #2309: a selection list is never tail-sliced — see
  // `DialogFrameTailOptions.selectionList`. `maxLines` still applies to a
  // pager / unclassified / promptUnreadable card, exactly as before.
  const isSelectionList = reason === 'selectionList';

  // Both steps memoised on the frame: the pane polls every couple of seconds and
  // usually returns the same bytes, and `sanitizeTerminalOutput` runs DOMPurify.
  const tail = useMemo(
    () => extractDialogFrameTail(frame, { maxLines, selectionList: isSelectionList }),
    [frame, maxLines, isSelectionList],
  );
  const html = useMemo(() => (tail ? sanitizeTerminalOutput(tail) : ''), [tail]);

  // --------------------------------------------------------------------
  // Highlight follow (Issue #2309, corrected by Issue #2318)
  // --------------------------------------------------------------------
  // A selection list this long only makes sense with the highlighted row kept
  // in view as the arrows move it — otherwise "scrollable" is not the same as
  // "reachable". The rows are one blob of HTML rather than one element per
  // line (see the docblock for why `TerminalDisplay`'s per-line diffing is not
  // reused here), so there is no element to `scrollIntoView`; the frame is
  // monospace with a fixed line height, so the row's own pixel offset is
  // computed from the line count instead — see the effect for the geometry and
  // for the two ways #2309 got it wrong.
  const frameRef = useRef<HTMLDivElement>(null);
  const highlightLineIndex = useMemo(
    () => (isSelectionList && tail ? findHighlightLineIndex(stripAnsi(tail)) : -1),
    [isSelectionList, tail],
  );
  useLayoutEffect(() => {
    if (highlightLineIndex < 0) return;
    const el = frameRef.current;
    if (!el) return;
    const totalLines = stripAnsi(tail).split('\n').length;
    if (totalLines <= 1) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable <= 0) return;

    // Issue #2318: row `i` lives at a fraction of the CONTENT height, not of
    // the SCROLLABLE distance. #2309 divided `highlightLineIndex` by
    // `totalLines - 1` and multiplied by `scrollHeight - clientHeight`, which
    // compresses every offset by `scrollable / scrollHeight` — measured on the
    // live `/model` card that is 765/1211 = 0.63, so the computed position ran
    // 155px short of the real row and the further down the list the arrows
    // went the worse it got. The denominator is `totalLines` (row `i` starts
    // `i` rows down, and there are `totalLines` rows), and the multiplicand is
    // the height the rows actually occupy.
    //
    // `scrollHeight` spans the scroller's padding box, so the rows are
    // `scrollHeight` minus this element's own vertical padding, and row 0
    // starts `paddingTop` below `scrollTop === 0`. Read via `getComputedStyle`
    // rather than hard-coded as 8 because the padding is the `p-2` class right
    // below and a later `p-3` must not silently push the highlight back out of
    // view; a box that reports no padding (jsdom lays nothing out) falls back
    // to an unpadded one, which is exactly what such a box is.
    const style = window.getComputedStyle(el);
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    const contentHeight = Math.max(0, el.scrollHeight - paddingTop - paddingBottom);
    const lineHeight = contentHeight / totalLines;
    const lineTop = paddingTop + highlightLineIndex * lineHeight;
    // Centre the ROW in the box, not the row's top edge — with a 15px row in a
    // 446px box the difference is half a line, but it is what keeps the last
    // row fully inside the viewport once the clamp below bites.
    const target = lineTop - (el.clientHeight - lineHeight) / 2;
    el.scrollTop = Math.min(scrollable, Math.max(0, target));
  }, [highlightLineIndex, tail]);

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
          sideways the way `TerminalDisplay`'s `wrapMode: 'frame'` does.

          Issue #2309: for a selection list this is real, scrollable content —
          `maxHeightClassName` is raised by the caller and this box no longer
          shows the whole thing at once, on purpose. */}
      <div
        ref={frameRef}
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
