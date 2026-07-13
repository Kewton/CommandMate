/**
 * Tests for TerminalSplitPane (Issue #728, instance-keyed in Issue #869)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  TerminalSplitPane,
  AGENT_INSTANCE_DND_MIME,
} from '@/components/worktree/TerminalSplitPane';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

// Issue #1079: the instance selector is now a Radix DropdownMenu (portalled),
// which touches pointer-capture / scrollIntoView that jsdom does not implement.
beforeAll(() => installRadixJsdomPolyfills());

/** Open the split's instance-selector menu (keyboard-opens the Radix trigger). */
function openSelector(splitIndex = 0) {
  fireEvent.keyDown(screen.getByTestId(`cli-selector-${splitIndex}`), { key: 'Enter' });
}

/** Build a primary AgentInstance (id === cliTool) for tests. */
function inst(cliTool: CLIToolType, alias?: string): AgentInstance {
  return { id: cliTool, cliTool, alias: alias ?? cliTool, order: 0 };
}

const ALL_INSTANCES: AgentInstance[] = [
  inst('claude'),
  inst('codex'),
  inst('gemini'),
  inst('copilot'),
  inst('opencode'),
  inst('vibe-local'),
];

function renderPane(
  overrides: Partial<React.ComponentProps<typeof TerminalSplitPane>> = {},
) {
  const props: React.ComponentProps<typeof TerminalSplitPane> = {
    worktreeId: 'w-1',
    splitIndex: 0,
    cliToolId: 'claude',
    instanceId: 'claude',
    instance: inst('claude'),
    availableInstances: ALL_INSTANCES,
    onInstanceChange: vi.fn(),
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

  it('shows the current instance alias and a status dot in the selector trigger', () => {
    renderPane({
      instanceId: 'claude',
      instance: { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 0 },
      status: 'running',
    });
    const trigger = screen.getByTestId('cli-selector-0');
    expect(trigger).toHaveTextContent('Primary');
    // Issue #1079: the derived status renders as a StatusDot inside the trigger.
    expect(screen.getByTestId('split-status-indicator-0')).toBeInTheDocument();
  });

  it('lists only the available instances in the selector menu', () => {
    // Issue #869: the parent already excludes instances used by other splits and
    // always includes this split's own instance, so the pane simply lists them.
    renderPane({
      instanceId: 'claude',
      instance: inst('claude'),
      availableInstances: [inst('claude'), inst('gemini')],
    });
    openSelector();
    const items = screen.getAllByRole('menuitemradio').map(i => i.textContent);
    expect(items).toEqual(['claude', 'gemini']);
  });

  it('labels menu items by the instance alias', () => {
    renderPane({
      instanceId: 'claude',
      instance: { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 0 },
      availableInstances: [
        { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 0 },
        { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 1 },
      ],
    });
    openSelector();
    const labels = screen.getAllByRole('menuitemradio').map(i => i.textContent);
    expect(labels).toEqual(['Primary', 'Review']);
  });

  it('fires onInstanceChange when a different instance is picked from the menu', () => {
    const onInstanceChange = vi.fn();
    renderPane({
      onInstanceChange,
      availableInstances: [inst('claude'), inst('codex')],
    });
    openSelector();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'codex' }));
    expect(onInstanceChange).toHaveBeenCalledWith('codex');
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
// Issue #786 / #869: drop target behavior. jsdom does not implement DragEvent /
// dataTransfer, so we hand-mock the dataTransfer interface and pass it to
// fireEvent.dragOver / drop. Production reads getData only on drop (D-2); the
// dragOver allowed/forbidden ring is driven by the published `draggedInstanceId`.
// ===========================================================================
function makeDataTransfer(payload?: string) {
  const store: Record<string, string> = {};
  if (payload !== undefined) store[AGENT_INSTANCE_DND_MIME] = payload;
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

describe('TerminalSplitPane drop target (Issue #786 / #869)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('onDragOver calls preventDefault so the drop is allowed', () => {
    renderPane({ onDropInstance: vi.fn(), draggedInstanceId: 'codex' });
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

  it('shows the allowed (cyan) ring when dragging an instance available to this split', () => {
    // availableInstances includes 'codex' → allowed.
    renderPane({
      onDropInstance: vi.fn(),
      draggedInstanceId: 'codex',
      availableInstances: [inst('claude'), inst('codex'), inst('gemini')],
    });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.dragEnter(region, { dataTransfer: makeDataTransfer() });
    expect(region.className).toMatch(/ring-accent-400/);
    expect(region.className).not.toMatch(/ring-red/);
  });

  it('shows the forbidden (red) ring + not-allowed cursor when dragging an instance used by another split', () => {
    // 'opencode' is NOT in availableInstances → used by another split → forbidden.
    renderPane({
      onDropInstance: vi.fn(),
      draggedInstanceId: 'opencode',
      availableInstances: [inst('claude'), inst('codex')],
    });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.dragEnter(region, { dataTransfer: makeDataTransfer() });
    expect(region.className).toMatch(/ring-red-300/);
    expect(region.className).toMatch(/cursor-not-allowed/);
  });

  it('clears the hover ring on dragLeave', () => {
    renderPane({
      onDropInstance: vi.fn(),
      draggedInstanceId: 'codex',
      availableInstances: [inst('claude'), inst('codex')],
    });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.dragEnter(region, { dataTransfer: makeDataTransfer() });
    expect(region.className).toMatch(/ring-accent-400/);
    fireEvent.dragLeave(region, { dataTransfer: makeDataTransfer() });
    expect(region.className).not.toMatch(/ring-accent-400/);
  });

  it('onDrop reads the dropped instanceId from dataTransfer and calls onDropInstance', () => {
    const onDropInstance = vi.fn();
    renderPane({ onDropInstance, draggedInstanceId: 'codex' });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.drop(region, { dataTransfer: makeDataTransfer('codex') });
    expect(onDropInstance).toHaveBeenCalledTimes(1);
    expect(onDropInstance).toHaveBeenCalledWith('codex');
  });

  it('onDrop clears the hover ring', () => {
    const onDropInstance = vi.fn();
    renderPane({
      onDropInstance,
      draggedInstanceId: 'codex',
      availableInstances: [inst('claude'), inst('codex')],
    });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.dragEnter(region, { dataTransfer: makeDataTransfer() });
    expect(region.className).toMatch(/ring-accent-400/);
    fireEvent.drop(region, { dataTransfer: makeDataTransfer('codex') });
    expect(region.className).not.toMatch(/ring-accent-400/);
  });

  it('onDrop ignores an empty / foreign payload (no onDropInstance call)', () => {
    const onDropInstance = vi.fn();
    renderPane({ onDropInstance, draggedInstanceId: 'codex' });
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    fireEvent.drop(region, { dataTransfer: makeDataTransfer() });
    expect(onDropInstance).not.toHaveBeenCalled();
  });

  it('is inert (no ring, no throw) when drop props are omitted (backward compat)', () => {
    renderPane();
    const region = screen.getByRole('region', { name: /Terminal split 1/i });
    expect(() => {
      fireEvent.dragOver(region, { dataTransfer: makeDataTransfer() });
      fireEvent.dragEnter(region, { dataTransfer: makeDataTransfer() });
      fireEvent.drop(region, { dataTransfer: makeDataTransfer('codex') });
    }).not.toThrow();
    expect(region.className).not.toMatch(/ring-accent-400/);
    expect(region.className).not.toMatch(/ring-red-300/);
  });
});
