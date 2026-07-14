/**
 * View Transitions guard utilities (Issue #1122).
 *
 * A thin, dependency-free wrapper around the browser View Transitions API used
 * to crossfade route content as a progressive enhancement. The DOM update is
 * only wrapped in `document.startViewTransition` when the API exists and the
 * user has not requested reduced motion; otherwise the update runs immediately
 * (instant navigation). Keeping the guard here (rather than delegating to a
 * library) makes feature-detection and the reduced-motion opt-out directly
 * unit-testable, and localizes the future swap to the Next 15 / React 19 native
 * View Transitions.
 */

/** Callback that performs the DOM/route update to animate between. */
export type ViewTransitionUpdate = () => void | Promise<void>;

/** Minimal shape of the object returned by `document.startViewTransition`. */
export interface ViewTransitionLike {
  readonly finished: Promise<void>;
  readonly ready: Promise<void>;
  readonly updateCallbackDone: Promise<void>;
  skipTransition(): void;
}

interface DocumentWithViewTransition {
  startViewTransition?: (callback: ViewTransitionUpdate) => ViewTransitionLike;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** True when the browser exposes the View Transitions API. */
export function supportsViewTransitions(): boolean {
  if (typeof document === 'undefined') return false;
  const doc = document as unknown as DocumentWithViewTransition;
  return typeof doc.startViewTransition === 'function';
}

/** True when the user has requested reduced motion at the OS level. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Run `update` inside a view transition when supported and motion is allowed;
 * otherwise run it immediately (no animation, no error). Returns the running
 * transition when one started, or `null` for the instant-fallback path.
 */
export function startViewTransition(update: ViewTransitionUpdate): ViewTransitionLike | null {
  if (!supportsViewTransitions() || prefersReducedMotion()) {
    void update();
    return null;
  }
  const doc = document as unknown as DocumentWithViewTransition;
  return doc.startViewTransition!(update);
}
