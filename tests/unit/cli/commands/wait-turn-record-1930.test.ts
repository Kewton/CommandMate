/**
 * `wait`'s completion gate, moved onto the turn record (Issue #1930, §13).
 *
 * #1926 published `turnId` / `openedAt` / `closedAt` / `closedBy` and said in as
 * many words that `adoptTurnStart` must NOT read them yet, because the values
 * were derived from the single newest event and re-stamped several times inside
 * one turn. #1930 makes them a real record under the generation fence, and this
 * is the migration.
 *
 * Two things have to be true at once, and this suite is written against both:
 *
 *  1. **#1975's false-completion guard survives.** That defect reproduced 3/3
 *     against a live copilot: `send` then `wait` came back in ~0.3 s with
 *     `basis=scraper_ready` and no artefact on disk. The mechanism is a ledger
 *     comparison, not a clock, and it is upstream of the turn fields — so it
 *     must still hold on a payload that carries them.
 *  2. **An already-idle session still completes on the first poll.** That is the
 *     orchestrator's normal path (#1975 measured 234/242/259 ms), and it is
 *     exactly what a naive migration breaks: adopt any published turn and every
 *     wait inherits the previous turn's gate.
 *
 * The new behaviour the migration buys is the third describe: a turn that opened
 * before this `wait` started and is *still open* is now adopted on its own
 * evidence rather than on whether its newest event happens to be fresh.
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
  isComplete: false,
  isPromptWaiting: false,
  isGenerating: false,
  content: 'frame',
  fullOutput: 'frame',
  realtimeSnippet: 'frame',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  thinkingMessage: null,
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

describe('[#1930] #1975’s guard still holds on a turn-record payload', () => {
  it('does NOT complete on the first poll after a send', async () => {
    vi.useFakeTimers();
    // The window the defect lives in: the prompt landed a second ago, the agent
    // has not opened its turn yet, so the server publishes the PREVIOUS turn —
    // closed, and older than this wait. Nothing is adopted, and the ledger is
    // the only thing that can tell "not started" from "finished".
    mockRoutes({ polls: [composer()], messages: [userMessage(NOW - 1_000)] });

    const cmd = await importWait();
    const pending = cmd.parseAsync([
      'node', 'wait', 'wt1', '--instance', 'copilot', '--timeout', '20',
    ]);
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderr()).toContain('has not started this turn yet');
    // Issue #1930: the diagnostic now names the turn it could not use.
    expect(stderr()).toContain('closedBy=stop');
  });

  it('completes once the agent reports the end of that turn', async () => {
    vi.useFakeTimers();
    mockRoutes({
      polls: [
        composer(),
        composer({ lastStopEventAt: NOW + 3_000 }, turnFields({
          turnId: 'turn-current',
          openedAt: NOW + 500,
          closedAt: NOW + 3_000,
          closedBy: 'stop',
        })),
      ],
      messages: [userMessage(NOW - 1_000)],
    });

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot']);
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('Completed: wt1 (basis=hook_stop)');
    // Held on poll 1, released on poll 2 — without this the case also passes
    // when the previous turn's stale `stop` is accepted.
    expect(mockConsoleError.mock.calls.map((c) => String(c[0]))[0]).toContain(
      'has not started this turn yet',
    );
  });

  it('completes on the first poll for a session that has been idle for ages', async () => {
    // The orchestrator's normal path, and the one a naive migration breaks: the
    // server publishes a turn (closed, ten minutes old) on every poll, and
    // adopting it would gate this wait on a `stop` that has already happened.
    mockRoutes({
      polls: [composer()],
      messages: [userMessage(PREVIOUS_STOP - 20_000)],
    });

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('Completed: wt1 (basis=hook_stop)');
    expect(stderr()).not.toContain('has not started this turn yet');
  });

  it('leaves a tool that reports no turn boundaries exactly as it was', async () => {
    // `supportedEvents: []` is what `legacy-relay` declares for a tool with no
    // source of its own. It never reaches the ledger and never holds.
    mockRoutes({
      polls: [
        composer({}, {
          source: { cliToolId: 'gemini', capabilities: { ...SOURCE.capabilities, supportedEvents: [] } },
        }),
      ],
      messages: [userMessage(NOW)],
    });

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('Completed: wt1 (basis=scraper_ready)');
  });
});

describe('[#1930] an open turn gates the wait however old it is', () => {
  it('holds on a turn that opened before this wait started and is still open', async () => {
    vi.useFakeTimers();
    // The hole the old reading had. Under `lastEventAt` this frame adopts
    // nothing — the newest event is five minutes old — so #1839's gate came
    // down at exactly the moment an upstream fault would exploit it. The server
    // has fenced and aged the record already, so an open turn is this
    // instance's turn whatever its age.
    const openedAt = NOW - 300_000;
    mockRoutes({
      polls: [
        composer(
          { lastStopEventAt: PREVIOUS_STOP },
          turnFields({
            turnId: 'turn-long-running',
            openedAt,
            closedAt: null,
            closedBy: null,
            // The agent last spoke five minutes ago and has been thinking since.
          }),
        ),
      ],
      messages: [userMessage(openedAt)],
    });

    const cmd = await importWait();
    const pending = cmd.parseAsync([
      'node', 'wait', 'wt1', '--instance', 'copilot', '--timeout', '20',
    ]);
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderr()).toContain('has not reported the end of this turn');
    expect(stderr()).toContain('closedBy=open');
  });

  it('adopts nothing when the server has fenced the turn off', async () => {
    // A generation bump, or the staleness bound: the server publishes null
    // rather than a turn, and `wait` must not fall back to `lastEventType` —
    // that fallback is what the record exists to remove. The ledger still
    // decides, so this completes rather than hanging.
    mockRoutes({
      polls: [
        composer({}, turnFields({ turnId: null, openedAt: null, closedAt: null, closedBy: null })),
      ],
      messages: [userMessage(PREVIOUS_STOP - 20_000)],
    });

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('Completed: wt1 (basis=hook_stop)');
  });
});

describe('[#1930] a server older than the turn record keeps the pre-#1930 reading', () => {
  /** #1926-era payload: turn fields present, but no `dialogPendingMaxMs`. */
  const legacy = (structured: Record<string, unknown> = {}) =>
    composer({}, {
      turnId: null,
      openedAt: null,
      closedAt: null,
      closedBy: null,
      pendingDecisions: undefined,
      dedupDropped: undefined,
      dialogPendingMaxMs: undefined,
      ...structured,
    });

  it('adopts from lastEventType / lastEventAt, as it did before', async () => {
    vi.useFakeTimers();
    // A newer CLI pointed at an older server must not silently lose the #1839
    // gate. The event is fresh and turn-opening, so the turn is adopted and the
    // composer frame is refused until a `stop` postdates it.
    //
    // `Date.now()` rather than the fixture's NOW: the pre-#1930 reading refuses
    // anything older than one poll interval before the wait began, which is the
    // whole of its stale-record protection, so an event stamped in the fixture's
    // past would be refused for that reason instead of adopted.
    const fresh = Date.now();
    mockRoutes({
      polls: [
        legacy({ lastEventType: 'user_prompt_submit', lastEventAt: fresh }),
      ],
      messages: [userMessage(fresh - 1_000)],
    });

    const cmd = await importWait();
    const pending = cmd.parseAsync([
      'node', 'wait', 'wt1', '--instance', 'copilot', '--timeout', '20',
    ]);
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderr()).toContain('has not reported the end of this turn');
  });
});
