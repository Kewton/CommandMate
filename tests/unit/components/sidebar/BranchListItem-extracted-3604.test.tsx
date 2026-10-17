/**
 * The parts moved out of BranchListItem (Issue #3604): the row class names, the
 * worktree status pill and its context. BranchListItem re-exports the context.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import {
  branchNextActionClass,
  branchRowButtonPaddingClass,
} from '@/components/sidebar/branch-list-item/row-classes';
import {
  BranchRowStatusPillContext,
  WorktreeStatusPill,
} from '@/components/sidebar/branch-list-item/WorktreeStatusPill';
import { BranchRowStatusPillContext as ReExportedContext } from '@/components/sidebar/BranchListItem';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

describe('branchRowButtonPaddingClass (Issue #3604)', () => {
  it('leaves room for "…" only while the actions show', () => {
    expect(branchRowButtonPaddingClass(false, false)).toBe('pr-3');
    expect(branchRowButtonPaddingClass(false, true)).toBe('pr-3');
    expect(branchRowButtonPaddingClass(true, true)).toBe('pr-9');
    expect(branchRowButtonPaddingClass(true, false)).toBe('pr-9 [@media(hover:none)]:pr-3');
  });
});

describe('branchNextActionClass (Issue #3604)', () => {
  it('shows on the selected row and, elsewhere, only where hover is unavailable', () => {
    expect(branchNextActionClass(true, false, false)).toBe(
      'pl-6 text-left text-xs font-medium truncate block text-sidebar-muted'
    );
    expect(branchNextActionClass(false, false, false)).toBe(
      'pl-6 text-left text-xs font-medium truncate hidden [@media(hover:none)]:block text-sidebar-muted'
    );
  });

  it('is amber while waiting, even when also awaiting an instruction', () => {
    expect(branchNextActionClass(false, true, true)).toContain('text-warning-foreground');
    expect(branchNextActionClass(false, false, true)).toContain('text-success-foreground');
  });
});

describe('WorktreeStatusPill (Issue #3604)', () => {
  it('is the same context BranchListItem exports', () => {
    expect(ReExportedContext).toBe(BranchRowStatusPillContext);
  });

  it('draws the pill for a set status', () => {
    render(<WorktreeStatusPill worktreeStatus="in_review" />);
    expect(screen.getByTestId('branch-worktree-status').getAttribute('data-status')).toBe('in_review');
    expect(screen.getByTestId('branch-worktree-status-dot')).toBeTruthy();
  });

  it('draws nothing for "Not set" or when the context turns pills off', () => {
    const { container, rerender } = render(<WorktreeStatusPill worktreeStatus={null} />);
    expect(container.innerHTML).toBe('');
    rerender(
      <BranchRowStatusPillContext.Provider value={false}>
        <WorktreeStatusPill worktreeStatus="in_review" />
      </BranchRowStatusPillContext.Provider>
    );
    expect(container.innerHTML).toBe('');
  });
});
