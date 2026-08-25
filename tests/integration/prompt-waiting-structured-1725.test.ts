/**
 * The open-dialog pipeline, end to end (Issue #1725).
 *
 * The units are covered elsewhere. What is only visible here is that the pieces
 * are actually connected: the *real* `Notification(permission_prompt)` payload
 * — the file captured off a live v2.1.223 session in #1721 — posted the way an
 * injected `type: "http"` hook posts it, reaches `agent-event-state`,
 * `buildCurrentOutput` reads it back, and the payload it produces is one that
 * `commandmate wait` exits 10 on.
 *
 * The fixture is used verbatim rather than a hand-written body on purpose. The
 * matcher is tested against `notification_type`, not the human-facing `message`
 * (D3), and a test that posts a body of its own invention cannot notice if that
 * ever stops being true.
 *
 * Every positive case is paired with the same frame minus the event. Without
 * that control, "wait exits 10" proves nothing — the frame might have produced
 * it anyway.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getMessages } from '@/lib/db';
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
import { buildClaude1000RowPermissionFrame } from '../fixtures/claude-1000-row-prompt';

const WORKTREE_ID = 'wt-1725';
const INSTANCE_ID = 'claude';
const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');

/** The frame that made #1708 possible: interactive, and unreadable. */
const UNREADABLE_FRAME = 'writing files\nediting src/app/page.tsx\n';

let db: Database.Database;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>;
}

/** Post a captured payload exactly as an injected `type: "http"` hook does. */
async function postFixture(name: string): Promise<void> {
  const url =
    `http://127.0.0.1:3000/api/hooks/agent-event` +
    `?tool=claude&worktreeId=${WORKTREE_ID}&instanceId=${INSTANCE_ID}`;
  const request = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `cwd` in the fixture is the placeholder `<CWD>`; the URL carries the
    // correlation keys, which is what an injected hook actually relies on.
    body: JSON.stringify({ ...fixture(name), cwd: undefined }),
  });
  const response = await agentEvent(request as unknown as import('next/server').NextRequest);
  expect(response.status).toBe(202);
}

/** Run `commandmate wait` against a payload the server just built. */
async function runWait(
  payload: unknown,
  args: string[] = [],
): Promise<{ exitCode: unknown; stdout: string[]; stderr: string[] }> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  mockFetchSequence([{ data: payload }]);

  const { createWaitCommand } = await import('../../src/cli/commands/wait');
  await createWaitCommand().parseAsync(['node', 'wait', WORKTREE_ID, ...args]);

  const result = {
    exitCode: exit.mock.calls[0]?.[0],
    stdout: log.mock.calls.map((c) => String(c[0])),
    stderr: error.mock.calls.map((c) => String(c[0])),
  };
  exit.mockRestore();
  log.mockRestore();
  error.mockRestore();
  return result;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  (setMockDb as (d: Database.Database) => void)(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-1725',
    path: '/path/to/wt-1725',
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
  vi.useRealTimers();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  db.close();
  clearAgentStopEvents();
});

describe('Issue #1725: a posted permission notification reaches current-output', () => {
  it('turns an unreadable frame into a prompt nobody could parse', async () => {
    const before = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(before.isPromptWaiting).toBe(false);
    expect(before.promptData).toBeNull();
    expect(before.sessionStatus).toBe('running');

    await postFixture('notification-permission-prompt.json');

    const after = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(after.isPromptWaiting).toBe(true);
    expect(after.sessionStatus).toBe('waiting');
    expect(after.sessionStatusReason).toBe('hook_permission_prompt');
    expect(after.promptData).toMatchObject({
      type: 'unclassified',
      status: 'pending',
      options: [],
      source: 'notification',
      // Carried through from the captured payload, for display only.
      message: 'Claude needs your permission',
    });
    expect(after.structuredEvents.promptWaitingSource).toBe('notification');
  });

  it('does nothing for the idle notification captured from the same session', async () => {
    // Both are `Notification`s; only `notification_type` tells them apart, and
    // `message` — "Claude is waiting for your input" — is prose that reads like
    // a prompt but is not one.
    await postFixture('notification-idle-prompt.json');

    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(payload.isPromptWaiting).toBe(false);
    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('hook_idle_prompt');
  });

  it('releases on the Stop the agent posts when the turn resumes', async () => {
    await postFixture('notification-permission-prompt.json');
    expect((await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID)).isPromptWaiting)
      .toBe(true);

    await postFixture('stop.json');

    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(payload.isPromptWaiting).toBe(false);
    expect(payload.sessionStatus).toBe('ready');
  });

  it('does not answer for an instance that posted nothing', async () => {
    await postFixture('notification-permission-prompt.json');

    const other = await buildCurrentOutput(db, WORKTREE_ID, 'claude', 'claude-2');
    expect(other.isPromptWaiting).toBe(false);
  });

  it('publishes the dialog on structuredEvents.pendingDecisions (Issue #1930)', async () => {
    // §7's discoverability rule: `commandmate capture --json` prints this
    // payload verbatim, so a dialog that only exists in `isPromptWaiting` gives
    // an operator no way to tell two concurrent approvals apart. `#1932` is what
    // teaches `respond` to name the `id`.
    await postFixture('notification-permission-prompt.json');

    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    const decisions = payload.structuredEvents.pendingDecisions ?? [];

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      source: 'notification',
      confirmedAt: expect.any(Number),
      scraperCorroborated: false,
      // claude declares `decisionTimeoutSeconds: 600`, and this record is
      // seconds old, so the server can still answer it.
      deliveryExpired: false,
    });
    // The agent's own `tool_input` is not on the wire, and neither is anything
    // else the payload carried: only the keys the published type declares.
    // Issue #2040 added `kind` and `questionOptions` — an approval, and null,
    // here — and this list is what makes such an addition deliberate rather than
    // incidental.
    expect(Object.keys(decisions[0]).sort()).toEqual([
      'at',
      'confirmedAt',
      'deliveryExpired',
      'id',
      'kind',
      'questionOptions',
      'scraperCorroborated',
      'source',
      'toolName',
    ]);
    expect(decisions[0]).toMatchObject({ kind: 'permission', questionOptions: null });

    // The two bookkeeping blocks travel with it: zeroed rather than absent, so
    // an operator reading a healthy payload knows where to look when it is not.
    expect(payload.structuredEvents.dedupDropped).toMatchObject({
      dedupDropped: { identity: 0, timeWindow: 0 },
      decisionEvicted: 0,
      idsDiscarded: 0,
    });
    expect(payload.structuredEvents.dialogPendingMaxMs).toEqual({
      predicted: 20_000,
      confirmed: 30 * 60 * 1000,
    });
  });

  it('empties pendingDecisions when the agent resumes the turn (Issue #1930)', async () => {
    await postFixture('notification-permission-prompt.json');
    expect((await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID))
      .structuredEvents.pendingDecisions).toHaveLength(1);

    await postFixture('stop.json');

    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(payload.structuredEvents.pendingDecisions).toEqual([]);
  });
});

