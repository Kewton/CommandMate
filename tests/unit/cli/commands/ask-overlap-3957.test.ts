/**
 * `ask` reads the send API's own reading of the instance at the send (Issue
 * #3957): `turnOpenAtSend: true` means a turn was open when the message went
 * out, so the reply is reported as overlapped without relying on the turn
 * record a poll sees — the server publishes only the newest one, and a turn
 * that opens right after the send replaces it before the first poll.
 *
 * When the key is there its value alone decides the later-ask side (it is
 * read at the input start, which is after `askedAt`); without it `ask` falls
 * back to the turn record. The earlier-ask side (another message reaching the
 * instance during this turn) is not something the send can see and is kept.
 *
 * Positive: the old record is replaced before the first poll and the send
 * said the turn was open → overlapped (fails before #3957). Negative: the same
 * replaced record with no mark → no `overlapped` key (the detection #3955 had);
 * the mark absent and the record showing the open turn → still overlapped;
 * `false` with a poll that saw a turn open at `askedAt` (it ended before the
 * input) → not overlapped.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';

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

const NOW = 1_787_400_000_000;
const DONE_AT = NOW + 12_000;

const BODY_A = 'Long request A. Reply with exactly: ACK-A';
const BODY_B = 'Request B. Reply with exactly: ACK-B';

const json = (data: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }) as unknown as Response;

interface Turn {
  openedAt: number;
  closedAt: number | null;
}

function structured(turn: Turn) {
  return {
    lastEventType: turn.closedAt === null ? 'user_prompt_submit' : 'stop',
    lastEventAt: turn.closedAt ?? turn.openedAt,
    lastEventDetail: null,
    promptWaitingSince: null,
    promptWaitingSource: null,
    turnId: `t-${turn.openedAt}`,
    openedAt: turn.openedAt,
    closedAt: turn.closedAt,
    closedBy: turn.closedAt === null ? null : 'stop',
    pendingDecisions: [],
    dedupDropped: {
      dedupDropped: { identity: 0, timeWindow: 0 },
      decisionEvicted: 0,
      idsDiscarded: 0,
      dialogTimedOut: 0,
      decisionOverflow: 0,
    },
    dialogPendingMaxMs: { predicted: 20_000, confirmed: 1_800_000 },
  };
}

function frame(cliToolId: string, done: boolean, turn: Turn | null) {
  return {
    isRunning: true,
    isPromptWaiting: false,
    content: done ? 'done' : `working ${Date.now()}`,
    fullOutput: 'done',
    realtimeSnippet: '',
    lineCount: 1,
    lastCapturedLine: 1,
    promptData: null,
    autoYes: { enabled: false, expiresAt: null },
    thinking: !done,
    cliToolId,
    isSelectionListActive: false,
    lastServerResponseTimestamp: null,
    serverPollerActive: false,
    sessionStatus: done ? ('ready' as const) : ('running' as const),
    sessionStatusReason: done ? 'hook_stop' : 'thinking_indicator',
    ...(turn ? { lastStopEventAt: turn.closedAt, structuredEvents: structured(turn) } : {}),
  };
}

interface Row {
  id: string;
  worktreeId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  messageType: 'normal';
  instanceId: string;
  requestId?: string;
  archived: false;
}

function userRow(id: string, content: string, at: number, instanceId = 'codex'): Row {
  return {
    id, worktreeId: 'wt1', role: 'user', content,
    timestamp: new Date(at).toISOString(), messageType: 'normal', instanceId, archived: false,
  };
}

function replyRow(content: string, at: number, instanceId = 'codex', requestId = 'codex-turn:01'): Row {
  return {
    id: `r-${at}-${content}`, worktreeId: 'wt1', role: 'assistant', content,
    timestamp: new Date(at).toISOString(), messageType: 'normal', instanceId, requestId, archived: false,
  };
}

/**
 * `GET /messages` over `rows`, as `getMessages` + the route answer it:
 * newest-first `limit` rows (or the newest `limit` user turns with
 * `unit=pairs`), `before` exclusive, `instance` exact, chronological out.
 */
