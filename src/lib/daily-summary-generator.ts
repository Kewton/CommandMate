/**
 * Daily Summary Generator
 * Generates AI-powered daily summary reports from chat messages.
 *
 * Issue #607: Daily summary feature
 *
 * Features:
 * - Concurrent execution control via globalThis flag (DR4-004)
 * - Failsafe auto-reset for stuck flags
 * - Configurable timeout via executeClaudeCommand
 * - Output validation (min/max length)
 * - Output sanitization (control character removal)
 */

import type Database from 'better-sqlite3';
import { createLogger } from '@/lib/logger';
import { executeClaudeCommand, MAX_MESSAGE_LENGTH } from '@/lib/session/claude-executor';
import { buildSummaryPrompt } from '@/lib/summary-prompt-builder';
import { DEFAULT_PERMISSIONS } from '@/config/schedule-config';
import { getMessagesByDateRange } from '@/lib/db/chat-db';
import { saveDailyReport } from '@/lib/db/daily-report-db';
import { getWorktrees } from '@/lib/db/worktree-db';
import { getAllRepositories } from '@/lib/db/db-repository';
import type { DailyReport } from '@/lib/db/daily-report-db';
import { SUMMARY_GENERATION_TIMEOUT_MS, GIT_LOG_TOTAL_TIMEOUT_MS, ISSUE_FETCH_TOTAL_TIMEOUT_MS } from '@/config/review-config';
import { collectRepositoryCommitLogs } from '@/lib/git/git-utils';
import { collectIssueInfos } from '@/lib/git/github-api';
import { withTimeout } from '@/lib/utils';

const logger = createLogger('daily-summary');

// =============================================================================
// Constants
// =============================================================================

/** Maximum allowed output length from AI generation */
export const MAX_SUMMARY_OUTPUT_LENGTH = MAX_MESSAGE_LENGTH * 2;

/** Minimum required output length from AI generation */
export const MIN_SUMMARY_OUTPUT_LENGTH = 50;

/** Failsafe margin: auto-reset flag after timeout + this margin */
const FAILSAFE_MARGIN_MS = 10_000;

// =============================================================================
// Concurrent Execution Control (DR4-004)
// =============================================================================

interface GeneratingState {
  active: boolean;
  startedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __dailySummaryGenerating: GeneratingState | undefined;
}

/**
 * Check if a summary generation is currently in progress.
 * Includes failsafe auto-reset for stuck flags.
 */
export function isGenerating(): boolean {
  const state = globalThis.__dailySummaryGenerating;
  if (!state?.active) return false;

  // Failsafe: auto-reset if timeout exceeded
  if (Date.now() - state.startedAt > SUMMARY_GENERATION_TIMEOUT_MS + FAILSAFE_MARGIN_MS) {
    logger.warn('failsafe-reset', { startedAt: state.startedAt });
    globalThis.__dailySummaryGenerating = undefined;
    return false;
  }

  return true;
}

// =============================================================================
// Error Types
// =============================================================================

/** Error thrown when a concurrent generation request is detected */
export class ConcurrentGenerationError extends Error {
  constructor() {
    super('Summary generation is already in progress');
    this.name = 'ConcurrentGenerationError';
  }
}

/** Error thrown when generation times out */
export class GenerationTimeoutError extends Error {
  constructor() {
    super('Summary generation timed out');
    this.name = 'GenerationTimeoutError';
  }
}

/** Error thrown when output validation fails */
export class OutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputValidationError';
  }
}

// =============================================================================
// Generator
// =============================================================================

/** Parameters for generateDailySummary */
export interface GenerateDailySummaryParams {
  date: string;
  tool: string;
  model?: string;
  /** Optional user instruction for summary customization (Issue #612) */
  userInstruction?: string;
}

/**
 * Generate a daily summary report using AI.
 *
 * @param db - Database instance
 * @param params - Generation parameters
 * @returns Generated DailyReport
 * @throws ConcurrentGenerationError if another generation is in progress
 * @throws GenerationTimeoutError if AI execution times out
 * @throws OutputValidationError if output is too short or too long
 */
