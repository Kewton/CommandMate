/**
 * The relay delivery a transcript reader recorded a second time (Issue #2392).
 *
 * ## What is being pinned
 *
 * #2377 delivers session B's answer by typing it into session A's composer, and
 * `sendUserMessage` writes that as a `relay` user row keyed `relay:<ledgerId>`.
 * Session A's own transcript reader then sees a prompt it was handed, calls
 * `recordUserTurn` with its own key, and — because #2196's claim only ever
 * looked at rows with **no** `request_id` — inserted a second row holding the
 * byte-identical body. Measured at 662ms apart in the UAT this Issue is written
 * from, and visible on every single delegation.
 *
 * So the assertions come in two halves and both are load-bearing:
 *
 *  - **one row, not two** — the reader now recognises the delivery's row;
 *  - **that row's `request_id` is untouched** — still `relay:<ledgerId>`. This
 *    is not tidiness. `relay-service`'s `findParentRelayHops` (#2387) reads the
 *    ledger id back out of that column, so a fix that claimed the row the way
 *    #2196 claims a `/send` row would silence the duplicate and un-chain every
 *    relay opened from the session, which is the regression #2387 had just
 *    finished fixing. Several tests below assert the column directly for that
 *    reason.
 *
 * The rows are built with `createMessage` in the shape `relay-delivery` writes
 * them rather than through the relay stack, because what is under test is the
 * recorder's reading of a row, and `tests/unit/lib/relay/relay-parent-hops-2387`
 * covers the same ground with the real delivery in front of it.
 *
 * A real `better-sqlite3` database and not a fake: the lookup this Issue adds is
 * SQL — `message_type = 'relay'` and the `relay:` key prefix over the same
 * window — and a hand-rolled stub would be asserting the stub.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database | null) => {
      mockDb = db;
    },
  };
});

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import { relayRequestId } from '@/lib/db/chat-db';
import { broadcastMessage } from '@/lib/ws-server';
import { recordUserTurn } from '@/lib/history/user-turn-recorder';
import type { ChatMessage, Worktree } from '@/types/models';

const WORKTREE_ID = 'wt-2392';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;
/** The key session A's own transcript reader derives for the prompt it was handed. */
const KEY = 'claude-prompt:29a5b0d1-7e64-4a2f-9f3c-0d8a1b6c4e21';
const RELAY_ID = 'c12d462f-8e1a-4f77-9c50-2b6d3ea9f014';
/** The body a delivery puts in A's composer; framing an operator would not type. */
const BODY = '【Codex 2 (agents-repo) からの返答】\n\n調査は完了しました。\n\n結論: 重複は転写リーダー側です。';
/** When `sendUserMessage` stamped the relay row. */
const DELIVERED_AT = Date.parse('2026-09-07T04:31:43.099Z');
/** The gap measured between the two rows in the UAT behind this Issue. */
const ECHO_DELAY_MS = 662;
const AT = DELIVERED_AT + ECHO_DELAY_MS;

let db: Database.Database;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  module.setMockDb(value);
}

/** Every user row this worktree holds for one instance, oldest first. */
function userRows(instanceId = 'claude'): ChatMessage[] {
  return getMessages(db, WORKTREE_ID, {
    limit: 200,
    cliToolId: 'claude',
    instanceId,
    matchResolvedInstance: true,
  })
    .filter((message) => message.role === 'user')
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/** The row `relay-delivery` writes when it hands A the answer (`kind: 'reply'`). */
function relayRow(content = BODY, at = DELIVERED_AT, instanceId = 'claude'): ChatMessage {
  return createMessage(db, {
    worktreeId: WORKTREE_ID,
    role: 'user',
    content,
    messageType: 'relay',
    timestamp: new Date(at),
    cliToolId: 'claude',
    instanceId,
    requestId: relayRequestId(RELAY_ID),
  });
}

/** A's transcript reader recording the prompt it was just handed. */
function readTranscriptBack(content = BODY, at = AT) {
  return recordUserTurn(TARGET, KEY, content, at);
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-2392',
    path: '/repos/commandmate-issue-2392',
    repositoryPath: '/repos',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
});

afterEach(async () => {
  await setMockDb(null);
  db.close();
});

