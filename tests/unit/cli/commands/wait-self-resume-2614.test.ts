/**
 * Issue #2614: `wait` must not read "the agent ended its turn and will wake
 * itself later" as "the agent finished".
 *
 * Measured, not imagined. On 2026-09-17 an antigravity 1.2.4 worker on the
 * production server (:3000, worktree commandmate-issue-2605) launched
 * `npm run test:unit` in the background, called `schedule` to be woken 60 s
 * later, and ended its turn. `wait --verify` reported
 * `Completed (basis=hook_stop)` on that `Stop` and started a verification run
 * against a half-finished worktree. The agent woke itself three more times and
 * really finished five minutes later. `logs/server.log`, reduced to what the
 * CLI can see:
 *
 *     01:28:36.149  stop                                  ← reported as done
 *     01:29:34.226  post_tool_use  schedule               ← woke itself
 *     01:29:42.772  stop
 *     01:30:41.129  post_tool_use  schedule
 *     01:30:51.300  stop
 *     01:31:49.527  post_tool_use  schedule
 *     01:31:57.574  stop
 *     01:33:19.982  post_tool_use  run_command            ← the background test run ended
 *     01:33:41.576  stop                                  ← the real end (IMPL_COMPLETED)
 *
 * agy's `Stop` payload says which of those stops leave background work behind
 * (`fullyIdle`), and since this Issue its hook passes that on as
 * `lastEventDetail: self_resume_pending`. {@link INCIDENT} replays the sequence
 * through a model of the server's turn record, poll by poll, so the assertions
 * are about WHEN `wait` completes rather than about a single frame.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { VerifyExitCode, WaitExitCode } from '../../../../src/cli/types';
import {
  SELF_RESUME_CAPABILITY,
  SELF_RESUME_HOLD_MS,
  SELF_RESUME_PENDING_DETAIL,
  pollWorktree,
} from '../../../../src/cli/commands/wait';
import { ApiClient } from '../../../../src/cli/utils/api-client';
import { SELF_RESUME_PENDING_DETAIL as SERVER_SELF_RESUME_PENDING_DETAIL } from '@/lib/hooks/agent-event-types';
import { antigravityAgentEventSource } from '@/lib/hooks/sources/antigravity/source';
import { TURN_STALE_AFTER_MS } from '@/lib/session/provisional-turn';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  mockConsoleError.mockImplementation(() => {});
  vi.useRealTimers();
});

/** Epoch ms of a UTC time on the day of the incident. */
const T = (hms: string): number => Date.parse(`2026-09-17T${hms}Z`);

interface TimelineEvent {
  at: number;
  event: 'stop' | 'post_tool_use';
  detail: string | null;
}

const PENDING = SELF_RESUME_PENDING_DETAIL;

/** When the orchestrator handed the worker its prompt. agy reports no `UserPromptSubmit`. */
const PROMPT_SENT = T('01:22:40.000');

/** The sequence above, with the turn's opening tool call in front of it. */
const INCIDENT: TimelineEvent[] = [
  { at: T('01:23:05.000'), event: 'post_tool_use', detail: 'view_file' },
  { at: T('01:28:12.631'), event: 'post_tool_use', detail: 'run_command' },
  { at: T('01:28:36.149'), event: 'stop', detail: PENDING },
  { at: T('01:29:34.226'), event: 'post_tool_use', detail: 'schedule' },
  { at: T('01:29:38.878'), event: 'post_tool_use', detail: 'manage_task' },
  { at: T('01:29:42.772'), event: 'stop', detail: PENDING },
  { at: T('01:30:41.129'), event: 'post_tool_use', detail: 'schedule' },
  { at: T('01:30:45.944'), event: 'post_tool_use', detail: 'manage_task' },
  { at: T('01:30:51.300'), event: 'stop', detail: PENDING },
  { at: T('01:31:49.527'), event: 'post_tool_use', detail: 'schedule' },
  { at: T('01:31:53.111'), event: 'post_tool_use', detail: 'manage_task' },
  { at: T('01:31:57.574'), event: 'stop', detail: PENDING },
  { at: T('01:33:19.982'), event: 'post_tool_use', detail: 'run_command' },
  { at: T('01:33:20.061'), event: 'post_tool_use', detail: 'schedule' },
  { at: T('01:33:24.537'), event: 'post_tool_use', detail: 'run_command' },
  { at: T('01:33:33.077'), event: 'post_tool_use', detail: 'run_command' },
  { at: T('01:33:39.544'), event: 'post_tool_use', detail: 'run_command' },
  { at: T('01:33:41.576'), event: 'stop', detail: null },
];