export async function generateDailySummary(
  db: Database.Database,
  params: GenerateDailySummaryParams
): Promise<DailyReport> {
  const { date, tool, model, userInstruction } = params;

  // Concurrent execution check
  if (isGenerating()) {
    logger.warn('concurrent-rejected', { date });
    throw new ConcurrentGenerationError();
  }

  // Set generating flag
  globalThis.__dailySummaryGenerating = { active: true, startedAt: Date.now() };

  try {
    logger.info('generation-started', { date, tool });

    // 1. Get messages for the date
    const dayStart = new Date(date + 'T00:00:00');
    const dayEnd = new Date(date + 'T23:59:59.999');
    const messages = getMessagesByDateRange(db, { after: dayStart, before: dayEnd });

    if (messages.length === 0) {
      throw new OutputValidationError('No messages found for the specified date');
    }

    // 2. Build worktree map for branch names
    const allWorktrees = getWorktrees(db);
    const worktreeMap = new Map<string, string>();
    for (const wt of allWorktrees) {
      worktreeMap.set(wt.id, wt.name);
    }

    // 3. Collect commit logs from all repositories (Issue #627)
    const repositories = getAllRepositories(db);
    const since = dayStart.toISOString();
    const until = dayEnd.toISOString();
    const commitLogs = await withTimeout(
      collectRepositoryCommitLogs(repositories, since, until),
      GIT_LOG_TOTAL_TIMEOUT_MS,
      new Map()
    );

    // 3.5. Collect Issue information from commit messages (Issue #630)
    const commitMessages = Array.from(commitLogs.values()).flatMap(
      ({ commits }) => commits.map((c: { message: string }) => c.message)
    );
    const issueInfos = await withTimeout(
      collectIssueInfos(repositories, commitMessages).catch(() => []),
      ISSUE_FETCH_TOTAL_TIMEOUT_MS,
      []
    );

    // 4. Build prompt
    const prompt = buildSummaryPrompt(messages, worktreeMap, userInstruction, commitLogs, issueInfos);

    // 5. Execute AI command
    // Issue #626: Use tool-specific default permission (e.g. codex: 'workspace-write')
    const permission = DEFAULT_PERMISSIONS[tool] || 'default';
    const result = await executeClaudeCommand(
      prompt,
      process.cwd(),
      tool,
      permission,
      { timeoutMs: SUMMARY_GENERATION_TIMEOUT_MS, model }
    );

    if (result.status === 'timeout') {
      logger.error('generation-timeout', { date, tool });
      throw new GenerationTimeoutError();
    }

    if (result.status === 'failed') {
      logger.error('generation-failed', { date, tool, error: result.error });
      throw new Error(`Summary generation failed: ${result.error}`);
    }

    // 6. Validate and sanitize output
    let output = result.output.trim();

    // Remove control characters (same pattern as sanitizeMessage)
    output = output.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

    if (output.length < MIN_SUMMARY_OUTPUT_LENGTH) {
      throw new OutputValidationError(
        `Generated summary is too short (${output.length} chars, minimum: ${MIN_SUMMARY_OUTPUT_LENGTH})`
      );
    }

    if (output.length > MAX_SUMMARY_OUTPUT_LENGTH) {
      output = output.slice(0, MAX_SUMMARY_OUTPUT_LENGTH);
    }

    // 7. Save to database
    const report = saveDailyReport(db, {
      date,
      content: output,
      generatedByTool: tool,
      model: model ?? null,
    });

    const durationMs = Date.now() - globalThis.__dailySummaryGenerating!.startedAt;
    logger.info('generation-completed', { date, tool, durationMs });

    return report;
  } finally {
    // Always clear the flag (DR4-004)
    globalThis.__dailySummaryGenerating = undefined;
  }
}
