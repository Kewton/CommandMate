/**
 * `ask` fails on an upstream fault (Issue #3011): a context-limit error on the
 * frame at the end of the turn is exit 11 with `id=context-limit`, not a reply.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode, WaitExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const NOW = 1_787_500_000_000;
const DRAIN_MS = 90_000;
const FAULT_LINE =
  "⚠ Error: 400 This model's maximum context length is 1048576 tokens. However, you requested 1070861 tokens";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

const json = (data: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }) as unknown as Response;

function startServer(upstreamFault: { id: string; matchedText: string } | null): void {
  global.fetch = vi.fn((input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/capabilities') {
      return Promise.resolve(json({ serverVersion: '0.0.0-test', capabilities: [] }));
    }
    if (url.pathname.endsWith('/send')) return Promise.resolve(json({ id: 1 }, 201));
    if (url.pathname.endsWith('/current-output')) {
      return Promise.resolve(json({
        isRunning: true,
        isComplete: true,
        isPromptWaiting: false,
        isGenerating: false,
        content: 'ready',
        fullOutput: 'ready',
        realtimeSnippet: '',
        lineCount: 1,
        lastCapturedLine: 1,
        promptData: null,
        autoYes: { enabled: false, expiresAt: null },
        thinking: false,
        thinkingMessage: null,
        cliToolId: 'command-code',
        isSelectionListActive: false,
        lastServerResponseTimestamp: null,
        serverPollerActive: false,
        sessionStatus: 'ready',
        upstreamFault,
      }));
    }
    if (url.pathname.endsWith('/messages')) return Promise.resolve(json([]));
    if (url.pathname.endsWith('/capture')) return Promise.resolve(json({ output: 'pane text' }));
    return Promise.resolve(json({ error: `unexpected ${url.pathname}` }, 404));
  }) as unknown as typeof fetch;
}

const stderr = (): string => mockConsoleError.mock.calls.flat().join('\n');

async function runAsk(argv: string[]): Promise<void> {
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  const pending = createAskCommand().parseAsync(['node', 'ask', 'wt1', ...argv]);
  await vi.advanceTimersByTimeAsync(DRAIN_MS);
  await pending;
}

describe('ask and upstream faults (Issue #3011)', () => {
  it('exits 11 with id=context-limit and the fresh-session advice', async () => {
    startServer({ id: 'context-limit', matchedText: FAULT_LINE });

    await runAsk(['hello', '--instance', 'command-code']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(mockExit).not.toHaveBeenCalledWith(ExitCode.SUCCESS);
    const err = stderr();
    expect(err).toContain('id=context-limit');
    expect(err).toContain('commandmate instances wt1 kill command-code');
  });

  it('puts the id in --json', async () => {
    startServer({ id: 'context-limit', matchedText: FAULT_LINE });

    await runAsk(['hello', '--instance', 'command-code', '--json']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    const payload = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(payload.upstreamFault.id).toBe('context-limit');
    expect(payload.instanceId).toBe('command-code');
  });

  it('still exits 0 when no fault is on the frame', async () => {
    startServer(null);

    await runAsk(['hello', '--instance', 'command-code']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
  });
});