const FIRST_STOP = T('01:28:36.149');
const FINAL_STOP = T('01:33:41.576');

/** The same run as the server published it before this Issue: no detail on any stop. */
const INCIDENT_WITHOUT_DETAIL = INCIDENT.map((e) => ({ ...e, detail: e.event === 'stop' ? null : e.detail }));

/** antigravity's declaration, as `src/lib/hooks/sources/antigravity/source.ts` publishes it. */
const AGY_CAPABILITIES = {
  supportedEvents: ['session_start', 'post_tool_use', 'stop'],
  configScope: 'global-singleton',
  decisionTimeoutSeconds: 5,
  permissionHookPredictsDialog: false,
  sessionStartMayArriveLate: false,
  permissionReplyReleasesPrompt: false,
  eventIdentity: null,
  resync: 'none',
  transcriptHistory: 'pull',
  stopReportsSelfResume: true,
};

interface TimelineOptions {
  capabilities?: Record<string, unknown>;
  /** Epoch ms from which tmux reports the session gone. */
  goneAt?: number;
}

/**
 * `current-output` at `now`, derived from the events that have arrived by then.
 *
 * The turn rules are the server's (`src/lib/session/agent-event-state.ts`
 * `openTurn` / `applyStopToTurn`): a turn-opening event after a closed turn
 * opens a new one, a `stop` closes the open turn, and a `stop` with nothing open
 * is published with `openedAt: null`.
 */
function currentOutputAt(now: number, events: TimelineEvent[], options: TimelineOptions = {}) {
  const seen = events.filter((e) => e.at <= now);
  let turn: { turnId: string | null; openedAt: number | null; closedAt: number | null; closedBy: string | null } = {
    turnId: null,
    openedAt: null,
    closedAt: null,
    closedBy: null,
  };
  let turns = 0;
  let lastStopEventAt: number | null = null;
  for (const e of seen) {
    if (e.event === 'stop') {
      lastStopEventAt = e.at;
      turn =
        turn.openedAt !== null && turn.closedAt === null
          ? { ...turn, closedAt: e.at, closedBy: 'stop' }
          : { turnId: `turn-${++turns}`, openedAt: null, closedAt: e.at, closedBy: 'stop' };
    } else if (turn.openedAt === null || turn.closedAt !== null) {
      turn = { turnId: `turn-${++turns}`, openedAt: e.at, closedAt: null, closedBy: null };
    }
  }
  const last = seen.at(-1) ?? null;
  const gone = options.goneAt !== undefined && now >= options.goneAt;
  const ready = last?.event === 'stop';
  return {
    isRunning: !gone,
    isComplete: false,
    isPromptWaiting: false,
    isGenerating: false,
    // Changes with every event, so --stall-timeout sees the agent's activity.
    content: `frame-${seen.length}`,
    fullOutput: `frame-${seen.length}`,
    realtimeSnippet: `frame-${seen.length}`,
    lineCount: 1,
    lastCapturedLine: 1,
    promptData: null,
    autoYes: { enabled: true, expiresAt: null },
    thinking: false,
    thinkingMessage: null,
    cliToolId: 'antigravity',
    isSelectionListActive: false,
    lastServerResponseTimestamp: null,
    serverPollerActive: false,
    sessionStatus: gone ? ('idle' as const) : ready ? ('ready' as const) : ('running' as const),
    sessionStatusReason: gone ? 'session_not_running' : ready ? 'hook_stop' : 'hook_post_tool_use',
    lastStopEventAt,
    structuredEvents: {
      lastEventType: last?.event ?? null,
      lastEventAt: last?.at ?? null,
      lastEventDetail: last?.detail ?? null,
      promptWaitingSince: null,
      promptWaitingSource: null,
      source: {
        cliToolId: 'antigravity',
        capabilities: options.capabilities ?? AGY_CAPABILITIES,
      },
      ...turn,
      pendingDecisions: [],
      dedupDropped: {
        dedupDropped: { identity: 0, timeWindow: 0 },
        decisionEvicted: 0,
        idsDiscarded: 0,
        dialogTimedOut: 0,
        decisionOverflow: 0,
      },
      dialogPendingMaxMs: { predicted: 20_000, confirmed: 1_800_000 },
    },
  };
}

