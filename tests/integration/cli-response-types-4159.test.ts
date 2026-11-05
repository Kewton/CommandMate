/**
 * Issue #4159: the CLI's types are a hand-kept copy of what the routes answer. `grantId` and
 * `rosterRevision` were read through casts because the copy did not have them, so nothing
 * noticed if either side moved. These hold the copy against the real routes:
 *
 *  - renaming a field in the type stops this file compiling (`npx tsc --noEmit`);
 *  - renaming it in the route fails the reads below;
 *  - a field the route starts answering on an enable, not in the type, fails the key check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { computeRosterRevision } from '@/lib/agent-roles/management';
import { clearAllAutoYesStates } from '@/lib/auto-yes-state';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import type { AutoYesSetResult, WorktreeDetailResponse } from '@/cli/types/api-responses';
import { fetchAgentRoster } from '@/cli/utils/agent-instances';
import type { ApiClient } from '@/cli/utils/api-client';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/ws-server', () => ({ broadcast: vi.fn(), broadcastMessage: vi.fn(), cleanupRooms: vi.fn() }));
vi.mock('@/lib/session-cleanup', () => ({
  cleanupMultipleWorktrees: vi.fn(async () => ({ results: [], warnings: [] })),
  createOwnedSessionKiller: vi.fn(() => vi.fn(async () => false)),
}));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'absent' })),
}));
vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>()),
  startAutoYesPolling: vi.fn(() => ({ started: true })),
  stopAutoYesPolling: vi.fn(),
  stopAutoYesPollingByWorktree: vi.fn(),
}));
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ reason: 'none', examined: 0, delivered: 0, skipped: 0 })),
}));
vi.mock('@/lib/tmux/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux')>()),
  listSessions: vi.fn(async () => []),
}));

import * as autoYesRoute from '@/app/api/worktrees/[id]/auto-yes/route';
import * as worktreeRoute from '@/app/api/worktrees/[id]/route';

const WT = 'wt-4159';
const wt = { params: Promise.resolve({ id: WT }) };
const AUTO_YES = `http://localhost:3000/api/worktrees/${WT}/auto-yes`;
const CODEX: AgentInstance = { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 };

/** Every key of the type, so a key added to it has to be added here, and the other way about. */
const AUTO_YES_KEYS: Record<keyof AutoYesSetResult, true> = {
  enabled: true,
  expiresAt: true,
  answerMode: true,
  grantId: true,
  pollingStarted: true,
  pendingDecisions: true,
  cliToolId: true,
  instanceId: true,
  resolvedBy: true,
  conflict: true,
  contractPolicy: true,
};
const GRANT_FIELD: keyof AutoYesSetResult = 'grantId';
const REVISION_FIELD: keyof WorktreeDetailResponse = 'rosterRevision';

const arm = async (): Promise<Record<string, unknown>> =>
  (
    await autoYesRoute.POST(
      new NextRequest(AUTO_YES, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, duration: 3600000, cliToolId: 'codex', instanceId: 'codex' }),
      }),
      wt,
    )
  ).json();

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, { id: WT, name: WT, path: '/tmp/wt-4159', repositoryPath: '/tmp', repositoryName: 'r' } as Worktree);
  setAgentInstances(db, WT, [CODEX]);
  clearAllAutoYesStates();
});

afterEach(() => {
  clearAllAutoYesStates();
  db.close();
  vi.restoreAllMocks();
});

describe('[#4159] the CLI types against the real routes', () => {
  it('POST auto-yes: an enable answers nothing the type does not have, and names its grant', async () => {
    const answer = await arm();
    expect(Object.keys(answer).filter((key) => !(key in AUTO_YES_KEYS))).toEqual([]);
    expect(typeof answer[GRANT_FIELD]).toBe('string');
  });

  it('GET auto-yes: the read names the same grant, under the same field', async () => {
    const armed = await arm();
    const read = (await (
      await autoYesRoute.GET(new NextRequest(`${AUTO_YES}?cliToolId=codex&instanceId=codex`), wt)
    ).json()) as AutoYesSetResult;
    expect(read.grantId).toBe(armed[GRANT_FIELD]);
  });

  it('GET worktree: the roster revision, and fetchAgentRoster reads it through the type', async () => {
    const answer = (await (
      await worktreeRoute.GET(new NextRequest(`http://localhost:3000/api/worktrees/${WT}`), wt)
    ).json()) as Record<string, unknown>;
    expect(answer[REVISION_FIELD]).toBe(computeRosterRevision([CODEX]));

    const client = { get: async () => answer } as unknown as ApiClient;
    await expect(fetchAgentRoster(client, WT)).resolves.toMatchObject({ revision: computeRosterRevision([CODEX]) });
  });

  it('an older server, with no revision: none is read, and the roster still is', async () => {
    const client = { get: async () => ({ id: WT, agentInstances: [CODEX] }) } as unknown as ApiClient;
    const snapshot = await fetchAgentRoster(client, WT);
    expect(snapshot.instances).toEqual([CODEX]);
    expect(snapshot).not.toHaveProperty('revision');
  });

  it('a revision of another type is not taken for one', async () => {
    const client = { get: async () => ({ id: WT, agentInstances: [CODEX], rosterRevision: 7 }) } as unknown as ApiClient;
    expect(await fetchAgentRoster(client, WT)).not.toHaveProperty('revision');
  });
});
