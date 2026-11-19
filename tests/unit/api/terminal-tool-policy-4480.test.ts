/**
 * Issue #4480: `POST /api/worktrees/:id/terminal` asks the tool policy before it
 * types anything.
 *
 * The route calls `ICLITool.sendMessage`, which for antigravity marks a use
 * (`noteAntigravityUse`) and may relaunch agy in the pane (`requireSession(…,
 * { relaunch: true })`). `/send` refused an agent's origin with 409 since #4437,
 * while the same body sent here was typed. Now:
 *
 *  - I1: no declaration, antigravity, origin agent/session/schedule/unknown → 409
 *    `TOOL_POLICY_DENIED`, `sendOutcome: not_sent`; `sendMessage` 0 calls (so no
 *    relaunch and no key), no tmux key write, the use mark stays unset, agy runs 0
 *    times and no table gains a row.
 *  - I2: no origin (the web UI, an older caller) and `terminal` still go through;
 *    claude from an agent's origin still goes through; a declaration lifts it.
 *  - A non-string `origin` is 400 (as on `/send`), and nothing is typed.
 *
 * The tool objects are the real `CLIToolManager` instances; only their
 * `sendMessage` / `isRunning` are stubbed (a real send would drive tmux). tmux's
 * key writers are mocked and recorded. `PATH` holds only the fake agy / claude /
 * codex (tests/helpers/fake-agy-path.ts) and `HOME` is private, so the real agy
 * cannot run.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { installFakeAgyPath, type FakeAgyPath } from '@tests/helpers/fake-agy-path';
import { rowCountsOfAllTables } from '@tests/helpers/db-row-counts';

const tmuxWrites: string[] = [];
vi.mock('@/lib/tmux/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux')>()),
  hasSession: vi.fn(async () => true),
  sendKeys: vi.fn(async (...args: unknown[]) => { tmuxWrites.push(`sendKeys ${JSON.stringify(args)}`); }),
  sendSpecialKeys: vi.fn(async (...args: unknown[]) => { tmuxWrites.push(`sendSpecialKeys ${JSON.stringify(args)}`); }),
}));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: '/path/to/wt' })),
}));
vi.mock('@/lib/session/prompt-waiting-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/prompt-waiting-guard')>()),
  isPromptWaiting: vi.fn(async () => ({ waiting: false })),
}));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database | null): void;
}
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database | null) => {
      mockDb = db;
    },
  };
});

import { POST } from '@/app/api/worktrees/[id]/terminal/route';
import { setMockDb } from '@/lib/db/db-instance';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { checkSessionOwnership } from '@/lib/cli-tools/session-ownership';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { TOOL_POLICY_DENIED } from '@/lib/tool-policy/policy';
import { hasAntigravityBeenUsed, resetAntigravityUseForTest } from '@/lib/tool-policy/version-probe-gate';

const WT = 'wt-4480-terminal';

let db: Database.Database;
let fake: FakeAgyPath;
const sendMessageCalls: string[] = [];
const isRunningCalls: string[] = [];

function call(body: Record<string, unknown>) {
  return POST(
    new NextRequest(`http://localhost:3000/api/worktrees/${WT}/terminal`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ id: WT }) },
  );
}

beforeEach(() => {
  fake = installFakeAgyPath();
  resetAntigravityUseForTest();
  tmuxWrites.length = 0;
  sendMessageCalls.length = 0;
  isRunningCalls.length = 0;
  db = new Database(':memory:');
  runMigrations(db);
  setMockDb(db);
  const worktree: Worktree = {
    id: WT,
    name: 'Terminal 4480',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'repo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
  setAgentInstances(db, WT, [{ id: 'antigravity-2', cliTool: 'antigravity', alias: 'Antigravity 2', order: 0 }]);
  vi.mocked(checkSessionOwnership).mockClear();
  for (const tool of ['antigravity', 'claude'] as CLIToolType[]) {
    const instance = CLIToolManager.getInstance().getTool(tool);
    vi.spyOn(instance, 'sendMessage').mockImplementation(async (...args: unknown[]) => {
      sendMessageCalls.push(`${tool} ${JSON.stringify(args)}`);
    });
    vi.spyOn(instance, 'isRunning').mockImplementation(async (...args: unknown[]) => {
      isRunningCalls.push(`${tool} ${JSON.stringify(args)}`);
      return true;
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setMockDb(null);
  db.close();
  resetAntigravityUseForTest();
  fake.restore();
});

describe('[#4480] POST /terminal asks the tool policy', () => {
  it.each(['agent', 'session', 'schedule', 'unknown', 'something-else'])(
    '4480 (I1): /terminal refuses antigravity from origin %s with 409 TOOL_POLICY_DENIED, types 0 keys, relaunches 0 times, adds 0 rows',
    async (origin) => {
      const before = rowCountsOfAllTables(db);

      const res = await call({ cliToolId: 'antigravity', command: 'hello', origin });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({
        code: TOOL_POLICY_DENIED,
        sendOutcome: 'not_sent',
        policy: { tool: 'antigravity', operation: 'send' },
      });
      expect(sendMessageCalls).toEqual([]);
      expect(isRunningCalls).toEqual([]);
      expect(checkSessionOwnership).not.toHaveBeenCalled();
      expect(tmuxWrites).toEqual([]);
      expect(hasAntigravityBeenUsed()).toBe(false);
      expect(fake.callsOf('agy')).toEqual([]);
      expect(rowCountsOfAllTables(db)).toEqual(before);
    },
  );

  it('4480: /terminal answers 400 for a non-string origin and types nothing', async () => {
    for (const origin of [null, 1, true, { kind: 'terminal' }]) {
      const res = await call({ cliToolId: 'antigravity', command: 'hello', origin });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'origin must be a string' });
    }
    expect(sendMessageCalls).toEqual([]);
    expect(tmuxWrites).toEqual([]);
  });

  it('4480 (I2): /terminal still sends to antigravity with no origin (web UI / legacy) and origin terminal', async () => {
    const legacy = await call({ cliToolId: 'antigravity', command: 'from the screen' });
    expect(legacy.status).toBe(200);
    const terminal = await call({ cliToolId: 'antigravity', command: 'from a terminal', origin: 'terminal' });
    expect(terminal.status).toBe(200);
    expect(sendMessageCalls).toHaveLength(2);
    expect(sendMessageCalls[0]).toContain('from the screen');
    expect(sendMessageCalls[1]).toContain('from a terminal');
  });

  it('4480 (I2): /terminal still sends to claude from origin agent', async () => {
    const res = await call({ cliToolId: 'claude', command: 'hello', origin: 'agent' });
    expect(res.status).toBe(200);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]).toMatch(/^claude /);
  });

  it.each(['api-key', 'enterprise'])(
    '4480: /terminal sends to antigravity from origin agent under CM_ANTIGRAVITY_USAGE=%s',
    async (declaration) => {
      vi.stubEnv('CM_ANTIGRAVITY_USAGE', declaration);
      const res = await call({ cliToolId: 'antigravity', command: 'hello', origin: 'agent' });
      expect(res.status).toBe(200);
      expect(sendMessageCalls).toHaveLength(1);
    },
  );

  // Review-4480 (codex P3-1): the refusal stops before the ownership check (which
  // asks tmux), and a send that goes through reaches the tool and instance named.
  it('4480 (I1): /terminal refuses a registered named antigravity instance from origin agent before the ownership check', async () => {
    const before = rowCountsOfAllTables(db);

    const res = await call({ cliToolId: 'antigravity', instanceId: 'antigravity-2', command: 'hello', origin: 'agent' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: TOOL_POLICY_DENIED, policy: { tool: 'antigravity' } });
    expect(checkSessionOwnership).not.toHaveBeenCalled();
    expect(sendMessageCalls).toEqual([]);
    expect(tmuxWrites).toEqual([]);
    expect(rowCountsOfAllTables(db)).toEqual(before);
  });

  it('4480 (I2): /terminal from a terminal sends to the named instance of the tool the roster names', async () => {
    const res = await call({ cliToolId: 'antigravity', instanceId: 'antigravity-2', command: 'hi', origin: 'terminal' });

    expect(res.status).toBe(200);
    expect(sendMessageCalls).toEqual([`antigravity ${JSON.stringify([WT, 'hi', 'antigravity-2'])}`]);
    expect(checkSessionOwnership).toHaveBeenCalledTimes(1);
  });

  it('4480 (I2): /terminal from origin agent sends to claude, primary instance', async () => {
    const res = await call({ cliToolId: 'claude', command: 'hi', origin: 'agent' });

    expect(res.status).toBe(200);
    expect(sendMessageCalls).toEqual([`claude ${JSON.stringify([WT, 'hi', null])}`]);
  });

  // The reinstruction called this "the existing 409"; the route answers it with
  // `sessionTargetConflictResponse`, which is 400 `instance_tool_conflict` (#1925).
  it('4480: a body tool the roster contradicts is still the earlier 400 instance_tool_conflict (not a tool-policy refusal), and nothing is sent', async () => {
    const res = await call({ cliToolId: 'claude', instanceId: 'antigravity-2', command: 'hi', origin: 'agent' });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('instance_tool_conflict');
    expect(checkSessionOwnership).not.toHaveBeenCalled();
    expect(sendMessageCalls).toEqual([]);
  });
});
