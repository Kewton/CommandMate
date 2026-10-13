/**
 * Width fitting for the worktree screen's two top rows on PC (Issue #2481,
 * Issue #3590).
 *
 * Both rows live in a column that is `overflow-hidden`, so anything pushed past
 * the right edge is cut off with no way to scroll to it. Each row therefore has
 * a group that may shrink (`min-w-0`, its text truncates) and controls that
 * never do. When truncating is not enough — the shrinking group's content is
 * wider than its box — the row gives something up, one step at a time, and
 * measures again:
 *
 * - the header (`DesktopHeader`): fold its tools behind a "…" button one at a
 *   time from the end (Issue #3591), then clip the identity group
 *   ({@link useDesktopHeaderFit}). Issue #3593: its session field has a fixed
 *   width, so there are no agent pills to fold;
 * - the second row (`TerminalSplitContainer`'s action bar): drop the History /
 *   Files labels to their icons, then move the slotted items (the
 *   Verification chip, and with one split that split's session controls,
 *   Issue #3592) behind a "…" button, then clip the layout ops
 *   ({@link useSplitActionBarFit}).
 *
 * @module hooks/useDesktopHeaderFit
 */

'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import type React from 'react';

/**
 * Issue #3615: marks a clipping element (a `truncate` span) that must keep at
 * least this many pixels of its text — e.g. the lone split's agent name in the
 * second row. Clipped narrower than that, it counts as "does not fit", so the
 * row gives up its next step instead of squeezing the name to one letter.
 * Unclipped, it keeps its natural width, however short.
 */
export const FIT_MIN_WIDTH_ATTR = 'data-fit-min-width';

/**
 * Whether anything in a row's shrinking group is wider than its box
 * (Issue #2481).
 *
 * The group's own overflow catches content pushed past its edge. The walk
 * catches content that collides inside it without widening anything: the
 * verification chip squeezed below its badges paints them over its own ⓘ
 * toggle, and the chip is a slot the row does not look into. Elements that
 * clip (the `truncate` spans) are wider than their box by design and skipped —
 * unless clipped below their {@link FIT_MIN_WIDTH_ATTR} (Issue #3615).
 */
export function contentOverflows(group: HTMLElement): boolean {
  if (group.scrollWidth > group.clientWidth + 1) return true;
  for (const el of Array.from(group.querySelectorAll('*'))) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    // Issue #3615: a clipping element that must stay readable — clipped
    // below its declared width, it no longer fits either.
    const minWidth = Number(el.getAttribute(FIT_MIN_WIDTH_ATTR));
    if (minWidth > 0 && el.clientWidth < minWidth) return true;
    if (getComputedStyle(el).overflowX !== 'visible') continue;
    return true;
  }
  return false;
}

/**
 * How many steps a row has given up to fit its width: 0 is "everything as
 * designed", `maxStep` is the last resort.
 *
 * The measurement runs in a layout effect, whose state updates re-render before
 * the browser paints, so the intermediate steps are never seen. Steps only go
 * one way, so the fit restarts from 0 whenever there may be room again: the row
 * got wider or narrower (a ResizeObserver — opening the sidebar resizes the
 * row without resizing the window), or `contentKey` changed.
 *
 * @param rowRef - The row, observed for size changes
 * @param groupRef - The shrinking group; its overflow is the "does not fit" signal
 * @param contentKey - What changes the row's widths and can be keyed
 * @param maxStep - The last step
 * @param unkeyedContent - Content whose width `contentKey` cannot capture (a
 *   node passed in as a slot): a new value re-measures without restarting, so
 *   content that grows gives up a step and content that shrinks waits for the
 *   next resize
 * @param watchedContent - An element whose content other components render
 *   (a portal target): any change inside it re-measures the way
 *   `unkeyedContent` does (Issue #3592)
 */
