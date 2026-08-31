/**
 * `GET /api/worktrees` is where the leak would have been observable, so it is
 * where the fix is pinned (Issue #2066, integration review H1).
 *
 * The suite in `tests/unit/db/repo-agents-yaml-2066.test.ts` asserts the same
 * rule one level down, on `getWorktrees()`. This one exists because the claim
 * the review made — and the claim the user guide makes — is about the payload
 * `/sessions` and the Review tab actually receive, and those two read
 * `row.selectedAgents` and never look at `row.agentInstances`. Between
 * `getWorktrees()` and the response body sits the route's compose phase, and
 * only a test at this level covers it.
 *
 * `?includeStatus=0` (Issue #2060) keeps the request off tmux entirely: with it
 * the route does the DB read, the roster resolution and the compose, which is
 * exactly the part under test.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '../../../helpers/temp-dir';

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => holder.db),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

/**
 * Spread the real module and stub only `listSessions`. `?includeStatus=0` never
 * calls it, so this is a guard rather than a fixture: a regression that started
 * probing tmux on the opted-out path would reach the user's real tmux server
 * from a unit test, and this makes that impossible without changing the mock.
 */
vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return { ...actual, listSessions: vi.fn(async () => []) };
});

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/worktrees/route';
import { runMigrations } from '@/lib/db/db-migrations';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { setDefaultSelectedAgents } from '@/lib/db/app-settings-db';
import {
  clearRepoAgentsConfigCache,
  REPO_AGENTS_CONFIG_RELATIVE_PATH,
} from '@/lib/repo-config/agents-config';

const WITH_ROSTER = 'wt-with-roster';
const WITHOUT_ROSTER = 'wt-without-roster';

let db: Database.Database;
let repo: string;

function seedWorktree(id: string): void {
  db.prepare(`
    INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, id, join(repo, id), repo, 'repo', 1700000000000);
}

async function listed(): Promise<Map<string, string[]>> {
  const response = await GET(
    new NextRequest(new Request('http://localhost/api/worktrees?includeStatus=0'))
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  return new Map(
    (body.worktrees as Array<{ id: string; selectedAgents: string[] }>).map((w) => [
      w.id,
      w.selectedAgents,
    ])
  );
}

describe('GET /api/worktrees and .commandmate/agents.yaml (Issue #2066 H1)', () => {
  beforeEach(() => {
    repo = makeTempDir('repo-agents-route-2066-');
    mkdirSync(join(repo, '.commandmate'), { recursive: true });
    writeFileSync(
      join(repo, REPO_AGENTS_CONFIG_RELATIVE_PATH),
      'agents: [gemini, opencode]\n',
      'utf8'
    );
    clearRepoAgentsConfigCache();

    db = new Database(':memory:');
    runMigrations(db);
    holder.db = db;

    seedWorktree(WITH_ROSTER);
    seedWorktree(WITHOUT_ROSTER);
    // The state `PATCH /api/worktrees/[id]` leaves when the operator edits the
    // roster in AgentInstancesPane: `agent_instances` rows written through the
    // `agentInstances` branch, `selected_agents` untouched and still NULL.
    setAgentInstances(db, WITH_ROSTER, [
      { id: 'codex', cliTool: 'codex', alias: '', order: 0 },
    ]);
    setDefaultSelectedAgents(db, ['codex', 'claude']);
  });

  afterEach(() => {
    db.close();
    removeTempDir(repo);
  });

  it('does not move selectedAgents for a worktree that already has agent_instances', async () => {
    const agents = await listed();

    expect(agents.get(WITH_ROSTER)).toEqual(['codex', 'claude']);
    // Same repository, same response, no roster: the declaration does apply.
    expect(agents.get(WITHOUT_ROSTER)).toEqual(['gemini', 'opencode']);
  });

  /**
   * The regression stated the way /sessions renders it: the agent this worktree
   * is actually running has to stay in the list the chips are built from, and
   * the declared agents must not appear in it.
   */
  it('keeps the running agent listed and the declared ones out', async () => {
    const agents = await listed();

    expect(agents.get(WITH_ROSTER)).toContain('codex');
    expect(agents.get(WITH_ROSTER)).not.toContain('gemini');
    expect(agents.get(WITH_ROSTER)).not.toContain('opencode');
  });

  /**
   * `agentInstances` is the other channel and must be unaffected by the
   * withholding — asserted here so a fix that "solved" the leak by emptying the
   * roster instead would be caught.
   */
  it('still reports the stored roster on agentInstances', async () => {
    const response = await GET(
      new NextRequest(new Request('http://localhost/api/worktrees?includeStatus=0'))
    );
    const body = await response.json();
    const rows = body.worktrees as Array<{ id: string; agentInstances: Array<{ cliTool: string }> }>;

    expect(rows.find((w) => w.id === WITH_ROSTER)?.agentInstances.map((i) => i.cliTool))
      .toEqual(['codex']);
    expect(rows.find((w) => w.id === WITHOUT_ROSTER)?.agentInstances.map((i) => i.cliTool))
      .toEqual(['gemini', 'opencode']);
  });
});
