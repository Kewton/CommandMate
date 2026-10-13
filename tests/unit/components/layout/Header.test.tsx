/**
 * Navigation active indicator (Issue #1119), moved off the Header by #3512.
 *
 * The Header used to carry the screen links; #3512 moved them to the sidebar
 * (open) and the icon rail (closed). The intents of this file are kept on both
 * hosts: the link of the current screen — and only it — carries
 * aria-current="page" plus the active styling; `/` and `/chat` mark nothing.
 *
 * Header's own remaining job (screen name, connection status, update) is in
 * Header-screen-3512.test.tsx. The #2709 "Settings opens the modal" cases are
 * listed in the commit body: Settings is a SettingsMenu item now, pinned by
 * SidebarRail-settings-modal-2709 / Sidebar-settings-modal-2709 /
 * SettingsMenu-3510.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { SidebarRail } from '@/components/layout/SidebarRail';
import { Sidebar } from '@/components/layout/Sidebar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { PcDisplaySizeProvider } from '@/contexts/PcDisplaySizeContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

const usePathnameMock = vi.fn<() => string>(() => '/');

vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
  // TransitionLink (#1122) reads the router at render time via useViewTransitionRouter.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: vi.fn() }),
}));

vi.mock('@/hooks/useAttentionCount', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAttentionCount')>();
  return { ...actual, useAttentionCount: () => ({ count: 0, worktrees: [] }) };
});

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { getAll: vi.fn(async () => ({ worktrees: [], repositories: [] })), getById: vi.fn() },
    repositoryApi: { sync: vi.fn() },
  };
});

// Issue #1206: the accessible names below are the real English labels, so
// resolve them through the real dictionary rather than the key-echoing global
// mock in tests/setup.ts.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const NAV_LABELS = ['Sessions', 'Repositories', 'Review'] as const;

const ROUTE_CASES: Array<{ pathname: string; activeLabel: (typeof NAV_LABELS)[number] }> = [
  { pathname: '/sessions', activeLabel: 'Sessions' },
  { pathname: '/sessions/abc123', activeLabel: 'Sessions' },
  { pathname: '/repositories', activeLabel: 'Repositories' },
  { pathname: '/review', activeLabel: 'Review' },
];

/** The two hosts of the screen links since #3512. */
const HOSTS: Array<{ name: string; render: () => void; testIds: Record<(typeof NAV_LABELS)[number], string>; activeClass: string }> = [
  {
    name: 'icon rail',
    render: () => render(
      <SidebarProvider initialOpen={false}>
        <SidebarRail />
      </SidebarProvider>,
    ),
    testIds: { Sessions: 'sidebar-rail-sessions', Repositories: 'sidebar-rail-repositories', Review: 'sidebar-rail-review' },
    activeClass: 'bg-sidebar-hover',
  },
  {
    name: 'sidebar',
    render: () => render(
      <ToastProvider>
        <PcDisplaySizeProvider>
          <SidebarProvider>
            <WorktreeSelectionProvider>
              <Sidebar />
            </WorktreeSelectionProvider>
          </SidebarProvider>
        </PcDisplaySizeProvider>
      </ToastProvider>,
    ),
    testIds: { Sessions: 'sidebar-nav-sessions', Repositories: 'sidebar-nav-repositories', Review: 'sidebar-nav-review' },
    activeClass: 'bg-sidebar-hover',
  },
];

describe.each(HOSTS)('Navigation active indicator on the $name (Issue #1119 → #3512)', (host) => {
  beforeEach(() => {
    usePathnameMock.mockReturnValue('/');
    localStorage.clear();
  });

  describe.each(ROUTE_CASES)('pathname: $pathname', ({ pathname, activeLabel }) => {
    it(`marks only "${activeLabel}" with aria-current="page"`, () => {
      usePathnameMock.mockReturnValue(pathname);
      host.render();

      for (const label of NAV_LABELS) {
        const link = screen.getByTestId(host.testIds[label]);
        expect(link).toHaveAccessibleName(new RegExp(`^${label}`));
        if (label === activeLabel) {
          expect(link).toHaveAttribute('aria-current', 'page');
        } else {
          expect(link).not.toHaveAttribute('aria-current');
        }
      }
    });
  });

  it('styles only the active item as active', () => {
    usePathnameMock.mockReturnValue('/sessions');
    host.render();

    expect(screen.getByTestId(host.testIds.Sessions)).toHaveClass(host.activeClass);
    expect(screen.getByTestId(host.testIds.Repositories)).not.toHaveClass(host.activeClass);
  });

  it.each(['/', '/chat'])('does not mark any nav link active on %s (Issue #2642)', (pathname) => {
    usePathnameMock.mockReturnValue(pathname);
    host.render();

    for (const label of NAV_LABELS) {
      expect(screen.getByTestId(host.testIds[label])).not.toHaveAttribute('aria-current');
    }
  });

  it('links each label to its screen', () => {
    host.render();
    expect(screen.getByTestId(host.testIds.Sessions)).toHaveAttribute('href', '/sessions');
    expect(screen.getByTestId(host.testIds.Repositories)).toHaveAttribute('href', '/repositories');
    expect(screen.getByTestId(host.testIds.Review)).toHaveAttribute('href', '/review');
  });
});
