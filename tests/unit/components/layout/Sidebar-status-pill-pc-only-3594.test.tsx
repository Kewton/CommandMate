/**
 * The worktree status pill is PC-only (Issue #3594, review follow-up).
 *
 * The phone's drawer is the same Sidebar, so it shows the row's "…" → Status
 * menu, but its rows draw neither the pill nor the dot — the drawer looks as
 * it did before #3594.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
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

const device = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => device.isMobile,
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { getAll: vi.fn(), getById: vi.fn(), markAsViewed: vi.fn(async () => {}) },
    repositoryApi: { sync: vi.fn() },
  };
});

import { worktreeApi } from '@/lib/api-client';
import { Sidebar } from '@/components/layout/Sidebar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

const worktrees: Worktree[] = [
  {
    id: 'feature-review',
    name: 'feature/review',
    path: '/path/to/review',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    status: 'in_review',
  },
];

function renderSidebar() {
  return render(
    <ToastProvider>
      <SidebarProvider>
        <WorktreeSelectionProvider>
          <Sidebar />
        </WorktreeSelectionProvider>
      </SidebarProvider>
    </ToastProvider>
  );
}

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  vi.mocked(worktreeApi.getAll).mockResolvedValue({ worktrees, repositories: [] } as never);
});

describe('status pill on the sidebar rows (Issue #3594)', () => {
  it('is drawn on the PC sidebar', async () => {
    device.isMobile = false;
    renderSidebar();
    await waitFor(() => expect(screen.getByText('feature/review')).toBeInTheDocument());
    expect(screen.getByTestId('branch-worktree-status')).toHaveAttribute('data-status', 'in_review');
  });

  it('is not drawn in the phone drawer, which keeps the Status menu', async () => {
    device.isMobile = true;
    renderSidebar();
    await waitFor(() => expect(screen.getByText('feature/review')).toBeInTheDocument());
    expect(screen.queryByTestId('branch-worktree-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('branch-worktree-status-dot')).not.toBeInTheDocument();

    fireEvent.pointerEnter(screen.getByTestId('branch-list-row'));
    fireEvent.keyDown(screen.getByTestId('branch-row-actions'), { key: 'Enter' });
    expect(screen.getByTestId('branch-row-status-current')).toHaveTextContent('In Review');
  });
});
