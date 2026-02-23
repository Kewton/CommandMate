/**
 * Tests for cmate-parser.ts
 * Issue #294: CMATE.md parser
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseCmateFile,
  parseSchedulesSection,
  sanitizeMessageContent,
  isValidCronExpression,
  validateCmatePath,
  CONTROL_CHAR_REGEX,
  NAME_PATTERN,
  MAX_CRON_EXPRESSION_LENGTH,
  MAX_SCHEDULE_ENTRIES,
  CMATE_FILENAME,
} from '../../../src/lib/cmate-parser';

describe('cmate-parser', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseCmateFile', () => {
    it('should parse a valid CMATE.md with Schedules section', () => {
      const content = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled |
|------|------|---------|----------|---------|
| daily-review | 0 9 * * * | Review code changes | claude | true |
| weekly-summary | 0 0 * * 1 | Generate weekly summary | claude | false |
`;

      const result = parseCmateFile(content);
      expect(result.has('Schedules')).toBe(true);

      const rows = result.get('Schedules')!;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual([
        'daily-review',
        '0 9 * * *',
        'Review code changes',
        'claude',
        'true',
      ]);
      expect(rows[1]).toEqual([
        'weekly-summary',
        '0 0 * * 1',
        'Generate weekly summary',
        'claude',
        'false',
      ]);
    });

    it('should parse multiple sections', () => {
      const content = `## Schedules

| Name | Cron | Message |
|------|------|---------|
| test | * * * * * | hello |

## Other

| Key | Value |
|-----|-------|
| foo | bar |
`;

      const result = parseCmateFile(content);
      expect(result.has('Schedules')).toBe(true);
      expect(result.has('Other')).toBe(true);
      expect(result.get('Schedules')!).toHaveLength(1);
      expect(result.get('Other')!).toHaveLength(1);
    });

    it('should return empty map for empty content', () => {
      const result = parseCmateFile('');
      expect(result.size).toBe(0);
    });

    it('should return empty map for content without sections', () => {
      const result = parseCmateFile('Just some text without sections');
      expect(result.size).toBe(0);
    });

    it('should ignore unknown sections gracefully', () => {
      const content = `## Unknown

| A | B |
|---|---|
| 1 | 2 |
`;

      const result = parseCmateFile(content);
      expect(result.has('Unknown')).toBe(true);
      expect(result.get('Unknown')!).toHaveLength(1);
    });

    it('should handle sections with no table rows', () => {
      const content = `## Schedules

| Name | Cron | Message |
|------|------|---------|
`;

      const result = parseCmateFile(content);
      expect(result.has('Schedules')).toBe(true);
      expect(result.get('Schedules')!).toHaveLength(0);
    });

    it('should skip non-table lines within a section', () => {
      const content = `## Schedules

Some description text.

| Name | Cron | Message |
|------|------|---------|
| test | * * * * * | hello |

More text here.
`;

      const result = parseCmateFile(content);
      expect(result.get('Schedules')!).toHaveLength(1);
    });
  });

  describe('parseSchedulesSection', () => {
    it('should parse valid schedule rows', () => {
      const rows = [
        ['daily-review', '0 9 * * *', 'Review code changes', 'claude', 'true'],
      ];

      const entries = parseSchedulesSection(rows);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        name: 'daily-review',
        cronExpression: '0 9 * * *',
        message: 'Review code changes',
        cliToolId: 'claude',
        enabled: true,
      });
    });

    it('should default cliToolId to claude when not specified', () => {
      const rows = [['test', '0 9 * * *', 'hello']];

      const entries = parseSchedulesSection(rows);
      expect(entries[0].cliToolId).toBe('claude');
    });

    it('should default enabled to true when not specified', () => {
      const rows = [['test', '0 9 * * *', 'hello']];

      const entries = parseSchedulesSection(rows);
      expect(entries[0].enabled).toBe(true);
    });

    it('should parse enabled=false correctly', () => {
      const rows = [
        ['test', '0 9 * * *', 'hello', 'claude', 'false'],
      ];

      const entries = parseSchedulesSection(rows);
      expect(entries[0].enabled).toBe(false);
    });

    it('should skip rows with insufficient columns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rows = [['only-name', '0 9 * * *']]; // Missing message

      const entries = parseSchedulesSection(rows);
      expect(entries).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('should skip entries with invalid name (NAME_PATTERN violation)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rows = [
        ['invalid<script>name', '0 9 * * *', 'hello'],
      ];

      const entries = parseSchedulesSection(rows);
      expect(entries).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('invalid name')
      );
    });

    it('should skip entries with invalid cron expression', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rows = [['test', 'not-a-cron', 'hello']];

      const entries = parseSchedulesSection(rows);
      expect(entries).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('should skip entries with empty message after sanitization', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rows = [['test', '0 9 * * *', '']];

      const entries = parseSchedulesSection(rows);
      expect(entries).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('should accept Japanese names', () => {
      const rows = [
        ['\u6BCE\u65E5\u30EC\u30D3\u30E5\u30FC', '0 9 * * *', 'Review code'],
      ];

      const entries = parseSchedulesSection(rows);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('\u6BCE\u65E5\u30EC\u30D3\u30E5\u30FC');
    });

    it('should enforce MAX_SCHEDULE_ENTRIES limit', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rows = Array.from({ length: MAX_SCHEDULE_ENTRIES + 5 }, (_, i) => [
        `schedule-${i}`,
        '0 9 * * *',
        `message ${i}`,
      ]);

      const entries = parseSchedulesSection(rows);
      expect(entries).toHaveLength(MAX_SCHEDULE_ENTRIES);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Maximum schedule entries')
      );
    });
  });

  describe('sanitizeMessageContent', () => {
    it('should remove C0 control characters (except tab, newline, CR)', () => {
      const input = 'hello\x00world\x07test';
      expect(sanitizeMessageContent(input)).toBe('helloworldtest');
    });

    it('should preserve tabs, newlines, and carriage returns', () => {
      const input = 'hello\tworld\ntest\r\n';
      expect(sanitizeMessageContent(input)).toBe('hello\tworld\ntest\r\n');
    });

    it('should remove C1 control characters', () => {
      const input = 'hello\x80world\x9Ftest';
      expect(sanitizeMessageContent(input)).toBe('helloworldtest');
    });

    it('should remove zero-width characters', () => {
      const input = 'hello\u200Bworld\u200Ftest';
      expect(sanitizeMessageContent(input)).toBe('helloworldtest');
    });

    it('should remove directional control characters', () => {
      const input = 'hello\u202Eworld\u202Atest';
      expect(sanitizeMessageContent(input)).toBe('helloworldtest');
    });

    it('should remove BOM character', () => {
      const input = '\uFEFFhello';
      expect(sanitizeMessageContent(input)).toBe('hello');
    });

    it('should return empty string for all-control input', () => {
      expect(sanitizeMessageContent('\x00\x01\x02')).toBe('');
    });

    it('should return same string for clean input', () => {
      const input = 'Hello, world! This is a normal message.';
      expect(sanitizeMessageContent(input)).toBe(input);
    });
  });

  describe('CONTROL_CHAR_REGEX', () => {
    it('should match NUL character', () => {
      expect(CONTROL_CHAR_REGEX.test('\x00')).toBe(true);
    });

    it('should not match tab', () => {
      // Reset lastIndex since CONTROL_CHAR_REGEX has /g flag
      CONTROL_CHAR_REGEX.lastIndex = 0;
      expect('\t'.replace(CONTROL_CHAR_REGEX, '')).toBe('\t');
    });

    it('should not match newline', () => {
      expect('\n'.replace(CONTROL_CHAR_REGEX, '')).toBe('\n');
    });
  });

  describe('NAME_PATTERN', () => {
    it('should accept alphanumeric names', () => {
      expect(NAME_PATTERN.test('daily-review')).toBe(true);
    });

    it('should accept names with spaces', () => {
      expect(NAME_PATTERN.test('daily review')).toBe(true);
    });

    it('should accept Japanese names', () => {
      expect(NAME_PATTERN.test('\u6BCE\u65E5\u30EC\u30D3\u30E5\u30FC')).toBe(true);
    });

    it('should accept underscores', () => {
      expect(NAME_PATTERN.test('daily_review')).toBe(true);
    });

    it('should reject names with special characters', () => {
      expect(NAME_PATTERN.test('test<script>')).toBe(false);
    });

    it('should reject empty names', () => {
      expect(NAME_PATTERN.test('')).toBe(false);
    });

    it('should reject names exceeding 100 characters', () => {
      const longName = 'a'.repeat(101);
      expect(NAME_PATTERN.test(longName)).toBe(false);
    });

    it('should accept names exactly 100 characters', () => {
      const name = 'a'.repeat(100);
      expect(NAME_PATTERN.test(name)).toBe(true);
    });
  });

  describe('isValidCronExpression', () => {
    it('should accept valid 5-field cron expressions', () => {
      expect(isValidCronExpression('0 9 * * *')).toBe(true);
      expect(isValidCronExpression('*/5 * * * *')).toBe(true);
      expect(isValidCronExpression('0 0 1 * *')).toBe(true);
    });

    it('should accept 6-field cron expressions (with seconds)', () => {
      expect(isValidCronExpression('0 0 9 * * *')).toBe(true);
    });

    it('should reject expressions that are too long', () => {
      const longExpr = '* '.repeat(MAX_CRON_EXPRESSION_LENGTH);
      expect(isValidCronExpression(longExpr)).toBe(false);
    });

    it('should reject expressions with too few fields', () => {
      expect(isValidCronExpression('* * *')).toBe(false);
    });

    it('should reject expressions with too many fields', () => {
      expect(isValidCronExpression('* * * * * * * *')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidCronExpression('')).toBe(false);
    });
  });

  describe('validateCmatePath', () => {
    it('should detect path traversal via logic check', () => {
      // Test the core validation logic: validateCmatePath compares realpathSync results
      // and throws if the file is not within the worktree directory.
      // We test this by creating a temp directory structure.
      const os = require('os');
      const fs = require('fs');
      const path = require('path');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmate-test-'));
      const worktreeDir = path.join(tmpDir, 'worktree');
      const outsideDir = path.join(tmpDir, 'outside');
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      // Create CMATE.md in the correct location
      const correctFile = path.join(worktreeDir, 'CMATE.md');
      fs.writeFileSync(correctFile, '# Test');

      // Correct path should not throw
      expect(() => validateCmatePath(correctFile, worktreeDir)).not.toThrow();

      // Create a symlink outside the worktree
      const outsideFile = path.join(outsideDir, 'CMATE.md');
      fs.writeFileSync(outsideFile, '# Evil');
      const symlinkPath = path.join(worktreeDir, 'evil-link.md');
      fs.symlinkSync(outsideFile, symlinkPath);

      // Symlink pointing outside should throw
      expect(() => validateCmatePath(symlinkPath, worktreeDir)).toThrow('Path traversal detected');

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('CMATE_FILENAME constant', () => {
    it('should be CMATE.md', () => {
      expect(CMATE_FILENAME).toBe('CMATE.md');
    });
  });
});
