/**
 * report Command Tests
 * Issue #636: CLI report generate/show/list
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, mockFetchError, mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const sampleReport = {
  date: '2026-04-05',
  content: '# Daily Report\n\nToday we did things.',
  generatedByTool: 'claude',
  model: null,
  createdAt: '2026-04-05T10:00:00.000Z',
  updatedAt: '2026-04-05T10:00:00.000Z',
};

const sampleGetResponse = {
  report: sampleReport,
  messageCount: 42,
};

const sampleGenerateResponse = {
  report: sampleReport,
  generated: true,
};

// ---------------------------------------------------------------------------
// Command creation
// ---------------------------------------------------------------------------

describe('createReportCommand', () => {
  it('creates a Command named "report"', async () => {
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    expect(cmd.name()).toBe('report');
  });

  it('has generate, show, and list subcommands', async () => {
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    const subNames = cmd.commands.map(c => c.name());
    expect(subNames).toContain('generate');
    expect(subNames).toContain('show');
    expect(subNames).toContain('list');
  });
});

// ---------------------------------------------------------------------------
// report generate
// ---------------------------------------------------------------------------

describe('report generate', () => {
  it('generates a report for today by default', async () => {
    mockFetchResponse(sampleGenerateResponse);
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'generate']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/daily-summary'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"tool":"claude"'),
      })
    );
    // Should output the report content
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  it('passes --date option', async () => {
    mockFetchResponse(sampleGenerateResponse);
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'generate', '--date', '2026-04-04']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/daily-summary'),
      expect.objectContaining({
        body: expect.stringContaining('"date":"2026-04-04"'),
      })
    );
  });

  it('passes --tool option', async () => {
    mockFetchResponse(sampleGenerateResponse);
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'generate', '--tool', 'codex']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/daily-summary'),
      expect.objectContaining({
        body: expect.stringContaining('"tool":"codex"'),
      })
    );
  });

  it('passes --tool antigravity option (Issue #990 Phase C)', async () => {
    mockFetchResponse(sampleGenerateResponse);
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'generate', '--tool', 'antigravity']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/daily-summary'),
      expect.objectContaining({
        body: expect.stringContaining('"tool":"antigravity"'),
      })
    );
  });

  it('passes --model option', async () => {
    mockFetchResponse(sampleGenerateResponse);
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'generate', '--tool', 'copilot', '--model', 'gpt-4o']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/daily-summary'),
      expect.objectContaining({
        body: expect.stringContaining('"model":"gpt-4o"'),
      })
    );
  });

  it('passes --instruction option as userInstruction', async () => {
    mockFetchResponse(sampleGenerateResponse);
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'generate', '--instruction', 'Focus on bugs']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/daily-summary'),
      expect.objectContaining({
        body: expect.stringContaining('"userInstruction":"Focus on bugs"'),
      })
    );
  });

  it('fetches template content when --template is specified by ID', async () => {
    const templateResponse = {
      id: 'tmpl-1',
      name: 'Daily Template',
      content: 'Template instruction content',
    };
    mockFetchSequence([
      { data: templateResponse, status: 200 },
      { data: sampleGenerateResponse, status: 200 },
    ]);
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'generate', '--template', 'tmpl-1']);

    // First call: GET template
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/templates/tmpl-1'),
      expect.any(Object)
    );
    // Second call: POST daily-summary with template content as userInstruction
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/daily-summary'),
      expect.objectContaining({
        body: expect.stringContaining('Template instruction content'),
      })
    );
  });

  it('rejects invalid --tool value', async () => {
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'generate', '--tool', 'invalid']);
    expect(mockExit).toHaveBeenCalledWith(2); // CONFIG_ERROR
  });

  it('rejects invalid --date format', async () => {
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'generate', '--date', 'not-a-date']);
    expect(mockExit).toHaveBeenCalledWith(2); // CONFIG_ERROR
  });

  it('handles server error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'generate']);
    expect(mockExit).toHaveBeenCalledWith(1); // DEPENDENCY_ERROR
  });
});

// ---------------------------------------------------------------------------
// report show
// ---------------------------------------------------------------------------

describe('report show', () => {
  it('displays report content for today by default', async () => {
    mockFetchResponse(sampleGetResponse);
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'show']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/daily-summary?date='),
      expect.any(Object)
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(sampleReport.content);
  });

  it('passes --date option', async () => {
    mockFetchResponse(sampleGetResponse);
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'show', '--date', '2026-04-04']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('date=2026-04-04'),
      expect.any(Object)
    );
  });

  it('outputs JSON with --json flag', async () => {
    mockFetchResponse(sampleGetResponse);
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'show', '--json']);

    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.report).toBeDefined();
    expect(output.messageCount).toBe(42);
  });

  it('shows message when no report exists', async () => {
    mockFetchResponse({ report: null, messageCount: 0 });
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'show']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('No report found')
    );
  });

  it('rejects invalid --date format', async () => {
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'show', '--date', 'bad']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('handles server error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'show']);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// report list
// ---------------------------------------------------------------------------

describe('report list', () => {
  it('lists reports for the last 7 days by default', async () => {
    // Mock multiple sequential fetch calls (one per day)
    const responses = Array.from({ length: 7 }, (_, i) => ({
      data: {
        report: i < 3 ? sampleReport : null,
        messageCount: i < 3 ? 10 : 0,
      },
      status: 200,
    }));
    mockFetchSequence(responses);

    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'list']);

    expect(global.fetch).toHaveBeenCalledTimes(7);
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  it('accepts --days option', async () => {
    const responses = Array.from({ length: 3 }, () => ({
      data: { report: null, messageCount: 0 },
      status: 200,
    }));
    mockFetchSequence(responses);

    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'list', '--days', '3']);

    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('outputs JSON with --json flag', async () => {
    const responses = Array.from({ length: 7 }, () => ({
      data: { report: sampleReport, messageCount: 5 },
      status: 200,
    }));
    mockFetchSequence(responses);

    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'list', '--json']);

    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBe(7);
  });

  it('rejects invalid --days value (0 or negative)', async () => {
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'list', '--days', '0']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('handles server error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'report', 'list']);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// report metrics [Issue #1551]
// ---------------------------------------------------------------------------

const sampleMetrics = {
  periodDays: 7,
  tasks: {
    total: 12,
    succeeded: 9,
    failed: 2,
    notStarted: 1,
    cancelled: 0,
    successRate: 0.75,
    avgRetryLoops: 4 / 3,
  },
  verification: {
    runs: 31,
    passed: 25,
    failed: 6,
    notStarted: 0,
    passRate: 25 / 31,
    gateFailBreakdown: [
      { gateId: 'unit', failCount: 4 },
      { gateId: 'lint', failCount: 2 },
    ],
  },
  intervention: { humanResponds: 5, autoAnswered: 23, suppressedByPolicy: null },
};

/** An empty database: every rate is null and nothing failed. */
const emptyMetrics = {
  periodDays: 7,
  tasks: {
    total: 0,
    succeeded: 0,
    failed: 0,
    notStarted: 0,
    cancelled: 0,
    successRate: null,
    avgRetryLoops: null,
  },
  verification: {
    runs: 0,
    passed: 0,
    failed: 0,
    notStarted: 0,
    passRate: null,
    gateFailBreakdown: [],
  },
  intervention: { humanResponds: 0, autoAnswered: 0, suppressedByPolicy: null },
};

