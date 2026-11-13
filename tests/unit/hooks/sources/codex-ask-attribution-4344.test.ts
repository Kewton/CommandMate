/**
 * codex's ask attribution adapter — the §6 PR2 controls (Issue #4344, design
 * `docs/design/ask-attribution-4344.md`, prereview F1〜F6 and T01〜T20).
 *
 * Driven through the reader's public entrance (`captureCodexTranscriptTurn`,
 * what the poller, the Stop receiver and the read API call), the read API's
 * function (`readAskAttribution`) and its route (`GET /api/asks/:askId`), on a
 * rollout written into a `mkdtemp` `$CODEX_HOME`. The ledger rows are reserved
 * the way the send route reserves them.
 *
 * This file is the capability control the guard
 * `tests/unit/guards/ask-capability-controls-4344.test.ts` holds codex's
 * `ASK_ATTRIBUTION_TOOLS` entry to: every M1〜M6 case below is named.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

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
import { createMessage, deleteMessageById, getMessages, upsertWorktree } from '@/lib/db';
import {
  captureCodexTranscriptTurn,
  codexSessionsRoot,
  resetCodexTranscriptSessions,
} from '@/lib/hooks/sources/codex/history';
import { MAX_CODEX_TURN_BODY_LENGTH, MAX_CODEX_TURN_ITEMS } from '@/lib/hooks/sources/codex/transcript';
import { readAskAttribution, askBodyDigest } from '@/lib/ask/ask-correlation';
import { formatAskEnvelope } from '@/lib/ask/envelope';
import { getAskCorrelation, recordAskSendOutcome, reserveAsk } from '@/lib/db/ask-correlation-db';
import { settleAskSend } from '@/lib/ask/ask-send';
import { GET as getAsk } from '@/app/api/asks/[askId]/route';
import { codexPromptRequestId, codexTurnRequestId } from '@/types/agent-transcript';
import type { Worktree } from '@/types/models';

const WT = 'wt-4344-codex';
const SESSION = '01a1d600-0000-7000-8000-000000004344';
const OTHER_SESSION = '01a1d600-0000-7000-8000-00000000c1ea';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRIEF = '<<<cmate-brief:0123abcd\nnotice\nstate\ncmate-brief:0123abcd>>>';
const T0 = Date.parse('2026-11-14T04:00:00.000Z');

/** The real Q3 record (0.167.2): see the fixture's README. */
const Q3_DIR = join(process.cwd(), 'tests/fixtures/codex-ask-attribution-4344');
const Q3_SESSION = '01a1d56d-69a6-7fd3-a2b9-35e6836ec3fb';
const Q3_ASK = '43440003-0000-4000-8000-000000004344';
const Q3_ITEM = '01a1d57a-a8d7-71c0-b1c3-df6910f9786e';
const Q3_TURN = '01a1d57a-a6a2-7f73-a189-c155e69093bc';

let db: Database.Database;
let codexHome: string;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (v: Database.Database | null) => void };
  module.setMockDb(value);
}

function rolloutPath(session = SESSION): string {
  return join(codexSessionsRoot(codexHome), '2026', '11', '14', `rollout-2026-11-14T13-00-00-${session}.jsonl`);
}

/** The rollout of `session`, where codex would have put it. */
async function writeRollout(records: readonly object[] | string, session = SESSION): Promise<void> {
  await mkdir(join(codexSessionsRoot(codexHome), '2026', '11', '14'), { recursive: true });
  const text = typeof records === 'string' ? records : records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(rolloutPath(session), text, 'utf8');
}

async function appendRollout(records: readonly object[] | string, session = SESSION): Promise<void> {
  const text = typeof records === 'string' ? records : records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  await appendFile(rolloutPath(session), text, 'utf8');
}

const capture = (instanceId = 'codex'): Promise<boolean> =>
  captureCodexTranscriptTurn({ worktreeId: WT, cliToolId: 'codex', instanceId }, { codexHome });

const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const env = (askId: string, body: string): string => `${formatAskEnvelope(askId)}\n${body}`;

