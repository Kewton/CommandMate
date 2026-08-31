/**
 * @vitest-environment jsdom
 *
 * useWorktreeVerification — gate selection, cancel and history (Issue #2063).
 *
 * The acceptance criterion these cover is the one about the *request*: "re-run
 * only the failed gates" has to send a `gateIds` equal to the previous run's
 * failing set, and the untouched default has to keep sending no `gateIds` at
 * all. Both are properties of the body that leaves the browser, so the fetch
 * mock records bodies rather than the hook's own state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWorktreeVerification } from '@/hooks/useWorktreeVerification';
import type { VerifyConfigResponse } from '@/lib/api/verification-api';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const CONFIG: VerifyConfigResponse = {
  exists: true,
  path: '.commandmate/verify.yaml',
  gates: [
    {
      id: 'lint',
      command: 'npm run lint',
      timeoutSec: 900,
      mutex: null,
      retryOnFail: null,
      flakyIsPass: null,
    },
    {
      id: 'unit',
      command: 'npm run test:unit',
      timeoutSec: 1800,
      mutex: null,
      retryOnFail: null,
      flakyIsPass: null,
    },
  ],
  options: null,
  plannedGateIds: ['work-evidence', 'scope', 'lint', 'unit'],
  error: null,
};

const RUN_9 = {
  id: 9,
  worktreeId: 'wt-1',
  instanceId: null,
  taskId: null,
  trigger: 'api',
  status: 'failed',
  baseRef: 'origin/develop',
  startedAt: '2026-08-31T00:01:00.000Z',
  finishedAt: '2026-08-31T00:02:00.000Z',
};

/** run 9's gates: lint passed, unit failed, scope was declined. */
const RUN_9_DETAIL = {
  ...RUN_9,
  gates: [
    { id: 1, runId: 9, gateId: 'scope', command: 'scope', status: 'skipped', exitCode: null, durationMs: 0, logTail: null, startedAt: RUN_9.startedAt, finishedAt: RUN_9.startedAt, source: 'builtin' },
    { id: 2, runId: 9, gateId: 'lint', command: 'npm run lint', status: 'passed', exitCode: 0, durationMs: 1000, logTail: null, startedAt: RUN_9.startedAt, finishedAt: RUN_9.finishedAt, source: 'verify.yaml' },
    { id: 3, runId: 9, gateId: 'unit', command: 'npm run test:unit', status: 'failed', exitCode: 1, durationMs: 2000, logTail: 'FAIL', startedAt: RUN_9.startedAt, finishedAt: RUN_9.finishedAt, source: 'verify.yaml' },
  ],
};

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

let recorded: Recorded[] = [];
const fixture = {
  runs: [RUN_9] as unknown[],
  run: RUN_9_DETAIL as unknown,
  history: [] as unknown[],
  cancel: { status: 200, body: {} as Record<string, unknown> },
};

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function install(): void {
  mockFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    recorded.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });

    if (url.includes('/verify/config')) return Promise.resolve(json(200, CONFIG));
    if (url.includes('/cancel')) {
      return Promise.resolve(json(fixture.cancel.status, fixture.cancel.body));
    }
    if (url.startsWith('/api/verification/runs')) {
      return Promise.resolve(json(200, { runs: fixture.history }));
    }
    if (method === 'POST') return Promise.resolve(json(202, { runId: 99 }));
    if (url.includes('/tasks')) return Promise.resolve(json(200, { tasks: [] }));
    if (/\/verify\/runs\/\d+/.test(url)) return Promise.resolve(json(200, { run: fixture.run }));
    if (url.includes('/verify/runs')) return Promise.resolve(json(200, { runs: fixture.runs }));
    return Promise.resolve(json(200, {}));
  });
}