/** Everything console.log received, joined — the human-readable report. */
function loggedOutput(): string {
  return mockConsoleLog.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('report metrics', () => {
  it('is registered as a subcommand', async () => {
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    expect(createReportCommand().commands.map(c => c.name())).toContain('metrics');
  });

  it('requests the default 7-day window', async () => {
    mockFetchResponse({ metrics: sampleMetrics });
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    await createReportCommand().parseAsync(['node', 'report', 'metrics']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/metrics/vibe?days=7'),
      expect.anything()
    );
  });

  it('passes --days through to the API', async () => {
    mockFetchResponse({ metrics: { ...sampleMetrics, periodDays: 30 } });
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    await createReportCommand().parseAsync(['node', 'report', 'metrics', '--days', '30']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/metrics/vibe?days=30'),
      expect.anything()
    );
  });

  it('renders counts, percentages and the top gate failures', async () => {
    mockFetchResponse({ metrics: sampleMetrics });
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    await createReportCommand().parseAsync(['node', 'report', 'metrics']);

    const output = loggedOutput();
    expect(output).toContain('Vibe Metrics (last 7 days)');
    expect(output).toContain('12 total / 9 succeeded / 2 failed / 1 not-started');
    expect(output).toContain('(success 75.0%)');
    expect(output).toContain('31 runs, pass 80.6%');
    expect(output).toContain('(top fails: unit x4, lint x2)');
    expect(output).toContain('5 human responds / 23 auto answered');
    expect(output).toContain('avg 1.3 per failed task');
  });

  // A zero denominator is not 0%. Printing "success 0.0%" for a day with no
  // tasks reports a failure that did not happen.
  it('prints n/a rather than 0.0% when a rate has no denominator', async () => {
    mockFetchResponse({ metrics: emptyMetrics });
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    await createReportCommand().parseAsync(['node', 'report', 'metrics']);

    const output = loggedOutput();
    expect(output).toContain('(success n/a)');
    expect(output).toContain('pass n/a');
    expect(output).toContain('n/a per failed task');
    expect(output).not.toContain('0.0%');
    expect(output).not.toContain('top fails');
  });

  it('outputs the raw metrics object with --json', async () => {
    mockFetchResponse({ metrics: sampleMetrics });
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    await createReportCommand().parseAsync(['node', 'report', 'metrics', '--json']);

    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.tasks.successRate).toBe(0.75);
    expect(output.verification.gateFailBreakdown).toHaveLength(2);
    expect(output.intervention.suppressedByPolicy).toBeNull();
  });

  it.each(['0', '-1', '91', 'abc'])('rejects --days %s without calling the API', async (value) => {
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    await createReportCommand().parseAsync(['node', 'report', 'metrics', '--days', value]);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('--days must be an integer between 1 and 90')
    );
  });

  it('handles server error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createReportCommand } = await import('../../../../src/cli/commands/report');
    await createReportCommand().parseAsync(['node', 'report', 'metrics']);

    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
