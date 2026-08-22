/**
 * `commandmate auto-yes <id> --enable` arms the worktree's agent (Issue #1909).
 *
 * The command and the route are driven together here — the real command, its
 * real ApiClient, and the real route handler behind a stubbed `fetch` — because
 * the bug lived in the seam between them and each half looks correct alone.
 * The CLI sends no `cliToolId` when neither `--agent` nor `--instance` is
 * given, which is right: the server owns the precedence chain (design §4 D5
 * 決定 1). The route then ended its own resolution in `?? 'claude'`, so "the
 * request named no agent" became "claude" instead of the worktree default. A
 * copilot worktree got a claude poller, `commandmate auto-yes` exited 0, and
 * the only evidence was `Claude Code session ... does not exist` repeating in
 * the server log while copilot's dialogs went unanswered.
 *
 * So the assertions are the two things an operator can see: the exit code, and
 * the (cliToolId, instanceId) the poller was started for.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import type { CLIToolType } from '@/lib/cli-tools/types';
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
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
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

/**
 * Issue #1898-2's re-check runs inside the POST this test drives. Mocked so the
 * CLI's report of it can be asserted; unmocked it answers `resync-unsupported`
 * for copilot and prints nothing.
 */
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(),
}));

import { GET, POST } from '@/app/api/worktrees/[id]/auto-yes/route';
import { recheckPendingDecisions } from '@/lib/hooks/pending-decision-recheck';
import { GET as RESOLVE_TARGET } from '@/app/api/worktrees/[id]/resolve-target/route';
import { GET as CAPABILITIES } from '@/app/api/capabilities/route';
import { startAutoYesPolling, clearAllAutoYesStates } from '@/lib/polling/auto-yes-manager';

const WORKTREE_ID = 'wt-cli-1909';

let mockExit: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
const originalFetch = global.fetch;

/** The (cliToolId, instanceId) pair `startAutoYesPolling` was last asked for. */
function armedTarget(): { cliToolId: string; instanceId: string | undefined } {
  const calls = vi.mocked(startAutoYesPolling).mock.calls;
  expect(calls.length).toBe(1);
  const [, cliToolId, instanceId] = calls[0];
  return { cliToolId, instanceId };
}

/** Every line the command wrote to stderr, joined. */
function stderr(): string {
  return consoleErrorSpy.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
}

async function runAutoYes(...args: string[]): Promise<void> {
  const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
  await createAutoYesCommand().parseAsync(['node', 'auto-yes', WORKTREE_ID, ...args]);
}

async function setUpDb(worktreeCliTool: CLIToolType): Promise<Database.Database> {
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'CLI auto-yes',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'repo',
    cliToolId: worktreeCliTool,
  };
  upsertWorktree(db, worktree);
  return db;
}

