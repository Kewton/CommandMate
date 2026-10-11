/**
 * @vitest-environment jsdom
 *
 * Issue #3593: the desktop header's session field is [current session]
 * [N others ▾][+].
 *
 * - The current session is the active instance — which the worktree screen
 *   keeps equal to the selected split's (see the seam test in
 *   `WorktreeDetailRefactored-selected-split-3593.test.tsx`).
 * - The others are a list: waiting-for-an-answer first, an amber count on the
 *   trigger, the split each one is in, the same tooltip as the pills had.
 * - The list is built for drag and drop: it ignores the pointer during a drag
 *   so a split it covers still gets the drop, nothing closes it mid-drag, the
 *   dragged row survives a re-order until `dragend`, and `dragend` closes it
 *   and hands focus back to the trigger.
 * - Keyboard: open, move, select, close.
 *
 * jsdom has no layout, so the "same width" promise is pinned here on the
 * classes (fixed widths, a reserved box for the trigger) and measured for real
 * in `tests/e2e/header-session-switcher-3593.spec.ts`.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { AGENT_INSTANCE_DND_MIME } from '@/components/worktree/TerminalSplitPane';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

type InstanceStatusMap = NonNullable<Worktree['sessionStatusByInstance']>;

const idle = { isRunning: false, isWaitingForResponse: false, isProcessing: false };
const running = { isRunning: true, isWaitingForResponse: false, isProcessing: true };
const waiting = { isRunning: true, isWaitingForResponse: true, isProcessing: false };

function roster(n: number, alias = (i: number) => `Agent ${i}`): AgentInstance[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `claude-${i}`,
    cliTool: 'claude' as CLIToolType,
    alias: alias(i),
    order: i,
  }));
}

const baseProps = {
  worktreeName: 'feature/3593-sessions',
  repositoryName: 'CommandMate',
  status: 'running' as const,
  onInfoClick: vi.fn(),
};

function renderHeader(
  props: Partial<React.ComponentProps<typeof DesktopHeader>> & { instances: AgentInstance[] }
) {
  return render(<DesktopHeader {...baseProps} {...props} />);
}

const trigger = () => screen.getByTestId('desktop-agent-status-overflow');
const list = () => screen.getByTestId('desktop-session-others-list');
const rowIds = () =>
  Array.from(list().querySelectorAll('[data-testid^="desktop-agent-status-"]')).map(
    (el) => el.getAttribute('data-testid')
  );

/** A DataTransfer stand-in (jsdom has none). */
function dataTransfer() {
  const data: Record<string, string> = {};
  return {
    setData: vi.fn((type: string, value: string) => {
      data[type] = value;
    }),
    getData: (type: string) => data[type] ?? '',
    effectAllowed: 'none',
    dropEffect: 'none',
    data,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[#3593] the session field: current + others', () => {
  it('draws the active instance as the one labelled pill, and lists every other', () => {
    renderHeader({ instances: roster(4), activeInstanceId: 'claude-2' });
    const current = document.querySelector('[data-session-current]');
    expect(current?.getAttribute('data-testid')).toBe('desktop-agent-status-claude-2');
    expect(current?.textContent).toBe('Agent 2: Idle');
    expect(rowIds()).toEqual([
      'desktop-agent-status-claude-0',
      'desktop-agent-status-claude-1',
      'desktop-agent-status-claude-3',
    ]);
    expect(trigger().textContent).toContain('3 more');
  });

  it('lists the sessions waiting for an answer first, and counts them in amber', () => {
    renderHeader({
      instances: roster(5),
      activeInstanceId: 'claude-0',
      sessionStatusByInstance: {
        'claude-1': running,
        'claude-3': waiting,
        'claude-4': waiting,
      } as InstanceStatusMap,
    });
    expect(rowIds()).toEqual([
      'desktop-agent-status-claude-3',
      'desktop-agent-status-claude-4',
      'desktop-agent-status-claude-1',
      'desktop-agent-status-claude-2',
    ]);
    const count = screen.getByTestId('desktop-session-others-waiting');
    expect(count.textContent).toBe('2');
    expect(count.className).toContain('bg-warning');
    expect(trigger().getAttribute('aria-label')).toBe(
      '4 other sessions, 2 waiting for your answer'
    );
  });

  it('negative control: no waiting session → the amber box stays, empty and invisible', () => {
    renderHeader({ instances: roster(3), activeInstanceId: 'claude-0' });
    const count = screen.getByTestId('desktop-session-others-waiting');
    expect(count.textContent).toBe('');
    expect(count.className).toContain('invisible');
    expect(trigger().getAttribute('aria-label')).toBe('2 other sessions');
  });

  it('a row shows the dot, the name, the status and the split it is in', () => {
    renderHeader({
      instances: roster(3),
      activeInstanceId: 'claude-0',
      sessionStatusByInstance: { 'claude-1': running } as InstanceStatusMap,
      splitInstanceIds: ['claude-0', 'claude-1'],
    });
    const row = screen.getByTestId('desktop-agent-status-claude-1');
    expect(row.querySelector('span.rounded-full')?.className).toContain('animate-status-glow');
    expect(row.textContent).toContain('Agent 1');
    expect(row.textContent).toContain('Running');
    expect(screen.getByTestId('desktop-session-split-claude-1').textContent).toBe('Split 2');
    // Not shown in any split → no split label.
    expect(screen.queryByTestId('desktop-session-split-claude-2')).toBeNull();
  });

  it('keeps the model / cost / source tooltip on the pill and on the rows', () => {
    renderHeader({
      instances: roster(2),
      activeInstanceId: 'claude-0',
      sessionStatusByInstance: {
        'claude-0': { ...running, model: 'claude-opus-4-7' },
        'claude-1': { ...idle, model: 'claude-sonnet-4-6' },
      } as InstanceStatusMap,
    });
    const pill = screen.getByTestId('desktop-agent-status-claude-0');
    expect(pill.getAttribute('title')).toContain('claude-opus-4-7');
    expect(pill.textContent).not.toContain('claude-opus-4-7');
    const row = screen.getByTestId('desktop-agent-status-claude-1');
    expect(row.getAttribute('aria-label')).toContain('claude-sonnet-4-6');
    expect(row.closest('[data-testid="tooltip-wrapper"]')).not.toBeNull();
  });

  it('shows the awaiting-instruction badge beside the current session, on the old condition', () => {
    renderHeader({
      instances: roster(3),
      activeInstanceId: 'claude-0',
      sessionStatusByInstance: { 'claude-2': { ...idle, isRunning: true, awaitingInstruction: true } } as InstanceStatusMap,
    });
    const badge = screen.getByTestId('desktop-awaiting-instruction-badge');
    const switcher = screen.getByTestId('desktop-session-switcher');
    expect(badge.nextElementSibling).toBe(switcher);
    expect(switcher.contains(badge)).toBe(false);
  });

  it('with no other session: no trigger, but its box keeps the width', () => {
    renderHeader({ instances: roster(1), activeInstanceId: 'claude-0' });
    expect(screen.queryByTestId('desktop-agent-status-overflow')).toBeNull();
    const placeholder = screen.getByTestId('desktop-session-others-placeholder');
    expect(placeholder.className).toMatch(/\bw-\[7\.5rem\]/);
  });

  it('fixes the widths: the pill truncates, the trigger is the same box for 1, 7 and 10', () => {
    const longAlias = (i: number) => `a very long alias for the session number ${i}`;
    for (const n of [1, 7, 10]) {
      const { unmount } = renderHeader({ instances: roster(n, longAlias), activeInstanceId: 'claude-0' });
      const pill = screen.getByTestId('desktop-agent-status-claude-0');
      expect(pill.className).toMatch(/\bw-44\b/);
      expect(pill.className).toMatch(/\bflex-shrink-0\b/);
      expect(pill.querySelector('span:not(.rounded-full)')?.className).toMatch(/\btruncate\b/);
      const box = n === 1 ? screen.getByTestId('desktop-session-others-placeholder') : trigger();
      expect(box.className).toMatch(/\bw-\[7\.5rem\]/);
      expect(box.className).toMatch(/\bflex-shrink-0\b/);
      unmount();
    }
  });
});

describe('[#3593] picking a row', () => {
  it('clicking a row selects it, closes the list and returns focus to the trigger', () => {
    const onActiveInstanceChange = vi.fn();
    renderHeader({ instances: roster(3), activeInstanceId: 'claude-0', onActiveInstanceChange });
    fireEvent.click(trigger());
    expect(list()).toBeVisible();
    fireEvent.click(screen.getByTestId('desktop-agent-status-claude-2'));
    expect(onActiveInstanceChange).toHaveBeenCalledWith('claude-2');
    expect(list()).not.toBeVisible();
    expect(document.activeElement).toBe(trigger());
  });

  it('focus leaving the list closes it', () => {
    renderHeader({ instances: roster(3), activeInstanceId: 'claude-0' });
    fireEvent.click(trigger());
    fireEvent.focusOut(screen.getByTestId('desktop-agent-status-claude-1'), { relatedTarget: document.body });
    expect(list()).not.toBeVisible();
  });

  it('pressing outside closes the list', () => {
    renderHeader({ instances: roster(3), activeInstanceId: 'claude-0' });
    fireEvent.click(trigger());
    expect(list()).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(list()).not.toBeVisible();
  });

  it('"Add session…" opens the "+" form', () => {
    const onPlus = vi.fn();
    renderHeader({
      instances: roster(2),
      activeInstanceId: 'claude-0',
      agentAddControl: (
        <button type="button" data-testid="slot-plus" onClick={onPlus}>
          +
        </button>
      ),
    });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId('desktop-session-add'));
    expect(onPlus).toHaveBeenCalledTimes(1);
    expect(list()).not.toBeVisible();
  });

  it('negative control: without the "+" there is no "Add session…"', () => {
    renderHeader({ instances: roster(2), activeInstanceId: 'claude-0' });
    expect(screen.queryByTestId('desktop-session-add')).toBeNull();
  });
});

