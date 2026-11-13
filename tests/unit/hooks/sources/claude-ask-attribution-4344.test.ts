/**
 * claude's ask attribution adapter — the §6 PR1 controls (Issue #4344, design
 * `docs/design/ask-attribution-4344.md`).
 *
 * Driven through the reader's public entrance (`captureClaudeTranscriptTurn`,
 * what the poller calls when a turn ends) and the read API's function
 * (`readAskAttribution`), on a transcript written into a `mkdtemp` home. The
 * ledger rows are reserved the way the send route reserves them.
 *
 * This file is the capability control the guard
 * `tests/unit/guards/ask-capability-controls-4344.test.ts` holds claude's
 * `ASK_ATTRIBUTION_TOOLS` entry to: every M1〜M6 case below is named.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
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
import { createMessage, deleteMessageById, getMessages, upsertWorktree } from '@/lib/db';
import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';
import { refreshClaudeAsk } from '@/lib/hooks/sources/claude/ask-refresh';
import { readAskAttribution, askBodyDigest } from '@/lib/ask/ask-correlation';
import { formatAskEnvelope } from '@/lib/ask/envelope';
import { getAskCorrelation, recordAskSendOutcome, reserveAsk } from '@/lib/db/ask-correlation-db';
import { settleAskSend } from '@/lib/ask/ask-send';
import { ASK_RESERVED_STALE_MS, bindAskSighting } from '@/lib/ask/ask-correlation';
import { claudeTranscriptPath as transcriptPathOf } from '@/lib/hooks/sources/claude/history';
import type { Worktree } from '@/types/models';

const WT = 'wt-4344';
const SESSION = '00000000-0000-4000-8000-000000004344';
const OTHER_SESSION = '00000000-0000-4000-8000-00000000c1ea';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIXTURES = join(process.cwd(), 'tests/fixtures/claude-ask-attribution-4344');
const BRIEF = '<<<cmate-brief:0123abcd\nnotice\nstate\ncmate-brief:0123abcd>>>';
const T0 = Date.parse('2026-11-13T04:00:00.000Z');

let db: Database.Database;
let home: string;
let worktreePath: string;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (v: Database.Database | null) => void };
  module.setMockDb(value);
}

/** The transcript of `session`, as Claude would leave it under the home. */
async function writeTranscript(records: readonly object[] | string, session = SESSION): Promise<void> {
  const path = claudeTranscriptPath(home, worktreePath, session);
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(worktreePath)), { recursive: true });
  const text = typeof records === 'string' ? records : records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(path, text.replaceAll('<CWD>', worktreePath), 'utf8');
}

const capture = (): Promise<boolean> =>
  captureClaudeTranscriptTurn({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }, { worktreePath, homeDir: home });

const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const paste = (body: string): string => `<pasted_content id="1">\n${body}\n</pasted_content id="1">`;

function prompt(uuid: string, text: string, at: number, session = SESSION): object {
  return {
    type: 'user', isSidechain: false, uuid, timestamp: iso(at), promptSource: 'typed', origin: { kind: 'human' },
    cwd: '<CWD>', message: { role: 'user', content: text }, sessionId: session,
  };
}
function reply(uuid: string, text: string, at: number, session = SESSION): object {
  return {
    type: 'assistant', isSidechain: false, uuid, timestamp: iso(at), cwd: '<CWD>',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }, sessionId: session,
  };
}
function toolUse(uuid: string, at: number, session = SESSION): object {
  return {
    type: 'assistant', isSidechain: false, uuid, timestamp: iso(at), cwd: '<CWD>',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${uuid}`, name: 'Bash', input: {} }], stop_reason: 'tool_use' },
    sessionId: session,
  };
}

/** What the send route leaves behind for a sent ask: the reservation, the outcome, the `/send` user row. */
function sentAsk(
  askId: string,
  body: string,
  options: { turnOpenAtSend?: boolean | null; at?: number; outcome?: 'sent' | 'not_sent'; instanceId?: string } = {},
): void {
  reserveOnly(askId, body, { at: options.at, instanceId: options.instanceId });
  const turnOpenAtSend = 'turnOpenAtSend' in options ? options.turnOpenAtSend : false;
  // Through the route's own settlement (carried evidence is judged there).
  settleAskSend(db, askId, options.outcome === 'not_sent'
    ? { sendState: 'not_sent' }
    : { sendState: 'sent', sentMessageId: null, turnOpenAtSend });
}

/** The reservation and the /send row only: the send route has not saved the outcome yet. */
function reserveOnly(askId: string, body: string, options: { at?: number; instanceId?: string; now?: number } = {}): void {
  reserveAsk(db, {
    askId, worktreeId: WT, instanceId: options.instanceId ?? 'claude', cliToolId: 'claude', bodyDigest: askBodyDigest(body),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  createMessage(db, {
    worktreeId: WT, role: 'user', content: body, messageType: 'normal',
    timestamp: new Date(T0 + (options.at ?? 0)), cliToolId: 'claude', instanceId: 'claude',
  });
}

const read = (askId: string) => readAskAttribution(db, askId);
const userRows = () => getMessages(db, WT, { limit: 200 }).filter((m) => m.role === 'user');

beforeEach(async () => {
  vi.clearAllMocks();
  resetClaudeTranscriptSessions();
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
  home = await mkdtemp(join(tmpdir(), 'cmate-4344-'));
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

describe('(1) the reply is the enveloped turn\'s whole body, wherever it would be on a screen', () => {
  it('a 305-line reply comes back in full (the pane read kept the last 80 lines)', async () => {
    const long = Array.from({ length: 305 }, (_, i) => `line ${i + 1}`).join('\n');
    sentAsk(A, 'write 305 lines');
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nwrite 305 lines`), 0), reply('r1', long, 1000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: long, notified: false });
  });
});

