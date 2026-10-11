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
 * 2. {@link usePaneOverlayDismiss} — how an overlaid (unpinned) panel closes:
 *    - Esc → `onDismiss('escape')`, when the key was pressed in the panel, in
 *      one of the `ignoreSelectors` regions (the activity bar) or on the page
 *      body — never from the terminal or another field elsewhere (Esc means
 *      something to the agent CLI), and never while a dialog or menu is open
 *      anywhere on the page (that Esc is the dialog's).
 *    - A press outside the panel → `onDismiss('outside')`, only when ALL of:
 *        - the press is not inside the panel's React tree. Portals rendered by
 *          the panel (dialogs, context menus, popovers) are part of that tree,
 *          so operating them never closes the panel even though they are not
 *          DOM descendants of it;
 *        - the press is not inside an `ignoreSelectors` region (the panel's
 *          own toggle — re-clicking the icon is the toggle's job);
 *        - no dialog / menu is open on the page (a dialog opened FROM the
 *          panel through a provider, e.g. `confirm()`, is outside both trees);
 *        - nothing in the panel has been edited since it opened (any `input`
 *          event in the panel's React tree counts — the panel cannot tell a
 *          saved edit from an unsaved one, so it errs on keeping the edit on
 *          screen) and the caller's `isDirty()` does not say otherwise.
 *    - The caller closes on × / a re-click itself; both are unconditional.
 *
 *    The hook does nothing while `enabled` is false (panel closed or pinned).
 *    Spread the returned `panelProps` on the panel's root element.
 */

'use client';

import { useCallback, useEffect, useRef, useState, type RefObject, type SyntheticEvent } from 'react';

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
  /** Attach the listeners only while true (open and not pinned). */
  enabled: boolean;
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
  /** Extra "has unsaved edits" signal from the caller. */
  isDirty?: () => boolean;
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

/** Anything on the page that owns the next click / Esc rather than the panel. */
const OPEN_DIALOG_SELECTOR =
  '[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"]';

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

  // A newly opened (or newly switched) panel has no edits yet.
  useEffect(() => {
    editedRef.current = false;
  }, [enabled, resetKey]);

  useEffect(() => {
    if (!enabled) return undefined;

    const handlePointerDown = (event: Event): void => {
      if (ownEventsRef.current.has(event)) return;
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      if (isInsideAny(target, ignoreRef.current)) return;
      if (isInsideAny(target, [OPEN_DIALOG_SELECTOR])) return;
      if (document.querySelector(OPEN_DIALOG_SELECTOR) !== null) return;
      if (editedRef.current || isDirtyRef.current?.() === true) return;
      onDismissRef.current('outside');
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector(OPEN_DIALOG_SELECTOR) !== null) return;
      const target = event.target;
      const fromPanel = target instanceof Node && panelRef.current?.contains(target) === true;
      const fromIgnored = isInsideAny(target, ignoreRef.current);
      const fromBody = target === document.body || target === document.documentElement || target === document;
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
