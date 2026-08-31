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

/**
 * A gate id the run recorded but `plannedGateIds` no longer lists — a gate
 * deleted from verify.yaml since the run, which the server would answer 400 for.
 */
const DROPPED_GATE_ID = 'gone-from-verify-yaml';

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

/**
 * When true, the NEXT `/verify/runs?limit=` read parks until released.
 *
 * The only way to reproduce the hook's in-flight guard: a `loadMore()` pressed
 * while a list read is already in the air used to be dropped with nothing to
 * re-schedule it, so the rows arrived only on the owner's next poll tick.
 */
let holdRunsList = false;

/** Completes the parked `/verify/runs` read; null when none is parked. */
let heldRunsResolve: (() => void) | null = null;

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
    if (url.includes('/verify/runs')) {
      if (holdRunsList) {
        holdRunsList = false;
        return new Promise<Response>((resolve) => {
          heldRunsResolve = () => resolve(json(200, { runs: fixture.runs }));
        });
      }
      return Promise.resolve(json(200, { runs: fixture.runs }));
    }
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
  holdRunsList = false;
  heldRunsResolve = null;
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

  it('drops a failed gate the config no longer plans, so the request cannot 400', async () => {
    // The intersection this pins is invisible in every other fixture, because
    // in all of them `failedGateIds` is already a subset of `availableGateIds`.
    // Here a gate that failed has since been deleted from verify.yaml: naming
    // it in `gateIds` makes the route answer 400 "Unknown gate id(s)", turning
    // a one-click shortcut into an error the operator has to decode.
    fixture.run = {
      ...RUN_9_DETAIL,
      gates: [
        ...RUN_9_DETAIL.gates,
        { id: 4, runId: 9, gateId: DROPPED_GATE_ID, command: 'npm run gone', status: 'failed', exitCode: 1, durationMs: 10, logTail: null, startedAt: RUN_9.startedAt, finishedAt: RUN_9.finishedAt, source: 'verify.yaml' },
      ],
    };
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.selectedRun).not.toBeNull());

    // `failedGateIds` reports what actually failed, unfiltered — that is a fact
    // about the run.
    expect(result.current.failedGateIds).toEqual(['unit', DROPPED_GATE_ID]);

    act(() => result.current.selectFailedGates());

    // ...but what gets REQUESTED is only what the server still knows about.
    expect(result.current.selectedGateIds).toEqual(['unit']);
    await act(async () => {
      await result.current.rerun();
    });
    expect(verifyPostBody()).toEqual({ gateIds: ['unit'] });
  });

  it('reads a full selection as "all gates" whatever order it arrives in', async () => {
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.availableGateIds.length).toBe(4));

    // `setGateSelection` is public, and a caller naming every gate means the
    // default run — which is spelled by sending NO gateIds, not by listing them
    // (an explicit `scope` changes how the gate is aggregated). Comparing the
    // two lists position by position would answer "no" here and quietly send a
    // different request than the operator asked for.
    act(() => result.current.setGateSelection([...CONFIG.plannedGateIds].reverse()));

    expect(result.current.selectedGateIds).toBeNull();
    await act(async () => {
      await result.current.rerun();
    });
    expect(verifyPostBody()).toEqual({});
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

  it('reports a 202 as still settling, so the Stop press is not silent', async () => {
    fixture.runs = [RUNNING];
    fixture.cancel = { status: 202, body: { runId: 11, status: 'running' } };
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.runningRun?.id).toBe(11));

    await act(async () => {
      await result.current.cancelRun();
    });

    // 202 means the signal is out and the gate has not exited. Without this the
    // route's 200/202 distinction had no consumer at all, and a stubborn gate's
    // five-second SIGKILL window looked like a button that did nothing.
    expect(result.current.cancelSettling).toBe(true);
    expect(result.current.cancelFailure).toBeNull();
  });

  it('does not claim to be settling when the run closed while we waited', async () => {
    fixture.runs = [RUNNING];
    fixture.cancel = { status: 200, body: { runId: 11, status: 'cancelled' } };
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.runningRun?.id).toBe(11));

    await act(async () => {
      await result.current.cancelRun();
    });

    expect(result.current.cancelSettling).toBe(false);
  });

  it('stops claiming to be settling once the run leaves the list as running', async () => {
    fixture.runs = [RUNNING];
    fixture.cancel = { status: 202, body: { runId: 11, status: 'running' } };
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.runningRun?.id).toBe(11));
    await act(async () => {
      await result.current.cancelRun();
    });
    expect(result.current.cancelSettling).toBe(true);

    // The run closed. Nothing has to clear the note: it is derived from the
    // list, so it goes away with the state it was describing.
    fixture.runs = [{ ...RUNNING, status: 'cancelled', finishedAt: '2026-08-31T00:03:00.000Z' }];
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.cancelSettling).toBe(false));
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

  it('does not lose a "load more" pressed while a list read is in flight', async () => {
    fixture.runs = Array.from({ length: 10 }, (_, i) => ({ ...RUN_9, id: 100 + i }));
    const { result } = renderHook(() => useWorktreeVerification({ worktreeId: 'wt-1' }));
    await waitFor(() => expect(result.current.runs.length).toBe(10));

    // Park the next list read, then press "load more" underneath it. The hook's
    // in-flight guard drops the effect this raise triggers.
    holdRunsList = true;
    act(() => result.current.refresh());
    await waitFor(() => expect(heldRunsResolve).not.toBeNull());

    act(() => result.current.loadMore());

    // The button must not vanish while the rows it asked for are still coming:
    // comparing `runs.length` against the REQUESTED limit made 10 >= 20 false
    // and took the only way of asking away.
    expect(result.current.canLoadMore).toBe(true);

    act(() => heldRunsResolve?.());

    // ...and the raise is re-armed rather than left for the owner's next poll.
    await waitFor(() =>
      expect(recorded.some((c) => c.url.includes('/verify/runs?limit=20'))).toBe(true)
    );
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
