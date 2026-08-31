/**
 * Tests for VerificationStatusChip (Issue #1816 / Issue #2064)
 * @vitest-environment jsdom
 *
 * The chip's whole job is discoverability: it has to be visible wherever
 * Verification is reachable — Issue #2064 included the branches nobody has sent
 * a contract to, which is where the feature was previously invisible — and it
 * has to carry the *reason* for the verdict (the failing gate ids) somewhere an
 * operator can actually reach without opening anything
 * (`docs/design/discoverability-principle.md`, 実装規約 1).
 *
 * "Reachable" here explicitly includes a touch device: #2064 stopped `title=`
 * being the only pointer-side channel for the reason.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VerificationStatusChip } from '@/components/worktree/VerificationStatusChip';
import type {
  TaskView,
  VerificationGateResultView,
  VerificationRunListItem,
} from '@/lib/api/verification-api';

// The rendered wording is the thing under test, so it has to go through the
// real dictionary — the global mock in tests/setup.ts would keep these
// assertions green with the keys missing.
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
  goal: 'goal',
  contractPath: '.commandmate/tasks/issue-1816.yaml',
  contract: {
    version: 1,
    title: 'Issue #1816',
    goal: 'goal',
    scope: { allow: ['src/**'], deny: [] },
    verify: { gates: null },
    autoYes: { mode: 'safe', allowPromptTypes: [], denyPatterns: [] },
    success: { requireWorkEvidence: true, requireScopeClean: true },
  },
  status: 'verifying',
  lastVerificationRunId: 9,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
} as unknown as TaskView;

const RUN: VerificationRunListItem = {
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

function gate(
  gateId: string,
  status: VerificationGateResultView['status']
): VerificationGateResultView {
  return {
    id: gateId.length,
    runId: 9,
    gateId,
    command: `npm run ${gateId}`,
    status,
    exitCode: status === 'passed' ? 0 : 1,
    durationMs: 1200,
    logTail: null,
    startedAt: '2026-08-18T00:01:00.000Z',
    finishedAt: '2026-08-18T00:02:00.000Z',
    source: 'verify.yaml',
    timingsMeasured: true,
  };
}

describe('VerificationStatusChip (Issue #1816)', () => {
  it('shows the task title, the task status, and the run verdict', () => {
    render(<VerificationStatusChip task={TASK} latestRun={RUN} onOpen={() => {}} />);

    expect(screen.getByTestId('verification-chip-title')).toHaveTextContent('Issue #1816');
    expect(screen.getByTestId('verification-chip-task-status')).toHaveTextContent('verifying');
    // §3.4 vocabulary, keyword included: two bare `failed` badges side by side
    // would read as one status repeated.
    expect(screen.getByTestId('verification-chip-run-status')).toHaveTextContent('RESULT Failed');
  });

  it('names the gates that did not pass in the accessible reason', () => {
    render(
      <VerificationStatusChip
        task={TASK}
        latestRun={RUN}
        latestRunGates={[gate('lint', 'passed'), gate('unit', 'failed'), gate('build', 'timeout')]}
        onOpen={() => {}}
      />
    );

    const chip = screen.getByTestId('verification-status-chip');
    const reason = chip.getAttribute('aria-label') ?? '';
    expect(reason).toContain('RESULT Failed');
    expect(reason).toContain('run 9');
    expect(reason).toContain('unit, build');
    // A passed gate is not a failure and must not be listed.
    expect(reason).not.toContain('lint');
    // The pointer affordance carries the same text as the a11y one, so a
    // hover-less device loses nothing (nothing here is hover-revealed).
    expect(chip).toHaveAttribute('title', reason);
  });

  it('says all gates passed when none failed', () => {
    render(
      <VerificationStatusChip
        task={TASK}
        latestRun={{ ...RUN, status: 'passed' }}
        latestRunGates={[gate('lint', 'passed'), gate('unit', 'passed')]}
        onOpen={() => {}}
      />
    );

    expect(screen.getByTestId('verification-status-chip').getAttribute('aria-label')).toContain(
      'All 2 gates passed'
    );
  });

  it('reports the absence of a run rather than an empty verdict', () => {
    render(<VerificationStatusChip task={TASK} latestRun={null} onOpen={() => {}} />);

    const chip = screen.getByTestId('verification-status-chip');
    expect(chip.getAttribute('aria-label')).toContain('No verification run yet');
    // Issue #2064: a bare em dash said nothing. "Not verified" is the verdict.
    expect(screen.getByTestId('verification-chip-run-status')).toHaveTextContent('Not verified');
  });

  it('opens the pane when clicked', () => {
    const onOpen = vi.fn();
    render(<VerificationStatusChip task={TASK} latestRun={RUN} onOpen={onOpen} />);

    fireEvent.click(screen.getByTestId('verification-status-chip'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // Issue #2064
  // ==========================================================================

  describe('branch with no execution contract (Issue #2064)', () => {
    it('renders a "Not verified" chip instead of hiding the entry point', () => {
      render(<VerificationStatusChip task={null} latestRun={null} onOpen={() => {}} />);

      const chip = screen.getByTestId('verification-status-chip');
      expect(chip).toBeInTheDocument();
      // The pane's own name, because there is no task title to show.
      expect(screen.getByTestId('verification-chip-title')).toHaveTextContent('Verification');
      expect(screen.getByTestId('verification-chip-run-status')).toHaveTextContent('Not verified');
      // Nothing to say about a task status that does not exist.
      expect(screen.queryByTestId('verification-chip-task-status')).not.toBeInTheDocument();
    });

    it('matches the rendered snapshot for the contract-less, run-less branch', () => {
      render(<VerificationStatusChip task={null} latestRun={null} onOpen={() => {}} />);

      const chip = screen.getByTestId('verification-status-chip');
      expect(chip.textContent).toMatchInlineSnapshot(`"VerificationNot verified"`);
      expect(chip.getAttribute('aria-label')).toMatchInlineSnapshot(`"No execution contract has been sent to this branch · No verification run yet · Open the Verification pane"`);
    });

    it('still opens the pane, so the chip is a working entry point', () => {
      const onOpen = vi.fn();
      render(<VerificationStatusChip task={null} latestRun={null} onOpen={onOpen} />);

      fireEvent.click(screen.getByTestId('verification-status-chip'));
      expect(onOpen).toHaveBeenCalledTimes(1);
    });
  });

  describe('reason on a touch device (Issue #2064)', () => {
    it('puts the reason in the document on tap, not only in title=', () => {
      render(
        <VerificationStatusChip
          task={TASK}
          latestRun={RUN}
          latestRunGates={[gate('unit', 'failed')]}
          onOpen={() => {}}
        />
      );

      expect(screen.queryByTestId('verification-chip-reason-popover')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));

      const popover = screen.getByTestId('verification-chip-reason-popover');
      // The same clauses the accessible name carries — one channel cannot drift
      // from the other, and neither one is hover-gated.
      expect(popover).toHaveTextContent('Gates that did not pass: unit');
      expect(popover).toHaveTextContent('RESULT Failed');
    });

    it('is a toggle, and the toggle names its own state', () => {
      render(<VerificationStatusChip task={TASK} latestRun={RUN} onOpen={() => {}} />);

      const toggle = screen.getByTestId('verification-chip-reason-toggle');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveAttribute('aria-label', 'Show why');

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(toggle).toHaveAttribute('aria-label', 'Hide why');

      fireEvent.click(toggle);
      expect(screen.queryByTestId('verification-chip-reason-popover')).not.toBeInTheDocument();
    });

    it('closes on Escape and on a press outside', () => {
      render(<VerificationStatusChip task={TASK} latestRun={RUN} onOpen={() => {}} />);
      const toggle = screen.getByTestId('verification-chip-reason-toggle');

      fireEvent.click(toggle);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('verification-chip-reason-popover')).not.toBeInTheDocument();

      fireEvent.click(toggle);
      fireEvent.mouseDown(document.body);
      expect(screen.queryByTestId('verification-chip-reason-popover')).not.toBeInTheDocument();
    });

    it('opening the pane closes the reason popover', () => {
      const onOpen = vi.fn();
      render(<VerificationStatusChip task={TASK} latestRun={RUN} onOpen={onOpen} />);

      fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
      fireEvent.click(screen.getByTestId('verification-status-chip'));

      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('verification-chip-reason-popover')).not.toBeInTheDocument();
    });
  });

  describe("failing gate names survive the pane's selection (Issue #2064)", () => {
    it('keeps the gate names when the pane moves to an older run', () => {
      const { rerender } = render(
        <VerificationStatusChip
          task={TASK}
          latestRun={RUN}
          latestRunGates={[gate('lint', 'passed'), gate('unit', 'failed')]}
          onOpen={() => {}}
        />
      );
      expect(screen.getByTestId('verification-status-chip').getAttribute('aria-label')).toContain(
        'Gates that did not pass: unit'
      );

      // Selecting run 8 in the pane makes both shells stop supplying the rows.
      rerender(
        <VerificationStatusChip
          task={TASK}
          latestRun={RUN}
          latestRunGates={null}
          onOpen={() => {}}
        />
      );

      expect(screen.getByTestId('verification-status-chip').getAttribute('aria-label')).toContain(
        'Gates that did not pass: unit'
      );
    });

    it('drops them when a genuinely new run becomes the latest one', () => {
      const { rerender } = render(
        <VerificationStatusChip
          task={TASK}
          latestRun={RUN}
          latestRunGates={[gate('unit', 'failed')]}
          onOpen={() => {}}
        />
      );

      // Run 10 has no gate rows loaded yet: reporting run 9's failures under
      // run 10's verdict would be a lie, not a convenience.
      rerender(
        <VerificationStatusChip
          task={TASK}
          latestRun={{ ...RUN, id: 10, status: 'running' }}
          latestRunGates={null}
          onOpen={() => {}}
        />
      );

      expect(
        screen.getByTestId('verification-status-chip').getAttribute('aria-label')
      ).not.toContain('unit');
    });
  });
});
