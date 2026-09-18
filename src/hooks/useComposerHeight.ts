/**
 * useComposerHeight — the PC composer's stored textarea height (Issue #2598, #2681).
 *
 * Two hooks and the pure functions under them:
 *
 * - {@link useComposerHeight} is the composer's side: which height floor (if any) is
 *   stored for this worktree and scope, what is actually drawn once the
 *   caller's upper bound is applied, and the two operations the handle needs.
 * - {@link useComposerMaxHeight} is the caller's side: the tallest the textarea
 *   may be before the body above the composer drops below its floor.
 *
 * ## 保存値は下限（floor）
 *
 * 保存値は下限であって固定高さではない。内容が下限より短ければ下限まで、
 * 長ければ `COMPOSER_AUTO_MAX_HEIGHT_PX` まで伸びる。
 * ハンドルを下げると下限が下がる（縮小して固定されるのではない）。床は `COMPOSER_MIN_HEIGHT_PX`。
 * ダブルクリックは下限を消して既定（36px）に戻す。
 *
 * ## Clamping is display-only
 *
 * The upper bound moves with the pane — a shorter window, the #2421 grid, a
 * prompt panel opening in the footer — and none of that is the user changing
 * their mind. So the bound applies to what is drawn and never to what is
 * stored: leave the grid and the stored height comes back. Only a drag or an
 * arrow key writes, and it writes what the user saw.
 *
 * ## Storage
 *
 * `commandmate:composer-height:<worktreeId>:<scope>` (see
 * `src/config/composer-height.ts` for the scopes). Every read and write is
 * best-effort: an unavailable storage leaves the height working for the
 * session, and a value that is not a number in range is treated as absent.
 */

'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  COMPOSER_HEIGHT_STORAGE_KEY_PREFIX,
  COMPOSER_MAX_STORED_HEIGHT_PX,
  COMPOSER_MIN_HEIGHT_PX,
} from '@/config/composer-height';

/** `useLayoutEffect` warns on the server; see `useIsMobile` for the same pattern. */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** The composer's textarea, as `useComposerMaxHeight` finds it inside the composer. */
export const COMPOSER_TEXTAREA_SELECTOR = '[data-testid="message-input-textarea"]';

/** Full localStorage key for one worktree and scope. */
export function getComposerHeightStorageKey(worktreeId: string, scope: string): string {
  return `${COMPOSER_HEIGHT_STORAGE_KEY_PREFIX}${worktreeId}:${scope}`;
}

/**
 * A stored value as a height, or `null` when it is not one.
 *
 * Accepts what {@link writeComposerHeight} writes (an integer) and rejects
 * everything else a corrupted or hand-edited entry could hold: an empty string,
 * a non-number, a non-finite number, and anything outside
 * `[COMPOSER_MIN_HEIGHT_PX, COMPOSER_MAX_STORED_HEIGHT_PX]`.
 */
export function parseStoredComposerHeight(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < COMPOSER_MIN_HEIGHT_PX || rounded > COMPOSER_MAX_STORED_HEIGHT_PX) return null;
  return rounded;
}

/**
 * `height` bounded by the floor and by `maxHeight`.
 *
 * `maxHeight` is optional because the caller may not have measured yet; the
 * floor wins over it, so a pane too short for even one line still draws one.
 */
export function clampComposerHeight(height: number, maxHeight?: number | null): number {
  const ceiling =
    maxHeight === null || maxHeight === undefined || !Number.isFinite(maxHeight)
      ? COMPOSER_MAX_STORED_HEIGHT_PX
      : Math.min(maxHeight, COMPOSER_MAX_STORED_HEIGHT_PX);
  return Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(Math.round(height), ceiling));
}

/** The stored height for one worktree and scope, or `null`. */
export function readComposerHeight(worktreeId: string, scope: string): number | null {
  try {
    return parseStoredComposerHeight(
      window.localStorage.getItem(getComposerHeightStorageKey(worktreeId, scope)),
    );
  } catch {
    return null;
  }
}

