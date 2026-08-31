/**
 * Tests for the Verification pane's onboarding block (Issue #2061)
 * @vitest-environment jsdom
 *
 * The Issue's acceptance criterion is that four states — no config / declared
 * but never run / running / results — render *different wording and different
 * CTAs*. So the snapshot here is not the DOM: it is exactly that claim, reduced
 * to what a reader would compare (the phase the pane declares, the prose, and
 * the label on every button and link). A full-markup snapshot would go red on
 * a class name and stay green when two states drift into the same sentence,
 * which is the failure this is protecting against.
 *
 * The wording resolves through the real `en` dictionary, so a key that exists
 * in the component and not in `locales/` fails here rather than rendering as
 * the raw key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { VerificationPane } from '@/components/worktree/VerificationPane';
import {
  resolveVerificationPhase,
  type WorktreeVerificationState,
} from '@/hooks/useWorktreeVerification';
import type {
  VerificationRunListItem,
  VerificationRunView,
  VerifyConfigResponse,
} from '@/lib/api/verification-api';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const CONFIG_ABSENT: VerifyConfigResponse = {
  exists: false,
  path: '.commandmate/verify.yaml',
  gates: [],
  options: null,
  plannedGateIds: [],
  error: null,
};

const CONFIG_PRESENT: VerifyConfigResponse = {
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
    {
      id: 'unit',
      command: 'npm run test:unit',
      timeoutSec: 1800,
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
  plannedGateIds: ['work-evidence', 'scope', 'lint', 'unit'],
  error: null,
};

const RUN_RUNNING: VerificationRunListItem = {
  id: 12,
  worktreeId: 'wt-1',
  instanceId: null,
  taskId: null,
  trigger: 'api',
  status: 'running',
  baseRef: 'origin/develop',
  startedAt: '2026-08-31T00:00:00.000Z',
  finishedAt: null,
};

const RUN_FAILED: VerificationRunListItem = {
  ...RUN_RUNNING,
  id: 11,
  status: 'failed',
  finishedAt: '2026-08-31T00:03:00.000Z',
};

const RUNNING_DETAIL: VerificationRunView = {
  ...RUN_RUNNING,
  gates: [
    {
      id: 1,
      runId: 12,
      gateId: 'work-evidence',
      command: 'work-evidence',
      status: 'passed',
      exitCode: 0,
      durationMs: 30,
      logTail: null,
      startedAt: '2026-08-31T00:00:00.000Z',
      finishedAt: '2026-08-31T00:00:00.030Z',
      source: 'builtin',
    },
    {
      id: 2,
      runId: 12,
      gateId: 'lint',
      command: 'npm run lint',
      status: 'running',
      exitCode: null,
      durationMs: null,
      logTail: null,
      startedAt: '2026-08-31T00:00:01.000Z',
      finishedAt: null,
      source: 'verify.yaml',
    },
  ],
};

function buildState(overrides: Partial<WorktreeVerificationState> = {}): WorktreeVerificationState {
  const base: WorktreeVerificationState = {
    worktreeId: 'commandmate-feature-2061',
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
    phase: 'configured',
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
    ...overrides,
  };
  // Derived, never chosen by the fixture: a state that claimed `no-config`
  // while carrying a config would pin a rendering the product cannot reach.
  return { ...base, phase: resolveVerificationPhase(base.config, base.runs) };
}

const STATES: Record<string, () => WorktreeVerificationState> = {
  'no-config': () => buildState({ config: CONFIG_ABSENT }),
  configured: () => buildState({ config: CONFIG_PRESENT }),
  running: () =>
    buildState({
      config: CONFIG_PRESENT,
      runs: [RUN_RUNNING],
      latestRun: RUN_RUNNING,
      selectedRunId: 12,
      selectedRun: RUNNING_DETAIL,
    }),
  result: () =>
    buildState({
      config: CONFIG_PRESENT,
      runs: [RUN_FAILED],
      latestRun: RUN_FAILED,
      selectedRunId: 11,
      selectedRun: { ...RUN_FAILED, gates: [] },
    }),
};

/** What a reader compares between two states: the prose and the offers. */
function readOnboarding(): { phase: string | null; text: string; ctas: string[] } {
  const block = screen.getByTestId('verification-onboarding');
  const ctas = [
    ...within(block).queryAllByRole('button'),
    ...within(block).queryAllByRole('link'),
  ].map((element) => element.textContent?.trim() ?? '');
  return {
    phase: block.getAttribute('data-phase'),
    text: (block.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ctas,
  };
}

describe('VerificationPane onboarding (Issue #2061)', () => {
  beforeEach(() => {
    // The running state prints elapsed wall-clock, which is otherwise a
    // different string every run and could never be snapshotted.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T00:02:07.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the four states render different wording and different CTAs', () => {
    for (const [name, build] of Object.entries(STATES)) {
      it(`${name} is fixed by snapshot`, () => {
        render(<VerificationPane state={build()} />);
        expect(readOnboarding()).toMatchSnapshot();
      });
    }

    it('no two states share their prose or their CTAs', () => {
      const seen: { name: string; text: string; ctas: string }[] = [];
      for (const [name, build] of Object.entries(STATES)) {
        const { unmount } = render(<VerificationPane state={build()} />);
        const read = readOnboarding();
        expect(read.phase).toBe(name);
        seen.push({ name, text: read.text, ctas: read.ctas.join('|') });
        unmount();
      }
      expect(new Set(seen.map((entry) => entry.text)).size).toBe(seen.length);
      expect(new Set(seen.map((entry) => entry.ctas)).size).toBe(seen.length);
    });
  });

  describe('no config yet', () => {
    it('offers the CI drafter and a link to the spec', () => {
      const state = STATES['no-config']();
      render(<VerificationPane state={state} />);

      expect(screen.getByTestId('verification-onboarding-no-config')).toHaveTextContent(
        'has not declared any verification gates yet'
      );
      fireEvent.click(screen.getByTestId('verification-draft-button'));
      expect(state.draftConfig).toHaveBeenCalledTimes(1);

      const link = screen.getByTestId('verification-docs-link');
      expect(link).toHaveAttribute(
        'href',
        'https://github.com/Kewton/CommandMate/blob/main/docs/design/verification-config.md'
      );
      // Opened in a new tab, so the operator does not lose the pane they are
      // reading the link from.
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    });

    it('names `commandmate verify init` so the CLI half is reachable', () => {
      render(<VerificationPane state={STATES['no-config']()} />);
      expect(screen.getByTestId('verification-onboarding-no-config')).toHaveTextContent(
        'commandmate verify init'
      );
    });

    it('reports a 409 as "it already exists", not as a failure', () => {
      render(
        <VerificationPane
          state={buildState({
            config: CONFIG_ABSENT,
            draftFailure: { kind: 'conflict', message: 'already exists' },
          })}
        />
      );
      expect(screen.getByTestId('verification-draft-failure')).toHaveTextContent(
        'Nothing was overwritten'
      );
    });

    it('reports "nothing draftable" separately from a real error', () => {
      render(
        <VerificationPane
          state={buildState({
            config: CONFIG_ABSENT,
            draftFailure: { kind: 'empty', message: 'no gates' },
          })}
        />
      );
      expect(screen.getByTestId('verification-draft-failure')).toHaveTextContent('by hand');
    });

    it('does not offer the drafter once a config exists', () => {
      render(<VerificationPane state={STATES.configured()} />);
      // Anchored on what this state DOES offer, not only on what it withholds:
      // an absence assertion alone would also pass if the whole block stopped
      // rendering, which is the opposite of what it is meant to prove.
      expect(screen.getByTestId('verification-run-button')).toBeInTheDocument();
      expect(screen.queryByTestId('verification-draft-button')).toBeNull();
    });
  });

  describe('declared but never run', () => {
    it('lists the declared gates with their commands', () => {
      render(<VerificationPane state={STATES.configured()} />);

      const gates = screen.getByTestId('verification-declared-gates');
      expect(within(gates).getByTestId('verification-declared-gate-lint')).toHaveTextContent(
        'npm run lint'
      );
      expect(within(gates).getByTestId('verification-declared-gate-unit')).toHaveTextContent(
        'npm run test:unit'
      );
    });

    it('names the built-in gates that run alongside them', () => {
      render(<VerificationPane state={STATES.configured()} />);
      // Subtracted from the server's plannedGateIds, so the pane holds no copy
      // of the runner's built-in list.
      expect(screen.getByTestId('verification-builtin-gates')).toHaveTextContent(
        'work-evidence, scope'
      );
    });

    it('starts a run from its own CTA', () => {
      const state = STATES.configured();
      render(<VerificationPane state={state} />);
      fireEvent.click(screen.getByTestId('verification-run-button'));
      expect(state.rerun).toHaveBeenCalledTimes(1);
    });
  });

  describe('running', () => {
    it('counts finished gates against the gates a full run executes', () => {
      render(<VerificationPane state={STATES.running()} />);
      // One of the run's two recorded gates has finished; the denominator comes
      // from the config (4 planned), not from the rows recorded so far.
      expect(screen.getByTestId('verification-running-progress')).toHaveTextContent(
        '1 of 4 gates have finished'
      );
    });

    it('shows elapsed wall-clock for the run in flight', () => {
      render(<VerificationPane state={STATES.running()} />);
      expect(screen.getByTestId('verification-running-elapsed')).toHaveTextContent('2m 07s');
    });
  });

  describe('results', () => {
    it('reports the latest verdict with the CLI keyword and a translated verdict', () => {
      // Issue #2062 turned the verdict from the raw `failed` token into a word;
      // `RESULT` stays, because that is the keyword the CLI prints and the one
      // a reader is comparing against.
      render(<VerificationPane state={STATES.result()} />);
      expect(screen.getByTestId('verification-result-body')).toHaveTextContent(
        'The last run on this branch, #11, is RESULT Failed.'
      );
    });

    it('jumps back to the latest run', () => {
      const state = STATES.result();
      render(<VerificationPane state={state} />);
      fireEvent.click(screen.getByTestId('verification-show-latest-button'));
      expect(state.selectRun).toHaveBeenCalledWith(11);
    });
  });

  describe('the config read itself', () => {
    it('says it is still reading rather than claiming no gates exist', () => {
      render(<VerificationPane state={buildState({ config: null })} />);

      // The rendered sentence, not just the phase attribute: `data-phase` lives
      // on the outer <section> and is set whatever the block below draws, so it
      // stays correct even if the `unknown` branch renders nothing at all —
      // which is the one outcome this state must not have. The pane has to SAY
      // it is still reading; silence reads as "there is nothing here".
      const reading = screen.getByTestId('verification-onboarding-unknown');
      expect(reading).toHaveTextContent('Reading the declared gates');

      expect(screen.getByTestId('verification-onboarding')).toHaveAttribute('data-phase', 'unknown');
      expect(screen.queryByTestId('verification-onboarding-no-config')).toBeNull();
    });

    it('separates "the file is broken" from "there is no file"', () => {
      render(
        <VerificationPane
          state={buildState({
            config: {
              ...CONFIG_PRESENT,
              gates: [],
              plannedGateIds: [],
              error: 'gates: required, at least one gate must be defined',
            },
          })}
        />
      );
      expect(screen.getByTestId('verification-config-invalid')).toHaveTextContent(
        'exists but could not be read'
      );
      expect(screen.queryByTestId('verification-onboarding-no-config')).toBeNull();
    });

    it('surfaces a failed config request without hiding the rest of the pane', () => {
      render(<VerificationPane state={buildState({ config: null, configError: 'boom' })} />);
      expect(screen.getByTestId('verification-config-error')).toHaveTextContent('boom');
      expect(screen.getByTestId('verification-contract-section')).toBeInTheDocument();
    });
  });

  describe('the empty-run CTA (Issue #2061 item 4)', () => {
    it('interpolates the worktree id instead of printing a placeholder', () => {
      render(<VerificationPane state={STATES.configured()} />);
      const empty = screen.getByTestId('verification-runs-empty');
      expect(empty).toHaveTextContent('commandmate verify commandmate-feature-2061');
      expect(empty.textContent).not.toContain('<worktree-id>');
    });
  });
});
