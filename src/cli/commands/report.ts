/**
 * report Command - Generate, show, and list daily reports
 * Issue #636: CLI report generate/show/list
 * Issue #1551: report metrics (Eval metrics)
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type {
  ReportGenerateOptions,
  ReportShowOptions,
  ReportListOptions,
  ReportMetricsOptions,
} from '../types';
import type {
  DailySummaryGetResponse,
  DailySummaryGenerateResponse,
  TemplateResponse,
  VibeMetrics,
  VibeMetricsResponse,
} from '../types/api-responses';
import { ApiClient } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { createSpinner } from '../utils/spinner';

/** Allowed tool values for report generation */
const ALLOWED_TOOLS = ['claude', 'codex', 'copilot', 'antigravity'] as const;

/** Validate YYYY-MM-DD date format (client-side) */
function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + 'T00:00:00');
  if (isNaN(parsed.getTime())) return false;
  const [y, m, d] = date.split('-').map(Number);
  return parsed.getFullYear() === y && parsed.getMonth() + 1 === m && parsed.getDate() === d;
}

/** Get today's date in YYYY-MM-DD format */
function getTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Get a date N days ago in YYYY-MM-DD format */
function getDateDaysAgo(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Longest metrics window the API accepts. Mirrors MAX_METRICS_DAYS. */
const MAX_METRICS_DAYS = 90;

/**
 * A 0..1 rate as a percentage, or `n/a`.
 *
 * `n/a` rather than `0.0%`: a null rate means the denominator was zero, and
 * printing "0.0%" for "nothing happened" reports a catastrophe that did not
 * occur.
 */
function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatVibeMetrics(m: VibeMetrics): string {
  const { tasks, verification, intervention } = m;

  const topFails = verification.gateFailBreakdown
    .map((g) => `${g.gateId} x${g.failCount}`)
    .join(', ');
  const topFailsSuffix = topFails ? `  (top fails: ${topFails})` : '';

  return [
    `Vibe Metrics (last ${m.periodDays} days)`,
    `Tasks:        ${tasks.total} total / ${tasks.succeeded} succeeded / ${tasks.failed} failed / ${tasks.notStarted} not-started  (success ${formatRate(tasks.successRate)})`,
    `Verification: ${verification.runs} runs, pass ${formatRate(verification.passRate)}${topFailsSuffix}`,
    `Intervention: ${intervention.humanResponds} human responds / ${intervention.autoAnswered} auto answered`,
    `Retry loops:  ${tasks.avgRetryLoops === null ? 'n/a' : `avg ${tasks.avgRetryLoops.toFixed(1)}`} per failed task`,
  ].join('\n');
}

export function createReportCommand(): Command {
  const cmd = new Command('report');
  cmd.description('Generate, show, and list daily reports');

  // ---- report generate ----
  cmd
    .command('generate')
    .description('Generate a daily report')
    .option('--date <date>', 'Target date (YYYY-MM-DD, default: today)')
    .option('--tool <tool>', 'AI tool to use (claude, codex, copilot, antigravity)', 'claude')
    .option('--model <model>', 'Model name (for copilot)')
    .option('--template <id>', 'Template ID to use as instruction')
    .option('--instruction <text>', 'Custom instruction text')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: ReportGenerateOptions) => {
      try {
        const date = options.date || getTodayDate();

        if (!isValidDate(date)) {
          console.error('Error: Invalid date format. Expected YYYY-MM-DD.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        if (!ALLOWED_TOOLS.includes(options.tool as typeof ALLOWED_TOOLS[number])) {
          console.error(`Error: Invalid tool. Must be one of: ${ALLOWED_TOOLS.join(', ')}`);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });

        // Resolve userInstruction from --template or --instruction
        let userInstruction: string | undefined = options.instruction;
        if (options.template) {
          const template = await client.get<TemplateResponse>(`/api/templates/${encodeURIComponent(options.template)}`);
          userInstruction = template.content;
        }

        const body: Record<string, unknown> = {
          date,
          tool: options.tool || 'claude',
        };
        if (options.model) body.model = options.model;
        if (userInstruction) body.userInstruction = userInstruction;

        const spinner = createSpinner(`Generating report for ${date}...`);
        spinner.start();
        try {
          const result = await client.post<DailySummaryGenerateResponse>('/api/daily-summary', body);
          spinner.succeed(`Report generated for ${date}`);
          console.log(result.report.content);
        } catch (error) {
          spinner.fail(`Report generation failed for ${date}`);
          throw error;
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  // ---- report show ----
  cmd
    .command('show')
    .description('Show a daily report')
    .option('--date <date>', 'Target date (YYYY-MM-DD, default: today)')
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: ReportShowOptions) => {
      try {
        const date = options.date || getTodayDate();

        if (!isValidDate(date)) {
          console.error('Error: Invalid date format. Expected YYYY-MM-DD.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });
        const data = await client.get<DailySummaryGetResponse>(
          `/api/daily-summary?date=${encodeURIComponent(date)}`
        );

        if (!data.report) {
          console.error(`No report found for ${date}.`);
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(data.report.content);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  // ---- report list ----
  cmd
    .command('list')
    .description('List recent daily reports')
    .option('--days <days>', 'Number of days to list (default: 7)', parseInt)
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: ReportListOptions) => {
      try {
        const days = options.days ?? 7;

        if (days < 1) {
          console.error('Error: --days must be at least 1.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });

        const results: Array<{ date: string; hasReport: boolean; messageCount: number; tool?: string }> = [];

        for (let i = 0; i < days; i++) {
          const date = getDateDaysAgo(i);
          const data = await client.get<DailySummaryGetResponse>(
            `/api/daily-summary?date=${encodeURIComponent(date)}`
          );
          results.push({
            date,
            hasReport: data.report !== null,
            messageCount: data.messageCount,
            tool: data.report?.generatedByTool,
          });
        }

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          for (const entry of results) {
            const status = entry.hasReport ? `[report] tool=${entry.tool}` : '[no report]';
            console.log(`${entry.date}  ${status}  messages=${entry.messageCount}`);
          }
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  // ---- report metrics ----
  cmd
    .command('metrics')
    .description('Show Eval metrics (task success rate, human interventions)')
    .option('--days <days>', 'Window length in days (default: 7)', parseInt)
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: ReportMetricsOptions) => {
      try {
        const days = options.days ?? 7;

        if (!Number.isInteger(days) || days < 1 || days > MAX_METRICS_DAYS) {
          console.error(`Error: --days must be an integer between 1 and ${MAX_METRICS_DAYS}.`);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });
        const data = await client.get<VibeMetricsResponse>(
          `/api/metrics/vibe?days=${encodeURIComponent(String(days))}`
        );

        if (options.json) {
          console.log(JSON.stringify(data.metrics, null, 2));
        } else {
          console.log(formatVibeMetrics(data.metrics));
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  return cmd;
}