function meta(session = SESSION): object {
  return { timestamp: iso(-10_000), type: 'session_meta', payload: { session_id: session, id: session, cli_version: '0.167.2' } };
}
function started(turn: string, at = 0): object {
  return { timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started', turn_id: turn } };
}
/** A `UserMessage`; `session` null leaves the record without a `thread_id`. */
function user(turn: string, id: string | null, text: string | null, at = 10, session: string | null = SESSION): object {
  const item: Record<string, unknown> = { type: 'UserMessage', content: text === null ? [] : [{ type: 'text', text }] };
  if (id !== null) item.id = id;
  const payload: Record<string, unknown> = { type: 'item_completed', turn_id: turn, item };
  if (session !== null) payload.thread_id = session;
  return { timestamp: iso(at), type: 'event_msg', payload };
}
/** The model-facing copy codex writes beside the item (never read). */
function responseUser(turn: string, text: string, at = 10): object {
  return {
    timestamp: iso(at), type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turn } },
  };
}
function agent(turn: string, text: string, at = 1_000, session: string | null = SESSION, phase = 'final_answer'): object {
  const payload: Record<string, unknown> = {
    type: 'item_completed', turn_id: turn,
    item: { type: 'AgentMessage', id: `msg_${turn}_${at}`, content: [{ type: 'Text', text }], phase },
  };
  if (session !== null) payload.thread_id = session;
  return { timestamp: iso(at), type: 'event_msg', payload };
}
function exec(turn: string, n: number, at = 500): object {
  return {
    timestamp: iso(at), type: 'event_msg',
    payload: { type: 'item_completed', thread_id: SESSION, turn_id: turn, item: { type: 'CommandExecution', id: `exec_${n}`, command: ['/bin/zsh', '-lc', `echo ${n}`] } },
  };
}
/** `task_complete`: a `turn_id` and no session, as codex writes it (Q1). */
function complete(turn: string, at = 2_000): object {
  return { timestamp: iso(at), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: null } };
}
function aborted(turn: string, at = 2_000): object {
  return { timestamp: iso(at), type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' } };
}

/** One whole turn of the followed session: started, the input, the reply, the close. */
function turnOf(turn: string, id: string, text: string, reply: string, at = 0): object[] {
  return [started(turn, at), user(turn, id, text, at + 10), agent(turn, reply, at + 1_000), complete(turn, at + 2_000)];
}

/** What the send route leaves behind for a sent ask: the reservation, the outcome, the `/send` user row. */
function sentAsk(
  askId: string,
  body: string,
  options: { turnOpenAtSend?: boolean | null; at?: number; outcome?: 'sent' | 'not_sent'; instanceId?: string; cliToolId?: string } = {},
): void {
  reserveOnly(askId, body, options);
  const turnOpenAtSend = 'turnOpenAtSend' in options ? options.turnOpenAtSend : false;
  settleAskSend(db, askId, options.outcome === 'not_sent'
    ? { sendState: 'not_sent' }
    : { sendState: 'sent', sentMessageId: null, turnOpenAtSend });
}

/** The reservation and the /send row only: the send route has not saved the outcome yet. */
function reserveOnly(askId: string, body: string, options: { at?: number; instanceId?: string; cliToolId?: string } = {}): void {
  reserveAsk(db, {
    askId, worktreeId: WT, instanceId: options.instanceId ?? 'codex', cliToolId: options.cliToolId ?? 'codex',
    bodyDigest: askBodyDigest(body),
  });
  createMessage(db, {
    worktreeId: WT, role: 'user', content: body, messageType: 'normal',
    timestamp: new Date(T0 + (options.at ?? 0)), cliToolId: 'codex', instanceId: 'codex',
  });
}

const read = (askId: string) => readAskAttribution(db, askId);
const rowsOf = (role: string) => getMessages(db, WT, { limit: 500 }).filter((m) => m.role === role);

beforeEach(async () => {
  vi.clearAllMocks();
  resetCodexTranscriptSessions();
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
  codexHome = await mkdtemp(join(tmpdir(), 'cmate-4344-codex-'));
  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);
  const worktree: Worktree = { id: WT, name: 'wt', path: join(codexHome, 'wt'), repositoryPath: '/repos', repositoryName: 'CommandMate' };
  upsertWorktree(db, worktree);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetCodexTranscriptSessions();
  await setMockDb(null);
  db.close();
  await rm(codexHome, { recursive: true, force: true });
});

