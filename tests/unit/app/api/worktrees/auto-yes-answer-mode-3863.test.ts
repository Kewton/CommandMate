/**
 * Issue #3863: the answer mode's state and the API that sets and reports it.
 *
 * - `setAutoYesEnabled`: off (expired included) → on starts a new grant at
 *   `recommended` unless a mode is given; on → on keeps the mode; every enable
 *   is a new state object (a tick holding the old one is no longer current); a
 *   state kept from before the field reads as `recommended`.
 * - `POST /auto-yes`: `answerMode` in the body (anything else is 400), the
 *   effective mode on the response; the `?cliToolId` GET; the whole-worktree
 *   GET's `answerModeByInstance` beside `agents` / `instances`, whose entries
 *   keep their shape.
 *
 * Over a real in-memory SQLite and the real Auto-Yes map, mocks as in
 * `auto-yes-contract-blocked-3723.test.ts`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import {
  autoYesAnswerModeOf,
  clearAllAutoYesStates,
  getAutoYesState,
  setAutoYesEnabled,
  type AutoYesState,
} from '@/lib/auto-yes-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
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
  return {
    ...actual,
    listSessions: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
    getSessionWorkingDirectory: vi.fn(async () => null),
  };
});

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

import { GET as getAutoYes, POST as postAutoYes } from '@/app/api/worktrees/[id]/auto-yes/route';

const WT = 'wt-3863-api';
const HOUR_MS = 3_600_000;

let db: Database.Database;

async function getJson(query = ''): Promise<Record<string, unknown>> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/auto-yes${query}`);
  const response = await getAutoYes(request, { params: Promise.resolve({ id: WT }) });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/auto-yes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const response = await postAutoYes(request, { params: Promise.resolve({ id: WT }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
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
    path: `/nonexistent-3863/${WT}`,
    repositoryPath: '/nonexistent-3863',
    repositoryName: 'repo',
    cliToolId: 'claude',
  } as Worktree);
  setAgentInstances(db, WT, [
    { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
    { id: 'claude-2', cliTool: 'claude', alias: '', order: 1 },
  ]);
});

afterEach(async () => {
  vi.useRealTimers();
  clearAllAutoYesStates();
  clearAutoYesPolicyCache();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
});

describe('[#3863] setAutoYesEnabled: the mode of a grant', () => {
  it('off → on: recommended when no mode is given, the given mode otherwise', () => {
    expect(setAutoYesEnabled(WT, 'claude', true, HOUR_MS).answerMode).toBe('recommended');
    setAutoYesEnabled(WT, 'claude', false);
    expect(setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, undefined, 'careful').answerMode).toBe('careful');
  });

  it('on → on keeps the mode when none is given, and a new state object either way', () => {
    const careful = setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, undefined, 'careful');
    const again = setAutoYesEnabled(WT, 'claude', true, HOUR_MS);
    expect(again.answerMode).toBe('careful');
    expect(again).not.toBe(careful);
    const changed = setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, undefined, 'recommended');
    expect(changed.answerMode).toBe('recommended');
    expect(getAutoYesState(WT, 'claude')).toBe(changed);
  });

  it('off in between (a manual disable) starts afresh at recommended', () => {
    setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, undefined, 'careful');
    setAutoYesEnabled(WT, 'claude', false);
    expect(setAutoYesEnabled(WT, 'claude', true, HOUR_MS).answerMode).toBe('recommended');
  });

  it('a grant that ran out is not continued: on again starts at recommended', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, undefined, 'careful');
    vi.setSystemTime(1_800_000_000_000 + HOUR_MS);
    expect(setAutoYesEnabled(WT, 'claude', true, HOUR_MS).answerMode).toBe('recommended');
  });

  it('one instance per mode: the alias keeps its own', () => {
    setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, undefined, 'careful');
    setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, 'claude-2');
    expect(getAutoYesState(WT, 'claude')?.answerMode).toBe('careful');
    expect(getAutoYesState(WT, 'claude', 'claude-2')?.answerMode).toBe('recommended');
  });

  it('a state kept from before the field reads as recommended', () => {
    const legacy: AutoYesState = { enabled: true, enabledAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
    expect(autoYesAnswerModeOf(legacy)).toBe('recommended');
    expect(autoYesAnswerModeOf({ ...legacy, answerMode: 'careful' })).toBe('careful');
  });
});

describe('[#3863] POST /auto-yes answerMode', () => {
  it('sets the mode and answers with it', async () => {
    const { status, body } = await post({ enabled: true, cliToolId: 'claude', answerMode: 'careful' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ enabled: true, answerMode: 'careful' });
    expect(getAutoYesState(WT, 'claude')?.answerMode).toBe('careful');
  });

  it('omitted: recommended for a new grant, the current mode for a live one', async () => {
    expect((await post({ enabled: true, cliToolId: 'claude' })).body.answerMode).toBe('recommended');
    await post({ enabled: true, cliToolId: 'claude', answerMode: 'careful' });
    expect((await post({ enabled: true, cliToolId: 'claude' })).body.answerMode).toBe('careful');
  });

  it.each(['RECOMMENDED', 'auto', 1, null])('%j is 400, and nothing is armed', async (answerMode) => {
    const { status, body } = await post({ enabled: true, cliToolId: 'claude', answerMode });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('answerMode');
    expect(getAutoYesState(WT, 'claude')).toBeNull();
  });

  it('negative: a disabling POST carries no answerMode (the shape it had)', async () => {
    await post({ enabled: true, cliToolId: 'claude', answerMode: 'careful' });
    const { body } = await post({ enabled: false, cliToolId: 'claude' });
    expect(body).not.toHaveProperty('answerMode');
  });
});

describe('[#3863] GET /auto-yes reports the mode', () => {
  it('?cliToolId: the resolved instance’s mode while on', async () => {
    setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, 'claude-2', 'careful');
    expect((await getJson('?cliToolId=claude&instanceId=claude-2')).answerMode).toBe('careful');
    expect(await getJson('?cliToolId=claude')).not.toHaveProperty('answerMode');
  });

  it('the whole worktree: answerModeByInstance beside the maps, whose entries keep their shape', async () => {
    const primary = setAutoYesEnabled(WT, 'claude', true, HOUR_MS);
    setAutoYesEnabled(WT, 'claude', true, HOUR_MS, undefined, 'claude-2', 'careful');
    setAutoYesEnabled(WT, 'claude', false, undefined, undefined, 'claude-2');
    setAutoYesEnabled(WT, 'codex', true, HOUR_MS, undefined, undefined, 'careful');

    const body = await getJson();
    expect(body.answerModeByInstance).toEqual({ claude: 'recommended', codex: 'careful' });
    expect(body.answerMode).toBe('recommended');
    const instances = body.instances as Record<string, Record<string, unknown>>;
    expect(instances.claude).toEqual({ enabled: true, expiresAt: primary.expiresAt });
    expect(instances['claude-2']).toEqual({ enabled: false, expiresAt: null });
  });
});
