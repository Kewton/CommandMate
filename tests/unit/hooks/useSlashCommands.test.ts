/**
 * Tests for useSlashCommands hook
 *
 * Tests slash command loading and filtering
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import type { SlashCommandGroup } from '@/types/slash-commands';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock the API client for handleApiError
vi.mock('@/lib/api-client', () => ({
  handleApiError: vi.fn((error) => error.message || 'Unknown error'),
}));

describe('useSlashCommands', () => {
  const mockGroups: SlashCommandGroup[] = [
    {
      category: 'planning',
      label: 'Planning',
      commands: [
        {
          name: 'work-plan',
          description: 'Issue単位の具体的な作業計画立案',
          category: 'planning',
          model: 'opus',
          filePath: '.claude/commands/work-plan.md',
        },
        {
          name: 'issue-create',
          description: 'Issue作成',
          category: 'planning',
          filePath: '.claude/commands/issue-create.md',
        },
      ],
    },
    {
      category: 'development',
      label: 'Development',
      commands: [
        {
          name: 'tdd-impl',
          description: 'テスト駆動開発で高品質コードを実装',
          category: 'development',
          model: 'opus',
          filePath: '.claude/commands/tdd-impl.md',
        },
      ],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial state', () => {
    it('should return loading true initially', async () => {
      // Never resolving fetch
      mockFetch.mockImplementation(() => new Promise(() => {}));

      const { result } = renderHook(() => useSlashCommands());

      expect(result.current.loading).toBe(true);
      expect(result.current.groups).toEqual([]);
      expect(result.current.error).toBeNull();
    });
  });

  describe('Loading commands', () => {
    it('should load commands on mount', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      });

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.groups).toEqual(mockGroups);
      expect(result.current.error).toBeNull();
      expect(mockFetch).toHaveBeenCalledWith('/api/slash-commands');
    });

    it('should handle API errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.groups).toEqual([]);
    });

    it('should handle non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBe('HTTP error 500');
      expect(result.current.groups).toEqual([]);
    });
  });

  describe('Worktree-specific commands (Issue #56)', () => {
    it('should use worktree-specific API when worktreeId is provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      });

      const { result } = renderHook(() => useSlashCommands('worktree-123'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/worktrees/worktree-123/slash-commands');
    });

    it('should use default API when worktreeId is not provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      });

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/slash-commands');
    });
  });

  describe('Filtering', () => {
    it('should filter commands by query', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      });

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        result.current.setFilter('work');
      });

      // Should filter to only commands containing 'work'
      expect(result.current.filteredGroups.length).toBeGreaterThan(0);
      const allCommands = result.current.filteredGroups.flatMap((g) => g.commands);
      expect(allCommands.some((cmd) => cmd.name === 'work-plan')).toBe(true);
      expect(allCommands.some((cmd) => cmd.name === 'tdd-impl')).toBe(false);
    });

    it('should return all commands with empty filter', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      });

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        result.current.setFilter('');
      });

      expect(result.current.filteredGroups).toEqual(mockGroups);
    });

    it('should be case-insensitive when filtering', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      });

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        result.current.setFilter('WORK');
      });

      const allCommands = result.current.filteredGroups.flatMap((g) => g.commands);
      expect(allCommands.some((cmd) => cmd.name === 'work-plan')).toBe(true);
    });

    it('should filter by description as well', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      });

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        result.current.setFilter('テスト駆動');
      });

      const allCommands = result.current.filteredGroups.flatMap((g) => g.commands);
      expect(allCommands.some((cmd) => cmd.name === 'tdd-impl')).toBe(true);
    });

    it('should remove empty groups after filtering', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      });

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        result.current.setFilter('tdd');
      });

      // Only development group should remain
      expect(result.current.filteredGroups.length).toBe(1);
      expect(result.current.filteredGroups[0].category).toBe('development');
    });
  });

  describe('Flat commands list', () => {
    it('should provide flat list of all commands', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      });

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.allCommands).toHaveLength(3);
      expect(result.current.allCommands.map((c) => c.name)).toContain('work-plan');
      expect(result.current.allCommands.map((c) => c.name)).toContain('tdd-impl');
    });
  });

  describe('Refresh', () => {
    it('should provide refresh function', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      });

      const { result } = renderHook(() => useSlashCommands());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(typeof result.current.refresh).toBe('function');

      // Call refresh
      act(() => {
        result.current.refresh();
      });

      // Should have called fetch again
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
