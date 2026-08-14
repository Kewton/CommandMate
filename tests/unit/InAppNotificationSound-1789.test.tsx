/**
 * @vitest-environment jsdom
 *
 * The waiting-chime preference and its switch (Issue #1789).
 *
 * The default is the decision worth pinning: **off**, the opposite of Issue
 * #1788's toast. A toast appears in a window you are already looking at; a sound
 * leaves the machine, into a meeting or a shared room. Audio nobody asked for is
 * the fastest way to get the whole tab muted — which would take the toast down
 * with it.
 *
 * Placement is inherited from #1788's in-app card, which sits outside every one
 * of `NotificationsSettings`' early returns, so the switch is reachable on the
 * installs where push is unavailable — pinned again here because a later
 * refactor could move it inside them without any other test noticing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, renderHook } from '@testing-library/react';
import React from 'react';
import {
  INAPP_WAITING_SOUND_DEFAULT,
  INAPP_WAITING_SOUND_STORAGE_KEY,
  readInAppWaitingSoundEnabled,
  setInAppWaitingSoundEnabled,
  useInAppWaitingSound,
} from '@/hooks/useInAppNotificationPrefs';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('waiting-chime preference (Issue #1789)', () => {
  it('defaults to off — sound is opt-in', () => {
    expect(INAPP_WAITING_SOUND_DEFAULT).toBe(false);
    expect(readInAppWaitingSoundEnabled()).toBe(false);
  });

  it('only an explicit "true" turns it on — a corrupt value stays quiet', () => {
    localStorage.setItem(INAPP_WAITING_SOUND_STORAGE_KEY, 'true');
    expect(readInAppWaitingSoundEnabled()).toBe(true);

    localStorage.setItem(INAPP_WAITING_SOUND_STORAGE_KEY, '{{garbage');
    expect(readInAppWaitingSoundEnabled()).toBe(false);
  });

  it('persists and re-reads', () => {
    setInAppWaitingSoundEnabled(true);
    expect(localStorage.getItem(INAPP_WAITING_SOUND_STORAGE_KEY)).toBe('true');
    expect(readInAppWaitingSoundEnabled()).toBe(true);

    setInAppWaitingSoundEnabled(false);
    expect(localStorage.getItem(INAPP_WAITING_SOUND_STORAGE_KEY)).toBe('false');
    expect(readInAppWaitingSoundEnabled()).toBe(false);
  });

  it('does not collide with the toast preference', () => {
    expect(INAPP_WAITING_SOUND_STORAGE_KEY).not.toBe('mcbd-inapp-waiting-toast');
  });

  it('tells a listener in the SAME tab, so the toggle takes effect without a reload', async () => {
    const { result } = renderHook(() => useInAppWaitingSound());
    await waitFor(() => expect(result.current.enabled).toBe(false));

    act(() => setInAppWaitingSoundEnabled(true));

    await waitFor(() => expect(result.current.enabled).toBe(true));
  });

  it('picks up a change made in another tab', async () => {
    const { result } = renderHook(() => useInAppWaitingSound());

    act(() => {
      localStorage.setItem(INAPP_WAITING_SOUND_STORAGE_KEY, 'true');
      window.dispatchEvent(new StorageEvent('storage'));
    });

    await waitFor(() => expect(result.current.enabled).toBe(true));
  });

  it('writes through the hook as well as the bare setter', async () => {
    const { result } = renderHook(() => useInAppWaitingSound());
    act(() => result.current.setEnabled(true));

    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(localStorage.getItem(INAPP_WAITING_SOUND_STORAGE_KEY)).toBe('true');
  });
});

describe('NotificationsSettings sound switch (Issue #1789)', () => {
  async function renderSettings(vapidConfigured: boolean) {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/push/vapid')) {
        return {
          ok: true,
          json: async () => ({
            configured: vapidConfigured,
            publicKey: vapidConfigured ? 'k' : null,
          }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ subscribed: false }) } as unknown as Response;
    }) as typeof fetch;

    const { NotificationsSettings } = await import(
      '@/components/notifications/NotificationsSettings'
    );
    render(<NotificationsSettings />);
    await waitFor(() =>
      expect(screen.getByTestId('notifications-toggle-inapp-sound')).toBeDefined(),
    );
  }

  it('renders next to the in-app toast switch, above the push card', async () => {
    await renderSettings(true);
    expect(screen.getByTestId('notifications-toggle-inapp-waiting')).toBeDefined();
    expect(screen.getByTestId('notifications-toggle-inapp-sound')).toBeDefined();
  });

  it('is STILL present when the push card has bailed out entirely', async () => {
    // jsdom has no Push API, so `renderBody` takes its `!supported` early
    // return — the install where an in-page signal is all there is.
    await renderSettings(false);
    expect(screen.getByText('This browser does not support push notifications.')).toBeDefined();
    expect(screen.getByTestId('notifications-toggle-inapp-sound')).toBeDefined();
  });

  it('starts off and reflects the stored preference', async () => {
    await renderSettings(true);
    expect(
      screen.getByTestId('notifications-toggle-inapp-sound').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('reflects a stored "on"', async () => {
    localStorage.setItem(INAPP_WAITING_SOUND_STORAGE_KEY, 'true');
    await renderSettings(true);
    await waitFor(() =>
      expect(
        screen.getByTestId('notifications-toggle-inapp-sound').getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('persists a flip of the switch', async () => {
    await renderSettings(true);
    const toggle = screen.getByTestId('notifications-toggle-inapp-sound');

    // A real click, not a hover-only affordance: this control has to work on the
    // phone, where the notification matters most.
    act(() => {
      toggle.click();
    });

    await waitFor(() =>
      expect(localStorage.getItem(INAPP_WAITING_SOUND_STORAGE_KEY)).toBe('true'),
    );
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('renders wording from the real dictionary, not a key echo', async () => {
    await renderSettings(true);
    expect(screen.getByText('Waiting sound')).toBeDefined();
  });
});
