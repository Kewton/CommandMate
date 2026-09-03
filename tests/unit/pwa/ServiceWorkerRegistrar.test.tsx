/**
 * Unit tests for ServiceWorkerRegistrar (Issue #1124 / #2271).
 *
 * Two things are covered here:
 *
 *  - the production-only registration guard (#1124): under NODE_ENV=test (as in
 *    this suite) the worker must never be registered, matching dev behaviour;
 *  - the two properties of the update toast that #2271 turned into defects —
 *    it must not swallow pointer events along the bottom edge of the viewport,
 *    and it must not appear alongside the version-mismatch banner.
 *
 * The toast cases run the component with `NODE_ENV=production`, because that is
 * the only state in which it registers a worker and therefore the only state in
 * which the toast can exist at all. `shouldRegisterServiceWorker` is left real:
 * stubbing it would make the first test above assert nothing but its own mock.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import type { RealtimeEvent } from '@/lib/realtime/types';

// The banner registers a realtime listener; capture it so these tests can drive
// a version_mismatch without standing up a RealtimeProvider.
let capturedListener: ((event: RealtimeEvent) => void) | null = null;
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtimeListener: (listener: (event: RealtimeEvent) => void) => {
    capturedListener = listener;
  },
}));

import { ServiceWorkerRegistrar } from '@/components/pwa/ServiceWorkerRegistrar';
import { VersionMismatchBanner } from '@/components/layout/VersionMismatchBanner';

describe('ServiceWorkerRegistrar', () => {
  const register = vi.fn(() => Promise.resolve({}));

  beforeEach(() => {
    register.mockClear();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        controller: null,
      },
    });
  });

  it('does not register the service worker outside production', () => {
    render(<ServiceWorkerRegistrar />);
    expect(register).not.toHaveBeenCalled();
  });

  it('renders nothing when no update is pending', () => {
    const { container } = render(<ServiceWorkerRegistrar />);
    expect(container.firstChild).toBeNull();
  });

  // ==========================================================================
  // The update toast (Issue #2271)
  // ==========================================================================
  describe('update toast', () => {
    /**
     * A registration whose replacement worker is already waiting — the state
     * that makes the toast render. A `controller` must be present too, or the
     * component (correctly) reads this as a first install rather than an update.
     */
    const waitingWorker = { postMessage: vi.fn() } as unknown as ServiceWorker;

    beforeEach(() => {
      capturedListener = null;
      vi.stubEnv('NODE_ENV', 'production');
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          register: vi.fn(() =>
            Promise.resolve({ waiting: waitingWorker, addEventListener: vi.fn() }),
          ),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          controller: {},
        },
      });
    });

    afterEach(() => {
      cleanup();
      vi.unstubAllEnvs();
    });

    const emit = (event: RealtimeEvent) => {
      act(() => {
        capturedListener?.(event);
      });
    };

    const mismatch: RealtimeEvent = {
      type: 'version_mismatch',
      serverVersion: '0.30.2',
      clientVersion: '0.30.1',
    };

    it('shows the toast once a replacement worker is waiting', async () => {
      render(<ServiceWorkerRegistrar />);
      await waitFor(() => expect(screen.getByTestId('pwa-update-toast')).toBeInTheDocument());
    });

    it('lets pointer events through everywhere except the card itself', async () => {
      render(<ServiceWorkerRegistrar />);
      const toast = await screen.findByTestId('pwa-update-toast');
      const card = screen.getByTestId('pwa-update-toast-card');

      // #2271: as a plain full-width `fixed` element the container intercepted
      // every click along the bottom edge — the composer's Auto-Yes switch
      // became unclickable behind it. The container must opt out of pointer
      // events and the card must opt back in.
      expect(toast.className).toContain('pointer-events-none');
      expect(toast.className).not.toContain('pointer-events-auto');
      expect(card.className).toContain('pointer-events-auto');
    });

    it('is anchored to the bottom-right corner, clear of the footer', async () => {
      render(<ServiceWorkerRegistrar />);
      const toast = await screen.findByTestId('pwa-update-toast');
      expect(toast.className).toContain('bottom-0');
      expect(toast.className).toContain('right-0');
      // `inset-x-0` is what made it span the whole footer.
      expect(toast.className).not.toContain('inset-x-0');
    });

    it('stands down while the version-mismatch banner is showing', async () => {
      render(
        <>
          <VersionMismatchBanner />
          <ServiceWorkerRegistrar />
        </>,
      );
      await waitFor(() => expect(screen.getByTestId('pwa-update-toast')).toBeInTheDocument());

      emit(mismatch);

      // Exactly one reload prompt is on screen, and it is the specific one.
      expect(screen.getByTestId('version-mismatch-banner')).toBeInTheDocument();
      expect(screen.queryByTestId('pwa-update-toast')).toBeNull();
    });

    it('comes back once the banner is dismissed', async () => {
      render(
        <>
          <VersionMismatchBanner />
          <ServiceWorkerRegistrar />
        </>,
      );
      await waitFor(() => expect(screen.getByTestId('pwa-update-toast')).toBeInTheDocument());

      emit(mismatch);
      expect(screen.queryByTestId('pwa-update-toast')).toBeNull();

      act(() => {
        screen.getByTestId('version-mismatch-dismiss').click();
      });

      // The Service Worker update is still pending, so its own prompt is owed
      // to the user again — suppression is tied to the banner being rendered,
      // not to the mismatch event ever having arrived.
      expect(screen.queryByTestId('version-mismatch-banner')).toBeNull();
      expect(screen.getByTestId('pwa-update-toast')).toBeInTheDocument();
    });

    it('is unaffected by a banner that never opened', async () => {
      render(
        <>
          <VersionMismatchBanner />
          <ServiceWorkerRegistrar />
        </>,
      );
      emit({ type: 'session_status_changed', worktreeId: 'wt-1', isRunning: true });
      await waitFor(() => expect(screen.getByTestId('pwa-update-toast')).toBeInTheDocument());
      expect(screen.queryByTestId('version-mismatch-banner')).toBeNull();
    });
  });
});
