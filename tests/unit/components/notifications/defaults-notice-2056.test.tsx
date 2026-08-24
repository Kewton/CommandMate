/**
 * @vitest-environment jsdom
 *
 * The one-off "the defaults changed" notice (Issue #2056).
 *
 * Epic #2002 moved the *new subscription* default for ordinary completions to
 * off and folded three failure kinds into the acting bucket. Neither reached a
 * device that had already subscribed: #2000 deliberately leaves existing rows
 * alone, so those readers kept completions **and** silently started receiving
 * failures. Their notification volume went up under an Epic meant to bring it
 * down, and `types.completionDesc` — "off by default on newly registered
 * devices" — is phrased for someone reading it fresh, not for someone who needs
 * to be told something changed.
 *
 * This file pins the fix at the surface it has to happen on: the reader sees
 * both facts, and can either take the new default in one tap or keep what they
 * have. Either answer retires the notice — which is what turns a silent change
 * into a consented one, and is the only way Epic #2002's criteria 3 and 6 both
 * hold for a row that already existed.
 *
 * Wording is asserted through the real dictionary rather than the key-echoing
 * global mock, so a key that exists only in the component fails here (#1206).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const showToast = vi.fn();
vi.mock('@/components/common/Toast', () => ({
  useToast: () => ({ showToast }),
}));

/**
 * jsdom has no Push API, and the component's first guard returns "unsupported"
 * without it — which would hide the very card the notice lives in. Stubbing the
 * capability module is the smallest way to reach the subscribed branch.
 */
vi.mock('@/lib/pwa/push-client', () => ({
  isPushSupported: () => true,
  canSubscribeToPush: () => ({ supported: true, iosNeedsInstall: false }),
  isIOSDevice: () => false,
  isStandalonePWA: () => true,
  urlBase64ToUint8Array: () => new Uint8Array(),
}));

const ENDPOINT = 'https://push.example/2056-ui';

interface PatchBody {
  endpoint: string;
  preferences?: { prompt: boolean; completion: boolean };
  acknowledgeDefaultsNotice?: boolean;
}

let getResponse: {
  subscribed: boolean;
  subscription?: {
    endpoint: string;
    preferences: { prompt: boolean; completion: boolean };
    defaultsNoticePending: boolean;
  };
};
let patchOk: boolean;
let patched: PatchBody[];

function installServiceWorker(): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: async () => ({
        pushManager: { getSubscription: async () => ({ endpoint: ENDPOINT }) },
      }),
    },
  });
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: { permission: 'granted', requestPermission: async () => 'granted' },
  });
}

function installFetch(): void {
  patched = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/api/push/vapid')) {
      return { ok: true, json: async () => ({ configured: true, publicKey: 'k' }) } as Response;
    }
    if (href.includes('/api/push/escalation')) {
      return {
        ok: true,
        json: async () => ({ settings: { enabled: true, thresholdMinutes: 10 }, choices: [10] }),
      } as Response;
    }
    if (href.includes('/api/push/subscriptions')) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as PatchBody;
        patched.push(body);
        return { ok: patchOk, json: async () => ({ success: patchOk }) } as Response;
      }
      return { ok: true, json: async () => getResponse } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
}

async function renderSettings() {
  installServiceWorker();
  installFetch();
  const { NotificationsSettings } = await import('@/components/notifications/NotificationsSettings');
  render(<NotificationsSettings />);
  await waitFor(() => expect(screen.getByTestId('notifications-unsubscribe')).toBeDefined());
}

/** A device that subscribed before #2000 and has never been told. */
function legacyDevice() {
  return {
    subscribed: true,
    subscription: {
      endpoint: ENDPOINT,
      preferences: { prompt: true, completion: true },
      defaultsNoticePending: true,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getResponse = legacyDevice();
  patchOk = true;
});

describe('defaults notice (Issue #2056)', () => {
  it('tells an existing subscriber both things that changed', async () => {
    await renderSettings();

    expect(screen.getByTestId('notifications-defaults-notice')).toBeDefined();
    expect(screen.getByText('What changed in notifications')).toBeDefined();
    // 1. the completion default moved, and this device did NOT move with it.
    expect(
      screen.getByText(/off by default on newly registered devices\. This device is still on/)
    ).toBeDefined();
    // 2. the three failure kinds joined the acting bucket this device is in.
    expect(
      screen.getByText(
        /failed verification gate, an upstream API fault, and a session that could not start/
      )
    ).toBeDefined();
  });

  it('is not shown to a device the server says is already at the current defaults', async () => {
    getResponse = {
      subscribed: true,
      subscription: {
        endpoint: ENDPOINT,
        preferences: { prompt: true, completion: false },
        defaultsNoticePending: false,
      },
    };
    await renderSettings();

    expect(screen.queryByTestId('notifications-defaults-notice')).toBeNull();
  });

  it('adopts the new default in one tap, and retires the notice', async () => {
    await renderSettings();

    fireEvent.click(screen.getByTestId('notifications-defaults-notice-adopt'));

    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toEqual({
      endpoint: ENDPOINT,
      preferences: { prompt: true, completion: false },
      acknowledgeDefaultsNotice: true,
    });
    await waitFor(() => expect(screen.queryByTestId('notifications-defaults-notice')).toBeNull());
    // The switch the notice was about must now show the adopted value.
    expect(
      screen.getByTestId('notifications-toggle-completion').getAttribute('aria-checked')
    ).toBe('false');
    expect(showToast).toHaveBeenCalledWith('Completions turned off on this device', 'success');
  });

  it('lets the reader keep this device as it is, without moving a toggle', async () => {
    await renderSettings();

    fireEvent.click(screen.getByTestId('notifications-defaults-notice-keep'));

    await waitFor(() => expect(patched).toHaveLength(1));
    // Declining sends the acknowledgement and nothing else — no `preferences`.
    expect(patched[0]).toEqual({ endpoint: ENDPOINT, acknowledgeDefaultsNotice: true });
    await waitFor(() => expect(screen.queryByTestId('notifications-defaults-notice')).toBeNull());
    expect(
      screen.getByTestId('notifications-toggle-completion').getAttribute('aria-checked')
    ).toBe('true');
    expect(showToast).toHaveBeenCalledWith("Left this device's settings unchanged", 'success');
  });

  it('brings the notice back when the acknowledgement fails to reach the server', async () => {
    patchOk = false;
    await renderSettings();

    fireEvent.click(screen.getByTestId('notifications-defaults-notice-adopt'));

    // A dismissed-but-unsaved notice would be a notice the reader can never
    // answer: the server still thinks they were not told, and the banner is gone.
    await waitFor(() =>
      expect(screen.getByTestId('notifications-defaults-notice')).toBeDefined()
    );
    expect(
      screen.getByTestId('notifications-toggle-completion').getAttribute('aria-checked')
    ).toBe('true');
    expect(showToast).toHaveBeenCalledWith('Could not enable notifications', 'error');
  });
});