function useFitSteps(
  rowRef: React.RefObject<HTMLElement | null>,
  groupRef: React.RefObject<HTMLElement | null>,
  contentKey: string,
  maxStep: number,
  unkeyedContent: unknown,
  watchedContent: HTMLElement | null = null
): number {
  const [fit, setFit] = useState(() => ({ key: contentKey, step: 0 }));

  // Reset while rendering (React's "adjust state when a prop changes"
  // pattern), not in an effect: an effect would run after the step below in
  // the same commit and be overwritten by it.
  let current = fit;
  if (fit.key !== contentKey) {
    current = { key: contentKey, step: 0 };
    setFit(current);
  }

  // While the group's content overflows, give up one more step. Every step is
  // a new `fit`, so this re-runs until the row fits or hits the last step; a
  // step never undoes one, so the chain ends.
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group || fit.step >= maxStep || !contentOverflows(group)) return;
    setFit((prev) => (prev.step >= maxStep ? prev : { ...prev, step: prev.step + 1 }));
    // `watchedContent`: a new slot is new content (its portal fills it in the
    // same commit), checked here before the observer below starts watching.
  }, [groupRef, fit, maxStep, unkeyedContent, watchedContent]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    let lastWidth: number | null = null;
    let lastHeight: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      const widthChanged = rect.width !== lastWidth;
      if (!widthChanged && rect.height === lastHeight) return;
      lastWidth = rect.width;
      lastHeight = rect.height;
      // A new width may hold more: start again from 0. The row's width comes
      // from its parent, never from its own content, so this cannot feed back
      // into itself. A height-only change (display size) is only re-checked —
      // a fresh object re-renders, and the step above can only go further, so
      // it cannot oscillate either.
      setFit((prev) => (widthChanged ? { key: prev.key, step: 0 } : { ...prev }));
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [rowRef]);

  // Issue #3592: content portalled into the row by another component changes
  // no prop of the row's owner, so neither `contentKey` nor `unkeyedContent`
  // sees it — a model, a cost or a note that grows would stay cut. Re-check
  // when it changes, and only when the group now overflows: like
  // `unkeyedContent`, this can only give up a step, never undo one.
  useEffect(() => {
    const group = groupRef.current;
    if (!watchedContent || !group || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (!contentOverflows(group)) return;
      // At the last step there is nothing left to give up, so no re-render:
      // a re-render touches the watched content itself (React re-applies an
      // <input>'s `name` / `type` on every update), and the group can stay
      // over its width at the last step (it clips) — re-rendering here would
      // feed this observer forever.
      setFit((prev) => (prev.step >= maxStep ? prev : { ...prev }));
    });
    observer.observe(watchedContent, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    return () => observer.disconnect();
  }, [groupRef, watchedContent, maxStep]);

  return Math.min(current.step, maxStep);
}

/** What the desktop header can afford at its current width (Issue #2481). */
export interface DesktopHeaderFit {
  /**
   * Issue #3591: how many of the header's tools, counted from the end, have
   * left the row for the "…" button (`HeaderToolBar`'s `foldedCount`). Always
   * 0 when the header has no tools.
   */
  foldedTools: number;
  /**
   * The last resort: the identity group and the agent row clip horizontally
   * instead of painting under the right-hand controls. Only after every tool
   * has folded.
   */
  squeezed: boolean;
}

