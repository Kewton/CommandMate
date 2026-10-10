/**
 * @vitest-environment jsdom
 */

/**
 * The open/close button stays put (Issue #3512).
 *
 * jsdom has no layout, so the position is checked through what decides it:
 *
 *   - the column's top: the fixed `<aside>` holding the button (open sidebar
 *     or icon rail) must get the same `top` class and inline `top` in both
 *     states — under every repository-tab mode (collapsed / always / hidden)
 *     and with or without the global Header;
 *   - inside the column: nothing between the `<aside>` and the button may move
 *     it — no element before it, no top/left padding or margin class (those
 *     are rem and scale with the display size). The only offset is the
 *     button's cell, whose padding and the button size are inline px.
 *
 * The collapsed-mode band must therefore not sit above the header once the
 * sidebar closes (it would push the rail down by its height).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const layout = vi.hoisted(() => ({ pathname: '/sessions' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => layout.pathname,
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

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/components/layout/Header', () => ({
  Header: () => <header data-testid="header" />,
}));
vi.mock('@/components/layout/RepositoryTabBar', () => ({
  RepositoryTabBar: () => <div data-testid="repository-tab-bar" />,
  REPOSITORY_TAB_BAR_HEIGHT: 32,
}));
vi.mock('@/components/common/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/common/KeyboardShortcutsOverlay', () => ({ KeyboardShortcutsOverlay: () => null }));
vi.mock('@/components/layout/VersionMismatchBanner', () => ({ VersionMismatchBanner: () => null }));
vi.mock('@/components/common/WhatsNewDialog', () => ({ WhatsNewDialog: () => null }));
vi.mock('@/components/new-task/NewTaskDialogHost', () => ({ NewTaskDialogHost: () => null }));

import { AppShell } from '@/components/layout/AppShell';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider, REPO_TAB_BAR_MODE_STORAGE_KEY } from '@/contexts/SidebarContext';
import { PcDisplaySizeProvider } from '@/contexts/PcDisplaySizeContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import {
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_TOGGLE_CELL_PADDING,
  SIDEBAR_TOGGLE_SIZE,
  type RepoTabBarMode,
} from '@/lib/sidebar-utils';

function renderShell() {
  return render(
    <ToastProvider>
      <PcDisplaySizeProvider>
        <SidebarProvider>
          <WorktreeSelectionProvider>
            <AppShell>
              <div>Content</div>
            </AppShell>
          </WorktreeSelectionProvider>
        </SidebarProvider>
      </PcDisplaySizeProvider>
    </ToastProvider>,
  );
}

/** Tailwind classes that move a box's own top/left edge (rem-based). */
const OFFSET_CLASS = /^-?(p|px|py|pt|pl|m|mx|my|mt|ml|top|left|inset|inset-x|inset-y|translate-x|translate-y)-/;

interface Placement {
  asideTop: string[];
  asideInlineTop: string;
  /** Offsets met between the aside and the button, outside the px cell. */
  strayOffsets: string[];
  /** Elements before the button's ancestors (anything above / left of it). */
  precedingSiblings: string[];
  cellPadding: string;
  buttonSize: string;
}

function placementOf(button: HTMLElement): Placement {
  const aside = button.closest('aside') as HTMLElement;
  const cell = button.closest('[data-sidebar-toggle-cell]') as HTMLElement;
  const strayOffsets: string[] = [];
  const precedingSiblings: string[] = [];
  for (let el: HTMLElement | null = button; el && el !== aside; el = el.parentElement) {
    if (el.previousElementSibling) {
      precedingSiblings.push(`${el.tagName}.${el.className} after ${el.previousElementSibling.tagName}`);
    }
    if (el === cell) continue; // its padding is inline px, checked below
    for (const cls of Array.from(el.classList)) {
      if (OFFSET_CLASS.test(cls)) strayOffsets.push(`${el.tagName}: ${cls}`);
    }
    if (el !== button && el.style.padding) strayOffsets.push(`${el.tagName}: padding ${el.style.padding}`);
  }
  return {
    asideTop: Array.from(aside.classList).filter((c) => /^top-|^h-/.test(c)).sort(),
    asideInlineTop: aside.style.top,
    strayOffsets,
    precedingSiblings,
    cellPadding: cell.style.padding,
    buttonSize: `${button.style.width} x ${button.style.height}`,
  };
}

function measureOpenThenClosed(): { open: Placement; closed: Placement } {
  renderShell();
  const openButton = screen.getByTestId('sidebar-panel-toggle');
  const open = placementOf(openButton);
  fireEvent.click(openButton);
  const closed = placementOf(screen.getByTestId('sidebar-rail-toggle'));
  return { open, closed };
}

beforeEach(() => {
  window.localStorage.clear();
  layout.pathname = '/sessions';
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('open/close button placement (Issue #3512)', () => {
  it('fits the px cell exactly into the 56px rail', () => {
    expect(SIDEBAR_TOGGLE_SIZE + 2 * SIDEBAR_TOGGLE_CELL_PADDING).toBe(SIDEBAR_RAIL_WIDTH);
  });

  // Positive control: the default mode, where closing the sidebar brings the
  // band up. Before the fix the rail went 32px down and the open sidebar's
  // button sat inside the header's rem padding.
  it('is at the same top and left in the default "collapsed" mode', () => {
    const { open, closed } = measureOpenThenClosed();

    expect(closed).toEqual(open);
    expect(open.strayOffsets).toEqual([]);
    expect(open.precedingSiblings).toEqual([]);
    expect(open.cellPadding).toBe(`${SIDEBAR_TOGGLE_CELL_PADDING}px`);
    expect(open.buttonSize).toBe(`${SIDEBAR_TOGGLE_SIZE}px x ${SIDEBAR_TOGGLE_SIZE}px`);
    // The band is up, but beside the rail, below the header.
    const band = screen.getByTestId('repository-tab-bar');
    expect(band.closest('[data-testid="repository-tab-bar-beside-rail"]')).not.toBeNull();
    expect(
      screen.getByTestId('header').compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it.each<RepoTabBarMode>(['always', 'hidden'])('is at the same top and left in "%s" mode (negative control)', (mode) => {
    window.localStorage.setItem(REPO_TAB_BAR_MODE_STORAGE_KEY, mode);
    const { open, closed } = measureOpenThenClosed();

    expect(closed).toEqual(open);
    expect(open.strayOffsets).toEqual([]);
    expect(open.precedingSiblings).toEqual([]);
  });

  it('pushes both columns below an "always" band by the same amount', () => {
    window.localStorage.setItem(REPO_TAB_BAR_MODE_STORAGE_KEY, 'always');
    const { open, closed } = measureOpenThenClosed();
    expect(open.asideInlineTop).toBe('96px');
    expect(closed.asideInlineTop).toBe('96px');
  });

  it.each<RepoTabBarMode>(['collapsed', 'always', 'hidden'])(
    'is at the same top and left without the global Header (worktree screen, "%s")',
    (mode) => {
      layout.pathname = '/worktrees/wt-1';
      window.localStorage.setItem(REPO_TAB_BAR_MODE_STORAGE_KEY, mode);
      const { open, closed } = measureOpenThenClosed();

      expect(closed).toEqual(open);
      expect(open.asideTop).toEqual(['h-full', 'top-0']);
      expect(open.strayOffsets).toEqual([]);
    },
  );
});
