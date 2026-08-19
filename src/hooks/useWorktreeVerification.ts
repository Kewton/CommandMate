/**
 * useWorktreeVerification (Issue #1816)
 *
 * Owns the worktree's task-contract / verification state for both surfaces that
 * show it: the header chip and the Verification pane. One hook instance per
 * worktree detail screen — mounted in `useWorktreeDetailController` and passed
 * down — so the two surfaces share a single set of requests instead of racing
 * each other for the same rows.
 *
 * **No timer of its own.** Refreshes are driven by `refreshToken`, which the
 * worktree detail controller bumps at the end of every poll cycle it already
 * runs (2s while the active CLI is running, 5s otherwise). Adding a second
 * interval would mean two cadences to reason about and two things to stop when
 * the tab is hidden.
 *
 * Riding that tick verbatim would be far more traffic than these rows need, so
 * the hook throttles itself: {@link VERIFICATION_IDLE_REFRESH_MS} between
 * refreshes normally, and no gap at all while something is actually in flight
 * (a `running` run, or a task the server has moved to `verifying`) — which is
 * the only time the rows change quickly. A throttle is not a timer: nothing
 * fires unless the parent's tick arrives.
 *
 * @module hooks/useWorktreeVerification
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_RUN_LIST_LIMIT,
  VerificationApiError,
  fetchLatestTask,
  fetchVerificationRun,
  fetchVerificationRuns,
  startVerification,
  type TaskView,
  type VerificationRunListItem,
  type VerificationRunView,
} from '@/lib/api/verification-api';

/** Minimum gap between piggy-backed refreshes while nothing is in flight. */
export const VERIFICATION_IDLE_REFRESH_MS = 15_000;

/** Reason a re-verify request was refused, for the UI to phrase. */
export interface RerunFailure {
  /** `conflict` = 409, a run is already going; `error` = anything else. */
  kind: 'conflict' | 'error';
  message: string;
  /** The run blocking a conflict, when the route named one. */
  runningRunId: number | null;
}

/** Everything the chip and the pane read. */
export interface WorktreeVerificationState {
  /** Most recent task for this worktree; `null` when none was ever recorded. */
  task: TaskView | null;
  /** Recent runs, newest first. */
  runs: VerificationRunListItem[];
  /** `runs[0]`, or `null`. What the header chip reports. */
  latestRun: VerificationRunListItem | null;
  /** Run whose gate table is shown; defaults to the latest run. */
  selectedRunId: number | null;
  /** Gate rows for {@link selectedRunId}; `null` while loading or when gone. */
  selectedRun: VerificationRunView | null;
  /** True only during the first load for the current worktree. */
  loading: boolean;
  /** Failure of the task/run list fetch, already a display string. */
  error: string | null;
  /** Failure of the selected run's detail fetch. */
  detailError: string | null;
  /** True when the run detail request for the current selection is in flight. */
  detailLoading: boolean;
  /** True while a re-verify POST is in flight. */
  rerunPending: boolean;
  /** Why the last re-verify attempt was refused; `null` when it was not. */
  rerunFailure: RerunFailure | null;
  /** Show a different run's gates. */
  selectRun: (runId: number) => void;
  /** Refetch now, ignoring the throttle. */
  refresh: () => void;
  /** `POST /verify`; selects the new run and refetches. */
  rerun: () => Promise<void>;
}

