/**
 * Tests for TransitionLink (Issue #1122).
 *
 * Verifies that a plain left-click routes through the View Transitions
 * crossfade when supported, degrades to immediate navigation when the API is
 * absent or reduced motion is requested, and leaves modified / same-route
 * clicks to the browser default.
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TransitionLink } from '@/components/view-transitions/TransitionLink';
import { ViewTransitionsProvider } from '@/components/providers/ViewTransitionsProvider';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/current',
}));

vi.mock('next/link', () => ({
  __esModule: true,
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
    function MockLink({ children, ...props }, ref) {
      return (
        <a ref={ref} {...props}>
          {children}
        </a>
      );
    },
  ),
}));

// lib.dom types startViewTransition as a required method; re-declare it optional
// so the feature-absent path (`delete`) and the fake stub are expressible.
type MutableVTDoc = Omit<Document, 'startViewTransition'> & {
  startViewTransition?: (cb: () => void | Promise<void>) => unknown;
};
const doc = document as unknown as MutableVTDoc;

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function renderLink(props: React.ComponentProps<typeof TransitionLink>) {
  return render(
    <ViewTransitionsProvider>
      <TransitionLink {...props} />
    </ViewTransitionsProvider>,
  );
}

describe('TransitionLink', () => {
  beforeEach(() => {
    stubReducedMotion(false);
    nav.push.mockClear();
    nav.replace.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete doc.startViewTransition;
  });

  it('renders an anchor with the given href and content', () => {
    renderLink({ href: '/sessions', children: 'Sessions' });
    const link = screen.getByRole('link', { name: 'Sessions' });
    expect(link).toHaveAttribute('href', '/sessions');
  });

  it('navigates through startViewTransition on a plain click when supported', () => {
    const svt = vi.fn((cb: () => void | Promise<void>) => {
      void cb();
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition: vi.fn() };
    });
    doc.startViewTransition = svt;

    renderLink({ href: '/sessions', children: 'Sessions' });
    fireEvent.click(screen.getByRole('link', { name: 'Sessions' }));

    expect(svt).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/sessions');
  });

  it('navigates immediately (no startViewTransition) when the API is unavailable', () => {
    delete doc.startViewTransition;

    renderLink({ href: '/sessions', children: 'Sessions' });
    expect(() =>
      fireEvent.click(screen.getByRole('link', { name: 'Sessions' })),
    ).not.toThrow();

    expect(nav.push).toHaveBeenCalledWith('/sessions');
  });

  it('does not start a view transition under prefers-reduced-motion but still navigates', () => {
    stubReducedMotion(true);
    const svt = vi.fn();
    doc.startViewTransition = svt;

    renderLink({ href: '/sessions', children: 'Sessions' });
    fireEvent.click(screen.getByRole('link', { name: 'Sessions' }));

    expect(svt).not.toHaveBeenCalled();
    expect(nav.push).toHaveBeenCalledWith('/sessions');
  });

  it('leaves modified clicks (⌘/ctrl-click, new tab) to the browser default', () => {
    doc.startViewTransition = vi.fn();

    renderLink({ href: '/sessions', children: 'Sessions' });
    fireEvent.click(screen.getByRole('link', { name: 'Sessions' }), { metaKey: true });

    expect(nav.push).not.toHaveBeenCalled();
    expect(doc.startViewTransition).not.toHaveBeenCalled();
  });

  it('does not navigate when the link targets the current route', () => {
    doc.startViewTransition = vi.fn();

    renderLink({ href: '/current', children: 'Current' });
    fireEvent.click(screen.getByRole('link', { name: 'Current' }));

    expect(nav.push).not.toHaveBeenCalled();
    expect(doc.startViewTransition).not.toHaveBeenCalled();
  });

  it('leaves clicks on external / new-tab links to the browser default', () => {
    doc.startViewTransition = vi.fn();

    renderLink({
      href: 'https://example.com',
      target: '_blank',
      rel: 'noopener noreferrer',
      children: 'External',
    });
    fireEvent.click(screen.getByRole('link', { name: 'External' }));

    expect(nav.push).not.toHaveBeenCalled();
    expect(doc.startViewTransition).not.toHaveBeenCalled();
  });
});
