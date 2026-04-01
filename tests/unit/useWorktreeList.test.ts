/**
 * Unit tests for useWorktreeList
 * Issue #600: UX refresh - sort, filter, group logic
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWorktreeList } from '@/hooks/useWorktreeList';
import type { SidebarBranchItem } from '@/types/sidebar';

const createItem = (overrides: Partial<SidebarBranchItem>): SidebarBranchItem => ({
  id: 'default',
  name: 'default-branch',
  repositoryName: 'repo',
  status: 'idle',
  hasUnread: false,
  ...overrides,
});

const sampleItems: SidebarBranchItem[] = [
  createItem({ id: '1', name: 'feature-b', repositoryName: 'RepoA', lastActivity: new Date('2024-01-02') }),
  createItem({ id: '2', name: 'feature-a', repositoryName: 'RepoB', lastActivity: new Date('2024-01-01') }),
  createItem({ id: '3', name: 'main', repositoryName: 'RepoA', lastActivity: new Date('2024-01-03') }),
  createItem({ id: '4', name: 'develop', repositoryName: 'RepoC', lastActivity: new Date('2024-01-04') }),
];

describe('useWorktreeList()', () => {
  describe('sorting', () => {
    it('should sort by branchName ascending', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'branchName',
          sortDirection: 'asc',
          viewMode: 'flat',
        })
      );
      expect(result.current.sortedItems.map((i) => i.name)).toEqual([
        'develop',
        'feature-a',
        'feature-b',
        'main',
      ]);
    });

    it('should sort by updatedAt descending (newest first)', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'updatedAt',
          sortDirection: 'desc',
          viewMode: 'flat',
        })
      );
      expect(result.current.sortedItems.map((i) => i.id)).toEqual(['4', '3', '1', '2']);
    });

    it('should sort by repositoryName ascending', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'repositoryName',
          sortDirection: 'asc',
          viewMode: 'flat',
        })
      );
      expect(result.current.sortedItems[0].repositoryName).toBe('RepoA');
      expect(result.current.sortedItems[result.current.sortedItems.length - 1].repositoryName).toBe('RepoC');
    });
  });

  describe('filtering', () => {
    it('should filter by branch name (case-insensitive)', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'branchName',
          sortDirection: 'asc',
          viewMode: 'flat',
          filterText: 'feature',
        })
      );
      expect(result.current.sortedItems).toHaveLength(2);
      expect(result.current.sortedItems.map((i) => i.name)).toEqual(['feature-a', 'feature-b']);
    });

    it('should filter by repository name', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'branchName',
          sortDirection: 'asc',
          viewMode: 'flat',
          filterText: 'repoa',
        })
      );
      expect(result.current.sortedItems).toHaveLength(2);
    });

    it('should return all items when filterText is empty', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'branchName',
          sortDirection: 'asc',
          viewMode: 'flat',
          filterText: '',
        })
      );
      expect(result.current.sortedItems).toHaveLength(4);
    });

    it('should return empty array when no items match filter', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'branchName',
          sortDirection: 'asc',
          viewMode: 'flat',
          filterText: 'nonexistent',
        })
      );
      expect(result.current.sortedItems).toHaveLength(0);
    });
  });

  describe('grouping', () => {
    it('should group by repository when viewMode is grouped', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'branchName',
          sortDirection: 'asc',
          viewMode: 'grouped',
        })
      );
      expect(result.current.groupedItems).toHaveLength(3);
      expect(result.current.groupedItems.map((g) => g.repositoryName)).toEqual([
        'RepoA',
        'RepoB',
        'RepoC',
      ]);
    });

    it('should return empty groupedItems when viewMode is flat', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'branchName',
          sortDirection: 'asc',
          viewMode: 'flat',
        })
      );
      expect(result.current.groupedItems).toEqual([]);
    });

    it('should sort branches within each group', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'branchName',
          sortDirection: 'asc',
          viewMode: 'grouped',
        })
      );
      const repoAGroup = result.current.groupedItems.find((g) => g.repositoryName === 'RepoA');
      expect(repoAGroup?.branches.map((b) => b.name)).toEqual(['feature-b', 'main']);
    });

    it('should apply filter before grouping', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: sampleItems,
          sortKey: 'branchName',
          sortDirection: 'asc',
          viewMode: 'grouped',
          filterText: 'feature',
        })
      );
      expect(result.current.groupedItems).toHaveLength(2);
      expect(result.current.groupedItems.map((g) => g.repositoryName)).toEqual(['RepoA', 'RepoB']);
    });
  });

  describe('empty input', () => {
    it('should handle empty items array', () => {
      const { result } = renderHook(() =>
        useWorktreeList({
          items: [],
          sortKey: 'branchName',
          sortDirection: 'asc',
          viewMode: 'flat',
        })
      );
      expect(result.current.sortedItems).toEqual([]);
      expect(result.current.groupedItems).toEqual([]);
    });
  });
});
