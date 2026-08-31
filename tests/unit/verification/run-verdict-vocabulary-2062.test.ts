/**
 * The Web UI's copy of the verify vocabulary is pinned to its producers
 * (Issue #2062).
 *
 * `lib/verification/run-verdict-vocabulary.ts` is browser-safe, so it cannot
 * import the modules it mirrors: `exitCodeForRunStatus` lives in the CLI's
 * runner and `gate-runner.ts` pulls better-sqlite3. That leaves two copies of
 * facts the pane now *displays* — the exit code per verdict, and the exact log
 * text a skipped gate carries — and a copy nothing checks is a copy that
 * drifts. This file is that check; it runs in node, where both sides import.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { VERIFICATION_RUN_STATUSES } from '@/lib/api/verification-api';
import { exitCodeForRunStatus } from '@/cli/utils/verify-runner';
import { CONFIG_GATE_ID, MUTEX_WAIT_SKIP_REASON } from '@/lib/verification/gate-runner';
// From their definition sites, not from gate-runner's re-export: the re-export
// could itself be re-pointed, and what this file has to pin is the id the
// runner writes into `verification_gate_results.gate_id`.
import {
  ENV_CLEAN_GATE_ID,
  SCOPE_GATE_ID,
  WORK_EVIDENCE_GATE_ID,
} from '@/lib/verification/verify-config';
import {
  SCOPE_SKIP_NO_CONTRACT,
  SCOPE_SKIP_NOT_REQUIRED,
  scopeSkipDetachedContract,
} from '@/lib/verification/scope-gate';
import {
  BUILTIN_GATE_DESCRIPTION_KEYS,
  LEGEND_RUN_STATUSES,
  PRIMARY_CHECKOUT_SKIP_LOG,
  RUN_STATUS_EXIT_CODE,
  SKIP_LOG_MARKERS,
  WORK_EVIDENCE_SKIP_LOG,
  builtinGateDescriptionKey,
  classifySkipReason,
} from '@/lib/verification/run-verdict-vocabulary';

describe('RUN_STATUS_EXIT_CODE (Issue #2062)', () => {
  it('agrees with the CLI for every run status', () => {
    for (const status of VERIFICATION_RUN_STATUSES) {
      const mirrored = RUN_STATUS_EXIT_CODE[status];
      if (status === 'running') {
        // A run in flight has no verdict, so the CLI never asks for its code.
        expect(mirrored).toBeNull();
        continue;
      }
      expect(mirrored).toBe(exitCodeForRunStatus(status));
    }
  });

  it('carries the three codes the pane promises in its legend', () => {
    expect(RUN_STATUS_EXIT_CODE.passed).toBe(0);
    expect(RUN_STATUS_EXIT_CODE.failed).toBe(20);
    expect(RUN_STATUS_EXIT_CODE.not_started).toBe(21);
  });

  it('legends only statuses that have a code', () => {
    for (const status of LEGEND_RUN_STATUSES) {
      expect(RUN_STATUS_EXIT_CODE[status]).not.toBeNull();
    }
  });
});

describe('skip reasons (Issue #2062)', () => {
  it('spells the work-evidence skip with the gate id the runner uses', () => {
    expect(WORK_EVIDENCE_SKIP_LOG).toBe(`skipped: the ${WORK_EVIDENCE_GATE_ID} gate did not pass.`);
  });

  it('matches the markers against the strings their producers emit', () => {
    expect(MUTEX_WAIT_SKIP_REASON).toContain(SKIP_LOG_MARKERS.mutex);
    expect(scopeSkipDetachedContract('task-1', 'succeeded')).toContain(
      SKIP_LOG_MARKERS.detachedContract
    );
    expect(SCOPE_SKIP_NO_CONTRACT).toContain(SKIP_LOG_MARKERS.noContract);
    expect(SCOPE_SKIP_NOT_REQUIRED).toContain(SKIP_LOG_MARKERS.notRequired);
  });

  it('classifies each producer to its own reason', () => {
    expect(classifySkipReason(PRIMARY_CHECKOUT_SKIP_LOG)).toBe('primaryCheckout');
    expect(classifySkipReason(WORK_EVIDENCE_SKIP_LOG)).toBe('workEvidence');
    expect(classifySkipReason(`${MUTEX_WAIT_SKIP_REASON} waited=3s`)).toBe('mutex');
    expect(classifySkipReason(scopeSkipDetachedContract('task-1', 'succeeded'))).toBe(
      'detachedContract'
    );
    expect(classifySkipReason(SCOPE_SKIP_NO_CONTRACT)).toBe('noContract');
    expect(classifySkipReason(SCOPE_SKIP_NOT_REQUIRED)).toBe('notRequired');
  });

  it('answers unknown rather than guessing for an unrecognised or absent log', () => {
    expect(classifySkipReason(null)).toBe('unknown');
    expect(classifySkipReason('')).toBe('unknown');
    expect(classifySkipReason('skipped: something a future Issue writes')).toBe('unknown');
  });
});

/**
 * Every id the runner can write with `source: 'builtin'`, read from the four
 * constants that define them rather than spelled out here.
 *
 * A literal list is the shape this test shipped with, and it had a hole: only
 * `WORK_EVIDENCE_GATE_ID` was actually reconciled, so renaming
 * `ENV_CLEAN_GATE_ID` to `env_clean` left the runner recording `env_clean`
 * rows, `builtinGateDescriptionKey` answering `null` for them, the pane
 * silently dropping the description — and this test green.
 */
const RUNNER_BUILTIN_GATE_IDS = [
  WORK_EVIDENCE_GATE_ID,
  SCOPE_GATE_ID,
  ENV_CLEAN_GATE_ID,
  CONFIG_GATE_ID,
] as const;

describe('built-in gate descriptions (Issue #2062)', () => {
  it('covers every built-in gate id the runner can record', () => {
    expect(Object.keys(BUILTIN_GATE_DESCRIPTION_KEYS).sort()).toEqual(
      [...RUNNER_BUILTIN_GATE_IDS].sort()
    );
  });

  it('answers a description key for each of those ids', () => {
    const unmapped = RUNNER_BUILTIN_GATE_IDS.filter(
      (gateId) => builtinGateDescriptionKey(gateId) === null
    );
    expect(unmapped).toEqual([]);
    // The mapping is id → dictionary key segment, and the two differ (the ids
    // are hyphenated, the keys are not), so at least one pair is pinned by name.
    expect(builtinGateDescriptionKey(WORK_EVIDENCE_GATE_ID)).toBe('workEvidence');
  });

  it('claims nothing about a gate the repository declared', () => {
    expect(builtinGateDescriptionKey('lint')).toBeNull();
  });
});
