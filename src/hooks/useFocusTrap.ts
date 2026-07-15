/**
 * useFocusTrap (Issue #1127)
 *
 * Confines keyboard focus to a container while it is active — the missing piece
 * for our modal/bottom-sheet surfaces (`ui/Modal`, `MobilePromptSheet`,
 * `MobileTerminalActionsSheet`) which previously let Tab escape to the page
 * behind the overlay.
 *
 * Why a hook instead of Radix Dialog: those surfaces are bespoke (custom portal,
 * enter/exit animation via useExitAnimation/usePromptAnimation, and swipe-to-
 * dismiss). Swapping in `@radix-ui/react-dialog` — not currently a dependency —
 * would force a rewrite of all three and their tests. A single shared hook adds
 * the trap without disturbing that machinery, and keeps the implementation in
 * one place per the issue's "focus trap は1実装に集約" directive.
 *
 * Behaviour while `active`:
 * - moves focus into the container on activation (initial focus),
 * - cycles Tab / Shift+Tab within the container's focusable elements,
 * - restores focus to the previously focused element on deactivation/unmount.
 */

'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Elements that can receive keyboard focus. Visibility is intentionally not part
 * of the filter: layout metrics (offsetParent / getClientRects) are unavailable
 * under jsdom, so we exclude disabled controls and tabindex="-1" up front and
 * drop `hidden` / `aria-hidden` nodes below instead.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface UseFocusTrapOptions {
  /** Whether the trap is engaged. Defaults to true. */
  active?: boolean;
  /** Move focus into the container when the trap engages. Defaults to true. */
  initialFocus?: boolean;
  /** Restore focus to the previously focused element on release. Defaults to true. */
  restoreFocus?: boolean;
}

/**
 * Returns a ref to attach to the trap container. Attach it to the dialog/sheet
 * panel; the panel is made programmatically focusable (tabindex="-1") if it is
 * not already, so initial focus can land on the dialog itself.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  options: UseFocusTrapOptions = {}
): RefObject<T | null> {
  const { active = true, initialFocus = true, restoreFocus = true } = options;
  const containerRef = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Whether focus already sat inside the container when the trap engaged.
    // React applies `autoFocus` during commit (before this effect), so a
    // consumer that autofocuses one of its own controls lands here as "inside".
    // In that case the consumer owns focus: we neither steal initial focus nor
    // hijack focus restoration from it (e.g. ConfirmDialog / ConfirmProvider).
    const previouslyInside =
      previouslyFocused !== null && container.contains(previouslyFocused);

    const getFocusable = (): HTMLElement[] =>
      Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter(
        (el) =>
          !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
      );

    if (initialFocus && !previouslyInside) {
      if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1');
      }
      container.focus();
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        // Nothing focusable inside — keep focus pinned to the container.
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const onContainer = activeEl === container;

      // Focus sits outside the trap entirely — pull it back to the edge.
      if (!activeEl || !container.contains(activeEl)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey) {
        // Wrap backwards from the first element (or the container itself).
        if (activeEl === first || onContainer) {
          event.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || onContainer) {
        // Wrap forwards from the last element (or the container itself).
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Only restore focus the trap itself moved in from outside; if focus
      // started inside (consumer-managed), leave restoration to the consumer.
      if (
        restoreFocus &&
        !previouslyInside &&
        previouslyFocused &&
        document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  }, [active, initialFocus, restoreFocus]);

  return containerRef;
}

export default useFocusTrap;
