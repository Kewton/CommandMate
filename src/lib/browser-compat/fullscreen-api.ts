/**
 * Browser-compat shims for the Fullscreen API.
 *
 * Centralizes the vendor-prefix (webkit/moz/ms) fallbacks for the Fullscreen
 * API so that hooks/components can consume a single, type-safe surface without
 * scattering type-suppression directives across the codebase.
 *
 * Design notes:
 * - Prefix access uses **file-local** type aliases + assertions
 *   (`FullscreenElementCompat` / `FullscreenDocumentCompat`). We intentionally
 *   avoid `declare global` / module augmentation: the main tsconfig resolves
 *   all of `src` as a single program, so augmenting the global `Document` /
 *   `Element` interfaces would (a) pollute global types and (b) risk
 *   `TS2578` unused-directive failures elsewhere.
 * - Behavior is preserved 1:1 from the original `useFullscreen.ts` helpers:
 *   `Boolean(...)` normalization, `|| null` fallback, the
 *   `'Fullscreen API not supported'` throw, and the silent void return on exit.
 * - Each function keeps the SSR guard (`typeof document === 'undefined'`) of
 *   the original implementation. `requestFullscreenCompat` receives an
 *   `Element` argument, so it does not need a document guard (matching the
 *   original).
 * - Request/exit return `Promise<void>` (the legacy prefixed APIs may return a
 *   thenable or nothing, so results are wrapped with `Promise.resolve(...)`).
 *
 * Security: the Fullscreen API requires a user gesture (click, keydown, etc.).
 *
 * @module lib/browser-compat/fullscreen-api
 */

/**
 * Element augmented with the legacy vendor-prefixed `requestFullscreen`
 * variants. File-local only — never registered as a global augmentation.
 */
type FullscreenElementCompat = Element & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  mozRequestFullScreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

/**
 * Document augmented with the legacy vendor-prefixed Fullscreen surface.
 * File-local only — never registered as a global augmentation.
 */
type FullscreenDocumentCompat = Document & {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozCancelFullScreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
  mozFullScreenEnabled?: boolean;
  msFullscreenEnabled?: boolean;
};

/**
 * Whether the Fullscreen API (standard or any vendor prefix) is available.
 *
 * SSR-safe: returns `false` when `document` is undefined.
 * Always returns a normalized `boolean` (never a truthy non-boolean).
 */
export function isFullscreenSupportedCompat(): boolean {
  if (typeof document === 'undefined') return false;

  const doc = document as FullscreenDocumentCompat;
  return Boolean(
    doc.fullscreenEnabled ||
      doc.webkitFullscreenEnabled ||
      doc.mozFullScreenEnabled ||
      doc.msFullscreenEnabled
  );
}

/**
 * The current fullscreen element (standard or vendor-prefixed).
 *
 * SSR-safe: returns `null` when `document` is undefined, and falls back to
 * `null` when no prefix reports a fullscreen element.
 */
export function getFullscreenElementCompat(): Element | null {
  if (typeof document === 'undefined') return null;

  const doc = document as FullscreenDocumentCompat;
  return (
    doc.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement ||
    null
  );
}

/**
 * Request fullscreen on an element (standard or vendor-prefixed).
 *
 * IMPORTANT: must be called from a user gesture (click, keydown, etc.).
 *
 * @throws Error('Fullscreen API not supported') when no API variant exists.
 */
export function requestFullscreenCompat(element: Element): Promise<void> {
  const el = element as FullscreenElementCompat;

  if (el.requestFullscreen) {
    return Promise.resolve(el.requestFullscreen());
  }
  if (el.webkitRequestFullscreen) {
    return Promise.resolve(el.webkitRequestFullscreen());
  }
  if (el.mozRequestFullScreen) {
    return Promise.resolve(el.mozRequestFullScreen());
  }
  if (el.msRequestFullscreen) {
    return Promise.resolve(el.msRequestFullscreen());
  }
  return Promise.reject(new Error('Fullscreen API not supported'));
}

/**
 * Exit fullscreen mode (standard or vendor-prefixed).
 *
 * SSR-safe: resolves to void when `document` is undefined. Unlike
 * {@link requestFullscreenCompat}, this resolves silently (does NOT throw)
 * when no exit API variant exists — preserving the original behavior.
 */
export function exitFullscreenCompat(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();

  const doc = document as FullscreenDocumentCompat;
  if (doc.exitFullscreen) {
    return Promise.resolve(doc.exitFullscreen());
  }
  if (doc.webkitExitFullscreen) {
    return Promise.resolve(doc.webkitExitFullscreen());
  }
  if (doc.mozCancelFullScreen) {
    return Promise.resolve(doc.mozCancelFullScreen());
  }
  if (doc.msExitFullscreen) {
    return Promise.resolve(doc.msExitFullscreen());
  }
  return Promise.resolve();
}

/**
 * Register a handler for fullscreen-change events across the standard and all
 * vendor-prefixed event names.
 *
 * SSR-safe: returns a no-op cleanup when `document` is undefined.
 *
 * @param handler - invoked on any fullscreen-change event.
 * @returns a cleanup function that removes all registered listeners.
 */
export function addFullscreenChangeListenerCompat(handler: () => void): () => void {
  if (typeof document === 'undefined') return () => {};

  const events = [
    'fullscreenchange',
    'webkitfullscreenchange',
    'mozfullscreenchange',
    'MSFullscreenChange',
  ];

  for (const event of events) {
    document.addEventListener(event, handler);
  }

  return () => {
    for (const event of events) {
      document.removeEventListener(event, handler);
    }
  };
}
