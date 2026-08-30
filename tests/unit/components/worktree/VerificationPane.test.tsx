/**
 * Tests for VerificationPane (Issue #1816)
 * @vitest-environment jsdom
 *
 * The pane is fully controlled, so every state the Issue's acceptance criteria
 * name — contract present / absent, run list, gate table, re-verify — is a
 * plain object here. The wording goes through the real dictionary so a missing
 * `verification.*` key fails the test instead of rendering the raw key.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { VerificationPane } from '@/components/worktree/VerificationPane';
import {
  resolveVerificationPhase,
  type WorktreeVerificationState,
} from '@/hooks/useWorktreeVerification';
import type {
  TaskView,
  VerificationGateResultView,
  VerificationRunListItem,
  VerificationRunView,
  VerifyConfigResponse,
} from '@/lib/api/verification-api';

/** A repository that has declared its gates (the ordinary case). */
const CONFIG_PRESENT: VerifyConfigResponse = {
  exists: true,
  path: '.commandmate/verify.yaml',
  gates: [
    { id: 'lint', command: 'npm run lint', timeoutSec: 900, mutex: null, retryOnFail: null, flakyIsPass: null },
    { id: 'unit', command: 'npm run test:unit', timeoutSec: 1800, mutex: null, retryOnFail: null, flakyIsPass: null },
  ],
  options: {
    baseRef: 'origin/develop',
    skipInPrimaryCheckout: true,
    maxLogTailBytes: 8192,
    requireCommit: false,
    requireEnvClean: false,
  },
  plannedGateIds: ['work-evidence', 'scope', 'lint', 'unit'],
  error: null,
};

/** A repository with no `.commandmate/verify.yaml` at all. */
const CONFIG_ABSENT: VerifyConfigResponse = {
  exists: false,
  path: '.commandmate/verify.yaml',
  gates: [],
  options: null,
  plannedGateIds: [],
  error: null,
};

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const TASK = {
  id: 'task-1',
  worktreeId: 'wt-1',
  cliToolId: 'claude',
  instanceId: null,
  title: 'Issue #1816: expose verification in the Web UI',
  goal: 'Wire the existing task / verification endpoints into the worktree screen.',
  contractPath: '.commandmate/tasks/issue-1816.yaml',
  contract: {
    version: 1,
    title: 'Issue #1816: expose verification in the Web UI',
    goal: 'Wire the existing task / verification endpoints into the worktree screen.',
    scope: { allow: ['src/**', 'locales/**'], deny: ['src/cli/**'] },
    verify: { gates: ['lint', 'unit'] },
    autoYes: { mode: 'allow-listed', allowPromptTypes: ['yes_no'], denyPatterns: [] },
    success: { requireWorkEvidence: true, requireScopeClean: true },
  },
  status: 'failed',
  lastVerificationRunId: 9,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  startedAt: '2026-08-18T00:00:30.000Z',
  finishedAt: null,
} as unknown as TaskView;

const RUN_9: VerificationRunListItem = {
  id: 9,
  worktreeId: 'wt-1',
  instanceId: null,
  taskId: 'task-1',
  trigger: 'api',
  status: 'failed',
  baseRef: 'origin/develop',
  startedAt: '2026-08-18T00:01:00.000Z',
  finishedAt: '2026-08-18T00:02:00.000Z',
};

const RUN_8: VerificationRunListItem = { ...RUN_9, id: 8, status: 'passed', trigger: 'wait' };

const GATES: VerificationGateResultView[] = [
  {
    id: 1,
    runId: 9,
    gateId: 'lint',
    command: 'npm run lint',
    status: 'passed',
    exitCode: 0,
    durationMs: 12_000,
    logTail: null,
    startedAt: '2026-08-18T00:01:00.000Z',
    finishedAt: '2026-08-18T00:01:12.000Z',
    source: 'verify.yaml',
    timingsMeasured: true,
  },
  {
    id: 2,
    runId: 9,
    gateId: 'unit',
    command: 'npm run test:unit',
    status: 'failed',
    exitCode: 1,
    durationMs: 45_000,
    logTail: 'FAIL tests/unit/foo.test.ts\n1 failed, 20 passed',
    startedAt: '2026-08-18T00:01:12.000Z',
    finishedAt: '2026-08-18T00:01:57.000Z',
    source: 'verify.yaml',
    timingsMeasured: true,
  },
];

