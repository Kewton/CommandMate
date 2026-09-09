/**
 * A saved turn is not a delivered turn (Issue #2443).
 *
 * `captureStructuredHistoryTurn` has announced the relay's completion edge since
 * #2377, on the single condition that the reader wrote something. For claude,
 * codex and command-code that is sound: each writes a record that closes a turn,
 * so a row implies a finished reply. antigravity writes none, and #2438 measured
 * what follows — an interim narration is saved under the key the conclusion will
 * land on. The announcement made from it hands a relay that body as the answer
 * to the question it asked, and `message_updated` does not take a delivered
 * message back.
 *
 * So this file drives the **real** gate over the **real** antigravity reader and
 * a real transcript on disk, with the delivery boundary
 * (`relay/relay-triggers`) and the push fan-out (`lib/push`) stubbed and
 * counted. The three readers that are not the subject are stubbed too, both to
 * keep their module graphs out and to pin the compatibility half: a reader that
 * reports no completion is announced exactly as it was before this Issue.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The delivery boundary, stubbed. Nothing below reaches a real relay or agent. */
const onRelayTurnCompleted = vi.fn();
vi.mock('@/lib/relay/relay-triggers', () => ({
  onRelayTurnCompleted: (...args: unknown[]) => onRelayTurnCompleted(...args),
}));

/** The push fan-out, stubbed. See the `push` describe below for what it proves. */
const notifyPushSubscribers = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/lib/push', () => ({
  notifyPushSubscribers: (...args: unknown[]) => notifyPushSubscribers(...args),
}));

vi.mock('@/lib/hooks/sources/opencode/subscription', () => ({
  isOpencodeStructuredHistoryLive: vi.fn(() => false),
}));
vi.mock('@/lib/hooks/sources/claude/history', () => ({
  captureClaudeTranscriptTurn: vi.fn(async () => true),
  resolveClaudeTranscriptPath: vi.fn(async () => '/transcripts/claude.jsonl'),
}));
vi.mock('@/lib/hooks/sources/codex/history', () => ({
  captureCodexTranscriptTurn: vi.fn(async () => false),
  resolveCodexTranscriptPath: vi.fn(async () => null),
}));
vi.mock('@/lib/hooks/sources/command-code/history', () => ({
  captureCommandCodeTranscriptTurn: vi.fn(async () => false),
  resolveCommandCodeTranscriptPath: vi.fn(async () => null),
}));

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
const getLastStopEventAt = vi.fn<(...a: unknown[]) => number | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
  getLastStopEventAt: (...a: unknown[]) => getLastStopEventAt(...a),
}));

/** A stand-in for `chat_messages`, keyed the way the real table's index is. */
const rows = new Map<string, Record<string, unknown>>();
const createMessage = vi.fn((_db: unknown, message: Record<string, unknown>) => {
  const saved = { id: `msg-${rows.size + 1}`, archived: false, ...message };
  rows.set(`${String(message.worktreeId)}::${String(message.requestId)}`, saved);
  return saved;
});
const findMessageByRequestId = vi.fn((_db: unknown, worktreeId: string, requestId: string) =>
  rows.get(`${worktreeId}::${requestId}`) ?? null
);
const updateMessageContent = vi.fn((_db: unknown, messageId: string, content: string) => {
  for (const row of rows.values()) {
    if (row.id === messageId) {
      row.content = content;
      return;
    }
  }
});

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  updateMessageContent: (...a: [unknown, string, string]) => updateMessageContent(...a),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: () => [],
  setMessageRequestId: () => true,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import { captureClaudeTranscriptTurn } from '@/lib/hooks/sources/claude/history';
import {
  antigravityTranscriptPath,
  resetAntigravityTranscriptConversations,
} from '@/lib/hooks/sources/antigravity/history';
import {
  captureStructuredHistoryTurn,
  resetStructuredHistoryCaptureQueue,
  type StructuredHistoryCaptureReport,
} from '@/lib/polling/structured-history-gate';
import { antigravityTurnRequestId } from '@/types/agent-transcript';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/antigravity-turn-completion-2443');
const WORKTREE_ID = 'wt-2443-gate';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CONCLUDED_LAST_RECORD_MS = Date.parse('2026-09-09T00:04:42Z');
/** What the poller hands every reader; claude is the one that needs the path. */
const CLAUDE_CAPTURE = { worktreePath: '/repos/wt-2443-gate', transcriptPathHint: null } as const;

