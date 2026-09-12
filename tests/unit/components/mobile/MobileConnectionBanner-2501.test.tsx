/**
 * @vitest-environment jsdom
 */

/**
 * Tests for MobileConnectionBanner (Issue #2501).
 *
 * Two things matter here: the banner is silent while connected, and it is laid
 * out in flow rather than on top of the page — the #2271 failure mode was a
 * floating element that covered the composer, and the assertions below are what
 * keep this one from becoming that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { ConnectivityState } from '@/hooks/useConnectivity';

const connectivity = vi.hoisted(() => ({
  state: {} as ConnectivityState,
}));

vi.mock('@/hooks/useConnectivity', () => ({
  useConnectivity: () => connectivity.state,
}));

import { MobileConnectionBanner } from '@/components/mobile/MobileConnectionBanner';

function setConnectivity(over: Partial<ConnectivityState>): void {
  connectivity.state = {
    status: 'online',
    isOnline: true,
    isReconnecting: false,
    isOffline: false,
    shouldSurface: false,
    signals: { browserOnline: true, realtimeStatus: 'connected', serverReachable: true },
    lastReachableAt: null,
    recheck: vi.fn(),
    ...over,
  };
}

describe('MobileConnectionBanner', () => {
  beforeEach(() => {
    setConnectivity({});
  });

  it('renders nothing while connected', () => {
    const { container } = render(<MobileConnectionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while a degraded verdict is still inside the settle window', () => {
    setConnectivity({ status: 'offline', isOnline: false, isOffline: true, shouldSurface: false });
    const { container } = render(<MobileConnectionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the offline state once it has settled', () => {
    setConnectivity({ status: 'offline', isOnline: false, isOffline: true, shouldSurface: true });
    render(<MobileConnectionBanner />);

    const banner = screen.getByTestId('mobile-connection-banner');
    expect(banner).toHaveAttribute('data-connection-state', 'offline');
    expect(banner).toHaveTextContent('common.connection.offline');
  });

  it('shows the reconnecting state while the server is still reachable', () => {
    setConnectivity({
      status: 'reconnecting',
      isOnline: false,
      isReconnecting: true,
      shouldSurface: true,
    });
    render(<MobileConnectionBanner />);

    const banner = screen.getByTestId('mobile-connection-banner');
    expect(banner).toHaveAttribute('data-connection-state', 'reconnecting');
    expect(banner).toHaveTextContent('common.connection.reconnecting');
  });

  it('announces itself politely rather than interrupting', () => {
    setConnectivity({ status: 'offline', isOnline: false, isOffline: true, shouldSurface: true });
    render(<MobileConnectionBanner />);

    const banner = screen.getByTestId('mobile-connection-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });

  it('takes space in the column instead of overlaying the page (cf. #2271)', () => {
    setConnectivity({ status: 'offline', isOnline: false, isOffline: true, shouldSurface: true });
    render(<MobileConnectionBanner />);

    const banner = screen.getByTestId('mobile-connection-banner');
    // No fixed/absolute positioning and no z-index anywhere in the subtree:
    // the composer and the bottom tab bar cannot end up underneath it.
    const classNames = [banner, ...Array.from(banner.querySelectorAll('*'))]
      .map((el) => el.className)
      .join(' ');
    expect(classNames).not.toMatch(/\b(fixed|absolute|sticky)\b/);
    expect(classNames).not.toMatch(/\bz-\d+\b/);
    expect(banner.className).toMatch(/\bshrink-0\b/);
  });
});
