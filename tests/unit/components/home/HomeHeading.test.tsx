/**
 * Unit tests for HomeHeading (Issue #1072).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { HomeHeading } from '@/components/home/HomeHeading';
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

describe('HomeHeading', () => {
  it('renders the functional title (i18n key, not the CommandMate wordmark)', () => {
    render(<HomeHeading worktrees={[]} />);
    // next-intl is mocked to echo `${namespace}.${key}`.
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.textContent).toBe('home.title');
  });

  it('does not break with zero sessions: subline shows 0 running · 0 waiting', () => {
    render(<HomeHeading worktrees={[]} />);
    expect(screen.getByTestId('home-subline')).toBeDefined();
    expect(screen.getByTestId('subline-running').textContent).toBe('0');
    expect(screen.getByTestId('subline-waiting').textContent).toBe('0');
  });

  it('derives running and waiting counts from the worktrees', () => {
    const worktrees = [
      createMockWorktree({ id: '1', isSessionRunning: true, isWaitingForResponse: false }),
      createMockWorktree({ id: '2', isSessionRunning: true, isWaitingForResponse: true }),
      createMockWorktree({ id: '3', isSessionRunning: false }),
    ];
    render(<HomeHeading worktrees={worktrees} />);
    expect(screen.getByTestId('subline-running').textContent).toBe('2');
    expect(screen.getByTestId('subline-waiting').textContent).toBe('1');
  });

  it('applies tabular-nums to the count elements so they do not jitter', () => {
    render(<HomeHeading worktrees={[]} />);
    expect(screen.getByTestId('subline-running').className).toContain('tabular-nums');
    expect(screen.getByTestId('subline-waiting').className).toContain('tabular-nums');
  });
});
