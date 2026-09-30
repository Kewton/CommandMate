/**
 * `commandmate respond <worktree> <n> --instance opencode-v2` (Issue #2945 D3).
 *
 * The command picks `/respond` on the DECLARED capability it reads off the
 * server (`structuredEvents.source.capabilities.eventIdentity`), so this pins
 * two things together: OpenCode V2's source now declares a per-decision id, and
 * with it the number goes to `/respond` for the resolved instance — never to
 * `/prompt-response`, which would type it at the TUI.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { opencodeV2AgentEventSource } from '../../../../src/lib/hooks/sources/opencode-v2/source';

vi.mock('../../../../src/cli/commands/instances', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/cli/commands/instances')>();
  return {
    ...actual,
    resolveInstanceTarget: vi.fn(async () => ({
      cliToolId: 'opencode-v2',
      instanceId: 'opencode-v2',
    })),
  };
});

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

/** `GET /current-output` as it describes an OpenCode V2 instance. */
const probe = {
  data: {
    isRunning: true,
    structuredEvents: {
      source: {
        cliToolId: 'opencode-v2',
        capabilities: opencodeV2AgentEventSource.capabilities,
      },
    },
  },
};

function calls(): Array<[string, { method?: string; body?: string }]> {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<
    [string, { method?: string; body?: string }]
  >;
}

async function runRespond(argv: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', ...argv]);
}

describe('OpenCode V2', () => {
  it('declares a per-decision id', () => {
    expect(opencodeV2AgentEventSource.capabilities.eventIdentity).toBe('permission-id');
  });

  it('answers an approval through /respond for the resolved instance', async () => {
    mockFetchSequence([
      probe,
      {
        data: {
          success: true,
          answer: '2',
          resolved: {
            via: 'structured-decision',
            optionNumber: 2,
            optionLabel: 'Always allow',
            decisionId: 'per_1',
          },
        },
      },
    ]);

    await runRespond(['wt1', '2', '--instance', 'opencode-v2']);

    const respondCall = calls().find((call) => String(call[0]).includes('/respond'));
    expect(respondCall?.[1].method).toBe('POST');
    expect(JSON.parse(respondCall?.[1].body ?? '{}')).toEqual({
      answer: '2',
      cliTool: 'opencode-v2',
      instanceId: 'opencode-v2',
    });
    expect(calls().some((call) => String(call[0]).includes('/prompt-response'))).toBe(false);
    expect(mockConsoleLog).toHaveBeenCalledWith('Answered approval per_1 with option 2: Always allow');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('answers a question with the choice that reached the agent', async () => {
    mockFetchSequence([
      probe,
      {
        data: {
          success: true,
          answer: '1',
          resolved: {
            via: 'structured-question',
            decisionId: 'frm_1',
            answers: [['Blue']],
            optionNumbers: [1],
            optionLabels: ['Blue'],
            freeText: false,
          },
        },
      },
    ]);

    await runRespond(['wt1', '1', '--instance', 'opencode-v2']);

    expect(mockConsoleLog).toHaveBeenCalledWith('Answered question frm_1 with 1: Blue');
    expect(mockExit).not.toHaveBeenCalled();
  });
});
