/**
 * Tests for cmate-validator.ts
 * Issue #294: Client-side CMATE.md validation
 */

import { describe, it, expect } from 'vitest';
import {
  CMATE_TEMPLATE_CONTENT,
  COMMAND_CODE_DIRECT_WRITE_TOOLS_DENIED,
  COMMAND_CODE_PRINT_GATED_TOOLS,
  collectScheduleWarnings,
  isCommandCodeDirectWriteToolsDenied,
  isScheduleEnabled,
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

    it('should accept valid copilot permission (allow-all-tools)', () => {
      const rows = [['copilot-task', '0 * * * *', 'Do something', 'copilot', 'true', 'allow-all-tools']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should accept valid copilot permission (yolo)', () => {
      const rows = [['copilot-task', '0 * * * *', 'Do something', 'copilot', 'true', 'yolo']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should detect invalid copilot permission', () => {
      const rows = [['copilot-task', '0 * * * *', 'Do something', 'copilot', 'true', 'read-only']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('permission');
      expect(errors[0].message).toContain('invalid permission');
      expect(errors[0].message).toContain('copilot');
    });

    it('should allow empty copilot permission (DR2-005)', () => {
      const rows = [['copilot-task', '0 * * * *', 'Do something', 'copilot', 'true', '']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should allow omitted copilot permission column', () => {
      const rows = [['copilot-task', '0 * * * *', 'Do something', 'copilot', 'true']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    // Issue #989: antigravity permission validation
    it('should accept valid antigravity permission (--dangerously-skip-permissions)', () => {
      const rows = [['antigravity-task', '0 * * * *', 'Do something', 'antigravity', 'true', '--dangerously-skip-permissions']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should detect invalid antigravity permission', () => {
      const rows = [['antigravity-task', '0 * * * *', 'Do something', 'antigravity', 'true', 'read-only']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('permission');
      expect(errors[0].message).toContain('invalid permission');
      expect(errors[0].message).toContain('antigravity');
    });

    it('should allow omitted antigravity permission column', () => {
      const rows = [['antigravity-task', '0 * * * *', 'Do something', 'antigravity', 'true']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    /**
     * Issue #2454: `yolo` joins command-code's column vocabulary.
     *
     * It is the flag name (`--yolo`), not a sixth `--permission-mode` value,
     * so the validator has to check the column against
     * COMMAND_CODE_SCHEDULE_PERMISSIONS rather than against the CLI's
     * `.choices()` set -- and the parser has to agree, which
     * `cmate-parser-validator-consistency.test.ts` covers row for row.
     */
    it('should accept command-code permission yolo (Issue #2454)', () => {
      const rows = [['cc-task', '0 * * * *', 'Do something', 'command-code', 'true', 'yolo']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should accept the five command-code --permission-mode values', () => {
      for (const permission of ['default', 'standard', 'plan', 'auto-accept', 'dont-ask']) {
        const rows = [['cc-task', '0 * * * *', 'Do something', 'command-code', 'true', permission]];
        expect(validateSchedulesSection(rows), permission).toEqual([]);
      }
    });

    it('should allow an omitted command-code permission column (parser fills yolo)', () => {
      const rows = [['cc-task', '0 * * * *', 'Do something', 'command-code', 'true']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    // The widening must not let another tool's vocabulary in. Note
    // `--dangerously-skip-permissions`: `--yolo` is an alias for it, but the
    // column takes the short spelling only, so "means the same flag" is not a
    // reason to accept antigravity's word here.
    it.each(['bypassPermissions', 'acceptEdits', 'allow-all-tools', '--dangerously-skip-permissions', 'workspace-write'])(
      'should detect invalid command-code permission "%s"',
      (permission) => {
        const rows = [['cc-task', '0 * * * *', 'Do something', 'command-code', 'true', permission]];
        const errors = validateSchedulesSection(rows);
        expect(errors).toHaveLength(1);
        expect(errors[0].field).toBe('permission');
        expect(errors[0].message).toContain('invalid permission');
        expect(errors[0].message).toContain('command-code');
      },
    );

    // Issue #588: copilot --model validation
    it('should accept copilot --model with valid model name', () => {
      const rows = [['copilot-task', '0 * * * *', 'Do something', 'copilot --model gpt-4', 'true', 'allow-all-tools']];
      const errors = validateSchedulesSection(rows);
      expect(errors).toEqual([]);
    });

    it('should report error for claude --model (unsupported)', () => {
      const rows = [['task', '0 * * * *', 'msg', 'claude --model gpt-4', 'true']];
      const errors = validateSchedulesSection(rows);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.field === 'cliTool')).toBe(true);
    });

    it('should report model error for copilot --model with invalid name', () => {
      const rows = [['task', '0 * * * *', 'msg', 'copilot --model -invalid', 'true']];
      const errors = validateSchedulesSection(rows);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.field === 'model')).toBe(true);
    });

    it('should report cliTool error for unknown CLI tool', () => {
      const rows = [['task', '0 * * * *', 'msg', 'unknown-tool', 'true']];
      const errors = validateSchedulesSection(rows);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.field === 'cliTool')).toBe(true);
    });
  });

  // ==========================================================================
  // Warnings (Issue #2576)
  // ==========================================================================

  /**
   * Issue #2576: the dialog note #2454 added never reaches a schedule written by
   * editing CMATE.md, and that is the path the 9/12 incident took. These pin the
   * read-time judgment that does not depend on the dialog.
   */
  describe('isCommandCodeDirectWriteToolsDenied', () => {
    it.each(['default', 'standard', 'plan', 'auto-accept', 'dont-ask'])(
      'is true for command-code with the --permission-mode value "%s"',
      (permission) => {
        expect(isCommandCodeDirectWriteToolsDenied('command-code', permission)).toBe(true);
      },
    );

    // `yolo` is the only value that gets `--yolo`. An empty cell and an
    // out-of-vocabulary value both resolve to `yolo` in the parser, and
    // `buildCliArgs` passes `--yolo` for anything that is not one of the five
    // modes, so none of these leave the print gate on.
    it.each(['yolo', '', '   ', 'bypassPermissions', '--dangerously-skip-permissions'])(
      'is false for command-code with "%s"',
      (permission) => {
        expect(isCommandCodeDirectWriteToolsDenied('command-code', permission)).toBe(false);
      },
    );

    it('trims the cell before comparing', () => {
      expect(isCommandCodeDirectWriteToolsDenied('command-code', ' auto-accept ')).toBe(true);
    });

    // The gate is command-code's. copilot also has a `yolo`, claude also has a
    // `default`, and neither means anything to `commandcode -p`.
    it.each([
      ['claude', 'default'],
      ['copilot', 'allow-all-tools'],
      ['codex', 'read-only'],
      ['opencode', ''],
    ])('is false for %s with "%s"', (cliToolId, permission) => {
      expect(isCommandCodeDirectWriteToolsDenied(cliToolId, permission)).toBe(false);
    });

    it('names the five tools the print gate blocks', () => {
      expect([...COMMAND_CODE_PRINT_GATED_TOOLS]).toEqual([
        'edit_file',
        'write_file',
        'shell_command',
        'monitor_command',
        'kill_shell',
      ]);
    });
  });

  describe('isScheduleEnabled', () => {
    it.each([
      [undefined, true],
      ['', true],
      ['true', true],
      ['TRUE', true],
      ['false', false],
      ['no', false],
    ])('reads %s as %s', (cell, expected) => {
      expect(isScheduleEnabled(cell)).toBe(expected);
    });
  });

  describe('collectScheduleWarnings', () => {
    const header = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
`;

    it('warns about a command-code + auto-accept row written directly into CMATE.md', () => {
      const content = `${header}| githubInsights | 30 21 * * * | Collect insights | command-code | true | auto-accept |
`;
      const rows = parseCmateContent(content).get('Schedules') ?? [];

      const warnings = collectScheduleWarnings(rows);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        row: 0,
        name: 'githubInsights',
        field: 'permission',
        code: COMMAND_CODE_DIRECT_WRITE_TOOLS_DENIED,
        cliToolId: 'command-code',
        permission: 'auto-accept',
      });
    });

    it('does not block: the same row validates with zero errors', () => {
      const rows = [['githubInsights', '30 21 * * *', 'Collect insights', 'command-code', 'true', 'auto-accept']];

      expect(collectScheduleWarnings(rows)).toHaveLength(1);
      // `validateSchedulesSection` keeps its contract: an empty array means the
      // file is valid. The warning lives in a separate channel, so a schedule
      // that only reports its final answer is still a valid schedule.
      expect(validateSchedulesSection(rows)).toEqual([]);
    });

    it('says the directly-called write tools are rejected, not that the run is read-only', () => {
      const rows = [['cc-task', '0 9 * * *', 'hello', 'command-code', 'true', 'plan']];

      const [warning] = collectScheduleWarnings(rows);

      expect(warning.message).toContain('cc-task');
      expect(warning.message).toContain('directly');
      expect(warning.message).toContain('--permission-mode');
      for (const tool of COMMAND_CODE_PRINT_GATED_TOOLS) {
        expect(warning.message).toContain(tool);
      }
      expect(warning.message.toLowerCase()).not.toContain('read-only');
    });

    it('does not warn about yolo or an empty Permission cell', () => {
      const rows = [
        ['cc-yolo', '0 9 * * *', 'hello', 'command-code', 'true', 'yolo'],
        ['cc-empty', '0 9 * * *', 'hello', 'command-code', 'true', ''],
        ['cc-omitted', '0 9 * * *', 'hello', 'command-code', 'true'],
      ];
      expect(collectScheduleWarnings(rows)).toEqual([]);
    });

    it('does not warn about a row the parser would not run with a mode', () => {
      const rows = [
        // Out of vocabulary: an error, and the parser falls back to yolo.
        ['cc-invalid-perm', '0 9 * * *', 'hello', 'command-code', 'true', 'bypassPermissions'],
        // Invalid name / cron: the parser skips the row entirely.
        ['bad name!', '0 9 * * *', 'hello', 'command-code', 'true', 'plan'],
        ['cc-bad-cron', 'not a cron', 'hello', 'command-code', 'true', 'plan'],
      ];
      expect(collectScheduleWarnings(rows)).toEqual([]);
    });

    it('does not warn about other tools', () => {
      const rows = [
        ['claude-task', '0 9 * * *', 'hello', 'claude', 'true', 'default'],
        ['copilot-task', '0 9 * * *', 'hello', 'copilot', 'true', 'yolo'],
      ];
      expect(collectScheduleWarnings(rows)).toEqual([]);
    });

    it('keeps the 0-based row index of each warned row', () => {
      const rows = [
        ['claude-task', '0 9 * * *', 'hello', 'claude', 'true', 'acceptEdits'],
        ['cc-plan', '0 9 * * *', 'hello', 'command-code', 'true', 'plan'],
        ['cc-yolo', '0 9 * * *', 'hello', 'command-code', 'true', 'yolo'],
        ['cc-dont-ask', '0 9 * * *', 'hello', 'command-code', 'TRUE', 'dont-ask'],
      ];

      const warnings = collectScheduleWarnings(rows);

      expect(warnings.map((w) => [w.row, w.name, w.permission])).toEqual([
        [1, 'cc-plan', 'plan'],
        [3, 'cc-dont-ask', 'dont-ask'],
      ]);
    });

    // A disabled row is registered but never runs, and the warning is about a
    // schedule that runs unnoticed. Enabling it rewrites CMATE.md, and the next
    // read picks it up.
    it('does not warn about a disabled row, and reads Enabled the way the parser does', () => {
      const rows = [
        ['cc-disabled', '0 9 * * *', 'hello', 'command-code', 'false', 'plan'],
        ['cc-empty-enabled', '0 9 * * *', 'hello', 'command-code', '', 'plan'],
      ];

      expect(collectScheduleWarnings(rows).map((w) => w.name)).toEqual(['cc-empty-enabled']);
    });

    it('stops where the parser stops registering (MAX_SCHEDULE_ENTRIES)', () => {
      const rows = Array.from({ length: 101 }, (_, i) => [
        `cc-${i}`, '0 9 * * *', 'hello', 'command-code', 'true', 'plan',
      ]);
      // An invalid row does not count toward the limit, in the parser or here.
      rows.unshift(['bad name!', '0 9 * * *', 'hello', 'command-code', 'true', 'plan']);

      const warnings = collectScheduleWarnings(rows);

      expect(warnings).toHaveLength(100);
      expect(warnings[99].name).toBe('cc-99');
    });

    // The parser registers an out-of-vocabulary permission as `yolo`, so that
    // row takes a slot even though it is never warned about.
    it('counts a row with an out-of-vocabulary permission toward the limit', () => {
      const filler = Array.from({ length: 100 }, (_, i) => [
        `claude-${i}`, '0 9 * * *', 'hello', 'claude', 'true', 'not-a-permission',
      ]);
      const rows = [...filler, ['cc-after-limit', '0 9 * * *', 'hello', 'command-code', 'true', 'plan']];

      expect(collectScheduleWarnings(rows)).toEqual([]);
    });

    it('returns no warnings for the template', () => {
      const rows = parseCmateContent(CMATE_TEMPLATE_CONTENT).get('Schedules') ?? [];
      expect(collectScheduleWarnings(rows)).toEqual([]);
    });
  });
});
