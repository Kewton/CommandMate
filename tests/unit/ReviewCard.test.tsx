/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for ReviewCard component
 * Issue #600: UX refresh - Review screen card
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { ReviewCard } from '@/components/review/ReviewCard';

describe('ReviewCard', () => {
  const defaultProps = {
    worktreeId: 'wt-1',
    repositoryName: 'MyRepo',
    branchName: 'feature/test',
    status: 'done' as const,
    nextAction: 'Review completed',
    cliToolId: 'claude',
  };

  it('should render repository name', () => {
    render(<ReviewCard {...defaultProps} />);
    expect(screen.getByText('MyRepo')).toBeDefined();
  });

  it('should render branch name', () => {
    render(<ReviewCard {...defaultProps} />);
    expect(screen.getByText('feature/test')).toBeDefined();
  });

  it('should render next action text', () => {
    render(<ReviewCard {...defaultProps} />);
    expect(screen.getByText('Review completed')).toBeDefined();
  });

  it('should render status badge for done', () => {
    render(<ReviewCard {...defaultProps} status="done" />);
    expect(screen.getByTestId('review-status-badge')).toBeDefined();
    expect(screen.getByTestId('review-status-badge').textContent).toBe('Done');
  });

  it('should render status badge for approval', () => {
    render(<ReviewCard {...defaultProps} status="approval" />);
    expect(screen.getByTestId('review-status-badge').textContent).toBe('Approval');
  });

  it('should render status badge for stalled', () => {
    render(<ReviewCard {...defaultProps} status="stalled" />);
    expect(screen.getByTestId('review-status-badge').textContent).toBe('Stalled');
  });

  it('should render a link to the worktree detail', () => {
    render(<ReviewCard {...defaultProps} />);
    const link = screen.getByTestId('review-card-link');
    expect(link.getAttribute('href')).toContain('/worktrees/wt-1');
  });

  it('should have data-testid review-card', () => {
    render(<ReviewCard {...defaultProps} />);
    expect(screen.getByTestId('review-card')).toBeDefined();
  });
});
