/**
 * Schedule Execution Configuration Constants
 * Issue #294: Centralized constants for schedule-related API routes
 *
 * Eliminates duplication of validation constants and UUID validation
 * across schedules/route.ts, schedules/[scheduleId]/route.ts,
 * and execution-logs/[logId]/route.ts.
 *
 * [S4-014] UUID v4 format validation
 */

// =============================================================================
// Validation Constants
// =============================================================================

/** Maximum schedule name length */
export const MAX_SCHEDULE_NAME_LENGTH = 100;

/** Maximum message length for schedule execution */
export const MAX_SCHEDULE_MESSAGE_LENGTH = 10000;

/** Maximum cron expression length */
export const MAX_SCHEDULE_CRON_LENGTH = 100;

// =============================================================================
// Permission Constants
// =============================================================================

/** Allowed permission values for claude CLI (--permission-mode) */
export const CLAUDE_PERMISSIONS = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const;
export type ClaudePermission = (typeof CLAUDE_PERMISSIONS)[number];

/** Allowed sandbox values for codex CLI (--sandbox) */
export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

/** Allowed permission values for copilot CLI (--allow-all-tools / --yolo) */
export const COPILOT_PERMISSIONS = [
  'allow-all-tools',
  'yolo',
] as const;
export type CopilotPermission = (typeof COPILOT_PERMISSIONS)[number];

/** Allowed permission values for antigravity CLI (--dangerously-skip-permissions) */
export const ANTIGRAVITY_PERMISSIONS = [
  '--dangerously-skip-permissions',
] as const;
export type AntigravityPermission = (typeof ANTIGRAVITY_PERMISSIONS)[number];

/**
 * Allowed permission values for Command Code CLI (`--permission-mode`),
 * Issue #2250.
 *
 * Read off the shipped bundle rather than off `--help`, and the two disagree:
 * `commandcode --help` advertises `(standard, plan, auto-accept)`, while the
 * option is declared
 * `.addOption(new Be("--permission-mode <mode>", …).choices(["default",
 * "standard","plan","auto-accept","dont-ask"]))` in
 * `command-code@1.40.1/dist/cli.mjs`. `.choices()` is what actually validates,
 * so all five are accepted and `default` is the one the tool reports back in its
 * own hook payloads (`"permission_mode":"default"`).
 *
 * `--yolo` / `--dangerously-skip-permissions` is a separate boolean flag rather
 * than a `--permission-mode` value, so it is not on this list — the same axis
 * distinction `OPENCODE_PERMISSIONS` records for `--auto`.
 */
export const COMMAND_CODE_PERMISSIONS = [
  'default',
  'standard',
  'plan',
  'auto-accept',
  'dont-ask',
] as const;
export type CommandCodePermission = (typeof COMMAND_CODE_PERMISSIONS)[number];

/** Allowed permission values for gemini CLI (no permission flags) */
export const GEMINI_PERMISSIONS = [] as const;

/** Allowed permission values for vibe-local CLI (no permission flags) */
export const VIBE_LOCAL_PERMISSIONS = [] as const;

/**
 * Allowed permission values for opencode CLI (Issue #1914).
 *
 * Empty, like gemini's and vibe-local's, but a **separate** constant on purpose:
 * before this Issue `getPermissionOptionsForTool('opencode')` resolved through
 * `default: return GEMINI_PERMISSIONS`, so the value was right for a reason that
 * was not. Object identity is what lets a test tell "opencode has its own case"
 * apart from "opencode falls through to gemini's".
 *
 * opencode has no permission *level* to choose from. `opencode run` does carry a
 * single boolean `--auto` ("auto-approve permissions that are not explicitly
 * denied", measured on 1.18.21), but that is a different axis from the
 * `--permission-mode` / `--sandbox` vocabularies this list models, and
 * CommandMate does not pass it. Wiring it up is a separate decision.
 */
export const OPENCODE_PERMISSIONS = [] as const;

/**
 * What a CLI tool with no permission flag at all resolves to (Issue #1914).
 *
 * The `default:` branch of {@link getPermissionOptionsForTool} returns this
 * rather than any one tool's constant. A tool added to `CLI_TOOL_IDS` without a
 * case below then inherits "no flags", which is the safe answer — inheriting
 * Claude's `--permission-mode` vocabulary is what let `acceptEdits` through on
 * an opencode schedule (`cmate-parser.ts` / `cmate-validator.ts` carry the same
 * decision).
 */
export const NO_PERMISSION_FLAGS = [] as const;

/**
 * Default permission per CLI tool.
 *
 * Issue #1914 added the `opencode` entry: it was the one id in `CLI_TOOL_IDS`
 * with no key here, so every reader fell back to its own `?? ''` and the
 * omission read as an oversight rather than as "this tool takes no flag".
 */
export const DEFAULT_PERMISSIONS: Record<string, string> = {
  claude: 'acceptEdits',
  codex: 'workspace-write',
  gemini: '',
  'vibe-local': '',
  opencode: '',
  copilot: 'allow-all-tools',
  antigravity: '--dangerously-skip-permissions',
  'command-code': 'default',
};

/**
 * Resolve the allowed Permission dropdown options for a CLI tool (Issue #824).
 *
 * Single source of truth shared by the ScheduleEditDialog (dynamic dropdown)
 * and the cmate-writer validation. Mirrors the per-tool permission rules that
 * cmate-parser.ts / cmate-validator.ts enforce on read, so any value the dialog
 * writes round-trips through the parser without being silently discarded.
 *
 * gemini, vibe-local and opencode have no permission flags, so the dialog hides
 * the Permission field and an empty permission is written.
 *
 * Issue #1914: every id in `CLI_TOOL_IDS` now has its own `case`, and `default:`
 * returns {@link NO_PERMISSION_FLAGS} instead of `GEMINI_PERMISSIONS`. The
 * returned *value* is unchanged for every tool that exists today — all three
 * empty lists are `[]` — but the old spelling said "a tool I do not recognise
 * gets gemini's rules", which is not a sentence anyone meant. It is also the
 * shape that hid the real bug in the two switches this function mirrors, where
 * the same fallback resolved to CLAUDE_PERMISSIONS and let `acceptEdits` onto an
 * opencode schedule.
 *
 * @param cliToolId - CLI tool identifier
 * @returns Readonly array of allowed permission values (empty = no permission flags)
 */
export function getPermissionOptionsForTool(cliToolId: string): readonly string[] {
  switch (cliToolId) {
    case 'claude':
      return CLAUDE_PERMISSIONS;
    case 'codex':
      return CODEX_SANDBOXES;
    case 'copilot':
      return COPILOT_PERMISSIONS;
    case 'antigravity':
      return ANTIGRAVITY_PERMISSIONS;
    case 'command-code':
      return COMMAND_CODE_PERMISSIONS;
    case 'gemini':
      return GEMINI_PERMISSIONS;
    case 'vibe-local':
      return VIBE_LOCAL_PERMISSIONS;
    case 'opencode':
      return OPENCODE_PERMISSIONS;
    default:
      return NO_PERMISSION_FLAGS;
  }
}

// =============================================================================
// UUID Validation
// =============================================================================

/**
 * UUID v4 validation pattern.
 * Matches standard UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
 *
 * [S4-014] Used to validate schedule IDs and execution log IDs
 */
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate that a string is a valid UUID v4 format.
 *
 * @param id - String to validate
 * @returns true if the string matches UUID v4 format
 */
export function isValidUuidV4(id: string): boolean {
  return UUID_V4_PATTERN.test(id);
}
