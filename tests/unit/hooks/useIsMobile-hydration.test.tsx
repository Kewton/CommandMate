/**
 * Hydration behavior tests for useIsMobile (Issue #1126)
 *
 * The SSR-flip flash fix keeps the SSR/first-client render deterministically
 * `false` (desktop) so hydration matches the server HTML — no mismatch warning
 * — and then corrects to the real viewport value in a layout effect that is
 * flushed before the browser paints. These tests exercise a real
 * `hydrateRoot()` against pre-rendered "desktop" HTML on a mobile viewport and
 * assert:
 *   1. React logs no hydration-mismatch warning.
 *   2. The client resolves to the mobile value after hydration.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { act } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { useIsMobile } from '@/hooks/useIsMobile';

/** Minimal probe that renders the string form of the detected mode. */
function Probe() {
  const isMobile = useIsMobile();
  return <div data-testid="probe">{isMobile ? 'mobile' : 'desktop'}</div>;
}

/** Install a `matchMedia` stub that reports the given match result. */
function stubMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

/** Collect console.error calls whose message looks like a hydration warning. */
function hydrationWarnings(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return (spy.mock.calls as unknown[][]).filter((args: unknown[]) =>
    /hydrat|did not match|server (?:rendered )?html|text content does not match/i.test(
      String(args[0])
    )
  );
}

describe('useIsMobile hydration (Issue #1126)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('hydrates desktop SSR HTML on a mobile viewport without a mismatch warning', async () => {
    stubMatchMedia(true); // viewport is mobile at hydration time
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Server rendered the SSR-safe `false` branch → "desktop".
    const container = document.createElement('div');
    container.innerHTML = '<div data-testid="probe">desktop</div>';
    document.body.appendChild(container);

    await act(async () => {
      hydrateRoot(container, <Probe />);
    });

    // No hydration mismatch: the first client render matched the server HTML.
    expect(hydrationWarnings(errorSpy)).toEqual([]);
    // The layout effect then corrected the value to the real (mobile) viewport.
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('mobile');
  });

  it('keeps desktop HTML stable when hydrating on a desktop viewport', async () => {
    stubMatchMedia(false); // viewport is desktop at hydration time
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const container = document.createElement('div');
    container.innerHTML = '<div data-testid="probe">desktop</div>';
    document.body.appendChild(container);

    await act(async () => {
      hydrateRoot(container, <Probe />);
    });

    expect(hydrationWarnings(errorSpy)).toEqual([]);
    // No regression on desktop: the value stays false, no flip occurs.
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('desktop');
  });
});
