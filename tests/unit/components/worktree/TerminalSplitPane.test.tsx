/**
 * Tests for TerminalSplitPane (Issue #728)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import type { CLIToolType } from '@/lib/cli-tools/types';

function renderPane(
  overrides: Partial<React.ComponentProps<typeof TerminalSplitPane>> = {},
) {
  const props: React.ComponentProps<typeof TerminalSplitPane> = {
    worktreeId: 'w-1',
    splitIndex: 0,
    cliToolId: 'claude',
    availableCliTools: ['claude', 'codex', 'gemini', 'copilot', 'opencode', 'vibe-local'] as CLIToolType[],
    onCliToolChange: vi.fn(),
    onFocus: vi.fn(),
    terminal: <div data-testid="terminal-body">term</div>,
    footer: <div data-testid="footer-body">footer</div>,
    ...overrides,
  };
  return { props, ...render(<TerminalSplitPane {...props} />) };
}

describe('TerminalSplitPane', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders with role=region and an aria-label including the split index', () => {
    renderPane({ splitIndex: 1 });
    const region = screen.getByRole('region', { name: /Terminal split 2/i });
    expect(region).toBeInTheDocument();
  });

  it('renders terminal and footer slots', () => {
    renderPane();
    expect(screen.getByTestId('terminal-body')).toBeInTheDocument();
    expect(screen.getByTestId('footer-body')).toBeInTheDocument();
  });

  it('disables CLI options taken by other splits but allows current CLI', () => {
    renderPane({
      cliToolId: 'claude',
      availableCliTools: ['claude', 'gemini'] as CLIToolType[],
    });
    const select = screen.getByTestId('cli-selector-0') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    const byValue = Object.fromEntries(options.map(o => [o.value, o]));
    expect(byValue['claude'].disabled).toBe(false);
    expect(byValue['gemini'].disabled).toBe(false);
    expect(byValue['codex'].disabled).toBe(true);
    expect(byValue['copilot'].disabled).toBe(true);
  });

  it('fires onCliToolChange when selector changes', () => {
    const onCliToolChange = vi.fn();
    renderPane({ onCliToolChange });
    const select = screen.getByTestId('cli-selector-0') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'codex' } });
    expect(onCliToolChange).toHaveBeenCalledWith('codex');
  });

  it('dispatches terminal-search-open on the search button click', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    renderPane();
    const btn = screen.getByTestId('terminal-search-button-0');
    fireEvent.click(btn);
    const events = dispatchSpy.mock.calls.map(c => (c[0] as CustomEvent).type);
    expect(events).toContain('terminal-search-open');
  });

  it('calls onFocus when any child focus bubbles up', () => {
    const onFocus = vi.fn();
    renderPane({
      onFocus,
      footer: (
        <input
          data-testid="inner-input"
          placeholder="x"
        />
      ),
    });
    const input = screen.getByTestId('inner-input');
    fireEvent.focus(input);
    expect(onFocus).toHaveBeenCalled();
  });

  it('renders an attach skeleton with role=status when attaching=true', () => {
    renderPane({ attaching: true });
    const skeleton = screen.getByTestId('terminal-attach-skeleton-0');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton.getAttribute('role')).toBe('status');
  });

  it('renders headerExtras after the search button', () => {
    renderPane({
      headerExtras: <span data-testid="header-extras">X</span>,
    });
    expect(screen.getByTestId('header-extras')).toBeInTheDocument();
  });
});
