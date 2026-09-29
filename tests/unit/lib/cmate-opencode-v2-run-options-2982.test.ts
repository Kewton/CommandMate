/**
 * OpenCode V2 run options in the CMATE.md CLI Tool column (Issue #2982).
 *
 * `opencode-v2` takes v1's column flags (`--model` / `--agent` / `--variant` /
 * `--continue` / `--title`). The one difference is `--variant`: `opencode2 run`
 * has no such flag, so the executor sends it as `-m <provider/model>#<variant>`
 * and a variant without a model is refused by the parser, the validator and the
 * writer alike — never silently dropped.
 *
 * The scheduler-entry-point half (`executeSchedule()` → `execFile`) is
 * `tests/integration/schedule-opencode-v2-run-options-2982.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  OPENCODE_COLUMN_SYNTAX,
  OPENCODE_V2_COLUMN_SYNTAX,
  TOOLS_WITH_MODEL_SUPPORT,
  parseAndValidateCliToolColumn,
  parseCliToolColumn,
  resolveScheduleCommandOptions,
  validateVariantHasModel,
} from '@/lib/cmate-cli-tool-parser';
import { parseCmateFile, parseSchedulesSection } from '@/lib/cmate-parser';
import { validateSchedulesSection } from '@/lib/cmate-validator';
import { formatCliToolColumn, serializeScheduleRow, validateScheduleInput } from '@/lib/cmate-writer';
import { buildCliArgs } from '@/lib/session/claude-executor';
import type { ScheduleWriteInput } from '@/types/cmate';

const VARIANT_NEEDS_MODEL =
  'opencode-v2 option "--variant" needs "--model" (sent as -m <provider/model>#<variant>)';

function cmate(cliTool: string): string {
  return `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| nightly | 0 3 * * * | Review today's diff | ${cliTool} | true | |
`;
}

function rowsOf(content: string): string[][] {
  return parseCmateFile(content).get('Schedules') ?? [];
}

describe('the acceptance criterion: CMATE.md -> argv (Issue #2982)', () => {
  it('opencode-v2 --model <provider/model> --agent plan launches with -m … --agent plan', () => {
    const rows = rowsOf(cmate('opencode-v2 --model anthropic/claude-sonnet-4-5 --agent plan'));
    expect(validateSchedulesSection(rows)).toEqual([]);
    const entries = parseSchedulesSection(rows);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      cliToolId: 'opencode-v2',
      model: 'anthropic/claude-sonnet-4-5',
      agent: 'plan',
    });

    const options = resolveScheduleCommandOptions(entries[0]);
    expect(options).toEqual({ model: 'anthropic/claude-sonnet-4-5', agent: 'plan' });
    expect(buildCliArgs(entries[0].message, 'opencode-v2', entries[0].permission, options)).toEqual([
      'run', '--standalone', '--format', 'json',
      '-m', 'anthropic/claude-sonnet-4-5',
      '--agent', 'plan',
      '--', "Review today's diff",
    ]);
  });

  it('folds --variant into -m model#variant, and carries -c and --title', () => {
    const rows = rowsOf(
      cmate('opencode-v2 --model anthropic/claude-sonnet-4-5 --variant high --continue --title "nightly review"'),
    );
    expect(validateSchedulesSection(rows)).toEqual([]);
    const [entry] = parseSchedulesSection(rows);
    const options = resolveScheduleCommandOptions(entry);
    expect(buildCliArgs('go', 'opencode-v2', 'default', options)).toEqual([
      'run', '--standalone', '--format', 'json',
      '-m', 'anthropic/claude-sonnet-4-5#high',
      '-c',
      '--title', 'nightly review',
      '--', 'go',
    ]);
  });
});

describe('a variant without a model is an error (Issue #2982)', () => {
  it('parseCliToolColumn refuses it', () => {
    expect(parseCliToolColumn('opencode-v2 --variant high')).toEqual({
      cliToolId: 'opencode-v2',
      error: VARIANT_NEEDS_MODEL,
    });
    expect(parseCliToolColumn('opencode-v2 --agent plan --variant high').error).toBe(VARIANT_NEEDS_MODEL);
  });

  it('the validator reports it and the parser skips the row', () => {
    const rows = rowsOf(cmate('opencode-v2 --variant high'));
    const errors = validateSchedulesSection(rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: 'cliTool' });
    expect(parseSchedulesSection(rows)).toEqual([]);
  });

  it('`#` in the model is not a way around it (invalid model)', () => {
    const { errors } = parseAndValidateCliToolColumn('opencode-v2 --model a/b#high');
    expect(errors).toEqual(['Model name contains invalid characters']);
  });

  it('v1 keeps accepting a model-less --variant (opencode run has the flag)', () => {
    expect(parseCliToolColumn('opencode --variant high')).toEqual({ cliToolId: 'opencode', variant: 'high' });
    expect(validateVariantHasModel('opencode', undefined, 'high')).toBeUndefined();
  });
});

describe('the v2 grammar in error messages (Issue #2982)', () => {
  it('names the v2 syntax for an unknown v2 flag', () => {
    expect(parseCliToolColumn('opencode-v2 --agnet plan').error).toBe(
      `opencode-v2 only supports: ${OPENCODE_V2_COLUMN_SYNTAX}`,
    );
  });

  it('leaves v1 and copilot messages as they were', () => {
    expect(parseCliToolColumn('opencode --agnet plan').error).toBe(
      `opencode only supports: ${OPENCODE_COLUMN_SYNTAX}`,
    );
    expect(parseCliToolColumn('copilot --agent plan').error).toBe(
      'copilot only supports: copilot --model <modelName>',
    );
    expect(parseCliToolColumn('claude --model x').error).toBe(
      'CLI Tool "claude" does not support additional options',
    );
  });

  it('opencode-v2 takes --model', () => {
    expect(TOOLS_WITH_MODEL_SUPPORT.has('opencode-v2')).toBe(true);
  });
});

describe('the writer (screen / API) writes the same values (Issue #2982)', () => {
  const base: ScheduleWriteInput = {
    name: 'nightly',
    cronExpression: '0 3 * * *',
    message: "Review today's diff",
    cliToolId: 'opencode-v2',
    enabled: true,
    permission: 'default',
  };

  it('serializes v2 run options in v1\'s fixed order, and the parser reads them back', () => {
    const input: ScheduleWriteInput = {
      ...base,
      model: 'anthropic/claude-sonnet-4-5',
      agent: 'plan',
      variant: 'high',
      continueSession: true,
      title: 'nightly review',
    };
    expect(validateScheduleInput(input)).toEqual({ valid: true, errors: [] });
    const column = formatCliToolColumn(input.cliToolId, input.model, input);
    expect(column).toBe(
      'opencode-v2 --model anthropic/claude-sonnet-4-5 --agent plan --variant high --continue --title "nightly review"',
    );

    const content = `## Schedules\n\n| Name | Cron | Message | CLI Tool | Enabled | Permission |\n|------|------|---------|----------|---------|------------|\n${serializeScheduleRow(input)}\n`;
    const [entry] = parseSchedulesSection(rowsOf(content));
    expect(entry).toMatchObject({
      cliToolId: 'opencode-v2',
      model: 'anthropic/claude-sonnet-4-5',
      agent: 'plan',
      variant: 'high',
      continueSession: true,
      title: 'nightly review',
      permission: 'default',
    });
  });

  it('writes the acceptance-criterion row', () => {
    const input = { ...base, model: 'anthropic/claude-sonnet-4-5', agent: 'plan' };
    expect(validateScheduleInput(input).valid).toBe(true);
    expect(formatCliToolColumn(input.cliToolId, input.model, input)).toBe(
      'opencode-v2 --model anthropic/claude-sonnet-4-5 --agent plan',
    );
  });

  it('refuses a variant without a model, before touching the file', () => {
    const result = validateScheduleInput({ ...base, variant: 'high' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([VARIANT_NEEDS_MODEL]);
  });

  it('still accepts a model-less variant for v1', () => {
    const result = validateScheduleInput({ ...base, cliToolId: 'opencode', permission: '', variant: 'high' });
    expect(result).toEqual({ valid: true, errors: [] });
  });
});
