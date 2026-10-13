/**
 * @vitest-environment jsdom
 */

/**
 * "New task" in the palette's Actions (Issue #3512): selecting it closes the
 * palette and opens the one New task dialog (`openNewTask()`), the same entry
 * the sidebar / rail buttons and Mod+Shift+O use.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/contexts/PcDisplaySizeContext', () => ({
  usePcDisplaySizeContext: () => ({ size: 'medium', setSize: vi.fn(), isMobile: false, factor: 1, isAvailable: false }),
}));

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => null,
}));

vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: vi.fn() }),
}));

import { CommandPalette } from '@/components/common/CommandPalette';
import { ToastProvider } from '@/components/common/Toast';
import { ViewTransitionsProvider } from '@/components/providers/ViewTransitionsProvider';
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext';
import { NewTaskProvider, useNewTask } from '@/contexts/NewTaskContext';

function NewTaskProbe() {
  const { isOpen } = useNewTask();
  return <div data-testid="new-task-probe" data-open={String(isOpen)} />;
}

function renderPalette() {
  return render(
    <ToastProvider>
      <ViewTransitionsProvider>
        <CommandPaletteProvider>
          <NewTaskProvider>
            <CommandPalette />
            <NewTaskProbe />
          </NewTaskProvider>
        </CommandPaletteProvider>
      </ViewTransitionsProvider>
    </ToastProvider>,
  );
}

// cmdk needs these; jsdom has neither (same stubs as CommandPalette.test.tsx).
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  window.localStorage.clear();
});

describe('CommandPalette: New task action (Issue #3512)', () => {
  it('lists New task in the Actions group', () => {
    renderPalette();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByText('commandPalette.actions.newTask')).toBeInTheDocument();
  });

  it('closes the palette and opens the New task dialog', async () => {
    renderPalette();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByTestId('new-task-probe')).toHaveAttribute('data-open', 'false');

    fireEvent.click(screen.getByText('commandPalette.actions.newTask'));

    expect(screen.queryByTestId('command-palette')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('new-task-probe')).toHaveAttribute('data-open', 'true');
    });
  });

  it('leaves the dialog closed when another action runs (negative control)', async () => {
    renderPalette();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(screen.getByText('commandPalette.actions.keyboardShortcuts'));
    await Promise.resolve();
    expect(screen.getByTestId('new-task-probe')).toHaveAttribute('data-open', 'false');
  });
});