describe('Issue #1725: `commandmate wait` stops on it', () => {
  it('exits 10 on the payload the notification produced', async () => {
    await postFixture('notification-permission-prompt.json');
    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);

    const { exitCode, stdout } = await runWait(payload);

    expect(exitCode).toBe(WaitExitCode.PROMPT_DETECTED);
    const output = JSON.parse(stdout[0]);
    expect(output).toMatchObject({
      worktreeId: WORKTREE_ID,
      type: 'unclassified',
      status: 'pending',
      options: [],
    });
    expect(output.question).toContain(`commandmate respond ${WORKTREE_ID} <number>`);
  });

  it('would NOT have stopped on the same frame without the event', async () => {
    // The control. Same capture, same everything — only the event is missing —
    // and the command keeps polling, which is the #1708 stall and the behaviour
    // that must survive on machines where no hook ever fires.
    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    expect(payload.isPromptWaiting).toBe(false);

    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchSequence([{ data: payload }, { data: { ...payload, isRunning: false } }]);

    const { createWaitCommand } = await import('../../src/cli/commands/wait');
    const promise = createWaitCommand().parseAsync(['node', 'wait', WORKTREE_ID]);
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(exit).not.toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    exit.mockRestore();
    consoleError.mockRestore();
  });

  it('keeps waiting under --on-prompt human', async () => {
    await postFixture('notification-permission-prompt.json');
    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);

    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The second poll is the session back at its composer: the dialog answered,
    // and the frame readable again (`ready`/`input_prompt` raises none of the
    // flags that suppress completion).
    mockFetchSequence([
      { data: payload },
      {
        data: {
          ...payload,
          isPromptWaiting: false,
          promptData: null,
          sessionStatus: 'ready',
          sessionStatusReason: 'input_prompt',
          isUnclassifiedActive: false,
        },
      },
    ]);

    const { createWaitCommand } = await import('../../src/cli/commands/wait');
    const promise = createWaitCommand().parseAsync([
      'node', 'wait', WORKTREE_ID, '--on-prompt', 'human',
    ]);
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(exit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(consoleError.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      `Prompt detected on ${WORKTREE_ID}`,
    );
    exit.mockRestore();
    consoleError.mockRestore();
  });
});

describe('Issue #1725: the gap lands in the prompt history `capture --prompts` reads', () => {
  it('writes one row naming the structured source', async () => {
    await postFixture('notification-permission-prompt.json');

    await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);

    const prompts = getMessages(db, WORKTREE_ID).filter((m) => m.messageType === 'prompt');
    expect(prompts).toHaveLength(1);
    const data = prompts[0].promptData as unknown as Record<string, unknown>;
    expect(data).toMatchObject({
      type: 'unclassified',
      // Never `pending`: markPendingPromptsAsAnswered() selects on that value.
      status: 'unclassified',
      source: 'notification',
    });
    expect(String(prompts[0].content)).toContain('commandmate respond');
  });

  it('writes nothing when the scraper published the prompt itself', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
    await postFixture('notification-permission-prompt.json');

    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);

    // The scraper's parsed prompt is the one published — it has options, so it
    // is the one a user can answer.
    expect(payload.promptData?.type).toBe('multiple_choice');
    expect(getMessages(db, WORKTREE_ID).filter((m) => m.messageType === 'prompt')).toHaveLength(0);
  });
});
