/**
 * Tests for composite key helper functions (Issue #525)
 * Phase 1: buildCompositeKey, extractWorktreeId, extractCliToolId
 * Issue #896: per-instance keys (3-part) + extractInstanceId
 */

import { describe, it, expect } from 'vitest';
import {
  buildCompositeKey,
  extractWorktreeId,
  extractCliToolId,
  extractInstanceId,
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

    // Issue #896: per-instance keys
    it('should keep the 2-part key for the primary instance (instanceId === cliToolId)', () => {
      expect(buildCompositeKey('wt-1', 'claude', 'claude')).toBe('wt-1:claude');
    });

    it('should keep the 2-part key when instanceId is omitted', () => {
      expect(buildCompositeKey('wt-1', 'claude')).toBe('wt-1:claude');
      expect(buildCompositeKey('wt-1', 'claude', undefined)).toBe('wt-1:claude');
    });

    it('should create a 3-part key for an alias instance (instanceId !== cliToolId)', () => {
      expect(buildCompositeKey('wt-1', 'claude', 'claude-2')).toBe('wt-1:claude:claude-2');
      expect(buildCompositeKey('wt-2', 'codex', 'codex-review')).toBe('wt-2:codex:codex-review');
    });

    it('should throw if instanceId contains the separator [SEC4-SF-004]', () => {
      expect(() => buildCompositeKey('wt-1', 'claude', 'bad:instance')).toThrow(
        /instanceId must not contain/
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

    it('should use the first segment so multi-part keys still resolve the worktreeId', () => {
      // worktreeId never contains ':', so the first segment is always the worktreeId
      expect(extractWorktreeId('wt-1:vibe-local')).toBe('wt-1');
      // Issue #896: 3-part alias key still extracts the worktreeId (not the cliToolId)
      expect(extractWorktreeId('wt-1:claude:claude-2')).toBe('wt-1');
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

    it('should extract cliToolId from a 3-part alias key (Issue #896)', () => {
      expect(extractCliToolId('wt-1:claude:claude-2')).toBe('claude');
      expect(extractCliToolId('wt-2:codex:codex-review')).toBe('codex');
    });
  });

  // Issue #896: extractInstanceId
  describe('extractInstanceId', () => {
    it('should return the alias instanceId from a 3-part key', () => {
      expect(extractInstanceId('wt-1:claude:claude-2')).toBe('claude-2');
      expect(extractInstanceId('wt-2:codex:codex-review')).toBe('codex-review');
    });

    it('should fall back to the cliToolId for a 2-part primary key', () => {
      expect(extractInstanceId('wt-1:claude')).toBe('claude');
      expect(extractInstanceId('wt-1:vibe-local')).toBe('vibe-local');
    });

    it('should return null when the key has no cliToolId segment', () => {
      expect(extractInstanceId('no-separator')).toBeNull();
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

    it('should reconstruct an alias composite key from extracted parts (Issue #896)', () => {
      const original = buildCompositeKey('my-wt', 'claude', 'claude-2');
      const worktreeId = extractWorktreeId(original);
      const cliToolId = extractCliToolId(original);
      const instanceId = extractInstanceId(original);
      expect(cliToolId).not.toBeNull();
      expect(buildCompositeKey(worktreeId, cliToolId!, instanceId!)).toBe(original);
    });
  });
});
