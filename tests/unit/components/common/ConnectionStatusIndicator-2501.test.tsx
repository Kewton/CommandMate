/**
 * @vitest-environment jsdom
 */

/**
 * Tests for ConnectionStatusIndicator on useConnectivity (Issue #2501).
 *
 * The indicator itself is unchanged in spirit — quiet while connected — but its
 * verdict now comes from the three-signal hook rather than the WebSocket status
 * alone, so "server unreachable" and "live push dropped" are distinguishable.
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

import { ConnectionStatusIndicator } from '@/components/common/ConnectionStatusIndicator';

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

describe('ConnectionStatusIndicator', () => {
  beforeEach(() => {
    setConnectivity({});
  });

  it('renders nothing while connected', () => {
    const { container } = render(<ConnectionStatusIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing during the settle window, so a page load does not blink', () => {
    setConnectivity({
      status: 'reconnecting',
      isOnline: false,
      isReconnecting: true,
      shouldSurface: false,
    });
    const { container } = render(<ConnectionStatusIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the reconnecting pill when live push is down but the server answers', () => {
    setConnectivity({
      status: 'reconnecting',
      isOnline: false,
      isReconnecting: true,
      shouldSurface: true,
    });
    render(<ConnectionStatusIndicator />);

    const pill = screen.getByTestId('connection-status-indicator');
    expect(pill).toHaveAttribute('data-connection-state', 'reconnecting');
    expect(pill).toHaveTextContent('common.connection.reconnecting');
    expect(pill).toHaveAttribute('title', 'common.connection.reconnectingTooltip');
  });

  it('shows the offline pill when the server cannot be reached', () => {
    setConnectivity({
      status: 'offline',
      isOnline: false,
      isOffline: true,
      shouldSurface: true,
      signals: { browserOnline: true, realtimeStatus: 'connecting', serverReachable: false },
    });
    render(<ConnectionStatusIndicator />);

    const pill = screen.getByTestId('connection-status-indicator');
    expect(pill).toHaveAttribute('data-connection-state', 'offline');
    expect(pill).toHaveTextContent('common.connection.offline');
    expect(pill).toHaveAttribute('title', 'common.connection.offlineTooltip');
  });

  it('stays a desktop surface — the phone gets MobileConnectionBanner instead', () => {
    setConnectivity({ status: 'offline', isOnline: false, isOffline: true, shouldSurface: true });
    render(<ConnectionStatusIndicator />);

    expect(screen.getByTestId('connection-status-indicator').className).toMatch(
      /hidden sm:inline-flex/
    );
  });
});
