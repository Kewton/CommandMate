/**
 * Issue #1975: `wait` must not read "the agent has not started yet" as "the
 * agent finished".
 *
 * Measured, not imagined. On 2026-08-22 an isolated CommandMate server (port
 * 3012, throwaway DB, its own sandbox repo) drove a real copilot 1.0.80 through
 * five send-then-wait cycles with the built CLI. Three of the five came back in
 * ~0.3 s with `basis=scraper_ready`, exit 0 and no artefact on disk:
 *
 *     run=1 rc=0 elapsed=271ms   file=NO   basis=scraper_ready
 *     run=2 rc=0 elapsed=40573ms file=YES  basis=hook_stop
 *     run=3 rc=0 elapsed=274ms   file=NO   basis=scraper_ready
 *     run=5 rc=0 elapsed=262ms   file=NO   basis=scraper_ready
 *
 * The window is narrow and entirely explained: the same probe measured copilot's
 * `UserPromptSubmit` reaching the server 0.04 s / 0.75 s / 0.88 s / 1.10 s after
 * the send returned (the last one a cold session start), and `wait`'s first poll
 * is immediate. Inside that window the newest structured event is still the
 * PREVIOUS turn's `stop`, so #1839's gate adopts no turn and reads `null` as
 * "settled".
 *
 * What separates the two states is not a timer but a comparison the CLI could
 * already make: the chat ledger says when this instance was last handed a
 * prompt, and `lastStopEventAt` says when its agent last reported finishing one.
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

/**
 * Route by path rather than by call order.
 *
 * `mockFetchSequence` hands out one queued response per call, which cannot
 * express this Issue: the poll and the ledger read are two different endpoints
 * interleaved at a cadence the test does not control. Routing keeps each poll's
 * payload next to the poll it belongs to.
 */
function mockRoutes(routes: {
  polls: unknown[];
  messages?: unknown;
  messagesFails?: boolean;
}): { messageCalls: () => number } {
  let pollIndex = 0;
  let messageCalls = 0;
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/api/capabilities')) {
      return Promise.resolve(
        json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }),
      );
    }
    if (url.includes('/messages?')) {
      messageCalls += 1;
      if (routes.messagesFails) return Promise.reject(new Error('ledger unreachable'));
      return Promise.resolve(json(routes.messages ?? []));
    }
    const poll = routes.polls[Math.min(pollIndex, routes.polls.length - 1)];
    pollIndex += 1;
    return Promise.resolve(json(poll));
  }) as unknown as typeof fetch;
  return { messageCalls: () => messageCalls };
}

const NOW = 1_787_400_000_000;
/** The previous turn ended ten minutes ago. Every case below starts here. */
const PREVIOUS_STOP = NOW - 600_000;

/** copilot's declaration, verbatim from src/lib/hooks/sources/copilot/source.ts. */
const COPILOT_EVENTS = [
  'stop',
  'session_start',
  'session_end',
  'user_prompt_submit',
  'post_tool_use',
];

/**
 * A session at its composer whose last structured word was the previous turn's
 * `stop` — the payload `send`-then-`wait` and wait-on-an-idle-session share.
 */
const composer = (overrides: Record<string, unknown> = {}) => ({
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
    source: {
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
    },
  },
  ...overrides,
});

/** One chat row, as GET /messages serializes it (`timestamp` is an ISO string). */
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

const stderr = () => mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');

