/**
 * Browser client for the task-contract / verification endpoints (Issue #1816).
 *
 * Every function here wraps an endpoint that already existed (#1542 / #1543 /
 * #1545): the Web UI adds no route of its own. The whole point of the Issue is
 * that the verdicts these endpoints already produce were reachable only from
 * the CLI's stdout.
 *
 * The response shapes are imported from `@/cli/types/api-responses` rather than
 * re-declared: that module is the repository's canonical mirror of the route
 * payloads, it is types-only (nothing runtime, so `import type` erases it out
 * of the browser bundle exactly as it keeps better-sqlite3 out of the CLI's),
 * and a third copy would be a third thing to keep in step with the DB layer.
 *
 * Error policy — a missing *run* is data, a missing *worktree* is a fault:
 * `fetchVerificationRun` answers 404 with `null` because a run id can go stale
 * while the pane is open (another client re-verified, the id came from a link),
 * whereas the list endpoints throw, because the only 404 they can produce means
 * the worktree this whole screen is about does not exist.
 *
 * @module lib/api/verification-api
 */

import type {
  TaskContractView,
  TaskStatus,
  TaskView,
  VerificationGateResultView,
  VerificationGateSource,
  VerificationGateStatus,
  VerificationRunStatus,
  VerificationRunView,
} from '@/cli/types/api-responses';

export type {
  TaskContractView,
  TaskStatus,
  TaskView,
  VerificationGateResultView,
  VerificationGateSource,
  VerificationGateStatus,
  VerificationRunStatus,
  VerificationRunView,
};

/**
 * A run as `GET /verify/runs` returns it.
 *
 * The list endpoint deliberately omits gate rows (log tails are large enough
 * that a list view would pay the detail view's cost), so the element type is
 * {@link VerificationRunView} *without* `gates` — declaring the field here
 * would let the runs list read something the server never sends.
 */
export type VerificationRunListItem = Omit<VerificationRunView, 'gates'>;

/** Task statuses, in the order `docs/user-guide/cli-operations-guide.md` lists them. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'running',
  'waiting_input',
  'verifying',
  'succeeded',
  'failed',
  'not_started',
  'cancelled',
];

/** Run verdicts, mirroring `VerificationRunStatus` in `lib/db/verification-db.ts`. */
export const VERIFICATION_RUN_STATUSES: readonly VerificationRunStatus[] = [
  'running',
  'passed',
  'failed',
  'not_started',
  'error',
  'cancelled',
];

/** Gate verdicts, mirroring `VerificationGateStatus` in `lib/db/verification-db.ts`. */
export const VERIFICATION_GATE_STATUSES: readonly VerificationGateStatus[] = [
  'running',
  'passed',
  'failed',
  'timeout',
  'skipped',
  'error',
];

/**
 * Log lines shown per gate.
 *
 * Same cap as the CLI's `MAX_PRINTED_LOG_TAIL_LINES`
 * (`src/cli/utils/verify-runner.ts`), so "the last 40 lines" means the same
 * thing on both surfaces and a reader comparing them is not comparing two
 * different excerpts.
 */
export const MAX_DISPLAYED_LOG_TAIL_LINES = 40;

/** Runs requested for the pane's list; the route's own default is 20. */
export const DEFAULT_RUN_LIST_LIMIT = 10;

/** An HTTP failure from one of the verification endpoints. */
export class VerificationApiError extends Error {
  readonly status: number;
  /** Run blocking a 409 conflict, when the route named one. */
  readonly runningRunId: number | null;

  constructor(message: string, status: number, runningRunId: number | null = null) {
    super(message);
    this.name = 'VerificationApiError';
    this.status = status;
    this.runningRunId = runningRunId;
  }
}

interface ErrorPayload {
  error?: unknown;
  runningRunId?: unknown;
}

async function fail(res: Response, fallback: string): Promise<never> {
  const payload = (await res.json().catch(() => ({}))) as ErrorPayload;
  const message = typeof payload.error === 'string' ? payload.error : `${fallback} (${res.status})`;
  const runningRunId = typeof payload.runningRunId === 'number' ? payload.runningRunId : null;
  throw new VerificationApiError(message, res.status, runningRunId);
}

function worktreePath(worktreeId: string): string {
  return `/api/worktrees/${encodeURIComponent(worktreeId)}`;
}

/**
 * Most recent task (execution contract) recorded for a worktree, or `null` when
 * the branch has never been delegated with one.
 */
export async function fetchLatestTask(
  worktreeId: string,
  signal?: AbortSignal
): Promise<TaskView | null> {
  const res = await fetch(`${worktreePath(worktreeId)}/tasks?limit=1`, { signal });
  if (!res.ok) {
    return fail(res, 'Failed to load tasks');
  }
  const data = (await res.json()) as { tasks?: TaskView[] };
  return data.tasks?.[0] ?? null;
}

/** Recent verification runs, newest first. Verdicts only — no gate rows. */
export async function fetchVerificationRuns(
  worktreeId: string,
  limit: number = DEFAULT_RUN_LIST_LIMIT,
  signal?: AbortSignal
): Promise<VerificationRunListItem[]> {
  const res = await fetch(`${worktreePath(worktreeId)}/verify/runs?limit=${limit}`, { signal });
  if (!res.ok) {
    return fail(res, 'Failed to load verification runs');
  }
  const data = (await res.json()) as { runs?: VerificationRunListItem[] };
  return data.runs ?? [];
}

/**
 * One run with its gate results, or `null` when the run is gone / belongs to
 * another worktree (both answered 404 by the route).
 */
export async function fetchVerificationRun(
  worktreeId: string,
  runId: number,
  signal?: AbortSignal
): Promise<VerificationRunView | null> {
  const res = await fetch(`${worktreePath(worktreeId)}/verify/runs/${runId}`, { signal });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    return fail(res, 'Failed to load the verification run');
  }
  const data = (await res.json()) as { run: VerificationRunView };
  return data.run;
}

/** Options accepted by {@link startVerification}. */
export interface StartVerificationOptions {
  /** Gate ids to run; omitted means work-evidence plus every declared gate. */
  gateIds?: string[];
  /** Task the run judges; omitted lets the server resolve the worktree's own. */
  taskId?: string;
}

/**
 * Start a verification run and return its id.
 *
 * The route answers 202, never a verdict — gates are whole suites and builds —
 * so the caller polls the list/detail endpoints instead of holding the
 * connection open. `trigger` is left unset so the run is recorded as `api`,
 * which is what it is; claiming `manual` would put Web UI runs in the same
 * bucket as `commandmate verify`.
 */
export async function startVerification(
  worktreeId: string,
  options: StartVerificationOptions = {}
): Promise<number> {
  const res = await fetch(`${worktreePath(worktreeId)}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    return fail(res, 'Failed to start verification');
  }
  const data = (await res.json()) as { runId?: unknown };
  if (typeof data.runId !== 'number') {
    throw new VerificationApiError('Verification response carried no run id', res.status);
  }
  return data.runId;
}
