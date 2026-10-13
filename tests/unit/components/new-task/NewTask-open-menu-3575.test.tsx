/**
 * New task (Mod+Shift+O) and Mod+B stand down while a Radix menu is open
 * (Issue #3575): the sidebar's View / Sort menu and the settings menu.
 *
 * Renders the real Sidebar (both menus live in it), the real
 * NewTaskDialogHost listener and the real useSidebarToggleShortcut. Only the
 * dialog body is stubbed — whether it mounts is what is checked.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Worktree } from '@/types/models';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      getAll: vi.fn(),
      getById: vi.fn().mockResolvedValue(null),
      markAsViewed: vi.fn().mockResolvedValue(undefined),
    },
    repositoryApi: { sync: vi.fn() },
  };
});

vi.mock('@/components/new-task/NewTaskDialog', () => ({
  NewTaskDialog: () => <div data-testid="new-task-dialog-stub" />,
}));

import { Sidebar } from '@/components/layout/Sidebar';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import { NewTaskProvider } from '@/contexts/NewTaskContext';
import { NewTaskDialogHost } from '@/components/new-task/NewTaskDialogHost';
import { useSidebarToggleShortcut } from '@/components/layout/useSidebarToggleShortcut';

const WORKTREES: Worktree[] = [
  {
    id: 'a',
    name: 'feature/alpha',
    path: '/repos/app/a',
    repositoryPath: '/repos/app',
    repositoryName: 'App',
  } as unknown as Worktree,
];

const toggleSpy = vi.fn();

function ToggleShortcut() {
  useSidebarToggleShortcut(true, toggleSpy);
  return null;
}

function renderShell() {
  return render(
    <NewTaskProvider>
      <SidebarProvider>
        <WorktreeSelectionProvider externalWorktrees={WORKTREES} externalRepositories={[]}>
          <Sidebar />
          <ToggleShortcut />
          <NewTaskDialogHost />
        </WorktreeSelectionProvider>
      </SidebarProvider>
    </NewTaskProvider>,
  );
}

const pressNewTask = () =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'O', code: 'KeyO', metaKey: true, shiftKey: true });
const pressToggleSidebar = () =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'b', code: 'KeyB', metaKey: true });

/** Opens a Radix menu from its trigger and waits for its first item to take focus. */
async function openMenu(trigger: HTMLElement): Promise<void> {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await waitFor(() => {
    expect(document.activeElement?.closest('[role="menu"][data-state="open"]')).not.toBeNull();
  });
}

async function closeMenu(trigger: HTMLElement): Promise<void> {
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
}

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  localStorage.clear();
  toggleSpy.mockClear();
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ success: true, order: null }) }) as unknown as typeof fetch;
});

describe.each([
  ['the View / Sort menu', 'sidebar-list-options'],
  ['the settings menu', 'sidebar-settings-menu'],
])('[#3575] shortcuts while %s is open', (_label, triggerTestId) => {
  it('does not open New task with Mod+Shift+O (positive control)', async () => {
    renderShell();
    const trigger = await screen.findByTestId(triggerTestId);

    await openMenu(trigger);
    pressNewTask();
    expect(screen.queryByTestId('new-task-dialog-stub')).not.toBeInTheDocument();
  });

  it('does not toggle the sidebar with Mod+B (positive control)', async () => {
    renderShell();
    const trigger = await screen.findByTestId(triggerTestId);

    await openMenu(trigger);
    pressToggleSidebar();
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it('opens New task and toggles the sidebar again once the menu is closed (negative control)', async () => {
    renderShell();
    const trigger = await screen.findByTestId(triggerTestId);

    await openMenu(trigger);
    await closeMenu(trigger);
    pressToggleSidebar();
    expect(toggleSpy).toHaveBeenCalledTimes(1);
    pressNewTask();
    expect(await screen.findByTestId('new-task-dialog-stub')).toBeInTheDocument();
  });
});
