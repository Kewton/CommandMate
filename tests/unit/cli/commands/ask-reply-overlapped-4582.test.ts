/**
 * Issue #4582 stage 1: the red reproduction of `ask --json` giving
 * `reply: null`・`unmatched/grace_expired`・`"overlapped": true` for a claude
 * reviewer that had finished its answer (S11, B1 #4558 5-2b, three times).
 *
 * The shape is the real one: Claude Code (2.1.330) records CommandMate's tmux
 * send of a multi-line body as a paste, and the prompt record's text is
 * `"\n\n<pasted_content id=\"X\">\n[cmate-ask v1 <askId>]\n<body>\n</pasted_content id=\"X\">\n"`
 * — two newlines OUTSIDE the wrapper (the same shape the #3102 fixture
 * `tests/fixtures/claude-transcript-3102/pasted-user-record.jsonl` keeps). The
 * #4344 controls use a paste with nothing outside it, so they never saw this.
 *
 * Root cause (stage 1, `src` unchanged):
 * - `src/lib/hooks/sources/claude/transcript.ts` `createClaudeTurn` takes the paste
 *   wrapper off (`claudePastedContentPrompt`) but leaves the leading `"\n\n"`;
 * - `src/lib/ask/envelope.ts` `stripAskEnvelope` reads the envelope only on the
 *   first line (no brief): the first line is empty, so it answers null;
 * - so the turn has no `askId`: the ledger row is never bound (stays `pending`,
 *   `nativeInputSeen: false`) and the CLI's grace ends in `unmatched/grace_expired`;
 * - and the turn's prompt text keeps the envelope, so it does not equal the
 *   `/send` row: History gets a second `user` row
 *   (`"\n\n[cmate-ask v1 …]\n<body>"`, `claude-prompt:<uuid>`) on the same
 *   instance inside the ask's window, which `hasForeignPromptInWindow`
 *   (`src/cli/utils/reply-ledger.ts`) reads as another sender's message:
 *   `overlapped: true` is a misjudgment, not a real overlap.
 *
 * The `it.fails` cases are the red ones: #4582 段 2 で it に戻す. The other
 * cases are controls that are green today and must stay green after the fix.
 *
 * Fake Claude Code only: a transcript written into a `mkdtemp` home, an
 * in-memory database. No tmux, no server, no real agent.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (value: Database.Database | null) => {
      mockDb = value;
    },
  };
});

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';
import { askBodyDigest, readAskAttribution } from '@/lib/ask/ask-correlation';
import { formatAskEnvelope } from '@/lib/ask/envelope';
import { reserveAsk } from '@/lib/db/ask-correlation-db';
import { settleAskSend } from '@/lib/ask/ask-send';
import { hasForeignPromptInWindow } from '@/cli/utils/reply-ledger';
import type { PromptMessageResponse } from '@/cli/types/api-responses';
import type { Worktree } from '@/types/models';

const WT = 'wt-4582';
const INSTANCE = 'claude-6';
const SESSION = '00000000-0000-4000-8000-000000004582';
const A = 'd103efe5-35a8-4954-9266-0997619538a4';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T0 = Date.parse('2026-11-23T07:05:27.318Z');
const BODY = '【依頼】Issue #4558 の修正をレビューしてください（読むだけ）\n\n■ 出力の形\n最後に `DONE:` で始まる1行で結論を要約してください。';
const REVIEW = '**整合性レビュー #4558**\n\n(1) 変更の要点\n1. G1\n\nDONE: 指摘 5 件（すべて P3）';

let db: Database.Database;
let home: string;
let worktreePath: string;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (v: Database.Database | null) => void };
  module.setMockDb(value);
}

async function writeTranscript(records: readonly object[]): Promise<void> {
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(worktreePath)), { recursive: true });
  const text = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(claudeTranscriptPath(home, worktreePath, SESSION), text, 'utf8');
}

const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/** The paste as Claude Code 2.1.330 recorded it in S11 (`e33e624b…jsonl`, the ask's prompt record). */
const realPaste = (text: string): string => `\n\n<pasted_content id="355c">\n${text}\n</pasted_content id="355c">\n`;
/** The paste the #4344 controls use: nothing outside the wrapper. */
const barePaste = (text: string): string => `<pasted_content id="1">\n${text}\n</pasted_content id="1">`;

