/**
 * CMATE.md related type definitions
 * Issue #294: Schedule execution feature
 */

/**
 * The `opencode run` options CommandMate can drive from a CMATE.md CLI Tool
 * column (Issue #2044).
 *
 * One shape, three readers: {@link ScheduleEntry} (what the parser produced),
 * {@link ScheduleWriteInput} (what the dialog is about to write) and
 * `ExecuteCommandOptions` (what `buildCliArgs()` turns into argv). Declaring it
 * here rather than in any of the three keeps the field names from drifting —
 * a schedule that parses but does not execute is the failure mode this Issue
 * exists to avoid, and it starts with two spellings of the same option.
 *
 * Every flag was measured against opencode 1.18.22 (`opencode run --help`, and
 * `GET /session` after a run that used it — see
 * `docs/design/opencode-server-live-verification.md` §15):
 *
 * | field | argv | how it was confirmed |
 * |-------|------|----------------------|
 * | `model` | `-m <provider/model>` | already wired by #1914 |
 * | `agent` | `--agent <name>` | `Session.agent === 'plan'` |
 * | `variant` | `--variant <name>` | `Session.model.variant === 'high'` |
 * | `continueSession` | `-c` | the run reused the previous `sessionID` |
 * | `title` | `--title <text>` | `Session.title === 'cm-2044-probe'` |
 *
 * `continueSession` rather than `continue`: `continue` is a reserved word, and
 * a property named for a keyword reads as a syntax error in every call site.
 */
export interface OpencodeRunOptions {
  /** `-m <provider/model>`. Passed through verbatim (Issue #1914). */
  model?: string;
  /** `--agent <name>` — which agent persona drives the run (`build`, `plan`, …). */
  agent?: string;
  /** `--variant <name>` — provider-specific reasoning effort (`high`, `max`, …). */
  variant?: string;
  /** `-c` — continue the most recently updated session in this directory. */
  continueSession?: boolean;
  /** `--title <text>` — names the session instead of truncating the prompt. */
  title?: string;
}

/**
 * A single schedule entry parsed from CMATE.md Schedules section
 */
export interface ScheduleEntry extends OpencodeRunOptions {
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
export interface ScheduleWriteInput extends OpencodeRunOptions {
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
}
