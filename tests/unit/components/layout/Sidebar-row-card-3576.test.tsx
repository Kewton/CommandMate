/**
 * Sidebar rows and group headings after Issue #3576 (UAT S6 of Epic #3508).
 *
 *   - The group heading's drag handle is shown on hover / keyboard focus only
 *     (and stays on touch screens, which never hover). Reordering is unchanged:
 *     the handle is still there, with its label and its drag listeners.
 *   - The sessions view rows draw the same inset card and 8px dot as the
 *     branch rows.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

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

import { Sidebar } from '@/components/layout/Sidebar';
import { SidebarProvider, SIDEBAR_VIEW_MODE_STORAGE_KEY } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

const REPO = '/repos/app';

function wt(overrides: Record<string, unknown> & { id: string }): Worktree {
  return {
    name: overrides.id,
    path: `${REPO}/${overrides.id}`,
    repositoryPath: REPO,
    repositoryName: 'App',
    ...overrides,
  } as unknown as Worktree;
}

function renderSidebar(worktrees: Worktree[]) {
  return render(
    <SidebarProvider>
      <WorktreeSelectionProvider externalWorktrees={worktrees} externalRepositories={[]}>
        <Sidebar />
      </WorktreeSelectionProvider>
    </SidebarProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ success: true, order: null }) }) as unknown as typeof fetch;
});

describe('group heading drag handle (Issue #3576)', () => {
  it('is hidden at rest and shown on hover or keyboard focus', async () => {
    renderSidebar([wt({ id: 'a', name: 'feature/a' })]);
    const handle = await screen.findByTestId('group-drag-handle');
    expect(handle.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(handle.className).toContain('group-hover/header:opacity-100');
    expect(handle.className).toContain('group-focus-within/header:opacity-100');
    expect(handle.closest('.group\\/header')).not.toBeNull();
  });

  it('stays visible on touch screens, which never hover', async () => {
    renderSidebar([wt({ id: 'a', name: 'feature/a' })]);
    const handle = await screen.findByTestId('group-drag-handle');
    expect(handle.className).toContain('[@media(hover:none)]:opacity-100');
  });

  it('keeps reordering as it was: labelled and keyboard-focusable (negative control)', async () => {
    renderSidebar([wt({ id: 'a', name: 'feature/a' })]);
    const handle = await screen.findByTestId('group-drag-handle');
    expect(handle).toHaveAttribute('aria-label', 'Drag to reorder group');
    expect(handle).toHaveAttribute('tabindex', '0');
  });
});

describe('sessions view rows (Issue #3576)', () => {
  it('draw the same inset card and 8px dot as the branch rows', async () => {
    localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, 'sessions');
    renderSidebar([wt({ id: 'a', name: 'feature/a', isSessionRunning: true })]);

    await waitFor(() => expect(screen.getAllByTestId('session-list-item').length).toBeGreaterThan(0));
    const row = screen.getAllByTestId('session-list-item')[0];
    expect(row.className).toMatch(/rounded-\[10px\]/);
    expect(row.className).not.toMatch(/border-l-2|border-accent-500/);
    expect(row.parentElement!.className).toMatch(/(^|\s)px-2(\s|$)/);
    const dot = row.querySelector('span.rounded-full') as HTMLElement;
    expect(dot.className).toMatch(/(^|\s)w-2(\s|$)/);
  });
});