function prompt(uuid: string, text: string, at: number): object {
  return {
    type: 'user', isSidechain: false, uuid, timestamp: iso(at), promptSource: 'typed', origin: { kind: 'human' },
    version: '2.1.330', cwd: worktreePath, message: { role: 'user', content: text }, sessionId: SESSION,
  };
}
function reply(uuid: string, text: string, at: number): object {
  return {
    type: 'assistant', isSidechain: false, uuid, timestamp: iso(at), version: '2.1.330', cwd: worktreePath,
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }, sessionId: SESSION,
  };
}

/** A `/send` user row on the instance (what the send route writes for every message). */
function sendRow(content: string, at: number): void {
  createMessage(db, {
    worktreeId: WT, role: 'user', content, messageType: 'normal',
    timestamp: new Date(T0 + at), cliToolId: 'claude', instanceId: INSTANCE,
  });
}

/** What the send route leaves for a sent ask: the reservation, the outcome (turnOpenAtSend=false, as S11's rows), the `/send` row. */
function sentAsk(askId: string, body: string, at = 0): void {
  reserveAsk(db, { askId, worktreeId: WT, instanceId: INSTANCE, cliToolId: 'claude', bodyDigest: askBodyDigest(body) });
  sendRow(body, at);
  settleAskSend(db, askId, { sendState: 'sent', sentMessageId: null, turnOpenAtSend: false });
}

const capture = (): Promise<boolean> =>
  captureClaudeTranscriptTurn({ worktreeId: WT, cliToolId: 'claude', instanceId: INSTANCE }, { worktreePath, homeDir: home });

/** History's rows the way `GET /api/worktrees/:id/messages` serializes them for the CLI. */
function ledgerRows(): PromptMessageResponse[] {
  return getMessages(db, WT, { limit: 200 }).map((m) => ({
    id: m.id,
    worktreeId: m.worktreeId,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp.toISOString(),
    messageType: m.messageType,
    cliToolId: m.cliToolId,
    instanceId: m.instanceId,
    requestId: m.requestId,
  }) as PromptMessageResponse);
}

/** `ask`'s foreign-message side of the overlap check (`detectOverlap`), over this ask's window. */
const overlapped = (body: string, since = T0, until = T0 + 600_000): boolean =>
  hasForeignPromptInWindow(ledgerRows(), body, since, until, INSTANCE);

/** A fresh session (S11 attempt 3, claude-6): one greeting turn before the ask. */
const freshSession = (): object[] => [
  prompt('p0', 'こんにちは。この後、整合性レビューの依頼を 1 本送ります。今は何もしないで待ってください', -40_000),
  reply('r0', '了解しました。\n\nWAIT: 依頼を待っています', -35_000),
];
/** A session with earlier relayed requests answered (S11 attempts 1・2, claude-5). */
const busySession = (): object[] => [
  prompt('p-1', 'PM の依頼: pm-dispatch-a.md 全文を読み、その依頼に従ってください', -900_000),
  reply('r-1', 'DONE: 結果 → enabler-return-a.md', -800_000),
  prompt('p-2', 'PM の依頼: pm-dispatch-b.md 全文を読み、その依頼に従ってください', -600_000),
  reply('r-2', 'DONE: 結果 → enabler-return-b.md', -500_000),
];

beforeEach(async () => {
  vi.clearAllMocks();
  resetClaudeTranscriptSessions();
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
  home = await mkdtemp(join(tmpdir(), 'cmate-4582-'));
  worktreePath = join(home, 'wt');
  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);
  const worktree: Worktree = { id: WT, name: 'wt', path: worktreePath, repositoryPath: '/repos', repositoryName: 'CommandMate' };
  upsertWorktree(db, worktree);
});

afterEach(async () => {
  resetClaudeTranscriptSessions();
  await setMockDb(null);
  db.close();
  await rm(home, { recursive: true, force: true });
});