describe('the row a relay delivery already wrote', () => {
  it('is recognised instead of duplicated', async () => {
    const delivered = relayRow();

    const result = await readTranscriptBack();

    expect(result.outcome).toBe('already-recorded');
    expect(result.messageId).toBe(delivered.id);

    const saved = userRows();
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(delivered.id);
  });

  it('keeps its own `request_id`, which is the loop guard’s way back to the ledger', async () => {
    const delivered = relayRow();

    await readTranscriptBack();

    const saved = userRows();
    expect(saved).toHaveLength(1);
    expect(saved[0].requestId).toBe(relayRequestId(RELAY_ID));
    expect(saved[0].requestId).toBe(delivered.requestId);
    // The reader's own key was never written anywhere.
    expect(saved.some((row) => row.requestId === KEY)).toBe(false);
  });

  it('keeps reading as a relay row, so History still badges it as one', async () => {
    relayRow();

    await readTranscriptBack();

    expect(userRows()[0].messageType).toBe('relay');
  });

  it('is not re-dated by the agent’s clock', async () => {
    // The delivery's own instant is what orders the reply after it, and the
    // caller is told that instant rather than the transcript's.
    relayRow();

    const result = await readTranscriptBack();

    expect(userRows()[0].timestamp.getTime()).toBe(DELIVERED_AT);
    expect(result.timestampMs).toBe(DELIVERED_AT);
  });

  it('does not broadcast — the row was already on screen', async () => {
    relayRow();

    await readTranscriptBack();

    expect(vi.mocked(broadcastMessage)).not.toHaveBeenCalled();
  });

  it('stays at one row however many times the poller asks', async () => {
    relayRow();

    for (let i = 0; i < 3; i += 1) {
      expect((await readTranscriptBack()).outcome).toBe('already-recorded');
    }

    expect(userRows()).toHaveLength(1);
    expect(userRows()[0].requestId).toBe(relayRequestId(RELAY_ID));
  });

  it('is recognised even when the transcript’s clock rounds the prompt backwards', async () => {
    // A reader whose record carries whole seconds dates the prompt *before* the
    // row that produced it. The window is symmetric precisely so that a clock
    // like that cannot bring the duplicate back.
    relayRow();

    const result = await readTranscriptBack(BODY, DELIVERED_AT - 400);

    expect(result.outcome).toBe('already-recorded');
    expect(userRows()).toHaveLength(1);
  });
});

describe('what it still writes', () => {
  it('inserts when the relay row holds a different message', async () => {
    relayRow('【Codex 2 (agents-repo) からの返答】\n\n別の依頼への返答です。');

    const result = await readTranscriptBack();

    expect(result.outcome).toBe('inserted');
    const saved = userRows();
    expect(saved).toHaveLength(2);
    expect(saved.find((row) => row.requestId === KEY)?.content).toBe(BODY);
  });

  it('inserts when the relay row belongs to another instance', async () => {
    // `claude-2` is a different session of the same tool; its delivery is not
    // this session's prompt, and folding the two would lose a message.
    relayRow(BODY, DELIVERED_AT, 'claude-2');

    const result = await readTranscriptBack();

    expect(result.outcome).toBe('inserted');
    expect(userRows('claude')).toHaveLength(1);
    expect(userRows('claude')[0].requestId).toBe(KEY);
    expect(userRows('claude-2')).toHaveLength(1);
  });

  it('inserts when the relay row is far outside the adoption window', async () => {
    relayRow(BODY, AT - 10 * 60_000);

    const result = await readTranscriptBack();

    expect(result.outcome).toBe('inserted');
    expect(userRows()).toHaveLength(2);
  });

  it('inserts when the relay row has been archived out of History', async () => {
    const delivered = relayRow();
    db.prepare('UPDATE chat_messages SET archived = 1 WHERE id = ?').run(delivered.id);

    const result = await readTranscriptBack();

    expect(result.outcome).toBe('inserted');
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0].requestId).toBe(KEY);
  });
});

describe('the two lookups together', () => {
  it('still claims the `/send` row when there is one (Issue #2196)', async () => {
    // The relay row must not shadow the unkeyed claim: a `/send` row is still
    // adopted, and adoption is still the outcome that writes the key.
    const sent = createMessage(db, {
      worktreeId: WORKTREE_ID,
      role: 'user',
      content: BODY,
      messageType: 'normal',
      timestamp: new Date(AT - 3_000),
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    const result = await readTranscriptBack();

    expect(result.outcome).toBe('adopted');
    expect(result.messageId).toBe(sent.id);
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0].requestId).toBe(KEY);
  });

  it('prefers claiming the unkeyed row over standing down on the relay row', async () => {
    // Both are present — the relay delivery, and an unkeyed row holding the same
    // text. The claim runs first, so the operator's own row gains the key and
    // the relay row keeps its own; neither is duplicated and nothing is lost.
    const delivered = relayRow();
    const sent = createMessage(db, {
      worktreeId: WORKTREE_ID,
      role: 'user',
      content: BODY,
      messageType: 'normal',
      timestamp: new Date(AT - 1_000),
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    const result = await readTranscriptBack();

    expect(result.outcome).toBe('adopted');
    expect(result.messageId).toBe(sent.id);

    const saved = userRows();
    expect(saved).toHaveLength(2);
    expect(saved.find((row) => row.id === delivered.id)?.requestId).toBe(
      relayRequestId(RELAY_ID)
    );
    expect(saved.find((row) => row.id === sent.id)?.requestId).toBe(KEY);
  });
});
