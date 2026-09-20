/**
 * Tests for Header navigation active indicator (Issue #1119)
 *
 * Verifies aria-current="page" assignment and the sliding underline
 * indicator classes for each route.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Header } from '@/components/layout/Header';

const usePathnameMock = vi.fn<() => string>(() => '/');

vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
  // TransitionLink (#1122) reads the router at render time via useViewTransitionRouter.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/contexts/CommandPaletteContext', () => ({
  useCommandPalette: () => ({ setOpen: vi.fn() }),
}));

vi.mock('@/components/common/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

vi.mock('@/components/layout/PcDisplaySizeSelector', () => ({
  PcDisplaySizeSelector: () => <div data-testid="pc-display-size-selector" />,
}));

// Issue #2709: "Settings" opens the settings modal rather than navigating.
const settingsDialogMock = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('@/contexts/SettingsDialogContext', () => ({
  useSettingsDialog: () => ({ isOpen: false, open: settingsDialogMock.open, close: settingsDialogMock.close }),
}));

// Issue #1206: the accessible names below are the real English labels, so
// resolve them through the real dictionary rather than the key-echoing global
// mock in tests/setup.ts.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const NAV_LABELS = ['Sessions', 'Repos', 'Review/Report', 'Settings'] as const;

const ROUTE_CASES: Array<{ pathname: string; activeLabel: (typeof NAV_LABELS)[number] }> = [
  { pathname: '/sessions', activeLabel: 'Sessions' },
  { pathname: '/sessions/abc123', activeLabel: 'Sessions' },
  { pathname: '/repositories', activeLabel: 'Repos' },
  { pathname: '/review', activeLabel: 'Review/Report' },
  { pathname: '/more', activeLabel: 'Settings' },
];

function getNavLink(label: string): HTMLElement {
  return screen.getByRole('link', { name: label });
}

describe('Header navigation active indicator', () => {
  beforeEach(() => {
    usePathnameMock.mockReturnValue('/');
  });

  describe.each(ROUTE_CASES)('pathname: $pathname', ({ pathname, activeLabel }) => {
    it(`marks only "${activeLabel}" with aria-current="page"`, () => {
      usePathnameMock.mockReturnValue(pathname);
      render(<Header />);

      for (const label of NAV_LABELS) {
        const link = getNavLink(label);
        if (label === activeLabel) {
          expect(link).toHaveAttribute('aria-current', 'page');
        } else {
          expect(link).not.toHaveAttribute('aria-current');
        }
      }
    });
  });

  it('renders the underline indicator expanded only on the active item', () => {
    usePathnameMock.mockReturnValue('/sessions');
    render(<Header />);

    expect(getNavLink('Sessions').className).toContain('after:scale-x-100');
    expect(getNavLink('Repos').className).toContain('after:scale-x-0');
  });

  it.each(['/', '/chat'])('does not mark any nav link active on %s (Issue #2642)', (pathname) => {
    usePathnameMock.mockReturnValue(pathname);
    render(<Header />);

    for (const label of NAV_LABELS) {
      expect(getNavLink(label)).not.toHaveAttribute('aria-current');
    }
  });
});

describe('Settings opens the modal (Issue #2709)', () => {
  beforeEach(() => {
    usePathnameMock.mockReturnValue('/');
    settingsDialogMock.open.mockClear();
  });

  it('stays a link to /more that advertises the dialog', () => {
    render(<Header />);

    const link = getNavLink('Settings');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/more');
    expect(link.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('leaves the other nav links without aria-haspopup', () => {
    render(<Header />);

    for (const label of ['Sessions', 'Repos', 'Review/Report'] as const) {
      expect(getNavLink(label).getAttribute('aria-haspopup')).toBeNull();
    }
  });

  it('opens the modal on a plain left-click', () => {
    render(<Header />);

    fireEvent.click(getNavLink('Settings'));

    expect(settingsDialogMock.open).toHaveBeenCalledTimes(1);
  });

  it('prevents the anchor default so the page does not navigate', () => {
    render(<Header />);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    getNavLink('Settings').dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ['⌘/Ctrl', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Shift', { shiftKey: true }],
    ['middle click', { button: 1 }],
  ])('leaves a %s click to the browser', (_label, init) => {
    render(<Header />);
    const link = getNavLink('Settings');
    link.addEventListener('click', (event) => event.preventDefault());

    fireEvent.click(link, init);

    expect(settingsDialogMock.open).not.toHaveBeenCalled();
  });

  it('still marks Settings as the current page on /more', () => {
    usePathnameMock.mockReturnValue('/more');
    render(<Header />);

    expect(getNavLink('Settings')).toHaveAttribute('aria-current', 'page');
  });
});