function serveMessages(rows: Row[], url: URL): Row[] {
  const limit = Number(url.searchParams.get('limit') ?? '50');
  const instance = url.searchParams.get('instance');
  const before = url.searchParams.get('before');
  const at = (r: Row) => Date.parse(r.timestamp);
  const scope = rows
    .filter((r) => instance === null || r.instanceId === instance)
    .filter((r) => before === null || at(r) < Date.parse(before))
    .sort((a, b) => at(b) - at(a));
  let out: Row[];
  const users = scope.filter((r) => r.role === 'user').slice(0, limit);
  if (url.searchParams.get('unit') === 'pairs' && users.length > 0) {
    const cutoff = Math.min(...users.map(at));
    out = scope.filter((r) => at(r) >= cutoff);
  } else {
    out = scope.slice(0, limit);
  }
  return out.sort((a, b) => at(a) - at(b));
}

interface Scenario {
  cliToolId: string;
  turn: () => Turn | null;
  done: () => boolean;
  rows: () => Row[];
  /** Run on the `/send` request (e.g. to move the clock past the send). */
  onSend?: () => void;
  /** The `/send` 201 body. */
  sent: Record<string, unknown>;
}

const messageUrls: string[] = [];

function mockServer(scenario: Scenario): void {
  messageUrls.length = 0;
  global.fetch = vi.fn((input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname;
    if (path.includes('/api/capabilities')) {
      return Promise.resolve(json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }));
    }
    if (path.includes('/resolve-target')) {
      return Promise.resolve(json({
        cliToolId: scenario.cliToolId, instanceId: scenario.cliToolId, resolvedBy: 'roster', conflict: null,
      }));
    }
    if (path.includes('/send')) {
      scenario.onSend?.();
      return Promise.resolve(json(scenario.sent, 201));
    }
    if (path.includes('/messages')) {
      messageUrls.push(url.search);
      return Promise.resolve(json(serveMessages(scenario.rows(), url)));
    }
    if (path.includes('/capture')) return Promise.resolve(json({ output: '' }));
    return Promise.resolve(json(frame(scenario.cliToolId, scenario.done(), scenario.turn())));
  }) as unknown as typeof fetch;
}

async function runAsk(argv: string[], advanceMs = 60_000): Promise<void> {
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  const pending = createAskCommand().parseAsync(['node', 'ask', ...argv]);
  await vi.advanceTimersByTimeAsync(advanceMs);
  await pending;
}

const stderr = (): string => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');
const payload = (): Record<string, unknown> => JSON.parse(mockConsoleLog.mock.calls[0][0] as string);

const SENT = { id: 1, worktreeId: 'wt1', role: 'user', content: BODY_B };

/**
 * A's turn opened before B's send and closed at +300; B's own turn opened at
 * +400. The first poll (+1000) sees only B's turn: nothing a poll reads says
 * B was sent into A's turn.
 */
