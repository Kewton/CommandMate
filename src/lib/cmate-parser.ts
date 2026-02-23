/**
 * CMATE.md Parser
 * Issue #294: Schedule execution feature
 *
 * Parses CMATE.md files (Markdown table format) from worktree root directories.
 * Provides a generic table parser and a specialized schedule section parser.
 *
 * Security:
 * - Path traversal prevention (realpath + worktree directory validation)
 * - Unicode control character sanitization
 * - Name validation with strict pattern matching
 * - Cron expression validation
 */

import { readFileSync, realpathSync } from 'fs';
import path from 'path';
import type { ScheduleEntry, CmateConfig } from '@/types/cmate';

// =============================================================================
// Constants
// =============================================================================

/** CMATE.md filename */
export const CMATE_FILENAME = 'CMATE.md';

/**
 * Unicode control character regex for sanitization
 * Matches: C0 control chars (except \t \n \r), C1 control chars,
 * zero-width characters, directional control characters
 *
 * [S4-002] Strips potentially dangerous Unicode control characters
 */
export const CONTROL_CHAR_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F\u200B-\u200F\u2028-\u202F\uFEFF]/g;

/**
 * Name validation pattern
 * Allows: ASCII word chars, Japanese chars (CJK, Hiragana, Katakana, Symbols),
 * spaces, and hyphens. Length: 1-100 characters.
 *
 * [S4-011] Prevents injection through name field
 */
export const NAME_PATTERN =
  /^[\w\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uF900-\uFAFF\s-]{1,100}$/;

/** Maximum cron expression length */
export const MAX_CRON_EXPRESSION_LENGTH = 100;

/** Minimum cron interval pattern (every minute) */
export const MIN_CRON_INTERVAL = '* * * * *';

/** Maximum number of schedule entries per worktree */
export const MAX_SCHEDULE_ENTRIES = 100;

// =============================================================================
// Sanitization
// =============================================================================

/**
 * Remove Unicode control characters from a string.
 * Preserves tabs (\t), newlines (\n), and carriage returns (\r).
 *
 * @param content - Raw string to sanitize
 * @returns Sanitized string with control characters removed
 */
export function sanitizeMessageContent(content: string): string {
  return content.replace(CONTROL_CHAR_REGEX, '');
}

// =============================================================================
// Path Validation
// =============================================================================

/**
 * Validate that a CMATE.md file path is within the expected worktree directory.
 * Prevents path traversal attacks by resolving symlinks and verifying containment.
 *
 * @param filePath - Path to CMATE.md file
 * @param worktreeDir - Expected worktree directory
 * @returns true if path is valid and within worktree directory
 * @throws Error if path traversal is detected
 */
export function validateCmatePath(
  filePath: string,
  worktreeDir: string
): boolean {
  const realFilePath = realpathSync(filePath);
  const realWorktreeDir = realpathSync(worktreeDir);

  // Ensure the file is within the worktree directory
  if (
    !realFilePath.startsWith(realWorktreeDir + path.sep) &&
    realFilePath !== path.join(realWorktreeDir, CMATE_FILENAME)
  ) {
    throw new Error(
      `Path traversal detected: ${filePath} is not within ${worktreeDir}`
    );
  }

  return true;
}

// =============================================================================
// Cron Validation
// =============================================================================

/**
 * Validate a cron expression.
 * Checks length and basic format (5 fields separated by spaces).
 *
 * @param expression - Cron expression to validate
 * @returns true if the expression appears valid
 */
export function isValidCronExpression(expression: string): boolean {
  if (expression.length > MAX_CRON_EXPRESSION_LENGTH) {
    return false;
  }

  // Basic format check: 5 fields separated by spaces
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) {
    return false;
  }

  return true;
}

// =============================================================================
// Generic Markdown Table Parser
// =============================================================================

/**
 * Parse a CMATE.md file into a generic structure.
 * Returns a Map where keys are section names (from ## headers)
 * and values are arrays of row data (each row is an array of cell values).
 *
 * [S1-010] Generic design: returns Map<string, string[][]>
 *
 * @param content - Raw CMATE.md file content
 * @returns Map of section name to table rows
 */
