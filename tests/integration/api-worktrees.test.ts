/**
 * API Routes Integration Tests - Worktrees
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as getWorktrees } from '@/app/api/worktrees/route';
import { GET as getWorktreeById } from '@/app/api/worktrees/[id]/route';
import { PATCH as patchWorktreeById } from '@/app/api/worktrees/[id]/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, createMessage } from '@/lib/db';
import { setDefaultSelectedAgents } from '@/lib/db/app-settings-db';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';
import type { Worktree } from '@/types/models';

// Declare mock function type
declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

// Mock the database instance
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDbInstance: () => {
      if (!mockDb) {
        throw new Error('Mock database not initialized');
      }
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

describe('GET /api/worktrees', () => {
  let db: Database.Database;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    runMigrations(db);

    // Set mock database
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return empty array when no worktrees exist', async () => {
    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);

    const data = await response.json();
    // Issue #2065: the envelope also carries the server-wide default agent
    // list. Nothing is stored here, so it is the compiled-in constant — the
    // "an install with no setting is unchanged" criterion, against a real DB.
    //
    // NOTE: this case alone cannot prove the field is WIRED — the expected
    // value is the same constant a hardcoded implementation would return. The
    // suite below is what pins that; do not let this one stand in for it.
    expect(data).toEqual({
      worktrees: [],
      repositories: [],
      defaultSelectedAgents: ['claude', 'codex', 'antigravity'],
    });
    // Belt and braces: the literal above is the constant, so a change to the
    // constant is a deliberate edit here rather than a silent no-op.
    expect(data.defaultSelectedAgents).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('should return all worktrees sorted by updatedAt DESC', async () => {
    // Insert test worktrees
    const worktree1: Worktree = {
      id: 'main',
      name: 'main',
      path: '/path/to/main',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      updatedAt: new Date('2025-01-17T10:00:00Z'),
    };

    const worktree2: Worktree = {
      id: 'feature-foo',
      name: 'feature/foo',
      path: '/path/to/feature-foo',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      updatedAt: new Date('2025-01-17T11:00:00Z'),
    };

    upsertWorktree(db, worktree1);
    upsertWorktree(db, worktree2);

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.worktrees).toHaveLength(2);

    // Should be sorted by updatedAt DESC (newest first)
    expect(data.worktrees[0].id).toBe('feature-foo');
    expect(data.worktrees[1].id).toBe('main');
  });

  it('should include lastMessageSummary in response', async () => {
    const worktree: Worktree = {
      id: 'test',
      name: 'test',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      lastMessageSummary: 'Last message summary',
    };

    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request as unknown as import('next/server').NextRequest);

    const data = await response.json();
    expect(data.worktrees[0].lastMessageSummary).toBe('Last message summary');
  });

  it('should include agentInstances roster for each worktree (Issue #878)', async () => {
    const worktree: Worktree = {
      id: 'feature-instances',
      name: 'feature/instances',
      path: '/path/to/feature-instances',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
    };

    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);

    const data = await response.json();
    const item = data.worktrees.find((w: { id: string }) => w.id === 'feature-instances');
    expect(item).toBeDefined();
    // With no explicit agent_instances rows, the roster is derived as one
    // primary instance per selectedAgent (id === cliTool).
    expect(Array.isArray(item.agentInstances)).toBe(true);
    expect(item.agentInstances.length).toBeGreaterThan(0);
    expect(item.agentInstances.map((i: { id: string }) => i.id)).toEqual(item.selectedAgents);
    expect(item.agentInstances.every((i: { id: string; cliTool: string }) => i.id === i.cliTool)).toBe(true);
  });

  it('should include branch for each worktree (Issue #1003)', async () => {
    upsertWorktree(db, {
      id: 'feature-branch',
      name: 'feature/branch',
      path: '/path/to/feature-branch',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      branch: 'feature/branch',
    });

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);

    const data = await response.json();
    const item = data.worktrees.find((w: { id: string }) => w.id === 'feature-branch');
    expect(item).toBeDefined();
    expect(item.branch).toBe('feature/branch');
  });

  it('should return 500 on database error', async () => {
    // Close database to simulate error
    db.close();

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});

describe('GET /api/worktrees/:id', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return worktree by id', async () => {
    const worktree: Worktree = {
      id: 'feature-foo',
      name: 'feature/foo',
      path: '/path/to/feature-foo',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
    };

    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees/feature-foo');
    const params = { params: Promise.resolve({ id: 'feature-foo' }) };
    const response = await getWorktreeById(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe('feature-foo');
    expect(data.name).toBe('feature/foo');
    expect(data.path).toBe('/path/to/feature-foo');
  });

  it('should include branch in response (Issue #1003)', async () => {
    upsertWorktree(db, {
      id: 'feature-foo',
      name: 'feature/foo',
      path: '/path/to/feature-foo',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      branch: 'feature/foo',
    });

    const request = new Request('http://localhost:3000/api/worktrees/feature-foo');
    const params = { params: Promise.resolve({ id: 'feature-foo' }) };
    const response = await getWorktreeById(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.branch).toBe('feature/foo');
  });

  it('should return 404 when worktree not found', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/nonexistent');
    const params = { params: Promise.resolve({ id: 'nonexistent' }) };
    const response = await getWorktreeById(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('not found');
  });

  it('should return 500 on database error', async () => {
    db.close();

    const request = new Request('http://localhost:3000/api/worktrees/test');
    const params = { params: Promise.resolve({ id: 'test' }) };
    const response = await getWorktreeById(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});

describe('PATCH /api/worktrees/:id', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    upsertWorktree(db, {
      id: 'feature-foo',
      name: 'feature/foo',
      path: '/path/to/feature-foo',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    });
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return 400 when request body is not a JSON object', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/feature-foo', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['not-an-object']),
    });

    const response = await patchWorktreeById(
      request as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: 'feature-foo' }) }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('JSON object');
  });

  it('should return 400 for invalid cliToolId', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/feature-foo', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliToolId: 'invalid-tool' }),
    });

    const response = await patchWorktreeById(
      request as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: 'feature-foo' }) }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Invalid cliToolId');
  });

  it('should enforce selectedAgents consistency against the updated cliToolId', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/feature-foo', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliToolId: 'codex',
        selectedAgents: ['gemini', 'claude'],
      }),
    });

    const response = await patchWorktreeById(
      request as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: 'feature-foo' }) }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.cliToolId).toBe('gemini');
    expect(data.selectedAgents).toEqual(['gemini', 'claude']);
    expect(data.cliToolIdAutoUpdated).toBe(true);
  });
});

/**
 * `GET /api/worktrees` carries the CONFIGURED default (Issue #2065).
 *
 * This is the only supply of the default agent list to `/review`, whose
 * `fetchWorktrees()` reads `data.defaultSelectedAgents` and seeds the client
 * store from it. Nothing else on that screen would notice if the field went
 * back to a hardcoded constant, so the wiring has to be pinned somewhere — and
 * "empty DB returns the constant" cannot do it, because a hardcoded
 * implementation returns exactly that.
 *
 * So every case here stores a value that DIFFERS from
 * `DEFAULT_SELECTED_AGENTS` in both membership and order.
 */