function replacedRecord(sent: Record<string, unknown>): Scenario {
  return {
    cliToolId: 'codex',
    sent,
    onSend: () => vi.setSystemTime(NOW + 1_000),
    turn: () => ({ openedAt: NOW + 400, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
    done: () => Date.now() >= DONE_AT,
    rows: () => [
      userRow('ua', BODY_A, NOW - 10_100),
      replyRow('ACK-A', NOW + 300, 'codex', 'codex-turn:00'),
      userRow('ub', BODY_B, NOW + 1),
      ...(Date.now() >= DONE_AT ? [replyRow('ACK-B', DONE_AT)] : []),
    ],
  };
}

describe('the send API says the instance was mid-turn at the send (Issue #3957)', () => {
  it('positive: overlapped though the record was replaced before the first poll', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer(replacedRecord({ ...SENT, turnOpenAtSend: true }));

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ reply: 'ACK-B', overlapped: true });
    expect(stderr()).toMatch(/^overlapped: codex was already in a turn/m);
  });

  it('negative: no mark and a replaced record is not an overlap (the detection before #3957)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer(replacedRecord(SENT));

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toEqual({
      worktreeId: 'wt1', instanceId: 'codex', cliToolId: 'codex', source: 'history', reply: 'ACK-B',
    });
    expect(stderr()).not.toContain('overlapped');
  });

  it('no mark (a tool without turn-start hooks, an older server) falls back to the turn record', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const A_OPENED = NOW - 10_000;
    mockServer({
      cliToolId: 'codex',
      sent: SENT,
      onSend: () => vi.setSystemTime(NOW + 1_000),
      turn: () => ({ openedAt: A_OPENED, closedAt: NOW + 500 }),
      done: () => true,
      rows: () => [
        userRow('ua', BODY_A, A_OPENED - 100),
        userRow('ub', BODY_B, NOW + 1),
        replyRow('ACK-A', NOW + 500),
      ],
    });

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ reply: 'ACK-A', overlapped: true });
  });

  it('askedAt → the old turn ends → input: turnOpenAtSend false is not an overlap, though a poll saw that turn open at askedAt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const A_OPENED = NOW - 10_000;
    mockServer({
      cliToolId: 'codex',
      // A's turn closed after askedAt (+300) but before the body went in.
      sent: { ...SENT, turnOpenAtSend: false },
      onSend: () => vi.setSystemTime(NOW + 1_000),
      turn: () => (Date.now() < NOW + 3_000
        ? { openedAt: A_OPENED, closedAt: NOW + 300 }
        : { openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ua', BODY_A, A_OPENED - 100),
        replyRow('ACK-A', NOW + 300, 'codex', 'codex-turn:00'),
        userRow('ub', BODY_B, NOW + 500),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-B', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toEqual({
      worktreeId: 'wt1', instanceId: 'codex', cliToolId: 'codex', source: 'history', reply: 'ACK-B',
    });
    expect(stderr()).not.toContain('overlapped');
  });

  it('the same timeline with no key falls back to the turn record (overlapped)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const A_OPENED = NOW - 10_000;
    mockServer({
      cliToolId: 'codex',
      sent: SENT,
      onSend: () => vi.setSystemTime(NOW + 1_000),
      turn: () => (Date.now() < NOW + 3_000
        ? { openedAt: A_OPENED, closedAt: NOW + 300 }
        : { openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ua', BODY_A, A_OPENED - 100),
        replyRow('ACK-A', NOW + 300, 'codex', 'codex-turn:00'),
        userRow('ub', BODY_B, NOW + 500),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-B', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ overlapped: true });
  });

  it('turnOpenAtSend false does not hide the other side: a message folded into this turn is still an overlap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer({
      cliToolId: 'codex',
      sent: { ...SENT, turnOpenAtSend: false },
      turn: () => ({ openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ub', BODY_B, NOW + 1),
        userRow('ua', BODY_A, NOW + 2_000),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-A', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ reply: 'ACK-A', overlapped: true });
    expect(stderr()).toMatch(/^overlapped: another message reached codex/m);
  });
});

/**
 * The earlier-ask side counts from this ask's own input, not from `askedAt`
 * (Issue #3957): B's `askedAt` → A's body → A's `Stop` → B's body → B done.
 * A went in and was answered while B waited, so A's row lies inside
 * `[askedAt, until]` but before B's own row.
 */
describe('the earlier-ask side counts from the stamp of the row the send returned (Issue #3957)', () => {
  const B_INPUT = NOW + 800;

  function answeredWhileWaiting(sent: Record<string, unknown>, foreignAt = NOW + 200): Scenario {
    return {
      cliToolId: 'codex',
      sent,
      onSend: () => vi.setSystemTime(NOW + 1_000),
      turn: () => ({ openedAt: B_INPUT, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ua', BODY_A, foreignAt),
        ...(foreignAt < B_INPUT ? [replyRow('ACK-A', NOW + 600, 'codex', 'codex-turn:00')] : []),
        userRow('ub', BODY_B, B_INPUT),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-B', DONE_AT)] : []),
      ],
    };
  }

  it('positive: a request that went in and ended before this ask\'s input is not an overlap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer(answeredWhileWaiting({
      ...SENT, turnOpenAtSend: false, timestamp: new Date(B_INPUT).toISOString(),
    }));

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toEqual({
      worktreeId: 'wt1', instanceId: 'codex', cliToolId: 'codex', source: 'history', reply: 'ACK-B',
    });
    expect(stderr()).not.toContain('overlapped');
  });

  it('negative: another message after this ask\'s input is still an overlap (foreign-message)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer(answeredWhileWaiting({
      ...SENT, turnOpenAtSend: false, timestamp: new Date(B_INPUT).toISOString(),
    }, NOW + 2_000));

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ overlapped: true });
    expect(stderr()).toMatch(/^overlapped: another message reached codex/m);
  });

  it('no stamp on the send body (an older server) keeps askedAt as the lower bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer(answeredWhileWaiting({ ...SENT, turnOpenAtSend: false }));

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ overlapped: true });
    expect(stderr()).toMatch(/^overlapped: another message reached codex/m);
  });

  it('an unparsable stamp is treated as not known (askedAt)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer(answeredWhileWaiting({ ...SENT, turnOpenAtSend: false, timestamp: 'not-a-date' }));

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ overlapped: true });
  });
});