describe('Q3: the real record of an enveloped 9 KB paste (codex 0.167.2)', () => {
  it('settles matched with exactly `ok`; History keeps one user row without the envelope', async () => {
    const text = await readFile(join(Q3_DIR, 'q3-enveloped-paste-01672.jsonl'), 'utf8');
    const sentText = (JSON.parse(text.split('\n')[5]) as { payload: { item: { content: { text: string }[] } } }).payload.item.content[0].text;
    const body = sentText.slice(sentText.indexOf('\n') + 1);
    getLastAgentEvent.mockReturnValue({ sessionId: Q3_SESSION });
    reserveAsk(db, { askId: Q3_ASK, worktreeId: WT, instanceId: 'codex', cliToolId: 'codex', bodyDigest: askBodyDigest(body) });
    createMessage(db, {
      worktreeId: WT, role: 'user', content: body, messageType: 'normal',
      timestamp: new Date('2026-11-13T15:15:47.900Z'), cliToolId: 'codex', instanceId: 'codex',
    });
    settleAskSend(db, Q3_ASK, { sendState: 'sent', sentMessageId: null, turnOpenAtSend: false });
    await writeRollout(text, Q3_SESSION);
    expect(await capture()).toBe(true);
    expect(await read(Q3_ASK)).toMatchObject({ state: 'matched', reply: 'ok', nativeInputSeen: true });
    expect(getAskCorrelation(db, Q3_ASK)).toMatchObject({ nativeInputId: Q3_ITEM, nativeSessionId: Q3_SESSION, nativeTurnKey: codexTurnRequestId(Q3_TURN) });
    const users = rowsOf('user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ content: body, requestId: codexPromptRequestId(Q3_ITEM) });
    expect(users[0].content).not.toContain('[cmate-ask');
    expect(users[0].content.endsWith('END-OF-PROBE-4344-Q3')).toBe(true);
  });
});

describe('PR2 (2): a single turn comes back whole', () => {
  it('ask `hi` answered `hi` is matched with exactly `hi`', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi', notified: false });
  });

  it('a 305-line reply comes back in full', async () => {
    const long = Array.from({ length: 305 }, (_, i) => `line ${i + 1}`).join('\n');
    sentAsk(A, 'write 305 lines');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'write 305 lines'), long)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: long });
  });

  it('an older turn with no envelope is never this ask\'s', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t0', 'u0', 'history', 'history', -60_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: false });
  });
});

describe('PR2 (1) M1: a turn that took another input', () => {
  it('M1 two asks in one turn: both ambiguous/shared_turn, reply null', async () => {
    sentAsk(A, 'first');
    sentAsk(B, 'second', { at: 500 });
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'first'), 10), user('t1', 'u2', env(B, 'second'), 500), agent('t1', 'both'), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'shared_turn', reply: null });
    expect(await read(B)).toMatchObject({ state: 'ambiguous', reason: 'shared_turn', reply: null });
  });

  it('M1 an ask and a hand-typed input with the same text (another item id): ambiguous/shared_turn', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi'), 10), user('t1', 'u2', 'hi', 500), agent('t1', 'hi'), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'shared_turn', reply: null });
  });

  it.each([
    ['with no id', user('t1', null, 'typed', 500)],
    ['with no text', user('t1', 'u2', null, 500)],
  ])('M1 an ask beside another UserMessage %s is not a single input (reply null)', async (_label, other) => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi'), 10), other, agent('t1', 'hi'), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ reply: null });
    expect((await read(A))?.state).not.toBe('matched');
  });

  it('M1 the same identity again after another input: never settles from its id (pending)', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi'), 10), user('t1', 'u2', 'other', 400), user('t1', 'u1', env(A, 'hi'), 500), agent('t1', 'hi'), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null });
  });

  it('Q2: an aborted turn (turn_aborted) is not a close — the ask stays pending, not turn_interrupted', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi')), agent('t1', 'partial', 500, SESSION, 'commentary'), aborted('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: true });
  });
});

