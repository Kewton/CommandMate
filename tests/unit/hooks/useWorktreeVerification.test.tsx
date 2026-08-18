/**
 * @vitest-environment jsdom
 *
 * Tests for useWorktreeVerification (Issue #1816).
 *
 * The two behaviours worth pinning are the ones the Issue's design constraints
 * name: the hook must carry no timer of its own (refreshes happen only when the
 * owner's poll tick arrives, and only outside the idle window), and pressing
 * Re-verify must close the loop — the route answers 202 with a run id and no
 * verdict, so the list has to be re-read for anything to change on screen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useWorktreeVerification,
  VERIFICATION_IDLE_REFRESH_MS,
} from '@/hooks/useWorktreeVerification';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

interface Fixture {
  tasks: unknown[];
  runs: unknown[];
  run: unknown | null;
  /** Status/body for POST /verify. */
  verify: { status: number; body: unknown };
}

const fixture: Fixture = {
  tasks: [],
  runs: [],
  run: null,
  verify: { status: 202, body: { runId: 99 } },
};

/** Counts, per endpoint kind, so throttling can be asserted without timers. */
const calls = { tasks: 0, runs: 0, run: 0, verify: 0 };

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function install(): void {
  mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      calls.verify += 1;
      return Promise.resolve(json(fixture.verify.status, fixture.verify.body));
    }
    if (url.includes('/tasks')) {
      calls.tasks += 1;
      return Promise.resolve(json(200, { tasks: fixture.tasks }));
    }
    if (/\/verify\/runs\/\d+/.test(url)) {
      calls.run += 1;
      return fixture.run === null
        ? Promise.resolve(json(404, { error: 'Verification run not found' }))
        : Promise.resolve(json(200, { run: fixture.run }));
    }
    if (url.includes('/verify/runs')) {
      calls.runs += 1;
      return Promise.resolve(json(200, { runs: fixture.runs }));
    }
    return Promise.resolve(json(200, {}));
  });
}

const TASK = {
  id: 'task-1',
  worktreeId: 'wt-1',
  title: 'Issue #1816',
  goal: 'expose verification in the Web UI',
  status: 'running',
  contractPath: '.commandmate/tasks/issue-1816.yaml',
  contract: {
    version: 1,
    title: 'Issue #1816',
    goal: 'expose verification in the Web UI',
    scope: { allow: ['src/**'], deny: [] },
    verify: { gates: null },
    autoYes: { mode: 'safe', allowPromptTypes: [], denyPatterns: [] },
    success: { requireWorkEvidence: true, requireScopeClean: true },
  },
  updatedAt: '2026-08-18T00:00:00.000Z',
};

const RUN_9 = {
  id: 9,
  worktreeId: 'wt-1',
  instanceId: null,
  taskId: 'task-1',
  trigger: 'api',
  status: 'failed',
  baseRef: 'origin/develop',
  startedAt: '2026-08-18T00:01:00.000Z',
  finishedAt: '2026-08-18T00:02:00.000Z',
};

