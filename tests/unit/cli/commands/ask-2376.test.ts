/**
 * `commandmate ask` — one round trip to another agent session (Issue #2376).
 *
 * What is pinned here is the contract the GUI's delegation brief promises to
 * session A, because the brief is what an agent will be following:
 *
 *   - exit 0 prints the REPLY BODY on stdout and nothing else, so a caller can
 *     use the output directly;
 *   - exit 10 prints the prompt JSON and does not answer it;
 *   - the reply is the one written AFTER the send, never the previous turn's;
 *   - a tool with no transcript falls back to the pane, and says so;
 *   - there is no `--auto-yes`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

/** A frame that says "the turn ended", as `wait`'s own tests spell it. */
const completedFrame = {
  isRunning: true,
  isComplete: true,
  isPromptWaiting: false,
  isGenerating: false,
  content: 'done',
  fullOutput: 'done',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  thinkingMessage: null,
  cliToolId: 'codex',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
};

function resolveTarget(cliToolId: string, instanceId: string) {
  return { data: { cliToolId, instanceId, resolvedBy: 'roster', conflict: null } };
}

/**
 * A reply row as a transcript reader writes it.
 *
 * `requestId` is not decoration: since Issue #2386 a row with no `<tool>-turn:`
 * marker is a screen scrape rather than the agent's words, and `ask` will not
 * print one for a tool that has a transcript reader. A fixture without it would
 * be asserting the defect.
 */
function chatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    worktreeId: 'wt1',
    role: 'assistant',
    content: '2 です',
    timestamp: new Date(Date.now() + 1000).toISOString(),
    messageType: 'normal',
    requestId: 'codex-turn:01a07a6a',
    archived: false,
    ...overrides,
  };
}

function callsTo(fragment: string): [string, { body?: string }][] {
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return calls.filter((c) => String(c[0]).includes(fragment)) as [string, { body?: string }][];
}

describe('createAskCommand', () => {
  it('creates a Command named "ask"', async () => {
    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    expect(createAskCommand().name()).toBe('ask');
  });

  it('offers no --auto-yes: another session\'s guard rails are not ask\'s to change', async () => {
    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    const flags = createAskCommand().options.map((o) => o.long);
    expect(flags).not.toContain('--auto-yes');
    expect(flags).toContain('--instance');
    expect(flags).toContain('--timeout');
  });
});

