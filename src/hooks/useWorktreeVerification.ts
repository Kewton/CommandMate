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
import { FAILING_GATE_STATUSES } from '@/config/verification-display';
import {
  DEFAULT_RUN_LIST_LIMIT,
  PANE_RUN_HISTORY_DAYS,
  PANE_RUN_HISTORY_LIMIT,
  MAX_RUN_LIST_LIMIT,
  RUN_LIST_LIMIT_STEP,
  VerificationApiError,
  cancelVerificationRun,
  draftVerificationConfig,
  fetchLatestTask,
  fetchVerificationConfig,
  fetchVerificationRun,
  fetchVerificationRunHistory,
  fetchVerificationRuns,
  startVerification,
  type TaskView,
  type VerificationRunListItem,
  type VerificationRunSummaryView,
  type VerificationRunView,
  type VerifyConfigDraftResponse,
  type VerifyConfigResponse,
} from '@/lib/api/verification-api';

/** Minimum gap between piggy-backed refreshes while nothing is in flight. */
export const VERIFICATION_IDLE_REFRESH_MS = 15_000;

/**
 * Which of the four onboarding states the pane is in (Issue #2061).
 *
 * `unknown` is not one of the four: it is the gap before the config read lands,
 * and it exists so the pane never renders "this repository declares no gates"
 * on the strength of not having asked yet — the one wrong answer here that
 * sends an operator off to write a file that is already there.
 */
export type VerificationPhase = 'unknown' | 'no-config' | 'configured' | 'running' | 'result';

/**
 * Resolve the pane's state from the two facts it rests on.
 *
 * Precedence, and why:
 *  1. A `running` run wins over everything. It is the only state that changes
 *     by itself, and it is what someone who just pressed the button is looking
 *     at.
 *  2. No config read yet -> `unknown` (see {@link VerificationPhase}).
 *  3. No config file -> `no-config`, *even with past runs in the list*. Those
 *     runs cannot be repeated until the file is back, so "declare your gates"
 *     is still the next move; the history stays visible below.
 *  4. A config and no runs -> `configured`; otherwise -> `result`.
 */
export function resolveVerificationPhase(
  config: VerifyConfigResponse | null,
  runs: readonly Pick<VerificationRunListItem, 'status'>[]
): VerificationPhase {
  if (runs.some((run) => run.status === 'running')) return 'running';
  if (config === null) return 'unknown';
  if (!config.exists) return 'no-config';
  if (runs.length === 0) return 'configured';
  return 'result';
}

/** Reason a "draft from CI" request was refused, for the UI to phrase. */
export interface DraftFailure {
  /**
   * `conflict` = 409, the file appeared between the read and the write;
   * `empty` = 422, nothing in CI was usable as a gate; `error` = anything else.
   */
  kind: 'conflict' | 'empty' | 'error';
  message: string;
}

/** Reason a re-verify request was refused, for the UI to phrase. */
export interface RerunFailure {
  /** `conflict` = 409, a run is already going; `error` = anything else. */
  kind: 'conflict' | 'error';
  message: string;
  /** The run blocking a conflict, when the route named one. */
  runningRunId: number | null;
}

/** Reason a cancel request was refused, for the UI to phrase (Issue #2063). */
export interface CancelFailure {
  /**
   * `gone` = 409: the run had already reached a verdict, or it is an orphan no
   * signal in this process can reach. Not a fault — the list is one poll
   * behind, and the refresh the hook forces resolves it.
   */
  kind: 'gone' | 'error';
  message: string;
}

/**
 * True when two gate-id lists name the same set.
 *
 * Order is deliberately ignored: the selection is rebuilt in the config's order
 * on every toggle, and what this answers is "is the operator still asking for
 * everything", which is a question about membership.
 */
function sameGateSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Everything the chip and the pane read. */
export interface WorktreeVerificationState {
  /** The branch this state is about. The pane interpolates it into CLI hints. */
  worktreeId: string;
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
  /**
   * `.commandmate/verify.yaml` as the server reads it; `null` until the first
   * read lands, or when it failed (see {@link configError}).
   */
  config: VerifyConfigResponse | null;
  /** Failure of the config read, already a display string. */
  configError: string | null;
  /** Which of the pane's four onboarding states this is (Issue #2061). */
  phase: VerificationPhase;
  /** True while a "draft from CI" POST is in flight. */
  draftPending: boolean;
  /** Why the last draft attempt was refused; `null` when it was not. */
  draftFailure: DraftFailure | null;
  /** What the last successful draft wrote; `null` before one succeeded. */
  draftResult: VerifyConfigDraftResponse | null;

