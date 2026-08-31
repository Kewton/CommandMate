/**
 * The pane explains its verdicts (Issue #2062)
 * @vitest-environment jsdom
 *
 * ## What was wrong
 *
 * Two runs the pane could not account for:
 *
 *   - `not_started` — printed as that raw token, in both locales, with nothing
 *     saying it means "this branch holds no work at all" (the verdict
 *     `commandmate verify` exits **21** for, which is not a failure).
 *   - `error` caused by skipped gates — `aggregateRunStatus` promotes a run
 *     holding any `skipped` gate to `error` on purpose, so that "we declined to
 *     check" cannot read as "we checked and it was fine". The commonest cause
 *     is `options.skipInPrimaryCheckout`, which declines every command gate
 *     when the worktree *is* the server's working directory. On screen that was
 *     an unexplained red run, and it read as a bug in the product.
 *
 * So the assertions here are on the *reason text*, not the badge: a snapshot of
 * each of those two runs must contain the sentence that accounts for it.
 *
 * Wording resolves through the real `en` dictionary, so a missing key fails
 * here instead of rendering as its own name.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerificationPane } from '@/components/worktree/VerificationPane';
import {
  resolveVerificationPhase,
  type WorktreeVerificationState,
} from '@/hooks/useWorktreeVerification';
import {
  PRIMARY_CHECKOUT_SKIP_LOG,
  WORK_EVIDENCE_SKIP_LOG,
} from '@/lib/verification/run-verdict-vocabulary';
import type {
  VerificationGateResultView,
  VerificationRunListItem,
  VerificationRunView,
  VerifyConfigResponse,
} from '@/lib/api/verification-api';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

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
  ],
  options: {
    baseRef: 'origin/develop',
    skipInPrimaryCheckout: true,
    maxLogTailBytes: 8192,
    requireCommit: false,
    requireEnvClean: false,
  },
  plannedGateIds: ['work-evidence', 'scope', 'lint'],
  error: null,
};

function gate(
  overrides: Partial<VerificationGateResultView> & Pick<VerificationGateResultView, 'gateId'>
): VerificationGateResultView {
  return {
    id: Math.floor(Math.random() * 1e6),
    runId: 30,
    command: 'n/a',
    status: 'skipped',
    exitCode: null,
    durationMs: 0,
    logTail: null,
    startedAt: '2026-08-31T00:00:00.000Z',
    finishedAt: '2026-08-31T00:00:00.000Z',
    source: 'builtin',
    ...overrides,
  };
}

function run(
  id: number,
  status: VerificationRunListItem['status']
): VerificationRunListItem {
  return {
    id,
    worktreeId: 'wt-1',
    instanceId: null,
    taskId: null,
    trigger: 'api',
    status,
    baseRef: 'origin/develop',
    startedAt: '2026-08-31T00:00:00.000Z',
    finishedAt: '2026-08-31T00:00:05.000Z',
  };
}

function stateFor(detail: VerificationRunView): WorktreeVerificationState {
  const listItem = run(detail.id, detail.status);
  const base: WorktreeVerificationState = {
    worktreeId: 'wt-1',
    task: null,
    runs: [listItem],
    latestRun: listItem,
    selectedRunId: detail.id,
    selectedRun: detail,
    loading: false,
    error: null,
    detailError: null,
    detailLoading: false,
    rerunPending: false,
    rerunFailure: null,
    config: CONFIG,
    configError: null,
    phase: 'result',
    draftPending: false,
    draftFailure: null,
    draftResult: null,
    // Issue #2063 additions. Spelled out rather than spread from a helper so a
    // reader of this fixture can see every field the pane may read.
    availableGateIds: [],
    selectedGateIds: null,
    failedGateIds: [],
    toggleGate: vi.fn(),
    setGateSelection: vi.fn(),
    selectFailedGates: vi.fn(),
    runningRun: null,
    cancelPending: false,
    cancelFailure: null,
    historyLimit: 10,
    canLoadMore: false,
    repositoryHistoryOpen: false,
    repositoryHistory: [],
    repositoryHistoryLoading: false,
    repositoryHistoryError: null,
    cancelRun: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn(),
    toggleRepositoryHistory: vi.fn(),
    selectRun: vi.fn(),
    refresh: vi.fn(),
    rerun: vi.fn().mockResolvedValue(undefined),
    draftConfig: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, phase: resolveVerificationPhase(base.config, base.runs) };
}

/** A branch with no commits and no dirty files: work-evidence fails, rest skipped. */
const NOT_STARTED_RUN: VerificationRunView = {
  ...run(30, 'not_started'),
  gates: [
    gate({
      gateId: 'work-evidence',
      status: 'failed',
      exitCode: 1,
      logTail: 'no commits ahead of origin/develop and no uncommitted changes',
    }),
    gate({ gateId: 'scope', logTail: WORK_EVIDENCE_SKIP_LOG }),
    gate({ gateId: 'lint', command: 'npm run lint', source: 'verify.yaml', logTail: WORK_EVIDENCE_SKIP_LOG }),
  ],
};

