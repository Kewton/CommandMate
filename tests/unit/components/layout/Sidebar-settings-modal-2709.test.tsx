/**
 * Sidebar footer settings: modal on PC, /more on the phone (Issue #2709)
 *
 * Issue #3510: the footer's settings link became the "Settings" item of the
 * shared settings menu, opened from the footer's only button. The #2709 split
 * is unchanged and is what this file pins, through the menu.
 *
 * Neither `useSettingsDialog` nor `Modal` is mocked: the real provider drives
 * a real `Modal` (and so a real `useFocusTrap`), because where focus lands
 * when the modal closes — the menu button, not <body> — is part of the
 * contract (same reasoning as ActivityBar-settings-modal-2709.test.tsx).
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import { SettingsDialogProvider, useSettingsDialog } from '@/contexts/SettingsDialogContext';
import { Modal } from '@/components/ui/Modal';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import type { Worktree } from '@/types/models';

// The menu item is matched by its English label; resolve it through
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

/** Stands in for SettingsDialog: same context, same Modal, trivial contents. */
function ProbeModal() {
  const { isOpen, close } = useSettingsDialog();
  return (
    <Modal isOpen={isOpen} onClose={close} title="Settings">
      <button type="button" data-testid="probe-inside">
        inside
      </button>
    </Modal>
  );
}

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <ToastProvider>
    <SettingsDialogProvider>
      <SidebarProvider>
        <WorktreeSelectionProvider>{children}</WorktreeSelectionProvider>
      </SidebarProvider>
      <ProbeModal />
    </SettingsDialogProvider>
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

/** Renders the sidebar and opens the footer's settings menu from the keyboard. */
async function renderSidebarAndOpenMenu(width: number): Promise<HTMLElement> {
  setViewportWidth(width);
  render(
    <Wrapper>
      <Sidebar />
    </Wrapper>
  );
  const trigger = await screen.findByTestId('sidebar-settings-menu');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return trigger;
}

describe('Sidebar footer settings button (Issue #2709)', () => {
  beforeAll(() => {
    installRadixJsdomPolyfills();
  });

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
      await renderSidebarAndOpenMenu(1024);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));

      await waitFor(() => expect(screen.getByTestId('modal-panel')).toBeInTheDocument());
      expect(mockPush).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByTestId('modal-panel'));
    });

    it('returns focus to the menu button when the modal is closed', async () => {
      const trigger = await renderSidebarAndOpenMenu(1024);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
      await waitFor(() => expect(screen.getByTestId('modal-panel')).toBeInTheDocument());

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => expect(document.activeElement).toBe(trigger));
      await waitFor(() => expect(screen.queryByTestId('modal-panel')).toBeNull());
    });

    it('leaves the modal closed when the menu itself is dismissed', async () => {
      const trigger = await renderSidebarAndOpenMenu(1024);
      expect(screen.getByRole('menu')).toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(screen.queryByTestId('modal-panel')).toBeNull();
    });
  });

  describe('Phone (390px)', () => {
    it('navigates to /more and opens no modal', async () => {
      await renderSidebarAndOpenMenu(390);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));

      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/more');
      // The PC path opens the modal one microtask after Radix's close; give it
      // the chance to (wrongly) do so before asserting it did not.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByTestId('modal-panel')).toBeNull();
    });
  });
});
