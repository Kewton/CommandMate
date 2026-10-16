/**
 * A contract that says `autoYes.mode: 'off'` is visible where Auto-Yes is armed
 * and listed (Issue #3723).
 *
 * Before: arming answered `enabled: true`, `GET /api/worktrees` listed the
 * instance with a countdown, and the only trace of the contract was
 * `capture --json`'s `autoYes.lastSuppression` — written once a prompt had
 * already gone unanswered (CommandAgent #680: 11 hours on a permission dialog).
 *
 * Pinned here over a real in-memory SQLite, the real task table and the real
 * Auto-Yes map:
 *
 *  - the arming POST and the `?cliToolId` GET carry `contractPolicy`
 *    (`{ taskId, mode, allowPromptTypes, denyPatternCount }` or null);
 *  - the whole-worktree GET's `instances` map and the list's
 *    `autoYesByInstance` flag `blockedByContract: true` on `mode: 'off'` only;
 *  - no contract, a contract with no mode, `safe` and `allow-listed` leave the
 *    entries exactly the shape they had (negative controls);
 *  - the verdict is the poller's: the instance listed as blocked is the one
 *    `getSessionAutoYesPolicy` + the resolver withholds an answer for.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { createTask, upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import {
  clearAutoYesPolicyCache,
  getSessionAutoYesPolicy,
  isSessionAutoYesBlockedByContract,
} from '@/lib/polling/auto-yes-policy';
import { resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import type { PromptData, Worktree } from '@/types/models';

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

// No session exists: the list reads nothing as running, and arming takes the
// `absent` branch of the ownership check (as `send --auto-yes` does).
vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    listSessions: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
    getSessionWorkingDirectory: vi.fn(async () => null),
  };
});

// State storage stays real; only the timer-driven poller is stood in for.
vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>();
  return {
    ...actual,
    startAutoYesPolling: vi.fn(() => ({ started: true })),
    stopAutoYesPolling: vi.fn(() => true),
    stopAutoYesPollingByWorktree: vi.fn(() => 0),
  };
});

vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ examined: 0, delivered: 0, skipped: 0, reason: 'no-pending' })),
}));

import { GET as getWorktrees } from '@/app/api/worktrees/route';
import { GET as getAutoYes, POST as postAutoYes } from '@/app/api/worktrees/[id]/auto-yes/route';

const WT = 'wt-3723';
const HOUR_MS = 3_600_000;

const YES_NO: PromptData = {
  type: 'yes_no',
  question: 'Allow this command?',
  status: 'pending',
  options: ['yes', 'no'],
};

let db: Database.Database;

/** A running task on (claude, instanceId) whose contract carries `autoYesBlock`. */
function seedTask(instanceId: string, autoYesBlock: string): string {
  const contract = parseTaskContract(
    `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
${autoYesBlock}`,
    'task.yaml'
  );
  const task = createTask(db, {
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId: instanceId === 'claude' ? null : instanceId,
    contractPath: '.commandmate/tasks/t.yaml',
    contract,
    status: 'running',
  });
  return task.id;
}

function listRequest(): NextRequest {
  const url = new URL('http://localhost:3000/api/worktrees');
  const request = new Request(url) as unknown as NextRequest;
  Object.defineProperty(request, 'nextUrl', { value: url, configurable: true });
  return request;
}

async function listedAutoYes(): Promise<Worktree['autoYesByInstance']> {
  const response = await getWorktrees(listRequest());
  expect(response.status).toBe(200);
  const body = (await response.json()) as { worktrees: Worktree[] };
  return body.worktrees.find((row) => row.id === WT)?.autoYesByInstance;
}

