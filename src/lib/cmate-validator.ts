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
  sanitizeContent,
  isValidCronExpression,
} from '@/config/cmate-constants';
import {
  CLAUDE_PERMISSIONS,
  CODEX_SANDBOXES,
} from '@/config/schedule-config';

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
  field: 'columns' | 'name' | 'cron' | 'message' | 'header' | 'permission';
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

    // Validate permission (6th column)
    const permissionStr = row[5];
    if (permissionStr !== undefined) {
      const trimmedPermission = permissionStr.trim();
      if (trimmedPermission === '') {
        errors.push({
          row: i,
          message: `Row ${i + 1}: empty permission`,
          field: 'permission',
        });
      } else {
        // Validate permission value against allowed values for the CLI tool
        const cliToolId = row[3]?.trim() || 'claude';
        const allowedValues: readonly string[] =
          cliToolId === 'codex' ? CODEX_SANDBOXES : CLAUDE_PERMISSIONS;
        if (!allowedValues.includes(trimmedPermission)) {
          errors.push({
            row: i,
            message: `Row ${i + 1}: invalid permission "${trimmedPermission}" for ${cliToolId}`,
            field: 'permission',
          });
        }
      }
    }
  }

  return errors;
}
