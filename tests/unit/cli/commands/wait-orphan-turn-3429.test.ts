/**
 * `wait` on a turn the agent will never send a `Stop` for (Issue #3429).
 *
 * Measured 2026-10-08 against claude 2.1.294 (production server log): the
 * agent's `Stop` arrived at 23:41:32.759Z, then a `pre_tool_use(AskUserQuestion)`
 * hook at 23:41:35.219Z with no prompt in between. That event opened a turn,
 * `wait` adopted it, no `Stop` ever came, and the server closed it as
 * `scraper_evidence`. #1839's gate had no bound, so `wait --timeout 10800`
 * polled the composer for 3 hours and exited 124.
 *
 * The release must not reopen #1839's hole: a prompt whose `Stop` never came
 * (the 529) still holds, and so does a pane that is still drawing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
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

const json = (data: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }) as unknown as Response;

function mockRoutes(routes: { polls: unknown[]; messages?: unknown }): void {
  let pollIndex = 0;
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/api/capabilities')) {
      return Promise.resolve(
        json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }),
      );
    }
    if (url.includes('/resolve-target')) {
      const requested = new URL(url).searchParams.get('instance') ?? 'claude';
      return Promise.resolve(
        json({ cliToolId: 'claude', instanceId: requested, resolvedBy: 'roster', conflict: null }),
      );
    }
    if (url.includes('/messages?')) return Promise.resolve(json(routes.messages ?? []));
    const poll = routes.polls[Math.min(pollIndex, routes.polls.length - 1)];
    pollIndex += 1;
    return Promise.resolve(json(poll));
  }) as unknown as typeof fetch;
}

/** When this wait starts. Every timestamp below is relative to it. */
const NOW = 1_791_416_495_000;
/** The agent's own `Stop`, answering the prompt. */
const STOP_AT = NOW - 3_000;
/** The `pre_tool_use` that arrived after it and opened the orphan turn. */
const ORPHAN_OPENED_AT = NOW - 1_000;
/** The server closing that turn on the screen's word. */
const ORPHAN_CLOSED_AT = NOW;

const SOURCE = {
  cliToolId: 'claude',
  capabilities: {
    supportedEvents: ['stop', 'session_start', 'session_end', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use'],
    configScope: 'worktree',
    decisionTimeoutSeconds: 30,
    permissionHookPredictsDialog: true,
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: true,
    eventIdentity: null,
    resync: 'none',
  },
};

/** A composer frame whose published turn is the orphan, closed by the screen. */
const composer = (
  overrides: Record<string, unknown> = {},
  structured: Record<string, unknown> = {},
) => ({
  isRunning: true,
  isPromptWaiting: false,
  content: 'frame',
  fullOutput: 'frame',
  realtimeSnippet: 'frame',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId: 'claude',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
  sessionStatusReason: 'input_prompt',
  lastStopEventAt: STOP_AT,
  structuredEvents: {
    lastEventType: 'pre_tool_use',
    lastEventAt: ORPHAN_OPENED_AT,
    lastEventDetail: 'AskUserQuestion',
    promptWaitingSince: null,
    promptWaitingSource: null,
    source: SOURCE,
    turnId: `turn-${ORPHAN_OPENED_AT}-435`,
    openedAt: ORPHAN_OPENED_AT,
    closedAt: ORPHAN_CLOSED_AT,
    closedBy: 'scraper_evidence',
    pendingDecisions: [],
    dialogPendingMaxMs: { predicted: 20_000, confirmed: 1_800_000 },
    ...structured,
  },
  ...overrides,
});

const userMessage = (at: number) => ({
  id: 'm1',
  worktreeId: 'wt1',
  role: 'user',
  content: 'Implement #3420',
  timestamp: new Date(at).toISOString(),
  messageType: 'normal',
  cliToolId: 'claude',
  instanceId: 'claude',
  archived: false,
});

const importWait = async () =>
  (await import('../../../../src/cli/commands/wait')).createWaitCommand();

const stderr = () => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');

const run = async (polls: unknown[], messages: unknown[], args: string[], advanceMs: number) => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockRoutes({ polls, messages });
  const cmd = await importWait();
  const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'claude', ...args]);
  await vi.advanceTimersByTimeAsync(advanceMs);
  return pending;
};

describe('an orphan turn opened after the Stop that answered the prompt (Issue #3429)', () => {
  it('holds for a while, then completes on that Stop instead of spinning to --timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRoutes({ polls: [composer()], messages: [userMessage(NOW - 600_000)] });
    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'claude', '--timeout', '600']);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockExit).not.toHaveBeenCalled();
    expect(stderr()).toContain('has not reported the end of this turn');

    await vi.advanceTimersByTimeAsync(40_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('completing on that stop');
    expect(stderr()).toContain('closedBy=scraper_evidence');
    expect(stderr()).toContain('Completed: wt1 (basis=hook_stop)');
  });

  it('lets a shorter --timeout win, as before', async () => {
    await run([composer()], [userMessage(NOW - 600_000)], ['--timeout', '20'], 25_000);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderr()).not.toContain('completing on that stop');
  });
});

describe('turns the release must NOT complete (Issue #3429, negative controls)', () => {
  it('keeps holding when the newest prompt has no Stop after it (#1839’s 529)', async () => {
    // The prompt postdates the last Stop: the agent was given work and never
    // reported finishing it. Same closed-by-screen turn, same quiet composer.
    await run([composer()], [userMessage(STOP_AT + 500)], ['--timeout', '300'], 310_000);

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderr()).not.toContain('completing on that stop');
  });

  it('keeps holding a turn that is still open while its output keeps changing', async () => {
    const polls = Array.from({ length: 80 }, (_, i) =>
      composer({ content: `frame ${i}` }, { closedAt: null, closedBy: null, lastEventAt: NOW + i * 5_000 }),
    );
    await run(polls, [userMessage(NOW - 600_000)], ['--timeout', '300'], 310_000);

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderr()).not.toContain('completing on that stop');
  });

  it('keeps holding a closed turn whose frame is still changing', async () => {
    const polls = Array.from({ length: 80 }, (_, i) => composer({ content: `frame ${i}` }));
    await run(polls, [userMessage(NOW - 600_000)], ['--timeout', '300'], 310_000);

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
  });

  it('keeps holding when the ledger has no prompt to compare against', async () => {
    await run([composer()], [], ['--timeout', '300'], 310_000);

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
  });
});
