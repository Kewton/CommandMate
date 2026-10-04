/**
 * Removing an instance from the roster releases its Auto-Yes (Issue #3184,
 * the `instance-removed` row of the Auto-Yes lifecycle table).
 *
 * Before #3184 the roster PATCH left the grant armed, so the next instance to
 * claim the id silently inherited it. Real route against a real in-memory
 * SQLite database; only the DB singleton is mocked, as
 * `worktree-alias-routes.test.ts` does it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, setAgentInstances } from '@/lib/db';
import type { NextRequest } from 'next/server';
import type { Worktree } from '@/types/models';
import type { AgentInstance } from '@/lib/cli-tools/types';
import {
  buildCompositeKey,
  clearAllAutoYesStates,
  getAutoYesState,
  getAutoYesStateCompositeKeys,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';

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
      mockDb = null;
    },
  };
});

import { PATCH } from '@/app/api/worktrees/[id]/route';

const WT = 'wt-3184-roster';

const WORKTREE: Worktree = {
  id: WT,
  name: 'feature/3184',
  branch: 'feature/3184',
  path: '/repos/commandmate-issue-3184',
  repositoryPath: '/repos/commandmate',
  repositoryName: 'commandmate',
};

const ROSTER: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 2 },
];

function patch(body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/worktrees/${WT}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: WT }) },
  );
}

const hasState = (tool: 'claude' | 'codex', instance: string) =>
  getAutoYesStateCompositeKeys().includes(buildCompositeKey(WT, tool, instance));

describe('PATCH /api/worktrees/[id] agentInstances releases removed instances’ Auto-Yes (#3184)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = ON');
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    upsertWorktree(db, WORKTREE);
    setAgentInstances(db, WT, ROSTER);

    clearAllAutoYesStates();
    setAutoYesEnabled(WT, 'claude', true);
    setAutoYesEnabled(WT, 'claude', true, undefined, undefined, 'claude-2');
    setAutoYesEnabled(WT, 'codex', true);
    setAutoYesEnabled('wt-3184-other', 'claude', true, undefined, undefined, 'claude-2');
  });

  afterEach(async () => {
    clearAllAutoYesStates();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('drops the removed instance’s state and leaves the kept ones armed', async () => {
    const response = await patch({ agentInstances: [ROSTER[0], { ...ROSTER[2], order: 1 }] });

    expect(response.status).toBe(200);
    expect(hasState('claude', 'claude-2')).toBe(false);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
    expect(getAutoYesState(WT, 'codex')?.enabled).toBe(true);
    // Negative control: the same instance id in another worktree is not touched.
    expect(getAutoYesState('wt-3184-other', 'claude', 'claude-2')?.enabled).toBe(true);
  });

  it('treats an id re-bound to another tool as removed for the old tool', async () => {
    const response = await patch({
      agentInstances: [ROSTER[0], { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 }],
    });

    expect(response.status).toBe(200);
    expect(hasState('claude', 'claude-2')).toBe(false);
    expect(hasState('codex', 'codex')).toBe(false);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
  });

  it('leaves every grant alone when the roster is only re-ordered or renamed', async () => {
    const response = await patch({
      agentInstances: [
        { ...ROSTER[2], order: 0 },
        { ...ROSTER[1], alias: 'renamed', order: 1 },
        { ...ROSTER[0], order: 2 },
      ],
    });

    expect(response.status).toBe(200);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
    expect(getAutoYesState(WT, 'claude', 'claude-2')?.enabled).toBe(true);
    expect(getAutoYesState(WT, 'codex')?.enabled).toBe(true);
  });

  it('releases nothing when the roster write is refused', async () => {
    const response = await patch({ agentInstances: [] });

    expect(response.status).toBe(400);
    expect(getAutoYesState(WT, 'claude', 'claude-2')?.enabled).toBe(true);
    expect(getAutoYesState(WT, 'codex')?.enabled).toBe(true);
  });
});
