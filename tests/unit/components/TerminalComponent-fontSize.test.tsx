/**
 * Unit tests for TerminalComponent fontSize prop (Issue #915)
 *
 * Verifies the xterm.js terminal font size is driven by the `fontSize` prop and
 * updates live when the prop changes (without tearing down the connection).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const constructorOptions: Array<Record<string, unknown>> = [];
let lastTerminal: MockTerminal | null = null;
const mockFit = vi.fn();

class MockTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  open = vi.fn();
  write = vi.fn();
  clear = vi.fn();
  dispose = vi.fn();
  loadAddon = vi.fn();
  onData = vi.fn();

  constructor(opts: Record<string, unknown>) {
    this.options = { ...opts };
    constructorOptions.push(opts);
    lastTerminal = this;
  }
}

class MockFitAddon {
  fit = mockFit;
}

class MockWebLinksAddon {}

vi.mock('xterm', () => ({ Terminal: MockTerminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: MockFitAddon }));
vi.mock('xterm-addon-web-links', () => ({ WebLinksAddon: MockWebLinksAddon }));
vi.mock('xterm/css/xterm.css', () => ({}));
vi.mock('@/lib/tmux/tmux-control-mode-flags', () => ({
  isTmuxControlModeEnabledForClient: () => false,
}));

describe('TerminalComponent fontSize (Issue #915)', () => {
  beforeEach(() => {
    constructorOptions.length = 0;
    lastTerminal = null;
    mockFit.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('passes the fontSize prop to the xterm Terminal constructor', async () => {
    const { TerminalComponent } = await import('@/components/Terminal');
    render(
      <TerminalComponent
        worktreeId="w1"
        cliToolId="claude"
        controlModeEnabled={false}
        fontSize={16}
      />
    );
    expect(constructorOptions[0]?.fontSize).toBe(16);
  });

  it('defaults to 14 when no fontSize prop is provided', async () => {
    const { TerminalComponent } = await import('@/components/Terminal');
    render(
      <TerminalComponent worktreeId="w1" cliToolId="claude" controlModeEnabled={false} />
    );
    expect(constructorOptions[0]?.fontSize).toBe(14);
  });

  it('updates the live terminal fontSize when the prop changes', async () => {
    const { TerminalComponent } = await import('@/components/Terminal');
    const { rerender } = render(
      <TerminalComponent
        worktreeId="w1"
        cliToolId="claude"
        controlModeEnabled={false}
        fontSize={16}
      />
    );
    const term = lastTerminal;
    expect(term?.options.fontSize).toBe(16);

    mockFit.mockClear();
    rerender(
      <TerminalComponent
        worktreeId="w1"
        cliToolId="claude"
        controlModeEnabled={false}
        fontSize={11}
      />
    );

    // Same instance updated in place (no reconnect/dispose).
    expect(lastTerminal).toBe(term);
    expect(term?.options.fontSize).toBe(11);
    expect(mockFit).toHaveBeenCalled();
  });
});
