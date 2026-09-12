/**
 * End-to-end offline chunk recovery, with the real connectivity module
 * (Issue #2500).
 *
 * The unit tests for this fix mock `@/hooks/useConnectivity`, which means they
 * would keep passing if the boundary asked for an export that no longer exists
 * or whose contract drifted — the exact seam #2500 was told to reuse rather than
 * reimplement. Nothing is mocked here except `fetch` and `navigator.onLine`, so
 * the boundary, `retryWhenServerReturns`, #2501's real `probeServerReachable`
 * and its real `subscribeServerReachability` all have to agree for these to go
 * green.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import AppError from '@/app/error';
import { CHUNK_RELOAD_STORAGE_KEY } from '@/lib/error/chunk-reload';
import {
  DEFAULT_PROBE_URL,
  reportServerReachability,
} from '@/hooks/useConnectivity';

function chunkError(): Error & { digest?: string } {
  const err = new Error(
    'Failed to fetch dynamically imported module: /_next/static/chunks/markdown-editor.js'
  ) as Error & { digest?: string };
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
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.sessionStorage.clear();

  reload = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    reload,
  } as unknown as Location);

  // Offline: every request fails at the transport layer, the way it does when
  // the radio is off.
  fetchMock = vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window.navigator as unknown as { onLine?: boolean }).onLine;
});

describe('[#2500] offline chunk failure → automatic recovery (real connectivity module)', () => {
  it('holds the page, then retries once the real probe reaches the server', async () => {
    setNavigatorOnLine(false);
    const reset = vi.fn();
    render(<AppError error={chunkError()} reset={reset} />);

    // 1. Nothing was reloaded and the one guarded self-heal is unspent.
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBeNull();

    // 2. The copy is about the connection, not about a new version.
    expect(screen.getByTestId('app-error')).toHaveAttribute(
      'data-error-kind',
      'chunk-offline'
    );

    // 3. A browser `online` event that the network does not actually back up
    //    must not retry: the probe still fails, so the page stays where it is.
    setNavigatorOnLine(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(fetchMock).toHaveBeenCalledWith(DEFAULT_PROBE_URL, expect.anything());
    expect(reset).not.toHaveBeenCalled();

    // 4. The server comes back for real. No user action anywhere in this test.
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('retries from a reachability report published by an ordinary API call', async () => {
    setNavigatorOnLine(false);
    const reset = vi.fn();
    render(<AppError error={chunkError()} reset={reset} />);

    // #2501's seam: any call site that completed a request tells everyone.
    await act(async () => {
      reportServerReachability(true);
    });

    expect(reset).toHaveBeenCalledTimes(1);
    // No probe was needed — a completed request is better evidence than one we
    // would have to make ourselves.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves a genuine version drift self-healing exactly once while online', () => {
    setNavigatorOnLine(true);
    render(<AppError error={chunkError()} reset={vi.fn()} />);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).not.toBeNull();
    expect(screen.getByTestId('app-error')).toHaveAttribute(
      'data-error-kind',
      'chunk-reload'
    );

    // A second incident inside the guard window does not start a reload loop.
    render(<AppError error={chunkError()} reset={vi.fn()} />);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
