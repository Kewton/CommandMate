/**
 * Issue #3631: the agent's name in a split's 30px title bar (two or more
 * splits) has a floor — min(48px, the name's own width). The action bar (one
 * split) keeps #3615's rule.
 *
 * jsdom has no layout, so the name's width is stubbed through `scrollWidth`;
 * the real widths are measured by tests/e2e/split-title-bar-name-width-3631.spec.ts.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { SplitHeaderSlotsProvider } from '@/components/worktree/SplitPaneHeaderControls';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');

/** Every element reports `width` as its scrollWidth. */
function stubScrollWidth(width: number): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get: () => width,
  });
}

afterEach(() => {
  if (originalScrollWidth) {
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
  }
  document.body.innerHTML = '';
});

function inst(cliTool: CLIToolType, alias: string): AgentInstance {
  return { id: cliTool, cliTool, alias, order: 0 };
}

function paneProps(
  overrides: Partial<React.ComponentProps<typeof TerminalSplitPane>> = {},
): React.ComponentProps<typeof TerminalSplitPane> {
  return {
    worktreeId: 'w-3631',
    splitIndex: 0,
    cliToolId: 'claude',
    instanceId: 'claude',
    instance: inst('claude', 'OpenCode reviewer'),
    availableInstances: [inst('claude', 'OpenCode reviewer')],
    onInstanceChange: vi.fn(),
    onFocus: vi.fn(),
    terminal: <div>term</div>,
    footer: <div>footer</div>,
    ...overrides,
  };
}

function nameLabel(): HTMLElement {
  return screen.getByTestId('cli-selector-0').querySelector('span.truncate') as HTMLElement;
}

describe('[#3631] the title bar keeps the agent name readable', () => {
  it('floors a long name at 48px', () => {
    stubScrollWidth(120);
    render(<TerminalSplitPane {...paneProps()} />);
    expect(screen.getByTestId('split-header-0')).toBeInTheDocument();
    expect(nameLabel().style.minWidth).toBe('48px');
    const selector = screen.getByTestId('cli-selector-0');
    // The trigger keeps its automatic minimum so the floor is its own.
    expect(selector.className.split(/\s+/)).not.toContain('min-w-0');
  });

  it('never pads a short name: the floor is the name\'s own width (negative control)', () => {
    stubScrollWidth(30);
    render(<TerminalSplitPane {...paneProps({ instance: inst('claude', 'Cx'), availableInstances: [inst('claude', 'Cx')] })} />);
    expect(nameLabel().style.minWidth).toBe('30px');
  });

  it('re-measures when the name changes', () => {
    stubScrollWidth(120);
    const { rerender } = render(<TerminalSplitPane {...paneProps()} />);
    expect(nameLabel().style.minWidth).toBe('48px');
    stubScrollWidth(20);
    rerender(
      <TerminalSplitPane {...paneProps({ instance: inst('claude', 'C2'), availableInstances: [inst('claude', 'C2')] })} />,
    );
    expect(nameLabel().style.minWidth).toBe('20px');
  });

  it('leaves the action bar as #3615 made it: no floor, min-w-0 (negative control)', () => {
    stubScrollWidth(120);
    const session = document.createElement('div');
    const actions = document.createElement('div');
    document.body.append(session, actions);
    render(
      <SplitHeaderSlotsProvider value={{ session, actions }}>
        <TerminalSplitPane {...paneProps()} />
      </SplitHeaderSlotsProvider>,
    );
    expect(screen.queryByTestId('split-header-0')).toBeNull();
    const selector = screen.getByTestId('cli-selector-0');
    expect(session.contains(selector)).toBe(true);
    expect(nameLabel().style.minWidth).toBe('');
    expect(selector.className.split(/\s+/)).toContain('min-w-0');
  });
});