describe('(2) same text as the ask, and no correspondence', () => {
  it('ask `hi` answered `hi` is matched with exactly `hi`', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nhi`), 0), reply('r1', 'hi', 1000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi' });
  });

  it('an older reply with no envelope in front of it is never this ask\'s', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p0', 'history', -60_000), reply('r0', 'history', -59_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: false });
  });
});

describe('(3) the previous turn ended after the send, this one did not', () => {
  it('stays pending (turn_incomplete for the CLI) and never takes the previous turn', async () => {
    sentAsk(A, 'second');
    await writeTranscript([
      prompt('p0', 'first', -5_000),
      reply('r0', 'first answer', 500),
      prompt('p1', paste(`${formatAskEnvelope(A)}\nsecond`), 1_000),
      toolUse('t1', 2_000),
    ]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', reply: null, nativeInputSeen: true });
  });
});

describe('(4) M1: inputs absorbed into the running turn', () => {
  it('M1 an absorbed ask: A is ambiguous/shared_turn and B unmatched/absorbed_mid_turn', async () => {
    sentAsk(A, 'review the plan');
    sentAsk(B, 'second question', { at: 1_500 });
    await writeTranscript(await readFile(join(FIXTURES, 'absorbed-ask.jsonl'), 'utf8'));
    await capture();
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'shared_turn', reply: null });
    expect(await read(B)).toMatchObject({ state: 'unmatched', reason: 'absorbed_mid_turn', reply: null });
  });

  it('M1 a background-task notice only: matched with notified (§7 (a) ②)', async () => {
    sentAsk(A, 'review the plan');
    await writeTranscript(await readFile(join(FIXTURES, 'absorbed-notice.jsonl'), 'utf8'));
    await capture();
    const answer = await read(A);
    expect(answer).toMatchObject({ state: 'matched', notified: true });
    // The row History holds for the turn (its prose, and the tool call drawn under it).
    expect(answer?.reply?.startsWith('The plan is fine.')).toBe(true);
  });
});

describe('(5) M2: the envelope and History\'s adoption', () => {
  it('M2 the /send row is adopted: one user row, no envelope in it', async () => {
    sentAsk(A, 'review the plan');
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nreview the plan`), 0), reply('r1', 'ok', 1000)]);
    await capture();
    const rows = userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('review the plan');
    expect(rows[0].requestId).toBe('claude-prompt:p1');
    expect(getAskCorrelation(db, A)?.sentMessageId).toBeNull();
  });

  it('M2 negative control: a prompt with no envelope is adopted as before and touches no ledger row', async () => {
    createMessage(db, { worktreeId: WT, role: 'user', content: 'plain', messageType: 'normal', timestamp: new Date(T0), cliToolId: 'claude', instanceId: 'claude' });
    await writeTranscript([prompt('p1', 'plain', 0), reply('r1', 'ok', 1000)]);
    await capture();
    expect(userRows()).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ask_correlations').get() as { n: number }).n).toBe(0);
  });
});

