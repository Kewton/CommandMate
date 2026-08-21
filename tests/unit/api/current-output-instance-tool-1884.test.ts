/**
 * current-output: `?instance=` decides the CLI tool (Issue #1884).
 *
 * The route used to resolve the tool from `?cliTool` and, failing that, from
 * the worktree default:
 *
 *   const cliToolId = isCliTool(cliToolParam) ? cliToolParam : (worktree.cliToolId || 'claude');
 *
 * `?instance=` never entered that expression. On a worktree whose default is
 * claude, `?instance=opencode` therefore asked
 * `getTool('claude').isRunning(id, 'opencode')` — a session named
 * `mcbd-claude-<id>-opencode` that has never existed — and answered
 * `isRunning: false` while the opencode session was generating.
 *
 * The exit code is the symptom, not the JSON: `commandmate wait --instance
 * opencode` has no `--agent` to correct the resolution with (Issue #1638), so
 * it took that `isRunning: false` on its first poll as "nothing to wait for"
 * and returned NOT_STARTED / exit 21 on a live agent. The last describe block
 * drives the real `wait` command against the real route handler for exactly
 * that reason — an assertion on the payload alone would not have caught the
 * thing operators actually hit.
 *
 * Resolution now goes through the one shared resolver (Issue #1925,
 * design §4 D5 決定 3), so this file also pins the parts of its precedence that
 * reach this route: roster over an explicit `?cliTool`, the primary anchor for
 * an instance id that is itself a tool name (#868), and the worktree default
 * for everything else.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { VerifyExitCode, WaitExitCode } from '../../../src/cli/types';

/**
 * A live opencode frame with an idle composer — `ready` / `input_prompt` under
 * the #1883 detector, i.e. a completion `wait` exits 0 on. Reused rather than
 * hand-written so the status this test depends on is the one a real pane
 * produces.
 */
const OPENCODE_IDLE_FRAME = fs.readFileSync(
  path.resolve(__dirname, '../lib/detection/fixtures/opencode-live-1883/boot-idle.txt'),
  'utf-8',
);

