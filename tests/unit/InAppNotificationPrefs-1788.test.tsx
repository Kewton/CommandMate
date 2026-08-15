/**
 * @vitest-environment jsdom
 *
 * The in-app notification preference and its switch (Issue #1788).
 *
 * The switch's *placement* is under test, not just its existence: it sits above
 * the push card and outside every one of `NotificationsSettings`' early returns
 * (no Push API / iOS not installed / no VAPID keys on the server). Those are
 * exactly the installs where the in-app toast is the only notification there is,
 * so a control hidden behind them would be missing where it matters most.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  INAPP_WAITING_TOAST_DEFAULT,
  INAPP_WAITING_TOAST_STORAGE_KEY,
  readInAppWaitingToastEnabled,
  setInAppWaitingToastEnabled,
  useInAppWaitingToast,
} from '@/hooks/useInAppNotificationPrefs';
import { renderHook } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('in-app waiting-toast preference (Issue #1788)', () => {
  it('defaults to on, so a user who never opened settings is still told', () => {
    expect(INAPP_WAITING_TOAST_DEFAULT).toBe(true);
    expect(readInAppWaitingToastEnabled()).toBe(true);
  });

  it('only an explicit "false" turns it off — a corrupt value fails toward notifying', () => {
    localStorage.setItem(INAPP_WAITING_TOAST_STORAGE_KEY, 'false');
    expect(readInAppWaitingToastEnabled()).toBe(false);

    localStorage.setItem(INAPP_WAITING_TOAST_STORAGE_KEY, '{{garbage');
    expect(readInAppWaitingToastEnabled()).toBe(true);
  });

  it('persists and re-reads', () => {
    setInAppWaitingToastEnabled(false);
    expect(localStorage.getItem(INAPP_WAITING_TOAST_STORAGE_KEY)).toBe('false');
    expect(readInAppWaitingToastEnabled()).toBe(false);

    setInAppWaitingToastEnabled(true);
    expect(readInAppWaitingToastEnabled()).toBe(true);
  });

  it('tells a listener in the SAME tab, so the toggle takes effect without a reload', async () => {
    // `storage` only fires in other tabs. The settings screen and the app-shell
    // listener are both in this one.
    const { result } = renderHook(() => useInAppWaitingToast());
    await waitFor(() => expect(result.current.enabled).toBe(true));

    act(() => setInAppWaitingToastEnabled(false));

    await waitFor(() => expect(result.current.enabled).toBe(false));
  });

  it('picks up a change made in another tab', async () => {
    const { result } = renderHook(() => useInAppWaitingToast());
    await waitFor(() => expect(result.current.enabled).toBe(true));

    act(() => {
      localStorage.setItem(INAPP_WAITING_TOAST_STORAGE_KEY, 'false');
      window.dispatchEvent(new StorageEvent('storage'));
    });

    await waitFor(() => expect(result.current.enabled).toBe(false));
  });
});

describe('NotificationsSettings in-app switch (Issue #1788)', () => {
  async function renderSettings(vapidConfigured: boolean) {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/push/vapid')) {
        return {
          ok: true,
          json: async () => ({ configured: vapidConfigured, publicKey: vapidConfigured ? 'k' : null }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ subscribed: false }) } as unknown as Response;
    }) as typeof fetch;

    const { NotificationsSettings } = await import('@/components/notifications/NotificationsSettings');
    render(<NotificationsSettings />);
    await waitFor(() =>
      expect(screen.getByTestId('notifications-toggle-inapp-waiting')).toBeDefined(),
    );
  }

  it('is present when push is fully configured', async () => {
    await renderSettings(true);
    expect(screen.getByTestId('notifications-toggle-inapp-waiting')).toBeDefined();
  });

  it('is STILL present when the push card has bailed out entirely', async () => {
    // jsdom has no Push API, so `renderBody` takes its `!supported` early
    // return — the strongest version of the placement argument: the push half
    // renders a dead end and the in-app switch is still there.
    await renderSettings(false);
    expect(screen.getByText('This browser does not support push notifications.')).toBeDefined();
    expect(screen.queryByTestId('notifications-enable')).toBeNull();
    expect(screen.getByTestId('notifications-toggle-inapp-waiting')).toBeDefined();
  });

  it('reflects the stored preference', async () => {
    localStorage.setItem(INAPP_WAITING_TOAST_STORAGE_KEY, 'false');
    await renderSettings(true);
    expect(
      screen.getByTestId('notifications-toggle-inapp-waiting').getAttribute('aria-checked'),
    ).toBe('false');
  });
});