describe('PR2 (3) M2・M3: the envelope and History\'s adoption', () => {
  it('M2 the /send row is adopted: one user row, no envelope in it', async () => {
    sentAsk(A, 'hello there');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hello there'), 'hi')]);
    await capture();
    const users = rowsOf('user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ content: 'hello there', requestId: codexPromptRequestId('u1') });
  });

  it('M2 a body that itself opens with another valid envelope keeps it (taken off once)', async () => {
    const body = env(B, 'quoted envelope first');
    sentAsk(A, body);
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, body), 'ok')]);
    await capture();
    const users = rowsOf('user');
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe(body);
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'ok' });
    expect(getAskCorrelation(db, B)).toBeNull();
  });

  it.each([
    ['no brief, one line', '', 'hi'],
    ['no brief, multi-line', '', 'line 1\nline 2\nline 3'],
    ['brief, one line', `${BRIEF}\n\n`, 'hi'],
    ['brief, multi-line', `${BRIEF}\n\n`, 'line 1\nline 2'],
  ])('M3 %s: the envelope is found after the brief and the row keeps the brief', async (_label, brief, body) => {
    sentAsk(A, body);
    await writeRollout([meta(), ...turnOf('t1', 'u1', `${brief}${env(A, body)}`, 'done')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'done' });
    const users = rowsOf('user');
    expect(users.map((row) => row.content)).not.toContainEqual(expect.stringContaining('[cmate-ask'));
  });

  it.each([
    ['no reservation at all', null],
    ['a reservation of another instance', { cliToolId: 'codex', instanceId: 'codex-2' }],
    ['a reservation of another tool', { cliToolId: 'claude', instanceId: 'claude' }],
  ])('M2 negative (I3): an envelope with %s stays in the History row', async (_label, reservation) => {
    if (reservation) {
      reserveAsk(db, { askId: A, worktreeId: WT, instanceId: reservation.instanceId, cliToolId: reservation.cliToolId, bodyDigest: askBodyDigest('hi') });
    }
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture();
    expect(rowsOf('user').map((row) => row.content)).toEqual([env(A, 'hi')]);
    if (reservation) expect(getAskCorrelation(db, A)).toMatchObject({ attributionState: 'pending', nativeInputId: null });
  });

  it('M2 negative control: turns with no envelope write the same rows as before and touch no ledger row', async () => {
    await writeRollout([meta(), ...turnOf('t0', 'u0', 'plain', 'answer', -5_000), ...turnOf('t1', 'u1', 'second', '## Result', 0)]);
    expect(await capture()).toBe(true);
    expect(rowsOf('user').map((row) => [row.requestId, row.content])).toEqual([[codexPromptRequestId('u1'), 'second']]);
    expect(rowsOf('assistant').map((row) => [row.requestId, row.content])).toEqual([[codexTurnRequestId('t1'), '## Result']]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ask_correlations').get() as { n: number }).n).toBe(0);
  });
});

