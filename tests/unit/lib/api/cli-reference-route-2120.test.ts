/**
 * GET /api/worktrees/:id/cli-reference (Issue #2120).
 *
 * The browser cannot read `CM_LAUNCHED_BY` — Next.js inlines only
 * `NEXT_PUBLIC_*` into the client bundle — so a roster pane that decided the
 * binary name for itself would print `commandmate` on every development machine
 * where the command on PATH is `commandmatedev`. This route is the server
 * answering that question, and the port question beside it.
 *
 * What is pinned here is the route's own contribution: the worktree scope, and
 * that both answers follow the process environment rather than a literal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

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
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

import { GET } from '@/app/api/worktrees/[id]/cli-reference/route';

const WORKTREE_ID = 'wt-cliref';

/** `x-real-ip`, which is what server.ts sets from the socket (see #1925's route test). */
function call(worktreeId: string, ip = '10.0.0.7') {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${worktreeId}/cli-reference`,
    { headers: { 'x-real-ip': ip } }
  );
  return GET(request, { params: Promise.resolve({ id: worktreeId }) });
}

describe('[#2120] GET /api/worktrees/:id/cli-reference', () => {
  let db: Database.Database;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'CliRef',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'codex',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it('answers `commandmate` when the installed CLI started this server', async () => {
    vi.stubEnv('CM_LAUNCHED_BY', 'commandmate-cli');
    const response = await call(WORKTREE_ID);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      binary: 'commandmate',
      worktreeId: WORKTREE_ID,
    });
  });

  it('answers `commandmatedev` for a checkout', async () => {
    vi.stubEnv('CM_LAUNCHED_BY', '');
    const response = await call(WORKTREE_ID);
    await expect(response.json()).resolves.toMatchObject({ binary: 'commandmatedev' });
  });

  it('asks for no CM_PORT prefix on the default port', async () => {
    vi.stubEnv('CM_PORT', '3000');
    const response = await call(WORKTREE_ID);
    await expect(response.json()).resolves.toMatchObject({ portPrefix: null });
  });

  it('names the port when this server is a parallel one', async () => {
    // `commandmate start --issue N --auto-port`. The four targeting commands
    // define no `--port` flag, so the prefix is the only way a pasted line can
    // reach this server rather than the one on 3000.
    vi.stubEnv('CM_PORT', '3135');
    const response = await call(WORKTREE_ID);
    await expect(response.json()).resolves.toMatchObject({ portPrefix: 3135 });
  });

  it('404s for a worktree this server does not have', async () => {
    const response = await call('wt-absent');
    expect(response.status).toBe(404);
  });

  it('400s on an id that is not a worktree id at all', async () => {
    const response = await call('../etc');
    expect(response.status).toBe(400);
  });
});