vi.mock('@/lib/session/cli-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/cli-session')>();
  return {
    ...actual,
    captureSessionOutput: vi.fn(async () => OPENCODE_IDLE_FRAME),
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

import { GET } from '@/app/api/worktrees/[id]/current-output/route';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { captureSessionOutput } from '@/lib/session/cli-session';

const WORKTREE_ID = 'wt-1884';

interface CurrentOutputBody {
  isRunning: boolean;
  cliToolId: string;
  resolvedBy?: string;
  conflict?: { instanceId: string; rosterCliTool: string; requestedCliTool: string } | null;
  sessionStatus?: string;
}

function call(query: string): Promise<Response> {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/current-output${query}`,
    { method: 'GET' }
  );
  return GET(request, { params: Promise.resolve({ id: WORKTREE_ID }) }) as Promise<Response>;
}

/**
 * Report exactly one (tool, instance) pair as live. The primary instance uses
 * `instanceId === cliToolId`, which is how the tools themselves normalise it.
 */
function onlyRunning(cliToolId: string, instanceId: string): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    vi.spyOn(manager.getTool(tool), 'isRunning').mockImplementation(
      async (_worktreeId: string, instance?: string) =>
        tool === cliToolId && (instance ?? tool) === instanceId
    );
  }
}

/** Nothing is running, whichever tool or instance is asked about. */
function nothingRunning(): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    vi.spyOn(manager.getTool(tool), 'isRunning').mockResolvedValue(false);
  }
}

async function setUpDb(worktreeCliTool: CLIToolType = 'claude'): Promise<Database.Database> {
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'Instance resolution',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'repo',
    cliToolId: worktreeCliTool,
  };
  upsertWorktree(db, worktree);
  return db;
}

describe('GET /api/worktrees/:id/current-output — instance resolution (Issue #1884)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = await setUpDb('claude');
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'oc-2', cliTool: 'opencode', alias: 'OpenCode 2', order: 0 },
    ]);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
  });

  /**
   * The Issue's own acceptance criterion, stated as the two fields it names:
   * a worktree whose default is claude, an opencode instance that is running,
   * and nothing in the query string but `?instance=`.
   */
  it('reports the running opencode session for ?instance=opencode on a claude worktree', async () => {
    onlyRunning('opencode', 'opencode');

    const response = await call('?instance=opencode');
    expect(response.status).toBe(200);

    const body = (await response.json()) as CurrentOutputBody;
    expect(body.cliToolId).toBe('opencode');
    expect(body.isRunning).toBe(true);
    // #868's primary anchor: an unregistered instance id that names a tool IS
    // that tool's primary instance.
    expect(body.resolvedBy).toBe('primary');
  });

  it('captures the resolved tool\'s pane, not the worktree default\'s', async () => {
    onlyRunning('opencode', 'opencode');

    await call('?instance=opencode');

    expect(captureSessionOutput).toHaveBeenCalledWith(
      WORKTREE_ID,
      'opencode',
      expect.any(Number),
      'opencode',
    );
  });

  it('resolves a roster instance to its registered tool', async () => {
    onlyRunning('opencode', 'oc-2');

    const body = (await (await call('?instance=oc-2')).json()) as CurrentOutputBody;
    expect(body.cliToolId).toBe('opencode');
    expect(body.isRunning).toBe(true);
    expect(body.resolvedBy).toBe('roster');
  });

  /**
   * DR3-015: reading is not a side effect, so a contradiction resolves (the
   * roster wins) and ships in the payload. 400 here would stall the monitor
   * loops that treat a non-zero `capture` as "skip this poll".
   */
  it('lets the roster win over a contradicting ?cliTool and reports the conflict', async () => {
    onlyRunning('opencode', 'oc-2');

    const response = await call('?instance=oc-2&cliTool=claude');
    expect(response.status).toBe(200);

    const body = (await response.json()) as CurrentOutputBody;
    expect(body.cliToolId).toBe('opencode');
    expect(body.isRunning).toBe(true);
    expect(body.resolvedBy).toBe('roster');
    expect(body.conflict).toEqual({
      instanceId: 'oc-2',
      rosterCliTool: 'opencode',
      requestedCliTool: 'claude',
    });
  });

  it('reports conflict: null when nothing contradicts', async () => {
    onlyRunning('opencode', 'oc-2');

    const body = (await (await call('?instance=oc-2&cliTool=opencode')).json()) as CurrentOutputBody;
    expect(body.conflict).toBeNull();
  });

  /** Unchanged behaviour: no instance named, no tool named, worktree default. */
  it('falls back to the worktree default when no instance is named', async () => {
    onlyRunning('claude', 'claude');

    const body = (await (await call('')).json()) as CurrentOutputBody;
    expect(body.cliToolId).toBe('claude');
    expect(body.isRunning).toBe(true);
    expect(body.resolvedBy).toBe('worktree-default');
  });

  /** Unchanged behaviour: an explicit ?cliTool with no instance is taken as given. */
  it('honours an explicit ?cliTool when no instance is named', async () => {
    onlyRunning('codex', 'codex');

    const body = (await (await call('?cliTool=codex')).json()) as CurrentOutputBody;
    expect(body.cliToolId).toBe('codex');
    expect(body.isRunning).toBe(true);
    expect(body.resolvedBy).toBe('explicit');
  });

  /**
   * An instance the roster does not know and whose id is not a tool name has
   * nothing to resolve from, so it keeps landing on the worktree default. Pinned
   * because `resolvedBy` is the only thing that tells that apart from the #1884
   * bug from outside.
   */
  it('falls back to the worktree default for an unknown, non-tool instance id', async () => {
    nothingRunning();

    const body = (await (await call('?instance=worker-7')).json()) as CurrentOutputBody;
    expect(body.cliToolId).toBe('claude');
    expect(body.resolvedBy).toBe('worktree-default');
  });

  it('still rejects a malformed instance parameter', async () => {
    nothingRunning();
    const response = await call('?instance=' + encodeURIComponent('bad/instance'));
    expect(response.status).toBe(400);
  });
});

/**
 * The regression the Issue is actually about: the exit code `wait` hands to
 * whatever runs next.
 *
 * `wait` is driven end to end here — the real command, its real ApiClient, and
 * the real route handler behind a stubbed `fetch` — because the two halves are
 * what produced the bug. The route answered `isRunning: false`; `wait` read
 * that on its first poll, concluded there was nothing to wait for (#1628), and
 * returned 21. Either half in isolation looks correct.
 */
describe('commandmate wait --instance <tool> against a live session (Issue #1884)', () => {
  const originalFetch = global.fetch;
  let db: Database.Database;
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = await setUpDb('claude');
    setAgentInstances(db, WORKTREE_ID, []);
    vi.clearAllMocks();

    // Route the CLI's HTTP calls into the route handler in this process. Only
    // /current-output is reachable: `wait` without --verify calls nothing else,
    // and anything it did call should fail loudly rather than be invented here.
    global.fetch = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/current-output')) {
        throw new Error(`unexpected request from wait: ${url.pathname}`);
      }
      const request = new NextRequest(url, { method: 'GET' });
      return GET(request, { params: Promise.resolve({ id: WORKTREE_ID }) }) as unknown as Response;
    }) as unknown as typeof fetch;

    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
  });

  it('does not exit 21 (NOT_STARTED) while the opencode session is running', async () => {
    onlyRunning('opencode', 'opencode');

    const { createWaitCommand } = await import('../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync([
      'node', 'wait', WORKTREE_ID, '--instance', 'opencode', '--timeout', '30',
    ]);

    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
    // The idle-composer frame is a completion, so the wait it was told to do is
    // over — stated explicitly so a future change that makes the assertion above
    // pass by never polling at all still fails here.
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  /**
   * The other half of the pin: exit 21 is still what a genuinely absent session
   * gets. Without this, deleting the NOT_STARTED branch would satisfy the test
   * above.
   */
  it('still exits 21 when no session for the instance is running', async () => {
    nothingRunning();

    const { createWaitCommand } = await import('../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync([
      'node', 'wait', WORKTREE_ID, '--instance', 'opencode', '--timeout', '30',
    ]);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
  });
});
