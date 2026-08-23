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
 * ## What Issue #1927 (DR2-003) narrowed, and why it shows up HERE
 *
 * #1927 stopped `mergeStructuredStatus` from raising `evidence` — a structured
 * `Stop` over a scraper `running` now clears `isUnclassifiedActive` only when
 * the scraper had something POSITIVE to say about the frame. That is a
 * deliberate decision (方針書 §5.2 補足 / §6.1 / §11's table A), not a side
 * effect: once `no_recent_output` publishes `running` instead of `ready`, BOTH
 * no-evidence routes reach that branch, and it would clear the #1708 hatch at
 * exactly the moment worth keeping it — the pane is unreadable AND the agent's
 * hooks say the turn is done.
 *
 * The unit twin of this file pins the payload fields. What only THIS file can
 * say is what the narrowing does to the command, because it feeds the real
 * `wait` the real payload. So #1723's headline claim is restated rather than
 * deleted, and it is now two claims instead of one:
 *
 *  - a `Stop` over a pane the scraper reads as busy (the interrupt affordance
 *    still on the chrome — #1723's own description of the case) still completes
 *    `wait` on the first poll, exactly as before;
 *  - a `Stop` over a pane NOTHING could read hands the session to the 60-second
 *    unclassified dwell and exit 10, which is the #1708 route the design chose
 *    over reporting a frame nobody understood as `Completed`.
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

/**
 * A frame the scraper reads as busy on POSITIVE evidence (Issue #1927).
 *
 * Claude's bottom chrome with the interrupt affordance still on it, which is
 * what a pane looks like in the seconds between the agent posting `Stop` and
 * the TUI repainting — i.e. #1723's own "the pane still looks busy after Stop".
 * `CLAUDE_INTERRUPT_HINT_PATTERN` matches it, so the verdict is
 * `running`/`thinking_indicator` with `evidence: 'positive'` and the structured
 * `ready` lands on a frame the scraper had already classified.
 */
const BUSY_FRAME = [
  'writing files',
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏸ manual mode on · esc to interrupt · ⇥ for agents',
].join('\n');

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
    // Issue #1927 (DR2-003): the hatch is NOT cleared here any more, and this
    // frame is why. `UNREADABLE_FRAME` carries no evidence of any kind, so
    // "the agent says it stopped" is the only thing anyone knows about it —
    // which is precisely the shape a missed dialog wears (#1708). The status
    // the agent reported is still published; what is no longer published is a
    // claim that the frame was understood.
    expect(after.statusEvidence).toBe('none');
    expect(after.isUnclassifiedActive).toBe(true);
    // #1722's diagnostic field still reports the raw event beside the verdict.
    expect(after.structuredEvents.lastEventType).toBe('stop');
  });

  it('clears the hatch when the pane the Stop landed on WAS readable', async () => {
    // The other half of DR2-003, end to end: the narrowing is a narrowing, not
    // a removal. A pane that still shows the interrupt affordance is a pane the
    // scraper positively classified, so the structured `ready` lands on a
    // verdict rather than on a blank, and everything #1723 promised holds.
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);

    const before = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(before.sessionStatus).toBe('running');
    expect(before.sessionStatusReason).toBe('thinking_indicator');
    expect(before.statusEvidence).toBe('positive');

    await postHookEvent('Stop');

    const after = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(after.sessionStatus).toBe('ready');
    expect(after.sessionStatusReason).toBe('hook_stop');
    expect(after.statusEvidence).toBe('positive');
    expect(after.isUnclassifiedActive).toBe(false);
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
    // Issue #1927 moved this test onto `BUSY_FRAME`. The claim it exists to
    // carry — "#1723's benefit reaches `wait`" — is about a pane that still
    // looks busy when the agent's `Stop` arrives, and after DR2-003 that claim
    // holds for a pane the scraper could read. Running it on a frame nothing
    // can classify would have been testing the #1708 dwell instead, which is
    // the test below.
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);

    await postHookEvent('Stop');
    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(payload.isUnclassifiedActive).toBe(false);

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

  it('hands an unreadable pane to the 60s dwell instead of reporting Completed', async () => {
    // The behaviour DR2-003 chose, at the layer an operator actually meets it.
    // The agent posted `Stop`, so `sessionStatus` is `ready` — but nothing
    // could read the pane, and `wait`'s completion check is suppressed while
    // the hatch is up. After the existing 60-second dwell it exits 10 with the
    // `unclassified` payload #1708 designed, which tells the operator to look
    // at the pane. No new timer and no new exit code (§4 D1 決定 2).
    await postHookEvent('Stop');
    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(payload.sessionStatus).toBe('ready');
    expect(payload.isUnclassifiedActive).toBe(true);

    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // 60s of dwell at a 5s poll interval, plus slack: the same payload every time.
    mockFetchSequence(Array.from({ length: 20 }, () => ({ data: payload })));

    const { createWaitCommand } = await import('../../src/cli/commands/wait');
    const promise = createWaitCommand().parseAsync(['node', 'wait', WORKTREE_ID]);
    await vi.advanceTimersByTimeAsync(70_000);
    await promise;

    expect(exit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Unclassified interactive frame'),
    );
    // The prompt payload the skill layer reads off stdout.
    const printed = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(JSON.parse(printed)).toMatchObject({ type: 'unclassified', options: [] });

    exit.mockRestore();
    consoleError.mockRestore();
    log.mockRestore();
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
