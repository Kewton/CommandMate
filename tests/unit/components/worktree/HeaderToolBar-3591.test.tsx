/**
 * @vitest-environment jsdom
 *
 * Issue #3591: the worktree's tools at the right of the PC header
 * (`HeaderToolBar`), replacing the vertical ActivityBar column.
 *
 * - Same tools in the same order as the bar, minus Verification (its entry is
 *   the second row's chip).
 * - A horizontal tablist: ←/→ (wrapping) and Home/End move, Enter/Space
 *   open/close, a roving tabindex so Tab enters and leaves in one step. The
 *   bar's ↑/↓ are gone (negative control: they move nothing now).
 * - On a narrow header the trailing tools fold behind "…": its list is
 *   reachable from the keyboard, picks a tool, and "…" is marked while the
 *   open tool is folded.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HeaderToolBar } from '@/components/worktree/HeaderToolBar';
import { ActionBarItemsOverflow } from '@/components/worktree/TerminalSplitContainer';
import { VerificationStatusChip } from '@/components/worktree/VerificationStatusChip';
import { ACTIVITIES, HEADER_TOOLS, type ActivityId } from '@/config/activity-bar-config';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const TOOL_IDS = HEADER_TOOLS.map((tool) => tool.id);

function rowTools(): HTMLElement[] {
  return TOOL_IDS.map((id) => screen.queryByTestId(`header-tool-${id}`)).filter(
    (el): el is HTMLElement => el !== null
  );
}

function renderBar(active: ActivityId | null = null, foldedCount = 0) {
  const onToggle = vi.fn();
  const utils = render(<HeaderToolBar active={active} onToggle={onToggle} foldedCount={foldedCount} />);
  return { ...utils, onToggle };
}

describe('HeaderToolBar — the tools (Issue #3591)', () => {
  it('draws every activity but Verification, in ACTIVITIES order', () => {
    renderBar();
    expect(TOOL_IDS).toEqual(ACTIVITIES.map((a) => a.id).filter((id) => id !== 'verification'));
    expect(TOOL_IDS).toHaveLength(9);
    expect(rowTools().map((el) => el.getAttribute('data-testid'))).toEqual(
      TOOL_IDS.map((id) => `header-tool-${id}`)
    );
    expect(screen.queryByTestId('header-tool-verification')).toBeNull();
    expect(screen.queryByTestId('header-tool-more')).toBeNull();
  });

  it('is a horizontal tablist of tabs controlling the activity pane', () => {
    renderBar('git');
    const list = screen.getByRole('tablist');
    expect(list).toHaveAttribute('aria-orientation', 'horizontal');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(9);
    for (const tab of tabs) expect(tab).toHaveAttribute('aria-controls', 'worktree-activity-pane');
    expect(screen.getByTestId('header-tool-git')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('header-tool-files')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('header-tool-git')).toHaveAttribute('aria-label', 'Git');
  });

  it('toggles the clicked tool (re-clicking the open one is the parent toggle)', () => {
    const { onToggle } = renderBar('files');
    fireEvent.click(screen.getByTestId('header-tool-notes'));
    fireEvent.click(screen.getByTestId('header-tool-files'));
    expect(onToggle.mock.calls).toEqual([['notes'], ['files']]);
  });

  it('marks each visible tool as the entry point of its activity', () => {
    renderBar();
    for (const id of TOOL_IDS) {
      expect(screen.getByTestId(`header-tool-${id}`)).toHaveAttribute('data-activity-entry', id);
    }
  });
});

describe('HeaderToolBar — keyboard (Issue #3591)', () => {
  it('keeps one tab stop: the open tool, else the first', () => {
    const { rerender } = renderBar(null);
    expect(rowTools().filter((el) => el.tabIndex === 0).map((el) => el.dataset.testid)).toEqual([
      'header-tool-files',
    ]);
    rerender(<HeaderToolBar active="timer" onToggle={vi.fn()} />);
    expect(rowTools().filter((el) => el.tabIndex === 0).map((el) => el.dataset.testid)).toEqual([
      'header-tool-timer',
    ]);
  });

  it('moves with ←/→ (wrapping) and jumps with Home/End', () => {
    renderBar();
    const first = screen.getByTestId('header-tool-files');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByTestId('header-tool-git'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByTestId('header-tool-env'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('header-tool-env'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(first);
  });

  it('no longer moves with ↑/↓ (the vertical bar keys)', () => {
    renderBar();
    const first = screen.getByTestId('header-tool-files');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });

  it('opens/closes the focused tool with Enter and Space', () => {
    const { onToggle } = renderBar();
    const skills = screen.getByTestId('header-tool-skills');
    fireEvent.keyDown(skills, { key: 'Enter' });
    fireEvent.keyDown(skills, { key: ' ' });
    expect(onToggle.mock.calls).toEqual([['skills'], ['skills']]);
  });
});

describe('HeaderToolBar — tools folded behind "…" (Issue #3591)', () => {
  it('folds the last N tools behind "…", keeping the rest in order', () => {
    renderBar(null, 3);
    expect(rowTools().map((el) => el.dataset.testid)).toEqual(
      TOOL_IDS.slice(0, 6).map((id) => `header-tool-${id}`)
    );
    const more = screen.getByTestId('header-tool-more');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveAttribute('data-active', 'false');
    expect(screen.queryByTestId('header-tool-more-active-mark')).toBeNull();
    expect(more).toHaveAttribute('aria-label', 'More tools');
  });

  it('clamps the fold to the number of tools', () => {
    renderBar(null, 99);
    expect(rowTools()).toHaveLength(0);
    expect(screen.getByTestId('header-tool-more')).toBeInTheDocument();
  });

  it('marks "…" when the open tool is folded and makes it the tab stop', () => {
    renderBar('env', 2);
    const more = screen.getByTestId('header-tool-more');
    expect(more).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('header-tool-more-active-mark')).toBeInTheDocument();
    expect(more).toHaveAttribute('aria-label', 'More tools (Env is open)');
    expect(more.tabIndex).toBe(0);
    expect(rowTools().every((el) => el.tabIndex === -1)).toBe(true);
  });

  it('reaches "…" with ←/→ and End like any tool', () => {
    renderBar(null, 3);
    const first = screen.getByTestId('header-tool-files');
    first.focus();
    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('header-tool-more'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByTestId('header-tool-more'));
  });

  it('opens the list from the keyboard, focuses its first tool, and every item is a Tab stop', () => {
    renderBar(null, 3);
    const more = screen.getByTestId('header-tool-more');
    more.focus();
    fireEvent.keyDown(more, { key: 'Enter' });
    const list = screen.getByTestId('header-tool-more-list');
    expect(list).toHaveAttribute('role', 'tablist');
    expect(list).toHaveAttribute('aria-orientation', 'vertical');
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const items = TOOL_IDS.slice(6).map((id) => screen.getByTestId(`header-tool-more-item-${id}`));
    expect(document.activeElement).toBe(items[0]);
    // Tab moves through them (none is taken out of the tab order).
    for (const item of items) expect(item.tabIndex).toBe(0);
    // DOM order: right after "…", so Tab from "…" lands in the list.
    expect(more.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('focuses the open tool when the list opens on it', () => {
    renderBar('skills', 3);
    fireEvent.click(screen.getByTestId('header-tool-more'));
    expect(document.activeElement).toBe(screen.getByTestId('header-tool-more-item-skills'));
    expect(screen.getByTestId('header-tool-more-item-skills')).toHaveAttribute('aria-selected', 'true');
  });

  it('picks a folded tool with Enter, closes the list and hands focus back to "…"', () => {
    const { onToggle } = renderBar(null, 3);
    const more = screen.getByTestId('header-tool-more');
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByTestId('header-tool-more-item-env'), { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledWith('env');
    expect(screen.queryByTestId('header-tool-more-list')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('picks a folded tool with a click', () => {
    const { onToggle } = renderBar(null, 3);
    fireEvent.click(screen.getByTestId('header-tool-more'));
    fireEvent.click(screen.getByTestId('header-tool-more-item-skills'));
    expect(onToggle).toHaveBeenCalledWith('skills');
    expect(screen.queryByTestId('header-tool-more-list')).toBeNull();
  });

  it('closes the list on Esc as its own key (handled, so the pane does not close too)', () => {
    renderBar('files', 3);
    const more = screen.getByTestId('header-tool-more');
    fireEvent.click(more);
    const item = screen.getByTestId('header-tool-more-item-todo');
    const notPrevented = fireEvent.keyDown(item, { key: 'Escape' });
    expect(notPrevented).toBe(false);
    expect(screen.queryByTestId('header-tool-more-list')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('closes the list on a press outside the bar, and while open marks itself a floating layer', () => {
    renderBar(null, 3);
    fireEvent.click(screen.getByTestId('header-tool-more'));
    expect(screen.getByTestId('header-tool-more-list')).toHaveAttribute('data-floating-layer', 'open');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('header-tool-more-list')).toBeNull();
  });

  it('drops the list when nothing is folded any more', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<HeaderToolBar active={null} onToggle={onToggle} foldedCount={2} />);
    fireEvent.click(screen.getByTestId('header-tool-more'));
    rerender(<HeaderToolBar active={null} onToggle={onToggle} foldedCount={0} />);
    expect(screen.queryByTestId('header-tool-more')).toBeNull();
    expect(screen.queryByTestId('header-tool-more-list')).toBeNull();
    expect(rowTools()).toHaveLength(9);
  });
});

describe('HeaderToolBar — Esc beside the second row "…" (Issue #3591)', () => {
  function renderBoth() {
    render(
      <>
        <HeaderToolBar active={null} onToggle={vi.fn()} foldedCount={3} />
        <ActionBarItemsOverflow label="More">
          <button type="button" data-testid="folded-chip">chip</button>
        </ActionBarItemsOverflow>
      </>
    );
    // The second row's panel first (a click), then the header's list from the
    // keyboard — a press would have closed the other one.
    fireEvent.click(screen.getByTestId('split-action-bar-items-overflow'));
    expect(screen.getByTestId('split-action-bar-items-panel')).toBeInTheDocument();
  }

  it('closes only the header list on Esc in it, and focus goes to the header "…"', () => {
    renderBoth();
    const more = screen.getByTestId('header-tool-more');
    more.focus();
    fireEvent.keyDown(more, { key: 'Enter' });
    const item = screen.getByTestId('header-tool-more-item-todo');
    expect(document.activeElement).toBe(item);

    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByTestId('header-tool-more-list')).toBeNull();
    expect(screen.getByTestId('split-action-bar-items-panel')).toBeInTheDocument();
    expect(document.activeElement).toBe(more);
  });

  it('still closes the second row panel on an Esc nobody handled (negative control)', () => {
    renderBoth();
    const chip = screen.getByTestId('folded-chip');
    chip.focus();
    fireEvent.keyDown(chip, { key: 'Escape' });
    expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('split-action-bar-items-overflow'));
  });
});

describe('HeaderToolBar — Esc beside the chip reason popover (Issue #3591)', () => {
  function renderWithReason() {
    render(
      <>
        <HeaderToolBar active={null} onToggle={vi.fn()} foldedCount={3} />
        <VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} />
      </>
    );
    fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
    expect(screen.getByTestId('verification-chip-reason-popover')).toBeInTheDocument();
  }

  it('keeps the reason open when Esc closes the header list', () => {
    renderWithReason();
    const more = screen.getByTestId('header-tool-more');
    more.focus();
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.keyDown(screen.getByTestId('header-tool-more-item-todo'), { key: 'Escape' });
    expect(screen.queryByTestId('header-tool-more-list')).toBeNull();
    expect(screen.getByTestId('verification-chip-reason-popover')).toBeInTheDocument();
    expect(document.activeElement).toBe(more);
  });

  it('still closes the reason on an Esc nobody handled (negative control)', () => {
    renderWithReason();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('verification-chip-reason-popover')).toBeNull();
  });
});
