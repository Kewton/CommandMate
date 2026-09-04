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
 *
 * ## Issue #2323: the arithmetic was right and its INPUT was wrong
 *
 * #2318 fixed WHERE row `i` is. It could not fix WHICH row `i` is, and for
 * Command Code that was never the highlighted one: its `/model` picker marks
 * the arrow-selected row with a BACKGROUND COLOUR and draws no selection caret
 * at all, so {@link HIGHLIGHT_CARET_PATTERN} fell through the list and matched
 * the filter row `› Type to search models...` — a row that never moves. Every
 * keypress then recomputed a correct pixel offset for the same wrong row, so
 * the card sat still while the selection walked off the bottom of it (UAT
 * 2026-09-04: rows at 704px and 825px of a 231..677 band, `scrollTop` 231
 * throughout). A caret-only rule fails SILENTLY in the one direction that is
 * not safe: a missing caret returns -1 and switches the follow off, which is
 * fine, but a caret on the WRONG row leaves it on and aimed at nothing.
 *
 * {@link findHighlightLineIndex} therefore reads the frame with its ANSI
 * intact and takes the last row carrying EITHER mark — a caret, or a
 * background the row is painted in and its neighbours are not. Both halves
 * already took the LAST match for the same documented reason; asking for the
 * last mark of either kind is that one rule over a two-glyph alphabet, not a
 * priority order between two rules.
 *
 * That is a correction to this Issue's own write-up, which proposed "the caret
 * if there is one, the paint otherwise". Measured on the committed capture
 * `tests/fixtures/chat-dialog-card-2254/command-code-model-1-40-1.txt`, that
 * order changes nothing at all: the filter row's `›` IS a caret (U+203A, the
 * glyph codex uses) and it is the only caret-shaped row on the whole frame, so
 * a caret-first rule keeps picking it.
 *
 * Re-derived across every ANSI capture committed to `tests/fixtures` (103
 * files): the paint outranks a caret on exactly one of them, this Issue's. So
 * claude, codex, copilot and gemini answer with the same index #2309 and #2318
 * measured, and every frame that had no mark at all still has none.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { sanitizeTerminalOutput } from '@/lib/security/sanitize';
import { stripAnsi } from '@/lib/detection/ansi';
import {
  backgroundValues,
  dominantBackground,
  scanRowBackgrounds,
} from '@/lib/detection/sgr-background';
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
 * Columns a background must cover before it can be a selected ROW (Issue #2323).
 *
 * A row highlight spans the row's label; a decoration spans a glyph or two.
 * Measured on the committed captures: Command Code's selected `/model` row
 * paints 72 columns and opencode's selected palette row 58, while the painted
 * cells inside claude's own boot logo paint 5 and 6
 * (`claude-model-2-1-259.txt`, rows 0–1). Eight sits between them, nearer the
 * decoration than the row, because the two mistakes do not cost the same:
 * following a logo is a card aimed at the wrong thing, which is the defect
 * this Issue exists to remove, while missing a very narrow highlight only
 * returns -1 and leaves the follow off.
 */
const HIGHLIGHT_MIN_PAINTED_COLUMNS = 8;

/**
 * Index of the LAST line marked as the current selection, or -1.
 *
 * Takes the frame with its ANSI **intact** (Issue #2323) — a background is the
 * only mark a tool that draws no caret leaves, and it exists only in the raw
 * bytes. A caller handing over a stripped frame still gets the caret rule,
 * i.e. every tool that draws one, so this degrades rather than breaks.
 *
 * Two marks, and the last one on the screen wins whichever kind it is:
 *
 *  - **a caret** ({@link HIGHLIGHT_CARET_PATTERN}) — claude, codex, copilot,
 *    gemini;
 *  - **a painted row** ({@link findPaintedHighlightLineIndex}) — Command Code's
 *    `/model` picker, which paints its selection and carets nothing.
 *
 * Last, not first: a TUI redraws the whole list on every keypress, so if more
 * than one row carries a mark (unlikely for one kind, routine across two — a
 * search-type picker carets its filter box AND paints its selection) the
 * bottom-most one is the one nearest the footer, which is where the measured
 * dialogs put the currently highlighted row relative to the rest of a long
 * list scrolled into view. `Math.max` also carries the -1: a frame with
 * neither mark still switches the follow off.
 *
 * Exported for the unit suite; not part of the render loop's public surface.
 */
export function findHighlightLineIndex(frame: string): number {
  const lines = frame.split('\n');

  let caret = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (HIGHLIGHT_CARET_PATTERN.test(stripAnsi(lines[i]))) {
      caret = i;
      break;
    }
  }

  return Math.max(caret, findPaintedHighlightLineIndex(lines));
}

/**
 * Index of the last row painted in a background its NEIGHBOURS do not use, or
 * -1.
 *
 * "That its neighbours do not use" is the whole rule, and it is what separates
 * the two things a `capture-pane -e` frame paints (Issue #2323's known trap
 * — "command-code paints only the selected row, opencode's overlay paints the
 * whole rectangle, and one rule may not cover both"):
 *
 *  - a **selection** is ONE row. Command Code's `/model` picker paints the
 *    arrow-selected row `48;2;45;43;85` and leaves its sixty-odd siblings bare;
 *    opencode's command palette paints its own selected row `48;2;250;178;131`
 *    INSIDE a panel every row of which is `48;2;20;20;20`;
 *  - a **panel** is a BLOCK of rows sharing one background — Command Code's
 *    boot banner is seven consecutive rows of `48;2;43;39;88` on that same
 *    capture, and the pane background some opencode themes paint is every row
 *    there is.
 *
 * So a row qualifies when the background it is MOSTLY painted in appears
 * nowhere on the row above or the row below. Two halves, both load-bearing:
 *
 *  - *mostly* ({@link dominantBackground}) rather than *anywhere*, because a
 *    panel's own chrome — a bottom border, a footer, a diff gutter — is an
 *    isolated colour too, and on the opencode palette a bare "some colour of
 *    its own" rule picks the `╹▀▀▀▀` border 46 rows below the selection;
 *  - *nowhere on the neighbours* ({@link backgroundValues}) rather than *not
 *    their dominant one*, because a highlight sits INSIDE its panel and the
 *    panel's colour is on the rows around it whether or not it dominates them.
 *
 * The measured limit of this: where a theme paints the whole pane edge to edge
 * and centres a narrower overlay on it — opencode at the 200 columns
 * `TUI_PANE_WIDTH` captures at — the pane's own background dominates every
 * row, including the selected one, and this returns -1. That is the answer
 * such a frame gave before this Issue too, so nothing regressed there; it is
 * simply not fixed, and Issue #2255's structured picker is what would fix it
 * properly, by giving the card an element to `scrollIntoView`.
 */
function findPaintedHighlightLineIndex(lines: readonly string[]): number {
  const rows = lines.map(scanRowBackgrounds);
  const dominant = rows.map(dominantBackground);
  const values = rows.map(backgroundValues);

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const { bg, columns } = dominant[i];
    if (bg === null || columns < HIGHLIGHT_MIN_PAINTED_COLUMNS) continue;
    if (i > 0 && values[i - 1].has(bg)) continue;
    if (i + 1 < rows.length && values[i + 1].has(bg)) continue;
    return i;
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
  // Highlight follow (Issue #2309; arithmetic corrected by #2318, input by #2323)
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
    () => (isSelectionList && tail ? findHighlightLineIndex(tail) : -1),
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
