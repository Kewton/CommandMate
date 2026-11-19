/**
 * Issue #4480: `POST /direct-input` and `POST /special-keys` ask the tool policy
 * before a key reaches the pane.
 *
 * Both type into an agent's pane without the detection layer: direct input takes
 * any text and named keys, special keys takes the tool's navigation keys and
 * Enter. On antigravity an Enter on its approval dialog is what Auto-Yes is
 * refused for, and `/send` refused an agent's origin since #4437. Now:
 *
 *  - I1: no declaration, antigravity, origin agent/session/schedule/unknown → 409
 *    `TOOL_POLICY_DENIED` (`policy.operation` is `send` on `/direct-input`, which
 *    can type any text, and `respond` on `/special-keys`), no tmux key write, agy
 *    0 runs, no table gains a row.
 *  - I2: the screen (no origin) and `terminal` still type; claude from an agent's
 *    origin still types; a declaration lifts it.
 *  - A non-string `origin` is 400 and nothing is typed.
 *
 * tmux's key writers and `hasSession` are mocked and recorded; the rest of the
 * route (validation, vocabulary, policy) is real. `PATH` / `HOME` are the private
 * ones of tests/helpers/fake-agy-path.ts.
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
  sendSpecialKeysAndInvalidate: vi.fn(async (...args: unknown[]) => {
    tmuxWrites.push(`special ${JSON.stringify(args)}`);
  }),
  sendDirectInputAndInvalidate: vi.fn(async (...args: unknown[]) => {
    tmuxWrites.push(`direct ${JSON.stringify(args)}`);
  }),
}));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: '/path/to/wt' })),
}));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastTerminalSnapshotAfterInteraction: vi.fn(async () => undefined),
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

import { POST as directInput } from '@/app/api/worktrees/[id]/direct-input/route';
import { POST as specialKeys } from '@/app/api/worktrees/[id]/special-keys/route';
import { setMockDb } from '@/lib/db/db-instance';
import { TOOL_POLICY_DENIED } from '@/lib/tool-policy/policy';

const WT = 'wt-4480-keys';

type Route = 'direct-input' | 'special-keys';

const ROUTES: Record<Route, { handler: typeof directInput; payload: Record<string, unknown>; operation: string }> = {
  'direct-input': {
    handler: directInput,
    payload: { events: [{ type: 'text', text: 'y' }, { type: 'key', key: 'Enter' }] },
    operation: 'send',
  },
  'special-keys': {
    handler: specialKeys,
    payload: { keys: ['Enter'] },
    operation: 'respond',
  },
};

let db: Database.Database;
let fake: FakeAgyPath;

function call(route: Route, body: Record<string, unknown>) {
  return ROUTES[route].handler(
    new NextRequest(`http://localhost:3000/api/worktrees/${WT}/${route}`, {
      method: 'POST',
      body: JSON.stringify({ ...ROUTES[route].payload, ...body }),
      headers: { 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ id: WT }) },
  );
}

beforeEach(() => {
  fake = installFakeAgyPath();
  tmuxWrites.length = 0;
  db = new Database(':memory:');
  runMigrations(db);
  setMockDb(db);
  const worktree: Worktree = {
    id: WT,
    name: 'Keys 4480',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'repo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setMockDb(null);
  db.close();
  fake.restore();
});

const ROUTE_NAMES = Object.keys(ROUTES) as Route[];
const REFUSED_ORIGINS = ['agent', 'session', 'schedule', 'unknown', 'something-else'];

describe('[#4480] /direct-input and /special-keys ask the tool policy', () => {
  it.each(ROUTE_NAMES.flatMap((route) => REFUSED_ORIGINS.map((origin) => [route, origin] as const)))(
    '4480 (I1): /%s refuses antigravity from origin %s with 409, writes 0 keys and 0 rows',
    async (route, origin) => {
      const before = rowCountsOfAllTables(db);

      const res = await call(route, { cliToolId: 'antigravity', origin });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: TOOL_POLICY_DENIED,
        sendOutcome: 'not_sent',
        policy: { tool: 'antigravity', operation: ROUTES[route].operation },
      });
      expect(tmuxWrites).toEqual([]);
      expect(fake.callsOf('agy')).toEqual([]);
      expect(rowCountsOfAllTables(db)).toEqual(before);
    },
  );

  it.each(ROUTE_NAMES)('4480: /%s answers 400 for a non-string origin and types nothing', async (route) => {
    for (const origin of [null, 1, false, ['agent']]) {
      const res = await call(route, { cliToolId: 'antigravity', origin });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'origin must be a string' });
    }
    expect(tmuxWrites).toEqual([]);
  });

  it.each(ROUTE_NAMES)(
    '4480 (I2): /%s still types for antigravity with no origin (the screen) and origin terminal',
    async (route) => {
      expect((await call(route, { cliToolId: 'antigravity' })).status).toBe(200);
      expect((await call(route, { cliToolId: 'antigravity', origin: 'terminal' })).status).toBe(200);
      expect(tmuxWrites).toHaveLength(2);
    },
  );

  it.each(ROUTE_NAMES)('4480 (I2): /%s still types for claude from origin agent', async (route) => {
    expect((await call(route, { cliToolId: 'claude', origin: 'agent' })).status).toBe(200);
    expect(tmuxWrites).toHaveLength(1);
  });

  it.each(ROUTE_NAMES)(
    '4480: /%s types for antigravity from origin agent under CM_ANTIGRAVITY_USAGE=enterprise',
    async (route) => {
      vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'enterprise');
      expect((await call(route, { cliToolId: 'antigravity', origin: 'agent' })).status).toBe(200);
      expect(tmuxWrites).toHaveLength(1);
    },
  );
});