/** Store a height (bounded to the storable range). */
export function writeComposerHeight(worktreeId: string, scope: string, height: number): void {
  try {
    window.localStorage.setItem(
      getComposerHeightStorageKey(worktreeId, scope),
      String(clampComposerHeight(height)),
    );
  } catch {
    /* storage unavailable: the height still applies for this session */
  }
}

/** Remove the stored height, returning the composer to auto-grow. */
export function clearComposerHeight(worktreeId: string, scope: string): void {
  try {
    window.localStorage.removeItem(getComposerHeightStorageKey(worktreeId, scope));
  } catch {
    /* storage unavailable */
  }
}

export interface UseComposerHeightOptions {
  worktreeId: string;
  /** `split:<n>` / `session-tile`. Absent: nothing is read, written or applied. */
  scope?: string | null;
  /** Upper bound on the drawn height, from {@link useComposerMaxHeight}. */
  maxHeight?: number | null;
  /** False on a phone: the stored height is neither applied nor changeable there. */
  enabled?: boolean;
}

export interface UseComposerHeightResult {
  /** What is stored as the height floor, unbounded by `maxHeight`. `null` = default auto-grow floor. */
  storedHeight: number | null;
  /** What to draw as the height floor within the bounds, or `null` for default auto-grow floor. */
  height: number | null;
  /**
   * Grow (positive) or lower (negative) the floor by `delta` pixels and store the result.
   * `currentHeight` is the textarea's drawn height, the starting point when no
   * floor is stored yet (the first drag starts from what auto-grow drew).
   */
  resizeBy: (delta: number, currentHeight: number) => void;
  /** Forget the stored floor (returns to default auto-grow floor). */
  reset: () => void;
}

export function useComposerHeight({
  worktreeId,
  scope,
  maxHeight,
  enabled = true,
}: UseComposerHeightOptions): UseComposerHeightResult {
  const active = enabled && !!scope;
  const [stored, setStored] = useState<number | null>(null);
  // What the handlers read. A drag delivers many moves between two renders, and
  // each has to build on the one before it, not on the last rendered value.
  const storedRef = useRef<number | null>(null);
  const maxRef = useRef<number | null | undefined>(maxHeight);

  useIsomorphicLayoutEffect(() => {
    const next = active && scope ? readComposerHeight(worktreeId, scope) : null;
    storedRef.current = next;
    setStored(next);
  }, [active, worktreeId, scope]);

  useIsomorphicLayoutEffect(() => {
    maxRef.current = maxHeight;
  }, [maxHeight]);

  const resizeBy = useCallback(
    (delta: number, currentHeight: number) => {
      if (!active || !scope || !Number.isFinite(delta)) return;
      const bound = maxRef.current;
      const base =
        storedRef.current === null
          ? clampComposerHeight(currentHeight, bound)
          : clampComposerHeight(storedRef.current, bound);
      const next = clampComposerHeight(base + delta, bound);
      storedRef.current = next;
      setStored(next);
      writeComposerHeight(worktreeId, scope, next);
    },
    [active, worktreeId, scope],
  );

  const reset = useCallback(() => {
    if (!active || !scope) return;
    storedRef.current = null;
    setStored(null);
    clearComposerHeight(worktreeId, scope);
  }, [active, worktreeId, scope]);

  const storedHeight = active ? stored : null;
  const height = storedHeight === null ? null : clampComposerHeight(storedHeight, maxHeight);

  return { storedHeight, height, resizeBy, reset };
}