describe('useWorktreeVerification (Issue #1816)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.tasks = 0;
    calls.runs = 0;
    calls.run = 0;
    calls.verify = 0;
    fixture.tasks = [];
    fixture.runs = [];
    fixture.run = null;
    fixture.verify = { status: 202, body: { runId: 99 } };
    install();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('loads the latest task and the run list, selecting the newest run', async () => {
    fixture.tasks = [TASK];
    fixture.runs = [RUN_9, { ...RUN_9, id: 8, status: 'passed' }];
    fixture.run = { ...RUN_9, gates: [{ id: 1, runId: 9, gateId: 'unit', status: 'failed' }] };

    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.task?.id).toBe('task-1');
    expect(result.current.runs).toHaveLength(2);
    expect(result.current.latestRun?.id).toBe(9);
    // The newest run is selected without the user picking one, so the gate
    // table opens on the verdict the header chip is reporting.
    expect(result.current.selectedRunId).toBe(9);
    await waitFor(() => expect(result.current.selectedRun?.gates).toHaveLength(1));
  });

  it('reports an empty worktree as empty, not as an error', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.task).toBeNull();
    expect(result.current.runs).toEqual([]);
    expect(result.current.selectedRunId).toBeNull();
    expect(result.current.error).toBeNull();
    // No run selected → no detail request at all.
    expect(calls.run).toBe(0);
  });

  it('surfaces a list failure as an error string', async () => {
    mockFetch.mockResolvedValue(json(500, { error: 'boom' }));

    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.loading).toBe(false);
  });

  it('does not refetch on a poll tick inside the idle window', async () => {
    fixture.tasks = [TASK];
    const { result, rerender } = renderHook(
      ({ token }: { token: number }) =>
        useWorktreeVerification({ worktreeId: 'wt-1', refreshToken: token }),
      { initialProps: { token: 0 } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(calls.runs).toBe(1);

    rerender({ token: 1 });
    rerender({ token: 2 });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Three ticks, one request: the hook rides the parent's cadence but is not
    // obliged to answer every beat of it.
    expect(calls.runs).toBe(1);
  });

  it('refetches once the idle window has elapsed', async () => {
    fixture.tasks = [TASK];
    const now = vi.spyOn(Date, 'now');
    const base = 1_000_000;
    now.mockReturnValue(base);

    const { result, rerender } = renderHook(
      ({ token }: { token: number }) =>
        useWorktreeVerification({ worktreeId: 'wt-1', refreshToken: token }),
      { initialProps: { token: 0 } }
    );
    await waitFor(() => expect(calls.runs).toBe(1));

    now.mockReturnValue(base + VERIFICATION_IDLE_REFRESH_MS + 1);
    rerender({ token: 1 });

    await waitFor(() => expect(calls.runs).toBe(2));
    expect(result.current.error).toBeNull();
  });

  it('follows the poll tick without waiting while a run is still running', async () => {
    fixture.tasks = [TASK];
    fixture.runs = [{ ...RUN_9, status: 'running', finishedAt: null }];
    fixture.run = { ...RUN_9, status: 'running', finishedAt: null, gates: [] };

    const { result, rerender } = renderHook(
      ({ token }: { token: number }) =>
        useWorktreeVerification({ worktreeId: 'wt-1', refreshToken: token }),
      { initialProps: { token: 0 } }
    );

    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    const before = calls.runs;

    rerender({ token: 1 });
    await waitFor(() => expect(calls.runs).toBe(before + 1));
  });

  it('re-verify POSTs, selects the new run, and re-reads the list (202 → refetch)', async () => {
    fixture.tasks = [TASK];
    fixture.runs = [RUN_9];
    fixture.run = { ...RUN_9, gates: [] };

    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const runsBefore = calls.runs;

    // The new run the server would create for this request.
    fixture.verify = { status: 202, body: { runId: 10 } };
    fixture.runs = [{ ...RUN_9, id: 10, status: 'running', finishedAt: null }, RUN_9];

    await act(async () => {
      await result.current.rerun();
    });

    expect(calls.verify).toBe(1);
    // The 202 carries no verdict, so the list is what closes the loop.
    await waitFor(() => expect(calls.runs).toBe(runsBefore + 1));
    await waitFor(() => expect(result.current.latestRun?.id).toBe(10));
    expect(result.current.selectedRunId).toBe(10);
    expect(result.current.rerunFailure).toBeNull();
    expect(result.current.rerunPending).toBe(false);
  });

  it('reports a 409 as a conflict naming the run already in flight', async () => {
    fixture.tasks = [TASK];
    fixture.verify = {
      status: 409,
      body: { error: 'Verification already running', runningRunId: 7 },
    };

    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.rerun();
    });

    expect(result.current.rerunFailure).toEqual({
      kind: 'conflict',
      message: 'Verification already running',
      runningRunId: 7,
    });
  });

  it('drops the previous worktree\'s rows when the branch changes', async () => {
    fixture.tasks = [TASK];
    fixture.runs = [RUN_9];
    fixture.run = { ...RUN_9, gates: [] };

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useWorktreeVerification({ worktreeId: id }),
      { initialProps: { id: 'wt-1' } }
    );
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    fixture.tasks = [];
    fixture.runs = [];
    fixture.run = null;
    rerender({ id: 'wt-2' });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.task).toBeNull();
    expect(result.current.runs).toEqual([]);
    expect(result.current.selectedRunId).toBeNull();
  });

  it('fetches nothing while disabled', async () => {
    renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1', enabled: false }));
    await waitFor(() => expect(calls.tasks).toBe(0));
    expect(calls.runs).toBe(0);
  });
});
