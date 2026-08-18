/**
 * Presentation mapping for task / verification vocabulary (Issue #1816).
 *
 * The wording lives in `locales/{en,ja}/worktree.json`; only the colour role
 * and the small format helpers live here, so the chip and the pane cannot drift
 * apart on what "failed" looks like.
 *
 * Every record is keyed by the full status union with no default branch, so
 * adding a status to `lib/db` fails the build here instead of silently
 * rendering as neutral grey.
 *
 * @module config/verification-display
 */

import type { BadgeVariant } from '@/components/ui/Badge';
import type {
  TaskStatus,
  VerificationGateStatus,
  VerificationRunStatus,
} from '@/lib/api/verification-api';

/**
 * Colour role per task status.
 *
 * `not_started` is a warning rather than an error: nothing was judged, which is
 * a different thing from work that was judged and did not pass.
 */
export const TASK_STATUS_VARIANT: Record<TaskStatus, BadgeVariant> = {
  pending: 'gray',
  running: 'info',
  waiting_input: 'warning',
  verifying: 'info',
  succeeded: 'success',
  failed: 'error',
  not_started: 'warning',
  cancelled: 'gray',
};

/** Colour role per run verdict (`RESULT <status>` in the CLI). */
export const RUN_STATUS_VARIANT: Record<VerificationRunStatus, BadgeVariant> = {
  running: 'info',
  passed: 'success',
  failed: 'error',
  not_started: 'warning',
  error: 'error',
  cancelled: 'gray',
};

/** Colour role per gate verdict (`GATE <id> <LABEL>` in the CLI). */
export const GATE_STATUS_VARIANT: Record<VerificationGateStatus, BadgeVariant> = {
  running: 'info',
  passed: 'success',
  failed: 'error',
  timeout: 'error',
  skipped: 'gray',
  error: 'error',
};

/** Gate verdicts that mean the gate did not pass (`skipped` is not one). */
export const FAILING_GATE_STATUSES: readonly VerificationGateStatus[] = [
  'failed',
  'timeout',
  'error',
];

/**
 * Duration in the CLI's own shape (`duration=12s` / `1.2s`), or `null` when the
 * row carries no measurement.
 */
export function formatGateDuration(durationMs: number | null | undefined): string | null {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) {
    return null;
  }
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** Result of trimming a gate log to its last lines. */
export interface LogTailExcerpt {
  lines: string[];
  /** Lines dropped from the head; 0 when the whole log is shown. */
  omitted: number;
}

/**
 * Last `max` lines of a gate log.
 *
 * Keeps the tail rather than the head for the same reason the CLI does: every
 * producer puts its conclusion at the end.
 */
export function excerptLogTail(log: string | null | undefined, max: number): LogTailExcerpt {
  const text = (log ?? '').replace(/\n+$/, '');
  if (text === '') return { lines: [], omitted: 0 };
  const lines = text.split('\n');
  if (lines.length <= max) return { lines, omitted: 0 };
  return { lines: lines.slice(-max), omitted: lines.length - max };
}
