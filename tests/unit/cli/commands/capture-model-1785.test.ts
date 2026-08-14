/**
 * `capture --json` carries model / reasoningEffort (Issue #1785).
 *
 * There is no CLI code behind this: `formatJson` strips `fullOutput` and
 * forwards the rest verbatim, which is the entire design — the CLI must not
 * interpret a model name, and a payload field added upstream must not require a
 * CLI release. That makes this suite the only thing standing between "the
 * server publishes it" and "the operator can read it", and it is also why the
 * text-mode regression below matters: a formatter that "helpfully" started
 * printing the model would break every consumer that pipes plain `capture` into
 * something else.
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

/** The payload as the server sends it, minus the two fields under test. */
const baseOutput = {
  isRunning: true,
  isComplete: false,
  isPromptWaiting: false,
  isGenerating: true,
  content: 'Hello from agent',
  fullOutput: 'Full output with lots of text',
  realtimeSnippet: 'snippet...',
  lineCount: 10,
  lastCapturedLine: 10,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  thinkingMessage: null,
  cliToolId: 'claude',
  sessionStatus: 'running',
  sessionStatusReason: 'thinking_indicator',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: true,
};

async function runCapture(args: string[]): Promise<void> {
  const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
  await createCaptureCommand().parseAsync(['node', 'capture', ...args]);
}

/** The `--json` body the command printed. */
function printedJson(): Record<string, unknown> {
  return JSON.parse(mockConsoleLog.mock.calls[0][0]);
}

describe('capture --json: model / reasoningEffort (Issue #1785)', () => {
  it('carries the model the server resolved', async () => {
    mockFetchResponse({ ...baseOutput, model: 'claude-opus-5[1m]', reasoningEffort: 'xhigh' });

    await runCapture(['wt1', '--json']);

    expect(printedJson().model).toBe('claude-opus-5[1m]');
  });

  it('carries null when the server knows no model', async () => {
    // gemini and copilot publish none in any hook payload; so does any session
    // that started before the server process did.
    mockFetchResponse({ ...baseOutput, model: null, reasoningEffort: null });

    await runCapture(['wt1', '--json']);

    const json = printedJson();
    expect(json).toHaveProperty('model');
    expect(json.model).toBeNull();
  });

  it('carries reasoningEffort as a string or null, whichever the server sent', async () => {
    // Schema, not value: null today (its holding layer is #1784, in flight), a
    // string afterwards. Both are correct here and neither needs an edit.
    mockFetchResponse({ ...baseOutput, model: 'gpt-5.6-sol', reasoningEffort: null });

    await runCapture(['wt1', '--json']);

    const { reasoningEffort } = printedJson();
    expect(reasoningEffort === null || typeof reasoningEffort === 'string').toBe(true);
  });

  it('still excludes fullOutput and keeps the fields orchestrate-monitor parses', async () => {
    // Requirement 3: additive only. The monitor recipe reads these four off
    // `capture --json`, and losing any of them stops parallel-worker supervision.
    mockFetchResponse({ ...baseOutput, model: 'claude-opus-5[1m]', reasoningEffort: null });

    await runCapture(['wt1', '--json']);

    const json = printedJson();
    expect(json.fullOutput).toBeUndefined();
    expect(json.content).toBe('Hello from agent');
    expect(json.realtimeSnippet).toBe('snippet...');
    expect(json.sessionStatus).toBe('running');
    expect(json.sessionStatusReason).toBe('thinking_indicator');
  });

  it('does not crash on a daemon too old to publish either field', async () => {
    // The CLI is routinely newer than the server it dials: `npm i -g` does not
    // restart the running daemon. Absent stays absent — the CLI invents nothing.
    mockFetchResponse(baseOutput);

    await runCapture(['wt1', '--json']);

    const json = printedJson();
    expect(json.model).toBeUndefined();
    expect(json.content).toBe('Hello from agent');
    expect(mockExit).not.toHaveBeenCalled();
  });
});

describe('capture (text mode) is unchanged by Issue #1785', () => {
  it('prints exactly the content field and nothing else', async () => {
    mockFetchResponse({ ...baseOutput, model: 'claude-opus-5[1m]', reasoningEffort: 'xhigh' });

    await runCapture(['wt1']);

    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    expect(mockConsoleLog).toHaveBeenCalledWith('Hello from agent');
  });

  it('prints the same bytes whether or not the server resolved a model', async () => {
    mockFetchResponse({ ...baseOutput, model: null, reasoningEffort: null });
    await runCapture(['wt1']);
    const withoutModel = mockConsoleLog.mock.calls.map((c) => c[0]);

    mockConsoleLog.mockClear();
    restoreFetch();

    mockFetchResponse({ ...baseOutput, model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' });
    await runCapture(['wt1']);
    const withModel = mockConsoleLog.mock.calls.map((c) => c[0]);

    expect(withModel).toEqual(withoutModel);
  });
});
