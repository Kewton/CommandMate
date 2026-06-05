/**
 * CMATE.md Writer
 * Issue #824: Schedules UX Phase 1 — write-only sync (Option C)
 *
 * Symmetric counterpart to cmate-parser.ts. Provides:
 * - Pure content transforms (upsert / remove / toggle a schedule row) that
 *   preserve existing section order and table formatting (minimal diff).
 * - Atomic file writes (tmp file -> rename) so the existing cron-parser mtime
 *   watcher (schedule-manager.syncSchedules) picks up changes and syncs the DB.
 *
 * Design (Issue #824):
 * - The UI never calls the schedule DB API directly. All mutations flow through
 *   CMATE.md writes here; the existing schedule-manager watcher reconciles the DB.
 * - Table cells are escaped so user input (pipes, newlines) cannot corrupt the
 *   naive Markdown table parser in cmate-parser.ts (which is intentionally left
 *   unchanged by this Issue).
 *
 * Security / trust boundary:
 * - worktreePath is DB-derived (getWorktreeById) and validated at worktree
 *   registration time, matching the trust boundary documented in cron-parser.ts
 *   (getCmateMtime). The target file is always `${worktreePath}/CMATE.md`.
 */

import { readFile, writeFile, rename, rm } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { ScheduleWriteInput } from '@/types/cmate';
import { CMATE_FILENAME, NAME_PATTERN, isValidCronExpression } from '@/config/cmate-constants';
import {
  MAX_SCHEDULE_NAME_LENGTH,
  MAX_SCHEDULE_MESSAGE_LENGTH,
  getPermissionOptionsForTool,
} from '@/config/schedule-config';
import { isCliToolType } from '@/lib/cli-tools/types';
import {
  TOOLS_WITH_MODEL_SUPPORT,
  validateCopilotModelName,
} from '@/lib/cmate-cli-tool-parser';

// =============================================================================
// Constants
// =============================================================================

/** Heading line for the Schedules section */
export const SCHEDULE_SECTION_HEADING = '## Schedules';

/** Canonical Schedules table header row */
export const SCHEDULE_TABLE_HEADER = '| Name | Cron | Message | CLI Tool | Enabled | Permission |';

/** Canonical Schedules table separator row */
export const SCHEDULE_TABLE_SEPARATOR = '|------|------|---------|----------|---------|------------|';

/** Markdown table separator detection (mirrors cmate-parser.ts) */
const TABLE_SEPARATOR_PATTERN = /^\|[\s\-:|]+\|$/;

/** Section heading detection (mirrors cmate-parser.ts) */
const SECTION_HEADING_PATTERN = /^##\s+(.+)$/;

// =============================================================================
// Cell / Row Serialization
// =============================================================================

/**
 * Escape a value for safe embedding in a Markdown table cell.
 *
 * The cmate-parser.ts table parser is intentionally naive (it splits on `|`
 * line-by-line and does not unescape). To guarantee a written row round-trips
 * without corrupting the table:
 * - newlines are collapsed to a single space (a newline would split the row)
 * - raw `|` is replaced with the fullwidth `｜` (U+FF5C) so it is not treated
 *   as a column delimiter on read.
 *
 * @param value - Raw cell value
 * @returns Table-safe cell value
 */
export function escapeTableCell(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\|/g, '｜');
}

/**
 * Build the CLI Tool column value, embedding `--model <name>` when the tool
 * supports it and a model is provided.
 */
export function formatCliToolColumn(cliToolId: string, model?: string): string {
  if (model && model.trim() && TOOLS_WITH_MODEL_SUPPORT.has(cliToolId)) {
    return `${cliToolId} --model ${model.trim()}`;
  }
  return cliToolId;
}

/**
 * Serialize a schedule into a single Markdown table row.
 */
export function serializeScheduleRow(schedule: ScheduleWriteInput): string {
  const cliToolColumn = formatCliToolColumn(schedule.cliToolId, schedule.model);
  const permission = (schedule.permission ?? '').trim();
  const cells = [
    escapeTableCell(schedule.name.trim()),
    escapeTableCell(schedule.cronExpression.trim()),
    escapeTableCell(schedule.message),
    escapeTableCell(cliToolColumn),
    schedule.enabled ? 'true' : 'false',
    escapeTableCell(permission),
  ];
  return `| ${cells.join(' | ')} |`;
}

// =============================================================================
// Section Location Helpers (pure)
// =============================================================================

interface SchedulesSection {
  /** Index of the `## Schedules` heading line */
  headingIndex: number;
  /** Index of the table header row, or -1 if the section has no table */
  tableHeaderIndex: number;
  /** Index of the separator row, or -1 if absent */
  separatorIndex: number;
  /** Indices of data rows (after the separator) */
  dataRowIndices: number[];
}

