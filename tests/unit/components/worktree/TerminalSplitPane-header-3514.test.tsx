/**
 * Issue #3514: the split title bar's labelled Terminal / Chat segments, the
 * selected-split frame, the "…" menu, and the desktop header's "+" slot.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

function renderPane(overrides: Partial<React.ComponentProps<typeof TerminalSplitPane>> = {}) {
  const props: React.ComponentProps<typeof TerminalSplitPane> = {
    worktreeId: 'w-3514',
    splitIndex: 0,
    cliToolId: 'claude',
    instanceId: 'claude',
    instance: inst('claude'),
    availableInstances: [inst('claude')],
    onInstanceChange: vi.fn(),
    onFocus: vi.fn(),
    terminal: <div>term</div>,
    footer: <div>footer</div>,
    ...overrides,
  };
  return render(<TerminalSplitPane {...props} />);
}

function openMoreMenu(): void {
  fireEvent.keyDown(screen.getByTestId('split-more-menu-0'), { key: 'Enter' });
}

describe('[#3514] split title bar', () => {
  it('labels the surface segments with a word, keeping their accessible names', () => {
    renderPane({ onSurfaceModeChange: vi.fn() });
    const term = screen.getByTestId('surface-mode-terminal-0');
    const chat = screen.getByTestId('surface-mode-chat-0');
    expect(term).toHaveTextContent('worktree.surfaceMode.terminal');
    expect(chat).toHaveTextContent('worktree.surfaceMode.chat');
    expect(term).toHaveAttribute('aria-label', 'worktree.surfaceMode.showTerminal');
    expect(chat).toHaveAttribute('aria-label', 'worktree.surfaceMode.showChat');
  });

  it('still reports the surface per split through aria-pressed (negative control)', () => {
    const onSurfaceModeChange = vi.fn();
    renderPane({ surfaceMode: 'chat', onSurfaceModeChange });
    expect(screen.getByTestId('surface-mode-chat-0')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('surface-mode-terminal-0'));
    expect(onSurfaceModeChange).toHaveBeenCalledWith('terminal');
  });

  it('frames the selected split, and only it', () => {
    const { unmount } = renderPane({ showFocusFrame: true });
    const framed = screen.getByTestId('terminal-split-pane-0');
    expect(framed).toHaveAttribute('data-focused', 'true');
    expect(framed.className).toContain('border-accent-500');
    unmount();
    renderPane();
    const plain = screen.getByTestId('terminal-split-pane-0');
    expect(plain).not.toHaveAttribute('data-focused');
    expect(plain.className).toContain('border-border');
  });

  it('gathers maximize, search and end session in the "…" menu', () => {
    const onToggleMaximize = vi.fn();
    const onEndSession = vi.fn();
    const searchListener = vi.fn();
    window.addEventListener('terminal-search-open', searchListener);
    renderPane({ onToggleMaximize, onEndSession });

    openMoreMenu();
    fireEvent.click(screen.getByTestId('split-more-maximize-0'));
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);

    openMoreMenu();
    fireEvent.click(screen.getByTestId('split-more-search-0'));
    expect(searchListener).toHaveBeenCalledTimes(1);

    openMoreMenu();
    fireEvent.click(screen.getByTestId('split-more-end-session-0'));
    expect(onEndSession).toHaveBeenCalledTimes(1);
    window.removeEventListener('terminal-search-open', searchListener);
  });

  it('leaves End out of the menu when the split has no session to end', () => {
    renderPane({ onToggleMaximize: vi.fn() });
    openMoreMenu();
    expect(screen.getByTestId('split-more-search-0')).toBeInTheDocument();
    expect(screen.queryByTestId('split-more-end-session-0')).toBeNull();
  });

  it('keeps the inline maximize and search buttons (negative control)', () => {
    renderPane({ onToggleMaximize: vi.fn() });
    expect(screen.getByTestId('toggle-maximize-0')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-search-button-0')).toBeInTheDocument();
  });
});

describe('[#3514] desktop header "+" slot', () => {
  const base = {
    worktreeName: 'feature/3514',
    repositoryName: 'CommandMate',
    status: 'idle' as const,
    onInfoClick: vi.fn(),
    instances: [inst('claude'), inst('codex')],
    activeInstanceId: 'claude',
  };

  it('renders the control at the right end of the agent row', () => {
    render(<DesktopHeader {...base} agentAddControl={<button data-testid="slot-plus">+</button>} />);
    const row = screen.getByTestId('desktop-agent-status-row');
    const plus = within(row).getByTestId('slot-plus');
    expect(row.lastElementChild).toBe(plus);
  });

  it('renders nothing extra without it (negative control)', () => {
    render(<DesktopHeader {...base} />);
    expect(screen.queryByTestId('slot-plus')).toBeNull();
    expect(screen.getByTestId('desktop-agent-status-row')).toBeInTheDocument();
  });
});