describe('#4582 red: a finished reply recorded as Claude Code records a paste is tied to the ask', () => {
  // #4582 段 2 で it に戻す
  it.fails('fresh session (claude-6 shape): matched, the reply is the review', async () => {
    sentAsk(A, BODY);
    await writeTranscript([...freshSession(), prompt('p1', realPaste(`${formatAskEnvelope(A)}\n${BODY}`), 200), reply('r1', REVIEW, 358_000)]);
    await capture();
    expect(await readAskAttribution(db, A)).toMatchObject({ state: 'matched', reply: REVIEW });
  });

  // #4582 段 2 で it に戻す
  it.fails('session with earlier relayed turns (claude-5 shape): matched, the reply is the review', async () => {
    sentAsk(A, BODY);
    await writeTranscript([...busySession(), prompt('p1', realPaste(`${formatAskEnvelope(A)}\n${BODY}`), 200), reply('r1', REVIEW, 150_000)]);
    await capture();
    expect(await readAskAttribution(db, A)).toMatchObject({ state: 'matched', reply: REVIEW });
  });

  // #4582 段 2 で it に戻す
  it.fails('no second user row: the /send row is adopted, so `ask` does not report overlapped', async () => {
    sentAsk(A, BODY);
    await writeTranscript([...freshSession(), prompt('p1', realPaste(`${formatAskEnvelope(A)}\n${BODY}`), 200), reply('r1', REVIEW, 358_000)]);
    await capture();
    expect(getMessages(db, WT, { limit: 200 }).filter((m) => m.role === 'user' && m.timestamp.getTime() >= T0)).toHaveLength(1);
    expect(overlapped(BODY)).toBe(false);
  });
});

describe('#4582 what today does with that shape (pins the cause; green before the fix)', () => {
  it('the ask stays pending with no native input seen (the CLI reads unmatched/grace_expired)', async () => {
    sentAsk(A, BODY);
    await writeTranscript([...freshSession(), prompt('p1', realPaste(`${formatAskEnvelope(A)}\n${BODY}`), 200), reply('r1', REVIEW, 358_000)]);
    await capture();
    expect(await readAskAttribution(db, A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: false });
    // The reader's own row keeps the envelope behind the two newlines (S11's History rows, len 4850 vs 4795).
    const extra = getMessages(db, WT, { limit: 200 }).find((m) => m.requestId === 'claude-prompt:p1');
    expect(extra?.content.startsWith(`\n\n${formatAskEnvelope(A)}\n`)).toBe(true);
    expect(overlapped(BODY)).toBe(true);
  });

  it('control: the same turn without the two newlines outside the paste is matched and not overlapped', async () => {
    sentAsk(A, BODY);
    await writeTranscript([...freshSession(), prompt('p1', barePaste(`${formatAskEnvelope(A)}\n${BODY}`), 200), reply('r1', REVIEW, 358_000)]);
    await capture();
    expect(await readAskAttribution(db, A)).toMatchObject({ state: 'matched', reply: REVIEW });
    expect(overlapped(BODY)).toBe(false);
  });
});

describe('#4582 negative control: another ask\'s answer is never this ask\'s reply', () => {
  it('only another ask\'s turn is in the transcript: A gets no reply, and never B\'s', async () => {
    sentAsk(A, BODY);
    sentAsk(B, 'another question', 100);
    await writeTranscript([...freshSession(), prompt('p1', barePaste(`${formatAskEnvelope(B)}\nanother question`), 200), reply('r1', 'the answer to B', 5_000)]);
    await capture();
    const a = await readAskAttribution(db, A);
    expect(a?.state).not.toBe('matched');
    expect(a?.reply).toBeNull();
    expect(await readAskAttribution(db, B)).toMatchObject({ state: 'matched', reply: 'the answer to B' });
  });

  it('a turn with no envelope after the send (the previous request\'s answer) is never this ask\'s', async () => {
    sentAsk(A, BODY);
    await writeTranscript([...busySession(), prompt('p1', realPaste('PM の依頼: 別の依頼'), 100), reply('r1', 'DONE: 別の依頼の答え', 5_000)]);
    await capture();
    expect(await readAskAttribution(db, A)).toMatchObject({ reply: null });
  });
});

describe('#4582 control: a real overlap is still reported', () => {
  it('another sender\'s message reaches the instance during the ask\'s turn: overlapped', async () => {
    sentAsk(A, BODY);
    sendRow('[from claude-8] 割り込みの一言', 30_000);
    await writeTranscript([...freshSession(), prompt('p1', barePaste(`${formatAskEnvelope(A)}\n${BODY}`), 200), reply('r1', REVIEW, 358_000)]);
    await capture();
    expect(overlapped(BODY)).toBe(true);
  });

  it('a message sent after the turn ended is not an overlap', async () => {
    sentAsk(A, BODY);
    await writeTranscript([...freshSession(), prompt('p1', barePaste(`${formatAskEnvelope(A)}\n${BODY}`), 200), reply('r1', REVIEW, 358_000)]);
    await capture();
    sendRow('[from claude-8] 次の依頼', 400_000);
    expect(overlapped(BODY, T0, T0 + 360_000)).toBe(false);
  });
});
