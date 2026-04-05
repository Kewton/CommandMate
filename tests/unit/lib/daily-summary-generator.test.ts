/**
 * Tests for daily-summary-generator.ts
 * Issue #607: AI summary generation with concurrent execution control
 * Issue #632: Filter invalid repositories before commit log collection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs (for existsSync) - Issue #632
const mockExistsSync = vi.fn();
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// Mock path (for join) - Issue #632
vi.mock('path', () => ({
  join: (...args: string[]) => args.join('/'),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

// Mock claude-executor
const mockExecuteClaudeCommand = vi.fn();
vi.mock('@/lib/session/claude-executor', () => ({
  executeClaudeCommand: (...args: unknown[]) => mockExecuteClaudeCommand(...args),
  MAX_MESSAGE_LENGTH: 10000,
}));

// Mock chat-db
const mockGetMessagesByDateRange = vi.fn();
vi.mock('@/lib/db/chat-db', () => ({
  getMessagesByDateRange: (...args: unknown[]) => mockGetMessagesByDateRange(...args),
}));

// Mock daily-report-db
const mockSaveDailyReport = vi.fn();
vi.mock('@/lib/db/daily-report-db', () => ({
  saveDailyReport: (...args: unknown[]) => mockSaveDailyReport(...args),
}));

// Mock worktree-db
const mockGetWorktrees = vi.fn();
vi.mock('@/lib/db/worktree-db', () => ({
  getWorktrees: (...args: unknown[]) => mockGetWorktrees(...args),
}));

// Mock db-repository
const mockGetAllRepositories = vi.fn();
vi.mock('@/lib/db/db-repository', () => ({
  getAllRepositories: (...args: unknown[]) => mockGetAllRepositories(...args),
}));

// Mock git-utils
const mockCollectRepositoryCommitLogs = vi.fn();
vi.mock('@/lib/git/git-utils', () => ({
  collectRepositoryCommitLogs: (...args: unknown[]) => mockCollectRepositoryCommitLogs(...args),
}));

// Mock github-api
const mockCollectIssueInfos = vi.fn();
vi.mock('@/lib/git/github-api', () => ({
  collectIssueInfos: (...args: unknown[]) => mockCollectIssueInfos(...args),
}));

// Mock utils (withTimeout)
vi.mock('@/lib/utils', async () => {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withTimeout: (promise: Promise<any>) => promise,
    TimeoutError: class TimeoutError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'TimeoutError';
      }
    },
  };
});

// Mock review-config
vi.mock('@/config/review-config', () => ({
  SUMMARY_GENERATION_TIMEOUT_MS: 60000,
  GIT_LOG_TOTAL_TIMEOUT_MS: 15000,
  ISSUE_FETCH_TOTAL_TIMEOUT_MS: 15000,
}));

// Mock schedule-config (DEFAULT_PERMISSIONS)
vi.mock('@/config/schedule-config', () => ({
  DEFAULT_PERMISSIONS: {
    claude: 'acceptEdits',
    codex: 'workspace-write',
    gemini: '',
    'vibe-local': '',
    copilot: 'allow-all-tools',
  },
}));

// Mock summary-prompt-builder
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockBuildSummaryPrompt = vi.fn((..._args: any[]) => 'mock prompt');
vi.mock('@/lib/summary-prompt-builder', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildSummaryPrompt: (...args: any[]) => mockBuildSummaryPrompt(...args),
}));

import {
  generateDailySummary,
  isGenerating,
  ConcurrentGenerationError,
  GenerationTimeoutError,
  OutputValidationError,
  MIN_SUMMARY_OUTPUT_LENGTH,
} from '@/lib/daily-summary-generator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDb = {} as any;

describe('daily-summary-generator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.__dailySummaryGenerating = undefined;

    mockGetWorktrees.mockReturnValue([
      { id: 'wt-1', name: 'feature/test' },
    ]);
    mockGetAllRepositories.mockReturnValue([
      { id: 'repo-1', name: 'MyRepo', path: '/repos/myrepo', enabled: true },
    ]);
    mockCollectRepositoryCommitLogs.mockResolvedValue(new Map());
    mockCollectIssueInfos.mockResolvedValue([]);
    // Default: all paths exist (Issue #632)
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    globalThis.__dailySummaryGenerating = undefined;
  });

  describe('isGenerating', () => {
    it('should return false when no generation in progress', () => {
      expect(isGenerating()).toBe(false);
    });

    it('should return true when generation is active', () => {
      globalThis.__dailySummaryGenerating = { active: true, startedAt: Date.now() };
      expect(isGenerating()).toBe(true);
    });

    it('should auto-reset after failsafe timeout', () => {
      // Set started 70+ seconds ago (timeout 60s + margin 10s)
      globalThis.__dailySummaryGenerating = {
        active: true,
        startedAt: Date.now() - 71_000,
      };
      expect(isGenerating()).toBe(false);
      expect(globalThis.__dailySummaryGenerating).toBeUndefined();
    });
  });

  describe('generateDailySummary', () => {
    it('should throw ConcurrentGenerationError when already generating', async () => {
      globalThis.__dailySummaryGenerating = { active: true, startedAt: Date.now() };

      await expect(
        generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' })
      ).rejects.toThrow(ConcurrentGenerationError);
    });

    it('should throw OutputValidationError when no messages found', async () => {
      mockGetMessagesByDateRange.mockReturnValue([]);

      await expect(
        generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' })
      ).rejects.toThrow(OutputValidationError);
    });

    it('should throw GenerationTimeoutError when AI times out', async () => {
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: '',
        exitCode: null,
        status: 'timeout',
      });

      await expect(
        generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' })
      ).rejects.toThrow(GenerationTimeoutError);
    });

    it('should throw Error when AI execution fails', async () => {
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: '',
        exitCode: 1,
        status: 'failed',
        error: 'command not found',
      });

      await expect(
        generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' })
      ).rejects.toThrow('Summary generation failed');
    });

    it('should throw OutputValidationError when output is too short', async () => {
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: 'too short',
        exitCode: 0,
        status: 'completed',
      });

      await expect(
        generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' })
      ).rejects.toThrow('too short');
    });

    it('should generate and save report successfully', async () => {
      const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      const mockReport = {
        date: '2026-04-02',
        content: validOutput,
        generatedByTool: 'claude',
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockSaveDailyReport.mockReturnValue(mockReport);

      const result = await generateDailySummary(mockDb, {
        date: '2026-04-02',
        tool: 'claude',
      });

      expect(result).toEqual(mockReport);
      expect(mockSaveDailyReport).toHaveBeenCalledWith(mockDb, {
        date: '2026-04-02',
        content: validOutput,
        generatedByTool: 'claude',
        model: null,
      });
    });

    it('should pass model for copilot', async () => {
      const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      mockSaveDailyReport.mockReturnValue({
        date: '2026-04-02',
        content: validOutput,
        generatedByTool: 'copilot',
        model: 'gpt-4o',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await generateDailySummary(mockDb, {
        date: '2026-04-02',
        tool: 'copilot',
        model: 'gpt-4o',
      });

      expect(mockExecuteClaudeCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'copilot',
        'allow-all-tools',
        { timeoutMs: 60000, model: 'gpt-4o' }
      );
    });

    it('should pass workspace-write permission for codex (Issue #626)', async () => {
      const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      mockSaveDailyReport.mockReturnValue({
        date: '2026-04-02',
        content: validOutput,
        generatedByTool: 'codex',
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await generateDailySummary(mockDb, {
        date: '2026-04-02',
        tool: 'codex',
      });

      expect(mockExecuteClaudeCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'codex',
        'workspace-write',
        { timeoutMs: 60000, model: undefined }
      );
    });

    it('should pass acceptEdits permission for claude (Issue #626)', async () => {
      const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      mockSaveDailyReport.mockReturnValue({
        date: '2026-04-02',
        content: validOutput,
        generatedByTool: 'claude',
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await generateDailySummary(mockDb, {
        date: '2026-04-02',
        tool: 'claude',
      });

      expect(mockExecuteClaudeCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'claude',
        'acceptEdits',
        { timeoutMs: 60000, model: undefined }
      );
    });

    it('should clear generating flag after success', async () => {
      const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      mockSaveDailyReport.mockReturnValue({
        date: '2026-04-02',
        content: validOutput,
        generatedByTool: 'claude',
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' });

      expect(globalThis.__dailySummaryGenerating).toBeUndefined();
    });

    it('should clear generating flag after error', async () => {
      mockGetMessagesByDateRange.mockReturnValue([]);

      try {
        await generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' });
      } catch {
        // expected
      }

      expect(globalThis.__dailySummaryGenerating).toBeUndefined();
    });

    it('should propagate userInstruction to buildSummaryPrompt (Issue #612)', async () => {
      const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      mockSaveDailyReport.mockReturnValue({
        date: '2026-04-02',
        content: validOutput,
        generatedByTool: 'claude',
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await generateDailySummary(mockDb, {
        date: '2026-04-02',
        tool: 'claude',
        userInstruction: 'Focus on testing',
      });

      expect(mockBuildSummaryPrompt).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Map),
        'Focus on testing',
        expect.any(Map),
        expect.any(Array)
      );
    });

    it('should propagate commitLogs to buildSummaryPrompt (Issue #627)', async () => {
      const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      mockSaveDailyReport.mockReturnValue({
        date: '2026-04-02',
        content: validOutput,
        generatedByTool: 'claude',
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const mockCommitLogs = new Map([
        ['repo-1', { name: 'MyRepo', commits: [{ shortHash: 'abc', message: 'fix', author: 'Dev' }] }],
      ]);
      mockCollectRepositoryCommitLogs.mockResolvedValue(mockCommitLogs);

      await generateDailySummary(mockDb, {
        date: '2026-04-02',
        tool: 'claude',
      });

      expect(mockCollectRepositoryCommitLogs).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(String),
        expect.any(String),
      );
      expect(mockBuildSummaryPrompt).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Map),
        undefined,
        mockCommitLogs,
        expect.any(Array)
      );
    });

    it('should NOT pass userInstruction to buildSummaryPrompt when undefined (Issue #612)', async () => {
      const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      mockSaveDailyReport.mockReturnValue({
        date: '2026-04-02',
        content: validOutput,
        generatedByTool: 'claude',
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await generateDailySummary(mockDb, {
        date: '2026-04-02',
        tool: 'claude',
      });

      expect(mockBuildSummaryPrompt).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Map),
        undefined,
        expect.any(Map),
        expect.any(Array)
      );
    });

    it('should propagate issueInfos to buildSummaryPrompt (Issue #630)', async () => {
      const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'fix #123', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      mockSaveDailyReport.mockReturnValue({
        date: '2026-04-05',
        content: validOutput,
        generatedByTool: 'claude',
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const mockIssueInfos = [
        {
          repositoryName: 'CommandMate',
          number: 123,
          title: 'Test Issue',
          labels: ['bug'],
          state: 'closed',
          bodySummary: 'Some body',
        },
      ];
      mockCollectIssueInfos.mockResolvedValue(mockIssueInfos);

      await generateDailySummary(mockDb, { date: '2026-04-05', tool: 'claude' });

      expect(mockCollectIssueInfos).toHaveBeenCalled();
      expect(mockBuildSummaryPrompt).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Map),
        undefined,
        expect.any(Map),
        mockIssueInfos
      );
    });

    it('should continue without issueInfos when collectIssueInfos fails (Issue #630)', async () => {
      const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      mockSaveDailyReport.mockReturnValue({
        date: '2026-04-05',
        content: validOutput,
        generatedByTool: 'claude',
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // collectIssueInfos fails → should gracefully degrade to empty array
      mockCollectIssueInfos.mockRejectedValue(new Error('gh CLI not available'));

      const result = await generateDailySummary(mockDb, { date: '2026-04-05', tool: 'claude' });

      expect(result).toBeDefined();
      expect(mockBuildSummaryPrompt).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Map),
        undefined,
        expect.any(Map),
        [] // graceful degradation: empty array
      );
    });
  });

  describe('repository filtering (Issue #632)', () => {
    const validOutput = 'x'.repeat(MIN_SUMMARY_OUTPUT_LENGTH + 10);

    /** Helper to set up mocks for a successful generation flow */
    function setupSuccessfulGeneration() {
      mockGetMessagesByDateRange.mockReturnValue([
        { id: 'msg-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp: new Date() },
      ]);
      mockExecuteClaudeCommand.mockResolvedValue({
        output: validOutput,
        exitCode: 0,
        status: 'completed',
      });
      mockSaveDailyReport.mockReturnValue({
        date: '2026-04-02',
        content: validOutput,
        generatedByTool: 'claude',
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    it('should exclude disabled repositories (enabled=false)', async () => {
      setupSuccessfulGeneration();
      mockGetAllRepositories.mockReturnValue([
        { id: 'repo-1', name: 'EnabledRepo', path: '/repos/enabled', enabled: true },
        { id: 'repo-2', name: 'DisabledRepo', path: '/repos/disabled', enabled: false },
      ]);
      mockExistsSync.mockReturnValue(true);

      await generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' });

      const passedRepos = mockCollectRepositoryCommitLogs.mock.calls[0][0];
      expect(passedRepos).toHaveLength(1);
      expect(passedRepos[0].name).toBe('EnabledRepo');
    });

    it('should exclude repositories with non-existent paths', async () => {
      setupSuccessfulGeneration();
      mockGetAllRepositories.mockReturnValue([
        { id: 'repo-1', name: 'ExistsRepo', path: '/repos/exists', enabled: true },
        { id: 'repo-2', name: 'MissingRepo', path: '/repos/missing', enabled: true },
      ]);
      mockExistsSync.mockImplementation((p: string) => {
        if (p === '/repos/missing') return false;
        return true;
      });

      await generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' });

      const passedRepos = mockCollectRepositoryCommitLogs.mock.calls[0][0];
      expect(passedRepos).toHaveLength(1);
      expect(passedRepos[0].name).toBe('ExistsRepo');
    });

    it('should exclude repositories without .git directory', async () => {
      setupSuccessfulGeneration();
      mockGetAllRepositories.mockReturnValue([
        { id: 'repo-1', name: 'GitRepo', path: '/repos/gitrepo', enabled: true },
        { id: 'repo-2', name: 'NoGitRepo', path: '/repos/nogit', enabled: true },
      ]);
      mockExistsSync.mockImplementation((p: string) => {
        if (p === '/repos/nogit/.git') return false;
        return true;
      });

      await generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' });

      const passedRepos = mockCollectRepositoryCommitLogs.mock.calls[0][0];
      expect(passedRepos).toHaveLength(1);
      expect(passedRepos[0].name).toBe('GitRepo');
    });

    it('should pass only valid repositories to collectRepositoryCommitLogs', async () => {
      setupSuccessfulGeneration();
      mockGetAllRepositories.mockReturnValue([
        { id: 'repo-1', name: 'ValidRepo', path: '/repos/valid', enabled: true },
        { id: 'repo-2', name: 'DisabledRepo', path: '/repos/disabled', enabled: false },
        { id: 'repo-3', name: 'MissingPathRepo', path: '/repos/missing', enabled: true },
        { id: 'repo-4', name: 'NoGitRepo', path: '/repos/nogit', enabled: true },
      ]);
      mockExistsSync.mockImplementation((p: string) => {
        if (p === '/repos/missing') return false;
        if (p === '/repos/nogit/.git') return false;
        return true;
      });

      await generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' });

      const passedRepos = mockCollectRepositoryCommitLogs.mock.calls[0][0];
      expect(passedRepos).toHaveLength(1);
      expect(passedRepos[0].name).toBe('ValidRepo');
    });

    it('should handle all repositories being invalid without error', async () => {
      setupSuccessfulGeneration();
      mockGetAllRepositories.mockReturnValue([
        { id: 'repo-1', name: 'DisabledRepo', path: '/repos/disabled', enabled: false },
        { id: 'repo-2', name: 'MissingRepo', path: '/repos/missing', enabled: true },
      ]);
      mockExistsSync.mockImplementation((p: string) => {
        if (p === '/repos/missing') return false;
        return true;
      });

      await generateDailySummary(mockDb, { date: '2026-04-02', tool: 'claude' });

      const passedRepos = mockCollectRepositoryCommitLogs.mock.calls[0][0];
      expect(passedRepos).toHaveLength(0);
    });
  });
});
