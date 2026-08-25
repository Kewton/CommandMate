/**
 * `opencode --agent plan --variant high` from CMATE.md to argv (Issue #2044)
 *
 * Issue #2044's second acceptance criterion is that a CMATE.md schedule written
 * as `opencode --agent plan --variant high` launches with those arguments. This
 * suite walks the whole path a row travels — column text → `parseCliToolColumn`
 * → `parseSchedulesSection` → `resolveScheduleCommandOptions` → `buildCliArgs` —
 * and asserts the argv at the end of it.
 *
 * ## What this suite does and does not prove
 *
 * It proves the *column grammar* end of the path: text in, options out, argv
 * out. It says nothing about whether `executeSchedule()` calls the resolver —
 * that is `tests/integration/schedule-opencode-run-options-2044.test.ts`, which
 * drives the scheduler entry point and asserts the argv `execFile` receives.
 * The two are kept apart on purpose: this file would stay green if the
 * scheduler stopped calling the resolver, which is exactly the gap #2044's
 * first pass shipped with.
 *
 * Every flag asserted here was confirmed against opencode 1.18.22 in an isolated
 * `HOME`: after `--agent plan --variant high --title cm-2044-probe`,
 * `GET /session` answered `agent: "plan"`, `model.variant: "high"` and
 * `title: "cm-2044-probe"`. See `docs/design/opencode-server-live-verification.md` §15.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCliToolColumn,
  parseAndValidateCliToolColumn,
  resolveScheduleCommandOptions,
  tokenizeCliToolColumn,
  TOOLS_WITH_RUN_OPTIONS,
} from '@/lib/cmate-cli-tool-parser';
import { parseSchedulesSection, parseCmateFile } from '@/lib/cmate-parser';
import { validateSchedulesSection, parseCmateContent } from '@/lib/cmate-validator';
import { formatCliToolColumn, serializeScheduleRow, validateScheduleInput } from '@/lib/cmate-writer';
import { buildCliArgs } from '@/lib/session/claude-executor';

const CMATE_WITH_OPENCODE = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| nightly | 0 3 * * * | Review today's diff | opencode --agent plan --variant high | true | |
`;

describe('the acceptance criterion: CMATE.md -> argv (Issue #2044)', () => {
  it('launches with --agent plan --variant high', () => {
    const config = parseCmateFile(CMATE_WITH_OPENCODE);
    const entries = parseSchedulesSection(config.get('Schedules') ?? []);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.cliToolId).toBe('opencode');
    expect(entry.agent).toBe('plan');
    expect(entry.variant).toBe('high');

    const options = resolveScheduleCommandOptions(entry);
    expect(options).toEqual({ agent: 'plan', variant: 'high' });

    expect(buildCliArgs(entry.message, entry.cliToolId, entry.permission, options)).toEqual([
      'run',
      '--format',
      'json',
      '--agent',
      'plan',
      '--variant',
      'high',
      "Review today's diff",
    ]);
  });

  it('accepts the row without complaint on the validator side too', () => {
    const rows = parseCmateContent(CMATE_WITH_OPENCODE).get('Schedules') ?? [];
    expect(validateSchedulesSection(rows)).toEqual([]);
  });

  it('carries all four options plus the model into argv', () => {
    const entry = {
      cliToolId: 'opencode',
      model: 'github-copilot/claude-sonnet-4.6',
      agent: 'plan',
      variant: 'high',
      continueSession: true,
      title: 'nightly-review',
    };
    expect(buildCliArgs('go', 'opencode', '', resolveScheduleCommandOptions(entry))).toEqual([
      'run',
      '--format',
      'json',
      '-m',
      'github-copilot/claude-sonnet-4.6',
      '--agent',
      'plan',
      '--variant',
      'high',
      '-c',
      '--title',
      'nightly-review',
      'go',
    ]);
  });

  it('puts the message last, so a message starting with - is not read as a flag', () => {
    const args = buildCliArgs('--not-a-flag', 'opencode', '', { agent: 'plan' });
    expect(args[args.length - 1]).toBe('--not-a-flag');
  });
});

describe('parseCliToolColumn: opencode flag list (Issue #2044)', () => {
  it('reads flags in any order', () => {
    expect(parseCliToolColumn('opencode --variant high --agent plan')).toEqual({
      cliToolId: 'opencode',
      agent: 'plan',
      variant: 'high',
    });
  });

  it.each([['--continue'], ['-c']])('reads %s as a boolean', (flag) => {
    expect(parseCliToolColumn(`opencode ${flag}`)).toEqual({
      cliToolId: 'opencode',
      continueSession: true,
    });
  });

  it.each([['--model'], ['-m']])('reads %s as the model', (flag) => {
    expect(parseCliToolColumn(`opencode ${flag} ollama/qwen3:8b`)).toEqual({
      cliToolId: 'opencode',
      model: 'ollama/qwen3:8b',
    });
  });

  it('reads a quoted title as one value', () => {
    expect(parseCliToolColumn('opencode --title "nightly review"')).toEqual({
      cliToolId: 'opencode',
      title: 'nightly review',
    });
  });

  it.each([
    ['opencode --agnet plan', 'unknown flag'],
    ['opencode --agent', 'missing value at the end'],
    ['opencode --agent --title x', 'a flag where a value belongs'],
    ['opencode --agent a --agent b', 'a repeated flag'],
    ['opencode -m x --model y', 'a repeated flag under its other spelling'],
    ['opencode --title "unterminated', 'an unterminated quote'],
  ])('refuses %s (%s)', (raw) => {
    const parsed = parseCliToolColumn(raw);
    expect(parsed.error, raw).toBeTruthy();
  });

  it('never echoes a raw value back in an error message (DR4-002)', () => {
    const parsed = parseCliToolColumn('opencode --sudo rm -rf /');
    expect(parsed.error).toBeTruthy();
    expect(parsed.error).not.toContain('rm -rf');
  });
});

describe('the other tools keep their grammar (Issue #2044)', () => {
  it('copilot still accepts only --model <name>', () => {
    expect(parseCliToolColumn('copilot --model gpt-5.4-mini')).toEqual({
      cliToolId: 'copilot',
      model: 'gpt-5.4-mini',
    });
    expect(parseCliToolColumn('copilot --agent plan').error).toBeTruthy();
    expect(parseCliToolColumn('copilot --model a --continue').error).toBeTruthy();
  });

  it('claude still refuses any option at all', () => {
    expect(parseCliToolColumn('claude --model x').error).toBeTruthy();
    expect(parseCliToolColumn('claude --agent plan').error).toBeTruthy();
    expect(parseCliToolColumn('claude')).toEqual({ cliToolId: 'claude', model: undefined });
  });

  it('opencode is the only tool with the flag-list grammar', () => {
    expect([...TOOLS_WITH_RUN_OPTIONS]).toEqual(['opencode']);
  });

  it('leaves claude and codex argv untouched', () => {
    expect(buildCliArgs('hi', 'claude')).toEqual([
      '-p', 'hi', '--output-format', 'text', '--permission-mode', 'acceptEdits',
    ]);
    expect(buildCliArgs('hi', 'codex')).toEqual(['exec', 'hi', '--sandbox', 'workspace-write']);
  });

  it('drops opencode options handed to a tool that has none', () => {
    const options = resolveScheduleCommandOptions({
      cliToolId: 'copilot',
      model: 'gpt-5',
      agent: 'plan',
      variant: 'high',
      continueSession: true,
      title: 't',
    });
    expect(options).toEqual({ model: 'gpt-5' });
  });

  it('answers undefined when a row asks for nothing', () => {
    expect(resolveScheduleCommandOptions({ cliToolId: 'opencode' })).toBeUndefined();
    expect(resolveScheduleCommandOptions({ cliToolId: 'claude', model: 'x' })).toBeUndefined();
  });
});

describe('validation of the option values (Issue #2044)', () => {
  it.each([
    ['opencode --agent ../../etc', 'a path'],
    ['opencode --variant "high low"', 'a space'],
    ['opencode --agent p@lan', 'an @'],
  ])('rejects %s (%s)', (raw) => {
    const { errors } = parseAndValidateCliToolColumn(raw);
    expect(errors.length, raw).toBeGreaterThan(0);
  });

  it('rejects a title starting with - so it cannot become another option', () => {
    const { errors } = parseAndValidateCliToolColumn('opencode --title "-p"');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a title with spaces and non-ASCII', () => {
    const { result, errors } = parseAndValidateCliToolColumn('opencode --title "夜間レビュー 1"');
    expect(errors).toEqual([]);
    expect(result.title).toBe('夜間レビュー 1');
  });
});

describe('tokenizeCliToolColumn (Issue #2044)', () => {
  it.each([
    ['opencode', ['opencode']],
    ['opencode  --agent   plan', ['opencode', '--agent', 'plan']],
    ['opencode --title "a b"', ['opencode', '--title', 'a b']],
    ["opencode --title 'a b'", ['opencode', '--title', 'a b']],
    ['opencode --title ""', ['opencode', '--title', '']],
  ])('tokenizes %s', (raw, expected) => {
    expect(tokenizeCliToolColumn(raw).tokens).toEqual(expected);
  });

  it('reports an unterminated quote', () => {
    expect(tokenizeCliToolColumn('opencode --title "a').error).toBeTruthy();
  });
});

describe('the writer round-trips what the parser reads (Issue #2044)', () => {
  it('serializes every option in a fixed order', () => {
    expect(
      formatCliToolColumn('opencode', 'ollama/qwen3:8b', {
        agent: 'plan',
        variant: 'high',
        continueSession: true,
        title: 'nightly',
      }),
    ).toBe('opencode --model ollama/qwen3:8b --agent plan --variant high --continue --title nightly');
  });

  it('quotes a title containing whitespace', () => {
    expect(formatCliToolColumn('opencode', undefined, { title: 'nightly review' }))
      .toBe('opencode --title "nightly review"');
  });

  it('ignores run options for a tool that has none', () => {
    expect(formatCliToolColumn('copilot', 'gpt-5', { agent: 'plan', continueSession: true }))
      .toBe('copilot --model gpt-5');
  });

  it.each([
    { agent: 'plan', variant: 'high' },
    { agent: 'plan', continueSession: true },
    { title: 'nightly review' },
    { model: 'anthropic/claude-sonnet-4-5', agent: 'build', variant: 'max', title: 'x' },
  ])('a written row parses back to the same options: %j', (options) => {
    const row = serializeScheduleRow({
      name: 'nightly',
      cronExpression: '0 3 * * *',
      message: 'go',
      cliToolId: 'opencode',
      enabled: true,
      permission: '',
      ...options,
    });

    const entries = parseSchedulesSection(
      parseCmateFile(`## Schedules\n\n| a | b | c | d | e | f |\n|---|---|---|---|---|---|\n${row}\n`)
        .get('Schedules') ?? [],
    );
    expect(entries).toHaveLength(1);
    expect({
      model: entries[0].model,
      agent: entries[0].agent,
      variant: entries[0].variant,
      continueSession: entries[0].continueSession,
      title: entries[0].title,
    }).toEqual({
      model: undefined,
      agent: undefined,
      variant: undefined,
      continueSession: undefined,
      title: undefined,
      ...options,
    });
  });

  it('refuses run options for a tool with no such flags, before touching the file', () => {
    const { valid, errors } = validateScheduleInput({
      name: 'nightly',
      cronExpression: '0 3 * * *',
      message: 'go',
      cliToolId: 'claude',
      enabled: true,
      agent: 'plan',
    });
    expect(valid).toBe(false);
    expect(errors.join(' ')).toContain('run options');
  });

  it('refuses an invalid agent before touching the file', () => {
    const { valid } = validateScheduleInput({
      name: 'nightly',
      cronExpression: '0 3 * * *',
      message: 'go',
      cliToolId: 'opencode',
      enabled: true,
      agent: '../escape',
    });
    expect(valid).toBe(false);
  });

  it('accepts the row the acceptance criterion names', () => {
    const { valid, errors } = validateScheduleInput({
      name: 'nightly',
      cronExpression: '0 3 * * *',
      message: 'go',
      cliToolId: 'opencode',
      enabled: true,
      agent: 'plan',
      variant: 'high',
    });
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });
});
