/**
 * Session Name Utility Tests
 * [Issue #163] Task-PRE-002: Session name generation unification
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect } from 'vitest';
import { getSessionNameUtil, isValidCliToolId } from '@/lib/session-name';

describe('getSessionNameUtil', () => {
  it('should generate session name with mcbd prefix', () => {
    expect(getSessionNameUtil('worktree-1', 'claude')).toBe('mcbd-claude-worktree-1');
  });

  it('should generate correct name for codex', () => {
    expect(getSessionNameUtil('worktree-1', 'codex')).toBe('mcbd-codex-worktree-1');
  });

  it('should generate correct name for gemini', () => {
    expect(getSessionNameUtil('worktree-1', 'gemini')).toBe('mcbd-gemini-worktree-1');
  });

  it('should handle numeric worktree IDs', () => {
    expect(getSessionNameUtil('123', 'claude')).toBe('mcbd-claude-123');
  });

  it('should handle worktree IDs with hyphens and underscores', () => {
    expect(getSessionNameUtil('my-worktree_1', 'claude')).toBe('mcbd-claude-my-worktree_1');
  });

  it('should throw on invalid worktree ID with shell special chars', () => {
    expect(() => getSessionNameUtil('; rm -rf /', 'claude')).toThrow();
  });

  it('should throw on worktree ID with double quotes', () => {
    expect(() => getSessionNameUtil('" ; echo hacked', 'claude')).toThrow();
  });

  it('should throw on worktree ID with backticks', () => {
    expect(() => getSessionNameUtil('`cmd`', 'claude')).toThrow();
  });

  it('should throw on worktree ID with dollar sign', () => {
    expect(() => getSessionNameUtil('$(cmd)', 'claude')).toThrow();
  });

  it('should throw on empty worktree ID', () => {
    expect(() => getSessionNameUtil('', 'claude')).toThrow();
  });

  it('should throw on worktree ID with spaces', () => {
    expect(() => getSessionNameUtil('has spaces', 'claude')).toThrow();
  });

  it('should throw on worktree ID with newline', () => {
    expect(() => getSessionNameUtil('line1\nline2', 'claude')).toThrow();
  });

  it('should throw on worktree ID with path traversal', () => {
    expect(() => getSessionNameUtil('../../../etc', 'claude')).toThrow();
  });
});

describe('isValidCliToolId', () => {
  it('should return true for valid CLI tool IDs', () => {
    expect(isValidCliToolId('claude')).toBe(true);
    expect(isValidCliToolId('codex')).toBe(true);
    expect(isValidCliToolId('gemini')).toBe(true);
  });

  it('should return false for invalid CLI tool IDs', () => {
    expect(isValidCliToolId('invalid')).toBe(false);
    expect(isValidCliToolId('')).toBe(false);
    expect(isValidCliToolId('CLAUDE')).toBe(false);
    expect(isValidCliToolId('Claude')).toBe(false);
  });

  it('should return false for injection attempts', () => {
    expect(isValidCliToolId('; rm -rf /')).toBe(false);
    expect(isValidCliToolId('claude; echo hacked')).toBe(false);
  });
});