const json = (data: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }) as unknown as Response;

const userMessage = (at: number) => ({
  id: 'm1',
  worktreeId: 'wt1',
  role: 'user',
  content: 'Implement #2605',
  timestamp: new Date(at).toISOString(),
  messageType: 'normal',
  cliToolId: 'antigravity',
  instanceId: 'antigravity',
  archived: false,
});

/**
 * Answer every poll from the timeline at the (fake) current time, so the
 * payload a poll sees depends on when it happens rather than on call order.
 *
 * @returns When (fake clock) `wait --verify` asked for a verification run, or null
 */
function mockTimeline(events: TimelineEvent[], options: TimelineOptions = {}): () => number | null {
  let verifyRequestedAt: number | null = null;
  global.fetch = vi.fn((input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (url.includes('/verify/runs/')) {
      return Promise.resolve(json({ run: { id: 1, status: 'passed', gates: [] } }));
    }
    if (url.endsWith('/verify') && init?.method === 'POST') {
      verifyRequestedAt ??= Date.now();
      return Promise.resolve(json({ runId: 1 }));
    }
    if (url.includes('/tasks?')) {
      return Promise.resolve(json({ tasks: [] }));
    }
    if (url.includes('/api/capabilities')) {
      return Promise.resolve(
        json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }),
      );
    }
    if (url.includes('/resolve-target')) {
      return Promise.resolve(
        json({ cliToolId: 'antigravity', instanceId: 'antigravity', resolvedBy: 'roster', conflict: null }),
      );
    }
    if (url.includes('/messages?')) {
      return Promise.resolve(json([userMessage(PROMPT_SENT)]));
    }
    return Promise.resolve(json(currentOutputAt(Date.now(), events, options)));
  }) as unknown as typeof fetch;
  return () => verifyRequestedAt;
}

const importWait = async () =>
  (await import('../../../../src/cli/commands/wait')).createWaitCommand();

const lines = () => mockConsoleError.mock.calls.map((c) => String(c[0]));
const stderr = () => lines().join('\n');

/** Fake-clock instant at which the `Completed:` line was printed, or null. */
function completedAtSpy(): () => number | null {
  let at: number | null = null;
  mockConsoleError.mockImplementation((message: unknown) => {
    if (at === null && String(message).startsWith('Completed:')) at = Date.now();
  });
  return () => at;
}

/** Run `wait` from `startAt` and let `runForMs` of fake time pass. */
async function runWait(
  args: string[],
  startAt: number,
  runForMs: number,
): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(startAt);
  const cmd = await importWait();
  const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'antigravity', ...args]);
  await vi.advanceTimersByTimeAsync(runForMs);
  await pending;
}

describe('the 2026-09-17 incident, replayed (Issue #2614)', () => {
  it('does not complete until the stop that really ends the work', async () => {
    mockTimeline(INCIDENT);
    const completedAt = completedAtSpy();

    await runWait([], T('01:28:00.000'), 7 * 60_000);

    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(completedAt()).not.toBeNull();
    expect(completedAt()!).toBeGreaterThanOrEqual(FINAL_STOP);
    // Within one poll of it, not at some bound.
    expect(completedAt()!).toBeLessThan(FINAL_STOP + 6_000);
  });

  it('says why it held, and for how long, on the completion line', async () => {
    mockTimeline(INCIDENT);

    await runWait([], T('01:28:00.000'), 7 * 60_000);

    expect(stderr()).toContain('ended its turn with background work still running');
    expect(stderr()).toContain(`lastEventDetail=${PENDING}`);
    expect(stderr()).toContain('has moved past the stop it said it would resume from');
    const completed = lines().find((l) => l.startsWith('Completed:'));
    // `basis=` keeps its word — the agent's own stop decided it.
    expect(completed).toMatch(/^Completed: wt1 \(basis=hook_stop, heldForSelfResume=(\d+)s\)$/);
    // Four holds of roughly a minute each (the fourth ends at the 01:33:19 wake).
    const held = Number(/heldForSelfResume=(\d+)s/.exec(completed!)![1]);
    expect(held).toBeGreaterThan(200);
    expect(held).toBeLessThan(330);
  });

  it('completed on the first stop before this Issue — the control case', async () => {
    // The same run without the detail, i.e. what the server published on
    // 2026-09-17. If this ever stops completing at 01:28:40 the replay above is
    // not testing the hold at all.
    mockTimeline(INCIDENT_WITHOUT_DETAIL);
    const completedAt = completedAtSpy();

    await runWait([], T('01:28:00.000'), 7 * 60_000);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(completedAt()!).toBeGreaterThanOrEqual(FIRST_STOP);
    expect(completedAt()!).toBeLessThan(FIRST_STOP + 6_000);
    expect(lines().find((l) => l.startsWith('Completed:'))).toBe('Completed: wt1 (basis=hook_stop)');
  });

  it('holds just the same when wait starts during the sleep', async () => {
    // A `wait` re-run after a --timeout, or started late: the stop it first sees
    // is already the self-resuming one, and the turn it closed is too old to
    // adopt. The hold must not depend on having seen the turn open.
    mockTimeline(INCIDENT);
    const completedAt = completedAtSpy();

    await runWait([], T('01:29:00.000'), 6 * 60_000);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(completedAt()!).toBeGreaterThanOrEqual(FINAL_STOP);
  });

  it('lets wait --verify start its run only after the real end', async () => {
    // The harm on 2026-09-17: run 819 started at 01:28:40, five minutes before
    // the worker was done, and caught its test run in flight.
    const verifyRequestedAt = mockTimeline(INCIDENT);

    await runWait(['--verify'], T('01:28:00.000'), 7 * 60_000);

    expect(verifyRequestedAt()).not.toBeNull();
    expect(verifyRequestedAt()!).toBeGreaterThanOrEqual(FINAL_STOP);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });
});

