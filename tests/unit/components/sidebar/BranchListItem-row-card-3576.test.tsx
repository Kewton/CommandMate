/**
 * BranchListItem as an inset, rounded card (Issue #3576, UAT S6 of Epic #3508).
 *
 *   - The row is a card inset 8px from both sidebar edges, rounded, with a
 *     light fill on hover and a stronger fill when selected. No left accent bar.
 *   - The status dot is 8px; the #3509 states stay distinct.
 *   - "…" (row actions) is shown on the hovered row and on the selected row;
 *     on a touch screen (`hover: none`) the selected row always shows it.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { BranchListItem, __resetMouseEnterSuppression } from '@/components/sidebar/BranchListItem';
import type { SidebarBranchItem } from '@/types/sidebar';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const base: SidebarBranchItem = {
  id: 'wt-1',
  name: 'feature/card',
  repositoryName: 'Repo',
  status: 'idle',
  hasUnread: false,
  cliStatus: { claude: 'idle' },
  worktreePath: '/repos/app/wt-1',
};

function renderRow(props: Partial<React.ComponentProps<typeof BranchListItem>> = {}) {
  const onClick = vi.fn();
  render(<BranchListItem branch={base} isSelected={false} onClick={onClick} {...props} />);
  return { onClick, row: screen.getByTestId('branch-list-row'), item: screen.getByTestId('branch-list-item') };
}

/** Open a Radix DropdownMenu trigger the way a keyboard user does. */
function openMenu(trigger: HTMLElement): HTMLElement {
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menu');
}

const originalClipboard = navigator.clipboard;

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  __resetMouseEnterSuppression();
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  vi.restoreAllMocks();
});

describe('row card (Issue #3576)', () => {
  it('is inset from both edges and rounded', () => {
    const { row, item } = renderRow();
    expect(row.className).toMatch(/(^|\s)px-2(\s|$)/);
    expect(item.className).toMatch(/rounded-\[10px\]/);
  });

  it('marks the selected row with a stronger fill, not a left accent bar', () => {
    const { item } = renderRow({ isSelected: true });
    expect(item.className).toMatch(/(^|\s)bg-sidebar-border(\s|$)/);
    expect(item.className).not.toMatch(/border-l-2|border-accent-500/);
  });

  it('gives an unselected row only the light hover fill (negative control)', () => {
    const { item } = renderRow();
    expect(item.className).toMatch(/hover:bg-sidebar-hover/);
    expect(item.className).not.toMatch(/(^|\s)bg-sidebar-border(\s|$)/);
    expect(item.className).not.toMatch(/border-l-2/);
  });

  it('shows a focus ring for keyboard focus, distinct from both fills', () => {
    const { item } = renderRow();
    expect(item.className).toMatch(/focus-visible:ring-2/);
    expect(item.className).toMatch(/focus-visible:ring-ring/);
  });

  it('keeps the selected row second line inside the filled card', () => {
    renderRow({
      isSelected: true,
      branch: { ...base, status: 'running', cliStatus: { claude: 'running' }, nextActionKey: 'nextAction.running' },
    });
    const line = screen.getByTestId('branch-next-action');
    expect(screen.getByTestId('branch-list-item').contains(line)).toBe(true);
  });
});

describe('status dot (Issue #3576)', () => {
  it('is 8px', () => {
    renderRow();
    const dot = screen.getByTestId('status-indicator');
    expect(dot.className).toMatch(/(^|\s)w-2(\s|$)/);
    expect(dot.className).toMatch(/(^|\s)h-2(\s|$)/);
  });

  it.each([
    ['waiting (prompt)', { status: 'waiting', cliStatus: { claude: 'waiting' } }, /animate-status-attention/],
    ['running', { status: 'running', cliStatus: { claude: 'running' } }, /animate-status-glow/],
    ['cannot tell', { status: 'ready', cliStatus: { claude: 'ready' }, unclassifiedInstanceIds: ['claude'] }, /bg-transparent/],
  ] as const)('keeps the %s look at the new size', (_label, patch, pattern) => {
    renderRow({ branch: { ...base, ...(patch as Partial<SidebarBranchItem>) } });
    expect(screen.getByTestId('status-indicator').className).toMatch(pattern);
  });
});

describe('row actions "…" (Issue #3576)', () => {
  it('is on the selected row and stays visible on a touch screen', () => {
    renderRow({ isSelected: true });
    const actions = screen.getByTestId('branch-row-actions');
    expect(actions).toHaveAccessibleName('Actions for feature/card');
    expect(actions.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(actions.className).not.toMatch(/hover:none\)\]:hidden/);
  });

  it('is not on an unselected row at rest (negative control)', () => {
    renderRow();
    expect(screen.queryByTestId('branch-row-actions')).not.toBeInTheDocument();
  });

  it('appears while the pointer is over an unselected row and goes when it leaves', () => {
    const { row } = renderRow();
    fireEvent.pointerEnter(row);
    const actions = screen.getByTestId('branch-row-actions');
    // A touch screen never hovers, so an unselected row keeps it hidden there.
    expect(actions.className).toContain('[@media(hover:none)]:hidden');
    fireEvent.pointerLeave(row);
    expect(screen.queryByTestId('branch-row-actions')).not.toBeInTheDocument();
  });

  it('appears for keyboard focus so Tab can reach it', () => {
    const { item } = renderRow();
    const realMatches = HTMLElement.prototype.matches;
    vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      if (selector === ':focus-visible') return true;
      return realMatches.call(this, selector);
    });
    fireEvent.focus(item);
    expect(screen.getByTestId('branch-row-actions')).toBeInTheDocument();
  });

  it('opens a menu without selecting the row', () => {
    const { onClick } = renderRow({ isSelected: true });
    const menu = openMenu(screen.getByTestId('branch-row-actions'));
    expect(menu).toHaveAttribute('data-branch-row-actions');
    expect(screen.getByRole('menuitem', { name: 'Open in new tab' })).toHaveAttribute('href', '/worktrees/wt-1');
    expect(screen.getByRole('menuitem', { name: 'Copy branch name' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('copies the branch name', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderRow({ isSelected: true });
    openMenu(screen.getByTestId('branch-row-actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy branch name' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('feature/card'));
  });

  it('leaves out "Copy path" when the path is unknown', () => {
    renderRow({ isSelected: true, branch: { ...base, worktreePath: undefined } });
    openMenu(screen.getByTestId('branch-row-actions'));
    expect(screen.queryByRole('menuitem', { name: 'Copy path' })).not.toBeInTheDocument();
  });
});
