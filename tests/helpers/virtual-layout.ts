/**
 * Test helper: give jsdom a non-zero layout so `@tanstack/react-virtual`
 * mounts rows (Issue #1123).
 *
 * jsdom performs no layout, so `offsetWidth`/`offsetHeight` are always 0.
 * `@tanstack/virtual-core` measures the scroll element via `offsetHeight` and
 * renders zero rows whenever the viewport size is 0 (its `calculateRange`
 * requires `outerSize > 0`). This installs configurable `offsetHeight` /
 * `offsetWidth` getters on `HTMLElement.prototype` — the scroll container gets a
 * tall viewport, every other element a fixed row height — and returns a
 * restore function. Scope it per test file (beforeEach/afterEach) so the global
 * suite keeps jsdom's default zero-size behaviour.
 */
export interface VirtualLayoutOptions {
  /** Reported offsetHeight of the scroll container (viewport). */
  viewportHeight?: number;
  /** Reported offsetHeight of every non-container element (a measured row). */
  rowHeight?: number;
  /** Reported offsetWidth of all elements. */
  width?: number;
  /** data-testid identifying the scroll container. */
  scrollContainerTestId?: string;
}

export function installVirtualLayout(options: VirtualLayoutOptions = {}): () => void {
  const viewportHeight = options.viewportHeight ?? 2000;
  const rowHeight = options.rowHeight ?? 200;
  const width = options.width ?? 800;
  const testId = options.scrollContainerTestId ?? 'history-scroll-container';

  const proto = HTMLElement.prototype;
  const prevHeight = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
  const prevWidth = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');

  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-testid') === testId ? viewportHeight : rowHeight;
    },
  });
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get() {
      return width;
    },
  });

  return () => {
    if (prevHeight) Object.defineProperty(proto, 'offsetHeight', prevHeight);
    else Reflect.deleteProperty(proto, 'offsetHeight');
    if (prevWidth) Object.defineProperty(proto, 'offsetWidth', prevWidth);
    else Reflect.deleteProperty(proto, 'offsetWidth');
  };
}