describe('PR2 (3) M5: the generation is the session of each record (F1)', () => {
  it('M5 the first ask after a restart is matched (nothing in memory is needed)', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    resetCodexTranscriptSessions();
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi' });
  });

  it.each([
    ['another session', OTHER_SESSION],
    ['no session', null],
  ])('M5 an enveloped input of %s inside a turn the followed session opened is not recorded (pending)', async (_label, session) => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), agent('t1', 'warming up', 5, SESSION, 'commentary'), user('t1', 'u1', env(A, 'hi'), 10, session), agent('t1', 'hi'), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: false });
  });

  it('M5 a turn whose first record names another session does not reject the ask\'s own input — and takes no close from that window', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), agent('t1', 'stale', 5, OTHER_SESSION, 'commentary'), user('t1', 'u1', env(A, 'hi'), 10), agent('t1', 'hi'), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: true });
    expect(getAskCorrelation(db, A)).toMatchObject({ nativeInputId: 'u1', nativeSessionId: SESSION });
  });

  it('M5 a foreign-session assistant record after the input (Q1: a window of two sessions): no close, no reply', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi')), agent('t1', 'not yours', 1_000, OTHER_SESSION), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: true });
  });

  it('M5 an assistant record that names no session: no close (I6)', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi')), agent('t1', 'hi', 1_000, null), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null });
  });

  it('M5 no session pointer: nothing is read or recorded', async () => {
    sentAsk(A, 'hi');
    getLastAgentEvent.mockReturnValue(null);
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    expect(await capture()).toBe(false);
    expect(await read(A)).toMatchObject({ state: 'pending', nativeInputSeen: false });
  });

  it('M5 a sighting under another instance is rejected and leaves the row pending', async () => {
    sentAsk(A, 'hi', { instanceId: 'codex-2' });
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture('codex');
    expect(await read(A)).toMatchObject({ state: 'pending', nativeInputSeen: false });
  });

  it('M5 the rollout of the session before /new: its input is rejected; the new session\'s single turn settles', async () => {
    sentAsk(A, 'old');
    sentAsk(B, 'new', { at: 5_000 });
    await writeRollout([meta(OTHER_SESSION), started('t0'), user('t0', 'u0', env(A, 'old'), 10, OTHER_SESSION), agent('t0', 'old reply', 1_000, OTHER_SESSION), complete('t0')], OTHER_SESSION);
    getLastAgentEvent.mockReturnValue({ sessionId: OTHER_SESSION });
    // The pointer moved on before the read: the old file is not the followed session's.
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(B, 'new'), 'new reply', 5_000)]);
    getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
    resetCodexTranscriptSessions();
    await capture();
    expect(await read(B)).toMatchObject({ state: 'matched', reply: 'new reply' });
    expect(await read(A)).toMatchObject({ state: 'pending', nativeInputSeen: false });
  });
});

describe('PR2 (3) M6: terminal states, idempotency, duplicates', () => {
  it('M6 reading the same input twice changes nothing', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture();
    const first = getAskCorrelation(db, A);
    await capture();
    expect(getAskCorrelation(db, A)).toEqual(first);
    expect(rowsOf('user')).toHaveLength(1);
    expect(rowsOf('assistant')).toHaveLength(1);
  });

  it('M6 the same UserMessage written twice, with its response_item copy, is one input: matched, one row each', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi')), responseUser('t1', env(A, 'hi')), user('t1', 'u1', env(A, 'hi'), 20), agent('t1', 'hi'), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi' });
    expect(rowsOf('user')).toHaveLength(1);
    expect(rowsOf('assistant')).toHaveLength(1);
  });

  it('M6 two inputs of one envelope read at once while reserved: carried, then envelope_duplicated — never matched', async () => {
    reserveOnly(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi'), ...turnOf('t2', 'u2', env(A, 'hi'), 'hi again', 5_000)]);
    await capture();
    expect(getAskCorrelation(db, A)).toMatchObject({ attributionState: 'pending', duplicateSeen: true });
    settleAskSend(db, A, { sendState: 'sent', turnOpenAtSend: false });
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'envelope_duplicated', reply: null });
  });

  it('M6 two inputs of one envelope read at once after the send is saved: envelope_duplicated, the first turn is not matched first', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi'), ...turnOf('t2', 'u2', env(A, 'hi'), 'hi again', 5_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'envelope_duplicated', reply: null });
  });

  it('M6 matched, then another input of the envelope in the same session: unchanged (I1)', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture();
    await appendRollout(turnOf('t2', 'u2', env(A, 'hi'), 'again', 5_000));
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi' });
  });

  it('M6 a reply row deleted from History reads unmatched/history_missing; the ledger stays matched', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture();
    deleteMessageById(db, rowsOf('assistant')[0].id);
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'history_missing', reply: null });
    expect(getAskCorrelation(db, A)?.attributionState).toBe('matched');
  });

  it('M6 a matched reply whose History row later changes reads unmatched/history_changed', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture();
    db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run('hi, edited', rowsOf('assistant')[0].id);
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'history_changed', reply: null });
  });

  it('M6 an envelope seen after not_sent leaves unmatched/not_sent (H2)', async () => {
    sentAsk(A, 'hi', { outcome: 'not_sent' });
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'not_sent', reply: null });
  });
});

