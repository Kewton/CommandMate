/**
 * `commandmate instances`: AUTO_YES for an instance that is not running
 * (Issue #3300).
 *
 * Auto-Yes is armed per worktree x instance and outlives the session it answers
 * for, so `commandmate auto-yes <id> --enable --instance codex` succeeds with no
 * codex session. `instances` then printed `AUTO_YES no` for that row while
 * `commandmate ls --json` and `GET /api/worktrees/:id/auto-yes` both said it was
 * armed: the column was read from `current-output`, and a session that is not
 * running is answered there with no `autoYes` key at all.
 *
 * The existing suites could not see it. They hand the command
 * `{ isRunning: false, autoYes: { enabled: true } }`, a response no server
 * sends. Everything the command reads here is therefore produced by the real
 * route handlers — `GET …/current-output` (through `buildCurrentOutput`) and
 * `GET …/auto-yes` — behind a stubbed `fetch`, with the real Auto-Yes state
 * store underneath. Only the roster is written by hand: its shape is not what
 * this Issue is about, and the real route reads tmux and git to build it.
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
import { FIELDS_ABSENT_WHEN_NOT_RUNNING } from '../types/current-output-stopped-fields-3300';

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

const WORKTREE_ID = 'wt-3300';

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

function servedFor(suffix: string): ServedResponse[] {
  return served.filter((entry) => entry.pathname.endsWith(suffix));
}

function currentOutputFor(instanceId: string): Record<string, unknown> {
  const entry = servedFor('/current-output').find(
    (candidate) => new URLSearchParams(candidate.search).get('instance') === instanceId
  );
  if (!entry) throw new Error(`no current-output request for ${instanceId}`);
  return entry.body;
}

interface InstanceRowJson {
  instanceId: string;
  running: boolean;
  autoYes: boolean;
}

describe('commandmate instances: AUTO_YES against the real responses (Issue #3300)', () => {
  const originalFetch = global.fetch;
  let mockConsoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'main',
      path: '/path/to/wt-3300',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WORKTREE_ID, ROSTER.map((instance) => ({ ...instance })));

    vi.clearAllMocks();
    clearAllAutoYesStates();
    served = [];
    autoYesOverride = null;

    global.fetch = vi.fn(serve) as unknown as typeof fetch;
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    clearAllAutoYesStates();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
  });

  /**
   * What the command printed. The route handlers run in this process and their
   * logger writes to `console.log` too, so the command's own line is found by
   * how it starts rather than by position.
   */
  function printed(startsWith: string): string {
    const lines = (mockConsoleLog.mock.calls as unknown[][])
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith(startsWith));
    if (lines.length !== 1) {
      throw new Error(`expected one line starting with ${JSON.stringify(startsWith)}, got ${lines.length}`);
    }
    return lines[0];
  }

  async function listJson(): Promise<InstanceRowJson[]> {
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', WORKTREE_ID, '--json']);
    return JSON.parse(printed('[\n')) as InstanceRowJson[];
  }

  async function listTable(): Promise<string[]> {
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', WORKTREE_ID]);
    return printed('INSTANCE_ID').split('\n');
  }

  function row(rows: InstanceRowJson[], instanceId: string): InstanceRowJson {
    const found = rows.find((candidate) => candidate.instanceId === instanceId);
    if (!found) throw new Error(`no row for ${instanceId}`);
    return found;
  }

  /** Arm Auto-Yes the way `POST …/auto-yes` does, minus the poller it starts. */
  function arm(cliTool: 'claude' | 'codex', instanceId: string): void {
    setAutoYesEnabled(WORKTREE_ID, cliTool, true, undefined, undefined, instanceId);
  }

  it('prints yes for an armed instance whose session is not running', async () => {
    running('claude');
    arm('codex', 'codex');

    const rows = await listJson();

    expect(row(rows, 'codex')).toMatchObject({ running: false, autoYes: true });
    // The premise, read off what the route actually answered: without this the
    // assertion above could pass on a response that carried the key after all.
    const stopped = currentOutputFor('codex');
    expect(stopped.isRunning).toBe(false);
    expect(stopped).not.toHaveProperty('autoYes');
  });

  it('prints it in the table, on the stopped row only', async () => {
    running('claude');
    arm('codex', 'codex');

    const lines = await listTable();

    const header = lines[0].split(/\s{2,}/);
    const cells = (instanceId: string): string[] =>
      (lines.find((line) => line.startsWith(`${instanceId} `)) ?? '').split(/\s{2,}/);
    const runningAt = header.indexOf('RUNNING');
    const autoYesAt = header.indexOf('AUTO_YES');
    expect(cells('codex')[runningAt]).toBe('no');
    expect(cells('codex')[autoYesAt]).toBe('yes');
    expect(cells('claude')[runningAt]).toBe('yes');
    expect(cells('claude')[autoYesAt]).toBe('no');
  });

  // Negative controls: the rows that were right before stay right.
  it('prints no for a stopped instance that is not armed', async () => {
    running('claude');

    const rows = await listJson();

    expect(row(rows, 'codex')).toMatchObject({ running: false, autoYes: false });
    expect(row(rows, 'claude')).toMatchObject({ running: true, autoYes: false });
  });

  it('prints no once a stopped instance is disarmed', async () => {
    running('claude');
    arm('codex', 'codex');
    setAutoYesEnabled(WORKTREE_ID, 'codex', false, undefined, undefined, 'codex');

    const rows = await listJson();

    expect(row(rows, 'codex').autoYes).toBe(false);
  });

  it('still prints yes for an armed instance that is running', async () => {
    running('claude');
    arm('claude', 'claude');

    const rows = await listJson();

    expect(row(rows, 'claude')).toMatchObject({ running: true, autoYes: true });
    expect(row(rows, 'codex')).toMatchObject({ running: false, autoYes: false });
    // The two sources agree on a running session: same store, same key.
    expect(currentOutputFor('claude').autoYes).toMatchObject({ enabled: true });
  });

  it('asks for the Auto-Yes state once per listing, not once per instance', async () => {
    running('claude');

    await listJson();

    expect(servedFor('/current-output')).toHaveLength(ROSTER.length);
    expect(servedFor('/auto-yes')).toHaveLength(1);
    // The whole-worktree form: no `cliToolId`, so the answer is the map.
    expect(servedFor('/auto-yes')[0].search).toBe('');
    expect(servedFor('/auto-yes')[0].body.instances).toEqual({});
  });

  describe('what the route answers for the two sessions', () => {
    // The type suite holds these thirteen optional on both types; this holds the
    // reason — the route's own answer — so neither rests on reading the builder.
    it.each(FIELDS_ABSENT_WHEN_NOT_RUNNING)(
      'sends %s for the running session and omits it for the stopped one',
      async (field) => {
        running('claude');

        await listJson();

        expect(currentOutputFor('claude')).toHaveProperty(field);
        expect(currentOutputFor('codex')).not.toHaveProperty(field);
      },
    );

    it('answers the three exposure fields for a stopped session too', async () => {
      running('claude');

      await listJson();

      expect(currentOutputFor('codex')).toMatchObject({
        isRunning: false,
        composerText: null,
        composerState: 'no_composer',
        // Not a mode: nothing was read, because there is no frame.
        agentMode: 'unknown',
      });
    });
  });

  describe('against a server that does not answer with the per-instance map', () => {
    // What `instances` did before #3300, kept as the fallback: the listing is
    // still printed, and a running session's own reading is still believed.
    it('reads the running session\'s own autoYes when the request fails', async () => {
      running('claude');
      arm('claude', 'claude');
      arm('codex', 'codex');
      autoYesOverride = { status: 404, body: { error: 'Not found' } };

      const rows = await listJson();

      expect(row(rows, 'claude')).toMatchObject({ running: true, autoYes: true });
      // Not knowable from `current-output` alone — the pre-#3300 answer.
      expect(row(rows, 'codex')).toMatchObject({ running: false, autoYes: false });
    });

    it('reads it when the answer carries no `instances` map', async () => {
      running('claude');
      arm('claude', 'claude');
      // The route as it answered before per-instance state (#896).
      autoYesOverride = { status: 200, body: { enabled: true, expiresAt: null } };

      const rows = await listJson();

      expect(row(rows, 'claude')).toMatchObject({ running: true, autoYes: true });
      expect(row(rows, 'codex')).toMatchObject({ running: false, autoYes: false });
    });
  });
});
