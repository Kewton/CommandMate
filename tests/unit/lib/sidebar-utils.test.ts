/**
 * Tests for sidebar utility functions
 *
 * Tests sortBranches function with various sort keys and directions
 */

import { describe, it, expect } from 'vitest';
import {
  sortBranches,
  groupBranches,
  generateRepositoryColor,
  SortKey,
  SortDirection,
  STATUS_PRIORITY,
  SORT_KEYS,
  isValidSortKey,
  compareByTimestamp,
} from '@/lib/sidebar-utils';
import type { ViewMode, BranchGroup } from '@/lib/sidebar-utils';
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
  describe('SORT_KEYS', () => {
    it('should contain all 5 sort key values', () => {
      expect(SORT_KEYS).toHaveLength(5);
      expect(SORT_KEYS).toContain('updatedAt');
      expect(SORT_KEYS).toContain('repositoryName');
      expect(SORT_KEYS).toContain('branchName');
      expect(SORT_KEYS).toContain('status');
      expect(SORT_KEYS).toContain('lastSent');
    });

    it('should be readonly', () => {
      // TypeScript enforces readonly at compile time; runtime check that it is an array
      expect(Array.isArray(SORT_KEYS)).toBe(true);
    });
  });

  describe('SortKey', () => {
    it('should have valid sort key values including lastSent', () => {
      const keys: SortKey[] = ['updatedAt', 'repositoryName', 'branchName', 'status', 'lastSent'];
      expect(keys).toHaveLength(5);
    });
  });

  describe('isValidSortKey', () => {
    it('should return true for all valid sort keys', () => {
      expect(isValidSortKey('updatedAt')).toBe(true);
      expect(isValidSortKey('repositoryName')).toBe(true);
      expect(isValidSortKey('branchName')).toBe(true);
      expect(isValidSortKey('status')).toBe(true);
      expect(isValidSortKey('lastSent')).toBe(true);
    });

    it('should return false for invalid sort keys', () => {
      expect(isValidSortKey('invalid')).toBe(false);
      expect(isValidSortKey('')).toBe(false);
      expect(isValidSortKey('UPDATED_AT')).toBe(false);
    });
  });

  describe('compareByTimestamp', () => {
    it('should return negative when a is newer than b (bTime - aTime)', () => {
      // a is newer => aTime > bTime => bTime - aTime < 0
      const result = compareByTimestamp('2024-06-01', '2024-01-01');
      expect(result).toBeLessThan(0);
    });

    it('should return positive when b is newer than a (bTime - aTime)', () => {
      // b is newer => bTime > aTime => bTime - aTime > 0
      const result = compareByTimestamp('2024-01-01', '2024-06-01');
      expect(result).toBeGreaterThan(0);
    });

    it('should return 0 when both are equal', () => {
      const result = compareByTimestamp('2024-06-01', '2024-06-01');
      expect(result).toBe(0);
    });

    it('should return 1 when a is null (null goes to end)', () => {
      const result = compareByTimestamp(null, '2024-06-01');
      expect(result).toBe(1);
    });

    it('should return -1 when b is null (null goes to end)', () => {
      const result = compareByTimestamp('2024-06-01', null);
      expect(result).toBe(-1);
    });

    it('should return 0 when both are null', () => {
      const result = compareByTimestamp(null, null);
      expect(result).toBe(0);
    });

    it('should return 0 when both are undefined', () => {
      const result = compareByTimestamp(undefined, undefined);
      expect(result).toBe(0);
    });

    it('should handle numeric timestamps', () => {
      const a = new Date('2024-06-01').getTime();
      const b = new Date('2024-01-01').getTime();
      const result = compareByTimestamp(a, b);
      // a is newer => bTime - aTime < 0
      expect(result).toBeLessThan(0);
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

    describe('sort by lastSent', () => {
      it('should sort by lastActivity as fallback (desc = newest first)', () => {
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

        const result = sortBranches(branches, 'lastSent', 'desc');

        expect(result[0].id).toBe('2'); // newest
        expect(result[1].id).toBe('3'); // middle
        expect(result[2].id).toBe('1'); // oldest
      });

      it('should sort by lastActivity ascending (oldest first)', () => {
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

        const result = sortBranches(branches, 'lastSent', 'asc');

        expect(result[0].id).toBe('1'); // oldest
        expect(result[1].id).toBe('2'); // newest
      });

      it('should place null lastActivity at end regardless of direction', () => {
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
          createBranchItem({
            id: '3',
            name: 'also-no-date',
            lastActivity: undefined,
          }),
        ];

        // desc direction
        const resultDesc = sortBranches(branches, 'lastSent', 'desc');
        expect(resultDesc[0].id).toBe('2');

        // asc direction
        const resultAsc = sortBranches(branches, 'lastSent', 'asc');
        expect(resultAsc[0].id).toBe('2');
      });
    });

    describe('default case', () => {
      it('should not throw for unknown sort key and preserve order', () => {
        const branches: SidebarBranchItem[] = [
          createBranchItem({ id: '1', name: 'a' }),
          createBranchItem({ id: '2', name: 'b' }),
        ];

        // Force an unknown sort key via type assertion
        const result = sortBranches(branches, 'unknownKey' as SortKey, 'asc');

        expect(result).toHaveLength(2);
        // comparison = 0 means order is preserved
        expect(result[0].id).toBe('1');
        expect(result[1].id).toBe('2');
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

  // ==========================================================================
  // ViewMode type
  // ==========================================================================

  describe('ViewMode', () => {
    it('should have valid view mode values', () => {
      const modes: ViewMode[] = ['grouped', 'flat'];
      expect(modes).toHaveLength(2);
    });
  });

  // ==========================================================================
  // groupBranches
  // ==========================================================================

  describe('groupBranches', () => {
    it('should group branches by repositoryName', () => {
      const branches: SidebarBranchItem[] = [
        createBranchItem({ id: '1', name: 'feature/a', repositoryName: 'RepoA' }),
        createBranchItem({ id: '2', name: 'feature/b', repositoryName: 'RepoB' }),
        createBranchItem({ id: '3', name: 'feature/c', repositoryName: 'RepoA' }),
      ];

      const result = groupBranches(branches, 'branchName', 'asc');

      expect(result).toHaveLength(2);
      expect(result[0].repositoryName).toBe('RepoA');
      expect(result[0].branches).toHaveLength(2);
      expect(result[1].repositoryName).toBe('RepoB');
      expect(result[1].branches).toHaveLength(1);
    });

    it('should sort groups alphabetically by repositoryName (case-insensitive)', () => {
      const branches: SidebarBranchItem[] = [
        createBranchItem({ id: '1', repositoryName: 'Zoo' }),
        createBranchItem({ id: '2', repositoryName: 'alpha' }),
        createBranchItem({ id: '3', repositoryName: 'Beta' }),
      ];

      const result = groupBranches(branches, 'branchName', 'asc');

      expect(result[0].repositoryName).toBe('alpha');
      expect(result[1].repositoryName).toBe('Beta');
      expect(result[2].repositoryName).toBe('Zoo');
    });

    it('should sort branches within each group using sortBranches', () => {
      const branches: SidebarBranchItem[] = [
        createBranchItem({ id: '1', name: 'z-branch', repositoryName: 'Repo' }),
        createBranchItem({ id: '2', name: 'a-branch', repositoryName: 'Repo' }),
        createBranchItem({ id: '3', name: 'm-branch', repositoryName: 'Repo' }),
      ];

      const result = groupBranches(branches, 'branchName', 'asc');

      expect(result).toHaveLength(1);
      expect(result[0].branches[0].name).toBe('a-branch');
      expect(result[0].branches[1].name).toBe('m-branch');
      expect(result[0].branches[2].name).toBe('z-branch');
    });

    it('should sort branches within groups by updatedAt descending', () => {
      const branches: SidebarBranchItem[] = [
        createBranchItem({
          id: '1', name: 'old', repositoryName: 'Repo',
          lastActivity: new Date('2024-01-01'),
        }),
        createBranchItem({
          id: '2', name: 'new', repositoryName: 'Repo',
          lastActivity: new Date('2024-06-01'),
        }),
      ];

      const result = groupBranches(branches, 'updatedAt', 'desc');

      expect(result[0].branches[0].id).toBe('2'); // newest first
      expect(result[0].branches[1].id).toBe('1');
    });

    it('should return empty array for empty input', () => {
      const result = groupBranches([], 'branchName', 'asc');
      expect(result).toEqual([]);
    });

    it('should handle single branch', () => {
      const branches: SidebarBranchItem[] = [
        createBranchItem({ id: '1', repositoryName: 'Solo' }),
      ];

      const result = groupBranches(branches, 'branchName', 'asc');

      expect(result).toHaveLength(1);
      expect(result[0].repositoryName).toBe('Solo');
      expect(result[0].branches).toHaveLength(1);
    });

    it('should return correct BranchGroup shape', () => {
      const branches: SidebarBranchItem[] = [
        createBranchItem({ id: '1', repositoryName: 'MyRepo' }),
      ];

      const result: BranchGroup[] = groupBranches(branches, 'branchName', 'asc');

      expect(result[0]).toHaveProperty('repositoryName');
      expect(result[0]).toHaveProperty('branches');
      expect(Array.isArray(result[0].branches)).toBe(true);
    });
  });

  // ==========================================================================
  // generateRepositoryColor
  // ==========================================================================

  describe('generateRepositoryColor', () => {
    it('should return the same color for the same repository name (idempotency)', () => {
      const color1 = generateRepositoryColor('my-repo');
      const color2 = generateRepositoryColor('my-repo');
      expect(color1).toBe(color2);
    });

    it('should return different hue values for different repository names', () => {
      const color1 = generateRepositoryColor('repo-alpha');
      const color2 = generateRepositoryColor('repo-beta');
      const color3 = generateRepositoryColor('repo-gamma');
      // At least two of three should differ
      const unique = new Set([color1, color2, color3]);
      expect(unique.size).toBeGreaterThanOrEqual(2);
    });

    it('should not throw for empty string and return valid HSL', () => {
      expect(() => generateRepositoryColor('')).not.toThrow();
      const color = generateRepositoryColor('');
      expect(color).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    });

    it('should handle special characters (Japanese, symbols, spaces)', () => {
      const japanese = generateRepositoryColor('テストリポジトリ');
      const symbols = generateRepositoryColor('repo@#$%^&*');
      const spaces = generateRepositoryColor('my cool repo');

      expect(japanese).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
      expect(symbols).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
      expect(spaces).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    });

    it('should return value matching HSL format', () => {
      const color = generateRepositoryColor('CommandMate');
      expect(color).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    });

    it('should use consistent saturation and lightness values', () => {
      const color = generateRepositoryColor('test-repo');
      // Extract saturation and lightness
      const match = color.match(/^hsl\(\d+, (\d+)%, (\d+)%\)$/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('65');
      expect(match![2]).toBe('60');
    });
  });
});
