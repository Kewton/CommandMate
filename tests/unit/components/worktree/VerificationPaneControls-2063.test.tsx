/**
 * VerificationPane controls (Issue #2063)
 * @vitest-environment jsdom
 *
 * The pane was read-only in every sense that mattered: it could start the whole
 * suite and nothing else. These tests pin the four things it can now do —
 * choose gates, stop a run, page through history, and show a gate's whole log —
 * at the level a user reaches them, and through the real dictionary, so a
 * missing `verification.*` key fails here rather than rendering its own name.
 *
 * The pane stays fully controlled: every assertion below is "the button called
 * the callback the hook owns", never "the pane went and fetched something".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { VerificationPane } from '@/components/worktree/VerificationPane';
import {
  resolveVerificationPhase,
  type WorktreeVerificationState,
} from '@/hooks/useWorktreeVerification';
import type {
  VerificationGateResultView,
  VerificationRunListItem,
  VerificationRunSummaryView,
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
    { id: 'lint', command: 'npm run lint', timeoutSec: 900, mutex: null, retryOnFail: null, flakyIsPass: null },
    { id: 'unit', command: 'npm run test:unit', timeoutSec: 1800, mutex: null, retryOnFail: null, flakyIsPass: null },
  ],
  options: null,
  plannedGateIds: ['work-evidence', 'scope', 'lint', 'unit'],
  error: null,
};

const RUN_9: VerificationRunListItem = {
  id: 9,
  worktreeId: 'wt-1',
  instanceId: null,
  taskId: null,
  trigger: 'api',
  status: 'failed',
  baseRef: 'origin/develop',
  startedAt: '2026-08-31T00:01:00.000Z',
  finishedAt: '2026-08-31T00:02:00.000Z',
};

const RUNNING_RUN: VerificationRunListItem = {
  ...RUN_9,
  id: 11,
  status: 'running',
  finishedAt: null,
};

/** A log long enough that the row's 40-line excerpt cannot be the whole thing. */
const LONG_LOG = Array.from({ length: 120 }, (_, i) => `line-${i + 1}`).join('\n');

/** What a real gate log looks like: vitest and eslint both emit SGR colour. */
const ANSI_LOG = '\u001b[31mFAIL\u001b[0m tests/unit/foo.test.ts\n\u001b[2m1 failed\u001b[22m';
const ANSI_LOG_STRIPPED = 'FAIL tests/unit/foo.test.ts\n1 failed';

const GATES: VerificationGateResultView[] = [
  {
    id: 2,
    runId: 9,
    gateId: 'unit',
    command: 'npm run test:unit',
    status: 'failed',
    exitCode: 1,
    durationMs: 45_000,
    logTail: LONG_LOG,
    startedAt: RUN_9.startedAt,
    finishedAt: RUN_9.finishedAt,
    source: 'verify.yaml',
  } as VerificationGateResultView,
];

const RUN_DETAIL: VerificationRunView = { ...RUN_9, gates: GATES };

const HISTORY: VerificationRunSummaryView[] = [
  {
    id: 55,
    worktreeId: 'wt-another-branch',
    instanceId: null,
    taskId: null,
    trigger: 'wait',
    status: 'failed',
    baseRef: 'origin/develop',
    startedAt: '2026-08-30T09:00:00.000Z',
    finishedAt: '2026-08-30T09:10:00.000Z',
    gates: [
      { gateId: 'unit', status: 'failed', exitCode: 1, durationMs: 1000, source: 'verify.yaml' },
      { gateId: 'lint', status: 'passed', exitCode: 0, durationMs: 100, source: 'verify.yaml' },
    ],
  },
];