describe('a prompt the agent has not reported the end of (Issue #1975)', () => {
  it('does NOT complete on the first poll after a send', async () => {
    vi.useFakeTimers();
    // The prompt landed a second ago; the newest `stop` is the previous turn's.
    mockRoutes({
      polls: [composer()],
      messages: [userMessage(NOW - 1_000)],
    });

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot', '--timeout', '20']);
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderr()).toContain('has not started this turn yet');
  });

  it('completes with basis=hook_stop once the agent reports the end of that turn', async () => {
    vi.useFakeTimers();
    mockRoutes({
      polls: [
        composer(),
        // The agent's own Stop, now newer than the prompt.
        composer({ lastStopEventAt: NOW + 3_000 }),
      ],
      messages: [userMessage(NOW - 1_000)],
    });

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot']);
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    const lines = mockConsoleError.mock.calls.map(c => String(c[0]));
    expect(lines.join('\n')).toContain('Completed: wt1 (basis=hook_stop)');
    // The gate must have HELD on poll 1 and released on poll 2. Without this the
    // test also passes when the previous turn's stale `stop` is accepted, which
    // is the exact confusion the comparison exists to prevent.
    expect(lines[0]).toContain('has not started this turn yet');
  });

  it('completes on the first poll when the agent already answered the newest prompt', async () => {
    // The legitimate wait an orchestrator makes on a session that finished long
    // ago. Costs nothing: no hold, no extra poll, same verdict as before #1975.
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

  it('completes a turn that opened and closed between two polls', async () => {
    // The fast-turn case, which needs no rule of its own: nothing was adopted
    // (the newest event is `stop`, not a turn-opening word), but the `stop`
    // postdates the prompt, so the turn this wait is about is over.
    mockRoutes({
      polls: [composer({ lastStopEventAt: NOW + 2_000 })],
      messages: [userMessage(NOW)],
    });

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('basis=hook_stop');
  });

  it('holds when the agent has never reported a stop at all', async () => {
    vi.useFakeTimers();
    // A session's first turn: hooks have said nothing yet, so `lastStopEventAt`
    // is null. Null is "never finished a turn", not "finished this one".
    mockRoutes({
      polls: [composer({ lastStopEventAt: null })],
      messages: [userMessage(NOW)],
    });

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot', '--timeout', '20']);
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
  });
});

describe('the hold is bounded (Issue #1975)', () => {
  it('completes on the frame alone after PENDING_PROMPT_HOLD_MS with no reported stop', async () => {
    vi.useFakeTimers();
    // Hooks that never answer must not turn `wait` into a command that never
    // returns: the contract for this Issue asks for the existing timeout paths
    // to stay reachable, and for the hold itself to end.
    mockRoutes({
      polls: [composer()],
      messages: [userMessage(NOW)],
    });

    const cmd = await importWait();
    // No --timeout at all: the bound below is the only thing that can end this.
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot']);
    await vi.advanceTimersByTimeAsync(70_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('Its hooks are not answering');
    expect(stderr()).toContain('Completed: wt1 (basis=scraper_ready)');
  });

  it('lets a --timeout shorter than the hold win, exactly as the unclassified dwell does', async () => {
    vi.useFakeTimers();
    mockRoutes({
      polls: [composer()],
      messages: [userMessage(NOW)],
    });

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot', '--timeout', '15']);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
  });

  it('falls to --stall-timeout while holding', async () => {
    vi.useFakeTimers();
    mockRoutes({
      polls: [composer()],
      messages: [userMessage(NOW)],
    });

    const cmd = await importWait();
    const pending = cmd.parseAsync([
      'node', 'wait', 'wt1', '--instance', 'copilot', '--stall-timeout', '12',
    ]);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderr()).toContain('Stall timeout');
  });
});

describe('tools that post no hooks are untouched (Issue #1975)', () => {
  it('completes immediately for a source that declares no events', async () => {
    // What `getAgentEventSource` answers for a tool with no implementation
    // (src/lib/hooks/sources/legacy-relay.ts): `supportedEvents: []`. It cannot
    // report a turn end, so holding for one would be a wait that never returns.
    const routes = mockRoutes({
      polls: [
        composer({
          cliToolId: 'vibe-local',
          structuredEvents: {
            lastEventType: null,
            lastEventAt: null,
            lastEventDetail: null,
            promptWaitingSince: null,
            promptWaitingSource: null,
            source: {
              cliToolId: 'vibe-local',
              capabilities: {
                supportedEvents: [],
                configScope: 'none',
                decisionTimeoutSeconds: null,
                permissionHookPredictsDialog: false,
                sessionStartMayArriveLate: false,
                permissionReplyReleasesPrompt: false,
                eventIdentity: null,
                resync: 'none',
              },
            },
          },
          lastStopEventAt: null,
        }),
      ],
      messages: [userMessage(NOW)],
    });

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('basis=scraper_ready');
    // Not even asked: the ledger read costs a round trip on every completing
    // poll, and a tool that cannot answer must not pay for it.
    expect(routes.messageCalls()).toBe(0);
  });

  it('completes immediately against a server too old to declare a source', async () => {
    const routes = mockRoutes({
      polls: [composer({ structuredEvents: {
        lastEventType: 'stop',
        lastEventAt: PREVIOUS_STOP,
        lastEventDetail: null,
        promptWaitingSince: null,
        promptWaitingSource: null,
      } })],
      messages: [userMessage(NOW)],
    });

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(routes.messageCalls()).toBe(0);
  });

  it('does not hold a tool that declares turn openings but no stop', async () => {
    // Nothing could ever release such a hold, so it would only ever end at its
    // own bound — 60 s of waiting bought with no possibility of an answer.
    const routes = mockRoutes({
      polls: [composer({ structuredEvents: {
        lastEventType: 'user_prompt_submit',
        lastEventAt: PREVIOUS_STOP,
        lastEventDetail: null,
        promptWaitingSince: null,
        promptWaitingSource: null,
        source: {
          cliToolId: 'copilot',
          capabilities: {
            supportedEvents: ['user_prompt_submit', 'session_start'],
            configScope: 'none',
            decisionTimeoutSeconds: null,
            permissionHookPredictsDialog: false,
            sessionStartMayArriveLate: false,
            permissionReplyReleasesPrompt: false,
            eventIdentity: null,
            resync: 'none',
          },
        },
      } })],
      messages: [userMessage(NOW)],
    });

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(routes.messageCalls()).toBe(0);
  });
});

describe('an unreadable ledger degrades rather than blocks (Issue #1975)', () => {
  it('completes and says so when the messages endpoint fails', async () => {
    // An unreachable ledger is not evidence that nothing was sent — but it is
    // also not a reason to stop returning a verdict. Same rule the task-ledger
    // read of Issue #1620 already follows.
    const routes = mockRoutes({ polls: [composer()], messagesFails: true });

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('could not read the message ledger');
    expect(stderr()).toContain('basis=scraper_ready');
    expect(routes.messageCalls()).toBe(1);
  });

  it('completes when the instance has never been sent anything', async () => {
    mockRoutes({ polls: [composer()], messages: [] });

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('basis=scraper_ready');
  });
});

describe('the ledger read is scoped like the poll (Issue #1975)', () => {
  it('asks for the named instance', async () => {
    const urls: string[] = [];
    const inner = mockRoutes({ polls: [composer()], messages: [userMessage(PREVIOUS_STOP - 1)] });
    const wrapped = global.fetch;
    global.fetch = vi.fn((input: unknown, init?: unknown) => {
      urls.push(String(input));
      return (wrapped as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
    }) as unknown as typeof fetch;
    void inner;

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'copilot-2']);

    const ledger = urls.find(u => u.includes('/messages?'));
    expect(ledger).toContain('instance=copilot-2');
    expect(ledger).toContain('unit=pairs');
  });

  it('falls back to the tool the server resolved when no instance was named', async () => {
    const urls: string[] = [];
    mockRoutes({ polls: [composer()], messages: [userMessage(PREVIOUS_STOP - 1)] });
    const wrapped = global.fetch;
    global.fetch = vi.fn((input: unknown, init?: unknown) => {
      urls.push(String(input));
      return (wrapped as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
    }) as unknown as typeof fetch;

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1']);

    const ledger = urls.find(u => u.includes('/messages?'));
    // Unscoped would let a message sent to claude decide a wait on copilot.
    expect(ledger).toContain('cliTool=copilot');
    expect(ledger).not.toContain('instance=');
  });
});

describe('the hold is reachable from --help (Issue #1975, 方針書 規約 3)', () => {
  /**
   * `helpInformation()` is NOT what a user sees: commander renders
   * `addHelpText` only through `outputHelp()`. Same reason the #1926 help suite
   * spells it this way.
   */
  const helpText = async (): Promise<string> => {
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    let out = '';
    cmd.configureOutput({ writeOut: (str: string) => { out += str; } });
    cmd.outputHelp();
    return out;
  };

  it('names the bound, the flags that beat it, and the tools it skips', async () => {
    // A judgement a caller can be surprised by, with no flag of its own — so it
    // has to be reachable from the command's own help. Assertions are on the
    // facts, not the prose.
    const help = await helpText();
    const [, after] = help.split('A prompt the agent has not answered yet');

    expect(after).toBeDefined();
    expect(after).toContain('60 s');
    expect(after).toContain('--stall-timeout');
    expect(after).toContain('124');
    expect(after).toContain('supportedEvents');
    expect(after).toContain('basis=hook_stop');
  });
});
