/**
 * @vitest-environment jsdom
 *
 * "This device is not receiving notifications" (Issue #2124).
 *
 * ## Why the banner sits outside the subscribed / not-subscribed branch
 *
 * The two delivery states straddle it. A 403 leaves the subscription registered
 * (a misconfigured `CM_VAPID_SUBJECT` must never cost a reader their
 * subscription), while a 410 has already deleted the server's row — and the
 * browser keeps its `PushSubscription` either way. Before this, the second case
 * rendered "Notifications are enabled on this device" for a device the server had
 * stopped sending to, which is the exact false reassurance the Epic #2002 device
 * UAT hit on 2026-08-27.
 *
 * So two things are pinned together: the banner appears, and the card stops
 * claiming the device is enabled once the server says it is not.
 *
 * The negative control — a healthy device shows no banner — is here for the same
 * reason the startup check has one: a banner that is sometimes just decoration is
 * a banner nobody reads.
 *
 * Wording is asserted through the real dictionary rather than the key-echoing
 * global mock, so a key that exists only in the component fails here (#1206).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('@/components/common/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@/lib/pwa/push-client', () => ({
  isPushSupported: () => true,
  canSubscribeToPush: () => ({ supported: true, iosNeedsInstall: false }),
  isIOSDevice: () => false,
  isStandalonePWA: () => true,
  urlBase64ToUint8Array: () => new Uint8Array(),
}));

const ENDPOINT = 'https://push.example/2124-ui';
const FIRST_FAILURE = Date.parse('2026-08-27T14:23:42.216Z');

interface DeliveryHealth {
  state: 'failing' | 'removed';
  statusCode: number | null;
  failureCount: number;
  firstFailureAt: number;
  lastFailureAt: number;
}

let getResponse: {
  subscribed: boolean;
  subscription?: {
    endpoint: string;
    preferences: { prompt: boolean; completion: boolean };
    defaultsNoticePending: boolean;
  };
  delivery?: DeliveryHealth | null;
};

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
  globalThis.fetch = vi.fn(async (url: unknown) => {
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
  // The escalation card renders unconditionally, so it is the reliable signal
  // that the component has finished its initial fetches.
  await waitFor(() => expect(screen.getByTestId('notifications-toggle-escalation')).toBeDefined());
}

function subscribedDevice(delivery: DeliveryHealth | null) {
  return {
    subscribed: true,
    subscription: {
      endpoint: ENDPOINT,
      preferences: { prompt: true, completion: false },
      defaultsNoticePending: false,
    },
    delivery,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getResponse = subscribedDevice(null);
});

describe('delivery health banner (Issue #2124)', () => {
  it('shows nothing for a healthy device (negative control)', async () => {
    await renderSettings();

    await waitFor(() => expect(screen.getByTestId('notifications-unsubscribe')).toBeDefined());
    expect(screen.queryByTestId('notifications-delivery-health')).toBeNull();
  });

  it('warns about a 403 streak while keeping the device subscribed', async () => {
    getResponse = subscribedDevice({
      state: 'failing',
      statusCode: 403,
      failureCount: 4,
      firstFailureAt: FIRST_FAILURE,
      lastFailureAt: FIRST_FAILURE + 60_000,
    });

    await renderSettings();

    const banner = await screen.findByTestId('notifications-delivery-health');
    expect(banner.getAttribute('data-delivery-state')).toBe('failing');
    expect(screen.getByText('This device is not receiving notifications')).toBeDefined();
    expect(screen.getByText(/rejected the last 4 notification/)).toBeDefined();
    expect(banner.textContent).toContain('HTTP 403');
    // A 403 must not have cost the reader their subscription.
    expect(screen.getByText(/Your subscription is intact/)).toBeDefined();
    expect(screen.getByTestId('notifications-unsubscribe')).toBeDefined();
  });

  it('points a 403 at CM_VAPID_SUBJECT, which is what it usually is', async () => {
    getResponse = subscribedDevice({
      state: 'failing',
      statusCode: 403,
      failureCount: 1,
      firstFailureAt: FIRST_FAILURE,
      lastFailureAt: FIRST_FAILURE,
    });

    await renderSettings();

    const hint = await screen.findByTestId('notifications-delivery-apns-hint');
    expect(hint.textContent).toContain('CM_VAPID_SUBJECT');
    expect(hint.textContent).toContain('docs/user-guide/webapp-guide.md');
  });

  it('omits the APNs hint for a status that is not 403', async () => {
    getResponse = subscribedDevice({
      state: 'failing',
      statusCode: 429,
      failureCount: 1,
      firstFailureAt: FIRST_FAILURE,
      lastFailureAt: FIRST_FAILURE,
    });

    await renderSettings();

    await screen.findByTestId('notifications-delivery-health');
    expect(screen.queryByTestId('notifications-delivery-apns-hint')).toBeNull();
  });

  it('stops claiming the device is enabled once the server has dropped it', async () => {
    // The 410 case. The browser still holds a PushSubscription, so `endpoint`
    // is set — without the server's verdict the card said "enabled on this
    // device" and offered the toggles, for a device receiving nothing.
    getResponse = {
      subscribed: false,
      delivery: {
        state: 'removed',
        statusCode: 410,
        failureCount: 1,
        firstFailureAt: FIRST_FAILURE,
        lastFailureAt: FIRST_FAILURE,
      },
    };

    await renderSettings();

    const banner = await screen.findByTestId('notifications-delivery-health');
    expect(banner.getAttribute('data-delivery-state')).toBe('removed');
    expect(screen.getByText('This device was dropped by the push service')).toBeDefined();
    expect(screen.queryByText('Notifications are enabled on this device')).toBeNull();
    // …and the repair is offered: pressing this re-registers the endpoint.
    expect(screen.getByTestId('notifications-enable')).toBeDefined();
  });

  it('renders without a status code rather than printing "HTTP null"', async () => {
    getResponse = subscribedDevice({
      state: 'failing',
      statusCode: null,
      failureCount: 2,
      firstFailureAt: FIRST_FAILURE,
      lastFailureAt: FIRST_FAILURE,
    });

    await renderSettings();

    const banner = await screen.findByTestId('notifications-delivery-health');
    expect(banner.textContent).toContain('rejected the last 2 notification');
    expect(banner.textContent).not.toContain('null');
    expect(banner.textContent).not.toContain('HTTP ');
  });
});
