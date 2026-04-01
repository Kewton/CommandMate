/**
 * Unit tests for worktrees API ?include=review extension
 * Issue #600: UX refresh - API extension for review screen
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

const mockWorktrees = [
  {
    id: 'wt-1',
    name: 'feature/one',
    status: 'done',
    cliToolId: 'claude',
    repositoryName: 'repo-1',
  },
  {
    id: 'wt-2',
    name: 'feature/two',
    status: 'doing',
    cliToolId: 'claude',
    repositoryName: 'repo-1',
  },
];

vi.mock('@/lib/db', () => ({
  getWorktrees: vi.fn(() => mockWorktrees),
  getRepositories: vi.fn(() => []),
  getMessages: vi.fn(() => []),
  markPendingPromptsAsAnswered: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux', () => ({
  listSessions: vi.fn(async () => []),
}));

vi.mock('@/lib/session/worktree-status-helper', () => ({
  detectWorktreeSessionStatus: vi.fn(async () => ({
    sessionStatusByCli: {},
    isSessionRunning: false,
    isWaitingForResponse: false,
    isProcessing: false,
  })),
}));

vi.mock('@/lib/detection/stalled-detector', () => ({
  isWorktreeStalled: vi.fn(() => false),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { parseIncludeParam, VALID_INCLUDE_VALUES } from '@/lib/api/worktrees-include-parser';

describe('worktrees API include=review', () => {
  describe('VALID_INCLUDE_VALUES', () => {
    it('should contain review as valid value', () => {
      expect(VALID_INCLUDE_VALUES).toContain('review');
    });
  });

  describe('parseIncludeParam', () => {
    it('should parse single valid value', () => {
      const result = parseIncludeParam('review');
      expect(result.has('review')).toBe(true);
    });

    it('should ignore invalid values silently', () => {
      const result = parseIncludeParam('invalid');
      expect(result.size).toBe(0);
    });

    it('should return empty set for null', () => {
      const result = parseIncludeParam(null);
      expect(result.size).toBe(0);
    });

    it('should return empty set for empty string', () => {
      const result = parseIncludeParam('');
      expect(result.size).toBe(0);
    });

    it('should parse comma-separated values and keep valid ones', () => {
      const result = parseIncludeParam('review,invalid,review');
      expect(result.has('review')).toBe(true);
      expect(result.size).toBe(1);
    });

    it('should handle XSS attempts silently', () => {
      const result = parseIncludeParam('<script>alert(1)</script>');
      expect(result.size).toBe(0);
    });
  });
});
