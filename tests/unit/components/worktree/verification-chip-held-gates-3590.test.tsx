/**
 * @vitest-environment jsdom
 *
 * Issue #3590: the Verification chip keeps the failing gates of the latest run
 * after the operator selects an older run (#2064's `useGatesOfLatestRun`). The
 * chip now sits in the split action bar, inside `FilePanelSplit`'s terminal —
 * and `FilePanelSplit` renders the terminal in a different tree when the
 * first file opens or the last one closes, so the chip remounts there. What it
 * held in a ref went with it, and the tooltip / reason lost the gate names.
 *
 * The composition here is the PC screen's: the chip built by
 * `useDesktopVerificationChip` (WorktreeDetailDesktop), handed to
 * `TerminalSplitContainer`'s `actionBarItems`, inside a real `FilePanelSplit`.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useDesktopVerificationChip } from '@/components/worktree/WorktreeDetailDesktop';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { FilePanelSplit } from '@/components/worktree/FilePanelSplit';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import type { FileTabsState } from '@/hooks/useFileTabs';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type {
  TaskView,
  VerificationGateResultView,
  VerificationRunListItem,
  VerificationRunView,
} from '@/lib/api/verification-api';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

// The file panel's own content is not the subject (same mocks as FilePanelSplit.test).
vi.mock('@/components/worktree/FilePanelTabs', () => ({
  FilePanelTabs: () => <div data-testid="file-panel-tabs" />,
}));
vi.mock('@/components/worktree/DiffViewer', () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));

const TASK = null as TaskView | null;

function run(id: number): VerificationRunListItem {
  return {
    id,
    worktreeId: 'wt-3590',
    instanceId: null,
    taskId: null,
    trigger: 'api',
    status: 'failed',
    baseRef: 'origin/develop',
    startedAt: '2026-10-11T00:01:00.000Z',
    finishedAt: '2026-10-11T00:02:00.000Z',
  } as VerificationRunListItem;
}

function gate(runId: number, gateId: string, status: VerificationGateResultView['status']) {
  return {
    id: runId * 10 + gateId.length,
    runId,
    gateId,
    command: `npm run ${gateId}`,
    status,
    exitCode: status === 'passed' ? 0 : 1,
    durationMs: 1200,
    logTail: null,
    startedAt: '2026-10-11T00:01:00.000Z',
    finishedAt: '2026-10-11T00:02:00.000Z',
    source: 'verify.yaml',
    timingsMeasured: true,
  } as VerificationGateResultView;
}

function view(id: number, gates: VerificationGateResultView[]): VerificationRunView {
  return { ...run(id), gates } as VerificationRunView;
}

const NO_TABS: FileTabsState = { tabs: [], activeIndex: null };
const ONE_TAB: FileTabsState = {
  tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
  activeIndex: 0,
};
const INSTANCES: AgentInstance[] = [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }];
const onOpen = () => {};

function Screen({
  latestRun,
  selectedRun,
  tabs,
}: {
  latestRun: VerificationRunListItem | null;
  selectedRun: VerificationRunView | null;
  tabs: FileTabsState;
}) {
  const chip = useDesktopVerificationChip({ task: TASK, latestRun, selectedRun }, onOpen);
  return (
    <FilePanelSplit
      fileTabs={tabs}
      worktreeId="wt-3590"
      onCloseTab={vi.fn()}
      onActivateTab={vi.fn()}
      onLoadContent={vi.fn()}
      onLoadError={vi.fn()}
      onSetLoading={vi.fn()}
      terminal={
        <TerminalSplitContainer
          worktreeId="wt-3590"
          instances={INSTANCES}
          renderPane={() => <div />}
          actionBarItems={chip}
        />
      }
    />
  );
}

function chipLabel(): string {
  return screen.getByTestId('verification-status-chip').getAttribute('aria-label') ?? '';
}

function reasonText(): string {
  fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
  const text = screen.getByTestId('verification-chip-reason-popover').textContent ?? '';
  fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
  return text;
}

const FAILING = 'Gates that did not pass: unit';

describe('Verification chip keeps the held failing gates (Issue #3590)', () => {
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    window.localStorage.clear();
  });
  afterEach(() => clearTerminalSplitsLocalStorage());

  const latest = run(9);
  const latestView = view(9, [gate(9, 'unit', 'failed'), gate(9, 'lint', 'passed')]);
  const older = view(8, [gate(8, 'unit', 'passed')]);

  it('across the first file opening and the last one closing', () => {
    const { rerender } = render(<Screen latestRun={latest} selectedRun={latestView} tabs={NO_TABS} />);
    expect(chipLabel()).toContain(FAILING);

    // The operator browses an older run: the chip keeps the latest run's gates.
    rerender(<Screen latestRun={latest} selectedRun={older} tabs={NO_TABS} />);
    expect(chipLabel()).toContain(FAILING);

    // The first file opens: the terminal moves into the split layout.
    rerender(<Screen latestRun={latest} selectedRun={older} tabs={ONE_TAB} />);
    expect(screen.getByTestId('terminal-pane')).toBeInTheDocument();
    expect(chipLabel()).toContain(FAILING);
    expect(reasonText()).toContain(FAILING);

    // The last file closes: back to the full-width terminal.
    rerender(<Screen latestRun={latest} selectedRun={older} tabs={NO_TABS} />);
    expect(screen.queryByTestId('terminal-pane')).toBeNull();
    expect(chipLabel()).toContain(FAILING);
    expect(reasonText()).toContain(FAILING);
  });

  it('still moves on to a new run (negative control)', () => {
    const { rerender } = render(<Screen latestRun={latest} selectedRun={latestView} tabs={NO_TABS} />);
    rerender(<Screen latestRun={latest} selectedRun={older} tabs={ONE_TAB} />);

    // A new run arrives while an older one is selected: its gates are unknown,
    // so the previous run's failures must not be shown under the new verdict.
    rerender(<Screen latestRun={run(10)} selectedRun={older} tabs={ONE_TAB} />);
    expect(chipLabel()).not.toContain('Gates that did not pass');
    expect(chipLabel()).toContain('run 10');

    // And once the new run's rows arrive, they are shown.
    rerender(
      <Screen
        latestRun={run(10)}
        selectedRun={view(10, [gate(10, 'lint', 'failed')])}
        tabs={NO_TABS}
      />
    );
    expect(chipLabel()).toContain('Gates that did not pass: lint');
  });
});