async function getJson(query = ''): Promise<Record<string, unknown>> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/auto-yes${query}`);
  const response = await getAutoYes(request, { params: Promise.resolve({ id: WT }) });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function postJson(body: unknown): Promise<Record<string, unknown>> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/auto-yes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const response = await postAutoYes(request, { params: Promise.resolve({ id: WT }) });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  clearAllAutoYesStates();
  clearAutoYesPolicyCache();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: WT,
    path: `/nonexistent-3723/${WT}`,
    repositoryPath: '/nonexistent-3723',
    repositoryName: 'repo',
    cliToolId: 'claude',
  } as Worktree);
  setAgentInstances(db, WT, [
    { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
    { id: 'claude-2', cliTool: 'claude', alias: '', order: 1 },
  ]);
});

afterEach(async () => {
  clearAllAutoYesStates();
  clearAutoYesPolicyCache();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
});

describe('[#3723] POST /auto-yes {enabled: true} names the contract policy', () => {
  it("carries contractPolicy with mode 'off' when the instance's contract says so", async () => {
    const taskId = seedTask('claude-2', "autoYes:\n  mode: 'off'\n");

    const body = await postJson({ enabled: true, cliToolId: 'claude', instanceId: 'claude-2' });

    expect(body.enabled).toBe(true);
    expect(body.contractPolicy).toEqual({
      taskId,
      mode: 'off',
      allowPromptTypes: [],
      denyPatternCount: 0,
    });
  });

  it('carries contractPolicy: null when no contract governs the instance (negative control)', async () => {
    seedTask('claude-2', "autoYes:\n  mode: 'off'\n");

    const body = await postJson({ enabled: true, cliToolId: 'claude' });

    expect(body.enabled).toBe(true);
    expect(body.contractPolicy).toBeNull();
  });

  it('reports allow-listed with its prompt types and deny-pattern count', async () => {
    seedTask(
      'claude',
      "autoYes:\n  mode: allow-listed\n  allowPromptTypes: [yes_no, multiple_choice]\n  denyPatterns: ['rm -rf']\n"
    );

    const body = await postJson({ enabled: true, cliToolId: 'claude' });

    expect(body.contractPolicy).toMatchObject({
      mode: 'allow-listed',
      allowPromptTypes: ['yes_no', 'multiple_choice'],
      denyPatternCount: 1,
    });
  });

  it('a disabling POST carries no contractPolicy (the shape it had)', async () => {
    seedTask('claude', "autoYes:\n  mode: 'off'\n");

    const body = await postJson({ enabled: false, cliToolId: 'claude' });

    expect(body).not.toHaveProperty('contractPolicy');
  });
});

describe('[#3723] GET /auto-yes', () => {
  it('?cliToolId carries contractPolicy for the resolved instance', async () => {
    const taskId = seedTask('claude-2', "autoYes:\n  mode: 'off'\n");

    const blocked = await getJson('?cliToolId=claude&instanceId=claude-2');
    const free = await getJson('?cliToolId=claude');

    expect(blocked.contractPolicy).toEqual({ taskId, mode: 'off', allowPromptTypes: [], denyPatternCount: 0 });
    expect(free.contractPolicy).toBeNull();
  });

  it('the instances map flags only the armed mode-off instance', async () => {
    seedTask('claude-2', "autoYes:\n  mode: 'off'\n");
    const primary = setAutoYesEnabled(WT, 'claude', true, HOUR_MS);
    const alias = setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, 'claude-2');

    const body = await getJson();
    const instances = body.instances as Record<string, Record<string, unknown>>;

    expect(instances['claude-2']).toEqual({ enabled: true, expiresAt: alias.expiresAt, blockedByContract: true });
    expect(instances.claude).toEqual({ enabled: true, expiresAt: primary.expiresAt });
  });

  it('a disarmed instance under a mode-off contract is not flagged', async () => {
    seedTask('claude-2', "autoYes:\n  mode: 'off'\n");
    setAutoYesEnabled(WT, 'claude', false, undefined, undefined, 'claude-2');

    const body = await getJson();
    const instances = body.instances as Record<string, Record<string, unknown>>;

    expect(instances['claude-2']).not.toHaveProperty('blockedByContract');
  });
});

describe('[#3723] GET /api/worktrees autoYesByInstance.blockedByContract', () => {
  it("flags an armed instance whose contract says mode 'off'", async () => {
    seedTask('claude-2', "autoYes:\n  mode: 'off'\n");
    const alias = setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, 'claude-2');

    expect(await listedAutoYes()).toEqual({
      'claude-2': { enabled: true, expiresAt: alias.expiresAt, blockedByContract: true },
    });
  });

  it.each([
    ['no contract', null],
    ['a contract with no mode', 'autoYes:\n  denyPatterns: []\n'],
    ['mode: safe', 'autoYes:\n  mode: safe\n'],
    ['mode: allow-listed', 'autoYes:\n  mode: allow-listed\n  allowPromptTypes: [yes_no]\n'],
  ])('leaves the entry as it was under %s (negative control)', async (_label, block) => {
    if (block !== null) seedTask('claude', block);
    const armed = setAutoYesEnabled(WT, 'claude', true, HOUR_MS);

    expect(await listedAutoYes()).toEqual({ claude: { enabled: true, expiresAt: armed.expiresAt } });
  });
});

describe('[#3723] the display verdict is the poller verdict', () => {
  it('the instance listed as blocked is the one the poller withholds every answer for', async () => {
    seedTask('claude-2', "autoYes:\n  mode: 'off'\n");
    setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, 'claude-2');
    setAutoYesEnabled(WT, 'claude', true, HOUR_MS);

    // What the poller does with a yes/no prompt on each instance (auto-yes-poller.ts step 3).
    const blockedResolution = resolveAutoAnswerWithPolicy(YES_NO, getSessionAutoYesPolicy(WT, 'claude', 'claude-2'));
    const freeResolution = resolveAutoAnswerWithPolicy(YES_NO, getSessionAutoYesPolicy(WT, 'claude', 'claude'));
    expect(blockedResolution).toMatchObject({ answer: null, suppressedBy: 'mode-off' });
    expect(freeResolution.answer).not.toBeNull();

    // What the list says about the same two instances.
    const listed = await listedAutoYes();
    expect(listed?.['claude-2']?.blockedByContract).toBe(true);
    expect(listed?.claude?.blockedByContract).toBeUndefined();
    expect(isSessionAutoYesBlockedByContract(WT, 'claude', 'claude-2')).toBe(true);
    expect(isSessionAutoYesBlockedByContract(WT, 'claude')).toBe(false);
  });

  it('mode: safe answers a yes/no prompt and is not listed as blocked', async () => {
    seedTask('claude', 'autoYes:\n  mode: safe\n');
    setAutoYesEnabled(WT, 'claude', true, HOUR_MS);

    expect(resolveAutoAnswerWithPolicy(YES_NO, getSessionAutoYesPolicy(WT, 'claude')).answer).not.toBeNull();
    expect((await listedAutoYes())?.claude?.blockedByContract).toBeUndefined();
  });
});
