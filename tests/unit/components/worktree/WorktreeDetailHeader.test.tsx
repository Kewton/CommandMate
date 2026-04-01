/**
 * Unit tests for WorktreeDetailHeader component
 * Issue #600: UX refresh - extracted header from WorktreeDetailRefactored
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { WorktreeDetailHeader, type WorktreeDetailHeaderProps } from '@/components/worktree/WorktreeDetailHeader';

const defaultProps: WorktreeDetailHeaderProps = {
  repositoryName: 'my-repo',
  branchName: 'feature/test-branch',
  cliToolId: 'claude',
  sessionStatus: 'running',
  nextAction: 'Running...',
};

describe('WorktreeDetailHeader', () => {
  it('should render repository name', () => {
    render(<WorktreeDetailHeader {...defaultProps} />);
    expect(screen.getByText('my-repo')).toBeDefined();
  });

  it('should render branch name', () => {
    render(<WorktreeDetailHeader {...defaultProps} />);
    expect(screen.getByText('feature/test-branch')).toBeDefined();
  });

  it('should render CLI tool name', () => {
    render(<WorktreeDetailHeader {...defaultProps} />);
    // getCliToolDisplayName('claude') should display 'Claude'
    expect(screen.getByText('Claude')).toBeDefined();
  });

  it('should render next action text', () => {
    render(<WorktreeDetailHeader {...defaultProps} />);
    expect(screen.getByText('Running...')).toBeDefined();
  });

  it('should render with waiting status and approval action', () => {
    render(
      <WorktreeDetailHeader
        {...defaultProps}
        sessionStatus="waiting"
        nextAction="Approve / Reject"
      />
    );
    expect(screen.getByText('Approve / Reject')).toBeDefined();
  });

  it('should render with null sessionStatus', () => {
    render(
      <WorktreeDetailHeader
        {...defaultProps}
        sessionStatus={null}
        nextAction="Start"
      />
    );
    expect(screen.getByText('Start')).toBeDefined();
  });

  it('should have data-testid for each section', () => {
    render(<WorktreeDetailHeader {...defaultProps} />);
    expect(screen.getByTestId('worktree-detail-header')).toBeDefined();
    expect(screen.getByTestId('header-repo-name')).toBeDefined();
    expect(screen.getByTestId('header-branch-name')).toBeDefined();
    expect(screen.getByTestId('header-next-action')).toBeDefined();
  });
});
