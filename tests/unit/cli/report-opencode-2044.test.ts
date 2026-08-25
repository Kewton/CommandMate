/**
 * `commandmate report generate --tool opencode` (Issue #2044)
 *
 * The CLI keeps its own copy of the allowed tool list — the CLI bundle does not
 * pull `@/config` — so the two can drift, and drifting means `--tool opencode`
 * is rejected client-side by a list the server would have accepted (or worse,
 * the reverse). This suite is the join: it reads the option description the CLI
 * builds from its own array and checks it against the server's constant.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SUMMARY_ALLOWED_TOOLS } from '@/config/review-config';
import { mockFetchResponse, restoreFetch } from '../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleError.mockClear();
  mockConsoleLog.mockClear();
});

async function generateOption() {
  const { createReportCommand } = await import('@/cli/commands/report');
  const generate = createReportCommand().commands.find((c) => c.name() === 'generate')!;
  return generate.options.find((o) => o.long === '--tool')!;
}

describe('the CLI tool list mirrors the server whitelist (Issue #2044)', () => {
  it('names every SUMMARY_ALLOWED_TOOLS id in the --tool description', async () => {
    const option = await generateOption();
    for (const tool of SUMMARY_ALLOWED_TOOLS) {
      expect(option.description, tool).toContain(tool);
    }
  });

  it('lists them in the same order, so the two arrays are the same list', async () => {
    const option = await generateOption();
    expect(option.description).toContain(SUMMARY_ALLOWED_TOOLS.join(', '));
  });

  it('still defaults to claude', async () => {
    const option = await generateOption();
    expect(option.defaultValue).toBe('claude');
  });
});

describe('report generate --tool opencode (Issue #2044)', () => {
  it('is accepted and posted to the API', async () => {
    mockFetchResponse({
      report: {
        date: '2026-08-25',
        content: 'hello-2044 report body',
        generatedByTool: 'opencode',
        model: null,
        createdAt: '2026-08-25T10:00:00.000Z',
        updatedAt: '2026-08-25T10:00:00.000Z',
      },
      generated: true,
    });

    const { createReportCommand } = await import('@/cli/commands/report');
    await createReportCommand().parseAsync(
      ['generate', '--date', '2026-08-25', '--tool', 'opencode'],
      { from: 'user' },
    );

    expect(mockConsoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('Invalid tool'),
    );
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.tool).toBe('opencode');
  });

  it('still rejects a tool nobody supports', async () => {
    const { createReportCommand } = await import('@/cli/commands/report');
    await createReportCommand().parseAsync(
      ['generate', '--date', '2026-08-25', '--tool', 'nonesuch'],
      { from: 'user' },
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Invalid tool'));
  });
});
