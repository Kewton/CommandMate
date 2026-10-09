/**
 * `wait` across a queued notice delivered into the turn it is waiting for
 * (Issue #3330).
 *
 * Claude Code fires `UserPromptSubmit` for each background-task notice it
 * attaches to a running turn. The server now keeps that turn (same `turnId`,
 * same `openedAt`) instead of re-opening it; `wait` must still hold through the
 * notice and complete on that turn's `stop`. The payloads are the ones the
 * server publishes before the notice, after it, and after the `stop`. The
 * capture/resolve stubs are the #1930 suite's, which answer as copilot; the
 * gate under test reads no tool id.
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
    // Issue #2376: `wait --instance` resolves the selector once per worktree
    // before polling, so an ALIAS reaches `/current-output?instance=` as the id
    // it stands for. Answered here, ahead of the catch-all, or the resolution
    // would eat the first poll.
    if (url.includes('/resolve-target')) {
      // Echoes the requested instance, as the real route does for an id it
      // recognises. A stub that answered a fixed id would silently rewrite
      // `--instance copilot-2` and hide exactly what the scoping tests check.
      const requested = new URL(url).searchParams.get('instance') ?? 'copilot';
      return Promise.resolve(
        json({ cliToolId: 'copilot', instanceId: requested, resolvedBy: 'roster', conflict: null }),
      );
    }
    if (url.includes('/messages?')) return Promise.resolve(json(routes.messages ?? []));
    const poll = routes.polls[Math.min(pollIndex, routes.polls.length - 1)];
    pollIndex += 1;
    return Promise.resolve(json(poll));
  }) as unknown as typeof fetch;
}

const NOW = 1_787_400_000_000;
/** The previous turn ended ten minutes ago. */
const PREVIOUS_STOP = NOW - 600_000;

const COPILOT_EVENTS = [
  'stop',
  'session_start',
  'session_end',
  'user_prompt_submit',
  'post_tool_use',
];

const SOURCE = {
  cliToolId: 'copilot',
  capabilities: {
    supportedEvents: COPILOT_EVENTS,
    configScope: 'global-singleton',
    decisionTimeoutSeconds: 30,
    permissionHookPredictsDialog: false,
    sessionStartMayArriveLate: true,
    permissionReplyReleasesPrompt: false,
    eventIdentity: null,
    resync: 'none',
  },
};

/**
 * The turn block a #1930 server publishes.
 *
 * `dialogPendingMaxMs` is the version probe `wait` reads — it landed with the
 * turn model, so a payload carrying it is a payload whose `openedAt` can be
 * trusted to be null when the server has fenced the turn off. Omitting it here
 * is what the pre-#1930 cases below do, and that is the point of the last
 * describe.
 */
const turnFields = (over: Record<string, unknown> = {}) => ({
  turnId: null,
  openedAt: null,
  closedAt: null,
  closedBy: null,
  pendingDecisions: [],
  dedupDropped: {
    dedupDropped: { identity: 0, timeWindow: 0 },
    decisionEvicted: 0,
    idsDiscarded: 0,
    dialogTimedOut: 0,
    decisionOverflow: 0,
  },
  dialogPendingMaxMs: { predicted: 20_000, confirmed: 1_800_000 },
  ...over,
});

/** A session at its composer. `structured` overrides the turn block. */
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
  cliToolId: 'copilot',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
  sessionStatusReason: 'hook_stop',
  lastStopEventAt: PREVIOUS_STOP,
  structuredEvents: {
    lastEventType: 'stop',
    lastEventAt: PREVIOUS_STOP,
    lastEventDetail: null,
    promptWaitingSince: null,
    promptWaitingSource: null,
    source: SOURCE,
    ...turnFields({
      turnId: 'turn-previous',
      // A turn that ran and ended, ten minutes ago. `openedAt` is non-null on
      // purpose: a fixture whose previous turn had none would make every
      // adoption case below pass for the wrong reason, since `adoptTurnStart`
      // returns early on a null.
      openedAt: PREVIOUS_STOP - 30_000,
      closedAt: PREVIOUS_STOP,
      closedBy: 'stop',
    }),
    ...structured,
  },
  ...overrides,
});

