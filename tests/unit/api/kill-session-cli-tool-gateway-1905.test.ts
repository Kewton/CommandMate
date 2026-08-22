/**
 * `kill-session` kills through the CLITool gateway (Issue #1905, design §4 D4).
 *
 * ## What was wrong
 *
 * `POST /api/worktrees/:id/kill-session` — the GUI stop button and
 * `commandmate instances <id> remove --kill` — read the session name off the
 * tool and then called `lib/tmux`'s `killSession` on it, so `ICLITool.killSession`
 * never ran. Everything a tool does *around* the tmux kill was therefore skipped:
 * most visibly OpenCode's, where the pane was destroyed while the SSE
 * subscription stayed open and the allocated port stayed recorded as in use, so
 * the reported symptom was a reconnect loop
 * (`opencode-subscription-disconnected … reason:"fetch failed"`) against a
 * server that no longer existed, and a restart on the same port that never
 * re-attached. `CopilotTool.killSession` was reachable from nowhere at all —
 * its only other caller, the Assistant session route, does not allow copilot —
 * which is why its own defects (#1905's tool-side half) went unnoticed.
 *
 * ## Why this file exists rather than trusting the lint rule
 *
 * #1922 put `src/lib/tmux/**` behind `no-restricted-imports` and put this route
 * on the allowlist; #1905 takes it off. But the rule only forbids an import
 * path. It cannot see the route reaching tmux through an allowlisted module,
 * and it says nothing about whether `cliTool.killSession` is *called* — a route
 * that dropped the kill entirely would satisfy it. §4 D4 names this gap and
 * asks for a positive test at the call. This is it: the gateway call is
 * measured, and the tool-specific shutdown is measured through the one tool
 * whose shutdown has an observable side effect outside tmux.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

/**
 * The whole tmux surface any tool's `killSession` can touch. Deliberately
 * complete: a partial mock would make a tool throw on an undefined binding, and
 * a route that swallowed that would look the same as one that never called the
 * tool at all.
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

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

// The opencode event pipeline: stubbed so nothing binds a port or opens a
// socket, but observable, because "was the stream released?" is the symptom.
vi.mock('@/lib/hooks/sources/opencode/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/runtime')>();
  return {
    ...actual,
    reserveOpencodeServerPort: vi.fn(() => Promise.resolve(null)),
    attachOpencodeEventStream: vi.fn(() => Promise.resolve(false)),
    resumeOpencodeEventStream: vi.fn(() => Promise.resolve(false)),
    releaseOpencodeEventStream: vi.fn(() => Promise.resolve(undefined)),
  };
});

vi.mock('@/lib/ws-server', () => ({ broadcast: vi.fn() }));

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
import { killSession as tmuxKillSession, sendKeys } from '@/lib/tmux/tmux';
import { releaseOpencodeEventStream } from '@/lib/hooks/sources/opencode/runtime';
import { OPENCODE_EXIT_COMMAND } from '@/lib/cli-tools/opencode';

const WORKTREE_ID = 'wt-gateway';
const ROUTE_SOURCE = 'src/app/api/worktrees/[id]/kill-session/route.ts';

function call(query = '') {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/kill-session${query}`,
    { method: 'POST' }
  );
  return POST(request, { params: Promise.resolve({ id: WORKTREE_ID }) });
}

/** Drive a request whose tools sleep through their graceful-exit waits. */
async function callWithTimers(query = ''): Promise<Response> {
  vi.useFakeTimers();
  try {
    const pending = call(query);
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

/** Only `cliToolId`'s primary instance is live; every other tool is idle. */
function onlyRunning(cliToolId: CLIToolType): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    vi.spyOn(manager.getTool(tool), 'isRunning').mockImplementation(async () => tool === cliToolId);
  }
}

/** Replace every tool's `killSession` with a recorder. */
function recordGatewayKills(): Array<[CLIToolType, string, string | undefined]> {
  const seen: Array<[CLIToolType, string, string | undefined]> = [];
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    vi.spyOn(manager.getTool(tool), 'killSession').mockImplementation(
      async (worktreeId: string, instanceId?: string) => {
        seen.push([tool, worktreeId, instanceId]);
      }
    );
  }
  return seen;
}