let interim: string;
let resumed: string;
let concluded: string;
let home: string;

async function writeTranscript(body: string): Promise<void> {
  const path = antigravityTranscriptPath(home, CONVERSATION);
  if (!path) throw new Error('not a conversation id');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, 'utf8');
}

/** One trip through the gate, as the poller and the Stop receiver both make it. */
async function captureAgy(): Promise<{
  captured: boolean;
  report: StructuredHistoryCaptureReport;
}> {
  const report: StructuredHistoryCaptureReport = {};
  const captured = await captureStructuredHistoryTurn(
    WORKTREE_ID,
    'antigravity',
    'antigravity',
    { ...CLAUDE_CAPTURE, antigravityHome: home },
    report
  );
  return { captured, report };
}

function agyRow(): Record<string, unknown> | undefined {
  return rows.get(`${WORKTREE_ID}::${antigravityTurnRequestId(CONVERSATION, 0)}`);
}

/** Announcements that told a relay the turn was over. */
function announcements(): unknown[][] {
  return onRelayTurnCompleted.mock.calls.filter((call) => call[3] === true);
}

beforeAll(async () => {
  interim = await readFile(join(FIXTURE_DIR, 'interim.jsonl'), 'utf8');
  resumed = await readFile(join(FIXTURE_DIR, 'resumed.jsonl'), 'utf8');
  concluded = await readFile(join(FIXTURE_DIR, 'concluded.jsonl'), 'utf8');
});

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  resetStructuredHistoryCaptureQueue();
  resetAntigravityTranscriptConversations();
  vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(true);
  home = await mkdtemp(join(tmpdir(), 'cmate-2443-gate-'));
  getLastAgentEvent.mockReturnValue({ sessionId: CONVERSATION });
  getLastStopEventAt.mockReturnValue(null);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('an interim body is saved and delivered to nobody', () => {
  it('writes the row and announces nothing', async () => {
    await writeTranscript(interim);

    const { captured, report } = await captureAgy();

    // The scraper still stands down — that is #2436's and #2437's contract and
    // #2443 does not touch it. What changes is that no relay is told.
    expect(captured).toBe(true);
    expect(agyRow()?.content).toContain('INTERIM_NARRATION');
    expect(report.completion).toBe('provisional');
    expect(report.completionReason).toBe('no-stop-event');
    expect(onRelayTurnCompleted).not.toHaveBeenCalled();
  });

  it('announces nothing while agy is back at work', async () => {
    await writeTranscript(interim);
    await captureAgy();
    await writeTranscript(resumed);

    const { report } = await captureAgy();

    expect(report.completion).toBe('provisional');
    expect(report.completionReason).toBe('turn-open');
    expect(onRelayTurnCompleted).not.toHaveBeenCalled();
  });

  it('announces nothing for a stop that belongs to an earlier state of the turn', async () => {
    // The stale stop: hook working, event received, and it predates the record
    // this body ends on. A gate that read "a stop exists" would deliver here.
    await writeTranscript(concluded);
    getLastStopEventAt.mockReturnValue(Date.parse('2026-09-09T00:00:05Z'));

    const { captured, report } = await captureAgy();

    expect(captured).toBe(true);
    expect(report.completion).toBe('provisional');
    expect(onRelayTurnCompleted).not.toHaveBeenCalled();
  });
});