describe('(6) M3: brief with / without × multi-line / one-line', () => {
  it.each([
    ['M3 no brief, one line', '', 'hi there'],
    ['M3 no brief, multi-line', '', 'line one\nline two'],
    ['M3 brief, one line', `${BRIEF}\n\n`, 'hi there'],
    ['M3 brief, multi-line', `${BRIEF}\n\n`, 'line one\nline two'],
  ])('%s', async (_name, brief, body) => {
    sentAsk(A, body);
    await writeTranscript([prompt('p1', paste(`${brief}${formatAskEnvelope(A)}\n${body}`), 0), reply('r1', 'done', 1000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'done' });
    const rows = userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(body);
  });
});

describe('(8) M5: the generation is the session the reader saw', () => {
  it('M5 the first ask after a restart is matched (nothing in memory is needed)', async () => {
    sentAsk(A, 'hi');
    resetClaudeTranscriptSessions();
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nhi`), 0), reply('r1', 'after restart', 1000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'after restart' });
  });

  it('M5 a record of the session before /clear is rejected', async () => {
    sentAsk(A, 'hi');
    getLastAgentEvent.mockReturnValue({ sessionId: OTHER_SESSION });
    // The file the instance follows now holds a record stamped with the old session.
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nhi`), 0, SESSION), reply('r1', 'old', 1000, SESSION)], OTHER_SESSION);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', nativeInputSeen: false });
  });
});

describe('(9) M6: terminal states and idempotency', () => {
  it('M6 reading the same input twice changes nothing', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nhi`), 0), reply('r1', 'hi', 1000)]);
    await capture();
    const first = getAskCorrelation(db, A);
    await capture();
    expect(getAskCorrelation(db, A)).toEqual(first);
  });

  it('M6 the same envelope seen again in another session after matched (resume / fork) leaves it as it was', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nhi`), 0), reply('r1', 'the answer', 1000)]);
    await capture();
    getLastAgentEvent.mockReturnValue({ sessionId: OTHER_SESSION });
    resetClaudeTranscriptSessions();
    await writeTranscript(
      [prompt('p9', paste(`${formatAskEnvelope(A)}\nhi`), 5_000, OTHER_SESSION), reply('r9', 'another', 6_000, OTHER_SESSION)],
      OTHER_SESSION,
    );
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'the answer' });
    expect(getAskCorrelation(db, A)?.nativeInputId).toBe('p1');
  });

  it('M6 a reply row deleted from History reads unmatched/history_missing; the ledger stays matched', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nhi`), 0), reply('r1', 'hi', 1000)]);
    await capture();
    const [id] = getAskCorrelation(db, A)!.assistantMessageIds;
    deleteMessageById(db, id);
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'history_missing', reply: null });
    expect(getAskCorrelation(db, A)?.attributionState).toBe('matched');
  });
});

describe('(11) R3: a turn open at the send is never matched', () => {
  it('turnOpenAtSend=true → ambiguous/turn_open_at_send', async () => {
    sentAsk(A, 'hi', { turnOpenAtSend: true });
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nhi`), 0), reply('r1', 'hi', 1000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'turn_open_at_send', reply: null });
  });
});

