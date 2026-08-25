/**
 * Daily Summary Generator
 * Generates AI-powered daily summary reports from chat messages.
 *
 * Issue #607: Daily summary feature
 * Issue #2044: opencode joins SUMMARY_ALLOWED_TOOLS, and the report grows an
 *   agent cost section built from the `agent_session_costs` ledger.
 *
 * Features:
 * - Concurrent execution control via globalThis flag (DR4-004)
 * - Failsafe auto-reset for stuck flags
 * - Configurable timeout via executeClaudeCommand
 * - Output validation (min/max length)
 * - Output sanitization (control character removal)
 */

import { existsSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { createLogger } from '@/lib/logger';
import { executeClaudeCommand, MAX_MESSAGE_LENGTH } from '@/lib/session/claude-executor';
import { buildSummaryPrompt } from '@/lib/summary-prompt-builder';
import { DEFAULT_PERMISSIONS } from '@/config/schedule-config';
import { getMessagesByDateRange } from '@/lib/db/chat-db';
import { saveDailyReport } from '@/lib/db/daily-report-db';
import { getWorktrees } from '@/lib/db/worktree-db';
import { getDailyAgentCostSummary, type DailyAgentCostSummary } from '@/lib/db/agent-session-cost-db';
import { sampleAgentSessionCosts } from '@/lib/db/agent-session-cost-sampler';
import { getAllRepositories } from '@/lib/db/db-repository';
import type { DailyReport } from '@/lib/db/daily-report-db';
import { SUMMARY_GENERATION_TIMEOUT_MS, GIT_LOG_TOTAL_TIMEOUT_MS, ISSUE_FETCH_TOTAL_TIMEOUT_MS } from '@/config/review-config';
import { collectRepositoryCommitLogs } from '@/lib/git/git-utils';
import { collectIssueInfos } from '@/lib/git/github-api';
import { computeVibeMetrics, MS_PER_DAY } from '@/lib/metrics/vibe-metrics';
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
  /** Target date for generation (Issue #638) */
  date?: string;
  /** AI tool used for generation (Issue #638) */
  tool?: string;
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

/**
 * Get the current generating state if active.
 * Returns null if no generation is in progress (or flag was failsafe-reset).
 * Issue #638: Expose generation state for status endpoint.
 */
export function getGeneratingState(): GeneratingState | null {
  if (!isGenerating()) return null;
  return globalThis.__dailySummaryGenerating ?? null;
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
// Agent cost section (Issue #2044)
// =============================================================================

/** Heading the appended cost section always starts with. */
export const AGENT_COST_SECTION_HEADING = '## Agent session cost';

/**
 * A number for the table, or `-` when nobody reported one.
 *
 * `-` and `0` mean different things here and the distinction is the reason the
 * whole ledger keeps nulls: `0` is "this session spent nothing", `-` is "the
 * agent never said what it spent". Printing `0` for both would make a broken
 * telemetry stream look like a free day.
 */
function formatLedgerNumber(value: number | null, fractionDigits = 0): string {
  if (value === null) return '-';
  return fractionDigits > 0 ? value.toFixed(fractionDigits) : String(value);
}

/**
 * Render the day's agent spend as a Markdown table, or `null` when the ledger
 * is empty for that day.
 *
 * ## Why this is not in the prompt
 *
 * These are exact numbers meant to be *reconciled* against
 * `opencode stats --project <path>`, and an LLM asked to include them in prose
 * will round, re-order, or summarise them — at which point they no longer
 * reconcile and the section is worse than absent. So the model never sees them:
 * the section is appended to the generated text, deterministically, after
 * generation. That also makes it **additive** in the strict sense the Issue
 * asks for — `buildSummaryPrompt()` is byte-identical to what it produced
 * before, so `claude` and `codex` generate exactly the text they used to.
 *
 * ## The correspondence with `opencode stats`
 *
 * Measured on opencode 1.18.22 (`docs/design/opencode-server-live-verification.md`
 * §15): summing each session's cumulative `cost` / `tokens` reproduces
 * `opencode stats --project ""`'s Total Cost, Input, Output, Cache Read and
 * Cache Write for the same project. The per-worktree row is therefore the
 * `--project <worktree path>` figure and the total row is the all-projects one,
 * restricted to a single day — which is what `stats --days 1` reports.
 *
 * The cost column carries six decimals because a single opencode step costs
 * ~0.003 and two decimals would print `0.00` for a real charge.
 *
 * @param summary - Ledger rollup for the day
 * @param worktreeNames - worktree id -> display name, for legibility
 * @returns Markdown section, or null when there is nothing to report
 */
export function buildAgentCostSection(
  summary: DailyAgentCostSummary,
  worktreeNames: Map<string, string>
): string | null {
  if (summary.worktrees.length === 0) return null;

  const header = [
    '| Worktree | Sessions | Cost (USD) | Input | Output | Reasoning | Cache read | Cache write |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];

  const rows = summary.worktrees.map((row) => {
    const name = worktreeNames.get(row.worktreeId) ?? row.worktreeId;
    return `| ${name} | ${row.sessions} | ${formatLedgerNumber(row.cost, 6)} | ` +
      `${formatLedgerNumber(row.tokensInput)} | ${formatLedgerNumber(row.tokensOutput)} | ` +
      `${formatLedgerNumber(row.tokensReasoning)} | ${formatLedgerNumber(row.tokensCacheRead)} | ` +
      `${formatLedgerNumber(row.tokensCacheWrite)} |`;
  });

  const total = summary.total;
  const totalRow =
    `| **Total** | ${total.sessions} | ${formatLedgerNumber(total.cost, 6)} | ` +
    `${formatLedgerNumber(total.tokensInput)} | ${formatLedgerNumber(total.tokensOutput)} | ` +
    `${formatLedgerNumber(total.tokensReasoning)} | ${formatLedgerNumber(total.tokensCacheRead)} | ` +
    `${formatLedgerNumber(total.tokensCacheWrite)} |`;

  return [
    `${AGENT_COST_SECTION_HEADING} (${summary.date})`,
    '',
    ...header,
    ...rows,
    totalRow,
    '',
    '_Cross-check: `opencode stats --project <worktree path> --days 1`. Figures are the agent\'s own cumulative per-session totals; `-` means the agent reported no value._',
  ].join('\n');
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

  // Set generating flag (Issue #638: include date/tool for status endpoint)
  globalThis.__dailySummaryGenerating = { active: true, startedAt: Date.now(), date, tool };

  try {
    logger.info('generation-started', { date, tool });

    // 0. Flush the in-memory agent telemetry into the ledger (Issue #2044).
    //
    // The background sampler has been doing this once a minute, but a session
    // that is alive right now may have moved since its last sample, and the
    // report is about to quote a number. Cheap and idempotent: the ledger is
    // keyed by the agent's own session id and writes overwrite, so an extra
    // sample changes nothing except the freshness of the row.
    try {
      sampleAgentSessionCosts(db);
    } catch (error) {
      // A failed sample must not fail the report: the section it feeds is
      // additive, and the alternative is losing the whole summary over a number.
      logger.warn('cost-sample-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

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

    // 3. Collect commit logs from valid repositories (Issue #627, #632)
    const allRepositories = getAllRepositories(db);
    const repositories = allRepositories.filter(repo => {
      if (!repo.enabled) return false;
      if (!existsSync(repo.path)) return false;
      if (!existsSync(join(repo.path, '.git'))) return false;
      return true;
    });

    if (repositories.length < allRepositories.length) {
      logger.info('repositories-filtered', {
        total: allRepositories.length,
        valid: repositories.length,
        skipped: allRepositories.length - repositories.length,
      });
    }
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

    // 3.6. Aggregate Eval metrics for the target day (Issue #1551).
    // The window is anchored to `date`, not to now, so a report generated for a
    // past date describes that date rather than the last 24 hours.
    const metrics = computeVibeMetrics(db, {
      days: 1,
      until: dayStart.getTime() + MS_PER_DAY,
    });

    // 4. Build prompt
    const prompt = buildSummaryPrompt(messages, worktreeMap, userInstruction, commitLogs, issueInfos, metrics);

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

    // 6.5. Append the agent cost section (Issue #2044).
    //
    // After generation and after truncation, so a long AI answer cannot push the
    // numbers out of the report, and so the section is byte-for-byte the ledger
    // rather than the model's recollection of it. `sampleAgentSessionCosts()`
    // ran before generation (step 0) to catch sessions still alive then; this
    // read includes whatever the background sampler collected earlier in the
    // day.
    //
    // Wrapped, like the sample above and for the same reason: this section is
    // *additive*. Losing a generated summary because a ledger query threw would
    // trade the feature that exists for the one being added.
    try {
      const costSummary = getDailyAgentCostSummary(db, date);
      const costSection = buildAgentCostSection(costSummary, worktreeMap);
      if (costSection) {
        output = `${output}\n\n${costSection}`;
      }
    } catch (error) {
      logger.warn('cost-section-failed', {
        date,
        error: error instanceof Error ? error.message : String(error),
      });
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
