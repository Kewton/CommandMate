/**
 * Two `ask`s to one instance that end up in one turn (Issue #3955).
 *
 * ## The measurement this suite is built from
 *
 * UAT 2026-10-27 (#3945 / #3946), codex-cli 0.164.0, isolated server: a long
 * `ask` A was running when a second `ask` B was sent to the same instance from
 * another terminal. codex put B into A's running turn ("Messages to be
 * submitted after next tool call") and answered once. In runs 1 and 2, A
 * printed `ACK-B`; in run 3, B printed `ACK-A`. Every `ask` exited 0
 * (`basis=hook_stop`) and nothing said the reply might belong to the other
 * message.
 *
 * ## What is pinned here
 *
 *  1. the earlier ask (A) sees B's `user` row between its send and the end of
 *     the turn, and says `overlapped:` on stderr / `"overlapped": true`;
 *  2. the later ask (B) sees that the turn its wait settled on opened before
 *     its own send, and says the same;
 *  3. both still exit 0 with the reply: the exit code does not change;
 *  4. an ask that did not overlap prints exactly what it printed before — no
 *     line, no key — on codex and on tools without a transcript reader alike.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { hasForeignPromptInWindow } from '../../../../src/cli/utils/reply-ledger';
import type { PromptMessageResponse } from '../../../../src/cli/types/api-responses';

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

/** Fixed clock: the moment this ask is run. */
const NOW = 1_787_400_000_000;

/** When the (shared) turn ends. */
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

/** A published turn (#1930 server): `dialogPendingMaxMs` is wait's version probe. */
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

/** A `current-output` frame: running, or back at the composer when `done`. */
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
    ...(turn
      ? {
        lastStopEventAt: turn.closedAt,
        structuredEvents: structured(turn),
      }
      : {}),
  };
}

function userRow(id: string, content: string, at: number, instanceId = 'codex') {
  return {
    id,
    worktreeId: 'wt1',
    role: 'user',
    content,
    timestamp: new Date(at).toISOString(),
    messageType: 'normal',
    instanceId,
    archived: false,
  };
}

function replyRow(content: string, at: number, requestId: string | null = 'codex-turn:01') {
  return {
    id: `r-${at}`,
    worktreeId: 'wt1',
    role: 'assistant',
    content,
    timestamp: new Date(at).toISOString(),
    messageType: 'normal',
    ...(requestId ? { requestId } : {}),
    archived: false,
  };
}

interface Scenario {
  cliToolId: string;
  /** The turn the server publishes, as a function of the clock (null: no hooks). */
  turn: () => Turn | null;
  /** Whether the frame says the turn is over. */
  done: () => boolean;
  /** Ledger rows, resolved at read time. */
  messages: () => unknown[];
  pane?: string;
}

function mockServer(scenario: Scenario): void {
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/api/capabilities')) {
      return Promise.resolve(
        json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }),
      );
    }
    if (url.includes('/resolve-target')) {
      return Promise.resolve(
        json({
          cliToolId: scenario.cliToolId,
          instanceId: scenario.cliToolId,
          resolvedBy: 'roster',
          conflict: null,
        }),
      );
    }
    if (url.includes('/send')) return Promise.resolve(json({ id: 1 }, 201));
    if (url.includes('/messages')) return Promise.resolve(json(scenario.messages()));
    if (url.includes('/capture')) return Promise.resolve(json({ output: scenario.pane ?? '' }));
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
const payload = (): Record<string, unknown> =>
  JSON.parse(mockConsoleLog.mock.calls[0][0] as string);

