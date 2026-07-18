/**
 * Unit tests for VersionMismatchBanner (#1338 / #1356).
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import type { RealtimeEvent } from '@/lib/realtime/types';

// Capture the listener the banner registers so tests can drive realtime events.
let capturedListener: ((event: RealtimeEvent) => void) | null = null;
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtimeListener: (listener: (event: RealtimeEvent) => void) => {
    capturedListener = listener;
  },
}));

// Override the global key-echo mock with real templates so {serverVersion}/
// {clientVersion} interpolation is actually exercised (the core UX signal).
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) => {
    const templates: Record<string, string> = {
      'versionMismatch.title': 'A new version is running',
      'versionMismatch.description':
        'The server is now on {serverVersion}, but this tab is still on {clientVersion}.',
      'versionMismatch.reload': 'Reload',
      'versionMismatch.dismiss': 'Dismiss',
    };
    let str = templates[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) str = str.replace(`{${k}}`, String(v));
    }
    return str;
  },
}));

import { VersionMismatchBanner } from '@/components/layout/VersionMismatchBanner';

const mismatchEvent = (serverVersion: string, clientVersion: string): RealtimeEvent => ({
  type: 'version_mismatch',
  serverVersion,
  clientVersion,
});

function emit(event: RealtimeEvent) {
  act(() => {
    capturedListener?.(event);
  });
}

describe('VersionMismatchBanner', () => {
  const originalLocation = window.location;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedListener = null;
    reloadMock = vi.fn();
    // jsdom's location.reload is a non-configurable own property, so replace the
    // whole location object rather than trying to redefine reload on it.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadMock },
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('renders nothing until a version_mismatch event arrives', () => {
    render(<VersionMismatchBanner />);
    expect(screen.queryByTestId('version-mismatch-banner')).toBeNull();
  });

  it('shows the banner with both versions on a version_mismatch event', () => {
    render(<VersionMismatchBanner />);
    emit(mismatchEvent('0.10.3', '0.10.0'));

    const banner = screen.getByTestId('version-mismatch-banner');
    expect(banner).toBeInTheDocument();
    expect(screen.getByText('A new version is running')).toBeInTheDocument();
    // Both drifted versions are interpolated into the message.
    expect(banner).toHaveTextContent('0.10.3');
    expect(banner).toHaveTextContent('0.10.0');
  });

  it('reloads the page when the reload button is clicked', () => {
    render(<VersionMismatchBanner />);
    emit(mismatchEvent('0.10.3', '0.10.0'));

    fireEvent.click(screen.getByTestId('version-mismatch-reload'));
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated realtime events', () => {
    render(<VersionMismatchBanner />);
    emit({ type: 'session_status_changed', worktreeId: 'wt-1', isRunning: true });
    expect(screen.queryByTestId('version-mismatch-banner')).toBeNull();
  });

  it('ignores a malformed version_mismatch event missing versions', () => {
    render(<VersionMismatchBanner />);
    emit({ type: 'version_mismatch' } as RealtimeEvent);
    expect(screen.queryByTestId('version-mismatch-banner')).toBeNull();
  });

  it('dismiss hides the banner and does not re-nag for the same server version', () => {
    render(<VersionMismatchBanner />);
    emit(mismatchEvent('0.10.3', '0.10.0'));
    expect(screen.getByTestId('version-mismatch-banner')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('version-mismatch-dismiss'));
    expect(screen.queryByTestId('version-mismatch-banner')).toBeNull();

    // A reconnect re-emits the same mismatch — it must stay dismissed.
    emit(mismatchEvent('0.10.3', '0.10.0'));
    expect(screen.queryByTestId('version-mismatch-banner')).toBeNull();
  });

  it('re-shows after dismiss when the server advances to a newer version', () => {
    render(<VersionMismatchBanner />);
    emit(mismatchEvent('0.10.3', '0.10.0'));
    fireEvent.click(screen.getByTestId('version-mismatch-dismiss'));
    expect(screen.queryByTestId('version-mismatch-banner')).toBeNull();

    emit(mismatchEvent('0.10.4', '0.10.0'));
    expect(screen.getByTestId('version-mismatch-banner')).toBeInTheDocument();
  });
});
