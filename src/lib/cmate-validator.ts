/**
 * CMATE.md Client-Side Validator
 * Issue #294: Schedule execution feature
 *
 * Provides pure-function validation and template generation for CMATE.md files.
 * Unlike cmate-parser.ts, this module has no fs dependency and can be used
 * in client-side (browser) code.
 *
 * Validation rules mirror cmate-parser.ts but return errors instead of
 * silently skipping invalid entries.
 */

import {
  NAME_PATTERN,
  MAX_SCHEDULE_ENTRIES,
  sanitizeContent,
  isValidCronExpression,
} from '@/config/cmate-constants';
import {
  CLAUDE_PERMISSIONS,
  CODEX_SANDBOXES,
  COPILOT_PERMISSIONS,
  ANTIGRAVITY_PERMISSIONS,
  COMMAND_CODE_PERMISSIONS,
  COMMAND_CODE_SCHEDULE_PERMISSIONS,
} from '@/config/schedule-config';
import { parseAndValidateCliToolColumn } from '@/lib/cmate-cli-tool-parser';
import { isCliToolType } from '@/lib/cli-tools/types';

// =============================================================================
// Types
// =============================================================================

/** Validation error for a single row in the Schedules table */
export interface CmateValidationError {
  /** 0-based row index in the Schedules table (-1 for header errors) */
  row: number;
  /** Human-readable error message */
  message: string;
  /** Field that caused the error */
  field: 'columns' | 'name' | 'cron' | 'message' | 'header' | 'permission' | 'cliTool' | 'model';
}

/**
 * The tools `commandcode -p` rejects when the agent calls them directly and
 * `--yolo` was not passed (Issue #2576; measured on the 1.53.1 bundle, where
 * `resolvePrintHarnessMods` injects `print-permission-gate` unless
 * `dangerouslySkipPermissions` is set).
 */
export const COMMAND_CODE_PRINT_GATED_TOOLS = [
  'edit_file',
  'write_file',
  'shell_command',
  'monitor_command',
  'kill_shell',
] as const;

/** Reason code of the command-code print-gate warning (Issue #2576) */
export const COMMAND_CODE_DIRECT_WRITE_TOOLS_DENIED = 'command-code-direct-write-tools-denied' as const;

/**
 * Non-blocking finding for a row in the Schedules table (Issue #2576).
 *
 * Deliberately not a {@link CmateValidationError}: `validateSchedulesSection`
 * returning `[]` means "valid", and a schedule that only reports an answer is a
 * valid schedule. Warnings travel through {@link collectScheduleWarnings}.
 */
export interface CmateValidationWarning {
  /** 0-based row index in the Schedules table */
  row: number;
  /** Sanitized schedule name */
  name: string;
  /** Field that caused the warning */
  field: 'permission';
  /** Machine-readable reason code */
  code: typeof COMMAND_CODE_DIRECT_WRITE_TOOLS_DENIED;
  cliToolId: string;
  permission: string;
  /** Human-readable message (English; the UI has its own localized wording) */
  message: string;
}

/** Required header columns for the Schedules table */
const REQUIRED_SCHEDULE_HEADERS = ['Name', 'Cron', 'Message', 'CLI Tool', 'Enabled'] as const;

/** Optional header columns (validated only when present) */
const OPTIONAL_SCHEDULE_HEADERS = ['Permission'] as const;

// =============================================================================
// Template
// =============================================================================

