/**
 * Vocabulary the two Verification surfaces read (Issue #2062).
 *
 * Until this Issue the Web UI printed the run and gate statuses as the raw
 * database tokens — `passed`, `not_started`, `SKIP`, `TIMEOUT` — identically in
 * both locales, and said nothing about what any of them meant. The words now
 * live in `locales/{en,ja}/worktree.json`; what lives here is the part that is
 * *not* wording: which CLI exit code a verdict corresponds to, which gate ids
 * are built in, and how to read the reason out of a skipped gate's log.
 *
 * BROWSER-SAFE ON PURPOSE. `VerificationPane` is a client component, and every
 * other module in this directory reads the filesystem or the database. This one
 * imports types only, so it erases out of the browser bundle entirely; a
 * runtime import of `verify-config.ts` here would drag `fs` and `yaml` in with
 * it. Keep it that way.
 *
 * @module lib/verification/run-verdict-vocabulary
 */

import type { VerificationRunStatus } from '@/cli/types/api-responses';

/**
 * The process exit code `commandmate verify` reports for each run verdict.
 *
 * A mirror of `exitCodeForRunStatus` in `src/cli/utils/verify-runner.ts`, which
 * the browser cannot import (it wraps `process.exit` and the CLI's HTTP client).
 * `tests/unit/verification/run-verdict-vocabulary-2062.test.ts` pins the two
 * together, so the mirror cannot drift silently.
 *
 * `running` is `null` rather than a number: a run still in flight has produced
 * no verdict, so there is no code to report — which is a different statement
 * from "it produced 0".
 */
export const RUN_STATUS_EXIT_CODE: Record<VerificationRunStatus, number | null> = {
  running: null,
  passed: 0,
  failed: 20,
  not_started: 21,
  // `error` and `cancelled` both mean "we could not judge", which the CLI maps
  // to the generic UNEXPECTED_ERROR rather than to VERIFY_FAILED — a caller
  // branching on 20 must be able to trust that gates actually ran.
  error: 99,
  cancelled: 99,
};

/**
 * Verdicts the pane spells out in its `exit 0 / 20 / 21` legend, in that order.
 *
 * `running` is absent because it has no code, and `cancelled` because it shares
 * 99 with `error` and #2063 has not yet shipped anything that can produce it —
 * listing it would advertise a state the operator cannot currently reach.
 */
export const LEGEND_RUN_STATUSES: readonly VerificationRunStatus[] = [
  'passed',
  'failed',
  'not_started',
  'error',
];

/**
 * Built-in gate id → the key segment under `verification.gates.builtin` that
 * describes it.
 *
 * Spelled as data rather than as `t('...' + gateId)` because the ids contain
 * hyphens and the dictionary keys do not: the mapping is the one place that
 * knows `work-evidence` is described by `workEvidence`.
 *
 * `config` is the pseudo-gate the runner writes when `.commandmate/verify.yaml`
 * itself could not be read — it is the only row a run in that state has, and
 * without a description it reads as a gate the repository declared.
 */
export const BUILTIN_GATE_DESCRIPTION_KEYS: Readonly<Record<string, string>> = {
  'work-evidence': 'workEvidence',
  scope: 'scope',
  'env-clean': 'envClean',
  config: 'config',
};

/** The description key for a built-in gate, or `null` for a declared one. */
export function builtinGateDescriptionKey(gateId: string): string | null {
  return BUILTIN_GATE_DESCRIPTION_KEYS[gateId] ?? null;
}

/**
 * Exact `logTail` the runner records for a gate the primary-checkout guard
 * declined to run.
 *
 * Owned here rather than inline in `gate-runner.ts` so the producer and the
 * reader are the same string. This is the skip that made `skipInPrimaryCheckout`
 * look like a bug: it turns the run into `error` (see `aggregateRunStatus`),
 * and until #2062 the pane showed that `error` with no cause at all.
 */
export const PRIMARY_CHECKOUT_SKIP_LOG =
  'skipped: worktreePath is the server process working directory and ' +
  'options.skipInPrimaryCheckout is true.';

/**
 * Exact `logTail` the runner records for the gates it leaves unrun once
 * `work-evidence` has failed. Kept in step with `WORK_EVIDENCE_GATE_ID` by
 * `tests/unit/verification/run-verdict-vocabulary-2062.test.ts`.
 */
export const WORK_EVIDENCE_SKIP_LOG = 'skipped: the work-evidence gate did not pass.';

/**
 * Substrings that identify the remaining skip producers.
 *
 * Substrings and not whole strings: `scopeSkipDetachedContract` and
 * `mutexWaitTimeoutLog` interpolate ids, durations and paths, so only the fixed
 * clause can be matched. Each one is pinned against its producer by the test
 * named above, so a reworded producer fails there instead of silently falling
 * through to the generic reason.
 */
export const SKIP_LOG_MARKERS = {
  mutex: 'reason=mutex-wait',
  detachedContract: 'was NOT judged',
  noContract: 'no contract is attached to this run',
  notRequired: 'success.requireScopeClean: false',
} as const;

/**
 * Why a gate did not run, as a key segment under `verification.gates.skipReason`.
 *
 * `unknown` is the honest answer for a log this module does not recognise — the
 * pane then points at the log tail rather than inventing a cause.
 */
export type SkipReasonKey =
  | 'primaryCheckout'
  | 'workEvidence'
  | 'mutex'
  | 'detachedContract'
  | 'noContract'
  | 'notRequired'
  | 'unknown';

/** Read the reason a `skipped` gate carries in its log tail. */
export function classifySkipReason(logTail: string | null | undefined): SkipReasonKey {
  const log = logTail ?? '';
  if (log.includes(PRIMARY_CHECKOUT_SKIP_LOG)) return 'primaryCheckout';
  if (log.includes(WORK_EVIDENCE_SKIP_LOG)) return 'workEvidence';
  if (log.includes(SKIP_LOG_MARKERS.mutex)) return 'mutex';
  if (log.includes(SKIP_LOG_MARKERS.detachedContract)) return 'detachedContract';
  if (log.includes(SKIP_LOG_MARKERS.noContract)) return 'noContract';
  if (log.includes(SKIP_LOG_MARKERS.notRequired)) return 'notRequired';
  return 'unknown';
}
