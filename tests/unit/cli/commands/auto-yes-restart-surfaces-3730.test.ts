/**
 * The CLI surfaces of a restart release, end to end (Issue #3730).
 *
 * A grant is armed, the real shutdown record is written, the in-memory state is
 * cleared (what a new process starts without) and the real restore runs. Then
 * `capture --json` and `instances` are run against the real route handlers —
 * `GET …/current-output` (through `buildCurrentOutput`) and `GET …/auto-yes` —
 * behind a stubbed `fetch`, exactly as `instances-auto-yes-3300.test.ts` does.
 *
 * Positive control: before #3730 nothing was recorded, so every
 * `server-restart` asserted below is absent on the old implementation.
 * Negative controls: an instance that was not armed at the stop, and one turned
 * off before it, read exactly as they did.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { buildClaudeIdleComposerFrame } from '../../../fixtures/claude-idle-composer';

vi.mock('@/lib/session/cli-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/cli-session')>();
  return {
    ...actual,
    captureSessionOutput: vi.fn(async () => buildClaudeIdleComposerFrame()),
  };
});

// The route asks tmux whether a same-named session belongs to another server.
// Answered by name only, so this suite never reaches the operator's tmux.
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);

// The route's staleness snapshot starts `<tool> --version` probes when its
// cache is cold. Not this suite's subject, and not a process it should start.
vi.mock('@/lib/detection/version-probes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/detection/version-probes')>();
  return { ...actual, getDetectorStalenessSnapshot: vi.fn(() => undefined) };
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

import { GET as getCurrentOutput } from '@/app/api/worktrees/[id]/current-output/route';
import { GET as getAutoYes } from '@/app/api/worktrees/[id]/auto-yes/route';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/polling/auto-yes-manager';
import { getAutoYesState, resetAutoYesShutdownForTesting } from '@/lib/auto-yes-state';
import { recordAutoYesShutdown, restoreAutoYesShutdownRecord } from '@/lib/auto-yes-shutdown-record';
import { clearAllPollerStates, getActivePollerCount } from '@/lib/auto-yes-poller';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKTREE_ID = 'wt-3730';

/** The Issue's roster: a claude session that is up, a codex instance that is not. */
const ROSTER = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
] as const;

/** Report exactly these instance ids as live; every other session is absent. */
function running(...instanceIds: string[]): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    vi.spyOn(manager.getTool(tool), 'isRunning').mockImplementation(
      async (_worktreeId: string, instance?: string) => instanceIds.includes(instance ?? tool)
    );
  }
}

interface ServedResponse {
  pathname: string;
  search: string;
  status: number;
  body: Record<string, unknown>;
}

/** What an `auto-yes` GET is answered with, when it is not the real route. */
type AutoYesOverride = { status: number; body: Record<string, unknown> } | null;

/** Every response the stubbed `fetch` handed the command, in request order. */
let served: ServedResponse[] = [];
let autoYesOverride: AutoYesOverride = null;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Route the CLI's requests into the route handlers in this process. Anything
 * the command asks for beyond these three is a request this Issue did not
 * expect, and fails loudly rather than being invented here.
 */
async function serve(input: unknown): Promise<Response> {
  const url = new URL(String(input));
  const params = { params: Promise.resolve({ id: WORKTREE_ID }) };
  const base = `/api/worktrees/${WORKTREE_ID}`;
  let response: Response;
  if (url.pathname === '/api/capabilities') {
    // `capture` probes the server's capabilities first; a server that predates
    // the endpoint (404) is the answer it already handles.
    return jsonResponse(404, { error: 'not found' });
  }
  if (url.pathname === base) {
    response = jsonResponse(200, { id: WORKTREE_ID, name: 'main', agentInstances: ROSTER });
  } else if (url.pathname === `${base}/current-output`) {
    response = (await getCurrentOutput(new NextRequest(url, { method: 'GET' }), params)) as Response;
  } else if (url.pathname === `${base}/auto-yes`) {
    response = autoYesOverride
      ? jsonResponse(autoYesOverride.status, autoYesOverride.body)
      : ((await getAutoYes(new NextRequest(url, { method: 'GET' }), params)) as Response);
  } else {
    throw new Error(`unexpected request from instances: ${url.pathname}`);
  }
  served.push({
    pathname: url.pathname,
    search: url.search,
    status: response.status,
    body: (await response.clone().json()) as Record<string, unknown>,
  });
  return response;
}

interface InstanceRowJson {
  instanceId: string;
  running: boolean;
  autoYes: boolean;
}

interface InstanceRowJson {
  instanceId: string;
  running: boolean;
  autoYes: boolean;
  autoYesStopReason?: string;
}

