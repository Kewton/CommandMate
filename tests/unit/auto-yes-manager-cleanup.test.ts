/**
 * Auto-Yes Manager cleanup function tests
 * Issue #404: Resource leak prevention - deleteAutoYesState and worktree ID accessors
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setAutoYesEnabled,
  getAutoYesState,
  clearAllAutoYesStates,
  clearAllPollerStates,
  startAutoYesPolling,
  isValidWorktreeId,
  deleteAutoYesState,
  getAutoYesStateWorktreeIds,
  getAutoYesPollerWorktreeIds,
} from '@/lib/auto-yes-manager';

// Mock dependencies required by startAutoYesPolling
import { vi } from 'vitest';
vi.mock('@/lib/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/prompt-detector', () => ({
  detectPrompt: vi.fn().mockReturnValue({ isPrompt: false }),
}));
vi.mock('@/lib/auto-yes-resolver', () => ({
  resolveAutoAnswer: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn().mockReturnValue({
      getTool: vi.fn().mockReturnValue({
        getSessionName: vi.fn().mockReturnValue('test-session'),
      }),
    }),
  },
}));

describe('Auto-Yes Manager Cleanup Functions (Issue #404)', () => {
  beforeEach(() => {
    clearAllAutoYesStates();
    clearAllPollerStates();
  });

  describe('deleteAutoYesState', () => {
    it('should delete an existing autoYesState entry and return true', () => {
      // Arrange: set up an auto-yes state
      setAutoYesEnabled('wt-valid-1', true);
      expect(getAutoYesState('wt-valid-1')).not.toBeNull();

      // Act
      const result = deleteAutoYesState('wt-valid-1');

      // Assert
      expect(result).toBe(true);
      expect(getAutoYesState('wt-valid-1')).toBeNull();
    });

    it('should return true when deleting a non-existent worktree ID (no-op)', () => {
      // Act: delete a worktree that doesn't exist in the map
      const result = deleteAutoYesState('wt-nonexistent');

      // Assert: should still return true since ID is valid
      expect(result).toBe(true);
    });

    it('should return false for an invalid worktree ID [SEC-404-001]', () => {
      // Act: try with invalid IDs
      expect(deleteAutoYesState('')).toBe(false);
      expect(deleteAutoYesState('../traversal')).toBe(false);
      expect(deleteAutoYesState('has spaces')).toBe(false);
      expect(deleteAutoYesState('special!chars')).toBe(false);
    });

    it('should not affect autoYesPollerStates when deleting autoYesState', () => {
      // Arrange: set up both state and poller
      setAutoYesEnabled('wt-both', true);
      startAutoYesPolling('wt-both', 'claude');

      // Verify poller is active
      expect(getAutoYesPollerWorktreeIds()).toContain('wt-both');

      // Act: delete only the auto-yes state
      deleteAutoYesState('wt-both');

      // Assert: poller should still be present
      expect(getAutoYesPollerWorktreeIds()).toContain('wt-both');
    });
  });

  describe('getAutoYesStateWorktreeIds', () => {
    it('should return empty array when no states exist', () => {
      expect(getAutoYesStateWorktreeIds()).toEqual([]);
    });

    it('should return correct worktree IDs', () => {
      setAutoYesEnabled('wt-a', true);
      setAutoYesEnabled('wt-b', true);
      setAutoYesEnabled('wt-c', true);

      const ids = getAutoYesStateWorktreeIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('wt-a');
      expect(ids).toContain('wt-b');
      expect(ids).toContain('wt-c');
    });
  });

  describe('getAutoYesPollerWorktreeIds', () => {
    it('should return empty array when no pollers exist', () => {
      expect(getAutoYesPollerWorktreeIds()).toEqual([]);
    });

    it('should return correct worktree IDs for active pollers', () => {
      // Set up auto-yes states first (required for starting pollers)
      setAutoYesEnabled('wt-p1', true);
      setAutoYesEnabled('wt-p2', true);

      startAutoYesPolling('wt-p1', 'claude');
      startAutoYesPolling('wt-p2', 'codex');

      const ids = getAutoYesPollerWorktreeIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain('wt-p1');
      expect(ids).toContain('wt-p2');
    });
  });
});
