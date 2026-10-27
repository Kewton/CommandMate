/**
 * Two `ask`s to one instance in one turn: the four holes the consistency
 * review found in the first cut (Issue #3955, second contract).
 *
 *  1. the later ask joined a turn that opened more than one poll interval
 *     earlier and closed before its first poll — `wait` does not adopt such a
 *     turn, so the ask has to keep its own reading of the turn record;
 *  2. the earlier ask's ledger read is the newest 30 rows, so the other
 *     message's `user` row falls out of it once 30 rows come after it;
 *  3. an ask with no `--instance` / `--agent` read every instance's rows and
 *     counted a message sent to another session;
 *  4. the window ended when a poll SAW the turn end, up to a poll interval
 *     after the `Stop`, so the next request sent in between was counted.
 *
 * Each has a positive control (fails on 5f22eff73) and a negative one.
 * The server is an in-memory stand-in for the messages route that honours
 * `limit`, `unit=pairs`, `before` and `instance` the way `getMessages` does.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import {
  REPLY_LOOKBACK_MESSAGES,
  fetchPromptRowsSince,
  hasForeignPromptInWindow,
  mayHaveDroppedRowsSince,
  ownPromptInstance,
} from '../../../../src/cli/utils/reply-ledger';
import type { PromptMessageResponse } from '../../../../src/cli/types/api-responses';
import type { ApiClient } from '../../../../src/cli/utils/api-client';

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
      return Promise.resolve(json({ id: 1 }, 201));
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

describe('(1) the later ask joined an old turn that closed before its first poll (Issue #3955)', () => {
  const A_OPENED = NOW - 10_000;

  it('says overlapped though wait adopted no turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // A's turn opened 10 s before B's send (past wait's 5 s adoption grace);
    // B was folded in, and the turn closed at +500 — before B's first poll
    // at +1000. wait adopts nothing; the record still shows the open turn.
    mockServer({
      cliToolId: 'codex',
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

    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ reply: 'ACK-A', overlapped: true });
    expect(stderr()).toMatch(/^overlapped: codex was already in a turn/m);
  });

  it('an old turn that closed before the send is not one this message joined', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer({
      cliToolId: 'codex',
      onSend: () => vi.setSystemTime(NOW + 1_000),
      turn: () => (Date.now() < NOW + 6_000
        ? { openedAt: A_OPENED, closedAt: NOW - 100 }
        : { openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ua', BODY_A, A_OPENED - 100),
        replyRow('ACK-A', NOW - 100, 'codex', 'codex-turn:00'),
        userRow('ub', BODY_B, NOW + 1),
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
});

describe('(2) the earlier ask finds the other user row behind 30+ rows (Issue #3955)', () => {
  /** codex narrating a long turn: many assistant rows after B's message. */
  const narration = (from: number, n: number): Row[] =>
    Array.from({ length: n }, (_, i) => replyRow(`step ${i}`, from + i * 100));

  it('says overlapped though B is out of the newest 30 rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer({
      cliToolId: 'codex',
      turn: () => ({ openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ua', BODY_A, NOW + 1),
        userRow('ub', BODY_B, NOW + 2_000),
        ...narration(NOW + 2_100, REPLY_LOOKBACK_MESSAGES + 5),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-B', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ reply: 'ACK-B', overlapped: true });
    expect(stderr()).toMatch(/^overlapped: another message reached codex/m);
    // The reply read itself is unchanged: the newest 30 rows, scoped.
    expect(messageUrls[0]).toBe('?limit=30&instance=codex');
  });

  it('a long turn with no other message is not warned about', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer({
      cliToolId: 'codex',
      turn: () => ({ openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('old', 'an earlier request', NOW - 600_000),
        userRow('ua', BODY_A, NOW + 1),
        ...narration(NOW + 2_100, REPLY_LOOKBACK_MESSAGES + 5),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-A', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).not.toHaveProperty('overlapped');
    expect(stderr()).not.toContain('overlapped');
  });
});

describe('(3) an ask with no --instance counts only its own instance (Issue #3955)', () => {
  it('a message sent to another instance during the turn is not an overlap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer({
      cliToolId: 'codex',
      turn: () => ({ openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ua', BODY_A, NOW + 1, 'codex'),
        userRow('other', BODY_B, NOW + 2_000, 'codex-2'),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-A', DONE_AT, 'codex')] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).not.toHaveProperty('overlapped');
    expect(stderr()).not.toContain('overlapped');
  });

  it('a message to the instance the send landed on still is', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer({
      cliToolId: 'codex',
      turn: () => ({ openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ua', BODY_A, NOW + 1, 'codex'),
        userRow('ub', BODY_B, NOW + 2_000, 'codex'),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-B', DONE_AT, 'codex')] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ overlapped: true });
    expect(stderr()).toMatch(/^overlapped: another message reached codex/m);
  });

  it('when the ledger cannot say which instance the send landed on, says nothing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The same text went to two instances: neither row is certainly this one's.
    mockServer({
      cliToolId: 'codex',
      turn: () => ({ openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ua', BODY_A, NOW + 1, 'codex'),
        userRow('ua2', BODY_A, NOW + 2, 'codex-2'),
        userRow('ub', BODY_B, NOW + 2_000, 'codex'),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-B', DONE_AT, 'codex')] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).not.toHaveProperty('overlapped');
  });
});

describe('(4) the next request sent after the Stop is not this turn\'s (Issue #3955)', () => {
  it('a request between the server\'s close and the poll that saw it is not an overlap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Polls at +0, +5, +10, +15 s; the turn closed at +12 s; the next request
    // landed at +13.5 s, before the +15 s poll saw the turn over.
    mockServer({
      cliToolId: 'codex',
      turn: () => ({ openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ua', BODY_A, NOW + 1),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-A', DONE_AT)] : []),
        ...(Date.now() >= DONE_AT + 1_500 ? [userRow('next', BODY_B, DONE_AT + 1_500)] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).not.toHaveProperty('overlapped');
    expect(stderr()).not.toContain('overlapped');
  });

  it('a request just before the close still is', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer({
      cliToolId: 'codex',
      turn: () => ({ openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      rows: () => [
        userRow('ua', BODY_A, NOW + 1),
        ...(Date.now() >= DONE_AT - 500 ? [userRow('ub', BODY_B, DONE_AT - 500)] : []),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-B', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ overlapped: true });
  });
});

describe('reply-ledger helpers for the overlap check (Issue #3955)', () => {
  const asRows = (r: Row[]) => r as unknown as PromptMessageResponse[];

  it('hasForeignPromptInWindow skips rows on another instance when one is given', () => {
    const rows = asRows([userRow('b', BODY_B, NOW + 5, 'codex-2')]);
    expect(hasForeignPromptInWindow(rows, BODY_A, NOW, NOW + 10, 'codex')).toBe(false);
    expect(hasForeignPromptInWindow(rows, BODY_A, NOW, NOW + 10, 'codex-2')).toBe(true);
  });

  it('ownPromptInstance names the one instance the own row is on, else null', () => {
    expect(ownPromptInstance(asRows([userRow('a', BODY_A, NOW + 1, 'codex-2')]), BODY_A, NOW)).toBe('codex-2');
    expect(ownPromptInstance(asRows([userRow('a', BODY_A, NOW - 1, 'codex-2')]), BODY_A, NOW)).toBeNull();
    expect(ownPromptInstance(asRows([
      userRow('a', BODY_A, NOW + 1, 'codex'), userRow('a2', BODY_A, NOW + 2, 'codex-2'),
    ]), BODY_A, NOW)).toBeNull();
  });

  it('mayHaveDroppedRowsSince is true only for a full read with nothing older than the send', () => {
    const full = Array.from({ length: REPLY_LOOKBACK_MESSAGES }, (_, i) => replyRow(`s${i}`, NOW + i));
    expect(mayHaveDroppedRowsSince(asRows(full), NOW)).toBe(true);
    expect(mayHaveDroppedRowsSince(asRows(full.slice(1)), NOW)).toBe(false);
    expect(mayHaveDroppedRowsSince(asRows([replyRow('old', NOW - 1), ...full.slice(1)]), NOW)).toBe(false);
  });

  it('fetchPromptRowsSince pages back until it passes the send, missing no user row', async () => {
    // 50 user turns after the send, each with 3 assistant rows, and older ones before it.
    const rows: Row[] = [];
    for (let i = -5; i < 50; i += 1) {
      const at = NOW + i * 1_000;
      rows.push(userRow(`u${i}`, `m${i}`, at));
      for (let j = 1; j <= 3; j += 1) rows.push(replyRow(`a${i}.${j}`, at + j * 10));
    }
    const urls: string[] = [];
    const client = {
      get: async (path: string) => {
        const url = new URL(path, 'http://localhost');
        urls.push(url.search);
        return serveMessages(rows, url);
      },
    } as unknown as ApiClient;

    const found = await fetchPromptRowsSince(client, 'wt1', 'codex', NOW);

    expect(found?.map((m) => m.id).sort()).toEqual(
      Array.from({ length: 50 }, (_, i) => `u${i}`).sort(),
    );
    expect(urls.length).toBe(3);
    expect(urls.every((u) => u.includes('unit=pairs') && u.includes('instance=codex'))).toBe(true);
  });

  it('fetchPromptRowsSince returns null when the route cannot be read', async () => {
    const client = { get: async () => { throw new Error('down'); } } as unknown as ApiClient;
    expect(await fetchPromptRowsSince(client, 'wt1', 'codex', NOW)).toBeNull();
  });
});
