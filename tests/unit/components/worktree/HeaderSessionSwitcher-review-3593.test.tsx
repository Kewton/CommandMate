/**
 * @vitest-environment jsdom
 *
 * Issue #3593, second pass (the consistency review's four P2s):
 *
 * 1. The "N more" list is capped at the room left below its trigger and
 *    scrolls inside; a row picked with the keyboard is scrolled into view —
 *    the same idea as the repository strip's lists (`resolvePopoverMaxHeight`).
 * 2. A row's tooltip (model, cost, source) is drawn above the list, not under
 *    it (the shared Tooltip's default layer is below the list's).
 * 3. "Add session…" moves focus to the trigger — the control that stays on
 *    screen — before it opens the "+" form, so closing the form lands there.
 * 4. "Add session…" is off on the same condition as the "+" (the roster is at
 *    MAX_AGENT_INSTANCES) and says why, in the "+"'s words.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { AgentAddMenu } from '@/components/worktree/AgentAddMenu';
import { Z_INDEX } from '@/config/z-index';
import { MAX_AGENT_INSTANCES, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

function roster(n: number): AgentInstance[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `claude-${i}`,
    cliTool: 'claude' as CLIToolType,
    alias: `Agent ${i}`,
    order: i,
  }));
}

const baseProps = {
  worktreeName: 'feature/3593-sessions',
  repositoryName: 'CommandMate',
  status: 'running' as const,
  onInfoClick: vi.fn(),
};

const trigger = () => screen.getByTestId('desktop-agent-status-overflow');
const list = () => screen.getByTestId('desktop-session-others-list');

const plusSlot = (
  <button type="button" data-testid="slot-plus">
    +
  </button>
);

const originalInnerHeight = window.innerHeight;
const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalRect = HTMLElement.prototype.getBoundingClientRect;

function setViewportHeight(height: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

/** The trigger sits in a 44px header: its bottom edge is at 40px. */
function placeTrigger(): void {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.getAttribute('data-testid') === 'desktop-agent-status-overflow') {
      return { top: 12, bottom: 40, left: 600, right: 720, width: 120, height: 28, x: 600, y: 12, toJSON() {} } as DOMRect;
    }
    return originalRect.call(this);
  };
}

let scrolled: Element[];

beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
  placeTrigger();
});

afterEach(() => {
  setViewportHeight(originalInnerHeight);
  Element.prototype.scrollIntoView = originalScrollIntoView;
  HTMLElement.prototype.getBoundingClientRect = originalRect;
});

describe('[#3593 P2-1] the list fits the room below its trigger and scrolls', () => {
  it('a short screen caps the list at the room left and lets it scroll', () => {
    setViewportHeight(300);
    render(<DesktopHeader {...baseProps} instances={roster(10)} activeInstanceId="claude-0" agentAddControl={plusSlot} />);
    fireEvent.click(trigger());
    // 300 - (40 + 4 gap) - 8 margin
    expect(list().style.maxHeight).toBe('248px');
    expect(list().className).toContain('overflow-y-auto');
  });

  it('negative control: a tall screen leaves the list at its own height (no cap below the room)', () => {
    setViewportHeight(2000);
    render(<DesktopHeader {...baseProps} instances={roster(3)} activeInstanceId="claude-0" agentAddControl={plusSlot} />);
    fireEvent.click(trigger());
    // No cap at all, or one no lower than the 1948px left below the trigger.
    const cap = list().style.maxHeight === '' ? Infinity : parseFloat(list().style.maxHeight);
    expect(cap).toBeGreaterThanOrEqual(1948);
  });

  it('a row reached with the keyboard is scrolled into view — the last row and "Add session…" too', () => {
    setViewportHeight(300);
    // 9: one under the limit, so "Add session…" is on and can take focus.
    render(<DesktopHeader {...baseProps} instances={roster(9)} activeInstanceId="claude-0" agentAddControl={plusSlot} />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    const add = screen.getByTestId('desktop-session-add');
    expect(document.activeElement).toBe(add);
    expect(scrolled).toContain(add);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    const last = screen.getByTestId('desktop-agent-status-claude-8');
    expect(document.activeElement).toBe(last);
    expect(scrolled[scrolled.length - 1]).toBe(last);

    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(scrolled[scrolled.length - 1]).toBe(screen.getByTestId('desktop-agent-status-claude-1'));
  });
});

describe('[#3593 P2-2] a row tooltip is above the list', () => {
  it('the tooltip of a row in the open list is layered over the list', () => {
    render(<DesktopHeader {...baseProps} instances={roster(4)} activeInstanceId="claude-0" />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    const bubble = screen.getByRole('tooltip', { hidden: true });
    expect(bubble.textContent).toContain('Agent 1');
    expect(Number(bubble.style.zIndex)).toBeGreaterThan(Z_INDEX.POPOVER);
    expect(Number(list().style.zIndex)).toBe(Z_INDEX.POPOVER);
  });
});

describe('[#3593 P2-3] "Add session…" → form → cancel lands on the trigger', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ installed: ['claude'] }) }),
    ) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('with the keyboard: Add session, then Cancel, returns focus to "N more"', async () => {
    const instances = roster(3);
    render(
      <DesktopHeader
        {...baseProps}
        instances={instances}
        activeInstanceId="claude-0"
        agentAddControl={
          <AgentAddMenu worktreeId="w-3593" instances={instances} splitCount={1} onInstancesChange={vi.fn()} />
        }
      />,
    );
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    const add = screen.getByTestId('desktop-session-add');
    expect(document.activeElement).toBe(add);
    fireEvent.click(add);

    const form = await screen.findByTestId('agent-add-form');
    await waitFor(() => expect(form.contains(document.activeElement) || document.activeElement?.contains(form)).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByTestId('agent-add-form')).toBeNull());
    expect(document.activeElement).toBe(trigger());
    expect(list()).not.toBeVisible();
  });
});

describe('[#3593 P2-4] "Add session…" follows the "+" limit', () => {
  it(`at ${MAX_AGENT_INSTANCES} sessions the row is off and says why, as the "+" does`, () => {
    render(
      <DesktopHeader
        {...baseProps}
        instances={roster(MAX_AGENT_INSTANCES)}
        activeInstanceId="claude-0"
        agentAddControl={plusSlot}
      />,
    );
    fireEvent.click(trigger());
    const add = screen.getByTestId('desktop-session-add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    const reason = screen.getByTestId('desktop-session-add-limit');
    expect(reason.textContent).toBe(`Up to ${MAX_AGENT_INSTANCES} agents per branch`);
    expect(add.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it(`negative control: with ${MAX_AGENT_INSTANCES - 1} sessions the row is on, with no reason`, () => {
    render(
      <DesktopHeader
        {...baseProps}
        instances={roster(MAX_AGENT_INSTANCES - 1)}
        activeInstanceId="claude-0"
        agentAddControl={plusSlot}
      />,
    );
    fireEvent.click(trigger());
    const add = screen.getByTestId('desktop-session-add') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    expect(screen.queryByTestId('desktop-session-add-limit')).toBeNull();
    expect(add.hasAttribute('aria-describedby')).toBe(false);
  });
});
