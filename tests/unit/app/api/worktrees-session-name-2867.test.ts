/**
 * The server publishes the tmux session names the CLI can no longer compute
 * (Issue #2867).
 *
 * Since #2866 a session is `mcbd-{ns}-{cli}-{worktreeId}[-{suffix}]`, and the
 * ns lives in the server's DB. So:
 *
 *   - `GET /api/worktrees` carries `tmuxSessionNamespace` ONCE, at the top level
 *     (the sidebar polls this route; per-row copies of one value would be waste);
 *   - `GET /api/worktrees/[id]` carries each roster entry's `sessionName`, the
 *     name actually in use — an adopted legacy name included.
 *
 * Real SQLite and the real naming module; only tmux and git are stubbed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { setActiveSessionNamespace } from '@/lib/cli-tools/session-name';
import { clearLegacyAliasesForTests, registerLegacyAlias } from '@/lib/tmux/legacy-session-alias';

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
  };
});

vi.mock('@/lib/tmux/tmux', () => ({
  listSessions: vi.fn(async () => [] as Array<{ name: string }>),
}));

vi.mock('@/lib/git/git-utils', () => ({
  getGitStatus: vi.fn(async () => undefined),
}));

const WT_ID = 'wt-2867';
const NS = '0a1b2c3d';

let db: Database.Database;

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, {
    id: WT_ID,
    name: 'feature/2867',
    path: '/nonexistent-2867/wt',
    repositoryPath: '/nonexistent-2867',
    repositoryName: 'fixture',
  });
  setAgentInstances(db, WT_ID, [
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    { id: 'codex-2', cliTool: 'codex', alias: 'Reviewer', order: 1 },
  ]);
});

afterEach(() => {
  setActiveSessionNamespace(null);
  clearLegacyAliasesForTests();
  db.close();
  vi.clearAllMocks();
});

async function getList(): Promise<Record<string, unknown>> {
  const { GET } = await import('@/app/api/worktrees/route');
  const res = await GET(new NextRequest(new Request('http://localhost/api/worktrees')));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function getDetail(): Promise<{ agentInstances: Array<{ id: string; sessionName?: string }> }> {
  const { GET } = await import('@/app/api/worktrees/[id]/route');
  const res = await GET(new NextRequest(new Request(`http://localhost/api/worktrees/${WT_ID}`)), {
    params: Promise.resolve({ id: WT_ID }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { agentInstances: Array<{ id: string; sessionName?: string }> };
}

describe('GET /api/worktrees — tmuxSessionNamespace', () => {
  it('is the server namespace, at the top level only', async () => {
    setActiveSessionNamespace(NS);

    const body = await getList();

    expect(body.tmuxSessionNamespace).toBe(NS);
    for (const row of body.worktrees as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('tmuxSessionNamespace');
    }
  });

  it('is null when the namespace is not initialized (legacy names)', async () => {
    const body = await getList();
    expect(body).toHaveProperty('tmuxSessionNamespace', null);
  });

  it('rides along with ?includeStatus=0 too', async () => {
    setActiveSessionNamespace(NS);
    const { GET } = await import('@/app/api/worktrees/route');
    const res = await GET(new NextRequest(new Request('http://localhost/api/worktrees?includeStatus=0')));
    expect((await res.json()).tmuxSessionNamespace).toBe(NS);
  });
});

describe('GET /api/worktrees/[id] — agentInstances[].sessionName', () => {
  it('names each instance in the namespaced form', async () => {
    setActiveSessionNamespace(NS);

    const { agentInstances } = await getDetail();

    expect(agentInstances.map(({ id, sessionName }) => ({ id, sessionName }))).toEqual([
      { id: 'claude', sessionName: `mcbd-${NS}-claude-${WT_ID}` },
      { id: 'codex-2', sessionName: `mcbd-${NS}-codex-${WT_ID}-2` },
    ]);
  });

  it('names an adopted legacy session by its legacy name', async () => {
    setActiveSessionNamespace(NS);
    registerLegacyAlias(`mcbd-${NS}-codex-${WT_ID}-2`, `mcbd-codex-${WT_ID}-2`);

    const { agentInstances } = await getDetail();

    expect(agentInstances.find((inst) => inst.id === 'codex-2')?.sessionName).toBe(
      `mcbd-codex-${WT_ID}-2`
    );
    expect(agentInstances.find((inst) => inst.id === 'claude')?.sessionName).toBe(
      `mcbd-${NS}-claude-${WT_ID}`
    );
  });

  it('names the legacy form when the namespace is not initialized', async () => {
    const { agentInstances } = await getDetail();

    expect(agentInstances.map((inst) => inst.sessionName)).toEqual([
      `mcbd-claude-${WT_ID}`,
      `mcbd-codex-${WT_ID}-2`,
    ]);
  });
});
