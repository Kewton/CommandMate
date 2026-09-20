/**
 * `commandmate send --model` for Claude (Issue #2771)
 *
 * `--model` was copilot / antigravity only. Claude joins on antigravity's terms —
 * a launch flag, honoured when the send starts the session — and the CLI's part
 * is three things: pick the Claude validator, insist that the target is named,
 * and NOT defer Auto-Yes the way it does for copilot's `/model` interaction.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

function resolveTarget(cliToolId: string, instanceId: string) {
  return { data: { cliToolId, instanceId, resolvedBy: 'roster', conflict: null } };
}

type FetchCall = [string, { body?: string }];
const fetchCalls = (): FetchCall[] => (global.fetch as ReturnType<typeof vi.fn>).mock.calls as FetchCall[];
const bodyOf = (call: FetchCall): Record<string, unknown> => JSON.parse(call[1].body ?? '{}');

async function runSend(argv: string[]): Promise<void> {
  const { createSendCommand } = await import('../../../../src/cli/commands/send');
  await createSendCommand().parseAsync(['node', 'send', ...argv]);
}

describe('[#2771] send --model for a Claude target', () => {
  it('sends the model when --instance resolves to claude', async () => {
    mockFetchSequence([resolveTarget('claude', 'claude'), { data: { id: 1 }, status: 201 }]);

    await runSend(['wt1', 'hello', '--instance', 'claude', '--model', 'sonnet']);

    expect(mockExit).not.toHaveBeenCalled();
    const sendCall = fetchCalls().find((call) => String(call[0]).includes('/send'));
    expect(bodyOf(sendCall as FetchCall)).toEqual({
      content: 'hello',
      cliToolId: 'claude',
      instanceId: 'claude',
      model: 'sonnet',
    });
  });

  it('accepts --agent claude without --instance', async () => {
    mockFetchSequence([{ data: { id: 1 }, status: 201 }]);

    await runSend(['wt1', 'hello', '--agent', 'claude', '--model', 'opus[1m]']);

    expect(mockExit).not.toHaveBeenCalled();
    const sendCall = fetchCalls().find((call) => String(call[0]).includes('/send'));
    expect(bodyOf(sendCall as FetchCall).model).toBe('opus[1m]');
  });

  it.each([
    ['a display name (antigravity spelling)', 'Claude Sonnet 5 (Thinking)'],
    ['shell metacharacters', 'sonnet; rm -rf /'],
    ['a leading dash', '-sonnet'],
  ])('rejects %s with exit 2', async (_name, model) => {
    // `process.exit` is mocked, so the command keeps running after the error —
    // what is asserted is the verdict, as in instance-cli-tool-resolution.test.ts.
    mockFetchSequence([resolveTarget('claude', 'claude'), { data: { id: 1 }, status: 201 }]);

    await runSend(['wt1', 'hello', '--instance', 'claude', `--model=${model}`]);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Invalid model name'));
  });

  it('refuses --model when the target is not named (the CLI cannot know the default tool)', async () => {
    mockFetchSequence([{ data: { id: 1 }, status: 201 }]);

    await runSend(['wt1', 'hello', '--model', 'sonnet']);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('--model option requires'));
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('--agent claude'));
  });
});

describe('[#2771] Auto-Yes ordering', () => {
  const order = (): string[] =>
    fetchCalls()
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/auto-yes') || url.includes('/send'))
      .map((url) => (url.includes('/auto-yes') ? 'auto-yes' : 'send'));

  it('claude: Auto-Yes is enabled BEFORE the send (a launch flag has no interaction to protect)', async () => {
    mockFetchSequence([
      resolveTarget('claude', 'claude'),
      { data: { enabled: true } },
      { data: { id: 1 }, status: 201 },
    ]);

    await runSend(['wt1', 'hello', '--instance', 'claude', '--model', 'sonnet', '--auto-yes']);

    expect(mockExit).not.toHaveBeenCalled();
    expect(order()).toEqual(['auto-yes', 'send']);
  });

  it('copilot: still deferred until after the send (Issue #576, unchanged)', async () => {
    mockFetchSequence([
      resolveTarget('copilot', 'copilot'),
      { data: { id: 1 }, status: 201 },
      { data: { enabled: true } },
    ]);

    await runSend(['wt1', 'hello', '--instance', 'copilot', '--model', 'gpt-5-mini', '--auto-yes']);

    expect(mockExit).not.toHaveBeenCalled();
    expect(order()).toEqual(['send', 'auto-yes']);
  });
});
