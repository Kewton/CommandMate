/**
 * Unit tests for prompt deduplication module
 * Issue #565: Content hash-based duplicate prompt prevention
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { isDuplicatePrompt, clearPromptHashCache } from '@/lib/polling/prompt-dedup';

describe('prompt-dedup', () => {
  const POLLER_KEY = 'test-worktree:copilot';

  beforeEach(() => {
    clearPromptHashCache(POLLER_KEY);
  });

  describe('isDuplicatePrompt()', () => {
    it('should return false for the first prompt', () => {
      expect(isDuplicatePrompt(POLLER_KEY, 'Allow access?')).toBe(false);
    });

    it('should return true for the same content', () => {
      isDuplicatePrompt(POLLER_KEY, 'Allow access?');
      expect(isDuplicatePrompt(POLLER_KEY, 'Allow access?')).toBe(true);
    });

    it('should return false for different content', () => {
      isDuplicatePrompt(POLLER_KEY, 'Allow access?');
      expect(isDuplicatePrompt(POLLER_KEY, 'Confirm changes?')).toBe(false);
    });

    it('should update cache on new content', () => {
      isDuplicatePrompt(POLLER_KEY, 'First prompt');
      isDuplicatePrompt(POLLER_KEY, 'Second prompt');
      // First prompt is no longer in cache (replaced by second)
      expect(isDuplicatePrompt(POLLER_KEY, 'First prompt')).toBe(false);
    });

    it('should isolate different pollerKeys', () => {
      const KEY_A = 'worktree-a:copilot';
      const KEY_B = 'worktree-b:copilot';

      isDuplicatePrompt(KEY_A, 'Same content');
      // Different key, same content -> not a duplicate
      expect(isDuplicatePrompt(KEY_B, 'Same content')).toBe(false);

      clearPromptHashCache(KEY_A);
      clearPromptHashCache(KEY_B);
    });

    it('should handle empty content', () => {
      expect(isDuplicatePrompt(POLLER_KEY, '')).toBe(false);
      expect(isDuplicatePrompt(POLLER_KEY, '')).toBe(true);
    });
  });

  describe('clearPromptHashCache()', () => {
    it('should allow the same content after clearing', () => {
      isDuplicatePrompt(POLLER_KEY, 'Allow access?');
      expect(isDuplicatePrompt(POLLER_KEY, 'Allow access?')).toBe(true);

      clearPromptHashCache(POLLER_KEY);
      // After clearing, same content should not be considered duplicate
      expect(isDuplicatePrompt(POLLER_KEY, 'Allow access?')).toBe(false);
    });

    it('should not affect other pollerKeys', () => {
      const KEY_A = 'worktree-a:copilot';
      const KEY_B = 'worktree-b:copilot';

      isDuplicatePrompt(KEY_A, 'Content A');
      isDuplicatePrompt(KEY_B, 'Content B');

      clearPromptHashCache(KEY_A);

      // KEY_A cleared, KEY_B still cached
      expect(isDuplicatePrompt(KEY_A, 'Content A')).toBe(false);
      expect(isDuplicatePrompt(KEY_B, 'Content B')).toBe(true);

      clearPromptHashCache(KEY_B);
    });

    it('should be safe to call on non-existent key', () => {
      expect(() => clearPromptHashCache('nonexistent:key')).not.toThrow();
    });
  });
});
