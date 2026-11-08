/**
 * `POST /api/worktrees/:id/send` and its `brief` field (Issue #4274): `skip` and
 * `force` are accepted, anything else is 400 before anything is resolved or
 * recorded.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { validateSendRequest } from '@/app/api/worktrees/[id]/send/send-request';

describe('[#4274] the send body’s brief flag', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run('wt', 'wt', '/tmp/wt', 1);
  });
  afterEach(() => db.close());

  it.each(['skip', 'force', undefined])('accepts brief: %s', (brief) => {
    const step = validateSendRequest(db, 'wt', { content: 'hi', cliToolId: 'claude', ...(brief ? { brief } : {}) } as never);
    expect(step.ok).toBe(true);
  });

  it.each(['auto', 'never', '', 1, true])('refuses brief: %s with 400', async (brief) => {
    const step = validateSendRequest(db, 'wt', { content: 'hi', cliToolId: 'claude', brief } as never);
    expect(step.ok).toBe(false);
    if (!step.ok) {
      const response = await step.response;
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "brief must be 'skip' or 'force'" });
    }
  });
});
