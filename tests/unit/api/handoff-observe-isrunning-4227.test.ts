/**
 * The hand-off's observation asks whether the session runs exactly as kill-session asks it
 * (Issue #4227 G-PR2, design `mem-ui-4227.md` §4.6 3, the 6th review's P2(1)): the tool from
 * the roster, `cliTool.isRunning(worktreeId, instanceId)` — never a session name passed in —
 * so the name looked up is the one the person's stop stopped, for the primary instance and
 * for an added one. And a stop that did not take (still running, or the read failing) is
 * never recorded as confirmed (H9(f)(g)).
 *
 * The positive control is the call kill-session makes: the same mocks record its arguments,
 * and the observation's are compared with them. Nothing is killed here (the tools' kills are
 * stubbed); no tmux, server or agent runs.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(() => Promise.resolve(true)),
  killSession: vi.fn(() => Promise.resolve(true)),
  createSession: vi.fn(() => Promise.resolve(undefined)),
  capturePane: vi.fn(() => Promise.resolve('')),
  sendKeys: vi.fn(() => Promise.resolve(undefined)),
  sendSpecialKey: vi.fn(() => Promise.resolve(undefined)),
  sendSpecialKeys: vi.fn(() => Promise.resolve(undefined)),
  clearInputLine: vi.fn(() => Promise.resolve(undefined)),
  reconcileSessionGeometry: vi.fn(() => Promise.resolve(false)),
  exactTarget: (name: string) => `=${name}:`,
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/ws-server', () => ({ broadcast: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

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

import { POST as killSessionPost } from '@/app/api/worktrees/[id]/kill-session/route';
import { POST as observePost } from '@/app/api/worktrees/[id]/mem/handoff/requests/[rid]/end/observe/route';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { changeHandoffRequest, getHandoffRequest, insertHandoffRequest } from '@/lib/db/handoff-db';
import { openBoundary, readInstanceLifetime } from '@/lib/db/session-brief-db';
import { getOrCreateWorktreeIncarnation } from '@/lib/mem/incarnation';

const WT = 'wt-observe';
let db: Database.Database;
let asked: Array<[string, string, string | undefined]>;
let answer: () => Promise<boolean>;

function spyTools(): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    vi.spyOn(manager.getTool(tool), 'isRunning').mockImplementation(async (worktreeId: string, instanceId?: string) => {
      asked.push([tool, worktreeId, instanceId]);
      return tool === 'claude' ? answer() : false;
    });
    vi.spyOn(manager.getTool(tool), 'killSession').mockImplementation(async () => undefined);
  }
}

/** A request of `instanceId` whose stop is declared (`ending`), in the current conversation. */
function declared(instanceId: string): { rid: string; endToken: string } {
  openBoundary(db, { worktreeId: WT, instanceId, cliToolId: 'claude', lifetime: readInstanceLifetime(db, WT, instanceId), kind: 'launch', evidence: 'launch', openedAt: Date.now() });
  const lifetime = readInstanceLifetime(db, WT, instanceId);
  const rid = `req-${instanceId}`;
  const now = Date.now();
  insertHandoffRequest(db, {
    id: rid,
    repositoryId: 'repo',
    branch: 'main',
    detached: false,
    targetWorktreeId: WT,
    targetWorktreeIncarnation: getOrCreateWorktreeIncarnation(db, WT),
    instanceId,
    cliToolId: 'claude',
    instanceIncarnation: lifetime.incarnation,
    instanceOnRoster: lifetime.onRoster,
    boundaryId: (db.prepare('SELECT id FROM session_brief_boundaries WHERE worktree_id = ? AND instance_id = ? ORDER BY seq DESC LIMIT 1').get(WT, instanceId) as { id: string }).id,
    agentDeadlineAt: now + 60_000,
    expiresAt: now + 3_600_000,
    now,
  });
  const endToken = `end-${instanceId}`;
  changeHandoffRequest(db, rid, null, { state: 'ending', endToken, agentDoneAt: now }, now);
  return { rid, endToken };
}

const screenHeaders = { 'X-CommandMate-Client': 'screen', origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' };
const observe = (rid: string, endToken: string) =>
  observePost(
    new NextRequest(`http://localhost:3000/api/worktrees/${WT}/mem/handoff/requests/${rid}/end/observe`, { method: 'POST', headers: screenHeaders, body: JSON.stringify({ endToken }) }),
    { params: Promise.resolve({ id: WT, rid }) }
  );
const kill = (instanceId: string) =>
  killSessionPost(new NextRequest(`http://localhost:3000/api/worktrees/${WT}/kill-session?cliTool=claude&instance=${instanceId}`, { method: 'POST' }), {
    params: Promise.resolve({ id: WT }),
  });

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const worktree: Worktree = { id: WT, name: 'Observe', path: '/path/to/wt', repositoryPath: '/path/to/repo', repositoryName: 'repo', cliToolId: 'claude' };
  upsertWorktree(db, worktree);
  asked = [];
  answer = async () => false;
  spyTools();
});
afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  vi.restoreAllMocks();
});

describe('[#4227] the observation asks isRunning as kill-session does', () => {
  it.each(['claude', 'claude-2'])('%s: the same tool, worktree and instance — so the same session name', async (instanceId) => {
    answer = async () => true;
    expect((await kill(instanceId)).status).toBe(200);
    const byKill = asked.filter(([tool]) => tool === 'claude');
    expect(byKill.length).toBe(1);

    asked = [];
    answer = async () => false;
    const { rid, endToken } = declared(instanceId);
    const response = await observe(rid, endToken);
    expect(response.status).toBe(200);
    expect(asked).toEqual(byKill);
    const tool = CLIToolManager.getInstance().getTool('claude');
    expect(tool.getSessionName(asked[0][1], asked[0][2])).toBe(tool.getSessionName(byKill[0][1], byKill[0][2]));
    expect(getHandoffRequest(db, rid)).toMatchObject({ state: 'ended', outcome: 'confirmed' });
  });

  it('H9(f) still running after the stop → 409 not_stopped, back to reviewing, never confirmed', async () => {
    answer = async () => true;
    const { rid, endToken } = declared('claude');
    const response = await observe(rid, endToken);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('not_stopped');
    expect(getHandoffRequest(db, rid)).toMatchObject({ state: 'reviewing', outcome: null });
  });

  it('H9(g) the read fails → 409 not_stopped, never confirmed', async () => {
    answer = async () => {
      throw new Error('tmux is gone');
    };
    const { rid, endToken } = declared('claude');
    const response = await observe(rid, endToken);
    expect(response.status).toBe(409);
    expect(getHandoffRequest(db, rid)).toMatchObject({ state: 'reviewing', outcome: null });
  });

  it('another token is refused without asking tmux at all', async () => {
    const { rid } = declared('claude');
    const response = await observe(rid, 'not-the-token');
    expect(response.status).toBe(409);
    expect(asked).toEqual([]);
  });
});
