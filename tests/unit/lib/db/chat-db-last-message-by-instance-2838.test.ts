/**
 * Tests for chat-db.ts getLastMessageAtByInstance()
 * Issue #2838: per-instance activity time for the sidebar's session rows
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createMessage, getLastMessageAtByInstance } from '@/lib/db/chat-db';

let db: Database.Database;

function insertRaw(
  id: string,
  worktreeId: string,
  timestamp: number,
  cliToolId: string | null,
  instanceId: string | null,
  archived = 0
) {
  db.prepare(`
    INSERT INTO chat_messages (id, worktree_id, role, content, timestamp, message_type, cli_tool_id, instance_id, archived)
    VALUES (?, ?, 'user', 'x', ?, 'normal', ?, ?, ?)
  `).run(id, worktreeId, timestamp, cliToolId, instanceId, archived);
}

describe('getLastMessageAtByInstance (Issue #2838)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    for (const id of ['wt-1', 'wt-2', 'wt-empty']) {
      upsertWorktree(db, { id, name: id, path: `/path/${id}`, repositoryPath: '/repo', repositoryName: 'Repo' });
    }
  });

  afterEach(() => {
    db.close();
  });

  it('returns the latest message time per worktree and instance', () => {
    createMessage(db, { worktreeId: 'wt-1', role: 'user', content: 'a', timestamp: new Date(1000), messageType: 'normal', cliToolId: 'claude', instanceId: 'claude' });
    createMessage(db, { worktreeId: 'wt-1', role: 'assistant', content: 'b', timestamp: new Date(3000), messageType: 'normal', cliToolId: 'claude', instanceId: 'claude' });
    createMessage(db, { worktreeId: 'wt-1', role: 'user', content: 'c', timestamp: new Date(2000), messageType: 'normal', cliToolId: 'codex', instanceId: 'codex-2' });
    createMessage(db, { worktreeId: 'wt-2', role: 'user', content: 'd', timestamp: new Date(5000), messageType: 'normal', cliToolId: 'codex', instanceId: 'codex' });

    const result = getLastMessageAtByInstance(db);

    expect(result.get('wt-1')).toEqual({ claude: new Date(3000), 'codex-2': new Date(2000) });
    expect(result.get('wt-2')).toEqual({ codex: new Date(5000) });
    expect(result.has('wt-empty')).toBe(false);
  });

  it('counts pre-#868 rows (instance_id IS NULL) toward the primary instance of their tool', () => {
    insertRaw('m1', 'wt-1', 1000, 'claude', 'claude');
    insertRaw('m2', 'wt-1', 4000, 'claude', null);
    insertRaw('m3', 'wt-1', 2000, 'codex', null);
    insertRaw('m4', 'wt-2', 3000, null, null);

    const result = getLastMessageAtByInstance(db);

    expect(result.get('wt-1')).toEqual({ claude: new Date(4000), codex: new Date(2000) });
    // no tool either: reads as 'claude', as getMessages does
    expect(result.get('wt-2')).toEqual({ claude: new Date(3000) });
  });

  it('includes archived rows, like the worktree updated_at they refine', () => {
    insertRaw('m1', 'wt-1', 1000, 'claude', 'claude');
    insertRaw('m2', 'wt-1', 9000, 'claude', 'claude', 1);

    expect(getLastMessageAtByInstance(db).get('wt-1')).toEqual({ claude: new Date(9000) });
  });

  it('answers every worktree with a single statement', () => {
    insertRaw('m1', 'wt-1', 1000, 'claude', 'claude');
    insertRaw('m2', 'wt-2', 2000, 'claude', 'claude');
    const prepare = vi.spyOn(db, 'prepare');

    const result = getLastMessageAtByInstance(db);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect([...result.keys()].sort()).toEqual(['wt-1', 'wt-2']);
  });

  it('returns an empty map when there are no messages', () => {
    expect(getLastMessageAtByInstance(db).size).toBe(0);
  });
});
