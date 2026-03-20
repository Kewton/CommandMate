/**
 * Tests for composite key helper functions (Issue #525)
 * Phase 1: buildCompositeKey, extractWorktreeId, extractCliToolId
 */

import { describe, it, expect } from 'vitest';
import {
  buildCompositeKey,
  extractWorktreeId,
  extractCliToolId,
  COMPOSITE_KEY_SEPARATOR,
} from '@/lib/auto-yes-state';

describe('Composite Key Helpers (Issue #525)', () => {
  describe('COMPOSITE_KEY_SEPARATOR', () => {
    it('should be a colon character', () => {
      expect(COMPOSITE_KEY_SEPARATOR).toBe(':');
    });
  });

  describe('buildCompositeKey', () => {
    it('should create a composite key from worktreeId and cliToolId', () => {
      expect(buildCompositeKey('wt-1', 'claude')).toBe('wt-1:claude');
      expect(buildCompositeKey('wt-2', 'codex')).toBe('wt-2:codex');
      expect(buildCompositeKey('my-worktree', 'gemini')).toBe('my-worktree:gemini');
    });

    it('should work with all valid CLI tool IDs', () => {
      expect(buildCompositeKey('wt-1', 'claude')).toBe('wt-1:claude');
      expect(buildCompositeKey('wt-1', 'codex')).toBe('wt-1:codex');
      expect(buildCompositeKey('wt-1', 'gemini')).toBe('wt-1:gemini');
      expect(buildCompositeKey('wt-1', 'vibe-local')).toBe('wt-1:vibe-local');
      expect(buildCompositeKey('wt-1', 'opencode')).toBe('wt-1:opencode');
    });

    it('should throw if worktreeId contains the separator [SEC4-SF-004]', () => {
      expect(() => buildCompositeKey('wt:invalid', 'claude')).toThrow(
        /worktreeId must not contain/
      );
    });
  });

  describe('extractWorktreeId', () => {
    it('should extract worktreeId from a valid composite key', () => {
      expect(extractWorktreeId('wt-1:claude')).toBe('wt-1');
      expect(extractWorktreeId('my-worktree:codex')).toBe('my-worktree');
    });

    it('should handle worktreeId with hyphens and underscores', () => {
      expect(extractWorktreeId('feature-branch_123:gemini')).toBe('feature-branch_123');
    });

    it('should return the full string if no separator found (fallback)', () => {
      expect(extractWorktreeId('no-separator')).toBe('no-separator');
    });

    it('should use lastIndexOf to handle edge cases', () => {
      // cliToolId "vibe-local" does not contain ':', so lastIndexOf is correct
      expect(extractWorktreeId('wt-1:vibe-local')).toBe('wt-1');
    });
  });

  describe('extractCliToolId', () => {
    it('should extract cliToolId from a valid composite key', () => {
      expect(extractCliToolId('wt-1:claude')).toBe('claude');
      expect(extractCliToolId('wt-1:codex')).toBe('codex');
      expect(extractCliToolId('wt-1:gemini')).toBe('gemini');
      expect(extractCliToolId('wt-1:vibe-local')).toBe('vibe-local');
      expect(extractCliToolId('wt-1:opencode')).toBe('opencode');
    });

    it('should return null if no separator found', () => {
      expect(extractCliToolId('no-separator')).toBeNull();
    });

    it('should return null for invalid cliToolId after separator', () => {
      expect(extractCliToolId('wt-1:invalid-tool')).toBeNull();
      expect(extractCliToolId('wt-1:')).toBeNull();
    });
  });

  describe('roundtrip consistency', () => {
    it('should reconstruct composite key from extracted parts', () => {
      const original = buildCompositeKey('my-wt', 'claude');
      const worktreeId = extractWorktreeId(original);
      const cliToolId = extractCliToolId(original);
      expect(cliToolId).not.toBeNull();
      expect(buildCompositeKey(worktreeId, cliToolId!)).toBe(original);
    });
  });
});
