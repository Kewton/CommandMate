/**
 * useExitAnimation Hook
 *
 * Issue #1114: Separates "close request" from "unmount" so overlay UI
 * (Modal / Toast / ContextMenu) can play an exit animation before being
 * removed from the DOM. While `open` is false but the exit window has not
 * elapsed, the component keeps rendering with `isExiting = true` and should
 * apply its exit animation classes; after `duration` ms it may unmount.
 *
 * The timer duration must match the CSS animation duration — pass the
 * constants from `@/config/ui-feedback-config` (EXIT_ANIMATION_DURATION_MS /
 * CONTEXT_MENU_EXIT_DURATION_MS), which mirror the motion tokens in
 * globals.css (Issue #1050).
 */

'use client';

import { useEffect, useState } from 'react';

/**
 * Return type for useExitAnimation hook
 */
export interface UseExitAnimationReturn {
  /** Whether the component should still be rendered in the DOM */
  shouldRender: boolean;
  /** Whether the exit animation window is in progress (closed but rendered) */
  isExiting: boolean;
}

/**
 * Hook that delays unmounting until an exit animation can complete.
 *
 * @param open - Whether the component is logically open/visible
 * @param duration - Exit animation duration in milliseconds
 * @returns Render gating state and exit-in-progress flag
 *
 * @example
 * ```tsx
 * const { shouldRender, isExiting } = useExitAnimation(isOpen, EXIT_ANIMATION_DURATION_MS);
 *
 * if (!shouldRender) return null;
 *
 * return <div data-state={isExiting ? 'closed' : 'open'} className="..." />;
 * ```
 */
/** Internal lifecycle state */
type ExitState = 'open' | 'exiting' | 'closed';

export function useExitAnimation(
  open: boolean,
  duration: number
): UseExitAnimationReturn {
  const [state, setState] = useState<ExitState>(open ? 'open' : 'closed');

  // Render-phase sync (the React "adjust state when props change" pattern):
  // opening must not lag a frame behind the `open` prop, and closing must
  // enter the exit window in the same render — an effect would be too late.
  if (open && state !== 'open') {
    setState('open');
  } else if (!open && state === 'open') {
    setState('exiting');
  }

  useEffect(() => {
    if (open || state !== 'exiting') return;

    // Keep rendering for the exit window, then release for unmount.
    // Re-opening during the window changes the deps and clears the timer.
    const timeout = setTimeout(() => {
      setState('closed');
    }, duration);

    return () => clearTimeout(timeout);
  }, [open, state, duration]);

  return {
    shouldRender: open || state !== 'closed',
    isExiting: !open && state === 'exiting',
  };
}

export default useExitAnimation;