  // --- Gate selection (Issue #2063) ------------------------------------------

  /**
   * Every gate a default run executes, in execution order.
   *
   * The server's `plannedGateIds` verbatim — built-ins first, then verify.yaml's
   * — so the checkbox list is the runner's own answer to "what runs", not a
   * composition the browser guessed at.
   */
  availableGateIds: string[];
  /**
   * Gates ticked for the next run; `null` means "all of them", the default.
   *
   * `null` is not the same value as a list naming every gate, and the difference
   * is load-bearing: an omitted `gateIds` leaves the scope gate `implicit`,
   * while naming `scope` explicitly makes a skip count against the run. So the
   * selection collapses back to `null` the moment every box is ticked again, and
   * {@link rerun} sends no `gateIds` at all for it.
   */
  selectedGateIds: string[] | null;
  /** Gates that did not pass in the run currently shown; `[]` when none did. */
  failedGateIds: string[];
  /** Tick or untick one gate. */
  toggleGate: (gateId: string) => void;
  /** Replace the selection outright; `null` restores "all gates". */
  setGateSelection: (gateIds: string[] | null) => void;
  /** Tick exactly {@link failedGateIds} — the "re-run the red ones" shortcut. */
  selectFailedGates: () => void;

  // --- Cancel (Issue #2063) --------------------------------------------------

  /** The run in flight for this worktree, or `null`. */
  runningRun: VerificationRunListItem | null;
  /** True while a cancel POST is in flight. */
  cancelPending: boolean;
  /**
   * True once a cancel was accepted (HTTP 202) and the run is still listed as
   * running — the SIGTERM is out and the gate has not exited yet.
   */
  cancelSettling: boolean;
  /** Why the last cancel was refused; `null` when it was not. */
  cancelFailure: CancelFailure | null;

  // --- History (Issue #2063) -------------------------------------------------

  /** Runs currently requested from the worktree-scoped list endpoint. */
  historyLimit: number;
  /** True when raising {@link historyLimit} could still yield more rows. */
  canLoadMore: boolean;
  /** True while the repository-wide history block is expanded. */
  repositoryHistoryOpen: boolean;
  /** Runs across every worktree, newest first; `[]` until the block is opened. */
  repositoryHistory: VerificationRunSummaryView[];
  /** True while the repository-wide history request is in flight. */
  repositoryHistoryLoading: boolean;
  /** Failure of the repository-wide history read, already a display string. */
  repositoryHistoryError: string | null;

  // --- Actions ---------------------------------------------------------------