export function parseCmateFile(content: string): CmateConfig {
  const result: CmateConfig = new Map();
  const lines = content.split('\n');

  let currentSection: string | null = null;
  let headerParsed = false;
  let separatorParsed = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers (## SectionName)
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

    // Skip empty lines
    if (!trimmed) {
      continue;
    }

    // Skip non-table lines
    if (!trimmed.startsWith('|')) {
      continue;
    }

    if (!currentSection) {
      continue;
    }

    // Parse table row
    if (!headerParsed) {
      // First row is header - skip it
      headerParsed = true;
      continue;
    }

    if (!separatorParsed) {
      // Second row is separator (|---|---|) - skip it
      if (trimmed.match(/^\|[\s-:|]+\|$/)) {
        separatorParsed = true;
        continue;
      }
      // If it's not a separator, treat it as data
      separatorParsed = true;
    }

    // Parse data row
    const cells = trimmed
      .split('|')
      .slice(1, -1) // Remove leading and trailing empty strings from split
      .map((cell) => cell.trim());

    if (cells.length > 0) {
      result.get(currentSection)!.push(cells);
    }
  }

  return result;
}

// =============================================================================
// Schedule Section Parser
// =============================================================================

/**
 * Parse the Schedules section of a CMATE.md file into typed ScheduleEntry objects.
 *
 * Expected table format:
 * | Name | Cron | Message | CLI Tool | Enabled |
 * |------|------|---------|----------|---------|
 * | daily-review | 0 9 * * * | Review code changes | claude | true |
 *
 * Entries with invalid names, cron expressions, or missing required fields
 * are silently skipped with a console.warn.
 *
 * @param rows - Raw table rows from parseCmateFile() for the Schedules section
 * @returns Array of validated ScheduleEntry objects
 */
export function parseSchedulesSection(rows: string[][]): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];

  for (const row of rows) {
    if (entries.length >= MAX_SCHEDULE_ENTRIES) {
      console.warn(`[cmate-parser] Maximum schedule entries (${MAX_SCHEDULE_ENTRIES}) reached, skipping remaining`);
      break;
    }

    // Minimum required columns: Name, Cron, Message
    if (row.length < 3) {
      console.warn(
        '[cmate-parser] Skipping row with insufficient columns:',
        row
      );
      continue;
    }

    const [name, cronExpression, message, cliToolId, enabledStr] = row;

    // Validate name
    const sanitizedName = sanitizeMessageContent(name);
    if (!NAME_PATTERN.test(sanitizedName)) {
      console.warn(
        `[cmate-parser] Skipping entry with invalid name: "${sanitizedName}"`
      );
      continue;
    }

    // Validate cron expression
    if (!isValidCronExpression(cronExpression)) {
      console.warn(
        `[cmate-parser] Skipping entry "${sanitizedName}" with invalid cron: "${cronExpression}"`
      );
      continue;
    }

    // Sanitize message
    const sanitizedMessage = sanitizeMessageContent(message);
    if (!sanitizedMessage) {
      console.warn(
        `[cmate-parser] Skipping entry "${sanitizedName}" with empty message`
      );
      continue;
    }

    // Parse enabled (default: true)
    const enabled =
      enabledStr === undefined ||
      enabledStr === '' ||
      enabledStr.toLowerCase() === 'true';

    entries.push({
      name: sanitizedName,
      cronExpression: cronExpression.trim(),
      message: sanitizedMessage,
      cliToolId: cliToolId?.trim() || 'claude',
      enabled,
    });
  }

  return entries;
}

/**
 * Read and parse a CMATE.md file from a worktree directory.
 *
 * @param worktreeDir - Path to the worktree directory
 * @returns Parsed CmateConfig, or null if the file doesn't exist
 * @throws Error if path traversal is detected
 */
export function readCmateFile(worktreeDir: string): CmateConfig | null {
  const filePath = path.join(worktreeDir, CMATE_FILENAME);

  try {
    // Validate path before reading
    validateCmatePath(filePath, worktreeDir);
    const content = readFileSync(filePath, 'utf-8');
    return parseCmateFile(content);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}
