/**
 * @vitest-environment jsdom
 *
 * Issue #3435: when `git status` could not be read (`statusUnknown`), no git
 * status surface may look clean. Each surface shows an explicit "unknown"
 * marker instead; clean / dirty rendering is unchanged.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GitCurrentStatusBar } from '@/components/worktree/git/panels/GitCurrentStatusBar';
import { GitPaneProvider } from '@/components/worktree/git/GitPaneContext';
import { MobileHeader } from '@/components/mobile/MobileHeader';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { toSkillTargetOption } from '@/components/skills/SkillTargetSelector';
import { makeAppUpdateValue } from '@tests/helpers/app-update-context';
import type { GitStatus, Worktree } from '@/types/models';

const mockUseAppUpdate = vi.fn();
vi.mock('@/contexts/AppUpdateContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AppUpdateContext')>()),
  useAppUpdate: () => mockUseAppUpdate(),
}));

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const base: GitStatus = {
  currentBranch: 'feature/3435',
  initialBranch: 'feature/3435',
  isBranchMismatch: false,
  commitHash: 'abc1234',
  isDirty: false,
};
const unknown: GitStatus = { ...base, statusUnknown: true };
const dirty: GitStatus = { ...base, isDirty: true };

beforeEach(() => {
  mockUseAppUpdate.mockReturnValue(makeAppUpdateValue());
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderStatusBar(gitStatus: GitStatus) {
  return render(
    <GitPaneProvider value={{ isMobile: false, onDiffSelect: vi.fn() }}>
      <GitCurrentStatusBar
        gitStatus={gitStatus}
        statusLoading={false}
        statusError={null}
        onRefresh={vi.fn()}
      />
    </GitPaneProvider>
  );
}

describe('GitCurrentStatusBar (Issue #3435)', () => {
  it('shows an unknown badge instead of looking clean', () => {
    renderStatusBar(unknown);
    const badge = screen.getByTestId('git-status-unknown-badge');
    expect(badge).toHaveTextContent('worktree.git.currentStatus.statusUnknown');
    expect(screen.queryByTestId('git-status-dirty-badge')).toBeNull();
  });

  it('clean: no unknown badge, no dirty badge (unchanged)', () => {
    renderStatusBar(base);
    expect(screen.queryByTestId('git-status-unknown-badge')).toBeNull();
    expect(screen.queryByTestId('git-status-dirty-badge')).toBeNull();
  });

  it('dirty: dirty badge, no unknown badge (unchanged)', () => {
    renderStatusBar(dirty);
    expect(screen.getByTestId('git-status-dirty-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('git-status-unknown-badge')).toBeNull();
  });
});

describe('MobileHeader (Issue #3435)', () => {
  it('marks the branch as unknown when status could not be read', () => {
    render(<MobileHeader worktreeName="wt" status="idle" gitStatus={unknown} />);
    expect(screen.getByTestId('mobile-git-status-unknown')).toHaveAttribute(
      'title',
      'worktree.git.statusUnknown'
    );
  });

  it('shows no unknown marker for a clean tree', () => {
    render(<MobileHeader worktreeName="wt" status="idle" gitStatus={base} />);
    expect(screen.getByTestId('mobile-branch-name')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-git-status-unknown')).toBeNull();
  });
});

describe('DesktopHeader (Issue #3435)', () => {
  const props = {
    worktreeName: 'wt',
    repositoryName: 'CommandMate',
    status: 'idle' as const,
    onInfoClick: vi.fn(),
    onWorktreeStatusChange: vi.fn(),
    worktreeStatus: 'in_progress' as const,
  };

  it('marks the branch as unknown when status could not be read', () => {
    render(<DesktopHeader {...props} gitStatus={unknown} />);
    expect(screen.getByTestId('desktop-git-status-unknown')).toHaveAttribute(
      'title',
      'worktree.git.statusUnknown'
    );
  });

  it('shows no unknown marker for a clean tree', () => {
    render(<DesktopHeader {...props} gitStatus={base} />);
    expect(screen.getByTestId('desktop-branch-name')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-git-status-unknown')).toBeNull();
  });
});

describe('toSkillTargetOption (Issue #3435)', () => {
  const worktree = { id: 'w', name: 'wt', repositoryName: 'r' } as Worktree;

  it('maps an unread status to dirty=null (unknown), not clean', () => {
    expect(toSkillTargetOption({ ...worktree, gitStatus: unknown }).dirty).toBeNull();
  });

  it('keeps clean / dirty unchanged', () => {
    expect(toSkillTargetOption({ ...worktree, gitStatus: base }).dirty).toBe(false);
    expect(toSkillTargetOption({ ...worktree, gitStatus: dirty }).dirty).toBe(true);
  });
});
