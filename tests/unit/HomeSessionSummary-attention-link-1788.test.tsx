/**
 * @vitest-environment jsdom
 *
 * Home's Waiting stat as a route into the attention list (Issue #1788).
 *
 * It used to be a number with nowhere to go: the user could see that three
 * branches were blocked on them and had no way to reach any of them. It is now
 * the same link the sidebar badge and the mobile bubble use — and it counts with
 * the same selector, so the three cannot disagree.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { HomeSessionSummary } from '@/components/home/HomeSessionSummary';
import { selectAttentionCount } from '@/hooks/useAttentionCount';
import { ATTENTION_REVIEW_HREF } from '@/config/review-config';
import type { Worktree } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

function wt(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    name: id,
    path: `/${id}`,
    repositoryPath: '/repo',
    repositoryName: 'Repo',
    ...overrides,
  };
}

describe('HomeSessionSummary attention link (Issue #1788)', () => {
  it('links the Waiting stat to the approval filter', () => {
    render(<HomeSessionSummary worktrees={[wt('a', { isSessionRunning: true, isWaitingForResponse: true })]} />);

    const link = screen.getByTestId('waiting-count-link');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(ATTENTION_REVIEW_HREF);
    expect(screen.getByTestId('waiting-count').textContent).toBe('1');
  });

  it('stays a link at zero, so the tile does not resize as the count crosses zero', () => {
    render(<HomeSessionSummary worktrees={[wt('a', { isSessionRunning: true })]} />);
    expect(screen.getByTestId('waiting-count-link').getAttribute('href')).toBe(
      ATTENTION_REVIEW_HREF,
    );
    expect(screen.getByTestId('waiting-count').textContent).toBe('0');
  });

  it('leaves the Running stat inert — it has no list to open', () => {
    render(<HomeSessionSummary worktrees={[wt('a', { isSessionRunning: true })]} />);
    expect(screen.getByTestId('running-count').closest('a')).toBeNull();
  });

  it('shows exactly the shared selector\'s number', () => {
    const worktrees = [
      wt('a', { isSessionRunning: true, isWaitingForResponse: true }),
      wt('b', { isSessionRunning: true }),
      wt('c', { isSessionRunning: true, isWaitingForResponse: true }),
    ];
    render(<HomeSessionSummary worktrees={worktrees} />);
    expect(screen.getByTestId('waiting-count').textContent).toBe(
      String(selectAttentionCount(worktrees)),
    );
  });

  it('counts a waiting worktree the Review list would show, even without isSessionRunning', () => {
    // Deliberate change from the old local filter, which required
    // `isSessionRunning` as well and could therefore show one fewer than the
    // approval list this tile now links to.
    render(<HomeSessionSummary worktrees={[wt('a', { isWaitingForResponse: true })]} />);
    expect(screen.getByTestId('waiting-count').textContent).toBe('1');
  });

  it('has an accessible label carrying the count', () => {
    render(
      <HomeSessionSummary
        worktrees={[
          wt('a', { isWaitingForResponse: true }),
          wt('b', { isWaitingForResponse: true }),
        ]}
      />,
    );
    expect(screen.getByTestId('waiting-count-link').getAttribute('aria-label')).toBe(
      '2 worktrees waiting — open the review list',
    );
  });
});
