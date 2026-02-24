/**
 * Tests for cmate-validator.ts
 * Issue #294: Client-side CMATE.md validation
 */

import { describe, it, expect } from 'vitest';
import {
  CMATE_TEMPLATE_CONTENT,
  parseCmateContent,
  validateScheduleHeaders,
  validateSchedulesSection,
} from '@/lib/cmate-validator';

describe('cmate-validator', () => {
  // ==========================================================================
  // Template round-trip
  // ==========================================================================

  describe('CMATE_TEMPLATE_CONTENT', () => {
    it('should parse and validate with zero errors (round-trip)', () => {
      const headerErrors = validateScheduleHeaders(CMATE_TEMPLATE_CONTENT);
      expect(headerErrors).toEqual([]);

      const sections = parseCmateContent(CMATE_TEMPLATE_CONTENT);
      const rows = sections.get('Schedules');
      expect(rows).toBeDefined();
      expect(rows!.length).toBeGreaterThan(0);

      const rowErrors = validateSchedulesSection(rows!);
      expect(rowErrors).toEqual([]);
    });
  });

  // ==========================================================================
  // parseCmateContent
  // ==========================================================================

  describe('parseCmateContent', () => {
    it('should parse a valid Schedules section', () => {
      const content = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| task1 | 0 * * * * | Do something | claude | true | acceptEdits |
| task2 | 0 9 * * 1 | Weekly check | codex | false | workspace-write |
`;
      const sections = parseCmateContent(content);
      expect(sections.has('Schedules')).toBe(true);
      const rows = sections.get('Schedules')!;
      expect(rows).toHaveLength(2);
      expect(rows[0][0]).toBe('task1');
      expect(rows[1][0]).toBe('task2');
    });

    it('should handle multiple sections', () => {
      const content = `## Schedules

| Name | Cron | Message |
|------|------|---------|
| t1 | 0 * * * * | msg1 |

## Other

| Key | Value |
|-----|-------|
| foo | bar |
`;
      const sections = parseCmateContent(content);
      expect(sections.has('Schedules')).toBe(true);
      expect(sections.has('Other')).toBe(true);
      expect(sections.get('Schedules')!).toHaveLength(1);
      expect(sections.get('Other')!).toHaveLength(1);
    });

    it('should return empty map for content with no sections', () => {
      const sections = parseCmateContent('just some text\nno sections here');
      expect(sections.size).toBe(0);
    });

    it('should return empty rows for section with only header', () => {
      const content = `## Schedules

| Name | Cron | Message |
|------|------|---------|
`;
      const sections = parseCmateContent(content);
      expect(sections.get('Schedules')!).toHaveLength(0);
    });
  });

  // ==========================================================================
  // validateScheduleHeaders
  // ==========================================================================

  describe('validateScheduleHeaders', () => {
    it('should return no errors for valid headers', () => {
      const content = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| task1 | 0 * * * * | msg | claude | true | acceptEdits |
`;
      expect(validateScheduleHeaders(content)).toEqual([]);
    });

    it('should detect wrong header name', () => {
      const content = `## Schedules

| Name | Cron | Message2 | CLI Tool | Enabled | Permission |
|------|------|----------|----------|---------|------------|
| task1 | 0 * * * * | msg | claude | true | acceptEdits |
`;
      const errors = validateScheduleHeaders(content);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('header');
      expect(errors[0].row).toBe(-1);
      expect(errors[0].message).toContain('Message');
      expect(errors[0].message).toContain('Message2');
    });

    it('should detect multiple wrong headers', () => {
      const content = `## Schedules

| Foo | Bar | Baz | Qux | Quux | Corge |
|-----|-----|-----|-----|------|-------|
| x | y | z | a | b | c |
`;
      const errors = validateScheduleHeaders(content);
      // 5 required header mismatches + 1 optional header mismatch (Corge != Permission)
      expect(errors).toHaveLength(6);
      expect(errors.every((e) => e.field === 'header')).toBe(true);
    });

    it('should detect missing required headers (too few columns)', () => {
      const content = `## Schedules

| Name | Cron |
|------|------|
| x | y |
`;
      const errors = validateScheduleHeaders(content);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.message.includes('(missing)'))).toBe(true);
    });

    it('should accept headers without optional Permission column', () => {
      const content = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled |
|------|------|---------|----------|---------|
| task1 | 0 * * * * | msg | claude | true |
`;
      expect(validateScheduleHeaders(content)).toEqual([]);
    });

    it('should return empty for content with no Schedules section', () => {
      const content = `## Other

| Key | Value |
|-----|-------|
| foo | bar |
`;
      expect(validateScheduleHeaders(content)).toEqual([]);
    });
  });

  // ==========================================================================
  // validateSchedulesSection
  // ==========================================================================

  describe('validateSchedulesSection', () => {
    it('should return no errors for valid rows', () => {
      const rows = [
        ['my-task', '0 * * * *', 'Do something', 'claude', 'true', 'acceptEdits'],
        ['task-2', '0 9 * * 1-5', 'Weekday job', 'codex', 'false', 'workspace-write'],
      ];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should detect insufficient columns', () => {
      const rows = [['only-name', '0 * * * *']]; // 2 columns, need 3
      const errors = validateSchedulesSection(rows);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('columns');
      expect(errors[0].row).toBe(0);
    });

    it('should detect invalid name', () => {
      const rows = [['invalid<name>', '0 * * * *', 'msg']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('name');
    });

    it('should detect invalid cron expression', () => {
      const rows = [['valid-name', 'not-a-cron', 'msg']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('cron');
    });

    it('should detect cron with too few fields', () => {
      const rows = [['name', '* *', 'msg']];
      const errors = validateSchedulesSection(rows);
      expect(errors.some((e) => e.field === 'cron')).toBe(true);
    });

    it('should detect cron with too many fields', () => {
      const rows = [['name', '* * * * * * *', 'msg']];
      const errors = validateSchedulesSection(rows);
      expect(errors.some((e) => e.field === 'cron')).toBe(true);
    });

    it('should detect empty message', () => {
      const rows = [['valid-name', '0 * * * *', '']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('message');
    });

    it('should detect whitespace-only message', () => {
      const rows = [['valid-name', '0 * * * *', '   ']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('message');
    });

    it('should collect multiple errors from different rows', () => {
      const rows = [
        ['ok', '0 * * * *', 'msg'],          // valid
        ['bad<name>', '0 * * * *', 'msg'],    // name error
        ['ok2', 'bad-cron', ''],              // cron + message errors
      ];
      const errors = validateSchedulesSection(rows);
      expect(errors.length).toBe(3);
    });

    it('should collect multiple errors from the same row', () => {
      const rows = [['bad<name>', 'not-cron', '']];
      const errors = validateSchedulesSection(rows);
      expect(errors.length).toBe(3);
      const fields = errors.map((e) => e.field);
      expect(fields).toContain('name');
      expect(fields).toContain('cron');
      expect(fields).toContain('message');
    });

    it('should allow empty permission (parser applies default)', () => {
      const rows = [['valid-name', '0 * * * *', 'msg', 'claude', 'true', '']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should not error when permission column is omitted', () => {
      const rows = [['valid-name', '0 * * * *', 'msg', 'claude', 'true']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should detect invalid permission value for claude', () => {
      const rows = [['valid-name', '0 * * * *', 'msg', 'claude', 'true', 'invalid-perm']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('permission');
      expect(errors[0].message).toContain('invalid permission');
    });

    it('should detect invalid permission value for codex', () => {
      const rows = [['valid-name', '0 * * * *', 'msg', 'codex', 'true', 'acceptEdits']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('permission');
    });

    it('should accept valid codex permission', () => {
      const rows = [['valid-name', '0 * * * *', 'msg', 'codex', 'true', 'read-only']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should accept Japanese names', () => {
      const rows = [['日次レビュー', '0 9 * * *', 'コードをレビュー']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should accept 6-field cron expressions', () => {
      const rows = [['task', '0 0 9 * * 1', 'msg']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should return empty array for empty rows', () => {
      expect(validateSchedulesSection([])).toEqual([]);
    });
  });
});