function buildState(overrides: Partial<WorktreeVerificationState> = {}): WorktreeVerificationState {
  const base: WorktreeVerificationState = {
    worktreeId: 'wt-1',
    task: null,
    runs: [RUN_9],
    latestRun: RUN_9,
    selectedRunId: 9,
    selectedRun: RUN_DETAIL,
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
    availableGateIds: CONFIG.plannedGateIds,
    selectedGateIds: null,
    failedGateIds: ['unit'],
    toggleGate: vi.fn(),
    setGateSelection: vi.fn(),
    selectFailedGates: vi.fn(),
    runningRun: null,
    cancelPending: false,
    cancelSettling: false,
    cancelFailure: null,
    historyLimit: 10,
    canLoadMore: false,
    repositoryHistoryOpen: false,
    repositoryHistory: [],
    repositoryHistoryLoading: false,
    repositoryHistoryError: null,
    selectRun: vi.fn(),
    refresh: vi.fn(),
    rerun: vi.fn().mockResolvedValue(undefined),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn(),
    toggleRepositoryHistory: vi.fn(),
    draftConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { ...base, phase: overrides.phase ?? resolveVerificationPhase(base.config, base.runs) };
}

describe('gate selection (Issue #2063)', () => {
  it('says "all gates" for the default selection rather than showing every box ticked', () => {
    render(<VerificationPane state={buildState()} />);

    expect(screen.getByTestId('verification-gate-selector-summary')).toHaveTextContent(
      'All 4 gates will run'
    );
    // `data-selection` is the pane's own answer to "what would this run", so a
    // reader of the DOM never has to infer it from which boxes are ticked.
    expect(screen.getByTestId('verification-gate-selector')).toHaveAttribute(
      'data-selection',
      'all'
    );
  });

  it('lists one checkbox per planned gate once opened, built-ins included', () => {
    render(<VerificationPane state={buildState()} />);
    fireEvent.click(screen.getByTestId('verification-gate-selector-toggle'));

    for (const gateId of ['work-evidence', 'scope', 'lint', 'unit']) {
      expect(screen.getByTestId(`verification-gate-select-${gateId}`)).toBeInTheDocument();
    }
  });

  it('reports a toggle to the hook rather than deciding the selection itself', () => {
    const toggleGate = vi.fn();
    render(<VerificationPane state={buildState({ toggleGate })} />);
    fireEvent.click(screen.getByTestId('verification-gate-selector-toggle'));
    fireEvent.click(screen.getByTestId('verification-gate-select-unit'));

    expect(toggleGate).toHaveBeenCalledWith('unit');
  });

  it('names the selected gates when the selection is a subset', () => {
    render(<VerificationPane state={buildState({ selectedGateIds: ['lint'] })} />);

    const summary = screen.getByTestId('verification-gate-selector-summary');
    expect(summary).toHaveTextContent('1 of 4 selected');
    expect(summary).toHaveTextContent('lint');
    expect(screen.getByTestId('verification-gate-selector')).toHaveAttribute(
      'data-selection',
      'lint'
    );
  });

  it('offers the failed-gates shortcut, counting only the run’s failures', () => {
    const selectFailedGates = vi.fn();
    render(<VerificationPane state={buildState({ selectFailedGates })} />);

    const button = screen.getByTestId('verification-failed-only-button');
    expect(button).toHaveTextContent('Only the gates that failed (1)');
    fireEvent.click(button);
    expect(selectFailedGates).toHaveBeenCalledTimes(1);
    // Pressing it opens the list: a change to what the run button will do must
    // be visible, not implied.
    expect(screen.getByTestId('verification-gate-selector-body')).toBeInTheDocument();
  });

  it('disables the shortcut and says why when nothing failed', () => {
    render(<VerificationPane state={buildState({ failedGateIds: [] })} />);

    expect(screen.getByTestId('verification-failed-only-button')).toBeDisabled();
    expect(screen.getByTestId('verification-failed-only-empty')).toHaveTextContent(
      'no failing gate to re-run'
    );
  });

  it('offers "back to all gates" only while a subset is selected', () => {
    const setGateSelection = vi.fn();
    const { rerender } = render(<VerificationPane state={buildState()} />);
    expect(screen.queryByTestId('verification-select-all-button')).toBeNull();

    rerender(
      <VerificationPane state={buildState({ selectedGateIds: ['lint'], setGateSelection })} />
    );
    fireEvent.click(screen.getByTestId('verification-select-all-button'));
    // `null`, not the full list: the absence is what restores the default run.
    expect(setGateSelection).toHaveBeenCalledWith(null);
  });

  it('runs the selection through the hook, passing no gate ids of its own', () => {
    const rerun = vi.fn().mockResolvedValue(undefined);
    render(<VerificationPane state={buildState({ selectedGateIds: ['unit'], rerun })} />);
    fireEvent.click(screen.getByTestId('verification-gate-selector-toggle'));
    fireEvent.click(screen.getByTestId('verification-run-selected-button'));

    expect(rerun).toHaveBeenCalledWith();
  });

  it('renders nothing when the config read has not told it what runs yet', () => {
    render(<VerificationPane state={buildState({ config: null, availableGateIds: [] })} />);
    expect(screen.queryByTestId('verification-gate-selector')).toBeNull();
  });
});

describe('cancelling a run (Issue #2063)', () => {
  const RUNNING_STATE = (overrides: Partial<WorktreeVerificationState> = {}) =>
    buildState({
      runs: [RUNNING_RUN],
      latestRun: RUNNING_RUN,
      runningRun: RUNNING_RUN,
      selectedRunId: 11,
      selectedRun: { ...RUNNING_RUN, gates: [] },
      ...overrides,
    });

  it('offers Stop beside Refresh while a run is in flight', () => {
    render(<VerificationPane state={RUNNING_STATE()} />);

    const block = screen.getByTestId('verification-onboarding-running');
    expect(within(block).getByTestId('verification-running-refresh-button')).toBeInTheDocument();
    expect(within(block).getByTestId('verification-cancel-button')).toHaveTextContent(
      'Stop verification'
    );
  });

  // Wording only. That the gate's process group actually dies is proven in
  // tests/integration/verification-cancel-2063.test.ts, against real pids; a
  // component test can only check that the pane says so.
  it('spells out what stopping does, in the words the runner implements', () => {
    render(<VerificationPane state={RUNNING_STATE()} />);
    expect(screen.getByTestId('verification-cancel-hint')).toHaveTextContent(
      'process group to terminate'
    );
  });

  it('calls the hook and never touches the run list itself', () => {
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    render(<VerificationPane state={RUNNING_STATE({ cancelRun })} />);
    fireEvent.click(screen.getByTestId('verification-cancel-button'));

    expect(cancelRun).toHaveBeenCalledTimes(1);
  });

  it('says the signal is out while a stubborn gate is still exiting', () => {
    // The route answers 202 for this, and until something reported it the
    // five-second SIGTERM -> SIGKILL window looked like a button that did
    // nothing.
    render(<VerificationPane state={RUNNING_STATE({ cancelSettling: true })} />);

    expect(screen.getByTestId('verification-cancel-settling')).toHaveTextContent(
      'Stop requested'
    );
  });

  it('says nothing about settling before a cancel has been accepted', () => {
    render(<VerificationPane state={RUNNING_STATE()} />);
    expect(screen.queryByTestId('verification-cancel-settling')).toBeNull();
  });

  it('disables the button while the cancel is in flight', () => {
    render(<VerificationPane state={RUNNING_STATE({ cancelPending: true })} />);
    const button = screen.getByTestId('verification-cancel-button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Stopping…');
  });

  it('shows no Stop button when nothing is running', () => {
    render(<VerificationPane state={buildState()} />);
    expect(screen.queryByTestId('verification-cancel-button')).toBeNull();
  });

  it('phrases a 409 as "it had already finished" in the runs section', () => {
    // The running block is gone by then — the refresh the cancel forced has
    // landed — so the message has to survive somewhere the operator is looking.
    render(
      <VerificationPane
        state={buildState({ cancelFailure: { kind: 'gone', message: 'already finished' } })}
      />
    );

    expect(screen.getByTestId('verification-runs-cancel-failure')).toHaveTextContent(
      'That run had already finished'
    );
  });
});

describe('a narrowed run is visibly narrowed (Issue #2063)', () => {
  it('says how much of the plan ran, and which gates did not', () => {
    // `verification_runs` stores no gate selection, so without this line a run
    // of one gate renders the identical green badge and `exit=0` as a run of
    // twelve. Derived from the config's plan, which is the only place the
    // difference is visible at all.
    const partial: VerificationRunView = {
      ...RUN_9,
      status: 'passed',
      gates: [{ ...GATES[0], gateId: 'unit', status: 'passed', exitCode: 0 }],
    };
    render(<VerificationPane state={buildState({ selectedRun: partial })} />);

    const note = screen.getByTestId('verification-run-partial');
    expect(note).toHaveTextContent('1 of the 4 planned gates ran');
    expect(note).toHaveTextContent('Not run: work-evidence, scope, lint');
    expect(note).toHaveTextContent('covers only the gates that ran');
  });

  it('says nothing when every planned gate has a row', () => {
    const full: VerificationRunView = {
      ...RUN_9,
      gates: ['work-evidence', 'scope', 'lint', 'unit'].map((gateId, index) => ({
        ...GATES[0],
        id: index + 1,
        gateId,
        status: 'passed',
        exitCode: 0,
      })),
    };
    render(<VerificationPane state={buildState({ selectedRun: full })} />);

    expect(screen.queryByTestId('verification-run-partial')).toBeNull();
  });

  it('claims nothing when the plan itself is unknown', () => {
    // An unreadable verify.yaml answers with an empty plan. "0 of 0 gates ran"
    // would be a statement about the reader's ignorance, not about the run.
    render(
      <VerificationPane
        state={buildState({
          config: { ...CONFIG, plannedGateIds: [] },
          availableGateIds: [],
        })}
      />
    );

    expect(screen.queryByTestId('verification-run-partial')).toBeNull();
  });
});

describe('history (Issue #2063)', () => {
  it('offers "load more" only when the hook says there may be more', () => {
    const loadMore = vi.fn();
    const { rerender } = render(<VerificationPane state={buildState()} />);
    expect(screen.queryByTestId('verification-load-more-button')).toBeNull();

    rerender(<VerificationPane state={buildState({ canLoadMore: true, loadMore })} />);
    fireEvent.click(screen.getByTestId('verification-load-more-button'));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('keeps the cross-branch history collapsed behind a toggle', () => {
    const toggleRepositoryHistory = vi.fn();
    render(<VerificationPane state={buildState({ toggleRepositoryHistory })} />);

    expect(screen.queryByTestId('verification-repository-history-body')).toBeNull();
    fireEvent.click(screen.getByTestId('verification-repository-history-toggle'));
    expect(toggleRepositoryHistory).toHaveBeenCalledTimes(1);
  });

  it('names the branch and the failing gates of every cross-branch run', () => {
    render(
      <VerificationPane
        state={buildState({ repositoryHistoryOpen: true, repositoryHistory: HISTORY })}
      />
    );

    const row = screen.getByTestId('verification-history-run-55');
    expect(row).toHaveTextContent('wt-another-branch');
    expect(row).toHaveTextContent('Failed');
    // The comparison the block exists for: which gate, on which branch.
    expect(row).toHaveTextContent('Failing gates: unit');
    expect(row).not.toHaveTextContent('lint');
  });

  it('reports a failed history read instead of showing an empty list', () => {
    render(
      <VerificationPane
        state={buildState({ repositoryHistoryOpen: true, repositoryHistoryError: 'boom' })}
      />
    );

    expect(screen.getByTestId('verification-repository-history-error')).toHaveTextContent('boom');
    expect(screen.queryByTestId('verification-repository-history-empty')).toBeNull();
  });
});

describe('full gate log (Issue #2063)', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('shows every stored line, not the 40-line excerpt the row shows', () => {
    render(<VerificationPane state={buildState()} />);

    // The row keeps the last 40 of 120 lines, so it opens at line-81 and the 80
    // before it are simply not there. Asserted on the <pre>'s raw text, not with
    // toHaveTextContent: that matcher collapses newlines and substring-matches,
    // so `line-1` would "match" line-100 and the check would prove nothing.
    const excerpt = screen.getByTestId('verification-gate-log-unit').querySelector('pre');
    expect(excerpt?.textContent?.split('\n')).toHaveLength(40);
    expect(excerpt?.textContent?.split('\n')[0]).toBe('line-81');
    expect(excerpt?.textContent).not.toContain('line-80');

    fireEvent.click(screen.getByTestId('verification-gate-full-log-button-unit'));

    // The modal is the whole stored log, byte for byte.
    const modal = screen.getByTestId('verification-gate-full-log-unit');
    expect(modal.querySelector('pre')?.textContent).toBe(LONG_LOG);
    expect(screen.getByTestId('verification-gate-log-size')).toHaveTextContent('120 lines');
  });

  it('says the stored tail is all there is, rather than implying a fuller log', () => {
    render(<VerificationPane state={buildState()} />);
    fireEvent.click(screen.getByTestId('verification-gate-full-log-button-unit'));

    expect(screen.getByTestId('verification-gate-full-log-unit')).toHaveTextContent(
      'maxLogTailBytes'
    );
  });

  it('copies the whole log, not the excerpt', async () => {
    render(<VerificationPane state={buildState()} />);
    fireEvent.click(screen.getByTestId('verification-gate-full-log-button-unit'));
    fireEvent.click(screen.getByTestId('verification-gate-log-copy-button'));

    await vi.waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(LONG_LOG)
    );
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('shows and copies the same bytes, with the ANSI colour codes gone', () => {
    // `copyToClipboard` strips ANSI before it writes. The <pre> did not, so the
    // reader saw `[31mFAIL[0m` and pasted `FAIL` — a difference nobody notices
    // until it lands in an Issue. Real gate logs are full of these; the fixture
    // above was not, which is why no test could see it.
    const gate = { ...GATES[0], logTail: ANSI_LOG } as VerificationGateResultView;
    render(
      <VerificationPane state={buildState({ selectedRun: { ...RUN_DETAIL, gates: [gate] } })} />
    );

    const excerpt = screen.getByTestId('verification-gate-log-unit').querySelector('pre');
    expect(excerpt?.textContent).toBe(ANSI_LOG_STRIPPED);
    expect(excerpt?.textContent).not.toContain('\u001b');

    fireEvent.click(screen.getByTestId('verification-gate-full-log-button-unit'));
    const shown = screen
      .getByTestId('verification-gate-full-log-unit')
      .querySelector('pre')?.textContent;
    expect(shown).toBe(ANSI_LOG_STRIPPED);

    fireEvent.click(screen.getByTestId('verification-gate-log-copy-button'));
    return vi
      .waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled())
      .then(() => {
        // The bytes handed to the clipboard are the bytes on screen.
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(shown);
      });
  });

  it('will not offer to copy a log that is nothing but whitespace', () => {
    // `copyToClipboard` returns silently for whitespace-only input, so an
    // enabled button would answer "Copied" having written nothing at all.
    const gate = { ...GATES[0], logTail: '   \n\n  ' } as VerificationGateResultView;
    render(
      <VerificationPane state={buildState({ selectedRun: { ...RUN_DETAIL, gates: [gate] } })} />
    );

    fireEvent.click(screen.getByTestId('verification-gate-full-log-button-unit'));
    expect(screen.getByTestId('verification-gate-log-copy-button')).toBeDisabled();
  });

  it('offers no full-log button for a gate that recorded no output', () => {
    const gate = { ...GATES[0], logTail: null } as VerificationGateResultView;
    render(
      <VerificationPane
        state={buildState({ selectedRun: { ...RUN_DETAIL, gates: [gate] } })}
      />
    );

    expect(screen.queryByTestId('verification-gate-full-log-button-unit')).toBeNull();
  });
});
