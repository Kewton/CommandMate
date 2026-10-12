
/**
 * useActivityPaneOverlay (Issue #3589)
 *
 * The behaviour behind a side panel that opens OVER the body instead of
 * beside it, so opening it never narrows the terminal. Two parts, both
 * reusable by any panel of that kind (Issue #3591 uses the same pair):
 *
 * 1. {@link usePanePinnedState} — the pin. Pinned means "lay the panel out
 *    beside the body as before"; unpinned means "lay it over the body". The
 *    choice is persisted under the storage key the caller passes (the
 *    activity pane uses `ACTIVITY_PANE_PINNED_STORAGE_KEY`), as the string
 *    `'true'` / `'false'`; anything else reads as not pinned.
 *
 * 2. {@link usePaneOverlayDismiss} — how an open panel closes on its own:
 *    - Esc → `onDismiss('escape')`, when the key was pressed in the panel or in
 *      one of the `ignoreSelectors` regions (the header tools, where the icon
 *      that opened it lives) — pinned or not, like × and a re-click. While
 *      unpinned, an Esc on the page body counts too. Never from the terminal or
 *      another field elsewhere (Esc means something to the agent CLI), never
 *      when the key's own handler called `preventDefault()` (the file search
 *      box clears its query / blurs on Esc and says so that way), and never
 *      while a modal dialog or open menu is up ({@link isAnyModalOpen} — the
 *      same check New task uses, so the inline PromptPanel and dialogs in
 *      hidden splits do not count — or an open {@link OPEN_FLOATING_LAYER_SELECTOR}
 *      such as the file tree's context menu; that Esc is theirs).
 *    - A press outside the panel → `onDismiss('outside')`, only while unpinned
 *      and only when ALL of:
 *        - the press is not inside the panel's React tree. Portals rendered by
 *          the panel (dialogs, context menus, popovers) are part of that tree,
 *          so operating them never closes the panel even though they are not
 *          DOM descendants of it;
 *        - the press is not inside an `ignoreSelectors` region (the panel's
 *          own toggle — re-clicking the icon is the toggle's job);
 *        - no modal dialog / open menu is up ({@link isAnyModalOpen}; a dialog
 *          opened FROM the panel through a provider, e.g. `confirm()`, is
 *          outside both trees) and no floating layer is open
 *          ({@link OPEN_FLOATING_LAYER_SELECTOR}: the press closes the file
 *          tree's context menu, not the panel);
 *        - the panel has no unsaved edits. The caller's `isDirty()` decides
 *          when it returns a boolean — content that knows its draft (the Env
 *          editor, through {@link useReportPaneDirty}) counts button edits as
 *          edits and a save as the end of them. When it returns `undefined`
 *          (content that reports nothing), any `input` event in the panel's
 *          React tree since it opened counts instead.
 *    - The caller closes on × / a re-click itself; both are unconditional.
 *
 *    The hook does nothing while `enabled` is false (panel closed).
 *    Spread the returned `panelProps` on the panel's root element.
 *
 * 3. {@link PaneDirtyContext} / {@link useReportPaneDirty} /
 *    {@link usePaneDirtyTracker} — how the content tells the frame it has
 *    unsaved edits. The owner keeps a tracker, hands `reportDirty` to the
 *    provider around the content (`ActivityPane`'s `onDirtyChange`) and
 *    `isDirty` to the frame; the content calls `useReportPaneDirty(dirty)`.
 *    Outside a provider the call does nothing (the mobile Env tab).
 */

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { isAnyModalOpen } from '@/lib/new-task/modal-open';
import { isUnhandledEscape } from '@/lib/escape-key';

/**
 * A floating layer that is up and owns the next press / Esc, but is not a
 * modal by `isAnyModalOpen()`'s definition — the custom file-tree
 * `ContextMenu` (`role="menu"` without Radix's `data-state`) marks itself with
 * `data-floating-layer="open"` while open (Issue #3589). Kept separate so the
 * New task / Mod+B check in `modal-open.ts` is unchanged.
 */
export const OPEN_FLOATING_LAYER_SELECTOR = '[data-floating-layer="open"]';

/** A modal dialog, an open Radix menu, or an open floating layer. */
function isBlockingLayerOpen(): boolean {
  return isAnyModalOpen() || document.querySelector(OPEN_FLOATING_LAYER_SELECTOR) !== null;
}

// ============================================================================
// Pin
// ============================================================================

export interface UsePanePinnedStateReturn {
  /** Whether the panel is laid out beside the body (true) or over it (false). */
  pinned: boolean;
  /** Flip the pin and persist it. */
  togglePinned: () => void;
}

function readPinned(storageKey: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(storageKey) === 'true';
  } catch {
    /* localStorage unavailable */
  }
  return false;
}

function writePinned(storageKey: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, String(value));
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * Pin state of an overlay panel, persisted under `storageKey`.
 *
 * SSR and the first client render return `false` (not pinned); the stored
 * value is read in an effect, like `useActivityBarState`, so there is no
 * hydration mismatch.
 */
export function usePanePinnedState(storageKey: string): UsePanePinnedStateReturn {
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  useEffect(() => {
    setPinned(readPinned(storageKey));
  }, [storageKey]);

  const togglePinned = useCallback((): void => {
    const next = !pinnedRef.current;
    setPinned(next);
    writePinned(storageKey, next);
  }, [storageKey]);

  return { pinned, togglePinned };
}

// ============================================================================
// Dismiss
// ============================================================================

