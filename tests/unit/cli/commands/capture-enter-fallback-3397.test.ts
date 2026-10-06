/**
 * `capture` and `autoYes.lastEnterFallback` (Issue #3397).
 *
 * `--json` forwards the record verbatim (`formatJson` strips only
 * `fullOutput`), so a pipeline reads it with no CLI code behind it. The plain
 * output prints `content` and nothing else — it shows no Auto-Yes state at all
 * (`lastSuppression` is not printed either), and a line added there would land
 * in what every consumer pipes onward — so it gets no line.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const RECORD = {
  outcome: 'sent',
  promptType: 'multiple_choice',
  refusalReason: 'prompt_no_longer_active',
  sentAt: 1_000,
  at: 1_000,
  currentPrompt: true,
};

const output = {
  isRunning: true,
  isPromptWaiting: true,
  content: 'Hello from agent',
  fullOutput: 'Full output',
  realtimeSnippet: 'snippet',
  lineCount: 1,
  promptData: null,
  autoYes: { enabled: true, expiresAt: null, lastSuppression: null, lastEnterFallback: RECORD },
  cliToolId: 'claude',
};

async function runCapture(args: string[]): Promise<void> {
  const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
  await createCaptureCommand().parseAsync(['node', 'capture', ...args]);
}

describe('[#3397] capture and the Enter record', () => {
  it('--json carries autoYes.lastEnterFallback exactly as the server sent it', async () => {
    mockFetchResponse(output);
    await runCapture(['wt1', '--json']);

    const json = JSON.parse(String(mockConsoleLog.mock.calls[0][0])) as {
      autoYes: { lastEnterFallback: unknown };
    };
    expect(json.autoYes.lastEnterFallback).toEqual(RECORD);
  });

  it('--json carries null as null', async () => {
    mockFetchResponse({ ...output, autoYes: { ...output.autoYes, lastEnterFallback: null } });
    await runCapture(['wt1', '--json']);

    const json = JSON.parse(String(mockConsoleLog.mock.calls[0][0])) as {
      autoYes: Record<string, unknown>;
    };
    expect(json.autoYes).toHaveProperty('lastEnterFallback', null);
  });

  it('the plain output is the content and nothing else', async () => {
    mockFetchResponse(output);
    await runCapture(['wt1']);

    expect(mockConsoleLog.mock.calls.map(c => String(c[0]))).toEqual(['Hello from agent']);
  });
});