/**
 * The tallest the composer's textarea may be drawn with `bodyEl` kept at
 * `minBodyPx` or more, or `null` when that cannot be measured.
 *
 * `bodyEl` is the flexible body of a column whose other children (header,
 * footer) keep their size, and the textarea is inside one of those children.
 * The space the body is given is the column's content height minus the other
 * children; whatever of it goes beyond `minBodyPx` may go to the textarea on
 * top of the height it already has:
 *
 *     max = textarea + (column − other children) − minBodyPx
 *
 * Summing from the column rather than reading the body's own height matters
 * when the body has a CSS floor (the sessions tile's `min-h-[15rem]`): a body
 * pinned at its floor reports the floor, not the space it was given, and a
 * too-tall textarea would then measure as fitting.
 *
 * Returns `null` while the textarea is not rendered (height 0, e.g. a split
 * hidden by maximize), so the caller keeps its last bound instead of clamping
 * to the floor and springing back.
 */
export function measureComposerMaxHeight(
  bodyEl: HTMLElement,
  textareaEl: HTMLElement,
  minBodyPx: number,
): number | null {
  const column = bodyEl.parentElement;
  if (!column) return null;
  const textareaHeight = textareaEl.getBoundingClientRect().height;
  if (textareaHeight <= 0) return null;
  let others = 0;
  for (const child of Array.from(column.children)) {
    if (child === bodyEl || !(child instanceof HTMLElement)) continue;
    const { display, position } = window.getComputedStyle(child);
    // Out-of-flow children (an absolutely positioned overlay) take no height.
    if (display === 'none' || position === 'absolute' || position === 'fixed') continue;
    others += child.getBoundingClientRect().height;
  }
  const bodySpace = contentBoxHeight(column) - others;
  return Math.floor(textareaHeight + bodySpace - minBodyPx);
}

/**
 * An element's content-box height, from its fractional border-box rect.
 * (`clientHeight` is rounded to an integer, and half a pixel of error here is
 * half a pixel the body loses below its floor.)
 */
function contentBoxHeight(el: HTMLElement): number {
  const style = window.getComputedStyle(el);
  const px = (value: string) => parseFloat(value) || 0;
  return (
    el.getBoundingClientRect().height -
    px(style.borderTopWidth) -
    px(style.borderBottomWidth) -
    px(style.paddingTop) -
    px(style.paddingBottom)
  );
}

/**
 * {@link measureComposerMaxHeight}, kept current.
 *
 * Watches the column (window resize, #2421 grid rows, maximize, split count),
 * the body, the composer (a prompt panel or an error banner joining the footer)
 * and the textarea. The bound is invariant under the textarea's own growth —
 * the body gives up exactly what the textarea takes — so typing does not
 * re-render the caller.
 *
 * Elements rather than refs so that a composer mounted later (the sessions
 * tile mounts it only on screen) re-subscribes.
 */
export function useComposerMaxHeight(
  bodyEl: HTMLElement | null,
  composerEl: HTMLElement | null,
  minBodyPx: number,
): number | null {
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  // The last value handed to React: a window drag fires the observer every
  // frame, and most frames leave the bound where it was.
  const lastRef = useRef<number | null>(null);

  // A layout effect, so the first bound lands before the first paint and a tall
  // stored height is never drawn unbounded for a frame.
  useIsomorphicLayoutEffect(() => {
    if (!bodyEl || !composerEl || typeof ResizeObserver === 'undefined') return;
    const textarea = composerEl.querySelector<HTMLElement>(COMPOSER_TEXTAREA_SELECTOR);
    if (!textarea) return;
    const measure = () => {
      const next = measureComposerMaxHeight(bodyEl, textarea, minBodyPx);
      if (next === null || next === lastRef.current) return;
      lastRef.current = next;
      setMaxHeight(next);
    };
    const observer = new ResizeObserver(measure);
    const column = bodyEl.parentElement;
    if (column) observer.observe(column);
    observer.observe(bodyEl);
    observer.observe(composerEl);
    observer.observe(textarea);
    measure();
    return () => observer.disconnect();
  }, [bodyEl, composerEl, minBodyPx]);

  return maxHeight;
}