const userMessage = (at: number) => ({
  id: 'm1',
  worktreeId: 'wt1',
  role: 'user',
  content: 'Create uat.txt',
  timestamp: new Date(at).toISOString(),
  messageType: 'normal',
  cliToolId: 'copilot',
  instanceId: 'copilot',
  archived: false,
});

const importWait = async () =>
  (await import('../../../../src/cli/commands/wait')).createWaitCommand();

const stderr = () => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');

const OPENED_AT = NOW - 300_000;
const NOTICE_AT = NOW + 2_000;
const STOP_AT = NOW + 8_000;

/** The running frame of the turn this wait adopts. */
const running = (structured: Record<string, unknown>) =>
  composer(
    { sessionStatus: 'running', sessionStatusReason: 'hook_pre_tool_use' },
    structured,
  );

const openTurn = (over: Record<string, unknown> = {}) =>
  turnFields({ turnId: 'turn-orchestrator', openedAt: OPENED_AT, closedAt: null, closedBy: null, ...over });

async function runWait(polls: unknown[]) {
  vi.useFakeTimers();
  mockRoutes({ polls, messages: [userMessage(OPENED_AT)] });
  const cmd = await importWait();
  const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot', '--timeout', '60']);
  // Poll 1 at 0 s, poll 2 at 5 s: the notice has landed, the turn is open.
  await vi.advanceTimersByTimeAsync(6_000);
  const exitedBeforeStop = mockExit.mock.calls.length > 0;
  // Poll 3 at 10 s: the turn's `stop`.
  await vi.advanceTimersByTimeAsync(6_000);
  await pending;
  return { exitedBeforeStop };
}

describe('[#3330] a notice delivered into the adopted turn', () => {
  it('holds through the notice and completes on that turn’s stop', async () => {
    const { exitedBeforeStop } = await runWait([
      running({ lastEventType: 'pre_tool_use', lastEventAt: OPENED_AT + 1_000, ...openTurn() }),
      // The notice joined the turn: newest event `user_prompt_submit`, the
      // turn unchanged. The scraper sees a composer between tool calls.
      composer({}, { lastEventType: 'user_prompt_submit', lastEventAt: NOTICE_AT, ...openTurn() }),
      composer(
        { lastStopEventAt: STOP_AT },
        {
          lastEventType: 'stop',
          lastEventAt: STOP_AT,
          ...openTurn({ closedAt: STOP_AT, closedBy: 'stop' }),
        },
      ),
    ]);

    expect(exitedBeforeStop).toBe(false);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('Completed: wt1 (basis=hook_stop)');
    expect(stderr()).toContain('has not reported the end of this turn');
  });

  it('does the same on the shape a pre-#3330 server published (the turn re-opened)', async () => {
    // The control: `wait` gates on `openedAt` and `lastStopEventAt`, not on the
    // id, so the re-stamped turn was waited for too. What #3330 changes is the
    // id every other reader of the turn sees, not this gate.
    const reopened = openTurn({ turnId: 'turn-notice', openedAt: NOTICE_AT });
    const { exitedBeforeStop } = await runWait([
      running({ lastEventType: 'pre_tool_use', lastEventAt: OPENED_AT + 1_000, ...openTurn() }),
      composer({}, { lastEventType: 'user_prompt_submit', lastEventAt: NOTICE_AT, ...reopened }),
      composer(
        { lastStopEventAt: STOP_AT },
        { lastEventType: 'stop', lastEventAt: STOP_AT, ...reopened, closedAt: STOP_AT, closedBy: 'stop' },
      ),
    ]);

    expect(exitedBeforeStop).toBe(false);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });
});
