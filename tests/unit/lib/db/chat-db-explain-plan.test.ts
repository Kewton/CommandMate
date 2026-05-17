/**
 * EXPLAIN QUERY PLAN tests for chat-db queries (Issue #708)
 *
 * Verifies that role/archived/timestamp queries use the new composite index
 * idx_messages_worktree_role_archived_time after Migration #32.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../src/lib/db/db-migrations';

interface ExplainRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

const TARGET_INDEX = 'idx_messages_worktree_role_archived_time';

function explainContainsIndex(rows: ExplainRow[], indexName: string): boolean {
  return rows.map((r) => r.detail).join('\n').includes(indexName);
}

describe('chat-db EXPLAIN QUERY PLAN (Issue #708)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  it('getWorktrees correlated subquery uses idx_messages_worktree_role_archived_time', () => {
    const sql = `
      SELECT MAX(timestamp)
      FROM chat_messages
      WHERE worktree_id = ? AND role = 'assistant' AND archived = 0
    `;
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('test-id') as ExplainRow[];
    expect(explainContainsIndex(rows, TARGET_INDEX)).toBe(true);
  });

  it('getLastAssistantMessageAt uses idx_messages_worktree_role_archived_time', () => {
    const sql = `
      SELECT MAX(timestamp) as last_assistant_message_at
      FROM chat_messages
      WHERE worktree_id = ? AND role = 'assistant' AND archived = 0
    `;
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('test-id') as ExplainRow[];
    expect(explainContainsIndex(rows, TARGET_INDEX)).toBe(true);
  });

  it('getLastUserMessage uses idx_messages_worktree_role_archived_time', () => {
    const sql = `
      SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, archived
      FROM chat_messages
      WHERE worktree_id = ? AND role = 'user' AND archived = 0
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('test-id') as ExplainRow[];
    expect(explainContainsIndex(rows, TARGET_INDEX)).toBe(true);
  });

  it('getLastMessagesByCliBatch ROW_NUMBER subquery uses idx_messages_worktree_role_archived_time', () => {
    const sql = `
      WITH ranked_messages AS (
        SELECT
          worktree_id,
          cli_tool_id,
          content,
          ROW_NUMBER() OVER (
            PARTITION BY worktree_id, cli_tool_id
            ORDER BY timestamp DESC
          ) as rn
        FROM chat_messages
        WHERE worktree_id IN (?)
          AND role = 'user'
          AND archived = 0
      )
      SELECT worktree_id, cli_tool_id, content
      FROM ranked_messages
      WHERE rn = 1
    `;
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('test-id') as ExplainRow[];
    expect(explainContainsIndex(rows, TARGET_INDEX)).toBe(true);
  });
});