describe('ask: the successful round trip', () => {
  it('sends, waits, and prints only the reply body on stdout', async () => {
    mockFetchSequence([
      resolveTarget('codex', 'codex-2'),
      { data: { id: 1, role: 'user', content: '1+1は？' }, status: 201 },
      { data: completedFrame },
      { data: [chatRow()] },
    ]);

    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    await createAskCommand().parseAsync(
      ['node', 'ask', 'wt1', '1+1は？', '--instance', 'codex-2']
    );

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    expect(mockConsoleLog).toHaveBeenCalledWith('2 です');
  });

  it('sends the resolved tool and instance, never the raw selector', async () => {
    mockFetchSequence([
      resolveTarget('codex', 'codex-2'),
      { data: { id: 1 }, status: 201 },
      { data: completedFrame },
      { data: [chatRow()] },
    ]);

    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    await createAskCommand().parseAsync(
      ['node', 'ask', 'wt1', 'hello', '--instance', 'Codex 2']
    );

    const [sendCall] = callsTo('/send');
    expect(JSON.parse(sendCall[1].body ?? '{}')).toEqual({
      content: 'hello',
      cliToolId: 'codex',
      instanceId: 'codex-2',
    });
    // …and the alias reached the one endpoint that knows how to read one.
    // `+` for the space: URLSearchParams serializes form-encoded, and
    // `searchParams.get()` on the route side decodes it back to `Codex 2`.
    expect(String(callsTo('/resolve-target')[0][0])).toContain('instance=Codex+2');
  });

  // Issue #2386: for a tool with a transcript reader `ask` now holds out for a
  // turn row for a few seconds before giving up, so the two "there is no answer
  // here" cases below have to be driven through that window. Timers are faked
  // rather than waited on; the fetch sequence runs dry inside the window and
  // every further read fails closed, which is the state under test.
  it('ignores an assistant row written before the send (previous turn)', async () => {
    vi.useFakeTimers();
    const stale = chatRow({
      id: 'old',
      content: 'answer to the PREVIOUS question',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    });
    mockFetchSequence([
      resolveTarget('codex', 'codex'),
      { data: { id: 1 }, status: 201 },
      { data: completedFrame },
      { data: [stale] },
    ]);

    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    const pending = createAskCommand().parseAsync(
      ['node', 'ask', 'wt1', 'hi', '--instance', 'codex']
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError.mock.calls.flat().join('\n')).toContain('no reply could be read');
  });

  it('never prints a prompt row as if it were an answer', async () => {
    vi.useFakeTimers();
    const promptRow = chatRow({
      messageType: 'prompt',
      content: 'Continue?',
      timestamp: new Date(Date.now() + 1000).toISOString(),
    });
    mockFetchSequence([
      resolveTarget('codex', 'codex'),
      { data: { id: 1 }, status: 201 },
      { data: completedFrame },
      { data: [promptRow] },
    ]);

    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    const pending = createAskCommand().parseAsync(
      ['node', 'ask', 'wt1', 'hi', '--instance', 'codex']
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(mockConsoleLog).not.toHaveBeenCalled();
  });
});

describe('ask: falling back to the pane', () => {
  it('reads the squeezed pane when the ledger has nothing, and reports source', async () => {
    mockFetchSequence([
      resolveTarget('copilot', 'copilot'),
      { data: { id: 1 }, status: 201 },
      { data: { ...completedFrame, cliToolId: 'copilot' } },
      { data: [] },
      { data: { output: 'copilot said this\n' } },
    ]);

    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    await createAskCommand().parseAsync(
      ['node', 'ask', 'wt1', 'hi', '--instance', 'copilot', '--json']
    );

    const payload = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(payload.source).toBe('pane');
    expect(payload.reply).toContain('copilot said this');
    expect(payload.instanceId).toBe('copilot');
    expect(payload.cliToolId).toBe('copilot');
  });

  it('reports source=history when the ledger answered', async () => {
    mockFetchSequence([
      resolveTarget('codex', 'codex'),
      { data: { id: 1 }, status: 201 },
      { data: completedFrame },
      { data: [chatRow()] },
    ]);

    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    await createAskCommand().parseAsync(
      ['node', 'ask', 'wt1', 'hi', '--instance', 'codex', '--json']
    );

    const payload = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(payload.source).toBe('history');
  });
});

describe('ask: exit codes are wait\'s exit codes', () => {
  it('exits 10 with the prompt JSON, and answers nothing', async () => {
    const promptFrame = {
      ...completedFrame,
      isPromptWaiting: true,
      sessionStatus: 'waiting' as const,
      promptData: {
        type: 'yes_no',
        question: 'Continue?',
        options: ['yes', 'no'],
        status: 'pending',
      },
    };
    mockFetchSequence([
      resolveTarget('codex', 'codex'),
      { data: { id: 1 }, status: 201 },
      { data: promptFrame },
    ]);

    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    await createAskCommand().parseAsync(['node', 'ask', 'wt1', 'hi', '--instance', 'codex']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    const payload = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(payload.type).toBe('yes_no');
    expect(payload.question).toBe('Continue?');
    // Nothing was answered on the other session's behalf.
    expect(callsTo('/prompt-response')).toHaveLength(0);
  });

  it('refuses to send into an open dialog and says what to do', async () => {
    mockFetchSequence([
      resolveTarget('codex', 'codex'),
      {
        data: {
          error: 'wt1 is waiting on a prompt; the message was not sent.',
          code: 'PROMPT_WAITING',
        },
        status: 409,
      },
    ]);

    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    await createAskCommand().parseAsync(['node', 'ask', 'wt1', 'hi', '--instance', 'codex']);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError.mock.calls.flat().join('\n')).toContain('waiting on a prompt');
  });
});

describe('ask: input validation', () => {
  it('rejects a --timeout that is not a positive integer', async () => {
    mockFetchSequence([]);
    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    await createAskCommand().parseAsync(
      ['node', 'ask', 'wt1', 'hi', '--timeout', 'soon']
    );
    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError.mock.calls.flat().join('\n')).toContain('--timeout');
  });

  it('rejects an empty message', async () => {
    mockFetchSequence([]);
    const { createAskCommand } = await import('../../../../src/cli/commands/ask');
    await createAskCommand().parseAsync(['node', 'ask', 'wt1', '   ']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});