describe('the hold is bounded (Issue #2614)', () => {
  const NEVER_WAKES: TimelineEvent[] = [
    { at: T('01:23:05.000'), event: 'post_tool_use', detail: 'view_file' },
    { at: FIRST_STOP, event: 'stop', detail: PENDING },
  ];

  it('completes on the stop after SELF_RESUME_HOLD_MS when the agent never wakes', async () => {
    // No --timeout at all: the bound is the only thing that can end this.
    mockTimeline(NEVER_WAKES);
    const completedAt = completedAtSpy();

    await runWait([], T('01:28:00.000'), SELF_RESUME_HOLD_MS + 5 * 60_000);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(completedAt()!).toBeGreaterThanOrEqual(FIRST_STOP + SELF_RESUME_HOLD_MS);
    expect(completedAt()!).toBeLessThan(FIRST_STOP + SELF_RESUME_HOLD_MS + 6_000);
    expect(stderr()).toContain('has not resumed since; completing on that stop');
    expect(lines().find((l) => l.startsWith('Completed:'))).toMatch(
      /^Completed: wt1 \(basis=hook_stop, heldForSelfResume=\d+s\)$/,
    );
  });

  it('lets a shorter --timeout win', async () => {
    mockTimeline(NEVER_WAKES);

    await runWait(['--timeout', '120'], T('01:28:00.000'), 3 * 60_000);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('lets a shorter --stall-timeout win, since nothing moves while it sleeps', async () => {
    mockTimeline(NEVER_WAKES);

    await runWait(['--stall-timeout', '60'], T('01:28:00.000'), 3 * 60_000);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderr()).toContain('Stall timeout');
  });

  it('does not hold again on a stop that said so long ago', async () => {
    // An idle session whose last stop, hours ago, still carries the detail —
    // a background task that never ended. The bound is measured from the stop
    // as well, so an orchestrator waiting on it pays nothing.
    mockTimeline(NEVER_WAKES);

    await runWait([], T('03:00:00.000'), 10_000);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).not.toContain('ended its turn with background work still running');
    expect(stderr()).toContain('has not resumed since; completing on that stop');
    expect(lines().find((l) => l.startsWith('Completed:'))).toBe('Completed: wt1 (basis=hook_stop)');
  });

  it('completes as soon as the session goes away mid-hold', async () => {
    mockTimeline(NEVER_WAKES, { goneAt: T('01:29:00.000') });
    const completedAt = completedAtSpy();

    await runWait([], T('01:28:00.000'), 2 * 60_000);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(completedAt()!).toBeLessThan(T('01:29:06.000'));
    expect(lines().find((l) => l.startsWith('Completed:'))).toMatch(
      /^Completed: wt1 \(basis=session_gone, heldForSelfResume=\d+s\)$/,
    );
  });
});