/** The primary-checkout guard: work exists, but every command gate is declined. */
const SKIPPED_ERROR_RUN: VerificationRunView = {
  ...run(31, 'error'),
  gates: [
    gate({ gateId: 'work-evidence', status: 'passed', exitCode: 0, runId: 31 }),
    gate({
      gateId: 'lint',
      command: 'npm run lint',
      source: 'verify.yaml',
      runId: 31,
      logTail: PRIMARY_CHECKOUT_SKIP_LOG,
    }),
  ],
};

describe('VerificationPane verdict vocabulary (Issue #2062)', () => {
  describe('a not_started run', () => {
    it('says what "no work evidence" means and which exit code it is', () => {
      render(<VerificationPane state={stateFor(NOT_STARTED_RUN)} />);

      const verdict = screen.getByTestId('verification-run-verdict');
      expect(verdict).toHaveTextContent('Not started');
      expect(verdict).toHaveTextContent(
        'No work evidence: neither a commit nor an uncommitted change.'
      );
      expect(verdict).toHaveTextContent('CLI exit=21');
    });

    it('names the gates that never ran and blames work-evidence, not them', () => {
      render(<VerificationPane state={stateFor(NOT_STARTED_RUN)} />);

      const skips = screen.getByTestId('verification-run-skip-reasons');
      expect(skips).toHaveTextContent('Gates that did not run');
      expect(skips).toHaveTextContent('scope:');
      expect(skips).toHaveTextContent('lint:');
      expect(skips).toHaveTextContent(
        'The `work-evidence` gate did not pass, so there was nothing for this gate to judge.'
      );
    });

    it('is fixed by snapshot', () => {
      render(<VerificationPane state={stateFor(NOT_STARTED_RUN)} />);
      expect(
        (screen.getByTestId('verification-run-verdict').textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
      ).toMatchSnapshot();
    });
  });

  describe('an error run caused by skipped gates', () => {
    it('separates "could not judge" from "failed"', () => {
      render(<VerificationPane state={stateFor(SKIPPED_ERROR_RUN)} />);

      const verdict = screen.getByTestId('verification-run-verdict');
      expect(verdict).toHaveTextContent('Could not judge');
      expect(verdict).toHaveTextContent('This is not the same as failing.');
    });

    it('names skipInPrimaryCheckout and says it is a guard, not a defect', () => {
      render(<VerificationPane state={stateFor(SKIPPED_ERROR_RUN)} />);

      const skips = screen.getByTestId('verification-run-skip-reasons');
      expect(skips).toHaveTextContent('lint:');
      expect(skips).toHaveTextContent('`options.skipInPrimaryCheckout` declined the gate');
      expect(skips).toHaveTextContent('it is not a defect');
    });

    it('is fixed by snapshot', () => {
      render(<VerificationPane state={stateFor(SKIPPED_ERROR_RUN)} />);
      expect(
        (screen.getByTestId('verification-run-verdict').textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
      ).toMatchSnapshot();
    });
  });

  describe('built-in gates', () => {
    it('describes each one on its own row, so the id is not all there is', () => {
      render(<VerificationPane state={stateFor(NOT_STARTED_RUN)} />);

      expect(screen.getByTestId('verification-gate-about-work-evidence')).toHaveTextContent(
        'Looks for commits ahead of `options.baseRef` or an uncommitted change.'
      );
      expect(screen.getByTestId('verification-gate-about-scope')).toHaveTextContent(
        "Reconciles the changed files against the execution contract's `scope.allow` / `scope.deny`."
      );
    });

    it('claims nothing about a gate the repository declared', () => {
      render(<VerificationPane state={stateFor(NOT_STARTED_RUN)} />);
      expect(screen.queryByTestId('verification-gate-about-lint')).toBeNull();
    });

    it('marks a skipped gate row as not-passing rather than leaving it neutral', () => {
      render(<VerificationPane state={stateFor(SKIPPED_ERROR_RUN)} />);
      expect(screen.getByTestId('verification-gate-skipped-lint')).toHaveTextContent(
        'That is not the same as passing.'
      );
    });
  });

  describe('the [contract] marker', () => {
    it('is explained when a run carries a contract gate', () => {
      const withContractGate: VerificationRunView = {
        ...SKIPPED_ERROR_RUN,
        gates: [
          ...SKIPPED_ERROR_RUN.gates,
          gate({
            gateId: 'issue-gate',
            command: 'npm run test:integration',
            status: 'passed',
            exitCode: 0,
            source: 'contract',
            runId: 31,
          }),
        ],
      };
      render(<VerificationPane state={stateFor(withContractGate)} />);
      expect(screen.getByTestId('verification-contract-source-hint')).toHaveTextContent(
        'marks a gate the execution contract sent to this branch asked for'
      );
    });

    it('stays out of the way when no gate came from a contract', () => {
      render(<VerificationPane state={stateFor(SKIPPED_ERROR_RUN)} />);
      expect(screen.queryByTestId('verification-contract-source-hint')).toBeNull();
    });
  });
});
