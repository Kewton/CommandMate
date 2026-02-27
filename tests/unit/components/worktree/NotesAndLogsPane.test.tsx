/**
 * Tests for NotesAndLogsPane extension
 * Issue #368: Adds 'agent' sub-tab for Agent settings
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotesAndLogsPane } from '@/components/worktree/NotesAndLogsPane';
import type { CLIToolType } from '@/lib/cli-tools/types';

// Mock child components
vi.mock('@/components/worktree/MemoPane', () => ({
  MemoPane: ({ worktreeId }: { worktreeId: string }) => (
    <div data-testid="memo-pane">MemoPane: {worktreeId}</div>
  ),
}));

vi.mock('@/components/worktree/ExecutionLogPane', () => ({
  ExecutionLogPane: ({ worktreeId }: { worktreeId: string }) => (
    <div data-testid="execution-log-pane">ExecutionLogPane: {worktreeId}</div>
  ),
}));

vi.mock('@/components/worktree/AgentSettingsPane', () => ({
  AgentSettingsPane: ({ worktreeId }: { worktreeId: string }) => (
    <div data-testid="agent-settings-pane">AgentSettingsPane: {worktreeId}</div>
  ),
}));

describe('NotesAndLogsPane', () => {
  const defaultProps = {
    worktreeId: 'test-worktree',
    selectedAgents: ['claude', 'codex'] as [CLIToolType, CLIToolType],
    onSelectedAgentsChange: vi.fn(),
    vibeLocalModel: null as string | null,
    onVibeLocalModelChange: vi.fn(),
    vibeLocalContextWindow: null as number | null,
    onVibeLocalContextWindowChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tab rendering', () => {
    it('should render Notes tab', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.getByText('schedule.notes')).toBeDefined();
    });

    it('should render Schedules tab', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.getByText('schedule.logs')).toBeDefined();
    });

    it('should render Agent tab', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.getByText('schedule.agentTab')).toBeDefined();
    });
  });

  describe('Tab switching', () => {
    it('should show MemoPane by default', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.getByTestId('memo-pane')).toBeDefined();
    });

    it('should show ExecutionLogPane when logs tab is clicked', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      fireEvent.click(screen.getByText('schedule.logs'));
      expect(screen.getByTestId('execution-log-pane')).toBeDefined();
    });

    it('should show AgentSettingsPane when agent tab is clicked', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      fireEvent.click(screen.getByText('schedule.agentTab'));
      expect(screen.getByTestId('agent-settings-pane')).toBeDefined();
    });
  });
});
