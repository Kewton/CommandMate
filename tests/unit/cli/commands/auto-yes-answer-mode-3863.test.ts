/**
 * Issue #3863: the answer mode on the CLI.
 *
 * - `auto-yes --enable --answer-mode <m>` sends `answerMode`; omitted, the body
 *   is what it was (the server keeps a live grant's mode). A bad value, or a
 *   mode with `--disable`, is exit 2. The mode the server answered is printed
 *   when it was asked for or is not the default.
 * - `send --auto-yes --auto-yes-answer-mode <m>` likewise; without
 *   `--auto-yes` it is exit 2.
 * - `instances --json` carries `autoYesAnswerMode` for an armed instance.
 * - `wait` names the mode on its withholding line and in the exit-10 JSON.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { mockFetchResponse, mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeAll(async () => {
  await import('../../../../src/cli/commands/wait');
  await import('../../../../src/cli/utils/api-client');
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

const stderrLines = (): string[] => mockConsoleError.mock.calls.map((call) => String(call[0]));
const bodyOf = (call: unknown[]): Record<string, unknown> =>
  JSON.parse(String((call[1] as { body: string }).body)) as Record<string, unknown>;

async function autoYes(...args: string[]): Promise<void> {
  const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
  await createAutoYesCommand().parseAsync(['node', 'auto-yes', 'wt1', ...args]);
}

describe('[#3863] auto-yes --answer-mode', () => {
  it('sends the mode and prints the one the server put it on with', async () => {
    mockFetchResponse({ enabled: true, expiresAt: 1, answerMode: 'careful', cliToolId: 'claude', instanceId: 'claude' });
    await autoYes('--enable', '--answer-mode', 'careful');

    const call = vi.mocked(global.fetch).mock.calls.find(([url]) => String(url).includes('/auto-yes'))!;
    expect(bodyOf(call)).toEqual({ enabled: true, duration: 3_600_000, answerMode: 'careful' });
    expect(stderrLines()).toEqual([
      'Auto-yes enabled for wt1 (claude).',
      'Answer mode: careful (questions are left to you; permissions are still answered).',
    ]);
  });

  it('omitted: the body is what it was, and a mode the server kept is still said when it is careful', async () => {
    mockFetchResponse({ enabled: true, expiresAt: 1, answerMode: 'careful', cliToolId: 'claude', instanceId: 'claude' });
    await autoYes('--enable');

    const call = vi.mocked(global.fetch).mock.calls.find(([url]) => String(url).includes('/auto-yes'))!;
    expect(bodyOf(call)).toEqual({ enabled: true, duration: 3_600_000 });
    expect(stderrLines()).toContain('Answer mode: careful (questions are left to you; permissions are still answered).');
  });

  it('negative: omitted and the default came back — the output it always printed', async () => {
    mockFetchResponse({ enabled: true, expiresAt: 1, answerMode: 'recommended', cliToolId: 'claude', instanceId: 'claude' });
    await autoYes('--enable');
    expect(stderrLines()).toEqual(['Auto-yes enabled for wt1 (claude).']);
  });

  it.each([
    [['--enable', '--answer-mode', 'auto']],
    [['--disable', '--answer-mode', 'careful']],
  ])('%j: exit 2', async (args) => {
    mockFetchResponse({});
    await autoYes(...args);
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});

describe('[#3863] send --auto-yes-answer-mode', () => {
  it('arms with the mode before sending', async () => {
    mockFetchSequence([
      { data: { enabled: true, expiresAt: 1, answerMode: 'careful' } },
      { data: { id: 1 }, status: 201 },
    ]);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'go', '--auto-yes', '--auto-yes-answer-mode', 'careful']);

    const call = vi.mocked(global.fetch).mock.calls.find(([url]) => String(url).includes('/auto-yes'))!;
    expect(bodyOf(call)).toMatchObject({ enabled: true, answerMode: 'careful' });
    expect(stderrLines()).toContain('Answer mode: careful (questions are left to you; permissions are still answered).');
  });

  it.each([
    [['--auto-yes-answer-mode', 'careful']],
    [['--auto-yes', '--auto-yes-answer-mode', 'yes']],
  ])('%j: exit 2', async (args) => {
    mockFetchResponse({ id: 1 }, 201);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'go', ...args]);
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});

describe('[#3863] instances --json', () => {
  it('an armed instance carries the mode of the state store; a disarmed one carries none', async () => {
    mockFetchSequence([
      { data: { id: 'wt1', name: 'main', agentInstances: [
        { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
        { id: 'claude-2', cliTool: 'claude', alias: 'Two', order: 1 },
      ] } },
      { data: { isRunning: true, autoYes: { enabled: true }, autoYesAnswerMode: 'recommended' } },
      { data: { isRunning: false } },
      { data: {
        instances: { claude: { enabled: true, expiresAt: 1 }, 'claude-2': { enabled: false, expiresAt: null } },
        answerModeByInstance: { claude: 'careful' },
      } },
    ]);
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', 'wt1', '--json']);

    const rows = JSON.parse(mockConsoleLog.mock.calls[0][0]) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ instanceId: 'claude', autoYes: true, autoYesAnswerMode: 'careful' });
    expect(rows[1]).not.toHaveProperty('autoYesAnswerMode');
  });
});

describe('[#3863] wait names the mode of a withheld question', () => {
  it('stderr says answerMode=, and the exit-10 JSON carries autoYesSuppression.answerMode', async () => {
    const frame = {
      isRunning: true,
      isPromptWaiting: true,
      content: 'claude',
      fullOutput: 'claude',
      realtimeSnippet: '',
      lineCount: 1,
      lastCapturedLine: 1,
      thinking: false,
      cliToolId: 'claude',
      isSelectionListActive: false,
      lastServerResponseTimestamp: null,
      serverPollerActive: true,
      sessionStatus: 'waiting' as const,
      sessionStatusReason: 'prompt_detected',
      promptData: {
        type: 'multiple_choice',
        question: 'Which approach?',
        options: [
          { number: 1, label: 'A (Recommended)', isDefault: true },
          { number: 2, label: 'B' },
        ],
        status: 'pending',
        isAskUserQuestion: true,
      },
      autoYes: {
        enabled: true,
        expiresAt: null,
        lastSuppression: { reason: 'question-left-to-human', mode: null, promptType: 'multiple_choice', at: Date.now() },
      },
      autoYesAnswerMode: 'careful',
    };
    mockFetchSequence(Array.from({ length: 3 }, () => ({ data: frame })));
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderrLines().join('\n')).toContain('reason=question-left-to-human mode=none promptType=multiple_choice answerMode=careful');
    const output = JSON.parse(String(mockConsoleLog.mock.calls[0][0])) as Record<string, unknown>;
    expect(output.autoYesSuppression).toMatchObject({ reason: 'question-left-to-human', answerMode: 'careful' });
  });
});
