/**
 * @vitest-environment jsdom
 *
 * The hook that carries the attention count out of the page (Issue #1789).
 *
 * What is under test here is the *sequencing* the pure helpers cannot check:
 * that the title survives Next.js rewriting it on navigation, that the favicon
 * goes back to the authored icon at zero and on unmount, and that a browser
 * without the Badging API is simply left alone.
 *
 * Every global this touches — `document.title`, the head's `<link>` elements,
 * `navigator.setAppBadge`, the canvas prototype — is restored in `afterEach`.
 * CI shares one process across the whole suite (`fileParallelism: false`), so a
 * leak here fails somebody else's file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const countMock = vi.hoisted(() => ({ current: 0 }));
vi.mock('@/hooks/useAttentionCount', () => ({
  useAttentionCount: () => ({ count: countMock.current, worktrees: [] }),
}));

import { useAttentionBadge } from '@/hooks/useAttentionBadge';

const STUB_DATA_URL = 'data:image/png;base64,STUB';
const ICON_HREF = '/icon.png?v=abc123';

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalTitle = document.title;

function iconLink(): HTMLLinkElement {
  const link = document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) throw new Error('no icon link');
  return link;
}

beforeEach(() => {
  countMock.current = 0;
  // Order matters: replacing the head's HTML drops the <title> element with it.
  document.head.innerHTML = `<link rel="icon" href="${ICON_HREF}" type="image/png" sizes="32x32">`;
  document.title = 'CommandMate';

  HTMLCanvasElement.prototype.getContext = (() => ({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = (() =>
    STUB_DATA_URL) as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  document.head.innerHTML = '';
  document.title = originalTitle;
  delete (navigator as { setAppBadge?: unknown }).setAppBadge;
  delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
});

describe('useAttentionBadge — tab title (Issue #1789)', () => {
  it('does not touch the title while nothing is waiting', () => {
    renderHook(() => useAttentionBadge());
    expect(document.title).toBe('CommandMate');
  });

  it('prefixes the count, and drops the prefix again at zero', () => {
    countMock.current = 2;
    const { rerender } = renderHook(() => useAttentionBadge());
    expect(document.title).toBe('(2) CommandMate');

    countMock.current = 0;
    act(() => rerender());
    expect(document.title).toBe('CommandMate');
  });

  it('replaces the prefix on a count change rather than stacking one', () => {
    countMock.current = 1;
    const { rerender } = renderHook(() => useAttentionBadge());
    countMock.current = 5;
    act(() => rerender());
    expect(document.title).toBe('(5) CommandMate');
  });

  it('stays single-prefixed when the effect runs again for the same count', () => {
    // React 18 StrictMode double-invokes effects, and any head mutation
    // re-triggers the observer. `(1) (1) CommandMate` is the bug this pins.
    countMock.current = 1;
    const { rerender } = renderHook(() => useAttentionBadge());
    act(() => rerender());
    act(() => rerender());
    expect(document.title).toBe('(1) CommandMate');
  });

  it('re-applies after a navigation rewrites the title', async () => {
    countMock.current = 3;
    renderHook(() => useAttentionBadge());
    expect(document.title).toBe('(3) CommandMate');

    // What Next.js does on a route change: the title is simply overwritten,
    // from an effect with no ordering relationship to ours.
    act(() => {
      document.title = 'Review | CommandMate';
    });

    await waitFor(() => expect(document.title).toBe('(3) Review | CommandMate'));
  });

  it('settles on a page with no title at all, instead of re-writing forever', async () => {
    // `document.title`'s getter strips trailing whitespace, so `"(2) "` reads
    // back as `"(2)"` — a difference the observer would chase indefinitely.
    document.head.innerHTML = '';
    countMock.current = 2;
    renderHook(() => useAttentionBadge());

    expect(document.title).toBe('(2)');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.title).toBe('(2)');
  });

  it('restores the plain title on unmount', () => {
    countMock.current = 4;
    const { unmount } = renderHook(() => useAttentionBadge());
    expect(document.title).toBe('(4) CommandMate');

    unmount();
    expect(document.title).toBe('CommandMate');
  });
});

describe('useAttentionBadge — favicon (Issue #1789)', () => {
  it('swaps the href for a data URL, keeping sizes and type', () => {
    countMock.current = 1;
    renderHook(() => useAttentionBadge());

    expect(iconLink().getAttribute('href')).toBe(STUB_DATA_URL);
    expect(iconLink().getAttribute('sizes')).toBe('32x32');
    expect(iconLink().getAttribute('type')).toBe('image/png');
  });

  it('restores the authored icon at zero', () => {
    countMock.current = 1;
    const { rerender } = renderHook(() => useAttentionBadge());
    expect(iconLink().getAttribute('href')).toBe(STUB_DATA_URL);

    countMock.current = 0;
    act(() => rerender());
    expect(iconLink().getAttribute('href')).toBe(ICON_HREF);
  });

  it('restores the authored icon on unmount', () => {
    countMock.current = 2;
    const { unmount } = renderHook(() => useAttentionBadge());
    unmount();
    expect(iconLink().getAttribute('href')).toBe(ICON_HREF);
  });

  it('survives a count change without ever losing the authored href', () => {
    countMock.current = 1;
    const { rerender, unmount } = renderHook(() => useAttentionBadge());
    countMock.current = 2;
    act(() => rerender());
    countMock.current = 3;
    act(() => rerender());
    unmount();
    expect(iconLink().getAttribute('href')).toBe(ICON_HREF);
  });

  it('leaves the icon untouched when the canvas cannot draw', () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    countMock.current = 1;
    expect(() => renderHook(() => useAttentionBadge())).not.toThrow();
    expect(iconLink().getAttribute('href')).toBe(ICON_HREF);
  });
});

describe('useAttentionBadge — app badge (Issue #1789)', () => {
  it('does not throw on a browser without the Badging API', () => {
    countMock.current = 3;
    expect(() => renderHook(() => useAttentionBadge())).not.toThrow();
  });

  it('sets the count and clears it at zero when the API exists', () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    Object.assign(navigator, { setAppBadge, clearAppBadge });

    countMock.current = 2;
    const { rerender } = renderHook(() => useAttentionBadge());
    expect(setAppBadge).toHaveBeenCalledWith(2);

    countMock.current = 0;
    act(() => rerender());
    expect(clearAppBadge).toHaveBeenCalled();
  });
});
