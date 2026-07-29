/**
 * Verification run driver shared by `commandmate verify` and `wait --verify`
 * (Issue #1544).
 *
 * The server answers a verify request with 202 and a run id rather than a
 * verdict — gates are whole test suites and builds — so every caller has to
 * start a run, poll it to a terminal status, and translate that status into an
 * exit code. That sequence lives here once so `verify` and `wait` cannot drift
 * apart on what "passed" means.
 *
 * @module cli/utils/verify-runner
 */

import { ExitCode, VerifyExitCode } from '../types';
import type {
  VerificationGateResultView,
  VerificationRunStatus,
  VerificationRunView,
  VerifyRunResponse,
  VerifyStartResponse,
} from '../types/api-responses';
import { ApiClient, ApiError, assertResponseShape } from './api-client';

/** Matches the wait command's cadence; runs are minutes long, not seconds. */
export const VERIFY_POLL_INTERVAL_MS = 5000;

/** Built-in gate id; mirrors WORK_EVIDENCE_GATE_ID in lib/verification/gate-runner.ts. */
export const WORK_EVIDENCE_GATE_ID = 'work-evidence';

export interface VerificationRequest {
  worktreeId: string;
  /** 'manual' for the verify command, 'wait' when chained after wait. */
  trigger: 'manual' | 'wait';
  instanceId?: string;
  /** Omitted means work-evidence plus every gate declared in verify.yaml. */
  gateIds?: string[];
  /** Seconds before the CLI stops polling and reports TIMEOUT. */
  timeoutSec?: number;
  /** Stream the final `RESULT <status>` line goes to. Defaults to stdout. */
  resultStream?: 'stdout' | 'stderr';
  /** Suppress the RESULT line because the caller prints JSON on stdout instead. */
  suppressResultLine?: boolean;
}

export interface VerificationOutcome {
  exitCode: number;
  /** Last observed run; on timeout this is still `running`. */
  run?: VerificationRunView;
}

const GATE_LABELS: Record<string, string> = {
  passed: 'PASS',
  failed: 'FAIL',
  timeout: 'TIMEOUT',
  skipped: 'SKIP',
  error: 'ERROR',
};

/**
 * Translate a terminal run status into a process exit code.
 *
 * `error` and `cancelled` mean no verdict was reached, so they take the generic
 * UNEXPECTED_ERROR code rather than VERIFY_FAILED — a caller branching on 20
 * must be able to trust that gates actually ran and judged the work.
 */
export function exitCodeForRunStatus(status: VerificationRunStatus): number {
  switch (status) {
    case 'passed':
      return VerifyExitCode.SUCCESS;
    case 'failed':
      return VerifyExitCode.VERIFY_FAILED;
    case 'not_started':
      return VerifyExitCode.NOT_STARTED;
    default:
      return ExitCode.UNEXPECTED_ERROR;
  }
}

/**
 * Parse `--gates a,b` into a gate id list.
 * @returns The ids, or null when the value names no gate at all.
 */
export function parseGateIds(value: string | undefined): string[] | null | undefined {
  if (value === undefined) return undefined;
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  return ids.length > 0 ? ids : null;
}

function formatDetail(gate: VerificationGateResultView): string {
  // The work-evidence gate's verdict is a count, not an exit status; surfacing
  // the counts is what tells a caller *why* a run came back not_started.
  if (gate.gateId === WORK_EVIDENCE_GATE_ID && gate.logTail) {
    const match = /commits=(\d+)\s+uncommitted=(\d+)/.exec(gate.logTail);
    if (match) return `commits=${match[1]}, uncommitted=${match[2]}`;
  }

  if (gate.status === 'skipped') {
    const reason = gate.logTail?.split('\n')[0]?.trim();
    return reason ? reason.slice(0, 160) : 'not run';
  }

  const parts: string[] = [];
  if (gate.exitCode !== null && gate.exitCode !== undefined) parts.push(`exit=${gate.exitCode}`);
  if (gate.durationMs !== null && gate.durationMs !== undefined) {
    parts.push(`${(gate.durationMs / 1000).toFixed(1)}s`);
  }
  return parts.join(', ');
}

