/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for HomeSessionSummary component
 * Issue #600: UX refresh - Home screen session summary
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { HomeSessionSummary } from '@/components/home/HomeSessionSummary';
import type { Worktree } from '@/types/models';

function createMockWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'test-id',
    name: 'test',
    path: '/test',
    repositoryPath: '/repo',
    repositoryName: 'TestRepo',
    ...overrides,
  };
}

describe('HomeSessionSummary', () => {
  it('should render running count', () => {
    const worktrees = [
      createMockWorktree({ id: '1', isSessionRunning: true, isWaitingForResponse: false }),
      createMockWorktree({ id: '2', isSessionRunning: true, isWaitingForResponse: false }),
      createMockWorktree({ id: '3', isSessionRunning: false }),
    ];
    render(<HomeSessionSummary worktrees={worktrees} />);
    expect(screen.getByTestId('running-count').textContent).toBe('2');
  });

  it('should render waiting count', () => {
    const worktrees = [
      createMockWorktree({ id: '1', isSessionRunning: true, isWaitingForResponse: true }),
      createMockWorktree({ id: '2', isSessionRunning: true, isWaitingForResponse: false }),
    ];
    render(<HomeSessionSummary worktrees={worktrees} />);
    expect(screen.getByTestId('waiting-count').textContent).toBe('1');
  });

  it('should show zero counts when no worktrees', () => {
    render(<HomeSessionSummary worktrees={[]} />);
    expect(screen.getByTestId('running-count').textContent).toBe('0');
    expect(screen.getByTestId('waiting-count').textContent).toBe('0');
  });

  it('should display Running and Waiting labels', () => {
    render(<HomeSessionSummary worktrees={[]} />);
    expect(screen.getByText('Running')).toBeDefined();
    expect(screen.getByText('Waiting')).toBeDefined();
  });
});
