/**
 * BranchListItem as a one-line row (Issue #3509).
 *
 * The status lives in the dot; the second line (next action, description)
 * moved to the selected row and the tooltip. These pin that every state keeps
 * a distinct look after the move.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { BranchListItem, __resetMouseEnterSuppression } from '@/components/sidebar/BranchListItem';
import type { SidebarBranchItem } from '@/types/sidebar';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const base: SidebarBranchItem = {
  id: 'b',
  name: 'feature/one-line',
  repositoryName: 'Repo',
  status: 'idle',
  hasUnread: false,
};

const running: SidebarBranchItem = {
  ...base,
  status: 'running',
  cliStatus: { claude: 'running' },
  nextActionKey: 'nextAction.running',
};

beforeEach(() => {
  __resetMouseEnterSuppression();
});

describe('BranchListItem one-line row (Issue #3509)', () => {
  it('has a fixed one-line minimum height instead of the old py-3 two-line padding', () => {
    render(<BranchListItem branch={base} isSelected={false} onClick={() => {}} />);
    const row = screen.getByTestId('branch-list-item');
    expect(row.className).toMatch(/min-h-\[34px\]/);
    expect(row.className).not.toMatch(/\bpy-3\b/);
  });

  it('puts the name and the repository on the same line', () => {
    render(<BranchListItem branch={base} isSelected={false} onClick={() => {}} />);
    const name = screen.getByText('feature/one-line');
    const repo = screen.getByText('Repo');
    expect(name.parentElement).toBe(repo.parentElement);
  });

  it('shows the next action on the selected row for any status (positive control)', () => {
    render(<BranchListItem branch={running} isSelected={true} onClick={() => {}} />);
    const line = screen.getByTestId('branch-next-action');
    expect(line).toHaveTextContent('Running...');
    expect(line.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it('keeps an unselected running row to one line (negative control)', () => {
    render(<BranchListItem branch={running} isSelected={false} onClick={() => {}} />);
    expect(screen.queryByTestId('branch-next-action')).not.toBeInTheDocument();
  });

  it('shows a waiting row\'s next action only where hover cannot reveal the tooltip', () => {
    render(
      <BranchListItem
        branch={{ ...base, status: 'waiting', cliStatus: { claude: 'waiting' }, nextActionKey: 'nextAction.approveReject' }}
        isSelected={false}
        onClick={() => {}}
      />
    );
    const line = screen.getByTestId('branch-next-action');
    expect(line.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(line.className).toContain('[@media(hover:none)]:block');
  });

  it('moves the description to the selected row', () => {
    const withDescription = { ...base, description: 'notes' };
    const { rerender } = render(
      <BranchListItem branch={withDescription} isSelected={false} onClick={() => {}} />
    );
    expect(screen.queryByTestId('branch-description')).not.toBeInTheDocument();
    rerender(<BranchListItem branch={withDescription} isSelected={true} onClick={() => {}} />);
    expect(screen.getByTestId('branch-description')).toHaveTextContent('notes');
  });

  it('draws "ready for work" as a compact mark with the words for screen readers and the tooltip', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <BranchListItem
          branch={{ ...base, status: 'ready', cliStatus: { claude: 'ready' }, awaitingInstruction: true }}
          isSelected={false}
          onClick={() => {}}
        />
      );
      const badge = screen.getByTestId('awaiting-instruction-badge');
      expect(badge.className).toMatch(/h-4/);
      expect(badge.querySelector('.sr-only')).toHaveTextContent('Ready for work');

      fireEvent.mouseEnter(screen.getByTestId('branch-list-item'));
      await vi.advanceTimersByTimeAsync(200);
      await waitFor(() => {
        expect(screen.getByRole('tooltip')).toHaveTextContent('Ready for work');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['waiting', { status: 'waiting', cliStatus: { claude: 'waiting' } }, /bg-warning/],
    ['running', { status: 'running', cliStatus: { claude: 'running' } }, /animate-status-glow/],
    ['ready', { status: 'ready', cliStatus: { claude: 'ready' } }, /bg-success/],
    ['idle', { status: 'idle', cliStatus: { claude: 'idle' } }, /bg-muted-foreground/],
  ] as const)('keeps a distinct dot for %s', (_label, overrides, pattern) => {
    render(<BranchListItem branch={{ ...base, ...overrides }} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('status-indicator').className).toMatch(pattern);
  });

  it('keeps the "cannot tell" ring for an unclassified ready', () => {
    render(
      <BranchListItem
        branch={{ ...base, status: 'ready', cliStatus: { claude: 'ready' }, unclassifiedInstanceIds: ['claude'] }}
        isSelected={false}
        onClick={() => {}}
      />
    );
    expect(screen.getByTestId('status-indicator')).toHaveAttribute('data-unclassified', 'true');
  });
});
