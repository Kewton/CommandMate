/**
 * Sidebar visibility filter tests (Issue #690)
 *
 * Verifies the Sidebar filters out worktrees whose repository has
 * `visible: false`. Covers the four enabled × visible combinations:
 *   - enabled=true,  visible=true  -> shown
 *   - enabled=false, visible=true  -> shown (Disabled badge handled elsewhere)
 *   - enabled=true,  visible=false -> hidden
 *   - enabled=false, visible=false -> hidden
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      getAll: vi.fn(),
      getById: vi.fn(),
    },
    repositoryApi: {
      sync: vi.fn(),
    },
  };
});

const HIDDEN_REPO_PATH = '/path/to/hidden-repo';
const VISIBLE_REPO_PATH = '/path/to/visible-repo';

const mockWorktrees: Worktree[] = [
  {
    id: 'wt-visible-1',
    name: 'feature/visible-branch',
    path: '/path/to/visible-repo/wt1',
    repositoryPath: VISIBLE_REPO_PATH,
    repositoryName: 'VisibleRepo',
  },
  {
    id: 'wt-hidden-1',
    name: 'feature/hidden-branch',
    path: '/path/to/hidden-repo/wt1',
    repositoryPath: HIDDEN_REPO_PATH,
    repositoryName: 'HiddenRepo',
  },
];

function buildRepoSummary(overrides: Partial<RepositorySummary>): RepositorySummary {
  return {
    id: overrides.id,
    path: overrides.path ?? '/path/to/repo',
    name: overrides.name ?? 'repo',
    displayName: overrides.displayName,
    worktreeCount: overrides.worktreeCount ?? 1,
    visible: overrides.visible ?? true,
    enabled: overrides.enabled ?? true,
  };
}

function Wrapper({
  children,
  repositories,
}: {
  children: React.ReactNode;
  repositories: RepositorySummary[];
}) {
  return (
    <SidebarProvider>
      <WorktreeSelectionProvider
        externalWorktrees={mockWorktrees}
        externalRepositories={repositories}
      >
        {children}
      </WorktreeSelectionProvider>
    </SidebarProvider>
  );
}

describe('Sidebar visibility filter (Issue #690)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows worktrees of repositories with visible=true', async () => {
    const repositories = [
      buildRepoSummary({ path: VISIBLE_REPO_PATH, name: 'VisibleRepo', visible: true }),
      buildRepoSummary({ path: HIDDEN_REPO_PATH, name: 'HiddenRepo', visible: true }),
    ];

    render(
      <Wrapper repositories={repositories}>
        <Sidebar />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    });

    expect(
      screen.getAllByText('feature/visible-branch').length
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText('feature/hidden-branch').length
    ).toBeGreaterThanOrEqual(1);
  });

  it('hides worktrees whose repository has visible=false', async () => {
    const repositories = [
      buildRepoSummary({ path: VISIBLE_REPO_PATH, name: 'VisibleRepo', visible: true }),
      buildRepoSummary({ path: HIDDEN_REPO_PATH, name: 'HiddenRepo', visible: false }),
    ];

    render(
      <Wrapper repositories={repositories}>
        <Sidebar />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    });

    // Visible branch is present
    expect(
      screen.getAllByText('feature/visible-branch').length
    ).toBeGreaterThanOrEqual(1);
    // Hidden branch is NOT rendered
    expect(screen.queryByText('feature/hidden-branch')).toBeNull();
  });

  it('keeps worktrees of disabled-but-visible repositories (Disabled badge case)', async () => {
    const repositories = [
      buildRepoSummary({
        path: VISIBLE_REPO_PATH,
        name: 'VisibleRepo',
        enabled: true,
        visible: true,
      }),
      // enabled=false but visible=true -> still shown in sidebar
      buildRepoSummary({
        path: HIDDEN_REPO_PATH,
        name: 'HiddenRepo',
        enabled: false,
        visible: true,
      }),
    ];

    render(
      <Wrapper repositories={repositories}>
        <Sidebar />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    });

    expect(
      screen.getAllByText('feature/hidden-branch').length
    ).toBeGreaterThanOrEqual(1);
  });

  it('hides worktrees when both enabled=false and visible=false', async () => {
    const repositories = [
      buildRepoSummary({
        path: VISIBLE_REPO_PATH,
        name: 'VisibleRepo',
        enabled: true,
        visible: true,
      }),
      buildRepoSummary({
        path: HIDDEN_REPO_PATH,
        name: 'HiddenRepo',
        enabled: false,
        visible: false,
      }),
    ];

    render(
      <Wrapper repositories={repositories}>
        <Sidebar />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    });

    expect(screen.queryByText('feature/hidden-branch')).toBeNull();
  });

  it('renders empty-state message when every repository is hidden', async () => {
    const repositories = [
      buildRepoSummary({ path: VISIBLE_REPO_PATH, name: 'VisibleRepo', visible: false }),
      buildRepoSummary({ path: HIDDEN_REPO_PATH, name: 'HiddenRepo', visible: false }),
    ];

    render(
      <Wrapper repositories={repositories}>
        <Sidebar />
      </Wrapper>
    );

    await waitFor(() => {
      // No branches rendered: the empty-state message should appear.
      expect(screen.getByText(/no branches available/i)).toBeInTheDocument();
    });
  });

  it('keeps a worktree visible when no matching repository row exists (legacy default)', async () => {
    // No repositories provided at all -> filter set is empty -> all kept.
    render(
      <Wrapper repositories={[]}>
        <Sidebar />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    });

    expect(
      screen.getAllByText('feature/visible-branch').length
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText('feature/hidden-branch').length
    ).toBeGreaterThanOrEqual(1);
  });
});