function formatGateLine(gate: VerificationGateResultView): string {
  const label = GATE_LABELS[gate.status] ?? gate.status.toUpperCase();
  const detail = formatDetail(gate);
  return detail ? `GATE ${gate.gateId} ${label} (${detail})` : `GATE ${gate.gateId} ${label}`;
}

/**
 * Print each gate exactly once, when it reaches a terminal status.
 * @param reported - Gate row ids already printed; mutated in place.
 */
function reportGates(gates: VerificationGateResultView[], reported: Set<number>): void {
  for (const gate of gates) {
    if (gate.status === 'running' || reported.has(gate.id)) continue;
    reported.add(gate.id);
    console.error(formatGateLine(gate));
    // A failing gate without its log forces the caller back to the API to learn
    // anything actionable, which defeats the point of a CLI verdict.
    if (gate.status !== 'passed' && gate.logTail) {
      console.error(gate.logTail.replace(/\n+$/, ''));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turn the verify route's 409 into an error that names the blocking run.
 *
 * handleApiError() maps 409 through its default branch to "Unexpected HTTP
 * status: 409", which tells the caller nothing about what to do next.
 */
function withConflictMessage(error: unknown, worktreeId: string): unknown {
  if (!(error instanceof ApiError) || error.statusCode !== 409) return error;
  const running = error.payload?.runningRunId;
  const which = typeof running === 'number' ? ` (run ${running})` : '';
  return new ApiError(
    `A verification run is already in progress for '${worktreeId}'${which}. ` +
      'Wait for it to finish, then retry.',
    error.exitCode,
    error.statusCode,
    error.payload
  );
}

/**
 * Start a verification run and poll it to a verdict.
 *
 * @throws ApiError when the run cannot be started or the server stops answering
 */
export async function runVerification(
  client: ApiClient,
  request: VerificationRequest
): Promise<VerificationOutcome> {
  const { worktreeId } = request;

  let runId: number;
  try {
    const started = await client.post<VerifyStartResponse>(`/api/worktrees/${worktreeId}/verify`, {
      trigger: request.trigger,
      instanceId: request.instanceId,
      gateIds: request.gateIds,
    });
    runId = assertResponseShape<VerifyStartResponse>(
      started,
      ['runId'],
      `POST /api/worktrees/${worktreeId}/verify`
    ).runId;
  } catch (error) {
    throw withConflictMessage(error, worktreeId);
  }

  console.error(`Verifying: ${worktreeId} (run ${runId})`);

  const startedAt = Date.now();
  const reported = new Set<number>();
  const runPath = `/api/worktrees/${worktreeId}/verify/runs/${runId}`;
  let lastRun: VerificationRunView | undefined;

  while (true) {
    const body = await client.get<VerifyRunResponse>(runPath);
    const run = assertResponseShape<VerifyRunResponse>(body, ['run'], `GET ${runPath}`).run;
    lastRun = run;
    reportGates(run.gates ?? [], reported);

    if (run.status !== 'running') {
      if (!request.suppressResultLine) {
        const line = `RESULT ${run.status}`;
        if (request.resultStream === 'stderr') console.error(line);
        else console.log(line);
      }
      return { exitCode: exitCodeForRunStatus(run.status), run };
    }

    // Checked after the terminal-status branch so a run that finishes exactly on
    // the deadline still reports its verdict instead of a timeout.
    if (request.timeoutSec) {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed >= request.timeoutSec) {
        console.error(
          `Timeout: verification of ${worktreeId} exceeded ${request.timeoutSec}s ` +
            `(run ${runId} is still running server-side)`
        );
        return { exitCode: VerifyExitCode.TIMEOUT, run: lastRun };
      }
    }

    await sleep(VERIFY_POLL_INTERVAL_MS);
  }
}
