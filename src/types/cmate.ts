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
  /** Permission mode (claude: --permission-mode, codex: --sandbox) */
  permission: string;
  /** AI model name (copilot only, from CLI Tool column --model option) */
  model?: string;
}

/**
 * Result of parsing a CMATE.md file
 * Maps section names to arrays of row data (each row is an array of cell values)
 */
export type CmateConfig = Map<string, string[][]>;

/**
 * Input shape for writing a schedule row to CMATE.md.
 * Issue #824: Schedules UX Phase 1 — symmetric to ScheduleEntry, but `permission`
 * and `model` are optional because callers may omit them for tools that do not
 * support permission flags / model selection.
 */
export interface ScheduleWriteInput {
  /** Schedule name (validated by NAME_PATTERN) */
  name: string;
  /** Cron expression for scheduling */
  cronExpression: string;
  /** Message/prompt to send to the CLI tool */
  message: string;
  /** CLI tool to use (e.g. 'claude') */
  cliToolId: string;
  /** Whether the schedule is enabled */
  enabled: boolean;
  /** Permission mode (claude: --permission-mode, codex: --sandbox). Empty for tools without flags. */
  permission?: string;
  /** AI model name (copilot only, serialized into the CLI Tool column) */
  model?: string;
}