/** Default CMATE.md template content */
export const CMATE_TEMPLATE_CONTENT = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| example-task | 0 * * * * | README.mdを要約してください | claude | true | acceptEdits |
| copilot-example | 0 9 * * * | コードをレビューしてください | copilot --model gpt-4.1 | true | allow-all-tools |
`;

// =============================================================================
// Parser (client-side, no fs dependency)
// =============================================================================

/**
 * Parse CMATE.md content into a generic structure.
 * Client-side equivalent of parseCmateFile() from cmate-parser.ts.
 *
 * @param content - Raw CMATE.md file content
 * @returns Map of section name to table rows
 */
export function parseCmateContent(content: string): Map<string, string[][]> {
  const result = new Map<string, string[][]>();
  const lines = content.split('\n');

  let currentSection: string | null = null;
  let headerParsed = false;
  let separatorParsed = false;

  for (const line of lines) {
    const trimmed = line.trim();

    const headerMatch = trimmed.match(/^##\s+(.+)$/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim();
      headerParsed = false;
      separatorParsed = false;
      if (!result.has(currentSection)) {
        result.set(currentSection, []);
      }
      continue;
    }

    if (!trimmed || !trimmed.startsWith('|') || !currentSection) {
      continue;
    }

    if (!headerParsed) {
      headerParsed = true;
      continue;
    }

    if (!separatorParsed) {
      if (trimmed.match(/^\|[\s-:|]+\|$/)) {
        separatorParsed = true;
        continue;
      }
      separatorParsed = true;
    }

    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (cells.length > 0) {
      result.get(currentSection)!.push(cells);
    }
  }

  return result;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate that the Schedules section header row contains the expected columns.
 *
 * @param content - Raw CMATE.md file content
 * @returns Array of validation errors (empty = headers valid)
 */
export function validateScheduleHeaders(
  content: string
): CmateValidationError[] {
  const errors: CmateValidationError[] = [];
  const lines = content.split('\n');

  let inSchedules = false;

  for (const line of lines) {
    const trimmed = line.trim();

    const sectionMatch = trimmed.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      inSchedules = sectionMatch[1].trim() === 'Schedules';
      continue;
    }

    if (!inSchedules || !trimmed.startsWith('|')) {
      continue;
    }

    // First table row in Schedules section = header row
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

    // Validate required headers
    for (let i = 0; i < REQUIRED_SCHEDULE_HEADERS.length; i++) {
      const expected = REQUIRED_SCHEDULE_HEADERS[i];
      const actual = cells[i];
      if (!actual || actual !== expected) {
        errors.push({
          row: -1,
          message: `Header column ${i + 1}: expected "${expected}", got "${actual || '(missing)'}"`,
          field: 'header',
        });
      }
    }

    // Validate optional headers (only when present)
    for (let j = 0; j < OPTIONAL_SCHEDULE_HEADERS.length; j++) {
      const colIndex = REQUIRED_SCHEDULE_HEADERS.length + j;
      const expected = OPTIONAL_SCHEDULE_HEADERS[j];
      const actual = cells[colIndex];
      if (actual !== undefined && actual !== expected) {
        errors.push({
          row: -1,
          message: `Header column ${colIndex + 1}: expected "${expected}", got "${actual}"`,
          field: 'header',
        });
      }
    }

    break; // Only check the first table row (header)
  }

  return errors;
}

/**
 * Validate rows from the Schedules section.
 * Returns an array of validation errors (empty array = all valid).
 *
 * @param rows - Raw table rows from parseCmateContent() for the Schedules section
 * @returns Array of validation errors
 */
export function validateSchedulesSection(
  rows: string[][]
): CmateValidationError[] {
  const errors: CmateValidationError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Minimum required columns: Name, Cron, Message
    if (row.length < 3) {
      errors.push({
        row: i,
        message: `Row ${i + 1}: insufficient columns (need at least 3, got ${row.length})`,
        field: 'columns',
      });
      continue;
    }

    const [name, cronExpression, message] = row;

    // Validate name
    const sanitizedName = sanitizeContent(name);
    if (!NAME_PATTERN.test(sanitizedName)) {
      errors.push({
        row: i,
        message: `Row ${i + 1}: invalid name "${sanitizedName}"`,
        field: 'name',
      });
    }

    // Validate cron expression
    if (!isValidCronExpression(cronExpression)) {
      errors.push({
        row: i,
        message: `Row ${i + 1}: invalid cron "${cronExpression}"`,
        field: 'cron',
      });
    }

    // Validate message
    const sanitizedMessage = sanitizeContent(message);
    if (!sanitizedMessage.trim()) {
      errors.push({
        row: i,
        message: `Row ${i + 1}: empty message`,
        field: 'message',
      });
    }

    // Validate CLI Tool column via shared pipeline (DR1-007)
    const { result: parsed, errors: cliToolErrors } = parseAndValidateCliToolColumn(row[3] || '');
    for (const errMsg of cliToolErrors) {
      errors.push({
        row: i,
        message: `Row ${i + 1}: ${errMsg}`,
        field: errMsg.includes('Model') ? 'model' : 'cliTool',
      });
    }

    // Validate cliToolId is a known tool (DR2-009)
    if (parsed && !isCliToolType(parsed.cliToolId)) {
      errors.push({
        row: i,
        message: `Row ${i + 1}: unknown CLI Tool "${parsed.cliToolId}"`,
        field: 'cliTool',
      });
    }

    // Validate permission (6th column)
    // Empty/missing permission is allowed -- parser applies default per CLI tool
    const permissionStr = row[5];
    if (permissionStr !== undefined && permissionStr.trim() !== '') {
      const trimmedPermission = permissionStr.trim();
      const cliToolId = parsed.cliToolId;
      // DR3-002: copilot separated from gemini/vibe-local to accept COPILOT_PERMISSIONS
      // Issue #1914: the fallback is `[]`, not CLAUDE_PERMISSIONS. Every tool
      // whose CLI has a permission flag is named explicitly; anything else --
      // `opencode`, `gemini`, `vibe-local`, and any tool added to CLI_TOOL_IDS
      // without a branch here -- has no flag, so a non-empty Permission cell is
      // an error rather than something silently checked against Claude's list.
      // Issue #2454: command-code's list is the six-value column vocabulary
      // (`yolo` + the five `--permission-mode` choices), the same set the
      // parser accepts and the dialog offers.
      const allowedValues: readonly string[] =
        cliToolId === 'claude' ? CLAUDE_PERMISSIONS
        : cliToolId === 'codex' ? CODEX_SANDBOXES
        : cliToolId === 'copilot' ? COPILOT_PERMISSIONS
        : cliToolId === 'antigravity' ? ANTIGRAVITY_PERMISSIONS
        : cliToolId === 'command-code' ? COMMAND_CODE_SCHEDULE_PERMISSIONS
        : [];
      if (!allowedValues.includes(trimmedPermission)) {
        errors.push({
          row: i,
          message: `Row ${i + 1}: invalid permission "${trimmedPermission}" for ${cliToolId}`,
          field: 'permission',
        });
      }
    }
  }

  return errors;
}

// =============================================================================
// Warnings (Issue #2576)
// =============================================================================

/**
 * Whether a schedule runs `commandcode -p` with its print gate still on.
 *
 * Shared by the parser's log line, {@link collectScheduleWarnings} and the
 * ScheduleEditDialog note, so the three cannot disagree.
 *
 * The test is "one of the five `--permission-mode` values", not "anything but
 * `yolo`", because that is what `buildCliArgs` does: `yolo` gets `--yolo`, the
 * five modes get `--permission-mode <value>` and leave the gate on, and
 * anything else (an empty cell, an out-of-vocabulary value) gets `--yolo` --
 * which is also what the parser resolves those cells to. "Not `yolo`" flagged
 * an empty cell that in fact runs with `--yolo`.
 *
 * What the gate rejects is the write tools the agent calls *directly*
 * ({@link COMMAND_CODE_PRINT_GATED_TOOLS}); a write routed through a sub-agent
 * can still land, so this does not mean the run is read-only.
 *
 * @param cliToolId - CLI tool id of the schedule
 * @param permission - Permission cell or resolved permission
 * @returns true when the directly-called write tools will be rejected
 */
export function isCommandCodeDirectWriteToolsDenied(cliToolId: string, permission: string): boolean {
  return (
    cliToolId === 'command-code' &&
    (COMMAND_CODE_PERMISSIONS as readonly string[]).includes(permission.trim())
  );
}

/**
 * Collect non-blocking warnings from the Schedules section rows (Issue #2576).
 *
 * CMATE.md is edited by hand, and that path never shows the dialog note, so the
 * judgment has to run on the file itself. Only rows that will actually run with
 * the gate on are reported, mirroring `parseSchedulesSection`:
 *
 * - rows the parser skips (any validation error other than the permission) are
 *   left out and do not count toward the limit;
 * - rows past `MAX_SCHEDULE_ENTRIES` registered rows are left out -- the parser
 *   stops there, and a row with an out-of-vocabulary permission *is* registered
 *   (as `yolo`), so it counts;
 * - rows with an out-of-vocabulary permission are left out -- they run as `yolo`;
 * - disabled rows are left out -- they are registered but never run, and the
 *   warning is about a schedule running unnoticed. Enabling one rewrites
 *   CMATE.md, and the next read reports it.
 *
 * This never adds to {@link validateSchedulesSection}'s errors -- a warned row
 * is still registered and still runs.
 *
 * @param rows - Raw table rows from parseCmateContent() for the Schedules section
 * @returns Array of warnings (empty = nothing to flag)
 */
export function collectScheduleWarnings(rows: string[][]): CmateValidationWarning[] {
  const warnings: CmateValidationWarning[] = [];
  let registered = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const errors = validateSchedulesSection([row]);
    if (errors.some((error) => error.field !== 'permission')) continue;
    if (registered >= MAX_SCHEDULE_ENTRIES) break;
    registered++;
    if (errors.length > 0) continue;

    const [rawName, , , rawCliTool, enabledStr, permissionStr] = row;
    if (!isScheduleEnabled(enabledStr)) continue;

    const { result: parsed } = parseAndValidateCliToolColumn(rawCliTool || '');
    const permission = (permissionStr ?? '').trim();
    if (!isCommandCodeDirectWriteToolsDenied(parsed.cliToolId, permission)) continue;

    const name = sanitizeContent(rawName);
    warnings.push({
      row: i,
      name,
      field: 'permission',
      code: COMMAND_CODE_DIRECT_WRITE_TOOLS_DENIED,
      cliToolId: parsed.cliToolId,
      permission,
      message:
        `Row ${i + 1}: schedule "${name}" runs command-code with the --permission-mode value "${permission}", ` +
        `so commandcode -p rejects the write tools the agent calls directly ` +
        `(${COMMAND_CODE_PRINT_GATED_TOOLS.join(', ')}). ` +
        'This is a warning, not an error: the schedule still runs. Use "yolo" if it needs to write.',
    });
  }

  return warnings;
}

/**
 * Read the Enabled cell of a Schedules row: missing, empty or `true` (any case)
 * means enabled. Shared with `parseSchedulesSection` so the parser and
 * {@link collectScheduleWarnings} cannot disagree about which rows run.
 */
export function isScheduleEnabled(enabledStr: string | undefined): boolean {
  return enabledStr === undefined || enabledStr === '' || enabledStr.toLowerCase() === 'true';
}
