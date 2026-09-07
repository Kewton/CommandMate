/**
 * GET /api/worktrees/:id/resolve-target (Issue #1925).
 *
 * The server-side half of "one resolver": this is where the CLI asks instead of
 * carrying its own copy of the precedence rules (design §4 D5 決定 1). The
 * resolution itself is pinned in tests/unit/session/resolve-session-target.test.ts;
 * what is pinned here is what the route adds on top of it — the worktree scope
 * that stops one worktree's request from resolving against another's roster
 * (S6), the rate limit that `capabilities` deliberately does without (S20), and
 * the 200-with-conflict shape that keeps polling readers alive (DR3-015).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
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

import { GET } from '@/app/api/worktrees/[id]/resolve-target/route';

const WORKTREE_ID = 'wt-target';

/**
 * `x-real-ip` rather than `x-forwarded-for`: getClientIp only trusts the latter
 * when CM_TRUST_PROXY is on, and server.ts sets the former from the socket. A
 * test that sends the wrong one buckets every request under "unknown" and then
 * fails to explain why the limiter fired early.
 */
function request(worktreeId: string, query = '', ip = '10.0.0.1'): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/worktrees/${worktreeId}/resolve-target${query}`,
    { headers: { 'x-real-ip': ip } }
  );
}

function call(worktreeId: string, query = '', ip?: string) {
  return GET(request(worktreeId, query, ip), { params: Promise.resolve({ id: worktreeId }) });
}

describe('GET /api/worktrees/:id/resolve-target', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Target',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'gemini',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
    ]);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it('answers the resolved target with the stage that produced it', async () => {
    const response = await call(WORKTREE_ID, '?instance=codex');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cliToolId: 'codex',
      instanceId: 'codex',
      resolvedBy: 'roster',
      conflict: null,
    });
  });

  it("answers the worktree's own agent when nothing is targeted", async () => {
    const response = await call(WORKTREE_ID);
    await expect(response.json()).resolves.toMatchObject({
      cliToolId: 'gemini',
      resolvedBy: 'worktree-default',
    });
  });

  /**
   * DR3-015. `.claude/skills/orchestrate-monitor/scripts/monitor.sh` skips the
   * poll and never advances its idle streak when capture exits non-zero, with
   * MAX_POLLS=0 as the operator default — so answering 400 to a reader would
   * turn one mislabelled worker into a silent infinite loop. The contradiction
   * rides along in the payload instead; refusing it is the caller's job when
   * the caller is about to change something.
   */
  it('answers 200 with the roster verdict and the contradiction attached', async () => {
    const response = await call(WORKTREE_ID, '?instance=codex&cliTool=claude');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cliToolId: 'codex',
      instanceId: 'codex',
      resolvedBy: 'roster',
      conflict: { instanceId: 'codex', rosterCliTool: 'codex', requestedCliTool: 'claude' },
    });
  });

  /**
   * S6. The roster read is scoped to the worktree in the URL, so a request for
   * a worktree that is not there cannot reach anyone's roster at all.
   */
  it('404s for a worktree it does not have, rather than resolving anyway', async () => {
    const response = await call('wt-elsewhere', '?instance=codex');
    expect(response.status).toBe(404);
  });

  it('does not borrow another worktree\'s roster entry', async () => {
    const other: Worktree = {
      id: 'wt-neighbour',
      name: 'Neighbour',
      path: '/path/to/other',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, other);
    setAgentInstances(db, 'wt-neighbour', [
      { id: 'worker-b', cliTool: 'copilot', alias: 'Worker B', order: 0 },
    ]);

    const response = await call(WORKTREE_ID, '?instance=worker-b');
    await expect(response.json()).resolves.toMatchObject({
      cliToolId: 'gemini',
      resolvedBy: 'worktree-default',
    });
  });

  /**
   * Issue #2376 widened `?instance=` from "an instance id" to "an instance id
   * or an alias", and an alias is free text — `not an id` is a perfectly
   * possible one. So the 400 now covers only what NO alias can be: something
   * longer than the alias field allows, or carrying control characters.
   * A free-text value that matches nothing resolves to nothing, exactly as an
   * unknown instance id always has.
   */
  it('rejects an instance selector no alias could be', async () => {
    const tooLong = await call(WORKTREE_ID, `?instance=${'x%20'.repeat(30)}`);
    expect(tooLong.status).toBe(400);

    const controlChar = await call(WORKTREE_ID, '?instance=bad%01value');
    expect(controlChar.status).toBe(400);
  });

  it('resolves a free-text selector that matches no row to the worktree default', async () => {
    const response = await call(WORKTREE_ID, '?instance=not%20an%20id');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cliToolId: 'gemini',
      resolvedBy: 'worktree-default',
    });
  });

  it('rejects a cliTool that is not a known agent', async () => {
    const response = await call(WORKTREE_ID, '?cliTool=not-a-tool');
    expect(response.status).toBe(400);
  });

  /**
   * S20 / DR4-015. Unlike `capabilities`, every call here reads the worktree row
   * and the roster, so the route carries a per-IP budget. The limit is 240/min;
   * this drains it and checks the 241st is refused with a Retry-After the caller
   * can act on.
   */
  it('rate limits per IP once the budget is spent', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 240; i++) {
      const ok = await call(WORKTREE_ID, '', ip);
      expect(ok.status, `request ${i + 1}`).toBe(200);
    }
    const limited = await call(WORKTREE_ID, '', ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);

    // Per IP, not global: a second caller is unaffected by the first's spending.
    const other = await call(WORKTREE_ID, '', '10.9.9.10');
    expect(other.status).toBe(200);
  });
});

/**
 * `?instance=` as an ALIAS (Issue #2376).
 *
 * The stage is LAST in the chain, and these tests are mostly about that: every
 * request that resolved before this Issue must resolve to the same answer, so
 * what is pinned is where the alias lookup does NOT run as much as where it
 * does.
 */
describe('GET /api/worktrees/:id/resolve-target — alias selectors (Issue #2376)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Target',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'gemini',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
      { id: 'codex-3', cliTool: 'codex', alias: 'レビュー担当', order: 2 },
    ]);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it('resolves an alias to its instance id', async () => {
    const response = await call(WORKTREE_ID, '?instance=Codex%202');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cliToolId: 'codex',
      instanceId: 'codex-2',
      resolvedBy: 'roster',
    });
  });

  it('resolves a non-ASCII alias', async () => {
    const response = await call(WORKTREE_ID, `?instance=${encodeURIComponent('レビュー担当')}`);
    await expect(response.json()).resolves.toMatchObject({ instanceId: 'codex-3' });
  });

  it('matches an alias case-insensitively when nothing matches exactly', async () => {
    const response = await call(WORKTREE_ID, '?instance=codex%202');
    await expect(response.json()).resolves.toMatchObject({ instanceId: 'codex-2' });
  });

  /**
   * The additive property, stated as a rule rather than as an example: an id
   * that a roster row carries is that row, whatever anybody's alias says.
   */
  it('lets a roster id win over an identical alias', async () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      // This row's ALIAS is another row's ID.
      { id: 'codex-2', cliTool: 'codex', alias: 'claude', order: 1 },
    ]);

    const response = await call(WORKTREE_ID, '?instance=claude');
    await expect(response.json()).resolves.toMatchObject({
      cliToolId: 'claude',
      instanceId: 'claude',
    });
  });

  /**
   * The primary anchor (#868) sits between the roster and the alias: bare
   * `--instance codex` has meant "codex's primary instance" since before
   * aliases were selectable, with or without a roster row.
   */
  it('lets the primary anchor win over an alias', async () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'gemini-2', cliTool: 'gemini', alias: 'codex', order: 1 },
    ]);

    const response = await call(WORKTREE_ID, '?instance=codex');
    await expect(response.json()).resolves.toMatchObject({
      cliToolId: 'codex',
      instanceId: 'codex',
      resolvedBy: 'primary',
    });
  });

  it('409s with every candidate when two rows answer to one alias', async () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Reviewer', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Reviewer', order: 1 },
    ]);

    const response = await call(WORKTREE_ID, '?instance=Reviewer');
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('ambiguous_instance_alias');
    expect(body.issues).toHaveLength(2);
    expect(body.issues.join('\n')).toContain('codex-2');
  });

  it('does not resolve an alias across worktrees', async () => {
    const other: Worktree = {
      id: 'wt-neighbour',
      name: 'Neighbour',
      path: '/path/to/other',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, other);
    setAgentInstances(db, 'wt-neighbour', [
      { id: 'copilot-2', cliTool: 'copilot', alias: 'Neighbour Bot', order: 0 },
    ]);

    const response = await call(WORKTREE_ID, '?instance=Neighbour%20Bot');
    await expect(response.json()).resolves.toMatchObject({
      cliToolId: 'gemini',
      resolvedBy: 'worktree-default',
    });
  });
});
