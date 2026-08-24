/**
 * `kill-session` は poller を止めてからセッション state を消す（Issue #1984）。
 *
 * ## なぜこのテストが要るのか
 *
 * #1984 で `CLIToolManager.stopPollers()` を `await import('../polling/response-poller')`
 * 経由に変えた。`ws-server -> cli-tools/manager -> polling/response-poller -> ... -> ws-server`
 * というモジュールスコープの循環を切るためで、代償として戻り値が
 * `void` から `Promise<void>` になった。
 *
 * 呼び出し元は `POST /api/worktrees/:id/kill-session` の 1 箇所だけ。そこは
 *
 *     await manager.stopPollers(id, cliToolId, instanceId);
 *     deleteSessionState(db, id, cliToolId, instanceId);
 *
 * という並びで、`await` を落とすと `stopPollers()` は最初の `await import()` で中断して
 * pending の Promise を返し、ルートはそのまま `deleteSessionState()` へ進む。つまり
 * **「state を消してから poller を止める」順序に静かに入れ替わる**。
 *
 * これを止められるものが他に無い:
 *
 * - **TypeScript**: 戻り値 `Promise<void>` を捨てるのは型エラーではない。
 * - **ESLint**: `npm run lint` の設定に `no-floating-promises` は無い
 *   （型情報を要する規則で、`.eslintrc.json` は型付き linting を有効にしていない）。
 * - **既存のテスト**: `kill-session-cli-tool-gateway-1905.test.ts` は
 *   「`cliTool.killSession` が呼ばれたか」を見る。順序は見ていないので `await` の
 *   有無で結果が変わらない。
 *
 * 見ているのは「`await` が書いてあるか」というテキストではなく、
 * **2 つの副作用が観測された順序**である。ソースを grep するだけの検査は、
 * 同じ効果を持つ別の書き方（`.then()` など）を偽の赤にし、
 * 逆に await の位置が違っても緑になりうる。
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

/** Side effects in the order the route produced them. */
const { effects } = vi.hoisted(() => ({ effects: [] as string[] }));

/**
 * The whole tmux surface a tool's `killSession` can touch — complete on purpose,
 * exactly as in the #1905 gateway test: a partial mock makes a tool throw on an
 * undefined binding, and the route's `catch` would then skip the two calls whose
 * order is the subject here, turning this test green for the wrong reason.
 */
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

/**
 * The far side of the edge #1984 cut. `manager.stopPollers()` reaches this
 * through `await import()`, so the recorder here fires one microtask after the
 * route calls it — which is precisely why a missing `await` reorders it past
 * `deleteSessionState`.
 */
vi.mock('@/lib/polling/response-poller', () => ({
  stopPolling: vi.fn((worktreeId: string, cliToolId: string, instanceId?: string) => {
    effects.push(`stopPolling:${worktreeId}:${cliToolId}:${instanceId ?? '-'}`);
  }),
}));

/**
 * Everything else in `@/lib/db` stays real (the route reads and writes a live
 * in-memory schema); only `deleteSessionState` is wrapped so its position in the
 * sequence is observable. The original still runs, so the route's own behaviour
 * is unchanged.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    deleteSessionState: vi.fn(
      (db: Database.Database, worktreeId: string, cliToolId: string, instanceId?: string) => {
        effects.push(`deleteSessionState:${worktreeId}:${cliToolId}:${instanceId ?? '-'}`);
        return actual.deleteSessionState(
          db,
          worktreeId,
          cliToolId as Parameters<typeof actual.deleteSessionState>[2],
          instanceId
        );
      }
    ),
  };
});

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

import { POST } from '@/app/api/worktrees/[id]/kill-session/route';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { addAgentInstance } from '@/lib/db/agent-instances-db';

const WORKTREE_ID = 'wt-order';

function call(query = ''): Promise<Response> {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/kill-session${query}`,
    { method: 'POST' }
  );
  return POST(request, { params: Promise.resolve({ id: WORKTREE_ID }) });
}

/** Only `cliToolId`'s primary instance is live, and its kill always succeeds. */
function onlyRunning(cliToolId: CLIToolType): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    vi.spyOn(manager.getTool(tool), 'isRunning').mockImplementation(async () => tool === cliToolId);
    vi.spyOn(manager.getTool(tool), 'killSession').mockImplementation(async () => {});
  }
}

describe('POST /api/worktrees/:id/kill-session — poller stop ordering (Issue #1984)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Order',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
    effects.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
  });

  it('stops the poller before deleting the session state', async () => {
    onlyRunning('claude');

    const response = await call('?cliTool=claude');

    expect(response.status).toBe(200);
    // Both halves in one assertion: dropping the `await` in the route keeps both
    // entries but swaps them, so an "each was called" check would stay green.
    expect(effects).toEqual([
      `stopPolling:${WORKTREE_ID}:claude:claude`,
      `deleteSessionState:${WORKTREE_ID}:claude:claude`,
    ]);
  });

  it('keeps the order per instance when several sessions are killed', async () => {
    // Two live instances of the same tool: the pairing must hold inside each
    // loop iteration, not merely "all stops before all deletes".
    const manager = CLIToolManager.getInstance();
    for (const tool of CLI_TOOL_IDS) {
      vi.spyOn(manager.getTool(tool), 'isRunning').mockImplementation(async () => tool === 'codex');
      vi.spyOn(manager.getTool(tool), 'killSession').mockImplementation(async () => {});
    }
    // The route seeds each targeted tool's primary instance itself
    // (`instanceId === cliToolId`, #868) and then appends the roster, so only
    // the additional instance has to be registered here.
    addAgentInstance(db, WORKTREE_ID, { id: 'codex-2', cliTool: 'codex', alias: 'second', order: 1 });

    const response = await call('?cliTool=codex');

    expect(response.status).toBe(200);
    expect(effects).toEqual([
      `stopPolling:${WORKTREE_ID}:codex:codex`,
      `deleteSessionState:${WORKTREE_ID}:codex:codex`,
      `stopPolling:${WORKTREE_ID}:codex:codex-2`,
      `deleteSessionState:${WORKTREE_ID}:codex:codex-2`,
    ]);
  });

  it('awaits the poller stop rather than leaving it pending at the response', async () => {
    // The response resolving is the observable boundary a caller has. If the
    // route did not await, `stopPolling` would still be queued behind it.
    onlyRunning('claude');

    await call('?cliTool=claude');

    expect(effects[0]).toBe(`stopPolling:${WORKTREE_ID}:claude:claude`);
  });
});
