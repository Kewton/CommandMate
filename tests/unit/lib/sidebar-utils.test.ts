/**
 * Tests for sidebar utility functions
 *
 * Tests sortBranches function with various sort keys and directions
 */

import { describe, it, expect } from 'vitest';
import {
  sortBranches,
  SortKey,
  SortDirection,
  STATUS_PRIORITY,
} from '@/lib/sidebar-utils';
import type { SidebarBranchItem } from '@/types/sidebar';

// ============================================================================
// Test Data
// ============================================================================

const createBranchItem = (
  overrides: Partial<SidebarBranchItem> = {}
): SidebarBranchItem => ({
  id: 'test-id',
  name: 'feature/test',
  repositoryName: 'MyRepo',
  status: 'idle',
  hasUnread: false,
  ...overrides,
});

describe('sidebar-utils', () => {
  describe('SortKey', () => {
    it('should have valid sort key values', () => {
      const keys: SortKey[] = ['updatedAt', 'repositoryName', 'branchName', 'status'];
      expect(keys).toHaveLength(4);
    });
  });

  describe('SortDirection', () => {
    it('should have valid sort direction values', () => {
      const directions: SortDirection[] = ['asc', 'desc'];
      expect(directions).toHaveLength(2);
    });
  });

  describe('STATUS_PRIORITY', () => {
    it('should define priority for all branch statuses', () => {
      expect(STATUS_PRIORITY.waiting).toBeLessThan(STATUS_PRIORITY.running);
      expect(STATUS_PRIORITY.running).toBeLessThan(STATUS_PRIORITY.generating);
      expect(STATUS_PRIORITY.generating).toBeLessThan(STATUS_PRIORITY.idle);
    });
  });

  describe('sortBranches', () => {
    describe('sort by updatedAt', () => {
      it('should sort by updatedAt descending (newest first)', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({
            id: '1',
            name: 'old-branch',
            lastActivity: new Date('2024-01-01'),
          }),
          createBranchItem({
            id: '2',
            name: 'new-branch',
            lastActivity: new Date('2024-06-01'),
          }),
          createBranchItem({
            id: '3',
            name: 'middle-branch',
            lastActivity: new Date('2024-03-01'),
          }),
        ];

        const result = sortBranches(branches, 'updatedAt', 'desc');

        expect(result[0].id).toBe('2'); // newest
        expect(result[1].id).toBe('3'); // middle
        expect(result[2].id).toBe('1'); // oldest
      });

      it('should sort by updatedAt ascending (oldest first)', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({
            id: '1',
            name: 'old-branch',
            lastActivity: new Date('2024-01-01'),
          }),
          createBranchItem({
            id: '2',
            name: 'new-branch',
            lastActivity: new Date('2024-06-01'),
          }),
        ];

        const result = sortBranches(branches, 'updatedAt', 'asc');

        expect(result[0].id).toBe('1'); // oldest
        expect(result[1].id).toBe('2'); // newest
      });

      it('should handle branches without lastActivity', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({
            id: '1',
            name: 'no-date',
            lastActivity: undefined,
          }),
          createBranchItem({
            id: '2',
            name: 'has-date',
            lastActivity: new Date('2024-06-01'),
          }),
        ];

        const result = sortBranches(branches, 'updatedAt', 'desc');

        // Branches with dates should come before those without
        expect(result[0].id).toBe('2');
        expect(result[1].id).toBe('1');
      });
    });

    describe('sort by repositoryName', () => {
      it('should sort by repositoryName ascending (A-Z)', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({ id: '1', repositoryName: 'Zoo' }),
          createBranchItem({ id: '2', repositoryName: 'Alpha' }),
          createBranchItem({ id: '3', repositoryName: 'Mid' }),
        ];

        const result = sortBranches(branches, 'repositoryName', 'asc');

        expect(result[0].repositoryName).toBe('Alpha');
        expect(result[1].repositoryName).toBe('Mid');
        expect(result[2].repositoryName).toBe('Zoo');
      });

      it('should sort by repositoryName descending (Z-A)', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({ id: '1', repositoryName: 'Alpha' }),
          createBranchItem({ id: '2', repositoryName: 'Zoo' }),
        ];

        const result = sortBranches(branches, 'repositoryName', 'desc');

        expect(result[0].repositoryName).toBe('Zoo');
        expect(result[1].repositoryName).toBe('Alpha');
      });

      it('should be case-insensitive', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({ id: '1', repositoryName: 'zoo' }),
          createBranchItem({ id: '2', repositoryName: 'ALPHA' }),
          createBranchItem({ id: '3', repositoryName: 'Beta' }),
        ];

        const result = sortBranches(branches, 'repositoryName', 'asc');

        expect(result[0].repositoryName).toBe('ALPHA');
        expect(result[1].repositoryName).toBe('Beta');
        expect(result[2].repositoryName).toBe('zoo');
      });
    });

    describe('sort by branchName', () => {
      it('should sort by branchName ascending (A-Z)', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({ id: '1', name: 'feature/z-feature' }),
          createBranchItem({ id: '2', name: 'feature/a-feature' }),
          createBranchItem({ id: '3', name: 'main' }),
        ];

        const result = sortBranches(branches, 'branchName', 'asc');

        expect(result[0].name).toBe('feature/a-feature');
        expect(result[1].name).toBe('feature/z-feature');
        expect(result[2].name).toBe('main');
      });

      it('should sort by branchName descending (Z-A)', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({ id: '1', name: 'alpha' }),
          createBranchItem({ id: '2', name: 'zeta' }),
        ];

        const result = sortBranches(branches, 'branchName', 'desc');

        expect(result[0].name).toBe('zeta');
        expect(result[1].name).toBe('alpha');
      });
    });

    describe('sort by status', () => {
      it('should sort by status priority (waiting first)', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({ id: '1', status: 'idle' }),
          createBranchItem({ id: '2', status: 'waiting' }),
          createBranchItem({ id: '3', status: 'running' }),
          createBranchItem({ id: '4', status: 'generating' }),
        ];

        const result = sortBranches(branches, 'status', 'asc');

        expect(result[0].status).toBe('waiting');
        expect(result[1].status).toBe('running');
        expect(result[2].status).toBe('generating');
        expect(result[3].status).toBe('idle');
      });

      it('should reverse status priority when descending', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({ id: '1', status: 'waiting' }),
          createBranchItem({ id: '2', status: 'idle' }),
        ];

        const result = sortBranches(branches, 'status', 'desc');

        expect(result[0].status).toBe('idle');
        expect(result[1].status).toBe('waiting');
      });
    });

    describe('edge cases', () => {
      it('should return empty array for empty input', () => {
        const result = sortBranches([], 'updatedAt', 'desc');
        expect(result).toEqual([]);
      });

      it('should return single item array unchanged', () => {
        const branch = createBranchItem({ id: 'single' });
        const result = sortBranches([branch], 'updatedAt', 'desc');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('single');
      });

      it('should maintain stable sort for equal values', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({ id: '1', repositoryName: 'Same' }),
          createBranchItem({ id: '2', repositoryName: 'Same' }),
          createBranchItem({ id: '3', repositoryName: 'Same' }),
        ];

        const result = sortBranches(branches, 'repositoryName', 'asc');

        // Original order should be preserved for equal values
        expect(result[0].id).toBe('1');
        expect(result[1].id).toBe('2');
        expect(result[2].id).toBe('3');
      });

      it('should not mutate the original array', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({ id: '1', name: 'z' }),
          createBranchItem({ id: '2', name: 'a' }),
        ];
        const originalFirst = branches[0];

        sortBranches(branches, 'branchName', 'asc');

        expect(branches[0]).toBe(originalFirst);
      });
    });
  });
});