describe('GET /api/worktrees defaultSelectedAgents (Issue #2065)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  function get(query = ''): Promise<Response> {
    const request = new Request(`http://localhost:3000/api/worktrees${query}`);
    return getWorktrees(
      request as unknown as import('next/server').NextRequest
    ) as unknown as Promise<Response>;
  }

  it('returns the stored setting, not the compiled-in constant', async () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);

    const data = await (await get()).json();

    expect(data.defaultSelectedAgents).toEqual(['codex', 'claude']);
    // The whole point: it is NOT the constant. A hardcoded field passes the
    // empty-DB case above and fails right here.
    expect(data.defaultSelectedAgents).not.toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('preserves the stored order, so [0] is the primary the UI opens first', async () => {
    setDefaultSelectedAgents(db, ['gemini', 'copilot', 'claude']);

    const data = await (await get()).json();

    expect(data.defaultSelectedAgents).toEqual(['gemini', 'copilot', 'claude']);
    expect(data.defaultSelectedAgents[0]).toBe('gemini');
  });

  it('reflects a change to the setting on the next request, with no restart', async () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);
    expect((await (await get()).json()).defaultSelectedAgents).toEqual(['codex', 'claude']);

    setDefaultSelectedAgents(db, ['opencode', 'gemini']);
    expect((await (await get()).json()).defaultSelectedAgents).toEqual(['opencode', 'gemini']);
  });

  /**
   * `/review` calls `?include=review`; the sidebar cache calls with no query;
   * `?includeStatus=0` is #2060's opt-out. The field is unconditional, so all
   * three must carry it — a version that only built it on one branch would
   * leave `/review` on the constant, which is the exact regression this suite
   * exists to catch.
   */
  it('carries the setting on every query shape a client actually sends', async () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);

    for (const query of ['', '?include=review', '?includeStatus=0']) {
      const data = await (await get(query)).json();
      expect(data.defaultSelectedAgents, `query=${query || '(none)'}`).toEqual([
        'codex',
        'claude',
      ]);
    }
  });

  /**
   * The setting is a fallback for worktrees that have not chosen, not an
   * override. The row's own `selectedAgents` must still win.
   */
  it('does not override a worktree that chose its own agents', async () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);
    upsertWorktree(db, {
      id: 'feature-own',
      name: 'feature/own',
      path: '/tmp/feature-own',
      repositoryPath: '/tmp/repo',
      repositoryName: 'repo',
    } as Worktree);
    db.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?').run(
      JSON.stringify(['gemini', 'copilot']),
      'feature-own'
    );

    const data = await (await get()).json();

    expect(data.defaultSelectedAgents).toEqual(['codex', 'claude']);
    expect(data.worktrees[0].selectedAgents).toEqual(['gemini', 'copilot']);
  });

  /**
   * The acceptance criterion, through the API a client actually calls: a
   * worktree that a sync just discovered (no `selected_agents`, no
   * `agent_instances`) gets the configured order and the configured primary.
   */
  it('gives a freshly discovered worktree the configured order and primary', async () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);
    upsertWorktree(db, {
      id: 'feature-synced',
      name: 'feature/synced',
      path: '/tmp/feature-synced',
      repositoryPath: '/tmp/repo',
      repositoryName: 'repo',
    } as Worktree);

    const row = (await (await get()).json()).worktrees[0];

    expect(row.selectedAgents).toEqual(['codex', 'claude']);
    expect(row.agentInstances.map((i: { cliTool: string }) => i.cliTool)).toEqual([
      'codex',
      'claude',
    ]);
    expect(row.agentInstances[0].id).toBe('codex');
  });
});
