/**
 * A pasted prompt is the `/send` row it came from, not a second one (Issue #3102).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
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
import { recordUserTurn } from '@/lib/history/user-turn-recorder';
import { buildClaudeTurns, parseClaudeTranscript } from '@/lib/hooks/sources/claude/transcript';
import type { Worktree } from '@/types/models';

const WORKTREE_ID = 'wt-3102';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;
const KEY = 'claude-prompt:f7605faf-1ee6-43fa-8008-b4d18b45ce00';
const SENT_AT = Date.parse('2026-10-03T00:00:00.000Z') - 1000;
const BODY = '/orchestrate 3099 3100\n\n条件の説明です。\n複数行の本文。';

let db: Database.Database;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  module.setMockDb(value);
}

function userRows() {
  return getMessages(db, WORKTREE_ID, { limit: 200 }).filter((message) => message.role === 'user');
}

/** What the transcript reader hands `recordUserTurn` for the fixture's record. */
function pastedTurn() {
  const raw = readFileSync(join(process.cwd(), 'tests/fixtures/claude-transcript-3102/pasted-user-record.jsonl'), 'utf8');
  const turn = buildClaudeTurns(parseClaudeTranscript(raw).records, 'fallback-session').turns[0];
  return { text: turn.promptText, at: turn.startedAt };
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-3102',
    path: '/repos/commandmate-issue-3102',
    repositoryPath: '/repos',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
});

afterEach(async () => {
  await setMockDb(null);
  db.close();
});

describe('a pasted transcript record', () => {
  it('adopts the /send row and leaves one row', async () => {
    createMessage(db, {
      worktreeId: WORKTREE_ID,
      role: 'user',
      content: BODY,
      messageType: 'normal',
      timestamp: new Date(SENT_AT),
      cliToolId: 'claude',
      instanceId: 'claude',
    });
    const { text, at } = pastedTurn();

    const result = await recordUserTurn(TARGET, KEY, text, at);

    expect(result.outcome).toBe('adopted');
    const rows = userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].requestId).toBe(KEY);
    expect(rows[0].content).toBe(BODY);
  });

  it('is already recorded on the relay row, which keeps its request_id', async () => {
    const relayId = relayRequestId('c12d462f-8e1a-4f77-9c50-2b6d3ea9f014');
    createMessage(db, {
      worktreeId: WORKTREE_ID,
      role: 'user',
      content: BODY,
      messageType: 'relay',
      timestamp: new Date(SENT_AT),
      cliToolId: 'claude',
      instanceId: 'claude',
      requestId: relayId,
    });
    const { text, at } = pastedTurn();

    const result = await recordUserTurn(TARGET, KEY, text, at);

    expect(result.outcome).toBe('already-recorded');
    const rows = userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].requestId).toBe(relayId);
  });
});
