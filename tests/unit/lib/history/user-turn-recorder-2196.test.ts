/**
 * The tool-agnostic half of "the operator's input reaches History" (Issue #2196).
 *
 * `recordUserTurn` is the piece #2197 (codex) and #2198 (antigravity) are meant
 * to reuse unchanged, so everything here is stated in terms of an instance, a
 * key, some text and a moment — no transcript, no tool. The Claude-specific
 * wiring is pinned in `tests/unit/hooks/sources/claude-user-turn-2196.test.ts`.
 *
 * The three outcomes are the whole contract and the middle one is the reason the
 * function exists:
 *
 *  - **already recorded** — the key is on a row, so a poller asking twice writes
 *    once;
 *  - **adopted** — `/send` already wrote this exact message, so the row is
 *    claimed rather than duplicated. Showing the operator their own message
 *    twice is a worse defect than the orphan pair the Issue set out to remove;
 *  - **inserted** — nobody had it, so it is written and broadcast.
 *
 * A real `better-sqlite3` database stands in for `chat_messages` rather than a
 * `Map`, because two of the rules under test are SQL — the ±120 s window and the
 * `request_id IS NULL` compare-and-set — and a hand-rolled fake would be
 * asserting the fake.
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
import { createMessage, getMessages } from '@/lib/db';
import { upsertWorktree } from '@/lib/db';
import { broadcastMessage } from '@/lib/ws-server';
import {
  normalizeUserTurnContent,
  recordUserTurn,
  USER_TURN_ADOPTION_WINDOW_MS,
} from '@/lib/history/user-turn-recorder';
import type { Worktree } from '@/types/models';

const WORKTREE_ID = 'wt-2196';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;
const SECOND = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude-2' } as const;
const KEY = 'claude-prompt:00000000-0000-4000-8000-000000000003';
const PROMPT = 'ターミナルから直接打った指示です。\nこれが履歴に user 行として出ること。';
const AT = Date.parse('2026-09-01T10:00:00.000Z');

let db: Database.Database;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  module.setMockDb(value);
}

/** Every row this worktree has, oldest first. */
function rows(instanceId?: string) {
  return getMessages(db, WORKTREE_ID, { limit: 200, instanceId })
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function userRows(instanceId?: string) {
  return rows(instanceId).filter((message) => message.role === 'user');
}

/** A row of the shape `sendUserMessage` writes: no `request_id`. */
function sendRow(content: string, at: number, instanceId = 'claude') {
  return createMessage(db, {
    worktreeId: WORKTREE_ID,
    role: 'user',
    content,
    messageType: 'normal',
    timestamp: new Date(at),
    cliToolId: 'claude',
    instanceId,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-2196',
    path: '/repos/commandmate-issue-2196',
    repositoryPath: '/repos',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
});

afterEach(async () => {
  await setMockDb(null);
  db.close();
});

describe('inserting a prompt nobody had', () => {
  it('writes one user row keyed by the caller’s key', async () => {
    const result = await recordUserTurn(TARGET, KEY, PROMPT, AT);

    expect(result.outcome).toBe('inserted');
    const saved = userRows();
    expect(saved).toHaveLength(1);
    expect(saved[0].content).toBe(PROMPT);
    expect(saved[0].requestId).toBe(KEY);
    expect(saved[0].cliToolId).toBe('claude');
    expect(saved[0].instanceId).toBe('claude');
    expect(saved[0].timestamp.getTime()).toBe(AT);
  });

  it('broadcasts it so an open History pane sees it without a reload', async () => {
    await recordUserTurn(TARGET, KEY, PROMPT, AT);

    expect(vi.mocked(broadcastMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(broadcastMessage).mock.calls[0][0]).toBe('message');
  });

  it('reports the row and its timestamp, which is what orders the reply after it', async () => {
    const result = await recordUserTurn(TARGET, KEY, PROMPT, AT);

    expect(result.messageId).not.toBeNull();
    expect(result.timestampMs).toBe(AT);
  });
});

describe('being asked twice', () => {
  it('writes one row however many times the poller asks', async () => {
    expect((await recordUserTurn(TARGET, KEY, PROMPT, AT)).outcome).toBe('inserted');
    expect((await recordUserTurn(TARGET, KEY, PROMPT, AT)).outcome).toBe('already-recorded');
    expect((await recordUserTurn(TARGET, KEY, PROMPT, AT)).outcome).toBe('already-recorded');

    expect(userRows()).toHaveLength(1);
    expect(vi.mocked(broadcastMessage)).toHaveBeenCalledTimes(1);
  });

  it('still reports the existing row, so the caller can order around it', async () => {
    await recordUserTurn(TARGET, KEY, PROMPT, AT);
    const again = await recordUserTurn(TARGET, KEY, PROMPT, AT);

    expect(again.messageId).toBe(userRows()[0].id);
    expect(again.timestampMs).toBe(AT);
  });
});

describe('a row `/send` already wrote', () => {
  it('claims it instead of writing a second copy of the operator’s words', async () => {
    const existing = sendRow(PROMPT, AT - 3_000);

    const result = await recordUserTurn(TARGET, KEY, PROMPT, AT);

    expect(result.outcome).toBe('adopted');
    const saved = userRows();
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(existing.id);
    expect(saved[0].requestId).toBe(KEY);
  });

  it('leaves the `/send` row’s own timestamp alone', async () => {
    // The row is the operator's record of when they sent it. Re-dating it by the
    // agent's clock would move the message under a different conversation card.
    sendRow(PROMPT, AT - 3_000);
    const result = await recordUserTurn(TARGET, KEY, PROMPT, AT);

    expect(userRows()[0].timestamp.getTime()).toBe(AT - 3_000);
    expect(result.timestampMs).toBe(AT - 3_000);
  });

  it('does not broadcast — the row was already on screen', async () => {
    sendRow(PROMPT, AT - 3_000);
    await recordUserTurn(TARGET, KEY, PROMPT, AT);

    expect(vi.mocked(broadcastMessage)).not.toHaveBeenCalled();
  });

  it('is idempotent afterwards, through the key it just wrote', async () => {
    sendRow(PROMPT, AT - 3_000);
    await recordUserTurn(TARGET, KEY, PROMPT, AT);

    expect((await recordUserTurn(TARGET, KEY, PROMPT, AT)).outcome).toBe('already-recorded');
    expect(userRows()).toHaveLength(1);
  });

  it('ignores trailing whitespace and CRLF, which a composer round trip adds', async () => {
    sendRow(`${PROMPT}   \r\n\r\n`, AT - 1_000);

    expect((await recordUserTurn(TARGET, KEY, PROMPT, AT)).outcome).toBe('adopted');
    expect(userRows()).toHaveLength(1);
  });

  it('takes the row nearest the agent’s clock when the same text was sent twice', async () => {
    sendRow(PROMPT, AT - 100_000);
    const near = sendRow(PROMPT, AT - 2_000);

    await recordUserTurn(TARGET, KEY, PROMPT, AT);

    expect(userRows().find((row) => row.requestId === KEY)?.id).toBe(near.id);
  });
});

describe('rows that are not this prompt', () => {
  it('inserts when the only matching row is outside the window', async () => {
    sendRow(PROMPT, AT - USER_TURN_ADOPTION_WINDOW_MS - 1_000);

    expect((await recordUserTurn(TARGET, KEY, PROMPT, AT)).outcome).toBe('inserted');
    expect(userRows()).toHaveLength(2);
  });

  it('inserts when a row inside the window says something else', async () => {
    sendRow('まったく別の指示', AT - 1_000);

    expect((await recordUserTurn(TARGET, KEY, PROMPT, AT)).outcome).toBe('inserted');
    expect(userRows()).toHaveLength(2);
  });

  it('inserts rather than collapsing a prompt whose paragraph breaks differ', async () => {
    // Interior blank lines are content. Only trailing whitespace is noise.
    sendRow(PROMPT.replace('\n', '\n\n'), AT - 1_000);

    expect((await recordUserTurn(TARGET, KEY, PROMPT, AT)).outcome).toBe('inserted');
    expect(userRows()).toHaveLength(2);
  });

  it('never claims another instance’s row', async () => {
    // claude-2's input must not be filed as claude-1's, and this is the only
    // guard against it: the two instances share a worktree, a tool and a
    // project directory.
    const other = sendRow(PROMPT, AT - 1_000, 'claude-2');

    expect((await recordUserTurn(TARGET, KEY, PROMPT, AT)).outcome).toBe('inserted');
    expect(userRows('claude-2')).toHaveLength(1);
    expect(userRows('claude-2')[0].id).toBe(other.id);
    expect(userRows('claude-2')[0].requestId).toBeUndefined();
    expect(userRows('claude')).toHaveLength(1);
  });

  it('records claude-2’s prompt against claude-2 only', async () => {
    await recordUserTurn(SECOND, KEY, PROMPT, AT);

    expect(userRows('claude-2')).toHaveLength(1);
    expect(userRows('claude')).toHaveLength(0);
  });

  it('never claims a row that already carries somebody’s key', async () => {
    createMessage(db, {
      worktreeId: WORKTREE_ID,
      role: 'user',
      content: PROMPT,
      messageType: 'normal',
      timestamp: new Date(AT - 1_000),
      cliToolId: 'claude',
      instanceId: 'claude',
      requestId: 'claude-prompt:somebody-else',
    });

    expect((await recordUserTurn(TARGET, KEY, PROMPT, AT)).outcome).toBe('inserted');
    expect(userRows()).toHaveLength(2);
  });
});

describe('nothing to record', () => {
  it('skips an empty key', async () => {
    expect((await recordUserTurn(TARGET, '', PROMPT, AT)).outcome).toBe('skipped');
    expect(userRows()).toHaveLength(0);
  });

  it('skips text that is only whitespace', async () => {
    expect((await recordUserTurn(TARGET, KEY, '  \n\t\n ', AT)).outcome).toBe('skipped');
    expect(userRows()).toHaveLength(0);
  });
});

describe('when the database cannot be reached', () => {
  it('reports the failure instead of throwing it at the poller', async () => {
    // The caller writes the assistant row immediately after this returns. An
    // exception escaping here would cost the reply as well as the prompt.
    await setMockDb(null);

    await expect(recordUserTurn(TARGET, KEY, PROMPT, AT)).resolves.toEqual({
      outcome: 'failed',
      messageId: null,
      timestampMs: null,
    });
  });

  it('reports the failure when the write itself is refused', async () => {
    db.exec('DROP TABLE chat_messages');

    await expect(recordUserTurn(TARGET, KEY, PROMPT, AT)).resolves.toMatchObject({
      outcome: 'failed',
    });
  });
});

describe('normalizeUserTurnContent', () => {
  it('drops trailing whitespace per line and at both ends', () => {
    expect(normalizeUserTurnContent('\n a \t\nb   \n\n')).toBe('a\nb');
  });

  it('treats CRLF and LF as the same break', () => {
    expect(normalizeUserTurnContent('a\r\nb')).toBe(normalizeUserTurnContent('a\nb'));
  });

  it('drops a trailing ideographic space, which a Japanese composer leaves behind', () => {
    expect(normalizeUserTurnContent('指示です。　')).toBe('指示です。');
  });

  it('keeps interior blank lines, which are content', () => {
    expect(normalizeUserTurnContent('a\n\nb')).toBe('a\n\nb');
  });
});
