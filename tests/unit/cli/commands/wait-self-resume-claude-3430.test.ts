/**
 * Issue #3430: `wait` holds a Claude `stop` that leaves background work behind,
 * the way #2614 holds antigravity's.
 *
 * Measured, not imagined. On 2026-10-08 a Claude Code worker (worktree
 * commandmate-issue-3423) sent its test run to the background, started five
 * Monitors on it and ended its turn at 23:37:53 "waiting for the related-tests
 * run to finish". `wait --verify` read that `Stop` as the end and verified the
 * worktree before the commit (`GATE work-evidence PASS (commits=0,
 * uncommitted=5)`). The notification opened the next turn at 23:38:14, which
 * committed at 23:38:32, and each Monitor's notice opened one more turn until
 * the last `Stop` at 23:47:51.
 *
 * The event times are the server's (`server.log`) and, after 23:38:45, the
 * transcript's. Which stops carry `self_resume_pending` is not written here by
 * hand: it is what `pendingClaudeBackgroundTasks` reads off the transcript
 * fixture at each `stop_hook_summary`, so this file replays what the source
 * would really have published. The timeline model is the one
 * `wait-self-resume-2614.test.ts` uses, with Claude's turn-opening event.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';
import { SELF_RESUME_PENDING_DETAIL } from '../../../../src/cli/commands/wait';
import { pendingClaudeBackgroundTasks } from '@/lib/hooks/sources/claude/self-resume';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';

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

/** Epoch ms of a UTC time on the night of the incident. */
const T = (hms: string): number => Date.parse(`2026-10-07T${hms}Z`);

const FIXTURE_LINES = readFileSync(
  join(process.cwd(), 'tests/fixtures/claude-self-resume-3430/transcript.jsonl'),
  'utf8'
)
  .split('\n')
  .filter((line) => line !== '');

/** The detail the source publishes on each `stop`, read off the transcript as of that stop. */
const STOP_DETAILS: (string | null)[] = FIXTURE_LINES.flatMap((line, i) =>
  (JSON.parse(line) as { subtype?: string }).subtype === 'stop_hook_summary'
    ? [pendingClaudeBackgroundTasks(FIXTURE_LINES.slice(0, i).join('\n')).length > 0 ? SELF_RESUME_PENDING_DETAIL : null]
    : []
);

interface TimelineEvent {
  at: number;
  event: 'stop' | 'user_prompt_submit';
  detail: string | null;
}

const PROMPT_SENT = T('23:32:53.638');
const FIRST_STOP = T('23:37:53.377');
const FINAL_STOP = T('23:47:51.432');

/** The wakes are the notifications' `UserPromptSubmit`s, opening a turn each. */
const WAKES_AND_STOPS: [string, string][] = [
  ['23:38:14.727', '23:38:45.656'],
  ['23:40:12.770', '23:40:14.924'],
  ['23:43:47.696', '23:43:49.816'],
  ['23:47:06.467', '23:47:08.508'],
  ['23:47:10.965', '23:47:13.093'],
  ['23:47:49.375', '23:47:51.432'],
];

const INCIDENT: TimelineEvent[] = [
  { at: PROMPT_SENT, event: 'user_prompt_submit', detail: null },
  // A Monitor's notice absorbed into the running turn (#3330): no new turn.
  { at: T('23:37:16.023'), event: 'user_prompt_submit', detail: null },
  { at: FIRST_STOP, event: 'stop', detail: STOP_DETAILS[0] },
  ...WAKES_AND_STOPS.flatMap(([wake, stop], n): TimelineEvent[] => [
    { at: T(wake), event: 'user_prompt_submit', detail: null },
    { at: T(stop), event: 'stop', detail: STOP_DETAILS[n + 1] },
  ]),
];

/** What the server published that night: no detail on any Claude stop. */
const INCIDENT_WITHOUT_DETAIL = INCIDENT.map((e) => ({ ...e, detail: null }));

/** Claude's declaration, as its source publishes it. */
const CLAUDE_CAPABILITIES = JSON.parse(JSON.stringify(claudeAgentEventSource.capabilities)) as Record<
  string,
  unknown
>;

