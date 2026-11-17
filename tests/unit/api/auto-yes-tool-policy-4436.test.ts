/**
 * Issue #4436: arming Auto-Yes on an antigravity instance is refused under the
 * default usage declaration (`personal`): 409 `{ code: TOOL_POLICY_DENIED,
 * error, reason, links }`, no grant written, no poller started, the session not
 * looked at. With `CM_ANTIGRAVITY_USAGE=api-key|enterprise`, and for every other
 * tool, the route answers as before. Turning Auto-Yes OFF is never refused.
 *
 * Real SQLite (in memory) and real Auto-Yes state; the poller entry points are
 * spied so no poller runs and nothing is typed (harness from
 * `auto-yes-duration-3913.test.ts`).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import type { Worktree } from '@/types/models';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import {
  ANTIGRAVITY_CONSUMER_TERMS,
  ANTIGRAVITY_FAQ_URL,
  ANTIGRAVITY_TERMS_URL,
  TOOL_POLICY_DENIED,
  TOOL_POLICY_DENIED_MESSAGE,
  USAGE_DECLARATION_ENV,
} from '@/lib/tool-policy/policy';

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
      mockDb?.close();
      mockDb = null;
    },
  };
});

vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return { ...actual, listSessions: vi.fn(async () => []), hasSession: vi.fn(async () => false) };
});

const checkSessionOwnership = vi.fn();
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>();
  return { ...actual, checkSessionOwnership: (...args: unknown[]) => checkSessionOwnership(...args) };
});

vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>();
  return {
    ...actual,
    startAutoYesPolling: vi.fn(() => ({ started: true })),
    stopAutoYesPolling: vi.fn(),
    stopAutoYesPollingByWorktree: vi.fn(),
  };
});

const recheckPendingDecisions = vi.fn(async () => ({ examined: 0, delivered: 0, skipped: 0, reason: 'no-pending' }));
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: () => recheckPendingDecisions(),
}));

import { POST } from '@/app/api/worktrees/[id]/auto-yes/route';
import { startAutoYesPolling, stopAutoYesPolling } from '@/lib/polling/auto-yes-manager';
import { clearAllAutoYesStates, getAutoYesState, resetAutoYesShutdownForTesting, setAutoYesEnabled } from '@/lib/auto-yes-state';

const WT = 'wt-4436-route';

function post(body: unknown): Promise<Response> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/auto-yes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: WT }) }) as Promise<Response>;
}

const savedDeclaration = process.env[USAGE_DECLARATION_ENV];
function declare(value: string | undefined): void {
  if (value === undefined) delete process.env[USAGE_DECLARATION_ENV];
  else process.env[USAGE_DECLARATION_ENV] = value;
}

beforeEach(async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: WT,
    path: `/tmp/${WT}`,
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    cliToolId: 'claude',
  } as Worktree);
  setAgentInstances(
    db,
    WT,
    CLI_TOOL_IDS.map((tool, order) => ({ id: tool, cliTool: tool, alias: '', order }))
  );
  clearAllAutoYesStates();
  resetAutoYesShutdownForTesting();
  vi.clearAllMocks();
  checkSessionOwnership.mockResolvedValue({ verdict: 'absent', sessionPath: null });
  declare(undefined);
});

afterEach(async () => {
  clearAllAutoYesStates();
  resetAutoYesShutdownForTesting();
  declare(savedDeclaration);
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
});

describe('Issue #4436: POST auto-yes {enabled: true} under the tool policy', () => {
  const DECLARATIONS: Array<[string, string | undefined, boolean]> = [
    ['unset (personal)', undefined, false],
    ['personal', 'personal', false],
    ['api-key', 'api-key', true],
    ['enterprise', 'enterprise', true],
  ];

  for (const tool of CLI_TOOL_IDS) {
    for (const [label, value, unlocks] of DECLARATIONS) {
      const arms = tool !== 'antigravity' || unlocks;
      it(`4436 I1/I2/I3: enabling ${tool} with the declaration ${label} ${arms ? 'arms once' : 'is refused (409, nothing armed)'}`, async () => {
        declare(value);
        const response = await post({ enabled: true, cliToolId: tool, instanceId: tool });
        const body = await response.json();

        if (arms) {
          expect(response.status).toBe(200);
          expect(body).toMatchObject({ enabled: true, cliToolId: tool, instanceId: tool });
          expect(startAutoYesPolling).toHaveBeenCalledTimes(1);
          expect(getAutoYesState(WT, tool, tool)?.enabled).toBe(true);
        } else {
          expect(response.status).toBe(409);
          expect(body).toEqual({
            code: TOOL_POLICY_DENIED,
            error: TOOL_POLICY_DENIED_MESSAGE,
            reason: ANTIGRAVITY_CONSUMER_TERMS,
            links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
            cliToolId: tool,
            instanceId: tool,
          });
          expect(startAutoYesPolling).not.toHaveBeenCalled();
          expect(checkSessionOwnership).not.toHaveBeenCalled();
          expect(recheckPendingDecisions).not.toHaveBeenCalled();
          expect(getAutoYesState(WT, tool, tool)).toBeNull();
        }
      });
    }
  }

  it('4436 I1: an instance resolved through the roster (no cliToolId in the body) is judged by its tool', async () => {
    const response = await post({ enabled: true, instanceId: 'antigravity' });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(TOOL_POLICY_DENIED);
    expect(startAutoYesPolling).not.toHaveBeenCalled();
  });

  it('4436 I1: a refused enable leaves an existing grant on another instance untouched', async () => {
    setAutoYesEnabled(WT, 'claude', true, 3_600_000, undefined, 'claude');
    const before = getAutoYesState(WT, 'claude', 'claude');
    const response = await post({ enabled: true, cliToolId: 'antigravity', instanceId: 'antigravity' });
    expect(response.status).toBe(409);
    expect(getAutoYesState(WT, 'claude', 'claude')).toEqual(before);
  });

  it('4436: turning Auto-Yes OFF on antigravity is never refused', async () => {
    const response = await post({ enabled: false, cliToolId: 'antigravity', instanceId: 'antigravity' });
    expect(response.status).toBe(200);
    expect(stopAutoYesPolling).toHaveBeenCalledTimes(1);
  });

  it('4436 I6: removing the declaration refuses the next enable', async () => {
    declare('enterprise');
    expect((await post({ enabled: true, cliToolId: 'antigravity', instanceId: 'antigravity' })).status).toBe(200);
    await post({ enabled: false, cliToolId: 'antigravity', instanceId: 'antigravity' });

    declare(undefined);
    expect((await post({ enabled: true, cliToolId: 'antigravity', instanceId: 'antigravity' })).status).toBe(409);
    expect(startAutoYesPolling).toHaveBeenCalledTimes(1);
  });
});
