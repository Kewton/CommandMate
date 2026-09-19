/**
 * Sidebar footer settings button: modal on PC, /more on the phone (Issue #2709)
 *
 * `TransitionLink` is deliberately NOT mocked here. The behaviour under test is
 * the handshake between the button's own handler and TransitionLink's
 * `defaultPrevented` check, so the existing Sidebar.test.tsx — which replaces
 * TransitionLink with a bare <a> — cannot see it: under that mock "push was not
 * called" is true no matter which branch ran.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import type { Worktree } from '@/types/models';

// The button's accessible name is `common.settings.title`; resolve it through
// the real dictionary rather than the key-echoing global mock.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const settingsDialogMock = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('@/contexts/SettingsDialogContext', () => ({
  useSettingsDialog: () => ({ isOpen: false, open: settingsDialogMock.open, close: settingsDialogMock.close }),
}));

vi.mock('@/hooks/useAttentionCount', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAttentionCount')>();
  return { ...actual, useAttentionCount: () => ({ count: 0, worktrees: [] }) };
});

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { getAll: vi.fn(), getById: vi.fn() },
    repositoryApi: { sync: vi.fn() },
  };
});

import { worktreeApi } from '@/lib/api-client';

const mockWorktrees: Worktree[] = [
  {
    id: 'feature-test-1',
    name: 'feature/test-1',
    path: '/path/to/worktree1',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    isSessionRunning: true,
    isWaitingForResponse: false,
  },
];

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <ToastProvider>
    <SidebarProvider>
      <WorktreeSelectionProvider>{children}</WorktreeSelectionProvider>
    </SidebarProvider>
  </ToastProvider>
);

/**
 * `useIsMobile` evaluates `matchMedia` once in a layout effect, and the jsdom
 * stub in tests/setup.ts answers from `window.innerWidth` — so the width has to
 * be in place before the first render, not after it.
 */
function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

async function renderSidebar(width: number): Promise<HTMLElement> {
  setViewportWidth(width);
  render(
    <Wrapper>
      <Sidebar />
    </Wrapper>
  );
  return screen.findByTestId('sidebar-settings');
}

describe('Sidebar footer settings button (Issue #2709)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      worktrees: mockWorktrees,
      repositories: [],
    });
    (worktreeApi.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorktrees[0]);
  });

  afterEach(() => {
    setViewportWidth(1024);
  });

  describe('PC (1024px)', () => {
    it('opens the modal instead of navigating', async () => {
      const link = await renderSidebar(1024);

      fireEvent.click(link);

      expect(settingsDialogMock.open).toHaveBeenCalledTimes(1);
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('prevents the default navigation of the anchor', async () => {
      const link = await renderSidebar(1024);

      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves a modified click to the browser', async () => {
      const link = await renderSidebar(1024);
      link.addEventListener('click', (event) => event.preventDefault());

      fireEvent.click(link, { metaKey: true });

      expect(settingsDialogMock.open).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('advertises the dialog it opens', async () => {
      const link = await renderSidebar(1024);
      expect(link.getAttribute('aria-haspopup')).toBe('dialog');
      expect(link.getAttribute('href')).toBe('/more');
    });
  });

  describe('Phone (390px)', () => {
    it('navigates to /more and opens no modal', async () => {
      const link = await renderSidebar(390);

      fireEvent.click(link);

      expect(settingsDialogMock.open).not.toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/more');
    });

    it('is a plain link, with no dialog advertised', async () => {
      const link = await renderSidebar(390);
      expect(link.getAttribute('aria-haspopup')).toBeNull();
      expect(link.getAttribute('href')).toBe('/more');
    });
  });
});
