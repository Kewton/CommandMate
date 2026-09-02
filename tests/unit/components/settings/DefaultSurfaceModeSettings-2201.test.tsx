/**
 * DefaultSurfaceModeSettings (Issue #2201).
 *
 * The card is small, so what is worth pinning is not its markup but the three
 * things that would make the setting quietly not work:
 *
 *   1. It seeds the browser's copy of the default on LOAD, not only on save.
 *      This mount is the only thing that seeds it today, so a user who opens
 *      More on a second device and merely looks at the setting must still leave
 *      with it applied to their worktrees.
 *   2. A body that is not this route (an older server answering the path with a
 *      404 page) reaches an error state instead of throwing through render and
 *      unmounting the whole More page.
 *   3. A rejected save does not leave the optimistic radio selection standing.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

import { DefaultSurfaceModeSettings } from '@/components/settings';
import {
  DEFAULT_SURFACE_MODE_ENDPOINT,
  getClientDefaultSurfaceMode,
  resetClientDefaultSurfaceMode,
} from '@/config/surface-mode-config';

const originalFetch = globalThis.fetch;

function body(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    defaultSurfaceMode: 'terminal',
    configured: false,
    constantDefault: 'terminal',
    available: ['terminal', 'chat'],
    ...overrides,
  };
}

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => payload } as Response;
}

describe('[#2201] DefaultSurfaceModeSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetClientDefaultSurfaceMode();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    resetClientDefaultSurfaceMode();
    vi.restoreAllMocks();
  });

  it('renders one radio per mode the server publishes, with the stored one checked', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(body({ defaultSurfaceMode: 'chat', configured: true }))
    ) as unknown as typeof fetch;

    render(<DefaultSurfaceModeSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('default-surface-mode-settings')).toBeInTheDocument();
    });
    expect(screen.getByTestId('default-surface-mode-radio-terminal')).not.toBeChecked();
    expect(screen.getByTestId('default-surface-mode-radio-chat')).toBeChecked();
  });

  /**
   * The load, not the save, is what carries the setting to this device's
   * worktree screens — `readSurfaceMode()` reads that mirror synchronously
   * during render and has no other way to learn the server's answer.
   */
  /**
   * The regression this pins: `load` used to build its error message with
   * `t(...)`, which put `t` — a fresh function on every render under next-intl
   * — in its dependency list, so the mount effect re-ran on every render and
   * the card refetched in a loop. In the browser that is a flicker; here it
   * also clobbered the optimistic radio selection with a stale GET body.
   */
  it('fetches once on mount rather than looping on a re-created callback', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(body()));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<DefaultSurfaceModeSettings />);
    await waitFor(() => {
      expect(screen.getByTestId('default-surface-mode-settings')).toBeInTheDocument();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('seeds the client-side default on load', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(body({ defaultSurfaceMode: 'chat', configured: true }))
    ) as unknown as typeof fetch;

    expect(getClientDefaultSurfaceMode()).toBe('terminal');
    render(<DefaultSurfaceModeSettings />);

    await waitFor(() => {
      expect(getClientDefaultSurfaceMode()).toBe('chat');
    });
  });

  it('PUTs the chosen mode and seeds the new answer', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === 'PUT'
        ? jsonResponse(body({ defaultSurfaceMode: 'chat', configured: true }))
        : jsonResponse(body())
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<DefaultSurfaceModeSettings />);
    await waitFor(() => {
      expect(screen.getByTestId('default-surface-mode-settings')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('default-surface-mode-radio-chat'));

    await waitFor(() => {
      expect(getClientDefaultSurfaceMode()).toBe('chat');
    });

    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT');
    expect(put).toBeDefined();
    expect(put![0]).toBe(DEFAULT_SURFACE_MODE_ENDPOINT);
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ mode: 'chat' });

    // Inside waitFor: the store settles before React re-renders, so asserting
    // the DOM straight after the store would be a race rather than a check.
    await waitFor(() => {
      expect(screen.getByTestId('default-surface-mode-radio-chat')).toBeChecked();
    });
    expect(screen.getByTestId('default-surface-mode-radio-terminal')).not.toBeChecked();
  });

  it('shows an error and restores the server answer when the save is rejected', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === 'PUT'
        ? jsonResponse({ success: false, error: 'Invalid "mode"' }, false, 400)
        : jsonResponse(body())
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<DefaultSurfaceModeSettings />);
    await waitFor(() => {
      expect(screen.getByTestId('default-surface-mode-settings')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('default-surface-mode-radio-chat'));

    await waitFor(() => {
      expect(screen.getByTestId('default-surface-mode-error')).toHaveTextContent('Invalid "mode"');
    });
    // The optimistic selection must not survive the rejection.
    await waitFor(() => {
      expect(screen.getByTestId('default-surface-mode-radio-terminal')).toBeChecked();
    });
    expect(getClientDefaultSurfaceMode()).toBe('terminal');
  });

  /**
   * A 200 carrying somebody else's body is the realistic failure (a server
   * older than this screen answers the path with a Next 404 page). Reading
   * `available.map()` off that would throw through render and unmount the whole
   * More page, taking Notifications and External Apps with it.
   */
  it.each([
    ['a body from another route', { apps: [] }],
    ['a mode outside the vocabulary', body({ defaultSurfaceMode: 'xterm' })],
    ['an empty vocabulary', body({ available: [] })],
  ])('degrades to its own error state for %s', async (_label, payload) => {
    globalThis.fetch = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;

    expect(() => render(<DefaultSurfaceModeSettings />)).not.toThrow();

    await waitFor(() => {
      expect(screen.getByTestId('default-surface-mode-load-error')).toBeInTheDocument();
    });
    expect(getClientDefaultSurfaceMode()).toBe('terminal');
  });

  it('degrades to its own error state when the request fails outright', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    render(<DefaultSurfaceModeSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('default-surface-mode-load-error')).toBeInTheDocument();
    });
  });
});
