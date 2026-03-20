/**
 * Tests for auto-yes-state.ts composite key migration (Issue #525)
 * Phase 1 Tasks 1.2, 1.3: Function signature changes and byWorktree helpers
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  setAutoYesEnabled,
  getAutoYesState,
  disableAutoYes,
  deleteAutoYesState,
  checkStopCondition,
  clearAllAutoYesStates,
  getAutoYesStateWorktreeIds,
  getCompositeKeysByWorktree,
  deleteAutoYesStateByWorktree,
  buildCompositeKey,
} from '@/lib/auto-yes-state';
import { DEFAULT_AUTO_YES_DURATION } from '@/config/auto-yes-config';

describe('auto-yes-state composite key migration (Issue #525)', () => {
  beforeEach(() => {
    clearAllAutoYesStates();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('setAutoYesEnabled with cliToolId', () => {
    it('should enable auto-yes with worktreeId and cliToolId', () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      const state = setAutoYesEnabled('wt-1', 'claude', true);

      expect(state.enabled).toBe(true);
      expect(state.enabledAt).toBe(now);
      expect(state.expiresAt).toBe(now + DEFAULT_AUTO_YES_DURATION);
    });

    it('should store state under composite key', () => {
      setAutoYesEnabled('wt-1', 'claude', true);
      setAutoYesEnabled('wt-1', 'codex', true);

      // Both should exist independently
      const claudeState = getAutoYesState('wt-1', 'claude');
      const codexState = getAutoYesState('wt-1', 'codex');
      expect(claudeState?.enabled).toBe(true);
      expect(codexState?.enabled).toBe(true);
    });

    it('should enable with specified duration', () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      const state = setAutoYesEnabled('wt-1', 'claude', true, 10800000);

      expect(state.expiresAt).toBe(now + 10800000);
    });

    it('should enable with stopPattern', () => {
      const state = setAutoYesEnabled('wt-1', 'claude', true, undefined, 'error');

      expect(state.stopPattern).toBe('error');
    });

    it('should disable auto-yes for specific agent', () => {
      setAutoYesEnabled('wt-1', 'claude', true);
      setAutoYesEnabled('wt-1', 'codex', true);

      // Disable only claude
      const state = setAutoYesEnabled('wt-1', 'claude', false);

      expect(state.enabled).toBe(false);
      // Codex should remain enabled
      expect(getAutoYesState('wt-1', 'codex')?.enabled).toBe(true);
    });
  });

  describe('getAutoYesState with cliToolId', () => {
    it('should return null when no state exists', () => {
      expect(getAutoYesState('wt-1', 'claude')).toBeNull();
    });

    it('should return state for specific agent', () => {
      setAutoYesEnabled('wt-1', 'claude', true);
      setAutoYesEnabled('wt-1', 'codex', true, 10800000);

      const claudeState = getAutoYesState('wt-1', 'claude');
      const codexState = getAutoYesState('wt-1', 'codex');

      expect(claudeState?.enabled).toBe(true);
      expect(codexState?.enabled).toBe(true);
    });

    it('should auto-disable when expired', () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      setAutoYesEnabled('wt-1', 'claude', true);

      // Advance past expiration
      vi.setSystemTime(now + 3600001);

      const state = getAutoYesState('wt-1', 'claude');
      expect(state?.enabled).toBe(false);
    });
  });

  describe('disableAutoYes with cliToolId', () => {
    it('should disable specific agent', () => {
      setAutoYesEnabled('wt-1', 'claude', true);
      setAutoYesEnabled('wt-1', 'codex', true);

      const state = disableAutoYes('wt-1', 'claude', 'expired');

      expect(state.enabled).toBe(false);
      expect(state.stopReason).toBe('expired');
      // Codex should remain enabled
      expect(getAutoYesState('wt-1', 'codex')?.enabled).toBe(true);
    });

    it('should handle non-existent state', () => {
      const state = disableAutoYes('wt-new', 'claude');

      expect(state.enabled).toBe(false);
      expect(state.enabledAt).toBe(0);
    });
  });

  describe('deleteAutoYesState with compositeKey [MF-001]', () => {
    it('should delete state by composite key', () => {
      setAutoYesEnabled('wt-1', 'claude', true);
      const compositeKey = buildCompositeKey('wt-1', 'claude');

      const result = deleteAutoYesState(compositeKey);

      expect(result).toBe(true);
      expect(getAutoYesState('wt-1', 'claude')).toBeNull();
    });

    it('should return false for invalid composite key', () => {
      expect(deleteAutoYesState('')).toBe(false);
      expect(deleteAutoYesState('../traversal:claude')).toBe(false);
    });

    it('should return false for composite key with invalid cliToolId', () => {
      expect(deleteAutoYesState('wt-1:invalid-tool')).toBe(false);
    });

    it('should return true for valid but non-existent key', () => {
      const result = deleteAutoYesState(buildCompositeKey('wt-nonexistent', 'claude'));
      expect(result).toBe(true);
    });
  });

  describe('checkStopCondition with compositeKey [MF-001]', () => {
    it('should check stop condition using composite key', () => {
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'error');
      const compositeKey = buildCompositeKey('wt-1', 'claude');

      const matched = checkStopCondition(compositeKey, 'some error occurred');

      expect(matched).toBe(true);
      expect(getAutoYesState('wt-1', 'claude')?.enabled).toBe(false);
      expect(getAutoYesState('wt-1', 'claude')?.stopReason).toBe('stop_pattern_matched');
    });

    it('should call onStopMatched with compositeKey', () => {
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'error');
      const compositeKey = buildCompositeKey('wt-1', 'claude');
      const onStopMatched = vi.fn();

      checkStopCondition(compositeKey, 'some error occurred', onStopMatched);

      expect(onStopMatched).toHaveBeenCalledWith(compositeKey);
    });

    it('should return false when no stop pattern set', () => {
      setAutoYesEnabled('wt-1', 'claude', true);
      const compositeKey = buildCompositeKey('wt-1', 'claude');

      expect(checkStopCondition(compositeKey, 'some output')).toBe(false);
    });

    it('should return false when pattern does not match', () => {
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'error');
      const compositeKey = buildCompositeKey('wt-1', 'claude');

      expect(checkStopCondition(compositeKey, 'all good')).toBe(false);
    });
  });

  describe('getAutoYesStateWorktreeIds returns composite keys', () => {
    it('should return empty array when no states', () => {
      expect(getAutoYesStateWorktreeIds()).toEqual([]);
    });

    it('should return composite keys', () => {
      setAutoYesEnabled('wt-1', 'claude', true);
      setAutoYesEnabled('wt-2', 'codex', true);

      const keys = getAutoYesStateWorktreeIds();
      expect(keys).toContain('wt-1:claude');
      expect(keys).toContain('wt-2:codex');
    });
  });

  describe('getCompositeKeysByWorktree', () => {
    it('should return all composite keys for a worktree', () => {
      setAutoYesEnabled('wt-1', 'claude', true);
      setAutoYesEnabled('wt-1', 'codex', true);
      setAutoYesEnabled('wt-2', 'claude', true);

      const keys = getCompositeKeysByWorktree('wt-1');
      expect(keys).toHaveLength(2);
      expect(keys).toContain('wt-1:claude');
      expect(keys).toContain('wt-1:codex');
    });

    it('should return empty array for non-existent worktree', () => {
      expect(getCompositeKeysByWorktree('wt-nonexistent')).toEqual([]);
    });
  });

  describe('deleteAutoYesStateByWorktree', () => {
    it('should delete all states for a worktree', () => {
      setAutoYesEnabled('wt-1', 'claude', true);
      setAutoYesEnabled('wt-1', 'codex', true);
      setAutoYesEnabled('wt-2', 'claude', true);

      const count = deleteAutoYesStateByWorktree('wt-1');

      expect(count).toBe(2);
      expect(getAutoYesState('wt-1', 'claude')).toBeNull();
      expect(getAutoYesState('wt-1', 'codex')).toBeNull();
      // wt-2 should remain
      expect(getAutoYesState('wt-2', 'claude')?.enabled).toBe(true);
    });

    it('should return 0 for non-existent worktree', () => {
      expect(deleteAutoYesStateByWorktree('wt-nonexistent')).toBe(0);
    });
  });
});