describe('ask: two asks folded into one codex turn are reported (Issue #3955)', () => {
  it('the earlier ask (A) says overlapped when B reaches the instance during its turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // run1 / run2: A is sent at NOW, B two seconds later, one turn answers both
    // and the one reply is B's.
    mockServer({
      cliToolId: 'codex',
      turn: () => ({ openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      messages: () => [
        userRow('ua', BODY_A, NOW + 1),
        userRow('ub', BODY_B, NOW + 2_000),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-B', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toEqual({
      worktreeId: 'wt1',
      instanceId: 'codex',
      cliToolId: 'codex',
      source: 'history',
      reply: 'ACK-B',
      overlapped: true,
    });
    const lines = stderr().split('\n').filter((l) => l.startsWith('overlapped: '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('another message reached codex');
  });

  it('the earlier ask says it in text mode too, and still prints the reply', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockServer({
      cliToolId: 'codex',
      turn: () => null,
      done: () => Date.now() >= DONE_AT,
      messages: () => [
        userRow('ua', BODY_A, NOW + 1),
        userRow('ub', BODY_B, NOW + 2_000),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-B', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--instance', 'codex']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(mockConsoleLog.mock.calls).toEqual([['ACK-B']]);
    expect(stderr()).toMatch(/^overlapped: /m);
  });

  it('the later ask (B) says overlapped when its message joined a turn already open', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // run3: A's turn opened before B was sent and is still open; B is folded
    // into it, and the one reply is A's.
    const A_OPENED = NOW - 3_000;
    mockServer({
      cliToolId: 'codex',
      turn: () => ({ openedAt: A_OPENED, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      messages: () => [
        userRow('ua', BODY_A, A_OPENED - 100),
        userRow('ub', BODY_B, NOW + 1),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-A', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_B, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ reply: 'ACK-A', overlapped: true });
    expect(stderr()).toMatch(/^overlapped: codex was already in a turn/m);
  });
});

describe('ask: an ask that did not overlap is unchanged (Issue #3955)', () => {
  it('a plain codex ask prints the payload it always did, with no overlapped line or key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The previous turn closed ten minutes ago; this ask's own turn opens after
    // the send and closes at DONE_AT.
    mockServer({
      cliToolId: 'codex',
      turn: () => (Date.now() < NOW + 600
        ? { openedAt: NOW - 600_000, closedAt: NOW - 590_000 }
        : { openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      messages: () => [
        userRow('old', 'an earlier request', NOW - 600_000),
        replyRow('earlier answer', NOW - 590_000, 'codex-turn:00'),
        userRow('ua', BODY_A, NOW + 1),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-A', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toEqual({
      worktreeId: 'wt1',
      instanceId: 'codex',
      cliToolId: 'codex',
      source: 'history',
      reply: 'ACK-A',
    });
    expect(Object.keys(payload())).toEqual(['worktreeId', 'instanceId', 'cliToolId', 'source', 'reply']);
    expect(stderr()).not.toContain('overlapped');
  });

  it('a message sent after the turn ended is the next turn\'s, not an overlap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The codex reply row lands 5 s after the stop (#2386), and a script's next
    // send can land inside that gap: it went to the NEXT turn.
    mockServer({
      cliToolId: 'codex',
      turn: () => ({ openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      messages: () => [
        userRow('ua', BODY_A, NOW + 1),
        ...(Date.now() >= DONE_AT + 6_000 ? [userRow('next', BODY_B, DONE_AT + 6_000)] : []),
        ...(Date.now() >= DONE_AT + 8_000 ? [replyRow('ACK-A', DONE_AT + 1_000)] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--instance', 'codex']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(mockConsoleLog.mock.calls).toEqual([['ACK-A']]);
    expect(stderr()).not.toContain('overlapped');
  });

  it('a previous turn that closed just before the send is not one this message joined', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Opened inside wait's adoption grace, but closed before askedAt.
    mockServer({
      cliToolId: 'codex',
      turn: () => (Date.now() < NOW + 600
        ? { openedAt: NOW - 2_000, closedAt: NOW - 500 }
        : { openedAt: NOW + 600, closedAt: Date.now() >= DONE_AT ? DONE_AT : null }),
      done: () => Date.now() >= DONE_AT,
      messages: () => [
        userRow('prev', 'the previous request', NOW - 2_000),
        replyRow('previous answer', NOW - 500, 'codex-turn:00'),
        userRow('ua', BODY_A, NOW + 1),
        ...(Date.now() >= DONE_AT ? [replyRow('ACK-A', DONE_AT)] : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).not.toHaveProperty('overlapped');
    expect(stderr()).not.toContain('overlapped');
  });

  it.each(['claude', 'copilot', 'gemini'])('a plain %s ask is not warned about', async (tool) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const hasTranscript = tool === 'claude';
    mockServer({
      cliToolId: tool,
      turn: () => null,
      done: () => Date.now() >= DONE_AT,
      messages: () => [
        userRow('old', 'an earlier request', NOW - 600_000, tool),
        userRow('ua', BODY_A, NOW + 1, tool),
        ...(Date.now() >= DONE_AT
          ? [replyRow('ACK-A', DONE_AT, hasTranscript ? `${tool}-turn:01` : null)]
          : []),
      ],
    });

    await runAsk(['wt1', BODY_A, '--instance', tool, '--json']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toEqual({
      worktreeId: 'wt1',
      instanceId: tool,
      cliToolId: tool,
      source: 'history',
      reply: 'ACK-A',
    });
    expect(stderr()).not.toContain('overlapped');
  });
});

describe('hasForeignPromptInWindow (Issue #3955)', () => {
  const rows = (...r: ReturnType<typeof userRow>[]) => r as unknown as PromptMessageResponse[];

  it('is true for a user row with other text inside the window', () => {
    expect(hasForeignPromptInWindow(rows(userRow('b', BODY_B, NOW + 5)), BODY_A, NOW, NOW + 10)).toBe(true);
  });

  it('ignores this ask\'s own text, trimmed as /send stores it', () => {
    expect(hasForeignPromptInWindow(rows(userRow('a', BODY_A, NOW + 5)), `  ${BODY_A}\n`, NOW, NOW + 10)).toBe(false);
  });

  it('ignores rows outside the window and assistant rows', () => {
    const outside = rows(userRow('b0', BODY_B, NOW - 1), userRow('b1', BODY_B, NOW + 11));
    expect(hasForeignPromptInWindow(outside, BODY_A, NOW, NOW + 10)).toBe(false);
    const assistant = [replyRow('ACK-B', NOW + 5)] as unknown as PromptMessageResponse[];
    expect(hasForeignPromptInWindow(assistant, BODY_A, NOW, NOW + 10)).toBe(false);
  });
});
