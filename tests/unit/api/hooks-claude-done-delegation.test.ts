/**
 * `/api/hooks/claude-done` delegating its stop event (Issue #1549).
 *
 * The compatibility requirement has two halves, and only asserting one of them
 * is how compatibility work usually goes wrong:
 *
 *  - the legacy endpoint now reaches the same task state a POST to
 *    `/api/hooks/agent-event` would have reached
 *  - it still does everything it did before, for the overwhelming majority of
 *    installations that have no contract and no task at all
 *
 * Both are asserted here. `tests/integration/api-hooks.test.ts` keeps the
 * message/capture behaviour under test; this file is about the delegation.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { createTask, getMessages, getTask, listTaskEvents, upsertWorktree } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { clearAgentStopEvents, getLastStopEventAt } from '@/lib/session/agent-event-state';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(() => Promise.resolve(true)),
  capturePane: vi.fn(() => Promise.resolve('agent finished\n')),
}));

const WORKTREE_ID = 'wt-claude-done';

let db: Database.Database;

function seedTask(status: 'running' | 'waiting_input' = 'running') {
  return createTask(db, {
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: legacy hook contract
goal: do the work
scope:
  allow: ["**"]
`,
      'task.yaml'
    ),
    status,
  });
}

async function postClaudeDone(body: unknown) {
  const { POST } = await import('@/app/api/hooks/claude-done/route');
  return POST(
    new Request('http://localhost/api/hooks/claude-done', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest
  );
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAgentStopEvents();

  upsertWorktree(db, {
    id: WORKTREE_ID,
    name: 'feature/legacy-hook',
    path: '/path/to/legacy',
    repositoryPath: '/path/to/repo',
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  clearAgentStopEvents();
});

describe('claude-done stop delegation', () => {
  it('records agent_idle with source=hook, exactly as agent-event would', async () => {
    const task = seedTask('waiting_input');

    const response = await postClaudeDone({ worktreeId: WORKTREE_ID });
    expect(response.status).toBe(200);

    const events = listTaskEvents(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('agent_idle');
    expect(events[0].payload).toEqual({ source: 'hook' });
    expect(getTask(db, task.id)?.status).toBe('running');
    expect(getLastStopEventAt(WORKTREE_ID, 'claude')).not.toBeNull();
  });

  it('still creates the assistant message it has always created', async () => {
    seedTask();

    await postClaudeDone({ worktreeId: WORKTREE_ID });

    // The delegation runs after the message is recorded, so a task-log failure
    // could never cost this endpoint its actual output.
    expect(getMessages(db, WORKTREE_ID)).toHaveLength(1);
  });

  it('changes nothing for a worktree with no task', async () => {
    const response = await postClaudeDone({ worktreeId: WORKTREE_ID });

    expect(response.status).toBe(200);
    expect(getMessages(db, WORKTREE_ID)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 0 });
  });

  it('keeps rejecting an unknown worktree before any delegation happens', async () => {
    const response = await postClaudeDone({ worktreeId: 'no-such-worktree' });

    expect(response.status).toBe(404);
    expect(getLastStopEventAt('no-such-worktree', 'claude')).toBeNull();
  });
});
