/**
 * jsdom polyfills required by Radix UI overlay primitives (Select / DropdownMenu
 * / Tooltip). jsdom does not implement pointer capture, ResizeObserver, or
 * scrollIntoView, all of which Radix touches when opening a portalled surface.
 *
 * Call {@link installRadixJsdomPolyfills} once from a `beforeAll` in any test
 * file that opens a Radix overlay.
 */

export function installRadixJsdomPolyfills(): void {
  if (typeof window === 'undefined') return;

  if (!('ResizeObserver' in window)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  }

  if (typeof Element !== 'undefined') {
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function scrollIntoView(): void {};
    }
    if (typeof Element.prototype.hasPointerCapture !== 'function') {
      Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
        return false;
      };
    }
    if (typeof Element.prototype.setPointerCapture !== 'function') {
      Element.prototype.setPointerCapture = function setPointerCapture(): void {};
    }
    if (typeof Element.prototype.releasePointerCapture !== 'function') {
      Element.prototype.releasePointerCapture = function releasePointerCapture(): void {};
    }
  }
}