describe('R3・H1: a turn open at the send is never matched', () => {
  it.each([[true], [null]])('turnOpenAtSend=%s → ambiguous/turn_open_at_send', async (open) => {
    sentAsk(A, 'hi', { turnOpenAtSend: open });
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'turn_open_at_send', reply: null });
  });
});

describe('F3: attribution does not hang on History\'s selection or early return', () => {
  it('reserved → capture writes History → outcome saved → the same rollout read again: pending, then matched, no new rows', async () => {
    reserveOnly(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture();
    expect(getAskCorrelation(db, A)).toMatchObject({ attributionState: 'pending', nativeInputId: 'u1' });
    recordAskSendOutcome(db, A, { sendState: 'sent', turnOpenAtSend: false });
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi' });
    expect(rowsOf('user')).toHaveLength(1);
    expect(rowsOf('assistant')).toHaveLength(1);
  });

  it('an older ask turn with its row, behind a newer plain turn: settles on its own row, never on the newer reply', async () => {
    sentAsk(A, 'hi');
    createMessage(db, {
      worktreeId: WT, role: 'assistant', content: 'old answer', messageType: 'normal',
      timestamp: new Date(T0 + 2_000), cliToolId: 'codex', instanceId: 'codex', requestId: codexTurnRequestId('t1'),
    });
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'old answer'), ...turnOf('t2', 'u2', 'later', 'newer answer', 10_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'old answer' });
  });

  it('an older ask turn with no row, no anchor, and a newer plain turn: pending (the newer reply is not taken)', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'old answer'), ...turnOf('t2', 'u2', 'later', 'newer answer', 10_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: true });
  });
});

describe('F4: closed is not complete', () => {
  it('a window with the input and the close but no task_started (headless): pending; the headless History row is still written', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), user('t1', 'u1', env(A, 'hi')), agent('t1', 'hi'), complete('t1')]);
    expect(await capture()).toBe(true);
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: true });
    expect(rowsOf('assistant')[0].content.startsWith('_(head truncated)_')).toBe(true);
  });

  it('an overflowed turn (items dropped, final answer lost) settles unmatched/body_truncated', async () => {
    sentAsk(A, 'hi');
    const execs = Array.from({ length: MAX_CODEX_TURN_ITEMS + 2 }, (_, n) => exec('t1', n));
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi')), ...execs, agent('t1', 'final'), complete('t1', 5_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'body_truncated', reply: null });
  });

  it('a body over the length bound settles unmatched/body_truncated', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'x'.repeat(MAX_CODEX_TURN_BODY_LENGTH + 10))]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'body_truncated', reply: null });
  });

  it('an unparseable line inside the turn: pending', async () => {
    sentAsk(A, 'hi');
    const lines = [meta(), started('t1'), user('t1', 'u1', env(A, 'hi'))].map((r) => JSON.stringify(r));
    lines.push('{"timestamp": "broken');
    lines.push(...[agent('t1', 'hi'), complete('t1')].map((r) => JSON.stringify(r)));
    await writeRollout(lines.join('\n') + '\n');
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null });
  });

  it('negative: a fragment after the close (a file being appended to) costs the turn nothing', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await appendRollout('{"timestamp": "2026-11-14T04:00:09');
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi' });
  });
});

describe('I5: the Stop order — the hook comes before task_complete', () => {
  it('the first read (no task_complete yet) is pending; after the close is appended the same input settles', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi')), agent('t1', 'hi')]);
    expect(await capture()).toBe(false);
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: true });
    await appendRollout([complete('t1')]);
    expect(await capture()).toBe(true);
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi' });
    expect(rowsOf('assistant')).toHaveLength(1);
  });

  it('a final answer with no task_complete, and a next turn arriving, is still no close', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi')), agent('t1', 'hi'), ...turnOf('t2', 'u2', 'next', 'next answer', 5_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null });
  });
});

