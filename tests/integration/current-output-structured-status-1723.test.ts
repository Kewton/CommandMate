/**
 * The structured event pipeline, end to end (Issue #1723).
 *
 * The units are covered elsewhere. What is only visible here is that the three
 * pieces are actually connected: a `Stop` posted the way an injected hook posts
 * it reaches `agent-event-state`, `buildCurrentOutput` reads it back, and the
 * payload it produces is one that `commandmate wait` — which this Issue does
 * not modify a line of — treats as a completion.
 *
 * The last step is the one worth having. Issue #1723's claim that `wait` and
 * the Auto-Yes poller "receive the benefit with no change" is otherwise an
 * assertion about code nobody ran; here the payload the builder produced is
 * literally what the command consumes.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { mockFetchSequence, restoreFetch } from '../helpers/mock-api';
import { WaitExitCode } from '../../src/cli/types';

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
      mockDb = null;
    },
  };
});

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...a: unknown[]) => isRunning(...a) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));

import { POST as agentEvent } from '@/app/api/hooks/agent-event/route';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';

const WORKTREE_ID = 'wt-1723';
const INSTANCE_ID = 'claude';

/**
 * A frame with no generation indicator in it — the shape that made a finished
 * turn read as still running, and a running turn read as finished.
 */
const UNREADABLE_FRAME = 'writing files\nediting src/app/page.tsx\n';

let db: Database.Database;

/**
 * Post an event exactly as an injected `type: "http"` hook does: Claude's own
 * payload verbatim, with the correlation keys in the URL (Issue #1722).
 */
async function postHookEvent(hookEventName: string, extra: Record<string, unknown> = {}) {
  const url =
    `http://127.0.0.1:3000/api/hooks/agent-event` +
    `?tool=claude&worktreeId=${WORKTREE_ID}&instanceId=${INSTANCE_ID}`;
  const request = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: hookEventName, session_id: 'sess-1723', ...extra }),
  });
  const response = await agentEvent(request as unknown as import('next/server').NextRequest);
  expect(response.status).toBe(202);
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  (setMockDb as (d: Database.Database) => void)(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-1723',
    path: '/path/to/wt-1723',
    repositoryPath: '/path/to/repo',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);

  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);
});

afterEach(async () => {
  restoreFetch();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  db.close();
  clearAgentStopEvents();
});

describe('Issue #1723: a posted Stop reaches current-output', () => {
  it('is running before the event and ready/hook_stop after it', async () => {
    const before = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(before.sessionStatus).toBe('running');
    expect(before.sessionStatusReason).toBe('default');

    await postHookEvent('Stop');

    const after = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(after.sessionStatus).toBe('ready');
    expect(after.sessionStatusReason).toBe('hook_stop');
    expect(after.isGenerating).toBe(false);
    expect(after.isUnclassifiedActive).toBe(false);
    // #1722's diagnostic field still reports the raw event beside the verdict.
    expect(after.structuredEvents.lastEventType).toBe('stop');
  });

  it('keeps the session running after a UserPromptSubmit', async () => {
    await postHookEvent('UserPromptSubmit');

    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(payload.sessionStatus).toBe('running');
    expect(payload.sessionStatusReason).toBe('hook_prompt_submit');
  });

  it('hands the session back to the scraper when the agent session ends', async () => {
    await postHookEvent('Stop');
    expect((await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID)).sessionStatusReason)
      .toBe('hook_stop');

    // `/clear`: the pane and the instance survive, the agent session does not.
    await postHookEvent('SessionEnd', { reason: 'clear' });

    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(payload.sessionStatus).toBe('running');
    expect(payload.sessionStatusReason).toBe('default');
  });

  it('does not answer for an instance that posted nothing', async () => {
    await postHookEvent('Stop');

    const other = await buildCurrentOutput(db, WORKTREE_ID, 'claude', 'claude-2');
    expect(other.sessionStatusReason).toBe('default');
  });
});

describe('Issue #1723: the benefit reaches `commandmate wait` unchanged', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes on the payload a posted Stop produces', async () => {
    await postHookEvent('Stop');
    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The payload the server just built, fed to the command verbatim.
    mockFetchSequence([{ data: payload }]);

    const { createWaitCommand } = await import('../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', WORKTREE_ID]);

    expect(exit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(`Completed: ${WORKTREE_ID}`));

    exit.mockRestore();
    consoleError.mockRestore();
  });

  it('would NOT have completed on the same frame without the event', async () => {
    // The control. Same capture, same everything — only the event is missing —
    // and the command keeps waiting, which is what it did before this Issue and
    // what it must keep doing on machines where no hook fires.
    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(payload.sessionStatusReason).toBe('default');

    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stopped = { ...payload, isRunning: false };
    mockFetchSequence([{ data: payload }, { data: stopped }]);

    const { createWaitCommand } = await import('../../src/cli/commands/wait');
    const promise = createWaitCommand().parseAsync(['node', 'wait', WORKTREE_ID]);
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    // It took the second poll — the session going away — to finish.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Waiting:'));
    expect(exit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    exit.mockRestore();
    consoleError.mockRestore();
  });
});
