/**
 * Issue #3603: the modules moved out of TerminalSplitContainer keep the
 * behavior they had inside it, and the container still exports the same names.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import * as container from '@/components/worktree/TerminalSplitContainer';
import {
  ActionBarItemsOverflow,
  clampOverflowPanelLeft,
  overflowPanelMaxWidth,
} from '@/components/worktree/terminal-split-container/ActionBarItemsOverflow';
import {
  GRID_DIVIDER_PX,
  gridColumnOf,
  gridRowOf,
  gridTemplateStyle,
} from '@/components/worktree/terminal-split-container/grid-layout';
import { ActionBarSessionSlot } from '@/components/worktree/terminal-split-container/ActionBarSessionSlot';
import { usePerSplitHandlers } from '@/components/worktree/terminal-split-container/usePerSplitHandlers';
import { MIN_GRID_ROW_PX, type TerminalSplitEntry } from '@/config/terminal-split-config';
import type { AgentInstance } from '@/lib/cli-tools/types';

describe('Issue #3603: TerminalSplitContainer re-exports the moved names', () => {
  it('re-exports the overflow panel and its helpers unchanged', () => {
    expect(container.ActionBarItemsOverflow).toBe(ActionBarItemsOverflow);
    expect(container.clampOverflowPanelLeft).toBe(clampOverflowPanelLeft);
    expect(container.overflowPanelMaxWidth).toBe(overflowPanelMaxWidth);
  });
});

describe('Issue #3603: grid-layout', () => {
  it('places panes 0/1 on the top row and 2/3 on the bottom, skipping the divider tracks', () => {
    expect([0, 1, 2, 3].map(gridColumnOf)).toEqual([1, 3, 1, 3]);
    expect([0, 1, 2, 3].map(gridRowOf)).toEqual([1, 1, 3, 3]);
  });

  it('builds the 3x3 track template, and a single cell while maximized', () => {
    expect(gridTemplateStyle(false, [1, 2], [3, 1])).toEqual({
      gridTemplateColumns: `1fr ${GRID_DIVIDER_PX}px 2fr`,
      gridTemplateRows: `minmax(${MIN_GRID_ROW_PX}px, 3fr) ${GRID_DIVIDER_PX}px minmax(${MIN_GRID_ROW_PX}px, 1fr)`,
    });
    expect(gridTemplateStyle(true, [1, 2], [3, 1])).toEqual({
      gridTemplateColumns: '1fr',
      gridTemplateRows: '1fr',
    });
  });
});

describe('Issue #3603: ActionBarSessionSlot', () => {
  it('marks the folded slot and leaves the inline one unmarked', () => {
    const { rerender } = render(<ActionBarSessionSlot slotRef={() => {}} folded={false} />);
    const slot = screen.getByTestId('split-action-bar-session');
    expect(slot.getAttribute('data-folded')).toBeNull();
    expect(slot.className).toContain('ml-1');
    rerender(<ActionBarSessionSlot slotRef={() => {}} folded />);
    expect(slot.getAttribute('data-folded')).toBe('true');
    expect(slot.className).toContain('group/bar-session');
  });
});

describe('Issue #3603: usePerSplitHandlers drop classification', () => {
  const splits: TerminalSplitEntry[] = [
    { cliToolId: 'claude', instanceId: 'claude' },
    { cliToolId: 'codex', instanceId: 'codex' },
  ];
  const instanceById = new Map<string, AgentInstance>([
    ['claude', { id: 'claude', cliTool: 'claude', alias: 'claude' } as AgentInstance],
    ['codex', { id: 'codex', cliTool: 'codex', alias: 'codex' } as AgentInstance],
    ['gemini', { id: 'gemini', cliTool: 'gemini', alias: 'gemini' } as AgentInstance],
  ]);

  function setup(applied = true) {
    const args = {
      splits,
      instanceById,
      setFocusedSplitIndex: vi.fn(),
      setSplitInstance: vi.fn(() => applied),
      toggleMaximize: vi.fn(),
      showToast: vi.fn(),
      onActiveInstanceChange: vi.fn(),
    };
    const { result } = renderHook(() => usePerSplitHandlers(args));
    return { args, handlers: result.current };
  }

  it('does nothing when the split already shows the instance', () => {
    const { args, handlers } = setup();
    handlers.dropHandlers[0]('claude');
    expect(args.setSplitInstance).not.toHaveBeenCalled();
    expect(args.showToast).not.toHaveBeenCalled();
  });

  it('rejects an instance another split uses, naming that split 1-based', () => {
    const { args, handlers } = setup();
    handlers.dropHandlers[0]('codex');
    expect(args.setSplitInstance).not.toHaveBeenCalled();
    expect(args.showToast).toHaveBeenCalledWith(expect.stringContaining('split 2'), 'warning');
  });

  it('applies an unused instance and selects the split', () => {
    const { args, handlers } = setup();
    handlers.dropHandlers[1]('gemini');
    expect(args.setSplitInstance).toHaveBeenCalledWith(1, 'gemini');
    expect(args.setFocusedSplitIndex).toHaveBeenCalledWith(1);
    expect(args.onActiveInstanceChange).toHaveBeenCalledWith('gemini');
    expect(args.showToast).toHaveBeenCalledWith(expect.stringContaining('Split 2'), 'success');
  });

  it('reports nothing when the change is not applied', () => {
    const { args, handlers } = setup(false);
    handlers.dropHandlers[1]('gemini');
    expect(args.setFocusedSplitIndex).not.toHaveBeenCalled();
    expect(args.onActiveInstanceChange).not.toHaveBeenCalled();
    expect(args.showToast).not.toHaveBeenCalled();
  });

  it('builds focus / instance / maximize handlers per split', () => {
    const { args, handlers } = setup();
    handlers.focusHandlers[1]();
    handlers.instanceChangeHandlers[0]('gemini');
    handlers.maximizeHandlers[1]();
    expect(args.setFocusedSplitIndex).toHaveBeenCalledWith(1);
    expect(args.setSplitInstance).toHaveBeenCalledWith(0, 'gemini');
    expect(args.toggleMaximize).toHaveBeenCalledWith(1);
  });
});