describe('F5: GET /api/asks/:askId reads the codex rollout by itself (Q1 of the design, §3.5)', () => {
  const get = (askId: string) =>
    getAsk(new Request(`http://localhost/api/asks/${askId}`) as unknown as NextRequest, { params: Promise.resolve({ askId }) }) as unknown as Promise<Response>;

  it('a pending codex ask settles through the route alone, with no poller reading', async () => {
    vi.stubEnv('CODEX_HOME', codexHome);
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    const response = await get(A);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ askId: A, state: 'matched', reply: 'hi' });
  });

  it('the route and the poller reading one snapshot at once: one user row, one reply, matched once', async () => {
    vi.stubEnv('CODEX_HOME', codexHome);
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    const [, response] = await Promise.all([capture(), get(A)]);
    expect(await response.json()).toMatchObject({ state: 'matched', reply: 'hi' });
    expect(rowsOf('user')).toHaveLength(1);
    expect(rowsOf('assistant')).toHaveLength(1);
    expect(getAskCorrelation(db, A)).toMatchObject({ attributionState: 'matched', nativeInputId: 'u1' });
  });
});

/**
 * Re-instruction 1 (consistency review of d19c5c8, P2 ×3): the session read at
 * the start must still be the followed one when the ledger is written; every
 * session-bearing record of the window counts (the response_item stream too);
 * an input with no id is its own in each turn.
 */
describe('re-instruction 1: the session at the write, the whole window, id-less inputs', () => {
  it('M5 /new during the read (pointer S → T before the ledger is written): the old turn is not matched and no input is recorded', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    let calls = 0;
    getLastAgentEvent.mockImplementation(() => ({ sessionId: (calls += 1) === 1 ? SESSION : OTHER_SESSION }));
    await capture();
    expect(calls).toBeGreaterThan(1);
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: false });
    expect(getAskCorrelation(db, A)).toMatchObject({ nativeInputId: null, nativeSessionId: null });
  });

  it('negative: no change of session during the read → matched as before', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), ...turnOf('t1', 'u1', env(A, 'hi'), 'hi')]);
    await capture();
    expect(getLastAgentEvent.mock.calls.length).toBeGreaterThan(1);
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi' });
  });

  it('M5 a response_item naming another session (Q1: a window of two sessions): the sessionless task_complete is no close', async () => {
    sentAsk(A, 'hi');
    const foreign = { timestamp: iso(500), type: 'response_item', payload: { type: 'message', role: 'assistant', thread_id: OTHER_SESSION, content: [{ type: 'output_text', text: 'x' }] } };
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi')), foreign, agent('t1', 'hi'), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: true });
    // History's double-stream exclusion is unchanged: one reply row, the response_item not rendered.
    expect(rowsOf('assistant').map((row) => [row.requestId, row.content])).toEqual([[codexTurnRequestId('t1'), 'hi']]);
  });

  it('negative: response_items naming the followed session (or none) keep the window whole → matched', async () => {
    sentAsk(A, 'hi');
    const own = { timestamp: iso(500), type: 'response_item', payload: { type: 'message', role: 'assistant', thread_id: SESSION, content: [{ type: 'output_text', text: 'hi' }] } };
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi')), responseUser('t1', env(A, 'hi')), own, agent('t1', 'hi'), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi' });
  });

  it('M1 an ask with an id-less input in turn 1, and another id-less input in turn 2: turn 1 is ambiguous/shared_turn', async () => {
    sentAsk(A, 'hi');
    await writeRollout([
      meta(),
      started('t1'), user('t1', 'u1', env(A, 'hi'), 10), user('t1', null, 'typed', 500), agent('t1', 'hi'), complete('t1'),
      started('t2', 5_000), user('t2', null, 'typed again', 5_010), agent('t2', 'later', 6_000), complete('t2', 7_000),
    ]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'shared_turn', reply: null });
  });

  it('negative: an id-less input in one turn only → ambiguous/shared_turn as before', async () => {
    sentAsk(A, 'hi');
    await writeRollout([meta(), started('t1'), user('t1', 'u1', env(A, 'hi'), 10), user('t1', null, 'typed', 500), agent('t1', 'hi'), complete('t1')]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'shared_turn', reply: null });
  });
});
