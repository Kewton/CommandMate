/**
 * Tests for TerminalSplitContainer (Issue #728)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';

function setup(renderImpl?: () => React.ReactNode) {
  const renderPane = vi.fn(({ splitIndex, cliToolId, availableCliTools, onFocus }) => (
    <div data-split-index={splitIndex} data-cli-tool={cliToolId}>
      <span data-testid={`pane-cli-${splitIndex}`}>{cliToolId}</span>
      <span data-testid={`pane-available-count-${splitIndex}`}>
        {availableCliTools.length}
      </span>
      <textarea data-testid={`pane-textarea-${splitIndex}`} onFocus={onFocus} />
      {renderImpl?.()}
    </div>
  ));
  const utils = render(
    <TerminalSplitContainer worktreeId="w-1" renderPane={renderPane} />,
  );
  return { renderPane, ...utils };
}

describe('TerminalSplitContainer', () => {
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
  });
  afterEach(() => {
    clearTerminalSplitsLocalStorage();
  });

  it('renders an outer group with aria-label', () => {
    setup();
    const group = screen.getByRole('group', { name: /Terminal splits/i });
    expect(group).toBeInTheDocument();
  });

  it('starts with one split and disabled remove button', () => {
    setup();
    expect(screen.getByTestId('pane-cli-0')).toHaveTextContent('claude');
    expect(screen.getByTestId('add-terminal-split')).not.toBeDisabled();
    expect(screen.getByTestId('remove-terminal-split')).toBeDisabled();
  });

  it('add → 2 splits → renders 2 panes and 1 resizer', () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    expect(screen.getByTestId('pane-cli-0')).toBeInTheDocument();
    expect(screen.getByTestId('pane-cli-1')).toBeInTheDocument();
    expect(screen.getByTestId('split-resizer-0')).toBeInTheDocument();
    expect(screen.queryByTestId('split-resizer-1')).not.toBeInTheDocument();
  });

  it('disables add at MAX_SPLITS=3 and disables remove at MIN=1', () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    expect(screen.getByTestId('add-terminal-split')).toBeDisabled();
    expect(screen.getByTestId('remove-terminal-split')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('remove-terminal-split'));
    fireEvent.click(screen.getByTestId('remove-terminal-split'));
    expect(screen.getByTestId('remove-terminal-split')).toBeDisabled();
  });

  it('availableCliTools excludes CLI used by other splits', () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    // split 0 has 'claude', split 1 picked a different CLI; both panes should
    // show CLI_TOOL_IDS.length - 1 = 5 available tools (own + 4 others not taken).
    expect(screen.getByTestId('pane-available-count-0')).toHaveTextContent('5');
    expect(screen.getByTestId('pane-available-count-1')).toHaveTextContent('5');
  });

  it('focuses the newly-added pane textarea after addSplit', async () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    // jsdom: focus is sync inside effect
    const ta = screen.getByTestId('pane-textarea-1') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(ta);
  });

  it('routes onFocus through to onFocusedSplitChange', () => {
    const cb = vi.fn();
    const renderPane = vi.fn(({ splitIndex, onFocus }) => (
      <div data-split-index={splitIndex}>
        <textarea data-testid={`ta-${splitIndex}`} onFocus={onFocus} />
      </div>
    ));
    render(
      <TerminalSplitContainer
        worktreeId="w-1"
        renderPane={renderPane}
        onFocusedSplitChange={cb}
      />,
    );
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    cb.mockClear();
    fireEvent.focus(screen.getByTestId('ta-0'));
    expect(cb).toHaveBeenCalledWith(0);
  });
});