/** `current-output` at `now`. The turn rules of `wait-self-resume-2614.test.ts`. */
function currentOutputAt(now: number, events: TimelineEvent[]) {
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
  const ready = last?.event === 'stop';
  return {
    isRunning: true,
    isPromptWaiting: false,
    content: `frame-${seen.length}`,
    fullOutput: `frame-${seen.length}`,
    realtimeSnippet: `frame-${seen.length}`,
    lineCount: 1,
    lastCapturedLine: 1,
    promptData: null,
    autoYes: { enabled: false, expiresAt: null },
    thinking: false,
    cliToolId: 'claude',
    isSelectionListActive: false,
    lastServerResponseTimestamp: null,
    serverPollerActive: false,
    sessionStatus: ready ? ('ready' as const) : ('running' as const),
    sessionStatusReason: ready ? 'hook_stop' : 'hook_user_prompt_submit',
    lastStopEventAt,
    structuredEvents: {
      lastEventType: last?.event ?? null,
      lastEventAt: last?.at ?? null,
      lastEventDetail: last?.detail ?? null,
      promptWaitingSince: null,
      promptWaitingSource: null,
      source: { cliToolId: 'claude', capabilities: CLAUDE_CAPABILITIES },
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
  content: 'Implement #3423',
  timestamp: new Date(at).toISOString(),
  messageType: 'normal',
  cliToolId: 'claude',
  instanceId: 'claude',
  archived: false,
});

/** @returns When (fake clock) `wait --verify` asked for a verification run, or null */
function mockTimeline(events: TimelineEvent[]): () => number | null {
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
      return Promise.resolve(json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }));
    }
    if (url.includes('/resolve-target')) {
      return Promise.resolve(json({ cliToolId: 'claude', instanceId: 'claude', resolvedBy: 'roster', conflict: null }));
    }
    if (url.includes('/messages?')) {
      return Promise.resolve(json([userMessage(PROMPT_SENT)]));
    }
    return Promise.resolve(json(currentOutputAt(Date.now(), events)));
  }) as unknown as typeof fetch;
  return () => verifyRequestedAt;
}

const lines = () => mockConsoleError.mock.calls.map((c) => String(c[0]));

function completedAtSpy(): () => number | null {
  let at: number | null = null;
  mockConsoleError.mockImplementation((message: unknown) => {
    if (at === null && String(message).startsWith('Completed:')) at = Date.now();
  });
  return () => at;
}

async function runWait(args: string[], startAt: number, runForMs: number): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(startAt);
  const cmd = (await import('../../../../src/cli/commands/wait')).createWaitCommand();
  const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--instance', 'claude', ...args]);
  await vi.advanceTimersByTimeAsync(runForMs);
  await pending;
}

describe('the 2026-10-08 incident, replayed (Issue #3430)', () => {
  it('reads six held stops and one final one off the transcript', () => {
    expect(STOP_DETAILS).toEqual([...Array(6).fill(SELF_RESUME_PENDING_DETAIL), null]);
    expect(CLAUDE_CAPABILITIES.stopReportsSelfResume).toBe(true);
  });

  it('lets wait --verify start its run only after the stop that really ends the work', async () => {
    const verifyRequestedAt = mockTimeline(INCIDENT);
    const completedAt = completedAtSpy();

    await runWait(['--verify'], T('23:37:30.000'), 12 * 60_000);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(completedAt()!).toBeGreaterThanOrEqual(FINAL_STOP);
    expect(completedAt()!).toBeLessThan(FINAL_STOP + 6_000);
    // The commit landed at 23:38:32; the run that night started at 23:37:56.
    expect(verifyRequestedAt()!).toBeGreaterThanOrEqual(FINAL_STOP);
    expect(lines().find((l) => l.startsWith('Completed:'))).toMatch(
      /^Completed: wt1 \(basis=hook_stop, heldForSelfResume=\d+s\)$/
    );
  });

  it('completed on the first stop without the detail — the control case', async () => {
    const verifyRequestedAt = mockTimeline(INCIDENT_WITHOUT_DETAIL);
    const completedAt = completedAtSpy();

    await runWait(['--verify'], T('23:37:30.000'), 2 * 60_000);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(completedAt()!).toBeGreaterThanOrEqual(FIRST_STOP);
    expect(completedAt()!).toBeLessThan(FIRST_STOP + 6_000);
    expect(verifyRequestedAt()!).toBeLessThan(T('23:38:32.000'));
  });
});