describe('commandmate capture / instances after a restart released Auto-Yes (Issue #3730)', () => {
  const originalFetch = global.fetch;
  let mockConsoleLog: ReturnType<typeof vi.spyOn>;
  let recordDir: string;
  let recordPath: string;

  beforeEach(async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'main',
      path: '/path/to/wt-3730',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WORKTREE_ID, ROSTER.map((instance) => ({ ...instance })));

    vi.clearAllMocks();
    clearAllAutoYesStates();
    resetAutoYesShutdownForTesting();
    served = [];
    autoYesOverride = null;
    recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-yes-cli-3730-'));
    recordPath = path.join(recordDir, 'cm.db.auto-yes-shutdown.json');

    global.fetch = vi.fn(serve) as unknown as typeof fetch;
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    clearAllPollerStates();
    clearAllAutoYesStates();
    resetAutoYesShutdownForTesting();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
    fs.rmSync(recordDir, { recursive: true, force: true });
  });

  /** Stop with the given instances armed, then start again: record, forget, restore. */
  function restartWith(armed: Array<['claude' | 'codex', string]>, disarmed: Array<['claude' | 'codex', string]> = []): void {
    for (const [tool, instanceId] of armed) setAutoYesEnabled(WORKTREE_ID, tool, true, undefined, undefined, instanceId);
    for (const [tool, instanceId] of disarmed) {
      setAutoYesEnabled(WORKTREE_ID, tool, true, undefined, undefined, instanceId);
      setAutoYesEnabled(WORKTREE_ID, tool, false, undefined, undefined, instanceId);
    }
    recordAutoYesShutdown({ path: recordPath });
    clearAllAutoYesStates();
    resetAutoYesShutdownForTesting();
    restoreAutoYesShutdownRecord({ path: recordPath });
  }

  function printed(startsWith: string): string {
    const lines = (mockConsoleLog.mock.calls as unknown[][])
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith(startsWith));
    if (lines.length !== 1) {
      throw new Error(`expected one line starting with ${JSON.stringify(startsWith)}, got ${lines.length}`);
    }
    return lines[0];
  }

  async function captureJson(instanceId: string): Promise<Record<string, unknown>> {
    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    await createCaptureCommand().parseAsync(['node', 'capture', WORKTREE_ID, '--json', '--instance', instanceId]);
    return JSON.parse(printed('{')) as Record<string, unknown>;
  }

  async function listJson(): Promise<InstanceRowJson[]> {
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', WORKTREE_ID, '--json']);
    return JSON.parse(printed('[\n')) as InstanceRowJson[];
  }

  async function tableCell(instanceId: string): Promise<string> {
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', WORKTREE_ID]);
    const lines = printed('INSTANCE_ID').split('\n');
    const header = lines[0].split(/\s{2,}/);
    const cells = (lines.find((line) => line.startsWith(`${instanceId} `)) ?? '').split(/\s{2,}/);
    return cells[header.indexOf('AUTO_YES')];
  }

  it('capture --json: autoYes is enabled:false with stopReason server-restart, and nothing polls', async () => {
    running('claude');
    restartWith([['claude', 'claude']]);

    const output = await captureJson('claude');

    expect(output.autoYes).toMatchObject({ enabled: false, expiresAt: null, stopReason: 'server-restart' });
    expect(getActivePollerCount()).toBe(0);
    expect(getAutoYesState(WORKTREE_ID, 'claude')?.enabled).toBe(false);
  });

  it('negative: an instance turned off before the stop has no reason after it', async () => {
    running('claude');
    restartWith([], [['claude', 'claude']]);

    const output = await captureJson('claude');

    expect((output.autoYes as Record<string, unknown>).stopReason).toBeUndefined();
  });

  it('instances --json / table: the released row says so, the other row is unchanged', async () => {
    running('claude');
    restartWith([['codex', 'codex']]);

    const rows = await listJson();
    expect(rows.find((r) => r.instanceId === 'codex')).toMatchObject({
      running: false,
      autoYes: false,
      autoYesStopReason: 'server-restart',
    });
    expect(rows.find((r) => r.instanceId === 'claude')).not.toHaveProperty('autoYesStopReason');

    mockConsoleLog.mockClear();
    expect(await tableCell('codex')).toBe('no(restart)');
    mockConsoleLog.mockClear();
    expect(await tableCell('claude')).toBe('no');
  });

  it('negative: a server older than the field — plain no', async () => {
    running('claude');
    autoYesOverride = { status: 200, body: { instances: { codex: { enabled: false, expiresAt: null } } } };

    const rows = await listJson();

    expect(rows.find((r) => r.instanceId === 'codex')).not.toHaveProperty('autoYesStopReason');
  });
});
