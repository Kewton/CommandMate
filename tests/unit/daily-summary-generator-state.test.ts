/**
 * Unit tests for getGeneratingState() and extended GeneratingState
 * Issue #638: Report generation status visibility
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger to avoid side effects
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock heavy dependencies that daily-summary-generator imports
vi.mock('@/lib/session/claude-executor', () => ({
  executeClaudeCommand: vi.fn(),
  MAX_MESSAGE_LENGTH: 10000,
}));
vi.mock('@/lib/summary-prompt-builder', () => ({
  buildSummaryPrompt: vi.fn(),
}));
vi.mock('@/config/schedule-config', () => ({
  DEFAULT_PERMISSIONS: { claude: 'default', codex: 'workspace-write', copilot: 'default' },
}));
vi.mock('@/lib/db/chat-db', () => ({
  getMessagesByDateRange: vi.fn(),
}));
vi.mock('@/lib/db/daily-report-db', () => ({
  saveDailyReport: vi.fn(),
}));
vi.mock('@/lib/db/worktree-db', () => ({
  getWorktrees: vi.fn(),
}));
vi.mock('@/lib/db/db-repository', () => ({
  getAllRepositories: vi.fn(),
}));
vi.mock('@/lib/git/git-utils', () => ({
  collectRepositoryCommitLogs: vi.fn(),
}));
vi.mock('@/lib/git/github-api', () => ({
  collectIssueInfos: vi.fn(),
}));
vi.mock('@/lib/utils', () => ({
  withTimeout: vi.fn(),
}));

import { isGenerating, getGeneratingState } from '@/lib/daily-summary-generator';

describe('getGeneratingState', () => {
  beforeEach(() => {
    globalThis.__dailySummaryGenerating = undefined;
  });

  afterEach(() => {
    globalThis.__dailySummaryGenerating = undefined;
  });

  it('should return null when no generation is in progress', () => {
    const state = getGeneratingState();
    expect(state).toBeNull();
  });

  it('should return null when flag is inactive', () => {
    globalThis.__dailySummaryGenerating = { active: false, startedAt: Date.now(), date: '2026-04-05', tool: 'claude' };
    const state = getGeneratingState();
    expect(state).toBeNull();
  });

  it('should return state when generation is active', () => {
    const startedAt = Date.now();
    globalThis.__dailySummaryGenerating = {
      active: true,
      startedAt,
      date: '2026-04-05',
      tool: 'claude',
    };

    const state = getGeneratingState();
    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(state!.date).toBe('2026-04-05');
    expect(state!.tool).toBe('claude');
    expect(state!.startedAt).toBe(startedAt);
  });

  it('should return null when failsafe timeout exceeded', () => {
    // Set startedAt to long ago (> timeout + margin)
    globalThis.__dailySummaryGenerating = {
      active: true,
      startedAt: Date.now() - 200_000, // well past timeout+margin
      date: '2026-04-05',
      tool: 'claude',
    };

    // isGenerating() should handle the failsafe and clear the flag
    const generating = isGenerating();
    expect(generating).toBe(false);

    const state = getGeneratingState();
    expect(state).toBeNull();
  });
});
