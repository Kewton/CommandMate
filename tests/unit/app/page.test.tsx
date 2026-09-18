/**
 * @vitest-environment jsdom
 *
 * Issue #2643: `/` は開く画面を決めて移動する。
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const mockRefresh = vi.fn(() => Promise.resolve());
const mockReplace = vi.fn();
let mockWorktrees: unknown[] = [];
let mockRepositories: unknown[] = [];
let mockIsLoading = false;
let mockError: Error | null = null;

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: mockRepositories,
    isLoading: mockIsLoading,
    error: mockError,
    refresh: mockRefresh,
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<'a'>) => (
    <a href={href as string} {...rest}>
      {children}
    </a>
  ),
}));

import Home from '@/app/page';
import { LAST_OPENED_WORKTREE_STORAGE_KEY } from '@/lib/last-opened-worktree';
import { ONBOARDING_DISMISSED_KEY } from '@/lib/onboarding';

const REPO = { path: '/repo', name: 'repo', worktreeCount: 1, visible: true, enabled: true };
const HIDDEN_REPO = { path: '/hidden', name: 'hidden', worktreeCount: 1, visible: false, enabled: true };
const WT1 = { id: 'wt-1', name: 'main', path: '/repo', repositoryPath: '/repo', repositoryName: 'repo' };
const WT2 = { id: 'wt-2', name: 'feat', path: '/repo-feat', repositoryPath: '/repo', repositoryName: 'repo' };
const WT_HIDDEN = { id: 'wt-h', name: 'main', path: '/hidden', repositoryPath: '/hidden', repositoryName: 'hidden' };

beforeEach(() => {
  localStorage.clear();
  mockWorktrees = [];
  mockRepositories = [];
  mockIsLoading = false;
  mockError = null;
  mockRefresh.mockClear();
  mockReplace.mockClear();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no fetch expected'))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Home (/) — 読込中・失敗 (Issue #2643)', () => {
  it('初回読込中はスピナーだけを出し、移動しない', () => {
    mockIsLoading = true;
    render(<Home />);
    expect(screen.getByTestId('home-loading')).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
    expect(screen.queryByTestId('home-empty')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('取得に失敗して一覧が空ならエラーと再試行を出し、再試行で refresh を呼ぶ', () => {
    mockError = new Error('boom');
    render(<Home />);
    expect(screen.getByTestId('home-load-error')).toHaveTextContent('common.sidebar.branchesLoadFailed');
    expect(screen.queryByTestId('home-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('home-load-retry'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('取得に失敗しても前回の一覧があれば移動する', () => {
    mockError = new Error('poll failed');
    mockWorktrees = [WT1];
    mockRepositories = [REPO];
    render(<Home />);
    expect(screen.queryByTestId('home-load-error')).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith('/sessions');
  });

  it('余計なリクエストをしない（共有キャッシュだけを読む）', () => {
    render(<Home />);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Home (/) — 一覧が空 (Issue #2643)', () => {
  it('初回ガイド・「ブランチがありません」・リポジトリ追加のリンクを出し、移動しない', () => {
    render(<Home />);
    expect(screen.getByTestId('home-empty')).toHaveTextContent('common.sidebar.noBranchesAvailable');
    expect(screen.getByTestId('onboarding-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('home-add-repository')).toHaveAttribute('href', '/repositories');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('初回ガイドを閉じた後でもリポジトリ追加のリンクは出る', () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true');
    render(<Home />);
    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
    expect(screen.getByTestId('home-add-repository')).toHaveAttribute('href', '/repositories');
  });
});

describe('Home (/) — 移動先 (Issue #2643)', () => {
  beforeEach(() => {
    mockWorktrees = [WT1, WT2];
    mockRepositories = [REPO];
  });

  it('最後に開いたブランチが一覧にあれば、そのブランチへ replace する', () => {
    localStorage.setItem(LAST_OPENED_WORKTREE_STORAGE_KEY, 'wt-2');
    render(<Home />);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/worktrees/wt-2');
    expect(screen.getByTestId('home-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
  });

  it('記録が無ければ /sessions へ replace する', () => {
    render(<Home />);
    expect(mockReplace).toHaveBeenCalledWith('/sessions');
  });

  it('記録したブランチが一覧に無ければ /sessions へ replace する', () => {
    localStorage.setItem(LAST_OPENED_WORKTREE_STORAGE_KEY, 'wt-deleted');
    render(<Home />);
    expect(mockReplace).toHaveBeenCalledWith('/sessions');
  });

  it('記録したブランチが非表示リポジトリのものなら /sessions へ replace する', () => {
    mockWorktrees = [WT1, WT_HIDDEN];
    mockRepositories = [REPO, HIDDEN_REPO];
    localStorage.setItem(LAST_OPENED_WORKTREE_STORAGE_KEY, 'wt-h');
    render(<Home />);
    expect(mockReplace).toHaveBeenCalledWith('/sessions');
  });

  it('一覧が空なら repositories があっても空状態を出し、移動しない', () => {
    mockWorktrees = [];
    localStorage.setItem(LAST_OPENED_WORKTREE_STORAGE_KEY, 'wt-1');
    render(<Home />);
    expect(screen.getByTestId('home-empty')).toHaveTextContent('common.sidebar.noBranchesAvailable');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('一覧があれば repositories が空でも移動する（e2e のスタブと同じ形）', () => {
    mockRepositories = [];
    localStorage.setItem(LAST_OPENED_WORKTREE_STORAGE_KEY, 'wt-1');
    render(<Home />);
    expect(screen.queryByTestId('home-empty')).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith('/worktrees/wt-1');
  });

  it('ポーリングで一覧が更新されても replace は 1 回だけ', () => {
    localStorage.setItem(LAST_OPENED_WORKTREE_STORAGE_KEY, 'wt-1');
    const { rerender } = render(<Home />);
    for (let i = 0; i < 3; i++) {
      mockWorktrees = [{ ...WT1 }, { ...WT2 }];
      rerender(<Home />);
    }
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('読込が終わった時点で初めて replace する', () => {
    mockIsLoading = true;
    mockWorktrees = [];
    mockRepositories = [];
    localStorage.setItem(LAST_OPENED_WORKTREE_STORAGE_KEY, 'wt-1');
    const { rerender } = render(<Home />);
    expect(mockReplace).not.toHaveBeenCalled();

    mockIsLoading = false;
    mockWorktrees = [WT1, WT2];
    mockRepositories = [REPO];
    rerender(<Home />);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/worktrees/wt-1');
  });
});
