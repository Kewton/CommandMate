/**
 * @vitest-environment jsdom
 *
 * The reminder switch and its threshold (Issue #1790).
 *
 * Placement is under test as much as behaviour: the reminder is a *server*
 * setting that fires at whichever device is subscribed, so it must not be
 * trapped behind the push card's early returns (no Push API here in jsdom — the
 * strongest version of the case). A laptop that can never receive a push is a
 * perfectly ordinary place to turn the reminder off for the phone that can.
 *
 * The wording is asserted through the real dictionary rather than the global
 * key-echoing mock, so a key that exists only in the component fails here.
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

interface EscalationBody {
  settings: { enabled: boolean; thresholdMinutes: number };
}

let escalationResponse: { enabled: boolean; thresholdMinutes: number };
let patchOk: boolean;
let patched: EscalationBody[];

function installFetch(): void {
  patched = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/api/push/escalation')) {
      if (init?.method === 'PATCH') {
        patched.push(JSON.parse(String(init.body)) as EscalationBody);
        return { ok: patchOk, json: async () => ({ settings: escalationResponse }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ settings: escalationResponse, choices: [5, 10, 30, 60] }),
      } as Response;
    }
    if (href.includes('/api/push/vapid')) {
      return { ok: true, json: async () => ({ configured: true, publicKey: 'k' }) } as Response;
    }
    return { ok: true, json: async () => ({ subscribed: false }) } as Response;
  }) as typeof fetch;
}

async function renderSettings() {
  installFetch();
  const { NotificationsSettings } = await import('@/components/notifications/NotificationsSettings');
  render(<NotificationsSettings />);
  await waitFor(() =>
    expect(
      screen.getByTestId('notifications-toggle-escalation').getAttribute('aria-checked')
    ).toBe(String(escalationResponse.enabled))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  escalationResponse = { enabled: true, thresholdMinutes: 10 };
  patchOk = true;
});

describe('reminder settings (Issue #1790)', () => {
  it('renders even though this browser has no Push API at all', async () => {
    await renderSettings();

    expect(screen.getByText('This browser does not support push notifications.')).toBeDefined();
    expect(screen.getByTestId('notifications-toggle-escalation')).toBeDefined();
    expect(screen.getByTestId('notifications-escalation-threshold')).toBeDefined();
    expect(screen.getByText('Remind me if still waiting')).toBeDefined();
  });

  it('shows the stored threshold and the choices the server offered', async () => {
    escalationResponse = { enabled: true, thresholdMinutes: 30 };
    await renderSettings();

    const select = screen.getByTestId('notifications-escalation-threshold') as HTMLSelectElement;
    expect(select.value).toBe('30');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      '5 min',
      '10 min',
      '30 min',
      '60 min',
    ]);
  });

  it('saves a new threshold to the server', async () => {
    await renderSettings();

    fireEvent.change(screen.getByTestId('notifications-escalation-threshold'), {
      target: { value: '60' },
    });

    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0].settings).toEqual({ enabled: true, thresholdMinutes: 60 });
  });

  it('turns the reminder off and disables the threshold with it', async () => {
    await renderSettings();

    fireEvent.click(screen.getByTestId('notifications-toggle-escalation'));

    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0].settings).toEqual({ enabled: false, thresholdMinutes: 10 });
    await waitFor(() =>
      expect(
        (screen.getByTestId('notifications-escalation-threshold') as HTMLSelectElement).disabled
      ).toBe(true)
    );
  });

  it('rolls the switch back when the server refuses the change', async () => {
    patchOk = false;
    await renderSettings();

    fireEvent.click(screen.getByTestId('notifications-toggle-escalation'));

    await waitFor(() =>
      expect(
        screen.getByTestId('notifications-toggle-escalation').getAttribute('aria-checked')
      ).toBe('true')
    );
    expect(showToast).toHaveBeenCalledWith('Could not enable notifications', 'error');
  });

  it('leaves the existing push and in-app switches alone', async () => {
    // #1789 is adding a control to the same screen in parallel; this pins that
    // #1790 only appended.
    await renderSettings();
    expect(screen.getByTestId('notifications-toggle-inapp-waiting')).toBeDefined();
  });
});
