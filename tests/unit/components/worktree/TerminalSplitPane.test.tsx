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

// ===========================================================================
// Issue #786: drop target behavior. jsdom does not implement DragEvent /
// dataTransfer, so we hand-mock the dataTransfer interface and pass it to
// fireEvent.dragOver / drop. Production reads getData only on drop (D-2); the
// dragOver allowed/forbidden ring is driven by the published `draggedCliTool`.
// ===========================================================================
const DND_MIME = 'application/x-commandmate-cli-tool';

function makeDataTransfer(payload?: string) {
  const store: Record<string, string> = {};
  if (payload !== undefined) store[DND_MIME] = payload;
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    types: Object.keys(store),
    getData: (type: string) => store[type] ?? '',
    setData: (type: string, val: string) => {
      store[type] = val;
    },
  };
}

describe('TerminalSplitPane drop target (Issue #786)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('onDragOver calls preventDefault so the drop is allowed', () => {
    renderPane({ onDropCliTool: vi.fn(), draggedCliTool: 'codex' });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    // fireEvent returns false when a handler called preventDefault.
    const notCanceled = fireEvent.dragOver(region, {
      dataTransfer: makeDataTransfer(),
    });
    expect(notCanceled).toBe(false);
  });

  it('onDragOver does NOT preventDefault when drop props are omitted (inert)', () => {
    renderPane();
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    const notCanceled = fireEvent.dragOver(region, {
      dataTransfer: makeDataTransfer(),
    });
    expect(notCanceled).toBe(true);
  });

  it('shows the allowed (cyan) ring when dragging a CLI available to this split', () => {
    // availableCliTools includes 'codex' → allowed.
    renderPane({
      onDropCliTool: vi.fn(),
      draggedCliTool: 'codex',
      availableCliTools: ['claude', 'codex', 'gemini'] as CLIToolType[],
    });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.dragEnter(region, { dataTransfer: makeDataTransfer() });
    expect(region.className).toMatch(/ring-cyan-400/);
    expect(region.className).not.toMatch(/ring-red/);
  });

  it('shows the forbidden (red) ring + not-allowed cursor when dragging a CLI used by another split', () => {
    // 'opencode' is NOT in availableCliTools → used by another split → forbidden.
    renderPane({
      onDropCliTool: vi.fn(),
      draggedCliTool: 'opencode',
      availableCliTools: ['claude', 'codex'] as CLIToolType[],
    });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.dragEnter(region, { dataTransfer: makeDataTransfer() });
    expect(region.className).toMatch(/ring-red-300/);
    expect(region.className).toMatch(/cursor-not-allowed/);
  });

  it('clears the hover ring on dragLeave', () => {
    renderPane({
      onDropCliTool: vi.fn(),
      draggedCliTool: 'codex',
      availableCliTools: ['claude', 'codex'] as CLIToolType[],
    });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.dragEnter(region, { dataTransfer: makeDataTransfer() });
    expect(region.className).toMatch(/ring-cyan-400/);
    fireEvent.dragLeave(region, { dataTransfer: makeDataTransfer() });
    expect(region.className).not.toMatch(/ring-cyan-400/);
  });

  it('onDrop reads the dropped cliId from dataTransfer and calls onDropCliTool', () => {
    const onDropCliTool = vi.fn();
    renderPane({ onDropCliTool, draggedCliTool: 'codex' });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.drop(region, { dataTransfer: makeDataTransfer('codex') });
    expect(onDropCliTool).toHaveBeenCalledTimes(1);
    expect(onDropCliTool).toHaveBeenCalledWith('codex');
  });

  it('onDrop clears the hover ring', () => {
    const onDropCliTool = vi.fn();
    renderPane({
      onDropCliTool,
      draggedCliTool: 'codex',
      availableCliTools: ['claude', 'codex'] as CLIToolType[],
    });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.dragEnter(region, { dataTransfer: makeDataTransfer() });
    expect(region.className).toMatch(/ring-cyan-400/);
    fireEvent.drop(region, { dataTransfer: makeDataTransfer('codex') });
    expect(region.className).not.toMatch(/ring-cyan-400/);
  });

  it('onDrop ignores an empty / foreign payload (no onDropCliTool call)', () => {
    const onDropCliTool = vi.fn();
    renderPane({ onDropCliTool, draggedCliTool: 'codex' });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.drop(region, { dataTransfer: makeDataTransfer() });
    expect(onDropCliTool).not.toHaveBeenCalled();
  });

  it('is inert (no ring, no throw) when drop props are omitted (backward compat)', () => {
    renderPane();
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    expect(() => {
      fireEvent.dragOver(region, { dataTransfer: makeDataTransfer() });
      fireEvent.dragEnter(region, { dataTransfer: makeDataTransfer() });
      fireEvent.drop(region, { dataTransfer: makeDataTransfer('codex') });
    }).not.toThrow();
    expect(region.className).not.toMatch(/ring-cyan-400/);
    expect(region.className).not.toMatch(/ring-red-300/);
  });
});