describe('everything else is unchanged (Issue #2614)', () => {
  it('completes an agy turn whose stop carries no detail on the first poll after it', async () => {
    const PLAIN: TimelineEvent[] = [
      { at: T('01:23:05.000'), event: 'post_tool_use', detail: 'view_file' },
      { at: FIRST_STOP, event: 'stop', detail: null },
    ];
    mockTimeline(PLAIN);
    const completedAt = completedAtSpy();

    await runWait([], T('01:28:00.000'), 60_000);

    expect(completedAt()!).toBeLessThan(FIRST_STOP + 6_000);
    expect(stderr()).not.toContain('background work');
    expect(lines().find((l) => l.startsWith('Completed:'))).toBe('Completed: wt1 (basis=hook_stop)');
  });

  it('ignores the detail when the source does not declare it', async () => {
    // A server older than this Issue, or a tool whose source declares false:
    // the capability, not the word, turns the hold on.
    const { stopReportsSelfResume: _omitted, ...undeclared } = AGY_CAPABILITIES;
    void _omitted;
    mockTimeline(INCIDENT, { capabilities: undeclared });
    const completedAt = completedAtSpy();

    await runWait([], T('01:28:00.000'), 60_000);

    expect(completedAt()!).toBeLessThan(FIRST_STOP + 6_000);
    expect(stderr()).not.toContain('background work');
  });

  it('ignores the detail when the source declares false', async () => {
    mockTimeline(INCIDENT, { capabilities: { ...AGY_CAPABILITIES, stopReportsSelfResume: false } });
    const completedAt = completedAtSpy();

    await runWait([], T('01:28:00.000'), 60_000);

    expect(completedAt()!).toBeLessThan(FIRST_STOP + 6_000);
  });

  it('does not hold for a source that declares it but cannot report a turn opening', async () => {
    // Nothing could release such a hold but the bound.
    mockTimeline(INCIDENT, {
      capabilities: { ...AGY_CAPABILITIES, supportedEvents: ['session_start', 'stop'] },
    });
    const completedAt = completedAtSpy();

    await runWait([], T('01:28:00.000'), 60_000);

    expect(completedAt()!).toBeLessThan(FIRST_STOP + 6_000);
  });

  it('does not hold a turn the server closed for another reason', async () => {
    // `generation`: the process that set the timer is gone.
    vi.useFakeTimers();
    vi.setSystemTime(T('01:28:40.000'));
    const frame = currentOutputAt(T('01:28:40.000'), INCIDENT);
    frame.structuredEvents.closedBy = 'generation';
    global.fetch = vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/messages?')) return Promise.resolve(json([userMessage(PROMPT_SENT)]));
      return Promise.resolve(json(frame));
    }) as unknown as typeof fetch;

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).not.toContain('background work');
  });

  it('still reports a never-started session as NOT_STARTED', async () => {
    mockTimeline(INCIDENT, { goneAt: 0 });

    await runWait([], T('01:28:40.000'), 10_000);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
  });
});

describe('ask shares the hold through pollWorktree (Issue #2614)', () => {
  it('returns SUCCESS only after the final stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T('01:28:00.000'));
    mockTimeline(INCIDENT);
    const completedAt = completedAtSpy();

    const client = new ApiClient({ baseUrl: 'http://localhost:3000' });
    const pending = pollWorktree(client, 'wt1', { instance: 'antigravity' });
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    const result = await pending;

    expect(result.exitCode).toBe(WaitExitCode.SUCCESS);
    expect(completedAt()!).toBeGreaterThanOrEqual(FINAL_STOP);
  });
});

describe('the CLI copies stay pinned to the server (Issue #2614)', () => {
  it('uses the same detail word the hooks layer writes', () => {
    expect(SELF_RESUME_PENDING_DETAIL).toBe(SERVER_SELF_RESUME_PENDING_DETAIL);
  });

  it('reads the capability key the sources declare', () => {
    expect(Object.keys(antigravityAgentEventSource.capabilities)).toContain(SELF_RESUME_CAPABILITY);
    expect(
      (antigravityAgentEventSource.capabilities as unknown as Record<string, unknown>)[
        SELF_RESUME_CAPABILITY
      ],
    ).toBe(true);
  });

  it('bounds the hold by the same length the server trusts a silent turn for', () => {
    expect(SELF_RESUME_HOLD_MS).toBe(TURN_STALE_AFTER_MS);
  });
});
