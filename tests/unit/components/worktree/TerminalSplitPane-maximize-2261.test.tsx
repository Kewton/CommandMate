/**
 * Issue #2261: the split title bar's maximize / restore toggle.
 *
 * The control is opt-in through `onToggleMaximize` for the same reason
 * `onSurfaceModeChange` is (Issue #2193): every pre-#2261 caller — and the
 * header-shape assertions in the existing pane tests — must keep rendering the
 * header they rendered before.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

function renderPane(
  overrides: Partial<React.ComponentProps<typeof TerminalSplitPane>> = {},
) {
  const props: React.ComponentProps<typeof TerminalSplitPane> = {
    worktreeId: 'w-1',
    splitIndex: 0,
    cliToolId: 'claude',
    instanceId: 'claude',
    instance: inst('claude'),
    availableInstances: [inst('claude'), inst('codex')],
    onInstanceChange: vi.fn(),
    onFocus: vi.fn(),
    terminal: <div data-testid="terminal-body">term</div>,
    footer: <div data-testid="footer-body">footer</div>,
    ...overrides,
  };
  return { props, ...render(<TerminalSplitPane {...props} />) };
}

describe('[#2261] TerminalSplitPane maximize toggle', () => {
  it('is absent when the parent wires no handler (pre-#2261 header shape)', () => {
    renderPane();
    expect(screen.queryByTestId('toggle-maximize-0')).not.toBeInTheDocument();
  });

  it('renders unpressed with a Maximize label when the split shares the row', () => {
    renderPane({ splitIndex: 1, onToggleMaximize: vi.fn() });
    const button = screen.getByTestId('toggle-maximize-1');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    // Icon-only, so the accessible name and the tooltip are the ONLY thing
    // naming it — and the tooltip carries the chord for discoverability.
    expect(button).toHaveAttribute('aria-label', 'worktree.terminal.maximizeSplit');
    expect(button.getAttribute('title')).toContain('worktree.terminal.maximizeShortcutHint');
  });

  it('renders pressed with a Restore label while the split fills the row', () => {
    renderPane({ isMaximized: true, onToggleMaximize: vi.fn() });
    const button = screen.getByTestId('toggle-maximize-0');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAttribute('aria-label', 'worktree.terminal.restoreSplits');
  });

  it('calls the parent handler on click (the container owns the state)', () => {
    const onToggleMaximize = vi.fn();
    renderPane({ onToggleMaximize });
    fireEvent.click(screen.getByTestId('toggle-maximize-0'));
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it('cannot be squeezed out of a narrow title bar', () => {
    // The row now carries four controls; a shrinkable button is what makes a
    // 30%-wide split wrap its header onto a second line.
    renderPane({ onToggleMaximize: vi.fn() });
    expect(screen.getByTestId('toggle-maximize-0').className).toContain('flex-shrink-0');
  });

  it('sits at the end of the title bar, after the search button', () => {
    renderPane({ onToggleMaximize: vi.fn() });
    const search = screen.getByTestId('terminal-search-button-0');
    const maximize = screen.getByTestId('toggle-maximize-0');
    expect(
      search.compareDocumentPosition(maximize) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('leaves the rest of the header intact', () => {
    renderPane({ onToggleMaximize: vi.fn() });
    expect(screen.getByTestId('cli-selector-0')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-search-button-0')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-body')).toBeInTheDocument();
    expect(screen.getByTestId('footer-body')).toBeInTheDocument();
  });
});
