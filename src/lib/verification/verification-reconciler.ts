/**
 * Startup recovery for verification runs orphaned by a restart (Issue #1543).
 *
 * `verification_runs` is opened in `running` state and closed when the gates
 * finish, so a run in flight when the process dies leaves a `running` row that
 * nothing will ever close. Those rows are not merely stale: the per-worktree
 * conflict check treats an open run as "verification in progress", so a single
 * crash would lock that worktree out of verification permanently.
 *
 * Every run this finds is an orphan by construction — gate execution lives in
 * process memory, so after a restart none of them is actually running. They are
 * closed as `error` rather than `failed`: no gate reached a verdict about the
 * work, which is exactly the distinction `error` encodes.
 *
 * Follows the shape of {@link reconcileAllAssistantExecutions}
 * (`src/lib/assistant/non-interactive-execution-reconciler.ts`).
 *
 * @module lib/verification/verification-reconciler
 */

import type Database from 'better-sqlite3';
import {
  finishGateResult,
  finishVerificationRun,
  getVerificationRun,
  listRunningVerificationRuns,
} from '@/lib/db';

const RECONCILE_NOTE = '[reconciled after server restart: the runner process is gone]';

export interface VerificationReconcileReport {
  /** Runs closed as `error`. */
  runs: number;
  /** Gate results closed as `error` inside those runs. */
  gates: number;
}

/**
 * Close every `running` verification run and its open gate results.
 *
 * @returns counts of what was closed, so startup can log a non-zero recovery
 */
export function reconcileOrphanVerificationRuns(
  db: Database.Database
): VerificationReconcileReport {
  const report: VerificationReconcileReport = { runs: 0, gates: 0 };

  for (const run of listRunningVerificationRuns(db)) {
    const detail = getVerificationRun(db, run.id);
    for (const gate of detail?.gates ?? []) {
      if (gate.status !== 'running') continue;
      finishGateResult(db, gate.id, {
        status: 'error',
        exitCode: null,
        durationMs: null,
        logTail: [gate.logTail, RECONCILE_NOTE].filter(Boolean).join('\n'),
      });
      report.gates += 1;
    }

    finishVerificationRun(db, run.id, 'error');
    report.runs += 1;
  }

  return report;
}