  /** Show a different run's gates. */
  selectRun: (runId: number) => void;
  /** Refetch now, ignoring the throttle. */
  refresh: () => void;
  /**
   * `POST /verify`; selects the new run and refetches.
   *
   * With no argument it sends {@link selectedGateIds}, which is what every
   * button in the pane does. An explicit `null` forces the full run regardless
   * of the selection; an explicit list overrides it for this one request.
   */
  rerun: (gateIds?: string[] | null) => Promise<void>;
  /** `POST /verify/runs/:runId/cancel` for {@link runningRun}; then refetches. */
  cancelRun: () => Promise<void>;
  /** Ask the list endpoint for {@link RUN_LIST_LIMIT_STEP} more runs. */
  loadMore: () => void;
  /** Expand or collapse the repository-wide history block. */
  toggleRepositoryHistory: () => void;
  /** `POST /verify/config`; drafts verify.yaml from CI and re-reads it. */
  draftConfig: () => Promise<void>;
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
  const [config, setConfig] = useState<VerifyConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [draftPending, setDraftPending] = useState(false);
  const [draftFailure, setDraftFailure] = useState<DraftFailure | null>(null);
  const [draftResult, setDraftResult] = useState<VerifyConfigDraftResponse | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelFailure, setCancelFailure] = useState<CancelFailure | null>(null);
  /**
   * Run the server answered 202 for: signalled, not yet closed (Issue #2063).
   *
   * The route distinguishes 200 ("it closed while you waited") from 202 ("the
   * signal is out, it is still winding down"), and the distinction is only
   * worth having if somebody reports it. A gate that ignores SIGTERM is
   * SIGKILLed five seconds later, so this is the window in which pressing Stop
   * again would look like nothing happened.
   */
  const [cancelRequestedRunId, setCancelRequestedRunId] = useState<number | null>(null);
  const [selectedGateIds, setSelectedGateIds] = useState<string[] | null>(null);
  const [historyLimit, setHistoryLimit] = useState(limit);
  /**
   * The limit the runs on screen were actually fetched with (Issue #2063).
   *
   * `canLoadMore` compares against THIS, not against `historyLimit`. Raising
   * the request to 20 while 10 rows are on screen would otherwise make
   * `runs.length >= historyLimit` false and take the button away before the
   * rows it asked for had arrived.
   */
  const [loadedLimit, setLoadedLimit] = useState(limit);
  const [repositoryHistoryOpen, setRepositoryHistoryOpen] = useState(false);
  const [repositoryHistory, setRepositoryHistory] = useState<VerificationRunSummaryView[]>([]);
  const [repositoryHistoryLoading, setRepositoryHistoryLoading] = useState(false);
  const [repositoryHistoryError, setRepositoryHistoryError] = useState<string | null>(null);
  /** Bumped by refresh()/rerun() to force a fetch between parent ticks. */
  const [nonce, setNonce] = useState(0);

  /** Guards against a queued response landing after a worktree switch. */
  const generationRef = useRef(0);
  const lastFetchAtRef = useRef(0);
  const inFlightRef = useRef(false);
  const activeRef = useRef(false);
  const rerunPendingRef = useRef(false);
  const draftPendingRef = useRef(false);
  const cancelPendingRef = useRef(false);
  const didMountRef = useRef(false);
  /**
   * The selection `rerun()` reads when it is called with no argument.
   *
   * A ref and not a dependency so `rerun`'s identity stays tied to the worktree
   * alone, as it was before #2063 — ticking a checkbox must not hand every
   * consumer of this state a new callback.
   */
  const selectedGateIdsRef = useRef<string[] | null>(null);
  selectedGateIdsRef.current = selectedGateIds;
  /** Latest requested limit, read by the fetch's `finally` to detect a raise. */
  const historyLimitRef = useRef(limit);
  historyLimitRef.current = historyLimit;

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
    setConfig(null);
    setConfigError(null);
    setDraftFailure(null);
    setDraftResult(null);
    setCancelFailure(null);
    // Issue #2063. The selection names gate ids from the previous branch's
    // verify.yaml, and "all gates" is the only selection that means the same
    // thing in every repository.
    setSelectedGateIds(null);
    setHistoryLimit(limit);
    setLoadedLimit(limit);
    setCancelRequestedRunId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId]);

  /**
   * Read `.commandmate/verify.yaml`.
   *
   * Deliberately NOT on `refreshToken`: the other two reads ride the owner's
   * poll because run rows change every few seconds, and this one answers "does
   * a file exist", which does not. It re-runs on the branch changing and on
   * `nonce` — the Refresh button, a re-verify, a draft — which covers every way
   * the answer can change from inside the app, and the Refresh button covers
   * the one way it can change from outside (someone wrote the file in an
   * editor).
   */
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchVerificationConfig(worktreeId, controller.signal);
        if (cancelled) return;
        setConfig(next);
        setConfigError(null);
      } catch (err) {
        if (cancelled || isAbort(err)) return;
        setConfig(null);
        setConfigError(messageOf(err, 'Failed to load the verification config'));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [worktreeId, enabled, nonce]);

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

    const limitUsed = historyLimit;

    void (async () => {
      try {
        const [nextTask, nextRuns] = await Promise.all([
          fetchLatestTask(worktreeId),
          fetchVerificationRuns(worktreeId, limitUsed),
        ]);
        if (generation !== generationRef.current) return;
        setTask(nextTask);
        setRuns(nextRuns);
        setLoadedLimit(limitUsed);
        setError(null);
      } catch (err) {
        if (generation !== generationRef.current || isAbort(err)) return;
        setError(messageOf(err, 'Failed to load verification data'));
      } finally {
        inFlightRef.current = false;
        if (generation === generationRef.current) {
          setLoading(false);
          // Issue #2063: a "load more" pressed while this request was in the
          // air was dropped by the in-flight guard above and nothing would have
          // re-scheduled it — the rows only arrived on the owner's next poll
          // tick, seconds later, with the button already gone. Re-arm here.
          if (historyLimitRef.current !== limitUsed) {
            lastFetchAtRef.current = 0;
            setNonce((value) => value + 1);
          }
        }
      }
    })();
  }, [worktreeId, refreshToken, nonce, enabled, historyLimit]);

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

  /**
   * Verification history across every worktree (Issue #2063).
   *
   * Fetched only while the block is expanded: it is a supplementary answer —
   * "is this gate red everywhere, or only here?" — and a pane that asked for it
   * on every poll would triple this screen's verification traffic to render
   * something usually collapsed.
   *
   * `nonce` is a dependency so the pane's Refresh reaches it too; `refreshToken`
   * deliberately is not, for the reason above.
   */
  useEffect(() => {
    if (!enabled || !repositoryHistoryOpen) return;
    const controller = new AbortController();
    let cancelled = false;
    setRepositoryHistoryLoading(true);
    void (async () => {
      try {
        const history = await fetchVerificationRunHistory(
          { days: PANE_RUN_HISTORY_DAYS, limit: PANE_RUN_HISTORY_LIMIT },
          controller.signal
        );
        if (cancelled) return;
        setRepositoryHistory(history);
        setRepositoryHistoryError(null);
      } catch (err) {
        if (cancelled || isAbort(err)) return;
        setRepositoryHistoryError(messageOf(err, 'Failed to load the verification history'));
      } finally {
        if (!cancelled) setRepositoryHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, repositoryHistoryOpen, nonce]);

  /**
   * The gates a default run executes, straight from the server (Issue #2063).
   *
   * `plannedGateIds` and not `config.gates`: the built-ins (`work-evidence`,
   * `scope`, and `env-clean` when a declaration switched it on) are gates the
   * operator can name in `gateIds` too, and leaving them out of the checkbox
   * list would make "re-run only the red ones" unable to include the red one.
   */
  const availableGateIds = useMemo(() => config?.plannedGateIds ?? [], [config]);

  /**
   * Gates that did not pass in the run on screen.
   *
   * Read from the *displayed* run, which defaults to the newest one — so the
   * shortcut means "the gates that just failed" without the operator having to
   * think about it, and means "the gates that failed in the run I am reading"
   * once they have clicked back through the history.
   *
   * `skipped` is excluded (via `FAILING_GATE_STATUSES`): a gate the runner
   * declined to run has no failure to reproduce, and re-running the primary
   * checkout's skipped gates would just skip them again.
   */
  const failedGateIds = useMemo(
    () =>
      (selectedRun?.gates ?? [])
        .filter((gate) => FAILING_GATE_STATUSES.includes(gate.status))
        .map((gate) => gate.gateId),
    [selectedRun]
  );

  const runningRun = useMemo(
    () => runs.find((run) => run.status === 'running') ?? null,
    [runs]
  );

  const setGateSelection = useCallback(
    (gateIds: string[] | null) => {
      setSelectedGateIds(
        gateIds === null || sameGateSet(gateIds, availableGateIds) ? null : gateIds
      );
    },
    [availableGateIds]
  );

  const toggleGate = useCallback(
    (gateId: string) => {
      setSelectedGateIds((current) => {
        const base = current ?? availableGateIds;
        const wanted = new Set(base);
        if (wanted.has(gateId)) {
          wanted.delete(gateId);
        } else {
          wanted.add(gateId);
        }
        // Rebuilt from availableGateIds rather than from the click order, so the
        // request always lists gates in the order the runner will execute them.
        const next = availableGateIds.filter((id) => wanted.has(id));
        return sameGateSet(next, availableGateIds) ? null : next;
      });
    },
    [availableGateIds]
  );

  const selectFailedGates = useCallback(() => {
    // Intersected with what the config plans: a gate the run recorded may have
    // been dropped from verify.yaml since, and asking for it answers 400.
    const wanted = availableGateIds.filter((id) => failedGateIds.includes(id));
    setSelectedGateIds(
      wanted.length === 0 || sameGateSet(wanted, availableGateIds) ? null : wanted
    );
  }, [availableGateIds, failedGateIds]);

  const loadMore = useCallback(() => {
    lastFetchAtRef.current = 0;
    setHistoryLimit((current) => Math.min(current + RUN_LIST_LIMIT_STEP, MAX_RUN_LIST_LIMIT));
  }, []);

  const toggleRepositoryHistory = useCallback(() => {
    setRepositoryHistoryOpen((open) => !open);
  }, []);

  const refresh = useCallback(() => {
    lastFetchAtRef.current = 0;
    setNonce((value) => value + 1);
  }, []);

  const selectRun = useCallback((runId: number) => {
    setSelectedRunId(runId);
  }, []);

  const rerun = useCallback(async (gateIds?: string[] | null) => {
    if (rerunPendingRef.current) return;
    rerunPendingRef.current = true;
    setRerunPending(true);
    setRerunFailure(null);
    setCancelFailure(null);
    try {
      // `undefined` means "use the pane's selection"; `null` — and a selection
      // of `null` — means the full run, which is spelled by sending NO gateIds
      // rather than by listing every gate. See StartVerificationOptions.
      const requested = gateIds === undefined ? selectedGateIdsRef.current : gateIds;
      const runId = await startVerification(
        worktreeId,
        requested !== null && requested.length > 0 ? { gateIds: requested } : {}
      );
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

  /**
   * Stop the run in flight (Issue #2063).
   *
   * The route kills the gate's process group before it closes the row, so this
   * resolving means the `build` gate is gone — not merely relabelled. A refresh
   * is forced either way: on success the list still holds the `running` row
   * this call just ended, and on a 409 the run had already finished, which is
   * exactly the state a re-read reveals.
   */
  const cancelRun = useCallback(async () => {
    const target = runningRun;
    if (cancelPendingRef.current || target === null) return;
    cancelPendingRef.current = true;
    setCancelPending(true);
    setCancelFailure(null);
    try {
      const result = await cancelVerificationRun(worktreeId, target.id);
      // 200 says the run closed while we waited; 202 says only the signal is
      // out. Remembered so the pane can say which, instead of leaving a Stop
      // button that appears to have done nothing.
      setCancelRequestedRunId(result.status === 'running' ? target.id : null);
    } catch (err) {
      const status = err instanceof VerificationApiError ? err.status : 0;
      setCancelFailure({
        kind: status === 409 ? 'gone' : 'error',
        message: messageOf(err, 'Failed to cancel the verification run'),
      });
    } finally {
      cancelPendingRef.current = false;
      setCancelPending(false);
      lastFetchAtRef.current = 0;
      setNonce((value) => value + 1);
    }
  }, [worktreeId, runningRun]);

  const draftConfig = useCallback(async () => {
    if (draftPendingRef.current) return;
    draftPendingRef.current = true;
    setDraftPending(true);
    setDraftFailure(null);
    try {
      const result = await draftVerificationConfig(worktreeId);
      setDraftResult(result);
      // The POST reports what it wrote; the pane's state machine reads the file
      // back, so nothing moves until the config read re-runs.
      lastFetchAtRef.current = 0;
      setNonce((value) => value + 1);
    } catch (err) {
      const status = err instanceof VerificationApiError ? err.status : 0;
      setDraftFailure({
        kind: status === 409 ? 'conflict' : status === 422 ? 'empty' : 'error',
        message: messageOf(err, 'Failed to draft the verification config'),
      });
      // 409 means the file is there after all — someone else, or another tab,
      // created it. Re-reading turns the error into the state the operator
      // actually wanted.
      if (status === 409) {
        lastFetchAtRef.current = 0;
        setNonce((value) => value + 1);
      }
    } finally {
      draftPendingRef.current = false;
      setDraftPending(false);
    }
  }, [worktreeId]);

  return {
    worktreeId,
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
    config,
    configError,
    phase: resolveVerificationPhase(config, runs),
    draftPending,
    draftFailure,
    draftResult,
    availableGateIds,
    selectedGateIds,
    failedGateIds,
    toggleGate,
    setGateSelection,
    selectFailedGates,
    runningRun,
    cancelPending,
    // Derived rather than stored as a flag: the moment the run leaves the list
    // as `running`, the settling window is over and the note goes away without
    // anything having to clear it.
    cancelSettling: cancelRequestedRunId !== null && runningRun?.id === cancelRequestedRunId,
    cancelFailure,
    historyLimit,
    // A full page is the only evidence there may be another: the endpoint
    // reports no total. Stopping at the route's own ceiling keeps the last
    // press from turning into a 400 the operator has to interpret.
    canLoadMore: runs.length >= loadedLimit && loadedLimit < MAX_RUN_LIST_LIMIT,
    repositoryHistoryOpen,
    repositoryHistory,
    repositoryHistoryLoading,
    repositoryHistoryError,
    selectRun,
    refresh,
    rerun,
    cancelRun,
    loadMore,
    toggleRepositoryHistory,
    draftConfig,
  };
}

export default useWorktreeVerification;