describe('commandmate auto-yes --enable against the real route (Issue #1909)', () => {
  beforeEach(async () => {
    await setUpDb('copilot');
    clearAllAutoYesStates();
    vi.clearAllMocks();

    // Route the CLI's HTTP calls into the handlers in this process. Anything
    // outside this list should fail loudly rather than be invented here.
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const params = { params: Promise.resolve({ id: WORKTREE_ID }) };
      if (url.pathname === '/api/capabilities') {
        return CAPABILITIES() as unknown as Response;
      }
      if (url.pathname.endsWith('/resolve-target')) {
        return RESOLVE_TARGET(new NextRequest(url, { method: 'GET' }), params) as unknown as Response;
      }
      if (url.pathname.endsWith('/auto-yes')) {
        const method = (init?.method ?? 'GET').toUpperCase();
        const request = new NextRequest(url, { method, body: init?.body as string | undefined });
        return (method === 'POST' ? POST(request, params) : GET(request, params)) as unknown as Response;
      }
      throw new Error(`unexpected request from auto-yes: ${url.pathname}`);
    }) as unknown as typeof fetch;

    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(recheckPendingDecisions).mockResolvedValue({
      examined: 0, delivered: 0, skipped: 0, reason: 'no-pending',
    });
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    clearAllAutoYesStates();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
  });

  /** The Issue's reproduction, end to end. */
  it('starts the copilot poller on a copilot worktree and exits 0', async () => {
    await runAutoYes('--enable');

    expect(armedTarget()).toEqual({ cliToolId: 'copilot', instanceId: 'copilot' });
    expect(mockExit).not.toHaveBeenCalled();
  });

  /** The choice was invisible before; now the command says which agent it armed. */
  it('names the agent it armed on stderr', async () => {
    await runAutoYes('--enable');

    expect(stderr()).toContain(`Auto-yes enabled for ${WORKTREE_ID} (copilot).`);
  });

  it('names the instance too when it is not the agent\'s primary', async () => {
    const db = await setUpDb('copilot');
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'oc-2', cliTool: 'opencode', alias: 'OpenCode 2', order: 0 },
    ]);
    vi.clearAllMocks();

    await runAutoYes('--enable', '--instance', 'oc-2');

    expect(armedTarget()).toEqual({ cliToolId: 'opencode', instanceId: 'oc-2' });
    expect(stderr()).toContain(`Auto-yes enabled for ${WORKTREE_ID} (opencode, instance oc-2).`);
    // Resolved by the server, not by the CLI's compatibility path (DR2-008):
    // `client-fallback` has no primary-anchor stage and is a degradation.
    expect(stderr()).not.toContain('client-fallback');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('still honours an explicit --agent', async () => {
    await runAutoYes('--enable', '--agent', 'codex');

    expect(armedTarget()).toEqual({ cliToolId: 'codex', instanceId: 'codex' });
    expect(stderr()).toContain('(codex)');
  });

  /**
   * `--disable` with no target disables every instance of the worktree, so the
   * response names no agent and the message must not invent one.
   */
  it('reports a bare --disable without naming an agent', async () => {
    await runAutoYes('--enable');
    consoleErrorSpy.mockClear();

    await runAutoYes('--disable');

    expect(stderr()).toContain(`Auto-yes disabled for ${WORKTREE_ID}.`);
    expect(mockExit).not.toHaveBeenCalled();
  });

  /**
   * A server that predates #1909 answers with none of the new fields. The CLI
   * must keep the old sentence rather than print `(undefined)` — the absence is
   * "this daemon does not say", which is also "this daemon still arms claude".
   */
  it('falls back to the agent-less message when the server names none', async () => {
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({ enabled: true, expiresAt: Date.now() + 3600000 }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as unknown as typeof fetch;

    await runAutoYes('--enable');

    expect(stderr()).toContain(`Auto-yes enabled for ${WORKTREE_ID}.`);
    expect(stderr()).not.toContain('undefined');
  });
});

/**
 * The CLI half of the #1909 × #1898 seam: one arming, two things worth saying.
 *
 * `Auto-yes enabled for … (copilot).` answers "which agent did this arm"
 * (#1909); `Re-judged N pending approval(s)` answers "and did it unstick the
 * worker that was already blocked" (#1898-2). Both are stderr lines from the
 * same command, and a conflict resolution that keeps only one of them is green
 * everywhere else.
 */
describe('commandmate auto-yes --enable reports both halves (#1898 × #1909)', () => {
  beforeEach(async () => {
    await setUpDb('copilot');
    clearAllAutoYesStates();
    vi.clearAllMocks();

    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const params = { params: Promise.resolve({ id: WORKTREE_ID }) };
      if (url.pathname === '/api/capabilities') return CAPABILITIES() as unknown as Response;
      if (url.pathname.endsWith('/auto-yes')) {
        const method = (init?.method ?? 'GET').toUpperCase();
        const request = new NextRequest(url, { method, body: init?.body as string | undefined });
        return (method === 'POST' ? POST(request, params) : GET(request, params)) as unknown as Response;
      }
      throw new Error(`unexpected request from auto-yes: ${url.pathname}`);
    }) as unknown as typeof fetch;

    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    clearAllAutoYesStates();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
  });

  it('names the agent it armed and the approvals it answered on the way in', async () => {
    vi.mocked(recheckPendingDecisions).mockResolvedValue({
      examined: 2, delivered: 2, skipped: 0, reason: null,
    });

    await runAutoYes('--enable');

    expect(armedTarget()).toEqual({ cliToolId: 'copilot', instanceId: 'copilot' });
    expect(stderr()).toContain(`Auto-yes enabled for ${WORKTREE_ID} (copilot).`);
    expect(stderr()).toContain('Re-judged 2 pending approval(s): 2 answered.');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('reports the bounded pass when the agent had more than the cap', async () => {
    vi.mocked(recheckPendingDecisions).mockResolvedValue({
      examined: 50, delivered: 50, skipped: 7, reason: null,
    });

    await runAutoYes('--enable');

    expect(stderr()).toContain('Re-judged 50 pending approval(s): 50 answered, 7 skipped (limit).');
  });

  it('stays silent about approvals when there were none, but still names the agent', async () => {
    vi.mocked(recheckPendingDecisions).mockResolvedValue({
      examined: 0, delivered: 0, skipped: 0, reason: 'no-pending',
    });

    await runAutoYes('--enable');

    expect(stderr()).toContain(`Auto-yes enabled for ${WORKTREE_ID} (copilot).`);
    expect(stderr()).not.toContain('Re-judged');
  });
});
