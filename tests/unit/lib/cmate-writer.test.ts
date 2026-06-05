/**
 * Unit tests for cmate-writer (Issue #824)
 *
 * Covers pure content transforms (upsert / remove / toggle), schedule
 * serialization/escaping, input validation, and atomic file I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  escapeTableCell,
  formatCliToolColumn,
  serializeScheduleRow,
  upsertScheduleInContent,
  removeScheduleFromContent,
  setScheduleEnabledInContent,
  validateScheduleInput,
  writeScheduleToCmate,
  deleteScheduleFromCmate,
  setScheduleEnabledInCmate,
  SCHEDULE_TABLE_HEADER,
} from '@/lib/cmate-writer';
import type { ScheduleWriteInput } from '@/types/cmate';

const baseSchedule: ScheduleWriteInput = {
  name: 'daily-review',
  cronExpression: '0 9 * * *',
  message: 'Review code changes',
  cliToolId: 'claude',
  enabled: true,
  permission: 'acceptEdits',
};

describe('escapeTableCell', () => {
  it('collapses newlines into a single space', () => {
    expect(escapeTableCell('line1\nline2\r\nline3')).toBe('line1 line2 line3');
  });

  it('replaces raw pipes with the fullwidth pipe to protect table parsing', () => {
    expect(escapeTableCell('a | b')).toBe('a ｜ b');
  });
});

describe('formatCliToolColumn', () => {
  it('embeds --model only for tools that support it', () => {
    expect(formatCliToolColumn('copilot', 'gpt-4.1')).toBe('copilot --model gpt-4.1');
    expect(formatCliToolColumn('claude', 'gpt-4.1')).toBe('claude');
    expect(formatCliToolColumn('copilot', '')).toBe('copilot');
  });
});

describe('serializeScheduleRow', () => {
  it('renders all six columns', () => {
    expect(serializeScheduleRow(baseSchedule)).toBe(
      '| daily-review | 0 9 * * * | Review code changes | claude | true | acceptEdits |',
    );
  });

  it('renders false for disabled and empty permission cell', () => {
    const row = serializeScheduleRow({
      ...baseSchedule,
      cliToolId: 'gemini',
      enabled: false,
      permission: '',
    });
    expect(row).toBe('| daily-review | 0 9 * * * | Review code changes | gemini | false |  |');
  });

  it('escapes pipes and newlines in the message cell', () => {
    const row = serializeScheduleRow({ ...baseSchedule, message: 'do a | b\nthen c' });
    expect(row).toContain('do a ｜ b then c');
    // Exactly 6 column delimiters + 1 leading => 7 ASCII pipes
    expect((row.match(/\|/g) ?? []).length).toBe(7);
  });
});

describe('upsertScheduleInContent', () => {
  it('creates a fresh Schedules section when content is empty', () => {
    const result = upsertScheduleInContent('', baseSchedule);
    expect(result).toContain('## Schedules');
    expect(result).toContain(SCHEDULE_TABLE_HEADER);
    expect(result).toContain('| daily-review | 0 9 * * * |');
  });

  it('appends a Schedules section while preserving existing sections', () => {
    const existing = '## Notes\n\nSome notes here.\n';
    const result = upsertScheduleInContent(existing, baseSchedule);
    expect(result).toContain('## Notes');
    expect(result).toContain('Some notes here.');
    expect(result.indexOf('## Notes')).toBeLessThan(result.indexOf('## Schedules'));
  });

  it('appends a new row to an existing table without touching the first row', () => {
    const first = upsertScheduleInContent('', baseSchedule);
    const second = upsertScheduleInContent(first, {
      ...baseSchedule,
      name: 'weekly-report',
      cronExpression: '0 9 * * 1',
    });
    expect(second).toContain('| daily-review | 0 9 * * * |');
    expect(second).toContain('| weekly-report | 0 9 * * 1 |');
    // First row precedes the second
    expect(second.indexOf('daily-review')).toBeLessThan(second.indexOf('weekly-report'));
  });

  it('updates an existing row matched by name', () => {
    const first = upsertScheduleInContent('', baseSchedule);
    const updated = upsertScheduleInContent(first, {
      ...baseSchedule,
      message: 'Updated message',
    });
    expect(updated).toContain('Updated message');
    expect(updated).not.toContain('Review code changes');
    // Only one data row remains
    expect((updated.match(/daily-review/g) ?? []).length).toBe(1);
  });

  it('renames a row when originalName is provided', () => {
    const first = upsertScheduleInContent('', baseSchedule);
    const renamed = upsertScheduleInContent(
      first,
      { ...baseSchedule, name: 'renamed-task' },
      'daily-review',
    );
    expect(renamed).toContain('| renamed-task | 0 9 * * * |');
    expect(renamed).not.toContain('| daily-review |');
  });

  it('preserves a section that follows the Schedules section', () => {
    const existing = `## Schedules\n\n${SCHEDULE_TABLE_HEADER}\n|------|------|---------|----------|---------|------------|\n| existing | 0 9 * * * | hi | claude | true | acceptEdits |\n\n## Notes\n\ntrailing\n`;
    const result = upsertScheduleInContent(existing, {
      ...baseSchedule,
      name: 'added',
    });
    expect(result).toContain('| existing | 0 9 * * * |');
    expect(result).toContain('| added | 0 9 * * * |');
    expect(result).toContain('## Notes');
    expect(result).toContain('trailing');
    // New row inserted before the Notes section
    expect(result.indexOf('| added |')).toBeLessThan(result.indexOf('## Notes'));
  });
});

describe('removeScheduleFromContent', () => {
  it('removes a row matched by name', () => {
    const first = upsertScheduleInContent('', baseSchedule);
    const removed = removeScheduleFromContent(first, 'daily-review');
    expect(removed).not.toContain('daily-review');
    expect(removed).toContain('## Schedules');
  });

  it('returns content unchanged when the row is missing', () => {
    const first = upsertScheduleInContent('', baseSchedule);
    expect(removeScheduleFromContent(first, 'nonexistent')).toBe(first);
  });
});

describe('setScheduleEnabledInContent', () => {
  it('flips the enabled cell while keeping other cells intact', () => {
    const first = upsertScheduleInContent('', baseSchedule);
    const disabled = setScheduleEnabledInContent(first, 'daily-review', false);
    expect(disabled).toContain('| daily-review | 0 9 * * * | Review code changes | claude | false | acceptEdits |');
  });

  it('returns content unchanged when the row is missing', () => {
    const first = upsertScheduleInContent('', baseSchedule);
    expect(setScheduleEnabledInContent(first, 'missing', false)).toBe(first);
  });
});

describe('validateScheduleInput', () => {
  it('accepts a valid claude schedule', () => {
    expect(validateScheduleInput(baseSchedule).valid).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = validateScheduleInput({ ...baseSchedule, name: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('name is required');
  });

  it('rejects an invalid cron expression', () => {
    const result = validateScheduleInput({ ...baseSchedule, cronExpression: 'nope' });
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown CLI tool', () => {
    const result = validateScheduleInput({ ...baseSchedule, cliToolId: 'bogus' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('invalid CLI tool');
  });

  it('rejects a permission that is not allowed for the tool', () => {
    const result = validateScheduleInput({
      ...baseSchedule,
      cliToolId: 'codex',
      permission: 'acceptEdits',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('invalid permission');
  });

  it('rejects a permission for a tool without permission flags', () => {
    const result = validateScheduleInput({
      ...baseSchedule,
      cliToolId: 'gemini',
      permission: 'acceptEdits',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('permission is not supported for this CLI tool');
  });

  it('accepts a copilot schedule with a model', () => {
    const result = validateScheduleInput({
      ...baseSchedule,
      cliToolId: 'copilot',
      permission: 'allow-all-tools',
      model: 'gpt-4.1',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a model for a tool that does not support it', () => {
    const result = validateScheduleInput({ ...baseSchedule, model: 'gpt-4.1' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('model is not supported for this CLI tool');
  });
});

describe('atomic file I/O', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cmate-writer-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates CMATE.md when it does not exist', async () => {
    await writeScheduleToCmate(dir, baseSchedule);
    const content = await readFile(path.join(dir, 'CMATE.md'), 'utf-8');
    expect(content).toContain('## Schedules');
    expect(content).toContain('| daily-review | 0 9 * * * |');
  });

  it('does not leave .tmp files behind after a write', async () => {
    await writeScheduleToCmate(dir, baseSchedule);
    const { readdir } = await import('fs/promises');
    const entries = await readdir(dir);
    expect(entries).toEqual(['CMATE.md']);
  });

  it('updates an existing CMATE.md and preserves other sections', async () => {
    const filePath = path.join(dir, 'CMATE.md');
    await writeFile(filePath, '## Notes\n\nkeep me\n', 'utf-8');
    await writeScheduleToCmate(dir, baseSchedule);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('keep me');
    expect(content).toContain('| daily-review | 0 9 * * * |');
  });

  it('toggles enabled via the file API', async () => {
    await writeScheduleToCmate(dir, baseSchedule);
    await setScheduleEnabledInCmate(dir, 'daily-review', false);
    const content = await readFile(path.join(dir, 'CMATE.md'), 'utf-8');
    expect(content).toContain('| claude | false | acceptEdits |');
  });

  it('deletes a schedule via the file API', async () => {
    await writeScheduleToCmate(dir, baseSchedule);
    await deleteScheduleFromCmate(dir, 'daily-review');
    const content = await readFile(path.join(dir, 'CMATE.md'), 'utf-8');
    expect(content).not.toContain('daily-review');
  });

  it('is a no-op when deleting from a missing CMATE.md', async () => {
    await deleteScheduleFromCmate(dir, 'daily-review');
    await expect(stat(path.join(dir, 'CMATE.md'))).rejects.toThrow();
  });
});