describe('[#3593] keyboard only', () => {
  it('opens on ArrowDown, moves, selects with Enter-click, and Escape closes back to the trigger', () => {
    const onActiveInstanceChange = vi.fn();
    renderHeader({ instances: roster(4), activeInstanceId: 'claude-0', onActiveInstanceChange });
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(list()).toBeVisible();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('desktop-agent-status-claude-1'));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('desktop-agent-status-claude-2'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('desktop-agent-status-claude-3'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('desktop-agent-status-claude-1'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('desktop-agent-status-claude-3'));

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(list()).not.toBeVisible();
    expect(document.activeElement).toBe(trigger());
    expect(onActiveInstanceChange).not.toHaveBeenCalled();

    // ArrowUp opens on the last row; a button's Enter is its click.
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('desktop-agent-status-claude-3'));
    fireEvent.click(document.activeElement!);
    expect(onActiveInstanceChange).toHaveBeenCalledWith('claude-3');
    expect(document.activeElement).toBe(trigger());
  });

  it('Enter / Space on the trigger (its click) opens the list on the first row', () => {
    renderHeader({ instances: roster(3), activeInstanceId: 'claude-0' });
    fireEvent.click(trigger());
    expect(document.activeElement).toBe(screen.getByTestId('desktop-agent-status-claude-1'));
  });
});

