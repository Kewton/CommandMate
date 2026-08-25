/**
 * The subscription feeding the history writer (Issue #2041).
 *
 * `tests/integration/opencode-history-2041.test.ts` drives the writer directly;
 * this file pins the wiring, which is where the two ways of getting it wrong
 * live:
 *
 *  - `message.part.updated` maps to `pre_tool_use` / `post_tool_use` for its
 *    tool parts and to **nothing at all** for its text ones, so a reader placed
 *    after `normalize` would never see the prose. It has to run in `deliver`,
 *    beside the #2040 `session.updated` read and the #1763 tool-name memo.
 *  - the backfill has to finish before the stream starts delivering, or a turn
 *    that completes on the new connection is written by both paths.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>()),
  fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
  fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
  fetchOpencodeSessionStatuses: vi.fn().mockResolvedValue({}),
  probeOpencodeHealth: vi.fn(),
  openOpencodeEventStream: vi.fn(),
}));

vi.mock('@/lib/hooks/sources/opencode/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/history')>()),
  recordOpencodeTranscriptFrame: vi.fn(),
  flushOpencodeTurn: vi.fn().mockResolvedValue(false),
  backfillOpencodeHistory: vi.fn().mockResolvedValue(0),
  forgetOpencodeTranscripts: vi.fn(),
}));

vi.mock('@/lib/session/opencode-session-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/opencode-session-store')>()),
  getRememberedOpencodeSession: vi.fn().mockReturnValue(null),
}));

import {
  openOpencodeEventStream,
  probeOpencodeHealth,
  type OpencodeFrame,
} from '@/lib/hooks/sources/opencode/client';
import {
  backfillOpencodeHistory,
  flushOpencodeTurn,
  forgetOpencodeTranscripts,
  recordOpencodeTranscriptFrame,
} from '@/lib/hooks/sources/opencode/history';
import { getRememberedOpencodeSession } from '@/lib/session/opencode-session-store';
import {
  closeOpencodeSubscription,
  isOpencodeStructuredHistoryLive,
  openOpencodeSubscription,
  resetOpencodeSubscriptions,
} from '@/lib/hooks/sources/opencode/subscription';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import { resetAgentSessionTelemetry } from '@/lib/hooks/agent-session-telemetry';
import { resetUnknownEventTallies, type NormalizedAgentEvent } from '@/lib/hooks/sources';

const TARGET = { worktreeId: 'wt-hist', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const PORT = 4242;
const SESSION = 'ses_0000000000000000000000000';

function frame(type: string, properties: Record<string, unknown>): OpencodeFrame {
  return { id: 'evt_0000000000000000000000000', type, properties } as unknown as OpencodeFrame;
}

const ASSISTANT_MESSAGE = frame('message.updated', {
  sessionID: SESSION,
  info: { id: 'msg_a', role: 'assistant', parentID: 'msg_user1' },
});
const TEXT_PART = frame('message.part.updated', {
  sessionID: SESSION,
  part: { id: 'prt_1', messageID: 'msg_a', type: 'text', text: 'the reply' },
});
const IDLE = frame('session.idle', { sessionID: SESSION });

let queued: Array<(signal: AbortSignal) => AsyncGenerator<OpencodeFrame>>;
let received: NormalizedAgentEvent[];

function streamOf(...frames: OpencodeFrame[]) {
  return async function* (): AsyncGenerator<OpencodeFrame> {
    for (const each of frames) yield each;
  };
}

function silentStream(signal: AbortSignal) {
  return async function* (): AsyncGenerator<OpencodeFrame> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
}

function subscribe() {
  return openOpencodeSubscription(
    TARGET,
    (event) => received.push(event),
    (raw) => opencodeAgentEventSource.normalizeEvent(raw),
    { port: PORT }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOpencodeSubscriptions();
  resetOpencodeToolCalls();
  resetUnknownEventTallies();
  resetAgentSessionTelemetry();
  queued = [];
  received = [];
  vi.mocked(getRememberedOpencodeSession).mockReturnValue(null);
  vi.mocked(flushOpencodeTurn).mockResolvedValue(false);
  vi.mocked(backfillOpencodeHistory).mockResolvedValue(0);
  vi.mocked(probeOpencodeHealth).mockResolvedValue({
    kind: 'healthy',
    health: { healthy: true, version: '1.18.22' },
  });
  vi.mocked(openOpencodeEventStream).mockImplementation(
    async (_port: number, signal: AbortSignal) => (queued.shift() ?? silentStream(signal))(signal)
  );
});

afterEach(() => {
  resetOpencodeSubscriptions();
  resetAgentSessionTelemetry();
});

describe('frames reaching the transcript', () => {
  it('records the assistant message and its text part', async () => {
    queued.push(streamOf(ASSISTANT_MESSAGE, TEXT_PART));
    await subscribe();

    await vi.waitFor(() =>
      expect(vi.mocked(recordOpencodeTranscriptFrame)).toHaveBeenCalledTimes(2)
    );
    const types = vi
      .mocked(recordOpencodeTranscriptFrame)
      .mock.calls.map((call) => (call[1] as { type: string }).type);
    expect(types).toEqual(['message.updated', 'message.part.updated']);
  });

  it('records the text part even though it maps to no event word', async () => {
    // The reason the read is in `deliver` and not after `normalize`: a text
    // part is silent to the seven-word vocabulary, so the frame would be
    // dropped two lines later with the prose still inside it.
    queued.push(streamOf(TEXT_PART));
    await subscribe();

    await vi.waitFor(() =>
      expect(vi.mocked(recordOpencodeTranscriptFrame)).toHaveBeenCalledTimes(1)
    );
    expect(received.map((event) => event.event)).not.toContain('post_tool_use');
    expect(received).toHaveLength(0);
  });

  it('leaves message.part.delta alone', async () => {
    // 95 of the 142 measured frames. Reading them would double every character
    // the closing `message.part.updated` already carries.
    queued.push(
      streamOf(
        frame('message.part.delta', {
          sessionID: SESSION,
          messageID: 'msg_a',
          partID: 'prt_1',
          field: 'text',
          delta: 'the ',
        })
      )
    );
    await subscribe();

    // Give the stream a tick to have delivered anything it was going to.
    await vi.waitFor(() => expect(vi.mocked(openOpencodeEventStream)).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(vi.mocked(recordOpencodeTranscriptFrame)).not.toHaveBeenCalled();
  });

  it('flushes the turn on session.idle', async () => {
    queued.push(streamOf(ASSISTANT_MESSAGE, TEXT_PART, IDLE));
    await subscribe();

    await vi.waitFor(() => expect(vi.mocked(flushOpencodeTurn)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(flushOpencodeTurn)).toHaveBeenCalledWith(TARGET, SESSION);
  });

  it('flushes on an idle for a session the gate never armed', async () => {
    // Read off the frame, not off the gate's verdict — the same independence
    // `watchOpencodeSessionIdle` has (#2034). A stream that opened mid-turn
    // publishes no `stop`, and its reply still has to be saved.
    queued.push(streamOf(IDLE));
    await subscribe();

    await vi.waitFor(() => expect(vi.mocked(flushOpencodeTurn)).toHaveBeenCalledTimes(1));
    expect(received.map((event) => event.event)).not.toContain('stop');
  });
});

describe('the backfill on connect', () => {
  it('runs before any frame is delivered', async () => {
    const order: string[] = [];
    vi.mocked(backfillOpencodeHistory).mockImplementation(async () => {
      order.push('backfill');
      return 0;
    });
    vi.mocked(recordOpencodeTranscriptFrame).mockImplementation(() => {
      order.push('frame');
    });
    vi.mocked(getRememberedOpencodeSession).mockReturnValue({
      sessionId: SESSION,
      title: null,
      worktreePath: null,
      updatedAt: 1,
    } as unknown as ReturnType<typeof getRememberedOpencodeSession>);

    queued.push(streamOf(ASSISTANT_MESSAGE));
    await subscribe();

    await vi.waitFor(() => expect(order).toContain('frame'));
    expect(order[0]).toBe('backfill');
  });

  it('uses the session #2038 persisted, which is what survives a restart', async () => {
    vi.mocked(getRememberedOpencodeSession).mockReturnValue({
      sessionId: 'ses_remembered',
      title: null,
      worktreePath: null,
      updatedAt: 1,
    } as unknown as ReturnType<typeof getRememberedOpencodeSession>);

    await subscribe();

    await vi.waitFor(() =>
      expect(vi.mocked(backfillOpencodeHistory)).toHaveBeenCalledWith(TARGET, PORT, 'ses_remembered')
    );
  });

  it('does nothing when no session can be named', async () => {
    // `GET /session/status` answers `{}` for a server whose turns have all
    // finished (measured), so a fresh CommandMate with nothing persisted has no
    // session to ask about — and must not guess one.
    await subscribe();
    await vi.waitFor(() => expect(vi.mocked(openOpencodeEventStream)).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(vi.mocked(backfillOpencodeHistory)).not.toHaveBeenCalled();
  });

  it('does not take the connection down when it throws', async () => {
    vi.mocked(getRememberedOpencodeSession).mockReturnValue({
      sessionId: SESSION,
      title: null,
      worktreePath: null,
      updatedAt: 1,
    } as unknown as ReturnType<typeof getRememberedOpencodeSession>);
    vi.mocked(backfillOpencodeHistory).mockRejectedValue(new Error('boom'));

    queued.push(streamOf(ASSISTANT_MESSAGE));
    await subscribe();

    await vi.waitFor(() =>
      expect(vi.mocked(recordOpencodeTranscriptFrame)).toHaveBeenCalledTimes(1)
    );
  });
});

describe('isOpencodeStructuredHistoryLive', () => {
  it('is true while the stream is up', async () => {
    await subscribe();
    await vi.waitFor(() => expect(isOpencodeStructuredHistoryLive(TARGET)).toBe(true));
  });

  it('is false for an instance with no subscription at all', () => {
    expect(isOpencodeStructuredHistoryLive({ worktreeId: 'wt-none', cliToolId: 'opencode' })).toBe(
      false
    );
  });

  it('is false once the subscription is closed, so the scraper takes over again', async () => {
    await subscribe();
    await vi.waitFor(() => expect(isOpencodeStructuredHistoryLive(TARGET)).toBe(true));

    await closeOpencodeSubscription(TARGET);

    expect(isOpencodeStructuredHistoryLive(TARGET)).toBe(false);
    // And the half-written turn goes with it — a process that is gone will not
    // finish the reply it was in the middle of.
    expect(vi.mocked(forgetOpencodeTranscripts)).toHaveBeenCalledWith(TARGET);
  });
});