/** Split a Markdown table row line into trimmed cell values. */
function splitRowCells(line: string): string[] {
  return line
    .trim()
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** Return the trimmed first cell (Name column) of a table row line. */
function getFirstCell(line: string): string {
  const cells = splitRowCells(line);
  return cells.length > 0 ? cells[0] : '';
}

/**
 * Locate the Schedules section within an array of content lines.
 * Returns null if no `## Schedules` heading exists.
 */
function locateSchedulesSection(lines: string[]): SchedulesSection | null {
  let headingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(SECTION_HEADING_PATTERN);
    if (match && match[1].trim() === 'Schedules') {
      headingIndex = i;
      break;
    }
  }
  if (headingIndex === -1) return null;

  // Section ends at the next `## ` heading, or EOF.
  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (SECTION_HEADING_PATTERN.test(lines[i].trim())) {
      sectionEnd = i;
      break;
    }
  }

  let tableHeaderIndex = -1;
  let separatorIndex = -1;
  let sawSeparator = false;
  const dataRowIndices: number[] = [];

  for (let i = headingIndex + 1; i < sectionEnd; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('|')) continue;

    if (tableHeaderIndex === -1) {
      tableHeaderIndex = i;
      continue;
    }
    if (!sawSeparator && TABLE_SEPARATOR_PATTERN.test(trimmed)) {
      separatorIndex = i;
      sawSeparator = true;
      continue;
    }
    dataRowIndices.push(i);
  }

  return { headingIndex, tableHeaderIndex, separatorIndex, dataRowIndices };
}

// =============================================================================
// Pure Content Transforms
// =============================================================================

/**
 * Insert or update a schedule row in CMATE.md content.
 *
 * - Empty content -> a fresh `## Schedules` section is created.
 * - Existing Schedules section -> a row whose Name cell equals
 *   `originalName ?? schedule.name` is replaced; otherwise a new row is appended
 *   after the last data row.
 * - No Schedules section -> one is appended at the end, preserving all existing
 *   sections and ordering.
 *
 * @param content - Current CMATE.md content
 * @param schedule - Schedule to write
 * @param originalName - Previous name when renaming (locates the row to update)
 * @returns Updated CMATE.md content
 */
export function upsertScheduleInContent(
  content: string,
  schedule: ScheduleWriteInput,
  originalName?: string,
): string {
  const targetName = (originalName ?? schedule.name).trim();
  const newRow = serializeScheduleRow(schedule);

  if (!content.trim()) {
    return `${SCHEDULE_SECTION_HEADING}\n\n${SCHEDULE_TABLE_HEADER}\n${SCHEDULE_TABLE_SEPARATOR}\n${newRow}\n`;
  }

  const lines = content.split('\n');
  const section = locateSchedulesSection(lines);

  if (!section) {
    const trimmedEnd = content.replace(/\s+$/, '');
    return `${trimmedEnd}\n\n${SCHEDULE_SECTION_HEADING}\n\n${SCHEDULE_TABLE_HEADER}\n${SCHEDULE_TABLE_SEPARATOR}\n${newRow}\n`;
  }

  // Section exists but has no table -> insert a fresh table right after heading.
  if (section.tableHeaderIndex === -1) {
    lines.splice(
      section.headingIndex + 1,
      0,
      '',
      SCHEDULE_TABLE_HEADER,
      SCHEDULE_TABLE_SEPARATOR,
      newRow,
    );
    return lines.join('\n');
  }

  // Update existing row matched by Name.
  for (const idx of section.dataRowIndices) {
    if (getFirstCell(lines[idx]) === targetName) {
      lines[idx] = newRow;
      return lines.join('\n');
    }
  }

  // Append after the last data row (or after the separator / header).
  const insertAfter =
    section.dataRowIndices.length > 0
      ? section.dataRowIndices[section.dataRowIndices.length - 1]
      : section.separatorIndex !== -1
        ? section.separatorIndex
        : section.tableHeaderIndex;
  lines.splice(insertAfter + 1, 0, newRow);
  return lines.join('\n');
}

/**
 * Remove a schedule row (matched by Name) from CMATE.md content.
 * Returns the content unchanged if the row is not found.
 */
export function removeScheduleFromContent(content: string, name: string): string {
  const target = name.trim();
  const lines = content.split('\n');
  const section = locateSchedulesSection(lines);
  if (!section || section.tableHeaderIndex === -1) return content;

  for (const idx of section.dataRowIndices) {
    if (getFirstCell(lines[idx]) === target) {
      lines.splice(idx, 1);
      return lines.join('\n');
    }
  }
  return content;
}

/**
 * Toggle the Enabled cell of a schedule row (matched by Name) in CMATE.md
 * content. Returns the content unchanged if the row is not found.
 */