describe('[#3593] dragging a row onto a split', () => {
  it('sets the shared payload and publishes the dragged id', () => {
    const onAgentDragStart = vi.fn();
    renderHeader({ instances: roster(3), activeInstanceId: 'claude-0', onAgentDragStart });
    fireEvent.click(trigger());
    const dt = dataTransfer();
    fireEvent.dragStart(screen.getByTestId('desktop-agent-status-claude-2'), { dataTransfer: dt });
    expect(dt.data[AGENT_INSTANCE_DND_MIME]).toBe('claude-2');
    expect(onAgentDragStart).toHaveBeenCalledWith('claude-2');
  });

  it('takes the list out of hit testing while dragging, and nothing outside closes it', async () => {
    renderHeader({ instances: roster(3), activeInstanceId: 'claude-0' });
    fireEvent.click(trigger());
    fireEvent.dragStart(screen.getByTestId('desktop-agent-status-claude-1'), {
      dataTransfer: dataTransfer(),
    });
    // Not during `dragstart` itself: Chrome cancels a drag whose source stops
    // taking the pointer while the event is dispatched.
    expect(list().className).not.toContain('pointer-events-none');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(list().className).toContain('pointer-events-none');
    expect(list().className).toContain('opacity-40');
    expect(list()).toHaveAttribute('data-dragging', 'true');
    // A press outside (the split under the list) or focus moving away does
    // not close it while the drag runs.
    fireEvent.pointerDown(document.body);
    fireEvent.focusOut(screen.getByTestId('desktop-agent-status-claude-1'), { relatedTarget: document.body });
    expect(list()).toBeVisible();
  });

  it('negative control: without a drag the list takes the pointer', () => {
    renderHeader({ instances: roster(3), activeInstanceId: 'claude-0' });
    fireEvent.click(trigger());
    expect(list().className).not.toContain('pointer-events-none');
    expect(list()).not.toHaveAttribute('data-dragging');
  });

  it('keeps the dragged row until dragend, even when the drop makes it the current one', () => {
    const onAgentDragEnd = vi.fn();
    const instances = roster(3);
    const { rerender } = renderHeader({ instances, activeInstanceId: 'claude-0', onAgentDragEnd });
    fireEvent.click(trigger());
    const row = screen.getByTestId('desktop-agent-status-claude-2');
    fireEvent.dragStart(row, { dataTransfer: dataTransfer() });

    // The drop lands: the split now shows claude-2, which becomes current.
    rerender(
      <DesktopHeader {...baseProps} instances={instances} activeInstanceId="claude-2" onAgentDragEnd={onAgentDragEnd} />
    );
    expect(list().contains(row)).toBe(true);
    expect(row.isConnected).toBe(true);

    act(() => {
      fireEvent.dragEnd(row);
    });
    expect(onAgentDragEnd).toHaveBeenCalledTimes(1);
    expect(list()).not.toBeVisible();
    expect(list().className).not.toContain('pointer-events-none');
    expect(document.activeElement).toBe(trigger());
    // After dragend the list is rebuilt from the new current session.
    expect(rowIds()).toEqual(['desktop-agent-status-claude-0', 'desktop-agent-status-claude-1']);
  });

  it('a cancelled drag (Esc → dragend without a drop) also closes and returns focus', () => {
    renderHeader({ instances: roster(3), activeInstanceId: 'claude-0' });
    fireEvent.click(trigger());
    const row = screen.getByTestId('desktop-agent-status-claude-1');
    fireEvent.dragStart(row, { dataTransfer: dataTransfer() });
    fireEvent.dragEnd(row, { dataTransfer: { ...dataTransfer(), dropEffect: 'none' } });
    expect(list()).not.toBeVisible();
    expect(document.activeElement).toBe(trigger());
  });
});
