/**
 * Issue #3514: the Action bar's layout icons, the selected-split frame, and the
 * placement of an agent added from the header's "+".
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  TerminalSplitContainer,
  type InstancePlacementRequest,
} from '@/components/worktree/TerminalSplitContainer';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import type { AgentInstance } from '@/lib/cli-tools/types';

const BASE: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 2 },
  { id: 'copilot', cliTool: 'copilot', alias: 'Copilot', order: 3 },
];
const ADDED: AgentInstance = { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 4 };

type Props = Partial<React.ComponentProps<typeof TerminalSplitContainer>>;

function renderContainer(props: Props = {}) {
  const renderPane = vi.fn(({ splitIndex, instanceId, onFocus, showFocusFrame }) => (
    <div data-split-index={splitIndex}>
      <span data-testid={`pane-instance-${splitIndex}`}>{instanceId}</span>
      <span data-testid={`pane-frame-${splitIndex}`}>{String(showFocusFrame)}</span>
      <textarea data-testid={`pane-textarea-${splitIndex}`} onFocus={onFocus} />
    </div>
  ));
  const all: React.ComponentProps<typeof TerminalSplitContainer> = {
    worktreeId: 'w-3514',
    instances: BASE,
    renderPane,
    ...props,
  };
  const utils = render(<TerminalSplitContainer {...all} />);
  const rerender = (next: Props) =>
    utils.rerender(<TerminalSplitContainer {...all} {...next} />);
  return { ...utils, rerender, renderPane };
}

function shown(): string[] {
  return screen
    .queryAllByTestId(/^pane-instance-\d+$/)
    .map((el) => el.textContent ?? '');
}

describe('[#3514] layout icons', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('replaces the "n / 4 splits + -" stepper', () => {
    renderContainer();
    expect(screen.queryByTestId('add-terminal-split')).toBeNull();
    expect(screen.queryByTestId('remove-terminal-split')).toBeNull();
    expect(screen.queryByText(/\/ 4 splits/)).toBeNull();
    for (const n of [1, 2, 3, 4]) {
      expect(screen.getByTestId(`split-layout-${n}`)).toBeInTheDocument();
    }
  });

  it('switches 1 -> 4 -> 2 -> 1 directly, with 4 laid out as the 2x2 grid', () => {
    renderContainer();
    fireEvent.click(screen.getByTestId('split-layout-4'));
    expect(shown()).toHaveLength(4);
    expect(screen.getByTestId('terminal-split-layout')).toHaveAttribute('data-layout', 'grid');
    expect(screen.getByTestId('split-layout-4')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('split-layout-2'));
    expect(shown()).toEqual(['claude', 'codex']);
    expect(screen.getByTestId('terminal-split-layout')).toHaveAttribute('data-layout', 'row');

    fireEvent.click(screen.getByTestId('split-layout-1'));
    expect(shown()).toEqual(['claude']);
  });

  it('disables layouts the roster cannot fill', () => {
    renderContainer({ instances: BASE.slice(0, 2) });
    expect(screen.getByTestId('split-layout-2')).not.toBeDisabled();
    expect(screen.getByTestId('split-layout-3')).toBeDisabled();
    expect(screen.getByTestId('split-layout-4')).toBeDisabled();
  });

  it('keeps maximize working on top of a layout picked by icon (negative control)', () => {
    renderContainer();
    fireEvent.click(screen.getByTestId('split-layout-3'));
    fireEvent.click(screen.getByTestId('toggle-maximize-split'));
    expect(screen.getByTestId('split-count-label')).toHaveTextContent(
      'worktree.terminal.maximizedStatus',
    );
    // Picking a layout restores, like add / remove always did.
    fireEvent.click(screen.getByTestId('split-layout-2'));
    expect(screen.queryByTestId('split-count-label')).toBeNull();
    expect(screen.getByTestId('split-wrapper-1').style.display).toBe('');
  });

  it('frames the focused split only while more than one split is open', () => {
    renderContainer();
    expect(screen.getByTestId('pane-frame-0')).toHaveTextContent('false');
    fireEvent.click(screen.getByTestId('split-layout-2'));
    // The new split took focus.
    expect(screen.getByTestId('pane-frame-1')).toHaveTextContent('true');
    expect(screen.getByTestId('pane-frame-0')).toHaveTextContent('false');
    fireEvent.focus(screen.getByTestId('pane-textarea-0'));
    expect(screen.getByTestId('pane-frame-0')).toHaveTextContent('true');
    expect(screen.getByTestId('pane-frame-1')).toHaveTextContent('false');
  });

  it('publishes the split count', () => {
    const onSplitCountChange = vi.fn();
    renderContainer({ onSplitCountChange });
    expect(onSplitCountChange).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByTestId('split-layout-3'));
    expect(onSplitCountChange).toHaveBeenLastCalledWith(3);
  });
});

describe('[#3514] placing an agent added from the header "+"', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  const req = (placement: InstancePlacementRequest['placement'], token = 1): InstancePlacementRequest => ({
    instanceId: ADDED.id,
    placement,
    token,
  });

  it('new-split appends a split showing it and focuses that split', () => {
    const onActiveInstanceChange = vi.fn();
    const { rerender } = renderContainer({ onActiveInstanceChange });
    rerender({ instances: [...BASE, ADDED], instancePlacementRequest: req('new-split') });
    expect(shown()).toEqual(['claude', 'claude-2']);
    expect(screen.getByTestId('pane-frame-1')).toHaveTextContent('true');
    expect(onActiveInstanceChange).toHaveBeenCalledWith('claude-2');
  });

  it('replace swaps it into the focused split', () => {
    const { rerender } = renderContainer();
    fireEvent.click(screen.getByTestId('split-layout-2'));
    fireEvent.focus(screen.getByTestId('pane-textarea-0'));
    rerender({ instances: [...BASE, ADDED], instancePlacementRequest: req('replace') });
    expect(shown()).toEqual(['claude-2', 'codex']);
  });

  it('at the ceiling a new-split request falls back to replacing the focused split', () => {
    const { rerender } = renderContainer();
    fireEvent.click(screen.getByTestId('split-layout-4'));
    fireEvent.focus(screen.getByTestId('pane-textarea-2'));
    rerender({ instances: [...BASE, ADDED], instancePlacementRequest: req('new-split') });
    expect(shown()).toEqual(['claude', 'codex', 'claude-2', 'copilot']);
  });

  it('waits for the roster that contains the new instance', () => {
    const { rerender } = renderContainer();
    rerender({ instancePlacementRequest: req('new-split') });
    expect(shown()).toEqual(['claude']);
    rerender({ instances: [...BASE, ADDED], instancePlacementRequest: req('new-split') });
    expect(shown()).toEqual(['claude', 'claude-2']);
  });

  it('applies a request once per token', () => {
    const { rerender } = renderContainer();
    const request = req('new-split');
    rerender({ instances: [...BASE, ADDED], instancePlacementRequest: request });
    fireEvent.click(screen.getByTestId('split-layout-1'));
    expect(shown()).toEqual(['claude']);
    // A re-render with the same request must not re-open the split.
    rerender({ instances: [...BASE, ADDED], instancePlacementRequest: request });
    expect(shown()).toEqual(['claude']);
  });
});
