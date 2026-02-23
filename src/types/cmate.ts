/**
 * CMATE.md related type definitions
 * Issue #294: Schedule execution feature
 */

/**
 * A single schedule entry parsed from CMATE.md Schedules section
 */
export interface ScheduleEntry {
  /** Schedule name (validated by NAME_PATTERN) */
  name: string;
  /** Cron expression for scheduling */
  cronExpression: string;
  /** Message/prompt to send to claude -p */
  message: string;
  /** CLI tool to use (default: 'claude') */
  cliToolId: string;
  /** Whether the schedule is enabled */
  enabled: boolean;
}

/**
 * Result of parsing a CMATE.md file
 * Maps section names to arrays of row data (each row is an array of cell values)
 */
export type CmateConfig = Map<string, string[][]>;
