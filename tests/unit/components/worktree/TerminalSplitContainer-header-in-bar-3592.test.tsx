/**
 * Issue #3592: with ONE split, the split's title bar is not drawn — its
 * controls (agent selector, Terminal / Chat, model, cost, note, End, search,
 * maximize, "…") are in the action bar. With two or more, each split has its
 * own 30px title bar. Switching between the two moves only the controls: the
 * split's content (draft, polling, scroll, the reason popover) is never
 * re-created.
 *
 * @vitest-environment jsdom
 */

import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import type { AgentInstance } from '@/lib/cli-tools/types';

beforeAll(() => installRadixJsdomPolyfills());

const INSTANCES: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
];

/** How many times each split's content mounted, by split index. */
let mounts: Record<number, number> = {};

/** Stands in for the split's content: counts its mounts, holds a draft. */
function PaneBody({ splitIndex }: { splitIndex: number }) {
  useEffect(() => {
    mounts[splitIndex] = (mounts[splitIndex] ?? 0) + 1;
  }, [splitIndex]);
  return <textarea data-testid={`draft-${splitIndex}`} defaultValue="" />;
}

function renderContainer(extra: Partial<React.ComponentProps<typeof TerminalSplitContainer>> = {}) {
  return render(
    <TerminalSplitContainer
      worktreeId="w-3592"
      instances={INSTANCES}
      actionBarItems={<span data-testid="chip">chip</span>}
      renderPane={({
        splitIndex,
        cliToolId,
        instanceId,
        instance,
        availableInstances,
        onInstanceChange,
        onFocus,
        isMaximized,
        onToggleMaximize,
        showFocusFrame,
      }) => (
        <TerminalSplitPane
          worktreeId="w-3592"
          splitIndex={splitIndex}
          cliToolId={cliToolId}
          instanceId={instanceId}
          instance={instance}
          availableInstances={availableInstances}
          onInstanceChange={onInstanceChange}
          onFocus={onFocus}
          isMaximized={isMaximized}
          onToggleMaximize={onToggleMaximize}
          showFocusFrame={showFocusFrame}
          onSurfaceModeChange={vi.fn()}
          agentModel="opus-4"
          agentUsage="$0.03 · 8.5K (1%)"
          agentUsageDetail="cost detail"
          terminal={<PaneBody splitIndex={splitIndex} />}
          footer={<div />}
        />
      )}
      {...extra}
    />,
  );
}

describe('[#3592] one split: the title bar\'s controls are in the action bar', () => {
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    mounts = {};
  });
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('draws no title bar in the split, and the session controls right of the chip', () => {
    renderContainer();
    const pane = screen.getByTestId('terminal-split-pane-0');
    expect(within(pane).queryByTestId('split-header-0')).toBeNull();
    expect(within(pane).queryByTestId('cli-selector-0')).toBeNull();
    // Flush under the bar: the bar's bottom border is the split's top edge.
    expect(pane.className).toContain('border-t-0');

    const session = screen.getByTestId('split-action-bar-session');
    for (const id of [
      'cli-selector-0',
      'surface-mode-toggle-0',
      'split-agent-model-0',
      'split-agent-usage-0',
      'split-session-note-edit-0',
    ]) {
      expect(within(session).getByTestId(id)).toBeInTheDocument();
    }
    // Right of the Verification chip (the slotted items).
    const chip = screen.getByTestId('chip');
    expect(chip.compareDocumentPosition(session) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts search, maximize and "…" at the right end, left of History / Files', () => {
    renderContainer();
    const actions = screen.getByTestId('split-action-bar-pane-actions');
    for (const id of ['terminal-search-button-0', 'toggle-maximize-0', 'split-more-menu-0']) {
      expect(within(actions).getByTestId(id)).toBeInTheDocument();
    }
    const history = screen.getByTestId('toggle-history-pane');
    expect(actions.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Open Files keeps its empty-state rule (#2259).
    expect(screen.getByTestId('toggle-file-panel')).toBeDisabled();
  });

  it('gives the selector the model and cost as its tooltip (the chips\' own strings)', () => {
    renderContainer();
    const title = screen.getByTestId('cli-selector-0').getAttribute('title') ?? '';
    expect(title).toContain('worktree.agentModel.modelLabel');
    expect(title).toContain('cost detail');
  });

  it('opens the note editor from the bar\'s edit entry when the note is empty', () => {
    renderContainer();
    fireEvent.click(screen.getByTestId('split-session-note-edit-0'));
    expect(
      within(screen.getByTestId('split-action-bar-session')).getByTestId('split-session-note-input-0'),
    ).toBeInTheDocument();
  });
});

describe('[#3592] two or more splits: each split has its own 30px title bar', () => {
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    mounts = {};
  });
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('draws a title bar per split and no slots in the bar', () => {
    renderContainer();
    fireEvent.click(screen.getByTestId('split-layout-2'));
    expect(screen.queryByTestId('split-action-bar-session')).toBeNull();
    expect(screen.queryByTestId('split-action-bar-pane-actions')).toBeNull();
    for (const idx of [0, 1]) {
      const header = within(screen.getByTestId(`terminal-split-pane-${idx}`)).getByTestId(
        `split-header-${idx}`,
      );
      expect(header.className).toContain('h-[30px]');
      expect(screen.getByTestId(`terminal-split-pane-${idx}`).className).not.toContain('border-t-0');
      expect(within(header).getByTestId(`cli-selector-${idx}`)).toBeInTheDocument();
      expect(within(header).getByTestId(`split-more-menu-${idx}`)).toBeInTheDocument();
      // The title bar keeps the #2427 rule: an empty note adds nothing.
      expect(within(header).queryByTestId(`split-session-note-edit-${idx}`)).toBeNull();
      // And no tooltip on the selector: the chips are beside it.
      expect(within(header).getByTestId(`cli-selector-${idx}`)).not.toHaveAttribute('title');
    }
  });

  it('1 → 2 → 1 keeps the split\'s content mounted and its draft', () => {
    renderContainer();
    const draft = screen.getByTestId('draft-0') as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: 'half-typed instruction' } });
    expect(mounts[0]).toBe(1);

    fireEvent.click(screen.getByTestId('split-layout-2'));
    expect(screen.getByTestId('split-header-0')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('split-layout-1'));
    expect(screen.queryByTestId('split-header-0')).toBeNull();

    expect(screen.getByTestId('draft-0')).toBe(draft);
    expect(draft.value).toBe('half-typed instruction');
    expect(mounts[0]).toBe(1);
  });
});

describe('[#3592] negative control: a pane with no container keeps its title bar', () => {
  it('renders the 30px title bar when nothing provides the slots', () => {
    render(
      <TerminalSplitPane
        worktreeId="w-3592"
        splitIndex={0}
        cliToolId="claude"
        instanceId="claude"
        instance={INSTANCES[0]}
        availableInstances={[INSTANCES[0]]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        terminal={<div />}
        footer={<div />}
      />,
    );
    const header = screen.getByTestId('split-header-0');
    expect(within(header).getByTestId('cli-selector-0')).toBeInTheDocument();
    expect(within(header).getByTestId('split-more-menu-0')).toBeInTheDocument();
  });

  it('keeps the bar\'s own maximize disabled at one split (unchanged)', () => {
    clearTerminalSplitsLocalStorage();
    renderContainer();
    expect(screen.getByTestId('toggle-maximize-split')).toBeDisabled();
    clearTerminalSplitsLocalStorage();
  });
});