export function setScheduleEnabledInContent(
  content: string,
  name: string,
  enabled: boolean,
): string {
  const target = name.trim();
  const lines = content.split('\n');
  const section = locateSchedulesSection(lines);
  if (!section || section.tableHeaderIndex === -1) return content;

  for (const idx of section.dataRowIndices) {
    const cells = splitRowCells(lines[idx]);
    if ((cells[0] ?? '') === target) {
      while (cells.length < 5) cells.push('');
      cells[4] = enabled ? 'true' : 'false';
      lines[idx] = `| ${cells.join(' | ')} |`;
      return lines.join('\n');
    }
  }
  return content;
}

// =============================================================================
// Validation (pure)
// =============================================================================

export interface ScheduleValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a schedule before writing it to CMATE.md.
 * Mirrors cmate-parser.ts / cmate-validator.ts rules so the written row passes
 * the read path and DB sync. Returns all errors found.
 */
export function validateScheduleInput(input: ScheduleWriteInput): ScheduleValidationResult {
  const errors: string[] = [];

  const name = (input.name ?? '').trim();
  if (!name) {
    errors.push('name is required');
  } else if (name.length > MAX_SCHEDULE_NAME_LENGTH) {
    errors.push(`name must be ${MAX_SCHEDULE_NAME_LENGTH} characters or less`);
  } else if (!NAME_PATTERN.test(name)) {
    errors.push('name contains invalid characters');
  }

  const cron = (input.cronExpression ?? '').trim();
  if (!cron) {
    errors.push('cronExpression is required');
  } else if (!isValidCronExpression(cron)) {
    errors.push('invalid cron expression');
  }

  const message = (input.message ?? '').trim();
  if (!message) {
    errors.push('message is required');
  } else if (message.length > MAX_SCHEDULE_MESSAGE_LENGTH) {
    errors.push(`message must be ${MAX_SCHEDULE_MESSAGE_LENGTH} characters or less`);
  }

  if (!isCliToolType(input.cliToolId)) {
    errors.push('invalid CLI tool');
  } else {
    if (input.model && input.model.trim()) {
      if (!TOOLS_WITH_MODEL_SUPPORT.has(input.cliToolId)) {
        errors.push('model is not supported for this CLI tool');
      } else {
        const modelResult = validateCopilotModelName(input.model.trim());
        if (!modelResult.valid) {
          errors.push(modelResult.reason ?? 'invalid model name');
        }
      }
    }

    const permission = (input.permission ?? '').trim();
    if (permission) {
      const options = getPermissionOptionsForTool(input.cliToolId);
      if (options.length === 0) {
        errors.push('permission is not supported for this CLI tool');
      } else if (!options.includes(permission)) {
        errors.push('invalid permission');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// =============================================================================
// File I/O (atomic)
// =============================================================================

/** Read CMATE.md content, returning an empty string when the file is absent. */
async function readCmateContent(worktreePath: string): Promise<string> {
  const filePath = path.join(worktreePath, CMATE_FILENAME);
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

/**
 * Atomically write CMATE.md: write to a unique tmp file in the same directory,
 * then rename over the target. The rename is atomic on the same filesystem, so
 * the mtime watcher never observes a partially-written file.
 */
async function writeCmateAtomic(worktreePath: string, content: string): Promise<void> {
  const filePath = path.join(worktreePath, CMATE_FILENAME);
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, content, 'utf-8');
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Insert or update a schedule in a worktree's CMATE.md (atomic write).
 *
 * @param worktreePath - DB-derived, trusted worktree directory
 * @param schedule - Schedule to write
 * @param originalName - Previous name when renaming
 */
export async function writeScheduleToCmate(
  worktreePath: string,
  schedule: ScheduleWriteInput,
  originalName?: string,
): Promise<void> {
  const content = await readCmateContent(worktreePath);
  const next = upsertScheduleInContent(content, schedule, originalName);
  await writeCmateAtomic(worktreePath, next);
}

/**
 * Remove a schedule (by Name) from a worktree's CMATE.md (atomic write).
 * No-op if the file or row does not exist.
 */
export async function deleteScheduleFromCmate(
  worktreePath: string,
  name: string,
): Promise<void> {
  const content = await readCmateContent(worktreePath);
  if (!content) return;
  const next = removeScheduleFromContent(content, name);
  if (next !== content) {
    await writeCmateAtomic(worktreePath, next);
  }
}

/**
 * Toggle a schedule's Enabled flag (by Name) in a worktree's CMATE.md
 * (atomic write). No-op if the file or row does not exist.
 */
export async function setScheduleEnabledInCmate(
  worktreePath: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  const content = await readCmateContent(worktreePath);
  if (!content) return;
  const next = setScheduleEnabledInContent(content, name, enabled);
  if (next !== content) {
    await writeCmateAtomic(worktreePath, next);
  }
}
