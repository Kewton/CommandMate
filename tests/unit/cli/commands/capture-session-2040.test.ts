/**
 * `capture --json` carries the session and the decision kind (Issue #2040).
 *
 * There is no CLI code behind either field, and that is the design: `formatJson`
 * strips `fullOutput` and forwards the rest verbatim, so a payload field added
 * upstream needs no CLI release. What that leaves this suite responsible for is
 * the other half of the contract — the ADDITIVE one. `.claude/skills/
 * orchestrate-monitor`'s parsers read this payload in an unbounded loop, so a
 * key they already read must keep its name, its nesting depth and its value,
 * and a new key must not push one of them somewhere else.
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

/** An opencode payload as a #2040 server sends it. */
const output = {
  isRunning: true,
  isComplete: false,
  isPromptWaiting: true,
  isGenerating: false,
  content: '',
  fullOutput: 'lots of text',
  realtimeSnippet: 'snippet...',
  lineCount: 10,
  cliToolId: 'opencode',
  sessionStatus: 'waiting',
  sessionStatusReason: 'hook_permission_prompt',
  structuredEvents: {
    lastEventType: 'notification',
    lastEventAt: 1754296400000,
    lastEventDetail: 'permission_prompt',
    pendingDecisions: [
      {
        id: 'que_1',
        at: 1754296400000,
        source: 'permission-request',
        toolName: 'question',
        confirmedAt: null,
        scraperCorroborated: false,
        deliveryExpired: false,
        kind: 'question',
        questionOptions: [
          { number: 1, label: 'Red' },
          { number: 2, label: 'Blue' },
        ],
      },
    ],
    source: { cliToolId: 'opencode', capabilities: { eventIdentity: 'permission-id' } },
    session: {
      id: 'ses_1',
      title: 'Fix the flaky test',
      agent: 'build',
      model: 'claude-sonnet-4.6',
      provider: 'github-copilot',
      cost: 0.4213,
      tokens: { input: 120, output: 30, reasoning: 0, cacheRead: 4096, cacheWrite: 512, total: null },
      at: 1754296400000,
    },
  },
};

async function runCapture(args: string[]): Promise<void> {
  const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
  await createCaptureCommand().parseAsync(['node', 'capture', ...args]);
}

function printedJson(): Record<string, unknown> {
  return JSON.parse(mockConsoleLog.mock.calls[0][0]);
}

describe('capture --json', () => {
  it('forwards structuredEvents.session verbatim', async () => {
    mockFetchResponse(output);

    await runCapture(['wt1', '--json']);

    const events = printedJson().structuredEvents as Record<string, unknown>;
    // Verbatim: the cost is not rounded and the model is not prettified, so an
    // operator can compare them against what the agent says about itself.
    expect(events.session).toEqual(output.structuredEvents.session);
  });

  it('forwards the decision kind and its choices verbatim', async () => {
    mockFetchResponse(output);

    await runCapture(['wt1', '--json']);

    const events = printedJson().structuredEvents as Record<string, unknown>;
    expect(events.pendingDecisions).toEqual(output.structuredEvents.pendingDecisions);
  });

  it('leaves the keys the monitor recipe parses exactly where they were', async () => {
    // `ml_json_scalar` in `.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh`
    // matches a two-space indent — the TOP level of the pretty-printed body — so
    // what would break it is a top-level key moving or appearing, not a nested
    // one. #2040 adds nothing at the top level; this pins that.
    mockFetchResponse(output);

    await runCapture(['wt1', '--json']);

    const printed = printedJson();
    expect(Object.keys(printed).sort()).toEqual(
      Object.keys(output).filter((key) => key !== 'fullOutput').sort(),
    );
    expect(printed.sessionStatus).toBe('waiting');
    expect(printed.realtimeSnippet).toBe('snippet...');
    // …and `fullOutput` is still the one thing stripped.
    expect(printed).not.toHaveProperty('fullOutput');
  });
});
