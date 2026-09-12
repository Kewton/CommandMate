/**
 * Error boundaries under a dead network (Issue #2500).
 *
 * `tests/unit/app/error-boundaries.test.tsx` covers the #1404 wiring; this file
 * covers what happens when the chunk failed because the device left the network
 * rather than because the build moved. Three things have to hold, and each one
 * was broken before #2500:
 *
 *   1. Nothing reloads — a reload on a phone that lost Wi-Fi fetches nothing and
 *      takes the user's half-typed message with it.
 *   2. The copy names the connection, not a version update. "A newer version is
 *      available" is simply false in this situation.
 *   3. The page retries itself when the server comes back, with no tap needed.
 *
 * The connectivity primitives (#2501) are mocked so the boundary's use of them
 * is observable; the recovery decision itself stays real.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

const reachabilityHandlers = new Set<(reachable: boolean) => void>();
const probeServerReachable = vi.fn(async () => true);

vi.mock('@/hooks/useConnectivity', () => ({
  probeServerReachable: (...args: unknown[]) =>
    probeServerReachable(...(args as [])),
  subscribeServerReachability: (handler: (reachable: boolean) => void) => {
    reachabilityHandlers.add(handler);
    return () => reachabilityHandlers.delete(handler);
  },
}));

import AppError from '@/app/error';
import GlobalError from '@/app/global-error';
import { CHUNK_RELOAD_STORAGE_KEY } from '@/lib/error/chunk-reload';

function chunkError(): Error & { digest?: string } {
  const err = new Error('Loading chunk 12 failed.') as Error & { digest?: string };
  err.name = 'ChunkLoadError';
  return err;
}

/** Override `navigator.onLine`, which jsdom defines as a non-writable getter. */
function setNavigatorOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reachabilityHandlers.clear();
  probeServerReachable.mockClear();
  probeServerReachable.mockResolvedValue(true);
  window.sessionStorage.clear();

  reload = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    reload,
  } as unknown as Location);

  // global-error renders <html> into a container div → React logs a nesting
  // warning; keep test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window.navigator as unknown as { onLine?: boolean }).onLine;
});

describe('app/error.tsx offline chunk failure (Issue #2500)', () => {
  it('does NOT reload while the device is offline', () => {
    setNavigatorOnLine(false);
    render(<AppError error={chunkError()} reset={vi.fn()} />);

    expect(reload).not.toHaveBeenCalled();
    // The one guarded self-heal is left unspent for a genuine build swap.
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBeNull();
  });

  it('shows connection copy rather than the "new version" copy', () => {
    setNavigatorOnLine(false);
    render(<AppError error={chunkError()} reset={vi.fn()} />);

    expect(screen.getByTestId('app-error')).toHaveAttribute(
      'data-error-kind',
      'chunk-offline'
    );
    // The i18n mock echoes keys back, so the key itself is the assertion.
    expect(screen.getByRole('heading').textContent).toBe('error.chunkOffline.title');
    expect(screen.getByText('error.chunkOffline.description')).toBeInTheDocument();
    expect(screen.queryByText('error.chunkReload.title')).not.toBeInTheDocument();
    expect(screen.queryByText('error.chunkReload.description')).not.toBeInTheDocument();
  });

  it('retries by itself when the server comes back, with no user action', async () => {
    setNavigatorOnLine(false);
    const reset = vi.fn();
    render(<AppError error={chunkError()} reset={reset} />);

    expect(reset).not.toHaveBeenCalled();
    expect(reachabilityHandlers.size).toBe(1);

    setNavigatorOnLine(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    expect(probeServerReachable).toHaveBeenCalled();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('stays put when the "online" event is not backed by a reachable server', async () => {
    setNavigatorOnLine(false);
    probeServerReachable.mockResolvedValue(false);
    const reset = vi.fn();
    render(<AppError error={chunkError()} reset={reset} />);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    expect(probeServerReachable).toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('retries on a reachability report from an ordinary API call', () => {
    setNavigatorOnLine(false);
    const reset = vi.fn();
    render(<AppError error={chunkError()} reset={reset} />);

    act(() => {
      reachabilityHandlers.forEach((handler) => handler(true));
    });

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount so a late signal cannot retry a gone boundary', () => {
    setNavigatorOnLine(false);
    const { unmount } = render(<AppError error={chunkError()} reset={vi.fn()} />);

    expect(reachabilityHandlers.size).toBe(1);
    unmount();
    expect(reachabilityHandlers.size).toBe(0);
  });

  it('still self-heals once when the same error happens online (Issue #1404)', () => {
    setNavigatorOnLine(true);
    render(<AppError error={chunkError()} reset={vi.fn()} />);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('app-error')).toHaveAttribute(
      'data-error-kind',
      'chunk-reload'
    );
    // No connectivity wait is armed for a build-change incident.
    expect(reachabilityHandlers.size).toBe(0);
  });
});

describe('app/global-error.tsx offline chunk failure (Issue #2500)', () => {
  function renderGlobal(reset = vi.fn()) {
    const result = render(<GlobalError error={chunkError()} reset={reset} />);
    return { ...result, reset };
  }

  it('does NOT reload while the device is offline', () => {
    setNavigatorOnLine(false);
    renderGlobal();

    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBeNull();
  });

  it('shows provider-independent connection copy, not the version copy', () => {
    setNavigatorOnLine(false);
    const { container } = renderGlobal();

    // React hoists the boundary's own <html>/<body> attributes onto the real
    // document rather than leaving them inside the test container.
    expect(document.body).toHaveAttribute('data-error-kind', 'chunk-offline');
    expect(container.textContent).toContain("You're offline");
    expect(container.textContent).not.toContain('A newer version of CommandMate is available');
  });

  it('retries by itself once the server answers again', async () => {
    setNavigatorOnLine(false);
    const { reset } = renderGlobal();

    setNavigatorOnLine(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('still self-heals once when the same error happens online (Issue #1404)', () => {
    setNavigatorOnLine(true);
    const { container } = renderGlobal();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(document.body).toHaveAttribute('data-error-kind', 'chunk-reload');
    expect(container.textContent).toContain('A newer version of CommandMate is available');
  });
});
