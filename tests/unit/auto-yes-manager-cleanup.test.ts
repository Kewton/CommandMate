/**
 * Auto-Yes Manager cleanup function tests
 * Issue #404: Resource leak prevention - deleteAutoYesState and worktree ID accessors
 * Issue #525: Updated for composite key migration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setAutoYesEnabled,
  getAutoYesState,
  clearAllAutoYesStates,
  clearAllPollerStates,
  startAutoYesPolling,
  deleteAutoYesState,
  getAutoYesStateWorktreeIds,
  getAutoYesPollerWorktreeIds,
  buildCompositeKey,
} from '@/lib/polling/auto-yes-manager';

// Mock dependencies required by startAutoYesPolling
import { vi } from 'vitest';
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/detection/prompt-detector', () => ({
  detectPrompt: vi.fn().mockReturnValue({ isPrompt: false }),
}));
vi.mock('@/lib/polling/auto-yes-resolver', () => ({
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

describe('Auto-Yes Manager Cleanup Functions (Issue #404, #525)', () => {
  beforeEach(() => {
    clearAllAutoYesStates();
    clearAllPollerStates();
  });

  describe('deleteAutoYesState', () => {
    it('should delete an existing autoYesState entry and return true', () => {
      // Arrange: set up an auto-yes state
      setAutoYesEnabled('wt-valid-1', 'claude', true);
      expect(getAutoYesState('wt-valid-1', 'claude')).not.toBeNull();

      // Act
      const compositeKey = buildCompositeKey('wt-valid-1', 'claude');
      const result = deleteAutoYesState(compositeKey);

      // Assert
      expect(result).toBe(true);
      expect(getAutoYesState('wt-valid-1', 'claude')).toBeNull();
    });

    it('should return true when deleting a non-existent composite key (no-op)', () => {
      const compositeKey = buildCompositeKey('wt-nonexistent', 'claude');
      const result = deleteAutoYesState(compositeKey);
      expect(result).toBe(true);
    });

    it('should return false for an invalid composite key [SEC-404-001]', () => {
      expect(deleteAutoYesState('')).toBe(false);
      expect(deleteAutoYesState('../traversal:claude')).toBe(false);
      expect(deleteAutoYesState('has spaces:claude')).toBe(false);
      expect(deleteAutoYesState('special!chars:claude')).toBe(false);
    });

    it('should return false for composite key with invalid cliToolId', () => {
      expect(deleteAutoYesState('wt-1:invalid')).toBe(false);
    });

    it('should not affect autoYesPollerStates when deleting autoYesState', () => {
      // Arrange: set up both state and poller
      setAutoYesEnabled('wt-both', 'claude', true);
      startAutoYesPolling('wt-both', 'claude');

      // Verify poller is active
      expect(getAutoYesPollerWorktreeIds()).toContain('wt-both:claude');

      // Act: delete only the auto-yes state
      deleteAutoYesState(buildCompositeKey('wt-both', 'claude'));

      // Assert: poller should still be present
      expect(getAutoYesPollerWorktreeIds()).toContain('wt-both:claude');
    });
  });

  describe('getAutoYesStateWorktreeIds (returns composite keys)', () => {
    it('should return empty array when no states exist', () => {
      expect(getAutoYesStateWorktreeIds()).toEqual([]);
    });

    it('should return correct composite keys', () => {
      setAutoYesEnabled('wt-a', 'claude', true);
      setAutoYesEnabled('wt-b', 'codex', true);
      setAutoYesEnabled('wt-c', 'claude', true);

      const ids = getAutoYesStateWorktreeIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('wt-a:claude');
      expect(ids).toContain('wt-b:codex');
      expect(ids).toContain('wt-c:claude');
    });
  });

  describe('getAutoYesPollerWorktreeIds (returns composite keys)', () => {
    it('should return empty array when no pollers exist', () => {
      expect(getAutoYesPollerWorktreeIds()).toEqual([]);
    });

    it('should return correct composite keys for active pollers', () => {
      setAutoYesEnabled('wt-p1', 'claude', true);
      setAutoYesEnabled('wt-p2', 'codex', true);

      startAutoYesPolling('wt-p1', 'claude');
      startAutoYesPolling('wt-p2', 'codex');

      const ids = getAutoYesPollerWorktreeIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain('wt-p1:claude');
      expect(ids).toContain('wt-p2:codex');
    });
  });
});