describe('POST /api/worktrees/:id/kill-session — the CLITool gateway (Issue #1905)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Gateway',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
  });

  describe('the call itself', () => {
    it('calls cliTool.killSession for the live target, with the worktree and instance', async () => {
      onlyRunning('opencode');
      const kills = recordGatewayKills();

      const response = await call('?cliTool=opencode&instance=opencode-2');

      expect(response.status).toBe(200);
      expect(kills).toEqual([['opencode', WORKTREE_ID, 'opencode-2']]);
    });

    /**
     * The half a lint rule cannot express. With every tool's `killSession`
     * stubbed out, a route that still reached tmux itself would show up as a
     * `killSession` call with nothing behind it.
     */
    it('does not kill the pane itself — the tmux kill belongs to the tool', async () => {
      onlyRunning('claude');
      recordGatewayKills();

      const response = await call('?cliTool=claude');

      expect(response.status).toBe(200);
      expect(tmuxKillSession).not.toHaveBeenCalled();
    });

    it('kills every live instance of the targeted tool, once each', async () => {
      const manager = CLIToolManager.getInstance();
      for (const tool of CLI_TOOL_IDS) {
        vi.spyOn(manager.getTool(tool), 'isRunning').mockImplementation(async () => tool === 'codex');
      }
      const kills = recordGatewayKills();

      const response = await call('?cliTool=codex');

      expect(response.status).toBe(200);
      expect(kills).toEqual([['codex', WORKTREE_ID, 'codex']]);
    });

    it('leaves a tool alone when nothing of it is running', async () => {
      onlyRunning('claude');
      const kills = recordGatewayKills();

      const response = await call('?cliTool=codex');

      expect(response.status).toBe(404);
      expect(kills).toEqual([]);
    });
  });

  describe('the tool-specific shutdown that the direct tmux kill skipped', () => {
    /**
     * The reported symptom, at the route. OpenCode's `killSession` closes the
     * SSE subscription and gives the port back; the old route destroyed the
     * pane without either, leaving a reconnect loop retrying a dead server.
     * `OpenCodeTool.killSession` is deliberately NOT stubbed here.
     */
    it('releases the opencode event stream and port', async () => {
      onlyRunning('opencode');

      const response = await callWithTimers('?cliTool=opencode');

      expect(response.status).toBe(200);
      expect(releaseOpencodeEventStream).toHaveBeenCalledWith({
        worktreeId: WORKTREE_ID,
        cliToolId: 'opencode',
        // The route seeds a tool's primary instance as instanceId === cliToolId.
        instanceId: 'opencode',
      });
    });

    it('sends the graceful /exit before the pane is destroyed', async () => {
      onlyRunning('opencode');

      await callWithTimers('?cliTool=opencode');

      const sessionName = CLIToolManager.getInstance()
        .getTool('opencode')
        .getSessionName(WORKTREE_ID, 'opencode');
      expect(sendKeys).toHaveBeenCalledWith(sessionName, OPENCODE_EXIT_COMMAND, false);
      expect(vi.mocked(sendKeys).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(tmuxKillSession).mock.invocationCallOrder[0]
      );
    });
  });

  describe('a tool that refuses to die', () => {
    it('reports 500 rather than archiving the messages of a pane that survived', async () => {
      onlyRunning('claude');
      vi.spyOn(CLIToolManager.getInstance().getTool('claude'), 'killSession').mockRejectedValue(
        new Error('tmux is wedged')
      );

      const response = await call('?cliTool=claude');

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        failedSessions: ['mcbd-claude-wt-gateway'],
      });
    });

    it('does not abandon the targets after it', async () => {
      const manager = CLIToolManager.getInstance();
      for (const tool of CLI_TOOL_IDS) {
        vi.spyOn(manager.getTool(tool), 'isRunning').mockResolvedValue(true);
      }
      const kills = recordGatewayKills();
      // The first tool in CLI_TOOL_IDS order throws; the rest must still run.
      const first = CLI_TOOL_IDS[0];
      vi.spyOn(manager.getTool(first), 'killSession').mockRejectedValue(new Error('nope'));

      const response = await call();

      expect(response.status).toBe(200);
      expect(kills.map((k) => k[0])).toEqual(CLI_TOOL_IDS.filter((t) => t !== first));
      await expect(response.json()).resolves.toMatchObject({
        failedSessions: [manager.getTool(first).getSessionName(WORKTREE_ID, first)],
      });
    });
  });

  describe('the import itself', () => {
    /**
     * Duplicated on purpose. `npm run lint` reads `.eslintrc.json`, and the
     * allowlist entry for this file was deleted by the same commit that removed
     * the import — so an edit that restores the import *and* the allowlist entry
     * would be silent in lint. It is not silent here.
     */
    it('does not import lib/tmux at all', () => {
      const source = readFileSync(join(process.cwd(), ROUTE_SOURCE), 'utf-8');
      const specifiers = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      const viaTmux = specifiers.filter((s) => s.split('/').includes('tmux'));
      expect(viaTmux).toEqual([]);
      // …and not through the dynamic spellings the core lint rule cannot see.
      expect(source).not.toMatch(/\b(?:import|require)\s*\(\s*['"][^'"]*\/tmux/);
    });
  });
});
