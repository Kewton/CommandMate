/**
 * Issue #2307: the split title bar's icon-only controls (output-surface
 * toggle, search, per-split maximize) are wrapped in `common/Tooltip`
 * (the same mechanism ActivityBar uses, Issue #730) instead of relying on
 * the native `title` attribute, which is slow to appear, unreachable by
 * keyboard, and browser-styled.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { TOOLTIP_DELAY_MS } from '@/components/common/Tooltip';

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

/** Hover a trigger and advance past TOOLTIP_DELAY_MS; caller owns fake timers. */
function revealTooltip(trigger: HTMLElement): string {
  fireEvent.mouseEnter(trigger);
  act(() => {
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  });
  return screen.getByRole('tooltip', { hidden: true }).textContent ?? '';
}

describe('[#2307] TerminalSplitPane hover discoverability', () => {
  it('carries no native title on the surface-mode segments, the search button, or the maximize toggle', () => {
    renderPane({ onSurfaceModeChange: vi.fn(), onToggleMaximize: vi.fn() });
    const targets = [
      screen.getByTestId('surface-mode-terminal-0'),
      screen.getByTestId('surface-mode-chat-0'),
      screen.getByTestId('terminal-search-button-0'),
      screen.getByTestId('toggle-maximize-0'),
    ];
    for (const el of targets) {
      expect(el.getAttribute('title')).toBeNull();
    }
  });

  it('keeps aria-label / data-testid unchanged for every wrapped control', () => {
    renderPane({ onSurfaceModeChange: vi.fn(), onToggleMaximize: vi.fn() });
    expect(screen.getByTestId('surface-mode-terminal-0')).toHaveAttribute(
      'aria-label',
      'worktree.surfaceMode.showTerminal',
    );
    expect(screen.getByTestId('surface-mode-chat-0')).toHaveAttribute(
      'aria-label',
      'worktree.surfaceMode.showChat',
    );
    expect(screen.getByTestId('toggle-maximize-0')).toHaveAttribute(
      'aria-label',
      'worktree.terminal.maximizeSplit',
    );
  });

  it('shows a Tooltip for the surface-mode segments after the hover delay', () => {
    vi.useFakeTimers();
    renderPane({ onSurfaceModeChange: vi.fn() });
    const chatBtn = screen.getByTestId('surface-mode-chat-0');
    expect(revealTooltip(chatBtn)).toBe('worktree.surfaceMode.showChat');
    vi.useRealTimers();
  });

  it('shows a Tooltip for the per-split maximize toggle, carrying the shortcut hint', () => {
    vi.useFakeTimers();
    renderPane({ onToggleMaximize: vi.fn() });
    const btn = screen.getByTestId('toggle-maximize-0');
    const text = revealTooltip(btn);
    expect(text).toContain('worktree.terminal.maximizeSplit');
    expect(text).toContain('worktree.terminal.maximizeShortcutHint');
    vi.useRealTimers();
  });

  it('i18n-izes the search button label — no hardcoded English aria-label — and shares it with the Tooltip', () => {
    vi.useFakeTimers();
    renderPane();
    const btn = screen.getByTestId('terminal-search-button-0');
    const label = btn.getAttribute('aria-label');
    expect(label).toBe('worktree.terminal.searchOutput');
    expect(label).not.toMatch(/Search terminal output for/);
    expect(revealTooltip(btn)).toBe(label);
    vi.useRealTimers();
  });
});