/**
 * Fits the desktop header's one row to its width (Issue #2481).
 *
 * At 1470px with the sidebar open, the identity (status dot, name, repository,
 * branch) plus the agent row and controls no longer fit, and the header's
 * parent is `overflow-hidden` — so the right end (Info) was cut off with no
 * way to scroll to it. The layout decides who gives way: the controls group
 * never shrinks, the identity group (`min-w-0`) takes what is left and
 * truncates. This hook handles the point where truncating is not enough:
 * {@link DesktopHeaderFit.squeezed}.
 *
 * Issue #3590: the Verification chip left the header for the second row
 * ({@link useSplitActionBarFit}), so nothing in the header is unkeyed any more.
 * Issue #3593: the agent pills, which used to fold into "+N" one at a time
 * before this step, became a fixed-width session field — the same width
 * whatever the number of sessions — so there is nothing to fold first.
 *
 * Issue #3591: the worktree's tools moved into the header (`HeaderToolBar`),
 * inside the controls group that never shrinks. Before the identity group
 * clips, they fold behind a "…" button one at a time from the end — step `k`
 * (1 … `toolCount`) folds the last `k` — so the narrower the header, the more
 * tools are two clicks away, and only past the last one does the row clip.
 *
 * @param headerRef - The header row, observed for size changes
 * @param identityRef - The left group; its overflow is the "does not fit" signal
 * @param contentKey - What changes the row's widths
 * @param toolCount - Issue #3591: how many tools the header draws (0: none)
 */
export function useDesktopHeaderFit(
  headerRef: React.RefObject<HTMLElement | null>,
  identityRef: React.RefObject<HTMLElement | null>,
  contentKey: string,
  toolCount = 0
): DesktopHeaderFit {
  const tools = Math.max(0, toolCount);
  const step = useFitSteps(headerRef, identityRef, `${contentKey}\ntools:${tools}`, tools + 1, null);
  return { foldedTools: Math.min(step, tools), squeezed: step >= tools + 1 };
}

/** What the split action bar (the second row) can afford (Issue #3590). */
export interface SplitActionBarFit {
  /** The History / Files toggles show their icons only (the label stays their accessible name). */
  compactToggles: boolean;
  /**
   * The slotted items (the Verification chip) leave the bar for a floating
   * panel behind a "…" button, which never shrinks — so the chip, its ⓘ and
   * its reason stay reachable however narrow the terminal side gets (e.g. a
   * file panel dragged to leave the terminal its 20% minimum).
   * Issue #3592: with one split, that split's agent selector, Terminal /
   * Chat and note go with them — Issue #3615: also when the agent's name
   * would be clipped below its readable width.
   */
  itemsFolded: boolean;
  /**
   * The last resort: the left group (by then only the layout ops) clips
   * horizontally instead of painting under the panel toggles.
   */
  squeezed: boolean;
}

/**
 * Fits the split action bar — the worktree screen's second row — to its width
 * (Issue #3590), the way {@link useDesktopHeaderFit} fits the header.
 *
 * The left group holds the layout icons, Equal / Maximize and the slotted
 * items (the Verification chip, whose title truncates but whose badges and ⓘ
 * cannot); the History / Files toggles never shrink. Once the chip is down to
 * its badges, the toggles drop their labels first, then the items fold behind
 * the "…" button, then the left group clips.
 *
 * Issue #3615: with one split, the agent's name counts as "does not fit" once
 * clipped below its readable width ({@link FIT_MIN_WIDTH_ATTR}), so it is
 * folded rather than squeezed to one letter. The order stays: the toggles'
 * labels go first, since an icon with its accessible name costs no click,
 * while the folded selector does.
 *
 * @param barRef - The action bar, observed for size changes
 * @param leftRef - The left group; its overflow is the "does not fit" signal
 * @param contentKey - What changes the bar's widths and can be keyed
 * @param slotContent - The slotted node (unkeyed: a chip that grows re-measures)
 * @param portalSlot - Issue #3592: the slot the lone split portals its
 *   session controls into, watched for changes (null: none)
 */
export function useSplitActionBarFit(
  barRef: React.RefObject<HTMLElement | null>,
  leftRef: React.RefObject<HTMLElement | null>,
  contentKey: string,
  slotContent: unknown,
  portalSlot: HTMLElement | null = null
): SplitActionBarFit {
  const step = useFitSteps(barRef, leftRef, contentKey, 3, slotContent, portalSlot);
  return { compactToggles: step >= 1, itemsFolded: step >= 2, squeezed: step >= 3 };
}