const RUN_DETAIL: VerificationRunView = { ...RUN_9, gates: GATES };

function buildState(overrides: Partial<WorktreeVerificationState> = {}): WorktreeVerificationState {
  const base: WorktreeVerificationState = {
    worktreeId: 'wt-1',
    task: null,
    runs: [],
    latestRun: null,
    selectedRunId: null,
    selectedRun: null,
    loading: false,
    error: null,
    detailError: null,
    detailLoading: false,
    rerunPending: false,
    rerunFailure: null,
    config: CONFIG_PRESENT,
    configError: null,
    phase: 'result',
    draftPending: false,
    draftFailure: null,
    draftResult: null,
    selectRun: vi.fn(),
    refresh: vi.fn(),
    rerun: vi.fn().mockResolvedValue(undefined),
    draftConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  // The phase is derived, never chosen: a fixture that says `no-config` while
  // carrying a config would pin a rendering the product can never reach.
  return { ...base, phase: overrides.phase ?? resolveVerificationPhase(base.config, base.runs) };
}

const LOADED = (overrides: Partial<WorktreeVerificationState> = {}) =>
  buildState({
    task: TASK,
    runs: [RUN_9, RUN_8],
    latestRun: RUN_9,
    selectedRunId: 9,
    selectedRun: RUN_DETAIL,
    ...overrides,
  });

describe('VerificationPane (Issue #1816)', () => {
  describe('empty state', () => {
    it('tells the operator how to create a contract when there is none', () => {
      render(<VerificationPane state={buildState()} />);

      const empty = screen.getByTestId('verification-contract-empty');
      expect(empty).toHaveTextContent('No contract on this branch.');
      // 実装規約 3 の同型: 正しい道具の名前を出す
      expect(empty).toHaveTextContent('commandmate send --contract');
      expect(empty).toHaveTextContent('cmate-task-contract');
    });

    it('shows the empty run list and no gate section', () => {
      render(<VerificationPane state={buildState()} />);

      expect(screen.getByTestId('verification-runs-empty')).toHaveTextContent(
        'No verification run yet.'
      );
      expect(screen.queryByTestId('verification-gates-section')).toBeNull();
    });
  });

  describe('contract summary', () => {
    it('shows the declarations that decide the verdict', () => {
      render(<VerificationPane state={LOADED()} />);

      const contract = screen.getByTestId('verification-contract');
      expect(contract).toHaveTextContent('src/**, locales/**');
      expect(contract).toHaveTextContent('src/cli/**');
      expect(contract).toHaveTextContent('lint, unit');
      expect(contract).toHaveTextContent('allow-listed');
      expect(contract).toHaveTextContent('.commandmate/tasks/issue-1816.yaml');
      expect(screen.getByTestId('verification-task-status')).toHaveTextContent('failed');
    });

    it('reads `gates: null` as "all declared gates", not as "none"', () => {
      const task = {
        ...TASK,
        contract: { ...TASK.contract, verify: { gates: null } },
      } as unknown as TaskView;
      render(<VerificationPane state={LOADED({ task })} />);

      expect(screen.getByTestId('verification-contract')).toHaveTextContent('all declared gates');
    });

    it('reports an unset autoYes.mode as unset rather than as off', () => {
      const task = {
        ...TASK,
        contract: { ...TASK.contract, autoYes: { mode: null, allowPromptTypes: [], denyPatterns: [] } },
      } as unknown as TaskView;
      render(<VerificationPane state={LOADED({ task })} />);

      expect(screen.getByTestId('verification-contract')).toHaveTextContent(
        'unset (keeps the existing behavior)'
      );
    });
  });

  describe('run list', () => {
    it('lists every run with its RESULT verdict, id and trigger', () => {
      render(<VerificationPane state={LOADED()} />);

      const list = screen.getByTestId('verification-runs');
      expect(within(list).getAllByRole('button')).toHaveLength(2);
      expect(screen.getByTestId('verification-run-9')).toHaveTextContent('failed');
      expect(screen.getByTestId('verification-run-9')).toHaveTextContent('trigger=api');
      expect(screen.getByTestId('verification-run-8')).toHaveTextContent('passed');
    });

    it('marks the selected run and delegates selection to the owner', () => {
      const selectRun = vi.fn();
      render(<VerificationPane state={LOADED({ selectRun })} />);

      expect(screen.getByTestId('verification-run-9')).toHaveAttribute('aria-current', 'true');
      fireEvent.click(screen.getByTestId('verification-run-8'));
      expect(selectRun).toHaveBeenCalledWith(8);
    });
  });

  describe('gate table', () => {
    it('shows one row per gate with the GATE vocabulary, exit code and duration', () => {
      render(<VerificationPane state={LOADED()} />);

      const lint = screen.getByTestId('verification-gate-lint');
      expect(lint).toHaveTextContent('PASS');
      expect(lint).toHaveTextContent('exit=0');
      expect(lint).toHaveTextContent('duration=12s');

      const unit = screen.getByTestId('verification-gate-unit');
      expect(unit).toHaveTextContent('FAIL');
      expect(unit).toHaveTextContent('exit=1');
    });

    it('opens a failing gate on its log and leaves a passing one collapsed', () => {
      render(<VerificationPane state={LOADED()} />);

      expect(screen.getByTestId('verification-gate-log-unit')).toHaveTextContent(
        'FAIL tests/unit/foo.test.ts'
      );
      expect(screen.queryByTestId('verification-gate-log-lint')).toBeNull();

      fireEvent.click(screen.getByTestId('verification-gate-log-toggle-lint'));
      expect(screen.getByTestId('verification-gate-log-lint')).toHaveTextContent(
        'No log output recorded.'
      );
    });

    it('keeps only the last 40 log lines and says how many were dropped', () => {
      const logTail = Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join('\n');
      const gates = [{ ...GATES[1], logTail }];
      render(
        <VerificationPane
          state={LOADED({ selectedRun: { ...RUN_DETAIL, gates } })}
        />
      );

      const log = screen.getByTestId('verification-gate-log-unit');
      expect(log).toHaveTextContent('line-45');
      expect(log).toHaveTextContent('line-6');
      // 45 lines, last 40 kept → 1..5 dropped. `line-5` is not a substring of
      // any surviving line, so this is a real absence assertion.
      expect(log).not.toHaveTextContent('line-5');
      expect(log).toHaveTextContent('+5 more lines');
      expect(log).toHaveTextContent('commandmate verify show 9');
    });

    it('reports a run that vanished instead of an empty table', () => {
      render(<VerificationPane state={LOADED({ selectedRun: null, detailError: 'not-found' })} />);

      expect(screen.getByTestId('verification-gates-error')).toHaveTextContent(
        'That verification run is no longer available.'
      );
    });
  });

  describe('re-verify', () => {
    it('starts a run through the owner and disables itself while pending', () => {
      const rerun = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(<VerificationPane state={LOADED({ rerun })} />);

      fireEvent.click(screen.getByTestId('verification-rerun-button'));
      expect(rerun).toHaveBeenCalledTimes(1);

      rerender(<VerificationPane state={LOADED({ rerun, rerunPending: true })} />);
      const button = screen.getByTestId('verification-rerun-button');
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('Starting…');
    });

    it('names the run already in flight when the server answers 409', () => {
      render(
        <VerificationPane
          state={LOADED({
            rerunFailure: { kind: 'conflict', message: 'busy', runningRunId: 7 },
          })}
        />
      );

      expect(screen.getByTestId('verification-rerun-failure')).toHaveTextContent(
        'A verification run is already in progress (run 7).'
      );
    });

    it('shows the server message for any other failure', () => {
      render(
        <VerificationPane
          state={LOADED({
            rerunFailure: { kind: 'error', message: 'Failed to start verification', runningRunId: null },
          })}
        />
      );

      expect(screen.getByTestId('verification-rerun-failure')).toHaveTextContent(
        'Could not start verification: Failed to start verification'
      );
    });
  });

  it('surfaces a load failure without hiding the rest of the pane', () => {
    render(<VerificationPane state={LOADED({ error: 'boom' })} />);

    expect(screen.getByTestId('verification-error')).toHaveTextContent(
      'Could not load verification data: boom'
    );
    expect(screen.getByTestId('verification-contract')).toBeInTheDocument();
  });

  it('refreshes on demand', () => {
    const refresh = vi.fn();
    render(<VerificationPane state={LOADED({ refresh })} />);

    fireEvent.click(screen.getByTestId('verification-refresh-button'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