/** The body of the POST that started a verification run, or undefined. */
function verifyPostBody(): unknown {
  const post = recorded.find(
    (call) => call.method === 'POST' && /\/verify$/.test(call.url)
  );
  return post?.body;
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded = [];
  fixture.runs = [RUN_9];
  fixture.run = RUN_9_DETAIL;
  fixture.history = [];
  fixture.cancel = { status: 200, body: { runId: 9, status: 'cancelled' } };
  install();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gate selection (Issue #2063)', () => {
  it('offers the server plannedGateIds as the selectable set', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.availableGateIds.length).toBe(4));

    // Built-ins included. `work-evidence` is a gate id `gateIds` accepts, and
    // leaving it out would make "re-run only the red ones" unable to name it.
    expect(result.current.availableGateIds).toEqual(['work-evidence', 'scope', 'lint', 'unit']);
    expect(result.current.selectedGateIds).toBeNull();
  });

  it('sends no gateIds while the default (all gates) selection stands', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.rerun();
    });

    expect(verifyPostBody()).toEqual({});
  });

  it('sends exactly the ticked gates once one is unticked', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.availableGateIds.length).toBe(4));

    act(() => result.current.toggleGate('unit'));
    expect(result.current.selectedGateIds).toEqual(['work-evidence', 'scope', 'lint']);

    await act(async () => {
      await result.current.rerun();
    });
    expect(verifyPostBody()).toEqual({ gateIds: ['work-evidence', 'scope', 'lint'] });
  });

  it('collapses back to "no gateIds" when every box is ticked again', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.availableGateIds.length).toBe(4));

    act(() => result.current.toggleGate('unit'));
    act(() => result.current.toggleGate('unit'));

    // NOT `['work-evidence','scope','lint','unit']`. Naming every gate makes
    // the scope gate `explicit`, which changes how a contract-less run is
    // aggregated — so a full selection has to be spelled as the absence.
    expect(result.current.selectedGateIds).toBeNull();
    await act(async () => {
      await result.current.rerun();
    });
    expect(verifyPostBody()).toEqual({});
  });

  it('re-adds a gate in execution order, not in click order', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.availableGateIds.length).toBe(4));

    act(() => result.current.setGateSelection(['unit']));
    act(() => result.current.toggleGate('work-evidence'));

    expect(result.current.selectedGateIds).toEqual(['work-evidence', 'unit']);
  });

  it('selects exactly the failing gates of the run on screen', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.selectedRun).not.toBeNull());

    // `scope` is `skipped`, not failing: re-running a gate the runner declined
    // would decline it again for the same reason.
    expect(result.current.failedGateIds).toEqual(['unit']);

    act(() => result.current.selectFailedGates());
    expect(result.current.selectedGateIds).toEqual(['unit']);

    await act(async () => {
      await result.current.rerun();
    });
    expect(verifyPostBody()).toEqual({ gateIds: ['unit'] });
  });

  it('lets an explicit null force the full run over a narrowed selection', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.availableGateIds.length).toBe(4));

    act(() => result.current.setGateSelection(['lint']));
    await act(async () => {
      await result.current.rerun(null);
    });

    expect(verifyPostBody()).toEqual({});
  });
});

describe('cancel (Issue #2063)', () => {
  const RUNNING = { ...RUN_9, id: 11, status: 'running', finishedAt: null };

  it('posts to the running run and re-reads the list afterwards', async () => {
    fixture.runs = [RUNNING];
    fixture.run = { ...RUNNING, gates: [] };
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.runningRun?.id).toBe(11));

    const listReadsBefore = recorded.filter((c) => /\/verify\/runs\?/.test(c.url)).length;
    await act(async () => {
      await result.current.cancelRun();
    });

    expect(recorded.some((c) => c.url.endsWith('/verify/runs/11/cancel'))).toBe(true);
    expect(result.current.cancelFailure).toBeNull();
    // The list still holds the `running` row this call just ended, so the
    // refresh is what closes the loop — the same rule rerun() follows.
    await waitFor(() =>
      expect(recorded.filter((c) => /\/verify\/runs\?/.test(c.url)).length).toBeGreaterThan(
        listReadsBefore
      )
    );
  });

  it('does nothing at all when no run is in flight', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.cancelRun();
    });

    expect(recorded.some((c) => c.url.includes('/cancel'))).toBe(false);
  });

  it('reports a 409 as gone rather than as a fault', async () => {
    fixture.runs = [RUNNING];
    fixture.cancel = { status: 409, body: { error: 'already finished', status: 'passed' } };
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.runningRun?.id).toBe(11));

    await act(async () => {
      await result.current.cancelRun();
    });

    expect(result.current.cancelFailure).toEqual({ kind: 'gone', message: 'already finished' });
  });
});

describe('history (Issue #2063)', () => {
  it('asks the list endpoint for more runs when loadMore is pressed', async () => {
    // A full page is the only evidence there may be another.
    fixture.runs = Array.from({ length: 10 }, (_, i) => ({ ...RUN_9, id: 100 + i }));
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.runs.length).toBe(10));
    expect(result.current.canLoadMore).toBe(true);
    expect(recorded.some((c) => c.url.includes('/verify/runs?limit=10'))).toBe(true);

    act(() => result.current.loadMore());

    await waitFor(() =>
      expect(recorded.some((c) => c.url.includes('/verify/runs?limit=20'))).toBe(true)
    );
    expect(result.current.historyLimit).toBe(20);
  });

  it('offers no "load more" while the page is not even full', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.runs.length).toBe(1));
    expect(result.current.canLoadMore).toBe(false);
  });

  it('reads the cross-worktree endpoint only once the block is opened', async () => {
    fixture.history = [{ ...RUN_9, id: 55, worktreeId: 'wt-other', gates: [] }];
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Collapsed by default, and the endpoint is untouched: this pane already
    // polls three endpoints per tick and a fourth for a hidden block would be
    // pure cost.
    expect(recorded.some((c) => c.url.startsWith('/api/verification/runs'))).toBe(false);

    act(() => result.current.toggleRepositoryHistory());

    await waitFor(() => expect(result.current.repositoryHistory).toHaveLength(1));
    expect(result.current.repositoryHistory[0].worktreeId).toBe('wt-other');
    expect(recorded.some((c) => c.url.startsWith('/api/verification/runs?days=7'))).toBe(true);
  });
});
