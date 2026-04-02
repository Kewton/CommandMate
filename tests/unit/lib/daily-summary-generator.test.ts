/**
 * Tests for daily-summary-generator.ts
 * Issue #607: AI summary generation with concurrent execution control
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Mock review-config
vi.mock('@/config/review-config', () => ({
  SUMMARY_GENERATION_TIMEOUT_MS: 60000,
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
        'default',
        { timeoutMs: 60000, model: 'gpt-4o' }
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
        'Focus on testing'
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
        undefined
      );
    });
  });
});
