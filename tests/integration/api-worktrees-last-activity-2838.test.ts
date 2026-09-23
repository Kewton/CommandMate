/**
 * `GET /api/worktrees` returns each agent instance's own latest message time
 * (Issue #2838), on both the status path and `?includeStatus=0`.
 *
 * The database is real, so the COALESCE attribution of pre-#868 rows is
 * exercised end to end. The tmux module is mocked so nothing on the machine
 * running the suite takes part.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createMessage } from '@/lib/db/chat-db';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

vi.mock('@/lib/tmux/tmux', () => ({ listSessions: vi.fn(async () => []) }));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/worktrees/route';

async function get(query = '') {
  const res = await GET(new NextRequest(new Request(`http://localhost:3000/api/worktrees${query}`)));
  return { res, body: await res.json() };
}

type Row = { id: string; lastActivityByInstance?: Record<string, string> };

describe('[#2838] GET /api/worktrees lastActivityByInstance', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    for (const id of ['wt-a', 'wt-empty']) {
      upsertWorktree(db, { id, name: id, path: `/path/${id}`, repositoryPath: '/repo', repositoryName: 'Repo' });
    }
    createMessage(db, { worktreeId: 'wt-a', role: 'user', content: 'x', timestamp: new Date('2026-09-23T10:00:00Z'), messageType: 'normal', cliToolId: 'claude', instanceId: 'claude' });
    createMessage(db, { worktreeId: 'wt-a', role: 'user', content: 'y', timestamp: new Date('2026-09-23T11:00:00Z'), messageType: 'normal', cliToolId: 'codex', instanceId: 'codex' });
    // pre-#868 row: counts toward the primary claude instance
    db.prepare(`
      INSERT INTO chat_messages (id, worktree_id, role, content, timestamp, message_type, cli_tool_id, instance_id)
      VALUES ('legacy', 'wt-a', 'assistant', 'z', ?, 'normal', 'claude', NULL)
    `).run(new Date('2026-09-23T12:00:00Z').getTime());
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance') as unknown as { closeDbInstance: () => void };
    closeDbInstance();
  });

  it.each([
    ['with status', ''],
    ['with ?includeStatus=0', '?includeStatus=0'],
  ])('returns per-instance times %s', async (_label, query) => {
    const { res, body } = await get(query);
    expect(res.status).toBe(200);
    const rows = body.worktrees as Row[];

    expect(rows.find((w) => w.id === 'wt-a')?.lastActivityByInstance).toEqual({
      claude: '2026-09-23T12:00:00.000Z',
      codex: '2026-09-23T11:00:00.000Z',
    });
    // `{}`, not an omitted key, for a worktree without messages
    expect(rows.find((w) => w.id === 'wt-empty')?.lastActivityByInstance).toEqual({});
  });
});
