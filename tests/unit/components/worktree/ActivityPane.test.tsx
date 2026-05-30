/**
 * Tests for ActivityPane (Issue #727)
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityPane, type ActivityContentMap } from '@/components/worktree/ActivityPane';

vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children, componentName }: { children: React.ReactNode; componentName?: string }) => (
    <div data-testid="error-boundary" data-component-name={componentName}>
      {children}
    </div>
  ),
}));

const fullActivities: ActivityContentMap = {
  files: <div data-testid="content-files">Files</div>,
  git: <div data-testid="content-git">Git</div>,
  notes: <div data-testid="content-notes">Notes</div>,
  schedules: <div data-testid="content-schedules">Schedules</div>,
  agent: <div data-testid="content-agent">Agent</div>,
  timer: <div data-testid="content-timer">Timer</div>,
};

describe('ActivityPane', () => {
  it('renders the content for the active activity', () => {
    render(<ActivityPane active="files" activities={fullActivities} />);
    expect(screen.getByTestId('content-files')).toBeInTheDocument();
  });

  it('renders different content when active changes', () => {
    const { rerender } = render(<ActivityPane active="files" activities={fullActivities} />);
    expect(screen.getByTestId('content-files')).toBeInTheDocument();
    rerender(<ActivityPane active="git" activities={fullActivities} />);
    expect(screen.queryByTestId('content-files')).not.toBeInTheDocument();
    expect(screen.getByTestId('content-git')).toBeInTheDocument();
  });

  it.each([
    ['files', 'FileTreeView'],
    ['git', 'GitPane'],
    ['notes', 'MemoPane'],
    ['schedules', 'ExecutionLogPane'],
    ['agent', 'AgentSettingsPane'],
    ['timer', 'TimerPane'],
  ])('wraps activity "%s" in an ErrorBoundary named "%s"', (id, name) => {
    render(<ActivityPane active={id as keyof ActivityContentMap} activities={fullActivities} />);
    const boundary = screen.getByTestId('error-boundary');
    expect(boundary).toHaveAttribute('data-component-name', name);
  });

  it('renders an empty stub container when active=null', () => {
    render(<ActivityPane active={null} activities={fullActivities} />);
    const stub = screen.getByTestId('activity-pane');
    expect(stub).toHaveAttribute('data-active', 'none');
    // None of the activity contents should be present
    expect(screen.queryByTestId('content-files')).not.toBeInTheDocument();
  });

  it('renders nothing inside the ErrorBoundary when activity content is undefined', () => {
    render(<ActivityPane active="files" activities={{}} />);
    // ErrorBoundary present but with no inner content
    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
    expect(screen.queryByTestId('content-files')).not.toBeInTheDocument();
  });

  it('sets id="worktree-activity-pane" on the root container', () => {
    render(<ActivityPane active="files" activities={fullActivities} />);
    expect(document.getElementById('worktree-activity-pane')).not.toBeNull();
  });
});
