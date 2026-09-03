/**
 * opencode dates a reply at the end of its turn too (Issue #2273).
 *
 * The other four readers are pinned in `./turn-timestamp-2273.test.ts` against
 * their own transcript files. opencode has none: the turn is accumulated off the
 * SSE stream and closed by `session.idle`, and the only other route is the REST
 * document a reconnect backfills from. So the same rule has two shapes here and
 * both are asserted, because a rule that lands on one of five structurally
 * identical readers is a rule that will be re-reported against the other four.
 *
 *  - **Live.** `session.idle` IS opencode's end-of-turn frame, so the instant it
 *    is handled is the instant the turn ended.
 *  - **Backfill.** `info.time.completed` is the same fact recorded in the
 *    document, folded with `Math.max` over a turn's assistant messages — the
 *    tool-calling turn of the captured session produced two.
 *
 * Both were `turn.startedAt` before this Issue, which put a reply BEFORE the
 * tool approvals written while the agent was producing it. The fixtures are the
 * live 1.18.22 capture `./opencode-transcript-2041.test.ts` renders from.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rows = new Map<string, Record<string, unknown>>();
const createMessage = vi.fn((_db: unknown, message: Record<string, unknown>) => {
  const saved = { id: `msg-${rows.size + 1}`, ...message };
  rows.set(String(message.requestId), saved);
  return saved;
});
const findMessageByRequestId = vi.fn(
  (_db: unknown, _worktreeId: string, requestId: string) => rows.get(requestId) ?? null
);

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  updateWorktreeTimestamp: vi.fn(),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>()),
  fetchOpencodeSessionMessages: vi.fn(),
}));

import { fetchOpencodeSessionMessages } from '@/lib/hooks/sources/opencode/client';
import {
  backfillOpencodeHistory,
  flushOpencodeTurn,
  recordOpencodeTranscriptFrame,
  resetOpencodeTranscripts,
} from '@/lib/hooks/sources/opencode/history';
import { opencodeTurnRequestId } from '@/types/agent-transcript';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

interface Frame {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

const FRAMES: Frame[] = JSON.parse(
  readFileSync(join(FIXTURES, 'history-turns-1-18-22.json'), 'utf-8')
) as Frame[];
const MESSAGES: Record<string, unknown>[] = JSON.parse(
  readFileSync(join(FIXTURES, 'session-messages-1-18-22.json'), 'utf-8')
) as Record<string, unknown>[];

const SESSION = 'ses_0000000000000000000000000';
const PORT = 4881;
const TARGET = { worktreeId: 'wt-2273-oc', cliToolId: 'opencode', instanceId: 'opencode' } as const;

/** The captured session's three turns, oldest first. */
const TURNS = [
  'msg_user0000000000000000001',
  'msg_user0000000000000000002',
  'msg_user0000000000000000003',
] as const;

/** `info.time.completed` of each turn's LAST assistant message, from the capture. */
const COMPLETED_AT: Record<string, number> = {
  msg_user0000000000000000001: 1_787_648_522_109,
  // Two assistant messages; the later one is the turn's end.
  msg_user0000000000000000002: 1_787_648_592_819,
  msg_user0000000000000000003: 1_787_648_679_754,
};

/** When the stream's first frame was received, in the capture's own clock. */
const STREAM_OPENED_AT = 1_787_648_517_229;

function writtenAt(userMessageId: string): number {
  const requestId = opencodeTurnRequestId(userMessageId);
  const call = createMessage.mock.calls.find(([, message]) => message.requestId === requestId);
  if (!call) throw new Error(`no row written for ${requestId}`);
  return (call[1].timestamp as Date).getTime();
}

/** Feed the captured stream in up to and including the Nth `session.idle`. */
async function playFirstTurn(closedAt: number): Promise<void> {
  for (const frame of FRAMES) {
    recordOpencodeTranscriptFrame(
      TARGET,
      frame as unknown as Record<string, unknown>,
      STREAM_OPENED_AT
    );
    if (frame.type === 'session.idle') {
      await flushOpencodeTurn(TARGET, frame.properties.sessionID as string, closedAt);
      return;
    }
  }
  throw new Error('the capture has no session.idle');
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  resetOpencodeTranscripts();
});

afterEach(() => {
  resetOpencodeTranscripts();
});

describe('the live flush', () => {
  it('dates the reply when session.idle arrived, not when the turn opened', async () => {
    const closedAt = STREAM_OPENED_AT + 4_880;
    await playFirstTurn(closedAt);

    expect(writtenAt(TURNS[0])).toBe(closedAt);
    // Non-vacuity: the rule this replaced would have written the turn's start,
    // so the assertion above genuinely discriminates between the two.
    expect(writtenAt(TURNS[0])).not.toBe(STREAM_OPENED_AT);
  });

  it('puts the reply after an approval raised inside the turn', async () => {
    // The dialog is written when it appears, seconds into the turn, and the chat
    // surface orders its rows by timestamp alone.
    const approvalAt = STREAM_OPENED_AT + 2_000;
    await playFirstTurn(STREAM_OPENED_AT + 4_880);

    expect(writtenAt(TURNS[0])).toBeGreaterThan(approvalAt);
  });

  it('never dates the reply before the turn opened', async () => {
    // A clock that went backwards — an NTP step between the first frame and the
    // idle — must not be able to put a reply above its own prompt.
    await playFirstTurn(STREAM_OPENED_AT - 60_000);

    expect(writtenAt(TURNS[0])).toBe(STREAM_OPENED_AT);
  });
});

describe('the backfill', () => {
  beforeEach(() => {
    vi.mocked(fetchOpencodeSessionMessages).mockResolvedValue(MESSAGES);
  });

  it('dates every turn at its last assistant message’s completion', async () => {
    expect(await backfillOpencodeHistory(TARGET, PORT, SESSION)).toBe(3);

    for (const userMessageId of TURNS) {
      expect(writtenAt(userMessageId), userMessageId).toBe(COMPLETED_AT[userMessageId]);
    }
  });

  it('keeps the three turns in conversation order', async () => {
    await backfillOpencodeHistory(TARGET, PORT, SESSION);

    const written = TURNS.map((userMessageId) => writtenAt(userMessageId));
    expect([...written].sort((a, b) => a - b)).toEqual(written);
  });

  it('leaves each reply after the prompt that opened its turn', async () => {
    // `time.created` on the turn's own user message is when opencode accepted the
    // prompt; the reply has to sort after it and, for turn 2, after the SECOND
    // assistant message rather than the first.
    await backfillOpencodeHistory(TARGET, PORT, SESSION);

    for (const entry of MESSAGES) {
      const info = entry.info as Record<string, unknown>;
      if (info.role !== 'user') continue;
      const created = (info.time as Record<string, number>).created;
      expect(writtenAt(info.id as string)).toBeGreaterThan(created);
    }
    // The first assistant message of turn 2 finished at 1787648591148; the row
    // is dated by the second one, which is what "the turn's end" means.
    expect(writtenAt(TURNS[1])).toBeGreaterThan(1_787_648_591_148);
  });
});