/** Why an overlay panel asked to be closed. */
export type PaneDismissReason = 'escape' | 'outside';

export interface UsePaneOverlayDismissOptions {
  /** Attach the listeners only while true (the panel is open). */
  enabled: boolean;
  /**
   * Pinned beside the body: only Esc from the panel or an `ignoreSelectors`
   * region closes it — no outside press, no Esc from the page body.
   */
  pinned?: boolean;
  /** The panel's root element. */
  panelRef: RefObject<HTMLElement | null>;
  /** Close the panel. */
  onDismiss: (reason: PaneDismissReason) => void;
  /**
   * CSS selectors of regions that are not "outside" (the panel's toggle). A
   * press there neither closes the panel nor counts as outside; Esc pressed
   * there still closes it.
   */
  ignoreSelectors?: readonly string[];
  /**
   * Whether the panel has unsaved edits. A boolean is authoritative; return
   * `undefined` to fall back to "an `input` event happened in the panel".
   */
  isDirty?: () => boolean | undefined;
  /**
   * Changing this forgets the "edited" flag (the panel now shows something
   * else, e.g. another activity).
   */
  resetKey?: unknown;
}

export interface UsePaneOverlayDismissReturn {
  /** Spread on the panel's root element. */
  panelProps: {
    onPointerDownCapture: (event: SyntheticEvent) => void;
    onInputCapture: () => void;
  };
}

function isInsideAny(target: EventTarget | null, selectors: readonly string[]): boolean {
  if (!(target instanceof Element)) return false;
  return selectors.some((selector) => target.closest(selector) !== null);
}

/**
 * Esc / outside-press dismissal of an overlay panel. See the module comment
 * for the exact rules.
 */
export function usePaneOverlayDismiss({
  enabled,
  pinned = false,
  panelRef,
  onDismiss,
  ignoreSelectors = [],
  isDirty,
  resetKey,
}: UsePaneOverlayDismissOptions): UsePaneOverlayDismissReturn {
  // Native events that passed through the panel's React tree (portals
  // included). React's capture listeners run before the document's bubble
  // listener below, so the set is filled by the time it is read.
  const ownEventsRef = useRef<WeakSet<Event>>(new WeakSet());
  const editedRef = useRef(false);

  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const ignoreRef = useRef(ignoreSelectors);
  ignoreRef.current = ignoreSelectors;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  // A newly opened (or newly switched) panel has no edits yet.
  useEffect(() => {
    editedRef.current = false;
  }, [enabled, resetKey]);

  useEffect(() => {
    if (!enabled) return undefined;

    const handlePointerDown = (event: Event): void => {
      if (pinnedRef.current) return;
      if (ownEventsRef.current.has(event)) return;
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      if (isInsideAny(target, ignoreRef.current)) return;
      if (isBlockingLayerOpen()) return;
      const dirty = isDirtyRef.current?.();
      if (dirty === true || (dirty === undefined && editedRef.current)) return;
      onDismissRef.current('outside');
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isUnhandledEscape(event)) return;
      if (isBlockingLayerOpen()) return;
      const target = event.target;
      const fromPanel = target instanceof Node && panelRef.current?.contains(target) === true;
      const fromIgnored = isInsideAny(target, ignoreRef.current);
      const fromBody =
        !pinnedRef.current &&
        (target === document.body || target === document.documentElement || target === document);
      if (!fromPanel && !fromIgnored && !fromBody) return;
      onDismissRef.current('escape');
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, panelRef]);

  const onPointerDownCapture = useCallback((event: SyntheticEvent): void => {
    ownEventsRef.current.add(event.nativeEvent);
  }, []);

  const onInputCapture = useCallback((): void => {
    editedRef.current = true;
  }, []);

  return { panelProps: { onPointerDownCapture, onInputCapture } };
}

// ============================================================================
// Unsaved edits
// ============================================================================

/**
 * Receives the panel content's unsaved state: `true` / `false`, or `null` when
 * the content stops reporting (it unmounted or was switched away).
 */
export type PaneDirtyReporter = (dirty: boolean | null) => void;

/** Provided around a panel's content by its owner (see `ActivityPane`). */
export const PaneDirtyContext = createContext<PaneDirtyReporter | null>(null);

/**
 * Report this content's unsaved state to the panel it is shown in. A no-op
 * outside a {@link PaneDirtyContext} provider.
 */
export function useReportPaneDirty(dirty: boolean): void {
  const report = useContext(PaneDirtyContext);
  useEffect(() => {
    report?.(dirty);
  }, [report, dirty]);
  useEffect(() => {
    if (!report) return undefined;
    return () => report(null);
  }, [report]);
}

export interface UsePaneDirtyTrackerReturn {
  /** Hand to the {@link PaneDirtyContext} provider around the content. */
  reportDirty: PaneDirtyReporter;
  /** Hand to `usePaneOverlayDismiss` / the frame: `undefined` = not reported. */
  isDirty: () => boolean | undefined;
}

/** The owner's side of {@link useReportPaneDirty}. Kept in a ref: no re-render. */
export function usePaneDirtyTracker(): UsePaneDirtyTrackerReturn {
  const dirtyRef = useRef<boolean | null>(null);
  const reportDirty = useCallback<PaneDirtyReporter>((dirty) => {
    dirtyRef.current = dirty;
  }, []);
  const isDirty = useCallback(() => dirtyRef.current ?? undefined, []);
  return { reportDirty, isDirty };
}
