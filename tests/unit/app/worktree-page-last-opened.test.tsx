/**
 * @vitest-environment jsdom
 *
 * Issue #2643: ブランチ画面を開くと、そのブランチを「最後に開いたブランチ」として記録する。
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

let mockParams: Record<string, string> = { id: 'wt-9' };

vi.mock('next/navigation', () => ({
  useParams: () => mockParams,
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/worktree/WorktreeDetailRefactored', () => ({
  WorktreeDetailRefactored: ({ worktreeId }: { worktreeId: string }) => (
    <div data-testid="detail" data-worktree-id={worktreeId} />
  ),
}));

import WorktreeDetailPage from '@/app/worktrees/[id]/page';
import { LAST_OPENED_WORKTREE_STORAGE_KEY } from '@/lib/last-opened-worktree';

beforeEach(() => {
  localStorage.clear();
  mockParams = { id: 'wt-9' };
});

afterEach(() => {
  cleanup();
});

describe('WorktreeDetailPage — 最後に開いたブランチの記録 (Issue #2643)', () => {
  it('表示したブランチの ID を記録する', () => {
    render(<WorktreeDetailPage />);
    expect(localStorage.getItem(LAST_OPENED_WORKTREE_STORAGE_KEY)).toBe('wt-9');
  });

  it('別のブランチへ切り替えると記録も切り替わる', () => {
    const { rerender } = render(<WorktreeDetailPage />);
    mockParams = { id: 'wt-10' };
    rerender(<WorktreeDetailPage />);
    expect(localStorage.getItem(LAST_OPENED_WORKTREE_STORAGE_KEY)).toBe('wt-10');
  });
});