export interface UseWorktreeVerificationOptions {
  worktreeId: string;
  /**
   * Bumped by the owner's existing poll loop. Every change is a *chance* to
   * refresh; the throttle above decides whether one actually happens.
   */
  refreshToken?: number;
  /** Suspend fetching (the detail screen is still loading, or errored). */
  enabled?: boolean;
  /** Runs requested for the list. */
  limit?: number;
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * True when the rows are expected to change within seconds.
 *
 * `verifying` is included even with no `running` run in the list yet: the task
 * moves first and the run row can lag it by one poll, and that gap is exactly
 * when a user who just pressed Re-verify is watching.
 */
function isInFlight(task: TaskView | null, runs: VerificationRunListItem[]): boolean {
  return task?.status === 'verifying' || runs.some((run) => run.status === 'running');
}

export function useWorktreeVerification({
  worktreeId,
  refreshToken = 0,
  enabled = true,
  limit = DEFAULT_RUN_LIST_LIMIT,
}: UseWorktreeVerificationOptions): WorktreeVerificationState {
  const [task, setTask] = useState<TaskView | null>(null);
  const [runs, setRuns] = useState<VerificationRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedRun, setSelectedRun] = useState<VerificationRunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rerunPending, setRerunPending] = useState(false);
  const [rerunFailure, setRerunFailure] = useState<RerunFailure | null>(null);
  /** Bumped by refresh()/rerun() to force a fetch between parent ticks. */
  const [nonce, setNonce] = useState(0);

  /** Guards against a queued response landing after a worktree switch. */
  const generationRef = useRef(0);
  const lastFetchAtRef = useRef(0);
  const inFlightRef = useRef(false);
  const activeRef = useRef(false);
  const rerunPendingRef = useRef(false);
  const didMountRef = useRef(false);

  activeRef.current = isInFlight(task, runs);

  // Clear everything when the screen switches branch. Declared before the fetch
  // effect so it runs first on the same commit: the fetch that follows must see
  // the bumped generation, not the previous worktree's.
  useEffect(() => {
    generationRef.current += 1;
    lastFetchAtRef.current = 0;
    inFlightRef.current = false;
    if (!didMountRef.current) {
      // Mount already has these values; re-setting them would just add a render.
      didMountRef.current = true;
      return;
    }
    setTask(null);
    setRuns([]);
    setSelectedRunId(null);
    setSelectedRun(null);
    setLoading(true);
    setError(null);
    setDetailError(null);
    setRerunFailure(null);
  }, [worktreeId]);

  useEffect(() => {
    if (!enabled) return;
    const isFirst = lastFetchAtRef.current === 0;
    const minGap = activeRef.current ? 0 : VERIFICATION_IDLE_REFRESH_MS;
    if (!isFirst && Date.now() - lastFetchAtRef.current < minGap) return;
    // A slow response must not be cancelled by the next tick, so the request is
    // not aborted on cleanup — it is discarded by generation instead.
    if (inFlightRef.current) return;

    const generation = generationRef.current;
    inFlightRef.current = true;
    lastFetchAtRef.current = Date.now();

    void (async () => {
      try {
        const [nextTask, nextRuns] = await Promise.all([
          fetchLatestTask(worktreeId),
          fetchVerificationRuns(worktreeId, limit),
        ]);
        if (generation !== generationRef.current) return;
        setTask(nextTask);
        setRuns(nextRuns);
        setError(null);
      } catch (err) {
        if (generation !== generationRef.current || isAbort(err)) return;
        setError(messageOf(err, 'Failed to load verification data'));
      } finally {
        inFlightRef.current = false;
        if (generation === generationRef.current) setLoading(false);
      }
    })();
  }, [worktreeId, refreshToken, nonce, enabled, limit]);

  /** Selection falls back to the newest run so the pane opens on it. */
  const effectiveRunId = selectedRunId ?? runs[0]?.id ?? null;

  /**
   * Refetch key for the gate table. Changing run, or a listed change in that
   * run's verdict/finish time, invalidates the detail; a run still `running`
   * follows the parent tick so gates appear as they complete.
   */
  const detailKey = useMemo(() => {
    if (effectiveRunId === null) return null;
    const listed = runs.find((run) => run.id === effectiveRunId);
    if (listed?.status === 'running') return `${effectiveRunId}:running:${refreshToken}:${nonce}`;
    return `${effectiveRunId}:${listed?.status ?? 'unlisted'}:${listed?.finishedAt ?? ''}`;
  }, [effectiveRunId, runs, refreshToken, nonce]);

  useEffect(() => {
    if (!enabled || effectiveRunId === null) {
      setSelectedRun(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setDetailLoading(true);
    void (async () => {
      try {
        const run = await fetchVerificationRun(worktreeId, effectiveRunId, controller.signal);
        if (cancelled) return;
        setSelectedRun(run);
        setDetailError(run === null ? 'not-found' : null);
      } catch (err) {
        if (cancelled || isAbort(err)) return;
        setSelectedRun(null);
        setDetailError(messageOf(err, 'Failed to load the verification run'));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `detailKey` is the composed invalidation key; `effectiveRunId` is read
    // inside and is one of its inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId, enabled, detailKey]);

  const refresh = useCallback(() => {
    lastFetchAtRef.current = 0;
    setNonce((value) => value + 1);
  }, []);

  const selectRun = useCallback((runId: number) => {
    setSelectedRunId(runId);
  }, []);

  const rerun = useCallback(async () => {
    if (rerunPendingRef.current) return;
    rerunPendingRef.current = true;
    setRerunPending(true);
    setRerunFailure(null);
    try {
      const runId = await startVerification(worktreeId);
      setSelectedRunId(runId);
      // The 202 carries no verdict, so the list is what closes the loop: force
      // the next refresh instead of waiting out the idle throttle.
      lastFetchAtRef.current = 0;
      setNonce((value) => value + 1);
    } catch (err) {
      const conflict = err instanceof VerificationApiError && err.status === 409;
      setRerunFailure({
        kind: conflict ? 'conflict' : 'error',
        message: messageOf(err, 'Failed to start verification'),
        runningRunId: err instanceof VerificationApiError ? err.runningRunId : null,
      });
      // A conflict means a run this pane has not listed yet is going; showing it
      // is more useful than the error alone.
      if (conflict) {
        lastFetchAtRef.current = 0;
        setNonce((value) => value + 1);
      }
    } finally {
      rerunPendingRef.current = false;
      setRerunPending(false);
    }
  }, [worktreeId]);

  return {
    task,
    runs,
    latestRun: runs[0] ?? null,
    selectedRunId: effectiveRunId,
    selectedRun,
    loading,
    error,
    detailError,
    detailLoading,
    rerunPending,
    rerunFailure,
    selectRun,
    refresh,
    rerun,
  };
}

export default useWorktreeVerification;