describe('the settled turn is delivered once', () => {
  it('announces the completion when the conclusion and the stop are both in', async () => {
    await writeTranscript(interim);
    await captureAgy();
    await writeTranscript(concluded);
    getLastStopEventAt.mockReturnValue(CONCLUDED_LAST_RECORD_MS + 400);

    const { captured, report } = await captureAgy();

    expect(captured).toBe(true);
    expect(report.completion).toBe('settled');
    expect(announcements()).toHaveLength(1);
    expect(onRelayTurnCompleted).toHaveBeenCalledWith(
      WORKTREE_ID,
      'antigravity',
      'antigravity',
      true
    );
    // What a relay would pick up is the row, and the row is the conclusion.
    expect(agyRow()?.content).toContain('ZARQUON-742');
  });

  it('does not announce again when the next poll reads the same finished turn', async () => {
    await writeTranscript(concluded);
    getLastStopEventAt.mockReturnValue(CONCLUDED_LAST_RECORD_MS + 400);

    await captureAgy();
    await captureAgy();
    await captureAgy();

    expect(announcements()).toHaveLength(1);
  });

  it('announces again when the turn grew and agy vouched for the new body', async () => {
    // Not a re-delivery of the same body: the transcript has a record the first
    // announcement was not about, and a stop that covers it.
    await writeTranscript(concluded);
    getLastStopEventAt.mockReturnValue(CONCLUDED_LAST_RECORD_MS + 400);
    await captureAgy();

    const laterMs = CONCLUDED_LAST_RECORD_MS + 30_000;
    await writeTranscript(
      `${concluded.trimEnd()}\n${JSON.stringify({
        step_index: 7,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(laterMs).toISOString(),
        content: 'A correction: ZARQUON-743.',
      })}\n`
    );
    getLastStopEventAt.mockReturnValue(laterMs + 400);
    await captureAgy();

    expect(announcements()).toHaveLength(2);
    expect(agyRow()?.content).toContain('ZARQUON-743');
  });

  it('announces nothing at all when the capture wrote nothing', async () => {
    // The newest turn is open and has no row: the scraper owns this turn, and
    // the poller makes its own unsettled announcement for it.
    await writeTranscript(resumed);
    getLastStopEventAt.mockReturnValue(Date.now());

    const { captured, report } = await captureAgy();

    expect(captured).toBe(false);
    expect(report.outcome).toBe('not_yet_closed');
    expect(onRelayTurnCompleted).not.toHaveBeenCalled();
  });
});

describe('the three readers that close their own turns are unchanged', () => {
  it('announces for a reader that reports no completion at all', async () => {
    // The pre-#2443 contract, and the compatibility this Issue must not break:
    // absent means settled. claude, codex and command-code each write a record
    // that closes a turn, so a row from them IS a finished reply.
    await captureStructuredHistoryTurn(WORKTREE_ID, 'claude', 'claude', CLAUDE_CAPTURE);

    expect(onRelayTurnCompleted).toHaveBeenCalledWith(WORKTREE_ID, 'claude', 'claude', true);
  });

  it('announces on every capture for such a reader, as it always did', async () => {
    // No key, no dedup: a reader that cannot name the body it settled with is
    // announced exactly as often as it was before. Pinned so the dedup cannot
    // quietly become universal.
    await captureStructuredHistoryTurn(WORKTREE_ID, 'claude', 'claude', CLAUDE_CAPTURE);
    await captureStructuredHistoryTurn(WORKTREE_ID, 'claude', 'claude', CLAUDE_CAPTURE);

    expect(announcements()).toHaveLength(2);
  });

  it('still announces nothing when such a reader answers false', async () => {
    vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(false);

    await captureStructuredHistoryTurn(WORKTREE_ID, 'claude', 'claude', CLAUDE_CAPTURE);

    expect(onRelayTurnCompleted).not.toHaveBeenCalled();
  });
});

describe('the push fan-out is not a second delivery path', () => {
  it('is never reached from a capture, provisional or settled', async () => {
    // The completion push has one producer, `polling/response-checker`'s
    // `notifyPushSubscribers({ kind: 'completion' })`, and it fires on the
    // poller's own running → idle judgement rather than on anything a reader
    // writes. This is the guard that keeps it that way: a capture must not grow
    // a second notification path, least of all one an interim body could reach.
    await writeTranscript(interim);
    await captureAgy();

    await writeTranscript(concluded);
    getLastStopEventAt.mockReturnValue(CONCLUDED_LAST_RECORD_MS + 400);
    await captureAgy();

    expect(notifyPushSubscribers).not.toHaveBeenCalled();
  });
});
