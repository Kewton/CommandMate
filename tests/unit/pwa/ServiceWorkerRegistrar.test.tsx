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
import { PWA_UPDATE_PROMPT_Z_INDEX, Z_INDEX } from '@/config/z-index';
import { OPEN_MODAL_SELECTOR } from '@/lib/new-task/modal-open';

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

    // Issue #4103. Where these end up on screen is measured in a real browser
    // (tests/e2e/pwa-update-toast-4103.spec.ts); this pins the two choices behind
    // it, so a later edit cannot undo them without a red test in the unit run.
    it('draws under dialogs, not at the toast layer', async () => {
      render(<ServiceWorkerRegistrar />);
      const toast = await screen.findByTestId('pwa-update-toast');
      expect(Number(toast.style.zIndex)).toBe(PWA_UPDATE_PROMPT_Z_INDEX);
      expect(Number(toast.style.zIndex)).toBeLessThan(Z_INDEX.MODAL);
    });

    it('leaves the bottom of a phone screen and the PC send button alone', async () => {
      render(<ServiceWorkerRegistrar />);
      const toast = await screen.findByTestId('pwa-update-toast');
      expect(toast.className).toContain('max-md:bottom-auto');
      expect(toast.className).toContain('max-md:top-[');
      expect(toast.className).toContain('pr-[4.25rem]');
    });

    it('steps aside only for a dialog inside main, which it would otherwise cover', async () => {
      render(<ServiceWorkerRegistrar />);
      const toast = await screen.findByTestId('pwa-update-toast');
      // jsdom applies no Tailwind, so the behaviour itself is in the e2e spec.
      expect(toast.className).toContain("[role='dialog'][aria-modal='true']");
      // What `lib/new-task/modal-open.ts` does not count as a modal either. This
      // selector cannot import that one (Tailwind needs the literal class).
      expect(OPEN_MODAL_SELECTOR).toContain(':not([data-testid="prompt-panel"])');
      expect(OPEN_MODAL_SELECTOR).toContain(':not([data-state="closed"])');
      expect(toast.className).toContain(":not([data-testid='prompt-panel'])");
      expect(toast.className).toContain(":not([data-state='closed'])");
      expect(toast.className).toContain(":not([data-hidden='true']_*)");
      expect(toast.className).toContain(":not([hidden]_*)");
    });

    it('can be put away, and offers a different waiting worker again', async () => {
      render(<ServiceWorkerRegistrar />);
      await screen.findByTestId('pwa-update-toast');
      act(() => {
        screen.getByTestId('pwa-update-toast-dismiss').click();
      });
      expect(screen.queryByTestId('pwa-update-toast')).toBeNull();
      expect(waitingWorker.postMessage).not.toHaveBeenCalled();
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

// ==========================================================================
// A fresh browser profile (Issue #4346, item 2)
// ==========================================================================
/**
 * The UAT saw "アプリの更新を適用できます" stay on screen. The question was whether a
 * new profile (a new Playwright context: no Service Worker installed) shows it.
 * It cannot: the prompt needs a worker waiting WHILE another controls the page,
 * and the first install in a profile has no controller. So a new profile only
 * installs; the prompt is what a profile that kept an older worker sees (the
 * UAT's persistent Playwright profile) until the update is applied — its × puts
 * it away for that load only (Issue #4103). Recorded, not changed.
 */
describe('ServiceWorkerRegistrar in a fresh profile (Issue #4346)', () => {
  type Listener = () => void;

  /** A registration whose first worker installs while `controller` is what the profile has. */
  function installFirstWorker(controller: object | null) {
    const installing = {
      state: 'installing',
      postMessage: vi.fn(),
      listeners: [] as Listener[],
      addEventListener(_: string, listener: Listener) {
        this.listeners.push(listener);
      },
    };
    const registrationListeners: Listener[] = [];
    const registration = {
      waiting: null,
      installing,
      addEventListener: (_: string, listener: Listener) => registrationListeners.push(listener),
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn(() => Promise.resolve(registration)),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        controller,
      },
    });
    return {
      finishInstall: () =>
        act(() => {
          registrationListeners.forEach((listener) => listener());
          installing.state = 'installed';
          installing.listeners.forEach((listener) => listener());
        }),
    };
  }

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('a new profile (no controller) installs its first worker without the update prompt', async () => {
    const sw = installFirstWorker(null);
    render(<ServiceWorkerRegistrar />);
    await waitFor(() => expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js'));
    await act(async () => {});
    sw.finishInstall();
    expect(screen.queryByTestId('pwa-update-toast')).toBeNull();
  });

  it('(positive control) a profile that already has a controlling worker does get the prompt', async () => {
    const sw = installFirstWorker({});
    render(<ServiceWorkerRegistrar />);
    await waitFor(() => expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js'));
    await act(async () => {});
    sw.finishInstall();
    await waitFor(() => expect(screen.getByTestId('pwa-update-toast')).toBeInTheDocument());
  });
});