describe('(12) Q1: settled by the read API alone, with no poller reading', () => {
  it('a pending ask is refreshed once from the transcript and comes back matched', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nhi`), 0), reply('r1', 'read on demand', 1000)]);
    // No capture(): the poller is not running.
    const answer = await readAskAttribution(db, A, (row) => refreshClaudeAsk(db, row, { homeDir: home }));
    expect(answer).toMatchObject({ state: 'matched', reply: 'read on demand' });
  });
});

describe('re-instruction 2 (review P2): never terminal before the send\'s observations are saved', () => {
  /** The reservation alone: the send route has not saved its outcome yet. */
  function reservedOnly(askId: string, body: string): void {
    reserveAsk(db, { askId, worktreeId: WT, instanceId: 'claude', cliToolId: 'claude', bodyDigest: askBodyDigest(body) });
    createMessage(db, {
      worktreeId: WT, role: 'user', content: body, messageType: 'normal',
      timestamp: new Date(T0), cliToolId: 'claude', instanceId: 'claude',
    });
  }

  it('a complete turn read before the outcome is saved stays pending; turnOpenAtSend=true saved later → ambiguous', async () => {
    reservedOnly(A, 'hi');
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nhi`), 0), reply('r1', 'hi', 1000)]);
    await capture();
    expect(getAskCorrelation(db, A)).toMatchObject({ attributionState: 'pending', nativeInputId: 'p1' });
    recordAskSendOutcome(db, A, { sendState: 'sent', turnOpenAtSend: true });
    await capture();
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'turn_open_at_send', reply: null });
  });

  it('read after the outcome is saved: matched as before', async () => {
    reservedOnly(A, 'hi');
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\nhi`), 0), reply('r1', 'hi', 1000)]);
    recordAskSendOutcome(db, A, { sendState: 'sent', turnOpenAtSend: false });
    await capture();
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'hi' });
  });

  it('an absorbed ask whose send is not saved yet is not settled either', async () => {
    sentAsk(A, 'review the plan');
    reservedOnly(B, 'second question');
    await writeTranscript(await readFile(join(FIXTURES, 'absorbed-ask.jsonl'), 'utf8'));
    await capture();
    expect(getAskCorrelation(db, B)?.attributionState).toBe('pending');
  });
});

describe('re-instruction 2 (review P2): the envelope comes off once', () => {
  it('M2 a body that itself opens with another valid envelope keeps it: one History row, the body as sent', async () => {
    const body = `${formatAskEnvelope(B)}\nquoted envelope first`;
    sentAsk(A, body);
    await writeTranscript([prompt('p1', paste(`${formatAskEnvelope(A)}\n${body}`), 0), reply('r1', 'ok', 1000)]);
    await capture();
    const rows = userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(body);
    expect(rows[0].requestId).toBe('claude-prompt:p1');
    expect(await read(A)).toMatchObject({ state: 'matched' });
    expect(getAskCorrelation(db, B)).toBeNull();
  });
});

/**
 * The state table (design §3.6.3), cell by cell. The ✗ cells are red on
 * 32b91fa (the version before the rebuild); the ○ cells pin what it already held.
 */
describe('§3.6 state table: the cells', () => {
  const env = (askId: string, body: string) => paste(`${formatAskEnvelope(askId)}\n${body}`);

  it('cell 4 (I8): a second input of the envelope while reserved is carried — after the outcome it is envelope_duplicated, never matched', async () => {
    reserveOnly(A, 'hi');
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), toolUse('t1', 500), prompt('p2', env(A, 'hi'), 1_000), reply('r2', 'hi', 2_000)]);
    await capture();
    expect(getAskCorrelation(db, A)).toMatchObject({ attributionState: 'pending', duplicateSeen: true });
    settleAskSend(db, A, { sendState: 'sent', turnOpenAtSend: false });
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'envelope_duplicated', reply: null });
  });

  it('cell 5 (I8): an absorbed ask seen while reserved is settled absorbed after the outcome is saved', async () => {
    sentAsk(A, 'review the plan');
    reserveOnly(B, 'second question', { at: 1_500 });
    await writeTranscript(await readFile(join(FIXTURES, 'absorbed-ask.jsonl'), 'utf8'));
    await capture();
    expect(getAskCorrelation(db, B)).toMatchObject({ attributionState: 'pending', absorbedSeen: true });
    settleAskSend(db, B, { sendState: 'sent', turnOpenAtSend: false });
    expect(await read(B)).toMatchObject({ state: 'unmatched', reason: 'absorbed_mid_turn' });
  });

  it('cell 5 / M5 (I6): an absorbed envelope in a stale session never settles the pending row', async () => {
    sentAsk(B, 'second question', { at: 1_500 });
    getLastAgentEvent.mockReturnValue({ sessionId: OTHER_SESSION });
    // The file the instance follows now holds the absorption, stamped with the old session.
    await writeTranscript(await readFile(join(FIXTURES, 'absorbed-ask.jsonl'), 'utf8'), OTHER_SESSION);
    await capture();
    expect(getAskCorrelation(db, B)?.attributionState).toBe('pending');
  });

  it('cell 7 (I7): M5 a sighting under another instance is rejected and leaves the row pending', async () => {
    sentAsk(A, 'hi', { instanceId: 'claude-2' });
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), reply('r1', 'hi', 1_000)]);
    await capture();
    expect(getAskCorrelation(db, A)).toMatchObject({ attributionState: 'pending', nativeInputId: null });
  });

  it('cell 8b (I6): M5 a sighting whose current session cannot be read never settles (stays pending)', async () => {
    sentAsk(A, 'hi');
    getLastAgentEvent.mockReturnValue({ sessionId: null });
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), reply('r1', 'hi', 1_000)]);
    const hint = transcriptPathOf(home, worktreePath, SESSION);
    await captureClaudeTranscriptTurn(
      { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' },
      { worktreePath, homeDir: home, transcriptPathHint: hint },
    );
    expect(getAskCorrelation(db, A)).toMatchObject({ attributionState: 'pending', nativeInputId: null });
  });

  it('cell 10b (H1): turnOpenAtSend unknown at the send → ambiguous/turn_open_at_send', async () => {
    sentAsk(A, 'hi', { turnOpenAtSend: null });
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), reply('r1', 'hi', 1_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'turn_open_at_send', reply: null });
  });

  it('cell 11b (H5): an interrupted turn (superseded, no stop) settles unmatched/turn_interrupted', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), toolUse('t1', 500), prompt('p2', 'something else', 1_000), reply('r2', 'other', 2_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'turn_interrupted', reply: null });
  });

  it('cell 11c (I5): a turn with no stop_reason observed is never matched (History\'s rescue is not completion)', async () => {
    sentAsk(A, 'hi');
    const noStop = {
      type: 'assistant', isSidechain: false, uuid: 'r1', timestamp: iso(1_000), cwd: '<CWD>',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, sessionId: SESSION,
    };
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), noStop]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', nativeInputSeen: true });
  });

  it('cell 12: a truncated row settles unmatched/body_truncated', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), reply('r1', 'x'.repeat(250_000), 1_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'body_truncated' });
  });

  it('cell 13: a closed turn whose row is not written yet stays pending', () => {
    sentAsk(A, 'hi');
    const outcome = bindAskSighting(db, {
      askId: A, target: { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' },
      nativeInputId: 'p1', nativeSessionId: SESSION, currentSessionId: SESSION, nativeTurnKey: 'claude-turn:p1',
      turnState: 'closed', otherInputs: 0, notices: 0, assistantMessage: null, truncated: false,
    });
    expect(outcome).toBe('pending');
    expect(getAskCorrelation(db, A)).toMatchObject({ attributionState: 'pending', nativeInputId: 'p1' });
  });

  it('cell 15 (I9): a second input of the same envelope after the send is saved → unmatched/envelope_duplicated', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), toolUse('t1', 500)]);
    await capture();
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), toolUse('t1', 500), prompt('p2', env(A, 'hi'), 1_000), reply('r2', 'hi', 2_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'envelope_duplicated' });
  });

  it('cell 16: resume into a new session before the turn settled → envelope_duplicated', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), toolUse('t1', 500)]);
    await capture();
    getLastAgentEvent.mockReturnValue({ sessionId: OTHER_SESSION });
    resetClaudeTranscriptSessions();
    await writeTranscript([prompt('p9', env(A, 'hi'), 5_000, OTHER_SESSION), reply('r9', 'hi', 6_000, OTHER_SESSION)], OTHER_SESSION);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'envelope_duplicated' });
  });

  it('cell 18 (I1): same session, another input id after matched → unchanged', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), reply('r1', 'first', 1_000)]);
    await capture();
    const settled = getAskCorrelation(db, A);
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), reply('r1', 'first', 1_000), prompt('p2', env(A, 'hi'), 2_000), reply('r2', 'second', 3_000)]);
    await capture();
    expect(getAskCorrelation(db, A)).toEqual(settled);
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'first' });
  });

  it('cell 19 (I2, H4): M6 a matched reply whose History row later changes reads unmatched/history_changed', async () => {
    sentAsk(A, 'hi');
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), reply('r1', 'short', 1_000)]);
    await capture();
    const [id] = getAskCorrelation(db, A)!.assistantMessageIds;
    db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run('short, and grown', id);
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'history_changed', reply: null });
    expect(getAskCorrelation(db, A)?.attributionState).toBe('matched');
  });

  it('cell 22 (H2): an envelope seen after not_sent leaves unmatched/not_sent', async () => {
    sentAsk(A, 'hi', { outcome: 'not_sent' });
    expect(getAskCorrelation(db, A)).toMatchObject({ attributionState: 'unmatched', reason: 'not_sent' });
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), reply('r1', 'hi', 1_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'unmatched', reason: 'not_sent', reply: null });
  });

  it('cell 24 (H3): a reservation older than ASK_RESERVED_STALE_MS is read as send_unknown and can settle', async () => {
    reserveOnly(A, 'hi', { now: Date.now() - ASK_RESERVED_STALE_MS - 1 });
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), reply('r1', 'hi', 1_000)]);
    await capture();
    // Settled, and by H1 (no turnOpenAtSend was saved) never matched.
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'turn_open_at_send', sendState: 'send_unknown' });
  });

  it('cell 24 (H3) negative: a fresh reservation is still waiting for its outcome', async () => {
    reserveOnly(A, 'hi');
    await writeTranscript([prompt('p1', env(A, 'hi'), 0), reply('r1', 'hi', 1_000)]);
    await capture();
    expect(await read(A)).toMatchObject({ state: 'pending', sendState: 'reserved' });
  });

  it('cell 26 (I3): M2 negative — a send without ask whose body opens with an envelope-shaped line keeps it; the /send row is adopted as one row', async () => {
    const body = `${formatAskEnvelope(A)}\nnot an ask`;
    createMessage(db, { worktreeId: WT, role: 'user', content: body, messageType: 'normal', timestamp: new Date(T0), cliToolId: 'claude', instanceId: 'claude' });
    await writeTranscript([prompt('p1', paste(body), 0), reply('r1', 'ok', 1_000)]);
    await capture();
    const rows = userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(body);
    expect(getAskCorrelation(db, A)).toBeNull();
  });
});

/**
 * Re-review (pr1c) P2: every observation is checked against its own record's
 * session, and only the observations that pass are counted, once per native
 * input (uuid + session). Red on de750be.
 */
describe('§3.6 I6・I9: each observation by its own record\'s session', () => {
  const env = (askId: string, body: string) => paste(`${formatAskEnvelope(askId)}\n${body}`);

  /** The absorbed-ask fixture with the absorbed records' own session replaced (null: removed). */
  async function absorbedWithSession(session: string | null): Promise<string> {
    const lines = (await readFile(join(FIXTURES, 'absorbed-ask.jsonl'), 'utf8')).split('\n').filter((l) => l.trim());
    return lines.map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type === 'queue-operation' || record.type === 'attachment') {
        if (session === null) delete record.sessionId;
        else record.sessionId = session;
      }
      return JSON.stringify(record);
    }).join('\n') + '\n';
  }

  it.each([
    ['an older session', OTHER_SESSION],
    ['no session', null],
  ])('an absorbed envelope whose own record names %s is rejected, though its turn is in the current session', async (_name, session) => {
    sentAsk(A, 'review the plan');
    sentAsk(B, 'second question', { at: 1_500 });
    await writeTranscript(await absorbedWithSession(session));
    await capture();
    expect(getAskCorrelation(db, B)).toMatchObject({ attributionState: 'pending', absorbedSeen: false });
    // The absorbing turn still took another input: A is never matched (safe side, M1).
    expect(await read(A)).toMatchObject({ state: 'ambiguous', reason: 'shared_turn' });
  });

  // The History row of p1 is written while p1 is the newest turn (as the poller does at
  // its end), with the send's outcome not saved yet; the outcome is then saved and the
  // next read holds the extra record after it.
  async function completedThenRead(extra: object): Promise<void> {
    reserveOnly(A, 'hi');
    const done = [prompt('p1', env(A, 'hi'), 0), reply('r1', 'the answer', 1_000)];
    await writeTranscript(done);
    await capture();
    settleAskSend(db, A, { sendState: 'sent', turnOpenAtSend: false });
    await writeTranscript([...done, extra]);
    await capture();
  }

  it('a completed turn followed by the same envelope stamped with an older session settles on its completion', async () => {
    await completedThenRead(prompt('p9', env(A, 'hi'), 2_000, OTHER_SESSION));
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'the answer' });
  });

  it('repeated records of one native input are one input, not a reappearance', async () => {
    await completedThenRead(prompt('p1', env(A, 'hi'), 0));
    expect(await read(A)).toMatchObject({ state: 'matched', reply: 'the answer' });
    expect(getAskCorrelation(db, A)).toMatchObject({ duplicateSeen: false, nativeInputId: 'p1' });
  });
});
