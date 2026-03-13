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

import { realpath, readFile } from 'fs/promises';
import path from 'path';
import type { ScheduleEntry, CmateConfig } from '@/types/cmate';
import { isCliToolType } from '@/lib/cli-tools/types';
import {
  CLAUDE_PERMISSIONS,
  CODEX_SANDBOXES,
  DEFAULT_PERMISSIONS,
} from '@/config/schedule-config';
import {
  CMATE_FILENAME,
  CONTROL_CHAR_PATTERN,
  NAME_PATTERN,
  MAX_CRON_EXPRESSION_LENGTH,
  MAX_SCHEDULE_ENTRIES,
  sanitizeContent,
  isValidCronExpression,
} from '@/config/cmate-constants';
import { createLogger } from '@/lib/logger';

const logger = createLogger('cmate-parser');

// Re-export shared constants for backward compatibility
export {
  CMATE_FILENAME,
  NAME_PATTERN,
  MAX_CRON_EXPRESSION_LENGTH,
  MAX_SCHEDULE_ENTRIES,
  isValidCronExpression,
};

/**
 * @deprecated Use CONTROL_CHAR_PATTERN from '@/config/cmate-constants' instead.
 * Kept for backward compatibility with existing tests.
 */
export const CONTROL_CHAR_REGEX = new RegExp(CONTROL_CHAR_PATTERN.source, 'g');

/** Minimum cron interval pattern (every minute) */
export const MIN_CRON_INTERVAL = '* * * * *';

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
  return sanitizeContent(content);
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
export async function validateCmatePath(
  filePath: string,
  worktreeDir: string
): Promise<boolean> {
  const realFilePath = await realpath(filePath);
  const realWorktreeDir = await realpath(worktreeDir);

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
      logger.warn('maximum-schedule-entries');
      break;
    }

    // Minimum required columns: Name, Cron, Message
    if (row.length < 3) {
      logger.warn('parse:insufficient-columns', { columnCount: row.length });
      continue;
    }

    const [name, cronExpression, message, cliToolId, enabledStr, permissionStr] = row;

    // Validate name
    const sanitizedName = sanitizeMessageContent(name);
    if (!NAME_PATTERN.test(sanitizedName)) {
      logger.warn('parse:invalid-name', { name: sanitizedName });
      continue;
    }

    // Validate cron expression
    if (!isValidCronExpression(cronExpression)) {
      logger.warn('parse:invalid-cron', { name: sanitizedName, cron: cronExpression });
      continue;
    }

    // Sanitize message
    const sanitizedMessage = sanitizeMessageContent(message);
    if (!sanitizedMessage) {
      logger.warn('parse:empty-message', { name: sanitizedName });
      continue;
    }

    // Parse enabled (default: true)
    const enabled =
      enabledStr === undefined ||
      enabledStr === '' ||
      enabledStr.toLowerCase() === 'true';

    // Parse and validate CLI tool ID [SEC-002]
    const resolvedCliToolId = cliToolId?.trim() || 'claude';
    if (!isCliToolType(resolvedCliToolId)) {
      logger.warn('parse:invalid-cli-tool', { name: sanitizedName, cliToolId: resolvedCliToolId });
      continue;
    }
    const defaultPermission = DEFAULT_PERMISSIONS[resolvedCliToolId] ?? '';
    let permission = permissionStr?.trim() || defaultPermission;

    // Validate permission against allowed values
    let allowedValues: readonly string[];
    switch (resolvedCliToolId) {
      case 'codex':
        allowedValues = CODEX_SANDBOXES;
        break;
      case 'gemini':
      case 'vibe-local':
        // No permission flags for gemini/vibe-local; only empty string is valid
        allowedValues = [];
        if (permission) {
          logger.warn('parse:permission-ignored', { name: sanitizedName, cliToolId: resolvedCliToolId, permission });
          permission = '';
        }
        break;
      default:
        allowedValues = CLAUDE_PERMISSIONS;
        break;
    }
    if (allowedValues.length > 0 && permission && !allowedValues.includes(permission)) {
      logger.warn('parse:invalid-permission', { name: sanitizedName, cliToolId: resolvedCliToolId, permission, defaultPermission });
      permission = defaultPermission;
    }

    entries.push({
      name: sanitizedName,
      cronExpression: cronExpression.trim(),
      message: sanitizedMessage,
      cliToolId: resolvedCliToolId,
      enabled,
      permission,
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
export async function readCmateFile(worktreeDir: string): Promise<CmateConfig | null> {
  const filePath = path.join(worktreeDir, CMATE_FILENAME);

  try {
    // Validate path before reading
    await validateCmatePath(filePath, worktreeDir);
    const content = await readFile(filePath, 'utf-8');
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
