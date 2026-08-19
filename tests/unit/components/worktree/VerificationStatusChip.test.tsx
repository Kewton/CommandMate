/**
 * Tests for VerificationStatusChip (Issue #1816)
 * @vitest-environment jsdom
 *
 * The chip's whole job is discoverability: it has to appear only where there is
 * something to report, and it has to carry the *reason* for the verdict — the
 * failing gate ids — somewhere an operator can actually reach without opening
 * anything (`docs/design/discoverability-principle.md`, 実装規約 1).
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
  it('renders nothing when the worktree has no task row', () => {
    const { container } = render(
      <VerificationStatusChip task={null} latestRun={RUN} onOpen={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the task title, the task status, and the run verdict', () => {
    render(<VerificationStatusChip task={TASK} latestRun={RUN} onOpen={() => {}} />);

    expect(screen.getByTestId('verification-chip-title')).toHaveTextContent('Issue #1816');
    expect(screen.getByTestId('verification-chip-task-status')).toHaveTextContent('verifying');
    // §3.4 vocabulary, keyword included: two bare `failed` badges side by side
    // would read as one status repeated.
    expect(screen.getByTestId('verification-chip-run-status')).toHaveTextContent('RESULT failed');
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
    expect(reason).toContain('RESULT failed');
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
    expect(screen.getByTestId('verification-chip-run-status')).toHaveTextContent('—');
  });

  it('opens the pane when clicked', () => {
    const onOpen = vi.fn();
    render(<VerificationStatusChip task={TASK} latestRun={RUN} onOpen={onOpen} />);

    fireEvent.click(screen.getByTestId('verification-status-chip'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
